// Optional per-build placement decode data is produced offline purely from
// analysis of the game's own files, never by inspecting or modifying a running
// game process or its memory. Missing data preserves legacy display grounding.
import {validEffectScales, type EffectScaleBinding} from './effect-scales.js';
import {validEffectWindows, type EffectWindowBinding} from './effect-windows.js';
import {validEffectSprites, type EffectSpriteBinding} from './effect-sprites.js';
import {validEffectFacings, type EffectFacingBinding} from './effect-facing.js';
import {validEffectOrigins, type EffectOriginBinding} from './effect-origins.js';
import {validEffectProperties, type EffectPropertyBinding} from './effect-properties.js';
import {validEffectFields, type EffectFieldData} from './effect-fields.js';
import {validEffectWaves, type EffectWaveData} from './effect-waves.js';
import {validWaterData, type WaterDecodeData} from './water-materials.js';
import {validRenderBuildData, type RenderBuildData} from './render-data.js';
import {validTileData, type TileDecodeData} from './tile-colour.js';
import {deref, type RoomNode} from './room.js';
import {makeRegistryRowDecoder} from './effects.js';
import {resolveValue} from './room-metadata.js';
import type {RegistryRow} from './graph.js';
import type {FillRow} from './replay.js';
import type {WorldProfile} from './profile.js';
import type {RoomRowRef, SpawnRecord} from './spawns.js';
import {PoolDecoder, profileArities} from './value-pool.js';
import {readAppearanceControllers} from './default-appearance.js';
import type {EffectMotion} from './effect-motion.js';

export interface PlacementDecodeData {
  kind: 'brighter-atlas-placement-decode';
  format: 1;
  bundle0_raw_sha256: string;
  rooms: {fieldCount:number; width:number; height:number; origin:number; words:number; links:number};
  actors: {parent:number};
  defaultAppearances?: {runtime:number; start:number; end:number}[];
  appearanceCandidates?: {runtime:number; fields:number[]}[];
  effectScales?: EffectScaleBinding[];
  effectWindows?: EffectWindowBinding[];
  effectSprites?: EffectSpriteBinding[];
  effectFacings?: EffectFacingBinding[];
  effectOrigins?: EffectOriginBinding[];
  effectProperties?: EffectPropertyBinding[];
  effectFields?: EffectFieldData;
  effectWaves?: EffectWaveData;
  water?: WaterDecodeData;
  render?: RenderBuildData;
  tiles?: TileDecodeData;
  effectMotion?: {
    controllers: {runtime:number; field:number}[];
    settings: {runtime:number; x:[number,number,number]; y:[number,number,number]}[];
  };
}
export interface ActorHeight {height:number; z:number; room:number|null}

export function validatePlacementData(data:any,hash:string):PlacementDecodeData {
  if(data?.kind!=='brighter-atlas-placement-decode'||data.format!==1||data.bundle0_raw_sha256!==hash)
    throw Error('placement decode data does not match this build');
  const integer=(n:any)=>Number.isInteger(n)&&n>=0&&n<65536;
  if(!data.rooms||!data.actors||!integer(data.rooms.fieldCount)||data.rooms.fieldCount<1
    ||!['width','height','origin','words','links'].every(k=>integer(data.rooms[k]))||!integer(data.actors.parent))
    throw Error('invalid placement field bindings');
  const fields=['width','height','origin','words'].map(k=>data.rooms[k]);
  if(new Set(fields).size!==fields.length||fields.some(n=>n>=data.rooms.fieldCount))
    throw Error('invalid room placement fields');
  if(data.defaultAppearances!==undefined){
    const values=data.defaultAppearances;
    if(!Array.isArray(values)||values.length>65536||values.some(v=>!v||!integer(v.runtime)
      ||!Number.isSafeInteger(v.start)||!Number.isSafeInteger(v.end)||v.start<0||v.end<=v.start
      ||v.end-v.start>65536)||new Set(values.map(v=>v.runtime)).size!==values.length)
      throw Error('invalid default appearance bindings');
  }
  if(data.appearanceCandidates!==undefined){
    const values=data.appearanceCandidates;
    if(!Array.isArray(values)||values.length>65536||values.some(v=>!v||!integer(v.runtime)
      ||!Array.isArray(v.fields)||!v.fields.length||v.fields.length>65536
      ||!v.fields.every(integer)||new Set(v.fields).size!==v.fields.length)
      ||new Set(values.map(v=>v.runtime)).size!==values.length)
      throw Error('invalid appearance candidate bindings');
  }
  if(data.effectMotion!==undefined){
    const {controllers,settings}=data.effectMotion??{};
    const unique=(values:any)=>Array.isArray(values)&&values.length<=65536
      &&values.every(v=>v&&integer(v.runtime))&&new Set(values.map(v=>v.runtime)).size===values.length;
    if(!unique(controllers)||!unique(settings)||controllers.some((v:any)=>!integer(v.field))
      ||settings.some((v:any)=>![v.x,v.y].every(a=>Array.isArray(a)&&a.length===3&&a.every(integer))
        ||new Set([...v.x,...v.y]).size!==6))throw Error('invalid effect motion bindings');
  }
  if(data.effectScales!==undefined&&!validEffectScales(data.effectScales))throw Error('invalid effect scale bindings');
  if(data.effectWindows!==undefined&&!validEffectWindows(data.effectWindows))throw Error('invalid effect window bindings');
  if(data.effectSprites!==undefined&&!validEffectSprites(data.effectSprites))throw Error('invalid effect sprite bindings');
  if(data.effectFacings!==undefined&&!validEffectFacings(data.effectFacings))throw Error('invalid effect facing bindings');
  if(data.effectOrigins!==undefined&&!validEffectOrigins(data.effectOrigins))throw Error('invalid effect origin bindings');
  if(data.effectProperties!==undefined&&!validEffectProperties(data.effectProperties))throw Error('invalid effect property bindings');
  if(data.effectFields!==undefined&&!validEffectFields(data.effectFields))throw Error('invalid effect field bindings');
  if(data.effectWaves!==undefined&&!validEffectWaves(data.effectWaves))throw Error('invalid effect wave bindings');
  if(data.water!==undefined&&!validWaterData(data.water))throw Error('invalid water bindings');
  if(data.render!==undefined&&!validRenderBuildData(data.render))throw Error('invalid render bindings');
  if(data.tiles!==undefined&&!validTileData(data.tiles))throw Error('invalid tile colour bindings');
  return data;
}

