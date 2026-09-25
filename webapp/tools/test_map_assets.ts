// Synthetic colour and font cases, including square icons whose rotation
// cannot be inferred from their aspect ratio, and the shape rules that find
// the map's shared values.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-map-assets-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: ['palette','bindings','fonts','decode-data','map-shape'].map(n => `export * from './src/extract/maps/${n}.ts';`).join('\n'),
    resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const {evaluateMapColor, resolveMapPalette, decodeMapBinding, decodeMapAnnotationTable, extractMapFonts, readMapDecodeData,
    readDictionaries, styleDictionaryCandidates, annotationTableCandidates, fleckAtlasCandidates, labelFontCandidates, labelForm,
    recordOfType, MAP_SPRITE_TYPES, labelBadgeWidth} = await import(pathToFileURL(file).href);
  assert.equal(evaluateMapColor({kind:'rgb',color:0,multiply:[1,2,1]}, [[0.5,0.25,0]], 0), 16896);
  assert.equal(evaluateMapColor({kind:'hsl',color:0,multiply:[1,1,2]}, [[0.5,0,0]], 0), 31744);
  for (const [rgb, expected] of [[[0,0,0],0], [[1,1,1],32767], [[1,0,0],31744], [[0,1,0],992],
    [[0,0,1],31], [[1,1,0],32736], [[0,1,1],1023], [[1,0,1],31775]] as [number[], number][]) {
    assert.equal(evaluateMapColor({kind:'hsl',color:0,multiply:[1,1,1]}, [rgb], 0), expected);
  }
  assert.equal(evaluateMapColor({kind:'hsl',color:0,multiply:[1,0,1]}, [[1,0,0]], 0), 16912);
  assert.equal(evaluateMapColor({kind:'rgb',color:0,multiply:[1,1,1]}, [[-1,2,0]], 0), 992);
  // Shared rules: key 0 tints the room's first colour, key 1 keeps its default.
  const rules = {101:{},102:{1:{kind:'constant',value:7}}};
  assert.deepEqual([...resolveMapPalette(101,[0,1],[[1,0,0]],new Map([[0,9],[1,10]]),rules)],[[0,31744],[1,10]]);
  assert.equal(resolveMapPalette(102,[1],[],new Map([[1,10]]),rules).get(1),7);
  assert.equal(resolveMapPalette(103,[1],[],new Map([[1,10]]),rules).get(1),10);
  assert.equal(resolveMapPalette(102,[1],[],new Map([[1,10]]),null).get(1),10);
  assert.throws(()=>resolveMapPalette(101,[2],[[1,0,0],[0,1,0]],new Map([[0,9]]),rules),/unresolved/);
  // A room using another room's colours: that room's rule and base colours,
  // or the shared rule when that room is not known.
  const linked = {...rules,104:{0:{kind:'room',owner:7},1:{kind:'room',owner:7}}};
  const roomOf = (owner:number) => owner===7 ? {runtime:102,colors:[[0,1,0]]} : undefined;
  assert.deepEqual([...resolveMapPalette(104,[0,1],[[1,0,0]],new Map([[0,9],[1,10]]),linked,roomOf)],[[0,992],[1,7]]);
  assert.deepEqual([...resolveMapPalette(104,[0,1],[[1,0,0]],new Map([[0,9],[1,10]]),linked)],[[0,31744],[1,10]]);
  assert.throws(()=>evaluateMapColor({kind:'default'},[],32768),/invalid/);
  assert.throws(()=>evaluateMapColor({kind:'rgb',color:1,multiply:[1,1,1]},[[1,1,1]],0),/invalid/);

  const uint=(v:number):number[]=>{const out=[];do{const b=v%128;v=Math.floor(v/128);out.push(b|(v?128:0));}while(v);return out;};
  const f32=(v:number,little=false)=>{const b=new Uint8Array(4);new DataView(b.buffer).setFloat32(0,v,little);return [...b];};
  const int=(v:number)=>{const b=new Uint8Array(4);new DataView(b.buffer).setInt32(0,v);return [10,...b];};
  const float=(v:number)=>[11,...f32(v)];
  const ref=(tag:number,id:number)=>[tag,...uint(id)];
  const list=(nodes:number[][])=>[32,...uint(nodes.length),...nodes.flat()];
  const typed=(id:number,nodes:number[][])=>[36,...uint(id),...nodes.flat()];
  const data:number[]=[],rows:any[]=[],selectors:any={};
  const add=(fields:number[][],selector=rows.length+100)=>{
    const slot=rows.length,start=data.length;data.push(...uint(slot),...fields.flat());
    selectors[selector]={runtime:selector,ctor_varints:0,fill:['U',...fields.map(()=> 'G')]};
    rows.push({slot,selector,runtime:selector,start,end:data.length,g:[],r:[],s:[],m:[],v:[]});return slot;
  };
  for(let g=0;g<5;g++) {
    const metrics=[0,0,0.02,...Array(10).fill(0)];
    add([[0x72,...metrics.flatMap(n=>f32(n)),0,0,g===4?0:1],[0x7d,g,0]]);
  }
  const face=add([]);
  rows[face].m=[[4,Array.from({length:5},(_,value)=>({key:null,value}))]];
  const lookup=[0x7e,1,3,5,...Array(5).fill(2),...Array.from({length:5},(_,i)=>[1,i,0]).flat()];
  const font=add([int(88),list([ref(2,face)]),lookup,float(0.8),float(0.2),float(1.1)]);
  const atlasSelector=303;
  add([int(43),list([ref(2,face)]),list(Array.from({length:4},(_,i)=>[0x33,9,i])),
    typed(1,[list([ref(19,55)]),list([ref(19,77)])])],atlasSelector);
  const profile:any={selectors,class_fields:{1:2,2:2},tag6_fields:{},stream:{object_count:rows.length,constructor_end:0}};
  const makeTable=(reverse=false)=>Uint8Array.from([0,...list(Array.from({length:5},(_,i)=>typed(2,[int(i===4?-1:0),
    [0x3c,...(i===0!==reverse?[0,0,1,1]:[1,0,0,1]).flatMap(n=>f32(n,true))]])))]);
  const bank=[
    {e:0,w:2,h:3,channels:1,pixels:Uint8Array.from([1,2,3,4,5,6])},
    {e:1,w:3,h:2,channels:1,pixels:Uint8Array.from([11,12,13,14,15,16])},
    {e:2,w:2,h:3,channels:4,pixels:Uint8Array.from([21,22,23,24,25,26].flatMap(v=>[v,0,0,255]))},
    {e:3,w:2,h:2,channels:4,pixels:Uint8Array.from([31,32,33,34].flatMap(v=>[v,0,0,255]))},
  ];
  let tableReads=0,bankReads=0;
  const extract=(readTable=async(id:number)=>{assert.equal(id,77);tableReads++;return makeTable();},request=[0,1,2,3,4,10])=>
    extractMapFonts(rows,[],Uint8Array.from(data),profile,['A','B','C','D',' '],{title:{slot:font,glyphs:request}},
      {selector:atlasSelector,uvTablesField:1},readTable,async(id:number)=>{assert.equal(id,9);bankReads++;return bank;});
  const result=await extract();
  assert.equal(tableReads,1);assert.equal(bankReads,1);
  assert.deepEqual(result.schema,{selector:atlasSelector,uvTablesField:1});
  // The atlas record kind and its UV table list found by shape: the other list
  // (geometry) does not parse as one entry per face glyph.
  const found=await extractMapFonts(rows,[],Uint8Array.from(data),profile,['A','B','C','D',' '],{title:{slot:font,glyphs:[0,1]}},{},
    async(id:number)=>id===77?makeTable():Uint8Array.from([9,1]),async()=>bank);
  assert.deepEqual(found.schema,{selector:atlasSelector,uvTablesField:1});
  // Fonts found by the stored label sizes: the advance at each mode's size,
  // plus the title margin, and the font's line metrics.
  const label=(w58:number,w64:number)=>({labels:{glyphs:[0,1],annotations:[],metrics:[[w58,58,0,0],[w64,64,0,0]]}});
  assert.equal(labelForm([label(51.16,51.28)]),'dual');
  assert.deepEqual(labelFontCandidates(rows,[],Uint8Array.from(data),profile,[label(51.16,51.28)]),{title:[font],annotation:[]});
  assert.deepEqual(labelFontCandidates(rows,[],Uint8Array.from(data),profile,[label(51.16,52)]),{title:[],annotation:[]});
  // The badge width: rooms whose annotations all have badges store it on top
  // of the margin that rooms without badges store.
  const annotated=(marker:any,w48:number)=>({labels:{glyphs:[0],metrics:[[0,0,w48,0],[0,0,20.64,0]],
    annotations:[{glyphs:[0,1],marker}]}});
  const none={tag:15,symbol:'$none'},levelMarker={tag:10,value:7};
  assert.equal(labelBadgeWidth(rows,[],Uint8Array.from(data),profile,[annotated(levelMarker,160.48),annotated(none,20.48)],font),140);
  assert.equal(labelBadgeWidth(rows,[],Uint8Array.from(data),profile,[annotated(levelMarker,220.48)],font),200);
  assert.equal(labelBadgeWidth(rows,[],Uint8Array.from(data),profile,[annotated(levelMarker,160.48),annotated(levelMarker,220.48)],font),null);
  const glyphs=result.fonts.title.glyphs;
  assert.equal(glyphs.length,5);assert.deepEqual(glyphs[0].variants,[0,null]);assert(!glyphs[4].bitmap);
  assert.deepEqual(glyphs.slice(0,4).map(g=>g.bitmap.correctionDegrees),[90,0,-90,-90]);
  const pixels=(g:any)=>{
    const [x,y,w,h]=g.bitmap.rect,out=[];
    for(let j=0;j<h;j++)for(let i=0;i<w;i++)out.push(result.sheet.rgba[((y+j)*result.sheet.width+x+i)*4+(g.bitmap.color?0:3)]);
    return out;
  };
  assert.deepEqual(glyphs.slice(0,4).map(pixels),[[5,3,1,6,4,2],[11,12,13,14,15,16],[22,24,26,21,23,25],[32,34,31,33]]);
  await assert.rejects(()=>extract(undefined,[8]),/missing default glyph/);
  await assert.rejects(()=>extract(async()=>makeTable(true)),/dimensions/);

  // The style dictionary: after the constructor stream, before the pool; the
  // one whose records are all of one kind with a single colour, keyed by the
  // styles rooms use.
  const colorSlot=add([int(1234)]),other=add([int(5),int(6)]),bindingOffset=data.length;
  data.push(0x1c,0);profile.stream.object_count=rows.length;profile.stream.constructor_end=data.length;
  data.push(1,7,...uint(colorSlot),2,0,1,...uint(other),...uint(other));
  const bytes=Uint8Array.from(data),binding={offset:bindingOffset,tag:0x1c},poolFrame={countOffset:bytes.length,end:bytes.length};
  const dictionaries=readDictionaries(bytes,profile,poolFrame);
  assert.deepEqual(dictionaries,[{keys:[7],slots:[colorSlot]},{keys:[0,1],slots:[other,other]}]);
  assert.deepEqual(readDictionaries(bytes,profile,{countOffset:bytes.length-1}),[{keys:[7],slots:[colorSlot]}]);
  // Style records' types lie under the terrain style type (type 0 here).
  const types={ends:Int32Array.from([1,1,2]),ids:Uint8Array.from([0x20,0x84,0x27,0x60,0x8d,0x62,0x0d,0xb3,...Array(16).fill(0)])};
  const objects:any[]=rows.map(()=>({values:[0,0,2]}));objects[colorSlot].values[2]=1;
  const styles=styleDictionaryCandidates(rows,objects,types,[],bytes,profile,dictionaries,[7]);
  assert.equal(styles.length,1);assert.equal(styles[0].index,0);assert.deepEqual([...styles[0].defaults],[[7,1234]]);
  assert.deepEqual(styleDictionaryCandidates(rows,objects,types,[],bytes,profile,dictionaries,[8]),[]);
  objects[colorSlot].values[2]=2;
  assert.deepEqual(styleDictionaryCandidates(rows,objects,types,[],bytes,profile,dictionaries,[7]),[]);
  // A label image is the one record of its type.
  const spriteTypes={ends:Int32Array.from([0,0]),ids:Uint8Array.from([0x4c,0x14,0x4e,0xa2,0x6b,0x6e,0x45,0x41,...Array(8).fill(0)])};
  assert.equal(recordOfType([{values:[0,0,1]},{values:[0,0,0]}] as any,spriteTypes,MAP_SPRITE_TYPES.round),1);
  assert.equal(recordOfType([{values:[0,0,0]},{values:[0,0,0]}] as any,spriteTypes,MAP_SPRITE_TYPES.round),null);
  assert.equal(recordOfType([{values:[0,0,0]}] as any,spriteTypes,MAP_SPRITE_TYPES.panel),null);
  assert.throws(()=>decodeMapBinding(bytes,[],profile,{offset:bytes.length,tag:28}),/outside/);
  assert.throws(()=>decodeMapBinding(bytes,[],profile,{...binding,tag:38}),/type/);
  // The decode data's optional code facts; anything malformed is left out.
  const star={offset:3,tag:14},mapData={kind:'brighter-atlas-map-decode',format:1,
    bindings:{annotationStar:star,labelRound:{offset:4,tag:2},styleDictionary:binding,levelMinorGlyph:{offset:-1,tag:115}},palette:{base:{},rooms:rules}};
  assert.deepEqual(readMapDecodeData(mapData),{bindings:{annotationStar:star},rooms:rules});
  assert.deepEqual(readMapDecodeData(undefined),{bindings:{},rooms:null});
  assert.deepEqual(readMapDecodeData({...mapData,kind:'other'}),{bindings:{},rooms:null});
  assert.equal(readMapDecodeData({...mapData,palette:{rooms:{101:{0:{kind:'constant',value:1e6}}}}}).rooms,null);
  assert.deepEqual(readMapDecodeData({...mapData,palette:{rooms:{104:{0:{kind:'room',owner:7}}}}}).rooms,{104:{0:{kind:'room',owner:7}}});
  assert.equal(readMapDecodeData({...mapData,palette:{rooms:{104:{0:{kind:'room',owner:-1}}}}}).rooms,null);
  // The fleck atlas: the referenced texture twelve 40-pixel cells wide whose
  // smaller levels halve.
  const level=(w:number,h:number)=>[0x16,w>>8,w&255,h>>8,h&255,0,0,0,0,0,0,0,0];
  const tails:Record<number,number[]>={5:[...level(480,880),...level(240,440),...level(120,220)],6:[...level(480,880),...level(100,100)],
    7:[...level(480,880),...level(240,440)]};
  const atlasRows=[{g:[[1,0,71,5],[2,0,71,6],[3,1,71,7]]}];
  assert.deepEqual(await fleckAtlasCandidates(atlasRows,[],{5:{flags:0,n:3},6:{flags:0,n:2},7:{flags:0,n:2}},
    async(id:number,length:number)=>{assert.equal(length,tails[id].length);return Uint8Array.from(tails[id]);}),[5]);
  // The compiled table contains all keys followed by all value lists. Reject
  // duplicate owners and malformed values instead of silently losing labels.
  const table=(nodes:number[][])=>Uint8Array.from([44,...uint(nodes.length/2),...nodes.flat()]);
  const tableBinding={offset:0,tag:44};
  const annotations=decodeMapAnnotationTable(table([ref(38,1),ref(38,2),list([int(7)]),list([])]),[],profile,tableBinding);
  assert.equal(annotations.get(1)[0].value,7);assert.deepEqual(annotations.get(2),[]);
  for(const nodes of [[ref(38,1),ref(38,1),list([]),list([])],
    [ref(38,rows.length),list([])], [ref(38,1),int(7)]]) {
    assert.throws(()=>decodeMapAnnotationTable(table(nodes),[],profile,tableBinding),/annotation/);
  }
  // Found by shape between the pool and the fill stream: keys are all rooms.
  const tableBytes=Uint8Array.from([0x2c,1,0x26,5,32,0,...table([ref(38,1),ref(38,2),list([int(7)]),list([])])]);
  const shaped=annotationTableCandidates(tableBytes,[],{...profile,stream:{...profile.stream,fill_start:tableBytes.length}},{end:0},new Set([1,2]));
  assert.deepEqual(shaped.map((t:any)=>t.offset),[6]);assert.equal(shaped[0].entries.get(1)[0].value,7);
  console.log('Map colour operations, strict bindings, glyph metrics, nullable variants, stored A8/RGBA rotations and shape rules passed');
} finally {await rm(tmp,{recursive:true,force:true});}
