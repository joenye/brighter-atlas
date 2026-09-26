// Build names: the game's build string from the per-build data ("0.99.3-" +
// 16 hex) names versions throughout the app ("build 21-Sep-2026 (v0.99.3)"),
// and data without one (or with a malformed one) keeps the date label.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const tmp=await mkdtemp(path.join(os.tmpdir(),'atlas-build-names-'));
try {
  const load=async(entry:string)=>{
    const file=path.join(tmp,path.basename(entry).replace(/\.ts$/,'.mjs'));
    await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'error'});
    return import(pathToFileURL(file).href);
  };
  const {parseBuildString,gameVersion}=await load('src/game-build.ts');
  assert.deepEqual(parseBuildString('0.99.3-278abe752c42bda0'),{version:'0.99.3',hash:'278abe752c42bda0'});
  assert.equal(gameVersion('0.2.0-df094ea079b97df9'),'0.2.0');
  for(const bad of [null,undefined,'','0.99.3','0.99-278abe752c42bda0','0.99.3-278ABE752C42BDA0','0.99.3-278abe75',42])
    assert.equal(parseBuildString(bad),null,`rejects ${JSON.stringify(bad)}`);

  const {versionLabel}=await load('src/ui.ts');
  const base={versionId:'aef3ef9d79c99a44aaaaaaaaaaaaaaaa'};
  assert.equal(versionLabel({...base,profileLabel:'21-Sep-2026 (aef3ef9d)',buildString:'0.99.3-278abe752c42bda0'}),'build 21-Sep-2026 (v0.99.3)');
  assert.equal(versionLabel({...base,buildString:'0.99.3-278abe752c42bda0'}),'build v0.99.3');
  assert.equal(versionLabel({...base,profileLabel:'21-Sep-2026 (aef3ef9d)'}),'build 21-Sep-2026','no build string: the date label');
  assert.equal(versionLabel({...base,profileLabel:'21-Sep-2026 (aef3ef9d)',buildString:'nonsense'}),'build 21-Sep-2026','a malformed string is ignored');
  assert.equal(versionLabel({...base,label:'My save',buildString:'0.99.3-278abe752c42bda0'}),'My save','a custom label still wins');

  const {matchWorldProfileEntryByHash}=await load('src/extract/world/profile.ts');
  const hash='aef3ef9d79c99a44'+'0'.repeat(48);
  const profile=(extra:any)=>({kind:'brighter-atlas-world-profile',format:1,label:'21-Sep-2026 (aef3ef9d)',bundle0:{raw_sha256:hash},
    stream:{object_count:1,constructor_start:0,constructor_end:1,fill_start:1},class_fields:{},tag6_fields:{},selectors:{},...extra});
  const entry=async(extra:any)=>(await matchWorldProfileEntryByHash(hash,{fetchJson:async()=>profile(extra)})).entry;
  assert.equal((await entry({build:{string:'0.99.3-278abe752c42bda0'}}))?.build,'0.99.3-278abe752c42bda0','the entry carries the build string');
  assert.equal((await entry({}))?.build,undefined,'older data has none');
  assert.equal((await entry({build:{string:'oops'}}))?.build,undefined,'a malformed one is dropped');
  assert.equal((await entry({}))?.label,'21-Sep-2026 (aef3ef9d)');
  console.log('Build names: the game version names builds, older or malformed data keeps the date label, custom names win');
}finally{await rm(tmp,{recursive:true,force:true});}
