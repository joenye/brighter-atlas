// Values a shape's geometry takes from somewhere other than its own record, from per-build decode data (produced
// offline purely from analysis of the game's own files, never by inspecting or modifying a running game process or
// its memory): a field of a record up the shape's owner chain (level 1 the emitter that owns the shape, level 2 the
// system that owns that), a value computed for each particle, or a sampled value (a number, a range, or one of a few
// picked per particle). One resolver for every kind of shape that uses them.
import type {EffectExtra} from './effects.js';
import {effectRange, effectScalar, effectVec3, validEffectChoice, type EffectSample} from './effect-fields.js';
import {bindingIndex} from './effect-bindings.js';

/** Computed for each particle: a polynomial over a few uniform draws (coefficient k belongs to the product of the
 *  draws whose bits k sets), per axis for a vector; at a particle number below `count`'s length, times that entry
 *  (a value that grows to its size over the first particles); with `perCount`, plus the particle number times a
 *  second such polynomial (a value that moves on with every particle). */
export interface ComputedValue {
  draws: number;
  coef?: number[];
  axes?: number[][];
  count?: number[];
  perCount?: number[] | number[][];
}
export type ValueSource = {op: number} | {owner: number; op: number} | ComputedValue | {value: EffectSample};
export const OWNER_LEVELS = 2;

const finiteList = (v: any, n: number) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);

/** A value source as the decode data gives it; `vector`: three axes. */
export function validValueSource(v: any, vector: boolean): v is ValueSource {
  if (!v || typeof v !== 'object') return false;
  if ('op' in v) {
    return bindingIndex(v.op) && (v.owner === undefined
      || (Number.isInteger(v.owner) && v.owner >= 1 && v.owner <= OWNER_LEVELS));
  }
  if ('value' in v) {
    // (a sampled value: a scalar only)
    const s = v.value;
    return !vector && (Number.isFinite(s) || (Array.isArray(s) && s.length === 2 && s.every(Number.isFinite))
      || validEffectChoice(s));
  }
  if (!Number.isInteger(v.draws) || v.draws < 0 || v.draws > 4) return false;
  const terms = 1 << v.draws;
  const shape = (x: any) => vector ? Array.isArray(x) && x.length === 3 && x.every((a: any) => finiteList(a, terms))
    : finiteList(x, terms);
  if (!shape(vector ? v.axes : v.coef)) return false;
  if (v.count !== undefined && !(Array.isArray(v.count) && v.count.length <= 4096 && v.count.every(Number.isFinite))) {
    return false;
  }
  return v.perCount === undefined || shape(v.perCount);
}

/** The fields of the records up a shape's owner chain: each record names its owner in field 0. */
export function ownerFields(ops: EffectExtra[], opsOf?: (slot: number) => EffectExtra[] | null) {
  const levels: (Map<number, EffectExtra> | null)[] = [];
  let at: EffectExtra[] | null = ops;
  for (let level = 1; level <= OWNER_LEVELS; level++) {
    const own: EffectExtra | undefined = at?.find(e => e.op === 0 && e.kind === 'scalar');
    const slot: number = own && 'value' in own ? Number(own.value) : NaN;
    at = Number.isInteger(slot) && opsOf ? opsOf(slot) : null;
    levels.push(at ? new Map(at.map(e => [e.op, e])) : null);
  }
  return (level: number): Map<number, EffectExtra> | null => levels[level - 1] ?? null;
}

export type ResolvedScalar = {value: EffectSample} | {computed: ComputedValue};
export type ResolvedVector = {value: [number, number, number]} | {computed: ComputedValue};

const fieldOf = (src: {op: number; owner?: number}, fields: Map<number, EffectExtra>,
  owners: (level: number) => Map<number, EffectExtra> | null) =>
  src.owner === undefined ? fields.get(src.op) : owners(src.owner)?.get(src.op);

/** A number (or a uniform range, an instance of `uniformClass`), else null. */
export function resolveScalar(src: ValueSource, fields: Map<number, EffectExtra>,
  owners: (level: number) => Map<number, EffectExtra> | null, uniformClass: number): ResolvedScalar | null {
  if ('op' in src) {
    const e = fieldOf(src, fields, owners);
    const value = effectScalar(e) ?? effectRange(e, uniformClass);
    return value === null ? null : {value};
  }
  if ('value' in src) return {value: src.value};
  return {computed: src};
}
/** A vector, else null. */
export function resolveVector(src: ValueSource, fields: Map<number, EffectExtra>,
  owners: (level: number) => Map<number, EffectExtra> | null): ResolvedVector | null {
  if ('op' in src) {
    const value = effectVec3(fieldOf(src, fields, owners));
    return value ? {value} : null;
  }
  if ('value' in src) return null;
  return {computed: src};
}
