// WorldScene: renders extracted world rooms (store.worldIndex() /
// store.worldRoom(id)) with instanced placement batches and exact transforms.
// Mesh geometry is the shared meshes payload (buildMeshGeometry); textures
// are the images-category PNGs routed by the world index's `textures` table
// (per texture: kind + albedo/normal/parameter SUB-IMAGE indices + alpha).

import * as THREE from '../../../vendor/three.module.js';
import {
  createGameWaterShared, createStyleUniforms, updateStyleUniforms, createGameWaterMaterial,
  type GameWaterShared, type GameWaterStyleUniforms,
} from './game-water.js';
import { buildMeshGeometry } from '../mesh-geometry.js';
import { idlePoseKey, skinVertices } from '../../extract/world/idle-poses.js';
import { applyPackedRecolor } from '../../recolor.js';
import { pad5 } from '../../ui.js';
import { b64f32, type AppStore } from '../../store.js';
import type { GameRoomSource, GameBatchSource } from './game-frame.js';
import { emissionKey } from './draw-order.js';

export const WORLD_CATEGORIES: readonly string[] = Object.freeze([
  'terrain', 'models', 'spawns', 'components',
]);
const OCCURRENCE_CATEGORIES: readonly string[] = Object.freeze([
  'terrain', 'models', 'components',
]);

export const CATEGORY_COLOURS: Readonly<Record<string, number>> = Object.freeze({
  terrain: 0x87926f,
  models: 0xb9c2cf,
  spawns: 0xd5b276,
  components: 0x93a2b3,
});

// Scratch matrices for the hot placement/spawn transform compositions:
// ~1.15M placements on an all-rooms load previously allocated fresh Matrix4s
// each. Both composers are synchronous end to end (no await between writing
// and multiplying a scratch into the caller's target), and multiply() copies
// the operand's elements immediately, so nothing ever aliases these.
const _scratchRotZ = new THREE.Matrix4();
const _scratchReflect = new THREE.Matrix4();
const _scratchLocal = new THREE.Matrix4();

// Pure placement-matrix composer: translate(centre * tileUnits, z *
// layerUnits) . rotateZ((quarterTurns + meshForwardQuarterTurns) * 90deg) .
// optional reflect(-1,1,1) . optional local 3x4 matrix. This is exactly the
// frame the room renderer places every mesh instance in (_placementMatrix
// below supplies its inputs from the live shard). Exported so any other
// consumer that must reproduce the SAME frame (world/effects-layer.ts
// particle placement) calls this instead of re-deriving the math: sharing
// the one implementation is what keeps them from drifting apart.
export function composePlacementMatrix(
  target: THREE.Matrix4,
  {
    centerX, centerY, z, quarterTurns, meshForwardQuarterTurns,
    packedFlags = 0, localMatrix = null, tileUnits, layerUnits,
    reflectionBaked = false,
  }: {
    centerX: number; centerY: number; z: number; quarterTurns: number;
    meshForwardQuarterTurns: number; packedFlags?: number;
    localMatrix?: number[] | null; tileUnits: number; layerUnits: number;
    reflectionBaked?: boolean;
  },
): THREE.Matrix4 {
  target.makeTranslation(
    centerX * tileUnits, centerY * tileUnits, z * layerUnits,
  );
  target.multiply(_scratchRotZ.makeRotationZ(
    ((quarterTurns & 3) + meshForwardQuarterTurns) * Math.PI / 2,
  ));
  if ((packedFlags & 0x4) !== 0) {
    target.multiply(_scratchReflect.makeScale(-1, 1, 1));
  }
  if (localMatrix) {
    if (localMatrix.length !== 12 || localMatrix.some((value) => !Number.isFinite(value))) {
      throw new Error('placement has invalid local matrix (expected 12 finite values)');
    }
    target.multiply(_scratchLocal.set(
      localMatrix[0], localMatrix[1], localMatrix[2], localMatrix[3],
      localMatrix[4], localMatrix[5], localMatrix[6], localMatrix[7],
      localMatrix[8], localMatrix[9], localMatrix[10], localMatrix[11],
      0, 0, 0, 1,
    ));
  }
  // Geometry already mirrored by F needs M*F as its instance matrix:
  // (M*F)*(F*v) = M*v. Removing an earlier reflection from M is invalid
  // when a component's local matrix includes translation, rotation or shear.
  return unbakeGeometryReflection(target, reflectionBaked);
}

/** Change between source-geometry and reflected-geometry matrix frames. */
export function unbakeGeometryReflection(target: THREE.Matrix4, reflected: boolean): THREE.Matrix4 {
  return reflected ? target.multiply(_scratchReflect.makeScale(-1, 1, 1)) : target;
}

// AB5 meshes face opposite the authored object-tree forward direction; the
// index coordinate_system carries the same constant. Exported so other
// consumers of the exact placement frame (world/effects-layer.ts particle
// placement) can default to it without duplicating the magic number.
export const DEFAULT_MESH_FORWARD_QUARTER_TURNS = 2;
// Spawned actors face 180° opposite the static mesh-forward convention.
const SPAWN_FACING_HALF_TURN = 2;

const REQUIRED_OCCURRENCE_COLUMNS = Object.freeze([
  'resource', 'x', 'y', 'z', 'rotation_quarters',
]);
const REQUIRED_PLACEMENT_COLUMNS = Object.freeze([
  'occurrence', 'mesh', 'material', 'texture', 'render_texture', 'flags',
  'matrix', 'recolor',
]);
const REQUIRED_LINK_COLUMNS = Object.freeze([
  'occurrence', 'direction', 'target_occurrence',
]);
const REQUIRED_COLLISION_COLUMNS = Object.freeze([
  'x', 'y', 'width', 'height', 'z_min', 'z_max', 'flags',
]);
const REQUIRED_SPAWN_COLUMNS = Object.freeze([
  'record', 'room_record', 'x', 'y', 'z', 'rotation_quarters',
  'direction_resource', 'label',
]);
const REQUIRED_SPAWN_PART_COLUMNS = Object.freeze([
  'spawn', 'mesh', 'material', 'texture', 'render_texture', 'flags',
  'recolor', 'part_index',
]);
const REQUIRED_SPAWN_MEMBERSHIP_COLUMNS = Object.freeze([
  'spawn', 'kind', 'field_op', 'series_index', 'leaf_index',
]);

/** Column-name -> row index map for one world-index table (optional columns
 *  are simply absent: reads yield undefined, exactly as the lookups expect). */
export type ColumnMap = Readonly<Record<string, number>>;

/** Editor gizmos: free-standing placements whose material is authored empty
 *  (effect direction arrows, sound, dig and combat markers) draw as solid
 *  flat shapes in one marker colour; authored-empty ground keeps a faint
 *  wireframe in its category colour. */
export const GIZMO_SWATCH = '#e05ad0';
export function gizmoMaterial(category: string): THREE.Material {
  if (category === 'terrain') {
    return new THREE.MeshBasicMaterial({ color: CATEGORY_COLOURS.terrain, wireframe: true, transparent: true, opacity: 0.24, depthWrite: false });
  }
  return new THREE.MeshBasicMaterial({ color: GIZMO_SWATCH, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
}

export interface WorldPlacementFlags {
  authoredEmpty: number;
  alpha: number;
  skinned: number;
  localMatrix: number;
  textureFallback: number;
  component: number;
  unrenderable: number;
  uniformLuminanceTint: number;
}

export interface WorldTextureSet {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  meta: any;
}

/** One retained room's graph + bookkeeping (this.rooms values). */
export interface WorldSceneRoom {
  id: number;
  meta: any;
  shard: any;
  worldRoom: any;
  origin: { x: number; y: number };
  group: THREE.Group;
  categoryGroups: Record<string, THREE.Group>;
  collisionGroup: THREE.Group;
  collisionMesh: THREE.InstancedMesh | null;
  batchCount: number;
  meshes: THREE.InstancedMesh[];
}

interface WorldBatchEntry {
  row: any;
  placementIndex: number;
  sourceKind: string;
}

interface WorldBatch {
  key: string;
  category: string;
  sourceKind: string;
  mesh: any;
  material: any;
  texture: any;
  renderTexture: any;
  flags: number;
  recolorIndex: number;
  recolors: number[][] | null;
  z: any;
  reflectLocalX: boolean;
  depthRank: number;
  /** spawn batches: the AB1 clip the actor rests in (-1 = bind pose) */
  idleClip: number;
  entries: WorldBatchEntry[];
}

export interface WorldSceneOptions {
  scene: THREE.Scene;
  store: AppStore;
  getWorldRoom?: ((roomId: number, meta: any, shard: any) => any) | null;
  origin?: any;
  onChange?: (() => void) | null;
  onStatus?: ((detail: any) => void) | null;
  textureAnisotropy?: number;
  assetConcurrency?: number;
  showAuthoredEmpty?: boolean;
  showCollision?: boolean;
  showUntextured?: boolean;
  categoryVisibility?: Record<string, boolean>;
}

function columns(names: any, required: readonly string[], label: string): ColumnMap {
  if (!Array.isArray(names)) throw new Error(`world index has no ${label} columns`);
  const result: Record<string, number> = Object.fromEntries(
    names.map((name, index) => [name, index]),
  );
  const missing = required.filter((name) => result[name] === undefined);
  if (missing.length) throw new Error(`world ${label} columns missing: ${missing.join(', ')}`);
  return Object.freeze(result);
}

function finite(value: any, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalFinite(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Room content renders at its RAW room-local coordinates: occurrences,
// spawns, collision and the door/exit tiles all share one frame anchored at
// the map-rect origin, with the map_size padding lying entirely beyond the
// content. The shard's stored map_offset (a centred-crop guess) must NOT be
// applied for display: doing so displaced every cropped room by half its
// margin (1 to 5 tiles) against the door-graph stitch, which is exactly the
// all-rooms door misalignment. Evidence: with a zero offset 1032/1034 exit
// tiles land on occupied content tiles across the corpus; the centred offset
// mis-anchors all 115 margin rooms.

function normalizeOrigin(value: any): { x: number; y: number } {
  if (Array.isArray(value)) return { x: finite(value[0]), y: finite(value[1]) };
  if (!value || typeof value !== 'object') return { x: 0, y: 0 };
  return {
    x: finite(value.x ?? value.ox),
    y: finite(value.y ?? value.z ?? value.oz),
  };
}

function placementRecolors(shard: any, index: any, label: string): number[][] | null {
  const value = Number(index);
  if (!Number.isInteger(value) || value < 0) return null;
  const colors = shard.recolors?.[value];
  if (!Array.isArray(colors) || ![2, 3].includes(colors.length)
      || colors.some(color => !Array.isArray(color)
        || color.length < 3 || color.some((component: any) => !Number.isFinite(Number(component))))) {
    throw new Error(`${label} has invalid recolor tuple ${index}`);
  }
  return colors.map(color => color.map(Number));
}

async function eachLimit<T>(
  items: T[],
  limit: number,
  callback: (item: T, index: number) => Promise<void> | void,
): Promise<void> {
  let cursor = 0;
  let failure: any = null;
  async function worker() {
    while (failure === null) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await callback(items[index], index);
      } catch (error) {
        failure = error;
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, limit), Math.max(1, items.length)) },
    worker,
  ));
  if (failure !== null) throw failure;
}

