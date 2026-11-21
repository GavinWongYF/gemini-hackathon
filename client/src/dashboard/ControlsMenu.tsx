import React, { useEffect, useRef, useState } from 'react';

/** One clean "Controls" button for the header: webcam + racket sensor (M5 over Bluetooth or USB) + keyboard fallback.
 * Replaces the separate IMU / ZERO / CAM chips. All actions are the existing hardwareInput calls. */
export interface ControlsMenuProps {
  webcamStatus: 'idle' | 'loading' | 'running' | 'error';
  webcamActive: boolean;
  armZone: string;
  imuConnected: boolean;
  imuCalibrated: boolean;
  imuHz: number;
  onToggleWebcam: () => void;
  onConnectBle: () => void;
  onConnectSerial: () => void;
  onZero: () => void;
  /** Why the last Bluetooth / USB connect failed, shown in the panel. */
  hardwareError?: string | null;
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const GREEN = '#059669';
const AMBER = '#d97706';
const GREY = '#c8c7c0';
const dot = (c: string) => <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0 }} />;

export const ControlsMenu: React.FC<ControlsMenuProps> = (p) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const camOn = p.webcamStatus === 'running';
  const camColor = camOn ? GREEN : p.webcamStatus === 'loading' ? AMBER : GREY;
  const racketColor = p.imuConnected ? (p.imuCalibrated ? GREEN : AMBER) : GREY;
  const summary = p.imuConnected ? 'Racket + camera' : camOn ? 'Webcam' : 'Keyboard';
  const camLine = camOn
    ? p.webcamActive
      ? `Tracking your arm · ${p.armZone}`
      : 'On · step back so your arm shows'
    : p.webcamStatus === 'loading'
      ? 'Starting…'
      : p.webcamStatus === 'error'
        ? 'Camera blocked or busy'
        : 'Off';
  const racketLine = p.imuConnected
    ? p.imuCalibrated
      ? `Connected · ${p.imuHz} Hz`
      : `Connected · ${p.imuHz} Hz · zero it first`
    : 'Not connected';

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderTop: '1px solid #efeee9' };
  const btn = (primary = false): React.CSSProperties => ({
    height: 28,
    padding: '0 10px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    border: primary ? '1px solid #141413' : '1px solid #e5e4df',
    background: primary ? '#141413' : '#fafaf8',
    color: primary ? '#ffffff' : '#141413',
  });

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="lab-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          height: 26,
          padding: '0 10px',
          borderRadius: 6,
          background: '#fafaf8',
          border: '1px solid #e5e4df',
          fontSize: 12,
          fontWeight: 600,
          color: '#141413',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {dot(camColor)}
        {dot(racketColor)}
        <span>Controls</span>
        <span style={{ color: '#8c8b85', fontWeight: 500 }}>· {summary}</span>
        <span style={{ color: '#8c8b85', fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Controls"
          style={{
            position: 'absolute',
            right: 0,
            top: 32,
            width: 320,
            background: '#ffffff',
            border: '1px solid #e5e4df',
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(20,20,19,0.12)',
            zIndex: 80,
            overflow: 'hidden',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ padding: '10px 12px', fontSize: 11, letterSpacing: '0.06em', color: '#8c8b85', fontFamily: MONO }}>HOW YOU PLAY</div>

          <div style={row}>
            {dot(camColor)}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#141413' }}>Webcam</div>
              <div style={{ fontSize: 11.5, color: '#575652' }}>{camLine}</div>
            </div>
            <button type="button" style={btn(!camOn)} onClick={p.onToggleWebcam}>
              {camOn ? 'Turn off' : 'Turn on'}
            </button>
          </div>

          <div style={row}>
            {dot(racketColor)}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#141413' }}>Racket sensor (M5)</div>
              <div style={{ fontSize: 11.5, color: '#575652' }}>{racketLine}</div>
            </div>
            {p.imuConnected && (
              <button type="button" style={btn(!p.imuCalibrated)} onClick={p.onZero}>
                {p.imuCalibrated ? 'Re-zero' : 'Zero'}
              </button>
            )}
          </div>
          {!p.imuConnected ? (
            <div style={{ display: 'flex', gap: 8, padding: '0 12px 12px 29px' }}>
              <button type="button" style={btn(true)} onClick={p.onConnectBle}>
                Connect Bluetooth
              </button>
              <button type="button" style={btn()} onClick={p.onConnectSerial}>
                Connect USB
              </button>
            </div>
          ) : (
            <div style={{ padding: '0 12px 12px 29px' }}>
              <button type="button" style={{ ...btn(), height: 24, fontSize: 11 }} onClick={p.onConnectBle}>
                Switch device
              </button>
            </div>
          )}

          {p.hardwareError && !p.imuConnected && (
            <div style={{ margin: '0 12px 12px 29px', padding: '8px 10px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 11.5, lineHeight: 1.4 }}>
              {p.hardwareError}
            </div>
          )}
          <div style={{ ...row, background: '#fafaf8' }}>
            <div style={{ fontSize: 11.5, color: '#575652', lineHeight: 1.45 }}>
              Hold the racket across your body and press <b>Zero</b> (or BtnA). No hardware? <b>Space</b> swings, <b>A / D</b> move your reach.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
