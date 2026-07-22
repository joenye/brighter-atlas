// GLB (glTF 2.0 binary) conversion: turns decoded payloads into the industry
// interchange format that Blender/Unity/Unreal/Godot import directly:
//   mesh     -> geometry (+ its rig & skin when the mesh is skinned), with the
//               viewer's effective albedo texture baked in
//   skeleton -> the bone hierarchy as glTF nodes (rest pose)
//   anim     -> its skeleton + the clip as a glTF animation (a clip without its
//               rig is meaningless, so the rig always rides along)
//   Model    -> rig + the fixed mesh set + each mesh's pinned texture variant,
//               optionally with any number of the skeleton's clips embedded
// Conventions are already normalized by buildMeshGeometry (CW->CCW winding,
// DirectX->GL v flip); GLTFExporter re-flips images for flipY textures, so the
// output matches the glTF UV convention without further correction.
//
// This module is big-ish (pulls the vendored GLTFExporter), so callers load it
// with a dynamic import (keep it off the boot path).

import * as THREE from '../vendor/three.module.js';
import { GLTFExporter } from '../vendor/GLTFExporter.js';
import { buildMeshGeometry } from './viewers/mesh-geometry.js';
import { Rig } from './viewers/rig.js';
import { b64f32, entryByOrdinal } from './store.js';
import { resolveRoles, texFile, effectiveTex, resolveVariantImage } from './texmap.js';
import { effectiveName } from './names.js';
import { modelParts } from './models.js';
import { applyRecolorPreview, partRecolor } from './recolor.js';
import type { PartRecolorState } from './recolor.js';

export interface TextureCache {
  load(rel: string | null): Promise<THREE.Texture | null>;
  dispose(): void;
}

// mesh payload -> export-clean geometry: the bone-influence vertex colors are a
// viewer-only visualization, not asset data. Never ship them in a GLB. Zero
// the joint index wherever its weight is zero (the stored data leaves stale
// bone ids in unused slots; harmless to skinning but flagged by the Khronos
// glTF validator).
function exportGeometry(payload: any): { geo: THREE.BufferGeometry; skinned: boolean } {
  const { geo, skinned } = buildMeshGeometry(payload);
  geo.deleteAttribute('color');
  const ji = geo.getAttribute('skinIndex');
  const w = geo.getAttribute('skinWeight');
  if (ji && w) for (let k = 0; k < ji.array.length; k++) if (w.array[k] === 0) ji.array[k] = 0;
  return { geo, skinned };
}

// strip skin attributes when a skinned payload is exported WITHOUT its rig
// (glTF forbids JOINTS_0/WEIGHTS_0 on a primitive that has no skin)
function unskin(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute('skinIndex');
  geo.deleteAttribute('skinWeight');
  return geo;
}

// Shared THREE.Texture loader keyed by payload path: meshes sharing an albedo
// reuse one Texture object (and bulk export re-decodes each PNG only once).
export function makeTextureCache(store: any): TextureCache {
  const cache = new Map<string, Promise<THREE.Texture | null>>();
  const loader = new THREE.TextureLoader();
  return {
    load(rel) {
      if (!rel) return Promise.resolve(null);
      if (!cache.has(rel)) {
        cache.set(rel, loader.loadAsync(store.url(rel)).then((t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.name = rel.split('/').pop()!.replace(/\.png$/i, '');
          return t;
        }).catch(() => null)); // untextured fallback: never fail the export over a texture
      }
      return cache.get(rel)!;
    },
    dispose() {
      for (const p of cache.values()) p.then((t) => t?.dispose());
      cache.clear();
    },
  };
}

// same neutral material the viewers use; a texture upgrades it to albedo+cutout
function exportMaterial(tex: THREE.Texture | null, recolor: PartRecolorState | null = null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.02, roughness: 0.88 });
  if (tex) {
    mat.map = tex;
    mat.color.set(0xffffff);
    mat.alphaTest = 0.35;   // -> glTF alphaMode MASK (foliage/cutout, as rendered in-app)
    mat.name = tex.name;
  }
  if (recolor) applyRecolorPreview(mat, recolor);
  return mat;
}

// the albedo payload path the viewer would show for this mesh (override-driven)
function albedoFileFor(entry: any, imagesIdx: any): string | null {
  const st = imagesIdx ? effectiveTex(entry, imagesIdx) : null;
  const img = st?.a != null ? entryByOrdinal(imagesIdx, st.a) : null;
  return img ? texFile(img, resolveRoles(img as any).albedo) : null;
}

