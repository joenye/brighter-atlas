// Interior rotations follow normalized linear interpolation; endpoints retain
// their stored values. Exercise playback in both directions with real matrices.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-clip-sampling-'));
try {
  const file = path.join(dir, 'test.mjs');
  await build({stdin: {contents: "export {Rig, ClipSampler} from './src/viewers/rig.ts'; export {decodeAnim} from './src/extract/anim.ts'; export * from './vendor/three.module.js';",
    resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const T = await import(pathToFileURL(file).href);
  const rig = new T.Rig({i: 0, bones: [{parent: -1, scale: [1,1,1], quat: [0,0,0,1], trans: [0,0,0],
    bind: [1,0,0,0,0,1,0,0,0,0,1,0]}]});
  const clip = (keys: number[]) => new T.ClipSampler({i: 0, skel: 0, duration_ms: 20, frame_ms: 20, frames: 2,
    bones: [{present: true, rot: {mode: 'track', data: Buffer.from(new Float32Array(keys).buffer).toString('base64')}}]});
  const close = (actual: number[], expected: number[], epsilon = 1e-7) => {
    actual.forEach((v, i) => assert(Math.abs(v - expected[i]) < epsilon, `${actual} != ${expected}`));
  };
  for (const sign of [1, -1]) {
    const sampler = clip([0,0,0,1, 0,sign*Math.sqrt(3)/2,0,sign*.5]);
    for (const [time, expected] of [[5,[23/26,0,-7*Math.sqrt(3)/26]], [5.9,[23/26,0,-7*Math.sqrt(3)/26]],
      [15,[-1/26,0,-15*Math.sqrt(3)/26]], [5,[23/26,0,-7*Math.sqrt(3)/26]]] as const) {
      sampler.apply(rig, time); rig.bones[0].updateMatrixWorld(true);
      close(new T.Vector3(1,0,0).applyMatrix4(rig.bones[0].matrixWorld).toArray(), [...expected]);
    }
  }
  const endpoints = new Float32Array([0,0,0,.9999, 0,1.0001,0,0]);
  const endpointClip = clip(Array.from(endpoints));
  for (const [time, offset] of [[-3,0], [0,0], [20,4], [400,4]]) {
    endpointClip.apply(rig, time);
    close(rig.bones[0].quaternion.toArray(), Array.from(endpoints.slice(offset, offset + 4)), 1e-12);
  }
  const tiny = clip([.001,0,0,.002, 0,.003,0,.001]);
  tiny.apply(rig, 10);
  close(rig.bones[0].quaternion.toArray(), [.0005,.0015,0,.0015]);
  rig.bones[0].updateMatrixWorld(true);
  assert(new T.Vector3(1,0,0).applyMatrix4(rig.bones[0].matrixWorld).length() < .00001);
  const threshold = T.decodeAnim(new Uint8Array([1,0]), {flags: 0x3e800000}).scale_threshold;
  assert.equal(threshold, .25);
  const scaleTrack = new T.ClipSampler({i: 0, skel: 0, duration_ms: 20, frame_ms: 20, frames: 2,
    scale_threshold: threshold, bones: [{present: true, scale: {mode: 'track',
      data: Buffer.from(new Float32Array([2,-2,.3, -3,4,.1]).buffer).toString('base64')}}]});
  for (const time of [10,10,5,10]) {
    scaleTrack.apply(rig, time);
    close(rig.bones[0].scale.toArray(), [2,-2+6*time/20,Math.fround(.3)]);
  }
  scaleTrack.apply(rig, 20); close(rig.bones[0].scale.toArray(), [-3,4,Math.fround(.1)]);
  const scaledRest = new T.Rig({i: 0, bones: [{parent: -1, scale: [2,3,4], quat: [0,0,0,1], trans: [0,0,0],
    bind: [2,0,0,0,0,3,0,0,0,0,4,0]}]});
  endpointClip.apply(scaledRest, 0); close(scaledRest.bones[0].scale.toArray(), [1,1,1]);
  scaledRest.skeleton.dispose();
  rig.resetToRest(); close(rig.bones[0].quaternion.toArray(), [0,0,0,1]);
  rig.skeleton.dispose();
  console.log('Clip interpolation, quantized endpoints, scale threshold, absent scale, rewind and reset passed');
} finally { await rm(dir, {recursive: true, force: true}); }
