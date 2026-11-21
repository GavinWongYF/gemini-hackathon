// Frontier AI Lab 3D Evaluation Console (`/match`, Notion Section 9 & 10):
//   - Top Studio Header:  Lab identity, active match_id + policy version, live hardware/vision/WS links
//   - Three-Column Body:
//       1. Left rail:     `<npc-panel side="left" />` (Decision 1 short-loop player read)
//       2. Center stage:  Scoreboard bar + completely uncovered 3D `Gemini Arena` (`<SceneSlot />`) + kinematics footer
//       3. Right rail:    `<npc-panel side="right" />` (Gemini 4 Neon long-loop strategy adaptation)

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ArmZone, MatchRenderState, RecordedShot, StrategyVisualCue } from '@shared/contracts';
import { TENNIS_MATCH_PLAN, TENNIS_SETTINGS_BOUNDS } from '@shared/agentProtocol';
import { hardwareInput } from '../hardware/HardwareInputManager';
import { AgentClient, type AgentConnectionStatus } from '../ai/AgentClient';
import { OpponentBrain } from '../ai/OpponentBrain';
import { TennisMatchEngine, createInitialMatchRenderState } from '../engine/TennisMatchEngine';
import { captureCourtJpeg } from './CourtFrameCapture';
import { PauseDashboard, type PointWinnerRecord } from './PauseDashboard';
import { PlayerCamPreview } from './PlayerCamPreview';
import { SceneSlot } from './SceneSlot';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'npc-panel': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { side?: 'left' | 'right' },
        HTMLElement
      >;
    }
  }
}

interface SwingTelemetrySnapshot {
  wing: string;
  shotType: string;
  power: number;
  rotation: number;
  confidence: number;
}

interface OpponentShotSnapshot {
  shotType: string;
  lands: string;
  byRule: boolean;
}

const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const CUE_LABELS: Record<StrategyVisualCue, { label: string; color: string }> = {
  balanced: { label: 'BALANCED', color: '#0284c7' },
  aggressive: { label: 'FLAT_PRESSURE', color: '#dc2626' },
  net_rush: { label: 'NET_INTERCEPT', color: '#d97706' },
  defensive_wall: { label: 'DEEP_RESET', color: '#059669' },
  slice_trap: { label: 'SLICE_DROP_TRAP', color: '#7c3aed' },
};

const CourtMarkIcon: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="2" y="1.5" width="12" height="13" rx="1.5" stroke="#141413" strokeWidth="1.3" />
    <line x1="2" y1="8" x2="14" y2="8" stroke="#141413" strokeWidth="1.3" />
    <line x1="4.5" y1="4.75" x2="11.5" y2="4.75" stroke="#141413" strokeWidth="1" opacity="0.55" />
    <line x1="4.5" y1="11.25" x2="11.5" y2="11.25" stroke="#141413" strokeWidth="1" opacity="0.55" />
    <line x1="8" y1="4.75" x2="8" y2="11.25" stroke="#141413" strokeWidth="1" opacity="0.55" />
  </svg>
);

const TelemetryPill: React.FC<{
  dotColor: string;
  label: string;
  detail?: string;
}> = ({ dotColor, label, detail }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 24,
      padding: '0 8px',
      borderRadius: 5,
      background: '#fafaf8',
      border: '1px solid #e5e4df',
      fontFamily: MONO,
      fontSize: 10.5,
      fontWeight: 500,
      color: '#141413',
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
    }}
  >
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: dotColor,
        flexShrink: 0,
      }}
    />
    <span>{label}</span>
    {detail && <span style={{ color: '#8c8b85' }}>{detail}</span>}
  </span>
);

