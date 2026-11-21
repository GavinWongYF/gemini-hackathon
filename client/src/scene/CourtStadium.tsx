import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

const DRACO_DECODER_PATH = '/models/draco/';
useGLTF.setDecoderPath(DRACO_DECODER_PATH);

/**
 * Loads Akhil's Blender-generated pro tennis stadium & court (`court_stadium.glb`).
 * Configured with broadcast shadows and clean PBR roughness.
 */
export function CourtStadium() {
  const { scene } = useGLTF('/models/court_stadium.glb', DRACO_DECODER_PATH);

  const cloned = useMemo(() => {
    const copy = scene.clone(true);
    copy.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const n = mesh.name.toLowerCase();
        if (n.includes('apron') || n.includes('innercourt') || n.includes('line_') || n.includes('mark_')) {
          mesh.receiveShadow = true;
          mesh.castShadow = false;
        } else {
          mesh.castShadow = !n.includes('netbody');
          mesh.receiveShadow = true;
        }
      }
    });
    return copy;
  }, [scene]);

  return (
    <group name="CourtStadium">
      <primitive object={cloned} />
    </group>
  );
}

useGLTF.preload('/models/court_stadium.glb', DRACO_DECODER_PATH);
