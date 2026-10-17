import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
// Emission timed by steps: a stream whose steps release several particles at once, and bursts after drawn waits.
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-steps-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export {EmitterSim,EFFECT_GAP_STEP} from './src/viewers/world/effects-sim.ts';export {steppedEmission} from './src/extract/world/effects.ts';",
  resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'error'});
 const {EmitterSim,EFFECT_GAP_STEP,steppedEmission}=await import(pathToFileURL(file).href);
 // (a four-byte whole number as the decoder reads it: one float, a denormal)
 const lane=(n:number)=>{const v=new DataView(new ArrayBuffer(4));v.setInt32(0,n);return v.getFloat32(0);};
 const back={op:0,kind:'scalar',tag:-85,value:7};
 const s1=steppedEmission([back,{op:1,kind:'int',value:18},{op:2,kind:'fixed',floats:[lane(1)]}]);
 assert.equal(s1.kind,'burst_continuous');assert.equal(s1.perSecond,18);assert.equal(s1.perStep,1);assert.equal(s1.used.length,2);
 assert.equal(steppedEmission([back,{op:1,kind:'int',value:10},{op:2,kind:'fixed',floats:[lane(3)]}]).perStep,3);
 assert.equal(steppedEmission([back,{op:1,kind:'int',value:10},{op:2,kind:'fixed',floats:[0.5]}]),null,'a real float is no count');
 assert.equal(steppedEmission([back,{op:1,kind:'int',value:0},{op:2,kind:'fixed',floats:[lane(1)]}]),null,'no steps');
 const s2=steppedEmission([back,{op:1,kind:'int',value:30},{op:2,kind:'duration',ticks:60},{op:3,kind:'duration',ticks:120},
  {op:4,kind:'int',value:50},{op:5,kind:'int',value:0}]);
 assert.deepEqual({kind:s2.kind,perSecond:s2.perSecond,gaps:s2.gaps,used:s2.used.length},{kind:'burst_gaps',perSecond:30,gaps:{min:60,max:120,count:50},used:4});
 assert.equal(steppedEmission([back,{op:1,kind:'int',value:30},{op:2,kind:'duration',ticks:120},{op:3,kind:'duration',ticks:60},
  {op:4,kind:'int',value:50},{op:5,kind:'int',value:0}]),null,'waits out of order');

 const tickRate=600;
 const snapshot=(s:any,t:number)=>{s.ensure(t);const rows:number[][]=[];s.evaluate(t,(...v:number[])=>rows.push(v));return rows;};
 // Steps of three: each step's particles share its tick.
 const stream=(stride=1)=>{const s=new EmitterSim({slot:1,loop:true},0,{slot:2,life:{ticks:700},burst:1,speed:{value:1000}},
  {1:{kind:'burst_continuous',per_second:2,per_step:3}},tickRate);s.setStride(stride);return s;};
 assert.deepEqual([0,1,2,3,4,5,6].map(i=>stream().spawnTick(i)),[0,0,0,300,300,300,600]);
 const one=stream();one.ensure(0);assert.equal(one.head,3,'the first step releases three');
 one.ensure(299);assert.equal(one.head,3);one.ensure(300);assert.equal(one.head,6);
 let checks=0;
 for(const stride of [1,2]) {
  const sim=stream(stride);
  for(const t of [0,10,299,300,301,650,700,701,1400,5000,300,0,701]) {
   assert.deepEqual(snapshot(sim,t),snapshot(stream(stride),t),`stepped stream seek differs at ${t}, stride ${stride}`);checks++;
  }
 }
 // Bursts after drawn waits: 50 at step 0, then each next after trunc(wait / step ticks) + 1 steps.
 const gaps=(stride=1,seed=0)=>{const s=new EmitterSim({slot:1,loop:true},0,{slot:2,life:{ticks:400},burst:1,speed:{value:1000}},
  {1:{kind:'burst_gaps',per_second:30,gaps:{min:60,max:120,count:50}}},tickRate);s.setStride(stride);if(seed)s.setInstanceSeed(seed);return s;};
 const g=gaps();g.ensure(0);assert.equal(g.head,50,'the first burst at the first step');
 g.ensure(5000);
 const births=[...new Set([...Array(g.head-g.tail)].map((_,i)=>g.spawnTick(g.tail+i)))].sort((a,b)=>a-b);
 const stepTicks=tickRate/30;
 for(const b of births) assert.equal(b%stepTicks,0,'bursts land on steps');
 const lo=(Math.trunc(60/EFFECT_GAP_STEP)+1)*stepTicks,hi=(Math.trunc(120/EFFECT_GAP_STEP)+1)*stepTicks;
 for(let i=1;i<births.length;i++) assert(births[i]-births[i-1]>=lo&&births[i]-births[i-1]<=hi,`wait ${births[i]-births[i-1]}`);
 assert(births.length>=Math.floor(400/hi),'every burst a life spans is alive');
 for(const b of births) assert.equal([...Array(g.head-g.tail)].filter((_,i)=>g.spawnTick(g.tail+i)===b).length,50,'a whole burst at once');
 for(const stride of [1,3]) for(const seed of [0,9]) {
  const sim=gaps(stride,seed);
  for(const t of [0,19,20,100,399,400,401,2000,100000,150,0,100001]) {
   assert.deepEqual(snapshot(sim,t),snapshot(gaps(stride,seed),t),`gap bursts seek differs at ${t}, stride ${stride}, seed ${seed}`);checks++;
  }
 }
 // Malformed counts and waits: never a NaN or an endless schedule; a stream without a count is as before.
 const plainStream=(cfg:any)=>new EmitterSim({slot:1,loop:true},0,{slot:2,life:{ticks:700},burst:1,speed:{value:1000}},{1:cfg},tickRate);
 const before=plainStream({kind:'burst_continuous',per_second:7});
 for(const per_step of [undefined,NaN,0,-3,1e9,Infinity,'x']) {
  const s=plainStream({kind:'burst_continuous',per_second:7,per_step});
  assert.deepEqual([0,1,2,3].map(i=>s.spawnTick(i)),[0,85,171,257],`per_step ${per_step} keeps one a step`);
  assert(Number.isFinite(s.rate)&&Number.isFinite(s.step)&&Number.isFinite(s.capacity));
  assert.deepEqual(snapshot(s,1000),snapshot(before,1000));checks++;
 }
 for(const gapsCfg of [null,{min:NaN,max:120,count:5},{min:-1,max:120,count:5},{min:120,max:60,count:5},{min:60,max:120,count:0},
  {min:60,max:120,count:NaN},{min:60,max:Infinity,count:5},{min:60.5,max:120,count:5},{min:60,max:120,count:1e9}]) {
  const s=plainStream({kind:'burst_gaps',per_second:30,gaps:gapsCfg});
  assert.equal(s.rate,0,`bad waits ${JSON.stringify(gapsCfg)} leave the emitter inert`);
  assert(Number.isFinite(s.capacity));s.ensure(5000);assert.equal(s.alive,0);checks++;
 }
 const noRate=plainStream({kind:'burst_gaps',per_second:0,gaps:{min:60,max:120,count:5}});
 noRate.ensure(5000);assert.equal(noRate.alive,0);
 console.log(`${checks} stepped and gap-timed emission checks passed`);
} finally {await rm(tmp,{recursive:true,force:true});}
