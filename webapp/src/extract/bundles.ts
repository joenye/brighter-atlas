// Bundle container framing: reading from Blobs (File handles / OPFS files)
// so a 400 MB bundle is never resident: every access is a ranged slice.
//
//   assetBundle0:    one raw zstd frame (whole file)
//   assetBundle1..7: u32 BE header_size | zstd(header) | object frames back-to-back
//                    header = varint object_count, then one varint length per object
//   assetBundle8:    same header, but object payloads stored UNCOMPRESSED
//   ab3 objects:     m concatenated zstd frames + raw 13*m-byte metadata tail
//
// Varints are LSB-first 7-bit with 0x80 continuation.

import { zstdDecompress, isZstdFrame, zstdFrameSize } from './zstd.js';

export interface BundleEntry { offset: number; length: number }
export interface BundleFrames { count: number; entries: BundleEntry[] }
export interface Ab3Split { tail: Uint8Array; frames: Uint8Array[] }
export interface Ab3Decoded { tail: Uint8Array; subs: Uint8Array[] }

export function readVarint(u8: Uint8Array, off: number): [number, number] {
  let value = 0, shift = 0;
  for (;;) {
    const b = u8[off++];
    value += (b & 0x7f) * 2 ** shift; // * not << : lengths can exceed 31 bits in sum
    shift += 7;
    if (!(b & 0x80)) return [value, off];
  }
}

// -> { count, entries: [{ offset, length }] }  (ab0: a single whole-file entry)
export async function parseBundleHeader(blob: Blob, bundleIndex: number): Promise<BundleFrames> {
  if (bundleIndex === 0) {
    return { count: 1, entries: [{ offset: 0, length: blob.size }] };
  }
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const headerSize = new DataView(head.buffer).getUint32(0, false); // BE
  const compressed = new Uint8Array(await blob.slice(4, 4 + headerSize).arrayBuffer());
  const header = zstdDecompress(compressed);
  let [count, off] = readVarint(header, 0);
  const entries = new Array<BundleEntry>(count);
  let start = 4 + headerSize;
  for (let i = 0; i < count; i++) {
    let length;
    [length, off] = readVarint(header, off);
    entries[i] = { offset: start, length };
    start += length;
  }
  if (off !== header.length) throw new Error(`ab${bundleIndex}: header slack (${header.length - off} bytes)`);
  if (start > blob.size) throw new Error(`ab${bundleIndex}: object table exceeds file size`);
  return { count, entries };
}

export async function readRaw(blob: Blob, entry: BundleEntry): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(entry.offset, entry.offset + entry.length).arrayBuffer());
}

// Slab reader for SEQUENTIAL per-object reads: objects come out of 16 MB
// contiguous slabs instead of one blob.slice().arrayBuffer() per object, since
// tens of thousands of tiny async disk round-trips dominate an index pass
// otherwise. Used by the ingest coordinator and the pool workers (each worker
// slabs its own contiguous shard).
export function makeSlabReader(
  file: Blob, slabBytes = 16 * 1024 * 1024,
): (entry: BundleEntry) => Promise<Uint8Array> {
  let start = -1, end = -1, buf: ArrayBuffer | null = null;
  return async ({ offset, length }) => {
    if (offset >= start && offset + length <= end) {
      return new Uint8Array(buf!, offset - start, length);
    }
    if (length > slabBytes) {   // oversized object: direct read
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    }
    start = offset;
    end = Math.min(file.size, offset + slabBytes);
    buf = await file.slice(start, end).arrayBuffer();
    return new Uint8Array(buf, 0, length);
  };
}

// ab3 object -> { tail, frames } (frames still compressed; tail = raw metadata).
// Uses the structural frame walker, so no decompression is needed to split.
export function splitAb3(raw: Uint8Array): Ab3Split {
  const frames = [];
  let off = 0;
  while (isZstdFrame(raw, off)) {
    const size = zstdFrameSize(raw, off);
    frames.push(raw.subarray(off, off + size));
    off += size;
  }
  return { tail: raw.subarray(off), frames };
}

// Decompressed object content:
//   ab3 -> { tail, subs: [Uint8Array] } (metadata tail first)
//   ab8 -> raw bytes as-is
//   else -> single decompressed Uint8Array
export function decodeObject(bundleIndex: 3, raw: Uint8Array): Ab3Decoded;
export function decodeObject(bundleIndex: number, raw: Uint8Array): Uint8Array;
export function decodeObject(bundleIndex: number, raw: Uint8Array): Uint8Array | Ab3Decoded {
  if (bundleIndex === 3) {
    const { tail, frames } = splitAb3(raw);
    return { tail, subs: frames.map((f) => zstdDecompress(f)) };
  }
  if (bundleIndex === 8) return raw;
  return zstdDecompress(raw);
}
