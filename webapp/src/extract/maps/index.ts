import {loadWorldProfile, type FetchJson} from '../world/profile.js';
import {replayGraph} from '../world/replay.js';
import {decodePool} from '../world/value-pool.js';
import {makeSlabReader, decodeObject, type BundleFrames} from '../bundles.js';
import {decodeFontGlyphs, parseDatafileRecords} from '../image.js';
import {extractMapGeometry} from './geometry.js';
import {readMapDecodeData} from './decode-data.js';
import {resolveMapPalette} from './palette.js';
import {extractMapFonts, type MapFont, type MapFontSheet} from './fonts.js';
import {extractMapImages} from './images.js';
import {mapBadgeFormatter} from './badges.js';
import {deriveMapFacts} from './map-shape.js';
import {hashText} from '../hash.js';
import {extractMapRoomData} from './room-data.js';

// Everything but each room type's own colours and the label images is read
// from the user's bundles by shape (map-shape.ts); the per-build decode data
// adds those when it has them.
export async function extractMaps({ab0,dt,files,frames,fetchJson,onProgress=()=>{},signal,includeRoomData=false}: {
  ab0:Uint8Array; dt:any; files:Record<number,Blob>; frames:Record<number,BundleFrames>;
  fetchJson?:FetchJson; onProgress?:(ev:any)=>void; signal?:AbortSignal; includeRoomData?:boolean;
}) {
  const bail=()=>{if(signal?.aborted)throw Error('cancelled');};
  const progress=(step:string)=>{bail();onProgress({stage:'index',cat:'maps',done:0,total:1,note:step});};
  progress('decode data');
  const {profile,rawSha256,error}=await loadWorldProfile(ab0,{fetchJson});
  if(!profile)throw Error(error);
  const data=readMapDecodeData(profile.maps);
  progress('room records');
  const {rows,objects}=replayGraph(ab0,profile),{values:pool,frame:poolFrame}=decodePool(ab0,profile);
  const readTail=async(id:number,length:number)=>{
    const e=frames[3].entries[id];if(!e||e.length<length)return null;
    return new Uint8Array(await files[3].slice(e.offset+e.length-length,e.offset+e.length).arrayBuffer());
  };
  const facts=await deriveMapFacts({ab0,profile,rows,objects,types:dt.types,pool,poolFrame,charset:dt.charset,symbols:dt.symbols,textures:dt.textureDir,readTail});
  const {records,styles,atlas,form}=facts;
  if(!styles||atlas===null)throw Error('2D maps are not supported for this game build yet');
  if(!form)throw Error('unsupported map label layout');
  const fixed=form==='single';
  const byOwner=new Map([...records.values()].map(r=>[r.owner,r]));
  const read2=makeSlabReader(files[2]),read3=makeSlabReader(files[3]);
  const raw3=async(id:number)=>{bail();if(!frames[3].entries[id])throw Error('missing map image');return read3(frames[3].entries[id]);};
  const object2=async(id:number)=>{bail();return decodeObject(2,await read2(frames[2].entries[id]));};
  const sub3=async(id:number)=>decodeObject(3,await raw3(id)).subs[0];
  const shingles=await extractMapGeometry(records.values(),dt.textureDir,
    sub3,owner=>{
      const r=byOwner.get(owner)!;
      const keys=new Set(r.terrain.styles.flatMap(w=>[0,8,16,24].map(s=>w>>>s&255)));
      return resolveMapPalette(rows[owner].runtime,keys,r.terrain.baseColors,styles.defaults,data.rooms);
    });
  const badge=mapBadgeFormatter(ab0,pool,profile,data,dt.charset,fixed);
  const rooms=[...records.values()].map(r=>{
    return {room:r.room,owner:r.owner,name:r.name,episode:r.episode,mapPosition:r.mapPosition,roomSize:r.mapSize,
      colors:r.terrain.baseColors,labels:{...r.labels,...(fixed?{layout:'fixed' as const}:{}),background:r.labels.background.symbol,
        connector:r.labels.connector.symbol??r.labels.connector,annotations:r.labels.annotations.map(a=>({...a,badge:badge(a.marker)}))}};
  });
  const roomData=includeRoomData?await extractMapRoomData({rows,pool,bytes:ab0,profile,charset:dt.charset,
    rooms:records.values(),readRoom:object2,
    onRoom:(done,total)=>{bail();onProgress({stage:'index',cat:'maps',done,total,note:'additional room placements'});}}):null;
  progress('glyphs');
  const titleGlyphs=rooms.flatMap(r=>r.labels.glyphs),annotationGlyphs=rooms.flatMap(r=>r.labels.annotations.flatMap(a=>[
    ...a.glyphs,...Array.from(a.badge?.text??'',ch=>dt.charset.indexOf(ch))]));
  for(const r of roomData?.resources??[])if(r.glyph!==null)annotationGlyphs.push(r.glyph);
  // Labels need their fonts: a build whose fonts are not found draws its
  // terrain alone.
  const requests={...(facts.fonts.title!==null?{title:{slot:facts.fonts.title,glyphs:titleGlyphs}}:{}),
    ...(facts.fonts.title!==null&&facts.fonts.annotation!==null?{annotation:{slot:facts.fonts.annotation,glyphs:annotationGlyphs}}:{})};
  let fonts:Record<string,MapFont>={},sheet:MapFontSheet={width:1,height:1,rgba:new Uint8Array(4)};
  if(Object.keys(requests).length)({fonts,sheet}=await extractMapFonts(rows,pool,ab0,profile,dt.charset,requests,{},object2,async id=>{
    const b=await sub3(id);return decodeFontGlyphs(b,parseDatafileRecords(b,dt.textureDir[id].n));
  }));
  progress('textures');
  const {atlas:mips,images,sprites}=await extractMapImages(rows,pool,ab0,profile,data,atlas,raw3);
  const scene={rooms,shingles,labelFonts:fonts,labelBackgrounds:sprites,atlas:{width:mips[0].width,height:mips[0].height}};
  const doc={format:1,scene,terrainMips:mips,images:{...images,glyphs:sheet},
    roomData:roomData?{file:'maps/room-data.json',records:roomData.rooms.reduce((n,r)=>n+r.occurrences.length+r.actors.length+r.volumes.length,0)}:null};
  const index=[{i:0,name:'Full world',room:null,rooms:rooms.length,h:hashText(rawSha256),f:'maps/scene.json'},
    ...rooms.map(r=>({i:r.room+1,room:r.room,name:r.name,episode:r.episode,w:r.roomSize[0],hTiles:r.roomSize[1],
      mapAnnotations:r.labels.annotations.map(a=>a.text),h:hashText(JSON.stringify(r)),f:'maps/scene.json'}))];
  bail();onProgress({stage:'index',cat:'maps',done:1,total:1});
  return {doc,index,roomData};
}

export type MapDocument = Awaited<ReturnType<typeof extractMaps>>['doc'];
