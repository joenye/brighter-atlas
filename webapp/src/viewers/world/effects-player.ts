// Lightweight particle-effect playback for non-world surfaces (currently the
// model page). Reuses the closed-form sim core (effects-sim.ts) unchanged;
// this file owns only rendering, and only for a SINGLE fixed anchor (v1: the
// scene origin, i.e. the model's own local space) rather than the room
// view's per-cell placement, room lifecycle and merged-view activation.
// Exact per-emitter bone attachment is an explicit non-goal here: every
// system this player runs is anchored at the root it was given.
//
// Kept deliberately separate from effects-layer.ts (which owns room
// placement math, camera-proximity activation and its own tuned batch
// internals): the billboard shader + unit-quad geometry below are a small,
// intentional duplicate of that file's proven approach rather than a shared
// import, so this player's lifecycle never couples to the room layer's.
//
// Playback modes, one per attached system (see addSystem):
//   - 'loop': the system's own doc.loop is true (ambient/idle). Runs
//     continuously from the moment it is added, driven by the player's
//     master clock.
//   - 'timed': a one-shot burst (attack/impact). Inert until triggered via
//     play() (standalone, replays from its own start every call) or driven
//     externally via syncClock() (slaved to an outside transport, e.g. a
//     clip playback bar): see the model page's use of both.

import * as THREE from '../../../vendor/three.module.js';
import {
  EmitterSim, EffectsClock, planStrides, MODEL_PREVIEW_ALIVE_BUDGET,
} from './effects-sim.js';
import {
  BILLBOARD_VERTEX, BILLBOARD_FRAGMENT, DEFAULT_SPRITE_DRAW,
  spriteDrawOf, spriteUniforms, spriteColorSpace, type SpriteDraw,
} from './effects-sprite.js';
import type { WorldEffectsDoc, EffectSystem } from '../../extract/world/effects.js';

// Per-view alive budget. A model page shows at most a handful of systems on
// one small subject, nowhere near a room's scale, so this is far below the
// room layer's per-view budgets.
export { MODEL_PREVIEW_ALIVE_BUDGET };

const RENDER_ORDER = 3;
const MIX_SORT_CAP = 2048;

const pad5 = (value: number | string): string => String(value).padStart(5, '0');

export type EffectsPlayerMode = 'loop' | 'timed';

interface Instance {
  slot: number;
  system: EffectSystem;
  mode: EffectsPlayerMode;
  // effective sim time source: 'loop' instances always follow the master
  // clock from tick 0; 'timed' instances are inert (startTick === null)
  // until play() or syncClock() activates them.
  startTick: number | null;
  slaved: boolean;
  slavedTick: number;
  emitters: { sim: EmitterSim; batchKey: string }[];
}

interface Batch {
  key: string;
  texId: number;
  draw: SpriteDraw;      // sub-image, native dimensions, channel layout
  blend: 'add' | 'mix';
  members: { sim: EmitterSim; instance: Instance }[];
  capacity: number;
  count: number;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  posSize: Float32Array;
  color: Uint8Array;
  rot: Float32Array;
  aPosSize: THREE.InstancedBufferAttribute;
  aColor: THREE.InstancedBufferAttribute;
  aRot: THREE.InstancedBufferAttribute;
  depth: Float32Array;
  order: number[];
}

export interface EffectsPlayerOptions {
  root: THREE.Object3D;                    // anchor group: added at (0,0,0) in its local space
  doc: WorldEffectsDoc;
  url: (rel: string) => string;
  anisotropy?: number;
  aliveBudget?: number;
}

export class EffectsPlayer {
  root: THREE.Object3D;
  doc: WorldEffectsDoc;
  clock: EffectsClock;
  private _url: (rel: string) => string;
  private _anisotropy: number;
  // texId -> draw metrics from the doc, recorded as systems are attached so
  // the batch and texture created for that texId agree (see effects-sprite).
  private _draws = new Map<number, SpriteDraw>();
  private _budget: number;
  private _systemsBySlot: Map<number, EffectSystem>;
  private _instances = new Map<number, Instance>();
  private _batches = new Map<string, Batch>();
  private _textureCache = new Map<number, THREE.Texture>();
  private _fallbackTexture: THREE.Texture | null = null;
  private _loader = new THREE.TextureLoader();
  private _camPos = new THREE.Vector3();
  private _camFwd = new THREE.Vector3();
  private _scratch = new THREE.Vector3();
  private _disposed = false;

  constructor({
    root, doc, url, anisotropy = 8, aliveBudget = MODEL_PREVIEW_ALIVE_BUDGET,
  }: EffectsPlayerOptions) {
    this.root = root;
    this.doc = doc;
    this.clock = new EffectsClock(Number(doc?.tick_rate?.value));
    this._url = url;
    this._anisotropy = anisotropy;
    this._budget = aliveBudget;
    this._systemsBySlot = new Map((doc?.systems || []).map((s) => [s.slot, s]));
  }

