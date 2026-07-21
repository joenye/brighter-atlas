// ab1 animation-clip payload decoder, producing the anims/NNNNN.json payload
// object.
//
// object = one clip sampled at 50 Hz (20 ms):
//   u8 bone_count, then per bone:
//     u8 present (0 = no track, nothing follows)
//     u8 0x14 (sample interval ms) | varint duration_ms (same for all bones)
//     varint n_scale in {0,1,full}; n*3 BE f32 PLANAR sx[n],sy[n],sz[n]
//     varint n_rot   in {0,1,full}; n*4 zigzag varints PLANAR qx..qw deltas,
//       accumulated with int16 wraparound, /32767 -> unit quat (x,y,z,w)
//     varint n_trans in {0,1,full}; n*3 BE f32 PLANAR tx[n],ty[n],tz[n]
//   where full = ceil(duration/20)+1 (both endpoints included).
// Channel count 0 = absent (skeleton rest pose), 1 = const, full = track.

import { readVarint } from './bundles.js';
import { b64FromTyped } from './b64.js';

export type AnimChannel =
  | { mode: 'absent' }
  | { mode: 'const'; value: number[] }
  | { mode: 'track'; data: string };

export type AnimBone =
  | { present: false }
  | { present: true; scale: AnimChannel; rot: AnimChannel; trans: AnimChannel };

export interface AnimPayload {
  i: number | undefined;
  skel: number | undefined;
  duration_ms: number;
  frame_ms: number;
  frames: number;
  bones: AnimBone[];
}

// Track b64 fields are f32 little-endian; typed arrays are platform-endian.
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
  throw new Error('anim.js: little-endian host required');
}

export const SAMPLE_MS = 20; // 50 Hz

function zigzag(v: number): number {
  // (v >> 1) ^ -(v & 1) without 32-bit truncation (varints are unbounded)
  return v % 2 ? -(v + 1) / 2 : v / 2;
}

// Scale/translation channel: n planar BE-f32 frames -> channel object.
// Track data is re-emitted interleaved (frame-major) f32le.
function floatChannel(dv: DataView, off: number, n: number, ch: number): [AnimChannel, number] {
  if (n === 0) return [{ mode: 'absent' }, off];
  if (n === 1) {
    const value = [];
    for (let c = 0; c < ch; c++) value.push(dv.getFloat32(off + 4 * c, false));
    return [{ mode: 'const', value }, off + 4 * ch];
  }
  const out = new Float32Array(n * ch);
  for (let c = 0; c < ch; c++) {
    for (let f = 0; f < n; f++) out[f * ch + c] = dv.getFloat32(off + 4 * (c * n + f), false);
  }
  return [{ mode: 'track', data: b64FromTyped(out) }, off + 4 * n * ch];
}

// Rotation channel: 4*n zigzag varints, planar per component; each component
// accumulates its own deltas with int16 wraparound.
function rotChannel(u8: Uint8Array, off: number, n: number): [AnimChannel, number] {
  if (n === 0) return [{ mode: 'absent' }, off];
  const q = new Float64Array(4 * n); // doubles first: const values stay f64
  for (let c = 0; c < 4; c++) {
    let acc = 0;
    for (let f = 0; f < n; f++) {
      let d;
      [d, off] = readVarint(u8, off);
      acc = (((acc + zigzag(d) + 32768) % 65536) + 65536) % 65536 - 32768;
      q[f * 4 + c] = acc / 32767.0;
    }
  }
  if (n === 1) return [{ mode: 'const', value: [q[0], q[1], q[2], q[3]] }, off];
  const out = new Float32Array(4 * n);
  for (let k = 0; k < 4 * n; k++) out[k] = q[k];
  return [{ mode: 'track', data: b64FromTyped(out) }, off];
}

// decodeAnim(u8, {i, skel, dur, frameMs}) -> anims/NNNNN.json object.
//   skel    = ab6 skeleton index from ab0's anim_dir (passed through).
//   dur     = ab0's duration; unused — the clip's own duration is parsed from
//             the stream (and validated identical across bones).
//   frameMs = sample interval (always 20; the per-bone header byte is 0x14).
export function decodeAnim(
  u8: Uint8Array,
  { i, skel, dur = null, frameMs = SAMPLE_MS }:
    { i?: number; skel?: number; dur?: number | null; frameMs?: number } = {},
): AnimPayload {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 0;
  const boneCount = u8[off++];
  let duration = null;
  const bones: AnimBone[] = [];
  for (let bone = 0; bone < boneCount; bone++) {
    const present = u8[off++];
    if (present === 0) {
      bones.push({ present: false });
      continue;
    }
    if (present !== 1) throw new Error(`anim ${i} bone ${bone}: present byte = ${present}`);
    const htype = u8[off++];
    if (htype !== 0x14) throw new Error(`anim ${i} bone ${bone}: header type 0x${htype.toString(16)}`);
    let d;
    [d, off] = readVarint(u8, off);
    if (duration === null) duration = d;
    else if (d !== duration) throw new Error(`anim ${i} bone ${bone}: duration ${d} != ${duration}`);
    const full = Math.ceil(d / frameMs) + 1;

    let n: number, scale: AnimChannel, rot: AnimChannel, trans: AnimChannel;
    [n, off] = readVarint(u8, off);
    if (n !== 0 && n !== 1 && n !== full) throw new Error(`anim ${i} bone ${bone}: n_scale ${n}`);
    [scale, off] = floatChannel(dv, off, n, 3);
    [n, off] = readVarint(u8, off);
    if (n !== 0 && n !== 1 && n !== full) throw new Error(`anim ${i} bone ${bone}: n_rot ${n}`);
    [rot, off] = rotChannel(u8, off, n);
    [n, off] = readVarint(u8, off);
    if (n !== 0 && n !== 1 && n !== full) throw new Error(`anim ${i} bone ${bone}: n_trans ${n}`);
    [trans, off] = floatChannel(dv, off, n, 3);
    bones.push({ present: true, scale, rot, trans });
  }
  if (off !== u8.length) throw new Error(`anim ${i}: ${u8.length - off} trailing bytes not consumed`);

  const durationMs = duration ?? 0; // all-absent clips: duration never seen
  return {
    i,
    skel,
    duration_ms: durationMs,
    frame_ms: frameMs,
    frames: Math.ceil(durationMs / frameMs) + 1,
    bones,
  };
}
