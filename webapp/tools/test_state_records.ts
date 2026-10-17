// Records picked by story progress: the per-build bindings' validator, and a shard's story-dependent colours drawn at
// the step a room shows (a giant crystal red until its story reaches a step, then blue).
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-state-records-'));
try {
 const file=path.join(tmp,'state-records.mjs');
 await build({entryPoints:[path.resolve(import.meta.dirname,'../src/extract/world/state-records.ts')],bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'error'});
 const {validStateRecords,storyRecolors}=await import(pathToFileURL(file).href);
 let checks=0;
 const ok=(v:boolean,what:string)=>{assert.ok(v,what);checks++;};

 // bindings
 const row={runtime:9092,variable:120863,states:33,steps:[[0,138019],[18,138027]]};
 ok(validStateRecords([row]),'a class, its quest variable and a record per step');
 ok(validStateRecords([row,{...row,variable:146657,states:3,steps:[[0,138019],[2,138020]]}]),'the same class under two variables');
 ok(!validStateRecords([row,row]),'one binding per class and variable');
 ok(!validStateRecords([{...row,steps:[[1,138019],[18,138027]]}]),'steps start at the first state');
 ok(!validStateRecords([{...row,steps:[[0,138019],[0,138027]]}]),'steps in order');
 ok(!validStateRecords([{...row,steps:[[0,138019],[33,138027]]}]),'a step within the variable');
 ok(!validStateRecords([{...row,steps:[[0,138019]]}]),'at least two steps');
 ok(!validStateRecords([{...row,steps:[[0,-1],[18,138027]]}]),'records are slots');
 ok(!validStateRecords({}),'a list');

 // a shard: colours 0 a shared entry, 1 the crystal face's own (as its object names: blue), 2 red, 3 blue
 const red=[[0.88,0.49,0.57,1],[0.5,0.5,0.5,1],[0.5,0.5,0.5,1]],blue=[[0.33,0.69,0.87,1],[0.5,0.5,0.5,1],[0.5,0.5,0.5,1]];
 const shard={room:848,recolors:[[[1,1,1,1]],blue,red,blue],
  state_recolors:[{recolor:1,variable:120863,states:33,steps:[[0,2],[18,3]]}]};
 const at=(step:number|null)=>storyRecolors(shard,(variable:number)=>variable===120863?step:null);
 ok(at(0).recolors[1]===red,'before the step: red');
 ok(at(17).recolors[1]===red,'one before: red');
 ok(at(18).recolors[1]===blue,'from the step: blue');
 ok(at(32).recolors[1]===blue,'at the story\'s end: blue');
 ok(at(null)===shard,'a room on another quest keeps the colours the object names');
 ok(at(0)!==shard&&shard.recolors[1]===blue,'the stored shard is left as it is');
 ok(at(0).recolors[0]===shard.recolors[0],'other entries untouched');
 ok(storyRecolors({room:1,recolors:[red]},()=>3).recolors[0]===red,'a shard with nothing that follows a story');
 console.log(`state records: ${checks} binding and story colour checks passed`);
} finally {
 await rm(tmp,{recursive:true,force:true});
}
