import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-shape-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/effect-shape.ts'; export {createEffectFieldReader} from './src/extract/world/effect-fields.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 const symbols=['$acceleration0','$color0','$none','$scale0','$screen','$speed0','$direction_single'];
 const sym=(name:string)=>({kind:'symbol',index:symbols.indexOf(name),name});
 const empty={kind:'other',tag:1},flag={kind:'other',tag:13};
 const owner={kind:'scalar',tag:-85,value:0};
 const rate=(v:number)=>({kind:'rate',value:v,den:600}),float=(v:number)=>({kind:'float',value:v});
 const vec=(...v:number[])=>({kind:'vec3',v}),color=(...rgba:number[])=>({kind:'color',rgba});
 const range=(a:number,b:number)=>({kind:'typed',class:40,fields:[float(a),float(b)]});
 const sampledRate={kind:'typed',class:41,fields:[range(1,2),{kind:'duration',ticks:600}]};
 // Records: [runtime, instance, type, fields, direct references].
 const records:[number,number,number,any[],number[]][]=[];
 const add=(runtime:number,instance:number,fields:any[],refs:number[]=[],type=0)=>{records.push([runtime,instance,type,fields,refs]);return records.length-1;};
 // configs first so emitters can reference them
 const windows=add(50,9,[owner,{kind:'int',value:3},{kind:'typed',class:42,fields:[{kind:'duration',ticks:0},{kind:'duration',ticks:30}]},sym('$none')]);
 add(50,9,[owner,{kind:'int',value:5},{kind:'list',tag:32,values:[]},{kind:'duration',ticks:90}]);
 const style=add(70,1,[owner,color(0,0,1,1),...Array(15).fill(float(1))]);
 const surface=add(71,1,[owner,{kind:'ref',slot:style}]);
 const wave=add(60,11,[owner,{kind:'int',value:1},{kind:'ref',slot:style},{kind:'other',tag:24},{kind:'int',value:15},float(9),flag,{kind:'other',tag:12}]);
 const wide=add(61,12,[owner,{kind:'int',value:1},{kind:'ref',slot:style},{kind:'other',tag:24},{kind:'int',value:15},float(9),flag,{kind:'int',value:2}]);
 const point=add(80,13,[owner,flag,vec(1,2,3),empty,range(0,1),range(0,1),vec(0,0,1),float(0),float(360),float(0),float(10)]);
 add(80,14,[owner,flag,empty,empty,range(0,1),range(0,1),vec(0,0,1),float(0),float(360),float(0),float(10)]);
 add(80,16,[owner,flag,vec(1,2,3),empty,range(0,1),range(0,1),empty,float(0),float(360),float(0),float(10)]);
 const position=add(81,15,[owner,vec(4,5,6),empty,vec(0,0,1),float(0),float(90),float(0),float(45)]);
 const configs=[windows,wave,wide,point,position];
 // A larger emitter: direction, speed end, rotation, spin, colour end, scale
 // start and end, acceleration start and end, colour start, sprite, speed start.
 const large=(instance:number,speed1:any,colour0:any,accel1:any,mode='$screen')=>add(100,instance,[owner,sym(mode),vec(0,0,1),speed1,float(0),rate(0),sym('$color0'),
  float(2),sym('$scale0'),vec(0,0,-1),accel1,colour0,{kind:'scalar',tag:2,value:7},rate(40)],configs);
 large(1,sym('$speed0'),color(1,0,0,1),sym('$acceleration0'),'$direction_single');
 large(1,rate(5),color(0,1,0,1),vec(0,0,0));
 large(2,sym('$speed0'),empty,sym('$acceleration0'));
 large(3,sampledRate,color(0,0,1,1),vec(1,1,1));
 // The same record without any acceleration marker: it borrows the others' ends.
 add(101,4,[owner,sym('$screen'),vec(0,0,1),sym('$speed0'),float(0),rate(0),sym('$color0'),float(2),sym('$scale0'),vec(0,0,-1),vec(0,0,-1),color(1,1,1,1),{kind:'scalar',tag:2,value:7},rate(40)]);
 // A compact emitter: sprite, then both speeds, rotation, spin, both colours,
 // both scales and both accelerations.
 add(200,5,[owner,sym('$screen'),{kind:'scalar',tag:2,value:7},rate(10),sym('$speed0'),float(0),rate(0),color(1,1,1,1),sym('$color0'),
  float(1),float(3),vec(0,0,0),sym('$acceleration0')]);
 add(200,5,[owner,sym('$screen'),{kind:'scalar',tag:2,value:7},rate(10),rate(20),float(0),rate(0),color(1,1,1,1),color(1,1,1,0),
  float(1),sym('$scale0'),vec(0,0,0),vec(1,0,0)]);
 // An older record: no rotation, the colour start beside its end.
 add(300,6,[owner,{kind:'duration',ticks:60},sym('$speed0'),rate(0),color(1,0,0,1),sym('$color0'),float(1),sym('$scale0'),
  vec(0,0,0),sym('$acceleration0'),{kind:'scalar',tag:2,value:7},rate(8)]);
 // Controllers of the type subtree with the stable id: one follows a water style.
 const ctrl=add(900,20,[owner,{kind:'int',value:0},{kind:'int',value:0},{kind:'ref',slot:style}],[],2);
 add(901,21,[owner,{kind:'int',value:0},{kind:'int',value:0},sym('$none')],[],3);
 add(902,22,[owner,{kind:'int',value:0},{kind:'int',value:0},float(1)],[],3);
 add(903,23,[owner,{kind:'int',value:0},{kind:'int',value:0},{kind:'ref',slot:style}],[],9);
 // The owning system lists every emitter in a series; each points back at it.
 const emitterSlots=records.map((r,slot)=>[100,101,200,300].includes(r[0])?slot:-1).filter(slot=>slot>=0);
 const system=add(10,30,[owner]);
 const rows=records.map(([runtime,,,fields,refs],slot)=>({slot,selector:runtime,runtime,start:0,end:0,m:[],g:[],
  v:emitterSlots.includes(slot)?[[0,'U',system]]:[],s:slot===system?[[1,emitterSlots]]:[],
  r:(emitterSlots.includes(slot)&&!refs.length?[windows]:refs).map((ref:number)=>[0,ref])}));
 const objects=records.map(([runtime,instance,type],slot)=>({slot,selector:runtime,runtime,values:[0,instance,type]}));
 const ids=new Uint8Array(8*10);ids.set([0x34,0xf2,0x8b,0xa2,0x59,0x5b,0xcb,0x34],8);
 const types={ends:Int32Array.from([9,4,2,3,4,5,6,7,8,9]),ids};
 const extras=(slot:number)=>records[slot]?.[3].map((f:any,op:number)=>({op,...f}))??null;
 const water={surface:71,curtain:72,style:1,styleFields:{amplitude:[8,12],frequency:[9,13],rate:[10,14]}};
 const out=T.effectLayout({rows,objects,symbols,types,extras},water);

 // value classes by their fields
 assert.deepEqual(out.effectFields.classes,{range:40,rate:41,vector:65535,colour:65535});
 const fields=new Map(out.effectFields.bindings.map((b:any)=>[b.instance,b]));
 const large1={instance:1,speed:[13,3],angularSpeed:5,acceleration:[9,10],scale:[7,8],rotation:4,color:[11,6]};
 assert.deepEqual(fields.get(1),large1);
 assert.deepEqual(fields.get(2),{...large1,instance:2,color:[null,6]},'an empty colour start stays unresolved');
 assert.deepEqual(fields.get(3),{...large1,instance:3});
 assert.deepEqual(fields.get(4),{...large1,instance:4},'a family without a marker borrows the ends of the others');
 assert.deepEqual(fields.get(5),{instance:5,speed:[3,4],angularSpeed:6,acceleration:[11,12],scale:[9,10],rotation:5,color:[7,8]});
 assert.deepEqual(fields.get(6),{instance:6,speed:[11,2],angularSpeed:3,acceleration:[8,9],scale:[6,7],rotation:null,color:[4,5]});
 assert.equal(fields.size,6);
 // the readers accept the derived data as they accept the decode data
 const read=T.createEffectFieldReader(out.effectFields,objects);
 const slotOf=(instance:number)=>objects.findIndex((o:any)=>o.values[1]===instance);
 assert.deepEqual(read(slotOf(3),extras(slotOf(3))).speed,{start:{value:40,ticks:600},end:{value:[1,2],ticks:600}});

 const facings=new Map(out.effectFacings.map((b:any)=>[b.instance,b]));
 assert.deepEqual(facings.get(1),{instance:1,modeField:1,axisField:2});
 assert.deepEqual(facings.get(5),{instance:5,modeField:1,axisField:null},'no direction vector ahead of the compact fields');
 assert.equal(facings.has(6),false,'no facing field, no facing');

 assert.deepEqual(out.effectWindows,[{instance:9,rate:1,windows:2,period:3,rangeClass:42,noneSymbol:2}]);
 assert.deepEqual(out.effectWaves,{step:12,bindings:[{instance:11,water:2,point:3,count:4,threshold:5,translation:6,
  waterFields:{amplitude:[8,12],frequency:[9,13],rate:[10,14]}}]},'a burst with a trailing count is not a wave burst');
 assert.deepEqual(out.effectOrigins,[
  {instance:13,kind:'point',position:2,axis:6,yaw:[7,8],pitch:[9,10],samples:[4,5],uniformClass:40},
  {instance:15,kind:'position',position:1,axis:3,yaw:[4,5],pitch:[6,7],uniformClass:40}],'a computed position or axis stays unbound');
 assert.deepEqual(out.effectMotion,{controllers:[{runtime:900,field:3},{runtime:901,field:3}],
  settings:[{runtime:70,x:[8,9,10],y:[12,13,14]}]},'controllers outside the subtree or with other values are left out');
 assert.equal(ctrl>=0&&surface>=0,true);

 // no emitter series: nothing is derived
 const bare=T.effectLayout({rows:rows.map((r:any)=>({...r,s:[]})),objects,symbols,types,extras},null);
 assert.equal(bare.effectFields,undefined);assert.equal(bare.effectWaves,undefined);assert.equal(bare.effectMotion,undefined);
 console.log('effect shape: OK');
} finally { await rm(tmp,{recursive:true,force:true}); }
