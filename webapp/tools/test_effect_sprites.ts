import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-sprites-'));
try{
 const file=path.join(tmp,'test.mjs');
 await build({entryPoints:[path.resolve(import.meta.dirname,'../src/extract/world/effect-sprites.ts')],bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 const bytes=new Uint8Array([0,2,7,2,11,2,19,0]);
 const binding={instance:8,choices:[{start:3,end:5},{start:1,end:3},{start:3,end:5},{start:5,end:7}]};
 const objects=[{values:[0,8]},{values:[0,9]}],profile={class_fields:{},tag6_fields:{}};
 const read=T.createEffectSpriteReader([binding],objects,bytes,profile,[]);
 assert.deepEqual(read(0),[11,7,11,19]);assert.equal(read(1),null);
 read(0)[0]=99;assert.deepEqual(read(0),[11,7,11,19]);
 assert.equal(T.createEffectSpriteReader(undefined,objects,bytes,profile,[])(0),null);
 for(const invalid of [[binding,binding],[{...binding,instance:-1}],[{...binding,choices:[]}],[{...binding,choices:[{start:1,end:1}]}],[{...binding,choices:[{start:NaN,end:3}]}]]){
  assert(!T.validEffectSprites(invalid));assert.throws(()=>T.createEffectSpriteReader(invalid,objects,bytes,profile,[]));
 }
 for(const choices of [[{start:1,end:9}],[{start:1,end:4}],[{start:0,end:2}]])assert.throws(()=>T.createEffectSpriteReader([{...binding,choices}],objects,bytes,profile,[]));
 const wrong=bytes.slice();wrong[1]=3;
 assert.throws(()=>T.createEffectSpriteReader([{...binding,choices:[{start:1,end:3}]}],objects,wrong,profile,[]));
 console.log('Sprite choices preserve authored order, repeated outcomes, source bounds and unresolved selectors');
}finally{await rm(tmp,{recursive:true,force:true});}
