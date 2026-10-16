// Bursts that emit only while a quest variable is in some of its states (weather that stops at a point in a story),
// from per-build decode data, which is produced offline purely from analysis of the game's own files, never by
// inspecting or modifying a running game process or its memory: per burst, the variable's record, the positions of
// the states it emits in and the variable's state count. Kept apart.
import type {ConstructorRecord} from './replay.js';
import {instanceLookup, validBindingList} from './effect-bindings.js';

export interface EffectGate { variable: number; emits: number[]; states: number }
export interface EffectGateBinding extends EffectGate { instance: number }

export function validEffectBurstGates(v: any): v is EffectGateBinding[] {
  return validBindingList(v, b => Number.isInteger(b.variable) && b.variable >= 0 && b.variable < 2 ** 24
    && Number.isInteger(b.states) && b.states >= 1 && b.states <= 4096
    && Array.isArray(b.emits) && b.emits.length <= b.states
    && b.emits.every((n: any) => Number.isInteger(n) && n >= 0 && n < b.states));
}

export function createEffectGateReader(gates: EffectGateBinding[] | undefined, objects: ConstructorRecord[]) {
  if (gates !== undefined && !validEffectBurstGates(gates)) throw Error('invalid effect burst gate bindings');
  const gateOf = instanceLookup((gates || []).map(b => [b.instance, b] as const), objects);
  return (slot: number): EffectGate | null => {
    const b = gateOf(slot);
    return b ? {variable: b.variable, emits: [...b.emits], states: b.states} : null;
  };
}

/** Whether a gated burst emits with its variable at `position` (null: the story's end, as the views show a story by
 *  default). */
export function gateOpen(gate: EffectGate, position: number | null): boolean {
  return gate.emits.includes(position ?? gate.states - 1);
}
