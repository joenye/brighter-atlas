import type { EffectTransformBinding } from '../../extract/world/effect-transforms.js';

export interface EffectBirthFrames {
  position: readonly number[] | null;
  direction: readonly number[] | null;
}

const validMatrix = (m: readonly number[] | undefined) => m?.length === 16 && m.every(Number.isFinite);

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
      + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

// Posed bones and inverse binds are in the owner's local coordinate system.
// Only the position selector can request inverse-bind cancellation. Direction
// selectors always use the posed bone, even when position uses the skin frame.
export function animatedEffectBirthFrames(
  binding: EffectTransformBinding, posedBones: readonly (readonly number[])[],
  inverseBinds: readonly (readonly number[])[], inverseOwner: readonly number[],
): EffectBirthFrames | null {
  if (!validMatrix(inverseOwner)) return null;
  const resolve = (ref: number | 'root' | null, skin: boolean): readonly number[] | null | undefined => {
    if (ref === 'root') return null;
    if (ref === null) return inverseOwner;
    if (!Number.isInteger(ref) || ref < 0 || !validMatrix(posedBones[ref])) return undefined;
    if (!skin) return posedBones[ref];
    if (!validMatrix(inverseBinds[ref])) return undefined;
    return multiply(posedBones[ref], inverseBinds[ref]);
  };
  const position = resolve(binding.primary, binding.mode === 'skin');
  const direction = resolve(binding.secondary, false);
  return position === undefined || direction === undefined ? null : {position, direction};
}

// Express the two independent birth frames relative to the owner. The
// rendering layer applies that common owner frame after simulation.
// At rest, inverse-bind mode cancels the bone's stored world matrix.
// A missing selector in a rigged system leaves world coordinates unchanged,
// so its relative frame is the inverse owner (including translation only
// for points). null matrices here mean identity, not a missing selector.
export function restEffectBirthFrames(
  binding: EffectTransformBinding, bones: readonly (readonly number[])[],
  inverseOwner: readonly number[],
): EffectBirthFrames | null {
  if (!validMatrix(inverseOwner)) return null;
  const resolve = (ref: number | 'root' | null, skin: boolean): readonly number[] | null | undefined => {
    if (ref === 'root') return null;
    if (ref === null) return inverseOwner;
    if (!Number.isInteger(ref) || ref < 0 || !validMatrix(bones[ref])) return undefined;
    return skin ? null : bones[ref];
  };
  const position = resolve(binding.primary, binding.mode === 'skin');
  const direction = resolve(binding.secondary, false);
  return position === undefined || direction === undefined ? null : { position, direction };
}
