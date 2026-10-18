// How the game routes a walk within one room: the tile path finder, the direct step, the walk
// smoothing that turns a tile path into waypoints, and an enemy's wander destination. Each gives exactly the
// tiles the game walks.
import {DIRS, type RoomGrid, costOf, layerOf, wordIndex, doorsOf, leavesRoom} from './grid.js';

export type Tile = [number, number, number];   // x, y, layer (room tiles)
/** A run-time passage (cost 63): the cost the room grants for the step, 0 for none. The game asks the room's own
 *  rules (doors, quest gates); with none given they are closed. */
export type Passage = (x: number, y: number, layer: number, d: number) => number;
const closed: Passage = () => 0;

const BUCKETS = 733;
/** The goal must lie within 32.5 tiles of the start (squared map distance at most 1056). */
export const GOAL_RADIUS2 = 0x420;
/** Only tiles nearer the start than 37.5 tiles (squared < 1407) are expanded. */
export const EXPAND_RADIUS2 = 0x57f;
/** The heuristic, and the cost unit: 4 * (3 per diagonal + 2 per straight tile). */
export const octile4 = (dx: number, dy: number) => { dx = Math.abs(dx); dy = Math.abs(dy); return (Math.min(dx, dy) * 3 + Math.abs(dx - dy) * 2) * 4; };

interface PNode { g: number; x: number; y: number; layer: number; parent: PNode | null; door: number; dir: number }
const pathOf = (n: PNode | null): Tile[] => { const out: Tile[] = []; for (; n; n = n.parent) out.push([n.x, n.y, n.layer]); return out.reverse(); };

export interface FindOptions {
  /** The mover's size in tiles (1, 2 or 3): its corner tile is what moves. */
  size?: number;
  passage?: Passage;
  /** Tiles taken by others: layer * 10000 + (y + offY) * 100 + (x + offX) keys of the search window (blockedKey). */
  blocked?: Set<number>;
  stats?: {pops: number};
}
/** The search window's offset of a room (it is centred in a 100 x 100 window). */
const windowOffset = (n: number) => Math.min(Math.max(100 - n >= 0 ? Math.floor((100 - n) / 2) : -Math.floor((n - 100) / 2), 0), 100 - n);
export const blockedKey = (r: RoomGrid, x: number, y: number, layer: number) => layer * 10000 + (y + windowOffset(r.H)) * 100 + (x + windowOffset(r.W));

/** The game's tile path finder: A* over 733 last-in-first-out buckets, 8 directions (a diagonal only where the
 *  east or west step it starts with is open), a straight step costing 2 x and a diagonal 3 x the step's cost.
 *  From start to goal (both included), or to the reachable tile nearest the goal; [] when none is nearer than
 *  the start or the goal is out of range. */
