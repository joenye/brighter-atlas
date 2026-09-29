// Brighter Maps (/maps) against synthetic world data, the landing page (/) and moving between the site's pages
// (tools/map-fixture.ts pixels and records, packed the way the site serves
// them): loads the newest release, switches by slider, buttons, list search
// and script, toggles labels, switches to satellite pictures and back, keeps
// state in the URL, the bare capture view, and a phone-sized layout.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
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
// satellite pictures for the newer release: one tile at two levels (a solid
// PNG does for a picture; the browser reads the bytes, not the name)
const png = (size: number, rgba: number[]) => {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgba).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
};
// ... and the same without roofs (another colour)
for (const [set, colour] of [['sat-a', [40, 140, 70, 255]], ['sat-b', [200, 60, 50, 255]]] as const) {
  for (const level of [3, 4]) {
    await mkdir(path.join(dir, 'satellite', set, String(level)), { recursive: true });
    await writeFile(path.join(dir, 'satellite', set, String(level), '0_0.webp'), png(256, [...colour]));
  }
  await writeFile(path.join(dir, 'satellite', set, 'index.json'), JSON.stringify({ format: 1, tile: 256, levels: { 3: [0, 0], 4: [0, 0] } }));
}
// the newer release carries the game's build string and satellite pictures, the older predates both
const release = (id: string, date: string, ids: number[], build: string | null = null) => ({ id, date, label: null, build, style: 'style-a', art: { terrain, images },
  ...(build ? { satellite: 'sat-a', satelliteRoofless: 'sat-b' } : {}), rooms: ids });
await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ format: 1,
  releases: [release('aaaaaaaaaaaaaaaa', '2025-01-10T10:00:00Z', [0, 1, 3]), release('bbbbbbbbbbbbbbbb', '2025-03-02T12:00:00Z', [0, 2], '1.2.3-0123456789abcdef')],
  packs: [{ file: 'packs/2025-01-a.json', count: 2 }, { file: 'packs/latest-a.json', count: 2 }], pieces: [1, 0, 1, 0],
  sealed: { vault: { name: 'The Vault', logo: 'art/vault.png' } } }));

