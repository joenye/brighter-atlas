// Ambient particle effect rendering for the world viewer, over the recovered
// world:effects doc. One instanced unit-quad batch per (sprite texture x
// blend mode): every emitter sharing that pair fills the same batch, so a
// typical room costs 2 to 6 draw calls regardless of particle count.
// Billboarding happens in the vertex shader (view-space corner offset), all
// particle math stays in native game space (Z up) under a root that mirrors
// world.root's rotation/scale, and each frame walks the alive rings into the
// batch's scratch attribute arrays: sequential writes into [0, alive), one
// instanceCount update, no ring-wrap ranges or compaction.
//
// Blending: additive batches draw unsorted (order-independent); normal-blend
// batches sort back-to-front only while small (documented approximation:
// ambient effects are overwhelmingly additive). Both draw with depth test on
// and depth write off, above the water sheets via renderOrder.
//
// Ownership: this layer owns its geometries, materials and textures and
// frees all of them in dispose(); nothing here touches the shared world
// caches. The material cache is layer-owned, never module-global.
//
// Picking: the particles themselves are instanced billboard batches
// (frustumCulled=false, shared geometry across every emitter in a texture x
// blend pair) and are not meaningfully raycastable -- a hit on the batch
// mesh cannot identify which of its many instances/systems was struck. So
// each InstanceRec gets its own tiny proxy Mesh at the instance's anchor
// (addRoom/removeRoom own its lifecycle exactly like the particle batches),
// living directly under `root` alongside them. That keeps it OUT of the
// world view's normal placement picking for free (world.ts's own raycasts
// only ever look at room meshes / the merged pick index, neither of which
// this layer's objects are part of), and it is only ever pickable while the
// Effects layer itself exists, i.e. exactly while the Effects toggle is on
// (world.ts disposes the whole layer, proxies included, when it is off).
// The proxy is small and translucent rather than fully invisible: a fully
// invisible target would be undiscoverable, so it reads as a faint marker
// (see the material colours below) that brightens on hover/pin, the same
// affordance a pinned placement's yellow wireframe outline gives.
//
// Session edits (position/scale/hide/pause/scrub) live on the LAYER, keyed
// by effectInstanceKey(), rather than on the transient InstanceRec: both
// single-room reload and merged-mode proximity deactivate/reactivate tear
// down and rebuild InstanceRecs routinely, and an edit must survive that
// exactly like world/edits.js's WorldEdits survives a merged re-bake. See
// the EffectInstanceEdit doc comment below for the per-field rationale.

import * as THREE from '../../../vendor/three.module.js';
import {
  EmitterSim, EffectsClock,
} from './effects-sim.js';
import { composePlacementMatrix, DEFAULT_MESH_FORWARD_QUARTER_TURNS } from './scene.js';
import {
  BILLBOARD_VERTEX, BILLBOARD_FRAGMENT, DEFAULT_SPRITE_DRAW,
  spriteDrawOf, spriteUniforms, spriteColorSpace, type SpriteDraw,
} from './effects-sprite.js';
import type { WorldEffectsDoc, EffectSystem } from '../../extract/world/effects.js';

// Draw after the water sheets regardless of centroid depth (fountain jets
// must never vanish behind their own base pool).
export const EFFECTS_RENDER_ORDER = 3;

// Normal-blend batches above this alive count skip the back-to-front sort.
const MIX_SORT_CAP = 2048;

// Scratch matrices for the placement-matrix composition in addRoom() (one
// system instance at a time, never in the per-particle hot loop): reused
// exactly like scene.ts's own scratch matrices, matching that module's
// documented reuse discipline.
const _scratchObj = new THREE.Matrix4();
const _scratchOffset = new THREE.Matrix4();
// Scratch matrices for _applyAnchorEdit: also one-instance-at-a-time (a user
// clicking a nudge/reset button), never the per-particle hot loop.
const _scratchEditT = new THREE.Matrix4();
const _scratchEditM = new THREE.Matrix4();

const pad5 = (value: number | string): string => String(value).padStart(5, '0');

// The placement matrix M_obj (viewers/world/scene.ts composePlacementMatrix)
// for the occurrence a system is attached to, EXACTLY the frame the room
// renderer draws the owning mesh in: translate(owner-dimensions centre) .
// rotateZ(occ.rot + meshForward) . optional reflect . optional local
// matrix. `m` holds THREE.Matrix4.elements (column-major 16 numbers); the
// per-particle hot loop in _fill() reads only the 12 affine entries,
// inlined there (never via a per-call tuple allocation). A pure translation
// (the pre-v2 anchor) is the degenerate case of this same matrix.
interface Anchor { m: Float32Array }

