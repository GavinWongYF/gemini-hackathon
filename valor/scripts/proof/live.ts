// Live arm: practice matches against the real agent backend (the team's `agents/` server).
// Uses Node's global WebSocket. Every message is the contract shape; every update goes through
// the same self-check before it is applied, and only between rounds.
import { makeAdaptiveBrain } from "../../src/agent/adaptiveBrain";
import { mulberry32, type AgentStrategyUpdateMessage, type BehaviourJson } from "../../src/agent/protocol";
import { BASELINE_AGENT_SETTINGS, valorSetup, type AgentSettings } from "../../src/agent/setup";
import { chooseCandidate, type CheckLogEntry } from "../../src/agent/selfcheck";
import { HabitTracker, STANDIN_VALUES } from "../../src/agent/standin";
import { PLAYERS, simulateRound } from "../../src/agent/sim";

export function probeServer(url: string, ms: number): Promise<boolean> {
  return new Promise((res) => {
    let done = false;
    let ws: WebSocket | undefined;
    const fin = (v: boolean) => {
      if (done) return;
      done = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      res(v);
    };
    try {
      ws = new WebSocket(url);
      ws.onopen = () => fin(true);
      ws.onerror = () => fin(false);
      setTimeout(() => fin(false), ms);
    } catch {
      fin(false);
    }
  });
}

const pct = (xs: number[], q: number) => (xs.length ? +xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))].toFixed(1) : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runLive(o: { url: string; matches: number; checkN: number }) {
  const lat = { read: [] as number[], quick: [] as number[], full: [] as number[], ready: [] as number[] };
  const matches: unknown[] = [];
  const checks: CheckLogEntry[] = [];
  for (let mi = 0; mi < o.matches; mi++) {
    const player = Object.values(PLAYERS)[mi % 3];
    const matchId = `live_${player.id}_${Date.now()}`;
    const setup = valorSetup({ matchId, mode: "practice" });
    const ws = new WebSocket(o.url);
    const inbox: Array<{ msg: Record<string, unknown>; at: number }> = [];
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws error"));
    });
    ws.onmessage = (ev) => {
      try {
        inbox.push({ msg: JSON.parse(String(ev.data)), at: performance.now() });
      } catch {
        /* ignore non-JSON */
      }
    };
    ws.send(JSON.stringify(setup));
    const t0 = performance.now();
    while (!inbox.some((m) => m.msg.type === "ready") && performance.now() - t0 < 90_000) await sleep(100);
    const readyIn = inbox.find((m) => m.msg.type === "ready");
    if (readyIn) lat.ready.push(readyIn.at - t0);
    const ready = readyIn?.msg as { behaviour: BehaviourJson; values: Record<string, unknown> } | undefined;
    let behaviour = ready?.behaviour ?? setup.default_behaviour!;
    let settings: AgentSettings = { ...BASELINE_AGENT_SETTINGS };
    let values: Record<string, number> = {};
    const known = Object.keys(ready?.values ?? STANDIN_VALUES);
    const tracker = new HabitTracker();
    const rng = mulberry32(1000 + mi);
    const brainRng = mulberry32(2000 + mi);
    const rounds: unknown[] = [];
    let tMatch = 0;
    const score = { player: 0, red: 0 };
    let pending: AgentStrategyUpdateMessage | null = null;
    let lastPlayerEventAt = 0;
    let roundEndAt = 0;
    let seen = 0;
    const drain = () => {
      for (; seen < inbox.length; seen++) {
        const { msg, at } = inbox[seen];
        if (msg.type === "player_read") {
          if (lastPlayerEventAt) lat.read.push(at - lastPlayerEventAt);
          values = (msg.values as Record<string, number>) ?? values;
        }
        if (msg.type === "strategy_update") {
          const u = msg as unknown as AgentStrategyUpdateMessage;
          if (roundEndAt) (u.source === "full" ? lat.full : lat.quick).push(at - roundEndAt);
          for (const k of Object.keys(u.new_values ?? {})) known.push(k);
          pending = u; // the later one replaces the earlier one
        }
      }
    };
    for (let r = 1; r <= setup.plan.rounds; r++) {
      const u = pending as AgentStrategyUpdateMessage | null;
      if (u) {
        const { chosen, log } = chooseCandidate([{ label: `gemini ${u.source} v${u.version}`, update: u }], {
          setup,
          knownValues: known,
          current: { behaviour, settings },
          habit: tracker.habit(),
          round: r - 1,
          n: o.checkN,
          seed: r,
          values,
        });
        checks.push(...log);
        if (chosen) {
          behaviour = chosen.update.behaviour;
          settings = chosen.settings;
        }
        pending = null;
      }
      const brain = makeAdaptiveBrain({ behaviour, settings, rng: brainRng, getValues: () => values });
      const res = simulateRound({
        brain,
        player,
        round: r,
        rng,
        onEvent: (e) => {
          if (e.name === "shot") return;
          const ev = { type: "event" as const, match_id: matchId, name: e.name, round: r, t: tMatch + e.t, by: e.by, data: e.data, picked: e.picked, by_rule: e.by_rule };
          tracker.onEvent(ev);
          ws.send(JSON.stringify(ev));
          if (e.by === "player") lastPlayerEventAt = performance.now();
        },
      });
      tMatch += res.seconds;
      if (res.winner === "blue") score.player++;
      else score.red++;
      tracker.onRoundEnd({ round: r, winner: res.winner === "blue" ? "player" : "red", t: tMatch });
      ws.send(JSON.stringify({ type: "round_end", match_id: matchId, round: r, t: tMatch, winner: res.winner === "blue" ? "player" : "red", how: res.how, stats: { seconds: res.seconds, player_kills: res.playerKills }, score, break: true }));
      roundEndAt = performance.now();
      const until = roundEndAt + setup.plan.break_seconds * 1000;
      while (performance.now() < until) {
        drain();
        await sleep(50);
      }
      drain();
      rounds.push({ round: r, winner: res.winner, behaviour_version: behaviour.version, cover: settings.cover });
    }
    await sleep(2000);
    drain();
    ws.close();
    matches.push({ player: player.id, match_id: matchId, got_ready: !!ready, rounds });
  }
  return {
    skipped: false,
    matches,
    self_check: checks,
    latency: {
      setup_to_ready_ms: { p50: pct(lat.ready, 0.5), p95: pct(lat.ready, 0.95), n: lat.ready.length },
      event_to_player_read_ms: { p50: pct(lat.read, 0.5), p95: pct(lat.read, 0.95), n: lat.read.length },
      round_end_to_quick_update_ms: { p50: pct(lat.quick, 0.5), p95: pct(lat.quick, 0.95), n: lat.quick.length },
      round_end_to_full_update_ms: { p50: pct(lat.full, 0.5), p95: pct(lat.full, 0.95), n: lat.full.length },
      frames: "not sent in practice mode (the contract needs no frames there); see the browser bridge's getLatencyReport()",
    },
  };
}
