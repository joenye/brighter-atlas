// The ground plane: the textured floor the game lays at z = 0 under and
// around a room (its data: extract/world/ground-plane.ts). Entering a room,
// the game floors every tile of the room's area (its rect grown by ten
// tiles) whose nearest point lies within ten tiles of the room's ellipse
// (the ellipse through the room rect's half extents, the ten tiles scaled by
// its longer half axis), unless the room's own tile removes it. Each tile is
// one 1024 x 1024 quad whose texture repeats every `repeat` tiles, anchored
// to world tiles. An episode's floor is tinted by the room's area colours
// (its minimap grid) sampled bilinearly at each corner, and beyond the room
// the floor fades to the scene's vignette colour over the same ten tiles.
//
// The viewer lets the floor reach further (or less far): a distance of D
// tiles floors what the game would with a reach of D tiles (the room's area
// growing with it past ten) and fades across those D tiles; the endless
// setting floors everything, out past the fog. Several rooms placed together
// share one floor: each tile goes to the room whose floor reaches it first.
// A room shown with its neighbours has the game's floor instead: the room's
// own, laid and tinted as if alone, where each neighbour's tiles remove it
// or bring their darker alternate floors (sea beds).
import { THREE } from '../three-common.js';
import { b64u16, b64u8 } from '../../store.js';
import type { GroundPlaneRecord } from '../../extract/world/ground-plane.js';

/** How far the game's floor reaches beyond the room's ellipse (native units). */
export const PLANE_REACH = 10240;
/** The game's distance, in tiles. */
export const PLANE_GAME_DISTANCE = 10;
/** The longest finite distance the viewer offers (tiles). */
export const PLANE_DISTANCE_MAX = 40;
/** The distance setting past the longest: an endless floor. */
export const PLANE_ENDLESS = PLANE_DISTANCE_MAX + 1;
/** The cover of the endless floor's far pieces: drawn only when endless. */
const FAR = 1e6;
/** The fade reach an endless floor uses (tiles): no fade at all. */
const ENDLESS_REACH = 1e9;

/** A distance setting (1 to PLANE_ENDLESS) as tiles, Infinity when endless. */
export function planeDistance(setting: unknown): number {
  const d = Math.round(Number(setting));
  if (!(d >= 1)) return PLANE_GAME_DISTANCE;
  return d > PLANE_DISTANCE_MAX ? Infinity : d;
}

/** The game's floor tile: a 1024 x 1024 quad centred on its origin. */
export const TILE_QUAD = Object.freeze({
  positions: new Float32Array([-512, -512, 0, -512, 512, 0, 512, -512, 0, 512, 512, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]),
  tangents: new Float32Array([1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1]),
  indices: new Uint16Array([0, 1, 2, 3, 2, 1]),
});
/** The quad's corners in tiles from the tile's lower corner, vertex order. */
const CORNERS = [[0, 0], [0, 1], [1, 0], [1, 1]];

/** One room's floor data placed in a frame of tiles. */
export interface PlaneSource {
  shard: any;
  /** The room's tile (0, 0) in the frame. */
  offset: [number, number];
}

export interface PlaneTile {
  /** The piece's lower corner in the frame (tiles). */
  x: number;
  y: number;
  /** Its size in tiles: one tile, or a far piece of the endless floor. */
  size: [number, number];
  record: GroundPlaneRecord;
  /** The lower corner's place in the texture repeat: floorMod(world tile, repeat). */
  cell: [number, number];
  /** Per corner (vertex order): the area colour it is tinted by (rgb). */
  tints: number[][];
  /** Per corner: tiles beyond the nearest room's ellipse (the fade). */
  beyond: number[];
  /** The shortest distance that floors it (whole tiles). */
  cover: number;
}

interface FieldRoom {
  /** The room's tile (0, 0) in the field's frame (whole tiles). */
  ox: number; oy: number;
  w: number; h: number;
  records: GroundPlaneRecord[];
  tiles: Uint8Array;
  grid: { x0: number; y0: number; width: number; height: number; palette: number[][]; cells: Uint16Array } | null;
  /** The room's ellipse as the game holds it (single precision): centre,
   *  half extents and their reciprocals; m is the longer half axis. */
  cx: number; cy: number; hx: number; hy: number; sx: number; sy: number; m: number;
}