// Yield the main thread between work slices WITHOUT the setTimeout nesting
// clamp: chained zero-timers are clamped to ~4ms each after a few levels, a
// real tax on bakes/releases sliced at 15 to 24ms. A MessageChannel macrotask
// yields just as well (input and rendering still interleave between slices)
// but resumes immediately. Lazy setup so non-browser imports never open a port.
let _yieldPort: MessagePort | null = null;
let _yieldWaiters: (() => void)[] = [];
export function yieldToBrowser(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!_yieldPort) {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const waiters = _yieldWaiters;
      _yieldWaiters = [];
      for (const resolve of waiters) resolve();
    };
    _yieldPort = channel.port2;
  }
  return new Promise((resolve) => {
    _yieldWaiters.push(resolve);
    _yieldPort!.postMessage(0);
  });
}

function cachedPromise<V>(
  cache: Map<any, Promise<V>>,
  key: any,
  factory: () => V | Promise<V>,
): Promise<V> {
  if (cache.has(key)) return cache.get(key)!;
  const promise = Promise.resolve().then(factory).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, promise);
  return promise;
}

/** Upload an authored mip chain as-is (three.js default trilinear filtering). */
function authoredMips<T extends THREE.Texture>(texture: T, mipmaps: any[], colorSpace: THREE.ColorSpace): T {
  texture.mipmaps = mipmaps;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
}

function disposeRoomGroup(group: THREE.Group): void {
  group.traverse((object: any) => {
    if (object.isInstancedMesh) object.dispose();
    // water materials are per room
    object.userData?.gameWater?.water?.dispose?.();
  });
  group.clear();
}

/**
 * Load a room set, then retry only transient failures after the high-pressure
 * initial pass has settled. Used by the all-rooms view; failed shard/asset
 * promises are evicted, so a retry is safe without disturbing rooms already
 * retained.
 */
export async function loadRoomsWithRetry(world: WorldScene, roomIds: Iterable<number | string>, {
  concurrency = 3,
  retries = 0,
  retryConcurrency = 1,
  onProgress = null,
  onRetry = null,
}: {
  concurrency?: number;
  retries?: number;
  retryConcurrency?: number;
  onProgress?: ((progress: any) => void) | null;
  onRetry?: ((detail: any) => void) | null;
} = {}): Promise<WorldSceneRoom[]> {
  const ids = [...new Set([...roomIds].map(Number))];
  const requested = new Set(ids);
  const retryLimit = Math.max(0, finite(retries, 0) | 0);
  let pending = ids;
  let attempt = 0;

  while (pending.length) {
    if (world.disposed) break;   // view destroyed mid-stream: stop immediately
    const completedBefore = ids.length - pending.length;
    try {
      await world.loadRooms(pending, {
        concurrency: Math.max(1, (attempt === 0 ? concurrency : retryConcurrency) | 0),
        onProgress: progress => {
          if (typeof onProgress !== 'function') return;
          let retained = 0;
          for (const id of ids) if (world.rooms.has(id)) retained++;
          try {
            onProgress({
              ...progress,
              attempt,
              total: ids.length,
              completed: Math.min(ids.length, completedBefore + progress.completed),
              loaded: retained,
            });
          } catch { /* host callback */ }
        },
      });
      pending = [];
    } catch (error: any) {
      if (world.disposed) break;
      const failures = Array.isArray(error?.failures) ? error.failures : null;
      if (!failures || attempt >= retryLimit) throw error;
      const failed = [...new Set<number>(failures.map((entry: any) => Number(entry?.room)))]
        .filter(id => requested.has(id) && !world.rooms?.has?.(id));
      if (!failed.length) throw error;
      attempt++;
      pending = failed;
      if (typeof onRetry === 'function') {
        try { onRetry({ attempt, retries: retryLimit, rooms: [...pending], error }); } catch { /* host */ }
      }
    }
  }
  return ids.map(id => world.rooms.get(id)).filter(Boolean) as WorldSceneRoom[];
}

/**
 * Progressively load extracted rooms into a Three.js scene.
 *
 * `getWorldRoom(roomId, meta, shard)` supplies each room's stitched world
 * placement ({x, y} in tiles); omitted → rooms render at the origin. `origin`
 * is a global {x, y} tile offset (or a callback).
 */
export class WorldScene {
  store: AppStore;
  scene: THREE.Scene;
  getWorldRoom: ((roomId: number, meta: any, shard: any) => any) | null;
  /** Optional shard override (bulk-prefetched maps); null -> store.worldRoom. */
  shardSource: ((roomId: number) => any) | null;
  origin: any;
  onChange: () => void;
  onStatus: (detail: any) => void;
  textureLoader: THREE.TextureLoader;
  textureAnisotropy: number;
  assetConcurrency: number;
  showAuthoredEmpty: boolean;
  showCollision: boolean;
  showUntextured: boolean;
  defaultZVisible: boolean;
  meshForwardQuarterTurns: number;
  roomYSign: number;
  zVisibility: Map<number, boolean>;
  categoryVisibility: Record<string, boolean>;
  index: any;
  rooms: Map<number, WorldSceneRoom>;
  disposed: boolean;
  root: THREE.Group;
  _generation: number;
  _onlyRoomId: number | null;
  _indexPromise: Promise<any> | null;
  _roomMeta: Map<number, any>;
  _roomPromises: Map<number, {
    generation: number;
    roomGeneration: number;
    promise: Promise<WorldSceneRoom | null> | null;
  }>;
  _roomGenerations: Map<number, number>;
  _geometryPromises: Map<string, Promise<THREE.BufferGeometry>>;
  _idlePosesPromise: Promise<any> | null;
  _texturePromises: Map<any, Promise<WorldTextureSet>>;
  _parameterPromises: Map<any, Promise<THREE.Texture | null>>;
  _materialPromises: Map<string, Promise<THREE.Material>>;
  _structuralAnchorCache: WeakMap<object, Map<number, any>>;
  /** Uniforms shared by the game-water materials (lights, frames). */
  gameWater: GameWaterShared;
  /** Water drawn with the game's surface and curtain materials (else plain). */
  gameWaterEnabled: boolean;
  gameShading = false;
  _waterStyles: Map<number, GameWaterStyleUniforms>;
  _waterTexturePromises: Map<string, Promise<any>>;
  _collisionGeometry: THREE.BoxGeometry;
  _collisionMaterial: THREE.MeshBasicMaterial;
  // filled by init() from the world index
  declare occurrenceColumns: ColumnMap;
  declare placementColumns: ColumnMap;
  declare linkColumns: ColumnMap | null;
  declare collisionColumns: ColumnMap;
  declare spawnColumns: ColumnMap | null;
  declare spawnPartColumns: ColumnMap | null;
  declare spawnMembershipColumns: ColumnMap | null;
  declare flags: WorldPlacementFlags;
  declare tileUnits: number;
  declare layerUnits: number;

  constructor({
    scene,
    store,
    getWorldRoom = null,
    origin = null,
    onChange = null,
    onStatus = null,
    textureAnisotropy = 8,
    assetConcurrency = 8,
    showAuthoredEmpty = false,
    showCollision = false,
    showUntextured = true,
    categoryVisibility = {},
  }: WorldSceneOptions = {} as WorldSceneOptions) {
    if (!scene?.add || !scene?.remove) throw new TypeError('WorldScene requires a Three.js scene');
    if (!store?.worldIndex) throw new TypeError('WorldScene requires a world-capable store');

    this.store = store;
    this.scene = scene;
    this.getWorldRoom = getWorldRoom;
    this.shardSource = null;   // hosts may install a bulk-prefetch seam
    this.origin = origin;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.textureLoader = new THREE.TextureLoader();
    this.textureAnisotropy = Math.max(1, finite(textureAnisotropy, 8));
    this.assetConcurrency = Math.max(1, finite(assetConcurrency, 8) | 0);
    this.showAuthoredEmpty = !!showAuthoredEmpty;
    this.showCollision = !!showCollision;
    this.showUntextured = showUntextured !== false;
    this.defaultZVisible = true;
    this.meshForwardQuarterTurns = DEFAULT_MESH_FORWARD_QUARTER_TURNS;
    this.roomYSign = 1;
    this.zVisibility = new Map();
    this.categoryVisibility = Object.fromEntries(WORLD_CATEGORIES.map((category) => [
      category, categoryVisibility[category] !== false,
    ]));

    this.index = null;
    this.rooms = new Map();
    this.disposed = false;
    this._generation = 0;
    this._onlyRoomId = null;
    this._indexPromise = null;
    this._roomMeta = new Map();
    this._roomPromises = new Map();
    this._roomGenerations = new Map();
    this._geometryPromises = new Map();
    this._idlePosesPromise = null;
    this._texturePromises = new Map();
    this._parameterPromises = new Map();
    this._materialPromises = new Map();
    this._structuralAnchorCache = new WeakMap();
    this.gameWater = createGameWaterShared();
    this.gameWaterEnabled = true;
    this._waterStyles = new Map();
    this._waterTexturePromises = new Map();

    this._collisionGeometry = new THREE.BoxGeometry(1, 1, 1);
    this._collisionMaterial = new THREE.MeshBasicMaterial({
      color: 0x65c9e8, wireframe: true, transparent: true,
      opacity: 0.32, depthWrite: false,
    });

    this.root = new THREE.Group();
    this.root.name = 'world-rooms';
    // Game meshes are Z-up with the opposite handedness to Three.js. The
    // negative local-Y scale preserves authored room row order while mapping
    // game (x,y,z) -> three (x,z,y); it wraps positions and geometry together.
    this.root.rotation.x = -Math.PI / 2;
    this.root.scale.set(1 / 1024, -1 / 1024, 1 / 1024);
    // Static except init()'s exact-units rescale (which calls updateMatrix):
    // frozen so the world graph never re-composes its root per frame.
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    this.scene.add(this.root);
  }

  _assertUsable(): void {
    if (this.disposed) throw new Error('WorldScene is disposed');
  }

  _emit(state: string, detail: any = {}): void {
    try { this.onStatus({ ...detail, state }); } catch { /* host callback */ }
    try { this.onChange(); } catch { /* host callback */ }
  }

