import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { ArmZone, StrokeWing, WebcamArmState } from '@shared/contracts';
import { OneEuroFilter } from './OneEuroFilter';
import { TennisSwingDetector, type DetectedWebcamSwing } from './TennisSwingDetector';

export type { DetectedWebcamSwing } from './TennisSwingDetector';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const MEDIAPIPE_WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm';
const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const INFER_W = 256;
const INFER_H = 192;
const MIN_INFER_INTERVAL_MS = 33; // ~30 Hz max

export interface ArmHistoryPoint {
  t: number;
  armX: number;
  armY: number;
  armZone: ArmZone;
  wing: StrokeWing;
  crossedOver: boolean;
  /** Unbiased continuous torso-relative wrist X in shoulder-widths (+ = dominant side, - = cross-body) */
  wristSignedX?: number;
  /** Alias for wristSignedX (+ = dominant side, - = cross-body) */
  handSignedX?: number;
  /** Unbiased continuous torso-relative elbow X in shoulder-widths (+ = dominant side, - = cross-body) */
  elbowSignedX?: number;
  /** Torso-relative vertical wrist height scaled to reference shoulder width (+ = higher) */
  handRelY?: number;
  /** Torso-relative wrist coordinates in shoulder-widths for body-relative wrist speed */
  relXSw?: number;
  relYSw?: number;
  /** Instantaneous body-relative wrist speed in shoulder-widths/sec */
  wristSpeed?: number;
}

export interface SwingArmSummary {
  wing: StrokeWing;
  /** Confidence (0..1) in webcam wing classification (low ~0.38-0.45 in neutral center so IMU yaw can vote) */
  wingConfidence: number;
  /** Most dominant-side torso-relative wrist position in shoulder-widths during stroke window */
  maxSignedX: number;
  /** Most cross-body torso-relative wrist position in shoulder-widths during stroke window */
  minSignedX: number;
  /** Torso-relative wrist X at start of stroke window (+ = dominant side, - = cross-body) */
  startSignedX: number;
  /** Torso-relative wrist X at end of stroke window (+ = dominant side, - = cross-body) */
  endSignedX: number;
  /** Signed wrist travel (endSignedX - startSignedX; + = toward dominant side, - = toward cross-body) */
  signedDeltaX: number;
  armZone: ArmZone;
  armX: number;
  /** Vertical wrist travel during swing (+ = low-to-high topspin, - = high-to-low slice) */
  deltaArmY: number;
  /** Horizontal wrist travel during swing (+ = toward player's right, - = toward player's left) */
  deltaArmX: number;
  hasWebcamData: boolean;
  /** Peak body-relative wrist speed in shoulder-widths/sec during the swing window */
  peakWristSpeed: number;
  /** Total 2D wrist travel distance in shoulder-widths during the forward stroke (compact < 0.72 = dropshot) */
  strokePathSw: number;
  /** Clean vertical swing path trend ('up' = topspin, 'down' = slice, 'flat' = level/dropshot) */
  verticalTrend: 'up' | 'down' | 'flat';
  /** True when the player's pre-swing setup was crossed over toward the backhand side */
  setupCrossedOver: boolean;
}

export interface PreSwingTakeback {
  wing: StrokeWing;
  wingConfidence?: number;
  maxSignedX?: number;
  minSignedX?: number;
  armZone: ArmZone;
  armX: number;
  backswing: number;
  deltaArmY: number;
  hasWebcamData: boolean;
  setupCrossedOver?: boolean;
  peakWristSpeed?: number;
  verticalTrend?: 'up' | 'down' | 'flat';
}

export interface WebcamTrackerSnapshot {
  arm: WebcamArmState;
  landmarks: NormalizedLandmark[] | null;
  fps: number;
  status: 'idle' | 'loading' | 'running' | 'error';
  error: string | null;
}

type TrackerListener = (snapshot: WebcamTrackerSnapshot) => void;
type WebcamSwingListener = (evt: DetectedWebcamSwing) => void;

/**
 * Tracks the stationary player's dominant arm position (LEFT / CENTER / RIGHT)
 * and accurate Forehand vs Backhand classification:
 *  - Detects cross-body backhands even when the elbow is still on the dominant side
 *    (by checking hand/index tip reach + forearm vector angled across the torso).
 *  - Keeps a rolling 500ms arm history so when a swing finishes, Forehand vs Backhand
 *    is classified from the PRE-SWING TAKEBACK & SWING DIRECTION (never fooled by
 *    follow-through crossing to the opposite side!).
 *  - Exposes 384px unmirrored JPEG capture for Felix & Gavin's `frames.views.player_cam`.
 */
