import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-facing-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/effect-facing.ts'; export {EmitterSim} from './src/viewers/world/effects-sim.ts'; export {EffectsPlayer} from './src/viewers/world/effects-player.ts'; export {WorldEffectsLayer} from './src/viewers/world/effects-layer.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 const bindings=[{instance:5,modeField:31,axisField:46},{instance:8,modeField:12,axisField:null}];
 assert(T.validEffectFacings(bindings));
 for(const bad of [[bindings[0],bindings[0]],[{...bindings[0],modeField:46}],[{...bindings[0],axisField:-1}],[{...bindings[0],axisField:NaN}],[{...bindings[0],instance:65536}]])assert(!T.validEffectFacings(bad));
 const objects=[{values:[0,5]},{values:[0,8]}];
 const read=T.createEffectFacingReader(bindings,objects);
 for(const mode of ['screen','direction_single','direction_plus','direction_screen','velocity_single','velocity_screen']){
  const fields=[{op:46,kind:'vec3',v:[2,-3,7]},{op:31,kind:'symbol',name:'$'+mode},{op:4,kind:'symbol',name:'$velocity_screen'}];
  const expected=mode.startsWith('direction_')?[2,-3,7]:null;
  assert.deepEqual(read(0,fields),{mode,axis:expected});
  assert.deepEqual(read(0,fields.map(e=>e.op===46?{...e,v:[0,0,0]}:e)),{mode,axis:expected?[0,0,0]:null});
  assert.deepEqual(read(0,fields.map(e=>e.op===46?{...e,v:[NaN,0,0]}:e)),{mode,axis:null});
  assert.deepEqual(read(0,fields.filter(e=>e.op!==46)),{mode,axis:null});
  assert.equal(read(2,fields),null);
 }
 // A computed axis must not read an incidental literal from its source.
 assert.deepEqual(read(1,[{op:12,kind:'symbol',name:'$direction_single'},{op:46,kind:'vec3',v:[1,0,0]}]),{mode:'direction_single',axis:null});
 for(const name of ['$unknown_screen','direction_single','$screen_extra',''])assert.equal(read(0,[{op:31,kind:'symbol',name}]),null);
 assert.equal(T.createEffectFacingReader(undefined,objects)(0,[]),null);
 assert.throws(()=>T.createEffectFacingReader([bindings[0],bindings[0]],objects));
 const fields=[{op:31,kind:'symbol',name:'$direction_single'},{op:46,kind:'vec3',v:[1,2,3]}];
 read(0,fields).axis[0]=9;assert.deepEqual(fields[1].v,[1,2,3]);
 const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
 const turned=[0,1,0,0,-1,0,0,0,0,0,1,0,100,200,300,1];
 const sim=new T.EmitterSim({slot:1,loop:false},0,{life:{ticks:100},burst:1,facing:{mode:'direction_single',axis:[2,3,7]}},
  {1:{kind:'burst_windowed',per_second:10,windows:[[0,60]]}},600);
 sim.setBirthFrameSampler((tick:number)=>({position:identity,direction:tick<60?identity:turned}));
 const sample=(tick:number)=>{sim.ensure(tick);const normals:number[][]=[];sim.evaluate(tick,(...p:number[])=>normals.push(p.slice(9,12)));return normals;};
 assert.deepEqual(sample(60),[[2,3,7],[-3,2,7]],'planes retain their own birth direction and ignore translation');
 const before=sample(60);sample(120);assert.deepEqual(sample(60),before,'seeking rebuilds historical planes');
 sim.setBirthFrames(identity,turned);assert.deepEqual(sample(60),[[-3,2,7],[-3,2,7]],'changing frames invalidates stored normals');
 // Projected fixed directions retain their birth frame; projected velocity
 // uses the changing motion vector, independently of any authored fixed axis.
 for(const [mode,code] of [['direction_screen',5],['velocity_screen',4]] as const){
  const projected=new T.EmitterSim({slot:1,loop:false},0,
   {life:{ticks:100},burst:1,speed:{value:600},acceleration:{v:[600,0,0]},
    facing:{mode,axis:[2,3,7]},shape:2},
   {1:{kind:'burst_continuous',per_second:1},2:{kind:'shape',shape_kind:'point',axis:[0,0,1],spread_pitch:0}},600);
  projected.setBirthFrames(identity,turned);
  for(const tick of [0,30,10]){
   projected.ensure(tick);const samples:number[][]=[];projected.evaluate(tick,(...p:number[])=>samples.push(p.slice(9)));
   assert.equal(samples.length,1);assert.equal(samples[0][3],code);
   const expected=mode==='direction_screen'?[-3,2,7]:[tick,0,600];
   samples[0].slice(0,3).forEach((v,i)=>assert(Math.abs(v-expected[i])<1e-4));
  }
 }
 for(const renderer of [T.EffectsPlayer,T.WorldEffectsLayer]){
  const batch={order:[],depth:new Float32Array([2,1,3]),posSize:new Float32Array([1,2,3,4,5,6,7,8,9,10,11,12]),color:new Float32Array(12),rot:new Float32Array([1,2,3]),facing:new Float32Array([1,2,3,4,5,6,7,8,9]),facingMode:new Float32Array([0,1,0])};
  renderer.prototype._sortBatch(batch,3);
  assert.deepEqual([...batch.facing],[7,8,9,1,2,3,4,5,6],'depth sorting keeps planes attached to particles');
  assert.deepEqual([...batch.rot],[3,1,2]);assert.deepEqual([...batch.facingMode],[0,0,1]);
 }
 console.log('Facing fields: all six modes, relocated layouts, unresolved and computed axes and validation passed');
} finally {await rm(tmp,{recursive:true,force:true});}