/** Every tile of the rooms' bounds grown by a margin: the room whose floor
 *  reaches it first and the distance from which it does. Filled a block of
 *  tiles at a time, as far out as asked for. */
export interface PlaneField {
  tileUnits: number;
  rooms: FieldRoom[];
  /** The field's tile (0, 0) in the sources' frame, and its size. */
  x0: number; y0: number; width: number; height: number;
  /** The whole-tile part the frame's tiles sit off (fractional offsets). */
  frac: [number, number];
  /** The world tile of the field frame's tile (0, 0) (the texture repeat). */
  anchor: [number, number];
  /** Neighbours mode: the first room lays the floor, the others only their tiles. */
  primary: boolean;
  /** Per tile: the room whose floor it is (lay, tint, fade). */
  claim: Int16Array;
  cover: Float32Array;
  /** Per tile: the room it belongs to (-1 none) and that room's value there
   *  (0 keep, 1 remove, n a floor of its own; 255 none). */
  owner: Int16Array;
  own: Uint8Array;
  /** Per tile corner ((width + 1) x (height + 1)): tiles beyond the nearest ellipse. */
  beyond: Float32Array;
  cellsX: number; cellsY: number;
  cellNear: Float32Array;
  candidates: Int16Array[];
  done: Uint8Array;
}

const CELL = 16;
const floorMod = (a: number, n: number) => ((a % n) + n) % n;
const f32 = Math.fround;

function fieldRoom(source: PlaneSource, frac: [number, number], tileUnits: number): FieldRoom | null {
  const { shard } = source;
  const plane = shard?.ground_plane;
  const [w, h] = shard?.size ?? [];
  if (!plane || !Array.isArray(plane.records) || !plane.records.length || !(w > 0) || !(h > 0)) return null;
  const tiles = b64u8(plane.tiles);
  if (tiles.length !== w * h) return null;
  const g = shard.colour_grid;
  const grid = g && Number.isInteger(g.width) && Number.isInteger(g.height)
    ? { x0: g.x0, y0: g.y0, width: g.width, height: g.height, palette: g.palette, cells: b64u16(g.cells) } : null;
  const x1 = f32(w * tileUnits), y1 = f32(h * tileUnits);
  const hx = f32(x1 * 0.5), hy = f32(y1 * 0.5);
  return {
    ox: Math.round(source.offset[0] - frac[0]), oy: Math.round(source.offset[1] - frac[1]),
    w, h, records: plane.records, tiles, grid,
    cx: hx, cy: hy, hx, hy, sx: f32(1 / hx), sy: f32(1 / hy), m: Math.max(hx, hy),
  };
}

/** How far a tile's nearest point lies out on the room's ellipse (1 on it),
 *  the game's test for flooring it, step for step in single precision. */
function reachOf(r: FieldRoom, x: number, y: number, tileUnits: number): number {
  const px = f32(x * tileUnits), py = f32(y * tileUnits);
  const dx = r.cx >= px ? f32(f32(r.cx - px) - tileUnits) : f32(px - r.cx);
  const dy = r.cy >= py ? f32(f32(r.cy - py) - tileUnits) : f32(py - r.cy);
  const vx = f32(dx * r.sx), vy = f32(dy * r.sy);
  return f32(Math.sqrt(f32(f32(vy * vy) + f32(vx * vx))));
}

/** The shortest whole-tile distance at which the room floors a tile (the
 *  game's test with that reach), given the tile's `reachOf`. The room's area
 *  bounds it too: the game's grid (the rect grown by ten tiles), or the rect
 *  grown by the distance past ten. */
function coverOf(r: FieldRoom, d: number, x: number, y: number, tileUnits: number): number {
  const k = (n: number) => f32(f32(n * tileUnits / r.m) + 1);
  let n = Math.max(0, Math.floor((d - 1) * r.m / tileUnits));
  while (!(d < k(n))) n++;
  while (n > 0 && d < k(n - 1)) n--;
  const g = r.grid;
  const inArea = g ? x >= g.x0 && y >= g.y0 && x < g.x0 + g.width && y < g.y0 + g.height
    : x >= -PLANE_GAME_DISTANCE && y >= -PLANE_GAME_DISTANCE && x < r.w + PLANE_GAME_DISTANCE && y < r.h + PLANE_GAME_DISTANCE;
  if (inArea) return n;
  const out = Math.max(x < 0 ? -x : x >= r.w ? x - r.w + 1 : 0, y < 0 ? -y : y >= r.h ? y - r.h + 1 : 0);
  return Math.max(n, out);
}

