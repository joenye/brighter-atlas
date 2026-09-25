// Draw terrain, panels and distance-field glyphs from decoded primitives.
import {textLine,labelLayout,labelComposition,labelConnector,annotationRowGeometry,panelTint} from './layout.js';
import type {MapDocument} from '../../extract/maps/index.js';
import type {MapFont} from '../../extract/maps/fonts.js';
import type {MapBitmap} from '../../extract/maps/images.js';
const unpack555=(c:number)=>[(c>>>10&31)/31,(c>>>5&31)/31,(c&31)/31];
const STRIDE=20;
const vertex=`#version 300 es
precision highp float;
layout(location=0) in vec2 origin;
layout(location=1) in vec4 axes;
layout(location=2) in vec4 uv;
layout(location=3) in vec4 color;
layout(location=4) in vec4 detail;
layout(location=5) in vec2 params;
uniform vec2 camera;
uniform vec2 viewport;
uniform float scale;
out vec2 texcoord;
flat out vec4 tint;
flat out vec4 extra;
flat out vec4 uvBounds;
flat out int kind;
vec4 edges(float size,bool badge,bool classic){
 if(!badge){
  float outer=5.0/size,inner=4.0/size;
  float weight=(0.6-0.5)+64.0/255.0;
  float high=(outer-weight)+1.0,low=max(0.0,high-(inner+outer));
  return floor(clamp(vec4(high,low,0,0),0.0,1.0)*65535.0)/65535.0;
 }
 float a=5.0/size,b=4.0/size,c=3.0/size,d=4.0/size;
 float base=min((((classic?0.6:0.53)-0.5)+64.0/255.0)-a,1.0);
 float high=1.0-base,gap=min(((classic?0.25:0.1)-b)-c,high);
 a=a+b;d=d+c;
 if(((base+a)+gap)+d>1.0){float ratio=a/(d+a),available=high-gap;d=(1.0-ratio)*available;a=available*ratio;}
 float low=high-a,outlineHigh=low-gap,outlineLow=outlineHigh-d;
 return floor(clamp(vec4(high,low,outlineHigh,outlineLow),0.0,1.0)*255.0)/255.0;
}
void main(){
 vec2 corner=vec2(gl_VertexID&1,gl_VertexID>>1);
 vec2 p=origin+axes.xy*corner.x+axes.zw*corner.y;
 vec2 pixel=(p-camera)*scale+viewport*0.5;
 kind=int(params.x);tint=color;extra=(kind==2||kind==3||kind==5)?edges(params.y*scale,kind!=2,kind==5):detail;
 texcoord=uv.xy+uv.zw*corner;uvBounds=vec4(uv.xy,uv.xy+uv.zw);
 gl_Position=vec4(pixel.x/viewport.x*2.0-1.0,1.0-pixel.y/viewport.y*2.0,kind==0?detail.w*2.0-1.0:0.0,1.0);
}`;
const fragment=`#version 300 es
precision highp float;
uniform sampler2D atlas;
uniform float lod;
uniform vec2 texel;
in vec2 texcoord;
flat in vec4 tint;
flat in vec4 extra;
flat in vec4 uvBounds;
flat in int kind;
out vec4 result;
float coverage(float v,float lo,float hi){float t=clamp((v-lo)/max(hi-lo,0.0000001),0.0,1.0);return t*t*(3.0-2.0*t);}
void main(){
 if(kind==0){
  vec4 t=textureLod(atlas,texcoord,lod);
  result=vec4(t.r*tint.rgb*t.g*(1.0-t.a)+t.b*extra.rgb*t.a,t.g*(1.0-t.a)+t.a);
 }else if(kind==1){
  vec4 t=texture(atlas,texcoord);result=vec4(t.rgb*tint.rgb*tint.a,t.a*tint.a);
 }else if(kind==4){
  vec2 p=texcoord*2.0-1.0;
  if(extra.x==1.0&&dot(p,p)>1.0)discard;
  if(extra.x==2.0&&abs(p.x)+abs(p.y)>1.0)discard;
  if(extra.x==3.0&&(p.y< -1.0||abs(p.x)>(p.y+1.0)*0.5))discard;
  result=vec4(tint.rgb*tint.a,tint.a);
 }else{
  float value=texture(atlas,clamp(texcoord,uvBounds.xy+texel*0.5,uvBounds.zw-texel*0.5)).a;
  if(kind==3||kind==5){
   if(value>=extra.y)result=vec4(tint.rgb*coverage(value,extra.y,extra.x),1.0);
   else result=vec4(0,0,0,coverage(value,extra.w,extra.z));
  }else{float a=coverage(value,extra.y,extra.x)*tint.a;result=vec4(tint.rgb*a,a);}
 }
}`;
function program(gl:WebGL2RenderingContext){
 const compile=(type:number,source:string)=>{const s=gl.createShader(type)!;gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s)??'shader compilation failed');return s;};
 const p=gl.createProgram()!,vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment);
 gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);gl.deleteShader(vs);gl.deleteShader(fs);
 if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p)??'shader linking failed');return p;
}
function quad(list:number[],texture:{width:number;height:number},rect:number[],source:number[],color:number[]=[1,1,1,1],kind=1,size=0,axes:number[]|null=null,detail:number[]=[0,0,0,0]){
 const [x,y,w,h]=rect,[sx,sy,sw,sh]=source;
 list.push(x,y,...(axes??[w,0,0,h]),sx/texture.width,sy/texture.height,sw/texture.width,sh/texture.height,...color,...detail,kind,size);
}
function nineSlice(list:number[],image:any,source:any,panel:any,offset:number[]){
 const [sx,sy,sw,sh]=source.sourceRect,cut=(panel.sourceBorder??panel.border)/source.scale;
 const xs=[sx,sx+cut,sx+sw-cut,sx+sw],ys=[sy,sy+cut,sy+sh-cut,sy+sh];
 const dx=[panel.x,panel.x+panel.border,panel.x+panel.width-panel.border,panel.x+panel.width];
 const dy=[panel.y,panel.y+panel.border,panel.y+panel.height-panel.border,panel.y+panel.height];
 for(let y=0;y<3;y++)for(let x=0;x<3;x++)quad(list,image,
  [offset[0]+dx[x],offset[1]+dy[y],dx[x+1]-dx[x],dy[y+1]-dy[y]],
  [xs[x],ys[y],xs[x+1]-xs[x],ys[y+1]-ys[y]],panelTint(panel.color));
}
// Labels need their fonts. Without a panel image a label sits on a plain panel
// of the same colour; a missing connector or badge image is left out.
function makeLabels(scene:any,images:Record<string,MapBitmap>){
 const passes=Array.from({length:7},()=>[] as number[]);
 const textures=['connector','round','panel','panel','badge','glyphs','glyphs'].map(name=>images[name]?name:'glyphs');
 if(!scene.labelFonts.title)return passes.map((rows,i)=>({texture:textures[i],rows:new Float32Array(rows)}));
 for(const r of scene.rooms){
  const room={...r,labelFonts:scene.labelFonts,badgeWidth:scene.labelBadgeWidth};
  const bounds=labelLayout(room),composition=labelComposition(room,bounds),offset=r.mapPosition.map((v:number)=>v*64);
  const connector=labelConnector(room,bounds);
  if(connector&&images.connector){const {anchor,edge,width,length}=connector,dx=(edge[0]-anchor[0])/length,dy=(edge[1]-anchor[1])/length;
   quad(passes[0],images.connector,[offset[0]+anchor[0]-dy*width/2,offset[1]+anchor[1]+dx*width/2,width,length],
    [0,0,images.connector.width,images.connector.height],[1,1,1,1],1,0,[dy*width,-dx*width,dx*length,dy*length]);
  }
  for(const [i,panel] of composition.panels.entries()){
   const pass=panel.kind==='round'?1:i===(r.labels.annotations.length?1:0)?2:3;
   if(images[panel.kind]&&scene.labelBackgrounds[panel.kind])nineSlice(passes[pass],images[panel.kind],scene.labelBackgrounds[panel.kind],panel,offset);
   else quad(passes[pass],{width:1,height:1},[offset[0]+panel.x,offset[1]+panel.y,panel.width,panel.height],[0,0,1,1],panelTint(panel.color),4);
  }
  function paint(pass:number,font:MapFont,text:string,size:number,tracking:number,baseline:number,color:number[],{left,center=bounds.x+bounds.width/2,runs,badge=false}:{left?:number;center?:number;runs?:any[];badge?:boolean}={}){
   const line=textLine(font,text,size,tracking);left??=center-line.width/2;
   const colors=runs?.flatMap(run=>Array.from(run.text,()=>run.color));
   for(const [index,{glyph,x}] of line.glyphs.entries()){
    if(!glyph.visible)continue;const b=glyph.bitmap!,[,,w,h]=b.rect;
    quad(passes[pass],images.glyphs,[offset[0]+left+x-size/b.em,offset[1]+baseline-glyph.metrics[0]*size-size/b.em,w*size/b.em,h*size/b.em],
     b.rect,b.color?[1,1,1,1]:[...(colors?.[index]??color).map((v:number)=>v/255),1],b.color?1:badge?(bounds.fixed?5:3):2,size);
   }
  }
  r.labels.title.split('\n').forEach((line:string,i:number)=>paint(6,scene.labelFonts.title,line,composition.titleSize,.02,composition.titleBaseline+i*composition.titleLineStep,[255,255,255]));
  if(!scene.labelFonts.annotation)continue;
  r.labels.annotations.forEach((a:any,i:number)=>{
   const row=annotationRowGeometry(bounds,i);
   paint(5,scene.labelFonts.annotation,a.text,composition.annotationSize,.01,composition.annotationBaseline+i*bounds.rowHeight,[0,0,0],{left:row.textLeft});
   if(bounds.fixed){
    if(a.marker.symbol!=='$none'&&images.badge)quad(passes[4],images.badge,
     [offset[0]+row.badgeX,offset[1]+row.y,row.badgeWidth,row.badgeHeight],[0,0,images.badge.width,images.badge.height],a.palette[0]);
    if(a.badge)paint(5,scene.labelFonts.annotation,a.badge.text,a.badge.size,.01,
     row.y+Math.fround(6.3)+scene.labelFonts.annotation.ascent*a.badge.size,a.palette[0].slice(0,3).map((v:number)=>v*255),
     {center:row.badgeX+row.badgeWidth/2,badge:true});
    return;
   }
   if(a.badge){
    const source=scene.labelBackgrounds.badge;
    if(source&&images.badge){
     const [width,height]=source.dimensions,cut=source.sourceBorder,destCut=cut*source.scale;
     const xs=[0,cut,width-cut,width],dx=[row.badgeX,row.badgeX+destCut,row.badgeX+row.badgeWidth-destCut,row.badgeX+row.badgeWidth];
     for(let j=0;j<3;j++)quad(passes[4],images.badge,[offset[0]+dx[j],offset[1]+row.y,dx[j+1]-dx[j],row.badgeHeight],[xs[j],0,xs[j+1]-xs[j],height],[...a.palette[2].slice(0,3),.8]);
    }
    paint(5,scene.labelFonts.annotation,a.badge.text,a.badge.size,.01,
     row.y+Math.fround(Math.fround(row.badgeHeight)*Math.fround(.11))+scene.labelFonts.annotation.ascent*a.badge.size,[255,255,255],{center:row.badgeX+row.badgeWidth/2,runs:a.badge.runs,badge:true});
   }
  });
 }
 return passes.map((rows,i)=>({texture:textures[i],rows:new Float32Array(rows)}));
}
function makeTerrain(scene:any){
 const count=scene.shingles.reduce((n:number,s:any)=>n+s.tiles.filter(Boolean).length,0),data=new Float32Array(count*STRIDE);let cursor=0;
 for(const s of scene.shingles){const base=unpack555(s.base555),corners=s.corners555.map(unpack555);
  for(let t=0;t<16;t++){const id=s.tiles[t];if(!id)continue;const x=t&3,y=t>>>2;
   data.set([(s.position[0]*2+x)*32,(s.position[1]*2+y)*32,32,0,0,32,
    ((id%12)*40+4)/scene.atlas.width,(Math.floor(id/12)*40+4)/scene.atlas.height,32/scene.atlas.width,32/scene.atlas.height,
    ...base,1,...corners[(y>>>1)*2+(x>>>1)],id<=12?.4:.3,0,0],cursor);cursor+=STRIDE;
  }
 }
 return data;
}

