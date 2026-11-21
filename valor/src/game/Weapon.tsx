// ─────────────────────────────────────────────────────────────────────────
// Weapon.tsx — the local player's sidearm: the §2 fire pipeline, the (cosmetic)
// weapon FSM, CS2/Valorant-style spread + recoil, ADS, and the first-person
// viewmodel.
//
// Design:
//
//   • FSM is COSMETIC. Fire rate is gated by a TIMER (`cooldown`). Fire is
//     AUTOMATIC while LMB is held (inputExtra.fireHeld) at FIRE_RPM; a quick tap
//     shorter than a frame still fires once via the `firePressed` edge pulse.
//
//   • THIS COMPONENT IS THE SOLE CONSUMER that clears the `firePressed` /
//     `reloadPressed` one-frame edge pulses on useControls (per the contract).
//
//   • Reload (RELOAD_TIME) is a full fire-lockout; mag = MAG_SIZE; auto-reload
//     when ammo hits 0. On finish: ammo = MAG_SIZE, recoil/spray reset.
//
//   • ACCURACY (crosshair-centred hitscan + random cone):
//       spread = (FIRST_SHOT + bloom) × stance  +  movement penalty
//       stance: crouched ×0.7, ADS ×0.6 (multiplicative)
//       movement: Shift-walk speed → +0.8°, full run → +4°, airborne → +6°
//       bloom: +0.55° per shot (max +3.5°), recovers 9°/s once you stop firing
//     So a standing (or crouched / ADS) first shot is near-pinpoint, and
//     spraying or shooting on the move is punished — counter-strafe to hit.
//
//   • RECOIL is a fixed, learnable vertical pattern (RECOIL_PATTERN, degrees of
//     pitch per shot) plus a late horizontal sway. It accumulates while you hold
//     fire and recovers quickly once you stop (RECOIL_RECOVERY), so you can pull
//     the mouse down to counter it. Applied as a TRANSIENT additive offset on the
//     camera look; the shot ray goes through the recoiled crosshair.
//
//   • HEADSHOTS: an entity hit whose point is in the top HEAD_HEIGHT of the
//     target's capsule deals SHOT_DAMAGE × HEADSHOT_MULT.
//
//   CAMERA WRITE (load-bearing): PlayerController writes the look base into
//   transforms[LOCAL_ID] (pitch/yaw) inside useBeforePhysicsStep — which fires
//   only on a fixed-1/60 physics step, NOT every render frame. So our LATE
//   useFrame(priority 10) SETS rotation = base + not-yet-consumed mouse delta +
//   decaying recoil each frame (idempotent). Adding the pending delta means mouse
//   look updates on EVERY rendered frame (no 60 Hz stepping on 120/144 Hz
//   monitors) while PlayerController stays the single owner of the base angles.
// ─────────────────────────────────────────────────────────────────────────

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { MathUtils, type PerspectiveCamera, Quaternion, Vector3 } from "three";
import { LOCAL_ID, MAG_SIZE, SHOT_DAMAGE, type Vec3 } from "./contracts";
import { capsuleFor, transforms, useControls, useGame } from "./stores";
import { raycastShot } from "./hitscan";
import { combat } from "./combat";
import { vfx } from "./vfx";
import { FpvArms } from "./FpvArms";
import { playSfx } from "./sfx";
import { getLock } from "./aimAssist";
import { AIM_ASSIST, inputExtra, look } from "./input";
import { mousePlaying } from "./playState";
import { useMatch } from "./match";

// ── Tunables ───────────────────────────────────────────────────────────────
export const FIRE_RPM = 400; // automatic while held (≈ Valorant Ghost / CS2 USP cadence)
const FIRE_INTERVAL = 60 / FIRE_RPM; // s
export const RELOAD_TIME = 1.2; // s — full fire-lockout
// Aim-down-sights zoom (controls.aiming).
const NORMAL_FOV = 75; // matches the Canvas camera fov
const SCOPED_FOV = 40; // ~1.9× magnification
const AIM_LERP = 14; // FOV damp rate (1/s)
const FIRE_ANIM_TIME = 0.12; // s — how long fireState stays "firing"
const MAX_RANGE = 200; // m — shot reach

