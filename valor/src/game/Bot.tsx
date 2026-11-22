// ─────────────────────────────────────────────────────────────────────────
// Bot.tsx — the 5 AI characters of the 3v3 match (2 blue allies, 3 red).
//
// <TeamBots/> registers ally1/ally2 (team "blue", character_a.glb) and
// red1..red3 (team "red", character_b.glb) in useGame on mount, and renders a
// <BotActor/> per bot. Teams read at a glance: coloured ring at the feet and a
// chevron over the head (the ally chevron draws through walls).
//
// Each BotActor follows its round plan from teamAI.botPlans (built by
// planRound(): red choices via getBrain().decide(), red skill via
// getBrain().getSettings(); blue = fixed). A plan `version` bump (new round)
// snaps the bot back to its spawn and resets its runtime state.
//
// PER FRAME (useFrame, no React re-render except anim-state changes):
//   • think tick at BOT_COMBAT.thinkHz (staggered per bot): pick the preferred
//     VISIBLE opponent (line of sight through the world BVH + cover), refresh
//     the floor height under the bot.
//   • move along the route / strafe / retreat to cover depending on style,
//     write capsule-centre pos + signed speeds into transforms[id] (anim
//     arbiter), face the target, and shoot with reaction delay + accuracy
//     falloff + moving penalties. Damage goes through combat.applyDamage
//     (friendly fire is rejected there).
//   • bots only act while the round is LIVE and the mouse is pointer-locked.
// ─────────────────────────────────────────────────────────────────────────

import { isPlaying } from "./playState";
import { introCameraActive } from "./intro";
import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { ConeGeometry, type Group, MeshBasicMaterial, RingGeometry, type Mesh } from "three";
import { Gun } from "../Gun";
import { AnimatedCharacter } from "./AnimatedCharacter";
import { LOCAL_ID, resolveAnimState, type AnimState, type Vec3 } from "./contracts";
import { makeEntity, transforms, useGame } from "./stores";
import { raycastShot } from "./hitscan";
import { playSfx, setEntityWalk } from "./sfx";
import { combat } from "./combat";
import { TRACER_COLOR, vfx } from "./vfx";
import { Billboard, Text } from "@react-three/drei";
import { displayName } from "./ui/roster";
import { useMatch, type Team } from "./match";
import {
  BLUE_IDS,
  BOT_COMBAT,
  BOT_SPAWNS,
  BOT_URL,
  CENTER_OFFSET,
  FLOOR_Y,
  RED_IDS,
  botPlans,
  floorYAt,
  nearestCoverSpot,
} from "./teamAI";

export { BOT_COMBAT } from "./teamAI";

const EYE = 0.55; // above capsule centre ≈ gun height
const BOT_WALK_MAX_DIST = 18; // m — footsteps silent beyond
const BOT_IDS = ["ally1", "ally2", ...RED_IDS] as const;
const TEAM_OF: Record<string, Team> = { ally1: "blue", ally2: "blue", red1: "red", red2: "red", red3: "red" };

// Shared marker geometry/materials (one copy for all bots).
const ringGeo = new RingGeometry(0.42, 0.56, 32);
const chevronGeo = new ConeGeometry(0.13, 0.26, 4);
const MARK: Record<Team, { ring: MeshBasicMaterial; chev: MeshBasicMaterial }> = {
  blue: {
    ring: new MeshBasicMaterial({ color: "#3aa0ff", transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }),
    chev: new MeshBasicMaterial({ color: "#4fb0ff", depthTest: false, transparent: true, opacity: 0.9, toneMapped: false }),
  },
  red: {
    ring: new MeshBasicMaterial({ color: "#ff3b3b", transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }),
    chev: new MeshBasicMaterial({ color: "#ff4a4a", toneMapped: false }),
  },
};

// Scratch (no per-frame allocation in the LOS path).
const sFrom: Vec3 = [0, 0, 0];
const sDir: Vec3 = [0, 0, 0];

