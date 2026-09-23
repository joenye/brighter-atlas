import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-default-appearance-'));
try {
  const file = path.join(tmp, 'selection.mjs');
  await build({stdin:{contents:"export {readStaticAppearance} from './src/extract/world/default-appearance.ts'; export {WorldEffectsLayer} from './src/viewers/world/effects-layer.ts'; export {Group} from './vendor/three.module.js'; export {EmitterSim} from './src/viewers/world/effects-sim.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
  const {readStaticAppearance,WorldEffectsLayer,Group,EmitterSim} = await import(pathToFileURL(file).href);
  const pool = [{tag:0x26,value:42}];
  const deref = n => n?.tag === 0 ? pool[n.value] : n;
  const symbol = i => i === 4 ? '$none' : '$different';
  for (const shift of [0, 3, 11]) {
    const f = (op, node) => ({op:op+shift,kind:'G',node});
    const prefix = [f(1,{tag:10,value:1}),f(2,{tag:10,value:2}),f(3,{tag:10,value:3}),
      f(4,{tag:11,value:[1]}),f(5,{tag:37,value:[0,0,0,100,200,300]}),
      // Other controller references are deliberately present in the catalogue.
      f(6,{tag:44,values:[{tag:38,value:99},{tag:12}]}),f(12,{tag:13})];
    const tail = [f(14,{tag:15,value:4}),{op:15+shift,kind:'F',raw:new Uint8Array([0])}];
    const read = node => readStaticAppearance([...prefix,f(13,node),...tail],deref,symbol);
    assert.deepEqual(read({tag:38,value:42}),{op:13+shift,controllers:[42]});
    assert.deepEqual(read({tag:0,value:0}),{op:13+shift,controllers:[42]});
    assert.deepEqual(read({tag:15,value:4}),{op:13+shift,controllers:[]});
    assert.deepEqual(read({tag:32,values:[{tag:38,value:42},{tag:32,values:[{tag:38,value:99}]}]}),{op:13+shift,controllers:[42,99]});
    assert.deepEqual(read({tag:32,values:[]}),{op:13+shift,controllers:[]});
    for (const node of [{tag:1},{tag:15,value:5},{tag:38,value:-1},{tag:38,value:1.5},
      {tag:32,values:[{tag:38,value:42},{tag:1}]},{tag:36,class:7,fields:[]}]) assert.equal(read(node),null);
    assert.equal(readStaticAppearance([...prefix.slice(1),f(13,{tag:38,value:42}),...tail],deref,symbol),null);
    assert.equal(readStaticAppearance([...prefix,f(13,{tag:38,value:42}),...tail.slice(0,1)],deref,symbol),null);
    const color = [0.2, 0.4, 0.8, 0.5];
    const parameter = {tag:36,class:8,fields:[{tag:21,value:color}]};
    const readColor = p => readStaticAppearance([...prefix,f(13,{tag:38,value:42}),f(14,p),tail[1]],deref,symbol);
    assert.deepEqual(readColor(parameter),{op:13+shift,controllers:[42],effectColor:color});
    assert.equal(readColor({...parameter,fields:[{tag:21,value:[1,2,NaN,1]}]}).effectColor,undefined);
    assert.equal(readColor({...parameter,fields:[...parameter.fields,{tag:10,value:2}]}).effectColor,undefined);
    const invalid = prefix.map(x=>x.op===12+shift?f(12,{tag:10,value:1}):x);
    assert.equal(readStaticAppearance([...invalid,f(13,{tag:38,value:42}),...tail],deref,symbol),null);
  }
  const emitter = {slot:1,color0:{rgba:[0.4,0.7,0.3,0.25],op:-1},color1:{rgba:[0.4,0.7,0.3,0.25],op:-1},color_override_alpha:0.25};
  const shared = {slot:7,emitters:[emitter]};
  const first = new EmitterSim(shared,0,emitter,{},600,[0.8,0.2,0.1,0.5]);
  const second = new EmitterSim(shared,0,emitter,{},600,[0.1,0.3,0.9,1]);
  assert.deepEqual(first.color0,[204/255,51/255,25/255,31/255]);assert.deepEqual(first.color1,first.color0);
  assert.deepEqual(second.color0,[25/255,76/255,229/255,63/255]);
  assert.deepEqual(emitter.color0.rgba,[0.4,0.7,0.3,0.25]);
  assert.deepEqual(new EmitterSim(shared,0,emitter,{},600).color0,[102/255,178/255,76/255,63/255]);
  assert.deepEqual(new EmitterSim(shared,0,{...emitter,color_override_alpha:undefined},{},600,[1,0,0,1]).color0,[102/255,178/255,76/255,63/255]);
  // Exercise room instantiation and picking. Inactive variants must not
  // shadow an active duplicate; an older record remains usable.
  const attachment = {room:1,occurrence:1,system:7,resource:2,controller:3,
    cell:[2,3,0],center:[2.5,3.5],rot:0,packedFlags:0,matrix:null,bones:null};
  const doc = {tick_rate:{value:600},configs:{},systems:[{slot:7,emitters:[{}],loop:true,triggered:false}],
    attachments:{rooms:[{...attachment,default_active:false},{...attachment,default_active:true},
      {...attachment,occurrence:2,default_active:false},{...attachment,occurrence:3}]}};
  const layer = new WorldEffectsLayer({root:new Group(),doc,url:r=>r,textures:{},tileUnits:1024,layerUnits:512});
  layer.addRoom(1,[0,0]);assert.equal(layer.systemCount(),2);assert.equal(layer.pickables().length,2);
  layer.removeRoom(1);assert.equal(layer.systemCount(),0);assert.equal(layer.pickables().length,0);
  layer.addRoom(1,[0,0],{loopOnly:true});assert.equal(layer.systemCount(),2);layer.dispose();
  console.log('Stored default appearance: shifted headers, pooled/inline refs, empty selection and unresolved/malformed guards passed');
} finally { await rm(tmp,{recursive:true,force:true}); }
