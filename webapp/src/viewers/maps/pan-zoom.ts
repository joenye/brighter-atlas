// Drag to pan, pinch or scroll to zoom, keys to step: the map views' camera
// controls (the Maps view and the hosted world map share them). The camera is
// in map tiles (cx, cy: the centre; scale: screen pixels per tile).
export interface MapCamera {cx:number;cy:number;scale:number}
export const MIN_SCALE=.01,MAX_SCALE=512;

export function attachPanZoom(canvas:HTMLCanvasElement,host:HTMLElement,camera:MapCamera,{changed,fit,tap}:{
  changed:()=>void; fit:()=>void; tap?:(x:number,y:number)=>void;
}) {
  const pointers=new Map<number,{x:number;y:number}>();
  function zoom(factor:number,x=host.clientWidth/2,y=host.clientHeight/2) {
    const next=Math.max(MIN_SCALE,Math.min(MAX_SCALE,camera.scale*factor));
    camera.cx+=(x-host.clientWidth/2)*(1/camera.scale-1/next);camera.cy+=(y-host.clientHeight/2)*(1/camera.scale-1/next);camera.scale=next;changed();
  }
  const point=(event:PointerEvent|WheelEvent|MouseEvent)=>{const b=host.getBoundingClientRect();return {x:event.clientX-b.left,y:event.clientY-b.top};};
  const gesture=()=>{
    const p=[...pointers.values()].slice(0,2);
    return p.length===2?{x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2,distance:Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y)}:{...p[0],distance:0};
  };
  let moved=false,startPoint:{x:number;y:number}|null=null,tapPoint:{x:number;y:number}|null=null;
  const down=(e:PointerEvent)=>{
    if(e.pointerType==='mouse'&&e.button!==0)return;
    if(!pointers.size){moved=false;startPoint=point(e);}else moved=true;
    tapPoint=null;pointers.set(e.pointerId,point(e));canvas.setPointerCapture(e.pointerId);canvas.focus();
  };
  const move=(e:PointerEvent)=>{
    if(!pointers.has(e.pointerId))return;
    const old=gesture(),oldScale=camera.scale;pointers.set(e.pointerId,point(e));const next=gesture();
    if(startPoint&&Math.hypot(next.x-startPoint.x,next.y-startPoint.y)>4)moved=true;
    if(old.distance>0&&next.distance>0)camera.scale=Math.max(MIN_SCALE,Math.min(MAX_SCALE,camera.scale*next.distance/old.distance));
    camera.cx+=(old.x-host.clientWidth/2)/oldScale-(next.x-host.clientWidth/2)/camera.scale;
    camera.cy+=(old.y-host.clientHeight/2)/oldScale-(next.y-host.clientHeight/2)/camera.scale;changed();
  };
  const up=(name:string)=>(e:Event)=>{
    const event=e as PointerEvent;if(!pointers.has(event.pointerId))return;
    tapPoint=name==='pointerup'&&!moved&&pointers.size===1?point(event):null;
    pointers.delete(event.pointerId);if(name!=='pointerup')moved=true;
  };
  const click=()=>{if(tapPoint&&tap){tap(camera.cx+(tapPoint.x-host.clientWidth/2)/camera.scale,camera.cy+(tapPoint.y-host.clientHeight/2)/camera.scale);}tapPoint=null;};
  const wheel=(e:WheelEvent)=>{e.preventDefault();const p=point(e);zoom(Math.exp(-e.deltaY*.002),p.x,p.y);};
  const dbl=(e:MouseEvent)=>{const p=point(e);zoom(2,p.x,p.y);};
  const key=(e:KeyboardEvent)=>{
    if(e.key==='+'||e.key==='=')zoom(1.5);else if(e.key==='-')zoom(1/1.5);else if(e.key==='0')fit();
    else if(e.key==='ArrowLeft')camera.cx-=host.clientWidth/camera.scale*.1;else if(e.key==='ArrowRight')camera.cx+=host.clientWidth/camera.scale*.1;
    else if(e.key==='ArrowUp')camera.cy-=host.clientHeight/camera.scale*.1;else if(e.key==='ArrowDown')camera.cy+=host.clientHeight/camera.scale*.1;else return;
    e.preventDefault();changed();
  };
  const ups=['pointerup','pointercancel','lostpointercapture'].map(name=>[name,up(name)] as const);
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);
  for(const [name,fn] of ups)canvas.addEventListener(name,fn);
  canvas.addEventListener('click',click);canvas.addEventListener('wheel',wheel,{passive:false});
  canvas.addEventListener('dblclick',dbl);canvas.addEventListener('keydown',key);
  return {zoom,destroy(){
    canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);
    for(const [name,fn] of ups)canvas.removeEventListener(name,fn);
    canvas.removeEventListener('click',click);canvas.removeEventListener('wheel',wheel);
    canvas.removeEventListener('dblclick',dbl);canvas.removeEventListener('keydown',key);
  }};
}

/** The camera that fits a map-tile rectangle in the host, with a margin. */
export function fitCamera(camera:MapCamera,b:{x:number;y:number;width:number;height:number},width:number,height:number,margin=.95) {
  camera.cx=b.x+b.width/2;camera.cy=b.y+b.height/2;
  camera.scale=Math.max(MIN_SCALE,Math.min(width/b.width,height/b.height)*margin);
}
