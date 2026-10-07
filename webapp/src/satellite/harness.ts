// Satellite stills: a room seen from straight above, drawn by the game's own
// frame (game-frame.ts: its programs, lights, shadow map, ambient occlusion,
// water and floor), with the rooms through its doors drawn beside it at full
// light. One harness serves every room of a stored World extraction: the
// world data is read once, and one frame keeps its compiled programs and
// uploaded textures from room to room (only each room's buffers change).
// No viewer is involved: rooms are read straight from the store and handed
// to the frame, never built into a three.js scene.
//
// The camera is a narrow lens `height` tiles above the room's middle, looking
// down with north up: the ground lands exactly on the map's grid (`pxPerTile`
// pixels per tile) and a thing h tiles tall leans by h / height of its
// distance from the middle (under a pixel at the defaults). The still covers
// the room's map rectangle and `margin` tiles around it; its top left corner
// is the room's map position less the margin.
import * as THREE from '../../vendor/three.module.js';
import type { AppStore } from '../store.js';
import { WorldScene, type WorldSceneRoom } from '../viewers/world/scene.js';
import { GameFrame, type GameCamera, type GameRoomSource } from '../viewers/world/game-frame.js';
import { doorNeighbours } from '../viewers/world/neighbours.js';
import { FrameInputs, sha256 } from './fingerprint.js';

export interface StillSettings {
  /** Pixels per map tile. */
  pxPerTile: number;
  /** Tiles of floor around the room. */
  margin: number;
  /** The camera's height (tiles). */
  height: number;
  /** Draw the rooms through its doors beside it. */
  neighbours: boolean;
  /** Frames drawn from a fresh occlusion history (the ambient occlusion
   *  accumulates over frames; the last is kept). */
  frames: number;
  /** The water's clock (scene ticks). */
  ticks: number;
  /** Draw roofs and whatever else is built overhead; off, a cutaway (see
   *  cutShard): roofs and the tops of walls go, floors, furniture and trees stay. */
  roofs: boolean;
  /** The game's floor (the ground plane it lays at z = 0 under and around a
   *  room): 'endless' as far as the still reaches, 'room' only under the
   *  rooms drawn (each room's own tiles: the ground between rooms stays
   *  clear), 'none' not at all (a tile with no terrain of its own shows
   *  nothing). */
  floor: 'endless' | 'room' | 'none';
}

export const DEFAULT_STILL: Readonly<StillSettings> = Object.freeze({ pxPerTile: 32, margin: 12, height: 4000, neighbours: true, frames: 16, ticks: 0, roofs: true, floor: 'room' });

/** Height levels (half a tile each) for the cutaway (see cutShard). */
export const OVERHEAD_LEVELS = 4;
export const STACK_GAP = 2;
/** Tiles around a tile whose floors it is judged against. */
export const FLOOR_REACH = 2;

export interface SatelliteRoom {
  id: number;
  name: string;
  episode: string | null;
  /** The room's map position and size (map tiles). */
  mapPosition: [number, number];
  size: [number, number];
  /** Rooms drawn beside it (through its doors). */
  neighbours: number[];
}

export interface StillResult {
  roomId: number;
  fingerprint: string;
  /** The fingerprint's parts, each digested alone (what changed between builds). */
  parts: Record<string, string>;
  /** The still's top left corner (map tiles) and size (pixels). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** RGBA rows, top first (absent when the fingerprint was already known). */
  rgba?: Uint8Array;
  /** Milliseconds per stage. */
  timings: Record<string, number>;
}

const SHARD_CACHE = 48;

/** One placement roofs off leaves out: where, how high, and what the tile keeps. */
export interface CutRecord { category: string; reason: string; tile: string; z: number; kept: number; stack: number[]; mesh: number; box: number[] | null; flags: number }
const PAYLOAD_CACHE = 1500;   // decoded mesh payloads kept (rooms share most of their meshes)

