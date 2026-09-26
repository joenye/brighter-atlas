// The ground plane: the textured floor the game lays at z = 0 under and
// around a room (its own name for it is the table). Each episode names its
// floor; each tile's ground then keeps that floor, removes it (most ground
// does: the room's own terrain covers it) or replaces it with its own (sea
// and river beds, seen through the water). Record types are anchored by the
// type table's ids and fields found by value shape, as in placement-shape.ts.
import { typesWithId, type TypeTable } from '../datatable.js';
import { resolveValue } from './room-metadata.js';
import type { ConstructorRecord, FillRow } from './replay.js';
import type { PoolNode } from './value-pool.js';
import type { RoomOccurrence } from './room.js';

const TYPE = { blocks: '3a66e596d656415a' };
/** The ground values that keep the episode's floor, or remove it. */
const KEEP = '$no_override', REMOVE = '$remove_table';
/** Constructor value holding a record's type. */
const TYPE_VALUE = 2;
/** A deciding block's shape list starts with this member of its enum. */
const DECIDING_KIND = 1;

type Decode = (slot: number) => { op: number; kind: string; node?: any }[] | null;
interface Registry { rows: FillRow[]; objects: ConstructorRecord[]; pool: PoolNode[]; decode: Decode; types: TypeTable }

/** Where this build keeps the ground plane's values. */
export interface GroundPlaneLayout {
  keep: number;
  remove: number;
  /** The inline record class of a floor. */
  recordClass: number;
  /** ground runtime -> the field holding its floor value */
  groundField: Record<number, number>;
  /** Every block's own ground field and its shape list field (blocks share
   *  them). */
  blockGround: number;
  blockKind: number;
  /** The enum row a deciding block's shape list names first. */
  kindRow: number;
  blockTypes: [number, number];
}

/** One floor: its material and image, colour, the tiles one texture repeat
 *  spans, whether the room's area colours tint it, and its darker variant
 *  (a record index) shown for rooms beside the one the player is in. */
export interface GroundPlaneRecord {
  material: number;
  texture: number;
  colour: number[];
  repeat: number;
  tint: boolean;
  alternate: number | null;
}

/** A room's ground plane: the floors (the first is the episode's) and one
 *  value per tile, row by row: 0 the episode's floor, 1 none, n >= 2 the
 *  floor records[n - 1]. */
export interface RoomGroundPlane {
  records: GroundPlaneRecord[];
  tiles: Uint8Array;
}

class Fields {
  private cache = new Map<number, Map<number, PoolNode>>();
  constructor(private reg: Registry) {}
  get(slot: number): Map<number, PoolNode> {
    let out = this.cache.get(slot);
    if (out) return out;
    out = new Map();
    let fields: ReturnType<Decode> = null;
    try { fields = this.reg.decode(slot); } catch { fields = null; }
    for (const f of fields ?? []) {
      if (f.kind !== 'G') continue;
      const n = resolveValue(this.reg.pool, f.node);
      if (n) out.set(f.op, n);
    }
    this.cache.set(slot, out);
    return out;
  }
  node(n: PoolNode | undefined): PoolNode | null { return resolveValue(this.reg.pool, n); }
}

const refOf = (n: PoolNode | null) => (n?.tag === 0x26 && Number.isInteger(n.value) ? n.value as number : null);

/** A floor record: material, colour, repeat, an alternate (itself a floor, or
 *  a symbol) and a flag. */
function floorShaped(f: Fields, n: PoolNode | null, cls: number | null = null): boolean {
  if (n?.tag !== 0x24 || (cls !== null && n.class !== cls) || n.fields?.length !== 5) return false;
  const [material, colour, repeat, alternate, flag] = n.fields.map((x) => f.node(x));
  return material?.tag === 0x02 && colour?.tag === 0x15 && Array.isArray(colour.value) && colour.value.length === 4
    && repeat?.tag === 0x0a && Number.isInteger(repeat.value) && repeat.value > 0
    && (alternate?.tag === 0x0f || (alternate?.tag === 0x24 && alternate.class === n.class))
    && (flag?.tag === 0x0c || flag?.tag === 0x0d);
}

/** The one op common to every row of a runtime, or null. */
function commonOp(candidates: Map<number, Set<number>[]>): Record<number, number> | null {
  const out: Record<number, number> = {};
  for (const [runtime, sets] of candidates) {
    if (!sets.length) return null;
    let common: number[] = [...sets[0]];
    for (const s of sets) common = common.filter((op) => s.has(op));
    if (common.length !== 1) return null;
    out[runtime] = common[0];
  }
  return out;
}

