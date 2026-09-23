// Per-build bindings are produced offline purely from analysis of the game's
// own files, never by inspecting or modifying a running game process or its
// memory. These bindings identify fields, not geometry or authored values.
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';

export type EffectFacingMode = 'screen' | 'direction_single' | 'direction_plus'
  | 'direction_screen' | 'velocity_single' | 'velocity_screen';
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
const modes = new Set<EffectFacingMode>(['screen', 'direction_single', 'direction_plus',
  'direction_screen', 'velocity_single', 'velocity_screen']);
export function validEffectFacings(value: any): value is EffectFacingBinding[] {
  const index = (v: any) => Number.isInteger(v) && v >= 0 && v < 65536;
  return Array.isArray(value) && value.length <= 65536 && value.every(b => b
    && index(b.instance) && index(b.modeField) && (b.axisField === null || index(b.axisField))
    && b.modeField !== b.axisField)
    && new Set(value.map(b => b.instance)).size === value.length;
}
export function createEffectFacingReader(bindings: EffectFacingBinding[] | undefined,
  objects: ConstructorRecord[]) {
  if (bindings !== undefined && !validEffectFacings(bindings)) throw Error('invalid effect facing bindings');
  const byInstance = new Map((bindings || []).map(b => [b.instance, b]));
  return (slot: number, fields: EffectExtra[]): EffectFacing | null => {
    const binding = byInstance.get(objects[slot]?.values[1]);
    if (!binding) return null;
    const modeField = fields.find(e => e.op === binding.modeField);
    if (modeField?.kind !== 'symbol' || !modeField.name?.startsWith('$')) return null;
    const mode = modeField.name.slice(1) as EffectFacingMode;
    if (!modes.has(mode)) return null;
    const field = binding.axisField === null ? null : fields.find(e => e.op === binding.axisField);
    const axis = mode.startsWith('direction_') && field?.kind === 'vec3'
      && field.v.length === 3 && field.v.every(Number.isFinite) ? [...field.v] as [number, number, number] : null;
    return {mode, axis};
  };
}
