// Synthetic asymmetric owners exercise all packed alignment modes and turns.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-owner-alignment-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/graph.ts'; export {WorldScene} from './src/viewers/world/scene.ts'; export {MergedWorld} from './src/viewers/world/merged.ts'; export {Matrix4,BufferGeometry,Float32BufferAttribute} from './vendor/three.module.js';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const {AssetGraph,nativeAxisAlignment,WorldScene,MergedWorld,Matrix4,BufferGeometry,Float32BufferAttribute}=await import(pathToFileURL(file).href);
 const expected=[[0,-100,724,-924],[0,-100,724,-924],[0,-100,-200,-200],[0,0,512,-512],[0,0,0,-512],[0,0,512,0]];
 for(let mode=0;mode<6;mode++)for(let selector=0;selector<4;selector++)assert.equal(nativeAxisAlignment(mode,selector,2,-100,300,1024)||0,expected[mode][selector]);
 const g=new AssetGraph([],[]);g.dimensions3i=()=>[2,3,1];g.bounds3f=()=>[-100,-200,0,300,800,512];g.ownerAnchorEnums=()=>[1,1];
 // Both centre selectors yield local (-100,-300). Rotate it with the mesh,
 // including its half-turn, after reflecting local X when requested.
 const offsets=[[100,300],[-300,100],[-100,-300],[300,-100]];
 const reflected=[[-100,300],[-300,-100],[100,-300],[300,100]];
 for(let turn=0;turn<4;turn++)for(const reflection of [false,true]){
  const [x,y]=g.occurrenceAnchor({resource:0,cell:[4,7,2],secondary:null,parentLink:null,rotationQuarters:turn,packedFlags:turn|(reflection?4:0)|8|32});
  const [dx,dy]=(reflection?reflected:offsets)[turn];
  assert.equal(x,4+(turn&1?1.5:1)+dx/1024);assert.equal(y,7+(turn&1?1:1.5)+dy/1024);
 }
 // Multiple objects at the same cell must not move authored geometry.
 const w=Object.create(WorldScene.prototype);
 Object.assign(w,{occurrenceColumns:{x:0,y:1,z:2,rotation_quarters:3,packed_flags:4},placementColumns:{occurrence:0,matrix:1},tileUnits:1024,layerUnits:512,meshForwardQuarterTurns:2});
 const shard={occurrences:[[4,7,2,0,0],[4,7,2,0,0]],placements:{terrain:[[0,-1],[1,-1]]}};
 w._placementAnchor=()=>({center:[4.5,7.5]});
 assert.equal(w._coplanarRank(shard,1),1);
 const a=w._placementMatrix(shard,[0,-1],new Matrix4()),b=w._placementMatrix(shard,[1,-1],new Matrix4());
 assert.deepEqual(a.elements,b.elements);assert.equal(b.elements[14],1024);
 // The ordering survives both instanced materials and merged buckets, but
 // does not alter vertex positions or shadow materials.
 Object.assign(w,{flags:{},_materialPromises:new Map(),disposed:false});
 const m0=await w._material('terrain',0,-1,0,null,0),m1=await w._material('terrain',0,-1,0,null,1);
 assert.notEqual(m0,m1);assert.equal(m0.polygonOffset,false);assert.equal(m1.polygonOffset,true);assert.equal(m1.polygonOffsetFactor,0);assert.equal(m1.polygonOffsetUnits,1);
 const merged=Object.create(MergedWorld.prototype);
 Object.assign(merged,{world:w,waterRegistry:{isWater:()=>false},_zBias:0,_materialCache:new Map()});
 const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
 const exact={category:'terrain',renderTexture:-1,flags:0,z:2};
 const c0=merged.classifyBucket({...exact,depthRank:0},geometry),c1=merged.classifyBucket({...exact,depthRank:1},geometry);
 assert.notEqual(merged.bucketKeyFor(0,0,c0),merged.bucketKeyFor(0,0,c1));
 merged._applyMergedProgram=()=>{};
 const mm=merged._authoredMaterial(c1,null,null);assert.equal(mm.polygonOffsetUnits,1);assert.equal(mm.polygonOffsetFactor,0);
 console.log('Owner selectors, rotated/reflected offsets, unchanged geometry and instanced/merged depth ordering passed');
} finally {await rm(tmp,{recursive:true,force:true});}
