// The room view's walk test: an actor walked about the room as the game walks it (src/movement/): click a
// tile and it routes there over the room's movement grid, steps tile by tile at its own speeds, eases in and
// out, turns, rises and falls with the floor and plays its walk clip by the distance covered. Wandering
// creatures wander as the game has them wander, and authored routes are drawn.
//
// This module holds the walking (Walker, Wanderer) and the overlays; viewers/world.ts gives it the actors'
// rigs and clips and asks it for their pose each frame.

import * as THREE from '../../../vendor/three.module.js';
import type { ClipSampler } from '../rig.js';
import { type RoomGrid, levelOf, groupFor, DIRS, costOf, wordIndex } from '../../movement/grid.js';
import { findPath, smoothPath, walkWaypoints, directWalk, pickWander, wanderArea, JavaRandom, WANDER_WAITS, type Tile } from '../../movement/path.js';
import { Blender, routeSteps, clickToArrival, travelYaw, TICKS_PER_SECOND, TILE_UNITS, LEVEL_UNITS, TURN_TICKS, type Mover, type Kind } from '../../movement/timing.js';
import type { MoversDoc, MoverActorDoc, LocomotionDoc, MoveClipDoc } from '../../extract/world/movers.js';

export const FLAT = 22;
/** The move request stops this many ticks before the last step ends (the idle takes over). */
const MOVE_TAIL = 30;

/** An actor's mover: its profile's kinds (or the player's), and the clips each kind of step plays. */
export interface ActorMover { mover: Mover; profile: number; locomotions: (LocomotionDoc | null)[]; player: boolean }

/** The mover an actor walks with; `asPlayer`: the player's own profile and clips (the player's everyday set). */
export function actorMover(doc: MoversDoc, actor: number | null, asPlayer: boolean): ActorMover | null {
  const a: MoverActorDoc | undefined = actor != null ? doc.actors[String(actor)] : undefined;
  const setSlot = asPlayer ? doc.player[0] : a?.set ?? null;
  const set = setSlot != null ? doc.sets[String(setSlot)] : null;
  const profile = set?.profile ?? a?.profile;
  const p = profile != null ? doc.profiles[String(profile)] : null;
  if (!p) return null;
  const kinds = p.kinds.map(k => (k == null ? null : doc.kinds[String(k)] as Kind ?? null));
  return { mover: { size: p.size, kinds }, profile: profile!, locomotions: set ? set.locomotions.map(l => (l == null ? null : doc.locomotions[String(l)] ?? null)) : [], player: asPlayer };
}

/** Every clip an actor's walking can play. */
export function moverClips(m: ActorMover): number[] {
  const out = new Set<number>();
  for (const l of m.locomotions) for (const c of l?.move ?? []) if (c) out.add(c.clip);
  return [...out];
}

/** The tile (x, y, layer) the game puts an actor's corner on from a native point in the room's frame. */
export function tileAt(grid: RoomGrid, x: number, y: number, z: number, size = 1): Tile | null {
  const tx = Math.floor(x / TILE_UNITS - (size - 1) / 2), ty = Math.floor(y / TILE_UNITS - (size - 1) / 2);
  if (tx < 0 || ty < 0 || tx > grid.W - size || ty > grid.H - size) return null;
  const l1 = levelOf(grid, tx, ty, 1);
  const layer = l1 && Math.abs(z - l1 * LEVEL_UNITS) < Math.abs(z - levelOf(grid, tx, ty, 0) * LEVEL_UNITS) ? 1 : 0;
  return [tx, ty, layer];
}

/** Can anything step from or onto this tile (a tile with a cost in any direction)? */
export function standable(grid: RoomGrid, group: number, t: Tile, size = 1): boolean {
  const g = grid.groups[group];
  if (!g || t[0] < 0 || t[1] < 0 || t[0] > grid.W - size || t[1] > grid.H - size) return false;
  const wi = wordIndex(grid, t[0], t[1], t[2], size);
  return DIRS.some((_, d) => costOf(g, wi, d) > 0);
}

export interface WalkReport {
  from: Tile; to: Tile; reached: Tile; tiles: number; stepTicks: number;
  /** ticks from the click until standing on the last tile, walking from rest */
  predicted: number | null;
  /** measured: ticks since the click (still walking: null) */
  arrived: number | null;
}

/** One actor walked by the game's blender. Its native position is in the room's own frame. */
export class Walker {
  blender: Blender;
  at: Tile;                     // the tile it stands on, or last stood on
  private acc = 0;
  private walkFrom = 0;         // the step count when the walk began (the walk clip's phase)
  private idleT = 0;
  private sinceClick = 0;
  report: WalkReport | null = null;
  path: Tile[] = [];
  boost: number | null = null;
  constructor(public grid: RoomGrid, public am: ActorMover, start: Tile, yaw: number) {
    this.at = start;
    this.group = groupFor(grid, am.profile);
    this.blender = new Blender([start[0], start[1], levelOf(grid, ...start)], Math.fround(1), Math.fround(0), 1, yaw);
  }
  group: number;
  get moving() { return this.blender.queue.length > 0; }
  get size() { return this.am.mover.size; }

