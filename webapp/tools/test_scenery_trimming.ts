// Archived trim flags select draw appearances without erasing source records.
import assert from 'node:assert/strict';
import{mkdtemp,rm}from'node:fs/promises';import os from'node:os';import path from'node:path';import{pathToFileURL}from'node:url';import{build}from'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-scenery-trim-'));
try{
 const file=path.join(tmp,'test.mjs');await build({stdin:{contents:"export {AssetGraph} from './src/extract/world/graph.ts'; export {occurrenceRows,OCCURRENCE_COLUMNS} from './src/extract/world/shards.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const{AssetGraph,occurrenceRows,OCCURRENCE_COLUMNS}=await import(pathToFileURL(file).href);
 const chunks:number[]=[],rows:any[]=[];
 const add=(bytes:number[],selector:number)=>{const start=chunks.length;chunks.push(...bytes);rows.push({slot:rows.length,selector,runtime:0,start,end:chunks.length,g:[],v:[],r:[],s:[],m:[]});};
 const int=(n:number)=>[0x0a,0,0,0,n],ref=(n:number)=>[0x26,n],sym=(n:number)=>[0x0f,n];
 // Source dimensions 1x1, replacement dimensions 3x2. Source condition is
 // enabled, replacement's own condition says remove: substitution is once.
 add([0,...ref(2),...sym(1),...ref(1),...int(1),...int(1),...int(1)],0);
 add([0,...ref(2),...sym(1),...sym(0),...int(3),...int(2),...int(1)],0);
 add([0,...sym(1),1],1);
 const profile={class_fields:{},tag6_fields:{},selectors:{0:{fill:['U','G','G','G','G','G','G']},1:{fill:['U','G','F1']}}};
 const make=()=>{const g=new AssetGraph(rows,[],undefined,{bytes:new Uint8Array(chunks),profile,symbols:['$remove','$dont_trim']});g._structuralOps={dimsOps:[4,5,6],boundsOp:8};return g;};
 const g=make(),source={record:50,resource:0,secondary:7,cell:[4,6,2],entrySlot:0,packed:123,packedFlags:4|8|32,rotationQuarters:1,individual:null,parentLink:null,childLinks:[]},saved=structuredClone(source);
 const draw=g.drawOccurrence(source);assert.equal(draw.resource,1);assert.equal(draw.secondary,null);assert.equal(draw.packedFlags,4|(511<<7));assert.equal(g.drawOccurrence(draw),draw);assert.deepEqual(source,saved);
 assert.deepEqual(g.occurrenceAnchor(source).slice(0,2),[5,7.5]);
 const ctx={graph:g};const[out]=occurrenceRows(ctx,[source]);const cols=Object.fromEntries(OCCURRENCE_COLUMNS.map((k:string,i:number)=>[k,i]));
 assert.equal(out[0][cols.resource],0);assert.equal(out[0][cols.appearance_resource],1);assert.equal(out[0][cols.packed_flags],saved.packedFlags);assert.equal(out[0][cols.appearance_packed_flags],draw.packedFlags);
 assert.equal(out[0][cols.anchor_x],5);assert.equal(out[0][cols.anchor_y],7.5);
 const part={kind:'model_part',mesh:10,material_slot:20,texture:30,typed_schema:'mesh_material_colors3_matrix3x4'};
 g.blockParts=()=>[];g.staticParts=(id:number)=>{assert.equal(id,1);return[part];};
 const placements=g.roomPlacements([source]);assert.equal(placements.length,1);assert.equal(placements[0].occurrence,source);assert.equal(placements[0].drawOccurrence.resource,1);
 // Independent source occurrence of the replacement owner IS removed.
 const removed={...source,resource:1};assert.equal(g.drawOccurrence(removed),null);assert.deepEqual(g.roomPlacements([removed]),[]);
 const untouched=make();chunks[chunks.length-1]=0;const inactive=make();assert.equal(inactive.drawOccurrence(source),source);
 // Disabled configuration and unknown prefixes preserve source rendering.
 const unknown=make(),decode=unknown._decode;unknown._decode=(id:number)=>id===2?[{kind:'G'},{kind:'U'},{kind:'F',raw:new Uint8Array([1])}]:decode(id);assert.equal(unknown.drawOccurrence(source),source);
 assert.equal(untouched.drawOccurrence(removed),null);
 console.log('Native trim flag, removal, one-step replacement, source provenance, masks and replacement bounds passed');
}finally{await rm(tmp,{recursive:true,force:true});}
