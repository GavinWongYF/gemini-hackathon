// Menu screens for the PC game. Shown whenever the mouse isn't captured:
//   • title screen on first load (phase "warmup")
//   • PAUSED after Esc, with RESUME
//   • the match end screen (phase "match_end")
// Clicking captures the mouse on the game canvas; RoundManager starts round 1
// on the first capture.

import { useEffect, useState } from "react";
import { useMatch, ROUNDS_TO_WIN } from "./match";
import { MatchEnd } from "./ui/MatchEnd";
import { PadChip, PadQrPanel } from "./PadHost";
import { useLookMode, usePadStatus } from "./playState";
import { requestGameLock } from "./input";

/** Capture the mouse (raw input, plain-lock fallback, then drag-look fallback).
 *  Runs inside the click handler, i.e. from a real user gesture. */
const lockPointer = () => requestGameLock();
import { C, DISPLAY, BODY, TEAM_COLOR, UiStyles, eyebrow } from "./ui/theme";

type Bind = { keys: string[]; action: string; or?: boolean };

const CONTROLS: { group: string; binds: Bind[] }[] = [
  {
    group: "Movement",
    binds: [
      { keys: ["W", "A", "S", "D"], action: "Move" },
      { keys: ["Shift"], action: "Walk — quiet, accurate" },
      { keys: ["Ctrl", "C"], action: "Crouch", or: true },
      { keys: ["Space"], action: "Jump" },
    ],
  },
  {
    group: "Combat",
    binds: [
      { keys: ["Mouse"], action: "Aim" },
      { keys: ["LMB"], action: "Fire (hold for auto)" },
      { keys: ["RMB"], action: "Aim down sights (hold)" },
      { keys: ["R"], action: "Reload" },
    ],
  },
  {
    group: "Other",
    binds: [
      { keys: ["Tab"], action: "Scoreboard (hold)" },
      { keys: ["[", "]"], action: "Mouse sensitivity", or: true },
      { keys: ["Esc"], action: "Pause" },
    ],
  },
];

const TIPS = [
  "Stop moving before you shoot — moving shots spray.",
  "Aim for the head: headshots do 2.5× damage.",
  "Tap or burst instead of holding — recoil grows the longer you spray.",
  "Crouch behind cover to reload and to win close duels.",
];

function Key({ k }: { k: string }) {
  const wide = k.length > 2;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: wide ? 0 : 26,
        height: 26,
        padding: wide ? "0 9px" : 0,
        background: "linear-gradient(#26313d, #1b242e)",
        border: "1px solid rgba(236,232,225,0.22)",
        borderBottomWidth: 3,
        borderRadius: 4,
        fontFamily: DISPLAY,
        fontWeight: 700,
        fontSize: 13,
        letterSpacing: 0.6,
        color: C.ink,
        whiteSpace: "nowrap",
      }}
    >
      {k}
    </span>
  );
}

