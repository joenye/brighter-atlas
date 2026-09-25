// Lightweight particle-effect playback for non-world surfaces (currently the
// model page). Reuses the closed-form sim core (effects-sim.ts) unchanged;
// this file owns rendering in one model's local space, rather than the room
// view's per-cell placement, room lifecycle and merged-view activation.
// Primary-rig attachments use the same birth-frame composition as the world
// layer, including independent position and direction bones.
//
// Kept deliberately separate from effects-layer.ts (which owns room
// placement math, camera-proximity activation and its own tuned batch
// internals). The sprite program and material settings are shared, while
// this player's lifecycle remains independent of the room layer's.
//
// Playback modes, one per attached system (see addSystem):
//   - 'loop': an untriggered looping system (ambient/idle). Runs
//     continuously from the moment it is added, driven by the player's
//     master clock.
//   - 'timed': a triggered system or non-looping burst. Inert until triggered via
//     play() (standalone, replays from its own start every call) or driven
//     externally via syncClock() (slaved to an outside transport, e.g. a
//     clip playback bar): see the model page's use of both.

import * as THREE from '../../../vendor/three.module.js';
import {
  EmitterSim, EffectsClock, planStrides, MODEL_PREVIEW_ALIVE_BUDGET,
} from './effects-sim.js';
import {
  BILLBOARD_VERTEX, BILLBOARD_FRAGMENT, DEFAULT_SPRITE_DRAW,
  spriteDrawOf, spriteUniforms, spriteColorSpace, spriteMaterialState, configureSpriteSampling, emitterSpriteDraws, type SpriteDraw,
} from './effects-sprite.js';
import type { WorldEffectsDoc, EffectSystem } from '../../extract/world/effects.js';
import {bindRigBirthFrames} from './effects-frames.js';
import type {EffectBoneAnimation} from './effects-animation.js';

// Per-view alive budget. A model page shows at most a handful of systems on
// one small subject, nowhere near a room's scale, so this is far below the
// room layer's per-view budgets.
export { MODEL_PREVIEW_ALIVE_BUDGET };

const RENDER_ORDER = 3;
const MIX_SORT_CAP = 2048;
const IDENTITY = new THREE.Matrix4().elements;

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
  timeSource: 'master' | 'external' | 'frozen';
  slavedTick: number;
  animation: EffectBoneAnimation | null;
  configureAnimation: (animation: EffectBoneAnimation | null) => void;
  // One entry per drawn sprite outcome; a selecting emitter repeats its sim.
  emitters: { sim: EmitterSim; batchKey: string; choice: number }[];
}

interface Batch {
  key: string;
  texId: number;
  draw: SpriteDraw;      // sub-image, native dimensions, channel layout
  blend: 'add' | 'mix';
  members: { sim: EmitterSim; instance: Instance; choice: number }[];
  capacity: number;
  count: number;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  posSize: Float32Array;
  color: Float32Array;
  rot: Float32Array;
  aPosSize: THREE.InstancedBufferAttribute;
  aColor: THREE.InstancedBufferAttribute;
  aRot: THREE.InstancedBufferAttribute;
  facing: Float32Array;
  aFacing: THREE.InstancedBufferAttribute;
  facingMode: Float32Array;
  aFacingMode: THREE.InstancedBufferAttribute;
  depth: Float32Array;
  order: number[];
}

export interface EffectsPlayerOptions {
  root: THREE.Object3D;                    // anchor group: added at (0,0,0) in its local space
  doc: WorldEffectsDoc;
  url: (rel: string) => string;
  aliveBudget?: number;
  rig?: {id: number; bones: readonly (readonly number[])[]};
}

export class EffectsPlayer {
  root: THREE.Object3D;
  doc: WorldEffectsDoc;
  clock: EffectsClock;
  private _url: (rel: string) => string;
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
  private _rig: EffectsPlayerOptions['rig'];

  constructor({
    root, doc, url, aliveBudget = MODEL_PREVIEW_ALIVE_BUDGET, rig,
  }: EffectsPlayerOptions) {
    this.root = root;
    this.doc = doc;
    this.clock = new EffectsClock(Number(doc?.tick_rate?.value));
    this._url = url;
    this._budget = aliveBudget;
    this._rig = rig;
    this._systemsBySlot = new Map((doc?.systems || []).map((s) => [s.slot, s]));
  }

