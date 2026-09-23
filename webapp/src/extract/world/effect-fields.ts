// Optional per-build decode data is produced offline purely from analysis of
// the game's own files, never by inspecting or modifying a running game
// process or its memory. It locates each emitter's spawn-time properties;
// every value is read from the user's bundle.
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';

// null marks a property whose value the game computes elsewhere.
export interface EffectFieldBinding {
  instance: number;
  speed: [number | null, number | null];
  angularSpeed: number | null;
  acceleration: [number | null, number | null];
  scale: [number | null, number | null];
  rotation: number | null;
  color: [number | null, number | null];
}
export interface EffectFieldData {
  // Value classes: uniform ranges, sampled rates, component vectors and
  // alpha/hue/saturation/lightness colours.
  classes: {range: number; rate: number; vector: number; colour: number};
  bindings: EffectFieldBinding[];
}

/** A literal, or a uniform range sampled once per particle. */
export type EffectSample = number | [number, number];
/** `value` per `ticks`: native units (degrees for spin) over a duration. */
export interface EffectRateSample { value: EffectSample; ticks: number }
/** Alpha, hue (sextants: 1 = 60 degrees), saturation and lightness. */
export type EffectColourSample = {rgba: [number, number, number, number]} | {ahsl: [EffectSample, EffectSample, EffectSample, EffectSample]};
/** A second endpoint of 'start' repeats the first particle's own sample. */
export interface EffectEndpoints<T> { start: T; end: T | 'start' }
// Absent: no binding for this emitter. null: bound but not a supported value.
export interface EffectFieldValues {
  speed?: EffectEndpoints<EffectRateSample> | null;
  angularSpeed?: EffectRateSample | null;
  acceleration?: EffectEndpoints<[EffectSample, EffectSample, EffectSample]> | null;
  scale?: EffectEndpoints<EffectSample> | null;
  rotation?: EffectSample | null;
  color?: EffectEndpoints<EffectColourSample> | null;
}

export function validEffectFields(value: any): value is EffectFieldData {
  const index = (v: any) => Number.isInteger(v) && v >= 0 && v < 65536;
  const field = (v: any) => v === null || index(v);
  const pair = (v: any) => Array.isArray(v) && v.length === 2 && v.every(field);
  const c = value?.classes;
  return !!c && ['range', 'rate', 'vector', 'colour'].every(k => index(c[k]))
    && Array.isArray(value.bindings) && value.bindings.length <= 65536
    && value.bindings.every((b: any) => b && index(b.instance) && field(b.angularSpeed) && field(b.rotation)
      && [b.speed, b.acceleration, b.scale, b.color].every(pair))
    && new Set(value.bindings.map((b: any) => b.instance)).size === value.bindings.length;
}

export function createEffectFieldReader(data: EffectFieldData | undefined, objects: ConstructorRecord[]) {
  if (data !== undefined && !validEffectFields(data)) throw Error('invalid effect field bindings');
  const byInstance = new Map((data?.bindings ?? []).map(b => [b.instance, b]));
  const classes = data?.classes;
  return (slot: number, ops: EffectExtra[]): EffectFieldValues | null => {
    const b = byInstance.get(objects[slot]?.values[1]);
    if (!b || !classes) return null;
    const fields = new Map(ops.map(e => [e.op, e]));
    const scalar = (e: EffectExtra | undefined): number | null => {
      const n = e?.kind === 'float' ? e.value : e?.kind === 'fixed' && e.floats?.length === 1 ? e.floats[0] : null;
      return n !== null && Number.isFinite(n) ? n : null;
    };
    const sample = (e: EffectExtra | undefined): EffectSample | null => {
      const n = scalar(e);
      if (n !== null) return n;
      if (e?.kind !== 'typed' || e.class !== classes.range || e.fields.length !== 2) return null;
      const lo = scalar(e.fields[0]), hi = scalar(e.fields[1]);
      return lo !== null && hi !== null ? [lo, hi] : null;
    };
    const marker = (op: number | null, name: string) => {
      const e = op === null ? undefined : fields.get(op);
      return e?.kind === 'symbol' && e.name === name;
    };
    const rate = (e: EffectExtra | undefined): EffectRateSample | null => {
      if (e?.kind === 'rate') return Number.isFinite(e.value) && e.den > 0 ? {value: e.value, ticks: e.den} : null;
      if (e?.kind !== 'typed' || e.class !== classes.rate || e.fields.length !== 2) return null;
      const value = sample(e.fields[0]), duration = e.fields[1];
      return value !== null && duration.kind === 'duration' && duration.ticks > 0 ? {value, ticks: duration.ticks} : null;
    };
    const vector = (e: EffectExtra | undefined): [EffectSample, EffectSample, EffectSample] | null => {
      if (e?.kind === 'vec3') return e.v.every(Number.isFinite) ? [...e.v] : null;
      if (e?.kind !== 'typed' || e.class !== classes.vector || e.fields.length !== 3) return null;
      const v = e.fields.map(sample);
      return v.every(x => x !== null) ? v as [EffectSample, EffectSample, EffectSample] : null;
    };
    const colour = (e: EffectExtra | undefined): EffectColourSample | null => {
      if (e?.kind === 'color') return e.rgba.every(Number.isFinite) ? {rgba: [...e.rgba]} : null;
      if (e?.kind !== 'typed' || e.class !== classes.colour || e.fields.length !== 4) return null;
      const v = e.fields.map(sample);
      return v.every(x => x !== null) ? {ahsl: v as [EffectSample, EffectSample, EffectSample, EffectSample]} : null;
    };
    const endpoints = <T>(pair: [number | null, number | null], name: string, read: (e: EffectExtra | undefined) => T | null)
      : EffectEndpoints<T> | null => {
      if (pair[0] === null || pair[1] === null) return null;
      const start = read(fields.get(pair[0]));
      const end = marker(pair[1], name) ? 'start' as const : read(fields.get(pair[1]));
      return start !== null && end !== null ? {start, end} : null;
    };
    return {
      speed: endpoints(b.speed, '$speed0', rate),
      angularSpeed: b.angularSpeed === null ? null : rate(fields.get(b.angularSpeed)),
      acceleration: endpoints(b.acceleration, '$acceleration0', vector),
      scale: endpoints(b.scale, '$scale0', sample),
      rotation: b.rotation === null ? null : sample(fields.get(b.rotation)),
      color: endpoints(b.color, '$color0', colour),
    };
  };
}

/** HSL with hue in sextants; saturation and lightness clamp first. */
export function effectHslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const s = Math.min(1, Math.max(0, saturation)), l = Math.min(1, Math.max(0, lightness));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const h = ((hue % 6) + 6) % 6;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}
