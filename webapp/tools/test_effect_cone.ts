import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-cone-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export {EmitterSim,sampleConeDirection} from './src/viewers/world/effects-sim.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const {EmitterSim,sampleConeDirection}=await import(pathToFileURL(file).href);
 const near=(a:number,b:number)=>assert(Math.abs(a-b)<1e-6,`${a} != ${b}`);
 for(const axis of [[0,0,1],[0,0,-1],[1,0,0],[0,1,0],[2,-3,-4]]) {
  const length=Math.hypot(...axis);
  const d=sampleConeDirection(axis,[0,2*Math.PI],[0,0],.7,.4);
  d.forEach((v:number,i:number)=>near(v,axis[i]/length));
  for(let i=0;i<=100;i++) {
   const v=sampleConeDirection(axis,[.2,5.5],[.1,1.2],i/100,i/100);
   near(Math.hypot(...v),1);
   near(v.reduce((sum:number,x:number,j:number)=>sum+x*axis[j]/length,0),Math.cos(.1)+(Math.cos(1.2)-Math.cos(.1))*i/100);
  }
 }
 // The real simulator must retain a nonzero azimuth and polar lower bound.
 const sim=new EmitterSim({slot:1,loop:true},0,
  {slot:2,life:{ticks:100},burst:1,shape:2,speed:{value:1000}},
  {1:{kind:'burst_continuous',per_second:1},2:{kind:'shape',shape_kind:'point',axis:[0,0,1],cone:{yaw:[90,90],pitch:[90,90]}}},1000);
 sim.ensure(1);const positions:number[][]=[];
 sim.evaluate(1,(x:number,y:number,z:number)=>positions.push([x,y,z]));
 assert.equal(positions.length,1);positions[0].forEach((v,i)=>near(v,[0,1,0][i]));
 console.log('505 cone distribution checks, axial limits and simulator endpoint preservation passed');
}finally {await rm(tmp,{recursive:true,force:true});}
