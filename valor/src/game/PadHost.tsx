// PadHost — mounts the phone-controller host connection (padInput.ts) and the
// QR UI pieces used by the start screen: <PadQrPanel/> (big "PLAY ON YOUR
// PHONE" card) and <PadChip/> (tiny QR + status for the pause screen).

import { useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { startPadHost } from "./padInput";
import { usePadStatus, isPlaying } from "./playState";
import { C, DISPLAY, eyebrow } from "./ui/theme";

/** Renders nothing; owns the relay connection for the game page's lifetime. */
export function PadHost() {
  useEffect(() => {
    const stop = startPadHost();
    if (import.meta.env.DEV) (window as unknown as { __pad?: unknown }).__pad = { usePadStatus, isPlaying };
    return stop;
  }, []);
  return null;
}

function Status() {
  const { hostUp, pads, started } = usePadStatus();
  const [color, text] = !hostUp
    ? [C.inkFaint, "Phone link offline (dev server only)"]
    : pads === 0
      ? [C.amber, "Waiting for phone…"]
      : started
        ? [C.teal, "Phone connected ✓ · playing"]
        : [C.teal, "Phone connected ✓ — tap START on the phone"];
  return (
    <div data-testid="pad-status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: color, boxShadow: pads > 0 ? `0 0 8px ${color}` : undefined }} />
      {text}
    </div>
  );
}

export function PadQrPanel() {
  const { url, room } = usePadStatus();
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        background: "rgba(15,25,35,0.82)",
        border: `1px solid ${C.line}`,
        padding: "16px 18px",
        marginTop: 14,
        cursor: "default",
        animation: "vl-slide-l .5s .25s ease-out both",
      }}
    >
      <div style={{ ...eyebrow, color: C.ink, fontSize: 13 }}>
        Play on your phone <span style={{ color: C.red }}>·</span> <span style={{ color: C.inkDim }}>room {room}</span>
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 10 }}>
        <div style={{ background: "#fff", padding: 8, lineHeight: 0, flex: "0 0 auto" }}>
          {url ? <QRCodeSVG value={url} size={124} level="M" /> : <div style={{ width: 124, height: 124 }} />}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.45 }}>
            Scan with your phone camera (same Wi-Fi). Turn the phone sideways — stick, swipe to look, tap to fire.
          </div>
          <div
            data-testid="pad-url"
            style={{ fontFamily: DISPLAY, fontSize: 14, letterSpacing: 0.5, color: C.ink, marginTop: 8, wordBreak: "break-all", userSelect: "text" }}
          >
            {url || "…"}
          </div>
          <div style={{ marginTop: 8 }}>
            <Status />
          </div>
        </div>
      </div>
    </div>
  );
}

export function PadChip() {
  const { url, pads } = usePadStatus();
  if (!url) return null;
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ display: "inline-flex", gap: 10, alignItems: "center", marginTop: 16, padding: 8, background: "rgba(15,25,35,0.82)", border: `1px solid ${C.line}`, cursor: "default" }}
    >
      <div style={{ background: "#fff", padding: 4, lineHeight: 0 }}>
        <QRCodeSVG value={url} size={56} level="M" />
      </div>
      <div style={{ fontSize: 12, color: pads > 0 ? C.teal : C.inkDim, maxWidth: 180 }}>
        {pads > 0 ? "Phone connected ✓ — tap START on the phone to resume" : "Scan to play on your phone"}
      </div>
    </div>
  );
}
