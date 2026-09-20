import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {mapFixture} from './map-fixture.ts';
import {shimWebroot,requireBuild} from './env.ts';
import {serve} from './serve.ts';
import {CHROME,GL_ARGS} from './chrome.ts';
requireBuild('maps');
const {root,cleanup}=await shimWebroot('atlas-maps-'),fixture=mapFixture();
for(const dir of ['data/maps','data/index','downloads'])await mkdir(path.join(root,dir),{recursive:true});
for(const [name,data] of [['manifest.json',fixture.manifest],['index/maps.json',fixture.index],['maps/scene.json',fixture.doc]] as const)
  await writeFile(path.join(root,'data',name),JSON.stringify(data));
const {server,port}=await serve(root),base=`http://127.0.0.1:${port}/?data=data`;
const browser=await puppeteer.launch({executablePath:CHROME!,headless:true,args:['--no-sandbox',...GL_ARGS]});
try{
  const page=await browser.newPage(),errors:string[]=[];
  page.on('pageerror',e=>errors.push((e as Error).message));
  await page.setViewport({width:1280,height:900});await page.goto(base+'#/map/0',{waitUntil:'networkidle0'});
  await page.waitForSelector('.map-view[data-ready="true"]');
  assert.equal(await page.$eval('.map-view',e=>(e as any).dataset.rooms),'2');
  assert.equal(await page.$eval('.map-view',e=>(e as any).dataset.tiles),'32');
  assert.equal(await page.$$eval('#list-host .r-main',nodes=>nodes[0].textContent),'Full world');
  await page.select('[aria-label="Map episode"]','1');
  assert.equal(await page.$eval('.map-view',e=>(e as any).dataset.rooms),'1');
  await page.select('[aria-label="Map episode"]','');
  const before=await page.$eval('.map-view canvas',e=>(e as any).dataset.center);
  const box=await (await page.$('.map-view canvas'))!.boundingBox();assert(box);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2+30);await page.mouse.up();
  await page.waitForFunction(v=>(document.querySelector('.map-view canvas') as any).dataset.center!==v,{},before);
  const session=await page.createCDPSession();
  await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:path.join(root,'downloads')});
  await page.$eval('[aria-label="PNG long edge in pixels"]',e=>{(e as any).value='512';});
  await page.evaluate(()=>window.__bs.app.view.exportPng());
  let png:Buffer|null=null;
  for(let i=0;i<30&&!png;i++){
    const files=(await readdir(path.join(root,'downloads'))).filter(n=>n.endsWith('.png'));
    if(files.length)png=await readFile(path.join(root,'downloads',files[0]));else await new Promise(r=>setTimeout(r,100));
  }
  assert(png);assert.equal(Math.max(png.readUInt32BE(16),png.readUInt32BE(20)),512);
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:2});
  await page.goto(base+'#/map/11',{waitUntil:'networkidle0'});await page.waitForSelector('.map-view[data-ready="true"]');
  assert.equal(await page.$('.mgate'),null);
  assert(await page.$eval('.map-view canvas',e=>e.getBoundingClientRect().width>=380));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);
  console.log('Maps category, room and episode selection, native canvas, pan, exact PNG size and mobile layout passed');
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));await cleanup();}
