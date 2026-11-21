// Pure-TypeScript Fixed-Timestep Tennis Ball Physics & Launch Solver (`contact-v1` calibrated)
// Ported from Tennis-Ball-Trajectory-Complete (`ContactFlight.ts`, `CourtImpact.ts`, `TennisShotResolver.ts`, `rallyDepth.ts`).
// ZERO DOM / React / Three.js imports — identical deterministic 60 Hz physics in Browser & Node.

import { COURT, type AiShotType, type HumanShotType } from '@shared/contracts';

export type AnyShotType = AiShotType | HumanShotType;

export const PHYSICS = {
  DT: 1 / 60,
  GRAVITY: 9.81,
  AIR_DENSITY: 1.21,
  BALL_MASS: 0.0577,
  BALL_RADIUS: COURT.BALL_RADIUS, // 0.0335m physical ITF ball radius
  COURT_Y: COURT.BALL_RADIUS, // 0.0335m physical center at court impact
  CD_BASE: 0.507, // Cross & Lindsey free-flight mean Cd
  CL_SLOPE: 0.6, // CL = 0.60 * S
  CL_CAP: 0.36, // Bounded lift cap
  SPIN_DECAY_RATE: 0.07,
  RESTITUTION: 0.8, // ITF medium hard court normal COR
  FRICTION: 0.64, // ITF medium hard court Coulomb friction
  INERTIA_K: 0.55, // Cross (2002) measured felt-ball I / (m R^2)
  NET_CLEAR_Y: 1.04, // Physical tape collision threshold (1.07m net w/ center strap)
  MIN_SOLVER_NET_Y: 1.15, // Solver target net clearance (skims cleanly 8-40cm over tape)
} as const;

const RPM_TO_RAD_S = Math.PI / 30;
const AREA_MASS =
  (0.5 * PHYSICS.AIR_DENSITY * Math.PI * PHYSICS.BALL_RADIUS * PHYSICS.BALL_RADIUS) /
  PHYSICS.BALL_MASS;

/**
 * Webcam human-receiver post-bounce horizontal retention (applied ONLY on human +Z half,
 * `bz > 0`, so AI shots arrive slowly & readably after bouncing without floating high pre-bounce,
 * while human shots toward -Z keep full fast ATP court speed!).
 */
const HUMAN_SIDE_BOUNCE_RETENTION: Record<AnyShotType, number> = {
  flat: 0.36,
  topspin: 0.38,
  slice: 0.52,
  dropshot: 0.38,
  lob: 0.42,
  volley: 0.42,
};

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BallState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Spin vector in rad/s */
  wx: number;
  wy: number;
  wz: number;
  active: boolean;
  bounceCount: number;
  shotType: AnyShotType;
  firstBouncePoint: { x: number; z: number } | null;
  lastBouncePoint: { x: number; z: number } | null;
  hitNet: boolean;
  flightTime: number;
}

export interface StepResult {
  bounced: boolean;
  bouncePoint: { x: number; z: number } | null;
  hitNet: boolean;
  crossedNet: boolean;
}

