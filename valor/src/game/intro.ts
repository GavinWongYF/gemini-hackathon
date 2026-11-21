// ─────────────────────────────────────────────────────────────────────────
// intro.ts — timeline of the pre-round intro (match phase "intro").
//
//   0 ─────────── 3.0 s ──── 4.3 s ─────────────────── 6.0 s ── 6.8 s
//   │  OVERVIEW   │   FLY    │                         │  GO    │
//   │  high-angle │  camera  │                         │ banner │
//   │  sweep over │  eases   │                         │ (live) │
//   │  both teams │  into    │                         │        │
//   │  + labels   │  the eyes│                         │        │
//                 │◄─ "3" ──►│◄── "2" ──►│◄── "1" ────►│
//
// Nobody moves, shoots or takes damage until GO (Bot/combat gate on phase
// "live"; PlayerController freezes movement; Weapon refuses to fire). Mouse
// look is discarded while the intro camera owns the view and allowed again
// once it lands (you can line up your first angle during "2 · 1").
//
// The timeline is wall-clock from useMatch.introStartedAt; RoundManager slides
// that start forward while the game is paused (Esc / phone paused), so a pause
// mid-intro freezes the countdown instead of letting the round go live.
// ─────────────────────────────────────────────────────────────────────────

import { create } from "zustand";
import { useMatch } from "./match";

export const INTRO_OVERVIEW_MS = 3000;
export const INTRO_FLY_MS = 1300;
export const INTRO_STEP_MS = 1000; // each of 3 · 2 · 1
/** The countdown starts as the camera starts flying down. */
export const INTRO_COUNT_START_MS = INTRO_OVERVIEW_MS;
/** GO = the round goes live. */
export const INTRO_GO_MS = INTRO_COUNT_START_MS + 3 * INTRO_STEP_MS;
/** How long "GO" stays on screen after the round goes live. */
export const GO_SHOW_MS = 800;

export type IntroStage = "none" | "overview" | "fly" | "count" | "go";

/** ms into the current intro, or -1 when the match is not in "intro". */
export function introElapsed(now = Date.now()): number {
  const m = useMatch.getState();
  if (m.phase !== "intro") return -1;
  return Math.max(0, now - m.introStartedAt);
}

export function stageAt(elapsed: number): IntroStage {
  if (elapsed < 0) return "none";
  if (elapsed < INTRO_OVERVIEW_MS) return "overview";
  if (elapsed < INTRO_OVERVIEW_MS + INTRO_FLY_MS) return "fly";
  return "count";
}

/** "3" / "2" / "1" during the countdown, else null. */
export function countAt(elapsed: number): string | null {
  if (elapsed < INTRO_COUNT_START_MS || elapsed >= INTRO_GO_MS) return null;
  return String(3 - Math.floor((elapsed - INTRO_COUNT_START_MS) / INTRO_STEP_MS));
}

/** True while the intro camera owns the view (overview + fly-down). */
export function introCameraActive(now = Date.now()): boolean {
  const e = introElapsed(now);
  return e >= 0 && e < INTRO_OVERVIEW_MS + INTRO_FLY_MS;
}

/** Low-frequency UI mirror of the timeline (changes ~6 times per round) so
 *  React overlays (HUD, Countdown, phone feedback) re-render only on a step. */
export interface IntroUi {
  stage: IntroStage;
  /** "3" | "2" | "1" | "GO" | null */
  count: string | null;
}
export const useIntro = create<IntroUi>(() => ({ stage: "none", count: null }));

let goUntil = 0;
/** Called once by RoundManager the instant the round goes live. */
export function markGo() {
  goUntil = Date.now() + GO_SHOW_MS;
}

/** Recompute the UI mirror (RoundManager calls this every frame). */
export function syncIntroUi(now = Date.now()) {
  const e = introElapsed(now);
  let stage = stageAt(e);
  let count = countAt(e);
  if (stage === "none" && now < goUntil && useMatch.getState().phase === "live") {
    stage = "go";
    count = "GO";
  }
  const cur = useIntro.getState();
  if (cur.stage !== stage || cur.count !== count) useIntro.setState({ stage, count });
}