  async init(): Promise<any> {
    this._assertUsable();
    if (this.index) return this.index;
    if (!this._indexPromise) {
      this._indexPromise = Promise.resolve(this.store.worldIndex()).then((index) => {
        if (!index) throw new Error('no world data stored for this version');
        if (![1, 2].includes(index?.schema)) {
          throw new Error(`unsupported world index schema ${index?.schema}`);
        }
        this.occurrenceColumns = columns(
          index.columns?.occurrence, REQUIRED_OCCURRENCE_COLUMNS, 'occurrence',
        );
        this.placementColumns = columns(
          index.columns?.placement, REQUIRED_PLACEMENT_COLUMNS, 'placement',
        );
        this.linkColumns = Array.isArray(index.columns?.link)
          ? columns(index.columns.link, REQUIRED_LINK_COLUMNS, 'link')
          : null;
        this.collisionColumns = columns(
          index.columns?.collision, REQUIRED_COLLISION_COLUMNS, 'collision',
        );
        if (index.schema >= 2) {
          this.spawnColumns = columns(index.columns?.spawn, REQUIRED_SPAWN_COLUMNS, 'spawn');
          this.spawnPartColumns = columns(
            index.columns?.spawn_part, REQUIRED_SPAWN_PART_COLUMNS, 'spawn part',
          );
          this.spawnMembershipColumns = columns(
            index.columns?.spawn_membership,
            REQUIRED_SPAWN_MEMBERSHIP_COLUMNS,
            'spawn membership',
          );
        } else {
          this.spawnColumns = null;
          this.spawnPartColumns = null;
          this.spawnMembershipColumns = null;
        }
        this.flags = Object.freeze({
          authoredEmpty: index.enums?.placement_flags?.authored_empty ?? 1,
          alpha: index.enums?.placement_flags?.alpha ?? 2,
          skinned: index.enums?.placement_flags?.skinned ?? 4,
          localMatrix: index.enums?.placement_flags?.local_matrix ?? 8,
          textureFallback: index.enums?.placement_flags?.texture_fallback ?? 16,
          component: index.enums?.placement_flags?.component ?? 32,
          unrenderable: index.enums?.placement_flags?.unrenderable_texture ?? 64,
          uniformLuminanceTint:
            index.enums?.placement_flags?.uniform_luminance_tint ?? 128,
        });
        this.tileUnits = finite(index.coordinate_system?.tile_units, 1024);
        this.layerUnits = finite(index.coordinate_system?.layer_units, 512);
        this.meshForwardQuarterTurns = finite(
          index.coordinate_system?.mesh_forward_quarter_turns,
          DEFAULT_MESH_FORWARD_QUARTER_TURNS,
        ) & 3;
        this.roomYSign = finite(index.coordinate_system?.room_y_sign, 1) < 0 ? -1 : 1;
        if (this.tileUnits <= 0 || this.layerUnits <= 0) {
          throw new Error('world index has invalid coordinate units');
        }
        this.root.scale.set(
          1 / this.tileUnits,
          -this.roomYSign / this.tileUnits,
          1 / this.tileUnits,
        );
        this.root.updateMatrix();   // root is frozen (matrixAutoUpdate=false)
        this._roomMeta = new Map(
          (index.rooms || []).map((room: any): [number, any] => [Number(room.id), room]),
        );
        this.index = index;
        this._emit('ready', { index, rooms: this._roomMeta.size });
        return index;
      }).catch((error) => {
        this._indexPromise = null;
        throw error;
      });
    }
    return this._indexPromise;
  }

  roomMeta(roomId: number | string): any {
    return this._roomMeta.get(Number(roomId)) || null;
  }

  /** The routing entry for one ab3 texture container (or null). */
  textureMeta(textureId: number | string): any {
    return this.index?.textures?.[String(textureId)] || null;
  }

  async _roomShard(meta: any): Promise<any> {
    const shard = await (this.shardSource
      ? this.shardSource(Number(meta.id))
      : this.store.worldRoom(meta.id));
    if (!shard) throw new Error(`room ${meta.id} is not stored: re-extract the World category`);
    if (shard.schema !== this.index.schema || Number(shard.room) !== Number(meta.id)) {
      throw new Error(`room ${meta.id} shard does not match the world index`);
    }
    if (!Array.isArray(shard.occurrences) || !shard.placements) {
      throw new Error(`room ${meta.id} shard is incomplete`);
    }
    if (this.index.schema >= 2 && (
      !Array.isArray(shard.spawns)
      || !Array.isArray(shard.spawn_parts)
      || !Array.isArray(shard.spawn_memberships)
    )) {
      throw new Error(`room ${meta.id} shard has no gameplay spawn tables`);
    }
    return shard;
  }

  async _resolveWorldRoom(roomId: number, meta: any, shard: any): Promise<any> {
    if (this.getWorldRoom) {
      const room = await this.getWorldRoom(roomId, meta, shard);
      if (!room) throw new Error(`room ${roomId} has no world placement`);
      return room;
    }
    return { id: roomId, x: 0, y: 0 };
  }

  async _resolveOrigin(roomId: number, meta: any, shard: any, worldRoom: any): Promise<{ x: number; y: number }> {
    const value = typeof this.origin === 'function'
      ? await this.origin(roomId, meta, shard, worldRoom)
      : this.origin;
    return normalizeOrigin(value);
  }

  _roomGeneration(roomId: number | string): number {
    return this._roomGenerations.get(Number(roomId)) || 0;
  }

  _roomLoadActive(roomId: number, generation: number, roomGeneration: number): boolean {
    return !this.disposed
      && generation === this._generation
      && roomGeneration === this._roomGeneration(roomId);
  }

  /** The frame-0 skin palettes World extraction wrote ('world:idle-poses'),
   *  or null: an older extraction, or one without the clips to pose from. */
  _idlePoses(): Promise<any> {
    if (!this._idlePosesPromise) {
      this._idlePosesPromise = Promise.resolve(this.store.worldIdlePoses?.() ?? null)
        .then((doc) => (doc && typeof doc.poses === 'object' ? doc : null))
        .catch(() => null);
    }
    return this._idlePosesPromise;
  }

  /** A batch's geometry: a rigged spawn resting in a clip is posed at that
   *  clip's first frame when its palette is known, else the bind pose. */
  _batchGeometry(batch: { mesh: any; reflectLocalX?: boolean; idleClip?: number; sourceKind?: string }): Promise<THREE.BufferGeometry> {
    if (batch.sourceKind === 'spawn' && Number.isInteger(batch.idleClip) && batch.idleClip! >= 0) {
      return this._posedGeometry(batch.mesh, batch.idleClip!);
    }
    return this._meshGeometry(batch.mesh, !!batch.reflectLocalX);
  }

  /** The mesh skinned into the first frame of `clip` (a separate cached
   *  geometry per mesh and clip); the bind-pose geometry when the mesh is
   *  not skinned or the palette is missing. Never throws for a missing pose. */
  _posedGeometry(meshId: number | string, clip: number): Promise<THREE.BufferGeometry> {
    const cacheKey = `${meshId}:idle${clip}`;
    return cachedPromise(this._geometryPromises, cacheKey, async () => {
      if (this.disposed) throw new Error('WorldScene is disposed');
      const base = await this._meshGeometry(meshId, false);
      const skinIndex = base.getAttribute('skinIndex');
      const skinWeight = base.getAttribute('skinWeight');
      if (!skinIndex || !skinWeight) return base;
      const payload = await this.store.payload(`meshes/${pad5(meshId)}.json`);
      const rig = Number(payload?.skel);
      const doc = await this._idlePoses();
      const pose = rig >= 0 ? doc?.poses?.[idlePoseKey(rig, clip)] : null;
      if (!pose?.m) return base;
      let palette: Float32Array;
      try { palette = b64f32(pose.m); } catch { return base; }
      if (palette.length !== Number(pose.bones) * 12 || !palette.length) return base;
      const geo = base.clone();
      const positions = geo.getAttribute('position');
      const normals = geo.getAttribute('normal');
      const tangents = geo.getAttribute('tangent');
      skinVertices(palette, skinIndex.array as any, skinWeight.array as any,
        positions.array as Float32Array, normals ? normals.array as Float32Array : null,
        tangents ? tangents.array as Float32Array : null);
      positions.needsUpdate = true;
      if (normals) normals.needsUpdate = true;
      if (tangents) tangents.needsUpdate = true;
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      if (this.disposed) {
        geo.dispose();
        throw new Error('WorldScene was disposed while posing a mesh');
      }
      return geo;
    });
  }

  _meshGeometry(meshId: number | string, reflectLocalX = false): Promise<THREE.BufferGeometry> {
    const cacheKey = `${meshId}:${reflectLocalX ? 1 : 0}`;
    return cachedPromise(this._geometryPromises, cacheKey, async () => {
      // Abort BEFORE starting new work: dispose() only sweeps promises that
      // already exist, so a post-dispose factory must never fetch or allocate.
      if (this.disposed) throw new Error('WorldScene is disposed');
      if (reflectLocalX) {
        // Three.js InstancedMesh does not support negative-determinant
        // instance transforms. Bake the native reflection into a separate
        // geometry batch and restore its front faces + tangent handedness.
        const geo = (await this._meshGeometry(meshId, false)).clone();
        for (const name of ['position', 'normal', 'tangent']) {
          const attribute = geo.getAttribute(name);
          if (!attribute) continue;
          for (let index = 0; index < attribute.count; index++) {
            attribute.setX(index, -attribute.getX(index));
            if (name === 'tangent') attribute.setW(index, -attribute.getW(index));
          }
          attribute.needsUpdate = true;
        }
        const indices = geo.getIndex();
        if (indices) {
          for (let index = 0; index < indices.count; index += 3) {
            const second = indices.getX(index + 1);
            indices.setX(index + 1, indices.getX(index + 2));
            indices.setX(index + 2, second);
          }
          indices.needsUpdate = true;
        }
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        if (this.disposed) {
          geo.dispose();
          throw new Error('WorldScene was disposed while reflecting a mesh');
        }
        return geo;
      }
      const payload = await this.store.payload(`meshes/${pad5(meshId)}.json`);
      if (Number(payload.i) !== Number(meshId)) throw new Error(`mesh ${meshId} payload id mismatch`);
      // no bone-influence vertex colors: world materials never enable them
      const { geo } = buildMeshGeometry(payload, { boneColors: false });
      // buildMeshGeometry handles the DirectX V flip before this room-level
      // handedness reflection. Mirror tangent W so normal maps retain the
      // same bitangent basis as the source renderer.
      const tangents = geo.getAttribute('tangent');
      if (tangents && this.roomYSign > 0) {
        for (let index = 0; index < tangents.count; index++) {
          tangents.setW(index, -tangents.getW(index));
        }
        tangents.needsUpdate = true;
      }
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      if (this.disposed) {
        geo.dispose();
        throw new Error('WorldScene was disposed while loading a mesh');
      }
      return geo;
    });
  }

  _textureUrl(textureId: number | string, subImage: number): string {
    return this.store.url(`images/${pad5(textureId)}_e${subImage}.png`);
  }

  _loadTexture(textureId: number | string, subImage: number, colorSpace: THREE.ColorSpace): Promise<THREE.Texture> {
    return this.textureLoader.loadAsync(this._textureUrl(textureId, subImage))
      .then((texture) => {
        texture.colorSpace = colorSpace;
        texture.anisotropy = this.textureAnisotropy;
        return texture;
      });
  }

