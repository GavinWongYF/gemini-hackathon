import type {
  CalibrationPhase,
  GyroReading,
  HumanShotType,
  RawImuSample,
} from '@shared/contracts';
import { OneEuroFilter } from './OneEuroFilter';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface ImuClassifierConfig {
  /** Linear acceleration threshold (in g, gravity removed) required to arm a swing */
  armAccelG: number;
  /** Bias-corrected angular velocity threshold (deg/s) required to arm a swing */
  armGyroDps: number;
  /** Max linear G mapped to power = 1.0 */
  maxAccelG: number;
  /** Max gyro rate (deg/s) mapped to power = 1.0 */
  maxGyroDps: number;
  /** Refractory cooldown after a completed swing (ms) — blocks follow-through double-triggers */
  cooldownMs: number;
  /** Max power classified as a soft dropshot (0..1) */
  dropshotPowerMax: number;
  /** Spin score below this threshold classifies as slice; above classifies as topspin */
  sliceRotationThreshold: number;
  /** Invert horizontal aim angle if needed */
  invertAngle: boolean;
  /** Invert topspin/slice axis if screen faces away vs toward player */
  invertRotation: boolean;
}

export const DEFAULT_IMU_CONFIG: ImuClassifierConfig = {
  armAccelG: 1.45,
  armGyroDps: 175,
  maxAccelG: 4.5,
  maxGyroDps: 650,
  cooldownMs: 650,
  dropshotPowerMax: 0.42,
  sliceRotationThreshold: -0.14,
  invertAngle: false,
  invertRotation: false,
};

export interface ClassifiedSwing {
  shotType: HumanShotType;
  power: number;
  rotation: number;
  angle: number;
  peakAccelG: number;
  peakGyroDps: number;
}

type SwingState = 'idle' | 'armed' | 'cooldown';

const ZERO_SAMPLES_REQUIRED = 28; // ~0.28s at 100 Hz

