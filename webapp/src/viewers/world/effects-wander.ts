// A source that wanders: each batch of `period` particles spawns about one seeded spot, along a tilted streak. The
// game draws every value from a seeded hash of the particle's number (its batch, n / period, or its place in the
// batch, n % period) and a salt, so the same particle always lands in the same place. Each value is a multilinear
// polynomial over those draws (the per-build decode data names the draws; the record's own numbers are already in
// the coefficients): coefficient k belongs to the product of the draws whose bits are set in k.

import type {WanderShapeValues, WanderValue} from '../../extract/world/effect-origins.js';

/** The game's seeded hash of two words. */
export function wanderHash(a: number, b: number): number {
  let h = a | 0;
  h = (h + (h << 10)) | 0; h ^= h >>> 6;
  h = (h + b) | 0;
  h = (h + (h << 10)) | 0; h ^= h >>> 6;
  h = Math.imul(h, 9);
  h ^= h >>> 11;
  h = (h + (h << 15)) | 0;
  return h >>> 0;
}
/** A uniform draw in [0, 1) from the hash, as the game makes it (24 bits). */
export function wanderUnit(seed: number, salt: number): number {
  return Math.fround((wanderHash(seed, salt) & 0xffffff) * Math.fround(1 / 16777216));
}

function value(v: WanderValue, cycle: number, index: number): number {
  const u = v.draws.map(([kind, salt]) => wanderUnit(kind === 'cycle' ? cycle : index, salt));
  let sum = 0;
  for (let k = 0; k < v.coef.length; k++) {
    if (!v.coef[k]) continue;
    let term = v.coef[k];
    for (let i = 0; i < u.length; i++) if (k & (1 << i)) term *= u[i];
    sum += term;
  }
  return sum;
}

const DEG = Math.PI / 180;
/** Particle `n`'s offset from the shape's centre. */
export function wanderPoint(shape: WanderShapeValues, n: number): [number, number, number] {
  const cycle = Math.trunc(n / shape.period), index = n - cycle * shape.period;
  const a = value(shape.angle, cycle, index) * DEG, t = value(shape.tilt, cycle, index) * DEG;
  const amp = value(shape.amp, cycle, index), radius = value(shape.base, cycle, index) + amp * Math.cos(t);
  return [radius * Math.cos(a), radius * Math.sin(a), value(shape.height, cycle, index) + amp * Math.sin(t)];
}
