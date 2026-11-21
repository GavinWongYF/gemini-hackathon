// Pure-TypeScript Fixed-Timestep Tennis Ball Physics & Launch Solver
// Based on tennis-reference/01-ball-physics.md & 05-rally-scoring.md.
// ZERO DOM / React / Three.js imports — identical deterministic physics in Browser & Node.

import { COURT, type AiShotType, type HumanShotType } from '@shared/contracts';

export type AnyShotType = AiShotType | HumanShotType;

export const PHYSICS = {
  DT: 1 / 60,
  GRAVITY: 9.81,
  AIR_DENSITY: 1.21,
  BALL_MASS: 0.0577,
  BALL_RADIUS: COURT.BALL_RADIUS,
  COURT_Y: 0.08, // Ball center height at floor contact (visual ball radius)
  CD_BASE: 0.507,
  CL_SLOPE: 0.6,
  CL_CAP: 0.36,
  SPIN_DECAY_RATE: 0.07,
  RESTITUTION: 0.8,
  FRICTION: 0.64,
  INERTIA_K: 0.55,
  NET_CLEAR_Y: COURT.NET_HEIGHT * 0.95, // 1.0165m net collision height
  GAME_PACE_FACTOR: 0.7,
} as const;

const CROSS_SECTION = Math.PI * PHYSICS.BALL_RADIUS * PHYSICS.BALL_RADIUS;
const AERO_K = (0.5 * PHYSICS.AIR_DENSITY * CROSS_SECTION) / PHYSICS.BALL_MASS;