export class WebcamArmTracker {
  private landmarker: PoseLandmarker | null = null;
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private inferCanvas: HTMLCanvasElement | null = null;
  private inferCtx: CanvasRenderingContext2D | null = null;
  private captureCanvas: HTMLCanvasElement | null = null;
  private rafId: number | null = null;
  private running = false;
  private lastVideoTime = -1;
  private lastInferMs = 0;

  private armXFilter = new OneEuroFilter(4.5, 0.35, 1.0);
  private armYFilter = new OneEuroFilter(4.5, 0.35, 1.0);

  private frameTimes: number[] = [];
  private history: ArmHistoryPoint[] = [];
  private listeners = new Set<TrackerListener>();
  private swingListeners = new Set<WebcamSwingListener>();
  readonly swingDetector = new TennisSwingDetector('right');

  // Camera mirror auto-detection (+1 = unmirrored, -1 = pre-mirrored front camera)
  private cameraSign: 1 | -1 = 1;
  private cameraSignVotes: Array<1 | -1> = [];
  private lastKinematics: { t: number; relXSw: number; relYSw: number } | null = null;

  private snapshot: WebcamTrackerSnapshot = {
    arm: {
      active: false,
      armZone: 'center',
      armX: 0,
      armY: 0.5,
      wing: 'forehand',
      handedness: 'right',
      confidence: 0,
      lastUpdateMs: 0,
    },
    landmarks: null,
    fps: 0,
    status: 'idle',
    error: null,
  };

  getSnapshot(): WebcamTrackerSnapshot {
    return this.snapshot;
  }

  getVideoElement(): HTMLVideoElement | null {
    return this.videoEl;
  }

