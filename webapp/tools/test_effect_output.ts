// Display and exported frames must use the same particle colour arithmetic.
// Probe real materials and the shared capture path, including overlapping
// particles, both blend modes, a coloured sprite, background, mesh and fog.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';
import {CHROME,GL_ARGS} from './chrome.ts';
import {serve} from './serve.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-output-'));
let browser:any,server:any;
try {
 await build({stdin:{contents:`
import * as T from './vendor/three.module.js';
import {EffectsPlayer} from './src/viewers/world/effects-player.ts';
import {WorldEffectsLayer} from './src/viewers/world/effects-layer.ts';
import {renderCaptureFrame} from './src/viewers/capture-common.ts';
const renderer=new T.WebGLRenderer({alpha:true,premultipliedAlpha:false,preserveDrawingBuffer:true,antialias:true});renderer.setSize(64,64);renderer.setClearColor(0,1);
const camera=new T.PerspectiveCamera(45,1,.1,10);camera.position.z=2;
const results=[];const gl=renderer.getContext();
const read=()=>{const pixel=new Uint8Array(4);gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return Array.from(pixel);};
const pixel=frame=>Array.from(frame.data.slice((31*64+32)*4,(31*64+32)*4+4));
for(const surface of ['world','preview'])for(const blend of ['add','mix'])for(const mask of [false,true]){
 const system={slot:1,loop:false,blend,emitters:[{life:{ticks:100},burst:1,sprite:{images:[-1]}}]};
 const doc={tick_rate:{value:600},configs:{1:{kind:'burst_windowed',per_second:600,windows:[[0,0]]}},systems:[system],attachments:{rooms:[{room:1,system:1,owner:2,cell:[0,0,0],size:[1,1],rotation:0,source:'placement'}]}};
 const root=new T.Group();const player=surface==='world'?new WorldEffectsLayer({root,doc,url:r=>r,textures:{},tileUnits:1,layerUnits:1}):new EffectsPlayer({root,doc,url:r=>r});
 if(surface==='world'){player.addRoom(1,[0,0]);player.setClock(1);}else{player.addSystem(1);player.syncClock(1,1);}
 let mesh;root.traverse(o=>{if(o.geometry?.attributes.aColor)mesh=o;});
 const scene=new T.Scene();scene.add(mesh);mesh.matrix.identity();mesh.matrixAutoUpdate=false;mesh.visible=true;
 // Linear sample values isolate output conversion from texture decoding.
 const texture=new T.DataTexture(new Uint8Array([128,192,64,128]),1,1);texture.needsUpdate=true;
 mesh.material.uniforms.map.value=texture;mesh.material.uniforms.uMask.value=mask?1:0;mesh.material.uniforms.uSpriteSize.value.set(1,1);
 for(let i=0;i<2;i++){mesh.geometry.attributes.aPosSize.array.set([0,0,0,1],i*4);mesh.geometry.attributes.aColor.array.set([.6,.2,.1,.25],i*4);}
 mesh.geometry.attributes.aPosSize.needsUpdate=true;mesh.geometry.attributes.aColor.needsUpdate=true;
 for(const count of [1,2]){
  mesh.geometry.instanceCount=count;renderer.setRenderTarget(null);renderer.render(scene,camera);const canvas=read();
  const capture=pixel(renderCaptureFrame({renderer,scene,camera},64,64,{transparent:false}));
  const transparent=pixel(renderCaptureFrame({renderer,scene,camera},64,64));
  results.push({surface,blend,mask,count,canvas,capture,transparent});
 }
 texture.dispose();player.dispose();
}
const scene=new T.Scene();scene.background=new T.Color('#243b51');scene.fog=new T.Fog('#718095',.1,4);
scene.add(new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({color:'#b43768',fog:true})));
renderer.setClearColor('#19354f',.3);renderer.render(scene,camera);const canvas=read();
const cornerBefore=new Uint8Array(4);gl.readPixels(2,2,1,1,gl.RGBA,gl.UNSIGNED_BYTE,cornerBefore);
const background=scene.background,fog=scene.fog,clear=renderer.getClearColor(new T.Color()).clone();
const wholeCapture=renderCaptureFrame({renderer,scene,camera},64,64,{transparent:false});
const capture=pixel(wholeCapture),cornerCapture=Array.from(wholeCapture.data.slice((61*64+2)*4,(61*64+2)*4+4));
const restored=scene.background===background&&scene.fog===fog&&renderer.getClearColor(new T.Color()).equals(clear)&&renderer.getClearAlpha()===.3&&renderer.getRenderTarget()===null&&camera.aspect===1;
// Restoration must also happen when drawing throws.
const render=renderer.render;renderer.render=()=>{throw Error('draw failed');};
try{renderCaptureFrame({renderer,scene,camera},32,64);}catch{}finally{renderer.render=render;}
const restoredOnError=scene.background===background&&scene.fog===fog&&renderer.getClearColor(new T.Color()).equals(clear)&&renderer.getClearAlpha()===.3&&renderer.getRenderTarget()===null&&camera.aspect===1;
scene.background=null;scene.fog=null;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.7;renderer.render(scene,camera);
const toneCanvas=read(),toneCapture=pixel(renderCaptureFrame({renderer,scene,camera},64,64,{transparent:false}));
const clearBefore=new Uint8Array(4);renderer.render(scene,camera);gl.readPixels(2,2,1,1,gl.RGBA,gl.UNSIGNED_BYTE,clearBefore);
const clearFrame=renderCaptureFrame({renderer,scene,camera},64,64,{transparent:false});const clearCapture=Array.from(clearFrame.data.slice((61*64+2)*4,(61*64+2)*4+4));
window.__result={results,mesh:{canvas,capture},background:{canvas:Array.from(cornerBefore),capture:cornerCapture},tone:{canvas:toneCanvas,capture:toneCapture},clear:{canvas:Array.from(clearBefore),capture:clearCapture},restored,restoredOnError};renderer.dispose();
`,resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,format:'esm',outfile:path.join(root,'test.js')});
 await writeFile(path.join(root,'index.html'),'<script type="module" src="test.js"></script>');
 const serving=await serve(root);server=serving.server;
 browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox',...GL_ARGS]});
 const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
 await page.goto(`http://127.0.0.1:${serving.port}/index.html`);await page.waitForFunction(()=>!!(window as any).__result);
 const result=await page.evaluate(()=>(window as any).__result);assert.deepEqual(errors,[]);
 for(const r of result.results){
  const alpha=(128/255)*.25;const rgb=[.6,.2,.1].map((v,k)=>v*(r.mask?1:[128,192,64][k]/255));let expected=[0,0,0],a=0;
  for(let i=0;i<r.count;i++){expected=expected.map((v,k)=>rgb[k]*alpha+v*(r.blend==='add'?1:1-alpha));a=alpha+a*(1-alpha);}
  for(const channel of ['canvas','capture'])for(let k=0;k<3;k++)assert(Math.abs(r[channel][k]-expected[k]*255)<2.1,JSON.stringify({r,channel,expected}));
  for(let k=0;k<3;k++)assert(Math.abs(r.transparent[k]-expected[k]*255/a)<10,JSON.stringify({r,expected,a}));
  assert(Math.abs(r.transparent[3]-a*255)<2.1);
 }
 for(const kind of ['mesh','background','tone','clear'])for(let k=0;k<3;k++)assert(Math.abs(result[kind].canvas[k]-result[kind].capture[k])<2.1,JSON.stringify({kind,...result[kind]}));
 assert(result.restored);assert(result.restoredOnError);
 console.log(result.results.length+' display/export particle cases passed, plus mesh/fog and state restoration');
} finally {await browser?.close();server?.close();await rm(root,{recursive:true,force:true});}
