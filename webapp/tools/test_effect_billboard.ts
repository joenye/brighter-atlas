// An asymmetric UV pattern makes screen-space roll direction observable.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';
import {CHROME,GL_ARGS} from './chrome.ts';
import {serve} from './serve.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'atlas-billboard-'));
let browser:any,server:any;
try {
  await build({stdin:{contents:`import * as T from './vendor/three.module.js';
import {BILLBOARD_VERTEX} from './src/viewers/world/effects-sprite.ts';
const renderer=new T.WebGLRenderer();renderer.setSize(128,128);renderer.setClearColor(0);
const target=new T.WebGLRenderTarget(128,128);
const scene=new T.Scene(),camera=new T.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=5;
const geometry=new T.InstancedBufferGeometry();
geometry.setAttribute('position',new T.Float32BufferAttribute([-.5,-.5,0,.5,-.5,0,.5,.5,0,-.5,.5,0],3));
geometry.setAttribute('uv',new T.Float32BufferAttribute([0,0,1,0,1,1,0,1],2));geometry.setIndex([0,1,2,0,2,3]);
geometry.setAttribute('aPosSize',new T.InstancedBufferAttribute(new Float32Array([0,0,0,1]),4));
geometry.setAttribute('aColor',new T.InstancedBufferAttribute(new Float32Array([1,1,1,1]),4));
const rotation=new T.InstancedBufferAttribute(new Float32Array([0]),1);geometry.setAttribute('aRot',rotation);geometry.instanceCount=1;
const material=new T.ShaderMaterial({vertexShader:BILLBOARD_VERTEX,fragmentShader:'varying vec2 vUv; void main(){gl_FragColor=vec4(vUv,1.0,1.0);}',uniforms:{uFacingSizeScale:{value:1},uSpriteSize:{value:new T.Vector2(.5,1)}},side:T.DoubleSide,depthTest:false,blending:T.NoBlending});
scene.add(new T.Mesh(geometry,material));const results=[];
// The authored upper edge moves right for a positive quarter-turn.
for(const [angle,x,y] of [[Math.PI/2,.25,0],[-Math.PI/2,-.25,0],[Math.PI/4,.1767767,.1767767],[-Math.PI/4,-.1767767,.1767767]]){
 rotation.array[0]=angle;rotation.needsUpdate=true;renderer.setRenderTarget(target);renderer.render(scene,camera);
 const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,Math.floor((x+1)*64),Math.floor((y+1)*64),1,1,pixel);
 results.push({angle,pixel:Array.from(pixel)});
}
window.__result=results;renderer.dispose();target.dispose();geometry.dispose();material.dispose();`,resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,format:'esm',outfile:path.join(root,'test.js')});
  await writeFile(path.join(root,'index.html'),'<script type="module" src="test.js"></script>');
  const serving=await serve(root);server=serving.server;
  browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox',...GL_ARGS]});
  const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${serving.port}/index.html`);
  await page.waitForFunction(()=>!!(window as any).__result);
  const results=await page.evaluate(()=>(window as any).__result);assert.deepEqual(errors,[]);
  for(const r of results){assert(Math.abs(r.pixel[0]-128)<8,JSON.stringify(r));assert(Math.abs(r.pixel[1]-191)<8,JSON.stringify(r));assert.equal(r.pixel[2],255);}
  console.log('4 GPU billboard roll-direction probes passed');
} finally {await browser?.close();server?.close();await rm(root,{recursive:true,force:true});}
