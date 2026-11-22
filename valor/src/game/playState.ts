// ─────────────────────────────────────────────────────────────────────────
// playState.ts — ONE answer to "is the player actively playing right now?"
//
//   isPlaying() = the mouse is pointer-locked on the game canvas
//              OR a phone controller is connected and its player tapped START.
//
// Bots, team AI, the round loop and the start overlay all gate on this instead
// of `document.pointerLockElement`, so a phone (see padInput.ts) can play the
// match without the laptop's mouse ever being captured.
// ─────────────────────────────────────────────────────────────────────────

import { create } from "zustand";

export interface PadStatus {
  /** Room code the PC host registered with the relay ("" until generated). */
  room: string;
  /** Host socket to the relay is open. */
  hostUp: boolean;
  /** Number of phone controllers currently in the room. */
  pads: number;
  /** A phone tapped START (cleared when the last phone leaves). */
  started: boolean;
  /** Reachable controller URL for the QR (LAN IP), "" until known. */
  url: string;
}

export const usePadStatus = create<PadStatus>(() => ({ room: "", hostUp: false, pads: 0, started: false, url: "" }));

/** True while the phone controller is driving the game. */
export function padPlaying(): boolean {
  const s = usePadStatus.getState();
  return s.pads > 0 && s.started;
}

/** Mouse look mode (written by input.ts). `freeLook` = pointer lock was
 *  unavailable/refused, so the game runs uncaptured and the player looks by
 *  holding a mouse button and dragging. Esc leaves it (= pause). */
export const useLookMode = create<{ freeLook: boolean; lockFails: number }>(() => ({ freeLook: false, lockFails: 0 }));

/** Mouse/keyboard is driving the game: pointer-locked, or drag-look fallback. */
export function mousePlaying(): boolean {
  return (typeof document !== "undefined" && !!document.pointerLockElement) || useLookMode.getState().freeLook;
}

export function isPlaying(): boolean {
  return mousePlaying() || padPlaying();
}
