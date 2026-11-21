// ─────────────────────────────────────────────────────────────────────────
// Cover.tsx — solid cover on the plaza.
//
//   <MapCover/>     the PERMANENT CS/Valorant-style blocks (teamAI.MAP_COVER):
//                   concrete walls/blocks + wooden crate stacks, chest-high
//                   (1.1 m) and head-high (1.9 m). Geometry is MERGED into one
//                   mesh per material (2 draw calls), with procedural PBR-ish
//                   canvas textures. Each piece is a Rapier fixed cuboid and the
//                   merged meshes are registered with the hitscan BVH so they
//                   block bullets and bot line of sight.
//   <DynamicCover/> the agent-placed cover from getBrain().getSettings().cover
//                   (tree / crate / wall at x,z), re-placed at every round start
//                   by teamAI.planRound(). Visuals + Rapier bodies remount per
//                   piece; hitscan uses a fixed pool of invisible proxy boxes
//                   (moved in/out — hitscan.ts has no unregister).
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CuboidCollider, RigidBody } from "@react-three/rapier";
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  type Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { registerWorld } from "./hitscan";
import {
  DYN_SIZE,
  FLOOR_Y,
  MAP_COVER,
  MAX_DYNAMIC_COVER,
  STACKED_ON,
  floorYAt,
  getDynamicCover,
  subscribeDynamicCover,
  type CoverBox,
  type DynCover,
} from "./teamAI";

// ── Procedural textures (built once, lazily) ─────────────────────────────
function rnd(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}
let concreteMat: MeshStandardMaterial | null = null;
let crateMat: MeshStandardMaterial | null = null;

function concreteMaterial(): MeshStandardMaterial {
  if (concreteMat) return concreteMat;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#9a958c";
  g.fillRect(0, 0, 256, 256);
  const r = rnd(7);
  for (let i = 0; i < 5000; i++) {
    const v = 120 + Math.floor(r() * 60);
    g.fillStyle = `rgba(${v},${v - 4},${v - 10},${0.25 + r() * 0.3})`;
    g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
  }
  for (let i = 0; i < 14; i++) {
    g.fillStyle = `rgba(70,64,58,${0.05 + r() * 0.08})`;
    g.beginPath();
    g.arc(r() * 256, r() * 256, 10 + r() * 40, 0, Math.PI * 2);
    g.fill();
  }
  // Form-work seams + darker tile edge.
  g.strokeStyle = "rgba(60,56,52,0.55)";
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 253, 253);
  g.strokeStyle = "rgba(60,56,52,0.25)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, 128);
  g.lineTo(256, 128);
  g.stroke();
  for (const [x, y] of [[32, 32], [224, 32], [32, 224], [224, 224]]) {
    g.fillStyle = "rgba(50,46,42,0.6)";
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  concreteMat = new MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.02 });
  return concreteMat;
}

function crateMaterial(): MeshStandardMaterial {
  if (crateMat) return crateMat;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const r = rnd(11);
  // Planks
  for (let i = 0; i < 6; i++) {
    const base = 120 + Math.floor(r() * 30);
    g.fillStyle = `rgb(${base + 40},${base},${Math.floor(base * 0.55)})`;
    g.fillRect(0, i * 43, 256, 43);
    for (let k = 0; k < 40; k++) {
      g.strokeStyle = `rgba(80,50,25,${0.1 + r() * 0.2})`;
      g.beginPath();
      const y = i * 43 + r() * 43;
      g.moveTo(0, y);
      g.bezierCurveTo(80, y + r() * 4 - 2, 170, y + r() * 4 - 2, 256, y + r() * 3 - 1.5);
      g.stroke();
    }
    g.fillStyle = "rgba(50,30,15,0.7)";
    g.fillRect(0, i * 43, 256, 2);
  }
  // Frame + diagonal brace
  g.fillStyle = "#6b4523";
  g.fillRect(0, 0, 256, 22);
  g.fillRect(0, 234, 256, 22);
  g.fillRect(0, 0, 22, 256);
  g.fillRect(234, 0, 22, 256);
  g.save();
  g.translate(128, 128);
  g.rotate(-Math.PI / 4);
  g.fillRect(-170, -11, 340, 22);
  g.restore();
  g.strokeStyle = "rgba(30,18,8,0.8)";
  g.lineWidth = 2;
  g.strokeRect(22, 22, 212, 212);
  g.strokeRect(1, 1, 254, 254);
  for (const [x, y] of [[11, 11], [245, 11], [11, 245], [245, 245], [128, 11], [128, 245], [11, 128], [245, 128]]) {
    g.fillStyle = "#3a3a3a";
    g.beginPath();
    g.arc(x, y, 3, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  crateMat = new MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });
  return crateMat;
}

