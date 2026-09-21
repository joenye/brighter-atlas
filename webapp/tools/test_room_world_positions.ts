import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-room-positions-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export {roomWorldPosition} from './src/extract/world/room.ts';export {resolveRoomPositions} from './src/extract/world/stitch.ts';export {WorldScene} from './src/viewers/world/scene.ts';export {Group,Matrix4,Vector3} from './vendor/three.module.js';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const {roomWorldPosition,resolveRoomPositions,WorldScene,Group,Matrix4,Vector3}=await import(pathToFileURL(file).href);
 const origin={kind:'lit',tag:46,index:null,value:[0xffffffed,31]};
 assert.deepEqual(roomWorldPosition([origin],[-19,31]),[-19,31]);
 for(const [top,xy] of [[[],[-19,31]],[[origin,origin],[-19,31]],[[origin],[-18,31]],[[{...origin,index:1}],[-19,31]],[[origin],undefined],[[{...origin,value:[1]}],[1,0]]])assert.equal(roomWorldPosition(top,xy),null);
 const stitched=new Map([[1,[0,0]],[2,[10,0]],[3,[20,0]],[4,[30,0]]]);
 const authored=new Map([[1,[-19,31]],[2,[-9,31]],[3,[2,33]],[9,[90,90]]]);
 const resolved=resolveRoomPositions(stitched,authored);
 assert.deepEqual([...resolved],[[1,[-19,31]],[2,[-9,31]],[3,[2,33]],[4,[11,31]]]);
 assert(!resolved.has(9),'isolated room must not enter the connected layout');
 assert.deepEqual([...resolveRoomPositions(stitched,new Map())],[...stitched]);
 assert.deepEqual([...resolveRoomPositions(stitched,new Map([[9,[90,90]]]))],[...stitched]);
 assert.deepEqual(stitched.get(3),[20,0],'keep the fallback source intact');
 const w=Object.create(WorldScene.prototype);
 Object.assign(w,{categoryVisibility:{},assetConcurrency:1,tileUnits:1024,layerUnits:512,meshForwardQuarterTurns:2,
  _buildCollision:()=>({group:new Group(),mesh:null}),_batchRows:()=>[],
  spawnColumns:{x:0,y:1,z:2,centre_offset:3,surface_z:4,rotation_quarters:5},spawnPartColumns:{spawn:0}});
 for(const [id,xy] of resolved)for(const sceneOrigin of [[0,0],[-40,27],[137,-211]]){
  const shard={map_offset:[4,7],spawns:[[3,5,1,.75,1024,1]]};
  const r=await w._buildRoom({id},shard,{x:xy[0],y:xy[1]},{x:-sceneOrigin[0],y:-sceneOrigin[1]},0,0);
  const actor=w._spawnMatrix(shard,[0],new Matrix4());
  const actual=new Vector3().applyMatrix4(actor).applyMatrix4(r.group.matrix).toArray();
  assert.deepEqual(actual,[(xy[0]-sceneOrigin[0]+3.75)*1024,(xy[1]-sceneOrigin[1]+5.75)*1024,1024]);
 }
 console.log('Authored room coordinates, isolated membership, fallback translation and room/actor composition passed');
}finally{await rm(tmp,{recursive:true,force:true});}
