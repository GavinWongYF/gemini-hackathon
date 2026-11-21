import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { SceneAnimState } from './clipContactTimings';
export { CLIP_CONTACT_TABLE } from './clipContactTimings';

/**
 * Canonical avatar clip names matching `SceneAnimState` and `TennisAvatar.tsx`.
 * Drop any `<clipName>.glb` or a combined `tennis_clips.glb` into
 * `client/public/models/animations/` to override built-in Blender animations.
 */
export const EXTERNAL_ANIMATION_CLIP_NAMES: readonly SceneAnimState[] = [
  'idle',
  'run_left',
  'run_right',
  'run_forward',
  'run_back',
  'forehand',
  'backhand',
  'slice',
  'dropshot',
  'serve',
  'volley_forehand',
  'volley_backhand',
  'split_step',
  'celebrate',
] as const;

const ANIMATIONS_BASE_PATH = '/models/animations';
const COMBINED_CLIPS_FILE = 'tennis_clips.glb';
const DRACO_DECODER_PATH = '/models/draco/';
const FINGER_BONE_PATTERN = /(thumb|index|middle|ring|pinky)/i;

/** Common Mixamo / rig aliases mapped to canonical bone names (lowercase stripped keys). */
const BONE_ALIASES: Record<string, readonly string[]> = {
  pelvis: ['hips'],
  hips: ['pelvis'],
  spine2: ['chest', 'spine1', 'spine'],
  upperchest: ['chest', 'spine2', 'spine'],
  spine1: ['chest', 'spine'],
  chest: ['spine2', 'spine1', 'spine'],
  leftupperarm: ['leftarm'],
  rightupperarm: ['rightarm'],
  leftlowerarm: ['leftforearm'],
  rightlowerarm: ['rightforearm'],
  leftupperleg: ['leftupleg'],
  rightupperleg: ['rightupleg'],
  leftthigh: ['leftupleg'],
  rightthigh: ['rightupleg'],
  leftlowerleg: ['leftleg'],
  rightlowerleg: ['rightleg'],
  leftshin: ['leftleg'],
  rightshin: ['rightleg'],
};

/** Clip name aliases for combined `tennis_clips.glb` exports. */
const CLIP_NAME_LOOKUP: Record<string, SceneAnimState> = {
  idle: 'idle',
  ready: 'idle',
  runleft: 'run_left',
  strafeleft: 'run_left',
  runright: 'run_right',
  straferight: 'run_right',
  runforward: 'run_forward',
  runfwd: 'run_forward',
  run: 'run_forward',
  runback: 'run_back',
  runbackward: 'run_back',
  forehand: 'forehand',
  fh: 'forehand',
  backhand: 'backhand',
  bh: 'backhand',
  slice: 'slice',
  dropshot: 'dropshot',
  drop: 'dropshot',
  serve: 'serve',
  volleyforehand: 'volley_forehand',
  forehandvolley: 'volley_forehand',
  volleybackhand: 'volley_backhand',
  backhandvolley: 'volley_backhand',
  splitstep: 'split_step',
  celebrate: 'celebrate',
  victory: 'celebrate',
};

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(DRACO_DECODER_PATH);

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

interface RawExternalClipEntry {
  clip: THREE.AnimationClip;
  sourceRestQuats: Map<string, THREE.Quaternion>;
}

/** Module-level cache so multiple avatars share one silent probe per page session. */
let rawExternalClipsPromise: Promise<Map<string, RawExternalClipEntry>> | null = null;

function stripMixamoPrefix(nodeName: string): string {
  // Strip any scene hierarchy prefix (e.g. "Armature/mixamorig:Hips" -> "mixamorig:Hips")
  const leaf = nodeName.includes('/') ? nodeName.slice(nodeName.lastIndexOf('/') + 1) : nodeName;
  // Remove Mixamo prefixes: "mixamorig:", "mixamorig_", "mixamorig", optionally numbered ("mixamorig1:")
  return leaf.replace(/^mixamorig\d*[:_]?/i, '').trim();
}

