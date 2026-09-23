import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-scales-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/effect-scales.ts'; export {EmitterSim} from './src/viewers/world/effects-sim.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 const binding={instance:2,start:6,end:9,rangeClass:7};
 const read=T.createEffectScaleReader([binding],[{values:[0,2]}]);
 const range={op:6,kind:'typed',class:7,fields:[{op:6,kind:'float',value:3},{op:6,kind:'float',value:-2}]};
 const end={op:9,kind:'symbol',name:'$scale0'};
 assert.deepEqual(read(0,[range,end]),{start:[3,-2],end:'start'});
 assert.equal(read(1,[range,end]),null);
 assert.equal(read(0,[{...range,class:8},end]),null);
 assert.equal(read(0,[range,{...end,name:'$speed0'}]),null);
 assert.equal(read(0,[{...range,fields:[...range.fields,{kind:'float',value:5}]},end]),null);
 assert.throws(()=>T.createEffectScaleReader([binding,binding],[]));
 assert(!T.validEffectScales([{...binding,end:6}]));
 const create=(scales:any)=>new T.EmitterSim({slot:1,loop:true},0,
  {life:{ticks:100},burst:1,scale0:{value:0},scales},
  {1:{kind:'burst_continuous',per_second:10}},100);
 const snapshot=(s:any,t:number)=>{s.ensure(t);const rows:number[][]=[];s.evaluate(t,(...p:number[])=>rows.push([p[3]]));return rows;};
 for(const scales of [{start:[1,2],end:'start'},{start:[-2,3],end:[4,6]},{start:2,end:[-2,-1]}]) {
  for(const stride of [1,3]){
   const sim=create(scales);sim.setStride(stride);
   for(const tick of [0,30,150,20,500,0]){
    const fresh=create(scales);fresh.setStride(stride);
    assert.deepEqual(snapshot(sim,tick),snapshot(fresh,tick));
   }
  }
 }
 const sim=create({start:[1,2],end:'start'});
 const first=snapshot(sim,0)[0][0];assert(first>=1&&first<=2);
 assert.equal(snapshot(sim,5)[0][0],first,'repeated endpoint retains the sampled start');
 const full=create({start:[1,2],end:'start'}),sparse=create({start:[1,2],end:'start'});sparse.setStride(3);
 assert.deepEqual(snapshot(sparse,90),snapshot(full,90).filter((_,i)=>i%3===0),'thinning retains original particle size draws');
 assert(new Set(snapshot(full,90).map(r=>r[0])).size>1,'range is sampled, not averaged');
 console.log('Scale ranges: source guards, repeated endpoints, 36 seeks and stride stability passed');
}finally{await rm(tmp,{recursive:true,force:true});}