/** Tiles beyond the room's ellipse at a point (room-local tiles). */
function beyondAt(r: FieldRoom, x: number, y: number, tileUnits: number): number {
  return (Math.hypot((r.cx - x * tileUnits) / r.hx, (r.cy - y * tileUnits) / r.hy) - 1) * r.m / tileUnits;
}

/** The room's area colour at a grid point, bilinear between cell centres,
 *  into out[at..at + 2]. */
function gridColour(r: FieldRoom, gx: number, gy: number, out: Float32Array, at: number): void {
  const g = r.grid!;
  const x = Math.min(Math.max(gx, 0), g.width - 1), y = Math.min(Math.max(gy, 0), g.height - 1);
  const x0 = Math.trunc(x), y0 = Math.trunc(y), x1 = Math.trunc(x + 0.99999), y1 = Math.trunc(y + 0.99999);
  const fx = x - x0, fy = y - y0;
  const c = (cx: number, cy: number) => g.palette[g.cells[cy * g.width + cx]] ?? [1, 1, 1, 1];
  const a = c(x0, y0), b = c(x1, y0), d = c(x0, y1), e = c(x1, y1);
  for (let k = 0; k < 3; k++) {
    out[at + k] = f32(f32(f32(a[k] * (1 - fx)) + f32(b[k] * fx)) * (1 - fy)
      + f32(f32(d[k] * (1 - fx)) + f32(e[k] * fx)) * fy);
  }
}

/** The floor field of one room, or of several placed together, over their
 *  bounds grown by `margin` tiles. `primary`: the first source is the room
 *  shown and the rest its neighbours (the game's floor). */
export function planeField(sources: PlaneSource[], { tileUnits = 1024, margin = PLANE_DISTANCE_MAX, primary = false } = {}): PlaneField | null {
  const first = sources.find((s) => s.shard?.ground_plane);
  if (!first) return null;
  const frac: [number, number] = [first.offset[0] - Math.round(first.offset[0]), first.offset[1] - Math.round(first.offset[1])];
  const rooms: FieldRoom[] = [];
  let anchor: [number, number] | null = null;
  for (const source of sources) {
    const room = fieldRoom(source, frac, tileUnits);
    if (!room) continue;
    rooms.push(room);
    const at = source.shard.mapPosition;
    if (!anchor && Array.isArray(at)) anchor = [(Number(at[0]) || 0) - room.ox, (Number(at[1]) || 0) - room.oy];
  }
  if (!rooms.length) return null;
  let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
  for (const r of rooms) { ax = Math.min(ax, r.ox); ay = Math.min(ay, r.oy); bx = Math.max(bx, r.ox + r.w); by = Math.max(by, r.oy + r.h); }
  const x0 = ax - margin, y0 = ay - margin, width = bx - ax + 2 * margin, height = by - ay + 2 * margin;
  const claim = new Int16Array(width * height).fill(-1);
  const owner = new Int16Array(width * height).fill(-1);
  const own = new Uint8Array(width * height).fill(255);
  // the rooms' own tiles are theirs (the first room placed on a tile)
  rooms.forEach((r, ri) => {
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const i = (r.oy - y0 + y) * width + (r.ox - x0 + x);
        if (own[i] !== 255) continue;
        own[i] = r.tiles[y * r.w + x];
        owner[i] = ri;
      }
    }
  });
  // with neighbours the room shown lays the whole floor
  const layers = primary ? rooms.slice(0, 1) : rooms;
  // per block of tiles, the rooms that can reach one of its tiles first: a
  // room's distance to a tile is at least the gap to its rect, and at most
  // one tile past the block corner it reaches last
  const cellsX = Math.ceil(width / CELL), cellsY = Math.ceil(height / CELL);
  const cellNear = new Float32Array(cellsX * cellsY);
  const candidates: Int16Array[] = [];
  const lower = new Float32Array(rooms.length);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const a0 = x0 + cx * CELL, a1 = x0 + Math.min(width, (cx + 1) * CELL);
      const b0 = y0 + cy * CELL, b1 = y0 + Math.min(height, (cy + 1) * CELL);
      let upperBest = Infinity, near = Infinity;
      layers.forEach((r, ri) => {
        const gx = Math.max(0, r.ox - a1, a0 - (r.ox + r.w)), gy = Math.max(0, r.oy - b1, b0 - (r.oy + r.h));
        lower[ri] = Math.hypot(gx, gy) - 1;
        near = Math.min(near, lower[ri]);
        let far = 0;
        for (const px of [a0, a1]) for (const py of [b0, b1]) far = Math.max(far, beyondAt(r, px - r.ox, py - r.oy, tileUnits));
        const out = (v: number, n: number) => (v < 0 ? -v : v >= n ? v - n + 1 : 0);
        const reach = Math.max(out(a0 - r.ox, r.w), out(a1 - 1 - r.ox, r.w), out(b0 - r.oy, r.h), out(b1 - 1 - r.oy, r.h));
        upperBest = Math.min(upperBest, Math.max(Math.ceil(far) + 1, reach));
      });
      const list: number[] = [];
      for (let ri = 0; ri < layers.length; ri++) if (lower[ri] <= upperBest) list.push(ri);
      candidates.push(Int16Array.from(list));
      cellNear[cy * cellsX + cx] = near;
    }
  }
  return {
    tileUnits, rooms, x0, y0, width, height, frac, anchor: anchor ?? [0, 0], primary,
    claim, cover: new Float32Array(width * height).fill(Infinity), owner, own,
    beyond: new Float32Array((width + 1) * (height + 1)).fill(Infinity),
    cellsX, cellsY, cellNear, candidates, done: new Uint8Array(cellsX * cellsY),
  };
}

