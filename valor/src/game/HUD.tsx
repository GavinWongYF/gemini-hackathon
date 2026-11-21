// ─────────────────────────────────────────────────────────────────────────
// HUD.tsx — the in-match heads-up display. A pure DOM overlay over the R3F
// canvas, pointer-transparent so clicks fall through to the game.
//
//   top-left    enemy-AI chip (tiny, live play only)
//   top-center  match bar: alive pips · score · round/clock
//   top-right   killfeed (team-coloured callsigns, fades after a few seconds)
//   side rails  the agent server's <npc-panel side="left|right"> (ui/NpcPanels.tsx)
//   center      crosshair + hitmarker (nothing else is ever drawn here in play)
//   upper third round banners
//   low center  agent card between rounds; "Esc · Tab" hint during play
//   bottom      health (left), ammo (right)
//   overlays    damage vignette, low-health edge, death / spectating, TAB board
//
// Selections are narrow; 60fps transforms never live here.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_ID, MAX_HEALTH, MAG_SIZE, type GameEvent } from "./contracts";
import { useGame } from "./stores";
import { useMatch } from "./match";
import { Scoreboard } from "./ui/Scoreboard";
import { useIntro } from "./intro";
import { RoundBanner } from "./ui/RoundBanner";
import { AgentCard, AgentChip } from "./ui/AgentCard";
import { TabScoreboard } from "./ui/TabScoreboard";
import { displayName, teamOf } from "./ui/roster";
import { C, DISPLAY, BODY, TEAM_COLOR, UiStyles, panel } from "./ui/theme";
import { DamageIndicator } from "./ui/DamageIndicator";
import { NpcPanels } from "./ui/NpcPanels";

const HITMARKER_MS = 140;
const KILLFEED_MS = 7000;

function healthColor(frac: number): string {
  if (frac > 0.5) return C.ink;
  if (frac > 0.25) return C.amber;
  return C.red;
}

/** Newest event matching `pred`, or null. */
function latest(events: GameEvent[], pred: (e: GameEvent) => boolean): GameEvent | null {
  let best: GameEvent | null = null;
  for (const e of events) if (pred(e) && (!best || e.t >= best.t)) best = e;
  return best;
}

/** Re-render every `ms` while `on` (for time-based fades). */
function useTick(ms: number, on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => set((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms, on]);
}