export const LiveMatchView: React.FC = () => {
  const matchStateRef = useRef<MatchRenderState>(
    createInitialMatchRenderState(TENNIS_MATCH_PLAN.rounds ?? 0),
  );
  const sceneContainerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TennisMatchEngine | null>(null);
  const agentRef = useRef<AgentClient | null>(null);
  const brainRef = useRef<OpponentBrain | null>(null);
  const matchEpochRef = useRef(0);

  const [phase, setPhase] = useState<MatchRenderState['phase']>('ready');
  const [score, setScore] = useState<MatchRenderState['score']>(matchStateRef.current.score);
  const [agentStatus, setAgentStatus] = useState<AgentConnectionStatus>('connecting');
  const [matchId, setMatchId] = useState<string>('');
  const [policyVersion, setPolicyVersion] = useState<number>(0);
  const [opponentSpeed, setOpponentSpeed] = useState<number>(
    TENNIS_SETTINGS_BOUNDS.opponent_speed.default,
  );
  const [visualCue, setVisualCue] = useState<StrategyVisualCue>('balanced');

  const [recentShots, setRecentShots] = useState<RecordedShot[]>([]);
  const [pointWinners, setPointWinners] = useState<PointWinnerRecord[]>([]);
  const [rallyShotCount, setRallyShotCount] = useState<number>(0);

  const [imuConnected, setImuConnected] = useState(false);
  const [imuHz, setImuHz] = useState(0);
  const [imuCalibrated, setImuCalibrated] = useState(false);
  const [webcamActive, setWebcamActive] = useState(false);
  const [webcamStatus, setWebcamStatus] = useState<'idle' | 'loading' | 'running' | 'error'>('idle');
  const [armZone, setArmZone] = useState<ArmZone>('center');
  const [strikeWindowLive, setStrikeWindowLive] = useState(false);
  const [lastSwing, setLastSwing] = useState<SwingTelemetrySnapshot | null>(null);
  const [lastAiShot, setLastAiShot] = useState<OpponentShotSnapshot | null>(null);
  const [shotMix, setShotMix] = useState<{ topspin: number; slice: number; dropshot: number; fh: number; total: number }>({
    topspin: 0,
    slice: 0,
    dropshot: 0,
    fh: 0,
    total: 0,
  });
  const [showSidePanels, setShowSidePanels] = useState(true);
  const [showPausedArcs, setShowPausedArcs] = useState(true);

  const handleRestart = useCallback(() => {
    const engine = engineRef.current;
    const agent = agentRef.current;
    const brain = brainRef.current;
    if (!engine || !agent || !brain) return;

    const epoch = ++matchEpochRef.current;
    brain.resetToBaseline();
    engine.resetToReady();
    engine.syncToRenderState(matchStateRef.current);
    setRecentShots([]);
    setPointWinners([]);
    setRallyShotCount(0);
    setLastSwing(null);
    setLastAiShot(null);
    setShotMix({ topspin: 0, slice: 0, dropshot: 0, fh: 0, total: 0 });
    setShowPausedArcs(true);
    setPolicyVersion(0);
    setOpponentSpeed(TENNIS_SETTINGS_BOUNDS.opponent_speed.default);
    setVisualCue('balanced');
    setPhase('ready');
    setScore({ ...engine.getRenderState().score });

    const readyPromise = agent.startNewMatch();
    setMatchId(agent.getMatchId());

    void readyPromise.then(() => {
      if (matchEpochRef.current !== epoch) return;
      if (engine.getRenderState().phase !== 'ready') return;
      setPolicyVersion(brain.getActiveBehaviour().version);
      setOpponentSpeed(brain.getSettings().opponent_speed);
      engine.startMatch();
      engine.syncToRenderState(matchStateRef.current);
      setPhase(engine.getRenderState().phase);
      setScore({ ...engine.getRenderState().score });
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    hardwareInput.start();
    const unsubWebcam = hardwareInput.webcam.subscribe((snap) => {
      setWebcamStatus(snap.status);
    });
    // Auto-start laptop webcam so Felix & Gavin receive `frames.views.player_cam` and
    // TennisSwingDetector tracks Forehand/Backhand + Topspin/Slice/Dropshot live!
    void hardwareInput.webcam.start();

    const brain = new OpponentBrain();
    brainRef.current = brain;

    const agent = new AgentClient({
      mode: 'live',
      callbacks: {
        onStatus: (status) => {
          setAgentStatus(status);
          // If :8000 came online AFTER /match loaded, dynamically retry loading panels.js once!
          if (
            status === 'connected' &&
            typeof customElements !== 'undefined' &&
            !customElements.get('npc-panel') &&
            !document.querySelector('script[data-npc-panels-retry]')
          ) {
            const s = document.createElement('script');
            s.type = 'module';
            s.dataset.npcPanelsRetry = '1';
            s.src = `http://localhost:8000/screen/panels.js?t=${Date.now()}`;
            s.onerror = () => s.remove();
            document.head.appendChild(s);
          }
        },
        onReady: (msg) => {
          if (engineRef.current && engineRef.current.getRenderState().phase !== 'ready') {
            // Presenter force-started before `ready` arrived -> apply cleanly at next point gap
            brain.queueStrategyUpdate({ behaviour: msg.behaviour });
          } else {
            brain.applyReadyBehaviour(msg.behaviour);
            setPolicyVersion(msg.behaviour.version);
          }
        },
        onPlayerRead: (msg) => {
          brain.updatePlayerValues(msg.values);
        },
        onStrategyUpdate: (msg) => {
          brain.queueStrategyUpdate(msg);
        },
      },
    });
    agentRef.current = agent;
    setMatchId(agent.getMatchId());

    const engine = new TennisMatchEngine(brain, {
      totalDemoPoints: TENNIS_MATCH_PLAN.rounds ?? 0,
      breakEvery: TENNIS_MATCH_PLAN.break_every,
      enableDemoPauses: TENNIS_MATCH_PLAN.break_every > 0,
      sink: {
        onAgentEvent: (evt) => {
          agent.sendEvent(evt);
          if (evt.name === 'shot' && evt.by === 'opponent') {
            setLastAiShot({
              shotType: String(evt.data.shot_type ?? 'topspin').toUpperCase(),
              lands: String(evt.data.lands ?? 'middle_deep').toUpperCase(),
              byRule: Array.isArray(evt.by_rule) && evt.by_rule.length > 0,
            });
          } else if (evt.name === 'shot' && evt.by === 'player') {
            const st = evt.data.shot_type;
            const sd = evt.data.side;
            setShotMix((prev) => ({
              topspin: prev.topspin + (st === 'topspin' ? 1 : 0),
              slice: prev.slice + (st === 'slice' ? 1 : 0),
              dropshot: prev.dropshot + (st === 'dropshot' ? 1 : 0),
              fh: prev.fh + (sd === 'forehand' ? 1 : 0),
              total: prev.total + 1,
            }));
          }
        },
        onAgentRoundEnd: (roundEnd) => {
          agent.sendRoundEnd(roundEnd);
          setScore({ ...engine.getRenderState().score });
          setRallyShotCount(0);
          if (roundEnd.winner === 'player' || roundEnd.winner === 'opponent') {
            const w = roundEnd.winner;
            setPointWinners((prev) => [...prev, w]);
          }
        },
        onShotRecorded: () => {
          setRecentShots([...engine.getShotHistory().slice(-12)]);
          setRallyShotCount(engine.getCurrentRallyShotCount());
        },
        onPhaseChange: (nextPhase) => {
          setPhase(nextPhase);
          setScore({ ...engine.getRenderState().score });
          setPolicyVersion(brain.getActiveBehaviour().version);
          setOpponentSpeed(brain.getSettings().opponent_speed);
        },
      },
    });
    engineRef.current = engine;

    // Hold in `ready` state until `connectAndSetup()` resolves so round 1 never starts before `ready`
    const initialEpoch = ++matchEpochRef.current;
    engine.resetToReady();
    engine.syncToRenderState(matchStateRef.current);
    setPhase('ready');
    setScore({ ...engine.getRenderState().score });

    void agent.connectAndSetup().then(() => {
      if (cancelled || matchEpochRef.current !== initialEpoch) return;
      if (engine.getRenderState().phase !== 'ready') return;
      setPolicyVersion(brain.getActiveBehaviour().version);
      engine.startMatch();
      engine.syncToRenderState(matchStateRef.current);
      setPhase(engine.getRenderState().phase);
      setScore({ ...engine.getRenderState().score });
    });

    const unsubSwingStart = hardwareInput.onSwingStart((evt) => {
      engine.handlePlayerSwingStart(evt);
    });
    const unsubSwing = hardwareInput.onSwing((evt) => {
      engine.handlePlayerSwing(evt);
      setRallyShotCount(engine.getCurrentRallyShotCount());
      setLastSwing({
        wing: evt.wing.toUpperCase(),
        shotType: evt.shotType.toUpperCase(),
        power: evt.power,
        rotation: evt.rotation,
        confidence: Math.round((evt.confidence ?? 0.85) * 100),
      });
    });

    // Capture-phase listener so Space during `ready`/`demo_pause` acts cleanly without firing a swing,
    // and Shift+R (or R on match_over) resets the match without colliding with plain R M5 zeroing!
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      const curPhase = engine.getRenderState().phase;
      if ((e.code === 'Space' || e.code === 'Enter') && curPhase === 'ready') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPolicyVersion(brain.getActiveBehaviour().version);
        engine.startMatch();
        engine.syncToRenderState(matchStateRef.current);
        setPhase(engine.getRenderState().phase);
        setScore({ ...engine.getRenderState().score });
        return;
      }
      if ((e.code === 'Space' || e.code === 'Enter') && curPhase === 'demo_pause') {
        e.preventDefault();
        e.stopImmediatePropagation();
        engine.resumeFromDemoPause();
        return;
      }
      if (e.code === 'KeyP') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (curPhase === 'demo_pause') {
          engine.resumeFromDemoPause();
        } else {
          engine.triggerManualDemoPause();
        }
        engine.syncToRenderState(matchStateRef.current);
        setPhase(engine.getRenderState().phase);
      } else if (e.code === 'KeyF' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowSidePanels((prev) => !prev);
      } else if (
        e.code === 'KeyR' &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.shiftKey || curPhase === 'match_over')
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        handleRestart();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);

    let lastTime = performance.now();
    let lastFrameSentMs = 0;
    let lastHudSyncMs = 0;
    let rafId = 0;

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      const hw = hardwareInput.getState();
      engine.applyPlayerControl(hw);
      engine.step(dt);
      engine.syncToRenderState(matchStateRef.current);

      // Gate IMU + Webcam swing detection ONLY to when an incoming ball is in its playable
      // return window (covering serves that bounce at z~5.5m and carry past the baseline to z~12.5m!).
      const b = matchStateRef.current.ball;
      const p = matchStateRef.current.player;
      const incomingToPlayer =
        matchStateRef.current.phase === 'rally' &&
        b.active &&
        b.vz > 0 &&
        b.bounceCount < 2 &&
        b.z > 0.5 &&
        b.z <= Math.max(p.z + 4.2, 13.5);
      hardwareInput.setStrikeWindow(incomingToPlayer, b.x - p.x);

      if (now - lastHudSyncMs >= 200) {
        lastHudSyncMs = now;
        setImuConnected(hw.imuConnected);
        setImuHz(hw.imuHz);
        setImuCalibrated(hw.calibration === 'ready');
        setWebcamActive(hw.arm.active);
        setArmZone(hw.arm.armZone);
        setStrikeWindowLive(incomingToPlayer);
        setVisualCue(matchStateRef.current.opponent.strategyVisualCue ?? 'balanced');
      }

      if (engine.getRenderState().phase === 'rally' && now - lastFrameSentMs >= 1000) {
        lastFrameSentMs = now;
        const views: Record<string, { mime_type: 'image/jpeg'; data: string }> = {};
        const courtB64 = captureCourtJpeg(
          matchStateRef.current,
          engine.getShotHistory(),
          sceneContainerRef.current,
        );
        if (courtB64) {
          views.court = { mime_type: 'image/jpeg', data: courtB64 };
        }
        const camB64 = hardwareInput.webcam.capturePlayerCamJpeg(384, 0.68);
        if (camB64) {
          views.player_cam = { mime_type: 'image/jpeg', data: camB64 };
        }
        agent.sendFrames(
          engine.getRenderState().score.pointIndex,
          Math.round(engine.getMatchTimeSec() * 100) / 100,
          views,
        );
      }
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      matchEpochRef.current += 1;
      cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKeyDown, true);
      unsubWebcam();
      unsubSwingStart();
      unsubSwing();
      hardwareInput.setStrikeWindow(true);
      hardwareInput.webcam.stop();
      agent.disconnect();
    };
  }, [handleRestart]);

  const handleResume = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.resumeFromDemoPause();
    eng.syncToRenderState(matchStateRef.current);
    setPhase(eng.getRenderState().phase);
  }, []);

  const handleTogglePause = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    if (eng.getRenderState().phase === 'demo_pause') {
      eng.resumeFromDemoPause();
    } else {
      eng.triggerManualDemoPause();
    }
    eng.syncToRenderState(matchStateRef.current);
    setPhase(eng.getRenderState().phase);
  }, []);

  const handleTogglePausedArcs = useCallback(() => {
    setShowPausedArcs((prev) => !prev);
  }, []);

  const handleToggleSidePanels = useCallback(() => {
    setShowSidePanels((prev) => !prev);
  }, []);

  const handleToggleWebcam = useCallback(() => {
    if (webcamStatus === 'running' || webcamStatus === 'loading') {
      hardwareInput.webcam.stop();
    } else {
      void hardwareInput.webcam.start();
    }
  }, [webcamStatus]);

  const handleZeroRacket = useCallback(() => {
    hardwareInput.zeroRacket();
  }, []);

  const handleConnectBle = useCallback(() => {
    void hardwareInput.connectBle();
  }, []);

  const handleForceStart = useCallback(() => {
    const engine = engineRef.current;
    const brain = brainRef.current;
    if (!engine || !brain) return;
    if (engine.getRenderState().phase !== 'ready') return;
    setPolicyVersion(brain.getActiveBehaviour().version);
    engine.startMatch();
    engine.syncToRenderState(matchStateRef.current);
    setPhase(engine.getRenderState().phase);
    setScore({ ...engine.getRenderState().score });
  }, []);

  const handleCanvasClick = useCallback(() => {
    const curPhase = engineRef.current?.getRenderState().phase;
    if (curPhase === 'ready') {
      handleForceStart();
    } else if (curPhase === 'rally') {
      hardwareInput.triggerManualSwing();
    }
  }, [handleForceStart]);

  const isOfflineNotAdapting = agentStatus === 'mock' || agentStatus === 'disconnected';

  const agentDot =
    agentStatus === 'connected'
      ? '#059669'
      : agentStatus === 'connecting'
        ? '#d97706'
        : '#dc2626';

  const agentLabel =
    agentStatus === 'connected'
      ? 'WS :8000'
      : agentStatus === 'connecting'
        ? 'WS :8000'
        : 'OFFLINE';

  const agentDetail =
    agentStatus === 'connected'
      ? 'ADAPTING'
      : agentStatus === 'connecting'
        ? 'SYNC'
        : 'NOT ADAPTING';

  const shortMatchId = matchId ? matchId.replace(/^tennis_/, '').slice(-8) : 'init';
  const cueMeta = CUE_LABELS[visualCue] ?? CUE_LABELS.balanced;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#f4f4f1',
        overflow: 'hidden',
      }}
    >
      {/* Row 1: Frontier AI Lab Studio Header */}
      <header
        style={{
          height: 42,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          background: '#ffffff',
          borderBottom: '1px solid #e5e4df',
          zIndex: 30,
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <CourtMarkIcon />
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              letterSpacing: '0.04em',
              color: '#141413',
              whiteSpace: 'nowrap',
            }}
          >
            GEMINI ARENA
          </span>
          <span style={{ color: '#d4d3cd', fontSize: 13 }}>/</span>
          <span
            style={{
              fontSize: 12.5,
              color: '#575652',
              letterSpacing: '-0.01em',
              whiteSpace: 'nowrap',
            }}
          >
            Adaptive Opponent Evaluation
          </span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              color: '#8c8b85',
              padding: '2px 7px',
              borderRadius: 4,
              background: '#f4f4f1',
              whiteSpace: 'nowrap',
            }}
          >
            SESSION · {shortMatchId}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            className="lab-btn"
            onClick={handleConnectBle}
            title={
              imuConnected
                ? 'M5 IMU live — click to switch Web Bluetooth device'
                : 'Click to pair M5-TENNIS-IMU over Web Bluetooth (or run ble_bridge.py)'
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 8px',
              borderRadius: 5,
              background: '#fafaf8',
              border: '1px solid #e5e4df',
              fontFamily: MONO,
              fontSize: 10.5,
              fontWeight: 500,
              color: '#141413',
              letterSpacing: '0.02em',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: imuConnected ? (imuCalibrated ? '#059669' : '#d97706') : '#c8c7c0',
                flexShrink: 0,
              }}
            />
            <span>IMU</span>
            <span style={{ color: '#8c8b85' }}>{imuConnected ? `${imuHz}HZ` : 'PAIR'}</span>
          </button>
          {imuConnected && (
            <button
              type="button"
              className="lab-btn"
              onClick={handleZeroRacket}
              title="Zero / Re-Zero M5 racket in any comfortable grip (also BtnA on M5)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: 24,
                padding: '0 8px',
                borderRadius: 5,
                background: imuCalibrated ? '#fafaf8' : '#fef3c7',
                color: imuCalibrated ? '#575652' : '#92400e',
                border: `1px solid ${imuCalibrated ? '#e5e4df' : '#f59e0b'}`,
                fontFamily: MONO,
                fontSize: 10.5,
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {imuCalibrated ? 'RE-ZERO' : 'ZERO M5'}
            </button>
          )}
          <button
            type="button"
            className="lab-btn"
            onClick={handleToggleWebcam}
            title="Toggle laptop webcam for pose tracking & Gemini player_cam frames"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 8px',
              borderRadius: 5,
              background: '#fafaf8',
              border: '1px solid #e5e4df',
              fontFamily: MONO,
              fontSize: 10.5,
              fontWeight: 500,
              color: '#141413',
              letterSpacing: '0.02em',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background:
                  webcamStatus === 'running'
                    ? '#059669'
                    : webcamStatus === 'loading'
                      ? '#d97706'
                      : '#c8c7c0',
                flexShrink: 0,
              }}
            />
            <span>CAM</span>
            <span style={{ color: '#8c8b85' }}>
              {webcamActive
                ? armZone.toUpperCase()
                : webcamStatus === 'loading'
                  ? 'INIT'
                  : webcamStatus === 'running'
                    ? 'ON'
                    : 'OFF'}
            </span>
          </button>
          {isOfflineNotAdapting ? (
            <span
              title="Agent backend at ws://localhost:8000/ws is not connected; opponent is running fixed baseline behaviour without adaptation."
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 24,
                padding: '0 9px',
                borderRadius: 5,
                background: '#fef2f2',
                border: '1px solid #fecaca',
                fontFamily: MONO,
                fontSize: 10.5,
                fontWeight: 600,
                color: '#b91c1c',
                letterSpacing: '0.02em',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#dc2626',
                  flexShrink: 0,
                }}
              />
              <span>OFFLINE · NOT ADAPTING</span>
            </span>
          ) : (
            <TelemetryPill dotColor={agentDot} label={agentLabel} detail={agentDetail} />
          )}

          <span style={{ width: 1, height: 14, background: '#e5e4df', margin: '0 2px' }} />

          <button
            type="button"
            className="lab-btn"
            onClick={handleToggleSidePanels}
            title="Toggle Cinema full-width 3D court (F)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 9px',
              borderRadius: 5,
              background: showSidePanels ? '#fafaf8' : '#141413',
              color: showSidePanels ? '#575652' : '#ffffff',
              border: `1px solid ${showSidePanels ? '#e5e4df' : '#141413'}`,
              fontFamily: MONO,
              fontSize: 10.5,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <span>{showSidePanels ? 'CINEMA [F]' : '3-COL [F]'}</span>
          </button>

          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            className="lab-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 24,
              padding: '0 9px',
              borderRadius: 5,
              background: '#fafaf8',
              border: '1px solid #e5e4df',
              color: '#575652',
              fontFamily: MONO,
              fontSize: 10.5,
              fontWeight: 500,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            SENSOR BENCH ↗
          </a>
        </div>
      </header>

      {/* Row 2: Section 9 Three-Column Body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: showSidePanels
            ? 'clamp(236px, 18.5vw, 276px) minmax(0, 1fr) clamp(236px, 18.5vw, 276px)'
            : 'minmax(0, 1fr)',
          width: '100%',
          overflow: 'hidden',
        }}
      >
        {/* Left slot: Live Player Cam + Pose skeleton above <npc-panel side="left"> short-loop read */}
        <aside
          style={{
            display: showSidePanels ? 'flex' : 'none',
            flexDirection: 'column',
            background: '#ffffff',
            borderRight: '1px solid #e5e4df',
            minHeight: 0,
            overflowY: 'auto',
          }}
        >
          <PlayerCamPreview />
          <div style={{ flex: 1, minHeight: 0 }}>
            <npc-panel side="left" />
          </div>
        </aside>

        {/* Middle widest column: Scoreboard bar + Uncovered 3D Court + Kinematics Footer */}
        <main
          style={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
            height: '100%',
            background: '#f4f4f1',
          }}
        >
          <PauseDashboard
            score={score}
            phase={phase}
            breakEvery={TENNIS_MATCH_PLAN.break_every}
            pointWinners={pointWinners}
            rallyShotCount={rallyShotCount}
            onResume={handleResume}
            onRestart={handleRestart}
            onTogglePause={handleTogglePause}
            onForceStart={handleForceStart}
            showPausedArcs={showPausedArcs}
            onTogglePausedArcs={handleTogglePausedArcs}
          />

          {/* Studio Viewport Mat framing Akhil's 3D CourtScene (0 overlays over the court) */}
          <div style={{ flex: 1, minHeight: 0, padding: '8px 10px', position: 'relative' }}>
            <SceneSlot
              containerRef={sceneContainerRef}
              matchStateRef={matchStateRef}
              replayMode={phase === 'demo_pause' && showPausedArcs}
              replayArcs={recentShots}
              onCanvasClick={handleCanvasClick}
            />
          </div>

          {/* Bottom Tabular Kinematics & Policy Telemetry Strip (below court, never over court) */}
          <footer
            style={{
              minHeight: 32,
              flexShrink: 0,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '4px 12px',
              background: '#ffffff',
              borderTop: '1px solid #e5e4df',
              fontFamily: MONO,
              fontVariantNumeric: 'tabular-nums',
              fontSize: 10.5,
              color: '#575652',
              columnGap: 12,
              rowGap: 4,
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 3, minWidth: 0 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                <span style={{ color: '#8c8b85' }}>OPPONENT</span>
                <span style={{ color: '#141413', fontWeight: 600 }}>v{policyVersion}</span>
                <span style={{ color: '#8c8b85' }}>·</span>
                <span style={{ color: '#141413' }}>{opponentSpeed.toFixed(2)}x</span>
                <span style={{ color: '#8c8b85' }}>·</span>
                <span style={{ color: cueMeta.color, fontWeight: 500 }}>{cueMeta.label}</span>
              </span>

              <span style={{ color: '#e5e4df' }}>|</span>

              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: strikeWindowLive ? '#059669' : '#d4d3cd',
                  }}
                />
                <span style={{ color: strikeWindowLive ? '#059669' : '#8c8b85', fontWeight: 600 }}>
                  {strikeWindowLive ? 'READY' : 'WAIT'}
                </span>
              </span>

              <span style={{ color: '#e5e4df' }}>|</span>

              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                <span style={{ color: '#8c8b85' }}>SHOT</span>
                {lastSwing ? (
                  <>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '1px 6px',
                        borderRadius: 4,
                        fontWeight: 700,
                        fontSize: 10,
                        color: '#ffffff',
                        background:
                          lastSwing.shotType === 'SLICE'
                            ? '#d97706'
                            : lastSwing.shotType === 'DROPSHOT'
                              ? '#059669'
                              : '#0284c7',
                      }}
                    >
                      {lastSwing.wing === 'FOREHAND' ? 'FH' : 'BH'} {lastSwing.shotType}
                    </span>
                    <span style={{ color: '#575652', fontWeight: 400 }}>
                      {lastSwing.power.toFixed(2)} · {lastSwing.rotation >= 0 ? '+' : ''}
                      {lastSwing.rotation.toFixed(2)}
                    </span>
                  </>
                ) : (
                  <span style={{ color: '#a1a1aa' }}>—</span>
                )}
              </span>

              <span style={{ color: '#e5e4df' }}>|</span>

              <span style={{ whiteSpace: 'nowrap' }}>
                <span style={{ color: '#8c8b85' }}>MIX </span>
                {shotMix.total > 0 ? (
                  <span style={{ color: '#141413', fontWeight: 500 }}>
                    TOP {Math.round((shotMix.topspin / shotMix.total) * 100)}% · SLC{' '}
                    {Math.round((shotMix.slice / shotMix.total) * 100)}% · DRP{' '}
                    {Math.round((shotMix.dropshot / shotMix.total) * 100)}%{' '}
                    <span style={{ color: '#8c8b85', fontWeight: 400 }}>
                      (FH {Math.round((shotMix.fh / shotMix.total) * 100)}%)
                    </span>
                  </span>
                ) : (
                  <span style={{ color: '#a1a1aa' }}>—</span>
                )}
              </span>

              <span style={{ color: '#e5e4df' }}>|</span>

              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                <span style={{ color: '#8c8b85' }}>AI</span>
                {lastAiShot ? (
                  <>
                    <span style={{ color: '#141413', fontWeight: 600 }}>
                      {lastAiShot.shotType} → {lastAiShot.lands}
                    </span>
                    {lastAiShot.byRule && (
                      <span
                        style={{
                          padding: '1px 5px',
                          borderRadius: 3,
                          background: '#141413',
                          color: '#ffffff',
                          fontSize: 9.5,
                          fontWeight: 600,
                        }}
                      >
                        RULE
                      </span>
                    )}
                  </>
                ) : (
                  <span style={{ color: '#a1a1aa' }}>—</span>
                )}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8c8b85', flexShrink: 0, whiteSpace: 'nowrap' }}>
              <span>SPACE Swing</span>
              <span>·</span>
              <span>P Pause</span>
              <span>·</span>
              <span>⇧R Restart</span>
              <span>·</span>
              <span>R Zero</span>
              <span>·</span>
              <span>F Cinema</span>
            </div>
          </footer>
        </main>

        {/* Right slot: empty standby when :8000 is offline, populated by <npc-panel side="right"> when online */}
        <aside
          style={{
            display: showSidePanels ? 'block' : 'none',
            background: '#ffffff',
            borderLeft: '1px solid #e5e4df',
            minHeight: 0,
            overflowY: 'auto',
          }}
        >
          <npc-panel side="right" />
        </aside>
      </div>
    </div>
  );
};
