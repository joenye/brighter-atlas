import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-wander-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export * from './src/viewers/world/effects-wander.ts'; export {createEffectOriginReader, validEffectWanders} from './src/extract/world/effect-origins.ts';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const W = await import(pathToFileURL(file).href);
  // the game's own draws (seed, salt -> value in [0, 1))
  for (const [seed, salt, want] of [[0, 437854378, 0.4206249713897705], [61, 758433422, 0.992150604724884],
    [145, 4325532, 0.3433007597923279], [7, 54355433, 0.5797092318534851], [123456, 1278954, 0.03075498342514038]])
    assert.equal(W.wanderUnit(seed, salt), Math.fround(want), `draw ${seed}, ${salt}`);
  // a binding with the record's numbers substituted: angle 87.2 + 5.6 u, tilt 30, amp (2u' - 1)(40 u'' + f4), height f6 u
  const binding = {instance: 9, center: 11, period: 200, values: {
    angle: {draws: [['cycle', 1]], terms: [[0, [12], 1], [1, [13], 1], [1, [12], -1]]},
    tilt: {draws: [], terms: [[0, [], 30]]},
    amp: {draws: [['index', 2], ['cycle', 3]], terms: [[0, [4], -1], [1, [4], 2], [2, [], -40], [3, [], 80]]},
    height: {draws: [['cycle', 4]], terms: [[1, [6], 1]]},
    base: {draws: [], terms: [[0, [], 100]]},
  }};
  assert(W.validEffectWanders([binding]));
  assert(!W.validEffectWanders([{...binding, period: 0}]));
  assert(!W.validEffectWanders([{...binding, values: {...binding.values, tilt: {draws: [], terms: [[1, [], 30]]}}}]));
  const f = (op: number, value: number) => ({op, kind: 'float', value});
  const ops = [{op: 11, kind: 'vec3', v: [1, 2, 3]}, f(12, 87.2), f(13, 92.8), f(4, 40), f(6, 250)];
  const read = W.createEffectOriginReader(undefined, [{values: [0, 9]}], undefined, undefined, undefined, undefined, [binding]);
  const origin = read(0, ops);
  assert.equal(origin.kind, 'wander');
  assert.deepEqual(origin.wander.center, [1, 2, 3]);
  const shape = origin.wander.shape;
  for (const n of [0, 1, 199, 200, 12345]) {
    const cycle = Math.trunc(n / 200), index = n % 200, u = (s: number, salt: number) => W.wanderUnit(s, salt);
    const a = (87.2 + 5.6 * u(cycle, 1)) * Math.PI / 180, t = 30 * Math.PI / 180;
    const amp = (2 * u(index, 2) - 1) * (40 * u(cycle, 3) + 40), r = 100 + amp * Math.cos(t);
    const want = [r * Math.cos(a), r * Math.sin(a), 250 * u(cycle, 4) + amp * Math.sin(t)];
    W.wanderPoint(shape, n).forEach((v: number, i: number) => assert(Math.abs(v - want[i]) < 1e-6, `particle ${n}`));
  }
  // the same batch keeps its spot; the next moves
  const p0 = W.wanderPoint(shape, 0), p1 = W.wanderPoint(shape, 1), p200 = W.wanderPoint(shape, 200);
  assert(Math.abs(Math.atan2(p0[1], p0[0]) - Math.atan2(p1[1], p1[0])) < 1e-9 && Math.atan2(p0[1], p0[0]) !== Math.atan2(p200[1], p200[0]));
  assert.equal(read(0, ops.filter((o: any) => o.op !== 4)), null, 'a missing field leaves the origin unbound');
  console.log('Wandering sources: the game\'s seeded draws, field substitution, per-batch spots and streaks');
} finally { await rm(tmp, {recursive: true, force: true}); }
