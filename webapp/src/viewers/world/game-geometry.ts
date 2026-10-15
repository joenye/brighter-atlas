// Vertex data for the game's own programs: every placement of a batch is
// baked into one buffer in the native frame (as the game bakes its rooms),
// with the elements laid out as the program's vertex shader declares them:
// position (float3), normal and tangent (10:10:10:2 unorm, fed as the exact
// k/1023 values the hardware would produce), uv (16-bit unorm), specular
// bytes (uint) and vertex colour (8-bit unorm). The vertex colour is the
// room bake's: half the part colour (the placement tint), alpha the material
// opacity, truncated to bytes. A skinned program's layout (an actor) adds
// four bone indices (8-bit uint) and weights (8-bit unorm) straight after the
// uv and tangent, and keeps the mesh in its own space: its bone matrices
// carry the placement.
// (three from its module, not three-common: the bake also runs in a worker, which has no page)
import * as THREE from '../../../vendor/three.module.js';
import { b64f32, b64u16, b64u32, b64u8 } from '../../store.js';
import type { AttributeBinding } from './dxbc-glsl.js';
import { packColour } from '../../extract/world/tile-colour.js';

// Engine vertex formats (render tables).
export const VERTEX_FORMAT = { FLOAT2: 1, FLOAT3: 2, UNORM16X2: 20, UINT8X4: 24, UNORM8X4: 25, UNORM10X3_2: 26 } as const;

const f32 = Math.fround;

export interface BakeInstance {
  /** The placement's mesh payload (positions, normals, uvs, tangents, indices). */
  payload: any;
  /** Native-frame placement of the raw mesh (column-major 4x4). */
  matrix: THREE.Matrix4;
  /** The part colour (full range; its vertex colour is half of it), or null for neutral. */
  tint: number[] | null;
  /** The two recolour tints (half range RGBA), or null for neutral. */
  recolours?: number[][] | null;
  /** The part's texture transform (m00, m01, tx, m10, m11, ty), applied as
   *  the bake applies it: to the 16-bit coordinates, the offset scaled to
   *  16 bits, each step in single precision, truncated and clamped. */
  uvAffine?: number[];
  /** Per vertex: the colour grid value its colour is multiplied by (rgb). */
  vertexTints?: number[][];
  /** All rooms, a cluster's part: its room's slot in the room mask (from 1). */
  slot?: number;
  /** All rooms, a joined draw's part: its textures' layer in the draw's arrays, and its own material's specular
   *  bytes and opacity (the bake's otherwise). */
  layer?: number;
  specular?: [number, number, number];
  opacity?: number;
}

export interface BakeInputs {
  instances: BakeInstance[];
  /** A ring program's per-vertex ring centre: the water element's origin, in
   *  the space positions are baked in (radial ripples, 07-Oct-2026 on). */
  ringCentre?: boolean;
  /** One vertex layout per program that draws the batch (main, then depth). */
  layouts: { elements: number[]; attributes: AttributeBinding[] }[];
  specular: [number, number, number];
  opacity: number;
  /** Water surfaces: the packed style colour bytes (their first colour element). */
  style?: [number, number, number, number];
  /** Water sides: the texture window (v range) as 16-bit unorm. */
  window?: [number, number];
  /** Skinned programs: bake the bone indices and weights (instances in mesh space). */
  skinned?: boolean;
}

const quantise10 = (v: number) => Math.min(1023, Math.max(0, Math.round((v + 1) * 511)));

export interface DecodedMesh {
  positions: Float32Array; normals: Float32Array; uvs: Float32Array; tangents: Float32Array | null;
  source: Uint16Array | Uint32Array; count: number;
  boneIndices: Uint8Array | null; boneWeights: Uint8Array | null;
}

// A stream is base64 in a stored payload, or already decoded (a posed copy).
const floats = (v: any): Float32Array => (v instanceof Float32Array ? v : b64f32(v));

