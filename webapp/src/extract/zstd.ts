// zstd decompression seam. Default engine is the vendored pure-JS fzstd; a
// context can upgrade to WASM libzstd by importing vendor/zstd-wasm.module.js
// itself and calling adoptZstdWasm() after init. Only sw.js does this today:
// its cold texture path decodes big single frames and pays the wasm compile
// ONCE per SW startup. Extraction contexts measured net-NEGATIVE with wasm
// (~10 worker spawns each recompiling the module outweighed the decode wins
// on 2026-07 hardware). Do not re-add init there without re-measuring.
// Whenever the WASM path can't take a call (no adopted impl, frame header
// carries no content size and the caller supplied none, any wasm error),
// fzstd decodes instead. Output bytes are identical either way (zstd
// decoding is deterministic by spec), so callers never see which path ran.
// Also provides a structural (no-decompress) zstd frame walker used to split
// ab3 objects into their concatenated frames + raw metadata tail.

import { decompress } from '../../vendor/fzstd.module.js';

interface ZstdWasmImpl { decompress(u8: Uint8Array, capacity: number): Uint8Array }
let wasm: ZstdWasmImpl | null = null;

// Hand the seam an initialized WASM impl (the vendor module namespace after
// its init() resolved). Keeping the vendor import in the ADOPTING bundle,
// not here, is what keeps the ~334 kB embedded wasm out of every other
// entry point.
export function adoptZstdWasm(impl: ZstdWasmImpl): void { wasm = impl; }

export function zstdDecompress(u8: Uint8Array, expectedSize?: number): Uint8Array {
  if (wasm) {
    try {
      // libzstd needs the output size up front: the caller's expectedSize,
      // else the frame header's content size (present throughout these
      // bundles). Multi-frame inputs whose total exceeds the first frame's
      // size just error into the fzstd path below.
      const capacity = expectedSize ?? zstdContentSize(u8);
      if (capacity !== null && capacity >= 0) {
        const out = wasm.decompress(u8, capacity);
        // with an explicit expectedSize fzstd returns exactly that many
        // bytes; keep the contracts identical by only trusting the WASM
        // result when the sizes agree
        if (expectedSize === undefined || out.length === expectedSize) return out;
      }
    } catch { /* fall through to fzstd */ }
  }
  // fzstd sizes output from the frame header when present (always is in these
  // bundles); expectedSize pre-allocates when the caller knows better.
  return expectedSize ? decompress(u8, new Uint8Array(expectedSize)) : decompress(u8);
}

export const ZSTD_MAGIC = 0xfd2fb528; // LE u32 at frame start (bytes 28 b5 2f fd)

export function isZstdFrame(u8: Uint8Array, off = 0): boolean {
  return off + 4 <= u8.length
    && u8[off] === 0x28 && u8[off + 1] === 0xb5 && u8[off + 2] === 0x2f && u8[off + 3] === 0xfd;
}

// Compressed byte length of the zstd frame starting at `off` (RFC 8878 walk:
// header + block headers; no decompression). Throws on malformed input.
export function zstdFrameSize(u8: Uint8Array, off = 0): number {
  const start = off;
  if (!isZstdFrame(u8, off)) {
    // skippable frame: magic 0x184D2A50..5F, u32 LE size follows
    const m = u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24);
    if ((m & 0xfffffff0) === 0x184d2a50) {
      const size = u8[off + 4] | (u8[off + 5] << 8) | (u8[off + 6] << 16) | (u8[off + 7] << 24);
      return 8 + (size >>> 0);
    }
    throw new Error(`not a zstd frame at ${off}`);
  }
  off += 4;
  const fhd = u8[off]; off += 1;
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const didFlag = fhd & 3;
  if (!singleSegment) off += 1;                       // window descriptor
  off += [0, 1, 2, 4][didFlag];                       // dictionary id
  off += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag];   // frame content size
  for (;;) {                                          // blocks
    const bh = u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16); off += 3;
    const last = bh & 1;
    const type = (bh >> 1) & 3;
    const size = bh >> 3;
    if (type === 3) throw new Error('reserved zstd block type');
    off += type === 1 ? 1 : size;                     // RLE stores one byte
    if (last) break;
  }
  if (checksum) off += 4;
  return off - start;
}

// Decompressed content size from the frame header, or null when not stored.
export function zstdContentSize(u8: Uint8Array, off = 0): number | null {
  if (!isZstdFrame(u8, off)) return null;
  let p = off + 4;
  const fhd = u8[p]; p += 1;
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const didFlag = fhd & 3;
  if (!singleSegment) p += 1;
  p += [0, 1, 2, 4][didFlag];
  const dv = new DataView(u8.buffer, u8.byteOffset);
  if (fcsFlag === 0) return singleSegment ? u8[p] : null;
  if (fcsFlag === 1) return dv.getUint16(p, true) + 256;
  if (fcsFlag === 2) return dv.getUint32(p, true);
  return Number(dv.getBigUint64(p, true));
}
