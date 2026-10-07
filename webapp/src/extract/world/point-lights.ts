// Point lights (07-Oct-2026 on): the lights placed scenery carries. A
// scenery kind holds a light definition in one of its fields: the light's
// style (colour, intensity, falloff, specular, flicker), its range, its
// offset from the object, an optional spot axis with its cone and soft edge,
// a pull-back width and an attach point. A kind also carries the lights of
// the records it refers to: a light record of its own (forges), and a
// model's visual state, which holds lights with the times they shine
// (always, or windows of an animation), of which the always-on ones (street
// lamps). Found by shape, so any build works.

import {resolveValue} from './room-metadata.js';
import type {PoolNode} from './value-pool.js';

/** One light as a room shard keeps it: the occurrence it hangs from and its definition. */
export interface ShardPointLight {
  occurrence: number;
  /** A model's light (the game gives these a cell's last slot). */
  model?: true;
  offset: [number, number, number];
  range: number;
  direction: [number, number, number] | null;
  cone: number;
  feather: number;
  width: number;
  colour: [number, number, number];
  intensity: number;
  falloff: number;
  specular: number;
  flicker: {depth: number; rate: number; colour: [number, number, number] | null};
}

type Definition = Omit<ShardPointLight, 'occurrence'>;
type Decode = (slot: number) => {op: number; kind: string; node?: any}[] | null;

/** A style: a colour, five numbers (intensity, falloff, specular, flicker depth and rate), a flicker
 *  colour or none, one number more. */
function readStyle(pool: PoolNode[], n: PoolNode | null): Pick<Definition, 'colour' | 'intensity' | 'falloff' | 'specular' | 'flicker'> | null {
  if (n?.tag !== 0x24 || !Array.isArray(n.fields) || n.fields.length !== 8) return null;
  const f = n.fields.map((x) => resolveValue(pool, x));
  const num = (k: number) => (f[k]?.tag === 0x0b && Array.isArray(f[k]!.value) && Number.isFinite(f[k]!.value[0]) ? Number(f[k]!.value[0]) : null);
  const rgb = (k: number) => (f[k]?.tag === 0x15 && Array.isArray(f[k]!.value) && f[k]!.value.length === 4
    ? [0, 1, 2].map((i) => Number(f[k]!.value[i])) as [number, number, number] : null);
  const colour = rgb(0), values = [1, 2, 3, 4, 5, 7].map(num);
  if (!colour || values.some((v) => v === null) || (f[6]?.tag !== 0x0f && !rgb(6))) return null;
  const [intensity, falloff, specular, depth, rate] = values as number[];
  return {colour, intensity, falloff, specular, flicker: {depth, rate, colour: rgb(6)}};
}

/** A definition: a style, the range, the offset, the spot axis or none, cone, soft edge, pull-back width,
 *  attach point or none, two numbers and a flag. */
function readDefinition(pool: PoolNode[], n: PoolNode | null): Definition | null {
  if (n?.tag !== 0x24 || !Array.isArray(n.fields) || n.fields.length !== 11) return null;
  const f = n.fields.map((x) => resolveValue(pool, x));
  const style = readStyle(pool, f[0]);
  const num = (k: number) => (f[k]?.tag === 0x0b && Array.isArray(f[k]!.value) && Number.isFinite(f[k]!.value[0]) ? Number(f[k]!.value[0]) : null);
  const vec = (k: number) => (f[k]?.tag === 0x22 && Array.isArray(f[k]!.value) && f[k]!.value.length === 3
    ? f[k]!.value.map(Number) as [number, number, number] : null);
  const offset = vec(2), direction = vec(3), range = num(1), cone = num(4), feather = num(5), width = num(6);
  if (!style || !offset || (!direction && f[3]?.tag !== 0x0f) || range === null || cone === null || feather === null
    || width === null || (f[7]?.tag !== 0x0f && f[7]?.tag !== 0x0a) || num(8) === null || num(9) === null
    || (f[10]?.tag !== 0x0c && f[10]?.tag !== 0x0d)) return null;
  return {offset, range, direction, cone, feather, width, ...style};
}

