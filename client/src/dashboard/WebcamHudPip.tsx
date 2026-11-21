// Section 16.1: Compact bottom-left webcam PiP (~200x150px) over the 3D court viewport.
// Mirrors the display video for intuitive player feedback while keeping `frames.views.player_cam`
// completely untouched/unmirrored, draws tracked dominant arm landmarks, and displays live chips
// for FOREHAND/BACKHAND, arm zone (LEFT/CENTER/RIGHT), and swing-start flash.

import React, { useEffect, useRef } from 'react';
import type { ArmZone, StrokeWing } from '@shared/contracts';
import { hardwareInput } from '../hardware/HardwareInputManager';

const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const PIP_W = 200;
const PIP_H = 122;

export interface WebcamHudPipProps {
  webcamStatus: 'idle' | 'loading' | 'running' | 'error';
  wing: StrokeWing;
  armZone: ArmZone;
  swingFlashActive: boolean;
}

export const WebcamHudPip: React.FC<WebcamHudPipProps> = ({
  webcamStatus,
  wing,
  armZone,
  swingFlashActive,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let rafId = 0;
    let lastDrawMs = 0;

    const draw = (now: number) => {
      rafId = requestAnimationFrame(draw);
      if (now - lastDrawMs < 33) return; // ~30 FPS
      lastDrawMs = now;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const video = hardwareInput.webcam.getVideoElement();
      const snap = hardwareInput.webcam.getSnapshot();

      ctx.clearRect(0, 0, PIP_W, PIP_H);

      if (snap.status !== 'running' || !video || video.readyState < 2 || video.videoWidth === 0) {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, PIP_W, PIP_H);
        ctx.fillStyle = '#94a3b8';
        ctx.font = `600 11px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          snap.status === 'loading' ? 'CAMERA STARTING...' : 'CAMERA OFF',
          PIP_W / 2,
          PIP_H / 2,
        );
        return;
      }

      // Draw mirrored webcam feed for natural player self-view (does NOT affect player_cam JPEG)
      ctx.save();
      ctx.translate(PIP_W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, PIP_W, PIP_H);
      ctx.restore();

      // Subtle vignette for landmark readability
      ctx.fillStyle = 'rgba(2, 6, 23, 0.16)';
      ctx.fillRect(0, 0, PIP_W, PIP_H);

      const lm = snap.landmarks;
      if (lm && lm.length >= 25) {
        const isRight = snap.arm.handedness === 'right';
        const lSh = lm[11];
        const rSh = lm[12];
        const domSh = isRight ? rSh : lSh;
        const domEl = isRight ? lm[14] : lm[13];
        const domWr = isRight ? lm[16] : lm[15];

        // Map normalized MediaPipe coordinates into mirrored canvas coordinates
        const mx = (x: number) => (1 - x) * PIP_W;
        const my = (y: number) => y * PIP_H;

        // Torso shoulder line + centerline
        if (lSh && rSh) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(mx(lSh.x), my(lSh.y));
          ctx.lineTo(mx(rSh.x), my(rSh.y));
          ctx.stroke();

          const midX = mx((lSh.x + rSh.x) * 0.5);
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(midX, 8);
          ctx.lineTo(midX, PIP_H - 8);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Dominant arm skeleton (shoulder -> elbow -> wrist)
        const armColor = swingFlashActive
          ? '#f59e0b'
          : snap.arm.wing === 'backhand'
            ? '#a855f7'
            : '#38bdf8';

        if (domSh && domEl && domWr) {
          ctx.strokeStyle = armColor;
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(mx(domSh.x), my(domSh.y));
          ctx.lineTo(mx(domEl.x), my(domEl.y));
          ctx.lineTo(mx(domWr.x), my(domWr.y));
          ctx.stroke();

          // Elbow joint dot
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(mx(domEl.x), my(domEl.y), 3.2, 0, Math.PI * 2);
          ctx.fill();

          // Highlighted wrist target dot
          ctx.fillStyle = armColor;
          ctx.beginPath();
          ctx.arc(mx(domWr.x), my(domWr.y), swingFlashActive ? 6.5 : 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      }

      if (swingFlashActive) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 3;
        ctx.strokeRect(1.5, 1.5, PIP_W - 3, PIP_H - 3);
      }
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [swingFlashActive]);

  const isRunning = webcamStatus === 'running';

  return (
    <div
      style={{
        position: 'absolute',
        left: 18,
        bottom: 18,
        width: PIP_W,
        zIndex: 20,
        pointerEvents: 'none',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'rgba(15, 23, 42, 0.92)',
        border: swingFlashActive
          ? '1.5px solid #f59e0b'
          : '1px solid rgba(255, 255, 255, 0.22)',
        boxShadow: '0 8px 24px rgba(2, 6, 23, 0.42)',
      }}
    >
      <canvas
        ref={canvasRef}
        width={PIP_W}
        height={PIP_H}
        style={{ display: 'block', width: PIP_W, height: PIP_H }}
      />

      {/* Three compact detection chips below live picture */}
      <div
        style={{
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 4,
          padding: '0 6px',
          background: '#0b1220',
          borderTop: '1px solid rgba(255, 255, 255, 0.1)',
          fontFamily: MONO,
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: '0.03em',
        }}
      >
        <span
          style={{
            padding: '2px 5px',
            borderRadius: 4,
            background: isRunning
              ? wing === 'backhand'
                ? 'rgba(168, 85, 247, 0.22)'
                : 'rgba(56, 189, 248, 0.22)'
              : 'rgba(148, 163, 184, 0.14)',
            color: isRunning ? (wing === 'backhand' ? '#d8b4fe' : '#7dd3fc') : '#64748b',
          }}
        >
          {isRunning ? wing.toUpperCase() : '—'}
        </span>

        <span
          style={{
            padding: '2px 5px',
            borderRadius: 4,
            background: 'rgba(255, 255, 255, 0.08)',
            color: isRunning ? '#e2e8f0' : '#64748b',
          }}
        >
          {isRunning ? armZone.toUpperCase() : 'OFF'}
        </span>

        <span
          style={{
            padding: '2px 5px',
            borderRadius: 4,
            background: swingFlashActive
              ? '#f59e0b'
              : 'rgba(255, 255, 255, 0.06)',
            color: swingFlashActive ? '#0f172a' : '#64748b',
            transition: 'background-color 120ms ease, color 120ms ease',
          }}
        >
          {swingFlashActive ? 'SWING!' : 'TRACK'}
        </span>
      </div>
    </div>
  );
};
