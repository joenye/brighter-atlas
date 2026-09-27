// Fashion: a full-body character viewer with every piece of player equipment,
// and the client's "Design your character" screen for the body, composed
// exactly as the client composes a player (compose.ts).
import {at} from './data.js';
import * as THREE from '../../vendor/three.module.js';
import {compose, makeIndex, randomise, itemParts, hiddenItems, STYLE_CATS, COLOUR_CATS, EQUIP_SLOTS} from './compose.js';
import type {State, EquipSlot, StyleCat, ColourCat, Worn} from './compose.js';
import {Preview, FRAMES, prefetch, Thumbnailer, report} from './render.js';
import {Wardrobe, h, icon} from './wardrobe.js';
import {attachScrollbar} from './scrollbar.js';
import {linkTools} from '../sites.js';

// (failures on a phone under test, whose console is out of reach, go to a local data server's log)
addEventListener('error', e => report('page error', e.error ?? e.message));
addEventListener('unhandledrejection', e => report('unhandled rejection', e.reason));

linkTools();
const pack = await fetch(at('pack.json')).then(r => r.json());
const index = makeIndex(pack);
const SEG_STYLE: Record<string, StyleCat | null> = {hair: 'hair', face: 'face', eyes: null, jaw: 'jaw', torso: 'torso', legs: 'legs', feet: 'feet', skin: null};
const SEG_COLOUR: Record<string, ColourCat | null> = {hair: 'hair', face: null, eyes: 'eyes', jaw: null, torso: 'torso', legs: 'legs', feet: 'feet', skin: 'skin'};
const RELAXED = pack.creator.idleClip;   // the resting clip (it hides held items; the viewer can show them in hand)
// the combat-ready idle most weapons share (a shield alone stands in it too)
const DEFAULT_STANCE: number | null = (() => { const n = new Map<number, number>(); for (const i of pack.items) if (i.stance != null) n.set(i.stance, (n.get(i.stance) ?? 0) + 1); return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; })();
const app = document.getElementById('app')!;
const store = {get: (k: string) => { try { return localStorage.getItem(`fashion.${k}`) ?? localStorage.getItem(`fashion.${k}`); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(`fashion.${k}`, v); } catch {} }};

