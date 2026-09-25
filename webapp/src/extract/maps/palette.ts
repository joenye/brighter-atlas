// Colour operations use single precision throughout, including intermediate
// HSL values. Rounding only at the final RGB555 conversion would change some tiles.
import {packMapColor} from './geometry.js';

export type MapColorRule =
  | {kind: 'default'}
  | {kind: 'constant'; value: number}
  | {kind: 'rgb' | 'hsl'; color: number; multiply: [number, number, number]}
  // The colour another room gives this style: that room's own rule, with its
  // own base colours.
  | {kind: 'room'; owner: number};

/** Each room type's own colour rules, by style key. */
export type MapRoomRules = Record<string, Record<string, MapColorRule>>;

const f = Math.fround;

/** The shared rules every room applies unless its type has its own: tints of
 *  the room's base colours for five style keys. Other keys keep the style's
 *  stored colour. These are the same in every build. */
export const MAP_BASE_RULES: Readonly<Record<string, MapColorRule>> = {
  0: {kind: 'rgb', color: 0, multiply: [f(1.2), f(1.4), f(1.2)]},
  2: {kind: 'hsl', color: 1, multiply: [1, f(1.4), f(1.6)]},
  7: {kind: 'hsl', color: 0, multiply: [1, f(1.6), f(1.3)]},
  8: {kind: 'rgb', color: 0, multiply: [f(1.2), 1, 1]},
  10: {kind: 'hsl', color: 2, multiply: [1, 1, f(1.5)]},
};
const DEFAULT_RULE: MapColorRule = {kind: 'default'};
const unit = (v: number): number => Math.max(0, Math.min(1, f(v)));

function rgbToHsl(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb.map(unit);
  const low = Math.min(r, g, b), high = Math.max(r, g, b);
  const delta = f(high - low), sum = f(low + high);
  let h = 0;
  if (delta !== 0) {
    h = high === r ? f(f(f(g - b) / delta) + 6) % 6
      : high === g ? f(f(f(b - r) / delta) + 2)
      : f(f(f(r - g) / delta) + 4);
  }
  const denominator = sum <= 1 ? sum : f(2 - sum);
  return [h, denominator === 0 ? 0 : f(delta / denominator), f(sum * 0.5)];
}

function hslToRgb(hsl: readonly number[]): [number, number, number] {
  let h = f(hsl[0]) % 6;
  if (h < 0) h = f(h + 6);
  const s = unit(hsl[1]), l = unit(hsl[2]);
  const half = l > 0.5 ? f(1 - l) : l;
  const c = f(f(half + half) * s);
  const x = f(f(1 - Math.abs(f(h % 2 - 1))) * c);
  const m = f(l + f(c * -0.5));
  const rgb = h < 1 ? [c,x,0] : h < 2 ? [x,c,0] : h < 3 ? [0,c,x]
    : h < 4 ? [0,x,c] : h < 5 ? [x,0,c] : [c,0,x];
  return rgb.map(v => f(v + m)) as [number, number, number];
}

export function evaluateMapColor(
  rule: MapColorRule, colors: readonly (readonly number[])[], default555: number,
): number {
  if (rule.kind === 'default' || rule.kind === 'constant') {
    const value = rule.kind === 'default' ? default555 : rule.value;
    if (!Number.isInteger(value) || value < 0 || value > 0x7fff) throw Error('invalid map style color');
    return value;
  }
  if (rule.kind !== 'rgb' && rule.kind !== 'hsl') throw Error('unsupported map color operation');
  const source = colors[rule.color];
  if (!Number.isInteger(rule.color) || !source || source.length < 3
    || !source.slice(0, 3).every(Number.isFinite)
    || !Array.isArray(rule.multiply) || rule.multiply.length !== 3 || !rule.multiply.every(Number.isFinite)) {
    throw Error('invalid map color input');
  }
  const input = rule.kind === 'hsl' ? rgbToHsl(source.slice(0, 3)) : source.slice(0, 3).map(f);
  const scaled = input.map((v, i) => f(v * f(rule.multiply[i])));
  return packMapColor(rule.kind === 'hsl' ? hslToRgb(scaled) : scaled);
}

/** A room's type and base colours, by its record. */
export type MapRoomLookup = (owner: number) => {runtime: number; colors: readonly (readonly number[])[]} | undefined;

// A room type without rules of its own (or a build without them) uses the
// shared rules alone. A rule naming another room takes that room's rule and
// base colours; when that room is unknown, the shared rule applies.
export function resolveMapPalette(
  runtime: number, keys: Iterable<number>, colors: readonly (readonly number[])[],
  defaults: ReadonlyMap<number, number>, rooms: MapRoomRules | null, room?: MapRoomLookup,
): Map<number, number> {
  const ruleOf = (type: number, key: number): MapColorRule | undefined =>
    (rooms && Object.hasOwn(rooms, type) ? rooms[type] : null)?.[key];
  const shared = (key: number): MapColorRule => MAP_BASE_RULES[key] ?? DEFAULT_RULE;
  const palette = new Map<number, number>();
  for (const key of keys) {
    const fallback = defaults.get(key);
    if (fallback === undefined) throw Error(`unresolved map style ${key}`);
    let rule = ruleOf(runtime, key) ?? shared(key), source = colors;
    for (let hops = 0; rule.kind === 'room'; hops++) {
      const other = hops < 8 ? room?.(rule.owner) : undefined;
      if (!other) { rule = shared(key); source = colors; break; }
      rule = ruleOf(other.runtime, key) ?? shared(key);
      source = other.colors;
    }
    palette.set(key, evaluateMapColor(rule, source, fallback));
  }
  return palette;
}
