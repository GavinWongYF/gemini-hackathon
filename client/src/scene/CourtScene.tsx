import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import * as THREE from 'three';
import type { MatchRenderState, RecordedShot } from '@shared/contracts';
import { CourtStadium } from './CourtStadium';
import { TennisAvatar } from './TennisAvatar';
import { TennisBallAndTrajectories } from './TennisBallAndTrajectories';
import { BroadcastCamera, LANDSCAPE_BROADCAST_CAMERA } from './BroadcastCamera';

export interface CourtSceneProps {
  matchStateRef: React.MutableRefObject<MatchRenderState>;
  replayMode: boolean;
  replayArcs: RecordedShot[];
  onCanvasClick?: () => void;
}

/**
 * Akhil's Master 3D Tennis Scene.
 * Reads `matchStateRef.current` at 60 FPS inside R3F useFrame — zero React re-renders per frame!
 */
export const CourtScene: React.FC<CourtSceneProps> = ({
  matchStateRef,
  replayMode,
  replayArcs,
  onCanvasClick,
}) => {
  return (
    <div className="scene-root" onPointerDown={onCanvasClick}>
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{
          position: [
            LANDSCAPE_BROADCAST_CAMERA.x,
            LANDSCAPE_BROADCAST_CAMERA.y,
            LANDSCAPE_BROADCAST_CAMERA.z,
          ],
          fov: LANDSCAPE_BROADCAST_CAMERA.fov,
          near: 0.1,
          far: 180,
        }}
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
      >
        <color attach="background" args={['#0d1829']} />
        <fog attach="fog" args={['#0d1829', 48, 120]} />

        {/* Golden-hour / Stadium Night-Match Broadcast Lighting */}
        <Sky
          distance={450}
          sunPosition={[28, 16, -24]}
          inclination={0.48}
          azimuth={0.25}
          turbidity={6}
          rayleigh={1.2}
        />
        <ambientLight intensity={0.62} color="#dbeafe" />
        <hemisphereLight args={['#93c5fd', '#14532d', 0.55]} />

        {/* Main Stadium Key Light with Crisp Shadows */}
        <directionalLight
          position={[14, 24, 14]}
          intensity={1.75}
          color="#fffbeb"
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-16}
          shadow-camera-right={16}
          shadow-camera-top={20}
          shadow-camera-bottom={-20}
          shadow-camera-near={2}
          shadow-camera-far={65}
          shadow-bias={-0.0004}
        />
        {/* Soft Rim / Back Fill Light so near player's back and far player's front stay well lit */}
        <directionalLight position={[-10, 14, -18]} intensity={0.85} color="#e0f2fe" />

        <BroadcastCamera matchStateRef={matchStateRef} replayMode={replayMode} />

        <Suspense fallback={null}>
          <CourtStadium />
          <TennisAvatar role="player" matchStateRef={matchStateRef} />
          <TennisAvatar role="opponent" matchStateRef={matchStateRef} />
          <TennisBallAndTrajectories
            matchStateRef={matchStateRef}
            showReplayArcs={replayMode}
            replayArcs={replayArcs}
          />
        </Suspense>
      </Canvas>
    </div>
  );
};
