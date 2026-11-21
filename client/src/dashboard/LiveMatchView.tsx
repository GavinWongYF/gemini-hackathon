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
    createInitialMatchRenderState(TENNIS_MATCH_PLAN.rounds),
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
  const [webcamActive, setWebcamActive] = useState(false);
  const [armZone, setArmZone] = useState<ArmZone>('center');
  const [lastSwing, setLastSwing] = useState<SwingTelemetrySnapshot | null>(null);
  const [showSidePanels, setShowSidePanels] = useState(true);

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
    setPolicyVersion(0);
    setOpponentSpeed(TENNIS_SETTINGS_BOUNDS.opponent_speed.default);
    setVisualCue('balanced');
    setPhase('ready');
    setScore({ ...engine.getRenderState().score });

    const readyPromise = agent.startNewMatch();
    setMatchId(agent.getMatchId());

    void readyPromise.then(() => {
      if (matchEpochRef.current !== epoch) return;
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

    const brain = new OpponentBrain();
    brainRef.current = brain;

    const agent = new AgentClient({
      mode: 'live',
      callbacks: {
        onStatus: setAgentStatus,
        onReady: (msg) => {
          brain.applyReadyBehaviour(msg.behaviour);
          setPolicyVersion(msg.behaviour.version);
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
      totalDemoPoints: TENNIS_MATCH_PLAN.rounds,
      breakEvery: TENNIS_MATCH_PLAN.break_every,
      enableDemoPauses: true,
      sink: {
        onAgentEvent: (evt) => {
          agent.sendEvent(evt);
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

    // Capture-phase listener so Space during `demo_pause` resumes cleanly without also firing a manual swing
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if ((e.code === 'Space' || e.code === 'Enter') && engine.getRenderState().phase === 'demo_pause') {
        e.preventDefault();
        e.stopImmediatePropagation();
        engine.resumeFromDemoPause();
        return;
      }
      if (e.code === 'KeyP') {
        e.preventDefault();
        if (engine.getRenderState().phase === 'demo_pause') {
          engine.resumeFromDemoPause();
        } else {
          engine.triggerManualDemoPause();
        }
      } else if (e.code === 'KeyF' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowSidePanels((prev) => !prev);
      } else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
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

      if (now - lastHudSyncMs >= 250) {
        lastHudSyncMs = now;
        setImuConnected(hw.imuConnected);
        setImuHz(hw.imuHz);
        setWebcamActive(hw.arm.active);
        setArmZone(hw.arm.armZone);
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
      unsubSwingStart();
      unsubSwing();
      agent.disconnect();
    };
  }, [handleRestart]);

  const handleResume = useCallback(() => {
    engineRef.current?.resumeFromDemoPause();
  }, []);

  const handleTogglePause = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    if (eng.getRenderState().phase === 'demo_pause') {
      eng.resumeFromDemoPause();
    } else {
      eng.triggerManualDemoPause();
    }
  }, []);

  const handleToggleSidePanels = useCallback(() => {
    setShowSidePanels((prev) => !prev);
  }, []);

  const handleCanvasClick = useCallback(() => {
    if (engineRef.current?.getRenderState().phase === 'demo_pause') {
      engineRef.current.resumeFromDemoPause();
    } else if (engineRef.current?.getRenderState().phase !== 'ready') {
      hardwareInput.triggerManualSwing();
    }
  }, []);

  const agentDot =
    agentStatus === 'connected'
      ? '#059669'
      : agentStatus === 'connecting'
        ? '#d97706'
        : '#a1a1aa';

  const agentLabel =
    agentStatus === 'connected'
      ? 'WS :8000'
      : agentStatus === 'connecting'
        ? 'WS :8000'
        : 'POLICY';

  const agentDetail =
    agentStatus === 'connected'
      ? 'LIVE'
      : agentStatus === 'connecting'
        ? 'SYNC'
        : 'LOCAL';

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
          <TelemetryPill
            dotColor={imuConnected ? '#059669' : '#c8c7c0'}
            label="IMU"
            detail={imuConnected ? `${imuHz}HZ` : 'KEY'}
          />
          <TelemetryPill
            dotColor={webcamActive ? '#059669' : '#c8c7c0'}
            label="POSE"
            detail={webcamActive ? armZone.toUpperCase() : 'IDLE'}
          />
          <TelemetryPill dotColor={agentDot} label={agentLabel} detail={agentDetail} />

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
        {/* Left slot: empty standby when :8000 is offline, populated by <npc-panel side="left"> when online */}
        <aside
          style={{
            display: showSidePanels ? 'block' : 'none',
            background: '#ffffff',
            borderRight: '1px solid #e5e4df',
            minHeight: 0,
            overflowY: 'auto',
          }}
        >
          <npc-panel side="left" />
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
          />

          {/* Studio Viewport Mat framing Akhil's 3D CourtScene (0 overlays over the court) */}
          <div style={{ flex: 1, minHeight: 0, padding: '8px 10px', position: 'relative' }}>
            <SceneSlot
              containerRef={sceneContainerRef}
              matchStateRef={matchStateRef}
              replayMode={phase === 'demo_pause'}
              replayArcs={recentShots}
              onCanvasClick={handleCanvasClick}
            />
          </div>

          {/* Bottom Tabular Kinematics & Policy Telemetry Strip (below court, never over court) */}
          <footer
            style={{
              height: 32,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 14px',
              background: '#ffffff',
              borderTop: '1px solid #e5e4df',
              fontFamily: MONO,
              fontVariantNumeric: 'tabular-nums',
              fontSize: 10.5,
              color: '#575652',
              gap: 12,
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, whiteSpace: 'nowrap' }}>
              <span>
                <span style={{ color: '#8c8b85' }}>LAST STROKE </span>
                {lastSwing ? (
                  <span style={{ color: '#141413', fontWeight: 500 }}>
                    {lastSwing.wing} · {lastSwing.shotType}{' '}
                    <span style={{ color: '#575652', fontWeight: 400 }}>
                      PWR {lastSwing.power.toFixed(2)} · SPIN {lastSwing.rotation >= 0 ? '+' : ''}
                      {lastSwing.rotation.toFixed(2)} · {lastSwing.confidence}%
                    </span>
                  </span>
                ) : (
                  <span style={{ color: '#a1a1aa' }}>—</span>
                )}
              </span>

              <span style={{ color: '#e5e4df' }}>|</span>

              <span>
                <span style={{ color: '#8c8b85' }}>STANCE </span>
                <span style={{ color: '#141413', fontWeight: 500 }}>{armZone.toUpperCase()}</span>
              </span>

              <span style={{ color: '#e5e4df' }}>|</span>

              <span>
                <span style={{ color: '#8c8b85' }}>OPPONENT </span>
                <span style={{ color: '#141413', fontWeight: 500 }}>v{policyVersion}</span>{' '}
                <span style={{ color: '#8c8b85' }}>· SPD</span>{' '}
                <span style={{ color: '#141413' }}>{opponentSpeed.toFixed(2)}x</span>{' '}
                <span style={{ color: '#8c8b85' }}>·</span>{' '}
                <span style={{ color: cueMeta.color, fontWeight: 500 }}>{cueMeta.label}</span>
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#8c8b85', flexShrink: 0, whiteSpace: 'nowrap' }}>
              <span>CLICK / SPACE Swing</span>
              <span>·</span>
              <span>P 3D Replay</span>
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
