// ─────────────────────────────────────────────────────────────────────────
// sim.ts — headless 3v3 round simulator of VALOR's plaza. Pure TS (Node + browser).
//
// FAITHFUL where it matters (numbers imported from the game, not copied):
//   • spawns, red posts per position option, ally holds and the permanent cover
//     come from src/game/teamAI.ts (via plaza.ts);
//   • bot shots use the game's model (Bot.tsx + teamAI.BOT_COMBAT):
//       hit = accuracy × max(0, 1 − dist/45) × (target moving ? 0.45 : 1)
//                      × (shooter moving ? 0.8 : 1),
//     reaction delay before the first shot, a random 0.5–0.95 s gap between
//     shots, 34 m range; red accuracy/reaction/damage from Brain.getSettings(),
//     blue allies from BLUE_COMBAT; 100 HP; the player's pistol does 20/shot;
//   • every red choice goes through Brain.decide() — the same call planRound()
//     makes in the game — and agent cover comes from getSettings().cover;
//   • "died in the open" uses the game's rule (no cover within 2.5 m).
// ABSTRACTED (see docs/LIMITATIONS.md): line of sight is lane-based (same lane =
// visible; adjacent lanes only once both are past the halfway line, and then
// only the nearest enemy — a corner peek; or at the same depth ±1.5 m);
// a crouched unit right behind cover takes ×0.5 accuracy from the FRONT only
// (flank shots ignore it); bots facing their own lane need extra time to turn
// to an attacker from another lane; the human is a scripted policy with
// assumed aim (SIM_TUNING) — not measured from real players.
// ─────────────────────────────────────────────────────────────────────────

import { DECISIONS, type Brain, type Facts } from "./brain";
import type { EventData } from "./protocol";
import {
  ALLY_POSTS,
  BLUE_COMBAT,
  BOT_COMBAT,
  BOT_SPAWNS,
  LANES,
  LANE_X,
  MAP_COVER_PIECES,
  MID_Z,
  PLAYER_SPAWN,
  laneOf,
  redPost,
  type CoverPiece,
  type Lane,
} from "./plaza";
import { DYN_WIDTH } from "./plaza";

export const MAX_HEALTH = 100;
/** teamAI BOT_COMBAT.vsBotDamageMul (bots trade faster with each other than with the human). */
const BOT_VS_BOT_MUL = (BOT_COMBAT as { vsBotDamageMul?: number }).vsBotDamageMul ?? 1;
export const PLAYER_SHOT_DAMAGE = 20;

/** Assumptions about the human and the abstraction (NOT measured — see LIMITATIONS.md). */
export const SIM_TUNING = {
  playerAccuracy: 0.25, // per-shot hit chance at point-blank vs a standing target
  playerFireInterval: 0.45, // s between aimed shots (gun cap is 0.25)
  playerReactionSec: 0.35,
  playerMovingAimPenalty: 0.6,
  playerVsMovingTarget: 0.75,
  coverFactor: 0.5, // frontal accuracy multiplier on a crouched unit behind cover
  turnSurpriseSec: 0.9, // extra red reaction vs an attacker from a lane it isn't watching
  runSpeed: 5.0,
  walkSpeed: 3.5,
  laneChangeSec: 1.4,
  roundTimeoutSec: 90,
  dt: 0.1,
  coverGrabM: 2.0, // a non-cover-user still crouches behind cover this close to where they stop
  coverSeekM: 4.0, // a cover-user moves to cover this close when shot at
  openRadiusM: 2.5, // teamAI.isInOpen radius
};

export interface RoundPlan {
  lane: Lane;
  usesCover: boolean;
  rush: boolean;
}
export interface ScriptedPlayer {
  id: string;
  about: string;
  plan(rng: () => number, round: number): RoundPlan;
}
export const PLAYERS: Record<string, ScriptedPlayer> = {
  flank_left_always: {
    id: "flank_left_always",
    about: "Always goes up the left lane, uses cover, and attacks the enemy from the side.",
    plan: () => ({ lane: "left", usesCover: true, rush: false }),
  },
  rush_open_mid: {
    id: "rush_open_mid",
    about: "Sprints up the open middle to the enemy line and fights there (only crouches behind cover right where they stop).",
    plan: () => ({ lane: "mid", usesCover: false, rush: true }),
  },
  mixed_random: {
    id: "mixed_random",
    about: "Random lane each round; uses cover half the time; rushes 30% of the time.",
    plan: (rng) => ({ lane: LANES[Math.floor(rng() * 3)], usesCover: rng() < 0.5, rush: rng() < 0.3 }),
  },
};