/**
 * Session-only edit state for one effect instance, mirroring world/edits.js's
 * placement-edit idiom but scoped to what an instance actually has:
 * - dx/dy/dz: an anchor offset in TILE units for x/y and HEIGHT LAYERS for z
 *   (exactly world/edits.js's units), never a rotation -- the anchor's own
 *   rotation is authored, and nudging particles is only ever a translation.
 *   The sim keeps simulating in its own local frame regardless; only the
 *   anchor matrix that frame is drawn INTO moves (see _applyAnchorEdit).
 * - scaleMult: multiplies every one of the instance's emitters' decoded quad
 *   size, on top of each emitter's own authored scale0/1 curve.
 * - hidden: drops every one of the instance's emitters from the fill loop
 *   entirely (zero particles, zero cost), never disposes anything.
 * - paused/clockOffset/frozenT: an independent pause + scrub riding the
 *   ONE shared EffectsClock rather than a second clock object per instance.
 *   The instance's effective sim time is `paused ? frozenT : clock.t +
 *   clockOffset`. A fully separate per-instance EffectsClock was not built:
 *   nothing here needs an independent speed multiplier, only an offset and a
 *   freeze, and both are cheap (two numbers + one branch in the hot fill
 *   loop). Pausing captures the CURRENT effective time into frozenT;
 *   resuming re-derives clockOffset so playback continues from exactly that
 *   point with no visible jump as the shared clock keeps advancing.
 * All fields default to an exact no-op (see defaultEffectEdit) so an
 * instance nobody has touched behaves byte-identically to before this edit
 * surface existed -- load-bearing for the frozen-clock determinism gate.
 */
export interface EffectInstanceEdit {
  dx: number; dy: number; dz: number;
  scaleMult: number;
  hidden: boolean;
  paused: boolean;
  clockOffset: number;
  frozenT: number;
}

function defaultEffectEdit(): EffectInstanceEdit {
  return {
    dx: 0, dy: 0, dz: 0, scaleMult: 1, hidden: false, paused: false, clockOffset: 0, frozenT: 0,
  };
}

function isEffectEditNoop(edit: EffectInstanceEdit): boolean {
  return !edit.dx && !edit.dy && !edit.dz && edit.scaleMult === 1
    && !edit.hidden && !edit.paused && !edit.clockOffset;
}

/** The identity of one effect instance across a session: room + the same
 *  (occurrence, system) pair addRoom() keys InstanceRecs by. Exported so a
 *  caller (world.ts's pin/inspect flow, its effectsApi test hook) can derive
 *  the SAME key from a `doc.attachments.rooms` record without duplicating
 *  the format. */
export function effectInstanceKey(
  room: number | string, occurrence: number | string, system: number | string,
): string {
  return `${Number(room)}|${Number(occurrence)}|${Number(system)}`;
}

interface InstanceRec {
  key: string;
  system: EffectSystem;
  anchor: Anchor;
  // The authored anchor, captured once before any edit is ever applied:
  // _applyAnchorEdit always recomputes `anchor.m` fresh from this (never
  // accumulates deltas), exactly like world/edits.js's `original`.
  anchorOriginal: Float32Array;
  // Shared reference with this._instanceEdits.get(key): mutating it (the
  // nudge*/setInstance*/reset* methods below) is instantly visible to every
  // batch member and the proxy that reference this same rec, with no need
  // to re-push or search anything.
  edit: EffectInstanceEdit;
  // Tiny pickable marker at the anchor; see the picking note atop this file.
  // Null only in the impossible case _createProxy is skipped; kept nullable
  // rather than asserted so a future guard can't NPE.
  proxy: THREE.Mesh | null;
  // boneOffset: the emitter's bound rig bone's rest-world translation
  // (native units, in the SAME local frame as the emitter's own origin),
  // added to the simulated position before `anchor` transforms it to world;
  // [0,0,0] for a root-anchored (unrigged, or no bone attachment) emitter.
  emitters: { sim: EmitterSim; batchKey: string; boneOffset: [number, number, number] }[];
}

interface Batch {
  key: string;
  texId: number;         // ab3 container ordinal, -1 = built-in fallback
  draw: SpriteDraw;      // sub-image, native dimensions, channel layout
  blend: 'add' | 'mix';
  members: {
    sim: EmitterSim; anchor: Anchor; boneOffset: [number, number, number];
    edit: EffectInstanceEdit;   // shared reference with the owning InstanceRec
  }[];
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
  // normal-blend sort scratch (allocated lazily with the batch arrays)
  depth: Float32Array;
  order: number[];
}

export interface WorldEffectsLayerOptions {
  root: THREE.Group;                       // native-space effects root
  doc: WorldEffectsDoc;
  url: (rel: string) => string;            // store URL resolver
  textures: Record<string, any>;           // world index texture routing table
  tileUnits: number;
  layerUnits: number;
  // The build's mesh-forward convention (world index coordinate_system),
  // the SAME value scene.ts uses to place every mesh instance: particle
  // placement must use it too, or systems land 180 degrees off their mesh.
  // Defaults to the scene.ts default so a caller that has not wired the
  // real value still gets a self-consistent frame.
  meshForwardQuarterTurns?: number;
  anisotropy?: number;
}

