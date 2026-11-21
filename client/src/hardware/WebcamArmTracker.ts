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
}

export interface SwingArmSummary {
  wing: StrokeWing;
  armZone: ArmZone;
  armX: number;
  /** Vertical wrist travel during swing (+ = low-to-high topspin, - = high-to-low slice) */
  deltaArmY: number;
  /** Horizontal wrist travel during swing */
  deltaArmX: number;
  hasWebcamData: boolean;
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
   * wing, armZone, armX, and normalized backswing amplitude (0..1).
   */
  getPreSwingTakeback(swingStartMs: number): {
    wing: StrokeWing;
    armZone: ArmZone;
    armX: number;
    backswing: number;
    deltaArmY: number;
    hasWebcamData: boolean;
  } {
    const summary = this.getSwingArmSummary(swingStartMs, performance.now());
    if (!summary.hasWebcamData) {
      return {
        wing: this.snapshot.arm.wing,
        armZone: this.snapshot.arm.armZone,
        armX: this.snapshot.arm.armX,
        backswing: clamp(Math.abs(this.snapshot.arm.armX) * 0.9, 0.2, 1),
        deltaArmY: 0,
        hasWebcamData: false,
      };
    }
    const windowPts = this.history.filter((p) => p.t >= swingStartMs - 320 && p.t <= swingStartMs + 30);
    let minX = summary.armX;
    let maxX = summary.armX;
    for (const p of windowPts) {
      if (p.armX < minX) minX = p.armX;
      if (p.armX > maxX) maxX = p.armX;
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
    };
  }

