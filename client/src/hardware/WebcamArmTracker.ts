import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { ArmZone, StrokeWing, WebcamArmState } from '@shared/contracts';
import { OneEuroFilter } from './OneEuroFilter';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const MEDIAPIPE_WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm';
const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// Downscale before MediaPipe inference so main-thread latency stays <10ms
const INFER_W = 256;
const INFER_H = 192;
const MIN_INFER_INTERVAL_MS = 33; // ~30 Hz max, never starves IMU or rendering

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
 * using MediaPipe PoseLandmarker on a downscaled 256×192 offscreen buffer,
 * and exposes 384px unmirrored JPEG frames for Felix & Gavin's `frames` WS message.
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
    this.snapshot.arm.wing = this.inferWing(this.snapshot.arm.armX, handedness);
    this.emitStatus();
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
    this.snapshot.arm.active = false;
    this.snapshot.status = 'idle';
    this.snapshot.landmarks = null;
    this.emitStatus();
  }

  /**
   * Captures an unmirrored ~384px wide JPEG frame (base64 without data-URI prefix)
   * matching Felix & Gavin's Notion API Design `frames.views.player_cam` contract.
   */
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

    // Downscale to 256×192 for ultra-fast pose inference
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

      const wrist = handedness === 'right' ? landmarks[16] : landmarks[15];
      const elbow = handedness === 'right' ? landmarks[14] : landmarks[13];

      const shoulderMidX = (leftShoulder.x + rightShoulder.x) * 0.5;
      const shoulderWidth = Math.max(0.08, Math.abs(leftShoulder.x - rightShoulder.x));

      const wristOffsetFromCenter = (shoulderMidX - wrist.x) / (shoulderWidth * 1.15);
      const rawArmX = clamp(wristOffsetFromCenter, -1, 1);
      const rawArmY = clamp(1 - wrist.y, 0, 1);

      const filteredArmX = this.armXFilter.filter(rawArmX, nowMs);
      const filteredArmY = this.armYFilter.filter(rawArmY, nowMs);

      const prevZone = this.snapshot.arm.armZone;
      const armZone = this.classifyZoneWithHysteresis(filteredArmX, prevZone);
      const wing = this.inferWing(filteredArmX, handedness);
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
    } else {
      this.snapshot.arm.active = false;
    }
  };

  private classifyZoneWithHysteresis(armX: number, prev: ArmZone): ArmZone {
    const enterThresh = 0.24;
    const exitThresh = 0.14;

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

  private inferWing(armX: number, handedness: 'right' | 'left'): StrokeWing {
    if (handedness === 'right') {
      return armX >= -0.05 ? 'forehand' : 'backhand';
    }
    return armX <= 0.05 ? 'forehand' : 'backhand';
  }

  private emitStatus() {
    for (const cb of this.listeners) cb(this.snapshot);
  }
}
