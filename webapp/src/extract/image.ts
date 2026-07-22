// ab3 image decode + the images index logic. Worker-safe: typed arrays only,
// no DOM/Node.
//
// ab3 object := [zstd frame 0]..[zstd frame m-1][13*m-byte metadata tail]
// 13-byte BE record: u8 format | u16 w | u16 h | u32 frame offset | u32 frame
// size (a seek table). BC blocks are stored PLANAR: each block field is its
// own contiguous stream (zstd-friendlier than the DDS interleave).
// Decoders reproduce bcdec.c integer math (UNORM) and IEEE-754 float32 math
// (BC5-SNORM) bit-exactly.

import { splitAb3 } from './bundles.js';
import { zstdDecompress } from './zstd.js';
import { resolveRoles } from '../texture-roles.js';

export interface ImageMeta {
  fmt: number; w: number; h: number; frameOffset: number; frameSize: number;
}
export interface DatafileRecord { fmt: number; dimA: number; dimB: number }
export interface GlyphImage {
  e: number; w: number; h: number; channels: number; pixels: Uint8Array;
}

export const FORMATS: Record<number, { name: string; bdim: number; bsize: number }> = {
  0x16: { name: 'rgba8', bdim: 1, bsize: 4 },  // raw RGBA8, "block" = 1px/4B
  0x22: { name: 'bc4', bdim: 4, bsize: 8 },    // 1 channel (gray/mask), UNORM
  0x24: { name: 'bc5la', bdim: 4, bsize: 16 }, // 2 channels: ch0=gray, ch1=alpha, UNORM
  0x25: { name: 'bc5s', bdim: 4, bsize: 16 },  // 2 channels: XY of normal map, SNORM
  0x26: { name: 'bc1', bdim: 4, bsize: 8 },    // RGB + 1-bit punch-through alpha
  0x28: { name: 'bc3', bdim: 4, bsize: 16 },   // RGBA
};

// index-catalog names (images.json entries[].fmt)
export const FMT_NAMES: Record<number, string> = {
  0x16: 'RGBA8', 0x22: 'BC4', 0x24: 'BC5LA', 0x25: 'BC5S', 0x26: 'BC1', 0x28: 'BC3',
};

// ------------------------------------------------------------------ metadata

// 13-byte BE records from the raw (uncompressed) object tail.
export function parseImageMeta(tail: Uint8Array): ImageMeta[] {
  if (tail.length % 13) throw new Error(`metadata tail ${tail.length}B is not a multiple of 13`);
  const n = tail.length / 13;
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const out = new Array<ImageMeta>(n);
  for (let k = 0; k < n; k++) {
    const o = 13 * k;
    out[k] = {
      fmt: dv.getUint8(o),
      w: dv.getUint16(o + 1, false),
      h: dv.getUint16(o + 3, false),
      frameOffset: dv.getUint32(o + 5, false),
      frameSize: dv.getUint32(o + 9, false),
    };
  }
  return out;
}

// ------------------------------------------------------------------ decoders

const fr = Math.fround;

// BC4-style smooth channel palette (8 entries) -> pal (Uint8Array(8)).
// UNORM reproduces bcdec.c integer rounding exactly.
function bcAlphaPaletteUnorm(e0: number, e1: number, pal: Uint8Array): void {
  pal[0] = e0;
  pal[1] = e1;
  const gt = e0 > e1;
  for (let j = 0; j < 6; j++) {
    if (gt) pal[2 + j] = ((e0 * (6 - j) + e1 * (1 + j) + 1) / 7) | 0;       // 8-value mode
    else if (j < 4) pal[2 + j] = ((e0 * (4 - j) + e1 * (1 + j) + 1) / 5) | 0; // 6-value mode
    else pal[2 + j] = j === 4 ? 0 : 255;
  }
}

