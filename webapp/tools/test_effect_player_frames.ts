import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-player-frames-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export {EffectsPlayer} from './src/viewers/world/effects-player.ts'; export {WorldEffectsLayer} from './src/viewers/world/effects-layer.ts'; export {EffectBoneAnimation} from './src/viewers/world/effects-animation.ts'; export * from './vendor/three.module.js';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const T = await import(pathToFileURL(file).href);
  const skel = {i: 7, bones: [
    {parent: -1, scale: [1,1,1], quat: [0,0,0,1], trans: [5,-3,7], bind: [1,0,0,5,0,1,0,-3,0,0,1,7]},
    {parent: 0, scale: [1,1,1], quat: [0,0,Math.SQRT1_2,Math.SQRT1_2], trans: [2,4,1], bind: [0,-1,0,2,1,0,0,4,0,0,1,1]},
  ]};
  const clip = {i: 9, skel: 7, duration_ms: 200, frame_ms: 200, frames: 2, bones: [
    {present: true, rot: {mode: 'const', value: [0,0,0,1]}, trans: {mode: 'track', data: Buffer.from(new Float32Array([5,-3,7,45,-3,7]).buffer).toString('base64')}},
    {present: true, rot: {mode: 'const', value: [0,0,Math.SQRT1_2,Math.SQRT1_2]}, trans: {mode: 'const', value: [2,4,1]}},
  ]};
  const bonesAt = (move: number) => {
    const root = new T.Matrix4().makeTranslation(5+move,-3,7);
    return [root, root.clone().multiply(new T.Matrix4().makeTranslation(2,4,1)).multiply(new T.Matrix4().makeRotationZ(Math.PI/2))];
  };
  const rest = bonesAt(0), identity = new T.Matrix4();
  let checks = 0;
  for (const loop of [false,true]) for (const primary of ['root',null,0,1]) for (const secondary of ['root',null,0,1]) for (const mode of ['bone','skin']) {
    let timeMs = 0;
    const animation = new T.EffectBoneAnimation(skel, clip, loop, 600, () => timeMs);
    const emitter = {slot: 2, life: {ticks: 300}, burst: 1, sprite: {images: [-1]}, facing: {mode: 'direction_single', axis: [2,3,7]}, transform: {primary, secondary, mode}};
    const doc = {tick_rate: {value: 600}, rigs: {'7': rest.map(m => m.elements)},
      configs: {1: {kind: 'burst_windowed', per_second: 10, windows: [[0,60]]}},
      systems: [{slot: 1, loop: true, triggered: false, cycle_ticks: 120, rig_selection: {alternate: false}, emitters: [emitter]}],
      attachments: {rooms: [{room: 1, occurrence: 2, system: 1, rig: 7, cell: [0,0,0], center: [0,0], rot: 2}]}};
    const root = new T.Group();
    const player = new T.EffectsPlayer({root, doc, url: (s: string) => s, rig: {id: 7, bones: rest.map(m => m.elements)}});
    const world = new T.WorldEffectsLayer({root: new T.Group(), doc, url: (s: string) => s, textures: {}, tileUnits: 1, layerUnits: 1});
    try {
      player.addSystem(1); player.setAnimation(1, animation);
      world.setOccurrenceAnimation(1,2,animation); world.addRoom(1,[0,0]);
      const sim = player._instances.get(1).emitters[0].sim;
      for (const s of [sim, world._rooms.get(1)[0].emitters[0].sim]) {
        s.shape.center = [2,3,4]; s.shape.w = [1,0,0]; s.shape.yaw = 0; s.shape.pitch = 0;
        s.speed = 10/600; s.accel = [0,2/(600*600),0];
      }
      const snapshot = () => {
        const rows: number[][] = [];
        root.traverse((o: any) => {if(o.geometry?.attributes.aPosSize) {
          const g=o.geometry;for(let j=0;j<g.instanceCount;j++) rows.push([...g.attributes.aPosSize.array.slice(j*4,j*4+3)]);
        }});
        return rows;
      };
      const verify = (ticks: number) => {
        timeMs = ticks*1000/600;
        player.setClock(9000); world.setClock(9000);
        const actual = snapshot();
        const axes = (group: any) => {
          const result: number[][]=[];
          group.traverse((o: any) => {const g=o.geometry;if(g?.attributes.aFacing)
            for(let i=0;i<g.instanceCount;i++)result.push([...g.attributes.aFacing.array.slice(i*3,i*3+3)]);});
          return result;
        };
        const playerAxes=axes(root),worldAxes=axes(world.root);
        const worldRows = world.snapshot().flatMap((b: any) => Array.from({length:b.count},(_,i)=>b.posSize.slice(i*4,i*4+3)));
        const births: number[] = [];
        for(let birth=0;birth<=ticks;birth+=60) if(ticks-birth<300) births.push(birth);
        assert.equal(actual.length,births.length);
        assert.equal(worldRows.length,births.length);
        for(let j=0;j<births.length;j++) {
          const born=births[j], age=(ticks-born)/600;
          const ms=born*1000/600, phase=Math.trunc(loop&&ms>200?ms%200:Math.min(ms,200));
          const posed=bonesAt(phase*.2);
          const pm=typeof primary==='number'?posed[primary].clone():identity;
          if(typeof primary==='number'&&mode==='skin')pm.multiply(rest[primary].clone().invert());
          const dm=typeof secondary==='number'?posed[secondary]:identity;
          const direction=new T.Vector3(1,0,0).applyMatrix3(new T.Matrix3().setFromMatrix4(dm));
          const normal=new T.Vector3(2,3,7).applyMatrix3(new T.Matrix3().setFromMatrix4(dm));
          assert(new T.Vector3(...playerAxes[j]).distanceTo(normal)<.0001);
          assert(new T.Vector3(...worldAxes[j]).distanceTo(normal)<.0001);
          const expected=new T.Vector3(2,3,4).applyMatrix4(pm).addScaledVector(direction,10*age).add(new T.Vector3(0,age*age,0));
          assert(new T.Vector3(...actual[j]).distanceTo(expected)<.0001,JSON.stringify({loop,primary,secondary,mode,ticks,born,actual:actual[j],expected}));
          assert(new T.Vector3(...worldRows[j]).distanceTo(new T.Vector3(...actual[j]))<.0001);
        }
        checks++;
        return actual;
      };
      verify(0); verify(60); const before=verify(150); verify(360); assert.deepEqual(verify(150),before);
      player.tick(1000); assert.deepEqual(snapshot(),before,'ambient attachment follows the paused animation clock');
      player.syncClock(1,60); assert.equal(snapshot().length,2);
      player.unslave(1); timeMs=1000; player.tick(1000); assert.equal(snapshot().length,2,'frozen time overrides the animation clock');
      player.setAnimation(1,null);
      assert.equal(player._instances.get(1).animation,null);
      const expectedRest=new T.Vector3(2,3,4).applyMatrix4(typeof primary==='number'&&mode==='bone'?rest[primary]:identity);
      assert(new T.Vector3(...sim.spawnCenter(0)).distanceTo(expectedRest)<1e-8);
      const wrongRig=new T.EffectBoneAnimation({...skel,i:8},clip,loop,600,()=>0);
      player.setAnimation(1,wrongRig); assert.equal(player._instances.get(1).animation,null); wrongRig.dispose();
    } finally {player.dispose();world.dispose();animation.dispose();}
  }
  console.log(`${checks} model/world attachment comparisons passed: position/direction selectors, skin frames, fixed sprite planes, acceleration, past births, loops, pause, reverse seek and rig rejection`);
} finally {await rm(tmp,{recursive:true,force:true});}
