// Door-graph world placement: every room's world-grid x/y for the main
// door-connected component + ferry annex, its plane, its voted room number,
// and the paired door links the all-rooms viewer needs as adjacency.
//
// Input rooms (from room.js): [{ idx, exits, name, w, h, gridW, gridH }] where
// exits = roomExits(...), w/h = roomLayers stack dims (null when undecodable),
// gridW/gridH = the minimap inner-rect dims. Rooms must be in ascending idx
// order: vote/link ordering depends on it.
//
// Worker-safe: no DOM, no Node APIs.

import type { RoomExit } from './room.js';

export const FERRY_GAP = 1; // tiles between ferry-linked rooms (thin seam)

// Jigsaw join connectors, by mesh CONTENT HASH (content hashes are the
// build-stable IDs). Every interlocking room join carries "male" marker
// meshes in one room and "female" in the other, sitting ONE TILE APART along
// the join axis once the rooms are correctly placed: rooms tile edge to edge
// WITHOUT sharing a border row/column, and a paired door's two tiles are
// ADJACENT world tiles (you step through), not the same tile. The classic
// door-tile constraint (pos[a]+aTile == pos[b]+bTile) therefore places every
// joined pair one tile too close, the historic all-rooms 1-tile overlap.
// With the +1 outward step applied per join (see joinStep), the whole door
// graph becomes perfectly consistent: 0 contradictory edges of 511 on the
// validated build, versus 46 without the step. The connector meshes are the
// evidence for this model and gate the calibrated placement mode (their
// presence proves the shard pipeline ran and placements resolved).
export const CONNECTOR_MESH_HASHES = {
  male: ['ae308da5f2362dec', 'd377e7b0af2be394'],
  female: ['b26c36cc0f6d37e0', 'a4ba84b3f8ffb26c'],
};

// Ferry crossings a newer build carries in its own data but an older bundle
// is missing, expressed by STABLE in-game room NUMBER (the door `code` space,
// which is consistent across builds: 451 is always Ferry South Shore, 67
// always Hopeforest Ferry). Modern builds spell the crossing out as a pair of
// direction-less (type-null) ferry exits, so ferryEdges recovers it from the
// data and the pair attaches to the main map; the episode-6-era bundle has NO
// type-null exits at all, so the same crossing (and its Himatik Ruins annex)
// would otherwise be left unplaced. These reinstate exactly the crossing a
// current build already resolves, keyed to survive bundle re-ordering. A build
// that already carries the crossing yields the identical edge and dedups to a
// no-op (placement stays byte-identical); a build missing it gains it.
export const SUPPLEMENTAL_FERRY_LINKS: [number, number][] = [
  [451, 67], // Ferry South Shore <-> Hopeforest Ferry (drags the Himatik Ruins door-pair to the main map)
];

export interface StitchRoom {
  idx: number;
  exits: RoomExit[];
  name: string | null;
  w: number | null;
  h: number | null;
  gridW: number | null;
  gridH: number | null;
}

export interface DoorLink {
  a: number;
  aTile: number[];
  b: number;
  bTile: number[];
  aCode: number;
  bCode: number;
}

export interface FlatExit {
  room: number;
  tile: number[];
  z: number;
  type: number | null;
  code: number;
  dest: number[];
}

