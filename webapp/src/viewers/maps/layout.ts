import type {MapFont, MapFontGlyph} from '../../extract/maps/fonts.js';

export function textLine(font:MapFont,text:string,size:number,tracking:number) {
  const lookup=new Map(font.glyphs.map(g=>[g.text,g]));
  const glyphs:{glyph:MapFontGlyph;x:number}[]=[];
  let x=0,previous:number[]|undefined;
  for(const char of text){
    const glyph=lookup.get(char);if(!glyph)throw Error(`missing label glyph ${char}`);
    const m=glyph.metrics;
    x+=(previous?Math.max(...[6,8,10,12].map(i=>previous![i]-m[i-1]))+tracking:m[3])*size;
    glyphs.push({glyph,x});previous=m;
  }
  return {glyphs,width:x+(previous?.[4]??0)*size};
}
export function labelLayout(room:any) {
  const [titleWidth,titleHeight,annotationWidth,width]=room.labels.metrics[0];
  const count=room.labels.annotations.length,rowHeight=83,height=titleHeight+5+count*rowHeight;
  const [dx,dy]=room.labels.offsets[0];
  return {x:(room.roomSize[0]*64-width)/2+dx,y:(room.roomSize[1]*64-height)/2+dy,
    width,height,titleWidth,titleHeight,annotationWidth,rowHeight};
}
function annotationPanelColor(floor:number[],palette:number[]) {
  const [r,g,b]=floor,hi=Math.max(r,g,b),lo=Math.min(r,g,b),delta=hi-lo,light=(hi+lo)/2;
  let hue=0;
  if(delta)hue=(hi===r?(g-b)/delta+(g<b?6:0):hi===g?(b-r)/delta+2:(r-g)/delta+4)/6;
  const saturation=(delta?delta/(1-Math.abs(2*light-1)):0)*.3;
  const l=Math.max(.4,Math.min(.7,Math.sqrt(light)-.1));
  const c=(1-Math.abs(2*l-1))*saturation,x=c*(1-Math.abs(hue*6%2-1)),m=l-c/2;
  const rgb=[[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(hue*6)%6];
  return [...rgb.map((v,i)=>(v+m)+(palette[i]-(v+m))*128/255),1];
}
export function panelTint(color:number[]) {
  const f=Math.fround;
  return color.map((v,i)=>Math.trunc(f(Math.max(0,Math.min(1,f(f(v)*(i<3?.5:1))))*255))*(i<3?2:1)/255);
}
export function labelComposition(room:any,bounds:any) {
  const n=room.labels.annotations.length,title=room.labelFonts.title;
  const background=room.colors[({'$floor':0,'$water':1,'$bridge':2} as Record<string,number>)[room.labels.background]??3];
  const titleSize=58,annotationSize=48;
  const titleY=n?bounds.y-40:bounds.y+(bounds.height-bounds.titleHeight)/2;
  const titleX=bounds.x+(bounds.width-bounds.titleWidth)/2;
  const panels:any[]=[];
  if(n)panels.push({kind:'round',x:bounds.x-20,y:bounds.y-20,width:bounds.width+40,height:bounds.height+40,border:50,color:background});
  panels.push({kind:'panel',x:titleX-20,y:titleY-20,width:bounds.titleWidth+40,height:bounds.titleHeight+40,border:40,color:background});
  for(let i=0;i<n;i++)panels.push({kind:'panel',x:bounds.x+(bounds.width-bounds.annotationWidth)/2-20,
    y:bounds.y+bounds.titleHeight-35+i*bounds.rowHeight,width:bounds.annotationWidth+40,height:bounds.rowHeight+35,border:40,
    color:annotationPanelColor(background,room.labels.annotations[i].palette[0])});
  const lineHeight=title.lineHeight-.2,lines=room.labels.title.split('\n').length;
  const textHeight=(title.ascent+title.descent+(lines-1)*lineHeight)*titleSize;
  const titleBaseline=titleY-2+(bounds.titleHeight-textHeight)/2+title.ascent*titleSize;
  const annotation=room.labelFonts.annotation;
  const annotationBaseline=bounds.y+bounds.titleHeight-15+(bounds.rowHeight-5-(annotation.ascent+annotation.descent)*annotationSize)/2+annotation.ascent*annotationSize;
  return {panels,titleBaseline,annotationBaseline,titleLineStep:lineHeight*titleSize,titleSize,annotationSize};
}
export function annotationRowGeometry(bounds:any,index=0) {
  const f=Math.fround,left=f(f(f(f(bounds.width)-f(bounds.annotationWidth))*.5)+f(bounds.x));
  let y=f(f(f(bounds.titleHeight)+f(bounds.y))-15);
  for(let i=0;i<index;i++)y=f(y+f(bounds.rowHeight));
  return {textLeft:f(left+10),badgeX:f(f(f(f(bounds.annotationWidth)+left)-200)-5),y,badgeWidth:200,badgeHeight:bounds.rowHeight-5};
}
export function labelConnector(room:any,bounds:any) {
  const offset=room.labels.connector;
  if(offset==='$none'||offset===undefined)return null;
  if(offset.tag!==24||!offset.value?.every(Number.isFinite))throw Error('invalid connector offset');
  const f=Math.fround,anchor=room.roomSize.map((v:number,i:number)=>f(f(f(v*64)*.5)+offset.value[i]));
  const [ax,ay]=anchor,x=f(bounds.x),y=f(bounds.y),right=f(x+f(bounds.width)),bottom=f(y+f(bounds.height));
  if(ax>=x&&ax<=right&&ay>=y&&ay<=bottom)return null;
  const clamp=(v:number,lo:number,hi:number)=>v<lo?lo:v>hi?hi:v;
  const horizontal=[clamp(ax,f(x+20),f(right-20)),ay<=y?f(y+20):f(bottom-20)];
  const vertical=[ax<=x?f(x+20):f(right-20),clamp(ay,f(y+20),f(bottom-20))];
  const distance=(p:number[])=>{const dx=f(p[0]-ax),dy=f(p[1]-ay);return f(Math.sqrt(f(f(dx*dx)+f(dy*dy))));};
  const edge=distance(vertical)<=distance(horizontal)?vertical:horizontal;
  return {anchor,edge,width:60,length:distance(edge)};
}