export interface MapMarker {
  id:number;x:number;y:number;source:'object'|'other'|'actor'|'enemy'|'region';glyph:number|null;
  footprint:number[]|null;linked:boolean;selected:boolean;
}
export interface MapView {cx:number;cy:number;scale:number;width:number;height:number;dpr?:number;labels?:boolean;markers?:MapMarker[]}
function makeMarkers(view:MapView,doc:MapDocument) {
  const rows:number[]=[],unit=64/view.scale,glyphs=new Map((doc.scene.labelFonts.annotation?.glyphs??[]).map(g=>[g.glyph,g]));
  const colors={region:[.706,.631,.812],actor:[.49,.812,1],enemy:[1,.671,.471],object:[.502,.882,.729],other:[.788,.827,.875]};
  const solid=(rect:number[],color:number[],shape=0)=>quad(rows,{width:1,height:1},rect,[0,0,1,1],color,4,0,null,[shape,0,0,0]);
  const outline=(x:number,y:number,w:number,h:number,color:number[],thickness=unit)=>{
    solid([x,y,w,thickness],color);solid([x,y+h-thickness,w,thickness],color);
    solid([x,y,thickness,h],color);solid([x+w-thickness,y,thickness,h],color);
  };
  for(const m of view.markers??[]) {
    const x=m.x*64,y=m.y*64,color=m.linked?[.792,.651,1]:colors[m.source];
    if(m.footprint&&view.scale>=5){
      const w=m.footprint[0]*64,h=m.footprint[1]*64;
      solid([x-w/2,y-h/2,w,h],[...color,.075]);outline(x-w/2,y-h/2,w,h,[...color,.6]);
    }
    const g=m.glyph===null?null:glyphs.get(m.glyph),b=g?.bitmap;
    if(m.source==='other')solid([x-unit,y-unit,unit*2,unit*2],[...color,.33]);
    else if(m.source==='region'){if(view.scale>=5)solid([x-unit*2,y-unit*2,unit*4,unit*4],[...color,1]);}
    else if(b&&view.scale>=3) {
      const [,,w,h]=b.rect,side=Math.max(9,Math.min(34,view.scale*.85))*unit,f=side/Math.max(w,h);
      quad(rows,doc.images.glyphs,[x-w*f/2,y-h*f/2,w*f,h*f],b.rect,b.color?[1,1,1,1]:[0,0,0,1],b.color?1:2,f*b.em);
    }else{
      const side=Math.max(2,Math.min(7,view.scale*.28))*unit,shape=m.source==='actor'?2:m.source==='enemy'?3:1;
      solid([x-side-unit,y-side-unit,(side+unit)*2,(side+unit)*2],[.067,.067,.067,1],shape);
      solid([x-side,y-side,side*2,side*2],[...color,1],shape);
    }
    if(m.selected)outline(x-unit*12,y-unit*12,unit*24,unit*24,[1,1,1,1],unit*2);
  }
  return new Float32Array(rows);
}
type BufferBatch={vao:WebGLVertexArrayObject;buffer:WebGLBuffer;count:number;texture?:string};
export class MapRenderer {
  readonly gl:WebGL2RenderingContext;
  private scene:MapDocument['scene'];
  private geometry:Float32Array=new Float32Array();
  private labels:ReturnType<typeof makeLabels>=[];
  private program:WebGLProgram|null=null;
  private textures=new Map<string,{texture:WebGLTexture;width:number;height:number}>();
  private buffers:BufferBatch[]=[];
  private uniforms:Record<string,WebGLUniformLocation|null>={};
  private view:MapView|null=null;
  private lost=false;
  readonly stats={terrainTiles:0,markers:0};
  private onLost=(e:Event)=>{e.preventDefault();this.lost=true;};
  private onRestored=()=>{this.lost=false;this.setup();this.upload();if(this.view)this.draw(this.view);};
  constructor(readonly canvas:HTMLCanvasElement,readonly doc:MapDocument) {
    const gl=canvas.getContext('webgl2',{alpha:true,antialias:false,depth:true,premultipliedAlpha:true});
    if(!gl)throw Error('2D maps require WebGL 2.');
    this.gl=gl;this.scene=doc.scene;this.setup();
    canvas.addEventListener('webglcontextlost',this.onLost);
    canvas.addEventListener('webglcontextrestored',this.onRestored);
  }
  setRooms(ids:Set<number>|null) {
    const rooms=ids?this.doc.scene.rooms.filter(r=>ids.has(r.room)):this.doc.scene.rooms;
    const owners=new Set(rooms.map(r=>r.owner));
    this.scene={...this.doc.scene,rooms,shingles:this.doc.scene.shingles.filter(s=>owners.has(s.room))};
    this.geometry=makeTerrain(this.scene);this.labels=makeLabels(this.scene,this.doc.images);
    this.stats.terrainTiles=this.geometry.length/STRIDE;
    if(!this.lost)this.upload();
  }
  bounds(labels=true) {
    let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
    for(const rows of [this.geometry,...(labels?this.labels.map(p=>p.rows):[])])for(let i=0;i<rows.length;i+=STRIDE){
      for(const [a,b] of [[0,0],[1,0],[0,1],[1,1]]){
        const px=rows[i]+rows[i+2]*a+rows[i+4]*b,py=rows[i+1]+rows[i+3]*a+rows[i+5]*b;
        x=Math.min(x,px);y=Math.min(y,py);right=Math.max(right,px);bottom=Math.max(bottom,py);
      }
    }
    if(!Number.isFinite(x))return {x:0,y:0,width:1,height:1};
    return {x:x/64-1,y:y/64-1,width:(right-x)/64+2,height:(bottom-y)/64+2};
  }
  private releaseBuffers() {
    for(const b of this.buffers){this.gl.deleteBuffer(b.buffer);this.gl.deleteVertexArray(b.vao);}this.buffers=[];
  }
  private release() {
    const gl=this.gl;this.releaseBuffers();
    for(const t of this.textures.values())gl.deleteTexture(t.texture);this.textures.clear();
    if(this.program)gl.deleteProgram(this.program);this.program=null;
  }
  // Program and textures are built once per context; room changes only
  // replace the vertex buffers.
  private setup() {
    this.release();const gl=this.gl,p=this.program=program(gl);gl.useProgram(p);
    this.uniforms=Object.fromEntries(['camera','viewport','scale','lod','texel'].map(k=>[k,gl.getUniformLocation(p,k)]));
    gl.uniform1i(gl.getUniformLocation(p,'atlas'),0);gl.disable(gl.DITHER);gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.depthFunc(gl.LEQUAL);
    const texture=(name:string,width:number,height:number)=>{
      const t=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      this.textures.set(name,{texture:t,width,height});
    };
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
    texture('terrain',this.scene.atlas.width,this.scene.atlas.height);
    for(const [i,m] of this.doc.terrainMips.entries())gl.texImage2D(gl.TEXTURE_2D,i,gl.RGBA,m.width,m.height,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(m.rgba));
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,this.doc.terrainMips.length-1);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_NEAREST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
    for(const [name,image] of Object.entries(this.doc.images)) {
      const surface=document.createElement('canvas');surface.width=image.width;surface.height=image.height;
      surface.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.rgba),image.width,image.height),0,0);
      texture(name,image.width,image.height);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,surface);
    }
  }
  private upload() {
    this.releaseBuffers();const gl=this.gl;
    for(const [i,rows] of [this.geometry,...this.labels.map(p=>p.rows),new Float32Array()].entries()){
      const vao=gl.createVertexArray()!,buffer=gl.createBuffer()!;gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,rows,gl.STATIC_DRAW);
      let offset=0;for(const [j,size] of [2,4,4,4,4,2].entries()){
        gl.enableVertexAttribArray(j);gl.vertexAttribPointer(j,size,gl.FLOAT,false,STRIDE*4,offset*4);gl.vertexAttribDivisor(j,1);offset+=size;
      }
      this.buffers.push({vao,buffer,count:rows.length/STRIDE,texture:i===this.labels.length+1?'glyphs':i?this.labels[i-1].texture:'terrain'});
    }
  }
  draw(view:MapView) {
    this.view=view;if(this.lost||!this.buffers.length)return;
    const {cx,cy,scale,width,height,dpr=1,labels=true}=view,gl=this.gl,u=this.uniforms;
    const w=Math.round(width*dpr),h=Math.round(height*dpr);if(!w||!h)return;
    if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
    gl.viewport(0,0,w,h);gl.useProgram(this.program);gl.uniform2f(u.camera,cx*64,cy*64);gl.uniform2f(u.viewport,w,h);gl.uniform1f(u.scale,scale*dpr/64);
    const lod=Math.floor(Math.max(0,Math.min(this.doc.terrainMips.length-1,Math.log2(64/(scale*dpr))-.5))+.5);gl.uniform1f(u.lod,lod);
    gl.depthMask(true);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);
    const markerBuffer=this.buffers.at(-1)!,markers=makeMarkers(view,this.doc);
    gl.bindBuffer(gl.ARRAY_BUFFER,markerBuffer.buffer);gl.bufferData(gl.ARRAY_BUFFER,markers,gl.DYNAMIC_DRAW);markerBuffer.count=markers.length/STRIDE;
    this.stats.markers=view.markers?.length??0;
    for(const [i,b] of this.buffers.entries()){
      if(i===1){gl.disable(gl.DEPTH_TEST);gl.depthMask(false);}if(!b.count||(!labels&&i&&b!==markerBuffer))continue;
      const t=this.textures.get(b.texture!)!;gl.bindTexture(gl.TEXTURE_2D,t.texture);gl.uniform2f(u.texel,1/t.width,1/t.height);
      gl.bindVertexArray(b.vao);gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,b.count);
    }
  }
  destroy() {
    this.canvas.removeEventListener('webglcontextlost',this.onLost);this.canvas.removeEventListener('webglcontextrestored',this.onRestored);
    this.release();this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
