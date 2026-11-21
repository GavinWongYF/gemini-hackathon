import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';
import type {
  MatchPhase,
  MatchRenderState,
  StrategyVisualCue,
} from '@shared/contracts';
import { loadExternalAvatarClips } from './externalAnimations';
import {
  CLIP_CONTACT_TABLE,
  ONE_SHOT_CLIP_NAMES,
  computeStrokePlaybackPlan,
  resolveStrokeClipName,
  type SceneAnimState,
} from './clipContactTimings';

const DRACO_DECODER_PATH = '/models/draco/';
useGLTF.setDecoderPath(DRACO_DECODER_PATH);

export const RACKET_GRIP_OFFSET: [number, number, number] = [0, 0.02, 0.025];
export const RACKET_GRIP_ROTATION: [number, number, number] = [-0.12, 0.0, -0.15];

interface TennisAvatarProps {
  role: 'player' | 'opponent';
  matchStateRef: React.MutableRefObject<MatchRenderState>;
}

const STRATEGY_CUE_COLORS: Record<StrategyVisualCue, string> = {
  balanced: '#38bdf8',       // Cool sky blue
  aggressive: '#ff3b30',     // Fiery crimson
  net_rush: '#f59e0b',       // Amber attack
  defensive_wall: '#22c55e', // Emerald wall
  slice_trap: '#a855f7',     // Electric violet
};

