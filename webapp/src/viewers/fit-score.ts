// Texture "fit" scoring — how well a texture WRAPS a given mesh's UV layout.
// Pure and worker-safe (no DOM, no THREE); shared by the main thread (feature
// extraction from the loaded geometry) and fit-worker.js (per-texture scoring).
//
// Two geometry-intrinsic signals (no semantic prior needed):
//   1. SEAM COHERENCE — where the mesh is cut in UV space (two triangles that
//      touch in 3D but are separated in the atlas), a correctly-authored
//      texture has matching colour on both sides of the cut. Wrong texture ->
//      colour breaks at the seam. This is the decisive signal.
//   2. ISLAND / CONTENT ALIGNMENT — authored content (opaque, detailed) should
//      fall UNDER the mesh's UV footprint; padding/transparency should fall
//      between islands. Weaker, but free, and strong for cutout/atlas art.
//
// Caveat baked into the weighting: for flat or fully-tiling textures neither
// signal is discriminative, so a flat texture is pulled toward NEUTRAL rather
// than scoring a false-perfect seam match (cohConf below). Treat the result as
// a candidate RANKER (surfaces the UV-compatible family), not ground truth.

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const SEAM_TRIM = 0.85;       // fraction of best seams averaged for coherence (drop worst = hard cuts)
const DENSITY_TARGET = 0.03;  // target texels-per-world-area (geo-mean across ground truths)
const DENSITY_SCALE = 2.5;    // log2 tolerance: only gross resolution misfits are penalised
const DENSITY_WEIGHT = 0.15;  // blend weight of the texel-density prior

export interface FitGeometry {
  positions: ArrayLike<number>;
  uvs: ArrayLike<number>;     // GL-flipped (v-up), matching THREE geo.attributes.uv
  index: ArrayLike<number>;
}

export interface FitFeatures {
  mask: Uint8Array;
  maskW: number;
  maskH: number;
  seams: Float32Array;
  coverage?: number;
  area?: number;
}

// Rasterise one UV triangle (coords in [0,1], DirectX v-down) into the mask.
function rasterTri(mask: Uint8Array, N: number, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void {
  const gx0 = x0 * N, gy0 = y0 * N, gx1 = x1 * N, gy1 = y1 * N, gx2 = x2 * N, gy2 = y2 * N;
  const d = (gy1 - gy2) * (gx0 - gx2) + (gx2 - gx1) * (gy0 - gy2);
  if (Math.abs(d) < 1e-9) return;
  let minX = Math.floor(Math.min(gx0, gx1, gx2)), maxX = Math.ceil(Math.max(gx0, gx1, gx2));
  let minY = Math.floor(Math.min(gy0, gy1, gy2)), maxY = Math.ceil(Math.max(gy0, gy1, gy2));
  minX = clamp(minX, 0, N - 1); maxX = clamp(maxX, 0, N - 1);
  minY = clamp(minY, 0, N - 1); maxY = clamp(maxY, 0, N - 1);
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5, cy = py + 0.5;
      const l0 = ((gy1 - gy2) * (cx - gx2) + (gx2 - gx1) * (cy - gy2)) / d;
      const l1 = ((gy2 - gy0) * (cx - gx2) + (gx0 - gx2) * (cy - gy2)) / d;
      const l2 = 1 - l0 - l1;
      if (l0 >= -1e-4 && l1 >= -1e-4 && l2 >= -1e-4) mask[py * N + px] = 1;
    }
  }
}

