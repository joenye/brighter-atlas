import {el} from '../ui.js';
import {download} from '../asset-export.js';
import {MapRenderer} from './maps/renderer.js';
import type {MapDocument} from '../extract/maps/index.js';
import type {IndexEntry} from '../store.js';

export function createMapView(app:any,entry:IndexEntry|null) {
  const root=el('div',{class:'map-view'}),bar=el('div',{class:'map-toolbar'});
  const canvas=el('canvas',{'aria-label':'Interactive world map',tabindex:0});
  const host=el('div',{class:'map-canvas-host'},canvas),status=el('div',{class:'map-status',role:'status',text:'Loading map...'});
  const button=(text:string,fn:()=>void)=>el('button',{class:'btn',text,onclick:fn});
  const labels=el('input',{type:'checkbox',checked:true,'aria-label':'Show room labels'});
  const episode=el('select',{'aria-label':'Map episode'},el('option',{value:'',text:'All episodes'}));
  const roomSelect=el('select',{'aria-label':'Map room',class:'map-room-select'},el('option',{value:'0',text:'Full world'}));
  const pixels=el('input',{type:'number',min:128,max:16384,step:128,value:4096,'aria-label':'PNG long edge in pixels'});
  const exportButton=button('Download PNG',()=>{void exportPng();});exportButton.disabled=true;
  bar.append(button('Fit',fit),button('+',()=>zoom(1.5)),button('-',()=>zoom(1/1.5)),
    el('label',{},labels,'Labels'),episode,roomSelect,el('label',{},'PNG long edge ',pixels,' px'),exportButton);
  root.append(bar,host,status);
  document.body.classList.add('map-active');
  let renderer:MapRenderer|null=null,doc:MapDocument|null=null,dead=false,raf=0,cx=0,cy=0,scale=1;
  const pointers=new Map<number,{x:number;y:number}>();
  const draw=()=>{
    raf=0;if(dead||!renderer)return;
    renderer.draw({cx,cy,scale,width:host.clientWidth,height:host.clientHeight,dpr:devicePixelRatio,labels:labels.checked});
    canvas.dataset.scale=String(scale);canvas.dataset.center=`${cx},${cy}`;
  };
  const requestDraw=()=>{if(!raf&&!dead)raf=requestAnimationFrame(draw);};
  function fit() {
    if(!renderer)return;const b=renderer.bounds(labels.checked);
    cx=b.x+b.width/2;cy=b.y+b.height/2;scale=Math.max(.01,Math.min(host.clientWidth/b.width,host.clientHeight/b.height)*.95);requestDraw();
  }
  function zoom(factor:number,x=host.clientWidth/2,y=host.clientHeight/2) {
    const next=Math.max(.01,Math.min(512,scale*factor));
    cx+=(x-host.clientWidth/2)*(1/scale-1/next);cy+=(y-host.clientHeight/2)*(1/scale-1/next);scale=next;requestDraw();
  }
  const point=(event:PointerEvent|WheelEvent)=>{const b=host.getBoundingClientRect();return {x:event.clientX-b.left,y:event.clientY-b.top};};
  const gesture=()=>{
    const p=[...pointers.values()].slice(0,2);
    return p.length===2?{x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2,distance:Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y)}:{...p[0],distance:0};
  };
  canvas.addEventListener('pointerdown',e=>{pointers.set(e.pointerId,point(e));canvas.setPointerCapture(e.pointerId);canvas.focus();});
  canvas.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;
    const old=gesture(),oldScale=scale;pointers.set(e.pointerId,point(e));const next=gesture();
    if(old.distance>0&&next.distance>0)scale=Math.max(.01,Math.min(512,scale*next.distance/old.distance));
    cx+=(old.x-host.clientWidth/2)/oldScale-(next.x-host.clientWidth/2)/scale;
    cy+=(old.y-host.clientHeight/2)/oldScale-(next.y-host.clientHeight/2)/scale;requestDraw();
  });
  for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,e=>pointers.delete((e as PointerEvent).pointerId));
  canvas.addEventListener('wheel',e=>{e.preventDefault();const p=point(e);zoom(Math.exp(-e.deltaY*.002),p.x,p.y);},{passive:false});
  canvas.addEventListener('dblclick',e=>{const b=host.getBoundingClientRect();zoom(2,e.clientX-b.left,e.clientY-b.top);});
  canvas.addEventListener('keydown',e=>{
    if(e.key==='+'||e.key==='=')zoom(1.5);else if(e.key==='-')zoom(1/1.5);else if(e.key==='0')fit();
    else if(e.key==='ArrowLeft')cx-=host.clientWidth/scale*.1;else if(e.key==='ArrowRight')cx+=host.clientWidth/scale*.1;
    else if(e.key==='ArrowUp')cy-=host.clientHeight/scale*.1;else if(e.key==='ArrowDown')cy+=host.clientHeight/scale*.1;else return;
    e.preventDefault();requestDraw();
  });
  labels.addEventListener('change',requestDraw);
  const resize=new ResizeObserver(()=>requestDraw());resize.observe(host);
  function selectRooms() {
    if(!renderer||!doc)return;
    const ids=new Set(doc.scene.rooms.filter(r=>(entry?.room==null||r.room===entry.room)
      &&(!episode.value||String(r.episode?.owner)===episode.value)).map(r=>r.room));
    renderer.setRooms(ids);fit();status.textContent=`${ids.size} room${ids.size===1?'':'s'}. Drag to pan, pinch or scroll to zoom.`;
    root.dataset.rooms=String(ids.size);root.dataset.tiles=String(renderer.stats.terrainTiles);exportButton.disabled=!ids.size;
  }
  episode.addEventListener('change',selectRooms);
  roomSelect.addEventListener('change',()=>{location.hash=`#/map/${roomSelect.value}`;});
  async function exportPng() {
    if(!renderer||dead)return;
    const edge=Number(pixels.value),b=renderer.bounds(labels.checked),factor=edge/Math.max(b.width,b.height);
    const width=Math.max(1,Math.round(b.width*factor)),height=Math.max(1,Math.round(b.height*factor));
    const limits=renderer.gl.getParameter(renderer.gl.MAX_VIEWPORT_DIMS) as Int32Array;
    if(!Number.isInteger(edge)||edge<128||edge>16384||width>limits[0]||height>limits[1]||width*height>64*1024*1024){
      status.textContent='This PNG size exceeds the browser limit. Choose a smaller long edge.';return;
    }
    exportButton.disabled=true;status.textContent=`Rendering ${width} x ${height} PNG...`;
    try {
      if(raf){cancelAnimationFrame(raf);raf=0;}
      renderer.draw({cx:b.x+b.width/2,cy:b.y+b.height/2,scale:factor,width,height,dpr:1,labels:labels.checked});
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('PNG encoding failed')),'image/png'));
      if(dead)return;
      const name=(entry?.name||'Full world').replace(/[^\p{L}\p{N}._-]+/gu,'-');
      download(blob,`${name}-${width}x${height}.png`);
      root.dataset.exportSize=`${width}x${height}`;status.textContent=`Downloaded ${width} x ${height} PNG.`;
    }catch(e){if(!dead)status.textContent=(e as Error).message;}
    finally {if(!dead){exportButton.disabled=false;draw();}}
  }
  void(async()=>{
    try {
      if(!app.store.manifest?.categories?.maps?.exported)throw Error('Load 2D Maps from your game files to open the map.');
      doc=await app.store.json('maps/scene.json');if(dead)return;
      if(!doc||doc.format!==1)throw Error('Map data is missing. Extract 2D Maps again.');
      renderer=new MapRenderer(canvas,doc);
      const episodes=new Map(doc.scene.rooms.flatMap(r=>r.episode?[[r.episode.owner,r.episode.name] as const]:[]));
      for(const [id,name] of episodes)episode.append(el('option',{value:id,text:name||`Episode ${id}`}));
      for(const r of [...doc.scene.rooms].sort((a,b)=>a.name.localeCompare(b.name)))roomSelect.append(el('option',{value:r.room+1,text:r.name}));
      roomSelect.value=String(entry?.i??0);selectRooms();root.dataset.ready='true';
    }catch(e){if(!dead){status.textContent=(e as Error).message;root.dataset.error=(e as Error).message;}}
  })();
  return {root,exportPng,destroy(){dead=true;resize.disconnect();if(raf)cancelAnimationFrame(raf);renderer?.destroy();document.body.classList.remove('map-active');}};
}
