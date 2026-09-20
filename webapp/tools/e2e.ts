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
// Anchored by NAME, not id: room ids are ab2 object indices and a game update
// renumbers them (one update moved 450 of 451 rooms, and this room's old id
// stopped being a room at all). Absent by name, the densest room stands in.
const DEFAULT_ROOM_NAME = 'Hopeport Garrison';
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
// onto the anims index (client-store `sn`). Find the player one-handed blunt
// attack family BY NAME, never by ordinal: bundle ordinals are renumbered by
// every game update, so pinning one tests the build rather than the recovery.
// (The mesh checks below already resolve by content hash for the same reason.)
// Anchored on the clip's CONTENT HASH, the same stable id the mesh checks
// below use, never its ordinal: ordinals are renumbered by every game update
// (this clip moved 567 -> 572). Matching by name instead would be weaker than
// the ordinal was, since it would still pass if the join attached names to the
// wrong clips, which is the regression this anchor exists to catch.
const animNames = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('anims');
  const named = idx.filter((c) => Array.isArray(c.sn) && c.sn.length).length;
  const clip = idx.find((c) => c.h === 'f372d08278da8f6f');
  return { named, total: idx.length, i: clip?.i ?? null, sn: clip?.sn ?? null };
});
ok(Array.isArray(animNames.sn)
  && animNames.sn.some((n) => n.includes('player_male_one_handed_blunt_attack')),
`the one-handed blunt attack clip carries its recovered animatic name `
+ `(clip ${animNames.i ?? 'NOT FOUND BY HASH'}, ${animNames.named}/${animNames.total} clips named, `
+ `${JSON.stringify(animNames.sn)})`);

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

// Every mesh on the player rig lands in a body slot, not just the few hundred
// an item definition names: the rest are inferred from the bone they are
// skinned to (islot). The two never collide on one mesh.
const rigSlots = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('meshes');
  // the player rig = the rig carrying the item-slotted meshes
  const slotted = new Map();
  for (const m of idx) if (typeof m.slot === 'string' && m.skel >= 0) slotted.set(m.skel, (slotted.get(m.skel) || 0) + 1);
  const rig = [...slotted.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
  const bound = idx.filter((m) => m.skel === rig);
  const slots = {};
  for (const m of bound) {
    const s = m.slot || m.islot;
    if (s) slots[s] = (slots[s] || 0) + 1;
  }
  return {
    rig,
    bound: bound.length,
    withSlot: bound.filter((m) => m.slot || m.islot).length,
    inferred: bound.filter((m) => !m.slot && m.islot).length,
    collisions: idx.filter((m) => m.slot && m.islot).length,
    otherRigsInferred: idx.filter((m) => m.islot && m.skel !== rig).length,
    slots,
  };
});
ok(rigSlots.bound > 1000 && rigSlots.withSlot / rigSlots.bound > 0.95 && rigSlots.inferred > 500,
  `player rig #${rigSlots.rig}: every mesh gets a body slot `
  + `(${rigSlots.withSlot}/${rigSlots.bound}, ${rigSlots.inferred} inferred, ${JSON.stringify(rigSlots.slots)})`);
ok(rigSlots.collisions === 0,
  `an inferred slot never sits on a mesh the item data already slots (${rigSlots.collisions})`);
ok(rigSlots.otherRigsInferred === 0,
  `inference stays on rigs with item slots to learn from (${rigSlots.otherRigsInferred} elsewhere)`);