// Find UV seams: mesh edges shared by two triangles whose UVs diverge across the
// shared 3D edge. Returns Float32Array of sample pairs [ax,ay,bx,by, ...] in
// stored (DirectX v-down) UV space — colours at (ax,ay) and (bx,by) should match.
function buildSeams(positions: ArrayLike<number>, uvs: ArrayLike<number>, index: ArrayLike<number>, cap = 300): Float32Array {
  const nV = positions.length / 3;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < nV; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
    if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
  }
  const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) || 1;
  const q = diag * 1e-4;                    // weld tolerance
  const wid = new Int32Array(nV);
  const wmap = new Map<string, number>();
  let next = 0;
  for (let i = 0; i < nV; i++) {
    const k = `${Math.round(positions[i * 3] / q)},${Math.round(positions[i * 3 + 1] / q)},${Math.round(positions[i * 3 + 2] / q)}`;
    let w = wmap.get(k);
    if (w === undefined) { w = next++; wmap.set(k, w); }
    wid[i] = w;
  }
  // edge (welded pair, oriented w1<w2) -> occurrences as [origLo, origHi]
  const em = new Map<number, [number, number][]>();
  const addEdge = (a: number, b: number) => {
    let w1 = wid[a], w2 = wid[b], ka = a, kb = b;
    if (w1 > w2) { const t = w1; w1 = w2; w2 = t; ka = b; kb = a; }
    if (w1 === w2) return;                   // degenerate
    const key = w1 * next + w2;
    let arr = em.get(key);
    if (!arr) { arr = []; em.set(key, arr); }
    arr.push([ka, kb]);                      // ka welds to w1, kb welds to w2
  };
  const nTri = index.length / 3;
  for (let t = 0; t < nTri; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
  }
  const su = (vi: number) => uvs[vi * 2];
  const sv = (vi: number) => 1 - uvs[vi * 2 + 1];    // GL v-up -> stored DirectX v-down
  const seamEdges: [[number, number], [number, number]][] = [];
  for (const arr of em.values()) {
    if (arr.length !== 2) continue;          // only clean 2-triangle edges
    const p = arr[0], r = arr[1];
    const disc = Math.abs(su(p[0]) - su(r[0])) + Math.abs(sv(p[0]) - sv(r[0]))
               + Math.abs(su(p[1]) - su(r[1])) + Math.abs(sv(p[1]) - sv(r[1]));
    if (disc > 1e-4) seamEdges.push([p, r]);
  }
  const stride = Math.max(1, Math.ceil(seamEdges.length / cap));
  const out: number[] = [];
  for (let i = 0; i < seamEdges.length; i += stride) {
    const [p, r] = seamEdges[i];
    for (const s of [0.3, 0.5, 0.7]) {
      out.push(
        su(p[0]) + (su(p[1]) - su(p[0])) * s, sv(p[0]) + (sv(p[1]) - sv(p[0])) * s,
        su(r[0]) + (su(r[1]) - su(r[0])) * s, sv(r[0]) + (sv(r[1]) - sv(r[0])) * s,
      );
    }
  }
  return new Float32Array(out);
}

// Extract per-mesh fit features once (main thread), from the loaded geometry.
export function buildFitFeatures({ positions, uvs, index }: FitGeometry,
  { mask: N = 128, seamCap = 300 }: { mask?: number; seamCap?: number } = {}): FitFeatures {
  const mask = new Uint8Array(N * N);
  const su = (vi: number) => uvs[vi * 2];
  const sv = (vi: number) => 1 - uvs[vi * 2 + 1];
  const nTri = index.length / 3;
  for (let t = 0; t < nTri; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
    rasterTri(mask, N, su(a), sv(a), su(b), sv(b), su(c), sv(c));
  }
  let covered = 0;
  for (let i = 0; i < mask.length; i++) covered += mask[i];
  // world surface area (sum of triangle areas) — for the texel-density prior:
  // a bigger mesh generally carries a more detailed (higher-res) texture, at
  // roughly constant texels-per-world-area. Combined with each texture's native
  // resolution downstream.
  let area = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area += 0.5 * Math.hypot(cx, cy, cz);
  }
  return { mask, maskW: N, maskH: N, seams: buildSeams(positions, uvs, index, seamCap), coverage: covered / mask.length, area };
}

// bilinear sample of an RGBA buffer at normalised (u,v); wraps (repeat) so tiling
// UVs sample sanely.
function sampleBilinear(rgba: ArrayLike<number>, W: number, H: number, u: number, v: number): [number, number, number] {
  u -= Math.floor(u); v -= Math.floor(v);
  const fx = clamp(u * (W - 1), 0, W - 1), fy = clamp(v * (H - 1), 0, H - 1);
  const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const o00 = (y0 * W + x0) * 4, o10 = (y0 * W + x1) * 4, o01 = (y1 * W + x0) * 4, o11 = (y1 * W + x1) * 4;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const ch = (k: number) => lerp(lerp(rgba[o00 + k], rgba[o10 + k], tx), lerp(rgba[o01 + k], rgba[o11 + k], tx), ty);
  return [ch(0), ch(1), ch(2)];
}

export interface FitScore {
  fit: number;
  coherence: number | null;
  iou: number | null;
  res: number | null;
  alignTerm: number;
  alphaGap: number;
  std: number;
}

