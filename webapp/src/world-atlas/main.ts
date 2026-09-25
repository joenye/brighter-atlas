// The world map (index.html: the site's home page): the 2D map of every
// game release, no game files needed. Pick a release from the list or slide
// through the dates; the camera stays put so the world can be watched
// changing. The state lives in the URL hash (#r=<release id or YYYY-MM-DD>
// &c=<x>,<y>,<scale>&l=0&ui=0) and window.__world drives it
// from a script (a time-lapse capture).
import { MapRenderer } from '../viewers/maps/renderer.js';
import { attachPanZoom, fitCamera, type MapCamera } from '../viewers/maps/pan-zoom.js';
import { createWorldData, type WorldMap, type WorldRelease } from './data.js';
import { SealedLayer } from './sealed.js';
import { openWhatsNew, maybeAutoShowWhatsNew } from '../changelog.js';
import { buildVersionLabel, buildInfoReady } from '../build-info.js';

// Links from before the site opened on the world map (#/mesh/3, ?data=...)
// belong to the viewer (viewer.html, at /viewer): send them on whole.
const viewerLink = location.hash.startsWith('#/') || new URLSearchParams(location.search).has('data');
if (viewerLink) location.replace(`viewer${location.search}${location.hash}`);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('world-canvas'), host = canvas.parentElement!;
const releaseButton = $<HTMLButtonElement>('world-release'), status = $('world-status');
const slider = $<HTMLInputElement>('world-date'), ticks = $('world-ticks');
const prev = $<HTMLButtonElement>('world-prev'), next = $<HTMLButtonElement>('world-next');
const labels = $<HTMLInputElement>('world-labels');
const picker = $('world-picker'), search = $<HTMLInputElement>('world-search'), list = $('world-list');

// Safari's own pinch zoom (its gesture events) would zoom the whole page:
// the map does its own pinch, so the page never zooms
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });

const data = createWorldData();
const camera: MapCamera = { cx: 0, cy: 0, scale: 1 };
let releases: WorldRelease[] = [];
let current: WorldMap | null = null, renderer: MapRenderer | null = null;
let wanted: WorldRelease | null = null, raf = 0, prefetching = false, cameraFromUrl = false, refit = false;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateOf = (r: WorldRelease) => new Date(r.date);
const minutes = (r: WorldRelease) => Math.round(dateOf(r).getTime() / 60000);
// every update as the viewer writes dates (21-Sep-2026), with its UTC time
const releaseText = (r: WorldRelease) => {
  const d = dateOf(r), p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
};

// ---------------------------------------------------------------- drawing
// sealed areas: silhouettes under drifting fog, drawn above the map
const sealed = new SealedLayer($<HTMLCanvasElement>('world-fog'), $('world-sealed'),
  () => ({ camera, width: host.clientWidth, height: host.clientHeight, dpr: devicePixelRatio }));
function draw() {
  raf = 0;
  if (!renderer) return;
  sealed.draw();
  renderer.draw({ ...camera, width: host.clientWidth, height: host.clientHeight, dpr: devicePixelRatio, labels: labels.checked });
  const root = document.documentElement.dataset;   // for tests and scripts
  root.tiles = String(renderer.stats.terrainTiles);
}
const requestDraw = () => { if (!raf) raf = requestAnimationFrame(draw); };
function fit() {
  if (!renderer) return;
  const b = renderer.bounds(labels.checked), s = sealed.bounds();
  const x0 = Math.min(b.x, s?.x ?? Infinity), y0 = Math.min(b.y, s?.y ?? Infinity);
  const x1 = Math.max(b.x + b.width, s ? s.x + s.width : -Infinity), y1 = Math.max(b.y + b.height, s ? s.y + s.height : -Infinity);
  fitCamera(camera, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, host.clientWidth, host.clientHeight, .95);
  requestDraw(); saveState();
}
attachPanZoom(canvas, host, camera, { changed: () => { requestDraw(); saveState(); }, fit });
new ResizeObserver(requestDraw).observe(host);
labels.addEventListener('change', () => { requestDraw(); saveState(); });

// ---------------------------------------------------------------- releases
function setStatus(text: string, error = false) { status.textContent = text; status.classList.toggle('error', error); }
// A release still downloading: the map shown now stays, blurred, under a
// clear notice (the first map has nothing under it yet).
const loadingBox = $('world-loading'), loadingText = $('world-loading-text');
function showLoading(text: string | null) {
  loadingBox.hidden = !text; host.classList.toggle('loading', !!text && !!renderer);
  if (text) loadingText.textContent = text;
}
// nothing to say when all is well (the map explains itself); tests and
// scripts read the counts from the page's data attributes
function describe(map: WorldMap) {
  setStatus('');
  const root = document.documentElement.dataset;
  root.rooms = String(map.doc.scene.rooms.length);
  root.wip = map.sealed.map((a) => a.name).join(', ');
}
/** Show a release: at once when its data is here, else once it arrives (a
 *  newer request made meanwhile wins). */
