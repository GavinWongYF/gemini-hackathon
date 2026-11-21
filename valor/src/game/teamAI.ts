// ─────────────────────────────────────────────────────────────────────────
// teamAI.ts — 3v3 team layout, round plans and the TEAM EVENT emitter.
//
// Teams: "blue" = LOCAL_ID + ally1 + ally2, "red" = red1..red3.
// This module is React-free (Bot.tsx / RoundManager.tsx / Cover.tsx / combat.ts
// all read it). It owns:
//   • the plaza map knowledge: spawns, lane posts, the PERMANENT cover layout
//     (MAP_COVER) and the agent-placed cover (setDynamicCover / getDynamicCover);
//   • `planRound()` — builds every bot's plan for a round. RED choices go
//     through getBrain().decide() (position / target / style) and red
//     accuracy / reaction / damage come from getBrain().getSettings(), sampled
//     ONCE at round start (the brain is swapped between rounds). Blue allies use
//     a fixed behaviour (BLUE_COMBAT).
//   • `roundReset` — a counter PlayerController watches to teleport the player
//     back to the blue spawn at round start.
//
// ── TEAM EVENTS (for the agent bridge) ────────────────────────────────────
//   import { onTeamEvent, teamEventLog } from "../game/teamAI";
//   const off = onTeamEvent((ev) => { ... });   // returns an unsubscribe fn
//
//   TeamEvent = {
//     kind: "player_kill" | "player_death" | "kill",  // player_kill = local
//                                                     // player killed someone,
//                                                     // player_death = local died,
//                                                     // kill = bot-vs-bot
//     killerId, victimId, killerTeam, victimTeam,
//     round,                   // useMatch round number
//     lane: "left"|"mid"|"right",   // the LOCAL PLAYER's lane at that moment
//     playerInOpen: boolean,   // player had no world cover within ~2.5 m
//     playerPos: [x,y,z], t: ms (Date.now)
//   }
//   `teamEventLog` keeps the last 32. The HUD killfeed keeps using the
//   existing useGame "kill"/"hit" events (combat.ts still pushes those).
// ─────────────────────────────────────────────────────────────────────────

import { CAPSULE, LOCAL_ID, type Vec3 } from "./contracts";
import { raycastShot } from "./hitscan";
import { transforms, useGame } from "./stores";
import { useMatch, type Team } from "./match";
import { DECISIONS, getBrain, type Facts, type MatchSettings, type OptionOf } from "../agent/brain";

// ── Map basics ───────────────────────────────────────────────────────────
/** Plaza floor (feet Y) near the spawns of arena_opt.glb. */
export const FLOOR_Y = -7.12;
/** Feet → capsule centre. */
export const CENTER_OFFSET = CAPSULE.standHalfHeight + CAPSULE.radius; // 0.9

/** Arena floor Y under (x,z): short downward cast from just above the plaza onto
 *  the world BVH; prop roofs (> FLOOR_Y+0.6) are ignored. null = no floor. */
export function floorYAt(x: number, z: number): number | null {
  const hit = raycastShot([x, FLOOR_Y + 2.5, z], [0, -1, 0], 5);
  if (!hit || hit.kind !== "world") return null;
  return hit.point[1] <= FLOOR_Y + 0.6 ? hit.point[1] : null;
}

/** yaw=0 faces -Z (PlayerController convention). */
export function yawToward(fx: number, fz: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - fx), -(tz - fz));
}

export type Lane = "left" | "mid" | "right";
/** Player faces -Z at spawn, so +X is the player's RIGHT. */
export function laneOf(x: number): Lane {
  return x < 8.5 ? "left" : x > 15.5 ? "right" : "mid";
}

export const PLAYER_SPAWN: Vec3 = [12, -6, -9.5]; // capsule centre-ish (PlayerController)
export const BLUE_IDS = [LOCAL_ID, "ally1", "ally2"] as const;
export const RED_IDS = ["red1", "red2", "red3"] as const;
export const BOT_URL: Record<Team, string> = { blue: "/models/character_a.glb", red: "/models/character_b.glb" };

/** Feet spawn XZ per bot id. */
export const BOT_SPAWNS: Record<string, [number, number]> = {
  ally1: [8, -8.5],
  ally2: [16.5, -8.5],
  red1: [7, -28.5],
  red2: [12, -29],
  red3: [17, -28.5],
};
/** Midline between the halves (z). Red half is z < MID_Z. */
export const MID_Z = -18.5;

