// Minimal animated-GIF encoder (GIF89a): median-cut 256-colour global palette
// + LZW. Self-contained (no vendored dependency) — built for the video
// wizard's short turntable clips, not general-purpose fidelity.
//
//   encodeGif(frames, width, height, { delayMs, transparent }) -> Uint8Array
//   frames: array of Uint8ClampedArray RGBA (width*height*4)
//
// transparent: 1-bit alpha. Pixels with alpha < ALPHA_CUT become the reserved
// transparent palette index 0; the palette is built from opaque pixels only and
// occupies indices 1..255. (GIF has no partial alpha, so anti-aliased edges get
// a hard cutout — expected.)

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
  { delayMs = 100, delaysMs = null, transparent = false, holdMs = 0 }:
  { delayMs?: number; delaysMs?: number[] | null; transparent?: boolean; holdMs?: number } = {}): Uint8Array<ArrayBuffer> {
  const palette = buildPalette(frames, w, h, transparent);
  const map = makeMapper(palette, transparent ? 1 : 0);
  const out: number[] = [];
  const u16 = (v: number) => { out.push(v & 0xff, (v >> 8) & 0xff); };
  const str = (s: string) => { for (const c of s) out.push(c.charCodeAt(0)); };

  str('GIF89a');
  u16(w); u16(h);
  out.push(0xf7, 0, 0);            // GCT present, 8-bit, 256 entries
  for (const [r, g, b] of palette) out.push(r, g, b);

  // Netscape loop-forever extension
  str('\x21\xFF\x0BNETSCAPE2.0\x03\x01');
  u16(0);
  out.push(0);

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
