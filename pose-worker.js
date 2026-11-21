/* pose-worker.js — Classic Worker for MediaPipe PoseLandmarker inference
 *
 * Messages IN:
 *   { type: 'init' }
 *   { type: 'detect', bitmap: ImageBitmap, timestamp: number }
 *
 * Messages OUT:
 *   { type: 'ready' }
 *   { type: 'result', landmarks: array|null, worldLandmarks: array|null }
 *   { type: 'error', message: string }
 *   { type: 'progress', stage: 'wasm'|'model', attempt: number, maxAttempts: number }
 */

importScripts('/mediapipe-vision.js');
// Per-device GPU/CPU choice (public/pose-bench.js). Optional: without it the worker stays on the GPU as before.
try { importScripts('/pose-bench.js'); } catch (_) { /* keep GPU */ }

// /mediapipe-vision.js is GENERATED from the installed @mediapipe/tasks-vision
// package by tools/build-mediapipe-worker-bundle.mjs: an IIFE exposing every
// package export as the global `Vision`, plus `Vision.__version`. Regenerate it
// after any package upgrade (npm run build:mediapipe-bundle); the contract test
// fails when the stamped version drifts from node_modules.
const visionApi = self.Vision || {};

const { PoseLandmarker, HandLandmarker, FilesetResolver } = visionApi;

let poseLandmarker = null;

// ─── On-demand HandLandmarker (2026-06-10, finger-serve feature) ───
// Pose model can't count fingers (only 3 crude hand points). The Hands model
// (21 landmarks) is created LAZILY on the first frame that asks for it and
// only runs while the main thread sets detectHands=true (serve-prep window).
// Zero cost during rallies.
let handLandmarker = null;
let handInitPromise = null;
let visionFileset = null; // saved from init so hands can reuse it
let poseDelegate = 'unknown';
// ?track=cpu|gpu (2026-10-09 diagnostic): the single forced delegate, so the hand model follows the pose model.
let forcedDelegate = null;
// Delegate benchmark (pose-bench.js): set after a GPU init unless the page sent bench: false.
let delegateBench = null;
let makePoseLandmarker = null;
let benchGpuLandmarker = null; // the GPU landmarker, parked while the CPU one is on trial
let poseModel = 'lite';
let handState = typeof HandLandmarker?.createFromOptions === 'function'
  ? 'lazy'
  : 'unavailable';
let handError = null;
// Finger read from the PREVIOUS frame's Hands pass. Pose is posted before Hands
// runs (2026-07-30 latency fix), so these ride along one frame later.
let lastFingerCount = null;
let lastHandsSeen = 0;

function capabilities() {
  return {
    source: 'worker',
    tasksVisionVersion: visionApi.__version || 'unknown',
    poseApi: typeof PoseLandmarker?.createFromOptions === 'function'
      && typeof FilesetResolver?.forVisionTasks === 'function',
    handApi: typeof HandLandmarker?.createFromOptions === 'function',
    handState,
    handError,
    poseDelegate,
    poseModel,
    benchGpuMs: delegateBench ? delegateBench.state.gpuMs : -1,
    benchCpuMs: delegateBench ? delegateBench.state.cpuMs : -1,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  };
}

function reportCapabilities() {
  self.postMessage({ type: 'capabilities', capabilities: capabilities() });
}

function safeClose(bitmap) {
  try { bitmap?.close(); } catch (_) { /* already closed / invalid bitmap */ }
}