function canonicalKey(name: string): string {
  return stripMixamoPrefix(name)
    .replace(/\.\d+$/, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

function splitTrackName(trackName: string): { nodeName: string; propertyPath: string } {
  // Handle Three.js ".bones[BoneName].quaternion" syntax
  const bonesMatch = /^\.?bones\[([^\]]+)\]\.(.+)$/.exec(trackName);
  if (bonesMatch) {
    return { nodeName: bonesMatch[1], propertyPath: bonesMatch[2] };
  }

  const lastDot = trackName.lastIndexOf('.');
  if (lastDot === -1) {
    return { nodeName: trackName, propertyPath: '' };
  }
  return {
    nodeName: trackName.slice(0, lastDot),
    propertyPath: trackName.slice(lastDot + 1),
  };
}

export interface TargetBoneLookup {
  exactNames: Set<string>;
  byCanonicalKey: Map<string, string>;
  restQuats: Map<string, THREE.Quaternion>;
}

function inspectTargetBones(targetRoot: THREE.Object3D): TargetBoneLookup {
  const exactNames = new Set<string>();
  const byCanonicalKey = new Map<string, string>();
  const restQuats = new Map<string, THREE.Quaternion>();

  targetRoot.traverse((obj) => {
    if (!obj.name) return;
    const isBone = (obj as THREE.Bone).isBone === true;
    exactNames.add(obj.name);
    if (!restQuats.has(obj.name) || isBone) {
      restQuats.set(obj.name, obj.quaternion.clone());
    }

    const key = canonicalKey(obj.name);
    if (!key) return;

    // Prefer actual THREE.Bone nodes over similarly named meshes
    if (!byCanonicalKey.has(key) || isBone) {
      byCanonicalKey.set(key, obj.name);
    }
  });

  return { exactNames, byCanonicalKey, restQuats };
}

function extractSourceRestQuats(sourceRoot: THREE.Object3D): Map<string, THREE.Quaternion> {
  const restQuats = new Map<string, THREE.Quaternion>();
  const isBoneByKey = new Set<string>();

  sourceRoot.traverse((obj) => {
    if (!obj.name) return;
    const key = canonicalKey(obj.name);
    if (!key) return;
    const isBone = (obj as THREE.Bone).isBone === true;
    if (!restQuats.has(key) || (isBone && !isBoneByKey.has(key))) {
      restQuats.set(key, obj.quaternion.clone());
      if (isBone) isBoneByKey.add(key);
    }
  });

  return restQuats;
}

/**
 * Normalizes a glTF / Mixamo animation track name (stripping `mixamorig:` / `mixamorig`
 * prefixes and hierarchy paths) and optionally resolves it dynamically against the
 * target avatar's actual bone names.
 */
export function normalizeMixamoTrackName(
  trackName: string,
  targetLookup?: TargetBoneLookup | ReadonlySet<string>,
): string {
  const { nodeName, propertyPath } = splitTrackName(trackName);
  const cleanedNode = stripMixamoPrefix(nodeName);
  const suffix = propertyPath ? `.${propertyPath}` : '';

  if (!targetLookup) {
    return `${cleanedNode}${suffix}`;
  }

  let exactNames: ReadonlySet<string>;
  let byCanonicalKey: ReadonlyMap<string, string>;

  if ('exactNames' in targetLookup) {
    exactNames = targetLookup.exactNames;
    byCanonicalKey = targetLookup.byCanonicalKey;
  } else {
    exactNames = targetLookup;
    const map = new Map<string, string>();
    for (const name of targetLookup) {
      const k = canonicalKey(name);
      if (k && !map.has(k)) map.set(k, name);
    }
    byCanonicalKey = map;
  }

  // 1. Exact match on original or cleaned bone name
  if (exactNames.has(nodeName)) return `${nodeName}${suffix}`;
  if (exactNames.has(cleanedNode)) return `${cleanedNode}${suffix}`;

  // 2. Canonical case-insensitive match (handles Mixamo <-> Blender in both directions)
  const key = canonicalKey(cleanedNode);
  const direct = byCanonicalKey.get(key);
  if (direct) return `${direct}${suffix}`;

  // 3. Semantic rig alias match (e.g. Mixamo Spine2 -> Blender Chest)
  const aliases = BONE_ALIASES[key];
  if (aliases) {
    for (const alias of aliases) {
      const matched = byCanonicalKey.get(alias);
      if (matched) return `${matched}${suffix}`;
    }
  }

  return `${cleanedNode}${suffix}`;
}

function isGlbMagicHeader(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const view = new Uint8Array(buffer, 0, 4);
  // "glTF" ASCII magic bytes: 0x67, 0x6C, 0x54, 0x46
  return view[0] === 0x67 && view[1] === 0x6c && view[2] === 0x54 && view[3] === 0x46;
}

async function probeAndParseGlb(url: string): Promise<GLTF | null> {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    // Vite dev server SPA fallback may return 200 text/html for missing files
    if (contentType.includes('text/html')) return null;

    const buffer = await response.arrayBuffer();
    if (!isGlbMagicHeader(buffer)) return null;

    return await new Promise<GLTF | null>((resolve) => {
      gltfLoader.parse(
        buffer,
        '',
        (gltf) => resolve(gltf),
        () => resolve(null),
      );
    });
  } catch {
    return null;
  }
}

