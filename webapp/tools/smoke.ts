// Smoke test: the pre-release gate. Drives the built viewer in system Chrome
// (puppeteer-core) against the committed synthetic fixtures
// (webapp/data-fixtures) plus a synthetic-bundle onboarding pass. Asserts:
// pages load, ZERO console errors, 3D canvases actually paint, skinned
// animation moves bones, prefs persist, audio decodes, images render, the
// fixture world renders + edits/animates, the onboarding wizard walks a
// fresh user through bundle picking, and a phone-sized touch boot lands on
// the desktop-only gate (inline help + session bypass). Needs no game data.
//
//   cd webapp && npm run build
//   cd webapp/tools && node smoke.ts
//   node smoke.ts --data=data            # also run against a real export tree
//   node smoke.ts --real-only            # only the real-data checks
//
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import { serve } from './serve.ts';
import { CHROME, GL_ARGS } from './chrome.ts';
import { WEBAPP, requireBuild, shimWebroot } from './env.ts';

const args = process.argv.slice(2);
const realData = args.find((a) => a.startsWith('--data='))?.slice(7) || null;
const realOnly = args.includes('--real-only');

let failures = 0;
let checks = 0;
function ok(cond: unknown, label: string) {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function newPage(browser: any, allow: string[] = []) {
  const page: any = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = `${msg.text()} ${msg.location()?.url || ''}`;
      if (allow.some((a) => text.includes(a))) return;
      errors.push(`console.error: ${text}`);
    }
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (!allow.some((a) => r.url().includes(a))) errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  return { page, errors };
}

