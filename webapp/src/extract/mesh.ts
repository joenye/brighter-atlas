// ab5 mesh payload decoder, producing the meshes/NNNNN.json payload object.
//
// ab5 object = [vertex records][u16le index buffer][optional 2-byte zero pad];
// no header. Vertex strides (all observed objects):
//   28 static : pos f32le x3 | normal 10:10:10:2 snorm | aux 10:10:10:2 snorm
//               | uv 2x unorm16le | tangent 10:10:10:2 snorm (w = handedness)
//   36 skinned: the 28 bytes above | bone indices u8 x4 | bone weights u8 x4
//   24 rare   : tangent-less variant (exactly one object: ab5[13205])
// Counts are NOT stored in ab5; v/t/skeleton_ref come from ab0's mesh
// directory and are passed in by the caller.

import { b64FromBytes, b64FromTyped } from './b64.js';

export interface MeshPayload {
  i: number;
  stride: number;
  v: number;
  t: number;
  skinned: boolean;
  skel: number;
  bbox: number[];
  positions: string;
  normals: string;
  uvs: string;
  tangents: string | null;
  aux_normals: string;
  indices: string;
  idx_dtype: 'u32' | 'u16';
  bone_indices: string | null;
  bone_weights: string | null;
}

// Payload b64 fields are little-endian; we use platform typed arrays for
// speed, so refuse a big-endian host rather than silently emit garbage.
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
  throw new Error('mesh.js: little-endian host required');
}

// DXGI-style R10G10B10A2, xyz as two's-complement 10-bit ints scaled by 1/511.
function snorm10(dw: number, shift: number): number {
  let c = (dw >>> shift) & 0x3ff;
  if (c >= 512) c -= 1024;
  return c / 511.0;
}

