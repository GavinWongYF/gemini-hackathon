// PLAY AGAIN helpers.

export { restartMatch } from "../RoundManager";

/** Capture the mouse on the game canvas (must run inside a click handler). */
export function lockPointer() {
  const canvas = document.querySelector("canvas");
  try {
    const p = canvas?.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => {});
  } catch {
    /* lock refused (e.g. too soon after Esc); the overlay stays up */
  }
}
