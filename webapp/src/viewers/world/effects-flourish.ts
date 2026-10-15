// A resting set's flourishes, scheduled as the game plays them: the set rests in its loop and, after a wait drawn as
// a whole number of ticks evenly between the set's two bounds, plays one of its flourishes, picked evenly (repeats
// allowed), once. The wait counts from the hand back, when the flourish has HANDBACK_TICKS left to play. Each
// placement keeps its own schedule (seeded by where it is), so placements of one set do not flourish together.
import { hash32 } from './effects-sim.js';

/** Ticks before a flourish ends at which the rest loop takes over again (the wait counts from there). */
export const HANDBACK_TICKS = 150;
/** Plays kept before the list starts again (a clock run for days). */
const MAX_PLAYS = 4096;

export class FlourishSchedule {
  private readonly starts: number[] = [];
  private readonly picks: number[] = [];
  private next = 0;   // the start of the play after the last one generated

  /** `durations`: each flourish's length in ticks, in the set's order. */
  constructor(private readonly seed: number, private readonly wait: [number, number],
    private readonly durations: number[]) {}

  private unit(index: number, salt: number): number {
    return hash32(hash32(this.seed, index), salt) / 4294967296;
  }

  private waitAt(index: number): number {
    const [lo, hi] = this.wait;
    return lo + Math.min(hi - lo, Math.floor(this.unit(index, 1) * (hi - lo + 1)));
  }

  private generateTo(t: number): void {
    if (this.starts.length >= MAX_PLAYS) { this.starts.length = 0; this.picks.length = 0; this.next = 0; }
    if (!this.starts.length && this.next === 0) this.next = this.waitAt(0);
    while (this.next <= t && this.starts.length < MAX_PLAYS) {
      const index = this.starts.length;
      const pick = Math.min(this.durations.length - 1, Math.floor(this.unit(index, 2) * this.durations.length));
      this.starts.push(this.next);
      this.picks.push(pick);
      this.next += Math.max(0, this.durations[pick] - HANDBACK_TICKS) + this.waitAt(index + 1);
    }
  }

  /** The start of flourish `pick`'s latest play at or before `t` within `span` ticks (its particles may still be
   *  out), else null. */
  lastStart(pick: number, t: number, span: number): number | null {
    if (!(t >= 0) || !this.durations.length) return null;
    this.generateTo(t);
    let lo = 0, hi = this.starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.starts[mid] <= t) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1; i >= 0 && this.starts[i] >= t - span; i--) if (this.picks[i] === pick) return this.starts[i];
    return null;
  }
}
