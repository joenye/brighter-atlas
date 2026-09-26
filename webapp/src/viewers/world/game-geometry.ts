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
import { THREE } from '../three-common.js';
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
}

export interface BakeInputs {
  instances: BakeInstance[];
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

interface DecodedMesh {
  positions: Float32Array; normals: Float32Array; uvs: Float32Array; tangents: Float32Array | null;
  source: Uint16Array | Uint32Array; count: number;
  boneIndices: Uint8Array | null; boneWeights: Uint8Array | null;
}

// A stream is base64 in a stored payload, or already decoded (a posed copy).
const floats = (v: any): Float32Array => (v instanceof Float32Array ? v : b64f32(v));

function decodeMesh(payload: any): DecodedMesh {
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

/** Bake a batch once into one geometry per layout, each with that vertex
 *  shader's attribute layout. */
export function bakeGameGeometry(input: BakeInputs): THREE.BufferGeometry[] {
  const { instances } = input;
  const decoded = new Map<any, DecodedMesh>();
  const meshes = instances.map(({ payload }) => {
    let mesh = decoded.get(payload);
    if (!mesh) decoded.set(payload, mesh = decodeMesh(payload));
    return mesh;
  });
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
  const win = new Uint16Array(total * 2);
  const bones = input.skinned ? new Uint8Array(total * 4) : null;
  const weights = input.skinned ? new Uint8Array(total * 4) : null;
  const neutral = packColour([127 / 255, 127 / 255, 127 / 255, 1]);   // neutral recolour tint (half range)
  const p = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3();
  const rotation = new THREE.Matrix3();
  const opacityByte = Math.trunc(f32(f32(input.opacity) * 255));
  let first = 0, at = 0;
  for (let i = 0; i < instances.length; i++) {
    const { matrix, tint, recolours, uvAffine, vertexTints } = instances[i];
    const { positions, normals, uvs, tangents, source, count: nv, boneIndices, boneWeights } = meshes[i];
    if (bones && boneIndices && boneWeights) { bones.set(boneIndices.subarray(0, nv * 4), first * 4); weights!.set(boneWeights.subarray(0, nv * 4), first * 4); }
    const tintBytes = [0, 1].map((k) => (recolours?.[k] ? packColour(recolours[k]) : neutral));
    rotation.setFromMatrix4(matrix);
    const mirrored = matrix.determinant() < 0;
    const base = tint ? [f32(tint[0] * 0.5), f32(tint[1] * 0.5), f32(tint[2] * 0.5)] : [0.5, 0.5, 0.5];
    for (let v = 0; v < nv; v++) {
      const o = first + v;
      p.fromArray(positions, v * 3).applyMatrix4(matrix);
      pos[o * 3] = p.x; pos[o * 3 + 1] = p.y; pos[o * 3 + 2] = p.z;
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
        const unit = (x: number) => Math.min(65535, Math.max(0, Math.trunc(x)));
        uv[o * 2] = unit(f32(f32(tx * 65535) + f32(f32(m00 * u16) + f32(m01 * v16))));
        uv[o * 2 + 1] = unit(f32(f32(ty * 65535) + f32(f32(m10 * u16) + f32(m11 * v16))));
      } else {
        uv[o * 2] = u16; uv[o * 2 + 1] = v16;
      }
      spec[o * 4] = input.specular[0]; spec[o * 4 + 1] = input.specular[1]; spec[o * 4 + 2] = input.specular[2];
      const grid = vertexTints?.[v];
      for (let k = 0; k < 3; k++) col[o * 4 + k] = Math.min(255, Math.trunc(f32((grid ? f32(base[k] * grid[k]) : base[k]) * 255)));
      col[o * 4 + 3] = opacityByte;
      if (input.style) sty.set(input.style, o * 4);
      tints[0].set(tintBytes[0], o * 4); tints[1].set(tintBytes[1], o * 4);
      if (input.window) { win[o * 2] = input.window[0]; win[o * 2 + 1] = input.window[1]; }
    }
    // Source triangles are clockwise; a mirrored placement reverses them.
    for (let k = 0; k < source.length; k += 3) {
      index[at + k] = first + source[k];
      index[at + k + 1] = first + source[mirrored ? k + 2 : k + 1];
      index[at + k + 2] = first + source[mirrored ? k + 1 : k + 2];
    }
    first += nv; at += source.length;
  }
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
      else return;
      geometry.setAttribute(name, attribute);
    });
    return geometry;
  });
}
