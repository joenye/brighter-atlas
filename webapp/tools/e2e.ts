// Real-bundle end-to-end (local-only, needs the game bundles): a fresh
// browser profile uploads assetBundle0..8 through the onboarding wizard,
// extracts EVERY category including World, then asserts the whole app is
// alive (populated catalogs, a painted 3D mesh, decoded audio, a rendered
// image, a painted world room, a non-empty Models list) with zero console
// errors throughout.
//
//   node e2e.ts [--bundles PATH] [--room N]
//
// Skips cleanly (exit 0) unless BS_BUNDLES (or --bundles, or the repo root)
// points at assetBundle0..8 from your own Brighter Shores install. Extracting
// everything takes a few minutes on a mid-range machine; timeouts are
// generous. A screenshot of the rendered room lands in webapp/screenshots/
// (git-ignored) for human review.
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { serve } from './serve.ts';
import { CHROME, GL_ARGS } from './chrome.ts';
import { WEBAPP, bundlePath, requireBundles, requireBuild, shimWebroot } from './env.ts';

requireBundles('e2e.ts');
requireBuild('e2e.ts');
if (!CHROME || !existsSync(CHROME)) {
  console.error('Chrome not found: set CHROME=/path/to/chrome or run: npx puppeteer browsers install chrome');
  process.exit(2);
}

const roomArg = process.argv.find((a) => a.startsWith('--room='))?.slice(7);
const DEFAULT_ROOM = 8564;   // Hopeport Garrison: dense, present in the supported builds
const SHOTS = path.join(WEBAPP, 'screenshots');

let pass = 0, fail = 0;
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? '  ok' : 'FAIL'} - ${msg}`); cond ? pass++ : fail++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// fraction of canvas pixels that differ from the app background: >5% means
// the view really painted, not just cleared
async function paintCoverage(page: any, sel = '.canvas-host canvas', bg = [16, 19, 26]) {
  return page.evaluate((sel, bg) => {
    const c = document.querySelector(sel);
    if (!c || !c.width) return -1;
    const t = document.createElement('canvas');
    const w = (t.width = Math.min(c.width, 800));
    const h = (t.height = Math.min(c.height, 600));
    const g = t.getContext('2d');
    g.drawImage(c, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let non = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 30) non++;
    }
    return non / (w * h);
  }, sel, bg);
}

// '3.42s' or '1:03.4' (the app's fmtDur forms) -> seconds
function parseDur(s: string) {
  s = (s || '').trim();
  const m = s.match(/^(\d+):([\d.]+)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return Number(s.replace(/s$/, '')) || 0;
}

// ---- a fresh webroot (no served data tree) + a fresh browser profile -------
const { root, cleanup } = await shimWebroot('bs-e2e-webroot-');
await fs.mkdir(SHOTS, { recursive: true });
const { server, port } = await serve(root);
const base = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new' as any,   // legacy new-headless flag, harmless on current Chrome
  dumpio: process.env.BS_E2E_DUMPIO === '1',        // surface renderer/OOM crashes when hunting
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio', ...GL_ARGS, '--window-size=1600,1000'],
});
const page: any = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
const errs: string[] = [];
const perfLines: string[] = [];
page.on('error', (e) => errs.push(`CRASH ${e?.message || 'page crashed'}`));   // renderer death (OOM etc.)
page.on('pageerror', (e) => errs.push(`PAGE ${e.message}`));
page.on('console', (m) => {
  // the fresh visit legitimately 404s the default HTTP data tree; individual
  // asset decode failures are surfaced (and tolerated) by the app itself
  const text = `${m.text()} ${m.location()?.url || ''}`;
  if (m.text().startsWith('[perf]')) perfLines.push(m.text());
  if (m.type() === 'error' && !/favicon|404 \(Not Found\)|decode failed/.test(text)) errs.push(`CONSOLE ${m.text()}`);
});

// ---- 1. onboarding: upload the real bundles, select everything --------------
let t0 = Date.now();
await page.goto(`${base}/index.html`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.ob-drop', { timeout: 15000 });
ok(true, 'fresh visit boots into the onboarding wizard');

const input = await page.$('.ob-drop input[type=file]');
await input.uploadFile(...Array.from({ length: 9 }, (_, n) => bundlePath(n)));
await sleep(500);
const okBundles = await page.$$eval('.ob-bundle.ok', (els) => els.length);
ok(okBundles === 9, `all 9 bundles recognised (${okBundles})`);

await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Continue')).click());
await page.waitForSelector('.ob-cat', { timeout: 5000 });
await page.waitForFunction(() => (document.querySelector('.ob-validate')?.textContent || '').trim().startsWith('✓'),
  { timeout: 60000 });
ok(true, 'picked-bundle validation reports the game index ok');
await sleep(3000);   // let the async World build check settle (decompress + hash ab0)
await page.$$eval('button', (b) => b.find((x) => x.textContent === 'select all')?.click());
const catState = await page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('.ob-cat')].map((row) => [
    row.querySelector('b').textContent,
    { checked: row.querySelector('input').checked, disabled: row.querySelector('input').disabled },
  ])));
ok(Object.values<any>(catState).every((s) => s.checked),
  `every category selected (${Object.keys(catState).join(', ')})`);
ok(catState.World && catState.World.checked && !catState.World.disabled,
  'World selectable: this build has decode data');
// the recognized build's human label shows on the upload screen, before
// extract: date only, the hash identity lives in the storage panel details
const validateText = await page.$eval('.ob-validate', (el) => el.textContent);
ok(/· build \d{2}-[A-Z][a-z]{2}-\d{4}\s*$/.test(validateText),
  `upload screen names the recognized build (${validateText.trim()})`);

// ---- 2. extraction (worker): the wizard reloads the page when done ----------
t0 = Date.now();
const navDone = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 1200000 }).then(() => true).catch(() => false);
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Extract').click());
console.log('  extracting every category (this takes a few minutes)…');
const poll = setInterval(async () => {
  const rows = await page.$$eval('.ob-bar-row', (rs) => rs.slice(-2).map((r) => r.textContent.trim())).catch(() => null);
  if (rows?.length) console.log('   ', rows.join(' | ').slice(0, 140));
}, 10000);
const navigated = await navDone;
clearInterval(poll);
if (!navigated) {
  const status = await page.$$eval('.onboard p', (ps) => ps.map((p) => p.textContent).join(' | ')).catch(() => '?');
  console.log('  wizard status at timeout:', status.slice(0, 300));
}
ok(navigated, `extraction + reload completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const line of perfLines) console.log(`  ${line}`);   // in-page stage timings (no skew)