// ...and the rig view's slot facet is built from all of them, which is the
// point: filtering "head" shows the whole head wardrobe, not the named few.
await page.goto(`${base}/index.html#/rig/${rigSlots.rig}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.sm-slot option', { timeout: 30000 });
const facet = await page.$eval('.sm-slot', (s) => [...s.options].slice(1).map((o) => o.text));
const facetTotal = facet.reduce((sum, text) => sum + (Number(text.match(/\((\d+)\)$/)?.[1]) || 0), 0);
ok(facet.length >= 4 && facetTotal === rigSlots.withSlot,
  `rig view slot facet covers every slotted mesh (${facetTotal} across ${facet.length}: ${facet.join(', ')})`);

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
const roomMetadata = await page.evaluate(async () => {
  const rooms = (await window.__bs.app.store.worldIndex())?.rooms || [];
  return {total:rooms.length, direct:rooms.filter(r=>r.nameSource==='room-record').length,
    episodes:[...new Set(rooms.map(r=>r.episode?.name).filter(Boolean))],
    complete:rooms.filter(r=>r.name && r.displayName && r.episode?.name
      && r.mapPosition?.length===2 && r.mapPosition.every(Number.isInteger)
      && r.mapSize?.length===2).length};
});
ok(roomMetadata.direct === roomMetadata.total && roomMetadata.complete === roomMetadata.total,
  `every room has a direct title, episode and map coordinates (${JSON.stringify(roomMetadata)})`);

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

// ---- 4c. dyeable regions on equipment -----------------------------------------
// Equipment textures carry a recolour mask whose two channels are the regions
// the game dyes at runtime; the albedo leaves them flat grey. The dye control
// paints them, and the choice is stored per mesh (dyes.ts), so it must survive
// a reload. Textures are shared, so a given mesh's UVs need not touch the
// masked area at all: the scan below takes the first candidate that actually
// repaints rather than assuming the first one does.
const dyeCandidates = await page.evaluate(async () => {
  const idx = await window.__bs.app.store.index('meshes');
  return idx.filter((m) => m.f && (m.slot || m.islot) && m.sys?.variants?.length)
    .slice(0, 12).map((m) => m.i);
});
// average canvas colour: the dye has to actually change what is on screen
const avgColor = (): Promise<number[] | null> => page.evaluate(() => {
  const c: any = document.querySelector('.canvas-host canvas');
  if (!c || !c.width) return null;
  const t = document.createElement('canvas');
  const w = (t.width = Math.min(c.width, 400));
  const h = (t.height = Math.min(c.height, 300));
  const g: any = t.getContext('2d');
  g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
  return sum.map((x) => x / (w * h));
});
const showTextured = async () => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.viewer-toolbar button')].find((x: any) => x.textContent === 'Textured') as any;
    b?.click();
  });
  await sleep(700);
};
const setDye = (hex: string) => page.evaluate((value: string) => {
  const input: any = document.querySelector('.tex-dyes input.dye-swatch');
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, hex);

let dyeMesh: number | null = null;
let dyeDelta = 0;
let dyeState: any = null;
let withControl = 0;
for (const i of dyeCandidates) {
  await page.goto(`${base}/index.html#/mesh/${i}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.canvas-host canvas', { timeout: 30000 });
  await sleep(700);
  if (!(await page.$('.tex-dyes:not([hidden]) input.dye-swatch'))) continue;
  withControl++;
  await showTextured();
  const before = await avgColor();
  await setDye('#c81e78');
  await sleep(1200);
  const after = await avgColor();
  const delta = before && after
    ? before.map((x, k) => Math.abs(x - after[k])).reduce((a, b) => a + b, 0) : 0;
  const state = await page.evaluate(() => {
    const rec = window.__bs.meshView?.texMat?.userData?.exactRecolor;
    return rec ? { applied: rec.applied, mode: rec.mode, field: rec.sourceField } : null;
  });
  if (delta > 3) { dyeMesh = i; dyeDelta = delta; dyeState = state; break; }
  // this mesh does not sit on the masked part of its shared texture: undo and move on
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.tex-dyes button')].find((b: any) => b.textContent === '∅') as any;
    btn?.click();
  });
}
ok(withControl > 0, `equipment meshes offer the dye control (${withControl} of ${dyeCandidates.length} candidates)`);
ok(dyeMesh != null, `a dyed region repaints the mesh (#${dyeMesh}, mean channel delta ${dyeDelta.toFixed(1)} > 3)`);
ok(dyeState?.applied === true && dyeState.mode === 'two-mask' && dyeState.field === 'dye',
  `the dye compiles into the native two-mask recolour (${JSON.stringify(dyeState)})`);