  /** Attach a system by its registry slot. Mode is inherent to the doc
   *  (system.loop): returns the assigned mode, or null when the slot is
   *  unknown or has no emitters (nothing to render, caller skips it). Safe
   *  to call once per slot; a repeat call is a no-op returning the existing
   *  mode. */
  addSystem(slot: number): EffectsPlayerMode | null {
    const existing = this._instances.get(slot);
    if (existing) return existing.mode;
    const system = this._systemsBySlot.get(slot);
    if (!system || !system.emitters.length) return null;
    const mode: EffectsPlayerMode = system.loop ? 'loop' : 'timed';
    const inst: Instance = {
      slot,
      system,
      mode,
      startTick: mode === 'loop' ? 0 : null,
      slaved: false,
      slavedTick: 0,
      // Same rule as the room layer: an emitter with no material draws
      // nothing in the game, so it must not draw a fallback dot here.
      emitters: system.emitters.filter((e: any) => e.sprite?.images?.length).map((emitter, index) => {
        const sim = new EmitterSim(system, index, emitter, this.doc.configs || {}, this.clock.tickRate);
        const texId = Number(emitter.sprite!.images[0]);
        const blend = (emitter.blend || system.blend) === 'add' ? 'add' : 'mix';
        this._draws.set(texId, spriteDrawOf(emitter.sprite));
        return { sim, batchKey: `${texId}|${blend}` };
      }),
    };
    this._instances.set(slot, inst);
    for (const { sim, batchKey } of inst.emitters) {
      this._batchFor(batchKey).members.push({ sim, instance: inst });
    }
    this._rebalance();
    return mode;
  }

  /** Restart a timed system from its beginning, standalone (its own
   *  progress is `masterClock.t - triggerTick`, so repeated calls simply
   *  replay it). No-op for unknown slots or 'loop' systems. */
  play(slot: number): void {
    const inst = this._instances.get(slot);
    if (!inst) return;
    inst.slaved = false;
    inst.startTick = this.clock.t;
  }

  /** Slaved mode: drive a timed system's local clock directly from an
   *  external transport (absolute ticks), bypassing the master clock until
   *  play() or unslave() releases it. Refills immediately. */
  syncClock(slot: number, ticks: number, camera: THREE.Camera | null = null): void {
    const inst = this._instances.get(slot);
    if (!inst) return;
    inst.slaved = true;
    inst.slavedTick = Number.isFinite(ticks) ? ticks : 0;
    this._fill(camera);
  }

  /** Stop driving a slaved instance externally; it freezes at its last tick
   *  until play() or syncClock() resumes it. */
  unslave(slot: number): void {
    const inst = this._instances.get(slot);
    if (inst) inst.slaved = false;
  }

  /** Advance the master clock (drives 'loop' instances and any 'timed'
   *  instance mid standalone playback) and refill every batch. Instances in
   *  slaved mode ignore the master clock (see syncClock). */
  tick(dtMs: number, camera: THREE.Camera | null = null): void {
    if (this._disposed) return;
    this.clock.advance(dtMs);
    this._fill(camera);
  }

  /** Absolute seek of the master clock (frozen-clock screenshots/tests). */
  setClock(ticks: number, camera: THREE.Camera | null = null): void {
    if (this._disposed) return;
    this.clock.setClock(ticks);
    this._fill(camera);
  }

  setRunning(on: boolean): void {
    this.clock.setRunning(on);
  }

  liveCount(slot?: number): number {
    let n = 0;
    for (const inst of this._instances.values()) {
      if (slot != null && inst.slot !== slot) continue;
      for (const { sim } of inst.emitters) n += sim.alive;
    }
    return n;
  }

  drawCount(): number {
    let n = 0;
    for (const batch of this._batches.values()) if (batch.count > 0) n++;
    return n;
  }

  /** Debug/harness summary: one row per attached system plus the total live
   *  particle count across all of them. */
  info(): { systems: { slot: number; name: string; mode: EffectsPlayerMode; live: number; clips: number[] }[]; live: number } {
    const systems = [...this._instances.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((inst) => ({
        slot: inst.slot,
        name: inst.system.names[0]?.name || `effect #${inst.slot}`,
        mode: inst.mode,
        live: inst.emitters.reduce((n, { sim }) => n + sim.alive, 0),
        clips: inst.system.clips.slice(),
      }));
    return { systems, live: systems.reduce((n, s) => n + s.live, 0) };
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const batch of this._batches.values()) this._disposeBatch(batch);
    this._batches.clear();
    this._instances.clear();
    for (const texture of this._textureCache.values()) texture.dispose();
    this._textureCache.clear();
    this._fallbackTexture?.dispose();
    this._fallbackTexture = null;
  }

