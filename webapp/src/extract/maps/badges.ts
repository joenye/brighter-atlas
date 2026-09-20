import {decodeMapBinding} from './bindings.js';
import type {MapDecodeData} from './decode-data.js';
import type {MapValue} from './records.js';
import type {PoolNode} from '../world/value-pool.js';
import type {WorldProfile} from '../world/profile.js';

export interface MapBadge {text: string; size: number; runs?: {text: string; color: number[]}[]}
export function mapBadgeFormatter(bytes: Uint8Array, pool: PoolNode[], profile: WorldProfile,
  data: MapDecodeData, charset: ArrayLike<string>): (marker: MapValue) => MapBadge | null {
  const read = (name: string) => decodeMapBinding(bytes,pool,profile,data.bindings[name]);
  const text = (glyph: number) => {
    if (!Number.isInteger(glyph) || typeof charset[glyph]!=='string') throw Error('missing map badge glyph');
    return charset[glyph];
  };
  const star=read('annotationStar');
  if (star.tag!==14 || !star.values?.length) throw Error('invalid map star glyph');
  const starText=star.values.map(text).join('');
  const parts=Object.fromEntries(['Minor','Major'].map(kind=>{
    const glyph=read('level'+kind+'Glyph'),color=read('level'+kind+'Color');
    if (glyph.tag!==0x73 || color.tag!==21) throw Error('invalid map level badge');
    return [kind,{suffix:text(glyph.value),color:color.value.slice(0,3).map((v:number)=>Math.round(v*255))}];
  }));
  return marker=>{
    if (marker.tag===15 && marker.symbol==='$star') return {text:starText,size:Math.fround(67.2)};
    if (marker.tag!==10) return null;
    const value=marker.value as number;
    if (!Number.isInteger(value) || value<0) throw Error('invalid map level');
    const major=Math.floor(value/50),minor=value%50,runs: {text:string;color:number[]}[]=[];
    if (major) runs.push({text:String(major)+parts.Major.suffix,color:parts.Major.color});
    if (!major || minor) runs.push({text:(major?String(minor).padStart(2,'0'):String(minor))+parts.Minor.suffix,color:parts.Minor.color});
    return {text:runs.map(r=>r.text).join(''),runs,size:48};
  };
}
