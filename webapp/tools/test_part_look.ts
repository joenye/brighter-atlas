// A placed part's look, as the game's part builder gives it: its part colour entry's colour multiplies the albedo and
// its two tints recolour the masked regions; the record's own recolour tuple is not read as tints for these parts.
// The room view, the pinned preview and All rooms all take it the same way.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-part-look-'));
try {
 const file=path.join(tmp,'look.mjs');
 await build({stdin:{contents:"export {partLookOf} from './src/viewers/world/scene.ts'; export {lookPaletteTuple, mergedPaletteTuple, MergedWorld} from './src/viewers/world/merged.ts'; export {isIdentityRecolor} from './src/recolor.ts';",
  resolveDir:path.resolve(import.meta.dirname,'..'),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'error'});
 const {partLookOf,lookPaletteTuple,mergedPaletteTuple,MergedWorld,isIdentityRecolor}=await import(pathToFileURL(file).href);
 let checks=0;
 const ok=(c:boolean,m:string)=>{assert.ok(c,m);checks++;};
 const half=127/255;
 // a grey hedge: the record names the two colours the game picks between per tile, and a neutral third
 const recolors=[[0.213,0.213,0.213,1],[0.274,0.274,0.274,1],[0.498,0.498,0.498,1]];
 const entry=[0.213,0.213,0.213,1, half,half,half,1, half,half,half,1];
 const look=partLookOf(entry,recolors);
 assert.deepEqual(look.colour,[0.213,0.213,0.213]);checks++;
 ok(look.tints.length===2&&look.tints.every((t:number[])=>t.length===4),'the entry\'s two tints, half range');
 ok(isIdentityRecolor(look.tints),'neutral tints leave the albedo as it is (the colour alone darkens the hedge)');
 ok(!isIdentityRecolor(recolors),'the record\'s tuple, read as tints, would not be neutral (what drew the hedge pale)');
 // a coloured tint recolours
 const tinted=partLookOf([1,1,1,1, 0.6,0.3,0.2,1, half,half,half,1],recolors);
 assert.deepEqual(tinted.colour,[1,1,1]);checks++;
 ok(!isIdentityRecolor(tinted.tints),'a coloured tint recolours the masked regions');
 // an entry with no tints: colour only
 ok(partLookOf([0.5,0.6,0.7,1],recolors).tints===null,'an entry of a colour alone carries no tints');
 // no entry: the part's first recolour as its colour, as the game's own frame takes it
 const bare=partLookOf(null,recolors);
 assert.deepEqual(bare.colour,[0.213,0.213,0.213]);checks++;
 ok(bare.tints===null,'no entry: no tints');
 assert.deepEqual(partLookOf(null,null).colour,[1,1,1]);checks++;
 assert.deepEqual(partLookOf([NaN,1,1,1],null).colour,[1,1,1]);checks++;
 // colours past 1 (the packed half range reaches 2) are kept
 assert.deepEqual(partLookOf([1.6,1.2,0.8,1],null).colour,[1.6,1.2,0.8]);checks++;

 // All rooms: the palette's fourth column is the colour; three-column tuples keep white there
 const tuple=lookPaletteTuple(look.tints,look.colour);
 ok(tuple.length===4,'a look tuple has four columns');
 assert.deepEqual(tuple[2],[0.5,0.5,0.5]);checks++;
 assert.deepEqual(tuple[3],[0.213,0.213,0.213]);checks++;
 assert.deepEqual(lookPaletteTuple(null,[0.4,0.5,0.6]).slice(0,2),[[1,1,1],[1,1,1]]);checks++;
 const texture=MergedWorld.prototype._buildPalette.call({},[[[1,1,1],[1,1,1],[0.5,0.5,0.5]],tuple,mergedPaletteTuple(recolors)]);
 const d=texture.image.data,texel=(i:number,s:number)=>Array.from(d.slice((i*4+s)*4,(i*4+s)*4+3)).map((v:any)=>+Number(v).toFixed(3));
 assert.deepEqual(texel(0,3),[1,1,1]);checks++;
 assert.deepEqual(texel(1,3),[0.213,0.213,0.213]);checks++;
 assert.deepEqual(texel(1,0),[+half.toFixed(3),+half.toFixed(3),+half.toFixed(3)]);checks++;
 assert.deepEqual(texel(2,3),[1,1,1]);checks++;
 assert.deepEqual(texel(2,2),[0.498,0.498,0.498]);checks++;
 // per-instance slots only where the colours differ
 const interned:string[]=[];
 const host={_internTuple:(t:any)=>{const k=JSON.stringify(t);let i=interned.indexOf(k);if(i<0){interned.push(k);i=interned.length-1;}return i;}};
 const same=MergedWorld.prototype._itemPalettes.call(host,recolors,{hasRecolor:true,fullTint:false},look.tints,[look.colour,look.colour]);
 ok(same.palettes===undefined&&same.palette===0,'one slot when every instance shares its colour');
 const mixed=MergedWorld.prototype._itemPalettes.call(host,recolors,{hasRecolor:true,fullTint:false},look.tints,[[0.213,0.213,0.213],[0.274,0.274,0.274]]);
 ok(Array.isArray(mixed.palettes)&&mixed.palettes[0]!==mixed.palettes[1],'a slot per instance when the per-tile colours differ');
 const plain=MergedWorld.prototype._itemPalettes.call(host,recolors,{hasRecolor:true,fullTint:false},undefined,undefined);
 ok(plain.palettes===undefined&&JSON.parse(interned[plain.palette]).length===3,'without the look, the record\'s tuple as before');
 console.log(`part looks: ${checks} colour, tint and palette checks passed`);
} finally { await rm(tmp,{recursive:true,force:true}); }
