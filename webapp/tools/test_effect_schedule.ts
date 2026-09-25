import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-schedule-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export {EmitterSim} from './src/viewers/world/effects-sim.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const {EmitterSim}=await import(pathToFileURL(file).href);
 const create=(rate:number)=>new EmitterSim({slot:1,loop:true},0,
  {slot:2,life:{ticks:13},burst:1,speed:{value:1000}},
  {1:{kind:'burst_continuous',per_second:rate}},1000);
 const sparse=create(7);
 assert.deepEqual([0,1,2,3].map(i=>sparse.spawnTick(i)),[0,142,285,428]);
 const dense=create(2000);
 // A timestamp of zero does not allow the second particle to appear at zero.
 dense.ensure(0);assert.equal(dense.head,1);
 dense.ensure(.5);assert.equal(dense.head,2);
 assert.deepEqual([...dense.birth.slice(0,2)],[0,0]);
 dense.ensure(1);assert.equal(dense.head,3);
 const attached=create(7);attached.speed=0;
 attached.setBirthFrameSampler((tick:number)=>({
  position:[1,0,0,0,0,1,0,0,0,0,1,0,tick,0,0,1],
  direction:null,
 }));
 attached.ensure(145);const positions:number[]=[];
 attached.evaluate(145,(x:number)=>positions.push(x));
 assert.deepEqual(positions,[142], 'attachment samples the integral birth pose');
 let checks=0;
 for(const rate of [7,11,2000]) for(const stride of [1,3]) {
  const sim=create(rate);sim.setStride(stride);
  const snapshot=(s:any,t:number)=>{s.ensure(t);const rows:number[][]=[];s.evaluate(t,(...v:number[])=>rows.push(v));return rows;};
  for(const t of [0,.5,1,2,12,13,14,100,142,143,428,429,12,0,143]) {
   const fresh=create(rate);fresh.setStride(stride);
   assert.deepEqual(snapshot(sim,t),snapshot(fresh,t),`seek differs at rate ${rate}, stride ${stride}, time ${t}`);
   for(let j=sim.tail;j<sim.head;j++)assert(sim.spawnTick(j)+sim.life>t);
   checks++;
  }
 }
 console.log(`${checks} schedule seek/stride checks, integral births and separate eligibility passed`);
} finally {await rm(tmp,{recursive:true,force:true});}
