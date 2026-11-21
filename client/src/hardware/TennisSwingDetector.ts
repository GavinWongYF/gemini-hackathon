/**
 * TennisSwingDetector — Battle-tested webcam swing detector & classifier
 * ported from Tennis-Game-Spec (`SwingDetector.ts`, `strokeSide.ts`, `types.ts`,
 * `PlayerShotPlacement.ts`, `WristMotionClock.ts`, `ContactStrokeMeasurement.ts`,
 * `PlayerStrokeIntent.ts`, `PlayerAim.ts`).
 *
 * Pure TypeScript (zero DOM/window globals, zero localStorage, zero Three.js/React).
 */
import type { ArmZone, HumanShotType, StrokeWing } from '@shared/contracts';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface StrokeSample {
  x: number;
  y: number;
  z?: number;
  shoulderMidX: number;
  shoulderMidY?: number;
  shoulderMidZ?: number;
  shoulderWidth?: number;
  cameraSign: number;
  time: number;
}

export interface DetectedWebcamSwing {
  timestampMs: number;
  contactCaptureMs: number;
  wing: StrokeWing;
  wingScore: number;
  wingSource: 'contact' | 'preparation' | 'travel' | 'palm' | 'ball' | 'default';
  shotType: HumanShotType;
  spinSource: 'motion' | 'pronation' | 'palmUp' | 'softTouch';
  pathAngleDeg: number;
  power: number; // 0.18..1.0
  rotation: number; // -1..1
  angle: number; // -1..1 (court aim)
  confidence: number; // 0.55..0.97
  swingSpeed: number;
  armZone: ArmZone;
  armX: number;
}

// ─── Constants (verbatim from Tennis-Game-Spec SwingDetector.ts) ────────────

const BUFFER_SIZE = 40;
const LOOKBACK_FRAMES = 12;
const MIN_FRAMES = 5;
const MIN_VISIBILITY = 0.3;
const SPEED_SMOOTH_MS = (5 * 1000) / 30; // 166.7ms camera-time window

const CALM_THRESHOLD = 0.7;
const CALM_REQUIRED = 2;
const ARMED_WINDOW_MS = 1500;
const SWING_THRESHOLD = 0.5;
const MIN_DISPLACEMENT = 0.13;
const BURST_SPEED_THRESHOLD = 2.0;
const SWING_COOLDOWN_MS = 350;

const AIM_MAX_DX = 0.15;
const AIM_MAX = 1.0;

const FACE_NORMAL_MIN_MAG = 5e-4;
const FACE_NORMAL_CONF_MAG = 1e-3;
const FACE_NORMAL_EMA_ALPHA = 0.4;

export const PLAYER_AIM_HALF_WIDTH_M = 4.5;

// ─── Exact Ported Helper Functions ──────────────────────────────────────────

const validStrokeSample = (s: StrokeSample | null | undefined): s is StrokeSample =>
  !!s &&
  [s.x, s.y, s.shoulderMidX, s.shoulderMidY].every(Number.isFinite) &&
  Math.abs(s.cameraSign) === 1;

/**
 * Per-frame body-relative contact step (ContactStrokeMeasurement.ts).
 * Subtracts shoulder-midpoint motion, scales by 0.2 / width, and rejects steps
 * with width < 0.035, a camera sign change, or an interval outside 1..200 ms.
 */
export function bodyRelativeContactStep(
  previous: StrokeSample,
  current: StrokeSample,
  width: number,
): { dx: number; dy: number; speed: number } | null {
  const elapsedMs = current.time - previous.time;
  if (
    !validStrokeSample(previous) ||
    !validStrokeSample(current) ||
    !Number.isFinite(width) ||
    width < 0.035 ||
    previous.cameraSign !== current.cameraSign ||
    elapsedMs < 1 ||
    elapsedMs > 200
  ) {
    return null;
  }
  const scale = 0.2 / width;
  const dx = (current.x - current.shoulderMidX - (previous.x - previous.shoulderMidX)) * scale;
  const dy = (current.y - current.shoulderMidY! - (previous.y - previous.shoulderMidY!)) * scale;
  return { dx, dy, speed: (Math.hypot(dx, dy) * 1000) / elapsedMs };
}

export interface ContactSpinMeasurement {
  dyTotal: number;
  yRange: number;
  horizontalRange: number;
  contactDx: number;
  contactDy: number;
}

/**
 * Measure the wrist's vertical path in the 400 ms before contact (ContactStrokeMeasurement.ts).
 * Never uses post-contact follow-through. Output is in shoulder-normalized units (* 0.2 / width).
 */
export function measureContactSpin(
  samples: readonly StrokeSample[],
  contactTime: number,
): ContactSpinMeasurement | null {
  if (!Number.isFinite(contactTime)) return null;
  const usable = samples.filter((s) => s.time <= contactTime && s.time >= contactTime - 400);
  if (usable.length < 2) return null;
  const width = Math.max(...usable.map((s) => s.shoulderWidth ?? 0));
  if (!Number.isFinite(width) || width < 0.035) return null;

  // Walk backward from contact so a calm pause / brief MediaPipe gap > 200ms before
  // swing onset trims off stale pre-pause frames instead of discarding the entire swing!
  let tailStart = usable.length - 1;
  let lastStep: { dx: number; dy: number; speed: number } | null = null;
  for (let i = usable.length - 1; i >= 1; i--) {
    const step = bodyRelativeContactStep(usable[i - 1], usable[i], width);
    if (!step) break;
    if (lastStep === null) lastStep = step;
    tailStart = i - 1;
  }
  const contiguous = usable.slice(tailStart);
  if (contiguous.length < 2 || !lastStep) return null;

  const scale = 0.2 / width;
  const rx = (s: StrokeSample) => (s.x - s.shoulderMidX) * scale;
  const ry = (s: StrokeSample) => (s.y - s.shoulderMidY!) * scale;

  const first = contiguous[0];
  const last = contiguous[contiguous.length - 1];
  const ys = contiguous.map(ry);
  const dyTotal = ry(last) - ry(first);
  const yRange = Math.max(...ys) - Math.min(...ys);
  const horizontalRange = Math.abs(rx(last) - rx(first));

  return {
    dyTotal,
    yRange,
    horizontalRange,
    contactDx: lastStep.dx,
    contactDy: lastStep.dy,
  };
}

export interface ContactTravelMeasurement {
  aim: number;
  speed: number;
  wristCourtX: number;
  wristBelowShoulders: number;
  velocityCourtX: number;
  velocityDown: number;
  velocityForward: number | null;
}

/**
 * Measure the direction of the hand in the last 110..160 ms before contact
 * by linear regression over camera timestamps (PlayerStrokeIntent.ts).
 */
export function measureContactTravel(
  samples: readonly StrokeSample[],
  contactTime: number,
): ContactTravelMeasurement | null {
  if (!Number.isFinite(contactTime)) return null;
  let recent = samples.filter((s) => s.time <= contactTime && s.time >= contactTime - 110);
  if (recent.length < 3) {
    recent = samples.filter((s) => s.time <= contactTime && s.time >= contactTime - 160);
  }
  if (recent.length < 2) return null;

  const last = recent[recent.length - 1];
  const span = last.time - recent[0].time;
  const width = Math.max(
    ...samples
      .filter((s) => s.time <= contactTime && s.time >= contactTime - 400)
      .map((s) => s.shoulderWidth ?? 0),
  );
  if (
    span < 45 ||
    span > 160 ||
    !Number.isFinite(width) ||
    width < 0.035 ||
    recent.some(
      (s) =>
        !validStrokeSample(s) ||
        s.cameraSign !== recent[0].cameraSign,
    ) ||
    recent.some((s, i) => i > 0 && (s.time <= recent[i - 1].time || s.time - recent[i - 1].time > 200))
  ) {
    return null;
  }

  const meanT = recent.reduce((sum, s) => sum + s.time, 0) / recent.length;
  let xx = 0;
  let tx = 0;
  let ty = 0;
  for (const s of recent) {
    const t = (s.time - meanT) / 1000;
    xx += t * t;
    tx += t * (s.x - s.shoulderMidX);
    ty += t * (s.y - s.shoulderMidY!);
  }
  if (xx <= 0) return null;
  const vx = tx / xx / width;
  const vy = ty / xx / width;

  let velocityForward: number | null = null;
  if (
    recent.length >= 3 &&
    recent.every((s) => Number.isFinite(s.z) && Number.isFinite(s.shoulderMidZ))
  ) {
    const dzVals = recent.map((s) => (s.z! - s.shoulderMidZ!) / width);
    const meanDz = dzVals.reduce((a, b) => a + b, 0) / dzVals.length;
    let tz = 0;
    let zz = 0;
    for (let i = 0; i < recent.length; i++) {
      const t = (recent[i].time - meanT) / 1000;
      const dz = dzVals[i] - meanDz;
      tz += t * dz;
      zz += dz * dz;
    }
    const forward = -tz / xx;
    const coherence = zz > 0 ? Math.abs(tz) / Math.sqrt(xx * zz) : 0;
    if (forward > 0.4 && (forward * span) / 1000 >= 0.12 && coherence >= 0.9) {
      velocityForward = forward;
    }
  }

  const travel = (Math.hypot(vx, vy, velocityForward ?? 0) * span) / 1000;
  if (travel < (recent.length === 2 ? 0.12 : 0.08)) return null;

  const horizontalTravel = -vx * last.cameraSign * 0.1;
  const magnitude = clamp((Math.abs(horizontalTravel) - 0.045) / 0.65, 0, 1);
  return {
    aim: magnitude === 0 ? 0 : Math.sign(horizontalTravel) * magnitude,
    speed: Math.hypot(vx, vy, velocityForward ?? 0) * 0.2,
    wristCourtX: -((last.x - last.shoulderMidX) * last.cameraSign) / width,
    wristBelowShoulders: (last.y - last.shoulderMidY!) / width,
    velocityCourtX: -vx * last.cameraSign,
    velocityDown: vy,
    velocityForward,
  };
}

