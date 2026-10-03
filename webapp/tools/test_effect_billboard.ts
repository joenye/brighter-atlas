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
const material=new T.ShaderMaterial({vertexShader:BILLBOARD_VERTEX,fragmentShader:'varying vec2 vUv; void main(){gl_FragColor=vec4(vUv,1.0,1.0);}',uniforms:{uFacingSizeScale:{value:1},uTurned:{value:0},uUvRect:{value:new T.Vector4(0,0,1,1)},uSpriteSize:{value:new T.Vector2(.5,1)}},side:T.DoubleSide,depthTest:false,blending:T.NoBlending});
scene.add(new T.Mesh(geometry,material));const results=[];
// The authored upper edge moves right for a positive quarter-turn.
for(const [angle,x,y] of [[Math.PI/2,.25,0],[-Math.PI/2,-.25,0],[Math.PI/4,.1767767,.1767767],[-Math.PI/4,-.1767767,.1767767]]){
 rotation.array[0]=angle;rotation.needsUpdate=true;renderer.setRenderTarget(target);renderer.render(scene,camera);
 const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,Math.floor((x+1)*64),Math.floor((y+1)*64),1,1,pixel);
 results.push({angle,pixel:Array.from(pixel)});
}
// A picture stored turned: each screen corner's texel, unturned then turned (roll 0, a square sprite).
rotation.array[0]=0;rotation.needsUpdate=true;material.uniforms.uSpriteSize.value.set(1,1);const turns=[];
for(const turned of [0,1]){material.uniforms.uTurned.value=turned;renderer.setRenderTarget(target);renderer.render(scene,camera);
 for(const [x,y] of [[-.25,-.25],[.25,-.25],[-.25,.25],[.25,.25]]){const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,Math.floor((x+1)*64),Math.floor((y+1)*64),1,1,pixel);turns.push({turned,x,y,uv:[pixel[0]/255,pixel[1]/255]});}}
window.__turns=turns;
// The frame spanning a stretch of the picture (0.1 to 1.5 across, 0.2 to 1.25 down): near each screen corner, the
// texel the stretch puts there (texture v runs up, the picture's rows down).
material.uniforms.uTurned.value=0;material.uniforms.uUvRect.value.set(.1,.2,1.5,1.25);const spans=[];
renderer.setRenderTarget(target);renderer.render(scene,camera);
for(const [x,y] of [[-.45,-.45],[.45,-.45],[-.45,.45],[.45,.45]]){const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,Math.floor((x+1)*64),Math.floor((y+1)*64),1,1,pixel);spans.push({x,y,uv:[pixel[0]/255,pixel[1]/255]});}
material.uniforms.uUvRect.value.set(0,0,1,1);window.__spans=spans;
window.__result=results;renderer.dispose();target.dispose();geometry.dispose();material.dispose();`,resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,format:'esm',outfile:path.join(root,'test.js')});
  await writeFile(path.join(root,'index.html'),'<script type="module" src="test.js"></script>');
  const serving=await serve(root);server=serving.server;
  browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox',...GL_ARGS]});
  const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${serving.port}/index.html`);
  await page.waitForFunction(()=>!!(window as any).__result);
  const results=await page.evaluate(()=>(window as any).__result);assert.deepEqual(errors,[]);
  for(const r of results){assert(Math.abs(r.pixel[0]-128)<8,JSON.stringify(r));assert(Math.abs(r.pixel[1]-191)<8,JSON.stringify(r));assert.equal(r.pixel[2],255);}
  // The game pairs a turned picture's corners with the quad's corners so that what an unturned picture shows at a
  // corner moves on: bottom right -> bottom left -> top left -> top right -> bottom right (picture corners; the
  // texture's v runs up, the picture's rows down). Whatever this quad's own axes, that is what each corner must show.
  const turns=await page.evaluate(()=>(window as any).__turns);
  const corner=(uv:number[])=>(uv[1]<.5?'B':'T')+(uv[0]<.5?'L':'R');
  const next:Record<string,string>={BR:'BL',BL:'TL',TL:'TR',TR:'BR'};
  for(const t of turns.filter((t:any)=>!t.turned)){const u=turns.find((v:any)=>v.turned&&v.x===t.x&&v.y===t.y);assert.equal(corner(u.uv),next[corner(t.uv)],`turned picture at (${t.x},${t.y}): ${JSON.stringify(t.uv)} -> ${JSON.stringify(u.uv)}`);}
  // (a corner pixel's centre sits a little inside the quad; colours saturate at 1, so only in-range ends are exact)
  const spans=await page.evaluate(()=>(window as any).__spans);
  for(const sp of spans){const s=(sp.x+.5)/1,t=(sp.y+.5)/1;const u=.1+(1.5-.1)*s,v=1-(.2+(1.25-.2)*(1-t));
    const want=[Math.min(1,Math.max(0,u)),Math.min(1,Math.max(0,v))];
    assert.ok(Math.abs(sp.uv[0]-want[0])<.03&&Math.abs(sp.uv[1]-want[1])<.03,`stretch at (${sp.x},${sp.y}): ${JSON.stringify(sp.uv)}, want ${JSON.stringify(want)}`);}
  console.log('4 GPU billboard roll-direction probes, 4 turned-picture corners and 4 picture-stretch corners passed');
} finally {await browser?.close();server?.close();await rm(root,{recursive:true,force:true});}
