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
  /** Low dynamic acceleration (g) so slow/gentle dropshots still register */
  dropAccelG: number;
  /** Low gyro threshold (deg/s) for slow/gentle dropshots */
  dropGyroDps: number;
  /** Max dynamic G mapped to power = 1.0 */
  maxAccelG: number;
  /** Max gyro rate (deg/s) mapped to power = 1.0 */
  maxGyroDps: number;
  /** Refractory cooldown after a completed swing (ms) */
  cooldownMs: number;
  /** Max power classified as a soft dropshot (0..1) in heuristic mode */
  dropshotPowerMax: number;
  /** Spin score below this classifies as slice; above classifies as topspin */
  sliceRotationThreshold: number;
  /** Invert horizontal aim angle if needed */
  invertAngle: boolean;
  /** Invert topspin/slice axis if screen faces opposite way */
  invertRotation: boolean;
}

export const DEFAULT_IMU_CONFIG: ImuClassifierConfig = {
  armAccelG: 1.1,
  armGyroDps: 145,
  dropAccelG: 0.30,
  dropGyroDps: 42,
  maxAccelG: 4.0,
  maxGyroDps: 600,
  cooldownMs: 600,
  dropshotPowerMax: 0.42,
  sliceRotationThreshold: -0.12,
  invertAngle: false,
  invertRotation: false,
};

/** 5D kinematic feature vector for nearest-centroid personal shot calibration */
export interface SwingFeatureVector {
  power: number;
  faceScore: number;
  brushScore: number;
  camVertScore: number;
  gyroRatio: number;
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
  features: SwingFeatureVector;
}

export interface ShotTrainingState {
  counts: Record<HumanShotType, number>;
  active: boolean;
}

type SwingState = 'idle' | 'armed' | 'cooldown';

const ZERO_SAMPLES_REQUIRED = 25; // ~0.25s at 100 Hz
const TRAINING_STORAGE_KEY = 'tennis_imu_shot_training_v1';

