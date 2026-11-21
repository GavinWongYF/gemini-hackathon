import React, { useState } from 'react';
import { HardwareTestView } from './hardware/HardwareTestView';
import { LiveMatchView } from './dashboard/LiveMatchView';

export const App: React.FC = () => {
  const [tab, setTab] = useState<'match' | 'hardware'>('match');

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#f8f9fa' }}>
      <header
        style={{
          height: 48,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 20px',
          background: '#ffffff',
          borderBottom: '1px solid #e3e3e3',
          zIndex: 40,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#1f1f1f', letterSpacing: '-0.01em' }}>
            Tennis
          </span>
          <span style={{ fontSize: 13, color: '#5f6368' }}>
            Adaptive Opponent
          </span>
        </div>

        <nav
          aria-label="View mode"
          style={{
            display: 'inline-flex',
            background: '#f1f3f4',
            padding: 3,
            borderRadius: 999,
            gap: 2,
          }}
        >
          <button
            type="button"
            onClick={() => setTab('match')}
            style={{
              background: tab === 'match' ? '#ffffff' : 'transparent',
              color: tab === 'match' ? '#1f1f1f' : '#5f6368',
              boxShadow: tab === 'match' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
              border: 'none',
              borderRadius: 999,
              padding: '5px 14px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Match
          </button>
          <button
            type="button"
            onClick={() => setTab('hardware')}
            style={{
              background: tab === 'hardware' ? '#ffffff' : 'transparent',
              color: tab === 'hardware' ? '#1f1f1f' : '#5f6368',
              boxShadow: tab === 'hardware' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
              border: 'none',
              borderRadius: 999,
              padding: '5px 14px',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Hardware
          </button>
        </nav>
      </header>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {tab === 'match' ? <LiveMatchView /> : <HardwareTestView />}
      </div>
    </div>
  );
};
