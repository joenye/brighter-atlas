// Synthetic structured room headers, independent of shipped game content.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-room-metadata-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/room-metadata.ts'; export * from './src/list-filters.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const {deriveRoomMetadata,episodeFilters,matchesFilters}=await import(pathToFileURL(file).href);
 const charset=['?','N','o','r','t','h','\n','H','a','l','é','S','u','D','e','s','c','i','p','n'];
 const uint=(v:number):number[]=>{const result=[];do{const b=v%128;v=Math.floor(v/128);result.push(b|(v?128:0));}while(v);return result;};
 const text=(s:string)=>[14,...uint(s.length),...Array.from(s).flatMap(c=>{const i=charset.indexOf(c);assert(i>=0,c);return uint(i);})];
 const integer=(n:number)=>[10,...Array.from(new Uint8Array(new Int32Array([n]).buffer)).reverse()];
 const pair=(x:number,y:number)=>[46,...integer(x).slice(1),...integer(y).slice(1)];
 const bytes:number[]=[],rows:any[]=[],selectors:any={};
 const add=(generic:number[][],room:number|null=null)=>{
  const slot=rows.length,start=bytes.length;bytes.push(...uint(slot));for(const g of generic)bytes.push(...g);
  selectors[slot]={runtime:slot,ctor_varints:0,fill:['U',...generic.map(()=> 'G')]};
  const op=room===null?null:generic.findIndex(g=>g[0]===19)+1;
  rows.push({slot,selector:slot,runtime:slot,start,end:bytes.length,g:room===null?[]:[[op,0,19,room]],r:[],s:[],m:[],v:[]});
  return slot;
 };
 const north=add([text('North'),[2,0],text('Description')]);
 const south=add([text('South'),[2,0],text('Description')]);
 const header=(ep:number,room:number,title:string,padding=0)=>[
  ...Array.from({length:padding},()=>[13]),[38,...uint(ep)],text(title),[12],
  [19,...uint(room)],pair(-15,-32),integer(11),integer(9),
 ];
 add(header(north,77,'North\nHallé',3),77);
 add(header(south,78,'North\nHallé',7),78); // same title is not the identity
 const profile:any={selectors,class_fields:{},tag6_fields:{}};
 const actual=deriveRoomMetadata(rows,[],Uint8Array.from(bytes),profile,charset);
 assert.equal(actual.size,2);
 assert.equal(actual.get(77).displayName,'North\nHallé');assert.equal(actual.get(77).name,'North Hallé');
 assert.equal(actual.get(77).episode.name,'North');assert.equal(actual.get(78).episode.name,'South');
 assert.deepEqual(actual.get(77).mapPosition,[-15,-32]);assert.deepEqual(actual.get(78).mapSize,[11,9]);
 assert.notEqual(actual.get(77).source.roomField,actual.get(78).source.roomField);
 assert.equal(deriveRoomMetadata(rows,[],Uint8Array.from(bytes),profile,charset,[78]).size,1);
 add(header(north,77,'North'),77); // ambiguous ownership must not choose a winner
 assert(!deriveRoomMetadata(rows,[],Uint8Array.from(bytes),profile,charset).has(77));
 const items=[...actual.values(),{episode:null}],defs=episodeFilters(items);
 assert.equal(defs.length,3);
 const selected=new Set(['Episode: North','Episode: South']);
 assert.equal(items.filter(i=>matchesFilters(i,defs,selected)).length,2);
 assert.equal(items.filter(i=>matchesFilters(i,defs,new Set(['Episode: Unknown']))).length,1);
 const withFacet=[...defs,['named north',(i:any)=>i.episode?.name==='North']];
 assert.equal(items.filter(i=>matchesFilters(i,withFacet,new Set([...selected,'named north']))).length,1);
 console.log('Structured room metadata and episode filter checks passed');
} finally {await rm(tmp,{recursive:true,force:true});}
