// Wave C — in-world skinned playback for the World inspector.
//
// When the inspector pins a spawn/NPC placement whose part(s) resolve to a
// skinned rig, world.js offers a clip picker (the Models viewer's PlaybackBar)
// that plays the selected animation on the entity AT its world position, in
// place of the static instanced/baked representation. This module owns the two
// pieces that don't belong in world.js:
//
//   resolveSpawnAnim() — spawn parts -> skinned mesh(es) -> shared skeleton ->
//     valid clips, gracefully reporting when Animations/Skeletons weren't
//     extracted for this version (world extraction pulls meshes/images/
//     skeletons but NOT anims, so "no anims" is the common case).
//
//   SpawnAnimComposite — a Rig-driven group of SkinnedMesh (+ any static parts)
//     built from the SHARED WorldScene geometry/material caches (never cloned,
//     so nothing new to dispose beyond the rig's own skeleton bone texture),
//     placed at the spawn's world transform and posed from the caller's tick.
//
// The Rig / ClipSampler / PlaybackBar are reused wholesale from rig.js.

import * as THREE from '../../../vendor/three.module.js';
import { entryByOrdinal } from '../../store.js';
import type { AppStore, IndexEntry } from '../../store.js';
import type { WorldScene } from './scene.js';

const ANIMS_HINT = 'Extract the Animations category to play clips — version chip → extract more';
const SKELETONS_HINT = 'Extract the Rigs category to play clips — version chip → extract more';

export type SpawnAnimResolution =
  | { kind: 'norig' }
  | { kind: 'hint'; message: string }
  | { kind: 'noclips' }
  | {
    kind: 'ready';
    skelEntry: IndexEntry;
    skelOrdinal: number;
    clips: IndexEntry[];
    skinnedSet: Set<number>;
  };

/** Tolerant recolor-tuple lookup (mirrors scene.js placementRecolors, but never
 *  throws — a bad tuple just means "no recolor" for the transient composite). */
export function resolveShardRecolors(shard: any, recolorIndex: any): number[][] | null {
  const value = Number(recolorIndex);
  if (!Number.isInteger(value) || value < 0) return null;
  const colors = shard?.recolors?.[value];
  if (!Array.isArray(colors) || ![2, 3].includes(colors.length)) return null;
  if (colors.some((color) => !Array.isArray(color) || color.length < 3
      || color.some((component: any) => !Number.isFinite(Number(component))))) return null;
  return colors.map((color) => color.map(Number));
}

/**
 * Resolve a pinned spawn's animation availability. `store` is the app store
 * (index()/manifest); `parts` the spawn's exact parts (each carrying a `mesh`
 * AB5 ordinal — from describeShardPlacement). Returns one of:
 *   {kind:'norig'}                          not a skinned entity — show nothing
 *   {kind:'hint', message}                  Animations/Skeletons not extracted
 *   {kind:'noclips'}                        rig has no clips for this version
 *   {kind:'ready', skelEntry, skelOrdinal, clips, skinnedSet}
 */
export async function resolveSpawnAnim({ store, parts }: {
  store: AppStore;
  parts: any[] | null | undefined;
}): Promise<SpawnAnimResolution> {
  if (!Array.isArray(parts) || !parts.length) return { kind: 'norig' };

  let meshesIdx;
  try { meshesIdx = await store.index('meshes'); } catch { return { kind: 'norig' }; }
  if (!Array.isArray(meshesIdx)) return { kind: 'norig' };

  // The skinned part(s) of a spawn share ONE skeleton.
  const skinnedSet = new Set<number>();
  let skelOrdinal = -1;
  for (const part of parts) {
    const mesh = entryByOrdinal(meshesIdx, Number(part.mesh));
    if (mesh && mesh.sk && Number.isInteger(mesh.skel) && mesh.skel >= 0) {
      skinnedSet.add(Number(part.mesh));
      if (skelOrdinal < 0) skelOrdinal = Number(mesh.skel);
    }
  }
  if (skelOrdinal < 0 || !skinnedSet.size) return { kind: 'norig' };

  // Skeletons: normally extracted alongside the World, but guard anyway.
  let skels = null;
  if (store.manifest?.categories?.rigs?.exported !== false) {
    try { skels = await store.index('rigs'); } catch { skels = null; }
  }
  const skelEntry = Array.isArray(skels) ? skels.find((s) => s.i === skelOrdinal) : null;
  if (!skelEntry || !skelEntry.f) return { kind: 'hint', message: SKELETONS_HINT };

  // Animations: the common no-op — World extraction does not pull anims.
  if (store.manifest?.categories?.anims?.exported === false) {
    return { kind: 'hint', message: ANIMS_HINT };
  }
  let anims = null;
  try { anims = await store.index('anims'); } catch { anims = null; }
  if (!Array.isArray(anims)) return { kind: 'hint', message: ANIMS_HINT };
  const clips = anims.filter((clip) => clip.skel === skelOrdinal);
  if (!clips.length) return { kind: 'noclips' };

  return { kind: 'ready', skelEntry, skelOrdinal, clips, skinnedSet };
}