export function findPath(r: RoomGrid, group: number, start: Tile, goal: Tile, o: FindOptions = {}): Tile[] {
  const size = o.size ?? 1, passage = o.passage ?? closed, blocked = o.blocked, g0 = r.groups[group];
  const [ox, oy] = r.origin, [sx, sy, sl] = start, [gx, gy, gl] = goal;
  const Sx = ox + sx, Sy = oy + sy, Gx = ox + gx, Gy = oy + gy, dX = Math.abs(Gx - Sx), dY = Math.abs(Gy - Sy);
  const h0 = octile4(dX, dY);
  let cur = h0 % BUCKETS;
  const offx = windowOffset(r.W), offy = windowOffset(r.H);
  const buckets: PNode[][] = Array.from({length: BUCKETS}, () => []);
  buckets[cur].push({g: 0, x: sx, y: sy, layer: sl, parent: null, door: 0, dir: -1});
  if (dX * dX + dY * dY > GOAL_RADIUS2) return [];
  const visited = new Set<number>();
  let best: PNode | null = null, bestH = h0, pops = 0;
  const push = (n: PNode, hx: number, hy: number) => buckets[(n.g + octile4(hx, hy)) % BUCKETS].push(n);
  for (;;) {
    if (!buckets[cur].length) {
      let k = 0;
      for (; k < BUCKETS; k++) { cur = (cur + 1) % BUCKETS; if (buckets[cur].length) break; }
      if (k === BUCKETS) return best ? pathOf(best) : [];
    }
    const n = buckets[cur].pop()!;
    pops++; if (o.stats) o.stats.pops = pops;
    if (n.door > 0 && n.parent && leavesRoom(n.door, n.x - n.parent.x, n.y - n.parent.y)) continue;   // (out through a door: another room's search)
    const key = n.layer * 10000 + (n.y + offy) * 100 + (n.x + offx);
    if (blocked?.size) {
      if (blocked.has(key)) continue;
      if (n.dir >= 0 && n.dir % 2 === 1) { const [ddx, ddy] = DIRS[n.dir]; if (blocked.has(key - ddy * 100) || blocked.has(key - ddx)) continue; }
    }
    if (n.x === gx && n.y === gy && n.layer === gl) return pathOf(n);
    if (visited.has(key)) continue;
    visited.add(key);
    const wx = n.x + ox, wy = n.y + oy;
    if ((wx - Sx) ** 2 + (wy - Sy) ** 2 >= EXPAND_RADIUS2) continue;
    const rx = Gx - wx, ry = Gy - wy, h = octile4(rx, ry);
    if (h < bestH) { best = n; bestH = h; }
    const door = doorsOf(r, n.x, n.y, n.layer), wi = (n.y * (r.W - size + 1) + n.x) * 2 + n.layer;
    const cost = (d: number) => { const c = costOf(g0, wi, d); return c === 63 ? passage(n.x, n.y, n.layer, d) : c; };
    const node = (g: number, d: number): PNode => ({g, x: n.x + DIRS[d][0], y: n.y + DIRS[d][1], layer: layerOf(g0, wi, d), parent: n, door, dir: d});
    const cE = cost(2);
    if (cE > 0) {
      let c = cost(1); if (c > 0) push(node(n.g + 3 * c, 1), rx - 1, ry + 1);
      c = cost(3); if (c > 0) push(node(n.g + 3 * c, 3), rx - 1, ry - 1);
      push(node(n.g + 2 * cE, 2), rx - 1, ry);
    }
    const cW = cost(6);
    if (cW > 0) {
      let c = cost(5); if (c > 0) push(node(n.g + 3 * c, 5), rx + 1, ry - 1);
      c = cost(7); if (c > 0) push(node(n.g + 3 * c, 7), rx + 1, ry + 1);
      push(node(n.g + 2 * cW, 6), rx + 1, ry);
    }
    let c = cost(0); if (c > 0) push(node(n.g + 2 * c, 0), rx, ry + 1);
    c = cost(4); if (c > 0) push(node(n.g + 2 * c, 4), rx, ry - 1);
  }
}

const sign = (v: number) => (v > 0 ? 1 : 0) - (v < 0 ? 1 : 0);
/** The game's direct step from a tile toward a target (dx, dy) away: along the longer axis first, a plain
 *  (cost 4) step preferred; diagonal only when both offsets are equal. The step (mx, my, layer), or null. */
export function directStep(r: RoomGrid, group: number, at: Tile, dx: number, dy: number, size = 1, passage: Passage = closed): Tile | null {
  const [x, y, l] = at, g = r.groups[group], wi = wordIndex(r, x, y, l, size);
  const cost = (mx: number, my: number): [number, number] => {
    const d = DIRS.findIndex(([a, b]) => a === mx && b === my);
    let c = costOf(g, wi, d); if (c === 63) c = passage(x, y, l, d);
    return [c, layerOf(g, wi, d)];
  };
  const ok = (c: number) => c >= 1 && c <= 62;
  if (dx === 0 && dy === 0) return null;
  const sx = sign(dx), sy = sign(dy), ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < ay) {
    const [cV, bV] = cost(0, sy); if (cV === 4) return [0, sy, bV];
    const [cH, bH] = ax ? cost(sx, 0) : [0, 0]; if (cH === 4) return [sx, 0, bH];
    if (ok(cV)) return [0, sy, bV]; if (ok(cH)) return [sx, 0, bH]; return null;
  }
  if (ax > ay) {
    const [cH, bH] = cost(sx, 0); if (cH === 4) return [sx, 0, bH];
    const [cV, bV] = ay ? cost(0, sy) : [0, 0]; if (cV === 4) return [0, sy, bV];
    if (ok(cH)) return [sx, 0, bH]; if (ok(cV)) return [0, sy, bV]; return null;
  }
  const [cD, bD] = cost(sx, sy); if (ok(cD)) return [sx, sy, bD];
  const [cH, bH] = cost(sx, 0), [cV, bV] = cost(0, sy);
  if (cH === 4) return [sx, 0, bH]; if (cV === 4) return [0, sy, bV];
  if (ok(cH)) return [sx, 0, bH]; if (ok(cV)) return [0, sy, bV];
  return null;
}