export const HEADSHOT_MULT = 2.5;
const HEAD_HEIGHT = 0.25; // m — top slice of the capsule that counts as head

const DEG = Math.PI / 180;
// Spread (half-angle of the random cone), degrees.
export const SPREAD = {
  firstShot: 0.15, // standing still, rested
  bloomPerShot: 0.55,
  bloomMax: 3.5,
  bloomRecovery: 9, // °/s once not firing
  crouchMult: 0.7,
  adsMult: 0.6,
  walkPenalty: 0.8, // at Shift-walk speed (~2.2 m/s)
  runPenalty: 4.0, // at full run speed (4 m/s)
  airPenalty: 6.0,
};
const WALK_SPEED_REF = 2.2; // m/s
const RUN_SPEED_REF = 4.0; // m/s
const STILL_SPEED = 0.35; // m/s — below this you count as stationary

// Recoil: degrees of upward kick for shot N of a spray (last value repeats).
export const RECOIL_PATTERN = [0.7, 0.9, 1.1, 1.3, 1.4, 1.4, 1.3, 1.2];
const RECOIL_SWAY = 0.45; // ° horizontal sway amplitude from shot 5 on
const RECOIL_RECOVERY = 10; // /s exp decay once you stop firing
const RECOIL_RECOVERY_FIRING = 1.5; // /s decay between shots of a held spray
const SPRAY_RESET = 0.35; // s without firing → pattern restarts from shot 1

const PITCH_LIMIT = 88 * DEG; // must match PlayerController

// Barrel-tip offset (muzzle world position for VFX), in the camera's LOCAL frame
// (right = +X, up = +Y, forward = -Z).
const MUZZLE_RIGHT = 0.18;
const MUZZLE_UP = -0.16;
const MUZZLE_FWD = -0.9;

/** Live weapon feel, read by HUD (dynamic crosshair / hit feedback). Also
 *  mirrored to the CSS custom property `--valor-crosshair-gap` (px) on <html>,
 *  so a CSS crosshair can use `calc(var(--valor-crosshair-gap, 4px))`. */
export const weaponFeel = {
  /** Current cone half-angle in radians (what the next shot would use). */
  spreadRad: SPREAD.firstShot * DEG,
  /** Crosshair arm gap from screen centre in CSS px (reflects spread + FOV). */
  crosshairGapPx: 4,
  /** Last hit we landed: performance.now() time + whether it was a headshot. */
  lastHit: { t: 0, headshot: false },
};

