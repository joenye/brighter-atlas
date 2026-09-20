// Display descriptors retain their source field and alternatives. A descriptor
// names an object; it does not establish whether that object is currently active.
import {makeRegistryRowDecoder} from './effects.js';
import {resolveValue,decodeGlyphText} from './room-metadata.js';
import type {FillRow} from './replay.js';
import type {PoolNode} from './value-pool.js';
import type {WorldProfile} from './profile.js';

export interface ObjectDescriptor {
  field:number; name:string; qualifier:string|null; glyph:number|null;
  category:string|null; iconResource:number|null;
}
export interface ObjectDescription {
  id:number; runtime:number; selector:number;
  name:string|null; qualifier:string|null; glyph:number|null; category:string;
  iconResource:number|null; dimensions:number[]|null; descriptors:ObjectDescriptor[];
}

export function objectDescriptionReader(rows:FillRow[],pool:PoolNode[],bytes:Uint8Array,
  profile:WorldProfile,charset:ArrayLike<string>) {
  const decode=makeRegistryRowDecoder(rows,bytes,profile),cache=new Map<number,ObjectDescription>();
  const icons=new Map<number,{glyph:number|null;category:string|null;iconResource:number}>();
  const fields=(slot:number)=>(decode(slot)??[]).flatMap(op=>op.kind==='G'?[{field:op.op,node:resolveValue(pool,op.node)}]:[]);
  const icon=(n:PoolNode|null):{glyph:number|null;category:string|null;iconResource:number|null}=>{
    if(n?.tag===0x73)return {glyph:n.value,category:null,iconResource:null};
    if(n?.tag!==0x26)return {glyph:null,category:null,iconResource:null};
    if(!icons.has(n.value)) {
      const values=fields(n.value).map(f=>f.node),glyphs=values.filter(v=>v?.tag===0x73);
      const distinctGlyphs=[...new Set(glyphs.map(g=>g!.value))];
      const names=values.slice(0,values.indexOf(glyphs[0])).map(v=>decodeGlyphText(v,charset)).filter((v):v is string=>v!==null);
      icons.set(n.value,{glyph:distinctGlyphs.length===1?distinctGlyphs[0]:null,
        category:distinctGlyphs.length===1&&names.length===1?names[0]:null,iconResource:n.value});
    }
    return icons.get(n.value)!;
  };
  return (slot:number):ObjectDescription=>{
    if(cache.has(slot))return cache.get(slot)!;
    const row=rows[slot];if(!row)throw Error('missing object resource');
    const values=fields(slot),descriptors:ObjectDescriptor[]=[];
    for(const {field,node} of values) {
      if(node?.tag!==0x24||node.fields?.length!==5)continue;
      const v=node.fields.map(n=>resolveValue(pool,n));
      if(v[0]?.tag!==14||![14,15].includes(v[1]?.tag??-1)||![15,38,115].includes(v[2]?.tag??-1)
        ||![15,38].includes(v[3]?.tag??-1)||![12,13].includes(v[4]?.tag??-1))continue;
      const name=decodeGlyphText(v[0],charset);if(name===null)continue;
      descriptors.push({field,name,qualifier:decodeGlyphText(v[1],charset),...icon(v[2])});
    }
    // Identify the visual owner's dimension header by shape, including flat
    // owners with zero height. Multiple candidate headers remain unresolved.
    const candidates:number[][]=[];
    for(let i=0;i+4<values.length;i++) {
      const f=values.slice(i,i+5),v=f.map(x=>x.node);
      if(f.some((x,j)=>x.field!==f[0].field+j))continue;
      if(v.slice(0,3).every(n=>n?.tag===10&&Number.isInteger(n.value)&&n.value>=0)
        &&v[0]!.value>0&&v[1]!.value>0&&v[3]?.tag===11
        &&(v[4]?.tag===15||v[4]?.tag===37&&v[4].value?.length===6))
        candidates.push([v[0]!.value,v[1]!.value]);
    }
    const preferred=descriptors[0],glyph=preferred?.glyph??null,char=glyph===null?null:charset[glyph];
    const result:ObjectDescription={id:slot,runtime:row.runtime,selector:row.selector,
      name:preferred?.name??null,qualifier:preferred?.qualifier??null,glyph,
      category:preferred?.category??(char?`Icon U+${char.codePointAt(0)!.toString(16).toUpperCase()}`:descriptors.length?'Unresolved icon':'Other placement'),
      iconResource:preferred?.iconResource??null,dimensions:candidates.length===1?candidates[0]:null,descriptors};
    cache.set(slot,result);return result;
  };
}