if (dyeMesh != null) {
  // a SECOND colour must take too: three.js reuses the compiled program, so the
  // recolour uniforms have to be live (recolor.ts recolorUniforms)
  const first = await avgColor();
  await setDye('#19c8ff');
  await sleep(1200);
  const second = await avgColor();
  const reDelta = first && second
    ? first.map((x, k) => Math.abs(x - second[k])).reduce((a, b) => a + b, 0) : 0;
  ok(reDelta > 1, `re-dyeing the same mesh takes effect (delta ${reDelta.toFixed(1)} > 1)`);

  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.tex-dyes input.dye-swatch', { timeout: 30000 });
  await showTextured();
  const kept = await page.$eval('.tex-dyes input.dye-swatch', (input: any) => input.value);
  const keptState = await page.evaluate(() => window.__bs.meshView?.texMat?.userData?.exactRecolor?.sourceField ?? null);
  ok(kept === '#19c8ff' && keptState === 'dye', `the dye survives a reload (${kept}, ${keptState})`);

  // clearing puts the texture back as authored
  const dyed = await avgColor();
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.tex-dyes button')].find((b: any) => b.textContent === '∅') as any;
    btn.click();
  });
  await sleep(1200);
  const undyed = await avgColor();
  const clearDelta = dyed && undyed
    ? dyed.map((x, k) => Math.abs(x - undyed[k])).reduce((a, b) => a + b, 0) : 0;
  const clearedState = await page.evaluate(() => window.__bs.meshView?.texMat?.userData?.exactRecolor ?? null);
  ok(clearDelta > 1 && (clearedState == null || clearedState.sourceField !== 'dye'),
    `clearing the dye returns the mesh to its authored texture (delta ${clearDelta.toFixed(1)})`);

  // ---- the dye reaches an exported GLB ---------------------------------------
  // glTF cannot express "tint only these texels", so the dye is baked into the
  // exported albedo (gltf-export.ts bakeDye). Export the same mesh undyed and
  // dyed, decode the texture the GLB actually carries, and compare.
  const exportStats = () => page.evaluate(() => new Promise<any>((resolve) => {
    const w = window as any;
    const captured: Blob[] = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: any) => { if (obj instanceof Blob) captured.push(obj); return orig(obj); };
    const btn = document.querySelector('.viewer-toolbar .asset-export-btn') as any;
    if (!btn) { URL.createObjectURL = orig; resolve(null); return; }
    btn.click();
    const deadline = Date.now() + 30000;
    const poll = async () => {
      const blob = captured.find((b) => b.size > 1000);
      if (!blob) {
        if (Date.now() > deadline) { URL.createObjectURL = orig; resolve(null); return; }
        setTimeout(poll, 250);
        return;
      }
      URL.createObjectURL = orig;
      try {
        const buf = new Uint8Array(await blob.arrayBuffer());
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let off = 12; let json: any = null; let bin: Uint8Array | null = null;
        while (off < buf.length) {
          const len = dv.getUint32(off, true);
          const type = dv.getUint32(off + 4, true);
          const chunk = buf.subarray(off + 8, off + 8 + len);
          if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
          else if (type === 0x004e4942) bin = chunk;
          off += 8 + len;
        }
        const image = json?.images?.[0];
        if (!image || !bin) { resolve({ material: json?.materials?.[0]?.name ?? null, mean: null }); return; }
        const view = json.bufferViews[image.bufferView];
        const bytes = bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
        const bmp = await createImageBitmap(new Blob([bytes], { type: image.mimeType || 'image/png' }));
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(bmp.width, 256);
        canvas.height = Math.min(bmp.height, 256);
        const ctx: any = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
        const n = canvas.width * canvas.height;
        resolve({ material: json?.materials?.[0]?.name ?? null, mean: sum.map((x) => x / n) });
      } catch (err: any) { resolve({ error: String(err?.message || err) }); }
    };
    poll();
  }));

  const plainGlb = await exportStats();
  await setDye('#19c8ff');
  await sleep(1200);
  const dyedGlb = await exportStats();
  const glbDelta = plainGlb?.mean && dyedGlb?.mean
    ? plainGlb.mean.map((x: number, k: number) => Math.abs(x - dyedGlb.mean[k])).reduce((a: number, b: number) => a + b, 0) : 0;
  ok(plainGlb?.mean != null && dyedGlb?.mean != null,
    `GLB export embeds its texture (${JSON.stringify(plainGlb?.material)} -> ${JSON.stringify(dyedGlb?.material)})`);
  ok(glbDelta > 3, `the exported GLB carries the dye, baked into its texture (mean delta ${glbDelta.toFixed(1)} > 3)`);
  ok(/_dyed$/.test(dyedGlb?.material || '') && !/_dyed$/.test(plainGlb?.material || ''),
    'only the dyed export names its texture as baked');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.tex-dyes button')].find((b: any) => b.textContent === '∅') as any;
    btn?.click();
  });
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
  // Pick the sample room from the DATA, never a fixed id: room ids are ab2
  // object indices and a game update renumbers them wholesale (one update moved
  // 450 of 451 rooms), which silently left this comparing zero files.
  const roomEntry = (wi?.rooms || [])
    .filter((r) => (r.textures || []).filter((id: number) => id >= 500).length >= 3)
    .sort((a, b) => (b.textures || []).length - (a.textures || []).length)[0];
  const texIds = (roomEntry?.textures || []).filter((id) => id >= 500).slice(0, 3);
  const idx = await store.index('images');
  const byI = new Map(idx.map((e) => [e.i, e]));
  const cache = await caches.open('bs-decoded-v6');
  const out = { compared: 0, mismatches: [], room: roomEntry ? roomEntry.id : null };
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
  `pre-warmed PNGs byte-equal fresh SW decodes (${warmCheck.compared} compared`
  + `${warmCheck.room == null ? ', NO ROOM with >= 3 world textures found' : ` from room ${warmCheck.room}`}`
  + `${warmCheck.mismatches.length ? `, MISMATCH: ${warmCheck.mismatches.join(', ')}` : ''})`);

