// Minimal animated-GIF encoder (GIF89a): median-cut 256-colour global palette
// + LZW. Self-contained (no vendored dependency), built for the video
// wizard's short turntable clips, not general-purpose fidelity.
//
//   encodeGif(frames, width, height, { delayMs, transparent }) -> Uint8Array
//   frames: array of Uint8ClampedArray RGBA (width*height*4)
//
// transparent: 1-bit alpha. Pixels with alpha < ALPHA_CUT become the reserved
// transparent palette index 0; the palette is built from opaque pixels only and
// occupies indices 1..255. (GIF has no partial alpha, so anti-aliased edges get
// a hard cutout, as expected.)

const ALPHA_CUT = 128;

// ---- palette: median cut over a sample of all frames -----------------------

function buildPalette(frames: Uint8ClampedArray[], w: number, h: number, transparent: boolean): number[][] {
  const maxColors = transparent ? 255 : 256;   // reserve index 0 for transparent
  // sample up to ~64k pixels across frames
  const samples: number[][] = [];
  const step = Math.max(1, Math.floor((frames.length * w * h) / 65536));
  let k = 0;
  for (const f of frames) {
    for (let p = 0; p < w * h; p++, k++) {
      if (k % step) continue;
      const o = p * 4;
      if (transparent && f[o + 3] < ALPHA_CUT) continue;   // don't let transparent px pollute the palette
      samples.push([f[o], f[o + 1], f[o + 2]]);
    }
  }
  if (!samples.length) samples.push([0, 0, 0]);

  // median cut to maxColors boxes
  let boxes: number[][][] = [samples];
  while (boxes.length < maxColors) {
    // split the box with the largest channel range
    let bi = -1, bc = -1, br = -1;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const px of box) { if (px[c] < lo) lo = px[c]; if (px[c] > hi) hi = px[c]; }
        if (hi - lo > br) { br = hi - lo; bi = i; bc = c; }
      }
    });
    if (bi < 0) break;
    const box = boxes[bi];
    box.sort((a, b) => a[bc] - b[bc]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  const colors = boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    for (const px of box) { r += px[0]; g += px[1]; b += px[2]; }
    const n = Math.max(1, box.length);
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
  while (colors.length < maxColors) colors.push([0, 0, 0]);
  // index 0 is the transparent sentinel; opaque colours fill 1..255
  const palette = transparent ? [[0, 0, 0], ...colors] : colors;
  return palette;
}

// nearest-palette lookup with a 5-bit/channel cache. startIdx skips the reserved
// transparent index 0, so opaque pixels never snap to the transparent colour.
function makeMapper(palette: number[][], startIdx = 0): (r: number, g: number, b: number) => number {
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = cache[key];
    if (idx >= 0) return idx;
    let best = startIdx, bd = Infinity;
    for (let i = startIdx; i < palette.length; i++) {
      const p = palette[i];
      const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    cache[key] = best;
    return best;
  };
}

// ---- LZW --------------------------------------------------------------------

function lzwEncode(indices: Uint8Array, minCodeSize: number, out: number[]): void {
  const CLEAR = 1 << minCodeSize;
  const EOI = CLEAR + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map<number, number>();
  let nextCode = EOI + 1;
  const reset = () => { dict = new Map(); nextCode = EOI + 1; codeSize = minCodeSize + 1; };

  // bit writer into 255-byte sub-blocks
  let cur = 0, curBits = 0;
  const bytes: number[] = [];
  const emit = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) { bytes.push(cur & 0xff); cur >>= 8; curBits -= 8; }
  };

  reset();
  emit(CLEAR);
  let prefix: number = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    dict.set(key, nextCode);
    if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    nextCode++;
    if (nextCode >= 4096) { emit(CLEAR); reset(); }
    prefix = k;
  }
  emit(prefix);
  emit(EOI);
  if (curBits > 0) bytes.push(cur & 0xff);

  out.push(minCodeSize);
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    out.push(n);
    for (let j = 0; j < n; j++) out.push(bytes[i + j]);
  }
  out.push(0);   // block terminator
}

// ---- container --------------------------------------------------------------

export function encodeGif(frames: Uint8ClampedArray[], w: number, h: number,
  { delayMs = 100, delaysMs = null, transparent = false, holdMs = 0, once = false }:
  { delayMs?: number; delaysMs?: number[] | null; transparent?: boolean; holdMs?: number; once?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const palette = buildPalette(frames, w, h, transparent);
  const map = makeMapper(palette, transparent ? 1 : 0);
  const out: number[] = [];
  const u16 = (v: number) => { out.push(v & 0xff, (v >> 8) & 0xff); };
  const str = (s: string) => { for (const c of s) out.push(c.charCodeAt(0)); };

  str('GIF89a');
  u16(w); u16(h);
  out.push(0xf7, 0, 0);            // GCT present, 8-bit, 256 entries
  for (const [r, g, b] of palette) out.push(r, g, b);

  // Netscape loop-forever extension (left out to play once)
  if (!once) {
    str('\x21\xFF\x0BNETSCAPE2.0\x03\x01');
    u16(0);
    out.push(0);
  }

  // per-frame delay in centiseconds: delaysMs (measured capture spacing, so a
  // slow capture stays real-time) when given, else the uniform delayMs
  const delayFor = (fi: number) => Math.max(2, Math.round((delaysMs?.[fi] ?? delayMs) / 10));
  // hold the LAST frame longer so a non-looping animation doesn't snap back
  const lastDelay = (fi: number) => Math.min(65535, Math.max(delayFor(fi), Math.round(((delaysMs?.[fi] ?? delayMs) + holdMs) / 10)));
  // packed field: transparent -> disposal=2 (restore to bg) + transparent flag
  const gce = transparent ? 0x09 : 0x00;
  const idx = new Uint8Array(w * h);
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    // graphic control extension
    out.push(0x21, 0xf9, 4, gce);
    u16(fi === frames.length - 1 ? lastDelay(fi) : delayFor(fi));
    out.push(0, 0);                 // transparent colour index 0, block terminator
    // image descriptor
    out.push(0x2c);
    u16(0); u16(0); u16(w); u16(h);
    out.push(0);                    // no local palette
    for (let p = 0, o = 0; p < w * h; p++, o += 4) {
      idx[p] = (transparent && f[o + 3] < ALPHA_CUT) ? 0 : map(f[o], f[o + 1], f[o + 2]);
    }
    lzwEncode(idx, 8, out);
  }
  out.push(0x3b);                   // trailer
  return new Uint8Array(out);
}

