// Content hashing rules:
//   h = sha256 hex, first 16 chars, of the DECOMPRESSED object content:
//     ab1/4/5/6/7: decompressed object bytes
//     ab3:         metadata tail + all decompressed sub-frames, concatenated
//     ab8:         raw object bytes (audio is not zstd-wrapped)
// Whole-bundle identity = full sha256 hex of the raw file bytes.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += HEX[u8[i]];
  return s;
}

// decoded = Uint8Array | { tail, subs } (the decodeObject() shapes)
export async function hashObject(
  decoded: Uint8Array | { tail: Uint8Array; subs: Uint8Array[] },
): Promise<string> {
  let bytes: Uint8Array;
  if (decoded instanceof Uint8Array) {
    bytes = decoded;
  } else {
    let total = decoded.tail.length;
    for (const s of decoded.subs) total += s.length;
    bytes = new Uint8Array(total);
    bytes.set(decoded.tail, 0);
    let off = decoded.tail.length;
    for (const s of decoded.subs) { bytes.set(s, off); off += s.length; }
  }
  // digest() snapshots its BufferSource SYNCHRONOUSLY (WebIDL "get a copy of
  // the bytes held by the buffer source" runs before the promise is returned),
  // and it respects a view's byteOffset/byteLength, so a subarray view hashes
  // exactly its own bytes with no re-slice copy and no exposure to any later
  // write into the backing buffer. The old defensive slice was pure cost.
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return toHex(digest).slice(0, 16);
}

// Synthetic content id for strings: sha256/16 of the UTF-8 text. Strings live
// inside ab0 (no per-object frame), so this synthesised h unifies them with
// every other category's hash-keyed machinery (names, diffing by text).
// Synchronous on purpose: 48k awaits would dominate ingest.
const utf8enc = new TextEncoder();
export function hashText(text: string): string {
  const digest = new Sha256().update(utf8enc.encode(text)).digest();
  let s = '';
  for (let i = 0; i < 8; i++) s += HEX[digest[i]];
  return s;
}

// Full sha256 of a Blob, streamed in chunks to bound memory. Identity must
// equal `sha256sum file`, and WebCrypto has no incremental API: read into one
// buffer when moderately sized (native digest runs off-thread and concurrent
// across bundles, while the JS stream serializes them all on the ingest thread);
// only the two giant bundles fall back to the JS SHA-256 stream.
// memory ceiling for the native one-shot digest path; above it the JS stream
// takes over (pool.js poolHashBlob moves that stream off the ingest thread)
export const HASH_ONE_SHOT = 128 * 1024 * 1024;

export async function hashBlob(
  blob: Blob, onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const CHUNK = 32 * 1024 * 1024;
  if (blob.size <= HASH_ONE_SHOT) {
    return toHex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  }
  const sha = new Sha256();
  for (let off = 0; off < blob.size; off += CHUNK) {
    sha.update(new Uint8Array(await blob.slice(off, Math.min(off + CHUNK, blob.size)).arrayBuffer()));
    onProgress?.(Math.min(off + CHUNK, blob.size), blob.size);
  }
  return toHex(sha.digest());
}

// ---- minimal streaming SHA-256 (FIPS 180-4), used only for whole-file hashes
// where WebCrypto's one-shot API would need the entire file in memory. ~100 MB/s
// in modern JITs, fine for a one-time ingest of ~1 GB.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  h: Uint32Array;
  buf: Uint8Array;
  bufLen: number;
  lenLo: number;
  lenHi: number;
  w: Uint32Array;

  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.lenLo = 0; this.lenHi = 0;
    this.w = new Uint32Array(64);
  }

  update(data: Uint8Array): this {
    const lo = this.lenLo + data.length;
    this.lenHi += (lo / 0x100000000) | 0;
    this.lenLo = lo >>> 0;
    let off = 0;
    if (this.bufLen) {
      const need = 64 - this.bufLen;
      const take = Math.min(need, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take; off = take;
      if (this.bufLen === 64) { this._block(this.buf, 0); this.bufLen = 0; }
    }
    while (off + 64 <= data.length) { this._block(data, off); off += 64; }
    if (off < data.length) { this.buf.set(data.subarray(off), 0); this.bufLen = data.length - off; }
    return this;
  }

  digest(): Uint8Array {
    const bitsLo = (this.lenLo << 3) >>> 0;
    const bitsHi = (this.lenHi << 3) | (this.lenLo >>> 29);
    this.update(new Uint8Array([0x80]));
    // update() mutated lengths; snapshot above is the true message length
    while (this.bufLen !== 56) this.update(new Uint8Array([0]));
    const tail = new Uint8Array(8);
    new DataView(tail.buffer).setUint32(0, bitsHi, false);
    new DataView(tail.buffer).setUint32(4, bitsLo, false);
    this.update(tail);
    const out = new Uint8Array(32);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) dv.setUint32(i * 4, this.h[i], false);
    return out;
  }

  _block(p: Uint8Array, off: number): void {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++, off += 4) {
      w[i] = (p[off] << 24) | (p[off + 1] << 16) | (p[off + 2] << 8) | p[off + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
}
