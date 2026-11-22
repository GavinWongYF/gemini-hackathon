// ─────────────────────────────────────────────────────────────────────────
// IntroCamera.tsx — the pre-round "here's the map, here's who's where" shot.
//
// During match phase "intro" (timeline in intro.ts):
//   OVERVIEW (0–3 s)  a high-angle crane shot sweeps around the plaza, looking
//                     down at both spawns. Every player gets a light pillar +
//                     ground ring in their team colour and a name tag; each
//                     team gets a header ("YOUR TEAM" / "ENEMY"). The local
//                     player — normally invisible (first person) — is drawn as
//                     a blue character with a gold "YOU" tag.
//   FLY (3–4.1 s)     the camera swoops down from behind and settles exactly
//                     on the player's eyes (yaw/pitch from transforms), FOV
//                     easing from the wide overview lens back to 75°.
// Then PlayerController takes the camera back on the same pose — no pop.
//
// Camera ownership: runs at useFrame priority 12, i.e. AFTER Weapon's
// priority-10 camera-rotation write and FpvArms' priority-11 follow, so the
// intro pose is what renders. PlayerController skips its camera write and
// FpvArms hides itself while introCameraActive().
// ─────────────────────────────────────────────────────────────────────────

import { Suspense, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { AdditiveBlending, CylinderGeometry, DoubleSide, Euler, type Group, MathUtils, MeshBasicMaterial, type PerspectiveCamera, Quaternion, RingGeometry, Vector3, Matrix4 } from "three";
import { CAPSULE, LOCAL_ID } from "./contracts";
import { transforms, useGame } from "./stores";
import { CENTER_OFFSET, FLOOR_Y, BLUE_IDS, RED_IDS, BOT_SPAWNS, PLAYER_SPAWN, BOT_URL } from "./teamAI";
import { INTRO_FLY_MS, INTRO_OVERVIEW_MS, introCameraActive, introElapsed, useIntro } from "./intro";
import { AnimatedCharacter } from "./AnimatedCharacter";
import { Gun } from "../Gun";
import { displayName } from "./ui/roster";
import { C, DISPLAY } from "./ui/theme";
import type { Team } from "./match";

const NORMAL_FOV = 75;
const OVERVIEW_FOV = 58;
/** Middle of the plaza between the two spawns (feet height). */
const CENTER = new Vector3(12, FLOOR_Y, -18);
/** Crane path: angle around CENTER (0 = behind the blue spawn, +Z), radius,
 *  height. Ends high behind the blue spawn so both teams sit in the middle
 *  band of the frame, clear of the letterbox bars (blue low, red high). */
const ORBIT = { a0: -0.9, a1: 0.1, r0: 23, r1: 20, h0: 31, h1: 26 };
/** Where the crane looks (ground point between the spawns, a touch blue-side). */
const LOOK_Z0 = -19;
const LOOK_Z1 = -17.6;
/** Fly-down swoops in from behind/above the player: bezier control offset. */
const FLY_CTRL = new Vector3(0, 5.5, 7);
const EYE_ABOVE_CENTER = CAPSULE.standEye - CAPSULE.standHalfHeight - CAPSULE.radius;

const easeInOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// Scratch (no per-frame allocation).
const vPos = new Vector3();
const vLook = new Vector3();
const vEye = new Vector3();
const vCtrl = new Vector3();
const p0 = new Vector3();
const qFrom = new Quaternion();
const qTo = new Quaternion();
const eTo = new Euler(0, 0, 0, "YXZ");
const mLook = new Matrix4();
const UP = new Vector3(0, 1, 0);

/** Overview crane pose at normalized time u∈[0,1] → (pos, quaternion). */
function overviewPose(u: number, pos: Vector3, quat: Quaternion) {
  const k = easeInOutSine(MathUtils.clamp(u, 0, 1));
  const a = MathUtils.lerp(ORBIT.a0, ORBIT.a1, k);
  const r = MathUtils.lerp(ORBIT.r0, ORBIT.r1, k);
  const h = MathUtils.lerp(ORBIT.h0, ORBIT.h1, k);
  pos.set(CENTER.x + Math.sin(a) * r, CENTER.y + h, CENTER.z + Math.cos(a) * r);
  // Aim drifts from the plaza centre toward the blue side as we come around.
  vLook.set(CENTER.x, CENTER.y, MathUtils.lerp(LOOK_Z0, LOOK_Z1, k));
  mLook.lookAt(pos, vLook, UP);
  quat.setFromRotationMatrix(mLook);
}

/** Player's first-person eye pose (what PlayerController will render). */
function eyePose(pos: Vector3, quat: Quaternion) {
  const t = transforms[LOCAL_ID];
  if (t) {
    pos.set(t.pos[0], t.pos[1] + EYE_ABOVE_CENTER, t.pos[2]);
    eTo.set(t.pitch, t.yaw, 0, "YXZ");
  } else {
    pos.set(PLAYER_SPAWN[0], PLAYER_SPAWN[1] + EYE_ABOVE_CENTER, PLAYER_SPAWN[2]);
    eTo.set(0, 0, 0, "YXZ");
  }
  quat.setFromEuler(eTo);
}

export function IntroCamera() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const wasActive = useRef(false);
  const stage = useIntro((s) => s.stage);

  useFrame(() => {
    const active = introCameraActive();
    if (!active) {
      if (wasActive.current) {
        wasActive.current = false;
        // Hand back a clean lens (Weapon's ADS damping takes over from here).
        camera.fov = NORMAL_FOV;
        camera.updateProjectionMatrix();
      }
      return;
    }
    wasActive.current = true;
    const e = introElapsed();
    let fov = OVERVIEW_FOV;
    let fade = 1;
    if (e < INTRO_OVERVIEW_MS) {
      overviewPose(e / INTRO_OVERVIEW_MS, vPos, qFrom);
      camera.position.copy(vPos);
      camera.quaternion.copy(qFrom);
    } else {
      const v = MathUtils.clamp((e - INTRO_OVERVIEW_MS) / INTRO_FLY_MS, 0, 1);
      const k = easeInOutCubic(v);
      overviewPose(1, p0, qFrom);
      eyePose(vEye, qTo);
      // Quadratic bezier p0 → (eye + ctrl) → eye: drops in from behind/above.
      vCtrl.copy(vEye).add(FLY_CTRL);
      const a = (1 - k) * (1 - k), b = 2 * (1 - k) * k, c = k * k;
      vPos.set(a * p0.x + b * vCtrl.x + c * vEye.x, a * p0.y + b * vCtrl.y + c * vEye.y, a * p0.z + b * vCtrl.z + c * vEye.z);
      camera.position.copy(vPos);
      camera.quaternion.copy(qFrom).slerp(qTo, k);
      fov = MathUtils.lerp(OVERVIEW_FOV, NORMAL_FOV, k);
      fade = 1 - MathUtils.clamp(v * 1.8, 0, 1); // markers gone before we get close
    }
    setMarkerFade(fade);
    camera.rotation.order = "YXZ"; // keep the FPS convention for everyone else
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }, 12);

  const show = stage === "overview" || stage === "fly";
  if (!show) return null;
  return (
    <>
      <GroundSkirt />
      <OverviewMarkers labels={stage === "overview"} />
    </>
  );
}