/** The store with its mesh payloads cached across rooms (a room's neighbours
 *  are drawn again with every room beside them). */
function cachingStore(store: AppStore): AppStore {
  const cache = new Map<string, Promise<any>>();
  const payload = (rel: string): Promise<any> => {
    if (!rel.startsWith('meshes/')) return store.payload(rel);
    let p = cache.get(rel);
    if (p) { cache.delete(rel); cache.set(rel, p); return p; }
    p = store.payload(rel);
    p.catch(() => cache.delete(rel));
    cache.set(rel, p);
    while (cache.size > PAYLOAD_CACHE) cache.delete(cache.keys().next().value!);
    return p;
  };
  // everything else is the store's own, called on the store itself
  return new Proxy(store, {
    get(target, key) {
      if (key === 'payload') return payload;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export class SatelliteHarness {
  private readonly shards = new Map<number, any>();
  private roomList: SatelliteRoom[] = [];

  private constructor(
    readonly store: AppStore,
    readonly world: WorldScene,
    readonly frame: GameFrame,
    readonly inputs: FrameInputs,
    /** Identifies the drawing code (part of every fingerprint). */
    readonly codeKey: string,
    /** A mesh's bounds (its own frame: min x y z, max x y z). */
    private readonly meshBox: (mesh: number) => number[] | null,
  ) {}

  /** A harness over the store's World extraction, drawing into `gl` (a WebGL 2
   *  context of its own: the frame draws offscreen at any size). */
  static async open(store: AppStore, gl: WebGL2RenderingContext, codeKey: string): Promise<SatelliteHarness> {
    const world = new WorldScene({ scene: new THREE.Scene() as any, store: cachingStore(store), groundPlanes: true, showGroundPlane: true,
      groundPlaneDistance: Infinity, neighbourShade: false });
    const index = await world.init();
    if (!index?.render) throw new Error('this World extraction has no game shading data (re-extract World with a supported build)');
    const frame = new GameFrame(gl, (rel: string) => store.url(rel), index.render, world.tileUnits);
    frame.neighbourFade = false;          // neighbours at full light
    frame.planeDistance = Infinity;       // the endless floor
    frame.showPlane = true;
    // the fog lies on the ground seen from the room's own camera: from straight above it would only veil it
    frame.showFog = false;
    const images = new Map((await store.index('images')).map((e) => [e.i, e.h ?? null]));
    const boxes = new Map((await store.index('meshes')).map((e) => [e.i, Array.isArray(e.bbox) ? e.bbox.map(Number) : null]));
    const inputs = new FrameInputs(index, frame.shaders, (id) => images.get(id) ?? null);
    const harness = new SatelliteHarness(store, world, frame, inputs, codeKey, (id) => boxes.get(id) ?? null);
    harness.roomList = (index.rooms ?? []).map((r: any): SatelliteRoom => ({
      id: Number(r.id), name: r.name ?? '', episode: r.episode?.name ?? null,
      mapPosition: [Number(r.mapPosition?.[0]), Number(r.mapPosition?.[1])],
      size: [Number(r.map_size?.[0] ?? r.size?.[0]), Number(r.map_size?.[1] ?? r.size?.[1])],
      neighbours: doorNeighbours(index, Number(r.id)).map((n) => n.id),
    })).filter((r: SatelliteRoom) => r.mapPosition.every(Number.isFinite) && r.size.every((n) => n > 0));
    return harness;
  }

  rooms(): SatelliteRoom[] { return this.roomList; }

  /** A shard without what is built overhead. At each tile the terrain rises
   *  in stacks of height levels; a gap of more than STACK_GAP levels starts
   *  another stack above the first (roof blocks, a deck). The floor a tile is
   *  judged against is the lowest first-stack top within FLOOR_REACH tiles
   *  (towers and walls rise sharply from the ground beside them; hills rise
   *  gradually, so a hill's own surface is its floor). A tile whose highest
   *  terrain is a flat face (a floor, a cliff top, a wall walk) keeps its
   *  first stack whole: terrain is built of faces, and cutting a cliff would
   *  leave an empty shell. A tile topped by a sloped piece (a roof) keeps its
   *  first stack only up to OVERHEAD_LEVELS above that floor: walls to head
   *  height, not the roofs on them nor roofs overhanging a tile with no floor
   *  of its own. A stack standing on the floor is only cut where a flat face
   *  closes it at the cut's height; rock whose sloped top is all there is
   *  (cave walls, crags) stays whole. A stack floating above
   *  the floor (an overhang) goes: what is under it is another room's. Models and components more than OVERHEAD_LEVELS above
   *  what the tile keeps go too (roofs, upper walls); floors, furniture,
   *  people and trees stay. Nothing standing on water is cut (a ship's deck
   *  and masts rise far above the sea bed, as do piers), nor anything drawn
   *  see-through (foliage, hedges, fences: stacks of it are hollow inside, so
   *  a cut would leave a hole; roofs and walls are solid). */
  private readonly roofless = new Map<number, any>();
  private async cutShard(id: number): Promise<any> {
    let cut = this.roofless.get(id);
    if (cut) return cut;
    const shard = await this.shard(id);
    const oc = this.world.occurrenceColumns!, pc = this.world.placementColumns!;
    const key = (x: number, y: number) => `${x},${y}`;
    const tileOf = (occ: any[]) => key(Number(occ[oc.x]), Number(occ[oc.y]));
    const levels = new Map<string, number[]>();
    const water = this.world.index?.water?.materials ?? {};
    const wet = new Set<string>();
    // each tile's highest terrain surface, and whether a flat face makes it
    const L = this.world.layerUnits;
    const highest = new Map<string, { top: number; flat: boolean }>();
    const flats = new Map<string, number[]>();   // each tile's flat faces (height levels)
    for (const row of shard.placements.terrain ?? []) {
      const occ = shard.occurrences[row[pc.occurrence]];
      if (!occ) continue;
      if (water[String(row[pc.material])]) wet.add(tileOf(occ));
      const box = this.meshBox(Number(row[pc.mesh]));
      if (box) {
        const top = Number(occ[oc.z]) * L + box[5], flat = box[5] - box[2] <= 1;
        const h = highest.get(tileOf(occ));
        if (!h || top > h.top + 1) highest.set(tileOf(occ), { top, flat });
        else if (Math.abs(top - h.top) <= 1 && flat) h.flat = true;
        if (flat) (flats.get(tileOf(occ)) ?? flats.set(tileOf(occ), []).get(tileOf(occ))!).push(Number(occ[oc.z]));
      }
      const list = levels.get(tileOf(occ)) ?? levels.set(tileOf(occ), []).get(tileOf(occ))!;
      list.push(Number(occ[oc.z]));
    }
    // each tile's first stack: its top
    const first = new Map<string, number>();
    let lowest = Infinity;
    for (const [tile, list] of levels) {
      list.sort((a, b) => a - b);
      let top = list[0];
      for (const z of list) { if (z - top > STACK_GAP) break; top = z; }
      first.set(tile, top);
      lowest = Math.min(lowest, list[0]);
    }
    const bottom = (tile: string) => levels.get(tile)?.[0];
    const base = Number.isFinite(lowest) ? lowest : 0;
    // what each tile keeps: its first stack, to OVERHEAD_LEVELS above the floor around it
    const keptTop = new Map<string, number>();
    const kept = (tile: string): number => {
      let top = keptTop.get(tile);
      if (top !== undefined) return top;
      const [x, y] = tile.split(',').map(Number);
      let floor = Infinity;
      for (let dy = -FLOOR_REACH; dy <= FLOOR_REACH; dy++) for (let dx = -FLOOR_REACH; dx <= FLOOR_REACH; dx++) {
        const t = first.get(key(x + dx, y + dy));
        if (t !== undefined) floor = Math.min(floor, t);
      }
      if (!Number.isFinite(floor)) floor = base;
      const own = first.get(tile), cut = Math.min(own ?? floor, floor + OVERHEAD_LEVELS);
      const grounded = own !== undefined && bottom(tile)! <= floor + OVERHEAD_LEVELS;
      // a flat face at the cut's height closes the stack there (else it is an open shell)
      const leavesFloor = (flats.get(tile) ?? []).some((z) => z <= cut && z >= cut - 1);
      top = own === undefined || cut >= own ? cut
        : highest.get(tile)?.flat || (grounded && !leavesFloor) ? own   // a floor, a cliff, bare rock: whole
          : cut;
      keptTop.set(tile, top);
      return top;
    };
    const seeThrough = this.world.flags.alpha;
    const removed: CutRecord[] = [];
    const placements = Object.fromEntries(Object.entries(shard.placements as Record<string, any[]>).map(([category, rows]) =>
      [category, rows.filter((row) => {
        const occ = shard.occurrences[row[pc.occurrence]];
        if (!occ || wet.has(tileOf(occ)) || Number(row[pc.flags]) & seeThrough) return true;
        const tile = tileOf(occ), z = Number(occ[oc.z]), top = kept(tile);
        const keep = category === 'terrain' ? z <= top : z <= top + OVERHEAD_LEVELS;
        const reason = category !== 'terrain' ? 'overhead model' : first.has(tile) && z > first.get(tile)! ? 'upper stack' : 'first stack cut';
        if (!keep) removed.push({ category, reason, tile, z, kept: top, stack: levels.get(tile) ?? [], mesh: Number(row[pc.mesh]),
          box: this.meshBox(Number(row[pc.mesh])), flags: Number(row[pc.flags]) });
        return keep;
      })]));
    cut = { ...shard, placements, removed };
    this.roofless.set(id, cut);
    while (this.roofless.size > SHARD_CACHE) this.roofless.delete(this.roofless.keys().next().value!);
    return cut;
  }

  private async shard(id: number): Promise<any> {
    let shard = this.shards.get(id);
    if (shard) { this.shards.delete(id); this.shards.set(id, shard); return shard; }
    shard = await this.world.roomShard(id);
    this.shards.set(id, shard);
    while (this.shards.size > SHARD_CACHE) this.shards.delete(this.shards.keys().next().value!);
    return shard;
  }

  /** The room (and its neighbours at their offsets) as the frame takes them,
   *  with the floor the settings ask for. */
  private async source(roomId: number, s: StillSettings): Promise<GameRoomSource> {
    const T = this.world.tileUnits;
    const room = async (id: number, x: number, y: number) => {
      const group = new THREE.Group();
      group.position.set(x * T, y * T, 0);
      group.updateMatrix();
      return { id, meta: this.world.roomMeta(id), shard: await (s.roofs ? this.shard(id) : this.cutShard(id)), group } as unknown as WorldSceneRoom;
    };
    const home = await room(roomId, 0, 0);
    const others = s.neighbours ? await Promise.all(doorNeighbours(this.world.index, roomId).map((n) => room(n.id, n.x, n.y))) : [];
    const source = await this.world.gameRoomSource(home, others);
    if (s.floor === 'endless') return source;
    if (s.floor === 'none') return { ...source, plane: [] };
    // 'room': the floor pieces under the rooms drawn (the game lays it under
    // and around them; here only what is within each room's own tiles)
    const rects = [home, ...others].map((r: any) => {
      const [w, h] = r.shard.size ?? [r.meta?.w ?? 0, r.meta?.h ?? 0];
      const x = Math.round(r.group.position.x / T), y = Math.round(r.group.position.y / T);
      return { x0: x, y0: y, x1: x + w, y1: y + h };
    });
    const under = (p: { x: number; y: number; size: [number, number] }) =>
      rects.some((r) => p.x >= r.x0 && p.y >= r.y0 && p.x + p.size[0] <= r.x1 && p.y + p.size[1] <= r.y1);
    return { ...source, plane: (source.plane ?? []).filter(under) };
  }

  /** The camera over the still's rectangle (room tiles, native frame). */
  private camera(room: SatelliteRoom, s: StillSettings): GameCamera & { near: number; far: number } {
    const T = this.world.tileUnits, D = s.height * T;
    const wt = room.size[0] + 2 * s.margin, ht = room.size[1] + 2 * s.margin;
    const cx = (room.size[0] / 2) * T, cy = (room.size[1] / 2) * T;
    return {
      eye: new THREE.Vector3(cx, cy, D), target: new THREE.Vector3(cx, cy, 0), up: new THREE.Vector3(0, -1, 0),
      fov: 2 * Math.atan((ht * T / 2) / D) * 180 / Math.PI,
      width: Math.round(wt * s.pxPerTile), height: Math.round(ht * s.pxPerTile),
      // depth: from 64 tiles above the ground to 16 below it
      near: D - 64 * T, far: D + 16 * T,
    };
  }

  /** One room's still, or only its fingerprint when `known` already holds it. */
  async still(roomId: number, settings: Partial<StillSettings> = {}, known?: (fingerprint: string) => boolean): Promise<StillResult> {
    const s: StillSettings = { ...DEFAULT_STILL, ...settings };
    const room = this.roomList.find((r) => r.id === roomId);
    if (!room) throw new Error(`no room ${roomId}`);
    const timings: Record<string, number> = {};
    let t = performance.now();
    const lap = (name: string) => { const now = performance.now(); timings[name] = Math.round(now - t); t = now; };
    const source = await this.source(roomId, s);
    lap('source');
    // roofs off only changes what the source holds: a room with nothing
    // overhead is the same still either way (its fingerprint says so)
    const { roofs: _roofs, ...drawn } = s;
    const { fingerprint, parts } = await this.inputs.digest(source, { code: this.codeKey, still: drawn });
    lap('fingerprint');
    const camera = this.camera(room, s);
    const result: StillResult = { roomId, fingerprint, parts, x: room.mapPosition[0] - s.margin, y: room.mapPosition[1] - s.margin,
      width: camera.width, height: camera.height, timings };
    if (known?.(fingerprint)) return result;
    await this.frame.setRoom(source);
    lap('build');
    this.frame.resetTemporal();
    for (let k = 0; k < s.frames; k++) this.frame.render(camera, s.ticks, 0, true);
    const out = this.frame.readMain();
    if (!out) throw new Error('the frame drew nothing');
    result.rgba = out.data;
    lap('render');
    return result;
  }

  /** What a still is drawn from, for telling why two builds' stills differ:
   *  each mesh with a digest of every payload field. */
  async explain(roomId: number, settings: Partial<StillSettings> = {}): Promise<unknown> {
    const s: StillSettings = { ...DEFAULT_STILL, ...settings };
    const source = await this.source(roomId, s);
    const out: Record<string, unknown>[] = [];
    const seen = new Set<object>();
    for (const scene of [source, ...(source.others ?? [])]) {
      for (const x of [...scene.batches, ...(scene.actors ?? [])]) {
        if (!x.payload || seen.has(x.payload)) continue;
        seen.add(x.payload);
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(x.payload)) fields[k] = (await sha256(JSON.stringify(v))).slice(0, 12);
        out.push({ mesh: x.mesh, key: await this.inputs.mesh(x.payload), fields });
      }
    }
    return out;
  }

  /** What roofs off leaves out of a room (its own shard), for tuning the rule. */
  async explainCut(roomId: number): Promise<CutRecord[]> {
    return (await this.cutShard(roomId)).removed;
  }

  /** Free the room's buffers (programs and textures stay for the next). */
  release(): void { this.frame.releaseRoom(); }
}
