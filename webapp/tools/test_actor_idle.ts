// Actor resting-clip recovery (actor-idle.ts) and frame-0 pose palettes
// (idle-poses.ts) against synthetic registry rows: every field position is
// shifted to prove nothing depends on fixed ops.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-actor-idle-'));
try {
  const file = path.join(tmp, 'idle.mjs');
  await build({stdin:{contents:"export {ActorIdleResolver} from './src/extract/world/actor-idle.ts'; export {idlePosePalette, skinVertices, encodeIdlePose, b64ToF32} from './src/extract/world/idle-poses.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
  const {ActorIdleResolver, idlePosePalette, skinVertices, encodeIdlePose, b64ToF32} = await import(pathToFileURL(file).href);

  // ---- registry: clip records 10..14, controllers, a set, a room, actors ---
  // clip ordinals: 100 (rig 7), 101 (rig 7, long loop), 102 (rig 7), 103 (rig 9), 104 (rig 7)
  const animDir = [];
  animDir[100] = {skel: 7, dur: 2400}; animDir[101] = {skel: 7, dur: 11900}; animDir[102] = {skel: 7, dur: 1260};
  animDir[103] = {skel: 9, dur: 1000}; animDir[104] = {skel: 7, dur: 600}; animDir[105] = {skel: 3, dur: 500};
  const rows = [];
  const row = (slot, g, {r = [], s = []} = {}) => { rows[slot] = {slot, runtime: 1, selector: 0, start: 0, end: 0, g, r, s, m: [], v: []}; };
  const clipRecord = (slot, clip) => row(slot, [[0, 0, 0x61, clip]]);
  clipRecord(10, 100); clipRecord(11, 101); clipRecord(12, 102); clipRecord(13, 103); clipRecord(14, 104); clipRecord(15, 105);
  row(20, [[1, 0, 0x26, 10]]);                                   // simple controller -> clip 100
  row(21, [[1, 0, 0x26, 12], [1, 0, 0x26, 11], [1, 0, 0x26, 14]]); // intro/loop/outro -> longest 101
  row(22, [[1, 0, 0x26, 13]]);                                   // controller on another rig
  row(23, [[0, 0, 0x26, 20], [0, 0, 0x26, 21]], {r: [[7, 21]], s: [[8, [20]]]}); // set: R names 21
  row(24, [[0, 0, 0x26, 20]], {r: [[7, 22]]});                   // set whose primary is off-rig
  row(30, [[2, 0, 0x13, 5168], [3, 0, 0x26, 20]], {r: [[9, 40]]}); // a room row referencing a controller and an actor
  row(40, [[1, 0, 0x26, 10]]);                                   // an actor row (isActor) referencing a clip
  const pool = [{tag: 0x26, value: 20}, {tag: 0x20, values: [{tag: 0x26, value: 23}, {tag: 0x0c}]}];
  const assets = {deref: (n) => (n?.tag === 0 ? pool[n.value] : n), fields: () => new Map()};
  const fieldsBySlot = new Map();
  const resolver = (isActor = (slot) => slot === 40 || slot === 50) => new ActorIdleResolver(rows, pool, assets, animDir, {
    isActor, decode: (slot) => fieldsBySlot.get(slot) ?? null,
    poolRegistryRefs: (index) => (index === 0 ? [20] : index === 1 ? [23] : []),
  });
  const rig7 = new Set([7]);
  const G = (op, node) => ({op, kind: 'G', node});
  const portrait = (clipSlot) => ({tag: 0x24, class: 429, fields: [{tag: 11, value: [1]}, {tag: 11, value: [0]}, {tag: 11, value: [0]}, {tag: 34, value: [0, 0, 0]}, {tag: 0x26, value: clipSlot}]});
  for (const shift of [0, 5, 40]) {
    const f = (op, node) => G(op + shift, node);
    const set = (fields) => { fieldsBySlot.set(50, [{op: 0, kind: 'U', value: 3}, ...fields, {op: 90 + shift, kind: 'F', raw: new Uint8Array([0])}]); };
    // 1. an animation reference field wins over the portrait, whatever kind it is
    set([f(1, portrait(10)), f(9, {tag: 0x0e, values: [1, 2]}), f(26, {tag: 0x26, value: 21})]);
    assert.deepEqual(resolver().resolve(50, rig7), {clip: 101, source: 'animatic', field_op: 26 + shift, controller: 21});
    set([f(1, portrait(10)), f(26, {tag: 0x26, value: 23})]);          // a set: its R controller rests
    assert.deepEqual(resolver().resolve(50, rig7), {clip: 101, source: 'animatic', field_op: 26 + shift, controller: 21});
    set([f(1, portrait(10)), f(26, {tag: 0x26, value: 12})]);          // a bare clip record
    assert.deepEqual(resolver().resolve(50, rig7), {clip: 102, source: 'animatic', field_op: 26 + shift, controller: null});
    set([f(1, portrait(10)), f(26, {tag: 0, value: 0})]);              // pool-interned controller reference
    assert.deepEqual(resolver().resolve(50, rig7), {clip: 100, source: 'animatic', field_op: 26 + shift, controller: 20});
    set([f(1, portrait(10)), f(26, {tag: 0, value: 1})]);              // a list [set, null]
    assert.deepEqual(resolver().resolve(50, rig7), {clip: 101, source: 'animatic', field_op: 26 + shift, controller: 21});
    set([f(1, portrait(10)), f(26, {tag: 0x20, values: [{tag: 0x26, value: 24}, {tag: 0x26, value: 20}]})]); // first usable list member
    assert.deepEqual(resolver().resolve(50, rig7), {clip: 100, source: 'animatic', field_op: 26 + shift, controller: 20});
    // 2. rooms and actors are never animation rows; the portrait then rests
    set([f(1, portrait(10)), f(26, {tag: 0x26, value: 30}), f(27, {tag: 0x26, value: 40})]);
    assert.deepEqual(resolver().resolve(50, rig7), {clip: 100, source: 'portrait', field_op: 1 + shift, controller: null});
    // 3. off-rig references are rejected at every level
    set([f(26, {tag: 0x26, value: 22})]);
    assert.equal(resolver().resolve(50, rig7), null);
    set([f(26, {tag: 0x26, value: 24})]);
    assert.equal(resolver().resolve(50, rig7), null);
    set([f(1, portrait(13))]);
    assert.equal(resolver().resolve(50, rig7), null);
    // 4. a long catalogue list is not one choice
    set([f(25, {tag: 0x20, values: [20, 21, 20, 21, 20].map((v) => ({tag: 0x26, value: v}))})]);
    assert.equal(resolver().resolve(50, rig7), null);
    // 5. a rig with exactly one clip rests in it
    set([f(3, {tag: 10, value: 1})]);
    assert.deepEqual(resolver().resolve(50, new Set([3])), {clip: 105, source: 'rig_single', field_op: -1, controller: null});
    assert.deepEqual(resolver().resolve(50, new Set([9])), {clip: 103, source: 'rig_single', field_op: -1, controller: null});
  }
  // ---- props: typed attachment records, else parallel mesh/material lists ---
  // mesh definitions 60 (ab5 mesh 600, rig 7) and 61 (ab5 601, rig 9); materials 70 -> texture 700, 71 -> [700, 701]
  const assets2 = {deref: (n) => (n?.tag === 0 ? pool[n.value] : n), fields: () => new Map(),
    meshBySlot: new Map([[60, 600], [61, 601]]), texturesByMaterial: new Map([[70, [700]], [71, [700, 701]]])};
  const meshRig = (mesh) => (mesh === 600 ? 7 : mesh === 601 ? 9 : null);
  const record = (meshSlot, material, extra = []) => ({tag: 0x24, class: 113, fields: [{tag: 0x26, value: meshSlot}, {tag: 2, value: material}, ...extra]});
  const tints = [{tag: 0x15, value: [0.5, 0.5, 0.5, 1]}, {tag: 0x15, value: [0.4, 0.4, 0.4, 1]}, {tag: 0x15, value: [1, 1, 1, 1]}];
  const identityMatrix = {tag: 0x30, value: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]};
  const propResolver = (fields) => { fieldsBySlot.set(20, fields); return new ActorIdleResolver(rows, pool, assets2, animDir, {decode: (slot) => fieldsBySlot.get(slot) ?? null, poolRegistryRefs: () => []}); };
  // controller 20: mesh list, material list, and the typed records (records win, carry tints and matrix)
  let r = propResolver([G(16, {tag: 0x20, values: [{tag: 0x26, value: 60}]}), G(17, {tag: 0x20, values: [{tag: 2, value: 70}]}),
    G(28, {tag: 0x20, values: [record(60, 70, [...tints, identityMatrix])]})]);
  assert.deepEqual(r.props(20, rig7, meshRig), [{mesh_def_slot: 60, mesh: 600, material_slot: 70, texture: 700,
    recolors: [[0.5, 0.5, 0.5, 1], [0.4, 0.4, 0.4, 1], [1, 1, 1, 1]], local_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]}]);
  // parallel lists only: no tints, no matrix
  r = propResolver([G(16, {tag: 0x20, values: [{tag: 0x26, value: 60}]}), G(17, {tag: 0x20, values: [{tag: 2, value: 70}]})]);
  assert.deepEqual(r.props(20, rig7, meshRig), [{mesh_def_slot: 60, mesh: 600, material_slot: 70, texture: 700, recolors: null, local_matrix: null}]);
  // a prop on another rig, a material with two textures, or mismatched list lengths: nothing
  r = propResolver([G(28, {tag: 0x20, values: [record(61, 70, tints)]})]);
  assert.deepEqual(r.props(20, rig7, meshRig), []);
  r = propResolver([G(28, {tag: 0x20, values: [record(60, 71, tints)]})]);
  assert.deepEqual(r.props(20, rig7, meshRig), []);
  r = propResolver([G(16, {tag: 0x20, values: [{tag: 0x26, value: 60}, {tag: 0x26, value: 60}]}), G(17, {tag: 0x20, values: [{tag: 2, value: 70}]})]);
  assert.deepEqual(r.props(20, rig7, meshRig), []);
  assert.deepEqual(r.props(null, rig7, meshRig), []);
  // the resolved idle names its controller: set -> R controller; bare clip record -> none
  fieldsBySlot.set(50, [G(26, {tag: 0x26, value: 23})]);
  assert.equal(resolver().resolve(50, rig7).controller, 21);
  fieldsBySlot.set(50, [G(26, {tag: 0x26, value: 12})]);
  assert.equal(resolver().resolve(50, rig7).controller, null);

  // rig 9 carries exactly one clip: single-clip fallback applies
  fieldsBySlot.set(50, []);
  assert.deepEqual(resolver().resolve(50, new Set([9])), {clip: 103, source: 'rig_single', field_op: -1, controller: null});
  assert.equal(resolver().resolve(50, new Set()), null);

  // ---- pose palettes: rest clip -> identity; a moved root moves vertices ---
  const bones = [
    {parent: -1, scale: [1, 1, 1], quat: [0, 0, 0, 1], trans: [0, 0, 0], bind: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]},
    {parent: 0, scale: [1, 1, 1], quat: [0, 0, 0, 1], trans: [0, 0, 10], bind: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 10]},
  ];
  const restClip = {frames: 1, bones: [{present: false}, {present: false}]};
  const identity = idlePosePalette(bones, restClip);
  assert.equal(identity.length, 24);
  for (const [i, v] of [...identity].entries()) assert.ok(Math.abs(v - [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0][i % 12]) < 1e-6, `identity ${i}`);
  const movedClip = {frames: 1, bones: [{present: true, scale: {mode: 'absent'}, rot: {mode: 'absent'}, trans: {mode: 'const', value: [5, 0, 0]}}, {present: false}]};
  const moved = idlePosePalette(bones, movedClip);
  assert.equal(moved[3], 5); assert.equal(moved[15], 5);   // both bones translate with the root
  const positions = new Float32Array([0, 0, 0, 0, 0, 10]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1]);
  skinVertices(moved, new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0]), new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]), positions, normals, null);
  assert.deepEqual([...positions], [5, 0, 0, 5, 0, 10]);
  assert.deepEqual([...normals], [0, 0, 1, 0, 0, 1]);
  const encoded = encodeIdlePose(moved);
  assert.equal(encoded.bones, 2);
  assert.deepEqual([...b64ToF32(encoded.m)], [...moved]);
  assert.equal(idlePosePalette(bones, {frames: 1, bones: [{present: false}]}), null);  // bone count mismatch
  console.log('actor idle: ok');
} finally {
  await rm(tmp, {recursive: true, force: true});
}