  /** Walk to `goal` as the player does: the path finder, the walk smoothing, a direct step at a time. A click
   *  while walking keeps the step under way and routes on from its tile. */
  goTo(goal: Tile): WalkReport | null {
    const b = this.blender, q = b.queue;
    const from: Tile = q.length ? this.tileOf(q[0]) : this.at;
    const path = findPath(this.grid, this.group, from, goal, { size: this.size });
    if (path.length < 2) { if (q.length > 1) q.splice(1); return null; }
    const waypoints = smoothPath(this.grid, this.group, path, this.size);
    const walked = walkWaypoints(this.grid, this.group, from, waypoints, this.size);
    return this.follow(walked, goal, q.length ? null : this.predict(goal));
  }
  /** Walk a list of tiles (start included) step by step. */
  follow(walked: Tile[], goal: Tile, predicted: number | null = null): WalkReport | null {
    const b = this.blender, q = b.queue;
    if (walked.length < 2) return null;
    const prevYaw = q.length ? (q[0].yaw ?? b.facing.target) : b.facing.target;
    let steps;
    try { steps = routeSteps(this.grid, this.group, walked, this.am.mover, prevYaw, this.am.player ? this.boost : null); }
    catch { return null; }
    if (q.length) q.splice(1); else this.walkFrom = b.c4;
    steps.forEach((s) => b.add([s.to[0], s.to[1], s.level], s.ticks, s.turn, s.yaw, s.kind));
    this.path = walked;
    this.sinceClick = 0;
    this.report = { from: walked[0], to: goal, reached: walked[walked.length - 1], tiles: walked.length - 1, stepTicks: steps.reduce((a, s) => a + s.ticks, 0), predicted, arrived: null };
    return this.report;
  }
  /** Ticks from a click until standing on `goal`, walking from rest where it stands. */
  predict(goal: Tile): number | null {
    try {
      const w = clickToArrival(this.grid, this.group, this.am.mover, this.at, goal, { startYaw: this.blender.facing.yaw, boost: this.am.player ? this.boost : null, frameTicks: 10 });
      return w.path.length > 1 ? w.arrive : null;
    } catch { return null; }
  }
  private tileOf(o: { target: [number, number, number] }): Tile {
    const x = Math.round(o.target[0]), y = Math.round(o.target[1]);
    return [x, y, this.layerNear(x, y, o.target[2])];
  }
  private layerNear(x: number, y: number, z: number): number {
    const l1 = levelOf(this.grid, x, y, 1);
    return l1 && Math.abs(l1 - z) < Math.abs(levelOf(this.grid, x, y, 0) - z) ? 1 : 0;
  }
  /** Advance the game's clock by `ms` (600 ticks a second; whole ticks per frame, as the game's clock). */
  advance(ms: number): void {
    this.acc += ms * TICKS_PER_SECOND / 1000;
    const n = Math.floor(this.acc);
    if (n <= 0) return;
    this.acc -= n;
    const b = this.blender, before = b.queue.length;
    // (the tile reached: each completed order's target)
    const targets = b.queue.map(o => o.target);
    b.frame(n);
    const done = before - b.queue.length;
    if (done > 0) { const t = targets[done - 1]; const x = Math.round(t[0]), y = Math.round(t[1]); this.at = [x, y, this.layerNear(x, y, t[2])]; }
    this.idleT += n;
    if (this.report && this.report.arrived == null) {
      this.sinceClick += n;
      if (!b.queue.length) this.report.arrived = this.sinceClick;
    }
    if (b.queue.length) this.idleT = 0;
  }
  /** The clip to show and its time (ticks): the walk by the distance covered, the idle by time. */
  clip(clips: Map<number, ClipSampler>, idle: ClipSampler | null): { sampler: ClipSampler, t: number } | null {
    const b = this.blender, o = b.queue[0];
    const tail = o && b.queue.length === 1 && o.dur * 1000 - o.el < MOVE_TAIL * 1000;
    if (o && !tail && !(o.turn && o.el < TURN_TICKS * 1000)) {
      const mc = this.moveClip(o.kind, o.yaw);
      const s = mc && clips.get(mc.clip);
      if (s && s.duration > 0) {
        const x = (b.c4 - this.walkFrom) / mc!.steps;
        return { sampler: s, t: Math.trunc(s.duration * (x - Math.floor(x))) };
      }
    }
    if (!idle) return null;
    return { sampler: idle, t: idle.duration > 0 ? this.idleT % idle.duration : 0 };
  }
  /** The move the step's kind plays, by the angle between the facing and the travel. */
  private moveClip(kind: number, travel: number | null): MoveClipDoc | null {
    const l = this.am.locomotions[kind] ?? this.am.locomotions[FLAT];
    if (!l) return null;
    const a = travel == null ? 0 : ((this.blender.facing.yaw - travel) % 360 + 360) % 360;
    const k = a < 55 || a >= 305 ? 0 : a < 140 ? 2 : a < 220 ? 1 : 3;
    return l.move[k] ?? l.move[0];
  }
  /** The actor's native matrix in the room's frame: its footprint's centre at the blender's position, turned to
   *  its facing. `quarterTurns`: the mesh's own forward correction (the spawn frame's). */
  matrix(out: THREE.Matrix4, quarterTurns: number): THREE.Matrix4 {
    const [x, y, z] = this.blender.pos, s = this.size;
    out.makeRotationZ((this.blender.facing.yaw / 90 + quarterTurns) * Math.PI / 2);
    out.setPosition((x + s / 2) * TILE_UNITS, (y + s / 2) * TILE_UNITS, z * LEVEL_UNITS);
    return out;
  }
}

