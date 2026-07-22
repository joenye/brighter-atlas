// ab2 (model/sprite metadata) tag-value parser, reduced to what the viewer
// needs: the 0x25 AABB and the 0x0b bounding radius of model objects. Every
// other tag must still be skipped with its exact payload size so the walk
// reaches them (an ab2 object is a self-describing stream: varint header
// count, then {u8 tag, payload} to EOF).
//
// Fixed payloads are big-endian, EXCEPT tag 0x3c (UV rect, little-endian). Size
// only matters here. Worker-safe: no DOM, no Node APIs.

import { readVarint } from './bundles.js';

// tag -> fixed payload byte size; highest tag is 0x3c
const FIXED_SIZE = new Uint8Array(0x40);
for (const [tag, size] of [
  [0x0a, 4], [0x0b, 4], [0x18, 8], [0x1f, 8], [0x28, 8], [0x2e, 8],
  [0x22, 12], [0x2f, 12], [0x15, 16], [0x2a, 16], [0x39, 16], [0x3c, 16],
  [0x25, 24], [0x30, 48],
]) FIXED_SIZE[tag] = size;

// Parse one decompressed ab2 object. Returns { bbox: [minX,minY,minZ,maxX,maxY,maxZ]
// | null, radius: number | null } (first 0x25 / first 0x0b in the stream).
// Throws unless the stream parses to EXACT EOF: partial parses must not be
// trusted, since one mis-sized skip would desync every later tag.
export function parseAb2Object(u8: Uint8Array): { bbox: number[] | null; radius: number | null } {
  const len = u8.length;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let [, i] = readVarint(u8, 0); // header value count; the values follow as tagged items
  let bbox: number[] | null = null;
  let radius: number | null = null;
  while (i < len) {
    const tag = u8[i++];
    // varint payload (0x00 int, 0x0f int, 0x20 array header, 0x24 group id,
    // 0x26 ref, 0x2c int). Array elements are inline tagged values, so 0x20
    // needs no recursion when only scanning for tags
    if (tag === 0x00 || tag === 0x0f || tag === 0x20 || tag === 0x24 || tag === 0x26 ||
        tag === 0x2c) {
      [, i] = readVarint(u8, i);
      continue;
    }
    if (tag === 0x0c || tag === 0x0d) continue; // bare markers
    if (tag === 0x0e) { // string: varint byte length + bytes
      let n;
      [n, i] = readVarint(u8, i);
      i += n;
      continue;
    }
    if (tag === 0x48) { // atlas: nPages x (w,h), nSprites x (w,h), 3 x nSprites placements
      let nPages, nSprites;
      [nPages, i] = readVarint(u8, i);
      if (nPages > 100000) throw new Error(`ab2: implausible atlas page count ${nPages}`);
      for (let k = 0; k < 2 * nPages && i <= len; k++) [, i] = readVarint(u8, i);
      [nSprites, i] = readVarint(u8, i);
      if (nSprites > 1000000) throw new Error(`ab2: implausible atlas sprite count ${nSprites}`);
      for (let k = 0; k < 5 * nSprites && i <= len; k++) [, i] = readVarint(u8, i);
      continue;
    }
    const size = tag < FIXED_SIZE.length ? FIXED_SIZE[tag] : 0;
    if (size === 0) throw new Error(`ab2: unknown tag 0x${tag.toString(16)} at ${i - 1}`);
    if (i + size > len) throw new Error(`ab2: tag 0x${tag.toString(16)} payload overruns object`);
    if (tag === 0x25 && bbox === null) {
      bbox = [
        dv.getFloat32(i, false), dv.getFloat32(i + 4, false), dv.getFloat32(i + 8, false),
        dv.getFloat32(i + 12, false), dv.getFloat32(i + 16, false), dv.getFloat32(i + 20, false),
      ];
    } else if (tag === 0x0b && radius === null) {
      radius = dv.getFloat32(i, false);
    }
    i += size;
  }
  // varint reads past the end strictly advance i, so any overrun lands here
  if (i !== len) throw new Error('ab2: object did not parse to exact EOF');
  return { bbox, radius };
}

// bboxes aligned to ab5 mesh ordinals: the i-th bbox-BEARING ab2 record
// describes mesh ab5[i] (the bbox-bearing records are exactly the class-501
// model records, in order: extents match the ab5 vertex buffers). Objects
// that fail to parse are treated as non-bbox-bearing.
export function bboxesForMeshes(ab2Objects: Uint8Array[]): number[][] {
  const out = [];
  for (const u8 of ab2Objects) {
    let rec = null;
    try {
      rec = parseAb2Object(u8);
    } catch {
      continue; // not a clean tag stream => not a model record
    }
    if (rec.bbox) out.push(rec.bbox);
  }
  return out;
}
