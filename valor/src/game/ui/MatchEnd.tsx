// Full-screen match end: VICTORY / DEFEAT, final score, round-by-round history,
// what the enemy AI learned, and PLAY AGAIN.

import { useEffect } from "react";
import { LOCAL_ID } from "../contracts";
import { useMatch } from "../match";
import { useTally } from "./roster";
import { AgentSummary } from "./AgentCard";
import { restartMatch, lockPointer } from "./restart";
import { C, DISPLAY, BODY, TEAM_COLOR, eyebrow, humanize } from "./theme";

export function MatchEnd() {
  const score = useMatch((s) => s.score);
  const history = useMatch((s) => s.history);
  const kills = useTally((s) => s.kills[LOCAL_ID] ?? 0);
  const deaths = useTally((s) => s.deaths[LOCAL_ID] ?? 0);
  const won = score.blue > score.red;
  const color = won ? TEAM_COLOR.blue : TEAM_COLOR.red;

  // Free the mouse so the player can click PLAY AGAIN.
  useEffect(() => {
    if (document.pointerLockElement) document.exitPointerLock();
  }, []);

  const playAgain = (e: React.MouseEvent) => {
    e.stopPropagation();
    restartMatch();
    lockPointer();
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        display: "flex",
        background: `radial-gradient(ellipse at 50% 22%, ${color}22 0%, rgba(10,16,24,0.93) 50%, rgba(10,16,24,0.97) 100%)`,
        backdropFilter: "blur(4px)",
        fontFamily: BODY,
        color: C.ink,
        userSelect: "none",
        animation: "vl-fade .5s ease-out",
        overflowY: "auto",
      }}
    >
      <div style={{ width: "min(760px, calc(100vw - 32px))", textAlign: "center", padding: "20px 0", margin: "auto" }}>
        <div style={{ ...eyebrow, letterSpacing: 6 }}>MATCH OVER</div>
        <div
          style={{
            fontFamily: DISPLAY,
            fontWeight: 800,
            fontSize: "clamp(60px, min(10vw, 15vh), 128px)",
            lineHeight: 1,
            letterSpacing: "0.12em",
            color,
            textShadow: `0 0 40px ${color}55`,
            animation: "vl-banner .7s cubic-bezier(.2,.9,.3,1)",
            marginTop: 6,
          }}
        >
          {won ? "VICTORY" : "DEFEAT"}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 18,
            marginTop: 10,
            fontFamily: DISPLAY,
            fontWeight: 700,
            fontSize: 44,
            fontVariantNumeric: "tabular-nums",
            animation: "vl-rise .5s .3s ease-out both",
          }}
        >
          <span style={{ fontSize: 13, letterSpacing: 3, color: TEAM_COLOR.blue }}>BLUE</span>
          <span style={{ color: TEAM_COLOR.blue }}>{score.blue}</span>
          <span style={{ color: C.inkFaint, fontSize: 28 }}>—</span>
          <span style={{ color: TEAM_COLOR.red }}>{score.red}</span>
          <span style={{ fontSize: 13, letterSpacing: 3, color: TEAM_COLOR.red }}>RED</span>
        </div>
        <div style={{ fontSize: 13, color: C.ink, opacity: 0.8, letterSpacing: 1.5, animation: "vl-rise .5s .4s ease-out both" }}>
          YOUR K / D · <b style={{ color: C.ink }}>{kills}</b> / {deaths}
        </div>

        {/* round history */}
        <div style={{ marginTop: 18, animation: "vl-rise .5s .5s ease-out both" }}>
          <div style={{ ...eyebrow, marginBottom: 8 }}>ROUNDS</div>
          <div style={{ display: "flex", justifyContent: "center", gap: 6, flexWrap: "wrap" }}>
            {history.map((r) => {
              const c = TEAM_COLOR[r.winner];
              return (
                <div
                  key={r.round}
                  title={`${humanize(r.how)} · ${Math.round(r.durationSec)}s`}
                  style={{
                    width: 84,
                    padding: "8px 6px",
                    background: `${c}14`,
                    borderTop: `3px solid ${c}`,
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 13, letterSpacing: 2, color: C.inkDim }}>R{r.round}</div>
                  <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 18, letterSpacing: 2, color: c }}>
                    {r.winner === "blue" ? "WON" : "LOST"}
                  </div>
                  <div style={{ fontSize: 11, color: C.inkDim, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.how ? humanize(r.how) : `${Math.round(r.durationSec)}s`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* what the AI learned */}
        <div
          style={{
            margin: "18px auto 0",
            width: "min(460px, 100%)",
            textAlign: "left",
            padding: "12px 16px",
            background: "rgba(255,255,255,0.04)",
            borderLeft: `2px solid ${C.red}`,
            animation: "vl-rise .5s .6s ease-out both",
          }}
        >
          <AgentSummary compact />
        </div>

        <button
          className="vl-btn"
          onClick={playAgain}
          style={{
            marginTop: 22,
            padding: "15px 54px",
            border: "none",
            background: C.red,
            color: C.ink,
            fontFamily: DISPLAY,
            fontWeight: 700,
            fontSize: 20,
            letterSpacing: 4,
            cursor: "pointer",
            clipPath: "polygon(12px 0, 100% 0, calc(100% - 12px) 100%, 0 100%)",
            animation: "vl-rise .5s .75s ease-out both",
          }}
        >
          PLAY AGAIN
        </button>
      </div>
    </div>
  );
}
