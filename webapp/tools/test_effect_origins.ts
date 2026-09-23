import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-origins-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export * from './src/extract/world/effect-origins.ts'; export {EmitterSim, hash32} from './src/viewers/world/effects-sim.ts'; export {EffectRandom} from './src/viewers/world/effects-random.ts';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const T = await import(pathToFileURL(file).href);
  const binding = {instance: 12, kind: 'radial', resample: 32, center: 20, radius: 21, axisScale: [22, 23], yaw: [24, 25], pitch: [26, 27], samples: [28, 29], overrides: [30, 31], uniformClass: 8};
  assert(T.validEffectOrigins([binding]));
  assert(!T.validEffectOrigins([binding, binding]));
  assert(!T.validEffectOrigins([{...binding, samples: [28]}]));
  const scalar = (op: number, value: number) => ({op, kind: 'float', value});
  const ops = [{op: 20, kind: 'vec3', v: [10, 20, 30]}, {op: 21, kind: 'fixed', floats: [7]},
    scalar(22, 2), scalar(23, .5), scalar(24, 45), scalar(25, 135), scalar(26, -10), scalar(27, 30),
    {op: 28, kind: 'typed', class: 8, fields: [scalar(28, .25), scalar(28, .75)]}, scalar(29, .5),
    {op: 30, kind: 'other', tag: 1}, {op: 31, kind: 'other', tag: 1}, {op: 32, kind: 'other', tag: 12}];
  const read = T.createEffectOriginReader([binding], [{values: [0, 12]}]);
  const origin = read(0, ops);
  assert.deepEqual(origin, {kind: 'radial', radial: {center: [10, 20, 30], radius: 7, axisScale: [2, .5], yaw: [67.5, 112.5], pitch: [10, 10]}});
  const radial = origin.radial;
  assert.equal(read(1, ops), null);
  assert.equal(read(0, ops.map(e => e.op === 32 ? {...e, tag: 13} : e)), null);
  assert.equal(T.createEffectOriginReader(undefined, [{values: [0, 12]}])(0, ops), null);
  assert.equal(read(0, ops.filter(e => e.op !== 23)), null);
  assert.equal(read(0, ops.map(e => e.op === 30 ? {op: 30, kind: 'symbol', name: '$unknown'} : e)), null);
  assert.equal(read(0, ops.map(e => e.op === 28 ? {...e, class: 9} : e)), null);
  // Elliptical positions use the two axis scales; velocity stays a unit
  // direction independent of those scales and retains nonzero pitch.
  for (const yaw of [0, 90, 180, 270, 37]) for (const pitch of [-25, 0, 42]) {
    const origin = {...radial, yaw: [yaw, yaw], pitch: [pitch, pitch]};
    const sim = new T.EmitterSim({slot: 1, loop: false}, 0,
      {life: {ticks: 100}, burst: 1, shape: 2, speed: {value: 600}},
      {1: {kind: 'burst_windowed', per_second: 600, windows: [[0, 0]]}, 2: {kind: 'shape', shape_kind: 'radial', resample: 32, center: origin.center, radial: origin}}, 600);
    const angle = yaw * Math.PI / 180, polar = pitch * Math.PI / 180;
    const expected = [10 + 14 * Math.cos(angle), 20 + 3.5 * Math.sin(angle), 30];
    const direction = [Math.cos(angle) * Math.cos(polar), Math.sin(angle) * Math.cos(polar), Math.sin(polar)];
    for (const tick of [0, 20, 3, 20]) {
      sim.ensure(tick); const points: number[][] = [];
      sim.evaluate(tick, (...p: number[]) => points.push(p));
      assert.equal(points.length, 1);
      for (let k = 0; k < 3; k++) assert(Math.abs(points[0][k] - expected[k] - direction[k] * tick) < 1e-5);
    }
  }
  // A sampled radius is a uniform range drawn for every particle, first in
  // its per-particle stream (the game evaluates the origin before the
  // emitter's own properties).
  const ranged = read(0, ops.map(e => e.op === 21 ? {op: 21, kind: 'typed', class: 8, fields: [scalar(21, 5), scalar(21, 9)]} : e));
  assert.deepEqual(ranged.radial.radius, [5, 9]);
  assert.equal(read(0, ops.map(e => e.op === 21 ? {op: 21, kind: 'typed', class: 9, fields: [scalar(21, 5), scalar(21, 9)]} : e)), null);
  {
    const shape = {...ranged.radial, yaw: [0, 0], pitch: [0, 0]};
    const sim = new T.EmitterSim({slot: 3, loop: false}, 0, {life: {ticks: 100}, burst: 1, shape: 2},
      {1: {kind: 'burst_windowed', per_second: 600, windows: [[0, 0]]}, 2: {kind: 'shape', shape_kind: 'radial', center: shape.center, radial: shape}}, 600);
    sim.ensure(1); const points: number[][] = [];
    sim.evaluate(1, (...p: number[]) => points.push(p));
    const expected = new T.EffectRandom(BigInt(T.hash32(sim.seed, 0))).range(5, 9);
    assert.equal(points.length, 1);
    assert(Math.abs(points[0][0] - (10 + 2 * expected)) < 1e-4, JSON.stringify({points, expected}));
  }
  // Point sources: a literal position with the default cone. Samples are the
  // azimuth and polar fractions, in that order, interpolating their bounds.
  const point = {instance: 13, kind: 'point', position: 40, axis: 41, yaw: [42, 43], pitch: [44, 45], samples: [46, 47], uniformClass: 8};
  assert(T.validEffectOrigins([binding, point]));
  assert(!T.validEffectOrigins([{...point, axis: undefined}]));
  const pointOps = [{op: 40, kind: 'vec3', v: [-780, -890, 670]}, {op: 41, kind: 'vec3', v: [.2, .2, 1.09]},
    scalar(42, 0), scalar(43, 360), scalar(44, 0), scalar(45, 2),
    {op: 46, kind: 'typed', class: 8, fields: [scalar(46, 0), scalar(46, 1)]}, {op: 47, kind: 'typed', class: 8, fields: [scalar(47, .5), scalar(47, 1)]}];
  const readPoint = T.createEffectOriginReader([point], [{values: [0, 13]}]);
  assert.deepEqual(readPoint(0, pointOps), {kind: 'point', point: {position: [-780, -890, 670], axis: [.2, .2, 1.09], yaw: [0, 360], pitch: [1, 2]}});
  assert.equal(readPoint(0, pointOps.filter(e => e.op !== 41)), null);
  assert.equal(readPoint(0, pointOps.map(e => e.op === 43 ? {op: 43, kind: 'symbol', index: 1, name: '$x'} : e)), null);
  console.log('effect origin extraction, sampled radius, point sources, elliptical geometry, direction and seek checks passed');
} finally { await rm(tmp, {recursive: true, force: true}); }
