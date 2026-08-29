// Model viewer: renders a saved Model, a fixed subset of a skeleton's meshes,
// each with its pinned texture variant (by image content hash), on the rig,
// with the SAME shading toolbar + animation transport + screenshot/video as the
// skeleton composite, but NO mesh picker (the selection is fixed). Rename +
// delete live in the details panel (main.js setModelDetails).
//
// This deliberately mirrors createSkeletonView's composite core (materials,
// shading toolbar, capture); the differences are the fixed mesh set and that
// each mesh's texture resolves from the model's pinned image hash, not the
// global override.

import { renderTransparentFrame, SHOT_RES, captureTiledPng } from './capture-common.js';
import { Scene3D, THREE, getRenderer, makeGridToggle, makeLightToggle, mountImmersiveControls, savedLights } from './three-common.js';
import { Rig, SkeletonViz, PlaybackBar } from './rig.js';
import { buildMeshGeometry } from './mesh-geometry.js';
import { resolveRoles, texFile, resolveVariantImage } from '../texmap.js';
import { el, clear, badge, fmtInt, notExported } from '../ui.js';
import { download } from '../asset-export.js';
import { getPref, setPref } from '../prefs.js';
import { openVideoWizard } from './video-wizard.js';
import { mountComposite } from './composite.js';
import {
  modelParts,
  modelVariantIndex,
  modelVariantLabels,
  modelVariants,
  setModelVariant,
} from '../models.js';
import type { ModelPart, ModelRecord } from '../models.js';
import { entryByOrdinal } from '../store.js';
import type { IndexEntry } from '../store.js';
import { applyPackedRecolor, partRecolor } from '../recolor.js';
import { meshDye, dyeRecolorInput } from '../dyes.js';
import { EffectsPlayer } from './world/effects-player.js';
import type { EffectSystem, WorldEffectsDoc } from '../extract/world/effects.js';

function applyPartTransform(obj: any, part: ModelPart | undefined): void {
  const a = part?.local_matrix;
  if (!Array.isArray(a) || a.length !== 12) return;
  obj.applyMatrix4(new THREE.Matrix4().set(
    a[0], a[1], a[2], a[3],
    a[4], a[5], a[6], a[7],
    a[8], a[9], a[10], a[11],
    0, 0, 0, 1,
  ));
}

function partImageOrdinal(row: any, imagesIdx: IndexEntry[] | null): number | null {
  if (row._system && Number.isInteger(row._imgOrdinal)) {
    return row._imgOrdinal >= 0 ? row._imgOrdinal : null;
  }
  return (imagesIdx && row._img) ? resolveVariantImage({ image_hash: row._img }, imagesIdx) : null;
}

async function mapConcurrent<T, R>(list: T[], limit: number, fn: (item: T) => Promise<R | null | undefined>): Promise<R[]> {
  let next = 0;
  const out = new Array<R | null | undefined>(list.length);
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next++;
      out[index] = await fn(list[index]);
    }
  }));
  return out.filter((value): value is R => value != null);
}

async function applyPartAppearance(mat: any, row: any, imagesIdx: IndexEntry[] | null, app: any, texLoader: any): Promise<any> {
  const ordinal = partImageOrdinal(row, imagesIdx);
  const img = ordinal == null ? null : entryByOrdinal(imagesIdx, ordinal);
  const roles: any = img ? resolveRoles(img as any) : {};
  const load = async (file: string | null, colorSpace: any) => {
    if (!file) return null;
    try {
      const map = await texLoader.loadAsync(app.store.url(file));
      map.colorSpace = colorSpace;
      map.anisotropy = 8;
      return map;
    } catch { return null; }
  };
  // A dye the user put on this mesh outranks the recovered tints, exactly as
  // in the mesh view: the row spreads the mesh index entry, so it carries the
  // content hash the dye is keyed by.
  const dye = dyeRecolorInput(meshDye(row));
  const recolor = dye || partRecolor(row._part);
  const [map, packed] = await Promise.all([
    load(texFile(img, roles.albedo), THREE.SRGBColorSpace),
    recolor ? load(texFile(img, roles.parameter), THREE.NoColorSpace) : null,
  ]);
  if (map) { mat.map = map; mat.color.set(0xffffff); }
  if (packed && !map) packed.dispose();
  // fullTint = the extraction-baked uniform-luminance verdict (grayscale
  // albedo × equal tints, the room renderer's exact rule); without it those
  // surfaces render as their raw white/gray albedo.
  if (recolor) {
    applyPackedRecolor(mat, map ? packed : null, recolor, {
      fullTint: !dye && row._part?.uniform_luminance_tint === true,
    });
  }
  return mat;
}

