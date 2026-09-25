// Optional per-build decode data is produced offline purely from analysis of
// the game's own files, never by inspecting or modifying a running game
// process or its memory. Authored sizes remain in the user's bundle.
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';
import {effectRange, effectScalar} from './effect-fields.js';
import {bindingIndex, instanceLookup, validBindingList} from './effect-bindings.js';
export interface EffectScaleBinding {
  instance: number; start: number; end: number; rangeClass: number;
}
export type EffectScaleValue = number | [number, number];
export interface EffectScales {start: EffectScaleValue; end: EffectScaleValue | 'start'}
export function validEffectScales(value: any): value is EffectScaleBinding[] {
  return validBindingList(value,b=>[b.start,b.end,b.rangeClass].every(bindingIndex)&&b.start!==b.end);
}
export function createEffectScaleReader(bindings: EffectScaleBinding[] | undefined, objects: ConstructorRecord[]) {
  if(bindings!==undefined&&!validEffectScales(bindings))throw Error('invalid effect scale bindings');
  const bindingOf=instanceLookup((bindings??[]).map(b=>[b.instance,b] as const),objects);
  return (slot:number,fields:EffectExtra[]):EffectScales|null=>{
    const binding=bindingOf(slot);if(!binding)return null;
    const read=(e:EffectExtra|undefined):EffectScaleValue|null=>effectScalar(e)??effectRange(e,binding.rangeClass);
    const start=read(fields.find(f=>f.op===binding.start));
    const last=fields.find(f=>f.op===binding.end);
    const end=last?.kind==='symbol'&&last.name==='$scale0'?'start':read(last);
    return start!==null&&end!==null?{start,end}:null;
  };
}