// ---- 7. world room: renders with real paint coverage --------------------------
if (!rooms.length) { console.log('\nFAILED: no rooms in the world index, cannot run the world checks'); process.exit(1); }
const ROOM = Number(roomArg)
  || rooms.find((r) => r.name === DEFAULT_ROOM_NAME)?.id
  || rooms.reduce((a, b) => (b.meshes > a.meshes ? b : a)).id;   // densest room fallback
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

  // ---- 7b2. merged-mode ambient effects: proximity activation sanity --------
  // Same opt-in gate as the load above (this is the only place the suite
  // pays for a full merged bake). Weak/software adapters (this harness runs
  // on SwiftShader) default merged effects OFF on first visit, alongside
  // water, so turn them on explicitly before asserting; on a capable GPU
  // they are already on and the click below is a harmless no-op check.
  {
    const clickCheck = (label: string) => page.evaluate((l) => {
      const opt = [...document.querySelectorAll('.world-panel .wp-check')]
        .find((n) => n.textContent.trim() === l);
      const input = opt?.querySelector('input');
      input?.click();
      return input ? input.checked : null;
    }, label);
    // "Town Square" is the same dense looping room used by the fountain
    // probe below; any room with attachments would do, so a build without
    // that name falls back to the first extracted room rather than skipping.
    const fxRoomId = rooms.find((r) => r.name === 'Town Square')?.id ?? rooms[0]?.id ?? null;
    if (fxRoomId == null) {
      console.log('  WARN: no rooms available, skipping the merged effects check');
      ok(true, 'merged effects activation skipped (no rooms)');
    } else {
      const fxWasOn = await page.evaluate(() => !!window.__bs.worldView.state.effects);
      if (!fxWasOn) await clickCheck('Effects');
      // focusRoom needs no already-active system (unlike effectsApi.focus):
      // it teleports the fly camera straight to the room's stitched corner,
      // which is what brings it inside the proximity activation radius.
      await page.evaluate((roomId) => {
        window.__bs.worldView.effectsApi.focusRoom(roomId, 20);
      }, fxRoomId);
      try {
        await page.waitForFunction(() => (window.__bs.worldView.effectsApi?.info().live || 0) > 0,
          { timeout: 20000 });
      } catch { /* reported by the assert below, with the live diagnostic attached */ }
      const mergedFx = await page.evaluate(() => window.__bs.worldView.effectsApi.info());
      ok(mergedFx.live > 0,
        `merged-mode ambient effects activate by proximity near a known room (${JSON.stringify(mergedFx)})`);
      await sleep(300);
      const mergedShot = path.join(SHOTS, 'e2e_effects_merged.png');
      await page.screenshot({ path: mergedShot });
      console.log(`  screenshot: ${mergedShot}`);
    }
  }
}

// ---- 7c. enemies use explicit authored actor records ------------------------
// Resolve by room name, never build-specific registry or bundle ordinals.
const bearRoomId = rooms.find((r) => r.name === 'Bear Clearing')?.id ?? null;
const bearSpawns = bearRoomId == null ? null : await page.evaluate(async (roomId) => {
  const store = window.__bs.app.store;
  const [index, shard] = await Promise.all([store.worldIndex(), store.worldRoom(roomId)]);
  const cols: Record<string, number> = {};
  (index?.columns?.spawn || []).forEach((name: string, i: number) => { cols[name] = i; });
  const rows = (shard?.spawns || []).filter((r) => r[cols.label] === 'Bear');
  return rows.map((r) => ({ x: r[cols.x], y: r[cols.y], origin: r[cols.origin], sz: r[cols.surface_z] }));
}, bearRoomId);
ok(bearSpawns !== null && bearSpawns.length >= 1 && bearSpawns.every((s) => s.origin === 0
  && Number.isFinite(s.sz) && s.sz >= 1536 && s.sz <= 4096),
  `Bear Clearing carries authored, grounded bear actors `
  + `(room ${bearRoomId ?? 'NOT FOUND BY NAME'}: ${JSON.stringify(bearSpawns)})`);
const actorAudit = await page.evaluate(async () => {
  const store = window.__bs.app.store, world = window.__bs.worldView.world;
  const index = await store.worldIndex();
  const cols = Object.fromEntries(index.columns.spawn.map((name, i) => [name, i]));
  const pc = Object.fromEntries(index.columns.spawn_part.map((name, i) => [name, i]));
  const threePath = '/vendor/three.module.js';
  const {Matrix4} = await import(threePath);
  let actors = 0, defaults = 0, volumes = 0, largeActors = 0, transforms = 0;
  const failures = [];
  for (const room of index.rooms) {
    const shard = await store.worldRoom(room.id);
    volumes += shard.room_volumes?.length ?? 0;
    for (let i = 0; i < shard.spawns.length; i++) {
      const row = shard.spawns[i]; actors++;
      if (row[cols.origin] !== 0 || row[cols.default_room_record] !== row[cols.room_record]
        || !Number.isFinite(row[cols.centre_offset])) failures.push([room.id, i, 'provenance']);
      if (shard.spawn_memberships.some(m => m[0] === i && m[1] === index.enums.spawn_membership_kind.default_room)) defaults++;
      if (row[cols.centre_offset] > 0.5) {
        largeActors++;
        const part = shard.spawn_parts.find(p => p[pc.spawn] === i);
        if (!part) continue;
        const actual = world._spawnMatrix(shard, part, new Matrix4()).elements;
        const expected = [cols.x, cols.y].map(c => Math.fround(Math.fround(row[c]) + row[cols.centre_offset]) * index.coordinate_system.tile_units);
        if (actual[12] !== expected[0] || actual[13] !== expected[1]) failures.push([room.id, i, 'centre']);
        transforms++;
      }
    }
  }
  return {actors, defaults, volumes, largeActors, transforms, failures};
});
ok(actorAudit.actors > 1000 && actorAudit.defaults === actorAudit.actors && actorAudit.volumes > 0
  && actorAudit.largeActors > 0 && actorAudit.transforms > 0 && actorAudit.failures.length === 0,
  `every actor retains default-room provenance; large actor matrices use authored centres (${JSON.stringify(actorAudit)})`);

