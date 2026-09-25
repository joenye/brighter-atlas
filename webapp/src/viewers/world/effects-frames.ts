import type { EffectTransformBinding } from '../../extract/world/effect-transforms.js';
import type { EmitterSim } from './effects-sim.js';
import type { EffectBoneAnimation } from './effects-animation.js';

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

// Express the two independent birth frames relative to the owner; the
// rendering layer applies that common owner frame after simulation. Only the
// position selector can request inverse-bind (skin) cancellation; direction
// always uses the bone. Without inverseBinds the bones are at rest, where that
// cancellation is identity. A missing selector in a rigged system leaves world
// coordinates unchanged, so its relative frame is the inverse owner (including
// translation only for points). null matrices here mean identity, not a
// missing selector.
export function effectBirthFrames(
  binding: EffectTransformBinding, bones: readonly (readonly number[])[],
  inverseOwner: readonly number[], inverseBinds?: readonly (readonly number[])[],
): EffectBirthFrames | null {
  if (!validMatrix(inverseOwner)) return null;
  const resolve = (ref: number | 'root' | null, skin: boolean): readonly number[] | null | undefined => {
    if (ref === 'root') return null;
    if (ref === null) return inverseOwner;
    if (!Number.isInteger(ref) || ref < 0 || !validMatrix(bones[ref])) return undefined;
    if (!skin) return bones[ref];
    if (!inverseBinds) return null;
    return validMatrix(inverseBinds[ref]) ? multiply(bones[ref], inverseBinds[ref]) : undefined;
  };
  const position = resolve(binding.primary, binding.mode === 'skin');
  const direction = resolve(binding.secondary, false);
  return position === undefined || direction === undefined ? null : {position, direction};
}

// Apply rest birth frames to a rigged emitter; the returned setter swaps to
// the animated frames (rest frames when a sample does not resolve) or back.
export function bindRigBirthFrames(
  sim: EmitterSim, binding: EffectTransformBinding, bones: readonly (readonly number[])[],
  inverseOwner: readonly number[],
): ((animation: EffectBoneAnimation | null) => void) | null {
  const frames = effectBirthFrames(binding, bones, inverseOwner);
  if (!frames) return null;
  sim.setBirthFrames(frames.position, frames.direction);
  return animation => {
    if (animation) sim.setBirthFrameSampler(tick =>
      effectBirthFrames(binding, animation.sample(tick), inverseOwner, animation.inverseBinds) || frames);
    else sim.setBirthFrames(frames.position, frames.direction);
  };
}
