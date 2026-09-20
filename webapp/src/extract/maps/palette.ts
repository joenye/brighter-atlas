// Colour operations use single precision throughout, including intermediate
// HSL values. Rounding only at the final RGB555 conversion changes some tiles.
import {packMapColor} from './geometry.js';

export type MapColorRule =
  | {kind: 'default'}
  | {kind: 'constant'; value: number}
  | {kind: 'rgb' | 'hsl'; color: number; multiply: [number, number, number]};

export interface MapPaletteRules {
  base: Record<string, MapColorRule>;
  rooms: Record<string, Record<string, MapColorRule>>;
}

const f = Math.fround;
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

export function resolveMapPalette(
  runtime: number, keys: Iterable<number>, colors: readonly (readonly number[])[],
  defaults: ReadonlyMap<number, number>, rules: MapPaletteRules,
): Map<number, number> {
  if (!Object.hasOwn(rules.rooms, runtime)) throw Error(`unsupported map palette for room type ${runtime}`);
  const overrides = rules.rooms[runtime], palette = new Map<number, number>();
  for (const key of keys) {
    const rule = overrides[key] ?? rules.base[key], fallback = defaults.get(key);
    if (!rule || fallback === undefined) throw Error(`unresolved map style ${key}`);
    palette.set(key, evaluateMapColor(rule, colors, fallback));
  }
  return palette;
}
