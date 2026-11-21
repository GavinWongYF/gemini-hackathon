// DamageIndicator — a red arc around the crosshair pointing toward whoever just
// hit the local player (combat.lastPlayerDamage), re-aimed every frame as the
// player turns, fading over ~1.1 s. Pure DOM, one rAF loop, no React re-render
// per frame.
import { useEffect, useRef } from "react";
import { lastPlayerDamage } from "../combat";
import { LOCAL_ID } from "../contracts";
import { transforms } from "../stores";

const FADE_MS = 1100;

export function DamageIndicator() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const d = el.current;
      const me = transforms[LOCAL_ID];
      if (!d || !me) return;
      const age = Date.now() - lastPlayerDamage.t;
      if (!lastPlayerDamage.t || age > FADE_MS) {
        if (d.style.opacity !== "0") d.style.opacity = "0";
        return;
      }
      const [ax, , az] = lastPlayerDamage.from;
      const bearing = Math.atan2(-(ax - me.pos[0]), -(az - me.pos[2])); // yaw toward attacker
      let rel = bearing - me.yaw;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      d.style.transform = `translate(-50%, -50%) rotate(${-rel}rad)`; // +yaw = left
      d.style.opacity = String(Math.max(0, 1 - age / FADE_MS));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div
      ref={el}
      data-testid="damage-indicator"
      style={{ position: "absolute", left: "50%", top: "50%", width: 260, height: 260, opacity: 0, pointerEvents: "none" }}
    >
      <svg viewBox="0 0 260 260" width={260} height={260} style={{ overflow: "visible" }}>
        {/* arc at the top of the ring = "in front"; the div rotates it */}
        <path d="M 78 26 A 115 115 0 0 1 182 26" fill="none" stroke="#ff2b3a" strokeWidth={9} strokeLinecap="round" opacity={0.9} />
        <path d="M 120 8 L 130 -4 L 140 8 Z" fill="#ff2b3a" />
      </svg>
    </div>
  );
}