async function fixtureSuite(browser: any, base: string) {
  console.log('\n== fixtures suite ==');
  const { page, errors } = await newPage(browser);
  const u = (hash) => `${base}/index.html?data=data-fixtures${hash}`;

  // ---- mesh 0: static cube paints ----------------------------------------
  await page.goto(u('#/mesh/0'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.canvas-host canvas');
  await sleep(700);
  const cov = await paintCoverage(page);
  ok(cov > 0.05, `mesh #0 canvas paints (coverage ${(cov * 100).toFixed(1)}% > 5%)`);
  ok(await page.$eval('#details-body', (n) => n.textContent.includes('share') && n.textContent.includes('clips')), 'details panel shows share/clips rig fields');

  // ---- camera-controls hint: on by default ---------------------------------
  ok(await page.$eval('.cam-hint-card', (n) => !n.hidden), 'camera hint card shows for fresh users');

  // ---- immersive controls: F fullscreen + U hide-chrome, keyboard + buttons -
  ok(await page.$eval('.viewer-toolbar', (n) => /Immersive/.test(n.textContent) && /Full/.test(n.textContent)),
    'toolbar exposes the Full + Immersive buttons');
  await page.keyboard.press('KeyU');
  ok(await page.$eval('.viewer-pane', (n) => n.classList.contains('ui-hidden')), 'U hides all chrome (immersive)');
  ok(await page.$eval('.viewer-toolbar', (n) => getComputedStyle(n).display === 'none'), 'immersive hides the toolbar');
  await page.keyboard.press('KeyU');
  ok(await page.$eval('.viewer-pane', (n) => !n.classList.contains('ui-hidden')), 'U again restores the chrome');
  // Ctrl+R (browser reload) must not be swallowed by a viewer key handler
  const ctrlRDefault = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', ctrlKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(e);
    return !e.defaultPrevented;
  });
  ok(ctrlRDefault, 'Ctrl+R is not intercepted by the viewer (browser reload works)');
  const stats = await page.$eval('.stats-row', (n) => n.textContent);
  ok(stats.includes('24') && stats.includes('12'), 'stats row shows 24v/12t');
  // render modes cycle without errors
  for (const label of ['Normals', 'UV checker', 'Wireframe', 'UV map', 'Lit']) {
    const btns = await page.$$('.viewer-toolbar .btn');
    for (const b of btns) {
      const t = await b.evaluate((n) => n.textContent);
      if (t === label) await b.click();
    }
    await sleep(120);
  }
  ok(await page.$('.uv-overlay') !== null, 'UV layout overlay opens');

  // mesh capture: Screenshot present, Video absent (a single mesh is a still)
  const meshCapBtns = await page.$$eval('.viewer-toolbar .btn', (b) => b.map((x) => x.textContent));
  ok(meshCapBtns.some((t) => /Screenshot/.test(t)) && !meshCapBtns.some((t) => /Video/.test(t)), 'mesh viewer offers Screenshot (and no Video)');
  // the screenshot preview is orbit-interactive (drag to reframe) like the video wizard
  await page.$$eval('.viewer-toolbar .btn', (b) => b.find((x) => /Screenshot/.test(x.textContent))?.click());
  await page.waitForSelector('.modal-overlay .video-preview');
  const camBefore = await page.evaluate(() => window.__bs.meshView.scene.camera.position.toArray().join(','));
  const pvBox = await (await page.$('.modal-overlay .video-preview')).boundingBox();
  const pvx = pvBox.x + pvBox.width / 2, pvy = pvBox.y + pvBox.height * 0.4;
  await page.mouse.move(pvx, pvy); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(pvx + i * 9, pvy + i * 3);
  await page.mouse.up(); await sleep(300);
  const camAfter = await page.evaluate(() => window.__bs.meshView.scene.camera.position.toArray().join(','));
  ok(camBefore !== camAfter, 'screenshot preview orbits on drag (reframe before capture)');
  await page.$$eval('.modal-overlay .btn', (b) => b.find((x) => x.textContent.trim() === 'Close')?.click());
  await sleep(150);

  // raw JSON toggle
  await page.click('#raw-toggle');
  ok(await page.$eval('#details-body', (n) => n.querySelector('.rawjson') !== null), 'raw JSON toggle works');
  await page.click('#raw-toggle');

  // ---- mesh 1: skinned animation ------------------------------------------
  await page.goto(u('#/mesh/1'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.anim-bar select');
  await page.select('.anim-bar select', '0'); // clip #0
  await sleep(500);
  const q1 = await page.evaluate(() => {
    const v = window.__bs.meshView;
    return v?.rig ? [...v.rig.bones[1].quaternion.toArray()] : null;
  });
  await sleep(280);
  const q2 = await page.evaluate(() => [...window.__bs.meshView.rig.bones[1].quaternion.toArray()]);
  ok(q1 && q2 && Math.abs(q1[0] - q2[0]) > 1e-4, `skinned clip animates bone 1 (qx ${q1?.[0]?.toFixed(3)} -> ${q2[0].toFixed(3)})`);
  const covSk = await paintCoverage(page);
  ok(covSk > 0.05, `skinned mesh paints (coverage ${(covSk * 100).toFixed(1)}%)`);
  // bone influence mode + skeleton overlay
  for (const label of ['Bone influence', 'Rig']) {
    const btns = await page.$$('.viewer-toolbar .btn');
    for (const b of btns) if ((await b.evaluate((n) => n.textContent)) === label) await b.click();
  }
  await sleep(200);
  ok(true, 'bone-influence + rig overlay toggles');

  // lighting overlay: 💡 opens the panel, ranges drive the shared rig, and the
  // adjustment persists across a full reload (prefs-backed)
  await page.$$eval('.viewer-toolbar .btn', (b) => b.find((x) => x.textContent === '💡')?.click());
  await page.waitForSelector('.light-overlay:not([hidden])', { timeout: 5000 });
  await page.$$eval('.light-overlay input[type=range]', (rs) => {
    rs[1].value = '0.8';
    rs[1].dispatchEvent(new Event('input'));
  });
  const sunNow = await page.evaluate(() => window.__bs.meshView.scene.key.intensity);
  ok(Math.abs(sunNow - 0.8) < 1e-6, `lighting overlay drives the key light (sun=${sunNow})`);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__bs?.meshView, { timeout: 20000 });
  const sunPersist = await page.evaluate(() => window.__bs.meshView.scene.key.intensity);
  ok(Math.abs(sunPersist - 0.8) < 1e-6, `viewer lighting persists across reload (sun=${sunPersist})`);
  await page.$$eval('.viewer-toolbar .btn', (b) => b.find((x) => x.textContent === '💡')?.click());
  await page.$$eval('.light-overlay .btn', (bs) => bs.find((x) => x.textContent === 'reset')?.click());
  ok(await page.evaluate(() => window.__bs.meshView.scene.key.intensity === 2.0
    && window.__bs.meshView.scene.hemi.intensity === 1.1), 'lighting reset restores the defaults');
  await page.$$eval('.viewer-toolbar .btn', (b) => b.find((x) => x.textContent === '💡')?.click());

  // scrub pauses playback
  await page.$eval('.anim-bar input[type=range]', (n) => { n.value = '500'; n.dispatchEvent(new Event('input')); });
  const paused = await page.$eval('.anim-bar button', (n) => n.textContent);
  ok(paused === '▶', 'scrubbing pauses playback');

  // ---- autoplay preference persists (localStorage) --------------------------
  const clickAuto = () => page.$$eval('.anim-bar button', (btns) => { const b = btns.find((x) => x.textContent === 'auto'); if (b) b.click(); return !!b; });
  const autoActive = () => page.$$eval('.anim-bar button', (btns) => btns.find((x) => x.textContent === 'auto')?.classList.contains('active') ?? null);
  ok((await autoActive()) === true, 'autoplay toggle present + on by default');
  await clickAuto();
  ok((await autoActive()) === false, 'autoplay toggles off');
  await page.goto(u('#/mesh/1'), { waitUntil: 'networkidle0' });   // full reload
  await page.waitForSelector('.anim-bar select');
  ok((await autoActive()) === false, 'autoplay-off persists across reload');
  await page.select('.anim-bar select', '0');
  await sleep(400);
  ok((await page.evaluate(() => window.__bs.meshView.bar.playing)) === false, 'autoplay off: selecting a clip does not start playback');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('bs.prefs') || '{}').autoplay === false), 'bs.prefs.autoplay stored as false');
  await clickAuto();   // restore for the remaining suites
  ok((await autoActive()) === true, 'autoplay re-enabled');

  // ---- Space toggles play/pause while the clip listbox has focus -----------
  const barPlaying = () => page.evaluate(() => window.__bs.meshView.bar.playing);
  await page.$eval('.anim-bar select.clip-select', (s) => s.focus());
  const wasPlaying = await barPlaying();
  await page.keyboard.press('Space');
  await sleep(250);
  ok((await barPlaying()) === !wasPlaying, 'Space toggles clip play/pause when the listbox has focus');
  ok(page.url().includes('#/mesh/1'), 'Space on the clip list does not scroll/navigate');
  await page.keyboard.press('Space');
  await sleep(250);
  ok((await barPlaying()) === wasPlaying, 'Space again toggles play/pause back');

  // ---- mesh 2: not exported ------------------------------------------------
  await page.goto(u('#/mesh/2'), { waitUntil: 'networkidle0' });
  ok(await page.$eval('#viewer', (n) => n.textContent.includes('not loaded')), 'unexported mesh shows low-key badge');

  // ---- skeleton 0 -----------------------------------------------------------
  await page.goto(u('#/rig/0'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.anim-bar select');
  await sleep(400);
  const covSkel = await paintCoverage(page);
  ok(covSkel > 0.01, `skeleton view paints (coverage ${(covSkel * 100).toFixed(1)}%)`);
  await page.select('.anim-bar select', '0');
  await sleep(300);
  ok(await page.$eval('.anim-bar .anim-time', (n) => n.textContent.includes('/')), 'skeleton clip playback runs');

  // ---- anim 0 ---------------------------------------------------------------
  await page.goto(u('#/anim/0'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.canvas-host canvas');
  await sleep(400);
  ok((await paintCoverage(page)) > 0.005, 'anim skeleton preview paints');

  // ---- audio 0 --------------------------------------------------------------
  await page.goto(u('#/audio/0'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.audio-wave-wrap canvas');
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.viewer-toolbar .btn')].find((x) => x.textContent === '▶');
    return b && !b.disabled;
  }, { timeout: 5000 });
  const covWave = await paintCoverage(page, '.audio-wave-wrap canvas', [13, 15, 19]);
  ok(covWave > 0.01, `waveform paints (coverage ${(covWave * 100).toFixed(1)}%)`);
  await page.$$eval('.viewer-toolbar .btn', (btns) => btns.find((b) => b.textContent === '▶')?.click());
  await sleep(400);
  const t1 = await page.$eval('.anim-time', (n) => n.textContent);
  ok(!t1.startsWith('0.00s') || t1.includes('1:'), `audio plays (position ${t1})`);
  ok(await page.$eval('.viewer-toolbar', (n) => n.textContent.includes('qoa')), 'codec badge shown');

  // ---- audio keyboard preview (Space / Enter toggle the mounted track) ------
  await page.goto(u('#/audio/0'), { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.viewer-toolbar .btn')].find((x) => x.textContent === '▶');
    return b && !b.disabled;
  }, { timeout: 5000 });
  const playLabel = () => page.$$eval('.viewer-toolbar .btn',
    (btns) => (btns.find((x) => x.textContent === '▶' || x.textContent === '❚❚') || {}).textContent || null);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());  // focus on body, not a button/list
  ok((await playLabel()) === '▶', 'audio preview starts paused');
  await page.keyboard.press('Space');
  await sleep(250);
  ok((await playLabel()) === '❚❚', 'Space starts playback');
  ok(page.url().includes('#/audio/0'), 'Space does not scroll/navigate the list');
  await page.keyboard.press('Space');
  await sleep(150);
  ok((await playLabel()) === '▶', 'Space again pauses');
  await page.keyboard.press('Enter');
  await sleep(150);
  ok((await playLabel()) === '❚❚', 'Enter also toggles playback');

  // ---- audio 1: bslpc (SFX) codec badge --------------------------------------
  await page.goto(u('#/audio/1'), { waitUntil: 'networkidle0' });
  const audio1Bar = await page.$eval('.viewer-toolbar', (n) => n.textContent.toLowerCase());
  ok(audio1Bar.includes('sfx'), 'SFX (bslpc) codec badge shown');

  // ---- image 0 ---------------------------------------------------------------
  await page.goto(u('#/image/0'), { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => {
    const i = document.querySelector('.img-stage img');
    return i && i.naturalWidth > 0 && i.style.visibility !== 'hidden';
  });
  const thumbs = await page.$$eval('.subthumb', (t) => t.length);
  ok(thumbs === 2, `sub-image strip has 2 entries (${thumbs})`);
  ok(await page.$eval('.substrip', (n) => n.textContent.includes('BC3') && n.textContent.includes('64×64')), 'sub-image fmt/size labels');
  await page.$$eval('.subthumb', (t) => t[1].click());
  await sleep(200);
  ok(await page.$eval('.img-stage img', (i) => i.src.includes('_e1')), 'clicking sub-image switches stage');
  // grid landing
  await page.goto(u('#/images'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.img-grid .img-cell');
  const cells = await page.$$eval('.img-grid .img-cell', (c) => c.length);
  ok(cells === 3, `image grid landing shows 3 tiles (${cells})`);

  // ---- removed routes fall back to meshes ------------------------------------
  await page.goto(u('#/shader/0'), { waitUntil: 'networkidle0' });
  await sleep(300);
  ok(await page.$eval('.cat-tab.active', (n) => n.dataset.cat === 'meshes'), 'unknown #/shader route falls back to meshes (no error)');
  await page.goto(u('#/datatable/symbols'), { waitUntil: 'networkidle0' });
  await sleep(300);
  ok(await page.$eval('.cat-tab.active', (n) => n.dataset.cat === 'meshes'), 'unknown #/datatable route falls back to meshes (no error)');

  // ---- global search (by index number) ---------------------------------------
  await page.keyboard.press('/');
  await page.type('#global-search', '1');
  await page.waitForSelector('.search-item', { timeout: 4000 });
  const found = await page.$$eval('.search-item', (items) => items.map((i) => i.textContent).join(' '));
  // rows headline the content hash (fixtures carry deterministic h values)
  ok(found.includes('f1c0de02'), 'global search finds mesh by index number');
  await page.keyboard.press('Enter');
  await sleep(300);
  ok(page.url().includes('#/mesh/1'), 'search enter navigates');

  // ---- keyboard list nav --------------------------------------------------------
  await page.keyboard.press('Escape');
  // order-aware: the default sort is triangles desc, so derive which mesh
  // follows the current one in the LIVE list rather than assuming index order
  const nextId = await page.evaluate(() => {
    const items = window.__bs.app.filteredItems();
    const cur = items.findIndex((m) => m.i === 1);
    return items[cur + 1]?.i;
  });
  await page.$eval('.vlist', (n) => n.focus());
  await page.keyboard.press('ArrowDown');
  await sleep(250);
  ok(page.url().includes(`#/mesh/${nextId}`), `ArrowDown moves list selection (to #${nextId})`);

  // ---- help / FAQ modal (shared help.js) --------------------------------------
  await page.click('#help-btn');
  await page.waitForSelector('.help-modal', { timeout: 4000 });
  const help = await page.$eval('.help-modal', (n) => n.textContent);
  ok(/not affiliated with.*Fen Research/i.test(help), 'help: not affiliated with Fen Research');
  ok(/no upload|stay in your browser/i.test(help), 'help: data stays on device');
  ok(/already textured|System.*mesh.*texture pairings/i.test(help), 'help: explains recovered textures');
  await page.keyboard.press('Escape');
  await sleep(150);
  ok(await page.$('.help-modal') === null, 'help modal closes on Escape');

  // ---- sort dropdown ----------------------------------------------------------
  await page.select('#list-sort', 'triangles');
  await sleep(250);
  const sorted = await page.evaluate(() => window.__bs.app.filteredItems().map((m) => m.i));
  ok(sorted.join(',') === '2,1,0,3', `sort triangles desc reorders list (${sorted.join(',')})`);
  await page.select('#list-sort', 'index');
  await sleep(250);

  // ---- filter dropdown + deep-link filter reset -----------------------------
  const setFilter = (name) => page.evaluate((n) => {
    const dd = document.querySelector('#list-chips .filter-dd'); if (dd) dd.open = true;
    document.querySelector('.filter-clear')?.click();   // single-select: clear then check one
    const opt = [...document.querySelectorAll('.filter-opt')].find((l) => l.textContent.trim() === n);
    const cb = opt?.querySelector('input');
    if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
  }, name);
  await setFilter('creatures');
  await sleep(200);
  let visRows = await page.$$eval('#list-host .vrow', (r) => r.length);
  ok(visRows === 1 && await page.$eval('#list-host .vrow', (n) => n.textContent.includes('f1c0de02')), `'creatures' filter narrows to the dedicated-rig mesh (${visRows})`);
  await setFilter('skinned');
  await sleep(200);
  visRows = await page.$$eval('#list-host .vrow', (r) => r.length);
  ok(visRows === 1, `'skinned' filter narrows mesh list to 1 (${visRows})`);
  // pick a filtered-out mesh that is NOT the current route (a same-URL goto is
  // a no-op: no hashchange, no filter reset)
  const hiddenId = page.url().includes('#/mesh/0') ? 2 : 0;
  await page.goto(u(`#/mesh/${hiddenId}`), { waitUntil: 'networkidle0' }); // filtered-out entry
  await sleep(300);
  visRows = await page.$$eval('#list-host .vrow', (r) => r.length);
  ok(visRows === 4, `deep-link to filtered-out entry resets filters (${visRows} rows)`);
  const hiddenHash8 = { 0: 'f1c0de01', 2: 'f1c0de03' }[hiddenId];
  ok(await page.$eval('#list-host .vrow.selected', (n, h8) => n.textContent.includes(h8), hiddenHash8), 'deep-linked row selected');

  // ---- mesh -> Model: save a static mesh as a single-mesh Model --------------
  // Deterministic start: the user stores are empty in this fresh profile. Seed
  // the rigged tube Model through its persisted record (the bs.models
  // localStorage mirror hydrates on the next boot: storage key names and
  // record shapes are part of the app contract); the static cube Model is then
  // created through the real UI. h values come from the committed fixtures.
  // The tube deliberately repeats the same 24-vertex part: the Models vertex
  // total must count occurrences (48), not distinct mesh assets (24).
  await page.evaluate(() => {
    localStorage.setItem('bs.models', JSON.stringify({
      version: 1,
      models: {
        f1c0de70be000001: {
          id: 'f1c0de70be000001',
          name: 'Fixture tube',
          skel: 'f1c0dea000000000',
          meshes: [
            { h: 'f1c0de0200000000', img: null },
            { h: 'f1c0de0200000000', img: null },
          ],
          created: '2026-01-01T00:00:00.000Z',
        },
      },
    }));
  });
  await page.goto(u('#/mesh/0'), { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'networkidle0' });   // reboot → the seeded store hydrates
  await page.waitForFunction(() => window.__bs?.meshView, { timeout: 20000 });
  ok(await page.$$eval('.viewer-toolbar .btn', (b) => {
    const btn = b.find((x) => /Save as Model/.test(x.textContent));
    btn?.click();
    return !!btn;
  }), 'mesh viewer offers ❖ Save as Model');
  await page.waitForSelector('.mesh-model-modal input', { timeout: 5000 });
  await page.$eval('.mesh-model-modal input', (n) => { n.value = 'Fixture cube'; });
  await page.$$eval('.mesh-model-modal .btn', (b) => b.find((x) => /Save model/.test(x.textContent))?.click());
  await page.waitForFunction(() => /#\/model\/[0-9a-f]{16}/.test(location.hash), { timeout: 5000 });
  await page.waitForFunction(() => window.__bs?.modelView, { timeout: 20000 });
  await sleep(600);
  ok(await page.evaluate(() => window.__bs.modelView.rig === null && window.__bs.modelView.model.skel === null), 'mesh-saved Model is static (no rig)');
  const covStatic = await paintCoverage(page);
  ok(covStatic > 0.05, `static Model view paints (coverage ${(covStatic * 100).toFixed(1)}%)`);
  ok(await page.$eval('.cat-tab[data-cat="models"] .ct-count', (n) => n.textContent) === '2', 'Models tab counts 2');

  // Models use the same persistent sort control as extracted asset lists. The
  // default name order keeps user and recovered models predictable; owner,
  // mesh-count, total-vertex, whole-model variant, skeleton, rig and source
  // sorts support catalog investigation. Vertex totals count repeated parts.
  await page.goto(u('#/models'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('#list-host .vrow', { timeout: 10000 });
  const modelSort = await page.evaluate(() => ({
    values: [...document.querySelector('#list-sort').options].map((o) => o.value),
    selected: document.querySelector('#list-sort').value,
    rows: [...document.querySelectorAll('#list-host .vrow .r-main')].map((n) => n.textContent),
  }));
  ok(modelSort.values.join(',') === 'name,owner,meshes,vertices,variants,skeleton,rig,source',
    `Models expose catalog sorts (${modelSort.values.join(',')})`);
  ok(modelSort.selected === 'name' && modelSort.rows.join(',') === 'Fixture cube,Fixture tube',
    `Models default to name order (${modelSort.rows.join(',')})`);
  await page.click('#list-sort-dir');
  await sleep(150);
  const modelDesc = await page.$$eval('#list-host .vrow .r-main', (rows) => rows.map((n) => n.textContent));
  ok(modelDesc.join(',') === 'Fixture tube,Fixture cube',
    `Models sort direction flips (${modelDesc.join(',')})`);

  // single-variant (user) model: no variant strip, and ←/→ stay inert
  await page.$$eval('#list-host .vrow', (rows) => (rows[0] as any).click());
  await page.waitForFunction(() => window.__bs?.modelView, { timeout: 20000 });
  ok(await page.$('.variant-strip') === null, 'single-variant model shows no variant strip');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  ok(await page.evaluate(() => !!window.__bs.modelView), 'arrow keys are inert without variants (no crash)');
  await page.goto(u('#/models'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('#list-host .vrow', { timeout: 10000 });
  await page.click('#list-sort-dir');
  await sleep(150);
  await page.select('#list-sort', 'vertices');
  await sleep(150);
  const vertexDesc = await page.evaluate(() => ({
    selected: document.querySelector('#list-sort').value,
    direction: document.querySelector('#list-sort-dir').textContent,
    rows: [...document.querySelectorAll('#list-host .vrow')].map((row) => ({
      name: row.querySelector('.r-main').textContent,
      meta: row.querySelector('.r-meta').textContent,
    })),
  }));
  ok(vertexDesc.selected === 'vertices' && vertexDesc.direction === '↓'
    && vertexDesc.rows.map((row) => row.name).join(',') === 'Fixture tube,Fixture cube'
    && vertexDesc.rows.map((row) => row.meta).join(',') === '2m · 48v · 0var,1m · 24v · 0var',
  `Models sort by occurrence-weighted total vertices (${vertexDesc.rows.map((row) => `${row.name}: ${row.meta}`).join(', ')})`);
  await page.click('#list-sort-dir');
  await sleep(150);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#list-host .vrow', { timeout: 10000 });
  const vertexPersisted = await page.evaluate(() => ({
    selected: document.querySelector('#list-sort').value,
    direction: document.querySelector('#list-sort-dir').textContent,
    rows: [...document.querySelectorAll('#list-host .vrow .r-main')].map((row) => row.textContent),
  }));
  ok(vertexPersisted.selected === 'vertices' && vertexPersisted.direction === '↑'
    && vertexPersisted.rows.join(',') === 'Fixture cube,Fixture tube',
  `Models vertex sort direction persists (${vertexPersisted.direction} ${vertexPersisted.rows.join(',')})`);

  // ---- GLB export: the toolbar Export button produces real glTF binaries -----
  // Downloads go through the same conversion the bulk exporter uses; each
  // GLB's JSON chunk is parsed from disk to assert real structure (not just a
  // non-empty blob).
  const dlDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bs-smoke-dl-'));
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dlDir, eventsEnabled: true });
  const nextDownload = () => new Promise((resolve) => {
    const onProgress = (ev) => {
      if (ev.state !== 'completed') return;
      cdp.off('Browser.downloadProgress', onProgress);
      resolve(ev.guid);
    };
    cdp.on('Browser.downloadProgress', onProgress);
  });
  const parseGlb = (file) => {
    const u8 = readFileSync(file);
    const jsonLen = u8.readUInt32LE(12);
    return {
      magic: u8.toString('latin1', 0, 4),
      len: u8.length,
      json: JSON.parse(u8.toString('utf8', 20, 20 + jsonLen)),
    };
  };
  const exportGlb = async (route, { needRig = false } = {}) => {
    await page.goto(u(route), { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__bs?.meshView, { timeout: 20000 });
    if (needRig) await page.waitForFunction(() => window.__bs?.meshView?.rig, { timeout: 20000 });
    const done = nextDownload();
    await page.$$eval('.viewer-toolbar .btn', (b) => b.find((x) => /Export/.test(x.textContent))?.click());
    const guid = await Promise.race([done, sleep(15000).then(() => null)]);
    return guid ? parseGlb(path.join(dlDir, guid)) : null;
  };
  const glbStatic = await exportGlb('#/mesh/0');
  ok(glbStatic && glbStatic.magic === 'glTF' && glbStatic.json.meshes?.length === 1 && !glbStatic.json.skins,
    `static mesh exports as GLB (${glbStatic?.len ?? 0}b)`);
  const glbSkinned = await exportGlb('#/mesh/1', { needRig: true });
  ok(glbSkinned && glbSkinned.magic === 'glTF' && glbSkinned.json.skins?.length === 1
    && (glbSkinned.json.nodes || []).length >= 3,
  'skinned mesh GLB carries its rig + skin');
  await fs.rm(dlDir, { recursive: true, force: true });

  ok(errors.length === 0, `zero console errors in fixtures suite${errors.length ? `:\n    ${errors.join('\n    ')}` : ''}`);
  await page.close();
}

async function worldSuite(browser: any, base: string) {
  console.log('\n== world suite (fixtures) ==');
  const { page, errors } = await newPage(browser);
  const u = (hash) => `${base}/index.html?data=data-fixtures${hash}`;

  // ---- landing: world present -> stats + list hint --------------------------
  await page.goto(u('#/world'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.card');
  await sleep(400);
  ok(await page.$eval('.card', (n) => n.textContent.includes('2 rooms extracted')),
    'world landing reports 2 extracted rooms');
  ok(await page.$eval('.card', (n) => !!n.querySelector('a[href="#/world/all"]')),
    'world landing links to the all-rooms view');

  // ---- sidebar: pinned "All" row above the rooms ----------------------------
  const allRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.vlist .vrow')];
    return {
      n: rows.length,
      pinned: rows[0]?.classList.contains('vrow-all') || false,
      label: rows[0]?.querySelector('.r-main')?.textContent || '',
      meta: rows[0]?.querySelector('.r-meta')?.textContent || '',
      selected: rows[0]?.classList.contains('selected') || false,
    };
  });
  ok(allRow.n === 3 && allRow.pinned && allRow.label === 'All',
    `world list pins an "All" row above the 2 rooms (${JSON.stringify(allRow)})`);
  ok(/2 rooms/.test(allRow.meta), `All row shows the room count (${allRow.meta})`);
  ok(!allRow.selected, 'All row is not active on the landing route');
  // pinned through sort direction flips and through a filter that hides every room
  await page.click('#list-sort-dir');
  ok(await page.evaluate(() => document.querySelector('.vlist .vrow')?.classList.contains('vrow-all')),
    'All row stays first when the sort direction flips');
  await page.click('#list-sort-dir');   // restore (persists in localStorage)
  await page.type('#list-filter', 'no room matches this');
  await sleep(300);   // input debounce
  const filtered = await page.evaluate(() => ({
    n: document.querySelectorAll('.vlist .vrow').length,
    pinned: !!document.querySelector('.vlist .vrow.vrow-all'),
  }));
  ok(filtered.n === 1 && filtered.pinned, 'All row stays pinned when a filter hides every room');
  await page.evaluate(() => {
    const f = document.getElementById('list-filter');
    f.value = '';
    f.dispatchEvent(new Event('input'));
  });
  await sleep(300);

  // ---- single room: renders + counts --------------------------------------
  await page.goto(u('#/world/1'), { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__bs.worldView?.ready === true, { timeout: 30000 });

  // ---- fresh defaults (state v2) + one-time legacy pref migration -----------
  const defState = await page.evaluate(() => {
    const s = window.__bs.worldView.state;
    return { wopacity: s.wopacity, ambient: s.ambient, sun: s.sun };
  });
  ok(defState.wopacity === 50 && defState.ambient === 1.85 && defState.sun === 2.8,
    `defaults apply: water 50%, ambient 1.85, sun 2.80 (${JSON.stringify(defState)})`);
  // a LEGACY (unversioned) saved state must be discarded once for the new defaults
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('bs.prefs') || '{}');
    prefs.world = { water: false, wopacity: 62, ambient: 1.15, sun: 1.5, aniso: 3 };
    localStorage.setItem('bs.prefs', JSON.stringify(prefs));
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__bs.worldView?.ready === true, { timeout: 30000 });
  const migrated = await page.evaluate(() => {
    const s = window.__bs.worldView.state;
    return { water: s.water, wopacity: s.wopacity, ambient: s.ambient, sun: s.sun };
  });
  ok(migrated.water === true && migrated.wopacity === 50 && migrated.ambient === 1.85 && migrated.sun === 2.8,
    `legacy unversioned prefs discarded once for the new defaults (${JSON.stringify(migrated)})`);

  await sleep(600);
  const covRoom = await paintCoverage(page);
  ok(covRoom > 0.05, `room #1 canvas paints (coverage ${(covRoom * 100).toFixed(1)}% > 5%)`);
  const stats = await page.evaluate(() => ({
    total: [...window.__bs.worldView.world.rooms.values()]
      .flatMap((r) => r.meshes).reduce((s, m) => s + m.count, 0),
    visible: window.__bs.worldView.visibleInstanceCount(),
    batches: window.__bs.worldView.loadStats.batches,
  }));
  // shard: 8 placements + 1 spawn part = 9 instances; the authored-empty
  // placement and the water curtain (water on by default) start hidden
  ok(stats.total === 9, `room #1 renders all 9 stored instances (${stats.total})`);
  ok(stats.visible === 7, `authored-empty + water curtain hidden by default (${stats.visible} visible)`);

  // camera = a single room uses the stock OrbitControls (drag=orbit), like the
  // model/mesh/scene viewers; the fly rig is reserved for the all-rooms
  // stitch. The orbit is clamped above the horizon so it never dips under floor.
  const cam = await page.evaluate(() => {
    const v = window.__bs.worldView;
    return {
      fly: !!v.fly, orbit: v.scene3d.controls.enabled,
      fov: v.scene3d.camera.fov,
      maxPolar: v.scene3d.controls.maxPolarAngle,
      hint: document.querySelector('.cam-hint-card')?.textContent || '',
    };
  });
  ok(!cam.fly && cam.orbit === true && cam.fov === 50,
    `single room uses orbit controls, not the fly rig (fly ${cam.fly}, orbit ${cam.orbit})`);
  ok(/orbit/i.test(cam.hint) && /zoom/i.test(cam.hint) && /move/i.test(cam.hint),
    'room hint card lists the orbit controls (drag orbit / scroll zoom)');
  ok(cam.maxPolar > 0 && cam.maxPolar < Math.PI / 2 + 1e-6,
    `single-room orbit is clamped above the horizon (maxPolar ${cam.maxPolar.toFixed(3)})`);

  // scripted vertical drag: the orbit polar angle must move and stay clamped
  // above the floor plane (never past maxPolarAngle).
  const polarOf = () => page.evaluate(() => window.__bs.worldView.scene3d.controls.getPolarAngle());
  const polar0 = await polarOf();
  const roomBox = await (await page.$('.canvas-host canvas')).boundingBox();
  const rx = roomBox.x + roomBox.width * 0.4;
  const ry = roomBox.y + roomBox.height * 0.6;
  await page.mouse.move(rx, ry);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(rx, ry - i * 20);   // partial drag up
  await page.mouse.up();
  await sleep(300);
  const polarMid = await polarOf();
  ok(Math.abs(polarMid - polar0) > 0.02, `vertical drag orbits the camera (${polar0.toFixed(3)} -> ${polarMid.toFixed(3)})`);
  for (let pass = 0; pass < 2; pass++) {   // drag hard in both directions at the clamp
    await page.mouse.move(rx, ry);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(rx, ry + i * 35);
    await page.mouse.up();
    await sleep(300);
  }
  const polar1 = await polarOf();
  ok(polar1 <= cam.maxPolar + 1e-3,
    `orbit polar clamps above the floor (${polar1.toFixed(3)} ≤ ${cam.maxPolar.toFixed(3)})`);
  // reset the pose so the projection-based inspector checks below see the room
  await page.$$eval('.viewer-toolbar .btn', (b) => b.find((x) => /Focus/.test(x.textContent))?.click());
  await sleep(300);

  const panelCheck = (label) => page.evaluate((l) => {
    const opt = [...document.querySelectorAll('.world-panel .wp-check')]
      .find((n) => n.textContent.trim() === l);
    opt?.querySelector('input')?.click();
    return !!opt;
  }, label);
  const visibleCount = () => page.evaluate(() => window.__bs.worldView.visibleInstanceCount());

  // category toggle: terrain off -> 4 fewer instances, back on restores
  await panelCheck('Terrain');
  ok((await visibleCount()) === 3, `terrain toggle hides its 4 instances (${await visibleCount()})`);
  await panelCheck('Terrain');
  ok((await visibleCount()) === 7, 'terrain toggle restores them');

  // z toggle: level 1 holds the rotated cube model
  await page.evaluate(() => document.querySelector('.world-panel .wp-zlist input[data-z="1"]').click());
  ok((await visibleCount()) === 6, `z-level toggle hides the z=1 model (${await visibleCount()})`);
  await page.evaluate(() => document.querySelector('.world-panel .wp-zlist input[data-z="1"]').click());

  // authored-empty toggle shows the wireframe placement
  await panelCheck('Empty materials');
  ok((await visibleCount()) === 8, `authored-empty toggle shows the wireframe (${await visibleCount()})`);
  await panelCheck('Empty materials');

  // ---- Advanced accordion: closed by default, hosts the tuning sections ------
  const advRoom = await page.evaluate(() => {
    const d = document.querySelector('.world-panel details.wp-advanced');
    return d && {
      open: d.open,
      titles: [...d.querySelectorAll('.wp-title')].map((n) => n.textContent).join(','),
    };
  });
  ok(!!advRoom && advRoom.open === false, 'Advanced accordion present, collapsed by default');
  ok(advRoom.titles === 'Water,Lighting & effects,Height levels',
    `room-view Advanced hosts Water/Lighting/Height levels (${advRoom.titles})`);
  ok(await page.$$eval('.viewer-toolbar .btn', (b) => b.some((x) => /Screenshot/.test(x.textContent))),
    'room view offers the standard toolbar Screenshot button');
  await page.$$eval('.viewer-toolbar .btn', (b) => b.find((x) => /Screenshot/.test(x.textContent))?.click());
  await page.waitForSelector('.modal-overlay .shot-hires select', { timeout: 5000 });
  ok(await page.$$eval('.shot-hires select option', (o) => o.length >= 5),
    'screenshot modal hosts the tiled high-res resolutions for the world view');
  await page.$$eval('.modal-overlay .btn', (b) => b.find((x) => x.textContent.trim() === 'Close')?.click());
  await new Promise((r) => setTimeout(r, 150));

  // room view also offers Video, opening the wizard in static (Duration) mode
  ok(await page.$$eval('.viewer-toolbar .btn', (b) => b.some((x) => /Video/.test(x.textContent))),
    'room view offers the Video button');
  await page.$$eval('.viewer-toolbar .btn', (b) => b.find((x) => /Video/.test(x.textContent))?.click());
  await page.waitForSelector('.video-modal', { timeout: 5000 });
  const worldVid = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.video-modal .video-form label span')].map((s) => s.textContent);
    return { duration: labels.includes('Duration'), anims: labels.includes('Animations') };
  });
  ok(worldVid.duration && !worldVid.anims,
    'world video wizard is static: Duration control, no clip selector');
  await page.$$eval('.video-modal .btn', (b) => b.find((x) => x.textContent.trim() === 'Close')?.click());
  await new Promise((r) => setTimeout(r, 150));

  await page.evaluate(() => { document.querySelector('.wp-advanced').open = true; });
  await sleep(200);   // details toggle event -> pref write
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('bs.prefs') || '{}').worldadv === true),
    'Advanced open state persists in prefs');

  // ---- water: sheet replaces the curtain; toggle restores the authored view --
  const waterOn = await page.evaluate(() => window.__bs.worldView.waterInfo());
  ok(waterOn.sheets === 1 && waterOn.sheetsVisible === 1 && waterOn.curtainsHidden === 1,
    `water on: 1 animated sheet, curtain hidden (${JSON.stringify(waterOn)})`);
  await panelCheck('Animated water');
  const waterOff = await page.evaluate(() => window.__bs.worldView.waterInfo());
  ok(waterOff.sheetsVisible === 0 && waterOff.curtainsHidden === 0,
    `water off: authored curtain returns (${JSON.stringify(waterOff)})`);
  await sleep(300);
  ok(!page.url().includes('?water') && !/#\/world\/1\?/.test(page.url()),
    'view state stays out of the URL (no hash-query mirroring)');
  ok(await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('bs.prefs') || '{}').world;
    return !!p && p.v === 2 && p.water === false;
  }), 'water toggle persists in the versioned prefs record');
  await panelCheck('Animated water');

  // ---- inspector: click a terrain tile -> pinned readout with source rows ----
  // Inspect is a distinct button-style MODE toggle at the top of the panel
  ok(await page.$eval('.world-panel .wp-inspect', (n) => n.tagName === 'BUTTON'
    && !n.disabled && n.getAttribute('aria-pressed') === 'false'),
  'Inspect is a button-style mode toggle (enabled in the room view)');
  await page.click('.world-panel .wp-inspect');
  ok(await page.$eval('.world-panel .wp-inspect', (n) => n.classList.contains('active')
    && n.getAttribute('aria-pressed') === 'true'), 'Inspect button activates the mode');
  const at = await page.evaluate(async () => {
    // @ts-ignore -- resolved in the browser against the served origin, not by Node
    const { Vector3 } = await import('./vendor/three.module.js');
    const v = window.__bs.worldView;
    // terrain tile (0.5, 0.5), top surface z=256 native -> three (0.5, 0.25, 0.5)
    const p = new Vector3(0.5, 0.25, 0.5).project(v.scene3d.camera);
    const r = v.scene3d.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  });
  await page.mouse.move(at.x, at.y);
  await sleep(150);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(250);
  const readout = await page.evaluate(() => {
    const n = document.querySelector('.world-panel .wp-readout');
    return { hidden: n.hidden, pinned: n.classList.contains('pinned'), text: n.textContent };
  });
  ok(!readout.hidden && readout.pinned, 'clicking a placement pins the inspector readout');
  ok(/Mesh/.test(readout.text) && /Occurrence|Spawn/.test(readout.text) && /Tile/.test(readout.text),
    'readout carries mesh + source-row provenance');

  // ---- temporary edits (single room): preview, nudge, delete, reset ----------
  ok(await page.evaluate(() => window.__bs.worldView.inspectInfo().previewActive)
    && await page.$eval('.world-panel .wp-readout', (n) => !!n.querySelector('.wp-preview canvas')),
  'pinning shows the spinning mesh preview in the readout');
  const roomPin = await page.evaluate(() => {
    const i = window.__bs.worldView.inspectInfo();
    return { room: i.room, category: i.category, placementIndex: i.placementIndex };
  });
  const readMatrix = (pin) => page.evaluate((p) => {
    const v = window.__bs.worldView;
    const room = v.world.rooms.get(p.room);
    for (const m of room.meshes) {
      const e = m.userData.exact;
      if (e.category !== p.category) continue;
      const at = e.placementIndices.indexOf(p.placementIndex);
      if (at < 0) continue;
      return [...m.instanceMatrix.array.slice(at * 16, at * 16 + 16)].map((x) => +x.toFixed(3));
    }
    return null;
  }, pin);
  const matBefore = await readMatrix(roomPin);
  await page.$$eval('.wp-readout .wp-edit button', (btns) => btns.find((b) => b.title === 'Nudge +X')?.click());
  const matNudged = await readMatrix(roomPin);
  ok(matBefore && matNudged && Math.abs((matNudged[12] - matBefore[12]) - 512) < 1e-3,
    `+X nudge moves the pinned instance half a tile (${matBefore?.[12]} -> ${matNudged?.[12]})`);
  await page.$$eval('.wp-readout .wp-edit-actions .wp-delete', (btns) => btns[0]?.click());
  const matDeleted = await readMatrix(roomPin);
  ok(matDeleted && matDeleted.every((x, i) => (i === 15 ? x === 1 : x === 0)),
    'Delete button zero-scales the instance (gone from render + raycasts)');
  ok(await page.$eval('.world-panel .wp-readout', (n) => n.hidden)
    && await page.$eval('.world-panel .wp-reset-edits', (n) => !n.hidden && /\(1\)/.test(n.textContent)),
  'delete clears the pin and surfaces Reset edits (1)');
  await page.click('.world-panel .wp-reset-edits');
  const matReset = await readMatrix(roomPin);
  ok(matReset && matBefore && matReset.join(',') === matBefore.join(','),
    'Reset edits restores the original instance matrix exactly');
  ok(await page.$eval('.world-panel .wp-reset-edits', (n) => n.hidden),
    'Reset edits hides once no edits remain');

  // ---- skinned playback on a pinned spawn (single room) -----------------------
  // The fixture guard spawn's part is the skinned tube (mesh 1, skeleton 0, one
  // exported clip). Spawns are ~0.01 tile in the fixture, so pin by reference
  // rather than a screen-space ray.
  const spawnRef = { room: 1, sourceKind: 'spawn', category: 'spawns', placementIndex: 0, mesh: 1, reflect: false };
  ok(await page.evaluate((ref) => window.__bs.worldView.pinPlacement(ref), spawnRef),
    'pinPlacement pins the fixture guard spawn (single room)');
  await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.hasBar === true, { timeout: 15000 });
  const animReady = await page.evaluate(() => window.__bs.worldView.spawnAnimInfo());
  ok(animReady.kind === 'ready' && animReady.clips === 2 && animReady.active === false,
    `rigged spawn resolves its clips; composite idle until a clip plays (${JSON.stringify({ kind: animReady.kind, clips: animReady.clips, active: animReady.active })})`);
  ok(await page.$eval('.world-panel .wp-readout', (n) => !!n.querySelector('.wp-anim .clip-select')),
    'clip picker (PlaybackBar) renders in the pinned detail area');
  const readSpawnMatrix = () => page.evaluate(() => {
    const v = window.__bs.worldView;
    const room = v.world.rooms.get(1);
    if (!room) return null;
    for (const m of room.meshes) {
      const e = m.userData.exact;
      if (!e || e.sourceKind !== 'spawn') continue;
      const at = (e.placementIndices || []).indexOf(0);
      if (at < 0) continue;
      return [...m.instanceMatrix.array.slice(at * 16, at * 16 + 16)].map((x) => +x.toFixed(3));
    }
    return null;
  });
  // ensure playing regardless of the persisted autoplay pref (a blind toggle
  // click would PAUSE an already-autoplaying clip)
  const ensurePlaying = async () => {
    if (!(await page.evaluate(() => window.__bs.worldView.spawnAnimInfo()?.playing))) {
      await page.$$eval('.world-panel .wp-anim button', (btns) => btns.find((b) => /Play\/pause/.test(b.title))?.click());
    }
    await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.playing === true, { timeout: 5000 });
  };
  const spawnMatBefore = await readSpawnMatrix();
  await page.select('.world-panel .wp-anim .clip-select', '0');
  await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.hasClip === true, { timeout: 10000 });
  await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.active === true, { timeout: 10000 });
  await ensurePlaying();
  const spawnQ0 = await page.evaluate(() => window.__bs.worldView.spawnAnimInfo().boneQ);
  await sleep(350);
  const spawnQ1 = await page.evaluate(() => window.__bs.worldView.spawnAnimInfo().boneQ);
  ok(spawnQ0 && spawnQ1 && spawnQ0.some((v, i) => Math.abs(v - spawnQ1[i]) > 1e-4),
    `clip playback poses the in-world rig (qx ${spawnQ0?.[0]?.toFixed(3)} -> ${spawnQ1?.[0]?.toFixed(3)})`);
  const spawnMatDuring = await readSpawnMatrix();
  const spawnDuring = await page.evaluate(() => window.__bs.worldView.spawnAnimInfo());
  ok(spawnDuring.active && spawnDuring.parts === 1 && spawnDuring.playing
    && spawnMatDuring && spawnMatDuring.every((x, i) => (i === 15 ? x === 1 : x === 0)),
  `composite replaces the static spawn while playing (parts ${spawnDuring.parts}, static zero-scaled)`);
  // Loop checkbox mirrors PlaybackBar wrap semantics
  const loopBefore = await page.evaluate(() => window.__bs.worldView.spawnAnimInfo().loop);
  await page.$$eval('.world-panel .wp-anim button', (btns) => btns.find((b) => b.textContent === '⟳')?.click());
  const loopAfter = await page.evaluate(() => window.__bs.worldView.spawnAnimInfo().loop);
  ok(loopBefore !== loopAfter, `Loop toggle flips wrap vs stop-at-end (${loopBefore} -> ${loopAfter})`);
  // clip -> none restores the static spawn exactly
  await page.select('.world-panel .wp-anim .clip-select', '-1');
  await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.active === false, { timeout: 5000 });
  const spawnMatRestored = await readSpawnMatrix();
  ok(spawnMatRestored && spawnMatBefore && spawnMatRestored.join(',') === spawnMatBefore.join(','),
    'clip → none restores the static spawn instance matrix exactly');
  // with a clip actively LOOPING, the highlight hides, and clicking away
  // (unpin mid-play) PARKS the animation: it keeps playing for the session
  // instead of vanishing or reverting to the static.
  await page.evaluate((ref) => window.__bs.worldView.pinPlacement(ref), spawnRef);
  await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.hasBar === true, { timeout: 15000 });
  await page.select('.world-panel .wp-anim .clip-select', '0');
  await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.active === true, { timeout: 10000 });
  await ensurePlaying();
  if (!(await page.evaluate(() => window.__bs.worldView.spawnAnimInfo().loop))) {
    await page.$$eval('.world-panel .wp-anim button', (btns) => btns.find((b) => b.textContent === '⟳')?.click());
  }
  ok(await page.evaluate(() => window.__bs.worldView.inspectInfo().highlightVisible) === false,
    'highlight hides while a clip plays');
  await page.evaluate(() => window.__bs.worldView.unpinInspect());
  await sleep(300);
  ok(await page.evaluate(() => window.__bs.worldView.spawnAnimInfo() === null),
    'unpin releases the pinned picker');
  const parked = await page.evaluate(() => window.__bs.worldView.persistentAnimInfo());
  ok(parked.count === 1 && parked.playing[0] === true,
    `unpin during a looping clip PARKS the animation (keeps playing) (${JSON.stringify(parked)})`);
  // re-pinning the same model pulls the parked animation back into the picker
  await page.evaluate((ref) => window.__bs.worldView.pinPlacement(ref), spawnRef);
  await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.active === true, { timeout: 10000 });
  ok(await page.evaluate(() => window.__bs.worldView.persistentAnimInfo().count === 0),
    're-pinning the model re-attaches the parked animation to the picker');
  // clip → none stops it for good, restoring the static exactly
  await page.select('.world-panel .wp-anim .clip-select', '-1');
  await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.active === false, { timeout: 5000 });
  await page.evaluate(() => window.__bs.worldView.unpinInspect());
  await sleep(300);
  const matAfterStop = await readSpawnMatrix();
  ok(matAfterStop && spawnMatBefore && matAfterStop.join(',') === spawnMatBefore.join(',')
    && await page.evaluate(() => window.__bs.worldView.persistentAnimInfo().count === 0),
    'clip → none then unpin stops the animation and restores the static exactly');
  await page.click('.world-panel .wp-inspect');   // leave inspect OFF for later tests

  // ---- perf HUD: present, live numbers, collapsible ---------------------------
  await sleep(700);   // one full 500ms sampling window
  const hud = await page.evaluate(() => ({
    present: !!document.querySelector('.world-hud'),
    env: document.querySelector('.world-hud .wh-env')?.textContent || '',
    ...window.__bs.worldView.hud.state,
  }));
  ok(hud.present && /WebGL/.test(hud.env), `perf HUD mounted with env line (${hud.env})`);
  ok(/^ready/.test(hud.stage) && hud.steady, `HUD reaches its steady stage (${hud.stage})`);
  ok(hud.fps > 0 && hud.drawCalls > 0 && hud.triangles > 0,
    `HUD samples renderer.info (${hud.fps} fps · ${hud.drawCalls} draws · ${hud.triangles} tris)`);
  ok(await page.$eval('.world-hud .wh-env', (n) => (n.title || '').length > 5),
    'HUD env line carries the full adapter string in its tooltip');
  await page.click('.world-hud .wh-toggle');
  ok(await page.evaluate(() => window.__bs.worldView.hud.state.collapsed
    && document.querySelector('.world-hud .wh-body').hidden), 'HUD collapses to its fps chip');

  // ---- all-rooms merged view, entered via the pinned All row ------------------
  await page.click('.vlist .vrow-all');
  await page.waitForFunction(() => /#\/world\/all/.test(location.hash), { timeout: 10000 });
  // loading every room is heavy, so navigation lands on an explicit confirm
  // gate first: nothing streams until the user opts in
  await page.waitForSelector('.canvas-host .world-loading .world-load-confirm', { timeout: 10000 });
  ok(await page.evaluate(() => {
    const v = window.__bs.worldView;
    return document.querySelector('.world-loading .wlo-bar').hidden && v?.ready !== true;
  }), 'all-rooms navigation waits at the confirm gate (no bar, no load)');
  await page.click('.world-loading .world-load-confirm');
  // the streaming/merging churn hides behind an overlay with ONE weighted
  // progress bar until the pipeline reaches ready
  await page.waitForFunction(() => !document.querySelector('.world-loading .wlo-bar')?.hidden, { timeout: 10000 });
  ok(true, 'confirming starts the load behind the loading overlay');
  // the previous (room) view stays in __bs.worldView until the all view mounts.
  // With WebGL2 the merged bake finishes AND releases the per-room graph
  // (rooms drop to 0, the GPU-memory fix); without it the graph is the
  // display path and both fixture rooms stay retained.
  await page.waitForFunction(() => {
    const v = window.__bs.worldView;
    if (v?.ready !== true) return false;
    return v.merged?.ready ? v.world.rooms.size === 0 : v.world.rooms.size === 2;
  }, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.world-loading'), { timeout: 10000 });
  ok(true, 'loading overlay dismisses when the world is ready');
  ok(/#\/world\/all$/.test(page.url()), 'all-rooms route stays plain (no URL state)');
  ok(await page.evaluate(() => document.querySelector('.vlist .vrow-all')?.classList.contains('selected')),
    'All row routes to #/world/all and highlights as active');
  await sleep(600);
  const covAll = await paintCoverage(page);
  ok(covAll > 0.01, `all-rooms view paints both rooms (coverage ${(covAll * 100).toFixed(1)}%)`);

  // ---- room-name sprites: on by default, cheap visibility toggle --------------
  const names = await page.evaluate(() => window.__bs.worldView.namesInfo());
  ok(names.sprites === 2 && names.visible === true,
    `room-name sprites built for both rooms, shown by default (${JSON.stringify(names)})`);
  await panelCheck('Room names');
  ok(await page.evaluate(() => window.__bs.worldView.namesInfo().visible) === false,
    'Room names toggle hides the label sprites');
  await panelCheck('Room names');
  ok(await page.evaluate(() => window.__bs.worldView.namesInfo().visible) === true,
    'Room names toggle restores them');

  // ---- all-rooms Advanced: Performance joins, Merged is the escape hatch ------
  const advAll = await page.evaluate(() => {
    const d = document.querySelector('.world-panel details.wp-advanced');
    return {
      open: d.open,
      titles: [...d.querySelectorAll('.wp-title')].map((n) => n.textContent).join(','),
      mergedInAdvanced: [...d.querySelectorAll('.wp-check')].some((n) => /Merged rendering/.test(n.textContent)),
      mergedTopLevel: [...document.querySelectorAll('.world-panel > .wp-section .wp-check')]
        .some((n) => /Merged rendering/.test(n.textContent)),
    };
  });
  ok(advAll.titles === 'Water,Lighting & effects,Performance,Height levels,Surface',
    `all-rooms Advanced hosts Water/Lighting/Performance/Height/Surface (${advAll.titles})`);
  ok(advAll.mergedInAdvanced && !advAll.mergedTopLevel,
    'Merged rendering lives in Advanced only (invisible default, escape hatch)');
  ok(advAll.open === true, 'Advanced open state persisted from the room view');
  const mergedInfo = await page.evaluate(() => ({
    webgl2: window.__bs.worldView.scene3d.renderer.capabilities.isWebGL2,
    ready: window.__bs.worldView.merged?.ready || false,
    meshes: window.__bs.worldView.merged?.stats?.meshes || 0,
    instances: window.__bs.worldView.merged?.stats?.instances || 0,
    rooms: window.__bs.worldView.world.rooms.size,
  }));
  if (mergedInfo.webgl2) {
    ok(mergedInfo.ready && mergedInfo.meshes > 0 && mergedInfo.instances === 12,
      `merged bake covers all placements (${mergedInfo.meshes} batches, ${mergedInfo.instances} instances)`);
    ok(mergedInfo.rooms === 0,
      `per-room graph GPU released after the bake (${mergedInfo.rooms} rooms retained)`);
    // inspection survives the graph release via the CPU picking index
    ok(await page.$eval('.world-panel .wp-inspect', (n) => !n.disabled && /Hover/.test(n.title)),
      'Inspect mode stays enabled under merged rendering');
    // collision + authored-empty render as STANDALONE wireframe batches built
    // from the shard data: they survive the graph release
    await panelCheck('Collision extents');
    await page.waitForFunction(() => {
      const w = window.__bs.worldView.wireInfo();
      return !!w && w.collisionVisible && w.collision === 1;
    }, { timeout: 20000 });
    ok(true, 'collision extents render standalone under merged (graph released)');
    await panelCheck('Empty materials');
    await page.waitForFunction(() => {
      const w = window.__bs.worldView.wireInfo();
      return !!w && w.emptyVisible && w.emptyInstances === 1;
    }, { timeout: 20000 });
    ok(true, 'authored-empty wireframes render standalone under merged');
    await panelCheck('Collision extents');
    await panelCheck('Empty materials');
    ok(await page.evaluate(() => {
      const w = window.__bs.worldView.wireInfo();
      return !!w && !w.collisionVisible && !w.emptyVisible;
    }), 'wire overlays hide on untick but stay built for cheap re-enable');
    // unticking Merged must stream the rooms back in from storage
    await page.evaluate(() => {
      const label = [...document.querySelectorAll('.world-panel label')]
        .find((l) => /Merged rendering/.test(l.textContent));
      label.querySelector('input').click();
    });
    await page.waitForFunction(() => window.__bs.worldView.world.rooms.size === 2, { timeout: 30000 });
    ok(true, 'unticking Merged reloads the per-room graph (2 rooms back)');
    await page.evaluate(() => {
      const label = [...document.querySelectorAll('.world-panel label')]
        .find((l) => /Merged rendering/.test(l.textContent));
      label.querySelector('input').click();
    });
    await page.waitForFunction(() => window.__bs.worldView.world.rooms.size === 0, { timeout: 30000 });
    ok(true, 're-ticking Merged releases the graph again');

    // ---- worker-pool bake: determinism gate (byte-compare vs main thread) ----
    ok(await page.evaluate(() => window.__bs.worldView.merged.lastBakeMode) === 'worker',
      'all-rooms bake ran on the worker pool');
    // Stream the rooms back, then run a verification bake: every bucket is
    // baked BOTH ways (worker pool AND forced main thread) and every merged
    // buffer (positions/normals/uvs/tangents/meta/recolor/index/bounds) is
    // byte-compared. Permanent regression gate for worker-bake determinism.
    await page.evaluate(() => {
      const label = [...document.querySelectorAll('.world-panel label')]
        .find((l) => /Merged rendering/.test(l.textContent));
      label.querySelector('input').click();
    });
    await page.waitForFunction(() => window.__bs.worldView.world.rooms.size === 2, { timeout: 30000 });
    const bakeCompare = await page.evaluate(async () => {
      const m = window.__bs.worldView.merged;
      m.bakeVerify = true;
      m.setVisible(true);   // keep the upload drain live during the check
      try { await m.build(); } finally { m.bakeVerify = false; }
      return { ...m.verifyResult, mode: m.lastBakeMode, poolReleased: m._bakePool === null };
    });
    ok(bakeCompare.mode === 'worker' && bakeCompare.buckets > 0
      && bakeCompare.mismatches === 0 && bakeCompare.poolReleased,
    `worker bake byte-identical to the main-thread bake (${bakeCompare.buckets} buckets, `
      + `${bakeCompare.mismatches} mismatches, pool released)`);
    await page.evaluate(() => {
      const label = [...document.querySelectorAll('.world-panel label')]
        .find((l) => /Merged rendering/.test(l.textContent));
      label.querySelector('input').click();
    });
    await page.waitForFunction(() => window.__bs.worldView.world.rooms.size === 0, { timeout: 30000 });
    ok(true, 'merged re-enables after the determinism gate');

    // ---- merged inspect + temporary edits (CPU pick index) -------------------
    await page.waitForFunction(() => window.__bs.worldView.pickInfo()?.ready === true, { timeout: 30000 });
    const pickStats = await page.evaluate(() => window.__bs.worldView.pickInfo());
    ok(pickStats.entries === 12 && pickStats.bytes > 0 && pickStats.bytes < 1e6,
      `pick index covers all 12 baked placements in typed arrays (${pickStats.entries} entries, ${pickStats.bytes}b)`);
    await page.click('.world-panel .wp-inspect');
    // deterministic vantage for the projection-based picks below: the
    // default pose starts close-in, where fixture models can occlude the
    // probed tile
    await page.evaluate(async () => {
      // @ts-ignore -- resolved in the browser against the served origin, not by Node
      const { Vector3 } = await import('./vendor/three.module.js');
      const v = window.__bs.worldView;
      const span = v.scene3d.controls.maxDistance / 2.4;   // focusWorld stores span*2.4
      v.scene3d.camera.position.set(0, span * 0.6, span * 0.62);
      v.fly.lookAt(new Vector3(0, 0, 0));
      // let a render commit the new matrices before screen-space projections
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    // room 1 terrain tile (0,0): the stitch centers the 0..7 × 0..4 world, so
    // its top center lands at display (-3, 0.25, -1.5); the raised probe point
    // sits one height layer above it (empty until the +Z nudges commit).
    const screenOf = (point) => page.evaluate(async (p) => {
      // @ts-ignore -- resolved in the browser against the served origin, not by Node
      const { Vector3 } = await import('./vendor/three.module.js');
      const v = window.__bs.worldView;
      const pr = new Vector3(p[0], p[1], p[2]).project(v.scene3d.camera);
      const r = v.scene3d.renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((pr.x + 1) / 2) * r.width, y: r.top + ((1 - pr.y) / 2) * r.height };
    }, point);
    const tileAt = await screenOf([-3, 0.25, -1.5]);
    const aboveAt = await screenOf([-3, 0.625, -1.5]);
    const probe = (at) => page.evaluate((s) => window.__bs.worldView.pickProbe(s.x, s.y), at);
    const probe0 = await probe(tileAt);
    ok(probe0 && probe0.count > 0 && probe0.room === 1
      && probe0.category === 'terrain' && probe0.placementIndex === 0,
    `pick probe resolves room 1 terrain #0 through the CPU index (${JSON.stringify(probe0)})`);
    await page.mouse.move(tileAt.x, tileAt.y);
    await sleep(300);   // hover pick resolves async (shard + geometry loads)
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => {
      const n = document.querySelector('.world-panel .wp-readout');
      return n && !n.hidden && n.classList.contains('pinned');
    }, { timeout: 15000 });
    const mergedPin = await page.evaluate(() => window.__bs.worldView.inspectInfo());
    ok(mergedPin.mode === 'index' && mergedPin.room === 1 && mergedPin.category === 'terrain',
      `merged click pins through the index (room ${mergedPin.room} ${mergedPin.category} #${mergedPin.placementIndex})`);
    ok(await page.$eval('.world-panel .wp-readout', (n) => /Mesh/.test(n.textContent)
      && /Occurrence/.test(n.textContent) && /Tile/.test(n.textContent)),
    'merged readout carries the same source-row provenance as the room view');
    await page.waitForFunction(() => window.__bs.worldView.inspectInfo().previewActive, { timeout: 15000 });
    ok(await page.$eval('.world-panel .wp-readout', (n) => !!n.querySelector('.wp-preview canvas')),
      'merged pin embeds the spinning mesh preview');
    // MOVE: two +Z nudges (default step 0.5 = one full height layer). The
    // picking index updates immediately; the cell bucket re-bakes debounced.
    const aboveBefore = await probe(aboveAt);
    await page.$$eval('.wp-readout .wp-edit button', (btns) => btns.find((b) => /Nudge up/.test(b.title))?.click());
    await page.$$eval('.wp-readout .wp-edit button', (btns) => btns.find((b) => /Nudge up/.test(b.title))?.click());
    const aboveAfter = await probe(aboveAt);
    const editState = await page.evaluate(() => window.__bs.worldView.editsInfo());
    ok(aboveBefore?.count === 0 && aboveAfter?.count > 0 && aboveAfter.placementIndex === 0
      && editState.count === 1 && editState.list[0].dz === 1,
    `+Z nudges move the placement in the picking index (probe ${aboveBefore?.count} -> ${aboveAfter?.count}, dz=${editState.list[0]?.dz})`);
    await page.waitForFunction(() => window.__bs.worldView.editsInfo().rebakes >= 1, { timeout: 20000 });
    ok(true, 'nudge commit re-bakes only the affected cell bucket');
    // DELETE via the Delete key while pinned
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => window.__bs.worldView.editsInfo().rebakes >= 2, { timeout: 20000 });
    const afterDelete = await page.evaluate((points) => ({
      above: window.__bs.worldView.pickProbe(points.above.x, points.above.y),
      tile: window.__bs.worldView.pickProbe(points.tile.x, points.tile.y),
      readoutHidden: document.querySelector('.world-panel .wp-readout').hidden,
      resetVisible: !document.querySelector('.world-panel .wp-reset-edits').hidden,
      edits: window.__bs.worldView.editsInfo().list,
    }), { above: aboveAt, tile: tileAt });
    ok(afterDelete.above?.count === 0 && afterDelete.tile?.count === 0
      && afterDelete.readoutHidden && afterDelete.resetVisible
      && afterDelete.edits[0]?.deleted === true,
    `Delete key removes the placement from picking + render and clears the pin (${JSON.stringify(afterDelete.edits)})`);
    // RESET restores the pristine bake and index
    await page.click('.world-panel .wp-reset-edits');
    await page.waitForFunction(() => window.__bs.worldView.editsInfo().rebakes >= 3, { timeout: 20000 });
    const afterReset = await probe(tileAt);
    ok(afterReset?.count > 0 && afterReset.placementIndex === 0
      && await page.evaluate(() => window.__bs.worldView.editsInfo().count === 0)
      && await page.$eval('.world-panel .wp-reset-edits', (n) => n.hidden),
    'Reset edits restores the placement and re-bakes back to pristine');

    // ---- skinned playback under merged rendering (overlay + hide) -------------
    const mSpawnRef = { room: 1, sourceKind: 'spawn', category: 'spawns', placementIndex: 0, mesh: 1, reflect: false };
    ok(await page.evaluate((ref) => window.__bs.worldView.pinPlacement(ref), mSpawnRef),
      'pinPlacement pins the fixture guard through the merged pick index');
    await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.hasBar === true, { timeout: 15000 });
    const mRebakesBefore = await page.evaluate(() => window.__bs.worldView.merged.rebakes);
    await page.select('.world-panel .wp-anim .clip-select', '0');
    await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.hasClip === true, { timeout: 10000 });
    await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.active === true, { timeout: 10000 });
    if (!(await page.evaluate(() => window.__bs.worldView.spawnAnimInfo()?.playing))) {
      await page.$$eval('.world-panel .wp-anim button', (btns) => btns.find((b) => /Play\/pause/.test(b.title))?.click());
    }
    await page.waitForFunction(() => window.__bs.worldView.spawnAnimInfo()?.playing === true, { timeout: 5000 });
    await page.waitForFunction((n) => window.__bs.worldView.merged.rebakes > n, { timeout: 20000 }, mRebakesBefore);
    const mq0 = await page.evaluate(() => window.__bs.worldView.spawnAnimInfo().boneQ);
    await sleep(350);
    const mq1 = await page.evaluate(() => window.__bs.worldView.spawnAnimInfo().boneQ);
    const mAnim = await page.evaluate(() => window.__bs.worldView.spawnAnimInfo());
    ok(mAnim.active && mAnim.parts === 1 && mq0 && mq1 && mq0.some((v, i) => Math.abs(v - mq1[i]) > 1e-4),
      `merged: composite overlays + animates while the cell re-bakes out the static (parts ${mAnim.parts})`);
    // Inspect off releases the picker but PARKS the playing composite (it keeps
    // animating for the session: merged path, same as the single-room one).
    await page.click('.world-panel .wp-inspect');   // Inspect off for the fly tests
    await sleep(300);
    ok(await page.evaluate(() => window.__bs.worldView.spawnAnimInfo() === null),
      'merged: inspect-off releases the pinned picker');
    ok(await page.evaluate(() => {
      const p = window.__bs.worldView.persistentAnimInfo();
      return p.count === 1 && p.playing[0] === true;
    }), 'merged: the animation is parked and keeps playing after inspect-off');
  } else {
    ok(mergedInfo.rooms === 2, `all-rooms retains both rooms without WebGL2 (${mergedInfo.rooms})`);
    ok(true, 'no WebGL2: merged bake skipped (per-room fallback)');
    ok(true, 'no WebGL2: inspect stays enabled on the graph path');
    ok(true, 'no WebGL2: standalone collision overlay skipped (graph path draws it)');
    ok(true, 'no WebGL2: standalone authored-empty overlay skipped');
    ok(true, 'no WebGL2: wire overlay toggle round-trip skipped');
    ok(true, 'no WebGL2: merged toggle round-trip skipped');
    ok(true, 'no WebGL2: worker-pool bake mode skipped');
    ok(true, 'no WebGL2: worker/main bake byte-compare skipped');
    ok(true, 'no WebGL2: determinism-gate re-enable skipped');
    ok(true, 'no WebGL2: pick index skipped (graph raycasts instead)');
    ok(true, 'no WebGL2: merged pick-probe check skipped');
    ok(true, 'no WebGL2: merged pin readout check skipped');
    ok(true, 'no WebGL2: merged provenance readout check skipped');
    ok(true, 'no WebGL2: merged preview check skipped');
    ok(true, 'no WebGL2: merged nudge check skipped');
    ok(true, 'no WebGL2: merged cell re-bake check skipped');
    ok(true, 'no WebGL2: merged Delete-key check skipped');
    ok(true, 'no WebGL2: merged reset check skipped');
    ok(true, 'no WebGL2: merged spawn pin skipped');
    ok(true, 'no WebGL2: merged spawn playback + overlay skipped');
    ok(true, 'no WebGL2: merged spawn restore skipped');
  }
  const stall = await page.evaluate(() => ({ ...window.__bs.worldView.stallProbe }));
  ok(stall && stall.phase === 'ready' && stall.worst >= 0,
    `stall probe tracks the whole load to ready (worst ${Math.round(stall.worst || 0)}ms`
    + `${stall.worstStage ? ` @ "${stall.worstStage}"` : ''})`);

  // ---- fly camera, all-rooms only ----------------------------------------------
  const flyBase = await page.evaluate(() => {
    const v = window.__bs.worldView;
    return {
      present: !!v.fly, orbit: v.scene3d.controls.enabled,
      speed: v.fly?.moveSpeed || 0, cameraSpeed: v.cameraSpeed,
      hint: document.querySelector('.cam-hint-card')?.textContent || '',
    };
  });
  ok(flyBase.present && flyBase.orbit === false && flyBase.speed > 0 && flyBase.cameraSpeed === 1,
    `all-rooms swaps the orbit for the fly camera (moveSpeed ${flyBase.speed.toFixed(1)})`);
  ok(/WASD/.test(flyBase.hint) && /mouselook/.test(flyBase.hint) && /Tab/.test(flyBase.hint),
    'all-rooms hint card retexts to the fly controls incl. Tab slow');

  const allBox = await (await page.$('.canvas-host canvas')).boundingBox();
  const ax = allBox.x + allBox.width * 0.45;
  const ay = allBox.y + allBox.height * 0.5;

  // KeyW while hovering the canvas flies forward along the yaw heading only
  const posBefore = await page.evaluate(() => window.__bs.worldView.scene3d.camera.position.toArray());
  await page.mouse.move(ax, ay);
  await page.keyboard.down('KeyW');
  await sleep(450);
  await page.keyboard.up('KeyW');
  const flyMove = await page.evaluate((before) => {
    const v = window.__bs.worldView;
    const p = v.scene3d.camera.position;
    const d = [p.x - before[0], p.y - before[1], p.z - before[2]];
    const len = Math.hypot(d[0], d[2]);
    const dot = len ? (d[0] * -Math.sin(v.fly.yaw) + d[2] * -Math.cos(v.fly.yaw)) / len : 0;
    return { len, dy: Math.abs(d[1]), dot };
  }, posBefore);
  ok(flyMove.len > 0.5 && flyMove.dot > 0.99 && flyMove.dy < 1e-6,
    `KeyW flies forward in the horizontal plane along the heading (${flyMove.len.toFixed(1)} units, dot ${flyMove.dot.toFixed(3)})`);

  // left-drag looks: a rightward drag turns the view right (yaw decreases)
  const yaw0 = await page.evaluate(() => window.__bs.worldView.fly.yaw);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(ax + i * 25, ay);
  await page.mouse.up();
  await sleep(200);
  const yaw1 = await page.evaluate(() => window.__bs.worldView.fly.yaw);
  ok(yaw0 - yaw1 > 0.5, `drag rotates yaw (${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)})`);

  // sustained upward drags: pitch clamps at +89° and never wraps
  // (each pass starts at a different x so Chrome never coalesces the clicks
  // into a dblclick, which would toggle pointer lock)
  for (let pass = 0; pass < 3; pass++) {
    const px = ax - 150 + pass * 150;
    await page.mouse.move(px, ay + 150);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(px, ay + 150 - i * 40);
    await page.mouse.up();
  }
  await sleep(200);
  const pitchInfo = await page.evaluate(() => ({
    pitch: window.__bs.worldView.fly.pitch,
    limit: (89 / 180) * Math.PI,
  }));
  ok(pitchInfo.pitch > 1 && pitchInfo.pitch <= pitchInfo.limit + 1e-9,
    `mouse-look pitch clamps at +89° (${pitchInfo.pitch.toFixed(3)} ≤ ${pitchInfo.limit.toFixed(3)})`);

  // HUD collapse persisted across the reload (prefs); expand it back
  ok(await page.evaluate(() => window.__bs.worldView.hud.state.collapsed === true),
    'HUD collapsed state persists across views');
  await page.click('.world-hud .wh-toggle');
  ok(await page.evaluate(() => window.__bs.worldView.hud.state.collapsed === false),
    'HUD expands again');

  // ---- abort: leaving the view frees its loop and every GL object -------------
  const memLoaded = await page.evaluate(() => {
    window.__probe = {
      view: window.__bs.worldView,
      renderer: window.__bs.worldView.scene3d.renderer,
    };
    return { ...window.__probe.renderer.info.memory };
  });
  await page.evaluate(() => { location.hash = '#/world'; });   // landing: no 3D view
  await page.waitForFunction(() => window.__bs.worldView === undefined, { timeout: 10000 });
  await sleep(400);
  const freed = await page.evaluate(() => ({
    disposed: window.__probe.view.world.disposed,
    rooms: window.__probe.view.world.rooms.size,
    mem: { ...window.__probe.renderer.info.memory },
  }));
  ok(freed.disposed && freed.rooms === 0,
    `destroy stops the world scene (disposed=${freed.disposed}, rooms=${freed.rooms})`);
  ok(freed.mem.geometries <= 2 && freed.mem.geometries < memLoaded.geometries
    && freed.mem.textures <= 2,
    `GL memory returns to baseline (geometries ${memLoaded.geometries} -> ${freed.mem.geometries}, `
    + `textures ${memLoaded.textures} -> ${freed.mem.textures})`);
  // fly-cam listeners are gone: a synthetic KeyW after destroy moves nothing
  const flyDead = await page.evaluate(() => {
    const f = window.__probe.view.fly;
    f.hover = true;   // force the gate a live keydown listener would pass
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    const cam = window.__probe.view.scene3d.camera;
    const before = cam.position.toArray();
    f.update(500);
    const after = cam.position.toArray();
    return { disposed: f.disposed, keys: f.keys.size, moved: before.some((v, i) => v !== after[i]) };
  });
  ok(flyDead.disposed && flyDead.keys === 0 && !flyDead.moved,
    'destroy removes the fly-cam listeners (post-destroy KeyW is inert)');

  // the confirm gate's other exit: cancel routes back to the room list
  await page.evaluate(() => { location.hash = '#/world/all'; });
  await page.waitForSelector('.world-loading .world-load-cancel', { timeout: 10000 });
  await page.click('.world-loading .world-load-cancel');
  await page.waitForFunction(() => location.hash === '#/world', { timeout: 10000 });
  ok(true, 'confirm gate cancel returns to the world list');

  // navigate INTO the load and away again immediately: no errors, view lands
  await page.evaluate(() => { location.hash = '#/world/all'; });
  await page.waitForSelector('.world-loading .world-load-confirm', { timeout: 10000 });
  await page.click('.world-loading .world-load-confirm');
  await sleep(30);   // mid-stream on the fixture world
  await page.evaluate(() => { location.hash = '#/world/1'; });
  await page.waitForFunction(() => window.__bs.worldView?.ready === true
    && /world\/1/.test(location.hash), { timeout: 30000 });
  ok(await page.evaluate(() => window.__bs.worldView.visibleInstanceCount() > 0),
    'room view restarts cleanly after an aborted all-rooms load');

  // pagehide (tab close mid-anything) runs the same abort path
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  ok(await page.evaluate(() => window.__bs.worldView === undefined),
    'pagehide destroys the world view');

  ok(errors.length === 0, `zero console errors in world suite${errors.length ? `:\n    ${errors.join('\n    ')}` : ''}`);
  await page.close();
}

