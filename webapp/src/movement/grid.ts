// A room's movement grid, as the game walks it.
//
// A room carries one or more movement groups. A group names the mover profiles it serves and holds two 64-bit
// words per tile of the mover's corner (layer 0 the ground, layer 1 an upper deck): for each of the 8 directions
// d (N, NE, E, SE, S, SW, W, NW; N is y - 1) the 6-bit cost of the step at bits 6d..6d+5 (0 no step, 1..62 the
// cost of the movement kind it takes, 63 a passage decided at run time) and the destination's layer at bit 48+d.
// The room's tile words carry the standing heights (half-tile levels) and the door edges.

export const DIRS: readonly [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
export const DIR_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
/** The direction index of a single step (dx, dy in -1..1, not both 0). */
export const dirOf = (dx: number, dy: number) => DIRS.findIndex(([x, y]) => x === dx && y === dy);

export interface MoveGroup {
  /** The mover profiles (registry slots) the group serves; the first sets the word stride's size. */
  profiles: number[];
  /** Each 64-bit word as its low and high halves: index ((y * (W - s + 1) + x) * 2 + layer). */
  lo: Uint32Array;
  hi: Uint32Array;
}
export interface RoomGrid {
  id: number;
  name?: string;
  W: number;
  H: number;
  /** The room's place on the world map (tiles): distances in the search are measured there. */
  origin: [number, number];
  /** Per tile (y * W + x): heights and doors. */
  words: Int32Array;
  groups: MoveGroup[];
  /** Door tiles (x, y, plane). */
  doors: [number, number, number][];
}

/** The 6-bit cost of the step in direction d from a word. */
export function costOf(g: MoveGroup, index: number, d: number): number {
  const lo = g.lo[index], hi = g.hi[index], b = 6 * d;
  if (b + 6 <= 32) return (lo >>> b) & 63;
  if (b >= 32) return (hi >>> (b - 32)) & 63;
  return ((lo >>> b) | (hi << (32 - b))) & 63;          // (d = 5: bits 30..35)
}
/** The layer (0 or 1) the step in direction d lands on. */
export const layerOf = (g: MoveGroup, index: number, d: number) => (g.hi[index] >>> (16 + d)) & 1;
export const wordIndex = (r: RoomGrid, x: number, y: number, layer: number, size = 1) => (y * (r.W - size + 1) + x) * 2 + layer;

/** The standing level (half tiles, 512 units each) of a tile's layer. */
export function levelOf(r: RoomGrid, x: number, y: number, layer: number): number {
  const w = r.words[y * r.W + x];
  if (layer === 0) return (w >> 4) & 15 ? w & 15 : 0;
  return (w >> 20) & 15 ? (w & 15) + ((w >> 4) & 15) + ((w >> 16) & 15) : 0;
}
/** The door edges of a tile's layer: 1 N, 2 E, 4 S, 8 W (a step out over one leaves the room). */
export const doorsOf = (r: RoomGrid, x: number, y: number, layer: number) => (r.words[y * r.W + x] >> (layer & 1 ? 24 : 8)) & 15;
/** Does the step (dx, dy) leave the room through one of the tile's door edges? */
export const leavesRoom = (door: number, dx: number, dy: number) =>
  !!((dy < 0 && door & 1) || (dx > 0 && door & 2) || (dy > 0 && door & 4) || (dx < 0 && door & 8));

/** The group a mover profile walks: the first that lists it, else the room's first. */
export function groupFor(r: RoomGrid, profile: number | null | undefined): number {
  const k = profile == null ? -1 : r.groups.findIndex(g => g.profiles.includes(profile));
  return k < 0 ? 0 : k;
}

// ---- reading it from a room parsed by the app's ab2 parser (extract/world/room.ts parse())

interface Node { kind: string; tag: number | null; value: any; cls: number | null; elems: Node[] | null }
const hexWord = (h: string): [number, number] => [parseInt(h.slice(8, 16), 16) >>> 0, parseInt(h.slice(0, 8), 16) >>> 0];

/** The grid of a parsed room ({top, table, nTable}), found by shape: the size, the map origin, the tile words (the
 *  first W x H array of integers), the door tiles, and the movement groups (records whose last field is an array of
 *  64-bit words sized for the room). Throws when a part is missing. */
export function readGrid(id: number, room: {nTable: number, top: Node[], table: Node[]}, name?: string): RoomGrid {
  const d = (n: Node): Node => n.kind === 'ref' ? room.table[n.value] : n;
  const T = room.top.slice(room.nTable).map(d);
  const W = T[0]?.value, H = T[1]?.value;
  if (!(Number.isInteger(W) && Number.isInteger(H) && W > 0 && H > 0)) throw Error(`room ${id}: no size`);
  const origin = T.find(n => n.kind === 'lit' && n.tag === 0x2e && Array.isArray(n.value) && n.value.length === 2)?.value;
  if (!origin) throw Error(`room ${id}: no origin`);
  const ints = T.find(n => n.kind === 'array' && n.elems!.length === W * H && n.elems!.every(e => { const v = d(e); return v.kind === 'lit' && v.tag === 0x0a; }));
  if (!ints) throw Error(`room ${id}: no tile words`);
  const words = Int32Array.from(ints.elems!, e => d(e).value | 0);
  const doorList = T.find(n => n.kind === 'array' && n.elems!.length > 0 && n.elems!.every(e => { const v = d(e); return v.kind === 'lit' && v.tag === 0x2f; }));
  const doors = (doorList?.elems ?? []).map(e => d(e).value.map((v: number) => v | 0) as [number, number, number]);
  const isGroup = (g: Node) => {
    if (g.kind !== 'group' || !g.elems?.length) return false;
    const last = d(g.elems[g.elems.length - 1]);
    if (last.kind !== 'array' || !last.elems!.length) return false;
    const n = last.elems!.length;
    return [0, 1, 2].some(s => n === 2 * (W - s) * (H - s)) && last.elems!.every(e => { const v = d(e); return v.kind === 'lit' && typeof v.value === 'string' && v.value.length === 16; });
  };
  const groupList = T.find(n => n.kind === 'array' && n.elems!.length > 0 && n.elems!.every(e => isGroup(d(e))));
  if (!groupList) throw Error(`room ${id}: no movement groups`);
  const groups = groupList.elems!.map(e => {
    const g = d(e), f = g.elems!.map(d), bits = f[f.length - 1].elems!.map(x => d(x).value as string);
    const keys = f.slice(0, f.length - 1), n = keys.length / 2;   // (a map: its keys, the profiles, then their values)
    const lo = new Uint32Array(bits.length), hi = new Uint32Array(bits.length);
    bits.forEach((h, k) => { [lo[k], hi[k]] = hexWord(h); });
    return {profiles: keys.slice(0, n).map(k => k.value as number), lo, hi};
  });
  return {id, name, W, H, origin: [origin[0] | 0, origin[1] | 0], words, groups, doors};
}

// ---- as JSON

export interface RoomGridJson { id: number; name?: string; W: number; H: number; origin: [number, number]; words: number[]; doors: [number, number, number][];
  groups: {profiles: number[], words: string[]}[] }
const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
export const gridToJson = (r: RoomGrid): RoomGridJson => ({id: r.id, name: r.name, W: r.W, H: r.H, origin: r.origin, words: [...r.words], doors: r.doors,
  groups: r.groups.map(g => ({profiles: g.profiles, words: [...g.lo].map((lo, k) => hex8(g.hi[k]) + hex8(lo))}))});
export function gridFromJson(j: RoomGridJson): RoomGrid {
  return {id: j.id, name: j.name, W: j.W, H: j.H, origin: j.origin, words: Int32Array.from(j.words), doors: j.doors,
    groups: j.groups.map(g => { const lo = new Uint32Array(g.words.length), hi = new Uint32Array(g.words.length);
      g.words.forEach((h, k) => { [lo[k], hi[k]] = hexWord(h); }); return {profiles: g.profiles, lo, hi}; })};
}