  /** Attach a system by its registry slot. Activation uses system.triggered;
   *  a repeating emitter can still require an action to start it. Returns
   *  the assigned mode, or null when the slot is
   *  unknown or has no emitters (nothing to render, caller skips it). Safe
   *  to call once per slot; a repeat call is a no-op returning the existing
   *  mode. */
  addSystem(slot: number): EffectsPlayerMode | null {
    const existing = this._instances.get(slot);
    if (existing) return existing.mode;
    const system = this._systemsBySlot.get(slot);
    if (!system || !system.emitters.length) return null;
    const mode: EffectsPlayerMode = system.loop && !system.triggered ? 'loop' : 'timed';
    const animationSetters: ((animation: EffectBoneAnimation | null) => void)[] = [];
    const inst: Instance = {
      slot,
      system,
      mode,
      startTick: mode === 'loop' ? 0 : null,
      timeSource: 'master',
      slavedTick: 0,
      animation: null,
      configureAnimation: () => {},
      // Emitters with nothing drawable are skipped rather than given a fallback dot.
      emitters: system.emitters.flatMap((emitter, index) => {
        const draws = emitterSpriteDraws(emitter, this.doc.configs || {});
        if (!draws.length) return [];
        const sim = new EmitterSim(system, index, emitter, this.doc.configs || {}, this.clock.tickRate);
        if (this._rig && system.rig_selection?.alternate === false && emitter.transform) {
          const set = bindRigBirthFrames(sim, emitter.transform, this._rig.bones, IDENTITY);
          if (set) animationSetters.push(set);
        }
        const blend = (emitter.blend || system.blend) === 'add' ? 'add' : 'mix';
        return draws.map(({ sprite, choice }) => {
          const texId = Number(sprite.images[0]);
          this._draws.set(texId, spriteDrawOf(sprite));
          return { sim, batchKey: `${texId}|${blend}`, choice };
        });
      }),
    };
    inst.configureAnimation = animation => {
      const accepted = animation?.rig === this._rig?.id && animationSetters.length ? animation : null;
      if (inst.animation === accepted) return;
      inst.animation = accepted;
      for (const set of animationSetters) set(accepted);
    };
    this._instances.set(slot, inst);
    for (const { sim, batchKey, choice } of inst.emitters) {
      this._batchFor(batchKey).members.push({ sim, instance: inst, choice });
    }
    this._rebalance();
    return mode;
  }

  /** Restart a timed system from its beginning, standalone (its own
   *  progress is `masterClock.t - triggerTick`, so repeated calls simply
   *  replay it). No-op for unknown slots. */
  play(slot: number): void {
    const inst = this._instances.get(slot);
    if (!inst) return;
    inst.timeSource = 'master';
    inst.startTick = this.clock.t;
    inst.configureAnimation(null);
  }

  /** The caller owns this sampling rig. Its clock must use the same local
   *  timeline as syncClock(); ambient instances follow it automatically. */
  setAnimation(slot: number, animation: EffectBoneAnimation | null): void {
    this._instances.get(slot)?.configureAnimation(animation);
  }

  /** Slaved mode: drive a timed system's local clock directly from an
   *  external transport (absolute ticks), bypassing the master clock until
   *  play() or unslave() releases it. Refills immediately. */
  syncClock(slot: number, ticks: number, camera: THREE.Camera | null = null): void {
    const inst = this._instances.get(slot);
    if (!inst) return;
    inst.timeSource = 'external';
    inst.slavedTick = Number.isFinite(ticks) ? ticks : 0;
    this._fill(camera);
  }

  /** Stop driving a slaved instance externally; it freezes at its last tick
   *  until play() or syncClock() resumes it. */
  unslave(slot: number): void {
    const inst = this._instances.get(slot);
    if (inst?.timeSource === 'external') inst.timeSource = 'frozen';
  }

  /** Clear a system when its preview is no longer selected. It stays inert
   *  until play() or syncClock() starts it again. */
  stop(slot: number, camera: THREE.Camera | null = null): void {
    const inst = this._instances.get(slot);
    if (!inst) return;
    inst.timeSource = 'master';
    inst.startTick = null;
    inst.configureAnimation(null);
    this._fill(camera);
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
      for (const { sim, choice } of inst.emitters) if (choice <= 0) n += sim.alive;
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
        live: inst.emitters.reduce((n, { sim, choice }) => n + (choice <= 0 ? sim.alive : 0), 0),
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
    if (inst.timeSource !== 'master') return inst.slavedTick;
    if (inst.startTick == null) return Number.NEGATIVE_INFINITY;   // inert: never spawns
    if (inst.mode === 'loop' && inst.animation) return inst.animation.time();
    return this.clock.t - inst.startTick;
  }

