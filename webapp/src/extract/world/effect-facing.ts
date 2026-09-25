// Per-build bindings are produced offline purely from analysis of the game's
// own files, never by inspecting or modifying a running game process or its
// memory. These bindings identify fields, not geometry or authored values.
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';
import {effectVec3} from './effect-fields.js';
import {bindingIndex, instanceLookup, validBindingList} from './effect-bindings.js';

const facingModes = ['screen', 'direction_single', 'direction_plus',
  'direction_screen', 'velocity_single', 'velocity_screen'] as const;
export type EffectFacingMode = typeof facingModes[number];
export interface EffectFacingBinding {
  instance: number;
  modeField: number;
  axisField: number | null;
}
export interface EffectFacing {
  mode: EffectFacingMode;
  // Null means unresolved, not a zero vector. Velocity and screen modes do
  // not require this source axis. Preserve zero vectors for their fallbacks.
  axis: [number, number, number] | null;
}
const modes = new Set<string>(facingModes);
export function validEffectFacings(value: any): value is EffectFacingBinding[] {
  return validBindingList(value, b => bindingIndex(b.modeField)
    && (b.axisField === null || bindingIndex(b.axisField)) && b.modeField !== b.axisField);
}
export function createEffectFacingReader(bindings: EffectFacingBinding[] | undefined,
  objects: ConstructorRecord[]) {
  if (bindings !== undefined && !validEffectFacings(bindings)) throw Error('invalid effect facing bindings');
  const bindingOf = instanceLookup((bindings || []).map(b => [b.instance, b] as const), objects);
  return (slot: number, fields: EffectExtra[]): EffectFacing | null => {
    const binding = bindingOf(slot);
    if (!binding) return null;
    const modeField = fields.find(e => e.op === binding.modeField);
    if (modeField?.kind !== 'symbol' || !modeField.name?.startsWith('$')) return null;
    const mode = modeField.name.slice(1) as EffectFacingMode;
    if (!modes.has(mode)) return null;
    const field = binding.axisField === null ? null : fields.find(e => e.op === binding.axisField);
    const axis = mode.startsWith('direction_') ? effectVec3(field ?? undefined) : null;
    return {mode, axis};
  };
}