export function HUD() {
  const local = useGame((s) => s.entities[LOCAL_ID]);
  const entities = useGame((s) => s.entities);
  const events = useGame((s) => s.events);
  const phase = useMatch((s) => s.phase);
  const roundStartedAt = useMatch((s) => s.roundStartedAt); // killfeed only shows this round
  // Pre-round overview + fly-down is a cinematic: the whole HUD steps aside.
  const cinematic = useIntro((s) => s.stage === "overview" || s.stage === "fly");

  const health = local?.health ?? 0;
  const alive = local?.alive ?? false;
  const ammo = local?.ammo ?? 0;
  const reloading = local?.reloading ?? false;
  const healthFrac = Math.max(0, Math.min(1, health / MAX_HEALTH));

  // ── Hitmarker (white on hit, red on kill) ──────────────────────────────
  const ownHit = useMemo(() => latest(events, (e) => e.by === LOCAL_ID && e.on !== LOCAL_ID), [events]);
  const lastHitT = useRef(0);
  const [hit, setHit] = useState<{ at: number; kill: boolean } | null>(null);
  useEffect(() => {
    if (ownHit && ownHit.t > lastHitT.current) {
      lastHitT.current = ownHit.t;
      setHit({ at: performance.now(), kill: ownHit.kind === "kill" });
      const id = window.setTimeout(() => setHit(null), ownHit.kind === "kill" ? HITMARKER_MS * 2.5 : HITMARKER_MS);
      return () => window.clearTimeout(id);
    }
  }, [ownHit]);

  // ── Damage flash ───────────────────────────────────────────────────────
  const hurt = useMemo(() => latest(events, (e) => e.on === LOCAL_ID), [events]);
  const lastHurtT = useRef(0);
  const [hurtAt, setHurtAt] = useState(0);
  useEffect(() => {
    if (hurt && hurt.t > lastHurtT.current) {
      lastHurtT.current = hurt.t;
      setHurtAt(performance.now());
      const id = window.setTimeout(() => setHurtAt(0), 380);
      return () => window.clearTimeout(id);
    }
  }, [hurt]);
  const killedBy = useMemo(() => latest(events, (e) => e.kind === "kill" && e.on === LOCAL_ID), [events]);

  // ── Killfeed (recent kills only) ───────────────────────────────────────
  const now = Date.now();
  const kills = useMemo(() => {
    const out: Array<{ ev: GameEvent; key: string }> = [];
    for (let i = events.length - 1; i >= 0 && out.length < 5; i--) {
      const e = events[i];
      if (e.kind === "kill") out.push({ ev: e, key: `${e.t}|${e.by}|${e.on}` });
    }
    return out;
  }, [events]);
  const visibleKills = kills.filter(({ ev }) => now - ev.t < KILLFEED_MS && ev.t >= roundStartedAt);
  useTick(1000, visibleKills.length > 0);

  const inMatch = phase !== "warmup";
  const showDeath = !alive && !!local && phase !== "match_end";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        fontFamily: BODY,
        fontSize: 13,
        color: C.ink,
        userSelect: "none",
        overflow: "hidden",
        opacity: cinematic ? 0 : 1,
        transition: "opacity .35s ease-out",
      }}
    >
      <UiStyles />

      {/* ── Damage vignette + low-health edge ── */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse at center, rgba(255,40,40,0) 52%, rgba(255,30,50,0.5) 100%)",
          opacity: hurtAt ? 1 : alive && healthFrac <= 0.3 ? 0.45 : 0,
          transition: hurtAt ? "none" : "opacity 420ms ease-out",
        }}
      />

      {/* ── Death / spectating ── */}
      {showDeath ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(rgba(30,0,6,0.45), rgba(10,0,4,0.25) 40%, rgba(30,0,6,0.5))",
            animation: "vl-fade .3s ease-out",
          }}
        >
          <div style={{ position: "absolute", top: "28vh", left: 0, right: 0, textAlign: "center" }}>
            <div
              style={{
                fontFamily: DISPLAY,
                fontWeight: 800,
                fontSize: 54,
                letterSpacing: "0.2em",
                color: C.red,
                textShadow: "0 2px 20px rgba(0,0,0,.6)",
                animation: "vl-banner .45s cubic-bezier(.2,.9,.3,1)",
              }}
            >
              YOU DIED
            </div>
            {killedBy ? (
              <div style={{ fontSize: 14, letterSpacing: 2, marginTop: 2, color: C.inkDim }}>
                ELIMINATED BY{" "}
                <b style={{ color: TEAM_COLOR[teamOf(killedBy.by, entities)], fontFamily: DISPLAY, fontSize: 17, letterSpacing: 2 }}>
                  {displayName(killedBy.by, entities)}
                </b>
              </div>
            ) : null}
          </div>
          <div style={{ position: "absolute", bottom: 112, left: 0, right: 0, display: phase === "round_end" ? "none" : "flex", justifyContent: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 16px",
              ...panel,
              fontFamily: DISPLAY,
              letterSpacing: 3,
              animation: "vl-rise .4s .3s ease-out both",
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 4, background: C.red, animation: "vl-pulse 1.4s infinite" }} />
            {phase === "live" ? (
              <>
                <span style={{ fontWeight: 700, fontSize: 16 }}>SPECTATING</span>
                <span style={{ fontSize: 13, color: C.inkDim }}>WAITING FOR ROUND END</span>
              </>
            ) : (
              <span style={{ fontWeight: 700, fontSize: 16 }}>RESPAWNING…</span>
            )}
          </div>
          </div>
        </div>
      ) : null}

      {alive ? <DamageIndicator /> : null}
      {/* ── Crosshair + hitmarker ── */}
      <div style={{ position: "absolute", left: "50%", top: "50%", width: 0, height: 0 }}>
        {alive ? <Crosshair /> : null}
        {hit ? <Hitmarker key={hit.at} kill={hit.kill} /> : null}
      </div>

      {inMatch ? (
        <>
          <Scoreboard />
          <AgentChip />
          <NpcPanels />
          <RoundBanner />
          <AgentCard />
        </>
      ) : null}

      {/* ── Killfeed ── */}
      <div style={{ position: "absolute", top: 14, right: 16, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        {visibleKills.map(({ ev, key }) => {
          const mine = ev.by === LOCAL_ID || ev.on === LOCAL_ID;
          const kc = TEAM_COLOR[teamOf(ev.by, entities)];
          const vc = TEAM_COLOR[teamOf(ev.on, entities)];
          const age = now - ev.t;
          return (
            <div
              key={key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 10px",
                ...panel,
                background: mine ? "rgba(15,25,35,0.9)" : C.panel,
                outline: mine ? `1px solid ${ev.by === LOCAL_ID ? C.teal : C.red}aa` : "none",
                borderLeft: `3px solid ${kc}`,
                fontFamily: DISPLAY,
                fontWeight: 600,
                fontSize: 15,
                letterSpacing: 1.2,
                whiteSpace: "nowrap",
                opacity: age > KILLFEED_MS - 1000 ? 0.35 : 1,
                transition: "opacity .8s",
                animation: "vl-slide-l .25s ease-out",
              }}
            >
              <span style={{ color: kc }}>{displayName(ev.by, entities)}</span>
              <RifleIcon />
              <span style={{ color: vc }}>{displayName(ev.on, entities)}</span>
            </div>
          );
        })}
      </div>

      {/* ── Health ── */}
      {local ? (
        <div style={{ position: "absolute", left: 20, bottom: 20, display: "flex", alignItems: "stretch", ...panel }}>
          <div style={{ width: 3, background: alive ? healthColor(healthFrac) : C.inkFaint }} />
          <div style={{ padding: "8px 14px 10px", width: 200 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span
                style={{
                  fontFamily: DISPLAY,
                  fontWeight: 700,
                  fontSize: 40,
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                  color: alive ? healthColor(healthFrac) : C.inkFaint,
                }}
              >
                {alive ? Math.max(0, Math.round(health)) : 0}
              </span>
              <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 12, letterSpacing: 2.4, color: C.inkDim }}>HP</span>
            </div>
            <div style={{ height: 4, marginTop: 6, background: "rgba(236,232,225,0.12)" }}>
              <div
                style={{
                  height: "100%",
                  width: `${healthFrac * 100}%`,
                  background: alive ? healthColor(healthFrac) : C.inkFaint,
                  transition: "width 120ms linear, background 200ms linear",
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Ammo ── */}
      {local ? (
        <div style={{ position: "absolute", right: 20, bottom: 20, display: "flex", alignItems: "stretch", ...panel }}>
          <div style={{ padding: "8px 14px 10px", textAlign: "right", minWidth: 130 }}>
            <div style={{ fontVariantNumeric: "tabular-nums", lineHeight: 1, fontFamily: DISPLAY }}>
              <span
                style={{
                  fontSize: 40,
                  fontWeight: 700,
                  color: reloading ? C.inkFaint : ammo <= Math.ceil(MAG_SIZE / 4) ? C.red : C.ink,
                }}
              >
                {ammo}
              </span>
              <span style={{ fontSize: 20, fontWeight: 600, color: C.inkFaint }}> / {MAG_SIZE}</span>
            </div>
            <div style={{ display: "flex", gap: 2, justifyContent: "flex-end", marginTop: 6 }}>
              {Array.from({ length: MAG_SIZE }, (_, i) => (
                <span key={i} style={{ width: 4, height: 4, background: i < ammo ? C.ink : "rgba(236,232,225,0.15)" }} />
              ))}
            </div>
            {reloading ? (
              <div style={{ fontFamily: DISPLAY, fontSize: 12, letterSpacing: 2.4, color: C.amber, marginTop: 4, animation: "vl-pulse .8s infinite" }}>
                RELOADING
              </div>
            ) : ammo === 0 && alive ? (
              <div style={{ fontFamily: DISPLAY, fontSize: 12, letterSpacing: 2.4, color: C.red, marginTop: 4 }}>PRESS R</div>
            ) : null}
          </div>
          <div style={{ width: 3, background: C.ink }} />
        </div>
      ) : null}

      {/* ── Tiny hint during play ── */}
      {phase === "live" && alive ? (
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            fontFamily: DISPLAY,
            fontSize: 11,
            letterSpacing: 2,
            color: "rgba(236,232,225,0.6)",
            textShadow: "0 1px 3px rgba(0,0,0,.8)",
            whiteSpace: "nowrap",
          }}
        >
          ESC · CONTROLS &nbsp;&nbsp; TAB · SCORES
        </div>
      ) : null}

      <TabScoreboard />
    </div>
  );
}