/**
 * A Rig-posed composite for one spawn: the skinned part(s) bound to `rig`, plus
 * any static parts, all under a single manually-transformed group. Geometry and
 * materials come from the SHARED WorldScene caches (`world._meshGeometry` /
 * `world._material`) — identical resolution to the static spawn — so this owns
 * NO cache-backed GL objects; dispose() only frees the group's own membership
 * and the rig's skeleton bone texture.
 */
export class SpawnAnimComposite {
  world: WorldScene;
  rig: any;
  group: THREE.Group;
  _meshes: THREE.Mesh[];
  _disposed: boolean;

  constructor({ world, rig }: { world: WorldScene; rig: any }) {
    this.world = world;
    this.rig = rig;
    this.group = new THREE.Group();
    this.group.name = 'spawn-anim-composite';
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.group.add(...rig.roots);
    this._meshes = [];
    this._disposed = false;
  }

  setBaseMatrix(matrix: THREE.Matrix4): void {
    this.group.matrix.copy(matrix);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /** Build every part (skinned -> SkinnedMesh bound to the rig; else static). */
  async loadParts({ parts, shard, skinnedSet, category = 'spawns', isDestroyed = null }: {
    parts: any[] | null | undefined;
    shard: any;
    skinnedSet: Set<number> | null | undefined;
    category?: string;
    isDestroyed?: (() => boolean) | null;
  }): Promise<void> {
    for (const part of parts || []) {
      if (this._disposed || isDestroyed?.()) return;
      let geometry;
      try { geometry = await this.world._meshGeometry(Number(part.mesh), false); } catch { continue; }
      if (this._disposed || isDestroyed?.()) return;
      let material: THREE.Material | null = null;
      try {
        material = await this.world._material(
          category, part.material, Number(part.renderTexture), Number(part.flags) | 0,
          resolveShardRecolors(shard, part.recolorIndex),
        );
      } catch { material = null; }
      if (this._disposed || isDestroyed?.() || !material) continue;
      const skinned = !!skinnedSet?.has(Number(part.mesh)) && !!geometry.attributes.skinIndex;
      const mesh = skinned ? new THREE.SkinnedMesh(geometry, material) : new THREE.Mesh(geometry, material);
      if (skinned) {
        // Explicit identity bind matrix — the bones live under this group; a
        // parameterless bind() would recompute boneInverses from the current
        // (posed) bone world matrices and clobber the Rig's stored inverses.
        (mesh as THREE.SkinnedMesh).bind(this.rig.skeleton, new THREE.Matrix4());
        mesh.frustumCulled = false;
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this._meshes.push(mesh);
    }
  }

  get meshCount(): number {
    return this._meshes.length;
  }

  dispose(): void {
    this._disposed = true;
    for (const mesh of this._meshes) mesh.removeFromParent();
    this._meshes = [];
    for (const root of this.rig.roots) root.removeFromParent();
    // Frees the skeleton bone data texture (the only GL object this created).
    try { this.rig.skeleton.dispose(); } catch { /* never uploaded */ }
    this.group.removeFromParent();
  }
}

export default SpawnAnimComposite;