// the version chip carries the profile build label (date, no hash), not the
// mtime-date or content-id fallbacks a label regression would leave behind
const chipText = await page.$eval('#data-source', (el) => el.textContent);
ok(/^build \d{2}-[A-Z][a-z]{2}-\d{4}$/.test(chipText.trim()),
  `version chip names the build from its decode data (${chipText.trim()})`);

// ---- 3. catalogs populated ---------------------------------------------------
await page.waitForFunction(
  () => /\d/.test(document.querySelector('.cat-tab[data-cat="meshes"] .ct-count')?.textContent || ''),
  { timeout: 120000 });
const counts = await page.$$eval('.cat-tab', (tabs) => Object.fromEntries(
  tabs.map((t) => [t.dataset.cat, Number((t.querySelector('.ct-count')?.textContent || '0').replace(/,/g, ''))])));
for (const [cat, min] of [['meshes', 100], ['images', 100], ['audio', 100], ['strings', 100], ['rigs', 10], ['anims', 10]]) {
  ok(counts[cat] > min, `${cat} list populated (${counts[cat] ?? 'no tab'} > ${min})`);
}

// Recovered animatic names rode in with the World extraction and are merged
// onto the anims index (client-store `sn`): the player one-handed blunt
// attack family names clip 567.
const clip567Names = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('anims');
  return idx.find((c) => c.i === 567)?.sn || null;
});
ok(Array.isArray(clip567Names)
  && clip567Names.some((n) => n.includes('player_male_one_handed_blunt_attack')),
`clip 567 carries its recovered animatic name (${JSON.stringify(clip567Names)})`);

// Recovered wearable-item mesh names rode in with the World extraction and are
// merged onto the meshes index (client-store `sn`). Resolve the stable Easter
// Warden Cape mesh by content hash (never ordinal). Its item-def row names it.
const capeSn = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('meshes');
  return idx.find((m) => m.h === 'bfc98d6cf426d092')?.sn || null;
});
ok(Array.isArray(capeSn) && capeSn.includes('Easter Warden Cape'),
  `Easter Warden Cape mesh carries its recovered item name (${JSON.stringify(capeSn)})`);

