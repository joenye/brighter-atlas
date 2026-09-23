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
 await build({stdin:{contents:"export * from './src/extract/world/effect-fields.ts'; export {EmitterSim, hash32} from './src/viewers/world/effects-sim.ts'; export {EffectRandom} from './src/viewers/world/effects-random.ts'; export {emitterSpriteDraws} from './src/viewers/world/effects-sprite.ts';",resolveDir:path.resolve(import.meta.dirname,'..')},bundle:true,platform:'node',format:'esm',outfile:file});
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
 console.log(`effect fields: ${checks} reader, colour, sampling order, choice, seek and basis checks passed`);
}finally{await rm(tmp,{recursive:true,force:true});}
