// Three-Column Live Match View (Notion Section 9 @ 1:20 PM)
//   - Left narrow box:   `<npc-panel side="left" />` (stays empty when :8000 is not running)
//   - Middle wide box:   Uncovered court (`<SceneSlot />`), with on-court trajectories & heat map during pause
//   - Right narrow box:  `<npc-panel side="right" />` (stays empty when :8000 is not running)

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchRenderState, RecordedShot } from '@shared/contracts';
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
  const matchStateRef = useRef<MatchRenderState>(createInitialMatchRenderState(6));
  const sceneContainerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TennisMatchEngine | null>(null);

  const [phase, setPhase] = useState<MatchRenderState['phase']>('ready');
  const [score, setScore] = useState<MatchRenderState['score']>(matchStateRef.current.score);
  const [agentStatus, setAgentStatus] = useState<AgentConnectionStatus>('connecting');
  const [recentShots, setRecentShots] = useState<RecordedShot[]>([]);

  useEffect(() => {
    hardwareInput.start();

    const brain = new OpponentBrain();
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

    const engine = new TennisMatchEngine(brain, {
      totalDemoPoints: 6,
      breakEvery: 2,
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

    engine.startMatch();
    engine.syncToRenderState(matchStateRef.current);
    setPhase(engine.getRenderState().phase);
    setScore({ ...engine.getRenderState().score });
    void agent.connectAndSetup();

    const unsubSwingStart = hardwareInput.onSwingStart((evt) => {
      engine.handlePlayerSwingStart(evt);
    });
    const unsubSwing = hardwareInput.onSwing((evt) => {
      engine.handlePlayerSwing(evt);
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
    let rafId = 0;

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      engine.applyPlayerControl(hardwareInput.getState());
      engine.step(dt);
      engine.syncToRenderState(matchStateRef.current);

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
    engineRef.current?.startMatch();
    if (engineRef.current) {
      setScore({ ...engineRef.current.getRenderState().score });
      setPhase(engineRef.current.getRenderState().phase);
    }
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

  const handleCanvasClick = useCallback(() => {
    if (engineRef.current?.getRenderState().phase === 'demo_pause') {
      engineRef.current.resumeFromDemoPause();
    } else {
      hardwareInput.triggerManualSwing();
    }
  }, []);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '280px minmax(0, 1fr) 280px',
        width: '100%',
        height: '100%',
        background: '#f8f9fa',
        overflow: 'hidden',
      }}
    >
      {/* Left slot: empty box when server is offline, filled by <npc-panel side="left"> when online */}
      <aside
        style={{
          background: '#ffffff',
          borderRight: '1px solid #e3e3e3',
          minHeight: 0,
          overflowY: 'auto',
        }}
      >
        <npc-panel side="left" />
      </aside>

      {/* Middle widest column: top toolbar + completely uncovered court */}
      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          height: '100%',
          background: '#e8eef5',
        }}
      >
        <PauseDashboard
          score={score}
          phase={phase}
          agentStatus={agentStatus}
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
