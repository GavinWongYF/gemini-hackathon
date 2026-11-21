// ─────────────────────────────────────────────────────────────────────────
// padInput.ts — PC side of the phone controller (phone page: src/pad/PadPage).
//
// On game load the PC connects to the dev-server relay (scripts/padRelay.ts) as
// `host` under a short room code; the start screen shows a QR to
// http://<LAN-IP>:<port>/#pad?room=<code>. Phone input arrives as ~60 Hz
// `in` snapshots and is written into the SAME stores the keyboard/mouse
// producer (input.ts) writes, so PlayerController/Weapon need no changes and
// keyboard + mouse keep working alongside:
//   joystick → moveForward/Back/strafeLeft/Right (threshold) + inputExtra.walk
//   look     → yawDelta / pitchDelta (radians, scaled by the ADS fov ratio)
//   fire     → inputExtra.fireHeld + firePressed edge (re-pulsed every frame
//              while held and the mouse isn't captured — Weapon's uncaptured
//              path only honours pulses)
//   ads/crouch/jump/reload → aiming / crouch / inputExtra.jump* / reloadPressed
// Only CHANGES from the phone are written, so a held keyboard key is never
// overwritten by an idle phone.
//
// Host → phone feedback: `state` (hp, ammo, phase, round, score) ~10 Hz when it
// changes, and `hit` the moment the local player loses health.
// ─────────────────────────────────────────────────────────────────────────

import { LOCAL_ID } from "./contracts";
import { useControls, useGame } from "./stores";
import { inputExtra, look } from "./input";
import { useMatch } from "./match";
import { useIntro } from "./intro";
import { usePadStatus } from "./playState";

/** Phone → PC input snapshot (see PadPage). */
export interface PadInputMsg {
  t: "in";
  mx: number; // joystick x ∈ [-1, 1], right +
  my: number; // joystick y ∈ [-1, 1], DOWN + (screen coords)
  dx: number; // look delta since last snapshot, radians (right +)
  dy: number; // look delta since last snapshot, radians (down +)
  f: 0 | 1; // fire held
  a: 0 | 1; // ADS on
  c: 0 | 1; // crouch on
  jh: 0 | 1; // jump held
  js: number; // jump press counter
  rs: number; // reload press counter
  fs?: number; // fire press counter (older pads omit it)
}

const ROOM_KEY = "valor.padRoom";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const AXIS = 0.35; // per-axis threshold for the movement booleans
const DEADZONE = 0.2; // radial stick deadzone — a resting thumb never moves you
const STALE_MS = 700; // phone keep-alive is 250 ms; longer silence = release all
const WALK_MAX = 0.7; // stick deflection below this = walk (quiet, slow)