function ControlsCard() {
  return (
    <div
      style={{
        background: "rgba(15,25,35,0.82)",
        border: `1px solid ${C.line}`,
        padding: "16px 18px",
        animation: "vl-slide-l .5s .15s ease-out both",
      }}
    >
      <div style={{ ...eyebrow, color: C.ink, fontSize: 13, marginBottom: 6 }}>Controls</div>
      {CONTROLS.map((g) => (
        <div key={g.group} style={{ marginTop: 10 }}>
          <div style={{ ...eyebrow, fontSize: 10.5, color: C.red, marginBottom: 6 }}>{g.group}</div>
          {g.binds.map((b) => (
            <div key={b.action} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "3px 0" }}>
              <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {b.keys.map((k, i) => (
                  <span key={k} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    {i > 0 && b.or ? <span style={{ fontSize: 11, color: C.inkFaint }}>/</span> : null}
                    <Key k={k} />
                  </span>
                ))}
              </span>
              <span style={{ fontSize: 13.5, color: C.inkDim, textAlign: "right" }}>{b.action}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Tips({ count }: { count: number }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ ...eyebrow, marginBottom: 6 }}>Winning fights</div>
      {TIPS.slice(0, count).map((t, i) => (
        <div key={i} style={{ display: "flex", gap: 10, fontSize: 14, lineHeight: 1.45, color: C.inkDim, marginTop: 3 }}>
          <span style={{ color: C.teal, fontFamily: DISPLAY, fontWeight: 700 }}>{String(i + 1).padStart(2, "0")}</span>
          <span>{t}</span>
        </div>
      ))}
    </div>
  );
}

export function StartOverlay() {
  const [locked, setLocked] = useState(!!document.pointerLockElement);
  const phase = useMatch((s) => s.phase);
  const round = useMatch((s) => s.round);
  const score = useMatch((s) => s.score);
  const padOn = usePadStatus((s) => s.pads > 0 && s.started); // phone controller playing
  const freeLook = useLookMode((s) => s.freeLook); // pointer lock refused → drag-look
  const lockFails = useLookMode((s) => s.lockFails);

  useEffect(() => {
    const onChange = () => {
      const isLocked = !!document.pointerLockElement;
      setLocked(isLocked); // RoundManager starts round 1 on the first capture
    };
    document.addEventListener("pointerlockchange", onChange);
    return () => document.removeEventListener("pointerlockchange", onChange);
  }, []);

  if (phase === "match_end") {
    return (
      <>
        <UiStyles />
        <MatchEnd />
      </>
    );
  }
  if (freeLook) {
    // Pointer lock unavailable: playing uncaptured with drag-to-look.
    return (
      <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 20, pointerEvents: "none", padding: "6px 14px", background: "rgba(10,16,24,0.7)", border: `1px solid ${C.line}`, fontFamily: BODY, fontSize: 13, color: C.ink, letterSpacing: 0.5 }}>
        Mouse capture unavailable — <b>hold a mouse button and drag</b> to look · Esc to pause
      </div>
    );
  }
  if (locked || padOn) return null;

  const paused = phase !== "warmup";

  return (
    <div
      onClick={lockPointer}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: paused
          ? "rgba(10,16,24,0.72)"
          : "linear-gradient(100deg, rgba(10,16,24,0.95) 0%, rgba(10,16,24,0.86) 48%, rgba(10,16,24,0.55) 100%)",
        backdropFilter: "blur(5px)",
        cursor: "pointer",
        fontFamily: BODY,
        color: C.ink,
        userSelect: "none",
        overflowY: "auto",
      }}
    >
      <UiStyles />
      <div
        style={{
          width: "min(1000px, calc(100vw - 32px))",
          display: "flex",
          flexWrap: "wrap",
          gap: "28px 56px",
          alignItems: "center",
          padding: "24px 0",
        }}
      >
        {/* left: title + call to action */}
        <div style={{ flex: "1 1 400px", minWidth: 0, animation: "vl-rise .5s ease-out both" }}>
          {paused ? (
            <>
              <div style={{ ...eyebrow, letterSpacing: 5 }}>
                ROUND {round} · <span style={{ color: TEAM_COLOR.blue }}>{score.blue}</span> — <span style={{ color: TEAM_COLOR.red }}>{score.red}</span>
              </div>
              <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: "clamp(64px, 9vw, 104px)", lineHeight: 0.95, letterSpacing: "0.06em", marginTop: 6 }}>
                PAUSED
              </div>
              <div style={{ fontSize: 15, color: C.inkDim, marginTop: 10 }}>The match is frozen until you get back in.</div>
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 28, height: 3, background: C.red }} />
                <span style={{ ...eyebrow, letterSpacing: 5, color: C.ink }}>TACTICAL FPS · BROWSER</span>
              </div>
              <div
                style={{
                  fontFamily: DISPLAY,
                  fontWeight: 800,
                  fontSize: "clamp(88px, 14vw, 168px)",
                  lineHeight: 0.86,
                  letterSpacing: "0.04em",
                  marginTop: 10,
                  marginLeft: -4,
                }}
              >
                VAL<span style={{ color: C.red }}>O</span>R
              </div>
              <div style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 22, letterSpacing: 4, marginTop: 12 }}>
                <span style={{ color: TEAM_COLOR.blue }}>3</span>
                <span style={{ color: C.inkFaint }}> v </span>
                <span style={{ color: TEAM_COLOR.red }}>3</span>
                <span style={{ color: C.inkFaint }}> · </span>
                FIRST TO {ROUNDS_TO_WIN} ROUNDS
              </div>
              <div style={{ fontSize: 15, lineHeight: 1.5, color: C.inkDim, marginTop: 12, maxWidth: 440 }}>
                You and two teammates against three enemies. No respawns inside a round. Between rounds the enemy team
                studies how you won and changes its plan.
              </div>
            </>
          )}

          <button
            className="vl-btn"
            onClick={(e) => {
              e.stopPropagation();
              lockPointer();
            }}
            style={{
              marginTop: 28,
              padding: "16px 52px",
              border: "none",
              background: C.red,
              color: C.ink,
              fontFamily: DISPLAY,
              fontWeight: 700,
              fontSize: 20,
              letterSpacing: 4,
              cursor: "pointer",
              clipPath: "polygon(12px 0, 100% 0, calc(100% - 12px) 100%, 0 100%)",
              boxShadow: "0 10px 30px rgba(255,70,85,0.25)",
            }}
          >
            {paused ? "RESUME" : "CLICK TO PLAY"}
          </button>
          <div style={{ fontSize: 12, color: C.inkFaint, marginTop: 10, letterSpacing: 1 }}>
            {lockFails > 0
              ? "Mouse capture was refused — click once more (it can take a second after Esc)"
              : paused
                ? "Click anywhere to resume"
                : "Your mouse will be captured — press Esc any time to pause"}
          </div>

          {paused && <PadChip />}
          <Tips count={paused ? 2 : 3} />
        </div>

        {/* right: controls */}
        <div style={{ flex: "0 1 360px", minWidth: 280 }}>
          <ControlsCard />
          {!paused && <PadQrPanel />}
        </div>
      </div>
    </div>
  );
}