/** Box with world-scaled UVs (1 texture repeat per `tile` m) so long walls
 *  don't stretch the concrete. Face order: px, nx, py, ny, pz, nz. */
function scaledBox(w: number, h: number, d: number, tile: number): BoxGeometry {
  const geo = new BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / tile, (uv.getY(i) * dims[f][1]) / tile);
    }
  }
  return geo;
}

interface Placed extends CoverBox {
  y: number; // centre Y
}

function placeMapCover(): Placed[] {
  const out: Placed[] = [];
  MAP_COVER.forEach((c, i) => {
    const baseIdx = STACKED_ON[i];
    if (baseIdx !== undefined) {
      const b = out[baseIdx];
      out.push({ ...c, y: b.y + b.h / 2 + c.h / 2 });
    } else {
      const fy = floorYAt(c.x, c.z) ?? FLOOR_Y;
      out.push({ ...c, y: fy + c.h / 2 - 0.02 });
    }
  });
  return out;
}

function mergedFor(pieces: Placed[], mat: "concrete" | "crate"): BufferGeometry | null {
  const geos: BufferGeometry[] = [];
  for (const p of pieces) {
    if (p.mat !== mat) continue;
    const g = mat === "concrete" ? scaledBox(p.w, p.h, p.d, 1.25) : new BoxGeometry(p.w, p.h, p.d);
    if (p.yaw) g.rotateY(p.yaw);
    g.translate(p.x, p.y, p.z);
    geos.push(g);
  }
  if (!geos.length) return null;
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  return merged;
}

/** Permanent plaza blocks. */
export function MapCover() {
  const [pieces, setPieces] = useState<Placed[] | null>(null);
  const group = useRef<Group>(null);
  // Floor snapping needs the world BVH (registered by <World/> in its effect).
  useEffect(() => setPieces(placeMapCover()), []);
  const geos = useMemo(() => (pieces ? { concrete: mergedFor(pieces, "concrete"), crate: mergedFor(pieces, "crate") } : null), [pieces]);
  useEffect(() => {
    const g = group.current;
    if (g && geos) {
      registerWorld(g);
      coverRoots.push(g);
    }
    return () => {
      coverRoots = coverRoots.filter((r) => r !== g);
      geos?.concrete?.dispose();
      geos?.crate?.dispose();
    };
  }, [geos]);
  if (!pieces || !geos) return null;
  return (
    <>
      <group ref={group}>
        {geos.concrete && <mesh geometry={geos.concrete} material={concreteMaterial()} castShadow receiveShadow />}
        {geos.crate && <mesh geometry={geos.crate} material={crateMaterial()} castShadow receiveShadow />}
      </group>
      <RigidBody type="fixed" colliders={false}>
        {pieces.map((p, i) => (
          <CuboidCollider key={i} args={[p.w / 2, p.h / 2, p.d / 2]} position={[p.x, p.y, p.z]} rotation={[0, p.yaw ?? 0, 0]} />
        ))}
      </RigidBody>
    </>
  );
}

/** Re-register the cover meshes with hitscan (e.g. after a World remount
 *  cleared the registry). registerWorld de-duplicates. */
