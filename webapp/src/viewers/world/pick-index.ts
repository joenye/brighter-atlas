// CPU-side picking index for the merged all-rooms world (world.js Inspect
// mode). The merged bake flattens every placement into large static batches
// with no per-instance identity, so this index records, per placement, a
// world-space AABB plus just enough provenance to re-derive the full readout
// from the room shard on demand: room, source kind, category, placement row
// index, mesh id (+reflect), z. Storage is typed arrays only (~56 bytes per
// placement: the full ~1.15M-placement world costs ~65 MB); the 3×3 linear
// parts of the composed instance matrices are deduplicated into a small pool
// (quarter-turns × reflections × interned local matrices) so the exact
// matrix can be rebuilt for the narrow-phase triangle test without storing
// 48 bytes of matrix per entry.
//
// Query = ray (native/game space, Z up) → uniform XY grid walk → slab test
// each cell's AABBs → candidates sorted by entry distance. The CALLER then
// confirms candidates with a precise triangle test against the shared-cache
// mesh geometry it loads on demand (world._meshGeometry). Session edits stay
// exact: setMatrix() moves an entry's matrix + AABB in place (the static grid
// is compensated by slab-testing moved entries from a small side list) and
// markDeleted() flips a meta bit that every query skips.

import { WORLD_CATEGORIES } from './scene.js';
import type { Matrix4, Box3, BufferGeometry } from '../../../vendor/three.module.js';

const CELL_TILES = 16;      // picking-grid cell edge, in tiles
const SEGMENT = 1 << 16;    // build-time chunk size, entries
const MAX_GRID = 1024;      // grid dimension clamp (degenerate bounds guard)

export const PICK_CATEGORY_MASK = 3;
export const PICK_SPAWN_BIT = 4;
export const PICK_UNTEXTURED_BIT = 8;
export const PICK_WATER_BIT = 16;
export const PICK_DELETED_BIT = 32;
export const PICK_Z_SHIFT = 8;
export const PICK_Z_BIAS = 128;

/** The z level packed into a meta word (see PICK_Z_*). */
export function pickMetaZ(meta: number): number {
  return ((meta >>> PICK_Z_SHIFT) & 255) - PICK_Z_BIAS;
}

interface PickSegment {
  aabb: Float32Array;
  pos: Float32Array;
  linear: Uint32Array;
  room: Uint32Array;
  rowIdx: Uint32Array;
  meshId: Uint32Array;
  meta: Uint32Array;
}

function newSegment(): PickSegment {
  return {
    aabb: new Float32Array(SEGMENT * 6),
    pos: new Float32Array(SEGMENT * 3),
    linear: new Uint32Array(SEGMENT),
    room: new Uint32Array(SEGMENT),
    rowIdx: new Uint32Array(SEGMENT),
    meshId: new Uint32Array(SEGMENT),
    meta: new Uint32Array(SEGMENT),
  };
}

export interface PickCandidate {
  index: number;
  tNear: number;
}

export interface PickRef {
  index: number;
  room: number;
  placementIndex: number;
  sourceKind: 'spawn' | 'occurrence';
  category: string;
  mesh: number;
  reflect: boolean;
  z: number;
  deleted: boolean;
  untextured: boolean;
  water: boolean;
}

export interface PickSnapshot {
  linear: number;
  pos: number[];
  aabb: number[];
  meta: number;
  moved: boolean;
}

export class WorldPickIndex {
  tileUnits: number;
  cellUnits: number;
  // set by reset() (called from the constructor); the SoA arrays are null
  // until finalize()
  declare ready: boolean;
  declare aabb: Float32Array;
  declare pos: Float32Array;
  declare linear: Uint32Array;
  declare room: Uint32Array;
  declare rowIdx: Uint32Array;
  declare meshId: Uint32Array;
  declare meta: Uint32Array;
  declare _count: number;
  declare _segments: PickSegment[];
  declare _segment: PickSegment | null;
  declare _segmentUsed: number;
  declare _linearIndex: Map<string, number>;
  declare _linears: Float32Array[];
  declare _roomRanges: Map<number, number[][]>;
  declare _openRoom: number | null;
  declare _openStart: number;
  declare _cellStarts: Uint32Array;
  declare _cellEntries: Uint32Array;
  declare _stamp: Uint32Array;
  declare _stampToken: number;
  declare _gridX: number;
  declare _gridY: number;
  declare _minX: number;
  declare _minY: number;
  declare _bounds: number[];
  declare _moved: Set<number>;

