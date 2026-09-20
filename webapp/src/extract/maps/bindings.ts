// Bindings select values from the user's bundle. Their offsets come from
// per-build decode data produced offline, purely from analysis of the game's
// own files; no running game process or its memory is inspected or modified.
import {PoolDecoder, type PoolNode} from '../world/value-pool.js';
import {makeRegistryRowDecoder} from '../world/effects.js';
import {resolveValue} from '../world/room-metadata.js';
import type {WorldProfile} from '../world/profile.js';
import type {FillRow} from '../world/replay.js';

export interface MapBinding {offset: number; tag: number}

export function decodeMapBinding(
  bytes: Uint8Array, pool: PoolNode[], profile: WorldProfile, binding: MapBinding,
): PoolNode {
  if (!Number.isInteger(binding.offset) || binding.offset < 0 || binding.offset >= bytes.length) {
    throw Error('map binding is outside the data bundle');
  }
  const arities = (values: Record<string, number>) => new Map(Object.entries(values).map(([k, v]) => [+k, v]));
  const decoder = new PoolDecoder(bytes, arities(profile.class_fields), arities(profile.tag6_fields));
  decoder.pos = binding.offset;
  const node = resolveValue(pool, decoder.value());
  if (!node || node.tag !== binding.tag) throw Error('map binding has an unexpected value type');
  return node;
}

export function decodeMapStyleDefaults(
  rows: FillRow[], pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile, binding: MapBinding,
): Map<number, number> {
  const dictionary = decodeMapBinding(bytes, pool, profile, binding);
  if (dictionary.tag !== 0x1c || !Number.isInteger(dictionary.value)
    || dictionary.value < 0 || dictionary.value >= profile.stream.object_count) {
    throw Error('invalid map style dictionary');
  }
  const reader = new PoolDecoder(bytes, new Map(), new Map());
  reader.pos = profile.stream.constructor_end;
  let keys: number[] = [], slots: number[] = [];
  for (let i = 0; i <= dictionary.value; i++) {
    const count = reader.varint();
    if (count > rows.length) throw Error('invalid map dictionary size');
    keys = Array.from({length: count}, () => reader.varint());
    slots = Array.from({length: count}, () => reader.varint());
    if (new Set(keys).size !== count || slots.some(slot => !rows[slot])) throw Error('invalid map dictionary entries');
  }
  const decode = makeRegistryRowDecoder(rows, bytes, profile), defaults = new Map<number, number>();
  for (let i = 0; i < keys.length; i++) {
    const colors = (decode(slots[i]) ?? []).flatMap(op => {
      const n = op.kind === 'G' ? resolveValue(pool, op.node) : null;
      return n?.tag === 10 ? [n.value] : [];
    });
    if (colors.length !== 1 || !Number.isInteger(colors[0]) || colors[0] < 0 || colors[0] > 0x7fff) {
      throw Error(`invalid map style color for key ${keys[i]}`);
    }
    defaults.set(keys[i], colors[0]);
  }
  return defaults;
}
