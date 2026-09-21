import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-animation-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export {EffectBoneAnimation} from './src/viewers/world/effects-animation.ts'; export {animatedEffectBirthFrames} from './src/viewers/world/effects-frames.ts'; export {WorldEffectsLayer} from './src/viewers/world/effects-layer.ts'; export {PlaybackBar} from './src/viewers/rig.ts'; export * from './vendor/three.module.js';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const T = await import(pathToFileURL(file).href);
  const skel = {i: 7, bones: [{parent: -1, scale: [1,1,1], quat: [0,0,0,1], trans: [5,0,0], bind: [1,0,0,5,0,1,0,0,0,0,1,0]}]};
  const clip = {i: 9, skel: 7, duration_ms: 40, frame_ms: 40, frames: 2, bones: [{present: true,
    rot: {mode: 'const', value: [0,0,0,1]}, trans: {mode: 'track', data: Buffer.from(new Float32Array([5,0,0,45,0,0]).buffer).toString('base64')}}]};
  let checks = 0;
  for (const loop of [false,true]) for (const mode of ['bone','skin']) for (const rot of [0,1,2,3]) for (const reflected of [false,true]) {
    let timeMs = 0;
    const animation = new T.EffectBoneAnimation(skel, clip, loop, 600, () => timeMs);
    const doc = {tick_rate: {value: 600}, rigs: {'7': [new T.Matrix4().makeTranslation(5,0,0).elements]},
      configs: {1: {kind: 'burst_windowed', per_second: 60, windows: [[0,30]]}},
      systems: [{slot: 1, loop: true, cycle_ticks: 40, triggered: false, names: [], rig_selection: {alternate: false},
        emitters: [{slot: 2, life: {ticks: 100}, burst: 1, sprite: {images: [-1]}, transform: {primary: 0, secondary: 0, mode}}]}],
      attachments: {rooms: [{room: 1, occurrence: 2, system: 1, rig: 7, cell: [0,0,0], center: [2,3], rot, packedFlags: reflected ? 4 : 0}]}};
    const layer = new T.WorldEffectsLayer({root: new T.Group(), doc, url: (s: string) => s, textures: {}, tileUnits: 1024, layerUnits: 512});
    const owner = new T.Matrix4().makeTranslation(2048+8192,3072-4096,0).multiply(new T.Matrix4().makeRotationZ((rot+2)*Math.PI/2));
    if (reflected) owner.multiply(new T.Matrix4().makeScale(-1,1,1));
    layer.setOccurrenceAnimation(1,2,animation);
    layer.addRoom(1,[8192,-4096]);
    const rec = () => layer._rooms.get(1)[0];
    const phase = (ticks: number) => {
      const ms = ticks * 1000 / 600;
      return Math.trunc(loop && ms > 40 ? ms % 40 : Math.min(40,ms));
    };
    const verify = (ticks: number) => {
      timeMs = ticks * 1000 / 600;
      const sim = rec().emitters[0].sim;
      sim.shape.center = [0,0,0]; sim.shape.w = [0,0,0]; sim.accel = [0,0,0]; sim.speed = 0;
      layer.setClock(9000);
      const snapshot = layer.snapshot();
      const actual = snapshot.flatMap((b: any) => Array.from({length: b.count}, (_, i) => b.posSize.slice(i*4,i*4+3)));
      const expected: number[][] = [];
      for (let j=sim.tail;j<sim.head;j++) {
        const born=sim.spawnTick(j), age=ticks-born;
        if (age<0 || age>=sim.life) continue;
        expected.push(new T.Vector3(phase(born)+(mode==='bone'?5:0),0,0).applyMatrix4(owner).toArray());
      }
      assert.equal(actual.length,expected.length);
      for (let i=0;i<expected.length;i++) assert(new T.Vector3(...actual[i]).distanceTo(new T.Vector3(...expected[i]))<.002);
      const marker=new T.Vector3(phase(ticks)+(mode==='bone'?5:0),0,0).applyMatrix4(owner);
      assert(rec().proxy.position.distanceTo(marker)<.001);
      checks++;
      return snapshot;
    };
    verify(0); verify(10); const at50=verify(50); verify(200); verify(0); assert.deepEqual(verify(50),at50);
    layer.tick(500,null); assert.deepEqual(layer.snapshot(),at50);
    layer.setInstancePaused('1|2|1',true); timeMs=500; layer.tick(10,null); assert.deepEqual(layer.snapshot(),at50);
    timeMs=50*1000/600; layer.setInstancePaused('1|2|1',false);
    layer.removeRoom(1); layer.addRoom(1,[8192,-4096]); assert.deepEqual(verify(50),at50);
    layer.setOccurrenceAnimation(1,2,null); layer.setClock(0);
    assert.equal(rec().animation,null); assert.deepEqual(rec().emitters[0].sim.spawnCenter(70),[mode==='bone'?5:0,0,0]);
    const wrongRig = new T.EffectBoneAnimation({...skel,i:8},clip,true,600,()=>0);
    layer.setOccurrenceAnimation(1,2,wrongRig); assert.equal(rec().animation,null);
    wrongRig.dispose(); animation.dispose(); layer.dispose();
  }
  const identity = new T.Matrix4().elements;
  assert.equal(T.animatedEffectBirthFrames({primary: 1,secondary:'root',mode:'bone'},[identity],[identity],identity),null);
  assert.equal(T.animatedEffectBirthFrames({primary: 0,secondary:'root',mode:'skin'},[identity],[],identity),null);
  assert.equal(T.animatedEffectBirthFrames({primary: 0,secondary:'root',mode:'bone'},[[NaN,...identity.slice(1)]],[identity],identity),null);
  const bar=Object.create(T.PlaybackBar.prototype);
  bar.t=0; bar.loop=true; bar.speed=1; bar.playing=true; bar.sampler={duration:40};
  bar.applyPose=()=>{}; bar.playBtn={textContent:''};
  bar.tick(40); assert.equal(bar.t,40); bar.tick(40); assert.equal(bar.t,0); assert.equal(bar.elapsedMs,80);
  bar.tick(15); assert.equal(bar.t,15); assert.equal(bar.elapsedMs,95);
  bar.t=7; assert.equal(bar.elapsedMs,7); bar.loop=false; bar.tick(100); assert.equal(bar.t,40); assert.equal(bar.elapsedMs,40); assert.equal(bar.playing,false);
  bar.play(); assert.equal(bar.t,0); assert.equal(bar.elapsedMs,0);
  console.log(`Animated effect checks passed: ${checks}; rewind, loop, pause, room reload, rig rejection and transport`);
} finally { await rm(tmp,{recursive:true,force:true}); }