function roomCode(): string {
  try {
    const saved = sessionStorage.getItem(ROOM_KEY);
    if (saved && /^[A-Z0-9]{4}$/.test(saved)) return saved;
  } catch {
    /* ignore */
  }
  let c = "";
  for (let i = 0; i < 4; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  try {
    sessionStorage.setItem(ROOM_KEY, c);
  } catch {
    /* ignore */
  }
  return c;
}

// What the phone last asked for — we write only on change.
const last = { fwd: false, back: false, left: false, right: false, walk: false, fire: false, ads: false, crouch: false, jh: false, js: -1, rs: -1, fs: -1 };

function releasePad() {
  const set = useControls.setState;
  if (last.fwd) set({ moveForward: false });
  if (last.back) set({ moveBack: false });
  if (last.left) set({ strafeLeft: false });
  if (last.right) set({ strafeRight: false });
  if (last.crouch) set({ crouch: false });
  if (last.ads) set({ aiming: false });
  if (last.fire) inputExtra.fireHeld = false;
  if (last.walk) inputExtra.walk = false;
  if (last.jh) inputExtra.jumpHeld = false;
  Object.assign(last, { fwd: false, back: false, left: false, right: false, walk: false, fire: false, ads: false, crouch: false, jh: false });
}

function applyInput(m: PadInputMsg) {
  const set = useControls.setState;
  const mx = +m.mx || 0;
  const my = +m.my || 0;
  const mag = Math.min(1, Math.hypot(mx, my));
  const live = mag >= DEADZONE;
  const fwd = live && -my > AXIS;
  const back = live && my > AXIS;
  const left = live && mx < -AXIS;
  const right = live && mx > AXIS;
  const walk = live && mag < WALK_MAX;
  if (fwd !== last.fwd) set({ moveForward: (last.fwd = fwd) });
  if (back !== last.back) set({ moveBack: (last.back = back) });
  if (left !== last.left) set({ strafeLeft: (last.left = left) });
  if (right !== last.right) set({ strafeRight: (last.right = right) });
  if (walk !== last.walk) inputExtra.walk = last.walk = walk;

  const dx = +m.dx || 0;
  const dy = +m.dy || 0;
  if (dx || dy) {
    const k = look.fovScale; // same "zoom ratio 1" scaling as the mouse
    const s = useControls.getState();
    // Same sign convention as the mouse (input.ts): drag right → turn right.
    set({ yawDelta: s.yawDelta + dx * k, pitchDelta: s.pitchDelta + dy * k });
  }

  const fire = m.f === 1;
  if (fire !== last.fire) {
    last.fire = fire;
    inputExtra.fireHeld = fire;
    if (fire) set({ firePressed: true });
  }
  // A new press count = a press happened even if it was released before this
  // snapshot (quick tap): pulse the edge so the weapon still fires once.
  if (typeof m.fs === "number") {
    if (last.fs >= 0 && m.fs > last.fs) set({ firePressed: true });
    last.fs = m.fs;
  }
  const ads = m.a === 1;
  if (ads !== last.ads) set({ aiming: (last.ads = ads) });
  const crouch = m.c === 1;
  if (crouch !== last.crouch) set({ crouch: (last.crouch = crouch) });
  const jh = m.jh === 1;
  if (jh !== last.jh) inputExtra.jumpHeld = last.jh = jh;
  if (last.js >= 0 && m.js > last.js) inputExtra.jumpPressed = true;
  last.js = m.js;
  if (last.rs >= 0 && m.rs > last.rs) set({ reloadPressed: true });
  last.rs = m.rs;
}

let ws: WebSocket | null = null;
/** performance.now() of the last phone snapshot (stale-input watchdog). */
let lastInAt = 0;
let started = false;

function send(msg: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function snapshot() {
  const me = useGame.getState().entities[LOCAL_ID];
  const m = useMatch.getState();
  return {
    t: "state",
    hp: me ? Math.max(0, Math.round(me.health)) : 100,
    ammo: me ? me.ammo : 0,
    rl: me?.reloading ? 1 : 0,
    alive: me ? (me.alive ? 1 : 0) : 1,
    phase: m.phase,
    round: m.round,
    blue: m.score.blue,
    red: m.score.red,
    banner: m.banner,
    // Pre-round intro (intro.ts): stage + "3"/"2"/"1"/"GO" so the phone shows the countdown too.
    st: useIntro.getState().stage,
    cd: useIntro.getState().count,
  };
}

/** Resolve the URL the phone should open (LAN IP when the PC uses localhost). */
async function resolveUrl(room: string): Promise<string> {
  const loc = window.location;
  const isLocal = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(loc.hostname);
  // Opened via a LAN IP or a public tunnel (https://*.trycloudflare.com): the
  // phone can reach this exact origin, so use it as-is.
  if (!isLocal) return `${loc.origin}/#pad?room=${room}`;
  let host = loc.hostname;
  let port = loc.port;
  try {
    const r = await fetch("/pad-info", { cache: "no-store" });
    if (r.ok) {
      const info = (await r.json()) as { ips?: string[]; port?: number };
      if (isLocal && info.ips && info.ips[0]) host = info.ips[0];
      if (!port && info.port) port = String(info.port);
    }
  } catch {
    /* no relay (static build) — fall back to the current origin */
  }
  return `${loc.protocol}//${host}${port ? ":" + port : ""}/#pad?room=${room}`;
}

/** Start the host connection (idempotent). Returns a stop function. */
export function startPadHost(): () => void {
  let stopped = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const room = roomCode();
  usePadStatus.setState({ room });
  void resolveUrl(room).then((url) => !stopped && usePadStatus.setState({ url }));

  const connect = () => {
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/pad-ws?role=host&room=${room}`);
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      usePadStatus.setState({ hostUp: true });
      send(snapshot());
    };
    sock.onmessage = (ev) => {
      let msg: { t?: string; n?: number } & Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (msg.t) {
        case "in":
          lastInAt = performance.now();
          applyInput(msg as unknown as PadInputMsg);
          break;
        case "start":
          started = true;
          usePadStatus.setState({ started: true });
          send({ t: "started" });
          send(snapshot());
          break;
        case "pause":
          started = false;
          releasePad();
          usePadStatus.setState({ started: false });
          send({ t: "paused" });
          break;
        case "pads":
        case "pad_join":
        case "pad_leave": {
          const n = msg.n ?? 0;
          usePadStatus.setState({ pads: n });
          if (msg.t === "pad_join") send(snapshot());
          if (n === 0) {
            releasePad();
            started = false;
            usePadStatus.setState({ started: false });
          }
          break;
        }
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      releasePad();
      usePadStatus.setState({ hostUp: false, pads: 0, started: false });
      started = false;
      if (!stopped) timer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    };
    sock.onerror = () => sock.close();
  };
  connect();

  // Fire auto-repeat while the phone holds FIRE and the mouse isn't captured.
  let raf = 0;
  const tick = () => {
    // Watchdog: a phone that goes silent (screen lock, Wi-Fi blip, tab killed)
    // must not leave the player walking/firing on its last snapshot.
    if (lastInAt && performance.now() - lastInAt > STALE_MS) {
      lastInAt = 0;
      releasePad();
    }
    if (last.fire && !document.pointerLockElement && !useControls.getState().firePressed) {
      useControls.setState({ firePressed: true });
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  // Feedback: hit the instant health drops; state ~10 Hz when it changes.
  let prevHp = useGame.getState().entities[LOCAL_ID]?.health ?? 100;
  const unsub = useGame.subscribe((s) => {
    const hp = s.entities[LOCAL_ID]?.health;
    if (hp === undefined) return;
    if (hp < prevHp) send({ t: "hit", dmg: Math.round(prevHp - hp), hp: Math.max(0, Math.round(hp)) });
    prevHp = hp;
  });
  // Countdown steps go out the moment they change (not on the next 100 ms tick).
  const unsubIntro = useIntro.subscribe(() => send(snapshot()));
  let lastJson = "";
  const iv = setInterval(() => {
    const j = JSON.stringify(snapshot());
    if (j !== lastJson) {
      lastJson = j;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(j);
    }
  }, 100);

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(iv);
    cancelAnimationFrame(raf);
    unsub();
    unsubIntro();
    releasePad();
    const s = ws;
    ws = null;
    s?.close();
    usePadStatus.setState({ hostUp: false, pads: 0, started: false });
    void started;
  };
}