// SNORM decodes s8 endpoints to [-1,1] in float32 (fround after every op is
// exact: double->float32 double rounding is safe for +,*,/,sqrt).
const snormScratch = new Float32Array(8);
function bcAlphaPaletteSnorm(b0: number, b1: number, pal: Uint8Array): void {
  const s0 = (b0 << 24) >> 24, s1 = (b1 << 24) >> 24; // sign-extend to int8
  const e0 = Math.max(fr(s0 / 127), -1);
  const e1 = Math.max(fr(s1 / 127), -1);
  const gt = s0 > s1;
  const pf = snormScratch;
  pf[0] = e0;
  pf[1] = e1;
  for (let j = 0; j < 6; j++) {
    if (gt) pf[2 + j] = fr(fr(fr(e0 * (6 - j)) + fr(e1 * (1 + j))) / 7);       // 8-value mode
    else if (j < 4) pf[2 + j] = fr(fr(fr(e0 * (4 - j)) + fr(e1 * (1 + j))) / 5); // 6-value mode
    else pf[2 + j] = j === 4 ? -1 : 1;
  }
  for (let j = 0; j < 8; j++) { // [-1,1] -> u8 via truncating cast
    let v = fr(fr(fr(fr(pf[j] + 1) * 0.5) * 255) + 0.5);
    if (v < 0) v = 0; else if (v > 255) v = 255;
    pal[j] = Math.floor(v);
  }
}

// BC1 color palettes (4 entries per channel). Reproduces bcdec.c integer math.
function bc1Palette(
  d: Uint8Array, o: number, opaque: boolean,
  pr: Uint8Array, pg: Uint8Array, pb: Uint8Array, pa: Uint8Array,
): void {
  const c0 = d[o] | (d[o + 1] << 8);      // two LE RGB565 endpoints
  const c1 = d[o + 2] | (d[o + 3] << 8);
  const r0 = (c0 >> 11) & 31, g0 = (c0 >> 5) & 63, b0 = c0 & 31;
  const r1 = (c1 >> 11) & 31, g1 = (c1 >> 5) & 63, b1 = c1 & 31;
  pr[0] = (r0 * 527 + 23) >> 6; pg[0] = (g0 * 259 + 33) >> 6; pb[0] = (b0 * 527 + 23) >> 6;
  pr[1] = (r1 * 527 + 23) >> 6; pg[1] = (g1 * 259 + 33) >> 6; pb[1] = (b1 * 527 + 23) >> 6;
  pa[0] = pa[1] = pa[2] = 255;
  if (c0 > c1 || opaque) { // 4-color mode (BC3's color block is always 4-color)
    pr[2] = ((2 * r0 + r1) * 351 + 61) >> 7;
    pg[2] = ((2 * g0 + g1) * 2763 + 1039) >> 11;
    pb[2] = ((2 * b0 + b1) * 351 + 61) >> 7;
    pr[3] = ((r0 + 2 * r1) * 351 + 61) >> 7;
    pg[3] = ((g0 + 2 * g1) * 2763 + 1039) >> 11;
    pb[3] = ((b0 + 2 * b1) * 351 + 61) >> 7;
    pa[3] = 255;
  } else {                 // 3-color + punch-through transparent black
    pr[2] = ((r0 + r1) * 1053 + 125) >> 8;
    pg[2] = ((g0 + g1) * 4145 + 1019) >> 11;
    pb[2] = ((b0 + b1) * 1053 + 125) >> 8;
    pr[3] = pg[3] = pb[3] = pa[3] = 0;
  }
}

// z(x,y) of a BC5-SNORM normal map depends only on the two decoded bytes, so a
// 64K LUT keeps the per-pixel float32 sqrt out of the hot loop, bit-exactly.
let zLut: Uint8Array | null = null;
function snormZLut(): Uint8Array {
  const lut = new Uint8Array(65536);
  for (let a = 0; a < 256; a++) {
    const x = fr(fr(a / 127.5) - 1);
    const oneMinusXx = fr(1 - fr(x * x));
    for (let b = 0; b < 256; b++) {
      const y = fr(fr(b / 127.5) - 1);
      let t = fr(oneMinusXx - fr(y * y));
      if (t < 0) t = 0; else if (t > 1) t = 1;
      let v = fr(fr(fr(Math.sqrt(t)) * 127.5) + 127.5);
      if (v < 0) v = 0; else if (v > 255) v = 255;
      lut[(a << 8) | b] = Math.floor(v);
    }
  }
  return lut;
}

