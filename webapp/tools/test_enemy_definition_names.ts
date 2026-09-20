import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-definition-names-'));
try {
  const file=path.join(tmp,'models.mjs');
  await build({entryPoints:['src/extract/world/models.ts'],bundle:true,platform:'node',format:'esm',outfile:file});
  const {scanEnemyDefinitions}=await import(pathToFileURL(file).href);
  const row=(slot:number,name:string,plural:string,selector=10,runtime=20,fields=[4,17])=>({
    slot,selector,runtime,start:slot,g:[[fields[0],0,14,name],[fields[1],0,14,plural]],r:[],s:[],
  });
  const rows=[row(0,'Rat','Rats'),row(1,'Wasp','Wasps'),row(2,'Mouse','Mice'),
    row(3,'Jellyfish','Jellyfish'),row(4,'Captain Example','Captain Example'),
    row(5,'Missing plural','',10,20),row(6,'Mouse','Mice',11,20),row(7,'Mouse','Mice',10,21)];
  rows[2].r.push([8,3]);
  const defs=scanEnemyDefinitions(rows,[],[]);
  assert.deepEqual(defs.map(d=>[d.slot,d.name,d.plural]),[
    [0,'Rat','Rats'],[1,'Wasp','Wasps'],[2,'Mouse','Mice'],[3,'Jellyfish','Jellyfish'],
    [4,'Captain Example','Captain Example'],
  ]);
  assert.deepEqual(defs[2].targets,[3]);
  assert.deepEqual(scanEnemyDefinitions([row(0,'Rat','Rats'),row(1,'Mouse','Mice')],[],[]).map(d=>d.slot),[0]);
  const conflict=[row(0,'Rat','Rats'),row(1,'Wasp','Wasps',10,20,[5,18]),row(2,'Mouse','Mice')];
  assert.deepEqual(scanEnemyDefinitions(conflict,[],[]).map(d=>d.slot),[0,1]);
  const nested=row(2,'Mouse','Mice');nested.g[1][1]=1;
  assert.deepEqual(scanEnemyDefinitions([rows[0],rows[1],nested],[],[]).map(d=>d.slot),[0,1]);
  const pooled=[{tag:14,values:[0,1,2,3,4]}];
  const poolRow=row(2,'Mouse','Mice');poolRow.g[0]=[4,0,0,0];
  assert.equal(scanEnemyDefinitions([rows[0],rows[1],poolRow],pooled,['M','o','u','s','e'])[2].name,'Mouse');
  console.log('Definition names retain irregular plurals and proper names only with multiple agreeing same-type field bindings; missing, nested, conflicting and unrelated fields remain unresolved');
}finally{await rm(tmp,{recursive:true,force:true});}
