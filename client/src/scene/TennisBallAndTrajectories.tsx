import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { COURT, type MatchRenderState, type RecordedShot } from '@shared/contracts';

interface Props {
  matchStateRef: React.MutableRefObject<MatchRenderState>;
  showReplayArcs: boolean;
  replayArcs: RecordedShot[];
}

export const TENNIS_BALL_FILL = 0.28;

export function readableTennisBallRadius(
  viewDepth: number,
  projectionY: number,
  width: number,
  height: number,
): number {
  const desktopBlend = Math.max(0, Math.min(1, (width - 480) / 480));
  const minimumDiameterPx = 4.5 + 2 * desktopBlend;
  return Math.max(
    0.048,
    (minimumDiameterPx * Math.max(0, viewDepth)) /
      (Math.max(0.01, projectionY) * Math.max(1, height)),
  );
}

const TRAIL_COUNT = 10;
const BOUNCE_MARK_DURATION = 0.9;
const HIT_FLASH_DURATION = 0.14;

const SHOT_ARC_COLORS: Record<string, string> = {
  topspin: '#38bdf8',
  flat: '#facc15',
  slice: '#c084fc',
  dropshot: '#22c55e',
  lob: '#fb923c',
  volley: '#f43f5e',
};

/**
 * High-readability Tennis Ball (apparent-size scaled optic yellow + contact shadow +
 * subtle short live trail + fading bounce mark + contact flash + Demo Pause 3D arcs).
 */