/** The game's walk smoothing: a tile path (start included) cut into waypoints (start excluded), each at most 8
 *  tiles on, a run kept whole only where repeated direct steps toward its end retrace exactly its tiles. */
export function smoothPath(r: RoomGrid, group: number, path: Tile[], size = 1): Tile[] {
  const n = path.length;
  if (!n) return [];
  if (n < 3) return [path[n - 1]];
  const same = (a: Tile | null, b: Tile) => !!a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  const walk = (cur: Tile, a: Tile): Tile | null => { const s = directStep(r, group, cur, a[0] - cur[0], a[1] - cur[1], size); return s ? [cur[0] + s[0], cur[1] + s[1], s[2]] : null; };
  const out: Tile[] = [];
  let i = 0, j = 1, remaining = n - 1, nxt = 0;
  while (remaining > 0) {
    for (;;) {
      nxt = j + 1; remaining--;
      if (j - i > 8) break;
      let cur: Tile | null = path[i], ok = true;
      for (let k = i + 1; k <= j; k++) { cur = cur ? walk(cur, path[j]) : null; if (!same(cur, path[k])) { ok = false; break; } }
      if (!ok) break;
      if (remaining <= 0) { out.push(path[n - 1]); return out; }
      j = nxt;
    }
    out.push(path[j - 1]); i = j - 1; j = nxt;
  }
  out.push(path[n - 1]);
  return out;
}

/** The tiles a walker steps through for a list of waypoints: one direct step toward the current waypoint at a time,
 *  the next waypoint once standing on it (the player's walking job). Start included. */
export function walkWaypoints(r: RoomGrid, group: number, start: Tile, waypoints: Tile[], size = 1): Tile[] {
  let cur = start, i = 0;
  const tiles: Tile[] = [start];
  while (i < waypoints.length) {
    if (cur[0] === waypoints[i][0] && cur[1] === waypoints[i][1]) { i++; continue; }
    const s = directStep(r, group, cur, waypoints[i][0] - cur[0], waypoints[i][1] - cur[1], size);
    if (!s) throw Error(`no direct step from ${cur} toward ${waypoints[i]}`);
    cur = [cur[0] + s[0], cur[1] + s[1], s[2]]; tiles.push(cur);
  }
  return tiles;
}

/** The game's direct walk (the one a wandering enemy uses): toward each waypoint in turn
 *  by repeated direct steps, never searched or smoothed; it stops at the first step it cannot take. The tiles
 *  stepped through, start included. */
export function directWalk(r: RoomGrid, group: number, start: Tile, waypoints: Tile[], size = 1, passage: Passage = closed): Tile[] {
  const out: Tile[] = [start];
  let cur = start;
  for (const wp of waypoints) {
    while (cur[0] !== wp[0] || cur[1] !== wp[1] || cur[2] !== wp[2]) {
      const s = directStep(r, group, cur, wp[0] - cur[0], wp[1] - cur[1], size, passage);
      if (!s) return out;
      cur = [cur[0] + s[0], cur[1] + s[1], s[2]]; out.push(cur);
    }
  }
  return out;
}

// ---- enemy wandering

/** The game's random numbers: Java's 48-bit linear congruential generator (seeded per session: a wander can be
 *  reproduced only from a known seed). */
