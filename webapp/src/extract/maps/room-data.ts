// Additional room-file placements are separate from the 2D map scene. They
// include linked components and alternate records, not a simultaneous state.
import {AssetGraph} from '../world/graph.js';
import {SpawnGraph} from '../world/spawns.js';
import {scanEnemyDefinitions,extractEnemyRosters} from '../world/models.js';
import {objectDescriptionReader} from '../world/object-descriptors.js';
import {configureFields,roomLayers,roomOccupancy} from '../world/room.js';
import type {ObjectDescription} from '../world/object-descriptors.js';
import type {FillRow} from '../world/replay.js';
import type {PoolNode} from '../world/value-pool.js';
import type {WorldProfile} from '../world/profile.js';
import type {RoomMetadata} from '../world/room-metadata.js';

export type MapOccurrence=[resource:number,x:number,y:number,layer:number,rotation:number|null,
  record:number,entrySlot:number,parentLink:number[]|null,childLinks:number[][],individual:number|null,packed:number|null];
export interface MapRoomInventory {
  room:number; owner:number; name:string; position:number[]; size:number[];
  occurrences:MapOccurrence[];
  actors:(ReturnType<SpawnGraph['roomSpawns']>[number]&{runtime:number;selector:number})[];
  volumes:ReturnType<SpawnGraph['roomVolumes']>;
}
export interface MapRoomData {
  format:1; resources:ObjectDescription[]; rooms:MapRoomInventory[];
  unplaced:ReturnType<typeof extractEnemyRosters>;
}

export async function extractMapRoomData({rows,pool,bytes,profile,charset,rooms,readRoom,onRoom=()=>{}}:{
  rows:FillRow[];pool:PoolNode[];bytes:Uint8Array;profile:WorldProfile; charset:ArrayLike<string>;
  rooms:Iterable<RoomMetadata>;readRoom:(id:number)=>Promise<Uint8Array>;
  onRoom?:(done:number,total:number)=>void;
}):Promise<MapRoomData> {
  const selected=[...rooms],assets=new AssetGraph(rows,pool);
  const spawns=new SpawnGraph(rows,pool,assets,{bytes,profile,charset,enemyDefs:scanEnemyDefinitions(rows,pool,charset)});
  const roomRows=spawns.discoverRoomRows(selected.map(r=>r.room));
  const describe=objectDescriptionReader(rows,pool,bytes,profile,charset),resources=new Map<number,ObjectDescription>();
  const inventory:MapRoomInventory[]=[];
  configureFields(profile);
  for(const r of selected) {
    onRoom(inventory.length,selected.length);
    const room=roomLayers(await readRoom(r.room),r.room),owner=roomRows.get(r.room);
    if(!room||!owner||owner.record!==r.owner)throw Error('room placement owner is missing or ambiguous');
    if(room.w!==r.mapSize[0]||room.h!==r.mapSize[1])throw Error('room dimensions disagree with map');
    const origins=room.top.filter(n=>n.kind==='lit'&&n.tag===0x2e&&n.index===null);
    if(origins.length!==1||origins[0].value.some((n:number,i:number)=>(n|0)!==r.mapPosition[i]))
      throw Error('room placement origin disagrees with map');
    const occurrences=roomOccupancy(room).occurrences.map((o):MapOccurrence=>{
      if(!resources.has(o.resource))resources.set(o.resource,describe(o.resource));
      return [o.resource,o.cell[0],o.cell[1],o.cell[2],o.rotationQuarters,o.record,o.entrySlot,
        o.parentLink,o.childLinks,o.individual,o.packed];
    });
    inventory.push({room:r.room,owner:r.owner,name:r.name,position:r.mapPosition,size:r.mapSize,
      occurrences,actors:spawns.roomSpawns(r.room,owner).map(a=>({...a,runtime:rows[a.record].runtime,selector:rows[a.record].selector})),volumes:spawns.roomVolumes(r.owner)});
  }
  const roomIds=new Set(selected.map(r=>r.room));
  onRoom(inventory.length,selected.length);
  return {format:1,resources:[...resources.values()],rooms:inventory,
    unplaced:extractEnemyRosters(rows,pool,charset).filter(r=>roomIds.has(r.room))};
}
