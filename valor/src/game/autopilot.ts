// ─────────────────────────────────────────────────────────────────────────
// autopilot.ts — scripted LOCAL player for reproducible demo recordings.
//
//   ?autopilot=flank_left      up the left lane, swing in on red spawn, shoot
//   ?autopilot=rush_open_mid   run straight up the open middle, never stop
//
// Drives the REAL controls (useControls move keys + yaw/pitch deltas + fire
// pulses), so movement/combat go through PlayerController/Weapon unchanged.
// Auto-starts the match by marking a "virtual pad" as playing (isPlaying() is
// then true without pointer lock and the click-to-play overlay is hidden).
// Inert unless the query param is present. Imported once from PlayerController.
// ─────────────────────────────────────────────────────────────────────────

import { CAPSULE, LOCAL_ID, type Vec3 } from "./contracts";
import { transforms, useControls, useGame } from "./stores";
import { useMatch } from "./match";
import { usePadStatus } from "./playState";
import { raycastShot } from "./hitscan";
import { inputExtra } from "./input";
import { RED_IDS, roundReset, yawToward } from "./teamAI";

type Scene = { route: [number, number][]; holdWhenSeen: boolean; engageRange: number };

const SCENES: Record<string, Scene> = {
  // Left lane (x≈6.6, laneOf < 8.5) past the crate at (5,-14.6), then cut in
  // behind the mid pillar toward the red spawn.
  flank_left: {
    route: [[6.6, -11], [6.6, -14.6], [7.0, -17.5], [8.4, -19.5], [8.3, -22], [7.0, -24.2], [9.5, -26.5], [12, -27.5]],
    holdWhenSeen: true,
    engageRange: 22,
  },
  // Straight up the open middle, around the mid wall on the open side.
  rush_open_mid: {
    route: [[12, -16.6], [14.3, -18.2], [13.2, -23.5], [12, -27.5]],
    holdWhenSeen: false,
    engageRange: 3, // careless rusher: sprints through fire, only shoots point-blank
  },
};

