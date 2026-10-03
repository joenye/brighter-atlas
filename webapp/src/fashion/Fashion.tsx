// Brighter Fashion (/fashion): a full-body character viewer with every piece of player equipment, and the
// client's "Design your character" screen for the body, composed exactly as the client composes a player
// (compose.ts). The look lives in the address (look-code.ts), is remembered on this device, and has undo
// (look-model.ts). The drawing is render.ts's (the character, a place behind it); the equipment panel is
// wardrobe.ts's.
import {Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import * as THREE from '../../vendor/three.module.js';
import {at, DEV} from './data.js';
import {compose, makeIndex, randomise, itemParts, hiddenItems, propParts, EQUIP_SLOTS} from './compose.js';
import type {State, EquipSlot, StyleCat, ColourCat, Worn} from './compose.js';
import {Preview, FRAMES, prefetch, Thumbnailer, report, forgetCaches, RENDERING_DEFAULTS, configureRendering, type Rendering} from './render.js';
import {Wardrobe, icon, forgetWardrobe, PATHS, FACTIONS, factionOf, takesDye, dyesFor, twoHandedItem, type Faction} from './wardrobe.js';
import {DEFAULT_LOOK, encodeLook, decodeLook, placeId, addressLook, withPose, lookPose} from './look-code.js';
import {BACKDROPS, cssOf, swatchOf, paintBackdrop, type Backdrop} from './backdrops.js';
import {LookModel} from './look-model.js';
import {attachTurning} from './turning.js';
import {el} from '../ui.js';
import {attachScrollbar} from '../scrollbar.js';
import {FashionPage} from '../app/pages.js';
import type {ToolProps} from '../app/tool.js';

// (failures on a phone under test, whose console is out of reach, go to a development server's log)
addEventListener('error', e => report('page error', e.error ?? e.message));
addEventListener('unhandledrejection', e => report('unhandled rejection', e.reason));

// ?picture: the look alone, framed and marked, for a link's preview picture (a renderer photographs the page once
// it says it is drawn: <html data-picture="ready">); it keeps nothing of the visitor's own
const PICTURE = new URLSearchParams(location.search).has('picture');
const store = {
  get: (k: string) => { if (PICTURE) return null; try { return localStorage.getItem(`fashion.${k}`); } catch { return null; } },
  set: (k: string, v: string) => { if (PICTURE) return; try { localStorage.setItem(`fashion.${k}`, v); } catch {} },
};
const SEG_STYLE: Record<string, StyleCat | null> = {hair: 'hair', face: 'face', eyes: null, jaw: 'jaw', torso: 'torso', legs: 'legs', feet: 'feet', skin: null};
const SEG_COLOUR: Record<string, ColourCat | null> = {hair: 'hair', face: null, eyes: 'eyes', jaw: null, torso: 'torso', legs: 'legs', feet: 'feet', skin: 'skin'};
const SEG_NAMES: [string, string][] = [['hair', 'Hair'], ['face', 'Face'], ['eyes', 'Eyes'], ['jaw', 'Jaw'], ['torso', 'Torso'], ['legs', 'Legs'], ['feet', 'Feet'], ['skin', 'Skin']];
// the part being chosen, framed (the head for hair, face, eyes and jaw; the body for torso, legs and feet)
const PART_FRAME: Record<string, {dist: number, target: number}> = {
  hair: FRAMES.face, face: FRAMES.face, eyes: {dist: 1100, target: 1250}, jaw: FRAMES.face,
  torso: FRAMES.upper, legs: {dist: 3300, target: 480}, feet: {dist: 1900, target: 240}, skin: FRAMES.full,
};
// what a random outfit draws from (remembered on this device; Reset puts it back)
interface RandomSettings { faction: Faction | 'Guard' | 'all'; allowEmpty: boolean; dyes: boolean; weapons: boolean }
const RANDOM_DEFAULTS: RandomSettings = {faction: 'all', allowEmpty: true, dyes: true, weapons: true};
// how the plain view is drawn (Settings, Rendering), kept on this device
const loadRendering = (): Rendering => { try { const v = JSON.parse(store.get('rendering') ?? 'null'); return v && typeof v === 'object' ? {...RENDERING_DEFAULTS, ...v} : {...RENDERING_DEFAULTS}; } catch { return {...RENDERING_DEFAULTS}; } };
const loadRandom = (): RandomSettings => { try { const v = JSON.parse(store.get('random') ?? 'null'); return v && typeof v === 'object' ? {...RANDOM_DEFAULTS, ...v} : {...RANDOM_DEFAULTS}; } catch { return {...RANDOM_DEFAULTS}; } };
const FLOORS = [['ring', 'Ring and shadow'], ['shadow', 'Shadow only'], ['none', 'None']] as const;
type Floor = typeof FLOORS[number][0];
const FRAME_KEYS = ['full', 'upper', 'face'] as const;
type FrameKey = typeof FRAME_KEYS[number];
const narrow = () => matchMedia('(max-width: 860px)').matches;
// phones: the drawer is below the view (portrait only: a phone on its side is asked to turn back)
const phone = () => matchMedia('(max-width: 860px)').matches && !matchMedia('(orientation: landscape) and (max-height: 520px)').matches;
const touch = matchMedia('(pointer: coarse)').matches;

/** An icon of the page's own set (wardrobe.ts), as JSX. */
// the animations the Animations drawer offers (animations.json: the game's emotes and the player's other named clips),
// fetched the first time the drawer opens
let ANIMATIONS: any[] = [];
let animationsLoad: Promise<void> | null = null;
const loadAnimations = () => animationsLoad ??= fetch(at('animations.json')).then(r => r.ok ? r.json() : []).then(a => { ANIMATIONS = Array.isArray(a) ? a : []; }).catch(() => { animationsLoad = null; });
const Icon = ({name}: {name: string}) => <svg viewBox="0 0 24 24" aria-hidden="true" className="ic"><path d={PATHS[name] ?? ''} /></svg>;
const Ic = ({d, children}: {d?: string; children?: ReactNode}) => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">{d ? <path d={d} /> : children}</svg>;

// ---- short links: the site keeps a look under an id of its own (/api/looks), with a picture of it for link
// previews (titled by a saved look's name). A look is only ever shared by its short link: asked for as it is
// about to be shared (the Share link button waits, "Getting link…"), asked again when the service is slow or
// fails (a cold start takes seconds), and a failure is never remembered, so the next share asks afresh. Where
// the site has no such service (a development server) the look's own address is the only link there is.
type Shared = {code: string, place: string | null, name?: string | null};
const shortKey = (l: Shared) => `${l.code}.${l.place ?? ''}.${l.name ?? ''}`;
const shortLinks = new Map<string, Promise<string | null>>();
const settled = new Map<string, string>();   // (short links only)
const SHORT_URL = /^https:\/\/[^/]+\/l\/[0-9A-Za-z]{10}$/;
// (at most two asks at a time: the looks' panel asks for every saved look as it opens, and the service is rate
// limited)
let asking = 0;
const waiting: (() => void)[] = [];
async function oneAtATime<T>(ask: () => Promise<T>): Promise<T> {
  if (asking >= 2) await new Promise<void>(r => waiting.push(r));
  asking++;
  try { return await ask(); } finally { asking--; waiting.shift()?.(); }
}
/** One ask: the short link; 'absent' (no service here: a 404 or a page instead of JSON); 'refused' (the service
 *  answered that this is not a look it keeps: asking again cannot help); or null (failed: ask again). */
function postLook(l: Shared, wait: number): Promise<string | 'absent' | 'refused' | null> {
  return oneAtATime(async () => {
    const stop = new AbortController(), timer = setTimeout(() => stop.abort(), wait);
    try {
      const r = await fetch('/api/looks', {method: 'POST', headers: {'content-type': 'application/json'}, signal: stop.signal,
        body: JSON.stringify({code: l.code, place: l.place, name: l.name ?? null})});
      if (r.status === 404 || (r.ok && !/json/.test(r.headers.get('content-type') ?? ''))) return 'absent';
      if (r.status === 400) return 'refused';
      const b = r.ok ? await r.json() : null;
      return typeof b?.url === 'string' && SHORT_URL.test(b.url) ? b.url : null;
    } catch { return null; } finally { clearTimeout(timer); }
  });
}
/** The look's short link (null: none to be had just now, or no service on a development server). */
function askShort(l: Shared): Promise<string | null> {
  const k = shortKey(l);
  const known = settled.get(k);
  if (known) return Promise.resolve(known);
  let got = shortLinks.get(k);
  if (!got) {
    got = (async () => {
      if (PICTURE) return null;
      // (up to four asks over about 40 s: each waits 10 s, then 1, 2, 4 s apart)
      for (let attempt = 0; attempt < 4; attempt++) {
        const url = await postLook(l, 10000);
        if (url === 'absent') { if (DEV) return null; }
        else if (url === 'refused') { console.warn('short link refused for this look', l); return null; }
        else if (url) return url;
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      }
      return null;
    })();
    got.then(url => { if (url) settled.set(k, url); shortLinks.delete(k); });
    shortLinks.set(k, got);
  }
  return got;
}
const lookUrl = (l: Shared) => `${location.origin}${location.pathname}#${l.code}${l.place ? '.' + l.place : ''}`;

// ---- saved looks: on this device, each with a picture; a look is its link code, so a saved look, a shared link
// and the page's address are one thing
interface SavedLook { id: string; name: string; code: string; place: string | null; thumb: string; at: number }
const loadLooks = (): SavedLook[] => { try { const v = JSON.parse(store.get('looks') ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

// ---- the site's mark, for the share picture's corner
const markImage = new Image();
markImage.src = '/brand/mark.svg';
// the link preview's picture (?picture): 1200 x 630, a three-quarter turn of the whole figure, the shield side away
// (so a shield never hides the outfit), on the first backdrop, the site's mark in its corner
const PICTURE_SIZE = [1200, 630] as const, PICTURE_YAW = -0.45;
const PICTURE_FRAMING = {dist: FRAMES.full.dist * 0.74, target: FRAMES.full.target * 0.96};
/** The preview picture's corner mark (the page's .of-picmark: the site's mark, "Brighter Fashion"), `k` times its size. */
async function pictureMark(g: CanvasRenderingContext2D, w: number, h: number, k: number) {
  await Promise.all([markImage.decode().catch(() => {}), document.fonts?.load(`600 ${20 * k}px "BA Brighter"`).catch(() => {})]);
  const img = 30 * k, gap = 9 * k, cy = h - 18 * k - img / 2, sans = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  g.save();
  g.textBaseline = 'middle'; g.fillStyle = 'rgba(232, 236, 242, .82)'; g.shadowColor = 'rgba(0, 0, 0, .5)'; g.shadowOffsetY = k; g.shadowBlur = 3 * k;
  const bold = `600 ${20 * k}px "BA Brighter", ${sans}`, plain = `400 ${20 * k}px ${sans}`;
  g.font = plain; const tail = ' Fashion', tw = g.measureText(tail).width;
  g.font = bold; const bw = g.measureText('Brighter').width;
  let x = w - 22 * k - tw - bw;
  g.fillText('Brighter', x, cy); g.font = plain; g.fillText(tail, x + bw, cy);
  x -= gap + img; g.shadowColor = 'transparent';
  if (markImage.naturalWidth) g.drawImage(markImage, x, cy - img / 2, img, img);
  g.restore();
}

export function Tool(props: ToolProps) {
  // without its data (not published yet, or the connection gone) the page says so rather than staying blank
  const [pack, setPack] = useState<any>(undefined);
  useEffect(() => {
    void fetch(at('pack.json')).then(r => r.ok && /json/.test(r.headers.get('content-type') ?? '') ? r.json() : null).catch(() => null).then(p => {
      setPack(p);
      if (!p) props.ready();
    });
  }, []);
  if (pack === undefined) return <FashionPage />;
  if (pack === null) return (
    <div id="fashion" className="fashion">
      <div className="of-nodata" role="alert">
        <p>Brighter Fashion could not load its data.</p><p>Check your connection and try again in a few minutes.</p>
        <button className="btn primary" onClick={() => location.reload()}>Try again</button>
      </div>
    </div>
  );
  return <Fashion pack={pack} {...props} />;
}

function Fashion({pack, active, ready}: ToolProps & {pack: any}) {
  const index = useMemo(() => makeIndex(pack), [pack]);
  const RELAXED = pack.creator.idleClip;   // the resting clip (it hides held items; the viewer can show them in hand)
  // the fists-up combat-ready idle the game plays with no weapon in hand (a shield alone included), and, for a pack
  // without it, the combat-ready idle most weapons share
  const DEFAULT_STANCE = useMemo<number | null>(() => { const n = new Map<number, number>(); for (const i of pack.items) if (i.stance != null) n.set(i.stance, (n.get(i.stance) ?? 0) + 1); return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; }, [pack]);
  const UNARMED: number | null = pack.unarmedClip ?? DEFAULT_STANCE;
  const encode = encodeLook, decode = (code: string | null) => decodeLook(code, i => index.items.has(i));
  const linked = useMemo(() => decode(addressLook().code), []);
  // A link opens its look as yours; the look you had is one Undo away (no prompt to keep or go back).
  const model = useMemo(() => {
    const mine = decode(store.get('look'));
    return new LookModel(linked ?? mine ?? structuredClone(DEFAULT_LOOK), linked && mine && encode(linked) !== encode(mine) ? mine : null);
  }, []);
  useSyncExternalStore(model.subscribe, model.snapshot);
  const state = model.state;

  // ---- the page's own state ----
  // (weapons away until asked for or one is tried on; a shared link opens in the pose it was shared in, and its
  // picture shows it. A link from before poses were shared: its picture shows the weapons, if any)
  const [showHeld, setShowHeld] = useState(() => lookPose(addressLook().code) ?? PICTURE);
  const picturePose = useMemo(() => PICTURE ? lookPose(addressLook().code) : null, []);
  const [showEffects, setShowEffects] = useState(store.get('fx') !== '0');
  const [backdrop, setBackdropState] = useState<Backdrop>(() => BACKDROPS.find(b => b.room && b.id === addressLook().place) ?? BACKDROPS.find(b => b.id === placeId(store.get('bg'))) ?? BACKDROPS[0]);
  const [floor, setFloorState] = useState<Floor>(PICTURE ? 'shadow' : (FLOORS.map(f => f[0]).find(m => m === store.get('floor')) ?? 'shadow'));   // (the shadow alone by default)
  const [panelCollapsed, setPanelCollapsedState] = useState(store.get('panel') === '1');
  const [bgMode, setBgModeState] = useState(false), [bgOpen, setBgOpen] = useState(false), [bgTouched, setBgTouched] = useState(false);
  // the Animations drawer, and the animation playing (until stopped; a one-shot then goes back to the pose)
  const [animMode, setAnimModeState] = useState(false), [anim, setAnim] = useState<{clip: number, loop: boolean, ticks: number, name: string, group: string, fx?: AnimItem['fx'],
    parts?: AnimItem['parts'], props?: AnimItem['props'], actors?: AnimItem['actors'], part: number, key: number} | null>(null);
  // (what the animation playing holds, a stable reference while it plays: the look's parts follow it)
  const animProps = anim && anim.group !== 'Combat' && anim.props?.length ? anim.props : null;
  const animKeys = useRef(0);
  // (the framing asked for before an animation with a figure ahead pulled the view back)
  const wideFrom = useRef<{dist: number, target: number} | null>(null);
  // (when the animation asked for began to play: its clip fetched and on the character; until then its tile spins)
  const [animRun, setAnimRun] = useState<{anim: {key: number}, t0: number} | null>(null);
  const [animTab, setAnimTab] = useState<AnimTab>('emotes');
  const [animRepeat, setAnimRepeat] = useState(false), [animPause, setAnimPause] = useState(false), [, setAnimListVersion] = useState(0);
  const [designing, setDesigningState] = useState(false), [sharedView, setSharedView] = useState(false);
  const [selected, setSelected] = useState('hair');
  const [currentFrame, setCurrentFrame] = useState<string>('full');
  const [opened, setOpened] = useState(false);
  const [parts, setParts] = useState({loading: false, first: true});
  const partsReady = useRef<Promise<unknown>>(Promise.resolve());   // (the viewer's last apply of the look's parts: settled once they are drawn)
  const actorsReady = useRef<Promise<unknown>>(Promise.resolve());   // (an animation's other figures, built)
  const [roomLoading, setRoomLoading] = useState(false);
  const [placeLoad, setPlaceLoad] = useState<{name: string, progress: number | null} | null>(null);
  const [toastMsg, setToastMsg] = useState<{text: string, n: number} | null>(null);
  const [looks, setLooks] = useState<SavedLook[]>(loadLooks);
  const [looksOpen, setLooksOpen] = useState(false), [looksTouched, setLooksTouched] = useState(false), [looksTop, setLooksTop] = useState(0);
  const [picture, setPicture] = useState<{blob: Blob | null, url: string} | null>(null), [shareOpen, setShareOpen] = useState(false);
  const [split, setSplit] = useState(Number(store.get('split')) || 0), [cSplit, setCSplit] = useState(Number(store.get('csplit')) || 0);
  const [stageH, setStageH] = useState<string | null>(null);
  const [columnBottom, setColumnBottom] = useState('');
  const [fx, setFx] = useState<number[]>([]);
  const [, forceRender] = useState(0);
  // (what listeners and the engine's callbacks read: the latest, not the render's)
  // the name typed for this look in Your looks (null: untouched), and as it was when typing last paused; both go
  // when the look changes
  const [nameDraft, setNameDraft] = useState<string | null>(null), [nameSettled, setNameSettled] = useState<string | null>(null);
  const live = useRef({} as {nameDraft: string | null, nameSettled: string | null, state: State, showHeld: boolean, backdrop: Backdrop, designing: boolean, sharedView: boolean, selected: string, panelCollapsed: boolean, bgMode: boolean, animMode: boolean, bgOpen: boolean, looksOpen: boolean, active: boolean, opened: boolean, roomLoading: boolean, parts: {loading: boolean, first: boolean}, currentFrame: string, split: number, looks: SavedLook[], floor: Floor});
  Object.assign(live.current, {nameDraft, nameSettled, state, showHeld, backdrop, designing, sharedView, selected, panelCollapsed, bgMode, animMode, bgOpen, looksOpen, active, opened, roomLoading, parts, currentFrame, split, looks, floor});

  const els = {
    main: useRef<HTMLElement>(null), viewer: useRef<HTMLElement>(null), canvas: useRef<HTMLCanvasElement>(null), right: useRef<HTMLElement>(null),
    creator: useRef<HTMLDivElement>(null), cCanvas: useRef<HTMLCanvasElement>(null), stage: useRef<HTMLDivElement>(null), body: useRef<HTMLDivElement>(null),
    cGrip: useRef<HTMLDivElement>(null), panel: useRef<HTMLDivElement>(null), share: useRef<HTMLButtonElement>(null), bgBtn: useRef<HTMLButtonElement>(null),
    bgPop: useRef<HTMLDivElement>(null), grip: useRef<HTMLDivElement>(null), looks: useRef<HTMLDivElement>(null),
  };
  // (the designer's own view and the thumbnail maker are made when first needed: a picture never needs them, and
  // each is a GL context of its own)
  const engine = useRef<{viewer: Preview, creatorPreview: Preview | null, thumbs: Thumbnailer | null, wardrobe: Wardrobe} | null>(null);
  const creator = () => {
    const e = engine.current!;
    if (!e.creatorPreview) {
      e.creatorPreview = new Preview(els.cCanvas.current!, {fov: 18, floor: true});
      e.creatorPreview.running = false; e.creatorPreview.setFloor(live.current.floor);
      e.creatorPreview.setDesigning(true);   // (the designer's own view: never a shadow on the face)
      e.creatorPreview.setMasks(pack.masks);   // (the fists' guard, Weapons out there, is two clips as the page's)
      attachTurning(els.cCanvas.current!, e.creatorPreview);
    }
    return e.creatorPreview;
  };

  const toast = useCallback((text: string) => setToastMsg(t => ({text, n: Math.abs(t?.n ?? 0) + 1})), []);
  // "Copied to clipboard", said where the click or tap was (bubble(), below)
  const [bubbleAt, setBubbleAt] = useState<Bubble | null>(null);
  useEffect(() => { const t = setTimeout(() => setNameSettled(nameDraft), 700); return () => clearTimeout(t); }, [nameDraft]);
  const lookCode = encode(state);
  useEffect(() => { setNameDraft(null); setNameSettled(null); }, [lookCode]);
  useEffect(() => {
    const on = (e: Event) => setBubbleAt({...(e as CustomEvent<Bubble>).detail, n: Date.now()});
    addEventListener('fashion-bubble', on); return () => removeEventListener('fashion-bubble', on);
  }, []);
  // (shown while n > 0; hidden by making it negative, which the timer leaves alone: flipping its sign each time
  // made a toast come back every 2.2 s)
  useEffect(() => { if (!toastMsg || toastMsg.n <= 0) return; const t = setTimeout(() => setToastMsg(m => m && {...m, n: -Math.abs(m.n)}), 2200); return () => clearTimeout(t); }, [toastMsg?.n]);

  const frameOf = (f: FrameKey) => f === 'full' && narrow() ? {dist: 4900, target: 840}
    : f === 'upper' && live.current.showHeld && (live.current.state.equip.weapon || live.current.state.equip.shield) ? {dist: 3900, target: 930} : FRAMES[f];
  const changed = useCallback(() => model.changed(), []);
  const edited = changed;   // (any edit of a shared look makes it yours)
  const twoHanded = (w: Worn) => twoHandedItem(index.items.get(w.item));

  // ---- the drawer's three modes (phones: Character, Equipment, Settings; one on at a time) ----
  const setPanelCollapsed = (on: boolean) => {
    if (on && live.current.bgMode) setBgMode(false);
    if (on && live.current.animMode) setAnimMode(false);
    live.current.panelCollapsed = on; setPanelCollapsedState(on); store.set('panel', on ? '1' : '0');
  };
  function setBgMode(on: boolean) { if (live.current.bgMode === on) return; if (on) setAnimMode(false); live.current.bgMode = on; setBgModeState(on); setBgOpen(on); }
  function setAnimMode(on: boolean) {
    if (live.current.animMode === on) return; if (on) setBgMode(false); live.current.animMode = on; setAnimModeState(on);
    if (on) void loadAnimations()?.then(() => setAnimListVersion(v => v + 1));
  }
  // (the equipment or the designer opened mid-animation stops it; the drawer folded away by its own button, or
  // Escape, leaves it playing)
  const stopAnimation = () => { setAnim(null); setAnimPause(false); };
  const toggleAnimMode = () => {
    if (live.current.animMode) { setAnimMode(false); return; }
    if (live.current.designing) leaveDesigner();
    setPanelCollapsed(false); setAnimMode(true);
  };
  const toggleBgMode = () => {
    if (live.current.bgMode) { setBgMode(false); setPanelCollapsed(true); return; }
    if (live.current.designing) leaveDesigner();
    setPanelCollapsed(false); setBgMode(true);
  };
  const closeBg = (refocus: boolean) => { if (live.current.bgMode) return; setBgOpen(false); if (refocus) els.bgBtn.current?.focus(); };

  // ---- the designer: face and body (phones: in the drawer, over the page's own view; wider screens: a dialog
  // with a view of its own) ----
  const creatorSnapshot = useRef('');
  const creatorReady = useRef<Promise<void> | null>(null);
  const designView = () => live.current.sharedView ? engine.current!.viewer : creator();
  const frameCreator = (instant = false) => {
    const v = designView();
    v.frameTo(PART_FRAME[live.current.selected] ?? FRAMES.full, instant);   // (the part being chosen, framed: always)
    if (instant && !live.current.sharedView) { v.yaw = 0.3; v.yawVel = 0; }
  };
  function openCreator() {
    const e = engine.current!;
    creatorSnapshot.current = JSON.stringify(model.state);
    const shared = phone();
    // phones: the designer's divider opens where the page's is (measured: the two frames differ by their borders).
    // Only a drawer on screen is measured: straight after no drawer at all (Settings or the designer just
    // closed), the page has not laid its drawer out again yet, the view fills the screen, and measuring it gave
    // the designer's view all the height and its panel none. Then the drawer's own height, as the page's
    // returns to it (none kept: the stylesheet's).
    if (shared) {
      const drawerShown = !!els.right.current?.getClientRects().length && !!els.main.current!.clientHeight;
      const clamp = (f: number) => Math.max(0.22, Math.min(0.72, f));
      if (drawerShown) {
        const body = els.body.current!.getBoundingClientRect(), view = els.viewer.current!.getBoundingClientRect();
        const f = view.height / els.main.current!.clientHeight;
        setCSplit(clamp(f));
        setStageH(body.height && f === clamp(f) ? `${view.bottom - body.top}px` : null);
      } else {
        setStageH(null);
        if (live.current.split) setCSplit(clamp(live.current.split));
      }
    }
    live.current.sharedView = shared; setSharedView(shared);
    live.current.designing = true; setDesigningState(true);
    e.viewer.setDesigning(true);   // (no shadows while designing: they fall across the face; back when it closes)
    model.holdUndo = true;
    if (!shared) { const c = creator(); e.viewer.running = false; c.running = true; creatorReady.current ??= c.init(pack.skeleton, RELAXED); }
    frameCreator(true);
    model.touch();
  }
  function hideCreator() {
    const e = engine.current!;
    live.current.designing = false; setDesigningState(false); e.viewer.running = true; if (e.creatorPreview) e.creatorPreview.running = false;
    e.viewer.setDesigning(false);
    if (live.current.sharedView) { e.viewer.frameTo(frameOf(live.current.currentFrame === '' ? 'full' : live.current.currentFrame as FrameKey)); live.current.sharedView = false; setSharedView(false); }
    els.canvas.current?.focus({preventScroll: true});
  }
  function closeCreator() { model.holdUndo = false; model.commit(); hideCreator(); model.touch(); }
  // Cancel drops the design, but keeps it one Redo away so a careful face is never lost to a stray Esc
  function cancelCreator() { const kept = model.cancel(creatorSnapshot.current); hideCreator(); if (kept) toast('Changes cancelled. Redo brings them back'); }
  // out of the designer into another of the drawer's modes, the drawer at the designer's height to the pixel
  function leaveDesigner() {
    const stage = els.stage.current!.getBoundingClientRect(), m = els.main.current!.getBoundingClientRect();
    if (phone() && m.height) { const s = (stage.bottom - m.top) / m.height; setSplit(s); store.set('split', String(s)); }
    closeCreator();
  }
  // the drawer in Character mode (the page opens in it)
  const openCharacter = () => { setBgMode(false); setAnimMode(false); stopAnimation(); if (live.current.panelCollapsed) setPanelCollapsed(false); openCreator(); };
  const modeClick = (designingBtn: boolean) => {
    // (Character with no drawer brings the page's back first: the view and its column sit above the designer's)
    if (designingBtn) { if (!live.current.designing) openCharacter(); else { closeCreator(); setPanelCollapsed(true); } }
    else if (live.current.designing) { leaveDesigner(); setPanelCollapsed(false); }
    else if (live.current.bgMode) setBgMode(false);
    else if (live.current.animMode) { setAnimMode(false); stopAnimation(); }
    else setPanelCollapsed(!live.current.panelCollapsed);
  };

  // ---- backdrops ----
  // `remember`: the viewer's own pick (a shared link's place shows for the visit, not saved as theirs)
  const setBackdrop = useCallback((b: Backdrop, remember = true) => {
    live.current.backdrop = b; setBackdropState(b);
    if (remember) store.set('bg', b.id);
    const e = engine.current; if (!e) return;
    history.replaceState(null, '', addressOf(encode(model.state), b));
    const done = () => { if (live.current.backdrop === b) { live.current.roomLoading = false; setRoomLoading(false); } };
    live.current.roomLoading = !!b.room; setRoomLoading(!!b.room); setPlaceLoad(b.room ? {name: b.name, progress: null} : null);
    void e.viewer.setRoom(b.room ?? null).then(done, () => { done(); toast(`${b.name} couldn’t be loaded`); setBackdrop(BACKDROPS[0]); });
  }, []);
  const addressOf = (code: string, b: Backdrop = live.current.backdrop) => `#${code}${b.room ? '.' + b.id : ''}`;
  const setFloor = (mode: Floor) => { store.set('floor', mode); setFloorState(mode); engine.current?.viewer.setFloor(mode); engine.current?.creatorPreview?.setFloor(mode); };
  // (a picture for a short link is always drawn the game's way)
  const [rend, setRendState] = useState<Rendering>(() => PICTURE ? {...RENDERING_DEFAULTS} : loadRendering());
  const setRend = (next: Rendering) => { setRendState(next); store.set('rendering', JSON.stringify(next)); engine.current?.viewer.setRendering(next); engine.current?.creatorPreview?.setRendering(next); };

  // ---- the engine: the character's view, the designer's, the item thumbnails and the wardrobe ----
  const slots = useMemo(() => [...pack.slotOrder.filter((s: string) => (EQUIP_SLOTS as readonly string[]).includes(s)), 'cape', 'weapon'] as EquipSlot[], [pack]);
  // the random outfit's settings (the Settings drawer), kept on this device
  const [rs, setRsState] = useState<RandomSettings>(loadRandom);
  const randomSettings = useRef(rs); randomSettings.current = rs;
  const setRs = (next: RandomSettings) => { randomSettings.current = next; setRsState(next); store.set('random', JSON.stringify(next)); };
  const randomOutfit = () => {
    const rs = randomSettings.current, pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
    const equip: Partial<Record<EquipSlot, Worn>> = {};
    for (const slot of slots) {
      if (!rs.weapons && (slot === 'weapon' || slot === 'shield')) continue;
      const chance = !rs.allowEmpty ? 1 : slot === 'weapon' || slot === 'shield' ? 0.45 : slot === 'cape' ? 0.5 : 0.85;
      if (Math.random() > chance) continue;
      // (a faction chosen: only its own combat gear, and combat capes in its colours; Guard: only the Guard gear,
      // no combat cape; what is no one's, transmogs and the other capes, always)
      const allowed = (it: any) => { const f = factionOf(it); return f == null || rs.faction === 'all' || (f === 'combat' ? rs.faction !== 'Guard' : f === rs.faction); };
      const list = engine.current!.wardrobe.entries.filter(e => e.slot === slot && e.members.some(m => allowed(m.item)));
      if (!list.length) continue;
      const e = pick(list), m = pick(e.members.filter(m => allowed(m.item)));
      // (a combat cape: the faction's variant, or any)
      const variant = factionOf(m.item) === 'combat' ? (rs.faction === 'all' ? Math.floor(Math.random() * m.item.variants.length) : Math.max(0, m.item.variants.findIndex((v: any) => v.grade === rs.faction))) : m.variant;
      const v = m.item.variants[variant];
      equip[slot] = {item: m.item.id, variant, colour: rs.dyes && v?.colourable && takesDye(m.item) ? pick(dyesFor(pack, m.item)).id : null};
    }
    if (equip.weapon && equip.shield && (twoHanded(equip.weapon) || Math.random() < 0.5)) delete equip.shield;
    model.state.equip = equip; edited();
  };
  useLayoutEffect(() => {
    // (a picture, for a link's preview, is drawn at its own pixels: no supersampling, which a software renderer pays for)
    configureRendering(rend);   // (before the view builds anything)
    const viewer = new Preview(els.canvas.current!, {fov: 24, floor: true, pixelRatio: PICTURE ? 1 : undefined});
    viewer.pitch = 0.07;
    viewer.frameTo(frameOf('full'), true);
    viewer.onLoading = n => setParts(p => {
      // (the first look is in once its parts are drawn: the viewer's own start applies no parts and says so too)
      const next = {loading: !!n, first: p.first && !(!n && viewer.drawn)};
      live.current.parts = next; return next;
    });
    viewer.onRoomProgress = f => { if (live.current.roomLoading) setPlaceLoad(pl => pl && {...pl, progress: f}); };
    attachTurning(els.canvas.current!, viewer, () => { setCurrentFrame(''); live.current.currentFrame = ''; });
    // the wardrobe's header: phones lead the slot view with the way into face and body
    const wardHeader = el('div', {class: 'of-wardhead'},
      el('button', {class: 'btn of-designer', title: 'Design your character: face, body and hair', onclick: () => openCreator()}, icon('mask'), 'Character'),
      el('h2', {}, 'Equipment'),
      el('span', {class: 'of-wardactions'},
        el('button', {class: 'btn-mini', title: 'Random equipment: put on something random (its settings: Settings, Random equipment button)', onclick: () => randomOutfit()}, icon('dice'), el('span', {class: 'of-long'}, 'Random equipment'), el('span', {class: 'of-short'}, 'Random')),
        el('button', {class: 'btn-mini', title: 'Unequip everything', onclick: () => { model.state.equip = {}; edited(); }}, icon('x'), 'Unequip all')));
    const wardrobe = new Wardrobe(els.right.current!, pack, slots, {
      equip: (slot, w) => {
        const st = model.state, hiddenBefore = hiddenItems(pack, index, st);
        if (w) st.equip[slot] = w; else delete st.equip[slot];
        // a two-handed weapon (by its type in the game's data: every bow among them) leaves no hand for a shield
        if (w && slot === 'weapon' && twoHanded(w) && st.equip.shield) { delete st.equip.shield; toast('Two-handed weapon: the shield comes off'); }
        else if (w && slot === 'shield' && st.equip.weapon && twoHanded(st.equip.weapon)) { delete st.equip.weapon; toast('A shield needs a free hand: the two-handed weapon comes off'); }
        // trying one on: show it in hand, turned so it isn't edge-on
        if (w && (slot === 'weapon' || slot === 'shield')) { live.current.showHeld = true; setShowHeld(true); if (Math.abs(viewer.yaw) < 0.2) viewer.turnTo(slot === 'weapon' ? -0.7 : 0.7); }
        // something just put on hides a piece, or goes on under one: a toast says so (only here, where one piece is
        // put on by hand: never for a random outfit, undo or a look opened, which the slots' own marks show)
        if (w) {
          const fresh = [...hiddenItems(pack, index, st)].filter(([s]) => !hiddenBefore.has(s));
          if (fresh.length) toast(wardrobe.hiddenMessage(st, fresh));
        }
        edited();
      },
      equipMany: (changes) => { for (const [s, w] of Object.entries(changes)) { if (w) model.state.equip[s as EquipSlot] = w; else delete model.state.equip[s as EquipSlot]; } edited(); },
      preview: (slot, w) => prefetch(compose(pack, index, {...model.state, equip: {...model.state.equip, [slot]: w}})),
      thumb: (slot, w) => (engine.current!.thumbs ??= new Thumbnailer()).thumb(`${w.item}/${w.variant}/${w.colour ?? 0}/${model.state.gender}`, itemParts(pack, index, w, model.state.gender, model.state), pack.skeleton),
    }, wardHeader);
    engine.current = {viewer, creatorPreview: null, thumbs: null, wardrobe};
    const gameBuild = document.getElementById('game-build');   // (the top bar's label: none in a picture)
    if (gameBuild) gameBuild.textContent = `game update ${pack.build.date}${pack.build.version ? ` (v${pack.build.version})` : ''}`;
    // iPhone and iPad Safari (not a home-screen app): its toolbar floats over the bottom of the page
    if (/iP(hone|ad|od)/.test(navigator.userAgent) && !(navigator as any).standalone) document.documentElement.classList.add('ios-browser');
    (window as any).fashion = {THREE, viewer, pack, get creatorPreview() { return engine.current?.creatorPreview; }, get state() { return model.state; }, compose: () => compose(pack, index, model.state), openCreator, closeCreator, cancelCreator, wardrobe};
    let gone = false;
    void (async () => {
      viewer.setMasks(pack.masks);
      await viewer.init(pack.skeleton, RELAXED);
      if (gone) return;
      if (!PICTURE) void viewer.setFlourishes(pack.flourishes, pack.flourishWait);
      setFloor(floor);
      viewer.setRendering(rend);
      // (a place waits for the character: its files would otherwise share a slow connection with the character's, and
      // a phone would show nothing for twice as long; the place fills in behind the character, its card showing)
      const opening = live.current.backdrop, remember = !(opening.room && opening.id === addressLook().place);
      const show = () => { try { setBackdrop(opening, remember); } catch (e) { console.warn('backdrop', e); setBackdrop(BACKDROPS[0]); } };
      if (!opening.room) show();
      else void new Promise<void>((done) => {
        const until = performance.now() + 15000;
        const wait = () => (gone || viewer.active.size || performance.now() > until ? done() : requestAnimationFrame(wait));
        wait();
      }).then(() => { if (!gone && live.current.backdrop === opening) show(); });
      model.touch();
      // (the page opens on the equipment, as it is first drawn: the designer is a tap away)
      if (PICTURE) { viewer.yaw = PICTURE_YAW; viewer.yawVel = 0; viewer.frameTo(PICTURE_FRAMING, true); }
      forceRender(n => n + 1);
    })();
    return () => {
      gone = true;
      viewer.dispose(); engine.current?.creatorPreview?.dispose(); engine.current?.thumbs?.dispose();
      forgetCaches(); forgetWardrobe();
      if ((window as any).fashion?.viewer === viewer) delete (window as any).fashion;
      engine.current = null;
    };
  }, []);

  // ---- the look, drawn: the parts, the wardrobe, the address, the pose and the effect ----
  useEffect(() => {
    const e = engine.current; if (!e) return;
    const st = model.state, look = compose(pack, index, st);
    // (an animation that holds something: its props in the weapons' place while it plays)
    const holding = animProps && !designing ? propParts(animProps) : [];
    // (the weapons stay in the look: the viewer swaps them for the props on the animation's first frame, not before)
    const partsNow = holding.length ? [...look, ...holding] : look;
    e.viewer.propClips = holding.length && anim ? new Set(anim.parts?.map(p => p.clip) ?? [anim.clip]) : null;
    // (an item another covers stays marked in its row: no toast. The rows, and their pictures, are drawn only where
    // they show: never for a picture, and not under the designer, which hides the wardrobe; they draw as it closes)
    e.wardrobe.hidden = hiddenItems(pack, index, st);
    if (!PICTURE && !designing) e.wardrobe.update(st);
    const code = encode(st);
    history.replaceState(null, '', addressOf(code));
    if (!model.holdUndo) store.set('look', code);   // (a design is saved on Done)
    // designing: the body alone (nothing worn, nothing held)
    const designParts = designing ? compose(pack, index, {...st, equip: {}}) : partsNow;
    partsReady.current = e.viewer.apply(sharedView ? designParts : partsNow);
    // worn-item effects: the torso appearance against the pack's worn-effect lists
    const torso = st.equip.torso ? index.items.get(st.equip.torso.item) : null;
    const wornId = torso?.variants[st.equip.torso!.variant]?.[st.gender]?.worn;
    const effects = wornId == null ? [] : pack.wornEffects.filter((w: any) => w[st.gender].includes(wornId)).flatMap((w: any) => w.systems);
    setFx(effects);
    void e.viewer.setEffects(showEffects ? effects : []);
    if (designing) { warmStyles(); if (!sharedView) void creatorReady.current?.then(() => e.creatorPreview?.apply(designParts)); }
  }, [model.version, designing, sharedView, showEffects, animProps]);
  // an animation's other figures (a rod, a rift, a snowball to throw), built as it is picked and drawn from its first
  // frame on (the clip waits for them, as it does for what it holds)
  const animActors = anim && !designing && anim.actors?.length ? anim.actors : null;
  useEffect(() => {
    const v = engine.current?.viewer; if (!v) return;
    actorsReady.current = v.setAnimActors(animActors ? animActors.map(a => ({...a, parts: propParts(a.parts)})) : null, anim ? anim.parts?.map(p => p.clip) ?? [anim.clip] : []);
  }, [animActors]);
  // the pose: weapons out (the worn weapon's combat-ready stance; with no weapon, a shield alone too, fists up as the
  // game does), or away. A link's picture of a look with nothing in hand stays at rest.
  const armed = !!(state.equip.weapon || state.equip.shield);
  const fighting = showHeld && (armed || !PICTURE || picturePose === true);
  useEffect(() => {
    const e = engine.current; if (!e) return;
    const plain = designing && sharedView;   // designing: nothing held; at rest, or Weapons out the fists' guard
    // (a stance is two clips where the pack says so: the shared lower body and the weapon's own upper body, the
    // fists' guard the same way)
    const weapon = state.equip.weapon ? pack.items.find((i: any) => i.id === state.equip.weapon?.item) : null;
    const fists: [number | null, number | null] = pack.unarmedLower != null && pack.masks ? [pack.unarmedLower, UNARMED] : [UNARMED, null];
    const [lower, upper]: [number | null, number | null] = weapon ? [weapon.stance ?? DEFAULT_STANCE, weapon.stanceUpper ?? null] : fists;
    const playing = anim && !plain ? anim : null;
    const guard = showHeld && fists[0] != null ? fists : [RELAXED, null];
    const [clip, top] = playing ? [playing.parts?.[playing.part]?.clip ?? playing.clip, null] : plain ? guard : fighting && lower != null ? [lower, upper] : [RELAXED, null];
    // (the pose and the held items switch on one frame, once the clips are in; the stance of what is worn is fetched
    // ahead, so taking weapons out does not wait for it)
    // (weapons are put away while an animation plays, but for a combat one: you would not clap with a sword in hand)
    const held = showHeld && !plain && (!playing || playing.group === 'Combat');
    if (playing ? e.viewer.clipId !== clip || animStarted.current !== playing : e.viewer.clipId !== clip || e.viewer.upperId !== top || e.viewer.showHeld !== held) {
      animStarted.current = playing;
      // (an animation holding something, or with figures of its own: its first clip starts once they are built, so
      // they never show on the pose before it)
      const first = !!playing && playing.part === 0 && !!(playing.props?.length || playing.actors?.length);
      const start = () => e.viewer.setClip(clip, top, held, !!playing, !(playing && playing.part > 0));
      poseReady.current = first ? Promise.all([partsReady.current, actorsReady.current]).then(() => animStarted.current === playing ? start() : undefined) : start();
      // (in: its tile's progress starts; a clip that could not be fetched: the tile stops loading and says so)
      if (playing) poseReady.current.then(() => { if (animStarted.current === playing && e.viewer.clipId === clip) setAnimRun({anim: playing, t0: performance.now()}); },
        () => { if (animStarted.current === playing) { setAnim(a => a === playing ? null : a); toast(`Couldn’t load ${playing.name}. Please try again`); } });
    }
    e.viewer.prefetchClips([lower, upper]);
    if (designing && !sharedView && e.creatorPreview) { const c = e.creatorPreview; c.showHeld = false; void creatorReady.current?.then(() => { if (c.clipId !== guard[0] || c.upperId !== guard[1]) void c.setClip(guard[0]!, guard[1], false); }); }
  }, [model.version, showHeld, designing, sharedView, anim, animPause]);
  const animStarted = useRef<typeof anim>(null), poseReady = useRef<Promise<unknown>>(Promise.resolve());
  // the fighting moves the drawer offers: in the combat-ready pose only, the weapon's own (with none, the fists')
  const heldWeapon = state.equip.weapon ? pack.items.find((i: any) => i.id === state.equip.weapon?.item) : null;
  const combatMoves: AnimItem[] = fighting && !designing ? ((heldWeapon ? heldWeapon.moves : pack.unarmedMoves) ?? []).map((m: any) => ({...m, group: 'Combat'})) : [];
  // a one-shot animation plays once (the game's 600 ticks a second), then the pose it interrupted comes back; Repeat
  // plays it again and again; Pause at end keeps its last frame until stopped
  // (counted on the animations' own clock from when it began to play: a clip still on its way plays whole, and a
  // pause holds it)
  // A three-piece animation goes on to its next part as one ends (to the first again on Repeat).
  useEffect(() => {
    const v = engine.current?.viewer;
    if (!v || !anim || anim.loop || animPause || !anim.ticks || animRun?.anim !== anim || (animRepeat && !anim.parts)) return;
    const last = !anim.parts || anim.part >= anim.parts.length - 1;
    const ticks = anim.parts ? anim.parts[anim.part].ticks ?? 0 : anim.ticks;
    const t = setTimeout(() => setAnim(a => a !== anim ? a : !last ? {...a, part: a.part + 1} : animRepeat ? {...a, part: 0, key: ++animKeys.current} : null),
      Math.max(0, ticks / 0.6 + (last ? 50 : 0) - v.clipElapsed()));
    return () => clearTimeout(t);
  }, [anim, animRun, animRepeat, animPause]);
  // the animation's particle effects, once it plays (its clip in), the body type's own where the game has one for each
  // (a three-piece animation's effect starts with its first part and runs on through the others)
  useEffect(() => {
    const v = engine.current?.viewer; if (!v) return;
    if (anim && anim.part > 0) return;
    const on = !!anim && animRun?.anim === anim;
    const fx = on ? (anim!.fx ?? []).filter(f => !f.gender || f.gender === state.gender) : null;
    void v.setAnimEffects(fx, !anim?.parts && (animRepeat || !!anim?.loop));
    // (a figure standing well ahead, the rift: seen from the side, not between the view and the character, and from
    // far enough back for both; the framing asked for before it comes back after)
    const ahead = on && anim!.actors?.some(a => Math.abs(a.at?.[1] ?? 0) > 500);
    if (ahead && !wideFrom.current) {
      wideFrom.current = {...v.want};
      if (Math.abs(v.yaw) < 0.6) v.turnTo(-1.1);
      v.frameTo({dist: FRAMES.full.dist * 1.9, target: FRAMES.full.target});
    } else if (!ahead && wideFrom.current && (!anim || anim.part === 0)) { v.frameTo(wideFrom.current); wideFrom.current = null; }
  }, [anim, animRun, animRepeat, state.gender]);
  // Pause: everything stands still where it is (the resting idle too: a way to freeze the character), until it is
  // let go, an animation is picked, or the equipment or the designer opens (folding the drawer keeps it)
  useEffect(() => { const v = engine.current?.viewer; if (v) v.paused = animPause; }, [animPause]);
  // (folding the drawer keeps a pause: the character stays frozen where it was; stopping the animation lets go)
  useEffect(() => { if (designing) frameCreator(); }, [selected]);

  // Parts load when first shown. So stepping through styles never waits, the designer loads every style of the
  // part being chosen in the background, nearest first, once per part and body type: from the first touch or key
  // in the designer on (the page opens on it: a visit that only looks stays small).
  const warmed = useRef(new Set<string>()), designUsed = useRef(false);
  function warmStyles() {
    const st = model.state, cat = SEG_STYLE[live.current.selected];
    if (!designUsed.current || !cat || warmed.current.has(`${st.gender}/${cat}`)) return;
    warmed.current.add(`${st.gender}/${cat}`);
    const n = pack.creator.styles[cat][st.gender].length, at = st.style[cat];
    const order = [...Array(n).keys()].sort((a, b) => Math.min(Math.abs(a - at), n - Math.abs(a - at)) - Math.min(Math.abs(b - at), n - Math.abs(b - at)));
    const base = {...st, equip: {}};
    let k = 0;
    const step = () => {
      for (const end = Math.min(order.length, k + 4); k < end; k++) prefetch(compose(pack, index, {...base, style: {...base.style, [cat]: order[k]}}));
      if (k < order.length) setTimeout(step, 60);
    };
    step();
  }

  // ---- the one loader: the page's (the shell's) until the first look is drawn; then a place's (with its progress)
  // while one loads, else an outfit whose parts take more than a moment (a quick change never flashes it) ----
  useEffect(() => {
    if (!opened && !parts.first && !roomLoading) { setOpened(true); live.current.opened = true; ready(); }
    if (PICTURE && !parts.loading && !parts.first) requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => { if (!live.current.parts.loading) document.documentElement.dataset.picture = 'ready'; }, 120)));
    if (roomLoading) return;
    if (!parts.loading) { setPlaceLoad(null); return; }
    const t = setTimeout(() => { if (live.current.parts.loading && !live.current.roomLoading) setPlaceLoad({name: 'outfit', progress: null}); }, 450);
    return () => clearTimeout(t);
  }, [parts, roomLoading]);
  const placeShown = opened && placeLoad;

  // ---- the phone split: the character view's share of the height, remembered (a share, not pixels: iOS Safari's
  // toolbar resizes the page) ----
  const onGripDown = (e: React.PointerEvent) => {
    if (!phone() || (e.target as HTMLElement).closest('.of-panel-toggle')) return;
    e.preventDefault();
    const grip = els.grip.current!; grip.setPointerCapture(e.pointerId); grip.classList.add('dragging');
    const top = els.main.current!.getBoundingClientRect().top, h0 = els.main.current!.clientHeight, y0 = e.clientY;
    let moved = false, s = live.current.split;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - y0) < 6) return;
      if (!moved) { moved = true; if (live.current.panelCollapsed) setPanelCollapsed(false); }
      s = Math.max(0.22, Math.min(0.72, (ev.clientY - top) / h0)); setSplit(s);
    };
    // a tap (no drag) folds or unfolds; a drag resizes
    const up = () => { grip.removeEventListener('pointermove', move); grip.classList.remove('dragging'); if (moved) store.set('split', String(s)); else setPanelCollapsed(!live.current.panelCollapsed); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up, {once: true}); grip.addEventListener('pointercancel', up, {once: true});
  };
  const onCGripDown = (e: React.PointerEvent) => {
    if (!phone()) return;
    e.preventDefault();
    const g = els.cGrip.current!; g.setPointerCapture(e.pointerId); g.classList.add('dragging');
    const top = els.body.current!.getBoundingClientRect().top, h0 = els.body.current!.clientHeight;
    let cs = cSplit;
    const move = (ev: PointerEvent) => { cs = Math.max(0.22, Math.min(0.72, (ev.clientY - top) / h0)); setStageH(null); setCSplit(cs); };
    // one split for both: the page's divider follows the designer's back out, to the pixel
    const up = () => {
      g.removeEventListener('pointermove', move); g.classList.remove('dragging'); store.set('csplit', String(cs));
      const stage = els.stage.current!.getBoundingClientRect(), m = els.main.current!.getBoundingClientRect();
      if (!live.current.panelCollapsed && m.height) { const s = (stage.bottom - m.top) / m.height; setSplit(s); store.set('split', String(s)); }
    };
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up, {once: true}); g.addEventListener('pointercancel', up, {once: true});
  };
  const [, setViewportTick] = useState(0);   // (the phone/desktop layout, remeasured on resize)
  // Phones: the view's column of buttons stands just above the drawer's top edge, wherever that is, and above the
  // page's foot when there is no drawer (the stylesheet's place). Measured, not assumed.
  const placeColumn = useCallback(() => {
    if (!phone() || live.current.panelCollapsed) { setColumnBottom(''); return; }
    const top = (live.current.designing ? els.cGrip.current : els.right.current)?.getBoundingClientRect().top, view = els.viewer.current?.getBoundingClientRect();
    if (!view?.height || !top) { setColumnBottom(''); return; }
    setColumnBottom(`${Math.max(8, Math.round(view.bottom - top + 8))}px`);
  }, []);
  useLayoutEffect(() => { placeColumn(); }, [panelCollapsed, designing, bgMode, split, cSplit, stageH]);
  useEffect(() => {
    let frame = 0;
    const soon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; placeColumn(); }); };
    const watch = new ResizeObserver(soon);
    for (const n of [els.viewer.current, els.right.current, els.stage.current]) if (n) watch.observe(n);
    const onResize = () => { soon(); setViewportTick(t => t + 1); if (live.current.looksOpen) placeLooks(); };
    addEventListener('resize', onResize); visualViewport?.addEventListener('resize', soon);
    return () => { watch.disconnect(); cancelAnimationFrame(frame); removeEventListener('resize', onResize); visualViewport?.removeEventListener('resize', soon); };
  }, []);
  useEffect(() => { if (els.panel.current) attachScrollbar(els.panel.current); }, []);
  // wheel zooms the view (a listener of its own: the page must not scroll under it)
  useEffect(() => {
    const c = els.canvas.current!;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); engine.current?.viewer.zoomBy(Math.exp(e.deltaY * 0.0012)); setCurrentFrame(''); live.current.currentFrame = ''; };
    c.addEventListener('wheel', onWheel, {passive: false});
    // (and the designer's own view, wider screens': from the part's framing out to the full figure; picking a part
    // again frames it again)
    const cc = els.cCanvas.current;
    const onCreatorWheel = (e: WheelEvent) => { e.preventDefault(); engine.current?.creatorPreview?.zoomBy(Math.exp(e.deltaY * 0.0012)); };
    cc?.addEventListener('wheel', onCreatorWheel, {passive: false});
    return () => { c.removeEventListener('wheel', onWheel); cc?.removeEventListener('wheel', onCreatorWheel); };
  }, []);

  // ---- looks ----
  const saveLooks = (next: SavedLook[]) => { setLooks(next); try { store.set('looks', JSON.stringify(next)); } catch { toast('Couldn’t save: this device’s storage is full'); } };
  /** The look worn, as it is shared (from Looks or the picture): under its saved name when it is a saved one. */
  // A look is shared under the name typed for it in Your looks (saved or not), else its saved name, else none (its
  // preview then names its items). `settled`: the name as it was when typing last paused, for the link field, so
  // typing asks for no link; a Share press takes the name as typed.
  const wearing = (settled = false): Shared => {
    const code = encode(model.state), typed = (settled ? live.current.nameSettled : live.current.nameDraft)?.trim();
    return {code: posed(code), place: live.current.backdrop.room ? live.current.backdrop.id : null, name: typed || live.current.looks.find(l => l.code === code)?.name || null};
  };
  /** A code as shared: with the pose the page shows (weapons out or at rest), which its link opens in and its picture shows. */
  const posed = (code: string) => withPose(code, live.current.showHeld && !live.current.designing);
  const lookName = (st: State) => {
    const pick = (['torso', 'head', 'cape', 'weapon'] as EquipSlot[]).map(s => st.equip[s] && (index.items.get(st.equip[s]!.item) as any)?.name).filter(Boolean);
    // (within the name field's 48 characters: the first two items' names, the first alone when both are long)
    const two = pick.slice(0, 2).join(' + '), name = two.length <= 48 ? two : String(pick[0]);
    return pick.length ? [...name].slice(0, 48).join('').trim() : `${st.gender === 'male' ? 'Male' : 'Female'} character`;
  };
  const lookThumb = () => new Promise<string>(res => {
    const img = new Image();
    img.onload = () => {
      // the character: a square around the middle of the view, 120 px
      const side = Math.min(img.width, img.height) * 0.62, x = (img.width - side) / 2, y = img.height * 0.5 - side / 2;
      const sq = document.createElement('canvas'); sq.width = sq.height = 120;
      const g = sq.getContext('2d')!; g.fillStyle = '#14171d'; g.fillRect(0, 0, 120, 120); g.drawImage(img, x, y, side, side, 0, 0, 120, 120);
      res(sq.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => res('');
    img.src = engine.current!.viewer.snapshot();
  });
  // it hangs from its button, whatever the bar's height (phones' is taller)
  const placeLooks = () => { const b = els.share.current; if (b) setLooksTop(b.getBoundingClientRect().bottom + 6); };
  const closeLooks = () => setLooksOpen(false);
  const wearLook = (l: SavedLook) => {
    const st = decode(l.code); if (!st) return;
    model.set(st);
    const pl = BACKDROPS.find(b => b.room && b.id === placeId(l.place)); if (pl && pl !== live.current.backdrop) setBackdrop(pl, false);
  };

  // ---- the toolbar's Share: the look's link and its preview picture as the link shows it (the same pose, view and
  // corner mark), drawn here at twice its size; the pose can be switched there (it is the page's Weapons out) ----
  // (Share takes the character as it stands: whatever plays is frozen where it is, the view as it is, until the sheet
  // closes; posed with the Pause, then shared)
  const pausedBefore = useRef(false);
  const openShare = () => { pausedBefore.current = animPause; setAnimPause(true); setShareOpen(true); };
  const closePicture = () => { setShareOpen(false); setAnimPause(pausedBefore.current); setPicture(p => { if (p?.url) URL.revokeObjectURL(p.url); return null; }); };
  useEffect(() => {
    if (!shareOpen) return;
    let gone = false;
    setPicture(p => { if (p?.url) URL.revokeObjectURL(p.url); return null; });
    void (async () => {
      // (once the look's parts and its pose are in: a look just put on, a saved one shared from the list, waits for
      // its parts; whatever was asked for last, should a newer ask overtake one)
      for (const ready of [partsReady, poseReady]) for (let p = ready.current; ; p = ready.current) { await p.catch(() => {}); if (gone || p === ready.current) break; }
      while (!gone && engine.current?.viewer.loadingParts) await new Promise(r => setTimeout(r, 100));
      const e = engine.current; if (gone || !e) return;
      const k = 2, [w, h] = [PICTURE_SIZE[0] * k, PICTURE_SIZE[1] * k];
      const v = e.viewer, shot = new Image(); shot.src = v.picture(w, h, {...v.want}, v.yaw); await shot.decode().catch(() => {});
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d')!; paintBackdrop(g, BACKDROPS[0], w, h); g.drawImage(shot, 0, 0); await pictureMark(g, w, h, k);
      const blob = await new Promise<Blob | null>(res => c.toBlob(res, 'image/png'));
      if (!gone) setPicture({blob, url: blob ? URL.createObjectURL(blob) : ''});
    })();
    return () => { gone = true; };
  }, [shareOpen, model.version]);

  // ---- keys and the address ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current.active) return;
      const typing = (e.target as HTMLElement)?.matches?.('input, textarea');
      if (live.current.designing) {
        if (e.key === 'Escape') { cancelCreator(); return; }
        // keep focus in the dialog
        if (e.key === 'Tab') {
          const f = [...els.creator.current!.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter(x => (x as any).getClientRects().length > 0);
          const i = f.indexOf(document.activeElement as HTMLElement);
          if (e.shiftKey ? i <= 0 : i === f.length - 1 || i < 0) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0]?.focus(); }
          return;
        }
        if (typing) return;
        const st = model.state, cat = SEG_STYLE[live.current.selected], col = SEG_COLOUR[live.current.selected];
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cat) { e.preventDefault(); st.style[cat] += e.key === 'ArrowLeft' ? -1 : 1; edited(); }
        else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && col) { e.preventDefault(); const n = paletteFor(live.current.selected)!.length; st.colour[col] = (((st.colour[col] + (e.key === 'ArrowUp' ? -1 : 1)) % n) + n) % n; edited(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) model.redo(); else model.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); model.redo(); }
      // Escape closes what is open, the topmost first: the looks, the background menu, then the worn item's choices
      else if (e.key === 'Escape') {
        const w = engine.current?.wardrobe;
        if (live.current.looksOpen) { closeLooks(); els.share.current?.focus(); }
        else if (live.current.bgMode) setBgMode(false);
        else if (live.current.animMode) setAnimMode(false);
        else if (live.current.bgOpen) setBgOpen(false);
        else if (w?.root.classList.contains('adjusting')) w.setAdjusting(false, true);
      }
      // ] folds the equipment panel
      else if (e.key === ']' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) { e.preventDefault(); setPanelCollapsed(!live.current.panelCollapsed); }
    };
    // a link pasted into this tab: like opening it fresh
    const onHash = () => {
      if (!live.current.active) return;
      const {code, place} = addressLook(), s = decode(code);
      const pl = BACKDROPS.find(b => b.room && b.id === place); if (pl && pl !== live.current.backdrop) setBackdrop(pl, false);
      if (s && encode(s) !== encode(model.state)) model.set(s);
      const pose = lookPose(code); if (pose != null) setShowHeld(pose);
    };
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (live.current.bgOpen && !live.current.bgMode && !els.bgPop.current?.contains(t) && !els.bgBtn.current?.contains(t)) setBgOpen(false);
      if (live.current.looksOpen && !els.looks.current?.contains(t)) closeLooks();
    };
    window.addEventListener('keydown', onKey); window.addEventListener('hashchange', onHash); document.addEventListener('click', onDocClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); document.removeEventListener('click', onDocClick); };
  }, []);
  // hidden: nothing draws; shown: the view as it was, and a look the address may now name (back and forward)
  const wasRunning = useRef({page: true, design: false});
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const e = engine.current; if (!e) return;
    if (!active) { wasRunning.current = {page: e.viewer.running, design: !!e.creatorPreview?.running}; e.viewer.running = false; if (e.creatorPreview) e.creatorPreview.running = false; return; }
    e.viewer.running = wasRunning.current.page; if (e.creatorPreview) e.creatorPreview.running = wasRunning.current.design;
    const s = decode(addressLook().code); if (s && encode(s) !== encode(model.state)) model.set(s);
    else history.replaceState(null, '', addressOf(encode(model.state)));
  }, [active]);

  const paletteFor = (seg: string): string[] | null => {
    const cat = SEG_COLOUR[seg];
    if (!cat) return null;
    if (cat === 'hair') {
      // HAIR shows the fabric colours while the head wrap is the style (as the game's screen does)
      const st = model.state, list = pack.creator.styles.hair[st.gender];
      const opt = list[((st.style.hair % list.length) + list.length) % list.length];
      return pack.parts[opt.parts[0]]?.r1 === '$hair_fabric' ? pack.creator.palettes.fabric : pack.creator.palettes.hair;
    }
    return pack.creator.palettes[cat];
  };

  // ---- drawing ----
  const isPhone = phone();
  const designingShared = designing && sharedView, controlsInStage = designing && !sharedView;
  const equipOn = !designing && !panelCollapsed && !bgMode && !animMode;
  const viewerHeight = isPhone && !panelCollapsed && split ? `${(Math.max(0.22, Math.min(0.72, split)) * 100).toFixed(3)}%` : undefined;
  const verb = panelCollapsed ? 'Show' : 'Hide';
  const shareField = (l: Shared) => <ShareField key={shortKey(l)} look={l} />;

  const bgPop = (
    <div ref={els.bgPop} className="of-bgpop" hidden={!bgOpen} role="menu"
      // the menu by keyboard: ↑ ↓ move, Esc closes back to its button
      onKeyDown={e => {
        const items = ([...els.bgPop.current!.querySelectorAll('summary, button:not(:disabled)')] as HTMLElement[]).filter(n => n.offsetParent !== null), at = items.indexOf(document.activeElement as HTMLElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setBgOpen(false); els.bgBtn.current?.focus(); }
      }}
      // keyboard: Tab out of the menu closes it. (Only when focus lands somewhere: a tap on iOS takes focus from the
      // menu without giving it to anything, and closing then would swallow the tap on the item.)
      onBlur={e => { const to = e.relatedTarget as Node | null; if (to && !els.bgPop.current!.contains(to) && to !== els.bgBtn.current) closeBg(false); }}>
      {/* two sections, both folded at first, so their titles show at a glance */}
      <details className="of-bgsec" data-sec="background">
        <summary><Icon name="image" />Background</summary>
        <div className="of-bghead">Colours</div>
        {BACKDROPS.filter(b => !b.room).map(b => <BgItem key={b.id} b={b} on={backdrop.id === b.id} pick={() => { setBackdrop(b); closeBg(true); }} />)}
        <div className="of-bghead">3D Scenes</div>
        {BACKDROPS.filter(b => b.room).map(b => <BgItem key={b.id} b={b} on={backdrop.id === b.id} pick={() => { setBackdrop(b); closeBg(true); }} />)}
        <div className="of-bghead">Ground</div>
        {FLOORS.map(([id, name]) => (
          // the disc under the character is for the colours: a place's floor takes the character's own shadow
          <button key={id} role="menuitemradio" aria-checked={floor === id} data-floor={id} className={floor === id ? 'on' : undefined}
            disabled={!!backdrop.room} title={backdrop.room ? 'A place shows the character’s own shadow on its ground' : ''}
            onClick={() => { setFloor(id); closeBg(true); }}><span className={`of-bgdot floor-${id}`} />{name}</button>
        ))}
      </details>
      <details className="of-bgsec" data-sec="random">
        <summary><Icon name="dice" />Random equipment button</summary>
        <div className="rs-checks">
          {([['allowEmpty', 'Include empty slots', 'Off: every slot gets something'], ['dyes', 'Include random dye colours', 'Off: dyeable pieces keep the neutral colour'], ['weapons', 'Include weapons and shields', 'Off: the hands stay empty']] as const).map(([k, label, hint]) => (
            <label key={k} className="of-check rs-check" title={hint}><input type="checkbox" checked={rs[k]} onChange={e => setRs({...rs, [k]: e.target.checked})} /><span>{label}</span></label>
          ))}
        </div>
        <div className="rs-label">Include faction</div>
        <div className="chips rs-faction" role="group" aria-label="Include faction">
          {(['all', 'Guardian', 'Hammermage', 'Cryoknight', 'Guard'] as const).map(f => <button key={f} type="button" className={rs.faction === f ? 'on' : undefined} aria-pressed={rs.faction === f} onClick={() => setRs({...rs, faction: f})}>{f === 'all' ? 'All' : f}</button>)}
        </div>
        <button type="button" className="rs-reset" onClick={() => setRs({...RANDOM_DEFAULTS})}>Reset to defaults</button>
      </details>
      <details className="of-bgsec" data-sec="rendering">
        <summary><Icon name="sun" />Rendering</summary>
        {backdrop.room && <div className="rd-note">A 3D scene is drawn by the game itself, with its own light and shadows: these apply to the colour backgrounds.</div>}
        <div className="rs-label">Lighting</div>
        <div className="chips rd-lighting" role="group" aria-label="Lighting">
          {([['game', 'Game', 'As the game lights characters: its sun and sky, the shine of metal and gold, glowing parts'], ['studio', 'Studio', 'Soft studio lights, as Brighter Fashion had before']] as const).map(([k, label, hint]) =>
            <button key={k} type="button" title={hint} className={rend.lighting === k ? 'on' : undefined} aria-pressed={rend.lighting === k} onClick={() => setRend({...rend, lighting: k})}>{label}</button>)}
        </div>
        <div className="rs-checks">
          {([['shadows', 'Shadows', 'The character’s own shadow from the sun, and on the ground'], ['glow', 'Glowing parts', 'Eyes, runes and trims that glow in the game']] as const).map(([k, label, hint]) => (
            <Fragment key={k}>
              <label className="of-check rs-check" title={hint}><input type="checkbox" checked={rend[k]} disabled={rend.lighting !== 'game'} onChange={e => setRend({...rend, [k]: e.target.checked})} /><span>{label}</span></label>
              {/* (so a face without its shadow in the designer is not taken for a fault) */}
              {k === 'shadows' && rend.shadows && rend.lighting === 'game' && <div className="rd-hint">Off while designing your character</div>}
            </Fragment>
          ))}
        </div>
        {([['sunTurn', 'Sun direction', -180, 180, (v: number) => v === 0 ? 'as in the game' : `${v > 0 ? '+' : ''}${v}°`], ['sunHeight', 'Sun height', 10, 85, (v: number) => v === RENDERING_DEFAULTS.sunHeight ? 'as in the game' : `${v}°`]] as const).map(([k, label, min, max, say]) => (
          <label key={k} className="rd-range">
            <span className="rs-label">{label} <b>{say(rend[k])}</b></span>
            <input type="range" min={min} max={max} step={5} value={rend[k]} disabled={rend.lighting !== 'game'} aria-label={label} onChange={e => setRend({...rend, [k]: Number(e.target.value)})} />
          </label>
        ))}
        <button type="button" className="rs-reset" onClick={() => setRend({...RENDERING_DEFAULTS})}>Reset to the game’s</button>
      </details>
    </div>
  );
  // the column of round buttons on the view, from the top: what the drawer shows (the character's design, the
  // equipment), then the outfit's effect (when it has one), weapons out, and the settings (background, ground, random outfit)
  const controls = (
    <div className="of-controls" style={columnBottom ? {bottom: columnBottom} : undefined}>
      <button className={`btn of-pose of-mode-btn${designing ? ' active' : ''}`} aria-pressed={designing} title="Design your character: face, body and hair" aria-label="Character" onClick={() => modeClick(true)}><Icon name="mask" /></button>
      <button className={`btn of-pose of-mode-btn${equipOn ? ' active' : ''}`} aria-pressed={equipOn} title="Equipment: what your character wears" aria-label="Equipment" onClick={() => modeClick(false)}><Icon name="torso" /></button>
      <button className={`btn of-pose of-fx${showEffects ? ' active' : ''}`} hidden={!fx.length} title="Show or hide the particle effect this outfit gives off" aria-label="Effect" aria-pressed={showEffects}
        onClick={() => { const on = !showEffects; setShowEffects(on); store.set('fx', on ? '1' : '0'); }}><span className="fx-glyph" aria-hidden="true"><Icon name="sparkles" /></span></button>
      <button className={`btn of-pose${fighting ? ' active' : ''}`} hidden={(designing || !armed) && UNARMED == null} aria-label="Weapons out" aria-pressed={fighting}
        title={designing || !state.equip.weapon ? (showHeld ? 'Fists up, in the combat-ready stance, as the game does with no weapon. Click to stand at rest' : 'At rest. Click to put your fists up, in the combat-ready stance, as the game does with no weapon')
          : showHeld ? 'Weapons out, in the combat-ready stance. Click to put them away, as the game shows you out of combat' : 'Weapons away. Click to take them out, in the combat-ready stance'}
        onClick={() => setShowHeld(h => !h)}><Icon name="sword" /></button>
      <button className={`btn of-pose of-anim-btn${animMode ? ' active' : ''}`} hidden={!pack.animationCount} aria-pressed={animMode} aria-label="Animations"
        title="Animations: play the game's emotes and other animations on your character" onClick={toggleAnimMode}><Icon name="wave" /></button>
    </div>
  );
  // the settings: on the view's toolbar, right of redo (phones: the drawer's settings mode; wider screens: a menu below it)
  const settingsButton = (
    <div className="of-bg of-bg-top">
      <button ref={els.bgBtn} className={`btn-mini of-icon of-bgbtn${bgMode ? ' active' : ''}`} aria-haspopup="menu" aria-label="Settings" title="Settings: background, ground, the random outfit and rendering"
        aria-expanded={bgTouched && !isPhone ? bgOpen : undefined} aria-pressed={isPhone ? bgMode : undefined}
        onClick={e => {
          e.stopPropagation();
          if (phone()) { toggleBgMode(); return; }   // (phones: one of the drawer's modes)
          setBgTouched(true); setBgOpen(o => !o);
        }}><Icon name="gear" /></button>
      {!bgMode && bgPop}
    </div>
  );
  useEffect(() => { if (bgOpen && !bgMode) (els.bgPop.current?.querySelector('button.on') as HTMLElement ?? els.bgPop.current?.querySelector('button'))?.focus(); }, [bgOpen]);
  useEffect(() => { if (looksOpen) placeLooks(); }, [looksOpen]);
  useEffect(() => { if (designing) (els.creator.current?.querySelector('.creator-actions .btn-cta') as HTMLElement)?.focus({preventScroll: true}); }, [designing]);
  const now = wearing(), nowSettled = wearing(true), current = looks.find(l => l.code === encode(state));

  return (
    <div id="fashion" className={`fashion${PICTURE ? ' picture' : ''}${bgMode ? ' bg-mode' : ''}${animMode ? ' anim-mode' : ''}${panelCollapsed ? ' panel-collapsed' : ''}${designing ? ' designing' : ''}${designingShared ? ' designing-shared' : ''}`}>
      <main ref={els.main} onScroll={e => { const m = e.currentTarget; if (m.scrollTop) m.scrollTop = 0; }}>
        <section ref={els.viewer} className="of-viewer" style={{background: cssOf(backdrop), height: viewerHeight}} data-loading={parts.loading ? '1' : ''}>
          <canvas ref={els.canvas} className={opened ? undefined : 'wait'} tabIndex={0} aria-label="Your character. Drag to turn, scroll or pinch to zoom, arrow keys turn."
            onDoubleClick={() => { const v = engine.current!.viewer; v.yaw = 0; v.yawVel = 0; v.frameTo(frameOf('full')); setCurrentFrame('full'); }}
            onKeyDown={e => { const v = engine.current!.viewer; if (e.key === 'ArrowLeft') v.yawVel += 1.6; else if (e.key === 'ArrowRight') v.yawVel -= 1.6; }} />
          {/* a place loading: a ring that fills (spins while the load cannot say how far it is); it never takes a tap */}
          <div className={`of-placeload load-card${placeShown && placeLoad!.progress == null ? ' spin' : ''}`} hidden={!placeShown} role="status"
            aria-label={placeShown ? `Loading ${placeLoad!.name}${placeLoad!.progress != null ? `, ${Math.round(placeLoad!.progress * 100)}%` : ''}` : undefined}
            data-progress={placeShown && placeLoad!.progress != null ? String(Math.round(placeLoad!.progress * 100)) : undefined}>
            <svg viewBox="0 0 44 44" aria-hidden="true"><circle className="pl-track" cx="22" cy="22" r="19" /><circle className="pl-fill" cx="22" cy="22" r="19" style={placeShown && placeLoad!.progress != null ? {strokeDashoffset: String(119.4 * (1 - placeLoad!.progress))} : undefined} /></svg>
          </div>
          {/* the one way into face and body (Male/Female and a random look are there, in Body) */}
          <div className="of-charcard"><button className="btn of-design" aria-label="Character: face, body and hair" title="Design your character: face, body and hair" onClick={() => openCreator()}><Icon name="person" />Character</button></div>
          <div id="toast" role="status" aria-live="polite" className={toastMsg && toastMsg.n > 0 ? 'show' : undefined}>{toastMsg?.text}</div>
          {PICTURE && <div className="of-picmark"><img src="/brand/mark.svg" alt="" /><span><b className="brand-name">Brighter</b> Fashion</span></div>}
          {/* the view's own toolbar, along its top on the right: undo, redo, the picture, the looks */}
          <div id="of-toolbar" className="of-toolbar">
            <button id="undo" className="btn-mini of-icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={designing || !model.past.length} onClick={() => model.undo()}><Ic d="M9 7H4V2M4 7a9 9 0 1 1-1.5 9" /></button>
            <button id="redo" className="btn-mini of-icon" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={designing || !model.future.length} onClick={() => model.redo()}><Ic d="M15 7h5V2M20 7a9 9 0 1 0 1.5 9" /></button>
            {settingsButton}
            <button ref={els.share} id="share" className={`btn-mini of-share${looksOpen ? ' active' : ''}`} aria-pressed={looksOpen} title="Your looks: save this one, wear a saved one, share a link" aria-haspopup="dialog" aria-expanded={looksTouched ? looksOpen : undefined}
              onClick={e => { e.stopPropagation(); setLooksTouched(true); setLooksOpen(o => !o); }}><Ic d="M6 3h12v18l-6-4-6 4z" /><span>Looks</span></button>
            {/* (the one primary button, at the far right: sharing a look is what the page leads to) */}
            <button id="share-now" className={`btn-mini of-icon-sm of-primary${shareOpen ? ' active' : ''}`} title="Share this look: its picture, and a link to it that shows the picture where it is posted" aria-label="Share"
              aria-haspopup="dialog" aria-pressed={shareOpen} onClick={e => { e.stopPropagation(); closeLooks(); openShare(); }}><Icon name="share" /><span>Share</span></button>
          </div>
          {/* (last: over the toast and the toolbar, where the designer's coming and going has always left it) */}
          {!controlsInStage && controls}
        </section>
        <aside ref={els.right} className={`of-right${opened ? '' : ' wait'}`} id="of-right" onScroll={e => { const r = e.currentTarget; if (r.scrollTop) r.scrollTop = 0; }}
          onClickCapture={e => { if (live.current.panelCollapsed && (e.target as HTMLElement).closest('.slot')) setPanelCollapsed(false); }}>
          {/* the wardrobe panel collapses and resizes. Desktop: a chevron pull-tab on its inner edge folds it to a
              rail ( ] toggles it). Phones: a grab bar between the character and the wardrobe; drag it to share the
              height, tap it to fold the wardrobe away to just the bar. */}
          <div ref={els.grip} className="of-grip" role="separator" aria-orientation="horizontal" tabIndex={0} aria-label="Drag to resize the character view, tap to fold the equipment away"
            onPointerDown={onGripDown} onKeyDown={e => { if (phone() && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setPanelCollapsed(!panelCollapsed); } }}>
            <span className="of-grip-bar" />
            <button className="of-panel-toggle" aria-controls="of-right" onClick={() => setPanelCollapsed(!panelCollapsed)}
              title={`${verb} the equipment panel${isPhone ? '' : '  ( ] )'}`} aria-label={`${verb} the equipment panel`} aria-expanded={!panelCollapsed}>
              {isPhone ? (panelCollapsed ? '⌃' : '⌄') : (panelCollapsed ? '‹' : '›')}
            </button>
          </div>
          {/* (the wardrobe's own section follows, wardrobe.ts; phones in Settings mode: the settings menu after it) */}
          {bgMode && <BgSlot>{bgPop}</BgSlot>}
          {animMode && <AnimationsPanel gender={state.gender} tab={animTab} setTab={setAnimTab} playing={anim} started={!!anim && animRun?.anim.key === anim.key}
            moves={combatMoves} fighting={fighting && !designing} weapon={heldWeapon?.name ?? null} armed={!!state.equip.weapon} takeOut={() => { live.current.showHeld = true; setShowHeld(true); }}
            repeat={animRepeat} setRepeat={setAnimRepeat} pause={animPause} setPause={setAnimPause}
            play={(a: AnimItem) => { setAnimPause(false); setAnim(anim && anim.clip === a.clip ? null : {clip: a.clip, loop: !!a.loop, ticks: a.ticks ?? 0, name: a.name, group: a.group, fx: a.fx, parts: a.parts, props: a.props, actors: a.actors, part: 0, key: ++animKeys.current}); }} />}
        </aside>
      </main>
      <div className="of-rotate" role="alert"><Ic><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></Ic><b>Turn your phone upright</b><span>Brighter Fashion is made for holding your phone this way up.</span></div>
      <div ref={els.creator} className="creator" role="dialog" aria-modal="true" aria-label="Design your character" hidden={!designing}
        onPointerDownCapture={() => { if (!designUsed.current) { designUsed.current = true; warmStyles(); } }} onKeyDownCapture={() => { if (!designUsed.current) { designUsed.current = true; warmStyles(); } }}>
        <div className="creator-box">
          <div className="creator-bar"><h2>Design your character</h2></div>
          <div ref={els.body} className="creator-body" style={{'--stage-h': stageH ?? (cSplit ? `${(cSplit * 100).toFixed(3)}%` : '')} as React.CSSProperties}>
            <div ref={els.stage} className="creator-stage" style={designing ? {background: cssOf(backdrop)} : undefined}>
              <canvas ref={els.cCanvas} aria-label="Preview: drag to turn, scroll to zoom" /><span className="stage-hint">Drag to turn</span>
              {controlsInStage && controls}
            </div>
            <div ref={els.cGrip} className="of-grip creator-grip" role="separator" aria-orientation="horizontal" aria-label="Drag to resize the character view" onPointerDown={onCGripDown}><span className="of-grip-bar" /></div>
            <div className="creator-drawer">
              {/* only Cancel and Done stay put; everything else scrolls with the choices below */}
              <div className="creator-actions"><span className="creator-title">Character Designer</span><span className="creator-gap" />
                <span className="creator-end">
                  <button className="btn" title="Discard these changes (Esc)" onClick={() => cancelCreator()}>Cancel</button>
                  <button className="btn btn-cta" title="Keep these changes" onClick={() => closeCreator()}>Done</button>
                </span>
              </div>
              <div ref={els.panel} className="creator-panel">
                {designing && <DesignerPanel state={state} selected={selected} pack={pack} paletteFor={paletteFor} edited={edited}
                  select={id => { const same = live.current.selected === id; live.current.selected = id; setSelected(id); warmStyles(); if (same) frameCreator(); }} randomise={() => { model.state = randomise(pack, model.state); edited(); }}
                  startOver={() => { model.state = {...structuredClone(DEFAULT_LOOK), equip: model.state.equip}; edited(); }} />}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div ref={els.looks} className="of-looks" role="dialog" aria-label="Your looks" hidden={!looksOpen} style={looksOpen ? {top: `${looksTop}px`, maxHeight: `calc(100dvh - ${looksTop + 10}px)`} : undefined}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closeLooks(); els.share.current?.focus(); } }}>
        {/* (what the panel is, and the way out: the Looks button, pressed while it is open, closes it too) */}
        <div className="lk-top"><b>Your looks</b>
          <button type="button" className="btn-mini of-icon lk-close" aria-label="Close your looks" title="Close" onClick={() => { closeLooks(); els.share.current?.focus(); }}><Icon name="x" /></button></div>
        {looksOpen && <Looks now={now} nowSettled={nowSettled} current={current} looks={looks} name={nameDraft ?? current?.name ?? lookName(state)} setName={setNameDraft} shareField={shareField}
          share={l => { wearLook(l); closeLooks(); openShare(); }} wear={wearLook} remove={l => saveLooks(looks.filter(x => x !== l))}
          save={async (label, place) => {
            const thumb = await lookThumb(), name = label.trim() || lookName(model.state), code = encode(model.state);
            const cur = live.current.looks.find(l => l.code === code);
            saveLooks(cur ? live.current.looks.map(l => l === cur ? {...l, name, thumb, place, at: Date.now()} : l) : [{id: Math.random().toString(36).slice(2, 10), name, code, place, thumb, at: Date.now()}, ...live.current.looks]);
          }} />}
      </div>
      {bubbleAt && <CopiedBubble key={bubbleAt.n} at={bubbleAt} gone={() => setBubbleAt(null)} />}
      {shareOpen && <PictureSheet picture={picture} close={closePicture} shareField={shareField(nowSettled)} />}
    </div>
  );
}

