// Synthetic actor records: room lists are not an exhaustive placement census.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-spawns-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/spawns.ts'; export * from './src/extract/world/graph.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const {SpawnGraph,AssetGraph}=await import(pathToFileURL(file).href);
 const charset=['?','é','l','k'];
 const uint=(v:number):number[]=>{const out=[];do{const b=v%128;v=Math.floor(v/128);out.push(b|(v?128:0));}while(v);return out;};
 const ref=(n:number)=>[38,...uint(n)];
 const int=(n:number)=>{const b=new Uint8Array(4);new DataView(b.buffer).setInt32(0,n);return [10,...b];};
 const float=(n:number)=>{const b=new Uint8Array(4);new DataView(b.buffer).setFloat32(0,n);return [11,...b];};
 const location=(x:number,y:number)=>[36,...uint(7),...int(x),...int(y),...int(0),...ref(0)];
 const bytes:number[]=[],rows:any[]=[],selectors:any={},pool:any[]=[];
 function add(fields:number[][],events:any[][]=[]){
  const slot=rows.length,start=bytes.length;bytes.push(...uint(slot),...fields.flat());
  selectors[slot]={runtime:slot,ctor_varints:0,fill:['U',...fields.map(()=> 'G')]};
  rows.push({slot,selector:slot,runtime:slot,start,end:bytes.length,g:events,r:[],s:[],m:[],v:[]});return slot;
 }
 pool.push({tag:11,value:[90]});
 add([[0,0]],[[1,0,0,0]]); // direction
 add([[19,77],ref(3)],[[1,0,19,77],[2,0,38,3]]); // room A cross-references an actor in B
 add([[19,78]],[[1,0,19,78]]); // room B has no actor list
 add([[14,3,1,2,3],float(1.5),ref(2),...Array.from({length:1},()=>int(4)),location(6,2)],[[3,0,38,2]]);
 add([[13],[13],float(0.5),ref(1),location(1,2)],[[4,0,38,1]]); // shifted header
 add([[13],[13],float(0.5),ref(1),location(1,2)],[[4,0,38,1]]); // alternate remains distinct
 add([float(0.5),ref(1),[36,8,...[1,2,3,1,1,2].flatMap(float)]],[[2,0,38,1]]); // volume is not actor
 add([float(0.5),ref(1),location(1,2),location(5,6)],[[2,0,38,1]]); // ambiguous locations
 const profile:any={selectors,class_fields:{7:4,8:6},tag6_fields:{}};
 const graph=new AssetGraph(rows,pool),spawns=new SpawnGraph(rows,pool,graph,{
   bytes:Uint8Array.from(bytes),profile,charset,enemyDefs:[{slot:20,name:'Elk',targets:[3]}],
 });
 const rooms=spawns.discoverRoomRows([77,78]);
 const a=spawns.roomSpawns(77,rooms.get(77)),b=spawns.roomSpawns(78,rooms.get(78));
 assert.deepEqual(a.map(s=>s.record),[4,5]);assert.deepEqual(b.map(s=>s.record),[3]);
 assert.equal(b[0].label,'Elk');assert.equal(b[0].authored_label,'élk');
 assert.deepEqual(b[0].position,[6,2,0]);assert.equal(b[0].centre_offset,1.5);assert.equal(b[0].rotation_quarters,1);
 assert(b[0].memberships.every(m=>m.kind==='default_room'));
 assert.equal(spawns.spawn(6),null);assert.equal(spawns.spawn(7),null);
 assert.deepEqual(a.map(s=>s.centre_offset),[0.5,0.5]);
 console.log('Actor discovery, shifted fields, charset, cross-room references, alternatives and non-actor checks passed');
} finally {await rm(tmp,{recursive:true,force:true});}
