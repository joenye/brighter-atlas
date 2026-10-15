import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-flourish-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: "export * from './src/viewers/world/effects-flourish.ts';", resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const {FlourishSchedule, HANDBACK_TICKS} = await import(pathToFileURL(file).href);
  const durations = [390, 400];
  const make = (seed = 7) => new FlourishSchedule(seed, [3000, 12000], durations);
  // every play: found again from any later moment within its span, and the same in a fresh schedule
  const a = make(), plays: {start: number; pick: number}[] = [];
  for (let t = 0; t < 2_000_000; t += 50) {
    for (const pick of [0, 1]) {
      const s = a.lastStart(pick, t, 10_000_000);
      if (s !== null && !plays.some((p) => p.start === s)) plays.push({start: s, pick});
    }
  }
  plays.sort((x, y) => x.start - y.start);
  assert(plays.length > 150, `${plays.length} plays`);
  assert(plays[0].start >= 3000 && plays[0].start <= 12000, 'the first wait counts from the start');
  for (let i = 1; i < plays.length; i++) {
    const wait = plays[i].start - (plays[i - 1].start + durations[plays[i - 1].pick] - HANDBACK_TICKS);
    assert(wait >= 3000 && wait <= 12000 && Number.isInteger(wait), `wait ${wait} counts from the hand back`);
  }
  const share = plays.filter((p) => p.pick === 0).length / plays.length;
  assert(share > 0.35 && share < 0.65, `even picks (${share})`);
  const b = make();
  for (const p of plays.slice(0, 40)) assert.equal(b.lastStart(p.pick, p.start + 10, 1000), p.start, 'deterministic');
  // outside its span a play is gone; before the first play there is none
  assert.equal(make().lastStart(0, 100, 1000), null);
  const first = plays[0];
  assert.equal(make().lastStart(first.pick, first.start + 5000, 1000), null);
  // another placement flourishes at its own moments
  const other = make(8);
  assert(plays.slice(0, 10).some((p) => other.lastStart(p.pick, p.start, 0) !== p.start));
  // the clock going back finds the same plays
  assert.equal(a.lastStart(first.pick, first.start + 1, 100), first.start);
  console.log(`Flourishes: ${plays.length} plays, waits from the hand back within the set's bounds, even picks, deterministic per placement`);
} finally { await rm(tmp, {recursive: true, force: true}); }
