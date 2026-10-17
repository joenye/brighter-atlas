// Effect colours picked by story progress: the per-build bindings' validator, the reader (an emitter record's owner's
// rows before its instance's) and the table a room's story position picks (a giant crystal's glow red until its story
// reaches a step, then blue), and the effects layer drawing it.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-colour-states-'));
try {
 const file=path.join(tmp,'colour-states.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/effect-properties.ts';",resolveDir:path.resolve(import.meta.dirname,'..'),loader:'ts'},
  bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'error'});
 const {validEffectColourStates,createEffectColourStateReader,storyColourTable,storyColoured}=await import(pathToFileURL(file).href);
 let checks=0;
 const ok=(v:boolean,what:string)=>{assert.ok(v,what);checks++;};
 const red=[[0.46,0.14,0.21,1],[0.46,0.14,0.21,1]], blue=[[0.14,0.29,0.44,1],[0.14,0.29,0.44,1]], green=[[0.14,0.45,0.11,1],[0.14,0.45,0.11,1]];

 // bindings
 const cave={instance:3,owner:217595,variable:120863,states:33,steps:[[0,red],[18,blue]]};
 const clearing={instance:3,owner:212101,variable:91127,states:36,steps:[[0,red],[31,green]]};
 ok(validEffectColourStates([cave,clearing]),'an instance per owner and quest variable');
 ok(validEffectColourStates([{...cave,owner:undefined}]),'an instance without an owner');
 ok(!validEffectColourStates([cave,cave]),'a repeated instance, owner and variable');
 ok(!validEffectColourStates([{...cave,steps:[[1,red],[18,blue]]}]),'steps start at the first state');
 ok(!validEffectColourStates([{...cave,steps:[[0,red]]}]),'one step is no choice');
 ok(!validEffectColourStates([{...cave,steps:[[0,red],[33,blue]]}]),'a step past the last state');
 ok(!validEffectColourStates([{...cave,steps:[[0,red],[18,[[2,0,0,1],[0,0,0,1]]]]}]),'a channel past 1');
 ok(!validEffectColourStates([{...cave,steps:[[18,blue],[0,red]]}]),'steps in order');

 // reader: objects[slot].values[1] is the record's instance; op 0 names the owning system's record
 const objects:any[]=[];objects[7]={values:[0,3]};objects[8]={values:[0,4]};
 const read=createEffectColourStateReader([cave,clearing,{instance:4,variable:91127,states:36,steps:[[0,red],[31,green]]}],objects);
 const op0=(v:number)=>[{op:0,kind:'scalar',value:v}];
 ok(read(7,op0(217595))?.[0].variable===120863,'the Cave owner follows its own quest');
 ok(read(7,op0(212101))?.[0].variable===91127,'the Clearing owner follows its own quest');
 ok(read(7,op0(1))===null,'an owner with no rows: none');
 ok(read(8,op0(5))?.[0].variable===91127,'an instance row whatever the owner');
 ok(createEffectColourStateReader(undefined,objects)(7,op0(217595))===null,'no bindings: none');
 assert.throws(()=>createEffectColourStateReader([cave,cave],objects));checks++;

 // the table at a room's story position (null: the room follows another quest)
 const stories=read(7,op0(217595));
 const at=(v:number|null)=>storyColourTable(stories,(variable:number)=>variable===120863?v:null);
 ok(JSON.stringify(at(0))===JSON.stringify(red),'the story\'s start: red');
 ok(JSON.stringify(at(17))===JSON.stringify(red),'the step before: red');
 ok(JSON.stringify(at(18))===JSON.stringify(blue),'from step 18: blue');
 ok(JSON.stringify(at(32))===JSON.stringify(blue),'the story\'s end: blue');
 ok(at(null)===null,'a room following another quest keeps its table');
 ok(storyColourTable(undefined,()=>3)===null,'no stories: none');

 // an emitter as the effects layer builds it for a room: the table at the room's story position, the rest untouched
 const emitter={slot:1,fields:{color:{start:{table:red,stories},end:'start'},speed:null}};
 const room=(v:number|null)=>storyColoured(emitter,(variable:number)=>variable===120863?v:null);
 ok(JSON.stringify(room(32).fields.color.start.table)===JSON.stringify(blue),'the room at its story\'s end: blue');
 ok(JSON.stringify(room(5).fields.color.start.table)===JSON.stringify(red),'the room early in its story: red');
 ok(room(null)===emitter,'a room following another quest: the emitter as it is');
 ok(storyColoured(emitter,undefined)===emitter,'no position: the emitter as it is');
 ok(JSON.stringify(emitter.fields.color.start.table)===JSON.stringify(red),'the extraction\'s emitter unchanged');
 ok(room(32).fields.color.end==='start'&&room(32).slot===1,'everything else kept');
 console.log(`effect colour states: ${checks} binding, reader and story checks passed`);
} finally { await rm(tmp,{recursive:true,force:true}); }