function wrapAngleRad(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((((rad + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngleRad(b - a) * t;
}

function fixTripoMaterial(mat: THREE.Material): THREE.Material {
  const cloned = mat.clone();
  if (cloned instanceof THREE.MeshStandardMaterial) {
    // Tripo FBX/GLB exports omit metallicFactor, causing Three.js to default metalness = 1.0
    // which renders pitch black without an envMap.
    if (cloned.metalness > 0.5 && !cloned.metalnessMap) {
      cloned.metalness = 0.08;
    }
    cloned.roughness = Math.max(0.62, cloned.roughness);
    cloned.envMapIntensity = 0.9;
    if (cloned instanceof THREE.MeshPhysicalMaterial) {
      cloned.specularIntensity = Math.min(0.35, cloned.specularIntensity ?? 0.35);
    }
    cloned.needsUpdate = true;
  }
  return cloned;
}

function findRightHandBone(root: THREE.Object3D): THREE.Object3D | null {
  let fallback: THREE.Object3D | null = null;
  let exactBone: THREE.Object3D | null = null;

  root.traverse((obj) => {
    if (!obj.name) return;
    const isBone = (obj as THREE.Bone).isBone === true;
    if (obj.name === 'mixamorig:RightHand' || obj.name === 'RightHand') {
      if (isBone) exactBone = obj;
      else if (!fallback) fallback = obj;
      return;
    }
    const cleaned = obj.name.replace(/^mixamorig\d*[:_]?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (cleaned === 'righthand') {
      if (isBone && !exactBone) exactBone = obj;
      else if (!fallback) fallback = obj;
    }
  });

  return exactBone ?? fallback;
}

/**
 * Akhil's Animated Rigged Tennis Athlete.
 * Loads Tripo-converted `player_athlete.glb` or `ai_athlete.glb`,
 * repairs missing glTF metallicFactor so PBR textures light cleanly,
 * attaches `racket.glb` to the right hand bone compensating for cm-to-m Armature scale,
 * applies retargeted external Mixamo animation clips (including volleys & split_step),
 * synchronizes stroke contact timing via `CLIP_CONTACT_TABLE`,
 * and renders subtle in-world AI strategy visual cues.
 */
export function TennisAvatar({ role, matchStateRef }: TennisAvatarProps) {
  const modelUrl = role === 'player' ? '/models/player_athlete.glb' : '/models/ai_athlete.glb';
  const { scene, animations } = useGLTF(modelUrl, DRACO_DECODER_PATH);
  const { scene: racketScene } = useGLTF('/models/racket.glb', DRACO_DECODER_PATH);

  const rootRef = useRef<THREE.Group>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const clonedScene = useMemo(() => {
    const clone = SkeletonUtils.clone(scene);
    clone.visible = true;

    clone.traverse((obj) => {
      if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
        obj.frustumCulled = false;
      }
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.visible = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((m) => fixTripoMaterial(m));
        } else if (mesh.material) {
          mesh.material = fixTripoMaterial(mesh.material);
        }
      }
    });

    // Keep feet grounded cleanly at y = 0 in rest pose
    clone.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(clone);
    if (Number.isFinite(box.min.y) && Math.abs(box.min.y) > 0.001 && Math.abs(box.min.y) < 0.5) {
      clone.position.y = -box.min.y;
    }

    return clone;
  }, [scene]);

  const accentMaterials = useMemo(() => {
    const mats: THREE.MeshStandardMaterial[] = [];
    if (role !== 'opponent') return mats;
    clonedScene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const rawMats = Array.isArray((obj as THREE.Mesh).material)
          ? ((obj as THREE.Mesh).material as THREE.Material[])
          : [(obj as THREE.Mesh).material];
        for (const mat of rawMats) {
          if (mat instanceof THREE.MeshStandardMaterial && mat.name.includes('Accent')) {
            mats.push(mat);
          }
        }
      }
    });
    return mats;
  }, [clonedScene, role]);

  // Attach real-metre racket.glb to the right hand bone, compensating for cm-space Armature scale
  useEffect(() => {
    const rightHandBone = findRightHandBone(clonedScene);
    if (!rightHandBone) return;

    clonedScene.updateMatrixWorld(true);
    const boneWorldScale = new THREE.Vector3(1, 1, 1);
    rightHandBone.getWorldScale(boneWorldScale);

    const mountGroup = new THREE.Group();
    mountGroup.name = 'RacketMount';
    mountGroup.scale.set(
      1 / Math.max(1e-4, boneWorldScale.x),
      1 / Math.max(1e-4, boneWorldScale.y),
      1 / Math.max(1e-4, boneWorldScale.z),
    );

    const racketClone = racketScene.clone(true);
    racketClone.position.set(...RACKET_GRIP_OFFSET);
    racketClone.rotation.set(...RACKET_GRIP_ROTATION);
    racketClone.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
      }
    });

    mountGroup.add(racketClone);
    rightHandBone.add(mountGroup);

    return () => {
      rightHandBone.remove(mountGroup);
    };
  }, [clonedScene, racketScene]);

  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionsRef = useRef<Record<string, THREE.AnimationAction>>({});
  const currentClipRef = useRef<string>('');
  const activeOneShotRef = useRef<string | null>(null);
  const lastSwingIdRef = useRef<number>(0);
  const serveWindupActiveRef = useRef<boolean>(false);
  const prevPhaseRef = useRef<MatchPhase>('ready');
  const splitStepElapsedRef = useRef<number>(0);
  const targetColor = useMemo(() => new THREE.Color('#38bdf8'), []);

  useEffect(() => {
    const mixer = new THREE.AnimationMixer(clonedScene);
    mixerRef.current = mixer;
    currentClipRef.current = '';
    activeOneShotRef.current = null;
    const map: Record<string, THREE.AnimationAction> = {};

    const configureAction = (clip: THREE.AnimationClip) => {
      const action = mixer.clipAction(clip);
      if (ONE_SHOT_CLIP_NAMES.has(clip.name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
      return action;
    };

    for (const clip of animations) {
      map[clip.name] = configureAction(clip);
    }
    actionsRef.current = map;

    const idle = map.idle;
    if (idle) {
      idle.reset().play();
      currentClipRef.current = 'idle';
    }

    const onFinished = (e: { action: THREE.AnimationAction }) => {
      const finishedName = e.action.getClip().name;
      if (activeOneShotRef.current === finishedName) {
        activeOneShotRef.current = null;
      }
    };
    mixer.addEventListener('finished', onFinished);

    let cancelled = false;
    void loadExternalAvatarClips(clonedScene).then((extClips) => {
      if (cancelled || !mixerRef.current) return;
      const replacedNames = new Set<string>();
      for (const clip of extClips) {
        const existing = actionsRef.current[clip.name];
        if (existing) {
          existing.stop();
        }
        actionsRef.current[clip.name] = configureAction(clip);
        replacedNames.add(clip.name);
      }

      // Start idle (or restart the active clip if it was replaced) once external clips arrive
      const activeName = currentClipRef.current;
      const activeAction = activeName ? actionsRef.current[activeName] : undefined;
      if (!activeAction || !activeAction.isRunning() || replacedNames.has(activeName)) {
        const startName =
          activeOneShotRef.current && actionsRef.current[activeOneShotRef.current]
            ? activeOneShotRef.current
            : activeName && actionsRef.current[activeName]
              ? activeName
              : 'idle';
        const startAction = actionsRef.current[startName] ?? actionsRef.current.idle;
        if (startAction) {
          const defaultSpeed = CLIP_CONTACT_TABLE[startName]?.speed ?? 1.0;
          startAction.reset();
          startAction.enabled = true;
          startAction.setEffectiveWeight(1);
          startAction.setEffectiveTimeScale(ONE_SHOT_CLIP_NAMES.has(startName) ? defaultSpeed : 1.0);
          startAction.play();
          currentClipRef.current = actionsRef.current[startName] ? startName : 'idle';
        }
      }
    });

    return () => {
      cancelled = true;
      mixer.removeEventListener('finished', onFinished);
      mixer.stopAllAction();
      mixerRef.current = null;
    };
  }, [clonedScene, animations]);

  const playClip = (
    clipName: string,
    fade = 0.12,
    forceRestart = false,
    timeScale = 1.0,
    startTime = 0,
  ) => {
    const actions = actionsRef.current;
    const resolvedName = actions[clipName] ? clipName : 'idle';
    const next = actions[resolvedName];
    if (!next) return;

    if (!forceRestart && currentClipRef.current === resolvedName && next.isRunning()) {
      next.setEffectiveTimeScale(timeScale);
      return;
    }

    const prev = actions[currentClipRef.current];
    next.reset();
    next.time = Math.min(Math.max(0, startTime), Math.max(0, next.getClip().duration - 0.01));
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(timeScale);
    if (prev && prev !== next) {
      prev.enabled = true;
      next.crossFadeFrom(prev, fade, false);
    }
    next.play();
    currentClipRef.current = resolvedName;
  };

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const state = matchStateRef.current;
    const athlete = role === 'player' ? state?.player : state?.opponent;
    const group = rootRef.current;
    if (!group || !athlete) return;

    group.visible = true;

    const ax = Number.isFinite(athlete.x) ? athlete.x : 0;
    const az = Number.isFinite(athlete.z) ? athlete.z : role === 'player' ? 11.2 : -9.5;
    const avx = Number.isFinite(athlete.vx) ? athlete.vx : 0;
    const avz = Number.isFinite(athlete.vz) ? athlete.vz : 0;
    const yaw = Number.isFinite(athlete.facingYaw)
      ? athlete.facingYaw
      : role === 'player'
        ? Math.PI
        : 0;

    // Smooth visual root placement (feet remain grounded at y = 0)
    group.position.x = THREE.MathUtils.lerp(group.position.x, ax, Math.min(1, dt * 18));
    group.position.y = 0;
    group.position.z = THREE.MathUtils.lerp(group.position.z, az, Math.min(1, dt * 18));

    // Local-space velocity relative to athlete.facingYaw
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const rightX = -Math.cos(yaw);
    const rightZ = Math.sin(yaw);
    const vzLocal = avx * forwardX + avz * forwardZ;
    const vxLocal = avx * rightX + avz * rightZ;
    const speed = Math.hypot(avx, avz);

    // Clear finished or timed-out one-shot clips
    if (activeOneShotRef.current) {
      const currentOneShot = actionsRef.current[activeOneShotRef.current];
      if (
        !currentOneShot ||
        !currentOneShot.isRunning() ||
        (activeOneShotRef.current === 'split_step' && splitStepElapsedRef.current >= 0.3)
      ) {
        activeOneShotRef.current = null;
        if (serveWindupActiveRef.current && currentClipRef.current !== 'serve') {
          serveWindupActiveRef.current = false;
        }
      }
    }

    const swingId = athlete.swingTriggerId ?? 0;

    // Handle match restart / counter resets cleanly
    if (swingId < lastSwingIdRef.current) {
      lastSwingIdRef.current = swingId;
      serveWindupActiveRef.current = false;
    }

    const hasNewSwingTrigger = swingId !== lastSwingIdRef.current;
    const phase = state.phase;

    const triggerStroke = () => {
      const intended = resolveStrokeClipName(athlete);
      const resolvedClip: SceneAnimState =
        intended === 'volley_forehand' && !actionsRef.current.volley_forehand
          ? 'forehand'
          : intended === 'volley_backhand' && !actionsRef.current.volley_backhand
            ? 'backhand'
            : intended;

      const plan = computeStrokePlaybackPlan(resolvedClip);
      activeOneShotRef.current = resolvedClip;
      splitStepElapsedRef.current = 0;
      playClip(resolvedClip, 0.06, true, plan.timeScale, plan.startTime);
    };

    // 1. Trigger stroke or synchronized serve windup
    if (
      role === 'opponent' &&
      phase === 'serving' &&
      athlete.animState === 'serve' &&
      (prevPhaseRef.current !== 'serving' || currentClipRef.current !== 'serve') &&
      actionsRef.current.serve
    ) {
      serveWindupActiveRef.current = true;
      activeOneShotRef.current = 'serve';
      splitStepElapsedRef.current = 0;
      playClip('serve', 0.08, true, 1.4, 1.15);
    } else if (hasNewSwingTrigger) {
      lastSwingIdRef.current = swingId;
      if (
        serveWindupActiveRef.current &&
        athlete.animState === 'serve' &&
        currentClipRef.current === 'serve' &&
        activeOneShotRef.current === 'serve'
      ) {
        // Serve windup already reached contact — let follow-through finish smoothly
        serveWindupActiveRef.current = false;
      } else {
        serveWindupActiveRef.current = false;
        triggerStroke();
      }
    } else if (
      role === 'player' &&
      prevPhaseRef.current === 'serving' &&
      phase === 'rally' &&
      !activeOneShotRef.current &&
      actionsRef.current.split_step
    ) {
      // Receiver split-step anticipation as the serve launches
      activeOneShotRef.current = 'split_step';
      splitStepElapsedRef.current = 0;
      playClip('split_step', 0.06, true, CLIP_CONTACT_TABLE.split_step.speed, 0);
    } else if (!activeOneShotRef.current) {
      // 2. Locomotion / Idle selection with velocity-matched playback speed.
      // Strokes are triggered exclusively by swingTriggerId / serve phase above, so if
      // athlete.animState holds a stroke name after completion, fall through to run/idle.
      let desired: SceneAnimState;
      let desiredTimeScale = 1.0;

      if (athlete.animState === 'celebrate' && actionsRef.current.celebrate) {
        desired = 'celebrate';
        desiredTimeScale = 1.0;
        if (currentClipRef.current !== 'celebrate') {
          activeOneShotRef.current = 'celebrate';
          playClip(desired, 0.14, true, desiredTimeScale, 0);
        }
      } else {
        if (speed > 0.35) {
          const locoScale = THREE.MathUtils.clamp(speed / 3.8, 0.65, 1.75);
          if (Math.abs(vxLocal) > Math.abs(vzLocal)) {
            desired = vxLocal >= 0 ? 'run_right' : 'run_left';
            desiredTimeScale = locoScale;
          } else if (vzLocal < -0.5) {
            if (actionsRef.current.run_back) {
              desired = 'run_back';
              desiredTimeScale = locoScale;
            } else {
              desired = 'run_forward';
              desiredTimeScale = -locoScale * 0.85;
            }
          } else {
            desired = 'run_forward';
            desiredTimeScale = locoScale;
          }
        } else {
          desired = 'idle';
          desiredTimeScale = 1.0;
        }

        playClip(desired, 0.14, false, desiredTimeScale, 0);
      }
    }

    prevPhaseRef.current = phase;

    if (activeOneShotRef.current === 'split_step') {
      splitStepElapsedRef.current += dt;
    }

    // Smoothly orient avatar toward facingYaw (leaning slightly into lateral run, returning on idle/swing)
    const isSwinging =
      activeOneShotRef.current !== null && activeOneShotRef.current !== 'split_step';
    const runYawBias =
      !isSwinging && speed > 0.6
        ? -THREE.MathUtils.clamp(vxLocal * 0.08, -0.32, 0.32)
        : 0;
    const targetYaw = yaw + runYawBias;
    group.rotation.y = lerpAngle(group.rotation.y, targetYaw, Math.min(1, dt * 12));

    // 3. Subtle AI visual cue tint (telegraphs strategy updates cleanly in-world)
    if (role === 'opponent' && athlete.strategyVisualCue) {
      targetColor.set(STRATEGY_CUE_COLORS[athlete.strategyVisualCue] ?? '#38bdf8');
      for (const mat of accentMaterials) {
        mat.color.lerp(targetColor, dt * 5);
        mat.emissive.lerp(targetColor, dt * 5);
      }
      if (ringMatRef.current) {
        ringMatRef.current.color.lerp(targetColor, dt * 5);
      }
    }

    mixerRef.current?.update(dt);
  });

  return (
    <group
      ref={rootRef}
      visible
      position={[0, 0, role === 'player' ? 11.2 : -9.5]}
      rotation={[0, role === 'player' ? Math.PI : 0, 0]}
    >
      <primitive object={clonedScene} />

      {/* Ground footwork / strategy cue ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.014, 0]}>
        <ringGeometry args={[0.42, 0.54, 32]} />
        <meshBasicMaterial
          ref={ringMatRef}
          color={role === 'player' ? '#38bdf8' : '#f97316'}
          transparent
          opacity={role === 'opponent' ? 0.58 : 0.38}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

useGLTF.preload('/models/player_athlete.glb', DRACO_DECODER_PATH);
useGLTF.preload('/models/ai_athlete.glb', DRACO_DECODER_PATH);
useGLTF.preload('/models/racket.glb', DRACO_DECODER_PATH);