/** Settle every block with a tile the floor may reach within `extent` tiles. */
function settle(field: PlaneField, extent: number): void {
  const { rooms, x0, y0, width, height, tileUnits: T } = field;
  for (let c = 0; c < field.done.length; c++) {
    if (field.done[c] || !(field.cellNear[c] <= extent)) continue;
    field.done[c] = 1;
    const cand = field.candidates[c];
    const cx = c % field.cellsX, cy = Math.floor(c / field.cellsX);
    const a0 = cx * CELL, a1 = Math.min(width, a0 + CELL), b0 = cy * CELL, b1 = Math.min(height, b0 + CELL);
    for (let y = b0; y < b1; y++) {
      for (let x = a0; x < a1; x++) {
        const i = y * width + x;
        if (field.owner[i] >= 0 && !field.primary) {
          const r = rooms[field.owner[i]];
          const lx = x + x0 - r.ox, ly = y + y0 - r.oy;
          field.claim[i] = field.owner[i];
          field.cover[i] = coverOf(r, reachOf(r, lx, ly, T), lx, ly, T);
          continue;
        }
        let best = -1, bestCover = Infinity, bestBeyond = Infinity;
        for (const ri of cand) {
          const r = rooms[ri];
          const lx = x + x0 - r.ox, ly = y + y0 - r.oy;
          const d = reachOf(r, lx, ly, T);
          const cover = coverOf(r, d, lx, ly, T);
          const e = (d - 1) * r.m / T;
          if (cover < bestCover || (cover === bestCover && e < bestBeyond)) { best = ri; bestCover = cover; bestBeyond = e; }
        }
        field.claim[i] = best;
        field.cover[i] = bestCover;
      }
    }
    for (let y = b0; y <= b1; y++) {
      for (let x = a0; x <= a1; x++) {
        let e = field.beyond[y * (width + 1) + x];
        for (const ri of cand) {
          const r = rooms[ri];
          e = Math.min(e, beyondAt(r, x + x0 - r.ox, y + y0 - r.oy, T));
        }
        field.beyond[y * (width + 1) + x] = e;
      }
    }
  }
}

type Emit = (x: number, y: number, sx: number, sy: number, record: GroundPlaneRecord,
  cellX: number, cellY: number, tints: Float32Array, beyond: Float32Array, cover: number) => void;