// decodeMesh(u8, {i, v, t, sref, bbox}) -> meshes/NNNNN.json object.
//   u8   = decompressed ab5 object bytes
//   v/t  = vertex/triangle counts from ab0's mesh directory (authoritative)
//   sref = mesh_dir skeleton_ref (0 static -> skel -1, 1 rigid single-bone ->
//          skel -2, >=2 -> ab6 index sref-2)
//   bbox = 6 floats from the mesh's class-501 ab2 record; when absent the
//          per-axis min/max of the f32 positions is used.
export function decodeMesh(
  u8: Uint8Array,
  { i, v, t, sref, bbox = null }:
    { i: number; v: number; t: number; sref: number; bbox?: ArrayLike<number> | null },
): MeshPayload {
  // Stride is whichever of 24/28/36 makes v*stride + t*6 equal the object
  // size modulo the 0/2-byte index alignment pad. At most one stride can
  // satisfy the equation (differences are >2 bytes).
  let stride = 0;
  for (const s of [24, 28, 36]) {
    const used = v * s + t * 6;
    if (used === u8.length || used + 2 === u8.length) { stride = s; break; }
  }
  if (!stride) {
    throw new Error(`mesh ${i}: directory counts (V=${v}, T=${t}) do not fit object size ${u8.length}`);
  }

  const idxOff = v * stride;
  const nIdx = t * 3;
  let maxIdx = 0;
  if (((u8.byteOffset + idxOff) & 1) === 0) {
    // aligned u16 view over the LE index buffer (LE host asserted above):
    // same values as the byte-pair reads, one load per index
    const idx16 = new Uint16Array(u8.buffer, u8.byteOffset + idxOff, nIdx);
    for (let k = 0; k < nIdx; k++) {
      const x = idx16[k];
      if (x > maxIdx) maxIdx = x;
    }
  } else {
    for (let k = 0; k < nIdx; k++) {
      const x = u8[idxOff + 2 * k] | (u8[idxOff + 2 * k + 1] << 8);
      if (x > maxIdx) maxIdx = x;
    }
  }
  if (nIdx > 0 && maxIdx >= v) {
    throw new Error(`mesh ${i}: directory counts admit out-of-range index`);
  }

  // u32-aligned dword view over the vertex records (strides are all multiples
  // of 4, so every packed attribute dword is aligned once the base is).
  const words = (u8.byteOffset & 3) === 0
    ? new Uint32Array(u8.buffer, u8.byteOffset, idxOff >> 2)
    : new Uint32Array(u8.slice(0, idxOff).buffer);

  const posBytes = new Uint8Array(12 * v); // f32le passthrough, byte-exact
  // copy positions as three u32 lanes per vertex from the existing words view
  // (posBytes is freshly allocated: offset 0, length divisible by 4), a pure
  // word memcpy of the same bytes, replacing per-vertex subarray().set()
  const posWords = new Uint32Array(posBytes.buffer);
  const normals = new Float32Array(3 * v);
  const aux = new Float32Array(3 * v);
  const uvs = new Float32Array(2 * v);
  const tangents = stride === 24 ? null : new Float32Array(4 * v);
  for (let k = 0; k < v; k++) {
    const rec = k * stride;
    const w0 = rec >> 2;
    posWords[3 * k] = words[w0];
    posWords[3 * k + 1] = words[w0 + 1];
    posWords[3 * k + 2] = words[w0 + 2];
    const dwN = words[(rec + 12) >> 2];
    const dwA = words[(rec + 16) >> 2];
    const dwUV = words[(rec + 20) >> 2];
    normals[3 * k] = snorm10(dwN, 0);
    normals[3 * k + 1] = snorm10(dwN, 10);
    normals[3 * k + 2] = snorm10(dwN, 20);
    aux[3 * k] = snorm10(dwA, 0);
    aux[3 * k + 1] = snorm10(dwA, 10);
    aux[3 * k + 2] = snorm10(dwA, 20);
    uvs[2 * k] = (dwUV & 0xffff) / 65535.0;
    uvs[2 * k + 1] = (dwUV >>> 16) / 65535.0;
    if (tangents) {
      const dwT = words[(rec + 24) >> 2];
      tangents[4 * k] = snorm10(dwT, 0);
      tangents[4 * k + 1] = snorm10(dwT, 10);
      tangents[4 * k + 2] = snorm10(dwT, 20);
      let w = dwT >>> 30; // {-2..1}: tangent handedness (+1/-1)
      if (w >= 2) w -= 4;
      tangents[4 * k + 3] = w;
    }
  }

  let boneIdx = null;
  let boneWt = null;
  if (stride === 36) {
    boneIdx = new Uint8Array(4 * v);
    boneWt = new Uint8Array(4 * v); // rows sum to 255
    for (let k = 0; k < v; k++) {
      // direct byte indexing: same bytes as the subarray().set() pairs
      const src = k * 36 + 28, dst = k * 4;
      boneIdx[dst] = u8[src];
      boneIdx[dst + 1] = u8[src + 1];
      boneIdx[dst + 2] = u8[src + 2];
      boneIdx[dst + 3] = u8[src + 3];
      boneWt[dst] = u8[src + 4];
      boneWt[dst + 1] = u8[src + 5];
      boneWt[dst + 2] = u8[src + 6];
      boneWt[dst + 3] = u8[src + 7];
    }
  }

  // dtype rule: u32 iff any index > 0xFFFF. The stored buffer is u16le so the
  // u32 branch is unreachable today; kept so the rule stays exact, not
  // approximated.
  const big = maxIdx > 0xffff;
  let idxB64;
  if (big) {
    const wide = new Uint32Array(nIdx);
    for (let k = 0; k < nIdx; k++) wide[k] = u8[idxOff + 2 * k] | (u8[idxOff + 2 * k + 1] << 8);
    idxB64 = b64FromTyped(wide);
  } else {
    idxB64 = b64FromBytes(u8.subarray(idxOff, idxOff + 2 * nIdx));
  }

  let bb;
  if (bbox) {
    bb = Array.from(bbox, Number);
  } else {
    // fallback bbox: per-axis min/max of the f32 positions (doubles of f32
    // values, so exact)
    const pos = new Float32Array(posBytes.buffer);
    bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < v; k++) {
      for (let a = 0; a < 3; a++) {
        const x = pos[3 * k + a];
        if (x < bb[a]) bb[a] = x;
        if (x > bb[3 + a]) bb[3 + a] = x;
      }
    }
  }

  return {
    i,
    stride,
    v,
    t,
    skinned: stride === 36,
    skel: sref >= 2 ? sref - 2 : (sref === 0 ? -1 : -2),
    bbox: bb,
    positions: b64FromBytes(posBytes),
    normals: b64FromTyped(normals),
    uvs: b64FromTyped(uvs),
    tangents: tangents ? b64FromTyped(tangents) : null,
    aux_normals: b64FromTyped(aux),
    indices: idxB64,
    idx_dtype: big ? 'u32' : 'u16',
    bone_indices: boneIdx ? b64FromBytes(boneIdx) : null,
    bone_weights: boneWt ? b64FromBytes(boneWt) : null,
  };
}