// ── Ground skirt ─────────────────────────────────────────────────────────
// The high overview sees past the edge of the map slab, where there is only
// the pale sky/background ("white void"). A huge grass-toned disc just under
// the map floor fills that, and the scene fog fades it into a hazy horizon.
// Sits below the slab top, so inside the map it is never visible.
const SKIRT_Y = FLOOR_Y - 0.45;
function GroundSkirt() {
  return (
    <mesh position={[CENTER.x, SKIRT_Y, CENTER.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1}>
      <circleGeometry args={[420, 48]} />
      <meshLambertMaterial color="#5d7f3e" />
    </mesh>
  );
}

// ── Overview markers ─────────────────────────────────────────────────────
const TEAM_HEX: Record<Team, string> = { blue: C.teal, red: C.red };
const YOU_HEX = C.amber;
const pillarGeo = new CylinderGeometry(0.32, 0.32, 1, 20, 1, true);
pillarGeo.translate(0, 0.5, 0);
const ringGeo = new RingGeometry(0.75, 0.98, 40);
function glow(color: string, opacity: number) {
  return new MeshBasicMaterial({ color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
}
const MAT = {
  blue: { pillar: glow(TEAM_HEX.blue, 0.2), ring: glow(TEAM_HEX.blue, 0.9) },
  red: { pillar: glow(TEAM_HEX.red, 0.2), ring: glow(TEAM_HEX.red, 0.9) },
  you: { pillar: glow(YOU_HEX, 0.3), ring: glow(YOU_HEX, 1) },
};
const BASE_OPACITY = new Map<MeshBasicMaterial, number>();
for (const g of Object.values(MAT)) for (const m of Object.values(g)) BASE_OPACITY.set(m, m.opacity);
/** 1 = full, 0 = invisible (the fly-down fades the pillars/rings out). */
function setMarkerFade(f: number) {
  for (const [m, o] of BASE_OPACITY) m.opacity = o * f;
}

/** Feet XZ of a player (live transform if known, else the spawn table). */
function feetXZ(id: string): [number, number] {
  const t = transforms[id];
  if (t) return [t.pos[0], t.pos[2]];
  if (id === LOCAL_ID) return [PLAYER_SPAWN[0], PLAYER_SPAWN[2]];
  return BOT_SPAWNS[id] ?? [0, 0];
}

function OverviewMarkers({ labels }: { labels: boolean }) {
  const entities = useGame.getState().entities;
  const blueC = centroid(BLUE_IDS);
  const redC = centroid(RED_IDS);
  return (
    <group>
      {BLUE_IDS.map((id) => (
        <Marker key={id} id={id} team="blue" name={displayName(id, entities)} labels={labels} />
      ))}
      {RED_IDS.map((id) => (
        <Marker key={id} id={id} team="red" name={displayName(id, entities)} labels={labels} />
      ))}
      <Suspense fallback={null}>
        <LocalBody />
      </Suspense>
      {labels ? (
        <>
          <TeamHeader x={blueC[0]} y={5.6} z={blueC[1] - 2.4} title="YOUR TEAM" color={TEAM_HEX.blue} />
          <TeamHeader x={redC[0]} y={5.8} z={redC[1] - 1.5} title="ENEMY" color={TEAM_HEX.red} />
        </>
      ) : null}
    </group>
  );
}

function centroid(ids: readonly string[]): [number, number] {
  let x = 0, z = 0;
  for (const id of ids) {
    const [fx, fz] = feetXZ(id);
    x += fx;
    z += fz;
  }
  return [x / ids.length, z / ids.length];
}

function Marker({ id, team, name, labels }: { id: string; team: Team; name: string; labels: boolean }) {
  const ref = useRef<Group>(null);
  const ring = useRef<Group>(null);
  const you = id === LOCAL_ID;
  const mats = you ? MAT.you : MAT[team];
  const color = you ? YOU_HEX : TEAM_HEX[team];
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const t = transforms[id];
    if (t) g.position.set(t.pos[0], t.pos[1] - CENTER_OFFSET, t.pos[2]);
    else {
      const [x, z] = feetXZ(id);
      g.position.set(x, FLOOR_Y, z);
    }
    if (ring.current) {
      const s = 1 + 0.18 * Math.sin(performance.now() / 160);
      ring.current.scale.setScalar(s);
    }
  });
  return (
    <group ref={ref}>
      <mesh geometry={pillarGeo} material={mats.pillar} scale={[you ? 1.25 : 1, 10, you ? 1.25 : 1]} renderOrder={3} />
      <group ref={ring} position={[0, 0.06, 0]}>
        <mesh geometry={ringGeo} material={mats.ring} rotation={[-Math.PI / 2, 0, 0]} scale={you ? 1.3 : 1} renderOrder={3} />
      </group>
      {labels ? (
        <Html position={[0, 2.5, 0]} center zIndexRange={[11, 10]} style={{ pointerEvents: "none" }}>
          <div
            data-testid={`intro-tag-${id}`}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              animation: "vl-rise .45s cubic-bezier(.2,.9,.3,1) both",
              animationDelay: `${(team === "blue" ? 0.15 : 0.55) + (you ? 0 : 0.08)}s`,
              whiteSpace: "nowrap",
            }}
          >
            <div
              style={{
                fontFamily: DISPLAY,
                fontWeight: 800,
                fontSize: you ? 22 : 16,
                letterSpacing: you ? 4 : 2.5,
                padding: you ? "3px 12px" : "2px 9px",
                color: you ? "#1a1204" : C.ink,
                background: you ? YOU_HEX : "rgba(10,16,24,0.82)",
                borderBottom: `3px solid ${color}`,
                boxShadow: `0 4px 18px rgba(0,0,0,.45), 0 0 18px ${color}55`,
              }}
            >
              {name}
            </div>
            <div style={{ width: 2, height: you ? 22 : 16, background: color, opacity: 0.9 }} />
          </div>
        </Html>
      ) : null}
    </group>
  );
}