// round() with banker's rounding (ties to even).
function pyRound(x: number): number {
  const f = Math.floor(x);
  if (x - f === 0.5) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

const tileKey = (t: number[]) => `${t[0]},${t[1]}`;

// Most-common key over an insertion-ordered Map: max count, first-inserted
// wins ties.
function mostCommon<K>(counts: Map<K, number>): K {
  let best: K | null = null, bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best as K;
}

const bump = <K>(map: Map<K, number>, key: K, w = 1) => map.set(key, (map.get(key) ?? 0) + w);

// Infer build-local opposite direction objects from reciprocal doors.
// exits: flat [{ room, tile, z, type, code, dest }].
export function inferOpposites(exits: FlatExit[]): Map<number, number> {
  const byTile = new Map<string, FlatExit[]>();
  for (const row of exits) {
    const k = tileKey(row.tile);
    if (!byTile.has(k)) byTile.set(k, []);
    byTile.get(k)!.push(row);
  }
  const votes = new Map<number, Map<number, number>>(); // type -> Map(otherType -> count), insertion-ordered
  for (const row of exits) {
    if (row.type === null) continue;
    for (const other of byTile.get(tileKey(row.dest)) ?? []) {
      if (other.room !== row.room && other.z === row.z && other.type !== null
        && other.dest[0] === row.tile[0] && other.dest[1] === row.tile[1]) {
        if (!votes.has(row.type)) votes.set(row.type, new Map());
        bump(votes.get(row.type)!, other.type);
      }
    }
  }
  const best = new Map<number, number>();
  for (const [type, counts] of votes) best.set(type, mostCommon(counts));
  const opposite = new Map<number, number>();
  for (const [type, opp] of best) {
    if (type !== opp && best.get(opp) === type) opposite.set(type, opp);
  }
  return opposite;
}

// Mutually-paired, number-consistent door links. A pair must match tiles both
// ways, share the plane, and face opposite directions.
// exitsByRoom: Map(idx -> exits); roomIndices: ascending room ordinals.
// -> { links: [{ a, aTile, b, bTile, aCode, bCode }], numbers: Map(idx -> num) }
export function buildLinks(exitsByRoom: Map<number, RoomExit[]>, roomIndices: number[]): {
  links: DoorLink[]; numbers: Map<number, number>;
} {
  const exits: FlatExit[] = [];
  for (const ridx of roomIndices) {
    for (const e of exitsByRoom.get(ridx) ?? []) {
      exits.push({ room: ridx, tile: [e.x, e.y], z: e.z, type: e.type, code: e.code, dest: e.dest });
    }
  }
  const opposite = inferOpposites(exits);
  const byTile = new Map<string, FlatExit[]>();
  for (const row of exits) {
    const k = tileKey(row.tile);
    if (!byTile.has(k)) byTile.set(k, []);
    byTile.get(k)!.push(row);
  }
  const raw: DoorLink[] = [];
  for (const row of exits) {
    // no opposite known (or direction-less) -> normalize to null so a pair of
    // direction-less exits still matches
    const want = opposite.has(row.type as number) ? opposite.get(row.type as number)! : null;
    for (const other of byTile.get(tileKey(row.dest)) ?? []) {
      if (other.dest[0] === row.tile[0] && other.dest[1] === row.tile[1]
        && other.room !== row.room && other.z === row.z && want === other.type) {
        raw.push({ a: row.room, aTile: row.tile, b: other.room, bTile: row.dest, aCode: row.code, bCode: other.code });
      }
    }
  }
  // room-number voting with consistency weighting: matching prior assignments
  // reinforce a vote across six fixed rounds
  let num = new Map<number, number>();
  for (let it = 0; it < 6; it++) {
    const votes = new Map<number, Map<number, number>>(); // room -> Map(number -> weight)
    for (const l of raw) {
      const na = num.get(l.a), nb = num.get(l.b);
      if ((na === undefined || na === l.bCode) && (nb === undefined || nb === l.aCode)) {
        const w = 1 + 3 * (na === l.bCode ? 1 : 0) + 3 * (nb === l.aCode ? 1 : 0);
        if (!votes.has(l.b)) votes.set(l.b, new Map());
        bump(votes.get(l.b)!, l.aCode, w);
        if (!votes.has(l.a)) votes.set(l.a, new Map());
        bump(votes.get(l.a)!, l.bCode, w);
      }
    }
    num = new Map();
    for (const [r, v] of votes) num.set(r, mostCommon(v));
  }
  const links = raw.filter((l) => num.get(l.b) === l.aCode && num.get(l.a) === l.bCode);
  return { links, numbers: num };
}

// Ferry teleport links: direction-less exits carrying a destination room
// NUMBER but no spatial door. -> [[srcIdx, dstIdx], ...] (unordered pairs).
export function ferryEdges(
  exitsByRoom: Map<number, RoomExit[]>,
  numbers: Map<number, number>,
  roomIndices: number[],
): [number, number][] {
  const num2room = new Map<number, number>();
  for (const [r, n] of numbers) num2room.set(n, r);
  const edges = new Map<string, [number, number]>();
  for (const ridx of roomIndices) {
    for (const e of exitsByRoom.get(ridx) ?? []) {
      if (e.type === null && e.code) {
        const d = num2room.get(e.code);
        if (d !== undefined && d !== ridx) {
          const key = ridx < d ? `${ridx},${d}` : `${d},${ridx}`;
          if (!edges.has(key)) edges.set(key, [ridx, d]);
        }
      }
    }
  }
  // Reinstate ferry crossings missing from this build's data (see
  // SUPPLEMENTAL_FERRY_LINKS). Runs AFTER the data pass so a crossing the build
  // already carries keeps its data edge and this dedups to nothing.
  for (const [na, nb] of SUPPLEMENTAL_FERRY_LINKS) {
    const a = num2room.get(na), b = num2room.get(nb);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (!edges.has(key)) edges.set(key, [a, b]);
  }
  return [...edges.values()];
}

// Connected components of paired links, largest first (stable on ties).
export function componentsOf(pairs: { a: number; b: number }[]): Set<number>[] {
  const adj = new Map<number, Set<number>>();
  for (const p of pairs) {
    if (!adj.has(p.a)) adj.set(p.a, new Set());
    if (!adj.has(p.b)) adj.set(p.b, new Set());
    adj.get(p.a)!.add(p.b);
    adj.get(p.b)!.add(p.a);
  }
  const out: Set<number>[] = [];
  const seen = new Set<number>();
  for (const n of adj.keys()) {
    if (seen.has(n)) continue;
    const c = new Set<number>();
    const q = [n];
    while (q.length) {
      const cur = q.pop()!;
      if (c.has(cur)) continue;
      c.add(cur);
      for (const m of adj.get(cur)!) if (!c.has(m)) q.push(m);
    }
    for (const m of c) seen.add(m);
    out.push(c);
  }
  return out.sort((a, b) => b.size - a.size);
}

// Dense SPD solve (normal equations) via in-place Cholesky; for a connected
// door graph plus the anchor row this equals the least-squares solution over
// the incidence matrix.
function choleskyFactor(M: Float64Array, n: number): void {
  for (let j = 0; j < n; j++) {
    let d = M[j * n + j];
    for (let k = 0; k < j; k++) d -= M[j * n + k] ** 2;
    if (d < 1e-9) { // isolated node after trimming: pin to 0 (min-norm analogue)
      for (let k = 0; k < j; k++) M[j * n + k] = 0;
      M[j * n + j] = Infinity;
      continue;
    }
    d = Math.sqrt(d);
    M[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let s = M[i * n + j];
      for (let k = 0; k < j; k++) s -= M[i * n + k] * M[j * n + k];
      M[i * n + j] = s / d;
    }
  }
}

function choleskySolve(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = L[i * n + i] === Infinity ? 0 : s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = L[i * n + i] === Infinity ? 0 : s / L[i * n + i];
  }
  return x;
}

