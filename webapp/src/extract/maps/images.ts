import {decodeObject, splitAb3} from '../bundles.js';
import {parseImageMeta, decodeSubImage} from '../image.js';
import {makeRegistryRowDecoder} from '../world/effects.js';
import {resolveValue} from '../world/room-metadata.js';
import type {PoolNode} from '../world/value-pool.js';
import type {FillRow} from '../world/replay.js';
import type {WorldProfile} from '../world/profile.js';
import type {MapSpriteName} from './map-shape.js';

export interface MapBitmap {width: number; height: number; rgba: Uint8Array}
export interface MapSprite {
  slot: number; ab3: number; mip: number;
  scale: number; canvas: number[]; trims: number[]; padding: number[];
  rotated: boolean; sourceRect: number[]; nominalSize: number[];
  dimensions: number[]; sourceBorder?: number; width?: number;
}
// The fleck atlas and the label images are found by shape (map-shape.ts);
// any label image not found is left out and labels draw without it.
export async function extractMapImages(
  rows: FillRow[], pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile,
  atlasImage: number, spriteSlots: Partial<Record<MapSpriteName, number>>, readImage: (id: number) => Promise<Uint8Array>,
): Promise<{atlas: MapBitmap[]; images: Record<string, MapBitmap>; sprites: Record<string, MapSprite>}> {
  const decode = makeRegistryRowDecoder(rows, bytes, profile);
  const imageLevels = async (id: number) => {
    const raw = await readImage(id), meta = parseImageMeta(splitAb3(raw).tail), decoded = decodeObject(3, raw);
    return meta.map((m, i) => {
      const bitmap = decodeSubImage(m, decoded.subs[i]);
      return {width:bitmap.w,height:bitmap.h,rgba:bitmap.rgba};
    });
  };
  const atlas = (await imageLevels(atlasImage)).sort((a,b)=>b.width-a.width);
  if (!atlas.length || atlas[0].width !== 12 * 40 || atlas[0].height % 40
    || atlas.some((m,i)=>i && (m.width !== Math.max(1,atlas[i-1].width>>1) || m.height !== Math.max(1,atlas[i-1].height>>1)))) {
    throw Error('invalid map terrain atlas');
  }
  const images: Record<string,MapBitmap> = {}, sprites: Record<string,MapSprite> = {};
  for (const name of ['round','panel','connector','badge'] as const) {
    const slot = spriteSlots[name];
    if (slot === undefined) continue;
    // A sprite the data does not describe correctly is left out as well.
    const sprite = async (): Promise<[MapSprite, MapBitmap]> => {
      const fields = (decode(slot) ?? []).flatMap(op => op.kind === 'G' ? [resolveValue(pool,op.node)] : []);
      const textures = fields.filter(n=>n?.tag===71), packing = fields.filter(n=>n?.tag===36 && n.fields?.length===16);
      if (textures.length !== 1 || packing.length !== 1) throw Error('invalid map sprite material');
      const scales = fields.slice(0,fields.indexOf(textures[0])).filter(n=>n?.tag===11);
      if (scales.length !== 1 || !(scales[0]!.value[0]>0)) throw Error('invalid map sprite scale');
      const scale = scales[0]!.value[0], p = packing[0]!.fields!.map(n=>resolveValue(pool,n));
      const ints = (start: number, length: number) => p.slice(start,start+length).map(n=> {
        if (n?.tag!==10 || !Number.isInteger(n.value) || n.value<0) throw Error('invalid map sprite layout');
        return n.value as number;
      });
      const canvas=ints(2,2),trims=ints(4,4),padding=ints(8,4),rotated=p[12]?.tag===12;
      if (![12,13].includes(p[12]?.tag ?? -1)) throw Error('invalid map sprite rotation');
      const ab3=textures[0]!.value, levels=await imageLevels(ab3);
      const mip=levels.reduce((best,m,i)=>m.width*m.height>levels[best].width*levels[best].height?i:best,0);
      const bitmap=levels[mip], [width,height]=canvas, [left,top,right,bottom]=trims;
      const panel=name==='round' || name==='panel';
      // Panel banks have a fixed four-pixel sampling gutter. Ordinary sprite
      // banks instead carry their crop padding in the packing record.
      const [sx,sy]=panel?[4,4]:padding;
      const cw=width-left-right,ch=height-top-bottom,sw=rotated?ch:cw,sh=rotated?cw:ch;
      if (cw<=0 || ch<=0 || sx+sw>bitmap.width || sy+sh>bitmap.height) throw Error('map sprite crop exceeds image');
      const nominalSize=fields.slice(fields.indexOf(packing[0])+1).filter(n=>n?.tag===11).map(n=>n!.value[0]);
      const sprite: MapSprite = {slot,ab3,mip,scale,canvas,trims,padding,rotated,
        sourceRect:[sx,sy,sw,sh],nominalSize,dimensions:canvas};
      if (panel) {
        if (rotated || trims.some(Boolean) || nominalSize.length!==2) throw Error('unsupported map panel layout');
        return [sprite,bitmap];
      } else {
        const rgba=new Uint8Array(width*height*4);
        for (let y=0;y<bitmap.height;y++) for (let x=0;x<bitmap.width;x++) {
          const src=(y*bitmap.width+x)*4;
          if (x<sx || x>=sx+sw || y<sy || y>=sy+sh) {
            if (bitmap.rgba[src+3]) throw Error('map sprite has pixels outside its crop');
            continue;
          }
          const tx=rotated?y-sy:x-sx,ty=rotated?ch-1-(x-sx):y-sy;
          rgba.set(bitmap.rgba.subarray(src,src+4),((top+ty)*width+left+tx)*4);
        }
        if (name==='badge') {sprite.sourceBorder=35;sprite.scale=1.3;}
        if (name==='connector') sprite.width=60;
        return [sprite,{width,height,rgba}];
      }
    };
    try {
      const [made,image] = await sprite();
      images[name]=image;sprites[name]=made;
    } catch { /* left out */ }
  }
  return {atlas,images,sprites};
}