// ⭳ Export: the whole Model as one GLB (glTF binary): rig + meshes + pinned
// textures, optionally with every clip of its skeleton embedded (clips can be
// numerous/large, so they're opt-in via the picker). Rebuilds a clean scene
// from the payloads. It never serializes the live viewer scene (wireframes,
// joint spheres, ground plane and the current pose don't belong in the file).
function exportGroup(app: any, model: ModelRecord, clips: IndexEntry[]): HTMLElement[] {
  const withAnims = clips.filter((c) => c.f);
  const sel = withAnims.length ? el('select', {
    class: 'btn asset-export-fmt',
    title: 'What the GLB contains: the model alone, or the model plus every animation clip of its rig',
  }) : null;
  if (sel) {
    sel.append(
      el('option', { value: 'model', text: '.glb' }),
      el('option', { value: 'anims', text: `.glb + ${fmtInt(withAnims.length)} clip${withAnims.length === 1 ? '' : 's'}` }),
    );
  }
  const btn = el('button', {
    class: 'btn asset-export-btn',
    text: '⭳ Export',
    title: 'Download this model as GLB (glTF binary: opens in Blender, Unity, Unreal, Godot)',
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (sel) sel.disabled = true;
    btn.textContent = 'exporting…';
    try {
      const { modelRoot, glbBytes } = await import('../gltf-export.js');
      const { root, animations } = await modelRoot(app, model, {
        clips: sel?.value === 'anims' ? withAnims : [],
        onProgress: (done, total) => { btn.textContent = `exporting… ${done}/${total}`; },
      });
      const bytes = await glbBytes(root, { animations });
      const name = `model_${(model.name || 'model').replace(/[^\w.-]+/g, '_')}_${model.id.slice(0, 8)}.glb`;
      download(new Blob([bytes], { type: 'model/gltf-binary' }), name);
      app.banner(`exported ${name}`, 'b-info');
      btn.textContent = 'exported ✓';
    } catch (err) {
      app.banner(`export failed: ${err.message}`);
      btn.textContent = '⭳ Export';
    }
    btn.disabled = false;
    if (sel) sel.disabled = false;
    setTimeout(() => { btn.textContent = '⭳ Export'; }, 1500);
  });
  return sel ? [btn, sel] : [btn];
}


// ---- variant strip: offscreen 3D thumbnails + keyboard focus ----------------
// Thumbnails render one at a time through a queue (shared renderer, offscreen
// target, never touches the live view) and cache per model+variant for the
// session. The camera pose is computed once per model (from the first variant
// rendered) so every variant's thumbnail shares the exact same framing.
// Finished thumbnails cache for the SESSION only (in-memory data URLs, lost
// on reload by design). Pending renders go through a priority queue: when the
// user moves to a new model, that model's jobs jump the queue and every
// still-pending job from other models is dropped (their cells are gone; the
// thumbs re-enqueue in the cheap cached path if the model is revisited).
const _thumbCache = new Map<string, string>();
const _thumbFrame = new Map<string, { pos: number[]; target: number[]; near: number; far: number }>();
const _stripFocus = new Map<string, boolean>();   // model.id -> strip has keyboard focus

interface ThumbJob { key: string; modelId: string; app: any; model: any; v: number; resolve: (url: string | null) => void }
const _thumbQueue: ThumbJob[] = [];
const _thumbPending = new Map<string, Promise<string | null>>();
let _thumbActiveModel: string | null = null;
let _thumbRunning = false;

// The freshly-opened model owns the queue: its jobs run first, and pending
// jobs for other models are abandoned (resolved null, evicted so a revisit
// re-enqueues them).
function prioritizeThumbs(modelId: string): void {
  _thumbActiveModel = modelId;
  for (let i = _thumbQueue.length - 1; i >= 0; i--) {
    const job = _thumbQueue[i];
    if (job.modelId !== modelId) {
      _thumbQueue.splice(i, 1);
      _thumbPending.delete(job.key);
      job.resolve(null);
    }
  }
}

async function _runThumbQueue(): Promise<void> {
  if (_thumbRunning) return;
  _thumbRunning = true;
  try {
    for (;;) {
      const at = _thumbQueue.findIndex((j) => j.modelId === _thumbActiveModel);
      const job = _thumbQueue.splice(at >= 0 ? at : 0, 1)[0];
      if (!job) break;
      let url: string | null = null;
      try { url = await renderVariantThumb(job.app, job.model, job.v); } catch { /* thumb failure is cosmetic */ }
      _thumbPending.delete(job.key);
      if (url) _thumbCache.set(job.key, url);
      job.resolve(url);
    }
  } finally {
    _thumbRunning = false;
    if (_thumbQueue.length) _runThumbQueue();   // jobs enqueued while finishing
  }
}