/** A wandering creature's loop, as the game runs it: pick a random tile of its box (its spawn tile +- radius),
 *  walk straight at it (stopping at the first wall), wait 300 to 3000 ms (its idle), then 1800 to 12000 ms, and
 *  pick again; with nothing to pick, try again after 600 ms. */
export class Wanderer {
  private wait: number;
  private rng: JavaRandom;
  constructor(public walker: Walker, public home: Tile, public radius: number, seed: number) {
    this.rng = new JavaRandom(seed);
    this.wait = this.rng.between(0, WANDER_WAITS.between[1]);   // (spawned at different moments)
  }
  advance(ms: number): void {
    const w = this.walker;
    w.advance(ms);
    if (w.moving) return;
    if ((this.wait -= ms) > 0) return;
    const pick = pickWander(w.grid, w.group, w.at, [this.home[0], this.home[1]], this.rng, this.radius, w.size);
    if (!pick) { this.wait = WANDER_WAITS.retry; return; }
    const walked = directWalk(w.grid, w.group, w.at, [pick], w.size);
    w.follow(walked, pick);
    this.wait = this.rng.between(...WANDER_WAITS.idle) + this.rng.between(...WANDER_WAITS.between);
  }
}

/** Where a wanderer can be: every tile its wanders reach from home. */
export function wanderTiles(grid: RoomGrid, am: ActorMover, home: Tile, radius: number): Tile[] {
  const g = groupFor(grid, am.profile);
  return [...wanderArea(grid, g, home, radius, am.mover.size).tiles].map(k => k.split(',').map(Number) as Tile);
}

// ---- overlays (native, the room's frame; drawn over everything)

const overlayMaterial = (color: number, opacity = 0.9) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
const LIFT = 40;   // units above the floor

/** A line through tile centres (the actor's footprint centre) at their standing height. */
export function tileLine(grid: RoomGrid, tiles: Tile[], color: number, size = 1): THREE.Line {
  const pts = tiles.map(t => new THREE.Vector3((t[0] + size / 2) * TILE_UNITS, (t[1] + size / 2) * TILE_UNITS, levelOf(grid, ...t) * LEVEL_UNITS + LIFT));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), overlayMaterial(color));
  line.renderOrder = 1000;
  return line;
}

/** Tiles as flat translucent squares. */
export function tileQuads(grid: RoomGrid, tiles: Tile[], color: number, opacity = 0.28): THREE.Mesh {
  const pos: number[] = [], m = 60;
  for (const t of tiles) {
    const x0 = t[0] * TILE_UNITS + m, y0 = t[1] * TILE_UNITS + m, x1 = (t[0] + 1) * TILE_UNITS - m, y1 = (t[1] + 1) * TILE_UNITS - m;
    const z = levelOf(grid, ...t) * LEVEL_UNITS + LIFT / 2;
    pos.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  mesh.renderOrder = 999;
  return mesh;
}

/** A tile's outline (the goal, the hovered tile). */
export function tileRing(grid: RoomGrid, t: Tile, color: number, size = 1): THREE.LineLoop {
  const z = levelOf(grid, ...t) * LEVEL_UNITS + LIFT, x0 = t[0] * TILE_UNITS, y0 = t[1] * TILE_UNITS, w = size * TILE_UNITS;
  const pts = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + w], [x0, y0 + w]].map(([x, y]) => new THREE.Vector3(x, y, z));
  const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), overlayMaterial(color, 1));
  ring.renderOrder = 1001;
  return ring;
}

export function disposeOverlay(o: THREE.Object3D): void {
  o.traverse((c: any) => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
  o.parent?.remove(o);
}

export const fmtTicks = (t: number | null) => t == null ? '-' : `${t} ticks (${(t / TICKS_PER_SECOND).toFixed(2)} s)`;
export { travelYaw };
