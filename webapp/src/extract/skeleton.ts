// ab6 skeleton payload decoder, producing the skeletons/NNNNN.json payload
// object.
//
// object = n 89-byte bone records, depth-first pre-order:
//   22 BE f32: 3x4 bind matrix (row-major), scale xyz, quat xyzw, trans xyz
//   u8 num_children: parents are reconstructed by replaying the pre-order
//   walk with a stack of remaining child counts.

export interface SkeletonBone {
  parent: number;
  scale: number[];
  quat: number[]; // xyzw
  trans: number[];
  bind: number[]; // 3x4 row-major, flattened
}

// decodeSkeleton(u8, {i}) -> skeletons/NNNNN.json object.
export function decodeSkeleton(
  u8: Uint8Array, { i }: { i?: number } = {},
): { i: number | undefined; bones: SkeletonBone[] } {
  if (u8.length % 89 !== 0) {
    throw new Error(`skeleton ${i}: object not a multiple of 89 bytes (${u8.length})`);
  }
  const n = u8.length / 89;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const floats = new Array<number[]>(n);
  const children = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    const f = new Array<number>(22);
    for (let j = 0; j < 22; j++) f[j] = dv.getFloat32(k * 89 + 4 * j, false);
    floats[k] = f;
    children[k] = u8[k * 89 + 88];
  }

  // Reconstruct parents from the depth-first child counts. If the walk fails
  // (never observed on real skeletons) every bone defaults to parent -1.
  const parents = new Array<number>(n).fill(-1);
  const stack: [number, number][] = n > 0 ? [[0, children[0]]] : [];
  let ok = true;
  for (let b = 1; b < n; b++) {
    while (stack.length && stack[stack.length - 1][1] === 0) stack.pop();
    if (!stack.length) { ok = false; break; }
    parents[b] = stack[stack.length - 1][0];
    stack[stack.length - 1][1]--;
    stack.push([b, children[b]]);
  }
  if (!ok) parents.fill(-1);

  const bones = new Array<SkeletonBone>(n);
  for (let k = 0; k < n; k++) {
    const f = floats[k];
    bones[k] = {
      parent: parents[k],
      scale: f.slice(12, 15),
      quat: f.slice(15, 19), // xyzw
      trans: f.slice(19, 22),
      bind: f.slice(0, 12), // 3x4 row-major, flattened
    };
  }
  return { i, bones };
}

// Rest-pose bone WORLD translations, forward-kinematics through the parent
// chain (decodeSkeleton's depth-first pre-order guarantees parent < child,
// so a single forward pass suffices). Mirrors the viewer's Rig.restWorldInfo
// (viewers/rig.ts) exactly -- TRS compose then multiply down the tree -- but
// without a THREE.js dependency: extraction only needs the resulting POINT
// positions (see extract/world/effects.ts rig-bone binding for particle
// placement), never full bone orientations, so this returns translations
// only. Matrices are column-major (THREE.Matrix4 convention) purely as
// internal working state; only element [12,13,14] (translation) is read out
// per bone.
export function restWorldTranslations(bones: SkeletonBone[]): number[][] {
  const world = new Array<number[]>(bones.length);
  const out = new Array<number[]>(bones.length);
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    const local = composeMatrix(b.trans, b.quat, b.scale);
    const m = b.parent >= 0 && b.parent < i ? multiplyMatrices(world[b.parent], local) : local;
    world[i] = m;
    out[i] = [m[12], m[13], m[14]];
  }
  return out;
}

// THREE.Matrix4.compose(position, quaternion, scale), reimplemented
// dependency-free (column-major 16-element array).
function composeMatrix(pos: number[], quat: number[], scale: number[]): number[] {
  const [x, y, z, w] = quat;
  const x2 = x + x; const y2 = y + y; const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2;
  const wx = w * x2; const wy = w * y2; const wz = w * z2;
  const [sx, sy, sz] = scale;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    pos[0], pos[1], pos[2], 1,
  ];
}

// THREE.Matrix4.multiply (this = a * b), reimplemented dependency-free
// (column-major 16-element arrays, standard 4x4 affine composition).
function multiplyMatrices(ae: number[], be: number[]): number[] {
  const a11 = ae[0]; const a12 = ae[4]; const a13 = ae[8]; const a14 = ae[12];
  const a21 = ae[1]; const a22 = ae[5]; const a23 = ae[9]; const a24 = ae[13];
  const a31 = ae[2]; const a32 = ae[6]; const a33 = ae[10]; const a34 = ae[14];
  const a41 = ae[3]; const a42 = ae[7]; const a43 = ae[11]; const a44 = ae[15];
  const b11 = be[0]; const b12 = be[4]; const b13 = be[8]; const b14 = be[12];
  const b21 = be[1]; const b22 = be[5]; const b23 = be[9]; const b24 = be[13];
  const b31 = be[2]; const b32 = be[6]; const b33 = be[10]; const b34 = be[14];
  const b41 = be[3]; const b42 = be[7]; const b43 = be[11]; const b44 = be[15];
  return [
    a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41,
    a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41,
    a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41,
    a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41,
    a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42,
    a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42,
    a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42,
    a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42,
    a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43,
    a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43,
    a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43,
    a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43,
    a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44,
    a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44,
    a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44,
    a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44,
  ];
}