/**
 * Position aim (PlayerAim.ts): wrist offset from the shoulder midpoint in shoulder widths,
 * sign corrected by cameraSign. Dead zone 0.035, full aim at 0.6 widths.
 */
export function wristPositionToCourtAim(input: {
  wristX: number;
  shoulderMidX: number;
  shoulderWidth: number;
  cameraSign: number;
}): number | null {
  const { wristX, shoulderMidX, shoulderWidth, cameraSign } = input;
  if (
    ![wristX, shoulderMidX, shoulderWidth, cameraSign].every(Number.isFinite) ||
    shoulderWidth < 0.035 ||
    Math.abs(cameraSign) !== 1
  ) {
    return null;
  }
  const offset = ((shoulderMidX - wristX) * cameraSign) / shoulderWidth;
  const deadZone = 0.035;
  const fullAimOffset = 0.6;
  const magnitude = Math.max(0, Math.abs(offset) - deadZone) / (fullAimOffset - deadZone);
  return magnitude === 0 ? 0 : Math.sign(offset) * Math.min(1, magnitude);
}

export interface StrokeSideKinematics {
  /** Wrist offset from the shoulder midpoint at contact, in shoulder widths.
   * Negative is the dominant-hand side; positive is across the body. */
  contactLateral?: number;
  /** Wrist offset at preparation/start, using the same convention. */
  startLateral?: number;
  /** Dominant-side to non-dominant-side travel is positive. */
  handTravel?: number;
  /** Optional palm-vs-forearm cue. Positive means palm-first. */
  palmAlignment?: number;
  /** Optional incoming ball offset in metres (negative = dominant side, positive = across body). */
  ballLateral?: number;
  /** Whether a valid body-relative contact trajectory was measured. */
  measuredContactMotion?: boolean;
}

export interface StrokeSideResult {
  side: StrokeWing;
  /** Signed confidence: +1 forehand, -1 backhand. */
  score: number;
  source: 'contact' | 'preparation' | 'travel' | 'palm' | 'ball' | 'default';
  signals: {
    contact: number;
    preparation: number;
    travel: number;
    palm: number;
    ball: number;
  };
}

/**
 * Classify forehand/backhand from the dominant hand + optional incoming ball side
 * (verbatim from Tennis-Game-Spec shared/strokeSide.ts).
 * Dominant wrist contact 0.55, ball 1.60 (0 if committed hand), preparation 0.25, travel 0.20, palm 0.10.
 */
export function classifyStrokeSide(input: StrokeSideKinematics): StrokeSideResult {
  const finite = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value);

  const signals = {
    contact: finite(input.contactLateral) ? clampUnit(-input.contactLateral / 0.45) : 0,
    preparation: finite(input.startLateral) ? clampUnit(-input.startLateral / 0.60) : 0,
    travel: finite(input.handTravel) ? clampUnit(input.handTravel / 0.75) : 0,
    palm: finite(input.palmAlignment) ? clampUnit(input.palmAlignment / 0.35) : 0,
    ball: finite(input.ballLateral) ? clampUnit(-input.ballLateral / 0.90) : 0,
  };

  const committedHand =
    input.measuredContactMotion === true &&
    Math.abs(signals.contact) === 1 &&
    finite(input.startLateral) &&
    Math.abs(input.startLateral) >= 0.45 &&
    Math.sign(signals.contact) === Math.sign(signals.preparation);

  const votes = [
    { key: 'contact' as const, value: signals.contact, weight: 0.55, gate: 0.08 },
    { key: 'ball' as const, value: signals.ball, weight: committedHand ? 0 : 1.60, gate: 0.15 },
    { key: 'preparation' as const, value: signals.preparation, weight: 0.25, gate: 0.10 },
    { key: 'travel' as const, value: signals.travel, weight: 0.20, gate: 0.08 },
    { key: 'palm' as const, value: signals.palm, weight: 0.10, gate: 0.45 },
  ];

  let weighted = 0;
  let totalWeight = 0;
  let source: StrokeSideResult['source'] = 'default';
  let strongestContribution = 0;
  for (const vote of votes) {
    if (Math.abs(vote.value) < vote.gate) continue;
    const contribution = vote.value * vote.weight;
    weighted += contribution;
    totalWeight += vote.weight;
    if (Math.abs(contribution) > strongestContribution) {
      strongestContribution = Math.abs(contribution);
      source = vote.key;
    }
  }

  const score = totalWeight > 0 ? clampUnit(weighted / totalWeight) : 0;
  return {
    side: score < 0 ? 'backhand' : 'forehand',
    score,
    source,
    signals,
  };
}

export type WristSpinMotionFamily = 'slice' | 'topspin' | 'ambiguous';

export interface WristSpinMotionInput {
  dyTotal: number;
  yRange: number;
  horizontalRange: number;
  contactDx?: number;
  contactDy?: number;
}

export interface WristSpinMotionDecision {
  family: WristSpinMotionFamily;
  pathAngle: number | null;
  verticality: number;
  contactVerticality: number;
}

/**
 * Classify spin family from dominant wrist camera-space motion (shared/types.ts).
 * Requires contactVerticality > 0.15 for descending arc slice so follow-through drop
 * never turns a drive into slice.
 */
export function classifyWristSpinMotion(input: WristSpinMotionInput): WristSpinMotionDecision {
  const finite = (value: number | undefined) => (Number.isFinite(value) ? (value as number) : 0);
  const dyTotal = finite(input.dyTotal);
  const yRange = Math.max(0, finite(input.yRange));
  const horizontalRange = Math.max(0, finite(input.horizontalRange));
  const contactDx = finite(input.contactDx);
  const contactDy = finite(input.contactDy);
  const verticality = yRange / Math.max(0.02, yRange + horizontalRange);
  const contactDistance = Math.hypot(contactDx, contactDy);
  const contactVerticality = contactDistance > 0.002 ? contactDy / contactDistance : 0;

  const descendingArc =
    dyTotal > 0.055 && yRange > 0.055 && verticality > 0.20 && contactVerticality > 0.15;
  const descendingContact = dyTotal > 0.02 && yRange > 0.055 && contactVerticality > 0.30;
  if (descendingArc || descendingContact) {
    const magnitude = Math.max(dyTotal, yRange * 0.75);
    return {
      family: 'slice',
      pathAngle: -Math.max(12, Math.min(20, magnitude * 95)),
      verticality,
      contactVerticality,
    };
  }

  const risingArc = dyTotal < -0.05;
  const risingContact = dyTotal < -0.02 && yRange > 0.05 && contactVerticality < -0.30;
  if (risingArc || risingContact) {
    const magnitude = Math.max(-dyTotal, yRange * 0.70);
    return {
      family: 'topspin',
      pathAngle: Math.max(13, Math.min(16, 9 + magnitude * 70)),
      verticality,
      contactVerticality,
    };
  }

  return { family: 'ambiguous', pathAngle: null, verticality, contactVerticality };
}

/**
 * Recognize slice's descending preparation followed by a level drive THROUGH contact
 * (PlayerShotPlacement.ts). Never consults post-contact drop.
 */
export function highToLevelSlice(samples: readonly StrokeSample[], contactTime: number): boolean {
  if (!Number.isFinite(contactTime)) return false;
  const usable = samples.filter((s) => s.time <= contactTime && s.time >= contactTime - 500);
  if (usable.length < 5) return false;
  const width = Math.max(...usable.map((s) => s.shoulderWidth ?? 0));
  if (
    !Number.isFinite(width) ||
    width < 0.035 ||
    usable.some(
      (s) =>
        ![s.x, s.y, s.shoulderMidX, s.shoulderMidY, s.shoulderWidth].every(Number.isFinite) ||
        Math.abs(s.cameraSign) !== 1 ||
        s.cameraSign !== usable[0].cameraSign,
    ) ||
    usable.some((s, i) => i > 0 && (s.time <= usable[i - 1].time || s.time - usable[i - 1].time > 200))
  ) {
    return false;
  }
  let through = usable.filter((s) => s.time >= contactTime - 90);
  if (through.length < 2) through = usable.filter((s) => s.time >= contactTime - 160);
  const prior = usable.filter((s) => s.time < (through[0]?.time ?? contactTime));
  if (prior.length < 3 || through.length < 2) return false;
  const y = (s: StrokeSample) => (s.y - s.shoulderMidY!) / width;
  const x = (s: StrokeSample) => (s.x - s.shoulderMidX) / width;
  const first = through[0];
  const last = through[through.length - 1];
  const drop = y(first) - Math.min(...prior.map(y));
  const levelY = y(last) - y(first);
  const forward = Math.abs(x(last) - x(first));
  const throughMs = last.time - first.time;
  let descendingMs = 0;
  for (let i = 1; i < prior.length; i++) {
    const dt = prior[i].time - prior[i - 1].time;
    if (dt > 0 && dt <= 200 && ((y(prior[i]) - y(prior[i - 1])) / dt) * 1000 > 0.18) {
      descendingMs += dt;
    }
  }
  return (
    descendingMs >= 65 &&
    drop >= 0.22 &&
    throughMs >= 25 &&
    forward >= 0.08 &&
    (forward / throughMs) * 1000 >= 2.4 &&
    levelY >= -0.045 &&
    levelY <= 0.09 &&
    Math.abs(levelY) <= forward * 0.22
  );
}

