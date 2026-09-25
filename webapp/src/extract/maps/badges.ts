import {decodeMapBinding} from './bindings.js';
import type {MapBindingName, MapDecodeData} from './decode-data.js';
import type {MapValue} from './records.js';
import type {PoolNode} from '../world/value-pool.js';
import type {WorldProfile} from '../world/profile.js';

export interface MapBadge {text: string; size: number; runs?: {text: string; color: number[]}[]}
// Badge glyphs and colours come from the decode data; a badge whose glyphs
// are not known is left out.
export function mapBadgeFormatter(bytes: Uint8Array, pool: PoolNode[], profile: WorldProfile,
  data: MapDecodeData, charset: ArrayLike<string>, fixed: boolean): (marker: MapValue) => MapBadge | null {
  const read = (name: MapBindingName) => {
    const binding = data.bindings[name];
    if (!binding) return null;
    try {return decodeMapBinding(bytes,pool,profile,binding);} catch {return null;}
  };
  const text = (glyph: number) => {
    if (!Number.isInteger(glyph) || typeof charset[glyph]!=='string') throw Error('missing map badge glyph');
    return charset[glyph];
  };
  const known = <T>(value: () => T): T | null => {try {return value();} catch {return null;}};
  const star=read('annotationStar');
  const starText=star?.tag===14 && star.values?.length ? known(()=>star.values!.map(text).join('')) : null;
  const levels=(['Minor','Major'] as const).map(kind=>{
    const glyph=read(`level${kind}Glyph`),color=read(`level${kind}Color`);
    return glyph?.tag===0x73 && color?.tag===21 ? known(()=>({suffix:text(glyph.value),color:color.value.slice(0,3).map((v:number)=>Math.round(v*255))})) : null;
  });
  const parts=fixed||levels.some(l=>!l)?null:{Minor:levels[0]!,Major:levels[1]!};
  return marker=>{
    if (marker.tag===15 && marker.symbol==='$star') return starText===null?null:{text:starText,size:Math.fround(fixed?89.6:67.2)};
    if (marker.tag!==10) return null;
    const value=marker.value as number;
    if (!Number.isInteger(value) || value<0) throw Error('invalid map level');
    if (fixed) return {text:String(value),size:Math.fround(57.6)};
    if (!parts) return null;
    const major=Math.floor(value/50),minor=value%50,runs: {text:string;color:number[]}[]=[];
    if (major) runs.push({text:String(major)+parts.Major.suffix,color:parts.Major.color});
    if (!major || minor) runs.push({text:(major?String(minor).padStart(2,'0'):String(minor))+parts.Minor.suffix,color:parts.Minor.color});
    return {text:runs.map(r=>r.text).join(''),runs,size:48};
  };
}
