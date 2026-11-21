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
  /** Invert IMU forehand/backhand yaw voter sign if needed */
  invertWingYaw?: boolean;
}

export const DEFAULT_IMU_CONFIG: ImuClassifierConfig = {
  armAccelG: 0.75,
  armGyroDps: 220,
  dropAccelG: 0.62,
  dropGyroDps: 85,
  dropMinSpeedMps: 0.26,
  maxAccelG: 3.4,
  maxGyroDps: 500,
  cooldownMs: 550,
  dropshotPowerMax: 0.48,
  sliceThreshold: -0.12,
  invertAngle: false,
  invertRotation: false,
  invertWingYaw: false,
};

export interface EarlySwingGuess {
  swingStartMs: number;
  nowMs: number;
  initialSpeed: number;
  imuBackswing: number;
  accelSlopeGps: number;
  faceNormal: Vec3;
  racketUp: Vec3;
  earlyYawDeg: number;
  preSwingRelYawDeg: number;
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
  /** Grip-agnostic virtual racket UP vector in world frame at peak contact */
  racketUpAtPeak: Vec3;
  /** Signed IMU lateral swing yaw integrated across entire stroke (deg, + = CCW around +Z_W) */
  worldYawAccumDeg: number;
  /** Signed IMU world yaw integrated strictly up to peak contact speed (deg, immune to follow-through recoil) */
  worldYawToPeakDeg: number;
  /** Signed peak world-vertical yaw rate during the stroke (deg/s) */
  peakWorldYawDps: number;
  /** Relative world-Z yaw at swing onset (deg, captures pre-swing backswing coil) */
  preSwingRelYawDeg: number;
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
  racketUp: Vec3;
  gyroDps: number;
  worldYawDps: number;
  relYawDeg: number;
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
  private racketUpAtPeak: Vec3 = { x: 0, y: 0, z: 1 };
  private peakAccelG = 0;
  private peakGyroDps = 0;
  private gyroPeakMs = 0;
  private samplesSinceGyroPeak = 0;
  private peakEnergy = 0;
  private swingYawAccumDeg = 0;
  private swingYawToPeakDeg = 0;
  private peakWorldYawDps = 0;
  private preSwingRelYawDeg = 0;
  private armAccelAtStart = 0;

  private pendingEarlyGuess: EarlySwingGuess | null = null;
  private earlyGuessEmitted = false;

  // Bias-immune raw stillness detector (150ms rolling window BEFORE gyro bias subtraction!
  // 100% immune to +/-500 deg/s M5 MPU6886 gyro-offset jumps across BLE reconnects/reboots!)
  private rawWindow: Array<{ t: number; ax: number; ay: number; az: number; gx: number; gy: number; gz: number }> = [];
  private rawStillSinceMs: number | null = null;

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

    this.ahrs.reset();
    this.gyroBiasX = 0;
    this.gyroBiasY = 0;
    this.gyroBiasZ = 0;
    this.aBiasX = 0;
    this.aBiasY = 0;
    this.aBiasZ = 0;
    this.localAccelMag = 1.0;

    this.vLiveX = 0;
    this.vLiveY = 0;
    this.vLiveZ = 0;
    this.stillSinceMs = null;

    this.state = 'idle';
    this.swingStartMs = 0;
    this.swingPeakMs = 0;
    this.cooldownUntilMs = 0;
    this.cooldownMaxUntilMs = 0;
    this.quietSinceMs = null;
    this.dropPulseSinceMs = null;

    this.vIntX = 0;
    this.vIntY = 0;
    this.vIntZ = 0;
    this.prevIntAx = 0;
    this.prevIntAy = 0;
    this.prevIntAz = 0;
    this.peakSpeedMps = 0;
    this.vContact = { x: 0, y: 0, z: 0 };
    this.faceNormalAtPeak = { x: 0, y: 1, z: 0 };
    this.racketUpAtPeak = { x: 0, y: 0, z: 1 };
    this.peakAccelG = 0;
    this.peakGyroDps = 0;
    this.gyroPeakMs = 0;
    this.samplesSinceGyroPeak = 0;
    this.peakEnergy = 0;
    this.swingYawAccumDeg = 0;
    this.swingYawToPeakDeg = 0;
    this.peakWorldYawDps = 0;
    this.preSwingRelYawDeg = 0;
    this.armAccelAtStart = 0;
    this.relYawDeg = 0;
    this.ring = [];
    this.rawWindow = [];
    this.rawStillSinceMs = null;
    this.pendingEarlyGuess = null;
    this.earlyGuessEmitted = false;
    this.lastClassifiedShot = 'topspin';

