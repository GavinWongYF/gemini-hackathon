// practice.ts — one headless practice match (contract mode "practice"): a
// scripted player vs red driven by either the BASELINE brain or the adaptive
// pipeline (stand-in → self-check → adaptive brain), through the same contract
// messages the browser bridge sends. Pure TS; used by scripts/proof/run.ts.

import { baselineBrain, type Brain } from "./brain";
import { makeAdaptiveBrain } from "./adaptiveBrain";
import { mulberry32, type AgentStrategyUpdateMessage, type GameEventMessage } from "./protocol";
import { BASELINE_AGENT_SETTINGS, VALOR_PLAN, valorSetup, type AgentSettings } from "./setup";
import { chooseCandidate, type CheckLogEntry } from "./selfcheck";
import { OfflineStandin, STANDIN_VALUES } from "./standin";
import { simulateRound, type RoundResult, type ScriptedPlayer } from "./sim";

export interface PracticeRound extends RoundResult {
  round: number;
  version: number;
  cover: string[];
  rulesActive: string[];
}
export interface PracticeMatch {
  rounds: PracticeRound[];
  updates: Array<{ afterRound: number; update: AgentStrategyUpdateMessage; label: string }>;
  checks: CheckLogEntry[];
  pipelineMs: number[]; // round_end → accepted/declined decision (stand-in + self-check)
  readMs: number[]; // event → player_read (stand-in)
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function runPracticeMatch(opts: { player: ScriptedPlayer; seed: number; mode: "baseline" | "standin"; rounds?: number; checkN?: number }): PracticeMatch {
  const rounds = opts.rounds ?? VALOR_PLAN.rounds;
  const rng = mulberry32(opts.seed); // the world (sim) stream — identical for baseline and adaptive
  const brainRng = mulberry32(opts.seed ^ 0x5bd1e995); // separate stream for pick() so round 1 matches exactly
  const matchId = `practice_${opts.player.id}_${opts.seed}`;
  const setup = valorSetup({ matchId, mode: "practice" });
  const out: PracticeMatch = { rounds: [], updates: [], checks: [], pipelineMs: [], readMs: [] };
  const standin = new OfflineStandin(matchId, BASELINE_AGENT_SETTINGS);
  const ready = standin.ready();
  let behaviour = ready.behaviour;
  let settings: AgentSettings = { ...BASELINE_AGENT_SETTINGS };
  let values: Record<string, number> = {};
  let version = behaviour.version;
  const mkBrain = (): Brain => (opts.mode === "baseline" ? baselineBrain : makeAdaptiveBrain({ behaviour, settings, rng: brainRng, getValues: () => values }));
  let brain = mkBrain();
  let tMatch = 0;
  const score = { player: 0, red: 0 };

  for (let r = 1; r <= rounds; r++) {
    const res = simulateRound({
      brain,
      player: opts.player,
      round: r,
      rng,
      onEvent: (e) => {
        if (opts.mode !== "standin") return;
        const ev: GameEventMessage = { type: "event", match_id: matchId, name: e.name, round: r, t: tMatch + e.t, by: e.by, data: e.data, picked: e.picked, by_rule: e.by_rule };
        const t0 = now();
        const read = standin.onEvent(ev, r);
        if (read) {
          out.readMs.push(now() - t0);
          values = read.values; // player_read → `when` values (behaviour itself is NOT swapped mid-round)
        }
      },
    });
    tMatch += res.seconds;
    out.rounds.push({ ...res, round: r, version, cover: settings.cover.slice(), rulesActive: (behaviour.npcs.red?.rules ?? []).map((x) => x.why ?? "") });
    if (res.winner === "blue") score.player++;
    else score.red++;
    if (opts.mode !== "standin") continue;

    // ── break: round_end → stand-in → self-check → queue for next round ──
    const t0 = now();
    const cands = standin.onRoundEnd({ type: "round_end", match_id: matchId, round: r, t: tMatch, winner: res.winner === "blue" ? "player" : "red", how: res.how, score: { ...score }, break: true, stats: { seconds: res.seconds, player_kills: res.playerKills } });
    if (cands.length) {
      const { chosen, log } = chooseCandidate(cands, {
        setup,
        knownValues: Object.keys(STANDIN_VALUES),
        current: { behaviour, settings },
        habit: standin.tracker.habit(),
        round: r,
        n: opts.checkN ?? 60,
        seed: opts.seed * 31 + r,
        values,
      });
      out.checks.push(...log);
      if (chosen) {
        standin.accept(chosen);
        behaviour = chosen.update.behaviour;
        settings = chosen.settings;
        version = chosen.update.version;
        out.updates.push({ afterRound: r, update: chosen.update, label: chosen.label });
      }
    }
    out.pipelineMs.push(now() - t0);
    brain = mkBrain(); // swapped only between rounds
  }
  return out;
}
