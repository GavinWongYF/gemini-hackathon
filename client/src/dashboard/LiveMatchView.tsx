// Three-Column Live Match View (aligned to Notion Section 9 @ 1:20 PM + Akhil's 3D CourtScene)
//   - Left narrow slot:  `<npc-panel side="left">` (Decisions API short loop from :8000/screen/panels.js,
//                        with clean offline fallback when backend isn't running)
//   - Middle wide slot:  `<SceneSlot>` (Akhil's 3D `CourtScene` — NEVER covered by a modal;
//                        3D trajectories & bounce heatmap render directly on the court!)
//   - Right narrow slot: `<npc-panel side="right">` (Neon longer loop: Noticed / Plan / Checks)

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
  const agentRef = useRef<AgentClient | null>(null);

  const [phase, setPhase] = useState<MatchRenderState['phase']>('ready');
  const [score, setScore] = useState<MatchRenderState['score']>(matchStateRef.current.score);
  const [agentStatus, setAgentStatus] = useState<AgentConnectionStatus>('connecting');
  const [valueLabels, setValueLabels] = useState<Record<string, { label: string }>>({});
  const [latestRead, setLatestRead] = useState<AgentPlayerReadMessage | null>(null);
  const [latestUpdate, setLatestUpdate] = useState<AgentStrategyUpdateMessage | null>(null);
  const [recentShots, setRecentShots] = useState<RecordedShot[]>([]);
  const [lastRuleFired, setLastRuleFired] = useState<string | null>(null);
  const [customPanelsLoaded, setCustomPanelsLoaded] = useState<boolean>(
    () => typeof customElements !== 'undefined' && Boolean(customElements.get('npc-panel')),
  );

  useEffect(() => {
    if (typeof customElements !== 'undefined' && !customElements.get('npc-panel')) {
      void customElements.whenDefined('npc-panel').then(() => setCustomPanelsLoaded(true));
    }
  }, []);

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

  const topHabits = latestRead
    ? Object.entries(latestRead.values)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
    : [];
  const latestCheck = latestUpdate?.checks?.[0];
  const speedAdjust =
    typeof latestUpdate?.settings?.opponent_speed === 'number'
      ? latestUpdate.settings.opponent_speed
      : null;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '250px minmax(0, 1fr) 260px',
        width: '100%',
        height: '100%',
        background: '#090d16',
        color: '#e2e8f0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        overflow: 'hidden',
      }}
    >
      {/* Left Narrow Slot: Felix & Gavin's `<npc-panel side="left">` */}
      <aside
        style={{
          borderRight: '1px solid rgba(148,163,184,0.16)',
          padding: 14,
          overflowY: 'auto',
          background: '#0b1120',
        }}
      >
        <npc-panel side="left" />
        {!customPanelsLoaded && agentStatus !== 'connected' && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', marginBottom: 10 }}>
              Player Read
            </div>
            {topHabits.map(([key, val]) => (
              <div key={key} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: '#e2e8f0', marginBottom: 4 }}>
                  {valueLabels[key]?.label ?? key}
                </div>
                <div style={{ height: 5, background: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.round(val * 100)}%`,
                      height: '100%',
                      background: '#38bdf8',
                    }}
                  />
                </div>
              </div>
            ))}
            {latestRead?.why && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 12, lineHeight: 1.4 }}>
                {latestRead.why}
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Middle Wide Slot: Akhil's 3D Court (NEVER covered by a modal!) */}
      <main style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
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
          strategyVersion={latestUpdate?.version ?? null}
          lastRuleFired={lastRuleFired}
          onResume={handleResume}
          onRestart={handleRestart}
          onTogglePause={handleTogglePause}
        />
      </main>

      {/* Right Narrow Slot: Felix & Gavin's `<npc-panel side="right">` */}
      <aside
        style={{
          borderLeft: '1px solid rgba(148,163,184,0.16)',
          padding: 14,
          overflowY: 'auto',
          background: '#0b1120',
        }}
      >
        <npc-panel side="right" />
        {!customPanelsLoaded && agentStatus !== 'connected' && latestUpdate && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', marginBottom: 6 }}>
                Noticed
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.45 }}>
                {latestUpdate.observations.slice(0, 2).map((line, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{line}</li>
                ))}
              </ul>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#fb7185', textTransform: 'uppercase', marginBottom: 6 }}>
                Plan
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.45 }}>
                {latestUpdate.plan.slice(0, 2).map((line, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{line}</li>
                ))}
              </ul>
            </div>
            {latestCheck && (
              <div style={{ fontSize: 12, color: latestCheck.held ? '#86efac' : '#fca5a5' }}>
                Said &ldquo;{latestCheck.said}&rdquo; — {latestCheck.held ? 'held' : "didn't hold"}
              </div>
            )}
            {speedAdjust !== null && (
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                Fairness pace: {speedAdjust.toFixed(2)}×
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
};