  constructor({ tileUnits = 1024 }: { tileUnits?: number } = {}) {
    this.tileUnits = Number(tileUnits) || 1024;
    this.cellUnits = CELL_TILES * this.tileUnits;
    this.reset();
  }

  reset(): void {
    this.ready = false;
    this._count = 0;
    this._segments = [];
    this._segment = null;
    this._segmentUsed = 0;
    // linear pool: column-major 3x3 [c0x,c0y,c0z, c1x,c1y,c1z, c2x,c2y,c2z]
    this._linearIndex = new Map();
    this._linears = [];
    this._roomRanges = new Map();   // room id -> [[start, end), ...]
    this._openRoom = null;
    this._openStart = 0;
    // finalized SoA storage
    this.aabb = null as any;
    this.pos = null as any;
    this.linear = null as any;
    this.room = null as any;
    this.rowIdx = null as any;
    this.meshId = null as any;
    this.meta = null as any;
    this._cellStarts = null as any;
    this._cellEntries = null as any;
    this._stamp = null as any;
    this._stampToken = 0;
    this._gridX = 0;
    this._gridY = 0;
    this._minX = 0;
    this._minY = 0;
    this._bounds = null as any;     // [minX,minY,minZ,maxX,maxY,maxZ]
    this._moved = new Set();
  }

  dispose(): void {
    this.reset();
  }

  get count(): number {
    return this._count;
  }

  _internLinear(
    e0: number, e1: number, e2: number,
    e4: number, e5: number, e6: number,
    e8: number, e9: number, e10: number,
  ): number {
    const key = `${e0},${e1},${e2},${e4},${e5},${e6},${e8},${e9},${e10}`;
    let index = this._linearIndex.get(key);
    if (index === undefined) {
      index = this._linears.length;
      this._linears.push(Float32Array.of(e0, e1, e2, e4, e5, e6, e8, e9, e10));
      this._linearIndex.set(key, index);
    }
    return index;
  }

  _closeRoomRange(): void {
    if (this._openRoom === null || this._count === this._openStart) return;
    const list = this._roomRanges.get(this._openRoom) || [];
    list.push([this._openStart, this._count]);
    this._roomRanges.set(this._openRoom, list);
  }