/** The drawer's Settings mode (phones): the settings menu (background, ground, random outfit), in the wardrobe's place after it. */
function BgSlot({children}: {children: ReactNode}) { return <>{children}</>; }

/** One animation the drawer offers (the pack's: an emote or another of the player's named clips). */
interface AnimItem { clip: number; name: string; group: string; loop?: boolean; ticks?: number; gender?: 'male' | 'female'; emote?: boolean; icon?: number; iconRotated?: boolean;
  /** A three-piece animation's parts (intro, loop and, where it has one, outro), played in turn; `clip` is the first. */
  parts?: {clip: number; ticks?: number}[];
  /** An attack's aim: the angle the game plays it at (degrees above the level, below when negative). */
  aim?: number;
  /** Its particle effects: the systems its controller names, where a loop clip starts in its controller, and the body type where there is one for each. */
  fx?: {system: number; offset?: number; gender?: 'male' | 'female'}[];
  /** What it holds while it plays (a tool, a book, a snowball): parts on the player's rig, in the weapons' place. */
  props?: any[];
  /** Its other figures (a rod, a rift, a snowball in flight): parts on a rig of their own (render.ts AnimActor). */
  actors?: {skel: number; parts: any[]; clips: (number | null)[]; at?: number[] | null; fx?: number[]; thrown?: {release: number; flight: number; distance: number}}[] }
