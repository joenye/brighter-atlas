// How long the game takes to walk a route, frame by frame: each tile step's duration
// from the mover's movement kinds, and the game's blender, which plays the steps on a 600-tick-a-second clock in
// sub-steps of at most 5 ticks, trailing its timeline by 100 ticks (easing in and out), moving in straight lines
// at a constant rate within a step (height too). float32 throughout, as the game computes it.
import {type RoomGrid, DIRS, costOf, wordIndex, levelOf} from './grid.js';
import {type Tile, findPath, smoothPath, walkWaypoints, type FindOptions} from './path.js';

const f = Math.fround;
export const TICKS_PER_SECOND = 600;
/** Units: a tile is 1024 world units across, a level 512 (half a tile) high. */
export const TILE_UNITS = 1024, LEVEL_UNITS = 512;
const ctrunc = (a: number, b: number) => Math.trunc(a / b);   // (C integer division; exact for the magnitudes used)
const SQRT2 = f(1.4142135381698608);

/** A movement kind (the game's kinematic): how a step of one kind is timed. */
export interface Kind {
  /** Ticks for the step with a travel facing (a straight tile; diagonals take it x sqrt 2). */
  ticks: number;
  /** Ticks with no travel facing (a ladder rung, a climb). */
  still: number;
  /** The change of standing level the kind makes (-2..2). */
  levels: number;
  /** Turn on the spot first (180 ticks) when the facing changes. */
  turnFirst: boolean;
  /** The step cost the room grid gives a step of this kind. */
  cost: number;
}
/** A mover profile: its size and its movement kinds by index (22: walking on the flat). */
export interface Mover { size: number; kinds: (Kind | null)[] }
/** The flat walking kind: the one the Speed Boost quickens. */
export const FLAT_WALK = 22;
/** The Speed Boost tiers' speed factors (flat walking only): 198, 162, 120 and 90 ticks a tile for the player. */
export const SPEED_BOOST = [f(1.2121211290359497), f(1.4814814329147339), f(2.0), f(2.6666665077209473)];
/** The turn on the spot: 180 ticks, easing out (1 - (1 - t/180)^2), the short way round. */
export const TURN_TICKS = 180;
export const turnEase = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t / TURN_TICKS))) ** 2;
/** The facing a step travels at, in degrees (S 0, W 90, N 180, E 270). */
export const travelYaw = (dx: number, dy: number) => ((Math.atan2(-dx, dy) * 180 / Math.PI) % 360 + 360) % 360;

/** Ticks for one step: trunc(trunc(ticks * facing multiplier) / speed), + 180 when it turns first. */
export function stepTicks(kind: Kind, diagonal: boolean, speed = f(1), facingChanged = false): number {
  const base = Math.trunc(f(f(kind.ticks) * (diagonal ? SQRT2 : f(1))));
  return Math.trunc(f(f(base) / f(speed))) + (facingChanged && kind.turnFirst ? TURN_TICKS : 0);
}

/** The facing (yaw, degrees): eases to its target over 180 real ticks, 1 - (1 - t/180)^2, the short way round (an
 *  exact reversal goes the positive way); a new target restarts the turn from where it stands. */
export class Facing {
  from: number; target: number; yaw: number; el = TURN_TICKS;
  constructor(yaw: number) { this.from = this.target = this.yaw = yaw; }
  turnTo(target: number) { if (target === this.target) return; this.from = this.yaw; this.target = target; this.el = 0; }
  advance(ticks: number) {
    this.el = Math.min(TURN_TICKS, this.el + ticks);
    let diff = ((this.target - this.from) % 360 + 540) % 360 - 180;
    if (diff === -180) diff = 180;
    const x = this.el / TURN_TICKS, y = this.from + diff * (1 - (1 - x) ** 2);
    this.yaw = this.el >= TURN_TICKS ? this.target : (y % 360 + 360) % 360;
  }
}
export interface Order { target: [number, number, number]; dur: number; turn: boolean; el: number; b4: number; b8: number; yaw: number | null; kind: number }
/** A frame: the clock `t`, the actor's position (tile corner x, y; level z), facing, speed, the blender's timeline
 *  (L, lag), whether a step is still under way, and `steps`, the walk's fractional step count (the walk clip's
 *  phase: walkClipTicks). */
export interface Frame { t: number; pos: [number, number, number]; yaw: number; speed: number; L: number; lag: number; moving: boolean; steps: number }

