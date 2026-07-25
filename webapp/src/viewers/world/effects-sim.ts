// Particle effect simulation core for the world viewer. Pure math over the
// recovered world:effects doc (extract/world/effects.js): no DOM, no three.js.
//
// The design is closed-form: a particle's full state at display time T is a
// pure function of its spawn index, so there is no integration, no free list
// and no frame-rate dependence. Spawn times come from a deterministic
// schedule (continuous rate or burst windows, looping by the system cycle),
// and every random quantity of spawn n draws from a counter-based PRNG keyed
// (emitterSeed, n), so any clock value reproduces the same particles
// bit-for-bit. Because life is constant per emitter, retirement is strict
// FIFO and the alive set is a contiguous ring [tail, head): small clock steps
// advance the ring incrementally, and any discontinuity (seek, pause-resume
// jump, late activation) rebuilds it in O(alive) straight from the closed
// form, so no spawn backlog can ever visually catch up.
//
// Units: local native space (Z up), ticks. The tick rate is read from the
// doc (tick_rate.value, derived per build); durations are raw tick counts
// and per-second fields divide by the doc's rate, never by a constant.

import type {
  EffectConfig, EffectEmitter, EffectSystem,
} from '../../extract/world/effects.js';

/** Hard alive ceiling per emitter instance. Set to the game engine's OWN
 *  documented maximum ("max_particles must be >0 and <=16383"), so an emitter
 *  can reach any population the engine itself could produce. This is a
 *  runaway guard against malformed data, not a display budget: nothing thins
 *  an emitter that stays under it. */
export const PER_EMITTER_CAP = 16383;
/** Clock jumps beyond this many ticks rebuild the ring from the closed form
 *  instead of advancing it incrementally. */
export const MAX_CATCHUP_TICKS = 250;
/** Per-view alive budget for the model-page player, which previews ONE
 *  system on a small subject and has no reason to run unbounded.
 *
 *  The world views deliberately have no such budget: an effect's density is a
 *  property of the effect, not of how much else happens to be on screen, and
 *  a shared budget made the same brazier look full in its own room and thin
 *  in the merged view. Proximity activation already bounds how many rooms are
 *  live at once, and PER_EMITTER_CAP still guards against malformed data. */
export const MODEL_PREVIEW_ALIVE_BUDGET = 8192;

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;
// Burst-window sanity: a window emitting more spawns than this per cycle is
// treated as inert rather than allowed to explode the schedule arithmetic.
const WINDOW_SPAWN_CAP = 1e6;

const finite = (value: any, fallback: number): number => (
  Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value: number, lo: number, hi: number): number => (
  value < lo ? lo : value > hi ? hi : value);
// One envelope window's progress, saturated. A zero-length window is passed
// instantly (nothing to ramp through), which is what makes a missing fade
// mean "already opaque" rather than "never visible".
const ramp = (elapsed: number, span: number): number => (
  span > 0 ? clamp(elapsed / span, 0, 1) : (elapsed > 0 ? 1 : 0));