function variantThumb(app: any, model: any, v: number): Promise<string | null> {
  const key = `${model.id}:${v}`;
  const done = _thumbCache.get(key);
  if (done) return Promise.resolve(done);
  const pending = _thumbPending.get(key);
  if (pending) return pending;
  const p = new Promise<string | null>((resolve) => {
    _thumbQueue.push({ key, modelId: model.id, app, model, v, resolve });
  });
  _thumbPending.set(key, p);
  _runThumbQueue();
  return p;
}

async function renderVariantThumb(app: any, model: any, v: number): Promise<string | null> {
  const parts = (modelVariants(model)[v]?.parts) || modelParts(model);
  if (!parts?.length) return null;
  const [meshesIdx, imagesIdx] = await Promise.all([app.store.index('meshes'), app.store.index('images')]);
  const byH = new Map(meshesIdx.map((e: any) => [e.h, e]));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 500000);
  camera.up.set(0, 0, 1);
  const lights = savedLights();
  const hemi = new THREE.HemisphereLight(0xcdd9ee, 0x33291f, lights.ambient); hemi.position.set(0, 0, 1);
  const key = new THREE.DirectionalLight(0xffffff, lights.sun); key.position.set(1, -1.2, 1.6);
  const fill = new THREE.DirectionalLight(0x8fb0dd, lights.fill); fill.position.set(-1.2, 0.8, 0.5);
  scene.add(hemi, key, fill);
  const group = new THREE.Group();
  scene.add(group);
  const texLoader = new THREE.TextureLoader();
  const own: any[] = [];   // geometries + materials we created (dispose after)
  try {
    for (const part of parts) {
      const entry: any = part.mesh_hash ? byH.get(part.mesh_hash) : null;
      if (!entry?.f) continue;
      const payload = await app.store.payload(entry.f);
      const { geo } = buildMeshGeometry(payload);
      const mat = new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.03, roughness: 0.85, alphaTest: 0.35, side: THREE.DoubleSide });
      const a = part.image_hash ? resolveVariantImage({ image_hash: part.image_hash }, imagesIdx) : null;
      if (a != null) {
        const img: any = entryByOrdinal(imagesIdx, a);
        const roles: any = img ? resolveRoles(img) : {};
        const albFile = texFile(img, roles.albedo);
        const recolor = partRecolor(part);
        if (albFile) {
          try {
            const map = await texLoader.loadAsync(app.store.url(albFile));
            map.colorSpace = THREE.SRGBColorSpace;
            mat.map = map;
            mat.color.set(0xffffff);
            // thumbnails tint exactly like the full viewer: packed two-mask
            // recolor when a parameter plane exists, uniform luminance when
            // the extraction baked that verdict onto the part
            if (recolor) {
              let packed = null;
              const paramFile = texFile(img, roles.parameter);
              if (paramFile) {
                try {
                  packed = await texLoader.loadAsync(app.store.url(paramFile));
                  packed.colorSpace = THREE.NoColorSpace;
                } catch { packed = null; }
              }
              applyPackedRecolor(mat, packed, recolor, {
                fullTint: part.uniform_luminance_tint === true,
              });
            }
          } catch { /* neutral fallback */ }
        }
      }
      const m = new THREE.Mesh(geo, mat);
      if (Array.isArray(part.local_matrix) && part.local_matrix.length === 12) {
        const l = part.local_matrix;
        m.applyMatrix4(new THREE.Matrix4().set(l[0], l[1], l[2], l[3], l[4], l[5], l[6], l[7], l[8], l[9], l[10], l[11], 0, 0, 0, 1));
      }
      m.frustumCulled = false;
      group.add(m);
      own.push(geo, mat);
    }
    if (!group.children.length) return null;
    // one shared camera pose per model, computed from the first variant rendered
    let f = _thumbFrame.get(model.id);
    if (!f) {
      const bb = new THREE.Box3().setFromObject(group);
      if (bb.isEmpty()) return null;
      const center = bb.getCenter(new THREE.Vector3());
      const r = Math.max(1e-3, 0.5 * bb.getSize(new THREE.Vector3()).length());
      const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.1;
      const dir = new THREE.Vector3(-0.55, 0.71, 0.44).normalize();
      const pos = center.clone().addScaledVector(dir, dist);
      f = { pos: pos.toArray(), target: center.toArray(), near: Math.max(dist / 500, 0.05), far: dist * 20 };
      _thumbFrame.set(model.id, f);
    }
    camera.position.fromArray(f.pos);
    camera.near = f.near; camera.far = f.far;
    camera.lookAt(new THREE.Vector3().fromArray(f.target));
    camera.updateProjectionMatrix();
    const size = 128;
    const frame = renderTransparentFrame({ renderer: getRenderer(), scene, camera }, size, size);
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const g = out.getContext('2d')!;
    g.fillStyle = '#0d0f13';
    g.fillRect(0, 0, size, size);
    const stage = document.createElement('canvas');
    stage.width = stage.height = size;
    stage.getContext('2d')!.putImageData(new ImageData(frame.data, size, size), 0, 0);
    g.drawImage(stage, 0, 0);
    return out.toDataURL('image/png');
  } finally {
    for (const o of own) { (o as any).map?.dispose?.(); o.dispose?.(); }
  }
}