// ---- streaming: frames encoded as they come, each with a palette of its own -------
// (for long or large recordings: no frame is kept once written, and a frame's own palette keeps colours that first
// appear late, a particle effect's, that a palette from the first frame would miss)
class Bytes {
  private buf = new Uint8Array(1 << 20); n = 0;
  private room(k: number) { if (this.n + k <= this.buf.length) return; const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf.subarray(0, this.n)); this.buf = b; }
  push(...v: number[]) { this.room(v.length); for (const x of v) this.buf[this.n++] = x; }
  append(v: number[]) { this.room(v.length); for (let i = 0; i < v.length; i++) this.buf[this.n++] = v[i]; }
  set(at: number, v: number) { this.buf[at] = v; }
  done() { return this.buf.slice(0, this.n); }
}
/** One palette for a whole GIF, from a few of its frames (small copies will do): every frame coloured the same way, so
 *  nothing shimmers from one to the next. */
export function gifPalette(frames: Uint8ClampedArray[], w: number, h: number, transparent = false): number[][] {
  return buildPalette(frames, w, h, transparent);
}
/** A GIF's opening bytes: its size, its palette (none: each frame has its own) and (unless `once`) the block that
 *  loops it. */
export function gifHead(w: number, h: number, once = false, palette: number[][] | null = null): Uint8Array {
  const out = new Bytes(), str = (t: string) => { for (const c of t) out.push(c.charCodeAt(0)); };
  str('GIF89a');
  out.push(w & 0xff, w >> 8, h & 0xff, h >> 8, palette ? 0xf7 : 0x70, 0, 0);
  if (palette) for (let i = 0; i < 256; i++) { const c = palette[i] ?? [0, 0, 0]; out.push(c[0], c[1], c[2]); }
  if (!once) { str('\x21\xFF\x0BNETSCAPE2.0\x03\x01'); out.push(0, 0, 0); }
  return out.done();
}
/** GIF frames, each encoded on its own (so several encoders can share a recording): its timing, a palette of its own
 *  (made again every few frames, reused between with its colour cache) and its pixels. The frame's delay is at bytes
 *  4 and 5 of what `frame` returns. */
export class GifFrames {
  private idx: Uint8Array; private palette: number[][] = []; private map: ((r: number, g: number, b: number) => number) | null = null; private n = 0;
  /** `palette`: the GIF's own (gifPalette), used for every frame; none: a palette of each frame's own. */
  constructor(private w: number, private h: number, private o: {delayMs: number, transparent?: boolean, palette?: number[][] | null}) {
    this.idx = new Uint8Array(w * h);
    if (o.palette) { this.palette = o.palette; this.map = makeMapper(o.palette, o.transparent ? 1 : 0); }
  }
  frame(f: Uint8ClampedArray): Uint8Array {
    const {w, h, idx} = this, transparent = !!this.o.transparent, out = new Bytes(), delay = Math.max(2, Math.round(this.o.delayMs / 10));
    const own = !this.o.palette;
    if (own && (!this.map || this.n++ % 8 === 0)) { this.palette = buildPalette([f], w, h, transparent); this.map = makeMapper(this.palette, transparent ? 1 : 0); }
    const palette = this.palette, map = this.map!;
    out.push(0x21, 0xf9, 4, transparent ? 0x09 : 0x00, delay & 0xff, delay >> 8, 0, 0);
    out.push(0x2c, 0, 0, 0, 0, w & 0xff, w >> 8, h & 0xff, h >> 8, own ? 0x87 : 0);   // (a local palette of 256, or the GIF's)
    if (own) for (let i = 0; i < 256; i++) { const c = palette[i] ?? [0, 0, 0]; out.push(c[0], c[1], c[2]); }
    for (let p = 0, o = 0; p < w * h; p++, o += 4) idx[p] = (transparent && f[o + 3] < ALPHA_CUT) ? 0 : map(f[o], f[o + 1], f[o + 2]);
    const bytes: number[] = [];
    lzwEncode(idx, 8, bytes);
    out.append(bytes);
    return out.done();
  }
}
/** A GIF from its head and frames in order, the last held `holdMs` longer. */
export function gifJoin(head: Uint8Array, frames: Uint8Array[], delayMs: number, holdMs = 0): Blob {
  const last = frames.at(-1);
  if (last && holdMs) { const d = Math.min(65535, Math.max(2, Math.round(delayMs / 10)) + Math.round(holdMs / 10)); last[4] = d & 0xff; last[5] = d >> 8; }
  return new Blob([head, ...frames, new Uint8Array([0x3b])] as BlobPart[], {type: 'image/gif'});
}
