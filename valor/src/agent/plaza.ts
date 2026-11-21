// plaza.ts — VALOR's plaza geometry as the agent side sees it.
// Re-uses the game's own numbers (src/game/teamAI.ts: spawns, permanent cover,
// lane split, bot combat tuning) so the setup, the self-check and the headless
// simulator can't drift from what the game actually renders. Pure data; the
// teamAI import is side-effect free (it also loads fine under Node / vitest).

import { BLUE_COMBAT, BOT_COMBAT, BOT_SPAWNS, DYN_SIZE, MAP_COVER, MID_Z, PLAYER_SPAWN, STACKED_ON, laneOf } from "../game/teamAI";

export { BLUE_COMBAT, BOT_COMBAT, BOT_SPAWNS, MID_Z, PLAYER_SPAWN, laneOf };

export const LANES = ["left", "mid", "right"] as const;
export type Lane = (typeof LANES)[number];
/** Lane centre X (player faces -Z at spawn; +X is the player's right). laneOf splits at 8.5 / 15.5. */
export const LANE_X: Record<Lane, number> = { left: 6, mid: 12, right: 18 };
/** Usable width of each lane between the plaza edge and the lane splits (approx.). */
export const LANE_WIDTH_M: Record<Lane, number> = { left: 5.5, mid: 7, right: 6 };
export const MIN_PASSABLE_M = 1.5;
export const BLUE_SPAWN_Z = PLAYER_SPAWN[2]; // -9.5
export const RED_SPAWN_Z = BOT_SPAWNS.red2[1]; // -29
export const SPAWN_CLEARANCE_M = 3;

export type CoverKind = "tree" | "crate" | "wall";
export interface CoverPiece {
  x: number;
  z: number;
  /** Width across the lane (X), metres. */
  w: number;
  source: "map" | "agent";
  name?: string;
  kind?: CoverKind | "concrete";
}

/** Permanent cover from the game (stacked tops skipped — they sit on a base). */
export const MAP_COVER_PIECES: CoverPiece[] = MAP_COVER.filter((_, i) => STACKED_ON[i] === undefined).map((c) => ({
  x: c.x,
  z: c.z,
  w: Math.abs(Math.cos(c.yaw ?? 0)) * c.w + Math.abs(Math.sin(c.yaw ?? 0)) * c.d,
  source: "map" as const,
  kind: c.mat === "crate" ? ("crate" as const) : ("concrete" as const),
}));

export const DYN_WIDTH: Record<CoverKind, number> = { tree: DYN_SIZE.tree.w, crate: DYN_SIZE.crate.w, wall: DYN_SIZE.wall.w };

export const SPAWN_POINTS: Array<[number, number]> = [[PLAYER_SPAWN[0], PLAYER_SPAWN[2]], ...Object.values(BOT_SPAWNS)];

/**
 * Red position option → where red bot i (0 left, 1 mid, 2 right) ends up.
 * Mirrors the LAST waypoint of redRoute() in src/game/teamAI.ts.
 */
export function redPost(position: string, i: number): { x: number; z: number; inCover: boolean } {
  switch (position) {
    case "watch_left_flank":
      return { x: 5.5 + i * 0.9, z: -21.8, inCover: false };
    case "watch_right_flank":
      return { x: 18.6 + (i - 1) * 0.9, z: -21.6, inCover: false };
    case "push_forward":
      return i === 1 ? { x: 12.8, z: -16.5, inCover: false } : { x: i === 0 ? 5.5 : 18, z: -17, inCover: false };
    case "hold_cover":
      return [{ x: 4.4, z: -25.9, inCover: true }, { x: 11.1, z: -24.2, inCover: true }, { x: 18.6, z: -25.5, inCover: true }][i];
    case "hold_mid":
    default:
      return { x: 12 + (i - 1) * 2, z: -21.2, inCover: false };
  }
}
/** Blue ally holds (teamAI planRound allyRoutes, last waypoint) — fixed, beside a block. */
export const ALLY_POSTS: Array<{ id: string; lane: Lane; x: number; z: number }> = [
  { id: "ally1", lane: "left", x: 6.4, z: -14.4 },
  { id: "ally2", lane: "right", x: 17.9, z: -14.5 },
];