  _textureSet(textureId: number | string): Promise<WorldTextureSet> {
    return cachedPromise(this._texturePromises, textureId, async () => {
      if (this.disposed) throw new Error('WorldScene is disposed');
      const meta = this.textureMeta(textureId);
      if (!meta || meta.kind !== 'image' || meta.albedo == null) {
        throw new Error(`world texture ${textureId} has no albedo image`);
      }
      const map = await this._loadTexture(textureId, meta.albedo, THREE.SRGBColorSpace);
      let normalMap: THREE.Texture | null = null;
      try {
        if (meta.normal != null) {
          normalMap = await this._loadTexture(textureId, meta.normal, THREE.NoColorSpace);
        }
      } catch (error) {
        map.dispose();
        throw error;
      }
      if (this.disposed) {
        map.dispose();
        normalMap?.dispose();
        throw new Error('WorldScene was disposed while loading a texture');
      }
      return { map, normalMap, meta };
    });
  }

  _parameterMap(textureId: number | string): Promise<THREE.Texture | null> {
    return cachedPromise(this._parameterPromises, textureId, async () => {
      if (this.disposed) throw new Error('WorldScene is disposed');
      const meta = this.textureMeta(textureId);
      if (!meta || meta.parameter == null) return null;
      const map = await this._loadTexture(textureId, meta.parameter, THREE.NoColorSpace);
      if (this.disposed) {
        map.dispose();
        throw new Error('WorldScene was disposed while loading a parameter map');
      }
      return map;
    });
  }

  /** Public texture access for sibling renderers (merged world, water). */
  textureSet(textureId: number | string): Promise<WorldTextureSet> {
    return this._textureSet(textureId);
  }

  parameterMap(textureId: number | string): Promise<THREE.Texture | null> {
    return this._parameterMap(textureId);
  }

  _material(
    category: string,
    materialId: any,
    renderTexture: number,
    flags: number,
    recolors: number[][] | null,
    depthRank = 0,
  ): Promise<THREE.Material> {
    const depthOffset = { polygonOffset: depthRank > 0, polygonOffsetFactor: 0, polygonOffsetUnits: depthRank };
    const authoredEmpty = !!(flags & this.flags.authoredEmpty);
    const unrenderable = !!(flags & this.flags.unrenderable);
    const alpha = !!(flags & this.flags.alpha);
    const uniformLuminanceTint = !!(flags & this.flags.uniformLuminanceTint);
    const key = JSON.stringify([
      category, materialId, renderTexture, authoredEmpty ? 1 : 0,
      unrenderable ? 1 : 0, alpha ? 1 : 0,
      uniformLuminanceTint ? 1 : 0, recolors, depthRank,
    ]);
    return cachedPromise(this._materialPromises, key, async () => {
      if (this.disposed) throw new Error('WorldScene is disposed');
      if (authoredEmpty) return gizmoMaterial(category);
      if (renderTexture < 0) {
        // Native meshes author reverse faces where required. Rendering those
        // triangles again as DoubleSide flips their lighting normal and makes
        // foliage cards alternate between textured and black faces.
        const material = new THREE.MeshStandardMaterial({
          ...depthOffset, color: CATEGORY_COLOURS[category], metalness: 0.02, roughness: 0.88,
          side: THREE.FrontSide,
        });
        if (recolors) applyPackedRecolor(material, null, recolors);
        return material;
      }
      const [textures, parameterMap] = await Promise.all([
        this._textureSet(renderTexture),
        recolors ? this._parameterMap(renderTexture) : null,
      ]);
      const material = new THREE.MeshStandardMaterial({
        // Preserve authored face ownership; two-sided foliage already carries
        // explicit opposite-winding triangles with its intended normals.
        ...depthOffset, color: 0xffffff, map: textures.map, normalMap: textures.normalMap,
        metalness: 0.02, roughness: 0.88, side: THREE.FrontSide,
      });
      if (alpha || textures.meta.alpha) {
        material.alphaTest = 0.35;
      }
      if (recolors) {
        const uniformTint = uniformLuminanceTint;
        applyPackedRecolor(material, parameterMap, recolors, {
          fullTint: uniformTint,
          // Compact ground records store tint + half-range modulation while
          // omitting their unused second tint; keep those two exact values.
          uniformTintModulation: uniformTint && recolors.length === 2,
        });
      }
      if (this.disposed) {
        material.dispose();
        throw new Error('WorldScene was disposed while loading a material');
      }
      return material;
    });
  }

  /** Load every sub-image of a texture container, in container order. */
  _waterSubImages(textureId: number, suffix: string): Promise<HTMLImageElement[]> {
    return cachedPromise(this._waterTexturePromises, `subs:${textureId}:${suffix}`, async () => {
      const subs = this.textureMeta(textureId)?.subs;
      if (!Array.isArray(subs) || !subs.length) throw new Error(`texture ${textureId} lists no images`);
      const loader = new THREE.ImageLoader();
      return Promise.all(subs.map((_: any, k: number) =>
        loader.loadAsync(this.store.url(`images/${pad5(textureId)}_e${k}${suffix}.png`))));
    });
  }

  /** The style's ripple normal map with its authored mip chain. */
  _waterRipples(textureId: number): Promise<THREE.Texture> {
    return cachedPromise(this._waterTexturePromises, `ripples:${textureId}`, async () => {
      const images = (await this._waterSubImages(textureId, '_rg')).slice().sort((a, b) => b.width - a.width);
      const chain = images.filter((image, k) => k === 0 || image.width * 2 === images[k - 1].width);
      const texture = authoredMips(new THREE.Texture(chain[0]), chain, THREE.NoColorSpace);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      return texture;
    });
  }

  /** The reflected sky: six faces per level, levels largest first. */
  _waterSky(textureId: number): Promise<THREE.CubeTexture> {
    return cachedPromise(this._waterTexturePromises, `sky:${textureId}`, async () => {
      const images = await this._waterSubImages(textureId, '');
      const sizes = [...new Set(images.map((image) => image.width))].sort((a, b) => b - a);
      const levels = sizes.map((size) => images.filter((image) => image.width === size));
      if (!levels.length || levels.some((faces) => faces.length !== 6)) throw new Error(`texture ${textureId} is not a cube`);
      return authoredMips(new THREE.CubeTexture(levels[0]), levels.slice(1).map((faces) => ({ image: faces })), THREE.SRGBColorSpace);
    });
  }

  /** A curtain's banded texture, sampled in its own (unflipped) orientation. */
  _waterBands(textureId: number): Promise<THREE.Texture> {
    return cachedPromise(this._waterTexturePromises, `bands:${textureId}`, async () => {
      const meta = this.textureMeta(textureId);
      const images = await this._waterSubImages(textureId, '');
      const albedo = meta?.albedo != null ? images[meta.albedo] : images[0];
      const chain = [albedo];
      for (;;) {
        const next = images.find((image) => image.width * 2 === chain[chain.length - 1].width
          && image.height * 2 === chain[chain.length - 1].height);
        if (!next) break;
        chain.push(next);
      }
      return authoredMips(new THREE.Texture(chain[0]), chain, THREE.SRGBColorSpace);
    });
  }

  _waterStyle(index: number): GameWaterStyleUniforms {
    let uniforms = this._waterStyles.get(index);
    if (!uniforms) {
      uniforms = createStyleUniforms(this.index.water.styles[index]);
      this._waterStyles.set(index, uniforms);
    }
    return uniforms;
  }

  async _gameWaterMaterial(info: any, tint: number[] | null, renderTexture: number): Promise<THREE.ShaderMaterial | null> {
    const style = this.index?.water?.styles?.[info.style];
    if (!style) return null;
    // A curtain samples its own material's texture (the batch's render texture).
    if (info.kind === 'curtain' && !(renderTexture >= 0)) return null;
    const [ripples, sky, bands] = await Promise.all([
      this._waterRipples(style.normal), this._waterSky(style.cube),
      info.kind === 'curtain' ? this._waterBands(renderTexture) : null,
    ]);
    return createGameWaterMaterial(info, this._waterStyle(info.style), this.gameWater, tint,
      { ripples, sky, bands }, this.tileUnits);
  }

  /** Advance the game water to `ticks` and mirror the view's frame. */
  updateGameWater(ticks: number): void {
    const water = this.index?.water;
    if (!water) return;
    this.root.updateWorldMatrix(true, false);   // the root's own matrix: every frame, so never the whole scene below it
    this.gameWater.uWorldFromNative.value.copy(this.root.matrixWorld);
    this.gameWater.uNativeFromWorld.value.copy(this.root.matrixWorld).invert();
    this.gameWater.uLevel.value.set(water.level, 0);
    for (const [index, uniforms] of this._waterStyles) updateStyleUniforms(uniforms, water.styles[index], ticks);
  }

  /** Switch loaded rooms (every one, or just these) between the game's water
   *  and plain surfaces. */
  setGameWaterEnabled(enabled: boolean, rooms: Iterable<any> = this.rooms.values()): void {
    this.gameWaterEnabled = !!enabled;
    for (const room of rooms) {
      for (const mesh of room.meshes) {
        const water = mesh.userData.gameWater;
        if (!water) continue;
        mesh.material = this.gameWaterEnabled ? water.water : water.base;
        const shadowed = !this.gameWaterEnabled && !mesh.userData.exact?.authoredEmpty;
        mesh.castShadow = shadowed;
        mesh.receiveShadow = shadowed;
        this._applyMeshVisibility(mesh);
      }
    }
  }

