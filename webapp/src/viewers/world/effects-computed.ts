// A value computed for each particle (effect-sources.ts): its draws, then each axis's polynomial over them, scaled or
// moved on by the particle's number; or tabulated over its draws (a grid, interpolated).
import type {ComputedValue} from '../../extract/world/effect-sources.js';
import type {EffectDrawKey, EffectTabulated} from '../../extract/world/effect-fields.js';
import {wanderUnit} from './effects-wander.js';

/** A draw's fraction for particle number `n`: keyed, the particle's own seeded draw; else `unit()`. */
export function keyedUnit(key: EffectDrawKey | null | undefined, n: number, unit: () => number): number {
  if (!key) return unit();
  const seed = key.period === undefined ? n : key.by === 'cycle' ? Math.floor(n / key.period) : n % key.period;
  return wanderUnit(seed, key.salt);
}

function poly(coef: number[], u: number[]): number {
  let sum = 0;
  for (let k = 0; k < coef.length; k++) {
    if (!coef[k]) continue;
    let term = coef[k];
    for (let i = 0; i < u.length; i++) if (k & (1 << i)) term *= u[i];
    sum += term;
  }
  return sum;
}

/** The value for particle number `n`, its draws taken from `unit` (each a fraction in [0, 1)). */
export function evaluateComputed(c: ComputedValue, n: number, unit: () => number): number[] {
  if (c.grid) return gridPoint(c.grid, Array.from({length: c.draws}, (_, i) => keyedUnit(c.keys?.[i], n, unit)));
  const u = Array.from({length: c.draws}, unit);
  const axes = c.axes ?? [c.coef ?? [0]];
  const per = c.perCount === undefined ? null : (c.axes ? c.perCount as number[][] : [c.perCount as number[]]);
  const factor = c.count && n >= 0 && n < c.count.length ? c.count[n] : 1;
  return axes.map((coef, a) => poly(coef, u) * factor + (per ? n * poly(per[a], u) : 0));
}

/** A tabulated number for particle number `n` (its draws keyed or from `unit`). */
export function tabulatedValue(t: EffectTabulated['tabulated'], n: number, unit: () => number): number {
  return gridPoint({res: t.res, values: [t.values]}, t.res.map((_, i) => keyedUnit(t.keys?.[i], n, unit)))[0];
}

/** A point (or any number of axes) tabulated on a grid over fractions (draw 0 fastest), interpolated multilinearly
 *  at `u`. */
export function gridPoint(grid: {res: number[]; values: number[][]}, u: number[]): number[] {
  const k = grid.res.length;
  const lo: number[] = [], frac: number[] = [];
  for (let i = 0; i < k; i++) {
    const x = Math.min(1, Math.max(0, u[i] ?? 0)) * (grid.res[i] - 1);
    const j = Math.min(Math.floor(x), grid.res[i] - 2);
    lo.push(j); frac.push(x - j);
  }
  const axes = grid.values.length, out = new Array<number>(axes).fill(0);
  for (let corner = 0; corner < 1 << k; corner++) {
    let weight = 1, flat = 0, stride = 1;
    for (let i = 0; i < k; i++) {
      const up = (corner >> i) & 1;
      weight *= up ? frac[i] : 1 - frac[i];
      flat += (lo[i] + up) * stride;
      stride *= grid.res[i];
    }
    if (weight) for (let a = 0; a < axes; a++) out[a] += weight * grid.values[a][flat];
  }
  return out;
}