let coverRoots: Group[] = [];
export function reregisterCover() {
  for (const r of coverRoots) registerWorld(r);
}

// ── Agent-placed cover ───────────────────────────────────────────────────
const proxyGeo = new BoxGeometry(1, 1, 1);
const proxyMat = new MeshBasicMaterial({ visible: false });

function DynPiece({ c, y }: { c: DynCover; y: number }) {
  const s = DYN_SIZE[c.kind];
  const yaw = c.yaw ?? 0;
  return (
    <group position={[c.x, y, c.z]} rotation={[0, yaw, 0]}>
      {c.kind === "tree" && (
        <>
          <mesh position={[0, 1.2, 0]} castShadow>
            <cylinderGeometry args={[0.22, 0.32, 2.4, 8]} />
            <meshStandardMaterial color="#6b4a2f" roughness={0.95} />
          </mesh>
          <mesh position={[0, 2.6, 0]} castShadow>
            <coneGeometry args={[1.3, 2.2, 9]} />
            <meshStandardMaterial color="#3f6b35" roughness={0.9} flatShading />
          </mesh>
          <mesh position={[0, 3.5, 0]} castShadow>
            <coneGeometry args={[0.95, 1.6, 9]} />
            <meshStandardMaterial color="#4b7c3e" roughness={0.9} flatShading />
          </mesh>
        </>
      )}
      {c.kind === "crate" && (
        <mesh position={[0, s.h / 2, 0]} material={crateMaterial()} castShadow receiveShadow>
          <boxGeometry args={[s.w, s.h, s.d]} />
        </mesh>
      )}
      {c.kind === "wall" && (
        <mesh position={[0, s.h / 2, 0]} material={concreteMaterial()} castShadow receiveShadow>
          <boxGeometry args={[s.w, s.h, s.d]} />
        </mesh>
      )}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[s.w / 2, s.h / 2, s.d / 2]} position={[0, s.h / 2, 0]} />
      </RigidBody>
    </group>
  );
}

export function DynamicCover() {
  const cover = useSyncExternalStore(subscribeDynamicCover, getDynamicCover);
  const pool = useRef<Group>(null);
  const placed = useMemo(() => cover.map((c) => ({ c, y: floorYAt(c.x, c.z) ?? FLOOR_Y })), [cover]);

  // Build the hitscan proxy pool once and register it.
  useEffect(() => {
    const g = pool.current;
    if (!g) return;
    for (let i = 0; i < MAX_DYNAMIC_COVER; i++) {
      const m = new Mesh(proxyGeo, proxyMat);
      m.position.set(0, -500, 0);
      g.add(m);
    }
    registerWorld(g);
    coverRoots.push(g);
    return () => {
      coverRoots = coverRoots.filter((r) => r !== g);
      for (const m of [...g.children]) {
        m.position.set(0, -500, 0);
        m.updateMatrixWorld(true);
        g.remove(m);
      }
    };
  }, []);

  // Move proxies onto the current cover; park the rest far below the map.
  useEffect(() => {
    const g = pool.current;
    if (!g) return;
    g.children.forEach((m, i) => {
      const p = placed[i];
      if (p) {
        const s = DYN_SIZE[p.c.kind];
        m.position.set(p.c.x, p.y + s.h / 2, p.c.z);
        m.rotation.set(0, p.c.yaw ?? 0, 0);
        m.scale.set(s.w, s.h, s.d);
      } else {
        m.position.set(0, -500, 0);
        m.scale.set(1, 1, 1);
      }
      m.updateMatrixWorld(true);
    });
    registerWorld(g);
  }, [placed]);

  return (
    <>
      <group ref={pool} />
      {placed.map(({ c, y }, i) => (
        <DynPiece key={`${i}:${c.kind}:${c.x}:${c.z}:${c.yaw ?? 0}`} c={c} y={y} />
      ))}
    </>
  );
}