type AnimTab = 'emotes' | 'combat' | 'more';
// a tile's picture where the game has none: the kind's own icon (the defeat its own)
const KIND_ICON: Record<string, string> = {Everyday: 'person', Professions: 'hammer', Magic: 'sparkles', Combat: 'swords'};
/** The Animations drawer: three tabs (the game's emotes, the moves of the pose and weapon, the rest by kind), every
 *  animation a tile; a tap plays it, a tap on the one playing stops it; Repeat and Pause beside the title. */
function AnimationsPanel({gender, tab, setTab, playing, started, moves, fighting, weapon, armed, takeOut, repeat, setRepeat, pause, setPause, play}: {gender: string | number, tab: AnimTab, setTab: (t: AnimTab) => void,
    playing: {clip: number, name: string, loop: boolean} | null, started: boolean, moves: AnimItem[], fighting: boolean, weapon: string | null, armed: boolean, takeOut: () => void,
    repeat: boolean, setRepeat: (on: boolean) => void, pause: boolean, setPause: (on: boolean) => void, play: (a: AnimItem) => void}) {
  const g = gender === 1 || gender === 'female' ? 'female' : 'male';
  const mine = (a: AnimItem) => !a.gender || a.gender === g;
  // (what the tab's animations hold, fetched as it opens: a tool is in hand from the first frame)
  useEffect(() => { if (tab === 'more') prefetch(ANIMATIONS.flatMap(a => propParts(a.props))); }, [tab, ANIMATIONS.length]);
  const all = (ANIMATIONS as AnimItem[]).filter(mine);
  const emotes = all.filter(a => a.emote);
  // (the moves of the pose and weapon, then the defeat: it fits every pose)
  const combat = [...moves.filter(mine), ...all.filter(a => a.group === 'Combat')];
  const groups = new Map<string, AnimItem[]>();
  for (const a of all) if (!a.emote && a.group !== 'Combat') { if (!groups.has(a.group)) groups.set(a.group, []); groups.get(a.group)!.push(a); }
  const secs = (t?: number) => t ? `${(t / 600).toFixed(1)} s` : '';
  // the one playing: a wheel while its clip is fetched, then its progress across it (the game's 600 ticks a second;
  // round and round when it repeats, full when it stops on its last frame)
  const tile = (a: AnimItem) => {
    const on = playing?.clip === a.clip, run = on && started;
    return <button key={`${a.clip}/${a.name}`} type="button" className={`of-tile${a.emote ? ' emote' : ''}${a.group === 'Combat' ? ' combat' : ''}${on ? ' on' : ''}${on ? (run ? ' running' : ' loading') : ''}`}
      aria-pressed={on} aria-busy={on && !started} title={`${a.name}${a.aim != null ? ` · aims ${a.aim ? `${Math.abs(a.aim)}° ${a.aim > 0 ? 'up' : 'down'}` : 'straight ahead'}` : ''} · ${secs(a.ticks)}${on ? ' · tap to stop' : ''}`} onClick={() => play(a)}>
      {run && a.ticks ? <span key={`${repeat || playing!.loop}`} className="of-anim-bar" aria-hidden="true" style={{animationDuration: `${a.ticks / 0.6}ms`, animationIterationCount: repeat || playing!.loop ? 'infinite' : 1, animationPlayState: pause ? 'paused' : 'running'}} /> : null}
      {/* (loading: the site's own loading ring in the picture's place) */}
      {on && !started ? <span className="of-tile-pic of-tile-load" role="progressbar" aria-label={`Loading ${a.name}`}><span className="load-card spin">
        <svg viewBox="0 0 44 44" aria-hidden="true"><circle className="pl-track" cx="22" cy="22" r="19" /><circle className="pl-fill" cx="22" cy="22" r="19" /></svg></span></span>
      : a.emote ? (a.icon != null ? <img src={at(`icon/${a.icon}`)} alt="" loading="lazy" className={a.iconRotated ? 'turned' : undefined} /> : <span className="of-tile-pic" />)
        : <span className="of-tile-pic"><Icon name={a.name === 'Defeated' ? 'skull' : KIND_ICON[a.group] ?? 'wave'} /></span>}
      <span className="of-tile-name">{a.name}</span>
    </button>;
  };
  const toggle = (on: boolean, set: (on: boolean) => void, icon: string, label: string, title: string) =>
    <button type="button" className={`btn-mini of-icon of-anims-tog${on ? ' active' : ''}`} aria-pressed={on} aria-label={label} title={title} onClick={() => set(!on)}><Icon name={icon} /></button>;
  const TABS: [AnimTab, string][] = [['emotes', 'Emotes'], ['combat', 'Combat'], ['more', 'More']];
  return (
    <Drawer className="of-anims" label="Animations">
      {/* (one row: the kinds, then Repeat and Pause) */}
      <div className="of-anims-head">
        <div className="of-anims-tabs" role="tablist" aria-label="Kinds of animation">
          {TABS.map(([k, label]) => <button key={k} type="button" role="tab" id={`anim-tab-${k}`} aria-selected={tab === k} aria-controls="anim-panel" className={tab === k ? 'on' : undefined} onClick={() => setTab(k)}>
            {label}</button>)}
        </div>
        {toggle(repeat, setRepeat, 'repeat', 'Repeat', 'Repeat: play it again and again')}
        {toggle(pause, setPause, 'hold', 'Pause', pause ? 'Paused: tap to go on' : 'Pause: freeze your character where it is')}
      </div>
      <div className="of-anims-list of-drawer-list" id="anim-panel" role="tabpanel" aria-labelledby={`anim-tab-${tab}`}>
        {!ANIMATIONS.length ? <div className="empty">Loading animations…</div>
          : tab === 'emotes' ? <div className="of-tiles">{emotes.map(tile)}</div>
          : tab === 'combat' ? <>
            <div className="group combat"><span>{fighting ? 'Moves' : 'At rest'}</span><b>{fighting ? weapon ?? 'Fists' : ''}</b></div>
            <div className="of-tiles">
              {!fighting && <button type="button" className="of-tile cta" onClick={takeOut}><span className="of-tile-pic"><Icon name="sword" /></span><span className="of-tile-name">{armed ? 'Weapons out' : 'Fists up'}</span></button>}
              {combat.map(tile)}
            </div>
            {!fighting && <p className="of-anims-hint">{armed ? 'Take your weapons out to see their moves.' : 'Put your fists up to see their moves, or try on a weapon for its own.'}</p>}
          </>
          : [...groups].map(([k, items]) => <Fragment key={k}><div className="group">{k}</div><div className="of-tiles">{items.map(tile)}</div></Fragment>)}
      </div>
    </Drawer>
  );
}