// Score how well a texture wraps the mesh. Higher = better fit.
export function scoreTexture(features: FitFeatures, rgba: ArrayLike<number>, W: number, H: number, nativeW = 0, nativeH = 0): FitScore {
  const { mask, maskW, maskH, seams, coverage = 0, area = 0 } = features;
  const lum = (o: number) => 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  let aIn = 0, aOut = 0, nIn = 0, nOut = 0, eIn = 0, eOut = 0, sumL = 0, sumL2 = 0, nAll = 0;
  let inter = 0, uni = 0, opaqueN = 0;   // opaque∩coverage / opaque∪coverage, for silhouette IoU
  for (let y = 0; y < H; y++) {
    const my = Math.min(maskH - 1, (y * maskH / H) | 0);
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const inside = mask[my * maskW + Math.min(maskW - 1, (x * maskW / W) | 0)];
      const a = rgba[o + 3] / 255;
      const L = lum(o);
      sumL += L; sumL2 += L * L; nAll++;
      const gx = x + 1 < W ? Math.abs(L - lum(o + 4)) : 0;
      const gy = y + 1 < H ? Math.abs(L - lum(o + W * 4)) : 0;
      if (inside) { aIn += a; eIn += gx + gy; nIn++; } else { aOut += a; eOut += gx + gy; nOut++; }
      const op = a > 0.5 ? 1 : 0;
      if (op) opaqueN++;
      if (inside && op) inter++;
      if (inside || op) uni++;
    }
  }
  const alphaGap = (nIn ? aIn / nIn : 0) - (nOut ? aOut / nOut : 0);
  const edgeGap = (nIn ? eIn / nIn : 0) / 255 - (nOut ? eOut / nOut : 0) / 255;
  const alignTerm = 0.5 + 0.5 * clamp(alphaGap + 0.5 * edgeGap, -1, 1);

  // Silhouette IoU — for CUTOUT textures (meaningful transparency), the opaque
  // region should coincide with the mesh's UV footprint. Very discriminative and
  // works even when the mesh has few seams (equipment). Skipped (neutral) for
  // fully-opaque textures where alpha carries no shape information.
  const opaqueFrac = opaqueN / Math.max(1, nAll);
  const hasAlpha = opaqueFrac > 0.02 && opaqueFrac < 0.92;
  const iouTerm = hasAlpha ? (uni ? inter / uni : 0) : null;

  const mean = sumL / Math.max(1, nAll) / 255;
  const std = Math.sqrt(Math.max(0, sumL2 / Math.max(1, nAll) / (255 * 255) - mean * mean));
  // Confidence in the seam signal = the texture's LOCAL high-frequency detail, not
  // its global spread. A soft gradient has high std yet is locally smooth, so its
  // seams match trivially on any mesh (a false-positive) — gating on local edge
  // energy neutralises it, while a busy authored skin/armour keeps full confidence.
  const meanEdge = (eIn + eOut) / Math.max(1, nAll) / 255;
  const cohConf = clamp(meanEdge / 0.035, 0, 1);

  let coherence: number | null = null;
  if (seams && seams.length) {
    const diffs: number[] = [];
    for (let i = 0; i < seams.length; i += 4) {
      const ca = sampleBilinear(rgba, W, H, seams[i], seams[i + 1]);
      const cb = sampleBilinear(rgba, W, H, seams[i + 2], seams[i + 3]);
      diffs.push((Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2])) / 765);
    }
    // TRIMMED mean of the best 70% of seams: drop the worst 30% as hard-edged
    // atlas cuts that even the CORRECT texture legitimately breaks at (high-island
    // meshes — helmets, capes), then judge the continuity seams' break magnitude
    // relative to the texture's own detail scale. Robust yet still graded, so a
    // merely smooth fill can't win (cohConf also neutralises flat textures).
    diffs.sort((p, q) => p - q);
    const keep = Math.max(1, Math.ceil(diffs.length * SEAM_TRIM));
    let sum = 0;
    for (let i = 0; i < keep; i++) sum += diffs[i];
    const trimmed = sum / keep;
    const rawCoh = 1 - clamp(trimmed / Math.max(0.06, std), 0, 1);
    coherence = 0.5 + (rawCoh - 0.5) * cohConf;
  }
  // Texel-density prior — bigger mesh -> higher-res texture, at roughly constant
  // texels-per-world-area. Penalises gross resolution mismatch (e.g. a 256² skin
  // on a tiny helmet) on a generous log scale. DELIBERATELY gentle + wide: the
  // target density varies by asset class (creatures ~0.01, equipment ~0.05), so
  // this only culls extreme misfits rather than pinning an exact resolution.
  let resTerm: number | null = null;
  const nativeRes = Math.max(nativeW, nativeH);
  if (nativeRes > 0 && area > 0) {
    const expectedRes = Math.sqrt(DENSITY_TARGET * area / Math.max(0.05, coverage));
    resTerm = 1 - clamp(Math.abs(Math.log2(nativeRes / expectedRes)) / DENSITY_SCALE, 0, 1);
  }

  // Present-weighted blend: seam coherence (when the mesh has seams) + silhouette
  // IoU (when the texture is a cutout) + texel-density + a content-alignment tiebreak.
  let num = 0.15 * alignTerm, den = 0.15;
  if (coherence != null) { num += 0.5 * coherence; den += 0.5; }
  if (iouTerm != null) { num += 0.4 * iouTerm; den += 0.4; }
  if (resTerm != null) { num += DENSITY_WEIGHT * resTerm; den += DENSITY_WEIGHT; }
  const fit = num / den;
  return { fit, coherence, iou: iouTerm, res: resTerm, alignTerm, alphaGap, std };
}