// Regular (non-cosmetic) profession/guard gear is recovered too, via the gear
// item family's typed-ref hub-join. The Horned Helmet mesh (stable content
// hash) must carry its name AND its equip slot 'head'.
const horned = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('meshes');
  const m = idx.find((e) => e.h === '225c54275e933e07');
  return m ? { sn: m.sn || null, slot: m.slot || null } : null;
});
ok(horned && Array.isArray(horned.sn) && horned.sn.includes('Horned Helmet') && horned.slot === 'head',
  `Horned Helmet mesh carries its gear name + equip slot (${JSON.stringify(horned)})`);

// The player-equippable set is grouped by equip slot: hundreds of rig-239
// meshes (armour + cosmetics) now carry a `slot`, far more than the ~81
// cosmetic-only names before.
const gearCount = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('meshes');
  return idx.filter((m) => typeof m.slot === 'string').length;
});
ok(gearCount > 300, `player-equippable meshes carry an equip slot (${gearCount} > 300)`);

// Profession/skill/region/combat capes are recovered too: dozens of tier items
// share one cape geometry, so tiers collapse to a concise base name. The Fisher
// Cape mesh (stable content hash) carries "Fisher Cape" in the cape slot.
const cape = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('meshes');
  const m = idx.find((e) => e.h === '5cc72f530e307e03');
  return m ? { sn: m.sn || null, slot: m.slot || null } : null;
});
ok(cape && Array.isArray(cape.sn) && cape.sn.includes('Fisher Cape') && cape.slot === 'cape',
  `cape mesh carries its recovered profession-cape name + slot (${JSON.stringify(cape)})`);

// Region capes reach their worn mesh only through the pool (no typed edge), so
// they need the emblem-gated hub-pruned pooled fallback. Verify the town capes
// resolve onto a cape-slot mesh (name-based: these share geometry with the
// town guard cape, which the emblem gate keeps off the mesh).
const regionCapes = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('meshes');
  const want = ['Hopeport Cape', 'Hopeforest Cape', 'Crenopolis Cape', 'Mine of Mantuban Cape'];
  const found = want.filter((name) => idx.some((e) => Array.isArray(e.sn) && e.sn.includes(name) && e.slot === 'cape'));
  return { found, missing: want.filter((n) => !found.includes(n)) };
});
ok(regionCapes.missing.length === 0,
  `region capes recovered onto cape-slot meshes (${JSON.stringify(regionCapes)})`);

// World category present, with a stored room index
ok('world' in counts, 'World category tab appears');
const rooms = await page.evaluate(async () => ((await window.__bs.app.store.worldIndex())?.rooms || [])
  .map((r) => ({ id: r.id, name: r.name, meshes: r.meshes?.length || 0 })));
ok(rooms.length > 100, `world index stored (${rooms.length} rooms)`);

// ---- 4. mesh route: a painted 3D canvas --------------------------------------
// flagship mesh: the biggest exported one, via the UI's own triangles sort
await page.goto(`${base}/index.html#/meshes`, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__bs?.app && document.querySelector('#list-host .vrow'), { timeout: 30000 });
await page.select('#list-sort', 'triangles');
await sleep(400);
const meshI = await page.evaluate(() => window.__bs.app.filteredItems().find((m) => m.f)?.i ?? null);
ok(meshI != null, `picked the largest exported mesh (#${meshI})`);
await page.goto(`${base}/index.html#/mesh/${meshI}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.canvas-host canvas', { timeout: 30000 });
await sleep(2000);
const covMesh = await paintCoverage(page);
ok(covMesh > 0.05, `mesh #${meshI} renders a painted 3D canvas (coverage ${(covMesh * 100).toFixed(1)}% > 5%)`);

// ---- 4b. skinned playback on real data ----------------------------------------
const skinnedI = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('meshes');
  return idx.find((m) => m.sk && m.skel >= 0 && m.f)?.i ?? null;
});
ok(skinnedI != null, `picked a skinned mesh with a rig (#${skinnedI})`);
await page.goto(`${base}/index.html#/mesh/${skinnedI}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.anim-bar select', { timeout: 30000 });
await sleep(800);
const clipVal = await page.$eval('.anim-bar select',
  (s) => [...s.options].find((o) => o.value !== '-1' && !o.disabled)?.value ?? null);
if (clipVal != null) {
  await page.select('.anim-bar select', clipVal);
  await sleep(1200);
  const rigMoved = await page.evaluate(() => {
    const v = window.__bs.meshView;
    if (!v?.rig || !v.bar?.sampler) return null;
    const snap = () => v.rig.bones.map((b) =>
      [...b.position.toArray(), ...b.quaternion.toArray(), ...b.scale.toArray()]
        .map((x) => +x.toFixed(4)).join(',')).join(';');
    const bar = v.bar;
    bar.pause();
    bar.t = 0.25 * bar.sampler.duration; bar.applyPose();
    const a = snap();
    bar.t = 0.55 * bar.sampler.duration; bar.applyPose();
    const b = snap();
    bar.play();
    return a !== b;
  });
  ok(rigMoved === true, `mesh #${skinnedI} clip ${clipVal} animates the rig (pose differs at 25% vs 55%)`);
} else {
  ok(true, `mesh #${skinnedI} has no exported clip on this build: playback check skipped`);
}

