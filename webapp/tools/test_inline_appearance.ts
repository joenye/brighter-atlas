// Full source values retain inline component arrays and affine matrices.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-inline-appearance-'));
try {
 const file=path.join(tmp,'graph.mjs');
 await build({entryPoints:[path.resolve(import.meta.dirname,'../src/extract/world/graph.ts')],bundle:true,platform:'node',format:'esm',outfile:file});
 const {AssetGraph}=await import(pathToFileURL(file).href);
 const matrix=[0,-1,0,123,1,0,0,-45,0,0,1,67];
 const component={tag:0x24,class:7,fields:[{tag:0x26,value:10},{tag:2,value:20},...[0,1,2].map(()=>({tag:0x15,value:[1,1,1,1]})),{tag:0x30,value:matrix}]};
 const maps={meshBySlot:new Map([[10,100]]),texturesByMaterial:new Map([[20,[200]]])};
 const floats=(xs:number[])=>{const b=new Uint8Array(xs.length*4),v=new DataView(b.buffer);xs.forEach((x,i)=>v.setFloat32(i*4,x,false));return [...b];};
 // Array: one pooled component, then one fully inline component, whose local
 // matrix differs. No absolute owner field positions or class ids are assumed.
 const local=matrix.map((x,i)=>i===3?456:x);
 const bytes=new Uint8Array([0x20,2,0,0,0x24,7,0x26,10,2,20,...[0,1,2].flatMap(()=>[0x15,...floats([1,1,1,1])]),0x30,...floats(local)]);
 const row={slot:0,selector:0,runtime:0,start:0,end:bytes.length,g:[[0,1,0,0],[0,2,0x26,10],[0,1,0x24,7]],v:[],r:[],s:[],m:[]};
 const profile={class_fields:{7:6},tag6_fields:{},selectors:{0:{fill:['G']}}};
 const g=new AssetGraph([row],[component],maps,{bytes,profile});
 assert.equal(g.fields(0).get(0).elements.length,2);
 const parts=g.modelGroups(0).find(x=>x.mesh_op===0).parts;
 assert.equal(parts.length,2);assert.deepEqual(parts.map(p=>p.series_index),[0,1]);
 assert.deepEqual(parts[0].local_matrix_game,matrix);assert.deepEqual(parts[1].local_matrix_game,local);
 assert.deepEqual(parts[1].recolors[2],[0.5,0.5,0.5,1]);
 // A known block component slot wins over a later alternate group. An empty
 // primary array stays empty, even when another appearance contains parts.
 const block=new AssetGraph([],[]);block._blockLayout=()=>[21,9];
 block.modelGroups=()=>[{mesh_op:29,material_op:29,parts},{mesh_op:60,material_op:60,parts:[{mesh:999}]}];
 assert.deepEqual(block.staticParts(0),parts);
 block.modelGroups=()=>[{mesh_op:60,material_op:60,parts:[{mesh:999}]}];
 assert.deepEqual(block.staticParts(0),[]);
 // Bounds may also be inline. Both encodings must produce the same packed
 // alignment, including asymmetric bounds and reflected quarter turns.
 const bounds=[-100,-200,0,300,800,512];
 const boundsBytes=new Uint8Array([0x25,...floats(bounds)]);
 const boundsRow={...row,end:boundsBytes.length,g:[]};
 const oneFieldProfile={class_fields:{},tag6_fields:{},selectors:{0:{fill:['G']}}};
 const inlineBounds=new AssetGraph([boundsRow],[],maps,{bytes:boundsBytes,profile:oneFieldProfile});
 const pooledBounds=new AssetGraph([{...boundsRow,end:2,g:[[0,0,0,0]]}],[{tag:0x25,value:bounds}],maps,{bytes:new Uint8Array([0,0]),profile:oneFieldProfile});
 for(const owner of [inlineBounds,pooledBounds]) {
  owner._structuralOps={dimsOps:[1,2,3],boundsOp:0};
  owner.dimensions3i=()=>[2,3,1];owner.ownerAnchorEnums=()=>[1,1];
  assert.deepEqual(owner.bounds3f(0),bounds);
 }
 for(let turn=0;turn<4;turn++)for(let flags=0;flags<128;flags+=4){
  const hit={resource:0,cell:[4,7,2],secondary:null,parentLink:null,rotationQuarters:turn,packedFlags:flags|turn};
  assert.deepEqual(inlineBounds.occurrenceAnchor(hit),pooledBounds.occurrenceAnchor(hit));
 }
 console.log('Mixed pooled/inline components and bounds, affine retention and primary block appearance selection passed');
} finally {await rm(tmp,{recursive:true,force:true});}
