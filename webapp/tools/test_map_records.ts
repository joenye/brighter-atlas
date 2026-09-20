// Synthetic map-only data, with no room occupancy or mesh bundle available.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-map-records-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/maps/records.ts'; export * from './src/extract/maps/geometry.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const {deriveMapRoomRecords,extractMapGeometry,packMapColor}=await import(pathToFileURL(file).href);
 const charset=['?','H','a','l','é','\n','C','r','y','s','t','W','o','k','p',' ','h'];
 const uint=(v:number):number[]=>{const out=[];do{const b=v%128;v=Math.floor(v/128);out.push(b|(v?128:0));}while(v);return out;};
 const scalar=(v:number,integer=false)=>{const b=new Uint8Array(4),d=new DataView(b.buffer);if(integer)d.setInt32(0,v);else d.setFloat32(0,v);return [...b];};
 const int=(v:number)=>[10,...scalar(v,true)],float=(v:number)=>[11,...scalar(v)];
 const ref=(v:number)=>[38,...uint(v)],symbol=(v:number)=>[15,...uint(v)];
 const color=(v:number)=>[21,...[v,v,v,1].flatMap(n=>scalar(n))];
 const vector=(x:number,y:number)=>[24,...scalar(x),...scalar(y)];
 const pair=(x:number,y:number)=>[46,...scalar(x,true),...scalar(y,true)];
 const list=(v:number[][])=>[32,...uint(v.length),...v.flat()];
 const typed=(cls:number,v:number[][])=>[36,...uint(cls),...v.flat()];
 const text=(s:string)=>[14,...uint(s.length),...Array.from(s).flatMap(c=>{const i=charset.indexOf(c);assert(i>=0,c);return uint(i);})];
 const bytes:number[]=[],rows:any[]=[],selectors:any={};
 const add=(fields:number[][])=>{const slot=rows.length,start=bytes.length;bytes.push(...uint(slot),...fields.flat());
   selectors[slot]={runtime:slot,ctor_varints:0,fill:['U',...fields.map(()=> 'G')]};
   rows.push({slot,selector:slot,runtime:slot,start,end:bytes.length,g:[],r:[],s:[],m:[],v:[]});return slot;};
 const palette=add(Array.from({length:6},(_,i)=>color(i/8)));
 const metadata=new Map();
 for(const [id,legacy,padding] of [[77,false,3],[78,true,7]] as const){
  const title='Hallé\nHallé';
  const fields=[text(title),...Array.from({length:padding},()=>[13]),[71,0],
   list([pair(-1,2),pair(3,-4)]),list([int(0x03020100),int(0x03020100)]),
   ...(legacy?[int(0),int(1)]:[[13],int(0),int(1),int(0)]),
   ...Array.from({length:legacy?3:4},(_,i)=>color(i/4)),vector(-5,8),vector(2,4),symbol(0),
   ...(legacy?[typed(2,[1,2,3,4,5].map(float))]:[typed(1,[1,2,3,4].map(float)),typed(1,[5,6,7,8].map(float))]),
   symbol(1),legacy?list([ref(0)]):list([typed(3,[text('Crystal Workshop'),ref(palette),int(24),int(7),symbol(0)])])];
  const owner=add(fields);
  metadata.set(id,{room:id,owner,name:'Hallé Hallé',displayName:title,episode:null,mapPosition:[-12,6],mapSize:[10,9],source:{nameField:1}});
 }
 const profile:any={selectors,class_fields:{1:4,2:5,3:5},tag6_fields:{}};
 const records=deriveMapRoomRecords(rows,[],Uint8Array.from(bytes),profile,charset,['$none','$panel'],metadata);
 assert.equal(records.size,2);
 const current=records.get(77),old=records.get(78);
 assert.deepEqual(current.terrain.positions,[[-1,2],[3,-4]]);
 assert.deepEqual(current.terrain.groupCounts,[0,1,0]);assert.deepEqual(old.terrain.groupCounts,[0,1]);
 assert.equal(current.labels.annotations[0].text,'Crystal Workshop');
 assert.equal(current.labels.annotations[0].condition.symbol,'$none');
 assert.equal(current.labels.annotations[0].palette.length,6);
 assert.deepEqual(current.labels.metrics,[[1,2,3,4],[5,6,7,8]]);assert.deepEqual(old.labels.metrics,[[1,2,3,4,5]]);
 assert.equal(old.labels.annotations.length,0);assert.deepEqual(old.labels.annotationEntries,[{tag:38,value:0}]);
 const lut=Uint8Array.from([...Array(32).fill(1),2,0,16,0,1,2,0,16,0,1]);
 let reading=false,calls=0;
 const read=async()=>{assert(!reading);reading=true;await new Promise(r=>setTimeout(r,1));reading=false;calls++;return lut;};
 const palette555=new Map([[0,100],[1,200],[2,300],[3,400]]);
 const patches=await extractMapGeometry(records.values(),[{flags:1,n:2}],read,()=>palette555);
 assert.equal(calls,2);assert.deepEqual(patches.map(p=>p.group),[1,3,1,2]);
 assert.deepEqual(patches[0].position,[-13,8]);assert.deepEqual(patches[0].corners555,[100,200,300,400]);
 assert.deepEqual(patches[0].tiles,Array(16).fill(1));
 assert.equal(packMapColor([1,1,1]),0x7fff);assert.equal(packMapColor([0,0,0]),0);
 await assert.rejects(()=>extractMapGeometry(records.values(),[{flags:1,n:2}],read,()=>new Map()),/unresolved map style/);
 await assert.rejects(()=>extractMapGeometry(records.values(),[{flags:1,n:3}],read,()=>palette555),/lookup count/);
 await assert.rejects(()=>extractMapGeometry(records.values(),[{flags:1,n:2}],async()=>new Uint8Array(4),()=>palette555));
 console.log('Map-only records, historical layouts, annotations, signed coordinates, sequential lookups and strict palette checks passed');
} finally {await rm(tmp,{recursive:true,force:true});}
