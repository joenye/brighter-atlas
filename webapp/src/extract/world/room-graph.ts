// Cross-build room-name fill: align this build's stitched world placement
// against a reference room list ({v:1, rooms:[{n,p,x,y,w,h}]}: single-letter
// keys keep the file small) and name the rooms whose derived name is missing.
//
// Per plane, rooms whose name uniquely matches a reference name become
// anchors; each votes a translation delta and the modal delta (when at least
// MIN_ANCHORS anchors exist and enough of them agree) aligns the plane.
// A still-unnamed room is filled only when exactly one reference room sits at
// its aligned position with near-identical dimensions. Pure and
// dependency-free; worker-safe.

export interface FillRoom {
  idx: number;
  name: string | null;
  plane: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ReferenceRoom {
  n: string; // name
  p: number; // plane
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoomReference {
  v: number;
  rooms: ReferenceRoom[];
}

export interface PlaneFillStats {
  anchors: number;
  delta: [number, number] | null;
  filled: number;
  skipped: boolean;
}

export interface FillResult {
  names: Map<number, string>;
  stats: Record<number, PlaneFillStats>;
}

const MIN_ANCHORS = 3;       // fewer anchors -> the plane's alignment is untrusted
const MIN_AGREEMENT = 0.6;   // modal delta must hold for this share of anchors
const MAX_DIM_DRIFT = 2;     // per-axis w/h tolerance for a positional match

// Names that appear exactly once in the list (by the given key).
function uniqueNames<T>(items: T[], nameOf: (item: T) => string | null): Map<string, T> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = nameOf(item);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const unique = new Map<string, T>();
  for (const item of items) {
    const name = nameOf(item);
    if (name && counts.get(name) === 1) unique.set(name, item);
  }
  return unique;
}

// rooms: this build's extracted rooms with stitched world positions;
// reference: a prior build's named room list. -> the names to fill (only for
// rooms whose name is null) plus per-plane diagnostics.
export function fillRoomNames(rooms: FillRoom[], reference: RoomReference): FillResult {
  const names = new Map<number, string>();
  const stats: Record<number, PlaneFillStats> = {};
  if (!reference || reference.v !== 1 || !Array.isArray(reference.rooms)) {
    return { names, stats };
  }

  const roomsByPlane = new Map<number, FillRoom[]>();
  for (const room of rooms) {
    if (!roomsByPlane.has(room.plane)) roomsByPlane.set(room.plane, []);
    roomsByPlane.get(room.plane)!.push(room);
  }
  const refByPlane = new Map<number, ReferenceRoom[]>();
  for (const ref of reference.rooms) {
    if (!refByPlane.has(ref.p)) refByPlane.set(ref.p, []);
    refByPlane.get(ref.p)!.push(ref);
  }

  for (const [plane, planeRooms] of roomsByPlane) {
    const planeRefs = refByPlane.get(plane) ?? [];
    const planeStats: PlaneFillStats = { anchors: 0, delta: null, filled: 0, skipped: true };
    stats[plane] = planeStats;

    // Anchors: extracted name === reference name, the name unique within the
    // plane in BOTH sets. Each votes delta = reference pos - extracted pos.
    const uniqueRooms = uniqueNames(planeRooms, (r) => r.name);
    const uniqueRefs = uniqueNames(planeRefs, (r) => r.n);
    const votes = new Map<string, { delta: [number, number]; count: number }>();
    let anchorCount = 0;
    for (const [name, room] of uniqueRooms) {
      const ref = uniqueRefs.get(name);
      if (!ref) continue;
      anchorCount++;
      const delta: [number, number] = [ref.x - room.x, ref.y - room.y];
      const key = `${delta[0]},${delta[1]}`;
      const vote = votes.get(key);
      if (vote) vote.count++;
      else votes.set(key, { delta, count: 1 });
    }
    planeStats.anchors = anchorCount;
    if (anchorCount < MIN_ANCHORS) continue;

    let modal: { delta: [number, number]; count: number } | null = null;
    for (const vote of votes.values()) {
      if (!modal || vote.count > modal.count) modal = vote;
    }
    if (!modal || modal.count / anchorCount < MIN_AGREEMENT) continue;
    planeStats.delta = modal.delta;
    planeStats.skipped = false;

    // Fill each still-unnamed room from the single reference room (if any) at
    // its aligned position, dims within tolerance.
    const refsAt = new Map<string, ReferenceRoom[]>();
    for (const ref of planeRefs) {
      const key = `${ref.x},${ref.y}`;
      if (!refsAt.has(key)) refsAt.set(key, []);
      refsAt.get(key)!.push(ref);
    }
    const [dx, dy] = modal.delta;
    for (const room of planeRooms) {
      if (room.name != null) continue;
      const candidates = refsAt.get(`${room.x + dx},${room.y + dy}`);
      if (!candidates || candidates.length !== 1) continue;
      const ref = candidates[0];
      if (Math.abs(ref.w - room.w) > MAX_DIM_DRIFT || Math.abs(ref.h - room.h) > MAX_DIM_DRIFT) continue;
      names.set(room.idx, ref.n);
      planeStats.filled++;
    }
  }
  return { names, stats };
}
