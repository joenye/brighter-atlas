import type {MapRoomData,MapRoomInventory,MapOccurrence} from '../../extract/maps/room-data.js';
import type {ObjectDescription} from '../../extract/world/object-descriptors.js';
import type {MapMarker,MapView} from './renderer.js';

export const sourceNames={object:'Described objects',other:'Other placements',actor:'Actor starts',enemy:'Enemy starts',region:'Room volumes'};
const kindNames:Record<NodeSource,string>={object:'Object',other:'Other placement',actor:'Actor start',enemy:'Enemy start',region:'Room volume'};
export type NodeSource=keyof typeof sourceNames;
type InventoryDescription=Omit<ObjectDescription,'runtime'|'selector'>&{runtime:number|null;selector:number|null};
export interface InventoryNode {id:number;room:MapRoomInventory;source:NodeSource;index:number;description:InventoryDescription}
export interface InventoryFilter {
  sources:Set<string>;categories:Set<string>;disabledTypes:Set<string>;
  roots:boolean;linked:boolean;additionalOnly:boolean;query:string;typeQuery:string;rooms:Set<number>|null;
}
export const nodeTitle=(n:InventoryNode)=>n.description.name
  ?`${n.description.name}${n.description.qualifier?' ('+n.description.qualifier+')':''}`:`Resource #${n.description.id}`;