// 3-bit selectors of one BC4/BC5 index field (6 bytes) as two 24-bit halves
// (avoids BigInt in the hot loop). p<8 from lo, p>=8 from hi.
function alphaSelHalves(d: Uint8Array, o: number): [number, number] {
  return [d[o] | (d[o + 1] << 8) | (d[o + 2] << 16),
          d[o + 3] | (d[o + 4] << 8) | (d[o + 5] << 16)];
}

// Decode one sub-image -> { w, h, rgba } (RGBA8, h rows of w).
// Integer/float32-exact.
export function decodeSubImage(
  meta: { fmt: number; w: number; h: number }, data: Uint8Array,
): { w: number; h: number; rgba: Uint8Array } {
  const { fmt, w, h } = meta;
  const info = FORMATS[fmt];
  if (!info) throw new Error(`unknown image format 0x${fmt.toString(16)}`);
  const nb = Math.floor(w / info.bdim) * Math.floor(h / info.bdim);
  if (data.length !== nb * info.bsize) {
    throw new Error(`size mismatch: fmt 0x${fmt.toString(16)} ${w}x${h} needs ` +
      `${nb * info.bsize} bytes, frame has ${data.length}`);
  }
  if (fmt === 0x16) return { w, h, rgba: data.slice() };

  const rgba = new Uint8Array(w * h * 4);
  const bw = w >> 2; // blocks per row; BC dims are always multiples of 4
  const pr = new Uint8Array(4), pg = new Uint8Array(4);
  const pb = new Uint8Array(4), pa = new Uint8Array(4);
  const p0 = new Uint8Array(8), p1 = new Uint8Array(8);

  for (let b = 0; b < nb; b++) {
    const bx = b % bw, by = (b / bw) | 0;
    const rowBase = (by * 4 * w + bx * 4) * 4;

    if (fmt === 0x26 || fmt === 0x28) {
      // color block: BC1 planar [colors 4B/blk][indices 4B/blk];
      // BC3 planar [a_ep 2][c_ep 4][a_idx 6][c_idx 4] (at S/8 multiples)
      const cEp = fmt === 0x26 ? 4 * b : 2 * nb + 4 * b;
      const cIx = fmt === 0x26 ? 4 * nb + 4 * b : 12 * nb + 4 * b;
      bc1Palette(data, cEp, fmt === 0x28, pr, pg, pb, pa);
      const v = data[cIx] | (data[cIx + 1] << 8) | (data[cIx + 2] << 16) | (data[cIx + 3] << 24);
      let aLo = 0, aHi = 0;
      if (fmt === 0x28) {
        bcAlphaPaletteUnorm(data[2 * b], data[2 * b + 1], p0);
        [aLo, aHi] = alphaSelHalves(data, 6 * nb + 6 * b);
      }
      for (let p = 0; p < 16; p++) {
        const sel = (v >>> (2 * p)) & 3;
        const o = rowBase + ((p >> 2) * w + (p & 3)) * 4;
        rgba[o] = pr[sel]; rgba[o + 1] = pg[sel]; rgba[o + 2] = pb[sel];
        rgba[o + 3] = fmt === 0x28
          ? p0[(p < 8 ? (aLo >>> (3 * p)) : (aHi >>> (3 * (p - 8)))) & 7]
          : pa[sel];
      }
      continue;
    }

    if (fmt === 0x22) { // BC4 planar: [ep 2B/blk][idx 6B/blk]; gray replicated
      bcAlphaPaletteUnorm(data[2 * b], data[2 * b + 1], p0);
      const [lo, hi] = alphaSelHalves(data, 2 * nb + 6 * b);
      for (let p = 0; p < 16; p++) {
        const g = p0[(p < 8 ? (lo >>> (3 * p)) : (hi >>> (3 * (p - 8)))) & 7];
        const o = rowBase + ((p >> 2) * w + (p & 3)) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = 255;
      }
      continue;
    }

    // 0x24 / 0x25: BC5 planar: [ep0 2][ep1 2][idx0 6][idx1 6] (at S/8 multiples)
    const snorm = fmt === 0x25;
    if (snorm) {
      bcAlphaPaletteSnorm(data[2 * b], data[2 * b + 1], p0);
      bcAlphaPaletteSnorm(data[2 * nb + 2 * b], data[2 * nb + 2 * b + 1], p1);
      if (!zLut) zLut = snormZLut();
    } else {
      bcAlphaPaletteUnorm(data[2 * b], data[2 * b + 1], p0);
      bcAlphaPaletteUnorm(data[2 * nb + 2 * b], data[2 * nb + 2 * b + 1], p1);
    }
    const [lo0, hi0] = alphaSelHalves(data, 4 * nb + 6 * b);
    const [lo1, hi1] = alphaSelHalves(data, 10 * nb + 6 * b);
    for (let p = 0; p < 16; p++) {
      const c0 = p0[(p < 8 ? (lo0 >>> (3 * p)) : (hi0 >>> (3 * (p - 8)))) & 7];
      const c1 = p1[(p < 8 ? (lo1 >>> (3 * p)) : (hi1 >>> (3 * (p - 8)))) & 7];
      const o = rowBase + ((p >> 2) * w + (p & 3)) * 4;
      if (snorm) { // normal map: R=X, G=Y, B=reconstructed Z
        rgba[o] = c0; rgba[o + 1] = c1; rgba[o + 2] = zLut![(c0 << 8) | c1]; rgba[o + 3] = 255;
      } else {     // gray + alpha mask
        rgba[o] = rgba[o + 1] = rgba[o + 2] = c0; rgba[o + 3] = c1;
      }
    }
  }
  return { w, h, rgba };
}

