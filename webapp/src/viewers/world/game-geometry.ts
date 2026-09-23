// Vertex data for the game's own programs: every placement of a batch is
// baked into one buffer in the native frame (as the game bakes its rooms),
// with the elements laid out as the program's vertex shader declares them:
// position (float3), normal and tangent (10:10:10:2 unorm, fed as the exact
// k/1023 values the hardware would produce), uv (16-bit unorm), specular
// bytes (uint) and vertex colour (8-bit unorm). The vertex colour is the
// room bake's: half the part colour (the placement tint), alpha the material
// opacity, truncated to bytes.
import { THREE } from '../three-common.js';
import { b64f32, b64u16, b64u32 } from '../../store.js';
import type { AttributeBinding } from './dxbc-glsl.js';
import { packColour } from '../../extract/world/tile-colour.js';

// Engine vertex formats (render tables).
export const VERTEX_FORMAT = { FLOAT2: 1, FLOAT3: 2, UNORM16X2: 20, UINT8X4: 24, UNORM8X4: 25, UNORM10X3_2: 26 } as const;

export interface TileColourGrid {
  x0: number; y0: number; width: number; height: number;
  /** RGBA per cell, row-major from (x0, y0). */
  colours: Float32Array;
}

/** Decode a shard's packed colour grid (palette + 16-bit cells). */
export function decodeTileColourGrid(encoded: any): TileColourGrid | null {
  if (!encoded || !Array.isArray(encoded.palette) || typeof encoded.cells !== 'string') return null;
  const cells = b64u16(encoded.cells);
  const { width, height } = encoded;
  if (!(width > 0 && height > 0) || cells.length !== width * height) return null;
  const colours = new Float32Array(width * height * 4);
  for (let i = 0; i < cells.length; i++) {
    const c = encoded.palette[cells[i]];
    if (!Array.isArray(c) || c.length !== 4) return null;
    colours.set(c, i * 4);
  }
  return { x0: encoded.x0, y0: encoded.y0, width, height, colours };
}

const f32 = Math.fround;
// fmod(x, 1) made positive, and the float-to-int truncation the bake uses.
const frac = (x: number) => { const r = f32(x % 1); return r < 0 ? f32(r + 1) : r; };

/** The room bake's tile colour at a native position (bilinear between tile centres). */
export function tileColourAt(grid: TileColourGrid, x: number, y: number, tileUnits: number, out: number[]): number[] {
  const gx = Math.min(Math.max(f32(f32(x / tileUnits) - 0.5 - grid.x0), 0), grid.width - 1);
  const gy = Math.min(Math.max(f32(f32(y / tileUnits) - 0.5 - grid.y0), 0), grid.height - 1);
  const x0 = Math.trunc(gx), x1 = Math.trunc(f32(gx + 0.99999));
  const y0 = Math.trunc(gy), y1 = Math.trunc(f32(gy + 0.99999));
  const fx = frac(gx), fy = frac(gy);
  const c = grid.colours, w = grid.width;
  for (let k = 0; k < 4; k++) {
    const c00 = c[(y0 * w + x0) * 4 + k], c10 = c[(y0 * w + x1) * 4 + k];
    const c01 = c[(y1 * w + x0) * 4 + k], c11 = c[(y1 * w + x1) * 4 + k];
    out[k] = f32(f32(f32(f32(c11 * fx) + f32(c01 * f32(1 - fx))) * fy) + f32(f32(f32(c10 * fx) + f32(c00 * f32(1 - fx))) * f32(1 - fy)));
  }
  return out;
}

export interface BakeInstance {
  /** This placement's mesh when it differs from the batch's (a draw group
   *  spans the meshes of one material). */
  payload?: any;
  /** Native-frame placement of the raw mesh (column-major 4x4). */
  matrix: THREE.Matrix4;
  /** The part colour (full range; its vertex colour is half of it), or null for neutral. */
  tint: number[] | null;
  /** The two recolour tints (half range RGBA), or null for neutral. */
  recolours?: number[][] | null;
}

