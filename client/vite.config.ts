import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Built-in WebSocket relay on `/ws-hardware` so the M5 IMU (over Wi-Fi) or
 * an optional local serial bridge can stream live 100Hz IMU packets directly
 * into the browser client with zero extra servers.
 */
function hardwareWsRelayPlugin(): Plugin {
  return {
    name: 'hardware-ws-relay',
    configureServer(server) {
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
  plugins: [react(), hardwareWsRelayPlugin()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
  },
});
