// Frame-0 skin palettes for actors' resting clips, so the world can draw a
// rigged actor in its resting pose without the Animations category.
//
// palette[bone] = worldPose(bone) * inverse(worldBind(bone)), the matrix the
// GPU skinning path applies to a bind-pose vertex; stored row-major 3x4 per
// bone (the skeleton payload's own matrix convention), base64 float32.

import { restWorldMatrices, multiplyMatrices, type SkeletonBone } from '../skeleton.js';
import type { AnimPayload } from '../anim.js';
import { b64FromTyped } from '../b64.js';

// Base64 float32 track decode (little-endian payloads, see anim.js).
export function b64ToF32(s: string): Float32Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2);
}

export const IDLE_POSES_FORMAT = 1;

export interface IdlePosesDoc {
  format: number;
  /** "<rig>:<clip>" -> { bones, m: base64 float32 of bones*12 row-major 3x4 } */
  poses: Record<string, { bones: number; m: string }>;
}

export const idlePoseKey = (rig: number, clip: number): string => `${rig}:${clip}`;

const trs = (t: number[], q: number[], s: number[]): number[] => {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  // column-major, like restWorldMatrices
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
};

const bindLocal = (m: number[]): number[] => [
  m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1,
];

// Inverse of a column-major affine 4x4 (general 3x3 block plus translation).
function invertAffine(m: number[]): number[] | null {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  const inv = 1 / det;
  const r00 = A * inv, r01 = -(b * i - c * h) * inv, r02 = (b * f - c * e) * inv;
  const r10 = B * inv, r11 = (a * i - c * g) * inv, r12 = -(a * f - c * d) * inv;
  const r20 = C * inv, r21 = -(a * h - b * g) * inv, r22 = (a * e - b * d) * inv;
  const tx = m[12], ty = m[13], tz = m[14];
  return [
    r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0,
    -(r00 * tx + r01 * ty + r02 * tz), -(r10 * tx + r11 * ty + r12 * tz), -(r20 * tx + r21 * ty + r22 * tz), 1,
  ];
}

const frame0 = (channel: any, width: number, fallback: number[]): number[] => {
  if (!channel || channel.mode === 'absent') return fallback;
  if (channel.mode === 'const') return channel.value;
  return Array.from(b64ToF32(channel.data).subarray(0, width));
};

/** Row-major 3x4 skin matrices (bones*12) for the clip's first frame. */
export function idlePosePalette(bones: SkeletonBone[], clip: AnimPayload): Float32Array | null {
  if (!bones.length || clip.bones.length !== bones.length) return null;
  const bind = restWorldMatrices(bones);
  const world: number[][] = new Array(bones.length);
  const out = new Float32Array(bones.length * 12);
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i];
    const track: any = clip.bones[i];
    const local = track?.present
      ? trs(frame0(track.trans, 3, bone.trans), frame0(track.rot, 4, bone.quat), frame0(track.scale, 3, [1, 1, 1]))
      : bindLocal(bone.bind);
    world[i] = bone.parent >= 0 && bone.parent < i ? multiplyMatrices(world[bone.parent], local) : local;
    const inverse = invertAffine(bind[i]);
    if (!inverse) return null;
    const skin = multiplyMatrices(world[i], inverse);
    const o = i * 12;
    out[o] = skin[0]; out[o + 1] = skin[4]; out[o + 2] = skin[8]; out[o + 3] = skin[12];
    out[o + 4] = skin[1]; out[o + 5] = skin[5]; out[o + 6] = skin[9]; out[o + 7] = skin[13];
    out[o + 8] = skin[2]; out[o + 9] = skin[6]; out[o + 10] = skin[10]; out[o + 11] = skin[14];
  }
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) return null;
  return out;
}

export function encodeIdlePose(palette: Float32Array): { bones: number; m: string } {
  return { bones: palette.length / 12, m: b64FromTyped(palette) };
}

/** Pose a bind-pose vertex stream in place: positions (xyz), normals (xyz)
 *  and tangents (xyzw, w kept) with 4 weighted global bone influences. */
export function skinVertices(
  palette: Float32Array, skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>,
  positions: Float32Array, normals?: Float32Array | null, tangents?: Float32Array | null,
): void {
  const count = positions.length / 3;
  const bones = palette.length / 12;
  const m = new Float32Array(12);
  for (let v = 0; v < count; v++) {
    m.fill(0);
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[v * 4 + k];
      if (!w) continue;
      const bone = skinIndex[v * 4 + k];
      if (!(bone >= 0 && bone < bones)) continue;
      total += w;
      const o = bone * 12;
      for (let j = 0; j < 12; j++) m[j] += palette[o + j] * w;
    }
    if (total <= 0) continue;
    if (Math.abs(total - 1) > 1e-3) for (let j = 0; j < 12; j++) m[j] /= total;
    const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
    positions[v * 3] = m[0] * px + m[1] * py + m[2] * pz + m[3];
    positions[v * 3 + 1] = m[4] * px + m[5] * py + m[6] * pz + m[7];
    positions[v * 3 + 2] = m[8] * px + m[9] * py + m[10] * pz + m[11];
    if (normals) {
      const nx = normals[v * 3], ny = normals[v * 3 + 1], nz = normals[v * 3 + 2];
      let x = m[0] * nx + m[1] * ny + m[2] * nz, y = m[4] * nx + m[5] * ny + m[6] * nz, z = m[8] * nx + m[9] * ny + m[10] * nz;
      const length = Math.hypot(x, y, z) || 1;
      normals[v * 3] = x / length; normals[v * 3 + 1] = y / length; normals[v * 3 + 2] = z / length;
    }
    if (tangents) {
      const tx = tangents[v * 4], ty = tangents[v * 4 + 1], tz = tangents[v * 4 + 2];
      let x = m[0] * tx + m[1] * ty + m[2] * tz, y = m[4] * tx + m[5] * ty + m[6] * tz, z = m[8] * tx + m[9] * ty + m[10] * tz;
      const length = Math.hypot(x, y, z) || 1;
      tangents[v * 4] = x / length; tangents[v * 4 + 1] = y / length; tangents[v * 4 + 2] = z / length;
    }
  }
}
