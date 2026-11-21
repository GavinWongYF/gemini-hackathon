// Frontier AI Lab Match Scoreboard & Round Control Bar.
// Seated cleanly ABOVE the 3D court viewport — nothing ever covers the court.

import React from 'react';
import type { MatchRenderState } from '@shared/contracts';

export type PointWinnerRecord = 'player' | 'opponent';

export interface CourtToolbarProps {
  score: MatchRenderState['score'];
  phase: MatchRenderState['phase'];
  breakEvery: number;
  pointWinners: PointWinnerRecord[];
  rallyShotCount: number;
  onResume: () => void;
  onRestart: () => void;
  onTogglePause: () => void;
  onForceStart?: () => void;
  showPausedArcs?: boolean;
  onTogglePausedArcs?: () => void;
}

const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

function formatCallBadge(phase: MatchRenderState['phase'], rawCall: string, rallyShots: number): {
  text: string;
  tone: 'neutral' | 'live' | 'pause' | 'accent';
} {
  if (phase === 'ready') {
    return { text: 'AWAITING READY', tone: 'neutral' };
  }
  if (phase === 'demo_pause') {
    return { text: 'STRATEGY PAUSE', tone: 'pause' };
  }
  if (phase === 'match_over') {
    return { text: 'EVALUATION COMPLETE', tone: 'accent' };
  }
  if (phase === 'serving') {
    return { text: `ROUND ${rawCall.replace(/[^0-9]/g, '') || '1'} · SERVE`, tone: 'live' };
  }
  if (phase === 'rally') {
    return {
      text: rallyShots > 0 ? `LIVE RALLY · ${rallyShots} ${rallyShots === 1 ? 'STROKE' : 'STROKES'}` : 'LIVE RALLY',
      tone: 'live',
    };
  }
  const cleaned = rawCall.replace(/—/g, '·').replace(/!/g, '').trim();
  return { text: cleaned || 'POINT OVER', tone: 'neutral' };
}

const KeyHint: React.FC<{ label: string; dark?: boolean }> = ({ label, dark }) => (
  <kbd
    style={{
      fontFamily: MONO,
      fontSize: 10,
      fontWeight: 500,
      lineHeight: 1,
      padding: '2px 5px',
      borderRadius: 4,
      background: dark ? 'rgba(255,255,255,0.16)' : '#ffffff',
      color: dark ? 'rgba(255,255,255,0.88)' : '#71717a',
      border: dark ? '1px solid rgba(255,255,255,0.2)' : '1px solid #deddd8',
    }}
  >
    {label}
  </kbd>
);

