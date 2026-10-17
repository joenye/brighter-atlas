// Optional per-build decode data is produced offline purely from analysis of
// the game's own files, never by inspecting or modifying a running game
// process or its memory. It locates the fields of wave-timed bursts and of the
// water style they follow; every value is read from the user's bundle.
import {resolveValue} from './room-metadata.js';
import type {ConstructorRecord} from './replay.js';
import type {ReparsedOp} from './effects.js';
import {bindingIndex, instanceLookup, validBindingList} from './effect-bindings.js';

export interface EffectWaveBinding {
  instance: number;
  water: number; point: number; count: number; threshold: number; translation: number;
  waterFields: {amplitude: [number, number]; frequency: [number, number]; rate: [number, number]};
  // Bursts that follow another burst's crests (per-build decode data): a fixed count in place of the count field, and
  // a hold-back read from the owning emitter's record: `steps` later when its field `flag` is set, or its field
  // `field`'s value in steps.
  countValue?: number;
  delay?: {steps: number; flag: number} | {field: number};
}
export interface EffectWaveData { step: number; bindings: EffectWaveBinding[] }

/** A burst whose particle count asks another burst's (per-build decode data): the instances it follows (`as`), what it
 *  releases when that one fires (a field of its own record, or a fixed count) and its hold-back. */
export interface EffectCountDelegate {
  instance: number;
  as: number[];
  count: {field: number} | {value: number};
  delay?: {steps: number; flag: number} | {field: number};
}

export function validEffectCountDelegates(value: any): value is EffectCountDelegate[] {
  const count = (c: any) => !!c && Object.keys(c).length === 1
    && (c.field !== undefined ? bindingIndex(c.field) : Number.isInteger(c.value) && c.value > 0 && c.value < 65536);
  const delay = (d: any) => d === undefined || (!!d && (Object.keys(d).length === 2 ? Number.isInteger(d.steps) && d.steps > 0
    && d.steps < 65536 && bindingIndex(d.flag) : Object.keys(d).length === 1 && bindingIndex(d.field)));
  return validBindingList(value, b => Array.isArray(b.as) && b.as.length > 0 && b.as.length <= 256 && b.as.every(bindingIndex)
    && count(b.count) && delay(b.delay));
}

/** Two travelling sine waves: height = sum of amplitude * sin(frequency *
 *  coordinate + rate * ticks), the first along x and the second along y. */
export interface WaterWaves {
  amplitude: [number, number];
  frequency: [number, number];   // radians per native unit
  rate: [number, number];        // radians per tick
}
/** A burst that fires `count` particles each time the water height at its
 *  point rises past `threshold` after having fallen below zero. */
export interface EffectWave {
  step: number;                  // ticks between height samples
  count: number;
  threshold: number;
  point: [number, number];       // in the owner's frame
  translation: boolean;          // true: owner position only, no rotation
  water: WaterWaves;
  delay?: number;                // steps a crest's particles are held back (absent: none)
}

export function validEffectWaves(value: any): value is EffectWaveData {
  const pair = (v: any) => Array.isArray(v) && v.length === 2 && v.every(bindingIndex);
  const delay = (d: any) => d === undefined || validEffectCountDelegates([{instance: 0, as: [0], count: {value: 1}, delay: d}]);
  return !!value && Number.isInteger(value.step) && value.step > 0 && value.step < 65536
    && validBindingList(value.bindings, b => [b.water, b.point, b.count, b.threshold, b.translation].every(bindingIndex)
      && b.waterFields && ['amplitude', 'frequency', 'rate'].every(k => pair(b.waterFields[k]))
      && (b.countValue === undefined || (Number.isInteger(b.countValue) && b.countValue > 0 && b.countValue < 65536))
      && delay(b.delay));
}

export function createEffectWaveReader(data: EffectWaveData | undefined, objects: ConstructorRecord[],
  decode: (slot: number) => ReparsedOp[] | null, pool: any[]) {
  if (data !== undefined && !validEffectWaves(data)) throw Error('invalid effect wave bindings');
  const bindingOf = instanceLookup((data?.bindings ?? []).map(b => [b.instance, b] as const), objects);
  return (slot: number): EffectWave | null => {
    const b = bindingOf(slot);
    if (!b || !data) return null;
    const node = (fields: ReparsedOp[] | null, op: number) => {
      const f = fields?.find(e => e.op === op);
      return f?.kind === 'G' ? resolveValue(pool, f.node) : null;
    };
    const float = (n: any): number | null => n?.tag === 0x0b && Array.isArray(n.value) && n.value.length === 1
      && Number.isFinite(n.value[0]) ? n.value[0] : null;
    const fields = decode(slot);
    const water = node(fields, b.water), point = node(fields, b.point), count = node(fields, b.count);
    const threshold = float(node(fields, b.threshold)), translation = node(fields, b.translation);
    if (water?.tag !== 0x26 || !Number.isInteger(water.value)) return null;
    if (point?.tag !== 0x18 || !Array.isArray(point.value) || point.value.length !== 2 || !point.value.every(Number.isFinite)) return null;
    const fixed = b.countValue;
    if (fixed === undefined && (count?.tag !== 0x0a || !Number.isInteger(count.value) || count.value < 0)) return null;
    if (threshold === null || threshold === 0 || (translation?.tag !== 0x0c && translation?.tag !== 0x0d)) return null;
    const style = decode(water.value);
    const pairOf = (ops: [number, number]): [number, number] | null => {
      const v = ops.map(op => float(node(style, op)));
      return v.every(n => n !== null) ? v as [number, number] : null;
    };
    const amplitude = pairOf(b.waterFields.amplitude), frequency = pairOf(b.waterFields.frequency), rate = pairOf(b.waterFields.rate);
    if (!amplitude || !frequency || !rate) return null;
    let delay = 0;
    if (b.delay) {
      // (the owning emitter: the record's own back reference)
      const own = fields?.find(e => e.op === 0);
      const owner = own && own.kind === 'U' && Number.isInteger(own.value) ? decode(own.value) : null;
      const at = 'flag' in b.delay ? b.delay.flag : b.delay.field;
      const f = owner?.find(e => e.op === at);
      const n = f?.kind === 'G' ? resolveValue(pool, f.node) : null;
      const v = n?.tag === 0x0a && Number.isInteger(n.value) ? n.value : n?.tag === 0x0c ? 1 : n?.tag === 0x0d ? 0
        : f && f.kind !== 'G' && 'value' in f && Number.isInteger(f.value) ? f.value : null;
      if (v === null || v < 0) return null;
      delay = 'flag' in b.delay ? (v !== 0 ? b.delay.steps : 0) : Math.min(v, 65535);
    }
    return {step: data.step, count: fixed ?? count!.value, threshold, point: [point.value[0], point.value[1]],
      translation: translation.tag === 0x0c, water: {amplitude, frequency, rate}, ...(delay ? {delay} : {})};
  };
}

/** Water height at a world point and time, in native units. */
export function waterHeight(water: WaterWaves, x: number, y: number, ticks: number): number {
  return water.amplitude[0] * Math.sin(water.frequency[0] * x + water.rate[0] * ticks)
    + water.amplitude[1] * Math.sin(water.frequency[1] * y + water.rate[1] * ticks);
}