// Trimmed LSQ over door-offset constraints -> { pos: Map(room -> [x, y]), worst }.
export function solvePositions(nodes: number[], pairs: DoorLink[]): {
  pos: Map<number, number[]>; worst: number;
} {
  const ni = new Map(nodes.map((n, k): [number, number] => [n, k]));
  const n = nodes.length;
  let live = pairs.filter((p) => ni.has(p.a) && ni.has(p.b));
  let X: Float64Array = new Float64Array(n), Y: Float64Array = new Float64Array(n);
  let worst = 0;
  for (let it = 0; it < 10; it++) {
    const M = new Float64Array(n * n);
    const rx = new Float64Array(n), ry = new Float64Array(n);
    for (const p of live) {
      const ia = ni.get(p.a)!, ib = ni.get(p.b)!;
      M[ia * n + ia] += 1; M[ib * n + ib] += 1;
      M[ia * n + ib] -= 1; M[ib * n + ia] -= 1;
      const bx = p.aTile[0] - p.bTile[0], by = p.aTile[1] - p.bTile[1];
      rx[ib] += bx; rx[ia] -= bx;
      ry[ib] += by; ry[ia] -= by;
    }
    M[0] += 1; // anchor row: X[nodes[0]] ~ 0
    choleskyFactor(M, n);
    X = choleskySolve(M, n, rx);
    Y = choleskySolve(M, n, ry);
    const res = live.map((p) => Math.abs(X[ni.get(p.b)!] - X[ni.get(p.a)!] - (p.aTile[0] - p.bTile[0]))
      + Math.abs(Y[ni.get(p.b)!] - Y[ni.get(p.a)!] - (p.aTile[1] - p.bTile[1])));
    worst = res.length ? Math.max(...res) : 0;
    if (worst <= 2.0) break;
    const cut = Math.max(2.0, worst * 0.5);
    live = live.filter((_, k) => res[k] < cut);
  }
  const pos = new Map(nodes.map((node): [number, number[]] => [node, [pyRound(X[ni.get(node)!]), pyRound(Y[ni.get(node)!])]]));
  return { pos, worst };
}

