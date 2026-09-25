import {el} from '../ui.js';
import {download} from '../asset-export.js';
import {MapRenderer} from './maps/renderer.js';
import {createMapInspection} from './maps/inspection.js';
import {attachPanZoom,fitCamera} from './maps/pan-zoom.js';
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
  const workspace=el('div',{class:'map-workspace'},host);root.append(bar,workspace,status);
  document.body.classList.add('map-active');
  let renderer:MapRenderer|null=null,doc:MapDocument|null=null,dead=false,exporting=false,raf=0;
  const camera={cx:0,cy:0,scale:1};
  const draw=()=>{
    raf=0;if(dead||exporting||!renderer)return;
    const view={...camera,width:host.clientWidth,height:host.clientHeight,dpr:devicePixelRatio,labels:labels.checked};
    renderer.draw({...view,markers:inspection.markers(view)});
    canvas.dataset.scale=String(camera.scale);canvas.dataset.center=`${camera.cx},${camera.cy}`;
    root.dataset.matches=String(inspection.count);root.dataset.markers=String(renderer.stats.markers);
  };
  const requestDraw=()=>{if(!raf&&!dead)raf=requestAnimationFrame(draw);};
  const inspection=createMapInspection(app,requestDraw,(x,y)=>{if(!Number.isFinite(x)||!Number.isFinite(y))return;camera.cx=x;camera.cy=y;camera.scale=Math.max(25,camera.scale);requestDraw();});
  bar.append(inspection.toolbar);workspace.append(inspection.panel);
  function fit() {
    if(!renderer)return;fitCamera(camera,inspection.bounds(renderer.bounds(labels.checked)),host.clientWidth,host.clientHeight);requestDraw();
  }
  const panZoom=attachPanZoom(canvas,host,camera,{changed:requestDraw,fit,tap:(x,y)=>inspection.hit(x,y,camera.scale)});
  const zoom=panZoom.zoom;
  labels.addEventListener('change',requestDraw);
  const resize=new ResizeObserver(()=>requestDraw());resize.observe(host);
  function selectRooms() {
    if(!renderer||!doc)return;
    const ids=new Set(doc.scene.rooms.filter(r=>(entry?.room==null||r.room===entry.room)
      &&(!episode.value||String(r.episode?.owner)===episode.value)).map(r=>r.room));
    renderer.setRooms(ids);inspection.setRooms(ids);fit();status.textContent=`${ids.size} room${ids.size===1?'':'s'}. Drag to pan, pinch or scroll to zoom. Tap a marker to inspect.`;
    root.dataset.rooms=String(ids.size);root.dataset.tiles=String(renderer.stats.terrainTiles);exportButton.disabled=!ids.size;
  }
  episode.addEventListener('change',selectRooms);
  roomSelect.addEventListener('change',()=>{location.hash=`#/map/${roomSelect.value}`;});
  async function exportPng() {
    if(!renderer||dead||exporting)return;
    const edge=Number(pixels.value),b=inspection.bounds(renderer.bounds(labels.checked)),factor=edge/Math.max(b.width,b.height);
    const width=Math.max(1,Math.round(b.width*factor)),height=Math.max(1,Math.round(b.height*factor));
    if(!Number.isInteger(edge)||edge<128||edge>16384||width*height>64*1024*1024){
      status.textContent='This PNG size exceeds the browser limit. Choose a smaller long edge.';return;
    }
    exporting=true;exportButton.disabled=true;episode.disabled=true;status.textContent=`Rendering ${width} x ${height} PNG...`;
    try {
      if(raf){cancelAnimationFrame(raf);raf=0;}
      const view={cx:b.x+b.width/2,cy:b.y+b.height/2,scale:factor,width,height,dpr:1,labels:labels.checked};
      const markers=inspection.markers(view,false);root.dataset.exportMarkers=String(markers.length);
      // A valid viewport size can still exceed the GPU's drawing-buffer
      // budget. Small native renders avoid silently downscaled exports.
      const output=el('canvas',{width,height}),context=output.getContext('2d');
      if(!context)throw Error('PNG canvas is unavailable.');
      const limits=renderer.gl.getParameter(renderer.gl.MAX_VIEWPORT_DIMS) as Int32Array;
      const tile=Math.min(2048,limits[0],limits[1]);
      if(tile<1)throw Error('PNG rendering is unavailable.');
      for(let y=0;y<height;y+=tile)for(let x=0;x<width;x+=tile){
        if(dead)return;
        const w=Math.min(tile,width-x),h=Math.min(tile,height-y);
        renderer.draw({...view,width:w,height:h,
          cx:view.cx+(x+w/2-width/2)/factor,
          cy:view.cy+(y+h/2-height/2)/factor,markers});
        if(renderer.gl.drawingBufferWidth!==w||renderer.gl.drawingBufferHeight!==h)
          throw Error('The browser could not render the requested PNG resolution. Choose a smaller size.');
        context.drawImage(canvas,x,y);
        await new Promise<void>(resolve=>setTimeout(resolve,0));
      }
      const blob=await new Promise<Blob>((resolve,reject)=>output.toBlob(b=>b?resolve(b):reject(Error('PNG encoding failed')),'image/png'));
      if(dead)return;
      const name=(entry?.name||'Full world').replace(/[^\p{L}\p{N}._-]+/gu,'-');
      download(blob,`${name}-${width}x${height}.png`);
      root.dataset.exportSize=`${width}x${height}`;status.textContent=`Downloaded ${width} x ${height} PNG.`;
    }catch(e){if(!dead)status.textContent=(e as Error).message;}
    finally {exporting=false;if(!dead){exportButton.disabled=false;episode.disabled=false;draw();}}
  }
  void(async()=>{
    try {
      if(!app.store.manifest?.categories?.maps?.exported)throw Error('Load 2D Maps from your game files to open the map.');
      doc=await app.store.json('maps/scene.json');if(dead)return;
      if(!doc||doc.format!==1)throw Error('Map data is missing. Extract 2D Maps again.');
      renderer=new MapRenderer(canvas,doc);
      inspection.attach(doc);
      const episodes=new Map(doc.scene.rooms.flatMap(r=>r.episode?[[r.episode.owner,r.episode.name] as const]:[]));
      for(const [id,name] of episodes)episode.append(el('option',{value:id,text:name||`Episode ${id}`}));
      for(const r of [...doc.scene.rooms].sort((a,b)=>a.name.localeCompare(b.name)))roomSelect.append(el('option',{value:r.room+1,text:r.name}));
      roomSelect.value=String(entry?.i??0);selectRooms();root.dataset.ready='true';
    }catch(e){if(!dead)status.textContent=(e as Error).message;}
  })();
  return {root,exportPng,destroy(){dead=true;panZoom.destroy();resize.disconnect();inspection.destroy();if(raf)cancelAnimationFrame(raf);renderer?.destroy();document.body.classList.remove('map-active');}};
}