export interface LaunchSolution {
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  landingPoint: { x: number; z: number };
  flightTime: number;
  apex: number;
  netY: number | null;
  clearedNet: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function isInsidePaintedCourt(x: number, z: number): boolean {
  return (
    Math.abs(x) <= COURT.PAINTED_HALF_W + COURT.LINE_TOLERANCE &&
    Math.abs(z) <= COURT.BASELINE_Z + COURT.LINE_TOLERANCE
  );
}

/**
 * Computes world-space spin vector (rad/s) for a ball traveling horizontally along (dx, dz).
 * Positive rpm = topspin (Magnus dips downward); negative rpm = backspin/slice (floats/skids low).
 */
export function computeSpinVector(dx: number, dz: number, rpm: number): Vec3 {
  const horiz = Math.hypot(dx, dz) || 1;
  const nx = dx / horiz;
  const nz = dz / horiz;
  const omega = rpm * RPM_TO_RAD_S;
  return {
    x: nz * omega,
    y: 0,
    z: -nx * omega,
  };
}

function computeAccel(vx: number, vy: number, vz: number, wx: number, wy: number, wz: number): Vec3 {
  const speed = Math.hypot(vx, vy, vz);
  if (speed < 1e-4) {
    return { x: 0, y: -PHYSICS.GRAVITY, z: 0 };
  }

  const drag = AREA_MASS * PHYSICS.CD_BASE * speed;
  let ax = -drag * vx;
  let ay = -PHYSICS.GRAVITY - drag * vy;
  let az = -drag * vz;

  // Magnus lift: ω × v (bounded linear CL = 0.60 * S capped at 0.36)
  const mx = wy * vz - wz * vy;
  const my = wz * vx - wx * vz;
  const mz = wx * vy - wy * vx;
  const cross = Math.hypot(mx, my, mz);

  if (cross > 1e-6) {
    const magnus =
      AREA_MASS *
      Math.min(
        PHYSICS.CL_SLOPE * PHYSICS.BALL_RADIUS,
        (PHYSICS.CL_CAP * speed * speed) / cross,
      );
    ax += magnus * mx;
    ay += magnus * my;
    az += magnus * mz;
  }

  return { x: ax, y: ay, z: az };
}

function advanceMidpoint(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  wx: number,
  wy: number,
  wz: number,
  dt: number,
) {
  const a0 = computeAccel(vx, vy, vz, wx, wy, wz);
  const halfDt = dt * 0.5;
  const midVx = vx + a0.x * halfDt;
  const midVy = vy + a0.y * halfDt;
  const midVz = vz + a0.z * halfDt;
  const halfDecay = Math.exp(-PHYSICS.SPIN_DECAY_RATE * halfDt);
  const aMid = computeAccel(midVx, midVy, midVz, wx * halfDecay, wy * halfDecay, wz * halfDecay);
  const fullDecay = Math.exp(-PHYSICS.SPIN_DECAY_RATE * dt);

  return {
    x: x + midVx * dt,
    y: y + midVy * dt,
    z: z + midVz * dt,
    vx: vx + aMid.x * dt,
    vy: vy + aMid.y * dt,
    vz: vz + aMid.z * dt,
    wx: wx * fullDecay,
    wy: wy * fullDecay,
    wz: wz * fullDecay,
  };
}

export class BallFlightEngine {
  state: BallState = this.createIdleState();

  createIdleState(): BallState {
    return {
      x: 0,
      y: 1.0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      wx: 0,
      wy: 0,
      wz: 0,
      active: false,
      bounceCount: 0,
      shotType: 'topspin',
      firstBouncePoint: null,
      lastBouncePoint: null,
      hitNet: false,
      flightTime: 0,
    };
  }

  reset(pos: Vec3 = { x: 0, y: 1.0, z: 0 }) {
    this.state = {
      ...this.createIdleState(),
      x: pos.x,
      y: pos.y,
      z: pos.z,
    };
  }

  launch(from: Vec3, vel: Vec3, spin: Vec3, shotType: AnyShotType) {
    this.state = {
      x: from.x,
      y: from.y,
      z: from.z,
      vx: vel.x,
      vy: vel.y,
      vz: vel.z,
      wx: spin.x,
      wy: spin.y,
      wz: spin.z,
      active: true,
      bounceCount: 0,
      shotType,
      firstBouncePoint: null,
      lastBouncePoint: null,
      hitNet: false,
      flightTime: 0,
    };
  }

  /** Advance one fixed 1/60s tick using `contact-v1` midpoint integration + bisection TOI impact. */
  stepFixed(dt = PHYSICS.DT): StepResult {
    const s = this.state;
    if (!s.active) {
      return { bounced: false, bouncePoint: null, hitNet: false, crossedNet: false };
    }

    const prevX = s.x;
    const prevY = s.y;
    const prevZ = s.z;

    const end = advanceMidpoint(s.x, s.y, s.z, s.vx, s.vy, s.vz, s.wx, s.wy, s.wz, dt);

    let bounced = false;
    let bouncePoint: { x: number; z: number } | null = null;

    if (end.y < PHYSICS.COURT_Y && s.vy <= 0) {
      // 12-step bisection on midpoint path for sub-millisecond time-of-impact
      let lo = 0;
      let hi = dt;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) * 0.5;
        const probe = advanceMidpoint(prevX, prevY, prevZ, s.vx, s.vy, s.vz, s.wx, s.wy, s.wz, mid);
        if (probe.y > PHYSICS.COURT_Y) lo = mid;
        else hi = mid;
      }
      const at = (lo + hi) * 0.5;
      const impact = advanceMidpoint(prevX, prevY, prevZ, s.vx, s.vy, s.vz, s.wx, s.wy, s.wz, at);
      s.x = impact.x;
      s.y = PHYSICS.COURT_Y;
      s.z = impact.z;
      s.vx = impact.vx;
      s.vy = impact.vy;
      s.vz = impact.vz;
      s.wx = impact.wx;
      s.wy = impact.wy;
      s.wz = impact.wz;

