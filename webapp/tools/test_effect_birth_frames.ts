import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-birth-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export {restEffectBirthFrames} from './src/viewers/world/effects-frames.ts'; export {EmitterSim} from './src/viewers/world/effects-sim.ts'; export {WorldEffectsLayer} from './src/viewers/world/effects-layer.ts'; export * from './vendor/three.module.js';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const T = await import(pathToFileURL(file).href);
  const owner = new T.Matrix4().set(0, -2, 0, 100, -1, 0, 0, 200, 0, 0, .5, 300, 0, 0, 0, 1);
  const bones = [new T.Matrix4().set(1, 0, 0, 10, 0, 0, -1, 20, 0, 1, 0, 30, 0, 0, 0, 1),
    new T.Matrix4().set(0, -1, 0, 50, 1, 0, 0, 60, 0, 0, 1, 70, 0, 0, 0, 1)];
  const inverse = owner.clone().invert().elements;
  const position = new T.Vector3(17, -23, 41), velocity = new T.Vector3(.5, -.7, .2), acceleration = new T.Vector3(.01, .02, -.03);
  const linear = (v: any, m: any) => v.clone().applyMatrix3(new T.Matrix3().setFromMatrix4(m));
  let checks = 0;
  for (const primary of ['root', null, 0, 1]) for (const secondary of ['root', null, 0, 1]) for (const mode of ['bone', 'skin']) {
    const frames = T.restEffectBirthFrames({primary, secondary, mode}, bones.map(b => b.elements), inverse);
    assert(frames);
    const sim = new T.EmitterSim({slot: 1, loop: false}, 0, {life: {ticks: 100}, burst: 1}, {1: {kind: 'burst_windowed', per_second: 600, windows: [[0, 0]]}}, 600);
    sim.shape.center = position.toArray(); sim.shape.w = velocity.toArray(); sim.shape.yaw = 0; sim.shape.pitch = 0;
    sim.speed = 1; sim.accel = acceleration.toArray(); sim.setBirthFrames(frames.position, frames.direction);
    const birthMatrix = primary === null ? new T.Matrix4() : owner.clone().multiply(typeof primary === 'number' && mode === 'bone' ? bones[primary] : new T.Matrix4());
    const directionMatrix = secondary === null ? new T.Matrix4() : owner.clone().multiply(typeof secondary === 'number' ? bones[secondary] : new T.Matrix4());
    const point = position.clone().applyMatrix4(birthMatrix), direction = linear(velocity, directionMatrix), force = linear(acceleration, owner);
    assert(new T.Vector3(...sim.spawnCenter()).applyMatrix4(owner).distanceTo(point) < 1e-9);
    for (const age of [0, 3, 20, 3]) {
      sim.ensure(age); let actual: any = null;
      sim.evaluate(age, (x: number, y: number, z: number) => {actual = new T.Vector3(x, y, z).applyMatrix4(owner);});
      const expected = point.clone().addScaledVector(direction, age).addScaledVector(force, .5 * age * age);
      assert(actual && actual.distanceTo(expected) < 1e-4, JSON.stringify({primary, secondary, mode, age, actual, expected})); checks++;
    }
  }
  assert.equal(T.restEffectBirthFrames({primary: 9, secondary: 'root', mode: 'bone'}, bones.map(b => b.elements), inverse), null);
  // Several live particles have different attachment poses. Moving the
  // displayed anchor would move all of them; each must retain its birth pose.
  const moving = new T.EmitterSim({slot: 2, loop: true, cycle_ticks: 40}, 0,
    {life: {ticks: 60}, burst: 1}, {1: {kind: 'burst_windowed', per_second: 60, windows: [[0, 30]]}}, 600);
  moving.shape.center = [2, 3, 4]; moving.shape.w = [1, 0, 0];
  moving.shape.yaw = 0; moving.shape.pitch = 0; moving.speed = 1;
  moving.accel = [.01, -.02, .03];
  const sample = (tick: number) => ({
    position: new T.Matrix4().makeTranslation(tick * 2, -tick, tick / 2).elements,
    direction: new T.Matrix4().makeRotationZ(tick * Math.PI / 40).elements,
  });
  const calls: number[] = [];
  moving.setBirthFrameSampler((tick: number) => {calls.push(tick); return sample(tick);});
  const snapshot = (time: number) => {
    moving.ensure(time);
    const particles: number[][] = [];
    moving.evaluate(time, (...p: number[]) => particles.push(p));
    const expected: number[][] = [];
    for (let j = moving.tail; j < moving.head; j++) {
      const tick = moving.spawnTick(j), age = time - tick;
      if (age < 0 || age >= moving.life) continue;
      const frames = sample(tick);
      const p = new T.Vector3(2, 3, 4).applyMatrix4(new T.Matrix4().fromArray(frames.position));
      const v = linear(new T.Vector3(1, 0, 0), new T.Matrix4().fromArray(frames.direction));
      p.addScaledVector(v, age).addScaledVector(new T.Vector3(...moving.accel), age * age / 2);
      expected.push(p.toArray());
    }
    assert.equal(particles.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert(new T.Vector3(...particles[i].slice(0, 3)).distanceTo(new T.Vector3(...expected[i])) < 1e-5);
    }
    return particles;
  };
  snapshot(0); snapshot(10); snapshot(20);
  const at50 = snapshot(50), sampled = calls.length;
  assert.deepEqual(snapshot(50), at50);
  assert.equal(calls.length, sampled, 'frozen clock does not resample');
  snapshot(600); snapshot(0);
  assert.deepEqual(snapshot(50), at50, 'rewind restores the same birth poses');
  assert(calls.includes(0) && calls.includes(10) && calls.includes(20));
  assert.deepEqual(moving.spawnCenter(10), [22, -7, 9]);
  moving.setBirthFrames(null, null); moving.ensure(50);
  assert.deepEqual(moving.spawnCenter(10), [2, 3, 4]);
  for (let j = moving.tail; j < moving.head; j++) assert.equal(moving.px[j % moving.capacity], 2);
  let worldChecks = 0;
  for (const rot of [0, 1, 2, 3]) for (const reflected of [false, true]) {
    for (const rigged of [false, true]) for (const world of [false, true]) {
      const a = {room: 1, occurrence: 1, system: 7, cell: [2, 3, 1], center: [2.5, 3.5], rot,
        packedFlags: reflected ? 4 : 0, rig: rigged ? 0 : null};
      const doc = {tick_rate: {value: 600}, rigs: {'0': [new T.Matrix4().elements]},
        configs: {1: {kind: 'burst_windowed', per_second: 600, windows: [[0, 0]]},
          2: {kind: 'shape', shape_kind: 'point', center: [17, -23, 41], axis: [0, 0, 1], spread_pitch: 0, spread_yaw: 0}},
        systems: [{slot: 7, loop: false, triggered: false, rig_selection: {alternate: false}, emitters: [{slot: 8,
          life: {ticks: 100}, burst: 1, shape: 2, speed: {value: 0}, sprite: {images: [-1]},
          transform: {primary: 'root', secondary: 'root', mode: 'bone'},
          acceleration: {v: [3600, -7200, 10800]}, acceleration_frame: {world, op: 30}}]}], attachments: {rooms: [a]}};
      const layer = new T.WorldEffectsLayer({root: new T.Group(), doc, url: (r: string) => r, textures: {}, tileUnits: 1024, layerUnits: 512});
      try {
        layer.addRoom(1, [8192, -4096]);
        const m = new T.Matrix4().makeTranslation(2560 + 8192, 3584 - 4096, 512)
          .multiply(new T.Matrix4().makeRotationZ((rot + 2) * Math.PI / 2));
        if (reflected) m.multiply(new T.Matrix4().makeScale(-1, 1, 1));
        const force = new T.Vector3(.01, -.02, .03);
        if (rigged || !world) force.applyMatrix3(new T.Matrix3().setFromMatrix4(m));
        for (const age of [3, 20, 3]) {
          layer.setClock(age); const particles = layer.snapshot(); assert.equal(particles[0].count, 1);
          const expected = new T.Vector3(17, -23, 41).applyMatrix4(m).addScaledVector(force, age * age / 2);
          assert(new T.Vector3(...particles[0].posSize.slice(0, 3)).distanceTo(expected) < .002);
          worldChecks++;
        }
      } finally {layer.dispose();}
    }
  }
  console.log(`${checks} separate birth/direction/acceleration, reflection and rewind checks passed`);
  console.log(`${worldChecks} world/local acceleration layer checks passed`);
} finally {await rm(tmp, {recursive: true, force: true});}
