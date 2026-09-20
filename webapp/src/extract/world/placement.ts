// Optional per-build placement decode data is produced offline purely from
// analysis of the game's own files, never by inspecting or modifying a running
// game process or its memory. Missing data preserves legacy display grounding.
import {deref, type RoomNode} from './room.js';
import {makeRegistryRowDecoder} from './effects.js';
import {resolveValue} from './room-metadata.js';
import type {RegistryRow} from './graph.js';
import type {FillRow} from './replay.js';
import type {FetchJson, WorldProfile} from './profile.js';
import type {RoomRowRef, SpawnRecord} from './spawns.js';

export interface PlacementDecodeData {
  kind: 'brighter-atlas-placement-decode';
  format: 1;
  bundle0_raw_sha256: string;
  rooms: {fieldCount:number; width:number; height:number; origin:number; words:number; links:number};
  actors: {parent:number};
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
  return data;
}

export async function loadPlacementData(hash:string,get:FetchJson):Promise<PlacementDecodeData|null> {
  let data:any;
  try{data=await get(`builds/${hash.slice(0,16)}.placement.json`);}catch{return null;}
  return validatePlacementData(data,hash);
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