// a Model's pinned texture variant -> albedo path. System model ordinals are
// profile-scoped; user model references remain strictly content-addressed.
function pinnedAlbedoFile(row: any, imagesIdx: any): string | null {
  if (!imagesIdx) return null;
  const a = row._system && Number.isInteger(row._imgOrdinal)
    ? row._imgOrdinal
    : row._img ? resolveVariantImage({ image_hash: row._img }, imagesIdx) : null;
  const img = a != null ? entryByOrdinal(imagesIdx, a) : null;
  return img ? texFile(img, resolveRoles(img as any).albedo) : null;
}

function applyModelPartTransform(obj: THREE.Object3D, part: any): void {
  const a = part?.local_matrix;
  if (!Array.isArray(a) || a.length !== 12) return;
  obj.applyMatrix4(new THREE.Matrix4().set(
    a[0], a[1], a[2], a[3],
    a[4], a[5], a[6], a[7],
    a[8], a[9], a[10], a[11],
    0, 0, 0, 1,
  ));
}

function rigRoot(skelJson: any): { rig: any; root: THREE.Group } {
  const rig = new Rig(skelJson);   // bones named bone_<i>, the track-binding names
  const root = new THREE.Group();
  root.name = skelJson.i != null ? `rig_${skelJson.i}` : 'rig';
  root.add(...rig.roots);
  return { rig, root };
}

// ab1 clip payload -> THREE.AnimationClip on a Rig's bones. Tracks are the
// stored uniform samples verbatim (frame_ms cadence); const channels become a
// single keyframe; absent channels stay at the node's rest TRS, which is what
// the game does too (see rig.js ClipSampler).
function clipToAnimationClip(clipJson: any, rig: any, name: string): THREE.AnimationClip {
  const frameS = (clipJson.frame_ms || 20) / 1000;
  const frames = Math.max(1, clipJson.frames || 1);
  const tracks: THREE.KeyframeTrack[] = [];
  const mk = (bn: string, prop: string, ch: any, width: number, Cls: any) => {
    if (!ch || ch.mode === 'absent') return;
    if (ch.mode === 'const') { tracks.push(new Cls(`${bn}.${prop}`, [0], Array.from(ch.value))); return; }
    const data = b64f32(ch.data);
    const n = Math.max(1, Math.min(frames, Math.floor(data.length / width)));
    const times = new Float32Array(n);
    for (let i = 0; i < n; i++) times[i] = i * frameS;
    tracks.push(new Cls(`${bn}.${prop}`, times, data.subarray(0, n * width)));
  };
  (clipJson.bones || []).forEach((b: any, i: number) => {
    if (!b || !b.present || i >= rig.bones.length) return;
    const bn = rig.bones[i].name;
    mk(bn, 'position', b.trans, 3, THREE.VectorKeyframeTrack);
    mk(bn, 'quaternion', b.rot, 4, THREE.QuaternionKeyframeTrack);
    mk(bn, 'scale', b.scale, 3, THREE.VectorKeyframeTrack);
  });
  return new THREE.AnimationClip(name, (clipJson.duration_ms || 0) / 1000, tracks);
}

export async function glbBytes(root: THREE.Object3D, { animations = [] }: { animations?: THREE.AnimationClip[] } = {}): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  return exporter.parseAsync(root, { binary: true, animations, onlyVisible: false }) as Promise<ArrayBuffer>;
}

// ---- per-asset builders -----------------------------------------------------

const meshName = (m: any) => effectiveName(m, 'meshes') || `mesh_${m.i}`;

async function skeletonEntryByIndex(app: any, idx: number): Promise<any> {
  const skels = await app.store.index('rigs');
  return skels.find((s: any) => s.i === idx) || null;
}

async function meshAssetRoot(app: any, entry: any, { texCache }: { texCache?: TextureCache | null } = {}): Promise<{ root: THREE.Group }> {
  const payload = await app.store.payload(entry.f);
  const { geo, skinned } = exportGeometry(payload);
  let imagesIdx = null;
  try { imagesIdx = await app.store.index('images'); } catch { /* untextured */ }
  const tc = texCache || makeTextureCache(app.store);
  const mat = exportMaterial(await tc.load(albedoFileFor(entry, imagesIdx)));
  if (skinned && entry.skel >= 0) {
    try {
      const se = await skeletonEntryByIndex(app, entry.skel);
      if (se?.f) {
        const { rig, root } = rigRoot(await app.store.json(se.f));
        const mesh = new THREE.SkinnedMesh(geo, mat);
        mesh.name = meshName(entry);
        mesh.frustumCulled = false;
        mesh.bind(rig.skeleton, new THREE.Matrix4());   // explicit identity bind (see skeleton.js)
        root.add(mesh);
        return { root };
      }
    } catch { /* rig unavailable -> static fallback */ }
  }
  const mesh = new THREE.Mesh(unskin(geo), mat);
  mesh.name = meshName(entry);
  const root = new THREE.Group();
  root.add(mesh);
  return { root };
}

