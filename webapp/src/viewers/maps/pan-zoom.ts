// The map views' camera controls (the Maps view and the hosted world map share
// them), the way a street map app works:
//   mouse: drag to pan, scroll to zoom at the pointer, double-click to zoom in;
//   touch: one finger pans, two pinch; double-tap zooms in on the spot;
//          double-tap and hold, then slide down or up, zooms in or out
//          continuously; a two-finger tap zooms out;
//   keys:  + and - zoom, arrows pan, 0 fits.
// The camera is in map tiles (cx, cy: the centre; scale: screen pixels per tile).
export interface MapCamera {cx:number;cy:number;scale:number}
export const MIN_SCALE=.01,MAX_SCALE=512;

const TAP_MS=300;          // a tap: down and up within this, moving under TAP_SLOP
const TAP_SLOP=8;          // px
const DOUBLE_MS=300;       // a second tap this soon after the first ...
const DOUBLE_SLOP=40;      // ... this near it is a double tap
const SLIDE_ZOOM=.01;      // double-tap-and-slide: zoom factor e^(px * this)

export function attachPanZoom(canvas:HTMLCanvasElement,host:HTMLElement,camera:MapCamera,{changed,fit,tap}:{
  changed:()=>void; fit:()=>void; tap?:(x:number,y:number)=>void;
}) {
  const pointers=new Map<number,{x:number;y:number}>();
  const clamp=(s:number)=>Math.max(MIN_SCALE,Math.min(MAX_SCALE,s));
  function zoom(factor:number,x=host.clientWidth/2,y=host.clientHeight/2) {
    const next=clamp(camera.scale*factor);
    camera.cx+=(x-host.clientWidth/2)*(1/camera.scale-1/next);camera.cy+=(y-host.clientHeight/2)*(1/camera.scale-1/next);camera.scale=next;changed();
  }
  // a smooth zoom about a point (buttons, keys, double taps); any touch stops it
  let animation=0;
  function zoomBy(factor:number,x=host.clientWidth/2,y=host.clientHeight/2,ms=220) {
    cancelAnimationFrame(animation);
    const from=camera.scale,to=clamp(from*factor),start=performance.now();
    if(ms<=0||!(to!==from)){zoom(to/camera.scale,x,y);return;}
    const step=(now:number)=>{
      const k=Math.min(1,(now-start)/ms),eased=1-(1-k)**3;
      zoom(from*Math.pow(to/from,eased)/camera.scale,x,y);
      if(k<1)animation=requestAnimationFrame(step);
    };
    animation=requestAnimationFrame(step);
  }
  const point=(event:PointerEvent|WheelEvent|MouseEvent)=>{const b=host.getBoundingClientRect();return {x:event.clientX-b.left,y:event.clientY-b.top};};
  const gesture=()=>{
    const p=[...pointers.values()].slice(0,2);
    return p.length===2?{x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2,distance:Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y)}:{...p[0],distance:0};
  };
  let moved=false,startPoint:{x:number;y:number}|null=null;
  let downAt=0,lastType='mouse';
  let lastTap:{t:number;x:number;y:number}|null=null;                  // the last one-finger tap (touch)
  let slide:{x:number;y:number;scale:number}|null=null;                // double-tap-and-slide in progress
  let twoTap:{t:number;x:number;y:number}|null=null;                   // a two-finger tap in progress
  // A lift that never reached the canvas (a finger that came up over a
  // control, or whose capture failed) would leave a finger behind and turn
  // every later one-finger drag into a pinch: a new gesture's first finger
  // starts afresh, and lifts are heard wherever they land.
  const down=(e:PointerEvent)=>{
    if(e.pointerType==='mouse'&&e.button!==0)return;
    cancelAnimationFrame(animation);
    lastType=e.pointerType;
    if(e.pointerType!=='mouse')touchedAt=performance.now();
    if(e.isPrimary)pointers.clear();
    const p=point(e),now=performance.now();
    if(!pointers.size){
      moved=false;startPoint=p;downAt=now;twoTap=null;
      const double=e.pointerType!=='mouse'&&lastTap&&now-lastTap.t<DOUBLE_MS&&Math.hypot(p.x-lastTap.x,p.y-lastTap.y)<DOUBLE_SLOP;
      slide=double?{x:p.x,y:p.y,scale:camera.scale}:null;
      lastTap=null;
    }else{
      // a second finger: a pinch, or a two-finger tap if both lift quickly in place
      twoTap=!moved&&pointers.size===1&&!slide?{t:now,...gestureWith(p)}:null;
      moved=true;slide=null;
    }
    pointers.set(e.pointerId,p);
    try{canvas.setPointerCapture(e.pointerId);}catch{/* not capturable: the window still hears its lift */}
    canvas.focus();
  };
  const gestureWith=(p:{x:number;y:number})=>{const [a]=[...pointers.values()];return {x:(a.x+p.x)/2,y:(a.y+p.y)/2};};
  const move=(e:PointerEvent)=>{
    if(!pointers.has(e.pointerId))return;
    if(slide){
      // double-tap-and-slide: down zooms in, up zooms out, about the tapped spot
      const p=point(e);pointers.set(e.pointerId,p);
      if(Math.abs(p.y-slide.y)>TAP_SLOP)moved=true;
      if(moved)zoom(clamp(slide.scale*Math.exp((p.y-slide.y)*SLIDE_ZOOM))/camera.scale,slide.x,slide.y);
      return;
    }
    const old=gesture(),oldScale=camera.scale;pointers.set(e.pointerId,point(e));const next=gesture();
    if(startPoint&&Math.hypot(next.x-startPoint.x,next.y-startPoint.y)>TAP_SLOP/2)moved=true;
    if(twoTap&&(Math.abs(next.distance-old.distance)>1||Math.hypot(next.x-twoTap.x,next.y-twoTap.y)>TAP_SLOP))twoTap=null;
    if(old.distance>0&&next.distance>0)camera.scale=clamp(camera.scale*next.distance/old.distance);
    camera.cx+=(old.x-host.clientWidth/2)/oldScale-(next.x-host.clientWidth/2)/camera.scale;
    camera.cy+=(old.y-host.clientHeight/2)/oldScale-(next.y-host.clientHeight/2)/camera.scale;changed();
  };
  const up=(name:string)=>(e:Event)=>{
    const event=e as PointerEvent;if(!pointers.has(event.pointerId))return;
    const now=performance.now(),p=point(event),lift=name==='pointerup';
    if(event.pointerType!=='mouse')touchedAt=now;
    if(slide){
      if(lift&&!moved)zoomBy(2,slide.x,slide.y);   // a double tap
      slide=null;moved=true;
    }else if(twoTap){
      if(lift&&now-twoTap.t<TAP_MS)zoomBy(.5,twoTap.x,twoTap.y);   // a two-finger tap
      twoTap=null;
    }else if(lift&&!moved&&pointers.size===1){
      // a tap (a click with the mouse): reported here, the browser's own
      // click never comes for a touch (see noTouch below)
      tap?.(camera.cx+(p.x-host.clientWidth/2)/camera.scale,camera.cy+(p.y-host.clientHeight/2)/camera.scale);
      if(event.pointerType!=='mouse'&&now-downAt<TAP_MS)lastTap={t:now,x:p.x,y:p.y};
    }
    pointers.delete(event.pointerId);if(!lift)moved=true;
  };
  // a double tap selects the nearest text in some browsers (wherever it
  // is): no selection starts while a touch on the map is under way or just over
  let touchedAt=-1e9;
  const noSelect=(e:Event)=>{if(pointers.size&&lastType!=='mouse'||performance.now()-touchedAt<DOUBLE_MS*2)e.preventDefault();};
  const lifted=(e:PointerEvent)=>{if(e.target!==canvas&&pointers.delete(e.pointerId)){moved=true;slide=null;twoTap=null;}};
  // Touches on the map are the map's alone: iOS Safari otherwise runs its own
  // gestures beside the pointer events (a double tap and hold brings up the
  // text magnifier, a long press its menu), whatever touch-action and
  // user-select say. Pointer events still come.
  const noTouch=(e:Event)=>{if(e.cancelable)e.preventDefault();};
  const wheel=(e:WheelEvent)=>{e.preventDefault();cancelAnimationFrame(animation);const p=point(e);zoom(Math.exp(-e.deltaY*.002),p.x,p.y);};
  // touch double taps are handled above (the browser's own double click is not sure to come)
  const dbl=(e:MouseEvent)=>{if(lastType!=='mouse')return;const p=point(e);zoomBy(2,p.x,p.y);};
  const key=(e:KeyboardEvent)=>{
    if(e.key==='+'||e.key==='=')zoomBy(2);else if(e.key==='-')zoomBy(.5);else if(e.key==='0')fit();
    else if(e.key==='ArrowLeft')camera.cx-=host.clientWidth/camera.scale*.1;else if(e.key==='ArrowRight')camera.cx+=host.clientWidth/camera.scale*.1;
    else if(e.key==='ArrowUp')camera.cy-=host.clientHeight/camera.scale*.1;else if(e.key==='ArrowDown')camera.cy+=host.clientHeight/camera.scale*.1;else return;
    e.preventDefault();changed();
  };
  const ups=['pointerup','pointercancel','lostpointercapture'].map(name=>[name,up(name)] as const);
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);
  for(const [name,fn] of ups)canvas.addEventListener(name,fn);
  window.addEventListener('pointerup',lifted,true);window.addEventListener('pointercancel',lifted,true);
  document.addEventListener('selectstart',noSelect,true);
  for(const name of ['touchstart','touchmove','touchend','contextmenu'])canvas.addEventListener(name,noTouch,{passive:false});
  canvas.addEventListener('wheel',wheel,{passive:false});
  canvas.addEventListener('dblclick',dbl);canvas.addEventListener('keydown',key);
  return {zoom,zoomBy,destroy(){
    cancelAnimationFrame(animation);
    canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);
    for(const [name,fn] of ups)canvas.removeEventListener(name,fn);
    window.removeEventListener('pointerup',lifted,true);window.removeEventListener('pointercancel',lifted,true);
    document.removeEventListener('selectstart',noSelect,true);
    for(const name of ['touchstart','touchmove','touchend','contextmenu'])canvas.removeEventListener(name,noTouch);
    canvas.removeEventListener('wheel',wheel);
    canvas.removeEventListener('dblclick',dbl);canvas.removeEventListener('keydown',key);
  }};
}

/** The camera that fits a map-tile rectangle in the host, with a margin. */
export function fitCamera(camera:MapCamera,b:{x:number;y:number;width:number;height:number},width:number,height:number,margin=.95) {
  camera.cx=b.x+b.width/2;camera.cy=b.y+b.height/2;
  camera.scale=Math.max(MIN_SCALE,Math.min(width/b.width,height/b.height)*margin);
}
