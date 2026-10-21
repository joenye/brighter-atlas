// The version diff on images the game re-encoded: new bytes (a new content hash), the same picture (a fingerprint
// within a few levels), so unchanged, not one removed and one added. 21-Oct-2026 re-encoded nearly every texture.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-diff-reencoded-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export {diffIndexes} from './src/diff.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'warning'});
 const {diffIndexes}=await import(pathToFileURL(file).href);
 const px=(f:(k:number)=>number)=>btoa(String.fromCharCode(...Array.from({length:192},(_,k)=>f(k))));
 const image=(i:number,h:string,print:string|null,w=64)=>({i,h,cat:'material',n:1,entries:[{fmt:'BC1',w,h:w}],...(print?{px:print}:{})});
 const ramp=(k:number)=>k%256, noisy=(k:number)=>Math.min(255,k%256+(k%3)), other=(k:number)=>255-k%256;
 const steps=(k:number)=>(k*7)%256, flat=()=>50;
 const before=[image(0,'a',px(ramp)),image(1,'b',px(steps)),image(2,'c',px(flat),128),image(3,'d',null)];
 const after=[image(0,'A',px(noisy)),image(1,'B',px(other)),image(2,'C',px(flat),64),image(3,'D',null)];
 const d=diffIndexes(before,after,'images');
 // a: re-encoded (unchanged); b: a different picture; c: another size; d: no fingerprint (an index from before them)
 assert.equal(d.reencoded,1);
 assert.equal(d.unchanged,1);
 assert.deepEqual(d.added.map((e:any)=>e.h).concat(d.changed.map((c:any)=>c.active.h)).sort(),['B','C','D']);
 // each added image takes one removed image at most
 const two=diffIndexes([image(0,'a',px(ramp))],[image(0,'A',px(ramp)),image(1,'A2',px(noisy))],'images');
 assert.equal(two.reencoded,1); assert.equal(two.added.length,1);
 // the same picture with a plane more (a material given a lighting map): one image changed
 const planes=(i:number,h:string,n:number)=>({i,h,cat:'material',n,px:px(ramp),entries:Array.from({length:n},()=>({fmt:'BC1',w:64,h:64}))});
 const repack=diffIndexes([planes(0,'p',6)],[planes(0,'P',9)],'images');
 assert.equal(repack.reencoded,undefined); assert.equal(repack.changed.length,1); assert.equal(repack.added.length+repack.removed.length,0);
 // rooms and models read a re-encoded picture as the one it was
 const imagesA=[image(5,'old',px(ramp))], imagesB=[image(7,'new',px(noisy))];
 const ctx={aliases:diffIndexes(imagesA,imagesB,'images').aliases,imagesA,imagesB,meshesA:[],meshesB:[]};
 const room=(h:string,t:number)=>({i:0,h,name:'Square',size:[4,4],textures:[t]});
 const rooms=diffIndexes([room('r1',5)],[room('r2',7)],'world',ctx);
 assert.equal(rooms.reencoded,1); assert.equal(rooms.changed.length,0);
 const model=(h:string,image:string)=>({i:-1,h,name:'Bear',skel:'s',parts:[{mesh_hash:'m',image_hash:image}]});
 const models=diffIndexes([model('a','old')],[model('b','new')],'models',ctx);
 assert.equal(models.reencoded,1); assert.equal(models.added.length+models.removed.length+models.changed.length,0);
 // other categories never match by fingerprint
 assert.equal(diffIndexes(before,after,'meshes').reencoded,undefined);
 console.log('diff re-encoded: ok');
} finally { await rm(tmp,{recursive:true,force:true}); }
