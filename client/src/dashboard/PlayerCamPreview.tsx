// Live Player Webcam + MediaPipe Pose Skeleton Preview for `/match` (Left Rail).
// Reads directly from `hardwareInput.webcam` at ~30 FPS onto a single canvas —
// zero React re-renders per frame, zero interference with the 3D court viewport.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { StrokeWing } from '@shared/contracts';
import { hardwareInput } from '../hardware/HardwareInputManager';
import type { WebcamTrackerSnapshot } from '../hardware/WebcamArmTracker';

const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export const PlayerCamPreview: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState<WebcamTrackerSnapshot['status']>(
    () => hardwareInput.webcam.getSnapshot().status,
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(
    () => hardwareInput.webcam.getSnapshot().error,
  );
  const [fps, setFps] = useState<number>(0);
  const [wing, setWing] = useState<StrokeWing>('forehand');
  const [poseActive, setPoseActive] = useState<boolean>(false);
  const [handedness, setHandedness] = useState<'right' | 'left'>(
    () => hardwareInput.getState().arm.handedness,
  );

  useEffect(() => {
    const unsub = hardwareInput.webcam.subscribe((snap) => {
      setStatus(snap.status);
      setErrorMsg(snap.error);
      setHandedness(snap.arm.handedness);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (collapsed) return;

    let rafId = 0;
    let lastDrawMs = 0;
    let lastHudMs = 0;

    const tick = (nowMs: number) => {
      rafId = requestAnimationFrame(tick);
      if (nowMs - lastDrawMs < 32) return; // ~30 FPS preview draw
      lastDrawMs = nowMs;

      const snap = hardwareInput.webcam.getSnapshot();
      const video = hardwareInput.webcam.getVideoElement();
      const canvas = canvasRef.current;

      if (canvas && video && snap.status === 'running' && video.readyState >= 2 && video.videoWidth > 0) {
        const targetW = 320;
        const targetH = Math.max(180, Math.round(targetW * (video.videoHeight / video.videoWidth)));
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;

          // Draw mirrored player camera feed
          ctx.save();
          ctx.translate(w, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(video, 0, 0, w, h);
          ctx.restore();

          // Subtle zone hairlines (Left / Center / Right)
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(w * 0.36, 0);
          ctx.lineTo(w * 0.36, h);
          ctx.moveTo(w * 0.64, 0);
          ctx.lineTo(w * 0.64, h);
          ctx.stroke();
          ctx.setLineDash([]);

          // MediaPipe Pose shoulder + dominant racket arm overlay
          const lm = snap.landmarks;
          if (lm && lm.length >= 17) {
            const px = (idx: number) => (1 - lm[idx].x) * w;
            const py = (idx: number) => lm[idx].y * h;

            // Clavicle / shoulder reference bar
            ctx.strokeStyle = 'rgba(226, 232, 240, 0.78)';
            ctx.lineWidth = 2.2;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(px(11), py(11));
            ctx.lineTo(px(12), py(12));
            ctx.stroke();

            const isRight = snap.arm.handedness === 'right';
            const sh = isRight ? 12 : 11;
            const el = isRight ? 14 : 13;
            const wr = isRight ? 16 : 15;

            ctx.strokeStyle = snap.arm.wing === 'forehand' ? '#38bdf8' : '#fb923c';
            ctx.lineWidth = 3.8;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(px(sh), py(sh));
            ctx.lineTo(px(el), py(el));
            ctx.lineTo(px(wr), py(wr));
            ctx.stroke();

            // Dominant wrist tracking marker
            ctx.fillStyle = '#22c55e';
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(px(wr), py(wr), 5.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
      }

      if (nowMs - lastHudMs >= 220) {
        lastHudMs = nowMs;
        setFps(snap.fps);
        setWing(snap.arm.wing);
        setPoseActive(snap.arm.active);
        setHandedness(snap.arm.handedness);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [collapsed]);

  const handleToggleHandedness = useCallback(() => {
    const next = handedness === 'right' ? 'left' : 'right';
    hardwareInput.setHandedness(next);
    setHandedness(next);
  }, [handedness]);

  const handleStartCam = useCallback(() => {
    void hardwareInput.webcam.start();
  }, []);

  const dotColor =
    status === 'running' ? '#059669' : status === 'loading' ? '#d97706' : '#c8c7c0';

  return (
    <section
      style={{
        borderBottom: '1px solid #e5e4df',
        background: '#ffffff',
      }}
    >
      {/* Card Header */}
      <div
        style={{
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          background: '#fafaf8',
          borderBottom: collapsed ? 'none' : '1px solid #e5e4df',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: dotColor,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '0.04em',
              color: '#141413',
              whiteSpace: 'nowrap',
            }}
          >
            PLAYER CAM
          </span>
          {status === 'running' && fps > 0 && (
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: '#8c8b85',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {fps}FPS
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="lab-btn"
            onClick={handleToggleHandedness}
            title="Switch dominant racket hand (Right-handed / Left-handed)"
            style={{
              height: 20,
              padding: '0 6px',
              borderRadius: 4,
              background: '#ffffff',
              border: '1px solid #e5e4df',
              fontFamily: MONO,
              fontSize: 9.5,
              fontWeight: 600,
              color: '#575652',
              cursor: 'pointer',
            }}
          >
            {handedness === 'right' ? 'RH' : 'LH'}
          </button>
          <button
            type="button"
            className="lab-btn"
            onClick={() => setCollapsed((prev) => !prev)}
            title={collapsed ? 'Expand live webcam preview' : 'Collapse live webcam preview'}
            style={{
              height: 20,
              padding: '0 6px',
              borderRadius: 4,
              background: '#ffffff',
              border: '1px solid #e5e4df',
              fontFamily: MONO,
              fontSize: 9.5,
              fontWeight: 500,
              color: '#575652',
              cursor: 'pointer',
            }}
          >
            {collapsed ? 'SHOW' : 'HIDE'}
          </button>
        </div>
      </div>

      {/* Mirrored Video + Pose Viewport */}
      {!collapsed && (
        <div style={{ padding: '8px 10px 10px' }}>
          <div
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '4 / 3',
              borderRadius: 6,
              overflow: 'hidden',
              background: '#141413',
              border: '1px solid #e5e4df',
            }}
          >
            <canvas
              ref={canvasRef}
              width={320}
              height={240}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: status === 'running' ? 'block' : 'none',
              }}
            />

            {status === 'running' ? (
              <div
                style={{
                  position: 'absolute',
                  left: 6,
                  right: 6,
                  bottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  pointerEvents: 'none',
                }}
              >
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 9.5,
                    fontWeight: 600,
                    letterSpacing: '0.03em',
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: 'rgba(20, 20, 19, 0.76)',
                    color: !poseActive
                      ? '#d4d4d8'
                      : wing === 'forehand'
                        ? '#38bdf8'
                        : '#fb923c',
                    backdropFilter: 'blur(4px)',
                  }}
                >
                  {poseActive ? (wing === 'forehand' ? 'FOREHAND' : 'BACKHAND') : 'NO POSE'}
                </span>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 9,
                    fontWeight: 500,
                    letterSpacing: '0.03em',
                    padding: '2px 5px',
                    borderRadius: 4,
                    background: 'rgba(20, 20, 19, 0.72)',
                    color: 'rgba(255, 255, 255, 0.82)',
                  }}
                >
                  GEMINI 1HZ
                </span>
              </div>
            ) : (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: 12,
                  textAlign: 'center',
                }}
              >
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 10.5,
                    color: status === 'error' ? '#fca5a5' : '#a1a1aa',
                  }}
                >
                  {status === 'loading'
                    ? 'INITIALIZING MEDIAPIPE POSE…'
                    : status === 'error'
                      ? errorMsg || 'CAMERA PERMISSION BLOCKED'
                      : 'CAMERA OFF'}
                </span>
                {status !== 'loading' && (
                  <button
                    type="button"
                    className="lab-btn"
                    onClick={handleStartCam}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 5,
                      background: '#ffffff',
                      color: '#141413',
                      border: '1px solid #e5e4df',
                      fontFamily: MONO,
                      fontSize: 10,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    ENABLE CAM
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
