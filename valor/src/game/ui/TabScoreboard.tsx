// Hold TAB: full scoreboard with both teams, alive/dead, kills and deaths.

import { useEffect, useState } from "react";
import { LOCAL_ID, MAX_HEALTH, type Entity } from "../contracts";
import { useGame } from "../stores";
import { useMatch, ROUNDS_TO_WIN, TEAM_SIZE, type Team } from "../match";
import { displayName, membersOf, useTally } from "./roster";
import { C, DISPLAY, BODY, TEAM_COLOR, TEAM_LABEL, eyebrow, panel } from "./theme";

function useTabHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Tab") {
        e.preventDefault();
        setHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Tab") setHeld(false);
    };
    const blur = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return held;
}

const COLS = "1fr 64px 44px 44px";

function TeamTable({ team, entities, score }: { team: Team; entities: Record<string, Entity>; score: number }) {
  const kills = useTally((s) => s.kills);
  const deaths = useTally((s) => s.deaths);
  const members = membersOf(team, entities);
  const color = TEAM_COLOR[team];
  const rows: (Entity | null)[] = [...members];
  while (rows.length < TEAM_SIZE) rows.push(null);

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, borderBottom: `2px solid ${color}`, paddingBottom: 4 }}>
        <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 26, color, minWidth: 22 }}>{score}</span>
        <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 16, letterSpacing: 3, color }}>
          {TEAM_LABEL[team]} · {team === "blue" ? "YOUR TEAM" : "ENEMY"}
        </span>
        <span style={{ marginLeft: "auto", display: "grid", gridTemplateColumns: "64px 44px 44px", ...eyebrow, fontSize: 10.5, textAlign: "right" }}>
          <span>STATUS</span>
          <span>K</span>
          <span>D</span>
        </span>
      </div>
      {rows.map((m, i) => {
        const isYou = m?.id === LOCAL_ID;
        const hpFrac = m ? Math.max(0, m.health) / MAX_HEALTH : 0;
        return (
          <div
            key={m?.id ?? `empty${i}`}
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              alignItems: "center",
              padding: "7px 8px",
              background: isYou ? `${color}1f` : i % 2 ? "rgba(255,255,255,0.025)" : "transparent",
              borderLeft: `3px solid ${m?.alive ? color : "transparent"}`,
              opacity: m ? (m.alive ? 1 : 0.5) : 0.3,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 16, letterSpacing: 1.5, color: C.ink }}>
              {m ? displayName(m.id, entities) : "—"}
              {isYou ? <span style={{ marginLeft: 8, fontSize: 11, color }}>●</span> : null}
            </span>
            <span style={{ textAlign: "right", fontSize: 12, letterSpacing: 1, color: m?.alive ? C.inkDim : C.red }}>
              {!m ? "" : m.alive ? (
                <span style={{ display: "inline-block", width: 44, height: 4, background: "rgba(255,255,255,0.12)", verticalAlign: "middle" }}>
                  <span style={{ display: "block", height: "100%", width: `${hpFrac * 100}%`, background: color }} />
                </span>
              ) : (
                "DEAD"
              )}
            </span>
            <span style={{ textAlign: "right", fontSize: 15, fontWeight: 700 }}>{m ? kills[m.id] ?? 0 : ""}</span>
            <span style={{ textAlign: "right", fontSize: 15, color: C.inkDim }}>{m ? deaths[m.id] ?? 0 : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

export function TabScoreboard() {
  const held = useTabHeld();
  const entities = useGame((s) => s.entities);
  const score = useMatch((s) => s.score);
  const round = useMatch((s) => s.round);
  const phase = useMatch((s) => s.phase);
  if (!held || phase === "match_end") return null;

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: "min(560px, calc(100vw - 32px))",
        padding: "16px 22px 20px",
        ...panel,
        background: C.panelSolid,
        fontFamily: BODY,
        color: C.ink,
        animation: "vl-fade .12s ease-out",
        zIndex: 5,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 22, letterSpacing: 4 }}>SCOREBOARD</span>
        <span style={{ ...eyebrow }}>
          ROUND {round} · FIRST TO {ROUNDS_TO_WIN}
        </span>
      </div>
      <TeamTable team="blue" entities={entities} score={score.blue} />
      <TeamTable team="red" entities={entities} score={score.red} />
    </div>
  );
}
