// Bindings select values from the user's bundle. Their offsets come from
// per-build decode data produced offline, purely from analysis of the game's
// own files; no running game process or its memory is inspected or modified.
import {PoolDecoder, type PoolNode} from '../world/value-pool.js';
import {resolveValue} from '../world/room-metadata.js';
import type {WorldProfile} from '../world/profile.js';

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

// Some builds keep the compiled annotations in a room-keyed table outside the
// rooms (found by shape, map-shape.ts). Its keys precede its values; the room's
// own list then contains providers.
export function decodeMapAnnotationTable(
  bytes: Uint8Array, pool: PoolNode[], profile: WorldProfile, binding: MapBinding,
): Map<number, PoolNode[]> {
  const table=decodeMapBinding(bytes,pool,profile,binding);
  if(table.tag!==44||!table.values||table.values.length%2)throw Error('invalid map annotation table');
  const count=table.values.length/2,result=new Map<number,PoolNode[]>();
  for(let i=0;i<count;i++){
    const key=resolveValue(pool,table.values[i]),value=resolveValue(pool,table.values[count+i]);
    if(key?.tag!==38||!Number.isInteger(key.value)||key.value<0||key.value>=profile.stream.object_count
      ||result.has(key.value)||value?.tag!==32||!value.values)throw Error('invalid room annotation entry');
    result.set(key.value,value.values);
  }
  return result;
}