      this.applyImpulseBounce(s);
      s.bounceCount += 1;
      bounced = true;
      bouncePoint = { x: s.x, z: s.z };
      s.lastBouncePoint = bouncePoint;
      if (!s.firstBouncePoint) {
        s.firstBouncePoint = bouncePoint;
      }

      // Asymmetric accessibility bounce:
      // - On human +Z side (bz > 0, AI's shot arriving to us): gently cushion post-bounce pace
      //   so the ball comes cleanly into the human's swing zone (~5.2-6.5 m/s) while guaranteeing
      //   ordinary serves/groundstrokes NEVER double-bounce before reaching z = 11.8m!
      // - On AI -Z side (bz < 0, human's shot arriving to AI): keep 100% fast physical speed!
      if (s.bounceCount === 1 && s.z > 0 && s.vz > 0) {
        const ret = HUMAN_SIDE_BOUNCE_RETENTION[s.shotType] ?? 0.42;
        s.vx *= ret;
        s.vz *= ret;
        if (s.shotType === 'slice') {
          s.vy = clamp(s.vy * 0.9, 3.4, 4.1);
        } else if (s.shotType === 'dropshot') {
          s.vy = clamp(s.vy * 0.92, 3.0, 3.8);
        } else {
          s.vy = clamp(s.vy * 1.06, 4.2, 5.0);
        }

        // Guarantee non-dropshot AI shots reach past the baseline (z >= 12.2m) before 2nd bounce
        if (s.shotType !== 'dropshot') {
          const airtime = Math.max(0.65, (2 * s.vy) / PHYSICS.GRAVITY);
          const minCarryVz = Math.max(0, 12.2 - s.z) / airtime;
          if (s.vz < minCarryVz) {
            const boost = minCarryVz / Math.max(0.5, s.vz);
            s.vz = minCarryVz;
            s.vx *= Math.min(1.3, boost);
          }
        }
      }

      const remDt = dt - at;
      if (remDt > 1e-6) {
        const after = advanceMidpoint(s.x, s.y, s.z, s.vx, s.vy, s.vz, s.wx, s.wy, s.wz, remDt);
        s.x = after.x;
        s.y = Math.max(PHYSICS.COURT_Y, after.y);
        s.z = after.z;
        s.vx = after.vx;
        s.vy = after.vy;
        s.vz = after.vz;
        s.wx = after.wx;
        s.wy = after.wy;
        s.wz = after.wz;
      }

      if (s.bounceCount >= 4 && Math.abs(s.vy) < 0.6) {
        s.active = false;
      }
    } else {
      s.x = end.x;
      s.y = end.y;
      s.z = end.z;
      s.vx = end.vx;
      s.vy = end.vy;
      s.vz = end.vz;
      s.wx = end.wx;
      s.wy = end.wy;
      s.wz = end.wz;
    }

    s.flightTime += dt;

    // Net crossing & collision check at z = 0
    let hitNet = false;
    let crossedNet = false;
    if (prevZ * s.z <= 0 && prevZ !== s.z && Math.abs(prevZ - s.z) < 5) {
      const frac = Math.abs(prevZ) / (Math.abs(prevZ) + Math.abs(s.z));
      const yAtNet = prevY + (s.y - prevY) * frac;
      const xAtNet = prevX + (s.x - prevX) * frac;
      if (Math.abs(xAtNet) <= COURT.NET_POST_X) {
        if (yAtNet < PHYSICS.NET_CLEAR_Y) {
          hitNet = true;
          s.hitNet = true;
          s.x = xAtNet;
          s.y = Math.max(PHYSICS.COURT_Y, yAtNet);
          s.z = prevZ > 0 ? 0.08 : -0.08;
          s.vx *= 0.25;
          s.vz *= -0.18;
          s.vy = Math.min(s.vy, -0.5);
        } else {
          crossedNet = true;
        }
      }
    }