// Parameter-blue cutout is deliberately population-gated. All-zero packed
// planes are common and mean "unused", not fully transparent; all-255 means
// opaque. Only a plane containing both populations is coverage. The operation
// mirrors World3D: combine with (never replace) any authored albedo alpha.
export function applyParameterBlueCutout(
  albedoRgba: Uint8Array | null | undefined, packedRgba: Uint8Array | null | undefined,
): boolean {
  if (!(albedoRgba instanceof Uint8Array) || !(packedRgba instanceof Uint8Array)
      || albedoRgba.length !== packedRgba.length || albedoRgba.length % 4) return false;
  let minBlue = 255;
  let maxBlue = 0;
  for (let offset = 2; offset < packedRgba.length; offset += 4) {
    const value = packedRgba[offset];
    if (value < minBlue) minBlue = value;
    if (value > maxBlue) maxBlue = value;
  }
  if (minBlue >= 16 || maxBlue <= 239) return false;
  for (let offset = 3; offset < albedoRgba.length; offset += 4) {
    albedoRgba[offset] = Math.min(albedoRgba[offset], packedRgba[offset - 1]);
  }
  return true;
}

// Apply the first qualifying same-size post-anchor BC1/BC3 plane. Twelve-plane
// materials can have a cutout plane followed by a distinct recolour plane, so
// looking only at resolveRoles().parameter loses foliage silhouettes.
export function applyMaterialCutout(
  metaList: ImageMeta[] | null | undefined,
  decodedRgba: Record<number, Uint8Array> | null | undefined,
): number | null {
  const roles = resolveRoles({ entries: metaList });
  const albedoMeta = metaList?.[roles.albedo as number];
  const albedo = decodedRgba?.[roles.albedo as number];
  if (!albedoMeta || !albedo) return null;
  for (const index of roles.parameters) {
    const meta = metaList![index];
    if (!meta || meta.w !== albedoMeta.w || meta.h !== albedoMeta.h) continue;
    if (applyParameterBlueCutout(albedo, decodedRgba![index])) return index;
  }
  return null;
}

