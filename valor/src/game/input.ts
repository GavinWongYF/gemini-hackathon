// ─────────────────────────────────────────────────────────────────────────
// input.ts — keyboard + mouse producer for the `useControls` store. Mount
// <InputController/> once inside the Canvas.
//
// Standard PC FPS scheme (CS2 / Valorant defaults), all rebindable in KEYBINDS:
//   W A S D move · mouse look · LMB fire (HOLD = automatic at the weapon RPM)
//   RMB aim-down-sights (hold) · R reload · Shift walk (slow, quiet, accurate)
//   C / Ctrl crouch · Space jump · [ / ] mouse sensitivity · Esc pause.
//
// Contract reminders (see contracts.ts):
//   • yawDelta/pitchDelta ACCUMULATE here and are zeroed by the consumer
//     (PlayerController) on each physics step. Weapon previews the not-yet-
//     consumed delta every render frame so look never waits for a 60 Hz step.
//   • firePressed/reloadPressed are ONE-FRAME edge pulses set here on the input
//     event; the SINGLE consumer (Weapon) reads and clears them. `inputExtra`
//     carries the held/extra state the frozen Controls contract has no field for
//     (fire held, walk, jump).
// Pointer lock engages on canvas click (raw `unadjustedMovement` input when the
// browser supports it); look only applies while locked.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { useControls } from "./stores";
import { useLookMode } from "./playState";

// ── Keybinds (single source of truth — KeyboardEvent.code values) ─────────
export const KEYBINDS = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  walk: ["ShiftLeft", "ShiftRight"],
  // C first: Ctrl+W is a browser shortcut (close tab) that pages cannot block,
  // so Ctrl-crouch while moving forward is risky outside fullscreen.
  crouch: ["KeyC", "ControlLeft"],
  jump: ["Space"],
  reload: ["KeyR"],
  sensDown: ["BracketLeft"],
  sensUp: ["BracketRight"],
} as const;
/** Mouse buttons (MouseEvent.button). */
export const MOUSE_BINDS = { fire: 0, aim: 2 } as const;

/** Webcam-era lock-on aim assist (red ring + snap). OFF for mouse play; the code
 *  is kept (TargetLock / aimAssist) and re-enabled by flipping this. */
export const AIM_ASSIST = false;

// ── Mouse sensitivity (radians per pixel), persisted ─────────────────────
export const DEFAULT_SENS = 0.0018;
const SENS_KEY = "valor.sensitivity";
const SENS_MIN = 0.0003;
const SENS_MAX = 0.01;
const SENS_STEP = 1.1; // ×/÷ per [ or ] press
let sens = DEFAULT_SENS;
try {
  const v = parseFloat(localStorage.getItem(SENS_KEY) ?? "");
  if (Number.isFinite(v) && v >= SENS_MIN && v <= SENS_MAX) sens = v;
} catch {
  /* storage blocked — keep default */
}
export function getSensitivity(): number {
  return sens;
}
/** Set + persist; fires a `valor:sensitivity` window event (detail = value) the
 *  HUD can show as a toast. */
export function setSensitivity(v: number): number {
  sens = Math.min(SENS_MAX, Math.max(SENS_MIN, v));
  try {
    localStorage.setItem(SENS_KEY, String(sens));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("valor:sensitivity", { detail: sens }));
  return sens;
}

// ADS sensitivity: scale by the zoom so the crosshair moves the same on-screen
// distance per mouse count (≈ "zoom sensitivity ratio 1"). Weapon writes the
// live FOV ratio here: tan(fov/2) / tan(hipFov/2).
export const look = { fovScale: 1 };

// ── Extra input state (not in the frozen Controls contract) ──────────────
export const inputExtra = {
  /** LMB currently held → automatic fire while true. */
  fireHeld: false,
  /** Shift held → walk. PlayerController should slow to walk speed. */
  walk: false,
  /** Space held. */
  jumpHeld: false,
  /** One-frame jump edge pulse; the movement consumer clears it. */
  jumpPressed: false,
};

// ── Pointer-lock state + drag-to-look fallback ─────────────────────────
// If pointer lock cannot be obtained (refused twice in a row, API missing, or
// an embedding iframe without allow-pointer-lock) we switch to FREE-LOOK mode:
// the game plays uncaptured and the player looks by holding a mouse button and
// dragging. playState.isPlaying() treats free-look as "playing".
export { useLookMode };

function lockFailed() {
  const n = useLookMode.getState().lockFails + 1;
  useLookMode.setState({ lockFails: n, freeLook: n >= 2 });
}

/** Request pointer lock with raw (unaccelerated) mouse input, falling back to a
 *  plain lock on browsers that don't support `unadjustedMovement`, and to
 *  drag-to-look free-look mode when the lock is refused repeatedly. MUST be
 *  called from a user gesture (click / mousedown). */
export function requestGameLock(el: Element | null = document.querySelector("canvas")): void {
  if (!el || document.pointerLockElement === el) return;
  type LockFn = (o?: { unadjustedMovement?: boolean }) => Promise<void> | void;
  const raw = (el as unknown as { requestPointerLock?: LockFn }).requestPointerLock;
  if (typeof raw !== "function") {
    useLookMode.setState({ freeLook: true });
    return;
  }
  const req = raw.bind(el);
  const plain = () => {
    try {
      const p2 = req();
      if (p2 && typeof (p2 as Promise<void>).catch === "function") (p2 as Promise<void>).catch(lockFailed);
    } catch {
      lockFailed();
    }
  };
  try {
    const p = req({ unadjustedMovement: true });
    if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(plain);
  } catch {
    plain();
  }
}

