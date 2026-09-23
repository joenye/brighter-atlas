// Optional computed-property bindings from per-build decode data, produced
// offline purely from analysis of the game's own files, never by inspecting
// or modifying a running game process or its memory. Values are read from the
// user's bundle; the bindings contain only source locations and operations.
import {PoolDecoder} from './value-pool.js';
import {resolveValue} from './room-metadata.js';
import type {WorldProfile} from './profile.js';
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';

const propertyRoles = ['color', 'scale', 'speed', 'acceleration'] as const;
type PropertyRole = typeof propertyRoles[number];
export type EffectPropertyPairs = Partial<Record<PropertyRole, [number, number]>>;

/** A repeated-value marker identifies both fields even when the first value
 * is an expression. Infer a family layout only when every marker agrees. */
export function inferEffectPropertyPairs(rows: readonly EffectExtra[][]): EffectPropertyPairs {
  const result: EffectPropertyPairs = {};
  for (const role of propertyRoles) {
    const candidates = new Map<string, [number, number]>();
    for (const fields of rows) for (let i = 1; i < fields.length; i++) {
      const field = fields[i];
      if (field.kind !== 'symbol' || field.name !== `$${role}0`) continue;
      const pair: [number, number] = [fields[i - 1].op, field.op];
      if (pair[1] !== pair[0] + 1) continue;
      candidates.set(pair.join(','), pair);
    }
    if (candidates.size === 1) result[role] = [...candidates.values()][0];
  }
  return result;
}

/** Preserve unresolved endpoints; their presence must not redirect a role
 * to an unrelated scalar or vector elsewhere in the record. */
export function readEffectPropertyPair(fields: EffectExtra[], layout: EffectPropertyPairs,
  role: PropertyRole): {start: EffectExtra | null; end: EffectExtra | null; indices: number[]} | null {
  const marker = fields.findIndex(f => f.kind === 'symbol' && f.name === `$${role}0`);
  const pair = marker > 0 && fields[marker].op === fields[marker - 1].op + 1
    ? [fields[marker - 1].op, fields[marker].op] : layout[role];
  if (!pair) return null;
  const a = fields.findIndex(f => f.op === pair[0]), b = fields.findIndex(f => f.op === pair[1]);
  const start = fields[a] ?? null, end = fields[b] ?? null;
  return {start, end: end?.kind === 'symbol' && end.name === `$${role}0` ? start : end,
    indices: [a, b].filter(i => i >= 0)};
}

export interface EffectPropertyBinding {
  instance: number;
  color: {start:number; end:number; alphaScale:number; systemField:number};
  speedField: number;
  angularSpeedField: number;
}
export function validEffectProperties(values:any):values is EffectPropertyBinding[] {
  const integer=(v:any)=>Number.isInteger(v)&&v>=0&&v<65536;
  return Array.isArray(values)&&values.length<=65536&&values.every(v=>v&&integer(v.instance)
    &&integer(v.speedField)&&integer(v.angularSpeedField)&&v.color&&integer(v.color.systemField)
    &&Number.isSafeInteger(v.color.start)&&v.color.start>=0&&Number.isSafeInteger(v.color.end)
    &&v.color.end>v.color.start&&v.color.end-v.color.start<=65536
    &&Number.isFinite(v.color.alphaScale)&&v.color.alphaScale>=0&&v.color.alphaScale<=1)
    &&new Set(values.map(v=>v.instance)).size===values.length;
}

export function createEffectPropertyReader(bindings:EffectPropertyBinding[]|undefined,
  objects:ConstructorRecord[],bytes:Uint8Array,profile:WorldProfile,pool:any[]) {
  if(bindings!==undefined&&!validEffectProperties(bindings))throw Error('invalid effect property bindings');
  const byInstance=new Map((bindings??[]).map(v=>[v.instance,v]));
  const colors=new Map<number,[number,number,number,number]>();
  const arities=(v:Record<string,number>)=>new Map(Object.entries(v).map(([k,n])=>[+k,n]));
  for(const b of bindings??[]){
    if(b.color.end>bytes.length)throw Error('effect colour lies outside source data');
    const d=new PoolDecoder(bytes.subarray(b.color.start,b.color.end),arities(profile.class_fields),arities(profile.tag6_fields));
    const n=resolveValue(pool,d.value());
    if(d.pos!==b.color.end-b.color.start||n?.tag!==21||!Array.isArray(n.value)
      ||n.value.length!==4||!n.value.every(Number.isFinite))throw Error('invalid effect colour value');
    colors.set(b.instance,[...n.value] as [number,number,number,number]);
  }
  return (slot:number,system:EffectExtra[]):EffectPropertyBinding & {rgba:[number,number,number,number]} | null=>{
    const b=byInstance.get(objects[slot]?.values[1]);
    if(!b)return null;
    const field=system.find(e=>e.op===b.color.systemField);
    // An optional authored colour overrides the default. Unknown expressions
    // remain unresolved rather than borrowing an unrelated nested colour.
    const value=field?.kind==='typed'&&field.fields.length===1&&field.fields[0].kind==='color'
      ?field.fields[0].rgba:null;
    if(!value&&!(field?.kind==='symbol'&&field.name==='$none'))return null;
    const rgba=[...(value??colors.get(b.instance)!)] as [number,number,number,number];
    rgba[3]*=b.color.alphaScale;
    return {...b,rgba};
  };
}

// Some complex emitters repeat life after the three timing-header fields.
// It is a movement interval, not another fade-out duration.
export function effectTimingDurations(ops:EffectExtra[]):number[] {
  const d=ops.filter((e):e is Extract<EffectExtra,{kind:'duration'}>=>e.kind==='duration').map(e=>e.ticks);
  while(d.length>3&&d[d.length-1]===d[0])d.pop();
  return d;
}
