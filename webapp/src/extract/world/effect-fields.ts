// Optional per-build decode data is produced offline purely from analysis of
// the game's own files, never by inspecting or modifying a running game
// process or its memory. It locates each emitter's spawn-time properties;
// every value is read from the user's bundle.
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';
import {bindingIndex, instanceLookup, validBindingList} from './effect-bindings.js';
import {ownerFields} from './effect-sources.js';

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

/** A literal, a uniform range sampled once per particle, or one of a few of those picked per particle. */
export type EffectSample = number | [number, number] | EffectChoice;
/** One of a few values, each with its weight, picked per particle in their order by one fraction: the particle's own
 *  seeded draw with `salt` (so every value a particle picks with that salt agrees), else a draw of its own. */
export interface EffectChoice { choice: [number, number | [number, number]][]; salt?: number }
const plainSample = (v: any) => Number.isFinite(v) || (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite));
/** A choice as the decode data gives it: weights that sum to one, each value a number or a range. */
export function validEffectChoice(v: any): v is EffectChoice {
  if (!v || typeof v !== 'object' || !Array.isArray(v.choice) || v.choice.length < 2 || v.choice.length > 16) return false;
  if (v.salt !== undefined && !(Number.isInteger(v.salt) && v.salt >= 0 && v.salt < 2 ** 32)) return false;
  if (!v.choice.every((e: any) => Array.isArray(e) && e.length === 2 && Number.isFinite(e[0]) && e[0] >= 0
    && plainSample(e[1]))) return false;
  return Math.abs(v.choice.reduce((sum: number, e: any) => sum + e[0], 0) - 1) < 1e-3;
}
/** `value` per `ticks`: native units (degrees for spin) over a duration. */
export interface EffectRateSample { value: EffectSample; ticks: number }
/** Alpha, hue (sextants: 1 = 60 degrees), saturation and lightness. */
/** `mix`: a colour the game mixes from two by a uniform draw per particle (each channel straight, or premultiplied by
 *  alpha), times `scale` channel by channel. */
export type EffectColourSample = {rgba: [number, number, number, number]} | {ahsl: [EffectSample, EffectSample, EffectSample, EffectSample]}
  | {mix: [[number, number, number, number], [number, number, number, number]]; premultiplied: boolean; scale?: [number, number, number, number]}
  | {table: [number, number, number, number][]};
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

/** A finite float, or a fixed value holding exactly one. */
export function effectScalar(e: EffectExtra | undefined): number | null {
  const n = e?.kind === 'float' ? e.value : e?.kind === 'fixed' && e.floats?.length === 1 ? e.floats[0] : null;
  return n !== null && Number.isFinite(n) ? n : null;
}
/** A uniform range: an instance of `cls` holding two scalars. */
export function effectRange(e: EffectExtra | undefined, cls: number): [number, number] | null {
  if (e?.kind !== 'typed' || e.class !== cls || e.fields.length !== 2) return null;
  const lo = effectScalar(e.fields[0]), hi = effectScalar(e.fields[1]);
  return lo !== null && hi !== null ? [lo, hi] : null;
}
export function effectVec3(e: EffectExtra | undefined): [number, number, number] | null {
  return e?.kind === 'vec3' && e.v.every(Number.isFinite) ? [...e.v] : null;
}

// Where a property the emitter's record does not hold comes from (per-build decode data): the emitter's own field, a
// field of the system that owns it (owner level 1), or a value worked out from the game's own draws (a number, a
// uniform range per number, or one of a few such picked per particle; a rate also its ticks). Kept apart from the
// field bindings.
export type PropertySource = {op: number} | {owner: number; op: number}
  | {value: EffectSample | [EffectSample, EffectSample, EffectSample]; ticks?: number};
export interface PropertySourceBinding {
  instance: number;
  speed?: [PropertySource | null, PropertySource | null];
  acceleration?: [PropertySource | null, PropertySource | null];
  scale?: [PropertySource | null, PropertySource | null];
  rotation?: PropertySource;
  angularSpeed?: PropertySource;
}
const sampleOk = (v: any) => plainSample(v) || validEffectChoice(v);
function validPropertySource(s: any, kind: 'scalar' | 'vector' | 'rate'): boolean {
  if (s === null) return true;
  if (!s || typeof s !== 'object') return false;
  if ('value' in s) {
    const ticks = s.ticks === undefined ? kind !== 'rate' : kind === 'rate' && Number.isInteger(s.ticks) && s.ticks > 0;
    const value = kind === 'vector' ? Array.isArray(s.value) && s.value.length === 3 && s.value.every(sampleOk) : sampleOk(s.value);
    return ticks && value;
  }
  return bindingIndex(s.op) && (s.owner === undefined || (Number.isInteger(s.owner) && s.owner >= 1 && s.owner <= 2));
}
export function validEffectPropertySources(v: any): v is PropertySourceBinding[] {
  const pair = (p: any, kind: 'scalar' | 'vector' | 'rate') => p === undefined
    || (Array.isArray(p) && p.length === 2 && p.every((s: any) => validPropertySource(s, kind)));
  const one = (s: any, kind: 'scalar' | 'rate') => s === undefined || (s !== null && validPropertySource(s, kind));
  return validBindingList(v, b => pair(b.speed, 'rate') && pair(b.acceleration, 'vector') && pair(b.scale, 'scalar')
    && one(b.rotation, 'scalar') && one(b.angularSpeed, 'rate'));
}