// Decoded once per payload while the payload is kept (the store keeps a mesh used across rooms): a tree in a
// hundred rooms of a joined cell is one decode, not a hundred.
const decodedMeshes = new WeakMap<object, DecodedMesh>();
export function decodeMesh(payload: any): DecodedMesh {
  let mesh = decodedMeshes.get(payload);
  if (!mesh) decodedMeshes.set(payload, mesh = decodeMeshNow(payload));
  return mesh;
}
function decodeMeshNow(payload: any): DecodedMesh {
  const positions = floats(payload.positions);
  return {
    positions, normals: floats(payload.normals), uvs: floats(payload.uvs),
    tangents: payload.tangents ? floats(payload.tangents) : null,
    source: payload.indices instanceof Uint16Array || payload.indices instanceof Uint32Array ? payload.indices
      : payload.idx_dtype === 'u32' ? b64u32(payload.indices) : b64u16(payload.indices),
    count: positions.length / 3,
    boneIndices: payload.bone_indices ? b64u8(payload.bone_indices) : null,
    boneWeights: payload.bone_weights ? b64u8(payload.bone_weights) : null,
  };
}

/** A skinned mesh posed once on the CPU by a bone palette (row-major 3x4 per bone, the placement
 *  included): its positions, normals and tangents in the frame the palette poses into, ready to bake as
 *  a static part (indices and texture coordinates kept; no bones). */
export function posePayload(payload: any, palette: Float32Array): any {
  const mesh = decodeMesh(payload);
  const { positions, normals, tangents, boneIndices, boneWeights, count } = mesh;
  if (!boneIndices || !boneWeights) return null;
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), tan = tangents ? new Float32Array(count * 4) : null;
  const bones = palette.length / 12;
  for (let v = 0; v < count; v++) {
    let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, tx = 0, ty = 0, tz = 0, sum = 0;
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const a = normals[v * 3], b = normals[v * 3 + 1], c = normals[v * 3 + 2];
    const ta = tan ? tangents![v * 4] : 0, tb = tan ? tangents![v * 4 + 1] : 0, tc = tan ? tangents![v * 4 + 2] : 0;
    for (let k = 0; k < 4; k++) {
      const w = boneWeights[v * 4 + k];
      const bone = boneIndices[v * 4 + k];
      if (!w || bone >= bones) continue;
      const o = bone * 12, m = palette;
      px += w * (m[o] * x + m[o + 1] * y + m[o + 2] * z + m[o + 3]);
      py += w * (m[o + 4] * x + m[o + 5] * y + m[o + 6] * z + m[o + 7]);
      pz += w * (m[o + 8] * x + m[o + 9] * y + m[o + 10] * z + m[o + 11]);
      nx += w * (m[o] * a + m[o + 1] * b + m[o + 2] * c);
      ny += w * (m[o + 4] * a + m[o + 5] * b + m[o + 6] * c);
      nz += w * (m[o + 8] * a + m[o + 9] * b + m[o + 10] * c);
      tx += w * (m[o] * ta + m[o + 1] * tb + m[o + 2] * tc);
      ty += w * (m[o + 4] * ta + m[o + 5] * tb + m[o + 6] * tc);
      tz += w * (m[o + 8] * ta + m[o + 9] * tb + m[o + 10] * tc);
      sum += w;
    }
    if (!sum) { pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z; nrm[v * 3] = a; nrm[v * 3 + 1] = b; nrm[v * 3 + 2] = c; if (tan) tan.set(tangents!.subarray(v * 4, v * 4 + 4), v * 4); continue; }
    pos[v * 3] = px / sum; pos[v * 3 + 1] = py / sum; pos[v * 3 + 2] = pz / sum;
    nrm[v * 3] = nx / sum; nrm[v * 3 + 1] = ny / sum; nrm[v * 3 + 2] = nz / sum;
    if (tan) { tan[v * 4] = tx / sum; tan[v * 4 + 1] = ty / sum; tan[v * 4 + 2] = tz / sum; tan[v * 4 + 3] = tangents![v * 4 + 3]; }
  }
  return { positions: pos, normals: nrm, uvs: payload.uvs, tangents: tan, indices: mesh.source, idx_dtype: payload.idx_dtype };
}

/** Bake a batch once into one geometry per layout, each with that vertex
 *  shader's attribute layout. */