/** Deterministic 32-bit combine of two integers (seed material). */
export function hash32(a: number, b: number): number {
  let h = (a | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = (h + (b | 0)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Counter-based PRNG: tiny, fast, and fully determined by its seed. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Vec3 = [number, number, number];

interface ShapeSpec {
  kind: 'point' | 'ring' | 'spiral' | 'segment' | 'other';
  center: Vec3;
  // orthonormal frame: w = emission axis, u/v span its perpendicular plane
  w: Vec3; u: Vec3; v: Vec3;
  yaw: number;            // point cone azimuth range (rad)
  pitch: number;          // point cone polar range (rad)
  radius: number;         // ring radius (native units)
  sweep: number;          // ring arc (rad)
  spiral: { r0: number; rRate: number; a0: number; aRate: number } | null;
  // 'segment': spawn spread evenly between these two local-frame endpoints
  segment: { from: Vec3; to: Vec3 } | null;
}

interface WindowSpec { start: number; step: number; count: number }

function normalize(v: Vec3, fallback: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-9)) return fallback;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function axisFrame(axis: Vec3): { w: Vec3; u: Vec3; v: Vec3 } {
  const w = normalize(axis, [0, 0, 1]);
  const a: Vec3 = Math.abs(w[2]) < 0.99 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize([
    a[1] * w[2] - a[2] * w[1],
    a[2] * w[0] - a[0] * w[2],
    a[0] * w[1] - a[1] * w[0],
  ], [1, 0, 0]);
  const v: Vec3 = [
    w[1] * u[2] - w[2] * u[1],
    w[2] * u[0] - w[0] * u[2],
    w[0] * u[1] - w[1] * u[0],
  ];
  return { w, u, v };
}

function vec3Of(value: any, fallback: Vec3): Vec3 {
  if (Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(Number(n)))) {
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  }
  return fallback;
}

// Resolve a spawn-shape config (or its absence) into sampler parameters.
// The conservative fallback for missing/unclassified shapes is point
// emission at the config's centre (else the anchor) with a full azimuth
// sweep and a 30 degree polar spread.
function resolveShape(config: EffectConfig | null, fallbackAxis: Vec3, tickRate: number): ShapeSpec {
  const kind = config?.kind === 'shape' ? (config.shape_kind || 'other') : 'other';
  const center = vec3Of(config?.center, [0, 0, 0]);
  const axis = vec3Of(config?.spiral?.axis ?? config?.axis, fallbackAxis);
  const frame = axisFrame(axis);
  const spec: ShapeSpec = {
    kind: kind === 'point' || kind === 'ring' || kind === 'spiral' || kind === 'segment'
      ? kind : 'other',
    center,
    ...frame,
    yaw: clamp(finite(config?.spread_yaw, 360), 0, 360) * DEG,
    pitch: clamp(finite(config?.spread_pitch, 30), 0, 180) * DEG,
    radius: Math.max(0, finite(config?.radius, 0)),
    sweep: clamp(finite(config?.sweep, 360), 0, 360) * DEG,
    spiral: null,
    segment: null,
  };
  if (spec.kind === 'segment') {
    const from = vec3Of(config?.segment?.from, null as any);
    const to = vec3Of(config?.segment?.to, null as any);
    if (from && to) spec.segment = { from, to };
    else { spec.kind = 'other'; spec.yaw = TWO_PI; spec.pitch = 30 * DEG; }
  }
  if (spec.kind === 'other') {
    spec.yaw = TWO_PI;
    spec.pitch = 30 * DEG;
  }
  if (spec.kind === 'spiral' && config?.spiral) {
    spec.spiral = {
      r0: finite(config.spiral.start_radius, 0),
      rRate: finite(config.spiral.radius_rate, 0) / tickRate,
      a0: finite(config.spiral.start_angle, 0) * DEG,
      aRate: (finite(config.spiral.angle_rate, 0) * DEG) / tickRate,
    };
  } else if (spec.kind === 'spiral') {
    spec.kind = 'other';
    spec.yaw = TWO_PI;
    spec.pitch = 30 * DEG;
  }
  return spec;
}

/**
 * One emitter instance: schedule + per-particle spawn constants in a
 * contiguous FIFO ring, evaluated closed-form at any clock value.
 */
export class EmitterSim {
  seed: number;
  tickRate: number;
  // envelope + look constants (tick domain)
  life: number;
  fadeIn: number;
  fadeOut: number;
  color0: [number, number, number, number];
  color1: [number, number, number, number];
  scale0: number;
  scale1: number;
  speed: number;          // native units per tick
  spin: number;           // radians per tick
  accel: Vec3;            // native units per tick^2
  shape: ShapeSpec;
  // schedule
  rate: number;           // spawns per second (0 = inert)
  step: number;           // ticks between consecutive spawns
  windows: WindowSpec[] | null;
  cycleCount: number;     // spawns per cycle (windowed)
  period: number | null;  // cycle length in ticks (looping windowed)
  totalCount: number;     // finite spawn count for one-shot schedules
  // thinning + ring state
  k: number;
  capacity: number;
  birth!: Float64Array;
  px!: Float32Array; py!: Float32Array; pz!: Float32Array;
  vx!: Float32Array; vy!: Float32Array; vz!: Float32Array;
  tail = 0;
  head = 0;
  private _lastT = NaN;
  private _dirty = true;

  constructor(system: EffectSystem, emitterIndex: number, emitter: EffectEmitter,
    configs: Record<string, EffectConfig>, tickRate: number) {
    this.tickRate = tickRate;
    this.seed = hash32(system.slot | 0, emitterIndex | 0);

    this.life = Math.max(1, finite(emitter.life?.ticks, tickRate));
    this.fadeIn = clamp(finite(emitter.fade_in?.ticks, 0), 0, this.life);
    this.fadeOut = clamp(finite(emitter.fade_out?.ticks, 0), 0, this.life);
    const c0 = emitter.color0?.rgba;
    this.color0 = Array.isArray(c0) && c0.length === 4
      ? [finite(c0[0], 1), finite(c0[1], 1), finite(c0[2], 1), finite(c0[3], 1)]
      : [1, 1, 1, 1];
    const c1 = emitter.color1?.rgba;
    this.color1 = Array.isArray(c1) && c1.length === 4
      ? [finite(c1[0], 1), finite(c1[1], 1), finite(c1[2], 1), finite(c1[3], 1)]
      : [...this.color0] as [number, number, number, number];
    this.scale0 = clamp(finite(emitter.scale0?.value, 1), 0.01, 100);
    this.scale1 = clamp(finite(emitter.scale1?.value, this.scale0), 0.01, 100);
    this.speed = finite(emitter.speed?.value, 0) / tickRate;
    this.spin = finite(emitter.angular_speed?.value, 0) / tickRate;
    const accel = vec3Of(emitter.acceleration?.v, [0, 0, 0]);
    const t2 = tickRate * tickRate;
    this.accel = [accel[0] / t2, accel[1] / t2, accel[2] / t2];

    const fallbackAxis = normalize(vec3Of(emitter.direction?.v, [0, 0, 1]), [0, 0, 1]);
    const shapeCfg = emitter.shape != null ? configs[String(emitter.shape)] || null : null;
    this.shape = resolveShape(shapeCfg, fallbackAxis, tickRate);

    // Burst schedule. A missing/degenerate burst leaves the emitter inert
    // (alive stays zero); siblings are unaffected.
    const burst = emitter.burst != null ? configs[String(emitter.burst)] || null : null;
    const rate = Math.max(0, finite(burst?.per_second, 0));
    this.rate = rate;
    this.step = rate > 0 ? tickRate / rate : Infinity;
    this.windows = null;
    this.cycleCount = 0;
    this.period = null;
    this.totalCount = Infinity;
    const cycleTicks = Math.max(0, finite(system.cycle_ticks, 0));
    if (rate > 0 && burst?.kind === 'burst_windowed' && Array.isArray(burst.windows)) {
      const windows: WindowSpec[] = [];
      let total = 0;
      for (const pair of burst.windows) {
        const a = finite(pair?.[0], NaN);
        const b = finite(pair?.[1], NaN);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
        const count = Math.min(WINDOW_SPAWN_CAP, Math.floor(((b - a) * rate) / tickRate) + 1);
        windows.push({ start: a, step: this.step, count });
        total += count;
      }
      windows.sort((w1, w2) => w1.start - w2.start);
      if (!windows.length || total > WINDOW_SPAWN_CAP) {
        this.rate = 0;
        this.step = Infinity;
      } else {
        this.windows = windows;
        this.cycleCount = total;
        if (system.loop) {
          const maxEnd = Math.max(...windows.map((w) => w.start + (w.count - 1) * w.step));
          this.period = cycleTicks > maxEnd ? cycleTicks : maxEnd + this.life;
        } else {
          this.totalCount = total;
        }
      }
    }
    // A genuinely continuous (non-windowed) stream never gets a finite
    // totalCount from the system cycle: loop detection ($infinite) is a
    // fragile symbol match, so a continuous stream that is ever
    // misclassified as non-looping must keep streaming rather than silently
    // truncate to a single cycle. Only windowed one-shots (handled above)
    // bound totalCount.

    // Emission is exactly what the data authors: `rate` particles per second
    // for `life` ticks, so the steady population is rate * life / tickRate
    // and nothing else. A sparse stream used to be densified up to a floor of
    // eight, with alpha scaled down to hide the extra bodies. That was a
    // workaround for a lone particle visibly pulsing through fade-in, full,
    // fade-out and death, and the pulse was really the colour envelope being
    // read as a ramp across the whole lifetime rather than the three windows
    // the game uses. With the envelope right, one particle holds steady on
    // its own, and the boost only survived as a lie about the count: three
    // per second showed as eight alive, spawning a third faster than the
    // game.
    this.k = 1;
    this.capacity = 4;
    this.setStride(1);
  }

  /** Steady-state alive estimate before stride thinning. Derived from
   *  life/step (not rate directly) so it tracks the density boost above:
   *  for an unboosted schedule step === tickRate/rate and this is identical
   *  to the native rate*life/tickRate estimate. */
  expectedAlive(): number {
    if (!(this.rate > 0)) return 0;
    return this.life / this.step;
  }

  /** Apply a deterministic stride: only spawn indices n % k == 0 are kept,
   *  so thinning never breaks determinism or frozen-clock counts. */
  setStride(k: number): void {
    const next = Math.max(1, Math.floor(k) || 1);
    const expected = this.expectedAlive() / next;
    const capacity = Math.round(clamp(Math.ceil(expected * 1.25), 4, PER_EMITTER_CAP));
    if (next === this.k && capacity === this.capacity && this.birth) return;
    this.k = next;
    this.capacity = capacity;
    this.birth = new Float64Array(capacity);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.tail = 0;
    this.head = 0;
    this._dirty = true;
  }

  get alive(): number { return this.head - this.tail; }

  /** Spawn tick of the j-th KEPT spawn (n = j * k). Infinity past the end of
   *  a one-shot schedule. */
  spawnTick(j: number): number {
    if (!(this.rate > 0) || j < 0) return Infinity;
    const n = j * this.k;
    if (n >= this.totalCount) return Infinity;
    if (!this.windows) return n * this.step;
    const c = this.cycleCount;
    const cycle = Math.floor(n / c);
    if (cycle > 0 && this.period == null) return Infinity;
    let r = n - cycle * c;
    for (const w of this.windows) {
      if (r < w.count) return (this.period ? cycle * this.period : 0) + w.start + r * w.step;
      r -= w.count;
    }
    return Infinity; // unreachable: r < cycleCount by construction
  }

  // Alive kept-index range at T: spawn in (T - life, T]. Continuous streams
  // are closed-form; windowed schedules binary-search the monotone spawnTick.
  private _aliveRange(T: number): [number, number] {
    if (!(this.rate > 0)) return [0, 0];
    if (!this.windows) {
      const stepK = this.step * this.k;
      let lo = Math.max(0, Math.floor((T - this.life) / stepK) + 1);
      let hi = Math.floor(T / stepK);
      if (this.totalCount !== Infinity) {
        const jMax = Math.floor((this.totalCount - 1) / this.k);
        hi = Math.min(hi, jMax);
      }
      if (hi < lo) hi = lo - 1;
      return [lo, hi + 1];
    }
    const perCycleKept = Math.max(1, Math.ceil(this.cycleCount / this.k));
    const cycles = this.period ? Math.floor(Math.max(0, T) / this.period) + 2 : 1;
    const searchHi = cycles * perCycleKept + 1;
    // last j with spawnTick(j) <= T
    let lo = 0; let hi = searchHi;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.spawnTick(mid) <= T) lo = mid + 1; else hi = mid;
    }
    const jHi = lo - 1;
    // first j with spawnTick(j) > T - life
    let lo2 = 0; let hi2 = jHi + 1;
    const cutoff = T - this.life;
    while (lo2 < hi2) {
      const mid = (lo2 + hi2) >> 1;
      if (this.spawnTick(mid) <= cutoff) lo2 = mid + 1; else hi2 = mid;
    }
    return [lo2, jHi + 1];
  }

  // Sample the j-th kept spawn's constants into its ring slot. Fixed draw
  // count and order (three draws) keeps the counter-based stream stable
  // across shape kinds.
  private _spawn(j: number): void {
    const slot = j % this.capacity;
    const rng = mulberry32(hash32(this.seed, (j * this.k) | 0));
    const r0 = rng();
    const r1 = rng();
    const r2 = rng();
    const tick = this.spawnTick(j);
    const s = this.shape;
    let x = s.center[0]; let y = s.center[1]; let z = s.center[2];
    let dx = s.w[0]; let dy = s.w[1]; let dz = s.w[2];
    if (s.kind === 'segment' && s.segment) {
      // Uniform along the authored line, so a shoreline wave breaks across the
      // whole width the game gives it rather than jetting from one end.
      const { from, to } = s.segment;
      x = from[0] + (to[0] - from[0]) * r0;
      y = from[1] + (to[1] - from[1]) * r0;
      z = from[2] + (to[2] - from[2]) * r0;
      const yaw = r1 * s.yaw;
      const pitch = r2 * s.pitch;
      const cp = Math.cos(pitch); const sp = Math.sin(pitch);
      const cy = Math.cos(yaw); const sy = Math.sin(yaw);
      dx = cp * s.w[0] + sp * (cy * s.u[0] + sy * s.v[0]);
      dy = cp * s.w[1] + sp * (cy * s.u[1] + sy * s.v[1]);
      dz = cp * s.w[2] + sp * (cy * s.u[2] + sy * s.v[2]);
    } else if (s.kind === 'ring') {
      const theta = r0 * s.sweep;
      const ct = Math.cos(theta); const st = Math.sin(theta);
      x += s.radius * (ct * s.u[0] + st * s.v[0]);
      y += s.radius * (ct * s.u[1] + st * s.v[1]);
      z += s.radius * (ct * s.u[2] + st * s.v[2]);
    } else if (s.kind === 'spiral' && s.spiral) {
      // spiral state is a pure function of the SPAWN time, folded to the
      // cycle so looping systems never walk off to infinity
      const sp = s.spiral;
      const st0 = this.period ? tick % this.period : tick;
      const angle = sp.a0 + sp.aRate * st0;
      const radius = sp.r0 + sp.rRate * st0;
      const ca = Math.cos(angle); const sa = Math.sin(angle);
      x += radius * (ca * s.u[0] + sa * s.v[0]);
      y += radius * (ca * s.u[1] + sa * s.v[1]);
      z += radius * (ca * s.u[2] + sa * s.v[2]);
    } else {
      // point / conservative fallback: cone sample about the axis
      const yaw = r0 * s.yaw;
      const pitch = r1 * s.pitch;
      const cp = Math.cos(pitch); const sp = Math.sin(pitch);
      const cy = Math.cos(yaw); const sy = Math.sin(yaw);
      dx = cp * s.w[0] + sp * (cy * s.u[0] + sy * s.v[0]);
      dy = cp * s.w[1] + sp * (cy * s.u[1] + sy * s.v[1]);
      dz = cp * s.w[2] + sp * (cy * s.u[2] + sy * s.v[2]);
    }
    this.birth[slot] = tick;
    this.px[slot] = x;
    this.py[slot] = y;
    this.pz[slot] = z;
    this.vx[slot] = dx * this.speed;
    this.vy[slot] = dy * this.speed;
    this.vz[slot] = dz * this.speed;
  }

  /** Bring the ring up to clock T: incremental for small forward steps,
   *  full O(alive) rebuild on any discontinuity. */
  ensure(T: number): void {
    if (!(this.rate > 0)) { this._lastT = T; return; }
    const dt = T - this._lastT;
    if (this._dirty || !(dt >= 0 && dt <= MAX_CATCHUP_TICKS)) {
      const [lo, hi] = this._aliveRange(T);
      const from = Math.max(lo, hi - this.capacity);
      this.tail = from;
      this.head = hi;
      for (let j = from; j < hi; j++) this._spawn(j);
      this._dirty = false;
    } else if (dt > 0) {
      while (this.spawnTick(this.head) <= T) {
        this._spawn(this.head);
        this.head++;
        if (this.head - this.tail > this.capacity) this.tail = this.head - this.capacity;
      }
      while (this.tail < this.head && this.spawnTick(this.tail) + this.life <= T) this.tail++;
    }
    this._lastT = T;
  }

  /**
   * Closed-form evaluation of every alive particle at T:
   *   p = p0 + v0 age + 0.5 accel age^2, roll = spin age, scale lerped by
   *   age/life, colour and alpha shaped by the three-phase envelope below.
   */
  evaluate(T: number, emit: (x: number, y: number, z: number, scale: number,
    r: number, g: number, b: number, a: number, rot: number) => void): void {
    const cap = this.capacity;
    const life = this.life;
    const [ax, ay, az] = this.accel;
    const [r0c, g0c, b0c, a0c] = this.color0;
    const [r1c, g1c, b1c, a1c] = this.color1;
    // A lifetime is three consecutive windows: fade in, hold, fade out. The
    // colour pair crosses over during the HOLD window alone, so a particle
    // reaches its second colour before it starts fading rather than over the
    // whole span; the two fades each act on one end's own alpha.
    const hold = Math.max(0, life - this.fadeIn - this.fadeOut);
    for (let j = this.tail; j < this.head; j++) {
      const slot = j % cap;
      const age = T - this.birth[slot];
      if (!(age >= 0) || age >= life) continue;
      const u = age / life;
      const half = 0.5 * age * age;
      const x = this.px[slot] + this.vx[slot] * age + ax * half;
      const y = this.py[slot] + this.vy[slot] * age + ay * half;
      const z = this.pz[slot] + this.vz[slot] * age + az * half;
      const k0 = ramp(age, this.fadeIn);
      const k1 = ramp(age - this.fadeIn, hold);
      const k2 = ramp(age - this.fadeIn - hold, this.fadeOut);
      // Composed in PREMULTIPLIED space (a colour fading out must not drag
      // the surviving colour's hue with it), then converted back: the render
      // attribute and both blend modes want straight alpha.
      const pa0 = a0c * k0;
      const pa1 = a1c * (1 - k2);
      const alpha = pa0 + (pa1 - pa0) * k1;
      let r = r1c; let g = g1c; let b = b1c;
      if (alpha > 1e-6) {
        r = (r0c * pa0 + (r1c * pa1 - r0c * pa0) * k1) / alpha;
        g = (g0c * pa0 + (g1c * pa1 - g0c * pa0) * k1) / alpha;
        b = (b0c * pa0 + (b1c * pa1 - b0c * pa0) * k1) / alpha;
      }
      emit(x, y, z,
        clamp(this.scale0 + (this.scale1 - this.scale0) * u, 0.01, 100),
        r, g, b, alpha,
        this.spin * age);
    }
  }
}

