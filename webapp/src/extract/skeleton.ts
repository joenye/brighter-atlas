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
