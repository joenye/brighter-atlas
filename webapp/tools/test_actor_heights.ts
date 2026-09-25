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
  const {packedRoomHeight,validatePlacementData,placementDataOf,createActorHeightReader,decodeDefaultAppearances,createAppearanceCandidateReader}=await import(pathToFileURL(file).href);
  for(const [word,layer,expected] of [[0xf5,0,5],[5,0,0],[0x120023,1,7],[0x20023,1,0],[0x120003,1,5],[0x120023,2,3]])
    assert.equal(packedRoomHeight(word,layer),expected);
  const hash='a'.repeat(64),data={kind:'brighter-atlas-placement-decode',format:1,bundle0_raw_sha256:hash,
    rooms:{fieldCount:5,width:1,height:2,origin:3,words:4,links:0},actors:{parent:5}};
  assert.equal(validatePlacementData(data,hash),data);
  assert.throws(()=>validatePlacementData(data,'b'.repeat(64)));
  assert.throws(()=>validatePlacementData({...data,rooms:{...data.rooms,words:1}},hash));
  assert.equal(placementDataOf({bundle0:{raw_sha256:hash}}),null);
  assert.equal(placementDataOf({bundle0:{raw_sha256:hash},placement:data}),data);
  assert.throws(()=>placementDataOf({bundle0:{raw_sha256:hash},placement:{...data,format:2}}));
  const lit=(tag:number,value:any)=>({kind:'lit',tag,value,elems:null});
  const grid=(origin:number[],words:number[])=>({table:[],top:[lit(10,99),lit(10,words.length),lit(10,1),lit(46,origin),
    {kind:'array',tag:32,elems:words.map(v=>lit(10,v))}]});
  const rooms=new Map([[10,grid([10,20],[0,0,0])],[11,grid([9,20],[0,0,0x17])],[12,grid([10,20],[0,0x19,0])]]);
  const rows=[{slot:0,start:0,end:6,selector:0,v:[]},{slot:1,start:6,end:8,selector:0,v:[]},
    {slot:2,start:8,end:10,selector:0,v:[]},{slot:3,start:10,end:10,selector:0,v:[[5,'U',0]]}].map(r=>({...r,g:[],r:[],s:[],m:[]}));
  const roomRows=new Map([[10,{record:0}],[11,{record:1}],[12,{record:2}]]);
  const bytes=new Uint8Array([32,2,38,1,38,2,32,0,32,0]);
  const profile={bundle0:{raw_sha256:hash},class_fields:{},tag6_fields:{},selectors:{0:{fill:['G']}}};
  const source=new Uint8Array([255,32,2,0,0,38,4,15,0]);
  const defaults={...data,defaultAppearances:[{runtime:17,start:1,end:7},{runtime:18,start:7,end:9}]};
  const defaultsPool=[{tag:38,value:3}];
  const selected=decodeDefaultAppearances(defaults,source,profile,defaultsPool,['$none'],5);
  assert.deepEqual([...selected],[[17,{controllers:[3,4]}],[18,{controllers:[]}]]);
  assert.equal(decodeDefaultAppearances(data,source,profile,defaultsPool,['$none'],5).size,0);
  assert.equal(decodeDefaultAppearances(null,source,profile,defaultsPool,['$none'],5).size,0);
  assert.throws(()=>decodeDefaultAppearances({...defaults,bundle0_raw_sha256:'b'.repeat(64)},source,profile,defaultsPool,['$none'],5),/match/);
  assert.throws(()=>decodeDefaultAppearances(defaults,source,profile,defaultsPool,['$none'],4),/source value/);
  assert.throws(()=>decodeDefaultAppearances(defaults,source,profile,[{tag:1}],['$none'],5),/source value/);
  for(const binding of [{runtime:17,start:1,end:6},{runtime:17,start:1,end:8},{runtime:17,start:1,end:50}])
    assert.throws(()=>decodeDefaultAppearances({...data,defaultAppearances:[binding]},source,profile,defaultsPool,['$none'],5));
  for(const bindings of [[defaults.defaultAppearances[0],defaults.defaultAppearances[0]],
    [{runtime:-1,start:1,end:7}],[{runtime:17,start:7,end:1}],[{runtime:17,start:1.5,end:7}]])
    assert.throws(()=>validatePlacementData({...data,defaultAppearances:bindings},hash),/appearance bindings/);
  const candidateBytes=new Uint8Array([38,3,38,4,15,0]);
  const candidateRows=Array.from({length:5},(_,slot)=>({slot,runtime:slot===0?17:18,start:0,end:6,selector:0,g:[],r:[],s:[],m:[],v:[]}));
  const candidateProfile={...profile,selectors:{0:{fill:['G','G','G']}}};
  const candidateData={...data,appearanceCandidates:[{runtime:17,fields:[0,1,2]}]};
  const candidateRead=createAppearanceCandidateReader(candidateData,candidateRows,candidateBytes,candidateProfile,[],['$none']);
  assert.deepEqual(candidateRead(0),[3,4]);
  assert.equal(candidateRead(1),null,'unbound owners stay unknown');
  assert.equal(candidateRead(50),null);
  assert.equal(createAppearanceCandidateReader(null,candidateRows,candidateBytes,candidateProfile,[],['$none'])(0),null);
  assert.equal(createAppearanceCandidateReader(data,candidateRows,candidateBytes,candidateProfile,[],['$none'])(0),null);
  const noFields={...data,appearanceCandidates:[{runtime:17,fields:[3]}]};
  assert.throws(()=>createAppearanceCandidateReader(noFields,candidateRows,candidateBytes,candidateProfile,[],['$none'])(0),/source value/);
  assert.throws(()=>createAppearanceCandidateReader(candidateData,candidateRows.slice(0,4),candidateBytes,candidateProfile,[],['$none'])(0),/source value/);
  for(const bindings of [[{runtime:17,fields:[]}],[{runtime:17,fields:[0,0]}],[{runtime:17,fields:[-1]}],
    [{runtime:17,fields:[0]},{runtime:17,fields:[1]}]])
    assert.throws(()=>validatePlacementData({...data,appearanceCandidates:bindings},hash),/candidate bindings/);
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