/** First-bounce horizontal speed retention (keeps post-bounce swing window readable) */
const FIRST_BOUNCE_RETENTION: Record<AnyShotType, number> = {
  flat: 0.38,
  topspin: 0.42,
  slice: 0.66, // slice skids low & fast
  dropshot: 0.3,
  lob: 0.44,
  volley: 0.46,
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
 * Computes spin vector (rad/s) for a ball traveling horizontally along (dx, dz).
 * Positive rpm = topspin (dips downward via Magnus); negative rpm = backspin/slice (floats/skids).
 */
export function computeSpinVector(dx: number, dz: number, rpm: number): Vec3 {
  const horiz = Math.hypot(dx, dz) || 1;
  const nx = dx / horiz;
  const nz = dz / horiz;
  const omega = (rpm * Math.PI) / 30;
  // Spin axis perpendicular to horizontal velocity: (nz, 0, -nx) gives ω × v downward for +rpm
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

  const omegaMag = Math.hypot(wx, wy, wz);
  const rpm = (omegaMag * 30) / Math.PI;
  const spinDragMul = 1 + Math.min(1, rpm / 2750) * 0.06;
  const dragMag = AERO_K * PHYSICS.CD_BASE * spinDragMul * speed;

  let ax = -dragMag * vx;
  let ay = -PHYSICS.GRAVITY - dragMag * vy;
  let az = -dragMag * vz;

  // Magnus lift: ω × v
  const cx = wy * vz - wz * vy;
  const cy = wz * vx - wx * vz;
  const cz = wx * vy - wy * vx;
  const crossMag = Math.hypot(cx, cy, cz);

  if (crossMag > 1e-5) {
    const magnusFactor = AERO_K * Math.min(PHYSICS.CL_SLOPE * PHYSICS.BALL_RADIUS, (PHYSICS.CL_CAP * speed * speed) / crossMag);
    ax += magnusFactor * cx;
    ay += magnusFactor * cy;
    az += magnusFactor * cz;
  }

  return { x: ax, y: ay, z: az };
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

  /** Advance exactly one fixed 1/60s tick using midpoint integration. */
  stepFixed(dt = PHYSICS.DT): StepResult {
    const s = this.state;
    if (!s.active) {
      return { bounced: false, bouncePoint: null, hitNet: false, crossedNet: false };
    }

    const prevX = s.x;
    const prevY = s.y;
    const prevZ = s.z;

    // 1. Midpoint integration of gravity + drag + Magnus
    const a0 = computeAccel(s.vx, s.vy, s.vz, s.wx, s.wy, s.wz);
    const halfDt = dt * 0.5;
    const midVx = s.vx + a0.x * halfDt;
    const midVy = s.vy + a0.y * halfDt;
    const midVz = s.vz + a0.z * halfDt;
    const aMid = computeAccel(midVx, midVy, midVz, s.wx, s.wy, s.wz);

    s.x += midVx * dt;
    s.y += midVy * dt;
    s.z += midVz * dt;
    s.vx += aMid.x * dt;
    s.vy += aMid.y * dt;
    s.vz += aMid.z * dt;

    // Spin decay (~7%/s)
    const decay = Math.exp(-PHYSICS.SPIN_DECAY_RATE * dt);
    s.wx *= decay;
    s.wy *= decay;
    s.wz *= decay;
    s.flightTime += dt;

    // 2. Net crossing & collision check
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

    // 3. Exact sub-tick impulse court bounce
    let bounced = false;
    let bouncePoint: { x: number; z: number } | null = null;
    if (s.y <= PHYSICS.COURT_Y && s.vy < 0) {
      const denom = prevY - s.y;
      const frac = denom > 1e-6 ? clamp((prevY - PHYSICS.COURT_Y) / denom, 0, 1) : 1;
      const bx = prevX + (s.x - prevX) * frac;
      const bz = prevZ + (s.z - prevZ) * frac;
      const remDt = (1 - frac) * dt;

      this.applyImpulseBounce(s);
      s.bounceCount += 1;
      bounced = true;
      bouncePoint = { x: bx, z: bz };
      s.lastBouncePoint = bouncePoint;
      if (!s.firstBouncePoint) {
        s.firstBouncePoint = bouncePoint;
      }

      // First-bounce accessibility pace retention (preserves readable post-bounce window)
      if (s.bounceCount === 1) {
        const baseRet = FIRST_BOUNCE_RETENTION[s.shotType] ?? 0.42;
        const depthFactor = clamp(1 - Math.abs(bz) / 36, 0.78, 1.08);
        const ret = clamp(baseRet * depthFactor, 0.26, 0.78);
        s.vx *= ret;
        s.vz *= ret;
        // Slice stays extra low after bounce; topspin kicks slightly higher
        if (s.shotType === 'slice') s.vy *= 0.72;
        else if (s.shotType === 'topspin') s.vy *= 1.08;
        else if (s.shotType === 'dropshot') s.vy *= 0.65;
      }

      s.x = bx + s.vx * remDt;
      s.y = PHYSICS.COURT_Y + Math.max(0, s.vy) * remDt;
      s.z = bz + s.vz * remDt;

      if (s.bounceCount >= 4 && Math.abs(s.vy) < 0.6) {
        s.active = false;
      }
    }

    return { bounced, bouncePoint, hitNet, crossedNet };
  }

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

const SHOT_BASE_SPEED_MPS: Record<AnyShotType, number> = {
  flat: 25.0,
  topspin: 21.5,
  slice: 19.2,
  dropshot: 11.2,
  lob: 14.4,
  volley: 18.0,
};

const SHOT_DEFAULT_RPM: Record<AnyShotType, number> = {
  flat: 650,
  topspin: 2300,
  slice: -2400,
  dropshot: -1300,
  lob: 1100,
  volley: 200,
};

/**
 * Simulates flight until first bounce to evaluate a candidate launch velocity.
 */
function simulateToFirstBounce(
  from: Vec3,
  vel: Vec3,
  spin: Vec3,
  shotType: AnyShotType,
): { landX: number; landZ: number; flightTime: number; clearedNet: boolean; hitNet: boolean } {
  const sim = new BallFlightEngine();
  sim.launch(from, vel, spin, shotType);
  let clearedNet = false;
  let hitNet = false;

  for (let i = 0; i < 240; i++) {
    const res = sim.stepFixed(PHYSICS.DT);
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
        clearedNet,
        hitNet,
      };
    }
  }

  return {
    landX: sim.state.x,
    landZ: sim.state.z,
    flightTime: sim.state.flightTime,
    clearedNet,
    hitNet,
  };
}

/**
 * Binary-search launch solver: finds clean (vx, vy, vz) + spin so the ball clears the net
 * and lands right at `target` (x, z) under real gravity + drag + Magnus physics.
 */