export function createEffectMotionReader(data:PlacementDecodeData|null,rows:RegistryRow[],
  bytes:Uint8Array,profile:WorldProfile,pool:any[],symbols:string[]):(slot:number)=>EffectMotion|null {
  if(!data?.effectMotion)return ()=>null;
  validatePlacementData(data,profile.bundle0?.raw_sha256??'');
  const controllers=new Map(data.effectMotion.controllers.map(v=>[v.runtime,v.field]));
  const settings=new Map(data.effectMotion.settings.map(v=>[v.runtime,v]));
  const decode=makeRegistryRowDecoder(rows as FillRow[],bytes,profile);
  const cache=new Map<number,EffectMotion|null>();
  return slot=>{
    if(cache.has(slot))return cache.get(slot)!;
    const op=controllers.get(rows[slot]?.runtime);
    if(op===undefined)return null;
    const field=decode(slot)?.find(f=>f.op===op);
    const ref=field?.kind==='G'?resolveValue(pool,field.node):null;
    if(ref?.tag===15&&symbols[ref.value]==='$none'){cache.set(slot,null);return null;}
    if(ref?.tag!==38||!rows[ref.value])throw Error('invalid effect motion reference');
    const binding=settings.get(rows[ref.value].runtime);
    if(!binding)return null;
    const fields=decode(ref.value);
    const axis=(ops:[number,number,number])=>{
      const values=ops.map(op=>{
        const f=fields?.find(v=>v.op===op),n=f?.kind==='G'?resolveValue(pool,f.node):null;
        if(n?.tag!==11||n.value?.length!==1||!Number.isFinite(n.value[0]))throw Error('invalid effect motion value');
        return n.value[0] as number;
      });
      return {amplitude:values[0],spatialFrequency:values[1],temporalFrequency:values[2]};
    };
    const motion={x:axis(binding.x),y:axis(binding.y)};cache.set(slot,motion);return motion;
  };
}

// A bound on possible selections can exclude unrelated actions without
// declaring which conditional state is active.
export function createAppearanceCandidateReader(data:PlacementDecodeData|null,rows:RegistryRow[],
  bytes:Uint8Array,profile:WorldProfile,pool:any[],symbols:string[]):(slot:number)=>number[]|null {
  if(!data)return ()=>null;
  validatePlacementData(data,profile.bundle0?.raw_sha256??'');
  const bindings=new Map((data.appearanceCandidates??[]).map(v=>[v.runtime,v.fields]));
  const decode=makeRegistryRowDecoder(rows as FillRow[],bytes,profile);
  const cache=new Map<number,number[]>();
  return slot=>{
    const fields=bindings.get(rows[slot]?.runtime);
    if(!fields)return null;
    if(cache.has(slot))return cache.get(slot)!;
    const source=decode(slot),controllers=new Set<number>();
    for(const op of fields){
      const field=source?.find(f=>f.op===op);
      const values=field?.kind==='G'
        ?readAppearanceControllers(field.node,n=>resolveValue(pool,n),i=>symbols[i]):null;
      if(!values||values.some(id=>id>=rows.length))throw Error('invalid appearance candidate source value');
      for(const id of values)controllers.add(id);
    }
    const result=[...controllers];cache.set(slot,result);return result;
  };
}

