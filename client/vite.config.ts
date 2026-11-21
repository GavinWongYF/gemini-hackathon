import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Built-in WebSocket relay on `/ws-hardware` so the M5 IMU (over Wi-Fi) or
 * `ble_bridge.py` streams live 100Hz IMU packets simultaneously to BOTH
 * `/` (Hardware & Classifier) and `/match` (3D Gemini Arena + AI Live Match).
 * Also routes `/match` and `/3d` cleanly to `/match.html`.
 */
function hardwareAndMultiPagePlugin(): Plugin {
  return {
    name: 'hardware-ws-and-mpa',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) {
          const cleanPath = req.url.split('?')[0];
          if (cleanPath === '/match' || cleanPath === '/match/' || cleanPath === '/3d' || cleanPath === '/3d/') {
            const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            req.url = `/match.html${query}`;
          }
        }
        next();
      });

      if (!server.httpServer) return;
      const wss = new WebSocketServer({ noServer: true });
      const clients = new Set<WebSocket>();

      server.httpServer.on('upgrade', (req, socket, head) => {
        if (req.url && req.url.startsWith('/ws-hardware')) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
        }
      });

      wss.on('connection', (ws) => {
        clients.add(ws);
        ws.on('message', (data) => {
          const text = data.toString();
          for (const peer of clients) {
            if (peer !== ws && peer.readyState === WebSocket.OPEN) {
              peer.send(text);
            }
          }
        });
        ws.on('close', () => {
          clients.delete(ws);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), hardwareAndMultiPagePlugin()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        match: path.resolve(__dirname, 'match.html'),
      },
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
  },
});