/** This build's ground plane layout, from the grounds and blocks the rooms
 *  place; null when the data does not show one. */
export function groundPlaneLayout(reg: Registry, symbols: string[], occurrences: Iterable<RoomOccurrence[]>): GroundPlaneLayout | null {
  const keep = symbols.indexOf(KEEP), remove = symbols.indexOf(REMOVE);
  const types = typesWithId(reg.types, TYPE.blocks);
  if (keep < 0 || remove < 0 || types.length !== 1) return null;
  const blockTypes: [number, number] = [types[0], reg.types.ends[types[0]]];
  const isBlock = (slot: number) => {
    const t = reg.objects[slot]?.values?.[TYPE_VALUE];
    return t !== undefined && t >= blockTypes[0] && t <= blockTypes[1];
  };
  const f = new Fields(reg);
  const grounds = new Set<number>(), blocks = new Set<number>();
  for (const list of occurrences) {
    for (const o of list) {
      if (o.secondary !== null && reg.rows[o.secondary]) grounds.add(o.secondary);
      if (reg.rows[o.resource] && isBlock(o.resource)) blocks.add(o.resource);
    }
  }
  // grounds: the field holding keep, remove or a floor in every ground of a
  // runtime, and remove or a floor in at least one (other fields keep too)
  let recordClass: number | null = null;
  const groundCandidates = new Map<number, Set<number>[]>(), deciding = new Map<number, Set<number>>();
  for (const g of grounds) {
    const ops = new Set<number>();
    const runtime = reg.rows[g].runtime;
    if (!deciding.has(runtime)) deciding.set(runtime, new Set());
    for (const [op, n] of f.get(g)) {
      if (n.tag === 0x0f && (n.value === keep || n.value === remove)) {
        ops.add(op);
        if (n.value === remove) deciding.get(runtime)!.add(op);
      } else if (floorShaped(f, n, recordClass)) {
        ops.add(op); recordClass ??= n.class!;
        deciding.get(runtime)!.add(op);
      }
    }
    if (!groundCandidates.has(runtime)) groundCandidates.set(runtime, []);
    groundCandidates.get(runtime)!.push(ops);
  }
  for (const [runtime, sets] of groundCandidates) sets.push(deciding.get(runtime)!);
  const groundField = commonOp(groundCandidates);
  if (!groundField || recordClass === null) return null;
  const groundRuntimes = new Set(Object.keys(groundField).map(Number));
  // blocks: their own ground (a ground after their material and two colours;
  // the first such run is the block's own), and the shape list whose first
  // entry names a kind; every block has them at the same fields
  let groundOps: number[] | null = null, kindOps: number[] | null = null;
  const kindOf = (n: PoolNode | null | undefined) => {
    const first = n?.tag === 0x20 && n.values?.length ? f.node(n.values[0]) : null;
    const k = first?.tag === 0x24 ? refOf(f.node(first.fields?.[0])) : null;
    return k !== null && reg.rows[k] ? k : null;
  };
  for (const b of blocks) {
    const ground = new Set<number>(), kind = new Set<number>();
    const bf = f.get(b);
    for (const [op, n] of bf) {
      const ref = refOf(n);
      if (ref !== null && groundRuntimes.has(reg.rows[ref]?.runtime) && bf.get(op - 3)?.tag === 0x02
        && bf.get(op - 2)?.tag === 0x15 && bf.get(op - 1)?.tag === 0x15) ground.add(op);
      if (kindOf(n) !== null) kind.add(op);
    }
    if (ground.size) groundOps = groundOps === null ? [...ground] : groundOps.filter((op) => ground.has(op));
    if (kind.size) kindOps = kindOps === null ? [...kind] : kindOps.filter((op) => kind.has(op));
  }
  if (!groundOps?.length || kindOps?.length !== 1) return null;
  const blockGround = Math.min(...groundOps), blockKind = kindOps[0];
  const kinds = new Set<number>();
  for (const b of blocks) {
    const k = kindOf(f.get(b).get(blockKind));
    if (k !== null) kinds.add(k);
  }
  // the kind enum: consecutive rows of one runtime numbered by their value
  const valueOf = (slot: number) => {
    const v = reg.rows[slot]?.v.find(([op, kind]) => op > 0 && kind === 'U');
    return v ? v[2] : null;
  };
  const enumRuntimes = new Set([...kinds].map((k) => reg.rows[k].runtime));
  if (enumRuntimes.size !== 1) return null;
  let kindRow: number | null = null;
  for (const k of kinds) {
    const v = valueOf(k);
    if (v === null) continue;
    const candidate = k - v + DECIDING_KIND;
    if (reg.rows[candidate]?.runtime === reg.rows[k].runtime && valueOf(candidate) === DECIDING_KIND) {
      if (kindRow !== null && kindRow !== candidate) return null;
      kindRow = candidate;
    }
  }
  if (kindRow === null) return null;
  return { keep, remove, recordClass, groundField, blockGround, blockKind, kindRow, blockTypes };
}

