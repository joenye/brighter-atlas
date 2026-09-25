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
}
export interface EffectWaveData { step: number; bindings: EffectWaveBinding[] }

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
}

export function validEffectWaves(value: any): value is EffectWaveData {
  const pair = (v: any) => Array.isArray(v) && v.length === 2 && v.every(bindingIndex);
  return !!value && Number.isInteger(value.step) && value.step > 0 && value.step < 65536
    && validBindingList(value.bindings, b => [b.water, b.point, b.count, b.threshold, b.translation].every(bindingIndex)
      && b.waterFields && ['amplitude', 'frequency', 'rate'].every(k => pair(b.waterFields[k])));
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
    if (count?.tag !== 0x0a || !Number.isInteger(count.value) || count.value < 0) return null;
    if (threshold === null || threshold === 0 || (translation?.tag !== 0x0c && translation?.tag !== 0x0d)) return null;
    const style = decode(water.value);
    const pairOf = (ops: [number, number]): [number, number] | null => {
      const v = ops.map(op => float(node(style, op)));
      return v.every(n => n !== null) ? v as [number, number] : null;
    };
    const amplitude = pairOf(b.waterFields.amplitude), frequency = pairOf(b.waterFields.frequency), rate = pairOf(b.waterFields.rate);
    if (!amplitude || !frequency || !rate) return null;
    return {step: data.step, count: count.value, threshold, point: [point.value[0], point.value[1]],
      translation: translation.tag === 0x0c, water: {amplitude, frequency, rate}};
  };
}

/** Water height at a world point and time, in native units. */
export function waterHeight(water: WaterWaves, x: number, y: number, ticks: number): number {
  return water.amplitude[0] * Math.sin(water.frequency[0] * x + water.rate[0] * ticks)
    + water.amplitude[1] * Math.sin(water.frequency[1] * y + water.rate[1] * ticks);
}