function ensureHandLandmarker() {
  if (handLandmarker) return Promise.resolve(true);
  if (handInitPromise) return handInitPromise;
  if (handState === 'unavailable' || handState === 'failed') return Promise.resolve(false);

  handState = 'initializing';
  handError = null;
  reportCapabilities();

  // createFromOptions may throw synchronously or reject asynchronously. Catch
  // both here so optional Hands can never escape into the Pose frame catch.
  try {
    handInitPromise = Promise.resolve(HandLandmarker.createFromOptions(visionFileset, {
      baseOptions: {
        modelAssetPath: '/mediapipe/models/hand_landmarker.task',
        // Hands run where the pose model runs: on a weak GPU the point of the CPU policy is to leave the GPU to the scene.
        delegate: forcedDelegate || (poseDelegate === 'CPU' ? 'CPU' : 'GPU'),
      },
      runningMode: 'VIDEO',
      // 2 hands so we can pick the user's LEFT (gesture) hand by handedness —
      // with numHands:1 the model grabs whichever hand is most prominent, which
      // during a swing is the RIGHT (racket) hand → spurious finger counts.
      numHands: 2,
      // Relaxed from 0.5 for smaller, more distant hands in the 640×480 frame.
      minHandDetectionConfidence: 0.35,
      minHandPresenceConfidence: 0.35,
      canvas: typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : undefined,
    })).then((hl) => {
      handLandmarker = hl;
      handState = 'ready';
      reportCapabilities();
      return true;
    }).catch((err) => {
      handState = 'failed';
      handError = String(err?.message || err || 'initialization failed').slice(0, 160);
      console.warn('[pose-worker] HandLandmarker init failed:', handError);
      reportCapabilities();
      return false;
    });
  } catch (err) {
    handState = 'failed';
    handError = String(err?.message || err || 'initialization failed').slice(0, 160);
    console.warn('[pose-worker] HandLandmarker init failed:', handError);
    reportCapabilities();
    handInitPromise = Promise.resolve(false);
  }
  return handInitPromise;
}

// Count extended fingers (index/middle/ring/pinky) — classic tip-above-PIP test.
// Image coords: y grows downward, so an extended (raised) finger has tip.y < pip.y.
// Thumb is skipped (orientation-ambiguous). 1 finger = 1, 2 fingers = 2, etc.
function countFingers(lm) {
  if (!lm || lm.length < 21) return null;
  const pairs = [[8, 6], [12, 10], [16, 14], [20, 18]]; // [tip, pip]
  let count = 0;
  for (const [tip, pip] of pairs) {
    if (lm[tip].y < lm[pip].y - 0.02) count++; // small margin rejects half-curled
  }
  return count;
}

// ─── Off-thread skeleton render (2026-07-08, ?offscreen A/B) ───
// When the main thread enables it via a 'config' message, draw the skeleton
// here (in the worker) and post a finished ImageBitmap back, so the main thread
// does zero skeleton rasterization — it only blits. Mirrors PoseTracker's
// main-thread draw. NOTE: draws RAW landmarks (no low-light pose-hold, which is
// main-thread only), so the preview can look slightly jerkier in dim light.
let renderSkeleton = false;
let cfgW = 0, cfgH = 0;
let skelW = 0, skelH = 0;
let skelCanvas = null, skelCtx = null;
const POSE_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10],
  [11,12],[11,23],[12,24],[23,24],
  [11,13],[13,15],[15,17],[15,19],[15,21],[17,19],
  [12,14],[14,16],[16,18],[16,20],[16,22],[18,20],
  [23,25],[25,27],[27,29],[27,31],[29,31],
  [24,26],[26,28],[28,30],[28,32],[30,32],
];
const FACE_LANDMARKS = [0,1,2,3,4,5,6,7,8,9,10];
const BODY_LANDMARKS = [11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32];

