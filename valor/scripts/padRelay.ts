// ─────────────────────────────────────────────────────────────────────────
// padRelay.ts — Vite dev-server plugin: a tiny WebSocket relay so a phone on
// the same Wi-Fi can act as the game controller ("scan the QR, play").
//
//   WS   /pad-ws?role=host&room=CODE   the PC game page (one per room)
//   WS   /pad-ws?role=pad&room=CODE    phone controller(s)
//   GET  /pad-info                     { ips: string[], port: number }
//
// The relay is dumb: pad → host messages are forwarded verbatim (the host
// learns which pad from `pad_join` / `pad_leave` notices); host → pad messages
// are broadcast to every pad in the room. Messages are small JSON strings.
// ─────────────────────────────────────────────────────────────────────────

import os from "node:os";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";
import { WebSocketServer, WebSocket } from "ws";

interface Room {
  host: WebSocket | null;
  pads: Set<WebSocket>;
}

const VIRTUAL_IF = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|vbox|loopback|tailscale|zerotier|hamachi|utun|bridge|br-|veth/i;

function rank(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && +m[1] >= 16 && +m[1] <= 31) return 2;
  return 3;
}

/** LAN IPv4 addresses, best first (real Wi-Fi/Ethernet private ranges). */
export function lanIPv4(): string[] {
  const out: { ip: string; score: number }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      const fam = a.family as unknown;
      if ((fam !== "IPv4" && fam !== 4) || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue; // link-local
      const virtual = VIRTUAL_IF.test(name);
      out.push({ ip: a.address, score: rank(a.address) + (virtual ? 10 : 0) + (/wi-?fi|wlan|wireless/i.test(name) ? -0.5 : 0) });
    }
  }
  out.sort((a, b) => a.score - b.score);
  return [...new Set(out.map((o) => o.ip))];
}

export function padRelay(): Plugin {
  return {
    name: "valor-pad-relay",
    apply: "serve",
    configureServer(server) {
      const rooms = new Map<string, Room>();
      const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
      const room = (code: string): Room => {
        let r = rooms.get(code);
        if (!r) rooms.set(code, (r = { host: null, pads: new Set() }));
        return r;
      };
      const send = (ws: WebSocket | null, msg: unknown) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
      };
      const gc = (code: string) => {
        const r = rooms.get(code);
        if (r && !r.host && r.pads.size === 0) rooms.delete(code);
      };

      wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        const url = new URL(req.url ?? "/", "http://x");
        const code = (url.searchParams.get("room") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
        const role = url.searchParams.get("role");
        if (!code || (role !== "host" && role !== "pad")) {
          ws.close(4000, "bad params");
          return;
        }
        const r = room(code);
        let padId = 0;

        if (role === "host") {
          if (r.host && r.host !== ws) r.host.close(4001, "replaced");
          r.host = ws;
          for (const p of r.pads) send(p, { t: "host", up: true });
          send(ws, { t: "pads", n: r.pads.size });
          ws.on("message", (data) => {
            const s = data.toString();
            for (const p of r.pads) send(p, s);
          });
          ws.on("close", () => {
            if (r.host === ws) {
              r.host = null;
              for (const p of r.pads) send(p, { t: "host", up: false });
            }
            gc(code);
          });
        } else {
          padId = Math.floor(Math.random() * 1e9);
          r.pads.add(ws);
          send(ws, { t: "host", up: !!r.host });
          send(r.host, { t: "pad_join", id: padId, n: r.pads.size });
          ws.on("message", (data) => send(r.host, data.toString()));
          ws.on("close", () => {
            r.pads.delete(ws);
            send(r.host, { t: "pad_leave", id: padId, n: r.pads.size });
            gc(code);
          });
        }
        // Keep NAT/Wi-Fi power-save from silently dropping idle sockets.
        const ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 15000);
        ws.on("close", () => clearInterval(ping));
        ws.on("error", () => {});
      });

      server.httpServer?.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!req.url?.startsWith("/pad-ws")) return; // leave Vite's HMR socket alone
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      });

      server.middlewares.use("/pad-info", (_req, res) => {
        const addr = server.httpServer?.address();
        const port = addr && typeof addr === "object" ? addr.port : server.config.server.port ?? 5173;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ ips: lanIPv4(), port }));
      });
    },
  };
}
