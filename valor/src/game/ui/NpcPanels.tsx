// The agent server's own side panels, embedded in VALOR's play screen.
//
//   <npc-panel side="left">   short loop: how this player plays right now
//   <npc-panel side="right">  long loop: what the agents noticed and what they plan
//
// The custom elements come from the agent server (http://localhost:8000/screen/panels.js)
// and read its /watch stream themselves; both are pinned to VALOR's own match_id
// via the `match` attribute. Server down → the script fails to load (or draws
// nothing) and the rails stay invisible; we retry once the bridge connects.
// The rails sit at the screen edges, well clear of the crosshair.

import { createElement, useEffect, useRef, useState } from "react";
import { useAgentStatus } from "../../agent/status";
import { C, panel } from "./theme";

export const AGENT_HTTP = "http://localhost:8000";
const SCRIPT_ATTR = "data-npc-panels";

let loading: Promise<boolean> | null = null;
function loadPanels(): Promise<boolean> {
  if (typeof window === "undefined" || typeof customElements === "undefined") return Promise.resolve(false);
  if (customElements.get("npc-panel")) return Promise.resolve(true);
  if (loading) return loading;
  loading = new Promise<boolean>((resolve) => {
    document.querySelectorAll(`script[${SCRIPT_ATTR}]`).forEach((s) => s.remove());
    const s = document.createElement("script");
    s.type = "module";
    s.setAttribute(SCRIPT_ATTR, "");
    s.src = `${AGENT_HTTP}/screen/panels.js?t=${Date.now()}`;
    s.onload = () => resolve(!!customElements.get("npc-panel"));
    s.onerror = () => {
      loading = null; // allow a later retry
      resolve(false);
    };
    document.head.appendChild(s);
  });
  return loading;
}

function Rail({ side, matchId, style }: { side: "left" | "right"; matchId: string; style: React.CSSProperties }) {
  const ref = useRef<HTMLElement | null>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (matchId) el.setAttribute("match", matchId);
    else el.removeAttribute("match");
  }, [matchId]);

  // Only show the backing panel once the element actually drew something.
  useEffect(() => {
    const id = window.setInterval(() => {
      const root = ref.current?.shadowRoot;
      setDrawn(!!root && root.childElementCount > 0);
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        width: "clamp(220px, 21vw, 300px)",
        overflow: "hidden",
        color: C.ink,
        fontSize: 13,
        ...(drawn ? { ...panel, background: "rgba(15,25,35,0.72)" } : {}),
        opacity: drawn ? 1 : 0,
        transition: "opacity .3s",
        ["--npc-accent" as string]: side === "right" ? C.red : C.teal,
        ["--npc-pad" as string]: "10px 12px",
        ...style,
      }}
    >
      {createElement("npc-panel", { ref, side })}
    </div>
  );
}

export function NpcPanels() {
  const connected = useAgentStatus((s) => s.connected);
  const matchId = useAgentStatus((s) => s.matchId);
  const [ok, setOk] = useState(() => typeof customElements !== "undefined" && !!customElements.get("npc-panel"));

  useEffect(() => {
    if (ok) return;
    let alive = true;
    loadPanels().then((v) => alive && setOk(v));
    return () => {
      alive = false;
    };
  }, [ok, connected]); // retry when the agent server comes up

  if (!ok) return null;
  return (
    <>
      {/* left rail: below the agent chip, above the health box */}
      <Rail side="left" matchId={matchId} style={{ left: 16, top: 52, maxHeight: "calc(100vh - 52px - 110px)" }} />
      {/* right rail: below the killfeed, above the ammo box */}
      <Rail side="right" matchId={matchId} style={{ right: 16, top: 190, maxHeight: "calc(100vh - 190px - 110px)" }} />
    </>
  );
}