  _structuralAnchors(shard: any): Map<number, any> {
    const cached = this._structuralAnchorCache.get(shard);
    if (cached) return cached;
    const result = new Map<number, any>();
    if (!this.linkColumns) {
      this._structuralAnchorCache.set(shard, result);
      return result;
    }
    const oc = this.occurrenceColumns;
    const lc = this.linkColumns;
    const parentDirection = this.index.enums?.link_direction?.parent ?? 0;
    const componentRole = this.index.enums?.role?.component ?? 2;
    const incoming = new Map<number, number[]>();
    const children = new Set<number>();
    for (const link of shard.links || []) {
      if (Number(link[lc.direction]) !== parentDirection) continue;
      const child = Number(link[lc.occurrence]);
      const parent = Number(link[lc.target_occurrence]);
      if (!Number.isInteger(child) || !Number.isInteger(parent)
          || child < 0 || parent < 0) continue;
      const list = incoming.get(parent) || [];
      list.push(child);
      incoming.set(parent, list);
      children.add(child);
    }
    for (const root of incoming.keys()) {
      const occurrence = shard.occurrences?.[root];
      if (!occurrence || children.has(root)) continue;
      if (oc.secondary !== undefined && Number(occurrence[oc.secondary]) >= 0) continue;
      if (oc.role !== undefined && Number(occurrence[oc.role]) === componentRole) continue;
      const members = new Set([root]);
      const pending = [root];
      while (pending.length) {
        for (const child of incoming.get(pending.pop()!) || []) {
          if (members.has(child)) continue;
          members.add(child);
          pending.push(child);
        }
      }
      let minX = Infinity; let minY = Infinity;
      let maxX = -Infinity; let maxY = -Infinity;
      for (const member of members) {
        const row = shard.occurrences?.[member];
        if (!row) continue;
        const x = finite(row[oc.x]); const y = finite(row[oc.y]);
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + 1); maxY = Math.max(maxY, y + 1);
      }
      if (![minX, minY, maxX, maxY].every(Number.isFinite)) continue;
      const center = [(minX + maxX) / 2, (minY + maxY) / 2];
      const placementCenter = [
        optionalFinite(occurrence[oc.anchor_x]) ?? finite(occurrence[oc.x]) + 0.5,
        optionalFinite(occurrence[oc.anchor_y]) ?? finite(occurrence[oc.y]) + 0.5,
      ];
      result.set(root, Object.freeze({
        source: 'class-127-tree-extent',
        center: Object.freeze(center),
        delta: Object.freeze([
          center[0] - (finite(occurrence[oc.x]) + 0.5),
          center[1] - (finite(occurrence[oc.y]) + 0.5),
          0,
        ]),
        agreesWithPlacement: center[0] === placementCenter[0]
          && center[1] === placementCenter[1],
        members: members.size,
      }));
    }
    this._structuralAnchorCache.set(shard, result);
    return result;
  }

  _placementAnchor(shard: any, occurrenceIndex: number): any {
    const occurrence = shard.occurrences?.[occurrenceIndex];
    if (!occurrence) return null;
    const oc = this.occurrenceColumns;

    const cellCenter = [
      finite(occurrence[oc.x]) + 0.5,
      finite(occurrence[oc.y]) + 0.5,
    ];
    const anchorX = optionalFinite(occurrence[oc.anchor_x]);
    const anchorY = optionalFinite(occurrence[oc.anchor_y]);
    if (anchorX === null || anchorY === null) {
      return Object.freeze({
        source: 'cell-center',
        center: Object.freeze(cellCenter),
        delta: Object.freeze([0, 0, 0]),
      });
    }
    const ownerBoundsKind = this.index.enums?.anchor_kind?.terrain_owner_bounds ?? 1;
    const linkedKind = this.index.enums?.anchor_kind?.linked_footprint ?? 2;
    const ownerDimensionsKind = this.index.enums?.anchor_kind?.owner_dimensions ?? 3;
    const ownerAlignmentKind = this.index.enums?.anchor_kind?.owner_bounds_alignment ?? 4;
    const anchorKind = optionalFinite(occurrence[oc.anchor_kind]);
    let source = 'cell-center';
    if (anchorKind === ownerBoundsKind) source = 'terrain-owner-bounds';
    else if (anchorKind === linkedKind) source = 'class-127-tree-extent';
    else if (anchorKind === ownerDimensionsKind) source = 'owner-dimensions';
    else if (anchorKind === ownerAlignmentKind) source = 'owner-bounds-alignment';
    return Object.freeze({
      source,
      center: Object.freeze([anchorX, anchorY]),
      delta: Object.freeze([anchorX - cellCenter[0], anchorY - cellCenter[1], 0]),
      kind: anchorKind,
    });
  }

  // Keep definition-order precedence for depth ties after batching. Sharing
  // a cell does not mean surfaces are coplanar, so this rank must only affect
  // raster depth, never the placement matrix, bounds, picking or shadows.
  _coplanarRank(shard: any, occurrenceIndex: number | string): number {
    let ranks = shard.__tieRanks;
    if (!ranks) {
      const oc = this.occurrenceColumns;
      const pc = this.placementColumns;
      const byCell = new Map<string, Set<number>>();
      for (const category of ['terrain', 'models', 'components']) {
        for (const row of shard.placements?.[category] || []) {
          const occIndex = Number(row[pc.occurrence]);
          const occ = shard.occurrences[occIndex];
          if (!occ) continue;
          const key = `${occ[oc.x]},${occ[oc.y]},${occ[oc.z]}`;
          let set = byCell.get(key);
          if (!set) byCell.set(key, set = new Set());
          set.add(occIndex);
        }
      }
      ranks = new Map();
      for (const set of byCell.values()) {
        if (set.size < 2) continue;
        const ordered = [...set].sort((a, b) => a - b);
        for (let rank = 1; rank < ordered.length; rank++) {
          // keep the LARGEST rank when an occurrence collides in several
          // cells: consistency matters more than which cell decided it
          ranks.set(ordered[rank], Math.max(ranks.get(ordered[rank]) || 0, rank));
        }
      }
      shard.__tieRanks = ranks;
    }
    return ranks.get(Number(occurrenceIndex)) || 0;
  }

  _placementLocalMatrix(shard: any, placement: any): number[] | null {
    const pc = this.placementColumns;
    const matrixIndex = finite(placement[pc.matrix], -1);
    let localMatrix: number[] | null = null;
    if (matrixIndex >= 0) {
      const values = shard.matrices?.[matrixIndex];
      if (!Array.isArray(values) || values.length !== 12 || values.some((value) => !Number.isFinite(value))) {
        throw new Error(`placement has invalid local matrix ${matrixIndex}`);
      }
      localMatrix = values;
    }
    return localMatrix;
  }

  _placementReflectLocalX(shard: any, placement: any): boolean {
    const occurrence = shard.occurrences[placement[this.placementColumns.occurrence]];
    const packed = finite(occurrence?.[this.occurrenceColumns.appearance_packed_flags
      ?? this.occurrenceColumns.packed_flags], 0);
    const m = this._placementLocalMatrix(shard, placement);
    const det = m ? m[0] * (m[5] * m[10] - m[6] * m[9])
      - m[1] * (m[4] * m[10] - m[6] * m[8])
      + m[2] * (m[4] * m[9] - m[5] * m[8]) : 1;
    return ((packed & 4) ? -det : det) < 0;
  }

  _placementMatrix(shard: any, placement: any, target: THREE.Matrix4, reflectionBaked = false): THREE.Matrix4 {
    const pc = this.placementColumns;
    const oc = this.occurrenceColumns;
    const occurrenceIndex = placement[pc.occurrence];
    const occurrence = shard.occurrences[occurrenceIndex];
    if (!occurrence) throw new Error(`placement references occurrence ${occurrenceIndex}`);
    const placementAnchor = this._placementAnchor(shard, occurrenceIndex);
    const centerX = placementAnchor?.center[0] ?? finite(occurrence[oc.x]) + 0.5;
    const centerY = placementAnchor?.center[1] ?? finite(occurrence[oc.y]) + 0.5;
    const z = finite(occurrence[oc.z]);
    const quarterTurns = finite(occurrence[oc.rotation_quarters], 0) & 3;
    const packedFlags = finite(occurrence[oc.appearance_packed_flags ?? oc.packed_flags], 0);

    const localMatrix = this._placementLocalMatrix(shard, placement);
    return composePlacementMatrix(target, {
      centerX, centerY, z, quarterTurns,
      meshForwardQuarterTurns: this.meshForwardQuarterTurns,
      packedFlags, localMatrix,
      tileUnits: this.tileUnits, layerUnits: this.layerUnits,
      reflectionBaked,
    });
  }

  /** The clip a spawn row rests in, or -1 (older shards carry no column). */
  _spawnIdleClip(spawn: any[]): number {
    const sc = this.spawnColumns;
    if (!sc || sc.idle_clip === undefined) return -1;
    const clip = Number(spawn[sc.idle_clip]);
    return Number.isInteger(clip) && clip >= 0 ? clip : -1;
  }

  _spawnMatrix(shard: any, part: any, target: THREE.Matrix4): THREE.Matrix4 {
    const pc = this.spawnPartColumns!;
    const sc = this.spawnColumns!;
    const spawnIndex = Number(part[pc.spawn]);
    const spawn = shard.spawns?.[spawnIndex];
    if (!spawn) throw new Error(`spawn part references spawn ${spawnIndex}`);
    const quarterTurns = finite(spawn[sc.rotation_quarters], 0) & 3;
    const surfaceZ = optionalFinite(spawn[sc.surface_z]);
    const centreOffset = optionalFinite(spawn[sc.centre_offset]) ?? 0.5;

    // Gameplay actor positions share the occurrences' raw room-local frame
    // (see the map_offset note near the top of this module), so like every
    // other display consumer they take no crop offset. New supported shards
    // carry the decoded room height in mesh units; older shards may carry a
    // sampled surface estimate. The legacy fallback keeps raw actor Z.
    target.makeTranslation(
      Math.fround(Math.fround(finite(spawn[sc.x])) + centreOffset) * this.tileUnits,
      Math.fround(Math.fround(finite(spawn[sc.y])) + centreOffset) * this.tileUnits,
      surfaceZ ?? finite(spawn[sc.z]) * this.layerUnits,
    );
    // The default mesh-forward correction and actor half-turn cancel, so
    // the base actor frame uses its authored angle directly. This frame
    // precedes any animation or attachment transform.
    target.multiply(_scratchRotZ.makeRotationZ(
      (quarterTurns + this.meshForwardQuarterTurns + SPAWN_FACING_HALF_TURN) * Math.PI / 2,
    ));
    return target;
  }

  /** A placed part's colour entry, when the shard carries it: the colour the
   *  game gives it at its tile (full range), then optionally its two
   *  recolour tints (half range). */
  _partColourEntry(shard: any, row: any[]): number[] | null {
    const column = this.placementColumns?.part_colour;
    if (column === undefined) return null;
    const index = Number(row[column]);
    const entry = index >= 0 ? shard.part_colours?.[index] : null;
    return Array.isArray(entry) && entry.length >= 4 ? entry.map(Number) : null;
  }

  /** One loaded room's placed batches for the game's own programs: raw mesh
   *  payloads with native-frame placements, the placement tints, and the
   *  water material each water face draws with. */
  async gameRoomSource(room: WorldSceneRoom): Promise<GameRoomSource> {
    const water = this.index?.water ?? null;
    const render = this.index?.render ?? null;
    const batches: GameBatchSource[] = [];
    const matrix = new THREE.Matrix4();
    const payloads = new Map<number, any>();   // one decode per mesh per room
    room.group.updateMatrix();
    const oc = this.occurrenceColumns, pc = this.placementColumns;
    for (const batch of this._batchRows(room.shard)) {
      if (batch.category === 'spawns') continue;
      const waterInfo = water?.materials?.[String(batch.material)] ?? null;
      const hasProgram = !!render?.materials?.[String(batch.material)];
      if (!waterInfo && !hasProgram) continue;
      // Untextured ground (the sea bed) draws with its colour-only program.
      // Untextured free-standing placements stay hidden: they are editor
      // markers (effect direction arrows, dig, sound and combat markers)
      // the game does not show.
      if (!waterInfo && batch.flags & this.flags.unrenderable) continue;
      if (!waterInfo && batch.flags & this.flags.authoredEmpty && batch.category !== 'terrain') continue;
      const mesh = Number(batch.mesh);
      let payload = payloads.get(mesh);
      if (!payload) payloads.set(mesh, payload = await this.store.payload(`meshes/${pad5(mesh)}.json`));
      const matrices = batch.entries.map((entry) => {
        this._placementMatrix(room.shard, entry.row, matrix, false);
        return room.group.matrix.clone().multiply(matrix);
      });
      const colours = batch.entries.map((entry) => this._partColourEntry(room.shard, entry.row));
      batches.push({
        category: batch.category,
        mesh, material: Number(batch.material), renderTexture: Number(batch.renderTexture),
        payload, matrices, tints: colours.map((c) => c?.slice(0, 4) ?? batch.recolors?.[0] ?? null),
        recolours: colours.map((c) => (c && c.length >= 12 ? [c.slice(4, 8), c.slice(8, 12)] : null)),
        order: batch.entries.map((entry) => emissionKey(room.shard.occurrences[entry.row[pc.occurrence]], entry.row, oc, pc)),
        water: waterInfo ? { kind: waterInfo.kind, style: waterInfo.style, opacity: waterInfo.opacity, window: waterInfo.window } : null,
      });
    }
    const grid = room.shard.colour_grid ?? null;
    const [w, h] = room.shard.size ?? [room.meta?.w ?? 0, room.meta?.h ?? 0];
    return {
      roomId: room.id,
      bounds: {
        inner: [0, 0, w, h],
        outer: grid ? [grid.x0, grid.y0, grid.x0 + grid.width, grid.y0 + grid.height] : [0, 0, w, h],
        layers: Number(room.shard.layers) || 1,
      },
      grid, batches, water, textureMeta: (id: number) => this.textureMeta(id),
    };
  }

  _batchRows(shard: any): WorldBatch[] {
    const batches = new Map<string, WorldBatch>();
    const add = ({ category, sourceKind, row, placementIndex, columns: pc, z, idleClip = -1 }: {
      category: string;
      sourceKind: string;
      row: any;
      placementIndex: number;
      columns: ColumnMap;
      z: any;
      idleClip?: number;
    }) => {
      const mesh = row[pc.mesh];
      const material = row[pc.material];
      const texture = row[pc.texture];
      const renderTexture = row[pc.render_texture];
      const flags = row[pc.flags] | 0;
      const recolorIndex = Number(row[pc.recolor]);
      const recolors = placementRecolors(
        shard, recolorIndex, `${category} ${sourceKind} ${placementIndex}`,
      );
      const visualFlags = flags & (
        this.flags.authoredEmpty | this.flags.alpha | this.flags.unrenderable
        | this.flags.uniformLuminanceTint
      );
      const reflectLocalX = sourceKind === 'occurrence'
        && this._placementReflectLocalX(shard, row);
      const depthRank = sourceKind === 'occurrence'
        ? this._coplanarRank(shard, row[pc.occurrence]) : 0;
      const key = JSON.stringify([
        category, sourceKind, mesh, material, texture, renderTexture, z,
        visualFlags, recolors, reflectLocalX, depthRank, idleClip,
      ]);
      let batch = batches.get(key);
      if (!batch) {
        batch = {
          key, category, sourceKind, mesh, material, texture, renderTexture,
          flags, recolorIndex, recolors, z, reflectLocalX, depthRank, idleClip, entries: [],
        };
        batches.set(key, batch);
      }
      batch.entries.push({ row, placementIndex, sourceKind });
    };

    const pc = this.placementColumns;
    const oc = this.occurrenceColumns;
    for (const category of OCCURRENCE_CATEGORIES) {
      const rows = shard.placements[category] || [];
      for (let placementIndex = 0; placementIndex < rows.length; placementIndex++) {
        const row = rows[placementIndex];
        const occurrence = shard.occurrences[row[pc.occurrence]];
        if (!occurrence) throw new Error(`${category} placement ${placementIndex} has no occurrence`);
        add({
          category, sourceKind: 'occurrence', row, placementIndex,
          columns: pc, z: occurrence[oc.z],
        });
      }
    }

    if (this.spawnColumns && this.spawnPartColumns) {
      const spawnPartColumns = this.spawnPartColumns;
      const spawnColumns = this.spawnColumns;
      const rows = shard.spawn_parts || [];
      for (let placementIndex = 0; placementIndex < rows.length; placementIndex++) {
        const row = rows[placementIndex];
        const spawn = shard.spawns?.[Number(row[spawnPartColumns.spawn])];
        if (!spawn) throw new Error(`spawn part ${placementIndex} has no spawn`);
        add({
          category: 'spawns', sourceKind: 'spawn', row, placementIndex,
          columns: spawnPartColumns, z: spawn[spawnColumns.z],
          idleClip: this._spawnIdleClip(spawn),
        });
      }
    }
    return [...batches.values()];
  }

  _isZVisible(z: any): boolean {
    const level = Number(z);
    return this.zVisibility.has(level)
      ? this.zVisibility.get(level)!
      : this.defaultZVisible;
  }

  /** While the game's own frame draws the room, hide what it draws. */
  setGameShading(on: boolean): void {
    if (this.gameShading === on) return;
    this.gameShading = on;
    for (const room of this.rooms.values()) for (const mesh of room.meshes) this._applyMeshVisibility(mesh);
  }

  _gameDraws(exact: any): boolean {
    if (!exact || exact.category === 'spawns') return false;
    const material = String(exact.material);
    return !!this.index?.water?.materials?.[material]
      || (!!this.index?.render?.materials?.[material] && (!exact.authoredEmpty || exact.category === 'terrain'));
  }

  _applyMeshVisibility(mesh: THREE.InstancedMesh): void {
    const exact = mesh.userData.exact;
    if (this.gameShading && this._gameDraws(exact)) { mesh.visible = false; return; }
    // A water surface has no plain texture of its own (its material is
    // authored empty): while the game's water draws it, it is always shown.
    const water = !!mesh.userData.gameWater && this.gameWaterEnabled;
    mesh.visible = this._isZVisible(exact.z)
      && (!exact.authoredEmpty || this.showAuthoredEmpty || water)
      && (!exact.untextured || this.showUntextured || water);
  }

  _buildCollision(shard: any): { group: THREE.Group; mesh: THREE.InstancedMesh | null } {
    const rows = shard.collision || [];
    const group = new THREE.Group();
    group.name = 'world-collision';
    group.visible = this.showCollision;
    if (!rows.length) return { group, mesh: null };

    const cc = this.collisionColumns;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const mesh = new THREE.InstancedMesh(
      this._collisionGeometry, this._collisionMaterial, rows.length,
    );
    mesh.name = 'world-collision-extents';
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const width = finite(row[cc.width]);
      const height = finite(row[cc.height]);
      const zMin = finite(row[cc.z_min]);
      const zMax = finite(row[cc.z_max]);
      if (width <= 0 || height <= 0 || zMax <= zMin) {
        throw new Error(`collision extent ${index} has invalid bounds`);
      }
      position.set(
        (finite(row[cc.x]) + width / 2) * this.tileUnits,
        (finite(row[cc.y]) + height / 2) * this.tileUnits,
        (zMin + zMax) / 2 * this.layerUnits,
      );
      scale.set(
        width * this.tileUnits,
        height * this.tileUnits,
        (zMax - zMin) * this.layerUnits,
      );
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(index, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    mesh.userData.worldCollision = { rows, columns: this.index.columns.collision };
    group.add(mesh);
    return { group, mesh };
  }

  async _buildRoom(
    meta: any,
    shard: any,
    worldRoom: any,
    origin: { x: number; y: number },
    generation: number,
    roomGeneration: number,
  ): Promise<{
    group: THREE.Group;
    categoryGroups: Record<string, THREE.Group>;
    batches: WorldBatch[];
    created: THREE.InstancedMesh[];
    collisionGroup: THREE.Group;
    collisionMesh: THREE.InstancedMesh | null;
  }> {
    const group = new THREE.Group();
    group.name = `world-room-${meta.id}`;
    group.userData.worldRoom = meta.id;
    const categoryGroups: Record<string, THREE.Group> = {};
    for (const category of WORLD_CATEGORIES) {
      const child = new THREE.Group();
      child.name = `world-${category}`;
      child.visible = this.categoryVisibility[category];
      categoryGroups[category] = child;
      group.add(child);
    }
    const collision = this._buildCollision(shard);
    group.add(collision.group);

    const batches = this._batchRows(shard);
    const matrix = new THREE.Matrix4();
    const created: THREE.InstancedMesh[] = [];
    const waterMaterials = new Map<string, Promise<THREE.ShaderMaterial | null>>();
    // Water faces carry their part colour (the placement's first recolour).
    const waterMaterialFor = (materialSlot: any, renderTexture: any, recolors: any): Promise<THREE.ShaderMaterial | null> => {
      const info = this.index?.water?.materials?.[String(materialSlot)];
      if (!info) return Promise.resolve(null);
      const tint: number[] | null = Array.isArray(recolors?.[0]) ? recolors[0].slice(0, 3).map(Number) : null;
      return cachedPromise(waterMaterials, `${materialSlot}:${renderTexture}:${tint ? tint.join(',') : 'neutral'}`,
        () => this._gameWaterMaterial(info, tint, Number(renderTexture)));
    };
    try {
      await eachLimit(batches, this.assetConcurrency, async (batch) => {
        // Bail before requesting assets: after a cancel/dispose, hundreds of
        // queued batches must not keep fetching payloads and decoding textures.
        if (!this._roomLoadActive(meta.id, generation, roomGeneration)) return;
        const [geometry, material] = await Promise.all([
          this._batchGeometry(batch),
          this._material(
            batch.category, batch.material, batch.renderTexture, batch.flags,
            batch.recolors, batch.depthRank,
          ),
        ]);
        if (!this._roomLoadActive(meta.id, generation, roomGeneration)) return;
        const waterMaterial = await waterMaterialFor(batch.material, batch.renderTexture, batch.recolors).catch(() => null);
        if (!this._roomLoadActive(meta.id, generation, roomGeneration)) return;
        const mesh = new THREE.InstancedMesh(geometry, waterMaterial && this.gameWaterEnabled ? waterMaterial : material,
          batch.entries.length);
        if (waterMaterial) mesh.userData.gameWater = { base: material, water: waterMaterial };
        mesh.name = `world-${batch.category}-m${batch.mesh}-t${batch.renderTexture}-z${batch.z}`;
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        for (let index = 0; index < batch.entries.length; index++) {
          const entry = batch.entries[index];
          if (entry.sourceKind === 'spawn') this._spawnMatrix(shard, entry.row, matrix);
          else this._placementMatrix(shard, entry.row, matrix, batch.reflectLocalX);
          mesh.setMatrixAt(index, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        const authoredEmpty = !!(batch.flags & this.flags.authoredEmpty);
        // Water neither casts nor receives shadows while the game's water draws it.
        const shadowed = !authoredEmpty && !(waterMaterial && this.gameWaterEnabled);
        mesh.castShadow = shadowed;
        mesh.receiveShadow = shadowed;
        mesh.userData.exact = {
          room: meta.id,
          category: batch.category,
          sourceKind: batch.sourceKind,
          mesh: batch.mesh,
          material: batch.material,
          texture: batch.texture,
          renderTexture: batch.renderTexture,
          recolorIndex: batch.recolorIndex,
          recolors: batch.recolors,
          flags: batch.flags,
          authoredEmpty,
          untextured: !authoredEmpty && Number(batch.renderTexture) < 0,
          reflectLocalX: !!batch.reflectLocalX,
          depthRank: batch.depthRank,
          idleClip: batch.idleClip,
          z: batch.z,
          placementIndices: batch.entries.map((entry) => entry.placementIndex),
          placementRows: batch.entries.map((entry) => entry.row),
        };
        this._applyMeshVisibility(mesh);
        categoryGroups[batch.category].add(mesh);
        created.push(mesh);
      });
    } catch (error) {
      disposeRoomGroup(group);
      throw error;
    }

    group.position.set(
      (finite(worldRoom.x) + origin.x) * this.tileUnits,
      (finite(worldRoom.y) + origin.y) * this.tileUnits,
      0,
    );
    // The room subtree is static once built (session edits rewrite INSTANCE
    // matrices, never node transforms): freeze every node's local matrix so
    // three's per-frame updateMatrixWorld pass stops re-composing hundreds of
    // objects per room (~100k across a 451-room stream) every frame.
    group.traverse((node: THREE.Object3D) => {
      node.matrixAutoUpdate = false;
      node.updateMatrix();
    });
    return {
      group, categoryGroups, batches, created,
      collisionGroup: collision.group,
      collisionMesh: collision.mesh,
    };
  }

  _detachRoom(roomId: number | string, emit = true): boolean {
    const id = Number(roomId);
    const room = this.rooms.get(id);
    if (!room) return false;
    this.root.remove(room.group);
    disposeRoomGroup(room.group);
    this.rooms.delete(id);
    if (emit) this._emit('unloaded', { room: id });
    return true;
  }

  _detachAll(emit = true): void {
    const ids = [...this.rooms.keys()];
    for (const id of ids) this._detachRoom(id, false);
    if (emit && ids.length) this._emit('unloaded', { rooms: ids });
  }

  _ensureRoomPrepared(
    id: number,
    generation: number = this._generation,
    roomGeneration: number = this._roomGeneration(id),
  ): Promise<WorldSceneRoom | null> {
    const meta = this._roomMeta.get(id);
    if (!meta) {
      return Promise.reject(new Error(`room ${id} is not present in the world index`));
    }
    if (!this._roomLoadActive(id, generation, roomGeneration)) return Promise.resolve(null);
    const loaded = this.rooms.get(id);
    if (loaded) return Promise.resolve(loaded);

    const pending = this._roomPromises.get(id);
    if (pending?.generation === generation
        && pending.roomGeneration === roomGeneration) return pending.promise!;

    const entry: {
      generation: number;
      roomGeneration: number;
      promise: Promise<WorldSceneRoom | null> | null;
    } = { generation, roomGeneration, promise: null };
    entry.promise = (async () => {
      this._emit('loading', { room: id, meta });
      try {
        const shard = await this._roomShard(meta);
        if (!this._roomLoadActive(id, generation, roomGeneration)) return null;
        const worldRoom = await this._resolveWorldRoom(id, meta, shard);
        if (!this._roomLoadActive(id, generation, roomGeneration)) return null;
        const origin = await this._resolveOrigin(id, meta, shard, worldRoom);
        if (!this._roomLoadActive(id, generation, roomGeneration)) return null;
        const built = await this._buildRoom(
          meta, shard, worldRoom, origin, generation, roomGeneration,
        );
        if (!this._roomLoadActive(id, generation, roomGeneration)) {
          disposeRoomGroup(built.group);
          return null;
        }
        built.group.visible = this._onlyRoomId === null || this._onlyRoomId === id;
        this.root.add(built.group);
        const room: WorldSceneRoom = {
          id, meta, shard, worldRoom, origin,
          group: built.group,
          categoryGroups: built.categoryGroups,
          collisionGroup: built.collisionGroup,
          collisionMesh: built.collisionMesh,
          // batch descriptors are build-time only; retaining 451 rooms' entry
          // arrays would double the placement-row footprint for no reader
          batchCount: built.batches.length,
          meshes: built.created,
        };
        this.rooms.set(id, room);
        this._emit('loaded', {
          room: id, meta, shard,
          batches: built.batches.length,
          instances: built.created.reduce((sum, mesh) => sum + mesh.count, 0),
          loadedRooms: this.rooms.size,
        });
        return room;
      } catch (error) {
        if (!this._roomLoadActive(id, generation, roomGeneration)) return null;
        this._emit('error', { room: id, error });
        throw error;
      } finally {
        if (this._roomPromises.get(id) === entry) this._roomPromises.delete(id);
      }
    })();
    this._roomPromises.set(id, entry);
    return entry.promise;
  }

  /** Load one room without unloading any room already retained. */
  async ensureRoom(roomId: number | string): Promise<WorldSceneRoom | null> {
    this._assertUsable();
    await this.init();
    return this._ensureRoomPrepared(Number(roomId), this._generation);
  }

  /** Progressively retain a set of rooms with bounded room-level concurrency. */
  async loadRooms(roomIds: Iterable<number | string>, {
    concurrency = 3,
    onProgress = null,
  }: {
    concurrency?: number;
    onProgress?: ((progress: any) => void) | null;
  } = {}): Promise<WorldSceneRoom[]> {
    this._assertUsable();
    await this.init();
    const ids = [...new Set([...roomIds].map(Number))];
    const total = ids.length;
    const generation = this._generation;
    const roomGenerations = new Map(ids.map(id => [id, this._roomGeneration(id)]));
    const results: (WorldSceneRoom | null | undefined)[] = new Array(total);
    const errors: { room: number; error: any }[] = [];
    let completed = 0;
    let loaded = 0;
    const limit = Math.max(1, finite(concurrency, 3) | 0);
    this._emit('rooms-loading', { total, concurrency: limit });

    await eachLimit(ids, limit, async (id, index) => {
      let room: WorldSceneRoom | null = null;
      let error: any = null;
      try {
        room = await this._ensureRoomPrepared(id, generation, roomGenerations.get(id));
        results[index] = room;
        if (room) loaded++;
      } catch (caught) {
        error = caught;
        errors.push({ room: id, error: caught });
      }
      completed++;
      const progress = {
        completed, total, loaded, failed: errors.length, room: id,
        state: error ? 'error' : room ? 'loaded' : 'cancelled',
        roomData: room, error,
      };
      if (typeof onProgress === 'function') {
        try { onProgress(progress); } catch { /* host callback */ }
      }
      this._emit('rooms-progress', { ...progress, roomState: progress.state });
    });

    const retained = results.filter(Boolean) as WorldSceneRoom[];
    if (errors.length) {
      const error: any = new AggregateError(
        errors.map(entry => entry.error),
        `${errors.length} of ${total} world rooms failed to load`,
      );
      error.rooms = retained;
      error.failures = errors;
      this._emit('rooms-error', { total, loaded, errors });
      throw error;
    }
    this._emit('rooms-loaded', { total, loaded });
    return retained;
  }

  /** Show one retained room, or pass null to show every retained room. */
  showOnly(roomId: number | string | null = null): void {
    this._assertUsable();
    const id = roomId === null || roomId === undefined ? null : Number(roomId);
    this._onlyRoomId = id;
    for (const room of this.rooms.values()) {
      room.group.visible = id === null || room.id === id;
    }
    this._emit('room-visibility', { room: id });
  }

  /** Cancel/unload every room, then load only `roomId` (single-room view). */
  async loadRoom(roomId: number | string): Promise<WorldSceneRoom | null> {
    this._assertUsable();
    await this.init();
    const id = Number(roomId);
    if (!this._roomMeta.has(id)) throw new Error(`room ${roomId} is not present in the world index`);
    const generation = ++this._generation;
    this._roomPromises.clear();
    this._roomGenerations.clear();
    this._detachAll(false);
    this._onlyRoomId = id;
    return this._ensureRoomPrepared(id, generation, this._roomGeneration(id));
  }

  setCategoryVisible(category: string, visible: boolean): void {
    if (!WORLD_CATEGORIES.includes(category)) throw new Error(`unknown world category ${category}`);
    this.categoryVisibility[category] = !!visible;
    for (const room of this.rooms.values()) {
      room.categoryGroups[category].visible = !!visible;
    }
    this._emit('visibility', { category, visible: !!visible });
  }

  zLevels(): number[] {
    const levels = new Set<number>();
    for (const room of this.rooms.values()) {
      for (const mesh of room.meshes) levels.add(Number(mesh.userData.exact.z));
    }
    return [...levels].sort((left, right) => left - right);
  }

  isZVisible(z: any): boolean {
    const level = Number(z);
    if (!Number.isFinite(level)) return false;
    return this._isZVisible(level);
  }

  setZVisible(z: any, visible: boolean): void {
    const level = Number(z);
    if (!Number.isFinite(level)) throw new TypeError(`invalid world Z level ${z}`);
    const next = !!visible;
    if (next === this.defaultZVisible) this.zVisibility.delete(level);
    else this.zVisibility.set(level, next);
    for (const room of this.rooms.values()) {
      for (const mesh of room.meshes) {
        if (Number(mesh.userData.exact?.z) === level) this._applyMeshVisibility(mesh);
      }
    }
    this._emit('z-visibility', { z: level, visible: next });
  }

  setAllZVisible(visible = true): void {
    this.defaultZVisible = !!visible;
    this.zVisibility.clear();
    for (const room of this.rooms.values()) {
      for (const mesh of room.meshes) this._applyMeshVisibility(mesh);
    }
    this._emit('z-visibility-all', { visible: this.defaultZVisible });
  }

  setCollisionVisible(visible: boolean): void {
    this.showCollision = !!visible;
    for (const room of this.rooms.values()) {
      room.collisionGroup.visible = this.showCollision;
    }
    this._emit('collision', { visible: this.showCollision });
  }

  setAuthoredEmptyVisible(visible: boolean): void {
    this.showAuthoredEmpty = !!visible;
    for (const room of this.rooms.values()) {
      for (const mesh of room.meshes) {
        if (mesh.userData.exact?.authoredEmpty) this._applyMeshVisibility(mesh);
      }
    }
    this._emit('authored-empty', { visible: this.showAuthoredEmpty });
  }

  /** Placements with no decodable texture render as flat category fills. */
  setUntexturedVisible(visible: boolean): void {
    this.showUntextured = !!visible;
    for (const room of this.rooms.values()) {
      for (const mesh of room.meshes) {
        if (mesh.userData.exact?.untextured) this._applyMeshVisibility(mesh);
      }
    }
    this._emit('untextured', { visible: this.showUntextured });
  }

  /**
   * Resolve a raycast hit on a world InstancedMesh back to its source rows.
   * Batch instance order is deliberately the same as placementRows, so this
   * stays exact even when many occurrences share one mesh/material batch.
   */
  describeInstance(mesh: THREE.InstancedMesh | null | undefined, instanceId: any): any {
    const exact = mesh?.userData?.exact;
    const instance = Number(instanceId);
    const owner = exact ? this.rooms.get(Number(exact.room)) : null;
    if (!owner || !Number.isInteger(instance)
        || instance < 0 || instance >= mesh!.count) return null;
    const placementIndex = exact.placementIndices?.[instance];
    if (placementIndex === undefined) return null;
    return this.describeShardPlacement(
      exact.room, owner.shard, exact.sourceKind, exact.category,
      placementIndex, instance,
    );
  }

  /**
   * Describe one placement/spawn-part row straight from its room shard. The
   * merged all-rooms inspector resolves CPU-index picks through this without
   * the per-room graph (which merged mode releases); describeInstance
   * delegates here so both paths return the identical readout payload.
   */
  describeShardPlacement(
    roomId: number | string,
    shard: any,
    sourceKind: string,
    category: string,
    rowIndex: number | string,
    instance = -1,
  ): any {
    if (!shard || !this.index) return null;
    const placementIndex = Number(rowIndex);
    if (!Number.isInteger(placementIndex) || placementIndex < 0) return null;
    const owner = { id: Number(roomId), shard };
    if (sourceKind === 'spawn') {
      const pc = this.spawnPartColumns;
      if (!pc) return null;
      const placement = shard.spawn_parts?.[placementIndex];
      if (!placement) return null;
      const spawnIndex = Number(placement[pc.spawn]);
      const spawn = this._describeSpawn(owner, spawnIndex);
      if (!spawn) return null;
      const recolorIndex = Number(placement[pc.recolor]);
      const recolors = placementRecolors(
        shard, recolorIndex, `spawn part ${placementIndex}`,
      );
      return Object.freeze({
        ...spawn,
        instance,
        placementIndex,
        placement,
        occurrenceIndex: null,
        occurrence: null,
        resource: null,
        secondary: null,
        structuralAnchor: null,
        placementAnchor: Object.freeze({
          source: 'spawn-authored-center',
          center: Object.freeze([
            Math.fround(Math.fround(Number(spawn.position[0])) + spawn.centreOffset),
            Math.fround(Math.fround(Number(spawn.position[1])) + spawn.centreOffset),
          ]),
          delta: Object.freeze([0, 0, 0]),
        }),
        mesh: placement[pc.mesh],
        material: placement[pc.material],
        texture: placement[pc.texture],
        renderTexture: placement[pc.render_texture],
        recolorIndex,
        recolors,
        matrixIndex: -1,
        localMatrix: null,
        flags: placement[pc.flags] | 0,
        z: spawn.position[2],
      });
    }
    const pc = this.placementColumns;
    const oc = this.occurrenceColumns;
    const placement = shard.placements?.[category]?.[placementIndex];
    if (!placement) return null;
    const occurrenceIndex = Number(placement[pc.occurrence]);
    const occurrence = shard.occurrences?.[occurrenceIndex];
    if (!occurrence) return null;
    const individualIndex = oc.individual === undefined ? -1 : Number(occurrence[oc.individual]);
    const secondaryValue = oc.secondary === undefined ? -1 : Number(occurrence[oc.secondary]);
    const packedColumn = oc.appearance_packed_flags ?? oc.packed_flags;
    const matrixIndexValue = Number(placement[pc.matrix]);
    const matrixIndex = Number.isInteger(matrixIndexValue) && matrixIndexValue >= 0
      ? matrixIndexValue
      : -1;
    const localMatrix = matrixIndex >= 0 ? shard.matrices?.[matrixIndex] : null;
    const recolorIndex = Number(placement[pc.recolor]);
    const recolors = placementRecolors(
      shard, recolorIndex, `placement ${placementIndex}`,
    );
    const structuralAnchor = this._structuralAnchors(shard).get(occurrenceIndex) || null;
    const placementAnchor = this._placementAnchor(shard, occurrenceIndex);

    return Object.freeze({
      room: owner.id,
      category,
      sourceKind: 'occurrence',
      instance,
      placementIndex,
      placement,
      occurrenceIndex,
      depthRank: this._coplanarRank(shard, occurrenceIndex),
      occurrence,
      record: oc.record === undefined ? null : occurrence[oc.record],
      resource: occurrence[oc.appearance_resource ?? oc.resource],
      secondary: secondaryValue >= 0 ? secondaryValue : null,
      entrySlot: oc.entry_slot === undefined ? null : occurrence[oc.entry_slot],
      packed: oc.packed === undefined ? null : occurrence[oc.packed],
      packedFlags: packedColumn === undefined ? null : occurrence[packedColumn],
      individual: individualIndex >= 0
        ? shard.individuals?.[individualIndex] ?? null
        : null,
      structuralAnchor,
      placementAnchor,
      position: [occurrence[oc.x], occurrence[oc.y], occurrence[oc.z]],
      rotationQuarters: occurrence[oc.rotation_quarters],
      mesh: placement[pc.mesh],
      material: placement[pc.material],
      texture: placement[pc.texture],
      renderTexture: placement[pc.render_texture],
      recolorIndex,
      recolors,
      matrixIndex,
      localMatrix: Array.isArray(localMatrix)
        ? Object.freeze(localMatrix.map(Number))
        : null,
      // Non-visual placement flags are excluded from the batch key: report
      // the selected source row, not whichever row created the batch.
      flags: placement[pc.flags] | 0,
      z: occurrence[oc.z],
    });
  }

  _describeSpawn(owner: { id: number; shard: any }, spawnIndex: number | string): any {
    const index = Number(spawnIndex);
    const spawn = owner?.shard?.spawns?.[index];
    if (!spawn || !this.spawnColumns) return null;
    const sc = this.spawnColumns;
    const pc = this.spawnPartColumns!;
    const parts = [];
    for (let rowIndex = 0; rowIndex < (owner.shard.spawn_parts || []).length; rowIndex++) {
      const row = owner.shard.spawn_parts[rowIndex];
      if (Number(row[pc.spawn]) !== index) continue;
      parts.push(Object.freeze({
        rowIndex,
        row,
        partIndex: row[pc.part_index],
        mesh: row[pc.mesh],
        material: row[pc.material],
        texture: row[pc.texture],
        renderTexture: row[pc.render_texture],
        flags: row[pc.flags] | 0,
        recolorIndex: Number(row[pc.recolor]),
      }));
    }
    const idleClip = this._spawnIdleClip(spawn);
    return Object.freeze({
      room: owner.id,
      category: 'spawns',
      sourceKind: 'spawn',
      spawnIndex: index,
      spawn,
      record: spawn[sc.record],
      roomRecord: spawn[sc.room_record],
      // spawn origin (optional column; older shards have none -> null):
      // 0 actor record; 1 and 2 are legacy inferred placements.
      origin: sc.origin !== undefined && Number.isInteger(spawn[sc.origin])
        ? Number(spawn[sc.origin]) : null,
      label: spawn[sc.label] ?? null,
      authoredLabel: spawn[sc.authored_label] ?? spawn[sc.label] ?? null,
      centreOffset: optionalFinite(spawn[sc.centre_offset]) ?? 0.5,
      directionResource: spawn[sc.direction_resource],
      position: Object.freeze([spawn[sc.x], spawn[sc.y], spawn[sc.z]]),
      surfaceZ: optionalFinite(spawn[sc.surface_z]),
      heightSource: spawn[sc.height_source] ?? 'surface_estimate',
      rotationQuarters: spawn[sc.rotation_quarters],
      // the clip the actor rests in (-1 / absent column -> null)
      defaultClip: idleClip >= 0 ? idleClip : null,
      parts: Object.freeze(parts),
    });
  }

  // Merged-mode graph release, split into two seams so the caller can spread
  // it across the bake instead of one synchronous end-of-bake pass: at world
  // scale that pass (451 rooms, ~100k InstancedMeshes) wedged real Firefox,
  // where every GL delete is IPC to its GPU process. Once the merged renderer
  // is the display path the graph is pure dead weight, roughly DOUBLING GPU
  // memory. Rooms reload from IndexedDB on demand (merged toggled back off).

  /**
   * Free ONE room's graph objects (its instanced meshes + groups). Shared
   * geometry/texture/material caches stay alive; emits 'unloaded' so the view
   * drops its per-room bookkeeping (water curtains/sheets).
   */
  releaseRoomGraph(roomId: number | string): boolean {
    if (this.disposed) return false;
    const id = Number(roomId);
    this._roomGenerations.set(id, this._roomGeneration(id) + 1);   // invalidate an in-flight load
    this._roomPromises.delete(id);
    return this._detachRoom(id, true);
  }

  /**
   * Dispose the shared geometry/material caches in time-budgeted slices.
   * Textures are deliberately KEPT: the merged materials reference the same
   * THREE.Texture objects, so disposing them here would only force a full
   * re-upload on the next frame (and previously leaked the re-uploaded copies
   * on navigation): dispose() frees them with the view.
   */
  async releaseGraphCaches({ budgetMs = 15, shouldStop = null, onProgress = null }: {
    budgetMs?: number;
    shouldStop?: (() => boolean) | null;
    onProgress?: ((detail: { done: number; total: number }) => void) | null;
  } = {}): Promise<number> {
    const entries: [Map<any, Promise<any>>, any, Promise<any>][] = [
      ...[...this._materialPromises].map(([key, promise]): [Map<any, Promise<any>>, any, Promise<any>] => [this._materialPromises, key, promise]),
      ...[...this._geometryPromises].map(([key, promise]): [Map<any, Promise<any>>, any, Promise<any>] => [this._geometryPromises, key, promise]),
    ];
    const total = entries.length;
    let done = 0;
    let sliceStart = performance.now();
    for (const [cache, key, promise] of entries) {
      // Abandoning mid-way is safe: undisposed entries stay in their cache,
      // so dispose() (or a later call) still sweeps them.
      if (this.disposed || shouldStop?.()) return done;
      if (cache.get(key) === promise) {
        cache.delete(key);
        try { (await promise).dispose(); } catch { /* failed load */ }
      }
      done++;
      if (performance.now() - sliceStart > budgetMs) {
        if (onProgress) {
          try { onProgress({ done, total }); } catch { /* host callback */ }
        }
        await yieldToBrowser();
        sliceStart = performance.now();
      }
    }
    this._emit('graph-released');
    return done;
  }

  dispose(): void {
    if (this.disposed) return;
    this._generation++;
    this._roomPromises.clear();
    this._roomGenerations.clear();
    this._detachAll(false);
    this.disposed = true;
    this.scene.remove(this.root);

    for (const promise of this._materialPromises.values()) {
      promise.then((material) => material.dispose()).catch(() => {});
    }
    for (const promise of this._geometryPromises.values()) {
      promise.then((geometry) => geometry.dispose()).catch(() => {});
    }
    for (const promise of this._texturePromises.values()) {
      promise.then(({ map, normalMap }) => {
        map.dispose();
        normalMap?.dispose();
      }).catch(() => {});
    }
    for (const promise of this._parameterPromises.values()) {
      promise.then((map) => map?.dispose()).catch(() => {});
    }
    this._collisionGeometry.dispose();
    this._collisionMaterial.dispose();
    this._materialPromises.clear();
    this._geometryPromises.clear();
    this._texturePromises.clear();
    this._parameterPromises.clear();
    this._roomMeta.clear();
    this.rooms.clear();
    this.root.clear();
    this._emit('disposed');
  }
}

export default WorldScene;
