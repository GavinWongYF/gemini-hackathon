// Zero-edit 1 Hz `court` JPEG frame capturer + clean architectural 2D court renderer.

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
    drawTacticalCourt(ctx, TARGET_W, TARGET_H, state, recentShots, false);
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
  showReplayOverlay = false,
) {
  // Clean hard-court outer apron
  ctx.fillStyle = '#e8eef5';
  ctx.fillRect(0, 0, w, h);

  // Maintain realistic court proportions (11m x 23m)
  const courtAspect = (COURT.PAINTED_HALF_W * 2) / (COURT.BASELINE_Z * 2);
  let courtH = h * 0.82;
  let courtW = courtH * courtAspect;
  if (courtW > w * 0.72) {
    courtW = w * 0.72;
    courtH = courtW / courtAspect;
  }
  const padX = (w - courtW) * 0.5;
  const padY = (h - courtH) * 0.5;

  const toCanvasX = (x: number) => w * 0.5 + (x / COURT.PAINTED_HALF_W) * (courtW * 0.5);
  const toCanvasY = (z: number) => h * 0.5 + (z / COURT.BASELINE_Z) * (courtH * 0.5);

  // Inner US Open blue court
  ctx.fillStyle = '#1967d2';
  ctx.fillRect(padX, padY, courtW, courtH);

  // Crisp court lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = Math.max(1.5, w * 0.0025);
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
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2.5, w * 0.004);
  ctx.beginPath();
  ctx.moveTo(padX - 10, h * 0.5);
  ctx.lineTo(padX + courtW + 10, h * 0.5);
  ctx.stroke();

  // Only draw shot trajectories & bounce heat map on the court during replay/pause (taken away during play)
  if (showReplayOverlay && recentShots.length > 0) {
    for (const shot of recentShots.slice(-8)) {
      if (shot.bouncePos) {
        const bx = toCanvasX(shot.bouncePos.x);
        const by = toCanvasY(shot.bouncePos.z);
        const r = Math.max(18, courtW * 0.09);
        const grad = ctx.createRadialGradient(bx, by, 2, bx, by, r);
        if (shot.actor === 'human') {
          grad.addColorStop(0, 'rgba(138, 180, 248, 0.72)');
          grad.addColorStop(1, 'rgba(138, 180, 248, 0)');
        } else {
          grad.addColorStop(0, 'rgba(242, 139, 130, 0.72)');
          grad.addColorStop(1, 'rgba(242, 139, 130, 0)');
        }
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
      }

      if (shot.arc.length >= 2) {
        ctx.strokeStyle =
          shot.actor === 'human' ? 'rgba(255, 255, 255, 0.85)' : 'rgba(253, 214, 99, 0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        shot.arc.forEach((pt, idx) => {
          const cx = toCanvasX(pt.x);
          const cy = toCanvasY(pt.z);
          if (idx === 0) ctx.moveTo(cx, cy);
          else ctx.lineTo(cx, cy);
        });
        ctx.stroke();
      }
    }
  }

  // Opponent marker (top, -Z)
  const oppX = toCanvasX(state.opponent.x);
  const oppY = toCanvasY(state.opponent.z);
  ctx.fillStyle = '#d93025';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(oppX, oppY, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Player marker (bottom, +Z)
  const plX = toCanvasX(state.player.x);
  const plY = toCanvasY(state.player.z);
  ctx.fillStyle = '#0b57d0';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(plX, plY, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Live ball + subtle landing target ring
  if (state.ball.active) {
    if (state.ball.landingMarker) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.lineWidth = 1.5;
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
    ctx.fillStyle = '#d4e157';
    ctx.strokeStyle = '#1f1f1f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(toCanvasX(state.ball.x), toCanvasY(state.ball.z), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
