// ─────────────────────────────────────────────────────────────────────────
// GameScene.tsx — the wired playable scene (PASS 1).
//
// Mounts the full local FPS: Rapier physics world + arena (fixed trimesh
// collider, registered with the hitscan BVH), the first-person PlayerController
// camera, the Weapon (fire pipeline + viewmodel), patrolling shootable Bots,
// pooled VFX, keyboard/mouse InputController, and the DOM HUD overlay.
//
// Physics runs a FIXED timestep (1/60) so movement and the 5-shots-to-kill
// cadence are frame-rate independent. Click the canvas to lock the pointer and
// play; WASD move, mouse look, click to fire, R to reload, Ctrl/C crouch.
// The studio (character/gun/anim viewer) stays at the default route; `?game`
// loads this.
// ─────────────────────────────────────────────────────────────────────────

import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer, PerformanceMonitor, Sky } from "@react-three/drei";
import { Physics, RigidBody } from "@react-three/rapier";
import type { DirectionalLight, Group } from "three";
import { Arena } from "../Models";
import { Scatter } from "../Scatter";
import { PlayerController } from "./PlayerController";
import { Weapon } from "./Weapon";
import { RoundManager } from "./RoundManager";
import { Vfx } from "./vfx";
import { HUD } from "./HUD";
import { PadHost } from "./PadHost";
import { AIM_ASSIST, InputController, inputExtra } from "./input";
import { registerWorld, clearWorld, raycastShot } from "./hitscan";
import { tickCombat, combat } from "./combat";
import { useGame, useControls, transforms } from "./stores";
import { LOCAL_ID } from "./contracts";
import { StartOverlay } from "./StartOverlay";
import { startAgentBridge } from "../agent";
import { Countdown } from "./ui/Countdown";
import { initAudio, setWalking } from "./sfx";
import { TargetLock } from "./TargetLock";
import { updateLock, getLock } from "./aimAssist";

// Static world: trimesh collider around the carved arena, also registered with
// the hitscan BVH for bullet-vs-world tests. Registration runs after the GLB has
// mounted under our group (we're inside <Suspense>, so geometry is ready).
function World() {
  const ref = useRef<Group>(null);
  useEffect(() => {
    if (ref.current) registerWorld(ref.current);
    return () => clearWorld();
  }, []);
  return (
    <RigidBody type="fixed" colliders="trimesh">
      <group ref={ref}>
        <Arena />
      </group>
      <Scatter />
    </RigidBody>
  );
}

// Bulletproof audio unlock: browsers gate audio behind a user gesture. Unlock on
// the FIRST pointer/keypress ANYWHERE (vision mode has no pointer-lock click), so
// the first interaction can't be missed. initAudio() is idempotent.
function AudioUnlock() {
  useEffect(() => {
    const unlock = () => initAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
  return null;
}

// Loops the footstep sound while the local player walks on the ground (crouched
// → slower + pitched down).
function Footsteps() {
  useFrame(() => {
    const t = transforms[LOCAL_ID];
    const moving = !!t && t.grounded && Math.hypot(t.forwardSpeed, t.lateralSpeed) > 0.5;
    const crouched = !!t && t.crouchAmount > 0.5;
    // Shift-walk (or slow movement) → quiet footsteps.
    const quiet = inputExtra.walk || (!!t && Math.hypot(t.forwardSpeed, t.lateralSpeed) < 2.6);
    setWalking(moving, crouched, quiet);
  });
  return null;
}

// Drives time-based combat (respawns) once per frame, scene-wide.
function CombatTicker() {
  useFrame(() => tickCombat(Date.now()));
  return null;
}

// Explicit render pass. The Weapon's recoil uses a positive-priority useFrame
// (priority 10), which switches R3F into MANUAL render mode and disables its
// automatic render (otherwise the canvas stays black). So we render the scene
// ourselves at the HIGHEST priority — after movement (physics step), all
// priority-0 updates, and the recoil offset have run for the frame.
// Sun with a shadow camera that FOLLOWS the player: a tight ±SHADOW_HALF box
// around the camera (texel-snapped so shadows don't shimmer as you move) gives
// crisp character/arena shadows from one 2048 map, and three culls every caster
// outside it from the shadow pass.
const SUN_DIR: [number, number, number] = [12, 18, 8];
const SHADOW_HALF = 22;
const SHADOW_MAP = 2048;
function Sun() {
  const light = useRef<DirectionalLight>(null);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const l = light.current;
    if (!l) return;
    scene.add(l.target);
    return () => {
      scene.remove(l.target);
    };
  }, [scene]);
  useFrame(() => {
    const l = light.current;
    if (!l) return;
    const texel = (SHADOW_HALF * 2) / SHADOW_MAP;
    const x = Math.round(camera.position.x / texel) * texel;
    const z = Math.round(camera.position.z / texel) * texel;
    const y = camera.position.y;
    l.target.position.set(x, y - 2, z);
    l.position.set(x + SUN_DIR[0] * 2, y - 2 + SUN_DIR[1] * 2, z + SUN_DIR[2] * 2);
    l.target.updateMatrixWorld();
  });
  return (
    <directionalLight
      ref={light}
      position={SUN_DIR}
      intensity={2.2}
      castShadow
      shadow-mapSize={[SHADOW_MAP, SHADOW_MAP]}
      shadow-camera-left={-SHADOW_HALF}
      shadow-camera-right={SHADOW_HALF}
      shadow-camera-top={SHADOW_HALF}
      shadow-camera-bottom={-SHADOW_HALF}
      shadow-camera-near={1}
      shadow-camera-far={120}
      shadow-bias={-0.0004}
      shadow-normalBias={0.03}
    />
  );
}

