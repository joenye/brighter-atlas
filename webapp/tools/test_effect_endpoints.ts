import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-endpoints-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: `export {buildEmitter} from './src/extract/world/effects.ts';
    export * from './src/extract/world/effect-properties.ts';
    export {EmitterSim} from './src/viewers/world/effects-sim.ts';
    export {EffectsPlayer} from './src/viewers/world/effects-player.ts';
    export {WorldEffectsLayer} from './src/viewers/world/effects-layer.ts';
    export {Group} from './vendor/three.module.js';`, resolveDir: path.resolve(import.meta.dirname, '..')},
    bundle: true, platform: 'node', format: 'esm', outfile: file,
    plugins: [{name: 'test-internal-emitter', setup(b) {
      b.onLoad({filter: /extract\/world\/effects\.ts$/}, async args => ({
        contents: await readFile(args.path, 'utf8') + '\nexport {buildEmitter};', loader: 'ts', resolveDir: path.dirname(args.path),
      }));
    }}]});
  const T = await import(pathToFileURL(file).href);
  const scalar = (op: number, value: number) => ({op, kind: 'float', value});
  const rate = (op: number, value: number) => ({op, kind: 'rate', value, den: 100});
  const vector = (op: number, v: number[]) => ({op, kind: 'vec3', v});
  const alias = (op: number, role: string) => ({op, kind: 'symbol', name: `$${role}0`, index: op});
  const unknown = (op: number) => ({op, kind: 'typed', class: 2, fields: []});
  const seed = [scalar(10, 2), alias(11, 'scale'), rate(20, 4), alias(21, 'speed'), vector(30, [0,0,1]), alias(31, 'acceleration')];
  const layout = T.inferEffectPropertyPairs([seed]);
  assert.deepEqual(layout, {scale: [10,11], speed: [20,21], acceleration: [30,31]});
  assert.equal(T.inferEffectPropertyPairs([seed, [scalar(40, 1), alias(41, 'scale')]]).scale, undefined);
  const decode = (fields: any[], pairs: any = layout) => T.buildEmitter({slot: 1, runtime: 2, r: []}, fields, 0,
    {fades: 'none', confidence: 'order', pairs}, () => null, new Set(), new Map(), () => null);
  const fields = [scalar(3, 90), vector(5, [1,0,0]), scalar(10, 2), scalar(11, 4),
    rate(20, 0), rate(21, 8), rate(22, 45), vector(30, [1,2,3]), vector(31, [5,6,7])];
  const decoded = decode(fields);
  assert.equal(decoded.scale0.value, 2); assert.equal(decoded.scale1.value, 4);
  assert.deepEqual(decoded.direction.v, [1,0,0]);
  assert.equal(decoded.speed.value, 0); assert.equal(decoded.speed1.value, 8);
  assert.equal(decoded.angular_speed.value, 45, 'speed endpoint must not become spin');
  assert.deepEqual(decoded.acceleration.v, [1,2,3]); assert.deepEqual(decoded.acceleration1.v, [5,6,7]);
  assert(decoded.extra.some((f: any) => f.op === 3));
  const shifted = fields.map(f => ({...f, op: f.op + 100}));
  const shiftedSeed = seed.map(f => ({...f, op: f.op + 100}));
  const shiftedResult = decode(shifted, T.inferEffectPropertyPairs([shiftedSeed]));
  assert.equal(shiftedResult.speed1.value, 8); assert.equal(shiftedResult.scale0.value, 2);
  const unresolved = T.readEffectPropertyPair([unknown(10), alias(11, 'scale')], layout, 'scale');
  assert.equal(unresolved.start.kind, 'typed'); assert.equal(unresolved.end.kind, 'typed');
  assert.deepEqual(unresolved.indices, [0,1]);
  const legacy = decode([scalar(2, 3), rate(4, 5), vector(6, [0,1,0])], {});
  assert.equal(legacy.scale0.value, 3); assert.equal(legacy.speed.value, 5);
  const configs = {1: {kind: 'burst_windowed', per_second: 100, windows: [[0,0]]},
    2: {kind: 'shape', shape_kind: 'point', axis: [1,0,0], spread_yaw: 0, spread_pitch: 0}};
  let checks = 0;
  for (const tickRate of [100, 600]) for (const speeds of [[0,8], [8,0], [-4,12], [3,3]]) {
    const emitter = {...decoded, burst: 1, shape: 2, life: {ticks: 2 * tickRate}, scale0: {value: 1}, scale1: {value: 1},
      speed: {value: speeds[0]}, speed1: {value: speeds[1]}, sprite: {images: [-1]}};
    const system = {slot: 1, loop: false, emitters: [emitter]};
    const sim = new T.EmitterSim(system, 0, emitter, configs, tickRate);
    sim.setBirthFrames(null, [0,1,0,0,-1,0,0,0,0,0,1,0,0,0,0,1]);
    for (const seconds of [0, .25, 1, 1.75, .25]) {
      const tick = seconds * tickRate;
      sim.ensure(tick); let actual: number[] = [];
      sim.evaluate(tick, (...p: number[]) => {actual = p;});
      const expected = [0, speeds[0] * seconds + (speeds[1] - speeds[0]) / 4 * seconds ** 2, 0];
      for (let axis = 0; axis < 3; axis++) {
        expected[axis] += .5 * [1,2,3][axis] * seconds ** 2 + .5 * seconds ** 3;
        assert(Math.abs(actual[axis] - expected[axis]) < 1e-5, `${speeds} ${seconds} ${axis}`); checks++;
      }
    }
    const doc = {tick_rate: {value: tickRate}, configs, systems: [system], attachments: {rooms: [
      {room: 1, system: 1, owner: 2, cell: [0,0,0], size: [1,1], rotation: 0, source: 'placement'}]}};
    const modelRoot = new T.Group(), worldRoot = new T.Group();
    const player = new T.EffectsPlayer({root: modelRoot, doc, url: (r: string) => r});
    const world = new T.WorldEffectsLayer({root: worldRoot, doc, url: (r: string) => r, textures: {}, tileUnits: 1, layerUnits: 1});
    try {
      player.addSystem(1); player.syncClock(1, tickRate); player.tick(0, null);
      world.addRoom(1, [0,0]); world.setClock(tickRate);
      const expected = [speeds[0] + (speeds[1]-speeds[0])/4 + 1, 1.5, 2];
      for (const root of [modelRoot, worldRoot]) {
        let buffer: any;
        root.traverse((o: any) => {if(o.geometry?.attributes.aPosSize) buffer = o.geometry.attributes.aPosSize.array;});
        const p = root === modelRoot ? expected : [.5-expected[0], .5-expected[1], expected[2]];
        for (let axis = 0; axis < 3; axis++) {assert(Math.abs(buffer[axis] - p[axis]) < 1e-5, JSON.stringify({surface: root === modelRoot ? "model" : "world", actual: Array.from(buffer.slice(0,4)), expected: p})); checks++;}
      }
    } finally {player.dispose(); world.dispose();}
  }
  console.log(`Endpoint roles and ${checks} motion/render-buffer checks passed`);
} finally {await rm(tmp, {recursive: true, force: true});}