/** The floor's record at a field tile, or null where it has none: a floor
 *  of the tile's own (a neighbour's darker alternate), else the floor of the
 *  room it belongs to. */
function tileRecord(field: PlaneField, i: number): GroundPlaneRecord | null {
  const ri = field.claim[i];
  if (ri < 0) return null;
  const v = field.own[i];
  if (v === 1) return null;
  let record = field.rooms[ri].records[0];
  if (v !== 255 && v >= 2) {
    const oi = field.owner[i];
    const records = field.rooms[oi].records;
    record = records[v - 1] ?? record;
    if (field.primary && oi !== 0 && record.alternate != null) record = records[record.alternate] ?? record;
  }
  return record && record.repeat > 0 ? record : null;
}

/** A field tile's corner tints (area colour where the floor takes it). */
function tileTints(field: PlaneField, i: number, record: GroundPlaneRecord, out: Float32Array): void {
  const r = field.rooms[field.claim[i]];
  const x = (i % field.width) + field.x0 - r.ox, y = Math.floor(i / field.width) + field.y0 - r.oy;
  for (let v = 0; v < 4; v++) {
    if (record.tint && r.grid) gridColour(r, x - r.grid.x0 + CORNERS[v][0] - 0.5, y - r.grid.y0 + CORNERS[v][1] - 0.5, out, v * 3);
    else out.fill(1, v * 3, v * 3 + 3);
  }
}

/** Every floor tile the field reaches within `extent` tiles and, endless,
 *  the far pieces out to `far` tiles past it: those carry the field edge's
 *  floor and colours outwards, one strip per edge tile (`split`: cut where
 *  the texture repeats, so a piece spans one repeat at most). */
function eachTile(field: PlaneField, extent: number, far: number, split: boolean, emit: Emit, detail = true): void {
  settle(field, extent);
  const { width, height, x0, y0, frac, anchor } = field;
  const tints = new Float32Array(12), beyond = new Float32Array(4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const cover = field.cover[i];
      if (!(cover <= extent)) continue;
      const record = tileRecord(field, i);
      if (!record) continue;
      if (detail) {
        tileTints(field, i, record, tints);
        for (let v = 0; v < 4; v++) beyond[v] = field.beyond[(y + CORNERS[v][1]) * (width + 1) + x + CORNERS[v][0]];
      }
      const n = record.repeat;
      emit(x0 + frac[0] + x, y0 + frac[1] + y, 1, 1, record,
        floorMod(anchor[0] + x0 + x, n), floorMod(anchor[1] + y0 + y, n), tints, beyond, cover);
    }
  }
  if (extent !== Infinity || !(far > 0)) return;
  // the far pieces: side strips per edge tile, corner blocks; their corners
  // take the edge tile's outer corner colours (the area colours clamp)
  beyond.fill(0);
  const edge = new Float32Array(12);
  const spans = (lo: number, hi: number, world: number, n: number) => {
    if (!split) return [[lo, hi]];
    const out: number[][] = [];
    for (let s = lo; s < hi;) {
      const e = Math.min(hi, s + n - floorMod(world + s, n));
      out.push([s, e]);
      s = e;
    }
    return out;
  };
  // x ranges: -1 before the field, 0 per column, 1 after (likewise y)
  for (const sideY of [-1, 0, 1]) {
    for (const sideX of [-1, 0, 1]) {
      if (!sideX && !sideY) continue;
      const columns = sideX ? [sideX < 0 ? 0 : width - 1] : Array.from({ length: width }, (_, k) => k);
      const rows = sideY ? [sideY < 0 ? 0 : height - 1] : Array.from({ length: height }, (_, k) => k);
      for (const ty of rows) {
        for (const tx of columns) {
          const i = ty * width + tx;
          const record = tileRecord(field, i);
          if (!record) continue;
          tileTints(field, i, record, edge);
          for (let v = 0; v < 4; v++) {
            const cx = sideX ? (sideX < 0 ? 0 : 1) : CORNERS[v][0], cy = sideY ? (sideY < 0 ? 0 : 1) : CORNERS[v][1];
            const from = (cx * 2 + cy) * 3;
            tints[v * 3] = edge[from]; tints[v * 3 + 1] = edge[from + 1]; tints[v * 3 + 2] = edge[from + 2];
          }
          const n = record.repeat;
          const xr = sideX ? (sideX < 0 ? [-far, 0] : [width, width + far]) : [tx, tx + 1];
          const yr = sideY ? (sideY < 0 ? [-far, 0] : [height, height + far]) : [ty, ty + 1];
          for (const [xa, xb] of spans(xr[0], xr[1], anchor[0] + x0, n)) {
            for (const [ya, yb] of spans(yr[0], yr[1], anchor[1] + y0, n)) {
              emit(x0 + frac[0] + xa, y0 + frac[1] + ya, xb - xa, yb - ya, record,
                floorMod(anchor[0] + x0 + xa, n), floorMod(anchor[1] + y0 + ya, n), tints, beyond, FAR);
            }
          }
        }
      }
    }
  }
}

