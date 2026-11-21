import React, { useEffect, useRef, useState } from 'react';
import { hardwareInput } from '../hardware/HardwareInputManager';

/** The player's own webcam in a corner of the court (Sportacle: you always see yourself), mirrored like a selfie,
 * with the live read under it: forehand or backhand side, and whether the camera sees the arm. Shares the tracker's
 * stream; never starts or stops the camera itself. */
export const CameraTile: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);
  const [read, setRead] = useState<{ wing: string; active: boolean; zone: string }>({ wing: 'forehand', active: false, zone: 'center' });

  useEffect(() => {
    const id = window.setInterval(() => {
      const src = hardwareInput.webcam.getVideoElement();
      const v = videoRef.current;
      const stream = (src?.srcObject as MediaStream | null) ?? null;
      if (v && stream && v.srcObject !== stream) {
        v.srcObject = stream;
        void v.play().catch(() => {});
      }
      setLive(!!stream && stream.getVideoTracks().some((t) => t.readyState === 'live'));
      const arm = hardwareInput.getState().arm;
      setRead({ wing: arm.wing, active: arm.active, zone: arm.armZone });
    }, 120);
    return () => window.clearInterval(id);
  }, []);

  if (!live) return null;
  const wingColor = read.wing === 'backhand' ? '#7c3aed' : '#0284c7';
  return (
    <div
      style={{
        position: 'absolute',
        left: 20,
        bottom: 18,
        width: 196,
        borderRadius: 10,
        overflow: 'hidden',
        background: '#0b1120',
        border: '1px solid rgba(255,255,255,0.18)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
        zIndex: 20,
        pointerEvents: 'none',
      }}
    >
      <video ref={videoRef} muted playsInline autoPlay style={{ display: 'block', width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', transform: 'scaleX(-1)' }} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          padding: '6px 9px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 11.5,
          fontWeight: 700,
          color: '#f8fafc',
          background: 'rgba(11,17,32,0.92)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: read.active ? '#22c55e' : '#f59e0b' }} />
          {read.active ? 'YOU' : 'Step back · show your arm'}
        </span>
        {read.active && (
          <span style={{ padding: '1px 7px', borderRadius: 4, background: wingColor, letterSpacing: '0.04em' }}>
            {read.wing === 'backhand' ? 'BACKHAND' : 'FOREHAND'}
          </span>
        )}
      </div>
    </div>
  );
};
