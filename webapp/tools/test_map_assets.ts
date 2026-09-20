// Synthetic colour and font cases, including square icons whose rotation
// cannot be inferred from their aspect ratio.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-map-assets-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({stdin: {contents: ['palette','bindings','fonts','decode-data'].map(n => `export * from './src/extract/maps/${n}.ts';`).join('\n'),
    resolveDir: path.resolve(import.meta.dirname, '..')}, bundle: true, platform: 'node', format: 'esm', outfile: file});
  const {evaluateMapColor, resolveMapPalette, decodeMapStyleDefaults, decodeMapBinding, decodeMapAnnotationTable, extractMapFonts, validateMapDecodeData} = await import(pathToFileURL(file).href);
  assert.equal(evaluateMapColor({kind:'rgb',color:0,multiply:[1,2,1]}, [[0.5,0.25,0]], 0), 16896);
  assert.equal(evaluateMapColor({kind:'hsl',color:0,multiply:[1,1,2]}, [[0.5,0,0]], 0), 31744);
  for (const [rgb, expected] of [[[0,0,0],0], [[1,1,1],32767], [[1,0,0],31744], [[0,1,0],992],
    [[0,0,1],31], [[1,1,0],32736], [[0,1,1],1023], [[1,0,1],31775]] as [number[], number][]) {
    assert.equal(evaluateMapColor({kind:'hsl',color:0,multiply:[1,1,1]}, [rgb], 0), expected);
  }
  assert.equal(evaluateMapColor({kind:'hsl',color:0,multiply:[1,0,1]}, [[1,0,0]], 0), 16912);
  assert.equal(evaluateMapColor({kind:'rgb',color:0,multiply:[1,1,1]}, [[-1,2,0]], 0), 992);
  const rules = {base:{0:{kind:'default'},1:{kind:'rgb',color:0,multiply:[1,1,1]}},rooms:{101:{},102:{1:{kind:'constant',value:7}}}};
  assert.deepEqual([...resolveMapPalette(101,[0,1],[[1,0,0]],new Map([[0,9],[1,10]]),rules)],[[0,9],[1,31744]]);
  assert.equal(resolveMapPalette(102,[1],[],new Map([[1,10]]),rules).get(1),7);
  assert.throws(()=>resolveMapPalette(103,[0],[],new Map([[0,9]]),rules),/unsupported/);
  assert.throws(()=>resolveMapPalette(101,[2],[],new Map([[2,9]]),rules),/unresolved/);
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

  // A dictionary binding is a byte offset, not a copied style colour table.
  const colorSlot=add([int(1234)]),bindingOffset=data.length;
  data.push(0x1c,0);profile.stream.object_count=rows.length;profile.stream.constructor_end=data.length;
  data.push(1,7,...uint(colorSlot));
  const bytes=Uint8Array.from(data),binding={offset:bindingOffset,tag:0x1c};
  assert.deepEqual([...decodeMapStyleDefaults(rows,[],bytes,profile,binding)],[[7,1234]]);
  assert.throws(()=>decodeMapBinding(bytes,[],profile,{offset:bytes.length,tag:28}),/outside/);
  assert.throws(()=>decodeMapBinding(bytes,[],profile,{...binding,tag:38}),/type/);
  const hash='a'.repeat(64),mapData={kind:'brighter-atlas-map-decode',format:1,bundle0_raw_sha256:hash,
    bindings:{styleDictionary:binding,titleFont:binding,annotationFont:binding},
    fontAtlas:{selector:atlasSelector,uvTablesField:1},palette:rules};
  assert.equal(validateMapDecodeData(mapData,hash),mapData);
  assert.throws(()=>validateMapDecodeData(mapData,'b'.repeat(64)),/different/);
  assert.throws(()=>validateMapDecodeData({...mapData,fontAtlas:null},hash),/incomplete/);
  assert.throws(()=>validateMapDecodeData({...mapData,bindings:{}},hash),/missing/);
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
  assert.throws(()=>validateMapDecodeData({...mapData,labels:{layout:'fixed'}},hash),/annotation/);
  assert.equal(validateMapDecodeData({...mapData,labels:{layout:'fixed'},bindings:{...mapData.bindings,annotationTable:tableBinding}},hash).labels.layout,'fixed');
  console.log('Map colour operations, strict bindings, glyph metrics, nullable variants and stored A8/RGBA rotations passed');
} finally {await rm(tmp,{recursive:true,force:true});}
