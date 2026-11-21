import type {
  CalibrationPhase,
  GyroReading,
  HumanShotType,
  RawImuSample,
  StrokeWing,
} from '@shared/contracts';
import { OneEuroFilter } from './OneEuroFilter';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface ImuClassifierConfig {
  /** Dynamic acceleration (g) for a normal/fast swing */
  armAccelG: number;
  /** Bias-corrected gyro rate (deg/s) for a normal/fast swing */
  armGyroDps: number;
  /** Minimum dynamic acceleration (g) for a deliberate soft dropshot (blocks casual hand motion!) */
  dropAccelG: number;
  /** Minimum gyro rate (deg/s) for a deliberate soft dropshot */
  dropGyroDps: number;
  /** Max dynamic G mapped to power = 1.0 */
  maxAccelG: number;
  /** Max gyro rate (deg/s) mapped to power = 1.0 */
  maxGyroDps: number;
  /** Refractory cooldown after a completed swing (ms) — prevents follow-through & recovery double-hits */
  cooldownMs: number;
  /** Power cutoff below which a deliberate swing is classified as a dropshot (0..1) */
  dropshotPowerMax: number;
  /** Spin/vertical score below this classifies as slice; above classifies as topspin */
  sliceThreshold: number;
  /** Invert horizontal aim angle if needed */
  invertAngle: boolean;
  /** Invert topspin/slice axis if needed */
  invertRotation: boolean;
}

export const DEFAULT_IMU_CONFIG: ImuClassifierConfig = {
  armAccelG: 0.90,
  armGyroDps: 140,
  dropAccelG: 0.52,
  dropGyroDps: 80,
  maxAccelG: 3.6,
  maxGyroDps: 540,
  cooldownMs: 700,
  dropshotPowerMax: 0.43,
  sliceThreshold: -0.14,
  invertAngle: false,
  invertRotation: false,
};

export interface EarlySwingGuess {
  swingStartMs: number;
  nowMs: number;
  initialSpeed: number;
  imuBackswing: number;
  preFaceOpen: number;
  earlyVerticalG: number;
  peakAccelG: number;
  peakGyroDps: number;
}

export interface RawClassifiedSwing {
  swingStartMs: number;
  swingEndMs: number;
  power: number;
  angle: number;
  preFaceOpen: number;
  earlyVerticalG: number;
  peakAccelG: number;
  peakGyroDps: number;
  shotType: HumanShotType;
  rotation: number;
  confidence: number;
}

type SwingState = 'idle' | 'armed' | 'cooldown';

const ZERO_SAMPLES_REQUIRED = 25; // ~0.25s at 100 Hz

/**
 * Universal, zero-training M5Stack 6-axis IMU swing detector & shot classifier.
 * Designed to work out-of-the-box for ANY player or judge:
 *
 *  1. ZERO Pose: Player holds M5 horizontally across body like a tennis racket and
 *     presses ZERO (BtnA / UI / R). Locks true world-vertical UP (`uUp`), resting
 *     accel magnitude (`restAccelMag`), and gyro zero-bias (`gx/gy/gz`).
 *  2. Zero False Triggers: Casual arm movement & repositioning (~0.15–0.4g, 20–65°/s)
 *     is ignored. Only deliberate swings (soft dropshot tap OR full swing) trigger,
 *     with a 700ms refractory cooldown blocking follow-through double-hits.
 *  3. Universal Shot Classification (works for every grip, forehand & backhand):
 *       - DROPSHOT : deliberate low-power touch swing (`power <= dropshotPowerMax`)
 *       - TOPSPIN  : medium/fast swing moving LOW -> HIGH (webcam ΔarmY + IMU upward impulse + closed face)
 *       - SLICE    : medium/fast chop moving HIGH -> LOW (webcam ΔarmY + IMU downward impulse + open face)
 */
export class ImuSwingClassifier {
  private config: ImuClassifierConfig = { ...DEFAULT_IMU_CONFIG };

