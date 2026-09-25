// The game's draw order for a room: emission keys from occurrence and
// placement rows, parts grouped by material and texture (water by kind and
// style) in walk order, groups by first appearance, dynamic elements after
// every static group. Synthetic rows only.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-draw-order-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/viewers/world/draw-order.ts';",
  resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 let checks=0;
 const oc={x:0,y:1,z:2,entry_slot:3,individual:4,dynamic:5},pc={occurrence:0,part_index:1};
 // Emission keys: layer = individual + 1 (none is 0); dynamic elements drop the layer.
 assert.deepEqual(T.emissionKey([3,4,1,2,-1,0],[0,5],oc,pc),[0,0,-1,4,3,2,5]);checks++;
 assert.deepEqual(T.emissionKey([3,4,1,2,6,0],[0,5],oc,pc),[0,7,-1,4,3,2,5]);checks++;
 assert.deepEqual(T.emissionKey([3,4,1,2,6,1],[0,5],oc,pc),[1,0,-1,4,3,2,5]);checks++;
 // Older data without the dynamic column orders every element as static.
 assert.deepEqual(T.emissionKey([3,4,1,2,-1],[0,5],{x:0,y:1,z:2,entry_slot:3,individual:4},pc),[0,0,-1,4,3,2,5]);checks++;
 const key=(o:number[],part=0)=>T.emissionKey(o,[0,part],oc,pc);
 const batch=(name:string,material:number,texture:number,keys:number[][],water:any=null)=>
  ({name,material,renderTexture:texture,water,matrices:keys.map(()=>null),order:keys});
 const names=(groups:any[])=>groups.map((g:any)=>g.parts.map((p:any)=>`${p.batch.name}${p.index}`).join(' '));
 // One material over two meshes: parts interleave in walk order (upper layer
 // first, then rows, then columns), whatever batch each came from.
 const A=batch('a',1,10,[key([0,0,0,0,-1,0]),key([2,0,0,0,-1,0])]);
 const B=batch('b',1,10,[key([1,0,0,0,-1,0]),key([0,0,1,0,-1,0])]);
 assert.deepEqual(names(T.drawGroups([A,B])),['b1 a0 b0 a1']);checks++;
 // Parts of one element keep slot order; entries of one cell keep entry order.
 const C=batch('c',1,10,[key([0,0,0,1,-1,0],3),key([0,0,0,1,-1,0],1),key([0,0,0,0,-1,0],7)]);
 assert.deepEqual(names(T.drawGroups([C])),['c2 c1 c0']);checks++;
 // Groups draw in the order they first appear; another texture is another group.
 const D=batch('d',2,10,[key([5,5,0,0,-1,0])]),E=batch('e',1,11,[key([1,0,0,0,-1,0])]);
 assert.deepEqual(names(T.drawGroups([D,E,A])),['a0 a1','e0','d0']);checks++;
 // Individual layers come before position: layer 1 (individual 0) after layer 0.
 const F=batch('f',3,10,[key([0,0,1,0,0,0])]),G=batch('g',4,10,[key([9,9,0,0,-1,0])]);
 assert.deepEqual(names(T.drawGroups([F,G])),['g0','f0']);checks++;
 // Dynamic elements form their own groups, after every static group, even
 // for a material the static list also uses.
 const H=batch('h',1,10,[key([0,0,5,0,-1,1]),key([0,0,0,0,-1,0])]);
 assert.deepEqual(names(T.drawGroups([H,G])),['h1','g0','h0']);checks++;
 // Water groups by kind and style: a block's top face (slot 2) before its
 // sides, so the surface group leads; a side-only element first reverses that.
 const S=batch('s',7,20,[key([0,0,0,0,-1,0],2)],{kind:'surface',style:0});
 const W=batch('w',8,20,[key([0,0,0,0,-1,0],4),key([1,0,0,0,-1,0],5)],{kind:'curtain',style:0});
 const S2=batch('t',9,20,[key([1,0,0,0,-1,0],2)],{kind:'surface',style:0});
 assert.deepEqual(names(T.drawGroups([W,S,S2])),['s0 t0','w0 w1']);checks++;
 const Wfirst=batch('v',8,20,[key([0,1,1,0,-1,0],4)],{kind:'curtain',style:0});
 assert.deepEqual(names(T.drawGroups([S,Wfirst])),['v0','s0']);checks++;
 // Without emission keys batches keep their own order.
 const plain=(name:string,material:number,n:number)=>({name,material,renderTexture:10,water:null,matrices:Array(n).fill(null)});
 assert.deepEqual(names(T.drawGroups([plain('p',1,2),plain('q',2,1),plain('r',1,1)])),['p0 p1 r0','q0']);checks++;
 console.log(`draw order: ${checks} checks passed`);
} finally { await rm(tmp,{recursive:true,force:true}); }