function TeamHeader({ x, y, z, title, color }: { x: number; y: number; z: number; title: string; color: string }) {
  return (
    <group position={[x, FLOOR_Y + y, z]}>
      <Html center zIndexRange={[11, 10]} style={{ pointerEvents: "none" }}>
        <div
          data-testid={`intro-team-${title === "ENEMY" ? "red" : "blue"}`}
          style={{
            fontFamily: DISPLAY,
            fontWeight: 800,
            fontSize: 30,
            letterSpacing: "0.22em",
            color,
            whiteSpace: "nowrap",
            textShadow: `0 2px 14px rgba(0,0,0,.75), 0 0 26px ${color}66`,
            animation: "vl-banner .5s cubic-bezier(.2,.9,.3,1) both",
            animationDelay: title === "ENEMY" ? "0.45s" : "0.05s",
          }}
        >
          {title}
        </div>
      </Html>
    </group>
  );
}

/** The local player's own body (normally never drawn in first person). Hidden
 *  for the last part of the fly-down so the camera never ends up inside it. */
function LocalBody() {
  const ref = useRef<Group>(null);
  useFrame(() => {
    const g = ref.current;
    const t = transforms[LOCAL_ID];
    if (!g || !t) return;
    g.position.set(t.pos[0], t.pos[1] - CENTER_OFFSET, t.pos[2]);
    g.rotation.y = t.yaw;
    const e = introElapsed();
    g.visible = e >= 0 && e < INTRO_OVERVIEW_MS + INTRO_FLY_MS * 0.55;
  });
  return (
    <group ref={ref}>
      <AnimatedCharacter url={BOT_URL.blue} tint="#2f8cff" height={1.8} animState="idle" hold={<Gun length={0.22} variant="normal" />} />
    </group>
  );
}