export function bakeGameGeometry(input: BakeInputs): THREE.BufferGeometry[] {
  const steps = bakeSteps(input);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** The same bake, between instances taking a turn of `pace` every `sliceMs` (a joined cell's part can be
 *  thousands of instances: baked at once it held up frames for a tenth of a second and more). No pace: at once. */
export async function bakeGameGeometryAsync(input: BakeInputs, pace: ((label?: string, bytes?: number) => Promise<void>) | null, sliceMs = 2): Promise<THREE.BufferGeometry[]> {
  if (!pace) return bakeGameGeometry(input);
  const steps = bakeSteps(input);
  await pace('bake');
  let start = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - start > sliceMs) { await pace('bake'); start = performance.now(); }
  }
}

function* bakeSteps(input: BakeInputs): Generator<void, THREE.BufferGeometry[]> {
  const meshes = input.instances.map(({ payload }) => decodeMesh(payload));
  const arrays = yield* bakeArraysSteps(meshes, input.instances, input);
  return assembleBakedGeometry(arrays, input);
}

/** What a bake computes, before it is laid out per program (a worker hands these back). */
export interface BakedArrays {
  index: Uint16Array | Uint32Array; pos: Float32Array; nrm: Float32Array; tan: Float32Array; uv: Uint16Array;
  spec: Uint8Array; col: Uint8Array; sty: Uint8Array; tints0: Uint8Array; tints1: Uint8Array; win: Uint16Array;
  centre: Float32Array | null; slots: Float32Array | null; bones: Uint8Array | null; weights: Uint8Array | null;
  layers?: Float32Array | null;
  bounds: number[]; largest: number;
}
/** A bake's options less its instances and layouts (what a worker is told). */
export type BakeOptions = Omit<BakeInputs, 'instances' | 'layouts'>;
export type BakePlacement = Omit<BakeInstance, 'payload'>;

