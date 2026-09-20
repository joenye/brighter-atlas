import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-descriptors-'));
try {
  const file=path.join(tmp,'reader.mjs');
  await build({entryPoints:['src/extract/world/object-descriptors.ts'],bundle:true,platform:'node',format:'esm',outfile:file});
  const {objectDescriptionReader}=await import(pathToFileURL(file).href);
  const uint=(v:number)=>{const out=[];do{const n=v%128;v=Math.floor(v/128);out.push(n|(v?128:0));}while(v);return out;};
  const int=(v:number)=>{const b=new Uint8Array(4);new DataView(b.buffer).setInt32(0,v);return [10,...b];};
  const scalar=(v:number)=>{const b=new Uint8Array(4);new DataView(b.buffer).setFloat32(0,v);return [11,...b];};
  const ref=(tag:number,v:number)=>[tag,...uint(v)],nil=ref(15,9);
  const charset=Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz é🪵');
  const text=(value:string)=>[14,...uint(Array.from(value).length),...Array.from(value,ch=>charset.indexOf(ch))];
  const typed=(nodes:number[][])=>[36,...uint(91),...nodes.flat()];
  const descriptor=(name:string,qualifier:string|null,glyph:number[])=>typed([text(name),qualifier===null?nil:text(qualifier),glyph,ref(38,0),[13]]);
  const data:number[]=[],rows:any[]=[],selectors:any={};
  const add=(values:number[][])=>{
    const slot=rows.length,start=data.length,selector=500+slot;
    data.push(...uint(slot),...values.flat());selectors[selector]={runtime:selector,ctor_varints:0,fill:['U',...values.map(()=> 'G')]};
    rows.push({slot,selector,runtime:selector,start,end:data.length,g:[],r:[],s:[],m:[],v:[]});return slot;
  };
  const glyph=charset.indexOf('🪵');
  const skill=add([text('Gatherer'),scalar(1),ref(115,glyph),ref(115,glyph)]);
  const object=add([nil,[12],int(2),int(1),int(0),scalar(1),nil,
    descriptor('Élder Log'.replace('É','é'),'Rare',ref(38,skill)),nil,descriptor('Log',null,ref(115,glyph))]);
  const shifted=add([nil,nil,nil,int(1),int(3),int(2),scalar(1),nil,descriptor('Moss',null,ref(115,glyph))]);
  const conflicting=add([text('Ambiguous'),ref(115,glyph),ref(115,0)]);
  const unknown=add([descriptor('Unknown',null,ref(38,conflicting))]);
  const unrelated=add([typed([text('Not a descriptor'),int(2),ref(115,glyph),ref(38,0),[13]])]);
  const ambiguousSize=add([int(2),int(1),int(0),scalar(1),nil,int(3),int(2),int(0),scalar(1),nil]);
  const profile:any={selectors,class_fields:{91:5},tag6_fields:{},stream:{object_count:rows.length,constructor_end:0}};
  const read=objectDescriptionReader(rows,[],Uint8Array.from(data),profile,charset);
  const result=read(object);
  assert.equal(result.name,'élder Log');assert.equal(result.qualifier,'Rare');assert.equal(result.category,'Gatherer');
  assert.equal(result.glyph,glyph);assert.deepEqual(result.dimensions,[2,1]);
  assert.deepEqual(result.descriptors.map(d=>d.field),[8,10]);assert.equal(result.descriptors[1].name,'Log');
  assert.equal(read(shifted).name,'Moss');assert.deepEqual(read(shifted).dimensions,[1,3]);
  assert.equal(read(unknown).glyph,null);assert.equal(read(unknown).category,'Unresolved icon');
  assert.equal(read(unrelated).name,null);assert.deepEqual(read(unrelated).descriptors,[]);
  assert.equal(read(ambiguousSize).dimensions,null);
  assert.equal(read(object),result);
  console.log('Object descriptors preserve names, qualifiers, alternate fields, Unicode icons and shifted dimension headers; ambiguous values stay unresolved');
} finally {await rm(tmp,{recursive:true,force:true});}
