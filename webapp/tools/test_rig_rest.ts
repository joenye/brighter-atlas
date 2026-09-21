// Stored rest matrices must survive skinning, clip changes and reset.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-rig-rest-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {
    contents: "export {Rig, ClipSampler} from './src/viewers/rig.ts'; export {restWorldMatrices} from './src/extract/skeleton.ts'; export * from './vendor/three.module.js';",
    resolveDir: path.resolve(import.meta.dirname, '..'),
  }, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const T = await import(pathToFileURL(file).href);
  // A reflection and shear exercise information a TRS reconstruction loses.
  const bones = [
    {parent: -1, scale: [1, 1, 1], quat: [0, 0, 0, 1], trans: [3, 4, 5],
      bind: [-1, .25, 0, 3, 0, 2, .125, 4, 0, 0, 1, 5]},
    {parent: 0, scale: [1, 1, 1], quat: [0, 0, 0, 1], trans: [6, 7, 8],
      bind: [1, 0, 0, 6, .5, 1, 0, 7, 0, 0, 1, 8]},
  ];
  const rig = new T.Rig({i: 0, bones});
  const parent = new T.Group(); parent.add(...rig.roots);
  const expected = [
    new T.Matrix4().set(-1, .25, 0, 3, 0, 2, .125, 4, 0, 0, 1, 5, 0, 0, 0, 1),
    new T.Matrix4().set(-.875, .25, 0, -1.25, 1, 2, .125, 19, 0, 0, 1, 13, 0, 0, 0, 1),
  ];
  const close = (a: number[], b: number[]) => a.forEach((v, i) => assert(Math.abs(v - b[i]) < 1e-9));
  function checkRest() {
    parent.updateMatrixWorld(true); rig.skeleton.update();
    for (let i = 0; i < 2; i++) {
      close(rig.bones[i].matrixWorld.elements, expected[i].elements);
      close(rig.skeleton.boneMatrices.slice(i * 16, i * 16 + 16), new T.Matrix4().elements);
    }
  }
  checkRest();
  const extracted = T.restWorldMatrices(bones);
  extracted.forEach((m: number[], i: number) => close(m, expected[i].elements));
  const info = rig.restWorldInfo();
  extracted.forEach((m: number[], i: number) => close(m.slice(12, 15), info.positions[i].toArray()));
  const clip = new T.ClipSampler({i: 0, skel: 0, duration_ms: 20, frames: 1, bones: [
    {present: true, trans: {mode: 'const', value: [20, 30, 40]}}, null,
  ]});
  clip.apply(rig, 0); parent.updateMatrixWorld(true);
  assert.equal(rig.bones[0].matrixAutoUpdate, false);
  close(rig.bones[0].matrixWorld.elements, new T.Matrix4().makeTranslation(20, 30, 40).elements);
  close(rig.bones[1].matrix.elements, new T.Matrix4().set(1, 0, 0, 6, .5, 1, 0, 7, 0, 0, 1, 8, 0, 0, 0, 1).elements);
  rig.resetToRest(); checkRest();
  clip.apply(rig, 0);
  const empty = new T.ClipSampler({i: 1, skel: 0, duration_ms: 20, frames: 1, bones: []});
  empty.apply(rig, 0); checkRest();
  console.log('Full affine rest pose, identity skinning, extraction, animation and reset checks passed');
} finally {
  await rm(tmp, {recursive: true, force: true});
}
