// Zero-edit 1 Hz `court` JPEG frame capturer for Felix & Gavin's `frames` WebSocket message.
// Never requires modifying Akhil's `CourtScene.tsx`:
//   1. First probes Akhil's WebGL `<canvas>` inside `.scene-root` — if non-blank pixels are present,
//      scales it directly to a ~384px JPEG.
//   2. If WebGL cleared its drawing buffer (`preserveDrawingBuffer` false) or fallback 2D mode is active,
//      renders a crisp 384x288 top-down broadcast court diagram from `MatchRenderState` + `RecordedShot[]`
//      so Gemini Decision 1 (`watcher`) ALWAYS receives a clean, informative `court` frame!

import { COURT, type MatchRenderState, type RecordedShot } from '@shared/contracts';

const TARGET_W = 384;
const TARGET_H = 288;

let scratchCanvas: HTMLCanvasElement | null = null;
let probeCanvas: HTMLCanvasElement | null = null;

function ensureScratchCanvas(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!scratchCanvas) {
    scratchCanvas = document.createElement('canvas');
    scratchCanvas.width = TARGET_W;
    scratchCanvas.height = TARGET_H;
  }
  return scratchCanvas.getContext('2d');
}

function isWebGlCanvasNonBlank(glCanvas: HTMLCanvasElement): boolean {
  if (glCanvas.width === 0 || glCanvas.height === 0) return false;
  if (!probeCanvas) {
    probeCanvas = document.createElement('canvas');
    probeCanvas.width = 16;
    probeCanvas.height = 16;
  }
  const pctx = probeCanvas.getContext('2d', { willReadFrequently: true });
  if (!pctx) return false;
  pctx.clearRect(0, 0, 16, 16);
  pctx.drawImage(glCanvas, 0, 0, 16, 16);
  const data = pctx.getImageData(0, 0, 16, 16).data;
  for (let i = 0; i < data.length; i += 16) {
    if (data[i + 3] > 10 && (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8)) {
      return true;
    }
  }
  return false;
}

export function captureCourtJpeg(
  state: MatchRenderState,
  recentShots: RecordedShot[],
  sceneContainer?: HTMLElement | null,
  quality = 0.7,
): string | null {
  const ctx = ensureScratchCanvas();
  if (!ctx || !scratchCanvas) return null;

  const glCanvas = sceneContainer?.querySelector('canvas') ?? null;
  if (glCanvas && isWebGlCanvasNonBlank(glCanvas)) {
    ctx.drawImage(glCanvas, 0, 0, TARGET_W, TARGET_H);
  } else {
    drawTacticalCourt(ctx, TARGET_W, TARGET_H, state, recentShots);
  }

  const dataUrl = scratchCanvas.toDataURL('image/jpeg', quality);
  const commaIdx = dataUrl.indexOf(',');
  return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
}

export function drawTacticalCourt(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  state: MatchRenderState,
  recentShots: RecordedShot[],
) {
  // Stadium apron
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);

  const padX = w * 0.2;
  const padY = h * 0.08;
  const courtW = w - padX * 2;
  const courtH = h - padY * 2;

  const toCanvasX = (x: number) => w * 0.5 + (x / COURT.PAINTED_HALF_W) * (courtW * 0.5);
  const toCanvasY = (z: number) => h * 0.5 + (z / COURT.BASELINE_Z) * (courtH * 0.5);

  // Inner Grand Slam hard court
  ctx.fillStyle = '#1d4ed8';
  ctx.fillRect(padX, padY, courtW, courtH);

  // Court lines
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = 2;
  ctx.strokeRect(padX, padY, courtW, courtH);

  // Service lines & center service line
  const svcTopY = toCanvasY(-COURT.SERVICE_LINE_Z);
  const svcBotY = toCanvasY(COURT.SERVICE_LINE_Z);
  ctx.beginPath();
  ctx.moveTo(padX, svcTopY);
  ctx.lineTo(padX + courtW, svcTopY);
  ctx.moveTo(padX, svcBotY);
  ctx.lineTo(padX + courtW, svcBotY);
  ctx.moveTo(w * 0.5, svcTopY);
  ctx.lineTo(w * 0.5, svcBotY);
  ctx.stroke();

  // Net line (z = 0)
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(padX - 10, h * 0.5);
  ctx.lineTo(padX + courtW + 10, h * 0.5);
  ctx.stroke();

  // Recent shot trajectories & bounce dots
  for (const shot of recentShots.slice(-6)) {
    if (shot.arc.length >= 2) {
      ctx.strokeStyle = shot.actor === 'human' ? 'rgba(56, 189, 248, 0.7)' : 'rgba(251, 113, 133, 0.7)';
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      shot.arc.forEach((pt, idx) => {
        const cx = toCanvasX(pt.x);
        const cy = toCanvasY(pt.z);
        if (idx === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      });
      ctx.stroke();
    }
    if (shot.bouncePos) {
      ctx.fillStyle = shot.actor === 'human' ? '#38bdf8' : '#fb7185';
      ctx.beginPath();
      ctx.arc(toCanvasX(shot.bouncePos.x), toCanvasY(shot.bouncePos.z), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Opponent (top, -Z)
  const oppX = toCanvasX(state.opponent.x);
  const oppY = toCanvasY(state.opponent.z);
  ctx.fillStyle = '#f97316';
  ctx.beginPath();
  ctx.arc(oppX, oppY, 7, 0, Math.PI * 2);
  ctx.fill();

  // Human player (bottom, +Z)
  const plX = toCanvasX(state.player.x);
  const plY = toCanvasY(state.player.z);
  ctx.fillStyle = '#38bdf8';
  ctx.beginPath();
  ctx.arc(plX, plY, 7, 0, Math.PI * 2);
  ctx.fill();

  // Live ball + predicted landing marker
  if (state.ball.active) {
    if (state.ball.landingMarker) {
      ctx.strokeStyle = '#fde047';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(
        toCanvasX(state.ball.landingMarker.x),
        toCanvasY(state.ball.landingMarker.z),
        6,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    ctx.fillStyle = '#d9ff2b';
    ctx.beginPath();
    ctx.arc(toCanvasX(state.ball.x), toCanvasY(state.ball.z), 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
