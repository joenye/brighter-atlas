// Object descriptors add display context after catalogue identity/grouping has
// finished. Names never change geometry, composition, ids or variant order.
import {EXACT_RULES,type SystemCatalog} from './catalog.js';
import type {ObjectDescription} from './object-descriptors.js';
import type {MeshNamesDoc} from './mesh-names.js';

type Describe=(owner:number)=>ObjectDescription;
interface ObjectLabel {owner:number;field:number;name:string;qualifier:string|null;label:string}
const strongNames=new Set(['entity_family','entity_family_variant','direct_family_string']);
const unique=(values:string[])=>[...new Set(values)].sort((a,b)=>a.localeCompare(b));
const qualified=(name:string,qualifier:string|null)=>qualifier?`${name} (${qualifier})`:name;
function labelsFor(owners:Iterable<number>,describe:Describe):ObjectLabel[] {
  const labels:ObjectLabel[]=[];
  for(const owner of new Set(owners)) {
    if(!Number.isInteger(owner)||owner<0)continue;
    const d=describe(owner),primary=d.descriptors[0];if(!primary)continue;
    labels.push({owner,field:primary.field,name:primary.name,qualifier:primary.qualifier,label:qualified(primary.name,primary.qualifier)});
  }
  return labels.sort((a,b)=>a.owner-b.owner||a.field-b.field);
}
const strong=(sources:any[])=>sources.some(s=>s.entity_family_owner_slot!=null||strongNames.has(s.source_name_provenance?.kind));
function addAliases(target:any,labels:string[]) {
  const aliases=unique([...(target.aliases??[]),...labels]).filter(s=>s!==target.name);
  if(aliases.length)target.aliases=aliases;
}

export function annotateObjectCatalog(catalog:SystemCatalog,describe:Describe) {
  let modelsNamed=0,variantsNamed=0,textureVariantsNamed=0;
  for(const model of catalog.models) {
    const labels=labelsFor(model.sources.map((s:any)=>s.owner_slot),describe);
    if(labels.length) {
      model.object_labels=labels;const names=unique(labels.map(l=>l.name));
      if(names.length===1&&!model.spawn_label&&!model.enemy_base&&!strong(model.sources)) {
        const previous=model.name;model.name=names[0];
        if(previous!==model.name){modelsNamed++;if(previous&&!/^Recovered model /.test(previous))addAliases(model,[previous]);}
      }
      addAliases(model,labels.map(l=>l.label));
    }
    for(const variant of model.variants??[]) {
      const labels=labelsFor(variant.sources.map((s:any)=>s.owner_slot),describe);if(!labels.length)continue;
      variant.object_labels=labels;
      const names=unique(labels.map(l=>l.label));
      if(names.length===1&&!strong(variant.sources)) {
        const previous=variant.name;variant.name=names[0];
        if(previous!==variant.name){variantsNamed++;if(previous&&previous!=='Variant')addAliases(variant,[previous]);}
      }
      addAliases(variant,names);
    }
    // Several authored compositions can share a label. Keep every composition
    // and its stable id; do not invent an active/depleted state from its shape.
    const groups=new Map<string,any[]>();
    for(const v of model.variants??[])if(v.object_labels?.length){const list=groups.get(v.name)??[];list.push(v);groups.set(v.name,list);}
    for(const [name,list] of groups)if(list.length>1) {
      const counts=new Set(list.map(v=>v.parts.length));
      [...list].sort((a,b)=>a.id.localeCompare(b.id)).forEach((v,i)=>{
        v.name=counts.size===list.length?`${name} (${v.parts.length} parts)`:`${name} #${i+1}`;
      });
    }
  }
  const ownerColumn=catalog.bindings.columns.indexOf('owner_slot'),ruleColumn=catalog.bindings.columns.indexOf('rule');
  if(ownerColumn<0||ruleColumn<0)throw Error('object naming needs catalogue binding columns');
  for(const system of catalog.mesh_system.values())for(const variant of system.variants) {
    const owners=variant.bindings.flatMap((index:number)=>{
      const row=catalog.bindings.rows[index];return row&&EXACT_RULES.has(catalog.bindings.rules[row[ruleColumn]])?[row[ownerColumn]]:[];
    });
    const labels=labelsFor(owners,describe);if(!labels.length)continue;
    variant.object_labels=labels;variant.names=unique(labels.map(l=>l.label));
    if(variant.names.length===1){variant.name=variant.names[0];textureVariantsNamed++;}
  }
  catalog.models.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  Object.assign(catalog.counts,{object_named_models:modelsNamed,object_named_variants:variantsNamed,object_named_texture_variants:textureVariantsNamed});
  return {modelsNamed,variantsNamed,textureVariantsNamed};
}

export function appendObjectMeshNames(doc:MeshNamesDoc,meshOwners:Iterable<[number,number]>,describe:Describe) {
  const ownersByMesh=new Map<number,Set<number>>();
  for(const [mesh,owner] of meshOwners) {
    const owners=ownersByMesh.get(mesh)??new Set<number>();owners.add(owner);ownersByMesh.set(mesh,owners);
  }
  for(const [mesh,owners] of ownersByMesh) {
    const labels=labelsFor(owners,describe);if(!labels.length)continue;
    const entry=doc.meshes[String(mesh)]??={names:[],sources:[]};
    // Existing item names keep their order and equipment-slot semantics.
    for(const label of labels) {
      if(!entry.names.includes(label.label))entry.names.push(label.label);
      entry.sources.push({kind:'object_descriptor',name:label.label,def_row:label.owner,owner:label.owner,hops:0,
        variants:unique(describe(label.owner).descriptors.map(d=>qualified(d.name,d.qualifier)))});
    }
  }
  doc.meshes_named=Object.keys(doc.meshes).length;
  doc.names_attached=new Set(Object.values(doc.meshes).flatMap(m=>m.names)).size;
}
