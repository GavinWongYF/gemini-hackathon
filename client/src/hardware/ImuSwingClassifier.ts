import type {
  CalibrationPhase,
  GyroReading,
  HumanShotType,
  RawImuSample,
  StrokeWing,
} from '@shared/contracts';
import { MadgwickAhrs, type Vec3 } from './MadgwickAhrs';
import { OneEuroFilter } from './OneEuroFilter';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const G_TO_MPS2 = 9.81;

export interface ImuClassifierConfig {
  /** True 3D world-frame linear accel (g) for a normal/fast swing */
  armAccelG: number;
  /** Bias-corrected gyro rate (deg/s) for a normal/fast swing */
  armGyroDps: number;
  /** Minimum 3D linear accel (g) for a deliberate soft dropshot (blocks casual hand motion) */
  dropAccelG: number;
  /** Minimum gyro rate (deg/s) for a deliberate soft dropshot (low enough for soft BH dropshots) */
  dropGyroDps: number;
  /** Minimum leaky 3D swing speed (m/s) for soft dropshot path */
  dropMinSpeedMps: number;
  /** Max linear G mapped to power = 1.0 */
  maxAccelG: number;
  /** Max gyro rate (deg/s) mapped to power = 1.0 */
  maxGyroDps: number;
  /** Refractory cooldown after a completed swing (ms) */
  cooldownMs: number;
  /** Power cutoff below which a soft carve/touch is classified as a dropshot */
  dropshotPowerMax: number;
  /** Spin/vertical score below this classifies as slice; above classifies as topspin */
  sliceThreshold: number;
  /** Invert horizontal aim angle if needed */
  invertAngle: boolean;
  /** Invert topspin/slice axis if needed */
  invertRotation: boolean;
}

export const DEFAULT_IMU_CONFIG: ImuClassifierConfig = {
  armAccelG: 1.15,
  armGyroDps: 165,
  dropAccelG: 0.62,
  dropGyroDps: 85,
  dropMinSpeedMps: 0.20,
  maxAccelG: 3.4,
  maxGyroDps: 500,
  cooldownMs: 650,
  dropshotPowerMax: 0.46,
  sliceThreshold: -0.12,
  invertAngle: false,
  invertRotation: false,
};

export interface EarlySwingGuess {
  swingStartMs: number;
  nowMs: number;
  initialSpeed: number;
  imuBackswing: number;
  accelSlopeGps: number;
  faceNormal: Vec3;
  vLive: Vec3;
  peakAccelG: number;
  peakGyroDps: number;
}

export interface RawClassifiedSwing {
  swingStartMs: number;
  /** Exact timestamp of peak 3D swing speed (contact instant — BEFORE follow-through!) */
  swingPeakMs: number;
  swingEndMs: number;
  /** 3D world-frame velocity vector at peak contact (m/s; +Z = up, -Z = down) */
  vContact: Vec3;
  /** Peak 3D swing speed at contact (m/s) */
  swingSpeedMps: number;
  /** 3D world-frame M5 screen normal at peak contact */
  faceNormalAtPeak: Vec3;
  /** Signed IMU lateral swing direction (+ = right, - = left in world frame) */
  worldYawAccumDeg: number;
  power: number;
  angle: number;
  peakAccelG: number;
  peakGyroDps: number;
  shotType: HumanShotType;
  rotation: number;
  confidence: number;
}

export interface ResolvedShotResult {
  shotType: HumanShotType;
  power: number;
  rotation: number;
  angle: number;
  confidence: number;
}

interface RingEntry {
  t: number;
  dtSec: number;
  aWorld: Vec3;
  aMag: number;
  faceNormal: Vec3;
  gyroDps: number;
}

type SwingState = 'idle' | 'armed' | 'cooldown';

const ZERO_SAMPLES_REQUIRED = 25; // ~0.25s at 100 Hz
const RING_WINDOW_MS = 140;

/**
 * Universal 6-DOF Madgwick Quaternion + 3D World-Frame Velocity Tennis Swing Classifier.
 *
 * Designed to work out-of-the-box for EVERY player (forehand & backhand, all 3 shots):
 *  1. 6-DOF Madgwick AHRS aligned to player's ZERO pose (M5 horizontal across body):
 *     - True 3D gravity subtraction (`worldLinearAccel = R(q)*a_body - [0,0,restMag]`)
 *       eliminates gravity cancellation on downward slice chops & backhand dropshots!
 *     - Dynamic accel gating freezes Madgwick tilt correction during high-G swings so
 *       linear swing acceleration never corrupts racket face orientation.
 *  2. Zero-drift 3D velocity integration (`v_world = ∫ a_world * 9.81 dt`) strictly up to
 *     the peak 3D speed instant (`swingPeakMs`) — never corrupted by follow-through!
 *  3. Grip & Wing-Invariant face openness (`hitSign * n_contact.z`) + 3D vertical velocity
 *     (`vContact.z`) + webcam vertical arm travel (`deltaArmY` measured to `swingPeakMs`) +
 *     `peakWristSpeed` cleanly separates all 6 combos (`FH/BH` × `topspin/slice/dropshot`).
 */
