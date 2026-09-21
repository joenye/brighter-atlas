import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-transforms-'));
try {
const file = path.join(tmp, 'effect-transforms.mjs');
await build({ entryPoints: [path.resolve(import.meta.dirname, '../src/extract/world/effect-transforms.ts')], bundle: true, platform: 'node', format: 'esm', outfile: file });
const { hasEmitterTimingHeader, inferEffectTransformLayout, readEffectTransformBinding, readEffectRigSelection, readEffectAccelerationFrame, inferEffectAccelerationFrameOp } = await import(pathToFileURL(file).href);
const mark = (op: number) => ({ op, kind: 'symbol', index: 7, name: '$additional_transform' });
const num = (op: number, value: number) => ({ op, kind: 'int', value });
const flag = (op: number, value: boolean) => ({ op, kind: 'other', tag: value ? 12 : 13 });
const timing = [1, 2, 3].map((op) => ({ op, kind: 'duration', ticks: op * 10 }));
const owner = { op: 0, kind: 'scalar', tag: -85, value: 12 };
assert(hasEmitterTimingHeader([owner, ...timing]));
assert(hasEmitterTimingHeader(timing.map(e => ({ ...e, op: e.op + 8 }))));
assert(!hasEmitterTimingHeader([owner, { op: 1, kind: 'ref', slot: 5 }, ...timing]));
assert(!hasEmitterTimingHeader([owner, ...timing.slice(0, 2)]));
assert(!hasEmitterTimingHeader([owner, { op: 1, kind: 'scalar', tag: 0x02, value: 6 }, ...timing]));
for (const start of [3, 9, 22]) {
  const root = [num(start - 1, 1), mark(start), flag(start + 1, false), mark(start + 2)];
  const bone = [num(start - 1, 1), num(start, 6), flag(start + 1, false), mark(start + 2)];
  const skin = [num(start - 1, 1), num(start, 6), flag(start + 1, true), num(start + 2, 4)];
  const layout = inferEffectTransformLayout([root, bone, skin]);
  assert.deepEqual(layout, { primaryOp: start, secondaryOp: start + 2, skinOp: start + 1 });
  assert.equal(readEffectTransformBinding(root, layout)?.primary, 'root');
  assert.equal(readEffectTransformBinding(bone, layout)?.primary, 6);
  assert.equal(readEffectTransformBinding(bone, layout)?.mode, 'bone');
  assert.equal(readEffectTransformBinding(skin, layout)?.mode, 'skin');
  assert.equal(readEffectTransformBinding(skin, layout)?.secondary, 4);
  const pair = [num(start - 1, 1), mark(start), mark(start + 1)];
  const pairLayout = inferEffectTransformLayout([pair]);
  assert.deepEqual(pairLayout, { primaryOp: start, secondaryOp: start + 1, skinOp: null });
  assert.equal(readEffectTransformBinding([num(start, 5), num(start + 1, 2)], pairLayout)?.secondary, 2);
  assert.equal(inferEffectTransformLayout([[num(start - 1, 1), mark(start)]]), null);
  assert.equal(inferEffectTransformLayout([root, pair]), null);
  assert.equal(readEffectTransformBinding([num(start, -1), mark(start + 1)], pairLayout), null);
  const none = (op: number) => ({ op, kind: 'symbol', index: 8, name: '$none' });
  // Adjacent references default all symbols to root. The mode-bearing
  // layout only applies a transform for the explicit root marker.
  assert.equal(readEffectTransformBinding([mark(start), none(start + 1)], pairLayout)?.secondary, 'root');
  assert.equal(readEffectTransformBinding([none(start), none(start + 1)], pairLayout)?.primary, 'root');
  const absent = readEffectTransformBinding([none(start), flag(start + 1, false), none(start + 2)], layout);
  assert.equal(absent?.primary, null);
  assert.equal(absent?.secondary, null);
  const selector = [none(start), flag(start + 1, true), flag(start + 2, false), flag(start + 3, true)];
  assert.deepEqual(readEffectRigSelection(selector), { alternate: true, op: start + 3 });
  assert.deepEqual(readEffectRigSelection([...selector, num(start + 4, 2)]), { alternate: true, op: start + 3 });
  assert.equal(readEffectRigSelection(selector.slice(0, 3)), null);
  assert.equal(readEffectRigSelection([...selector, none(start + 10), flag(start + 11, false), flag(start + 12, false), flag(start + 13, false)]), null);
  const accelerationFlags = [...root, none(start + 3), none(start + 4), flag(start + 5, false), flag(start + 6, false), flag(start + 7, true)];
  assert.deepEqual(readEffectAccelerationFrame(accelerationFlags, layout), {world: true, op: start + 7});
  assert.equal(readEffectAccelerationFrame(accelerationFlags.slice(0, -1), layout), null);
  const accel = {op: start + 12, kind: 'symbol', index: 9, name: '$acceleration0'};
  const defaults = [...pair, accel, flag(start + 13, true)];
  const override = [...pair, num(start + 12, 5), flag(start + 13, false)];
  const accelerationOp = inferEffectAccelerationFrameOp([defaults, override], pairLayout);
  assert.equal(accelerationOp, start + 13);
  assert.deepEqual(readEffectAccelerationFrame(override, pairLayout, accelerationOp), {world: false, op: start + 13});
  assert.equal(readEffectAccelerationFrame(override.slice(0, -1), pairLayout, accelerationOp), null);
  assert.equal(inferEffectAccelerationFrameOp([defaults, [...pair, {...accel, op: start + 20}, flag(start + 21, true)]], pairLayout), null);
  assert.equal(readEffectAccelerationFrame(defaults, pairLayout, null), null);
}
console.log('Effect transform fields: both layouts, shifted schemas, inverse-bind mode, separate references and ambiguous/malformed guards passed');

} finally { await rm(tmp, { recursive: true, force: true }); }