export class WorldEffectsLayer {
  root: THREE.Group;
  doc: WorldEffectsDoc;
  clock: EffectsClock;
  private _url: (rel: string) => string;
  private _textures: Record<string, any>;
  private _tileUnits: number;
  private _layerUnits: number;
  private _meshForwardQuarterTurns: number;
  private _anisotropy: number;
  private _systemsBySlot: Map<number, EffectSystem>;
  private _rooms = new Map<number, InstanceRec[]>();
  private _batches = new Map<string, Batch>();
  // texId -> draw metrics, recorded as emitters are added so a batch created
  // for that texId (and its texture) resolves the same sub-image and channel
  // layout. Metrics are a property of the container, so every emitter sharing
  // a texId agrees.
  private _draws = new Map<number, SpriteDraw>();
  private _textureCache = new Map<number, THREE.Texture>();
  // Refcounted by live BATCHES referencing a texId (0..2: at most an 'add'
  // and a 'mix' batch share one sprite). Deactivating the last batch for a
  // texId drops it into the cold LRU instead of disposing it immediately, so
  // a room that reactivates moments later (camera drifting near a boundary)
  // reuses the still-resident texture with no reload / pop.
  private _textureRefCount = new Map<number, number>();
  private _coldTextures: number[] = [];       // texIds with refcount 0, oldest first
  private readonly _coldTextureCap = 16;       // judge-mandated LRU cap (design 4.4)
  private _fallbackTexture: THREE.Texture | null = null;
  private _loader = new THREE.TextureLoader();
  private _camPos = new THREE.Vector3();
  private _camFwd = new THREE.Vector3();
  private _scratch = new THREE.Vector3();
  // Session edits, keyed by effectInstanceKey(): persists across addRoom/
  // removeRoom (single-room reload, merged proximity cycling) for the same
  // reason world/edits.js's WorldEdits persists across a merged re-bake.
  // Cleared only by dispose() or an explicit reset.
  private _instanceEdits = new Map<string, EffectInstanceEdit>();
  // Pickable-proxy geometry/materials: one tiny unit sphere baked to a
  // build-appropriate radius, one dim ("here's an effect") and one bright
  // ("hovered/pinned") material, shared by every proxy so swapping
  // `.material` is the whole highlight mechanic (see the picking note atop
  // this file).
  private _proxyGeometry: THREE.SphereGeometry;
  private _proxyMaterial: THREE.MeshBasicMaterial;
  private _proxyHighlightMaterial: THREE.MeshBasicMaterial;
  private _disposed = false;