  private phase: CalibrationPhase = 'needs_zero';
  private zeroCount = 0;
  private zeroAccSumX = 0;
  private zeroAccSumY = 0;
  private zeroAccSumZ = 0;
  private zeroGyrSumX = 0;
  private zeroGyrSumY = 0;
  private zeroGyrSumZ = 0;

  private uUpX = 0;
  private uUpY = 0;
  private uUpZ = 1;
  private restAccelMag = 1.0;
  private restFaceAz = 0;

  private gxEst = 0;
  private gyEst = 0;
  private gzEst = 1;
  private initializedGravity = false;

  private gyroBiasX = 0;
  private gyroBiasY = 0;
  private gyroBiasZ = 0;
  private prevAx = 0;
  private prevAy = 0;
  private prevAz = 1;

  private preFaceHistory: number[] = [];
  private relYawDeg = 0;

  private lastSampleMs: number | null = null;
  private angleFilter = new OneEuroFilter(4.5, 0.35, 1.0);
  private rotFilter = new OneEuroFilter(4.5, 0.35, 1.0);

  private state: SwingState = 'idle';
  private swingStartMs = 0;
  private cooldownUntilMs = 0;
  private cooldownMaxUntilMs = 0;
  private quietSinceMs: number | null = null;
  private dropPulseSinceMs: number | null = null;
  private peakAccelG = 0;
  private peakGyroDps = 0;
  private peakEnergy = 0;
  private swingYawAccum = 0;
  private swingPreFaceOpen = 0;
  private earlyVerticalImpulse = 0;
  private earlyVerticalSamples = 0;
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
    this.relYawDeg = 0;
    this.preFaceHistory = [];
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
   * Universal wing-aware + webcam-fused shot classification.
   * Prioritizes grip-independent vertical swing path (low→high vs high→low)
   * plus wing-corrected racket face tilt and swing power.
   */
  resolveShot(
    swing: RawClassifiedSwing,
    wing: StrokeWing,
    webcamDeltaArmY = 0,
    hasWebcamData = false,
  ): { shotType: HumanShotType; rotation: number; confidence: number } {
    const rotSign = this.config.invertRotation ? -1 : 1;
    const wingFaceSign = wing === 'backhand' ? -1 : 1;

    // 1. Grip-invariant vertical swing path (primary for all users!)
    const brushScore = clamp(swing.earlyVerticalG / 1.1, -1, 1);
    const camVertScore = hasWebcamData ? clamp(webcamDeltaArmY / 0.12, -1, 1) : 0;

    // 2. Wing-corrected racket face tilt (open skyward = negative/slice, closed = positive/topspin)
    const faceScore = clamp(-swing.preFaceOpen * wingFaceSign * 1.5, -1, 1);

    let spinRotation: number;
    if (hasWebcamData && Math.abs(webcamDeltaArmY) > 0.025) {
      // When webcam sees clear upward/downward arm travel, trust it strongly (works for ANY grip!)
      spinRotation = clamp(
        rotSign * (camVertScore * 0.55 + brushScore * 0.25 + faceScore * 0.25),
        -1,
        1,
      );
    } else {
      // IMU-only fallback: blend vertical brush + face tilt
      spinRotation = clamp(rotSign * (brushScore * 0.55 + faceScore * 0.55), -1, 1);
    }

    let shotType: HumanShotType;
    let confidence: number;

    // A true Dropshot is genuinely soft in BOTH acceleration AND rotational speed.
    // Downward high->low slice chops partially cancel +1g gravity in |a|, so checking
    // peakGyroDps prevents crisp slices from being mislabeled as dropshots!
    const isSoftDropshot =
      swing.power <= this.config.dropshotPowerMax && swing.peakGyroDps < 210;

    if (isSoftDropshot) {
      shotType = 'dropshot';
      confidence = clamp(0.68 + (this.config.dropshotPowerMax - swing.power) * 0.9, 0.6, 0.96);
    } else if (spinRotation < this.config.sliceThreshold) {
      shotType = 'slice';
      confidence = clamp(0.62 + Math.abs(spinRotation - this.config.sliceThreshold) * 0.45, 0.55, 0.96);
    } else {
      shotType = 'topspin';
      confidence = clamp(0.62 + Math.abs(spinRotation - this.config.sliceThreshold) * 0.45, 0.55, 0.96);
    }

    this.lastClassifiedShot = shotType;
    return { shotType, rotation: spinRotation, confidence };
  }