/** Clear line of sight from shooter centre (sx,sy,sz) to target `id`'s chest?
 *  Returns the distance, or -1 if blocked by world/cover or another body. */
function lineOfSight(sx: number, sy: number, sz: number, id: string): number {
  const tt = transforms[id];
  if (!tt) return -1;
  const fy = sy + EYE;
  const tx = tt.pos[0], ty = tt.pos[1] + 0.3 - 0.35 * tt.crouchAmount, tz = tt.pos[2];
  const dx = tx - sx, dy = ty - fy, dz = tz - sz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.6 || dist > BOT_COMBAT.range) return -1;
  sDir[0] = dx / dist;
  sDir[1] = dy / dist;
  sDir[2] = dz / dist;
  // Start just outside our own capsule so we don't hit ourselves.
  sFrom[0] = sx + sDir[0] * 0.45;
  sFrom[1] = fy + sDir[1] * 0.45;
  sFrom[2] = sz + sDir[2] * 0.45;
  const reach = dist - 0.45;
  const hit = raycastShot(sFrom, sDir, reach);
  if (!hit) return dist;
  if (hit.kind === "entity") return hit.entityId === id ? dist : -1;
  return hit.distance >= reach - 0.4 ? dist : -1;
}

/** Team tint for the character materials (enemies red, allies blue). */
const TEAM_TINT: Record<Team, string> = { blue: "#2f8cff", red: "#ff2a2a" };
const TEAMMATES: Record<Team, readonly string[]> = { blue: [LOCAL_ID, "ally1", "ally2"], red: RED_IDS };
/** Clearance a bot keeps between its line of fire and any teammate (m). Blue
 *  is extra careful: the player must never see an ally shoot toward them. */
const FRIENDLY_CLEAR_M: Record<Team, number> = { blue: 1.8, red: 0.7 };

/** True if a living teammate of `selfId` stands in/near the segment
 *  from (fx,fz) toward (tx,tz) (2D, extended 2 m past the target). */
function friendlyInLine(selfId: string, team: Team, fx: number, fz: number, tx: number, tz: number): boolean {
  const ents = useGame.getState().entities;
  const dx = tx - fx, dz = tz - fz;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return false;
  const ux = dx / len, uz = dz / len;
  for (const mid of TEAMMATES[team]) {
    if (mid === selfId || !ents[mid]?.alive) continue;
    const mt = transforms[mid];
    if (!mt) continue;
    const px = mt.pos[0] - fx, pz = mt.pos[2] - fz;
    const along = px * ux + pz * uz;
    if (along < -0.5 || along > len + 2) continue;
    const perp = Math.abs(px * uz - pz * ux);
    if (perp < FRIENDLY_CLEAR_M[team]) return true;
  }
  return false;
}

/** Debug counters (window.__mosh can read them via the module). */
export const botFireStats = { shots: 0, hits: 0, heldFriendly: 0, heldNoLos: 0 };
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __botFire: typeof botFireStats }).__botFire = botFireStats;

/** Spawn + render the 5 bots. */
export function TeamBots() {
  useEffect(() => {
    const game = useGame.getState();
    for (const id of BOT_IDS) {
      const team = TEAM_OF[id];
      const [x, z] = BOT_SPAWNS[id];
      const fy = floorYAt(x, z) ?? FLOOR_Y;
      game.upsert(makeEntity(id, team, BOT_URL[team], true), [x, fy + CENTER_OFFSET, z], team === "red" ? Math.PI : 0);
    }
    return () => {
      const g = useGame.getState();
      for (const id of BOT_IDS) g.remove(id);
    };
  }, []);
  return (
    <>
      {BOT_IDS.map((id) => (
        <BotActor key={id} id={id} team={TEAM_OF[id]} />
      ))}
    </>
  );
}