/** A drawer of the side panel: the equipment's insets, gap and scrolling list (css `.of-drawer`, `.of-drawer-list`,
 *  sized by `--drawer-*` on `.fashion`), the same for every drawer, the wardrobe's own included. */
function Drawer({className, label, children}: {className?: string, label: string, children: ReactNode}) {
  return <section className={`of-drawer${className ? ` ${className}` : ''}`} aria-label={label}>{children}</section>;
}

function BgItem({b, on, pick}: {b: Backdrop, on: boolean, pick: () => void}) {
  return <button role="menuitemradio" aria-checked={on} data-bg={b.id} className={on ? 'on' : undefined} onClick={pick}><span className={`of-bgdot${b.room ? ' place' : ''}`} style={{background: swatchOf(b)}} />{b.name}</button>;
}

type Bubble = {x: number, y: number, text: string, n?: number};
/** Say something where a click or tap was (near `from`, or its pointer): "Copied to clipboard". */
function bubble(from: HTMLElement | null | undefined, text: string) {
  const r = from?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.top : innerHeight / 2;
  dispatchEvent(new CustomEvent<Bubble>('fashion-bubble', {detail: {x, y, text}}));
}
/** Copy a link, and say so where the button is; a browser that will not copy: said, the field left to copy from. */
async function copyLink(url: string, from?: HTMLElement | null): Promise<boolean> {
  try { await navigator.clipboard.writeText(url); bubble(from, 'Copied to clipboard'); return true; }
  catch { bubble(from, touch ? 'Tap and hold the link to copy it' : 'Press Ctrl+C to copy the link'); return false; }
}
function CopiedBubble({at, gone}: {at: Bubble, gone: () => void}) {
  useEffect(() => { const t = setTimeout(gone, 1800); return () => clearTimeout(t); }, []);
  const x = Math.max(90, Math.min(innerWidth - 90, at.x)), y = Math.max(50, at.y);
  return <div className="of-bubble" role="status" aria-live="polite" style={{left: `${x}px`, top: `${y}px`}}>
    {/copied/i.test(at.text) && <span className="of-bubble-tick" aria-hidden="true">✓</span>}{at.text}
  </div>;
}

