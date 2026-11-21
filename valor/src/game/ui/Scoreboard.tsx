// Top-center match bar: alive pips · BLUE score · round + clock · RED score · pips.

import { useEffect, useState } from "react";
import { LOCAL_ID, type Entity } from "../contracts";
import { useGame } from "../stores";
import { TEAM_SIZE, useMatch, type Team } from "../match";
import { membersOf } from "./roster";
import { C, DISPLAY, TEAM_COLOR, panel } from "./theme";

function useClock(running: boolean, since: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [running]);
  const s = running && since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Pips({ team, members, mirror }: { team: Team; members: Entity[]; mirror?: boolean }) {
  const slots: (Entity | null)[] = [...members.slice(0, TEAM_SIZE)];
  while (slots.length < TEAM_SIZE) slots.push(null);
  if (mirror) slots.reverse();
  const color = TEAM_COLOR[team];
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "flex-end", padding: "0 10px" }}>
      {slots.map((m, i) => {
        const alive = !!m?.alive;
        return (
          <div
            key={m?.id ?? `empty${i}`}
            title={m?.id}
            style={{
              position: "relative",
              width: 9,
              height: 20,
              background: m ? (alive ? color : "rgba(236,232,225,0.12)") : "transparent",
              border: m ? "none" : `1px dashed ${C.inkFaint}`,
              boxShadow: alive ? `0 0 8px ${color}66` : "none",
              transform: "skewX(-12deg)",
              transition: "background .25s",
              borderBottom: m?.id === LOCAL_ID ? `2px solid ${C.ink}` : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

function Score({ team, value }: { team: Team; value: number }) {
  return (
    <div
      style={{
        minWidth: 54,
        textAlign: "center",
        fontFamily: DISPLAY,
        fontWeight: 700,
        fontSize: 34,
        lineHeight: "44px",
        color: TEAM_COLOR[team],
        textShadow: `0 0 14px ${TEAM_COLOR[team]}55`,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {value}
    </div>
  );
}

export function Scoreboard() {
  const entities = useGame((s) => s.entities);
  const phase = useMatch((s) => s.phase);
  const round = useMatch((s) => s.round);
  const score = useMatch((s) => s.score);
  const since = useMatch((s) => s.roundStartedAt);
  const clock = useClock(phase === "live", since);

  const blue = membersOf("blue", entities);
  const red = membersOf("red", entities);

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        animation: "vl-drop .4s ease-out",
      }}
    >
      <Pips team="blue" members={blue} mirror />
      <div style={{ display: "flex", alignItems: "stretch", ...panel, clipPath: "polygon(10px 0, calc(100% - 10px) 0, 100% 100%, 0 100%)" }}>
        <div style={{ width: 3, background: TEAM_COLOR.blue }} />
        <Score team="blue" value={score.blue} />
        <div
          style={{
            padding: "4px 16px",
            borderLeft: `1px solid ${C.line}`,
            borderRight: `1px solid ${C.line}`,
            textAlign: "center",
            fontFamily: DISPLAY,
            minWidth: 74,
          }}
        >
          <div style={{ fontSize: 11, letterSpacing: 2.2, color: C.inkDim, fontWeight: 600 }}>ROUND {round}</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: C.ink, fontVariantNumeric: "tabular-nums", lineHeight: "22px" }}>
            {phase === "live" ? clock : phase === "warmup" ? "—" : phase === "intro" ? "READY" : phase === "match_end" ? "END" : "NEXT"}
          </div>
        </div>
        <Score team="red" value={score.red} />
        <div style={{ width: 3, background: TEAM_COLOR.red }} />
      </div>
      <Pips team="red" members={red} />
    </div>
  );
}