export class ImuSwingClassifier {
  private config: ImuClassifierConfig = { ...DEFAULT_IMU_CONFIG };
  private ahrs = new MadgwickAhrs();

  private phase: CalibrationPhase = 'needs_zero';
  private zeroCount = 0;
  private zeroAccSumX = 0;
  private zeroAccSumY = 0;
  private zeroAccSumZ = 0;
  private zeroGyrSumX = 0;
  private zeroGyrSumY = 0;
  private zeroGyrSumZ = 0;

  // Calibrated gyro zero-bias (deg/s)
  private gyroBiasX = 0;
  private gyroBiasY = 0;
  private gyroBiasZ = 0;
  private prevAx = 0;
  private prevAy = 0;
  private prevAz = 1;

  // Live leaky 3D velocity (m/s) for soft-swing speed gating & anti-takeback
  private vLiveX = 0;
  private vLiveY = 0;
  private vLiveZ = 0;
  private stillSinceMs: number | null = null;

  // High-pass world-frame accel bias tracker + rotation-proof scalar magnitude baseline
  private aBiasX = 0;
  private aBiasY = 0;
  private aBiasZ = 0;
  private localAccelMag = 1.0;

  // Integrated world-Z yaw relative to ZERO (CCW/+ = left, CW/- = right)
  private relYawDeg = 0;

  // 140 ms pre-trigger ring buffer for exact onset rewind & trapezoid integration
  private ring: RingEntry[] = [];

  private lastSampleMs: number | null = null;
  private angleFilter = new OneEuroFilter(4.5, 0.35, 1.0);
  private rotFilter = new OneEuroFilter(4.5, 0.35, 1.0);

  // Swing state machine
  private state: SwingState = 'idle';
  private swingStartMs = 0;
  private cooldownUntilMs = 0;
  private cooldownMaxUntilMs = 0;
  private quietSinceMs: number | null = null;
  private dropPulseSinceMs: number | null = null;

  // Active swing integration state (frozen at peak 3D speed instant `t_peak`)
  private vIntX = 0;
  private vIntY = 0;
  private vIntZ = 0;
  private prevIntAx = 0;
  private prevIntAy = 0;
  private prevIntAz = 0;
  private peakSpeedMps = 0;
  private swingPeakMs = 0;
  private vContact: Vec3 = { x: 0, y: 0, z: 0 };
  private faceNormalAtPeak: Vec3 = { x: 0, y: 1, z: 0 };
  private peakAccelG = 0;
  private peakGyroDps = 0;
  private peakEnergy = 0;
  private swingYawAccumDeg = 0;
  private armAccelAtStart = 0;

  private pendingEarlyGuess: EarlySwingGuess | null = null;
  private earlyGuessEmitted = false;

  private latestReading: GyroReading = {
    power: 0,
    rotation: 0,
    angle: 0,
    linearAccelG: 0,
    gyroRateDps: 0,
    rawPitchDeg: 0,
    rawRollDeg: 0,
    rawYawDeg: 0,
  };

  private lastClassifiedShot: HumanShotType = 'topspin';