/** A look's link, wherever it is shared (the looks' panel, the picture): the short link in a field, selected to
 *  copy, with Copy beside it (and a phone's Share); a wheel in the button while it is made; Try again when none
 *  came. Never the look's long address on the site. */
function ShareField({look}: {look: Shared}) {
  const [url, setUrl] = useState<string | null>(settled.get(shortKey(look)) ?? null);
  const [state, setState] = useState<'getting' | 'ready' | 'failed'>(url ? 'ready' : 'getting');
  const field = useRef<HTMLInputElement>(null), alive = useRef(true);
  const ask = () => {
    setState('getting');
    void askShort(look).then(got => {
      if (!alive.current) return;
      const link = got ?? (DEV ? lookUrl(look) : null);
      setUrl(link); setState(link ? 'ready' : 'failed');
    });
  };
  useEffect(() => { alive.current = true; if (!url) ask(); return () => { alive.current = false; }; }, []);
  // (ready: the link selected, to copy at once; not on a phone, where selecting pops up its own menu)
  useEffect(() => { if (state === 'ready' && !touch) field.current?.select(); }, [state]);
  const copy = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (state === 'failed') { ask(); return; }
    if (!url) return;
    const btn = e.currentTarget;
    void copyLink(url, btn).then(ok => { if (!ok) { field.current?.focus(); field.current?.select(); } });
  };
  const share = async () => { if (url) try { await navigator.share({title: look.name || 'My Brighter Shores look', url}); } catch { /* cancelled */ } };
  return (
    <div className={`share-field ${state}`}>
      <input ref={field} className="share-url" readOnly aria-label="Link to this look" value={url ?? ''}
        placeholder={state === 'failed' ? 'Could not make a link' : 'Getting link…'} onFocus={e => e.currentTarget.select()} onClick={e => e.currentTarget.select()} />
      <button type="button" className="btn btn-cta share-copy" disabled={state === 'getting'} onClick={copy}
        title={state === 'failed' ? 'Ask for the link again' : 'Copy the link'}>
        {state === 'getting' ? <span className="share-wheel" aria-label="Getting link" /> : state === 'failed' ? 'Try again' : 'Copy'}
      </button>
      {touch && typeof navigator.share === 'function' && <button type="button" className="btn share-send" disabled={state !== 'ready'} onClick={() => void share()} aria-label="Share"><Icon name="share" /></button>}
    </div>
  );
}

