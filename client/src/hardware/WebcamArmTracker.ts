import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { ArmZone, StrokeWing, WebcamArmState } from '@shared/contracts';
import { OneEuroFilter } from './OneEuroFilter';

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
  /** Unbiased continuous torso-relative hand X in shoulder-widths (+ = dominant side, - = cross-body) */
  handSignedX?: number;
  /** Unbiased continuous torso-relative elbow X in shoulder-widths (+ = dominant side, - = cross-body) */
  elbowSignedX?: number;
  /** Torso-relative vertical hand height scaled to reference shoulder width (+ = higher) */
  handRelY?: number;
  /** Torso-relative hand coordinates in shoulder-widths for body-relative wrist speed */
  relXSw?: number;
  relYSw?: number;
  /** Instantaneous body-relative wrist speed in shoulder-widths/sec */
  wristSpeed?: number;
}

export interface SwingArmSummary {
  wing: StrokeWing;
  armZone: ArmZone;
  armX: number;
  /** Vertical wrist travel during swing (+ = low-to-high topspin, - = high-to-low slice) */
  deltaArmY: number;
  /** Horizontal wrist travel during swing (+ = toward player's right, - = toward player's left) */
  deltaArmX: number;
  hasWebcamData: boolean;
  /** Peak body-relative wrist speed in shoulder-widths/sec during the swing window */
  peakWristSpeed: number;
  /** Clean vertical swing path trend ('up' = topspin, 'down' = slice, 'flat' = level/dropshot) */
  verticalTrend: 'up' | 'down' | 'flat';
  /** True when the player's pre-swing setup was crossed over toward the backhand side */
  setupCrossedOver: boolean;
}

export interface WebcamTrackerSnapshot {
  arm: WebcamArmState;
  landmarks: NormalizedLandmark[] | null;
  fps: number;
  status: 'idle' | 'loading' | 'running' | 'error';
  error: string | null;
}