  ingest(sample: RawImuSample, nowMs = performance.now()): RawClassifiedSwing | null {
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

    const accelMag = Math.hypot(sample.ax, sample.ay, sample.az);

    // Step A: Sampling ZERO pose (~0.25s)
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
        const mag = Math.max(0.2, Math.hypot(meanAx, meanAy, meanAz));

        this.restAccelMag = mag;
        this.uUpX = meanAx / mag;
        this.uUpY = meanAy / mag;
        this.uUpZ = meanAz / mag;
        this.restFaceAz = meanAz / mag;

        this.gxEst = meanAx;
        this.gyEst = meanAy;
        this.gzEst = meanAz;
        this.initializedGravity = true;

        this.gyroBiasX = this.zeroGyrSumX / this.zeroCount;
        this.gyroBiasY = this.zeroGyrSumY / this.zeroCount;
        this.gyroBiasZ = this.zeroGyrSumZ / this.zeroCount;

        this.relYawDeg = 0;
        this.preFaceHistory = [];
        this.angleFilter.reset(0);
        this.rotFilter.reset(0);
        this.phase = 'ready';
        this.state = 'idle';
      }
      return null;
    }

    // Step B: Locked until player holds racket horizontally across body & presses ZERO
    if (this.phase === 'needs_zero') {
      if (!this.initializedGravity) {
        this.gxEst = sample.ax;
        this.gyEst = sample.ay;
        this.gzEst = sample.az;
        this.restAccelMag = Math.max(0.5, accelMag);
        this.initializedGravity = true;
      }
      this.latestReading = {
        power: 0,
        rotation: 0,
        angle: 0,
        linearAccelG: Math.abs(accelMag - this.restAccelMag),
        gyroRateDps: 0,
        rawPitchDeg: 0,
        rawRollDeg: 0,
        rawYawDeg: 0,
      };
      return null;
    }

    // Step C: ZEROED & READY TO PLAY
    const gx = sample.gx - this.gyroBiasX;
    const gy = sample.gy - this.gyroBiasY;
    const gz = sample.gz - this.gyroBiasZ;

    // Orientation-invariant dynamic acceleration magnitude
    const dynAccelG = Math.abs(accelMag - this.restAccelMag);
    const gyroRateDps = Math.hypot(gx, gy, gz);

    // Smooth gravity vector tracker (NEVER freezes on rotation)
    if (this.state !== 'armed') {
      const gAlpha = dynAccelG < 0.25 ? 0.14 : 0.04;
      this.gxEst += gAlpha * (sample.ax - this.gxEst);
      this.gyEst += gAlpha * (sample.ay - this.gyEst);
      this.gzEst += gAlpha * (sample.az - this.gzEst);
    }

    const linAx = sample.ax - this.gxEst;
    const linAy = sample.ay - this.gyEst;
    const linAz = sample.az - this.gzEst;

    // Online gyro-bias tracking when genuinely stationary
    if (this.state === 'idle' && accelDelta < 0.05 && dynAccelG < 0.12 && gyroRateDps < 16) {
      const bAlpha = 0.02;
      this.gyroBiasX += bAlpha * (sample.gx - this.gyroBiasX);
      this.gyroBiasY += bAlpha * (sample.gy - this.gyroBiasY);
      this.gyroBiasZ += bAlpha * (sample.gz - this.gyroBiasZ);
    }

    const gMag = Math.max(0.2, Math.hypot(this.gxEst, this.gyEst, this.gzEst));
    const faceOpen = clamp(this.gzEst / gMag - this.restFaceAz, -1, 1);

    if (this.state === 'idle') {
      this.preFaceHistory.push(faceOpen);
      if (this.preFaceHistory.length > 12) this.preFaceHistory.shift();
    }

    const worldYawDps = gx * this.uUpX + gy * this.uUpY + gz * this.uUpZ;
    const verticalAccelG = linAx * this.uUpX + linAy * this.uUpY + linAz * this.uUpZ;

    const cleanYawRate = Math.abs(worldYawDps) > 4.0 ? worldYawDps : 0;
    this.relYawDeg = clamp(this.relYawDeg + cleanYawRate * dtSec, -75, 75);
    if (this.state === 'idle' && dynAccelG < 0.15 && gyroRateDps < 15) {
      this.relYawDeg *= 1 - 0.4 * dtSec;
    }

    const yawSign = this.config.invertAngle ? 1 : -1;
    const rotSign = this.config.invertRotation ? -1 : 1;

    const rawAngle = clamp((yawSign * this.relYawDeg) / 45, -1, 1);
    const liveSpinBias = clamp(rotSign * (-faceOpen * 1.5), -1, 1);

    const filteredAngle = this.angleFilter.filter(rawAngle, nowMs);
    const filteredRotation = this.rotFilter.filter(liveSpinBias, nowMs);
    const livePower = this.computePower(dynAccelG, gyroRateDps);

    this.latestReading = {
      power: livePower,
      rotation: filteredRotation,
      angle: filteredAngle,
      linearAccelG: dynAccelG,
      gyroRateDps,
      rawPitchDeg: faceOpen * 90,
      rawRollDeg: faceOpen * 90,
      rawYawDeg: this.relYawDeg,
    };

    // Single-trigger-per-swing state machine (strict anti-false-trigger + hard ceiling)
    if (this.state === 'cooldown') {
      const isQuiet = dynAccelG < 0.30 && gyroRateDps < 60;
      if (isQuiet) {
        if (this.quietSinceMs === null) this.quietSinceMs = nowMs;
      } else {
        this.quietSinceMs = null;
      }

      const quietUnlocked =
        nowMs >= this.cooldownUntilMs &&
        this.quietSinceMs !== null &&
        nowMs - this.quietSinceMs >= 80;
      const ceilingUnlocked = nowMs >= this.cooldownMaxUntilMs;

      if (quietUnlocked || ceilingUnlocked) {
        this.state = 'idle';
        this.quietSinceMs = null;
        this.dropPulseSinceMs = null;
      }
      return null;
    }

    const energy =
      dynAccelG / Math.max(0.2, this.config.armAccelG) +
      gyroRateDps / Math.max(20, this.config.armGyroDps);

    if (this.state === 'idle') {
      // Path 1: Clear full/medium swing — requires BOTH real accel AND real whip
      // (or a sharp wrist snap >= 210 deg/s with >= 0.38g)
      const fullSwing =
        (dynAccelG >= this.config.armAccelG && gyroRateDps >= this.config.armGyroDps) ||
        (gyroRateDps >= this.config.armGyroDps * 1.55 && dynAccelG >= 0.38);

      // Path 2: Deliberate soft dropshot — requires BOTH moderate accel AND gyro sustained >= 35ms
      // Casual arm repositioning (~0.2g / 35°/s) will NEVER cross this!
      const deliberateDrop =
        dynAccelG >= this.config.dropAccelG && gyroRateDps >= this.config.dropGyroDps;

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

      if (fullSwing || softSwingArmed) {
        this.state = 'armed';
        this.swingStartMs = this.dropPulseSinceMs ?? nowMs;
        this.dropPulseSinceMs = null;
        this.peakAccelG = dynAccelG;
        this.peakGyroDps = gyroRateDps;
        this.peakEnergy = energy;
        this.swingYawAccum = cleanYawRate * dtSec;

        if (this.preFaceHistory.length > 0) {
          const sum = this.preFaceHistory.reduce((a, b) => a + b, 0);
          this.swingPreFaceOpen = sum / this.preFaceHistory.length;
        } else {
          this.swingPreFaceOpen = faceOpen;
        }

        this.earlyVerticalImpulse = verticalAccelG;
        this.earlyVerticalSamples = 1;
        this.earlyGuessEmitted = false;
        this.pendingEarlyGuess = null;
      }
      return null;
    }

    // state === 'armed'
    if (dynAccelG > this.peakAccelG) this.peakAccelG = dynAccelG;
    if (gyroRateDps > this.peakGyroDps) this.peakGyroDps = gyroRateDps;
    if (energy > this.peakEnergy) this.peakEnergy = energy;

    this.swingYawAccum += cleanYawRate * dtSec;

    const elapsedMs = nowMs - this.swingStartMs;
    if (elapsedMs <= 70) {
      this.earlyVerticalImpulse += verticalAccelG;
      this.earlyVerticalSamples += 1;
    }

    // Emit one early animation anticipation guess ~25ms into a deliberate swing
    if (!this.earlyGuessEmitted && elapsedMs >= 25) {
      this.earlyGuessEmitted = true;
      const initialSpeed = clamp(this.computePower(this.peakAccelG, this.peakGyroDps), 0.16, 1);
      this.pendingEarlyGuess = {
        swingStartMs: this.swingStartMs,
        nowMs,
        initialSpeed,
        imuBackswing: clamp(Math.abs(this.relYawDeg) / 45, 0.15, 1),
        preFaceOpen: this.swingPreFaceOpen,
        earlyVerticalG: this.earlyVerticalImpulse / Math.max(1, this.earlyVerticalSamples),
        peakAccelG: this.peakAccelG,
        peakGyroDps: this.peakGyroDps,
      };
    }

    const passedPeak = elapsedMs >= 60 && energy < this.peakEnergy * 0.52;
    const maxWindowHit = elapsedMs >= 200;

    if (passedPeak || maxWindowHit) {
      this.state = 'cooldown';
      this.cooldownUntilMs = nowMs + this.config.cooldownMs;
      this.cooldownMaxUntilMs = nowMs + this.config.cooldownMs + 250;
      this.quietSinceMs = null;

      // Reject anything below the deliberate dropshot floor
      if (
        this.peakAccelG < this.config.dropAccelG &&
        this.peakGyroDps < this.config.armGyroDps * 1.4
      ) {
        return null;
      }

      const power = clamp(this.computePower(this.peakAccelG, this.peakGyroDps), 0.16, 1);
      const swingYawComponent = clamp((yawSign * this.swingYawAccum) / 38, -1, 1);
      const aimAngle = clamp(filteredAngle * 0.5 + swingYawComponent * 0.65, -1, 1);
      const earlyVerticalG = this.earlyVerticalImpulse / Math.max(1, this.earlyVerticalSamples);

      const rawSwing: RawClassifiedSwing = {
        swingStartMs: this.swingStartMs,
        swingEndMs: nowMs,
        power,
        angle: aimAngle,
        preFaceOpen: this.swingPreFaceOpen,
        earlyVerticalG,
        peakAccelG: this.peakAccelG,
        peakGyroDps: this.peakGyroDps,
        shotType: 'topspin',
        rotation: 0,
        confidence: 0.75,
      };

      const resolved = this.resolveShot(rawSwing, 'forehand', 0, false);
      rawSwing.shotType = resolved.shotType;
      rawSwing.rotation = resolved.rotation;
      rawSwing.confidence = resolved.confidence;

      return rawSwing;
    }

    return null;
  }

  private computePower(dynAccelG: number, gyroDps: number): number {
    const aNorm = clamp(dynAccelG / Math.max(0.5, this.config.maxAccelG), 0, 1);
    const gNorm = clamp(gyroDps / Math.max(50, this.config.maxGyroDps), 0, 1);
    return clamp(aNorm * 0.5 + gNorm * 0.5, 0, 1);
  }
}