/** Leave free-look (Esc) — the start overlay comes back as the pause menu. */
export function exitFreeLook(): void {
  if (useLookMode.getState().freeLook) useLookMode.setState({ freeLook: false, lockFails: 0 });
}

const has = (list: readonly string[], code: string) => list.includes(code);

/** R3F component (renders null) that wires DOM input into useControls. */
export function InputController() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const dom = gl.domElement;
    const set = useControls.setState;
    const locked = () => document.pointerLockElement === dom;
    const freeLook = () => useLookMode.getState().freeLook;
    /** Free-look drag in progress (a mouse button went down on the canvas). */
    let dragging = false;

    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      const c = e.code;
      if (down && c === "Escape") {
        exitFreeLook();
        releaseAll();
        return;
      }
      if (has(KEYBINDS.forward, c)) set({ moveForward: down });
      else if (has(KEYBINDS.back, c)) set({ moveBack: down });
      else if (has(KEYBINDS.left, c)) set({ strafeLeft: down });
      else if (has(KEYBINDS.right, c)) set({ strafeRight: down });
      else if (has(KEYBINDS.crouch, c)) set({ crouch: down });
      else if (has(KEYBINDS.walk, c)) inputExtra.walk = down;
      else if (has(KEYBINDS.jump, c)) {
        if (down && !e.repeat && !inputExtra.jumpHeld) inputExtra.jumpPressed = true;
        inputExtra.jumpHeld = down;
        if (locked() || freeLook()) e.preventDefault(); // no page scroll
      } else if (has(KEYBINDS.reload, c)) {
        if (down && !e.repeat) set({ reloadPressed: true });
      } else if (down && has(KEYBINDS.sensDown, c)) setSensitivity(sens / SENS_STEP);
      else if (down && has(KEYBINDS.sensUp, c)) setSensitivity(sens * SENS_STEP);
    };
    const onKeyDown = onKey(true);
    const onKeyUp = onKey(false);

    // Accumulate raw deltas; one store write per event (no React subscribers on
    // the deltas, so this never re-renders).
    // SIGN CONVENTION (the consumer, PlayerController, does yaw -= yawDelta and
    // pitch -= pitchDelta; in three.js +yaw = turn LEFT, +pitch = look UP):
    //   mouse right (+movementX) → yawDelta +   → yaw decreases   → turn right
    //   mouse down  (+movementY) → pitchDelta + → pitch decreases → look down
    // (This was inverted on both axes before — "I can't look where I want".)
    const onMouseMove = (e: MouseEvent) => {
      if (!locked() && !(freeLook() && dragging)) return;
      let mx = e.movementX || 0;
      let my = e.movementY || 0;
      // Chrome sometimes reports one huge spurious jump on lock / window
      // re-entry; drop it instead of spinning the camera.
      if (Math.abs(mx) > 400 || Math.abs(my) > 400) return;
      if (!locked()) {
        mx *= 1.6; // drag-look: absolute pixels feel slower than raw counts
        my *= 1.6;
      }
      const k = sens * look.fovScale;
      const s = useControls.getState();
      set({ yawDelta: s.yawDelta + mx * k, pitchDelta: s.pitchDelta + my * k });
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!locked() && !freeLook()) {
        requestGameLock(dom);
        return;
      }
      if (!locked()) dragging = true; // free-look: any held button drags the view
      if (e.button === MOUSE_BINDS.fire) {
        inputExtra.fireHeld = true;
        set({ firePressed: true });
      }
      if (e.button === MOUSE_BINDS.aim) set({ aiming: true });
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.buttons === 0) dragging = false;
      if (e.button === MOUSE_BINDS.fire) inputExtra.fireHeld = false;
      if (e.button === MOUSE_BINDS.aim) set({ aiming: false });
    };
    const noMenu = (e: Event) => e.preventDefault();
    // Releasing everything on pause / focus loss so nothing sticks (Esc while
    // holding W would otherwise keep walking, LMB would keep firing).
    const releaseAll = () => {
      dragging = false;
      inputExtra.fireHeld = false;
      inputExtra.walk = false;
      inputExtra.jumpHeld = false;
      inputExtra.jumpPressed = false;
      set({
        aiming: false,
        moveForward: false,
        moveBack: false,
        strafeLeft: false,
        strafeRight: false,
        crouch: false,
        firePressed: false,
        yawDelta: 0,
        pitchDelta: 0,
      });
    };
    const onLockChange = () => {
      releaseAll(); // fresh state on every capture AND release — no stuck keys
      if (locked()) useLookMode.setState({ freeLook: false, lockFails: 0 });
    };
    const onLockError = () => lockFailed();
    const onVis = () => {
      if (document.hidden) releaseAll();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    dom.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", releaseAll);
    dom.addEventListener("contextmenu", noMenu);
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("pointerlockerror", onLockError);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("pointerlockerror", onLockError);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      dom.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", releaseAll);
      dom.removeEventListener("contextmenu", noMenu);
      document.removeEventListener("pointerlockchange", onLockChange);
    };
  }, [gl]);

  return null;
}