  constructor({
    root, doc, url, textures, tileUnits, layerUnits,
    meshForwardQuarterTurns = DEFAULT_MESH_FORWARD_QUARTER_TURNS,
    anisotropy = 8,
  }: WorldEffectsLayerOptions) {
    this.root = root;
    this.doc = doc;
    this.clock = new EffectsClock(Number(doc?.tick_rate?.value));
    this._url = url;
    this._textures = textures || {};
    this._tileUnits = tileUnits;
    this._layerUnits = layerUnits;
    this._meshForwardQuarterTurns = meshForwardQuarterTurns;
    this._anisotropy = anisotropy;
    this._systemsBySlot = new Map((doc?.systems || []).map((s) => [s.slot, s]));
    this._proxyGeometry = new THREE.SphereGeometry(1, 6, 4);
    const proxyRadius = Math.max(12, tileUnits * 0.05);
    this._proxyGeometry.scale(proxyRadius, proxyRadius, proxyRadius);
    // FrontSide, not DoubleSide: a proxy is only ever seen from outside (the
    // camera is never inside a 12+-unit marker in practice), and three.js
    // renders a transparent DoubleSide object as TWO draw calls (back faces
    // then front faces, for correct self-transparency) -- doubling every
    // instance's cost for a difference nobody would see on a small
    // translucent dot. Batches stay DoubleSide (see their own comment): they
    // sit under the root's handedness-mirrored transform, which a proxy's
    // plain world-space position does not.
    this._proxyMaterial = new THREE.MeshBasicMaterial({
      color: 0x8fd6ff, transparent: true, opacity: 0.35,
      depthWrite: false, depthTest: true, side: THREE.FrontSide, toneMapped: false,
    });
    // Same yellow as world.ts's placement-pin highlight (0xffd84d): one
    // visual language for "this is what's currently selected" app-wide.
    this._proxyHighlightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd84d, transparent: true, opacity: 0.85,
      depthWrite: false, depthTest: true, side: THREE.FrontSide, toneMapped: false,
    });
  }

  /** Instantiate every effect system attached to a loaded room. `offset` is
   *  the room's display offset in native units (spawnRoomOffset).
   *  `loopOnly` (merged all-rooms): skip systems that are not looping. Timed
   *  systems (burst_windowed, one-shot) are meant to be triggered by a clip
   *  or an in-room spawn animation; the merged view has no such trigger, so
   *  including them would either sit permanently dark after their one-shot
   *  window passes or, worse, replay a stale burst every time proximity
   *  reactivates the room. Ambient (looping) systems are unaffected. */
  addRoom(roomId: number, offset: [number, number], opts: { loopOnly?: boolean } = {}): void {
    const id = Number(roomId);
    if (this._disposed || this._rooms.has(id)) return;
    const recs: InstanceRec[] = [];
    const seen = new Set<string>();
    for (const att of this.doc.attachments?.rooms || []) {
      if (Number(att.room) !== id) continue;
      // controller variants repeat (occurrence, system) pairs: one instance each
      const key = `${att.occurrence}|${att.system}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const system = this._systemsBySlot.get(Number(att.system));
      if (!system || !system.emitters.length) continue;
      if (opts.loopOnly && !system.loop) continue;
      const cell = Array.isArray(att.cell) ? att.cell : [0, 0, 0];
      // M_obj: EXACTLY the frame scene.ts places the owning mesh instance
      // in (composePlacementMatrix, shared with scene.ts's own
      // _placementMatrix so the two can never drift apart) -- owner-
      // dimensions centre pivot, occ.z, Rz(occ.rot + meshForward), optional
      // reflect, optional local matrix -- then the room's own display
      // offset (merged all-rooms view) composed on top. `center`/
      // `packedFlags`/`matrix` are absent on older docs (pre-v2
      // extraction), in which case this degrades to the tile-centre pivot
      // rotated by att.rot alone, same as the pre-v2 anchor.
      const center = Array.isArray(att.center) ? att.center : [Number(cell[0]) + 0.5, Number(cell[1]) + 0.5];
      const packedFlags = Number(att.packedFlags) || 0;
      const localMatrix = Array.isArray(att.matrix) && att.matrix.length === 12
        ? att.matrix.map(Number) : null;
      composePlacementMatrix(_scratchObj, {
        centerX: Number(center[0]), centerY: Number(center[1]),
        z: Number(cell[2]) || 0, quarterTurns: Number(att.rot) | 0,
        meshForwardQuarterTurns: this._meshForwardQuarterTurns,
        packedFlags, localMatrix,
        tileUnits: this._tileUnits, layerUnits: this._layerUnits,
      });
      _scratchObj.premultiply(_scratchOffset.makeTranslation(offset[0], offset[1], 0));
      const anchorOriginal = Float32Array.from(_scratchObj.elements);
      const anchor: Anchor = { m: Float32Array.from(anchorOriginal) };
      const recKey = effectInstanceKey(id, att.occurrence, att.system);
      const edit = this._editFor(recKey);
      const rec: InstanceRec = {
        key: recKey, system, anchor, anchorOriginal, edit, proxy: null, emitters: [],
      };
      // A persisted edit (surviving a prior instantiation of this SAME
      // instance) is folded back in immediately; a fresh/no-op edit leaves
      // `anchor.m` exactly the authored matrix, so an untouched instance
      // never runs the recompute at all.
      if (!isEffectEditNoop(edit)) this._applyAnchorEdit(rec);
      rec.proxy = this._createProxy(rec);
      this.root.add(rec.proxy);
      // Every emitter of a system draws in its owning mesh instance's frame,
      // with NO per-emitter offset.
      //
      // Emitters do carry an attachment field (doc `emitter.bone`), and it
      // used to be resolved against the owning rig's rest-world bone
      // translations and added here. That is wrong, and the way it fails is
      // instructive: within ONE system the emitters that carry the field got
      // shifted while their siblings stayed put, so a brazier's flame split
      // into a correct part sitting in its bowl and a second part metres
      // away. Authored effects are co-located by construction, so any rule
      // that separates one system's emitters is refuted by that alone.
      //
      // The field is a "$additional_transform" slot, not a rig bone index,
      // so indexing bone translations with it was reading an unrelated
      // table. It stays decoded in the doc as provenance for whenever the
      // additional-transform table itself is recovered; until then nothing
      // consumes it, and every emitter anchors at the mesh root.
      system.emitters.forEach((emitter, index) => {
        const sim = new EmitterSim(system, index, emitter, this.doc.configs || {}, this.clock.tickRate);
        const texId = emitter.sprite?.images?.length ? Number(emitter.sprite.images[0]) : -1;
        const blend = (emitter.blend || system.blend) === 'add' ? 'add' : 'mix';
        this._draws.set(texId, spriteDrawOf(emitter.sprite));
        rec.emitters.push({ sim, batchKey: `${texId}|${blend}`, boneOffset: [0, 0, 0] });
      });
      recs.push(rec);
    }
    this._rooms.set(id, recs);
    for (const rec of recs) {
      for (const { sim, batchKey, boneOffset } of rec.emitters) {
        this._batchFor(batchKey).members.push({ sim, anchor: rec.anchor, boneOffset, edit: rec.edit });
      }
    }
    this._rebalance();
  }

  removeRoom(roomId: number): void {
    const recs = this._rooms.get(Number(roomId));
    if (!recs) return;
    this._rooms.delete(Number(roomId));
    const gone = new Set<EmitterSim>();
    for (const rec of recs) {
      for (const { sim } of rec.emitters) gone.add(sim);
      // The edit record itself is NOT removed from _instanceEdits: it must
      // survive so a later addRoom() for this same key (room reload, merged
      // reactivation) picks the session edit back up.
      rec.proxy?.removeFromParent();
    }
    for (const [key, batch] of [...this._batches]) {
      batch.members = batch.members.filter((m) => !gone.has(m.sim));
      if (!batch.members.length) {
        this._disposeBatch(batch);
        this._batches.delete(key);
        // the batch (and therefore its sprite texture) is now unreferenced:
        // release it into the cold LRU rather than leaking it forever
        this._releaseTexture(batch.texId);
      }
    }
    this._rebalance();
  }

  /** Advance the clock by frame dt and refill the batches. */
  tick(dtMs: number, camera: THREE.Camera | null): void {
    if (this._disposed) return;
    this.clock.advance(dtMs);
    this._fill(camera);
  }

  /** Absolute seek; refills immediately so reads/screenshots see it. */
  setClock(ticks: number, camera: THREE.Camera | null = null): void {
    if (this._disposed) return;
    this.clock.setClock(ticks);
    // any seek is a discontinuity: rings rebuild in ensure() because the
    // jump exceeds the catch-up window or moves backwards; same-value seeks
    // are pure no-op refills (the determinism gate relies on that)
    this._fill(camera);
  }

  setRunning(on: boolean): void {
    this.clock.setRunning(on);
  }

  systemCount(): number {
    let n = 0;
    for (const recs of this._rooms.values()) n += recs.length;
    return n;
  }

  emitterCount(): number {
    let n = 0;
    for (const recs of this._rooms.values()) for (const rec of recs) n += rec.emitters.length;
    return n;
  }

  liveCount(): number {
    let n = 0;
    for (const batch of this._batches.values()) for (const m of batch.members) n += m.sim.alive;
    return n;
  }

  drawCount(): number {
    let n = 0;
    for (const batch of this._batches.values()) if (batch.count > 0) n++;
    return n;
  }

  /** Native-space anchor of the first instance matching a system slot or a
   *  recovered name fragment (camera-focus helper for tests/debugging). */
  findAnchor(nameOrSlot: number | string): { x: number; y: number; z: number } | null {
    const slot = Number(nameOrSlot);
    const text = typeof nameOrSlot === 'string' ? nameOrSlot : null;
    for (const recs of this._rooms.values()) {
      for (const rec of recs) {
        const bySlot = Number.isFinite(slot) && rec.system.slot === slot;
        const byName = text != null
          && rec.system.names.some((n) => n.name.includes(text));
        if (bySlot || byName) {
          const m = rec.anchor.m;
          return { x: m[12], y: m[13], z: m[14] };
        }
      }
    }
    return null;
  }

  /** Copies of the live regions of every batch's attribute arrays, keyed and
   *  sorted for stable comparison (the frozen-clock determinism gate). */
  snapshot(): { key: string; count: number; posSize: number[]; color: number[]; rot: number[] }[] {
    return [...this._batches.values()]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((batch) => ({
        key: batch.key,
        count: batch.count,
        posSize: Array.from(batch.posSize.subarray(0, batch.count * 4)),
        color: Array.from(batch.color.subarray(0, batch.count * 4)),
        rot: Array.from(batch.rot.subarray(0, batch.count)),
      }));
  }

  // ------------------------------------------------------- picking + edits

  /** Every currently-instantiated effect instance's pickable proxy, for a
   *  raycast pass (see the picking note atop this file). Recomputed on
   *  demand rather than cached: addRoom/removeRoom already own the
   *  authoritative live set, so caching would just be a second place for it
   *  to go stale. */
  pickables(): { object: THREE.Object3D; key: string }[] {
    const list: { object: THREE.Object3D; key: string }[] = [];
    for (const recs of this._rooms.values()) {
      for (const rec of recs) if (rec.proxy) list.push({ object: rec.proxy, key: rec.key });
    }
    return list;
  }

  /** Knobs + live snapshot of one instance (by effectInstanceKey), or null
   *  once its room is no longer loaded (single-room unload, or merged
   *  proximity deactivation) -- the null case tells a caller (world.ts's
   *  pinned-effect readout) to release a stale pin. */
  instanceInfo(key: string): {
    key: string; live: number; edit: EffectInstanceEdit;
    anchor: { x: number; y: number; z: number };
  } | null {
    const rec = this._findRec(key);
    if (!rec) return null;
    // A hidden instance draws zero particles by construction (_fill skips
    // it entirely, never calling sim.ensure()), but each sim's OWN ring
    // state is whatever it was when it was last advanced -- sim.alive does
    // NOT drop to zero on its own just because the instance stopped being
    // filled. Report the same zero _fill() actually draws rather than the
    // sim's stale last-advanced count.
    let live = 0;
    if (!rec.edit.hidden) {
      for (const { sim } of rec.emitters) live += sim.alive;
    }
    return {
      key: rec.key,
      live,
      edit: { ...rec.edit },
      anchor: { x: rec.anchor.m[12], y: rec.anchor.m[13], z: rec.anchor.m[14] },
    };
  }

  /** Swap a proxy between its dim and highlighted material (hover/pin). */
  setInstanceHighlighted(key: string, on: boolean): void {
    const rec = this._findRec(key);
    if (rec?.proxy) rec.proxy.material = on ? this._proxyHighlightMaterial : this._proxyMaterial;
  }

  /** Position nudge: offsets the instance's ANCHOR only. The sim keeps
   *  simulating in its own local frame regardless of where the anchor puts
   *  it, so this never touches any EmitterSim state -- only the anchor
   *  matrix _fill() transforms through. */
  nudgeInstance(key: string, axis: 'dx' | 'dy' | 'dz', delta: number): boolean {
    const rec = this._findRec(key);
    if (!rec || !Number.isFinite(delta)) return false;
    rec.edit[axis] += delta;
    this._applyAnchorEdit(rec);
    return true;
  }

  /** Multiplies the current per-instance scale factor (clamped so a runaway
   *  double-click can't shrink an effect to nothing or blow it up). */
  nudgeInstanceScale(key: string, factor: number): boolean {
    const rec = this._findRec(key);
    if (!rec || !(factor > 0)) return false;
    rec.edit.scaleMult = Math.min(20, Math.max(0.05, rec.edit.scaleMult * factor));
    return true;
  }

  /** Hide/show: a hidden instance's emitters are skipped entirely by
   *  _fill() (zero particles, zero per-frame cost), never disposed. */
  setInstanceHidden(key: string, hidden: boolean): boolean {
    const rec = this._findRec(key);
    if (!rec) return false;
    rec.edit.hidden = !!hidden;
    return true;
  }

  /** Pause/resume the instance's OWN effective clock, riding the shared
   *  EffectsClock (see the EffectInstanceEdit doc comment). Continuity is
   *  preserved across the toggle: pausing freezes at the instance's current
   *  effective time; resuming re-derives clockOffset so playback picks up
   *  from exactly that point as the shared clock keeps advancing. */
  setInstancePaused(key: string, paused: boolean): boolean {
    const rec = this._findRec(key);
    if (!rec) return false;
    const edit = rec.edit;
    const on = !!paused;
    if (on !== edit.paused) {
      if (on) edit.frozenT = this.clock.t + edit.clockOffset;
      else edit.clockOffset = edit.frozenT - this.clock.t;
      edit.paused = on;
    }
    return true;
  }

  /** Scrub the instance's effective time by deltaTicks, forward or back,
   *  whether it is currently running (shifts clockOffset) or paused (shifts
   *  the frozen point directly). */
  nudgeInstanceClock(key: string, deltaTicks: number): boolean {
    const rec = this._findRec(key);
    if (!rec || !Number.isFinite(deltaTicks)) return false;
    if (rec.edit.paused) rec.edit.frozenT += deltaTicks;
    else rec.edit.clockOffset += deltaTicks;
    return true;
  }

  /** Restore one instance to its authored position/scale/visibility/clock. */
  resetInstanceEdit(key: string): boolean {
    const edit = this._instanceEdits.get(key);
    if (!edit || isEffectEditNoop(edit)) return false;
    Object.assign(edit, defaultEffectEdit());
    const rec = this._findRec(key);
    if (rec) this._applyAnchorEdit(rec);
    return true;
  }

  /** Session-wide reset: folded into the panel's global "Reset edits" action
   *  alongside placement edits (world.ts wires this into resetAllEdits). */
  resetAllInstanceEdits(): void {
    for (const edit of this._instanceEdits.values()) Object.assign(edit, defaultEffectEdit());
    for (const recs of this._rooms.values()) for (const rec of recs) this._applyAnchorEdit(rec);
  }

  /** Count of instances carrying a non-noop edit, for the global "Reset
   *  edits (N)" tally (world.ts's syncEditsUi). */
  instanceEditCount(): number {
    let n = 0;
    for (const edit of this._instanceEdits.values()) if (!isEffectEditNoop(edit)) n++;
    return n;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const batch of this._batches.values()) this._disposeBatch(batch);
    this._batches.clear();
    // Every remaining proxy must leave the scene graph before its SHARED
    // geometry is disposed below, exactly like _disposeBatch() detaches each
    // batch mesh before disposing ITS geometry: a mesh left attached (and
    // still reachable by the render loop for the one more frame that
    // typically elapses before the caller also tears down `root`) makes the
    // renderer's WebGLGeometries silently RE-register the geometry on that
    // next render pass (dispose() only removes ITS OWN bookkeeping entry; a
    // still-rendered mesh triggers a fresh get() that just re-adds it) --
    // undoing the dispose() call below and leaking one geometry per instance
    // that had ever been on screen. This was the exact cause of a GL-memory
    // baseline regression caught in review.
    for (const recs of this._rooms.values()) {
      for (const rec of recs) rec.proxy?.removeFromParent();
    }
    this._rooms.clear();
    for (const texture of this._textureCache.values()) texture.dispose();
    this._textureCache.clear();
    this._textureRefCount.clear();
    this._coldTextures = [];
    this._fallbackTexture?.dispose();
    this._fallbackTexture = null;
    this._proxyGeometry.dispose();
    this._proxyMaterial.dispose();
    this._proxyHighlightMaterial.dispose();
    // Session edits end with the layer/session, never persisted (matches
    // world/edits.js's WorldEdits.clear() on view destroy).
    this._instanceEdits.clear();
  }

  // ------------------------------------------------------------- internals

  private _findRec(key: string): InstanceRec | null {
    for (const recs of this._rooms.values()) {
      for (const rec of recs) if (rec.key === key) return rec;
    }
    return null;
  }

  private _editFor(key: string): EffectInstanceEdit {
    let edit = this._instanceEdits.get(key);
    if (!edit) {
      edit = defaultEffectEdit();
      this._instanceEdits.set(key, edit);
    }
    return edit;
  }

  private _createProxy(rec: InstanceRec): THREE.Mesh {
    const proxy = new THREE.Mesh(this._proxyGeometry, this._proxyMaterial);
    proxy.name = `effects-pick-${rec.key}`;
    proxy.position.set(rec.anchor.m[12], rec.anchor.m[13], rec.anchor.m[14]);
    proxy.matrixAutoUpdate = true;
    proxy.userData.effectKey = rec.key;
    return proxy;
  }

  // Recompute `anchor.m` = T(edit.dx*tileUnits, edit.dy*tileUnits,
  // edit.dz*layerUnits) . anchorOriginal -- never accumulated, always fresh
  // off the authored matrix, exactly world/edits.js's editedMatrix without
  // the rotation term (an effect instance is never rotated by an edit).
  // Mutates `anchor.m`'s contents in place rather than replacing the array,
  // so every batch member/proxy sharing the SAME Anchor object (by
  // reference, see addRoom) picks up the change with no re-push.
  private _applyAnchorEdit(rec: InstanceRec): void {
    _scratchEditT.makeTranslation(
      rec.edit.dx * this._tileUnits, rec.edit.dy * this._tileUnits, rec.edit.dz * this._layerUnits,
    );
    _scratchEditM.fromArray(rec.anchorOriginal);
    _scratchEditT.multiply(_scratchEditM);
    rec.anchor.m.set(_scratchEditT.elements);
    rec.proxy?.position.set(rec.anchor.m[12], rec.anchor.m[13], rec.anchor.m[14]);
  }

  // Every emitter runs at FULL density, in both the single-room and merged
  // views. There is deliberately no per-view alive budget: thinning made an
  // effect's density depend on how much else happened to be loaded, so the
  // same brazier read full in its own room and sparse in the merged view.
  // What bounds cost instead is proximity activation (only nearby rooms are
  // instantiated at all) plus PER_EMITTER_CAP, which is the engine's own
  // per-emitter maximum rather than a display limit.
  private _rebalance(): void {
    for (const batch of this._batches.values()) {
      for (const m of batch.members) m.sim.setStride(1);
    }
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
      name: `effects-${key}`,
      vertexShader: BILLBOARD_VERTEX,
      fragmentShader: BILLBOARD_FRAGMENT,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...spriteUniforms(draw),
        map: { value: this._acquireTexture(texId) },
      },
      fog: true,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending,
      // The root mirrors world.root, whose matrix has a NEGATIVE determinant
      // (the handedness mirror), so three flips the front-face convention
      // for everything under it. Billboard corners are added in VIEW space
      // and never see that mirror, which would leave every quad back-face
      // culled under a FrontSide material: billboards must be double sided.
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
    mesh.name = `effects-batch-${key}`;
    mesh.frustumCulled = false;          // instances live in shader attributes
    mesh.renderOrder = EFFECTS_RENDER_ORDER;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    this.root.add(mesh);
    // the chain above is frozen: joining it needs one explicit compose so
    // the new mesh picks up the root's native-to-display transform
    mesh.updateMatrix();
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
    // replacing attributes re-uploads; dropping the old GL buffers needs the
    // geometry rebuilt, so swap wholesale (rare: only when capacity changes)
    batch.geometry.deleteAttribute('aPosSize');
    batch.geometry.deleteAttribute('aColor');
    batch.geometry.deleteAttribute('aRot');
    batch.geometry.setAttribute('aPosSize', batch.aPosSize);
    batch.geometry.setAttribute('aColor', batch.aColor);
    batch.geometry.setAttribute('aRot', batch.aRot);
    // the renderer caches its instance ceiling from the FIRST setup; drop it
    // so a capacity regrowth never silently clamps the draw
    delete (batch.geometry as any)._maxInstanceCount;
    batch.geometry.instanceCount = 0;
    batch.count = 0;
  }

  private _disposeBatch(batch: Batch): void {
    batch.mesh.removeFromParent();
    batch.geometry.dispose();
    batch.material.dispose();
  }

  // Sprite textures ride the standard decoded-image route
  // (images/<pad5>_e<k>.png) at the sub-image the doc resolved for this
  // container (effects-sprite.js): the drawable image is the LARGEST member
  // of the sprite's mip chain, never the container's first sub-image, which
  // is a thumbnail. Loading is async: batches draw with the built-in radial
  // fallback until the real sprite lands.
  private _textureFor(texId: number): THREE.Texture {
    if (!(texId >= 0)) return this._fallback();
    let texture = this._textureCache.get(texId);
    if (texture) return texture;
    const draw = this._draws.get(texId) ?? DEFAULT_SPRITE_DRAW;
    const sub = draw.sub;
    texture = this._fallback().clone();
    texture.needsUpdate = true;          // clones upload independently
    this._textureCache.set(texId, texture);
    this._loader.loadAsync(this._url(`images/${pad5(texId)}_e${sub}.png`))
      .then((loaded) => {
        if (this._disposed) { loaded.dispose(); return; }
        // The texture may have gone cold (or been evicted outright) while the
        // fetch was in flight, e.g. a merged-mode room deactivated moments
        // after activating. Only install it if it is still wanted: otherwise
        // this async resolution would silently resurrect an evicted entry
        // and defeat the eviction cap.
        if (!((this._textureRefCount.get(texId) || 0) > 0)) { loaded.dispose(); return; }
        loaded.colorSpace = spriteColorSpace(draw);
        loaded.anisotropy = this._anisotropy;
        const previous = this._textureCache.get(texId);
        this._textureCache.set(texId, loaded);
        for (const batch of this._batches.values()) {
          if (batch.texId === texId) {
            batch.material.uniforms.map.value = loaded;
          }
        }
        previous?.dispose();
      })
      .catch(() => { /* missing sprite image: the fallback keeps drawing */ });
    return texture;
  }

  // Acquire a sprite texture for a new batch: bumps its refcount and, if it
  // was sitting in the cold LRU (deactivated but not yet evicted), pulls it
  // back out so it survives. Fallback (-1) is shared/never refcounted.
  private _acquireTexture(texId: number): THREE.Texture {
    if (!(texId >= 0)) return this._fallback();
    this._textureRefCount.set(texId, (this._textureRefCount.get(texId) || 0) + 1);
    const coldIndex = this._coldTextures.indexOf(texId);
    if (coldIndex >= 0) this._coldTextures.splice(coldIndex, 1);
    return this._textureFor(texId);
  }

  // Release a texture when its last referencing batch is disposed: drops the
  // refcount and, once it hits zero, pushes the texId onto the cold LRU,
  // evicting (and disposing) the oldest cold entry beyond the cap. A texture
  // is only ever evicted from the cold list, so a texture a live batch is
  // using (refcount > 0) can never be evicted.
  private _releaseTexture(texId: number): void {
    if (!(texId >= 0)) return;
    const next = (this._textureRefCount.get(texId) || 0) - 1;
    if (next > 0) { this._textureRefCount.set(texId, next); return; }
    this._textureRefCount.delete(texId);
    this._coldTextures.push(texId);
    while (this._coldTextures.length > this._coldTextureCap) {
      const evictId = this._coldTextures.shift()!;
      const texture = this._textureCache.get(evictId);
      this._textureCache.delete(evictId);
      texture?.dispose();
    }
  }

  // Procedural radial soft dot (no DOM): used until sprites load and for
  // emitters that carry no image.
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

  // Per-frame scratch fill: evaluate the closed form per alive particle and
  // write sequentially into [0, alive). Positions are anchored (M_obj . bone
  // offset, see the Anchor comment above) here on the CPU so one batch
  // serves every instance.
  private _fill(camera: THREE.Camera | null): void {
    const T = this.clock.t;
    // Native -> display: the batch's own uSpriteSize supplies the sprite's
    // native dimensions, so the per-particle term is just the decoded scale
    // converted out of native units.
    const sizeScale = 1 / this._tileUnits;
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
        const { sim, anchor, boneOffset, edit } = member;
        // Session-edit hook, exact no-op when untouched: a hidden instance
        // contributes nothing; otherwise the instance's own effective time
        // (paused freeze or a running offset off the ONE shared clock,
        // see EffectInstanceEdit) stands in for the batch's shared T, and
        // its scale multiplier rides along with the decoded per-particle
        // scale. `edit.hidden` false / `paused` false / `clockOffset` 0 /
        // `scaleMult` 1 reduces this block byte-for-byte to the pre-edit
        // behaviour (Tm === T, factor === 1), which is what keeps the
        // frozen-clock determinism gate green for every instance nobody
        // touched.
        if (edit.hidden) continue;
        const Tm = edit.paused ? edit.frozenT : T + edit.clockOffset;
        const m = anchor.m;
        const [bx, by, bz] = boneOffset;
        sim.ensure(Tm);
        sim.evaluate(Tm, (x, y, z, scale, r, g, b, a, roll) => {
          if (idx >= cap) return;
          // M_obj . (bone offset + simulated position), inlined rather than
          // a helper returning a tuple: no per-particle allocation, since
          // this loop runs thousands of times a frame across a merged room
          // set.
          const lx = x + bx; const ly = y + by; const lz = z + bz;
          const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
          const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
          const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
          const at4 = idx * 4;
          posSize[at4] = wx;
          posSize[at4 + 1] = wy;
          posSize[at4 + 2] = wz;
          posSize[at4 + 3] = scale * sizeScale * edit.scaleMult;
          color[at4] = Math.round(clamp01(r) * 255);
          color[at4 + 1] = Math.round(clamp01(g) * 255);
          color[at4 + 2] = Math.round(clamp01(b) * 255);
          color[at4 + 3] = Math.round(clamp01(a) * 255);
          rot[idx] = roll;
          if (sortable) {
            this._scratch.set(wx, wy, wz).applyMatrix4(rootMatrix!);
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

  // Back-to-front reorder of a normal-blend batch (stable index sort, then
  // one permutation pass through copies of the live regions).
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

export default WorldEffectsLayer;
