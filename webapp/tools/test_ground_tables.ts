// Ground records found by their layout: eight materials, the varied pair and eight face triples, and the same
// layout with two more colours after it (a block's own material table, as giant crystals carry).
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-ground-tables-'));
try {
 const file=path.join(tmp,'graph.mjs');
 await build({entryPoints:[path.resolve(import.meta.dirname,'../src/extract/world/graph.ts')],bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'error'});
 const {AssetGraph}=await import(pathToFileURL(file).href);
 // a record's fields: materials at base..base+7, colours from base+8 to base+33 (and two more when `extra`)
 const record=(base:number,extra:boolean,lead=0)=>{
  const fields=new Map<number,any>();
  for(let op=1;op<=lead;op++)fields.set(op,'symbol');
  for(let k=0;k<8;k++)fields.set(base+k,{material:100+k});
  for(let op=base+8;op<=base+(extra?35:33);op++)fields.set(op,{colour:op});
  return fields;
 };
 const graphOf=(fields:Map<number,any>)=>{
  const g=new AssetGraph([],[]);
  g.rows=[{}];g.fields=()=>fields;
  g.oneMaterial=(f:any)=>f?.material!==undefined?[f.material,f.material]:null;
  g.color4f=(f:any)=>f?.colour!==undefined?[1,1,1,1]:null;
  return g;
 };
 assert.equal(graphOf(record(7,false,6))._groundFieldBase(0),7,'a ground');
 assert.equal(graphOf(record(7,true,6))._groundFieldBase(0),7,'a material table with two colours after the faces');
 assert.equal(graphOf(record(3,true))._groundFieldBase(0),3);
 // three colours after the faces is no layout this rule knows
 const three=record(7,true,6);three.set(43,{colour:43});
 assert.equal(graphOf(three)._groundFieldBase(0),null,'unknown tail');
 // materials elsewhere: not a ground
 const loose=record(7,true,6);for(let k=0;k<8;k++)loose.delete(7+k);loose.set(1,{material:1});loose.set(2,{material:2});
 assert.equal(graphOf(loose)._groundFieldBase(0),null,'materials outside the layout');
 console.log('Ground layouts: plain grounds and material tables with two trailing colours');
} finally {await rm(tmp,{recursive:true,force:true});}