const EYE = CAPSULE.standEye - CAPSULE.standHalfHeight - CAPSULE.radius; // centre → eye
const TURN_RATE = 5.5; // rad/s max look speed (reads as human on video)
const REACH = 0.9; // m — waypoint reached
const FIRE_EVERY = 0.11; // s between fire pulses

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function visibleTarget(eye: Vec3, range: number): { id: string; yaw: number; pitch: number } | null {
  let best: { id: string; yaw: number; pitch: number; d: number } | null = null;
  const ents = useGame.getState().entities;
  for (const id of RED_IDS) {
    const e = ents[id];
    const t = transforms[id];
    if (!e || !e.alive || !t) continue;
    const ty = t.pos[1] + 0.3 - 0.35 * t.crouchAmount;
    const dx = t.pos[0] - eye[0], dy = ty - eye[1], dz = t.pos[2] - eye[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > range || (best && d > best.d)) continue;
    const hit = raycastShot(eye, [dx / d, dy / d, dz / d], d + 1);
    if (!hit || hit.kind !== "entity" || hit.entityId !== id) continue;
    best = { id, d, yaw: yawToward(eye[0], eye[2], t.pos[0], t.pos[2]), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
  }
  return best;
}

function start(name: string, scene: Scene) {
  let wp = 0;
  let seq = roundReset.seq;
  let last = performance.now();
  let fireT = 0;
  let stuckT = 0;
  let sideT = 0;
  let side = 1;
  let prev = [0, 0];
  const w = window as unknown as { __autopilot?: unknown };
  const status = { scene: name, wp, target: null as string | null };
  w.__autopilot = status;

  const tick = () => {
    requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    // Keep the virtual pad "playing" (auto-start + no click overlay).
    const pad = usePadStatus.getState();
    if (pad.pads < 1 || !pad.started) usePadStatus.setState({ pads: Math.max(1, pad.pads), started: true });

    if (seq !== roundReset.seq) {
      seq = roundReset.seq;
      wp = 0;
    }
    const t = transforms[LOCAL_ID];
    const me = useGame.getState().entities[LOCAL_ID];
    const phase = useMatch.getState().phase;
    const idle = { moveForward: false, moveBack: false, strafeLeft: false, strafeRight: false, crouch: false };
    if (!t || !me || !me.alive || phase !== "live") {
      useControls.setState(idle);
      return;
    }

    const eye: Vec3 = [t.pos[0], t.pos[1] + EYE, t.pos[2]];
    const tgt = visibleTarget(eye, scene.engageRange);
    status.target = tgt?.id ?? null;

    // Route progress.
    while (wp < scene.route.length && Math.hypot(scene.route[wp][0] - t.pos[0], scene.route[wp][1] - t.pos[2]) < REACH) wp++;
    status.wp = wp;
    (status as { pos?: string }).pos = `${t.pos[0].toFixed(1)},${t.pos[2].toFixed(1)}`;
    const goal = scene.route[Math.min(wp, scene.route.length - 1)];
    const atEnd = wp >= scene.route.length;
    const moveYaw = yawToward(t.pos[0], t.pos[2], goal[0], goal[1]);

    // Look: at the target if any, else down the path.
    const wantYaw = tgt ? tgt.yaw : moveYaw;
    const wantPitch = tgt ? tgt.pitch : 0;
    const maxStep = TURN_RATE * dt;
    const dy = Math.max(-maxStep, Math.min(maxStep, wrap(wantYaw - t.yaw)));
    const dp = Math.max(-maxStep, Math.min(maxStep, wantPitch - t.pitch));
    // PlayerController: yaw -= yawDelta, pitch -= pitchDelta (accumulated until consumed).
    const c = useControls.getState();
    useControls.setState({ yawDelta: c.yawDelta - dy, pitchDelta: c.pitchDelta - dp });

    // Move: 8-way keys relative to the current view yaw.
    const hold = atEnd || (scene.holdWhenSeen && !!tgt);
    if (hold) {
      useControls.setState(idle);
    } else {
      // Stuck on a prop (benches, crates)? hop + sidestep for a moment.
      const moved = Math.hypot(t.pos[0] - prev[0], t.pos[2] - prev[1]);
      stuckT = moved < 1.6 * dt ? stuckT + dt : 0;
      if (stuckT > 0.5) {
        inputExtra.jumpPressed = true;
        sideT = 0.8;
        side = -side;
        stuckT = 0;
      }
      sideT -= dt;
      const rel = wrap(moveYaw - t.yaw + (sideT > 0 ? 2.3 * side : 0)); // + = to the left (yaw is CCW, -Z forward)
      const f = Math.cos(rel), s = -Math.sin(rel);
      useControls.setState({
        moveForward: f > 0.38,
        moveBack: f < -0.38,
        strafeRight: s > 0.38,
        strafeLeft: s < -0.38,
        crouch: false,
      });
    }

    prev = [t.pos[0], t.pos[2]];

    // Fire once roughly on target.
    fireT -= dt;
    if (tgt && Math.abs(wrap(tgt.yaw - t.yaw)) < 0.08 && fireT <= 0) {
      fireT = FIRE_EVERY;
      useControls.setState({ firePressed: true, reloadPressed: me.ammo <= 0 });
    } else if (me.ammo <= 0 && !tgt) {
      useControls.setState({ reloadPressed: true });
    }
  };
  requestAnimationFrame(tick);
  console.info(`[autopilot] ${name} engaged`);
}

if (typeof window !== "undefined") {
  const name = new URLSearchParams(window.location.search).get("autopilot");
  if (name) {
    const scene = SCENES[name];
    if (scene) start(name, scene);
    else console.warn(`[autopilot] unknown scene "${name}" (have: ${Object.keys(SCENES).join(", ")})`);
  }
}
