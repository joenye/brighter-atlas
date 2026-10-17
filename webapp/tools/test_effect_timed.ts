// Start points worked out in code that move with the particle's time on its system's clock (a window, clamped).
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-timed-'));
let checks = 0;
const ok = (cond: unknown, what: string) => { assert(cond, what); checks++; };
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export * from './src/extract/world/effect-origins.ts'; export * from './src/extract/world/placement.ts'; export {EmitterSim} from './src/viewers/world/effects-sim.ts';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error'});
  const T = await import(pathToFileURL(file).href);
  // x = -200 + 400 u t (u a draw, t the time through its window), y = -480, z = 500: a point sliding along a ledge
  const timed = {instance: 12, owner: 40, draws: 1, axes: [[-200, 0, 0, 400], [-480, 0, 0, 0], [500, 0, 0, 0]], time: {from: 0.1, to: 0.3}};
  ok(T.validEffectOriginsTimed([timed]), 'a timed row');
  ok(!T.validEffectOriginsTimed([timed, timed]), 'one row per shape and owner');
  ok(!T.validEffectOriginsTimed([{...timed, time: {from: 0.3, to: 0.1}}]), 'a window that ends after it starts');
  ok(!T.validEffectOriginsTimed([{...timed, time: {from: 0.1}}]), 'a window with both ends');
  ok(!T.validEffectOriginsTimed([{...timed, time: {from: 0.1, to: 0.3, at: 1}}]), 'nothing else in the window');
  ok(!T.validEffectOriginsTimed([{...timed, axes: timed.axes.map(a => a.slice(0, 2))}]), 'terms for the time too');
  ok(!T.validEffectOriginsTimed([{...timed, time: undefined}]), 'a time');
  ok(T.validEffectOriginsTimed([{...timed, slot: 3}, timed]), 'a row for a single record beside the pair\'s');
  ok(!T.validEffectOriginsCoded([timed]), 'not a plain coded row (its time would be taken for a draw)');
  // (as per-build data: validated with the rest of the placement section)
  const doc = (rows: any[]) => ({kind: 'brighter-atlas-placement-decode', format: 1, bundle0_raw_sha256: 'a'.repeat(64), effectOriginsTimed: rows});
  ok(T.validatePlacementData(doc([timed]), 'a'.repeat(64)).effectOriginsTimed?.length === 1, 'placement data keeps the rows');
  ok((() => { try { T.validatePlacementData(doc([{...timed, time: {from: 1, to: 0}}]), 'a'.repeat(64)); return false; } catch { return true; } })(),
    'placement data refuses a bad window');
  const own = (slot: number) => [{op: 0, kind: 'scalar', tag: -85, value: slot}];
  const objects = [{values: [0, 12]}, {values: [0, 40]}, {values: [0, 41]}, {values: [0, 12]}];
  const read = T.createEffectOriginReader(undefined, objects, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, [timed, {...timed, slot: 3, time: {from: 0, to: 0.5}}]);
  const got = read(0, own(1));
  ok(got?.kind === 'coded' && got.coded.draws === 1, 'read as a coded start point');
  assert.deepEqual(got.coded.time, {from: 0.1, to: 0.3}); checks++;
  assert.deepEqual(got.coded.axes, timed.axes); checks++;
  ok(read(0, own(2)) === null, 'another owner, another case');
  assert.deepEqual(read(3, own(1)).coded.time, {from: 0, to: 0.5}); checks++;
  ok(T.createEffectOriginReader(undefined, objects)(0, own(1)) === null, 'no rows, no point');
  ok((() => { try { T.createEffectOriginReader(undefined, objects, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, [{...timed, time: {from: -1, to: 1}}]); return false; }
  catch { return true; } })(), 'invalid rows refused');
  // the simulator: one particle a tick for 300 ticks at 600 ticks a second; each one's x through its window by its birth
  const tickRate = 600;
  const sim = new T.EmitterSim({slot: 1, loop: false}, 0, {life: {ticks: 1000}, burst: 1, shape: 2},
    {1: {kind: 'burst_windowed', per_second: 600, windows: [[0, 300]]}, 2: {kind: 'shape', shape_kind: 'point', center: [0, 0, 0], origin: 'bound', coded: got.coded}}, tickRate);
  sim.ensure(300);
  const points: number[][] = [];
  sim.evaluate(300, (...p: number[]) => points.push(p));
  ok(points.length > 200, `particles born across the window (${points.length})`);
  const tOf = (born: number) => Math.min(1, Math.max(0, (born / tickRate - 0.1) / 0.2));
  let early = 0, late = 0;
  for (const p of points) {
    ok(Math.abs(p[1] + 480) < 1e-6 && Math.abs(p[2] - 500) < 1e-6, 'y and z stay put');
    ok(p[0] >= -200 - 1e-6 && p[0] <= 200 + 1e-6, `x within the ledge (${p[0]})`);
  }
  // (a particle born before the window starts at -200 whatever its draw; one born after reaches -200 + 400 u, over
  // the whole ledge)
  const born = Array.from({length: points.length}, (_, j) => sim.spawnTick(j));
  for (const b of born) { if (tOf(b) === 0) early++; if (tOf(b) === 1) late++; }
  ok(early > 0 && late > 0, 'births before and after the window');
  const atStart = points.filter(p => Math.abs(p[0] + 200) < 1e-6).length;
  ok(atStart >= early, `every particle born before the window at the ledge's start (${atStart} >= ${early})`);
  ok(points.some(p => p[0] > 100), 'particles born after the window reach the far end');
  // (spread grows with time: the widest x of particles born at a time never shrinks as the window goes on)
  const spread = (b0: number, b1: number) => Math.max(...points.filter((_, j) => born[j] >= b0 && born[j] < b1).map(p => p[0]));
  ok(spread(0, 60) <= spread(100, 140) + 1e-6 && spread(100, 140) <= spread(200, 300) + 1e-6, 'the ledge opens up over the window');
  console.log(`effect timed origins: ${checks} checks passed`);
} finally {
  await rm(tmp, {recursive: true, force: true});
}