async function skeletonAssetRoot(app: any, entry: any): Promise<{ root: THREE.Group }> {
  const { root } = rigRoot(await app.store.json(entry.f));
  return { root };
}

async function animAssetRoot(app: any, entry: any): Promise<{ root: THREE.Group; animations: THREE.AnimationClip[] }> {
  const clipJson = await app.store.payload(entry.f);
  const se = await skeletonEntryByIndex(app, entry.skel ?? clipJson.skel);
  if (!se?.f) throw new Error(`rig #${entry.skel} is not available (the clip needs its rig)`);
  const { rig, root } = rigRoot(await app.store.json(se.f));
  const clip = clipToAnimationClip(clipJson, rig, effectiveName(entry, 'anims') || `anim_${entry.i}`);
  return { root, animations: [clip] };
}

// one call for the Export button AND bulk export: category -> GLB ArrayBuffer
export async function assetGLB(app: any, cat: string, entry: any, opts: { texCache?: TextureCache | null } = {}): Promise<ArrayBuffer> {
  const b = cat === 'meshes' ? await meshAssetRoot(app, entry, opts)
    : cat === 'rigs' ? await skeletonAssetRoot(app, entry)
      : cat === 'anims' ? await animAssetRoot(app, entry)
        : null;
  if (!b) throw new Error(`no GLB conversion for category ${cat}`);
  return glbBytes(b.root, { animations: (b as any).animations || [] });
}

// ---- Model builder ----------------------------------------------------------

// model record -> export root. clips: anims-index entries to embed (pass [] for
// geometry-only). onProgress(done, total) covers mesh + clip payload loads.
export async function modelRoot(app: any, model: any, { clips = [], onProgress }: {
  clips?: any[]; onProgress?: (done: number, total: number) => void;
} = {}): Promise<{ root: THREE.Group; animations: THREE.AnimationClip[] }> {
  const meshes = await app.store.index('meshes');
  const byH = new Map(meshes.map((m: any) => [m.h, m]));
  const rows = modelParts(model)
    .map((part: any, partIndex: number) => {
      const system = model.source === 'system';
      const m: any = system && Number.isInteger(part.mesh)
        ? entryByOrdinal(meshes, part.mesh) : byH.get(part.mesh_hash);
      return m?.f ? {
        ...m, _img: part.image_hash, _imgOrdinal: part.image,
        _part: part, _system: system, _partIndex: partIndex,
      } : null;
    })
    .filter(Boolean);
  if (!rows.length) throw new Error('none of this model\'s meshes are loaded');
  let imagesIdx = null;
  try { imagesIdx = await app.store.index('images'); } catch { /* untextured */ }
  const tc = makeTextureCache(app.store);

  const root = new THREE.Group();
  root.name = model.name || 'model';
  let rig = null;
  if (model.skel || Number.isInteger(model.skel_i)) {   // null = static/mixed model (no single rig)
    const skels = await app.store.index('rigs');
    let se = model.skel ? skels.find((s: any) => s.h === model.skel) : null;
    if (!se && Number.isInteger(model.skel_i)) se = skels.find((s: any) => s.i === model.skel_i);
    if (!se?.f) throw new Error(`the rig this model was built on (${model.skel ? model.skel.slice(0, 8) : `#${model.skel_i}`}) is not available`);
    const rr = rigRoot(await app.store.json(se.f));
    rig = rr.rig;
    root.add(rr.root);
  }

  const total = rows.length + clips.length;
  let done = 0;
  const tick = () => onProgress?.(++done, total);
  for (const m of rows) {
    const payload = await app.store.payload(m.f);
    const { geo, skinned } = exportGeometry(payload);
    const mat = exportMaterial(
      await tc.load(pinnedAlbedoFile(m, imagesIdx)), partRecolor(m._part),
    );
    if (rig && skinned) {
      const mesh = new THREE.SkinnedMesh(geo, mat);
      mesh.name = meshName(m);
      mesh.frustumCulled = false;
      mesh.bind(rig.skeleton, new THREE.Matrix4());
      applyModelPartTransform(mesh, m._part);
      root.add(mesh);
    } else {
      const mesh = new THREE.Mesh(unskin(geo), mat);
      mesh.name = meshName(m);
      applyModelPartTransform(mesh, m._part);
      root.add(mesh);
    }
    tick();
  }
  const animations: THREE.AnimationClip[] = [];
  for (const c of clips) {
    if (!c.f || !rig) { tick(); continue; }
    try {
      animations.push(clipToAnimationClip(await app.store.payload(c.f), rig, effectiveName(c, 'anims') || `anim_${c.i}`));
    } catch { /* skip an unloadable clip rather than fail the model */ }
    tick();
  }
  return { root, animations };
}
