// A turning ring (a spawn origin some effects use: Teleport's circle, On fire's rings): each particle is born where
// the ring's point is at its birth, in the plane the shortest turn from +z to the ring's axis gives it. Reference
// points: the game's own placement for these inputs.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-effect-spiral-'));
try {
  const file = path.join(tmp, 'effects-sim.mjs');
  await build({ entryPoints: [path.resolve(import.meta.dirname, '../src/viewers/world/effects-sim.ts')], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error' });
  const { turningRingPoint } = await import(pathToFileURL(file).href);
  const cases: [string, number[], number[], number, number, number, number, number, number[]][] = [
    // name, centre, axis, radius, radius per second, angle (deg), angle per second, t, the game's point
    ['flat ring, start', [0, 100, 1200], [0, 0, 0], 200, 0, 200, 355, 0, [-187.9385, 31.5960, 1200]],
    ['flat ring, half a second', [0, 100, 1200], [0, 0, 0], 200, 0, 200, 355, 300, [190.7434, 160.1412, 1200]],
    ['flat ring, later', [0, 100, 1200], [0, 0, 0], 200, 0, 200, 355, 1234, [-173.0011, -0.3525, 1200]],
    ['upright ring, start', [0, 280, 850], [0, 1, 0], 500, 0, 200, 125, 0, [-469.8463, 280, 1021.0101]],
    ['upright ring, 1150', [0, 280, 850], [0, 1, 0], 500, 0, 200, 125, 1150, [90.4029, 280, 358.2406]],
    ['upright ring, 1600', [0, 280, 850], [0, 1, 0], 500, 0, 200, 125, 1600, [-496.6192, 280, 791.9542]],
    ['upright ring, 2050', [0, 280, 850], [0, 1, 0], 500, 0, 200, 125, 2050, [-25.4413, 280, 1349.3523]],
    ['up axis', [10, 20, 30], [0, 0, 1], 100, 0, 90, 0, 0, [10, 120, 30]],
    ['up axis, not unit length', [10, 20, 30], [0, 0, 5], 100, 0, 30, 60, 300, [60, 106.6025, 30]],
    ['x axis', [0, 0, 0], [1, 0, 0], 100, 0, 0, 90, 600, [0, 100, 0]],
    ['tilted, growing', [5, -5, 7], [1, 1, 1], 50, 25, 10, 45, 900, [1.8837, 58.3711, -53.2548]],
    ['growing radius', [0, 0, 0], [0, 0, 1], 100, 50, 0, 0, 1200, [200, 0, 0]],
  ];
  for (const [name, centre, axis, r0, rr, a0, ar, t, want] of cases) {
    const got = turningRingPoint(centre, axis, r0, rr, a0, ar, t);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i] - want[i]) < 1e-2, `${name}: ${got} against ${want}`);
  }
  // an axis of exactly -z: the game's turn collapses the ring onto its centre
  assert.deepEqual(turningRingPoint([1, 2, 3], [0, 0, -1], 100, 0, 30, 0, 0), [1, 2, 3]);
  assert.deepEqual(turningRingPoint([0, 0, 0], [0, 0, -1], 100, 0, 0, 0, 0), [0, 0, 0]);
  console.log('Effect turning rings: the game\'s points for flat and upright rings, and the collapsed down axis, passed');
} finally { await rm(tmp, { recursive: true, force: true }); }