  // ------------------------------------------------------------- internals

  private _effectiveT(inst: Instance): number {
    if (inst.slaved) return inst.slavedTick;
    if (inst.startTick == null) return Number.NEGATIVE_INFINITY;   // inert: never spawns
    return this.clock.t - inst.startTick;
  }

  private _rebalance(): void {
    const all: EmitterSim[] = [];
    for (const batch of this._batches.values()) for (const m of batch.members) all.push(m.sim);
    planStrides(all, this._budget);
    for (const batch of this._batches.values()) {
      const capacity = Math.max(4, batch.members.reduce((sum, m) => sum + m.sim.capacity, 0));
      if (capacity !== batch.capacity) this._allocBatchArrays(batch, capacity);
    }
  }

  private _batchFor(key: string): Batch {
    let batch = this._batches.get(key);
    if (batch) return batch;
    const [texPart, blendPart] = key.split('|');
    const texId = Number(texPart);
    const blend = blendPart === 'add' ? 'add' : 'mix';
    const draw = this._draws.get(texId) ?? DEFAULT_SPRITE_DRAW;
    const material = new THREE.ShaderMaterial({
      name: `effects-player-${key}`,
      vertexShader: BILLBOARD_VERTEX,
      fragmentShader: BILLBOARD_FRAGMENT,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...spriteUniforms(draw),
        map: { value: this._textureFor(texId) },
      },
      fog: true,
      transparent: true,
      depthWrite: false,
      // Depth-tested against solid scenery in the room view (effects-layer.ts),
      // where the layer is occluded by OTHER geometry (walls, terrain) that
      // has nothing to do with the effect's own owner. Here the only geometry
      // present IS the attached model, and v1 has no bone anchor (an explicit
      // non-goal): a system's raw local coordinates are attached at the
      // model's origin, not its actual owning bone, so they routinely land
      // inside or just behind the model's own mesh. Depth-testing against it
      // would make an attached effect invisible far more often than not, so
      // this player always draws on top of its own model.
      depthTest: false,
      blending: blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending,
      // Double-sided for the same reason as the room layer: a possible
      // negative-determinant root (mirrored handedness) flips front-face
      // convention for everything under it, and corners are added in view
      // space so they never see that mirror themselves.
      side: THREE.DoubleSide,
    });
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `effects-player-batch-${key}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER;
    mesh.visible = false;
    this.root.add(mesh);
    batch = {
      key, texId, draw, blend, members: [], capacity: 0, count: 0,
      geometry, material, mesh,
      posSize: new Float32Array(0), color: new Uint8Array(0), rot: new Float32Array(0),
      aPosSize: null as any, aColor: null as any, aRot: null as any,
      depth: new Float32Array(0), order: [],
    };
    this._allocBatchArrays(batch, 4);
    this._batches.set(key, batch);
    return batch;
  }

  private _allocBatchArrays(batch: Batch, capacity: number): void {
    batch.capacity = capacity;
    batch.posSize = new Float32Array(capacity * 4);
    batch.color = new Uint8Array(capacity * 4);
    batch.rot = new Float32Array(capacity);
    batch.depth = new Float32Array(capacity);
    batch.order = [];
    batch.aPosSize = new THREE.InstancedBufferAttribute(batch.posSize, 4);
    batch.aColor = new THREE.InstancedBufferAttribute(batch.color, 4, true);
    batch.aRot = new THREE.InstancedBufferAttribute(batch.rot, 1);
    for (const attr of [batch.aPosSize, batch.aColor, batch.aRot]) {
      attr.setUsage(THREE.DynamicDrawUsage);
    }
    batch.geometry.deleteAttribute('aPosSize');
    batch.geometry.deleteAttribute('aColor');
    batch.geometry.deleteAttribute('aRot');
    batch.geometry.setAttribute('aPosSize', batch.aPosSize);
    batch.geometry.setAttribute('aColor', batch.aColor);
    batch.geometry.setAttribute('aRot', batch.aRot);
    delete (batch.geometry as any)._maxInstanceCount;
    batch.geometry.instanceCount = 0;
    batch.count = 0;
  }

  private _disposeBatch(batch: Batch): void {
    batch.mesh.removeFromParent();
    batch.geometry.dispose();
    batch.material.dispose();
  }

  private _textureFor(texId: number): THREE.Texture {
    if (!(texId >= 0)) return this._fallback();
    let texture = this._textureCache.get(texId);
    if (texture) return texture;
    const draw = this._draws.get(texId) ?? DEFAULT_SPRITE_DRAW;
    const sub = draw.sub;
    texture = this._fallback().clone();
    texture.needsUpdate = true;
    this._textureCache.set(texId, texture);
    this._loader.loadAsync(this._url(`images/${pad5(texId)}_e${sub}.png`))
      .then((loaded) => {
        if (this._disposed) { loaded.dispose(); return; }
        loaded.colorSpace = spriteColorSpace(draw);
        loaded.anisotropy = this._anisotropy;
        const previous = this._textureCache.get(texId);
        this._textureCache.set(texId, loaded);
        for (const batch of this._batches.values()) {
          if (batch.texId === texId) batch.material.uniforms.map.value = loaded;
        }
        previous?.dispose();
      })
      .catch(() => { /* missing sprite image: the fallback keeps drawing */ });
    return texture;
  }

  // Procedural radial soft dot (no DOM): used until sprites load and for
  // emitters that carry no image. Identical to effects-layer.ts's fallback.
  private _fallback(): THREE.Texture {
    if (this._fallbackTexture) return this._fallbackTexture;
    const size = 32;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5) / size - 0.5;
        const dy = (y + 0.5) / size - 0.5;
        const d = Math.min(1, Math.hypot(dx, dy) * 2);
        const a = Math.round(255 * Math.max(0, 1 - d) ** 2);
        const at = (y * size + x) * 4;
        data[at] = 255; data[at + 1] = 255; data[at + 2] = 255; data[at + 3] = a;
      }
    }
    const texture = new THREE.DataTexture(data, size, size);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this._fallbackTexture = texture;
    return texture;
  }

  // Per-frame scratch fill: same shape as effects-layer.ts's, minus the
  // room-cell anchor transform (v1: every instance sits at the root's own
  // origin, so sim-local coordinates ARE the batch coordinates directly).
  private _fill(camera: THREE.Camera | null): void {
    let rootMatrix: THREE.Matrix4 | null = null;
    if (camera) {
      (camera as any).getWorldPosition?.(this._camPos);
      (camera as any).getWorldDirection?.(this._camFwd);
      rootMatrix = this.root.matrixWorld;
    }
    for (const batch of this._batches.values()) {
      const { posSize, color, rot } = batch;
      const cap = batch.capacity;
      let idx = 0;
      const sortable = batch.blend === 'mix' && rootMatrix != null;
      for (const member of batch.members) {
        const { sim, instance } = member;
        const T = this._effectiveT(instance);
        sim.ensure(T);
        sim.evaluate(T, (x, y, z, scale, r, g, b, a, roll) => {
          if (idx >= cap) return;
          const at4 = idx * 4;
          posSize[at4] = x;
          posSize[at4 + 1] = y;
          posSize[at4 + 2] = z;
          posSize[at4 + 3] = scale;
          color[at4] = Math.round(clamp01(r) * 255);
          color[at4 + 1] = Math.round(clamp01(g) * 255);
          color[at4 + 2] = Math.round(clamp01(b) * 255);
          color[at4 + 3] = Math.round(clamp01(a) * 255);
          rot[idx] = roll;
          if (sortable) {
            this._scratch.set(x, y, z).applyMatrix4(rootMatrix!);
            batch.depth[idx] = this._scratch.sub(this._camPos).dot(this._camFwd);
          }
          idx++;
        });
      }
      if (sortable && idx > 1 && idx <= MIX_SORT_CAP) this._sortBatch(batch, idx);
      batch.count = idx;
      batch.geometry.instanceCount = idx;
      batch.aPosSize.needsUpdate = true;
      batch.aColor.needsUpdate = true;
      batch.aRot.needsUpdate = true;
      batch.mesh.visible = idx > 0;
    }
  }

  private _sortBatch(batch: Batch, count: number): void {
    const order = batch.order;
    order.length = count;
    for (let i = 0; i < count; i++) order[i] = i;
    const depth = batch.depth;
    order.sort((a, b) => depth[b] - depth[a] || a - b);
    let ordered = true;
    for (let i = 0; i < count; i++) if (order[i] !== i) { ordered = false; break; }
    if (ordered) return;
    const posCopy = batch.posSize.slice(0, count * 4);
    const colCopy = batch.color.slice(0, count * 4);
    const rotCopy = batch.rot.slice(0, count);
    for (let i = 0; i < count; i++) {
      const src = order[i];
      batch.posSize.set(posCopy.subarray(src * 4, src * 4 + 4), i * 4);
      batch.color.set(colCopy.subarray(src * 4, src * 4 + 4), i * 4);
      batch.rot[i] = rotCopy[src];
    }
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export default EffectsPlayer;