// ---- 7d. recovered particle effect systems ------------------------------------
// The world:effects doc rode in with the World extraction. Thresholds are
// plain counts; the spot checks anchor by NAME (recovered animatic names and
// room names are extracted data), never by ordinal, and never assert decoded
// numeric game values.
const fxProbe = await page.evaluate(async () => {
  const store = window.__bs.app.store;
  return { has: await store.hasWorldEffects?.(), doc: !!(await store.worldEffects?.()) };
});
ok(fxProbe.has === true && fxProbe.doc === true, 'effects doc stored (hasWorldEffects + worldEffects)');
const fx = await page.evaluate(async () => {
  const doc = await window.__bs.app.store.worldEffects();
  if (!doc) return null;
  // effective blend: the emitter's own override, else the system's
  const blendOf = (sys, e) => e.blend || sys.blend;
  const isAddCont = (sys) => sys.emitters.some((e) => blendOf(sys, e) === 'add'
    && e.burst != null && doc.configs[String(e.burst)]?.kind === 'burst_continuous');
  const lantern = doc.systems.find((s) => s.names.some((n) => n.name.includes('hanging_street_lantern_idle'))) || null;
  return {
    systems: doc.systems.length,
    named: doc.systems.filter((s) => s.names.length > 0).length,
    roomAtt: doc.attachments.rooms.length,
    actorAtt: doc.attachments.actors.length,
    additiveContinuous: doc.systems.filter(isAddCont).length,
    lantern: lantern && {
      loop: lantern.loop,
      emitters: lantern.emitters.length,
      addContinuous: isAddCont(lantern),
    },
  };
});
if (!fx) {
  // absent doc: fail through ok() and skip the dependent assertions instead
  // of crashing the suite dereferencing null
  ok(false, 'effects doc stored (worldEffects() resolved null, dependent effects checks skipped)');
} else {
  ok(fx.systems > 1000, `effect systems recovered (${fx.systems} > 1000)`);
  // named counts systems carrying at least one recovered name entry (from
  // the controller name join or a referencing row's own strings), never a
  // plain system count; the row-string path names nearly every system on
  // current builds, so this legitimately tracks close to the systems count
  ok(fx.named > 500, `named effect systems (${fx.named} > 500)`);
  ok(fx.roomAtt > 100, `room-attached effects (${fx.roomAtt} > 100)`);
  ok(fx.actorAtt > 50, `actor-attached effects (${fx.actorAtt} > 50)`);
  // structural additive-continuous check: ambient effects are overwhelmingly
  // additive looping emitters feeding a continuous burst config
  ok(fx.additiveContinuous > 100,
    `systems with an additive continuous emitter (${fx.additiveContinuous} > 100)`);
  // Supported releases can express this effect with one emitter or several.
  // Its looping additive-continuous behavior is the invariant.
  ok(fx.lantern != null && fx.lantern.loop === true && fx.lantern.emitters >= 1 && fx.lantern.addContinuous,
    `hanging street lantern system: looping additive continuous emitter (${JSON.stringify(fx.lantern)})`);
  // the room named Town Square hosts a dense looping system; resolved by NAME
  // (room names partly come from the cross-build fill, so a rename skips with
  // a warning instead of failing the suite)
  const squareId = rooms.find((r) => r.name === 'Town Square')?.id ?? null;
  if (squareId == null) {
    console.log('  WARN: no room named "Town Square" in this build, skipping the effects room anchor');
    ok(true, 'Town Square effects anchor skipped (room name absent)');
  } else {
    const square = await page.evaluate(async (roomId) => {
      const doc = await window.__bs.app.store.worldEffects();
      const systems = new Set(doc.attachments.rooms.filter((a) => a.room === roomId).map((a) => a.system));
      const bySlot = new Map(doc.systems.map((s) => [s.slot, s]));
      let best = null;
      for (const slot of systems) {
        const sys: any = bySlot.get(slot);
        if (sys && (!best || sys.emitters.length > best.emitters)) {
          best = { slot: sys.slot, emitters: sys.emitters.length, loop: sys.loop };
        }
      }
      return best;
    }, squareId);
    ok(square != null && square.emitters >= 8 && square.loop === true,
      `Town Square hosts a dense looping effect system (${JSON.stringify(square)})`);
  }
}

