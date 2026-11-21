import React from 'react';
import ReactDOM from 'react-dom/client';
import { LiveMatchView } from './dashboard/LiveMatchView';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LiveMatchView />
  </React.StrictMode>,
);
