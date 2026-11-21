import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { MatchRenderState } from '@shared/contracts';

export const LANDSCAPE_BROADCAST_CAMERA = Object.freeze({
  x: 0,
  y: 6,
  z: 22,
  fov: 48,
  lookY: 0.8,
  lookZ: 0.6,
});

export const PORTRAIT_BROADCAST_CAMERA = Object.freeze({
  x: 0,
  y: 17.5,
  z: 24,
  pitch: -0.548,
  fov: 64,
});

export const PORTRAIT_CAMERA_FOLLOW = Object.freeze({
  deadZoneM: 2.25,
  gain: 0.65,
  maxOffsetM: 2.05,
});

export function isPortraitViewport(width: number, height: number): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > width
  );
}

export function portraitCameraFollowX(playerX: number): number {
  if (!Number.isFinite(playerX)) return 0;
  const magnitude = Math.min(
    PORTRAIT_CAMERA_FOLLOW.maxOffsetM,
    Math.max(0, Math.abs(playerX) - PORTRAIT_CAMERA_FOLLOW.deadZoneM) *
      PORTRAIT_CAMERA_FOLLOW.gain,
  );
  if (magnitude === 0) return 0;
  return Math.sign(playerX) * magnitude;
}

interface Props {
  matchStateRef: React.MutableRefObject<MatchRenderState>;
  replayMode: boolean;
}

/**
 * Responsive TV Broadcast Camera.
 * Matches the low-and-close real-game composition in landscape, switches cleanly
 * to the high-FOV portrait follow rig on narrow screens, and glides into an
 * elevated tactical orbit during Demo Pause replay.
 */
export function BroadcastCamera({ matchStateRef, replayMode }: Props) {
  const { camera, size } = useThree();
  const initialized = useRef(false);
  const targetPos = useRef(
    new THREE.Vector3(
      LANDSCAPE_BROADCAST_CAMERA.x,
      LANDSCAPE_BROADCAST_CAMERA.y,
      LANDSCAPE_BROADCAST_CAMERA.z,
    ),
  );
  const lookAtPos = useRef(
    new THREE.Vector3(
      0,
      LANDSCAPE_BROADCAST_CAMERA.lookY,
      LANDSCAPE_BROADCAST_CAMERA.lookZ,
    ),
  );
  const currentLookAt = useRef(
    new THREE.Vector3(
      0,
      LANDSCAPE_BROADCAST_CAMERA.lookY,
      LANDSCAPE_BROADCAST_CAMERA.lookZ,
    ),
  );

  useFrame(({ clock }, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const state = matchStateRef.current;
    const playerX = Number.isFinite(state?.player?.x) ? state.player.x : 0;
    const ballX = Number.isFinite(state?.ball?.x) ? state.ball.x : 0;
    let targetFov: number = LANDSCAPE_BROADCAST_CAMERA.fov;

    if (replayMode) {
      // Smooth slow tactical orbit over the court during Demo Pause
      const t = clock.elapsedTime * 0.22;
      targetPos.current.set(Math.sin(t) * 14.5, 13.5, Math.cos(t) * 14.5);
      lookAtPos.current.set(0, 0.4, 0);
      targetFov = LANDSCAPE_BROADCAST_CAMERA.fov;
    } else if (isPortraitViewport(size.width, size.height)) {
      const camX = portraitCameraFollowX(playerX);
      targetPos.current.set(
        camX,
        PORTRAIT_BROADCAST_CAMERA.y,
        PORTRAIT_BROADCAST_CAMERA.z,
      );
      lookAtPos.current.set(
        camX,
        PORTRAIT_BROADCAST_CAMERA.y + Math.tan(PORTRAIT_BROADCAST_CAMERA.pitch) * 24,
        PORTRAIT_BROADCAST_CAMERA.z - 24,
      );
      targetFov = PORTRAIT_BROADCAST_CAMERA.fov;
    } else {
      const followX = THREE.MathUtils.clamp(
        playerX * 0.22 + ballX * 0.1,
        -1.8,
        1.8,
      );
      targetPos.current.set(
        followX,
        LANDSCAPE_BROADCAST_CAMERA.y,
        LANDSCAPE_BROADCAST_CAMERA.z,
      );
      lookAtPos.current.set(
        followX * 0.45,
        LANDSCAPE_BROADCAST_CAMERA.lookY,
        LANDSCAPE_BROADCAST_CAMERA.lookZ,
      );
      targetFov = LANDSCAPE_BROADCAST_CAMERA.fov;
    }

    if (!initialized.current) {
      camera.position.copy(targetPos.current);
      currentLookAt.current.copy(lookAtPos.current);
      if (
        camera instanceof THREE.PerspectiveCamera &&
        Math.abs(camera.fov - targetFov) > 0.05
      ) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
      }
      initialized.current = true;
    } else {
      camera.position.lerp(targetPos.current, Math.min(1, dt * 4.5));
      currentLookAt.current.lerp(lookAtPos.current, Math.min(1, dt * 5.5));
      if (
        camera instanceof THREE.PerspectiveCamera &&
        Math.abs(camera.fov - targetFov) > 0.05
      ) {
        camera.fov = THREE.MathUtils.lerp(
          camera.fov,
          targetFov,
          Math.min(1, dt * 6),
        );
        camera.updateProjectionMatrix();
      }
    }

    camera.lookAt(currentLookAt.current);
  });

  return null;
}
