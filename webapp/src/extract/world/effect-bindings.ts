// Shared checks for the effect bindings in per-build decode data, which is
// produced offline purely from analysis of the game's own files, never by
// inspecting or modifying a running game process or its memory.
import type {ConstructorRecord} from './replay.js';

/** A field or instance number in per-build decode data. */
export const bindingIndex = (v: any): boolean => Number.isInteger(v) && v >= 0 && v < 65536;

/** A bounded binding list with one entry per instance, each accepted by `each`. */
export const validBindingList = (v: any, each: (b: any) => boolean): boolean =>
  Array.isArray(v) && v.length <= 65536 && v.every(b => b && bindingIndex(b.instance) && each(b))
  && new Set(v.map(b => b.instance)).size === v.length;

/** The entry bound to a registry slot's instance. */
export function instanceLookup<T>(entries: Iterable<readonly [number, T]>, objects: ConstructorRecord[]) {
  const byInstance = new Map(entries);
  return (slot: number): T | undefined => byInstance.get(objects[slot]?.values[1]);
}
