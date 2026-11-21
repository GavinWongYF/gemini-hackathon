// Broadcast HUD + Between-Point Demo Pause Dashboard
// Displays live score, hardware & agent status, running `player_read` habits,
// and the pause overlay (2D shot bounce heatmap, Neon observations, plan, rule/weight diff, and `checks`).

import React, { useEffect, useRef } from 'react';
import {
  COURT,
  type AgentPlayerReadMessage,
  type AgentStrategyUpdateMessage,
  type MatchRenderState,
  type RecordedShot,
} from '@shared/contracts';
import type { AgentConnectionStatus } from '../ai/AgentClient';
import { drawTacticalCourt } from './CourtFrameCapture';

export interface PauseDashboardProps {
  score: MatchRenderState['score'];
  phase: MatchRenderState['phase'];
  agentStatus: AgentConnectionStatus;
  valueLabels: Record<string, { label: string }>;
  latestRead: AgentPlayerReadMessage | null;
  latestUpdate: AgentStrategyUpdateMessage | null;
  recentShots: RecordedShot[];
  matchStateRef: React.MutableRefObject<MatchRenderState>;
  lastRuleFired: string | null;
  onResume: () => void;
  onRestart: () => void;
  onTogglePause: () => void;
}

export const PauseDashboard: React.FC<PauseDashboardProps> = ({
  score,
  phase,
  agentStatus,
  valueLabels,
  latestRead,
  latestUpdate,
  recentShots,
  matchStateRef,
  lastRuleFired,
  onResume,
  onRestart,
  onTogglePause,
}) => {
  const heatmapRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (phase !== 'demo_pause' && phase !== 'match_over') return;
    const canvas = heatmapRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawTacticalCourt(ctx, canvas.width, canvas.height, matchStateRef.current, recentShots);

    // Overlay bounce heatmap glow circles
    const padX = canvas.width * 0.2;
    const padY = canvas.height * 0.08;
    const courtW = canvas.width - padX * 2;
    const courtH = canvas.height - padY * 2;
    const toX = (x: number) => canvas.width * 0.5 + (x / COURT.PAINTED_HALF_W) * (courtW * 0.5);
    const toY = (z: number) => canvas.height * 0.5 + (z / COURT.BASELINE_Z) * (courtH * 0.5);

    for (const shot of recentShots) {
      if (!shot.bouncePos) continue;
      const bx = toX(shot.bouncePos.x);
      const by = toY(shot.bouncePos.z);
      const grad = ctx.createRadialGradient(bx, by, 2, bx, by, 18);
      if (shot.actor === 'human') {
        grad.addColorStop(0, 'rgba(56, 189, 248, 0.75)');
        grad.addColorStop(1, 'rgba(56, 189, 248, 0)');
      } else {
        grad.addColorStop(0, 'rgba(251, 113, 133, 0.75)');
        grad.addColorStop(1, 'rgba(251, 113, 133, 0)');
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(bx, by, 18, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [phase, recentShots, matchStateRef]);

  const statusBadgeColor =
    agentStatus === 'connected'
      ? '#22c55e'
      : agentStatus === 'connecting'
        ? '#f59e0b'
        : '#a855f7';

  const topHabits = latestRead
    ? Object.entries(latestRead.values)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
    : [];

  return (
    <>
      {/* Top Broadcast Scoreboard Pill */}
      <div
        style={{
          position: 'absolute',
          top: 14,
          left: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: 'rgba(15, 23, 42, 0.86)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(148, 163, 184, 0.22)',
          borderRadius: 12,
          padding: '8px 14px',
          color: '#f8fafc',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          zIndex: 20,
        }}
      >
        <div>
          <div style={{ fontSize: 10, color: '#94a3b8', letterSpacing: 0.8, textTransform: 'uppercase' }}>
            Point {Math.min(score.pointIndex, score.totalDemoPoints)} / {score.totalDemoPoints}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            <span style={{ color: '#38bdf8' }}>YOU {score.humanPoints}</span>
            <span style={{ margin: '0 8px', color: '#64748b' }}>—</span>
            <span style={{ color: '#fb7185' }}>{score.aiPoints} AI</span>
          </div>
        </div>
        <div
          style={{
            padding: '3px 9px',
            borderRadius: 999,
            background: 'rgba(30, 41, 59, 0.9)',
            fontSize: 12,
            fontWeight: 600,
            color: '#fde047',
          }}
        >
          {score.lastCall}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: '#cbd5e1',
            borderLeft: '1px solid rgba(148,163,184,0.2)',
            paddingLeft: 10,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: statusBadgeColor,
              display: 'inline-block',
            }}
          />
          {agentStatus === 'connected'
            ? 'Gemini Agents LIVE'
            : agentStatus === 'connecting'
              ? 'Connecting ws://localhost:8000/ws...'
              : 'Offline Mock AI'}
          {latestUpdate ? ` • v${latestUpdate.version}` : ''}
        </div>
        <button
          onClick={onTogglePause}
          style={{
            background: 'rgba(51, 65, 85, 0.85)',
            color: '#e2e8f0',
            border: '1px solid rgba(148,163,184,0.3)',
            borderRadius: 6,
            padding: '4px 9px',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Pause (P)
        </button>
      </div>

      {/* Live Compact `player_read` Habit Sparkbars (Top Right) */}
      {topHabits.length > 0 && phase !== 'demo_pause' && phase !== 'match_over' && (
        <div
          style={{
            position: 'absolute',
            top: 56,
            right: 16,
            width: 240,
            background: 'rgba(15, 23, 42, 0.8)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(148, 163, 184, 0.2)',
            borderRadius: 10,
            padding: '8px 11px',
            color: '#e2e8f0',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: 11,
            zIndex: 20,
          }}
        >
          <div style={{ fontWeight: 700, color: '#94a3b8', marginBottom: 5, fontSize: 10, textTransform: 'uppercase' }}>
            Live Player Read (Decision 1)
          </div>
          {topHabits.map(([key, val]) => (
            <div key={key} style={{ marginBottom: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                <span style={{ color: '#cbd5e1' }}>{valueLabels[key]?.label ?? key}</span>
                <span style={{ color: '#38bdf8', fontWeight: 600 }}>{Math.round(val * 100)}%</span>
              </div>
              <div style={{ height: 4, background: '#1e293b', borderRadius: 2, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${Math.round(val * 100)}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #38bdf8, #818cf8)',
                  }}
                />
              </div>
            </div>
          ))}
          {latestRead?.why && (
            <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 4 }}>{latestRead.why}</div>
          )}
        </div>
      )}

      {/* Subtle Rule-Fired Toast */}
      {lastRuleFired && phase === 'rally' && (
        <div
          style={{
            position: 'absolute',
            bottom: 18,
            left: 16,
            background: 'rgba(88, 28, 135, 0.88)',
            border: '1px solid rgba(192, 132, 252, 0.5)',
            color: '#f3e8ff',
            padding: '6px 12px',
            borderRadius: 8,
            fontSize: 12,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            zIndex: 20,
          }}
        >
          ⚡ Rule Fired: {lastRuleFired}
        </div>
      )}

      {/* Between-Round Demo Pause / Match Summary Overlay */}
      {(phase === 'demo_pause' || phase === 'match_over') && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(2, 6, 23, 0.76)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            zIndex: 30,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            color: '#f8fafc',
          }}
        >
          <div
            style={{
              maxWidth: 920,
              width: '100%',
              background: '#0f172a',
              border: '1px solid rgba(148, 163, 184, 0.25)',
              borderRadius: 16,
              padding: 22,
              display: 'grid',
              gridTemplateColumns: '300px 1fr',
              gap: 20,
              boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
            }}
          >
            {/* Left: Court Shot Trajectory & Bounce Heatmap */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', marginBottom: 8 }}>
                Shot Heatmap & Trajectories
              </div>
              <canvas
                ref={heatmapRef}
                width={300}
                height={240}
                style={{
                  width: '100%',
                  borderRadius: 10,
                  border: '1px solid rgba(148,163,184,0.2)',
                  display: 'block',
                }}
              />
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
                <span>🔵 Your Shots</span>
                <span>🔴 AI Opponent</span>
              </div>
            </div>

            {/* Right: Gemini Observations, Strategy Plan & Rule Diffs */}
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <h2 style={{ margin: 0, fontSize: 20 }}>
                    {phase === 'match_over' ? 'Match Complete' : 'Adaptive AI Strategy Update'}
                  </h2>
                  {latestUpdate && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: '3px 9px',
                        borderRadius: 999,
                        background: 'rgba(56,189,248,0.16)',
                        color: '#38bdf8',
                        fontWeight: 600,
                      }}
                    >
                      Strategy v{latestUpdate.version} ({latestUpdate.source})
                    </span>
                  )}
                </div>

                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', marginBottom: 4 }}>
                    What Gemini Observed
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#e2e8f0', lineHeight: 1.5 }}>
                    {(latestUpdate?.observations ?? [
                      latestRead?.why ?? 'Gathering initial shot patterns from live rallies...',
                    ]).map((obs, idx) => (
                      <li key={idx}>{obs}</li>
                    ))}
                  </ul>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#fb7185', textTransform: 'uppercase', marginBottom: 4 }}>
                    Opponent Adaptation Plan
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#e2e8f0', lineHeight: 1.5 }}>
                    {(latestUpdate?.plan ?? [' Holding baseline default behaviour until next rewrite lands.']).map(
                      (item, idx) => (
                        <li key={idx}>{item}</li>
                      ),
                    )}
                  </ul>
                </div>

                {latestUpdate && latestUpdate.changes.length > 0 && (
                  <div
                    style={{
                      background: '#1e293b',
                      borderRadius: 10,
                      padding: '8px 12px',
                      fontSize: 12,
                      color: '#cbd5e1',
                    }}
                  >
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#fde047', textTransform: 'uppercase', marginBottom: 4 }}>
                      Installed Behaviour Diff (vs. Unchanged Baseline)
                    </div>
                    {latestUpdate.changes.slice(0, 3).map((ch, idx) => (
                      <div key={idx} style={{ marginBottom: 4 }}>
                        <code style={{ color: '#93c5fd' }}>{ch.where}</code>: {ch.why}
                        {ch.expect ? <span style={{ color: '#86efac' }}> → Expect: {ch.expect}</span> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                {phase === 'demo_pause' ? (
                  <button
                    onClick={onResume}
                    style={{
                      background: '#2563eb',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      padding: '9px 18px',
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Next Point (Space / Enter) →
                  </button>
                ) : (
                  <button
                    onClick={onRestart}
                    style={{
                      background: '#16a34a',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      padding: '9px 18px',
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Play Again
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