function Looks({now, nowSettled, current, looks, name, setName, shareField, share, wear, remove, save}: {
  now: Shared, nowSettled: Shared, current: SavedLook | undefined, looks: SavedLook[], name: string, setName: (n: string) => void, shareField: (l: Shared) => ReactNode,
  share: (l: SavedLook, from: HTMLElement) => void, wear: (l: SavedLook) => void, remove: (l: SavedLook) => void, save: (label: string, place: string | null) => Promise<void>,
}) {
  // (every saved look's short link asked for as the looks open, so any row's Share is ready at once)
  useEffect(() => { for (const l of looks) void askShort(l); }, [looks]);
  const doSave = () => void save(name, now.place);
  return <>
    <div className="lk-head"><b>This look</b></div>
    {shareField(nowSettled)}
    <div className="lk-save">
      <input className="lk-name" value={name} aria-label="Name" maxLength={48} enterKeyHint="done" onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } }} />
      <button className="btn" onClick={doSave}>{current ? 'Update' : 'Save'}</button>
    </div>
    <div className="lk-head"><b>{`Saved looks${looks.length ? ` (${looks.length})` : ''}`}</b></div>
    {looks.length ? <div className="lk-list">{looks.map(l => {
      const on = l === current;
      return (
        <div key={l.id} className={`lk-row${on ? ' on' : ''}`}>
          <button className="lk-wear" title={on ? 'Wearing this look' : 'Wear this look'} onClick={() => wear(l)}>
            {l.thumb ? <img src={l.thumb} alt="" /> : <span className="lk-noimg"><Icon name="torso" /></span>}
            <span className="lk-text"><span className="lk-title">{l.name}</span><span className="lk-sub">{on ? 'Wearing' : new Date(l.at).toLocaleDateString()}</span></span>
          </button>
          <button className="btn-mini of-icon" title="Share this look: wears it and opens Share (Undo goes back)" aria-label={`Share ${l.name}`} onClick={e => { e.stopPropagation(); share(l, e.currentTarget); }}><Icon name="share" /></button>
          <button className="btn-mini of-icon" title="Delete this look" aria-label={`Delete ${l.name}`} onClick={() => remove(l)}><Icon name="x" /></button>
        </div>
      );
    })}</div> : <p className="lk-empty">Looks you save appear here, on this device. Open a shared link and save it to keep it.</p>}
  </>;
}

