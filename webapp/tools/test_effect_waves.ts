// Wave-timed bursts: reading the burst and its water style through per-build
// field bindings, the two-sine height field, and the crest schedule (fire on
// reaching the threshold, re-arm only below zero) under seeks and thinning.
// Synthetic records only.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-waves-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/effect-waves.ts'; export {EmitterSim} from './src/viewers/world/effects-sim.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 let checks=0;const ok=(c:any,m:string)=>{assert(c,m);checks++;};
 const binding={instance:3,water:2,point:3,count:4,threshold:5,translation:6,waterFields:{amplitude:[8,12],frequency:[9,13],rate:[10,14]}};
 ok(T.validEffectWaves({step:12,bindings:[binding]}),'valid bindings');
 ok(!T.validEffectWaves({step:0,bindings:[binding]}),'step must be positive');
 ok(!T.validEffectWaves({step:12,bindings:[binding,binding]}),'duplicate instance');
 ok(!T.validEffectWaves({step:12,bindings:[{...binding,waterFields:{amplitude:[8],frequency:[9,13],rate:[10,14]}}]}),'water pairs');
 // Raw rows: pool references (tag 0) resolve through the pool.
 const pool=[{tag:0x0b,value:[20]},{tag:0x26,value:77}];
 const G=(op:number,node:any)=>({op,kind:'G',node});
 const rows:Record<number,any[]>={
  5:[G(2,{tag:0,value:1}),G(3,{tag:0x18,value:[0,-512]}),G(4,{tag:0x0a,value:15}),G(5,{tag:0x0b,value:[9]}),G(6,{tag:0x0d}),G(7,{tag:0x0c})],
  77:[G(8,{tag:0,value:0}),G(9,{tag:0x0b,value:[0.0017]}),G(10,{tag:0x0b,value:[0.004]}),G(12,{tag:0x0b,value:[40]}),G(13,{tag:0x0b,value:[0.0011]}),G(14,{tag:0x0b,value:[0.007]})],
 };
 const objects:any[]=[];objects[5]={values:[0,3]};objects[6]={values:[0,4]};
 const read=T.createEffectWaveReader({step:12,bindings:[binding]},objects,(slot:number)=>rows[slot]??null,pool);
 const wave=read(5);
 assert.deepEqual(wave,{step:12,count:15,threshold:9,point:[0,-512],translation:false,
  water:{amplitude:[20,40],frequency:[0.0017,0.0011],rate:[0.004,0.007]}});checks++;
 ok(read(6)===null,'unbound instance');
 const broken=(mutate:(r:any[])=>any[])=>T.createEffectWaveReader({step:12,bindings:[binding]},objects,(slot:number)=>slot===5?mutate(rows[5]):rows[slot],pool)(5);
 ok(broken(r=>r.map(f=>f.op===5?G(5,{tag:0x0b,value:[0]}):f))===null,'zero threshold');
 ok(broken(r=>r.map(f=>f.op===3?G(3,{tag:0x22,value:[0,0,0]}):f))===null,'point must be a pair');
 ok(broken(r=>r.filter(f=>f.op!==2))===null,'missing water');
 ok(broken(r=>r.map(f=>f.op===6?G(6,{tag:0x0c}):f)).translation===true,'translation flag');
 // Height field.
 const h=(x:number,y:number,t:number)=>20*Math.sin(0.0017*x+0.004*t)+40*Math.sin(0.0011*y+0.007*t);
 for(const [x,y,t] of [[0,0,0],[100,-512,600],[-3000,250,12345]])ok(Math.abs(T.waterHeight(wave.water,x,y,t)-h(x,y,t))<1e-9,'height');
 // Crest schedule against an independent state machine on the 12-tick grid.
 const emitter:any={life:{ticks:720},fade_in:{ticks:120},fade_out:{ticks:180},burst:1,shape:2,sprite:{material:1,images:[1]}};
 const configs:any={1:{kind:'burst_wave',wave},2:{kind:'shape',shape_kind:'point',center:[0,0,0],axis:[0,0,1],cone:{yaw:[0,0],pitch:[0,0]}}};
 const frame=[1,0,0,0, 0,1,0,0, 0,0,1,0, 1500,700,0,1];
 const make=()=>{const s=new T.EmitterSim({slot:9,loop:true},0,emitter,configs,600);s.setWaveFrame(frame);return s;};
 const px=1500,py=700-512;
 const fires:number[]=[];let armed=false;
 for(let n=-4096;n<=5000;n++){
  const r=Math.fround(Math.fround(h(px,py,n*12))/9);
  if(r>=1&&armed){armed=false;fires.push(n*12);}else if(r<0)armed=true;
 }
 ok(fires.length>20,'the field crests repeatedly');
 const births=(s:any,t:number)=>{s.ensure(t);const out:number[]=[];for(let j=s.tail;j<s.head;j++)out.push(s.birth[j%s.capacity]);return out;};
 const expectedAt=(t:number)=>fires.filter(f=>f<=t&&f+720>t).flatMap(f=>Array(15).fill(f));
 for(const t of [0,500,2000,7777,20000,60000]){
  const got=births(make(),t);
  ok(JSON.stringify(got)===JSON.stringify(expectedAt(t)),'fresh schedule at '+t);
 }
 // Incremental playback equals fresh rebuilds, including seeks back and forth.
 const walk=make();
 for(const t of [0,10,24,300,301,1200,1250,900,20000,20010,5]){
  ok(JSON.stringify(births(walk,t))===JSON.stringify(births(make(),t)),'walk '+t);
 }
 // Thinning keeps a stable subset of each crest's burst.
 const thin=make();thin.setStride(3);
 const kept=births(thin,20000);
 ok(kept.length>0&&kept.length<births(make(),20000).length,'stride thins bursts');
 // Owner translation only: rotation is ignored for the sample point.
 const turned=[0,1,0,0, -1,0,0,0, 0,0,1,0, 1500,700,0,1];
 const rotated=new T.EmitterSim({slot:9,loop:true},0,emitter,{...configs,1:{kind:'burst_wave',wave:{...wave,translation:true}}},600);
 rotated.setWaveFrame(turned);
 ok(JSON.stringify(births(rotated,20000))===JSON.stringify(births(make(),20000)),'translation-only point');
 console.log(`effect waves: ${checks} reader, field, crest schedule, seek and thinning checks passed`);
}finally{await rm(tmp,{recursive:true,force:true});}
