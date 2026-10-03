// A particle's waves: per world axis, (a1 + (a2 - a1) * life fraction) * sin(6.282 * (age / period + phase)), the
// period in ticks and the phase a byte's fraction of a cycle, as the particle shader computes it; the default slot
// (period 1, no amplitude) is still. Examples from the game's own effects.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-wave-slots-'));
try {
  const file = path.join(tmp, 'effects-sim.mjs');
  await build({ entryPoints: [path.resolve(import.meta.dirname, '../src/viewers/world/effects-sim.ts')], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error' });
  const { waveOffset } = await import(pathToFileURL(file).href);
  const close = (a: number, b: number, m: string) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} against ${b}`);
  // a bob of 50 units once a second, phase 0.9 (a byte of 229)
  const bob = { period: 600, a1: 50, a2: 50, phase: 229 / 255 };
  close(waveOffset(bob, 0, 0), 50 * Math.sin(6.282 * 229 / 255), 'bob at birth');
  close(waveOffset(bob, 150, 0.25), 50 * Math.sin(6.282 * (0.25 + 229 / 255)), 'bob a quarter period on');
  // an amplitude that decays over the life: 350 at birth to 50 at death
  const decay = { period: 1200, a1: 350, a2: 50, phase: 178 / 255 };
  close(waveOffset(decay, 300, 0.5), 200 * Math.sin(6.282 * (0.25 + 178 / 255)), 'decaying at half life');
  // the default slot is still
  close(waveOffset({ period: 1, a1: 0, a2: 0, phase: 0 }, 77, 0.3), 0, 'default slot');
  close(waveOffset({ period: 0, a1: 10, a2: 10, phase: 0 }, 77, 0.3), 0, 'no period');
  console.log('Effect wave slots: bob, decaying amplitude and still slots passed');
} finally { await rm(tmp, { recursive: true, force: true }); }