  /**
   * Add every instance of one harvested batch. `exact` is the per-room graph
   * batch descriptor (mesh.userData.exact); `instanceArray` the instanced
   * Float32 matrices in ROOM-LOCAL native units; roomX/roomY the room's
   * stitched offset in native units. Copies everything: safe to call right
   * before the room graph is released.
   */
  addBatch({ geometry, count, instanceArray, roomX, roomY, exact, water = false }: {
    geometry: BufferGeometry | null | undefined;
    count: number;
    instanceArray: ArrayLike<number>;
    roomX: number;
    roomY: number;
    exact: any;
    water?: boolean;
  }): void {
    if (!geometry?.boundingBox) geometry?.computeBoundingBox?.();
    const bb = geometry?.boundingBox;
    if (!bb || !count) return;
    const roomId = Number(exact.room);
    if (roomId !== this._openRoom) {
      this._closeRoomRange();
      this._openRoom = roomId;
      this._openStart = this._count;
    }
    const catIndex = Math.max(0, WORLD_CATEGORIES.indexOf(exact.category)) & PICK_CATEGORY_MASK;
    const z = Math.max(0, Math.min(255, Math.round(Number(exact.z) || 0) + PICK_Z_BIAS));
    const baseMeta = catIndex
      | (exact.sourceKind === 'spawn' ? PICK_SPAWN_BIT : 0)
      | (exact.untextured ? PICK_UNTEXTURED_BIT : 0)
      | (water ? PICK_WATER_BIT : 0)
      | (z << PICK_Z_SHIFT);
    const meshId = ((Number(exact.mesh) >>> 0) & 0x7fffffff)
      | (exact.reflectLocalX ? 0x80000000 : 0);
    const bnx = bb.min.x; const bny = bb.min.y; const bnz = bb.min.z;
    const bxx = bb.max.x; const bxy = bb.max.y; const bxz = bb.max.z;

    for (let i = 0; i < count; i++) {
      if (!this._segment || this._segmentUsed === SEGMENT) {
        this._segment = newSegment();
        this._segments.push(this._segment);
        this._segmentUsed = 0;
      }
      const s = this._segment;
      const at = this._segmentUsed++;
      const e = instanceArray;
      const o = i * 16;
      const linear = this._internLinear(
        e[o], e[o + 1], e[o + 2], e[o + 4], e[o + 5], e[o + 6],
        e[o + 8], e[o + 9], e[o + 10],
      );
      const px = e[o + 12] + roomX;
      const py = e[o + 13] + roomY;
      const pz = e[o + 14];
      s.pos[at * 3] = px;
      s.pos[at * 3 + 1] = py;
      s.pos[at * 3 + 2] = pz;
      s.linear[at] = linear;
      s.room[at] = roomId >>> 0;
      s.rowIdx[at] = Number(exact.placementIndices?.[i] ?? 0) >>> 0;
      s.meshId[at] = meshId >>> 0;
      s.meta[at] = baseMeta >>> 0;
      // world AABB of geometry bbox under the affine [A|b] (per-row abs trick)
      const a = this._linears[linear];
      const base = at * 6;
      for (let j = 0; j < 3; j++) {
        const a0 = a[j]; const a1 = a[3 + j]; const a2 = a[6 + j];
        const t = j === 0 ? px : j === 1 ? py : pz;
        s.aabb[base + j] = t
          + Math.min(a0 * bnx, a0 * bxx) + Math.min(a1 * bny, a1 * bxy)
          + Math.min(a2 * bnz, a2 * bxz);
        s.aabb[base + 3 + j] = t
          + Math.max(a0 * bnx, a0 * bxx) + Math.max(a1 * bny, a1 * bxy)
          + Math.max(a2 * bnz, a2 * bxz);
      }
      this._count++;
    }
  }

  /** Concatenate segments and build the uniform XY grid (CSR layout). */
  finalize(): void {
    this._closeRoomRange();
    this._openRoom = null;
    const n = this._count;
    this.aabb = new Float32Array(n * 6);
    this.pos = new Float32Array(n * 3);
    this.linear = new Uint32Array(n);
    this.room = new Uint32Array(n);
    this.rowIdx = new Uint32Array(n);
    this.meshId = new Uint32Array(n);
    this.meta = new Uint32Array(n);
    let at = 0;
    for (let s = 0; s < this._segments.length; s++) {
      const seg = this._segments[s];
      const used = s === this._segments.length - 1
        ? this._count - at
        : SEGMENT;
      this.aabb.set(seg.aabb.subarray(0, used * 6), at * 6);
      this.pos.set(seg.pos.subarray(0, used * 3), at * 3);
      this.linear.set(seg.linear.subarray(0, used), at);
      this.room.set(seg.room.subarray(0, used), at);
      this.rowIdx.set(seg.rowIdx.subarray(0, used), at);
      this.meshId.set(seg.meshId.subarray(0, used), at);
      this.meta.set(seg.meta.subarray(0, used), at);
      at += used;
    }
    this._segments = [];
    this._segment = null;
    this._segmentUsed = 0;

    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const b = i * 6;
      if (this.aabb[b] < minX) minX = this.aabb[b];
      if (this.aabb[b + 1] < minY) minY = this.aabb[b + 1];
      if (this.aabb[b + 2] < minZ) minZ = this.aabb[b + 2];
      if (this.aabb[b + 3] > maxX) maxX = this.aabb[b + 3];
      if (this.aabb[b + 4] > maxY) maxY = this.aabb[b + 4];
      if (this.aabb[b + 5] > maxZ) maxZ = this.aabb[b + 5];
    }
    if (!n) { minX = minY = minZ = 0; maxX = maxY = maxZ = 1; }
    this._bounds = [minX, minY, minZ, maxX, maxY, maxZ];
    this._minX = minX;
    this._minY = minY;
    this._gridX = Math.max(1, Math.min(MAX_GRID, Math.ceil((maxX - minX) / this.cellUnits) || 1));
    this._gridY = Math.max(1, Math.min(MAX_GRID, Math.ceil((maxY - minY) / this.cellUnits) || 1));