export class JavaRandom {
  private s: bigint;
  constructor(seed: bigint | number) { this.s = BigInt(seed) & ((1n << 48n) - 1n); }
  private next(): number { this.s = (this.s * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n); return Number(this.s >> 17n); }
  nextInt(n: number): number {
    if ((n & (n - 1)) === 0) return Number((BigInt(n) * BigInt(this.next())) >> 31n);
    for (;;) { const bits = this.next(), val = bits % n; if (bits - val + (n - 1) < 2 ** 31) return val; }
  }
  /** Inclusive. */
  between(lo: number, hi: number) { const a = Math.min(lo, hi), b = Math.max(lo, hi); return a + this.nextInt(b - a + 1); }
}
/** The game's single step check: passable (cost 1..62), inside the room and not out through a door. */
export function canStep(r: RoomGrid, group: number, x: number, y: number, l: number, d: number, size = 1): boolean {
  const sw = r.W - size + 1, sh = r.H - size + 1;
  if (!(x >= 0 && x < sw && y >= 0 && y < sh && (l === 0 || l === 1))) return false;
  const c = costOf(r.groups[group], wordIndex(r, x, y, l, size), d);
  if (!(c >= 1 && c <= 62)) return false;
  return !leavesRoom(doorsOf(r, x, y, l), DIRS[d][0], DIRS[d][1]);
}
/** The box an enemy wanders in from where it stands: its home (spawn) tile +- radius (10 on every enemy), clipped
 *  to the room, the sides it cannot step toward from here shut. [x0, y0, x1, y1] inclusive, or null. */
export function wanderBox(r: RoomGrid, group: number, pos: Tile, home: [number, number] | null, radius = 10, size = 1): [number, number, number, number] | null {
  const [x, y, l] = pos;
  let x1 = r.W - size, y1 = r.H - size;
  const x0 = x < 1 || canStep(r, group, x, y, l, 6, size) ? 0 : x;
  if (x < x1 && !canStep(r, group, x, y, l, 2, size)) x1 = x;
  const y0 = y < 1 || canStep(r, group, x, y, l, 0, size) ? 0 : y;
  if (y < y1 && !canStep(r, group, x, y, l, 4, size)) y1 = y;
  if (x0 === x1 && y0 === y1) return null;
  let box: [number, number, number, number] = [x0, y0, x1, y1];
  if (home) {
    const hx0 = Math.max(home[0] - radius, x0), hx1 = Math.min(home[0] + radius, x1), hy0 = Math.max(home[1] - radius, y0), hy1 = Math.min(home[1] + radius, y1);
    if ((hx0 < hx1 && hy0 <= hy1) || (hy0 < hy1 && hx0 <= hx1)) box = [hx0, hy0, hx1, hy1];
  }
  return box;
}
/** The game's wander destination: a uniformly random tile of the box, never the one it stands on. The enemy then
 *  walks there by directWalk (it may stop short, at a wall). */
export function pickWander(r: RoomGrid, group: number, pos: Tile, home: [number, number] | null, rng: JavaRandom, radius = 10, size = 1): Tile | null {
  const box = wanderBox(r, group, pos, home, radius, size);
  if (!box) return null;
  const [x0, y0, x1, y1] = box, [x, y, l] = pos, w = x1 - x0 + 1, n = (y1 - y0 + 1) * w;
  let k: number;
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1) { k = rng.between(0, n - 2); if ((x - x0) + (y - y0) * w <= k) k++; }
  else k = rng.between(0, n - 1);
  return [x0 + k % w, y0 + Math.floor(k / w), l];
}
/** The wander loop's waits (ms): before an idle animation, between wanders, and the retry when none is found. */
export const WANDER_WAITS = {idle: [300, 3000], between: [1800, 12000], retry: 600} as const;

/** Where a wandering enemy can go: every tile it can stand on or pass through, from its home by chains of
 *  wanders (each a random tile of the box from where it stands, walked by directWalk, ending where the walk
 *  stops). Tiles as "x,y,layer" keys; `rests` the tiles a wander can end on. */
export function wanderArea(r: RoomGrid, group: number, home: Tile, radius = 10, size = 1): {tiles: Set<string>, rests: Set<string>} {
  const key = (t: Tile) => t.join(','), tiles = new Set<string>([key(home)]), rests = new Set<string>([key(home)]);
  const todo: Tile[] = [home];
  while (todo.length) {
    const at = todo.pop()!, box = wanderBox(r, group, at, [home[0], home[1]], radius, size);
    if (!box) continue;
    for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) {
      if (x === at[0] && y === at[1]) continue;
      const walk = directWalk(r, group, at, [[x, y, at[2]]], size);
      for (const t of walk) tiles.add(key(t));
      const end = walk[walk.length - 1], k = key(end);
      if (!rests.has(k)) { rests.add(k); todo.push(end); }
    }
  }
  return {tiles, rests};
}