// ---- 5. audio route: decodes with a real duration -----------------------------
const audioEntry = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('audio');
  const e = idx.find((x) => x.f && x.dur > 0 && x.dur < 30) || idx.find((x) => x.f);
  return e ? { i: e.i, dur: e.dur, codec: e.codec } : null;
});
ok(audioEntry != null && audioEntry.dur > 0,
  `picked an audio entry with a duration (#${audioEntry?.i} ${audioEntry?.codec} ${audioEntry?.dur}s)`);
await page.goto(`${base}/index.html#/audio/${audioEntry.i}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.audio-wave-wrap canvas', { timeout: 30000 });
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll('.viewer-toolbar .btn')].find((x) => x.textContent === '▶');
  return b && !b.disabled;
}, { timeout: 60000 });
ok(true, `audio #${audioEntry.i} decodes (play control enabled)`);
await page.$$eval('.viewer-toolbar .btn', (btns) => btns.find((b) => b.textContent === '▶')?.click());
await sleep(600);
const audioTime = await page.$eval('.anim-time', (n) => n.textContent);
const [audioPos, audioTotal] = audioTime.split('/').map(parseDur);
ok(audioPos > 0 && audioTotal > 0, `audio plays with a decoded duration > 0 (${audioTime.trim()})`);

// ---- 5b. every audio codec decodes to a valid WAV through the SW --------------
const wavs = await page.evaluate(async () => {
  const store = window.__bs.app.store;
  const idx = await store.index('audio');
  const out = {};
  for (const codec of ['qoa', 'bslpc', 'opus']) {
    const e = idx.find((x) => x.codec === codec && x.f && x.dur < 30);
    if (!e) { out[codec] = null; continue; }
    const res = await fetch(store.url(e.f));
    const buf = new Uint8Array(await res.arrayBuffer());
    out[codec] = { i: e.i, status: res.status, riff: String.fromCharCode(...buf.slice(0, 4)), size: buf.length };
  }
  return out;
});
for (const [codec, w] of Object.entries<any>(wavs)) {
  if (!w) { ok(true, `no ${codec} entry on this build: WAV check skipped`); continue; }
  ok(w.status === 200 && w.riff === 'RIFF' && w.size > 44, `SW served a valid ${codec} WAV (#${w.i}, ${w.size} bytes)`);
}

// ---- 6. image route: paints through the service worker ------------------------
const imageI = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('images');
  return (idx.find((e) => e.cat === 'material' && e.f?.length) || idx.find((e) => e.f?.length))?.i ?? null;
});
ok(imageI != null, `picked an exported image (#${imageI})`);
await page.goto(`${base}/index.html#/image/${imageI}`, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => {
  const i = document.querySelector('.img-stage img');
  return i && i.naturalWidth > 0 && i.style.visibility !== 'hidden';
}, { timeout: 60000 });
ok(true, `image #${imageI} decodes + paints (SW-served PNG)`);

