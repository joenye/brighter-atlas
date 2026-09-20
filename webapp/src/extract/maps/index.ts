import {loadWorldProfile, type FetchJson} from '../world/profile.js';
import {replayGraph} from '../world/replay.js';
import {decodePool} from '../world/value-pool.js';
import {makeSlabReader, decodeObject, type BundleFrames} from '../bundles.js';
import {decodeFontGlyphs, parseDatafileRecords} from '../image.js';
import {deriveMapRoomRecords} from './records.js';
import {extractMapGeometry} from './geometry.js';
import {decodeMapBinding, decodeMapStyleDefaults, decodeMapAnnotationTable} from './bindings.js';
import {validateMapDecodeData} from './decode-data.js';
import {resolveMapPalette} from './palette.js';
import {extractMapFonts} from './fonts.js';
import {extractMapImages} from './images.js';
import {mapBadgeFormatter} from './badges.js';
import {hashText} from '../hash.js';
import {extractMapRoomData} from './room-data.js';

export async function extractMaps({ab0,dt,files,frames,fetchJson,onProgress=()=>{},signal,includeRoomData=false}: {
  ab0:Uint8Array; dt:any; files:Record<number,Blob>; frames:Record<number,BundleFrames>;
  fetchJson?:FetchJson; onProgress?:(ev:any)=>void; signal?:AbortSignal; includeRoomData?:boolean;
}) {
  const bail=()=>{if(signal?.aborted)throw Error('cancelled');};
  const progress=(step:string)=>{bail();onProgress({stage:'index',cat:'maps',done:0,total:1,note:step});};
  progress('decode data');
  const {profile,rawSha256,error}=await loadWorldProfile(ab0,{fetchJson});
  if(!profile)throw Error(error);
  const get=fetchJson??(async(rel:string)=>{
    const response=await fetch(new URL('../../../'+rel,import.meta.url),{cache:'no-cache'});
    if(!response.ok)throw Error('Map decode data is unavailable for this build');
    return response.json();
  });
  let data;
  try {data=validateMapDecodeData(await get(`builds/${rawSha256.slice(0,16)}.maps.json`),rawSha256);}
  catch {throw Error('2D maps are not supported for this game build yet');}
  progress('room records');
  const {rows}=replayGraph(ab0,profile),pool=decodePool(ab0,profile).values;
  const annotationBinding=data.bindings.annotationTable;
  const annotationTable=annotationBinding?{offset:annotationBinding.offset,
    entries:decodeMapAnnotationTable(ab0,pool,profile,annotationBinding)}:undefined;
  const records=deriveMapRoomRecords(rows,pool,ab0,profile,dt.charset,dt.symbols,undefined,annotationTable);
  const defaults=decodeMapStyleDefaults(rows,pool,ab0,profile,data.bindings.styleDictionary);
  const byOwner=new Map([...records.values()].map(r=>[r.owner,r]));
  const read2=makeSlabReader(files[2]),read3=makeSlabReader(files[3]);
  const raw3=async(id:number)=>{bail();if(!frames[3].entries[id])throw Error('missing map image');return read3(frames[3].entries[id]);};
  const shingles=await extractMapGeometry(records.values(),dt.textureDir,
    async id=>decodeObject(3,await raw3(id)).subs[0],owner=>{
      const r=byOwner.get(owner)!;
      const keys=new Set(r.terrain.styles.flatMap(w=>[0,8,16,24].map(s=>w>>>s&255)));
      return resolveMapPalette(rows[owner].runtime,keys,r.terrain.baseColors,defaults,data.palette);
    });
  const badge=mapBadgeFormatter(ab0,pool,profile,data,dt.charset);
  const rooms=[...records.values()].map(r=>{
    const fixed=data.labels?.layout==='fixed';
    if(r.labels.metrics.length!==(fixed?1:2) || r.labels.metrics.some(m=>m.length!==(fixed?5:4)))throw Error('unsupported map label layout');
    return {room:r.room,owner:r.owner,name:r.name,episode:r.episode,mapPosition:r.mapPosition,roomSize:r.mapSize,
      colors:r.terrain.baseColors,labels:{...r.labels,...(fixed?{layout:'fixed' as const}:{}),background:r.labels.background.symbol,
        connector:r.labels.connector.symbol??r.labels.connector,annotations:r.labels.annotations.map(a=>({...a,badge:badge(a.marker)}))}};
  });
  const roomData=includeRoomData?await extractMapRoomData({rows,pool,bytes:ab0,profile,charset:dt.charset,
    rooms:records.values(),readRoom:async id=>{bail();return decodeObject(2,await read2(frames[2].entries[id]));},
    onRoom:(done,total)=>{bail();onProgress({stage:'index',cat:'maps',done,total,note:'additional room placements'});}}):null;
  progress('glyphs');
  const titleGlyphs=rooms.flatMap(r=>r.labels.glyphs),annotationGlyphs=rooms.flatMap(r=>r.labels.annotations.flatMap(a=>[
    ...a.glyphs,...Array.from(a.badge?.text??'',ch=>dt.charset.indexOf(ch))]));
  for(const r of roomData?.resources??[])if(r.glyph!==null)annotationGlyphs.push(r.glyph);
  const fontSlot=(name:string)=>decodeMapBinding(ab0,pool,profile,data.bindings[name]).value;
  const {fonts,sheet}=await extractMapFonts(rows,pool,ab0,profile,dt.charset,
    {title:{slot:fontSlot('titleFont'),glyphs:titleGlyphs},annotation:{slot:fontSlot('annotationFont'),glyphs:annotationGlyphs}},
    data.fontAtlas,async id=>{bail();return decodeObject(2,await read2(frames[2].entries[id]));},async id=>{
      const b=decodeObject(3,await raw3(id)).subs[0];return decodeFontGlyphs(b,parseDatafileRecords(b,dt.textureDir[id].n));
    });
  progress('textures');
  const {atlas,images,sprites}=await extractMapImages(rows,pool,ab0,profile,data,raw3);
  const scene={rooms,shingles,labelFonts:fonts,labelBackgrounds:sprites,atlas:{width:atlas[0].width,height:atlas[0].height}};
  const doc={format:1,scene,terrainMips:atlas,images:{...images,glyphs:sheet},
    roomData:roomData?{file:'maps/room-data.json',records:roomData.rooms.reduce((n,r)=>n+r.occurrences.length+r.actors.length+r.volumes.length,0)}:null};
  const index=[{i:0,name:'Full world',room:null,rooms:rooms.length,h:hashText(rawSha256),f:'maps/scene.json'},
    ...rooms.map(r=>({i:r.room+1,room:r.room,name:r.name,episode:r.episode,w:r.roomSize[0],hTiles:r.roomSize[1],
      mapAnnotations:r.labels.annotations.map(a=>a.text),h:hashText(JSON.stringify(r)),f:'maps/scene.json'}))];
  bail();onProgress({stage:'index',cat:'maps',done:1,total:1});
  return {doc,index,roomData};
}

export type MapDocument = Awaited<ReturnType<typeof extractMaps>>['doc'];
