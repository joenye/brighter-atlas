/** Stateful random draws for authored particle ranges. The preview supplies
 * its own seed; cross-emitter stream ownership is handled separately. */
export class EffectRandom {
  state: bigint;
  constructor(seed: bigint) { this.state = seed; }
  integer(bound: number): number {
    if (!Number.isInteger(bound) || bound < 1 || bound > 2147483647) throw Error('invalid random bound');
    for (;;) {
      this.state = (this.state * 0x5deece66dn + 11n) & ((1n << 48n) - 1n);
      const bits = Number(this.state >> 17n);
      if ((bound & (bound - 1)) === 0) return Math.floor(bound * bits / 2147483648);
      const value = bits % bound;
      if (bits - value + bound - 1 < 2147483648) return value;
    }
  }
  range(start: number, end: number): number {
    const f = Math.fround;
    const fraction = this.integer(16777217) / 16777216;
    return f(f(start) + f(f(f(end) - f(start)) * fraction));
  }
}