/** The floor pieces within `extent` tiles (endless: with the far pieces out
 *  to `far` tiles, each within one texture repeat), nearest first, so a
 *  shorter distance draws a prefix. */
export function planeTiles(field: PlaneField, extent = Infinity, far = 0): PlaneTile[] {
  const out: PlaneTile[] = [];
  eachTile(field, extent, far, true, (x, y, sx, sy, record, cellX, cellY, tints, beyond, cover) => {
    out.push({
      x, y, size: [sx, sy], record, cell: [cellX, cellY],
      tints: [0, 1, 2, 3].map((v) => [tints[v * 3], tints[v * 3 + 1], tints[v * 3 + 2]]),
      beyond: Array.from(beyond), cover,
    });
  });
  return out.sort((a, b) => a.cover - b.cover);
}

/** How many of the (sorted) covers a distance floors. */
export function planeCount(covers: ArrayLike<number>, distance: number): number {
  if (distance === Infinity) return covers.length;
  let lo = 0, hi = covers.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (covers[mid] <= distance) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Floor pieces grouped by what draws them (material and image), in order. */
export function planeGroups(tiles: PlaneTile[]): { record: GroundPlaneRecord; tiles: PlaneTile[] }[] {
  const groups = new Map<string, { record: GroundPlaneRecord; tiles: PlaneTile[] }>();
  for (const t of tiles) {
    const key = `${t.record.material}:${t.record.texture}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { record: t.record, tiles: [] });
    g.tiles.push(t);
  }
  return [...groups.values()];
}

/** One floor mesh's data for the viewer's own renderer. */
export interface PlaneMesh {
  record: GroundPlaneRecord;
  geometry: THREE.BufferGeometry;
  /** Per piece, in draw order: the shortest distance that floors it. */
  covers: Float32Array;
}

/** The floor for the viewer's own renderer (native units, z = 0), one
 *  geometry per floor material, pieces nearest first: the quad per piece,
 *  world-anchored texture coordinates (the texture repeats), the tile's
 *  colour and area tint as a linear vertex colour (the game multiplies after
 *  its gamma encode) and the tiles beyond the ellipse for the fade. */
export function planeMeshes(field: PlaneField, extent: number, far = 0): PlaneMesh[] {
  const T = field.tileUnits;
  // first pass: the pieces per group and their covers, in emission order
  const groups = new Map<string, { record: GroundPlaneRecord; covers: number[] }>();
  eachTile(field, extent, far, false, (_x, _y, _sx, _sy, record, _cx, _cy, _t, _b, cover) => {
    const key = `${record.material}:${record.texture}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { record, covers: [] });
    g.covers.push(cover);
  }, false);
  // nearest first, stable: each piece's slot in its group
  const slots = new Map<string, { at: number; order: Uint32Array; covers: Float32Array; data: any }>();
  for (const [key, { record, covers }] of groups) {
    const order = Uint32Array.from(covers.keys()).sort((a, b) => covers[a] - covers[b] || a - b);
    const rank = new Uint32Array(order.length);
    order.forEach((piece, slot) => { rank[piece] = slot; });
    const n = covers.length;
    slots.set(key, {
      at: 0, order: rank, covers: Float32Array.from(order, (piece) => covers[piece]),
      data: {
        record, pos: new Float32Array(n * 12), uv: new Float32Array(n * 8), col: new Float32Array(n * 12),
        beyond: new Float32Array(n * 4), index: n * 4 > 65535 ? new Uint32Array(n * 6) : new Uint16Array(n * 6),
      },
    });
  }
  eachTile(field, extent, far, false, (x, y, sx, sy, record, cellX, cellY, tints, beyond) => {
    const g = slots.get(`${record.material}:${record.texture}`)!;
    const i = g.order[g.at++];
    const { pos, uv, col, index } = g.data;
    const n = record.repeat;
    for (let v = 0; v < 4; v++) {
      const [dx, dy] = CORNERS[v];
      const o = i * 4 + v;
      pos[o * 3] = (x + dx * sx) * T; pos[o * 3 + 1] = (y + dy * sy) * T; pos[o * 3 + 2] = 0;
      uv[o * 2] = (cellX + dx * sx) / n; uv[o * 2 + 1] = (cellY + dy * sy) / n;
      for (let k = 0; k < 3; k++) col[o * 3 + k] = Math.pow(Math.min(1, record.colour[k] * tints[v * 3 + k]), 2.2);
      g.data.beyond[o] = beyond[v];
    }
    // the world root mirrors the frame, so three's front faces are the
    // game's triangles taken the other way round
    for (let k = 0; k < 6; k += 3) {
      index[i * 6 + k] = i * 4 + TILE_QUAD.indices[k];
      index[i * 6 + k + 1] = i * 4 + TILE_QUAD.indices[k + 2];
      index[i * 6 + k + 2] = i * 4 + TILE_QUAD.indices[k + 1];
    }
  });
  return [...slots.values()].map(({ covers, data }) => {
    const n = covers.length;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.col, 3));
    geometry.setAttribute('planeBeyond', new THREE.BufferAttribute(data.beyond, 1));
    const normal = new Int8Array(n * 12);
    for (let k = 2; k < normal.length; k += 3) normal[k] = 127;
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { record: data.record, geometry, covers };
  });
}