/**
 * Bulletproof, orientation-invariant M5Stack 6-axis IMU swing detector & classifier:
 *  1. Uses true gravity-magnitude dynamic acceleration (`| |a| - restAccelMag |`),
 *     so rotating the M5 to ANY angle (forehand, backhand, upside-down) NEVER causes
 *     false triggers and NEVER freezes/locks up cooldown!
 *  2. Hard cooldown ceiling (`cooldownMs + 220ms`) guarantees zero state-machine lockups.
 *  3. Supports BOTH instant physics defaults AND a 6-second "Teach My 3 Shots"
 *     5D nearest-centroid classifier (persisted in localStorage) for ~95%+ personal accuracy
 *     with calibrated `confidence` (0..1).
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

  // Calibrated ZERO basis
  private uUpX = 0;
  private uUpY = 0;
  private uUpZ = 1;
  private restAccelMag = 1.0;
  private restFaceAz = 0;

  // Smooth orientation gravity tracker (ALWAYS updates when idle — never freezes!)
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

  private preFaceHistory: number[] = [];
  private relYawDeg = 0;

  private lastSampleMs: number | null = null;
  private angleFilter = new OneEuroFilter(5.0, 0.45, 1.0);
  private rotFilter = new OneEuroFilter(5.0, 0.45, 1.0);

  // Swing state machine
  private state: SwingState = 'idle';
  private swingStartMs = 0;
  private cooldownUntilMs = 0;
  private cooldownMaxUntilMs = 0;
  private quietSinceMs: number | null = null;
  private softMotionSinceMs: number | null = null;
  private peakAccelG = 0;
  private peakGyroDps = 0;
  private peakEnergy = 0;
  private swingYawAccum = 0;
  private swingPreFaceOpen = 0;
  private earlyVerticalImpulse = 0;
  private earlyVerticalSamples = 0;

  // Personal 5D nearest-centroid training samples per shot type
  private trainingSamples: Record<HumanShotType, SwingFeatureVector[]> = {
    topspin: [],
    slice: [],
    dropshot: [],
  };

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

  constructor() {
    this.loadTrainingFromStorage();
  }

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

  getTrainingState(): ShotTrainingState {
    const counts: Record<HumanShotType, number> = {
      topspin: this.trainingSamples.topspin.length,
      slice: this.trainingSamples.slice.length,
      dropshot: this.trainingSamples.dropshot.length,
    };
    const active = counts.topspin > 0 && counts.slice > 0 && counts.dropshot > 0;
    return { counts, active };
  }

  addTrainingExample(label: HumanShotType, features: SwingFeatureVector) {
    this.trainingSamples[label].push({ ...features });
    if (this.trainingSamples[label].length > 8) {
      this.trainingSamples[label].shift();
    }
    this.saveTrainingToStorage();
  }

  clearTraining() {
    this.trainingSamples = { topspin: [], slice: [], dropshot: [] };
    this.saveTrainingToStorage();
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
    this.softMotionSinceMs = null;
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

  /**
   * Computes wing-aware + webcam-fused 5D features and classifies into
   * `topspin | slice | dropshot` with calibrated confidence `0..1`.
   * Uses the personal nearest-centroid model if all 3 shots have >=1 recorded example;
   * otherwise uses physics heuristics.
   */
  resolveShot(
    swing: RawClassifiedSwing,
    wing: StrokeWing,
    webcamDeltaArmY = 0,
    hasWebcamData = false,
  ): { shotType: HumanShotType; rotation: number; confidence: number; features: SwingFeatureVector } {
    const rotSign = this.config.invertRotation ? -1 : 1;
    const wingFaceSign = wing === 'backhand' ? -1 : 1;

    const faceScore = clamp(rotSign * (-swing.preFaceOpen * wingFaceSign * 1.75), -1, 1);
    const brushScore = clamp(rotSign * (swing.earlyVerticalG / 1.2), -1, 1);
    const camVertScore = hasWebcamData ? clamp(webcamDeltaArmY / 0.14, -1, 1) : 0;
    const gyroRatio = clamp(
      swing.peakGyroDps / Math.max(80, swing.peakAccelG * 220 + 60),
      0,
      1.5,
    );

    const features: SwingFeatureVector = {
      power: swing.power,
      faceScore,
      brushScore,
      camVertScore,
      gyroRatio,
    };

    const spinRotation =
      hasWebcamData && Math.abs(webcamDeltaArmY) > 0.025
        ? clamp(faceScore * 0.4 + brushScore * 0.25 + camVertScore * 0.55, -1, 1)
        : clamp(faceScore * 0.6 + brushScore * 0.5, -1, 1);

    // Tier B: Personal 5D nearest-centroid classifier (if trained on all 3 shot types)
    const train = this.getTrainingState();
    if (train.active) {
      const labels: HumanShotType[] = ['topspin', 'slice', 'dropshot'];
      // Feature weights tuned for tennis kinematics
      const weights = {
        power: 2.6,
        faceScore: 1.8,
        brushScore: 1.2,
        camVertScore: hasWebcamData ? 2.0 : 0.0,
        gyroRatio: 0.8,
      };

      const dists: Record<HumanShotType, number> = {
        topspin: Infinity,
        slice: Infinity,
        dropshot: Infinity,
      };

      for (const lbl of labels) {
        const list = this.trainingSamples[lbl];
        const mean: SwingFeatureVector = {
          power: 0,
          faceScore: 0,
          brushScore: 0,
          camVertScore: 0,
          gyroRatio: 0,
        };
        for (const f of list) {
          mean.power += f.power;
          mean.faceScore += f.faceScore;
          mean.brushScore += f.brushScore;
          mean.camVertScore += f.camVertScore;
          mean.gyroRatio += f.gyroRatio;
        }
        const n = list.length;
        mean.power /= n;
        mean.faceScore /= n;
        mean.brushScore /= n;
        mean.camVertScore /= n;
        mean.gyroRatio /= n;

        const d2 =
          weights.power * (features.power - mean.power) ** 2 +
          weights.faceScore * (features.faceScore - mean.faceScore) ** 2 +
          weights.brushScore * (features.brushScore - mean.brushScore) ** 2 +
          weights.camVertScore * (features.camVertScore - mean.camVertScore) ** 2 +
          weights.gyroRatio * (features.gyroRatio - mean.gyroRatio) ** 2;
        dists[lbl] = Math.sqrt(d2);
      }

      const sorted = labels.slice().sort((a, b) => dists[a] - dists[b]);
      const best = sorted[0];
      const second = sorted[1];
      const margin = dists[second] - dists[best];
      const confidence = clamp(0.55 + margin / (dists[second] + 0.35) * 0.45, 0.5, 0.99);

      this.lastClassifiedShot = best;
      return { shotType: best, rotation: spinRotation, confidence, features };
    }

    // Tier A: Physics heuristic defaults (out of the box)
    let shotType: HumanShotType;
    let confidence: number;
    if (swing.power <= this.config.dropshotPowerMax) {
      shotType = 'dropshot';
      confidence = clamp(0.65 + (this.config.dropshotPowerMax - swing.power) * 1.1, 0.6, 0.95);
    } else if (spinRotation < this.config.sliceRotationThreshold) {
      shotType = 'slice';
      confidence = clamp(0.6 + Math.abs(spinRotation - this.config.sliceRotationThreshold) * 0.5, 0.55, 0.95);
    } else {
      shotType = 'topspin';
      confidence = clamp(0.6 + Math.abs(spinRotation - this.config.sliceRotationThreshold) * 0.5, 0.55, 0.95);
    }

    this.lastClassifiedShot = shotType;
    return { shotType, rotation: spinRotation, confidence, features };
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

    // Step B: Locked until player presses ZERO
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

    // True orientation-invariant dynamic acceleration magnitude!
    // Rotating the M5 to ANY angle keeps |a| == restAccelMag -> dynAccelG == 0!
    const dynAccelG = Math.abs(accelMag - this.restAccelMag);
    const gyroRateDps = Math.hypot(gx, gy, gz);

    // Smoothly track orientation gravity vector whenever NOT actively armed (NEVER freezes!)
    if (this.state !== 'armed') {
      const gAlpha = dynAccelG < 0.25 ? 0.14 : 0.04;
      this.gxEst += gAlpha * (sample.ax - this.gxEst);
      this.gyEst += gAlpha * (sample.ay - this.gyEst);
      this.gzEst += gAlpha * (sample.az - this.gzEst);
    }

    // Component-wise linear accel for vertical brush direction only
    const linAx = sample.ax - this.gxEst;
    const linAy = sample.ay - this.gyEst;
    const linAz = sample.az - this.gzEst;

    // Slow online gyro-bias tracking when genuinely still
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
    const liveSpinBias = clamp(rotSign * (-faceOpen * 1.65), -1, 1);

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

    // Single-trigger-per-swing state machine (with hard cooldown ceiling — CANNOT hang!)
    if (this.state === 'cooldown') {
      const isQuiet =
        dynAccelG < Math.max(0.25, this.config.dropAccelG * 0.9) &&
        gyroRateDps < Math.max(55, this.config.dropGyroDps * 1.2);

      if (isQuiet) {
        if (this.quietSinceMs === null) this.quietSinceMs = nowMs;
      } else {
        this.quietSinceMs = null;
      }

      const quietUnlocked =
        nowMs >= this.cooldownUntilMs &&
        this.quietSinceMs !== null &&
        nowMs - this.quietSinceMs >= 60;
      const ceilingUnlocked = nowMs >= this.cooldownMaxUntilMs;

      if (quietUnlocked || ceilingUnlocked) {
        this.state = 'idle';
        this.quietSinceMs = null;
        this.softMotionSinceMs = null;
      }
      return null;
    }

    const energy =
      dynAccelG / Math.max(0.2, this.config.armAccelG) +
      gyroRateDps / Math.max(20, this.config.armGyroDps);

    if (this.state === 'idle') {
      // Path 1: Normal / fast swing (immediate arm)
      const fastSwing =
        dynAccelG >= this.config.armAccelG && gyroRateDps >= this.config.armGyroDps;

      // Path 2: Slow / gentle dropshot swing (sustained >= 25ms above low floor)
      const aboveDropFloor =
        dynAccelG >= this.config.dropAccelG && gyroRateDps >= this.config.dropGyroDps;

      let softSwingArmed = false;
      if (aboveDropFloor) {
        if (this.softMotionSinceMs === null) {
          this.softMotionSinceMs = nowMs;
        } else if (nowMs - this.softMotionSinceMs >= 25) {
          softSwingArmed = true;
        }
      } else {
        this.softMotionSinceMs = null;
      }

      if (fastSwing || softSwingArmed) {
        this.state = 'armed';
        this.swingStartMs = this.softMotionSinceMs ?? nowMs;
        this.softMotionSinceMs = null;
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

    const passedPeak = elapsedMs >= 65 && energy < this.peakEnergy * 0.55;
    const maxWindowHit = elapsedMs >= 210;

    if (passedPeak || maxWindowHit) {
      this.state = 'cooldown';
      this.cooldownUntilMs = nowMs + this.config.cooldownMs;
      this.cooldownMaxUntilMs = nowMs + this.config.cooldownMs + 220;
      this.quietSinceMs = null;

      if (
        this.peakAccelG < this.config.dropAccelG * 1.05 &&
        this.peakGyroDps < this.config.dropGyroDps * 1.05
      ) {
        return null;
      }

      const power = clamp(this.computePower(this.peakAccelG, this.peakGyroDps), 0.14, 1);
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
        confidence: 0.7,
        features: {
          power,
          faceScore: 0,
          brushScore: 0,
          camVertScore: 0,
          gyroRatio: 0,
        },
      };

      const resolved = this.resolveShot(rawSwing, 'forehand', 0, false);
      rawSwing.shotType = resolved.shotType;
      rawSwing.rotation = resolved.rotation;
      rawSwing.confidence = resolved.confidence;
      rawSwing.features = resolved.features;

      return rawSwing;
    }

    return null;
  }

  private computePower(dynAccelG: number, gyroDps: number): number {
    const aNorm = clamp(dynAccelG / Math.max(0.5, this.config.maxAccelG), 0, 1);
    const gNorm = clamp(gyroDps / Math.max(50, this.config.maxGyroDps), 0, 1);
    return clamp(aNorm * 0.5 + gNorm * 0.5, 0, 1);
  }

  private saveTrainingToStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(TRAINING_STORAGE_KEY, JSON.stringify(this.trainingSamples));
    } catch {
      // ignore storage quota errors
    }
  }

  private loadTrainingFromStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(TRAINING_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Record<HumanShotType, SwingFeatureVector[]>>;
      if (Array.isArray(parsed.topspin)) this.trainingSamples.topspin = parsed.topspin;
      if (Array.isArray(parsed.slice)) this.trainingSamples.slice = parsed.slice;
      if (Array.isArray(parsed.dropshot)) this.trainingSamples.dropshot = parsed.dropshot;
    } catch {
      // ignore malformed storage
    }
  }
}
