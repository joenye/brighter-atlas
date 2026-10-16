// A value computed for each particle (effect-sources.ts): its draws, then each axis's polynomial over them, scaled or
// moved on by the particle's number.
import type {ComputedValue} from '../../extract/world/effect-sources.js';

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
  const u = Array.from({length: c.draws}, unit);
  const axes = c.axes ?? [c.coef ?? [0]];
  const per = c.perCount === undefined ? null : (c.axes ? c.perCount as number[][] : [c.perCount as number[]]);
  const factor = c.count && n >= 0 && n < c.count.length ? c.count[n] : 1;
  return axes.map((coef, a) => poly(coef, u) * factor + (per ? n * poly(per[a], u) : 0));
}