    const cells = this._gridX * this._gridY;
    const counts = new Uint32Array(cells + 1);
    const cellOf = (x: number, y: number) => {
      const cx = Math.max(0, Math.min(this._gridX - 1, Math.floor((x - this._minX) / this.cellUnits)));
      const cy = Math.max(0, Math.min(this._gridY - 1, Math.floor((y - this._minY) / this.cellUnits)));
      return cy * this._gridX + cx;
    };
    for (let i = 0; i < n; i++) {
      const b = i * 6;
      const c0 = cellOf(this.aabb[b], this.aabb[b + 1]);
      const c1 = cellOf(this.aabb[b + 3], this.aabb[b + 4]);
      const x0 = c0 % this._gridX; const y0 = (c0 / this._gridX) | 0;
      const x1 = c1 % this._gridX; const y1 = (c1 / this._gridX) | 0;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) counts[cy * this._gridX + cx + 1]++;
      }
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this._cellStarts = counts;
    this._cellEntries = new Uint32Array(counts[cells]);
    const cursor = counts.slice(0, cells);
    for (let i = 0; i < n; i++) {
      const b = i * 6;
      const c0 = cellOf(this.aabb[b], this.aabb[b + 1]);
      const c1 = cellOf(this.aabb[b + 3], this.aabb[b + 4]);
      const x0 = c0 % this._gridX; const y0 = (c0 / this._gridX) | 0;
      const x1 = c1 % this._gridX; const y1 = (c1 / this._gridX) | 0;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) this._cellEntries[cursor[cy * this._gridX + cx]++] = i;
      }
    }
    this._stamp = new Uint32Array(n);
    this._stampToken = 0;
    this._moved = new Set();
    this.ready = true;
  }

  _slab(
    i: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    tMax: number,
  ): number {
    const b = i * 6;
    let t0 = 0;
    let t1 = tMax;
    for (let j = 0; j < 3; j++) {
      const o = j === 0 ? ox : j === 1 ? oy : oz;
      const d = j === 0 ? dx : j === 1 ? dy : dz;
      const lo = this.aabb[b + j];
      const hi = this.aabb[b + 3 + j];
      if (Math.abs(d) < 1e-12) {
        if (o < lo || o > hi) return -1;
        continue;
      }
      const inv = 1 / d;
      let near = (lo - o) * inv;
      let far = (hi - o) * inv;
      if (near > far) { const swap = near; near = far; far = swap; }
      if (near > t0) t0 = near;
      if (far < t1) t1 = far;
      if (t0 > t1) return -1;
    }
    return t0;
  }

  /**
   * Broad-phase raycast: origin/direction in native world units (direction
   * normalized). Returns candidates sorted by AABB entry distance; `filter`
   * receives each entry's raw meta word. Deleted entries never match.
   */
  raycast(
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
    { filter = null, maxCandidates = 24 }: {
      filter?: ((meta: number) => boolean) | null;
      maxCandidates?: number;
    } = {},
  ): PickCandidate[] {
    if (!this.ready || !this._count) return [];
    const ox = origin.x; const oy = origin.y; const oz = origin.z;
    const dx = direction.x; const dy = direction.y; const dz = direction.z;
    const B = this._bounds;
    // clip to the global bounds
    let tEnter = 0;
    let tExit = Infinity;
    for (let j = 0; j < 3; j++) {
      const o = j === 0 ? ox : j === 1 ? oy : oz;
      const d = j === 0 ? dx : j === 1 ? dy : dz;
      if (Math.abs(d) < 1e-12) {
        if (o < B[j] || o > B[3 + j]) return [];
        continue;
      }
      const inv = 1 / d;
      let near = (B[j] - o) * inv;
      let far = (B[3 + j] - o) * inv;
      if (near > far) { const swap = near; near = far; far = swap; }
      if (near > tEnter) tEnter = near;
      if (far < tExit) tExit = far;
      if (tEnter > tExit) return [];
    }
    const token = ++this._stampToken;
    const candidates: PickCandidate[] = [];
    const testEntry = (i: number) => {
      if (this._stamp[i] === token) return;
      this._stamp[i] = token;
      const meta = this.meta[i];
      if (meta & PICK_DELETED_BIT) return;
      if (filter && !filter(meta)) return;
      const t = this._slab(i, ox, oy, oz, dx, dy, dz, tExit);
      if (t >= 0) candidates.push({ index: i, tNear: t });
    };

    // 2D DDA over the XY grid between tEnter and tExit
    const cell = this.cellUnits;
    let px = ox + dx * tEnter;
    let py = oy + dy * tEnter;
    let cx = Math.max(0, Math.min(this._gridX - 1, Math.floor((px - this._minX) / cell)));
    let cy = Math.max(0, Math.min(this._gridY - 1, Math.floor((py - this._minY) / cell)));
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tDeltaX = stepX ? Math.abs(cell / dx) : Infinity;
    const tDeltaY = stepY ? Math.abs(cell / dy) : Infinity;
    let tMaxX = stepX
      ? tEnter + ((stepX > 0 ? (cx + 1) * cell + this._minX - px : px - (cx * cell + this._minX)) / Math.abs(dx || 1))
      : Infinity;
    let tMaxY = stepY
      ? tEnter + ((stepY > 0 ? (cy + 1) * cell + this._minY - py : py - (cy * cell + this._minY)) / Math.abs(dy || 1))
      : Infinity;
    let tCell = tEnter;
    let guard = this._gridX + this._gridY + 4;
    while (guard-- > 0) {
      const c = cy * this._gridX + cx;
      for (let k = this._cellStarts[c]; k < this._cellStarts[c + 1]; k++) {
        testEntry(this._cellEntries[k]);
      }
      // near-enough early exit: later cells can only add farther candidates
      if (candidates.length >= 4) {
        let earliest = Infinity;
        for (const candidate of candidates) if (candidate.tNear < earliest) earliest = candidate.tNear;
        if (tCell > earliest + cell * 4) break;
      }
      if (tMaxX < tMaxY) {
        tCell = tMaxX;
        tMaxX += tDeltaX;
        cx += stepX;
        if (cx < 0 || cx >= this._gridX) break;
      } else {
        tCell = tMaxY;
        tMaxY += tDeltaY;
        cy += stepY;
        if (cy < 0 || cy >= this._gridY) break;
      }
      if (tCell > tExit) break;
    }
    // moved entries live outside their build-time grid cells: test them all
    for (const i of this._moved) testEntry(i);

    candidates.sort((a, b) => a.tNear - b.tNear);
    if (candidates.length > maxCandidates) candidates.length = maxCandidates;
    return candidates;
  }

  /** Decode one entry's provenance. */
  ref(index: number): PickRef {
    const meta = this.meta[index];
    const meshId = this.meshId[index];
    return {
      index,
      room: this.room[index],
      placementIndex: this.rowIdx[index],
      sourceKind: (meta & PICK_SPAWN_BIT) ? 'spawn' : 'occurrence',
      category: WORLD_CATEGORIES[meta & PICK_CATEGORY_MASK],
      mesh: meshId & 0x7fffffff,
      reflect: !!(meshId & 0x80000000),
      z: pickMetaZ(meta),
      deleted: !!(meta & PICK_DELETED_BIT),
      untextured: !!(meta & PICK_UNTEXTURED_BIT),
      water: !!(meta & PICK_WATER_BIT),
    };
  }

  /** Rebuild the exact composed matrix (native units, room offset included). */
  matrix(index: number, target: Matrix4): Matrix4 {
    const a = this._linears[this.linear[index]];
    const p = index * 3;
    target.set(
      a[0], a[3], a[6], this.pos[p],
      a[1], a[4], a[7], this.pos[p + 1],
      a[2], a[5], a[8], this.pos[p + 2],
      0, 0, 0, 1,
    );
    return target;
  }

  /** Session edit: move an entry to a new composed matrix, updating its AABB. */
  setMatrix(index: number, matrix: Matrix4, boundingBox?: Box3 | null): void {
    const e = matrix.elements;
    this.linear[index] = this._internLinear(
      Math.fround(e[0]), Math.fround(e[1]), Math.fround(e[2]),
      Math.fround(e[4]), Math.fround(e[5]), Math.fround(e[6]),
      Math.fround(e[8]), Math.fround(e[9]), Math.fround(e[10]),
    );
    const p = index * 3;
    this.pos[p] = e[12];
    this.pos[p + 1] = e[13];
    this.pos[p + 2] = e[14];
    if (boundingBox) {
      const a = this._linears[this.linear[index]];
      const b = index * 6;
      const bn = [boundingBox.min.x, boundingBox.min.y, boundingBox.min.z];
      const bx = [boundingBox.max.x, boundingBox.max.y, boundingBox.max.z];
      for (let j = 0; j < 3; j++) {
        const a0 = a[j]; const a1 = a[3 + j]; const a2 = a[6 + j];
        const t = this.pos[p + j];
        this.aabb[b + j] = t
          + Math.min(a0 * bn[0], a0 * bx[0]) + Math.min(a1 * bn[1], a1 * bx[1])
          + Math.min(a2 * bn[2], a2 * bx[2]);
        this.aabb[b + 3 + j] = t
          + Math.max(a0 * bn[0], a0 * bx[0]) + Math.max(a1 * bn[1], a1 * bx[1])
          + Math.max(a2 * bn[2], a2 * bx[2]);
      }
    }
    this._moved.add(index);
  }

  markDeleted(index: number, deleted: boolean): void {
    if (deleted) this.meta[index] |= PICK_DELETED_BIT;
    else this.meta[index] &= ~PICK_DELETED_BIT >>> 0;
  }

  /** Capture an entry's mutable state (for exact session-edit reset). */
  snapshot(index: number): PickSnapshot {
    return {
      linear: this.linear[index],
      pos: [this.pos[index * 3], this.pos[index * 3 + 1], this.pos[index * 3 + 2]],
      aabb: Array.from(this.aabb.subarray(index * 6, index * 6 + 6)),
      meta: this.meta[index],
      moved: this._moved.has(index),
    };
  }

  restore(index: number, snapshot: PickSnapshot): void {
    this.linear[index] = snapshot.linear;
    this.pos.set(snapshot.pos, index * 3);
    this.aabb.set(snapshot.aabb, index * 6);
    this.meta[index] = snapshot.meta;
    if (!snapshot.moved) this._moved.delete(index);
  }

  /** Locate the entry for one placement row (scans the room's ranges). */
  find({ room, sourceKind, category, placementIndex }: {
    room: number | string;
    sourceKind: string;
    category: string;
    placementIndex: number | string;
  }): number {
    const ranges = this._roomRanges.get(Number(room));
    if (!ranges) return -1;
    const wantSpawn = sourceKind === 'spawn';
    const wantCat = WORLD_CATEGORIES.indexOf(category);
    const wantRow = Number(placementIndex) >>> 0;
    for (const [start, end] of ranges) {
      for (let i = start; i < end; i++) {
        if (this.rowIdx[i] !== wantRow) continue;
        const meta = this.meta[i];
        if (!!(meta & PICK_SPAWN_BIT) !== wantSpawn) continue;
        if ((meta & PICK_CATEGORY_MASK) !== wantCat) continue;
        return i;
      }
    }
    return -1;
  }

  stats(): {
    ready: boolean;
    entries: number;
    linears: number;
    cells: number;
    grid: [number, number];
    moved: number;
    bytes: number;
  } {
    const arrays = [
      this.aabb, this.pos, this.linear, this.room, this.rowIdx,
      this.meshId, this.meta, this._cellStarts, this._cellEntries, this._stamp,
    ];
    let bytes = 0;
    for (const array of arrays) bytes += array?.byteLength || 0;
    bytes += this._linears.length * (36 + 16);
    return {
      ready: this.ready,
      entries: this._count,
      linears: this._linears.length,
      cells: this._gridX * this._gridY,
      grid: [this._gridX, this._gridY],
      moved: this._moved.size,
      bytes,
    };
  }
}

export default WorldPickIndex;