// Per-build bindings identify source values for the authored default state.
// Controller references are always decoded from the supplied game files.
export function decodeDefaultAppearances(data:PlacementDecodeData|null,bytes:Uint8Array,
  profile:WorldProfile,pool:any[],symbols:string[],rowCount:number):Map<number,{controllers:number[]}> {
  const result=new Map<number,{controllers:number[]}>();
  if(!data)return result;
  validatePlacementData(data,profile.bundle0?.raw_sha256??'');
  for(const binding of data.defaultAppearances??[]){
    if(binding.end>bytes.length)throw Error('default appearance lies outside source data');
    const decoder=new PoolDecoder(bytes.subarray(binding.start,binding.end),...profileArities(profile));
    const node=decoder.value();
    const controllers=readAppearanceControllers(node,n=>resolveValue(pool,n),i=>symbols[i]);
    if(decoder.pos!==binding.end-binding.start||!controllers||controllers.some(id=>id>=rowCount))
      throw Error('invalid default appearance source value');
    result.set(binding.runtime,{controllers});
  }
  return result;
}

/** The profile's placement section (the one per-build file carries it), or
 *  null when the build has none. */
export function placementDataOf(profile:WorldProfile):PlacementDecodeData|null {
  if(profile.placement===undefined)return null;
  return validatePlacementData(profile.placement,profile.bundle0?.raw_sha256??'');
}

// A zero result is meaningful. Only a positive result stops the ordered
// linked-room search; an exhausted search returns zero, not a sampled surface.
export function packedRoomHeight(word:number,layer:number):number {
  const base=word&15,span=(word>>>4)&15;
  return layer===1 ? (word&0xf00000 ? base+span+((word>>>16)&15) : 0) : span ? base : 0;
}

export function createActorHeightReader({data,rooms,roomRows,rows,pool,bytes,profile}:{
  data:PlacementDecodeData|null;
  rooms:Map<number,{top:RoomNode[];table:RoomNode[]}>;
  roomRows:Map<number,RoomRowRef>;
  rows:RegistryRow[];pool:any[];bytes?:Uint8Array;profile:WorldProfile;
}):((room:number,actor:SpawnRecord)=>ActorHeight)|null {
  if(!data)return null;
  validatePlacementData(data,profile.bundle0?.raw_sha256??'');
  if(!bytes)throw Error('placement decoding needs the source registry');
  const decode=makeRegistryRowDecoder(rows as FillRow[],bytes,profile);
  const byOwner=new Map([...roomRows].map(([id,r])=>[r.record,id]));
  const grids=new Map<number,{width:number;height:number;origin:number[];words:number[];links:number[]}>();
  for(const [id,room] of rooms){
    const fields=room.top.slice(room.table.length),binding=data.rooms;
    if(fields.length!==binding.fieldCount)throw Error(`room ${id} placement field count changed`);
    const at=(field:number)=>deref(fields[field],room.table);
    const width=at(binding.width),height=at(binding.height),origin=at(binding.origin),words=at(binding.words);
    if(width.tag!==10||height.tag!==10||![width.value,height.value].every(n=>Number.isInteger(n)&&n>0)
      ||origin.tag!==46||origin.value?.length!==2||words.kind!=='array'||words.elems?.length!==width.value*height.value)
      throw Error(`room ${id} placement grid does not match its decode data`);
    const values=words.elems.map(n=>deref(n,room.table));
    if(values.some(n=>n.tag!==10||!Number.isInteger(n.value)))throw Error(`room ${id} has an invalid height word`);
    const owner=roomRows.get(id)?.record;
    if(owner===undefined)throw Error(`room ${id} has no placement owner`);
    const op=decode(owner)?.find(op=>op.op===binding.links);
    const links=op?.kind==='G'?resolveValue(pool,op.node):null;
    if(links?.tag!==32||!Array.isArray(links.values))throw Error(`room ${id} has no linked-room list`);
    const refs=links.values.map(n=>resolveValue(pool,n));
    if(refs.some(n=>n?.tag!==38))throw Error(`room ${id} has an invalid linked-room reference`);
    grids.set(id,{width:width.value,height:height.value,origin:origin.value.map((n:number)=>n|0),
      words:values.map(n=>n.value),links:refs.map(n=>n!.value)});
  }
  const at=(grid:{width:number;height:number;words:number[]},x:number,y:number,layer:number)=>
    x<0||y<0||x>=grid.width||y>=grid.height?0:packedRoomHeight(grid.words[y*grid.width+x],layer);
  return (room,actor)=>{
    const grid=grids.get(room),owner=roomRows.get(room)?.record;
    if(!grid||owner===undefined)throw Error(`missing actor height grid ${room}`);
    const parent=rows[actor.record]?.v?.find(v=>v[0]===data.actors.parent&&v[1]==='U')?.[2];
    if(parent!==owner||actor.default_room_record!==owner)throw Error(`actor ${actor.record} has a different height parent`);
    const [x,y,layer]=actor.position;
    let height=at(grid,x,y,layer);
    if(height>0)return {height,z:height*512,room};
    for(const linkedOwner of grid.links){
      const linked=byOwner.get(linkedOwner),other=linked===undefined?undefined:grids.get(linked);
      if(!other||linked===undefined)throw Error(`actor ${actor.record} needs an unavailable linked room`);
      height=at(other,x+grid.origin[0]-other.origin[0],y+grid.origin[1]-other.origin[1],layer);
      if(height>0)return {height,z:height*512,room:linked};
    }
    return {height:0,z:0,room:null};
  };
}