export function TennisBallAndTrajectories({
  matchStateRef,
  showReplayArcs,
  replayArcs,
}: Props) {
  const { camera, size } = useThree();

  const ballRef = useRef<THREE.Mesh>(null);
  const shadowRef = useRef<THREE.Mesh>(null);
  const shadowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const markerRef = useRef<THREE.Mesh>(null);

  const hitFlashRef = useRef<THREE.Mesh>(null);
  const hitFlashMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const bounceRingRef = useRef<THREE.Mesh>(null);
  const bounceRingMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const bounceDiscRef = useRef<THREE.Mesh>(null);
  const bounceDiscMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const trailMeshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const trailMatRefs = useRef<(THREE.MeshBasicMaterial | null)[]>([]);

  const ballWorldPos = useRef(new THREE.Vector3());
  const trailPositions = useRef<THREE.Vector3[]>(
    Array.from({ length: TRAIL_COUNT }, () => new THREE.Vector3()),
  );
  const trailCount = useRef(0);
  const trailHead = useRef(0);
  const lastSamplePos = useRef(new THREE.Vector3());
  const hasLastSample = useRef(false);

  const prevBounceCount = useRef(0);
  const bounceStartClock = useRef<number | null>(null);
  const bouncePos = useRef(new THREE.Vector3(0, 0.018, 0));

  const prevVz = useRef(0);
  const wasBallActive = useRef(false);
  const hitFlashStartClock = useRef<number | null>(null);

  useFrame(({ clock }) => {
    const state = matchStateRef.current;
    const ball = state?.ball;
    if (!ball) return;

    const bx = Number.isFinite(ball.x) ? ball.x : 0;
    const by = Number.isFinite(ball.y) ? ball.y : COURT.VISUAL_BALL_RADIUS;
    const bz = Number.isFinite(ball.z) ? ball.z : 0;
    const bvx = Number.isFinite(ball.vx) ? ball.vx : 0;
    const bvz = Number.isFinite(ball.vz) ? ball.vz : 0;

    ballWorldPos.current.set(bx, Math.max(COURT.VISUAL_BALL_RADIUS, by), bz);

    const viewDepth = camera.position.distanceTo(ballWorldPos.current);
    const projectionY = camera.projectionMatrix.elements[5];
    const visualRadius = Math.max(
      COURT.VISUAL_BALL_RADIUS,
      readableTennisBallRadius(viewDepth, projectionY, size.width, size.height),
    );
    const ballScale = visualRadius / COURT.VISUAL_BALL_RADIUS;
    ballWorldPos.current.y = Math.max(visualRadius, by);

    if (ballRef.current) {
      ballRef.current.visible = Boolean(ball.active);
      ballRef.current.position.copy(ballWorldPos.current);
      ballRef.current.scale.setScalar(ballScale);
      // Visual spin rotation
      ballRef.current.rotation.x += bvz * 0.04;
      ballRef.current.rotation.z -= bvx * 0.04;
    }

    if (shadowRef.current && shadowMatRef.current) {
      shadowRef.current.visible = Boolean(ball.active);
      shadowRef.current.position.set(bx, 0.015, bz);
      const h = Math.max(0, by);
      const scale = Math.max(0.45, 1.15 - h * 0.14);
      shadowRef.current.scale.set(scale, scale, 1);
      shadowMatRef.current.opacity = Math.max(0.14, 0.58 - h * 0.08);
    }

    if (markerRef.current) {
      if (ball.active && ball.landingMarker) {
        markerRef.current.visible = true;
        markerRef.current.position.set(
          ball.landingMarker.x,
          0.018,
          ball.landingMarker.z,
        );
        const pulse = 1 + Math.sin(clock.elapsedTime * 8) * 0.12;
        markerRef.current.scale.set(pulse, pulse, 1);
      } else {
        markerRef.current.visible = false;
      }
    }

    // Short, subtle fading live trail during active rallies
    if (!showReplayArcs && ball.active) {
      if (hasLastSample.current) {
        const distSq = lastSamplePos.current.distanceToSquared(
          ballWorldPos.current,
        );
        if (distSq > 4.0) {
          // Ball teleported / reset between points (> 2m jump)
          trailCount.current = 0;
        } else if (distSq > 0.0004) {
          trailHead.current = (trailHead.current + 1) % TRAIL_COUNT;
          trailPositions.current[trailHead.current].copy(lastSamplePos.current);
          trailCount.current = Math.min(TRAIL_COUNT, trailCount.current + 1);
        }
      }
      lastSamplePos.current.copy(ballWorldPos.current);
      hasLastSample.current = true;

      for (let i = 0; i < TRAIL_COUNT; i++) {
        const mesh = trailMeshRefs.current[i];
        const mat = trailMatRefs.current[i];
        if (!mesh || !mat) continue;

        if (i < trailCount.current) {
          const slot = (trailHead.current - i + TRAIL_COUNT) % TRAIL_COUNT;
          const t = TRAIL_COUNT > 1 ? i / (TRAIL_COUNT - 1) : 0;
          const opacity = THREE.MathUtils.lerp(0.42, 0.04, t);
          const dotScale = THREE.MathUtils.lerp(0.74, 0.24, t) * ballScale;

          mesh.visible = true;
          mesh.position.copy(trailPositions.current[slot]);
          mesh.scale.setScalar(dotScale);
          mat.opacity = opacity;
        } else {
          mesh.visible = false;
        }
      }
    } else {
      trailCount.current = 0;
      hasLastSample.current = false;
      for (let i = 0; i < TRAIL_COUNT; i++) {
        const mesh = trailMeshRefs.current[i];
        if (mesh) mesh.visible = false;
      }
    }

    // Fading bounce mark on court
    const bounceCount = ball.bounceCount ?? 0;
    if (ball.active && bounceCount > prevBounceCount.current) {
      bounceStartClock.current = clock.elapsedTime;
      bouncePos.current.set(bx, 0.018, bz);
    }
    prevBounceCount.current = ball.active ? bounceCount : 0;

    if (
      bounceRingRef.current &&
      bounceRingMatRef.current &&
      bounceDiscRef.current &&
      bounceDiscMatRef.current
    ) {
      if (!showReplayArcs && bounceStartClock.current !== null) {
        const age = clock.elapsedTime - bounceStartClock.current;
        if (age >= 0 && age < BOUNCE_MARK_DURATION) {
          const p = age / BOUNCE_MARK_DURATION;
          const ringScale = 0.75 + p * 0.85;
          const fade = 1 - p;

          bounceRingRef.current.visible = true;
          bounceRingRef.current.position.copy(bouncePos.current);
          bounceRingRef.current.scale.set(ringScale, ringScale, 1);
          bounceRingMatRef.current.opacity = fade * 0.72;

          bounceDiscRef.current.visible = true;
          bounceDiscRef.current.position.copy(bouncePos.current);
          bounceDiscRef.current.scale.set(ringScale * 0.85, ringScale * 0.85, 1);
          bounceDiscMatRef.current.opacity = fade * 0.24;
        } else {
          bounceRingRef.current.visible = false;
          bounceDiscRef.current.visible = false;
          bounceStartClock.current = null;
        }
      } else {
        bounceRingRef.current.visible = false;
        bounceDiscRef.current.visible = false;
      }
    }

    // Subtle hit flash on contact (vz reversal during rally or serve launch velocity jump)
    if (ball.active && wasBallActive.current) {
      if (
        (prevVz.current > 1.5 && bvz < -1.5) ||
        (prevVz.current < -1.5 && bvz > 1.5) ||
        (Math.abs(prevVz.current) < 0.5 && Math.abs(bvz) > 6.0)
      ) {
        hitFlashStartClock.current = clock.elapsedTime;
      }
    }
    prevVz.current = bvz;
    wasBallActive.current = Boolean(ball.active);

    if (hitFlashRef.current && hitFlashMatRef.current) {
      if (!showReplayArcs && ball.active && hitFlashStartClock.current !== null) {
        const age = clock.elapsedTime - hitFlashStartClock.current;
        if (age >= 0 && age < HIT_FLASH_DURATION) {
          const p = age / HIT_FLASH_DURATION;
          const flashScale = (1.35 + p * 1.15) * ballScale;
          hitFlashRef.current.visible = true;
          hitFlashRef.current.position.copy(ballWorldPos.current);
          hitFlashRef.current.scale.setScalar(flashScale);
          hitFlashMatRef.current.opacity = (1 - p) * 0.65;
        } else {
          hitFlashRef.current.visible = false;
          hitFlashStartClock.current = null;
        }
      } else {
        hitFlashRef.current.visible = false;
      }
    }
  });

  const arcLines = useMemo(() => {
    if (!showReplayArcs || !Array.isArray(replayArcs)) return [];
    return replayArcs
      .filter((s) => Array.isArray(s?.arc) && s.arc.length >= 2)
      .map((shot) => ({
        id: shot.id,
        actor: shot.actor,
        color:
          shot.actor === 'human'
            ? (SHOT_ARC_COLORS[shot.shotType] ?? '#38bdf8')
            : '#fb7185',
        points: shot.arc.map(
          (p) => [p.x, Math.max(0.05, p.y), p.z] as [number, number, number],
        ),
        bouncePos: shot.bouncePos,
      }));
  }, [showReplayArcs, replayArcs]);

  return (
    <group>
      {/* Live Optic-Yellow Tennis Ball */}
      <mesh ref={ballRef} castShadow>
        <sphereGeometry args={[COURT.VISUAL_BALL_RADIUS, 20, 16]} />
        <meshStandardMaterial
          color="#e4ff33"
          emissive="#a3cc00"
          emissiveIntensity={0.4}
          roughness={0.55}
        />
      </mesh>

      {/* Subtle Contact Hit-Flash Halo */}
      <mesh ref={hitFlashRef} visible={false}>
        <sphereGeometry args={[COURT.VISUAL_BALL_RADIUS, 16, 12]} />
        <meshBasicMaterial
          ref={hitFlashMatRef}
          color="#fef08a"
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>

      {/* Short Fading Live Rally Trail */}
      {Array.from({ length: TRAIL_COUNT }, (_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            trailMeshRefs.current[i] = el;
          }}
          visible={false}
        >
          <sphereGeometry args={[COURT.VISUAL_BALL_RADIUS, 12, 10]} />
          <meshBasicMaterial
            ref={(el) => {
              trailMatRefs.current[i] = el;
            }}
            color="#e4ff33"
            transparent
            opacity={0}
            depthWrite={false}
          />
        </mesh>
      ))}

      {/* Contact Ground Shadow (essential for depth readability!) */}
      <mesh
        ref={shadowRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.015, 0]}
      >
        <circleGeometry args={[0.17, 20]} />
        <meshBasicMaterial
          ref={shadowMatRef}
          color="#020617"
          transparent
          opacity={0.45}
          depthWrite={false}
        />
      </mesh>

      {/* Fading Court Bounce Mark */}
      <mesh
        ref={bounceDiscRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.018, 0]}
        visible={false}
      >
        <circleGeometry args={[0.16, 20]} />
        <meshBasicMaterial
          ref={bounceDiscMatRef}
          color="#e4ff33"
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>
      <mesh
        ref={bounceRingRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.018, 0]}
        visible={false}
      >
        <ringGeometry args={[0.16, 0.24, 24]} />
        <meshBasicMaterial
          ref={bounceRingMatRef}
          color="#fef08a"
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>

      {/* Predicted Landing Ring */}
      <mesh
        ref={markerRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.018, 0]}
        visible={false}
      >
        <ringGeometry args={[0.18, 0.28, 24]} />
        <meshBasicMaterial
          color="#fde047"
          transparent
          opacity={0.75}
          depthWrite={false}
        />
      </mesh>

      {/* 3D Replay Shot Trajectories & Bounce Heatmap Dots (Demo Pause) */}
      {showReplayArcs &&
        arcLines.map((item) => (
          <group key={item.id}>
            <Line
              points={item.points}
              color={item.color}
              lineWidth={item.actor === 'human' ? 3 : 2}
              transparent
              opacity={0.85}
            />
            {item.bouncePos && (
              <mesh
                rotation={[-Math.PI / 2, 0, 0]}
                position={[item.bouncePos.x, 0.025, item.bouncePos.z]}
              >
                <circleGeometry args={[0.26, 20]} />
                <meshBasicMaterial
                  color={item.color}
                  transparent
                  opacity={0.85}
                  depthWrite={false}
                />
              </mesh>
            )}
          </group>
        ))}
    </group>
  );
}