export const PauseDashboard: React.FC<CourtToolbarProps> = ({
  score,
  phase,
  breakEvery,
  pointWinners,
  rallyShotCount,
  onResume,
  onRestart,
  onTogglePause,
  onForceStart,
  showPausedArcs = true,
  onTogglePausedArcs,
}) => {
  const badge = formatCallBadge(phase, score.lastCall, rallyShotCount);

  const badgeStyles: Record<typeof badge.tone, { bg: string; fg: string; border: string; dot?: string }> = {
    neutral: { bg: '#f4f4f1', fg: '#575652', border: '#e5e4df' },
    live: { bg: '#ecfdf5', fg: '#065f46', border: '#a7f3d0', dot: '#059669' },
    pause: { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe', dot: '#2563eb' },
    accent: { bg: '#141413', fg: '#ffffff', border: '#141413' },
  };
  const bs = badgeStyles[badge.tone];

  const hasPointCap = Number.isFinite(score.totalDemoPoints) && score.totalDemoPoints > 0;
  const totalRounds = hasPointCap ? score.totalDemoPoints : 0;
  const activePointIdx = hasPointCap ? Math.min(score.pointIndex, totalRounds) : score.pointIndex;
  const visibleHistory = hasPointCap ? pointWinners : pointWinners.slice(-12);

  return (
    <div
      style={{
        height: 48,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 14px',
        background: '#ffffff',
        borderBottom: '1px solid #e5e4df',
        gap: 12,
      }}
    >
      {/* Left: Tabular Broadcast Scoreboard */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 2,
              background: '#2563eb',
              display: 'inline-block',
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.03em',
              color: '#141413',
            }}
          >
            PLAYER
          </span>
          <span
            style={{
              fontFamily: MONO,
              fontVariantNumeric: 'tabular-nums',
              fontSize: 14,
              fontWeight: 600,
              minWidth: 26,
              height: 24,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 5,
              background: '#f4f4f1',
              border: '1px solid #e5e4df',
              color: '#141413',
            }}
          >
            {score.humanPoints}
          </span>

          <span style={{ fontFamily: MONO, fontSize: 12, color: '#a1a1aa' }}>:</span>

          <span
            style={{
              fontFamily: MONO,
              fontVariantNumeric: 'tabular-nums',
              fontSize: 14,
              fontWeight: 600,
              minWidth: 26,
              height: 24,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 5,
              background: '#f4f4f1',
              border: '1px solid #e5e4df',
              color: '#141413',
            }}
          >
            {score.aiPoints}
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.03em',
              color: '#141413',
            }}
          >
            OPPONENT
          </span>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 2,
              background: '#f97316',
              display: 'inline-block',
            }}
          />
        </div>

        <span style={{ width: 1, height: 16, background: '#e5e4df', flexShrink: 0 }} />

        {/* Point Counter + Rolling Pip Timeline */}
        <div
          title={
            hasPointCap
              ? `Round ${activePointIdx} of ${totalRounds}`
              : `Open-ended live session · Point ${activePointIdx} (press P anytime for 3D replay)`
          }
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: '0.05em',
              color: '#8c8b85',
              marginRight: 3,
            }}
          >
            {hasPointCap ? `PT ${activePointIdx}/${totalRounds}` : `PT ${activePointIdx}`}
          </span>
          {hasPointCap ? (
            Array.from({ length: totalRounds }, (_, i) => {
              const winner = visibleHistory[i];
              const isCurrent = i + 1 === score.pointIndex && phase !== 'match_over';
              const isBreakAfter = breakEvery > 0 && (i + 1) % breakEvery === 0 && i + 1 < totalRounds;
              const bg =
                winner === 'player'
                  ? '#2563eb'
                  : winner === 'opponent'
                    ? '#f97316'
                    : isCurrent
                      ? '#141413'
                      : '#e5e4df';

              return (
                <React.Fragment key={i}>
                  <span
                    style={{
                      width: 14,
                      height: 6,
                      borderRadius: 2,
                      background: bg,
                      opacity: winner ? 1 : isCurrent ? 0.85 : 0.75,
                      transition: 'background-color 160ms ease',
                    }}
                  />
                  {isBreakAfter && (
                    <span
                      style={{
                        width: 1,
                        height: 10,
                        background: '#c8c7c0',
                        margin: '0 2px',
                      }}
                    />
                  )}
                </React.Fragment>
              );
            })
          ) : (
            <>
              {visibleHistory.map((winner, idx) => (
                <span
                  key={idx}
                  style={{
                    width: 11,
                    height: 6,
                    borderRadius: 2,
                    background: winner === 'player' ? '#2563eb' : '#f97316',
                  }}
                />
              ))}
              {phase !== 'match_over' && (
                <span
                  style={{
                    width: 11,
                    height: 6,
                    borderRadius: 2,
                    background: '#141413',
                    opacity: 0.85,
                  }}
                />
              )}
            </>
          )}
        </div>

        {/* Live Phase / Call Chip */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 9px',
            borderRadius: 5,
            background: bs.bg,
            color: bs.fg,
            border: `1px solid ${bs.border}`,
            fontFamily: MONO,
            fontSize: 10.5,
            fontWeight: 500,
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
          }}
        >
          {bs.dot && (
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: bs.dot,
                display: 'inline-block',
              }}
            />
          )}
          {badge.text}
        </span>
      </div>

      {/* Right: Crisp Studio Action Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {phase === 'ready' && onForceStart ? (
          <>
            <button
              type="button"
              className="lab-btn"
              onClick={onForceStart}
              title="Start match immediately without waiting for :8000 ready (SPACE)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                background: '#141413',
                color: '#ffffff',
                border: '1px solid #141413',
                borderRadius: 6,
                padding: '5px 12px',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              <span>Start now</span>
              <KeyHint label="SPACE" dark />
            </button>
            <button
              type="button"
              className="lab-btn"
              onClick={onRestart}
              title="Restart match from 0:0 with a fresh match_id (Shift+R)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: '#fafaf8',
                color: '#141413',
                border: '1px solid #e5e4df',
                borderRadius: 6,
                padding: '5px 10px',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2.2 4.5A4.2 4.2 0 1 1 2.5 8.3" />
                <polyline points="2,1.8 2,4.7 4.9,4.7" />
              </svg>
              <span>Restart</span>
              <KeyHint label="⇧R" />
            </button>
          </>
        ) : phase === 'demo_pause' ? (
          <>
            <button
              type="button"
              className="lab-btn"
              onClick={onResume}
              title="Resume game (P or SPACE)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: '#059669',
                color: '#ffffff',
                border: '1px solid #047857',
                borderRadius: 6,
                padding: '5px 12px',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
                <polygon points="2,1 9,5 2,9" />
              </svg>
              <span>Continue</span>
              <KeyHint label="ENTER" dark />
            </button>
            {onTogglePausedArcs && (
              <button
                type="button"
                className="lab-btn"
                onClick={onTogglePausedArcs}
                title="Toggle 3D shot arc replay overlay while paused"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  background: showPausedArcs ? '#eff6ff' : '#fafaf8',
                  color: showPausedArcs ? '#1d4ed8' : '#575652',
                  border: `1px solid ${showPausedArcs ? '#bfdbfe' : '#e5e4df'}`,
                  borderRadius: 6,
                  padding: '5px 9px',
                  fontSize: 11.5,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <span>{showPausedArcs ? '3D Arcs: ON' : '3D Arcs: OFF'}</span>
              </button>
            )}
            <button
              type="button"
              className="lab-btn"
              onClick={onRestart}
              title="Restart match from 0:0 with a fresh match_id (Shift+R)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: '#fafaf8',
                color: '#141413',
                border: '1px solid #e5e4df',
                borderRadius: 6,
                padding: '5px 10px',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2.2 4.5A4.2 4.2 0 1 1 2.5 8.3" />
                <polyline points="2,1.8 2,4.7 4.9,4.7" />
              </svg>
            </button>
          </>
        ) : phase === 'match_over' ? (
          <button
            type="button"
            className="lab-btn"
            onClick={onRestart}
            title="Restart match from 0:0 with a fresh match_id (R or Shift+R)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background: '#141413',
              color: '#ffffff',
              border: '1px solid #141413',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2.2 4.5A4.2 4.2 0 1 1 2.5 8.3" />
              <polyline points="2,1.8 2,4.7 4.9,4.7" />
            </svg>
            <span>Restart</span>
            <KeyHint label="R" dark />
          </button>
        ) : (
          <>
            <button
              type="button"
              className="lab-btn"
              onClick={onTogglePause}
              disabled={phase === 'ready'}
              title="Pause the match anytime (P)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: '#fafaf8',
                color: phase === 'ready' ? '#a1a1aa' : '#141413',
                border: '1px solid #e5e4df',
                borderRadius: 6,
                padding: '5px 10px',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'inherit',
                cursor: phase === 'ready' ? 'default' : 'pointer',
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
                <rect x="1.5" y="1" width="2.5" height="8" rx="0.6" />
                <rect x="6" y="1" width="2.5" height="8" rx="0.6" />
              </svg>
              <span>Pause</span>
              <KeyHint label="P" />
            </button>
            <button
              type="button"
              className="lab-btn"
              onClick={onRestart}
              title="Restart match from 0:0 with a fresh match_id (Shift+R)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: '#fafaf8',
                color: '#141413',
                border: '1px solid #e5e4df',
                borderRadius: 6,
                padding: '5px 10px',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2.2 4.5A4.2 4.2 0 1 1 2.5 8.3" />
                <polyline points="2,1.8 2,4.7 4.9,4.7" />
              </svg>
              <span>Restart</span>
              <KeyHint label="⇧R" />
            </button>
          </>
        )}
      </div>
    </div>
  );
};
