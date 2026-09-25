// Per-build decode data is produced offline purely from analysis of the game's
// own files, never by inspecting or modifying a running game process or its
// memory. Bindings identify fields; timings remain in the user's bundle.
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';
import {bindingIndex, instanceLookup, validBindingList} from './effect-bindings.js';
export interface EffectWindowBinding {
  instance: number; rate: number; windows: number; period: number;
  rangeClass: number; noneSymbol: number;
}
export interface EffectWindow {
  rate: number;
  windows: [number, number][];
  period: number | null;
}
export function validEffectWindows(v: any): v is EffectWindowBinding[] {
  return validBindingList(v,b=>[b.rate,b.windows,b.period,b.rangeClass,b.noneSymbol].every(bindingIndex)
    &&new Set([b.rate,b.windows,b.period]).size===3);
}
export function createEffectWindowReader(bindings: EffectWindowBinding[] | undefined, objects: ConstructorRecord[]) {
  if(bindings!==undefined&&!validEffectWindows(bindings))throw Error('invalid effect window bindings');
  const bindingOf=instanceLookup((bindings??[]).map(b=>[b.instance,b] as const),objects);
  return (slot:number,ops:EffectExtra[]):EffectWindow|null=>{
    const b=bindingOf(slot);if(!b)return null;
    const rate=ops.find(e=>e.op===b.rate),period=ops.find(e=>e.op===b.period);
    if(rate?.kind!=='int'||!Number.isSafeInteger(rate.value)||rate.value<0)return null;
    let repeat:number|null;
    if(period?.kind==='symbol'&&period.index===b.noneSymbol)repeat=null;
    else if(period?.kind==='duration'&&Number.isSafeInteger(period.ticks)&&period.ticks>0)repeat=period.ticks;
    else return null;
    const windows:[number,number][]=[];
    const read=(e:EffectExtra|undefined,depth:number):boolean=>{
      if(!e||depth>8||windows.length>4096)return false;
      if(e.kind==='list'&&e.tag===32)return e.values.every(v=>read(v,depth+1));
      if(e.kind!=='typed'||e.class!==b.rangeClass||e.fields.length!==2)return false;
      const [a,z]=e.fields;
      if(a.kind!=='duration'||z.kind!=='duration'||!Number.isSafeInteger(a.ticks)||!Number.isSafeInteger(z.ticks)||z.ticks<a.ticks)return false;
      if(windows.length&&a.ticks<windows[windows.length-1][0])return false;
      windows.push([a.ticks,z.ticks]);return true;
    };
    if(!read(ops.find(e=>e.op===b.windows),0))return null;
    return {rate:rate.value,windows,period:repeat};
  };
}
