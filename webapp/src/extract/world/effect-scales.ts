// Optional per-build decode data is produced offline purely from analysis of
// the game's own files, never by inspecting or modifying a running game
// process or its memory. Authored sizes remain in the user's bundle.
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';
export interface EffectScaleBinding {
  instance: number; start: number; end: number; rangeClass: number;
}
export type EffectScaleValue = number | [number, number];
export interface EffectScales {start: EffectScaleValue; end: EffectScaleValue | 'start'}
export function validEffectScales(value: any): value is EffectScaleBinding[] {
  const index=(v:any)=>Number.isInteger(v)&&v>=0&&v<65536;
  return Array.isArray(value)&&value.length<=65536&&value.every(b=>b
    &&[b.instance,b.start,b.end,b.rangeClass].every(index)&&b.start!==b.end)
    &&new Set(value.map(b=>b.instance)).size===value.length;
}
export function createEffectScaleReader(bindings: EffectScaleBinding[] | undefined, objects: ConstructorRecord[]) {
  if(bindings!==undefined&&!validEffectScales(bindings))throw Error('invalid effect scale bindings');
  const byInstance=new Map((bindings??[]).map(b=>[b.instance,b]));
  return (slot:number,fields:EffectExtra[]):EffectScales|null=>{
    const binding=byInstance.get(objects[slot]?.values[1]);if(!binding)return null;
    const scalar=(e:EffectExtra|undefined):number|null=>{
      const n=e?.kind==='float'?e.value:e?.kind==='fixed'&&e.floats?.length===1?e.floats[0]:null;
      return n!==null&&Number.isFinite(n)?n:null;
    };
    const read=(e:EffectExtra|undefined):EffectScaleValue|null=>{
      const n=scalar(e);if(n!==null)return n;
      if(e?.kind!=='typed'||e.class!==binding.rangeClass||e.fields.length!==2)return null;
      const a=scalar(e.fields[0]),b=scalar(e.fields[1]);return a!==null&&b!==null?[a,b]:null;
    };
    const start=read(fields.find(f=>f.op===binding.start));
    const last=fields.find(f=>f.op===binding.end);
    const end=last?.kind==='symbol'&&last.name==='$scale0'?'start':read(last);
    return start!==null&&end!==null?{start,end}:null;
  };
}
