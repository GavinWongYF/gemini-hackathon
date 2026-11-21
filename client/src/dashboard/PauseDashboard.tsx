// Minimal Top-Edge Broadcast HUD + Non-Covering Bottom Action Pill
// Per Notion Section 9 (1:14 PM) & Akhil's 3D `CourtScene`:
// NEVER covers the middle court during play or pause — Akhil's `BroadcastCamera` orbits
// and `TennisBallAndTrajectories` renders 3D shot arcs & bounce heatmap directly on the court!

import React from 'react';
import type { MatchRenderState } from '@shared/contracts';
import type { AgentConnectionStatus } from '../ai/AgentClient';

export interface CourtHudProps {
  score: MatchRenderState['score'];
  phase: MatchRenderState['phase'];
  agentStatus: AgentConnectionStatus;
  strategyVersion: number | null;
  lastRuleFired: string | null;
  onResume: () => void;
  onRestart: () => void;
  onTogglePause: () => void;
}

export const PauseDashboard: React.FC<CourtHudProps> = ({
  score,
  phase,
  agentStatus,
  strategyVersion,
  lastRuleFired,
  onResume,
  onRestart,
  onTogglePause,
}) => {
  const statusColor =
    agentStatus === 'connected'
      ? '#22c55e'
      : agentStatus === 'connecting'
        ? '#f59e0b'
        : '#a855f7';

  return (
    <>
      {/* Compact Top-Left Score + Connection Pill (never covers the court) */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'rgba(15, 23, 42, 0.82)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(148, 163, 184, 0.2)',
          borderRadius: 10,
          padding: '6px 12px',
          color: '#f8fafc',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          zIndex: 20,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700 }}>
          <span style={{ color: '#38bdf8' }}>YOU {score.humanPoints}</span>
          <span style={{ margin: '0 6px', color: '#64748b' }}>:</span>
          <span style={{ color: '#fb7185' }}>{score.aiPoints} AI</span>
        </div>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          Pt {Math.min(score.pointIndex, score.totalDemoPoints)}/{score.totalDemoPoints}
        </span>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            background: 'rgba(30, 41, 59, 0.9)',
            fontSize: 11,
            fontWeight: 600,
            color: '#fde047',
          }}
        >
          {score.lastCall}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#cbd5e1' }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: statusColor,
              display: 'inline-block',
            }}
          />
          {agentStatus === 'connected' ? 'LIVE' : agentStatus === 'connecting' ? 'SYNC' : 'MOCK'}
          {strategyVersion !== null ? ` v${strategyVersion}` : ''}
        </span>
        <button
          onClick={onTogglePause}
          style={{
            background: 'rgba(51, 65, 85, 0.85)',
            color: '#e2e8f0',
            border: '1px solid rgba(148,163,184,0.28)',
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {phase === 'demo_pause' ? 'Resume (P)' : 'Replay (P)'}
        </button>
      </div>

      {/* Subtle Bottom-Left Rule Fired Pill */}
      {lastRuleFired && phase === 'rally' && (
        <div
          style={{
            position: 'absolute',
            bottom: 14,
            left: 14,
            background: 'rgba(88, 28, 135, 0.85)',
            border: '1px solid rgba(192, 132, 252, 0.45)',
            color: '#f3e8ff',
            padding: '5px 10px',
            borderRadius: 8,
            fontSize: 11,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            zIndex: 20,
            pointerEvents: 'none',
          }}
        >
          ⚡ {lastRuleFired}
        </div>
      )}

      {/* Non-Covering Bottom-Center Bar During On-Court Trajectory/Heatmap Replay */}
      {(phase === 'demo_pause' || phase === 'match_over') && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'rgba(15, 23, 42, 0.88)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(148, 163, 184, 0.28)',
            borderRadius: 999,
            padding: '7px 16px',
            color: '#f8fafc',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: 12,
            zIndex: 25,
          }}
        >
          <span style={{ color: '#cbd5e1' }}>
            {phase === 'match_over'
              ? `Match Finished (${score.humanPoints}–${score.aiPoints})`
              : '3D Trajectory & Bounce Replay on Court'}
          </span>
          {phase === 'demo_pause' ? (
            <button
              onClick={onResume}
              style={{
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 999,
                padding: '5px 14px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Next Point (Space) →
            </button>
          ) : (
            <button
              onClick={onRestart}
              style={{
                background: '#16a34a',
                color: '#fff',
                border: 'none',
                borderRadius: 999,
                padding: '5px 14px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Play Again
            </button>
          )}
        </div>
      )}
    </>
  );
};
