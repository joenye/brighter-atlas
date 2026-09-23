import {EffectRandom} from './effects-random.js';
import type {EffectScales} from '../../extract/world/effect-scales.js';
import {effectHslToRgb, type EffectColourSample, type EffectFieldValues, type EffectSample} from '../../extract/world/effect-fields.js';
import {waterHeight, type EffectWave} from '../../extract/world/effect-waves.js';
import type {EffectWindow} from '../../extract/world/effect-windows.js';
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
import type { EffectBirthFrames } from './effects-frames.js';

export type EffectBirthFrameSampler = (tick: number) => EffectBirthFrames;

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
// Wave bursts rebuild their armed state from the last decisive height sample.
// Samples further back than this cannot change the state (the waves are
// bounded sines); a field that never dips below zero simply never fires.
const WAVE_LOOKBACK_SAMPLES = 4096;

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
  kind: 'point' | 'ring' | 'spiral' | 'segment' | 'radial' | 'other';
  center: Vec3;
  radial: EffectConfig['radial'] | null;
  cone: EffectConfig['cone'] | null;
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

// Sample polar cosine, giving uniform solid angle within the cone. The
// quaternion preserves the azimuth origin when rotating the cone axis.
export function sampleConeDirection(axis: readonly number[], yaw: readonly number[], pitch: readonly number[], azimuth: number, polar: number): Vec3 {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  const sign = axis[2] < 0 ? -1 : 1;
  const nx = length ? axis[0] * sign / length : 0;
  const ny = length ? axis[1] * sign / length : 0;
  const nz = length ? axis[2] * sign / length : 0;
  const z0 = Math.cos(pitch[0]) * sign;
  const z = z0 + (Math.cos(pitch[1]) * sign - z0) * polar;
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  const angle = yaw[0] + (yaw[1] - yaw[0]) * azimuth;
  const x = radius * Math.cos(angle), y = radius * Math.sin(angle);
  const qlen = Math.hypot(nx, ny, 1 + nz);
  const a = -ny / qlen, b = nx / qlen, d = (1 + nz) / qlen;
  return [(1 - 2 * b * b) * x + 2 * a * b * y + 2 * b * d * z,
    2 * a * b * x + (1 - 2 * a * a) * y - 2 * a * d * z,
    -2 * b * d * x + 2 * a * d * y + (1 - 2 * (a * a + b * b)) * z];
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
  const center = vec3Of(config?.radial?.center ?? config?.center, [0, 0, 0]);
  const axis = vec3Of(config?.spiral?.axis ?? config?.axis, fallbackAxis);
  const frame = axisFrame(axis);
  const spec: ShapeSpec = {
    kind: kind === 'point' || kind === 'ring' || kind === 'spiral' || kind === 'segment' || kind === 'radial'
      ? kind : 'other',
    center,
    radial: config?.radial ?? null,
    cone: config?.cone ?? null,
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
  private _baseSeed = 0;
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
  speedSlope: number;     // change in speed per tick
  spin: number;           // radians per tick
  accel: Vec3;            // native units per tick^2
  accelSlope: Vec3;       // change in acceleration per tick
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
  sx!: Float32Array; sy!: Float32Array; sz!: Float32Array;
  tail = 0;
  head = 0;
  private _scales: EffectScales | null = null;
  private _sizes0!: Float32Array;
  private _sizes1!: Float32Array;
  // Bound spawn-time properties. Sampled values are drawn per particle, in
  // the game's evaluation order, from the same per-particle stream as
  // sizes; literal values are already folded into the constants above.
  private _fields: EffectFieldValues | null = null;
  private _random = false;
  private _perParticle = false;
  private _sampledColour = false;
  private _accelBasis: readonly number[] | null = null;
  /** Number of sprite outcomes; each particle stores its uniform choice. */
  spriteChoices = 0;
  choice!: Uint8Array;
  private _ax!: Float32Array; private _ay!: Float32Array; private _az!: Float32Array;
  private _jx!: Float32Array; private _jy!: Float32Array; private _jz!: Float32Array;
  private _spin!: Float32Array;
  private _rot0!: Float32Array;
  private _colours!: Float32Array;
  private _eventWindow: EffectWindow | null = null;
  private _wave: EffectWave | null = null;
  private _wavePoint: [number, number] = [0, 0];
  private _waveArmed = false;
  private _waveNext = 0;
  private _windowNext = 0;
  private _lastT = NaN;
  private _dirty = true;
  private _birthPosition: readonly number[] | null = null;
  private _facingAxis: Vec3 | null = null;
  private _facingMode = 0;
  nx!: Float32Array; ny!: Float32Array; nz!: Float32Array;
  private _birthDirection: readonly number[] | null = null;
  private _birthFrameSampler: EffectBirthFrameSampler | null = null;

  /** Give one placed copy of an effect its own random stream. In the game,
   *  separate copies of the same effect never repeat each other's particles. */
  setInstanceSeed(instance: number): void {
    this.seed = hash32(this._baseSeed, instance | 0);
    this._dirty = true;
  }

  setBirthFrames(position: readonly number[] | null, direction: readonly number[] | null): void {
    this._birthFrameSampler = null;
    this._birthPosition = position ? Array.from(position) : null;
    this._birthDirection = direction ? Array.from(direction) : null;
    this._dirty = true;
  }

  // Sample the attachment at each birth, never at the current display time.
  // Samplers must be pure functions of ticks so seeks can rebuild the ring.
  setBirthFrameSampler(sample: EffectBirthFrameSampler | null): void {
    this._birthFrameSampler = sample;
    this._dirty = true;
  }

  spawnCenter(tick = 0): Vec3 {
    const [x, y, z] = this.shape.center;
    const m = this._birthFrameSampler ? this._birthFrameSampler(tick).position : this._birthPosition;
    return m ? [m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14]] : [x, y, z];
  }

  constructor(system: EffectSystem, emitterIndex: number, emitter: EffectEmitter,
    configs: Record<string, EffectConfig>, tickRate: number, colorOverride?: number[]) {
    this.tickRate = tickRate;
    const facing = emitter.facing;
    this._facingMode = facing?.mode === 'velocity_single' ? 1
      : facing?.mode === 'velocity_screen' ? 4 : facing?.mode === 'direction_screen' ? 5 : 0;
    if ((facing?.mode === 'direction_single' || facing?.mode === 'direction_screen') && facing.axis?.length === 3
      && facing.axis.every(Number.isFinite)) this._facingAxis = [...facing.axis];
    this.seed = this._baseSeed = hash32(system.slot | 0, emitterIndex | 0);

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
    if (Number.isFinite(emitter.color_override_alpha) && Array.isArray(colorOverride)
      && colorOverride.length === 4 && colorOverride.every(Number.isFinite)) {
      this.color0 = [colorOverride[0], colorOverride[1], colorOverride[2],
        colorOverride[3] * emitter.color_override_alpha!];
      this.color1 = [...this.color0];
    }
    // Endpoint colours are stored as normalized bytes. Quantize once before
    // the envelope, retaining floating-point precision during fades.
    const channel = (v: number) => Math.trunc(Math.fround(Math.fround(clamp(v, 0, 1)) * 255)) / 255;
    this.color0 = this.color0.map(channel) as [number, number, number, number];
    this.color1 = this.color1.map(channel) as [number, number, number, number];
    this._scales = emitter.scales ?? null;
    this.scale0 = finite(emitter.scale0?.value, 1);
    this.scale1 = finite(emitter.scale1?.value, this.scale0);
    this.speed = finite(emitter.speed?.value, 0) / tickRate;
    this.speedSlope = (finite(emitter.speed1?.value, this.speed * tickRate) / tickRate - this.speed) / this.life;
    this.spin = finite(emitter.angular_speed?.value, 0) * DEG / tickRate;
    const accel = vec3Of(emitter.acceleration?.v, [0, 0, 0]);
    const t2 = tickRate * tickRate;
    this.accel = [accel[0] / t2, accel[1] / t2, accel[2] / t2];
    const accel1 = vec3Of(emitter.acceleration1?.v, accel);
    this.accelSlope = [(accel1[0] - accel[0]) / t2 / this.life,
      (accel1[1] - accel[1]) / t2 / this.life, (accel1[2] - accel[2]) / t2 / this.life];
    const fields = emitter.fields ?? null;
    const sampled = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number';
    const anySampled = (v: unknown): boolean => sampled(v) || (Array.isArray(v) && v.some(sampled));
    const colourSampled = (c: EffectColourSample | 'start' | undefined) => !!c && c !== 'start' && 'ahsl' in c;
    this._sampledColour = !Number.isFinite(emitter.color_override_alpha) && !!fields?.color
      && (colourSampled(fields.color.start) || colourSampled(fields.color.end));
    this._perParticle = !!fields && (anySampled(fields.speed?.start.value) || (fields.speed?.end !== 'start' && anySampled(fields.speed?.end?.value))
      || anySampled(fields.angularSpeed?.value) || anySampled(fields.acceleration?.start)
      || (fields.acceleration?.end !== 'start' && anySampled(fields.acceleration?.end))
      || (fields.rotation !== null && fields.rotation !== undefined && fields.rotation !== 0) || this._sampledColour);
    this._fields = this._perParticle ? fields : null;
    this.spriteChoices = emitter.sprite_choices?.sprites?.length ?? 0;

    const fallbackAxis = normalize(vec3Of(emitter.direction?.v, [0, 0, 1]), [0, 0, 1]);
    const shapeCfg = emitter.shape != null ? configs[String(emitter.shape)] || null : null;
    this.shape = resolveShape(shapeCfg, fallbackAxis, tickRate);
    this._random = !!this._scales || this._perParticle || this.spriteChoices > 1
      || (!!this.shape.radial && typeof this.shape.radial.radius !== 'number');

    // Burst schedule. A missing/degenerate burst leaves the emitter inert
    // (alive stays zero); siblings are unaffected.
    const burst = emitter.burst != null ? configs[String(emitter.burst)] || null : null;
    this._eventWindow = burst?.emission_window ?? null;
    this._wave = burst?.kind === 'burst_wave' && burst.wave ? burst.wave : null;
    if (this._wave) this.setWaveFrame(null);
    // A wave burst's steady density: its count once per crest of the faster wave.
    const waveRate = this._wave ? this._wave.count * Math.max(...this._wave.water.rate.map(Math.abs)) * tickRate / TWO_PI : 0;
    const rate = this._wave ? waveRate : Math.max(0, finite(this._eventWindow?.rate ?? burst?.per_second, 0));
    this.rate = rate;
    this.step = rate > 0 ? tickRate / rate : Infinity;
    this.windows = null;
    this.cycleCount = 0;
    this.period = null;
    this.totalCount = Infinity;
    const cycleTicks = Math.max(0, finite(system.cycle_ticks, 0));
    if (!this._eventWindow && rate > 0 && burst?.kind === 'burst_windowed' && Array.isArray(burst.windows)) {
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
    let capacity = Math.round(clamp(Math.ceil(expected * 1.25), 4, PER_EMITTER_CAP));
    // A crest releases a whole burst at once; hold every burst one life can span.
    if (this._wave) capacity = Math.round(clamp(Math.max(capacity, Math.ceil(this._wave.count / next)
      * (Math.ceil(this.life * Math.max(...this._wave.water.rate.map(Math.abs)) / Math.PI) + 2)), 4, PER_EMITTER_CAP));
    if (next === this.k && capacity === this.capacity && this.birth) return;
    this.k = next;
    this.capacity = capacity;
    this.birth = new Float64Array(capacity);
    this._sizes0 = new Float32Array(capacity);
    this._sizes1 = new Float32Array(capacity);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.sx = new Float32Array(capacity);
    this.sy = new Float32Array(capacity);
    this.sz = new Float32Array(capacity);
    this.nx = new Float32Array(capacity);
    this.ny = new Float32Array(capacity);
    this.nz = new Float32Array(capacity);
    this.choice = new Uint8Array(this.spriteChoices > 1 ? capacity : 0);
    const motion = this._perParticle ? capacity : 0;
    this._ax = new Float32Array(motion); this._ay = new Float32Array(motion); this._az = new Float32Array(motion);
    this._jx = new Float32Array(motion); this._jy = new Float32Array(motion); this._jz = new Float32Array(motion);
    this._spin = new Float32Array(motion);
    this._rot0 = new Float32Array(motion);
    this._colours = new Float32Array(this._sampledColour ? capacity * 8 : 0);
    this.tail = 0;
    this.head = 0;
    this._dirty = true;
  }

  /** Express acceleration (both endpoints) in another frame: a 4x4
   *  column-major matrix whose linear part applies. Sampled values are
   *  transformed per particle at birth. */
  setAccelerationBasis(m: readonly number[] | null): void {
    this._accelBasis = m ? Array.from(m) : null;
    if (m) {
      const apply = (v: Vec3): Vec3 => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
      this.accel = apply(this.accel);
      this.accelSlope = apply(this.accelSlope);
    }
    this._dirty = true;
  }

  get alive(): number { return this.head - this.tail; }

  /** Spawn tick of the j-th KEPT spawn (n = j * k). Infinity past the end of
   *  a one-shot schedule. */
  spawnTick(j: number): number {
    if (!(this.rate > 0) || j < 0) return Infinity;
    if (this._eventWindow || this._wave) return j >= this.tail && j < this.head ? this.birth[j % this.capacity] : Infinity;
    const n = j * this.k;
    if (n >= this.totalCount) return Infinity;
    // Birth timestamps use integral ticks. Eligibility still follows the
    // emission counter: several particles may share a timestamp without
    // all becoming eligible at that rounded-down time.
    if (!this.windows) return Math.trunc(n * this.tickRate / this.rate);
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

  private _continuousEnd(T: number): number {
    if (T < 0) return 0;
    const counter = Math.min(0x7fffffff,
      Math.trunc(Math.fround(Math.fround(T * this.rate) / Math.fround(this.tickRate))));
    return Math.max(0, Math.floor(Math.min(counter, this.totalCount - 1) / this.k) + 1);
  }

  // Alive kept-index range at T: spawn in (T - life, T]. Continuous streams
  // are closed-form; windowed schedules binary-search the monotone spawnTick.
  private _aliveRange(T: number): [number, number] {
    if (!(this.rate > 0)) return [0, 0];
    if (!this.windows) {
      const stepK = this.step * this.k;
      let lo = Math.max(0, Math.floor((T - this.life) / stepK) + 1);
      const end = this._continuousEnd(T);
      // Rounded birth times can expire before the nominal counter interval.
      while (lo < end && this.spawnTick(lo) + this.life <= T) lo++;
      lo = Math.min(lo, end);
      return [lo, end];
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
  private _spawn(j: number, counter = j * this.k, tick = this.spawnTick(j)): void {
    const slot = j % this.capacity;
    const rng = mulberry32(hash32(this.seed, counter | 0));
    const r0 = rng();
    const r1 = rng();
    const r2 = rng();
    // Stable preview seeds keep seeks and thinning reproducible. Sampled
    // values are drawn in the game's evaluation order (origin radius, speed,
    // acceleration, size, rotation, spin, sprite, colour); the session's
    // shared stream state is not implied by this per-particle preview seed.
    const random = this._random ? new EffectRandom(BigInt(hash32(this.seed, counter | 0))) : null;
    const draw = (v: EffectSample) => typeof v === 'number' ? v : random!.range(v[0], v[1]);
    const radius = this.shape.radial ? draw(this.shape.radial.radius) : 0;
    let speed = this.speed; let speedSlope = this.speedSlope;
    const f = this._fields;
    if (f) {
      if (f.speed) {
        const s0 = draw(f.speed.start.value) / f.speed.start.ticks;
        const s1 = f.speed.end === 'start' ? s0 : draw(f.speed.end.value) / f.speed.end.ticks;
        speed = s0; speedSlope = (s1 - s0) / this.life;
      }
      let a0 = this.accel; let a1 = this.accelSlope;
      if (f.acceleration) {
        const t2 = this.tickRate * this.tickRate;
        const v0 = f.acceleration.start.map(draw);
        const v1 = f.acceleration.end === 'start' ? v0 : f.acceleration.end.map(draw);
        a0 = [v0[0] / t2, v0[1] / t2, v0[2] / t2];
        a1 = [(v1[0] - v0[0]) / t2 / this.life, (v1[1] - v0[1]) / t2 / this.life, (v1[2] - v0[2]) / t2 / this.life];
        const m = this._accelBasis;
        if (m) {
          a0 = [m[0] * a0[0] + m[4] * a0[1] + m[8] * a0[2], m[1] * a0[0] + m[5] * a0[1] + m[9] * a0[2], m[2] * a0[0] + m[6] * a0[1] + m[10] * a0[2]];
          a1 = [m[0] * a1[0] + m[4] * a1[1] + m[8] * a1[2], m[1] * a1[0] + m[5] * a1[1] + m[9] * a1[2], m[2] * a1[0] + m[6] * a1[1] + m[10] * a1[2]];
        }
      }
      this._ax[slot] = a0[0]; this._ay[slot] = a0[1]; this._az[slot] = a0[2];
      this._jx[slot] = a1[0]; this._jy[slot] = a1[1]; this._jz[slot] = a1[2];
    }
    if (this._scales) {
      this._sizes0[slot] = draw(this._scales.start);
      this._sizes1[slot] = this._scales.end === 'start' ? this._sizes0[slot] : draw(this._scales.end);
    }
    if (f) {
      // The game turns a particle's corners counter-clockwise by its initial
      // rotation (degrees), while roll turns them the other way.
      this._rot0[slot] = f.rotation !== null && f.rotation !== undefined ? draw(f.rotation) * DEG : 0;
      this._spin[slot] = f.angularSpeed ? draw(f.angularSpeed.value) * DEG / f.angularSpeed.ticks : this.spin;
    }
    if (this.spriteChoices > 1) this.choice[slot] = random!.integer(this.spriteChoices);
    if (this._sampledColour) {
      const channel = (v: number) => Math.trunc(Math.fround(Math.fround(clamp(v, 0, 1)) * 255)) / 255;
      const rgba = (c: EffectColourSample): number[] => {
        if ('rgba' in c) return c.rgba.map(channel);
        const [a, h, sat, l] = c.ahsl.map(draw);
        return [...effectHslToRgb(h, sat, l), a].map(channel);
      };
      const colour = f!.color!;
      const c0 = rgba(colour.start);
      this._colours.set(c0, slot * 8);
      this._colours.set(colour.end === 'start' ? c0 : rgba(colour.end), slot * 8 + 4);
    }
    const s = this.shape;
    let x = s.center[0]; let y = s.center[1]; let z = s.center[2];
    let dx = s.w[0]; let dy = s.w[1]; let dz = s.w[2];
    if (s.kind === 'radial' && s.radial) {
      const radial = s.radial;
      const yaw = (radial.yaw[0] + (radial.yaw[1] - radial.yaw[0]) * r0) * DEG;
      const pitch = (radial.pitch[0] + (radial.pitch[1] - radial.pitch[0]) * r1) * DEG;
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch);
      x += radius * radial.axisScale[0] * cy;
      y += radius * radial.axisScale[1] * sy;
      dx = cy * cp; dy = sy * cp; dz = Math.sin(pitch);
    } else if (s.kind === 'segment' && s.segment) {
      // Uniform along the authored line, so a shoreline wave breaks across the
      // whole width the game gives it rather than jetting from one end.
      const { from, to } = s.segment;
      x = from[0] + (to[0] - from[0]) * r0;
      y = from[1] + (to[1] - from[1]) * r0;
      z = from[2] + (to[2] - from[2]) * r0;
      if (s.cone) {
        // A bound segment aims through its authored cone (azimuth, then polar).
        [dx, dy, dz] = sampleConeDirection(s.w, [s.cone.yaw[0] * DEG, s.cone.yaw[1] * DEG],
          [s.cone.pitch[0] * DEG, s.cone.pitch[1] * DEG], r1, r2);
      } else {
      const yaw = r1 * s.yaw;
      const pitch = r2 * s.pitch;
      const cp = Math.cos(pitch); const sp = Math.sin(pitch);
      const cy = Math.cos(yaw); const sy = Math.sin(yaw);
      dx = cp * s.w[0] + sp * (cy * s.u[0] + sy * s.v[0]);
      dy = cp * s.w[1] + sp * (cy * s.u[1] + sy * s.v[1]);
      dz = cp * s.w[2] + sp * (cy * s.u[2] + sy * s.v[2]);
      }
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
      const yaw: [number, number] = s.cone ? [s.cone.yaw[0] * DEG, s.cone.yaw[1] * DEG] : [0, s.yaw];
      const pitch: [number, number] = s.cone ? [s.cone.pitch[0] * DEG, s.cone.pitch[1] * DEG] : [0, s.pitch];
      [dx, dy, dz] = sampleConeDirection(s.w, yaw, pitch, r0, r1);
    }
    const frames = this._birthFrameSampler?.(tick);
    const p = frames ? frames.position : this._birthPosition;
    const d = frames ? frames.direction : this._birthDirection;
    if (p) {
      const tx = p[0] * x + p[4] * y + p[8] * z + p[12];
      const ty = p[1] * x + p[5] * y + p[9] * z + p[13];
      z = p[2] * x + p[6] * y + p[10] * z + p[14];
      x = tx; y = ty;
    }
    if (d) {
      const tx = d[0] * dx + d[4] * dy + d[8] * dz;
      const ty = d[1] * dx + d[5] * dy + d[9] * dz;
      dz = d[2] * dx + d[6] * dy + d[10] * dz;
      dx = tx; dy = ty;
    }
    // Fixed sprite planes follow the direction frame at birth, independently
    // of the point frame. Keep the raw vector until the common owner transform.
    const n = this._facingAxis;
    this.nx[slot] = n ? (d ? d[0] * n[0] + d[4] * n[1] + d[8] * n[2] : n[0]) : 0;
    this.ny[slot] = n ? (d ? d[1] * n[0] + d[5] * n[1] + d[9] * n[2] : n[1]) : 0;
    this.nz[slot] = n ? (d ? d[2] * n[0] + d[6] * n[1] + d[10] * n[2] : n[2]) : 0;
    this.birth[slot] = tick;
    this.px[slot] = x;
    this.py[slot] = y;
    this.pz[slot] = z;
    this.vx[slot] = dx * speed;
    this.vy[slot] = dy * speed;
    this.vz[slot] = dz * speed;
    this.sx[slot] = dx * speedSlope;
    this.sy[slot] = dy * speedSlope;
    this.sz[slot] = dz * speedSlope;
  }

  /** Owner-to-world matrix (column-major) placing a wave burst's point in the
   *  water's coordinate frame. Null leaves the point in the owner frame. */
  setWaveFrame(m: readonly number[] | null): void {
    const w = this._wave;
    if (!w) return;
    const [x, y] = w.point;
    this._wavePoint = !m ? [x, y] : w.translation ? [x + m[12], y + m[13]]
      : [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]];
    this._dirty = true;
  }

  private _waveRatio(ticks: number): number {
    const w = this._wave!;
    return Math.fround(Math.fround(waterHeight(w.water, this._wavePoint[0], this._wavePoint[1], ticks)) / Math.fround(w.threshold));
  }

  // Crest-timed bursts: the height is sampled on a fixed tick grid; a sample
  // at or above the threshold fires the burst once, and only a later sample
  // below zero re-arms it. The ring stores birth ticks like event windows.
  private _ensureWave(T: number): void {
    const w = this._wave!;
    const step = w.step;
    const last = Math.floor(T / step);
    const dt = T - this._lastT;
    if (this._dirty || !(dt >= 0 && dt <= MAX_CATCHUP_TICKS)) {
      this.tail = this.head = 0;
      const first = Math.floor((T - this.life) / step) + 1;
      let armed = false;
      for (let n = first - 1; n > first - 1 - WAVE_LOOKBACK_SAMPLES; n--) {
        const r = this._waveRatio(n * step);
        if (r < 0) { armed = true; break; }
        if (r >= 1) break;
      }
      this._waveArmed = armed;
      this._waveNext = first;
    }
    for (let n = this._waveNext; n <= last; n++) {
      const r = this._waveRatio(n * step);
      if (r >= 1 && this._waveArmed) {
        this._waveArmed = false;
        for (let k = 0; k < w.count; k++) {
          const counter = n * w.count + k;
          if (counter % this.k) continue;
          this._spawn(this.head++, counter, n * step);
          if (this.head - this.tail > this.capacity) this.tail = this.head - this.capacity;
        }
      } else if (r < 0) this._waveArmed = true;
    }
    this._waveNext = Math.max(this._waveNext, last + 1);
    while (this.tail < this.head && this.birth[this.tail % this.capacity] + this.life <= T) this.tail++;
    this._dirty = false;
    this._lastT = T;
  }

  private _ensureWindow(T: number): void {
    const schedule = this._eventWindow!;
    const dt = T - this._lastT;
    const end = this._continuousEnd(T);
    if (this._dirty || !(dt >= 0 && dt <= MAX_CATCHUP_TICKS)) {
      this.tail = this.head = 0;
      this._windowNext = Math.max(0, Math.floor((T - this.life) / (this.step * this.k)) + 1);
    }
    for (let j = this._windowNext; j < end; j++) {
      const counter = j * this.k;
      const born = Math.trunc(counter * this.tickRate / this.rate);
      if (born + this.life <= T) continue;
      const phase = schedule.period === null ? born : ((born % schedule.period) + schedule.period) % schedule.period;
      if (!schedule.windows.some(([start, finish]) => start <= phase && phase < finish)) continue;
      this._spawn(this.head++, counter, born);
      if (this.head - this.tail > this.capacity) this.tail = this.head - this.capacity;
    }
    this._windowNext = end;
    while (this.tail < this.head && this.birth[this.tail % this.capacity] + this.life <= T) this.tail++;
    this._dirty = false;
    this._lastT = T;
  }

  /** Bring the ring up to clock T: incremental for small forward steps,
   *  full O(alive) rebuild on any discontinuity. */
  ensure(T: number): void {
    if (!(this.rate > 0)) { this._lastT = T; return; }
    if (this._wave) { this._ensureWave(T); return; }
    if (this._eventWindow) { this._ensureWindow(T); return; }
    const dt = T - this._lastT;
    if (this._dirty || !(dt >= 0 && dt <= MAX_CATCHUP_TICKS)) {
      const [lo, hi] = this._aliveRange(T);
      const from = Math.max(lo, hi - this.capacity);
      this.tail = from;
      this.head = hi;
      for (let j = from; j < hi; j++) this._spawn(j);
      this._dirty = false;
    } else if (dt > 0) {
      while (this.windows ? this.spawnTick(this.head) <= T : this.head < this._continuousEnd(T)) {
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
   * Motion uses the two authored speed and acceleration endpoints. The
   * acceleration-slope term is one quarter of age cubed, as defined by the
   * particle program, rather than the one-sixth term of jerk integration.
   * Roll = spin age; scale follows age/life and colour its three windows.
   */
  evaluate(T: number, emit: (x: number, y: number, z: number, scale: number,
    r: number, g: number, b: number, a: number, rot: number, nx: number, ny: number, nz: number, facingMode: number) => void,
    choice = -1): void {
    const cap = this.capacity;
    const life = this.life;
    const per = this._perParticle;
    const colours = this._sampledColour ? this._colours : null;
    // A renderer draws each sprite outcome from its own batch; an unfiltered
    // evaluation (choice < 0) visits every particle.
    const filter = choice >= 0 && this.spriteChoices > 1;
    let [ax, ay, az] = this.accel;
    let [jx, jy, jz] = this.accelSlope;
    let [r0c, g0c, b0c, a0c] = this.color0;
    let [r1c, g1c, b1c, a1c] = this.color1;
    // A lifetime is three consecutive windows: fade in, hold, fade out. The
    // colour pair crosses over during the HOLD window alone, so a particle
    // reaches its second colour before it starts fading rather than over the
    // whole span; the two fades each act on one end's own alpha.
    const hold = Math.max(0, life - this.fadeIn - this.fadeOut);
    for (let j = this.tail; j < this.head; j++) {
      const slot = j % cap;
      const age = T - this.birth[slot];
      if (!(age >= 0) || age >= life) continue;
      if (filter && this.choice[slot] !== choice) continue;
      if (per) {
        ax = this._ax[slot]; ay = this._ay[slot]; az = this._az[slot];
        jx = this._jx[slot]; jy = this._jy[slot]; jz = this._jz[slot];
      }
      if (colours) {
        const at = slot * 8;
        r0c = colours[at]; g0c = colours[at + 1]; b0c = colours[at + 2]; a0c = colours[at + 3];
        r1c = colours[at + 4]; g1c = colours[at + 5]; b1c = colours[at + 6]; a1c = colours[at + 7];
      }
      const u = age / life;
      const half = 0.5 * age * age;
      const quarter = half * age * 0.5;
      const x = this.px[slot] + this.vx[slot] * age + (ax + this.sx[slot]) * half + jx * quarter;
      const y = this.py[slot] + this.vy[slot] * age + (ay + this.sy[slot]) * half + jy * quarter;
      const z = this.pz[slot] + this.vz[slot] * age + (az + this.sz[slot]) * half + jz * quarter;
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
        this._scales ? this._sizes0[slot] + (this._sizes1[slot] - this._sizes0[slot]) * u
          : this.scale0 + (this.scale1 - this.scale0) * u,
        r, g, b, alpha,
        per ? this._spin[slot] * age - this._rot0[slot] : this.spin * age,
        // Facing velocity follows the sprite program's motion vector. Its
        // changing-acceleration coefficient differs from the derivative of
        // the position polynomial. Supply native units per second.
        (this._facingMode === 1 || this._facingMode === 4) ? this.tickRate * (this.vx[slot] + age * (ax + this.sx[slot] + .5 * age * jx)) : this.nx[slot],
        (this._facingMode === 1 || this._facingMode === 4) ? this.tickRate * (this.vy[slot] + age * (ay + this.sy[slot] + .5 * age * jy)) : this.ny[slot],
        (this._facingMode === 1 || this._facingMode === 4) ? this.tickRate * (this.vz[slot] + age * (az + this.sz[slot] + .5 * age * jz)) : this.nz[slot],
        this._facingMode);
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
