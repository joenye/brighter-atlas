// Entirely synthetic pixels and layout records for the map browser test.
export function mapFixture() {
  const bitmap=(width:number,height:number,pixel:(x:number,y:number)=>number[])=>({width,height,
    rgba:Array.from({length:width*height},(_,i)=>pixel(i%width,Math.floor(i/width))).flat()});
  const atlas=bitmap(480,40,()=>[255,255,0,0]);
  const white=bitmap(128,128,()=>[255,255,255,255]);
  const glyphs=bitmap(16,16,(x,y)=>[255,255,255,x>2&&x<13&&y>2&&y<13?255:0]);
  const glyph=(text:string,index:number)=>({glyph:index,text,slot:index,variants:[index],visible:true,
    metrics:[.3,0,.3,0,.3,0,.3,0,.3,0,.3,0,.3],auxiliary1:null,auxiliary2:null,
    bitmap:{ab3:0,record:0,face:0,atlasOwner:0,color:false,width:16,height:16,em:50,storageRotation:0,correctionDegrees:0,rect:[0,0,16,16]}});
  const font={slot:0,faces:[],sizeRange:[1,4],ascent:.3,descent:0,lineHeight:1,glyphs:[glyph('A',0),glyph('B',1)]};
  const sprite={slot:0,ab3:0,mip:0,scale:1,canvas:[128,128],trims:[0,0,0,0],padding:[0,0,0,0],rotated:false,
    sourceRect:[0,0,128,128],nominalSize:[128,128],dimensions:[128,128]};
  const rooms=[0,1].map(i=>({room:i+10,owner:i,name:i?'Blue room':'Amber room',episode:{owner:i,name:i?'Below':'Above'},
    mapPosition:[i*5,0],roomSize:[2,2],colors:Array(4).fill(i?[.2,.4,.8,1]:[.8,.4,.2,1]),
    labels:{title:i?'B':'A',glyphs:[i],offsets:[[0,0],[0,0]],metrics:[[40,40,0,40],[40,40,0,40]],
      background:'$floor',connector:'$none',annotations:[],annotationEntries:[]}}));
  const scene={rooms,shingles:rooms.map((r,i)=>({index:i,room:r.owner,position:r.mapPosition,group:0,
    base555:i?0x199f:0x7d80,corners555:[0,0,0,0],tiles:Array(16).fill(1)})),
    labelFonts:{title:font,annotation:font},labelBackgrounds:{round:sprite,panel:sprite,connector:{...sprite,width:60},badge:{...sprite,sourceBorder:2,scale:1.3}},
    atlas:{width:480,height:40}};
  const resource=(id:number,name:string|null,described:boolean,glyph:number|null,dimensions:number[]|null)=>({id,name,glyph,dimensions,
    runtime:id+500,selector:id+600,qualifier:null,category:described?'Gathering':'Other placement',iconResource:null,
    descriptors:described?[{field:30,name,qualifier:null,glyph,category:'Gathering',iconResource:null}]:[]});
  const actor=(record:number,label:string,enemy:boolean)=>({record,label,authored_label:label,runtime:800+record,selector:900+record,
    position:[3,1,0],centre_offset:1.5,centre_field_op:7,rotation_quarters:1,angle_degrees:90,
    enemy_definitions:enemy?[{record:record+10,name:label}]:[],memberships:[{kind:'default_room',field_op:20,series_index:-1,leaf_index:-1}],
    default_room_record:0,default_room_field_op:20,direction_resource:22,location_field_op:21,location_series_index:0,location_class:7,
    direction_field_op:2,label_field_op:5,parts:[],appearance_confidence:null});
  const roomData={format:1,resources:[resource(100,'Gathering node',true,0,[2,1]),resource(101,null,false,null,[1,1]),resource(102,'Storage',true,1,null)],
    rooms:rooms.map((r,i)=>({room:r.room,owner:r.owner,name:r.name,position:r.mapPosition,size:r.roomSize,
      occurrences:i?[[102,0,0,0,0,40,0,null,[],null,0]]:[
        [100,0,0,0,0,20,0,null,[[1,0,0]],null,0],
        [100,1,0,1,1,21,0,[0,0,0],[],null,1],
        [101,0,1,0,0,22,0,null,[],null,0]],
      actors:i?[]:[actor(200,'Guide',false),actor(201,'Fiend',true)],
      volumes:i?[]:[{field_op:8,typed_class:9,path:[],origin:[0,0,0],extent:[2,2,1]}]})),
    unplaced:[{room:10,name:'Unplaced creature',def_slot:77,roster_slot:78}]};
  const doc={format:1,scene,terrainMips:[atlas],images:{glyphs,round:white,panel:white,connector:white,badge:white},roomData:{file:'maps/room-data.json',records:7}};
  const index=[{i:0,room:null,name:'Full world'},...rooms.map(r=>({i:r.room+1,room:r.room,name:r.name,episode:r.episode}))];
  return {doc,index,roomData,manifest:{game:'Synthetic maps',categories:{maps:{count:3,exported:3,index:'index/maps.json'}}}};
}