function drawSkeletonBitmap(lm, w, h) {
  if (!skelCanvas || skelW !== w || skelH !== h) {
    skelCanvas = new OffscreenCanvas(w, h);
    skelCtx = skelCanvas.getContext('2d');
    skelW = w; skelH = h;
  }
  const ctx = skelCtx;
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);
  if (lm) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const face of [false, true]) {
      ctx.strokeStyle = face ? '#00e5ff' : '#C8A951';
      ctx.lineWidth = face ? 2 : 4;
      ctx.shadowColor = face ? '#00e5ff' : '#C8A951';
      ctx.shadowBlur = face ? 4 : 6;
      ctx.beginPath();
      for (const [a, b] of POSE_CONNECTIONS) {
        if (!lm[a] || !lm[b]) continue;
        if (lm[a].visibility < 0.3 || lm[b].visibility < 0.3) continue;
        if ((a <= 10 && b <= 10) !== face) continue;
        ctx.moveTo(lm[a].x * w, lm[a].y * h);
        ctx.lineTo(lm[b].x * w, lm[b].y * h);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath();
    for (const i of FACE_LANDMARKS) {
      if (!lm[i] || lm[i].visibility < 0.3) continue;
      ctx.moveTo(lm[i].x * w + 3, lm[i].y * h);
      ctx.arc(lm[i].x * w, lm[i].y * h, 3, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    for (const i of BODY_LANDMARKS) {
      if (!lm[i] || lm[i].visibility < 0.3) continue;
      ctx.moveTo(lm[i].x * w + 5, lm[i].y * h);
      ctx.arc(lm[i].x * w, lm[i].y * h, 5, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }
  return skelCanvas.transferToImageBitmap();
}

// LATENCY DIAGNOSTIC (2026-05-28): can this worker get a GPU (WebGL2) context?
// If not, MediaPipe's GPU delegate silently falls back to CPU (~50-120ms inference
// vs <10ms on GPU). Computed once at init, reported in every result for the HUD.
let gpuInfo = 'pending';
function detectGpu() {
  try {
    if (typeof OffscreenCanvas === 'undefined') return 'no-OffscreenCanvas';
    const oc = new OffscreenCanvas(4, 4);
    const gl = oc.getContext('webgl2') || oc.getContext('webgl');
    if (!gl) return 'NO-webgl';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'webgl-ok';
    // Trim ANGLE(...) wrapper for HUD readability.
    return r.replace(/^ANGLE \(/, '').slice(0, 28);
  } catch (e) {
    return 'err:' + (e && e.message ? e.message.slice(0, 20) : 'x');
  }
}

const MAX_RETRIES = 3;
const BACKOFF = [1000, 3000, 9000]; // exponential backoff

// ── Step 0 (2026-07-18): cache-warming prefetch with BYTE PROGRESS ──
// On slow networks (India 3G ≈ 400-700Kbps) the ~8-9MB first-visit download
// takes 90-180s, but init used to hard-timeout at 25s mid-download — success
// was impossible and the user saw a progress-less spinner then a false
// "camera didn't start". Fix: stream-fetch the assets ourselves first,
// posting {type:'progress', stage:'download', loaded, total} so (a) the UI
// can show a real percentage and (b) the client can SLIDE its init deadline
// while bytes are still arriving (only a genuinely stalled download times
// out). The assets are immutable-cached (verified content-encoding: br,
// max-age=1y), so consuming them here warms the HTTP cache and the real
// loads below (FilesetResolver + createFromOptions) hit disk in ~ms.
// Every failure here is NON-FATAL — we fall through to the normal init path.
const DEFAULT_POSE_MODEL = '/mediapipe/models/pose_landmarker_lite.task';
const PREFETCH_WASM = [
  '/mediapipe/wasm/vision_wasm_internal.js',
  '/mediapipe/wasm/vision_wasm_internal.wasm',
];

// Since the move to Amplify (2026-08-31) the host sends the engine and model uncompressed: 17.2 MB on a first visit
// (the note above dates from the old host). The site build writes gzip copies next to them (*.packed.wasm 3.4 MB,
// *.packed.task 5.0 MB), the same files and unpacking the cricket worker has used in production since 2026-09-30.
// They are tried first; anything unexpected (no DecompressionStream, a missing file, an error page) returns null and
// the plain files load exactly as before. ?packed=off on the page skips this.
const packedPath = (url) => url.replace(/\.(wasm|task)$/, '.packed.$1');
async function fetchPackedWithProgress(urls) {
  if (typeof DecompressionStream !== 'function') return null;
  let loaded = 0;
  let total = 0;
  let lastPost = 0;
  const post = (force) => {
    const now = Date.now();
    if (!force && now - lastPost < 500) return;
    lastPost = now;
    self.postMessage({ type: 'progress', stage: 'download', loaded, total });
  };
  try {
    const responses = await Promise.all(urls.map((url) => fetch(packedPath(url))));
    if (responses.some((res) => !res.ok)) return null;
    for (const res of responses) total += Number(res.headers.get('Content-Length') || 0);
    const out = [];
    for (const res of responses) {
      const parts = [];
      let size = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value); size += value.byteLength; loaded += value.byteLength;
          post(false);
        }
      } else {
        const whole = new Uint8Array(await res.arrayBuffer());
        parts.push(whole); size = whole.byteLength; loaded += size;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        out.push(new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()));
      } else if (bytes[0] === 0 && (bytes[1] === 0x61 || bytes[2] === 0x50)) {
        // A host that labels the copy as an encoding hands over the plain engine (" asm") or model ("  PK") already.
        out.push(bytes);
      } else {
        return null; // An error page or anything else: take the plain files.
      }
    }
    post(true);
    return out;
  } catch (_) {
    return null;
  }
}

async function prefetchWithProgress(assets) {
  let loaded = 0;
  let total = 0;
  let knownTotal = true;
  let lastPost = 0;
  const post = (force) => {
    const now = Date.now();
    if (!force && now - lastPost < 500) return; // throttle ~2/s
    lastPost = now;
    self.postMessage({ type: 'progress', stage: 'download', loaded, total: knownTotal ? total : 0 });
  };
  for (const url of assets) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) continue;
      const len = Number(res.headers.get('Content-Length') || 0);
      if (len > 0) total += len; else knownTotal = false;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        post(false);
      }
    } catch (_) { /* non-fatal — normal init path retries below */ }
  }
  post(true);
}