/** A player model fitted to observed habit frequencies (used by the self-check). */
export type Habit = { left: number; mid: number; right: number; cover: number; rush: number };
export function habitModel(p: Habit): ScriptedPlayer {
  const tot = p.left + p.mid + p.right || 1;
  return {
    id: "habit_model",
    about: `lanes L${p.left}/M${p.mid}/R${p.right}, cover ${p.cover.toFixed(2)}, rush ${p.rush.toFixed(2)}`,
    plan: (rng) => {
      const r = rng() * tot;
      const lane: Lane = r < p.left ? "left" : r < p.left + p.mid ? "mid" : "right";
      return { lane, usesCover: rng() < p.cover, rush: rng() < p.rush };
    },
  };
}

interface Unit {
  id: string;
  team: "blue" | "red";
  isPlayer: boolean;
  enemyIndex: number;
  lane: Lane;
  x: number;
  z: number;
  goalZ: number;
  hp: number;
  alive: boolean;
  inCover: boolean;
  moving: boolean;
  watch: Lane;
  speed: number;
  seen: Map<string, number>;
  nextShot: number;
  laneChangeLeft: number;
  laneTo: Lane | null;
  quietFor: number;
  engagedFor: number;
  accuracy: number;
  reaction: number;
  damage: number;
  position?: string;
  target?: string;
  style?: string;
  plan?: RoundPlan;
}

export interface RoundResult {
  winner: "blue" | "red";
  how: string;
  seconds: number;
  playerLane: Lane;
  playerDied: boolean;
  playerDiedInOpen: boolean;
  playerKills: number;
  timeToPlayerDeath: number | null;
  /** Seconds from the first enemy hit on the player to the player's death. */
  enemyTtk: number | null;
  redPositions: string[];
  redByRule: boolean[];
  plan: RoundPlan;
}

export interface SimEvent {
  name: string;
  by: string;
  t: number;
  data: EventData;
  picked?: Record<string, string>;
  by_rule?: string[];
}

const laneIdx = (l: Lane) => LANES.indexOf(l);
const d2 = (a: Unit, b: Unit) => Math.hypot(a.x - b.x, a.z - b.z);

export function coverPieces(brain: Brain): CoverPiece[] {
  return [
    ...MAP_COVER_PIECES,
    ...brain.getSettings().cover.map((c) => ({ x: c.x, z: c.z, w: DYN_WIDTH[c.kind], source: "agent" as const, kind: c.kind })),
  ];
}