// ── Cover ────────────────────────────────────────────────────────────────
export type CoverMat = "concrete" | "crate";
export interface CoverBox {
  /** Centre XZ; y is snapped to the floor at mount. */
  x: number;
  z: number;
  w: number; // size on X (before yaw)
  h: number;
  d: number; // size on Z (before yaw)
  yaw?: number;
  mat: CoverMat;
}

/** Permanent CS/Valorant-style blocks. Chest-high = 1.1 m (crouch cover),
 *  head-high = 1.9 m (full cover). Crate stacks are a 1.1 crate + 0.85 on top.
 *  Kept off the spawns and off the straight spawn→post walking lines. */
export const MAP_COVER: CoverBox[] = [
  // Blue spawn
  { x: 8.6, z: -12.6, w: 2.4, h: 1.1, d: 0.45, mat: "concrete" },
  { x: 16.6, z: -12.9, w: 1.1, h: 1.1, d: 1.1, mat: "crate" },
  // Left lane
  { x: 5, z: -14.6, w: 1.1, h: 1.1, d: 1.1, mat: "crate" },
  { x: 5.05, z: -14.6, w: 0.85, h: 0.85, d: 0.85, yaw: 0.35, mat: "crate" }, // stacked on top (y offset below)
  { x: 4.4, z: -25, w: 2.6, h: 1.1, d: 0.45, mat: "concrete" },
  // Mid
  { x: 12, z: -18.2, w: 3.0, h: 1.1, d: 0.45, mat: "concrete" },
  { x: 9.8, z: -23, w: 1.4, h: 1.9, d: 1.4, mat: "concrete" },
  { x: 14.1, z: -15.2, w: 1.1, h: 1.1, d: 1.1, mat: "crate" },
  // Right lane
  { x: 19.6, z: -15, w: 2.4, h: 1.9, d: 0.45, mat: "concrete" },
  { x: 20.2, z: -20.2, w: 1.1, h: 1.1, d: 1.1, mat: "crate" },
  { x: 21.35, z: -20.1, w: 1.1, h: 1.1, d: 1.1, yaw: 0.2, mat: "crate" },
  { x: 18.6, z: -24.6, w: 2.4, h: 1.1, d: 0.45, mat: "concrete" },
  // Red spawn
  { x: 14.6, z: -25.2, w: 1.1, h: 1.1, d: 1.1, mat: "crate" },
  { x: 14.6, z: -25.2, w: 0.85, h: 0.85, d: 0.85, yaw: -0.4, mat: "crate" },
];
/** Index pairs [base, top] of stacked crates: the top sits on the base. */
export const STACKED_ON: Record<number, number> = { 3: 2, 13: 12 };

/** Agent-placed cover (getSettings().cover), as rendered. Set at round start. */
export type DynCover = MatchSettings["cover"][number];
let dynamicCover: DynCover[] = [];
const dynListeners = new Set<() => void>();
export function setDynamicCover(c: DynCover[]) {
  dynamicCover = c.slice(0, MAX_DYNAMIC_COVER);
  dynListeners.forEach((f) => f());
}
export const getDynamicCover = () => dynamicCover;
export function subscribeDynamicCover(f: () => void) {
  dynListeners.add(f);
  return () => dynListeners.delete(f);
}
export const MAX_DYNAMIC_COVER = 8;
/** Footprint of an agent cover piece (w on X, h, d on Z before yaw). */
export const DYN_SIZE: Record<DynCover["kind"], { w: number; h: number; d: number }> = {
  tree: { w: 0.7, h: 3.2, d: 0.7 },
  crate: { w: 1.2, h: 1.2, d: 1.2 },
  wall: { w: 3.0, h: 1.4, d: 0.4 },
};

/** Spot to stand behind the nearest cover piece (static or agent) for `team`,
 *  i.e. on the side away from the enemy half. Written into `out`. */
export function nearestCoverSpot(team: Team, x: number, z: number, out: Vec3): boolean {
  let best = Infinity;
  const away = team === "red" ? -1 : 1; // red hides on -Z side, blue on +Z
  const consider = (cx: number, cz: number, d: number) => {
    const sx = cx, sz = cz + away * (d / 2 + 0.6);
    const dd = (sx - x) * (sx - x) + (sz - z) * (sz - z);
    if (dd < best) {
      best = dd;
      out[0] = sx;
      out[2] = sz;
    }
  };
  for (let i = 0; i < MAP_COVER.length; i++) {
    if (STACKED_ON[i] !== undefined) continue;
    const c = MAP_COVER[i];
    consider(c.x, c.z, Math.max(c.d, Math.abs(Math.sin(c.yaw ?? 0)) * c.w));
  }
  for (const c of dynamicCover) consider(c.x, c.z, DYN_SIZE[c.kind].d);
  return best < 12 * 12;
}

