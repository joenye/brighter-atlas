import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-object-names-'));
try {
  const file=path.join(tmp,'names.mjs');
  await build({entryPoints:['src/extract/world/object-names.ts'],bundle:true,platform:'node',format:'esm',outfile:file});
  const {annotateObjectCatalog,appendObjectMeshNames}=await import(pathToFileURL(file).href);
  const descriptions=new Map([
    [1,{name:'Dye vessel',qualifier:'Blue'}],[2,{name:'Dye vessel',qualifier:'Red'}],
    [3,{name:'Bank clerk',qualifier:null}],[4,{name:'Oak log',qualifier:null}],[5,{name:'Ash log',qualifier:null}],
  ]);
  const describe=(owner:number)=>{const d=descriptions.get(owner);return {id:owner,descriptors:d?[{field:30,...d}]:[]};};
  const variant=(id:string,owner:number)=>({id,name:'Variant',parts:[{mesh:owner,image:10}],sources:[{owner_slot:owner}]});
  const model={id:'sys-keep',name:'Recovered model 1',parts:[{mesh:1}],sources:[{owner_slot:1},{owner_slot:2}],
    variants:[variant('var-z',1),variant('var-a',2)]};
  const named={id:'sys-captain',name:'Captain',spawn_label:{label:'Captain'},parts:[{mesh:3}],sources:[{owner_slot:3}],variants:[variant('var-c',3)]};
  const ambiguous={id:'sys-shared',name:'Recovered model 4',parts:[{mesh:4}],sources:[{owner_slot:4},{owner_slot:5}],variants:[]};
  const strong={id:'sys-authored',name:'Authored creature',parts:[{mesh:4}],sources:[{owner_slot:4,source_name_provenance:{kind:'entity_family'}}],variants:[]};
  const catalog={models:[model,named,ambiguous,strong],mesh_system:new Map([[1,{active:1,variants:[{image:10,bindings:[0]},{image:11,bindings:[1]}]}]]),
    bindings:{columns:['owner_slot','rule'],rules:['typed_meshmat','repeated_interleaved'],rows:[[1,0],[2,1]]},counts:{}};
  const identity=()=>JSON.stringify(catalog.models.map(m=>({id:m.id,parts:m.parts,variants:m.variants.map(v=>({id:v.id,parts:v.parts}))})).sort((a,b)=>a.id.localeCompare(b.id)));
  const before=identity();
  const counts=annotateObjectCatalog(catalog,describe);
  assert.equal(identity(),before);assert.equal(model.name,'Dye vessel');
  assert.deepEqual(model.variants.map(v=>v.id),['var-z','var-a']);
  assert.deepEqual(model.variants.map(v=>v.name),['Dye vessel (Blue)','Dye vessel (Red)']);
  assert.equal(named.name,'Captain');assert.equal(strong.name,'Authored creature');
  assert.equal(ambiguous.name,'Recovered model 4');assert.deepEqual((ambiguous as any).aliases,['Ash log','Oak log']);
  assert.equal((catalog.mesh_system.get(1)!.variants[0] as any).name,'Dye vessel (Blue)');
  assert.equal((catalog.mesh_system.get(1)!.variants[1] as any).name,undefined);
  assert.equal(catalog.mesh_system.get(1)!.active,1);assert.equal(counts.modelsNamed,1);
  const meshes:any={meshes:{1:{names:['Wearable name'],slot:'head',sources:[]}},meshes_named:1,names_attached:1};
  appendObjectMeshNames(meshes,[[1,1],[1,1],[2,4],[2,5]],describe);
  assert.deepEqual(meshes.meshes[1].names,['Wearable name','Dye vessel (Blue)']);
  assert.equal(meshes.meshes[1].slot,'head');assert.equal(meshes.meshes[2].slot,undefined);
  assert.equal(meshes.meshes[1].sources.length,1);assert.equal(meshes.meshes[1].sources[0].kind,'object_descriptor');
  assert.equal(meshes.meshes_named,2);assert.equal(meshes.names_attached,4);
  console.log('Object names preserve model/variant ids, order, composition, strong authored labels, equipment slots and texture selections; ambiguous names remain aliases and inferred material pairings receive no state label');
}finally{await rm(tmp,{recursive:true,force:true});}
