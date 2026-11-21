// Serves the slide page and the game from one address, so the slide page can hear
// keys pressed inside the game (G switches back to the slides with no change to the game).
//
//   node agents/slides/serve.mjs [port]
//
// The slides are at  http://localhost:<port>/deck/index.html?game=/match
// Everything else (the game's pages, code and sockets) is passed on to the game.
// The game's address is the one line in agents/slides/game-address.txt. Change the line
// and reload the page to point at another copy of the game.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DECK = path.join(here, 'web');
const ADDRESS_FILE = path.join(here, 'game-address.txt');
const port = Number(process.argv[2] || process.env.PORT || 8766);
// Started with the word "sensor" after the port, the front address opens the live sensor view.
const SENSOR_HOME = process.argv[3] === 'sensor';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function game() {
  let text = 'http://localhost:5173';
  try { text = fs.readFileSync(ADDRESS_FILE, 'utf8').trim() || text; } catch (err) {}
  try { return new URL(text); } catch (err) { return new URL('http://localhost:5173'); }
}

function serveDeck(req, res, rel) {
  const file = path.normalize(path.join(DECK, decodeURIComponent(rel || 'index.html')));
  if (!file.startsWith(DECK)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
    const head = {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store', 'accept-ranges': 'bytes',
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, 'content-length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/deck') { res.writeHead(302, { location: '/deck/' }).end(); return; }
  if (SENSOR_HOME && pathname === '/') { res.writeHead(302, { location: '/deck/dev.html' }).end(); return; }
  if (pathname.startsWith('/deck/')) { serveDeck(req, res, pathname.slice('/deck/'.length)); return; }
  const g = game();
  const up = http.request({
    hostname: g.hostname, port: g.port || 80, path: req.url, method: req.method,
    headers: { ...req.headers, host: g.host },
  }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`The game is not running at ${g.origin}. Start it, or change agents/slides/game-address.txt.`);
  });
  req.pipe(up);
});

// Sockets (the game's hot reload and its hardware relay) are passed straight through.
server.on('upgrade', (req, socket, head) => {
  const g = game();
  const up = net.connect(Number(g.port || 80), g.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      lines.push(`${key}: ${key.toLowerCase() === 'host' ? g.host : req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Slides: http://localhost:${port}/deck/index.html?game=/match   Game: ${game().origin}`);
});