  subscribe(listener: TrackerListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  onWebcamSwing(cb: (evt: DetectedWebcamSwing) => void): () => void {
    this.swingListeners.add(cb);
    return () => {
      this.swingListeners.delete(cb);
    };
  }

  resetSwingDetector(): void {
    this.swingDetector.reset();
  }

  setHandedness(handedness: 'right' | 'left') {
    this.snapshot.arm.handedness = handedness;
    this.swingDetector.setHandedness(handedness);
    this.snapshot.arm.wing = this.inferStaticWing(this.snapshot.arm.armX, false, handedness);
    this.emitStatus();
  }

  /**
   * Captures pre-swing takeback state at `swing_start` (~100-160ms before ball contact):
   * wing, armZone, armX, normalized backswing amplitude (0..1), and setup kinematics.
   */
  getPreSwingTakeback(swingStartMs: number): PreSwingTakeback {
    const latestHistoryT =
      this.history.length > 0 ? this.history[this.history.length - 1].t : performance.now();
    const summaryEndMs = Math.max(swingStartMs, latestHistoryT);
    const summary = this.getSwingArmSummary(swingStartMs, summaryEndMs);
    if (!summary.hasWebcamData) {
      return {
        wing: this.snapshot.arm.wing,
        wingConfidence: 0,
        maxSignedX: 0,
        minSignedX: 0,
        armZone: this.snapshot.arm.armZone,
        armX: this.snapshot.arm.armX,
        backswing: clamp(Math.abs(this.snapshot.arm.armX) * 0.9, 0.2, 1),
        deltaArmY: 0,
        hasWebcamData: false,
        setupCrossedOver: false,
        peakWristSpeed: 0,
        verticalTrend: 'flat',
      };
    }

    const handSign = this.snapshot.arm.handedness === 'right' ? 1 : -1;
    const windowPts = this.history.filter(
      (p) => p.t >= swingStartMs - 280 && p.t <= swingStartMs + 40,
    );
    let minX = summary.minSignedX;
    let maxX = summary.maxSignedX;
    for (const p of windowPts) {
      const x =
        p.wristSignedX !== undefined
          ? p.wristSignedX
          : p.handSignedX !== undefined
            ? p.handSignedX
            : p.armX * handSign;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    const takebackSpan = maxX - minX;
    const backswing = clamp(Math.abs(summary.armX) * 0.65 + takebackSpan * 0.75, 0.12, 1);
    return {
      wing: summary.wing,
      wingConfidence: summary.wingConfidence,
      maxSignedX: summary.maxSignedX,
      minSignedX: summary.minSignedX,
      armZone: summary.armZone,
      armX: summary.armX,
      backswing,
      deltaArmY: summary.deltaArmY,
      hasWebcamData: true,
      setupCrossedOver: summary.setupCrossedOver,
      peakWristSpeed: summary.peakWristSpeed,
      verticalTrend: summary.verticalTrend,
    };
  }

  /**
   * Resolves true Forehand vs Backhand, vertical swing path, and wrist speed for a swing.
   * Accounts for ~80-120 ms webcam pipeline latency behind the 100 Hz BLE IMU by evaluating
   * strokeWindow across [swingStartMs - 280, effectiveEndMs + 40] and using temporal order
   * between dominant-side extremum (maxSample) and cross-body extremum (minSample) so:
   *  - Neutral ready-pose and forehand-side setups NEVER false-trigger backhand.
   *  - Follow-through crossing the centerline NEVER flips forehand <-> backhand.
   *  - Cross-body backhands (including compact BH dropshots) stay backhand.
   */
  getSwingArmSummary(
    swingStartMs: number,
    swingEndMs: number,
    lagCompensationMs = 0,
  ): SwingArmSummary {
    const handedness = this.snapshot.arm.handedness;
    const handSign = handedness === 'right' ? 1 : -1;
    const tStartCam = swingStartMs + lagCompensationMs;
    const tEndCam = Math.max(swingEndMs, swingStartMs) + lagCompensationMs;

    const recent = this.history.filter(
      (p) => p.t >= tStartCam - 600 && p.t <= tEndCam + 45,
    );

    if (!this.snapshot.arm.active || recent.length < 2) {
      const curSigned = this.snapshot.arm.armX * handSign;
      return {
        wing: this.snapshot.arm.wing,
        wingConfidence: 0,
        maxSignedX: curSigned,
        minSignedX: curSigned,
        startSignedX: curSigned,
        endSignedX: curSigned,
        signedDeltaX: 0,
        armZone: this.snapshot.arm.armZone,
        armX: this.snapshot.arm.armX,
        deltaArmY: 0,
        deltaArmX: 0,
        hasWebcamData: false,
        peakWristSpeed: 0,
        strokePathSw: 0,
        verticalTrend: 'flat',
        setupCrossedOver: false,
      };
    }

    const getSignedX = (p: ArmHistoryPoint) =>
      p.wristSignedX !== undefined
        ? p.wristSignedX
        : p.handSignedX !== undefined
          ? p.handSignedX
          : p.armX * handSign;
    const getRelY = (p: ArmHistoryPoint) =>
      p.handRelY !== undefined ? p.handRelY : p.armY;

    // 1. Time-aligned stroke window: when lagCompensationMs (~90ms) is provided after
    //    the settle wait, [tStartCam - 220, tEndCam + 35] aligns directly with the physical swing!
    const preLookbackMs = lagCompensationMs > 0 ? 220 : 280;
    let strokeWindow = recent.filter(
      (p) => p.t >= tStartCam - preLookbackMs && p.t <= tEndCam + 40,
    );
    if (strokeWindow.length === 0) {
      strokeWindow = recent.slice(-4);
    }

    // 2. Find maxSample (most dominant-side) and minSample (most cross-body) across strokeWindow
    let maxSample = strokeWindow[0];
    let minSample = strokeWindow[0];
    for (const p of strokeWindow) {
      const sx = getSignedX(p);
      if (sx > getSignedX(maxSample)) maxSample = p;
      if (sx < getSignedX(minSample)) minSample = p;
    }

    const maxSignedX = getSignedX(maxSample);
    const minSignedX = getSignedX(minSample);

    // 3. Time-ordered Forehand vs Backhand resolution
    let wing: StrokeWing;
    let wingConfidence: number;

    if (minSignedX >= -0.06) {
      // Rule 1: Wrist never meaningfully crossed past midline onto backhand side
      wing = 'forehand';
      wingConfidence =
        maxSignedX > 0.10 ? 0.70 + clamp(maxSignedX / 0.5, 0, 0.25) : 0.45;
    } else if (minSignedX < -0.08 && maxSignedX < 0.14) {
      // Rule 2: Wrist clearly crossed onto backhand side and never coiled onto forehand side
      wing = 'backhand';
      wingConfidence = 0.72 + clamp((-minSignedX - 0.08) / 0.45, 0, 0.24);
    } else if (maxSignedX >= 0.14 && minSignedX < -0.08) {
      // Rule 3: Both sides visited (e.g., big follow-through) -> temporal order decides!
      if (maxSample.t <= minSample.t) {
        // Started on dominant side, finished across body on follow-through
        wing = 'forehand';
        wingConfidence = 0.86;
      } else {
        // Started coiled across midline, uncoiled toward dominant side
        wing = 'backhand';
        wingConfidence = 0.86;
      }
    } else {
      // Rule 4: Narrow center band (-0.08 <= minSignedX < -0.06) -> low-confidence tie-breaker so IMU yaw can vote
      wing = (maxSignedX + minSignedX) * 0.5 >= -0.04 ? 'forehand' : 'backhand';
      wingConfidence = 0.38;
    }

    const setupCrossedOver = wing === 'backhand' && (minSignedX < -0.08 || minSample.crossedOver);
    const activeSample = wing === 'backhand' ? minSample : maxSample;
    const armZone = this.classifyZoneWithHysteresis(
      activeSample.armX,
      this.snapshot.arm.armZone,
    );

    // 4. Forward-stroke travel & vertical swing path across the time-aligned forward window
    const fwdPreMs = lagCompensationMs > 0 ? 45 : 110;
    let swingSamples = strokeWindow.filter(
      (p) => p.t >= tStartCam - fwdPreMs && p.t <= tEndCam + 35,
    );
    if (swingSamples.length < 2) {
      swingSamples = strokeWindow.length >= 2 ? strokeWindow : recent.slice(-4);
    }

    const strokeStart = swingSamples[0];
    const strokeEnd = swingSamples[swingSamples.length - 1];
    const startSignedX = getSignedX(strokeStart);
    const endSignedX = getSignedX(strokeEnd);
    const signedDeltaX = endSignedX - startSignedX;
    const deltaArmX = signedDeltaX * handSign;

    const vertWindow = swingSamples;
    const yStart = getRelY(vertWindow[0]);
    const yEnd = getRelY(vertWindow[vertWindow.length - 1]);
    const netDeltaY = yEnd - yStart;

    let maxY = yStart;
    let minY = yStart;
    for (const p of vertWindow) {
      const y = getRelY(p);
      if (y > maxY) maxY = y;
      if (y < minY) minY = y;
    }
    const upExcursion = maxY - yStart; // >= 0 (low -> high)
    const downExcursion = minY - yStart; // <= 0 (high -> low)

    let peakDeltaY = netDeltaY;
    if (upExcursion > Math.abs(downExcursion) * 1.35 && upExcursion > 0.03) {
      peakDeltaY = upExcursion;
    } else if (Math.abs(downExcursion) > upExcursion * 1.35 && Math.abs(downExcursion) > 0.03) {
      peakDeltaY = downExcursion;
    }

    let deltaArmY: number;
    if (Math.abs(netDeltaY) >= 0.03 && Math.sign(netDeltaY) === Math.sign(peakDeltaY)) {
      deltaArmY = netDeltaY * 0.65 + peakDeltaY * 0.35;
    } else if (Math.abs(peakDeltaY) > 0.045) {
      deltaArmY = netDeltaY * 0.35 + peakDeltaY * 0.65;
    } else {
      deltaArmY = netDeltaY;
    }

    const verticalTrend: 'up' | 'down' | 'flat' =
      deltaArmY > 0.03 ? 'up' : deltaArmY < -0.03 ? 'down' : 'flat';

    // 5. Peak body-relative wrist speed & total 2D wrist path length (shoulder-widths)
    const speedWindow = swingSamples.length >= 2 ? swingSamples : strokeWindow;
    const stepSpeeds: number[] = [];
    let strokePathSw = 0;
    for (let i = 1; i < speedWindow.length; i++) {
      const prev = speedWindow[i - 1];
      const curr = speedWindow[i];
      const dtMs = curr.t - prev.t;
      if (dtMs < 8 || dtMs > 250) continue;
      if (
        prev.relXSw !== undefined &&
        prev.relYSw !== undefined &&
        curr.relXSw !== undefined &&
        curr.relYSw !== undefined
      ) {
        const dx = curr.relXSw - prev.relXSw;
        const dy = curr.relYSw - prev.relYSw;
        const stepDist = Math.hypot(dx, dy);
        strokePathSw += stepDist;
        stepSpeeds.push(stepDist / (dtMs / 1000));
      } else if (curr.wristSpeed !== undefined) {
        stepSpeeds.push(curr.wristSpeed);
      } else {
        const dx = curr.armX - prev.armX;
        const dy = curr.armY - prev.armY;
        const stepDist = Math.hypot(dx, dy);
        strokePathSw += stepDist;
        stepSpeeds.push(stepDist / (dtMs / 1000));
      }
    }

    let peakWristSpeed = 0;
    if (stepSpeeds.length >= 2) {
      // 2-frame mean peak guards against single-frame MediaPipe jitter (per tennis-reference spec)
      for (let i = 1; i < stepSpeeds.length; i++) {
        const avg2 = (stepSpeeds[i - 1] + stepSpeeds[i]) * 0.5;
        if (avg2 > peakWristSpeed) peakWristSpeed = avg2;
      }
    } else if (stepSpeeds.length === 1) {
      peakWristSpeed = stepSpeeds[0];
    } else {
      for (const p of speedWindow) {
        if ((p.wristSpeed ?? 0) > peakWristSpeed) peakWristSpeed = p.wristSpeed ?? 0;
      }
    }

    return {
      wing,
      wingConfidence,
      maxSignedX,
      minSignedX,
      startSignedX,
      endSignedX,
      signedDeltaX,
      armZone,
      armX: activeSample.armX,
      deltaArmY,
      deltaArmX,
      hasWebcamData: true,
      peakWristSpeed,
      strokePathSw,
      verticalTrend,
      setupCrossedOver,
    };
  }

  async start(videoElement?: HTMLVideoElement): Promise<boolean> {
    if (this.running) return true;
    this.snapshot.status = 'loading';
    this.snapshot.error = null;
    this.emitStatus();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      this.stream = stream;

      const video = videoElement ?? document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      this.videoEl = video;

      if (!this.inferCanvas) {
        this.inferCanvas = document.createElement('canvas');
        this.inferCanvas.width = INFER_W;
        this.inferCanvas.height = INFER_H;
        this.inferCtx = this.inferCanvas.getContext('2d', { willReadFrequently: false });
      }

      if (!this.landmarker) {
        const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
        try {
          this.landmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: POSE_MODEL_URL,
              delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.35,
            minPosePresenceConfidence: 0.35,
            minTrackingConfidence: 0.3,
          });
        } catch {
          this.landmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: POSE_MODEL_URL,
              delegate: 'CPU',
            },
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.35,
            minPosePresenceConfidence: 0.35,
            minTrackingConfidence: 0.3,
          });
        }
      }

      this.running = true;
      this.snapshot.status = 'running';
      this.emitStatus();
      this.loop();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.snapshot.status = 'error';
      this.snapshot.error = message;
      this.snapshot.arm.active = false;
      this.emitStatus();
      return false;
    }
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
    this.history = [];
    this.lastKinematics = null;
    this.cameraSign = 1;
    this.cameraSignVotes = [];
    this.swingDetector.reset();
    this.armXFilter.reset();
    this.armYFilter.reset();
    this.snapshot.arm.active = false;
    this.snapshot.status = 'idle';
    this.snapshot.landmarks = null;
    this.emitStatus();
  }

  capturePlayerCamJpeg(targetWidth = 384, quality = 0.68): string | null {
    const video = this.videoEl;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return null;

    if (!this.captureCanvas) {
      this.captureCanvas = document.createElement('canvas');
    }
    const aspect = video.videoHeight / Math.max(1, video.videoWidth);
    const w = targetWidth;
    const h = Math.max(1, Math.round(w * aspect));
    if (this.captureCanvas.width !== w || this.captureCanvas.height !== h) {
      this.captureCanvas.width = w;
      this.captureCanvas.height = h;
    }

    const ctx = this.captureCanvas.getContext('2d');
    if (!ctx) return null;
    ctx.save();
    if (this.cameraSign === -1) {
      // Normalize pre-mirrored webcam feed so Gemini player_cam always receives unmirrored left/right orientation
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    const dataUrl = this.captureCanvas.toDataURL('image/jpeg', quality);
    const commaIdx = dataUrl.indexOf(',');
    return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const video = this.videoEl;
    const landmarker = this.landmarker;
    const inferCanvas = this.inferCanvas;
    const inferCtx = this.inferCtx;
    if (!video || !landmarker || !inferCanvas || !inferCtx || video.readyState < 2) return;

    const nowMs = performance.now();
    if (nowMs - this.lastInferMs < MIN_INFER_INTERVAL_MS) return;
    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;
    this.lastInferMs = nowMs;

    inferCtx.drawImage(video, 0, 0, INFER_W, INFER_H);
    const result = landmarker.detectForVideo(inferCanvas, nowMs);
    const landmarks = result.landmarks?.[0] ?? null;

    this.frameTimes.push(nowMs);
    while (this.frameTimes.length > 0 && nowMs - this.frameTimes[0] > 1000) {
      this.frameTimes.shift();
    }
    this.snapshot.fps = this.frameTimes.length;
    this.processLandmarks(landmarks, nowMs);
  };

  /**
   * Processes a single MediaPipe Pose 33-landmark frame into torso-relative arm kinematics,
   * cross-body backhand detection, and rolling swing history.
   */
  processLandmarks(landmarks: NormalizedLandmark[] | null, nowMs = performance.now()): void {
    this.snapshot.landmarks = landmarks;

    if (!landmarks || landmarks.length < 25) {
      this.snapshot.arm.active = false;
      this.lastKinematics = null;
      return;
    }

    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    if (
      !leftShoulder ||
      !rightShoulder ||
      !Number.isFinite(leftShoulder.x) ||
      !Number.isFinite(rightShoulder.x) ||
      (leftShoulder.visibility ?? 0.9) < 0.25 ||
      (rightShoulder.visibility ?? 0.9) < 0.25
    ) {
      this.snapshot.arm.active = false;
      this.lastKinematics = null;
      return;
    }

    // Majority-vote camera mirror sign (prevents mid-swing flips while supporting pre-mirrored webcams)
    const shoulderDx = leftShoulder.x - rightShoulder.x;
    if (Math.abs(shoulderDx) > 0.05) {
      const vote: 1 | -1 = rightShoulder.x > leftShoulder.x ? -1 : 1;
      if (this.cameraSignVotes.length === 0 && Math.abs(shoulderDx) > 0.08) {
        this.cameraSign = vote;
      }
      this.cameraSignVotes.push(vote);
      if (this.cameraSignVotes.length > 30) this.cameraSignVotes.shift();
      if (this.cameraSignVotes.length >= 3) {
        let voteSum = 0;
        for (const v of this.cameraSignVotes) voteSum += v;
        if (Math.abs(voteSum) > this.cameraSignVotes.length * 0.7) {
          this.cameraSign = voteSum > 0 ? 1 : -1;
        }
      }
    }

    const handedness = this.snapshot.arm.handedness;
    const isRight = handedness === 'right';
    const handSign = isRight ? 1 : -1;

    const elbow = isRight ? landmarks[14] : landmarks[13];
    const wrist = isRight ? landmarks[16] : landmarks[15];

    if (
      !elbow ||
      !wrist ||
      !Number.isFinite(elbow.x) ||
      !Number.isFinite(wrist.x) ||
      !Number.isFinite(wrist.y) ||
      (wrist.visibility ?? 0.9) < 0.2
    ) {
      // Skip occluded wrist frame without polluting swing history
      return;
    }

    // Torso centerline (weighted shoulders + hips when hips are visible in frame)
    const shoulderMidX = (leftShoulder.x + rightShoulder.x) * 0.5;
    const shoulderMidY = (leftShoulder.y + rightShoulder.y) * 0.5;
    const shoulderWidth = Math.max(
      0.08,
      Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y),
    );

    const leftHip = landmarks[23];
    const rightHip = landmarks[24];
    const hipsVisible = Boolean(
      leftHip &&
        rightHip &&
        Number.isFinite(leftHip.x) &&
        Number.isFinite(rightHip.x) &&
        (leftHip.visibility ?? 0.9) >= 0.3 &&
        (rightHip.visibility ?? 0.9) >= 0.3 &&
        leftHip.y >= 0 &&
        leftHip.y <= 1.08 &&
        rightHip.y >= 0 &&
        rightHip.y <= 1.08,
    );
    const hipMidX = hipsVisible ? (leftHip.x + rightHip.x) * 0.5 : shoulderMidX;
    const torsoMidX = hipsVisible ? shoulderMidX * 0.72 + hipMidX * 0.28 : shoulderMidX;

    // Player-centric X in shoulder-widths (+ = player's right, - = player's left)
    // Use wrist.x directly (do NOT blend indexTip/pinky inward into lateral X)
    const wristPlayerX = ((torsoMidX - wrist.x) * this.cameraSign) / shoulderWidth;
    const elbowPlayerX = ((torsoMidX - elbow.x) * this.cameraSign) / shoulderWidth;

    // Handedness-signed X (+ = dominant side, - = cross-body / backhand side)
    const wristSignedX = wristPlayerX * handSign;
    const handSignedX = wristSignedX;
    const elbowSignedX = elbowPlayerX * handSign;

    // Cross-body backhand detection (immune to neutral ready pose & forehand-side elbow bend)
    const crossedMidline = wristSignedX < -0.10;
    const forearmCrossedInward =
      wristSignedX < -0.03 && elbowSignedX - wristSignedX > 0.24;
    const crossedOver = crossedMidline || forearmCrossedInward;

    // Body-relative kinematics (shoulder-widths & distance-normalized vertical height)
    const relXSw = wristPlayerX;
    const relYSw = (shoulderMidY - wrist.y) / shoulderWidth;
    const refScale = clamp(0.22 / shoulderWidth, 0.8, 1.8);
    const handRelY = (shoulderMidY - wrist.y) * refScale;

    let wristSpeed = 0;
    if (this.lastKinematics && nowMs > this.lastKinematics.t) {
      const dtMs = nowMs - this.lastKinematics.t;
      if (dtMs >= 8 && dtMs <= 250) {
        const dxSw = relXSw - this.lastKinematics.relXSw;
        const dySw = relYSw - this.lastKinematics.relYSw;
        wristSpeed = Math.hypot(dxSw, dySw) / (dtMs / 1000);
      }
    }
    this.lastKinematics = { t: nowMs, relXSw, relYSw };

    // Continuous, unbiased armX (±0.22 zone threshold = ±0.143 shoulder-widths, keeping 'center' wide & stable)
    const rawArmX = clamp(wristPlayerX / 0.65, -1, 1);
    const rawArmY = clamp(1 - wrist.y, 0, 1);

    const filteredArmX = this.armXFilter.filter(rawArmX, nowMs);
    const filteredArmY = this.armYFilter.filter(rawArmY, nowMs);

    const prevZone = this.snapshot.arm.armZone;
    const armZone = this.classifyZoneWithHysteresis(filteredArmX, prevZone);
    const wing = this.inferStaticWing(filteredArmX, crossedOver, handedness);
    const confidence = Math.min(wrist.visibility ?? 0.9, elbow.visibility ?? 0.9);

    this.snapshot.arm = {
      active: true,
      armZone,
      armX: filteredArmX,
      armY: filteredArmY,
      wing,
      handedness,
      confidence,
      lastUpdateMs: nowMs,
    };

    this.history.push({
      t: nowMs,
      armX: filteredArmX,
      armY: filteredArmY,
      armZone,
      wing,
      crossedOver,
      wristSignedX,
      handSignedX,
      elbowSignedX,
      handRelY,
      relXSw,
      relYSw,
      wristSpeed,
    });
    while (this.history.length > 0 && nowMs - this.history[0].t > 900) {
      this.history.shift();
    }

    const detectedSwing = this.swingDetector.update(landmarks, nowMs, nowMs);
    if (detectedSwing) {
      for (const cb of this.swingListeners) {
        cb(detectedSwing);
      }
    }
  }

  private classifyZoneWithHysteresis(armX: number, prev: ArmZone): ArmZone {
    const enterThresh = 0.22;
    const exitThresh = 0.12;

    if (prev === 'right') {
      if (armX < -enterThresh) return 'left';
      if (armX < exitThresh) return 'center';
      return 'right';
    }
    if (prev === 'left') {
      if (armX > enterThresh) return 'right';
      if (armX > -exitThresh) return 'center';
      return 'left';
    }
    if (armX >= enterThresh) return 'right';
    if (armX <= -enterThresh) return 'left';
    return 'center';
  }

  private inferStaticWing(
    armX: number,
    crossedOver: boolean,
    handedness: 'right' | 'left',
  ): StrokeWing {
    if (crossedOver) return 'backhand';
    const handSign = handedness === 'right' ? 1 : -1;
    return armX * handSign < -0.10 ? 'backhand' : 'forehand';
  }

  private emitStatus() {
    for (const cb of this.listeners) cb(this.snapshot);
  }
}
