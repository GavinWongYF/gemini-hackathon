// ─────────────────────────────────────────────────────────────────────────
// match.ts — SHARED CONTRACT for the 3v3 round-based match (team AI, HUD, agent
// bridge all read/write this). Keep the shape stable; add fields, don't rename.
//
//   Teams:  "blue" = the local player + 2 ally bots, "red" = 3 enemy bots.
//   Round:  a team wins the round when every member of the other team is dead
//           (no respawn inside a round). First to ROUNDS_TO_WIN rounds wins.
//   Phases: "warmup" (before the first click) → "intro" (overview camera over
//           both teams, then 3·2·1·GO — nobody moves/shoots/takes damage) →
//           "live" → "round_end" (short banner, then everyone respawns at their
//           side) → "intro" → "live" → … → "match_end".  See intro.ts.
// ─────────────────────────────────────────────────────────────────────────

import { create } from "zustand";

export type Team = "blue" | "red";
export type MatchPhase = "warmup" | "intro" | "live" | "round_end" | "match_end";

export const TEAM_SIZE = 3;
export const ROUNDS_TO_WIN = 4; // best of 7
export const ROUND_END_MS = 6000; // banner + agent card time between rounds (readable on stage)

export interface RoundSummary {
  round: number; // 1-based
  winner: Team;
  durationSec: number;
  /** How the player's team won/lost, for the agents ("flank_left", "rush_mid", "picked_off"…). */
  how: string;
}

export interface MatchState {
  phase: MatchPhase;
  round: number; // 1-based, current/last round
  score: Record<Team, number>;
  roundStartedAt: number; // ms (Date.now)
  lastRound: RoundSummary | null;
  history: RoundSummary[];
  /** Set by the round logic; HUD shows it during round_end/match_end. */
  banner: string | null;
  /** ms (Date.now) the current pre-round intro started (phase "intro"). The
   *  round loop shifts it forward while the game is paused mid-intro. */
  introStartedAt: number;

  setPhase(phase: MatchPhase): void;
  /** Pre-round intro for `round` (overview + countdown); RoundManager calls
   *  startRound(round) when the countdown hits GO. */
  beginIntro(round: number): void;
  startRound(round: number): void;
  endRound(summary: RoundSummary): void;
  reset(): void;
}

export const useMatch = create<MatchState>((set) => ({
  phase: "warmup",
  round: 1,
  score: { blue: 0, red: 0 },
  roundStartedAt: 0,
  lastRound: null,
  history: [],
  banner: null,
  introStartedAt: 0,

  setPhase: (phase) => set({ phase }),
  beginIntro: (round) => set({ round, phase: "intro", introStartedAt: Date.now(), banner: null }),
  startRound: (round) => set({ round, phase: "live", roundStartedAt: Date.now(), banner: null }),
  endRound: (summary) =>
    set((s) => {
      const score = { ...s.score, [summary.winner]: s.score[summary.winner] + 1 };
      const over = score[summary.winner] >= ROUNDS_TO_WIN;
      return {
        score,
        lastRound: summary,
        history: [...s.history, summary],
        phase: over ? "match_end" : "round_end",
        banner: over
          ? summary.winner === "blue" ? "VICTORY" : "DEFEAT"
          : summary.winner === "blue" ? "ROUND WON" : "ROUND LOST",
      };
    }),
  reset: () =>
    set({ phase: "warmup", round: 1, score: { blue: 0, red: 0 }, roundStartedAt: 0, lastRound: null, history: [], banner: null, introStartedAt: 0 }),
}));
