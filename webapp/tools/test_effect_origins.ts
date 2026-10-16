import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-origins-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export * from './src/extract/world/effect-origins.ts'; export {EmitterSim, hash32, throughTable} from './src/viewers/world/effects-sim.ts'; export {wanderUnit} from './src/viewers/world/effects-wander.ts'; export {EffectRandom} from './src/viewers/world/effects-random.ts'; export {evaluateComputed, gridPoint} from './src/viewers/world/effects-computed.ts';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
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
  // A ring whose particles all leave along one vector of the record: that vector, as it is, whatever the yaw
  {
    assert(T.validEffectOriginDirections([{instance: 12, direction: 33}]));
    assert(!T.validEffectOriginDirections([{instance: 12, direction: -1}]));
    const fixed = T.createEffectOriginReader([binding], [{values: [0, 12]}], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, [{instance: 12, direction: 33}]);
    const withDir = [...ops, {op: 33, kind: 'vec3', v: [0, 0, -2]}];
    const got = fixed(0, withDir);
    assert.deepEqual(got.radial.direction, [0, 0, -2]);
    assert.equal(fixed(0, ops), null, 'a direction field that does not read leaves the origin unbound');
    const shape = {...got.radial, yaw: [90, 90], pitch: [30, 30]};
    const sim = new T.EmitterSim({slot: 1, loop: false}, 0, {life: {ticks: 100}, burst: 1, shape: 2, speed: {value: 600}},
      {1: {kind: 'burst_windowed', per_second: 600, windows: [[0, 0]]}, 2: {kind: 'shape', shape_kind: 'radial', center: shape.center, radial: shape}}, 600);
    sim.ensure(10); const points: number[][] = [];
    sim.evaluate(10, (...p: number[]) => points.push(p));
    const want = [10, 20 + 3.5, 30 - 2 * 10];
    for (let k = 0; k < 3; k++) assert(Math.abs(points[0][k] - want[k]) < 1e-4, `fixed direction ${points[0]}`);
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
  // Compact spawns: a literal position or a segment, each with a full cone.
  const compact = [{instance: 14, kind: 'position', position: 50, axis: 51, yaw: [52, 53], pitch: [54, 55], uniformClass: 8},
    {instance: 15, kind: 'segment', start: 58, end: 59, axis: 51, yaw: [52, 53], pitch: [54, 55], uniformClass: 8}];
  assert(T.validEffectOrigins(compact));
  assert(!T.validEffectOrigins([{...compact[1], end: undefined}]));
  const compactOps = [{op: 50, kind: 'vec3', v: [0, 0, 1200]}, {op: 51, kind: 'vec3', v: [0, 0, 1]},
    scalar(52, 90), scalar(53, 90), scalar(54, 90), scalar(55, 100),
    {op: 58, kind: 'vec3', v: [512, -512, 0]}, {op: 59, kind: 'vec3', v: [-512, -512, 0]}];
  const readCompact = T.createEffectOriginReader(compact, [{values: [0, 14]}, {values: [0, 15]}]);
  assert.deepEqual(readCompact(0, compactOps), {kind: 'point', point: {position: [0, 0, 1200], axis: [0, 0, 1], yaw: [90, 90], pitch: [90, 100]}});
  assert.deepEqual(readCompact(1, compactOps), {kind: 'segment', segment: {from: [512, -512, 0], to: [-512, -512, 0], axis: [0, 0, 1], yaw: [90, 90], pitch: [90, 100]}});
  assert.equal(readCompact(1, compactOps.filter(e => e.op !== 59)), null);
  {
    // A bound segment spawns uniformly along its ends and aims through the cone:
    // azimuth 90 degrees puts every direction in the y-z plane, polar 90..100
    // keeps it at or below the horizon.
    const segment = readCompact(1, compactOps).segment;
    const sim = new T.EmitterSim({slot: 4, loop: true}, 0, {life: {ticks: 600}, burst: 1, shape: 2, speed: {value: 600}},
      {1: {kind: 'burst_continuous', per_second: 600}, 2: {kind: 'shape', shape_kind: 'segment', segment: {from: segment.from, to: segment.to},
        center: [0, -512, 0], axis: segment.axis, cone: {yaw: segment.yaw, pitch: segment.pitch}, origin: 'bound'}}, 600);
    sim.ensure(300);
    sim.evaluate(300, (x: number) => assert(Math.abs(x) <= 512 + 1e-3, 'on the segment'));
    for (let j = sim.tail; j < sim.head; j++) {
      const slot = j % sim.capacity;
      const d = [sim.vx[slot], sim.vy[slot], sim.vz[slot]];
      assert(Math.abs(d[0]) < 1e-6 && d[1] > 0.98 && d[2] <= 1e-6 && d[2] >= -0.18, JSON.stringify(d));
    }
  }
  {
    // A disc (compact): a distance up to the radius (uniform, so its mean is half the radius) and an angle all the
    // way round, flat about the centre; a ranged radius is drawn first.
    const disc = {instance: 16, center: 60, radius: 61, axis: 62, yaw: [63, 64], pitch: [65, 66], uniformClass: 8};
    assert(T.validEffectDiscs([disc]));
    assert(!T.validEffectDiscs([{...disc, yaw: [63]}]));
    const discOps = [{op: 60, kind: 'vec3', v: [100, 200, 300]}, scalar(61, 50), {op: 62, kind: 'vec3', v: [0, 0, 1]},
      scalar(63, 0), scalar(64, 360), scalar(65, 0), scalar(66, 90)];
    const readDisc = T.createEffectOriginReader(undefined, [{values: [0, 16]}], undefined, [disc]);
    assert.deepEqual(readDisc(0, discOps), {kind: 'cylinder', cylinder: {center: [100, 200, 300], radius: 50, height: 0, flat: true,
      axisScale: [1, 1], axis: [0, 0, 1], yaw: [0, 360], pitch: [0, 90]}});
    assert.equal(readDisc(0, discOps.filter(e => e.op !== 61)), null);
    // the generic route: two across scales and the default cone's sample fractions
    const genericDisc = {...disc, instance: 17, axisScale: [67, 68], samples: [69, 59]};
    assert(T.validEffectDiscs([genericDisc]));
    const readGenericDisc = T.createEffectOriginReader(undefined, [{values: [0, 17]}], undefined, [genericDisc]);
    const genericOps = [...discOps, scalar(67, 2), scalar(68, .5), {op: 69, kind: 'typed', class: 8, fields: [scalar(69, 0), scalar(69, 1)]}, scalar(59, .5)];
    assert.deepEqual(readGenericDisc(0, genericOps), {kind: 'cylinder', cylinder: {center: [100, 200, 300], radius: 50, height: 0, flat: true,
      axisScale: [2, .5], axis: [0, 0, 1], yaw: [0, 360], pitch: [45, 45]}});
    const ranged = readDisc(0, discOps.map(e => e.op === 61 ? {op: 61, kind: 'typed', class: 8, fields: [scalar(61, 20), scalar(61, 40)]} : e));
    assert.deepEqual(ranged.cylinder.radius, [20, 40]);
    for (const [radius, top] of [[50, 50], [[20, 40], 40]] as const) {
      const sim = new T.EmitterSim({slot: 5, loop: true}, 0, {life: {ticks: 6000}, burst: 1, shape: 2, speed: {value: 0}},
        {1: {kind: 'burst_continuous', per_second: 600}, 2: {kind: 'shape', shape_kind: 'point', center: [100, 200, 300], axis: [0, 0, 1],
          cone: {yaw: [0, 360], pitch: [0, 90]}, cylinder: {radius, height: 0, axisScale: [1, 1], flat: true}, origin: 'bound'}}, 600);
      sim.ensure(3000);
      const distances: number[] = [];
      sim.evaluate(3000, (x: number, y: number, z: number) => {
        assert(Math.abs(z - 300) < 1e-3, 'flat');
        distances.push(Math.hypot(x - 100, y - 200));
      });
      assert(distances.length > 1000 && Math.max(...distances) <= top + 1e-3, `within the radius (${Math.max(...distances)})`);
      if (radius === 50) {
        const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
        assert(Math.abs(mean - 25) < 1.5, `uniform in distance, not area (mean ${mean})`);
      }
    }
  }
  {
    // A segment on the generic route: its two ends, the default cone's angles interpolated by their sample fractions.
    const line = {instance: 18, start: 70, end: 71, axis: 72, yaw: [73, 74], pitch: [75, 76], samples: [77, 78], uniformClass: 8};
    assert(T.validEffectSegments([line]));
    assert(!T.validEffectSegments([{...line, samples: [77]}]));
    const lineOps = [{op: 70, kind: 'vec3', v: [0, 0, 0]}, {op: 71, kind: 'vec3', v: [0, 0, 1000]}, {op: 72, kind: 'vec3', v: [0, 0, 1]},
      scalar(73, 0), scalar(74, 360), scalar(75, 0), scalar(76, 90),
      {op: 77, kind: 'typed', class: 8, fields: [scalar(77, 0), scalar(77, 1)]}, scalar(78, .5)];
    const readLine = T.createEffectOriginReader(undefined, [{values: [0, 18]}], undefined, undefined, [line]);
    assert.deepEqual(readLine(0, lineOps), {kind: 'segment', segment: {from: [0, 0, 0], to: [0, 0, 1000], axis: [0, 0, 1],
      yaw: [0, 360], pitch: [45, 45]}});
    assert.equal(readLine(0, lineOps.filter(e => e.op !== 71)), null);
  }
  {
    // A box: a point drawn between its corners, x, y then z, in place of the centre; compact (cone bounds as they are)
    // and generic (angles interpolated by their sample fractions).
    const compactBox = {instance: 20, box: 80, axis: 81, yaw: [82, 83], pitch: [84, 85], uniformClass: 8};
    const genericBox = {instance: 21, box: 80, axis: 81, yaw: [82, 83], pitch: [84, 85], samples: [86, 87], uniformClass: 8};
    assert(T.validEffectBoxes([compactBox, genericBox]));
    assert(!T.validEffectBoxes([{...compactBox, samples: [86]}]));
    const boxOps = [{op: 80, kind: 'box', a: [-100, 50, 0], b: [100, -50, 20]}, {op: 81, kind: 'vec3', v: [0, 0, 1]},
      scalar(82, 0), scalar(83, 360), scalar(84, 0), scalar(85, 90),
      {op: 86, kind: 'typed', class: 8, fields: [scalar(86, 0), scalar(86, 1)]}, scalar(87, .5)];
    const readBox = T.createEffectOriginReader(undefined, [{values: [0, 20]}, {values: [0, 21]}], undefined, undefined, undefined,
      [compactBox, genericBox]);
    assert.deepEqual(readBox(0, boxOps), {kind: 'box', box: {a: [-100, 50, 0], b: [100, -50, 20], axis: [0, 0, 1], yaw: [0, 360], pitch: [0, 90]}});
    assert.deepEqual(readBox(1, boxOps).box.pitch, [45, 45]);
    assert.equal(readBox(0, boxOps.map(e => e.op === 80 ? {op: 80, kind: 'other', tag: 37} : e)), null);
    const sim = new T.EmitterSim({slot: 6, loop: true}, 0, {life: {ticks: 6000}, burst: 1, shape: 2, speed: {value: 0}},
      {1: {kind: 'burst_continuous', per_second: 600}, 2: {kind: 'shape', shape_kind: 'point', center: [0, 0, 10], axis: [0, 0, 1],
        cone: {yaw: [0, 360], pitch: [0, 90]}, box: {a: [-100, 50, 0], b: [100, -50, 20]}, origin: 'bound'}}, 600);
    sim.ensure(3000);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    sim.evaluate(3000, (x: number, y: number, z: number) => {
      [x, y, z].forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
    });
    assert(lo[0] >= -100 && hi[0] <= 100 && lo[1] >= -50 && hi[1] <= 50 && lo[2] >= 0 && hi[2] <= 20, `inside the box (${lo} ${hi})`);
    assert(hi[0] - lo[0] > 180 && hi[1] - lo[1] > 90 && hi[2] - lo[2] > 18, `spread over the box (${lo} ${hi})`);
  }
    // a radial origin whose yaw fraction the class's code draws: the full yaw range, a quantile table
  const coded = {instance: 12, resample: 32, center: 20, radius: 21, axisScale: [22, 23], yaw: [24, 25], pitch: [26, 27],
    samples: [{quantiles: [0.1, 0.2, 0.8, 0.9]}, 29], uniformClass: 8};
  assert(T.validEffectRadialsCoded([coded]));
  assert(!T.validEffectRadialsCoded([{...coded, samples: [28, 29]}]), 'a coded binding needs a coded sample');
  assert(!T.validEffectRadialsCoded([{...coded, samples: [{quantiles: [2, 3]}, 29]}]));
  const codedRead = T.createEffectOriginReader(undefined, [{values: [0, 12]}], undefined, undefined, undefined, undefined, undefined, [coded]);
  const codedOrigin = codedRead(0, ops);
  assert.deepEqual(codedOrigin, {kind: 'radial', radial: {center: [10, 20, 30], radius: 7, axisScale: [2, .5], yaw: [45, 135],
    pitch: [10, 10], yawTable: [0.1, 0.2, 0.8, 0.9]}});
  // an even draw through quantiles: each quantile at its own place, linear between, the draw itself with none
  assert.equal(T.throughTable([0.1, 0.2, 0.8, 0.9], 0.125), 0.1);
  assert.equal(T.throughTable([0.1, 0.2, 0.8, 0.9], 0.375), 0.2);
  assert(Math.abs(T.throughTable([0.1, 0.2, 0.8, 0.9], 0.5) - 0.5) < 1e-12);
  assert.equal(T.throughTable([0.1, 0.2, 0.8, 0.9], 0), 0.1);
  assert.equal(T.throughTable([0.1, 0.2, 0.8, 0.9], 0.999), 0.9);
  assert.equal(T.throughTable(undefined, 0.3), 0.3);
  // an origin the code makes from draws alone, chosen by shape and owner instance
  const made = {instance: 12, owner: 40, draws: 1, axes: [[0, 0], [0, 0], [600, 800]]};
  assert(T.validEffectOriginsCoded([made]));
  assert(!T.validEffectOriginsCoded([{...made, axes: [[0], [0], [600]]}]));
  assert(!T.validEffectOriginsCoded([made, made]));
  const madeRead = T.createEffectOriginReader(undefined, [{values: [0, 12]}, {values: [0, 40]}, {values: [0, 41]}],
    undefined, undefined, undefined, undefined, undefined, undefined, [made]);
  const own = (slot: number) => [{op: 0, kind: 'scalar', tag: -85, value: slot}];
  assert.deepEqual(madeRead(0, own(1)), {kind: 'coded', coded: {draws: 1, axes: [[0, 0], [0, 0], [600, 800]]}});
  assert.equal(madeRead(0, own(2)), null, 'another owner, another case');
  // records of one shape and owner instance each at their own point: a row for the record first
  {
    const perRecord = [{...made, slot: 0, axes: [[10, 0], [20, 0], [30, 0]]}, {...made, slot: 3, axes: [[-10, 0], [0, 0], [0, 0]]}];
    assert(T.validEffectOriginsPerRecord(perRecord));
    assert(!T.validEffectOriginsPerRecord([perRecord[0], perRecord[0]]), 'one row per record');
    assert(!T.validEffectOriginsPerRecord([{...perRecord[0], slot: -1}]));
    assert(!T.validEffectOriginsPerRecord([{...perRecord[0], axes: [[0], [0], [0]]}]));
    const objects = [{values: [0, 12]}, {values: [0, 40]}, {values: [0, 41]}, {values: [0, 12]}, {values: [0, 12]}];
    const recordRead = T.createEffectOriginReader(undefined, objects, undefined, undefined, undefined, undefined, undefined,
      undefined, [made], undefined, undefined, undefined, perRecord);
    assert.deepEqual(recordRead(0, own(1)).coded.axes, [[10, 0], [20, 0], [30, 0]]);
    assert.deepEqual(recordRead(3, own(1)).coded.axes, [[-10, 0], [0, 0], [0, 0]]);
    assert.deepEqual(recordRead(4, own(1)).coded.axes, [[0, 0], [0, 0], [600, 800]], 'a record with no row of its own: the pair\'s');
    assert.deepEqual(T.createEffectOriginReader(undefined, objects, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, perRecord)(3, own(1)).coded.axes, [[-10, 0], [0, 0], [0, 0]]);
  }
  // whole-number draws, draws the same for every particle born on a tick, and the system's own numbers
  {
    // x = -100 + 50 u F (u the tick's draw with salt 7, F the system's field 28); y = -40 + 80 c (c a coin); z = 5
    const axes = [[-100, 0, 0, 0, 0, 0, 0, 0], [-40, 80, 0, 0, 0, 0, 0, 0], [5, 0, 0, 0, 0, 0, 0, 0]];
    axes[0][0b110] = 50;
    const rich = {instance: 12, owner: 40, draws: 2, steps: [1, 0], seeded: [-1, 7], fields: [28], axes};
    assert(T.validEffectOriginsCoded([rich]));
    assert(!T.validEffectOriginsCoded([{...rich, axes: axes.map(a => a.slice(0, 4))}]), 'coefficients for every variable');
    assert(!T.validEffectOriginsCoded([{...rich, steps: [1]}]));
    assert(!T.validEffectOriginsCoded([{...rich, seeded: [-2, 7]}]));
    const richRead = T.createEffectOriginReader(undefined, [{values: [0, 12]}, {values: [0, 40]}],
      undefined, undefined, undefined, undefined, undefined, undefined, [rich]);
    // (the records up the chain: the shape names its emitter (slot 1), the emitter its system (slot 2))
    const system = (slot: number) => slot === 1 ? [{op: 0, kind: 'scalar', tag: -85, value: 2}]
      : slot === 2 ? [{op: 28, kind: 'float', value: 13}] : null;
    const got = richRead(0, own(1), system);
    assert.deepEqual(got.coded.fieldValues, [13]);
    assert.deepEqual([got.coded.steps, got.coded.seeded], [[1, 0], [-1, 7]]);
    assert.equal(richRead(0, own(1)), null, 'no system: no origin');
    assert.equal(richRead(0, own(1), () => [{op: 27, kind: 'float', value: 13}]), null, 'a system without the field');
    const sim = new T.EmitterSim({slot: 1, loop: false}, 0, {life: {ticks: 100}, burst: 1, shape: 2},
      {1: {kind: 'burst_windowed', per_second: 600, windows: [[0, 0]]}, 2: {kind: 'shape', shape_kind: 'point', center: [0, 0, 0], origin: 'bound', coded: got.coded}}, 600);
    sim.ensure(1); const points: number[][] = [];
    sim.evaluate(1, (...p: number[]) => points.push(p));
    assert(points.length >= 1);
    const born = sim.spawnTick(0), want = -100 + 50 * 13 * T.wanderUnit(born - 1, 7);
    for (const p of points) {
      assert(Math.abs(p[0] - want) < 1e-3, `seeded x ${p[0]} vs ${want}`);
      assert(Math.abs(Math.abs(p[1]) - 40) < 1e-6, `whole draw y ${p[1]}`);
      assert(Math.abs(p[2] - 5) < 1e-6);
    }
  }
  // A ring whose values come from elsewhere: the emitter that owns it (field 0 names the owner), or computed for each
  // particle (a draw, a ramp over the first particles, a step per particle)
  {
    const sourced = {instance: 12, resample: 32, yaw: [24, 25], pitch: [26, 27], samples: [28, 29], overrides: [30, 31],
      uniformClass: 8, center: {owner: 1, op: 38}, radius: {owner: 1, op: 39}, axisScale: [{op: 22}, {op: 23}]};
    assert(T.validEffectRadialsSourced([sourced]));
    assert(!T.validEffectRadialsSourced([{...sourced, center: {owner: 3, op: 38}}]));
    assert(!T.validEffectRadialsSourced([{...sourced, radius: {draws: 1, coef: [1]}}]));
    assert(!T.validEffectRadialsSourced([{...sourced, center: {draws: 0, coef: [1]}}]));
    const read = T.createEffectOriginReader(undefined, [{values: [0, 12]}], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, [sourced]);
    const shapeOps = [{op: 0, kind: 'scalar', tag: -85, value: 5}, ...ops];
    const emitter = [{op: 0, kind: 'scalar', tag: -85, value: 6}, {op: 38, kind: 'vec3', v: [1, 2, 3]}, {op: 39, kind: 'fixed', floats: [450]}];
    const opsOf = (slot: number) => slot === 5 ? emitter : null;
    assert.deepEqual(read(0, shapeOps, opsOf), {kind: 'radial', radial: {center: [1, 2, 3], radius: 450, axisScale: [2, .5],
      yaw: [67.5, 112.5], pitch: [10, 10]}});
    assert.equal(read(0, shapeOps), null, 'no owner records: unbound');
    // (a radius one draw picks among a few: a sampled value, drawn per particle as the shape's own range is)
    const picked = {choice: [[0.25, 300], [0.75, [400, 500]]], salt: 3};
    assert(T.validEffectRadialsSourced([{...sourced, radius: {value: picked}}]));
    assert(!T.validEffectRadialsSourced([{...sourced, center: {value: picked}}]), 'a centre is no sampled value');
    assert(!T.validEffectRadialsSourced([{...sourced, radius: {value: {choice: [[0.5, 1]]}}}]));
    const pickRead = T.createEffectOriginReader(undefined, [{values: [0, 12]}], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, [{...sourced, radius: {value: picked}}]);
    assert.deepEqual(pickRead(0, shapeOps, opsOf).radial.radius, picked);
    assert.equal(read(0, ops, opsOf), null, 'no owner named: unbound');
    const grow = {draws: 1, coef: [900, 100], count: [0, 0.5]};
    const funnel = {draws: 0, axes: [[0], [0], [300]], perCount: [[0], [0], [-10]]};
    const computedRead = T.createEffectOriginReader(undefined, [{values: [0, 12]}], undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, [{...sourced, center: funnel, radius: grow}]);
    const made = computedRead(0, shapeOps, opsOf);
    assert.deepEqual(made.radial.computed, {center: funnel, radius: grow});
    assert.deepEqual(made.radial.center, [0, 0, 0]);
    // the values per particle number: the ramp, then the settled draw; the step per particle
    const half = () => 0.5;
    assert.deepEqual(T.evaluateComputed(grow, 0, half), [0]);
    assert.deepEqual(T.evaluateComputed(grow, 1, half), [475]);
    assert.deepEqual(T.evaluateComputed(grow, 7, half), [950]);
    assert.deepEqual(T.evaluateComputed(funnel, 4, half), [0, 0, 260]);
    assert.deepEqual(T.evaluateComputed({draws: 2, axes: [[1, 2, 3, 4], [0, 0, 0, 0], [0, 0, 0, 0]]}, 0, (() => {
      let k = 0; return () => [0.5, 0.25][k++]; })()), [1 + 1 + .75 + .5, 0, 0]);
    // the first particle: the funnel's top, the ring not yet grown
    const shape = {...made.radial, yaw: [0, 0], pitch: [0, 0]};
    const sim = new T.EmitterSim({slot: 4, loop: false}, 0, {life: {ticks: 100}, burst: 1, shape: 2},
      {1: {kind: 'burst_windowed', per_second: 600, windows: [[0, 0]]}, 2: {kind: 'shape', shape_kind: 'radial', center: shape.center, radial: shape}}, 600);
    sim.ensure(1); const points: number[][] = [];
    sim.evaluate(1, (...p: number[]) => points.push(p));
    assert.equal(points.length, 1);
    for (const [k, want] of [[0, 0], [1, 0], [2, 300]]) assert(Math.abs(points[0][k] - want) < 1e-4, `first particle ${points[0]}`);
  }
  // Start points the plain rows cannot carry: a polynomial that takes the particle's number itself, a grid
  // interpolated over the draws, a table of equally likely points
  {
    const own = (slot: number) => [{op: 0, kind: 'scalar', tag: -85, value: slot}];
    const counted = {instance: 12, owner: 40, draws: 2, counted: [0, 1], axes: [[-1024, 2048, 0, 0], [0, 0, 18.5, 0], [100, 0, 0, 0]]};
    const grid = {instance: 13, owner: 40, draws: 2, grid: {res: [3, 2], values: [[0, 10, 40, 0, 10, 40], [0, 0, 0, 6, 6, 6], [1, 1, 1, 1, 1, 1]]}};
    const table = {instance: 14, owner: 40, draws: 4, table: [[1, 2, 3], [4, 5, 6], [7, 8, 9]]};
    assert(T.validEffectOriginsTabulated([counted, grid, table]));
    assert(!T.validEffectOriginsTabulated([{...grid, axes: counted.axes}]), 'one shape of row');
    assert(!T.validEffectOriginsTabulated([{...grid, grid: {res: [3, 2], values: [[0], [0], [0]]}}]), 'every grid point');
    assert(!T.validEffectOriginsTabulated([{...grid, counted: [1, 0]}]), 'a grid takes fractions only');
    assert(!T.validEffectOriginsTabulated([{...table, table: [[1, 2]]}]));
    assert(!T.validEffectOriginsTabulated([{...counted, counted: [2, 0]}]));
    // (a grid point exactly, and halfway between two along a curved draw)
    assert.deepEqual(T.gridPoint(grid.grid, [0.5, 1]), [10, 6, 1]);
    assert.deepEqual(T.gridPoint(grid.grid, [0.75, 0]), [25, 0, 1]);
    const read = T.createEffectOriginReader(undefined, [{values: [0, 12]}, {values: [0, 40]}, {values: [0, 13]}, {values: [0, 14]}],
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [counted, grid, table]);
    const got = read(0, own(1)), gotGrid = read(2, own(1)), gotTable = read(3, own(1));
    assert.deepEqual(got.coded.counted, [0, 1]);
    assert.deepEqual(gotGrid.coded.grid, grid.grid);
    assert.deepEqual(gotTable.coded.table, table.table);
    const run = (coded: any, ticks: number) => {
      const sim = new T.EmitterSim({slot: 1, loop: false}, 0, {life: {ticks: 600}, burst: 1, shape: 2},
        {1: {kind: 'burst_windowed', per_second: 600, windows: [[0, 10]]}, 2: {kind: 'shape', shape_kind: 'point', center: [0, 0, 0], origin: 'bound', coded}}, 600);
      sim.ensure(ticks); const points: number[][] = [];
      sim.evaluate(ticks, (...p: number[]) => points.push(p));
      return points;
    };
    // (the table: every particle at one of its points)
    const tp = run(gotTable.coded, 10);
    assert(tp.length >= 3);
    for (const p of tp) assert(table.table.some(q => q.every((v, a) => Math.abs(v - p[a]) < 1e-6)), `table point ${p}`);
    // (counted: y steps on by 18.5 a particle, x stays within its draw)
    const cp = run(got.coded, 10).sort((a, b) => a[1] - b[1]);
    assert(cp.length >= 3);
    for (let i = 1; i < cp.length; i++) assert(Math.abs((cp[i][1] - cp[i - 1][1]) % 18.5) < 1e-6, `counted y ${cp[i][1]}`);
    for (const p of cp) assert(p[0] >= -1024 - 1e-6 && p[0] <= 1024 + 1e-6 && Math.abs(p[2] - 100) < 1e-6);
  }
  // A start point worked out in code whose particles leave through the shape's own cone: its axis field (pointing
  // down here, as weather over a room falls), yaw and pitch bounds, and fractions keyed by the birth tick
  {
    const cone = {instance: 12, axis: 6, yaw: [7, 8], pitch: [9, 10], samples: [{seeded: 28387520}, {seeded: 27395479}], uniformClass: 8};
    assert(T.validEffectDirections([cone]));
    assert(!T.validEffectDirections([{...cone, samples: [{seeded: -1}, 3]}]));
    assert(!T.validEffectDirections([{...cone, axis: 'x'}]));
    const coneRead = T.createEffectOriginReader(undefined, [{values: [0, 12]}, {values: [0, 40]}],
      undefined, undefined, undefined, undefined, undefined, undefined, [made], undefined, undefined, undefined, undefined, [cone]);
    const shapeOps = [...own(1), {op: 6, kind: 'vec3', v: [0.1, 0.1, -0.7]}, scalar(7, 0), scalar(8, 360), scalar(9, 0), scalar(10, 0.3)];
    const got = coneRead(0, shapeOps);
    assert.equal(got.kind, 'coded');
    assert.deepEqual(got.cone, {axis: [0.1, 0.1, -0.7], yaw: [0, 360], pitch: [0, 0.3], salts: [28387520, 27395479]});
    // (a cone that does not read leaves the start point bound, its direction as the shape reads it)
    assert.equal(coneRead(0, shapeOps.filter(e => e.op !== 6)).cone, undefined);
    // the particles fall along the axis, and two born on one tick leave the same way
    const level = {draws: 1, axes: [[0, 0], [0, 0], [1000, 0]]};
    const shape = {kind: 'shape', shape_kind: 'point', center: [0, 0, 0], origin: 'bound', coded: level,
      axis: got.cone.axis, cone: {yaw: got.cone.yaw, pitch: got.cone.pitch}, cone_salts: got.cone.salts};
    const sim = new T.EmitterSim({slot: 1, loop: false}, 0, {life: {ticks: 100}, burst: 1, shape: 2, speed: {value: 600}},
      {1: {kind: 'burst_windowed', per_second: 1200, windows: [[0, 0]]}, 2: shape}, 600);
    sim.ensure(30); const points: number[][] = [];
    sim.evaluate(30, (...p: number[]) => points.push(p));
    assert(points.length >= 1);
    for (const p of points) assert(p[2] < 1000 - 20, `particle ${p} falls`);
    // (without the cone the shape's guessed direction, up, would carry them up)
    const up = new T.EmitterSim({slot: 1, loop: false}, 0, {life: {ticks: 100}, burst: 1, shape: 2, speed: {value: 600}},
      {1: {kind: 'burst_windowed', per_second: 1200, windows: [[0, 0]]}, 2: {...shape, axis: null, cone: null, cone_salts: undefined}}, 600);
    up.ensure(30); const risen: number[][] = [];
    up.evaluate(30, (...p: number[]) => risen.push(p));
    assert(risen.some(p => p[2] > 1001));
  }
  console.log('effect origin extraction, sampled radius, point, position, segment (both routes), disc and box sources, elliptical geometry, direction and seek checks passed');
} finally { await rm(tmp, {recursive: true, force: true}); }
