// How the game colours the parts of each tile. A block face or model carries
// two authored colours and the game picks between them per tile: a hash of
// the room's seed and the tile's x, y gives a fraction t in [0, 1] and the
// part colour is the blend at t. Some ground blocks also shift the lightness
// of their top faces by up to 5% per tile. Every step runs in single
// precision, in the game's own order, so the result matches it bit for bit.
//
// Which records carry the seed and which blocks vary comes from optional
// per-build decode data, produced offline purely from analysis of the game's
// own files, never by inspecting or modifying a running game process or its
// memory. Every colour is read from the user's bundle.

const f = Math.fround;

/** The 32-bit hash of a room seed and a tile position. */
export function tileHash(seed: number, x: number, y: number): number {
  let h = seed >>> 0;
  const mix = () => {
    h = (h + (h << 10 >>> 0)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  };
  mix();
  h = (h + (x >>> 0)) >>> 0; mix();
  h = (h + (y >>> 0)) >>> 0; mix();
  h = Math.imul(h, 9) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  return (h + (h << 15 >>> 0)) >>> 0;
}

/** The tile's blend fraction: the hash's low 24 bits over 2^24 - 1. */
export function tileFraction(seed: number, x: number, y: number): number {
  return f((tileHash(seed, x, y) & 0xffffff) / f(16777215));
}

export type Colour = [number, number, number, number];

/** Blend two RGBA colours at t with premultiplied alpha. A blend with
 *  zero alpha is fully transparent. */
export function blendColours(t: number, a: number[], b: number[]): Colour {
  t = f(t);
  const alpha = f(f(f(f(b[3]) - f(a[3])) * t) + f(a[3]));
  if (alpha === 0) return [0, 0, 0, 0];
  const out: Colour = [0, 0, 0, alpha];
  for (let k = 0; k < 3; k++) {
    const pa = f(f(a[k]) * f(a[3])), pb = f(f(b[k]) * f(b[3]));
    out[k] = f(f(f(f(pb - pa) * t) + pa) / alpha);
  }
  return out;
}

/** The part colour of a tile: the first colour at t = 0, the second at
 *  t = 1, the blend between. */
export function tileColour(t: number, a: number[], b: number[]): Colour {
  t = f(t);
  if (!(t > 0)) return [f(a[0]), f(a[1]), f(a[2]), f(a[3])];
  if (!(t < 1)) return [f(b[0]), f(b[1]), f(b[2]), f(b[3])];
  return blendColours(t, a, b);
}

const clamp01 = (v: number) => {
  const low = v > 0 ? v : 0;
  return low < 1 ? low : 1;
};

// Hue (in sixths), saturation and lightness of the clamped channels.
function toHsl(r: number, g: number, b: number): [number, number, number] {
  r = clamp01(r); g = clamp01(g); b = clamp01(b);
  let max = r > g ? r : g;
  max = max > b ? max : b;
  const min = Math.min(Math.min(r, g), b);
  const d = f(max - min);
  let h: number;
  if (d === 0) h = 0;
  else if (max === r) h = f(f(f(f(g - b) / d) + 6) % 6);
  else if (max === g) h = f(f(f(b - r) / d) + 2);
  else h = f(f(f(r - g) / d) + 4);
  let sum = f(min + max);
  if (sum > 1) sum = f(2 - sum);
  const s = sum === 0 ? 0 : f(f(max - min) / sum);
  const l = f(f(min + max) * 0.5);
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  let h6 = f(h % 6);
  if (!(h6 >= 0)) h6 = f(6 + h6);
  s = clamp01(s); l = clamp01(l);
  const base = l > 0.5 ? f(1 - l) : l;
  const c = f(f(base + base) * s);
  const m2 = f(f(h6 % 2) + -1);
  const x = f(f(1 - (0 > m2 ? f(-m2) : m2)) * c);
  let rgb: [number, number, number];
  if (1 > h6) rgb = [c, x, 0];
  else if (2 > h6) rgb = [x, c, 0];
  else if (3 > h6) rgb = [0, c, x];
  else if (4 > h6) rgb = [0, x, c];
  else if (5 > h6) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = f(l + f(c * -0.5));
  return [f(rgb[0] + m), f(rgb[1] + m), f(m + rgb[2])];
}

/** The top-face lightness shift at t: ((t + t) - 1) * 0.05. */
export function lightnessShift(t: number, scale = 0.05): number {
  t = f(t);
  return f(f(f(t + t) + -1) * f(scale));
}

/** Shift a colour's lightness: taken at half intensity, moved in HSL and
 *  brought back to full intensity. Alpha is kept. */
export function shiftLightness(colour: number[], delta: number): Colour {
  const [h, s, l] = toHsl(f(f(colour[0]) * 0.5), f(f(colour[1]) * 0.5), f(f(colour[2]) * 0.5));
  const [r, g, b] = fromHsl(h, s, f(l + f(delta)));
  return [f(r + r), f(g + g), f(b + b), f(colour[3])];
}

/** Per-build bindings for tile colours. */
export interface TileDecodeData {
  /** Field of a room's owner record holding the room's colour seed: a pair
   *  whose second number is the seed. */
  seed: number;
  /** Blocks whose top faces vary: constructor value holding the record type,
   *  the inclusive type range, and the boolean field that enables it. */
  variation: {typeValue: number; types: [number, number]; flag: number};
  /** The ground record meaning "use the block's own colours". */
  defaultGround: number;
  /** The neutral recolour tint (half range, 0.5 keeps a texture's colour). */
  neutral: [number, number, number, number];
}

export function validTileData(d: any): d is TileDecodeData {
  const index = (v: any) => Number.isInteger(v) && v >= 0 && v < 1 << 30;
  const v = d?.variation;
  return !!d && index(d.seed) && index(d.defaultGround) && !!v && index(v.typeValue) && index(v.flag)
    && Array.isArray(v.types) && v.types.length === 2 && v.types.every(index) && v.types[0] <= v.types[1]
    && Array.isArray(d.neutral) && d.neutral.length === 4 && d.neutral.every((c: any) => Number.isFinite(c));
}

/** How one placed part is coloured: two colours blended per tile, or (the
 *  top faces of varied blocks on a one-pair ground whose colours match) the
 *  first colour with its lightness shifted per tile. Recoloured textures also
 *  take two tints (half range) for their mask channels. */
export interface PartColourRule {
  a: number[];
  b: number[];
  shift: boolean;
  tints: [number[], number[]];
}

/** The part colour at a tile's fraction. */
export function partColour(rule: PartColourRule, t: number): Colour {
  return rule.shift ? shiftLightness(rule.a, lightnessShift(t)) : tileColour(t, rule.a, rule.b);
}

/** A colour's packed vertex bytes: each channel clamped to [0, 1], times
 *  255 in single precision, truncated. */
export function packColour(c: number[]): [number, number, number, number] {
  const byte = (v: number) => Math.trunc(f(Math.min(Math.max(f(v), 0), 1) * 255));
  return [byte(c[0]), byte(c[1]), byte(c[2]), byte(c[3] ?? 1)];
}