// -------------------------------------------------------------- categorizing

// Group sub-images into chains (mip runs): a sub continues the chain when it
// has the same format and ~2x (or ~0.5x) the previous dims.
export function detectChains(metaList: ImageMeta[]): number[] {
  const chains = [];
  let cur = -1;
  let prev = null;
  for (const m of metaList) {
    let cont = false;
    if (prev && prev.fmt === m.fmt && prev.w && prev.h) {
      const r = Math.sqrt((m.w / prev.w) * (m.h / prev.h));
      cont = (r >= 1.7 && r <= 2.35) || (r >= 0.42 && r <= 0.59);
    }
    cur = cont ? cur : cur + 1;
    chains.push(cur);
    prev = m;
  }
  return chains;
}

// 18 BC1 subs in 3 groups of 6 equal dims = cubemap face set with 3 mip tiers.
export function isSkybox(metaList: ImageMeta[]): boolean {
  if (metaList.length !== 18) return false;
  if (!metaList.every((m) => m.fmt === 0x26)) return false;
  for (let g = 0; g < 3; g++) {
    const first = metaList[g * 6];
    for (let k = 1; k < 6; k++) {
      const m = metaList[g * 6 + k];
      if (m.w !== first.w || m.h !== first.h) return false;
    }
  }
  return true;
}

// sub-image count (+formats) -> catalog category.
export function category(metaList: ImageMeta[]): string {
  const n = metaList.length;
  if (isSkybox(metaList)) return 'skybox';
  if (n <= 2) return 'misc';
  if (n === 3) return 'sprite';
  if (n === 5 || n === 7) return 'sprite_lod';
  if (n === 6) return metaList.some((m) => m.fmt === 0x25) ? 'material' : 'sprite_pair';
  return 'material';
}

// ---------------------------------------------------- data files (font/LUT)

// 5-byte record tail of a flags=1 data file: {u8 fmt, u8 0, u8 dimA, u8 0,
// u8 dimB}; bitmap k is dimA*dimB bytes. Returns null unless the zero pads
// hold AND the bitmap sizes sum exactly to the payload before the tail.
function readDatafileRecords(d: Uint8Array, n: number): DatafileRecord[] | null {
  const base = d.length - 5 * n;
  const recs = new Array<DatafileRecord>(n);
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const o = base + 5 * k;
    if (d[o + 1] || d[o + 3]) return null;
    recs[k] = { fmt: d[o], dimA: d[o + 2], dimB: d[o + 4] };
    sum += d[o + 2] * d[o + 4];
  }
  return sum === base ? recs : null;
}

// Trust the ab0 texture_dir count first, fall back to a search (n is not
// stored in the payload itself: it lives in ab0).
export function parseDatafileRecords(d: Uint8Array, nHint = 0, maxN = 8192): DatafileRecord[] {
  if (nHint > 0 && 5 * nHint <= d.length) {
    const recs = readDatafileRecords(d, nHint);
    if (recs) return recs;
  }
  const lim = Math.min(maxN, Math.floor(d.length / 5));
  for (let n = 1; n <= lim; n++) {
    const recs = readDatafileRecords(d, n);
    if (recs) return recs;
  }
  throw new Error('unrecognized data-file framing');
}

