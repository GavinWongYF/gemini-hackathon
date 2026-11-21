// Practice session against the real agent server: connects with mode "practice",
// answers every practice_run by simulating rounds headlessly, and exits when the
// server closes the socket (design stored). Run before live matches:
//   npx tsx scripts/record/practice.ts [ws://localhost:8000/ws]
import { makeAdaptiveBrain } from "../../src/agent/adaptiveBrain";
import { mulberry32, type BehaviourJson } from "../../src/agent/protocol";
import { BASELINE_AGENT_SETTINGS, valorSetup, type AgentSettings } from "../../src/agent/setup";
import { PLAYERS, habitModel, simulateRound, type ScriptedPlayer } from "../../src/agent/sim";

const url = process.argv[2] ?? "ws://localhost:8000/ws";
const matchId = `valor_practice_${Date.now()}`;

type Persona = { name: string; plays?: Record<string, Record<string, Record<string, number>>> };

/** A named scripted player, or a persona the agents wrote (lane shares from any `lane` field). */
function playerFor(p: string | Persona): ScriptedPlayer | null {
  if (typeof p === "string") return PLAYERS[p] ?? null;
  const lane: Record<string, number> = {};
  for (const fields of Object.values(p.plays ?? {})) {
    for (const [field, dist] of Object.entries(fields)) {
      if (field === "lane") for (const [k, v] of Object.entries(dist)) lane[k] = (lane[k] ?? 0) + v;
    }
  }
  const m = habitModel({ left: lane.left ?? 1, mid: lane.mid ?? 1, right: lane.right ?? 1, cover: 0.5, rush: 0.3 });
  return { ...m, id: p.name };
}

const setup = valorSetup({ matchId, mode: "practice" });
const ws = new WebSocket(url);
let runs = 0;
ws.onopen = () => {
  ws.send(JSON.stringify(setup));
  console.log(`[practice] setup sent as ${matchId}`);
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === "error") return console.log("[practice] error:", msg.about, msg.where ?? "");
  if (msg.type === "ready") return console.log("[practice] ready received");
  if (msg.type !== "practice_run") return;
  const player = playerFor(msg.player);
  const name = typeof msg.player === "string" ? msg.player : msg.player?.name;
  if (!player) {
    ws.send(JSON.stringify({ type: "error", match_id: matchId, about: `Unknown practice player ${name}`, where: "practice_run.player", got: name }));
    return;
  }
  const settings: AgentSettings = { ...BASELINE_AGENT_SETTINGS, ...(msg.settings ?? {}) };
  const rng = mulberry32(runs * 7919 + 1);
  const brain = makeAdaptiveBrain({ behaviour: msg.behaviour as BehaviourJson, settings, rng: mulberry32(runs * 104729 + 3) });
  const wins = { player: 0, red: 0 };
  for (let r = 1; r <= (msg.rounds ?? 20); r++) {
    const res = simulateRound({ brain, player, round: r, rng });
    if (res.winner === "blue") wins.player++;
    else wins.red++;
  }
  runs++;
  ws.send(JSON.stringify({ type: "practice_result", match_id: matchId, run_id: msg.run_id, player: name, rounds: msg.rounds ?? 20, wins }));
  if (runs % 20 === 0) console.log(`[practice] ${runs} runs answered`);
};
ws.onclose = (ev) => {
  console.log(`[practice] socket closed (${ev.code}) after ${runs} runs`);
  process.exit(ev.code === 1000 ? 0 : 1);
};
