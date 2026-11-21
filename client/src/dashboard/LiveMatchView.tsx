// Three-Column 3D Live Match View (`/match`, Notion Section 9 @ 1:20 PM + Section 10 fixes):
//   - Left narrow box:   `<npc-panel side="left" />` (stays empty when :8000 is offline)
//   - Middle wide box:   Uncovered 3D Gemini Arena (`<SceneSlot />` -> Akhil's `CourtScene`)
//   - Right narrow box:  `<npc-panel side="right" />` (stays empty when :8000 is offline)

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchRenderState, RecordedShot } from '@shared/contracts';
import { TENNIS_MATCH_PLAN } from '@shared/agentProtocol';
import { hardwareInput } from '../hardware/HardwareInputManager';
import { AgentClient, type AgentConnectionStatus } from '../ai/AgentClient';
import { OpponentBrain } from '../ai/OpponentBrain';
import { TennisMatchEngine, createInitialMatchRenderState } from '../engine/TennisMatchEngine';
import { captureCourtJpeg } from './CourtFrameCapture';
import { PauseDashboard } from './PauseDashboard';
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
  const [recentShots, setRecentShots] = useState<RecordedShot[]>([]);
  const [imuConnected, setImuConnected] = useState(false);
  const [imuHz, setImuHz] = useState(0);
  const [lastSwingLabel, setLastSwingLabel] = useState<string | null>(null);
  const [showSidePanels, setShowSidePanels] = useState(true);

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
        },
        onShotRecorded: () => {
          setRecentShots([...engine.getShotHistory().slice(-12)]);
        },
        onPhaseChange: (nextPhase) => {
          setPhase(nextPhase);
          setScore({ ...engine.getRenderState().score });
        },
      },
    });
    engineRef.current = engine;

    // Wait in `ready` state until `connectAndSetup()` resolves so round 1 never fires before `ready`!
    const initialEpoch = ++matchEpochRef.current;
    engine.resetToReady();
    engine.syncToRenderState(matchStateRef.current);
    setPhase('ready');
    setScore({ ...engine.getRenderState().score });

    void agent.connectAndSetup().then(() => {
      if (cancelled || matchEpochRef.current !== initialEpoch) return;
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
      const wingText = evt.wing === 'backhand' ? 'Backhand' : 'Forehand';
      const pct = Math.round((evt.confidence ?? 0.85) * 100);
      setLastSwingLabel(`${wingText} ${evt.shotType} · ${pct}%`);
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'KeyP') {
        if (engine.getRenderState().phase === 'demo_pause') {
          engine.resumeFromDemoPause();
        } else {
          engine.triggerManualDemoPause();
        }
      } else if (
        (e.code === 'Enter' || e.code === 'Space') &&
        engine.getRenderState().phase === 'demo_pause'
      ) {
        e.preventDefault();
        engine.resumeFromDemoPause();
      }
    };
    window.addEventListener('keydown', onKeyDown);

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

      if (now - lastHudSyncMs >= 500) {
        lastHudSyncMs = now;
        setImuConnected(hw.imuConnected);
        setImuHz(hw.imuHz);
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
      window.removeEventListener('keydown', onKeyDown);
      unsubSwingStart();
      unsubSwing();
      agent.disconnect();
    };
  }, []);

  const handleResume = useCallback(() => {
    engineRef.current?.resumeFromDemoPause();
  }, []);

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
    setPhase('ready');
    setScore({ ...engine.getRenderState().score });

    void agent.startNewMatch().then(() => {
      if (matchEpochRef.current !== epoch) return;
      engine.startMatch();
      engine.syncToRenderState(matchStateRef.current);
      setPhase(engine.getRenderState().phase);
      setScore({ ...engine.getRenderState().score });
    });
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

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: showSidePanels ? '260px minmax(0, 1fr) 260px' : 'minmax(0, 1fr)',
        width: '100%',
        height: '100%',
        background: '#f8f9fa',
        overflow: 'hidden',
      }}
    >
      {/* Left slot: empty box when server is offline, filled by <npc-panel side="left"> when online */}
      <aside
        style={{
          display: showSidePanels ? 'block' : 'none',
          background: '#ffffff',
          borderRight: '1px solid #e3e3e3',
          minHeight: 0,
          overflowY: 'auto',
        }}
      >
        <npc-panel side="left" />
      </aside>

      {/* Middle widest column: top toolbar + completely uncovered 3D Gemini Arena court */}
      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          height: '100%',
          background: '#0d1829',
        }}
      >
        <PauseDashboard
          score={score}
          phase={phase}
          agentStatus={agentStatus}
          imuConnected={imuConnected}
          imuHz={imuHz}
          lastSwingLabel={lastSwingLabel}
          showSidePanels={showSidePanels}
          onToggleSidePanels={handleToggleSidePanels}
          onResume={handleResume}
          onRestart={handleRestart}
          onTogglePause={handleTogglePause}
        />
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <SceneSlot
            containerRef={sceneContainerRef}
            matchStateRef={matchStateRef}
            replayMode={phase === 'demo_pause'}
            replayArcs={recentShots}
            onCanvasClick={handleCanvasClick}
          />
        </div>
      </main>

      {/* Right slot: empty box when server is offline, filled by <npc-panel side="right"> when online */}
      <aside
        style={{
          display: showSidePanels ? 'block' : 'none',
          background: '#ffffff',
          borderLeft: '1px solid #e3e3e3',
          minHeight: 0,
          overflowY: 'auto',
        }}
      >
        <npc-panel side="right" />
      </aside>
    </div>
  );
};