/**
 * -1: wrap across to opposite shoulder (cross-court); 0: middle; +1: extend on hitting side
 * (PlayerShotPlacement.ts).
 */
export function shoulderPlacement(
  travel: ContactTravelMeasurement | null,
  wing: StrokeWing,
  hand: 'right' | 'left',
): number | null {
  if (!travel) return null;
  const side = (wing === 'forehand' ? 1 : -1) * (hand === 'right' ? 1 : -1);
  if (travel.velocityForward !== null && travel.velocityForward !== undefined) {
    const inward = -travel.velocityCourtX * side;
    const placement = 1 - 2 * clamp(inward / travel.velocityForward, 0, 1);
    const magnitude = clamp((Math.abs(placement) - 0.12) / 0.78, 0, 1);
    const eased = magnitude * magnitude * (3 - 2 * magnitude);
    return eased === 0 ? 0 : Math.sign(placement) * eased;
  }
  const length = Math.hypot(travel.velocityCourtX, travel.velocityDown);
  if (!Number.isFinite(length) || length < 0.4) return null;
  const dx = (travel.velocityCourtX * side) / length;
  const dy = travel.velocityDown / length;
  const reach =
    dy < -0.2 && travel.wristBelowShoulders > 0.1
      ? clamp(travel.wristBelowShoulders / -dy, 0.45, 2.3)
      : 1.25;
  const projected = travel.wristCourtX * side + dx * reach;
  const magnitude = clamp((Math.abs(projected) - 0.15) / 0.35, 0, 1);
  const eased = magnitude * magnitude * (3 - 2 * magnitude);
  return eased === 0 ? 0 : Math.sign(projected) * eased;
}

export function placementCourtAim(
  placement: number,
  courtX: number,
  wing: StrokeWing,
  hand: 'right' | 'left',
): number {
  if (![placement, courtX].every(Number.isFinite)) return 0;
  const line = clamp(courtX, -4.1, 4.1);
  const side =
    Math.abs(line) > 0.6
      ? Math.sign(line)
      : (wing === 'forehand' ? 1 : -1) * (hand === 'right' ? 1 : -1);
  const cross = -side * clamp(Math.abs(line) + 0.7, 2.8, 4.0);
  const lane = clamp(placement, -1, 1);
  if (lane === 0) return 0;
  return (lane < 0 ? -lane * cross : lane * line) / PLAYER_AIM_HALF_WIDTH_M;
}

/**
 * Soft-touch stroke check (PlayerShotPlacement.ts).
 */
export function isSoftTouchStroke(normalizedSpeed: number | null, rawSpeed: number): boolean {
  const speed = normalizedSpeed ?? rawSpeed;
  return Number.isFinite(speed) && speed >= 0 && speed < 0.48;
}

/**
 * Burst detection uses the stronger of the current camera sample and rolling average
 * (WristMotionClock.ts).
 */
export function responsiveBurstSpeed(
  smoothedSpeed: number,
  currentFrameSpeed: number | undefined,
): number {
  const instant = Number.isFinite(currentFrameSpeed) ? currentFrameSpeed! : 0;
  return Math.max(smoothedSpeed, instant);
}

// ─── Internal Snapshot Type ─────────────────────────────────────────────────

interface WristSnapshot extends StrokeSample {
  x: number;
  y: number;
  z: number;
  shoulderMidX: number;
  shoulderMidY?: number;
  shoulderMidZ?: number;
  shoulderWidth?: number;
  cameraSign: number;
  shoulderX?: number;
  shoulderY?: number;
  shoulderZ?: number;
  elbowX?: number;
  elbowY?: number;
  elbowZ?: number;
  palmAlignment?: number;
  palmUpness?: number;
  lShoulderX?: number;
  rShoulderX?: number;
  time: number;
  speed?: number;
  faceNormalX?: number;
  faceNormalY?: number;
  faceNormalZ?: number;
  pronationDeg?: number;
  flexionDeg?: number;
}

// ─── TennisSwingDetector Class ──────────────────────────────────────────────

export class TennisSwingDetector {
  private buffer: (WristSnapshot | null)[];
  private writeIdx = 0;
  private frameCount = 0;
  private handedness: 'left' | 'right';
  private recentSpeeds: { speed: number; start: number; end: number }[] = [];

  private faceN = { x: 0, y: 0, z: 0, init: false };
  lastContactFrameIdx = -1;
  lastContactSubFrameFrac = 0;
  lastContactCaptureTime = 0;
  lastFaceNormalAtContact: { x: number; y: number; z: number } | null = null;

  // State machine
  private calmFrames = 0;
  private armed = false;
  private armedTime = 0;
  private lastSwingTime = 0;

  // Duplicate frame rejection
  private prevWristX = NaN;
  private prevWristY = NaN;
  private prevWristZ = NaN;

  // Camera orientation majority vote (+1 unmirrored, -1 pre-mirrored)
  cameraSign = 1;
  private cameraSignVotes: number[] = [];

  // Grip EMA from forearm pronation
  private gripAngleEMA: number | null = null;
  lastGrip: 'continental' | 'eastern' | 'semi-western' | 'western' | null = null;

  // Latest classification diagnostics
  lastDetectedSwing: DetectedWebcamSwing | null = null;
  lastStrokeSide: StrokeWing = 'forehand';
  lastStrokeSideScore = 0;
  lastStrokeSideSource: 'contact' | 'preparation' | 'travel' | 'palm' | 'ball' | 'default' =
    'default';
  lastStrokeSideSignals: StrokeSideResult['signals'] | null = null;
  private ballOffsetRightMeters: number | undefined = undefined;
  lastContactSpinMeasured = false;
  lastDetectedTime = 0;
  lastSwingPower = 0;
  lastSwingSpeed = 0;
  lastSwingDirection = 0;
  lastShotType: HumanShotType = 'topspin';
  lastPathAngle = 0;
  lastBrushFactor = 0;
  lastContactHeight = 0.5;
  lastContactAimDirection: number | null = null;
  lastContactMotionAim: number | null = null;
  lastContactPlacement: number | null = null;
  lastContactSwingSpeed: number | null = null;
  liveAimDirection: number | null = null;
  liveAimCaptureTime = 0;
  intendedAim = 0;
  lastShoulderRotation = 0;
  lastElbowExtension = 0;
  lastPowerMultiplier = 1.0;
  lastShoulderAim = 0;
  lastPalmAlign: number | undefined = undefined;

  constructor(handedness: 'left' | 'right' = 'right') {
    this.handedness = handedness;
    this.buffer = new Array(BUFFER_SIZE).fill(null);
  }

  setHandedness(handedness: 'left' | 'right'): void {
    this.handedness = handedness;
  }

  setBallLateral(ballOffsetRightMeters?: number): void {
    this.ballOffsetRightMeters =
      typeof ballOffsetRightMeters === 'number' && Number.isFinite(ballOffsetRightMeters)
        ? ballOffsetRightMeters
        : undefined;
  }

  getHandedness(): 'left' | 'right' {
    return this.handedness;
  }

  invalidateLiveAim(): void {
    this.liveAimDirection = null;
    this.liveAimCaptureTime = 0;
  }

  /**
   * Clears circular buffer and resets calm-then-swing state machine (e.g. on Re-Zero).
   */
  reset(): void {
    this.lastDetectedTime = 0;
    this.lastContactCaptureTime = 0;
    this.lastContactFrameIdx = -1;
    this.lastContactSubFrameFrac = 0;
    this.lastFaceNormalAtContact = null;
    this.lastContactAimDirection = null;
    this.lastContactMotionAim = null;
    this.lastContactPlacement = null;
    this.lastContactSwingSpeed = null;
    this.lastStrokeSideSignals = null;
    this.lastContactSpinMeasured = false;
    this.lastDetectedSwing = null;
    this.invalidateLiveAim();
    this.lastSwingTime = 0;
    this.calmFrames = 0;
    this.armed = false;
    this.armedTime = 0;
    this.recentSpeeds = [];
    this.faceN = { x: 0, y: 0, z: 0, init: false };
    this.gripAngleEMA = null;
    this.lastGrip = null;
    this.buffer.fill(null);
    this.writeIdx = 0;
    this.frameCount = 0;
    this.prevWristX = NaN;
    this.prevWristY = NaN;
    this.prevWristZ = NaN;
  }

  private updateGrip(pronationDeg: number): void {
    this.gripAngleEMA =
      this.gripAngleEMA === null ? pronationDeg : this.gripAngleEMA * 0.9 + pronationDeg * 0.1;
    const a = this.gripAngleEMA;
    this.lastGrip =
      a < -25 ? 'continental' : a < 20 ? 'eastern' : a < 55 ? 'semi-western' : 'western';
  }