/** The bake's arithmetic over decoded meshes, one instance a step. */
export function* bakeArraysSteps(meshes: DecodedMesh[], instances: BakePlacement[], input: BakeOptions): Generator<void, BakedArrays> {
  const total = meshes.reduce((n, m) => n + m.count, 0);
  const indices = meshes.reduce((n, m) => n + m.source.length, 0);
  const index = total > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 4);
  const tan = new Float32Array(total * 4);
  const uv = new Uint16Array(total * 2);
  const spec = new Uint8Array(total * 4);
  const col = new Uint8Array(total * 4);
  const sty = new Uint8Array(total * 4);
  const tints = [new Uint8Array(total * 4), new Uint8Array(total * 4)];
  const [tints0, tints1] = tints;
  const style = input.style, windowWords = input.window;
  const unit = (x: number) => Math.min(65535, Math.max(0, Math.trunc(x)));
  const win = new Uint16Array(total * 2);
  const centre = input.ringCentre ? new Float32Array(total * 2) : null;
  const slots = instances.some((i) => i.slot) ? new Float32Array(total) : null;
  const layers = instances.some((i) => i.layer !== undefined) ? new Float32Array(total) : null;
  const bones = input.skinned ? new Uint8Array(total * 4) : null;
  const weights = input.skinned ? new Uint8Array(total * 4) : null;
  const neutral = packColour([127 / 255, 127 / 255, 127 / 255, 1]);   // neutral recolour tint (half range)
  const p = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3();
  const rotation = new THREE.Matrix3();
  const opacityByteOf = (opacity: number) => Math.trunc(f32(f32(opacity) * 255));
  const sharedOpacityByte = opacityByteOf(input.opacity);
  let first = 0, at = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let largest = 0;   // the largest instance's diagonal
  for (let i = 0; i < instances.length; i++) {
    const il = [Infinity, Infinity, Infinity], ih = [-Infinity, -Infinity, -Infinity];
    const { matrix, tint, recolours, uvAffine, vertexTints, slot } = instances[i];
    if (slots && slot) slots.fill(slot, first, first + meshes[i].count);
    const own = instances[i];
    if (layers) layers.fill(own.layer ?? 0, first, first + meshes[i].count);
    const specular = own.specular ?? input.specular;
    const opacityByte = own.opacity === undefined ? sharedOpacityByte : opacityByteOf(own.opacity);
    const { positions, normals, uvs, tangents, source, count: nv, boneIndices, boneWeights } = meshes[i];
    if (bones && boneIndices && boneWeights) { bones.set(boneIndices.subarray(0, nv * 4), first * 4); weights!.set(boneWeights.subarray(0, nv * 4), first * 4); }
    const tintBytes = [0, 1].map((k) => (recolours?.[k] ? packColour(recolours[k]) : neutral));
    const [ta, tb] = tintBytes;
    rotation.setFromMatrix4(matrix);
    const mirrored = matrix.determinant() < 0;
    const base = tint ? [f32(tint[0] * 0.5), f32(tint[1] * 0.5), f32(tint[2] * 0.5)] : [0.5, 0.5, 0.5];
    for (let v = 0; v < nv; v++) {
      const o = first + v;
      p.fromArray(positions, v * 3).applyMatrix4(matrix);
      pos[o * 3] = p.x; pos[o * 3 + 1] = p.y; pos[o * 3 + 2] = p.z;
      if (p.x < il[0]) il[0] = p.x; if (p.x > ih[0]) ih[0] = p.x;
      if (p.y < il[1]) il[1] = p.y; if (p.y > ih[1]) ih[1] = p.y;
      if (p.z < il[2]) il[2] = p.z; if (p.z > ih[2]) ih[2] = p.z;
      n.fromArray(normals, v * 3).applyMatrix3(rotation).normalize();
      nrm[o * 4] = quantise10(n.x) / 1023; nrm[o * 4 + 1] = quantise10(n.y) / 1023; nrm[o * 4 + 2] = quantise10(n.z) / 1023;
      nrm[o * 4 + 3] = 0;
      if (tangents) {
        t.fromArray(tangents, v * 4).applyMatrix3(rotation).normalize();
        const w = tangents[v * 4 + 3] * (mirrored ? -1 : 1);
        tan[o * 4] = quantise10(t.x) / 1023; tan[o * 4 + 1] = quantise10(t.y) / 1023; tan[o * 4 + 2] = quantise10(t.z) / 1023;
        tan[o * 4 + 3] = w > 0 ? 2 / 3 : 0;
      }
      const u16 = Math.round(uvs[v * 2] * 65535), v16 = Math.round(uvs[v * 2 + 1] * 65535);
      if (uvAffine) {
        const [m00, m01, tx, m10, m11, ty] = uvAffine;
        uv[o * 2] = unit(f32(f32(tx * 65535) + f32(f32(m00 * u16) + f32(m01 * v16))));
        uv[o * 2 + 1] = unit(f32(f32(ty * 65535) + f32(f32(m10 * u16) + f32(m11 * v16))));
      } else {
        uv[o * 2] = u16; uv[o * 2 + 1] = v16;
      }
      spec[o * 4] = specular[0]; spec[o * 4 + 1] = specular[1]; spec[o * 4 + 2] = specular[2];
      const grid = vertexTints?.[v];
      for (let k = 0; k < 3; k++) col[o * 4 + k] = Math.min(255, Math.trunc(f32((grid ? f32(base[k] * grid[k]) : base[k]) * 255)));
      col[o * 4 + 3] = opacityByte;
      // (four bytes each, written one by one: a set() per vertex was most of the bake)
      if (style) { sty[o * 4] = style[0]; sty[o * 4 + 1] = style[1]; sty[o * 4 + 2] = style[2]; sty[o * 4 + 3] = style[3]; }
      tints0[o * 4] = ta[0]; tints0[o * 4 + 1] = ta[1]; tints0[o * 4 + 2] = ta[2]; tints0[o * 4 + 3] = ta[3];
      tints1[o * 4] = tb[0]; tints1[o * 4 + 1] = tb[1]; tints1[o * 4 + 2] = tb[2]; tints1[o * 4 + 3] = tb[3];
      if (windowWords) { win[o * 2] = windowWords[0]; win[o * 2 + 1] = windowWords[1]; }
      if (centre) { centre[o * 2] = matrix.elements[12]; centre[o * 2 + 1] = matrix.elements[13]; }
    }
    if (nv) {
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], il[k]); hi[k] = Math.max(hi[k], ih[k]); }
      largest = Math.max(largest, Math.hypot(ih[0] - il[0], ih[1] - il[1], ih[2] - il[2]));
    }
    // Source triangles are clockwise; a mirrored placement reverses them.
    for (let k = 0; k < source.length; k += 3) {
      index[at + k] = first + source[k];
      index[at + k + 1] = first + source[mirrored ? k + 2 : k + 1];
      index[at + k + 2] = first + source[mirrored ? k + 1 : k + 2];
    }
    first += nv; at += source.length;
    yield;
  }
  return { index, pos, nrm, tan, uv, spec, col, sty, tints0, tints1, win, centre, slots, bones, weights, layers, bounds: [...lo, ...hi], largest };
}

