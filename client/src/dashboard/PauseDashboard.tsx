// Clean Google-style top match toolbar seated ABOVE Akhil's 3D court (never drawn over the court).

import React from 'react';
import type { MatchRenderState } from '@shared/contracts';
import type { AgentConnectionStatus } from '../ai/AgentClient';

export interface CourtToolbarProps {
  score: MatchRenderState['score'];
  phase: MatchRenderState['phase'];
  agentStatus: AgentConnectionStatus;
  imuConnected: boolean;
  imuHz: number;
  lastSwingLabel: string | null;
  showSidePanels: boolean;
  onToggleSidePanels: () => void;
  onResume: () => void;
  onRestart: () => void;
  onTogglePause: () => void;
}

function formatCallLabel(raw: string): string {
  const clean = raw.replace(/—/g, '·').trim();
  if (!clean || clean === 'READY') return 'Ready';
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

export const PauseDashboard: React.FC<CourtToolbarProps> = ({
  score,
  phase,
  agentStatus,
  imuConnected,
  imuHz,
  lastSwingLabel,
  showSidePanels,
  onToggleSidePanels,
  onResume,
  onRestart,
  onTogglePause,
}) => {
  const statusDot =
    agentStatus === 'connected'
      ? '#188038'
      : agentStatus === 'connecting'
        ? '#e37400'
        : '#80868b';

  const statusText =
    agentStatus === 'connected'
      ? 'AI Connected'
      : agentStatus === 'connecting'
        ? 'AI Connecting'
        : 'AI Local';

  return (
    <div
      style={{
        height: 44,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        background: '#ffffff',
        borderBottom: '1px solid #e3e3e3',
        color: '#1f1f1f',
        fontSize: 13,
        gap: 12,
      }}
    >
      {/* Left: Score & Point Status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>
          <span>Player {score.humanPoints}</span>
          <span style={{ color: '#9aa0a6', fontWeight: 400 }}>–</span>
          <span>{score.aiPoints} Opponent</span>
        </div>

        <span style={{ width: 1, height: 14, background: '#dadce0', flexShrink: 0 }} />

        <span style={{ color: '#5f6368', whiteSpace: 'nowrap' }}>
          Point {Math.min(score.pointIndex, score.totalDemoPoints)} of {score.totalDemoPoints}
        </span>

        <span
          style={{
            padding: '2px 10px',
            borderRadius: 999,
            background: '#f1f3f4',
            color: '#3c4043',
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
        >
          {formatCallLabel(score.lastCall)}
        </span>

        {lastSwingLabel && (
          <span
            style={{
              padding: '2px 10px',
              borderRadius: 999,
              background: '#e8f0fe',
              color: '#0b57d0',
              fontSize: 12,
              fontWeight: 500,
              whiteSpace: 'nowrap',
            }}
          >
            {lastSwingLabel}
          </span>
        )}
      </div>

      {/* Right: Sensor/AI Status & Clean Action Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#5f6368' }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: imuConnected ? '#188038' : '#dadce0',
              display: 'inline-block',
            }}
          />
          {imuConnected ? `M5 ${imuHz}Hz` : 'Space / Click'}
        </span>

        <span style={{ width: 1, height: 14, background: '#dadce0' }} />

        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#5f6368' }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: statusDot,
              display: 'inline-block',
            }}
          />
          {statusText}
        </span>

        <button
          type="button"
          onClick={onToggleSidePanels}
          style={{
            background: '#f1f3f4',
            color: '#3c4043',
            border: 'none',
            borderRadius: 999,
            padding: '5px 12px',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          {showSidePanels ? 'Full court' : 'Side panels'}
        </button>

        {phase === 'demo_pause' ? (
          <button
            type="button"
            onClick={onResume}
            style={{
              background: '#0b57d0',
              color: '#ffffff',
              border: 'none',
              borderRadius: 999,
              padding: '6px 16px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Next point
          </button>
        ) : phase === 'match_over' ? (
          <button
            type="button"
            onClick={onRestart}
            style={{
              background: '#0b57d0',
              color: '#ffffff',
              border: 'none',
              borderRadius: 999,
              padding: '6px 16px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            New match
          </button>
        ) : (
          <button
            type="button"
            onClick={onTogglePause}
            style={{
              background: '#f1f3f4',
              color: '#1f1f1f',
              border: 'none',
              borderRadius: 999,
              padding: '6px 14px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Replay
          </button>
        )}
      </div>
    </div>
  );
};