  private _rebalance(): void {
    // A selecting emitter appears once per sprite outcome; plan it once.
    const all = new Set<EmitterSim>();
    for (const batch of this._batches.values()) for (const m of batch.members) all.add(m.sim);
    planStrides([...all], this._budget);
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
        ...spriteUniforms(draw),
        map: { value: this._textureFor(texId) },
      },
      ...spriteMaterialState(blend),
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
      posSize: new Float32Array(0), color: new Float32Array(0), rot: new Float32Array(0),
      aPosSize: null as any, aColor: null as any, aRot: null as any, facing: new Float32Array(0), aFacing: null as any, facingMode: new Float32Array(0), aFacingMode: null as any,
      depth: new Float32Array(0), order: [],
    };
    this._allocBatchArrays(batch, 4);
    this._batches.set(key, batch);
    return batch;
  }

  private _allocBatchArrays(batch: Batch, capacity: number): void {
    batch.capacity = capacity;
    batch.posSize = new Float32Array(capacity * 4);
    batch.color = new Float32Array(capacity * 4);
    batch.rot = new Float32Array(capacity);
    batch.facing = new Float32Array(capacity * 3);
    batch.facingMode = new Float32Array(capacity);
    batch.depth = new Float32Array(capacity);
    batch.order = [];
    batch.aPosSize = new THREE.InstancedBufferAttribute(batch.posSize, 4);
    batch.aColor = new THREE.InstancedBufferAttribute(batch.color, 4);
    batch.aRot = new THREE.InstancedBufferAttribute(batch.rot, 1);
    batch.aFacing = new THREE.InstancedBufferAttribute(batch.facing, 3);
    batch.aFacingMode = new THREE.InstancedBufferAttribute(batch.facingMode, 1);
    for (const attr of [batch.aPosSize, batch.aColor, batch.aRot, batch.aFacing, batch.aFacingMode]) {
      attr.setUsage(THREE.DynamicDrawUsage);
    }
    batch.geometry.deleteAttribute('aPosSize');
    batch.geometry.deleteAttribute('aColor');
    batch.geometry.deleteAttribute('aRot');
    batch.geometry.deleteAttribute('aFacing');
    batch.geometry.deleteAttribute('aFacingMode');
    batch.geometry.setAttribute('aPosSize', batch.aPosSize);
    batch.geometry.setAttribute('aColor', batch.aColor);
    batch.geometry.setAttribute('aRot', batch.aRot);
    batch.geometry.setAttribute('aFacing', batch.aFacing);
    batch.geometry.setAttribute('aFacingMode', batch.aFacingMode);
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
        configureSpriteSampling(loaded);
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

  // Per-frame scratch fill: birth frames already put each particle in the
  // model's local coordinates. The room-cell placement transform is absent.
  private _fill(camera: THREE.Camera | null): void {
    let rootMatrix: THREE.Matrix4 | null = null;
    if (camera) {
      (camera as any).getWorldPosition?.(this._camPos);
      (camera as any).getWorldDirection?.(this._camFwd);
      rootMatrix = this.root.matrixWorld;
    }
    for (const batch of this._batches.values()) {
      const { posSize, color, rot, facing, facingMode } = batch;
      const cap = batch.capacity;
      let idx = 0;
      const sortable = batch.blend === 'mix' && rootMatrix != null;
      for (const member of batch.members) {
        const { sim, instance, choice } = member;
        const T = this._effectiveT(instance);
        sim.ensure(T);
        sim.evaluate(T, (x, y, z, scale, r, g, b, a, roll, nx, ny, nz, mode) => {
          if (idx >= cap) return;
          const at4 = idx * 4;
          posSize[at4] = x;
          posSize[at4 + 1] = y;
          posSize[at4 + 2] = z;
          posSize[at4 + 3] = scale;
          color[at4] = r;
          color[at4 + 1] = g;
          color[at4 + 2] = b;
          color[at4 + 3] = a;
          rot[idx] = roll;
          facingMode[idx] = mode;
          facing[idx * 3] = nx;
          facing[idx * 3 + 1] = ny;
          facing[idx * 3 + 2] = nz;
          if (sortable) {
            this._scratch.set(x, y, z).applyMatrix4(rootMatrix!);
            batch.depth[idx] = this._scratch.sub(this._camPos).dot(this._camFwd);
          }
          idx++;
        }, choice);
      }
      if (sortable && idx > 1 && idx <= MIX_SORT_CAP) this._sortBatch(batch, idx);
      batch.count = idx;
      batch.geometry.instanceCount = idx;
      batch.aPosSize.needsUpdate = true;
      batch.aColor.needsUpdate = true;
      batch.aRot.needsUpdate = true;
      batch.aFacing.needsUpdate = true;
      batch.aFacingMode.needsUpdate = true;
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
    const facingCopy = batch.facing.slice(0, count * 3);
    const facingModeCopy = batch.facingMode.slice(0, count);
    for (let i = 0; i < count; i++) {
      const src = order[i];
      batch.posSize.set(posCopy.subarray(src * 4, src * 4 + 4), i * 4);
      batch.color.set(colCopy.subarray(src * 4, src * 4 + 4), i * 4);
      batch.rot[i] = rotCopy[src];
      batch.facingMode[i] = facingModeCopy[src];
      batch.facing.set(facingCopy.subarray(src * 3, src * 3 + 3), i * 3);
    }
  }
}


export default EffectsPlayer;