export const nodeType=(n:InventoryNode)=>`${n.source}:${n.description.name??'runtime:'+n.description.runtime}`;
export const isLinked=(n:InventoryNode)=>['object','other'].includes(n.source)&&n.room.occurrences[n.index][7]!==null;
const clean=(s:string)=>s.toLocaleLowerCase();
export class MapInventory {
  readonly nodes:InventoryNode[]=[];
  readonly categories=new Map<string,number>();
  readonly types=new Map<string,{name:string;source:NodeSource;runtime:number|null;count:number}>();
  readonly coordinates:Float32Array;
  private sizes=new Map<number,number[]|null>();
  constructor(readonly data:MapRoomData) {
    const resources=new Map(data.resources.map(r=>[r.id,r]));
    const add=(room:MapRoomInventory,source:NodeSource,index:number,description:InventoryDescription)=>{
      const n={id:this.nodes.length,room,source,index,description};this.nodes.push(n);
      this.categories.set(description.category,(this.categories.get(description.category)??0)+1);
      const key=nodeType(n),type=this.types.get(key)??{name:description.name??`Runtime ${description.runtime}`,source,runtime:description.runtime,count:0};
      type.count++;this.types.set(key,type);
    };
    const description=(id:number,name:string|null,category:string):InventoryDescription=>({id,name,category,runtime:null,selector:null,
      qualifier:null,glyph:null,iconResource:null,dimensions:null,descriptors:[]});
    for(const room of data.rooms) {
      room.occurrences.forEach((o,i)=>{const r=resources.get(o[0]);if(!r)throw Error('missing placement descriptor');add(room,r.descriptors.length?'object':'other',i,r);});
      room.actors.forEach((a,i)=>{const enemy=!!a.enemy_definitions.length;add(room,enemy?'enemy':'actor',i,{...description(a.record,a.label,enemy?'Enemy actor':'Actor start'),runtime:a.runtime??null,selector:a.selector??null});});
      room.volumes.forEach((v,i)=>add(room,'region',i,description(room.owner,`Room volume (field ${v.field_op})`,'Room volume')));
    }
    this.coordinates=new Float32Array(this.nodes.length*2);
    for(const n of this.nodes) {
      const p=this.rawPosition(n),size=this.footprint(n);
      const actor=n.source==='actor'||n.source==='enemy';
      const offset=actor?n.room.actors[n.index].centre_offset:null;
      for(let i=0;i<2;i++)this.coordinates[n.id*2+i]=n.room.position[i]+(actor
        ?offset===null?NaN:Math.fround(Math.fround(p[i])+offset)
        :p[i]+(size?size[i]/2:n.source==='other'?.5:0));
    }
  }
  rawPosition(n:InventoryNode):number[] {
    if(n.source==='object'||n.source==='other')return n.room.occurrences[n.index].slice(1,3) as number[];
    if(n.source==='region')return n.room.volumes[n.index].origin;
    return n.room.actors[n.index].position;
  }
  footprint(n:InventoryNode):number[]|null {
    if(this.sizes.has(n.id))return this.sizes.get(n.id)!;
    let size:number[]|null=null;
    if(n.source==='region')size=n.room.volumes[n.index].extent.slice(0,2);
    else if(n.source==='object'||n.source==='other') {
      const dims=n.description.dimensions,rotation=n.room.occurrences[n.index][4];
      if(dims&&rotation!==null)size=rotation%2?[dims[1],dims[0]]:dims;
    }
    this.sizes.set(n.id,size);return size;
  }
  filter(f:InventoryFilter):InventoryNode[] {
    const q=clean(f.query.trim()),t=clean(f.typeQuery.trim());
    return this.nodes.filter(n=>{
      if(f.rooms&&!f.rooms.has(n.room.room)||!f.sources.has(n.source)||!f.categories.has(n.description.category)||f.disabledTypes.has(nodeType(n)))return false;
      if(n.source==='object'||n.source==='other') {
        if(isLinked(n)?!f.linked:!f.roots)return false;
        if(f.additionalOnly&&(n.source==='other'||n.description.descriptors.length>1&&!isLinked(n)))return false;
      }
      if(q&&!clean(`${nodeTitle(n)} ${n.room.name} ${n.description.id} ${n.description.category}`).includes(q))return false;
      if(t&&!clean(`${nodeTitle(n)} runtime:${n.description.runtime} selector:${n.description.selector}`).includes(t))return false;
      return true;
    });
  }
  markers(nodes:InventoryNode[],view:MapView,raw:boolean,footprints:boolean,selected:InventoryNode|null=null):MapMarker[] {
    const out:MapMarker[]=[],dots=new Set<string>();
    for(const n of nodes) {
      if(n.source==='other'&&!raw)continue;
      const x=this.coordinates[n.id*2],y=this.coordinates[n.id*2+1],px=(x-view.cx)*view.scale+view.width/2,py=(y-view.cy)*view.scale+view.height/2;
      if(!Number.isFinite(px)||!Number.isFinite(py)||px< -150||py< -150||px>view.width+150||py>view.height+150)continue;
      if(n.source==='other'){const key=`${Math.round(px)},${Math.round(py)}`;if(dots.has(key))continue;dots.add(key);}
      out.push({id:n.id,x,y,source:n.source,glyph:n.description.glyph,linked:isLinked(n),
        footprint:footprints||n.source==='region'?this.footprint(n):null,selected:n===selected});
    }
    return out;
  }
  hits(nodes:InventoryNode[],x:number,y:number,scale:number,raw:boolean):InventoryNode[] {
    const radius=Math.max(7,Math.min(18,scale*.45))/scale;
    const distance=(n:InventoryNode)=>Math.hypot(this.coordinates[n.id*2]-x,this.coordinates[n.id*2+1]-y);
    return nodes.filter(n=>(raw||n.source!=='other')&&distance(n)<radius)
      .sort((a,b)=>Number(a.source==='other')-Number(b.source==='other')||distance(a)-distance(b));
  }
  /** One record as the inspector shows and exports it: plain facts, no internal
   *  identifiers. `tile` and `layer` are in the room (tiles from its top-left
   *  corner, height layers); `mapPosition` is on the world map (the room's map
   *  position plus the tile, centred as the marker is drawn). */
  record(n:InventoryNode) {
    const actor=n.source==='actor'||n.source==='enemy'?n.room.actors[n.index]:null;
    const occurrence=n.source==='object'||n.source==='other'?n.room.occurrences[n.index]:null;
    const volume=n.source==='region'?n.room.volumes[n.index]:null;
    const tile=this.rawPosition(n).slice(0,2);
    const layer=actor?actor.position[2]:occurrence?occurrence[3]:volume?(volume.origin[2]??null):null;
    const facing=actor?actor.angle_degrees:occurrence&&occurrence[4]!==null?occurrence[4]*90:null;
    const map=Array.from(this.coordinates.subarray(n.id*2,n.id*2+2),v=>Number.isFinite(v)?Math.round(v*1000)/1000:null);
    const kind=kindNames[n.source];
    return {...(n.description.name?{name:nodeTitle(n)}:{}),kind,...(n.description.category!==kind?{category:n.description.category}:{}),room:n.room.name,
      tile,...(layer!==null?{layer}:{}),mapPosition:map,
      ...(facing!==null?{facing}:{}),...(this.footprint(n)?{footprint:this.footprint(n)}:{}),
      ...(isLinked(n)?{linked:true}:{}),
      ...(actor&&actor.enemy_definitions.length?{enemies:actor.enemy_definitions.map(e=>e.name)}:{})};
  }
  /** The download: each room with its map position and size, then the chosen
   *  records inside it. `episodes`: room id to episode name. */
  exportData(nodes:InventoryNode[],episodes:Map<number,string|null>=new Map()) {
    const rooms=new Map<MapRoomInventory,ReturnType<MapInventory['record']>[]>();
    for(const n of nodes){let list=rooms.get(n.room);if(!list)rooms.set(n.room,list=[]);list.push(this.record(n));}
    return {format:2,rooms:[...rooms].map(([r,records])=>({name:r.name,...(episodes.get(r.room)?{episode:episodes.get(r.room)}:{}),
      mapPosition:r.position,size:r.size,records})),
      unplaced:this.data.unplaced.filter(u=>[...rooms.keys()].some(r=>r.room===u.room))
        .map(u=>({name:u.name,room:[...rooms.keys()].find(r=>r.room===u.room)!.name}))};
  }
  /** Why a record sits where it does (shown under it in the inspector). */
  note(n:InventoryNode):string {
    return n.source==='region'?'Room geometry volume; its gameplay purpose is unresolved.'
      :n.source==='actor'||n.source==='enemy'?'Authored default starting position. Alternate actor records are retained separately.'
      :'Stored occupancy origin, centred using its footprint. Linked components and alternate records are retained; visibility during play is unresolved.';
  }


}
