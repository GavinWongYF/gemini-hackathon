// Pre-round intro overlay (match phase "intro", timeline in ../intro.ts):
//   overview  cinematic letterbox, "ROUND n" + score up top, the two line-ups
//             along the bottom (YOUR TEAM — VS — ENEMY)
//   3 · 2 · 1 big centred numbers that punch in once a second
//   GO        teal flash for ~0.8 s as the round goes live
// The 3D name tags over each player live in IntroCamera.tsx.

import { useGame } from "../stores";
import { ROUNDS_TO_WIN, useMatch, type Team } from "../match";
import { useIntro } from "../intro";
import { displayName, membersOf } from "./roster";
import { C, DISPLAY, TEAM_COLOR, UiStyles } from "./theme";

const COUNT_CSS = `
@keyframes vl-count { 0% { opacity: 0; transform: scale(2.1) } 18% { opacity: 1; transform: scale(.94) } 30% { transform: scale(1) } 82% { opacity: 1 } 100% { opacity: 0; transform: scale(.88) } }
@keyframes vl-go { 0% { opacity: 0; transform: scale(.6); letter-spacing: .05em } 25% { opacity: 1; transform: scale(1.08) } 100% { opacity: 0; transform: scale(1.35); letter-spacing: .3em } }
@keyframes vl-ring { 0% { opacity: .8; transform: scale(.4) } 100% { opacity: 0; transform: scale(1.9) } }
@keyframes vl-bar-t { from { transform: translateY(-100%) } to { transform: none } }
@keyframes vl-bar-b { from { transform: translateY(100%) } to { transform: none } }
`;

const TOP_BAR = "12vh";
const BOTTOM_BAR = "16vh";

