// Round banners in the upper third of the screen (never over the crosshair):
//   (the round start — "ROUND 2", MATCH POINT, 3·2·1·GO — is the pre-round
//    intro now: Countdown.tsx + IntroCamera.tsx)
//   round_end     → "ROUND WON" / "ROUND LOST" with how it went, until next round
// match_end is handled by the full MatchEnd screen.

import { useMatch } from "../match";
import { C, DISPLAY, TEAM_COLOR, humanize } from "./theme";

interface Banner {
  key: string;
  title: string;
  sub: string;
  color: string;
}

export function RoundBanner() {
  const phase = useMatch((s) => s.phase);
  const round = useMatch((s) => s.round);
  const banner = useMatch((s) => s.banner);
  const lastRound = useMatch((s) => s.lastRound);

  let b: Banner | null = null;
  if (phase === "round_end") {
    const won = lastRound ? lastRound.winner === "blue" : banner === "ROUND WON";
    b = {
      key: `end${round}`,
      title: banner ?? (won ? "ROUND WON" : "ROUND LOST"),
      sub: lastRound?.how ? humanize(lastRound.how).toUpperCase() : "",
      color: won ? TEAM_COLOR.blue : TEAM_COLOR.red,
    };
  }
  if (!b) return null;

  return (
    <div
      key={b.key}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: "16vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        animation: "vl-fade .2s ease-out",
      }}
    >
      <div style={{ position: "relative", padding: "6px 0", width: "100%", display: "flex", justifyContent: "center" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `linear-gradient(90deg, transparent, ${b.color}2a 30%, ${b.color}2a 70%, transparent), linear-gradient(90deg, transparent, rgba(15,25,35,.62) 22%, rgba(15,25,35,.62) 78%, transparent)`,
            animation: "vl-band .35s ease-out",
          }}
        />
        <div
          style={{
            position: "relative",
            fontFamily: DISPLAY,
            fontWeight: 800,
            fontSize: "clamp(40px, 6vw, 76px)",
            letterSpacing: "0.14em",
            color: b.color,
            textShadow: `0 2px 18px rgba(0,0,0,.55), 0 0 30px ${b.color}44`,
            animation: "vl-banner .45s cubic-bezier(.2,.9,.3,1)",
          }}
        >
          {b.title}
        </div>
      </div>
      {b.sub ? (
        <div
          style={{
            marginTop: 6,
            fontFamily: DISPLAY,
            fontWeight: 600,
            fontSize: 15,
            letterSpacing: 4,
            color: C.ink,
            textShadow: "0 1px 3px rgba(0,0,0,.9), 0 0 12px rgba(0,0,0,.6)",
            animation: "vl-rise .5s .15s ease-out both",
          }}
        >
          {b.sub}
        </div>
      ) : null}
    </div>
  );
}