const { server, port } = await serve(root), site = `http://127.0.0.1:${port}`, base = `${site}/maps`;
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
  // the slider's thumb stands at the newest release (its right end), not at the left
  const thumb = await page.$eval('#world-date', (e: any) => ({ value: Number(e.value), max: Number(e.max), min: Number(e.min) }));
  assert.ok(thumb.max > thumb.min && thumb.value === thumb.max, `the slider opens at the newest release (${JSON.stringify(thumb)})`);
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
  assert.equal(await page.$$eval('input[type=checkbox]', (c) => c.filter((x) => !x.closest('[hidden]')).length), 1, 'labels is the only switch of the street map');
  assert.equal(await page.$eval('#world-labels', (c: any) => !!c.closest('.world-map')), true, 'and it sits on the map');
  // satellite: the switch in the corner shows the other view and swaps to it
  const view = () => page.evaluate(() => document.documentElement.dataset.view);
  assert.equal(await page.$eval('#world-view', (b: any) => !b.hidden && !b.disabled), true, 'the view switch is offered where there are pictures');
  assert.equal(await page.$eval('#world-view', (b) => b.textContent), 'Satellite');
  assert.equal(await page.$eval('#world-view', (b) => !!b.closest('.world-map')), true, 'and it sits on the map');
  assert.equal(await view(), 'map', 'the map is the first view');
  await page.click('#world-view');
  await page.waitForFunction(() => document.documentElement.dataset.view === 'satellite' && Number(document.documentElement.dataset.pictures) > 0);
  assert.match(await hash(), /&v=satellite/, 'satellite view in the URL');
  assert.equal(await page.$eval('#world-view', (b) => b.textContent), 'Street', 'the switch now offers the street map');
  assert.equal(await page.$eval('#world-view', (b) => b.getAttribute('aria-pressed')), 'true');
  assert.equal(await page.$eval('#world-satellite', (c: any) => c.width > 0), true, 'the pictures draw');
  // roofs: the switch shows in satellite view and swaps to the pictures without roofs
  const centre = () => page.evaluate(() => {
    const w = (window as any).__world, cam = w.camera, c = document.getElementById('world-satellite') as any;
    cam.cx = 4; cam.cy = 4; cam.scale = 40; w.satellite(true);   // map tile (4, 4): inside the fixture's picture
    return new Promise<number[]>((resolve) => setTimeout(() => {
      resolve(Array.from(c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data));
    }, 700));
  });
  assert.equal(await page.$eval('#world-roofs-switch', (e: any) => e.hidden), false, 'the roofs switch shows in satellite view');
  {
    await page.evaluate(() => { location.hash = location.hash; });
    const withRoofs = await centre();
    assert.ok(withRoofs[1] > withRoofs[0], `roofs on: the pictures with roofs (${withRoofs})`);
    await page.click('#world-roofs');
    await page.waitForFunction(() => /roofs=0/.test(location.hash), { timeout: 3000 });
    await page.waitForFunction(() => { const c = document.getElementById('world-satellite') as any; const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data; return d[0] > d[1]; }, { timeout: 5000 });
    await page.click('#world-roofs');
    await page.waitForFunction(() => !/roofs=0/.test(location.hash), { timeout: 3000 });
  }
  await page.waitForFunction(() => { const c = document.getElementById('world-view-thumb') as any; return c.width > 0; });
  // an update without pictures shows the map, and says so
  await page.click('#world-prev');
  await page.waitForFunction(() => document.documentElement.dataset.release === 'aaaaaaaaaaaaaaaa');
  // the next frame draws the map (the release shows before it redraws)
  await page.waitForFunction(() => document.documentElement.dataset.view === 'map', { timeout: 5000 });
  assert.equal(await view(), 'map', 'no pictures: the map');
  assert.match(await page.$eval('#world-note', (e) => e.textContent ?? ''), /No satellite pictures/);
  assert.equal(await page.$eval('#world-view', (b: any) => b.disabled), false, 'the way back to the map stays open');
  await page.click('#world-next');
  await page.waitForFunction(() => document.documentElement.dataset.view === 'satellite');
  assert.equal(await page.$eval('#world-note', (e) => e.textContent), '', 'pictures again: nothing to say');
  assert.equal(await page.evaluate(() => (window as any).__world.satellite(false)), false, 'scripts switch the view');
  await page.waitForFunction(() => document.documentElement.dataset.view === 'map');
  assert.equal(await page.$eval('#world-roofs-switch', (e: any) => e.hidden), true, 'the roofs switch is for satellite pictures only');
  assert.doesNotMatch(await hash(), /v=satellite/, 'the map view keeps the URL short');
  // a finger whose lift never reaches the map (it came up over a control)
  // must not turn the next one-finger drag into a pinch
  const drag = await page.evaluate(async () => {
    const canvas = document.getElementById('world-canvas')!, cam = (window as any).__world.camera;
    const b = canvas.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
    const fire = (target: EventTarget, type: string, id: number, cx: number, cy: number, primary: boolean) =>
      target.dispatchEvent(new (window as any).PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: primary, clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 0 }));
    // a pinch: two fingers down, the second lifted over a control, the first lifted on the map
    fire(canvas, 'pointerdown', 11, x - 50, y, true);
    fire(canvas, 'pointerdown', 12, x + 50, y, false);
    fire(canvas, 'pointermove', 12, x + 80, y, false);
    fire(document.querySelector('.wmap-labels')!, 'pointerup', 12, x + 80, y, false);
    fire(canvas, 'pointerup', 11, x - 50, y, true);
    // then one finger drags 100 px to the left
    const before = { cx: cam.cx, scale: cam.scale };
    fire(canvas, 'pointerdown', 13, x, y, true);
    for (let k = 1; k <= 10; k++) fire(canvas, 'pointermove', 13, x - k * 10, y, true);
    fire(canvas, 'pointerup', 13, x - 100, y, true);
    return { scaleKept: cam.scale === before.scale, moved: cam.cx - before.cx, expected: 100 / cam.scale };
  });
  assert.equal(drag.scaleKept, true, 'a one-finger drag after a pinch does not zoom');
  assert.ok(Math.abs(drag.moved - drag.expected) < 1e-6, `and it pans with the finger (${drag.moved} vs ${drag.expected})`);
  // touch zooms as on a street map: double tap in, double tap and slide,
  // two-finger tap out; and the zoom buttons
  const touch = (steps: string) => page.evaluate(async (steps: string) => {
    const canvas = document.getElementById('world-canvas')!, cam = (window as any).__world.camera;
    const b = canvas.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
    const fire = (type: string, id: number, dx: number, dy: number, primary: boolean) =>
      canvas.dispatchEvent(new (window as any).PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: primary, clientX: x + dx, clientY: y + dy, bubbles: true, cancelable: true, button: 0 }));
    (window as any).__world.fit();
    cam.scale = Math.sqrt(cam.scale * 0.5 * 512);   // well inside the zoom limits (half the fitted zoom to 512)
    const before = cam.scale;
    const settle = () => new Promise((r) => setTimeout(r, 400));   // the animated zooms
    if (steps === 'double') { for (const id of [21, 22]) { fire('pointerdown', id, 0, 0, true); fire('pointerup', id, 0, 0, true); } await settle(); }
    if (steps === 'slide') {
      fire('pointerdown', 23, 0, 0, true); fire('pointerup', 23, 0, 0, true); fire('pointerdown', 24, 0, 0, true);
      for (let k = 1; k <= 10; k++) fire('pointermove', 24, 0, k * 10, true);
      fire('pointerup', 24, 0, 100, true);
    }
    if (steps === 'two') { fire('pointerdown', 25, -40, 0, true); fire('pointerdown', 26, 40, 0, false); fire('pointerup', 26, 40, 0, false); fire('pointerup', 25, -40, 0, true); await settle(); }
    if (steps === 'in' || steps === 'out') { (document.getElementById(`world-zoom-${steps}`) as any).click(); await settle(); }
    return cam.scale / before;
  }, steps);
  const near = (a: number, b: number) => Math.abs(a / b - 1) < 1e-3;
  await new Promise((r) => setTimeout(r, 400));
  const doubled = await touch('double');
  assert.ok(near(doubled, 2), `a double tap zooms in (${doubled})`);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(near(await touch('slide'), Math.E), 'double tap and slide down zooms in with the slide');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(near(await touch('two'), 0.5), 'a two-finger tap zooms out');
  assert.ok(near(await touch('in'), 2), 'the plus button zooms in');
  assert.ok(near(await touch('out'), 0.5), 'the minus button zooms out');
  assert.equal(await page.$eval('.wmap-zoom', (e) => !!e.closest('.world-map')), true, 'the zoom buttons sit on the map');
  // zooming out stops once the whole world fills half the view (it used to go on until the world was a dot)
  const floor = await page.evaluate(async () => {
    const w = (window as any).__world, cam = w.camera;
    w.fit(); const fitted = cam.scale;
    for (let k = 0; k < 5; k++) { (document.getElementById('world-zoom-out') as any).click(); await new Promise((r) => setTimeout(r, 400)); }
    const out = cam.scale;
    for (let k = 0; k < 5; k++) (document.getElementById('world-canvas') as any).dispatchEvent(new (window as any).WheelEvent('wheel', { deltaY: 500, clientX: 200, clientY: 200, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 400));
    const wheeled = cam.scale;
    w.fit();
    return { out: out / fitted, wheeled: wheeled / fitted };
  });
  assert.ok(near(floor.out, 0.5), `five steps out stop at half the fitted zoom (${floor.out.toFixed(3)})`);
  assert.ok(near(floor.wheeled, 0.5), `and so does the wheel (${floor.wheeled.toFixed(3)})`);
  // taps never select text: not the page, not right after a touch on the map
  assert.deepEqual(await page.evaluate(() => ['.world', '.world-map', '#topbar', '.world-toolbar'].map((q) => getComputedStyle(document.querySelector(q)!).userSelect)),
    ['none', 'none', 'none', 'none'], 'the map page does not select text');
  assert.equal(await page.$eval('#world-search', (e) => getComputedStyle(e).userSelect), 'text', 'the search field still does');
  assert.equal(await page.evaluate(() => {
    const canvas = document.getElementById('world-canvas')!;
    const fire = (type: string) => canvas.dispatchEvent(new (window as any).PointerEvent(type, { pointerId: 31, pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 50, bubbles: true }));
    fire('pointerdown'); fire('pointerup');
    const start = new Event('selectstart', { bubbles: true, cancelable: true });
    document.getElementById('world-status')!.dispatchEvent(start);
    return start.defaultPrevented;
  }), true, 'a selection starting just after a touch on the map is stopped');
  assert.deepEqual(await page.evaluate(() => ['touchstart', 'touchend', 'contextmenu'].map((type) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    document.getElementById('world-canvas')!.dispatchEvent(e);
    return e.defaultPrevented;
  })), [true, true, true], 'the browser runs no gestures of its own on the map (no magnifier, no menu)');
  // Maps picked in the switch (the brand) returns to the latest update without leaving the page
  await page.evaluate(() => (window as any).__world.show('aaaa'));
  await page.click('#topbar .tool-switch-btn');
  await page.click('.tool-switch-menu a.on');
  await page.waitForFunction(() => document.documentElement.dataset.release === 'bbbbbbbbbbbbbbbb');
  assert.equal(await page.evaluate(() => location.pathname), '/maps', 'still the world map');
  // a script drives it (time-lapse capture)
  assert.deepEqual(await page.evaluate(() => (window as any).__world.releases().map((r: any) => r.id)), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
  assert.deepEqual(await page.evaluate(() => (window as any).__world.releases().map((r: any) => r.build)), [null, '1.2.3-0123456789abcdef'], 'scripts see each build string');
  assert.equal(await page.evaluate(() => (window as any).__world.show('aaaa')), true);
  assert.equal(await release(), 'aaaaaaaaaaaaaaaa');
  // a satellite link opens on the pictures
  await page.goto(`${base}#r=bbbb&v=satellite`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.documentElement.dataset.view === 'satellite' && Number(document.documentElement.dataset.pictures) > 0);
  // the URL restores it all, and ui=0 leaves the map alone; a date picks the update in force
  await page.goto(`${base}#r=2025-02-20&l=0&ui=0`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.documentElement.dataset.release === 'aaaaaaaaaaaaaaaa');
  assert.equal(await page.$eval('#world-labels', (e) => (e as any).checked), false);
  assert.equal(await page.$eval('.world-toolbar', (e) => getComputedStyle(e).display), 'none', 'capture view hides the controls');
  assert.equal(await page.$eval('#topbar', (e) => getComputedStyle(e).display), 'none', 'and the top bar');
  assert.equal(await page.$eval('.wmap-corner', (e) => getComputedStyle(e).display), 'none', 'and the map switches');
  assert.equal(await page.$eval('.wmap-zoom', (e) => getComputedStyle(e).display), 'none', 'and the zoom buttons');
  // the map is drawn: both rooms' terrain
  await page.waitForFunction(() => document.documentElement.dataset.tiles === '32');
  // the app's own look: its stylesheet and top bar
  assert.equal(await page.$$eval('link[rel=stylesheet]', (l) => l.map((x) => x.getAttribute('href'))).then((h) => h.includes('/css/app.css')), true, 'uses the app stylesheet');
  // a phone: nothing wider than the screen, controls reachable
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!document.documentElement.dataset.release);
  const overflow = await page.evaluate(() => [...document.querySelectorAll('#topbar, #topbar *, .world-toolbar, .world-toolbar *, .map-status')]
    .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => e.className || e.tagName));
  assert.deepEqual(overflow, [], 'no control runs past a phone screen');
  // links from before the tools had addresses of their own (they name the landing page): a viewer route goes
  // to the viewer, a place on the map to the map, whole
  await page.goto(`${site}/#/mesh/3`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => location.pathname === '/data');
  assert.equal(await page.evaluate(() => location.hash), '#/mesh/3', 'an old deep link keeps its route');
  await page.goto(`${site}/?data=data#/map/0`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => location.pathname === '/data');
  assert.equal(await page.evaluate(() => location.search + location.hash), '?data=data#/map/0', 'and its data folder');
  await page.goto(`${site}/#r=2025-02-20&l=0`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => location.pathname === '/maps');
  await page.waitForFunction(() => document.documentElement.dataset.release === 'aaaaaaaaaaaaaaaa');   // (the place it named: the update of 20-Feb)
  // the landing page names each tool and links to it, and shows the version like every top bar
  await page.goto(`${site}/`, { waitUntil: 'networkidle0' });
  assert.deepEqual(await page.$$eval('.home-tool', (a) => a.map((x) => x.getAttribute('href'))), ['/fashion', '/maps', '/data'], 'the landing page links every tool, Fashion first');
  assert.equal(await page.$eval('.home-steam', (a) => `${a.getAttribute('href')} ${a.getAttribute('target')}`), 'https://store.steampowered.com/app/2791440/Brighter_Shores/ _blank', 'and the game on Steam, in a new tab');
  assert.equal(await page.$eval('.tool-switch-news', (b) => b.textContent), "What's new · dev build", 'the landing page has the version in its switch');
  // on a phone the three stacked cards run past the screen: the page scrolls (the tools' pages never do)
  const viewport = page.viewport();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  // (a swipe, as a finger: a script may scroll a page that fingers cannot)
  await page.touchscreen.touchStart(200, 700); await page.touchscreen.touchMove(200, 150); await page.touchscreen.touchEnd();
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(await page.evaluate(() => document.querySelector('.home')!.scrollTop > 200), 'the landing page scrolls on a phone');
  await page.setViewport({ ...viewport!, isMobile: false, hasTouch: false });
  await page.goto(base, { waitUntil: 'networkidle0' });
  // every top bar: the mark, the tool's name, its switch and the version (What's new)
  assert.equal(await page.$eval('#topbar .brand-mark', (i) => i.getAttribute('src')), '/brand/mark.svg', 'the mark');
  assert.equal(await page.$eval('.tool-switch-news', (b) => b.textContent), "What's new · dev build", 'the version, in the switch');
  assert.equal(await page.$eval('#topbar .brand-sub', (e) => e.textContent), 'maps', 'Brighter Maps');
  // the top bar's tool switch: every tool (this one marked) and the landing page
  await page.click('#topbar .tool-switch-btn');
  assert.deepEqual(await page.$$eval('.tool-switch-menu:not([hidden]) a', (a) => a.map((x) => x.getAttribute('href'))), ['/', '/fashion', '/maps', '/data', 'https://brightershoreswiki.org'], 'the switch leads with Home, then every tool, then the game\'s wiki');
  assert.equal(await page.$eval('.tool-switch-menu a[href^="https://brightershoreswiki"]', (a) => a.getAttribute('target') + ' ' + a.getAttribute('rel')), '_blank noopener noreferrer', 'the wiki opens in a new tab');
  assert.equal(await page.$eval('.tool-switch-home', (a) => a.textContent), 'Home', 'the landing page is Home');
  assert.equal(await page.$eval('.tool-switch-menu a[aria-current=page]', (a) => a.getAttribute('href')), '/maps', 'this one marked');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.tool-switch-menu', (m) => (m as any).hidden), true, 'Escape closes it');
  // one page for the whole site: tools open from the switch without a page load, keep their place, and the
  // browser's back and forward move between them
  await page.evaluate(() => { (window as any).__onePage = true; });
  const pick = async (href: string) => {
    await page.click('#topbar .tool-switch-btn');
    await page.click(`.tool-switch-menu a[href="${href}"]`);
  };
  const mapHash = await page.evaluate(() => location.hash);
  await pick('/data');
  await page.waitForFunction(() => location.pathname === '/data' && document.title === 'Brighter Data');
  await page.waitForFunction(() => !!(window as any).__bs?.app && !!document.querySelector('.ob-drop, .cat-tab'));
  await pick('/');
  await page.waitForFunction(() => location.pathname === '/' && !!document.querySelector('.home-tool'));
  await page.click('.home-tool[data-tool=maps]');
  await page.waitForFunction(() => location.pathname === '/maps');
  assert.equal(await page.evaluate(() => location.hash), mapHash, 'Maps opened again as it was left');
  await page.goBack(); await page.waitForFunction(() => location.pathname === '/');
  await page.goBack(); await page.waitForFunction(() => location.pathname === '/data');
  await page.goForward(); await page.waitForFunction(() => location.pathname === '/');
  assert.equal(await page.evaluate(() => (window as any).__onePage), true, 'no page loaded between them');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet]')].filter((l: any) => l.sheet && !l.sheet.disabled).map((l) => l.getAttribute('href')).sort().join()), '/css/app.css,/css/home.css', 'only the page\'s own stylesheet is on');
  // where memory is short (a phone), a tool that draws with the GPU is let go when another page shows (two
  // kept at once are more than a phone's browser allows a page: it throws the page away and loads it again),
  // and opened afresh on coming back, still without a page load
  {
    const phone = await browser.newPage();
    await phone.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await phone.evaluateOnNewDocument(() => {
      const all: any[] = (window as any).__gl = [];
      const proto = (window as any).HTMLCanvasElement.prototype, get = proto.getContext;
      proto.getContext = function (this: any, type: string, o: any) { const c = get.call(this, type, o); if (c && /webgl/.test(type) && !all.includes(c)) all.push(c); return c; };
    });
    phone.on('pageerror', (e) => errors.push(String(e)));
    await phone.goto(base, { waitUntil: 'networkidle0' });
    await phone.waitForFunction(() => !!document.documentElement.dataset.release && !document.querySelector('.page-load'));
    await phone.evaluate(() => { (window as any).__onePage = true; });
    const live = () => phone.evaluate(() => (window as any).__gl.filter((g: any) => !g.isContextLost()).length);
    assert.ok(await live() > 0, 'the map draws with the GPU');
    await phone.evaluate(() => { const w = window as any; w.history.pushState(null, '', '/'); w.dispatchEvent(new w.PopStateEvent('popstate')); });
    await phone.waitForFunction(() => !!document.querySelector('.home-tool'));
    assert.equal(await phone.$('[data-page=maps]'), null, 'on a phone, Maps leaves the page when another shows');
    assert.equal(await live(), 0, 'and its GPU contexts are freed');
    await phone.goBack();
    await phone.waitForFunction(() => location.pathname === '/maps' && !!document.querySelector('[data-page=maps]') && !document.querySelector('.page-load'));
    await phone.waitForFunction(() => Number(document.documentElement.dataset.tiles) > 0);
    assert.ok(await live() > 0, 'coming back draws the map again');
    assert.equal(await phone.evaluate(() => (window as any).__onePage), true, 'without a page load');
    await phone.close();
  }
  // the landing page's own stylesheet is in before the first paint (never drawn unstyled, then moved)
  assert.ok(/<link rel="stylesheet" href="\/css\/home.css">/.test(await (await fetch(`${site}/`)).text()), 'the landing page\'s stylesheet is linked by the page itself');
  // the tools' old addresses move to their paths, their query and hash kept
  await page.goto(`${site}/viewer.html?data=data#/map/0`, { waitUntil: 'networkidle0' });
  assert.equal(await page.evaluate(() => location.pathname + location.search + location.hash), '/data?data=data#/map/0', 'an old viewer address');
  await page.goto(`${site}/data`, { waitUntil: 'networkidle0' });
  assert.deepEqual(await page.$$eval('.tool-switch-menu button', (b) => b.map((x) => x.textContent)), ['Help & FAQs', "What's new · dev build"], 'the viewer\'s switch has its Help and the version');
  assert.equal(await page.$eval('#topbar .brand-sub', (e) => e.textContent), 'data', 'Brighter Data');
  assert.deepEqual(errors.filter((e) => !/404|Failed to load resource/.test(e)), [], 'no page errors');
  console.log('world map: all checks passed');
} finally {
  await browser.close(); server.close(); await cleanup();
}