  /**
   * Feed a new MediaPipe Pose 33-landmark array (~30fps).
   * Returns a `DetectedWebcamSwing` when a swing is detected on this frame, or `null`.
   */
  update(
    pose: readonly Landmark[],
    timestamp: number,
    captureTimestamp: number = timestamp,
  ): DetectedWebcamSwing | null {
    const motionTimestamp = Number.isFinite(captureTimestamp) ? captureTimestamp : timestamp;
    const previousFrame = this.buffer[(this.writeIdx - 1 + BUFFER_SIZE) % BUFFER_SIZE];
    if (!Number.isFinite(motionTimestamp) || (previousFrame && motionTimestamp <= previousFrame.time)) {
      return null;
    }

    const wristIdx = this.handedness === 'right' ? 16 : 15;
    const wrist = pose[wristIdx];
    if (
      !wrist ||
      ![wrist.x, wrist.y, wrist.z].every(Number.isFinite) ||
      (wrist.visibility ?? 0) < MIN_VISIBILITY
    ) {
      this.invalidateLiveAim();
      return null;
    }

    const duplicateWristFrame =
      wrist.x === this.prevWristX && wrist.y === this.prevWristY && wrist.z === this.prevWristZ;

    const lShoulder = pose[11];
    const rShoulder = pose[12];
    let shoulderMidX = 0.5;
    let shoulderWidth: number | undefined;
    let shoulderMidY: number | undefined;
    let shoulderMidZ: number | undefined;
    if (
      lShoulder &&
      rShoulder &&
      (lShoulder.visibility ?? 0) >= MIN_VISIBILITY &&
      (rShoulder.visibility ?? 0) >= MIN_VISIBILITY
    ) {
      shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
      shoulderMidY = (lShoulder.y + rShoulder.y) / 2;
      if ([lShoulder.z, rShoulder.z].every(Number.isFinite)) {
        shoulderMidZ = (lShoulder.z + rShoulder.z) / 2;
      }
      shoulderWidth = Math.abs(rShoulder.x - lShoulder.x);
      if (!duplicateWristFrame) {
        const vote = rShoulder.x > lShoulder.x ? -1 : 1;
        this.cameraSignVotes.push(vote);
        if (this.cameraSignVotes.length > 30) this.cameraSignVotes.shift();
        const voteSum = this.cameraSignVotes.reduce((a, b) => a + b, 0);
        if (Math.abs(voteSum) > this.cameraSignVotes.length * 0.7) {
          this.cameraSign = voteSum > 0 ? 1 : -1;
        }
      }
    }

    let aimReferenceWidth = shoulderWidth ?? 0;
    for (let i = 0; i < Math.min(LOOKBACK_FRAMES, this.frameCount); i++) {
      const prior = this.buffer[(this.writeIdx - 1 - i + BUFFER_SIZE) % BUFFER_SIZE];
      aimReferenceWidth = Math.max(aimReferenceWidth, prior?.shoulderWidth ?? 0);
    }
    this.liveAimDirection = wristPositionToCourtAim({
      wristX: wrist.x,
      shoulderMidX,
      shoulderWidth: shoulderWidth === undefined ? 0 : aimReferenceWidth,
      cameraSign: this.cameraSign,
    });
    this.liveAimCaptureTime = this.liveAimDirection === null ? 0 : motionTimestamp;

    if (duplicateWristFrame) return null;
    this.prevWristX = wrist.x;
    this.prevWristY = wrist.y;
    this.prevWristZ = wrist.z;

    if (shoulderWidth && shoulderWidth > 0.01) {
      const rawOff = (wrist.x - shoulderMidX) / (shoulderWidth * 0.6);
      const aimPos = Math.max(-1, Math.min(1, rawOff)) * this.cameraSign;
      this.intendedAim = this.intendedAim * 0.7 + aimPos * 0.3;
    }

    const domShoulderIdx = this.handedness === 'right' ? 12 : 11;
    const domElbowIdx = this.handedness === 'right' ? 14 : 13;
    const domShoulder = pose[domShoulderIdx];
    const domElbow = pose[domElbowIdx];
    const hasArmChain =
      domShoulder &&
      (domShoulder.visibility ?? 0) >= MIN_VISIBILITY &&
      domElbow &&
      (domElbow.visibility ?? 0) >= MIN_VISIBILITY;

    const domPinkyIdx = this.handedness === 'right' ? 18 : 17;
    const domIndexIdx = this.handedness === 'right' ? 20 : 19;
    const pinkyLm = pose[domPinkyIdx];
    const indexLm = pose[domIndexIdx];

    let palmAlignment: number | undefined;
    let palmUpness: number | undefined;
    let pronationDeg: number | undefined;
    let flexionDeg: number | undefined;

    if (
      pinkyLm &&
      indexLm &&
      hasArmChain &&
      (pinkyLm.visibility ?? 0) >= MIN_VISIBILITY &&
      (indexLm.visibility ?? 0) >= MIN_VISIBILITY
    ) {
      const vIx = indexLm.x - wrist.x;
      const vIy = indexLm.y - wrist.y;
      const vIz = indexLm.z - wrist.z;
      const vPx = pinkyLm.x - wrist.x;
      const vPy = pinkyLm.y - wrist.y;
      const vPz = pinkyLm.z - wrist.z;

      const nx0 = vIy * vPz - vIz * vPy;
      const ny0 = vIz * vPx - vIx * vPz;
      const nz0 = vIx * vPy - vIy * vPx;
      const nMag = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0);

      if (nMag > FACE_NORMAL_MIN_MAG) {
        const handFlip = this.handedness === 'right' ? 1 : -1;
        const nx = (nx0 / nMag) * handFlip;
        const ny = (ny0 / nMag) * handFlip;
        const nz = (nz0 / nMag) * handFlip;

        const conf = Math.min(1, nMag / FACE_NORMAL_CONF_MAG);
        const a = FACE_NORMAL_EMA_ALPHA * conf;
        if (!this.faceN.init) {
          this.faceN.x = nx;
          this.faceN.y = ny;
          this.faceN.z = nz;
          this.faceN.init = true;
        } else {
          this.faceN.x = this.faceN.x * (1 - a) + nx * a;
          this.faceN.y = this.faceN.y * (1 - a) + ny * a;
          this.faceN.z = this.faceN.z * (1 - a) + nz * a;
          const sMag = Math.sqrt(this.faceN.x ** 2 + this.faceN.y ** 2 + this.faceN.z ** 2);
          if (sMag > 0) {
            this.faceN.x /= sMag;
            this.faceN.y /= sMag;
            this.faceN.z /= sMag;
          }
        }

        const ax = wrist.x - domShoulder.x;
        const ay = wrist.y - domShoulder.y;
        const az = wrist.z - domShoulder.z;
        const aMag = Math.sqrt(ax * ax + ay * ay + az * az);
        if (aMag > 1e-5) {
          const axn = ax / aMag;
          const ayn = ay / aMag;
          const azn = az / aMag;
          palmAlignment = nx * axn + ny * ayn + nz * azn;
        }

        palmUpness = -ny;

        const fx0 = wrist.x - domElbow.x;
        const fy0 = wrist.y - domElbow.y;
        const fz0 = wrist.z - domElbow.z;
        const fMag = Math.sqrt(fx0 * fx0 + fy0 * fy0 + fz0 * fz0);
        if (fMag > 1e-4) {
          const fx = fx0 / fMag;
          const fy = fy0 / fMag;
          const fz = fz0 / fMag;
          const dotNF = nx * fx + ny * fy + nz * fz;
          const px = nx - dotNF * fx;
          const py = ny - dotNF * fy;
          const pz = nz - dotNF * fz;
          const pMag = Math.sqrt(px * px + py * py + pz * pz);
          if (pMag > 1e-4) {
            const pyn = py / pMag;
            const pzn = pz / pMag;
            const handFlipPron = this.handedness === 'right' ? 1 : -1;
            pronationDeg = Math.atan2(pzn * handFlipPron, -pyn) * (180 / Math.PI);
          }

          const hx = indexLm.x - wrist.x;
          const hy = indexLm.y - wrist.y;
          const hz = indexLm.z - wrist.z;
          const hMag = Math.sqrt(hx * hx + hy * hy + hz * hz);
          if (hMag > 1e-4) {
            const cosFlex = (fx * hx + fy * hy + fz * hz) / hMag;
            flexionDeg = Math.acos(Math.max(-1, Math.min(1, cosFlex))) * (180 / Math.PI);
            flexionDeg = 180 - flexionDeg;
          }
        }
      }
    }

    if (pronationDeg !== undefined) this.updateGrip(pronationDeg);

    const frameSpeed = previousFrame
      ? bodyRelativeContactStep(
          previousFrame,
          {
            x: wrist.x,
            y: wrist.y,
            shoulderMidX,
            shoulderMidY,
            shoulderWidth,
            cameraSign: this.cameraSign,
            time: motionTimestamp,
          },
          aimReferenceWidth,
        )?.speed
      : undefined;