// The +1 outward separation for one door link: the unit vector from room a
// toward room b along the join axis (pos[b] - pos[a] = aTile - bTile + step).
// Derived from where the two door tiles sit against their room rects:
//   1. exact-edge votes: a door tile on a room edge names the join side
//      (a's east edge / b's west edge both vote (+1,0)); a unique majority
//      wins. Covers 880/1026 links on the validated build.
//   2. nearest-edge fallback: interior door tiles (arrival squares one or
//      two tiles inside the room) take the closest edge within 2 tiles when
//      it is unique. Coverage rises to 1022/1026; the whole graph is exactly
//      consistent under these steps (0 contradictory edges).
// null = underivable (a handful of deep-interior doors); those links keep
// the plain door offset and the solver absorbs them.
function joinStep(link: DoorLink, dims: Map<number, number[]>): number[] | null {
  const [wa, ha] = dims.get(link.a) || [null, null];
  const [wb, hb] = dims.get(link.b) || [null, null];
  if (wa == null || wb == null) return null;
  const votes = new Map<string, number>();
  const vote = (s: number[]) => votes.set(`${s}`, (votes.get(`${s}`) ?? 0) + 1);
  if (link.aTile[0] === 0) vote([-1, 0]);
  if (link.aTile[0] === wa - 1) vote([1, 0]);
  if (link.aTile[1] === 0) vote([0, -1]);
  if (link.aTile[1] === ha! - 1) vote([0, 1]);
  if (link.bTile[0] === 0) vote([1, 0]);
  if (link.bTile[0] === wb - 1) vote([-1, 0]);
  if (link.bTile[1] === 0) vote([0, 1]);
  if (link.bTile[1] === hb! - 1) vote([0, -1]);
  if (votes.size) {
    const sorted = [...votes.entries()].sort((x, y) => y[1] - x[1]);
    if (sorted.length === 1 || sorted[0][1] > sorted[1][1]) {
      return sorted[0][0].split(',').map(Number);
    }
    return null;   // tied exact-edge votes (corner doors): ambiguous
  }
  const candidates: [number, number[]][] = [
    [link.aTile[0], [-1, 0]], [wa - 1 - link.aTile[0], [1, 0]],
    [link.aTile[1], [0, -1]], [ha! - 1 - link.aTile[1], [0, 1]],
    [link.bTile[0], [1, 0]], [wb - 1 - link.bTile[0], [-1, 0]],
    [link.bTile[1], [0, 1]], [hb! - 1 - link.bTile[1], [0, -1]],
  ];
  candidates.sort((x, y) => x[0] - y[0]);
  if (candidates[0][0] > 2) return null;
  const best = candidates.filter((c) => c[0] === candidates[0][0]).map((c) => `${c[1]}`);
  if (new Set(best).size !== 1) return null;
  return candidates[0][1];
}