async function initWithRetry(opts) {
  if (typeof FilesetResolver?.forVisionTasks !== 'function'
      || typeof PoseLandmarker?.createFromOptions !== 'function') {
    throw new Error('MediaPipe Pose worker API is incomplete');
  }

  // Warm the HTTP cache with progress reporting (see PREFETCH_ASSETS above).
  // skipPrefetch (2026-07-30 latency): the page already streamed these three
  // files to completion, so they are in the HTTP cache and this pass would be
  // pure duplicate transfer — a cache entry only exists once a response finishes,
  // so an overlapping prefetch costs the full 17.4MB twice. Post one synthetic
  // 'download' progress message anyway to keep the client's sliding init
  // deadline armed and the loading copy honest.
  // ?model=full|heavy (2026-09-02 experiment): the main thread names the model.
  // A non-default model was never warmed by App.tsx, so prefetch it here with
  // progress regardless of skipPrefetch (the wasm entries are then cache hits).
  const modelAssetPath = (opts && opts.modelAssetPath) || DEFAULT_POSE_MODEL;
  poseModel = modelAssetPath === DEFAULT_POSE_MODEL
    ? 'lite'
    : ((/pose_landmarker_(lite|full|heavy)/.exec(modelAssetPath) || [])[1] || 'custom');
  // The packed engine and model first (see fetchPackedWithProgress): the fileset is resolved up front so the copy
  // matches the engine this browser will run (SIMD or not).
  let vision = null;
  let poseFileset = null;
  let poseModelBuffer = null;
  const packedAllowed = !(opts && opts.packed === false) && modelAssetPath === DEFAULT_POSE_MODEL
    && typeof DecompressionStream === 'function';
  if (packedAllowed) {
    try {
      const resolved = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const unpacked = await fetchPackedWithProgress([resolved.wasmBinaryPath, modelAssetPath]);
      if (unpacked) {
        vision = resolved;
        // Kept for the session: the landmarker can be rebuilt later from the same fileset.
        poseFileset = { ...resolved, wasmBinaryPath: URL.createObjectURL(new Blob([unpacked[0]], { type: 'application/wasm' })) };
        poseModelBuffer = unpacked[1];
      }
    } catch (_) { /* The plain files below. */ }
  }
  if (poseFileset) {
    /* Already downloaded, with progress. */
  } else if (opts && opts.skipPrefetch && modelAssetPath === DEFAULT_POSE_MODEL && !packedAllowed) {
    self.postMessage({ type: 'progress', stage: 'download', loaded: 1, total: 1 });
  } else {
    // A failed packed attempt cannot rely on the page's warm-up, which fetched the packed copies.
    await prefetchWithProgress([...PREFETCH_WASM, modelAssetPath]);
  }

  // Step 1: Load WASM fileset with retry
  for (let attempt = 1; attempt <= MAX_RETRIES && !vision; attempt++) {
    try {
      self.postMessage({ type: 'progress', stage: 'wasm', attempt, maxAttempts: MAX_RETRIES });
      // Self-hosted WASM; must come from the same package version stamped in
      // /mediapipe-vision.js (Vision.__version).
      // Was jsdelivr @latest — an unpinned tag against pinned glue (version-skew
      // landmine) AND an external dependency that failed/timed out on slow/geo
      // networks, driving `tracking_failed` (init_failed). See public/mediapipe/.
      vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      break;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw new Error('WASM download failed after ' + MAX_RETRIES + ' attempts: ' + (err.message || err));
      await new Promise(r => setTimeout(r, BACKOFF[attempt - 1]));
    }
  }

  // Save fileset for on-demand HandLandmarker (finger-serve feature)
  // Hands run on the same engine; with the packed copy that is the unpacked one, not a second plain download.
  visionFileset = poseFileset || vision;

  // Step 2: Create PoseLandmarker. Try GPU first (fast path), then fall back to
  // CPU. The GPU delegate fails or hangs on some browsers (notably Firefox) and
  // integrated GPUs; without a CPU fallback those users got stuck on a black
  // "Starting Camera" screen forever. CPU is slower (~50-120ms/frame) but lets
  // them actually play. (2026-06-24)
  const makePose = (delegate) => PoseLandmarker.createFromOptions(poseFileset || vision, {
    baseOptions: poseModelBuffer ? { modelAssetBuffer: poseModelBuffer, delegate } : {
      modelAssetPath,
      delegate,
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    // Low-light robustness (2026-06-13, research-backed): detection and
    // tracking confidence are INDEPENDENT stages. Keep detection at 0.3 to
    // acquire the player, but set TRACKING low (0.2) so once we're locked we
    // keep following a dim/low-confidence player across frames instead of
    // re-demanding a confident fresh detection — the model can't be retrained
    // for low light, so we lean on the tracker staying latched.
    minPoseDetectionConfidence: 0.3,
    minPosePresenceConfidence: 0.3,
    minTrackingConfidence: 0.2,
    // Use OffscreenCanvas for GPU rendering in worker
    canvas: typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : undefined,
  });

  let lastErr = null;
  // 2026-07-30 (latency): this used to run the NETWORK ladder here — 3 attempts
  // with BACKOFF [1000,3000,9000] per delegate, so a flaky GPU init cost 1s+3s of
  // sleeping before CPU was even tried, and CPU could add another 4s: up to 8s of
  // a black "Starting camera" screen. But model creation is not a download (the
  // .task file is already cached by this point) — it fails on GPU/driver
  // conditions that a long sleep does not change. Retry once, fast, then move to
  // the next delegate. A GPU delegate that HANGS instead of throwing was never
  // covered by these retries anyway; the client's 25s silence deadline owns that.
  const MODEL_MAX_RETRIES = 2;
  const MODEL_BACKOFF = [250, 750];
  // ?track=cpu|gpu sends a one-rung ladder: a forced GPU that cannot start fails loudly rather than
  // silently running on the CPU (the delegate_gpu field in the perf row reports what actually ran).
  const ladder = opts && Array.isArray(opts.delegates) && opts.delegates.length ? opts.delegates : ['GPU', 'CPU'];
  forcedDelegate = ladder.length === 1 ? ladder[0] : null;
  for (const delegate of ladder) {
    for (let attempt = 1; attempt <= MODEL_MAX_RETRIES; attempt++) {
      try {
        self.postMessage({ type: 'progress', stage: 'model', attempt, maxAttempts: MODEL_MAX_RETRIES });
        poseLandmarker = await makePose(delegate);
        poseDelegate = delegate;
        break;
      } catch (err) {
        lastErr = err;
        self.postMessage({ type: 'progress', stage: delegate === 'GPU' ? 'gpu_init_failed' : 'cpu_init_failed', attempt, maxAttempts: MODEL_MAX_RETRIES });
        if (attempt === MODEL_MAX_RETRIES) break; // exhausted this delegate — try the next
        await new Promise(r => setTimeout(r, MODEL_BACKOFF[attempt - 1]));
      }
    }
    if (poseLandmarker) break;
  }
  if (!poseLandmarker) {
    throw new Error('Model init failed on ' + ladder.join(' and ') + ': ' + (lastErr && (lastErr.message || lastErr)));
  }
  makePoseLandmarker = makePose;
  delegateBench = opts && opts.bench !== false && poseDelegate === 'GPU' && self.PoseBench
    ? self.PoseBench.createDelegateBench({ cores: (self.navigator && self.navigator.hardwareConcurrency) || 0 })
    : null;
}

function safeCloseLandmarker(landmarker) {
  try { landmarker && landmarker.close(); } catch (_) { /* already gone */ }
}

// Feed one frame's inference time to the delegate benchmark, start the CPU trial when it asks, and settle on the
// winner. Swaps happen between frames (this worker handles one message at a time).
function stepDelegateBench(inferenceMs) {
  const bench = delegateBench;
  if (!bench || bench.state.phase === 'done') return;
  const before = bench.state.phase;
  if (before === 'cpu') bench.cpuFrame(inferenceMs);
  else bench.gpuFrame(inferenceMs);
  if (before === 'gpu' && bench.state.phase === 'want-cpu') {
    Promise.resolve()
      .then(() => makePoseLandmarker('CPU'))
      .then((cpuLandmarker) => {
        if (delegateBench !== bench || bench.state.phase !== 'want-cpu') { safeCloseLandmarker(cpuLandmarker); return; }
        benchGpuLandmarker = poseLandmarker;
        poseLandmarker = cpuLandmarker;
        bench.cpuReady();
      })
      .catch(() => {
        if (delegateBench !== bench) return;
        bench.cpuUnavailable();
        self.postMessage({ type: 'capabilities', capabilities: capabilities() });
      });
  }
  if (before === 'cpu' && bench.state.phase === 'done') {
    if (bench.state.choice === 'CPU') {
      safeCloseLandmarker(benchGpuLandmarker);
      poseDelegate = 'CPU';
    } else {
      safeCloseLandmarker(poseLandmarker);
      poseLandmarker = benchGpuLandmarker;
    }
    benchGpuLandmarker = null;
  }
  if (bench.state.phase === 'done') self.postMessage({ type: 'capabilities', capabilities: capabilities() });
}

self.onmessage = async function (e) {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      await initWithRetry({ skipPrefetch: !!msg.skipPrefetch, modelAssetPath: msg.modelAssetPath, bench: msg.bench, packed: msg.packed === true, delegates: msg.delegates });
      gpuInfo = detectGpu();
      self.postMessage({ type: 'ready', capabilities: capabilities() });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
    return;
  }

  // ?offscreen: main thread turns on worker-side skeleton rendering (re-sent on
  // every worker restart so a fresh worker picks it back up).
  if (msg.type === 'config') {
    renderSkeleton = !!msg.renderSkeleton && typeof OffscreenCanvas !== 'undefined';
    cfgW = msg.canvasW || 0;
    cfgH = msg.canvasH || 0;
    return;
  }

  // P2 LAG FIX (2026-07-18): pre-warm the HandLandmarker during idle. It used
  // to lazy-init on the FIRST serve-prep frame, stalling pose inference for
  // seconds right as the first serve started (watchdog fired in playtest).
  // ensureHandLandmarker is promise-guarded + idempotent, so warming early is
  // free; the serve-prep path finds it already 'ready'.
  if (msg.type === 'warm-hands') {
    if (visionFileset) void ensureHandLandmarker();
    return;
  }

  if (msg.type === 'detect') {
    if (!poseLandmarker) {
      safeClose(msg.bitmap);
      safeClose(msg.handsBitmap);
      self.postMessage({
        type: 'result',
        landmarks: null,
        worldLandmarks: null,
        captureTs: msg.captureTs,
        inferenceMs: 0,
        handState,
        handError,
        poseStatus: 'error',
        poseError: 'PoseLandmarker is not initialized',
      });
      return;
    }

    const handsPassPending = !!(msg.detectHands && msg.handsBitmap);
    // Set once the pose result has gone out, so a later failure (hands, cache)
    // cannot post a second 'result' with null landmarks and blip tracking.
    let posePosted = false;
    try {
      // LATENCY INSTRUMENTATION (2026-05-28): time the GPU inference and echo
      // back the frame's capture timestamp so the main thread can compute
      // end-to-end latency (capture → landmarks-in-hand).
      const inW = msg.bitmap.width;
      const inH = msg.bitmap.height;
      const _t0 = performance.now();
      const result = poseLandmarker.detectForVideo(msg.bitmap, msg.timestamp);
      const inferenceMs = performance.now() - _t0;
      stepDelegateBench(inferenceMs);

      // ── POST POSE FIRST (2026-07-30 latency audit) ──────────────────────
      // This used to sit AFTER the Hands block, so during serve prep every
      // pose result waited on a second model's inference (~40% of the frame
      // budget by this file's own note) before the avatar could move. Pose is
      // all the avatar and ball need; finger counts ride along on the NEXT
      // frame via the caches below — one frame (~33ms) is nothing against the
      // 700ms gesture-stability lock that consumes them.
      const landmarks = result.landmarks && result.landmarks.length > 0
        ? result.landmarks[0]
        : null;
      const worldLandmarks = result.worldLandmarks && result.worldLandmarks.length > 0
        ? result.worldLandmarks[0]
        : null;
      let skeletonBitmap = null;
      if (renderSkeleton && cfgW && cfgH) {
        try { skeletonBitmap = drawSkeletonBitmap(landmarks, cfgW, cfgH); } catch (_) { skeletonBitmap = null; }
      }
      safeClose(msg.bitmap);
      // ONE-SHOT finger cache: consume it here and clear. If it were left set,
      // every later Pose result would keep republishing the same reading and the
      // main thread refreshes __fingerCountAt each time — so a hand raised for
      // one frame would look "just seen" forever and could auto-lock a serve
      // placement the player never chose. Publishing once means the reading goes
      // stale the moment Hands stops producing new ones, which is correct.
      const outFingerCount = lastFingerCount;
      const outHandsSeen = lastHandsSeen;
      lastFingerCount = null;
      lastHandsSeen = 0;
      self.postMessage({
        type: 'result', landmarks, worldLandmarks, captureTs: msg.captureTs, inferenceMs,
        inW, inH, gpu: gpuInfo,
        fingerCount: outFingerCount, handsSeen: outHandsSeen,
        handState, handError, poseStatus: landmarks ? 'ok' : 'no-person', skeletonBitmap,
        processingComplete: !handsPassPending,
      }, skeletonBitmap ? [skeletonBitmap] : undefined);
      posePosted = true;

      // ── Finger-serve: run Hands model on its DEDICATED 640×480 bitmap ──
      // (serve-prep window only — main thread gates via detectHands flag).
      // v2 BUGFIX: was running on the 320×240 pose bitmap where a hand is ~30px —
      // the model never detected anything. Hands now get their own larger frame.
      let fingerCount = null;
      let handsSeen = 0; // how many hands the HandLandmarker found this frame (for finger debug)
      if (msg.detectHands && msg.handsBitmap) {
        try {
          if (handLandmarker) {
          try {
            const hr = handLandmarker.detectForVideo(msg.handsBitmap, msg.timestamp);
            // Gestures come from the user's LEFT hand ONLY (right = racket hand).
            // 2026-06-12 FIX: picking by MediaPipe handedness LABEL never matched
            // the left hand in playtest (mirror-convention ambiguity) → fingerCount
            // was always null and gestures silently did nothing. Instead match each
            // detected hand's wrist (landmark 0) to the POSE model's wrists from the
            // SAME frame — pose 15 = user's left, 16 = right. Both bitmaps are the
            // same frame resized, so normalized coords align. No label conventions.
            const hands = hr.landmarks || [];
            const poseLm = result.landmarks && result.landmarks.length > 0 ? result.landmarks[0] : null;
            const lw = poseLm && poseLm[15]; // user's LEFT (gesture) wrist
            const rw = poseLm && poseLm[16]; // user's RIGHT (racket) wrist
            // 2026-06-13 ROBUST PICK: the gesture hand is the LEFT hand = the one
            // FARTHEST from the RIGHT/racket wrist. The right wrist is the dominant,
            // best-tracked landmark; the previous logic depended on the LEFT wrist
            // being visible (>0.3), which fails in low light / low Hz — and when
            // BOTH hands were detected it then picked nothing. We no longer require
            // left-wrist visibility. The racket hand grips a fist → countFingers=0
            // → ignored downstream, so even a mis-pick can't inject a fake gesture.
            const rwOK = rw && (rw.visibility == null || rw.visibility > 0.3);
            const lwOK = lw && (lw.visibility == null || lw.visibility > 0.3);
            let gestureHand = null;
            if (hands.length === 1) {
              // Single hand: count it unless it's clearly the racket (right) hand.
              const w = hands[0][0];
              if (rwOK && Math.hypot(w.x - rw.x, w.y - rw.y) < 0.18) gestureHand = null;
              else gestureHand = hands[0];
            } else if (hands.length >= 2) {
              let best = null, bestScore = -Infinity;
              for (const hand of hands) {
                const w = hand[0];
                let score;
                if (rwOK) score = Math.hypot(w.x - rw.x, w.y - rw.y);        // farther from racket = better
                else if (lwOK) score = -Math.hypot(w.x - lw.x, w.y - lw.y);  // closer to left wrist = better
                else score = -w.x;                                           // last resort: leftmost hand
                if (score > bestScore) { bestScore = score; best = hand; }
              }
              gestureHand = best;
            }
            if (gestureHand) fingerCount = countFingers(gestureHand);
            handsSeen = hands.length;
          } catch (_) { /* hands inference hiccup — skip frame */ }
          } else {
            void ensureHandLandmarker(); // warm up; counts start a few frames later
          }
        } catch (err) {
          // Hands is optional. A failure here must not turn a healthy Pose
          // result into a tracking dropout.
          handError = String(err?.message || err || 'inference failed').slice(0, 160);
          console.warn('[pose-worker] HandLandmarker frame failed:', handError);
        } finally {
          safeClose(msg.handsBitmap);
        }
      }
      // Pose was already posted above. Cache this frame's finger read so it
      // rides along on the next pose result.
      lastFingerCount = fingerCount;
      lastHandsSeen = handsSeen;
    } catch (err) {
      safeClose(msg.bitmap);
      safeClose(msg.handsBitmap);
      // A CPU landmarker on trial that cannot run: back to the GPU one at once, trial over.
      if (!posePosted && benchGpuLandmarker) {
        safeCloseLandmarker(poseLandmarker);
        poseLandmarker = benchGpuLandmarker;
        benchGpuLandmarker = null;
        if (delegateBench) delegateBench.state.phase = 'done';
      }
      if (!posePosted) {
        self.postMessage({ type: 'result', landmarks: null, worldLandmarks: null, captureTs: msg.captureTs, inferenceMs: 0, handState, handError, poseStatus: 'error', poseError: String(err?.message || err || 'inference failed').slice(0, 160) });
      } else {
        // Pose already delivered; only the Hands pass failed. Keep it non-fatal.
        handError = String(err?.message || err || 'hands failed').slice(0, 160);
      }
    }
    // Pose can be consumed immediately, but the main thread must not queue a
    // new bitmap until the optional Hands pass has released its GPU work.
    if (handsPassPending && posePosted) self.postMessage({ type: 'frame-complete' });
    return;
  }
};
