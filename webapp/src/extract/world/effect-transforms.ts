import type { EffectExtra } from './effects.js';

// Emitter definitions begin with three timing values after their owner
// backpointer. Actor containers can have the same parent/child topology and
// later timing or material fields, but do not have this inherited header.
export function hasEmitterTimingHeader(ops: EffectExtra[]): boolean {
  const fields = ops.filter((e) => !(e.kind === 'scalar' && e.tag === -85));
  return fields.length >= 3 && fields.slice(0, 3).every((e) => e.kind === 'duration');
}

export interface EffectTransformLayout {
  primaryOp: number;
  secondaryOp: number;
  skinOp: number | null;
}

export interface EffectTransformBinding {
  primary: number | 'root' | null;
  secondary: number | 'root' | null;
  mode: 'bone' | 'skin';
  source: EffectTransformLayout;
}

export interface EffectRigSelection { alternate: boolean; op: number }
export interface EffectAccelerationFrame { world: boolean; op: number }

// Two supported emitter layouts expose this flag differently. Require the
// surrounding field pattern instead of assuming a fixed operation number.
export function readEffectAccelerationFrame(
  ops: EffectExtra[], layout: EffectTransformLayout | null, familyOp?: number | null,
): EffectAccelerationFrame | null {
  if (!layout || familyOp === null) return null;
  const byOp = new Map(ops.map(e => [e.op, e]));
  if (familyOp != null) {
    const flag = byOp.get(familyOp);
    return boolean(flag) ? {world: isTrue(flag), op: familyOp} : null;
  }
  let flags: EffectExtra[] = [];
  if (layout.skinOp !== null) {
    const start = layout.secondaryOp;
    if (reference(byOp.get(start + 1)) && reference(byOp.get(start + 2))
      && [3, 4, 5].every(n => boolean(byOp.get(start + n)))) {
      flags = [byOp.get(start + 5)!];
    }
  } else {
    flags = ops.filter(e => {
      const prev = byOp.get(e.op - 1);
      return boolean(e) && prev?.kind === 'symbol' && prev.name === '$acceleration0';
    });
  }
  return flags.length === 1 ? { world: isTrue(flags[0]), op: flags[0].op } : null;
}

export function inferEffectAccelerationFrameOp(
  rows: Iterable<EffectExtra[]>, layout: EffectTransformLayout | null,
): number | null {
  const candidates = new Set<number>();
  for (const row of rows) {
    const flag = readEffectAccelerationFrame(row, layout);
    if (flag) candidates.add(flag.op);
  }
  return candidates.size === 1 ? candidates.values().next().value! : null;
}

// The inherited rig selector follows a symbol and three consecutive flags.
// Extended system types may append fields, so do not assume it ends the row.
export function readEffectRigSelection(ops: EffectExtra[]): EffectRigSelection | null {
  const candidates: EffectRigSelection[] = [];
  for (let i = 0; i + 3 < ops.length; i++) {
    const [a, b, c, d] = ops.slice(i, i + 4);
    if (a.kind === 'symbol' && boolean(b) && boolean(c) && boolean(d)
      && b.op === a.op + 1 && c.op === b.op + 1 && d.op === c.op + 1) {
      candidates.push({ alternate: isTrue(d), op: d.op });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

const marker = (e: EffectExtra | undefined): boolean =>
  e?.kind === 'symbol' && e.name === '$additional_transform';
const reference = (e: EffectExtra | undefined): boolean =>
  e?.kind === 'symbol' || (e?.kind === 'int' && Number.isInteger(e.value) && e.value >= 0);
const boolean = (e: EffectExtra | undefined): boolean =>
  e?.kind === 'other' && (e.tag === 0x0c || e.tag === 0x0d);
const isTrue = (e: EffectExtra | null | undefined): boolean => e?.kind === 'other' && e.tag === 0x0c;

// Infer one layout from the family's complete field patterns. A number next
// to a marker is insufficient: configuration flags can occupy that position.
// The two supported shapes are reference/boolean/reference and two adjacent
// references. The latter needs a row containing both marker defaults.
export function inferEffectTransformLayout(rows: Iterable<EffectExtra[]>): EffectTransformLayout | null {
  const candidates = new Map<string, EffectTransformLayout>();
  for (const ops of rows) {
    for (let i = 0; i < ops.length; i++) {
      const a = ops[i], b = ops[i + 1], c = ops[i + 2];
      let layout: EffectTransformLayout | null = null;
      if (reference(a) && boolean(b) && reference(c)
        && (marker(a) || marker(c)) && b.op === a.op + 1 && c.op === b.op + 1) {
        layout = { primaryOp: a.op, secondaryOp: c.op, skinOp: b.op };
      } else if (marker(a) && marker(b) && b.op === a.op + 1) {
        layout = { primaryOp: a.op, secondaryOp: b.op, skinOp: null };
      }
      if (layout) candidates.set(JSON.stringify(layout), layout);
    }
  }
  return candidates.size === 1 ? candidates.values().next().value! : null;
}

export function readEffectTransformBinding(
  ops: EffectExtra[], layout: EffectTransformLayout | null,
): EffectTransformBinding | null {
  if (!layout) return null;
  const byOp = new Map(ops.map((e) => [e.op, e]));
  const a = byOp.get(layout.primaryOp), b = byOp.get(layout.secondaryOp);
  const flag = layout.skinOp === null ? null : byOp.get(layout.skinOp);
  if (!reference(a) || !reference(b) || (layout.skinOp !== null && !boolean(flag ?? undefined))) return null;
  const value = (e: EffectExtra | undefined): number | 'root' | null =>
    e?.kind === 'int' ? e.value : layout.skinOp === null || marker(e) ? 'root' : null;
  return { primary: value(a), secondary: value(b),
    mode: isTrue(flag) ? 'skin' : 'bone', source: layout };
}
