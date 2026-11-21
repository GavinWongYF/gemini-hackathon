// Complete Live Match Integration View
// Wires together:
//   - Ethan's M5 + Webcam `hardwareInput` (`getState`, `onSwingStart`, `onSwing`, `capturePlayerCamJpeg`)
//   - Ethan's pure-TS `TennisMatchEngine` + `OpponentBrain` (`pick()`)
//   - Felix & Gavin's `AgentClient` (`ws://localhost:8000/ws`, 1Hz `frames`, `event`, `round_end`)
//   - Akhil's `CourtScene` via `<SceneSlot>` (auto-upgrades to 3D the instant Akhil pushes `scene/` + `.glb`s!)

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentPlayerReadMessage,
  AgentStrategyUpdateMessage,
  MatchRenderState,
  RecordedShot,
} from '@shared/contracts';
import { hardwareInput } from '../hardware/HardwareInputManager';
import { AgentClient, type AgentConnectionStatus } from '../ai/AgentClient';
import { OpponentBrain } from '../ai/OpponentBrain';
import { TennisMatchEngine, createInitialMatchRenderState } from '../engine/TennisMatchEngine';
import { captureCourtJpeg } from './CourtFrameCapture';
import { PauseDashboard } from './PauseDashboard';
import { SceneSlot } from './SceneSlot';

export const LiveMatchView: React.FC = () => {
  const matchStateRef = useRef<MatchRenderState>(createInitialMatchRenderState(6));
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<TennisMatchEngine | null>(null);
  const agentRef = useRef<AgentClient | null>(null);

  const [phase, setPhase] = useState<MatchRenderState['phase']>('ready');
  const [score, setScore] = useState<MatchRenderState['score']>(matchStateRef.current.score);
  const [agentStatus, setAgentStatus] = useState<AgentConnectionStatus>('connecting');
  const [valueLabels, setValueLabels] = useState<Record<string, { label: string }>>({});
  const [latestRead, setLatestRead] = useState<AgentPlayerReadMessage | null>(null);
  const [latestUpdate, setLatestUpdate] = useState<AgentStrategyUpdateMessage | null>(null);
  const [recentShots, setRecentShots] = useState<RecordedShot[]>([]);
  const [lastRuleFired, setLastRuleFired] = useState<string | null>(null);

  useEffect(() => {
    hardwareInput.start();

    const brain = new OpponentBrain();
    const agent = new AgentClient({
      mode: 'live',
      callbacks: {
        onStatus: setAgentStatus,
        onReady: (msg) => {
          setValueLabels(msg.values);
          brain.applyReadyBehaviour(msg.behaviour);
        },
        onPlayerRead: (msg) => {
          setLatestRead(msg);
          brain.updatePlayerValues(msg.values);
        },
        onStrategyUpdate: (msg) => {
          setLatestUpdate(msg);
          setValueLabels((prev) => ({ ...prev, ...(msg.new_values ?? {}) }));
          brain.queueStrategyUpdate(msg);
        },
      },
    });
    agentRef.current = agent;

    const engine = new TennisMatchEngine(brain, {
      totalDemoPoints: 6,
      breakEvery: 2,
      enableDemoPauses: true,
      sink: {
        onAgentEvent: (evt) => {
          agent.sendEvent(evt);
          if (evt.by === 'opponent' && evt.by_rule && evt.by_rule.length > 0) {
            const ruleSummary = `${evt.by_rule.join(' + ')} → ${Object.values(evt.picked ?? {}).join(', ')}`;
            setLastRuleFired(ruleSummary);
          }
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

    // Start play immediately (uses default_behaviour until `ready` arrives or mock kicks in)
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

    // 60 FPS simulation loop + 1 Hz `frames` sender (`court` + `player_cam`)
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

      // Send ~1 Hz 384px JPEG `frames` (`court` + `player_cam`) during active rallies
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
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#0d1829' }}>
      <SceneSlot
        containerRef={sceneContainerRef}
        matchStateRef={matchStateRef}
        replayMode={phase === 'demo_pause'}
        replayArcs={recentShots}
        onCanvasClick={handleCanvasClick}
      />
      <PauseDashboard
        score={score}
        phase={phase}
        agentStatus={agentStatus}
        valueLabels={valueLabels}
        latestRead={latestRead}
        latestUpdate={latestUpdate}
        recentShots={recentShots}
        matchStateRef={matchStateRef}
        lastRuleFired={lastRuleFired}
        onResume={handleResume}
        onRestart={handleRestart}
        onTogglePause={handleTogglePause}
      />
    </div>
  );
};