/** The game's blender: positions (tile corner x, y in tiles; z in levels) advanced frame by frame. */
export class Blender {
  start: [number, number, number]; pos: [number, number, number];
  speed = 0; L = 0; lag = 0; c0 = 0; c4 = 0; queue: Order[] = []; started = false; facing: Facing;
  // (the stride phase's settings: its divisor over the ground, over the height, and how it settles at a step's end)
  private tilesPerStep: number; private levelsPerStep: number; private settle: number;
  constructor(at: [number, number, number], tilesPerStep = f(1), levelsPerStep = f(0), settle = 1, yaw = 0) {
    this.start = at.map(f) as [number, number, number]; this.pos = [...this.start]; this.facing = new Facing(yaw);
    this.tilesPerStep = tilesPerStep; this.levelsPerStep = levelsPerStep; this.settle = settle;
  }
  /** Queue a step to `target`, `ticks` long, turning first when `turn`, facing `yaw` (null: as it is); `kind`: the
   *  step's movement kind, kept for the caller (the clip it plays). */
  add(target: [number, number, number], ticks: number, turn: boolean, yaw: number | null = null, kind = -1) { this.queue.push({target: target.map(f) as [number, number, number], dur: ticks, turn, el: 0, b4: 0, b8: 0, yaw, kind}); }
  private speedControl(step: number, T = 100) {
    if (!this.queue.length) { this.L = 0; this.speed = 0; this.lag = 0; return; }
    const lag = this.L * 1000 - this.queue[0].el; this.lag = lag;
    let tgt: number;
    if (lag < -1000) tgt = f(0.2);
    else if (lag < T * 1000 - 2500) tgt = f(f(f(f(ctrunc(lag * 1000, T * 1000)) / f(1000)) * f(0.8)) + f(0.2));
    else if (lag > T * 1000 + 2500) tgt = f(f(f(ctrunc(lag - T * 1000, 100)) / f(1000)) + f(1));
    else tgt = f(1);
    if (this.speed === 0) this.speed = tgt;
    else {
      const d = f(tgt - this.speed);
      if (d !== 0) { const amt = Math.min(f(f(step) / f(30)), Math.abs(d)); this.speed = f(f(Math.sign(d) * amt) + this.speed); }
    }
    const total = this.queue.reduce((a, o) => a + o.dur, 0);
    this.L = Math.min(this.L + step, total);
  }
  /** The leftover (thousandths of a tick) when the order completes, else null. */
  private orderUpdate(o: Order, remaining: number): number | null {
    const speedk = Math.trunc(f(this.speed * f(1000)));
    o.el += ctrunc(speedk * remaining, 1000);
    let el = o.el, tot = o.dur * 1000;
    if (o.turn) { if (el <= 179999) return null; el -= 180000; tot -= 180000; }   // (turning on the spot)
    const fr = tot <= 0 ? 1 : Math.min(f(f(el) / f(tot)), 1);
    const delta = [0, 1, 2].map(k => f(o.target[k] - this.start[k]));
    let dist: number, div: number;
    if (this.tilesPerStep !== 0) { dist = f(Math.sqrt(f(f(delta[0] * delta[0]) + f(delta[1] * delta[1])))); div = this.tilesPerStep; }
    else { dist = Math.abs(delta[2]); div = this.levelsPerStep; }
    this.pos = [0, 1, 2].map(k => f(this.start[k] + f(delta[k] * fr))) as [number, number, number];
    this.c0 = f(o.b4 + f(f(dist * fr) / div)); this.c4 = f(o.b8 + f(fr / Math.abs(div)));
    if (fr >= 1) {
      this.start = [...o.target];
      if (this.settle === 0) this.c4 = Math.floor(this.c0); else this.c0 = this.c4;
      return o.el - o.dur * 1000;
    }
    return null;
  }
  private startNext() { this.L = ctrunc(this.lag, 1000); if (this.queue.length) { this.queue[0].b4 = this.c0; this.queue[0].b8 = this.c4; } this.started = true; }
  private tick(step: number) {
    if (!this.started && this.queue.length) this.startNext();
    // (the facing: the current step's, turned toward as soon as the step is the current one)
    if (this.queue.length && this.queue[0].yaw != null) this.facing.turnTo(this.queue[0].yaw);
    this.facing.advance(step);
    this.speedControl(step);
    let remaining = step * 1000;
    while (this.queue.length) {
      const left = this.orderUpdate(this.queue[0], remaining);
      if (left === null) break;
      remaining = Math.min(left, remaining);
      this.queue.shift();
      if (this.queue.length) this.startNext(); else this.L = 0;
    }
  }
  /** One frame of `ticks` clock ticks (10 at 60 frames a second), in sub-steps of at most 5. */
  frame(ticks: number) { while (ticks > 0) { const st = Math.min(5, ticks); ticks -= st; this.tick(st); } }
  /** The walk's fractional step count (what the walk clip is played by). */
  get steps() { return this.c4; }
}

