import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-playback-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export {EffectsPlayer} from './src/viewers/world/effects-player.ts'; export {PlaybackBar} from './src/viewers/rig.ts'; export * from './vendor/three.module.js';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const T = await import(pathToFileURL(file).href);
  const system = {slot: 1, loop: true, triggered: true, names: [], clips: [9], emitters: [{
    life: {ticks: 1000}, burst: 1, sprite: {images: [-1]},
    scale0: {value: 1}, scale1: {value: 5}, angular_speed: {value: 90},
  }]};
  const doc = {tick_rate: {value: 600}, systems: [system], configs: {1: {kind: 'burst_windowed', per_second: 600, windows: [[0,0]]}}};
  const root = new T.Group();
  const player = new T.EffectsPlayer({root, doc, url: (s: string) => s});
  const snapshot = () => {
    const rows: unknown[] = [];
    root.traverse((o: any) => {
      if (!o.geometry?.attributes.aPosSize) return;
      const g = o.geometry, n = g.instanceCount;
      rows.push({n, pos: [...g.attributes.aPosSize.array.slice(0,n*4)],
        color: [...g.attributes.aColor.array.slice(0,n*4)], rot: [...g.attributes.aRot.array.slice(0,n)]});
    });
    return rows;
  };
  try {
    assert.equal(player.addSystem(1), 'timed', 'looping action effects must wait for activation');
    player.setClock(8000);
    assert.equal(player.liveCount(), 0, 'an action effect does not start with the ambient effects');
    player.syncClock(1, 120);
    const at120 = snapshot();
    assert.equal(player.liveCount(), 1);
    player.unslave(1);
    player.tick(2000);
    assert.deepEqual(snapshot(), at120, 'releasing the external clock freezes the rendered particles');
    player.setClock(0);
    assert.deepEqual(snapshot(), at120, 'master seeking does not move a frozen effect');
    player.syncClock(1, 300);
    assert.notDeepEqual(snapshot(), at120, 'external seek advances the frozen effect');
    player.syncClock(1, 120);
    assert.deepEqual(snapshot(), at120, 'backward seek reproduces the same render buffers');
    player.play(1);
    player.tick(200);
    assert.deepEqual(snapshot(), at120, 'standalone replay resumes with its own local origin');
    player.stop(1);
    assert.equal(player.liveCount(), 0, 'switching clips clears the outgoing particles immediately');
    player.tick(200);
    assert.equal(player.liveCount(), 0, 'stopped systems remain inactive');
    player.syncClock(1, 120);
    assert.deepEqual(snapshot(), at120, 'a stopped system can be replayed deterministically');
  } finally { player.dispose(); }

  // Exercise real clip loading with controlled completion order, without DOM.
  const pending = new Map<string, {resolve: (v: any) => void; reject: (e: Error) => void}>();
  const errors: string[] = [];
  const bar = Object.create(T.PlaybackBar.prototype);
  Object.assign(bar, {_loadGeneration: 0, _destroyed: false, t: 0, speed: 1, loop: false,
    playBtn: {}, scrub: {}, timeLbl: {}, rig: {bones: [], resetToRest() {}},
    onError: (s: string) => errors.push(s),
    store: {payload: (f: string) => new Promise((resolve, reject) => pending.set(f, {resolve, reject}))}});
  const entry = (i: number) => ({i, f: `clip-${i}.json`});
  const clip = (i: number) => ({i, skel: 1, bones: [], duration_ms: 1000, frame_ms: 20, frames: 51});
  const finish = (i: number) => pending.get(entry(i).f)!.resolve(clip(i));
  const first = bar.loadClip(entry(1)), second = bar.loadClip(entry(2));
  finish(2); assert.equal(await second, true);
  bar.t = 250; bar.pause();
  finish(1); assert.equal(await first, false);
  assert.equal(bar.clipJson.i, 2, 'a late response must not replace the selected clip');
  assert.equal(bar.t, 250); assert.equal(bar.playing, false);
  const cleared = bar.loadClip(entry(3)); bar.clearClip(); finish(3);
  assert.equal(await cleared, false); assert.equal(bar.clipJson, null); assert.equal(bar.playing, false);
  const failed = bar.loadClip(entry(4)), current = bar.loadClip(entry(5));
  pending.get(entry(4).f)!.reject(new Error('stale request'));
  assert.equal(await failed, false); assert.deepEqual(errors, []);
  finish(5); assert.equal(await current, true);
  const broken = bar.loadClip(entry(6)); pending.get(entry(6).f)!.reject(new Error('current request'));
  assert.equal(await broken, false); assert.equal(errors.length, 1);
  const disposed = bar.loadClip(entry(7)); bar.destroy(); finish(7);
  assert.equal(await disposed, false); assert.equal(bar.clipJson.i, 5); assert.equal(bar.playing, false);
  assert.equal(await bar.loadClip(entry(8)), false, 'disposed transport cannot restart loading');
  console.log('Effect playback: frozen render buffers, seek/replay, stop, and stale/failed/disposed clip loads passed');
} finally { await rm(tmp, {recursive: true, force: true}); }