    const snap: WristSnapshot = {
      x: wrist.x,
      y: wrist.y,
      z: wrist.z,
      shoulderMidX,
      shoulderMidY,
      shoulderMidZ,
      shoulderWidth,
      cameraSign: this.cameraSign,
      shoulderX: hasArmChain ? domShoulder.x : undefined,
      shoulderY: hasArmChain ? domShoulder.y : undefined,
      shoulderZ: hasArmChain ? domShoulder.z : undefined,
      elbowX: hasArmChain ? domElbow.x : undefined,
      elbowY: hasArmChain ? domElbow.y : undefined,
      elbowZ: hasArmChain ? domElbow.z : undefined,
      palmAlignment,
      palmUpness,
      lShoulderX:
        lShoulder && (lShoulder.visibility ?? 0) >= MIN_VISIBILITY ? lShoulder.x : undefined,
      rShoulderX:
        rShoulder && (rShoulder.visibility ?? 0) >= MIN_VISIBILITY ? rShoulder.x : undefined,
      time: motionTimestamp,
      speed: frameSpeed,
      faceNormalX: this.faceN.init ? this.faceN.x : undefined,
      faceNormalY: this.faceN.init ? this.faceN.y : undefined,
      faceNormalZ: this.faceN.init ? this.faceN.z : undefined,
      pronationDeg,
      flexionDeg,
    };
    this.buffer[this.writeIdx] = snap;
    this.writeIdx = (this.writeIdx + 1) % BUFFER_SIZE;
    this.frameCount++;

    const previewSamples: WristSnapshot[] = [];
    for (let i = Math.min(this.frameCount, BUFFER_SIZE) - 1; i >= 0; i--) {
      const sample = this.buffer[(this.writeIdx - 1 - i + BUFFER_SIZE) % BUFFER_SIZE];
      if (sample) previewSamples.push(sample);
    }
    const previewTravel = measureContactTravel(previewSamples, motionTimestamp);
    const forwardStroke =
      previewTravel?.velocityForward !== null && previewTravel?.velocityForward !== undefined;
    if (forwardStroke) snap.speed = Math.max(snap.speed ?? 0, previewTravel!.speed);

    if (this.frameCount < MIN_FRAMES) return null;

    const prevIdx = (this.writeIdx - 2 + BUFFER_SIZE) % BUFFER_SIZE;
    const prev = this.buffer[prevIdx];
    if (!prev) return null;

    const dt = (snap.time - prev.time) / 1000;
    if (dt < 0.001) return null;

    const motionScale = aimReferenceWidth >= 0.035 ? Math.min(2, 0.2 / aimReferenceWidth) : 1;
    const bodyMeasured = snap.shoulderMidY !== undefined && prev.shoulderMidY !== undefined;
    const dx = snap.x - prev.x - (bodyMeasured ? snap.shoulderMidX - prev.shoulderMidX : 0);
    const dy = snap.y - prev.y - (bodyMeasured ? snap.shoulderMidY! - prev.shoulderMidY! : 0);
    const speed = Math.max(
      (Math.sqrt(dx * dx + dy * dy) / dt) * motionScale,
      forwardStroke ? previewTravel!.speed : 0,
    );

    this.recentSpeeds.push({ speed, start: prev.time, end: snap.time });
    const cutoff = snap.time - SPEED_SMOOTH_MS;
    while (this.recentSpeeds[0]?.end <= cutoff) this.recentSpeeds.shift();
    let integratedSpeed = 0;
    let sampledMs = 0;
    for (const sample of this.recentSpeeds) {
      const duration = sample.end - Math.max(cutoff, sample.start);
      integratedSpeed += sample.speed * duration;
      sampledMs += duration;
    }
    const avgSpeed = sampledMs > 0 ? integratedSpeed / sampledMs : 0;
    const burstSpeed = responsiveBurstSpeed(avgSpeed, speed);

    // ── State machine: calm-then-swing + burst bypass ──
    if (timestamp - this.lastSwingTime < SWING_COOLDOWN_MS) {
      this.calmFrames = 0;
      this.armed = false;
      return null;
    }

    if (avgSpeed < CALM_THRESHOLD) {
      this.calmFrames++;
      if (this.calmFrames >= CALM_REQUIRED) {
        this.armed = true;
        this.armedTime = timestamp;
      }
      return null;
    }

    this.calmFrames = 0;

    if (this.armed && timestamp - this.armedTime > ARMED_WINDOW_MS) {
      this.armed = false;
    }

    // BURST BYPASS: very fast wrist motion fires immediately even if never armed
    if (!this.armed && burstSpeed > BURST_SPEED_THRESHOLD) {
      const displacement = this.getLookbackDisplacement(forwardStroke);
      if (displacement >= MIN_DISPLACEMENT) {
        this.lastSwingTime = timestamp;
        return this.classifyAndFire(timestamp);
      }
    }

    if (this.armed && avgSpeed > SWING_THRESHOLD) {
      const displacement = this.getLookbackDisplacement(forwardStroke);
      if (displacement >= MIN_DISPLACEMENT) {
        this.armed = false;
        this.lastSwingTime = timestamp;
        return this.classifyAndFire(timestamp);
      }
    }