type TrackerListener = (snapshot: WebcamTrackerSnapshot) => void;

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

  setHandedness(handedness: 'right' | 'left') {
    this.snapshot.arm.handedness = handedness;
    this.snapshot.arm.wing = this.inferStaticWing(this.snapshot.arm.armX, false, handedness);
    this.emitStatus();
  }

  /**
   * Captures pre-swing takeback state at `swing_start` (~100-160ms before ball contact):
   * wing, armZone, armX, normalized backswing amplitude (0..1), and setup kinematics.
   */
  getPreSwingTakeback(swingStartMs: number): {
    wing: StrokeWing;
    armZone: ArmZone;
    armX: number;
    backswing: number;
    deltaArmY: number;
    hasWebcamData: boolean;
    setupCrossedOver?: boolean;
    peakWristSpeed?: number;
    verticalTrend?: 'up' | 'down' | 'flat';
  } {
    const latestHistoryT =
      this.history.length > 0 ? this.history[this.history.length - 1].t : performance.now();
    const summaryEndMs = Math.max(swingStartMs, latestHistoryT);
    const summary = this.getSwingArmSummary(swingStartMs, summaryEndMs);
    if (!summary.hasWebcamData) {
      return {
        wing: this.snapshot.arm.wing,
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
      (p) => p.t >= swingStartMs - 340 && p.t <= swingStartMs + 30,
    );
    let minX = summary.armX * handSign;
    let maxX = summary.armX * handSign;
    for (const p of windowPts) {
      const x = p.handSignedX !== undefined ? p.handSignedX : p.armX * handSign;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    const takebackSpan = maxX - minX;
    const backswing = clamp(Math.abs(summary.armX) * 0.65 + takebackSpan * 0.75, 0.12, 1);
    return {
      wing: summary.wing,
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
   * Uses the pre-swing takeback extremum across [swingStartMs - 340, swingStartMs - 20]
   * + stroke travel during [swingStartMs - 60, swingEndMs] so:
   *  - Follow-through crossing the centerline NEVER flips forehand <-> backhand.
   *  - Crossed-over backhands (even with elbow on dominant side) stay backhand.
   *  - Short, gentle backhand dropshots stay backhand with low peakWristSpeed.
   */
  getSwingArmSummary(swingStartMs: number, swingEndMs: number): SwingArmSummary {
    const handedness = this.snapshot.arm.handedness;
    const handSign = handedness === 'right' ? 1 : -1;
    const effectiveEndMs = Math.max(swingEndMs, swingStartMs);

    const recent = this.history.filter(
      (p) => p.t >= swingStartMs - 400 && p.t <= effectiveEndMs + 40,
    );

    if (!this.snapshot.arm.active || recent.length < 2) {
      return {
        wing: this.snapshot.arm.wing,
        armZone: this.snapshot.arm.armZone,
        armX: this.snapshot.arm.armX,
        deltaArmY: 0,
        deltaArmX: 0,
        hasWebcamData: false,
        peakWristSpeed: 0,
        verticalTrend: 'flat',
        setupCrossedOver: false,
      };
    }

    const getSignedX = (p: ArmHistoryPoint) =>
      p.handSignedX !== undefined ? p.handSignedX : p.armX * handSign;
    const getRelY = (p: ArmHistoryPoint) =>
      p.handRelY !== undefined ? p.handRelY : p.armY;

    // 1. Pre-swing takeback window [swingStartMs - 340, swingStartMs - 20]
    let preSamples = recent.filter(
      (p) => p.t >= swingStartMs - 340 && p.t <= swingStartMs - 20,
    );
    if (preSamples.length === 0) {
      preSamples = recent.filter((p) => p.t <= swingStartMs + 20);
    }
    if (preSamples.length === 0) {
      preSamples = [recent[0]];
    }

    const latePreRaw = preSamples.filter((p) => p.t >= swingStartMs - 200);
    const latePreSamples = latePreRaw.length > 0 ? latePreRaw : preSamples;

    // Find takeback extrema across [swingStartMs - 340, swingStartMs - 20]
    let maxPreSample = preSamples[0]; // Most dominant-side (FH takeback extremum)
    let minPreSample = preSamples[0]; // Most cross-body (BH takeback extremum)
    let preCrossedCount = 0;
    for (const p of preSamples) {
      const sx = getSignedX(p);
      if (sx > getSignedX(maxPreSample)) maxPreSample = p;
      if (sx < getSignedX(minPreSample)) minPreSample = p;
      if (p.crossedOver) preCrossedCount++;
    }

    let lateCrossedCount = 0;
    for (const p of latePreSamples) {
      if (p.crossedOver) lateCrossedCount++;
    }

    const maxPreSignedX = getSignedX(maxPreSample);
    const minPreSignedX = getSignedX(minPreSample);
    const preCrossRatio = preCrossedCount / preSamples.length;
    const lateCrossRatio = lateCrossedCount / latePreSamples.length;
    const lateMidSample = latePreSamples[Math.floor(latePreSamples.length / 2)];
    const setupSignedX = getSignedX(lateMidSample);

    // Did the player set up crossed over before forward swing acceleration?
    // Checking latePreSamples prevents an old neutral ready-pose frame from overriding
    // a clear forehand coil, while staying rock-solid when the player starts crossed over.
    const setupCrossedOver =
      lateCrossRatio >= 0.45 || (preCrossRatio >= 0.5 && maxPreSignedX < 0.35);

    // 2. Actual stroke travel during [swingStartMs - 60, swingEndMs]
    let swingSamples = recent.filter(
      (p) => p.t >= swingStartMs - 60 && p.t <= effectiveEndMs + 20,
    );
    if (swingSamples.length < 2) {
      swingSamples = recent.filter(
        (p) => p.t >= swingStartMs - 110 && p.t <= effectiveEndMs + 40,
      );
    }
    if (swingSamples.length < 2) {
      swingSamples = recent;
    }

    const strokeStart = swingSamples[0];
    const strokeEnd = swingSamples[swingSamples.length - 1];
    const signedDeltaX = getSignedX(strokeEnd) - getSignedX(strokeStart);
    const deltaArmX = signedDeltaX * handSign;

    // 3. Forehand vs Backhand resolution (zero follow-through flips, rock-solid BH dropshots)
    let wing: StrokeWing;
    if (setupCrossedOver) {
      // Player started crossed over (including elbow-on-right crossed BH & short BH dropshots!).
      // Stay backhand unless there was both a wide dominant-side coil AND a huge right->left sweep.
      const unmistakableForehandOverride =
        maxPreSignedX > 0.55 && signedDeltaX < -0.45 && setupSignedX > 0.35;
      wing = unmistakableForehandOverride ? 'forehand' : 'backhand';
    } else if (minPreSignedX < -0.08 && signedDeltaX > 0.16) {
      // Wound up past midline toward backhand side and uncoiling left -> right
      wing = 'backhand';
    } else if (maxPreSignedX > 0.28 && signedDeltaX <= 0.18) {
      // Coiled cleanly on forehand side (full FH, compact FH, or soft FH dropshot);
      // cross-body follow-through has negative signedDeltaX so it NEVER flips to backhand!
      wing = 'forehand';
    } else if (Math.abs(signedDeltaX) > 0.18) {
      // Ambiguous center setup -> actual stroke direction breaks tie cleanly:
      // +signedDeltaX (left->right for righty) = backhand; -signedDeltaX (right->left) = forehand
      wing = signedDeltaX > 0 ? 'backhand' : 'forehand';
    } else if (setupSignedX < 0.08) {
      wing = 'backhand';
    } else {
      wing = 'forehand';
    }

    // Report the pre-swing hitting zone & takeback extremum armX (never follow-through!)
    const takebackSample = wing === 'backhand' ? minPreSample : maxPreSample;
    let armZone: ArmZone;
    if (wing === 'backhand') {
      armZone = handedness === 'right' ? 'left' : 'right';
    } else if (maxPreSignedX > 0.15) {
      armZone = handedness === 'right' ? 'right' : 'left';
    } else {
      armZone = takebackSample.armZone;
    }

    // 4. Vertical swing path across [swingStartMs - 50, swingEndMs]
    const vertWindowRaw = recent.filter(
      (p) => p.t >= swingStartMs - 55 && p.t <= effectiveEndMs + 15,
    );
    const vertWindow = vertWindowRaw.length >= 2 ? vertWindowRaw : swingSamples;

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

    // 5. Peak body-relative wrist speed (shoulder-widths/sec) during the swing window
    const stepSpeeds: number[] = [];
    for (let i = 1; i < swingSamples.length; i++) {
      const prev = swingSamples[i - 1];
      const curr = swingSamples[i];
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
        stepSpeeds.push(Math.hypot(dx, dy) / (dtMs / 1000));
      } else if (curr.wristSpeed !== undefined) {
        stepSpeeds.push(curr.wristSpeed);
      } else {
        const dx = curr.armX - prev.armX;
        const dy = curr.armY - prev.armY;
        stepSpeeds.push(Math.hypot(dx, dy) / (dtMs / 1000));
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
      for (const p of swingSamples) {
        if ((p.wristSpeed ?? 0) > peakWristSpeed) peakWristSpeed = p.wristSpeed ?? 0;
      }
    }

    return {
      wing,
      armZone,
      armX: takebackSample.armX,
      deltaArmY,
      deltaArmX,
      hasWebcamData: true,
      peakWristSpeed,
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
    ctx.drawImage(video, 0, 0, w, h);
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

    const domShoulder = isRight ? rightShoulder : leftShoulder;
    const oppShoulder = isRight ? leftShoulder : rightShoulder;
    const elbow = isRight ? landmarks[14] : landmarks[13];
    const wrist = isRight ? landmarks[16] : landmarks[15];
    const pinky = isRight ? landmarks[18] : landmarks[17];
    const indexTip = isRight ? landmarks[20] : landmarks[19];

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

    // Estimate racket-hand center from wrist + visible index/pinky knuckles
    const indexOk = Boolean(
      indexTip &&
        Number.isFinite(indexTip.x) &&
        Number.isFinite(indexTip.y) &&
        (indexTip.visibility ?? 0.9) >= 0.3,
    );
    const pinkyOk = Boolean(
      pinky &&
        Number.isFinite(pinky.x) &&
        Number.isFinite(pinky.y) &&
        (pinky.visibility ?? 0.9) >= 0.3,
    );

    let handX = wrist.x;
    let handY = wrist.y;
    if (indexOk && pinkyOk) {
      const knuckleX = (indexTip.x + pinky.x) * 0.5;
      const knuckleY = (indexTip.y + pinky.y) * 0.5;
      handX = wrist.x * 0.6 + knuckleX * 0.4;
      handY = wrist.y * 0.6 + knuckleY * 0.4;
    } else if (indexOk) {
      handX = wrist.x * 0.65 + indexTip.x * 0.35;
      handY = wrist.y * 0.65 + indexTip.y * 0.35;
    } else if (pinkyOk) {
      handX = wrist.x * 0.65 + pinky.x * 0.35;
      handY = wrist.y * 0.65 + pinky.y * 0.35;
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
    const toPlayerX = (imgX: number) => ((torsoMidX - imgX) * this.cameraSign) / shoulderWidth;
    const handPlayerX = toPlayerX(handX);
    const wristPlayerX = toPlayerX(wrist.x);
    const elbowPlayerX = toPlayerX(elbow.x);

    // Handedness-signed X (+ = dominant side, - = cross-body / backhand side)
    const handSignedX = handPlayerX * handSign;
    const wristSignedX = wristPlayerX * handSign;
    const elbowSignedX = elbowPlayerX * handSign;

    // Bulletproof Cross-Body Backhand Detection:
    //  a) Hand or wrist crosses torso midline toward non-dominant side (handSignedX < 0.08)
    //  b) Forearm angles inward across chest even while elbow stays on dominant side
    //     ((elbowSignedX - handSignedX) > 0.16 && handSignedX < 0.42)
    //  c) Hand is horizontally closer to the opposite shoulder than the dominant shoulder
    const crossedMidline = handSignedX < 0.08 || wristSignedX < 0.08;
    const forearmCrossedInward = elbowSignedX - handSignedX > 0.16 && handSignedX < 0.42;
    const closerToOppShoulder =
      Math.abs(handX - oppShoulder.x) < Math.abs(handX - domShoulder.x);
    const crossedOver = crossedMidline || forearmCrossedInward || closerToOppShoulder;

    // Body-relative kinematics (shoulder-widths & distance-normalized vertical height)
    const relXSw = handPlayerX;
    const relYSw = (shoulderMidY - handY) / shoulderWidth;
    const refScale = clamp(0.22 / shoulderWidth, 0.8, 1.8);
    const handRelY = (shoulderMidY - handY) * refScale;

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

    // Smooth UI/avatar armX (biased cleanly onto backhand side when forearm is crossed over)
    const scaledPlayerX = handPlayerX / 1.1;
    const effectiveArmX = crossedOver
      ? Math.min(scaledPlayerX * handSign, -0.28) * handSign
      : scaledPlayerX;

    const rawArmX = clamp(effectiveArmX, -1, 1);
    const rawArmY = clamp(1 - handY, 0, 1);

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
    return armX * handSign >= 0.04 ? 'forehand' : 'backhand';
  }

  private emitStatus() {
    for (const cb of this.listeners) cb(this.snapshot);
  }
}
