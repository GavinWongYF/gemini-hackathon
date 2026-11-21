// ─────────────────────────────────────────────────────────────────────────
// RoundManager.tsx — drives the 3v3 round loop on top of useMatch (match.ts).
//
//   warmup     everyone waits at their spawn; the FIRST pointer lock (or the
//              phone's START) begins round 1's intro (resetEveryone + beginIntro).
//   intro      overview camera over both teams, then 3 · 2 · 1 (intro.ts,
//              IntroCamera.tsx, ui/Countdown.tsx). Frozen while paused. At GO
//              → startRound(round).
//   live       no respawns (combatRules.respawn = false). When every member of
//              one team is dead → endRound({ round, winner, durationSec, how }).
//   round_end  wait ROUND_END_MS, then resetEveryone(next) — full health/ammo,
//              everyone back at spawn, red re-planned with the CURRENT brain,
//              agent cover re-placed — and beginIntro(next).
//   match_end  stops. UI calls restartMatch() to go back to warmup (the next
//              pointer lock — or an existing one — starts round 1 again).
//
// "how" tag: where the local player was when the round was decided (or where
// they died): "picked_off" (died in the open), "flank_left", "flank_right",
// "rush_mid" (pushed past z -15.5 in mid) or "hold_mid".
//
// Renders <TeamBots/>, <MapCover/> and <DynamicCover/>. Mount inside <Physics>.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { LOCAL_ID, MAG_SIZE, MAX_HEALTH } from "./contracts";
import { useGame } from "./stores";
import { ROUND_END_MS, useMatch, type Team } from "./match";
import { combatRules } from "./combat";
import { isPlaying } from "./playState";
import { TeamBots } from "./Bot";
import { IntroCamera } from "./IntroCamera";
import { INTRO_GO_MS, markGo, syncIntroUi } from "./intro";
import { DynamicCover, MapCover, reregisterCover } from "./Cover";
import { getBrain, setBrain } from "../agent/brain";
import { BLUE_IDS, getDynamicCover, RED_IDS, botPlans, lastRoundPlayer, planRound, playerSnapshot, roundInfo, roundReset, teamEventLog } from "./teamAI";

let roundEndedAt = 0;
let lastFrameAt = 0;

/** Revive everyone at their spawns and (re)plan the bots for `round`. */
function resetEveryone(round: number) {
  planRound(round); // bumps plan versions → bots snap to spawn; re-places agent cover
  roundInfo.playerDeath = null;
  useGame.setState((s) => {
    const entities = { ...s.entities };
    for (const id in entities) {
      entities[id] = { ...entities[id], health: MAX_HEALTH, alive: true, ammo: MAG_SIZE, reloading: false, fireState: "ready", respawnAt: undefined };
    }
    return { entities };
  });
  roundReset.seq++; // PlayerController teleports the player to the blue spawn
  reregisterCover();
}

/** Back to warmup with a fresh score (UI calls this from the match-end screen). */
export function restartMatch() {
  useMatch.getState().reset();
  lastRoundPlayer.lane = null;
  lastRoundPlayer.inOpen = false;
  resetEveryone(1);
}

function aliveCount(ids: readonly string[]): number {
  const ents = useGame.getState().entities;
  let n = 0;
  for (const id of ids) if (ents[id]?.alive) n++;
  return n;
}

function decideRound(winner: Team) {
  const m = useMatch.getState();
  const pd = roundInfo.playerDeath;
  const snap = playerSnapshot();
  const lane = pd ? pd.lane : snap.lane;
  const inOpen = pd ? pd.inOpen : snap.inOpen;
  const z = pd ? pd.z : snap.pos[2];
  const how = pd && pd.inOpen ? "picked_off" : lane === "left" ? "flank_left" : lane === "right" ? "flank_right" : z < -15.5 ? "rush_mid" : "hold_mid";
  lastRoundPlayer.lane = lane;
  lastRoundPlayer.inOpen = inOpen;
  roundEndedAt = Date.now();
  m.endRound({ round: m.round, winner, durationSec: Math.round((Date.now() - m.roundStartedAt) / 100) / 10, how });
}

export function RoundManager() {
  useEffect(() => {
    combatRules.respawn = false;
    if (!botPlans.red1) planRound(useMatch.getState().round);
    if (import.meta.env.DEV) {
      (window as unknown as { __teams?: unknown }).__teams = { restartMatch, botPlans, teamEventLog, useMatch, roundReset, getBrain, setBrain, getDynamicCover };
    }
    return () => {
      combatRules.respawn = true;
    };
  }, []);

  useFrame(() => {
    const now = Date.now();
    const frameMs = lastFrameAt ? Math.min(250, now - lastFrameAt) : 0;
    lastFrameAt = now;
    const m = useMatch.getState();
    const ents = useGame.getState().entities;
    syncIntroUi(now);
    if (!ents[LOCAL_ID] || !ents.red1) return; // not spawned yet
    if (m.phase === "warmup") {
      if (isPlaying()) {
        resetEveryone(1);
        m.beginIntro(1);
      }
      return;
    }
    if (m.phase === "intro") {
      if (!isPlaying()) {
        // Paused mid-intro: hold the timeline where it is.
        useMatch.setState({ introStartedAt: m.introStartedAt + frameMs });
        return;
      }
      if (now - m.introStartedAt >= INTRO_GO_MS) {
        m.startRound(m.round);
        markGo();
        syncIntroUi(now);
      }
      return;
    }
    if (m.phase === "live") {
      const blue = aliveCount(BLUE_IDS);
      const red = aliveCount(RED_IDS);
      if (blue === 0) decideRound("red");
      else if (red === 0) decideRound("blue");
      return;
    }
    if (m.phase === "round_end" && Date.now() - roundEndedAt >= ROUND_END_MS) {
      const next = m.round + 1;
      resetEveryone(next);
      m.beginIntro(next);
    }
  });

  return (
    <>
      <MapCover />
      <DynamicCover />
      <TeamBots />
      <IntroCamera />
    </>
  );
}
