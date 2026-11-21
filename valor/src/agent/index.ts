// ─────────────────────────────────────────────────────────────────────────
// src/agent — VALOR's side of the adaptive-NPC agent system.
//
// ONE CALL from the game is enough:
//
//   import { startAgentBridge } from "../agent";
//   useEffect(() => startAgentBridge(), []);          // e.g. in GameView, once
//
// startAgentBridge() (idempotent, returns a stop fn):
//   • finds the WebGL <canvas> (or pass one: startAgentBridge(canvasEl));
//   • opens ws://localhost:8000/ws (reconnects with backoff; offline → stand-in);
//   • subscribes to useMatch (round start/end) and teamAI.onTeamEvent
//     (player_kill / player_death) and polls the player's lane at 4 Hz, turning
//     them into the contract events declared in setup.ts;
//   • installs the adaptive Brain via setBrain() — only between rounds, after the
//     self-check — so teamAI.planRound() picks it up for the next round, cover included.
//
// Lower-level API if you'd rather wire it by hand (then don't call autoWire):
//   agentBridge.start({ canvas })
//   agentBridge.onRoundStart(round, redPicks)       // after planRound()
//   agentBridge.onEvent(name, data, by?)            // any event declared in setup.events
//   agentBridge.onRoundEnd({ round, winner: "player"|"red", how, score })
//   agentBridge.getLatencyReport()
// HUD: read useAgentStatus (status.ts) — mode is "offline_standin" or "live_gemini".
// Proof: npx tsx scripts/proof/run.ts   (docs/PROOF.md)
// ─────────────────────────────────────────────────────────────────────────

import { agentBridge } from "./bridge";
import { useMatch } from "../game/match";
import { BOT_SPAWNS, MAP_COVER, botPlans, getDynamicCover, laneOf, onTeamEvent, type Lane } from "../game/teamAI";
import { transforms } from "../game/stores";
import { LOCAL_ID } from "../game/contracts";

export { agentBridge, AgentBridge } from "./bridge";
export { valorSetup, COVER_SPOTS, baselineBehaviour } from "./setup";
export { pick, holds } from "./protocol";
export { makeAdaptiveBrain } from "./adaptiveBrain";
export { OfflineStandin, HabitTracker } from "./standin";
export { validateStructure, fairnessCheck, chooseCandidate } from "./selfcheck";

const RED_INDEX: Record<string, number> = { red1: 0, red2: 1, red3: 2 };
const POSITION_LANE: Record<string, Lane> = { watch_left_flank: "left", watch_right_flank: "right", hold_mid: "mid", push_forward: "mid", hold_cover: "mid" };

let stopFn: (() => void) | null = null;

export function startAgentBridge(canvas?: HTMLCanvasElement | null): () => void {
  if (stopFn) {
    if (canvas) agentBridge.setCanvas(canvas);
    return stopFn;
  }
  const cv = canvas ?? (typeof document !== "undefined" ? document.querySelector("canvas") : null);
  agentBridge.start({ canvas: cv });
  const offs: Array<() => void> = [];

  let lastLane: Lane = "mid";
  let roundStartedAt = Date.now();
  const secs = () => Math.round((Date.now() - roundStartedAt) / 100) / 10;

  // rounds (useMatch is the shared contract in src/game/match.ts)
  offs.push(
    useMatch.subscribe((s, prev) => {
      if (s.phase === "live" && (prev.phase !== "live" || s.round !== prev.round)) {
        roundStartedAt = Date.now();
        lastLane = "mid";
        const picks = ["red1", "red2", "red3"].map((id) => botPlans[id]).filter(Boolean).map((p) => ({ position: p.position, target: p.target, style: p.style, byRule: p.byRule }));
        agentBridge.onRoundStart(s.round, picks);
        if (!cv) agentBridge.setCanvas(document.querySelector("canvas"));
      }
      if (s.lastRound && s.lastRound !== prev.lastRound) {
        const lr = s.lastRound;
        agentBridge.onRoundEnd({
          round: lr.round,
          winner: lr.winner === "blue" ? "player" : "red",
          how: lr.how,
          stats: { seconds: lr.durationSec },
          score: { player: s.score.blue, red: s.score.red },
          isBreak: s.phase !== "match_end",
        });
        if (s.phase === "match_end") agentBridge.onMatchEnd();
      }
    }),
  );

  // kills / deaths (teamAI emits these from combat.ts)
  offs.push(
    onTeamEvent((e) => {
      if (e.kind === "player_kill" && e.victimTeam === "red") {
        const v = transforms[e.victimId]?.pos;
        const dist = v ? Math.round(Math.hypot(v[0] - e.playerPos[0], v[2] - e.playerPos[2])) : null;
        agentBridge.onEvent("kill", { lane: e.lane, distance_m: dist, enemy_index: RED_INDEX[e.victimId] ?? null, enemy_was_watching: POSITION_LANE[botPlans[e.victimId]?.position ?? "hold_mid"] });
      } else if (e.kind === "player_death") {
        agentBridge.onEvent("death", { lane: e.lane, in_open: e.playerInOpen ? "yes" : "no", killer_index: RED_INDEX[e.killerId] ?? null, seconds_into_round: secs() });
        if (e.playerInOpen) {
          const [px, , pz] = e.playerPos;
          let best = Infinity;
          for (const c of [...MAP_COVER, ...getDynamicCover()]) best = Math.min(best, Math.hypot(c.x - px, c.z - pz));
          agentBridge.onEvent("died_in_open", { lane: e.lane, nearest_cover_m: Number.isFinite(best) ? Math.round(best * 10) / 10 : null });
        }
      }
    }),
  );

  // lane changes (cheap: one transform read at 4 Hz, only while live)
  const poll = setInterval(() => {
    if (useMatch.getState().phase !== "live") return;
    const p = transforms[LOCAL_ID]?.pos;
    if (!p || p[2] > BOT_SPAWNS.ally1[1]) return; // still in the spawn area
    const lane = laneOf(p[0]);
    if (lane !== lastLane) {
      agentBridge.onEvent("player_lane_change", { lane, from: lastLane, seconds_into_round: secs() });
      lastLane = lane;
    }
  }, 250);
  offs.push(() => clearInterval(poll));

  if (import.meta.env?.DEV && typeof window !== "undefined") (window as unknown as Record<string, unknown>).__valorAgent = { agentBridge, report: () => agentBridge.getLatencyReport() };

  stopFn = () => {
    offs.forEach((f) => f());
    agentBridge.stop();
    stopFn = null;
  };
  return stopFn;
}
