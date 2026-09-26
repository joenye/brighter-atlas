// The world map (index.html, the site's home page) against synthetic world data
// (tools/map-fixture.ts pixels and records, packed the way the site serves
// them): loads the newest release, switches by slider, buttons, list search
// and script, toggles labels, keeps state in the URL, the bare
// capture view, and a phone-sized layout.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { mapFixture } from './map-fixture.ts';
import { shimWebroot, requireBuild } from './env.ts';
import { serve } from './serve.ts';
import { CHROME, GL_ARGS } from './chrome.ts';
requireBuild('world');

// ---- synthetic world-data: two releases, the second recolours a room
const { root, cleanup } = await shimWebroot('atlas-world-'), fixture = mapFixture();
const dir = path.join(root, 'world-data');
for (const d of ['packs', 'styles', 'art']) await mkdir(path.join(dir, d), { recursive: true });
const art = async (name: string, bitmap: { width: number; height: number; rgba: number[] }) => {
  const head = Buffer.alloc(12); head.write('BAIM', 0); head.writeUInt32LE(bitmap.width, 4); head.writeUInt32LE(bitmap.height, 8);
  await writeFile(path.join(dir, 'art', `${name}.bin`), deflateSync(Buffer.concat([head, Buffer.from(bitmap.rgba)])));
  return name;
};
const images = Object.fromEntries(await Promise.all(Object.entries(fixture.doc.images).map(async ([k, v]) => [k, await art(`img-${k}`, v as any)])));
const terrain = [await art('terrain-0', fixture.doc.terrainMips[0] as any)];
const { rooms, shingles, ...style } = fixture.doc.scene as any;
await writeFile(path.join(dir, 'styles', 'style-a.json'), JSON.stringify({ format: 1, ...style }));
const piece = (i: number, colors?: number[][]) => {
  const { room: _r, owner: _o, ...room } = rooms[i];
  const s = shingles[i];
  return { room: { ...room, ...(colors ? { colors } : {}) },
    shingles: [s.position[0], s.position[1], colors ? 0x03e0 : s.base555, ...s.corners555, ...s.tiles] };
};
const pieces = [piece(0), piece(1), piece(1, Array(4).fill([.2, .8, .3, 1]))];
await writeFile(path.join(dir, 'packs', 'latest-a.json'), JSON.stringify({ format: 1, pieces: [[0, pieces[0]], [2, pieces[2]]] }));
// the first release also has a sealed area: a silhouette of whole tiles only
await writeFile(path.join(dir, 'packs', '2025-01-a.json'), JSON.stringify({ format: 1, pieces: [[1, pieces[1]], [3, { sealed: 'vault', cells: [10, 0, 11, 0, 10, 1, 11, 1] }]] }));
await writeFile(path.join(dir, 'art', 'vault.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
// the newer release carries the game's build string, the older predates it
const release = (id: string, date: string, ids: number[], build: string | null = null) => ({ id, date, label: null, build, style: 'style-a', art: { terrain, images }, rooms: ids });
await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ format: 1,
  releases: [release('aaaaaaaaaaaaaaaa', '2025-01-10T10:00:00Z', [0, 1, 3]), release('bbbbbbbbbbbbbbbb', '2025-03-02T12:00:00Z', [0, 2], '1.2.3-0123456789abcdef')],
  packs: [{ file: 'packs/2025-01-a.json', count: 2 }, { file: 'packs/latest-a.json', count: 2 }], pieces: [1, 0, 1, 0],
  sealed: { vault: { name: 'The Vault', logo: 'art/vault.png' } } }));