export interface BakeInputs {
  /** Mesh payload (positions, normals, uvs, tangents, indices) of the
   *  instances that carry none of their own. */
  payload?: any;
  instances: BakeInstance[];
  elements: number[];                   // vertex shader element formats
  attributes: AttributeBinding[];       // the translated vertex shader's attributes
  specular: [number, number, number];
  opacity: number;
  /** The area colour grid tints only the flat floor tiles the game lays
   *  around the loaded area; block faces (ground and water) never take it. */
  grid: TileColourGrid | null;
  tileUnits: number;
  /** Water surfaces: the packed style colour bytes (their first colour element). */
  style?: [number, number, number, number];
  /** The neutral recolour tint (half range RGBA). */
  neutralTint?: number[];
  /** Water sides: the texture window (v range) as 16-bit unorm. */
  window?: [number, number];
}

const quantise10 = (v: number) => Math.min(1023, Math.max(0, Math.round((v + 1) * 511)));

/** Bake a batch into one geometry with the vertex shader's attribute layout. */
interface DecodedMesh {
  positions: Float32Array; normals: Float32Array; uvs: Float32Array; tangents: Float32Array | null;
  source: Uint16Array | Uint32Array; count: number;
}

function decodeMesh(payload: any): DecodedMesh {
  const positions = b64f32(payload.positions);
  return {
    positions, normals: b64f32(payload.normals), uvs: b64f32(payload.uvs),
    tangents: payload.tangents ? b64f32(payload.tangents) : null,
    source: payload.idx_dtype === 'u32' ? b64u32(payload.indices) : b64u16(payload.indices),
    count: positions.length / 3,
  };
}

export function bakeGameGeometry(input: BakeInputs): THREE.BufferGeometry {
  const { instances, elements, attributes } = input;
  const decoded = new Map<any, DecodedMesh>();
  const meshes = instances.map(({ payload = input.payload }) => {
    let mesh = decoded.get(payload);
    if (!mesh) decoded.set(payload, mesh = decodeMesh(payload));
    return mesh;
  });
  const total = meshes.reduce((n, m) => n + m.count, 0);
  const indices = meshes.reduce((n, m) => n + m.source.length, 0);
  const geometry = new THREE.BufferGeometry();
  const index = total > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  // Elements are named FIELD_A, FIELD_B, ... in order; shaders may skip some.
  const byElement = elements.map((format, k) => ({
    format, name: attributes.find((a) => a.semantic === `FIELD_${String.fromCharCode(65 + k)}` && a.semanticIndex === 0)?.name,
  }));
  // Colour elements: a water surface's style colour then its colour; for
  // recoloured textures one or two tints precede the colour, which is last.
  let normalSeen = 0, uvSeen = 0, colourSeen = 0;
  const colourCount = elements.filter((f) => f === VERTEX_FORMAT.UNORM8X4).length;
  const roles = byElement.map(({ format }) => {
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
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 4);
  const tan = new Float32Array(total * 4);
  const uv = new Uint16Array(total * 2);
  const spec = new Uint8Array(total * 4);
  const col = new Uint8Array(total * 4);
  const sty = new Uint8Array(total * 4);
  const tints = [new Uint8Array(total * 4), new Uint8Array(total * 4)];
  const win = new Uint16Array(total * 2);
  const neutral = packColour(input.neutralTint ?? [127 / 255, 127 / 255, 127 / 255, 1]);
  const p = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3();
  const rotation = new THREE.Matrix3();
  const cell = [0, 0, 0, 0];
  const opacityByte = Math.trunc(f32(f32(input.opacity) * 255));
  let first = 0, at = 0;
  for (let i = 0; i < instances.length; i++) {
    const { matrix, tint, recolours } = instances[i];
    const { positions, normals, uvs, tangents, source, count: nv } = meshes[i];
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
      uv[o * 2] = Math.round(uvs[v * 2] * 65535); uv[o * 2 + 1] = Math.round(uvs[v * 2 + 1] * 65535);
      spec[o * 4] = input.specular[0]; spec[o * 4 + 1] = input.specular[1]; spec[o * 4 + 2] = input.specular[2];
      if (input.grid) tileColourAt(input.grid, p.x, p.y, input.tileUnits, cell);
      else { cell[0] = cell[1] = cell[2] = 1; }
      for (let k = 0; k < 3; k++) col[o * 4 + k] = Math.min(255, Math.trunc(f32(f32(base[k] * cell[k]) * 255)));
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
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
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
    else return;
    geometry.setAttribute(name, attribute);
  });
  // three.js requires a 'position' attribute for bounds; keep the real one too.
  if (!geometry.getAttribute('position')) geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.computeBoundingSphere();
  return geometry;
}
