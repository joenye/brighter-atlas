// Bound spawn-time properties: reading literal and sampled values through
// per-build field bindings, and drawing them per particle in the game's
// evaluation order (origin radius, speed, acceleration, size, rotation, spin,
// sprite, colour). Synthetic records only.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-effect-fields-'));
try {
 const file=path.join(tmp,'test.mjs');
 await build({stdin:{contents:"export * from './src/extract/world/effect-fields.ts'; export {EmitterSim, hash32, pickChoice} from './src/viewers/world/effects-sim.ts'; export {wanderUnit} from './src/viewers/world/effects-wander.ts'; export {EffectRandom} from './src/viewers/world/effects-random.ts'; export {emitterSpriteDraws} from './src/viewers/world/effects-sprite.ts'; export {tabulatedValue, keyedUnit, evaluateComputed} from './src/viewers/world/effects-computed.ts'; export {validValueSource} from './src/extract/world/effect-sources.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
 const T=await import(pathToFileURL(file).href);
 let checks=0;const ok=(c:any,m:string)=>{assert(c,m);checks++;};
 const classes={range:7,rate:8,vector:9,colour:10};
 const binding={instance:4,speed:[30,31],angularSpeed:32,acceleration:[33,34],scale:[35,36],rotation:37,color:[38,39]};
 ok(T.validEffectFields({classes,bindings:[binding]}),'valid binding');
 ok(!T.validEffectFields({classes,bindings:[binding,binding]}),'duplicate instance rejected');
 ok(!T.validEffectFields({classes:{...classes,colour:undefined},bindings:[binding]}),'every class is required');
 ok(!T.validEffectFields({classes,bindings:[{...binding,speed:[30]}]}),'pairs are pairs');
 ok(T.validEffectFields({classes,bindings:[{...binding,angularSpeed:null,color:[null,null]}]}),'unbound roles are null');
 const f=(op:number,value:number)=>({op,kind:'float',value});
 const range=(op:number,lo:number,hi:number)=>({op,kind:'typed',class:7,fields:[f(op,lo),f(op,hi)]});
 const ops=[
  {op:30,kind:'typed',class:8,fields:[range(30,1550,1650),{op:30,kind:'duration',ticks:600}]},
  {op:31,kind:'symbol',index:1,name:'$speed0'},
  {op:32,kind:'rate',value:90,den:600},
  {op:33,kind:'typed',class:9,fields:[f(33,0),range(33,-50,50),range(33,-720,-780)]},
  {op:34,kind:'symbol',index:2,name:'$acceleration0'},
  range(35,1.5,2),{op:36,kind:'symbol',index:3,name:'$scale0'},
  range(37,0,360),
  {op:38,kind:'typed',class:10,fields:[f(38,1),range(38,.2,.6),f(38,.5),range(38,.1,.9)]},
  {op:39,kind:'color',rgba:[1,1,1,.25]},
 ];
 const read=T.createEffectFieldReader({classes,bindings:[binding]},[{values:[0,4]}]);
 const values=read(0,ops);
 assert.deepEqual(values,{
  speed:{start:{value:[1550,1650],ticks:600},end:'start'},
  angularSpeed:{value:90,ticks:600},
  acceleration:{start:[0,[-50,50],[-720,-780]],end:'start'},
  scale:{start:[1.5,2],end:'start'},
  rotation:[0,360],
  color:{start:{ahsl:[1,[.2,.6],.5,[.1,.9]]},end:{rgba:[1,1,1,.25]}},
 });checks++;
 ok(read(1,ops)===null,'unbound instance');
 ok(T.createEffectFieldReader(undefined,[{values:[0,4]}])(0,ops)===null,'no bindings');
 const wrong=read(0,ops.map(e=>e.op===30?{...e,class:99}:e.op===33?{...e,class:99}:e));
 ok(wrong.speed===null&&wrong.acceleration===null&&wrong.color!==null,'unknown value classes stay unresolved per role');
 ok(read(0,ops.map(e=>e.op===31?{op:31,kind:'rate',value:5,den:600}:e)).speed.end.value===5,'separate end value');
 ok(read(0,ops.filter(e=>e.op!==32)).angularSpeed===null,'missing field');
 // HSL with hue in sextants, clamped saturation and lightness: a sampled
 // control plus hue wrap and clamp controls.
 const close=(a:number[],b:number[])=>a.every((v,i)=>Math.abs(v-b[i])<2e-5);
 ok(close(T.effectHslToRgb(.2,.5,.2009),[.30135,.14063,.10045]),'sampled HSL control');
 ok(close(T.effectHslToRgb(1,1,.5),[1,1,0]),'one sextant is yellow');
 ok(close(T.effectHslToRgb(12.3,1.5,.5),[1,.3,0]),'hue wraps, saturation clamps');
 ok(close(T.effectHslToRgb(-.3,1,.5),[1,0,.3]),'negative hue wraps');
 ok(close(T.effectHslToRgb(3,1,1.2),[1,1,1])&&close(T.effectHslToRgb(3,.5,-.1),[0,0,0]),'lightness clamps');

 // Per-particle sampling in the game's order from the particle's own stream.
 const emitter:any={life:{ticks:600},fade_in:{ticks:0},fade_out:{ticks:0},burst:1,shape:2,scales:values.scale,fields:values,
  sprite_choices:{kind:'uniform',sprites:[{material:1,images:[11]},{material:2,images:[12]},{material:3,images:[13]}]}};
 const configs:any={1:{kind:'burst_continuous',per_second:60},2:{kind:'shape',shape_kind:'point',center:[0,0,0],axis:[0,0,1],cone:{yaw:[0,0],pitch:[0,0]},origin:'bound'}};
 const make=()=>new T.EmitterSim({slot:5,loop:true},0,emitter,configs,600);
 const sim=make();
 const t=20;sim.ensure(t);
 const rows:any[]=[];sim.evaluate(t,(...p:number[])=>rows.push(p));
 ok(rows.length===3,'births at ticks 0, 10 and 20 are live at tick 20');
 const channel=(v:number)=>Math.trunc(Math.fround(Math.fround(Math.min(1,Math.max(0,v)))*255))/255;
 rows.forEach((p,n)=>{
  const r=new T.EffectRandom(BigInt(T.hash32(sim.seed,n)));
  const age=t-Math.trunc(n*600/60);
  const speed=r.range(1550,1650)/600;
  const ay=r.range(-50,50)/(600*600),az=r.range(-720,-780)/(600*600);
  const size=r.range(1.5,2);
  const rot0=r.range(0,360)*Math.PI/180;
  const spin=90*Math.PI/180/600;
  const choice=r.integer(3);
  const a=1,h=r.range(.2,.6),s=.5,l=r.range(.1,.9);
  ok(Math.abs(p[0])<1e-6&&Math.abs(p[1]-.5*ay*age*age)<1e-6,'lateral acceleration sample');
  ok(Math.abs(p[2]-(speed*age+.5*az*age*age))<1e-4,'vertical motion uses sampled speed and acceleration');
  ok(Math.abs(p[3]-size)<1e-6,'size shares the stream after motion');
  ok(Math.abs(p[8]-(spin*age-rot0))<1e-6,'initial rotation turns against the roll');
  ok(sim.choice[n%sim.capacity]===choice,'sprite choice follows rotation and spin');
  // Colour: the hold window starts at birth (no fades), interpolating toward
  // rgba. At age zero an absent fade-in has not yet elapsed (alpha zero).
  if(age===0)return;
  const c0=[...T.effectHslToRgb(h,s,l),a].map(channel),c1=[1,1,1,.25].map(channel);
  const k=age/600,alpha=c0[3]+(c1[3]-c0[3])*k;
  ok(Math.abs(p[7]-alpha)<1e-6,'sampled colour alpha envelope');
  ok(Math.abs(p[4]-(c0[0]*c0[3]+(c1[0]*c1[3]-c0[0]*c0[3])*k)/alpha)<1e-6,'sampled HSL colour');
 });
 // Choice-filtered evaluation partitions the particles.
 sim.ensure(300);let all=0;sim.evaluate(300,()=>{all++;});
 let parts=0;for(const c of [0,1,2]){sim.evaluate(300,()=>{parts++;},c);}
 ok(all===parts&&all>10,'sprite batches partition the live particles');
 // Seeks and stride rebuild the same samples.
 const snapshot=(s:any,tick:number)=>{s.ensure(tick);const out:number[][]=[];s.evaluate(tick,(...p:number[])=>out.push(p.slice(0,9)));return out;};
 const walk=make();
 for(const tick of [0,120,700,30,700]){ok(JSON.stringify(snapshot(walk,tick))===JSON.stringify(snapshot(make(),tick)),'seek '+tick);}
 // Acceleration basis applies to sampled values at birth.
 const turned=make();turned.setAccelerationBasis([0,1,0,0, -1,0,0,0, 0,0,1,0, 0,0,0,1]);
 const straight=snapshot(make(),20),rotated=snapshot(turned,20);
 rotated.forEach((p,i)=>{ok(Math.abs(p[0]+straight[i][1])<1e-6&&Math.abs(p[2]-straight[i][2])<1e-6,'basis rotates sampled acceleration');});
 // Literal-only bindings keep the constant path.
 const literal:any={...emitter,fields:{speed:{start:{value:600,ticks:600},end:'start'},rotation:0},scales:undefined,sprite_choices:null,sprite:{material:1,images:[11]}};
 const plain=new T.EmitterSim({slot:5,loop:true},0,literal,configs,600);
 ok(!(plain as any)._perParticle&&plain.spriteChoices===0,'literal bindings need no per-particle state');
 // Computed selections draw only when their shape is bound.
 ok(T.emitterSpriteDraws(emitter,configs).map((d:any)=>d.choice).join()==='0,1,2','bound selection draws every outcome');
 ok(T.emitterSpriteDraws(emitter,{...configs,2:{...configs[2],origin:undefined}}).length===0,'unbound selection stays hidden');
 ok(T.emitterSpriteDraws(literal,configs)[0].choice===-1,'single sprite');
 // A property the record does not hold: from its source (a value worked out from the game's own draws, a field of
 // the system that owns the emitter, or the emitter's own field), read the way the record's own field would be
 {
  const sources=[{instance:4,speed:[{value:[6600,7200],ticks:600},{op:31}],scale:[{value:[1,1.5]},null],
   acceleration:[{owner:1,op:5},{op:34}],rotation:{value:20},angularSpeed:{owner:1,op:6}}];
  ok(T.validEffectPropertySources(sources),'valid property sources');
  ok(!T.validEffectPropertySources([{instance:4,speed:[{value:[1,2]},null]}]),'a rate needs its ticks');
  ok(!T.validEffectPropertySources([{instance:4,acceleration:[{value:[1,2]},null]}]),'a vector has three numbers');
  ok(!T.validEffectPropertySources([{instance:4,rotation:{owner:3,op:1}}]),'owner levels are 1 or 2');
  ok(!T.validEffectPropertySources([...sources,...sources]),'one row per instance');
  const open={instance:4,speed:[null,31],angularSpeed:null,acceleration:[null,null],scale:[null,null],rotation:null,color:[38,39]};
  const own=[{op:0,kind:'scalar',tag:-85,value:1},...ops];
  const system=[{op:5,kind:'typed',class:9,fields:[f(5,1),f(5,2),f(5,3)]},{op:6,kind:'rate',value:45,den:300}];
  const readSources=T.createEffectFieldReader({classes,bindings:[open]},[{values:[0,4]},{values:[0,9]}],sources);
  const got=readSources(0,own,(slot:number)=>slot===1?system:null);
  ok(JSON.stringify(got.speed)===JSON.stringify({start:{value:[6600,7200],ticks:600},end:'start'}),'speed worked out, its end the record\'s marker');
  ok(JSON.stringify(got.acceleration)===JSON.stringify({start:[1,2,3],end:'start'}),'acceleration from the system\'s field');
  ok(got.scale===null,'no end anywhere: the scale stays unresolved');
  ok(got.rotation===20&&JSON.stringify(got.angularSpeed)===JSON.stringify({value:45,ticks:300}),'rotation worked out, spin from the system');
  ok(readSources(0,own)!.acceleration===null,'no system: no acceleration');
  // (the end the build does not work out: the record's own end field)
  const withEnd=T.createEffectFieldReader({classes,bindings:[{...open,scale:[null,35]}]},[{values:[0,4]}],sources);
  ok(JSON.stringify(withEnd(0,own,()=>null).scale)===JSON.stringify({start:[1,1.5],end:[1.5,2]}),'scale end from the record');
  // (no field binding at all: the sources alone)
  const alone=T.createEffectFieldReader(undefined,[{values:[0,4]}],sources);
  ok(alone.bound(0)&&alone(0,own,()=>system).rotation===20,'sources without field bindings');
  ok(JSON.stringify(read(0,ops))===JSON.stringify(values),'records holding their properties read as before');
 }
 // One of a few values picked per particle: by the particle's own seeded draw (a salt: every pick of a particle with
 // that salt agrees, as the game's do) or a draw of its own; the picked range then drawn from the particle's stream
 {
  const rotation={value:{choice:[[.5,[-10,-50]],[.5,[10,50]]],salt:1}};
  const spin={value:{choice:[[.5,[40,28]],[.5,[-40,-28]]],salt:1},ticks:600};
  const coin={value:[0,{choice:[[.5,-50],[.5,50]]},0]};
  const picks=[{instance:4,rotation,angularSpeed:spin,acceleration:[coin,null]}];
  ok(T.validEffectPropertySources(picks),'valid choices');
  ok(!T.validEffectPropertySources([{instance:4,rotation:{value:{choice:[[.5,1],[.4,2]]}}}]),'weights sum to one');
  ok(!T.validEffectPropertySources([{instance:4,rotation:{value:{choice:[[1,1]]}}}]),'a choice has two values or more');
  ok(!T.validEffectPropertySources([{instance:4,rotation:{value:{choice:[[.5,1],[.5,2]],salt:-1}}}]),'a salt is a word');
  ok(!T.validEffectPropertySources([{instance:4,rotation:{value:{choice:[[.5,{choice:[]}],[.5,2]]}}}]),'no choice inside a choice');
  const own=[{op:0,kind:'scalar',tag:-85,value:1}];
  const got=T.createEffectFieldReader(undefined,[{values:[0,4]}],picks)(0,own,()=>null);
  ok(JSON.stringify(got.rotation)===JSON.stringify(rotation.value)&&JSON.stringify(got.angularSpeed)===JSON.stringify(spin),
   'choices read as given');
  ok(got.acceleration===null,'no end anywhere: the acceleration stays unresolved');
  // (the pick itself: in order, by the seeded draw of the particle's number)
  for(const n of [0,1,2,77,4096]){
   const want=T.wanderUnit(n,1)<.5?[-10,-50]:[10,50];
   ok(JSON.stringify(T.pickChoice(rotation.value,n,()=>{throw Error('a seeded pick draws nothing');}))===JSON.stringify(want),'seeded pick '+n);
  }
  ok(T.pickChoice({choice:[[.25,1],[.75,2]]},0,()=>.2)===1&&T.pickChoice({choice:[[.25,1],[.75,2]]},0,()=>.3)===2,'a pick of its own by weight');
  const em:any={life:{ticks:600},fade_in:{ticks:0},fade_out:{ticks:0},burst:1,shape:2,
   fields:{rotation:rotation.value,angularSpeed:spin},sprite_choices:null,sprite:{material:1,images:[11]}};
  const s2=new T.EmitterSim({slot:6,loop:true},0,em,configs,600);
  ok((s2 as any)._perParticle,'a choice is drawn per particle');
  s2.ensure(200);const live:any[]=[];s2.evaluate(200,(...p:number[])=>live.push(p));
  ok(live.length>10,'particles live');
  let both=0;
  live.forEach((p,n)=>{
   const r=new T.EffectRandom(BigInt(T.hash32(s2.seed,n)));
   const first=T.wanderUnit(n,1)<.5;
   const rot0=(first?r.range(-10,-50):r.range(10,50))*Math.PI/180;
   const sp=(first?r.range(40,28):r.range(-40,-28))*Math.PI/180/600;
   const age=200-Math.trunc(n*600/60);
   ok(Math.abs(p[8]-(sp*age-rot0))<1e-6,'rotation and spin from the picked ranges, particle '+n);
   if(first)both++;
  });
  ok(both>0&&both<live.length,'both picks occur');
 }
 // A value through a curve of its draws, tabulated over their fractions per particle: a size the particle's seeded
 // draw of its place in its batch picks (start and end alike), interpolated between the samples
 {
  const key={salt:4325532,period:200};
  const start={tabulated:{res:[3],values:[0,10,0],keys:[key]}},end={tabulated:{res:[3],values:[1,11,1],keys:[key]}};
  ok(T.validEffectTabulated(start),'a tabulated value');
  ok(!T.validEffectTabulated({tabulated:{res:[3],values:[0,10]}}),'a value at every grid point');
  ok(!T.validEffectTabulated({tabulated:{res:[1],values:[0]}}),'two samples per draw at least');
  ok(!T.validEffectTabulated({tabulated:{res:[3],values:[0,1,2],keys:[{salt:1,by:'cycle'}]}}),'a cycle needs its period');
  ok(!T.validEffectTabulated({tabulated:{res:[3],values:[0,1,2],keys:[]}}),'a key per draw');
  ok(T.validEffectPropertySources([{instance:4,scale:[{value:start},{value:end}]}]),'a tabulated size as a property source');
  ok(T.validValueSource({value:start},false)&&!T.validValueSource({value:start},true),'a tabulated scalar as a value source');
  const ringGrid={draws:1,grid:{res:[3],values:[[0,4,0]]},keys:[{salt:9}]};
  ok(T.validValueSource(ringGrid,false),'a computed value on a grid');
  ok(!T.validValueSource({...ringGrid,coef:[1,2]},false),'a grid or a polynomial, not both');
  ok(!T.validValueSource({draws:1,grid:{res:[3],values:[[0,4,0],[0,0,0],[0,0,0]]}},false),'one axis for a scalar');
  ok(!T.validValueSource({draws:2,grid:{res:[3],values:[[0,4,0]]}},false),'a sample count per draw');
  for(const n of [0,1,199,200,4321]){
   const f=T.wanderUnit(n%200,key.salt);
   const want=f<.5?20*f:20*(1-f);
   ok(Math.abs(T.tabulatedValue(start.tabulated,n,()=>{throw Error('a keyed draw draws nothing');})-want)<1e-9,'keyed tabulated value '+n);
   const g=T.wanderUnit(n,9);
   ok(Math.abs(T.evaluateComputed(ringGrid,n,()=>{throw Error('a keyed draw draws nothing');})[0]-(g<.5?8*g:8*(1-g)))<1e-9,
    'a computed grid value, keyed by n '+n);
  }
  ok(Math.abs(T.keyedUnit({salt:3,period:10,by:'cycle'},57,()=>0)-T.wanderUnit(5,3))<1e-12,'a cycle key: the batch number');
  ok(T.keyedUnit(null,57,()=>.25)===.25,'no key: a draw of its own');
  const em:any={life:{ticks:600},fade_in:{ticks:0},fade_out:{ticks:0},burst:1,shape:2,fields:{rotation:0},
   scales:{start,end},sprite_choices:null,sprite:{material:1,images:[11]}};
  const s3=new T.EmitterSim({slot:7,loop:true},0,em,configs,600);
  s3.ensure(200);const live:any[]=[];s3.evaluate(200,(...p:number[])=>live.push(p));
  ok(live.length>10,'particles live');
  live.forEach((p,n)=>{
   const f=T.wanderUnit(n%200,key.salt),s0=f<.5?20*f:20*(1-f),s1=s0+1;
   const age=200-Math.trunc(n*600/60);
   ok(Math.abs(p[3]-(s0+(s1-s0)*age/600))<1e-6,'size from the tabulated start and end, particle '+n);
  });
 }
 console.log(`effect fields: ${checks} reader, colour, sampling order, choice, tabulated, seek and basis checks passed`);
}finally{await rm(tmp,{recursive:true,force:true});}
