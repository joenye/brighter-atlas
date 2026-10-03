// Brighter Fashion (/fashion): a full-body character viewer with every piece of player equipment, and the
// client's "Design your character" screen for the body, composed exactly as the client composes a player
// (compose.ts). The look lives in the address (look-code.ts), is remembered on this device, and has undo
// (look-model.ts). The drawing is render.ts's (the character, a place behind it); the equipment panel is
// wardrobe.ts's.
import {Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import * as THREE from '../../vendor/three.module.js';
import {at, DEV} from './data.js';
import {compose, makeIndex, randomise, itemParts, hiddenItems, propParts, itemAppearance, EQUIP_SLOTS} from './compose.js';
import type {State, EquipSlot, StyleCat, ColourCat, Worn} from './compose.js';
import {Preview, FRAMES, prefetch, Thumbnailer, report, forgetCaches, RENDERING_DEFAULTS, configureRendering, type Rendering, type Crop} from './render.js';
import {Wardrobe, icon, forgetWardrobe, PATHS, FACTIONS, factionOf, takesDye, dyesFor, twoHandedItem, type Faction} from './wardrobe.js';
import {Mp4Writer, avcCodec} from './mp4-mux.js';
import {gifHead, gifJoin} from '../viewers/gif-encoder.js';
import {DEFAULT_LOOK, encodeLook, decodeLook, placeId, addressLook, withPose, lookPose, withShot, lookShot, type Shot} from './look-code.js';
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
// how the plain view is drawn (Settings, Lighting), kept on this device
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
// ---- downloads: a picture, a GIF or a video of the look, made from the record view (the crop over the character),
// on the page's background or transparent (nothing behind the character, no shadow, no mark); any other: the mark in
// the lower right ----
type SaveFmt = 'picture' | 'gif' | 'video';
type Shape = 'wide' | 'square' | 'tall' | 'free';
interface RecOpts {
  fmt: SaveFmt; clear: boolean; shape: Shape; crop: Crop | null;
  // (More options)
  quality: 'standard' | 'high'; fps: number; plays: number; turns: number;
}
const REC_DEFAULTS: RecOpts = {fmt: 'picture', clear: false, shape: 'wide', crop: null, quality: 'standard', fps: 0, plays: 1, turns: 0};
const SHAPE_RATIO: Record<Exclude<Shape, 'free'>, number> = {wide: 16 / 9, square: 1, tall: 9 / 16};
// (the file's long edge; High for those who want it sharp: 4K pictures, big GIFs, 1440p video)
const LONG_EDGE: Record<SaveFmt, Record<RecOpts['quality'], number>> = {picture: {standard: 1920, high: 3840}, gif: {standard: 640, high: 1080}, video: {standard: 1920, high: 2560}};
// (a GIF's frames last whole hundredths of a second: only rates that divide 100 play at their true pace)
const FPS_CHOICES: Record<SaveFmt, number[]> = {picture: [], gif: [10, 20, 25, 50], video: [24, 30, 60]};
const FPS_DEFAULT: Record<SaveFmt, number> = {picture: 0, gif: 25, video: 30};
const fpsOf = (o: RecOpts) => FPS_CHOICES[o.fmt].includes(o.fps) ? o.fps : FPS_DEFAULT[o.fmt];
// (what a file of each kind weighs a pixel, measured on this page's looks: for the size it is said to be)
const BYTES_PER_PX: Record<SaveFmt, number> = {picture: 0.65, gif: 0.1, video: 0};
const SPIN_MS = 4000;       // (how long a save with no animation runs: the idle's whole loops, about this long)
const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
const megabytes = (bytes: number) => bytes < 1e6 ? 'under 1 MB' : `about ${bytes < 10e6 ? (bytes / 1e6).toFixed(0) : Math.round(bytes / 5e6) * 5} MB`;
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const loadRec = (): RecOpts => {
  try { const o = JSON.parse(localStorage.getItem('fashion.rec') ?? 'null'); return o && typeof o === 'object' ? {...REC_DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([k]) => k in REC_DEFAULTS))} : {...REC_DEFAULTS}; }
  catch { return {...REC_DEFAULTS}; }
};
const keepRec = (o: RecOpts) => { try { localStorage.setItem('fashion.rec', JSON.stringify(o)); } catch {} };
/** The crop a shape gives a view `vw` x `vh` pixels: as large as fits inside a margin, centred. */
function cropFor(shape: Exclude<Shape, 'free'>, vw: number, vh: number): Crop {
  const r = SHAPE_RATIO[shape], mw = vw * 0.86, mh = vh * 0.8;
  const [w, h] = mw / mh > r ? [mh * r, mh] : [mw, mw / r];
  return {x: (vw - w) / 2 / vw, y: (vh - h) / 2 / vh, w: w / vw, h: h / vh};
}
/** The file's size: the crop's own shape, at the long edge the format and quality ask. */
function outSize(o: RecOpts, crop: Crop, vw: number, vh: number): [number, number] {
  const r = (crop.w * vw) / Math.max(1, crop.h * vh), long = LONG_EDGE[o.fmt][o.quality];
  return r >= 1 ? [even(long), even(long / r)] : [even(long * r), even(long)];
}
/** Hand a file over: a download (on a phone still in the tap that asked, its own share sheet: Save Image, Save Video). */
async function deliver(blob: Blob, name: string) {
  const file = new File([blob], name, {type: blob.type});
  if (touch && (navigator as any).userActivation?.isActive && navigator.canShare?.({files: [file]})) {
    try { await navigator.share({files: [file]}); return; } catch (e: any) { if (e?.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// how far a shot flies with no foe to aim at (tiles of 1024 units)
const SHOT_TILES = 4;
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
  /** The worn weapon's pieces (held records): [0] the weapon, then what goes with it (a bow's arrow). */
  const weaponPieces = (st: State): number[] => { const ap = itemAppearance(pack, index, st.equip.weapon, st.gender); return ap?.a.held != null ? [ap.a.held, ...(ap.a.also ?? [])] : []; };
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
  // (the picture of a shared moment: the view Share had, and the animation stopped where it was)
  const pictureShot = useMemo(() => PICTURE ? lookShot(addressLook().code) : null, []);
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
  // (the looks: a drawer of the side panel, as the animations are, in the equipment's place)
  const [looksOpen, setLooksOpen] = useState(false);
  // (Share or download: the record view, with its drawer)
  const [shareOpen, setShareOpen] = useState(false);
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
  function setBgMode(on: boolean) { if (live.current.bgMode === on) return; if (on) { setAnimMode(false); closeLooks(); } live.current.bgMode = on; setBgModeState(on); setBgOpen(on); }
  function setAnimMode(on: boolean) {
    if (live.current.animMode === on) return; if (on) { setBgMode(false); closeLooks(); } live.current.animMode = on; setAnimModeState(on);
    if (on) void loadAnimations()?.then(() => setAnimListVersion(v => v + 1));
  }
  // (the equipment or the designer opened mid-animation stops it; the drawer folded away by its own button, or
  // Escape, leaves it playing)
  const stopAnimation = () => { setAnim(null); setLastAnim(null); setAnimPause(false); };
  // the animation played last: after a one-off ends it can still be saved, and its timeline stays (resting at its end)
  // till another is played or it is stopped
  const [lastAnim, setLastAnim] = useState<typeof anim>(null);
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
  const openCharacter = () => { setBgMode(false); setAnimMode(false); closeLooks(); stopAnimation(); if (live.current.panelCollapsed) setPanelCollapsed(false); openCreator(); };
  const modeClick = (designingBtn: boolean) => {
    // (Equipment or Character pressed: what plays stops and a pause lets go, the Animations drawer open or folded)
    const looksWere = live.current.looksOpen;
    stopAnimation(); closeLooks();
    // (Character with no drawer brings the page's back first: the view and its column sit above the designer's)
    if (designingBtn) { if (!live.current.designing) openCharacter(); else { closeCreator(); setPanelCollapsed(true); } }
    else if (live.current.designing) { leaveDesigner(); setPanelCollapsed(false); }
    else if (live.current.bgMode) setBgMode(false);
    else if (live.current.animMode) setAnimMode(false);
    else if (looksWere) { /* (the looks drawer gave way to the equipment) */ }
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
      if (PICTURE) { const sv = pictureShot?.v; viewer.yaw = sv ? sv[0] / 1000 : PICTURE_YAW; viewer.yawVel = 0; viewer.frameTo(sv ? {dist: sv[1], target: sv[2]} : PICTURE_FRAMING, true); }
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
    // (a ranged weapon's pieces, drawn by the state of its attack: the arrow loosed leaves the bow)
    const w = st.equip.weapon ? pack.items.find((i: any) => i.id === st.equip.weapon?.item) : null, pieces = weaponPieces(st);
    e.viewer.setInHand(w?.inHand && pieces.length ? {piece: new Map(pieces.map((id, i) => [id, i])), states: w.inHand.states, shots: w.inHand.shots.map((x: any) => x.release),
      attackClips: new Set((w.moves ?? []).filter((m: any) => m.aim != null).map((m: any) => m.clip))} : null);
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
    actorsReady.current = v.setAnimActors(animActors ? animActors.map(a => ({...a, parts: a.parts.some((p: any) => p?.key) ? a.parts : propParts(a.parts)})) : null, anim ? anim.parts?.map(p => p.clip) ?? [anim.clip] : []);
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
      // (an animation's first clip starts once what it holds, its figures and its particles' pictures are in: none
      // of them shows on the pose before it, nor late, nor as a stand-in)
      const fxSystems = playing ? (playing.fx ?? []).filter(f => !f.gender || f.gender === state.gender).map(f => f.system) : [];
      const first = !!playing && playing.part === 0 && !!(playing.props?.length || playing.actors?.length || fxSystems.length);
      const start = () => e.viewer.setClip(clip, top, held, !!playing, !(playing && playing.part > 0));
      poseReady.current = first ? Promise.all([partsReady.current, actorsReady.current, e.viewer.effectsReady(fxSystems).catch(() => {})]).then(() => animStarted.current === playing ? start() : undefined) : start();
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
  // (a ranged attack sends its pieces off as the game launches them: each shot's piece as the hand last held it, from
  // its release straight ahead at the game's 37.5 ticks a tile; with no foe to aim at, SHOT_TILES tiles)
  const shotsOf = (m: any): Pick<AnimItem, 'actors'> => {
    const shots = heldWeapon?.inHand?.shots ?? [], pieces = weaponPieces(state);
    if (m.aim == null || !shots.length || !pieces.length) return {};
    const look = compose(pack, index, state);
    return {actors: shots.filter((x: any) => pieces[x.el] != null).map((x: any) => ({skel: pack.skeleton, clips: [m.clip],
      parts: look.filter(p => p.key.endsWith(`/h${pieces[x.el]}`)).map(p => ({...p, key: `${p.key}/shot`})),
      thrown: {release: x.release, flight: Math.round(SHOT_TILES * 37.5), distance: SHOT_TILES * 1024, ...(x.bone != null ? {bone: x.bone} : {})}}))};
  };
  const combatMoves: AnimItem[] = fighting && !designing ? ((heldWeapon ? heldWeapon.moves : pack.unarmedMoves) ?? []).map((m: any) => ({...m, group: 'Combat', ...(heldWeapon ? shotsOf(m) : {})})) : [];
  // a one-shot animation plays once (the game's 600 ticks a second), then the pose it interrupted comes back; Repeat
  // plays it again and again; Pause at end keeps its last frame until stopped
  // (counted on the animations' own clock from when it began to play: a clip still on its way plays whole, and a
  // pause holds it)
  // A three-piece animation goes on to its next part as one ends (to the first again on Repeat).
  useEffect(() => {
    const v = engine.current?.viewer;
    if (!v || !anim || anim.loop || animPause || !anim.ticks || animRun?.anim !== anim || (animRepeat && !anim.parts)) return;
    if (shotFreeze.current && anim.part === shotFreeze.current.part) return;   // (a shared moment's picture stops in it)
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
  // ---- the animation's timeline (the drawer's slider): its parts' lengths, where it is, a jump to any moment ----
  const partsMs = (a: NonNullable<typeof anim>) => {
    const v = engine.current?.viewer;
    return (a.parts ?? [{clip: a.clip, ticks: a.ticks}]).map((p, i) => ({clip: p.clip, ms: (p.ticks || (i === a.part && v ? v.clipDuration() : 0)) / 0.6}));
  };
  const seekWant = useRef<{part: number, local: number, total: number} | null>(null);
  const seekTo = (a: NonNullable<typeof anim>, ms: number) => {
    const v = engine.current?.viewer; if (!v) return;
    setAnimPause(true); v.paused = true;
    const ps = partsMs(a); let part = 0, before = 0;
    while (part < ps.length - 1 && ms >= before + ps[part].ms) { before += ps[part].ms; part++; }
    const local = Math.max(0, Math.min(ms - before, ps[part].ms - 1)), fx = (a.fx ?? []).filter(f => !f.gender || f.gender === live.current.state.gender);
    // (another part, or the animation over: it starts there again, then is moved to the moment)
    if (a !== anim) { const again = {...a, part, key: ++animKeys.current}; seekWant.current = {part, local, total: ms}; setAnim(again); setLastAnim(again); return; }
    if (part !== a.part) { seekWant.current = {part, local, total: ms}; setAnim(x => x === a ? {...a, part} : x); return; }
    void v.seek(local, fx, ms, !a.parts && (animRepeat || a.loop));
  };
  const ended = !anim && lastAnim ? lastAnim : null;
  const timeline: Timeline | null = ended ? {
    id: `${ended.key}-end`, name: ended.name, total: partsMs(ended).reduce((t, p) => t + p.ms, 0),
    at: () => partsMs(ended).reduce((t, p) => t + p.ms, 0), seek: ms => seekTo(ended, ms),
  } : anim && animRun?.anim === anim ? {
    id: `${anim.key}`, name: anim.name, total: partsMs(anim).reduce((t, p) => t + p.ms, 0),
    at: () => {
      const v = engine.current?.viewer; if (!v || !anim) return 0;
      const ps = partsMs(anim), before = ps.slice(0, anim.part).reduce((t, p) => t + p.ms, 0), len = ps[anim.part]?.ms || 1, el = v.clipElapsed();
      return before + (!anim.parts && (anim.loop || animRepeat) ? el % len : Math.min(el, len));
    },
    seek: ms => seekTo(anim, ms),
  } : null;
  useEffect(() => {
    const w = seekWant.current, v = engine.current?.viewer;
    if (!w || !v || !anim || animRun?.anim !== anim || anim.part !== w.part) return;
    seekWant.current = null;
    void v.seek(w.local, (anim.fx ?? []).filter(f => !f.gender || f.gender === live.current.state.gender), w.total);
  }, [animRun]);
  const playOf = (a: AnimItem) => ({clip: a.clip, loop: !!a.loop, ticks: a.ticks ?? 0, name: a.name, group: a.group, fx: a.fx, parts: a.parts, props: a.props, actors: a.actors, part: 0, key: ++animKeys.current});
  // The picture page of a shared moment plays its animation from the start and stops it on the moment's tick (the
  // clock stands there exactly, whatever the frames' pace), and only then says it is drawn.
  const shotFreeze = useRef<{part: number, ms: number, armed: boolean} | null>(null), shotPending = useRef(!!pictureShot?.a);
  const pictureReady = () => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
    if (!live.current.parts.loading && !shotPending.current) document.documentElement.dataset.picture = 'ready';
  }, 120)));
  const shotDone = () => { shotFreeze.current = null; if (shotPending.current) { shotPending.current = false; pictureReady(); } };
  useEffect(() => {
    const a = pictureShot?.a; if (!a || !opened) return;
    const giveUp = setTimeout(shotDone, 12000);   // (a moment that cannot be shown: the look without it)
    // (once a frame of the resting pose is drawn: a close framing follows the head from where it rests, as the page
    // that shared it did)
    const rested = new Promise<void>(done => { const until = performance.now() + 3000, wait = () => engine.current?.viewer.restKnown || performance.now() > until ? done() : requestAnimationFrame(wait); wait(); });
    void Promise.all([loadAnimations(), rested]).then(() => {
      const [name, part, tick] = a, g = live.current.state.gender;
      const item = [...combatMoves, ...(ANIMATIONS as AnimItem[]).filter(x => !x.gender || x.gender === g)].find(x => x.name === name);
      if (!item) { shotDone(); return; }
      shotFreeze.current = {part: Math.max(0, Math.min(part, (item.parts?.length ?? 1) - 1)), ms: tick / 0.6, armed: false};
      setAnimPause(false); setAnim(playOf(item));
    });
    return () => clearTimeout(giveUp);
  }, [opened]);
  useEffect(() => {
    const f = shotFreeze.current, v = engine.current?.viewer;
    if (!f || f.armed || !v || !anim || animRun?.anim !== anim || anim.part !== f.part) return;
    f.armed = true;
    v.freezeAt(f.ms, () => { setAnimPause(true); shotDone(); });
  }, [animRun]);
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
    if (PICTURE && !parts.loading && !parts.first) pictureReady();
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
    const onResize = () => { soon(); setViewportTick(t => t + 1); };
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
  const closeLooks = () => { live.current.looksOpen = false; setLooksOpen(false); };
  // (the Looks button: the looks in the drawer, in place of the equipment, the animations or the background; again: away)
  const toggleLooks = () => {
    if (live.current.looksOpen) { closeLooks(); return; }
    if (live.current.designing) leaveDesigner();
    setAnimMode(false); setBgMode(false); setPanelCollapsed(false);
    live.current.looksOpen = true; setLooksOpen(true);
  };
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
  // ---- Share: the drawer with the link to the look and, opened below it, its download. While the download is open
  // the view is the record view: the crop over it is what a download holds (the background and shadow as they will
  // be, the mark where it goes), and only turning, zooming and the crop work on it ----
  const shareShot = useRef<Shot | null>(null);
  const sheetOpen = useRef(false);
  const [rec, setRecState] = useState<RecOpts>(loadRec);
  const setRec = (patch: Partial<RecOpts>) => setRecState(x => { const n = {...x, ...patch}; keepRec(n); return n; });
  const [dlOpen, setDlOpen] = useState(() => store.get('dlOpen') === '1');
  const toggleDl = () => setDlOpen(o => { store.set('dlOpen', o ? '0' : '1'); return !o; });
  const recView = shareOpen && dlOpen;
  /** The moment as it stands: an animation paused part way (none while one plays), and the view. */
  const momentNow = (): Shot | null => {
    const v = engine.current?.viewer; if (!v) return null;
    const turn = Math.PI * 2, playing = anim && animRun?.anim === anim ? anim : null;
    // (a looping one: within its one turn, so a picture of it never waits long)
    const tick = Math.round(v.clipElapsed() * 0.6);
    const at = playing && v.paused ? Math.max(0, (playing.loop || (animRepeat && !playing.parts)) && v.clipDuration() ? tick % v.clipDuration() : tick) : null;
    return {a: playing && at != null ? [playing.name, playing.part, at] : null, v: [Math.round((((v.yaw % turn) + turn) % turn) * 1000), Math.round(v.want.dist), Math.round(v.want.target)]};
  };
  const momentRef = useRef(momentNow); momentRef.current = momentNow;
  // (the link follows the moment: once the view has kept still a moment, so turning it asks for no links)
  const [linkShot, setLinkShot] = useState<Shot | null>(null);
  useEffect(() => {
    if (!shareOpen) return;
    let seen = '', last = JSON.stringify(shareShot.current);
    const t = setInterval(() => {
      const s = momentRef.current(), k = JSON.stringify(s);
      if (k === seen && k !== last) { last = k; shareShot.current = s; setLinkShot(s); }
      seen = k;
    }, 700);
    return () => clearInterval(t);
  }, [shareOpen]);
  const openShare = () => {
    sheetOpen.current = true;
    pausedBefore.current = animPause;
    // (an animation playing stops where it is: the moment the link names is the one shown. With none, the character
    // goes on breathing)
    const v = engine.current?.viewer, playing = !!anim && animRun?.anim === anim;
    if (v && playing) v.paused = true;
    shareShot.current = momentNow(); setLinkShot(shareShot.current);
    if (playing) setAnimPause(true);
    setShareOpen(true); setSaveState(null);
    if (live.current.panelCollapsed) setPanelCollapsed(false);
  };
  /** What a download shows behind the look and under it: transparent (nothing, no shadow, no mark) where asked or the
   *  page's background is, and the file can be (a video cannot: the Atlas background), else the page's background (a
   *  3D place: the place itself). */
  const saveLook = (o: RecOpts) => {
    const b = live.current.backdrop, pageClear = !b.room && !b.stops.length;
    const transparent = (o.clear || pageClear) && o.fmt !== 'video', room = !transparent && !!b.room;
    const paint = transparent || room ? null : pageClear ? BACKDROPS[0] : b;
    return {transparent, room, pageClear, paint, floor: (transparent ? 'none' : 'page') as 'none' | 'page', name: transparent ? 'Transparent' : room ? b.name : paint!.name};
  };
  const recLook = saveLook(rec);
  // (the view in the record view: transparent shown as such, the place hidden meanwhile, no shadow; all back after)
  useEffect(() => {
    const v = engine.current?.viewer; if (!v) return;
    v.setRoomHidden(recView && recLook.transparent);
    v.setFloor(recView && recLook.transparent ? 'none' : floor);
  }, [recView, recLook.transparent, floor, backdrop]);
  const viewBg = recView && recLook.transparent ? cssOf(BACKDROPS.find(b => !b.room && !b.stops.length) ?? BACKDROPS[0])
    : recView && recLook.paint && recLook.paint !== backdrop ? cssOf(recLook.paint) : cssOf(backdrop);
  // the crop: a shape's, fitted to the view, or one drawn with the bars (kept as fractions of the view)
  const [viewSize, setViewSize] = useState<[number, number]>([1, 1]);
  useEffect(() => {
    const c = els.canvas.current; if (!c) return;
    const ro = new ResizeObserver(() => setViewSize([c.clientWidth || 1, c.clientHeight || 1])); ro.observe(c);
    return () => ro.disconnect();
  }, []);
  const crop: Crop = rec.shape === 'free' && rec.crop ? rec.crop : cropFor(rec.shape === 'free' ? 'wide' : rec.shape, viewSize[0], viewSize[1]);
  const [outW, outH] = outSize(rec, crop, viewSize[0], viewSize[1]);
  // the animation a download plays: the one playing, else the one played last (a one-off over can still be saved)
  const sharedAnim = () => anim ? (animRun?.anim === anim ? anim : null) : lastAnim;
  const recordPlan = (o: RecOpts) => {
    const a = sharedAnim(); if (!a) return null;
    const ps = partsMs(a), plan: {clip: number, ms: number, restart?: boolean}[] = [];
    for (let i = 0; i < o.plays; i++) ps.forEach((p, j) => plan.push({clip: p.clip, ms: p.ms, restart: j === 0}));
    return plan;
  };
  // (a save with no animation: a whole number of the pose's idle loops, about SPIN_MS, as record() draws it)
  const recordMs = (o: RecOpts) => {
    const plan = recordPlan(o); if (plan) return plan.reduce((t, p) => t + p.ms, 0);
    const idle = (engine.current?.viewer.clipDuration() ?? 0) / 0.6;
    return idle ? Math.max(1, Math.round(SPIN_MS / idle)) * idle : SPIN_MS;
  };
  // one recording at a time (the view draws one): a newer ask stops the one running, which puts the view back first
  const job = useRef<Promise<unknown>>(Promise.resolve()), jobStop = useRef<{stop: boolean} | null>(null);
  const runJob = <T,>(fn: (tok: {stop: boolean}) => Promise<T>): Promise<T> => {
    if (jobStop.current) jobStop.current.stop = true;
    const tok = {stop: false}; jobStop.current = tok;
    const p = job.current.catch(() => {}).then(() => tok.stop ? Promise.reject(new Error('stopped')) : fn(tok));
    job.current = p.catch(() => {});
    return p;
  };
  /** Make the download `o` asks, from the crop: the picture of this moment, or the animation from its start (`plays`
   *  times, turning once if asked; no animation: one turn of the pose as it stands). Fast: the frames go from the view
   *  to the encoder without the page waiting on their pixels (a video: the browser's own encoder, fed the canvas; a
   *  GIF: a worker reads and encodes each as it comes). */
  const recordLook = (o: RecOpts, cropNow: Crop, progress: (k: number) => void) => runJob(async tok => {
    // (once the look's parts and pose are in: a saved look just put on waits for its parts)
    for (const ready of [partsReady, poseReady]) for (let p = ready.current; ; p = ready.current) { await p.catch(() => {}); if (p === ready.current) break; }
    while (engine.current?.viewer.loadingParts) await new Promise(r => setTimeout(r, 100));
    const e = engine.current; if (!e) throw new Error('not ready');
    const stopped = () => { if (tok.stop) throw new Error('stopped'); };
    const v = e.viewer, look = saveLook(o), c0 = els.canvas.current!, [w, h] = outSize(o, cropNow, c0.clientWidth || 1, c0.clientHeight || 1);
    const framing = {...v.want}, yaw = v.yaw, k = Math.min(w, h) / 630;
    // (what goes behind and over every frame, drawn once)
    const layer = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    const back = look.paint ? layer() : null; if (back) paintBackdrop(back.getContext('2d')!, look.paint!, w, h);
    const mark = look.transparent ? null : layer(); if (mark) await pictureMark(mark.getContext('2d')!, w, h, k);
    const c = layer(), g = c.getContext('2d')!;
    const compose = (src: CanvasImageSource) => { g.clearRect(0, 0, w, h); if (back) g.drawImage(back, 0, 0); g.drawImage(src, 0, 0); if (mark) g.drawImage(mark, 0, 0); };
    if (o.fmt === 'picture') {
      const shot = new Image(); shot.src = v.picture(w, h, framing, yaw, look.floor, cropNow); await shot.decode().catch(() => {});
      stopped(); compose(shot); progress(1);
      return await new Promise<Blob>((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('no picture')), 'image/png'));
    }
    const a = sharedAnim(), plan = recordPlan(o), fx = a ? (a.fx ?? []).filter(f => !f.gender || f.gender === live.current.state.gender) : null, fps = fpsOf(o);
    const shoot = (each: (c: HTMLCanvasElement) => void | Promise<void>) => v.record({w, h, framing, yaw, floor: look.floor, stepMs: 1000 / fps, crop: cropNow, plan, fx,
      turn: o.turns, turnMs: SPIN_MS}, src => { stopped(); compose(src); return each(c); }, x => progress(x * 0.95));
    if (o.fmt === 'gif') {
      // (the frames shared among a few workers, each encoding as they come; put back in order at the end)
      const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
      const workers = Array.from({length: n}, () => new Worker(new URL('/js/fashion/save-worker.js', location.href), {type: 'module'}));
      const blocks: Uint8Array[] = [];
      let got = 0, sent = 0, wake: (() => void) | null = null, failed: unknown = null, watch = 0;
      const nudge = () => { const f = wake; wake = null; f?.(); };
      // (wait for the workers: as they answer, or stop)
      const until = (ok: () => boolean) => new Promise<void>((res, rej) => { const t = () => { if (failed) rej(new Error(String(failed))); else if (ok() || tok.stop) res(); else wake = t; }; t(); });
      try {
        for (const wk of workers) {
          wk.onmessage = (m: MessageEvent) => { blocks[m.data.i] = m.data.bytes; got++; nudge(); };
          wk.onerror = err => { failed = err.message || 'the GIF maker failed'; nudge(); };
          wk.postMessage({start: {w, h, delayMs: 1000 / fps, transparent: look.transparent}});
        }
        watch = window.setInterval(() => { if (tok.stop) nudge(); }, 100);   // (a stop: no waiting on the workers)
        await shoot(async cv => {
          const bmp = await createImageBitmap(cv), i = sent++;
          workers[i % n].postMessage({frame: bmp, i}, [bmp]);
          await until(() => sent - got <= 3 * n);   // (a few frames ahead of the workers, no more: memory stays small)
        });
        await until(() => got >= sent); stopped();
        return gifJoin(gifHead(w, h), blocks, 1000 / fps);
      } finally { clearInterval(watch); for (const wk of workers) wk.terminate(); }
    }
    // a video: the browser's own encoder where it has one (most do), fed the canvas itself; else one in the page
    const codec = avcCodec(w, h, fps), bitrate = o.quality === 'high' ? 20e6 : 8e6;
    const native = typeof VideoEncoder !== 'undefined' && await VideoEncoder.isConfigSupported({codec, width: w, height: h, bitrate, framerate: fps}).then(r => !!r.supported, () => false);
    if (native) {
      const mp4 = new Mp4Writer(w, h, fps);
      let failed: unknown = null;
      const enc = new VideoEncoder({output: (chunk, meta) => mp4.add(chunk, meta), error: err => { failed = err; }});
      enc.configure({codec, width: w, height: h, bitrate, framerate: fps, avc: {format: 'avc'}});
      try {
        let i = 0;
        await shoot(async cv => {
          if (failed) throw failed;
          const frame = new VideoFrame(cv, {timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps)});
          enc.encode(frame, {keyFrame: i % (fps * 2) === 0}); frame.close(); i++;
          if (enc.encodeQueueSize > 4) await new Promise<void>(r => enc.addEventListener('dequeue', () => r(), {once: true}));
        });
        stopped();
        await enc.flush(); if (failed) throw failed;
        return mp4.finish();
      } finally { if (enc.state !== 'closed') enc.close(); }
    }
    const {default: HME} = await import('../../vendor/h264-mp4-encoder.module.js' as any);
    const enc = await HME.createH264MP4Encoder(); enc.width = w; enc.height = h; enc.frameRate = fps; enc.kbps = bitrate / 1000; enc.initialize();
    try {
      const rg = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!; rg.canvas.width = w; rg.canvas.height = h;
      await shoot(cv => { rg.drawImage(cv, 0, 0); enc.addFrameRgba(rg.getImageData(0, 0, w, h).data); });
      stopped(); enc.finalize();
      const data = enc.FS.readFile(enc.outputFilename);
      try { enc.FS.unlink(enc.outputFilename); } catch {}
      return new Blob([data], {type: 'video/mp4'});
    } finally { enc.delete(); }
  });
  const saveName = (o: RecOpts) => {
    const a = o.fmt === 'picture' ? (anim ? sharedAnim() : null) : sharedAnim(), t = new Date(), hms = [t.getHours(), t.getMinutes(), t.getSeconds()].map(x => String(x).padStart(2, '0')).join('');
    return `brighter-fashion${a ? `-${slug(a.name)}` : ''}-${hms}.${({picture: 'png', gif: 'gif', video: 'mp4'} as const)[o.fmt]}`;
  };
  // the download: being made, saved, or failed; it downloads by itself once made
  const [saveState, setSaveState] = useState<{k: number} | {saved: string} | {error: string} | null>(null);
  useEffect(() => { setSaveState(st => st && 'k' in st ? st : null); }, [rec.fmt, rec.clear, rec.shape, rec.quality, rec.fps, rec.plays, rec.turns, rec.crop]);
  const download = async () => {
    const o = rec, t0 = performance.now();
    setSaveState({k: 0});
    try {
      const blob = await recordLook(o, crop, k => setSaveState({k})), name = saveName(o);
      await deliver(blob, name);
      setSaveState({saved: `Saved ${name} (${megabytes(blob.size).replace('about ', '')}, ${((performance.now() - t0) / 1000).toFixed(1)} s).`});
    } catch (e: any) {
      if (e?.message !== 'stopped') console.warn('save', e);
      setSaveState(e?.message === 'stopped' ? null : {error: 'Couldn’t make it. Try Standard quality, or try again.'});
    }
  };
  const cancelSave = () => { if (jobStop.current) jobStop.current.stop = true; setSaveState(null); };
  const closeShare = () => {
    cancelSave();
    setShareOpen(false); sheetOpen.current = false; shareShot.current = null; setLinkShot(null);
    // (a recording still running puts the view back as it was, paused, when it stops: the pause let go after)
    const was = pausedBefore.current;
    void job.current.then(() => { setAnimPause(was); const v = engine.current?.viewer; if (v) v.paused = was; });
  };

  // ---- keys and the address ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current.active || sheetOpen.current) return;
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
      if (!live.current.active || sheetOpen.current) return;
      const {code, place} = addressLook(), s = decode(code);
      const pl = BACKDROPS.find(b => b.room && b.id === place); if (pl && pl !== live.current.backdrop) setBackdrop(pl, false);
      if (s && encode(s) !== encode(model.state)) model.set(s);
      const pose = lookPose(code); if (pose != null) setShowHeld(pose);
    };
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (live.current.bgOpen && !live.current.bgMode && !els.bgPop.current?.contains(t) && !els.bgBtn.current?.contains(t)) setBgOpen(false);
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
        <summary><Icon name="sun" />Lighting</summary>
        {backdrop.room && <div className="rd-note">A 3D scene is drawn by the game itself, with its own light and shadows: these apply to the colour backgrounds.</div>}
        <div className="rs-label">Style</div>
        <div className="chips rd-lighting" role="group" aria-label="Lighting style">
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
  useEffect(() => { if (designing) (els.creator.current?.querySelector('.creator-actions .btn-cta') as HTMLElement)?.focus({preventScroll: true}); }, [designing]);
  const now = wearing(), nowSettled = wearing(true), current = looks.find(l => l.code === encode(state));

  return (
    <div id="fashion" className={`fashion${PICTURE ? ' picture' : ''}${bgMode ? ' bg-mode' : ''}${animMode ? ' anim-mode' : ''}${looksOpen ? ' looks-mode' : ''}${recView ? ' record-mode' : ''}${shareOpen ? ' share-mode' : ''}${panelCollapsed ? ' panel-collapsed' : ''}${designing ? ' designing' : ''}${designingShared ? ' designing-shared' : ''}`}>
      <main ref={els.main} onScroll={e => { const m = e.currentTarget; if (m.scrollTop) m.scrollTop = 0; }}>
        <section ref={els.viewer} className={`of-viewer${recView ? ' rec' : ''}`} style={{background: viewBg, height: viewerHeight}} data-loading={parts.loading ? '1' : ''}>
          <canvas ref={els.canvas} className={opened ? undefined : 'wait'} tabIndex={0} aria-label="Your character. Drag to turn, scroll or pinch to zoom, arrow keys turn."
            onDoubleClick={() => { const v = engine.current!.viewer; v.yaw = 0; v.yawVel = 0; v.frameTo(frameOf('full')); setCurrentFrame('full'); }}
            onKeyDown={e => { const v = engine.current!.viewer; if (e.key === 'ArrowLeft') v.yawVel += 1.6; else if (e.key === 'ArrowRight') v.yawVel -= 1.6; }} />
          {recView && <RecordOverlay crop={crop} size={[outW, outH]} mark={!recLook.transparent} view={viewSize} setCrop={c => setRec({shape: 'free', crop: c})} />}
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
            <button ref={els.share} id="share" className={`btn-mini of-share${looksOpen ? ' active' : ''}`} aria-pressed={looksOpen} title="Your looks: save this one, wear a saved one, share a link"
              onClick={e => { e.stopPropagation(); toggleLooks(); }}><Ic d="M6 3h12v18l-6-4-6 4z" /><span>Looks</span></button>
            {/* (the one primary button, at the far right: sharing a look is what the page leads to) */}
            {/* (a toggle: open, it shows pressed in, and puts Share away again) */}
            <button id="share-now" className={`btn-mini of-icon-sm of-primary${shareOpen ? ' active of-share-open' : ''}`}
              title={shareOpen ? 'Close Share and go back to dressing up' : 'Share this look: a link to it, or a picture, GIF or video of it'} aria-label="Share"
              aria-pressed={shareOpen} onClick={e => { e.stopPropagation(); if (shareOpen) closeShare(); else { closeLooks(); openShare(); } }}>
              <Icon name="share" /><span>Share</span></button>
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
          {looksOpen && <Drawer className="of-looks" label="Your looks"><div className="of-drawer-list lk-body"><Looks now={now} nowSettled={nowSettled} current={current} looks={looks} name={nameDraft ?? current?.name ?? lookName(state)} setName={setNameDraft} shareField={shareField}
            share={l => { wearLook(l); closeLooks(); openShare(); }} wear={wearLook} remove={l => saveLooks(looks.filter(x => x !== l))}
            save={async (label, place) => {
              const thumb = await lookThumb(), name = label.trim() || lookName(model.state), code = encode(model.state);
              const cur = live.current.looks.find(l => l.code === code);
              saveLooks(cur ? live.current.looks.map(l => l === cur ? {...l, name, thumb, place, at: Date.now()} : l) : [{id: Math.random().toString(36).slice(2, 10), name, code, place, thumb, at: Date.now()}, ...live.current.looks]);
            }} /></div></Drawer>}
          {shareOpen && <ShareDrawer shareField={shareField({...nowSettled, code: withShot(nowSettled.code, linkShot)})} rec={rec} setRec={setRec} dlOpen={dlOpen} toggleDl={toggleDl}
            anim={sharedAnim()?.name ?? null} timeline={timeline} paused={animPause} setPaused={p => { if (!anim && lastAnim && !p) { setAnim({...lastAnim, part: 0, key: ++animKeys.current}); } setAnimPause(p); }}
            size={[outW, outH]} ms={recordMs(rec)} look={recLook} state={saveState} download={() => void download()} cancel={cancelSave} close={closeShare} />}
          {animMode && <AnimationsPanel gender={state.gender} tab={animTab} setTab={setAnimTab} playing={anim} started={!!anim && animRun?.anim.key === anim.key}
            moves={combatMoves} fighting={fighting && !designing} weapon={heldWeapon?.name ?? null} armed={!!state.equip.weapon} takeOut={() => { live.current.showHeld = true; setShowHeld(true); }}
            repeat={animRepeat} setRepeat={setAnimRepeat} pause={animPause} setPause={setAnimPause}
            play={(a: AnimItem) => { const next = anim && anim.clip === a.clip ? null : playOf(a); setAnimPause(false); setAnim(next); setLastAnim(next); }} timeline={timeline} />}
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
      {bubbleAt && <CopiedBubble key={bubbleAt.n} at={bubbleAt} gone={() => setBubbleAt(null)} />}
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
  actors?: {skel: number; parts: any[]; clips: (number | null)[]; at?: number[] | null; fx?: number[]; thrown?: {release: number; flight: number; distance: number; bone?: number}}[] }