function resolveCanonicalClipName(rawName: string): SceneAnimState | null {
  const key = rawName.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return CLIP_NAME_LOOKUP[key] ?? null;
}

function hasDynamicBodyMotion(clip: THREE.AnimationClip): boolean {
  let activeBodyTracks = 0;
  for (const track of clip.tracks) {
    const { nodeName, propertyPath } = splitTrackName(track.name);
    if (propertyPath !== 'quaternion') continue;
    const key = canonicalKey(nodeName);
    if (key === 'armature' || key === 'fbxroot' || key === 'root') continue;
    if (track.times.length <= 2) continue;

    // Verify the quaternion values actually vary across keyframes
    const vals = track.values;
    if (vals.length >= 8) {
      const q0x = vals[0];
      const q0y = vals[1];
      const q0z = vals[2];
      const q0w = vals[3];
      for (let i = 4; i + 3 < vals.length; i += 4) {
        const dot = Math.abs(
          q0x * vals[i] + q0y * vals[i + 1] + q0z * vals[i + 2] + q0w * vals[i + 3],
        );
        if (dot < 0.9995) {
          activeBodyTracks += 1;
          break;
        }
      }
    }
    if (activeBodyTracks >= 3) return true;
  }
  return false;
}

/**
 * Builds an organic, seamless looping athletic tennis ready-stance `idle` clip
 * from `split_step`'s retargeted frame-0 posture (knees bent, elbows bent, racket
 * in front) with subtle breathing and weight-shift bounce so characters never T-pose.
 */
function buildAthleticIdleFromSplitStep(splitClip: THREE.AnimationClip): THREE.AnimationClip {
  const duration = 2.2;
  const times = [0, 0.55, 1.1, 1.65, 2.2];
  const tracks: THREE.KeyframeTrack[] = [];

  const baseQuat = new THREE.Quaternion();
  const deltaQuat = new THREE.Quaternion();
  const deltaEuler = new THREE.Euler();
  const outQuat = new THREE.Quaternion();

  for (const track of splitClip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue;
    if (track.values.length < 4) continue;

    baseQuat.set(track.values[0], track.values[1], track.values[2], track.values[3]).normalize();
    const { nodeName } = splitTrackName(track.name);
    const key = canonicalKey(nodeName);

    const values: number[] = [];
    for (let i = 0; i < times.length; i += 1) {
      const phase = (i / (times.length - 1)) * Math.PI * 2;
      const breath = Math.sin(phase);
      const bounce = Math.cos(phase * 2) * 0.5 + 0.5;

      let rx = 0;
      let ry = 0;
      let rz = 0;

      if (key === 'spine' || key === 'spine1' || key === 'spine2') {
        rx = 0.025 * breath;
        ry = 0.015 * Math.sin(phase * 0.5);
      } else if (key === 'hips' || key === 'pelvis') {
        rx = 0.018 * bounce;
        ry = 0.02 * Math.sin(phase);
      } else if (key === 'rightarm' || key === 'rightupperarm') {
        rx = 0.03 * breath;
        rz = 0.02 * Math.sin(phase);
      } else if (key === 'leftarm' || key === 'leftupperarm') {
        rx = 0.025 * breath;
        rz = -0.02 * Math.sin(phase);
      } else if (key === 'head') {
        rx = -0.02 * breath;
      }

      if (rx !== 0 || ry !== 0 || rz !== 0) {
        deltaEuler.set(rx, ry, rz);
        deltaQuat.setFromEuler(deltaEuler);
        outQuat.copy(baseQuat).multiply(deltaQuat).normalize();
      } else {
        outQuat.copy(baseQuat);
      }

      values.push(outQuat.x, outQuat.y, outQuat.z, outQuat.w);
    }

    tracks.push(new THREE.QuaternionKeyframeTrack(track.name, times, values));
  }

  return new THREE.AnimationClip('idle', duration, tracks);
}

/**
 * Builds a clean point-won / reaction clip from the ready stance (confident racket/fist lift)
 * when no external `celebrate.glb` exists.
 */