interface BotRuntime {
  version: number;
  wp: number;
  targetId: string | null;
  visible: boolean;
  dist: number;
  seenFor: number;
  nextShot: number;
  think: number;
  strafeT: number;
  floorY: number;
  firing: number;
  /** Retreat/cover spot (XZ) once engaged with retreat style; holdUntil in s. */
  coverX: number;
  coverZ: number;
  hasCover: boolean;
  holdFor: number;
  lastSeenX: number;
  lastSeenZ: number;
  lastSeenFor: number; // s remaining to keep facing the last known position
  lastHealth: number;
}

function BotActor({ id, team }: { id: string; team: Team }) {
  const groupRef = useRef<Group>(null);
  const ringRef = useRef<Mesh>(null);
  const chevRef = useRef<Mesh>(null);
  const labelRef = useRef<Group>(null);
  const [animState, setAnimState] = useState<AnimState>("idle");
  const animRef = useRef<AnimState>("idle");
  const st = useRef<BotRuntime>({
    version: -1,
    wp: 0,
    targetId: null,
    visible: false,
    dist: 0,
    seenFor: 0,
    nextShot: 0,
    think: Math.random() / BOT_COMBAT.thinkHz,
    strafeT: Math.random() * 6,
    floorY: FLOOR_Y,
    firing: 0,
    coverX: 0,
    coverZ: 0,
    hasCover: false,
    holdFor: 0,
    lastSeenX: 0,
    lastSeenZ: 0,
    lastSeenFor: 0,
    lastHealth: 100,
  });
  const coverOut = useRef<Vec3>([0, 0, 0]);
  const idleYaw = team === "red" ? Math.PI : 0;
  const opponents: readonly string[] = team === "red" ? BLUE_IDS : RED_IDS;

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const group = groupRef.current;
    const t = transforms[id];
    const ents = useGame.getState().entities;
    const e = ents[id];
    const plan = botPlans[id];
    if (!group || !t || !e || !plan) return;
    const s = st.current;

    // ── New round: snap to spawn, reset runtime ─────────────────────────
    if (s.version !== plan.version) {
      s.version = plan.version;
      s.wp = 0;
      s.targetId = null;
      s.visible = false;
      s.seenFor = 0;
      s.nextShot = 0.3 + Math.random() * 0.4;
      s.hasCover = false;
      s.holdFor = 0;
      s.lastSeenFor = 0;
      s.firing = 0;
      s.lastHealth = e.health;
      const [x, z] = plan.spawn;
      s.floorY = floorYAt(x, z) ?? FLOOR_Y;
      t.pos[0] = x;
      t.pos[1] = s.floorY + CENTER_OFFSET;
      t.pos[2] = z;
      t.yaw = idleYaw;
      t.forwardSpeed = 0;
      t.lateralSpeed = 0;
    }

    const phase = useMatch.getState().phase;
    const locked = isPlaying(); // pointer-locked OR phone controller playing
    const active = e.alive && phase === "live" && locked;
    let vx = 0;
    let vz = 0;
    let wantYaw = t.yaw;

    if (active) {
      // ── Think: target selection + floor refresh (throttled) ───────────
      s.think -= dt;
      if (s.think <= 0) {
        s.think += 1 / BOT_COMBAT.thinkHz;
        let best: string | null = null;
        let bestScore = Infinity;
        let bestDist = 0;
        let curVisibleDist = -1;
        for (let i = 0; i < opponents.length; i++) {
          const oid = opponents[i];
          const oe = ents[oid];
          if (!oe || !oe.alive) continue;
          const d = lineOfSight(t.pos[0], t.pos[1], t.pos[2], oid);
          if (d < 0) continue;
          if (oid === s.targetId) curVisibleDist = d;
          let score = d;
          if (plan.target === "player_first" && oid === LOCAL_ID) score -= 1000;
          else if (plan.target === "weakest") score = oe.health * 10 + d;
          if (score < bestScore) {
            bestScore = score;
            best = oid;
            bestDist = d;
          }
        }
        // Sticky: keep the current target while it stays visible unless the
        // preference strongly favours another (avoids flicking).
        if (curVisibleDist >= 0 && best !== s.targetId && plan.target === "nearest" && curVisibleDist < bestDist + 4) {
          best = s.targetId;
          bestDist = curVisibleDist;
        }
        if (best !== s.targetId) {
          s.targetId = best;
          s.seenFor = 0;
        }
        s.visible = best !== null;
        s.dist = bestDist;
        const fy = floorYAt(t.pos[0], t.pos[2]);
        if (fy != null) s.floorY = fy;
      }

      // Got hit by someone we can't see → glance toward the attacker side.
      if (e.health < s.lastHealth && !s.visible) {
        s.lastSeenFor = 1.5;
        s.lastSeenX = t.pos[0];
        s.lastSeenZ = t.pos[2] + (team === "red" ? 8 : -8);
      }
      s.lastHealth = e.health;

      const tt = s.targetId ? transforms[s.targetId] : undefined;
      const engaged = s.visible && !!tt;

      // ── Movement goal ──────────────────────────────────────────────────
      let gx = NaN, gz = NaN, speed = BOT_COMBAT.walkSpeed;
      const lowHp = e.health < (team === "blue" ? 45 : 60);
      if (engaged && (plan.style === "retreat_to_cover" || lowHp) && !s.hasCover) {
        if (nearestCoverSpot(team, t.pos[0], t.pos[2], coverOut.current)) {
          s.hasCover = true;
          s.coverX = coverOut.current[0];
          s.coverZ = coverOut.current[2];
          s.holdFor = 4;
        }
      }
      if (s.hasCover) {
        gx = s.coverX;
        gz = s.coverZ;
        speed = BOT_COMBAT.walkSpeed * 1.25;
        s.holdFor -= engaged ? 0 : dt;
        if (s.holdFor <= 0 && !lowHp) s.hasCover = false; // peek back out
      } else if (engaged && s.wp < plan.route.length) {
        // Still on the way to our post: keep advancing while shooting.
        gx = plan.route[s.wp][0];
        gz = plan.route[s.wp][1];
        speed = BOT_COMBAT.walkSpeed * 0.75;
      } else if (engaged && plan.style !== "strafe_and_shoot") {
        // stand_and_shoot (or retreat style already in cover): hold position.
      } else if (engaged) {
        // strafe_and_shoot: oscillate sideways relative to our facing.
        s.strafeT += dt;
        const k = Math.cos(s.strafeT * 1.7) * BOT_COMBAT.strafeSpeed;
        vx = Math.cos(t.yaw) * k;
        vz = -Math.sin(t.yaw) * k;
      } else if (s.wp < plan.route.length) {
        gx = plan.route[s.wp][0];
        gz = plan.route[s.wp][1];
      }
      if (gx === gx) {
        const dx = gx - t.pos[0], dz = gz - t.pos[2];
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < 0.3) {
          if (!s.hasCover && s.wp < plan.route.length) s.wp++;
        } else {
          const v = Math.min(speed, d / Math.max(dt, 1e-3));
          vx = (dx / d) * v;
          vz = (dz / d) * v;
        }
      }

      // Don't walk off the plaza: probe the floor a step ahead (rare cost —
      // only when moving, and only every think tick via the cached floorY).
      t.pos[0] += vx * dt;
      t.pos[2] += vz * dt;

      // ── Facing ─────────────────────────────────────────────────────────
      if (engaged && tt) {
        wantYaw = Math.atan2(-(tt.pos[0] - t.pos[0]), -(tt.pos[2] - t.pos[2]));
        s.lastSeenX = tt.pos[0];
        s.lastSeenZ = tt.pos[2];
        s.lastSeenFor = 2.5;
      } else if (s.lastSeenFor > 0) {
        s.lastSeenFor -= dt;
        wantYaw = Math.atan2(-(s.lastSeenX - t.pos[0]), -(s.lastSeenZ - t.pos[2]));
      } else if (vx * vx + vz * vz > 0.25) {
        wantYaw = Math.atan2(-vx, -vz);
      } else {
        wantYaw = idleYaw;
      }

      // ── Shoot ──────────────────────────────────────────────────────────
      if (engaged && tt && s.targetId) {
        s.seenFor += dt;
        s.nextShot -= dt;
        let yawErr = wantYaw - t.yaw;
        yawErr = Math.atan2(Math.sin(yawErr), Math.cos(yawErr));
        if (s.seenFor >= plan.reactionSec && s.nextShot <= 0 && Math.abs(yawErr) < 0.35) {
          const [lo, hi] = BOT_COMBAT.fireIntervalSec;
          // FRESH line of sight at the moment of the shot (the think tick's
          // result can be up to 1/thinkHz stale): no shooting through walls,
          // cover or bodies, ever.
          const losD = lineOfSight(t.pos[0], t.pos[1], t.pos[2], s.targetId);
          if (losD < 0) {
            s.visible = false;
            s.nextShot = 0.15;
            botFireStats.heldNoLos++;
          } else if (friendlyInLine(id, team, t.pos[0], t.pos[2], tt.pos[0], tt.pos[2])) {
            // A teammate (or the player) is in the line of fire: hold.
            s.nextShot = 0.25;
            botFireStats.heldFriendly++;
          } else {
            s.dist = losD;
            s.nextShot = lo + Math.random() * (hi - lo);
            s.firing = 0.18;
            botFireStats.shots++;
            const targetMoving = Math.hypot(tt.forwardSpeed, tt.lateralSpeed) > 0.5;
            const selfMoving = vx * vx + vz * vz > 0.25;
            const acc = Math.min(
              0.92,
              plan.accuracy *
              (s.targetId === LOCAL_ID ? BOT_COMBAT.vsPlayerAccuracyMul : 1) *
              Math.max(0, 1 - s.dist / BOT_COMBAT.accuracyFalloffM) *
              (targetMoving ? BOT_COMBAT.movingPenalty : 1) *
              (selfMoving ? BOT_COMBAT.selfMovingPenalty : 1),
            );
            const hit = Math.random() < acc;
            const from: Vec3 = [t.pos[0] - Math.sin(t.yaw) * 0.4, t.pos[1] + EYE - 0.1, t.pos[2] - Math.cos(t.yaw) * 0.4];
            const to: Vec3 = [tt.pos[0], tt.pos[1] + 0.3 - 0.35 * tt.crouchAmount, tt.pos[2]];
            if (!hit) {
              // A visible MISS: deflect sideways/up past the target and let the
              // world stop the tracer where it would really land.
              const side = Math.random() < 0.5 ? -1 : 1;
              const ux = (to[0] - from[0]) / s.dist, uz = (to[2] - from[2]) / s.dist;
              const off = 0.7 + Math.random() * 0.8;
              to[0] += -uz * side * off;
              to[2] += ux * side * off;
              to[1] += (Math.random() - 0.3) * 0.9;
              const ddx = to[0] - from[0], ddy = to[1] - from[1], ddz = to[2] - from[2];
              const dl = Math.hypot(ddx, ddy, ddz);
              const dir: Vec3 = [ddx / dl, ddy / dl, ddz / dl];
              const reach = dl + 8;
              const h = raycastShot(from, dir, reach);
              const end = h ? h.distance : reach;
              to[0] = from[0] + dir[0] * end;
              to[1] = from[1] + dir[1] * end;
              to[2] = from[2] + dir[2] * end;
            }
            vfx.muzzle(from);
            vfx.tracer(from, to, TRACER_COLOR[team]);
            const lp = transforms[LOCAL_ID]?.pos;
            const ld = lp ? Math.hypot(lp[0] - t.pos[0], lp[2] - t.pos[2]) : 30;
            const vol = Math.max(0.08, 1 - ld / 40) * 0.7;
            playSfx("shot", vol);
            if (hit) {
              botFireStats.hits++;
              const inv = 1 / Math.max(s.dist, 0.01);
              combat.applyDamage({
                targetId: s.targetId,
                amount: s.targetId === LOCAL_ID ? plan.damage : Math.round(plan.damage * BOT_COMBAT.vsBotDamageMul),
                fromDir: [(to[0] - from[0]) * inv, (to[1] - from[1]) * inv, (to[2] - from[2]) * inv],
                byId: id,
              });
            }
          }
        }
      } else {
        s.seenFor = 0;
      }
    } else if (e.alive && phase !== "live") {
      wantYaw = idleYaw;
    }

    // Smooth turn.
    let dYaw = wantYaw - t.yaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    t.yaw += Math.sign(dYaw) * Math.min(Math.abs(dYaw), BOT_COMBAT.turnRate * dt);

    // Local-space speeds for the anim arbiter (yaw=0 faces -Z).
    const sy = Math.sin(t.yaw), cy = Math.cos(t.yaw);
    t.forwardSpeed = e.alive ? vx * -sy + vz * -cy : 0;
    t.lateralSpeed = e.alive ? vx * cy + vz * -sy : 0;

    // Ease onto the floor height.
    const wantY = s.floorY + CENTER_OFFSET;
    t.pos[1] += (wantY - t.pos[1]) * Math.min(1, dt * 10);

    group.position.set(t.pos[0], t.pos[1] - CENTER_OFFSET, t.pos[2]);
    group.rotation.y = t.yaw;
    if (ringRef.current) ringRef.current.visible = e.alive;
    if (chevRef.current) chevRef.current.visible = e.alive;
    if (labelRef.current) labelRef.current.visible = e.alive && !introCameraActive();

    // Footsteps.
    const speed = Math.hypot(t.forwardSpeed, t.lateralSpeed);
    const lp = transforms[LOCAL_ID]?.pos;
    let walkGain = 0;
    if (e.alive && speed > 0.5 && lp) {
      const dx = t.pos[0] - lp[0], dz = t.pos[2] - lp[2];
      walkGain = Math.max(0, 1 - Math.sqrt(dx * dx + dz * dz) / BOT_WALK_MAX_DIST);
    }
    setEntityWalk(id, walkGain > 0.001, walkGain);

    // Anim: brief "fire" pose when shooting while standing still.
    if (s.firing > 0) s.firing -= dt;
    let next = resolveAnimState(e, t);
    if (e.alive && s.firing > 0 && speed < 0.3) next = "fire";
    if (next !== animRef.current) {
      animRef.current = next;
      setAnimState(next);
    }
  });

  useEffect(() => () => setEntityWalk(id, false, 0), [id]);

  return (
    <group ref={groupRef}>
      <AnimatedCharacter url={BOT_URL[team]} tint={TEAM_TINT[team]} height={1.8} animState={animState} hold={<Gun length={0.22} variant="normal" />} />
      <mesh ref={ringRef} geometry={ringGeo} material={MARK[team].ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]} renderOrder={2} />
      <mesh
        ref={chevRef}
        geometry={chevronGeo}
        material={MARK[team].chev}
        rotation={[Math.PI, 0, 0]}
        position={[0, 2.12, 0]}
        renderOrder={team === "blue" ? 998 : 0}
      />
      {team === "blue" ? (
        // Hidden during the intro overview (IntroCamera draws the big name tag).
        <Billboard ref={labelRef} position={[0, 2.42, 0]}>
          <Text fontSize={0.2} color="#9fd0ff" outlineWidth={0.015} outlineColor="#001a33" anchorX="center" anchorY="middle" renderOrder={999} material-depthTest={false}>
            {displayName(id, useGame.getState().entities)}
          </Text>
        </Billboard>
      ) : null}
    </group>
  );
}