async function show(release: WorldRelease): Promise<void> {
  wanted = release;
  releaseButton.textContent = releaseText(release);
  sliderLook();
  const i = releases.indexOf(release);
  prev.disabled = i <= 0; next.disabled = i >= releases.length - 1;
  const loading = !data.ready(release);
  if (loading) showLoading(`Loading ${releaseText(release)}...`);
  try {
    const map = await data.map(release);
    if (wanted !== release) return;
    current = map;
    sealed.setAreas(map.sealed);
    if (!renderer) {
      renderer = new MapRenderer(canvas, map.doc);
      renderer.setRooms(null);
      if (!cameraFromUrl) fit();
    } else renderer.setDoc(map.doc);
    if (refit) { refit = false; fit(); }
    showLoading(null); describe(map); requestDraw(); saveState();
    document.documentElement.dataset.release = release.id;
  } catch (e) {
    if (wanted === release) { showLoading(null); setStatus(`This update could not be loaded: ${(e as Error).message}`, true); }
  }
}
const nearest = (value: number) => {   // the release in force at a date: the last one on or before it
  let pick = releases[0];
  for (const r of releases) if (minutes(r) <= value) pick = r;
  return pick;
};
// the slider's look: filled to the handle, and the date in a bubble over it
const sliderBox = slider.parentElement!, bubble = $('world-bubble');
function sliderLook() {
  const lo = Number(slider.min), hi = Number(slider.max), frac = hi > lo ? (Number(slider.value) - lo) / (hi - lo) : 1;
  sliderBox.style.setProperty('--pos', `calc(9px + (100% - 18px) * ${frac})`);
  sliderBox.style.setProperty('--frac', String(frac));
  if (releases.length) bubble.textContent = releaseText(nearest(Number(slider.value)));
}
for (const e of ['pointerdown', 'touchstart']) slider.addEventListener(e, () => sliderBox.classList.add('dragging'), { passive: true });
for (const e of ['pointerup', 'pointercancel', 'touchend', 'blur']) slider.addEventListener(e, () => sliderBox.classList.remove('dragging'));
slider.addEventListener('input', sliderLook);
slider.addEventListener('input', () => {
  const r = nearest(Number(slider.value));
  if (r !== wanted) void show(r);
  if (!prefetching) { prefetching = true; void data.prefetch(); }   // scrubbing: fetch the rest of history once
});
slider.addEventListener('change', () => { if (wanted) slider.value = String(minutes(wanted)); sliderLook(); });
const step = (by: number) => {
  const i = Math.max(0, Math.min(releases.length - 1, releases.indexOf(wanted!) + by));
  slider.value = String(minutes(releases[i])); void show(releases[i]);
};
prev.addEventListener('click', () => step(-1));
next.addEventListener('click', () => step(1));

function buildTicks() {
  const lo = minutes(releases[0]), hi = minutes(releases.at(-1)!), span = Math.max(1, hi - lo);
  slider.min = String(lo); slider.max = String(hi);
  const frag = document.createDocumentFragment();
  for (const r of releases) {
    const t = document.createElement('span');
    t.style.left = `${((minutes(r) - lo) / span) * 100}%`;
    frag.append(t);
  }
  for (let y = dateOf(releases[0]).getUTCFullYear() + 1; y <= dateOf(releases.at(-1)!).getUTCFullYear(); y++) {
    const t = document.createElement('span'); t.className = 'year'; t.dataset.year = String(y);
    t.style.left = `${((Date.UTC(y, 0, 1) / 60000 - lo) / span) * 100}%`;
    frag.append(t);
  }
  ticks.replaceChildren(frag);
}

