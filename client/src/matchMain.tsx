import React from 'react';
import ReactDOM from 'react-dom/client';
import { LiveMatchView } from './dashboard/LiveMatchView';

const MatchApp: React.FC = () => {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#f8f9fa' }}>
      <header
        style={{
          height: 46,
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
            Gemini Arena · Adaptive Opponent
          </span>
        </div>

        <a
          href="/"
          target="_blank"
          rel="noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 12px',
            borderRadius: 999,
            background: '#f1f3f4',
            color: '#3c4043',
            fontSize: 12,
            fontWeight: 500,
            textDecoration: 'none',
          }}
        >
          Classifier & Calibration ↗
        </a>
      </header>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <LiveMatchView />
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MatchApp />
  </React.StrictMode>,
);
