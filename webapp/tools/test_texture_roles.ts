// Material plane recovery: mip chains of one map, including containers that
// store a map's smallest level after its largest, and the plane roles read
// from them. Synthetic container layouts only.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-texture-roles-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/texture-roles.ts';",
  resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 let checks=0;
 const run=(fmt:number,sizes:number[])=>sizes.map((w)=>({fmt,w,h:w}));
 const BC1=0x26,BC5S=0x25;
 // Ascending chains: albedo, normal, parameter.
 const plain=[...run(BC1,[64,128,256]),...run(BC5S,[64,128,256]),...run(BC1,[64,128,256])];
 assert.deepEqual(T.detectChains(plain),[0,0,0,1,1,1,2,2,2]);checks++;
 assert.deepEqual(T.resolveRoles({entries:plain}),{albedo:2,normal:5,parameter:8,parameters:[8]});checks++;
 // 128, 256, 512, then 64: the 64 is each plane's fourth level, not a plane.
 const late=[...run(BC1,[128,256,512,64]),...run(BC5S,[128,256,512,64]),...run(BC1,[128,256,512,64])];
 assert.deepEqual(T.detectChains(late),[0,0,0,0,1,1,1,1,2,2,2,2]);checks++;
 assert.deepEqual(T.resolveRoles({entries:late}),{albedo:2,normal:6,parameter:10,parameters:[10]});checks++;
 // Two planes of one format stay two chains, stored either way round.
 assert.deepEqual(T.detectChains(run(BC1,[64,128,256,64,128,256])),[0,0,0,1,1,1]);checks++;
 assert.deepEqual(T.detectChains(run(BC1,[256,128,64,256,128,64])),[0,0,0,1,1,1]);checks++;
 // A half-size image that starts the next plane of the same format is not
 // folded back: only the last image of a format run can be a late level.
 assert.deepEqual(T.detectChains(run(BC1,[128,256,512,64,128,256,512])),[0,0,0,1,1,1,1]);checks++;
 // A padded level (68 then 36) stays in its chain (the level walk then drops
 // it); a change of format always starts a new chain.
 assert.deepEqual(T.detectChains([...run(BC1,[68,36]),...run(BC5S,[34])]),[0,0,1]);checks++;
 console.log(`texture roles: ${checks} checks passed`);
} finally { await rm(tmp,{recursive:true,force:true}); }
