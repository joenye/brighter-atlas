import {el} from '../../ui.js';
import {download} from '../../asset-export.js';
import {MapInventory,sourceNames,nodeTitle,nodeType,type InventoryNode,type InventoryFilter} from './inventory.js';
import type {MapDocument} from '../../extract/maps/index.js';
import type {MapView} from './renderer.js';

export function createMapInspection(app:any,onChange:()=>void,focus:(x:number,y:number)=>void) {
  const saved=app.mapInspectionSettings??={mode:'map',query:'',typeQuery:'',roots:true,linked:true,additionalOnly:false,
    footprints:true,raw:true,disabledSources:new Set<string>(),disabledCategories:new Set<string>(),disabledTypes:new Set<string>()};
  const toolbar=el('span',{class:'map-inspection-toolbar'});
  const mode=el('select',{'aria-label':'Map data mode'},el('option',{value:'map',text:'2D map only'}),el('option',{value:'room',text:'Additional room data'}));
  mode.value=saved.mode;
  const panel=el('aside',{class:'map-inspection',hidden:true,'aria-label':'Map filters and inspection'});
  const button=(text:string,run:()=>void)=>el('button',{class:'btn',text,onclick:run});
  const toggle=button('Filters / inspect',()=>{panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));});
  toggle.setAttribute('aria-expanded','false');toolbar.append(mode,toggle);
  const message=el('p',{class:'dim small'}),count=el('p',{class:'map-match-count',role:'status'});
  const controls=el('fieldset'),categories=el('div',{class:'map-options'}),types=el('div',{class:'map-options'});
  const selection=el('section',{class:'map-selection'}),results=el('div',{class:'map-results'}),overlaps=el('div',{class:'map-overlaps'});
  const search=el('input',{type:'search',placeholder:'Search objects or rooms','aria-label':'Search map entities',value:saved.query});
  const typeSearch=el('input',{type:'search',placeholder:'Find node types','aria-label':'Search map node types',value:saved.typeQuery});
  const categorySearch=el('input',{type:'search',placeholder:'Find categories','aria-label':'Search map categories'});
  let doc:MapDocument|null=null,inventory:MapInventory|null=null,matches:InventoryNode[]=[],selected:InventoryNode|null=null;
  let rooms:Set<number>|null=null,loading:Promise<void>|null=null,dead=false;
  const close=()=>{panel.hidden=true;toggle.setAttribute('aria-expanded','false');};
  function check(label:string,checked:boolean,change:(checked:boolean)=>void,attrs:Record<string,string>={}) {
    const input=el('input',{type:'checkbox',checked,'aria-label':label,...attrs});
    input.onchange=()=>change(input.checked);return el('label',{},input,el('span',{text:label}));
  }
  const sources=el('div',{class:'map-options map-sources'});
  for(const [key,label] of Object.entries(sourceNames))sources.append(check(label,!saved.disabledSources.has(key),v=>{
    v?saved.disabledSources.delete(key):saved.disabledSources.add(key);filter();},{'data-source':key}));
  const options=el('div',{class:'map-options'});
  for(const [key,label] of [['roots','Root placements'],['linked','Linked components'],['additionalOnly','Additional inventory only'],
    ['footprints','Show footprints'],['raw','Show other placement dots']])
    options.append(check(label,saved[key],v=>{saved[key]=v;filter();},{'data-map-option':key}));
  function drawCategories() {
    categories.replaceChildren();if(!inventory)return;
    for(const [category,n] of [...inventory.categories].sort((a,b)=>a[0].localeCompare(b[0]))) {
      if(!category.toLowerCase().includes(categorySearch.value.toLowerCase()))continue;
      const row=check(category,!saved.disabledCategories.has(category),v=>{v?saved.disabledCategories.delete(category):saved.disabledCategories.add(category);filter();},{'data-category':category});
      row.append(el('small',{text:n.toLocaleString()}));categories.append(row);
    }
  }
  function drawTypes() {
    types.replaceChildren();if(!inventory)return;
    for(const [key,t] of [...inventory.types].sort((a,b)=>a[1].name.localeCompare(b[1].name))) {
      if(!`${t.name} runtime:${t.runtime}`.toLowerCase().includes(typeSearch.value.toLowerCase()))continue;
      const row=check(t.name,!saved.disabledTypes.has(key),v=>{v?saved.disabledTypes.delete(key):saved.disabledTypes.add(key);filter();},{'data-node-type':key});
      row.title=sourceNames[t.source];row.append(el('small',{text:t.count.toLocaleString()}));types.append(row);
    }
  }
  function select(n:InventoryNode) {
    if(!inventory)return;selected=n;panel.hidden=false;toggle.setAttribute('aria-expanded','true');
    selection.replaceChildren(el('h3',{text:nodeTitle(n)}),button('Hide this node type',()=>{saved.disabledTypes.add(nodeType(n));drawTypes();filter();}),
      el('pre',{text:JSON.stringify(inventory.detail(n),null,2)}));panel.scrollTop=0;onChange();
  }
  function filter() {
    saved.query=search.value;saved.typeQuery=typeSearch.value;
    const f:InventoryFilter={sources:new Set(Object.keys(sourceNames).filter(s=>!saved.disabledSources.has(s))),
      categories:new Set([...(inventory?.categories.keys()??[])].filter(s=>!saved.disabledCategories.has(s))),disabledTypes:saved.disabledTypes,
      roots:saved.roots,linked:saved.linked,additionalOnly:saved.additionalOnly,query:saved.query,typeQuery:saved.typeQuery,rooms};
    matches=mode.value==='room'&&inventory?inventory.filter(f):[];
    toolbar.dataset.matches=String(matches.length);toolbar.dataset.mode=mode.value;
    if(selected&&!matches.includes(selected)){selected=null;selection.replaceChildren();overlaps.replaceChildren();}
    count.textContent=mode.value==='room'?`${matches.length.toLocaleString()} matching records`:'2D terrain, room names and map annotations';
    controls.disabled=mode.value!=='room'||!inventory;
    results.replaceChildren();
    if(inventory&&(saved.query||saved.typeQuery))for(const n of matches.slice(0,50))results.append(button(`${nodeTitle(n)} / ${n.room.name}`,()=>{
      focus(inventory!.coordinates[n.id*2],inventory!.coordinates[n.id*2+1]);select(n);
    }));
    onChange();
  }
  async function load() {
    if(inventory||loading||!doc?.roomData)return loading;
    message.textContent='Loading additional room placements...';
    loading=(async()=>{
      try {
        const data=await app.store.json(doc!.roomData!.file);if(dead)return;
        if(!data||data.format!==1)throw Error('Room data is missing. Extract 2D Maps again.');
        inventory=new MapInventory(data);drawCategories();drawTypes();
        const names=new Map(data.rooms.map((r:any)=>[r.room,r.name]));
        for(const r of data.unplaced)unplaced.append(button(`${r.name} / ${names.get(r.room)??r.room}`,()=>{
          selected=null;selection.replaceChildren(el('h3',{text:r.name}),el('p',{text:'This definition references the room but supplies no starting position.'}),el('pre',{text:JSON.stringify(r,null,2)}));onChange();
        }));
        message.textContent='Inspection markers show stored room data. Actor shapes and volume colours are diagnostic. Alternate records may not be active together.';
        filter();
      }catch(e){if(!dead){message.textContent=(e as Error).message;toolbar.dataset.error=message.textContent;}}
      finally{loading=null;}
    })();return loading;
  }
  mode.onchange=()=>{saved.mode=mode.value;selected=null;selection.replaceChildren();overlaps.replaceChildren();filter();void load();};
  let searchTimer:ReturnType<typeof setTimeout>|null=null;
  const scheduleFilter=()=>{if(searchTimer)clearTimeout(searchTimer);searchTimer=setTimeout(()=>{searchTimer=null;drawTypes();filter();},140);};
  search.oninput=scheduleFilter;typeSearch.oninput=scheduleFilter;categorySearch.oninput=drawCategories;
  const unplaced=el('details',{},el('summary',{text:'Unplaced room associations'}));
  const reset=button('Reset filters',()=>{
    saved.disabledSources.clear();saved.disabledCategories.clear();saved.disabledTypes.clear();
    search.value='';typeSearch.value='';categorySearch.value='';saved.roots=saved.linked=saved.footprints=saved.raw=true;saved.additionalOnly=false;
    for(const input of sources.querySelectorAll('input'))input.checked=true;
    for(const input of options.querySelectorAll('input'))input.checked=saved[input.dataset.mapOption!];
    drawTypes();drawCategories();filter();
  });
  const exportData=button('Download filtered records',()=>{
    if(!inventory)return;
    download(new Blob([JSON.stringify({mode:mode.value,filters:{...saved,disabledSources:[...saved.disabledSources],disabledCategories:[...saved.disabledCategories],disabledTypes:[...saved.disabledTypes]},
      inventory:inventory.filteredData(matches)})],{type:'application/json'}),'map-records.json');
  });
  controls.append(search,sources,options,el('details',{open:true},el('summary',{text:'Categories'}),categorySearch,
    button('All categories',()=>{saved.disabledCategories.clear();drawCategories();filter();}),
    button('No categories',()=>{saved.disabledCategories=new Set(inventory?.categories.keys());drawCategories();filter();}),categories),
    el('details',{},el('summary',{text:'Node types'}),typeSearch,button('All node types',()=>{saved.disabledTypes.clear();drawTypes();filter();}),types),reset,exportData,results,unplaced);
  panel.append(button('Close',close),message,count,selection,overlaps,controls);
  return {toolbar,panel,
    attach(value:MapDocument){doc=value;if(!doc.roomData){mode.value='map';mode.options[1].disabled=true;message.textContent='Extract 2D Maps again to include additional room placements.';}else message.textContent='Switch to additional room data to inspect objects, actor starts and volumes.';
      filter();if(mode.value==='room')void load();},
    setRooms(ids:Set<number>){rooms=ids;filter();},
    markers(view:MapView,highlight=true){return mode.value==='room'&&inventory?inventory.markers(matches,view,saved.raw,saved.footprints,highlight?selected:null):[];},
    bounds(base:{x:number;y:number;width:number;height:number}){
      let {x,y,width,height}=base,right=x+width,bottom=y+height;
      if(mode.value==='room'&&inventory)for(const n of matches){
        if(n.source==='other'&&!saved.raw)continue;
        const px=inventory.coordinates[n.id*2],py=inventory.coordinates[n.id*2+1];if(!Number.isFinite(px)||!Number.isFinite(py))continue;
        const size=saved.footprints||n.source==='region'?inventory.footprint(n):null,hw=(size?.[0]??0)/2+1,hh=(size?.[1]??0)/2+1;
        x=Math.min(x,px-hw);y=Math.min(y,py-hh);right=Math.max(right,px+hw);bottom=Math.max(bottom,py+hh);
      }
      return {x,y,width:right-x,height:bottom-y};
    },
    hit(x:number,y:number,scale:number){if(mode.value!=='room'||!inventory)return;
      const hits=inventory.hits(matches,x,y,scale,saved.raw);overlaps.replaceChildren();
      if(hits.length){overlaps.append(el('h3',{text:`${hits.length} overlapping records`}));for(const n of hits.slice(0,200))overlaps.append(button(`${nodeTitle(n)} / ${sourceNames[n.source]}`,()=>select(n)));select(hits[0]);}
    },
    get mode(){return mode.value;},get count(){return matches.length;},
    destroy(){dead=true;if(searchTimer)clearTimeout(searchTimer);}
  };
}
