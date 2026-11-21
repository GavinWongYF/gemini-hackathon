import React, { useState } from 'react';
import { HardwareTestView } from './hardware/HardwareTestView';
import { LiveMatchView } from './dashboard/LiveMatchView';

export const App: React.FC = () => {
  const [tab, setTab] = useState<'hardware' | 'match'>('hardware');

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 14px',
          background: '#0b1120',
          borderBottom: '1px solid rgba(148,163,184,0.18)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          zIndex: 40,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>
          🎾 Adaptive AI Tennis
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setTab('hardware')}
            style={{
              background: tab === 'hardware' ? '#2563eb' : 'rgba(30,41,59,0.8)',
              color: '#f8fafc',
              border: '1px solid rgba(148,163,184,0.25)',
              borderRadius: 6,
              padding: '4px 11px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Hardware & Calibration
          </button>
          <button
            onClick={() => setTab('match')}
            style={{
              background: tab === 'match' ? '#2563eb' : 'rgba(30,41,59,0.8)',
              color: '#f8fafc',
              border: '1px solid rgba(148,163,184,0.25)',
              borderRadius: 6,
              padding: '4px 11px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Live Match + AI Dashboard
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {tab === 'hardware' ? <HardwareTestView /> : <LiveMatchView />}
      </div>
    </div>
  );
};