// ---- state: in the address (so any link reproduces it), remembered locally, with undo ----
const DEFAULT: State = {gender: 'male', style: {hair: 7, face: 0, jaw: 8, torso: 9, legs: 1, feet: 1}, colour: {hair: 0, eyes: 12, torso: 2, legs: 25, feet: 20, skin: 5}, equip: {}};
const encode = (s: State) => {
  const e: any = {g: s.gender === 'male' ? 0 : 1, s: STYLE_CATS.map(k => s.style[k]), c: COLOUR_CATS.map(k => s.colour[k]), e: {}};
  for (const slot of EQUIP_SLOTS) { const w = s.equip[slot]; if (w) e.e[slot] = [w.item, w.variant, w.colour ?? 0]; }
  return btoa(JSON.stringify(e)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const decode = (hash: string | null): State | null => {
  if (!hash) return null;
  try {
    const e = JSON.parse(atob(hash.replace(/-/g, '+').replace(/_/g, '/')));
    const st: State = {gender: e.g ? 'female' : 'male', style: {...DEFAULT.style}, colour: {...DEFAULT.colour}, equip: {}};
    STYLE_CATS.forEach((k, i) => { if (Number.isInteger(e.s?.[i])) st.style[k] = e.s[i]; });
    COLOUR_CATS.forEach((k, i) => { if (Number.isInteger(e.c?.[i])) st.colour[k] = e.c[i]; });
    for (const [slot, v] of Object.entries(e.e ?? {}) as any) if ((EQUIP_SLOTS as readonly string[]).includes(slot) && index.items.has(v[0])) st.equip[slot as EquipSlot] = {item: v[0], variant: v[1] | 0, colour: v[2] || null};
    return st;
  } catch { return null; }
};
// the address: the look, then ".<place>" when a place from the game stands behind it
const hashLook = () => location.hash.slice(1).split('.')[0];
// (links, saved looks and choices from before the rename name the beach by its room: East Beach)
const placeId = (p: string | null | undefined) => p === 'east-beach' ? 'beach' : p ?? null;
const hashPlace = () => placeId(location.hash.slice(1).split('.')[1]);
const linked = decode(hashLook());
const mine = decode(store.get('look'));
let state: State = linked ?? mine ?? structuredClone(DEFAULT);
const past: string[] = [], future: string[] = [];
// A link opens its look as yours; the look you had is one Undo away (no prompt to keep or go back).
if (linked && mine && encode(linked) !== encode(mine)) past.push(JSON.stringify(mine));
let lastSaved = JSON.stringify(state);
let holdUndo = false;   // the designer is one undo step: Done commits it, Cancel drops it
function commit() {
  if (holdUndo) return;
  const now = JSON.stringify(state);
  if (now === lastSaved) return;
  past.push(lastSaved); if (past.length > 200) past.shift();
  future.length = 0; lastSaved = now;
}
function undo() { const p = past.pop(); if (!p) return; future.push(lastSaved); lastSaved = p; state = JSON.parse(p); refresh(); }
function redo() { const f = future.pop(); if (!f) return; past.push(lastSaved); lastSaved = f; state = JSON.parse(f); refresh(); }
let showHeld = true;
let selected = 'hair';
let showOutfitInDesigner = false;

// ---- layout ----
const main = document.querySelector('main')!;
const toastEl = document.getElementById('toast')!;
const toast = (msg: string) => { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout((toastEl as any)._t); (toastEl as any)._t = setTimeout(() => toastEl.classList.remove('show'), 2200); };
(document.getElementById('build') as HTMLElement).textContent = `build ${pack.build.date}${pack.build.version ? ` (v${pack.build.version})` : ''}`;

// the viewer
const canvas = h('canvas', {tabindex: '0', 'aria-label': 'Your character. Drag to turn, scroll or pinch to zoom, arrow keys turn.'}) as HTMLCanvasElement;
const loading = h('div', {class: 'of-loading'}, 'Loading…');
// a place loading: a ring that fills (spins while the load cannot say how far it is), its name and how far;
// it never takes a tap, so another place (or a colour) can be picked meanwhile
const placeLoad = h('div', {class: 'of-placeload', hidden: true, role: 'status'});
placeLoad.innerHTML = '<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="pl-track" cx="22" cy="22" r="19"/><circle class="pl-fill" cx="22" cy="22" r="19"/></svg><span class="pl-name"></span><span class="pl-pct"></span>';
const plFill = placeLoad.querySelector('.pl-fill') as SVGCircleElement, plPct = placeLoad.querySelector('.pl-pct')!;
// (the character's first appearance shows it too, spinning, until the figure first draws)
let firstLook = true;
function showPlaceLoad(name: string | null) {
  if (!name && firstLook) name = 'character';
  placeLoad.hidden = !name;
  if (!name) return;
  placeLoad.querySelector('.pl-name')!.textContent = `Loading ${name}`;
  placeLoad.classList.add('spin'); plPct.textContent = ''; plFill.style.strokeDashoffset = '';
}
function placeProgress(f: number) {
  placeLoad.classList.remove('spin');
  plFill.style.strokeDashoffset = String(119.4 * (1 - f));   // (the circle's length: 2 pi 19)
  plPct.textContent = `${Math.round(f * 100)}%`;
}
let partsLoading = false, roomLoading = false;
const FRAME_KEYS = ['full', 'upper', 'face'] as const;
let currentFrame: string = 'full';
const narrow = () => matchMedia('(max-width: 860px)').matches;
const frameOf = (f: typeof FRAME_KEYS[number]) => f === 'full' && narrow() ? {dist: 6100, target: 640} : f === 'upper' && showHeld && (state.equip.weapon || state.equip.shield) ? {dist: 3900, target: 930} : FRAMES[f];
const poseBtn = h('button', {class: 'btn of-pose', onclick: () => { showHeld = !showHeld; syncControls(); }}, icon('weapon'));
let showEffects = store.get('fx') !== '0';
const fxBtn = h('button', {class: 'btn of-pose of-fx', hidden: true, title: 'Show or hide the particle effect this outfit gives off', onclick: () => { showEffects = !showEffects; store.set('fx', showEffects ? '1' : '0'); refresh(); }}, h('span', {class: 'fx-glyph', 'aria-hidden': 'true'}, '✦'));
fxBtn.setAttribute('aria-label', 'Effect');
// the one way into face and body (Male/Female and a random look are there, in Body)
const charCard = h('div', {class: 'of-charcard'},
  h('button', {class: 'btn of-design', 'aria-label': 'Character: face, body and hair', title: 'Design your character: face, body and hair', onclick: () => openCreator()}, icon('mask'), 'Character'));
// A look from someone's link is shown, not saved, until you keep it (or change it: that keeps it too).
// a link pasted into this tab: its look becomes yours (Undo brings back the one you had)
function showShared(s: State) { state = s; changed(); }
// backgrounds: the viewer's backdrop, also painted under saved pictures
const radial = (stops: string[]) => (g: CanvasRenderingContext2D, w: number, hh: number) => {
  const gr = g.createRadialGradient(w / 2, hh * 0.4, 0, w / 2, hh * 0.4, Math.max(w, hh) * 0.75);
  stops.forEach((c, i) => gr.addColorStop([0, .55, 1][i], c)); g.fillStyle = gr; g.fillRect(0, 0, w, hh);
};
const BACKDROPS = [
  {id: 'atlas', name: 'Atlas', stops: ['#1f2531', '#14171d', '#0d0f13']},
  {id: 'dusk', name: 'Dusk', stops: ['#4a3b52', '#231c2b', '#120e16']},
  {id: 'meadow', name: 'Meadow', stops: ['#6f8a5a', '#3a4d31', '#1d2618']},
  {id: 'sand', name: 'Parchment', stops: ['#e8dcc0', '#bfae8a', '#8a7a5c']},
  {id: 'studio', name: 'Studio grey', stops: ['#8a8f99', '#5b6068', '#33363c']},
  {id: 'none', name: 'Transparent', stops: [] as string[]},
  // places: a scene of the game around the character, drawn by the game's own programs (its view and what is
  // in it come with the place's data)
  {id: 'beach', name: 'Beach', stops: ['#2a3a48', '#18222c', '#0d1116'], room: {id: 8996}},
] as {id: string, name: string, stops: string[], room?: {id: number}}[];
const cssOf = (b: typeof BACKDROPS[number]) => b.stops.length ? `radial-gradient(ellipse at 50% 40%, ${b.stops[0]} 0%, ${b.stops[1]} 55%, ${b.stops[2]} 100%)` : 'repeating-conic-gradient(#2a2d33 0% 25%, #1f2227 0% 50%) 50% / 20px 20px';
let backdrop = BACKDROPS.find(b => b.room && b.id === hashPlace()) ?? BACKDROPS.find(b => b.id === placeId(store.get('bg'))) ?? BACKDROPS[0];
const addressOf = (code: string) => `#${code}${backdrop.room ? '.' + backdrop.id : ''}`;
const bgPop = h('div', {class: 'of-bgpop', hidden: true, role: 'menu'});
const bgBtn = h('button', {class: 'btn of-bgbtn', 'aria-haspopup': 'menu', 'aria-label': 'Background', title: 'Background', onclick: (e: Event) => {
  e.stopPropagation(); bgPop.hidden = !bgPop.hidden; bgBtn.setAttribute('aria-expanded', String(!bgPop.hidden));
  if (!bgPop.hidden) (bgPop.querySelector('button.on') as HTMLElement ?? bgPop.querySelector('button'))?.focus();
}}, icon('image'));
// the menu by keyboard: ↑ ↓ move, Esc closes back to its button
bgPop.addEventListener('keydown', e => {
  const items = [...bgPop.querySelectorAll('button:not(:disabled)')] as HTMLElement[], at = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); bgPop.hidden = true; bgBtn.setAttribute('aria-expanded', 'false'); bgBtn.focus(); }
});
const closeBg = (refocus: boolean) => { bgPop.hidden = true; bgBtn.setAttribute('aria-expanded', 'false'); if (refocus) bgBtn.focus(); };
const bgItem = (b: typeof BACKDROPS[number]) => h('button', {role: 'menuitemradio', 'aria-checked': 'false', 'data-bg': b.id, onclick: () => { setBackdrop(b); closeBg(true); }}, h('span', {class: `of-bgdot${b.room ? ' place' : ''}`, style: `background:${cssOf(b)}`}), b.name);
bgPop.append(h('div', {class: 'of-bghead'}, 'Colours'), ...BACKDROPS.filter(b => !b.room).map(bgItem), h('div', {class: 'of-bghead'}, 'Places in the game'), ...BACKDROPS.filter(b => b.room).map(bgItem));
// the disc under the character
const FLOORS = [['ring', 'Ring and shadow'], ['shadow', 'Shadow only'], ['none', 'None']] as const;
const floorItems = FLOORS.map(([id, name]) => h('button', {role: 'menuitemradio', 'aria-checked': 'false', 'data-floor': id,
  onclick: () => { setFloor(id); closeBg(true); }}, h('span', {class: `of-bgdot floor-${id}`}), name));