// ── Crosshair — four arms + center dot, outlined so it reads on any bg. ───
function Crosshair() {
  const color = "rgba(255,255,255,0.95)";
  const gap = 4;
  const len = 6;
  const thick = 2;
  const arm = (style: React.CSSProperties): React.CSSProperties => ({
    position: "absolute",
    background: color,
    boxShadow: "0 0 0 1px rgba(0,0,0,0.55)",
    ...style,
  });
  return (
    <div style={{ position: "absolute", left: 0, top: 0 }}>
      <div style={arm({ left: -1, top: -1, width: 2, height: 2 })} />
      <div style={arm({ left: -thick / 2, top: -gap - len, width: thick, height: len })} />
      <div style={arm({ left: -thick / 2, top: gap, width: thick, height: len })} />
      <div style={arm({ top: -thick / 2, left: -gap - len, height: thick, width: len })} />
      <div style={arm({ top: -thick / 2, left: gap, height: thick, width: len })} />
    </div>
  );
}

// ── Hitmarker — a quick "✕" over the crosshair; red and larger on a kill. ──
function Hitmarker({ kill }: { kill: boolean }) {
  const size = kill ? 18 : 13;
  const stroke: React.CSSProperties = {
    position: "absolute",
    left: -1,
    top: -size / 2,
    width: 2,
    height: size,
    background: kill ? C.red : "#fff",
    boxShadow: "0 0 3px rgba(0,0,0,0.9)",
  };
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        animation: `vl-hit ${kill ? HITMARKER_MS * 2.5 : HITMARKER_MS}ms ease-out forwards`,
      }}
    >
      <div style={{ ...stroke, transform: "rotate(45deg)" }} />
      <div style={{ ...stroke, transform: "rotate(-45deg)" }} />
    </div>
  );
}

function RifleIcon() {
  return (
    <svg width="26" height="10" viewBox="0 0 26 10" style={{ opacity: 0.8 }} aria-hidden>
      <path d="M0 3h17l2-2h5v2h2v2h-6l-1 1h-4l-1 4h-3l1-4H6L4 7H0z" fill={C.ink} />
    </svg>
  );
}