// Local, procedural image-based lighting (replaces <Environment preset="city">,
// which downloaded a 1k HDR from GitHub on every load). Rendered ONCE into a
// small cube map from a few light panels tinted like the sky/ground, so PBR
// metals (the gun) still get reflections and nothing is fetched at runtime.
function LocalEnvironment() {
  return (
    <Environment frames={1} resolution={128} environmentIntensity={0.9}>
      <color attach="background" args={["#9fb6c9"]} />
      {/* sky dome */}
      <Lightformer form="rect" intensity={1.6} color="#dfeaf5" position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[30, 30, 1]} />
      {/* warm ground bounce */}
      <Lightformer form="rect" intensity={0.6} color="#7a6248" position={[0, -6, 0]} rotation-x={-Math.PI / 2} scale={[30, 30, 1]} />
      {/* sun hot spot + soft horizon strips (city-like streak reflections) */}
      <Lightformer form="circle" intensity={6} color="#fff3dc" position={[12, 18, 8]} scale={4} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={1.2} color="#ffffff" position={[0, 1, -10]} scale={[20, 2, 1]} />
      <Lightformer form="rect" intensity={0.8} color="#cfe0ee" position={[-10, 1, 0]} rotation-y={Math.PI / 2} scale={[20, 2, 1]} />
      <Lightformer form="rect" intensity={0.8} color="#cfe0ee" position={[10, 1, 0]} rotation-y={-Math.PI / 2} scale={[20, 2, 1]} />
      <Lightformer form="rect" intensity={0.6} color="#e6d6c0" position={[0, 1, 10]} rotation-y={Math.PI} scale={[20, 2, 1]} />
    </Environment>
  );
}

function RenderPass() {
  useFrame(({ gl, scene, camera }) => gl.render(scene, camera), 1000);
  return null;
}

// Dev-only handle so an automated browser smoke test can exercise the REAL wired
// modules (raycast against the live scene, apply damage) — stripped from prod.
function DevHook() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __mosh?: unknown }).__mosh = { useGame, useControls, transforms, raycastShot, combat, LOCAL_ID, gl, scene, camera, updateLock, getLock };
  }, [gl, scene, camera]);
  return null;
}

function Scene() {
  return (
    <>
      {/* Same look as the studio map: sky-blue bg + fog + sun */}
      <color attach="background" args={["#bcd4e6"]} />
      {/* Distance fog in the sky colour hides the hard edge where the map ends. */}
      <fog attach="fog" args={["#c4d6e4", 30, 95]} />
      <Sky sunPosition={[60, 18, 40]} turbidity={3} rayleigh={3} mieCoefficient={0.005} mieDirectionalG={0.7} />
      <hemisphereLight args={["#bcd4e6", "#5a4633", 0.9]} />
      <Sun />
      <LocalEnvironment />

      <Physics timeStep={1 / 60}>
        <World />
        {/* Spawn just above the measured plaza floor (feet ~-3.76) so the player
            settles instantly instead of free-falling several metres. */}
        {/* Spawn on the real plaza ground (~y -7, per the studio's dialed-in stand
            point), capsule centre a bit above so it settles instead of falling. */}
        {/* Exact spot the studio proved is solid ground (char stood at y -7). */}
        <PlayerController spawn={[12, -6, -9.5]} />
        <Weapon />
        {AIM_ASSIST && <TargetLock />}
        <RoundManager />
        <Vfx />
        <CombatTicker />
        <Footsteps />
      </Physics>

      <AudioUnlock />
      <InputController />
      <DevHook />
      <RenderPass />
    </>
  );
}

// Pixel-ratio bounds: never above 1.5 (retina 2x costs ~1.8x the fragments of
// 1.5x for little visible gain in a fast FPS), never below 0.85.
const DPR_MAX = 1.5;
const DPR_MIN = 0.85;

export function Game() {
  const dprMax = Math.min(DPR_MAX, Math.max(1, window.devicePixelRatio || 1));
  const [dpr, setDpr] = useState(dprMax);
  // Adaptive enemies: connects to the Gemini backend (or the labelled offline
  // stand-in) and swaps the red team's behaviour between rounds.
  useEffect(() => startAgentBridge(), []);
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Canvas
        // PCF (not PCFSoft — deprecated in three r18x and silently downgraded).
        shadows="percentage"
        camera={{ position: [0, 1.5, 6], fov: 75, near: 0.05, far: 300 }}
        dpr={dpr}
        gl={{ preserveDrawingBuffer: import.meta.env.DEV, powerPreference: "high-performance", stencil: false }}
      >
        {/* Adaptive resolution: if the GPU can't hold the refresh rate, drop the
            pixel ratio toward DPR_MIN; climb back toward DPR_MAX when there's
            headroom. Settles on 1.0 if it keeps flip-flopping. */}
        <PerformanceMonitor
          onChange={({ factor }) => setDpr(Math.round((DPR_MIN + (dprMax - DPR_MIN) * factor) * 20) / 20)}
          onFallback={() => setDpr(1)}
          factor={1}
          // Only step down when fps really sags (<45); 60/120/144 Hz all incline.
          bounds={() => [45, 58]}
          flipflops={3}
        />
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>

      <HUD />
      <Countdown />
      <PadHost />
      <StartOverlay />
    </div>
  );
}