// ---- particle effects: join the displayed model to the world effects doc --
// A system model's `sources[]` (extract/world/catalog.ts, the portable
// catalog build) retain the registry slot(s) that produced it: the row that
// owns the mesh/material directly (owner_slot), and, when the entity is
// grouped under a shared descriptor, its family/base owner
// (entity_owner_slot, entity_family_owner_slot). Any of those may be the
// slot the effects doc's owner attachments reference, so the join checks
// their union. User-authored models carry no `sources`, so this is empty
// for them and the model page simply shows no effects.
function modelOwnerSlots(model: ModelRecord): Set<number> {
  const slots = new Set<number>();
  const sources = Array.isArray(model.sources) ? model.sources : [];
  for (const source of sources) {
    for (const key of ['owner_slot', 'entity_owner_slot', 'entity_family_owner_slot']) {
      const value = source?.[key];
      if (Number.isInteger(value)) slots.add(value);
    }
  }
  return slots;
}

// Systems attached to any of the model's owner slots, ascending by slot
// (deterministic chip order), emitter-less systems excluded (nothing to
// render).
function systemsForModel(doc: WorldEffectsDoc, slots: Set<number>): EffectSystem[] {
  if (!slots.size || !Array.isArray(doc?.systems) || !doc.systems.length) return [];
  const wanted = new Set<number>();
  for (const att of doc.attachments?.owners || []) {
    if (slots.has(Number(att.owner))) wanted.add(Number(att.system));
  }
  if (!wanted.size) return [];
  const bySlot = new Map(doc.systems.map((s) => [s.slot, s]));
  return [...wanted]
    .map((slot) => bySlot.get(slot))
    .filter((s): s is EffectSystem => !!s && s.emitters.length > 0)
    .sort((a, b) => a.slot - b.slot);
}

function effectSystemLabel(system: EffectSystem): string {
  return system.names[0]?.name || `effect #${system.slot}`;
}