export function Weapon() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  // ── Per-frame mutable state (refs, never React state) ──────────────────
  const cooldown = useRef(0); // s until next shot allowed
  const reloadTimer = useRef(0); // s remaining in reload (0 = not reloading)
  const fireAnimTimer = useRef(0); // s remaining of the "firing" anim flag
  const recoilPitch = useRef(0); // current additive pitch offset (rad)
  const recoilYaw = useRef(0); // current additive yaw offset (rad)
  const bloom = useRef(0); // current bloom (deg) atop the first-shot spread
  const sprayIndex = useRef(0); // shot number within the current spray
  const sinceShot = useRef(99); // s since the last shot
  const lastGap = useRef(-1);

  // Reusable temporaries (keep the hot path allocation-free).
  const tmpOrigin = useRef(new Vector3());
  const tmpDir = useRef(new Vector3());
  const tmpMuzzle = useRef(new Vector3());
  const tmpRight = useRef(new Vector3());
  const tmpUp = useRef(new Vector3());
  const tmpQuat = useRef(new Quaternion());

  // Final camera look = authoritative base + pending (unconsumed) mouse delta +
  // recoil. Idempotent; safe to call more than once per frame.
  function applyLook() {
    if (camera.rotation.order !== "YXZ") camera.rotation.order = "YXZ";
    const t = transforms[LOCAL_ID];
    if (!t) return;
    const c = useControls.getState();
    const pitch = MathUtils.clamp(t.pitch - c.pitchDelta, -PITCH_LIMIT, PITCH_LIMIT);
    camera.rotation.x = MathUtils.clamp(pitch + recoilPitch.current, -PITCH_LIMIT, PITCH_LIMIT);
    camera.rotation.y = t.yaw - c.yawDelta + recoilYaw.current;
    camera.rotation.z = 0;
    camera.updateMatrixWorld();
  }

  // Current spread (degrees) from stance, movement and bloom.
  function currentSpreadDeg(aiming: boolean): number {
    const t = transforms[LOCAL_ID];
    let stance = 1;
    let move = 0;
    if (t) {
      if (t.crouchAmount > 0.5) stance *= SPREAD.crouchMult;
      const speed = Math.hypot(t.forwardSpeed, t.lateralSpeed);
      if (!t.grounded) move = SPREAD.airPenalty;
      else if (speed > STILL_SPEED) {
        if (speed <= WALK_SPEED_REF) move = SPREAD.walkPenalty * (speed / WALK_SPEED_REF);
        else move = SPREAD.walkPenalty + (SPREAD.runPenalty - SPREAD.walkPenalty) * Math.min(1, (speed - WALK_SPEED_REF) / (RUN_SPEED_REF - WALK_SPEED_REF));
      }
    }
    if (aiming) stance *= SPREAD.adsMult;
    return (SPREAD.firstShot + bloom.current) * stance + move;
  }

  // ── fire(): the §2 pipeline ────────────────────────────────────────────
  function fire(aiming: boolean) {
    const g = useGame.getState();
    const me = g.entities[LOCAL_ID];
    const ammo = me ? me.ammo : 0;
    if (ammo <= 0) return;

    // 1. decrement ammo + drive HUD.
    const nextAmmo = ammo - 1;
    g.patch(LOCAL_ID, { ammo: nextAmmo, fireState: "firing" });
    fireAnimTimer.current = FIRE_ANIM_TIME;
    playSfx("shot"); // gunshot crack

    // 2. ray from the camera, through the (recoiled) crosshair as of THIS frame.
    applyLook();
    camera.getWorldPosition(tmpOrigin.current);
    camera.getWorldDirection(tmpDir.current).normalize();
    const origin = tmpOrigin.current;
    const originVec: Vec3 = [origin.x, origin.y, origin.z];

    // 3-4. Optional lock-on assist (webcam era; AIM_ASSIST off for mouse).
    let dirVec: Vec3 = [tmpDir.current.x, tmpDir.current.y, tmpDir.current.z];
    let hit: ReturnType<typeof raycastShot> = null;
    let assisted = false;
    const lock = AIM_ASSIST ? getLock() : null;
    if (lock) {
      const dx = lock.point[0] - origin.x, dy = lock.point[1] - origin.y, dz = lock.point[2] - origin.z;
      const inv = 1 / (Math.hypot(dx, dy, dz) || 1);
      const ld: Vec3 = [dx * inv, dy * inv, dz * inv];
      const lhit = raycastShot(originVec, ld, MAX_RANGE);
      if (lhit && lhit.kind === "entity" && lhit.entityId && lhit.entityId !== LOCAL_ID) {
        dirVec = ld; hit = lhit; assisted = true;
      }
    }
    if (!assisted) {
      applySpread(tmpDir.current, currentSpreadDeg(aiming) * DEG);
      dirVec = [tmpDir.current.x, tmpDir.current.y, tmpDir.current.z];
      hit = raycastShot(originVec, dirVec, MAX_RANGE);
    }

    // 5. on an entity hit → deal damage (headshot = top slice of the capsule).
    if (hit && hit.kind === "entity" && hit.entityId) {
      const cap = capsuleFor(hit.entityId);
      const headshot = !!cap && hit.point[1] >= cap.tip[1] + cap.radius - HEAD_HEIGHT;
      const amount = headshot ? Math.round(SHOT_DAMAGE * HEADSHOT_MULT) : SHOT_DAMAGE;
      weaponFeel.lastHit.t = performance.now();
      weaponFeel.lastHit.headshot = headshot;
      combat.applyDamage({ targetId: hit.entityId, amount, fromDir: dirVec, byId: LOCAL_ID });
    }

    // 6. always: muzzle flash + tracer.
    muzzleWorldPos(tmpMuzzle.current);
    const muzzle: Vec3 = [tmpMuzzle.current.x, tmpMuzzle.current.y, tmpMuzzle.current.z];
    vfx.muzzle(muzzle);
    const to: Vec3 = hit
      ? hit.point
      : [origin.x + dirVec[0] * MAX_RANGE, origin.y + dirVec[1] * MAX_RANGE, origin.z + dirVec[2] * MAX_RANGE];
    vfx.tracer(muzzle, to);

    // Recoil kick: fixed vertical pattern + late alternating sway.
    if (sinceShot.current > SPRAY_RESET) sprayIndex.current = 0;
    const n = sprayIndex.current;
    recoilPitch.current += RECOIL_PATTERN[Math.min(n, RECOIL_PATTERN.length - 1)] * DEG;
    if (n >= 4) recoilYaw.current += Math.sin(n * 1.3) * RECOIL_SWAY * DEG;
    sprayIndex.current = n + 1;
    sinceShot.current = 0;
    bloom.current = Math.min(SPREAD.bloomMax, bloom.current + SPREAD.bloomPerShot);

    cooldown.current += FIRE_INTERVAL;
    if (nextAmmo <= 0) beginReload();
  }

  // Apply a random cone of half-angle `half` (rad) to `dir` in place.
  function applySpread(dir: Vector3, half: number) {
    if (half <= 0) return;
    const right = tmpRight.current;
    const up = tmpUp.current;
    if (Math.abs(dir.y) < 0.99) up.set(0, 1, 0);
    else up.set(1, 0, 0);
    right.crossVectors(dir, up).normalize();
    up.crossVectors(right, dir).normalize();
    const ang = half * Math.sqrt(Math.random()); // uniform over the disc
    const roll = Math.random() * Math.PI * 2;
    const sinA = Math.sin(ang);
    dir.multiplyScalar(Math.cos(ang));
    dir.addScaledVector(right, sinA * Math.cos(roll));
    dir.addScaledVector(up, sinA * Math.sin(roll));
    dir.normalize();
  }

  function beginReload() {
    if (reloadTimer.current > 0) return;
    const me = useGame.getState().entities[LOCAL_ID];
    if (!me || !me.alive || me.ammo >= MAG_SIZE) return;
    reloadTimer.current = RELOAD_TIME;
    useGame.getState().patch(LOCAL_ID, { reloading: true, fireState: "reloading" });
    playSfx("reload");
  }

  function muzzleWorldPos(out: Vector3) {
    camera.getWorldPosition(out);
    camera.getWorldQuaternion(tmpQuat.current);
    const fwd = tmpDir.current.set(0, 0, -1).applyQuaternion(tmpQuat.current);
    const right = tmpRight.current.set(1, 0, 0).applyQuaternion(tmpQuat.current);
    const up = tmpUp.current.set(0, 1, 0).applyQuaternion(tmpQuat.current);
    out.addScaledVector(fwd, -MUZZLE_FWD);
    out.addScaledVector(right, MUZZLE_RIGHT);
    out.addScaledVector(up, MUZZLE_UP);
  }

  // ── Main update loop (default priority) ────────────────────────────────
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const c = useControls.getState();

    // ADS: lerp the FOV; scale mouse sensitivity with the zoom.
    const cam = camera as PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      const targetFov = c.aiming ? SCOPED_FOV : NORMAL_FOV;
      if (Math.abs(cam.fov - targetFov) > 0.05) {
        cam.fov = MathUtils.damp(cam.fov, targetFov, AIM_LERP, dt);
        cam.updateProjectionMatrix();
        look.fovScale = Math.tan((cam.fov * DEG) / 2) / Math.tan((NORMAL_FOV * DEG) / 2);
      }
    }

    if (c.reloadPressed) {
      beginReload();
      useControls.setState({ reloadPressed: false });
    }

    if (reloadTimer.current > 0) {
      reloadTimer.current -= dt;
      if (reloadTimer.current <= 0) {
        reloadTimer.current = 0;
        bloom.current = 0;
        sprayIndex.current = 0;
        useGame.getState().patch(LOCAL_ID, { ammo: MAG_SIZE, reloading: false, fireState: "ready" });
      }
    }

    // Cooldown never banks shots while idle (clamped at 0).
    cooldown.current = Math.max(0, cooldown.current - dt);
    sinceShot.current += dt;

    // Fire: automatic while held; a tap (pulse) fires once.
    // Only while the round is LIVE: no shots in warmup, the pre-round intro
    // (overview + 3·2·1), round end or match end — only from GO.
    const wantFire = (c.firePressed || inputExtra.fireHeld) && useMatch.getState().phase === "live";
    if (c.firePressed) useControls.setState({ firePressed: false });
    // Held-auto fire while the mouse drives the game (locked, or drag-look).
    if (wantFire && mousePlaying()) {
      const me = useGame.getState().entities[LOCAL_ID];
      // At most one shot per frame (cooldown carries the remainder).
      if (cooldown.current <= 0 && reloadTimer.current <= 0 && me && me.alive && me.ammo > 0) fire(c.aiming);
    } else if (wantFire) {
      // Not captured (e.g. automation / vision mode): still honour a tap.
      const me = useGame.getState().entities[LOCAL_ID];
      if (c.firePressed && cooldown.current <= 0 && reloadTimer.current <= 0 && me && me.alive && me.ammo > 0) fire(c.aiming);
    }

    if (fireAnimTimer.current > 0) {
      fireAnimTimer.current -= dt;
      if (fireAnimTimer.current <= 0) {
        const me = useGame.getState().entities[LOCAL_ID];
        if (me && me.fireState === "firing") {
          useGame.getState().patch(LOCAL_ID, { fireState: reloadTimer.current > 0 ? "reloading" : "ready" });
        }
      }
    }

    // Recoil recovery: slow between shots of a held spray, fast once released.
    const spraying = sinceShot.current < FIRE_INTERVAL * 1.6;
    const recover = Math.exp(-(spraying ? RECOIL_RECOVERY_FIRING : RECOIL_RECOVERY) * dt);
    recoilPitch.current *= recover;
    recoilYaw.current *= recover;
    if (!spraying) bloom.current = Math.max(0, bloom.current - SPREAD.bloomRecovery * dt);

    // Publish spread for the dynamic crosshair.
    const spreadDeg = currentSpreadDeg(c.aiming);
    weaponFeel.spreadRad = spreadDeg * DEG;
    const fov = cam.isPerspectiveCamera ? cam.fov : NORMAL_FOV;
    const gap = Math.max(3, Math.round((Math.tan(weaponFeel.spreadRad) / Math.tan((fov * DEG) / 2)) * (size.height / 2)) + 3);
    weaponFeel.crosshairGapPx = gap;
    if (gap !== lastGap.current) {
      lastGap.current = gap;
      document.documentElement.style.setProperty("--valor-crosshair-gap", `${gap}px`);
    }
  });

  // ── LATE loop (priority 10): write the FINAL camera rotation ────────────
  // FpvArms then tracks the camera at priority 11 (after this), so the arms +
  // gun inherit the final look + recoil.
  useFrame(applyLook, 10);

  // First-person arms hold the gun (the real rigged hands) — see FpvArms.
  return <FpvArms />;
}