// ---------------------------------------------------------------- picker
function renderList() {
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  const items = [...releases].reverse().filter((r) => {
    const text = `${releaseText(r)} ${r.label ?? ''} ${r.date.slice(0, 10)} ${r.id}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  list.replaceChildren(...(items.length ? items.map((r) => {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; if (r === wanted) b.classList.add('current');
    const when = document.createElement('span'); when.className = 'when'; when.textContent = r.id.slice(0, 8);
    b.append(releaseText(r), when);
    b.addEventListener('click', () => { closePicker(); slider.value = String(minutes(r)); void show(r); });
    li.append(b); return li;
  }) : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No update matches.' })]));
}
function openPicker() { picker.hidden = false; search.value = ''; renderList(); search.focus(); list.querySelector('.current')?.scrollIntoView({ block: 'center' }); }
function closePicker() { picker.hidden = true; releaseButton.focus(); }
releaseButton.addEventListener('click', openPicker);
$('world-picker-close').addEventListener('click', closePicker);
picker.addEventListener('click', (e) => { if (e.target === picker) closePicker(); });
picker.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });
search.addEventListener('input', renderList);
search.addEventListener('keydown', (e) => {
  // Enter picks the first match; without preventDefault the same key press
  // would then click the release button that gets the focus back
  if (e.key === 'Enter') { e.preventDefault(); (list.querySelector('button') as HTMLButtonElement | null)?.click(); }
});

// ---------------------------------------------------------------- URL state
let saveTimer = 0;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (!wanted) return;
    const parts = [`r=${wanted.id}`, `c=${camera.cx.toFixed(2)},${camera.cy.toFixed(2)},${camera.scale.toFixed(4)}`];
    if (!labels.checked) parts.push('l=0');
    if (document.getElementById('world')!.classList.contains('bare')) parts.push('ui=0');
    history.replaceState(null, '', `#${parts.join('&')}`);
  }, 250);
}
function readState(): WorldRelease {
  const q = new URLSearchParams(location.hash.slice(1));
  labels.checked = q.get('l') !== '0';
  document.getElementById('world')!.classList.toggle('bare', q.get('ui') === '0');
  const c = q.get('c')?.split(',').map(Number);
  if (c?.length === 3 && c.every(Number.isFinite) && c[2] > 0) { [camera.cx, camera.cy, camera.scale] = c; cameraFromUrl = true; }
  const r = q.get('r');
  if (r) {
    const byId = releases.find((x) => x.id.startsWith(r));
    if (byId) return byId;
    const t = Date.parse(r);   // a date: the update in force then
    if (Number.isFinite(t)) return nearest(Math.round(t / 60000) + 24 * 60 - 1);
  }
  return releases.at(-1)!;
}

// ---------------------------------------------------------------- top bar
// The version and "What's new", as in the viewer (one record of what was seen
// serves both pages)
const badge = document.getElementById('build-badge');
if (badge && !viewerLink) {
  const setBadge = () => { badge.textContent = buildVersionLabel(); };
  setBadge(); void buildInfoReady.then(setBadge);
  badge.title = "What's new: this release's changes";
  badge.addEventListener('click', () => { void openWhatsNew(); });
  void maybeAutoShowWhatsNew();
}
// The brand: back to the latest update and the whole world, without a reload
$('world-home').addEventListener('click', (e) => {
  if (!releases.length) return;   // not started: let the link reload the page
  e.preventDefault();
  const latest = releases.at(-1)!;
  slider.value = String(minutes(latest));
  if (!labels.checked) labels.checked = true;
  if (latest === wanted) fit(); else { cameraFromUrl = false; refit = true; void show(latest); }
});

// ---------------------------------------------------------------- start
(async () => {
  if (viewerLink) return;
  try {
    const manifest = await data.manifest();
    releases = [...manifest.releases].sort((a, b) => a.date.localeCompare(b.date));
    buildTicks();
    const start = readState();
    slider.value = String(minutes(start));
    await show(start);
  } catch (e) {
    releaseButton.textContent = 'Unavailable';
    setStatus((e as Error).message, true);
  }
})();

// A new hash (typed, or set by a script) applies at once; the page's own
// updates use replaceState, which fires no hashchange.
addEventListener('hashchange', () => {
  if (location.hash.startsWith('#/')) { location.replace(`viewer${location.search}${location.hash}`); return; }   // a viewer route
  if (!releases.length) return;
  const r = readState();
  slider.value = String(minutes(r));
  if (r !== wanted) void show(r); else { requestDraw(); saveState(); }
});

// For scripts (time-lapse capture): the releases, and show() resolving once
// the release is drawn.
(window as any).__world = {
  releases: () => releases.map((r) => ({ id: r.id, date: r.date, label: r.label })),
  async show(id: string) {
    const r = releases.find((x) => x.id === id || x.id.startsWith(id));
    if (!r) throw Error(`no release ${id}`);
    slider.value = String(minutes(r)); await show(r);
    draw(); await new Promise((resolve) => requestAnimationFrame(resolve));
    return current?.release.id === r.id;
  },
  camera,
  get current() { return current?.release.id ?? null; },
};
