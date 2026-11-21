// Shared look for the PC game's UI: colours, type, and the keyframes every
// overlay uses. Valorant-ish: off-white ink on dark navy, red for the enemy,
// teal for your team, flat panels with hard edges.

import type { CSSProperties } from "react";
import type { Team } from "../match";

export const C = {
  ink: "#ece8e1",
  inkDim: "rgba(236,232,225,0.62)",
  inkFaint: "rgba(236,232,225,0.32)",
  navy: "#0f1923",
  panel: "rgba(15,25,35,0.78)",
  panelSolid: "rgba(15,25,35,0.94)",
  line: "rgba(236,232,225,0.14)",
  red: "#ff4655",
  teal: "#33e0c4",
  amber: "#f5b942",
};

export const TEAM_COLOR: Record<Team, string> = { blue: C.teal, red: C.red };
export const TEAM_LABEL: Record<Team, string> = { blue: "BLUE", red: "RED" };

export const DISPLAY = "'Barlow Condensed', 'Oswald', 'Arial Narrow', 'Roboto Condensed', sans-serif";
export const BODY = "'Barlow', 'Segoe UI', system-ui, -apple-system, sans-serif";

export const panel: CSSProperties = {
  background: C.panel,
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
};

/** Small uppercase label used for section titles. */
export const eyebrow: CSSProperties = {
  fontFamily: DISPLAY,
  fontWeight: 600,
  fontSize: 12,
  letterSpacing: 2.4,
  textTransform: "uppercase",
  color: C.inkDim,
};

/** Turns an agent/round tag like "flank_left" into "flank left". */
export function humanize(tag: string): string {
  return tag.replace(/[_.-]+/g, " ").trim();
}

/** Keyframes shared by all overlays. Mounted once by the HUD and the menus
 *  (two identical <style> tags are harmless). */
export function UiStyles() {
  return (
    <style>{`
@keyframes vl-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes vl-rise { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
@keyframes vl-drop { from { opacity: 0; transform: translateY(-10px) } to { opacity: 1; transform: none } }
@keyframes vl-banner { 0% { opacity: 0; transform: scale(1.18); letter-spacing: 0.5em } 60% { opacity: 1 } 100% { opacity: 1; transform: none } }
@keyframes vl-band { from { transform: scaleX(0) } to { transform: scaleX(1) } }
@keyframes vl-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
@keyframes vl-ping { 0% { box-shadow: 0 0 0 0 rgba(51,224,196,.55) } 100% { box-shadow: 0 0 0 10px rgba(51,224,196,0) } }
@keyframes vl-shimmer { from { background-position: -200px 0 } to { background-position: 200px 0 } }
@keyframes vl-hit { 0% { transform: scale(1.6); opacity: 1 } 100% { transform: scale(.9); opacity: 0 } }
@keyframes vl-slide-l { from { opacity: 0; transform: translateX(24px) } to { opacity: 1; transform: none } }
.vl-btn { transition: background .15s, color .15s, transform .15s, box-shadow .15s; }
.vl-btn:hover { background: ${C.ink} !important; color: ${C.navy} !important; transform: translateY(-1px); }
.vl-btn:active { transform: translateY(1px); }
`}</style>
  );
}