    return { bounced, bouncePoint, hitNet, crossedNet };
  }

  /** Passive Coulomb grip-slip court impact (`CourtImpact.ts`). */
  private applyImpulseBounce(s: BallState) {
    const r = PHYSICS.BALL_RADIUS;
    const k = PHYSICS.INERTIA_K;
    const jn = -(1 + PHYSICS.RESTITUTION) * s.vy;
    const slipX = s.vx + r * s.wz;
    const slipZ = s.vz - r * s.wx;
    const slip = Math.hypot(slipX, slipZ);

    if (slip > 1e-5) {
      const jStop = slip / (1 + 1 / k);
      const jMax = PHYSICS.FRICTION * jn;
      const j = Math.min(jStop, jMax);
      const jx = (-j * slipX) / slip;
      const jz = (-j * slipZ) / slip;
      s.vx += jx;
      s.vz += jz;
      s.wx -= jz / (k * r);
      s.wz += jx / (k * r);
    }

    s.vy = -s.vy * PHYSICS.RESTITUTION;
  }
}

/**
 * Forward velocity (`|vz|`, m/s) envelopes:
 * - HUMAN -> AI (`actor === 'human'`): Fast real club/ATP pace (`19–27 m/s`, low 1.5–2.3m arcs!)
 *   so player shots zip crisply across the court and showcase AI anticipation & adaptation.
 * - AI -> HUMAN (`actor === 'ai'`): Readable moderate pace (`15.2–17.2 m/s`, still low 1.6–2.4m arcs
 *   because AI targets `z = 5.2..7.8m`), then cushioned on first bounce for comfortable human swings!
 */
const PLAYER_FORWARD_SPEED_MPS: Record<AnyShotType, number> = {
  flat: 25.5,
  topspin: 23.8,
  slice: 20.5,
  dropshot: 13.5,
  lob: 13.2,
  volley: 21.5,
};

const AI_FORWARD_SPEED_MPS: Record<AnyShotType, number> = {
  flat: 20.2,
  topspin: 18.8,
  slice: 17.8,
  dropshot: 12.6,
  lob: 12.4,
  volley: 16.8,
};

const SHOT_DEFAULT_RPM: Record<AnyShotType, number> = {
  flat: 650,
  topspin: 1850,
  slice: -2200,
  dropshot: -1350,
  lob: 1250,
  volley: -300,
};

function simulateToFirstBounce(
  from: Vec3,
  vel: Vec3,
  spin: Vec3,
  shotType: AnyShotType,
): {
  landX: number;
  landZ: number;
  flightTime: number;
  apex: number;
  netY: number | null;
  clearedNet: boolean;
  hitNet: boolean;
} {
  const sim = new BallFlightEngine();
  sim.launch(from, vel, spin, shotType);
  let clearedNet = false;
  let hitNet = false;
  let apex = from.y;
  let netY: number | null = null;

  for (let i = 0; i < 300; i++) {
    const prevY = sim.state.y;
    const prevZ = sim.state.z;
    const res = sim.stepFixed(PHYSICS.DT);
    if (!res.bounced) {
      apex = Math.max(apex, sim.state.y);
    }
    if (netY === null && prevZ * sim.state.z <= 0 && prevZ !== sim.state.z) {
      netY = prevY + ((sim.state.y - prevY) * Math.abs(prevZ)) / (Math.abs(prevZ) + Math.abs(sim.state.z));
    }
    if (res.crossedNet) clearedNet = true;
    if (res.hitNet) {
      hitNet = true;
      break;
    }
    if (res.bounced && res.bouncePoint) {
      return {
        landX: res.bouncePoint.x,
        landZ: res.bouncePoint.z,
        flightTime: sim.state.flightTime,
        apex,
        netY,
        clearedNet,
        hitNet,
      };
    }
  }

  return {
    landX: sim.state.x,
    landZ: sim.state.z,
    flightTime: sim.state.flightTime,
    apex,
    netY,
    clearedNet,
    hitNet,
  };
}

