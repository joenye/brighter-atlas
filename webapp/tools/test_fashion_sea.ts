// Brighter Fashion's sea, laid out from a place's own water tile to the horizon in ever larger pieces: no hole anywhere
// (the room's own tiles that hold nothing are sea too: a view turned toward them looked through to the sky), and every
// larger piece meets its neighbours vertex for vertex along its edges, half a tile apart as the game's own tiles are
// (the waves lift both sides of an edge alike: no bright slit of sky between the pieces).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-fashion-sea-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({ stdin: { contents: "export { extendSea } from './src/fashion/gameroom.ts'; export * as THREE from './vendor/three.module.js';",
    resolveDir: path.resolve(import.meta.dirname, '..') }, bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error' });
  const { extendSea, THREE } = await import(pathToFileURL(file).href);
  const T = 1024;
  // a 3 x 3 grid tile over [-512, 512], as the game's water surface is
  const grid: number[] = [], uvs: number[] = [], idx: number[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { grid.push(-512 + 512 * i, -512 + 512 * j, 1024); uvs.push(i / 2, j / 2); }
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const a = j * 3 + i; idx.push(a, a + 1, a + 4, a, a + 4, a + 3); }
  const water = { positions: new Float32Array(grid), normals: new Float32Array(grid.map((_, k) => (k % 3 === 2 ? 1 : 0))), uvs: new Float32Array(uvs),
    indices: new Uint16Array(idx), idx_dtype: 'u16', bbox: [-512, -512, 1024, 512, 512, 1024] };
  const at = (x: number, y: number) => new THREE.Matrix4().makeTranslation((x + 0.5) * T, (y + 0.5) * T, 0);
  // a 6 x 4 room: water along its top row, sand on the rest but for two tiles with nothing at all
  const wet = [0, 1, 2, 3, 4, 5].map((x) => at(x, 3)), sand: any[] = [];
  for (let x = 0; x < 6; x++) for (let y = 0; y < 3; y++) if (!(x === 4 && y === 1) && !(x === 5 && y === 1)) sand.push(at(x, y));
  const batch = (payload: any, matrices: any[], w: any) => ({ category: 'terrain', mesh: 1, material: 1, payload, matrices, tints: matrices.map(() => null), water: w });
  const source = { batches: [batch(water, wet, { kind: 'surface', style: 0 }), batch({ ...water }, sand, null)], water: { styles: [] } };
  const out = extendSea(source, [6, 4], T);
  const sea = out.batches.filter((b: any) => b.water?.kind === 'surface');
  // every tile from the room out to 40 tiles round it is covered by the sea or the room's ground, and only once by sea
  const cover = new Map<string, number>();
  for (const b of sea) {
    const e = b.payload.bbox ?? [-512, -512, 0, 512, 512, 0];
    for (const m of b.matrices) {
      const lo = new THREE.Vector3(e[0], e[1], 0).applyMatrix4(m), hi = new THREE.Vector3(e[3], e[4], 0).applyMatrix4(m);
      for (let x = Math.round(Math.min(lo.x, hi.x) / T); x < Math.round(Math.max(lo.x, hi.x) / T); x++)
        for (let y = Math.round(Math.min(lo.y, hi.y) / T); y < Math.round(Math.max(lo.y, hi.y) / T); y++) cover.set(`${x},${y}`, (cover.get(`${x},${y}`) ?? 0) + 1);
    }
  }
  const ground = new Set(sand.map((m: any) => `${Math.floor(m.elements[12] / T)},${Math.floor(m.elements[13] / T)}`));
  const holes: string[] = [], twice: string[] = [];
  for (let x = -40; x < 46; x++) for (let y = -40; y < 44; y++) {
    const k = `${x},${y}`, n = cover.get(k) ?? 0;
    if (!n && !ground.has(k)) holes.push(k);
    if (n > 1) twice.push(k);
  }
  assert.deepEqual(holes, [], `no hole in the sea (${holes.slice(0, 6).join(' ')})`);
  assert.deepEqual(twice, [], `no tile laid twice (${twice.slice(0, 6).join(' ')})`);
  assert.ok(cover.has('4,1') && cover.has('5,1'), 'the room\'s empty tiles are sea');
  // every piece's edge vertices, as laid, half a tile apart
  let pieces = 0;
  for (const b of sea) {
    const p = b.payload.positions as Float32Array;
    for (const m of b.matrices) {
      const v = new THREE.Vector3(), pts: number[][] = [];
      for (let i = 0; i < p.length; i += 3) { v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m); pts.push([v.x, v.y]); }
      const xs = pts.map((q) => q[0]), x0 = Math.min(...xs), y0 = Math.min(...pts.map((q) => q[1]));
      const bottom = pts.filter((q) => Math.abs(q[1] - y0) < 1).map((q) => q[0]).sort((a, b) => a - b);
      for (let i = 1; i < bottom.length; i++) assert.ok(Math.abs(bottom[i] - bottom[i - 1] - 512) < 1, `edge vertices half a tile apart (${bottom[i] - bottom[i - 1]} at ${x0})`);
      pieces++;
    }
  }
  console.log(`fashion sea: ${pieces} pieces, no holes, edges matched`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
