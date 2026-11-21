import React, { useEffect, useRef, useState } from 'react';
import type { PlayerControlState, PlayerSwingEvent } from '@shared/contracts';
import { DEFAULT_IMU_CONFIG, type ImuClassifierConfig } from './ImuSwingClassifier';
import { hardwareInput } from './HardwareInputManager';
import type { WebcamTrackerSnapshot } from './WebcamArmTracker';

const SHOT_COLORS: Record<string, string> = {
  topspin: '#38bdf8',
  slice: '#f59e0b',
  dropshot: '#34d399',
};

export const HardwareTestView: React.FC = () => {
  const [ctrl, setCtrl] = useState<PlayerControlState>(() => hardwareInput.getState());
  const [camStatus, setCamStatus] = useState<WebcamTrackerSnapshot['status']>('idle');
  const [camError, setCamError] = useState<string | null>(null);
  const [camFps, setCamFps] = useState(0);
  const [bleError, setBleError] = useState<string | null>(null);
  const [swings, setSwings] = useState<PlayerSwingEvent[]>([]);
  const [config, setConfig] = useState<ImuClassifierConfig>(() => ({ ...DEFAULT_IMU_CONFIG }));

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    hardwareInput.start();

    const unsubCam = hardwareInput.webcam.subscribe((snap) => {
      setCamStatus(snap.status);
      setCamError(snap.error);
    });
    const unsubSwing = hardwareInput.onSwing((evt) => {
      setSwings((prev) => [evt, ...prev].slice(0, 12));
    });

    // Draw webcam skeleton on canvas at 60 FPS (zero React re-renders!)
    // and refresh DOM gauges calmly at 15 Hz so buttons & sliders never stutter.
    let rafId = 0;
    let lastUiSyncMs = 0;

    const tick = (nowMs: number) => {
      rafId = requestAnimationFrame(tick);

      const canvas = overlayRef.current;
      const snap = hardwareInput.webcam.getSnapshot();
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const lm = snap.landmarks;
          if (lm && lm.length >= 17) {
            const w = canvas.width;
            const h = canvas.height;
            const px = (idx: number) => (1 - lm[idx].x) * w;
            const py = (idx: number) => lm[idx].y * h;

            ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(w * 0.36, 0);
            ctx.lineTo(w * 0.36, h);
            ctx.moveTo(w * 0.64, 0);
            ctx.lineTo(w * 0.64, h);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(px(11), py(11));
            ctx.lineTo(px(12), py(12));
            ctx.stroke();

            const isRight = snap.arm.handedness === 'right';
            const sh = isRight ? 12 : 11;
            const el = isRight ? 14 : 13;
            const wr = isRight ? 16 : 15;

            ctx.strokeStyle = snap.arm.wing === 'forehand' ? '#38bdf8' : '#f472b6';
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(px(sh), py(sh));
            ctx.lineTo(px(el), py(el));
            ctx.lineTo(px(wr), py(wr));
            ctx.stroke();

            ctx.fillStyle = '#22c55e';
            ctx.beginPath();
            ctx.arc(px(wr), py(wr), 9, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      if (nowMs - lastUiSyncMs >= 66) {
        lastUiSyncMs = nowMs;
        const s = hardwareInput.getState();
        setCtrl({
          ...s,
          arm: { ...s.arm },
          gyro: { ...s.gyro },
          rawImu: s.rawImu ? { ...s.rawImu } : null,
        });
        setCamFps(snap.fps);
      }
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      unsubCam();
      unsubSwing();
    };
  }, []);

  const handleConnectBle = async () => {
    setBleError(null);
    const res = await hardwareInput.connectBle();
    if (!res.ok && res.error) setBleError(res.error);
  };

  const handleConnectSerial = async () => {
    setBleError(null);
    await hardwareInput.connectSerial(115200);
  };

  const handleStartWebcam = async () => {
    if (videoRef.current) {
      await hardwareInput.webcam.start(videoRef.current);
    }
  };

  const updateCfg = <K extends keyof ImuClassifierConfig>(key: K, val: ImuClassifierConfig[K]) => {
    setConfig((prev) => {
      const next = { ...prev, [key]: val };
      hardwareInput.updateClassifierConfig({ [key]: val });
      return next;
    });
  };

  const latestSwing = swings[0] ?? null;

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Adaptive AI Tennis — Hardware Lab</h1>
          <div style={styles.subtitle}>
            Universal Zero-Training Classifier • Wireless M5Stack IMU + Webcam Arm Tracking
          </div>
        </div>
        <div style={styles.headerActions}>
          <button style={styles.bleBtn} onClick={handleConnectBle}>
            {ctrl.imuConnected && (ctrl.source === 'm5_ble' || ctrl.source === 'm5_ws')
              ? `Wireless BLE Live (${ctrl.imuHz} Hz)`
              : 'Connect M5 Wireless'}
          </button>
          <button style={styles.secondaryBtn} onClick={handleConnectSerial}>
            {ctrl.imuConnected && ctrl.source === 'm5_serial'
              ? `USB Serial (${ctrl.imuHz} Hz)`
              : 'USB Serial'}
          </button>
          <button
            style={styles.secondaryBtn}
            onClick={
              camStatus === 'running' ? () => hardwareInput.webcam.stop() : handleStartWebcam
            }
          >
            {camStatus === 'running'
              ? `Stop Webcam (${camFps} fps)`
              : camStatus === 'loading'
                ? 'Loading Pose...'
                : 'Enable Webcam'}
          </button>
          <button style={styles.zeroBtn} onClick={() => hardwareInput.zeroRacket()}>
            {ctrl.calibration === 'zeroing'
              ? `Zeroing ${Math.round(ctrl.calibrationProgress * 100)}%`
              : ctrl.calibration === 'ready'
                ? 'Re-Zero Racket (BtnA / R)'
                : 'ZERO RACKET (BtnA / R)'}
          </button>
        </div>
      </header>

      {bleError && <div style={styles.errorBanner}>{bleError}</div>}

      {/* Fixed-height status banner so layout never jumps */}
      <div
        style={
          ctrl.calibration === 'ready' && ctrl.imuConnected
            ? styles.readyBanner
            : styles.zeroBanner
        }
      >
        {!ctrl.imuConnected ? (
          <span>
            <strong>Waiting for M5 Wireless IMU…</strong> Make sure the M5 is powered on (green{' '}
            <code>BLE LIVE!</code> on its screen) or press <strong>Space</strong> for keyboard test.
          </span>
        ) : ctrl.calibration === 'ready' ? (
          <span>
            <strong>RACKET ZEROED &amp; READY</strong> — Swing deliberately for{' '}
            <strong>Topspin</strong> (low→high), <strong>Slice</strong> (high→low chop), or{' '}
            <strong>Dropshot</strong> (short soft tap). Press <strong>BtnA</strong> or{' '}
            <strong>R</strong> to re-zero for a new player.
          </span>
        ) : (
          <div style={styles.zeroBannerInner}>
            <span>
              <strong>
                {ctrl.calibration === 'zeroing'
                  ? 'Hold Steady — Zeroing Pose…'
                  : 'Step 1: Zero Your Racket'}
              </strong>{' '}
              — Hold M5 horizontally across your body like a tennis racket, then press{' '}
              <strong>BtnA</strong> or click <strong>ZERO NOW</strong>.
            </span>
            <button style={styles.zeroBannerBtn} onClick={() => hardwareInput.zeroRacket()}>
              {ctrl.calibration === 'zeroing'
                ? `${Math.round(ctrl.calibrationProgress * 100)}%`
                : 'ZERO NOW'}
            </button>
          </div>
        )}
      </div>

      <div style={styles.grid}>
        {/* Left Column: Webcam Arm Position */}
        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>1. Webcam Arm Tracker</span>
            <div style={styles.pillRow}>
              <button
                style={ctrl.arm.handedness === 'right' ? styles.toggleActive : styles.toggleIdle}
                onClick={() => hardwareInput.setHandedness('right')}
              >
                Right-Handed
              </button>
              <button
                style={ctrl.arm.handedness === 'left' ? styles.toggleActive : styles.toggleIdle}
                onClick={() => hardwareInput.setHandedness('left')}
              >
                Left-Handed
              </button>
            </div>
          </div>

          <div style={styles.videoBox}>
            <video
              ref={videoRef}
              playsInline
              muted
              style={{
                ...styles.video,
                transform: 'scaleX(-1)',
                opacity: camStatus === 'running' ? 1 : 0.2,
              }}
            />
            <canvas ref={overlayRef} width={640} height={480} style={styles.overlayCanvas} />
            {camStatus !== 'running' && (
              <div style={styles.videoPlaceholder}>
                {camError
                  ? `Webcam error: ${camError}`
                  : 'Click "Enable Webcam" — or use A / D keys as fallback'}
              </div>
            )}
          </div>

          <div style={styles.zoneStrip}>
            {(['left', 'center', 'right'] as const).map((z) => {
              const active = ctrl.arm.armZone === z;
              const wingLabel =
                z === 'center'
                  ? 'READY'
                  : (ctrl.arm.handedness === 'right' ? z === 'right' : z === 'left')
                    ? 'FOREHAND'
                    : 'BACKHAND';
              return (
                <div
                  key={z}
                  style={{
                    ...styles.zoneCell,
                    borderColor: active ? '#38bdf8' : '#1e293b',
                    background: active ? 'rgba(56, 189, 248, 0.16)' : '#0f172a',
                  }}
                >
                  <div style={styles.zoneName}>{z.toUpperCase()}</div>
                  <div style={styles.zoneSub}>{wingLabel}</div>
                </div>
              );
            })}
          </div>

          <div style={styles.metaLine}>
            <span>armX: {ctrl.arm.armX.toFixed(2)}</span>
            <span>wing: {ctrl.arm.wing.toUpperCase()}</span>
            <span>{ctrl.arm.active ? `WEBCAM (${camFps} fps)` : 'KEYBOARD (A/D)'}</span>
          </div>
        </section>

        {/* Right Column: M5 IMU & Universal Shot Classifier */}
        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>2. M5Stack IMU &amp; Universal Shot Classifier</span>
            <span
              style={{
                ...styles.badge,
                background: ctrl.imuConnected ? '#065f46' : '#334155',
                color: ctrl.imuConnected ? '#a7f3d0' : '#cbd5e1',
              }}
            >
              {ctrl.imuConnected
                ? `${ctrl.source.toUpperCase()} • ${ctrl.imuHz} Hz`
                : 'DISCONNECTED'}
            </span>
          </div>

          <div style={styles.metricsGrid}>
            <MeterBar
              label="LIVE SWING ENERGY (0..1)"
              value={ctrl.gyro.power}
              min={0}
              max={1}
              color="#22c55e"
            />
            <MeterBar
              label="AIM ANGLE (-1 left .. +1 right)"
              value={ctrl.gyro.angle}
              min={-1}
              max={1}
              color="#38bdf8"
              bipolar
            />
            <MeterBar
              label="SPIN BIAS (-1 slice .. +1 topspin)"
              value={ctrl.gyro.rotation}
              min={-1}
              max={1}
              color="#f59e0b"
              bipolar
            />
          </div>

          <div style={styles.rawGrid}>
            <div>Dyn Accel: {ctrl.gyro.linearAccelG.toFixed(2)} g</div>
            <div>Gyro Rate: {ctrl.gyro.gyroRateDps.toFixed(0)} °/s</div>
            <div>Yaw: {(ctrl.gyro.rawYawDeg ?? 0).toFixed(0)}°</div>
            <div>Face Tilt: {(ctrl.gyro.rawRollDeg ?? 0).toFixed(0)}°</div>
          </div>

          <div style={styles.swingHero}>
            {latestSwing ? (
              <>
                <div style={styles.swingHeroTop}>
                  <span
                    style={{
                      ...styles.shotPill,
                      background: SHOT_COLORS[latestSwing.shotType] ?? '#38bdf8',
                    }}
                  >
                    {latestSwing.shotType.toUpperCase()}
                  </span>
                  <span style={styles.wingPill}>{latestSwing.wing.toUpperCase()}</span>
                  <span style={styles.swingTime}>
                    #{latestSwing.id} • {((latestSwing.confidence ?? 0) * 100).toFixed(0)}% conf
                  </span>
                </div>
                <div style={styles.swingStats}>
                  <span>PWR {(latestSwing.power * 100).toFixed(0)}%</span>
                  <span>
                    ANG {latestSwing.angle >= 0 ? '+' : ''}
                    {latestSwing.angle.toFixed(2)}
                  </span>
                  <span>
                    ROT {latestSwing.rotation >= 0 ? '+' : ''}
                    {latestSwing.rotation.toFixed(2)}
                  </span>
                  <span>
                    {latestSwing.peakAccelG.toFixed(2)}g / {latestSwing.peakGyroDps.toFixed(0)}°/s
                  </span>
                </div>
              </>
            ) : (
              <div style={styles.emptySwing}>
                Zero racket, then swing deliberately — casual hand movement is ignored.
              </div>
            )}
          </div>

          <div style={styles.slidersBox}>
            <div style={styles.slidersHeader}>
              <span style={styles.slidersTitle}>Sensitivity &amp; Cutoffs</span>
              {swings.length > 0 && (
                <button style={styles.clearBtn} onClick={() => setSwings([])}>
                  Clear Log
                </button>
              )}
            </div>
            <SliderRow
              label={`Min Swing G (${config.dropAccelG.toFixed(2)}g — higher = fewer accidental hits)`}
              min={0.3}
              max={1.4}
              step={0.05}
              value={config.dropAccelG}
              onChange={(v) => updateCfg('dropAccelG', v)}
            />
            <SliderRow
              label={`Min Swing Gyro (${config.dropGyroDps.toFixed(0)}°/s)`}
              min={45}
              max={200}
              step={5}
              value={config.dropGyroDps}
              onChange={(v) => updateCfg('dropGyroDps', v)}
            />
            <SliderRow
              label={`Dropshot Max Power (${config.dropshotPowerMax.toFixed(2)})`}
              min={0.22}
              max={0.62}
              step={0.02}
              value={config.dropshotPowerMax}
              onChange={(v) => updateCfg('dropshotPowerMax', v)}
            />
            <SliderRow
              label={`Slice Cutoff (${config.sliceThreshold.toFixed(2)})`}
              min={-0.5}
              max={0.25}
              step={0.02}
              value={config.sliceThreshold}
              onChange={(v) => updateCfg('sliceThreshold', v)}
            />
            <div style={styles.checkboxRow}>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={config.invertAngle}
                  onChange={(e) => updateCfg('invertAngle', e.target.checked)}
                />
                Invert Aim Angle
              </label>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={config.invertRotation}
                  onChange={(e) => updateCfg('invertRotation', e.target.checked)}
                />
                Invert Topspin / Slice
              </label>
            </div>
          </div>

          <div style={styles.logBox}>
            {swings.map((s) => (
              <div key={s.id} style={styles.logRow}>
                <span style={{ color: SHOT_COLORS[s.shotType], fontWeight: 700 }}>
                  {s.shotType.toUpperCase()}
                </span>
                <span>{s.wing}</span>
                <span>pwr:{s.power.toFixed(2)}</span>
                <span>ang:{s.angle.toFixed(2)}</span>
                <span>rot:{s.rotation.toFixed(2)}</span>
                <span>{s.peakAccelG.toFixed(1)}g</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

const MeterBar: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  color: string;
  bipolar?: boolean;
}> = ({ label, value, min, max, color, bipolar }) => {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8' }}>
        <span>{label}</span>
        <span style={{ fontFamily: 'monospace', color: '#f8fafc' }}>{value.toFixed(2)}</span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 10,
          borderRadius: 999,
          background: '#1e293b',
          overflow: 'hidden',
        }}
      >
        {bipolar ? (
          <>
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: 0,
                width: 1,
                background: '#475569',
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${Math.min(50, pct)}%`,
                width: `${Math.abs(pct - 50)}%`,
                background: color,
              }}
            />
          </>
        ) : (
          <div style={{ width: `${pct}%`, height: '100%', background: color }} />
        )}
      </div>
    </div>
  );
};

const SliderRow: React.FC<{
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}> = ({ label, min, max, step, value, onChange }) => (
  <label
    style={{
      display: 'grid',
      gridTemplateColumns: '1fr 120px',
      alignItems: 'center',
      gap: 10,
      fontSize: 12,
      color: '#cbd5e1',
    }}
  >
    <span>{label}</span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  </label>
);

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    padding: '16px 22px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    background: '#090d16',
    color: '#f1f5f9',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 12,
  },
  title: { margin: 0, fontSize: 21, fontWeight: 800 },
  subtitle: { fontSize: 12, color: '#94a3b8', marginTop: 3 },
  headerActions: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  bleBtn: {
    padding: '9px 14px',
    borderRadius: 10,
    border: 'none',
    background: 'linear-gradient(135deg, #0ea5e9, #22c55e)',
    color: '#031525',
    fontWeight: 900,
    cursor: 'pointer',
  },
  secondaryBtn: {
    padding: '9px 12px',
    borderRadius: 10,
    border: '1px solid #334155',
    background: '#1e293b',
    color: '#f8fafc',
    fontWeight: 700,
    cursor: 'pointer',
  },
  zeroBtn: {
    padding: '9px 14px',
    borderRadius: 10,
    border: '2px solid #f59e0b',
    background: '#78350f',
    color: '#fef3c7',
    fontWeight: 900,
    cursor: 'pointer',
  },
  errorBanner: {
    background: '#450a0a',
    border: '1px solid #dc2626',
    color: '#fecaca',
    padding: '8px 12px',
    borderRadius: 10,
    marginBottom: 12,
    fontSize: 13,
  },
  zeroBanner: {
    minHeight: 46,
    display: 'flex',
    alignItems: 'center',
    background: 'rgba(245, 158, 11, 0.16)',
    border: '1px solid #f59e0b',
    color: '#fef3c7',
    borderRadius: 12,
    padding: '10px 14px',
    marginBottom: 14,
    fontSize: 13,
  },
  zeroBannerInner: {
    width: '100%',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  zeroBannerBtn: {
    padding: '8px 18px',
    borderRadius: 10,
    border: 'none',
    background: '#f59e0b',
    color: '#1c1917',
    fontSize: 13,
    fontWeight: 900,
    cursor: 'pointer',
  },
  readyBanner: {
    minHeight: 46,
    display: 'flex',
    alignItems: 'center',
    background: 'rgba(16, 185, 129, 0.14)',
    border: '1px solid #10b981',
    color: '#a7f3d0',
    borderRadius: 12,
    padding: '10px 14px',
    marginBottom: 14,
    fontSize: 13,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
    gap: 16,
  },
  card: {
    background: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: 16,
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: 800 },
  pillRow: { display: 'flex', gap: 6 },
  toggleActive: {
    padding: '4px 10px',
    borderRadius: 999,
    border: '1px solid #38bdf8',
    background: '#0c4a6e',
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
  },
  toggleIdle: {
    padding: '4px 10px',
    borderRadius: 999,
    border: '1px solid #334155',
    background: '#1e293b',
    color: '#94a3b8',
    fontSize: 12,
    cursor: 'pointer',
  },
  videoBox: {
    position: 'relative',
    width: '100%',
    aspectRatio: '4 / 3',
    background: '#020617',
    borderRadius: 12,
    overflow: 'hidden',
    border: '1px solid #1e293b',
  },
  video: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  overlayCanvas: { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' },
  videoPlaceholder: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    textAlign: 'center',
    color: '#94a3b8',
    fontSize: 13,
  },
  zoneStrip: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 },
  zoneCell: {
    padding: '10px 8px',
    borderRadius: 10,
    border: '2px solid #1e293b',
    textAlign: 'center',
  },
  zoneName: { fontWeight: 800, fontSize: 14 },
  zoneSub: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  metaLine: {
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#94a3b8',
  },
  badge: { padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 800 },
  metricsGrid: { display: 'flex', flexDirection: 'column', gap: 10 },
  rawGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 6,
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#94a3b8',
    background: '#090d16',
    padding: 10,
    borderRadius: 10,
  },
  swingHero: {
    minHeight: 68,
    background: '#111827',
    border: '1px solid #334155',
    borderRadius: 12,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
  },
  swingHeroTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  shotPill: {
    padding: '4px 10px',
    borderRadius: 999,
    color: '#031525',
    fontWeight: 900,
    fontSize: 13,
  },
  wingPill: {
    padding: '4px 10px',
    borderRadius: 999,
    background: '#1e293b',
    color: '#f8fafc',
    fontWeight: 700,
    fontSize: 12,
  },
  swingTime: { marginLeft: 'auto', fontFamily: 'monospace', fontSize: 12, color: '#64748b' },
  swingStats: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  emptySwing: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  slidersBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    background: '#090d16',
    padding: 10,
    borderRadius: 10,
  },
  slidersHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  slidersTitle: { fontSize: 12, fontWeight: 700, color: '#94a3b8' },
  clearBtn: {
    padding: '2px 8px',
    borderRadius: 6,
    border: '1px solid #475569',
    background: 'transparent',
    color: '#94a3b8',
    fontSize: 11,
    cursor: 'pointer',
  },
  checkboxRow: { display: 'flex', gap: 16, marginTop: 4 },
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#cbd5e1' },
  logBox: {
    height: 130,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#94a3b8',
  },
  logRow: {
    display: 'grid',
    gridTemplateColumns: '76px 76px 68px 68px 68px 50px',
    gap: 4,
    padding: '4px 6px',
    background: '#090d16',
    borderRadius: 6,
  },
};