function buildCelebrateFromSplitStep(splitClip: THREE.AnimationClip): THREE.AnimationClip {
  const duration = 1.25;
  const times = [0, 0.35, 0.75, 1.25];
  const tracks: THREE.KeyframeTrack[] = [];

  const baseQuat = new THREE.Quaternion();
  const deltaQuat = new THREE.Quaternion();
  const deltaEuler = new THREE.Euler();
  const outQuat = new THREE.Quaternion();

  for (const track of splitClip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue;
    if (track.values.length < 4) continue;

    baseQuat.set(track.values[0], track.values[1], track.values[2], track.values[3]).normalize();
    const { nodeName } = splitTrackName(track.name);
    const key = canonicalKey(nodeName);

    const values: number[] = [];
    const amp = [0, 1, 0.85, 0];
    for (let i = 0; i < times.length; i += 1) {
      const a = amp[i];
      let rx = 0;
      let ry = 0;
      let rz = 0;

      if (key === 'rightarm' || key === 'rightupperarm') {
        rx = -0.55 * a;
        rz = -0.25 * a;
      } else if (key === 'rightforearm' || key === 'rightlowerarm') {
        rx = -0.35 * a;
      } else if (key === 'spine' || key === 'spine1' || key === 'spine2') {
        rx = -0.06 * a;
        ry = 0.08 * a;
      } else if (key === 'head') {
        rx = -0.08 * a;
      }

      if (a !== 0 && (rx !== 0 || ry !== 0 || rz !== 0)) {
        deltaEuler.set(rx, ry, rz);
        deltaQuat.setFromEuler(deltaEuler);
        outQuat.copy(baseQuat).multiply(deltaQuat).normalize();
      } else {
        outQuat.copy(baseQuat);
      }
      values.push(outQuat.x, outQuat.y, outQuat.z, outQuat.w);
    }

    tracks.push(new THREE.QuaternionKeyframeTrack(track.name, times, values));
  }

  return new THREE.AnimationClip('celebrate', duration, tracks);
}

async function fetchRawExternalClips(basePath: string): Promise<Map<string, RawExternalClipEntry>> {
  const clipMap = new Map<string, RawExternalClipEntry>();

  // 1. Probe optional combined clip library `/models/animations/tennis_clips.glb`
  const combinedGltf = await probeAndParseGlb(`${basePath}/${COMBINED_CLIPS_FILE}`);
  if (combinedGltf?.animations?.length) {
    const sourceRestQuats = extractSourceRestQuats(combinedGltf.scene);
    for (const clip of combinedGltf.animations) {
      const canonical = resolveCanonicalClipName(clip.name);
      if (canonical && hasDynamicBodyMotion(clip)) {
        const cloned = clip.clone();
        cloned.name = canonical;
        clipMap.set(canonical, { clip: cloned, sourceRestQuats });
      }
    }
  }

  // 2. Probe individual drop-in `/models/animations/<clipName>.glb` files in parallel
  // Individual files take precedence over the combined pack for easy single-clip iteration.
  const results = await Promise.all(
    EXTERNAL_ANIMATION_CLIP_NAMES.map(async (clipName) => {
      const gltf = await probeAndParseGlb(`${basePath}/${clipName}.glb`);
      if (!gltf?.animations?.length) return null;

      // Filter out static T-pose tracks (e.g. idle.glb clip 10 has 300 Armature frames
      // while every body bone holds only 2 static T-pose keyframes).
      const dynamicClips = gltf.animations.filter(hasDynamicBodyMotion);
      if (dynamicClips.length === 0) return null;

      // For idle.glb, clips 0..5 are actually run_left/run_right/run_forward exports,
      // so skip idle.glb unless an explicitly named idle clip with real motion exists.
      if (clipName === 'idle') {
        const explicitIdle = dynamicClips.find(
          (c) => resolveCanonicalClipName(c.name) === 'idle',
        );
        if (!explicitIdle) return null;
        const cloned = explicitIdle.clone();
        cloned.name = 'idle';
        return {
          clipName,
          entry: {
            clip: cloned,
            sourceRestQuats: extractSourceRestQuats(gltf.scene),
          },
        };
      }

      const matchedByName = dynamicClips.find(
        (c) => resolveCanonicalClipName(c.name) === clipName,
      );
      const longestClip = dynamicClips.reduce((best, curr) =>
        curr.duration > best.duration ? curr : best,
      );
      const preferred = matchedByName ?? longestClip;
      const cloned = preferred.clone();
      cloned.name = clipName;
      return {
        clipName,
        entry: {
          clip: cloned,
          sourceRestQuats: extractSourceRestQuats(gltf.scene),
        },
      };
    }),
  );

  for (const item of results) {
    if (item) {
      clipMap.set(item.clipName, item.entry);
    }
  }

  return clipMap;
}

