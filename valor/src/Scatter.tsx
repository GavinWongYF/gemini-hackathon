import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import { InstancedMesh, Object3D, Raycaster, Vector3 } from "three";

const ROCK_CANDIDATES = 40;
const MAX_ROCKS = ROCK_CANDIDATES;

// Deterministic PRNG so the scatter is stable across reloads.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Cand = { x: number; z: number; scale: number; rot: number };
type Item = { pos: [number, number, number]; scale: number; rot: number };

// Candidate prop positions in a ring around the town center (inner radius keeps the
// plaza clear). y is resolved later by raycasting onto the ground.
function ring(count: number, inner: number, outer: number, seed: number): Cand[] {
  const rnd = mulberry32(seed);
  const out: Cand[] = [];
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = inner + rnd() * (outer - inner);
    out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, scale: 0.7 + rnd() * 0.9, rot: rnd() * Math.PI * 2 });
  }
  return out;
}

// Low-poly trees + boulders, no external assets. Each prop is dropped straight DOWN
// onto the real map geometry (raycast) so nothing floats in the air or sinks under
// the ground; candidates that miss the map entirely are skipped.
export function Scatter() {
  const scene = useThree((s) => s.scene);
  const [rocks, setRocks] = useState<Item[]>([]);

  useEffect(() => {
    const ray = new Raycaster();
    const down = new Vector3(0, -1, 0);
    const from = new Vector3();
    const snap = (cands: Cand[]): Item[] => {
      const out: Item[] = [];
      for (const c of cands) {
        from.set(c.x, 80, c.z);
        ray.set(from, down);
        const hits = ray.intersectObject(scene, true);
        // Ignore the giant <Sky>/<Environment> dome (huge |y|); keep only real
        // ground/props within a sane height band, then take the LOWEST = ground.
        const ground = hits.filter((h) => Math.abs(h.point.y) < 40);
        if (!ground.length) continue; // off the edge of the map → don't place
        const groundY = ground[ground.length - 1].point.y;
        out.push({ pos: [c.x, groundY, c.z], scale: c.scale, rot: c.rot });
      }
      return out;
    };
    // small delay so the arena GLB is in the scene graph before we raycast it
    const id = requestAnimationFrame(() => {
      setRocks(snap(ring(ROCK_CANDIDATES, 14, 75, 4242)));
    });
    return () => cancelAnimationFrame(id);
  }, [scene]);

  // ONE instanced draw (main + shadow pass) instead of a mesh per rock.
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const o = new Object3D();
    rocks.forEach((r, i) => {
      o.position.set(r.pos[0], r.pos[1] + 0.15, r.pos[2]);
      o.rotation.set(r.rot, r.rot, 0);
      o.scale.setScalar(r.scale);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.count = rocks.length;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [rocks]);

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, MAX_ROCKS]} count={0} castShadow receiveShadow>
      <dodecahedronGeometry args={[0.5, 0]} />
      <meshStandardMaterial color="#7a756c" roughness={1} flatShading />
    </instancedMesh>
  );
}