// ── Open-ground check ────────────────────────────────────────────────────
const OPEN_DIRS: [number, number][] = [];
for (let i = 0; i < 8; i++) OPEN_DIRS.push([Math.cos((i / 8) * Math.PI * 2), Math.sin((i / 8) * Math.PI * 2)]);
/** True if no world geometry (map props, blocks, agent cover) is within `r` m
 *  of the point at waist height. 8 short rays — call on events, not per frame. */
export function isInOpen(x: number, feetY: number, z: number, r = 2.5): boolean {
  const o: Vec3 = [x, feetY + 0.8, z];
  for (const [dx, dz] of OPEN_DIRS) {
    const h = raycastShot(o, [dx, 0, dz], r);
    if (h && h.kind === "world") return false;
  }
  return true;
}

export function playerSnapshot(): { lane: Lane; inOpen: boolean; pos: Vec3 } {
  const t = transforms[LOCAL_ID];
  if (!t) return { lane: "mid", inOpen: false, pos: [...PLAYER_SPAWN] as Vec3 };
  const feet = t.pos[1] - CENTER_OFFSET;
  return { lane: laneOf(t.pos[0]), inOpen: isInOpen(t.pos[0], feet, t.pos[2]), pos: [t.pos[0], t.pos[1], t.pos[2]] };
}

// ── Team events ──────────────────────────────────────────────────────────
export interface TeamEvent {
  kind: "player_kill" | "player_death" | "kill";
  killerId: string;
  victimId: string;
  killerTeam: Team | null;
  victimTeam: Team | null;
  round: number;
  lane: Lane;
  playerInOpen: boolean;
  playerPos: Vec3;
  t: number;
}
export const teamEventLog: TeamEvent[] = [];
const teamListeners = new Set<(e: TeamEvent) => void>();
export function onTeamEvent(fn: (e: TeamEvent) => void): () => void {
  teamListeners.add(fn);
  return () => {
    teamListeners.delete(fn);
  };
}
/** Info about the local player's last death in the current round (for "how"). */
export const roundInfo = { playerDeath: null as null | { lane: Lane; inOpen: boolean; z: number } };

/** Called by combat.ts when anything dies. */
export function emitKill(killerId: string, victimId: string) {
  const ents = useGame.getState().entities;
  const snap = playerSnapshot();
  const kind: TeamEvent["kind"] = victimId === LOCAL_ID ? "player_death" : killerId === LOCAL_ID ? "player_kill" : "kill";
  if (kind === "player_death") roundInfo.playerDeath = { lane: snap.lane, inOpen: snap.inOpen, z: snap.pos[2] };
  const ev: TeamEvent = {
    kind,
    killerId,
    victimId,
    killerTeam: ents[killerId]?.team ?? null,
    victimTeam: ents[victimId]?.team ?? null,
    round: useMatch.getState().round,
    lane: snap.lane,
    playerInOpen: snap.inOpen,
    playerPos: snap.pos,
    t: Date.now(),
  };
  teamEventLog.push(ev);
  if (teamEventLog.length > 32) teamEventLog.shift();
  teamListeners.forEach((f) => {
    try {
      f(ev);
    } catch (err) {
      console.error(err);
    }
  });
}

// ── Combat tuning ────────────────────────────────────────────────────────
export const BOT_COMBAT = {
  range: 34, // m — engage inside this distance
  fireIntervalSec: [0.5, 0.95] as [number, number],
  /** × red accuracy (getSettings().enemy_accuracy is the base) when the
   *  target is the human (1.7 felt like being hit "from nowhere"; 1.35 gives
   *  the player time to react to the hurt cue / damage arc and turn). */
  vsPlayerAccuracyMul: 1.35,
  /** × damage when a bot shoots another BOT (bots trade faster than they
   *  shoot the human, so rounds don't stall in long bot-vs-bot duels). */
  vsBotDamageMul: 1.5,
  accuracyFalloffM: 45, // accuracy → 0 linearly at this distance
  movingPenalty: 0.45, // × accuracy when the TARGET is moving
  selfMovingPenalty: 0.8, // × accuracy when the SHOOTER is moving
  turnRate: 7, // rad/s
  walkSpeed: 2.6, // m/s
  strafeSpeed: 1.9,
  thinkHz: 8, // LOS/target re-evaluation rate per bot
};
/** Fixed blue-ally skill. */
export const BLUE_COMBAT = { accuracy: 0.38, reactionSec: 0.85, damage: 12 };