function DesignerPanel({state, selected, pack, paletteFor, edited, select, randomise, startOver}: {
  state: State, selected: string, pack: any, paletteFor: (seg: string) => string[] | null, edited: () => void, select: (id: string) => void, randomise: () => void, startOver: () => void,
}) {
  const cat = SEG_STYLE[selected], col = SEG_COLOUR[selected], pal = paletteFor(selected);
  const section = (title: string, value: string | null, body: ReactNode) =>
    <section className="cp-section"><div className="cp-head"><span>{title}</span>{value ? <b>{value}</b> : null}</div>{body}</section>;
  const n = cat ? pack.creator.styles[cat][state.gender].length : 0, i = cat ? ((state.style[cat] % n) + n) % n : 0;
  const ci = col && pal ? ((state.colour[col] % pal.length) + pal.length) % pal.length : 0;
  return <>
    <div className="cp-tools"><div className="cp-row">
      <button className="btn cp-random" title="A random face, hair and clothes underneath" onClick={randomise}><Icon name="dice" />Random</button>
      <button className="btn cp-random" title="Back to the default character (your equipment stays)" onClick={startOver}><Icon name="reset" />Start over</button>
    </div></div>
    {section('Body', null, <div className="cp-row"><div className="segmented cp-gender">{(['male', 'female'] as const).map(g =>
      <button key={g} className={state.gender === g ? 'on' : ''} aria-pressed={state.gender === g} onClick={() => { if (state.gender !== g) { state.gender = g; edited(); } }}>{g === 'male' ? 'Male' : 'Female'}</button>)}</div></div>)}
    {section('Part', null, <div className="cp-parts" role="tablist">{SEG_NAMES.map(([id, name]) =>
      <button key={id} className={id === selected ? 'on' : ''} role="tab" data-part={id} aria-selected={id === selected} onClick={() => select(id)}>{name}</button>)}</div>)}
    {cat && section('Style', `${i + 1} of ${n}`, <div className="cp-step">
      <button className="btn cp-prev" aria-label="Previous style" onClick={() => { state.style[cat] -= 1; edited(); }}><Icon name="turnLeft" /></button>
      <input type="range" className="cp-range" min="1" max={String(n)} value={String(i + 1)} aria-label="Style" onChange={e => { state.style[cat] = Number(e.target.value) - 1; edited(); }} />
      <button className="btn cp-next" aria-label="Next style" onClick={() => { state.style[cat] += 1; edited(); }}><Icon name="turnRight" /></button>
    </div>)}
    {col && pal && section('Colour', `${ci + 1} of ${pal.length}`, <div className="swatches cp-colours">{pal.map((c, k) =>
      <button key={k} className={`swatch${k === ci ? ' on' : ''}`} aria-pressed={k === ci} style={{background: c}} aria-label={`Colour ${k + 1}`} onClick={() => { state.colour[col] = k; edited(); }} />)}</div>)}
    <p className="creator-keys">Keys: ← → style, ↑ ↓ colour, Esc to cancel.</p>
  </>;
}

