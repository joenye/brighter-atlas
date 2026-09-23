import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-precision-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export {EmitterSim} from './src/viewers/world/effects-sim.ts'; export {EffectsPlayer} from './src/viewers/world/effects-player.ts'; export {WorldEffectsLayer} from './src/viewers/world/effects-layer.ts'; export * from './vendor/three.module.js';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const T = await import(pathToFileURL(file).href);
  const emitter = {life: {ticks: 100}, fade_in: {ticks: 20}, fade_out: {ticks: 20}, burst: 1,
    color0: {rgba: [.2,.4,.8,.004]}, color1: {rgba: [.8,.4,.2,.5]},
    scale0: {value: 0}, scale1: {value: 150}, sprite: {images: [-1]}};
  const system = {slot: 1, loop: false, emitters: [{...emitter, sprite: null}, emitter]};
  const configs = {1: {kind: 'burst_windowed', per_second: 600, windows: [[0,0]]}};
  const sim = new T.EmitterSim(system, 1, emitter, configs, 600);
  const sample = (tick: number) => {
    sim.ensure(tick); const particles: number[][] = [];
    sim.evaluate(tick, (...p: number[]) => particles.push(p));
    return particles[0];
  };
  assert.deepEqual(sim.color0, [51/255,102/255,204/255,1/255]);
  assert.deepEqual(sim.color1, [204/255,102/255,51/255,127/255]);
  assert.equal(sample(0)[3], 0);
  assert.equal(sample(80)[3], 120);
  sim.scale0 = -2; sim.scale1 = 2;
  assert.equal(sample(0)[3], -2); assert.equal(sample(50)[3], 0);
  const early = sample(1);
  assert(Math.abs(early[7] - 1/5100) < 1e-10);
  assert(early[7] > 0 && early[7] < .5/255, 'a faint fade must survive the render upload');
  const middle = sample(50);
  assert(Math.abs(middle[7] - 64/255) < 1e-10);
  assert(Math.abs(middle[4] * middle[7] - (.2/255 + .8*127/255)/2) < 1e-10);
  assert.deepEqual(sample(1), early, 'seeking preserves envelope precision');
  for (const speed of [-180, -45, 0, 90, 360]) {
    const rotating = new T.EmitterSim(system, 1, {...emitter, life: {ticks: 1200}, angular_speed: {value: speed}}, configs, 600);
    for (const age of [150, 600, 300]) {
      rotating.ensure(age); let roll = NaN;
      rotating.evaluate(age, (...p: number[]) => {roll = p[8];});
      assert(Math.abs(roll-speed*Math.PI/180*age/600)<1e-8);
    }
  }

  const doc = {tick_rate: {value: 600}, configs, systems: [system], attachments: {rooms: [
    {room: 1, system: 1, owner: 2, cell: [0,0,0], size: [1,1], rotation: 0, source: 'placement'}]}};
  const root = new T.Group();
  const player = new T.EffectsPlayer({root, doc, url: (r: string) => r});
  const worldRoot = new T.Group();
  const layer = new T.WorldEffectsLayer({root: worldRoot, doc, url: (r: string) => r, textures: {}, tileUnits: 1, layerUnits: 1});
  try {
    player.addSystem(1); player.syncClock(1, 1); player.tick(0, null);
    layer.addRoom(1,[0,0]); layer.setClock(1);
    const findColours = (group: any) => {
      let result: any;
      group.traverse((o: any) => {if(o.geometry?.attributes.aColor) result = o.geometry.attributes.aColor;});
      return result;
    };
    for (const group of [root, worldRoot]) {
      const attribute = findColours(group);
      assert(attribute.array instanceof Float32Array);
      assert(Math.abs(attribute.array[3] - early[7]) < 1e-10);
    }
    // Invisible emitters must retain their source indices in either view.
    const instance = player._instances.get(1);
    assert.equal(instance.emitters[0].sim.seed, sim.seed);
  } finally {player.dispose(); layer.dispose();}
  console.log('particle endpoint packing, smooth fades, signed/zero scale and both render uploads passed');
} finally {await rm(tmp, {recursive: true, force: true});}
