import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-ground-edge-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export {planeBrightness, planeEdgeWidth, planeEdgeData, planeUniforms} from './src/viewers/world/ground-plane.ts';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error'});
  const G = await import(pathToFileURL(file).href);
  // brightness: a positive scale, the game's 1 otherwise
  assert.equal(G.planeBrightness(undefined), 1);
  assert.equal(G.planeBrightness('0.5'), 0.5);
  assert.equal(G.planeBrightness(0), 1);
  assert.equal(G.planeBrightness(-2), 1);
  assert.equal(G.planeUniforms({}, 10, 1.5).planeBrightness.value, 1.5);
  assert.equal(G.planeUniforms({}).planeBrightness.value, 1);
  // the soft edge: two tiles wide, half a short floor
  assert.equal(G.planeEdgeWidth(10), 2);
  assert.equal(G.planeEdgeWidth(3), 1.5);
  assert.equal(G.planeEdgeWidth(1), 0.5);
  // the edge's pieces nearest first, each corner at its place with its distance past the rooms
  const tile = (x: number, y: number, cover: number, beyond: number[]) => ({x, y, size: [1, 1], cover, beyond, record: {}, cell: [0, 0], tints: [], room: 0});
  const {vertices, indices, covers} = G.planeEdgeData([tile(5, 0, 3, [2, 2.5, 3, 3.5]), tile(-1, 2, 1, [0, 0.4, 1, 1.2])], 1024);
  assert.deepEqual([...covers], [1, 3]);
  assert.deepEqual([...vertices.slice(0, 4)], [-1024, 2048, 0, 0]);
  assert.deepEqual([...vertices.slice(4, 8)], [-1024, 3072, 0, Math.fround(0.4)]);
  assert.deepEqual([...vertices.slice(16, 20)], [5120, 0, 0, 2]);
  assert.deepEqual([...vertices.slice(28, 32)], [6144, 1024, 0, 3.5]);
  assert.deepEqual([...indices], [0, 1, 2, 3, 2, 1, 4, 5, 6, 7, 6, 5]);
  console.log('Ground plane: brightness setting, soft edge width and pieces');
} finally { await rm(tmp, {recursive: true, force: true}); }