// One images.json index record ({cat, n, entries}) from the RAW ab3 object
// bytes + its ab0 texture_dir entry ([flags, n] or {flags, n}):
//   flags=0, n>0 -> image: parse the last 13n RAW bytes (no decompression),
//                   cat from category(); entries [{fmt name, w, h}].
//   flags=1      -> data file: decompress frame 0, count tail records;
//                   cat lut (all recs fmt 0x02) or font; n = record count.
//   otherwise    -> empty placeholder. Any parse failure -> cat 'error'.
export function categorize(
  raw: Uint8Array, textureDirEntry: [number, number] | { flags: number; n: number },
): { cat: string; n: number; entries: { fmt: string; w: number; h: number }[] } {
  const flags = Array.isArray(textureDirEntry) ? textureDirEntry[0] : textureDirEntry.flags;
  const n = Array.isArray(textureDirEntry) ? textureDirEntry[1] : textureDirEntry.n;
  const entry: { cat: string; n: number; entries: { fmt: string; w: number; h: number }[] } =
    { cat: 'empty', n, entries: [] };
  try {
    if (flags === 0 && n > 0) {
      // Byte-true parse: the object's own zstd sub-frame count is the
      // authority, and the datatable's n must agree with it. Slicing the
      // tail by a trusted n would silently produce misaligned (impostor)
      // entries whenever the bundle does not belong with this datatable
      // (mixed game versions), while the payload decoder splits byte-true,
      // so the index and the rendered pixels would disagree.
      const { frames, tail } = splitAb3(raw);
      if (frames.length !== n) {
        throw new Error(`object has ${frames.length} sub-frames but the datatable expects ${n}`);
      }
      if (tail.length !== 13 * n) throw new Error('metadata tail does not match the sub-frame count');
      const ml = parseImageMeta(tail);
      if (ml.some((m) => !FORMATS[m.fmt])) throw new Error('bad format enum in metadata tail');
      entry.cat = category(ml);
      entry.entries = ml.map((m) => ({ fmt: FMT_NAMES[m.fmt], w: m.w, h: m.h }));
    } else if (flags === 1) {
      const { frames } = splitAb3(raw);
      if (!frames.length) throw new Error('data file has no zstd frame');
      const recs = parseDatafileRecords(zstdDecompress(frames[0]), n);
      entry.cat = recs.every((r) => r.fmt === 0x02) ? 'lut' : 'font';
      entry.n = recs.length;
    }
  } catch {
    entry.cat = 'error'; // catalog stays usable despite one bad object
  }
  return entry;
}

// Font glyph bank -> [{e, w, h, channels, pixels}] (channels 1 = grayscale,
// 4 = RGBA). e is the RECORD index: files are named NNNNN_e<K>.png and empty
// glyphs are skipped, so e values may be non-contiguous.
// fmt 0x28 with 4-aligned dims is a planar-BC3 color icon; everything else is
// an A8 glyph stored rotated 90° CW (dimA = glyph height = stored row length),
// displayed via transpose + vertical flip.
export function decodeFontGlyphs(d: Uint8Array, recs: DatafileRecord[]): GlyphImage[] {
  const out = [];
  let off = 0;
  for (let k = 0; k < recs.length; k++) {
    const { fmt, dimA, dimB } = recs[k];
    const size = dimA * dimB;
    const chunk = d.subarray(off, off + size);
    off += size;
    if (!chunk.length) continue; // empty glyph: no pixels, no file
    if (fmt === 0x28 && dimA % 4 === 0 && dimB % 4 === 0) {
      const { rgba } = decodeSubImage({ fmt: 0x28, w: dimA, h: dimB }, chunk);
      out.push({ e: k, w: dimA, h: dimB, channels: 4, pixels: rgba });
    } else {
      const g = new Uint8Array(size); // out[r][c] = stored[c][dimA-1-r]
      for (let r = 0; r < dimA; r++) {
        for (let c = 0; c < dimB; c++) g[r * dimB + c] = chunk[c * dimA + (dimA - 1 - r)];
      }
      out.push({ e: k, w: dimB, h: dimA, channels: 1, pixels: g });
    }
  }
  return out;
}

// LUT table -> ONE grayscale image (the single NNNNN_e0.png):
// one row per 16-byte record, rows zero-padded to the widest record.
export function decodeLut(d: Uint8Array, recs: DatafileRecord[]): GlyphImage {
  let width = 0;
  for (const r of recs) width = Math.max(width, r.dimA * r.dimB);
  const g = new Uint8Array(recs.length * width);
  let off = 0;
  for (let k = 0; k < recs.length; k++) {
    const size = recs[k].dimA * recs[k].dimB;
    g.set(d.subarray(off, off + size), k * width);
    off += size;
  }
  return { e: 0, w: width, h: recs.length, channels: 1, pixels: g };
}
