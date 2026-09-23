import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-windows-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/effect-windows.ts'; export {EmitterSim} from './src/viewers/world/effects-sim.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 const binding={instance:7,rate:1,windows:2,period:3,rangeClass:9,noneSymbol:6};
 const reader=T.createEffectWindowReader([binding],[{values:[0,7]}]);
 const duration=(ticks:number)=>({op:2,kind:'duration',ticks});
 const range=(a:number,b:number)=>({op:2,kind:'typed',class:9,fields:[duration(a),duration(b)]});
 const ops=[{op:1,kind:'int',value:700},{op:2,kind:'list',tag:32,values:[range(2,5),range(7,9)]},{op:3,kind:'symbol',index:6,name:'$none'}];
 assert.deepEqual(reader(0,ops),{rate:700,windows:[[2,5],[7,9]],period:null});
 assert.equal(reader(1,ops),null);
 assert.equal(reader(0,[ops[0],range(5,2),ops[2]]),null);
 assert.equal(reader(0,[ops[0],ops[1],{op:3,kind:'symbol',index:8,name:'$none'}]),null);
 assert.equal(reader(0,[ops[0],ops[1],{op:3,kind:'duration',ticks:0}]),null);
 assert.equal(T.validEffectWindows([binding,binding]),false);
 const make=(period:number|null,rate=700)=>new T.EmitterSim({slot:1,loop:true,cycle_ticks:9999},0,
  {slot:2,life:{ticks:13},burst:1,speed:{value:1000}},
  {1:{kind:'burst_windowed',emission_window:{rate,windows:[[2,5],[7,9]],period}}},1000);
 const samples=(s:any,t:number)=>{s.ensure(t);const v:any[]=[];s.evaluate(t,(...r:number[])=>v.push(r));return v;};
 const expected=(t:number,period:number|null,rate:number,stride:number)=>{
  const end=Math.trunc(Math.fround(Math.fround(t*rate)/1000));const births:number[]=[];
  for(let n=0;n<=end;n+=stride){const born=Math.trunc(n*1000/rate),phase=period===null?born:born%period;
   if(born+13>t&&((phase>=2&&phase<5)||(phase>=7&&phase<9)))births.push(born);}
  return births;
 };
 let checks=0;
 for(const period of [null,10])for(const rate of [700,3000])for(const stride of [1,3]){
  const sim=make(period,rate);sim.setStride(stride);
  for(const t of [0,2,3,4,5,7,8,9,10,12,15,20,100,1000,7,0,20]){
   const fresh=make(period,rate);fresh.setStride(stride);
   assert.deepEqual(samples(sim,t),samples(fresh,t));
   const births=[];for(let j=sim.tail;j<sim.head;j++)births.push(sim.birth[j%sim.capacity]);
   assert.deepEqual(births,expected(t,period,rate,stride));
   const continuous=new T.EmitterSim({slot:1,loop:true},0,{slot:2,life:{ticks:13},burst:1,speed:{value:1000}},
     {1:{kind:'burst_continuous',per_second:rate}},1000);
   continuous.setStride(stride);const all=samples(continuous,t);
   const chosen=all.filter((_,i)=>{const born=continuous.birth[(continuous.tail+i)%continuous.capacity];
     const phase=period===null?born:born%period;return (phase>=2&&phase<5)||(phase>=7&&phase<9);});
   assert.deepEqual(samples(sim,t),chosen,'skipped windows must preserve global counter randomness');
   checks++;
  }
 }
 const attached=make(null);attached.speed=0;
 attached.setBirthFrameSampler((tick:number)=>({position:[1,0,0,0,0,1,0,0,0,0,1,0,tick,0,0,1],direction:null}));
 assert.deepEqual(samples(attached,9).map(v=>v[0]),[2,4,7,8]);
 assert.deepEqual(samples(attached,100),[],'no invented repeat from loop flag or system cycle');
 console.log(`${checks} window timing/seek/stride comparisons, source guards and attachment samples passed`);
} finally {await rm(tmp,{recursive:true,force:true});}
