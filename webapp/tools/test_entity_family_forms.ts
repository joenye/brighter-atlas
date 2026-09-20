import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-family-forms-'));
try {
  const file=path.join(tmp,'models.mjs');
  await build({entryPoints:['src/extract/world/models.ts'],bundle:true,platform:'node',format:'esm',outfile:file});
  const {extractEntityVariantRecords,PoolStrings}=await import(pathToFileURL(file).href);
  const fixture=(pooled:boolean,forward:boolean)=>{
    const pool:any[]=[];
    const put=(v:any)=>{pool.push(v);return pool.length-1;};
    const ref=(value:number)=>put({tag:38,value});
    const a=ref(1),b=ref(2),meshA=ref(7),meshB=ref(8);
    const matA=put({tag:2,value:9}),matB=put({tag:2,value:10});
    const list=(...ids:number[])=>put({tag:32,values:ids.map(value=>({tag:0,value}))});
    const meshes=[list(meshA),list(meshB)],materials=[list(matA),list(matB)];
    const familyList=list(a,b);
    const rows:any[]=Array.from({length:11},(_,slot)=>({slot,selector:slot,runtime:slot,start:slot,g:[],v:[],r:[],s:[]}));
    rows[0].g=[[1,0,14,'Creature'],...(pooled?[[3,0,0,familyList]]:[[3,1,0,a],[3,1,0,b]])];
    for(let i=0;i<2;i++){
      Object.assign(rows[i+1],{selector:20,runtime:30,g:[[1,0,14,i?'large_creature':'small_creature'],[2,0,14,i?'Large':'Small'],[6,1,38,i+3]]});
      if(forward?i===0:i===1)rows[i+1].g.push([5,0,0,forward?b:a]);
      Object.assign(rows[i+3],{selector:40,runtime:50,g:[[20,0,0,meshes[i]],[21,0,0,materials[i]]],v:[[0,'U',-1],[23,'U',i]]});
    }
    const run=()=>extractEntityVariantRecords(rows,pool,new Map([[7,100],[8,101]]),new Map([[9,[200]],[10,[201]]]),new PoolStrings(pool,[]));
    return {run,rows,pool,a,b,familyList};
  };
  const bare=fixture(false,true).run(),pooled=fixture(true,true).run();
  assert.equal(pooled.length,2);assert.deepEqual(pooled,bare);
  assert.deepEqual(pooled.map(r=>[r.source_name,r.entity_variant_index,r.ab5_mesh,r.ab3_textures]),[
    ['Small Creature',0,100,[200]],['Large Creature',1,101,[201]],
  ]);
  assert.deepEqual(pooled.map(r=>r.entity_successor_owner_slot),[2,null]);
  assert(pooled.every(r=>r.entity_successor_field_op===5&&r.entity_predecessor_field_op===undefined&&!r.material_inherited));
  const previous=fixture(true,false);previous.rows[4].g.pop();
  const inherited=previous.run();assert.equal(inherited.length,2);assert(inherited[1].material_inherited);
  assert.deepEqual(inherited.map(r=>r.entity_predecessor_owner_slot),[null,1]);
  const missing=fixture(true,true);missing.rows[4].g.pop();assert.deepEqual(missing.run(),[]);
  const cycle=fixture(true,true);cycle.rows[2].g.push([5,0,0,cycle.a]);assert.deepEqual(cycle.run(),[]);
  const wrongIndex=fixture(true,true);wrongIndex.rows[4].v[1][2]=0;assert.deepEqual(wrongIndex.run(),[]);
  const nested=fixture(true,true);nested.pool[nested.familyList]={tag:36,fields:nested.pool[nested.familyList].values};assert.deepEqual(nested.run(),[]);
  console.log('Family lists preserve ordered variants in bare and pooled forms; forward links retain source provenance and require explicit materials, while cycles, wrong indices and arbitrary containers are rejected');
}finally{await rm(tmp,{recursive:true,force:true});}
