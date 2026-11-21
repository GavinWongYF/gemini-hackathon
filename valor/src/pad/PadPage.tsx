// ─────────────────────────────────────────────────────────────────────────
// PadPage — the phone controller (route: /#pad?room=CODE). PUBG-Mobile style:
//   left thumb   floating analog stick (small push = walk, full = run)
//   right half   drag anywhere to look (deltas batched, sent at ~60 Hz)
//   FIRE         big button bottom-right (hold = auto, drag on it to aim too)
//                + a second FIRE on the left like PUBG
//   ADS · RELOAD · JUMP · CROUCH, pause, sensitivity slider, tiny HUD
// Talks to the PC through the dev-server relay (scripts/padRelay.ts); the PC
// side is src/game/padInput.ts. Pointer Events with per-pointer capture, so
// move + look + fire work simultaneously with three thumbs/fingers.
// ─────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { C, DISPLAY, BODY, UiStyles } from "../game/ui/theme";

type Feedback = {
  hp: number;
  ammo: number;
  rl: number;
  alive: number;
  phase: string;
  round: number;
  blue: number;
  red: number;
  banner: string | null;
  /** Pre-round intro stage ("none" | "overview" | "fly" | "count" | "go"). */
  st?: string;
  /** Countdown "3" | "2" | "1" | "GO" | null. */
  cd?: string | null;
};

const SENS_KEY = "valor.padSens";
const SENS_MIN = 0.0015;
const SENS_MAX = 0.012;
const STICK_R = 62; // px of knob travel
const MAG_SIZE_GUESS = 30;

function readRoom(): string {
  const h = window.location.hash; // "#pad?room=ABCD"
  const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : window.location.search.slice(1);
  return (new URLSearchParams(q).get("room") ?? "").toUpperCase();
}

function vibrate(p: number | number[]) {
  try {
    navigator.vibrate?.(p);
  } catch {
    /* unsupported */
  }
}

// ── live input state (refs, no re-render per touch) ─────────────────────
interface PadState {
  mx: number;
  my: number;
  dx: number;
  dy: number;
  fire: Set<number>; // pointer ids holding a fire button
  ads: boolean;
  crouch: boolean;
  jh: boolean;
  js: number;
  rs: number;
  fs: number; // fire press counter (a tap shorter than one snapshot still fires)
}

function Btn({
  label,
  sub,
  size,
  style,
  active,
  color,
  onDown,
  onUp,
  onDrag,
  testId,
}: {
  label: ReactNode;
  sub?: string;
  size: number;
  style: CSSProperties;
  active?: boolean;
  color?: string;
  onDown: (id: number) => void;
  onUp?: (id: number) => void;
  onDrag?: (dx: number, dy: number) => void;
  testId?: string;
}) {
  const last = useRef(new Map<number, { x: number; y: number }>());
  const [pressed, setPressed] = useState(false);
  const tint = color ?? C.ink;
  return (
    <div
      data-testid={testId}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
        last.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        setPressed(true);
        onDown(e.pointerId);
      }}
      onPointerMove={(e) => {
        const p = last.current.get(e.pointerId);
        if (!p || !onDrag) return;
        onDrag(e.clientX - p.x, e.clientY - p.y);
        p.x = e.clientX;
        p.y = e.clientY;
      }}
      onPointerUp={(e) => {
        if (!last.current.delete(e.pointerId)) return;
        setPressed(last.current.size > 0);
        onUp?.(e.pointerId);
      }}
      onPointerCancel={(e) => {
        if (!last.current.delete(e.pointerId)) return;
        setPressed(last.current.size > 0);
        onUp?.(e.pointerId);
      }}
      style={{
        position: "absolute",
        width: size,
        height: size,
        borderRadius: "50%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: active || pressed ? `${tint}38` : "rgba(15,25,35,0.42)",
        border: `2px solid ${active || pressed ? tint : "rgba(236,232,225,0.35)"}`,
        boxShadow: active || pressed ? `0 0 18px ${tint}66` : "0 4px 14px rgba(0,0,0,0.35)",
        color: tint,
        fontFamily: DISPLAY,
        fontWeight: 700,
        fontSize: Math.max(12, size * 0.2),
        letterSpacing: 1.5,
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        transform: pressed ? "scale(0.94)" : "none",
        transition: "transform .06s, background .1s",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        ...style,
      }}
    >
      {label}
      {sub ? <span style={{ fontSize: 9, letterSpacing: 1, opacity: 0.7, marginTop: 1 }}>{sub}</span> : null}
    </div>
  );
}