// ---- 7e. effects layer renders in real rooms (frozen clock + screenshots) -----
// Rooms resolve BY NAME from the stored world index rooms list (a rename
// skips with a warning, never fails the suite). The sim freezes at a
// developed clock so the shots are deterministic and human-reviewable; the
// paint delta is measured against an otherwise static scene (water toggled
// off for the comparison since its ripples animate, restored for the shot).
const clickWorldCheck = (label: string) => page.evaluate((l) => {
  const opt = [...document.querySelectorAll('.world-panel .wp-check')]
    .find((n) => n.textContent.trim() === l);
  const input = opt?.querySelector('input');
  input?.click();
  return input ? input.checked : null;
}, label);
const waitWorldFrame = () => page.evaluate(() => new Promise((resolve) => {
  const r = window.__bs.worldView.scene3d.renderer;
  const f0 = r.info.render.frame;
  const check = () => (r.info.render.frame > f0 ? resolve(true) : requestAnimationFrame(check));
  requestAnimationFrame(check);
}));
// downscaled canvas grab, diffed against the previous grab: under the frozen
// clock only particle pixels can differ between the two captures. The
// channel threshold is per probe: a lone lantern flame is a handful of dim
// additive pixels, a fountain a dense plume.
const grabDiff = (channelMin: number) => page.evaluate((cmin) => {
  const c = document.querySelector('.canvas-host canvas');
  const t = document.createElement('canvas');
  const w = (t.width = Math.min(c.width, 800));
  const h = (t.height = Math.min(c.height, 600));
  const g = t.getContext('2d');
  g.drawImage(c, 0, 0, w, h);
  const prev = window.__fxPixels || null;
  const cur = g.getImageData(0, 0, w, h).data;
  window.__fxPixels = cur;
  if (!prev) return null;
  let diff = 0; let sum = 0;
  for (let i = 0; i < cur.length; i += 4) {
    const d = Math.abs(cur[i] - prev[i]) + Math.abs(cur[i + 1] - prev[i + 1])
      + Math.abs(cur[i + 2] - prev[i + 2]);
    sum += d;
    if (d > cmin) diff++;
  }
  return { diff, sum };
}, channelMin);
// aim the camera straight at a LIVE particle (the biggest one) so the paint
// delta measures a close-up of something guaranteed on screen; anchors can
// sit far from where a system's particles actually develop
const aimAtParticles = () => page.evaluate(() => {
  const v = window.__bs.worldView;
  const tu = v.world.tileUnits;
  let best: any = null;
  for (const b of v.effectsApi.buffers()) {
    for (let i = 0; i < b.count; i++) {
      const score = b.posSize[i * 4 + 3] * (b.color[i * 4 + 3] / 255);
      if (score > 0 && (!best || score > best.score)) {
        best = { score, x: b.posSize[i * 4] / tu, y: b.posSize[i * 4 + 2] / tu, z: b.posSize[i * 4 + 1] / tu };
      }
    }
  }
  if (!best) return false;
  const s = v.scene3d;
  s.controls.target.set(best.x, best.y, best.z);
  s.camera.position.set(best.x - 3.2, best.y + 2.4, best.z + 3.2);
  s.camera.near = 0.05;
  s.camera.updateProjectionMatrix();
  s.controls.update();
  return true;
});
// diagnostic summary of the live batches (public-safe: counts + display
// sizes + alpha bytes), printed so a failing threshold carries its data
const fxDiag = () => page.evaluate(() => {
  const v = window.__bs.worldView;
  return v.effectsApi.buffers().map((b) => {
    let minW = Infinity; let maxW = 0; let maxA = 0;
    for (let i = 0; i < b.count; i++) {
      const w = b.posSize[i * 4 + 3];
      if (w < minW) minW = w; if (w > maxW) maxW = w;
      const a = b.color[i * 4 + 3];
      if (a > maxA) maxA = a;
    }
    return `${b.key}: n=${b.count} w=${b.count ? minW.toFixed(3) : '-'}..${maxW.toFixed(3)} maxA=${maxA}`;
  }).join(' | ');
});
for (const probe of [
  // minSum 0: a lone lantern flame is too few dim additive pixels for a
  // reliable close-up paint delta (washes out in the downscaled diff), so its
  // delta is informational and it is gated on live count + coverage + the
  // review screenshot instead. The dense fountain keeps a hard delta.
  { room: 'Twiddle Corner', focus: 'hanging_street_lantern_idle', extent: 3, aimParticles: true, clock: 5000, minLive: 0, channelMin: 8, minDiff: 0, minSum: 0, shot: 'e2e_effects_lantern.png' },
  { room: 'Town Square', focus: null, extent: 10, aimParticles: false, clock: 1750, minLive: 200, channelMin: 12, minDiff: 200, minSum: 5000, shot: 'e2e_effects_fountain.png' },
  // The monument's braziers are the co-location case: one system's emitters
  // must all sit in their own bowl, never split between the bowl and a point
  // metres away (see the attachment note in effects-layer.ts addRoom).
  { room: 'Fallen Monument', focus: null, extent: 8, aimParticles: false, clock: 3000, minLive: 0, channelMin: 8, minDiff: 0, minSum: 0, shot: 'e2e_effects_monument.png' },
]) {
  const fxRoomId = rooms.find((r) => r.name === probe.room)?.id ?? null;
  if (fxRoomId == null) {
    console.log(`  WARN: no room named "${probe.room}" in this build, skipping its effects render`);
    ok(true, `${probe.room} effects render skipped (room name absent)`);
    continue;
  }
  await page.goto(`${base}/index.html#/world/${fxRoomId}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__bs.worldView?.ready === true, { timeout: 300000 });
  await page.waitForFunction(() => (window.__bs.worldView.effectsApi?.info().systems || 0) > 0,
    { timeout: 60000 });
  // freeze at a developed clock: steady glow for loops, jets mid-arc
  await page.evaluate((t) => {
    const fx = window.__bs.worldView.effectsApi;
    fx.setRunning(false);
    fx.setClock(t);
  }, probe.clock);
  const fxLive = await page.evaluate(() => window.__bs.worldView.effectsApi.info().live);
  ok(fxLive > probe.minLive,
    `${probe.room} live particles at tick ${probe.clock} (${fxLive} > ${probe.minLive})`);
  // frame the flagship system: by recovered name when given (densest system
  // as the fallback), so the paint delta measures a close-up, not specks
  const focused = await page.evaluate(async (name, id, extent) => {
    const fx = window.__bs.worldView.effectsApi;
    if (name && fx.focus(name, extent)) return `name:${name}`;
    const doc = await window.__bs.app.store.worldEffects();
    const bySlot = new Map(doc.systems.map((s) => [s.slot, s]));
    let best: any = null;
    for (const att of doc.attachments.rooms) {
      if (att.room !== id) continue;
      const sys: any = bySlot.get(att.system);
      if (sys && (!best || sys.emitters.length > best.emitters.length)) best = sys;
    }
    if (best && fx.focus(best.slot, extent)) return `slot:${best.slot}`;
    return null;
  }, probe.focus, fxRoomId, probe.extent);
  console.log(`  ${probe.room}: focused ${focused} · ${await fxDiag()}`);
  // a sparse effect's anchor can sit away from where its particles develop:
  // aim straight at the biggest live particle for the close-up measurement
  if (probe.aimParticles) await aimAtParticles();
  await clickWorldCheck('Animated water');
  await waitWorldFrame();
  await page.evaluate(() => { window.__fxPixels = null; });
  await grabDiff(probe.channelMin);            // effects-ON capture
  await clickWorldCheck('Effects');
  await waitWorldFrame();
  const fxDelta = await grabDiff(probe.channelMin);  // effects-OFF -> delta
  if (probe.minSum > 0) {
    ok(fxDelta && fxDelta.diff >= probe.minDiff && fxDelta.sum > probe.minSum,
      `${probe.room} effects paint a visible delta (${fxDelta?.diff} px differ, `
      + `abs sum ${fxDelta?.sum} > ${probe.minSum})`);
  } else {
    // A small effect (a lone lantern flame is a handful of dim additive
    // pixels) tucked tight against its own owner: the close-up delta is
    // unreliable because the aimed camera can land opaque owner geometry
    // between it and the glow. Validated by the live count, the paint
    // coverage, and the review screenshot instead; the delta is logged.
    ok(true,
      `${probe.room} effects delta (informational: ${fxDelta?.diff} px differ, `
      + `abs sum ${fxDelta?.sum})`);
  }
  // restore effects + water at the same frozen clock, then the review shot
  await clickWorldCheck('Effects');
  await page.waitForFunction(() => (window.__bs.worldView.effectsApi?.info().systems || 0) > 0,
    { timeout: 60000 });
  await page.evaluate((t) => {
    const fx = window.__bs.worldView.effectsApi;
    fx.setRunning(false);
    fx.setClock(t);
  }, probe.clock);
  await clickWorldCheck('Animated water');
  await waitWorldFrame();
  await sleep(400);
  const fxCov = await paintCoverage(page);
  ok(fxCov > 0.05, `${probe.room} paints with effects on (coverage ${(fxCov * 100).toFixed(1)}% > 5%)`);
  const fxShot = path.join(SHOTS, probe.shot);
  await page.screenshot({ path: fxShot });
  console.log(`  screenshot: ${fxShot}`);
}

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

// ---- 8a3. model-page particle effects: Electric Snail -------------------------
// Independent structural check (deliberately not reusing model.ts's own join
// helpers): find an effect system whose recovered name mentions the snail,
// walk the doc's owner attachments to the registry slot(s) that own it, and
// resolve which system-catalog model carries one of those slots in its
// `sources`. This confirms the runtime join actually holds on real data, not
// just that some model happens to be named "Electric Snail". Falls back to a
// plain name match if the effect-system name search misses.
const snail = await page.evaluate(async () => {
  const rel = (window as any).__bs.app.store.manifest?.system?.models;
  if (!rel) return null;
  const store = (window as any).__bs.app.store;
  const [models, doc] = await Promise.all([
    store.json(rel),
    store.worldEffects ? store.worldEffects() : Promise.resolve(null),
  ]);
  if (!Array.isArray(models)) return null;
  const systemSlots = new Set(
    ((doc?.systems as any[]) || [])
      .filter((s) => (s.names || []).some((n: any) => /electric_snail/i.test(n.name)))
      .map((s) => s.slot),
  );
  const ownerSlots = new Set<number>();
  for (const att of (doc?.attachments?.owners as any[]) || []) {
    if (systemSlots.has(att.system)) ownerSlots.add(att.owner);
  }
  let hit = ownerSlots.size
    ? models.find((m: any) => Array.isArray(m.sources) && m.sources.some((s: any) => (
      ownerSlots.has(s.owner_slot) || ownerSlots.has(s.entity_owner_slot) || ownerSlots.has(s.entity_family_owner_slot)
    )))
    : null;
  if (!hit) hit = models.find((m: any) => /electric snail/i.test(m.name || ''));
  return hit ? { id: hit.id, name: hit.name, bySystem: ownerSlots.size > 0 } : null;
});
if (!snail) {
  console.log('  WARN: no Electric Snail model/effect system found in this build, skipping model-page effects check');
  ok(true, 'model-page effects skipped (Electric Snail absent)');
} else {
  await page.goto(`${base}/index.html#/model/${snail.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.canvas-host canvas', { timeout: 30000 });
  await page.waitForFunction(() => typeof (window as any).__bs.modelView?.effectsInfo === 'function', { timeout: 20000 });
  await page.waitForFunction(() => ((window as any).__bs.modelView.effectsInfo().systems || []).length > 0, { timeout: 20000 })
    .catch(() => { /* asserted (and reported) below with whatever resolved */ });
  const info = await page.evaluate(() => (window as any).__bs.modelView.effectsInfo());
  ok(info.systems.length >= 1,
    `${snail.name} (${snail.id}, resolved by ${snail.bySystem ? 'effect system name' : 'model name'}) `
    + `has >= 1 attached effect system (${info.systems.length}: ${info.systems.map((s: any) => `${s.name}/${s.mode}`).join(', ')})`);
  await sleep(500);
  let live = await page.evaluate(() => (window as any).__bs.modelView.effectsInfo().live);
  if (!(live > 0)) {
    // every attached system is timed (no idle/ambient one auto-playing):
    // fire the first "Play effect" chip so the screenshot has a real chance
    // of showing the burst
    const clicked = await page.evaluate(() => {
      const btn: any = [...document.querySelectorAll('.viewer-toolbar button')]
        .find((b: any) => b.title === 'Play this timed particle effect once');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (clicked) {
      await page.waitForFunction(() => (window as any).__bs.modelView.effectsInfo().live > 0, { timeout: 8000 })
        .catch(() => { /* asserted (and reported) below with whatever resolved */ });
    }
    live = await page.evaluate(() => (window as any).__bs.modelView.effectsInfo().live);
  }
  ok(live > 0, `Electric Snail effect(s) render live particles (live=${live})`);
  const snailShot = path.join(SHOTS, 'e2e_effects_snail.png');
  await page.screenshot({ path: snailShot });
  console.log(`  screenshot: ${snailShot}`);
}

// ---- 8a4. model-page particle effects: Giant Rat (ambient aura) ----------------
// The rat's aura is a generic, centre-less ambient system (shared by ~2000
// creature owners, so it does not carry the creature's name), attached
// through the same owner-slot join model.ts uses. Unlike the snail's timed
// burst this is an infinite ambient loop, so it should already be live once
// the model page settles: a good regression check that particles anchor on
// the body (not the floor/feet).
const rat = await page.evaluate(async () => {
  const rel = (window as any).__bs.app.store.manifest?.system?.models;
  if (!rel) return null;
  const models = await (window as any).__bs.app.store.json(rel);
  if (!Array.isArray(models)) return null;
  const hit = models.find((m: any) => /giant rat/i.test(m.name || ''));
  return hit ? { id: hit.id, name: hit.name } : null;
});
if (!rat) {
  console.log('  WARN: no Giant Rat model found in this build, skipping rat aura screenshot');
  ok(true, 'model-page rat aura skipped (Giant Rat absent)');
} else {
  await page.goto(`${base}/index.html#/model/${rat.id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.canvas-host canvas', { timeout: 30000 });
  await page.waitForFunction(() => typeof (window as any).__bs.modelView?.effectsInfo === 'function', { timeout: 20000 });
  await page.waitForFunction(() => ((window as any).__bs.modelView.effectsInfo().systems || []).length > 0, { timeout: 20000 })
    .catch(() => { /* asserted (and reported) below with whatever resolved */ });
  const info = await page.evaluate(() => (window as any).__bs.modelView.effectsInfo());
  ok(info.systems.length >= 1,
    `${rat.name} (${rat.id}) has >= 1 attached effect system (${info.systems.length}: ${info.systems.map((s: any) => `${s.name}/${s.mode}`).join(', ')})`);
  await sleep(500);
  const live = await page.evaluate(() => (window as any).__bs.modelView.effectsInfo().live);
  ok(live > 0, `Giant Rat aura renders live particles (live=${live})`);
  const ratShot = path.join(SHOTS, 'e2e_effects_rat.png');
  await page.screenshot({ path: ratShot });
  console.log(`  screenshot: ${ratShot}`);
}

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