/**
 * Deterministic stride planning for a set of emitters under a per-view alive
 * budget: per-emitter caps first, then proportional shares when the whole
 * view would overflow. Keeps spawn indices n % k == 0, never random drops,
 * so thinning survives seeks and frozen-clock comparisons.
 */
export function planStrides(emitters: EmitterSim[], budget: number): void {
  let total = 0;
  for (const em of emitters) total += Math.min(em.expectedAlive(), PER_EMITTER_CAP);
  const over = total > budget;
  for (const em of emitters) {
    const expected = em.expectedAlive();
    if (!(expected > 0)) continue;
    let share = PER_EMITTER_CAP;
    if (over) {
      const capped = Math.min(expected, PER_EMITTER_CAP);
      share = Math.min(PER_EMITTER_CAP, Math.max(1, Math.floor((capped * budget) / total)));
    }
    em.setStride(Math.max(1, Math.ceil(expected / share)));
  }
}

/**
 * The master effect clock, in ticks. Advanced only by accumulated frame dt
 * (never wall clock: a hidden tab freezes it), with absolute seeks and a
 * freeze switch serving tests, scrubbing and screenshots alike.
 */
export class EffectsClock {
  tickRate: number;
  t = 0;
  running = true;
  speed = 1;

  constructor(tickRate: number) {
    this.tickRate = Number.isFinite(tickRate) && tickRate > 0 ? tickRate : 1;
  }

  advance(dtMs: number): void {
    if (!this.running || !(dtMs > 0)) return;
    this.t += (dtMs * this.tickRate * this.speed) / 1000;
  }

  setClock(ticks: number): void {
    this.t = Number.isFinite(ticks) ? ticks : 0;
  }

  setRunning(on: boolean): void {
    this.running = !!on;
  }
}

export default EmitterSim;
