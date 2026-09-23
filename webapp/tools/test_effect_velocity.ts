import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-velocity-'));
try{
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export {EmitterSim} from './src/viewers/world/effects-sim.ts'; export {EffectsPlayer} from './src/viewers/world/effects-player.ts'; export {WorldEffectsLayer} from './src/viewers/world/effects-layer.ts'; export * from './vendor/three.module.js';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 const configs={1:{kind:'burst_windowed',per_second:600,windows:[[0,0]]},2:{kind:'shape',shape_kind:'point',center:[0,0,0],axis:[1,0,0],spread_yaw:0,spread_pitch:0}};
 const emitter={slot:2,life:{ticks:1200},burst:1,shape:2,sprite:{images:[-1]},facing:{mode:'velocity_single',axis:null},speed:{value:8},speed1:{value:0},acceleration:{v:[2,0,-4]},acceleration1:{v:[-2,4,8]},angular_speed:{value:180}};
 const system={slot:1,loop:false,emitters:[emitter]};
 const sim=new T.EmitterSim(system,0,emitter,configs,600);
 for(const tick of [0,150,600,1050,600]){
  sim.ensure(tick);let sample:number[]=[];sim.evaluate(tick,(...p:number[])=>sample=p);
  const t=tick/600,expected=[8-2*t-t*t,t*t,-4*t+3*t*t];
  for(let i=0;i<3;i++)assert(Math.abs(sample[9+i]-expected[i])<1e-6,JSON.stringify({tick,sample,expected}));
  assert.equal(sample[12],1);
 }
 const doc={tick_rate:{value:600},configs,systems:[system],attachments:{rooms:[{room:1,occurrence:2,system:1,cell:[0,0,0],center:[0,0],rot:2}]}};
 const camera=new T.PerspectiveCamera();camera.position.z=10;camera.updateMatrixWorld();
 for(const tileUnits of [1,128,512,1024]){
  const playerRoot=new T.Group(),worldRoot=new T.Group();
  const player=new T.EffectsPlayer({root:playerRoot,doc,url:(s:string)=>s});
  const world=new T.WorldEffectsLayer({root:worldRoot,doc,url:(s:string)=>s,textures:{},tileUnits,layerUnits:tileUnits});
  try{
   player.addSystem(1);player.syncClock(1,600);player.tick(0,camera);
   world.addRoom(1,[0,0]);world.setClock(600,camera);
   for(const [root,units] of [[playerRoot,1],[worldRoot,tileUnits]]){
    let batches=0;root.traverse((o:any)=>{const g=o.geometry;if(!g?.attributes.aFacing)return;batches++;
     assert.equal(g.instanceCount,1);assert.equal(g.attributes.aFacingMode.array[0],1);
     const axis=[...g.attributes.aFacing.array.slice(0,3)];
     for(let i=0;i<3;i++)assert(Math.abs(axis[i]-[5,1,-1][i])<1e-5,JSON.stringify({units,axis}));
     assert.equal(o.material.uniforms.uFacingSizeScale.value,units);
     assert(Math.abs(g.attributes.aPosSize.array[3]*units-1)<1e-6);
    });assert.equal(batches,1);
   }
  }finally{player.dispose();world.dispose();}
 }
 console.log('Velocity motion, reverse seek and native-unit uploads passed on both surfaces at four world scales');
}finally{await rm(tmp,{recursive:true,force:true});}