export function simulateRound(opts: { brain: Brain; player: ScriptedPlayer; round: number; rng: () => number; onEvent?: (e: SimEvent) => void; lastPlayerZone?: Facts["player_zone"] }): RoundResult {
  const { brain, rng, round } = opts;
  const T = SIM_TUNING;
  const st = brain.getSettings();
  const cover = coverPieces(brain);
  const emit = (e: SimEvent) => opts.onEvent?.(e);
  const plan = opts.player.plan(rng, round);
  const r1 = (v: number) => Math.round(v * 10) / 10;

  const mk = (id: string, team: "blue" | "red", x: number, z: number, extra: Partial<Unit> = {}): Unit => ({
    id,
    team,
    isPlayer: false,
    enemyIndex: -1,
    lane: laneOf(x),
    x,
    z,
    goalZ: z,
    hp: MAX_HEALTH,
    alive: true,
    inCover: false,
    moving: false,
    watch: laneOf(x),
    speed: BOT_COMBAT.walkSpeed,
    seen: new Map(),
    nextShot: 0,
    laneChangeLeft: 0,
    laneTo: null,
    quietFor: 0,
    engagedFor: 0,
    accuracy: BLUE_COMBAT.accuracy,
    reaction: BLUE_COMBAT.reactionSec,
    damage: BLUE_COMBAT.damage,
    ...extra,
  });

  // ── Blue: the scripted player + the two fixed allies ────────────────────
  const player = mk("player", "blue", PLAYER_SPAWN[0], PLAYER_SPAWN[2], {
    isPlayer: true,
    plan,
    speed: plan.rush ? T.runSpeed : T.walkSpeed,
    accuracy: T.playerAccuracy,
    reaction: T.playerReactionSec,
    damage: PLAYER_SHOT_DAMAGE,
  });
  player.goalZ = plan.lane === "mid" ? (plan.rush ? -20.9 : -17) : -22;
  if (plan.lane !== "mid") {
    player.laneTo = plan.lane;
    player.laneChangeLeft = T.laneChangeSec;
  }
  const allies = ALLY_POSTS.map((a) => {
    const [sx, sz] = BOT_SPAWNS[a.id];
    const u = mk(a.id, "blue", sx, sz);
    u.lane = a.lane;
    u.x = a.x;
    u.goalZ = a.z;
    return u;
  });

  // ── Red: every choice through the brain (as teamAI.planRound does) ──────
  const reds: Unit[] = [];
  const redPositions: string[] = [];
  const redByRule: boolean[] = [];
  const redIds = ["red1", "red2", "red3"];
  for (let i = 0; i < 3; i++) {
    const facts: Facts = { round, enemy_index: i, player_zone: opts.lastPlayerZone ?? "unknown", player_in_open: true, allies_alive: 3, opponents_alive: 3 };
    const p = brain.decide("position", DECISIONS.position, facts);
    const tg = brain.decide("target", DECISIONS.target, facts);
    const sy = brain.decide("style", DECISIONS.style, facts);
    const post = redPost(p.choice, i);
    const [sx, sz] = BOT_SPAWNS[redIds[i]];
    const u = mk(redIds[i], "red", sx, sz, {
      enemyIndex: i,
      accuracy: st.enemy_accuracy,
      reaction: st.enemy_reaction_sec,
      damage: st.enemy_damage,
      position: p.choice,
      target: tg.choice,
      style: sy.choice,
    });
    u.lane = laneOf(post.x);
    u.x = post.x;
    u.goalZ = post.z;
    u.watch = u.lane;
    reds.push(u);
    redPositions.push(p.choice);
    redByRule.push(p.byRule);
    const byRule = [p.byRule && "position", tg.byRule && "target", sy.byRule && "style"].filter(Boolean) as string[];
    emit({ name: "round_start", by: "red", t: 0, data: { enemy_index: i, lane: u.lane }, picked: { position: p.choice, target: tg.choice, style: sy.choice }, by_rule: byRule });
  }

  const blue = [player, ...allies];
  const all = [...blue, ...reds];
  let t = 0;
  let playerKills = 0;
  let firstHitOnPlayer: number | null = null;
  let timeToPlayerDeath: number | null = null;
  let diedInOpen = false;

  const coverNear = (x: number, z: number, r: number): CoverPiece | null => {
    let best: CoverPiece | null = null;
    let bd = r;
    for (const c of cover) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d <= bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  const nearestCoverM = (u: Unit) => {
    let best = Infinity;
    for (const c of cover) best = Math.min(best, Math.hypot(c.x - u.x, c.z - u.z));
    return r1(best);
  };
  /** Cover in the unit's lane between it and the enemy side within `ahead` m (or just behind). */
  const coverAhead = (u: Unit, ahead: number): CoverPiece | null => {
    let best: CoverPiece | null = null;
    for (const c of cover) {
      if (laneOf(c.x) !== u.lane) continue;
      const dz = u.z - c.z; // + = ahead (toward red)
      if (dz >= -1 && dz <= ahead && (!best || Math.abs(dz) < Math.abs(u.z - best.z))) best = c;
    }
    return best;
  };

  const visible = (a: Unit, b: Unit): boolean => {
    if (!a.alive || !b.alive || a.laneChangeLeft > 0 || b.laneChangeLeft > 0) return false;
    if (d2(a, b) > BOT_COMBAT.range) return false;
    const gap = Math.abs(laneIdx(a.lane) - laneIdx(b.lane));
    if (gap === 0) return true;
    if (gap > 1) return false;
    if (Math.abs(a.z - b.z) < 1.5) return true;
    const bl = a.team === "blue" ? a : b;
    const rd = a.team === "red" ? a : b;
    if (!(bl.z < MID_Z && rd.z < MID_Z)) return false;
    // corner peek: only the nearest live red in that lane is exposed
    let nearest: Unit | null = null;
    for (const r of reds) if (r.alive && r.lane === rd.lane && (!nearest || d2(bl, r) < d2(bl, nearest))) nearest = r;
    return nearest === rd;
  };

  const killUnit = (victim: Unit, killer: Unit) => {
    victim.alive = false;
    victim.moving = false;
    if (killer.isPlayer) {
      playerKills++;
      emit({ name: "kill", by: "player", t: r1(t), data: { lane: player.lane, distance_m: Math.round(d2(killer, victim)), enemy_index: victim.enemyIndex, enemy_was_watching: victim.watch } });
    }
    if (victim.isPlayer) {
      timeToPlayerDeath = t;
      diedInOpen = !coverNear(victim.x, victim.z, T.openRadiusM);
      emit({ name: "death", by: "player", t: r1(t), data: { lane: victim.lane, in_open: diedInOpen ? "yes" : "no", killer_index: killer.enemyIndex, seconds_into_round: r1(t) } });
      if (diedInOpen) emit({ name: "died_in_open", by: "player", t: r1(t), data: { lane: victim.lane, nearest_cover_m: nearestCoverM(victim) } });
    }
  };

  const shoot = (s: Unit, target: Unit) => {
    const d = d2(s, target);
    let acc = s.accuracy * Math.max(0, 1 - d / BOT_COMBAT.accuracyFalloffM);
    if (s.isPlayer) {
      if (target.moving) acc *= T.playerVsMovingTarget;
      if (s.moving) acc *= T.playerMovingAimPenalty;
      s.nextShot = T.playerFireInterval;
    } else {
      if (target.moving) acc *= BOT_COMBAT.movingPenalty;
      if (s.moving) acc *= BOT_COMBAT.selfMovingPenalty;
      const [lo, hi] = BOT_COMBAT.fireIntervalSec;
      s.nextShot = lo + rng() * (hi - lo);
    }
    // crouched behind cover: only protects against fire from the front (same lane)
    if (target.inCover && s.lane === target.lane) acc *= T.coverFactor;
    const hit = rng() < acc;
    const dmg = !s.isPlayer && !target.isPlayer ? s.damage * BOT_VS_BOT_MUL : s.damage;
    if (s.isPlayer) emit({ name: "shot", by: "player", t: r1(t), data: { hit: hit ? "yes" : "no", distance_m: Math.round(d), lane: s.lane } });
    if (!hit) return;
    if (target.isPlayer && firstHitOnPlayer === null) firstHitOnPlayer = t;
    target.hp -= dmg;
    if (target.hp <= 0) killUnit(target, s);
  };

  let lastLaneSent: Lane = "mid";
  while (t < T.roundTimeoutSec) {
    const blueAlive = blue.filter((u) => u.alive).length;
    const redAlive = reds.filter((u) => u.alive).length;
    if (!blueAlive || !redAlive) break;

    for (const u of all) {
      if (!u.alive) continue;
      const opp = u.team === "blue" ? reds : blue;
      const foes = opp.filter((f) => visible(u, f));
      for (const f of opp) {
        if (foes.includes(f)) u.seen.set(f.id, (u.seen.get(f.id) ?? 0) + T.dt);
        else u.seen.delete(f.id);
      }
      u.nextShot -= T.dt;
      const engaged = foes.length > 0;
      u.quietFor = engaged ? 0 : u.quietFor + T.dt;

      // ── lane changes ──
      if (u.laneChangeLeft > 0) {
        u.laneChangeLeft -= T.dt;
        u.moving = true;
        u.inCover = false;
        if (u.laneChangeLeft <= 0 && u.laneTo) {
          u.lane = u.laneTo;
          u.x = LANE_X[u.lane];
          u.laneTo = null;
          if (u.team === "red") u.watch = u.lane;
          if (u.isPlayer && u.lane !== lastLaneSent) {
            emit({ name: "player_lane_change", by: "player", t: r1(t), data: { lane: u.lane, from: lastLaneSent, seconds_into_round: r1(t) } });
            lastLaneSent = u.lane;
          }
        }
        continue;
      }

      // ── movement ──
      let wantMove = Math.abs(u.z - u.goalZ) > 1e-3;
      if (u.team === "blue") {
        const usesCover = u.isPlayer ? u.plan!.usesCover : true;
        const rush = u.isPlayer ? u.plan!.rush : false;
        if (engaged) {
          if (usesCover && !u.inCover) {
            const c = coverAhead(u, T.coverSeekM);
            if (c) {
              u.goalZ = c.z + 0.7; // crouch on the near side
              wantMove = Math.abs(u.z - u.goalZ) > 1e-3;
            } else wantMove = false;
          } else if (!rush) wantMove = false;
        }
        if (!engaged && !wantMove && u.quietFor > 2) {
          // nothing in sight: allies push on after a while, everyone then sweeps toward the reds
          const target = reds.filter((r) => r.alive).sort((a, b) => Math.abs(laneIdx(a.lane) - laneIdx(u.lane)) - Math.abs(laneIdx(b.lane) - laneIdx(u.lane)))[0];
          const patience = u.isPlayer ? 2 : 10;
          if (target && u.quietFor > patience) {
            if (target.lane !== u.lane && (u.z < MID_Z || !u.isPlayer)) {
              u.laneTo = LANES[laneIdx(u.lane) + Math.sign(laneIdx(target.lane) - laneIdx(u.lane))];
              u.laneChangeLeft = T.laneChangeSec;
            } else u.goalZ = Math.min(u.goalZ, target.z + 2.5);
            u.quietFor = 0;
          }
        }
      } else {
        if (engaged && u.style === "retreat_to_cover" && !u.inCover) {
          const c = coverNear(u.x, u.z, 6);
          if (c) u.goalZ = c.z - 0.7;
          wantMove = Math.abs(u.z - u.goalZ) > 1e-3;
        } else if (engaged) wantMove = false;
        if (!engaged && t > 30 && u.quietFor > 8) {
          const b = blue.filter((x) => x.alive).sort((a, c) => Math.abs(laneIdx(a.lane) - laneIdx(u.lane)) - Math.abs(laneIdx(c.lane) - laneIdx(u.lane)))[0];
          if (b && b.lane !== u.lane) {
            u.laneTo = LANES[laneIdx(u.lane) + Math.sign(laneIdx(b.lane) - laneIdx(u.lane))];
            u.laneChangeLeft = T.laneChangeSec;
          } else if (b) u.goalZ = Math.max(u.goalZ, b.z - 3);
          u.quietFor = 0;
        }
      }
      if (wantMove) {
        const step = u.speed * T.dt;
        const dz = u.goalZ - u.z;
        u.z += Math.sign(dz) * Math.min(step, Math.abs(dz));
        u.moving = true;
        u.inCover = false;
      } else {
        u.moving = u.team === "red" && engaged && u.style === "strafe_and_shoot";
        // stopped: crouch if cover is right here (red hold_cover posts sit behind map cover)
        const grab = u.isPlayer && !u.plan!.usesCover ? T.coverGrabM : 1.6;
        if (!u.inCover && coverNear(u.x, u.z, grab)) u.inCover = true;
      }

      // ── shooting ──
      if (!engaged) {
        u.engagedFor = 0;
        continue;
      }
      u.engagedFor += T.dt;
      let target: Unit;
      if (u.team === "red" && foes.length > 1) {
        if (u.target === "player_first" && foes.includes(player)) target = player;
        else if (u.target === "weakest") target = foes.slice().sort((a, b) => a.hp - b.hp)[0];
        else target = foes.slice().sort((a, b) => d2(u, a) - d2(u, b))[0];
      } else target = foes.slice().sort((a, b) => d2(u, a) - d2(u, b))[0];
      if (u.team === "red" && u.style === "retreat_to_cover" && u.moving) continue;
      const react = u.reaction + (u.team === "red" && target.lane !== u.watch ? T.turnSurpriseSec : 0);
      if ((u.seen.get(target.id) ?? 0) >= react && u.nextShot <= 0) shoot(u, target);
    }
    t += T.dt;
  }

  const blueAlive = blue.filter((u) => u.alive).length;
  const redAlive = reds.filter((u) => u.alive).length;
  const winner: "blue" | "red" = redAlive === 0 && blueAlive > 0 ? "blue" : blueAlive === 0 ? "red" : blueAlive > redAlive ? "blue" : "red";
  const route = plan.lane === "left" ? "flank_left" : plan.lane === "right" ? "flank_right" : "rush_mid";
  return {
    winner,
    how: !player.alive && diedInOpen ? "picked_off" : route,
    seconds: r1(t),
    playerLane: plan.lane,
    playerDied: !player.alive,
    playerDiedInOpen: !player.alive && diedInOpen,
    playerKills,
    timeToPlayerDeath,
    enemyTtk: timeToPlayerDeath !== null && firstHitOnPlayer !== null ? r1(timeToPlayerDeath - firstHitOnPlayer) : null,
    redPositions,
    redByRule,
    plan,
  };
}

/** Monte-Carlo estimate of the player's round win-rate (used by the self-check). */
export function predictWinRate(brain: Brain, player: ScriptedPlayer, n: number, rng: () => number, round = 2): number {
  let w = 0;
  for (let i = 0; i < n; i++) if (simulateRound({ brain, player, round, rng }).winner === "blue") w++;
  return w / n;
}
