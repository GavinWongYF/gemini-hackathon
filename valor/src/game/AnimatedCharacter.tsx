// ─────────────────────────────────────────────────────────────────────────
// AnimatedCharacter.tsx — the crossfading animation blender (Agent B).
//
// Fits a character rig (via fit.ts) and drives it with a single AnimationMixer
// that crossfades between every clip in ANIM_CLIPS as `animState` changes.
//
// MIXER / CROSSFADE DESIGN
//   - We build ONE mixer on the fitted `object`, plus one persistent
//     AnimationAction per clip (all kept alive for the object's lifetime). On
//     an animState change we reset+play the next action and crossFadeTo it from
//     the previous over CROSSFADE_S, so weights ramp smoothly rather than
//     popping. Keeping every action alive means a crossfade never has to
//     rebuild a clip mid-frame — all per-frame work is just `mixer.update(dt)`.
//   - Track fixup is reused from Models.tsx `ClipPlayer`: clip nodes keep the
//     Mixamo "mixamorig:Bone" colon while the character GLB strips it to
//     "mixamorigBone", so we normalize track names; and we drop tracks whose
//     bone isn't on this (reduced-hand) rig to silence PropertyBinding warnings.
//
// POSITION TRACKS / DEATH HIP-Y DECISION
//   - Clips are authored in CENTIMETRES; this rig lives in METRES. An absolute
//     hip-translation track would therefore fling the body ~100x skyward, and
//     the KCC already moves the body in world space — so for locomotion / idle /
//     fire / reload we drop ALL `.position` tracks and stay perfectly in-place.
//   - DEATH is the exception (ROOT_MOTION_CLIPS): we want the body to actually
//     drop as it collapses instead of standing upright while the limbs fold. So
//     for the death clip we KEEP the `mixamorigHips.position` track but SCALE
//     its values by HIP_SCALE (cm→m). HIP_SCALE is a guess that needs a browser
//     eyeball — see the const below. Death plays once and clamps; it never loops
//     and never resets to idle on its own.
//
// Parent components own world placement (position/rotation via the group props);
// this component only fits + animates the rig.
// ─────────────────────────────────────────────────────────────────────────