const { server, port } = await serve(root), site = `http://127.0.0.1:${port}`, base = `${site}/`;
const browser = await puppeteer.launch({ executablePath: CHROME!, headless: true, args: ['--no-sandbox', ...GL_ARGS] });
try {
  const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', (e) => errors.push((e as Error).message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const release = () => page.evaluate(() => document.documentElement.dataset.release ?? null);
  const status = () => page.$eval('#world-status', (e) => e.textContent);
  const hash = () => page.evaluate(() => new Promise<string>((r) => setTimeout(() => r(location.hash), 400)));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.documentElement.dataset.release === 'bbbbbbbbbbbbbbbb');
  assert.equal(await page.$eval('#world-release', (e) => e.textContent), '02-Mar-2025 12:00 UTC (v1.2.3)', 'opens on the newest release, named by its game version');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.rooms), '2');
  assert.match(await hash(), /^#r=bbbbbbbbbbbbbbbb&c=/, 'the release and camera are in the URL');
  assert.equal(await page.$$eval('#world-ticks span:not(.year)', (s) => s.length), 2, 'one tick per release');
  // previous button: the older release comes from its own pack
  assert.equal(await page.$$eval('.sealed-badge', (b) => b.length), 0, 'no sealed area in the newest release');
  await page.click('#world-prev');
  await page.waitForFunction(() => document.documentElement.dataset.release === 'aaaaaaaaaaaaaaaa');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.rooms), '2', 'a WIP area is not counted as a room');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.wip), 'The Vault');
  assert.equal(await status(), '', 'no status text when all is well');
  assert.deepEqual(await page.$$eval('.sealed-badge', (b) => b.map((x) => x.textContent)), ['The VaultWIP'], 'the WIP area wears its badge');
  assert.equal(await page.$eval('#world-fog', (c: any) => c.width > 0), true, 'the fog layer draws');
  assert.equal(await page.$eval('#world-prev', (e) => (e as any).disabled), true, 'no update before the first');
  // slider: a date between the releases shows the one in force then
  await page.$eval('#world-date', (e: any) => { e.value = String(Math.round(Date.parse('2025-03-05T00:00:00Z') / 60000)); e.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => document.documentElement.dataset.release === 'bbbbbbbbbbbbbbbb');
  await page.$eval('#world-date', (e: any) => { e.value = String(Math.round(Date.parse('2025-02-01T00:00:00Z') / 60000)); e.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => document.documentElement.dataset.release === 'aaaaaaaaaaaaaaaa');
  // the list: search, pick
  await page.click('#world-release');
  assert.equal(await page.$eval('#world-picker', (e) => (e as any).hidden), false);
  assert.deepEqual(await page.$$eval('#world-list button', (b) => b.map((x) => x.firstChild?.textContent)),
    ['02-Mar-2025 12:00 UTC (v1.2.3)', '10-Jan-2025 10:00 UTC'], 'the list names each update by version where it has one');
  await page.type('#world-search', '1.2');
  assert.deepEqual(await page.$$eval('#world-list button', (b) => b.map((x) => x.firstChild?.textContent)), ['02-Mar-2025 12:00 UTC (v1.2.3)'], 'search finds an update by version');
  await page.$eval('#world-search', (e: any) => { e.value = ''; });
  await page.type('#world-search', 'mar 2025');
  assert.deepEqual(await page.$$eval('#world-list button', (b) => b.map((x) => x.firstChild?.textContent)), ['02-Mar-2025 12:00 UTC (v1.2.3)'], 'search narrows the list');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.release === 'bbbbbbbbbbbbbbbb');
  assert.equal(await page.$eval('#world-picker', (e) => (e as any).hidden), true, 'picking closes the list');
  // toggles are kept in the URL
  await page.click('#world-labels');
  assert.match(await hash(), /&l=0$/, 'labels off in the URL');
  assert.equal(await page.$$eval('input[type=checkbox]', (c) => c.length), 1, 'labels is the only switch');
  assert.equal(await page.$eval('#world-labels', (c: any) => !!c.closest('.world-map')), true, 'and it sits on the map');
  // the brand returns to the latest update without leaving the page
  await page.evaluate(() => (window as any).__world.show('aaaa'));
  await page.click('#world-home');
  await page.waitForFunction(() => document.documentElement.dataset.release === 'bbbbbbbbbbbbbbbb');
  assert.equal(await page.evaluate(() => location.pathname), '/', 'still the world map');
  // a script drives it (time-lapse capture)
  assert.deepEqual(await page.evaluate(() => (window as any).__world.releases().map((r: any) => r.id)), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
  assert.deepEqual(await page.evaluate(() => (window as any).__world.releases().map((r: any) => r.build)), [null, '1.2.3-0123456789abcdef'], 'scripts see each build string');
  assert.equal(await page.evaluate(() => (window as any).__world.show('aaaa')), true);
  assert.equal(await release(), 'aaaaaaaaaaaaaaaa');
  // the URL restores it all, and ui=0 leaves the map alone; a date picks the update in force
  await page.goto(`${base}#r=2025-02-20&l=0&ui=0`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.documentElement.dataset.release === 'aaaaaaaaaaaaaaaa');
  assert.equal(await page.$eval('#world-labels', (e) => (e as any).checked), false);
  assert.equal(await page.$eval('.world-toolbar', (e) => getComputedStyle(e).display), 'none', 'capture view hides the controls');
  assert.equal(await page.$eval('#topbar', (e) => getComputedStyle(e).display), 'none', 'and the top bar');
  // the map is drawn: both rooms' terrain
  await page.waitForFunction(() => document.documentElement.dataset.tiles === '32');
  // the app's own look: its stylesheet and top bar
  assert.equal(await page.$$eval('link[rel=stylesheet]', (l) => l.map((x) => x.getAttribute('href'))).then((h) => h.includes('css/app.css')), true, 'uses the app stylesheet');
  // a phone: nothing wider than the screen, controls reachable
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!document.documentElement.dataset.release);
  const overflow = await page.evaluate(() => [...document.querySelectorAll('#topbar, #topbar *, .world-toolbar, .world-toolbar *, .map-status')]
    .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => e.className || e.tagName));
  assert.deepEqual(overflow, [], 'no control runs past a phone screen');
  // links from before the site opened on the map belong to the viewer: sent on whole
  await page.goto(`${site}/#/mesh/3`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => location.pathname === '/viewer');
  assert.equal(await page.evaluate(() => location.hash), '#/mesh/3', 'an old deep link keeps its route');
  await page.goto(`${site}/?data=data#/map/0`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => location.pathname === '/viewer');
  assert.equal(await page.evaluate(() => location.search + location.hash), '?data=data#/map/0', 'and its data folder');
  // the two pages link to each other
  await page.goto(base, { waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#topbar .top-world', (a) => a.getAttribute('href')), 'viewer', 'the map links to the viewer');
  await page.goto(`${site}/viewer`, { waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#topbar .top-world', (a) => a.getAttribute('href')), './', 'the viewer links to the map');
  assert.deepEqual(errors.filter((e) => !/404|Failed to load resource/.test(e)), [], 'no page errors');
  console.log('world map: all checks passed');
} finally {
  await browser.close(); server.close(); await cleanup();
}
