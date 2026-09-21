// Moving a reflection into geometry must preserve the complete affine map.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-placement-reflection-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export {WorldScene,composePlacementMatrix} from './src/viewers/world/scene.ts'; export {Matrix4,Vector3} from './vendor/three.module.js';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const {WorldScene,composePlacementMatrix,Matrix4,Vector3}=await import(pathToFileURL(file).href);
 const w=Object.create(WorldScene.prototype);
 Object.assign(w,{occurrenceColumns:{x:0,y:1,z:2,rotation_quarters:3,packed_flags:4},placementColumns:{occurrence:0,matrix:1,mesh:2,material:3,texture:4,render_texture:5,flags:6,recolor:7},tileUnits:1024,layerUnits:512,meshForwardQuarterTurns:2,flags:{},spawnColumns:null,spawnPartColumns:null});
 w._placementAnchor=()=>({center:[4.5,7.5]});
 const matrices=[null,[1,0,0,300,0,1,0,-70,0,0,1,90],[0,-1,0,300,1,0,0,-70,0,0,1,90],[2,.3,0,300,0,1,.2,-70,0,0,.5,90],[-1,0,0,300,0,1,0,-70,0,0,1,90]];
 let checks=0;
 for(const local of matrices)for(const reflected of [false,true])for(let turn=0;turn<4;turn++){
  const flags=turn|(reflected?4:0),row=[0,local?0:-1,0,0,-1,-1,0,-1];
  const shard={occurrences:[[4,7,2,turn,flags]],placements:{models:[row]},matrices:local?[local]:[],recolors:[]};
  const full=w._placementMatrix(shard,row,new Matrix4());
  const batch=w._batchRows(shard)[0];
  assert.equal(batch.reflectLocalX,full.determinant()<0,'bake the total transform handedness');
  const instance=w._placementMatrix(shard,row,new Matrix4(),batch.reflectLocalX);
  assert(instance.determinant()>0,'InstancedMesh must receive positive determinant');
  for(const point of [[2,3,5],[-4,8,6],[0,0,0]]){
   const expected=new Vector3(...point).applyMatrix4(full);
   const baked=new Vector3(...point);if(batch.reflectLocalX)baked.x=-baked.x;baked.applyMatrix4(instance);
   assert(baked.distanceTo(expected)<1e-8,JSON.stringify({local,reflected,turn,expected,baked}));checks++;
  }
 }
 console.log(`${checks} asymmetric affine/reflection vertex comparisons passed`);
}finally{await rm(tmp,{recursive:true,force:true});}