export function createModelView(app: any, model: ModelRecord) {
  const root = el('div', { class: 'viewer-pane' });
  const toolbar = el('div', { class: 'viewer-toolbar' });
  const host = el('div', { class: 'canvas-host' });
  root.append(toolbar, host);

  let destroyed = false, scene: any = null, bar: any = null;
  let effectsPlayer: EffectsPlayer | null = null;
  // sibling group anchored at the model's rest-pose bbox centre; the
  // EffectsPlayer mounts here so ambient effects (e.g. auras) radiate from
  // the body rather than from the rig-root/scene-origin at the model's feet
  let effectsAnchor: any = null;
  // the (at most one) timed system currently slaved to the clip transport:
  // its clock is driven from bar.t every tick while that clip keeps playing
  let effectsSlaved: { slot: number; clip: number } | null = null;
  const immersive = mountImmersiveControls({ pane: root, host, toolbar });
  const view = {
    root,
    destroy() { destroyed = true; immersive.destroy(); effectsPlayer?.dispose(); effectsAnchor?.removeFromParent(); scene?.destroy(); bar?.destroy(); },
    // ←/→ from the global key handler: → enters/advances the variant strip,
    // ← retreats; ← on the leftmost variant exits strip focus back to the list
    variantNav(dir: number): boolean {
      if (!hasStrip) return false;
      const cur = modelVariantIndex(model);
      const focused = _stripFocus.get(model.id) === true;
      if (dir > 0) {
        if (!focused) { _stripFocus.set(model.id, true); syncStripClasses(); return true; }
        if (cur < variants.length - 1) selectVariant(cur + 1);
        return true;
      }
      if (!focused) return false;
      if (cur === 0) { _stripFocus.set(model.id, false); syncStripClasses(); return true; }
      selectVariant(cur - 1);
      return true;
    },
  };

  // Advances the effects player each frame (called from the existing
  // scene.addTick, beside bar.tick). While a timed system is slaved to the
  // clip transport, its progress tracks bar.t directly instead of the
  // player's own master clock, so windowed bursts land on the animation
  // timeline; it releases back to standalone once that clip stops playing.
  function tickModelEffects(dt: number, playbackBar: any | null): void {
    if (!effectsPlayer) return;
    if (effectsSlaved) {
      if (playbackBar?.playing && playbackBar.clipJson?.i === effectsSlaved.clip) {
        effectsPlayer.syncClock(effectsSlaved.slot, playbackBar.t * (effectsPlayer.clock.tickRate / 1000));
      } else {
        effectsPlayer.unslave(effectsSlaved.slot);
        effectsSlaved = null;
      }
    }
    effectsPlayer.tick(dt, scene.camera);
  }

  // Resolves the model's attached particle effect systems (if any) and, once
  // found, mounts an EffectsPlayer on `effectsRoot` (the same native-unit
  // group the model mesh lives under). Idle/ambient systems auto-play;
  // timed (attack/impact) systems get a "Play effect" chip that either fires
  // standalone or, when bound to a clip this model actually has, slaves to
  // the PlaybackBar. Fire-and-forget: never blocks mesh loading.
  async function attachModelEffects(effectsRoot: any, playbackBar: any | null, clipList: IndexEntry[]): Promise<void> {
    const slots = modelOwnerSlots(model);
    if (!slots.size || typeof app.store.worldEffects !== 'function') return;
    let doc: WorldEffectsDoc | null = null;
    try { doc = await app.store.worldEffects(); } catch { /* no effects data for this version */ }
    if (destroyed || !doc) return;
    const systems = systemsForModel(doc, slots);
    if (!systems.length) return;
    const player = new EffectsPlayer({
      root: effectsRoot, doc, url: (rel: string) => app.store.url(rel), anisotropy: 8,
    });
    const chips: HTMLElement[] = [];
    for (const system of systems) {
      if (player.addSystem(system.slot) !== 'timed') continue;
      const btn = el('button', {
        class: 'btn', text: `▶ ${effectSystemLabel(system)}`,
        title: 'Play this timed particle effect once',
      });
      btn.addEventListener('click', () => {
        const boundClip = playbackBar
          ? system.clips.find((ordinal) => clipList.some((c) => c.i === ordinal && c.f))
          : undefined;
        if (playbackBar && boundClip != null) {
          const entry = clipList.find((c) => c.i === boundClip)!;
          effectsSlaved = { slot: system.slot, clip: boundClip };
          playbackBar.loadClip(entry).then(() => playbackBar.play());
        } else {
          effectsSlaved = null;
          player.play(system.slot);
        }
      });
      chips.push(btn);
    }
    effectsPlayer = player;
    if (chips.length) toolbar.append(el('span', { class: 'sep' }), ...chips);
  }

  const parts = modelParts(model);
  toolbar.append(
    el('span', { class: 'viewer-title', text: `Model ${model.name}` }),
    badge(`${parts.length} mesh${parts.length === 1 ? '' : 'es'}`, 'b-ghost'),
    // native append: a null here becomes a "null" text node, preserved as-is
    model.source === 'system' ? badge('system', 'b-good b-ghost', 'Read-only model recovered from owner-qualified asset data') : (null as any),
  );
  // variant strip along the bottom (image-viewer style): one 3D-preview
  // thumbnail per whole-model variant; click or ←/→ swaps the complete
  // mesh/material/texture/recolour part set (what the old dropdown did)
  const variants = modelVariants(model);
  const hasStrip = model.source === 'system' && variants.length > 1;
  const selectVariant = (index: number): void => {
    if (index === modelVariantIndex(model) || !setModelVariant(model, index)) return;
    app.mountView?.(app.cur, ++app._navToken);
  };
  let syncStripClasses: () => void = () => {};
  if (hasStrip) {
    toolbar.append(badge(`${variants.length} variants`, 'b-ghost'));
    const labels = modelVariantLabels(model);
    const active = modelVariantIndex(model);
    const strip = el('div', { class: 'substrip variant-strip' });
    // this model now owns the render queue; its active variant goes first
    prioritizeThumbs(model.id);
    variantThumb(app, model, active);
    const cells = variants.map((_, k) => {
      const box = el('div', { class: 'st-box' }, el('span', { class: 'dim', text: '⋯' }));
      const cell = el('div', { class: 'subthumb' }, box,
        el('div', { class: 'st-label', text: labels[k] }));
      cell.addEventListener('click', () => { _stripFocus.set(model.id, true); selectVariant(k); });
      strip.appendChild(cell);
      variantThumb(app, model, k).then((url) => {
        if (!url || !cell.isConnected) return;
        clear(box);
        box.appendChild(el('img', { src: url, alt: labels[k] }));
      });
      return cell;
    });
    syncStripClasses = () => {
      const cur = modelVariantIndex(model);
      const focused = _stripFocus.get(model.id) === true;
      cells.forEach((c, k) => {
        c.classList.toggle('active', k === cur);
        c.classList.toggle('kb-focus', focused && k === cur);
      });
      cells[cur]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    syncStripClasses();
    root.appendChild(strip);
  }

  (async () => {
    let skelEntry: IndexEntry | null | undefined = null;
    let skelJson: any, clips: IndexEntry[] = [], meshRows: any[] = [], imagesIdx: IndexEntry[] | null = null;
    try {
      if (model.skel || Number.isInteger(model.skel_i)) {   // null = static/mixed model: no single rig
        const skels = await app.store.index('rigs');
        skelEntry = model.skel ? skels.find((s: IndexEntry) => s.h === model.skel) : null;
        if (!skelEntry && Number.isInteger(model.skel_i)) skelEntry = skels.find((s: IndexEntry) => s.i === model.skel_i);
        if (!skelEntry) {
          root.appendChild(notExported(`The rig this model was built on (${model.skel ? model.skel.slice(0, 8) : `#${model.skel_i}`})`));
          return;
        }
        skelJson = await app.store.json(skelEntry.f);
        const anims = await app.store.index('anims');
        clips = anims.filter((a: IndexEntry) => a.skel === skelEntry!.i);
      }
      const meshes = await app.store.index('meshes');
      const byH = new Map<any, IndexEntry>(meshes.map((m: IndexEntry) => [m.h, m]));
      // System parts are profile-scoped and resolve ordinal-first. User models
      // remain hash-only so they survive reordering across versions.
      meshRows = parts
        .map((part, partIndex) => {
          const system = model.source === 'system';
          const m = system && Number.isInteger(part.mesh)
            ? entryByOrdinal(meshes, part.mesh) : byH.get(part.mesh_hash);
          return m ? {
            ...m, _img: part.image_hash, _imgOrdinal: part.image,
            _part: part, _partKey: `${partIndex}:${m.i}`, _system: system,
          } : null;
        })
        .filter(Boolean);
    } catch { return; }
    try { imagesIdx = await app.store.index('images'); } catch { /* untextured */ }
    if (destroyed) return;

    // ---- static model: meshes on a plain scene (no rig, transport or video) --
    if (!skelEntry) {
      scene = new Scene3D(host);
      const texLoader = new THREE.TextureLoader();
      const bb = new THREE.Box3();
      const prepared = await mapConcurrent(meshRows.filter((m) => m.f), 6, async (m) => {
        try {
          const payload = await app.store.payload(m.f);
          if (destroyed) return null;
          const { geo } = buildMeshGeometry(payload);
          const mat = new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.02, roughness: 0.88, alphaTest: 0.35 });
          await applyPartAppearance(mat, m, imagesIdx, app, texLoader);
          if (destroyed) {
            geo.dispose(); mat.map?.dispose();
            (mat as any).brighterParameterMap?.dispose(); mat.dispose(); return null;
          }
          const obj = new THREE.Mesh(geo, mat);
          applyPartTransform(obj, m._part);
          return obj;
        } catch (e) { app.banner(`mesh failed to load: ${e.message}`); }
        return null;
      });
      if (destroyed) {
        for (const obj of prepared) {
          obj.geometry.dispose(); (obj.material as any).map?.dispose();
          (obj.material as any).brighterParameterMap?.dispose(); (obj.material as any).dispose();
        }
        return;
      }
      // Commit the completed model in one scene update.  Adding each part as
      // its request finishes creates a conspicuous assemble-in-place effect.
      scene.scene.add(...prepared);
      for (const obj of prepared) {
        obj.updateMatrixWorld(true);
        bb.union(new THREE.Box3().setFromObject(obj));
      }
      if (bb.isEmpty()) bb.setFromCenterAndSize(new THREE.Vector3(0, 0, 5), new THREE.Vector3(10, 10, 10));
      const dim = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, 1);
      scene.frameBox([bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.max.y, bb.max.z]);
      scene.addGround(dim / 2, Math.min(0, bb.min.z), { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2 });
      toolbar.append(makeGridToggle(scene), makeLightToggle(scene));
      // dedicated anchor at the mesh bbox centre: effects mount here, not at
      // the scene root, so a floor-level model origin doesn't put ambient
      // effects at the model's feet
      effectsAnchor = new THREE.Group();
      effectsAnchor.position.copy(bb.getCenter(new THREE.Vector3()));
      scene.scene.add(effectsAnchor);
      const capStatic = { i: model.id.slice(0, 8), h: model.id, name: model.name };
      const staticShot = el('button', { class: 'btn', text: '▣ Screenshot', title: 'Capture the current 3D view as a PNG/JPEG/WebP image' });
      staticShot.addEventListener('click', async () => {
        const { openScreenshotModal } = await import('./screenshot.js');
        const shotRes = getPref('shotRes') || '8k';
        openScreenshotModal({
          app, scene, entry: capStatic, activeSize: meshRows.length, cat: 'models',
          highRes: {
            options: SHOT_RES,
            initial: shotRes in SHOT_RES ? shotRes : '8k',
            onPick: (key: string) => setPref('shotRes', key),
            capture: (key: string, onProgress: (msg: string) => void, opts?: { transparent?: boolean }) =>
              captureTiledPng(scene, key, `brighter-atlas-model-${capStatic.i}`, onProgress, () => !destroyed, opts?.transparent),
          },
        });
      });
      toolbar.append(el('span', { class: 'sep' }), staticShot, el('span', { class: 'sep' }), ...exportGroup(app, model, []));
      scene.addTick((dt: number) => tickModelEffects(dt, null));
      void attachModelEffects(effectsAnchor, null, []);
      if ((window as any).__bs) {
        (window as any).__bs.modelView = {
          model, skelEntry: null, rig: null, bar: null, active: null, scene, meshRows,
          effectsInfo: () => (effectsPlayer ? effectsPlayer.info() : { systems: [], live: 0 }),
        };
      }
      return;
    }

    toolbar.append(el('a', { href: `#/rig/${skelEntry.i}`, class: 'small', text: `rig #${skelEntry.i} →`, title: 'Open the underlying rig' }));

    const rig = new Rig(skelJson);
    const { min, max } = rig.restWorldInfo();
    const dim = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1);

    scene = new Scene3D(host);
    scene.frameBox([min.x, min.y, min.z], [max.x, max.y, max.z]);
    scene.addGround(dim / 2, Math.min(0, min.z), { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 });

    const anchor = new THREE.Group();
    anchor.add(...rig.roots);
    scene.scene.add(anchor);

    // dedicated sibling group at the rest-pose bbox centre: do NOT translate
    // `anchor` itself (it holds the rig roots; moving it would move the
    // model). Ambient effects (e.g. auras) mount on this group instead, so
    // they radiate from the body rather than from the rig-root/scene-origin
    // that sits at the model's feet
    effectsAnchor = new THREE.Group();
    effectsAnchor.position.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    scene.scene.add(effectsAnchor);

    const viz = new SkeletonViz(scene.scene, rig, { jointRadius: Math.max(dim * 0.018, 0.12), onTop: true });
    viz.update();

    bar = new PlaybackBar({
      host: root, clips, store: app.store, rig,
      onApplied: () => { if (viz.group.visible) viz.update(); },
      onError: (msg: string) => app.banner(msg),
    });
    scene.addTick((dt: number) => {
      bar.tick(dt);
      if (viz.group.visible && bar.playing) viz.update();
      tickModelEffects(dt, bar);
    });
    void attachModelEffects(effectsAnchor, bar, clips);

    const active = new Map<string, any>();
    const meshCountLbl = el('b', { text: '0' });
    // materials + full shading toolbar (Lit/Textured/…/UV-map) shared with the
    // skeleton composite; mounts its buttons onto `toolbar` here.
    const { mats, wireMat, texLoader, po, matFor, refit, refreshUv, getMode } = mountComposite({
      // this composite keys `active` by part key (string), not mesh ordinal
      scene, toolbar, host, viz, active: active as any, min, max,
      isDestroyed: () => destroyed,
      applyTitle: 'Applies to every mesh in this model',
      uvTitle: 'Combined UV layout of every mesh in this model',
    });

    // resolve the mesh's PINNED variant image (by content hash) -> textured mat
    async function makeTexMat(m: any) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.02, roughness: 0.88, alphaTest: 0.35, ...po });
      mat.side = mats.lit.side;
      return applyPartAppearance(mat, m, imagesIdx, app, texLoader);
    }

    async function prepareMesh(m: any): Promise<{ m: any; obj: any; wire: any } | null> {
      if (active.has(m._partKey) || !m.f) return null;
      try {
        const payload = await app.store.payload(m.f);
        if (destroyed) return null;
        const { geo, skinned } = buildMeshGeometry(payload);
        const texMat = await makeTexMat(m);
        if (destroyed) {
          geo.dispose(); texMat.map?.dispose();
          texMat.brighterParameterMap?.dispose(); texMat.dispose(); return null;
        }
        const Cls = (skinned ? THREE.SkinnedMesh : THREE.Mesh) as any;
        const obj = new Cls(geo, mats.lit);
        const wire = new Cls(geo, wireMat);
        applyPartTransform(obj, m._part);
        applyPartTransform(wire, m._part);
        if (skinned) {
          (obj as any).bind(rig.skeleton, new THREE.Matrix4());   // explicit identity bind matrix (see skeleton.js)
          (wire as any).bind(rig.skeleton, (obj as any).bindMatrix);
          obj.frustumCulled = wire.frustumCulled = false;
        }
        obj.userData = { texMat, wire };
        wire.visible = getPref('wireframe');
        obj.material = matFor(obj);
        return { m, obj, wire };
      } catch (e) {
        app.banner(`mesh #${m.i} failed to load: ${e.message}`);
      }
      return null;
    }
    async function enableMany(list: any[]): Promise<void> {
      const prepared = await mapConcurrent(list, 6, prepareMesh);
      if (destroyed) {
        for (const { obj } of prepared) {
          obj.geometry.dispose(); obj.userData.texMat.map?.dispose();
          obj.userData.texMat.brighterParameterMap?.dispose(); obj.userData.texMat.dispose();
        }
        return;
      }
      // Reveal the fixed set atomically, then do the expensive combined UV and
      // camera calculations once instead of once per constituent mesh.
      for (const { m, obj, wire } of prepared) {
        scene.scene.add(obj, wire);
        active.set(m._partKey, obj);
      }
      meshCountLbl.textContent = fmtInt(active.size);
      refreshUv();
      refit();
    }

    // ---- capture group: screenshot / video ---------------------------------
    const capEntry = { i: skelEntry.i, h: model.id, name: model.name };   // synthetic entry (caption + filename)
    const shotBtn = el('button', { class: 'btn', text: '▣ Screenshot', title: 'Capture the current 3D view as a PNG/JPEG/WebP image' });
    shotBtn.addEventListener('click', async () => {
      if (!active.size) { app.banner('this model has no loaded meshes'); return; }
      const { openScreenshotModal } = await import('./screenshot.js');
      const shotRes = getPref('shotRes') || '8k';
      openScreenshotModal({
        app, scene, entry: capEntry, activeSize: active.size, cat: 'models',
        highRes: {
          options: SHOT_RES,
          initial: shotRes in SHOT_RES ? shotRes : '8k',
          onPick: (key: string) => setPref('shotRes', key),
          capture: (key: string, onProgress: (msg: string) => void, opts?: { transparent?: boolean }) =>
            captureTiledPng(scene, key, `brighter-atlas-model-${capEntry.i}`, onProgress, () => !destroyed, opts?.transparent),
        },
      });
    });
    const vidBtn = el('button', { class: 'btn', text: '◉ Video', title: 'Record the current model: WEBM/MP4/GIF, multiple clips, turntable, caption' });
    vidBtn.addEventListener('click', () => {
      if (!active.size) { app.banner('this model has no loaded meshes'); return; }
      openVideoWizard({ app, scene, bar, clips, entry: capEntry, activeSize: active.size });
    });
    toolbar.append(makeGridToggle(scene), makeLightToggle(scene), el('span', { class: 'sep' }), shotBtn, vidBtn, el('span', { class: 'sep' }), ...exportGroup(app, model, clips));

    // load the fixed mesh set
    await enableMany(meshRows.filter((m) => m.f));

    if ((window as any).__bs) {
      (window as any).__bs.modelView = {
        model, skelEntry, rig, bar, active, scene, meshRows, get mode() { return getMode(); },
        effectsInfo: () => (effectsPlayer ? effectsPlayer.info() : { systems: [], live: 0 }),
      };
    }
  })();

  return view;
}
