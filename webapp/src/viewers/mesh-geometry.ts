// Shared mesh-payload -> BufferGeometry builder (stored-convention handling:
// CW->CCW winding, DirectX->GL v, global ab6 bone ids as skin indices), with
// bone-influence vertex colors, plus the 2D UV-layout overlay renderer.
// Used by the mesh view and the skeleton composite view.

import { THREE } from './three-common.js';
import { b64f32, b64u16, b64u32, b64u8 } from '../store.js';
import { el, hashColorRGB, hashColor } from '../ui.js';

// `boneColors: false` skips the bone-influence vertex-color attribute — the
// world renderer never enables vertexColors on its materials, and computing
// the palette per vertex across a 451-room stream is pure waste there. Every
// other caller keeps the default (mesh/skeleton views render the colors).
export function buildMeshGeometry(m: any, { boneColors = true }: { boneColors?: boolean } = {}): { geo: THREE.BufferGeometry; skinned: boolean } {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(b64f32(m.positions), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(b64f32(m.normals), 3));
  const uvs = b64f32(m.uvs);
  for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i]; // DirectX v -> GL v
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (m.tangents) geo.setAttribute('tangent', new THREE.BufferAttribute(b64f32(m.tangents), 4));
  const idx = m.idx_dtype === 'u32' ? b64u32(m.indices) : b64u16(m.indices);
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } // CW -> CCW
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  const skinned = !!(m.skinned && m.bone_indices && m.bone_weights && m.skel >= 0);
  if (m.bone_indices && m.bone_weights && (skinned || boneColors)) {
    const boneIdx = b64u8(m.bone_indices);
    const boneWgt = b64u8(m.bone_weights);
    if (skinned) {
      geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(boneIdx), 4));
      const w = new Float32Array(boneWgt.length);
      for (let i = 0; i < w.length; i++) w[i] = boneWgt[i] / 255;
      geo.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    }
    if (boneColors) {
      // bone-influence vertex colors (weighted palette by GLOBAL bone id)
      const col = new Float32Array(m.v * 3);
      for (let v = 0; v < m.v; v++) {
        let r = 0, g = 0, b = 0;
        for (let k = 0; k < 4; k++) {
          const w = boneWgt[v * 4 + k] / 255;
          if (!w) continue;
          const c = hashColorRGB(boneIdx[v * 4 + k]);
          r += c[0] * w; g += c[1] * w; b += c[2] * w;
        }
        col[v * 3] = r; col[v * 3 + 1] = g; col[v * 3 + 2] = b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
  }
  return { geo, skinned };
}

// 2D UV-layout overlay (drawn in stored DirectX orientation: v down).
// Accepts several geometries; each gets its own stable color when >1.
export function drawUVLayout(geos: THREE.BufferGeometry[], size: number, labels: number[] | null = null): HTMLCanvasElement {
  const cv = el('canvas', { class: 'uv-overlay', width: size, height: size });
  const g = cv.getContext('2d')!;
  g.fillStyle = 'rgba(10,12,16,0.92)';
  g.fillRect(0, 0, size, size);
  g.lineWidth = 1;
  geos.forEach((geo, gi) => {
    g.strokeStyle = geos.length > 1 ? hashColor(labels?.[gi] ?? gi, 60, 55).replace(')', ',0.35)').replace('hsl', 'hsla') : 'rgba(120,183,255,0.16)';
    const uv = geo.attributes.uv.array;   // already GL-flipped; undo for display
    const idx = geo.index!.array;
    const nTri = idx.length / 3;
    const step = Math.max(1, Math.ceil(nTri / Math.max(4000, 25000 / geos.length)));
    g.beginPath();
    for (let t = 0; t < nTri; t += step) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      g.moveTo(uv[a * 2] * size, (1 - uv[a * 2 + 1]) * size);
      g.lineTo(uv[b * 2] * size, (1 - uv[b * 2 + 1]) * size);
      g.lineTo(uv[c * 2] * size, (1 - uv[c * 2 + 1]) * size);
      g.closePath();
    }
    g.stroke();
  });
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.strokeRect(0.5, 0.5, size - 1, size - 1);
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.font = '10px monospace';
  g.fillText(`UV (DirectX v↓)${geos.length > 1 ? ` × ${geos.length}` : ''}`, 6, 12);
  return cv;
}