// ---- 6b. worldtex pre-warm consistency: cached PNGs == fresh SW decodes --------
// Regression guard for the foreign-image bug: the world extraction pre-warms
// decoded PNGs into the service worker's cache; for a sample of world-
// referenced containers, every sub-image URL's cached bytes must byte-equal a
// forced fresh decode (delete the cache entry, refetch through the SW).
const warmCheck = await page.evaluate(async () => {
  const store = window.__bs.app.store;
  const wi = await store.worldIndex();
  const roomEntry = (wi?.rooms || []).find((r) => Number(r.id) === 8564);
  const texIds = (roomEntry?.textures || []).filter((id) => id >= 500).slice(0, 3);
  const idx = await store.index('images');
  const byI = new Map(idx.map((e) => [e.i, e]));
  const cache = await caches.open('bs-decoded-v6');
  const out = { compared: 0, mismatches: [] };
  for (const id of texIds) {
    for (const rel of (byI.get(id) as any)?.f || []) {
      const abs = new URL(store.url(rel), location.href).href;
      const a = new Uint8Array(await (await fetch(abs)).arrayBuffer());
      await cache.delete(abs);
      const b = new Uint8Array(await (await fetch(abs)).arrayBuffer());
      out.compared++;
      if (a.length !== b.length || !a.every((v, j) => v === b[j])) out.mismatches.push(rel);
    }
  }
  return out;
});
ok(warmCheck.compared >= 3 && warmCheck.mismatches.length === 0,
  `pre-warmed PNGs byte-equal fresh SW decodes (${warmCheck.compared} compared${warmCheck.mismatches.length ? `, MISMATCH: ${warmCheck.mismatches.join(', ')}` : ''})`);

// ---- 7. world room: renders with real paint coverage --------------------------
if (!rooms.length) { console.log('\nFAILED: no rooms in the world index, cannot run the world checks'); process.exit(1); }
const ROOM = Number(roomArg)
  || (rooms.some((r) => r.id === DEFAULT_ROOM) ? DEFAULT_ROOM
    : rooms.reduce((a, b) => (b.meshes > a.meshes ? b : a)).id);   // densest room fallback