type AnimTab = 'emotes' | 'combat' | 'more';
// a tile's picture where the game has none: the kind's own icon (the defeat its own)
const KIND_ICON: Record<string, string> = {Everyday: 'person', Professions: 'hammer', Magic: 'sparkles', Combat: 'swords'};
/** The Animations drawer: three tabs (the game's emotes, the moves of the pose and weapon, the rest by kind), every
 *  animation a tile; a tap plays it, a tap on the one playing stops it; Repeat and Pause beside the title. */
function AnimationsPanel({gender, tab, setTab, playing, started, moves, fighting, weapon, armed, takeOut, repeat, setRepeat, pause, setPause, play, timeline}: {gender: string | number, tab: AnimTab, setTab: (t: AnimTab) => void,
    timeline: Timeline | null,
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
      {timeline && <AnimTimeline key={timeline.id} {...timeline} />}
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

/** Share, the drawer: the link to the look as it is now, first; below it the download, opened when wanted (a picture of
 *  this moment, or a GIF or video of the animation from its start), its few choices and, under More options, the rest.
 *  While the download is open the view above is its preview: the crop is what is saved. */
function ShareDrawer({shareField, rec, setRec, dlOpen, toggleDl, anim, timeline, paused, setPaused, size, ms, look, state, download, cancel, close}: {
  shareField: ReactNode, rec: RecOpts, setRec: (p: Partial<RecOpts>) => void, dlOpen: boolean, toggleDl: () => void, anim: string | null, timeline: Timeline | null,
  paused: boolean, setPaused: (p: boolean) => void, size: [number, number], ms: number, look: {transparent: boolean, pageClear: boolean, name: string},
  state: {k: number} | {saved: string} | {error: string} | null, download: () => void, cancel: () => void, close: () => void}) {
  // (Escape puts it away, as a click on Share does; while a download is being made, it stops that first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape' || (e.target as HTMLElement)?.matches?.('input[type=text], textarea')) return; e.preventDefault(); if (state && 'k' in state) cancel(); else close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close, cancel, state]);
  const [more, setMore] = useState(() => { try { return localStorage.getItem('fashion.recMore') === '1'; } catch { return false; } });
  const toggleMore = () => setMore(m => { try { localStorage.setItem('fashion.recMore', m ? '0' : '1'); } catch {} return !m; });
  const busy = !!state && 'k' in state, moving = rec.fmt !== 'picture', [w, h] = size, fps = fpsOf(rec);
  const frames = Math.round(ms * fps / 1000);
  // (a video by its bitrate, which the encoder comes in under on a look like this one)
  const bytes = rec.fmt === 'video' ? (rec.quality === 'high' ? 20e6 : 8e6) / 8 * ms / 1000 * 0.6 : w * h * (moving ? frames : 1) * BYTES_PER_PX[rec.fmt] * (look.transparent ? 0.3 : 1);
  const noun = ({picture: 'picture', gif: 'GIF', video: 'video'} as const)[rec.fmt];
  type Chip = [string, boolean, () => void, string?];
  const row = (label: string, items: Chip[]) => (
    <div className="sd-row"><span>{label}</span><div className="chips" role="group" aria-label={label}>
      {items.map(([t, on, pick, title]) => <button key={t} type="button" className={on ? 'on' : undefined} aria-pressed={on} title={title} disabled={busy} onClick={pick}>{t}</button>)}
    </div></div>
  );
  const chips = <T,>(list: readonly (readonly [T, string, string?])[], now: T | null, pick: (v: T) => void): Chip[] => list.map(([v, t, title]) => [t, now === v, () => pick(v), title]);
  // (what More options has away from its usual, named while it is shut)
  const on = [rec.quality === 'high' && 'High quality', moving && rec.fps && fps !== FPS_DEFAULT[rec.fmt] && `${fps} frames per second`,
    moving && anim && rec.plays > 1 && (rec.plays === 2 ? 'plays twice' : `plays ${rec.plays} times`), moving && rec.turns > 0 && (rec.turns === 1 ? '1 rotation' : `${rec.turns} rotations`)].filter(Boolean) as string[];
  const clearNote = rec.fmt === 'video' ? 'A video can’t be transparent' : look.pageClear ? 'Your background is transparent' : undefined;
  return (
    <Drawer className="of-sharedraw" label="Share">
      <div className="of-drawer-list sd-body">
        <section className="sd-sec sd-link" aria-label="Share a link">
          <h3>Share a link</h3>
          {shareField}
          <p className="sd-note">The link shows your look as it is now, wherever you post it.</p>
        </section>
        <section className={`sd-sec sd-dl${dlOpen ? ' open' : ''}`} aria-label="Download">
          <button type="button" className="sd-dl-toggle" aria-expanded={dlOpen} onClick={toggleDl}><Icon name="download" /><span>Download a picture, GIF or video</span><Icon name="chevron" /></button>
          {dlOpen && <>
            {timeline && <div className="sd-transport">
              <button type="button" className="btn-mini of-icon" aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play' : 'Pause'} onClick={() => setPaused(!paused)} disabled={busy}>
                <Icon name={paused ? 'play' : 'hold'} /></button>
              <AnimTimeline {...timeline} hint={false} />
            </div>}
            <div className="sd-rows">
              {row('Save as', chips([['picture', 'Picture'], ['gif', 'GIF'], ['video', 'Video']] as const, rec.fmt, f => setRec({fmt: f})))}
              <div className="sd-row"><span>Background</span><label className="of-check sd-clear" title={clearNote}>
                <input type="checkbox" checked={look.transparent} disabled={busy || !!clearNote} onChange={e => setRec({clear: e.target.checked})} />Transparent
                {!look.transparent && <em className="sd-bg">otherwise: {look.name}</em>}</label></div>
              {row('Shape', [...chips([['wide', 'Wide', '16:9'], ['square', 'Square', '1:1'], ['tall', 'Tall', '9:16, for phone stories']] as const, rec.shape, v => setRec({shape: v, crop: null})),
                ...(rec.shape === 'free' ? [['Your crop', true, () => {}, 'Drag the crop’s edges on the view'] as Chip] : [])])}
            </div>
            <button type="button" className="sd-more" aria-expanded={more} onClick={toggleMore}>More options{!more && on.length ? <em>: {on.join(', ')}</em> : null}<Icon name="chevron" /></button>
            {more && <div className="sd-rows sd-advanced">
              {row('Quality', chips([['standard', 'Standard'], ['high', 'High', 'Sharper and bigger: 4K pictures, larger GIFs, 1440p video']] as const, rec.quality, v => setRec({quality: v})))}
              {moving && row('Frames per second', FPS_CHOICES[rec.fmt].map(n => [`${n}`, fps === n, () => setRec({fps: n})] as Chip))}
              {moving && anim && row('Play', chips([[1, 'Once'], [2, 'Twice'], [3, '3 times']] as const, rec.plays, n => setRec({plays: n})))}
              {moving && row('Rotations', chips([[0, 'None'], [1, '1'], [2, '2'], [3, '3']] as const, rec.turns, v => setRec({turns: v})))}
            </div>}
            <p className="sd-sum">{moving ? `${anim ?? 'Idle'}, ${(ms / 1000).toFixed(1)} seconds · ` : ''}{w} × {h}{moving ? ` · ${fps} frames per second` : ''} · {megabytes(bytes)}</p>
            {moving && !anim && <p className="sd-note">No animation is playing: your character stands, breathing{rec.turns ? ' as it turns' : ''}.</p>}
            {state && 'error' in state && <p className="sd-warn" role="alert">{state.error}</p>}
            {state && 'saved' in state && <p className="sd-ok" role="status">{state.saved}</p>}
            <div className="sd-actions">
              <button className="btn of-primary sd-go" disabled={busy} onClick={download}>
                {busy ? <><span className="sd-bar" style={{width: `${Math.round((state as {k: number}).k * 100)}%`}} /><span>Making the {noun}… {Math.round((state as {k: number}).k * 100)}%</span></>
                  : <><Icon name="download" />Download {noun}</>}</button>
              {busy && <button className="btn" onClick={cancel}>Cancel</button>}
            </div>
          </>}
        </section>
      </div>
    </Drawer>
  );
}

/** The record view over the character: the crop (what a download holds; outside it dimmed), its edges to drag, its
 *  size and the mark where a download carries it. Turning and zooming pass through to the character. */
function RecordOverlay({crop, size, mark, view, setCrop}: {crop: Crop, size: [number, number], mark: boolean, view: [number, number], setCrop: (c: Crop) => void}) {
  const box = useRef<HTMLDivElement>(null);
  const [vw, vh] = view, pw = crop.w * vw, ph = crop.h * vh, k = Math.min(pw, ph) / 630;
  const drag = (edge: 'top' | 'bottom' | 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget as HTMLElement, r = box.current!.getBoundingClientRect(), MIN = 0.12;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      let {x: cx, y: cy, w: cw, h: ch} = crop;
      if (edge === 'left') { const right = cx + cw; cx = Math.min(x, right - MIN); cw = right - cx; }
      else if (edge === 'right') cw = Math.max(MIN, x - cx);
      else if (edge === 'top') { const bottom = cy + ch; cy = Math.min(y, bottom - MIN); ch = bottom - cy; }
      else ch = Math.max(MIN, y - cy);
      crop = {x: cx, y: cy, w: cw, h: ch};
      setCrop(crop);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  return (
    <div ref={box} className="of-rec">
      <div className="of-crop" style={{left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%`}}>
        <span className="of-crop-size">{size[0]} × {size[1]}</span>
        {mark && <span className="of-crop-mark" style={{right: 22 * k, bottom: 18 * k, gap: 9 * k, fontSize: 20 * k}}>
          <img src="/brand/mark.svg" alt="" style={{width: 30 * k, height: 30 * k}} /><span><b className="brand-name">Brighter</b> Fashion</span></span>}
        {(['top', 'bottom', 'left', 'right'] as const).map(edge => <span key={edge} className={`of-crop-bar ${edge}`} role="slider" aria-label={`Crop: ${edge} edge`}
          aria-valuenow={Math.round((edge === 'top' ? crop.y : edge === 'bottom' ? crop.y + crop.h : edge === 'left' ? crop.x : crop.x + crop.w) * 100)} aria-valuemin={0} aria-valuemax={100}
          tabIndex={0} onPointerDown={drag(edge)} />)}
      </div>
    </div>
  );
}

/** Where the animation playing is: its whole length (ms, every part), how far it has got, and a jump to any moment. */
interface Timeline { id: string; name: string; total: number; at: () => number; seek: (ms: number) => void; hint?: boolean }
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** The animation's timeline: it follows the animation as it plays; dragging it pauses there, at the moment dragged
 *  to (what Share then takes). */
function AnimTimeline({name, total, at, seek, hint: hinted = true}: Timeline) {
  const range = useRef<HTMLInputElement>(null), label = useRef<HTMLSpanElement>(null), held = useRef(false);
  // (the latest `at`: Repeat switched on changes where a moment falls)
  const now = useRef(at); now.current = at;
  // (a hint till the timeline is first used)
  const [hint, setHint] = useState(() => { try { return localStorage.getItem('fashion.timelineUsed') !== '1'; } catch { return true; } });
  useEffect(() => {
    let f = 0;
    const tick = () => {
      if (!held.current && range.current && label.current) { const t = now.current(); range.current.value = String(Math.round(t)); label.current.textContent = `${secs(t)} / ${secs(total)}`; }
      f = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(f);
  }, [total]);
  const go = (ms: number) => {
    if (label.current) label.current.textContent = `${secs(ms)} / ${secs(total)}`;
    if (hint) { setHint(false); try { localStorage.setItem('fashion.timelineUsed', '1'); } catch {} }
    seek(ms);
  };
  return (
    <div className="of-anim-time" title="Drag to stop at any moment: Share saves from there">
      <div className="of-anim-time-row">
        <span className="of-anim-time-name">{name}</span>
        <input ref={range} type="range" min={0} max={Math.max(1, Math.round(total))} step={1} defaultValue={0} aria-label={`${name}: drag to stop at a moment`}
          onPointerDown={() => { held.current = true; }} onPointerUp={() => { held.current = false; }} onBlur={() => { held.current = false; }}
          onInput={e => go(Number((e.target as HTMLInputElement).value))} />
        <span ref={label} className="of-anim-time-at" aria-hidden="true">0.0 s / {secs(total)}</span>
      </div>
      {hint && hinted && <p className="of-anim-time-hint">Drag to stop at any moment. Share saves from there.</p>}
    </div>
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

