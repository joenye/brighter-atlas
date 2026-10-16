import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-gates-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export * from './src/extract/world/effect-gates.ts';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error'});
  const G = await import(pathToFileURL(file).href);
  // rain over a room until the nineteenth step of a 30-step story (a variable's record can be any registry slot)
  const rain = {instance: 13, variable: 91491, emits: Array.from({length: 19}, (_, i) => i), states: 30};
  assert(G.validEffectBurstGates([rain]));
  assert(!G.validEffectBurstGates([{...rain, emits: [30]}]), 'a state the variable does not have');
  assert(!G.validEffectBurstGates([{...rain, states: 0}]));
  assert(!G.validEffectBurstGates([rain, rain]), 'one row per burst');
  const read = G.createEffectGateReader([rain], [{values: [0, 13]}, {values: [0, 14]}]);
  const gate = read(0);
  assert.deepEqual(gate, {variable: 91491, emits: rain.emits, states: 30});
  assert.equal(read(1), null, 'another burst is not gated');
  // as a room's story stands: early, it rains; from the nineteenth step on, and at the story's end (the default), not
  assert.equal(G.gateOpen(gate, 0), true);
  assert.equal(G.gateOpen(gate, 18), true);
  assert.equal(G.gateOpen(gate, 19), false);
  assert.equal(G.gateOpen(gate, null), false);
  assert.throws(() => G.createEffectGateReader([{...rain, emits: [-1]}], []));
  console.log('Burst gates: emitting states of a quest variable, read per burst, open as the story stands');
} finally { await rm(tmp, {recursive: true, force: true}); }