t0 = Date.now();
await page.goto(`${base}/index.html#/world/${ROOM}`, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__bs.worldView?.ready === true, { timeout: 300000 });
await sleep(2500);
console.log(`  room ${ROOM} loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const roomTitle = await page.$eval('.viewer-title', (n) => n.textContent).catch(() => '');
ok(new RegExp(`#${ROOM}`).test(roomTitle), `room viewer opened (${roomTitle || 'no title'})`);
const covRoom = await paintCoverage(page);
ok(covRoom > 0.05, `world room #${ROOM} paints (coverage ${(covRoom * 100).toFixed(1)}% > 5%)`);
ok(await page.evaluate(() => window.__bs.worldView.visibleInstanceCount() > 0),
  'room renders visible instances');
const shot = path.join(SHOTS, `e2e_world_room_${ROOM}.png`);
await page.screenshot({ path: shot });
console.log(`  screenshot: ${shot}`);

// ---- 7b. all-rooms load timing (opt-in: BS_E2E_ALL_ROOMS=1) --------------------
// Heavy (~all 451 rooms streamed + merged bake, SwiftShader here): perf
// measurement only, never asserted, kept out of the default gate's runtime.
if (process.env.BS_E2E_ALL_ROOMS === '1') {
  await page.goto(`${base}/index.html#/world/all`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.world-loading .world-load-confirm', { timeout: 30000 });
  t0 = Date.now();
  await page.click('.world-loading .world-load-confirm');
  await page.waitForFunction(() => window.__bs.worldView?.ready === true, { timeout: 1800000, polling: 1000 });
  const allSecs = ((Date.now() - t0) / 1000).toFixed(1);
  const probe = await page.evaluate(() => ({
    timeline: window.__bs.worldView.loadTimeline,
    stall: window.__bs.worldView.stallProbe,
    env: document.querySelector('.wh-env')?.textContent || '',
    bake: window.__bs.worldView.merged?.buildStats || null,
  }));
  console.log(`  [perf] all-rooms ${allSecs}s (${probe.env || 'env unknown'})`);
  let prev = probe.timeline[0]?.t ?? 0;
  for (const { stage, t } of probe.timeline) {
    console.log(`    ${((t - prev) / 1000).toFixed(1).padStart(7)}s → ${stage}`);
    prev = t;
  }
  console.log(`    stall: worst ${Math.round(probe.stall?.worst || 0)}ms @ "${probe.stall?.worstStage}" · finalize ${Math.round(probe.stall?.finalizeWorst || 0)}ms @ "${probe.stall?.finalizeWorstStage}"`);
  if (probe.bake) console.log(`    bake: mode=${probe.bake.mode} loop=${probe.bake.bucketLoopMs}ms mathWait=${probe.bake.mathWaitMs}ms drainWait=${probe.bake.drainWaitMs}ms`);
  ok(true, `all-rooms loaded in ${allSecs}s (perf run)`);
}

// ---- 7c. roaming-enemy roster spawns: Bear Clearing renders bears -------------
// (room 78 has no positioned actor records for bears; the roster markers
// carry authored tiles -> origin=roster; approximate fallbacks are flagged 2)
const bearSpawns = await page.evaluate(async () => {
  const store = window.__bs.app.store;
  const [index, shard] = await Promise.all([store.worldIndex(), store.worldRoom(78)]);
  const cols: Record<string, number> = {};
  (index?.columns?.spawn || []).forEach((name: string, i: number) => { cols[name] = i; });
  const rows = (shard?.spawns || []).filter((r) => r[cols.label] === 'Bear');
  return rows.map((r) => ({ x: r[cols.x], y: r[cols.y], origin: r[cols.origin], sz: r[cols.surface_z] }));
});
// grounded like the room's actor spawns (floor ~2560 native units): the
// minimap-frame y-flip regression put bears on treetops 9+ layers up
ok(bearSpawns.length >= 1 && bearSpawns.every((s) => (s.origin === 1 || s.origin === 2)
  && Number.isFinite(s.sz) && s.sz >= 1536 && s.sz <= 4096),
  `Bear Clearing carries grounded roster bear spawns (${JSON.stringify(bearSpawns)})`);

// ---- 8. Models list: the system catalog arrived with the World extraction -----
await page.goto(`${base}/index.html#/models`, { waitUntil: 'networkidle0' });
await page.waitForSelector('#list-host .vrow', { timeout: 30000 });
const modelRows = await page.$$eval('#list-host .vrow', (r) => r.length);
ok(modelRows > 0, `Models list is non-empty (${modelRows} visible rows)`);

// ---- 8b. variant strip: 3D thumbnails + full keyboard navigation --------------
const vm = await page.evaluate(() => {
  const m = (window.__bs.app.allModels() || []).find((x) => x.source === 'system' && (x.variants?.length || 0) >= 2);
  return m ? { id: m.id, variants: m.variants.length } : null;
});
ok(vm != null, `found a multi-variant system model (${vm?.variants ?? 0} variants)`);
if (vm) {
  await page.goto(`${base}/index.html#/model/${vm.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.variant-strip', { timeout: 20000 });
  const cells = await page.$$eval('.variant-strip .subthumb', (c) => c.length);
  ok(cells === vm.variants, `variant strip shows one cell per variant (${cells}/${vm.variants})`);
  await page.waitForSelector('.variant-strip .subthumb img', { timeout: 60000 });
  ok(await page.$eval('.variant-strip .subthumb img', (i: any) => i.src.startsWith('data:image/png')),
    'variant thumbnails render as 3D previews');
  await page.keyboard.press('ArrowRight');   // enter the strip (focus current)
  await page.keyboard.press('ArrowRight');   // advance to variant 1 (remounts)
  await page.waitForFunction(() => [...document.querySelectorAll('.variant-strip .subthumb')]
    .findIndex((c) => c.classList.contains('active')) === 1, { timeout: 30000 });
  ok(true, 'ArrowRight advances to the next variant');
  ok(await page.$('.variant-strip .subthumb.kb-focus') !== null, 'strip keeps keyboard focus after the switch');
  await page.keyboard.press('ArrowLeft');    // back to variant 0
  await page.waitForFunction(() => [...document.querySelectorAll('.variant-strip .subthumb')]
    .findIndex((c) => c.classList.contains('active')) === 0, { timeout: 30000 });
  await page.keyboard.press('ArrowLeft');    // leftmost: exits strip focus to the list
  await sleep(200);
  ok(await page.$('.variant-strip .subthumb.kb-focus') === null,
    'ArrowLeft on the leftmost variant returns keyboard focus to the list');
}

// ---- 8a. enemy card anchor: base name + neutral tints stay identity -----------
// The Street Hag card: the enemy-definition base name wins over the adjective
// variant labels (naming anchor). Every one of its tint channels is the
// grey-127 neutral sentinel (no authored colour), so the two-mask wash must NOT
// run: the neutral tints are recognised as identity and the card keeps its
// albedo (the same guard that keeps the pink staff crystals pink).
// resolve the merged card BY NAME: the id scheme is deterministic but the
// anchor must survive future merges
const hagCardId = await page.evaluate(async () => {
  const rel = window.__bs.app.store.manifest?.system?.models;
  const models = await window.__bs.app.store.json(rel);
  const named = models.filter((m) => m.name === 'Street Hag');
  return named.length === 1 ? named[0].id : `AMBIGUOUS:${named.length}`;
});
ok(typeof hagCardId === 'string' && hagCardId.startsWith('sys-'),
  `Street Hag resolves to exactly one merged card (${hagCardId})`);
await page.goto(`${base}/index.html#/model/${hagCardId}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.canvas-host canvas', { timeout: 30000 });
await sleep(2500);
const hagState = await page.evaluate(() => {
  const scene = window.__bs.modelView?.scene?.scene;
  const out = { applied: 0, identity: 0, materials: 0, title: document.querySelector('.viewer-title')?.textContent || '' };
  scene?.traverse((node) => {
    const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const mat of mats) {
      out.materials++;
      const st = mat.userData?.exactRecolor;
      if (st?.applied) out.applied++;
      else if (st?.fallback === 'identity-neutral-tints') out.identity++;
    }
  });
  return out;
});
ok(hagState.identity > 0 && hagState.applied === 0 && /Street Hag/.test(hagState.title),
  `Street Hag named; neutral grey-127 tints render as identity, no wash (${JSON.stringify(hagState)})`);
await page.screenshot({ path: path.join(SHOTS, 'e2e_model_street_hag.png') });

// ---- 8a1. an authored-tint card still compiles its two-mask recolor -----------
// The neutral-identity guard must not disable genuine authored colours: pick the
// system card with the most non-neutral recolour tints (an NPC's clothing) and
// confirm its material recolour still compiles + applies in the viewer.
const coloredCardId = await page.evaluate(async () => {
  const rel = window.__bs.app.store.manifest?.system?.models;
  const models = await window.__bs.app.store.json(rel);
  const isNeutral = (c) => {
    const [r, g, b] = c;
    return (r >= 0.999 && g >= 0.999 && b >= 0.999)
      || (Math.abs(r - 127 / 255) < 1.5 / 255 && Math.abs(g - 127 / 255) < 1.5 / 255 && Math.abs(b - 127 / 255) < 1.5 / 255);
  };
  let best = null; let bestColored = 0;
  for (const m of models) {
    const v0 = (m.variants || m.appearances || [])[0];
    if (!v0?.parts) continue;
    let colored = 0;
    for (const p of v0.parts) {
      const rc = p.recolors || p.recolors_observed;
      if (!Array.isArray(rc)) continue;
      const tints = rc.length === 3 ? rc.slice(0, 2) : rc;
      if (!tints.every(isNeutral)) colored++;
    }
    if (colored > bestColored) { bestColored = colored; best = m.id; }
  }
  return best;
});
ok(typeof coloredCardId === 'string' && coloredCardId.startsWith('sys-'),
  `found a system card with authored (non-neutral) recolours (${coloredCardId})`);
await page.goto(`${base}/index.html#/model/${coloredCardId}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.canvas-host canvas', { timeout: 30000 });
await sleep(2500);
const coloredState = await page.evaluate(() => {
  const scene = window.__bs.modelView?.scene?.scene;
  const out = { applied: 0, twoMask: 0 };
  scene?.traverse((node) => {
    const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const mat of mats) {
      const st = mat.userData?.exactRecolor;
      if (st?.applied) { out.applied++; if (st.mode === 'two-mask') out.twoMask++; }
    }
  });
  return out;
});
ok(coloredState.applied > 0,
  `authored-tint card still compiles its recolour into the shader (${JSON.stringify(coloredState)})`);

// ---- 8a2. Troll Mystic: crystal keeps its authored PINK albedo ----------------
// The staff crystal parts carry the grey-127 neutral tint sentinel (no authored
// colour) over a mask covering the pink gem. The two-mask formula colourises
// from luminance, so running it desaturated the gem to grey/white; the neutral
// grey-127 tint is now recognised as identity (like white) and the recolour is
// skipped, so the pink albedo shows. Every Troll Mystic part is neutral-tinted,
// so none should be an APPLIED recolour and its albedo map must survive.
const trollId = await page.evaluate(async () => {
  const rel = window.__bs.app.store.manifest?.system?.models;
  const models = await window.__bs.app.store.json(rel);
  return models.find((m) => m.name === 'Troll Mystic')?.id || null;
});
await page.goto(`${base}/index.html#/model/${trollId}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.canvas-host canvas', { timeout: 30000 });
await sleep(2500);
const trollState = await page.evaluate(() => {
  const scene = window.__bs.modelView?.scene?.scene;
  const out = { applied: 0, identity: 0, identityWithMap: 0, title: document.querySelector('.viewer-title')?.textContent || '' };
  scene?.traverse((node) => {
    const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const mat of mats) {
      const st = mat.userData?.exactRecolor;
      if (!st) continue;
      if (st.applied) out.applied++;
      else if (st.fallback === 'identity-neutral-tints') {
        out.identity++;
        if (mat.map) out.identityWithMap++;
      }
    }
  });
  return out;
});
ok(trollState.identityWithMap > 0 && trollState.applied === 0 && /Troll Mystic/.test(trollState.title),
  `Troll Mystic crystal keeps its pink albedo: neutral grey-127 tints are identity, none recoloured (${JSON.stringify(trollState)})`);
await page.screenshot({ path: path.join(SHOTS, 'e2e_model_troll_mystic.png') });

// ---- 8b. strings viewer + global search ----------------------------------------
await page.goto(`${base}/index.html#/strings`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vrow', { timeout: 15000 });
const stringRows = await page.$$eval('.vrow', (r) => r.length);
ok(stringRows > 5, `strings list renders (${stringRows} visible rows)`);
await page.evaluate(() => { document.querySelector('.vrow').click(); });
await page.waitForSelector('.string-text', { timeout: 10000 });
ok(true, 'string viewer opens');
await page.evaluate(() => {
  const i = document.getElementById('global-search');
  i.value = 'sword';
  i.dispatchEvent(new Event('input'));
});
await sleep(700);
const searchHits = await page.$$eval('.search-item', (items) => items.length).catch(() => 0);
const searchGroups = await page.$$eval('.search-group', (g) => g.map((x) => x.textContent)).catch(() => []);
ok(searchHits > 0, `global search returns results (${searchHits} hits: ${searchGroups.join(', ') || 'no groups'})`);
await page.keyboard.press('Escape');

// ---- 8c. storage panel opens from the topbar chip -------------------------------
await page.evaluate(() => document.getElementById('data-source').click());
await page.waitForSelector('.ver-row', { timeout: 10000 });
ok(true, 'storage & versions panel opens from the topbar chip');
// the identity + timing moved out of the name into the details line:
// added/built timestamp with HH:MM:SS, the decode-data build id, the version id
const verDetails = await page.$eval('.ver-details', (el) => el.textContent);
const decodeIdTxt = await page.$eval('.ver-details .mono', (el) => el.textContent);
ok(/\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}:\d{2}/.test(verDetails) && /^build [0-9a-f]{8}$/.test(decodeIdTxt.trim()),
  `version details carry the timestamp + decode-data id (${verDetails.trim()})`);
await sleep(200);

// ---- 9. return visit: instant boot from storage, no re-extract ----------------
t0 = Date.now();
await page.goto(`${base}/index.html`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.vrow', { timeout: 20000 });
ok((Date.now() - t0) < 15000, `return visit boots from storage in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
ok(await page.$('.ob-drop') === null, 'no onboarding on return visit');

// ---- 0.4.0 upgrade notice: fires for pre-0.4.0 data, ack persists ---------------
// A fresh extraction stamps `engine` on the version record; strip it to
// simulate data extracted by an older release, reload, and expect the notice.
await page.evaluate(() => new Promise<void>((resolve, reject) => {
  const open = indexedDB.open('bs-assets');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const tx = db.transaction('versions', 'readwrite');
    const st = tx.objectStore('versions');
    const all = st.getAll();
    all.onsuccess = () => {
      for (const rec of all.result) { delete rec.engine; st.put(rec); }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
}));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.notice-modal', { timeout: 15000 });
ok(await page.$eval('.notice-modal', (n) => /fresh extraction/i.test(n.textContent || '')),
  'pre-0.4.0 data: upgrade notice prompts for a fresh extraction');
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.notice-modal button')]
    .find((b: any) => b.textContent === 'Understood') as any;
  btn.click();
});
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1500));
ok(await page.$('.notice-modal') === null, 'acknowledged notice stays dismissed');

// ---- zero console errors throughout -------------------------------------------
ok(errs.length === 0, `zero page/console errors (${errs.length})`);
errs.slice(0, 10).forEach((e) => console.log('   ', e));

await browser.close();
server.close();
await cleanup();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
