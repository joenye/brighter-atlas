import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
// An arc: each particle on the level circle at its drawn angle, aimed straight out and raised by its draw.
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-arc-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export {EmitterSim} from './src/viewers/world/effects-sim.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const {EmitterSim}=await import(pathToFileURL(file).href);
 const near=(a:number,b:number)=>assert(Math.abs(a-b)<1e-4,`${a} != ${b}`);   // (positions are 32-bit floats)
 const born=(arc:any,centre:number[],speed:number)=>{
  const sim=new EmitterSim({slot:1,loop:true},0,
   {slot:2,life:{ticks:100},burst:1,shape:2,speed:{value:speed}},
   {1:{kind:'burst_continuous',per_second:1},2:{kind:'shape',shape_kind:'arc',center:centre,arc}},1000);
  sim.ensure(1);const out:number[][]=[];
  sim.evaluate(1,(x:number,y:number,z:number)=>out.push([x,y,z]));
  assert.equal(out.length,1);return out[0];
 };
 // a fixed angle: on the circle at +y, moving straight out (one unit by the first evaluation)
 born({radius:100,angles:[90,90],tilt:0},[5,6,7],1000).forEach((v,i)=>near(v,[5,107,7][i]));
 born({radius:950,angles:[180,180],tilt:0},[0,0,550],0).forEach((v,i)=>near(v,[-950,0,550][i]));
 // any draw: on the circle within its angles, level with the centre
 let checks=2;
 for(let k=0;k<200;k++){
  const [x,y,z]=born({radius:950,angles:[0,45],tilt:0},[0,0,550],0);
  near(Math.hypot(x,y),950);near(z,550);
  const a=Math.atan2(y,x)*180/Math.PI;assert(a>=-1e-9&&a<=45+1e-9,`angle ${a}`);checks++;
 }
 console.log(`${checks} arc spawn checks passed`);
}finally {await rm(tmp,{recursive:true,force:true});}