/** A bake's arrays laid out for each program that draws the batch. */
export function assembleBakedGeometry(a: BakedArrays, input: Pick<BakeInputs, 'layouts' | 'skinned' | 'style'>): THREE.BufferGeometry[] {
  const { index, pos, nrm, tan, uv, spec, col, sty, win, centre, slots, bones, weights, largest } = a;
  const tints = [a.tints0, a.tints1];
  const indexAttribute = new THREE.BufferAttribute(index, 1);
  return input.layouts.map(({ elements, attributes }) => {
    const geometry = new THREE.BufferGeometry();
    // Elements are named FIELD_A, FIELD_B, ... in order; shaders may skip some.
    const byElement = elements.map((format, k) => ({
      format, name: attributes.find((a) => a.semantic === `FIELD_${String.fromCharCode(65 + k)}` && a.semanticIndex === 0)?.name,
    }));
    // Colour elements: a water surface's style colour then its colour; for
    // recoloured textures one or two tints precede the colour, which is last.
    // Skinned layouts: the first uint element is the bone indices, the unorm
    // element after it their weights; the rest follow the static layout.
    let normalSeen = 0, uvSeen = 0, colourSeen = 0;
    const boneAt = input.skinned ? elements.indexOf(VERTEX_FORMAT.UINT8X4) : -1;
    const colourCount = elements.filter((f, k) => f === VERTEX_FORMAT.UNORM8X4 && k !== boneAt + 1).length;
    const roles = byElement.map(({ format }, k) => {
      if (boneAt >= 0 && k === boneAt) return 'boneIndex';
      if (boneAt >= 0 && k === boneAt + 1) return 'boneWeight';
      if (format === VERTEX_FORMAT.FLOAT3) return 'position';
      if (format === VERTEX_FORMAT.UNORM10X3_2) return normalSeen++ === 0 ? 'normal' : 'tangent';
      if (format === VERTEX_FORMAT.UNORM16X2) return uvSeen++ === 0 ? 'uv' : 'uv2';
      if (format === VERTEX_FORMAT.UINT8X4) return 'specular';
      if (format === VERTEX_FORMAT.UNORM8X4) {
        const k = colourSeen++;
        if (k === colourCount - 1) return 'colour';
        return input.style ? 'style' : `tint${k}`;
      }
      if (format === VERTEX_FORMAT.FLOAT2) return 'position2';
      return 'unknown';
    });
    geometry.setIndex(indexAttribute);
    // what the instances span, in the frame they are baked in (skinned: their meshes' own space)
    geometry.userData.bounds = a.bounds;
    geometry.userData.largest = largest;
    if (slots) geometry.setAttribute('a_room', new THREE.BufferAttribute(slots, 1));
    if (a.layers) geometry.setAttribute('a_layer', new THREE.BufferAttribute(a.layers, 1));
    byElement.forEach(({ name }, k) => {
      if (!name) return;
      const role = roles[k];
      let attribute: THREE.BufferAttribute;
      if (role === 'position') attribute = new THREE.BufferAttribute(pos, 3);
      else if (role === 'normal') attribute = new THREE.BufferAttribute(nrm, 4);
      else if (role === 'tangent') attribute = new THREE.BufferAttribute(tan, 4);
      else if (role === 'uv') attribute = new THREE.BufferAttribute(uv, 2, true);
      else if (role === 'uv2') attribute = new THREE.BufferAttribute(win, 2, true);
      else if (role === 'specular') { attribute = new THREE.BufferAttribute(spec, 4); attribute.gpuType = THREE.IntType; }
      else if (role === 'colour') attribute = new THREE.BufferAttribute(col, 4, true);
      else if (role === 'style') attribute = new THREE.BufferAttribute(sty, 4, true);
      else if (role === 'tint0' || role === 'tint1') attribute = new THREE.BufferAttribute(tints[role === 'tint0' ? 0 : 1], 4, true);
      else if (role === 'boneIndex' && bones) { attribute = new THREE.BufferAttribute(bones, 4); attribute.gpuType = THREE.IntType; }
      else if (role === 'boneWeight' && weights) attribute = new THREE.BufferAttribute(weights, 4, true);
      else if (role === 'position2' && centre) attribute = new THREE.BufferAttribute(centre, 2);
      else return;
      geometry.setAttribute(name, attribute);
    });
    return geometry;
  });
}