/**
 * Orientation-invariant M5Stack 6-axis IMU swing detector & shot classifier.
 *
 * Calibrated at the player's ZERO pose (holding M5 like a tennis racket in front
 * of body, screen facing horizontally across body):
 *  - `uUp`: world-vertical unit vector from resting gravity
 *  - `restFaceDot`: resting racket-face tilt (`az`, screen normal vs gravity)
 *  - `gyroBias`: resting MPU6886 gyro offset
 *
 * Accurate Topspin vs Slice vs Dropshot classification:
 *  1. DROPSHOT: soft / controlled swing (`power <= dropshotPowerMax`).
 *  2. TOPSPIN vs SLICE: combines TWO clean physical cues without deceleration cancellation:
 *     - Racket face tilt right BEFORE impact (from a rolling 100ms pre-swing buffer):
 *       tilting the screen/racket face UP toward the sky = OPEN face (slice);
 *       keeping it vertical or tilted DOWN = CLOSED face (topspin).
 *     - First-60ms vertical impulse along `uUp` (ONLY acceleration phase, never averaged
 *       with follow-through deceleration!): upward low-to-high = topspin (+),
 *       downward high-to-low chop = slice (-).
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

  // Calibrated world-vertical unit vector in sensor frame (at ZERO pose)
  private uUpX = 0;
  private uUpY = 0;
  private uUpZ = 1;
  // Resting screen normal tilt (az at ZERO; +1 = screen facing ceiling, 0 = vertical, -1 = floor)
  private restFaceAz = 0;

  // Live gravity estimate (g)
  private gxEst = 0;
  private gyEst = 0;
  private gzEst = 1;
  private initializedGravity = false;

  // Calibrated gyro zero-bias (deg/s)
  private gyroBiasX = 0;
  private gyroBiasY = 0;
  private gyroBiasZ = 0;
  private prevAx = 0;
  private prevAy = 0;
  private prevAz = 1;

  // Rolling pre-swing buffer of racket face tilt (screen az relative to ZERO)
  // Captures the true racket face orientation right as the player approaches the ball!
  private preFaceHistory: number[] = [];

  // Relative integrated yaw angle since ZERO (degrees)
  private relYawDeg = 0;

  private lastSampleMs: number | null = null;
  private angleFilter = new OneEuroFilter(5.0, 0.45, 1.0);
  private rotFilter = new OneEuroFilter(5.0, 0.45, 1.0);

  // Swing peak state machine
  private state: SwingState = 'idle';
  private swingStartMs = 0;
  private cooldownUntilMs = 0;
  private quietSinceMs: number | null = null;
  private peakAccelG = 0;
  private peakGyroDps = 0;
  private peakEnergy = 0;
  private swingYawAccum = 0;
  private swingPreFaceOpen = 0; // + = tilted toward ceiling (open/slice), - = closed/topspin
  private earlyVerticalImpulse = 0; // First 60ms only (+ = low-to-high topspin, - = high-to-low slice)
  private earlyVerticalSamples = 0;

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

  resetToNeedsZero() {
    this.phase = 'needs_zero';
    this.zeroCount = 0;
    this.state = 'idle';
  }

  getLatestReading(): GyroReading {
    return this.latestReading;
  }

  getLastShotType(): HumanShotType {
    return this.lastClassifiedShot;
  }

  ingest(sample: RawImuSample, nowMs = performance.now()): ClassifiedSwing | null {
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

    // Step A: Sampling ZERO pose
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
        const mag = Math.max(0.1, Math.hypot(meanAx, meanAy, meanAz));

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

    // Step B: Locked until player presses ZERO
    if (this.phase === 'needs_zero') {
      if (!this.initializedGravity) {
        this.gxEst = sample.ax;
        this.gyEst = sample.ay;
        this.gzEst = sample.az;
        this.initializedGravity = true;
      } else {
        this.gxEst += 0.1 * (sample.ax - this.gxEst);
        this.gyEst += 0.1 * (sample.ay - this.gyEst);
        this.gzEst += 0.1 * (sample.az - this.gzEst);
      }
      const linG = Math.hypot(
        sample.ax - this.gxEst,
        sample.ay - this.gyEst,
        sample.az - this.gzEst,
      );
      this.latestReading = {
        power: 0,
        rotation: 0,
        angle: 0,
        linearAccelG: linG,
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

    if (this.state !== 'armed') {
      const gAlpha = 0.1;
      this.gxEst += gAlpha * (sample.ax - this.gxEst);
      this.gyEst += gAlpha * (sample.ay - this.gyEst);
      this.gzEst += gAlpha * (sample.az - this.gzEst);
    }

    const linAx = sample.ax - this.gxEst;
    const linAy = sample.ay - this.gyEst;
    const linAz = sample.az - this.gzEst;
    const linearAccelG = Math.hypot(linAx, linAy, linAz);
    const gyroRateDps = Math.hypot(gx, gy, gz);

    // Slow online gyro bias tracking when genuinely still
    if (this.state === 'idle' && accelDelta < 0.06 && linearAccelG < 0.14 && gyroRateDps < 18) {
      const bAlpha = 0.02;
      this.gyroBiasX += bAlpha * (sample.gx - this.gyroBiasX);
      this.gyroBiasY += bAlpha * (sample.gy - this.gyroBiasY);
      this.gyroBiasZ += bAlpha * (sample.gz - this.gyroBiasZ);
    }

    // Live racket face tilt relative to ZERO pose:
    // Using gravity estimate's Z component (screen normal):
    //   faceOpen > 0 => screen tilted UP toward sky (open racket face -> SLICE)
    //   faceOpen < 0 => screen tilted DOWN toward floor (closed racket face -> TOPSPIN)
    const gMag = Math.max(0.1, Math.hypot(this.gxEst, this.gyEst, this.gzEst));
    const faceOpen = clamp((this.gzEst / gMag) - this.restFaceAz, -1, 1);

    if (this.state === 'idle') {
      this.preFaceHistory.push(faceOpen);
      if (this.preFaceHistory.length > 12) this.preFaceHistory.shift();
    }

    // World-vertical yaw rate (turning racket left/right around vertical axis)
    const worldYawDps = gx * this.uUpX + gy * this.uUpY + gz * this.uUpZ;
    // Vertical linear accel along calibrated world UP (+ = low-to-high, - = high-to-low)
    const verticalAccelG = linAx * this.uUpX + linAy * this.uUpY + linAz * this.uUpZ;

    const cleanYawRate = Math.abs(worldYawDps) > 4.0 ? worldYawDps : 0;
    this.relYawDeg = clamp(this.relYawDeg + cleanYawRate * dtSec, -75, 75);
    if (this.state === 'idle' && linearAccelG < 0.2 && gyroRateDps < 15) {
      this.relYawDeg *= 1 - 0.4 * dtSec;
    }

    const yawSign = this.config.invertAngle ? 1 : -1;
    const rotSign = this.config.invertRotation ? -1 : 1;

    // Live rotation preview: negative = open face (slice), positive = closed face (topspin)
    const rawAngle = clamp((yawSign * this.relYawDeg) / 45, -1, 1);
    const liveSpinBias = clamp(rotSign * (-faceOpen * 1.65), -1, 1);

    const filteredAngle = this.angleFilter.filter(rawAngle, nowMs);
    const filteredRotation = this.rotFilter.filter(liveSpinBias, nowMs);
    const livePower = this.computePower(linearAccelG, gyroRateDps);

    this.latestReading = {
      power: livePower,
      rotation: filteredRotation,
      angle: filteredAngle,
      linearAccelG,
      gyroRateDps,
      rawPitchDeg: faceOpen * 90,
      rawRollDeg: faceOpen * 90,
      rawYawDeg: this.relYawDeg,
    };

    // Single-trigger-per-swing state machine
    if (this.state === 'cooldown') {
      const isQuiet =
        linearAccelG < this.config.armAccelG * 0.55 && gyroRateDps < this.config.armGyroDps * 0.55;
      if (isQuiet) {
        if (this.quietSinceMs === null) this.quietSinceMs = nowMs;
      } else {
        this.quietSinceMs = null;
      }

      if (
        nowMs >= this.cooldownUntilMs &&
        this.quietSinceMs !== null &&
        nowMs - this.quietSinceMs >= 80
      ) {
        this.state = 'idle';
        this.quietSinceMs = null;
      }
      return null;
    }

    const energy =
      linearAccelG / Math.max(0.2, this.config.armAccelG) +
      gyroRateDps / Math.max(20, this.config.armGyroDps);

    if (this.state === 'idle') {
      const hasAccel = linearAccelG >= this.config.armAccelG;
      const hasGyro = gyroRateDps >= this.config.armGyroDps;
      // Soft dropshot touch: lower accel + moderate wrist tap
      const softTap =
        linearAccelG >= this.config.armAccelG * 0.58 &&
        gyroRateDps >= this.config.armGyroDps * 0.72;

      if ((hasAccel && hasGyro) || softTap) {
        this.state = 'armed';
        this.swingStartMs = nowMs;
        this.peakAccelG = linearAccelG;
        this.peakGyroDps = gyroRateDps;
        this.peakEnergy = energy;
        this.swingYawAccum = cleanYawRate * dtSec;

        // Snapshot racket face tilt from the clean 100ms approach right BEFORE impact!
        if (this.preFaceHistory.length > 0) {
          const sum = this.preFaceHistory.reduce((a, b) => a + b, 0);
          this.swingPreFaceOpen = sum / this.preFaceHistory.length;
        } else {
          this.swingPreFaceOpen = faceOpen;
        }

        // Capture ONLY the early acceleration phase (first 60ms) so deceleration doesn't cancel it!
        this.earlyVerticalImpulse = verticalAccelG;
        this.earlyVerticalSamples = 1;
      }
      return null;
    }

    // state === 'armed'
    if (linearAccelG > this.peakAccelG) this.peakAccelG = linearAccelG;
    if (gyroRateDps > this.peakGyroDps) this.peakGyroDps = gyroRateDps;
    if (energy > this.peakEnergy) this.peakEnergy = energy;

    this.swingYawAccum += cleanYawRate * dtSec;

    const elapsedMs = nowMs - this.swingStartMs;
    if (elapsedMs <= 60) {
      this.earlyVerticalImpulse += verticalAccelG;
      this.earlyVerticalSamples += 1;
    }

    const passedPeak = elapsedMs >= 65 && energy < this.peakEnergy * 0.5;
    const maxWindowHit = elapsedMs >= 160;

    if (passedPeak || maxWindowHit) {
      this.state = 'cooldown';
      this.cooldownUntilMs = nowMs + this.config.cooldownMs;
      this.quietSinceMs = null;

      if (
        this.peakAccelG < this.config.armAccelG * 0.58 &&
        this.peakGyroDps < this.config.armGyroDps * 0.72
      ) {
        return null;
      }

      const power = clamp(this.computePower(this.peakAccelG, this.peakGyroDps), 0.18, 1);

      const swingYawComponent = clamp((yawSign * this.swingYawAccum) / 38, -1, 1);
      const aimAngle = clamp(filteredAngle * 0.5 + swingYawComponent * 0.65, -1, 1);

      // Clean spin score (+1 = heavy topspin, -1 = heavy slice):
      // 1) Pre-impact racket face angle (-faceOpen: open/skyward = negative/slice, closed/downward = positive/topspin)
      // 2) First-60ms vertical swing brush (+ = low-to-high topspin, - = high-to-low slice)
      const faceScore = clamp(-this.swingPreFaceOpen * 1.85, -1, 1);
      const avgEarlyVertG = this.earlyVerticalImpulse / Math.max(1, this.earlyVerticalSamples);
      const brushScore = clamp(avgEarlyVertG / 1.3, -1, 1);

      // Weight racket face tilt strongly (65%) + early vertical swing path (35%)
      const spinRotation = clamp(rotSign * (faceScore * 0.65 + brushScore * 0.45), -1, 1);

      const shotType = this.classifyShotType(power, spinRotation);
      this.lastClassifiedShot = shotType;

      return {
        shotType,
        power,
        rotation: spinRotation,
        angle: aimAngle,
        peakAccelG: this.peakAccelG,
        peakGyroDps: this.peakGyroDps,
      };
    }

    return null;
  }

  private computePower(accelG: number, gyroDps: number): number {
    const aNorm = clamp(accelG / Math.max(0.5, this.config.maxAccelG), 0, 1);
    const gNorm = clamp(gyroDps / Math.max(50, this.config.maxGyroDps), 0, 1);
    return clamp(aNorm * 0.5 + gNorm * 0.5, 0, 1);
  }

  private classifyShotType(power: number, rotation: number): HumanShotType {
    if (power <= this.config.dropshotPowerMax) {
      return 'dropshot';
    }
    if (rotation < this.config.sliceRotationThreshold) {
      return 'slice';
    }
    return 'topspin';
  }
}