export function Countdown() {
  const stage = useIntro((s) => s.stage);
  const count = useIntro((s) => s.count);
  const round = useMatch((s) => s.round);
  const score = useMatch((s) => s.score);
  const entities = useGame((s) => s.entities);
  if (stage === "none") return null;

  const final = score.blue === ROUNDS_TO_WIN - 1 && score.red === ROUNDS_TO_WIN - 1;
  const point = !final && (score.blue === ROUNDS_TO_WIN - 1 || score.red === ROUNDS_TO_WIN - 1);
  const sub = final ? "FINAL ROUND" : point ? "MATCH POINT" : `FIRST TO ${ROUNDS_TO_WIN}`;
  const overview = stage === "overview";
  const cinematic = overview || stage === "fly";

  return (
    <div data-testid="intro-overlay" data-stage={stage} style={{ position: "absolute", inset: 0, zIndex: 12, pointerEvents: "none", userSelect: "none", overflow: "hidden" }}>
      <UiStyles />
      <style>{COUNT_CSS}</style>

      {/* letterbox bars (overview + fly-down) */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: TOP_BAR, background: "linear-gradient(#05080c, rgba(5,8,12,.88))", transform: cinematic ? "none" : "translateY(-100%)", transition: "transform .45s ease-in-out", animation: "vl-bar-t .45s ease-out" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: BOTTOM_BAR, background: "linear-gradient(rgba(5,8,12,.88), #05080c)", transform: cinematic ? "none" : "translateY(100%)", transition: "transform .45s ease-in-out", animation: "vl-bar-b .45s ease-out" }} />

      {/* round header (inside the top bar) */}
      {overview ? (
        <div style={{ position: "absolute", top: 0, height: TOP_BAR, left: 16, right: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: "clamp(10px, 2.5vw, 28px)", animation: "vl-drop .45s ease-out both" }}>
          <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: "clamp(22px, 3vw, 34px)", color: TEAM_COLOR.blue, fontVariantNumeric: "tabular-nums" }}>{score.blue}</span>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div data-testid="intro-round" style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: "clamp(30px, 4.6vw, 54px)", letterSpacing: "0.16em", lineHeight: 1, color: C.ink, animation: "vl-banner .5s cubic-bezier(.2,.9,.3,1) both" }}>
              ROUND {round}
            </div>
            <div style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 12, letterSpacing: 5, marginTop: 2, color: final || point ? C.amber : C.inkDim }}>{sub}</div>
          </div>
          <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: "clamp(22px, 3vw, 34px)", color: TEAM_COLOR.red, fontVariantNumeric: "tabular-nums" }}>{score.red}</span>
        </div>
      ) : null}

      {/* line-ups */}
      {overview ? (
        <div style={{ position: "absolute", bottom: 0, height: BOTTOM_BAR, left: 16, right: 16, display: "flex", justifyContent: "center", alignItems: "center", gap: "clamp(12px, 4vw, 48px)" }}>
          <Lineup team="blue" title="YOUR TEAM" names={membersOf("blue", entities).map((e) => displayName(e.id, entities))} />
          <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 28, letterSpacing: 2, color: C.inkFaint, paddingTop: 22, animation: "vl-fade .4s .3s both" }}>VS</div>
          <Lineup team="red" title="ENEMY" names={membersOf("red", entities).map((e) => displayName(e.id, entities))} />
        </div>
      ) : null}

      {/* 3 · 2 · 1 · GO */}
      {count ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: "50%", transform: "translateY(-58%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
          {count !== "GO" ? (
            <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 15, letterSpacing: 5, color: C.ink, padding: "3px 14px", background: "rgba(10,16,24,.62)", marginBottom: 6 }}>
              ROUND {round} · {sub}
            </div>
          ) : null}
          <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div key={`ring${count}`} style={{ position: "absolute", width: 220, height: 220, borderRadius: "50%", border: `3px solid ${count === "GO" ? C.teal : "rgba(236,232,225,.7)"}`, animation: "vl-ring .7s ease-out both" }} />
            <div
              key={count}
              data-testid="intro-count"
              style={{
                fontFamily: DISPLAY,
                fontWeight: 800,
                fontSize: count === "GO" ? "clamp(110px, 17vw, 210px)" : "clamp(130px, 20vw, 250px)",
                lineHeight: 1,
                color: count === "GO" ? C.teal : C.ink,
                textShadow: count === "GO" ? `0 0 40px ${C.teal}aa, 0 4px 30px rgba(0,0,0,.6)` : "0 4px 30px rgba(0,0,0,.65), 0 0 2px rgba(0,0,0,.9)",
                animation: count === "GO" ? "vl-go .8s ease-out both" : "vl-count 1s cubic-bezier(.2,.9,.3,1) both",
              }}
            >
              {count}
            </div>
          </div>
          {count !== "GO" && stage === "count" ? (
            <div style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 13, letterSpacing: 3, color: C.ink, padding: "2px 12px", background: "rgba(10,16,24,.55)", marginTop: 4 }}>LOOK AROUND · MOVE ON GO</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Lineup({ team, title, names }: { team: Team; title: string; names: string[] }) {
  const color = TEAM_COLOR[team];
  const mirror = team === "red";
  return (
    <div data-testid={`intro-lineup-${team}`} style={{ minWidth: 0, flex: "0 1 300px", animation: `${mirror ? "vl-slide-l" : "vl-rise"} .45s ${mirror ? ".35s" : ".1s"} ease-out both` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexDirection: mirror ? "row-reverse" : "row", marginBottom: 6 }}>
        <span style={{ width: 22, height: 3, background: color }} />
        <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 18, letterSpacing: 4, color }}>{title}</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexDirection: mirror ? "row-reverse" : "row" }}>
        {names.map((n) => {
          const you = n === "YOU";
          return (
            <div
              key={n}
              style={{
                flex: "1 1 0",
                minWidth: 0,
                padding: "6px 10px",
                background: you ? C.amber : "rgba(10,16,24,0.82)",
                borderTop: `3px solid ${you ? C.amber : color}`,
                fontFamily: DISPLAY,
                fontWeight: 700,
                fontSize: 16,
                letterSpacing: 2,
                color: you ? "#1a1204" : C.ink,
                textAlign: "center",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {n}
            </div>
          );
        })}
      </div>
    </div>
  );
}