function solveGivenForwardSpeed(
  from: Vec3,
  target: { x: number; z: number },
  forwardSpeed: number,
  spin: Vec3,
  shotType: AnyShotType,
) {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dirSignZ = dz >= 0 ? 1 : -1;
  const vz = dirSignZ * forwardSpeed;
  const estFlight = Math.max(0.25, Math.abs(dz) / forwardSpeed);
  let vx = clamp(dx / estFlight, -16, 16);

  // 1. Solve vy by bisection for exact landing depth
  let vyLo = -6.0;
  let vyHi = shotType === 'lob' ? 15.5 : 11.0;
  let vy = 2.0;
  for (let iter = 0; iter < 20; iter++) {
    vy = (vyLo + vyHi) * 0.5;
    const res = simulateToFirstBounce(from, { x: vx, y: vy, z: vz }, spin, shotType);
    const alongErr = (res.landZ - target.z) * dirSignZ;
    if (res.hitNet || alongErr < 0) vyLo = vy;
    else vyHi = vy;
  }

  // 2. Solve vx by bisection for exact lateral landing
  let vxLo = vx - 8;
  let vxHi = vx + 8;
  for (let iter = 0; iter < 14; iter++) {
    vx = (vxLo + vxHi) * 0.5;
    const res = simulateToFirstBounce(from, { x: vx, y: vy, z: vz }, spin, shotType);
    if (res.landX < target.x) vxLo = vx;
    else vxHi = vx;
  }

  // 3. Quick 6-step polish on vy after lateral adjustment
  vyLo = vy - 1.2;
  vyHi = vy + 1.2;
  for (let iter = 0; iter < 6; iter++) {
    vy = (vyLo + vyHi) * 0.5;
    const res = simulateToFirstBounce(from, { x: vx, y: vy, z: vz }, spin, shotType);
    const alongErr = (res.landZ - target.z) * dirSignZ;
    if (res.hitNet || alongErr < 0) vyLo = vy;
    else vyHi = vy;
  }

  const finalRes = simulateToFirstBounce(from, { x: vx, y: vy, z: vz }, spin, shotType);
  return { vx, vy, vz, finalRes };
}

/**
 * Physical launch solver (`TennisShotResolver.ts` + `solvePhysicalLaunchToLanding` style):
 * - Touch shots (`dropshot`, `lob`) bisect forward speed to hit an exact target apex
 *   (`1.70m` low touch arc for dropshots; `5.6m` high clearance ONLY for lobs).
 * - Groundstrokes & serves solve at crisp forward speeds ensuring `netY >= 1.15m` and low
 *   broadcast arcs (`1.45m–2.45m` apex — never floaty moonballs!).
 */
