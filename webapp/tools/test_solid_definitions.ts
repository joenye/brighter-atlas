// Mesh definitions that carry a tall solid object's height slices are solid geometry; editor markers' are not.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-solid-definitions-'));
try {
 const file=path.join(tmp,'graph.mjs');
 await build({entryPoints:[path.resolve(import.meta.dirname,'../src/extract/world/graph.ts')],bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'error'});
 const {AssetGraph}=await import(pathToFileURL(file).href);
 const box=(z:number)=>({tag:0x25,value:[-100,-100,z,100,100,z+350]});
 // a definition: its envelope, radius and matrix, then the slices (boxes) and their radii; no fixed field positions
 const definition=(slices:number)=>({tag:0x24,class:572,fields:[box(0),{tag:0x0b,value:[500]},{tag:0x30,value:[1,0,0,0,0,1,0,0,0,0,1,0]},
  {tag:0x20,values:Array.from({length:slices},(_,k)=>box(k*350))},{tag:0x20,values:Array.from({length:slices},()=>({tag:0x0b,value:[200]}))}]});
 const profile={class_fields:{},tag6_fields:{},selectors:{0:{fill:['G']}}};
 const graphOf=(node:any)=>new AssetGraph([{slot:0,selector:0,runtime:0,start:0,end:2,g:[[0,0,0,0]],v:[],r:[],s:[],m:[]}],[node],
  {meshBySlot:new Map(),texturesByMaterial:new Map()},{bytes:new Uint8Array([0,0]),profile});
 assert.equal(graphOf(definition(10)).meshDefinitionSolid(0),true,'a crystal ten slices tall');
 assert.equal(graphOf(definition(0)).meshDefinitionSolid(0),false,'a marker: no slices');
 // a list of something other than boxes is not slices
 const other=definition(0);other.fields[3]={tag:0x20,values:[{tag:0x0b,value:[1]}]};
 assert.equal(graphOf(other).meshDefinitionSolid(0),false);
 // without the record's source data nothing is solid
 assert.equal(new AssetGraph([],[]).meshDefinitionSolid(0),false);
 console.log('Mesh definitions: sliced solids and editor markers told apart');
} finally {await rm(tmp,{recursive:true,force:true});}
