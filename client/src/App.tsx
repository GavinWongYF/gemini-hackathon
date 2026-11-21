import React from 'react';
import { HardwareTestView } from './hardware/HardwareTestView';

export const App: React.FC = () => {
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
          🎾 Adaptive AI Tennis — Hardware & Classifier
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <a
            href="/match"
            target="_blank"
            rel="noreferrer"
            style={{
              background: '#2563eb',
              color: '#f8fafc',
              border: '1px solid rgba(148,163,184,0.25)',
              borderRadius: 6,
              padding: '4px 11px',
              fontSize: 12,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Open 3D Match (/match) ↗
          </a>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <HardwareTestView />
      </div>
    </div>
  );
};