  getConfig(): ImuClassifierConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<ImuClassifierConfig>) {
    this.config = { ...this.config, ...partial };
  }

  getCalibrationPhase(): CalibrationPhase {
    return this.phase;
  }

  getCalibrationProgress(): number {
    if (this.phase === 'ready') return 1;
    if (this.phase === 'needs_zero') return 0;
    return clamp(this.zeroCount / ZERO_SAMPLES_REQUIRED, 0, 1);
  }

  startZeroing() {
    this.phase = 'zeroing';
    this.zeroCount = 0;
    this.zeroAccSumX = 0;
    this.zeroAccSumY = 0;
    this.zeroAccSumZ = 0;
    this.zeroGyrSumX = 0;
    this.zeroGyrSumY = 0;
    this.zeroGyrSumZ = 0;

    this.state = 'idle';
    this.dropPulseSinceMs = null;
    this.quietSinceMs = null;
    this.stillSinceMs = null;
    this.vLiveX = 0;
    this.vLiveY = 0;
    this.vLiveZ = 0;
    this.aBiasX = 0;
    this.aBiasY = 0;
    this.aBiasZ = 0;
    this.relYawDeg = 0;
    this.ring = [];
    this.pendingEarlyGuess = null;
    this.earlyGuessEmitted = false;
    this.angleFilter.reset(0);
    this.rotFilter.reset(0);
    this.latestReading.angle = 0;
    this.latestReading.rotation = 0;
    this.latestReading.power = 0;
  }

  recenter() {
    this.startZeroing();
  }

  getLatestReading(): GyroReading {
    return this.latestReading;
  }

  getLastShotType(): HumanShotType {
    return this.lastClassifiedShot;
  }

  consumeEarlySwingGuess(): EarlySwingGuess | null {
    const g = this.pendingEarlyGuess;
    this.pendingEarlyGuess = null;
    return g;
  }

  /**
   * Pure early-swing guess (at ~25ms into swing) for 3D avatar anticipation.
   * Never mutates `lastClassifiedShot`, and avoids the low-speed dropshot bias
   * while acceleration is still ramping!
   */
  resolveEarlyGuess(
    early: EarlySwingGuess,
    wing: StrokeWing,
    backswing: number,
    webcamDeltaArmY = 0,
    hasWebcamData = false,
  ): { shotType: HumanShotType; confidence: number } {
    const wingFaceSign = wing === 'backhand' ? -1 : 1;
    const effFaceOpen = wingFaceSign * early.faceNormal.z;

    // Only predict dropshot early if backswing is compact, face is open, AND accel isn't ramping hard
    if (backswing < 0.35 && effFaceOpen > 0.14 && early.accelSlopeGps < 12) {
      return { shotType: 'dropshot', confidence: 0.62 };
    }

    const vertCue = hasWebcamData
      ? clamp(webcamDeltaArmY / 0.1, -1, 1) * 0.5 + clamp(early.vLive.z / 1.2, -1, 1) * 0.5
      : clamp(early.vLive.z / 1.2, -1, 1);
    const faceCue = clamp(-effFaceOpen / 0.5, -1, 1);
    const score = vertCue * 0.65 + faceCue * 0.35;

    if (score < this.config.sliceThreshold) {
      return { shotType: 'slice', confidence: 0.64 };
    }
    return { shotType: 'topspin', confidence: 0.66 };
  }

  /**
   * Pure 6-combo (`FH/BH` × `topspin/slice/dropshot`) multi-cue shot classifier
   * using 3D contact velocity (`vContact`), grip-invariant face openness, and
   * peak-locked webcam kinematics (`deltaArmY`, `peakWristSpeed`).
   */
  resolveShot(
    swing: RawClassifiedSwing,
    wing: StrokeWing,
    webcamDeltaArmY = 0,
    hasWebcamData = false,
    peakWristSpeed = 0,
    commitAsLastShot = true,
  ): ResolvedShotResult {
    const rotSign = this.config.invertRotation ? -1 : 1;
    const yawSign = this.config.invertAngle ? -1 : 1;

    const v = swing.vContact;
    const n = swing.faceNormalAtPeak;
    const vHoriz = Math.hypot(v.x, v.y);

    // 1. Grip & wing-invariant face openness:
    //    Determine which side of the M5 (+Z screen or -Z back) is the hitting face
    //    by dotting screen normal with horizontal swing velocity; fall back to wing!
    let hitSign = wing === 'backhand' ? -1 : 1;
    if (vHoriz >= 0.35) {
      const faceDot = (n.x * v.x + n.y * v.y) / vHoriz;
      if (Math.abs(faceDot) >= 0.25) {
        hitSign = faceDot > 0 ? 1 : -1;
      }
    }
    // effFaceOpen > 0 => hitting face tilted UP toward sky (open / slice / dropshot)
    // effFaceOpen < 0 => hitting face tilted DOWN / vertical (closed / topspin)
    const effFaceOpen = clamp(hitSign * n.z, -1, 1);

    // 2. Unified BH-compensated power (backhands naturally have ~12% lower peak speed)
    const speedComp = swing.swingSpeedMps * (wing === 'backhand' ? 1.12 : 1.0);
    const vNorm = clamp(speedComp / 4.2, 0, 1);
    const aNorm = clamp(swing.peakAccelG / Math.max(0.5, this.config.maxAccelG), 0, 1);
    const gNorm = clamp(swing.peakGyroDps / Math.max(50, this.config.maxGyroDps), 0, 1);
    const power = clamp(0.45 * vNorm + 0.30 * aNorm + 0.25 * gNorm, 0.16, 1);

    // 3. Orthogonal spin cues (+ = topspin low->high, - = slice high->low)
    const imuPath = clamp(v.z / Math.max(0.55, 0.55 * vHoriz), -1, 1);
    const camVert = hasWebcamData ? clamp(webcamDeltaArmY / 0.11, -1, 1) : 0;
    const faceCue = clamp(-effFaceOpen / 0.5, -1, 1);

    const rawSpin =
      hasWebcamData && Math.abs(webcamDeltaArmY) > 0.025
        ? clamp(0.45 * imuPath + 0.35 * camVert + 0.20 * faceCue, -1, 1)
        : clamp(0.65 * imuPath + 0.35 * faceCue, -1, 1);
    const spinScore = rotSign * rawSpin;

    // 4. 6-Combo Decision Rules (cleanly separates FH/BH dropshots vs slices vs topspins!)
    const camSlowOk = !hasWebcamData || peakWristSpeed <= 0 || peakWristSpeed < 1.65;

    // Rule A: Ultra-soft touch dropshot (catches gentle FH & BH dropshots with any face angle)
    const isUltraSoftDrop =
      swing.swingSpeedMps < 1.25 && swing.peakGyroDps < 175 && camSlowOk;

    // Rule B: Controlled open/flat carve dropshot (real BH slices exceed 1.68 m/s or 210 deg/s)
    const isControlledDrop =
      swing.swingSpeedMps < 1.68 &&
      swing.peakGyroDps < 210 &&
      power <= this.config.dropshotPowerMax &&
      (effFaceOpen > 0.12 || spinScore <= 0.12);

    let shotType: HumanShotType;
    let rotation: number;
    let confidence: number;

    if (isUltraSoftDrop || isControlledDrop) {
      shotType = 'dropshot';
      rotation = clamp(-0.25 - 0.35 * Math.max(0, effFaceOpen), -0.65, -0.2);
      const speedMargin = clamp((1.68 - swing.swingSpeedMps) / 1.0, 0, 1);
      confidence = clamp(0.68 + speedMargin * 0.28, 0.62, 0.96);
    } else if (
      spinScore < this.config.sliceThreshold ||
      (v.z < -0.22 && effFaceOpen > 0.18)
    ) {
      shotType = 'slice';
      rotation = clamp(Math.min(-0.22, spinScore), -1, -0.22);
      confidence = clamp(
        0.64 + Math.abs(spinScore - this.config.sliceThreshold) * 0.42,
        0.58,
        0.97,
      );
    } else {
      shotType = 'topspin';
      rotation = clamp(Math.max(0.18, spinScore), 0.18, 1);
      confidence = clamp(
        0.64 + Math.abs(spinScore - this.config.sliceThreshold) * 0.42,
        0.58,
        0.97,
      );
    }

    // 5. World-frame aim angle (-1 left .. +1 right)
    const velDeg = (Math.atan2(v.x, Math.max(0.35, Math.abs(v.y) + 0.15)) * 180) / Math.PI;
    const hitNx = hitSign * n.x;
    const hitNy = hitSign * n.y;
    const faceDeg = (Math.atan2(hitNx, Math.max(0.25, Math.abs(hitNy) + 0.15)) * 180) / Math.PI;
    const wV = clamp((swing.swingSpeedMps - 0.5) / 1.5, 0.25, 0.65);
    const wF = 0.85 - wV;
    const yawAngle = clamp(-swing.worldYawAccumDeg / 45, -1, 1);

    const angle =
      yawSign *
      clamp(wV * clamp(velDeg / 42, -1, 1) + wF * clamp(faceDeg / 38, -1, 1) + 0.15 * yawAngle, -1, 1);

    if (commitAsLastShot) {
      this.lastClassifiedShot = shotType;
    }

    return { shotType, power, rotation, angle, confidence };
  }

  /**
   * Process one raw 100 Hz 6-axis M5Stack IMU sample.
   * Optional `isTakingBackCrossBody` flag from WebcamArmTracker vetoes soft-path
   * false triggers while the player is simply crossing their arm over to prepare a backhand.
   */
  ingest(
    sample: RawImuSample,
    nowMs = performance.now(),
    isTakingBackCrossBody = false,
  ): RawClassifiedSwing | null {
    const dtSec =
      this.lastSampleMs === null ? 0.01 : clamp((nowMs - this.lastSampleMs) / 1000, 0.002, 0.1);
    this.lastSampleMs = nowMs;

    if (sample.recenter) {
      this.startZeroing();
    }

    const accelDelta = Math.hypot(
      sample.ax - this.prevAx,
      sample.ay - this.prevAy,
      sample.az - this.prevAz,
    );
    this.prevAx = sample.ax;
    this.prevAy = sample.ay;
    this.prevAz = sample.az;

    // Step A: Sampling ZERO pose (~0.25s holding M5 horizontally across body)
    if (this.phase === 'zeroing') {
      this.zeroAccSumX += sample.ax;
      this.zeroAccSumY += sample.ay;
      this.zeroAccSumZ += sample.az;
      this.zeroGyrSumX += sample.gx;
      this.zeroGyrSumY += sample.gy;
      this.zeroGyrSumZ += sample.gz;
      this.zeroCount += 1;

      if (this.zeroCount >= ZERO_SAMPLES_REQUIRED) {
        const meanAx = this.zeroAccSumX / this.zeroCount;
        const meanAy = this.zeroAccSumY / this.zeroCount;
        const meanAz = this.zeroAccSumZ / this.zeroCount;

        this.ahrs.alignToZero(meanAx, meanAy, meanAz);
        this.localAccelMag = this.ahrs.getRestAccelMag();
        this.gyroBiasX = this.zeroGyrSumX / this.zeroCount;
        this.gyroBiasY = this.zeroGyrSumY / this.zeroCount;
        this.gyroBiasZ = this.zeroGyrSumZ / this.zeroCount;

        this.vLiveX = 0;
        this.vLiveY = 0;
        this.vLiveZ = 0;
        this.aBiasX = 0;
        this.aBiasY = 0;
        this.aBiasZ = 0;
        this.relYawDeg = 0;
        this.ring = [];
        this.angleFilter.reset(0);
        this.rotFilter.reset(0);
        this.phase = 'ready';
        this.state = 'idle';
      }
      return null;
    }

    // Step B: Locked until player presses ZERO
    if (this.phase === 'needs_zero') {
      const restMag = this.ahrs.getRestAccelMag();
      const mag = Math.hypot(sample.ax, sample.ay, sample.az);
      this.latestReading = {
        power: 0,
        rotation: 0,
        angle: 0,
        linearAccelG: Math.abs(mag - restMag),
        gyroRateDps: 0,
        rawPitchDeg: 0,
        rawRollDeg: 0,
        rawYawDeg: 0,
      };
      return null;
    }

    // Step C: ZEROED & READY TO PLAY (6-DOF Madgwick Quaternion AHRS)
    const gx = sample.gx - this.gyroBiasX;
    const gy = sample.gy - this.gyroBiasY;
    const gz = sample.gz - this.gyroBiasZ;

    const ahrsOut = this.ahrs.update(sample.ax, sample.ay, sample.az, gx, gy, gz, dtSec);
    const rawWorld = ahrsOut.worldLinearAccel;
    const gyroRateDps = Math.hypot(gx, gy, gz);
    const rawAccMag = Math.hypot(sample.ax, sample.ay, sample.az);

    // Track & remove anisotropic MPU6886 axis-scale DC offset (0.82g..1.20g across axes!)
    // Only updates when gyro is calm (< 65 deg/s) so crisp swings & dropshots are NEVER eaten!
    if (this.state !== 'armed' && gyroRateDps < 65) {
      const biasAlpha = 0.05;
      this.aBiasX += biasAlpha * (rawWorld.x - this.aBiasX);
      this.aBiasY += biasAlpha * (rawWorld.y - this.aBiasY);
      this.aBiasZ += biasAlpha * (rawWorld.z - this.aBiasZ);
      this.localAccelMag += biasAlpha * (rawAccMag - this.localAccelMag);
    }

    // Rotation-proof scalar dynamic G (0.00g during pure wrist twists even if gyro has scale error!)
    const scalarDynG = Math.abs(rawAccMag - this.localAccelMag);

    const aWorld: Vec3 = {
      x: rawWorld.x - this.aBiasX,
      y: rawWorld.y - this.aBiasY,
      z: rawWorld.z - this.aBiasZ,
    };
    const linAccelMag = Math.hypot(aWorld.x, aWorld.y, aWorld.z);

    // Slow online gyro bias tracking when genuinely stationary
    if (this.state === 'idle' && accelDelta < 0.05 && linAccelMag < 0.14 && gyroRateDps < 16) {
      const bAlpha = 0.02;
      this.gyroBiasX += bAlpha * (sample.gx - this.gyroBiasX);
      this.gyroBiasY += bAlpha * (sample.gy - this.gyroBiasY);
      this.gyroBiasZ += bAlpha * (sample.gz - this.gyroBiasZ);
    }

    // Maintain leaky 3D live velocity (decays cleanly when idle, zeroed when still)
    if (linAccelMag < 0.18 && gyroRateDps < 30) {
      if (this.stillSinceMs === null) this.stillSinceMs = nowMs;
      if (nowMs - this.stillSinceMs >= 35) {
        this.vLiveX = 0;
        this.vLiveY = 0;
        this.vLiveZ = 0;
      }
    } else {
      this.stillSinceMs = null;
      const decay = Math.exp(-dtSec / 0.16);
      this.vLiveX = this.vLiveX * decay + aWorld.x * G_TO_MPS2 * dtSec;
      this.vLiveY = this.vLiveY * decay + aWorld.y * G_TO_MPS2 * dtSec;
      this.vLiveZ = this.vLiveZ * decay + aWorld.z * G_TO_MPS2 * dtSec;
    }
    const liveSpeedMps = Math.hypot(this.vLiveX, this.vLiveY, this.vLiveZ);

    // Maintain 140 ms pre-trigger ring buffer
    this.ring.push({
      t: nowMs,
      dtSec,
      aWorld: { x: aWorld.x, y: aWorld.y, z: aWorld.z },
      aMag: linAccelMag,
      faceNormal: {
        x: ahrsOut.worldFaceNormal.x,
        y: ahrsOut.worldFaceNormal.y,
        z: ahrsOut.worldFaceNormal.z,
      },
      gyroDps: gyroRateDps,
    });
    while (this.ring.length > 0 && nowMs - this.ring[0].t > RING_WINDOW_MS) {
      this.ring.shift();
    }

    // World-vertical yaw integration (CCW/+ = left, CW/- = right)
    const worldYawDps = Math.abs(ahrsOut.worldGyro.z) > 4.0 ? ahrsOut.worldGyro.z : 0;
    this.relYawDeg = clamp(this.relYawDeg + worldYawDps * dtSec, -75, 75);
    if (this.state === 'idle' && linAccelMag < 0.18 && gyroRateDps < 15) {
      this.relYawDeg *= 1 - 0.45 * dtSec;
    }

    const yawSign = this.config.invertAngle ? 1 : -1;
    const rotSign = this.config.invertRotation ? -1 : 1;

    const filteredAngle = this.angleFilter.filter(clamp((yawSign * this.relYawDeg) / 45, -1, 1), nowMs);
    const filteredRotation = this.rotFilter.filter(
      clamp(rotSign * (-ahrsOut.worldFaceNormal.z * 1.5), -1, 1),
      nowMs,
    );
    const livePower = clamp(
      0.45 * clamp(liveSpeedMps / 4.2, 0, 1) +
        0.30 * clamp(linAccelMag / Math.max(0.5, this.config.maxAccelG), 0, 1) +
        0.25 * clamp(gyroRateDps / Math.max(50, this.config.maxGyroDps), 0, 1),
      0,
      1,
    );

    this.latestReading = {
      power: livePower,
      rotation: filteredRotation,
      angle: filteredAngle,
      linearAccelG: linAccelMag,
      gyroRateDps,
      rawPitchDeg: ahrsOut.faceTiltDeg,
      rawRollDeg: ahrsOut.faceTiltDeg,
      rawYawDeg: this.relYawDeg,
    };

    // Single-trigger-per-swing state machine (650ms cooldown + quiet exit + hard ceiling)
    if (this.state === 'cooldown') {
      const isQuiet = linAccelMag < 0.25 && gyroRateDps < 55;
      if (isQuiet) {
        if (this.quietSinceMs === null) this.quietSinceMs = nowMs;
      } else {
        this.quietSinceMs = null;
      }

      const quietUnlocked =
        nowMs >= this.cooldownUntilMs &&
        this.quietSinceMs !== null &&
        nowMs - this.quietSinceMs >= 90;
      const ceilingUnlocked = nowMs >= this.cooldownMaxUntilMs;

      if (quietUnlocked || ceilingUnlocked) {
        this.state = 'idle';
        this.quietSinceMs = null;
        this.dropPulseSinceMs = null;
      }
      return null;
    }

    const energy =
      linAccelMag / Math.max(0.2, this.config.armAccelG) +
      gyroRateDps / Math.max(20, this.config.armGyroDps);

    if (this.state === 'idle') {
      // Require REAL translational acceleration (`scalarDynG >= 0.28g`, immune to pure wrist twists!)
      // in addition to 3D world-frame accel + gyro so turning/adjusting grip NEVER false-triggers!
      const fastSwing =
        linAccelMag >= this.config.armAccelG &&
        scalarDynG >= 0.35 &&
        gyroRateDps >= this.config.armGyroDps;

      // Path 2: Deliberate soft dropshot (FH & BH) — requires vector accel, scalar translational
      // accel (>= 0.16g — 3x above pure wrist-twist noise, catches gentle forward dropshots!),
      // gyro, AND real 3D speed sustained >= 35ms.
      const deliberateDrop =
        !isTakingBackCrossBody &&
        linAccelMag >= this.config.dropAccelG &&
        scalarDynG >= 0.16 &&
        gyroRateDps >= this.config.dropGyroDps &&
        liveSpeedMps >= this.config.dropMinSpeedMps;

      let softSwingArmed = false;
      if (deliberateDrop) {
        if (this.dropPulseSinceMs === null) {
          this.dropPulseSinceMs = nowMs;
        } else if (nowMs - this.dropPulseSinceMs >= 35) {
          softSwingArmed = true;
        }
      } else {
        this.dropPulseSinceMs = null;
      }

      if (fastSwing || softSwingArmed) {
        this.armSwingFromRing(nowMs, linAccelMag, gyroRateDps, energy, worldYawDps * dtSec, ahrsOut.worldFaceNormal);
      }
      return null;
    }

    // state === 'armed': trapezoid-integrate 3D world velocity & track exact t_peak!
    this.vIntX += 0.5 * (this.prevIntAx + aWorld.x) * G_TO_MPS2 * dtSec;
    this.vIntY += 0.5 * (this.prevIntAy + aWorld.y) * G_TO_MPS2 * dtSec;
    this.vIntZ += 0.5 * (this.prevIntAz + aWorld.z) * G_TO_MPS2 * dtSec;
    this.prevIntAx = aWorld.x;
    this.prevIntAy = aWorld.y;
    this.prevIntAz = aWorld.z;

    const speedNow = Math.hypot(this.vIntX, this.vIntY, this.vIntZ);
    if (speedNow >= this.peakSpeedMps) {
      this.peakSpeedMps = speedNow;
      this.swingPeakMs = nowMs;
      this.vContact = { x: this.vIntX, y: this.vIntY, z: this.vIntZ };
      this.faceNormalAtPeak = {
        x: ahrsOut.worldFaceNormal.x,
        y: ahrsOut.worldFaceNormal.y,
        z: ahrsOut.worldFaceNormal.z,
      };
    }

    if (linAccelMag > this.peakAccelG) this.peakAccelG = linAccelMag;
    if (gyroRateDps > this.peakGyroDps) this.peakGyroDps = gyroRateDps;
    if (energy > this.peakEnergy) this.peakEnergy = energy;
    this.swingYawAccumDeg += worldYawDps * dtSec;

    const elapsedMs = nowMs - this.swingStartMs;

    // Emit one early anticipation guess ~25ms into the swing
    if (!this.earlyGuessEmitted && elapsedMs >= 25) {
      this.earlyGuessEmitted = true;
      const accelSlopeGps = (this.peakAccelG - this.armAccelAtStart) / Math.max(0.015, elapsedMs / 1000);
      this.pendingEarlyGuess = {
        swingStartMs: this.swingStartMs,
        nowMs,
        initialSpeed: clamp(speedNow / 3.2, 0.16, 1),
        imuBackswing: clamp(Math.abs(this.relYawDeg) / 45, 0.15, 1),
        accelSlopeGps,
        faceNormal: {
          x: ahrsOut.worldFaceNormal.x,
          y: ahrsOut.worldFaceNormal.y,
          z: ahrsOut.worldFaceNormal.z,
        },
        vLive: { x: this.vIntX, y: this.vIntY, z: this.vIntZ },
        peakAccelG: this.peakAccelG,
        peakGyroDps: this.peakGyroDps,
      };
    }

    // End swing strictly after peak passes (or 190ms cap)
    const passedPeak = elapsedMs >= 55 && linAccelMag < this.peakAccelG * 0.45;
    const maxWindowHit = elapsedMs >= 190;

    if (passedPeak || maxWindowHit) {
      this.state = 'cooldown';
      this.cooldownUntilMs = nowMs + this.config.cooldownMs;
      this.cooldownMaxUntilMs = nowMs + this.config.cooldownMs + 200;
      this.quietSinceMs = null;

      if (
        this.peakAccelG < this.config.dropAccelG * 0.9 &&
        this.peakGyroDps < 180
      ) {
        return null;
      }

      const rawSwing: RawClassifiedSwing = {
        swingStartMs: this.swingStartMs,
        swingPeakMs: this.swingPeakMs,
        swingEndMs: nowMs,
        vContact: { ...this.vContact },
        swingSpeedMps: this.peakSpeedMps,
        faceNormalAtPeak: { ...this.faceNormalAtPeak },
        worldYawAccumDeg: this.swingYawAccumDeg,
        power: 0.5,
        angle: 0,
        peakAccelG: this.peakAccelG,
        peakGyroDps: this.peakGyroDps,
        shotType: 'topspin',
        rotation: 0,
        confidence: 0.75,
      };

      const defaultResolved = this.resolveShot(rawSwing, 'forehand', 0, false, 0, false);
      rawSwing.power = defaultResolved.power;
      rawSwing.angle = defaultResolved.angle;
      rawSwing.shotType = defaultResolved.shotType;
      rawSwing.rotation = defaultResolved.rotation;
      rawSwing.confidence = defaultResolved.confidence;

      return rawSwing;
    }

    return null;
  }

  /**
   * Rewinds up to 40 ms into the pre-trigger ring buffer to find the local
   * acceleration minimum (`t_onset`), then trapezoid-integrates 3D world velocity
   * cleanly from `t_onset` to `nowMs`.
   */
  private armSwingFromRing(
    nowMs: number,
    linAccelMag: number,
    gyroRateDps: number,
    energy: number,
    yawDeltaDeg: number,
    curFaceNormal: Vec3,
  ) {
    this.state = 'armed';
    this.dropPulseSinceMs = null;
    this.earlyGuessEmitted = false;
    this.pendingEarlyGuess = null;

    // Find local |a| minimum within last 45ms
    let onsetIdx = this.ring.length - 1;
    let minMag = Infinity;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (nowMs - this.ring[i].t > 45) break;
      if (this.ring[i].aMag <= minMag) {
        minMag = this.ring[i].aMag;
        onsetIdx = i;
      }
    }

    const onsetEntry = this.ring[onsetIdx];
    this.swingStartMs = onsetEntry ? onsetEntry.t : nowMs;
    this.armAccelAtStart = onsetEntry ? onsetEntry.aMag : linAccelMag;

    // Integrate cleanly from t_onset -> nowMs
    this.vIntX = 0;
    this.vIntY = 0;
    this.vIntZ = 0;
    this.peakSpeedMps = 0;
    this.swingPeakMs = this.swingStartMs;
    this.peakAccelG = linAccelMag;
    this.peakGyroDps = gyroRateDps;
    this.peakEnergy = energy;
    this.swingYawAccumDeg = yawDeltaDeg;
    this.vContact = { x: 0, y: 0, z: 0 };
    this.faceNormalAtPeak = { ...curFaceNormal };

    if (onsetEntry) {
      this.prevIntAx = onsetEntry.aWorld.x;
      this.prevIntAy = onsetEntry.aWorld.y;
      this.prevIntAz = onsetEntry.aWorld.z;

      for (let i = onsetIdx + 1; i < this.ring.length; i++) {
        const cur = this.ring[i];
        this.vIntX += 0.5 * (this.prevIntAx + cur.aWorld.x) * G_TO_MPS2 * cur.dtSec;
        this.vIntY += 0.5 * (this.prevIntAy + cur.aWorld.y) * G_TO_MPS2 * cur.dtSec;
        this.vIntZ += 0.5 * (this.prevIntAz + cur.aWorld.z) * G_TO_MPS2 * cur.dtSec;
        this.prevIntAx = cur.aWorld.x;
        this.prevIntAy = cur.aWorld.y;
        this.prevIntAz = cur.aWorld.z;

        const spd = Math.hypot(this.vIntX, this.vIntY, this.vIntZ);
        if (spd >= this.peakSpeedMps) {
          this.peakSpeedMps = spd;
          this.swingPeakMs = cur.t;
          this.vContact = { x: this.vIntX, y: this.vIntY, z: this.vIntZ };
          this.faceNormalAtPeak = { ...cur.faceNormal };
        }
        if (cur.aMag > this.peakAccelG) this.peakAccelG = cur.aMag;
        if (cur.gyroDps > this.peakGyroDps) this.peakGyroDps = cur.gyroDps;
      }
    }
  }
}