export function solveShotLaunch(
  from: Vec3,
  target: { x: number; z: number },
  shotType: AnyShotType,
  opts?: {
    actor?: 'human' | 'ai';
    isServe?: boolean;
    speedScale?: number;
    rpmOverride?: number;
    allowNetError?: boolean;
  },
): LaunchSolution {
  const actor = opts?.actor ?? (from.z >= 0 ? 'human' : 'ai');
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const defaultRpm = opts?.isServe
    ? shotType === 'slice'
      ? -1200
      : shotType === 'flat'
        ? 600
        : 1050
    : (SHOT_DEFAULT_RPM[shotType] ?? 1200);
  const rpm = opts?.rpmOverride ?? defaultRpm;
  const spin = computeSpinVector(dx, dz, rpm);

  // Touch shots (`dropshot`, `lob`): bisect forwardSpeed to achieve authored apex (`TennisShotResolver.ts`)
  if ((shotType === 'dropshot' || shotType === 'lob') && !opts?.allowNetError) {
    const desiredApex =
      shotType === 'lob'
        ? Math.max(from.y + 2.0, 5.5)
        : Math.max(from.y + 0.16, actor === 'ai' ? 1.78 : 1.65);
    let spdLo = 5.5;
    let spdHi = shotType === 'lob' ? 18.5 : 22.0;
    let best: LaunchSolution | null = null;
    let bestApexErr = Infinity;

    for (let i = 0; i < 11; i++) {
      const midSpd = (spdLo + spdHi) * 0.5;
      const cand = solveGivenForwardSpeed(from, target, midSpd, spin, shotType);
      const { finalRes } = cand;
      const distErr = Math.hypot(finalRes.landX - target.x, finalRes.landZ - target.z);
      const netOk = finalRes.netY !== null && finalRes.netY >= PHYSICS.MIN_SOLVER_NET_Y;
      const apexErr = Math.abs(finalRes.apex - desiredApex);

      if (!finalRes.hitNet && netOk && distErr < 0.35 && apexErr < bestApexErr) {
        bestApexErr = apexErr;
        best = {
          vx: cand.vx,
          vy: cand.vy,
          vz: cand.vz,
          wx: spin.x,
          wy: spin.y,
          wz: spin.z,
          landingPoint: { x: finalRes.landX, z: finalRes.landZ },
          flightTime: finalRes.flightTime,
          apex: finalRes.apex,
          netY: finalRes.netY,
          clearedNet: finalRes.clearedNet,
        };
        if (apexErr < 0.04) break;
      }

      // More forward speed = less airtime = lower apex
      if (finalRes.netY !== null && finalRes.netY < PHYSICS.MIN_SOLVER_NET_Y + 0.03) {
        spdHi = midSpd;
      } else if (finalRes.apex > desiredApex || distErr > 0.35) {
        spdLo = midSpd;
      } else {
        spdHi = midSpd;
      }
    }
    if (best) return best;
  }

  // Groundstrokes, volleys & serves: fast low-arc trajectories
  const table = actor === 'human' ? PLAYER_FORWARD_SPEED_MPS : AI_FORWARD_SPEED_MPS;
  const baseForward = opts?.isServe
    ? shotType === 'flat'
      ? 19.6
      : shotType === 'slice'
        ? 18.2
        : 18.6
    : (table[shotType] ?? 18.5) * (opts?.speedScale ?? 1.0);

  const factors = opts?.allowNetError ? [1.0] : [1.0, 0.9, 0.8, 0.7, 0.58];
  let bestFallback: LaunchSolution | null = null;
  let bestErr = Infinity;

  for (const f of factors) {
    const fwd = clamp(baseForward * f, 6.5, 29.0);
    const cand = solveGivenForwardSpeed(from, target, fwd, spin, shotType);
    const { finalRes } = cand;
    const distErr = Math.hypot(finalRes.landX - target.x, finalRes.landZ - target.z);
    const netOk =
      opts?.allowNetError ||
      (!finalRes.hitNet && (finalRes.netY === null || finalRes.netY >= PHYSICS.MIN_SOLVER_NET_Y));

    if (distErr < bestErr && (!finalRes.hitNet || opts?.allowNetError)) {
      bestErr = distErr;
      bestFallback = {
        vx: cand.vx,
        vy: cand.vy,
        vz: cand.vz,
        wx: spin.x,
        wy: spin.y,
        wz: spin.z,
        landingPoint: { x: finalRes.landX, z: finalRes.landZ },
        flightTime: finalRes.flightTime,
        apex: finalRes.apex,
        netY: finalRes.netY,
        clearedNet: finalRes.clearedNet,
      };
    }

    if (netOk && distErr <= 0.25) {
      return {
        vx: cand.vx,
        vy: cand.vy,
        vz: cand.vz,
        wx: spin.x,
        wy: spin.y,
        wz: spin.z,
        landingPoint: { x: finalRes.landX, z: finalRes.landZ },
        flightTime: finalRes.flightTime,
        apex: finalRes.apex,
        netY: finalRes.netY,
        clearedNet: finalRes.clearedNet,
      };
    }
  }

  if (bestFallback) return bestFallback;

  const fallback = solveGivenForwardSpeed(from, target, 13.5, spin, shotType);
  return {
    vx: fallback.vx,
    vy: fallback.vy,
    vz: fallback.vz,
    wx: spin.x,
    wy: spin.y,
    wz: spin.z,
    landingPoint: { x: fallback.finalRes.landX, z: fallback.finalRes.landZ },
    flightTime: fallback.finalRes.flightTime,
    apex: fallback.finalRes.apex,
    netY: fallback.finalRes.netY,
    clearedNet: fallback.finalRes.clearedNet,
  };
}
