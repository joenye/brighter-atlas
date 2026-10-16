import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-kinds-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export {effectKindOf, EFFECT_KINDS, DEFAULT_EFFECT_KINDS} from './src/viewers/world/effects-layer.ts';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error'});
  const K = await import(pathToFileURL(file).href);
  const looping = {loop: true, triggered: false}, fired = {loop: false, triggered: true};
  // what plays at rest, and an actor's playing controller even when its system is one fired by events
  assert.equal(K.effectKindOf({}, looping, false), 'rest');
  assert.equal(K.effectKindOf({default_active: true}, looping, false), 'rest');
  assert.equal(K.effectKindOf({active: true}, fired, false), 'rest');
  // a resting set's flourish, an owner's other state and its actions, a fired effect
  assert.equal(K.effectKindOf({default_active: false}, looping, true), 'extras');
  assert.equal(K.effectKindOf({default_active: false, inactive: 'state'}, looping, false), 'states');
  assert.equal(K.effectKindOf({default_active: false, inactive: 'action'}, looping, false), 'actions');
  assert.equal(K.effectKindOf({default_active: false}, looping, false), 'states', 'documents from before the reason was kept');
  assert.equal(K.effectKindOf({}, fired, false), 'oneshot');
  assert.deepEqual([...K.DEFAULT_EFFECT_KINDS], ['rest', 'extras']);
  assert.equal(new Set(K.EFFECT_KINDS).size, 5);
  console.log('Effect kinds: at rest, occasional extras, other states, actions, one-offs');
} finally { await rm(tmp, {recursive: true, force: true}); }