bgPop.append(h('div', {class: 'of-bghead'}, 'Ground'), ...floorItems);
function setFloor(mode: typeof FLOORS[number][0]) {
  store.set('floor', mode);
  viewer?.setFloor(mode); creatorPreview?.setFloor(mode);
  floorItems.forEach(x => { const on = x.dataset.floor === mode; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
}
document.addEventListener('click', e => { if (!bgPop.hidden && !bgPop.contains(e.target as Node) && e.target !== bgBtn && !bgBtn.contains(e.target as Node)) closeBg(false); });
// keyboard: Tab out of the menu closes it. (Only when focus lands somewhere: a tap on iOS takes focus from
// the menu without giving it to anything, and closing then would swallow the tap on the item.)
bgPop.addEventListener('focusout', e => { const to = e.relatedTarget as Node | null; if (to && !bgPop.contains(to) && to !== bgBtn) closeBg(false); });
const viewerEl = h('section', {class: 'of-viewer'}, canvas, loading, placeLoad, charCard,
  // the viewer's toggles, stacked at its side: weapons out, and the outfit's effect when it has one
  // bottom right, from the bottom: weapons out, the outfit's effect (when it has one), the background
  h('div', {class: 'of-controls'}, poseBtn, fxBtn, h('div', {class: 'of-bg'}, bgBtn, bgPop)));
// `remember`: the viewer's own pick (a shared link's place shows for the visit, not saved as theirs)
function setBackdrop(b: typeof BACKDROPS[number], remember = true) {
  // a place's sky is one flat colour, the room's fog fading into it (a gradient bands behind a room)
  backdrop = b; viewerEl.style.background = b.room ? b.stops[1] : cssOf(b);
  // the disc under the character is for the colours: a place's floor takes the character's own shadow
  floorItems.forEach(x => { (x as HTMLButtonElement).disabled = !!b.room; x.title = b.room ? 'A place shows the character’s own shadow on its ground' : ''; });
  bgPop.querySelectorAll('[data-bg]').forEach(x => { const on = (x as HTMLElement).dataset.bg === b.id; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
  if (remember) store.set('bg', b.id);
  if (!viewer) return;
  history.replaceState(null, '', addressOf(encode(state)));
  const done = () => { if (backdrop === b) { roomLoading = false; showPlaceLoad(null); } };
  roomLoading = !!b.room; showPlaceLoad(b.room ? b.name : null);
  void viewer.setRoom(b.room ?? null).then(done, () => { done(); toast(`${b.name} couldn’t be loaded`); setBackdrop(BACKDROPS[0]); });
}
const right = h('aside', {class: 'of-right', id: 'of-right'});
main.append(viewerEl, right);
viewerEl.append(toastEl);   // toasts sit where the message bar does, in the same style
// (browsers without overflow: clip: anything that scrolls the panel itself is undone at once)
right.addEventListener('scroll', () => { if (right.scrollTop) right.scrollTop = 0; });
main.addEventListener('scroll', () => { if (main.scrollTop) main.scrollTop = 0; });

// ---- the wardrobe panel collapses and resizes, like the Brighter Atlas side panels ----
// Desktop: a chevron pull-tab on its inner edge folds it to a 32px rail ( ] toggles it).
// Phones: a grab bar on the border between the character and the wardrobe; drag it to share the
// height, tap it to fold the wardrobe away to just the bar (tapping it again brings the wardrobe back).
const phone = () => matchMedia('(max-width: 860px)').matches && !matchMedia('(orientation: landscape) and (max-height: 520px)').matches;
let panelCollapsed = store.get('panel') === '1';
const panelTab = h('button', {class: 'of-panel-toggle', 'aria-controls': 'of-right', onclick: () => setPanelCollapsed(!panelCollapsed)});
const grip = h('div', {class: 'of-grip', role: 'separator', 'aria-orientation': 'horizontal', tabindex: '0',
  'aria-label': 'Drag to resize the character view, tap to fold the equipment away'}, h('span', {class: 'of-grip-bar'}), panelTab);
grip.addEventListener('keydown', e => { if (phone() && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setPanelCollapsed(!panelCollapsed); } });
right.prepend(grip);
function setPanelCollapsed(on: boolean) {
  panelCollapsed = on; store.set('panel', on ? '1' : '0');
  document.getElementById('app')!.classList.toggle('panel-collapsed', on);
  const verb = on ? 'Show' : 'Hide';
  panelTab.textContent = phone() ? (on ? '⌃' : '⌄') : (on ? '‹' : '›');
  panelTab.title = `${verb} the equipment panel${phone() ? '' : '  ( ] )'}`;
  panelTab.setAttribute('aria-label', `${verb} the equipment panel`);
  panelTab.setAttribute('aria-expanded', String(!on));
  applySplit();
}
// the phone split: the character view's share of the height, remembered
let split = Number(store.get('split')) || 0;
// (a share of the height, not pixels: iOS Safari's toolbar resizes the page, and a pixel height left the
// wardrobe squeezed to nothing, grab bar included)
function applySplit() {
  viewerEl.style.height = phone() && !panelCollapsed && split ? `${(Math.max(0.22, Math.min(0.72, split)) * 100).toFixed(1)}%` : '';
}
grip.addEventListener('pointerdown', (e: PointerEvent) => {
  if (!phone() || (e.target as HTMLElement).closest('.of-panel-toggle')) return;
  e.preventDefault(); grip.setPointerCapture(e.pointerId); grip.classList.add('dragging');
  const top = main.getBoundingClientRect().top, h0 = main.clientHeight, y0 = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (!moved && Math.abs(ev.clientY - y0) < 6) return;
    if (!moved) { moved = true; if (panelCollapsed) setPanelCollapsed(false); }
    split = Math.max(0.22, Math.min(0.74, (ev.clientY - top) / h0)); applySplit();
  };
  // a tap (no drag) folds or unfolds; a drag resizes
  const up = () => { grip.removeEventListener('pointermove', move); grip.classList.remove('dragging'); if (moved) store.set('split', String(split)); else setPanelCollapsed(!panelCollapsed); };
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up, {once: true}); grip.addEventListener('pointercancel', up, {once: true});
});
right.addEventListener('click', e => { if (panelCollapsed && (e.target as HTMLElement).closest('.slot')) setPanelCollapsed(false); }, true);
window.addEventListener('resize', () => setPanelCollapsed(panelCollapsed));
document.addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (e.key !== ']' || e.ctrlKey || e.metaKey || e.altKey || t.matches?.('input, textarea') || !(document.querySelector('.creator') as HTMLElement | null)?.hidden) return;
  e.preventDefault(); setPanelCollapsed(!panelCollapsed);
});
// iPhone and iPad Safari (not a home-screen app): its toolbar floats over the bottom of the page
if (/iP(hone|ad|od)/.test(navigator.userAgent) && !(navigator as any).standalone) document.documentElement.classList.add('ios-browser');
setPanelCollapsed(panelCollapsed);

