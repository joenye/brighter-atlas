// Synthetic occurrence masks and alternate terrain appearances.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-face-selection-'));
try {
 const file=path.join(tmp,'graph.mjs');
 await build({entryPoints:[path.resolve(import.meta.dirname,'../src/extract/world/graph.ts')],bundle:true,platform:'node',format:'esm',outfile:file});
 const {AssetGraph}=await import(pathToFileURL(file).href);
 const faces=Array.from({length:8},(_,i)=>({kind:'block_face',mesh:i,material_slot:0,texture:0,face_index:i}));
 const g=new AssetGraph([],[]);g.blockParts=()=>faces;g.staticParts=()=>[];
 const hit=(mask:number|null,rotation=0,reflected=false)=>({resource:0,secondary:null,parentLink:null,cell:[3,5,2],rotationQuarters:rotation,packedFlags:mask===null?null:(mask<<7)|(reflected?4:0)});
 for(let mask=0;mask<256;mask++)for(let rotation=0;rotation<4;rotation++)for(const reflected of [false,true]){
  const expected=faces.filter((_,i)=>mask&(1<<i));
  assert.deepEqual(g.roomPlacements([hit(mask,rotation,reflected)]).map(p=>p.part),expected);
 }
 assert.deepEqual(g.roomPlacements([hit(null)]).map(p=>p.part),faces);
 assert.equal(g.roomPlacements([hit(0)]).length,0);
 // Same-owner cache reuse must preserve different masks in a single batch.
 const occurrences=[hit(1),hit(128),hit(255),hit(0)];
 const placements=g.roomPlacements(occurrences);
 assert.deepEqual(placements.map(p=>[occurrences.indexOf(p.occurrence),p.part.face_index]),[[0,0],[1,7],...faces.map((_,i)=>[2,i])]);
 assert.equal(faces.length,8);assert.equal(g.blockParts(0).length,8);
 const terrain=faces.map(p=>({...p,kind:'terrain_face'}));g.terrainParts=()=>terrain;
 assert.deepEqual(g.roomPlacements([{...hit(4),secondary:1,parentLink:[0,-1,0,0]}]).map(p=>p.part.face_index),[2]);
 const composite=new AssetGraph([],[]),part={kind:'model_part',mesh:9,material_slot:0,texture:0,typed_schema:'mesh_material_colors3_matrix3x4'};
 composite.blockParts=()=>[];composite.staticParts=()=>[part];
 const linked={...hit(256),parentLink:[-1,0,0,0]};
 assert.equal(composite.roomPlacements([linked]).length,1);
 assert.equal(composite.roomPlacements([{...linked,packedFlags:128}]).length,0);
 composite.terrainParts=()=>[{...part,kind:'terrain_model_part'}];
 assert.equal(composite.roomPlacements([{...linked,secondary:1}]).length,1);
 assert.equal(composite.roomPlacements([{...linked,secondary:1,packedFlags:128}]).length,0);
 // An unrelated later mesh/material pair must not collapse a multi-face tile.
 for(const offset of [20,55]){
  const t=new AssetGraph([],[]),meshField={series:false,elements:[{tag:0x26,value:10}]},shape=new Map<number,any>([[offset,meshField],[offset+1,'material']]),ground=new Map([[0,'material']]);
  t.fields=(id)=>id===0?shape:ground;
  t._groundFieldBase=()=>0;t.oneMesh=f=>f===meshField?[10,10]:null;t.oneMaterial=f=>f==='material'?[20,20]:null;
  t._faceBase=()=>3;t.faceParts=()=>terrain;t.modelGroups=()=>[];t.staticParts=()=>[];
  assert.deepEqual(t.terrainParts(0,1),terrain);
  // A true standalone terrain mesh has no multi-face appearance.
  t.faceParts=()=>[];t.groundRecolorData=()=>null;
  const custom=t.terrainParts(0,1);assert.equal(custom.length,1);assert.equal(custom[0].kind,'terrain_custom_mesh');assert.equal(custom[0].mesh,10);
 }
 // On the default ground a block's faces take its own material; any other
 // ground supplies one material per face.
 {
  const g=new AssetGraph([],[],undefined,{defaultGround:7}),mesh={m:1};
  const shape=new Map<number,any>([[37,mesh],[47,'own']]),ground=new Map<number,any>([[7,'ground']]);
  g.fields=(id)=>id===0?shape:ground;g._groundFieldBase=()=>7;g._fallbackRel=()=>10;g.groundRecolorData=()=>null;
  g.oneMesh=f=>f===mesh?[5,5]:null;g.oneMaterial=f=>f==='own'?[47,470]:f==='ground'?[7,70]:null;
  assert.equal(g.faceParts(0,7,'block_face',37)[0].material_slot,47);
  assert.equal(g.faceParts(0,8,'block_face',37)[0].material_slot,7);
 }
 console.log('2,048 face-mask/orientation cases, cache reuse, linked terrain, default ground and alternate appearance guards passed');
} finally {await rm(tmp,{recursive:true,force:true});}