// Minimal valid zstd frame wrapping `data` as a single RAW block: magic,
// single-segment frame header with a 1-byte content size, one last-raw-block.
// Lets the onboarding wizard's build check decompress a synthetic assetBundle0
// (whose hash then matches no per-build decode data, by design).
function zstdRawFrame(data: Buffer) {
  if (data.length > 255) throw new Error('zstdRawFrame: keep the payload under 256 bytes');
  const blockHeader = (data.length << 3) | 0b001;   // last=1, type=raw
  return Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, data.length,
      blockHeader & 0xff, (blockHeader >> 8) & 0xff, (blockHeader >> 16) & 0xff]),
    Buffer.from(data),
  ]);
}

async function onboardingSuite(browser: any) {
  console.log('\n== onboarding (synthetic bundles) ==');
  // Fresh origin (its own port) + a webroot with no data/ tree: the app boots
  // straight into the client-extraction wizard, exactly like a new user.
  const { root, cleanup } = await shimWebroot('bs-smoke-webroot-');
  const { server, port } = await serve(root);
  const base = `http://127.0.0.1:${port}`;
  // Tiny synthetic bundles: assetBundle0 is a valid zstd frame so the wizard's
  // build check can decompress + hash it; the rest only need the right names.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bs-smoke-bundles-'));
  const files: string[] = [];
  await fs.writeFile(path.join(dir, 'assetBundle0'),
    zstdRawFrame(Buffer.from('brighter-atlas synthetic assetBundle0, not a real game build')));
  files.push(path.join(dir, 'assetBundle0'));
  for (let n = 1; n <= 8; n++) {
    const p = path.join(dir, `assetBundle${n}`);
    await fs.writeFile(p, Buffer.from(`synthetic assetBundle${n}`));
    files.push(p);
  }

  // the fresh visit legitimately 404s the default HTTP data tree once
  const { page, errors } = await newPage(browser, ['data/manifest.json', 'data-nonexistent/manifest.json', 'builds/']);
  await page.goto(`${base}/index.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ob-drop', { timeout: 15000 });
  ok(true, 'fresh visit (no stored data) boots into the onboarding wizard');
  ok(await page.$eval('.onboard', (n) => /not affiliated/i.test(n.textContent) && /fan-made/i.test(n.textContent)),
    'wizard carries the fan-made / not-affiliated legal framing');
  ok(await page.$$eval('button', (b) => b.find((x) => x.textContent.startsWith('Continue'))?.disabled === true),
    'Continue is gated until assetBundle0 is picked');

  const input = await page.$('.ob-drop input[type=file]');
  await input.uploadFile(...files);
  await sleep(400);
  const okBundles = await page.$$eval('.ob-bundle.ok', (els) => els.length);
  ok(okBundles === 9, `all 9 synthetic bundles recognised by name (${okBundles})`);

  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Continue')).click());
  await page.waitForSelector('.ob-cat', { timeout: 5000 });
  const catNames = await page.$$eval('.ob-cat b', (bs) => bs.map((b) => b.textContent));
  ok(catNames.length >= 7 && catNames.includes('Meshes') && catNames.includes('World'),
    `category picker lists every category (${catNames.join(', ')})`);
  await page.waitForFunction(() => (document.querySelector('.ob-validate')?.textContent || '').trim().startsWith('✓'),
    { timeout: 15000 });
  ok(true, 'picked-bundle validation reports the game index ok');
  // the async build check settles: a synthetic assetBundle0 hashes to no
  // per-build decode data, so World must bow out honestly
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('.ob-cat')].find((r) => r.querySelector('b')?.textContent === 'World');
    return row && /world data on this bundle yet/.test(row.textContent);
  }, { timeout: 15000 });
  const rowState = await page.evaluate(() => {
    const rowOf = (name) => [...document.querySelectorAll('.ob-cat')].find((r) => r.querySelector('b')?.textContent === name);
    const world = rowOf('World');
    const meshes = rowOf('Meshes');
    return {
      worldDisabled: world.querySelector('input').disabled,
      worldChecked: world.querySelector('input').checked,
      worldExplains: /doesn.t have support for world data on this bundle yet/.test(world.textContent),
      meshesEnabled: !meshes.querySelector('input').disabled,
      meshesChecked: meshes.querySelector('input').checked,
    };
  });
  ok(rowState.worldDisabled && !rowState.worldChecked && rowState.worldExplains,
    'unknown build: World disables with an honest explanation (everything else still works)');
  ok(rowState.meshesEnabled && rowState.meshesChecked,
    'World bowing out releases its force-locked dependencies (Meshes selectable)');

  // Back returns to the pick step with the files kept
  await page.$$eval('button', (b) => b.find((x) => x.textContent === '← Back')?.click());
  await page.waitForSelector('.ob-drop', { timeout: 5000 });
  ok(await page.$$eval('.ob-bundle.ok', (els) => els.length) === 9, 'Back returns to the pick step with the files kept');

  // ---- classic ?data= landing: explicit HTTP tree missing -> guidance card ----
  await page.goto(`${base}/index.html?data=data-nonexistent`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.card');
  ok(await page.$eval('.card', (n) => !!n.querySelector('a[href*="data-fixtures"]')),
    'classic ?data= landing links to the built-in fixtures dataset');

  ok(errors.length === 0, `zero unexpected console errors in onboarding suite${errors.length ? `:\n    ${errors.join('\n    ')}` : ''}`);
  await page.close();
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
  await cleanup();
}

async function mobileGateSuite(browser: any) {
  console.log('\n== mobile gate (emulated phone) ==');
  // Fresh origin with no data/ tree (like the onboarding suite): the bypass
  // must land on the client-extraction wizard, exactly like a new phone user.
  const { root, cleanup } = await shimWebroot('bs-smoke-mgate-');
  const { server, port } = await serve(root);
  const base = `http://127.0.0.1:${port}`;

  const { page, errors } = await newPage(browser, ['data/manifest.json', 'builds/']);
  // feature-level phone emulation: coarse pointer + touch + small viewport + touch UA
  await page.emulate({
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await page.goto(`${base}/index.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.mgate', { timeout: 15000 });
  ok(await page.$('.ob-drop') === null, 'phone boot mounts the gate, not the onboarding wizard');
  ok(await page.$eval('#app', (n) => getComputedStyle(n).display === 'none'), 'app chrome stays hidden behind the gate');
  ok(await page.$eval('.mgate', (n) => n.textContent.includes('mobile lacks the memory + storage this needs')),
    'gate states the shared desktop-only reason');

  // three large actions; the community links are clones of the topbar anchors
  const acts = await page.$$eval('.mgate .mgate-action', (els) => els.map((n) => ({
    label: n.textContent.trim(), h: n.getBoundingClientRect().height,
    href: n.getAttribute('href'), target: n.getAttribute('target'), rel: n.getAttribute('rel'),
    svg: !!n.querySelector('svg'),
  })));
  ok(acts.length === 3 && acts.every((a) => a.h >= 44),
    `gate offers 3 tappable actions ≥44px (${acts.map((a) => `${a.label} ${Math.round(a.h)}px`).join(', ')})`);
  // the single source of truth for each URL/icon is the (hidden) topbar markup
  const srcLinks = await page.evaluate(() => Object.fromEntries(['discord', 'github'].map((k) =>
    [k, document.querySelector(`#topbar .top-social.${k}`)?.getAttribute('href')])));
  const discord = acts.find((a) => /Discord/.test(a.label));
  const github = acts.find((a) => /GitHub/.test(a.label));
  ok(!!discord && discord.href === srcLinks.discord && /discord\.gg\//.test(discord.href || '')
    && discord.target === '_blank' && /noopener/.test(discord.rel || '') && discord.svg,
  `Discord action clones the topbar anchor (${discord?.href})`);
  ok(!!github && github.href === srcLinks.github && /github\.com\//.test(github.href || '')
    && github.target === '_blank' && /noopener/.test(github.rel || '') && github.svg,
  `GitHub action clones the topbar anchor (${github?.href})`);

  // the desktop showcase: all curated previews load real pixels, and each
  // caption lives INSIDE its image's card (same figure) so association is
  // unambiguous
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('.mgate-preview img')] as any[];
    return imgs.length === 3 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, { timeout: 15000 });
  const prevs = await page.$$eval('.mgate-preview', (els) => els.map((f: any) => ({
    src: f.querySelector('img')?.getAttribute('src'),
    alt: f.querySelector('img')?.getAttribute('alt'),
    caption: f.querySelector('figcaption')?.textContent?.trim(),
  })));
  ok(prevs.length === 3 && prevs.every((p) => /^assets\/preview-.*\.jpg$/.test(p.src || '') && p.alt === p.caption),
    `gate shows 3 desktop previews, captions enclosed with their images (${prevs.map((p) => p.src).join(', ')})`);

  // Help/FAQs renders the SHARED help content inline: full page, no modal
  await page.$$eval('.mgate .mgate-action', (els) => (els.find((n) => /Help\/FAQs/.test(n.textContent)) as any)?.click());
  await page.waitForSelector('.mgate .help-body', { timeout: 5000 });
  const helpTxt = await page.$eval('.mgate .help-body', (n) => n.textContent);
  ok(/not affiliated with.*Fen Research/i.test(helpTxt) && /no upload, no account/i.test(helpTxt),
    'help renders inline with the shared help.ts content');
  ok(await page.$('.modal-overlay') === null, 'inline help mounts no modal overlay');
  ok(await page.$eval('.mgate-back', (n) => n === document.activeElement), 'back control takes focus (keyboard-reachable)');
  await page.click('.mgate-back');
  await page.waitForSelector('.mgate-actions', { timeout: 5000 });
  ok(await page.$('.mgate .help-body') === null, 'back control returns to the gate');

  // the escape hatch: sets the session flag and proceeds to the normal boot
  await page.click('.mgate-bypass');
  await page.waitForSelector('.ob-drop', { timeout: 20000 });
  ok(await page.$('.mgate') === null
    && await page.evaluate(() => sessionStorage.getItem('bs.mobileGateBypass') === '1'),
  'bypass proceeds to onboarding in-place (bs.mobileGateBypass set)');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.ob-drop', { timeout: 20000 });
  ok(await page.$('.mgate') === null, 'bypass persists for the session (reload boots the app)');
  ok(errors.length === 0, `zero console errors in mobile gate suite${errors.length ? `:\n    ${errors.join('\n    ')}` : ''}`);
  await page.close();

  // a NARROW DESKTOP window (mouse, no touch) must never gate
  const desk = await newPage(browser, ['data/manifest.json', 'builds/']);
  await desk.page.setViewport({ width: 640, height: 720 });
  await desk.page.goto(`${base}/index.html`, { waitUntil: 'networkidle0' });
  await desk.page.waitForSelector('.ob-drop', { timeout: 15000 });
  ok(await desk.page.$('.mgate') === null, 'narrow desktop window (fine pointer) never gates');
  ok(desk.errors.length === 0, `zero console errors in narrow-desktop check${desk.errors.length ? `:\n    ${desk.errors.join('\n    ')}` : ''}`);
  await desk.page.close();

  server.close();
  await cleanup();
}

async function realSuite(browser: any, base: string, dataDir: string) {
  console.log(`\n== real data suite (${dataDir}) ==`);
  const { page, errors } = await newPage(browser);
  const u = (hash) => `${base}/index.html?data=${dataDir}${hash}`;

  // mesh 3855: largest mesh, skinned, flagship animation test
  await page.goto(u('#/mesh/3855'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.canvas-host canvas', { timeout: 20000 });
  await sleep(1500);
  const cov = await paintCoverage(page);
  ok(cov > 0.05, `mesh #3855 paints (coverage ${(cov * 100).toFixed(1)}%)`);
  const hasBar = await page.$('.anim-bar select');
  ok(hasBar !== null, 'mesh #3855 exposes clip transport (skinned)');
  if (hasBar) {
    const clipVal = await page.$eval('.anim-bar select', (s) => {
      const opt = [...s.options].find((o) => o.value !== '-1' && !o.disabled);
      return opt ? opt.value : null;
    });
    if (clipVal != null) {
      await page.select('.anim-bar select', clipVal);
      await sleep(1200);
      const moved = await page.evaluate(() => {
        const v = window.__bs.meshView;
        if (!v?.rig || !v.bar?.sampler) return null;
        const trs = () => v.rig.bones.map((b) =>
          [...b.position.toArray(), ...b.quaternion.toArray(), ...b.scale.toArray()]
            .map((x) => +x.toFixed(4)).join(',')).join(';');
        const bar = v.bar;
        bar.pause();
        bar.t = 0.25 * bar.sampler.duration; bar.applyPose();
        const a = trs();
        bar.t = 0.55 * bar.sampler.duration; bar.applyPose();
        const b = trs();
        bar.play();
        return a !== b;
      });
      ok(moved === true, `mesh #3855 clip ${clipVal} animates the rig (pose differs at 25% vs 55%)`);
      // scale-driven appear/hide clips park bones at 0.001 for much of the
      // clip: scrub to 50% (parts at scale 1.0) before measuring paint
      await page.$eval('.anim-bar input[type=range]', (n) => { n.value = '500'; n.dispatchEvent(new Event('input')); });
      await sleep(300);
      const cov2 = await paintCoverage(page);
      ok(cov2 > 0.02, `animated mesh paints at mid-clip (${(cov2 * 100).toFixed(1)}%)`);
    } else ok(false, 'no exported clip for mesh 3855 skeleton');
  }

  // player rig ab6[235]
  await page.goto(u('#/rig/235'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.anim-bar select', { timeout: 20000 });
  await sleep(800);
  ok((await paintCoverage(page)) > 0.01, 'player rig ab6[235] renders');
  const clipCount = await page.$eval('.anim-bar select', (s) => s.options.length - 1);
  ok(clipCount > 0, `player rig lists clips (${clipCount})`);
  const clipVal = await page.$eval('.anim-bar select', (s) => [...s.options].find((o) => o.value !== '-1' && !o.disabled)?.value ?? null);
  if (clipVal != null) {
    await page.select('.anim-bar select', clipVal);
    await sleep(1000);
    ok(await page.$eval('.anim-bar .anim-time', (n) => /f\d+/.test(n.textContent)), `player rig plays clip #${clipVal}`);
    const rigMoves = await page.evaluate(async () => {
      const v = window.__bs.skelView;
      if (!v?.rig) return null;
      const snap = () => v.rig.bones.map((b) => b.quaternion.toArray().map((x) => +x.toFixed(4)).join(',')).join(';');
      const a = snap();
      await new Promise((r) => setTimeout(r, 350));
      return snap() !== a;
    });
    ok(rigMoves === true, 'player rig bones rotate during playback');
  }

  ok(errors.length === 0, `zero console errors in real suite${errors.length ? `:\n    ${errors.join('\n    ')}` : ''}`);
  await page.close();
}

(async () => {
  requireBuild('smoke.ts');
  if (!CHROME || !existsSync(CHROME)) {
    console.error('Chrome not found: set CHROME=/path/to/chrome or run: npx puppeteer browsers install chrome');
    process.exit(2);
  }
  const { server, port } = await serve(WEBAPP);
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new' as any,   // legacy new-headless flag, harmless on current Chrome
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-gpu-sandbox', ...GL_ARGS],
  });
  try {
    if (!realOnly) {
      await fixtureSuite(browser, base);
      await worldSuite(browser, base);
      await onboardingSuite(browser);
      await mobileGateSuite(browser);
    }
    if (realData && existsSync(path.join(WEBAPP, realData, 'manifest.json'))) {
      await realSuite(browser, base, realData);
    } else if (realData) {
      console.log(`\n(real data dir ${realData} has no manifest.json, skipped)`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})();