// The picture, on a page of its own, with the site's mark: Share link (the look's link, as Looks shares it) is
// the way to share it; phones save it by pressing and holding the picture, desktops with Download.
function PictureSheet({picture, close, shareField}: {picture: {blob: Blob | null, url: string} | null, close: () => void, shareField: ReactNode}) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  // (Escape closes it wherever focus is, and focus goes back to what opened it)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    closeBtn.current?.focus();
    return () => { document.removeEventListener('keydown', onKey, true); opener?.focus?.(); };
  }, []);
  return (
    <div className="of-picture" role="dialog" aria-modal="true" aria-labelledby="pic-title" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="pic-box">
        <div className="pic-top"><h2 id="pic-title">Share your look</h2>
          <button type="button" className="btn-mini of-icon pic-x" aria-label="Close" title="Close" onClick={close}><Icon name="x" /></button></div>
        {/* the character as it stands, frozen where it was when Share was pressed, seen as the view sees it */}
        <div className="pic-frame">
          {picture?.url ? <img src={picture.url} alt="Your look, as it stands" /> : <div className="pic-wait" aria-label="Drawing the picture"><span className="share-wheel" /></div>}
        </div>
        <p>{touch ? 'Press and hold the picture to save it. The link shows it wherever you post it.' : 'The link shows this picture wherever you post it.'}</p>
        <div className="pic-share">{shareField}</div>
        <div className="pic-actions">
          <button ref={closeBtn} className="btn" onClick={close}>Close</button>
          {!touch && <button className="btn" disabled={!picture?.blob} onClick={() => {
            if (!picture) return;
            const a = document.createElement('a'); a.href = picture.url; a.download = 'brighter-atlas-fashion.png'; document.body.append(a); a.click(); a.remove();
          }}><Icon name="download" />Download picture</button>}
        </div>
      </div>
    </div>
  );
}