const viewer = new Preview(canvas, {fov: 24, floor: true});
showPlaceLoad(null);   // (the character's first load)
viewer.pitch = 0.07;
viewer.frameTo(frameOf('full'), true);
viewer.onLoading = n => {
  partsLoading = !!n;
  if (!n && firstLook) { firstLook = false; if (!roomLoading) showPlaceLoad(null); }
  loading.classList.toggle('on', partsLoading && !roomLoading && !firstLook);
};
viewer.onRoomProgress = f => { if (roomLoading) placeProgress(f); };
// turning like a game's character screen: drag with inertia; wheel or pinch zooms; double-click resets
// Drag turns the character the way the finger goes (its front follows the finger); a flick keeps it
// spinning after release with the speed of the last ~100 ms of the drag, slowing gradually.
function attachTurning(el: HTMLElement, pv: Preview, zoom: boolean) {
  const pointers = new Map<number, {x: number, y: number}>();
  let drag: {samples: {t: number, yaw: number}[]} | null = null, pinch = 0;
  const K = 0.012;   // radians per pixel
  el.addEventListener('pointerdown', e => {
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); el.setPointerCapture(e.pointerId);
    if (pointers.size === 1) { drag = {samples: [{t: performance.now(), yaw: pv.yaw}]}; pv.yawVel = 0; el.classList.add('dragging'); }
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); drag = null; }
  });
  el.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId); if (!prev) return;
    const cur = {x: e.clientX, y: e.clientY}; pointers.set(e.pointerId, cur);
    if (pointers.size === 2 && zoom) {
      const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) { pv.zoomBy(pinch / d); currentFrame = ''; syncControls(); }
      pinch = d; return;
    }
    if (!drag) return;
    const now = performance.now();
    pv.yaw -= (cur.x - prev.x) * K;
    drag.samples.push({t: now, yaw: pv.yaw});
    while (drag.samples.length > 2 && now - drag.samples[0].t > 100) drag.samples.shift();
  });
  const end = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (drag && pointers.size === 0) {
      const now = performance.now(), s = drag.samples, a = s[0], b = s[s.length - 1];
      // held still before letting go: no spin; otherwise the flick's speed carries on
      pv.yawVel = now - b.t < 60 && b.t - a.t > 8 ? Math.max(-40, Math.min(40, (b.yaw - a.yaw) / ((b.t - a.t) / 1000))) : 0;
    }
    if (pointers.size === 0) { drag = null; pinch = 0; el.classList.remove('dragging'); }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
attachTurning(canvas, viewer, true);
canvas.addEventListener('wheel', e => { e.preventDefault(); viewer.zoomBy(Math.exp(e.deltaY * 0.0012)); currentFrame = ''; syncControls(); }, {passive: false});
canvas.addEventListener('dblclick', () => { viewer.yaw = 0; viewer.yawVel = 0; viewer.frameTo(frameOf('full')); currentFrame = 'full'; syncControls(); });
canvas.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') viewer.yawVel += 1.6; else if (e.key === 'ArrowRight') viewer.yawVel -= 1.6; });

// the wardrobe
const slots = [...pack.slotOrder.filter((s: string) => (EQUIP_SLOTS as readonly string[]).includes(s)), 'cape', 'weapon'] as EquipSlot[];
const wardHeader = h('div', {class: 'of-wardhead'},
  // phones: the way into face and body leads the slot view (the viewer's own button is for wider screens)
  h('button', {class: 'btn of-designer', title: 'Design your character: face, body and hair', onclick: () => openCreator()}, icon('mask'), 'Character'),
  h('h2', {}, 'Equipment'),
  h('span', {class: 'of-wardactions'},
    h('button', {class: 'btn-mini', title: 'Put on something random in most slots', onclick: () => randomOutfit()}, icon('dice'), h('span', {class: 'of-long'}, 'Random outfit'), h('span', {class: 'of-short'}, 'Random')),
    h('button', {class: 'btn-mini', title: 'Unequip everything', onclick: () => { state.equip = {}; edited(); }}, icon('x'), 'Unequip all')));
const thumbs = new Thumbnailer();
const wardrobe = new Wardrobe(right, pack, slots, {
  equip: (slot, w) => {
    if (w) state.equip[slot] = w; else delete state.equip[slot];
    // a two-handed weapon (the game's "Melee 2h" category) leaves no hand for a shield
    if (w && slot === 'weapon' && twoHanded(w) && state.equip.shield) { delete state.equip.shield; toast('Two-handed weapon: the shield comes off'); }
    else if (w && slot === 'shield' && state.equip.weapon && twoHanded(state.equip.weapon)) { delete state.equip.weapon; toast('A shield needs a free hand: the two-handed weapon comes off'); }
    if (w && (slot === 'weapon' || slot === 'shield')) { showHeld = true; if (Math.abs(viewer.yaw) < 0.2) viewer.turnTo(slot === 'weapon' ? -0.7 : 0.7); }   // trying one on: show it in hand, turned so it isn't edge-on
    edited();
  },
  equipMany: (changes) => { for (const [s, w] of Object.entries(changes)) { if (w) state.equip[s as EquipSlot] = w; else delete state.equip[s as EquipSlot]; } edited(); },
  preview: (slot, w) => prefetch(compose(pack, index, {...state, equip: {...state.equip, [slot]: w}})),
  thumb: (slot, w) => thumbs.thumb(`${w.item}/${w.variant}/${w.colour ?? 0}/${state.gender}`, itemParts(pack, index, w, state.gender, state), pack.skeleton),
}, wardHeader);