export function validEffectFields(value: any): value is EffectFieldData {
  const field = (v: any) => v === null || bindingIndex(v);
  const pair = (v: any) => Array.isArray(v) && v.length === 2 && v.every(field);
  const c = value?.classes;
  return !!c && ['range', 'rate', 'vector', 'colour'].every(k => bindingIndex(c[k]))
    && validBindingList(value.bindings, b => field(b.angularSpeed) && field(b.rotation)
      && [b.speed, b.acceleration, b.scale, b.color].every(pair));
}

export function createEffectFieldReader(data: EffectFieldData | undefined, objects: ConstructorRecord[],
  sources?: PropertySourceBinding[]) {
  if (data !== undefined && !validEffectFields(data)) throw Error('invalid effect field bindings');
  if (sources !== undefined && !validEffectPropertySources(sources)) throw Error('invalid effect property sources');
  const bindingOf = instanceLookup((data?.bindings ?? []).map(b => [b.instance, b] as const), objects);
  const sourceOf = instanceLookup((sources ?? []).map(b => [b.instance, b] as const), objects);
  const none = -1;   // (no value of any build has this class)
  const classes = data?.classes ?? (sources?.length ? {range: none, rate: none, vector: none, colour: none} : undefined);
  // opsOf: any record's fields by slot, for a value read from the system that owns the emitter
  const read = (slot: number, ops: EffectExtra[], opsOf?: (slot: number) => EffectExtra[] | null): EffectFieldValues | null => {
    const b = bindingOf(slot), src = sourceOf(slot);
    if ((!b && !src) || !classes) return null;
    const fields = new Map(ops.map(e => [e.op, e]));
    const sample = (e: EffectExtra | undefined): EffectSample | null => effectScalar(e) ?? effectRange(e, classes.range);
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
      if (e?.kind === 'vec3') return effectVec3(e);
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
    const values: EffectFieldValues = b ? {
      speed: endpoints(b.speed, '$speed0', rate),
      angularSpeed: b.angularSpeed === null ? null : rate(fields.get(b.angularSpeed)),
      acceleration: endpoints(b.acceleration, '$acceleration0', vector),
      scale: endpoints(b.scale, '$scale0', sample),
      rotation: b.rotation === null ? null : sample(fields.get(b.rotation)),
      color: endpoints(b.color, '$color0', colour),
    } : {speed: null, angularSpeed: null, acceleration: null, scale: null, rotation: null, color: null};
    if (!src) return values;
    // (a property the record does not hold: from its source, read the way the record's own field would be)
    const owners = ownerFields(ops, opsOf);
    const fieldOf = (s: {op: number; owner?: number}) => s.owner ? owners(s.owner)?.get(s.op) : fields.get(s.op);
    const one = <T>(s: PropertySource | null | undefined, from: (e: EffectExtra | undefined) => T | null,
      made: (s: {value: any; ticks?: number}) => T | null): T | null =>
      !s ? null : 'value' in s ? made(s) : from(fieldOf(s));
    // (an end the build does not work out: the record's own end field, where the binding names one)
    const pair = <T>(p: [PropertySource | null, PropertySource | null] | undefined, name: string,
      from: (e: EffectExtra | undefined) => T | null, made: (s: {value: any; ticks?: number}) => T | null,
      ownEnd: number | null | undefined): EffectEndpoints<T> | null => {
      if (!p) return null;
      const start = one(p[0], from, made);
      if (start === null) return null;
      const endSource: PropertySource | null = p[1] ?? (ownEnd === null || ownEnd === undefined ? null : {op: ownEnd});
      const e = endSource && !('value' in endSource) ? fieldOf(endSource) : undefined;
      const end = e?.kind === 'symbol' && e.name === name ? 'start' as const : one(endSource, from, made);
      return end === null ? null : {start, end};
    };
    const madeSample = (s: {value: any}) => s.value as EffectSample;
    const madeRate = (s: {value: any; ticks?: number}) => ({value: s.value as EffectSample, ticks: s.ticks!});
    const madeVector = (s: {value: any}) => s.value as [EffectSample, EffectSample, EffectSample];
    if (!values.speed) values.speed = pair(src.speed, '$speed0', rate, madeRate, b?.speed[1]);
    if (!values.angularSpeed) values.angularSpeed = one(src.angularSpeed, rate, madeRate);
    if (!values.acceleration) values.acceleration = pair(src.acceleration, '$acceleration0', vector, madeVector, b?.acceleration[1]);
    if (!values.scale) values.scale = pair(src.scale, '$scale0', sample, madeSample, b?.scale[1]);
    if (values.rotation === null || values.rotation === undefined) values.rotation = one(src.rotation, sample, madeSample);
    return values;
  };
  // Whether the build's decode data knows this row as a particle emitter.
  const bound = (slot: number): boolean => bindingOf(slot) !== undefined || sourceOf(slot) !== undefined;
  return Object.assign(read, {bound});
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

// A speed the game computes (from 07-Oct-2026: the Halloween teleports' bats): a uniform draw between two ends, native
// units per second, for every emitter of its instance.
export interface EffectSpeedBinding { instance: number; speed: [number, number] }
export function validEffectSpeeds(v: any): v is EffectSpeedBinding[] {
  return validBindingList(v, b => Array.isArray(b.speed) && b.speed.length === 2
    && b.speed.every((n: any) => Number.isFinite(n) && n >= 0) && b.speed[0] <= b.speed[1]);
}
export function createEffectSpeedReader(bindings: EffectSpeedBinding[] | undefined, objects: ConstructorRecord[]) {
  if (bindings !== undefined && !validEffectSpeeds(bindings)) throw Error('invalid effect speed bindings');
  const bindingOf = instanceLookup((bindings || []).map(b => [b.instance, b.speed] as const), objects);
  return (slot: number): [number, number] | undefined => bindingOf(slot);
}