/** The ground plane of one room placed in its episode's record. `skip`:
 *  the individuals whose items never decide a tile (those carrying entries
 *  in their third field). */
export function roomGroundPlane(
  layout: GroundPlaneLayout, reg: Registry, occurrences: RoomOccurrence[], width: number, height: number,
  episode: number, texturesByMaterial: Map<number, number[]>, skip: Set<number> = new Set(),
): RoomGroundPlane | null {
  const f = new Fields(reg);
  const records: GroundPlaneRecord[] = [];
  const recordIndex = new Map<string, number>();
  const floor = (n: PoolNode | null): number | null => {
    if (!floorShaped(f, n, layout.recordClass)) return null;
    const [material, colour, repeat, alternate, flag] = n!.fields!.map((x) => f.node(x));
    const textures = texturesByMaterial.get(material!.value);
    const alt = alternate?.tag === 0x24 ? floor(alternate) : null;
    const record: GroundPlaneRecord = {
      material: material!.value, texture: textures?.length === 1 ? textures[0] : -1,
      colour: (colour!.value as number[]).map(Number),
      repeat: repeat!.value, tint: flag!.tag === 0x0c, alternate: alt,
    };
    const key = JSON.stringify(record);
    let at = recordIndex.get(key);
    if (at === undefined) { at = records.length; records.push(record); recordIndex.set(key, at); }
    return at;
  };
  // the episode's floor comes first
  let own: number | null = null;
  for (const n of f.get(episode).values()) {
    if (floorShaped(f, n, layout.recordClass)) { own = floor(n); break; }
  }
  if (own !== 0) return null;
  const valueOf = (o: RoomOccurrence): number | null => {
    const block = o.resource;
    const t = reg.objects[block]?.values?.[TYPE_VALUE];
    if (t === undefined || t < layout.blockTypes[0] || t > layout.blockTypes[1]) return null;
    const bf = f.get(block);
    const list = bf.get(layout.blockKind);
    const first = list?.tag === 0x20 && list.values?.length ? f.node(list.values[0]) : null;
    if (first?.tag !== 0x24 || refOf(f.node(first.fields?.[0])) !== layout.kindRow) return null;
    const ground = o.secondary ?? refOf(bf.get(layout.blockGround) ?? null);
    const field = ground === null ? undefined : layout.groundField[reg.rows[ground]?.runtime];
    const v = field === undefined ? null : f.get(ground!).get(field) ?? null;
    if (v?.tag === 0x0f) return v.value === layout.keep ? null : v.value === layout.remove ? 1 : null;
    const custom = floor(v);
    return custom === null ? null : custom === 0 ? 0 : custom + 1;
  };
  // per tile, the first deciding item of its ground layer, in the cell's order
  const byTile = new Map<number, RoomOccurrence[]>();
  for (const o of occurrences) {
    const [x, y, z] = o.cell;
    if (z !== 0 || x < 0 || y < 0 || x >= width || y >= height) continue;
    if (o.individual !== null && o.individual >= 0 && skip.has(o.individual)) continue;
    const tile = y * width + x;
    const list = byTile.get(tile);
    if (list) list.push(o); else byTile.set(tile, [o]);
  }
  const tiles = new Uint8Array(width * height);
  for (const [tile, list] of byTile) {
    list.sort((a, b) => a.entrySlot - b.entrySlot);
    for (const o of list) {
      const v = valueOf(o);
      if (v !== null) { tiles[tile] = v; break; }
    }
  }
  if (records.length > 254) return null;
  return { records, tiles };
}
