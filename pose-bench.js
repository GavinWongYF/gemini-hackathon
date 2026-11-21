/* pose-bench.js — chooses the faster pose delegate on this device (loaded by pose-worker.js).
 *
 * Android tennis visits had a 152 ms e2e p95 against 42 ms on iPhone (visits, 2026-09-22..10-06), and only half of
 * their camera frames got a pose. Some phone GPUs run the lite model slower than the phone's CPU does, so after
 * the GPU has warmed up the worker times it, and only when it is slow tries the CPU on live frames and keeps the
 * faster one. Pure state machine: the worker feeds it each frame's inference time and asks what to run next.
 */
(function (root) {
  const WARM_FRAMES = 15;      // GPU shader compile and first detections are slow; not representative.
  const SAMPLE_FRAMES = 20;    // GPU frames timed after warm-up.
  const GPU_OK_MS = 30;        // At or under this the GPU keeps up with a 30 fps camera: no CPU trial.
  const CPU_SKIP_FRAMES = 3;   // A fresh landmarker runs its person detector first.
  const CPU_SAMPLE_FRAMES = 15;
  const CPU_EARLY_FRAMES = 4;  // Give up on the CPU after this many frames if it is clearly worse.
  const CPU_MUST_WIN = 0.8;    // CPU kept only when at least 20% faster than the GPU.

  function median(xs) {
    const sorted = xs.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  /** phase: 'gpu' timing the GPU, 'want-cpu' waiting for the worker to create a CPU landmarker,
   * 'cpu' timing the CPU, 'done'. `choice` is 'GPU' or 'CPU' once done. */
  function createDelegateBench(options) {
    const cores = (options && options.cores) || 0;
    const state = { phase: 'gpu', choice: 'GPU', gpuMs: -1, cpuMs: -1, frames: 0, gpu: [], cpu: [] };

    function finish(choice) {
      state.phase = 'done';
      state.choice = choice;
    }

    return {
      state,
      /** Record one GPU-delegate frame's inference time. */
      gpuFrame(ms) {
        if (state.phase !== 'gpu') return;
        state.frames++;
        if (state.frames <= WARM_FRAMES) return;
        state.gpu.push(ms);
        if (state.gpu.length < SAMPLE_FRAMES) return;
        state.gpuMs = median(state.gpu);
        // A CPU trial needs spare cores: the main thread, the camera and the GPU process run beside it.
        if (state.gpuMs <= GPU_OK_MS || cores < 4) finish('GPU');
        else state.phase = 'want-cpu';
      },
      /** The worker could not create the CPU landmarker. */
      cpuUnavailable() {
        if (state.phase === 'want-cpu') finish('GPU');
      },
      cpuReady() {
        if (state.phase === 'want-cpu') { state.phase = 'cpu'; state.frames = 0; }
      },
      /** Record one CPU-delegate frame's inference time. */
      cpuFrame(ms) {
        if (state.phase !== 'cpu') return;
        state.frames++;
        if (state.frames <= CPU_SKIP_FRAMES) return;
        state.cpu.push(ms);
        const early = state.cpu.length === CPU_EARLY_FRAMES && median(state.cpu) > state.gpuMs * 1.5;
        if (!early && state.cpu.length < CPU_SAMPLE_FRAMES) return;
        state.cpuMs = median(state.cpu);
        finish(state.cpuMs < state.gpuMs * CPU_MUST_WIN ? 'CPU' : 'GPU');
      },
    };
  }

  root.PoseBench = { createDelegateBench };
})(typeof self !== 'undefined' ? self : globalThis);