import type * as React from "react";
import { useMemo, useLayoutEffect, useEffect, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { createPortal, useFrame } from "@react-three/fiber";
import { AnimationMixer, AnimationClip, LoopOnce, LoopRepeat, Color, type AnimationAction, type Material, type Mesh, type Object3D } from "three";
import { fitCharacter } from "./fit";
import { ANIM_CLIPS, ONESHOT_CLIPS, ROOT_MOTION_CLIPS, type AnimState } from "./contracts";

export interface AnimatedCharacterProps extends React.ComponentProps<"group"> {
  url: string;
  height?: number;
  /** Item to portal into the right hand (e.g. <Gun/>). Authored in metres. */
  hold?: React.ReactNode;
  /** Which clip to play. Resolve via resolveAnimState(); do not pick clips ad-hoc. */
  animState: AnimState;
  /** Cast the sun's shadow (default true). The first-person rig passes false. */
  castShadows?: boolean;
  /** Team tint (hex). Materials are CLONED per instance before tinting, so a
   *  tint never leaks into another character sharing the same GLB. */
  tint?: string;
}

// In-hand transform for the held gun (the "while animating" preset from the
// studio — a clip is always playing in-game so the hand pose matches).
const HOLD_OFFSET: [number, number, number] = [0.04, 0.24, -0.02];
const HOLD_ROTATION: [number, number, number] = [(-277 * Math.PI) / 180, (15 * Math.PI) / 180, (-75 * Math.PI) / 180];
const HOLD_SCALE = 1.2;
const GRIP_CURL = 1;

// Crossfade duration between anim states, seconds.
const CROSSFADE_S = 0.15;

// cm→m factor for the KEPT death hip-translation track. Clips are authored in
// centimetres and the rig is metres, so the raw hip-Y values are ~100x too big.
// 0.01 is the nominal conversion; the real number depends on how the death GLB
// was exported, so this NEEDS A BROWSER EYEBALL — if the body sinks through the
// floor or barely drops, nudge this.
const HIP_SCALE = 0.01;

// Order matters only as a stable list of [state, url] to load/build.
const CLIP_ENTRIES = Object.entries(ANIM_CLIPS) as [AnimState, string][];

export function AnimatedCharacter({ url, height = 1.8, hold, animState, castShadows = true, tint, ...props }: AnimatedCharacterProps) {
  const { scene } = useGLTF(url);
  const { object, scale, offset, hand, handScale, fingerBones } = useMemo(() => fitCharacter(scene, height), [scene, height]);

  // Preload every clip GLB. Order is fixed (CLIP_ENTRIES), so calling useGLTF
  // per clip in a stable loop keeps the Hooks order stable across renders.
  const clipGltfs = CLIP_ENTRIES.map(([, clipUrl]) => useGLTF(clipUrl));

  useLayoutEffect(() => {
    object.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh) o.castShadow = castShadows;
    });
  }, [object, castShadows]);

  // Team tint: per-instance material clones, base colour pulled toward the tint
  // plus a faint emissive so the team reads even in shade.
  useLayoutEffect(() => {
    if (!tint) return;
    const tc = new Color(tint);
    const made: Material[] = [];
    const restore: [Mesh, Mesh["material"]][] = [];
    object.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      restore.push([m, m.material]);
      const tintOne = (src: Material) => {
        const c = src.clone() as Material & { color?: Color; emissive?: Color; emissiveIntensity?: number };
        if (c.color) c.color.lerp(tc, 0.7);
        if (c.emissive) {
          c.emissive.copy(tc);
          c.emissiveIntensity = 0.28;
        }
        made.push(c);
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(tintOne) : tintOne(m.material);
    });
    return () => {
      for (const [m, orig] of restore) m.material = orig;
      made.forEach((c) => c.dispose());
    };
  }, [object, tint]);

  // Curl the fingers around the grip (static fist; the clips don't pose the
  // reduced hand, so we bend the finger joints procedurally like the studio).
  useLayoutEffect(() => {
    for (const { bone, restQ } of fingerBones) {
      bone.quaternion.copy(restQ);
      bone.rotateX(GRIP_CURL * 1.2);
    }
  }, [fingerBones]);

  // Build ONE mixer on the fitted object plus one action per state. Rebuilds
  // only when the fitted object (or a loaded clip set) changes. All per-frame
  // cost lives in useFrame; this just wires up the crossfade graph.
  const { mixer, actions } = useMemo(() => {
    const mixer = new AnimationMixer(object);
    const actions = {} as Record<AnimState, AnimationAction>;
    CLIP_ENTRIES.forEach(([state, clipUrl], i) => {
      // Track-fixed clip, built once per (source clip, rig) and SHARED by every
      // character using this rig (mixers can share AnimationClips) — no per-bot
      // track cloning, and switching animState never rebuilds anything.
      const clip = processedClip(clipGltfs[i].animations[0], url, object, state, clipUrl);
      const action = mixer.clipAction(clip);
      if (ONESHOT_CLIPS.has(state)) {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true; // hold the last pose (death stays down)
      } else {
        action.setLoop(LoopRepeat, Infinity);
      }
      actions[state] = action;
    });
    return { mixer, actions };
    // useGLTF returns cached (identity-stable) results per url, so depend on the
    // individual clip GLTFs, not the per-render array (which is always new and
    // used to rebuild the mixer on EVERY re-render, i.e. every anim change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object, url, ...clipGltfs]);

  // Track the currently-playing action so we can crossFadeTo the next one.
  const currentRef = useRef<AnimationState | null>(null);

  // Kick the initial action once the mixer/actions exist (no fade in).
  useEffect(() => {
    const first = actions[animState] ?? actions.idle;
    first.reset().play();
    currentRef.current = { state: animState in actions ? animState : "idle", action: first };
    return () => {
      mixer.stopAllAction();
    };
    // Only on (re)build of the mixer; animState changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixer, actions]);

  // Crossfade on animState change. Death never loops or self-resets (LoopOnce +
  // clampWhenFinished), and we never force it back to idle here — the arbiter
  // (resolveAnimState) keeps returning "death" while the entity is dead.
  useEffect(() => {
    const next = actions[animState];
    if (!next) return;
    const cur = currentRef.current;
    if (cur && cur.action === next) return; // already on this clip

    next.reset();
    next.play();
    if (cur) {
      cur.action.crossFadeTo(next, CROSSFADE_S, false);
    }
    currentRef.current = { state: animState, action: next };
  }, [animState, actions]);

  useFrame((_, dt) => mixer.update(dt));

  return (
    <group {...props}>
      <group scale={scale} position={offset}>
        <primitive object={object} />
      </group>
      {hold && hand &&
        createPortal(
          <group scale={handScale}>
            <group position={HOLD_OFFSET} rotation={HOLD_ROTATION} scale={HOLD_SCALE}>
              {hold}
            </group>
          </group>,
          hand,
        )}
    </group>
  );
}

// ── Shared, track-fixed clips ─────────────────────────────────────────────
// Keyed by source clip → rig url. Fixups (see header): normalize the Mixamo
// colon in track names, drop position tracks (except the death hip, scaled
// cm→m), and drop tracks for bones this reduced-hand rig doesn't have.
const clipCache = new WeakMap<AnimationClip, Map<string, AnimationClip>>();
function processedClip(src: AnimationClip, rigUrl: string, rig: Object3D, state: AnimState, clipUrl: string): AnimationClip {
  let byRig = clipCache.get(src);
  if (!byRig) clipCache.set(src, (byRig = new Map()));
  const hit = byRig.get(rigUrl);
  if (hit) return hit;

  const bones = new Set<string>();
  rig.traverse((o) => bones.add(o.name));
  const keepHips = ROOT_MOTION_CLIPS.has(state); // death keeps a scaled hip-Y
  const tracks = src.tracks
    .map((t) => {
      const c = t.clone();
      c.name = c.name.replace(/:/g, ""); // mixamorig:Hips.quaternion -> mixamorigHips.quaternion
      return c;
    })
    .filter((t) => {
      if (!t.name.endsWith(".position")) return true;
      return keepHips && t.name === "mixamorigHips.position";
    })
    .filter((t) => bones.has(t.name.split(".")[0]));
  for (const t of tracks) {
    if (keepHips && t.name === "mixamorigHips.position") {
      for (let k = 0; k < t.values.length; k++) t.values[k] *= HIP_SCALE;
    }
  }
  const clip = new AnimationClip(clipUrl, src.duration, tracks);
  byRig.set(rigUrl, clip);
  return clip;
}

// Small record tying an active state to its action, for crossfade bookkeeping.
interface AnimationState {
  state: AnimState;
  action: AnimationAction;
}