/** The page's side of the bake worker (all rooms). A mesh read from the store goes to the worker once and is kept
 *  there; a posed one (a resting actor) goes with its one job. Null when no worker can be started; a failed
 *  job bakes on the page instead. */
export class GameBakeWorker {
  private readonly worker: Worker;
  private readonly sent = new WeakMap<DecodedMesh, number>();
  private nextMesh = 1;
  private nextJob = 1;
  private readonly jobs = new Map<number, { resolve: (a: BakedArrays) => void; reject: (e: Error) => void }>();
  private dead = false;

  static spawn(): GameBakeWorker | null {
    if (typeof Worker === 'undefined') return null;
    try { return new GameBakeWorker(); } catch { return null; }
  }

  private constructor() {
    // (emitted beside the other workers: tools/build.ts)
    this.worker = new Worker(new URL('/js/viewers/world/game-bake-worker.js', location.href), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent) => {
      const { id, ok, arrays, error } = event.data;
      const job = this.jobs.get(id);
      if (!job) return;
      this.jobs.delete(id);
      if (ok) job.resolve(arrays); else job.reject(new Error(error));
    };
    this.worker.onerror = () => this.fail('game bake worker failed');
  }

  private fail(why: string): void {
    this.dead = true;
    for (const job of this.jobs.values()) job.reject(new Error(why));
    this.jobs.clear();
  }

  /** The bake's geometries, the arithmetic in the worker (else on the page). */
  async bake(input: BakeInputs): Promise<THREE.BufferGeometry[]> {
    if (this.dead) return bakeGameGeometry(input);
    const meshes: { id: number; mesh: DecodedMesh }[] = [];
    const once: DecodedMesh[] = [];
    const instances = input.instances.map((instance) => {
      const mesh = decodeMesh(instance.payload);
      // (a stored payload's planes are text: kept by the worker; a posed one is used once)
      const keep = typeof instance.payload?.positions === 'string';
      let ref: number;
      if (keep) {
        let id = this.sent.get(mesh);
        if (!id) { id = this.nextMesh++; this.sent.set(mesh, id); meshes.push({ id, mesh }); }
        ref = id;
      } else { ref = once.length; once.push(mesh); }
      return { mesh: ref, once: !keep, matrix: instance.matrix.elements, tint: instance.tint, recolours: instance.recolours,
        uvAffine: instance.uvAffine, vertexTints: instance.vertexTints, slot: instance.slot,
        layer: instance.layer, specular: instance.specular, opacity: instance.opacity };
    });
    const { instances: _i, layouts: _l, ...options } = input;
    try {
      const arrays = await new Promise<BakedArrays>((resolve, reject) => {
        const id = this.nextJob++;
        this.jobs.set(id, { resolve, reject });
        this.worker.postMessage({ id, meshes, once, instances, options });
      });
      return assembleBakedGeometry(arrays, input);
    } catch {
      // (meshes this job sent may not have arrived: the worker is not trusted with them again)
      for (const { mesh } of meshes) this.sent.delete(mesh);
      return bakeGameGeometry(input);
    }
  }

  dispose(): void {
    this.fail('disposed');
    this.worker.terminate();
  }
}
