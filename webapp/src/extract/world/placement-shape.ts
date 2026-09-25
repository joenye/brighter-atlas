// Where rooms, water and tiles keep their values, read from the user's own
// bundles by shape (the same rule on every build). Record types are anchored
// by the type table's ids, which stay the same from build to build.
import { typesWithId, type TypeTable } from '../datatable.js';
import { deref, type RoomNode } from './room.js';
import { resolveValue } from './room-metadata.js';
import type { ConstructorRecord, FillRow } from './replay.js';
import type { PoolNode } from './value-pool.js';
import type { WaterDecodeData } from './water-materials.js';
import type { TileDecodeData } from './tile-colour.js';
import type { PlacementDecodeData } from './placement.js';

const TYPE = {
  waterSurface: '4c1bde37579be240',
  waterCurtain: '69de5442b0f6368c',
  variedBlocks: '43910bfd0081cae2',
  defaultGround: '04a48441fcb46048',
};
/** Constructor value holding a record's type. */
const TYPE_VALUE = 2;

type Decode = (slot: number) => { op: number; kind: string; node?: any }[] | null;
interface Registry { rows: FillRow[]; objects: ConstructorRecord[]; pool: PoolNode[]; decode: Decode; types: TypeTable }

const tally = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

function generic(reg: Registry, slot: number): Map<number, PoolNode> {
  const out = new Map<number, PoolNode>();
  let fields: ReturnType<Decode> = null;
  try { fields = reg.decode(slot); } catch { fields = null; }
  for (const f of fields ?? []) {
    if (f.kind !== 'G') continue;
    const n = resolveValue(reg.pool, f.node);
    if (n) out.set(f.op, n);
  }
  return out;
}

/** The one type with this id, or -1. */
function typeOf(reg: Registry, id: string): number {
  const found = typesWithId(reg.types, id);
  return found.length === 1 ? found[0] : -1;
}
const recordType = (reg: Registry, slot: number) => reg.objects[slot]?.values?.[TYPE_VALUE] as number | undefined;
/** Runtimes of the records whose type lies under this type. */
function runtimesUnder(reg: Registry, type: number): Set<number> {
  const end = reg.types.ends[type], out = new Set<number>();
  for (const row of reg.rows) {
    const t = recordType(reg, row.slot);
    if (t !== undefined && t > type && t <= end) out.add(row.runtime);
  }
  return out;
}
const opsOfTag = (f: Map<number, PoolNode>, tag: number) => [...f].filter(([, n]) => n.tag === tag).map(([op]) => op);

/** Water: the two water material classes, the reference that links a
 *  standard material to one, and the style and texture records they use.
 *  The style's value order is the engine's (checked by its field kinds). */
export function waterLayout(reg: Registry): WaterDecodeData | null {
  const surfaceType = typeOf(reg, TYPE.waterSurface), curtainType = typeOf(reg, TYPE.waterCurtain);
  if (surfaceType < 0 || curtainType < 0) return null;
  const surfaces = runtimesUnder(reg, surfaceType), curtains = runtimesUnder(reg, curtainType);
  if (surfaces.size !== 1 || curtains.size !== 1) return null;
  const surface = [...surfaces][0], curtain = [...curtains][0];
  const firstRow = (rt: number) => reg.rows.find((r) => r.runtime === rt)!;
  const waterFields = generic(reg, firstRow(surface).slot);
  const styleOps = opsOfTag(waterFields, 0x26);
  if (styleOps.length !== 1 || waterFields.size !== 1) return null;
  const style = styleOps[0];
  // links: the reference field of the records pointing at water materials
  const links = new Map<string, number>();
  for (const row of reg.rows) {
    for (const [op, ref] of row.r ?? []) {
      const rt = reg.rows[ref]?.runtime;
      if (rt === surface || rt === curtain) tally(links, `${row.runtime}:${op}`);
    }
  }
  const fields = new Set([...links.keys()].map((k) => Number(k.split(':')[1])));
  if (fields.size !== 1) return null;
  const families = [...new Set([...links.keys()].map((k) => Number(k.split(':')[0])))].sort((a, b) => a - b);
  const linking = reg.rows.find((r) => r.runtime === families[0] && (r.r ?? []).some(([, ref]) => {
    const rt = reg.rows[ref]?.runtime;
    return rt === surface || rt === curtain;
  }));
  if (!linking) return null;
  const material = generic(reg, linking.slot);
  const opacity = opsOfTag(material, 0x0b), rect = opsOfTag(material, 0x3c);
  if (opacity.length !== 1 || rect.length !== 1) return null;
  const styleSlot = (waterFields.get(style)!.value as number);
  const styleRow = reg.rows[styleSlot];
  if (!styleRow) return null;
  // the style: colour, two images, four pairs, nine scalars
  const s = generic(reg, styleRow.slot);
  const kinds = [...Array(16)].map((_, k) => s.get(k + 1)?.tag);
  const expected = [0x15, 0x02, 0x02, 0x18, 0x18, 0x18, 0x18, ...Array(9).fill(0x0b)];
  if (kinds.some((t, k) => t !== expected[k])) return null;
  const texture = (op: number) => {
    const slot = s.get(op)!.value as number;
    const row = reg.rows[slot];
    const image = row ? opsOfTag(generic(reg, slot), 0x47) : [];
    return row && image.length === 1 ? { family: row.runtime, image: image[0] } : null;
  };
  const plane = texture(2), cube = texture(3);
  if (!plane || !cube) return null;
  return {
    link: { families, field: [...fields][0] }, surface, curtain, style, opacity: opacity[0], textureRect: rect[0],
    styleFields: { colour: 1, normal: 2, cube: 3, uv0: [4, 5], uv1: [6, 7], amplitude: [8, 12], frequency: [9, 13],
      rate: [10, 14], tilt: [11, 15], level: 16 },
    textures: { plane, cube }, waterLevel: 1024,
  };
}