// ── Plans ────────────────────────────────────────────────────────────────
export interface BotPlan {
  id: string;
  team: Team;
  index: number;
  /** Version bumps every round so BotActor resets its runtime state. */
  version: number;
  /** Feet spawn XZ. */
  spawn: [number, number];
  /** Waypoints (XZ) to walk to after the round goes live; holds at the last. */
  route: [number, number][];
  target: OptionOf<"target">;
  style: OptionOf<"style">;
  position: OptionOf<"position">;
  accuracy: number;
  reactionSec: number;
  damage: number;
  byRule: boolean;
}
export const botPlans: Record<string, BotPlan> = {};
let planVersion = 0;

/** Red position option → route (XZ) for red bot `i` (0 left, 1 mid, 2 right). */
function redRoute(pos: OptionOf<"position">, i: number): [number, number][] {
  switch (pos) {
    case "watch_left_flank":
      return [[6.5 - i * 0.3, -24], [5.5 + i * 0.9, -21.8]];
    case "watch_right_flank":
      return [[17.5 + i * 0.3, -24], [18.6 + (i - 1) * 0.9, -21.6]];
    case "push_forward": {
      const lane = i === 0 ? 5.5 : i === 1 ? 14.8 : 18;
      return i === 1 ? [[14.8, -22], [14.8, -19.2], [12.8, -16.5]] : [[lane, -22], [lane, -17]];
    }
    case "hold_cover": {
      const spots: [number, number][] = [[4.4, -25.9], [11.1, -24.2], [18.6, -25.5]];
      return [spots[i]];
    }
    case "hold_mid":
    default:
      return [[12 + (i - 1) * 2, -24.5], [12 + (i - 1) * 2, -21.2]];
  }
}

const zoneOf = (lane: Lane | null): Facts["player_zone"] => lane ?? "unknown";

/** Last round's player info → Facts for the next round's decisions. */
export const lastRoundPlayer = { lane: null as Lane | null, inOpen: false };

/** Build all bot plans for `round`. Red decisions through the CURRENT brain. */
export function planRound(round: number): void {
  planVersion++;
  const brain = getBrain();
  const settings = brain.getSettings();
  setDynamicCover(settings.cover ?? []);
  for (let i = 0; i < RED_IDS.length; i++) {
    const facts: Facts = {
      round,
      enemy_index: i,
      player_zone: round === 1 ? "unknown" : zoneOf(lastRoundPlayer.lane),
      player_in_open: lastRoundPlayer.inOpen,
      allies_alive: RED_IDS.length,
      opponents_alive: BLUE_IDS.length,
    };
    const p = brain.decide("position", DECISIONS.position, facts);
    const tg = brain.decide("target", DECISIONS.target, facts);
    const st = brain.decide("style", DECISIONS.style, facts);
    const id = RED_IDS[i];
    botPlans[id] = {
      id,
      team: "red",
      index: i,
      version: planVersion,
      spawn: BOT_SPAWNS[id],
      route: redRoute(p.choice, i),
      position: p.choice,
      target: tg.choice,
      style: st.choice,
      accuracy: settings.enemy_accuracy,
      reactionSec: settings.enemy_reaction_sec,
      damage: settings.enemy_damage,
      byRule: p.byRule || tg.byRule || st.byRule,
    };
  }
  // Blue allies: fixed, sensible — one per flank, peeking beside a block.
  const allyRoutes: Record<string, [number, number][]> = {
    ally1: [[6.6, -11], [6.4, -14.4]],
    ally2: [[17.6, -11], [17.9, -14.5]],
  };
  ["ally1", "ally2"].forEach((id, i) => {
    botPlans[id] = {
      id,
      team: "blue",
      index: i,
      version: planVersion,
      spawn: BOT_SPAWNS[id],
      route: allyRoutes[id],
      position: "hold_cover",
      target: "nearest",
      style: "strafe_and_shoot",
      accuracy: BLUE_COMBAT.accuracy,
      reactionSec: BLUE_COMBAT.reactionSec,
      damage: BLUE_COMBAT.damage,
      byRule: false,
    };
  });
}

/** PlayerController watches `seq`; a bump teleports the player to `spawn`. */
export const roundReset = { seq: 0, spawn: PLAYER_SPAWN };