export function solveShotLaunch(
  from: Vec3,
  target: { x: number; z: number },
  shotType: AnyShotType,
  opts?: {
    speedScale?: number;
    rpmOverride?: number;
    allowNetError?: boolean;
  },
): LaunchSolution {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dirSignZ = dz >= 0 ? 1 : -1;
  const horizDist = Math.hypot(dx, dz) || 1;

  const baseSpeed = (SHOT_BASE_SPEED_MPS[shotType] ?? 20) * PHYSICS.GAME_PACE_FACTOR * (opts?.speedScale ?? 1);
  const rpm = opts?.rpmOverride ?? SHOT_DEFAULT_RPM[shotType] ?? 1200;
  const spin = computeSpinVector(dx, dz, rpm);

  // Try full speed first, stepping down cleanly if contact is too low to clear the net
  const speedMultipliers = shotType === 'lob' || shotType === 'dropshot' ? [1.0, 0.85, 0.72] : [1.0, 0.88, 0.76, 0.64, 0.52];

  let bestSolution: LaunchSolution | null = null;
  let bestError = Infinity;

  for (const mul of speedMultipliers) {
    const horizSpeed = clamp(baseSpeed * mul, 6.0, 26.0);
    const vz = (dz / horizDist) * horizSpeed;
    let vx = (dx / horizDist) * horizSpeed;

    // 1. Binary search vy to match target.z
    let vyLo = shotType === 'lob' ? 7.5 : shotType === 'dropshot' ? 2.5 : -2.5;
    let vyHi = shotType === 'lob' ? 16.5 : 13.0;
    let vy = (vyLo + vyHi) * 0.5;

    for (let iter = 0; iter < 18; iter++) {
      vy = (vyLo + vyHi) * 0.5;
      const res = simulateToFirstBounce(from, { x: vx, y: vy, z: vz }, spin, shotType);
      const reachedDepth = (res.landZ - from.z) * dirSignZ;
      const wantedDepth = Math.abs(dz);
      if (res.hitNet || reachedDepth < wantedDepth) {
        vyLo = vy;
      } else {
        vyHi = vy;
      }
    }

    // 2. Binary search vx to match target.x accurately
    let vxLo = vx - 8;
    let vxHi = vx + 8;
    for (let iter = 0; iter < 12; iter++) {
      vx = (vxLo + vxHi) * 0.5;
      const res = simulateToFirstBounce(from, { x: vx, y: vy, z: vz }, spin, shotType);
      if (res.landX < target.x) {
        vxLo = vx;
      } else {
        vxHi = vx;
      }
    }

    const finalRes = simulateToFirstBounce(from, { x: vx, y: vy, z: vz }, spin, shotType);
    const err = Math.hypot(finalRes.landX - target.x, finalRes.landZ - target.z);

    if ((!finalRes.hitNet || opts?.allowNetError) && err < bestError) {
      bestError = err;
      bestSolution = {
        vx,
        vy,
        vz,
        wx: spin.x,
        wy: spin.y,
        wz: spin.z,
        landingPoint: { x: finalRes.landX, z: finalRes.landZ },
        flightTime: finalRes.flightTime,
        clearedNet: finalRes.clearedNet,
      };
      if (finalRes.clearedNet && err < 0.25) {
        return bestSolution;
      }
    }
  }

  if (bestSolution) return bestSolution;

  // Guaranteed safe fallback lob over the net
  const fallbackVz = dirSignZ * 10.5;
  const fallbackVx = clamp((dx / Math.max(1, Math.abs(dz))) * 10.5, -10, 10);
  const fallbackVy = 7.2;
  const res = simulateToFirstBounce(from, { x: fallbackVx, y: fallbackVy, z: fallbackVz }, spin, shotType);
  return {
    vx: fallbackVx,
    vy: fallbackVy,
    vz: fallbackVz,
    wx: spin.x,
    wy: spin.y,
    wz: spin.z,
    landingPoint: { x: res.landX, z: res.landZ },
    flightTime: res.flightTime,
    clearedNet: res.clearedNet,
  };
}
