import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-actor-height-'));
try{
  const file=path.join(tmp,'placement.mjs');
  await build({entryPoints:['src/extract/world/placement.ts'],bundle:true,platform:'node',format:'esm',outfile:file});
  const {packedRoomHeight,validatePlacementData,loadPlacementData,createActorHeightReader}=await import(pathToFileURL(file).href);
  for(const [word,layer,expected] of [[0xf5,0,5],[5,0,0],[0x120023,1,7],[0x20023,1,0],[0x120003,1,5],[0x120023,2,3]])
    assert.equal(packedRoomHeight(word,layer),expected);
  const hash='a'.repeat(64),data={kind:'brighter-atlas-placement-decode',format:1,bundle0_raw_sha256:hash,
    rooms:{fieldCount:5,width:1,height:2,origin:3,words:4,links:0},actors:{parent:5}};
  assert.equal(validatePlacementData(data,hash),data);
  assert.throws(()=>validatePlacementData(data,'b'.repeat(64)));
  assert.throws(()=>validatePlacementData({...data,rooms:{...data.rooms,words:1}},hash));
  assert.equal(await loadPlacementData(hash,async()=>{throw Error('not available');}),null);
  await assert.rejects(()=>loadPlacementData(hash,async()=>({...data,format:2})));
  const lit=(tag:number,value:any)=>({kind:'lit',tag,value,elems:null});
  const grid=(origin:number[],words:number[])=>({table:[],top:[lit(10,99),lit(10,words.length),lit(10,1),lit(46,origin),
    {kind:'array',tag:32,elems:words.map(v=>lit(10,v))}]});
  const rooms=new Map([[10,grid([10,20],[0,0,0])],[11,grid([9,20],[0,0,0x17])],[12,grid([10,20],[0,0x19,0])]]);
  const rows=[{slot:0,start:0,end:6,selector:0,v:[]},{slot:1,start:6,end:8,selector:0,v:[]},
    {slot:2,start:8,end:10,selector:0,v:[]},{slot:3,start:10,end:10,selector:0,v:[[5,'U',0]]}].map(r=>({...r,g:[],r:[],s:[],m:[]}));
  const roomRows=new Map([[10,{record:0}],[11,{record:1}],[12,{record:2}]]);
  const bytes=new Uint8Array([32,2,38,1,38,2,32,0,32,0]);
  const profile={bundle0:{raw_sha256:hash},class_fields:{},tag6_fields:{},selectors:{0:{fill:['G']}}};
  const options={data,rooms,roomRows,rows,bytes,profile,pool:[]};
  const read=createActorHeightReader(options);
  const actor={record:3,default_room_record:0,position:[1,0,0]};
  assert.deepEqual(read(10,actor),{height:7,z:3584,room:11},'translate room origins and stop at the first positive linked height');
  assert.deepEqual(read(10,{...actor,position:[0,0,0]}),{height:0,z:0,room:null},'zero is a valid final height');
  assert.deepEqual(read(10,{...actor,position:[-20,0,0]}),{height:0,z:0,room:null},'out-of-bounds tiles must not wrap into a row');
  assert.throws(()=>read(10,{...actor,default_room_record:2}),/different height parent/);
  assert.equal(createActorHeightReader({...options,data:null}),null);
  assert.throws(()=>createActorHeightReader({...options,data:{...data,rooms:{...data.rooms,fieldCount:6}}}),/field count/);
  const invalid=new Map(rooms);invalid.set(10,grid([10,20],[0.5,0,0]));
  assert.throws(()=>createActorHeightReader({...options,rooms:invalid}),/invalid height word/);
  console.log('Actor heights preserve zero, ordered linked-room lookup and coordinate origins; invalid bindings and source shapes fail closed');
}finally{await rm(tmp,{recursive:true,force:true});}
