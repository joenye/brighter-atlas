// Brighter Fashion's place: every pose reaches the GPU. The game frame sends an actor's bone palette only when it is
// handed a palette it has not sent (a resting actor hands back the same one); Fashion poses its character and the
// scene's actors in arrays it fills in place, so each must hand the frame a fresh view. When it did not, every
// figure, creature and the character stood frozen in their first pose. Runs Fashion's own palette sources (the
// character's and a scene actor's) through the frame's own upload step on a stand-in GL context.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-fashion-poses-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({ stdin: { contents: "export { GameRoom } from './src/fashion/gameroom.ts'; export { GameFrame } from './src/viewers/world/game-frame.ts'; export * as THREE from './vendor/three.module.js';",
    resolveDir: path.resolve(import.meta.dirname, '..') }, bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error' });
  const { GameRoom, GameFrame, THREE } = await import(pathToFileURL(file).href);
  // (every mesh skinned; nothing else is fetched)
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({ skinned: true }) });

  // a frame that records the actor draws it is asked to build, and counts the palettes it sends
  let sent = 0;
  const frame: any = {
    index: { materials: { 7: {} } }, gl: { collect: null }, actorDraws: [], freeDraws() {},
    async buildActorDraw(a: any) { return { bones: { texture: { texture: null, width: 1, height: 1 }, actor: a, data: new Float32Array(a.bones * 12), live: false } }; },
  };
  const gl = { TEXTURE_2D: 0, RGBA: 0, FLOAT: 0, bindTexture() {}, texSubImage2D() { sent++; } };
  const upload = () => GameFrame.prototype['updateActors'].call({ context: gl, actorsMoved: false }, { actorDraws: frame.actorDraws });
  const BONES = 2;

  // the character: setActors, then a pose a frame, the bones moving
  const room: any = { actorGen: 0, palette: new Float32Array(0), paletteLive: false, frame, actorBuffers: [], extraDraws: [], skin: new THREE.Matrix4() };
  const bone = { matrixWorld: new THREE.Matrix4() }, rig = { bones: [bone, { matrixWorld: new THREE.Matrix4() }], boneInverses: [new THREE.Matrix4(), new THREE.Matrix4()] };
  await GameRoom.prototype.setActors.call(room, [{ key: 'a', mesh: 1, mat: null, t1: [1, 1, 1], t2: [1, 1, 1], material: 7 }], rig);
  assert.equal(frame.actorDraws.length, 1, 'the character has its draw');
  for (let k = 1; k <= 3; k++) {
    bone.matrixWorld.makeTranslation(k, 0, 0);
    GameRoom.prototype.pose.call(room, rig, new THREE.Matrix4());
    upload();
  }
  assert.equal(sent, 3, `the character: each frame's pose sent (${sent} of 3)`);

  // a scene's actor (a figure, a creature): its own palette, filled in place as it steps
  const actor = { ready: true, palette: new Float32Array(BONES * 12), step(k: number) { this.palette.fill(k); } };
  const scene: any = { frame, extras: [], extraBuffers: [] };
  frame.actorDraws = [];
  await GameRoom.prototype['addActor'].call(scene, actor, [{ mesh: 2, material: 7, renderTexture: -1, recolours: null }], BONES);
  assert.equal(frame.actorDraws.length, 1, 'the scene actor has its draw');
  sent = 0;
  for (let k = 1; k <= 3; k++) { actor.step(k); upload(); }
  assert.equal(sent, 3, `a scene actor: each step's pose sent (${sent} of 3)`);
  assert.equal(frame.actorDraws[0].bones.data[0], 3, 'the pose sent is the latest');
  console.log('fashion poses: 5 checks');
} finally {
  await rm(tmp, { recursive: true, force: true });
}