/** What every floor material of a view shares: the fade colour and reach. */
export interface PlaneUniforms {
  planeFadeColour: { value: THREE.Color };
  planeReach: { value: number };
}

export function planeUniforms(fadeColour: THREE.Color, distance = PLANE_GAME_DISTANCE): PlaneUniforms {
  const uniforms = { planeFadeColour: { value: fadeColour }, planeReach: { value: 0 } };
  setPlaneReach(uniforms, distance);
  return uniforms;
}

/** Fade across `distance` tiles (none when endless). */
export function setPlaneReach(uniforms: PlaneUniforms, distance: number): void {
  uniforms.planeReach.value = Number.isFinite(distance) ? Math.max(distance, 1e-3) : ENDLESS_REACH;
}

/** Draw the pieces a distance floors. */
export function showPlaneMesh(mesh: THREE.Mesh, distance: number): void {
  const covers: Float32Array | undefined = mesh.userData.planeCovers;
  if (covers) mesh.geometry.setDrawRange(0, planeCount(covers, distance) * 6);
}

/** A standard material that fades to the fade colour (output colour space)
 *  across the reach. Its texture is a repeating copy of `map`. */
export function planeMaterial(map: THREE.Texture | null, uniforms: PlaneUniforms): THREE.MeshStandardMaterial {
  const texture = map ? map.clone() : null;
  if (texture) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
  }
  const material = new THREE.MeshStandardMaterial({
    map: texture, color: 0xffffff, vertexColors: true, metalness: 0.02, roughness: 0.9, side: THREE.FrontSide,
  });
  material.addEventListener('dispose', () => texture?.dispose());
  material.onBeforeCompile = (shader) => {
    shader.uniforms.planeFadeColour = uniforms.planeFadeColour;
    shader.uniforms.planeReach = uniforms.planeReach;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float planeBeyond;\nvarying float vPlaneBeyond;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPlaneBeyond = planeBeyond;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 planeFadeColour;\nuniform float planeReach;\nvarying float vPlaneBeyond;')
      .replace('#include <fog_fragment>', 'float planeFade = smoothstep(0.0, 1.0, clamp(vPlaneBeyond / planeReach, 0.0, 1.0));\n'
        + 'gl_FragColor.rgb = mix(gl_FragColor.rgb, planeFadeColour, planeFade);\n#include <fog_fragment>');
  };
  material.customProgramCacheKey = () => 'ground-plane';
  return material;
}
