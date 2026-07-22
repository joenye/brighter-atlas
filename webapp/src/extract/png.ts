// Minimal deterministic PNG writer (worker-safe, zlib via vendored fflate).
// 8-bit non-interlaced; filter 0 on every row (deterministic, and the ratio
// is good enough for on-demand browser export).

import { zlibSync } from '../../vendor/fflate.module.js';

// channels -> PNG color type: 1 gray, 2 gray+alpha, 3 RGB, 4 RGBA
const COLOR_TYPE: Record<number, number | undefined> = { 1: 0, 2: 4, 3: 2, 4: 6 };

// Compression level for PNGs served/cached at runtime: sw.js servePng and
// the ingest's world-texture cache pre-warm (jobs.ts). The two MUST stay in
// lockstep so the warm writes byte-identical responses to what sw.js would
// encode on a cache miss. These PNGs never leave the machine (Cache API /
// blob URLs), so encode speed wins: level 1 measured 2.4x faster than the
// old level 6 on real decoded world-texture planes at +13% bytes.
export const SERVED_PNG_LEVEL = 1;

let crcTable: Int32Array | null = null;
function makeCrcTable(): Int32Array {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  crcTable ??= makeCrcTable();
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// One standalone PNG chunk as bytes, for callers assembling PNGs from
// streamed parts (e.g. the viewer's tiled high-res screenshot).
export function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  writeChunk(out, 0, type, data);
  return out;
}

// PNG magic + an IHDR chunk (8-bit, non-interlaced) for streamed assembly.
export function pngHeader(w: number, h: number, channels = 4): Uint8Array<ArrayBuffer>[] {
  const colorType = COLOR_TYPE[channels];
  if (colorType === undefined) throw new Error(`unsupported channel count ${channels}`);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w, false);
  dv.setUint32(4, h, false);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)];
}

// chunk = u32 BE length | 4-char type | data | u32 BE crc(type+data)
function writeChunk(out: Uint8Array, off: number, type: string, data: Uint8Array): number {
  const dv = new DataView(out.buffer, out.byteOffset);
  dv.setUint32(off, data.length, false);
  for (let i = 0; i < 4; i++) out[off + 4 + i] = type.charCodeAt(i);
  out.set(data, off + 8);
  dv.setUint32(off + 8 + data.length, crc32(out, off + 4, off + 8 + data.length), false);
  return off + 12 + data.length;
}

// encodePng(w, h, pixels, {channels?: 1|2|3|4 (default 4), level?: 0-9}) -> Uint8Array
export function encodePng(
  w: number, h: number, pixels: Uint8Array,
  opts: { channels?: number; level?: number } = {},
): Uint8Array<ArrayBuffer> {
  const channels = opts.channels ?? 4;
  const colorType = COLOR_TYPE[channels];
  if (colorType === undefined) throw new Error(`unsupported channel count ${channels}`);
  if (!(w > 0 && h > 0)) throw new Error(`bad dimensions ${w}x${h}`);
  if (pixels.length !== w * h * channels) {
    throw new Error(`pixel buffer ${pixels.length}B != ${w}x${h}x${channels}`);
  }

  const stride = w * channels;
  const filtered = new Uint8Array((stride + 1) * h); // each scanline prefixed by filter byte 0
  for (let y = 0; y < h; y++) {
    filtered.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlibSync(filtered, { level: (opts.level ?? 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 });

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w, false);
  hv.setUint32(4, h, false);
  ihdr[8] = 8;         // bit depth
  ihdr[9] = colorType;
  // [10..12] compression 0, filter 0, interlace 0

  const out = new Uint8Array(8 + 25 + (12 + idat.length) + 12);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
  let off = 8;
  off = writeChunk(out, off, 'IHDR', ihdr);
  off = writeChunk(out, off, 'IDAT', idat);
  writeChunk(out, off, 'IEND', new Uint8Array(0));
  return out;
}

// The decoded-payload Cache API name + size cap, shared by BOTH writers
// (sw.ts on-demand decodes and jobs.ts the worldtex pre-warm) so they can
// never drift apart again. Bump the version whenever any decoder's OUTPUT
// changes OR a caching bug ships: the service worker's activate handler
// deletes every other cache name, so a bump is a clean purge.
// v6: purge caches poisoned by the pre-warm keying PNGs by dense job position
// instead of ab3 ordinal (foreign images shown on low-ordinal containers).
export const DECODED_CACHE = 'bs-decoded-v6';
export const DECODED_CACHE_MAX_BYTES = 24 * 1024 * 1024;
