// The adaptive-enemy story on screen.
//   <AgentCard/>  — between rounds: what the agents noticed about you, what the
//                   enemy will do differently, the mode chip, and anything the
//                   game's self-check refused. Sits low on screen, off-center
//                   of the crosshair.
//   <AgentChip/>  — during live play: one tiny line in the top-left corner.

import { useEffect, useRef, useState } from "react";
import { useAgentStatus, type AgentMode } from "../../agent/status";
import { useMatch } from "../match";
import { C, DISPLAY, BODY, eyebrow, panel } from "./theme";

const MODE_LABEL: Record<AgentMode, string> = {
  baseline: "BASELINE",
  offline_standin: "OFFLINE STAND-IN",
  live_gemini: "LIVE GEMINI",
};
const MODE_COLOR: Record<AgentMode, string> = {
  baseline: C.inkDim,
  offline_standin: C.amber,
  live_gemini: C.teal,
};

export function ModeChip({ mode, small }: { mode: AgentMode; small?: boolean }) {
  const color = MODE_COLOR[mode];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: small ? "1px 6px" : "2px 8px",
        border: `1px solid ${color}88`,
        color,
        fontFamily: DISPLAY,
        fontWeight: 600,
        fontSize: small ? 10 : 11,
        letterSpacing: 1.6,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          background: color,
          animation: mode === "live_gemini" ? "vl-pulse 1.6s infinite" : undefined,
        }}
      />
      {MODE_LABEL[mode]}
    </span>
  );
}

function titleFor(mode: AgentMode, adapted: boolean): string {
  if (!adapted) return "ENEMY AI";
  if (mode === "live_gemini") return "GEMINI ADAPTED";
  return "ENEMY ADAPTED";
}

function Lines({ label, items, accent }: { label: string; items: string[]; accent: string }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ ...eyebrow, fontSize: 10.5 }}>{label}</div>
      {items.map((t, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            gap: 8,
            marginTop: 4,
            fontSize: 14,
            lineHeight: 1.35,
            color: C.ink,
            animation: `vl-rise .4s ${0.1 + i * 0.12}s ease-out both`,
          }}
        >
          <span style={{ color: accent, fontWeight: 700 }}>›</span>
          <span>{t}</span>
        </div>
      ))}
    </div>
  );
}

/** Card body, shared by the between-rounds card and the match end screen. */
export function AgentSummary({ compact }: { compact?: boolean }) {
  const mode = useAgentStatus((s) => s.mode);
  const observations = useAgentStatus((s) => s.observations);
  const plan = useAgentStatus((s) => s.plan);
  const rejected = useAgentStatus((s) => s.rejected);
  const version = useAgentStatus((s) => s.version);
  const connected = useAgentStatus((s) => s.connected);
  const adapted = observations.length > 0 || plan.length > 0;
  const n = compact ? 1 : 2;

  return (
    <div style={{ fontFamily: BODY }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 10, height: 10, background: C.red, transform: "rotate(45deg)" }} />
          <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, letterSpacing: 2.4, color: C.ink }}>
            {titleFor(mode, adapted)}
          </span>
          {version > 0 ? <span style={{ fontSize: 11, color: C.inkFaint, letterSpacing: 1 }}>v{version}</span> : null}
        </div>
        <ModeChip mode={mode} />
      </div>

      {adapted ? (
        <>
          <Lines label="What it noticed" items={observations.slice(0, n)} accent={C.teal} />
          <Lines label="Next round" items={plan.slice(0, n)} accent={C.red} />
        </>
      ) : mode === "baseline" && !connected ? (
        <div style={{ marginTop: 8, fontSize: 13.5, color: C.inkDim }}>Enemies are running their baseline tactics.</div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13.5, color: C.inkDim }}>Reviewing the last round…</div>
          <div
            style={{
              marginTop: 8,
              height: 3,
              background: `linear-gradient(90deg, transparent, ${C.teal}, transparent) no-repeat`,
              backgroundSize: "120px 3px",
              animation: "vl-shimmer 1.1s linear infinite",
            }}
          />
        </div>
      )}

      {rejected.length ? (
        <div style={{ marginTop: 10, fontSize: 12, color: C.amber, lineHeight: 1.35 }}>
          Self-check blocked: {rejected[0]}
          {rejected.length > 1 ? ` (+${rejected.length - 1} more)` : ""}
        </div>
      ) : null}
    </div>
  );
}

export function AgentCard() {
  const phase = useMatch((s) => s.phase);
  if (phase !== "round_end") return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 92, display: "flex", justifyContent: "center" }}>
    <div
      style={{
        width: "min(440px, calc(100vw - 32px))",
        padding: "12px 18px",
        borderTop: `2px solid ${C.red}`,
        ...panel,
        background: C.panelSolid,
        animation: "vl-rise .45s .25s ease-out both",
      }}
    >
      <AgentSummary />
    </div>
    </div>
  );
}

export function AgentChip() {
  const phase = useMatch((s) => s.phase);
  const mode = useAgentStatus((s) => s.mode);
  const version = useAgentStatus((s) => s.version);
  const prev = useRef(version);
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    if (version !== prev.current) {
      prev.current = version;
      setFresh(true);
      const id = window.setTimeout(() => setFresh(false), 5000);
      return () => window.clearTimeout(id);
    }
  }, [version]);

  if (phase !== "live") return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 14,
        left: 16,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        ...panel,
        background: "rgba(15,25,35,0.55)",
        fontFamily: DISPLAY,
        fontSize: 11,
        letterSpacing: 1.6,
        color: C.inkDim,
        animation: fresh ? "vl-ping 1.2s 3" : undefined,
      }}
    >
      ENEMY AI
      <ModeChip mode={mode} small />
      {version > 0 ? <span style={{ color: fresh ? C.teal : C.inkFaint }}>v{version}{fresh ? " · ADAPTED" : ""}</span> : null}
    </div>
  );
}