    return null;
  }

  /**
   * Classifies the most recent contact window on demand (e.g. if an M5 BLE gyro
   * peak fires slightly before the webcam displacement gate).
   */
  classifyNow(timestamp: number = performance.now()): DetectedWebcamSwing | null {
    if (this.frameCount < 2) return this.lastDetectedSwing;
    if (
      this.lastDetectedSwing &&
      timestamp - this.lastDetectedSwing.timestampMs < 140
    ) {
      return this.lastDetectedSwing;
    }
    return this.classifyAndFire(timestamp) ?? this.lastDetectedSwing;
  }

  /**
   * Time-aligned exact-window classification anchored to an M5 BLE gyro-peak swing!
   * Scans ONLY frames inside `[tStartCam - 180, tEndCam + 40]` in the 40-frame ring buffer,
   * locates the exact peak-wrist-speed contact frame inside `[tStartCam - 40, tEndCam + 40]`,
   * and runs the exact battle-tested `classifyStrokeSide`, `classifyWristSpinMotion`,
   * `highToLevelSlice`, and `isSoftTouchStroke` rules strictly on that contact window.
   */
  classifyWindow(
    tStartCam: number,
    tEndCam: number,
    ballOffsetRightMeters?: number,
  ): DetectedWebcamSwing | null {
    if (this.frameCount < 3) return null;

    const allSamples: WristSnapshot[] = [];
    const count = Math.min(this.frameCount, BUFFER_SIZE);
    for (let i = count - 1; i >= 0; i--) {
      const s = this.buffer[(this.writeIdx - 1 - i + BUFFER_SIZE) % BUFFER_SIZE];
      if (s) allSamples.push(s);
    }

    const windowSamples = allSamples.filter(
      (s) => s.time >= tStartCam - 220 && s.time <= tEndCam + 45,
    );
    if (windowSamples.length < 2) return null;

    // Locate peak-speed contact frame strictly inside the forward swing window
    const fwdSamples = windowSamples.filter(
      (s) => s.time >= tStartCam - 45 && s.time <= tEndCam + 45,
    );
    const searchPool = fwdSamples.length >= 2 ? fwdSamples : windowSamples;

    let contactIdx = searchPool.length - 1;
    let bestSpeed = -1;
    for (let i = 0; i < searchPool.length; i++) {
      const spd = searchPool[i].speed ?? 0;
      if (spd >= bestSpeed) {
        bestSpeed = spd;
        contactIdx = i;
      }
    }
    const contactFrame = searchPool[contactIdx];
    const prepFrame = windowSamples[0];

    let referenceShoulderWidth = 0;
    for (const s of windowSamples) {
      if ((s.shoulderWidth ?? 0) > referenceShoulderWidth) {
        referenceShoulderWidth = s.shoulderWidth!;
      }
    }
    if (referenceShoulderWidth < 0.035) return null;

    const preAndContact = windowSamples.filter((s) => s.time <= contactFrame.time);
    const travel = measureContactTravel(preAndContact, contactFrame.time);
    const spinMotion = measureContactSpin(preAndContact, contactFrame.time);
    const isHighToLevel = highToLevelSlice(preAndContact, contactFrame.time);

    // Average palm cues near contact
    let palmAlignSum = 0;
    let palmAlignCount = 0;
    let palmUpSum = 0;
    let palmUpCount = 0;
    const palmSlice = preAndContact.slice(-5);
    for (const s of palmSlice) {
      if (s.palmAlignment !== undefined) {
        palmAlignSum += s.palmAlignment;
        palmAlignCount++;
      }
      if (s.palmUpness !== undefined) {
        palmUpSum += s.palmUpness;
        palmUpCount++;
      }
    }
    const avgPalmAlign = palmAlignCount > 0 ? palmAlignSum / palmAlignCount : undefined;
    const avgPalmUp = palmUpCount > 0 ? palmUpSum / palmUpCount : undefined;

    const sideResult = this.strokeSideAt(
      contactFrame,
      prepFrame,
      referenceShoulderWidth,
      travel,
      avgPalmAlign,
      ballOffsetRightMeters,
    );

    // Measure contact speed & displacement across forward window
    const nbPrev = contactIdx > 0 ? searchPool[contactIdx - 1] : null;
    const nbNext = contactIdx + 1 < searchPool.length ? searchPool[contactIdx + 1] : null;
    const nb = nbNext && (nbNext.speed ?? 0) >= (nbPrev?.speed ?? 0) ? nbNext : nbPrev;
    const contactSpeed =
      contactFrame.speed !== undefined
        ? nb && nb.speed !== undefined
          ? (contactFrame.speed + nb.speed) * 0.5
          : contactFrame.speed
        : travel?.speed ?? 0;

    const dtWin = Math.max(0.02, (contactFrame.time - prepFrame.time) / 1000);
    const dispWin = Math.hypot(contactFrame.x - prepFrame.x, contactFrame.y - prepFrame.y);
    const swingSpeed = contactSpeed > 0 ? contactSpeed : dispWin / dtWin;
    const power = clamp(swingSpeed / 3.2, 0.18, 1.0);

    // Exact Tennis-Game-Spec spin classification
    const yRange = spinMotion?.yRange ?? 0;
    const horizontalRange = spinMotion?.horizontalRange ?? 0;
    let motionSpin = classifyWristSpinMotion({
      dyTotal: spinMotion?.dyTotal ?? 0,
      yRange,
      horizontalRange,
      contactDx: spinMotion?.contactDx ?? 0,
      contactDy: spinMotion?.contactDy ?? 0,
    });
    if (isHighToLevel) {
      motionSpin = { ...motionSpin, family: 'slice', pathAngle: -14 };
    }

    const contactPronation = contactFrame.pronationDeg;
    let pathAngle: number;
    let spinSource: 'motion' | 'pronation' | 'palmUp' | 'softTouch' = 'motion';
    const angleMag = Math.min(20, yRange * 80 * motionSpin.verticality);

    if (motionSpin.family === 'slice') {
      pathAngle = motionSpin.pathAngle as number;
      spinSource = 'motion';
    } else if (motionSpin.family === 'topspin') {
      pathAngle = motionSpin.pathAngle as number;
      spinSource = 'motion';
    } else if (contactPronation !== undefined && contactPronation >= 25) {
      pathAngle = Math.min(16, 13 + (contactPronation - 25) * 0.15);
      spinSource = 'pronation';
    } else if (contactPronation !== undefined && contactPronation <= -30) {
      pathAngle = -Math.min(20, 12 + (-contactPronation - 30) * 0.2);
      spinSource = 'pronation';
    } else if (avgPalmUp !== undefined && avgPalmUp > 0.45) {
      pathAngle = -12;
      spinSource = 'palmUp';
    } else {
      pathAngle = Math.max(8, angleMag * 0.6);
    }

    let shotType: HumanShotType;
    let rotation: number;
    const softTouch =
      isSoftTouchStroke(travel?.speed ?? null, swingSpeed) ||
      (swingSpeed < 0.72 && dispWin < 0.22);

    if (motionSpin.family === 'slice' || isHighToLevel || pathAngle <= -10) {
      if (softTouch && dispWin < 0.22) {
        shotType = 'dropshot';
        rotation = -0.4;
        spinSource = 'softTouch';
      } else {
        shotType = 'slice';
        rotation = clamp(pathAngle / 22, -1, -0.25);
      }
    } else if (softTouch) {
      shotType = 'dropshot';
      rotation = -0.3;
      spinSource = 'softTouch';
    } else {
      shotType = 'topspin';
      rotation = clamp(Math.max(0.22, pathAngle / 20), 0.22, 1);
    }

    const contactAim = wristPositionToCourtAim({
      wristX: contactFrame.x,
      shoulderMidX: contactFrame.shoulderMidX,
      shoulderWidth: referenceShoulderWidth,
      cameraSign: contactFrame.cameraSign,
    });
    const angle = clamp(
      travel?.aim !== undefined && Math.abs(travel.aim) > 0.03
        ? contactAim !== null
          ? travel.aim * 0.65 + contactAim * 0.35
          : travel.aim
        : contactAim ?? 0,
      -1,
      1,
    );

    const playerX =
      ((contactFrame.shoulderMidX - contactFrame.x) * contactFrame.cameraSign) /
      referenceShoulderWidth;
    const armX = clamp(playerX / 0.65, -1, 1);
    const armZone: ArmZone = armX >= 0.22 ? 'right' : armX <= -0.22 ? 'left' : 'center';

    const confidence = clamp(
      0.66 + Math.abs(sideResult.score) * 0.16 + (spinMotion ? 0.12 : 0),
      0.58,
      0.97,
    );

    return {
      timestampMs: tEndCam,
      contactCaptureMs: contactFrame.time,
      wing: sideResult.side,
      wingScore: sideResult.score,
      wingSource: sideResult.source,
      shotType,
      spinSource,
      pathAngleDeg: pathAngle,
      power,
      rotation,
      angle,
      confidence,
      swingSpeed,
      armZone,
      armX,
    };
  }

  private getLookbackDisplacement(forwardStroke = false): number {
    const curIdx = (this.writeIdx - 1 + BUFFER_SIZE) % BUFFER_SIZE;
    const lookback = Math.min(LOOKBACK_FRAMES, this.frameCount - 1);
    const oldIdx = (this.writeIdx - 1 - lookback + BUFFER_SIZE) % BUFFER_SIZE;
    const cur = this.buffer[curIdx];
    const old = this.buffer[oldIdx];
    if (!cur || !old) return 0;
    const bodyMeasured = cur.shoulderMidY !== undefined && old.shoulderMidY !== undefined;
    const dx = cur.x - old.x - (bodyMeasured ? cur.shoulderMidX - old.shoulderMidX : 0);
    const dy = cur.y - old.y - (bodyMeasured ? cur.shoulderMidY! - old.shoulderMidY! : 0);
    let width = 0;
    for (let i = 0; i <= lookback; i++) {
      width = Math.max(
        width,
        this.buffer[(this.writeIdx - 1 - i + BUFFER_SIZE) % BUFFER_SIZE]?.shoulderWidth ?? 0,
      );
    }
    const scale = width >= 0.035 ? Math.min(2, 0.2 / width) : 1;
    const forward =
      forwardStroke && cur.shoulderMidZ !== undefined && old.shoulderMidZ !== undefined
        ? Math.max(0, old.z - old.shoulderMidZ - (cur.z - cur.shoulderMidZ))
        : 0;
    return Math.hypot(dx, dy, forward) * scale;
  }

  /**
   * Find the peak-wrist-speed frame in the lookback window (contact instant),
   * refine with quadratic sub-frame interpolation, and NLERP the face normal.
   */
  private resolveContactFaceNormal(): { x: number; y: number; z: number } | null {
    let peakIdx = -1;
    let peakSpeedVal = -1;
    const lb = Math.min(LOOKBACK_FRAMES, this.frameCount - 1);
    for (let i = 0; i < lb; i++) {
      const idx = (this.writeIdx - 1 - i + BUFFER_SIZE) % BUFFER_SIZE;
      const s = this.buffer[idx];
      if (!s || s.speed === undefined) continue;
      if (s.speed > peakSpeedVal) {
        peakSpeedVal = s.speed;
        peakIdx = idx;
      }
    }
    this.lastContactFrameIdx = peakIdx;
    this.lastContactSubFrameFrac = 0;
    if (peakIdx >= 0) {
      this.lastContactCaptureTime = this.buffer[peakIdx]?.time ?? this.lastContactCaptureTime;
    }
    if (peakIdx < 0 || peakSpeedVal < 0.4) return null;
    const peak = this.buffer[peakIdx];
    if (!peak || peak.faceNormalX === undefined) return null;

    const prevIdx = (peakIdx - 1 + BUFFER_SIZE) % BUFFER_SIZE;
    const nextIdx = (peakIdx + 1) % BUFFER_SIZE;
    const before = this.buffer[prevIdx];
    const after = this.buffer[nextIdx];
    const prev =
      before && before.time < peak.time && peak.time - before.time <= 200 ? before : null;
    const next =
      after && after.time > peak.time && after.time - peak.time <= 200 ? after : null;
    let frac = 0;
    if (prev && next && prev.speed !== undefined && next.speed !== undefined) {
      const denom = prev.speed - 2 * peakSpeedVal + next.speed;
      if (Math.abs(denom) > 1e-5) {
        frac = (0.5 * (prev.speed - next.speed)) / denom;
        frac = Math.max(-0.5, Math.min(0.5, frac));
      }
    }
    this.lastContactSubFrameFrac = frac;
    if (frac > 0 && next) {
      this.lastContactCaptureTime = peak.time + (next.time - peak.time) * frac;
    } else if (frac < 0 && prev) {
      this.lastContactCaptureTime = peak.time + (peak.time - prev.time) * frac;
    }

    const lerp = (a: number, b: number, t: number) => a * (1 - t) + b * t;
    const nl = (
      px: number,
      py: number,
      pz: number,
      qx: number,
      qy: number,
      qz: number,
      t: number,
    ) => {
      const rx = lerp(px, qx, t);
      const ry = lerp(py, qy, t);
      const rz = lerp(pz, qz, t);
      const m = Math.sqrt(rx * rx + ry * ry + rz * rz);
      return m > 0 ? { x: rx / m, y: ry / m, z: rz / m } : { x: px, y: py, z: pz };
    };
    if (frac > 0 && next && next.faceNormalX !== undefined) {
      return nl(
        peak.faceNormalX!,
        peak.faceNormalY!,
        peak.faceNormalZ!,
        next.faceNormalX,
        next.faceNormalY!,
        next.faceNormalZ!,
        frac,
      );
    } else if (frac < 0 && prev && prev.faceNormalX !== undefined) {
      return nl(
        prev.faceNormalX,
        prev.faceNormalY!,
        prev.faceNormalZ!,
        peak.faceNormalX!,
        peak.faceNormalY!,
        peak.faceNormalZ!,
        1 + frac,
      );
    }
    return { x: peak.faceNormalX!, y: peak.faceNormalY!, z: peak.faceNormalZ! };
  }

  private contactNeighbour(): WristSnapshot | null {
    if (this.lastContactFrameIdx < 0) return null;
    const peak = this.buffer[this.lastContactFrameIdx];
    if (!peak) return null;
    const direction = this.lastContactSubFrameFrac > 0 ? 1 : -1;
    const neighbour =
      this.buffer[(this.lastContactFrameIdx + direction + BUFFER_SIZE) % BUFFER_SIZE];
    if (!neighbour) return null;
    const elapsed = (neighbour.time - peak.time) * direction;
    return elapsed > 0 && elapsed <= 200 ? neighbour : null;
  }

  private strokeSideAt(
    contactFrame: WristSnapshot,
    old: WristSnapshot,
    referenceShoulderWidth: number,
    travel: ContactTravelMeasurement | null,
    palmAlignment: number | undefined = contactFrame.palmAlignment,
    ballOffsetRightMeters?: number,
  ): StrokeSideResult {
    const handSign = this.handedness === 'right' ? 1 : -1;
    const bodyLateral = (frame: WristSnapshot): number | undefined =>
      referenceShoulderWidth > 0.01
        ? ((frame.x - frame.shoulderMidX) * this.cameraSign * handSign) / referenceShoulderWidth
        : undefined;
    const ballLateral =
      typeof ballOffsetRightMeters === 'number' && Number.isFinite(ballOffsetRightMeters)
        ? -ballOffsetRightMeters * handSign
        : undefined;
    return classifyStrokeSide({
      contactLateral: bodyLateral(contactFrame),
      startLateral: bodyLateral(old),
      handTravel:
        referenceShoulderWidth > 0.01
          ? ((contactFrame.x - old.x) * this.cameraSign * handSign) / referenceShoulderWidth
          : undefined,
      palmAlignment,
      ballLateral,
      measuredContactMotion: travel !== null,
    });
  }

  private classifyAndFire(timestamp: number): DetectedWebcamSwing | null {
    const curIdx = (this.writeIdx - 1 + BUFFER_SIZE) % BUFFER_SIZE;
    const lookback = Math.min(LOOKBACK_FRAMES, this.frameCount - 1);
    const oldIdx = (this.writeIdx - 1 - lookback + BUFFER_SIZE) % BUFFER_SIZE;

    const cur = this.buffer[curIdx];
    const old = this.buffer[oldIdx];
    if (!cur || !old) return null;

    this.lastContactCaptureTime = cur.time;

    const dt = (cur.time - old.time) / 1000;
    if (dt < 0.01) return null;

    const contactNormal = this.resolveContactFaceNormal();
    this.lastFaceNormalAtContact = contactNormal;

    if (this.lastContactFrameIdx >= 0) {
      const cf = this.buffer[this.lastContactFrameIdx];
      if (cf) this.lastContactHeight = cf.y;
    }

    const dxTotal = cur.x - old.x;
    const dyTotal = cur.y - old.y;
    const dist = Math.sqrt(dxTotal * dxTotal + dyTotal * dyTotal);

    const avgSwingSpeed = dist / dt;
    let contactSpeed = 0;
    if (this.lastContactFrameIdx >= 0) {
      const pk = this.buffer[this.lastContactFrameIdx];
      if (pk && pk.speed !== undefined) {
        const nb = this.contactNeighbour();
        contactSpeed = nb && nb.speed !== undefined ? (pk.speed + nb.speed) / 2 : pk.speed;
      }
    }
    const swingSpeed = contactSpeed > 0 ? contactSpeed : avgSwingSpeed;
    const rawPower = Math.min(1.0, swingSpeed / (contactSpeed > 0 ? 3.2 : 2.5));
    const power = clamp(rawPower, 0.18, 1.0);

    // ── 1. FOREHAND vs BACKHAND — dominant-hand contact geometry ──
    const handSign = this.handedness === 'right' ? 1 : -1;

    let palmAlignSum = 0;
    let palmAlignCount = 0;
    let palmUpSum = 0;
    let palmUpCount = 0;
    const PALM_WINDOW = 5;
    for (let i = 0; i < PALM_WINDOW; i++) {
      const idx = (this.writeIdx - 1 - i + BUFFER_SIZE) % BUFFER_SIZE;
      const s = this.buffer[idx];
      if (!s) continue;
      if (s.palmAlignment !== undefined) {
        palmAlignSum += s.palmAlignment;
        palmAlignCount++;
      }
      if (s.palmUpness !== undefined) {
        palmUpSum += s.palmUpness;
        palmUpCount++;
      }
    }
    const avgPalmAlign = palmAlignCount > 0 ? palmAlignSum / palmAlignCount : undefined;
    const avgPalmUp = palmUpCount > 0 ? palmUpSum / palmUpCount : undefined;

    let referenceShoulderWidth = 0;
    for (let i = 0; i <= lookback; i++) {
      const idx = (this.writeIdx - 1 - i + BUFFER_SIZE) % BUFFER_SIZE;
      referenceShoulderWidth = Math.max(
        referenceShoulderWidth,
        this.buffer[idx]?.shoulderWidth ?? 0,
      );
    }
    const contactFrame =
      this.lastContactFrameIdx >= 0 ? this.buffer[this.lastContactFrameIdx] ?? cur : cur;

    // Choose `prepFrame` within <= 420 ms of contactFrame so a prior swing from seconds ago
    // can never pollute `startLateral` or `handTravel`!
    let prepFrame = old;
    for (let i = 0; i <= lookback; i++) {
      const idx = (this.writeIdx - 1 - i + BUFFER_SIZE) % BUFFER_SIZE;
      const cand = this.buffer[idx];
      if (!cand) break;
      if (contactFrame.time - cand.time > 420) break;
      prepFrame = cand;
    }

    this.lastContactAimDirection = wristPositionToCourtAim({
      wristX: contactFrame.x,
      shoulderMidX: contactFrame.shoulderMidX,
      shoulderWidth: contactFrame.shoulderWidth === undefined ? 0 : referenceShoulderWidth,
      cameraSign: contactFrame.cameraSign,
    });

    const contactSamples: WristSnapshot[] = [];
    for (let i = Math.min(this.frameCount, BUFFER_SIZE) - 1; i >= 0; i--) {
      const sample = this.buffer[(this.writeIdx - 1 - i + BUFFER_SIZE) % BUFFER_SIZE];
      if (sample) contactSamples.push(sample);
    }
    const travel = measureContactTravel(contactSamples, contactFrame.time);
    this.lastContactMotionAim = travel?.aim ?? null;
    this.lastContactSwingSpeed = travel?.speed ?? null;

    const sideResult = this.strokeSideAt(
      contactFrame,
      prepFrame,
      referenceShoulderWidth,
      travel,
      avgPalmAlign,
      this.ballOffsetRightMeters,
    );
    this.lastStrokeSideSignals = sideResult.signals;
    this.lastContactPlacement = shoulderPlacement(travel, sideResult.side, this.handedness);

    // ── 2. AIM DIRECTION ──
    const cappedDx = Math.max(-0.35, Math.min(0.35, dxTotal));
    const normalizedDx = cappedDx * this.cameraSign * handSign;
    const AIM_DEAD_ZONE = 0.02;
    const absDx = Math.abs(normalizedDx);
    let direction: number;
    if (absDx < AIM_DEAD_ZONE) {
      direction = 0;
    } else {
      const t = Math.min(1, (absDx - AIM_DEAD_ZONE) / (AIM_MAX_DX - AIM_DEAD_ZONE));
      direction = -t * Math.sign(normalizedDx) * AIM_MAX;
    }

    const courtAim = clamp(
      this.lastContactMotionAim !== null && Math.abs(this.lastContactMotionAim) > 0.03
        ? this.lastContactAimDirection !== null
          ? this.lastContactMotionAim * 0.65 + this.lastContactAimDirection * 0.35
          : this.lastContactMotionAim
        : this.lastContactAimDirection ?? this.liveAimDirection ?? direction,
      -1,
      1,
    );

    // ── 3. SPIN TYPE — hand path primary, face angle secondary ──
    const spinMotion = measureContactSpin(contactSamples, contactFrame.time);
    this.lastContactSpinMeasured = spinMotion !== null;
    const yRange = spinMotion?.yRange ?? 0;
    const horizontalRange = spinMotion?.horizontalRange ?? 0;
    let motionSpin = classifyWristSpinMotion({
      dyTotal: spinMotion?.dyTotal ?? 0,
      yRange,
      horizontalRange,
      contactDx: spinMotion?.contactDx ?? 0,
      contactDy: spinMotion?.contactDy ?? 0,
    });
    const isHighToLevelSlice = highToLevelSlice(contactSamples, contactFrame.time);
    if (isHighToLevelSlice) {
      motionSpin = { ...motionSpin, family: 'slice', pathAngle: -14 };
    }
    const verticality = motionSpin.verticality;

    let contactPronation: number | undefined;
    if (this.lastContactFrameIdx >= 0) {
      const pk = this.buffer[this.lastContactFrameIdx];
      if (pk && pk.pronationDeg !== undefined) {
        const nb = this.contactNeighbour();
        contactPronation =
          nb && nb.pronationDeg !== undefined
            ? (pk.pronationDeg + nb.pronationDeg) / 2
            : pk.pronationDeg;
      }
    }

    let pathAngle: number;
    let spinSource: 'pronation' | 'motion' | 'palmUp' | 'softTouch' = 'motion';
    const angleMag = Math.min(20, yRange * 80 * verticality);
    if (motionSpin.family === 'slice') {
      pathAngle = motionSpin.pathAngle as number;
      spinSource = 'motion';
    } else if (motionSpin.family === 'topspin') {
      pathAngle = motionSpin.pathAngle as number;
      spinSource = 'motion';
    } else if (contactPronation !== undefined && contactPronation >= 25) {
      pathAngle = Math.min(16, 13 + (contactPronation - 25) * 0.15);
      spinSource = 'pronation';
    } else if (contactPronation !== undefined && contactPronation <= -30) {
      pathAngle = -Math.min(20, 12 + (-contactPronation - 30) * 0.2);
      spinSource = 'pronation';
    } else if (
      contactPronation !== undefined &&
      contactPronation >= -10 &&
      contactPronation <= 15 &&
      horizontalRange > 0.12
    ) {
      pathAngle = 2;
      spinSource = 'pronation';
    } else if (yRange < 0.05 && horizontalRange > 0.12) {
      pathAngle = 2;
      spinSource = 'motion';
    } else if (avgPalmUp !== undefined && avgPalmUp > 0.45) {
      pathAngle = -12;
      spinSource = 'palmUp';
    } else {
      pathAngle = Math.max(8, angleMag * 0.6);
      spinSource = 'motion';
    }

    // Wrist flexion blend at contact (non-slice shots only)
    let contactFlexion: number | undefined;
    if (this.lastContactFrameIdx >= 0) {
      const pk = this.buffer[this.lastContactFrameIdx];
      if (pk && pk.flexionDeg !== undefined) contactFlexion = pk.flexionDeg;
    }
    if (contactFlexion !== undefined && pathAngle > 0) {
      const wasTopspin = pathAngle > 12;
      const flexTarget = Math.max(2, Math.min(14, 2 + (180 - contactFlexion) * 0.2));
      pathAngle = pathAngle * 0.7 + flexTarget * 0.3;
      if (wasTopspin) pathAngle = Math.max(pathAngle, 12.5);
    }

    let brushFactor = Math.min(0.7, (Math.abs(pathAngle) / 25) * 0.6);

    // Grip nudge (refines spin within family without overturning slice/topspin)
    if (this.lastGrip && this.lastGrip !== 'eastern') {
      const wasSlice = pathAngle < -10;
      const wasTopspin = pathAngle > 12;
      if (this.lastGrip === 'continental') {
        pathAngle -= 4;
        brushFactor = Math.min(0.8, brushFactor + 0.1);
      } else if (this.lastGrip === 'semi-western') {
        pathAngle += 3;
        brushFactor = Math.min(0.8, brushFactor + 0.06);
      } else if (this.lastGrip === 'western') {
        pathAngle += 5;
        brushFactor = Math.min(0.85, brushFactor + 0.1);
      }
      if (wasSlice) {
        pathAngle = Math.min(pathAngle, -10.5);
      } else if (wasTopspin) {
        pathAngle = Math.max(pathAngle, 12.5);
      }
    }

    // ── 4. Map to our HumanShotType ('topspin' | 'slice' | 'dropshot') ──
    const forwardStroke =
      travel?.velocityForward !== null && travel?.velocityForward !== undefined;
    const displacement = this.getLookbackDisplacement(forwardStroke);

    let shotType: HumanShotType;
    let rotation: number;
    if (motionSpin.family === 'slice' || isHighToLevelSlice || pathAngle <= -10) {
      if (swingSpeed < 0.72 && displacement < 0.24) {
        shotType = 'dropshot';
        rotation = -0.4;
        spinSource = 'softTouch';
      } else {
        shotType = 'slice';
        rotation = clamp(pathAngle / 22, -1, -0.25);
      }
    } else if (
      isSoftTouchStroke(travel?.speed ?? null, swingSpeed) ||
      (swingSpeed < 0.65 && Math.abs(pathAngle) < 12)
    ) {
      shotType = 'dropshot';
      rotation = -0.3;
      spinSource = 'softTouch';
    } else {
      shotType = 'topspin';
      rotation = clamp(Math.max(0.22, pathAngle / 20), 0.22, 1);
    }

    // ── 5. Skill scores (shoulder rotation + elbow extension) ──
    let shoulderRotation = 0;
    let elbowExtension = 0;
    if (cur.shoulderWidth !== undefined && old.shoulderWidth !== undefined) {
      let maxWidth = 0;
      for (let i = 0; i < LOOKBACK_FRAMES; i++) {
        const idx = (this.writeIdx - 1 - i + BUFFER_SIZE) % BUFFER_SIZE;
        const s = this.buffer[idx];
        if (s?.shoulderWidth !== undefined && s.shoulderWidth > maxWidth) {
          maxWidth = s.shoulderWidth;
        }
      }
      const contactWidth = cur.shoulderWidth;
      if (maxWidth > 0.02) {
        const ratio = Math.min(1, contactWidth / maxWidth);
        const rotRad = Math.acos(ratio);
        shoulderRotation = Math.min(1, rotRad / (Math.PI / 2));
      }
    }

    if (cur.shoulderX !== undefined && cur.elbowX !== undefined) {
      const ax = cur.elbowX - cur.shoulderX;
      const ay = cur.elbowY! - cur.shoulderY!;
      const az = cur.elbowZ! - cur.shoulderZ!;
      const bx = cur.x - cur.elbowX;
      const by = cur.y - cur.elbowY!;
      const bz = cur.z - cur.elbowZ!;
      const magA = Math.sqrt(ax * ax + ay * ay + az * az);
      const magB = Math.sqrt(bx * bx + by * by + bz * bz);
      if (magA > 0.001 && magB > 0.001) {
        const dotAB = (ax * bx + ay * by + az * bz) / (magA * magB);
        const clamped = Math.max(-1, Math.min(1, dotAB));
        const angle = Math.acos(clamped);
        elbowExtension = Math.max(0, Math.min(1, 1 - angle / (Math.PI / 2)));
      }
    }
    const powerMultiplier = 0.6 + 0.4 * shoulderRotation + 0.4 * elbowExtension;

    let shoulderAim = 0;
    const domShoulderField = this.handedness === 'right' ? 'rShoulderX' : 'lShoulderX';
    const nonDomShoulderField = this.handedness === 'right' ? 'lShoulderX' : 'rShoulderX';
    if (
      cur[domShoulderField] !== undefined &&
      cur[nonDomShoulderField] !== undefined &&
      old[domShoulderField] !== undefined &&
      old[nonDomShoulderField] !== undefined
    ) {
      const curOffset = cur[domShoulderField]! - cur[nonDomShoulderField]!;
      const oldOffset = old[domShoulderField]! - old[nonDomShoulderField]!;
      const shoulderDelta = curOffset - oldOffset;
      const SHOULDER_DEAD = 0.01;
      const SHOULDER_FULL = 0.06;
      if (Math.abs(shoulderDelta) > SHOULDER_DEAD) {
        const t = Math.min(
          1,
          (Math.abs(shoulderDelta) - SHOULDER_DEAD) / (SHOULDER_FULL - SHOULDER_DEAD),
        );
        shoulderAim = t * Math.sign(shoulderDelta) * this.cameraSign;
      }
    }

    // ── 6. Contact armX & armZone ──
    const safeWidth = Math.max(0.08, referenceShoulderWidth || contactFrame.shoulderWidth || 0.2);
    const wristPlayerX =
      ((contactFrame.shoulderMidX - contactFrame.x) * contactFrame.cameraSign) / safeWidth;
    const armX = clamp(wristPlayerX / 0.65, -1, 1);
    const armZone: ArmZone = armX >= 0.22 ? 'right' : armX <= -0.22 ? 'left' : 'center';

    // ── 7. Confidence (0.55..0.97) ──
    const wingConf = Math.abs(sideResult.score);
    const spinConf =
      motionSpin.family !== 'ambiguous'
        ? 0.92
        : spinSource === 'softTouch'
          ? 0.85
          : spinSource === 'pronation'
            ? 0.78
            : 0.68;
    const confidence = clamp(0.55 + 0.22 * wingConf + 0.2 * spinConf, 0.55, 0.97);

    this.lastStrokeSide = sideResult.side;
    this.lastStrokeSideScore = sideResult.score;
    this.lastStrokeSideSource = sideResult.source;
    this.lastDetectedTime = timestamp;
    this.lastSwingPower = power;
    this.lastSwingSpeed = swingSpeed;
    this.lastSwingDirection = direction;
    this.lastShotType = shotType;
    this.lastPathAngle = pathAngle;
    this.lastBrushFactor = brushFactor;
    this.lastShoulderRotation = shoulderRotation;
    this.lastElbowExtension = elbowExtension;
    this.lastPowerMultiplier = powerMultiplier;
    this.lastShoulderAim = shoulderAim;
    this.lastPalmAlign = avgPalmAlign;

    const detected: DetectedWebcamSwing = {
      timestampMs: timestamp,
      contactCaptureMs: this.lastContactCaptureTime,
      wing: sideResult.side,
      wingScore: sideResult.score,
      wingSource: sideResult.source,
      shotType,
      spinSource,
      pathAngleDeg: pathAngle,
      power,
      rotation,
      angle: courtAim,
      confidence,
      swingSpeed,
      armZone,
      armX,
    };
    this.lastDetectedSwing = detected;
    return detected;
  }
}