/** A model's lights (one, or a list): each with the times it shines (`$all`, or windows), fade in and out,
 *  and a flag. The always-on ones (a still frame shows them; windowed ones belong to an animation's moment). */
function readModelLights(pool: PoolNode[], n: PoolNode | null): Definition[] {
  const items = n?.tag === 0x24 ? [n] : n && n.tag !== 0x0e && Array.isArray(n.values) ? n.values : [];
  const out: Definition[] = [];
  for (const item of items) {
    const h = typeof item === 'object' ? resolveValue(pool, item) : null;
    if (h?.tag !== 0x24 || !Array.isArray(h.fields) || h.fields.length !== 5) return [];
    const f = h.fields.map((x) => resolveValue(pool, x));
    const light = readDefinition(pool, f[0]);
    if (!light || f[2]?.tag !== 0x28 || f[3]?.tag !== 0x28 || (f[4]?.tag !== 0x0c && f[4]?.tag !== 0x0d)) return [];
    if (f[1]?.tag === 0x0f) out.push(light);
  }
  return out;
}

const fieldsOf = (decode: Decode, slot: number) => { try { return decode(slot) ?? []; } catch { return []; } };

/** The records a field refers to (within lists too). */
function references(pool: PoolNode[], n: PoolNode | null, out: Set<number>, depth = 0): void {
  if (!n || depth > 3) return;
  if (n.tag === 0x26 && Number.isInteger(n.value)) out.add(n.value as number);
  else if (n.tag !== 0x0e && Array.isArray(n.values)) {
    for (const v of n.values) if (typeof v === 'object') references(pool, resolveValue(pool, v), out, depth + 1);
  }
}

/** The lights a record carries: in its own fields (scenery kinds), and those of the records it refers to
 *  (each once): their own fields' and, as a model's, their always-on visual state lights. Cached per record. */
export function lightCarrier(pool: PoolNode[], decode: Decode): (slot: number) => (Definition & {model?: true})[] {
  const cache = new Map<number, (Definition & {model?: true})[]>();
  const referred = new Map<number, (Definition & {model?: true})[]>();
  const referredLights = (slot: number) => {
    let out = referred.get(slot);
    if (!out) {
      out = [];
      for (const field of fieldsOf(decode, slot)) {
        if (field.kind !== 'G') continue;
        const node = resolveValue(pool, field.node);
        const light = readDefinition(pool, node);
        if (light) out.push(light);
        else for (const model of readModelLights(pool, node)) out.push({...model, model: true});
      }
      referred.set(slot, out);
    }
    return out;
  };
  return (slot) => {
    let out = cache.get(slot);
    if (out) return out;
    out = [];
    const refs = new Set<number>();
    for (const field of fieldsOf(decode, slot)) {
      if (field.kind !== 'G') continue;
      const node = resolveValue(pool, field.node);
      const light = readDefinition(pool, node);
      if (light) out.push(light);
      else references(pool, node, refs);
    }
    for (const ref of refs) if (ref !== slot) out.push(...referredLights(ref));
    cache.set(slot, out);
    return out;
  };
}

/** A room's lights: each occurrence's, those its kind and its appearance carry (a light both carry once). */
export function roomPointLights(occurrences: any[][], columns: string[], lightsOf: (slot: number) => (Definition & {model?: true})[]): ShardPointLight[] {
  const resource = columns.indexOf('resource'), appearance = columns.indexOf('appearance_resource');
  const out: ShardPointLight[] = [];
  occurrences.forEach((row, occurrence) => {
    const slots = new Set([row[resource], appearance >= 0 ? row[appearance] : null].filter((v) => Number.isInteger(v) && v >= 0));
    const seen = new Set<string>();
    for (const slot of slots) for (const light of lightsOf(slot)) {
      const key = JSON.stringify(light);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({occurrence, ...light});
    }
  });
  return out;
}