function Crosshair() {
  return (
    <svg width="54" height="54" viewBox="0 0 54 54" style={{ display: "block" }}>
      <circle cx="27" cy="27" r="14" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <path d="M27 4v12M27 38v12M4 27h12M38 27h12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function PadPage() {
  const room = readRoom();
  const st = useRef<PadState>({ mx: 0, my: 0, dx: 0, dy: 0, fire: new Set(), ads: false, crouch: false, jh: false, js: 0, rs: 0, fs: 0 });
  // Immediate snapshot sender (set by the 60 Hz loop effect). Mobile Chrome
  // throttles timers ~100 ms after each touchstart, so FIRE presses are sent
  // straight from the touch handler instead of waiting for the next tick.
  const flushRef = useRef<(() => void) | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [link, setLink] = useState<"connecting" | "online" | "nohost">("connecting");
  const [started, setStarted] = useState(false);
  const [fb, setFb] = useState<Feedback | null>(null);
  const [hitFlash, setHitFlash] = useState(0);
  const [ads, setAds] = useState(false);
  const [crouch, setCrouch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [portrait, setPortrait] = useState(() => window.innerHeight > window.innerWidth);
  const [sens, setSensState] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem(SENS_KEY) ?? "");
      if (v >= SENS_MIN && v <= SENS_MAX) return v;
    } catch {
      /* ignore */
    }
    return 0.0045;
  });
  const sensRef = useRef(sens);
  sensRef.current = sens;
  const startedRef = useRef(false);
  const prevAmmo = useRef<number | null>(null);
  const lastBuzz = useRef(0);

  // stick visuals
  const [stick, setStick] = useState<{ bx: number; by: number; kx: number; ky: number } | null>(null);
  const stickPtr = useRef<number | null>(null);
  /** Floating stick base (screen px). Lives in a ref — NOT read back from React
   *  state — so the input value is computed synchronously in the event handler
   *  and a release can never be overwritten by a still-queued state updater. */
  const stickBase = useRef<{ bx: number; by: number } | null>(null);
  const lookPtrs = useRef(new Map<number, { x: number; y: number }>());

  const send = useCallback((m: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  // ── socket ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!room) return;
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/pad-ws?role=pad&room=${encodeURIComponent(room)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        if (startedRef.current) ws.send(JSON.stringify({ t: "start" }));
      };
      ws.onmessage = (ev) => {
        let m: { t?: string } & Record<string, unknown>;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m.t === "host") {
          setLink(m.up ? "online" : "nohost");
          if (m.up && startedRef.current) ws.send(JSON.stringify({ t: "start" }));
        } else if (m.t === "state") {
          const f = m as unknown as Feedback;
          // Shot feedback: ammo dropped while holding fire → tiny buzz (throttled).
          if (prevAmmo.current !== null && f.ammo < prevAmmo.current && performance.now() - lastBuzz.current > 70) {
            lastBuzz.current = performance.now();
            vibrate(12);
          }
          prevAmmo.current = f.ammo;
          setFb(f);
        } else if (m.t === "hit") {
          vibrate([45, 30, 70]);
          setHitFlash((n) => n + 1);
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped) return;
        setLink("connecting");
        timer = setTimeout(connect, Math.min(4000, 400 * 2 ** retry++));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [room]);

  // ── 60 Hz input snapshots (batched look deltas) ─────────────────────
  useEffect(() => {
    let lastSent = "";
    let lastAt = 0;
    const flush = (force = false) => {
      const s = st.current;
      const msg = {
        t: "in",
        mx: Math.round(s.mx * 1000) / 1000,
        my: Math.round(s.my * 1000) / 1000,
        dx: s.dx,
        dy: s.dy,
        f: s.fire.size > 0 ? 1 : 0,
        a: s.ads ? 1 : 0,
        c: s.crouch ? 1 : 0,
        jh: s.jh ? 1 : 0,
        js: s.js,
        rs: s.rs,
        fs: s.fs,
      };
      s.dx = 0;
      s.dy = 0;
      const j = JSON.stringify(msg);
      const now = performance.now();
      // Send on change or look motion; otherwise a 4 Hz keep-alive.
      if (force || j !== lastSent || now - lastAt > 250) {
        send(msg);
        lastSent = msg.dx || msg.dy ? "" : j;
        lastAt = now;
      }
    };
    flushRef.current = () => flush(true);
    const iv = setInterval(flush, 1000 / 60);
    return () => {
      clearInterval(iv);
      flushRef.current = null;
    };
  }, [send]);

  useEffect(() => {
    const onResize = () => setPortrait(window.innerHeight > window.innerWidth);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Wake lock is released when the tab hides — re-acquire on return.
  const wakeRef = useRef<{ release(): Promise<void> } | null>(null);
  const acquireWake = useCallback(async () => {
    try {
      const nav = navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } };
      if (nav.wakeLock) wakeRef.current = await nav.wakeLock.request("screen");
    } catch {
      /* denied / unsupported */
    }
  }, []);
  useEffect(() => {
    // Hidden / blurred tab: release every held control so the PC never keeps
    // walking or firing on a stale snapshot (pointerup never arrives then).
    const releaseHeld = () => {
      const s = st.current;
      s.mx = s.my = 0;
      s.fire.clear();
      s.jh = false;
      stickPtr.current = null;
      stickBase.current = null;
      lookPtrs.current.clear();
      setStick(null);
    };
    const onVis = () => {
      if (document.visibilityState === "visible" && startedRef.current) void acquireWake();
      else releaseHeld();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", releaseHeld);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", releaseHeld);
    };
  }, [acquireWake]);

  const start = useCallback(() => {
    startedRef.current = true;
    setStarted(true);
    vibrate(30);
    send({ t: "start" });
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: "hide" }) : el.webkitRequestFullscreen?.();
      Promise.resolve(p)
        .then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape"))
        .catch(() => {});
    } catch {
      /* iOS Safari: no element fullscreen */
    }
    void acquireWake();
  }, [send, acquireWake]);

  const pause = useCallback(() => {
    startedRef.current = false;
    setStarted(false);
    const s = st.current;
    s.mx = s.my = 0;
    s.fire.clear();
    s.jh = false;
    setStick(null);
    stickPtr.current = null;
    lookPtrs.current.clear();
    send({ t: "pause" });
  }, [send]);

  // ── surface: left = floating stick, right = look ───────────────────
  const onSurfaceDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const leftZone = e.clientX < window.innerWidth * 0.42;
    if (leftZone && stickPtr.current === null) {
      stickPtr.current = e.pointerId;
      stickBase.current = { bx: e.clientX, by: e.clientY };
      setStick({ bx: e.clientX, by: e.clientY, kx: 0, ky: 0 });
      st.current.mx = st.current.my = 0;
    } else {
      lookPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  };
  const onSurfaceMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId === stickPtr.current) {
      const base = stickBase.current;
      if (!base) return;
      let kx = e.clientX - base.bx;
      let ky = e.clientY - base.by;
      const d = Math.hypot(kx, ky);
      // Floating base: drag past the rim and the base follows the thumb.
      if (d > STICK_R) {
        const over = d - STICK_R;
        base.bx += (kx / d) * over;
        base.by += (ky / d) * over;
        kx = (kx / d) * STICK_R;
        ky = (ky / d) * STICK_R;
      }
      st.current.mx = kx / STICK_R;
      st.current.my = ky / STICK_R;
      setStick({ bx: base.bx, by: base.by, kx, ky });
      return;
    }
    const p = lookPtrs.current.get(e.pointerId);
    if (!p) return;
    const k = sensRef.current;
    st.current.dx += (e.clientX - p.x) * k;
    st.current.dy += (e.clientY - p.y) * k;
    p.x = e.clientX;
    p.y = e.clientY;
  };
  const onSurfaceUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId === stickPtr.current) {
      stickPtr.current = null;
      stickBase.current = null;
      st.current.mx = st.current.my = 0;
      setStick(null);
    }
    lookPtrs.current.delete(e.pointerId);
  };

  const fireDown = (id: number) => {
    const first = st.current.fire.size === 0;
    st.current.fire.add(id);
    if (first) {
      st.current.fs++;
      flushRef.current?.(); // send now — don't wait for the (throttled) timer
      vibrate(15);
    }
  };
  const fireUp = (id: number) => {
    if (st.current.fire.delete(id) && st.current.fire.size === 0) flushRef.current?.();
  };
  const aimDrag = (dx: number, dy: number) => {
    st.current.dx += dx * sensRef.current;
    st.current.dy += dy * sensRef.current;
  };

  const setSens = (v: number) => {
    setSensState(v);
    try {
      localStorage.setItem(SENS_KEY, String(v));
    } catch {
      /* ignore */
    }
  };

  const hp = fb?.hp ?? 100;
  const hpColor = hp > 60 ? C.teal : hp > 30 ? C.amber : C.red;
  const linkColor = link === "online" ? C.teal : link === "nohost" ? C.amber : C.inkFaint;
  const linkText = !room ? "No room code — scan the QR on the PC" : link === "online" ? `Connected · ${room}` : link === "nohost" ? `Room ${room} · PC not open` : `Connecting · ${room}`;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: `radial-gradient(ellipse at 70% 40%, #1a2a3a 0%, ${C.navy} 60%, #070c12 100%)`,
        color: C.ink,
        fontFamily: BODY,
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        overscrollBehavior: "none",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <UiStyles />
      {/* grid texture */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.07,
          backgroundImage: "linear-gradient(rgba(236,232,225,1) 1px, transparent 1px), linear-gradient(90deg, rgba(236,232,225,1) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          pointerEvents: "none",
        }}
      />
      {/* hit flash */}
      <div
        key={hitFlash}
        data-testid="pad-hitflash"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          boxShadow: "inset 0 0 120px rgba(255,70,85,0.85)",
          animation: hitFlash ? "padHit .45s ease-out forwards" : undefined,
          opacity: 0,
        }}
      />
      <style>{`@keyframes padHit{0%{opacity:1}100%{opacity:0}}`}</style>

      {/* touch surface (stick + look) */}
      <div
        data-testid="pad-surface"
        onPointerDown={onSurfaceDown}
        onPointerMove={onSurfaceMove}
        onPointerUp={onSurfaceUp}
        onPointerCancel={onSurfaceUp}
        style={{ position: "absolute", inset: 0, touchAction: "none" }}
      >
        {/* zone hints */}
        {!stick && (
          <div style={{ position: "absolute", left: "9%", bottom: "14%", width: 132, height: 132, borderRadius: "50%", border: "2px dashed rgba(236,232,225,0.18)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: DISPLAY, fontSize: 12, letterSpacing: 2, color: C.inkFaint, pointerEvents: "none" }}>
            MOVE
          </div>
        )}
        <div style={{ position: "absolute", left: "58%", top: "46%", transform: "translate(-50%,-50%)", fontFamily: DISPLAY, fontSize: 12, letterSpacing: 3, color: "rgba(236,232,225,0.16)", pointerEvents: "none" }}>
          ← DRAG TO LOOK →
        </div>
        {stick && (
          <div style={{ position: "absolute", left: stick.bx - STICK_R - 10, top: stick.by - STICK_R - 10, width: (STICK_R + 10) * 2, height: (STICK_R + 10) * 2, borderRadius: "50%", background: "rgba(15,25,35,0.35)", border: "2px solid rgba(236,232,225,0.3)", pointerEvents: "none" }}>
            <div
              style={{
                position: "absolute",
                left: STICK_R + 10 - 30 + stick.kx,
                top: STICK_R + 10 - 30 + stick.ky,
                width: 60,
                height: 60,
                borderRadius: "50%",
                background: Math.hypot(stick.kx, stick.ky) / STICK_R > 0.7 ? C.teal : "rgba(236,232,225,0.85)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
              }}
            />
          </div>
        )}
      </div>

      {/* ── HUD (top) ── */}
      <div style={{ position: "absolute", top: 10, left: 14, right: 14, display: "flex", alignItems: "center", gap: 14, pointerEvents: "none" }}>
        <div data-testid="pad-link" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: linkColor, fontFamily: DISPLAY, letterSpacing: 1.2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: linkColor, boxShadow: link === "online" ? `0 0 8px ${linkColor}` : undefined }} />
          {linkText}
        </div>
        <div style={{ flex: 1 }} />
        {fb && (
          <div data-testid="pad-round" style={{ fontFamily: DISPLAY, fontSize: 14, letterSpacing: 1.5 }}>
            {fb.banner ? <span style={{ color: C.amber, marginRight: 10 }}>{fb.banner}</span> : null}
            R{fb.round} <span style={{ color: C.teal }}>{fb.blue}</span> – <span style={{ color: C.red }}>{fb.red}</span>
          </div>
        )}
        <div style={{ width: 84 }} />
      </div>
      <div style={{ position: "absolute", top: 8, right: 12, display: "flex", gap: 8 }}>
        <div onPointerDown={(e) => { e.stopPropagation(); setShowSettings((v) => !v); }} style={smallBtn}>⚙</div>
        <div onPointerDown={(e) => { e.stopPropagation(); pause(); }} style={smallBtn} data-testid="pad-pause">❚❚</div>
      </div>

      {/* health + ammo (bottom centre) */}
      <div style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "flex-end", gap: 18, pointerEvents: "none" }}>
        <div>
          <div data-testid="pad-hp" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 26, lineHeight: 1, color: hpColor }}>
            {fb?.alive === 0 ? "DEAD" : hp}
            <span style={{ fontSize: 11, color: C.inkDim, marginLeft: 4, letterSpacing: 1.5 }}>HP</span>
          </div>
          <div style={{ width: 120, height: 5, background: "rgba(236,232,225,0.15)", marginTop: 4 }}>
            <div style={{ width: `${hp}%`, height: "100%", background: hpColor, transition: "width .2s" }} />
          </div>
        </div>
        <div data-testid="pad-ammo" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 26, lineHeight: 1 }}>
          {fb?.rl ? <span style={{ color: C.amber, fontSize: 18 }}>RELOADING</span> : (fb?.ammo ?? MAG_SIZE_GUESS)}
          <span style={{ fontSize: 11, color: C.inkDim, marginLeft: 4, letterSpacing: 1.5 }}>AMMO</span>
        </div>
      </div>

      {/* ── buttons ── */}
      <Btn testId="pad-fire" label={<Crosshair />} sub="FIRE" size={112} color={C.red} style={{ right: "6%", bottom: "13%" }} onDown={fireDown} onUp={fireUp} onDrag={aimDrag} />
      <Btn testId="pad-fire-left" label={<Crosshair />} size={70} color={C.red} style={{ left: "5%", top: "24%" }} onDown={fireDown} onUp={fireUp} onDrag={aimDrag} />
      <Btn
        testId="pad-ads"
        label="ADS"
        size={66}
        active={ads}
        color={C.teal}
        style={{ right: "calc(6% + 130px)", bottom: "34%" }}
        onDown={() => {
          st.current.ads = !st.current.ads;
          setAds(st.current.ads);
          vibrate(8);
        }}
      />
      <Btn testId="pad-reload" label="↻" sub="RELOAD" size={60} style={{ right: "calc(6% + 128px)", bottom: "8%" }} onDown={() => { st.current.rs++; vibrate(8); }} />
      <Btn
        testId="pad-jump"
        label="▲"
        sub="JUMP"
        size={62}
        style={{ right: "4%", bottom: "calc(13% + 128px)" }}
        onDown={() => {
          st.current.js++;
          st.current.jh = true;
          vibrate(8);
        }}
        onUp={() => (st.current.jh = false)}
      />
      <Btn
        testId="pad-crouch"
        label="▼"
        sub="CROUCH"
        size={62}
        active={crouch}
        color={C.amber}
        style={{ right: "calc(4% + 76px)", bottom: "calc(13% + 150px)" }}
        onDown={() => {
          st.current.crouch = !st.current.crouch;
          setCrouch(st.current.crouch);
          vibrate(8);
        }}
      />

      {/* settings */}
      {showSettings && (
        <div onPointerDown={(e) => e.stopPropagation()} style={{ position: "absolute", top: 50, right: 12, width: 250, padding: "14px 16px", background: C.panelSolid, border: `1px solid ${C.line}`, touchAction: "auto" }}>
          <div style={{ fontFamily: DISPLAY, letterSpacing: 2, fontSize: 13, color: C.inkDim }}>LOOK SENSITIVITY</div>
          <input
            type="range"
            min={SENS_MIN}
            max={SENS_MAX}
            step={0.0001}
            value={sens}
            onChange={(e) => setSens(parseFloat(e.target.value))}
            style={{ width: "100%", marginTop: 10, accentColor: C.red }}
          />
          <div style={{ fontSize: 12, color: C.inkFaint }}>{(sens * 1000).toFixed(1)}</div>
        </div>
      )}

      {/* tap to start */}
      {/* pre-round intro: GET READY → 3 · 2 · 1 · GO (mirrors the PC screen) */}
      {started && fb && (fb.cd || fb.st === "overview") ? (
        <div data-testid="pad-countdown" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none", background: fb.cd === "GO" ? "transparent" : "rgba(7,12,18,0.45)" }}>
          <style>{`@keyframes pad-cd { 0% { opacity: 0; transform: scale(1.9) } 20% { opacity: 1; transform: scale(.95) } 32% { transform: scale(1) } 100% { opacity: 1 } }`}</style>
          <div style={{ fontFamily: DISPLAY, fontSize: 15, letterSpacing: 5, color: C.inkDim }}>ROUND {fb.round}</div>
          {fb.cd ? (
            <div key={fb.cd} style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: fb.cd === "GO" ? 110 : 140, lineHeight: 1, color: fb.cd === "GO" ? C.teal : C.ink, textShadow: "0 4px 24px rgba(0,0,0,.6)", animation: "pad-cd .9s cubic-bezier(.2,.9,.3,1) both" }}>
              {fb.cd}
            </div>
          ) : (
            <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 44, letterSpacing: 6, marginTop: 6 }}>GET READY</div>
          )}
        </div>
      ) : null}
      {!started && !portrait && (
        <div
          data-testid="pad-start"
          onPointerDown={(e) => {
            e.stopPropagation();
            start();
          }}
          style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(7,12,18,0.88)", backdropFilter: "blur(6px)", touchAction: "none" }}
        >
          <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 64, letterSpacing: "0.05em", lineHeight: 0.9 }}>
            VAL<span style={{ color: C.red }}>O</span>R
          </div>
          <div style={{ fontFamily: DISPLAY, fontSize: 14, letterSpacing: 4, color: C.inkDim, marginTop: 6 }}>PHONE CONTROLLER</div>
          <div
            style={{
              marginTop: 22,
              padding: "16px 56px",
              background: C.red,
              fontFamily: DISPLAY,
              fontWeight: 700,
              fontSize: 22,
              letterSpacing: 4,
              clipPath: "polygon(12px 0, 100% 0, calc(100% - 12px) 100%, 0 100%)",
              boxShadow: "0 10px 30px rgba(255,70,85,0.3)",
            }}
          >
            TAP TO START
          </div>
          <div style={{ marginTop: 14, fontSize: 12, color: linkColor, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: linkColor }} />
            {linkText}
          </div>
        </div>
      )}

      {portrait && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, background: C.navy, textAlign: "center", padding: 24 }}>
          <div style={{ fontSize: 64, animation: "padRot 1.8s ease-in-out infinite" }}>📱</div>
          <style>{`@keyframes padRot{0%,30%{transform:rotate(0)}60%,100%{transform:rotate(-90deg)}}`}</style>
          <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 24, letterSpacing: 3 }}>ROTATE YOUR PHONE</div>
          <div style={{ fontSize: 14, color: C.inkDim, maxWidth: 260 }}>The controller plays in landscape. Turn off rotation lock if it doesn't flip.</div>
          <div style={{ fontSize: 12, color: linkColor }}>{linkText}</div>
        </div>
      )}
    </div>
  );
}

const smallBtn: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(15,25,35,0.6)",
  border: `1px solid ${C.line}`,
  color: C.ink,
  fontSize: 15,
  touchAction: "none",
};
