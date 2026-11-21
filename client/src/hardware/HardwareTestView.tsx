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
  const [trainingTarget, setTrainingTarget] = useState<'topspin' | 'slice' | 'dropshot' | null>(null);
  const [trainingState, setTrainingState] = useState(() => hardwareInput.classifier.getTrainingState());

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
      setTrainingTarget(hardwareInput.getTrainingTarget());
      setTrainingState(hardwareInput.classifier.getTrainingState());
    });

    // Single smooth rAF loop: draws skeleton at 60 FPS with zero React lag,
    // and updates DOM telemetry cleanly at ~30 Hz (never flooded by 100 Hz IMU packets!)
    let rafId = 0;
    let lastUiSyncMs = 0;

    const tick = (nowMs: number) => {
      rafId = requestAnimationFrame(tick);

      // 1. Draw webcam arm overlay directly on canvas (no React re-render!)
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

      // 2. Sync DOM telemetry meters cleanly at ~30 Hz
      if (nowMs - lastUiSyncMs >= 33) {
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
    if (!res.ok && res.error) {
      setBleError(res.error);
    }
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
          <h1 style={styles.title}>Adaptive AI Tennis — Real-Time Hardware Lab</h1>
          <div style={styles.subtitle}>
            Wireless BLE M5Stack IMU (100 Hz, &lt;10 ms) + Webcam Arm Side • Zero-Lag Sensor Fusion
          </div>
        </div>
        <div style={styles.headerActions}>
          <button style={styles.bleBtn} onClick={handleConnectBle}>
            {ctrl.imuConnected && (ctrl.source === 'm5_ble' || ctrl.source === 'm5_ws')
              ? `Wireless BLE Live (${ctrl.imuHz} Hz)`
              : 'Connect M5 Wireless (Bluetooth)'}
          </button>
          <button style={styles.secondaryBtn} onClick={handleConnectSerial}>
            {ctrl.imuConnected && ctrl.source === 'm5_serial'
              ? `USB Serial (${ctrl.imuHz} Hz)`
              : 'USB Serial Backup'}
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
                : 'Enable Webcam Arm Tracker'}
          </button>
          <button style={styles.zeroBtn} onClick={() => hardwareInput.zeroRacket()}>
            {ctrl.calibration === 'zeroing'
              ? `Zeroing... ${Math.round(ctrl.calibrationProgress * 100)}%`
              : ctrl.calibration === 'ready'
                ? 'Re-Zero Racket (BtnA / R)'
                : 'ZERO RACKET (BtnA / R)'}
          </button>
        </div>
      </header>

      {bleError && <div style={styles.errorBanner}>{bleError}</div>}

      {/* Prominent Racket Zeroing Banner — player holds M5 across body like a racket & presses ZERO */}
      {ctrl.imuConnected && ctrl.calibration !== 'ready' && (
        <div style={styles.zeroBanner}>
          <div style={styles.zeroBannerText}>
            <strong>
              {ctrl.calibration === 'zeroing'
                ? 'Hold Steady — Zeroing Racket Pose...'
                : 'Step 1: Zero Your Racket Before Playing'}
            </strong>
            <span>
              Hold the M5 in front of you like a tennis racket with the screen facing horizontally
              across your body, then press <strong>BtnA</strong> on the M5 (or click{' '}
              <strong>ZERO RACKET</strong> / press <strong>R</strong>). Swings stay locked until
              zeroed.
            </span>
          </div>
          <button style={styles.zeroBannerBtn} onClick={() => hardwareInput.zeroRacket()}>
            {ctrl.calibration === 'zeroing'
              ? `Calibrating ${Math.round(ctrl.calibrationProgress * 100)}%`
              : 'ZERO NOW'}
          </button>
        </div>
      )}

      {ctrl.imuConnected && ctrl.calibration === 'ready' && (
        <div style={styles.readyBanner}>
          <span>
            <strong>RACKET ZEROED &amp; LIVE</strong> — Swing naturally to register Topspin, Slice,
            or Dropshot (press <strong>BtnA</strong> or <strong>R</strong> anytime to re-zero for a
            new player).
          </span>
        </div>
      )}

      <div style={styles.grid}>
        {/* Left Column: Webcam Arm Position */}
        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>1. Webcam Arm Tracker (256×192 Fast Pose)</span>
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
                  : 'Click "Enable Webcam Arm Tracker" — or use A / D keys as fallback'}
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
            <span>source: {ctrl.arm.active ? `WEBCAM (${camFps} fps)` : 'KEYBOARD (A/D)'}</span>
          </div>
        </section>

        {/* Right Column: M5 IMU Telemetry & Swing Classifier */}
        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>2. M5Stack Wireless IMU & Auto Shot Classifier</span>
            <span
              style={{
                ...styles.badge,
                background: ctrl.imuConnected ? '#065f46' : '#334155',
                color: ctrl.imuConnected ? '#a7f3d0' : '#cbd5e1',
              }}
            >
              {ctrl.imuConnected
                ? `${ctrl.source.toUpperCase()} • ${ctrl.imuHz} Hz`
                : 'NOT CONNECTED (SPACE = TEST)'}
            </span>
          </div>

          {ctrl.deviceInfo && <div style={styles.deviceTag}>{ctrl.deviceInfo}</div>}

          <div style={styles.metricsGrid}>
            <MeterBar label="LIVE SWING ENERGY (0..1)" value={ctrl.gyro.power} min={0} max={1} color="#22c55e" />
            <MeterBar
              label="AIM ANGLE (-1 left .. +1 right)"
              value={ctrl.gyro.angle}
              min={-1}
              max={1}
              color="#38bdf8"
              bipolar
            />
            <MeterBar
              label="RACKET FACE SPIN (-1 open/slice .. +1 closed/topspin)"
              value={ctrl.gyro.rotation}
              min={-1}
              max={1}
              color="#f59e0b"
              bipolar
            />
          </div>

          <div style={styles.shotGuide}>
            <span style={{ color: '#38bdf8' }}>● TOPSPIN: Fast, screen vertical/tilted down (low→high)</span>
            <span style={{ color: '#f59e0b' }}>● SLICE: Tilt screen UP toward ceiling + chop (high→low)</span>
            <span style={{ color: '#34d399' }}>● DROPSHOT: Soft, gentle tap</span>
          </div>

          <div style={styles.rawGrid}>
            <div>Lin Accel: {ctrl.gyro.linearAccelG.toFixed(2)} g</div>
            <div>Gyro Rate: {ctrl.gyro.gyroRateDps.toFixed(0)} deg/s</div>
            <div>
              Raw A: {ctrl.rawImu ? `${ctrl.rawImu.ax.toFixed(2)}, ${ctrl.rawImu.ay.toFixed(2)}, ${ctrl.rawImu.az.toFixed(2)}` : '—'}
            </div>
            <div>
              Yaw / Roll: {(ctrl.gyro.rawYawDeg ?? 0).toFixed(0)}° / {(ctrl.gyro.rawRollDeg ?? 0).toFixed(0)}°
            </div>
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
                  <span style={styles.swingTime}>#{latestSwing.id}</span>
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
                  <span>CONF {((latestSwing.confidence ?? 0) * 100).toFixed(0)}%</span>
                </div>
              </>
            ) : (
              <div style={styles.emptySwing}>
                Click "Connect M5 Wireless (Bluetooth)" → pick M5-TENNIS-IMU → unplug USB-C &amp; swing!
              </div>
            )}
          </div>

          <div style={styles.trainBox}>
            <div style={styles.trainHeader}>
              <span>
                <strong>Quick Personal Classifier</strong>{' '}
                {trainingState.active ? '✅ PERSONALIZED (5D)' : '(Record 1+ swing each for ~95% accuracy)'}
              </span>
              {trainingState.counts.topspin +
                trainingState.counts.slice +
                trainingState.counts.dropshot >
                0 && (
                <button
                  style={styles.clearBtn}
                  onClick={() => {
                    hardwareInput.clearShotTraining();
                    setTrainingTarget(null);
                    setTrainingState(hardwareInput.classifier.getTrainingState());
                  }}
                >
                  Reset
                </button>
              )}
            </div>
            <div style={styles.trainBtns}>
              {(['topspin', 'slice', 'dropshot'] as const).map((st) => {
                const armed = trainingTarget === st;
                return (
                  <button
                    key={st}
                    style={{
                      ...styles.trainBtn,
                      borderColor: armed ? '#fff' : SHOT_COLORS[st],
                      background: armed ? SHOT_COLORS[st] : '#0f172a',
                      color: armed ? '#031525' : '#f1f5f9',
                    }}
                    onClick={() => {
                      const next = armed ? null : st;
                      hardwareInput.setTrainingTarget(next);
                      setTrainingTarget(next);
                    }}
                  >
                    {armed
                      ? `Swing ${st.toUpperCase()} now...`
                      : `Teach ${st.toUpperCase()} (${trainingState.counts[st]})`}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={styles.slidersBox}>
            <div style={styles.slidersTitle}>Live Calibration Tuning</div>
            <SliderRow
              label={`Swing Trigger G (${config.armAccelG.toFixed(2)}g)`}
              min={0.5}
              max={2.8}
              step={0.05}
              value={config.armAccelG}
              onChange={(v) => updateCfg('armAccelG', v)}
            />
            <SliderRow
              label={`Swing Trigger Gyro (${config.armGyroDps.toFixed(0)}°/s)`}
              min={60}
              max={360}
              step={5}
              value={config.armGyroDps}
              onChange={(v) => updateCfg('armGyroDps', v)}
            />
            <SliderRow
              label={`Slow Dropshot Min G (${config.dropAccelG.toFixed(2)}g)`}
              min={0.2}
              max={1.0}
              step={0.02}
              value={config.dropAccelG}
              onChange={(v) => updateCfg('dropAccelG', v)}
            />
            <SliderRow
              label={`Dropshot Max Power (${config.dropshotPowerMax.toFixed(2)})`}
              min={0.22}
              max={0.6}
              step={0.02}
              value={config.dropshotPowerMax}
              onChange={(v) => updateCfg('dropshotPowerMax', v)}
            />
            <SliderRow
              label={`Slice Roll Cutoff (${config.sliceRotationThreshold.toFixed(2)})`}
              min={-0.6}
              max={0.2}
              step={0.02}
              value={config.sliceRotationThreshold}
              onChange={(v) => updateCfg('sliceRotationThreshold', v)}
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
                Invert Topspin / Slice Axis
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
                <span>zone:{s.armZone}</span>
                <span>pwr:{s.power.toFixed(2)}</span>
                <span>ang:{s.angle.toFixed(2)}</span>
                <span>rot:{s.rotation.toFixed(2)}</span>
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
      gridTemplateColumns: '1fr 130px',
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
    padding: '18px 22px',
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
    marginBottom: 14,
  },
  title: { margin: 0, fontSize: 22, fontWeight: 800 },
  subtitle: { fontSize: 13, color: '#94a3b8', marginTop: 4 },
  headerActions: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  bleBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: 'none',
    background: 'linear-gradient(135deg, #0ea5e9, #22c55e)',
    color: '#031525',
    fontWeight: 900,
    cursor: 'pointer',
  },
  secondaryBtn: {
    padding: '9px 14px',
    borderRadius: 10,
    border: '1px solid #334155',
    background: '#1e293b',
    color: '#f8fafc',
    fontWeight: 700,
    cursor: 'pointer',
  },
  zeroBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: '2px solid #f59e0b',
    background: '#78350f',
    color: '#fef3c7',
    fontWeight: 900,
    cursor: 'pointer',
  },
  zeroBanner: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(234, 88, 12, 0.14))',
    border: '2px solid #f59e0b',
    borderRadius: 14,
    padding: '14px 18px',
    marginBottom: 14,
  },
  zeroBannerText: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 13,
    color: '#fef3c7',
    maxWidth: 760,
  },
  zeroBannerBtn: {
    padding: '12px 22px',
    borderRadius: 12,
    border: 'none',
    background: '#f59e0b',
    color: '#1c1917',
    fontSize: 15,
    fontWeight: 900,
    cursor: 'pointer',
  },
  readyBanner: {
    background: 'rgba(16, 185, 129, 0.14)',
    border: '1px solid #10b981',
    color: '#a7f3d0',
    borderRadius: 12,
    padding: '10px 14px',
    marginBottom: 14,
    fontSize: 13,
  },
  errorBanner: {
    background: '#450a0a',
    border: '1px solid #dc2626',
    color: '#fecaca',
    padding: '10px 14px',
    borderRadius: 10,
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
  deviceTag: { fontSize: 12, color: '#38bdf8', fontFamily: 'monospace' },
  metricsGrid: { display: 'flex', flexDirection: 'column', gap: 10 },
  shotGuide: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    fontSize: 11,
    background: '#090d16',
    border: '1px solid #1e293b',
    borderRadius: 10,
    padding: '8px 10px',
  },
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
    background: '#111827',
    border: '1px solid #334155',
    borderRadius: 12,
    padding: 12,
  },
  swingHeroTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
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
  emptySwing: { fontSize: 13, color: '#64748b', textAlign: 'center', padding: '6px 0' },
  trainBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    background: '#090d16',
    border: '1px solid #334155',
    borderRadius: 10,
    padding: 10,
  },
  trainHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 12,
    color: '#cbd5e1',
  },
  trainBtns: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 },
  trainBtn: {
    padding: '8px 6px',
    borderRadius: 8,
    border: '1px solid #334155',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
  },
  clearBtn: {
    padding: '2px 8px',
    borderRadius: 6,
    border: '1px solid #475569',
    background: 'transparent',
    color: '#94a3b8',
    fontSize: 11,
    cursor: 'pointer',
  },
  slidersBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    background: '#090d16',
    padding: 10,
    borderRadius: 10,
  },
  slidersTitle: { fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 2 },
  checkboxRow: { display: 'flex', gap: 16, marginTop: 4 },
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#cbd5e1' },
  logBox: {
    maxHeight: 150,
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
    gridTemplateColumns: '76px 76px 86px 68px 68px 68px',
    gap: 4,
    padding: '4px 6px',
    background: '#090d16',
    borderRadius: 6,
  },
};
