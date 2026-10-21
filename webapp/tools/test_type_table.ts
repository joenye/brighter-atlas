// The type table and the visual owner header across the 21-Oct-2026 format: the type table lost its 0x00 tag
// and bit 62 of its ids, and owners lost the tag-0x0B op between their cell dims and their box.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-type-table-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export {parseTypes,typesWithId} from './src/extract/datatable.ts'; export {AssetGraph} from './src/extract/world/graph.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'warning'});
 const {parseTypes,typesWithId,AssetGraph}=await import(pathToFileURL(file).href);

 // 1000 types (a real table has over 87k), type 1 holding 998 below it; ids carry bit 62 or not
 const varint=(n:number)=>{const out=[];do{out.push((n&0x7f)|(n>0x7f?0x80:0));n>>>=7;}while(n);return out;};
 const id=(k:number,bit62:boolean)=>[(bit62?0x40:0)|(k>>8&0x3f),k&0xff,1,2,3,4,5,6];
 const table=(tagged:boolean,bit62:boolean)=>{
  const bytes=[...(tagged?[0]:[]),...varint(1000)];
  for(let k=0;k<1000;k++)bytes.push(...varint(k===1?998:0),...id(k,bit62&&k%2===1));
  return new Uint8Array([...bytes,0xee]);
 };
 const tagged=table(true,true),untagged=table(false,false);
 const old=parseTypes(tagged,0),now=parseTypes(untagged,0);
 assert.equal(tagged[old.end],0xee,'the tagged table ends after its last entry');
 assert.equal(untagged[now.end],0xee,'the untagged table ends after its last entry');
 assert.deepEqual([...now.types.ends],[...old.types.ends]);
 assert.equal(now.types.ends[1],999);
 // ids compare without bit 62, whichever side has it
 for(const t of [old.types,now.types]){
  assert.deepEqual(typesWithId(t,'4001010203040506'),[1]);
  assert.deepEqual(typesWithId(t,'0001010203040506'),[1]);
  assert.deepEqual(typesWithId(t,'0002010203040506'),[2]);
  assert.deepEqual(typesWithId(t,'0002010203040507'),[]);
 }
 assert.throws(()=>parseTypes(new Uint8Array([5,0]),0),/type table of 5 entries/);

 // owners: dims at 4/5/6, 0x0B at 7, box at 8 (before), or dims at 5/6/7 and the box at 8 (21-Oct-2026)
 const owner=(dims:number,gap:boolean)=>{
  const m=new Map<number,any>();
  for(let op=1;op<dims;op++)m.set(op,{elements:[{tag:0x0f,value:op}]});
  [1,2,3].forEach((v,i)=>m.set(dims+i,{elements:[{tag:0x0a,value:v}]}));
  if(gap)m.set(dims+3,{elements:[{tag:0x0b,value:[1]}]});
  m.set(dims+(gap?4:3),{elements:[{tag:0x25,value:[-512,-512,0,512,512,512]}]});
  return m;
 };
 const ops=(dims:number,gap:boolean)=>{
  const rows=Array.from({length:12},(_,slot)=>({slot,runtime:1,g:Array.from({length:8},(_,op)=>[op,0,0,0])}));
  const g=new AssetGraph(rows,[]);
  (g as any)._scanFields=()=>owner(dims,gap);
  return (g as any)._ensureStructuralOps();
 };
 assert.deepEqual(ops(4,true),{dimsOps:[4,5,6],boundsOp:8});
 assert.deepEqual(ops(5,false),{dimsOps:[5,6,7],boundsOp:8});
 assert.deepEqual(ops(1,true),{dimsOps:[1,2,3],boundsOp:5});
 console.log('type table: ok');
} finally { await rm(tmp,{recursive:true,force:true}); }