/** Play a route (positions, tile corner x, y and level z) through the blender, a frame at a time. */
export function simulate(route: [number, number, number][], ticks: number[], turns: boolean[], frameTicks = 10, limit = 200000, yaws?: number[], startYaw?: number): Frame[] {
  const b = new Blender(route[0], f(1), f(0), 1, startYaw ?? yaws?.[0] ?? 0);
  route.slice(1).forEach((t, k) => b.add(t, ticks[k], turns[k], yaws?.[k] ?? null));
  const rows: Frame[] = [];
  let t = 0;
  // (until standing still: the last step done and the facing settled)
  while ((b.queue.length || b.facing.el < TURN_TICKS) && t < limit) { b.frame(frameTicks); t += frameTicks; rows.push({t, pos: [...b.pos], yaw: b.facing.yaw, speed: b.speed, L: b.L, lag: b.lag, moving: b.queue.length > 0, steps: b.c4}); }
  return rows;
}

export interface Step { to: Tile; level: number; kind: number; yaw: number; turn: boolean; ticks: number }
/** Each tile step of a walked route timed: its movement kind (the first whose grid cost and level change match the
 *  step's), facing, turn and ticks. `boost`: the Speed Boost tier (0..3) on flat walking. */
export function routeSteps(r: RoomGrid, group: number, tiles: Tile[], mover: Mover, startYaw: number, boost: number | null = null): Step[] {
  const out: Step[] = [], g = r.groups[group];
  let prev = startYaw;
  for (let k = 1; k < tiles.length; k++) {
    const a = tiles[k - 1], b = tiles[k], dx = b[0] - a[0], dy = b[1] - a[1];
    const d = DIRS.findIndex(([x, y]) => x === dx && y === dy);
    if (d < 0) throw Error(`not adjacent: ${a} -> ${b}`);
    const cost = costOf(g, wordIndex(r, a[0], a[1], a[2], mover.size), d), dh = levelOf(r, ...b) - levelOf(r, ...a);
    const kind = mover.kinds.findIndex(m => m && m.cost === cost && m.levels === dh);
    if (kind < 0) throw Error(`no movement kind for cost ${cost}, level change ${dh} at ${a} -> ${b}`);
    const m = mover.kinds[kind]!, yaw = travelYaw(dx, dy), changed = yaw !== prev;
    const speed = boost != null && kind === FLAT_WALK ? SPEED_BOOST[boost] : f(1);
    out.push({to: b, level: levelOf(r, ...b), kind, yaw, turn: changed && m.turnFirst, ticks: stepTicks(m, !!(dx && dy), speed, changed)});
    prev = yaw;
  }
  return out;
}

export interface Walk { path: Tile[]; waypoints: Tile[]; walked: Tile[]; steps: Step[]; frames: Frame[]; arrive: number }
/** Click to arrival, as the game walks it: path -> smoothing -> direct steps toward each waypoint -> timed steps
 *  -> the blender, frame by frame. `arrive`: ticks from the first frame until standing on the last tile. */
export function clickToArrival(r: RoomGrid, group: number, mover: Mover, start: Tile, goal: Tile,
  o: FindOptions & {startYaw?: number, boost?: number | null, frameTicks?: number} = {}): Walk {
  const size = mover.size, path = findPath(r, group, start, goal, {...o, size});
  if (path.length < 2) return {path, waypoints: [], walked: path, steps: [], frames: [], arrive: 0};
  const waypoints = smoothPath(r, group, path, size), walked = walkWaypoints(r, group, path[0], waypoints, size);
  const steps = routeSteps(r, group, walked, mover, o.startYaw ?? travelYaw(walked[1][0] - walked[0][0], walked[1][1] - walked[0][1]), o.boost ?? null);
  const route: [number, number, number][] = [[walked[0][0], walked[0][1], levelOf(r, ...walked[0])], ...steps.map(s => [s.to[0], s.to[1], s.level] as [number, number, number])];
  const frames = simulate(route, steps.map(s => s.ticks), steps.map(s => s.turn), o.frameTicks ?? 10, 200000, steps.map(s => s.yaw), o.startYaw);
  // (arrival: the frame the last step completes; the facing may still be settling after it)
  const done = frames.findIndex(fr => !fr.moving);
  return {path, waypoints, walked, steps, frames, arrive: done >= 0 ? frames[done].t : frames.length ? frames[frames.length - 1].t : 0};
}
/** World position (units) of an actor's corner tile position for a w x h footprint. */
export const worldOf = (p: [number, number, number], w = 1, h = 1): [number, number, number] => [(p[0] + w / 2) * TILE_UNITS, (p[1] + h / 2) * TILE_UNITS, p[2] * LEVEL_UNITS];
/** The walk clip's time for a fractional step count: the clip is driven by distance, not time. The player's walk
 *  clip (2914, or 3889 for the other body) is 2000 ticks for 8 steps, so a tile is 250 clip ticks. `from`: the step
 *  count when the walk request was posted (it is posted with that offset). */
export const walkClipTicks = (steps: number, from = 0, clipTicks = 2000, stepsPerCycle = 8) => {
  const x = (steps - from) / stepsPerCycle; return Math.trunc(clipTicks * (x - Math.floor(x)));
};