/** Room owner records: the one record naming each room's asset. */
export function roomOwners(reg: Registry, roomIds: Set<number>): Map<number, number> {
  const handles = new Map<number, number[]>();
  for (const row of reg.rows) {
    for (const [, depth, tag, value] of row.g ?? []) {
      if (depth === 0 && tag === 0x13 && roomIds.has(value as number)) {
        let list = handles.get(value as number);
        if (!list) handles.set(value as number, list = []);
        list.push(row.slot);
      }
    }
  }
  const owners = new Map<number, number>();   // owner slot -> room
  for (const [room, slots] of handles) if (slots.length === 1) owners.set(slots[0], room);
  return owners;
}

/** Tiles: the owner's colour seed field, the blocks whose top faces vary
 *  (a type subtree and its enabling flag) and the default ground record. */
export function tileLayout(reg: Registry, profile: { selectors: Record<string, { fill: string[] }> }, owners: Map<number, number>): TileDecodeData | null {
  const seeds = new Map<number, number>();
  for (const slot of owners.keys()) {
    const pairs = opsOfTag(generic(reg, slot), 0x85);
    if (pairs.length === 1) tally(seeds, pairs[0]);
  }
  if (seeds.size !== 1) return null;
  const varied = typeOf(reg, TYPE.variedBlocks), ground = typeOf(reg, TYPE.defaultGround);
  if (varied < 0 || ground < 0) return null;
  const end = reg.types.ends[varied];
  const lastOps = new Set<number>();
  let defaultGround = -1, grounds = 0;
  for (const row of reg.rows) {
    const t = recordType(reg, row.slot);
    if (t === undefined) continue;
    if (t >= varied && t <= end) lastOps.add(profile.selectors[row.selector].fill.length - 1);
    if (t === ground) { defaultGround = row.slot; grounds++; }
  }
  if (lastOps.size !== 1 || grounds !== 1) return null;
  const half = Math.fround(127 / 255);
  return {
    seed: [...seeds.keys()][0],
    variation: { typeValue: TYPE_VALUE, types: [varied, end], flag: [...lastOps][0] },
    defaultGround, neutral: [half, half, half, 1],
  };
}

/** Room records: the grid size, origin and height words by kind, and the
 *  owner field listing linked rooms (the one whose lists name the most
 *  owners). */
export function roomLayout(reg: Registry, rooms: Map<number, { top: RoomNode[]; table: RoomNode[] }>,
  owners: Map<number, number>): Pick<PlacementDecodeData, 'rooms' | 'actors'> | null {
  let layout: PlacementDecodeData['rooms'] | null = null;
  for (const room of rooms.values()) {
    const fields = room.top.slice(room.table.length).map((f) => deref(f, room.table));
    const ints = fields.map((f, i) => (f.kind === 'lit' && f.tag === 0x0a ? i : -1)).filter((i) => i >= 0);
    const origins = fields.map((f, i) => (f.kind === 'lit' && f.tag === 0x2e ? i : -1)).filter((i) => i >= 0);
    if (ints.length < 2 || origins.length !== 1) return null;
    const cells = (fields[ints[0]].value as number) * (fields[ints[1]].value as number);
    const words = fields.findIndex((f) => f.kind === 'array' && f.elems?.length === cells && cells > 0
      && f.elems.every((e: RoomNode) => deref(e, room.table).tag === 0x0a));
    if (words < 0) return null;
    const next = { fieldCount: fields.length, width: ints[0], height: ints[1], origin: origins[0], words, links: 0 };
    if (layout && JSON.stringify(layout) !== JSON.stringify(next)) return null;
    layout = next;
  }
  if (!layout) return null;
  const ownerRuntimes = new Set([...owners.keys()].map((s) => reg.rows[s].runtime));
  const ownerLike = (slot: number) => ownerRuntimes.has(reg.rows[slot]?.runtime);
  const links = new Map<number, number>();
  for (const slot of owners.keys()) {
    for (const [op, n] of generic(reg, slot)) {
      if (n.tag !== 0x20 || !Array.isArray(n.values)) continue;
      for (const v of n.values) {
        const r = resolveValue(reg.pool, v);
        if (r?.tag === 0x26 && ownerLike(r.value as number)) links.set(op, (links.get(op) ?? 0) + 1);
      }
    }
  }
  const ranked = [...links].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked.length > 1 && ranked[1][1] * 10 > ranked[0][1])) return null;
  layout.links = ranked[0][0];
  return { rooms: layout, actors: { parent: 0 } };
}