// ---- the designer: face and body, as a Brighter Atlas dialog (the character, and a panel of choices) ----
// Same data and rules as the game's "Design your character" screen, in the
// site's own look: parts as tabs, a style stepper, the part's colours.
const creatorEl = h('div', {class: 'creator', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Design your character', hidden: true});
const cCanvas = h('canvas', {'aria-label': 'Preview: drag to turn'}) as HTMLCanvasElement;
const panel = h('div', {class: 'creator-panel'});
const cGrip = h('div', {class: 'of-grip creator-grip', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Drag to resize the character view'}, h('span', {class: 'of-grip-bar'}));
let autoZoom = store.get('autozoom') !== '0';   // on unless turned off (a new key: the old Close-up setting, off by default, is not carried over)
const zoomToggle = h('label', {class: 'of-check', 'data-short': 'Auto-Zoom', title: 'Frame the part you are choosing: the head for hair, face, eyes and jaw, the body for torso, legs and feet'},
  h('input', {type: 'checkbox', checked: autoZoom, onchange: (e: Event) => { autoZoom = (e.target as HTMLInputElement).checked; store.set('autozoom', autoZoom ? '1' : '0'); frameCreator(); }}), h('span', {}, 'Auto-Zoom'));
const outfitToggle = h('label', {class: 'of-check', 'data-short': 'Outfit', title: 'Show your equipment over the body (it covers clothes and hair you are designing)'},
  h('input', {type: 'checkbox', onchange: (e: Event) => { showOutfitInDesigner = (e.target as HTMLInputElement).checked; refresh(); }}), h('span', {class: 'of-long'}, 'Show outfit'), h('span', {class: 'of-short'}, 'Outfit'));
// the designer's own controls lead its drawer (the page's top bar stays as it always is)
creatorEl.append(h('div', {class: 'creator-box'},
  h('div', {class: 'creator-bar'}, h('h2', {}, 'Design your character')),
  h('div', {class: 'creator-body'},
    h('div', {class: 'creator-stage'}, cCanvas, h('span', {class: 'stage-hint'}, 'Drag to turn')),
    cGrip,
    h('div', {class: 'creator-drawer'},
      // only Cancel and Done stay put; everything else scrolls with the choices below
      h('div', {class: 'creator-actions'}, h('span', {class: 'creator-title'}, 'Character Designer'),
        h('span', {class: 'creator-gap'}),
        h('span', {class: 'creator-end'},
          h('button', {class: 'btn', title: 'Discard these changes (Esc)', onclick: () => cancelCreator()}, 'Cancel'),
          h('button', {class: 'btn btn-cta', title: 'Keep these changes', onclick: () => closeCreator()}, 'Done'))),
      panel))));
app.append(creatorEl);
attachScrollbar(panel);
// phones: the same grab bar as the wardrobe's, sharing the height between the character and the choices
let cSplit = Number(store.get('csplit')) || 0;
const applyCSplit = () => { (creatorEl.querySelector('.creator-body') as HTMLElement).style.setProperty('--stage-h', cSplit ? `${(cSplit * 100).toFixed(1)}%` : ''); };
applyCSplit();
cGrip.addEventListener('pointerdown', (e: PointerEvent) => {
  if (!phone()) return;
  e.preventDefault(); cGrip.setPointerCapture(e.pointerId); cGrip.classList.add('dragging');
  const body = creatorEl.querySelector('.creator-body') as HTMLElement, top = body.getBoundingClientRect().top, h0 = body.clientHeight;
  const move = (ev: PointerEvent) => { cSplit = Math.max(0.2, Math.min(0.75, (ev.clientY - top) / h0)); applyCSplit(); };
  // one split for both: the page's divider follows the designer's back out
  const up = () => { cGrip.removeEventListener('pointermove', move); cGrip.classList.remove('dragging'); store.set('csplit', String(cSplit)); if (!panelCollapsed) { split = cSplit; store.set('split', String(split)); applySplit(); } };
  cGrip.addEventListener('pointermove', move); cGrip.addEventListener('pointerup', up, {once: true}); cGrip.addEventListener('pointercancel', up, {once: true});
});
const paletteFor = (seg: string): string[] | null => {
  const cat = SEG_COLOUR[seg];
  if (!cat) return null;
  if (cat === 'hair') {
    // HAIR shows the fabric colours while the head wrap is the style (as the game's screen does)
    const list = pack.creator.styles.hair[state.gender];
    const opt = list[((state.style.hair % list.length) + list.length) % list.length];
    return pack.parts[opt.parts[0]]?.r1 === '$hair_fabric' ? pack.creator.palettes.fabric : pack.creator.palettes.hair;
  }
  return pack.creator.palettes[cat];
};
const creatorPreview = new Preview(cCanvas, {fov: 18, floor: true});
creatorPreview.running = false;
attachTurning(cCanvas, creatorPreview, false);
// Auto-Zoom (on by default) frames the part being chosen; off, the whole figure
const PART_FRAME: Record<string, {dist: number, target: number}> = {
  hair: FRAMES.face, face: FRAMES.face, eyes: {dist: 1100, target: 1250}, jaw: FRAMES.face,
  torso: FRAMES.upper, legs: {dist: 3300, target: 480}, feet: {dist: 1900, target: 240}, skin: FRAMES.full,
};
function frameCreator(instant = false) {
  creatorPreview.frameTo(autoZoom ? PART_FRAME[selected] ?? FRAMES.full : FRAMES.full, instant);
  if (instant) { creatorPreview.yaw = 0.3; creatorPreview.yawVel = 0; }
}
let creatorReady: Promise<void> | null = null;
let creatorSnapshot = '';
function openCreator() {
  creatorSnapshot = JSON.stringify(state);
  // phones: the designer's divider opens where the page's is, so nothing jumps
  if (phone() && !panelCollapsed && main.clientHeight) { cSplit = viewerEl.getBoundingClientRect().height / main.clientHeight; applyCSplit(); }
  app.classList.add('designing');
  holdUndo = true;
  creatorEl.hidden = false; viewer.running = false; creatorPreview.running = true;
  creatorReady ??= creatorPreview.init(pack.skeleton, RELAXED);
  frameCreator(true);
  refresh();
  (creatorEl.querySelector('.creator-actions .btn-cta') as HTMLElement)?.focus({preventScroll: true});
}
function hideCreator() { app.classList.remove('designing'); creatorEl.hidden = true; viewer.running = true; creatorPreview.running = false; canvas.focus({preventScroll: true}); }
function closeCreator() { holdUndo = false; commit(); hideCreator(); refresh(); }
// Cancel drops the design, but keeps it one Redo away so a careful face is never lost to a stray Esc
function cancelCreator() {
  const dropped = JSON.stringify(state);
  state = JSON.parse(creatorSnapshot); holdUndo = false; hideCreator(); refresh();
  if (dropped !== lastSaved) { future.push(dropped); refresh(); toast('Changes cancelled. Redo brings them back'); }
}
const SEG_NAMES: [string, string][] = [['hair', 'Hair'], ['face', 'Face'], ['eyes', 'Eyes'], ['jaw', 'Jaw'], ['torso', 'Torso'], ['legs', 'Legs'], ['feet', 'Feet'], ['skin', 'Skin']];
const section = (title: string, value: string | null, ...body: Node[]) =>
  h('section', {class: 'cp-section'}, h('div', {class: 'cp-head'}, h('span', {}, title), value ? h('b', {}, value) : null), ...body);
function renderPanel() {
  const cat = SEG_STYLE[selected], col = SEG_COLOUR[selected];
  const pal = paletteFor(selected);
  const kids: Node[] = [
    h('div', {class: 'cp-tools'},
      h('div', {class: 'cp-row'},
        h('button', {class: 'btn cp-random', title: 'A random face, hair and clothes underneath', onclick: () => { state = randomise(pack, state); edited(); }}, icon('dice'), 'Random'),
        h('button', {class: 'btn cp-random', title: 'Back to the default character (your equipment stays)', onclick: () => { state = {...structuredClone(DEFAULT), equip: state.equip}; edited(); }}, icon('reset'), 'Start over')),
      h('div', {class: 'cp-row cp-checks'}, zoomToggle, outfitToggle)),
    section('Body', null, h('div', {class: 'cp-row'},
      h('div', {class: 'segmented cp-gender'}, ...(['male', 'female'] as const).map(g => h('button', {class: state.gender === g ? 'on' : '', 'aria-pressed': String(state.gender === g), onclick: () => { if (state.gender !== g) { state.gender = g; edited(); } }}, g === 'male' ? 'Male' : 'Female'))))),
    section('Part', null, h('div', {class: 'cp-parts', role: 'tablist'}, ...SEG_NAMES.map(([id, name]) =>
      h('button', {class: id === selected ? 'on' : '', role: 'tab', 'data-part': id, 'aria-selected': String(id === selected), onclick: () => { selected = id; frameCreator(); refreshCreator(); }}, name)))),
  ];
  if (cat) {
    const n = pack.creator.styles[cat][state.gender].length, i = ((state.style[cat] % n) + n) % n;
    kids.push(section('Style', `${i + 1} of ${n}`, h('div', {class: 'cp-step'},
      h('button', {class: 'btn cp-prev', 'aria-label': 'Previous style', onclick: () => { state.style[cat] -= 1; edited(); }}, icon('turnLeft')),
      h('input', {type: 'range', class: 'cp-range', min: '1', max: String(n), value: String(i + 1), 'aria-label': 'Style',
        oninput: (e: Event) => { state.style[cat] = Number((e.target as HTMLInputElement).value) - 1; edited(); }}),
      h('button', {class: 'btn cp-next', 'aria-label': 'Next style', onclick: () => { state.style[cat] += 1; edited(); }}, icon('turnRight')))));
  }
  if (col && pal) {
    const i = ((state.colour[col] % pal.length) + pal.length) % pal.length;
    kids.push(section('Colour', `${i + 1} of ${pal.length}`, h('div', {class: 'swatches cp-colours'}, ...pal.map((c, k) =>
      h('button', {class: `swatch${k === i ? ' on' : ''}`, 'aria-pressed': String(k === i), style: `background:${c}`, 'aria-label': `Colour ${k + 1}`, onclick: () => { state.colour[col] = k; edited(); }})))));
  }
  // only when the outfit really hides or changes this part (a helm over the hair, a jacket over the torso)
  const partKeys = (st: State) => compose(pack, index, st).filter(p => p.key.endsWith('/' + cat)).map(p => p.key).join('|');
  if (showOutfitInDesigner && cat && Object.keys(state.equip).length && partKeys(state) !== partKeys({...state, equip: {}}))
    kids.push(h('p', {class: 'creator-note'}, 'Your outfit covers this. Untick Show outfit to see it.'));
  kids.push(h('p', {class: 'creator-keys'}, 'Keys: ← → style, ↑ ↓ colour, Esc to cancel.'));
  // (keep the slider in hand while dragging it: only rebuild the rest)
  const dragging = panel.querySelector('.cp-range:active');
  if (dragging) { const r = panel.querySelector('.cp-section:has(.cp-range) .cp-head b'); if (r && cat) { const n = pack.creator.styles[cat][state.gender].length; r.textContent = `${(((state.style[cat] % n) + n) % n) + 1} of ${n}`; } return; }
  panel.replaceChildren(...kids);
}

// ---- header actions ----
const undoBtn = document.getElementById('undo') as HTMLButtonElement, redoBtn = document.getElementById('redo') as HTMLButtonElement;
undoBtn.addEventListener('click', undo); redoBtn.addEventListener('click', redo);
// ---- looks: saved on this device, each with a picture; share any as a link ----
// A look is its link code (the same one the address carries), so a saved look, a shared link and the page's
// address are one thing: saving keeps a link, wearing one puts it in the address, sharing sends it.
interface SavedLook { id: string; name: string; code: string; place: string | null; thumb: string; at: number }
const loadLooks = (): SavedLook[] => { try { const v = JSON.parse(store.get('looks') ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
let looks = loadLooks();
const saveLooks = () => { try { store.set('looks', JSON.stringify(looks)); } catch { toast('Couldn’t save: this device’s storage is full'); } };
const shareBtn = document.getElementById('share')!;
const looksEl = h('div', {class: 'of-looks', role: 'dialog', 'aria-label': 'Your looks', hidden: true});
app.append(looksEl);
const closeLooks = () => { looksEl.hidden = true; shareBtn.setAttribute('aria-expanded', 'false'); };
// it hangs from its button, whatever the bar's height (phones' is taller)
const placeLooks = () => { const top = shareBtn.getBoundingClientRect().bottom + 6; looksEl.style.top = `${top}px`; looksEl.style.maxHeight = `calc(100dvh - ${top + 10}px)`; };
shareBtn.addEventListener('click', e => { e.stopPropagation(); if (looksEl.hidden) { renderLooks(); placeLooks(); looksEl.hidden = false; shareBtn.setAttribute('aria-expanded', 'true'); } else closeLooks(); });
addEventListener('resize', () => { if (!looksEl.hidden) placeLooks(); });
document.addEventListener('click', e => { if (!looksEl.hidden && !looksEl.contains(e.target as Node)) closeLooks(); });
looksEl.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeLooks(); shareBtn.focus(); } });
function lookName(st: State) {
  const pick = (['torso', 'head', 'cape', 'weapon'] as EquipSlot[]).map(s => st.equip[s] && (index.items.get(st.equip[s]!.item) as any)?.name).filter(Boolean);
  return pick.length ? pick.slice(0, 2).join(' + ') : `${st.gender === 'male' ? 'Male' : 'Female'} character`;
}
function lookThumb(): Promise<string> {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      // the character: a square around the middle of the view, 120 px
      const side = Math.min(img.width, img.height) * 0.62, x = (img.width - side) / 2, y = img.height * 0.5 - side / 2;
      const sq = document.createElement('canvas'); sq.width = sq.height = 120;
      const g = sq.getContext('2d')!; g.fillStyle = '#14171d'; g.fillRect(0, 0, 120, 120); g.drawImage(img, x, y, side, side, 0, 0, 120, 120);
      res(sq.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => res('');
    img.src = viewer.snapshot();
  });
}
const lookUrl = (l: {code: string, place: string | null}) => `${location.origin}${location.pathname}#${l.code}${l.place ? '.' + l.place : ''}`;
async function shareUrl(url: string) {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) { try { await navigator.share({title: 'My Brighter Shores look', url}); return; } catch (e: any) { if (e?.name === 'AbortError') return; } }
  navigator.clipboard?.writeText(url).then(() => toast('Link copied: anyone with it sees this exact look'), () => toast('Copy the address bar to share this look'));
}
function renderLooks() {
  const code = encode(state), place = backdrop.room ? backdrop.id : null;
  const current = looks.find(l => l.code === code);
  const name = h('input', {class: 'lk-name', value: current?.name ?? lookName(state), 'aria-label': 'Name', maxlength: '48', enterkeyhint: 'done',
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void saveCurrent(); } }}) as HTMLInputElement;
  const saveCurrent = async () => {
    const thumb = await lookThumb(), label = name.value.trim() || lookName(state);
    if (current) Object.assign(current, {name: label, thumb, place, at: Date.now()});
    else looks.unshift({id: Math.random().toString(36).slice(2, 10), name: label, code, place, thumb, at: Date.now()});
    saveLooks(); renderLooks();
  };
  const rows = looks.map(l => {
    const on = l.code === code;
    return h('div', {class: `lk-row${on ? ' on' : ''}`},
      h('button', {class: 'lk-wear', title: on ? 'Wearing this look' : 'Wear this look', onclick: () => {
        const st = decode(l.code); if (!st) return;
        state = st; changed();
        const pl = BACKDROPS.find(b => b.room && b.id === placeId(l.place)); if (pl && pl !== backdrop) setBackdrop(pl, false);
        renderLooks();
      }}, l.thumb ? h('img', {src: l.thumb, alt: ''}) : h('span', {class: 'lk-noimg'}, icon('torso')),
        h('span', {class: 'lk-text'}, h('span', {class: 'lk-title'}, l.name), h('span', {class: 'lk-sub'}, on ? 'Wearing' : new Date(l.at).toLocaleDateString()))),
      h('button', {class: 'btn-mini of-icon', title: 'Share a link to this look', 'aria-label': `Share ${l.name}`, onclick: () => void shareUrl(lookUrl(l))}, icon('share')),
      h('button', {class: 'btn-mini of-icon', title: 'Delete this look', 'aria-label': `Delete ${l.name}`, onclick: () => { looks = looks.filter(x => x !== l); saveLooks(); renderLooks(); }}, icon('x')));
  });
  looksEl.replaceChildren(
    h('div', {class: 'lk-head'}, h('b', {}, 'This look'),
      h('button', {class: 'btn-mini', title: 'Copy a link to this exact look', onclick: () => void shareUrl(lookUrl({code, place}))}, icon('share'), 'Share link')),
    h('div', {class: 'lk-save'}, name, h('button', {class: 'btn btn-cta', onclick: () => void saveCurrent()}, current ? 'Update' : 'Save')),
    h('div', {class: 'lk-head'}, h('b', {}, `Saved looks${looks.length ? ` (${looks.length})` : ''}`)),
    looks.length ? h('div', {class: 'lk-list'}, ...rows) : h('p', {class: 'lk-empty'}, 'Looks you save appear here, on this device. Open a shared link and save it to keep it.'));
}
document.getElementById('shot')!.addEventListener('click', () => {
  const shot = new Image();
  shot.onload = () => {
    // transparent: crop to the figure (and its effect), with a margin, rather than the whole viewer
    let [sx, sy, sw, sh] = [0, 0, shot.width, shot.height];
    if (!backdrop.stops.length) {
      const t = document.createElement('canvas'); t.width = shot.width; t.height = shot.height;
      const tg = t.getContext('2d')!; tg.drawImage(shot, 0, 0);
      const px = tg.getImageData(0, 0, t.width, t.height).data;
      let x0 = t.width, y0 = t.height, x1 = -1, y1 = -1;
      for (let y = 0; y < t.height; y += 2) for (let x = 0; x < t.width; x += 2) if (px[(y * t.width + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 > x0 && y1 > y0) { const m = Math.round(0.06 * (y1 - y0)); sx = Math.max(0, x0 - m); sy = Math.max(0, y0 - m); sw = Math.min(t.width, x1 + m) - sx; sh = Math.min(t.height, y1 + m) - sy; }
    }
    // the mark's size follows the picture's; a tight transparent crop gets a strip below for it
    const mark = Math.max(11, Math.round(Math.max(sw, sh) * 0.016)), strip = backdrop.stops.length ? 0 : Math.round(mark * 2.4);
    const c = document.createElement('canvas'); c.width = sw; c.height = sh + strip;
    const g = c.getContext('2d')!;
    if (backdrop.room) { g.fillStyle = backdrop.stops[1]; g.fillRect(0, 0, c.width, c.height); }   // a place's sky is flat, as on screen
    else if (backdrop.stops.length) radial(backdrop.stops)(g, c.width, c.height);
    g.drawImage(shot, sx, sy, sw, sh, 0, 0, sw, sh);
    // the picture page shows it and lets the mark be turned off (remembered)
    const plain = document.createElement('canvas'); plain.width = c.width; plain.height = c.height; plain.getContext('2d')!.drawImage(c, 0, 0);
    const compose = (withMark: boolean) => new Promise<Blob | null>(res => {
      const out = document.createElement('canvas'); out.width = plain.width; out.height = plain.height;
      const og = out.getContext('2d')!; og.drawImage(plain, 0, 0);
      if (withMark) watermark(og, out.width, out.height, mark, !backdrop.stops.length || backdrop.id === 'sand' || backdrop.id === 'studio');
      out.toBlob(res, 'image/png');
    });
    void showPicture(compose);
  };
  shot.src = (creatorEl.hidden ? viewer : creatorPreview).snapshot(1080);
});
// "Made with BrighterAtlas.com", small in the bottom-right corner (the character stands in the middle)
function watermark(g: CanvasRenderingContext2D, w: number, hgt: number, size: number, onLight: boolean) {
  const pad = Math.round(size * 0.9);
  g.save();
  g.font = `500 ${size}px -apple-system, "Segoe UI", system-ui, Roboto, sans-serif`;
  g.textAlign = 'right'; g.textBaseline = 'alphabetic';
  const text = 'Made with BrighterAtlas.com', x = w - pad, y = hgt - pad;
  const tw = g.measureText(text).width, mw = size * 0.72, gap = size * 0.4;
  g.shadowColor = onLight ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.55)'; g.shadowBlur = size * 0.3;
  g.fillStyle = onLight ? 'rgba(20,24,32,.6)' : 'rgba(255,255,255,.55)';
  g.fillText(text, x, y);
  // the Atlas mark (the site's triangle) before the words
  const mx = x - tw - gap - mw, my = y - size * 0.72;
  g.beginPath(); g.moveTo(mx + mw / 2, my); g.lineTo(mx + mw, my + size * 0.72); g.lineTo(mx, my + size * 0.72); g.closePath();
  g.fillStyle = onLight ? 'rgba(61,110,168,.75)' : 'rgba(120,183,255,.7)'; g.fill();
  g.restore();
}
// Saving a picture: shown on a page of its own, with the BrighterAtlas.com mark as an option. Phones: the share
// sheet (Save Image) where the browser can share files; where it can't (iOS over plain http), press and hold the
// picture. Desktop: a download.
const touch = matchMedia('(pointer: coarse)').matches;
async function showPicture(compose: (withMark: boolean) => Promise<Blob | null>) {
  let withMark = store.get('watermark') !== '0', blob = await compose(withMark), url = blob ? URL.createObjectURL(blob) : '';
  const img = h('img', {src: url, alt: 'Your look'}) as HTMLImageElement;
  const close = () => { sheet.remove(); if (url) URL.revokeObjectURL(url); };
  const file = () => new File([blob!], 'brighter-atlas-fashion.png', {type: 'image/png'});
  const markToggle = h('label', {class: 'of-check'}, h('input', {type: 'checkbox', checked: withMark, onchange: async (e: Event) => {
    withMark = (e.target as HTMLInputElement).checked; store.set('watermark', withMark ? '1' : '0');
    const next = await compose(withMark); if (!next) return;
    if (url) URL.revokeObjectURL(url); blob = next; url = URL.createObjectURL(next); img.src = url;
  }}), h('span', {}, 'Enable watermark'));
  const canShare = touch && !!blob && !!navigator.canShare?.({files: [file()]});
  const save = h('button', {class: 'btn btn-cta', onclick: async () => {
    if (!blob) return;
    if (canShare) { try { await navigator.share({files: [file()], title: 'My Brighter Shores look'}); } catch {} return; }
    const a = document.createElement('a'); a.href = url; a.download = file().name; document.body.append(a); a.click(); a.remove();
  }}, canShare ? 'Save or share' : 'Download');
  const sheet = h('div', {class: 'of-picture', role: 'dialog', 'aria-label': 'Your picture', onclick: (e: Event) => { if (e.target === sheet) close(); }},
    img,
    touch && !canShare ? h('p', {}, 'Press and hold the picture to save it to Photos.') : null,
    h('div', {class: 'pic-actions'}, markToggle, h('span', {class: 'creator-gap'}), h('button', {class: 'btn', onclick: close}, 'Close'), touch && !canShare ? null : save));
  sheet.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  app.append(sheet);
}
window.addEventListener('keydown', e => {
  const typing = (e.target as HTMLElement)?.matches?.('input, textarea');
  if (!creatorEl.hidden) {
    if (e.key === 'Escape') { cancelCreator(); return; }
    // keep focus in the dialog
    if (e.key === 'Tab') {
      const f = [...creatorEl.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter(x => (x as any).getClientRects().length > 0);
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey ? i <= 0 : i === f.length - 1 || i < 0) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0]?.focus(); }
      return;
    }
    if (typing) return;
    const cat = SEG_STYLE[selected], col = SEG_COLOUR[selected];
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cat) { e.preventDefault(); state.style[cat] += e.key === 'ArrowLeft' ? -1 : 1; edited(); }
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && col) { e.preventDefault(); const n = paletteFor(selected)!.length; state.colour[col] = (((state.colour[col] + (e.key === 'ArrowUp' ? -1 : 1)) % n) + n) % n; edited(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); }
  else if (e.key === 'Escape') bgPop.hidden = true;
});
// a link pasted into this tab: like opening it fresh
window.addEventListener('hashchange', () => { const s = decode(hashLook()); const pl = BACKDROPS.find(b => b.room && b.id === hashPlace()); if (pl && pl !== backdrop) setBackdrop(pl, false); if (s && encode(s) !== encode(state)) showShared(s); });