function retargetClipToTarget(
  entry: RawExternalClipEntry,
  targetLookup: TargetBoneLookup,
): THREE.AnimationClip | null {
  const { clip: sourceClip, sourceRestQuats } = entry;
  const remappedTracks: THREE.KeyframeTrack[] = [];
  const tmpQuat = new THREE.Quaternion();
  const correction = new THREE.Quaternion();

  for (const track of sourceClip.tracks) {
    const { nodeName: sourceNodeName } = splitTrackName(track.name);
    const normalizedName = normalizeMixamoTrackName(track.name, targetLookup);
    const { nodeName, propertyPath } = splitTrackName(normalizedName);

    // Keep only rotation (quaternion) tracks so differences in rig hip height
    // never make the avatar float or sink; the game moves the avatar root instead.
    if (propertyPath !== 'quaternion') {
      continue;
    }

    // Drop finger bone tracks so the hand keeps its natural racket grip pose.
    if (FINGER_BONE_PATTERN.test(nodeName) || FINGER_BONE_PATTERN.test(sourceNodeName)) {
      continue;
    }

    // Drop tracks targeting bones that do not exist on this skeleton to keep mixer clean
    if (!targetLookup.exactNames.has(nodeName)) {
      continue;
    }

    const clonedTrack = track.clone();
    clonedTrack.name = normalizedName;

    // Retarget rest-pose orientation delta: targetRest * inv(sourceRest) * animQ
    // This aligns source Mixamo clips (e.g. Hips rest at -90 deg X under +90 deg Armature)
    // cleanly onto upright target rigs without twisting wrists or pitching the character.
    const targetRest = targetLookup.restQuats.get(nodeName);
    const sourceRest = sourceRestQuats.get(canonicalKey(sourceNodeName));
    if (targetRest && sourceRest) {
      correction.copy(sourceRest).invert().premultiply(targetRest);
      if (Math.abs(correction.w) < 0.999999) {
        const vals = clonedTrack.values;
        for (let i = 0; i + 3 < vals.length; i += 4) {
          tmpQuat.set(vals[i], vals[i + 1], vals[i + 2], vals[i + 3]);
          tmpQuat.premultiply(correction).normalize();
          vals[i] = tmpQuat.x;
          vals[i + 1] = tmpQuat.y;
          vals[i + 2] = tmpQuat.z;
          vals[i + 3] = tmpQuat.w;
        }
      }
    }

    remappedTracks.push(clonedTrack);
  }

  if (remappedTracks.length === 0) {
    return null;
  }

  return new THREE.AnimationClip(sourceClip.name, sourceClip.duration, remappedTracks);
}

/**
 * Probes `/models/animations/` for any drop-in external `.glb` animation clips,
 * dynamically remaps Mixamo / rig track names to match `targetRoot`'s skeleton,
 * and returns the ready-to-play `THREE.AnimationClip[]`.
 *
 * Fails silently when no external clips are present so built-in Blender clips
 * continue working uninterrupted.
 */
export async function loadExternalAvatarClips(
  targetRoot: THREE.Object3D,
  basePath = ANIMATIONS_BASE_PATH,
): Promise<THREE.AnimationClip[]> {
  if (typeof window === 'undefined') return [];

  // Snapshot target skeleton rest quaternions synchronously before async fetch resolves
  const targetLookup = inspectTargetBones(targetRoot);

  if (!rawExternalClipsPromise || basePath !== ANIMATIONS_BASE_PATH) {
    const promise = fetchRawExternalClips(basePath);
    if (basePath === ANIMATIONS_BASE_PATH) {
      rawExternalClipsPromise = promise;
    }
    const rawClips = await promise;
    return mapClipsToRoot(rawClips, targetLookup);
  }

  const rawClips = await rawExternalClipsPromise;
  return mapClipsToRoot(rawClips, targetLookup);
}

function mapClipsToRoot(
  rawClips: Map<string, RawExternalClipEntry>,
  targetLookup: TargetBoneLookup,
): THREE.AnimationClip[] {
  if (rawClips.size === 0) return [];
  const adapted: THREE.AnimationClip[] = [];
  const byName = new Map<string, THREE.AnimationClip>();

  for (const entry of rawClips.values()) {
    const retargeted = retargetClipToTarget(entry, targetLookup);
    if (retargeted) {
      adapted.push(retargeted);
      byName.set(retargeted.name, retargeted);
    }
  }

  const readyBasis = byName.get('split_step') ?? byName.get('forehand');
  if (readyBasis) {
    if (!byName.has('idle')) {
      adapted.push(buildAthleticIdleFromSplitStep(readyBasis));
    }
    if (!byName.has('celebrate')) {
      adapted.push(buildCelebrateFromSplitStep(readyBasis));
    }
  }

  return adapted;
}

/** Clears the cached probe so newly dropped files can be reloaded in dev without refresh. */
export function clearExternalAvatarClipCache(): void {
  rawExternalClipsPromise = null;
}
