// Per-build decode data is produced offline purely from analysis of the game's
// own files, never by inspecting or modifying a running game process or its
// memory. It identifies source values, not distributed textures.
import {PoolDecoder} from './value-pool.js';
import {resolveValue} from './room-metadata.js';
import type {WorldProfile} from './profile.js';
import type {ConstructorRecord} from './replay.js';
import {instanceLookup, validBindingList} from './effect-bindings.js';

export interface EffectSpriteBinding {
  instance: number;
  choices: {start: number; end: number}[];
}
export function validEffectSprites(value: any): value is EffectSpriteBinding[] {
  return validBindingList(value, b => Array.isArray(b.choices) && b.choices.length >= 1 && b.choices.length <= 256
    && b.choices.every((c: any) => c && Number.isSafeInteger(c.start) && c.start >= 0
      && Number.isSafeInteger(c.end) && c.end > c.start && c.end - c.start <= 65536));
}
export function createEffectSpriteReader(bindings: EffectSpriteBinding[] | undefined,
  objects: ConstructorRecord[], bytes: Uint8Array, profile: WorldProfile, pool: any[]) {
  if (bindings !== undefined && !validEffectSprites(bindings)) throw Error('invalid effect sprite bindings');
  const arities = (v: Record<string, number>) => new Map(Object.entries(v).map(([k, n]) => [+k, n]));
  const decodeMaterials = (binding: EffectSpriteBinding): number[] => binding.choices.map(({start, end}) => {
    if (end > bytes.length) throw Error('effect sprite lies outside source data');
    const decoder = new PoolDecoder(bytes.subarray(start, end), arities(profile.class_fields), arities(profile.tag6_fields));
    const node = resolveValue(pool, decoder.value());
    if (decoder.pos !== end - start || node?.tag !== 2 || !Number.isSafeInteger(node.value) || node.value < 0)
      throw Error('invalid effect sprite value');
    return node.value;
  });
  const materialsOf = instanceLookup((bindings ?? []).map(b => [b.instance, decodeMaterials(b)] as const), objects);
  // Choice order is significant. Do not deduplicate repeated materials: each
  // occurrence represents one outcome of the uniform selection.
  return (slot: number): number[] | null => {
    const materials = materialsOf(slot);
    return materials ? [...materials] : null;
  };
}
