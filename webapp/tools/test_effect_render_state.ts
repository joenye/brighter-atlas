// Exercise the actual world and preview materials on a linear render target.
// Presentation colour conversion is intentionally outside this blend test.
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';
import {CHROME, GL_ARGS} from './chrome.ts';
import {serve} from './serve.ts';
const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-particle-state-'));
let browser: any, server: any;
try {
  await build({stdin: {contents: `
import * as T from './vendor/three.module.js';
import {EffectsPlayer} from './src/viewers/world/effects-player.ts';
import {WorldEffectsLayer} from './src/viewers/world/effects-layer.ts';
import {configureSpriteSampling} from './src/viewers/world/effects-sprite.ts';
const renderer=new T.WebGLRenderer({alpha:true,premultipliedAlpha:false});renderer.setSize(64,64);
renderer.setClearColor(new T.Color().setRGB(.1,.2,.3),.4);
const target=new T.WebGLRenderTarget(64,64);target.texture.colorSpace=T.LinearSRGBColorSpace;
const camera=new T.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=5;
const white=new T.DataTexture(new Uint8Array([255,255,255,255]),1,1);
configureSpriteSampling(white);white.generateMipmaps=true;white.needsUpdate=true;
const results=[];
for(const surface of ['world','preview'])for(const blend of ['add','mix']){
 const system={slot:1,loop:false,blend,emitters:[{life:{ticks:100},burst:1,sprite:{images:[-1]}}]};
 const doc={tick_rate:{value:600},configs:{1:{kind:'burst_windowed',per_second:600,windows:[[0,0]]}},systems:[system],attachments:{rooms:[{room:1,system:1,owner:2,cell:[0,0,0],size:[1,1],rotation:0,source:'placement'}]}};
 const root=new T.Group();
 const player=surface==='world'?new WorldEffectsLayer({root,doc,url:r=>r,textures:{},tileUnits:1,layerUnits:1}):new EffectsPlayer({root,doc,url:r=>r});
 if(surface==='world'){player.addRoom(1,[0,0]);player.setClock(1);}else{player.addSystem(1);player.syncClock(1,1);}
 let mesh;root.traverse(o=>{if(o.geometry?.attributes.aColor)mesh=o;});
 const scene=new T.Scene();scene.add(mesh);mesh.matrix.identity();mesh.matrixAutoUpdate=false;
 mesh.visible=true;mesh.material.uniforms.map.value=white;mesh.material.uniforms.uSpriteSize.value.set(1,1);
 for(let i=0;i<2;i++){
  mesh.geometry.attributes.aPosSize.array.set([0,0,0,1],i*4);
  mesh.geometry.attributes.aColor.array.set([.6,.2,.1,.25],i*4);
 }
 mesh.geometry.attributes.aPosSize.needsUpdate=true;mesh.geometry.attributes.aColor.needsUpdate=true;
 const capture=()=>{renderer.setRenderTarget(target);renderer.render(scene,camera);const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,32,32,1,1,pixel);return Array.from(pixel);};
 for(const count of [1,2]){mesh.geometry.instanceCount=count;results.push({surface,blend,kind:'blend',count,pixel:capture()});}
 mesh.geometry.instanceCount=1;
 const blocker=new T.Mesh(new T.PlaneGeometry(2,2),new T.ShaderMaterial({fragmentShader:'void main(){gl_FragColor=vec4(.1,.2,.3,1.0);}',depthTest:true,depthWrite:true}));
 scene.add(blocker);
 for(const z of [1,0,-1]){blocker.position.z=z;results.push({surface,blend,kind:'depth',z,pixel:capture()});}
 scene.remove(blocker);blocker.geometry.dispose();blocker.material.dispose();
 const probe=new T.Mesh(new T.PlaneGeometry(2,2),new T.ShaderMaterial({fragmentShader:'void main(){gl_FragColor=vec4(0,1,0,1);}',transparent:true,blending:T.NoBlending,depthTest:true}));
 probe.position.z=-1;probe.renderOrder=100;scene.add(probe);
 results.push({surface,blend,kind:'no-depth-write',pixel:capture()});
 probe.geometry.dispose();probe.material.dispose();player.dispose();
}
window.__result={results,sampling:{min:white.minFilter===T.LinearMipmapLinearFilter,mag:white.magFilter===T.LinearFilter,clamp:white.wrapS===T.ClampToEdgeWrapping&&white.wrapT===T.ClampToEdgeWrapping,anisotropy:white.anisotropy}};
white.dispose();target.dispose();renderer.dispose();
`, resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, format: 'esm', outfile: path.join(root, 'test.js')});
  await writeFile(path.join(root, 'index.html'), '<script type="module" src="test.js"></script>');
  const serving = await serve(root); server = serving.server;
  browser = await puppeteer.launch({executablePath: CHROME, headless: true, args: ['--no-sandbox', ...GL_ARGS]});
  const page = await browser.newPage(); const errors: string[] = [];
  page.on('pageerror', (e: any) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${serving.port}/index.html`);
  await page.waitForFunction(() => !!(window as any).__result);
  const {results, sampling} = await page.evaluate(() => (window as any).__result);
  assert.deepEqual(errors, []);
  assert.deepEqual(sampling, {min: true, mag: true, clamp: true, anisotropy: 1});
  for (const r of results) {
    let expected = [.1,.2,.3,.4];
    if (r.kind === 'no-depth-write') expected = [0,1,0,1];
    else if (r.kind === 'depth' && r.z >= 0) expected = [.1,.2,.3,1];
    else {
      if (r.kind === 'depth') expected[3] = 1;
      for (let n = 0; n < (r.count ?? 1); n++) {
        for (let k = 0; k < 3; k++) expected[k] = [.6,.2,.1][k]*.25 + expected[k]*(r.blend === 'add' ? 1 : .75);
        expected[3] = .25 + expected[3]*.75;
      }
    }
    for (let k = 0; k < 4; k++) assert(Math.abs(r.pixel[k]-expected[k]*255)<2.1, JSON.stringify({r,expected}));
  }
  console.log(results.length+' GPU blend, equal/front/back depth and disabled depth-write probes passed on both surfaces');
} finally {await browser?.close(); server?.close(); await rm(root, {recursive: true, force: true});}