function twoHanded(w: Worn) { return (index.items.get(w.item) as any)?.category === 'Melee 2h'; }
function randomOutfit() {
  const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  const equip: Partial<Record<EquipSlot, Worn>> = {};
  for (const slot of slots) {
    const chance = slot === 'weapon' || slot === 'shield' ? 0.45 : slot === 'cape' ? 0.5 : 0.85;
    if (Math.random() > chance) continue;
    const list = wardrobe.entries.filter(e => e.slot === slot);
    if (!list.length) continue;
    const e = pick(list), m = pick(e.members);
    const v = m.item.variants[m.variant];
    equip[slot] = {item: m.item.id, variant: m.variant, colour: v.colourable && m.item.dyeable ? pick(pack.dyes as any[]).id : null};
  }
  if (equip.weapon && equip.shield && (twoHanded(equip.weapon) || Math.random() < 0.5)) delete equip.shield;
  state.equip = equip; edited();
}

function syncControls() {
  const armed = !!(state.equip.weapon || state.equip.shield);
  viewer.showHeld = showHeld;
  // weapons out: the worn weapon's combat-ready stance (a shield alone takes the common one); away: the resting clip
  const stance = pack.items.find((i: any) => i.id === state.equip.weapon?.item)?.stance ?? DEFAULT_STANCE;
  const clip = armed && showHeld && stance != null ? stance : RELAXED;
  if (viewer.clipId !== clip) void viewer.setClip(clip);
  poseBtn.hidden = !armed;   // only with something to hold
  poseBtn.classList.toggle('active', armed && showHeld);
  poseBtn.setAttribute('aria-label', 'Weapons out'); poseBtn.setAttribute('aria-pressed', String(armed && showHeld));
  poseBtn.title = !armed ? 'Nothing held yet: pick a weapon or shield' : showHeld ? 'Weapons out, in the combat-ready stance. Click to put them away, as the game shows you out of combat' : 'Weapons away. Click to take them out, in the combat-ready stance';
  const designing = !creatorEl.hidden;
  undoBtn.disabled = designing || !past.length; redoBtn.disabled = designing || !future.length;
}
function refreshCreator() {
  if (creatorEl.hidden) return;
  renderPanel();
  warmStyles();
}
// Parts load when first shown. So stepping through styles never waits, the designer loads every style of the
// part being chosen in the background, nearest first, once per part and body type.
const warmed = new Set<string>();
function warmStyles() {
  const cat = SEG_STYLE[selected];
  if (!cat || warmed.has(`${state.gender}/${cat}`)) return;
  warmed.add(`${state.gender}/${cat}`);
  const n = pack.creator.styles[cat][state.gender].length, at = state.style[cat];
  const order = [...Array(n).keys()].sort((a, b) => Math.min(Math.abs(a - at), n - Math.abs(a - at)) - Math.min(Math.abs(b - at), n - Math.abs(b - at)));
  const base = {...state, equip: showOutfitInDesigner ? state.equip : {}};
  let k = 0;
  const step = () => {
    for (const end = Math.min(order.length, k + 4); k < end; k++) prefetch(compose(pack, index, {...base, style: {...base.style, [cat]: order[k]}}));
    if (k < order.length) setTimeout(step, 60);
  };
  step();
}
function changed() { commit(); refresh(); }
// any edit of a shared look makes it yours
function edited() { changed(); }
function refresh() {
  const parts = compose(pack, index, state);
  const wasHidden = wardrobe.hidden;
  wardrobe.hidden = hiddenItems(pack, index, state);
  for (const [slot, by] of wardrobe.hidden) if (!wasHidden.has(slot) && by.length) {
    const name = (s: EquipSlot) => (index.items.get(state.equip[s]!.item) as any)?.name ?? s;
    toast(`Your ${by.map(name).join(' and ')} ${by.length > 1 ? 'cover' : 'covers'} the ${name(slot)}, as in the game`);
  }
  wardrobe.update(state);
  syncControls();
  const code = encode(state);
  history.replaceState(null, '', addressOf(code));
  // a shared look isn't yours until you keep it, nor a design until Done
  if (!holdUndo) store.set('look', code);   // (a design is saved on Done)
  void viewer.apply(parts);
  // worn-item effects: the torso appearance against the client's lists
  const torso = state.equip.torso ? index.items.get(state.equip.torso.item) : null;
  const tv = torso?.variants[state.equip.torso!.variant];
  const wornId = tv?.[state.gender]?.worn;
  const fx = wornId == null ? [] : pack.wornEffects.filter((w: any) => w[state.gender].includes(wornId)).flatMap((w: any) => w.systems);
  fxBtn.hidden = !fx.length; fxBtn.classList.toggle('active', showEffects); fxBtn.setAttribute('aria-pressed', String(showEffects));
  void viewer.setEffects(showEffects ? fx : []);
  if (!creatorEl.hidden) {
    refreshCreator();
    const bare = showOutfitInDesigner ? parts : compose(pack, index, {...state, equip: {}});
    void creatorReady?.then(() => creatorPreview.apply(bare));
  }
}
(window as any).fashion = {THREE, viewer, creatorPreview, get state() { return state; }, compose: () => compose(pack, index, state), openCreator, closeCreator, cancelCreator, wardrobe};
await viewer.init(pack.skeleton, RELAXED);
setFloor((['ring', 'shadow', 'none'] as const).find(m => m === store.get('floor')) ?? 'ring');
try { setBackdrop(backdrop, !(backdrop.room && backdrop.id === hashPlace())); } catch (e) { console.warn('backdrop', e); setBackdrop(BACKDROPS[0]); }
refresh();
