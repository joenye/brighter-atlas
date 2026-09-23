// Game water: resolving water materials and styles through per-build field
// bindings (link field, styles, textures, opacity, texture rectangle), the
// per-frame layer and wave uniforms, the packed style colour and the room
// tile-colour grid. Synthetic records only.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-game-water-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/water-materials.ts'; export * as W from './src/viewers/world/game-water.ts';",
  resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 let checks=0;const ok=(c:any,m:string)=>{assert(c,m);checks++;};
 const data={link:{families:[20,21],field:9},surface:30,curtain:31,style:1,opacity:4,textureRect:6,
  styleFields:{colour:1,normal:2,cube:3,uv0:[4,5],uv1:[6,7],amplitude:[8,12],frequency:[9,13],rate:[10,14],tilt:[11,15],level:16},
  textures:{plane:{family:40,image:3},cube:{family:41,image:2}},waterLevel:1024};
 ok(T.validWaterData(data),'valid bindings');
 ok(!T.validWaterData({...data,link:{families:[],field:9}}),'needs link families');
 ok(!T.validWaterData({...data,styleFields:{...data.styleFields,uv0:[4]}}),'pairs');
 ok(!T.validWaterData({...data,waterLevel:NaN}),'finite level');
 // Rows: two standard materials linking to a surface and a curtain, one
 // standard material without a link, and one linking to a non-water row.
 const rows:any[]=[];
 const row=(slot:number,runtime:number,r:[number,number][]=[])=>{rows[slot]={slot,runtime,r,g:[],s:[],m:[],v:[]};};
 row(1,20,[[9,5]]);row(2,21,[[9,6]]);row(3,20);row(4,21,[[9,8]]);
 row(5,30);row(6,31);row(7,99);row(8,77);
 row(10,50);row(11,40);row(12,41);
 // Little-endian floats as the generic reader decodes them (big-endian).
 const swap=(v:number)=>{const d=new DataView(new ArrayBuffer(4));d.setFloat32(0,v,true);return d.getFloat32(0,false);};
 const G=(op:number,node:any)=>({op,kind:'G',node});
 const fields:Record<number,any[]>={
  1:[G(4,{tag:0x0b,value:[0.4]}),G(6,{tag:0x3c,value:[0,0,1,1].map(swap)})],
  2:[G(4,{tag:0x0b,value:[0.6]}),G(6,{tag:0x3c,value:[0,0.25,1,0.75].map(swap)})],
  4:[G(4,{tag:0x0b,value:[0.5]}),G(6,{tag:0x3c,value:[0,0,1,1].map(swap)})],
  5:[G(1,{tag:0x26,value:10})],6:[G(1,{tag:0,value:0})],
  10:[G(1,{tag:0x15,value:[0.22,0.47,0.47,0.25]}),G(2,{tag:0x02,value:11}),G(3,{tag:0x02,value:12}),
   G(4,{tag:0x18,value:[0.0002,0.0002]}),G(5,{tag:0x18,value:[0.000025,0.00005]}),G(6,{tag:0x18,value:[0.00016,0.00016]}),G(7,{tag:0x18,value:[0.00005,0.0001]}),
   ...[20,0.0017,0.004,0.01,40,0.0011,0.007,0.02,-60].map((v,k)=>G(8+k,{tag:0x0b,value:[v]}))],
  11:[G(3,{tag:0x47,value:1686})],12:[G(2,{tag:0x47,value:9605})],
 };
 const pool=[{tag:0x26,value:10}];
 const water=T.readWorldWater(data,rows,(slot:number)=>fields[slot]??null,pool);
 ok(water&&water.level===1024,'level');
 ok(Object.keys(water.materials).sort().join()==='1,2','only water links: '+Object.keys(water.materials));
 assert.deepEqual(water.materials['1'],{kind:'surface',style:0,opacity:0.4,window:[0,1]});checks++;
 assert.deepEqual(water.materials['2'],{kind:'curtain',style:0,opacity:0.6,window:[0.25,0.75]});checks++;
 ok(water.styles.length===1,'styles are shared');
 const style=water.styles[0];
 assert.deepEqual(style.layers,[[0.0002,0.0002,0.000025,0.00005],[0.00016,0.00016,0.00005,0.0001]]);checks++;
 assert.deepEqual(style.waves,{amplitude:[20,40],frequency:[0.0017,0.0011],rate:[0.004,0.007],tilt:[0.01,0.02]});checks++;
 ok(style.normal===1686&&style.cube===9605&&style.level===-60,'textures and level');
 ok(T.readWorldWater(undefined,rows,()=>null,pool)===null,'no data');
 ok(T.readWorldWater(data,rows,(slot:number)=>slot===10?fields[10].filter((f:any)=>f.op!==3):fields[slot]??null,pool)===null,'missing cube skips');
 const wrongTexture=T.readWorldWater({...data,textures:{...data.textures,plane:{family:42,image:3}}},rows,(slot:number)=>fields[slot]??null,pool);
 ok(wrongTexture===null,'texture record family must match');
 // Per-frame uniforms: offsets scroll and wrap, phases travel and wrap.
 const u=T.W.createStyleUniforms(style);
 const srgb=(c:number)=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;
 const packed=(v:number)=>Math.floor(Math.fround(Math.fround(v)*255))/255;
 ok(Math.abs(u.uStyleColour.value.x-packed(srgb(0.22)))<1e-9&&Math.abs(u.uStyleColour.value.w-packed(0.25))<1e-9,'linear packed colour');
 for(const t of [0,600,123456,-50]){
  T.W.updateStyleUniforms(u,style,t);
  const frac=(v:number)=>((v%1)+1)%1;
  ok(Math.abs(u.uLayer0.value.z-frac(0.000025*t))<1e-9&&Math.abs(u.uLayer1.value.w-frac(0.0001*t))<1e-9,'layer offsets '+t);
  const turn=(v:number)=>((v%(2*Math.PI))+2*Math.PI)%(2*Math.PI);
  ok(Math.abs(u.uWaveX.value.z-turn(0.004*t))<1e-9&&Math.abs(u.uWaveY.value.z-turn(0.007*t))<1e-9,'phases '+t);
 }
 ok(u.uWaveX.value.x===20&&u.uWaveY.value.y===0.0011&&u.uWaveX.value.w===0.01,'wave constants');
 // Room grid: palette plus 16-bit cells, origin from the room offset and rect.
 const cells=new Uint16Array([0,1,1,0,2,0]);
 const b64=Buffer.from(cells.buffer).toString('base64');
 (globalThis as any).atob??=(s:string)=>Buffer.from(s,'base64').toString('binary');
 const grid=T.W.createWaterGrid({x0:-10,y0:-10,width:3,height:2,palette:[[0.5,0.5,0.5,1],[0.26,0.39,0.39,1],[0.56,0.5,0.37,1]],cells:b64},[2048,-1024]);
 ok(grid&&grid.size.x===3&&grid.size.y===2&&grid.origin.x===2048&&grid.origin.w===-10,'grid shape');
 const d=grid.texture.image.data;
 ok(d[4]===Math.fround(0.26)&&d[16]===Math.fround(0.56)&&d[20]===0.5,'grid texels');
 ok(T.W.createWaterGrid({x0:0,y0:0,width:2,height:2,palette:[[1,1,1,1]],cells:b64},[0,0])===null,'size mismatch rejected');
 ok(Math.abs(T.W.NEUTRAL_TINT-126/255)<1e-12,'neutral tint');
 console.log(`game water: ${checks} binding, style, uniform and grid checks passed`);
}finally{await rm(tmp,{recursive:true,force:true});}