// Discrete post-pass: the LSQ solution smears each inconsistent cycle's
// error across its whole ring in fractional tiles, and rounding then leaves
// several joins off by one. Nudging one room at a time (±2 tiles) toward the
// least total join error concentrates the unavoidable error on the few
// genuinely contradictory edges and makes every other join exact. Mutates
// pos; deterministic (ascending room order, first-best move).
function hillClimbPositions(pos: Map<number, number[]>, pairs: DoorLink[]): void {
  const joins: { a: number; b: number; dx: number; dy: number }[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    if (!pos.has(p.a) || !pos.has(p.b)) continue;
    const key = p.a < p.b
      ? `${p.a}|${p.b}|${p.aTile}|${p.bTile}` : `${p.b}|${p.a}|${p.bTile}|${p.aTile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    joins.push({ a: p.a, b: p.b, dx: p.aTile[0] - p.bTile[0], dy: p.aTile[1] - p.bTile[1] });
  }
  const byRoom = new Map<number, typeof joins>();
  for (const j of joins) {
    if (!byRoom.has(j.a)) byRoom.set(j.a, []);
    if (!byRoom.has(j.b)) byRoom.set(j.b, []);
    byRoom.get(j.a)!.push(j);
    byRoom.get(j.b)!.push(j);
  }
  const errOf = (j: { a: number; b: number; dx: number; dy: number }) => {
    const pa = pos.get(j.a)!, pb = pos.get(j.b)!;
    return Math.abs(pb[0] - pa[0] - j.dx) + Math.abs(pb[1] - pa[1] - j.dy);
  };
  const nodes = [...byRoom.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < 20; pass++) {
    let moved = 0;
    for (const n of nodes) {
      const edges = byRoom.get(n)!;
      const cur = pos.get(n)!;
      let best = [0, 0];
      let bestErr = edges.reduce((s, e) => s + errOf(e), 0);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (!dx && !dy) continue;
          pos.set(n, [cur[0] + dx, cur[1] + dy]);
          const err = edges.reduce((s, e) => s + errOf(e), 0);
          if (err < bestErr) { bestErr = err; best = [dx, dy]; }
        }
      }
      pos.set(n, [cur[0] + best[0], cur[1] + best[1]]);
      if (best[0] || best[1]) moved++;
    }
    if (!moved) break;
  }
}

// Mode of a room's exit planes; deterministic ties (smallest z). Rooms without
// exits sit on plane 0.
export function planeOf(exits: RoomExit[]): number {
  if (!exits.length) return 0;
  const counts = new Map<number, number>();
  for (const e of exits) bump(counts, e.z);
  let best: number | null = null, bestN = -1;
  for (const [z, c] of counts) if (c > bestN || (c === bestN && z < (best as number))) { best = z; bestN = c; }
  return best as number;
}

export interface FerryContext {
  surface: DoorLink[];
  numbers: Map<number, number>;
  names: Map<number, string | null>;
  exitsByRoom: Map<number, RoomExit[]>;
  roomIndices: number[];
  gridDims: Map<number, number[]>;
}

// Append ferry-reached rooms below their placed source room: the connection
// is data-driven, the straight-south stacking is the map's own convention.
// Mutates pos/grids.
export function attachFerries(pos: Map<number, number[]>, grids: Map<number, number[]>, ctx: FerryContext): void {
  const { surface, numbers, names, exitsByRoom, roomIndices, gridDims } = ctx;
  const edges = ferryEdges(exitsByRoom, numbers, roomIndices);
  const comps = componentsOf(surface);
  let progress = true;
  while (progress) {
    progress = false;
    for (const [a, b] of edges) {
      if (pos.has(a) === pos.has(b)) continue; // both or neither placed
      const [src, dst] = pos.has(a) ? [a, b] : [b, a];
      if (!gridDims.has(dst)) continue;
      const comp = comps.find((c) => c.has(dst)) ?? new Set([dst]);
      const sub = new Map<number, number[]>();
      for (const m of [...comp].sort((x, y) => x - y)) {
        if (gridDims.has(m)) sub.set(m, gridDims.get(m)!);
      }
      const spos = sub.size > 1
        ? solvePositions([...sub.keys()], surface).pos
        : new Map<number, number[]>([[dst, [0, 0]]]);
      const cx = pos.get(src)![0] + grids.get(src)![0] / 2; // stack centred under src
      let sy = pos.get(src)![1] + grids.get(src)![1] + FERRY_GAP;
      for (const cr of roomIndices) { // passive crossing room in the gap
        if (!pos.has(cr) && !sub.has(cr) && gridDims.has(cr)
          && (names.get(cr) ?? '').includes('Crossing') && !(exitsByRoom.get(cr) ?? []).length) {
          const cg = gridDims.get(cr)!;
          pos.set(cr, [pyRound(cx - cg[0] / 2), sy]);
          grids.set(cr, cg);
          sy += cg[1] + FERRY_GAP;
          break;
        }
      }
      const dref = spos.get(dst)!;
      const sx = pyRound(cx - sub.get(dst)![0] / 2); // centre the ferry sub-map under src
      for (const [m, g] of sub) {
        const [nx, ny] = spos.get(m)!;
        pos.set(m, [sx + nx - dref[0], sy + ny - dref[1]]);
        grids.set(m, g);
      }
      progress = true;
    }
  }
}

export interface WorldPlacement {
  positions: Map<number, number[]>;
  planes: Map<number, number>;
  numbers: Map<number, number>;
  links: DoorLink[];
  components: Set<number>[];
}

export const DETACHED_GAP = 6; // tiles between the main map and each parked region

// Park the door-graph components the main stitch could not reach: regions cut
// from later builds (the episode-6 Bleakholm cluster on the old bundle) that
// share no door AND no ferry with the main map, so both the reciprocal-door
// stitch and the ferry annex leave every one of their rooms unplaced. Rather
// than let them collapse into the viewer's fallback grid, solve each on its OWN
// door-graph (the same least-squares stitch, so the region stays internally
// coherent) and place it just EAST of the placed map's eastern edge (past
// Crenopolis, the main map's easternmost region), stacking multiple regions in
// Y so they sit side by side without overlapping each other or the main map.
// Each region is based at the world's ground plane, its internal plane offsets
// preserved, so it reads flat alongside the world.
//
// Build-agnostic and guarded: only a build that still has an unplaced
// door-component after the main solve + ferry attach reaches the body. A fully
// connected build (every current build) has none, so positions/planes come out
// byte-identical. Mutates positions and planes.
export function placeDetachedComponents(
  components: Set<number>[],
  positions: Map<number, number[]>,
  planes: Map<number, number>,
  surface: DoorLink[],
  gridDims: Map<number, number[]>,
  connectors: unknown,
): void {
  if (!positions.size || components.length < 2) return;
  // Detached = a surface component none of whose rooms got a position from the
  // main solve or the ferry attach.
  const detached = components.filter((c) => ![...c].some((n) => positions.has(n)));
  if (!detached.length) return;

  // Park detached regions to the SOUTH of the placed map (just past its
  // southern edge), stacked west-to-east. South rather than east keeps them
  // clear of the viewer's own east-side grid of fully-unplaced no-exit rooms,
  // so a whole-world screenshot isn't cluttered by two parked groups colliding.
  // (Max Y over placed rooms = the map's south edge; min X aligns the row's
  // west with the map, guaranteeing no overlap with the main map above.)
  let southEdge = -Infinity;
  let westEdge = Infinity;
  for (const [n, p] of positions) {
    const g = gridDims.get(n);
    if (g) southEdge = Math.max(southEdge, p[1] + g[1]);
    westEdge = Math.min(westEdge, p[0]);
  }
  if (!Number.isFinite(southEdge)) southEdge = 0;
  if (!Number.isFinite(westEdge)) westEdge = 0;

  // World ground plane: the most common plane among placed rooms (ties -> the
  // lowest plane, deterministic).
  const planeCounts = new Map<number, number>();
  for (const n of positions.keys()) bump(planeCounts, planes.get(n) ?? 0);
  let groundPlane = 0; let bestCount = -1;
  for (const [p, c] of planeCounts) {
    if (c > bestCount || (c === bestCount && p < groundPlane)) { groundPlane = p; bestCount = c; }
  }

  let cursorX = westEdge;
  for (const comp of detached) {
    const nodes = [...comp].filter((n) => gridDims.has(n)).sort((a, b) => a - b);
    if (!nodes.length) continue;
    const { pos } = solvePositions(nodes, surface);
    if (connectors) hillClimbPositions(pos, surface);
    // rooms are placed by their top-left tile; take the region's bounding box
    // and its lowest plane
    let minLx = Infinity; let minLy = Infinity; let maxBx = -Infinity;
    let basePlane = Infinity;
    for (const n of nodes) {
      const p = pos.get(n)!; const g = gridDims.get(n)!;
      minLx = Math.min(minLx, p[0]); minLy = Math.min(minLy, p[1]);
      maxBx = Math.max(maxBx, p[0] + g[0]);
      basePlane = Math.min(basePlane, planes.get(n) ?? 0);
    }
    const dy = southEdge + DETACHED_GAP - minLy; // north edge sits GAP south of the map
    const dx = cursorX - minLx;
    const dPlane = groundPlane - (Number.isFinite(basePlane) ? basePlane : 0);
    for (const n of nodes) {
      const p = pos.get(n)!;
      positions.set(n, [p[0] + dx, p[1] + dy]);
      planes.set(n, (planes.get(n) ?? 0) + dPlane);
    }
    cursorX += (maxBx - minLx) + DETACHED_GAP; // stack the next region east of this one
  }
}

// Full placement pipeline: rooms MUST be in ascending idx order. Optional
// `connectors` is a Map(idx -> {m: [[x,y]...], f: [[x,y]...]}) of jigsaw
// connector tiles (see CONNECTOR_MESH_HASHES); when present the CALIBRATED
// model applies: every door link gets its +1 outward separation (joinStep) so
// rooms tile edge to edge, plus a discrete refinement that keeps rounding
// exact. Without it the plain door-tile constraint applies, which places
// joined rooms one tile too close (the pre-calibration model).
// -> {
//   positions: Map(idx -> [x, y])   world-grid tile position (main component +
//                                   ferry annex; absent = unplaced room),
//   planes:    Map(idx -> z)        mode of the room's exit planes,
//   numbers:   Map(idx -> num)      voted in-game room numbers,
//   links:     [{ a, aTile, b, bTile, aCode, bCode }]  paired door adjacency,
//   components: [Set(idx)]          surface components, largest first,
// }
export function stitchWorld(
  rooms: StitchRoom[],
  connectors: Map<number, { m: number[][]; f: number[][] }> | null = null,
): WorldPlacement {
  const roomIndices = rooms.map((r) => r.idx);
  const exitsByRoom = new Map(rooms.map((r): [number, RoomExit[]] => [r.idx, r.exits]));
  const names = new Map(rooms.map((r): [number, string | null] => [r.idx, r.name]));
  const gridDims = new Map<number, number[]>(); // minimap inner-rect dims
  const dims = new Map<number, number[]>();     // stack dims, falling back to grid dims
  for (const r of rooms) {
    if (r.gridW != null) gridDims.set(r.idx, [r.gridW, r.gridH!]);
    if (r.w != null) dims.set(r.idx, [r.w, r.h!]);
    else if (r.gridW != null) dims.set(r.idx, [r.gridW, r.gridH!]);
  }

  const { links, numbers } = buildLinks(exitsByRoom, roomIndices);
  // Calibrated solver copies: aTile is rewritten so aTile - bTile carries the
  // +1 outward separation (joinStep): rooms tile edge to edge, door tiles
  // adjacent. The returned `links` keep their real door tiles; only the
  // placement math takes the steps.
  const solveLinks = connectors
    ? links.map((l) => {
      const step = joinStep(l, dims);
      return step === null
        ? l
        : { ...l, aTile: [l.aTile[0] + step[0], l.aTile[1] + step[1]] };
    })
    : links;
  // every paired link is a real same-plane adjacency
  const surface = solveLinks.filter((l) => dims.has(l.a) && dims.has(l.b));
  const components = componentsOf(surface);
  const positions = new Map<number, number[]>();
  const grids = new Map<number, number[]>();
  if (components.length) {
    const nodes = [...components[0]].sort((a, b) => a - b);
    const { pos } = solvePositions(nodes, surface);
    if (connectors) hillClimbPositions(pos, surface);
    for (const n of nodes) {
      if (gridDims.has(n)) {
        positions.set(n, pos.get(n)!);
        grids.set(n, gridDims.get(n)!);
      }
    }
    attachFerries(positions, grids, { surface, numbers, names, exitsByRoom, roomIndices, gridDims });
  }
  const planes = new Map(rooms.map((r): [number, number] => [r.idx, planeOf(r.exits)]));
  // Park any door-component the main solve + ferry attach could not reach (cut
  // future-episode regions) east of the placed map on the ground plane. No-op
  // for a fully connected build.
  placeDetachedComponents(components, positions, planes, surface, gridDims, connectors);
  return { positions, planes, numbers, links, components };
}