    this.angleFilter.reset(0);
    this.rotFilter.reset(0);
    this.latestReading = {
      power: 0,
      rotation: 0,
      angle: 0,
      linearAccelG: 0,
      gyroRateDps: 0,
      rawPitchDeg: 0,
      rawRollDeg: 0,
      rawYawDeg: 0,
    };
  }

  /**
   * Immediately exits cooldown back to `idle` — used when a backswing prep
   * motion is vetoed so the player's actual forward swing 150ms later fires cleanly!
   */
  cancelCooldown() {
    // A swing already in flight is kept; only a finished swing's cooldown is cleared.
    if (this.state === 'armed') return;
    this.state = 'idle';
    this.cooldownUntilMs = 0;
    this.cooldownMaxUntilMs = 0;
    this.quietSinceMs = null;
    this.dropPulseSinceMs = null;
  }

  rezero() {
    this.startZeroing();
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
   * Grip-invariant IMU Forehand / Backhand voter using world-vertical (+Z_W) yaw
   * integrated up to peak contact (`worldYawToPeakDeg`) and pre-swing backswing coil
   * (`preSwingRelYawDeg`).
   *
   * Right-hand rule around world UP (+Z_W):
   * - Right-handed Forehand sweeps Right -> Forward -> Left = CCW around +Z_W (+yaw)
   *   after coiling CW (-preSwingRelYawDeg).
   * - Right-handed Backhand sweeps Left -> Forward -> Right = CW around +Z_W (-yaw)
   *   after coiling CCW (+preSwingRelYawDeg).
   * - Left-handed is the exact mirror (`handSign = -1`).
   */
  inferImuWing(
    swing: RawClassifiedSwing,
    handedness: 'right' | 'left',
  ): { wing: StrokeWing; confidence: number; signedYawDeg: number } {
    const handSign =
      (handedness === 'right' ? 1 : -1) * (this.config.invertWingYaw ? -1 : 1);

    const yawToPeak = swing.worldYawToPeakDeg ?? swing.worldYawAccumDeg;
    const yawAccum = swing.worldYawAccumDeg;
    const effectiveYawDeg =
      Math.abs(yawToPeak) < 10 && Math.abs(yawAccum) >= 12
        ? 0.35 * yawToPeak + 0.65 * yawAccum
        : yawToPeak;

    const primarySignedYaw = effectiveYawDeg * handSign;
    const coilSignedYaw = -(swing.preSwingRelYawDeg ?? 0) * handSign;
    const signedYawDeg =
      Math.abs(coilSignedYaw) >= 4
        ? 0.65 * primarySignedYaw + 0.35 * coilSignedYaw
        : primarySignedYaw;

    const wing: StrokeWing = signedYawDeg >= 0 ? 'forehand' : 'backhand';
    const absYaw = Math.abs(signedYawDeg);
    const confidence =
      absYaw < 8
        ? clamp(absYaw / 25, 0, 0.30)
        : clamp(0.45 + (absYaw - 8) / 42, 0.45, 0.94);

    return { wing, confidence, signedYawDeg };
  }

  /**
   * Pure early-swing guess (at ~25ms into swing) for 3D avatar anticipation.
   * Uses 100% grip-agnostic virtual racket UP (`early.racketUp`) and live 3D velocity.
   * Never mutates `lastClassifiedShot`, and avoids the low-speed dropshot bias
   * while acceleration is still ramping!
   */
  resolveEarlyGuess(
    early: EarlySwingGuess,
    _wing: StrokeWing,
    backswing: number,
    webcamDeltaArmY = 0,
    hasWebcamData = false,
  ): { shotType: HumanShotType; confidence: number } {
    // Only predict dropshot early if backswing is compact AND accel isn't ramping hard
    if (backswing < 0.32 && early.accelSlopeGps < 10 && early.initialSpeed < 0.35) {
      return { shotType: 'dropshot', confidence: 0.62 };
    }

    const v = early.vLive;
    const vHoriz = Math.hypot(v.x, v.y);
    const racketUp = early.racketUp ?? { x: 0, y: 0, z: 1 };
    const effFaceOpen =
      vHoriz >= 0.25
        ? clamp(-(racketUp.x * (v.x / vHoriz) + racketUp.y * (v.y / vHoriz)), -1, 1)
        : 0;

    const vertCue = hasWebcamData
      ? clamp(webcamDeltaArmY / 0.1, -1, 1) * 0.55 + clamp(v.z / 1.1, -1, 1) * 0.45
      : clamp(v.z / 1.1, -1, 1);
    const faceCue = clamp(-effFaceOpen / 0.5, -1, 1);
    const score = vHoriz >= 0.25 ? vertCue * 0.65 + faceCue * 0.35 : vertCue;

    if (score < this.config.sliceThreshold) {
      return { shotType: 'slice', confidence: 0.64 };
    }
    return { shotType: 'topspin', confidence: 0.66 };
  }

  /**
   * Pure 6-combo (`FH/BH` × `topspin/slice/dropshot`) multi-cue shot classifier
   * using 3D contact velocity (`vContact`), 100% grip-agnostic virtual racket UP
   * (`racketUpAtPeak`), and peak-locked webcam kinematics (`deltaArmY`, `peakWristSpeed`).
   */
  resolveShot(
    swing: RawClassifiedSwing,
    wing: StrokeWing,
    webcamDeltaArmY = 0,
    hasWebcamData = false,
    peakWristSpeed = 0,
    commitAsLastShot = true,
    webcamStrokePathSw = 0,
  ): ResolvedShotResult {
    const rotSign = this.config.invertRotation ? -1 : 1;
    const yawSign = this.config.invertAngle ? -1 : 1;

    const v = swing.vContact;
    const racketUp = swing.racketUpAtPeak ?? { x: 0, y: 0, z: 1 };
    const vHoriz = Math.hypot(v.x, v.y);

    // 1. 100% Grip-Agnostic Face Openness via SO(3) virtual racket UP projection:
    // At ZERO, `worldRacketUp` is (0, 0, +1) for EVERY grip orientation.
    // Closing the racket over the ball (topspin) pitches `racketUp` forward along +u_h
    // (tiltAlongSwing > 0 -> effFaceOpen < 0). Laying the racket open (slice/dropshot)
    // tilts `racketUp` backward away from +u_h (tiltAlongSwing < 0 -> effFaceOpen > 0).
    let effFaceOpen = 0;
    if (vHoriz >= 0.25) {
      const ux = v.x / vHoriz;
      const uy = v.y / vHoriz;
      const tiltAlongSwing = racketUp.x * ux + racketUp.y * uy;
      effFaceOpen = clamp(-tiltAlongSwing, -1, 1);
    }

    // 2. Unified BH-compensated power blended with bleController.ts's proven gyro-peak curve
    //    (260-300 deg/s gentle -> ~0.22, 1350+ deg/s full swing -> 1.0)
    const speedComp = swing.swingSpeedMps * (wing === 'backhand' ? 1.12 : 1.0);
    const gyroPower = clamp(((swing.peakGyroDps - 240) / 1100) * 0.8 + 0.2, 0.2, 1.0);
    const vNorm = clamp(speedComp / 4.2, 0, 1);
    const aNorm = clamp(swing.peakAccelG / Math.max(0.5, this.config.maxAccelG), 0, 1);
    const power = clamp(0.40 * gyroPower + 0.35 * vNorm + 0.25 * aNorm, 0.18, 1.0);

    // 3. Camera-Primary + IMU Fusion for Spin (+ = topspin low->high, - = slice high->low)
    // When time-aligned webcam sees clear upward/downward arm travel (|deltaArmY| >= 0.03),
    // give camera 70% weight (100% immune to M5 grip angle & axis-scale bias!) + 30% IMU.
    const imuPath = clamp(v.z / Math.max(0.5, 0.52 * vHoriz), -1, 1);
    const camVert = hasWebcamData ? clamp(webcamDeltaArmY / 0.085, -1, 1) : 0;
    const faceCue = clamp(-effFaceOpen / 0.5, -1, 1);

    const rawSpin =
      hasWebcamData && Math.abs(webcamDeltaArmY) >= 0.03
        ? clamp(0.70 * camVert + 0.22 * imuPath + 0.08 * faceCue, -1, 1)
        : hasWebcamData
          ? clamp(0.42 * camVert + 0.43 * imuPath + 0.15 * faceCue, -1, 1)
          : clamp(0.70 * imuPath + 0.30 * faceCue, -1, 1);
    const spinScore = rotSign * rawSpin;

    // 4. Camera + IMU Fused 6-Combo Decision Rules (compact slow tap = dropshot; big fast arc = topspin/slice)
    const camSlowOk = !hasWebcamData || peakWristSpeed <= 0 || peakWristSpeed < 3.6;
    const camCompact =
      hasWebcamData &&
      webcamStrokePathSw > 0 &&
      webcamStrokePathSw < 0.72 &&
      (peakWristSpeed <= 0 || peakWristSpeed < 3.6);
    const camBigFastSwing =
      hasWebcamData && webcamStrokePathSw > 1.05 && peakWristSpeed > 4.2;

    // Rule A: Soft touch dropshot (gentle IMU speed/G + not a big fast camera swing)
    const isSoftDrop =
      !camBigFastSwing &&
      swing.swingSpeedMps < 1.60 &&
      swing.peakAccelG < 1.65 &&
      swing.peakGyroDps < 320 &&
      camSlowOk;

    // Rule B: Camera-confirmed compact dropshot (short arm stroke + moderate-soft IMU power)
    const isCameraCompactDrop =
      camCompact &&
      power <= 0.56 &&
      swing.swingSpeedMps < 2.15 &&
      swing.peakAccelG < 2.05;

    // Rule C: Controlled soft-to-medium dropshot (pure IMU fallback & gentle open carve)
    const isControlledDrop =
      !camBigFastSwing &&
      power <= this.config.dropshotPowerMax &&
      swing.swingSpeedMps < 1.95 &&
      swing.peakAccelG < 1.90 &&
      swing.peakGyroDps < 350 &&
      camSlowOk &&
      (effFaceOpen > 0.02 || spinScore <= 0.25);

    let shotType: HumanShotType;
    let rotation: number;
    let confidence: number;

    if (isSoftDrop || isCameraCompactDrop || isControlledDrop) {
      shotType = 'dropshot';
      rotation = clamp(-0.25 - 0.35 * Math.max(0, effFaceOpen), -0.65, -0.2);
      const speedMargin = clamp((1.95 - swing.swingSpeedMps) / 1.1, 0, 1);
      confidence = clamp(0.68 + speedMargin * 0.28, 0.62, 0.96);
    } else if (
      spinScore < this.config.sliceThreshold ||
      (v.z < -0.22 && effFaceOpen > 0.16)
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

    // 5. 100% Grip-Agnostic World-Frame Aim Angle (-1 left .. +1 right)
    const velDeg = (Math.atan2(v.x, Math.max(0.35, Math.abs(v.y) + 0.15)) * 180) / Math.PI;
    const yawToPeak = swing.worldYawToPeakDeg ?? swing.worldYawAccumDeg;
    const yawAngle = clamp(-yawToPeak / 45, -1, 1);
    const angle =
      yawSign * clamp(0.65 * clamp(velDeg / 42, -1, 1) + 0.35 * yawAngle, -1, 1);

    if (commitAsLastShot) {
      this.lastClassifiedShot = shotType;
    }

    return { shotType, power, rotation, angle, confidence };
  }

  /**
   * Process one raw 100 Hz 6-axis M5Stack IMU sample.
   * - `isTakingBackCrossBody`: optional flag from WebcamArmTracker that vetoes soft-path
   *   false triggers while the player is crossing their arm over to prepare a backhand.
   * - `allowSoftImuDropshot`: when `false` (e.g. webcam swing detector is active and
   *   handles soft dropshots visually), ONLY the rock-solid `armGyroDps` (260 deg/s)
   *   `bleController.ts` gyro-peak detector fires. Defaults to `true` for IMU-only mode.
   */
  ingest(
    sample: RawImuSample,
    nowMs = performance.now(),
    isTakingBackCrossBody = false,
    allowSoftImuDropshot = true,
  ): RawClassifiedSwing | null {
    const dtSec =
      this.lastSampleMs === null ? 0.01 : clamp((nowMs - this.lastSampleMs) / 1000, 0.002, 0.1);
    this.lastSampleMs = nowMs;

    // Once calibrated, a zero request that lands while a swing is in flight or has just ended is ignored,
    // so a grip that brushes the button mid-swing cannot store the swing's motion as the zero pose.
    if (sample.recenter && (this.phase !== 'ready' || this.state === 'idle')) {
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

    // Step B: Auto-zero cleanly on first 0.25s of stillness (so opening `/match` never
    // leaves the M5 paralyzed in `needs_zero`!) while keeping manual `ZERO M5` / `RE-ZERO` anytime.
    if (this.phase === 'needs_zero') {
      this.rawWindow.push({
        t: nowMs,
        ax: sample.ax,
        ay: sample.ay,
        az: sample.az,
        gx: sample.gx,
        gy: sample.gy,
        gz: sample.gz,
      });
      while (
        this.rawWindow.length > 20 ||
        (this.rawWindow.length > 2 && nowMs - this.rawWindow[0].t > 240)
      ) {
        this.rawWindow.shift();
      }

      if (this.rawWindow.length >= 6) {
        let minAx = Infinity, maxAx = -Infinity;
        let minAy = Infinity, maxAy = -Infinity;
        let minAz = Infinity, maxAz = -Infinity;
        let minGx = Infinity, maxGx = -Infinity;
        let minGy = Infinity, maxGy = -Infinity;
        let minGz = Infinity, maxGz = -Infinity;
        let sAx = 0, sAy = 0, sAz = 0, sGx = 0, sGy = 0, sGz = 0;
        for (const p of this.rawWindow) {
          if (p.ax < minAx) minAx = p.ax;
          if (p.ax > maxAx) maxAx = p.ax;
          if (p.ay < minAy) minAy = p.ay;
          if (p.ay > maxAy) maxAy = p.ay;
          if (p.az < minAz) minAz = p.az;
          if (p.az > maxAz) maxAz = p.az;
          if (p.gx < minGx) minGx = p.gx;
          if (p.gx > maxGx) maxGx = p.gx;
          if (p.gy < minGy) minGy = p.gy;
          if (p.gy > maxGy) maxGy = p.gy;
          if (p.gz < minGz) minGz = p.gz;
          if (p.gz > maxGz) maxGz = p.gz;
          sAx += p.ax; sAy += p.ay; sAz += p.az;
          sGx += p.gx; sGy += p.gy; sGz += p.gz;
        }
        const rawAccRange = Math.hypot(maxAx - minAx, maxAy - minAy, maxAz - minAz);
        const rawGyroRange = Math.hypot(maxGx - minGx, maxGy - minGy, maxGz - minGz);
        if (rawAccRange < 0.09 && rawGyroRange < 14) {
          if (this.rawStillSinceMs === null) this.rawStillSinceMs = nowMs;
          if (nowMs - this.rawStillSinceMs >= 220) {
            const n = this.rawWindow.length;
            this.ahrs.alignToZero(sAx / n, sAy / n, sAz / n);
            this.localAccelMag = this.ahrs.getRestAccelMag();
            this.gyroBiasX = sGx / n;
            this.gyroBiasY = sGy / n;
            this.gyroBiasZ = sGz / n;
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
            return null;
          }
        } else {
          this.rawStillSinceMs = null;
        }
      }

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
    // 1. Bias-Immune Raw Stillness Detector (runs BEFORE bias subtraction!)
    //    Even if the M5 reboots/reconnects and its resting gyro offset jumps by 300+ deg/s,
    //    peak-to-peak raw spread stays ~0.02g / ~2 deg/s while stationary -> auto-heals bias in 0.12s!
    this.rawWindow.push({
      t: nowMs,
      ax: sample.ax,
      ay: sample.ay,
      az: sample.az,
      gx: sample.gx,
      gy: sample.gy,
      gz: sample.gz,
    });
    while (this.rawWindow.length > 15 || (this.rawWindow.length > 2 && nowMs - this.rawWindow[0].t > 160)) {
      this.rawWindow.shift();
    }

    let rawAccRange = 0;
    let rawGyroRange = 0;
    let rawMeanAx = sample.ax;
    let rawMeanAy = sample.ay;
    let rawMeanAz = sample.az;
    let rawMeanGx = sample.gx;
    let rawMeanGy = sample.gy;
    let rawMeanGz = sample.gz;

    if (this.rawWindow.length >= 4) {
      let minAx = Infinity, maxAx = -Infinity;
      let minAy = Infinity, maxAy = -Infinity;
      let minAz = Infinity, maxAz = -Infinity;
      let minGx = Infinity, maxGx = -Infinity;
      let minGy = Infinity, maxGy = -Infinity;
      let minGz = Infinity, maxGz = -Infinity;
      let sAx = 0, sAy = 0, sAz = 0, sGx = 0, sGy = 0, sGz = 0;
      for (const p of this.rawWindow) {
        if (p.ax < minAx) minAx = p.ax;
        if (p.ax > maxAx) maxAx = p.ax;
        if (p.ay < minAy) minAy = p.ay;
        if (p.ay > maxAy) maxAy = p.ay;
        if (p.az < minAz) minAz = p.az;
        if (p.az > maxAz) maxAz = p.az;
        if (p.gx < minGx) minGx = p.gx;
        if (p.gx > maxGx) maxGx = p.gx;
        if (p.gy < minGy) minGy = p.gy;
        if (p.gy > maxGy) maxGy = p.gy;
        if (p.gz < minGz) minGz = p.gz;
        if (p.gz > maxGz) maxGz = p.gz;
        sAx += p.ax; sAy += p.ay; sAz += p.az;
        sGx += p.gx; sGy += p.gy; sGz += p.gz;
      }
      const n = this.rawWindow.length;
      rawMeanAx = sAx / n;
      rawMeanAy = sAy / n;
      rawMeanAz = sAz / n;
      rawMeanGx = sGx / n;
      rawMeanGy = sGy / n;
      rawMeanGz = sGz / n;
      rawAccRange = Math.hypot(maxAx - minAx, maxAy - minAy, maxAz - minAz);
      rawGyroRange = Math.hypot(maxGx - minGx, maxGy - minGy, maxGz - minGz);
    }

    const rawQuietNow = this.rawWindow.length >= 6 && rawAccRange < 0.09 && rawGyroRange < 14;
    if (rawQuietNow) {
      if (this.rawStillSinceMs === null) this.rawStillSinceMs = nowMs;
    } else {
      this.rawStillSinceMs = null;
    }
    const isRawStill = this.rawStillSinceMs !== null && nowMs - this.rawStillSinceMs >= 110;

    // Auto-heal resting gyro offset jump (e.g. +311 -> -144 deg/s after BLE disconnect/M5 reset!)
    if (isRawStill) {
      const biasErr = Math.hypot(
        rawMeanGx - this.gyroBiasX,
        rawMeanGy - this.gyroBiasY,
        rawMeanGz - this.gyroBiasZ,
      );
      if (biasErr > 20) {
        // Large hardware bias jump detected while completely motionless -> snap immediately!
        this.gyroBiasX = rawMeanGx;
        this.gyroBiasY = rawMeanGy;
        this.gyroBiasZ = rawMeanGz;
        this.ahrs.alignGravityOnly(rawMeanAx, rawMeanAy, rawMeanAz);
        this.localAccelMag = this.ahrs.getRestAccelMag();
        this.aBiasX = 0;
        this.aBiasY = 0;
        this.aBiasZ = 0;
        this.vLiveX = 0;
        this.vLiveY = 0;
        this.vLiveZ = 0;
        if (this.state === 'armed') {
          this.state = 'idle';
          this.dropPulseSinceMs = null;
          this.pendingEarlyGuess = null;
        }
      } else {
        const bAlpha = 0.08;
        this.gyroBiasX += bAlpha * (rawMeanGx - this.gyroBiasX);
        this.gyroBiasY += bAlpha * (rawMeanGy - this.gyroBiasY);
        this.gyroBiasZ += bAlpha * (rawMeanGz - this.gyroBiasZ);
      }
    }

    const gx = sample.gx - this.gyroBiasX;
    const gy = sample.gy - this.gyroBiasY;
    const gz = sample.gz - this.gyroBiasZ;

    const ahrsOut = this.ahrs.update(sample.ax, sample.ay, sample.az, gx, gy, gz, dtSec);
    const rawWorld = ahrsOut.worldLinearAccel;
    const gyroRateDps = isRawStill ? 0 : Math.hypot(gx, gy, gz);
    const rawAccMag = Math.hypot(sample.ax, sample.ay, sample.az);

    // Track & remove anisotropic MPU6886 axis-scale DC offset (0.82g..1.20g across axes!)
    // ONLY updates when truly calm (gyro < 28 deg/s AND accelDelta < 0.08g) so soft
    // dropshots (75-180 deg/s, 0.7g) are NEVER eaten by the baseline tracker!
    if (this.state !== 'armed' && (isRawStill || (gyroRateDps < 28 && accelDelta < 0.08))) {
      const biasAlpha = isRawStill ? 0.16 : 0.06;
      this.aBiasX += biasAlpha * (rawWorld.x - this.aBiasX);
      this.aBiasY += biasAlpha * (rawWorld.y - this.aBiasY);
      this.aBiasZ += biasAlpha * (rawWorld.z - this.aBiasZ);
      this.localAccelMag += biasAlpha * (rawAccMag - this.localAccelMag);
    }

    // Rotation-proof scalar dynamic G (0.00g during pure wrist twists even if gyro has scale error!)
    const scalarDynG = isRawStill ? 0 : Math.abs(rawAccMag - this.localAccelMag);

    const aWorld: Vec3 = isRawStill
      ? { x: 0, y: 0, z: 0 }
      : {
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

    // World-vertical yaw integration (CCW/+ = left, CW/- = right)
    // Widen clamp to [-160, 160] so a 110° follow-through returning to neutral
    // never saturates and creates a permanent yaw offset!
    const worldYawDps = Math.abs(ahrsOut.worldGyro.z) > 4.0 ? ahrsOut.worldGyro.z : 0;
    this.relYawDeg = clamp(this.relYawDeg + worldYawDps * dtSec, -160, 160);
    if (this.state === 'idle' && linAccelMag < 0.18 && gyroRateDps < 15) {
      this.relYawDeg *= 1 - 0.45 * dtSec;
    }

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
      racketUp: {
        x: ahrsOut.worldRacketUp.x,
        y: ahrsOut.worldRacketUp.y,
        z: ahrsOut.worldRacketUp.z,
      },
      gyroDps: gyroRateDps,
      worldYawDps,
      relYawDeg: this.relYawDeg,
    });
    while (this.ring.length > 0 && nowMs - this.ring[0].t > RING_WINDOW_MS) {
      this.ring.shift();
    }

    const yawSign = this.config.invertAngle ? 1 : -1;
    const rotSign = this.config.invertRotation ? -1 : 1;

    // 100% Grip-Agnostic live rotation gauge: at ZERO, worldRacketUp = (0, 0, +1),
    // so horizontal projection is identically 0.00 for every grip orientation!
    const vLiveHoriz = Math.hypot(this.vLiveX, this.vLiveY);
    const liveTiltProject =
      vLiveHoriz >= 0.20
        ? (ahrsOut.worldRacketUp.x * this.vLiveX + ahrsOut.worldRacketUp.y * this.vLiveY) /
          vLiveHoriz
        : -ahrsOut.worldRacketUp.y;
    const liveFaceDelta = clamp(liveTiltProject * 1.4, -1, 1);

    const filteredAngle = this.angleFilter.filter(clamp((yawSign * this.relYawDeg) / 45, -1, 1), nowMs);
    const filteredRotation = this.rotFilter.filter(clamp(rotSign * liveFaceDelta, -1, 1), nowMs);
    const liveGyroPower =
      gyroRateDps < 35
        ? 0
        : clamp(((gyroRateDps - 240) / 1100) * 0.8 + 0.2, 0.05, 1.0);
    const livePower = clamp(
      0.40 * liveGyroPower +
        0.35 * clamp(liveSpeedMps / 4.2, 0, 1) +
        0.25 * clamp(linAccelMag / Math.max(0.5, this.config.maxAccelG), 0, 1),
      0,
      1,
    );

    this.latestReading = {
      power: livePower,
      rotation: filteredRotation,
      angle: filteredAngle,
      linearAccelG: linAccelMag,
      gyroRateDps,
      rawPitchDeg: ahrsOut.racketTiltDeg,
      rawRollDeg: ahrsOut.faceTiltDeg,
      rawYawDeg: this.relYawDeg,
    };

    // Single-trigger-per-swing state machine (~550ms cooldown + quiet exit + hard ceiling)
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
      // HARD BLOCK: if bias-immune raw stillness detector sees motionless sensor, NEVER arm!
      if (isRawStill) {
        this.dropPulseSinceMs = null;
        return null;
      }

      // Path 1: bleController.ts battle-tested Peak Gyro Swing Trigger!
      // Starts tracking when bias-corrected spin >= armGyroDps (default 260 deg/s, well above
      // casual hand movement & slow backswing prep < 180 deg/s) with real dynamic raw change
      // (rawGyroRange >= 90 deg/s, rawAccRange >= 0.35g) and modest linAccelMag >= 0.45g
      // so fast swings ALWAYS trigger regardless of grip orientation.
      const minFastAccelG = Math.min(0.45, this.config.armAccelG);
      const fastSwing =
        gyroRateDps >= this.config.armGyroDps &&
        linAccelMag >= minFastAccelG &&
        rawGyroRange >= 90 &&
        rawAccRange >= 0.35;

      // Path 2: Optional IMU-only soft dropshot path (gated by allowSoftImuDropshot;
      // disabled when webcam swing detector is active and already handles soft dropshots visually).
      const dropHasRealTranslation =
        scalarDynG >= 0.14 || (linAccelMag >= 0.60 && liveSpeedMps >= 0.20);
      const dropPulseActive =
        allowSoftImuDropshot &&
        !isTakingBackCrossBody &&
        linAccelMag >= this.config.dropAccelG &&
        dropHasRealTranslation &&
        gyroRateDps >= this.config.dropGyroDps &&
        rawAccRange >= 0.34 &&
        rawGyroRange >= 45;

      let softSwingArmed = false;
      if (dropPulseActive) {
        if (this.dropPulseSinceMs === null) {
          this.dropPulseSinceMs = nowMs;
        } else if (
          nowMs - this.dropPulseSinceMs >= 20 &&
          liveSpeedMps >= this.config.dropMinSpeedMps
        ) {
          softSwingArmed = true;
        }
      } else {
        this.dropPulseSinceMs = null;
      }

      if (fastSwing || softSwingArmed) {
        this.armSwingFromRing(
          nowMs,
          linAccelMag,
          gyroRateDps,
          energy,
          worldYawDps,
          dtSec,
          ahrsOut.worldFaceNormal,
          ahrsOut.worldRacketUp,
          softSwingArmed && !fastSwing,
        );
      }
      return null;
    }

    // state === 'armed': trapezoid-integrate 3D world velocity & follow bleController.ts gyro peak!
    this.vIntX += 0.5 * (this.prevIntAx + aWorld.x) * G_TO_MPS2 * dtSec;
    this.vIntY += 0.5 * (this.prevIntAy + aWorld.y) * G_TO_MPS2 * dtSec;
    this.vIntZ += 0.5 * (this.prevIntAz + aWorld.z) * G_TO_MPS2 * dtSec;
    this.prevIntAx = aWorld.x;
    this.prevIntAy = aWorld.y;
    this.prevIntAz = aWorld.z;

    this.swingYawAccumDeg += worldYawDps * dtSec;
    if (Math.abs(worldYawDps) > Math.abs(this.peakWorldYawDps)) {
      this.peakWorldYawDps = worldYawDps;
    }

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
      this.racketUpAtPeak = {
        x: ahrsOut.worldRacketUp.x,
        y: ahrsOut.worldRacketUp.y,
        z: ahrsOut.worldRacketUp.z,
      };
      this.swingYawToPeakDeg = this.swingYawAccumDeg;
    }

    if (linAccelMag > this.peakAccelG) this.peakAccelG = linAccelMag;
    if (gyroRateDps > this.peakGyroDps) {
      this.peakGyroDps = gyroRateDps;
      this.gyroPeakMs = nowMs;
      this.samplesSinceGyroPeak = 0;
    } else {
      this.samplesSinceGyroPeak += 1;
    }
    if (energy > this.peakEnergy) this.peakEnergy = energy;

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
        racketUp: {
          x: ahrsOut.worldRacketUp.x,
          y: ahrsOut.worldRacketUp.y,
          z: ahrsOut.worldRacketUp.z,
        },
        earlyYawDeg: this.swingYawAccumDeg,
        preSwingRelYawDeg: this.preSwingRelYawDeg,
        vLive: { x: this.vIntX, y: this.vIntY, z: this.vIntZ },
        peakAccelG: this.peakAccelG,
        peakGyroDps: this.peakGyroDps,
      };
    }

    // bleController.ts peak-hold termination rule:
    // End swing when spin drops below 60% of peak (after >= 45ms), OR 12 samples (~120ms)
    // pass without a new gyro peak, OR 190ms safety cap is reached.
    const passedGyroPeak =
      (elapsedMs >= 45 && gyroRateDps < 0.60 * this.peakGyroDps) ||
      this.samplesSinceGyroPeak >= 12;
    const maxWindowHit = elapsedMs >= 190;

    if (passedGyroPeak || maxWindowHit) {
      this.state = 'cooldown';
      this.cooldownUntilMs = nowMs + this.config.cooldownMs;
      this.cooldownMaxUntilMs = nowMs + this.config.cooldownMs + 200;
      this.quietSinceMs = null;

      const isFastGyroSwing = this.peakGyroDps >= this.config.armGyroDps;
      if (
        isFastGyroSwing
          ? this.peakAccelG < 0.40 || this.peakSpeedMps < 0.22
          : this.peakAccelG < this.config.dropAccelG * 0.90 ||
            this.peakGyroDps < this.config.dropGyroDps * 0.90 ||
            this.peakSpeedMps < this.config.dropMinSpeedMps
      ) {
        return null;
      }

      const contactPeakMs =
        this.gyroPeakMs >= this.swingStartMs
          ? Math.max(this.swingPeakMs, this.gyroPeakMs)
          : this.swingPeakMs;

      const rawSwing: RawClassifiedSwing = {
        swingStartMs: this.swingStartMs,
        swingPeakMs: contactPeakMs,
        swingEndMs: nowMs,
        vContact: { ...this.vContact },
        swingSpeedMps: this.peakSpeedMps,
        faceNormalAtPeak: { ...this.faceNormalAtPeak },
        racketUpAtPeak: { ...this.racketUpAtPeak },
        worldYawAccumDeg: this.swingYawAccumDeg,
        worldYawToPeakDeg: this.swingYawToPeakDeg,
        peakWorldYawDps: this.peakWorldYawDps,
        preSwingRelYawDeg: this.preSwingRelYawDeg,
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
   * Rewinds into the pre-trigger ring buffer (up to 95 ms for soft dropshots,
   * 55 ms for fast swings) to find the local acceleration minimum (`t_onset`),
   * then trapezoid-integrates 3D world velocity and world yaw cleanly from
   * `t_onset` to `nowMs`.
   */
  private armSwingFromRing(
    nowMs: number,
    linAccelMag: number,
    gyroRateDps: number,
    energy: number,
    worldYawDps: number,
    dtSec: number,
    curFaceNormal: Vec3,
    curRacketUp: Vec3,
    isSoftTrigger = false,
  ) {
    this.state = 'armed';
    this.dropPulseSinceMs = null;
    this.earlyGuessEmitted = false;
    this.pendingEarlyGuess = null;

    const rewindWindowMs = isSoftTrigger ? 95 : 55;

    // Find local |a| minimum within rewindWindowMs
    let onsetIdx = this.ring.length - 1;
    let minMag = Infinity;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (nowMs - this.ring[i].t > rewindWindowMs) break;
      if (this.ring[i].aMag <= minMag) {
        minMag = this.ring[i].aMag;
        onsetIdx = i;
      }
    }

    const onsetEntry = this.ring[onsetIdx];
    this.swingStartMs = onsetEntry ? onsetEntry.t : nowMs;
    this.armAccelAtStart = onsetEntry ? onsetEntry.aMag : linAccelMag;
    this.preSwingRelYawDeg = onsetEntry ? onsetEntry.relYawDeg : this.relYawDeg;

    // Integrate cleanly from t_onset -> nowMs
    this.vIntX = 0;
    this.vIntY = 0;
    this.vIntZ = 0;
    this.peakSpeedMps = 0;
    this.swingPeakMs = this.swingStartMs;
    this.peakAccelG = linAccelMag;
    this.peakGyroDps = gyroRateDps;
    this.gyroPeakMs = nowMs;
    this.samplesSinceGyroPeak = 0;
    this.peakEnergy = energy;
    this.swingYawAccumDeg = onsetEntry
      ? onsetEntry.worldYawDps * onsetEntry.dtSec
      : worldYawDps * dtSec;
    this.swingYawToPeakDeg = this.swingYawAccumDeg;
    this.peakWorldYawDps = onsetEntry ? onsetEntry.worldYawDps : worldYawDps;
    this.vContact = { x: 0, y: 0, z: 0 };
    this.faceNormalAtPeak = { ...curFaceNormal };
    this.racketUpAtPeak = { ...curRacketUp };

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

        this.swingYawAccumDeg += cur.worldYawDps * cur.dtSec;
        if (Math.abs(cur.worldYawDps) > Math.abs(this.peakWorldYawDps)) {
          this.peakWorldYawDps = cur.worldYawDps;
        }

        const spd = Math.hypot(this.vIntX, this.vIntY, this.vIntZ);
        if (spd >= this.peakSpeedMps) {
          this.peakSpeedMps = spd;
          this.swingPeakMs = cur.t;
          this.vContact = { x: this.vIntX, y: this.vIntY, z: this.vIntZ };
          this.faceNormalAtPeak = { ...cur.faceNormal };
          this.racketUpAtPeak = { ...cur.racketUp };
          this.swingYawToPeakDeg = this.swingYawAccumDeg;
        }
        if (cur.aMag > this.peakAccelG) this.peakAccelG = cur.aMag;
        if (cur.gyroDps >= this.peakGyroDps) {
          this.peakGyroDps = cur.gyroDps;
          this.gyroPeakMs = cur.t;
          this.samplesSinceGyroPeak = 0;
        }
      }
    }
  }
}