  /**
   * Resolves true Forehand vs Backhand & vertical swing path for a swing that just ended.
   * Uses the pre-swing takeback position (120–320 ms before swingEndMs) + swing travel
   * direction so follow-through crossing the centerline NEVER flips forehand <-> backhand!
   */
  getSwingArmSummary(swingStartMs: number, swingEndMs: number): SwingArmSummary {
    const handedness = this.snapshot.arm.handedness;
    const recent = this.history.filter((p) => swingEndMs - p.t <= 550);

    if (!this.snapshot.arm.active || recent.length < 2) {
      return {
        wing: this.snapshot.arm.wing,
        armZone: this.snapshot.arm.armZone,
        armX: this.snapshot.arm.armX,
        deltaArmY: 0,
        deltaArmX: 0,
        hasWebcamData: false,
      };
    }

    // Find takeback samples right BEFORE the swing started (280ms..40ms before swingStartMs)
    const preSamples = recent.filter(
      (p) => p.t >= swingStartMs - 300 && p.t <= swingStartMs - 20,
    );
    const startSample =
      preSamples.length > 0
        ? preSamples[Math.floor(preSamples.length / 2)]
        : recent[0];

    // End sample = around peak/impact
    const endSample = recent[recent.length - 1];

    const deltaArmX = endSample.armX - startSample.armX;
    const deltaArmY = endSample.armY - startSample.armY;

    // For a right-handed player:
    //   - Forehand: starts on RIGHT (armX > 0.08, not crossed over), swings RIGHT -> LEFT (deltaArmX < 0)
    //   - Backhand: starts CROSSED OVER / LEFT (crossedOver || armX < 0.08), swings LEFT -> RIGHT (deltaArmX > 0)
    // Mirror sign for left-handed player.
    const handSign = handedness === 'right' ? 1 : -1;
    const signedStartX = startSample.armX * handSign; // + = dominant side, - = cross-body side
    const signedDeltaX = deltaArmX * handSign; // - = swinging across body (FH), + = opening out (BH)

    const preCrossedVotes = preSamples.filter((p) => p.crossedOver).length;
    const wasCrossedAtSetup =
      startSample.crossedOver ||
      (preSamples.length > 0 && preCrossedVotes >= Math.ceil(preSamples.length * 0.4));

    let wing: StrokeWing;
    if (wasCrossedAtSetup || signedStartX < -0.02) {
      // Clearly wound up crossed over / on backhand side
      wing = 'backhand';
    } else if (signedStartX > 0.22 && signedDeltaX <= 0.14) {
      // Clearly wound up wide on forehand side
      wing = 'forehand';
    } else if (Math.abs(signedDeltaX) > 0.18) {
      // Ambiguous center setup -> swing direction breaks tie cleanly!
      // Righty swinging left->right (+signedDeltaX) = backhand; right->left (-signedDeltaX) = forehand
      wing = signedDeltaX > 0 ? 'backhand' : 'forehand';
    } else {
      wing = startSample.wing;
    }

    // Report the setup/hitting zone (never the opposite-side follow-through zone!)
    let armZone: ArmZone;
    if (wing === 'backhand') {
      armZone = handedness === 'right' ? 'left' : 'right';
    } else if (signedStartX > 0.15) {
      armZone = handedness === 'right' ? 'right' : 'left';
    } else {
      armZone = startSample.armZone;
    }

    return {
      wing,
      armZone,
      armX: startSample.armX,
      deltaArmY,
      deltaArmX,
      hasWebcamData: true,
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
    this.snapshot.landmarks = landmarks;

    if (landmarks && landmarks.length >= 25) {
      const leftShoulder = landmarks[11];
      const rightShoulder = landmarks[12];
      const handedness = this.snapshot.arm.handedness;

      const isRight = handedness === 'right';
      const shoulder = isRight ? rightShoulder : leftShoulder;
      const elbow = isRight ? landmarks[14] : landmarks[13];
      const wrist = isRight ? landmarks[16] : landmarks[15];
      // Index knuckle extends past wrist in the direction the racket points!
      const indexTip = isRight ? landmarks[20] : landmarks[19];
      const handX = indexTip && (indexTip.visibility ?? 0) > 0.3 ? wrist.x * 0.65 + indexTip.x * 0.35 : wrist.x;
      const handY = indexTip && (indexTip.visibility ?? 0) > 0.3 ? wrist.y * 0.65 + indexTip.y * 0.35 : wrist.y;

      const shoulderMidX = (leftShoulder.x + rightShoulder.x) * 0.5;
      const shoulderWidth = Math.max(0.08, Math.abs(leftShoulder.x - rightShoulder.x));

      // Unmirrored camera x: person's RIGHT side has SMALLER image x.
      // Convert to player-centric coordinates where +X = player's right, -X = player's left.
      const toPlayerX = (imgX: number) => (shoulderMidX - imgX) / (shoulderWidth * 1.1);

      const handPlayerX = toPlayerX(handX);
      const elbowPlayerX = toPlayerX(elbow.x);
      const shoulderPlayerX = toPlayerX(shoulder.x);

      // Cross-body backhand detection!
      // For right-handed (handSign = +1):
      //   Even if elbow is still on the right side (elbowPlayerX > 0), if the forearm
      //   angles inward across the body (handPlayerX < elbowPlayerX - 0.22) AND the hand
      //   is past the dominant shoulder toward center/left (handPlayerX < shoulderPlayerX - 0.18),
      //   the arm is CROSSED OVER -> BACKHAND!
      const handSign = isRight ? 1 : -1;
      const forearmCrossedInward = (elbowPlayerX - handPlayerX) * handSign > 0.22;
      const handInsideDomShoulder = handPlayerX * handSign < shoulderPlayerX * handSign - 0.15;
      const handPastCenter = handPlayerX * handSign < 0.04;
      const crossedOver = handPastCenter || (forearmCrossedInward && handInsideDomShoulder);

      // Bias reported armX cleanly across center when forearm is crossed over
      const effectiveArmX = crossedOver
        ? Math.min(handPlayerX * handSign, -0.28) * handSign
        : handPlayerX;

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
      });
      while (this.history.length > 0 && nowMs - this.history[0].t > 700) {
        this.history.shift();
      }
    } else {
      this.snapshot.arm.active = false;
    }
  };

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
