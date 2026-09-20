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
  const doc={format:1,scene,terrainMips:[atlas],images:{glyphs,round:white,panel:white,connector:white,badge:white}};
  const index=[{i:0,room:null,name:'Full world'},...rooms.map(r=>({i:r.room+1,room:r.room,name:r.name,episode:r.episode}))];
  return {doc,index,manifest:{game:'Synthetic maps',categories:{maps:{count:3,exported:3,index:'index/maps.json'}}}};
}
