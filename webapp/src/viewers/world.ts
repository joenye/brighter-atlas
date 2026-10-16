// World viewer: the production room renderer for the World category. Routes:
//   #/world            landing (stats + how to extract)
//   #/world/<roomId>   single room: instanced placements, category/z toggles,
//                      collision + authored-empty wireframes, animated water,
//                      lighting, flatten, hover/pin inspector
//   #/world/all        merged whole world (WebGL2): every room at its stitched
//                      position, baked static batches + GPU palette recolor,
//                      a clean loading overlay with one weighted progress bar,
//                      toggleable room-name sprites, standalone collision/empty
//                      wireframe batches that survive the graph release, and
//                      hover/pin inspection via a CPU picking index built
//                      during the bake (world/pick-index.js)
//
// Both views support session-transient placement edits while a placement is
// pinned (world/edits.js): X/Y/Z nudges + quarter-turn rotation, delete
// (button or the Delete key) and a per-view "reset edits". Single-room edits
// rewrite the instanced matrices in place; merged all-rooms edits update the
// picking index immediately and re-bake ONLY the affected bucket(s) of the
// affected cell through merged.replaceBuckets. Nothing is ever persisted.
//
// View state persists ONLY in prefs ('world', versioned: a bumped version
// discards stale saved defaults once). The routes stay plain: no view state
// is mirrored into the URL.
//
// Both views mount the world/hud.js perf overlay (fps · draws · tris, live
// load/bake stage, GPU line). destroy() (also wired to pagehide) aborts the
// room stream, the asset fetches and the merged bake, and frees every GL
// resource the view created; the renderer itself is shared and survives.

import {
  el, clear, append, kvTable, fmtInt, fmtNum, pad5, placeholderCard,
} from '../ui.js';
import { getPref, setPref } from '../prefs.js';
import { Scene3D, getRenderer, mountImmersiveControls } from './three-common.js';
import * as THREE from '../../vendor/three.module.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import WorldScene, {
  WORLD_CATEGORIES, loadRoomsWithRetry, yieldToBrowser, unbakeGeometryReflection, GIZMO_SWATCH, gizmoMaterial,
  GAME_DRAWN_LAYER, placeSkin,
} from './world/scene.js';
import { GameBakeWorker } from './world/game-geometry.js';
import { backgroundStats, backgroundTurn, setBackgroundShare } from './world/frame-budget.js';
import { FlyControls } from './world/fly-controls.js';
import {
  WorldWaterRegistry, createWaterUniforms, updateWaterSheetLights,
  collectRoomWaterTiles, buildWaterSheetGeometry, waterSheetMaterialFor,
  isWaterWallGeometry,
} from './world/water.js';
import { updateGameWaterLights } from './world/game-water.js';
import { EffectsClock, hash32 } from './world/effects-sim.js';
import { GameFrame, clusterSource, type GameScene, type GameRoomSource, type ShadowTile } from './world/game-frame.js';
import { progressVariables } from './world/individuals.js';
import { doorNeighbours } from './world/neighbours.js';
import {
  PLANE_DISTANCE_MAX, PLANE_ENDLESS, PLANE_FIELD_REACH, PLANE_GAME_DISTANCE, planeCount, planeDistance, planeField, planeMaterial, planeMeshes,
  planeUniforms, setPlaneReach, showPlaneMesh, planeTiles, type PlaneField, type PlaneSource, type PlaneTile,
} from './world/ground-plane.js';
import { renderCard, type CardSubject, type CardView } from './world/card.js';
import { REVEAL_KEY } from './model-rooms.js';
import { MergedWorld } from './world/merged.js';
import { createWorldHud, classifyGpu } from './world/hud.js';
import {
  WorldPickIndex, pickMetaZ,
  PICK_CATEGORY_MASK, PICK_UNTEXTURED_BIT, PICK_WATER_BIT,
} from './world/pick-index.js';
import { WorldEdits, editedMatrix } from './world/edits.js';
import { SHOT_RES, captureTiledPng } from './capture-common.js';
import { Rig, PlaybackBar } from './rig.js';
import {
  resolveSpawnAnim, SpawnAnimComposite, resolveShardRecolors,
} from './world/spawn-anim.js';
import { EffectBoneAnimation } from './world/effects-animation.js';
import { WorldEffectsLayer, effectInstanceKey } from './world/effects-layer.js';
import type { EffectInstanceEdit, EffectKind } from './world/effects-layer.js';
import { spriteDrawOf } from './world/effects-sprite.js';
import type { AppStore, IndexEntry } from '../store.js';

// What the world views need from the app shell (main.ts owns the full shape).
interface WorldViewApp {
  store: AppStore;
  loadSystemModels(): Promise<any[]>;
  setDetailsExtra(node: HTMLElement): void;
  [key: string]: any;
}

interface WorldViewHandle {
  root: HTMLElement;
  destroy(): void;
  [key: string]: any;
}

const SPAWN_ORIGIN_NOTES: Record<number, string> = {
  1: 'legacy inferred placement from a room volume; re-extract for authored actors',
  2: 'legacy approximate room-centre placement; re-extract for authored actors',
};
const CATEGORY_LABELS: Record<string, [string, string]> = {
  terrain: ['Terrain', '#65976f'],
  models: ['Scenery / models', '#d6b772'],
  spawns: ['NPC / enemy spawns', '#dc8268'],
  components: ['Components', '#a4aeba'],
};
// all rooms' drawing resolution, as a share of the screen's own pixels (100%: as sharp as the screen, on a 2x
// display too)
const RENDER_SCALES = [0.25, 0.5, 0.75, 1];
// all rooms' game shading distance (tiles across the ground from the camera; the last: no limit, the whole world)
const GAME_REACHES = [50, 100, 200, 400, 800, Infinity];
const TEXTURE_ANISOTROPY = 8;   // fixed: the user-facing control was removed

// Merged all-rooms ambient-effects activation policy (design 4.4): a hard cap
// on simultaneously active room effect sets, chosen by proximity to the fly
// camera and re-ranked on a slow cadence (never every frame). The +-hysteresis
// band keeps a room hovering near the boundary from thrashing activate/
// deactivate every re-rank.
const MAX_ACTIVE_MERGED = 24;               // hard cap on active room effect sets
const MERGED_ACTIVATION_RADIUS = 96;        // tiles: activation search radius
const MERGED_ACTIVATION_HYSTERESIS = 8;     // tiles: +/- band around the radius
const MERGED_ACTIVATION_INTERVAL_MS = 500;  // re-rank cadence

// Bumping this discards previously saved prefs ONCE so everyone lands on the
// current defaults (v2: water 50%, ambient 1.85, sun 2.80, no aniso control).
const STATE_VERSION = 2;

const DEFAULT_STATE = Object.freeze({
  terrain: true,
  models: true,
  spawns: true,
  components: true,
  untextured: true,
  collision: false,
  empty: false,
  ground: true,
  groundd: PLANE_ENDLESS,           // a room's ground plane distance: endless
  groundw: PLANE_GAME_DISTANCE,     // all rooms: the game's ten tiles
  neighbours: false,                // a room: also its neighbours
  neighbourfade: true,              // ... shaded as the game shades them
  names: true,
  spawnnames: false,
  inspect: false,
  water: true,
  game: true,
  gamereach: GAME_REACHES.length - 1, // all rooms: how far rooms are drawn in the game's shading (GAME_REACHES index: no limit)
  gamesteady: false,
  variants: false,                  // debug: every stage and state of a room's parts at once                // ... every room kept the same wherever the camera is (lamps, detail, shadows: more GPU memory)
  glights: true,                    // game shading: lamps, torches and fires
  gfog: true,                       // game shading: the fog of the rooms that have one
  effects: true,
  fxrest: true,                     // effects: what plays at rest
  fxextras: true,                   // ... the occasional extras of a resting set
  fxstates: false,                  // ... what owners play in their other states
  fxactions: false,                 // ... what owners play while someone uses them
  fxoneshot: false,                 // ... effects fired by an event, repeated
  fxmarkers: true,                  // ... their pick markers while inspecting
  idle: true,
  wcolor: 'auto',
  wopacity: 50,
  ambient: 1.85,
  sun: 2.8,
  shadows: false,
  flatten: false,
  merged: true,
  rscale: 3,      // RENDER_SCALES index (the screen's own pixels)
  cull: false,
  culld: 160,
  shotRes: '8k',    // high-res screenshot long-edge target (see SHOT_RES)
});
// z (level csv) and inspect are per-visit; everything else persists, except
// the settings the panel no longer offers (the plain view's water, lights,
// shadows, small-object cull and under-world surface: always their defaults,
// and the weak-GPU ones below).
const UNOFFERED = new Set(['inspect', 'water', 'wcolor', 'wopacity', 'ambient', 'sun', 'shadows', 'cull', 'culld']);
const PERSISTED = Object.keys(DEFAULT_STATE).filter((k) => !UNOFFERED.has(k));

// The view state: DEFAULT_STATE plus the per-visit z csv. Keys are also
// accessed dynamically (category toggles, the inputs registry).
interface WorldState {
  terrain: boolean; models: boolean; spawns: boolean; components: boolean;
  untextured: boolean; collision: boolean; empty: boolean; names: boolean; ground: boolean;
  groundd: number; groundw: number; neighbours: boolean; neighbourfade: boolean;
  spawnnames: boolean;
  inspect: boolean; water: boolean; game: boolean; gamereach: number; gamesteady: boolean; effects: boolean; idle: boolean;
  wcolor: string; wopacity: number; ambient: number; sun: number;
  shadows: boolean; flatten: boolean; merged: boolean;
  rscale: number; cull: boolean; culld: number;
  shotRes: string;
  z: string;
  [key: string]: any;
}

// High-res screenshot long-edge targets. The capture reads tiles back one at
// a time and streams assembled scanline rows through a zlib PNG encoder, so
// no full-frame (or even full-width) canvas is ever allocated: the only
// per-size costs are tile count (scale²), a one-tile-row scanline buffer,
// and the output blob. 64K/128K are for the patient: thousands of tiles and
// multi-gigabyte PNGs that most image viewers will refuse to open.
const isAllRoute = (): boolean => /^#\/?world\/all(\?|$)/i.test(location.hash || '');

export function createWorldView(app: WorldViewApp, entry?: IndexEntry | null): WorldViewHandle {
  if (entry) return createSceneView(app, entry, false);
  if (isAllRoute()) return createSceneView(app, null, true);
  return createLandingView(app);
}

// ------------------------------------------------------------------ landing

function createLandingView(app: WorldViewApp): WorldViewHandle {
  const root = el('div', { class: 'world-view' });
  const status = el('p', { class: 'dim', text: 'Checking for world data…' });
  const extra = el('div', {});
  root.appendChild(placeholderCard('World',
    el('p', { text: 'Walk the game\'s world room by room: terrain, placed models and spawns, rebuilt entirely from your own game files.' }),
    status,
    extra,
    el('p', { class: 'dim small' }, 'Keys: ', el('kbd', { text: '↑' }), ' ', el('kbd', { text: '↓' }), ' navigate list · ', el('kbd', { text: '/' }), ' search')));
  (async () => {
    let index: any = null;
    try { index = await app.store.worldIndex?.(); } catch { /* unavailable */ }
    if (!root.isConnected) return;
    const rooms = index?.rooms?.length || 0;
    if (rooms) {
      status.textContent = `${fmtInt(rooms)} room${rooms === 1 ? '' : 's'} extracted for this version. Pick one from the list to walk it in 3D, or sort the list by size, placements or spawns.`;
      append(extra,
        el('p', {}, el('a', { class: 'landing-cta', href: '#/world/all', text: 'Open the whole world →' }),
          el('span', { class: 'dim small', text: ' (heavy: loads every room)' })));
    } else if (app.store.versionId) {
      status.textContent = 'World hasn\'t been extracted for this version yet. '
        + 'Click the version chip in the topbar, choose "extract more", and tick World. '
        + 'It re-uses your game files and includes Meshes, Images and Rigs.';
    } else {
      status.textContent = 'This data source doesn\'t include World data.';
    }
  })();
  return { root, destroy() {} };
}

// ------------------------------------------------------------- state helpers

function loadState(allMode: boolean): WorldState {
  const saved = getPref('world');
  // Older (unversioned / previous-version) saves are discarded wholesale so
  // users pick up the new defaults exactly once.
  const usable = saved && typeof saved === 'object' && saved.v === STATE_VERSION;
  const state: WorldState = { ...DEFAULT_STATE, z: 'all' };
  if (usable) {
    for (const key of PERSISTED) {
      if (key in saved) state[key] = saved[key];
    }
  }
  state.inspect = false;
  state.z = 'all';
  if (!allMode) state.merged = DEFAULT_STATE.merged;   // room view never merges
  return state;
}

function persistState(state: WorldState): void {
  const out: Record<string, any> = { v: STATE_VERSION };
  for (const key of PERSISTED) out[key] = state[key];
  setPref('world', out);
}

// True when a current-version saved world state exists: the gate for the
// GPU-adaptive first-run defaults (a returning user's settings are never
// clobbered; stale-version saves are discarded by loadState anyway).
function hasSavedWorldState(): boolean {
  const saved = getPref('world');
  return !!(saved && typeof saved === 'object' && saved.v === STATE_VERSION);
}

// Confirm-overlay GPU warnings (public-safe copy; label interpolated).
const GPU_WARN_SOFTWARE = (label: string): string =>
  `This browser is rendering without GPU acceleration (software rendering: ${label}), `
  + 'so the whole-world view will be extremely slow. Check that hardware acceleration '
  + 'is enabled in your browser settings, then restart the browser. Performance '
  + 'settings have been set conservatively. Raise them in the HUD if it runs well.';
const GPU_WARN_INTEGRATED = (label: string): string =>
  `This browser is running on integrated graphics (${label}). The whole-world view `
  + 'is heavy and may run at a low frame rate. If this machine also has a dedicated '
  + 'GPU, tell your OS to run your browser on it (Windows 11: Settings → System → '
  + 'Display → Graphics → add your browser → High performance; then restart the '
  + 'browser). Performance settings have been set conservatively. Raise them in '
  + 'the HUD if it runs well.';

// ---------------------------------------------------------------- room view

function createSceneView(app: WorldViewApp, entry: IndexEntry | null, allMode: boolean): WorldViewHandle {
  const state = loadState(allMode);

  const root = el('div', { class: 'viewer-pane world-view' });
  const toolbar = el('div', { class: 'viewer-toolbar' });
  const host = el('div', { class: 'canvas-host' });
  root.append(toolbar, host);

  const title = entry
    ? `${entry.name || 'Room'} · #${entry.i}`
    : 'The whole world';
  toolbar.appendChild(el('span', { class: 'viewer-title', text: title }));
  if (entry?.w && entry?.h) {
    toolbar.appendChild(el('span', { class: 'badge b-ghost', text: `${entry.w}×${entry.h} tiles` }));
  }
  if (entry?.world && Number.isFinite(entry.world.plane)) {
    toolbar.appendChild(el('span', { class: 'badge b-ghost', text: `plane ${entry.world.plane}` }));
  }
  const focusBtn = el('button', { class: 'btn', text: '⌾ Focus', title: 'Reset the camera onto the room' });
  const shotBtn = el('button', { class: 'btn', text: '▣ Screenshot', title: 'Capture the current 3D view as an image (with an optional tiled high-res PNG)' });
  shotBtn.addEventListener('click', () => {
    import('./screenshot.js').then(({ openScreenshotModal }) => {
      if (destroyed) return;
      if (!(state.shotRes in SHOT_RES)) state.shotRes = '8k';
      openScreenshotModal({
        app,
        scene: scene3d,
        cat: 'world',
        entry: entry || { i: 0, name: 'The whole world' },
        highRes: {
          options: SHOT_RES,
          initial: state.shotRes,
          onPick: (key: string) => { state.shotRes = key; syncState(); },
          capture: (key: string, onProgress: (msg: string) => void, opts?: { transparent?: boolean }) => captureHighRes(key, onProgress, opts?.transparent),
        },
      });
    });
  });
  const vidBtn = el('button', { class: 'btn', text: '◉ Video', title: 'Record the current view: WEBM/MP4/GIF, turntable, caption' });
  vidBtn.addEventListener('click', () => {
    import('./video-wizard.js').then(({ openVideoWizard }) => {
      if (destroyed) return;
      // static-scene recording: no rig/clips, just the room turntable
      openVideoWizard({
        app, scene: scene3d, bar: null, clips: [],
        entry: entry || { i: 0, name: 'The whole world' },
        activeSize: 0,
      });
    });
  });
  toolbar.append(el('span', { class: 'spacer' }), shotBtn, vidBtn, focusBtn);

  // --- three.js scaffolding (shared renderer via Scene3D) -------------------
  const scene3d = new Scene3D(host);
  const immersive = mountImmersiveControls({ pane: root, host, toolbar });
  const renderer = getRenderer();
  const savedPixelRatio = renderer.getPixelRatio();

  // GPU-adaptive first-run defaults (all-rooms only): weak adapters start
  // with conservative performance settings. Applied ONLY when no saved world
  // prefs exist; nothing is persisted until the user changes something, and a
  // masked adapter ('unknown') is never treated as weak.
  const gpu = allMode ? classifyGpu(renderer) : null;
  // (the plain view's water is not offered: a software adapter keeps the authored curtains every visit)
  if (gpu?.tier === 'software') state.water = false;
  if (gpu && !hasSavedWorldState()) {
    if (gpu.tier === 'software') {
      state.rscale = RENDER_SCALES.indexOf(0.5);
      // Weak-GPU default (design 4.4, judge-decided): merged first-run on a
      // software adapter starts with effects off too, alongside water.
      // Single-room keeps effects ON unconditionally (see DEFAULT_STATE) and
      // relies on the per-emitter/per-view caps instead: accept-and-cap, not
      // a blanket disable. Always user-toggleable via the panel checkbox.
      state.effects = false;
      // the game's frame over many rooms is far too slow in software
      state.game = false;
    } else if (gpu.tier === 'integrated') {
      state.rscale = RENDER_SCALES.indexOf(0.5);
      state.gamereach = GAME_REACHES.indexOf(100);   // (the whole world in the game's shading holds every room on the GPU)
    }
  }
  // The world root converts game Z-up into three Y-up (see world/scene.js),
  // so this view is Y-up unlike the app's other Z-up asset views.
  scene3d.camera.up.set(0, 1, 0);
  // OrbitControls bakes its orbit axis from camera.up AT CONSTRUCTION, and
  // Scene3D builds it in the app's Z-up frame, so this view's controls must
  // be rebuilt Y-up. Without this, polar angles are measured about world Z:
  // a vertical drag walks the orbit to the sideways pole where pitch wedges
  // and the camera can only look at the map edge-on/from below. Same feel
  // otherwise: stock damping/speeds/buttons, PLUS an above-horizon polar
  // clamp for the single room so the orbit can never dip under the ground
  // plane. The remaining world-specific camera pieces live in focus*():
  // world-scale near/far + fog and a maxDistance cap.
  // All rooms: the orbit is disabled outright and an osrs.world-style
  // first-person fly camera (world/fly-controls.js) drives the view.
  scene3d.controls.dispose();
  scene3d.controls = new OrbitControls(scene3d.camera, renderer.domElement);
  scene3d.controls.enableDamping = true;
  scene3d.controls.dampingFactor = 0.12;
  scene3d.setHelpersVisible(false);              // XY grid is meaningless here
  const worldFog = new THREE.Fog((scene3d.scene.background as any).getHex(), 500, 2000);
  scene3d.scene.fog = worldFog;

  // All-rooms only: Scene3D renders unconditionally every rAF, but here a
  // single render can block the main thread for a second on weak GPUs while
  // rooms stream in, starving input, progress, the streaming tasks and
  // destroy (the Firefox "page is frozen / WebGL wedged" report). Replace THIS
  // instance's frame loop (view-local; the shared class is untouched) with one
  // that keeps ticks + damping at full rate but, whenever the previous render
  // exceeded its budget, skips presenting until an equal wall-time gap has
  // passed, bounding rendering to ≤50% duty so the event loop always drains.
  // While the loading overlay hides the canvas the cap is far stricter still
  // (see STREAM_PRESENT_MS below).
  let fly: any = null;     // first-person fly camera (all-rooms only; created below)
  let worldLoopCost = 0;   // all rooms: a drawn frame's page time (ms, smoothed)
  // all rooms: the time between drawn frames, the last two seconds' worth (the display's pace shows in it, and
  // so does what the page's own time does not: Chrome's GPU process falling behind)
  const worldFrameGaps: number[] = [];
  let worldLastDrawn = 0;
  /** The share of recent frames that came late: a gap more than half again the pace aimed for, the display's
   *  (the quickest tenth of the gaps) held between 75 and 57 a second: the view aims for 60 frames a second
   *  on any display, and frames all as slow as each other are still late. */
  function worldLateFrames(): number {
    if (worldFrameGaps.length < 30) return 0;
    const sorted = [...worldFrameGaps].sort((a, b) => a - b);
    const pace = Math.min(17.5, Math.max(1000 / 75, sorted[Math.floor(sorted.length * 0.1)]));
    return worldFrameGaps.filter((g) => g > pace * 1.5).length / worldFrameGaps.length;
  }
  if (allMode) {
    const RENDER_BUDGET_MS = 40;
    // While the loading overlay hides the canvas and the merged bake hasn't
    // started, presented frames exist ONLY to pace the reveal queue's GPU
    // uploads: cap them hard (4× the last cost, floor 250ms) so the room
    // stream keeps the main thread instead of rendering a 94%-hidden scene
    // at full rate. Normal cadence resumes the moment the bake starts (its
    // upload pacing wants frames) and after the overlay dismisses.
    const STREAM_PRESENT_MS = 250;
    let renderCost = 0;
    let renderEnd = 0;
    (scene3d as any)._loop = function throttledLoop(this: any, t: number) {
      if (!this._alive) return;
      const loopStart = performance.now();
      const dt = Math.min(100, t - this._lastT);
      this._lastT = t;
      for (const fn of this._ticks) fn(dt);
      // fly cam replaces the orbit here: controls.update() would re-lookAt the
      // orbit target every frame and fight the first-person orientation.
      if (fly) fly.update(dt);
      else this.controls.update();
      const start = performance.now();
      const streaming = !!overlay && !!merged && !merged.building && !merged.ready;
      const wait = streaming
        ? Math.max(4 * renderCost, STREAM_PRESENT_MS)
        : (renderCost <= RENDER_BUDGET_MS ? 0 : renderCost);
      if (start - renderEnd >= wait) {
        if (worldLastDrawn) {
          const gap = start - worldLastDrawn;
          worldFrameGaps.push(gap);
          if (worldFrameGaps.length > 120) worldFrameGaps.shift();
        }
        worldLastDrawn = start;
        updateWorldGame(start);
        renderAllRooms();
        renderEnd = performance.now();
        renderCost = renderEnd - start;
        // the whole frame's page time (ticks, effects, the game's frame and three's view), smoothed
        worldLoopCost = worldLoopCost * 0.9 + (renderEnd - loopStart) * 0.1;
        setBackgroundShare(worldLoopCost);
      }
      requestAnimationFrame(this._loop);
    }.bind(scene3d);
  }

  // All rooms: osrs.world-style WASD/mouselook fly camera drives the merged
  // stitch. OrbitControls stays constructed (focus*() and updateSunShadow() use
  // its target as the point of interest) but its input handlers are disabled for
  // the view's life. Single room: keep the stock OrbitControls live so a lone
  // room behaves exactly like the model/mesh/scene viewers (drag=orbit, scroll=
  // zoom, ctrl/right-drag=pan), with an above-horizon polar clamp so the orbit
  // can never dip below the ground plane.
  if (allMode) {
    scene3d.controls.enabled = false;
    fly = new FlyControls({
      camera: scene3d.camera,
      domElement: renderer.domElement,
      onChange: () => updateSunShadow(),
    });
    // the Scene3D hint card describes orbit controls: retext it for the fly cam
    const hintCard = (scene3d as any)._camHint.querySelector('.cam-hint-card');
    hintCard.querySelectorAll('.cam-hint-row').forEach((node: Element) => node.remove());
    for (const [keys, verb] of [
      ['WASD', 'fly'], ['E / Q', 'up / down'], ['drag', 'look'],
      ['double-click', 'mouselook'], ['Shift', 'fast'], ['Tab', 'slow'],
      ['F', 'fullscreen'], ['U', 'hide UI'],
    ]) {
      hintCard.append(
        el('span', { class: 'cam-hint-row' }, el('b', { text: keys }), el('span', { text: ` ${verb}` })));
    }
  } else {
    // single room keeps the default orbit hint card; clamp just above horizontal
    // so a downward drag never walks the eye under the floor.
    scene3d.controls.maxPolarAngle = Math.PI * 0.495;
  }

  const hemi = scene3d.hemi;
  hemi.color.set(0xcfe0ff);
  hemi.groundColor.set(0x55584d);
  const sun = scene3d.key;
  sun.color.set(0xfff4e0);
  const sunTarget = new THREE.Object3D();
  scene3d.scene.add(sunTarget);
  sun.target = sunTarget;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.025;
  scene3d.fill.visible = false;

  // The scene chain above the world graph is static (identity scene, flatten
  // toggling displayRoot.scale explicitly): frozen local matrices keep three's
  // per-frame updateMatrixWorld from dirtying (and thus re-multiplying) the
  // entire ~100k-object graph under it every frame. Every transform change on
  // these roots below calls updateMatrix() explicitly.
  scene3d.scene.matrixAutoUpdate = false;
  const displayRoot = new THREE.Group();
  displayRoot.name = 'world-display';
  displayRoot.matrixAutoUpdate = false;
  scene3d.scene.add(displayRoot);
  const highlightRoot = new THREE.Group();
  highlightRoot.name = 'world-highlights';
  highlightRoot.matrixAutoUpdate = false;
  displayRoot.add(highlightRoot);
  // Skinned NPC playback overlays here (mirrors world.root's Z-up->Y-up
  // rotation/scale, set once the index resolves): the animated composite is
  // placed at the spawn's native world matrix, exactly like the highlight.
  const spawnAnimRoot = new THREE.Group();
  spawnAnimRoot.name = 'world-spawn-anim';
  spawnAnimRoot.matrixAutoUpdate = false;
  displayRoot.add(spawnAnimRoot);
  // Ambient particle effects overlay here (same recipe): instanced billboard
  // batches authored in native game space under a root mirroring world.root's
  // rotation/scale, placed by room offset + occurrence-anchor cells.
  const effectsRoot = new THREE.Group();
  effectsRoot.name = 'world-effects';
  effectsRoot.matrixAutoUpdate = false;
  displayRoot.add(effectsRoot);

  // --- water + status state -------------------------------------------------
  const waterUniforms = createWaterUniforms();
  const sheetMaterialCache = new Map<any, any>();
  const roomWaterSheets = new Map<number, any[]>();     // room id -> [sheet meshes]
  const waterClock = new EffectsClock(600);
  let waterTicks = 0;
  const roomWaterCurtains = new Map<number, any[]>();   // room id -> [curtain meshes]
  let waterRegistry: any = null;
  // Ambient effects layer state, shared by both view modes (see the "ambient
  // particle effects" section below for the split single-room / merged
  // activation logic).
  let effectsLayer: any = null;
  let effectsDoc: any = null;
  let effectsDocRequested = false;
  const effectsRooms = new Set<number>();       // single-room: loaded rooms wanting effects
  const activeEffectRooms = new Set<number>();  // merged: proximity-activated rooms
  let effectsActivationAccum = 0;               // ms since the last merged re-rank
  let merged: any = null;
  let pickIndex: any = null;   // all-rooms WebGL2 only: CPU picking for merged mode
  let destroyed = false;
  let ready = false;
  let loadStats = { batches: 0, instances: 0 };
  let allProgress: any = null;
  // All-rooms reveal queue: a room's first rendered frame uploads all its
  // GL buffers, so revealing a whole burst of freshly streamed rooms at once
  // turns one frame into a multi-second stall. Rooms enter hidden and a tick
  // reveals a geometric share of the backlog per actually-rendered frame.
  const revealQueue: number[] = [];
  let revealFrame = -1;
  // While the merged bake is the destination (WebGL2 + Merged ticked, bake
  // not failed), streamed rooms are never revealed AT ALL: their geometry /
  // instance buffers never upload, stream frames render an empty scene
  // behind the overlay, and the bake releases each room right after harvest.
  // The reveal path stays live for: no WebGL2, Merged unticked (before or
  // mid-load), the bake-failure fallback, and graph reloads.
  let bakeFailed = false;
  const deferStreamReveal = () => !!merged && state.merged && !bakeFailed;
  // Queue every retained-but-hidden room for the paced reveal: the catch-up
  // for rooms whose reveal was skipped (Merged unticked mid-load / bake
  // failure re-showing the graph path).
  function queueHiddenRooms(): void {
    if (!allMode) return;
    const queued = new Set(revealQueue);
    for (const room of world.rooms.values()) {
      if (!room.group.visible && !queued.has(room.id)) revealQueue.push(room.id);
    }
  }

  const world = new WorldScene({
    // the world root lives in a plain Group under the shared scene
    scene: displayRoot as any,
    store: app.store,
    categoryVisibility: {
      terrain: state.terrain, models: state.models,
      spawns: state.spawns, components: state.components,
    },
    showCollision: state.collision,
    showAuthoredEmpty: state.empty,
    showUntextured: state.untextured,
    // all rooms: one floor for the whole world (see the ground plane below)
    groundPlanes: !allMode,
    showGroundPlane: state.ground,
    groundPlaneDistance: planeDistance(state.groundd),
    neighbourShade: state.neighbourfade,
    textureAnisotropy: TEXTURE_ANISOTROPY,
    assetConcurrency: 12,
    onStatus: (event: any) => {
      if (destroyed) return;
      if (event.state === 'error') setStatus(event.error?.message || 'room failed to load', true);
      if (event.state === 'loaded') {
        const room = world.rooms.get(Number(event.room));
        if (room) {
          if (allMode) {
            room.group.visible = false;
            // headed for the merged bake: stay hidden, never uploads
            if (!deferStreamReveal()) revealQueue.push(room.id);
          }
          applyRoomWater(room);
          // Single-room only: the merged all-rooms path activates effects by
          // camera proximity (updateMergedEffectsActivation), not by the
          // stream's loaded/unloaded events, which fire for every one of the
          // (possibly 451) streamed rooms regardless of where the camera is.
          if (!allMode) effectsRoomLoaded(room.id);
          if (!allMode) idleRoomLoaded(room).catch(() => { /* best-effort */ });
        }
        syncStatusSoon();
      }
      if (event.state === 'unloaded') {
        for (const id of event.rooms || [event.room]) {
          roomWaterCurtains.delete(Number(id));
          disposeRoomWaterSheets(Number(id));
          if (!allMode) effectsRoomUnloaded(Number(id));
          if (!allMode) idleRoomUnloaded(Number(id));
        }
      }
    },
  });
  // the ground plane fades into the view's background (output colour space)
  if ((scene3d.scene.background as any)?.isColor) {
    world.setGroundPlaneFade((scene3d.scene.background as THREE.Color).clone().convertLinearToSRGB());
  }

  // --- control panel ---------------------------------------------------------
  const hud = createWorldHud({
    host,
    renderer,
    // live particle count rides the 2 Hz stats line while the layer runs
    extra: () => {
      const live = effectsLayer ? effectsLayer.liveCount() : 0;
      return live > 0 ? `${fmtInt(live)} fx` : '';
    },
  });

  // rAF-gap stall probe (all-rooms only): records the worst main-thread gap
  // across the whole load, and separately across the finalize window (water
  // sheets → uploads → graph release → ready), the exact phase where a
  // real-world Firefox freeze pointed. Read via api.stallProbe.
  const stallProbe = allMode
    ? { phase: 'load', worst: 0, worstStage: '', finalizeWorst: 0, finalizeWorstStage: '' }
    : null;
  const stallPhase = (phase: string) => { if (stallProbe) stallProbe.phase = phase; };
  // Stage-transition timeline (all-rooms only): one {stage, t} entry per
  // hud.setStage text change, so a slow load attributes to a phase without
  // manual profiling. Read via api.loadTimeline; observational only.
  const loadTimeline: { stage: string; t: number }[] = [];
  if (allMode) {
    const origSetStage = hud.setStage.bind(hud);
    let lastStageKey = '';
    hud.setStage = (text: string, opts?: any) => {
      // collapse counter churn ("merging rooms 12/451") to the phase name
      const key = text.replace(/[\d,]+\s*\/\s*[\d,]+|[\d,]+/g, '#');
      if (key !== lastStageKey && loadTimeline.length < 512) {
        lastStageKey = key;
        loadTimeline.push({ stage: text, t: Math.round(performance.now()) });
      }
      return origSetStage(text, opts);
    };
  }
  if (allMode) {
    const probeState = stallProbe!;
    let lastRaf = 0;
    const probe = (t: number) => {
      if (destroyed) return;
      if (lastRaf) {
        const gap = t - lastRaf;
        if (gap > probeState.worst) {
          probeState.worst = gap;
          probeState.worstStage = hud.state.stage;
        }
        if (probeState.phase === 'finalize' && gap > probeState.finalizeWorst) {
          probeState.finalizeWorst = gap;
          probeState.finalizeWorstStage = hud.state.stage;
        }
      }
      lastRaf = t;
      requestAnimationFrame(probe);
    };
    requestAnimationFrame(probe);
  }

  const panel = el('div', { class: 'world-panel' });
  host.appendChild(panel);
  const statusEl = el('div', { class: 'wp-status', text: 'loading…' });
  const readout = el('div', { class: 'wp-readout', hidden: true });

  function setStatus(text: string, bad = false): void {
    statusEl.textContent = text;
    statusEl.classList.toggle('bad', !!bad);
  }

  // --- loading overlay (all-rooms only) --------------------------------------
  // osrs.world-style: the streaming/merging churn hides behind one weighted
  // progress bar over the dimmed canvas; the finished world reveals at ready.
  // Phase weights (merged pipeline): rooms 0→.50, textures .50→.58, merging
  // rooms .58→.72, merging batches .72→.88, water .88→.90, upload .90→.92,
  // graph release .92→.98, cache release .98→1. Without WebGL2 the room
  // stream owns 0→.95 and ready completes the bar.
  let overlay: HTMLElement | null = null;
  let overlayFill: HTMLElement | null = null;
  let overlayPct: HTMLElement | null = null;
  let overlayProgress = 0;
  let gateResolve: ((v: boolean) => void) | null = null;
  // Loading every room is deliberately gated behind an explicit confirmation:
  // the merged world is heavy (all rooms streamed + baked; roughly 1 to 2 GB of
  // memory) and must never start from a mere navigation.
  let confirmGate: Promise<boolean> = Promise.resolve(true);
  if (allMode) {
    overlayFill = el('div', { class: 'wlo-fill' });
    overlayPct = el('div', { class: 'wlo-pct', text: '0%' });
    const bar = el('div', { class: 'wlo-bar' }, overlayFill);
    bar.hidden = true;
    overlayPct.hidden = true;
    const title = el('div', { class: 'wlo-title', text: 'Load the whole world?' });
    const note = el('p', {
      class: 'wlo-note',
      text: 'Streams every extracted room into one scene and bakes it for fast '
        + 'rendering. This is heavy: expect roughly 1 to 2 GB of memory and a long '
        + 'first load on slower machines.',
    });
    const confirmBtn = el('button', { class: 'btn world-load-confirm', type: 'button', text: '⛰ Load the world' });
    const cancelBtn = el('button', { class: 'btn world-load-cancel', type: 'button', text: 'Back to rooms' });
    const actions = el('div', { class: 'wlo-actions' }, confirmBtn, cancelBtn);
    confirmGate = new Promise((resolve) => { gateResolve = resolve; });
    confirmBtn.addEventListener('click', () => {
      title.textContent = 'Loading the whole world';
      note.remove();
      actions.remove();
      bar.hidden = false;
      overlayPct!.hidden = false;
      gateResolve?.(true);
      gateResolve = null;
    });
    cancelBtn.addEventListener('click', () => {
      gateResolve?.(false);
      gateResolve = null;
      location.hash = '#/world';
    });
    // GPU-tier warning, part of the confirm overlay (no dismiss of its own:
    // it lives and dies with the overlay). Built here so it also shows when
    // the user lands directly on #/world/all.
    let gpuWarn: HTMLElement | null = null;
    if (gpu?.tier === 'software' || gpu?.tier === 'integrated') {
      const software = gpu.tier === 'software';
      gpuWarn = el('div', { class: `wlo-warn${software ? ' wlo-warn-software' : ''}` },
        el('b', { text: software ? 'No GPU acceleration detected' : 'Integrated graphics detected' }),
        el('p', { text: software ? GPU_WARN_SOFTWARE(gpu.label) : GPU_WARN_INTEGRATED(gpu.label) }));
    }
    overlay = el('div', { class: 'world-loading' },
      el('div', { class: 'wlo-card' }, title, gpuWarn, note, actions, bar, overlayPct));
    host.appendChild(overlay);
    // best-effort exact room count in the message (never blocks the gate)
    app.store.worldIndex?.().then((index: any) => {
      const count = index?.rooms?.length;
      if (count && note.isConnected) {
        note.textContent = `Streams all ${fmtInt(count)} rooms into one scene and `
          + 'bakes it for fast rendering. This is heavy: expect roughly 1 to 2 GB of '
          + 'memory and a long first load on slower machines.';
      }
    }).catch(() => {});
  }
  const roomPhaseShare = () => (merged ? 0.5 : 0.95);
  function setOverlayProgress(fraction: number): void {
    if (!overlay) return;
    overlayProgress = Math.max(overlayProgress, Math.min(1, Number(fraction) || 0));
    overlayFill!.style.width = `${(overlayProgress * 100).toFixed(1)}%`;
    overlayPct!.textContent = `${Math.round(overlayProgress * 100)}%`;
  }
  function dismissOverlay(): void {
    if (!overlay) return;
    const node = overlay;
    overlay = null;
    node.classList.add('done');
    setTimeout(() => node.remove(), 450);
  }

  // --- inspect mode toggle ----------------------------------------------------
  // A distinct button-style MODE toggle (not a view-layer checkbox): inspection
  // changes how the pointer behaves. Works in both display paths: the per-room
  // graph raycasts its instanced meshes; merged all-rooms picks through the
  // CPU index built during the bake.
  const INSPECT_TITLE = 'Hover a placement for its source data; click to pin';
  const inspectBtn = el('button', {
    class: 'wp-inspect', type: 'button', text: '⌖ Inspect / pin',
    title: INSPECT_TITLE, 'aria-pressed': 'false',
  });
  function setInspect(on: boolean): void {
    state.inspect = !!on;
    inspectBtn.classList.toggle('active', state.inspect);
    inspectBtn.setAttribute('aria-pressed', state.inspect ? 'true' : 'false');
    if (!state.inspect) { clearInspection(true); clearEffectInspection(true); }
    effectsLayer?.setMarkersShown(state.inspect && state.fxmarkers);
  }
  inspectBtn.addEventListener('click', () => {
    if (!inspectBtn.disabled) setInspect(!state.inspect);
  });
  // Session-edit reset lives next to the mode toggle so it stays reachable
  // after a delete cleared the pinned readout. Hidden until an edit exists.
  const resetEditsBtn = el('button', {
    class: 'wp-reset-edits', type: 'button', text: '↺ Reset edits', hidden: true,
    title: 'Undo every temporary move/delete from this session (edits are never saved)',
  });
  resetEditsBtn.addEventListener('click', () => resetAllEdits());

  const section = (name: string, ...kids: any[]) => el('div', { class: 'wp-section' },
    el('div', { class: 'wp-title', text: name }), ...kids);
  const inputs: Record<string, any> = {};
  const check = (key: string, label: string, onchange: () => void,
    { swatch = null, title = '' }: { swatch?: string | null; title?: string } = {}) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!state[key];
    cb.addEventListener('change', () => {
      state[key] = cb.checked;
      onchange();
      syncState();
    });
    inputs[key] = cb;
    return el('label', { class: 'wp-check', ...(title ? { title } : {}) },
      cb,
      swatch ? el('span', { class: 'wp-sw', style: `background:${swatch}` }) : null,
      el('span', { text: label }));
  };
  const range = (key: string, label: string, min: number, max: number, step: number,
    fmt: (v: any) => string, onchange: () => void) => {
    const out = el('output', { text: fmt(state[key]) });
    const input = el('input', {
      type: 'range', min: String(min), max: String(max), step: String(step),
      value: String(state[key]),
    });
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      out.textContent = fmt(state[key]);
      onchange();
      syncState();
    });
    inputs[key] = input;
    return el('div', { class: 'wp-range' },
      el('div', { class: 'wp-range-head' }, el('span', { text: label }), out),
      input);
  };

  // visibility --------------------------------------------------------------
  const applyCategories = () => {
    for (const category of WORLD_CATEGORIES) {
      world.setCategoryVisible(category, state[category]);
      merged?.setCategoryVisible(category, state[category]);
    }
  };
  // the ground plane's distance: one setting for a room, one for all rooms
  const groundKey = allMode ? 'groundw' : 'groundd';
  const groundDistance = () => planeDistance(state[groundKey]);
  const applyGround = () => {
    groundRange.hidden = !state.ground;
    world.setGroundPlaneVisible(state.ground);
    if (gameFrame) gameFrame.showPlane = !!state.ground;
    applyWorldGameSettings();
    applyWorldGroundPlane();
  };
  /** Rebuilds of the room shown, one after another (its progress, its floor). */
  let homeReload: Promise<void> = Promise.resolve();
  const applyGroundDistance = () => {
    world.setGroundPlaneDistance(groundDistance());
    if (gameFrame) gameFrame.planeDistance = groundDistance();
    applyWorldGameSettings();
    applyWorldGroundPlane();
    // past the field (or no limit): the game frame's floor runs on for hundreds of tiles, and the camera sees it
    const endless = groundDistance() > PLANE_FIELD_REACH;
    if (world.endlessFloor !== endless) {
      world.endlessFloor = endless;
      if (!allMode) refreshGameFloor();
    }
    if (!allMode && savedCamera) { scene3d.camera.far = gameCameraFar(); scene3d.camera.updateProjectionMatrix(); }
  };
  /** The single room's camera range with game shading: the game's, or far enough for an endless floor. */
  function gameCameraFar(): number {
    const far = (world.index?.render?.camera?.far ?? 102400) / world.tileUnits;
    return world.endlessFloor ? Math.max(far, 3000) : far;
  }
  /** The room's game frame given its floor again (the endless one, or the game's). */
  function refreshGameFloor(): void {
    homeReload = homeReload.then(async () => {
      await gameSetup;
      const home = entry ? world.rooms.get(Number(entry.i)) : null;
      if (!gameFrame || !home || destroyed) return;
      await gameFrame.setRoom(await world.gameRoomSource(home, world.neighbourRooms()));
      renderer.resetState();
    }).catch((error) => console.warn('floor not laid again', error));
  }
  const groundRange = range(groundKey, 'Ground plane distance', 1, PLANE_ENDLESS, 1,
    (v) => { const d = planeDistance(v); return d === Infinity ? '\u221e no limit' : d === 1 ? '1 tile' : `${d} tiles`; }, applyGroundDistance);
  groundRange.title = `How far the floor reaches past each room. The game's is ${PLANE_GAME_DISTANCE} tiles; `
    + `past ${PLANE_DISTANCE_MAX} (the far end) it never ends.`;
  groundRange.hidden = !state.ground;
  // a room's neighbours: the rooms directly through its doors
  const applyNeighbourFade = () => {
    world.setNeighbourShade(!!state.neighbourfade);
    if (gameFrame) gameFrame.neighbourFade = !!state.neighbourfade;
  };
  const neighbourFadeCheck = check('neighbourfade', 'Dim neighbouring rooms', applyNeighbourFade,
    { title: 'Dim the neighbouring rooms as the game does (a tenth of the light, and their water faded), so the room you are in stands out' });
  neighbourFadeCheck.classList.add('wp-sub');
  neighbourFadeCheck.hidden = !state.neighbours;
  groundRange.classList.add('wp-sub');
  const applyToggles = () => {
    world.setUntexturedVisible(state.untextured);
    world.setCollisionVisible(state.collision);
    world.setAuthoredEmptyVisible(state.empty);
    applyWireOverlays();   // merged all-rooms path for collision/empty
    applyWater();   // authored-empty/z passes re-show hidden curtains
  };

  // the kinds of effect shown, under Effects (a change re-adds the rooms' effects)
  const EFFECT_KIND_ROWS: [string, EffectKind, string, string][] = [
    ['fxrest', 'rest', 'At rest', 'What plays with nobody acting, as the game shows a room'],
    ['fxextras', 'extras', 'Occasional extras', 'The extras a resting object plays now and then'],
    ['fxstates', 'states', 'Other states', "What objects play in their other states (another stage of a quest, a plant's other growth stages)"],
    ['fxactions', 'actions', 'Skill and use effects', 'What objects play while someone uses them (skilling, opening, lighting), shown looping'],
    ['fxoneshot', 'oneshot', 'One-off effects', 'Effects fired by an event, repeated every few seconds'],
  ];
  const effectKinds = (): EffectKind[] => EFFECT_KIND_ROWS.filter(([key]) => state[key]).map(([, kind]) => kind);
  const effectKindChecks = EFFECT_KIND_ROWS.map(([key, , label, title]) => {
    const row = check(key, label, () => {
      // (the layer takes its kinds when made: a fresh one with the new set)
      effectsLayer?.dispose(); effectsLayer = null;
      activeEffectRooms.clear();
      for (const id of [...actorEffectRooms.keys()]) dropActorEffects(id);
      if (effectPinned) clearEffectInspection(true);
      applyEffects();
    }, { title });
    row.classList.add('wp-sub');
    return row;
  });
  // the effects' pick markers (drawn while inspecting): picking still works with them hidden
  const effectMarkersCheck = check('fxmarkers', 'Effect markers', () => {
    effectsLayer?.setMarkersShown(state.inspect && state.fxmarkers);
  }, { title: 'The small markers drawn at each effect while inspecting, to find and pick it; picking still works with them hidden' });
  effectMarkersCheck.classList.add('wp-sub');
  effectKindChecks.push(effectMarkersCheck);
  const syncEffectKinds = () => { for (const row of effectKindChecks) row.hidden = !state.effects; };
  syncEffectKinds();
  const categoryCheck = (category: string) => check(category, CATEGORY_LABELS[category][0], () => {
    clearInspection(true);
    applyCategories();
  }, { swatch: CATEGORY_LABELS[category][1] });
  // what the room is shown with (the rest of the old Visible list is in Debug and Game shading)
  const visSection = section('Show',
    ...WORLD_CATEGORIES.filter((category: string) => category !== 'components').map(categoryCheck),
    check('effects', 'Effects', () => { syncEffectKinds(); applyEffects(); },
      { swatch: '#e8b04c', title: 'Ambient particle effects recovered from this game version' }),
    ...effectKindChecks,
    allMode ? null : check('idle', 'Resting animations', applyIdle,
      { swatch: '#c9a0dc', title: 'NPCs, enemies and animals play the animation they rest in (standing, sitting, lying in wait). Off: each holds its resting pose.' }),
    allMode ? check('names', 'Room names', () => applyNames(),
      { swatch: '#e8e4d8', title: 'Floating name labels at each room\'s stitched position' }) : null,
    check('spawnnames', 'NPC names', () => applySpawnNames(),
      { swatch: '#dc8268', title: 'Floating name labels above NPC / enemy spawns' }));

  // z levels ------------------------------------------------------------------
  const zList = el('div', { class: 'wp-zlist' });
  const zSummary = el('span', { text: '' });
  const zAll = el('a', { text: 'all' });
  const zNone = el('a', { text: 'none' });
  const zSection = section('Height levels',
    el('div', { class: 'wp-zlinks dim small' }, 'Layers ', zAll, ' · ', zNone, ' ', zSummary),
    zList);
  zSection.hidden = true;
  let zLevels: number[] = [];
  const syncZSummary = () => {
    const shown = zLevels.filter((z) => world.isZVisible(z)).length;
    zSummary.textContent = shown === zLevels.length ? '' : `(${shown}/${zLevels.length})`;
  };
  function buildZUI(): void {
    zLevels = allMode
      ? [...new Set([...(world.index?.totals?.z_levels || []), ...world.zLevels()])].sort((a, b) => a - b)
      : world.zLevels();
    zSection.hidden = !zLevels.length;
    clear(zList);
    const parsed = state.z === 'all' ? null
      : new Set((state.z || '').split(',').filter(Boolean).map(Number));
    world.setAllZVisible(parsed === null);
    if (parsed !== null) for (const z of zLevels) world.setZVisible(z, parsed.has(z));
    for (const z of zLevels) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = world.isZVisible(z);
      cb.dataset.z = String(z);
      cb.addEventListener('change', () => {
        clearInspection(true);
        world.setZVisible(z, cb.checked);
        merged?.refreshZMask((level: number) => world.isZVisible(level));
        applyWater();
        applyWireOverlays();
        syncZState();
      });
      zList.appendChild(el('label', {}, cb, el('span', { text: ` Z ${z}` })));
    }
    syncZSummary();
  }
  const bulkZ = (visible: boolean) => () => {
    clearInspection(true);
    world.setAllZVisible(visible);
    merged?.refreshZMask((level: number) => world.isZVisible(level));
    applyWater();
    applyWireOverlays();
    zList.querySelectorAll('input').forEach((cb) => { cb.checked = visible; });
    syncZState();
  };
  zAll.addEventListener('click', bulkZ(true));
  zNone.addEventListener('click', bulkZ(false));
  function syncZState(): void {
    const visible = zLevels.filter((z) => world.isZVisible(z));
    state.z = visible.length === zLevels.length ? 'all' : visible.join(',');
    syncZSummary();
    syncState();
  }

  // water: the game's water in rooms with game shading, the plain view's animated sheets beyond (or, on a
  // weak adapter, its authored curtains); its colour and opacity are the plain view's own

  // --- the game's own shading (single room) ----------------------------------
  // With the game's shader bundles and this build's render data, a single
  // room is drawn frame by frame exactly as the game draws it: its programs,
  // its lights, shadow map, ambient occlusion, vignette and water. Other
  // layers (effects, highlights, labels) draw on top through three.js with
  // the same camera and depth range.
  let gameFrame: GameFrame | null = null;
  let gameCamera: { eye: THREE.Vector3; target: THREE.Vector3 } | null = null;
  const gameActive = () => !!gameFrame && !!state.game;
  // The view's own framing, taken when the game camera replaces it.
  let savedCamera: { fov: number; near: number; far: number } | null = null;
  function applyGameShading(): void {
    if (allMode) {
      if (!state.game) stopWorldGame();
      else worldGameRanked = 0;
      return;
    }
    const on = gameActive();
    world.setGameShading(on);
    const cam = scene3d.camera;
    const render = world.index?.render;
    if (on && render) {
      savedCamera ??= { fov: cam.fov, near: cam.near, far: cam.far };
      cam.fov = render.camera.fov;
      cam.near = render.camera.near / world.tileUnits;
      cam.far = gameCameraFar();
    } else if (savedCamera) {
      Object.assign(cam, savedCamera);
      savedCamera = null;
    }
    cam.updateProjectionMatrix();
  }
  // While a game frame is being built, its GL work (programs, buffers,
  // textures, vertex arrays) lands between three's frames, behind three's
  // state cache: three then draws with whatever program or texture the frame
  // left bound. Until the build finishes, every frame resets that cache.
  let gameBuilds = 0;
  async function setupGameShading(room: any): Promise<void> {
    const gl = renderer.getContext();
    if (allMode || !world.index?.render || !(gl instanceof WebGL2RenderingContext)) return;
    gameBuilds++;
    try {
      const frame = new GameFrame(gl, (rel: string) => app.store.url(rel), world.index.render, world.tileUnits);
      await frame.setRoom(await world.gameRoomSource(room, world.neighbourRooms()));
      renderer.resetState();
      if (destroyed) return;
      frame.showPlane = !!state.ground;
      frame.planeDistance = groundDistance();
      frame.neighbourFade = !!state.neighbourfade;
      frame.pointLightStrength = state.glights ? 1 : 0;
      frame.showFog = !!state.gfog;
      frame.viewerReach = true;
      gameFrame = frame;
      applyGameShading();
      setupStory(room.id);
    } catch (error) {
      renderer.resetState();
      console.warn('game shading unavailable for this room', error);
    } finally {
      gameBuilds--;
    }
  }
  // --- the game's own shading, all rooms --------------------------------------
  // The world is drawn with the game's frame. The rooms nearest the camera
  // (as many as the frame's budget holds) are drawn as the game draws each
  // alone: built in its own frame (its lighting, vignette, lamps and fog) and
  // placed at its stitched place. With "Whole world", every room is also part
  // of its cell's cluster: the cell's rooms' parts joined by what draws them,
  // one draw per material and lighting preset, without the rooms' vignettes,
  // fog and lamps (too far to tell). Clusters build once, nearest first, and
  // stay; a room drawn on its own is left out of its cluster (its slot in the
  // room mask), so nothing is drawn twice and nothing comes and goes. The
  // merged batches draw only the rooms the game's frame does not, and not at
  // all once it draws every room. One shadow map, fitted over the nearest
  // rooms, and one ambient occlusion chain serve the whole view.
  const WORLD_CLUSTER_TILES = 128;      // a cluster cell's edge (tiles)
  const WORLD_GAME_MAX_ROOMS = 96;      // the most rooms drawn on their own...
  const WORLD_GAME_NEAR_TILES = 40;    // a room whose cell is joined is drawn on its own only this near (3D, tiles)
  // ...within a draw budget the view keeps its frame within (a town's rooms hold several times a
  // field's draws, and every draw costs the page's thread), smaller when the frame runs long, larger when
  // it has room to spare
  const WORLD_GAME_FRAME_MS = 14;       // a frame's page time aimed for (everything the frame does: 60 a second with room to spare)
  let worldGameBudget = 1200;
  const WORLD_GAME_SHADOW_TILES = 40;   // rooms this near the camera cast the shadow map...
  const WORLD_GAME_CASTERS = 16;        // ...the nearest so many of them
  const WORLD_GAME_OCCLUDERS = 4;       // the nearest rooms in view in the ambient occlusion (beyond: too small to tell)
  const WORLD_GATHER_AT_ONCE = 4;       // rooms gathered side by side for a cluster
  // Everything kept ("Keep everything loaded"): no room drawn on its own, every cluster in full detail with its
  // lamps, the occlusion of everything in view, and a shadow map per cell drawn once (its own cell's clusters and
  // those within reach casting), so nothing changes as the camera moves.
  const WORLD_SHADOW_TEXELS = 24;       // a cell's shadow map: pixels per tile...
  const WORLD_SHADOW_MAX = 4096;        // ...within this size
  const WORLD_SHADOW_REACH_TILES = 24;  // clusters this near a cell's cast into its map
  /** How far rooms are drawn in the game's shading (native units across the ground; Infinity: the whole world). */
  const worldGameReach = () => (GAME_REACHES[state.gamereach] ?? Infinity) * world.tileUnits;
  const worldWhole = () => worldGameReach() === Infinity;
  const worldSteady = () => worldWhole() && !!state.gamesteady;
  interface WorldGameRoom {
    id: number;
    /** Its slot in the game frame's room mask (from 1). */
    slot: number;
    /** The room's tile (0, 0), native. */
    origin: THREE.Vector3;
    /** Native bounds (min x, y, z, max x, y, z): the room's map rect until built, then its own. */
    box: number[];
    scene: GameScene | null;
    building: boolean;
    failed: boolean;
    cell: WorldGameCell;
    /** What draws it now: the game's frame (on its own or in its cluster), or the merged batches. */
    drawnByGame: boolean;
    /** Its plain drawing (the merged batches, the room graph) hidden. */
    classicHidden: boolean;
  }
  interface WorldGameCell {
    key: string;
    /** Its tile (0, 0), native: its clusters' frame. */
    origin: THREE.Vector3;
    rooms: WorldGameRoom[];
    /** Native bounds of its rooms (min x, y, z, max x, y, z). */
    box: number[];
    /** Its rooms joined (one per lighting preset), once built; and their bounds. */
    clusters: GameScene[] | null;
    clusterBoxes: number[][];
    clusterBuilding: boolean;
    clusterFailed: boolean;
    /** The frame its clusters are built in (native): its rooms' corner. */
    frame: THREE.Vector3;
    /** Everything kept: whether its clusters carry their lamps, and its own shadow map (with the cells cast from). */
    lit: boolean;
    shadow: ShadowTile | null;
    shadowKey: string;
  }
  let worldGame: GameFrame | null = null;
  const worldGameRooms = new Map<number, WorldGameRoom>();
  const worldGameCells = new Map<string, WorldGameCell>();
  /** Rooms being gathered or built (gathering overlaps; the frame builds one at a time), and clusters. */
  let worldGameBuilding = 0;
  let worldClusterBuilding = 0;
  const WORLD_GAME_IN_FLIGHT = 3;
  /** The game frame's cost on the page's thread per drawn frame (ms, smoothed), and its scenes drawn. */
  let worldGameCost = 0, worldGameDrawn = 0;
  let worldGameRanked = 0;
  const worldGameTimes: number[][] = [];   // per room built: id, gathering ms, building ms
  let worldPlaneByRoom: Map<number, PlaneTile[]> | null = null;
  const worldGameOn = () => allMode && !!worldGame && !!state.game && ready && !destroyed;
  /** Every room is the game's: the merged batches and the plain floor are not drawn at all. */
  let worldAllGame = false;

  function setupWorldGameShading(): void {
    const gl = renderer.getContext();
    if (!allMode || worldGame || !worldFrame || !world.index?.render || !(gl instanceof WebGL2RenderingContext)) return;
    const frame = new GameFrame(gl, (rel: string) => app.store.url(rel), world.index.render, world.tileUnits, undefined, { roomMask: true });
    frame.idleTextures = 512;
    frame.neighbourFade = false;
    // (its builds share the frames: bakes and uploads in the time left once each frame is drawn)
    frame.pace = backgroundTurn;
    // (and their bakes' arithmetic in a worker of their own)
    frame.bakeWorker = (window as any).__bs?.noBakeWorker ? null : GameBakeWorker.spawn();   // (tests: off, to compare)
    if ((window as any).__bs?.verifyBake) frame.bakeVerify = { bakes: 0, mismatches: 0 };
    // parts drawn alike joined into one draw, their textures layers of shared arrays: about a quarter of the draws
    // (tests: __bs.noJoinLayers draws every part on its own, as a single room does)
    frame.joinLayers = !(window as any).__bs?.noJoinLayers;
    worldGame = frame;
    applyWorldGameSettings();
    const T = world.tileUnits, C = WORLD_CLUSTER_TILES;
    for (const [id, f] of worldFrame.frames) {
      const x = (f.x + worldFrame.ox) * T, y = (f.y + worldFrame.oz) * T;
      const cx = Math.floor((f.x + worldFrame.ox + f.w / 2) / C), cy = Math.floor((f.y + worldFrame.oz + f.h / 2) / C);
      const key = `${cx},${cy}`;
      let cell = worldGameCells.get(key);
      if (!cell) {
        worldGameCells.set(key, cell = { key, origin: new THREE.Vector3(cx * C * T, cy * C * T, 0), rooms: [],
          box: [Infinity, Infinity, 0, -Infinity, -Infinity, -Infinity], clusters: null, clusterBoxes: [],
          clusterBuilding: false, clusterFailed: false, frame: new THREE.Vector3(), lit: false, shadow: null, shadowKey: '' });
      }
      const room: WorldGameRoom = { id, slot: worldGameRooms.size + 1, origin: new THREE.Vector3(x, y, 0),
        box: [x, y, 0, x + f.w * T, y + f.h * T, 16 * world.layerUnits], scene: null, building: false, failed: false, cell, drawnByGame: false, classicHidden: false };
      cell.rooms.push(room);
      worldGameRooms.set(id, room);
      growBox(cell.box, room.box);
    }
    for (const cell of worldGameCells.values()) cell.frame.set(cell.box[0], cell.box[1], 0);
  }
  const growBox = (box: number[], by: number[]) => {
    for (let k = 0; k < 3; k++) { box[k] = Math.min(box[k], by[k]); box[k + 3] = Math.max(box[k + 3], by[k + 3]); }
  };
  function applyWorldGameSettings(): void {
    if (!worldGame) return;
    worldGame.showPlane = !!state.ground;
    worldGame.planeDistance = groundDistance();
    worldGame.pointLightStrength = state.glights ? 1 : 0;
    worldGame.showFog = !!state.gfog;
    worldGame.clusterDetailPixels = worldSteady() ? 0 : 10;
    worldGame.clusterDepth = worldSteady();
  }

  /** The room's share of the world's floor (the tiles whose floor it is), in its own frame. */
  function worldGamePlane(id: number): PlaneTile[] {
    if (!worldPlaneField || !worldFrame) return [];
    if (!worldPlaneByRoom) {
      worldPlaneByRoom = new Map();
      for (const tile of planeTiles(worldPlaneField, PLANE_FIELD_REACH)) {
        const owner = worldPlaneSourceIds[tile.room];
        if (owner === undefined) continue;
        let list = worldPlaneByRoom.get(owner);
        if (!list) worldPlaneByRoom.set(owner, list = []);
        list.push(tile);
      }
    }
    const f = worldFrame.frames.get(id);
    if (!f) return [];
    const ox = f.x + worldFrame.ox, oy = f.y + worldFrame.oz;
    return (worldPlaneByRoom.get(id) ?? []).map((tile) => ({ ...tile, x: tile.x - ox, y: tile.y - oy }));
  }

  // The endless floor (no limit): past the rooms' own floors (the 40 tiles the rooms and clusters carry), the floor
  // runs on for a thousand tiles in pieces a texture repeat each, one scene per lighting environment of the rooms
  // whose floor it carries on (a floor-only cluster: no vignette, never masked, always in view).
  const WORLD_FLOOR_FAR = 1000;
  let worldFarFloor: { scene: GameScene; box: number[] }[] = [];
  let worldFarFloorState: 'none' | 'building' | 'built' = 'none';
  function dropWorldFarFloor(): void {
    for (const { scene } of worldFarFloor) worldGame?.disposeScene(scene);
    worldFarFloor = [];
    worldFarFloorState = 'none';
  }
  async function buildWorldFarFloor(): Promise<void> {
    if (!worldPlaneField || !worldFrame) return;
    worldFarFloorState = 'building';
    const scenes: { scene: GameScene; box: number[] }[] = [];
    try {
      const far = (window as any).__bs?.floorFar ?? WORLD_FLOOR_FAR;   // (tests: how far past the world)
      const tiles = planeTiles(worldPlaneField, Infinity, far, PLANE_FIELD_REACH).filter((t) => t.cover > PLANE_FIELD_REACH);
      const groups = new Map<string, { owner: number; tiles: PlaneTile[] }>();
      for (const tile of tiles) {
        const owner = worldPlaneSourceIds[tile.room];
        if (owner === undefined || !worldGameRooms.has(owner)) continue;
        const key = worldGame!.environmentKey(owner);
        let group = groups.get(key);
        if (!group) groups.set(key, group = { owner, tiles: [] });
        group.tiles.push(tile);
      }
      const T = world.tileUnits;
      for (const { owner, tiles: list } of groups.values()) {
        await backgroundTurn('floor');
        if (!worldGameOn() || worldFarFloorState !== 'building') return;
        const room = worldGameRooms.get(owner)!;
        const f = worldFrame.frames.get(owner)!;
        const ox = f.x + worldFrame.ox, oy = f.y + worldFrame.oz;
        const base = await worldGameSource(owner);
        const source: GameRoomSource = { ...base, batches: [], actors: [], lights: undefined, others: [],
          plane: list.map((t) => ({ ...t, x: t.x - ox, y: t.y - oy })) };
        const scene = await worldGame!.buildScene(source, room.origin, { cluster: true });
        renderer.resetState();
        const o = room.origin, b = scene.bounds;
        scenes.push({ scene, box: b ? [o.x + b[0], o.y + b[1], o.z + b[2], o.x + b[3], o.y + b[4], o.z + b[5] + T] : room.box });
      }
      if (!worldGameOn() || worldFarFloorState !== 'building') return;
      worldFarFloor = scenes.splice(0);
      worldFarFloorState = 'built';
    } catch (error) {
      console.warn('game shading: endless floor not laid', error);
    } finally {
      for (const { scene } of scenes) worldGame?.disposeScene(scene);   // (left unfinished)
      if (worldFarFloorState === 'building') worldFarFloorState = 'none';
    }
  }
  /** The endless floor wanted (no limit, the floor shown, the world in the game's shading) built, else dropped. */
  function syncWorldFarFloor(): void {
    const wanted = worldGameOn() && !!state.ground && groundDistance() > PLANE_FIELD_REACH && !!worldPlaneField;
    if (wanted && worldFarFloorState === 'none' && !worldClusterBuilding) buildWorldFarFloor().catch(() => { /* reported */ });
    if (!wanted && worldFarFloorState !== 'none') dropWorldFarFloor();
  }

  async function worldGameSource(id: number): Promise<GameRoomSource> {
    const shard = await cachedShard(id);
    const meta = (world.index?.rooms || []).find((room: any) => Number(room.id) === id) ?? null;
    // the room in its own frame: its parts as a single room has them, without its neighbours
    const room = { id, shard, meta, group: new THREE.Group() };
    const parts = await world._gameRoomParts(room as any);
    return { ...parts, plane: worldGamePlane(id), others: [] };
  }

  /** The rooms the merged batches (or the room graph) leave to the game's frame. */
  function setClassicRoomHidden(id: number, hidden: boolean): void {
    merged?.setRoomsHidden([id], hidden);
    const room = world.rooms.get(id);
    if (room) room.group.visible = !hidden;
  }

  /** What draws each room (on its own, in its cluster, or the merged batches), its slot in the clusters'
   *  room mask, and whether the merged batches are needed at all. */
  function syncRooms(): void {
    const on = worldGameOn();
    let all = on;
    for (const room of worldGameRooms.values()) {
      worldGame?.setRoomHidden(room.slot, !!room.scene);
      room.drawnByGame = on && (!!room.scene || !!room.cell.clusters);
      // with the game's shading a room shows once drawn in it, never in the plain shading first (beyond the
      // shading distance, not at all); one the game's frame could not build keeps the plain shading
      const plain = !on || room.failed || (room.cell.clusterFailed && !room.scene);
      if (plain === room.classicHidden) {
        room.classicHidden = !plain;
        setClassicRoomHidden(room.id, !plain);
      }
      if (plain) all = false;
    }
    if (all !== worldAllGame) {
      worldAllGame = all;
      // (back in view only where the merged rendering is the display path)
      if (merged) merged.setVisible(!all && mergedActive());
      if (worldPlane) worldPlane.visible = !all && !!state.ground;
    }
  }

  async function buildWorldGameRoom(entry: WorldGameRoom): Promise<void> {
    worldGameBuilding++;
    entry.building = true;
    try {
      const t0 = performance.now();
      // (its resting actors posed once, as parts of the room: they do not move in this view)
      const parts = await worldGameSource(entry.id);
      await backgroundTurn('rest actors');
      const source = worldGame!.restActors(parts);
      if (!worldGameOn()) return;
      // its programs and textures readied beside the build under way, then built in turn
      await worldGame!.prepare(source);
      if (!worldGameOn()) return;
      const t1 = performance.now();
      const scene = await worldGame!.buildScene(source, entry.origin, { shareDepth: true });
      worldGameTimes.push([entry.id, Math.round(t1 - t0), Math.round(performance.now() - t1)]);
      renderer.resetState();
      if (!worldGameOn() || !worldGame) { worldGame?.disposeScene(scene); return; }
      // its bounds: what it draws (its rect where it draws nothing yet)
      const T = world.tileUnits, o = entry.origin, b = scene.bounds;
      const { inner, layers } = source.bounds;
      entry.box = b ? [o.x + b[0], o.y + b[1], o.z + b[2], o.x + b[3], o.y + b[4], o.z + b[5]]
        : [o.x + inner[0] * T, o.y + inner[1] * T, 0, o.x + inner[2] * T, o.y + inner[3] * T, Math.max(1, layers) * world.index.render.shadow.layerHeight];
      entry.scene = scene;
    } catch (error) {
      entry.failed = true;
      console.warn(`game shading: room ${entry.id} skipped`, error);
    } finally {
      entry.building = false;
      worldGameBuilding--;
      syncRooms();
    }
  }

  /** A cell's rooms joined: gathered a few at a time (their actors resting), grouped by the environment
   *  they are drawn in, each group built as one scene in the cell's frame. */
  async function buildWorldCluster(cell: WorldGameCell): Promise<void> {
    worldClusterBuilding++;
    cell.clusterBuilding = true;
    const scenes: GameScene[] = [];
    // (left behind: the camera moved on and the cell is now well past the shading distance)
    const behind = () => {
      const far = worldGameReach();
      if (far === Infinity) return false;
      syncNativeFrame();
      return groundDistance2(cell.box, scene3d.camera.position.clone().applyMatrix4(nativeFromWorld)) > far * 1.25;
    };
    try {
      const lit = worldSteady();
      const gathered: ({ source: GameRoomSource; offset: THREE.Vector3; slot: number; key: string } | null)[] = new Array(cell.rooms.length).fill(null);
      let next = 0;
      await Promise.all(Array.from({ length: WORLD_GATHER_AT_ONCE }, async () => {
        for (let k = next++; k < cell.rooms.length; k = next++) {
          const room = cell.rooms[k];
          if (room.failed || !worldGameOn() || behind()) continue;
          try {
            const parts = await worldGameSource(room.id);
            await backgroundTurn('rest actors');
            const source = worldGame!.restActors(parts);
            gathered[k] = { source, offset: room.origin.clone().sub(cell.frame), slot: room.slot, key: worldGame!.environmentKey(room.id) };
          } catch { /* left to the merged batches */ }
        }
      }));
      if (!worldGameOn()) return;
      const groups = new Map<string, { source: GameRoomSource; offset: THREE.Vector3; slot: number }[]>();
      for (const g of gathered) {
        if (!g) continue;
        let list = groups.get(g.key);
        if (!list) groups.set(g.key, list = []);
        list.push(g);
      }
      const T = world.tileUnits;
      const size: [number, number] = [Math.ceil((cell.box[3] - cell.frame.x) / T), Math.ceil((cell.box[4] - cell.frame.y) / T)];
      for (const list of groups.values()) {
        await backgroundTurn('join');
        if (!worldGameOn() || behind()) return;
        const source = clusterSource(list, size, list[0].source.roomId, T, lit);
        await worldGame!.prepare(source, 8, false, true);
        if (!worldGameOn()) return;
        scenes.push(await worldGame!.buildScene(source, cell.frame, { shareDepth: true, cluster: true }));
        renderer.resetState();
      }
      if (!worldGameOn() || !worldGame) return;
      cell.clusters = scenes.splice(0);
      cell.lit = lit;
      const o = cell.frame;
      cell.clusterBoxes = cell.clusters.map((s) => (s.bounds
        ? [o.x + s.bounds[0], o.y + s.bounds[1], o.z + s.bounds[2], o.x + s.bounds[3], o.y + s.bounds[4], o.z + s.bounds[5]] : cell.box));
    } catch (error) {
      cell.clusterFailed = true;
      console.warn(`game shading: cell ${cell.key} not joined`, error);
    } finally {
      for (const scene of scenes) worldGame?.disposeScene(scene);   // (left unfinished)
      cell.clusterBuilding = false;
      worldClusterBuilding--;
      syncRooms();
    }
  }

  let worldGameDropped = 0;   // rooms given back since the view opened (tests)
  function dropWorldGameRoom(entry: WorldGameRoom): void {
    if (!entry.scene) return;
    worldGameDropped++;
    worldGame?.disposeScene(entry.scene);
    entry.scene = null;
  }
  function dropWorldCluster(cell: WorldGameCell): void {
    for (const scene of cell.clusters ?? []) worldGame?.disposeScene(scene);
    cell.clusters = null;
    cell.clusterBoxes = [];
    if (cell.shadow) worldGame?.freeShadowTile(cell.shadow);
    cell.shadow = null;
    cell.shadowKey = '';
  }

  /** Every room back to the merged batches (game shading off, or the view going). */
  function stopWorldGame(): void {
    for (const room of worldGameRooms.values()) dropWorldGameRoom(room);
    for (const cell of worldGameCells.values()) dropWorldCluster(cell);
    dropWorldFarFloor();
    syncRooms();
    applyRenderMode();
  }

  // native frame of the view: the camera, and how far a box is from it
  const worldFromNative = new THREE.Matrix4(), nativeFromWorld = new THREE.Matrix4();
  function syncNativeFrame(): void {
    world.root.updateMatrix();
    worldFromNative.multiplyMatrices(displayRoot.matrixWorld, world.root.matrix);
    nativeFromWorld.copy(worldFromNative).invert();
  }
  /** How far a box is from a point across the ground (x, y only). */
  const groundDistance2 = (box: number[], p: THREE.Vector3) => Math.hypot(
    Math.max(box[0] - p.x, 0, p.x - box[3]), Math.max(box[1] - p.y, 0, p.y - box[4]));
  const boxDistance = (box: number[], p: THREE.Vector3) => Math.hypot(
    Math.max(box[0] - p.x, 0, p.x - box[3]), Math.max(box[1] - p.y, 0, p.y - box[4]), Math.max(box[2] - p.z, 0, p.z - box[5]));

  /** A few times a second: the rooms nearest the camera (across the ground: turning changes nothing)
   *  within the budget are drawn on their own, built nearest first; with "Whole world" the cells build
   *  their clusters, nearest first, while no room is building. */
  function updateWorldGame(now: number): void {
    if (!worldGameOn() || worldGameHeld || now - worldGameRanked < 200) return;
    // the draw budget follows the frame's cost (while rooms build, their uploads cost frames too: held)
    if (worldGameDrawn && !worldGameBuilding && !worldClusterBuilding && !worldGameBudgetFixed && now - worldGameBudgetAt > 1000) {
      worldGameBudgetAt = now;
      const frame = worldLoopCost, late = worldLateFrames();
      // (smaller only when the frame ran long, or frames came late, twice running: a passing spike drops
      // nothing; larger only while frames keep the display's pace)
      const slow = frame > WORLD_GAME_FRAME_MS + 1 || late > 0.2;
      worldGameSlow = slow ? worldGameSlow + 1 : 0;
      // (a budget that made frames late is remembered: the budget grows back to just under it, and the
      // mark itself rises a tenth every half minute, so the budget neither saws up and down nor stays low)
      if (now - worldGameCeilingAt > 30000) { worldGameCeiling *= 1.1; worldGameCeilingAt = now; }
      if (worldGameSlow >= 2) {
        if (late > 0.2) { worldGameCeiling = worldGameBudget * 0.9; worldGameCeilingAt = now; }
        worldGameBudget = Math.max(200, Math.round(worldGameBudget * Math.min(0.85, WORLD_GAME_FRAME_MS / frame)));
      } else if (!slow && frame < WORLD_GAME_FRAME_MS - 1 && late < 0.05) {
        worldGameBudget = Math.max(worldGameBudget, Math.min(4000, Math.round(worldGameCeiling), Math.round(worldGameBudget * 1.1)));
      }
    }
    worldGameRanked = now;
    const steady = worldSteady();
    syncNativeFrame();
    const eye = scene3d.camera.position.clone().applyMatrix4(nativeFromWorld);
    const ranked = [...worldGameRooms.values()].filter((r) => !r.failed)
      .map((room) => ({ room, distance: boxDistance(room.box, eye) }))
      .sort((a, b) => a.distance - b.distance);
    // (by distance in 3D, which turning does not change either: from high above, rooms whose cell is joined
    // are left to the cell, each too small on screen to be worth its own draws)
    const reach = WORLD_GAME_NEAR_TILES * world.tileUnits, far = worldGameReach();
    // the nearest rooms within the count and the draw budget (a room not built yet counts as the built
    // ones' average); a room built is kept a little past both, so one at the edge does not come and go
    const built = ranked.filter((r) => r.room.scene);
    const average = built.length ? built.reduce((n, r) => n + r.room.scene!.drawCount, 0) / built.length : 60;
    const wanted: WorldGameRoom[] = [];
    let draws = 0;
    ranked.forEach(({ room, distance }, rank) => {
      const cost = room.scene?.drawCount ?? average;
      const joined = !!room.cell.clusters;
      // (everything kept: none, its cluster draws it the same from near and far)
      // (the shading distance across the ground, as the cells': the camera's height does not count)
      const ground = far === Infinity ? 0 : groundDistance2(room.box, eye);
      const want = !steady && rank < WORLD_GAME_MAX_ROOMS && draws + cost <= worldGameBudget && (!joined || distance <= reach)
        && ground <= far;
      const keep = !steady && !!room.scene && rank < WORLD_GAME_MAX_ROOMS * 1.5 && draws + cost <= worldGameBudget * 1.5
        && (!joined || distance <= reach * 1.25) && ground <= far * 1.25;
      if (want || keep) draws += cost;
      if (want) wanted.push(room);
      if (room.scene && !want && !keep) dropWorldGameRoom(room);
      // (the room graph, when it draws instead of the merged batches, may have loaded the room again since)
      if (room.classicHidden) { const graph = world.rooms.get(room.id); if (graph?.group.visible) graph.group.visible = false; }
    });
    syncRooms();
    for (const room of wanted) {
      if (worldGameBuilding >= WORLD_GAME_IN_FLIGHT) break;
      if (!room.scene && !room.building) buildWorldGameRoom(room).catch(() => { /* reported above */ });
    }
    // the cells within the shading distance joined, the nearest first (asked again every time, so the camera's
    // moves reorder what is left), while no room is building; a cell well past the distance gives its clusters back
    if (far !== Infinity) {
      let dropped = false;
      for (const cell of worldGameCells.values()) {
        if (cell.clusters && groundDistance2(cell.box, eye) > far * 1.25) { dropWorldCluster(cell); dropped = true; }
      }
      if (dropped) syncRooms();
    }
    if (!worldGameBuilding && !worldClusterBuilding) {
      const cells = [...worldGameCells.values()]
        .filter((c) => !c.clusters && !c.clusterBuilding && !c.clusterFailed && groundDistance2(c.box, eye) <= far)
        .sort((a, b) => groundDistance2(a.box, eye) - groundDistance2(b.box, eye));
      if (cells.length) buildWorldCluster(cells[0]).catch(() => { /* reported above */ });
    }
    if (steady) bakeWorldShadows(eye);
    syncWorldFarFloor();
  }

  /** Everything kept: the shadow maps of the cells whose casters changed (a cell joined within reach), nearest
   *  first, a few each time. */
  let worldShadowBakes = 0;   // (tests)
  function bakeWorldShadows(eye: THREE.Vector3): void {
    const T = world.tileUnits, reach = WORLD_SHADOW_REACH_TILES * T;
    const joined = [...worldGameCells.values()].filter((c) => c.clusters?.length);
    const todo: { cell: WorldGameCell; box: number[]; casters: GameScene[]; key: string }[] = [];
    for (const cell of joined) {
      const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const b of cell.clusterBoxes) growBox(box, b);
      const near = (b: number[]) => b[0] < box[3] + reach && b[3] > box[0] - reach && b[1] < box[4] + reach && b[4] > box[1] - reach;
      const from = joined.filter((c) => c.clusterBoxes.some(near));
      const key = from.map((c) => c.key).sort().join(';');
      if (key === cell.shadowKey) continue;
      todo.push({ cell, box, key, casters: from.flatMap((c) => c.clusters!.filter((_, k) => near(c.clusterBoxes[k]))) });
    }
    todo.sort((a, b) => groundDistance2(a.box, eye) - groundDistance2(b.box, eye));
    const t0 = performance.now();
    for (const { cell, box, casters, key } of todo) {
      if (performance.now() - t0 > 6) break;
      const extent = Math.max(box[3] - box[0], box[4] - box[1]) / T;
      const size = Math.min(WORLD_SHADOW_MAX, 2 ** Math.ceil(Math.log2(Math.max(256, extent * WORLD_SHADOW_TEXELS))));
      cell.shadow = worldGame!.bakeShadowTile(box, casters, size, cell.shadow);
      cell.shadowKey = key;
      worldShadowBakes++;
    }
    if (todo.length) renderer.resetState();
  }

  /** The scenes the camera sees, nearest first: the rooms drawn on their own and the clusters (less those
   *  rooms); and the rooms near enough to cast the shadow map. */
  const worldFrustum = new THREE.Frustum(), worldBox = new THREE.Box3(), frustumMatrix = new THREE.Matrix4();
  function visibleWorldScenes(eye: THREE.Vector3): { visible: { scene: GameScene; box: number[]; room: boolean }[]; casters: { scene: GameScene; box: number[] }[] } {
    const camera = scene3d.camera;
    camera.updateMatrixWorld();
    frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    worldFrustum.setFromProjectionMatrix(frustumMatrix);
    const inView = (b: number[]) => {
      worldBox.min.set(b[0], b[1], b[2]); worldBox.max.set(b[3], b[4], b[5]);
      return worldFrustum.intersectsBox(worldBox.applyMatrix4(worldFromNative));
    };
    const visible: { scene: GameScene; box: number[]; room: boolean; distance: number }[] = [];
    for (const room of worldGameRooms.values()) {
      if (room.scene && inView(room.box)) visible.push({ scene: room.scene, box: room.box, room: true, distance: boxDistance(room.box, eye) });
    }
    {
      for (const cell of worldGameCells.values()) {
        cell.clusters?.forEach((scene, k) => {
          const box = cell.clusterBoxes[k];
          if (inView(box)) visible.push({ scene, box, room: false, distance: boxDistance(box, eye) });
        });
      }
    }
    visible.sort((a, b) => a.distance - b.distance);
    // the endless floor, behind everything (in view wherever the camera looks down)
    for (const { scene, box } of worldFarFloor) visible.push({ scene, box, room: false, distance: Infinity });
    const shadowReach = WORLD_GAME_SHADOW_TILES * world.tileUnits;
    return {
      visible,
      // (everything kept: each cell's own shadow map, drawn once)
      casters: worldSteady() ? [] : visible.filter((v) => v.room && v.distance <= shadowReach).slice(0, WORLD_GAME_CASTERS),
    };
  }

  /** All rooms' frame: the game's frame for the cells it draws (the canvas cleared to the view's
   *  background first), then three's view of the rest of the world and the overlays. */
  let frozenTicks: number | null = null;   // tests: the game frame's clock held (stills that compare byte for byte)
  function renderAllRooms(): void {
    const scene = scene3d.scene, camera = scene3d.camera;
    // the merged world's cells out of view are skipped whole (all of them drawn while the sun casts
    // shadows: an unseen cell can shade the view)
    if (merged && !worldAllGame) { merged.cellCulling = !state.shadows; merged.cullCells(camera); }
    if (!worldGameOn()) {
      if (worldGameBuilding || worldClusterBuilding) renderer.resetState();
      renderer.render(scene, camera);
      return;
    }
    syncNativeFrame();
    const eye = camera.position.clone().applyMatrix4(nativeFromWorld);
    const { visible, casters } = visibleWorldScenes(eye);
    if (!visible.length) {
      renderer.resetState();
      renderer.render(scene, camera);
      return;
    }
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const target = camera.position.clone().add(forward).applyMatrix4(nativeFromWorld);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).transformDirection(nativeFromWorld);
    const units = nativeFromWorld.getMaxScaleOnAxis();
    const size = worldStillSize ?? renderer.getDrawingBufferSize(new THREE.Vector2());
    // the shadow map over the casters (or, with none near, the nearest scenes in view)
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const v of casters.length ? casters : visible.slice(0, 1)) growBox(box, v.box);
    // the plain floor under the rooms the game's frame draws lies at its floor's depth: it gives way
    for (const material of worldPlaneMaterials.values()) {
      material.polygonOffset = true; material.polygonOffsetFactor = 1; material.polygonOffsetUnits = 8;
    }
    const background = scene.background as THREE.Color | null;
    if (background?.isColor) renderer.setClearColor(background, 1);
    renderer.setRenderTarget(null);
    renderer.clear();
    const t0 = performance.now();
    // (everything kept: every scene in view in the occlusion, and each cluster its cell's shadow map)
    const steady = worldSteady();
    let tiles: Map<GameScene, ShadowTile> | null = null;
    if (steady && !(window as any).__bs?.noShadowTiles) {   // (tests: without them, to compare)
      tiles = new Map();
      for (const cell of worldGameCells.values()) if (cell.shadow) for (const scene of cell.clusters ?? []) tiles.set(scene, cell.shadow);
    }
    worldGame!.renderWorld({ eye, target, up, fov: camera.fov, width: size.x, height: size.y, near: camera.near * units, far: camera.far * units },
      frozenTicks ?? waterTicks, 0, visible.map((v) => v.scene), casters.map((v) => v.scene), box,
      (steady ? visible : visible.filter((v) => v.room).slice(0, WORLD_GAME_OCCLUDERS)).map((v) => v.scene), tiles);
    worldGameCost = worldGameCost * 0.9 + (performance.now() - t0) * 0.1;
    worldGameDrawn = visible.length;
    renderer.resetState();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    scene.background = null;
    const t1 = performance.now();
    renderer.render(scene, camera);
    worldThreeCost = worldThreeCost * 0.9 + (performance.now() - t1) * 0.1;
    renderer.autoClear = autoClear;
    scene.background = background;
  }
  let worldThreeCost = 0;
  let worldStillSize: THREE.Vector2 | null = null;   // (tests: a still's own size)
  let worldGameBudgetAt = 0;
  let worldGameBudgetFixed = false;   // (tests: a budget that does not follow the frame)
  let worldGameHeld = false;   // (tests: what is drawn left as it is wherever the camera goes)
  let worldGameSlow = 0;
  let worldGameCeiling = Infinity, worldGameCeilingAt = 0;   // the budget that last made frames late

  // Actors in the game's frame: a spawn playing a clip (its resting clip, or
  // one picked in the inspector) is drawn in its live pose. Its skinned
  // meshes' skin matrices, taken to the native frame, are the palette the
  // game's skinned programs read; three's own copies leave the camera.
  const nativeFromDisplay = new THREE.Matrix4(), skin = new THREE.Matrix4(), editMatrix = new THREE.Matrix4();
  world.actorPalette = (roomId: number, spawnIndex: number, partIndex: number, mesh: number, rest: Float32Array) => {
    if (!state.spawns) return null;
    const edit = edits.get({ room: roomId, sourceKind: 'spawn', category: 'spawns', placementIndex: partIndex });
    if (edit?.deleted) return null;
    const key = `${roomId}|spawn|${spawnIndex}`;
    const sa = spawnAnim?.key === key ? spawnAnim : persistentAnims.get(key);
    const part = sa?.active ? sa.composite?._meshes.find((m: any) => m.isSkinnedMesh && m.userData.mesh === mesh) : null;
    if (!part) {
      // resting: a nudge or turn moves the resting pose about the spawn's anchor
      if (!edit || edits.isNoop(edit)) return undefined;
      const room = world.rooms.get(roomId);
      let info;
      try { info = room && world._describeSpawn({ id: roomId, shard: room.shard }, spawnIndex); } catch { info = null; }
      if (!info) return undefined;
      const pivot = pivotFor(info);
      editedMatrix(edit, new THREE.Matrix4(), pivot[0], pivot[1], world.tileUnits, world.layerUnits, editMatrix);
      return placeSkin(editMatrix, rest);
    }
    const skeleton = part.skeleton;
    const out = new Float32Array(skeleton.bones.length * 12);
    nativeFromDisplay.copy(world.root.matrixWorld).invert().multiply(part.matrixWorld).multiply(part.bindMatrixInverse);
    for (let b = 0; b < skeleton.bones.length; b++) {
      skin.multiplyMatrices(skeleton.bones[b].matrixWorld, skeleton.boneInverses[b]).multiply(part.bindMatrix).premultiply(nativeFromDisplay);
      const e = skin.elements, o = b * 12;
      out[o] = e[0]; out[o + 1] = e[4]; out[o + 2] = e[8]; out[o + 3] = e[12];
      out[o + 4] = e[1]; out[o + 5] = e[5]; out[o + 6] = e[9]; out[o + 7] = e[13];
      out[o + 8] = e[2]; out[o + 9] = e[6]; out[o + 10] = e[10]; out[o + 11] = e[14];
    }
    return out;
  };
  /** Composite meshes the game's frame draws leave three's camera while it does. */
  function syncActorLayers(on: boolean): void {
    const materials = world.index?.render?.materials;
    spawnAnimRoot.traverse((o: any) => {
      if (!o.isMesh) return;
      const drawn = on && o.userData.gameMaterial !== undefined && !!materials?.[String(o.userData.gameMaterial)];
      o.layers.set(drawn ? GAME_DRAWN_LAYER : 0);
    });
  }

  /** Native-frame camera of the current view (or the harness override). */
  function currentGameCamera() {
    const nativeFromWorld = world.root.matrixWorld.clone().invert();
    const eye = gameCamera?.eye ?? scene3d.camera.position.clone().applyMatrix4(nativeFromWorld);
    const target = gameCamera?.target ?? scene3d.controls.target.clone().applyMatrix4(nativeFromWorld);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // (the camera's range: the game's, or out to an endless floor)
    const T = world.tileUnits;
    return { eye, target, fov: scene3d.camera.fov, width: size.x, height: size.y, near: scene3d.camera.near * T, far: scene3d.camera.far * T };
  }
  if (!allMode) {
    (scene3d as any)._loop = function gameLoop(this: any, t: number) {
      if (!this._alive) return;
      const dt = Math.min(100, t - this._lastT);
      this._lastT = t;
      for (const fn of this._ticks) fn(dt);
      this.controls.update();
      if (gameActive()) {
        world.root.updateMatrixWorld();
        const camera = currentGameCamera();
        if (gameCamera) {
          // keep three's camera on the same view for the overlays
          const worldFromNative = world.root.matrixWorld;
          this.camera.position.copy(camera.eye.clone().applyMatrix4(worldFromNative));
          this.camera.lookAt(camera.target.clone().applyMatrix4(worldFromNative));
          this.camera.updateMatrixWorld();
        }
        // the bones' posed matrices, current for this frame's palettes
        spawnAnimRoot.updateMatrixWorld(true);
        syncActorLayers(true);
        gameFrame!.render(camera, waterTicks, camera.target.z);
        this.renderer.resetState();
        // A colour background makes three clear the frame: overlays only.
        const autoClear = this.renderer.autoClear, background = this.scene.background, fog = this.scene.fog;
        this.renderer.autoClear = false;
        this.scene.background = null;
        this.scene.fog = null;
        this.renderer.render(this.scene, this.camera);
        this.renderer.autoClear = autoClear;
        this.scene.background = background;
        this.scene.fog = fog;
      } else {
        if (gameBuilds) this.renderer.resetState();
        syncActorLayers(false);
        this.renderer.render(this.scene, this.camera);
      }
      requestAnimationFrame(this._loop);
    }.bind(scene3d);
  }

  // Builds whose data carries the game's water materials draw water with
  // them (surfaces and shoreline curtains); older data keeps the sheets.
  const gameWaterAvailable = () => !!world.index?.water;
  function applyWater(): void {
    const enabled = !!state.water;
    if (gameWaterAvailable()) world.setGameWaterEnabled(enabled);
    const auto = state.wcolor === 'auto';
    const override = waterUniforms.sheetColorOverride.value;
    override.w = auto ? 0 : 1;
    if (!auto) {
      const custom = new THREE.Color(`#${state.wcolor}`).convertSRGBToLinear();
      override.set(custom.r, custom.g, custom.b, 1);
    }
    waterUniforms.sheetOpacity.value = state.wopacity / 100;
    for (const meshes of roomWaterSheets.values()) {
      for (const mesh of meshes) mesh.visible = enabled;
    }
    for (const curtains of roomWaterCurtains.values()) {
      for (const mesh of curtains) mesh.visible = enabled ? false : isMeshBaseVisible(mesh);
    }
    merged?.setWaterSheetsVisible(enabled);
    merged?.setWaterCurtainsVisible(!enabled);
  }

  // A curtain re-shown by the water toggle must still honour its z/category
  // visibility (world._applyMeshVisibility owns that base state).
  function isMeshBaseVisible(mesh: any): boolean {
    const exact = mesh.userData.exact;
    return world.isZVisible(exact.z)
      && (!exact.untextured || world.showUntextured);
  }

  function applyRoomWater(room: any): void {
    const id = Number(room.id);
    // a room just loaded: switch its own water (applyWater over every loaded
    // room, once per room, grows with the square of the room count)
    if (gameWaterAvailable()) { world.setGameWaterEnabled(!!state.water, [room]); return; }
    if (!roomWaterCurtains.has(id)) {
      roomWaterCurtains.set(id, room.meshes.filter((mesh: any) => {
        const exact = mesh.userData.exact;
        return exact && !exact.authoredEmpty
          && Number(exact.renderTexture) >= 0
          && waterRegistry.isWater(exact.renderTexture)
          && isWaterWallGeometry(mesh.geometry);
      }));
    }
    if (!roomWaterCurtains.get(id)!.length) return;
    if (!roomWaterSheets.has(id)) {
      const tiles = collectRoomWaterTiles(world, room, waterRegistry);
      const byTexture = new Map<any, any[]>();
      for (const tile of tiles) {
        const list = byTexture.get(tile.texture) || [];
        list.push(tile);
        byTexture.set(tile.texture, list);
      }
      const meshes = [];
      for (const [texture, group] of byTexture) {
        const mesh = new THREE.Mesh(
          buildWaterSheetGeometry(group),
          waterSheetMaterialFor(texture, waterUniforms, sheetMaterialCache),
        );
        mesh.name = `water-sheet-${id}-t${texture}`;
        room.group.add(mesh);
        meshes.push(mesh);
      }
      roomWaterSheets.set(id, meshes);
    }
    applyWater();
  }

  function disposeRoomWaterSheets(roomId: number): void {
    const meshes = roomWaterSheets.get(Number(roomId));
    if (!meshes) return;
    for (const mesh of meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    roomWaterSheets.delete(Number(roomId));
  }

  // ambient particle effects (per-room layer + merged all-rooms) --------------
  // Single room: driven by the same loaded/unloaded seam as water. Merged
  // all-rooms: proximity activation instead (updateMergedEffectsActivation
  // below) -- the loaded/unloaded stream events fire for every one of the
  // (possibly 451) rooms regardless of camera position, so they are guarded
  // off for allMode at the onStatus call sites above. Both modes share one
  // effectsLayer instance, the same effectsRoot and the same doc fetch: the
  // doc is optional and multi-MB, so it is fetched once, lazily, the first
  // time either mode wants the layer.
  function effectsSupported(): boolean {
    return typeof app.store.worldEffects === 'function';
  }
  function effectsRoomLoaded(roomId: any): void {
    if (!effectsSupported()) return;
    effectsRooms.add(Number(roomId));
    applyEffects();
  }
  function effectsRoomUnloaded(roomId: number): void {
    effectsRooms.delete(Number(roomId));
    effectsLayer?.removeRoom(Number(roomId));
    dropActorEffects(Number(roomId));
    // A pinned effect belonging to this room just went away underneath the
    // pin: release it rather than leave a stale readout (refreshEffectReadout
    // would also catch this reactively, but clearing proactively here avoids
    // a frame of showing knobs for an instance that no longer exists).
    if (effectPinned && Number(effectPinned.key.split('|')[0]) === Number(roomId)) clearEffectInspection(true);
  }
  // An actor rests under a controller (its spawn row's idle_controller), and the effect system that controller names
  // (a system lists the controllers that name it) plays while it rests, as the game plays it with the controller:
  // in the actor's frame, on its rig posed in the resting clip's first frame. Each room's actor effects are kept
  // apart from its own (actorEffectsKey), so they come and go with the room.
  const actorEffectsKey = (roomId: number) => -(roomId + 1);
  const actorEffectRooms = new Map<number, number>();   // room -> the token of its latest build
  const actorEffectPoses = new Map<number, { occurrence: number; animation: EffectBoneAnimation }[]>();
  let actorEffectToken = 0;
  function dropActorEffects(roomId: number): void {
    const key = actorEffectsKey(roomId);
    effectsLayer?.removeRoom(key);
    for (const { occurrence, animation } of actorEffectPoses.get(roomId) ?? []) {
      effectsLayer?.setOccurrenceAnimation(key, occurrence, null);
      animation.dispose();
    }
    actorEffectPoses.delete(roomId);
    actorEffectRooms.delete(roomId);
  }
  let controllerSystems: Map<number, number[]> | null = null;
  let controllerSystemsDoc: any = null;
  function systemsOfController(controller: number): number[] {
    if (controllerSystemsDoc !== effectsDoc) {
      controllerSystemsDoc = effectsDoc;
      controllerSystems = new Map();
      for (const system of effectsDoc?.systems ?? []) {
        for (const c of system.controllers ?? []) {
          let list = controllerSystems.get(Number(c));
          if (!list) controllerSystems.set(Number(c), list = []);
          list.push(Number(system.slot));
        }
      }
    }
    return controllerSystems!.get(controller) ?? [];
  }
  async function addActorEffects(roomId: number): Promise<void> {
    const layer = effectsLayer;
    if (!layer || !effectsDoc) return;
    const token = ++actorEffectToken;
    actorEffectRooms.set(roomId, token);
    const live = () => !destroyed && effectsLayer === layer && actorEffectRooms.get(roomId) === token;
    // (the room view's loaded room, else the stored shard: All rooms bakes its rooms without keeping them)
    const shard = world.rooms.get(roomId)?.shard ?? await world.roomShard(roomId).catch(() => null);
    if (!live()) return;
    const sc = world.spawnColumns;
    if (!shard.spawns?.length || !sc || sc.idle_controller === undefined) return;
    const tickRate = layer.clock.tickRate || Number(effectsDoc.tick_rate?.value) || 600;
    const num = (v: any): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
    const attachments: any[] = [];
    const poses: { occurrence: number; animation: EffectBoneAnimation }[] = [];
    for (let index = 0; index < shard.spawns.length; index++) {
      const spawn = shard.spawns[index];
      const controller = num(spawn[sc.idle_controller]);
      const systems = controller !== null && controller >= 0 ? systemsOfController(controller) : [];
      if (!systems.length) continue;
      let info: any;
      try { info = world._describeSpawn({ id: roomId, shard }, index); } catch { continue; }
      // the rig and the resting clip the actor is posed in (its first frame)
      let rig: number | null = null;
      let animation: EffectBoneAnimation | null = null;
      try {
        const resolved = await resolveSpawnAnim({ store: app.store, parts: info?.parts ?? [] });
        if (resolved.kind === 'ready') {
          rig = Number(resolved.skelOrdinal);
          const entry = resolved.clips.find((c: any) => c.i === info.defaultClip && c.f);
          if (entry) {
            const [skeleton, clip] = await Promise.all([app.store.json(resolved.skelEntry.f), app.store.json(entry.f)]);
            animation = new EffectBoneAnimation(skeleton, clip, true, tickRate, () => 0, 0);
          }
        }
      } catch { /* no rig: the effect sits on the actor's root */ }
      if (!live()) { animation?.dispose(); return; }
      const x = num(spawn[sc.x]) ?? 0, y = num(spawn[sc.y]) ?? 0, centre = num(spawn[sc.centre_offset]) ?? 0.5;
      const surface = num(spawn[sc.surface_z]);
      const z = surface !== null ? surface / world.layerUnits : (num(spawn[sc.z]) ?? 0);
      // (the actor's frame: its tile centre, its height, its own turn plus the half turn actors face by)
      for (const system of systems) {
        // (each actor's loop began at its own moment: a fixed phase within the system's cycle, so actors that rest
        // alike do not puff in lockstep)
        const cycle = Math.max(1, Number(effectsDoc.systems.find((s: any) => Number(s.slot) === system)?.cycle_ticks) || 600);
        attachments.push({ occurrence: index, system, cell: [x, y, z], center: [x + centre, y + centre],
          rot: ((num(spawn[sc.rotation_quarters]) ?? 0) & 3) + 2, packedFlags: 0, matrix: null, rig, active: true,
          phase: hash32(roomId, index) % cycle });
      }
      if (animation) poses.push({ occurrence: index, animation });
    }
    if (!live() || !attachments.length) { for (const p of poses) p.animation.dispose(); return; }
    const key = actorEffectsKey(roomId);
    for (const { occurrence, animation } of poses) layer.setOccurrenceAnimation(key, occurrence, animation);
    actorEffectPoses.set(roomId, poses);
    layer.addRoom(key, spawnRoomOffset(roomId), { extra: attachments });
  }
  function ensureEffectsDoc(): void {
    if (effectsDocRequested || !effectsSupported()) return;
    effectsDocRequested = true;
    Promise.resolve(app.store.worldEffects!()).then((doc: any) => {
      if (destroyed || !doc || !Array.isArray(doc.systems) || !doc.systems.length) return;
      effectsDoc = doc;
      applyEffects();
    }).catch(() => { /* no effects data for this version: layer stays dormant */ });
  }
  function applyEffects(): void {
    if (destroyed) return;
    if (!state.effects || !effectsSupported()) {
      // toggle-off DISPOSES (not hides) so GL memory returns to baseline
      effectsLayer?.dispose();
      effectsLayer = null;
      activeEffectRooms.clear();
      for (const id of [...actorEffectRooms.keys()]) dropActorEffects(id);
      if (effectPinned) clearEffectInspection(true);   // the pinned instance just got disposed
      return;
    }
    ensureEffectsDoc();
    if (!effectsDoc || !world.index) return;
    if (!effectsLayer) {
      effectsLayer = new WorldEffectsLayer({
        root: effectsRoot,
        doc: effectsDoc,
        url: (rel: string) => app.store.url(rel),
        textures: world.index.textures || {},
        tileUnits: world.tileUnits,
        layerUnits: world.layerUnits,
        meshForwardQuarterTurns: world.meshForwardQuarterTurns,
        kinds: effectKinds(),
        // Merged mode activates far more room effect sets than a lone room
        // ever holds at once, and the alive budget must thin proportionally
        // across all of them, not per room.
      });
      effectsLayer.setMarkersShown(state.inspect && state.fxmarkers);
    }
    if (allMode) {
      updateMergedEffectsActivation();   // re-rank immediately, don't wait for the next tick
    } else {
      for (const id of effectsRooms) {
        effectsLayer.addRoom(id, spawnRoomOffset(id), { leftOut: world.roomLeftOut.get(id) });
        if (!actorEffectRooms.has(id)) addActorEffects(id).catch(() => { /* the room keeps its other effects */ });
      }
    }
  }

  // Merged all-rooms candidate rooms: every placed room with its stitched
  // tile-space center (same frame the fly camera and focusExtent() operate
  // in), marked when the doc attaches ANY system to it. Built once the doc and
  // worldFrame are both ready. A room the doc attaches nothing to is a
  // candidate only once its loaded shard shows an actor resting under a
  // controller that names an effect (hasActorEffects), so empty rooms never
  // take the nearest slots; a room without a system that survives the
  // loopOnly filter simply activates to nothing.
  let effectsCandidates: { id: number; x: number; z: number; attached: boolean }[] | null = null;
  function ensureEffectsCandidates(): { id: number; x: number; z: number; attached: boolean }[] {
    if (effectsCandidates) return effectsCandidates;
    if (!effectsDoc || !worldFrame) return [];
    const attached = new Set<number>((effectsDoc.attachments?.rooms || []).map((att: any) => Number(att.room)));
    const list: { id: number; x: number; z: number; attached: boolean }[] = [];
    for (const [id, frame] of worldFrame.frames) {
      list.push({ id: Number(id), x: frame.x + worldFrame.ox + frame.w / 2, z: frame.y + worldFrame.oz + frame.h / 2,
        attached: attached.has(Number(id)) });
    }
    effectsCandidates = list;
    return list;
  }
  const actorEffectsIn = new Map<number, boolean | null>();   // room -> whether its actors rest with an effect (null: asking)
  function hasActorEffects(roomId: number): boolean {
    const known = actorEffectsIn.get(roomId);
    if (known !== undefined) return !!known;
    const sc = world.spawnColumns;
    if (!effectsDoc || !sc || sc.idle_controller === undefined) return false;
    // (the stored shard is read once, in the background: the answer counts from the next re-rank)
    actorEffectsIn.set(roomId, null);
    Promise.resolve(world.rooms.get(roomId)?.shard ?? world.roomShard(roomId)).then((shard: any) => {
      actorEffectsIn.set(roomId, (shard?.spawns ?? []).some((spawn: any) => {
        const controller = Number(spawn[sc.idle_controller]);
        return Number.isInteger(controller) && controller >= 0 && systemsOfController(controller).length > 0;
      }));
    }).catch(() => actorEffectsIn.set(roomId, false));
    return false;
  }
  // Re-rank candidate rooms by fly-camera distance and reconcile the active
  // set against MAX_ACTIVE_MERGED, honouring the +-hysteresis band so a room
  // sitting near the radius boundary doesn't activate/deactivate every
  // re-rank. Called on a slow cadence from the tick loop, plus once
  // immediately whenever the layer/doc first becomes ready.
  function updateMergedEffectsActivation(): void {
    if (!allMode || !effectsLayer || destroyed) return;
    const candidates = ensureEffectsCandidates();
    if (!candidates.length) return;
    const cam = scene3d.camera.position;
    const enterRadius = MERGED_ACTIVATION_RADIUS - MERGED_ACTIVATION_HYSTERESIS;
    const keepRadius = MERGED_ACTIVATION_RADIUS + MERGED_ACTIVATION_HYSTERESIS;
    const eligible: { id: number; d: number }[] = [];
    for (const room of candidates) {
      const dx = room.x - cam.x;
      const dz = room.z - cam.z;
      // (the camera's height counts: from high above, effects too small to see stay off)
      const d = Math.hypot(dx, dz, cam.y);
      const wasActive = activeEffectRooms.has(room.id);
      // (a room without scenery effects is asked about its actors only once it is within reach)
      if (d <= (wasActive ? keepRadius : enterRadius) && (room.attached || hasActorEffects(room.id))) eligible.push({ id: room.id, d });
    }
    eligible.sort((a, b) => a.d - b.d);
    const nextActive = new Set(eligible.slice(0, MAX_ACTIVE_MERGED).map((r) => r.id));
    for (const id of activeEffectRooms) {
      if (nextActive.has(id)) continue;
      activeEffectRooms.delete(id);
      effectsLayer!.removeRoom(id);
      dropActorEffects(id);
      // proximity deactivated the pinned instance's room: release the pin
      // (merged mode cycles rooms in/out every re-rank, unlike single-room
      // unload which only happens on navigation).
      if (effectPinned && Number(effectPinned.key.split('|')[0]) === id) clearEffectInspection(true);
    }
    for (const id of nextActive) {
      // (an active room's actors: added once its shard is in, which may be a later re-rank)
      if (activeEffectRooms.has(id)) {
        if (!actorEffectRooms.has(id)) addActorEffects(id).catch(() => { /* the room keeps its other effects */ });
        continue;
      }
      activeEffectRooms.add(id);
      effectsLayer!.addRoom(id, spawnRoomOffset(id),
        { loopOnly: true, leftOut: world.roomLeftOut.get(id) });
      addActorEffects(id).catch(() => { /* the room keeps its other effects */ });
    }
  }

  // lighting ---------------------------------------------------------------------
  // The room ambience controls scene lighting. It is not an effect tint;
  // individual effect instances retain their own authored colours.
  function roomAmbience(): number[] | null {
    if (mergedActive()) return null;
    const ids = [...world.rooms.keys()];
    if (ids.length !== 1) return null;
    const rec = (world.index?.rooms || []).find((r: any) => Number(r.i ?? r.id ?? r.idx) === Number(ids[0]));
    const first = rec?.ambience?.colors?.[0];
    return Array.isArray(first) && first.length >= 3 ? first.map(Number) : null;
  }

  function applyLights(): void {
    hemi.intensity = state.ambient;
    sun.intensity = state.sun;
    // Tint the sky light with the room's authored ambience. Its HUE only: the
    // authored values are dark (0.16 to 0.59), and multiplying them into an
    // intensity tuned for white light would just make every room dim. Scaling
    // each colour so its brightest channel is 1 keeps the room's cast while
    // leaving overall brightness to the Ambient slider, which is what a
    // viewer wants to stay in control of.
    const amb = roomAmbience();
    if (amb) {
      const peak = Math.max(amb[0], amb[1], amb[2], 1e-4);
      hemi.color.setRGB(amb[0] / peak, amb[1] / peak, amb[2] / peak);
    } else {
      hemi.color.set(0xcfe0ff);
    }
  }
  function applyShadows(): void {
    renderer.shadowMap.enabled = !!state.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.needsUpdate = true;
    sun.castShadow = !!state.shadows;
    updateSunShadow();
  }
  function applyFlatten(): void {
    displayRoot.scale.y = state.flatten ? 0.02 : 1;
    displayRoot.updateMatrix();   // frozen root: re-compose explicitly
  }
  // Shadows follow the orbit target, with the ortho frustum sized to the
  // current viewing distance (close-ups dense, wide views covered).
  function updateSunShadow(): void {
    if (!sun.castShadow) return;
    const focus = scene3d.controls.target;
    const extent = Math.min(560, Math.max(36, scene3d.camera.position.distanceTo(focus) * 1.15));
    sunTarget.position.set(focus.x, 0, focus.z);
    sun.position.set(focus.x + extent * 0.65, extent * 1.3, focus.z + extent * 0.45);
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = extent * 4;
    sun.shadow.camera.updateProjectionMatrix();
    sunTarget.updateMatrixWorld();
    sun.updateMatrixWorld();
  }
  const onControlsChange = () => updateSunShadow();
  scene3d.controls.addEventListener('change', onControlsChange);

  // Story progress: rooms whose lighting follows a quest get a slider over
  // that quest's steps (game shading only), starting at the story's end.
  const storyBox = el('div', { class: 'wp-range', hidden: true });
  function setupStory(roomId: number): void {
    clear(storyBox);
    storyBox.hidden = true;
    const story = world.index?.render?.story?.[String(roomId)];
    if (!story || !gameFrame) return;
    const out = el('span', { class: 'dim small' });
    const input = el('input', { type: 'range', min: '1', max: String(story.states), step: '1', value: String(story.states),
      'aria-label': `Story progress: ${story.quest}` }) as HTMLInputElement;
    const changes = story.steps.slice(1).map((st: any) => st.from + 1).join(', ');
    const apply = () => {
      const step = Number(input.value) - 1;
      const active = [...story.steps].reverse().find((st: any) => st.from <= step);
      if (gameFrame) gameFrame.environmentOverride = active?.environment ?? null;
      out.textContent = `step ${step + 1} of ${story.states}`;
    };
    input.addEventListener('input', apply);
    apply();
    append(storyBox,
      el('div', { class: 'wp-range-head' }, el('span', { text: 'Story progress', title: `${story.quest}: this room's lighting changes at step ${changes}` }), out),
      el('div', { class: 'dim small', text: story.quest }),
      input);
    storyBox.hidden = false;
  }

  // Room progress: rooms whose parts change as their story moves on (a monument rebuilt in stages) get a slider per
  // progress value, starting at the latest; the game draws one stage, and so does the view (individuals.ts). The
  // choice is kept per build and room, and All rooms draws each room at it.
  const progressBox = el('div', { class: 'wp-range', hidden: true });
  const progressKey = () => `bs.roomProgress.${app.store.versionId ?? ''}`;
  function loadRoomProgress(): void {
    world.allIndividuals = !allMode && !!state.variants;
    world.individualProgress.clear();
    try {
      const saved = JSON.parse(localStorage.getItem(progressKey()) || '{}');
      for (const [key, value] of Object.entries(saved)) if (Number.isInteger(value)) world.individualProgress.set(key, value as number);
    } catch { /* no saved progress */ }
  }
  function saveRoomProgress(): void {
    try { localStorage.setItem(progressKey(), JSON.stringify(Object.fromEntries(world.individualProgress))); } catch { /* not kept */ }
  }
  function setupProgress(roomId: number): void {
    clear(progressBox);
    progressBox.hidden = true;
    const shard = world.rooms.get(roomId)?.shard;
    const own = shard?.room_number;
    const variables = [...progressVariables(shard).values()].filter((v) => v.room === own);
    if (!variables.length) return;
    for (const v of variables) {
      const key = `${v.room}/${v.variable}`;
      const out = el('span', { class: 'dim small' });
      const value = world.individualProgress.get(key) ?? v.latest;
      const input = el('input', { type: 'range', min: '0', max: String(v.latest), step: '1', value: String(Math.min(value, v.latest)),
        'aria-label': 'Room progress' }) as HTMLInputElement;
      const label = () => { out.textContent = Number(input.value) >= v.latest ? 'latest' : `stage ${Number(input.value) + 1} of ${v.latest + 1}`; };
      input.addEventListener('input', label);
      input.addEventListener('change', () => {
        const chosen = Number(input.value);
        if (chosen >= v.latest) world.individualProgress.delete(key); else world.individualProgress.set(key, chosen);
        saveRoomProgress();
        reloadHomeRoom();
      });
      label();
      append(progressBox,
        el('div', { class: 'wp-range-head' }, el('span', { text: 'Room progress', title: "Parts of this room change as its story moves on; the game draws one stage at a time" }), out),
        input);
    }
    progressBox.hidden = false;
  }
  /** The room drawn again as its individuals now are (progress, every variant), its game frame with it. */
  function reloadHomeRoom(): void {
    homeReload = homeReload.then(async () => {
      if (allMode || !entry || destroyed) return;
      const id = Number(entry.i);
      world.unloadRoom(id);
      const room = await world.loadRoom(id);
      if (!room || destroyed) return;
      // loading a room lets every other room go: the neighbours come back with their floor and frame
      if (state.neighbours) { await syncNeighbours(); return; }
      applyCategories();
      applyToggles();
      await world.refreshGroundPlane(id);
      await gameSetup;
      if (gameFrame && !destroyed) {
        await gameFrame.setRoom(await world.gameRoomSource(room, world.neighbourRooms()));
        renderer.resetState();
      }
    }).catch((error) => console.warn('room not drawn again', error));
  }

  // all rooms: how far from the camera rooms are drawn in the game's shading (the nearest room by room, the rest
  // joined); past it nothing is drawn, so a slower graphics card can keep to what is near
  const gameReachRange = allMode ? Object.assign(range('gamereach', 'Shading distance', 0, GAME_REACHES.length - 1, 1,
    (v) => (GAME_REACHES[Number(v)] === Infinity ? '\u221e whole world' : `${GAME_REACHES[Number(v)]} tiles`), () => {
      if (!worldWhole()) for (const cell of worldGameCells.values()) if (cell.lit) dropWorldCluster(cell);
      applyWorldGameSettings();
      if (inputs.gamesteady) inputs.gamesteady.disabled = !worldWhole();
      worldGameRanked = 0;
    }), { title: "How far from the camera rooms are drawn with the game's shading, nearest first (the nearest exactly, the rest a little simplified: no lamps or edge fade). Rooms further away are not drawn: a shorter distance is lighter for slower graphics cards." }) : null;
  gameReachRange?.classList.add('wp-sub');
  // everything kept: the clusters built again with their lamps, in full detail, each cell's shadows its own
  const gameSteadyCheck = allMode ? check('gamesteady', 'Keep everything loaded', () => {
    for (const cell of worldGameCells.values()) dropWorldCluster(cell);
    for (const room of worldGameRooms.values()) dropWorldGameRoom(room);
    applyWorldGameSettings();
    syncRooms();
    worldGameRanked = 0;
  }, { title: "With the whole world shaded: every room drawn the same wherever the camera is, so nothing changes as you move (full detail, lamps and shadows everywhere; effects still start near the camera). Uses more GPU memory." }) : null;
  gameSteadyCheck?.classList.add('wp-sub');
  if (inputs.gamesteady) inputs.gamesteady.disabled = !worldWhole();

  // the views of the data rather than the room (Debug)
  const debugChecks = [
    WORLD_CATEGORIES.includes('components') ? categoryCheck('components') : null,
    check('untextured', 'Untextured fills', applyToggles,
      { swatch: '#6a7d55', title: 'Placements with no decodable texture, drawn in flat category colours' }),
    check('collision', 'Collision extents', applyToggles, { swatch: '#79a9c9' }),
    allMode ? null : check('variants', 'Every variant', () => { world.allIndividuals = !!state.variants; reloadHomeRoom(); },
      { swatch: '#b48ead', title: "Draw every stage and state of the room's parts at once (the game draws one: the room's progress picks it)" }),
    check('empty', 'Editor gizmos', applyToggles,
      { swatch: GIZMO_SWATCH, title: 'Untextured markers placed for the game\'s editor (effect direction arrows, sound, dig and combat markers). The game does not show them.' }),
  ];

  // the game's own lamps and fog (game shading; rooms that have them)
  const gameLightsCheck = check('glights', 'Lamps and torches', () => {
    if (gameFrame) gameFrame.pointLightStrength = state.glights ? 1 : 0;
    applyWorldGameSettings();
  }, { title: 'The light lamps, torches and fires cast (game shading)' });
  const gameFogCheck = check('gfog', 'Fog', () => {
    if (gameFrame) gameFrame.showFog = !!state.gfog;
    applyWorldGameSettings();
  }, { title: 'The fog and deeper light of the rooms an event haunts, as when nothing scares them off (game shading)' });
  gameLightsCheck.classList.add('wp-sub');
  gameFogCheck.classList.add('wp-sub');
  const lightSection = section('Game shading',
    check('game', 'Game shading', () => applyGameShading(),
      { swatch: '#c9a86a', title: allMode
        ? "Draw the rooms near the camera with the game's own lights, shadows, shading and water"
        : "Draw the room with the game's own lights, shadows, shading and water" }),
    gameReachRange, gameSteadyCheck, gameLightsCheck, gameFogCheck,
    storyBox, progressBox,
    check('ground', 'Ground plane', applyGround,
      { swatch: '#8c7b5e', title: 'The textured floor the game lays under and around each room. Each episode has its own; sea and river beds show through the water.' }),
    groundRange,
    allMode ? null : check('neighbours', 'Neighbouring rooms', () => applyNeighbours(),
      { swatch: '#9aa7b8', title: 'Also show the rooms through its doors, in place around it' }),
    allMode ? null : neighbourFadeCheck);
  const flattenCheck = check('flatten', 'Flatten heights', applyFlatten,
    { swatch: '#3a4759', title: 'Squash the vertical axis to read the room like a map' });

  // performance (all-rooms only) ----------------------------------------------
  let perfSection: HTMLElement | null = null;
  function applyRenderScale(): void {
    renderer.setPixelRatio((devicePixelRatio || 1) * (RENDER_SCALES[state.rscale] ?? 1));
    (scene3d as any)._resize();
  }
  const scaleLabel = (v: number) => `${Math.round((RENDER_SCALES[v] ?? 1) * 100)}%`;
  function applyCull(): void {
    merged?.setSmallCullDistance(state.cull ? state.culld : Infinity);
  }
  function mergedActive(): boolean {
    return !!(merged?.ready && state.merged);
  }
  // In merged mode the per-room graph is redundant; detaching it removes the
  // per-frame matrix/visibility traversal of a few hundred thousand objects.
  function applyRenderMode(): void {
    const active = mergedActive();
    merged?.setVisible(active);
    if (active) {
      world.root.removeFromParent();
      // The merged batches are the display path now; the per-room graph's
      // GPU buffers would sit resident alongside them (~2x world GPU memory,
      // enough to wedge Firefox's GPU process on tab close). Free them in
      // slices; unticking Merged streams the rooms back in from IndexedDB.
      if (world.rooms.size) releaseGraphPaced();
    } else if (!world.root.parent && !destroyed) displayRoot.add(world.root);
    // Collision/authored-empty survive the graph release as standalone
    // wireframe batches; inspection survives it through the CPU pick index.
    applyWireOverlays();
  }
  function setReadyStage(): void {
    stallPhase('ready');
    hud.setStage(`ready · ${allProgress?.loaded ?? world.rooms.size} rooms`, { steady: true });
    setOverlayProgress(1);
    dismissOverlay();
  }
  // Chunked release of whatever per-room graph remains, then the shared
  // geometry/material caches: ~15ms slices so the GL deletes (IPC to
  // Firefox's GPU process) never pile into one main-thread stall. Safe to
  // call repeatedly; a single release runs at a time.
  let graphReleasePromise: Promise<void> | null = null;
  function releaseGraphPaced(): Promise<void> {
    if (graphReleasePromise) return graphReleasePromise;
    graphReleasePromise = (async () => {
      const ids = [...world.rooms.keys()];
      let sliceStart = performance.now();
      for (let index = 0; index < ids.length; index++) {
        if (destroyed || !mergedActive()) return;   // view died / merged unticked
        world.releaseRoomGraph(ids[index]);
        if (performance.now() - sliceStart > 15) {
          hud.setStage(`releasing room graph ${index + 1}/${ids.length}`);
          setOverlayProgress(0.92 + 0.06 * ((index + 1) / ids.length));
          await yieldToBrowser();
          sliceStart = performance.now();
        }
      }
      if (destroyed || !mergedActive()) return;
      await world.releaseGraphCaches({
        shouldStop: () => destroyed || !mergedActive(),
        onProgress: ({ done, total }: { done: number; total: number }) => {
          if (destroyed) return;
          hud.setStage(`releasing cached assets ${done}/${total}`);
          setOverlayProgress(0.98 + 0.02 * (done / Math.max(1, total)));
        },
      });
      if (!destroyed && ready) setReadyStage();
    })().finally(() => { graphReleasePromise = null; });
    return graphReleasePromise;
  }
  async function buildMerged(): Promise<void> {
    if (!merged || !state.merged || merged.ready || merged.building) {
      applyRenderMode();
      return;
    }
    try {
      // Swap the display to the (initially empty) merged root up front: baked
      // cells attach (and upload) incrementally across frames instead of in
      // one end-of-bake stall, and the per-room graph's draw cost stops
      // starving the bake immediately. applyRenderMode() below settles the
      // final state (including the failure path, which re-attaches the graph).
      merged.refreshZMask((z: number) => world.isZVisible(z));
      applyCategories();
      applyCull();
      applyWater();
      merged.setVisible(true);
      world.root.removeFromParent();
      const stats = await merged.build({
        // Free each room's graph the moment its data is harvested: the
        // release cost spreads across the bake and peak memory never holds
        // the full graph alongside the growing merged output. The 'unloaded'
        // event this fires drops the room's water curtain/sheet bookkeeping
        // (curtain geometry is already baked into the merged water buckets).
        onRoomHarvested: (roomId: number) => {
          if (destroyed || !state.merged) return;   // unticked mid-bake: keep the graph
          world.releaseRoomGraph(roomId);
        },
        onProgress: (progress: any) => {
          if (destroyed) return;
          switch (progress.phase) {
            case 'textures':
              hud.setStage(`decoding textures ${progress.textures}/${progress.totalTextures}`);
              setOverlayProgress(0.50 + 0.08 * (progress.textures / Math.max(1, progress.totalTextures)));
              return;
            case 'harvest':
              hud.setStage(`merging rooms ${progress.rooms}/${progress.totalRooms}`);
              setOverlayProgress(0.58 + 0.14 * (progress.rooms / Math.max(1, progress.totalRooms)));
              return;
            case 'water':
              stallPhase('finalize');
              hud.setStage(`water sheets ${progress.sheets}/${progress.totalSheets}`);
              setOverlayProgress(0.88 + 0.02 * (progress.sheets / Math.max(1, progress.totalSheets)));
              return;
            case 'upload':
              stallPhase('finalize');
              hud.setStage('uploading merged batches…');
              setOverlayProgress(0.90);
              return;
            default:
              hud.setStage(`merging batch ${progress.meshes}/${progress.totalMeshes}`);
              setOverlayProgress(0.72 + 0.16 * (progress.vertices / Math.max(1, progress.totalVertices)));
              setStatus(
                `optimising world · ${Math.round(100 * progress.vertices / Math.max(1, progress.totalVertices))}%`
                + ` · ${progress.meshes}/${progress.totalMeshes} batches`);
          }
        },
      });
      if (stats && !destroyed) {
        merged.refreshZMask((z: number) => world.isZVisible(z));   // bake set _zBias
        applyWater();                                      // sheets exist only now
        if (mergedActive()) {
          stallPhase('finalize');
          await releaseGraphPaced();   // rooms kept back + the shared caches
        }
      }
    } catch (error) {
      if (destroyed) return;
      // fallback = the per-room graph: rooms streamed hidden for the bake
      // must reveal (paced), and future streams must reveal normally
      bakeFailed = true;
      queueHiddenRooms();
      setStatus(`merged rendering failed: ${error.message || error}`, true);
      hud.setStage('merged rendering failed', { bad: true });
      dismissOverlay();   // show the per-room fallback instead of a stuck bar
      console.error(error);
    }
    if (destroyed) return;
    applyRenderMode();
    // Failure or a mid-bake untick can leave already-released rooms missing
    // from the graph path: stream them back in.
    if (!mergedActive()) reloadGraphIfReleased();
    syncStatus();
  }
  // Merged rendering frees the per-room graph; showing the graph path again
  // has to stream the missing rooms back in from IndexedDB first.
  let graphReloading = false;
  async function reloadGraphIfReleased(): Promise<void> {
    if (destroyed || !allMode || graphReloading) return;
    if (graphReleasePromise) await graphReleasePromise;   // settle an in-flight release
    if (destroyed || mergedActive() || merged?.building || graphReloading) return;
    const missing = (world.index?.rooms || [])
      .map((room: any) => Number(room.id))
      .filter((id: number) => !world.rooms.has(id));
    if (!missing.length) return;
    graphReloading = true;
    try {
      hud.setStage(`reloading rooms 0/${missing.length}`);
      await loadRoomsWithRetry(world, missing, {
        concurrency: 6,
        retries: 1,
        retryConcurrency: 1,
        onProgress: (progress: any) => {
          if (destroyed) return;
          hud.setStage(`reloading rooms ${progress.loaded}/${progress.total}`);
        },
      });
      if (destroyed) return;
      applyCategories();
      applyToggles();
      applyRenderMode();
      hud.setStage(`ready · ${world.rooms.size} rooms`);
      syncStatus();
    } finally {
      graphReloading = false;
    }
  }
  if (allMode) {
    perfSection = section('Drawing',
      Object.assign(range('rscale', 'Render scale', 0, RENDER_SCALES.length - 1, 1, scaleLabel, applyRenderScale),
        { title: "How many of your screen's pixels the world is drawn at: 100% is as sharp as your screen; less is faster" }),
      // escape hatch: merged is the invisible default; the raw per-room
      // graph remains reachable here for debugging/inspection workflows.
      // Session edits are undone first: the other path's display data
      // (a fresh graph reload / a fresh bake) would not carry them.
      check('merged', 'Merged rendering', () => {
        resetAllEdits();
        // unticked mid-load: rooms streamed hidden for the bake must reveal
        if (!state.merged) queueHiddenRooms();
        buildMerged();
        applyRenderMode();
        reloadGraphIfReleased();
      },
        { swatch: '#7fb069', title: 'Bake all rooms into a few large static batches (much faster). Untick for the raw per-room graph.' }));
  }

  // Debug accordion: the views of the data rather than of the room, collapsed by default, its open state
  // persisted. Showing the room and its game shading stay top-level.
  const advanced = el('details', { class: 'wp-advanced' },
    el('summary', { text: 'Debug' }));
  advanced.open = getPref('worldadv') === true;
  advanced.addEventListener('toggle', () => setPref('worldadv', advanced.open));
  append(advanced, section('Data', ...debugChecks, flattenCheck), perfSection, zSection);

  append(panel, inspectBtn, resetEditsBtn, readout, statusEl, visSection, lightSection, advanced);

  // --- pref sync (state lives ONLY in prefs/localStorage, no URL mirroring) ---
  function syncState(): void {
    persistState(state);
  }

  // --- inspector -----------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  raycaster.layers.enableAll();   // spawns the game's frame draws sit on their own layer
  const confirmRaycaster = new THREE.Raycaster();   // stable across async picks
  const pointerNdc = new THREE.Vector2();
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd84d, wireframe: true, transparent: true, opacity: 0.9,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  let highlight: any = null;
  let inspectedKey = '';
  // Model identity of the CURRENT hover highlight. Hovering a different PART of
  // the same multi-mesh model must not tear down and async-rebuild its group
  // outline every pointer-move (parts would blink in and out as the cursor
  // crosses an NPC). While this stays equal, the whole-model highlight is left
  // untouched.
  let hoverModelKey: string | null = null;
  let inspectPinned = false;
  let inspectFrame = 0;
  let inspectPoint: [number, number] | null = null;
  let pointerDown: [number, number] | null = null;
  // Pinned selection context (null unless pinned):
  //   {mode:'graph', object, instanceId, info}                (instanced path)
  //   {mode:'index', entryIndex, ref, info, geometry, shard}  (merged path)
  let pinnedCtx: any = null;
  let pickToken = 0;       // stales in-flight async merged picks
  let groupHighlights: any[] = [];   // whole-model selection: sibling part outlines

  // --- whole-model selection -------------------------------------------------
  // A multi-mesh prop/NPC placed as `models` shares one occurrence across its
  // part placements. Pinning any part selects the whole occurrence group: all
  // parts highlight, edits move/delete them together, and the readout links
  // the recovered System Model.
  function modelGroupIndices(info: any, shard: any): number[] | null {
    if (!shard || info.sourceKind === 'spawn' || info.category !== 'models'
        || !(Number(info.occurrenceIndex) >= 0)) return null;
    const pc = world.placementColumns;
    const rows = shard.placements?.models || [];
    const members = [];
    for (let i = 0; i < rows.length; i++) {
      if (Number(rows[i][pc.occurrence!]) === Number(info.occurrenceIndex)) members.push(i);
    }
    // Even a lone placement is returned: attachModelGroup keeps a single-part
    // group only if it resolves to a catalog model (for variants), otherwise
    // discards it back to a plain part.
    return members.length ? members : null;
  }

  function graphMemberBinding(roomId: any, placementIndex: any, wantSpawn = false): { object: any; instanceId: number } | null {
    const room = world.rooms.get(Number(roomId));
    for (const mesh of room?.meshes || []) {
      const exact = mesh.userData.exact;
      if (!exact) continue;
      const isSpawn = exact.sourceKind === 'spawn';
      if (wantSpawn ? !isSpawn : (exact.category !== 'models' || isSpawn)) continue;
      const instanceId = (exact.placementIndices || []).indexOf(Number(placementIndex));
      if (instanceId >= 0) return { object: mesh, instanceId };
    }
    return null;
  }

  function primaryMemberFrom(ctx: any): any {
    if (!ctx) return null;
    return ctx.mode === 'graph'
      ? {
        mode: 'graph', info: ctx.info, object: ctx.object,
        instanceId: ctx.instanceId, geometry: ctx.object.geometry,
        shard: world.rooms.get(Number(ctx.info.room))?.shard || null,
      }
      : {
        mode: 'index', info: ctx.info, entryIndex: ctx.entryIndex,
        geometry: ctx.geometry, shard: ctx.shard,
      };
  }
  function primaryMember(): any { return primaryMemberFrom(pinnedCtx); }

  // Stable identity of the MODEL a placement belongs to (all parts share it),
  // so re-pinning within the same model doesn't tear down its overlays.
  function modelKeyOf(info: any): string | null {
    if (!info) return null;
    if (info.sourceKind === 'spawn') return `spawn|${Number(info.room)}|${Number(info.spawnIndex)}`;
    if (info.category === 'models' && Number(info.occurrenceIndex) >= 0) {
      return `models|${Number(info.room)}|${Number(info.occurrenceIndex)}`;
    }
    return `${info.category}|${Number(info.room)}|${Number(info.placementIndex)}`;
  }

  // Outline the whole physical model on HOVER (not just the hovered mesh).
  // Builds the occurrence/spawn part group off the hover context and highlights
  // its siblings; the single hover highlight already covers the primary.
  async function showHoverGroup(ctx: any, key: string): Promise<void> {
    if (inspectPinned) return;
    const primary = primaryMemberFrom(ctx);
    if (!primary?.shard) return;
    const info = primary.info;
    let group = null;
    try {
      group = info.sourceKind === 'spawn'
        ? await buildSpawnGroup(primary, pickToken)
        : await buildModelsGroup(primary, pickToken);
    } catch { group = null; }
    if (!group || group.members.length < 2 || destroyed || inspectPinned || inspectedKey !== key) return;
    showGroupHighlights(group);
  }

  function pinnedMembers(): any[] {
    if (pinnedCtx?.group) return pinnedCtx.group.members;
    const primary = primaryMember();
    return primary ? [primary] : [];
  }

  function memberWorldMatrix(member: any, target: THREE.Matrix4, sourceGeometry = false): THREE.Matrix4 {
    if (member.mode === 'graph') {
      member.object.getMatrixAt(member.instanceId, target);
      for (let node = member.object; node && node !== world.root; node = node.parent) {
        target.premultiply(node.matrix);
      }
    } else {
      pickIndex.matrix(member.entryIndex, target);
    }
    if (sourceGeometry) {
      const reflected = member.mode === 'graph'
        ? !!member.object.userData.exact?.reflectLocalX
        : !!pickIndex.ref(member.entryIndex).reflect;
      unbakeGeometryReflection(target, reflected);
    }
    return target;
  }

  function clearGroupHighlights(): void {
    for (const mesh of groupHighlights) mesh.removeFromParent();
    groupHighlights = [];
  }

  // Hide the static selection outlines while the animated composite plays
  // (the static geometry is hidden and the composite moves, so a fixed
  // outline would sit orphaned at the rest pose); restore them when it stops.
  function setInspectHighlightsVisible(on: boolean): void {
    if (highlight) highlight.visible = on;
    for (const mesh of groupHighlights) mesh.visible = on;
  }

  // Outline every OTHER part of the group (members[0] is the pinned primary,
  // which already carries the main highlight).
  function showGroupHighlights(group: any): void {
    clearGroupHighlights();
    for (const member of group.members.slice(1)) {
      const mesh = new THREE.Mesh(member.geometry, highlightMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1000;
      memberWorldMatrix(member, mesh.matrix);
      mesh.matrixWorldNeedsUpdate = true;
      highlightRoot.add(mesh);
      groupHighlights.push(mesh);
    }
  }

  function refreshGroupHighlights(): void {
    if (!pinnedCtx?.group) return;
    const others = pinnedCtx.group.members.slice(1);
    for (let i = 0; i < groupHighlights.length && i < others.length; i++) {
      memberWorldMatrix(others[i], groupHighlights[i].matrix);
      groupHighlights[i].matrixWorldNeedsUpdate = true;
    }
  }

  // --- apply a System Model VARIANT to the pinned model in-world ---------------
  // Variants re-texture (occasionally re-mesh) the same entity. Applying one
  // renders the model's parts as a static overlay with the variant's
  // materials at each part's world matrix, hiding the authored statics: the
  // same seam the animation composite uses, minus the rig. Applied variants
  // PERSIST for the session exactly like animations: leaving a model
  // (unpin / pin another / inspect-off) PARKS its overlay here (statics stay
  // hidden, overlay stays drawn) rather than reverting; re-pinning re-adopts
  // it. Only an explicit revert (picker → base variant, or Reset) or a refresh
  // disposes one.
  let variantOverlay: any = null;   // active: { meshes, hiddenGraph, hiddenMerged, index, modelKey, pinRef }
  const persistentVariants = new Map<string, any>();   // modelKey -> parked overlay

  function modelVariantList(model: any): any[] {
    const variants = Array.isArray(model?.variants) ? model.variants : [];
    return variants.length > 1 ? variants : [];
  }

  function variantLabel(variant: any, index: number): string {
    const names = [variant?.name, ...(Array.isArray(variant?.aliases) ? variant.aliases : [])]
      .filter((n) => typeof n === 'string' && n);
    return names.join(' / ') || `Variant ${index + 1}`;
  }

  function buildVariantPicker(): HTMLElement | null {
    const group = pinnedCtx?.group;
    const variants = modelVariantList(group?.model);
    if (!variants.length) return null;
    const box = el('div', { class: 'wp-variant' });
    box.appendChild(el('div', { class: 'wp-variant-title', text: 'Variant' }));
    const select = el('select', { class: 'wp-variant-select', title: 'Apply a catalog variant to this placement' });
    variants.forEach((variant, index) => {
      select.appendChild(el('option', { value: String(index), text: variantLabel(variant, index) }));
    });
    select.value = String(variantOverlay?.index ?? 0);
    select.addEventListener('change', () => {
      applyVariant(Number(select.value)).catch(() => { /* best-effort */ });
    });
    box.appendChild(select);
    return box;
  }

  // Hard revert of ONE overlay (active or parked): drop its meshes and restore
  // the authored statics it hid (graph: un-zero the instance; merged: drop the
  // hidden-set keys and re-bake). Does not touch variantOverlay/persistentVariants
  // bookkeeping: the caller owns that.
  function disposeVariantOverlay(ov: any): void {
    if (!ov) return;
    for (const mesh of ov.meshes) mesh.removeFromParent();
    const touched = new Set<any>();
    for (const { mesh, instanceId, original } of ov.hiddenGraph || []) {
      if (!mesh.parent) continue;
      mesh.setMatrixAt(instanceId, original);
      touched.add(mesh);
    }
    for (const mesh of touched) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
    }
    const rebakeKeys = ov.hiddenMerged;
    if (rebakeKeys?.length) {
      for (const [set, key] of rebakeKeys) set.delete(key);
      for (const bucketKey of new Set(rebakeKeys.map((r: any[]) => r[2]).filter(Boolean))) {
        queueMergedRebake(bucketKey, { immediate: true });
      }
      flushRebakeNow();   // restore the authored statics NOW, not debounced
    }
  }

  // Explicit revert of the ACTIVE variant (picker → base, Reset, view teardown).
  function clearVariantOverlay(): void {
    if (!variantOverlay) return;
    disposeVariantOverlay(variantOverlay);
    variantOverlay = null;
    syncEditsUi();
  }

  // Leave the pinned model without reverting: keep the overlay drawn + statics
  // hidden, filed by model key so re-pinning re-adopts it. Mirrors parkSpawnAnim.
  function parkVariantOverlay(): void {
    if (!variantOverlay) return;
    if (variantOverlay.modelKey) persistentVariants.set(variantOverlay.modelKey, variantOverlay);
    else disposeVariantOverlay(variantOverlay);   // unkeyed: can't re-find it, drop it
    variantOverlay = null;
    syncEditsUi();
  }

  // At every pin: park the outgoing model's variant (if still active) and adopt
  // the newly-pinned model's parked variant so its picker reflects the applied
  // index and it stays interactive.
  function syncVariantOverlay(): void {
    if (!pinnedCtx) return;
    const key = modelKeyOf(pinnedCtx.info);
    if (variantOverlay && variantOverlay.modelKey !== key) parkVariantOverlay();
    if (key && !variantOverlay && persistentVariants.has(key)) {
      variantOverlay = persistentVariants.get(key);
      persistentVariants.delete(key);
      syncEditsUi();
    }
  }

  // Every live overlay (active + parked), used to keep them all pickable so the
  // hidden statics they stand in for never swallow a click into the floor.
  function allVariantOverlays(): any[] {
    return [variantOverlay, ...persistentVariants.values()].filter((o) => o?.meshes.length);
  }

  // Revert every variant (active + parked) and forget them. Reset/refresh path.
  function clearAllVariantOverlays(): void {
    clearVariantOverlay();
    for (const ov of persistentVariants.values()) disposeVariantOverlay(ov);
    persistentVariants.clear();
    syncEditsUi();
  }

  // Hide the group's authored statics (graph: zero-scale; merged: hidden set +
  // bucket re-bake) and return the bookkeeping needed to restore them.
  async function hideGroupStatics(members: any[]): Promise<{ hiddenGraph: any[]; hiddenMerged: [Set<string>, string, string | null][] }> {
    const hiddenGraph: any[] = [];
    const hiddenMerged: [Set<string>, string, string | null][] = [];
    if (mergedActive()) {
      const cell = merged?.cellOfRoom(members[0]?.info.room);
      for (const member of members) {
        const isSpawn = member.info.sourceKind === 'spawn';
        const set = isSpawn ? hiddenSpawnParts : hiddenOccurrenceParts;
        const key = `${Number(member.info.room)}|${member.info.category}|${Number(member.info.placementIndex)}`;
        set.add(key);
        let bucketKey = null;
        if (cell) {
          try {
            const geometry = await world._meshGeometry(member.info.mesh, false);
            const classified = merged.classifyBucket({
              category: member.info.category, renderTexture: member.info.renderTexture,
              flags: member.info.flags, recolors: member.info.recolors, z: member.info.z,
              depthRank: member.info.depthRank,
            }, geometry);
            bucketKey = merged.bucketKeyFor(cell.cellX, cell.cellY, classified);
          } catch { /* fall back to no targeted re-bake */ }
        }
        hiddenMerged.push([set, key, bucketKey]);
      }
      for (const bucketKey of new Set(hiddenMerged.map((r) => r[2]).filter(Boolean))) {
        queueMergedRebake(bucketKey, { immediate: true });
      }
    } else {
      for (const member of members) {
        if (member.mode !== 'graph' || !member.object?.parent) continue;
        const original = new THREE.Matrix4();
        member.object.getMatrixAt(member.instanceId, original);
        hiddenGraph.push({ mesh: member.object, instanceId: member.instanceId, original });
        member.object.setMatrixAt(member.instanceId, zeroMatrix);
        member.object.instanceMatrix.needsUpdate = true;
        member.object.computeBoundingBox();
        member.object.computeBoundingSphere();
      }
    }
    return { hiddenGraph, hiddenMerged };
  }

  async function applyVariant(index: number): Promise<void> {
    const group = pinnedCtx?.group;
    const variants = modelVariantList(group?.model);
    if (!variants.length) return;
    const guardKey = inspectedKey;
    // variants and animation both override the statics: one at a time
    if (spawnAnim?.active) { if (spawnAnim.bar) spawnAnim.bar.select.value = '-1'; deactivateSpawnComposite(); }
    clearVariantOverlay();
    if (index <= 0) return;   // variant 0 is the authored appearance (statics)
    const variant = variants[index];
    const vparts = Array.isArray(variant?.parts) ? variant.parts : [];
    const members = group.members;
    const primary = members[0];
    const shard = primary?.shard || await cachedShard(primary?.info?.room);
    if (!shard || destroyed || inspectedKey !== guardKey) return;
    // Variants own their part list and local matrices. Original part counts
    // and offsets need not match (for example, additional clothing pieces).
    const base = replacementBaseMatrix(primary, shard);
    if (!base) return;
    const built = [];
    for (const vpart of vparts) {
      let geometry = null;
      try { geometry = await world._meshGeometry(Number(vpart.mesh), false); } catch { continue; }
      if (destroyed || inspectedKey !== guardKey) return;
      let material = null;
      try {
        material = await world._material('models', vpart.material ?? primary.info.material,
          Number(vpart.image ?? primary.info.renderTexture), primary.info.flags | 0, vpart.recolors || null);
      } catch { material = null; }
      if (destroyed || inspectedKey !== guardKey) return;
      const mesh = new THREE.Mesh(geometry, material || highlightMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(base);
      const local = vpart.local_matrix;
      if (Array.isArray(local) && local.length === 12 && local.every(Number.isFinite)) {
        mesh.matrix.multiply(new THREE.Matrix4().set(
          local[0], local[1], local[2], local[3],
          local[4], local[5], local[6], local[7],
          local[8], local[9], local[10], local[11], 0, 0, 0, 1,
        ));
      }
      mesh.matrixWorldNeedsUpdate = true;
      built.push(mesh);
    }
    if (destroyed || inspectedKey !== guardKey || !built.length) { return; }
    const hidden = await hideGroupStatics(members);
    if (destroyed || inspectedKey !== guardKey) return;
    for (const mesh of built) highlightRoot.add(mesh);
    const info = pinnedCtx.info;
    variantOverlay = {
      meshes: built, ...hidden, index,
      modelKey: modelKeyOf(info),
      // enough to re-pin the model straight from a click on the parked overlay
      pinRef: {
        room: Number(info.room), sourceKind: info.sourceKind,
        category: info.category, placementIndex: Number(info.placementIndex),
      },
    };
    syncEditsUi();
  }

  // Resolve the group's mesh set against the read-only System Models catalog
  // (smallest model containing every part mesh wins: entity variants share
  // their base meshes). Built once per view; user models key by hash, not
  // ordinal, and stay out of this lookup.
  let systemModelsByMesh: Map<number, any[]> | null = null;
  async function modelForMeshes(meshIds: any[]): Promise<any> {
    if (!systemModelsByMesh) {
      systemModelsByMesh = new Map();
      let models = [];
      try { models = await app.loadSystemModels(); } catch { models = []; }
      for (const model of models || []) {
        for (const part of model.parts || []) {
          const key = Number(part.mesh);
          if (!systemModelsByMesh.has(key)) systemModelsByMesh.set(key, []);
          systemModelsByMesh.get(key)!.push(model);
        }
      }
    }
    const wanted = [...new Set(meshIds.map(Number))];
    let best = null;
    for (const model of systemModelsByMesh.get(wanted[0]) || []) {
      const meshes = new Set((model.parts || []).map((part: any) => Number(part.mesh)));
      if (!wanted.every((mesh) => meshes.has(mesh))) continue;
      if (!best || meshes.size < best.meshes) best = { model, meshes: meshes.size };
    }
    return best?.model || null;
  }

  // Build the full member list at pin time (geometries resolved up front so
  // group nudges stay synchronous). Async: attaches to pinnedCtx when done.
  // A pinned spawn's part rows -> group members (all parts of the entity).
  // Unlike a models occurrence group, a spawn is always ONE model even with a
  // single part, so the group attaches unconditionally.
  async function buildSpawnGroup(primary: any, token: number): Promise<any> {
    const info = primary.info;
    const members = [];
    for (const part of info.parts || []) {
      const rowIndex = Number(part.rowIndex);
      const pInfo = rowIndex === Number(info.placementIndex) ? info
        : world.describeShardPlacement(info.room, primary.shard, 'spawn', 'spawns', rowIndex);
      if (!pInfo) continue;
      if (rowIndex === Number(info.placementIndex)) { members.unshift(primary); continue; }
      if (primary.mode === 'graph') {
        const binding = graphMemberBinding(info.room, rowIndex, true);
        if (!binding) continue;
        members.push({
          mode: 'graph', info: pInfo, object: binding.object,
          instanceId: binding.instanceId, geometry: binding.object.geometry, shard: primary.shard,
        });
      } else {
        const entryIndex = pickIndex.find({ room: info.room, sourceKind: 'spawn', category: 'spawns', placementIndex: rowIndex });
        if (entryIndex < 0) continue;
        let geometry = null;
        try { geometry = await world._meshGeometry(pInfo.mesh, pickIndex.ref(entryIndex).reflect); } catch { continue; }
        if (destroyed || token !== pickToken) return null;
        members.push({ mode: 'index', info: pInfo, entryIndex, geometry, shard: primary.shard });
      }
    }
    return members.length ? { kind: 'spawn', members, model: null, label: info.label, spawnIndex: info.spawnIndex } : null;
  }

  async function buildModelsGroup(primary: any, token: number): Promise<any> {
    const info = primary.info;
    const indices = modelGroupIndices(info, primary.shard);
    if (!indices) return null;
    const members = [primary];
    for (const placementIndex of indices) {
      if (placementIndex === Number(info.placementIndex)) continue;
      const mInfo = world.describeShardPlacement(info.room, primary.shard, 'occurrence', 'models', placementIndex);
      if (!mInfo) continue;
      if (primary.mode === 'graph') {
        const binding = graphMemberBinding(info.room, placementIndex);
        if (!binding) continue;
        members.push({
          mode: 'graph', info: mInfo, object: binding.object,
          instanceId: binding.instanceId, geometry: binding.object.geometry, shard: primary.shard,
        });
      } else {
        const entryIndex = pickIndex.find({ room: info.room, sourceKind: 'occurrence', category: 'models', placementIndex });
        if (entryIndex < 0) continue;
        let geometry = null;
        try { geometry = await world._meshGeometry(mInfo.mesh, pickIndex.ref(entryIndex).reflect); } catch { continue; }
        if (destroyed || token !== pickToken) return null;
        members.push({ mode: 'index', info: mInfo, entryIndex, geometry, shard: primary.shard });
      }
    }
    return members.length ? { kind: 'models', occurrenceIndex: Number(info.occurrenceIndex), members, model: null } : null;
  }

  // Whole-model selection: build the group for a spawn (every part) or a
  // models occurrence, resolve its System Model, highlight all parts, preview
  // the whole model, and mount the animation picker if rigged. A LONE models
  // placement only becomes a "model" when it resolves to a catalog model
  // (otherwise it stays a plain part: most ambient props aren't models);
  // spawns and multi-part occurrences always group.
  async function attachModelGroup(token: number): Promise<void> {
    const primary = primaryMember();
    if (!primary?.shard) return;
    const info = primary.info;
    const group = info.sourceKind === 'spawn'
      ? await buildSpawnGroup(primary, token)
      : await buildModelsGroup(primary, token);
    if (!group || destroyed || token !== pickToken || !pinnedCtx || pinnedCtx.info !== info) return;
    const model = await modelForMeshes(group.members.map((member: any) => member.info.mesh)).catch(() => null);
    if (destroyed || token !== pickToken || !pinnedCtx || pinnedCtx.info !== info) return;
    if (group.kind === 'models' && group.members.length < 2 && !model) return;   // lone non-model part
    group.model = model;
    group.__resolved = true;
    pinnedCtx.group = group;
    syncVariantOverlay();   // re-adopt a variant this model had parked (picker reflects it)
    showGroupHighlights(group);
    if (group.members.length > 1) showPreviewModel(group.members, inspectedKey).catch(() => {});
    showReadout(info, true);
    syncSpawnAnim();   // rigged spawns / model groups get the animation picker
  }

  // --- in-world skinned playback for a pinned spawn ---------------------------
  // spawnAnim (null unless a rigged spawn is pinned):
  //   { token, key, info, box, rig, composite, bar, resolved, shard,
  //     active, partsLoaded, _hiddenGraph, _hiddenMerged }
  let spawnAnim: any = null;
  let spawnAnimToken = 0;
  // Merged-mode transient hide: "room|category|placementIndex" of spawn parts whose
  // baked static must be skipped by the cell re-bake while the composite plays.
  const hiddenSpawnParts = new Set<string>();
  // Same, for an occurrence group whose composite is playing. Category is
  // part of the key because each category has its own placement indexes.
  const hiddenOccurrenceParts = new Set<string>();

  // --- session edits (move/delete/reset, never persisted) -------------------
  const edits = new WorldEdits();
  let editStep = 0.5;      // tiles for X/Y, height layers for Z
  const editScratch = new THREE.Matrix4();
  const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  // --- pinned effect instance (mirrors pinnedCtx/inspectPinned above, but
  // for a particle-effect InstanceRec rather than a placement): the two pins
  // are mutually exclusive (pinning one clears the other) and share the same
  // `readout` element, so at most one of showReadout/showEffectReadout is
  // ever the current content. All the knob/edit state itself lives on
  // effectsLayer, keyed by effectInstanceKey(); this holds only WHICH
  // instance is currently shown. -----------------------------------------
  let effectPinned: { key: string } | null = null;
  let fxHoverKey: string | null = null;   // proxy currently swapped to the highlight material
  let fxEditStep = 0.5;                   // tiles for X/Y, height layers for Z (mirrors editStep)

  function pickInstance(clientX: number, clientY: number): any {
    if (!world.rooms.size || mergedActive()) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    scene3d.camera.updateMatrixWorld();
    raycaster.setFromCamera(pointerNdc, scene3d.camera);
    const candidates = [];
    for (const room of world.rooms.values()) {
      if (!room.group.visible) continue;
      for (const mesh of room.meshes) {
        if (mesh.visible && mesh.parent?.visible) candidates.push(mesh);
      }
    }
    return raycaster.intersectObjects(candidates, false).find(
      (hit) => Number.isInteger(hit.instanceId),
    ) || null;
  }

  const identifier = (value: any, prefix = '#'): string => (
    Number.isFinite(Number(value)) && Number(value) >= 0 ? `${prefix}${Number(value)}` : 'none');
  // All-rooms only: readout links open a new tab. Navigating in place would
  // tear down the merged world scene the user waited to load. Room views keep
  // normal same-tab navigation.
  const readoutLink = (href: string, text: string) =>
    el('a', allMode ? { href, text, target: '_blank', rel: 'noopener' } : { href, text });
  const compact = (value: any): string => (Number.isFinite(Number(value)) ? String(Number(Number(value).toFixed(3))) : '?');

  const MESH_LINKS_CAP = 8;   // "Parts" row: individual mesh links shown before collapsing to "+N more"
  // A group with no resolved catalog Model still has per-mesh identity: link
  // each member mesh (deduped, capped) via the same #/mesh/<n> idiom as the
  // Mesh row above, so there is always something to click through to.
  function meshLinksCell(members: any[]): HTMLElement {
    const meshIds = [...new Set(
      members.map((member) => Number(member.info.mesh)).filter((id) => Number.isFinite(id) && id >= 0),
    )];
    const cell = el('span', {});
    meshIds.slice(0, MESH_LINKS_CAP).forEach((meshId, i) => {
      if (i > 0) append(cell, ', ');
      append(cell, readoutLink(`#/mesh/${meshId}`, identifier(meshId)));
    });
    if (meshIds.length > MESH_LINKS_CAP) append(cell, ` +${meshIds.length - MESH_LINKS_CAP} more`);
    return cell;
  }

  // --- inspector tie-in: pinned occurrence -> attached particle systems -----
  // Reuses the effectsDoc the room view's own ambient effects layer already
  // fetches lazily (ensureEffectsDoc/applyEffects above): no second fetch
  // here, so a doc that has not resolved yet simply means no row, same as an
  // occurrence with no attached effects. Matches primarily by (room,
  // occurrence) -- exactly what attachments.rooms records to join back to
  // this same inspector's Occurrence row -- falling back to a resource-only
  // match if the occurrence index isn't present.
  function attachedEffectSystems(info: any): { system: number; controller: number | null }[] {
    const roomAttachments = effectsDoc?.attachments?.rooms;
    if (!Array.isArray(roomAttachments)) return [];
    const room = Number(info.room);
    const occurrence = Number(info.occurrenceIndex);
    let matches = roomAttachments.filter((att: any) => Number(att.room) === room && Number(att.occurrence) === occurrence);
    if (!matches.length) {
      const resource = Number(info.resource);
      if (Number.isFinite(resource)) {
        matches = roomAttachments.filter((att: any) => Number(att.room) === room && Number(att.resource) === resource);
      }
    }
    const bySystem = new Map<number, number | null>();
    for (const att of matches) {
      const system = Number(att.system);
      if (!bySystem.has(system)) bySystem.set(system, att.controller == null ? null : Number(att.controller));
    }
    return [...bySystem.entries()].map(([system, controller]) => ({ system, controller }));
  }

  // "Effects: <name>" (or "Effects: N systems"): the effect systems attached to a placement.
  function effectsReadoutRow(info: any): HTMLElement | null {
    const attached = attachedEffectSystems(info);
    if (!attached.length) return null;
    const first = attached[0];
    const sys = effectsDoc?.systems?.find((s: any) => Number(s.slot) === first.system);
    const name = sys?.names?.[0]?.name || `system #${first.system}`;
    const text = attached.length === 1 ? name : `${attached.length} systems`;
    return el('span', { text });
  }

  function readoutRows(info: any, pinned: boolean): [string, any][] {
    const isSpawn = info.sourceKind === 'spawn';
    const group = pinned && pinnedCtx?.info === info ? pinnedCtx.group : null;
    const roomCell = `${identifier(info.room)}${world.roomMeta(info.room)?.name ? ` · ${world.roomMeta(info.room).name}` : ''}`;
    const tileCell = `${info.position.join(', ')} · ${Number(info.rotationQuarters || 0) * 90}°`;
    const rows: [string, any][] = [['Room', roomCell]];
    const spawnHeightRows: [string, string][] = isSpawn ? [
      ['Centre offset', compact(info.centreOffset)],
      ['Height source', info.heightSource === 'room_tiles' ? 'Authored room tiles' : 'Estimated terrain surface'],
    ] : [];

    // A pinned model (spawn entity or multi-part occurrence group) reads at the
    // MODEL level: the per-mesh mesh/material/texture/recolor fields belong to
    // one part and only mislead here, so they are replaced by the model name +
    // link (#/model/…). Single non-model placements keep the full detail.
    if (group) {
      const label = group.kind === 'spawn' ? (group.label || 'unlabelled entity') : null;
      let modelCell;
      if (group.model) {
        const name = group.model.name || group.model.id;
        modelCell = el('span', {},
          readoutLink(`#/model/${group.model.id}`, name),
          label && label !== name ? ` · ${label}` : '');
      } else if (group.model === null && group.__resolved) {
        modelCell = label || 'not a catalog model';
      } else {
        modelCell = label || 'resolving…';
      }
      rows.push(['Model', modelCell]);
      const partsCountText = `${group.members.length} mesh${group.members.length === 1 ? '' : 'es'} (moved & animated together)`;
      // No single catalog Model to click through to: link each mesh that
      // makes up the group instead of leaving the count unlinked.
      rows.push(['Parts', group.model === null && group.__resolved
        ? el('span', {}, `${partsCountText}: `, meshLinksCell(group.members))
        : partsCountText]);
      if (isSpawn) rows.push(['Spawn', `${identifier(info.record)} · row ${identifier(info.spawnIndex)}`]);
      if (isSpawn && SPAWN_ORIGIN_NOTES[info.origin]) rows.push(['Position', SPAWN_ORIGIN_NOTES[info.origin]]);
      if (isSpawn && info.authoredLabel && info.authoredLabel !== info.label) rows.push(['Source label', info.authoredLabel]);
      rows.push(...spawnHeightRows);
      rows.push(['Tile', tileCell]);
    } else {
      const texture = identifier(info.texture);
      const renderTexture = identifier(info.renderTexture);
      const textureCell = Number(info.renderTexture) >= 0
        ? el('span', {},
          readoutLink(`#/image/${info.renderTexture}`, renderTexture),
          texture !== renderTexture ? ` (source ${texture})` : '')
        : `${texture} source · no render image`;
      const recolor = Array.isArray(info.recolors)
        ? `${identifier(info.recolorIndex)} · ${info.recolors.map((c: number[]) => `[${c.slice(0, 3).map((v) => Number(v).toFixed(3)).join(', ')}]`).join(' / ')}`
        : 'none';
      const anchor = info.placementAnchor?.center
        ? `${info.placementAnchor.source} · ${info.placementAnchor.center.map(compact).join(', ')}`
        : 'cell center';
      const local = Array.isArray(info.localMatrix) && info.matrixIndex >= 0
        ? `${identifier(info.matrixIndex)} · translate ${[info.localMatrix[3], info.localMatrix[7], info.localMatrix[11]].map(compact).join(', ')}`
        : 'none';
      rows.push(
        ['Mesh', readoutLink(`#/mesh/${info.mesh}`, identifier(info.mesh))],
        ['Material', identifier(info.material)],
        ['Texture', textureCell],
        ['Recolor', recolor],
        ['Placement', `${isSpawn ? 'spawn part' : info.category} #${info.placementIndex}`],
      );
      if (isSpawn) {
        rows.push(
          ['Label', info.label || 'unlabelled'],
          ['Spawn', `${identifier(info.record)} · row ${identifier(info.spawnIndex)}`],
          ...spawnHeightRows,
          ...(info.authoredLabel && info.authoredLabel !== info.label ? [['Source label', info.authoredLabel] as [string, string]] : []),
          ...(SPAWN_ORIGIN_NOTES[info.origin] ? [['Position', SPAWN_ORIGIN_NOTES[info.origin]] as [string, string]] : []),
        );
      } else {
        const source = [identifier(info.occurrenceIndex), `resource ${identifier(info.resource)}`];
        if (info.secondary !== null && info.secondary !== undefined) source.push(`secondary ${identifier(info.secondary)}`);
        rows.push(['Occurrence', source.join(' · ')]);
        const effectsRow = effectsReadoutRow(info);
        if (effectsRow) rows.push(['Effects', effectsRow]);
      }
      rows.push(['Tile', tileCell], ['Anchor', anchor]);
      if (!isSpawn) rows.push(['Local', local]);
    }
    if (pinned) {
      const edit = edits.get(info);
      if (edit && !edits.isNoop(edit)) {
        rows.push(['Delta', edit.deleted
          ? 'deleted (session only)'
          : `Δ ${compact(edit.dx)}, ${compact(edit.dy)} tiles · ${compact(edit.dz)} layers · ${edit.turns * 90}°`]);
      }
    }
    rows.push(['Inspect', pinned ? 'pinned (click again to release)' : 'hover · click to pin']);
    return rows;
  }

  function showReadout(info: any, pinned: boolean): void {
    const list = el('dl', {});
    for (const [term, value] of readoutRows(info, pinned)) {
      append(list, el('dt', { text: term }),
        typeof value === 'string' ? el('dd', { text: value }) : el('dd', {}, value));
    }
    clear(readout);
    readout.appendChild(list);
    if (pinned && pinnedCtx) {
      if (preview?.active) readout.appendChild(preview.host);
      const variantPicker = buildVariantPicker();
      if (variantPicker) readout.appendChild(variantPicker);
      if (spawnAnim?.box && spawnAnim.key === currentSpawnKey()) readout.appendChild(spawnAnim.box);
      readout.appendChild(buildEditTools());
    }
    readout.classList.toggle('pinned', pinned);
    readout.hidden = false;
  }

  // --- pinned-mesh preview (shared by both views): a tiny standalone renderer
  // in the detail area showing the picked mesh with its own material, slowly
  // spinning via the main frame tick.
  let preview: any = null;
  function ensurePreview(): any {
    if (preview) return preview;
    const host = el('div', { class: 'wp-preview', 'aria-label': 'Pinned mesh preview' });
    const previewRenderer = new THREE.WebGLRenderer({ antialias: true });
    previewRenderer.setPixelRatio(1);
    previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
    previewRenderer.setSize(224, 168, false);
    host.appendChild(previewRenderer.domElement);
    const previewScene = new THREE.Scene();
    previewScene.background = new THREE.Color(0x171a20);
    previewScene.add(new THREE.HemisphereLight(0xdbe8ff, 0x555b50, 1.8));
    const key = new THREE.DirectionalLight(0xfff1d6, 2.2);
    key.position.set(3, 5, 4);
    previewScene.add(key);
    const camera = new THREE.PerspectiveCamera(38, 4 / 3, 0.01, 100);
    preview = {
      host, renderer: previewRenderer, scene: previewScene, camera,
      spinner: null, active: false,
    };
    return preview;
  }
  function showPreviewMesh(geometry: any, material: any, sourceMatrix: THREE.Matrix4): HTMLElement {
    const p = ensurePreview();
    p.spinner?.removeFromParent();
    const spinner = new THREE.Group();
    const conversion = new THREE.Group();
    conversion.rotation.x = -Math.PI / 2;             // native Z-up -> preview Y-up
    conversion.scale.set(1, -world.roomYSign, 1);
    const mesh = new THREE.Mesh(geometry, material || highlightMaterial);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(sourceMatrix);
    mesh.matrix.elements[12] = 0;                     // keep orientation, drop position
    mesh.matrix.elements[13] = 0;
    mesh.matrix.elements[14] = 0;
    conversion.add(mesh);
    spinner.add(conversion);
    p.scene.add(spinner);
    spinner.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(conversion);
    if (!bounds.isEmpty()) {
      const center = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.001);
      conversion.position.sub(center);
      p.camera.near = Math.max(radius / 100, 0.0001);
      p.camera.far = Math.max(radius * 20, 1);
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(p.camera.fov / 2)) * 1.08;
      p.camera.position.set(distance * 0.72, distance * 0.48, distance * 0.86);
      p.camera.lookAt(0, 0, 0);
      p.camera.updateProjectionMatrix();
    }
    p.spinner = spinner;
    p.active = true;
    p.renderer.render(p.scene, p.camera);
    return p.host;
  }

  // Preview the WHOLE model: every group part at its position relative to the
  // first part, then centre + frame the assembly. Materials resolve from the
  // shared caches (async); a pin change before they land aborts.
  async function showPreviewModel(members: any[], guardKey: string): Promise<void> {
    if (!members?.length) return;
    const mats = await Promise.all(members.map((member) => world._material(
      member.info.category, member.info.material, Number(member.info.renderTexture),
      member.info.flags | 0, member.info.recolors,
    ).catch(() => null)));
    if (destroyed || inspectedKey !== guardKey) return;
    const p = ensurePreview();
    p.spinner?.removeFromParent();
    const spinner = new THREE.Group();
    const conversion = new THREE.Group();
    conversion.rotation.x = -Math.PI / 2;
    conversion.scale.set(1, -world.roomYSign, 1);
    const base = memberWorldMatrix(members[0], new THREE.Matrix4()).elements;
    const scratch = new THREE.Matrix4();
    members.forEach((member, i) => {
      memberWorldMatrix(member, scratch);
      scratch.elements[12] -= base[12];   // relative to the first part; the
      scratch.elements[13] -= base[13];   // whole assembly is recentred below
      scratch.elements[14] -= base[14];
      const mesh = new THREE.Mesh(member.geometry, mats[i] || highlightMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(scratch);
      conversion.add(mesh);
    });
    spinner.add(conversion);
    p.scene.add(spinner);
    spinner.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(conversion);
    if (!bounds.isEmpty()) {
      const center = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.001);
      conversion.position.sub(center);
      p.camera.near = Math.max(radius / 100, 0.0001);
      p.camera.far = Math.max(radius * 20, 1);
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(p.camera.fov / 2)) * 1.08;
      p.camera.position.set(distance * 0.72, distance * 0.48, distance * 0.86);
      p.camera.lookAt(0, 0, 0);
      p.camera.updateProjectionMatrix();
    }
    p.spinner = spinner;
    p.active = true;
    p.renderer.render(p.scene, p.camera);
    if (pinnedCtx) showReadout(pinnedCtx.info, true);
  }
  function hidePreview(): void {
    if (!preview) return;
    preview.spinner?.removeFromParent();
    preview.spinner = null;
    preview.active = false;
    preview.host.remove();
  }
  function destroyPreview(): void {
    if (!preview) return;
    hidePreview();
    preview.renderer.dispose();
    try { preview.renderer.forceContextLoss(); } catch { /* already lost */ }
    preview = null;
  }

  // --- pinned-spawn animation player ------------------------------------------
  // One picker per pinned spawn (keyed by room + spawn index: every part of
  // the spawn shares it). Playing a clip swaps the spawn's STATIC render for a
  // Rig-driven composite at the same world transform; clip → none / unpin /
  // destroy restores the static representation. Works on both display paths.
  function currentSpawnKey(): string | null {
    if (!inspectPinned || !pinnedCtx) return null;
    if (pinnedCtx.info?.sourceKind === 'spawn') {
      return `${Number(pinnedCtx.info.room)}|spawn|${Number(pinnedCtx.info.spawnIndex)}`;
    }
    // whole-model groups animate too (rigged multi-part NPCs placed as models)
    if (pinnedCtx.group) {
      return `${Number(pinnedCtx.info.room)}|models|occ${pinnedCtx.group.occurrenceIndex}`;
    }
    // A LONE placement animates on its own account. It never becomes a
    // "model" (that needs a catalog match, and most ambient props have none),
    // but being a model and being rigged are different things: plenty of
    // single-mesh props carry their own clips, and gating the picker on
    // model-hood hid every one of them. Offering it costs nothing when the
    // mesh has no rig, since resolveSpawnAnim answers 'norig' and the picker
    // never mounts.
    const info = pinnedCtx.info;
    if (info && info.category && Number.isInteger(Number(info.placementIndex))) {
      return `${Number(info.room)}|${info.category}|part${Number(info.placementIndex)}`;
    }
    return null;
  }

  // The player's part list: a spawn carries exact parts; a model group uses
  // its member placements (rowIndex doubles as the placement index for the
  // static hide/re-bake paths).
  function animPartsFor(): any {
    if (!pinnedCtx) return null;
    if (pinnedCtx.info?.sourceKind === 'spawn') return { parts: pinnedCtx.info.parts, category: 'spawns', members: null };
    if (pinnedCtx.group) {
      return {
        parts: pinnedCtx.group.members.map((member: any) => ({
          ...member.info, rowIndex: member.info.placementIndex,
        })),
        category: 'models',
        members: pinnedCtx.group.members,
      };
    }
    // The lone-placement case (see currentSpawnKey): its one part, in its own
    // category, so the static-hide and re-bake paths address the right row.
    // It carries a one-entry `members` list rather than null, because null is
    // what marks a SPAWN: the composite would then be positioned by the spawn
    // matrix, which has no meaning for a placed occurrence, and the animation
    // would play somewhere the camera never looks.
    const info = pinnedCtx.info;
    const member = primaryMember();
    if (member && info && info.category && Number.isInteger(Number(info.placementIndex))) {
      return {
        parts: [{ ...info, rowIndex: Number(info.placementIndex) }],
        category: info.category,
        members: [member],
      };
    }
    return null;
  }

  async function spawnShard(roomId: any): Promise<any> {
    const room = world.rooms.get(Number(roomId));
    if (room?.shard) return room.shard;
    try { return await cachedShard(roomId); } catch { return null; }
  }

  // Where the room sits in display space: the per-room graph carries it on the
  // room group; the merged bake stitches it from the world frame (as edits do).
  function spawnRoomOffset(roomId: any): [number, number] {
    const room = world.rooms.get(Number(roomId));
    if (room?.group) return [room.group.position.x, room.group.position.y];
    if (worldFrame) {
      const frame = worldFrame.frames.get(Number(roomId));
      if (frame) {
        return [(frame.x + worldFrame.ox) * world.tileUnits, (frame.y + worldFrame.oz) * world.tileUnits];
      }
    }
    return [0, 0];
  }

  // Apply any session edit, then the room's display offset.
  function placeEdited(info: any, matrix: THREE.Matrix4): THREE.Matrix4 {
    const edit = edits.get(info);
    if (edit && !edit.deleted && !edits.isNoop(edit)) {
      const pivot = pivotFor(info);
      editedMatrix(edit, matrix.clone(), pivot[0], pivot[1],
        world.tileUnits, world.layerUnits, matrix);
    }
    const offset = spawnRoomOffset(info.room);
    matrix.elements[12] += offset[0];
    matrix.elements[13] += offset[1];
    return matrix;
  }

  // The spawn's native world matrix, honouring any session edit, so the
  // composite tracks exactly where the static spawn would sit (including nudges).
  function computeSpawnBaseMatrix(info: any, shard: any): THREE.Matrix4 | null {
    const partRow = info.parts?.[0]?.row;
    if (!partRow) return null;
    const matrix = new THREE.Matrix4();
    try { world._spawnMatrix(shard, partRow, matrix); } catch { return null; }
    return placeEdited(info, matrix);
  }

  function replacementBaseMatrix(member: any, shard: any): THREE.Matrix4 | null {
    const info = member.info;
    if (info.sourceKind === 'spawn') return computeSpawnBaseMatrix(info, shard);
    const row = shard.placements?.[info.category]?.[info.placementIndex]?.slice();
    if (!row) return null;
    row[world.placementColumns.matrix] = -1;
    return placeEdited(info, world._placementMatrix(shard, row, new THREE.Matrix4()));
  }

  function updateSpawnCompositeMatrix(): void {
    if (!spawnAnim?.composite || !spawnAnim.shard) return;
    const matrix = spawnAnim.members
      ? memberWorldMatrix(spawnAnim.members[0], new THREE.Matrix4(), true)
      : computeSpawnBaseMatrix(spawnAnim.info, spawnAnim.shard);
    if (matrix) {
      spawnAnim.composite.setBaseMatrix(matrix);
      if (spawnAnim.members) {
        const inverse = matrix.clone().invert();
        spawnAnim.composite.setPartMatrices(spawnAnim.members.map((member: any) =>
          memberWorldMatrix(member, new THREE.Matrix4(), true).premultiply(inverse)));
      }
    }
  }

  // Single-room: zero-scale each of the spawn's static instances (restored 1:1).
  function hideSpawnStaticGraph(sa: any): void {
    if (sa.members) {
      const hidden = [];
      const touched = new Set<any>();
      for (const member of sa.members) {
        if (member.mode !== 'graph' || !member.object?.parent) continue;
        const original = new THREE.Matrix4();
        member.object.getMatrixAt(member.instanceId, original);
        hidden.push({ mesh: member.object, instanceId: member.instanceId, original });
        member.object.setMatrixAt(member.instanceId, zeroMatrix);
        touched.add(member.object);
      }
      for (const mesh of touched) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
      }
      sa._hiddenGraph = hidden;
      return;
    }
    const room = world.rooms.get(Number(sa.info.room));
    if (!room) return;
    const rows = new Set((sa.info.parts || []).map((p: any) => Number(p.rowIndex)));
    const hidden = [];
    const touched = new Set<any>();
    for (const mesh of room.meshes) {
      const exact = mesh.userData.exact;
      if (!exact || exact.sourceKind !== 'spawn') continue;
      const indices = exact.placementIndices || [];
      for (let instanceId = 0; instanceId < indices.length; instanceId++) {
        if (!rows.has(Number(indices[instanceId]))) continue;
        const original = new THREE.Matrix4();
        mesh.getMatrixAt(instanceId, original);
        hidden.push({ mesh, instanceId, original });
        mesh.setMatrixAt(instanceId, zeroMatrix);
        touched.add(mesh);
      }
    }
    for (const mesh of touched) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
    }
    sa._hiddenGraph = hidden;
  }

  function restoreSpawnStaticGraph(sa: any): void {
    const touched = new Set<any>();
    for (const { mesh, instanceId, original } of sa._hiddenGraph || []) {
      if (!mesh.parent) continue;
      mesh.setMatrixAt(instanceId, original);
      touched.add(mesh);
    }
    for (const mesh of touched) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
    }
    sa._hiddenGraph = null;
  }

  // Merged: mark the spawn's parts hidden and re-bake only their cell bucket(s)
  // (runMergedRebake honours hiddenSpawnParts), cheaper than a full re-bake and
  // never recorded as a session edit. Restore clears the flag and re-bakes back.
  async function queueSpawnBucketRebake(sa: any): Promise<void> {
    if (destroyed || !mergedActive() || !merged?.ready) return;
    const cell = merged.cellOfRoom(sa.info.room);
    if (!cell) return;
    const keys = new Set<string>();
    for (const part of sa.parts || []) {
      let geometry;
      try {
        geometry = await world._batchGeometry({ mesh: Number(part.mesh), sourceKind: sa.info?.sourceKind,
          idleClip: sa.info?.defaultClip ?? -1 });
      } catch { continue; }
      if (destroyed) return;
      const classified = merged.classifyBucket({
        category: sa.category,
        renderTexture: part.renderTexture,
        flags: part.flags,
        recolors: resolveShardRecolors(sa.shard, part.recolorIndex),
        depthRank: part.depthRank,
        z: part.z ?? sa.info.z,
      }, geometry);
      keys.add(merged.bucketKeyFor(cell.cellX, cell.cellY, classified));
    }
    for (const key of keys) queueMergedRebake(key, { immediate: true });
  }

  function hideSpawnStaticMerged(sa: any): void {
    sa._hiddenMerged = [];
    const set = sa.category === 'spawns' ? hiddenSpawnParts : hiddenOccurrenceParts;
    for (const part of sa.parts || []) {
      const key = `${Number(sa.info.room)}|${sa.category}|${Number(part.rowIndex)}`;
      set.add(key);
      sa._hiddenMerged.push(key);
    }
    queueSpawnBucketRebake(sa).catch(() => { /* re-bake is best-effort */ });
  }

  function restoreSpawnStaticMerged(sa: any): void {
    const set = sa.category === 'spawns' ? hiddenSpawnParts : hiddenOccurrenceParts;
    for (const key of sa._hiddenMerged || []) set.delete(key);
    sa._hiddenMerged = null;
    queueSpawnBucketRebake(sa).catch(() => { /* re-bake is best-effort */ });
  }

  function hideSpawnStatic(sa: any): void {
    if (mergedActive()) hideSpawnStaticMerged(sa);
    else hideSpawnStaticGraph(sa);
  }
  function restoreSpawnStatic(sa: any): void {
    if (sa?._hiddenGraph) restoreSpawnStaticGraph(sa);
    if (sa?._hiddenMerged) restoreSpawnStaticMerged(sa);
  }

  function syncSpawnEffectAnimation(sa: any): void {
    if (!sa || sa.info.sourceKind === 'spawn' || !Number.isInteger(sa.info.occurrenceIndex)
      || sa.info.occurrenceIndex < 0) return;
    const room = Number(sa.info.room), occurrence = sa.info.occurrenceIndex;
    const clip = sa.active ? sa.bar?.clipJson : null;
    const tickRate = effectsLayer?.clock.tickRate || Number(effectsDoc?.tick_rate?.value) || 600;
    if (sa.effectClip !== clip || sa.effectLoop !== sa.bar?.loop || sa.effectTickRate !== tickRate) {
      sa.effectAnimation?.dispose();
      sa.effectClip = clip;
      sa.effectLoop = sa.bar?.loop;
      sa.effectTickRate = tickRate;
      sa.effectAnimation = clip && sa.skeletonJson ? new EffectBoneAnimation(
        sa.skeletonJson, clip, sa.bar.loop, tickRate,
        () => sa.bar.elapsedMs) : null;
      sa.effectLayer?.setOccurrenceAnimation(room, occurrence, null);
      sa.effectLayer = null;
    }
    if (sa.effectLayer !== effectsLayer) {
      effectsLayer?.setOccurrenceAnimation(room, occurrence, sa.effectAnimation || null);
      sa.effectLayer = effectsLayer;
    }
  }

  function deactivateSpawnComposite(): void {
    if (!spawnAnim) return;
    spawnAnim.active = false;
    syncSpawnEffectAnimation(spawnAnim);
    if (spawnAnim.composite) spawnAnim.composite.group.visible = false;
    restoreSpawnStatic(spawnAnim);
    setInspectHighlightsVisible(true);
  }

  async function activateSpawnComposite(token: number): Promise<void> {
    if (destroyed || !spawnAnim || token !== spawnAnimToken || !spawnAnim.composite) return;
    clearVariantOverlay();
    restoreSpawnStatic(spawnAnim);
    if (!spawnAnim.partsLoaded) {
      spawnAnim.partsLoaded = true;
      const shard = await spawnShard(spawnAnim.info.room);
      if (destroyed || !spawnAnim || token !== spawnAnimToken) return;
      if (!shard) { spawnAnim.partsLoaded = false; return; }
      spawnAnim.shard = shard;
      await spawnAnim.composite.loadParts({
        parts: spawnAnim.parts,
        shard,
        category: spawnAnim.category,
        skinnedSet: spawnAnim.resolved?.skinnedSet,
        isDestroyed: () => destroyed || !spawnAnim || token !== spawnAnimToken,
      });
      if (destroyed || !spawnAnim || token !== spawnAnimToken) return;
      spawnAnimRoot.add(spawnAnim.composite.group);
    }
    if (destroyed || !spawnAnim || token !== spawnAnimToken) return;
    updateSpawnCompositeMatrix();
    hideSpawnStatic(spawnAnim);
    setInspectHighlightsVisible(false);
    spawnAnim.composite.group.visible = true;
    spawnAnim.active = true;
    syncSpawnEffectAnimation(spawnAnim);
  }

  function onSpawnClipChange(token: number): void {
    if (!spawnAnim || token !== spawnAnimToken || !spawnAnim.bar) return;
    const value = spawnAnim.bar.select.value;
    if (value === '' || value === '-1') deactivateSpawnComposite();
    else activateSpawnComposite(token).catch(() => { /* best-effort */ });
  }

  async function mountSpawnPicker(token: number, resolved: any): Promise<void> {
    let skelJson;
    try { skelJson = await app.store.json(resolved.skelEntry.f); } catch {
      if (spawnAnim && token === spawnAnimToken) {
        clear(spawnAnim.box);
        spawnAnim.box.appendChild(el('div', { class: 'wp-anim-hint dim small', text: 'rig failed to load' }));
        if (pinnedCtx && currentSpawnKey() === spawnAnim.key) showReadout(pinnedCtx.info, true);
      }
      return;
    }
    if (destroyed || !spawnAnim || token !== spawnAnimToken) return;
    const rig = new Rig(skelJson);
    spawnAnim.skeletonJson = skelJson;
    spawnAnim.rig = rig;
    spawnAnim.composite = new SpawnAnimComposite({ world, rig });
    clear(spawnAnim.box);
    spawnAnim.box.appendChild(el('div', { class: 'wp-anim-title', text: 'Animate this entity' }));
    const bar = new PlaybackBar({
      host: spawnAnim.box,
      clips: resolved.clips,
      store: app.store,
      rig,
      onApplied: () => { /* the render loop poses the skinned mesh */ },
      onError: (message: string) => setStatus(message, true),
    });
    spawnAnim.bar = bar;
    bar.select.addEventListener('change', () => onSpawnClipChange(token));
    // A spawn resting in a known clip opens on it (the whole-world view has
    // no live idles, so pinning one is how it starts breathing there).
    const defaultClip = spawnAnim.info?.defaultClip;
    if (spawnAnim.category === 'spawns' && Number.isInteger(defaultClip) && defaultClip >= 0
        && resolved.clips.some((c: any) => c.i === defaultClip && c.f)) {
      bar.select.value = String(defaultClip);
      bar.select.dispatchEvent(new Event('change'));
    }
    if (pinnedCtx && currentSpawnKey() === spawnAnim.key) showReadout(pinnedCtx.info, true);
  }

  async function startSpawnAnim(info: any, key: string, { parts, category, members }: any): Promise<void> {
    const token = ++spawnAnimToken;
    const box = el('div', { class: 'wp-anim' });
    box.appendChild(el('div', { class: 'wp-anim-hint dim small', text: 'checking for animations…' }));
    spawnAnim = {
      token, key, info, box, rig: null, composite: null, bar: null,
      resolved: null, shard: null, active: false, partsLoaded: false,
      parts, category, members,
    };
    if (pinnedCtx && currentSpawnKey() === key) showReadout(pinnedCtx.info, true);
    let resolved;
    try { resolved = await resolveSpawnAnim({ store: app.store, parts }); }
    catch { resolved = { kind: 'norig' }; }
    if (destroyed || !spawnAnim || token !== spawnAnimToken) return;
    spawnAnim.resolved = resolved;
    if (resolved.kind === 'norig') {
      spawnAnimToken++;
      disposeSpawnAnim(spawnAnim);
      spawnAnim = null;
      if (pinnedCtx) showReadout(pinnedCtx.info, true);
      return;
    }
    clear(box);
    if (resolved.kind === 'hint' || resolved.kind === 'noclips') {
      const text = resolved.kind === 'hint' ? resolved.message : 'No animations for this entity.';
      box.appendChild(el('div', { class: 'wp-anim-hint dim small', text }));
      if (pinnedCtx && currentSpawnKey() === key) showReadout(pinnedCtx.info, true);
      return;
    }
    await mountSpawnPicker(token, resolved);
  }

  // --- resting animations (single-room view) ---------------------------------
  // Every rigged spawn that rests in a known clip plays it from the moment its
  // room loads, as a parked entry of persistentAnims (so pinning it adopts the
  // running player, and unpinning parks it again). The static posed instance
  // is hidden while the player runs; turning the toggle off or unloading the
  // room disposes the entry and shows the posed static again. Without the
  // Animations category there is nothing to play: the posed static stays.
  const idleRooms = new Map<number, { token: number }>();
  let idleToken = 0;
  async function idleRoomLoaded(room: any): Promise<void> {
    if (!state.idle || destroyed) return;
    const roomId = Number(room.id);
    if (idleRooms.has(roomId)) return;
    const owner = { token: ++idleToken };
    idleRooms.set(roomId, owner);
    const shard = room.shard || await spawnShard(roomId);
    if (!shard?.spawns?.length || destroyed || idleRooms.get(roomId) !== owner) return;
    for (let index = 0; index < shard.spawns.length; index++) {
      if (destroyed || idleRooms.get(roomId) !== owner || !state.idle) return;
      const key = `${roomId}|spawn|${index}`;
      if (persistentAnims.has(key) || spawnAnim?.key === key) continue;
      let info;
      try { info = world._describeSpawn({ id: roomId, shard }, index); } catch { continue; }
      const clip = info?.defaultClip;
      if (!info?.parts?.length || !Number.isInteger(clip) || clip < 0) continue;
      try { await startIdleAnim(roomId, shard, info, key, clip, owner); } catch { /* one actor at a time */ }
    }
  }
  // Drop parked resting animations: one room's, or all of them.
  function disposeIdleAnims(roomId?: number): void {
    const prefix = roomId === undefined ? '' : `${roomId}|spawn|`;
    for (const [key, parked] of [...persistentAnims]) {
      if (!parked.idle || !key.startsWith(prefix)) continue;
      persistentAnims.delete(key);
      disposeSpawnAnim(parked);
    }
  }
  function idleRoomUnloaded(roomId: number): void {
    idleRooms.delete(roomId);
    disposeIdleAnims(roomId);
  }
  async function startIdleAnim(roomId: number, shard: any, info: any, key: string, clip: number, owner: { token: number }): Promise<void> {
    const live = () => !destroyed && idleRooms.get(roomId) === owner && state.idle;
    const resolved = await resolveSpawnAnim({ store: app.store, parts: info.parts });
    if (!live() || resolved.kind !== 'ready') return;
    const entry = resolved.clips.find((c: any) => c.i === clip && c.f);
    if (!entry) return;
    const skelJson = await app.store.json(resolved.skelEntry.f);
    if (!live() || persistentAnims.has(key) || spawnAnim?.key === key) return;
    const rig = new Rig(skelJson);
    const composite = new SpawnAnimComposite({ world, rig });
    const box = el('div', { class: 'wp-anim' });
    box.appendChild(el('div', { class: 'wp-anim-title', text: 'Animate this entity' }));
    const sa: any = {
      token: -1, key, info, box, rig, composite, bar: null, resolved, shard,
      active: false, partsLoaded: false, parts: info.parts, category: 'spawns', members: null,
      skeletonJson: skelJson, idle: true,
    };
    const bar = new PlaybackBar({
      host: box, clips: resolved.clips, store: app.store, rig,
      onApplied: () => { /* the render loop poses the skinned mesh */ },
      onError: () => { /* a resting clip that fails to load simply stays static */ },
    });
    sa.bar = bar;
    bar.select.value = String(entry.i);
    // Once adopted by a pin, clip changes go through the pinned-anim path.
    bar.select.addEventListener('change', () => {
      if (spawnAnim === sa) onSpawnClipChange(sa.token);
    });
    const loaded = await bar.loadClip(entry);
    if (!loaded || !live() || persistentAnims.has(key) || spawnAnim?.key === key) { disposeSpawnAnim(sa); return; }
    bar.play();
    await composite.loadParts({
      parts: info.parts, shard, category: 'spawns', skinnedSet: resolved.skinnedSet,
      isDestroyed: () => !live(),
    });
    if (!live() || persistentAnims.has(key) || spawnAnim?.key === key) { disposeSpawnAnim(sa); return; }
    spawnAnimRoot.add(composite.group);
    sa.partsLoaded = true;
    const matrix = computeSpawnBaseMatrix(info, shard);   // room offset included
    if (matrix) composite.setBaseMatrix(matrix);
    hideSpawnStatic(sa);
    composite.group.visible = true;
    sa.active = true;
    persistentAnims.set(key, sa);
  }
  function applyIdle(): void {
    if (state.idle) {
      for (const room of world.rooms.values()) idleRoomLoaded(room).catch(() => { /* best-effort */ });
      return;
    }
    idleRooms.clear();
    disposeIdleAnims();
  }

  // A playing/posed animation persists for the whole session, decoupled from
  // the pin: unpinning or selecting another model PARKS its composite here
  // (still ticking, statics still hidden) so it keeps animating; re-pinning
  // pulls it back. Only a view teardown, or explicitly clearing the clip,
  // disposes it. Keyed by the model key (currentSpawnKey()).
  const persistentAnims = new Map<string, any>();

  // Fully tear one anim down: restore its statics, dispose the composite/bar,
  // remove its DOM. Used on view destroy and when the clip is cleared.
  function disposeSpawnAnim(sa: any): void {
    if (!sa) return;
    sa.effectLayer?.setOccurrenceAnimation(Number(sa.info.room), sa.info.occurrenceIndex, null);
    sa.effectAnimation?.dispose();
    restoreSpawnStatic(sa);
    try { sa.bar?.destroy(); } catch { /* not yet built */ }
    sa.bar?.root?.remove();
    sa.composite?.dispose();
    sa.box?.remove();
  }

  // Leave the current pinned anim: if it is ACTIVE (a clip is applied: playing
  // or paused at a pose) park it so it keeps running; otherwise (idle picker,
  // no clip) dispose it. Detaching the box from the readout keeps the bar +
  // composite alive.
  function parkSpawnAnim(): void {
    if (!spawnAnim) return;
    const sa = spawnAnim;
    spawnAnim = null;
    if (sa.active && sa.composite) {
      sa.box?.remove();               // detach from the readout; keep the object
      persistentAnims.set(sa.key, sa);
    } else {
      spawnAnimToken++;               // stale any in-flight build
      disposeSpawnAnim(sa);
    }
  }

  // Called at every pin/unpin: re-attach a parked anim for the newly-pinned
  // model, build a fresh picker for a rigged model that has none, and park the
  // previously-pinned model's anim so it persists.
  function syncSpawnAnim(): void {
    const key = currentSpawnKey();
    if (spawnAnim && spawnAnim.key !== key) parkSpawnAnim();
    if (key && !spawnAnim) {
      if (persistentAnims.has(key)) {
        spawnAnim = persistentAnims.get(key);
        persistentAnims.delete(key);   // showReadout re-appends spawnAnim.box
        if (pinnedCtx) showReadout(pinnedCtx.info, true);
        return;
      }
      const anim = animPartsFor();
      if (anim?.parts?.length) startSpawnAnim(pinnedCtx.info, key, anim).catch(() => { /* best-effort */ });
    }
  }

  // --- edit controls (nudge / rotate / delete) --------------------------------
  // Reset clears nudges/deletes AND every applied variant (both persist for
  // the session), so it surfaces for either. The count reflects both.
  function syncEditsUi(): void {
    const n = edits.size + (variantOverlay ? 1 : 0) + persistentVariants.size
      + (effectsLayer ? effectsLayer.instanceEditCount() : 0);
    resetEditsBtn.hidden = n === 0;
    resetEditsBtn.textContent = `↺ Reset (${n})`;
  }
  function buildEditTools(): HTMLElement {
    const tools = el('div', { class: 'wp-edit' });
    const row = (label: string, prop: string, minusTitle: string, plusTitle: string) => {
      const minus = el('button', { type: 'button', text: prop === 'turns' ? '−90°' : '−', title: minusTitle });
      const plus = el('button', { type: 'button', text: prop === 'turns' ? '+90°' : '+', title: plusTitle });
      minus.addEventListener('click', () => nudgePinned(prop, -(prop === 'turns' ? 1 : editStep)));
      plus.addEventListener('click', () => nudgePinned(prop, prop === 'turns' ? 1 : editStep));
      append(tools, el('span', { class: 'axis', text: label }), minus, plus);
    };
    row('X', 'dx', 'Nudge −X', 'Nudge +X');
    row('Y', 'dy', 'Nudge −Y', 'Nudge +Y');
    row('Z', 'dz', 'Nudge down in game Z layers', 'Nudge up in game Z layers');
    row('Turn', 'turns', 'Rotate −90°', 'Rotate +90°');
    const step = el('select', { title: 'X/Y use tiles; Z uses game height layers' });
    for (const value of [0.25, 0.5, 1, 2]) {
      step.appendChild(el('option', { value: String(value), text: `${value} tiles · layers` }));
    }
    step.value = String(editStep);
    step.addEventListener('change', () => { editStep = Number(step.value); });
    append(tools, el('span', { class: 'axis', text: 'Step' }), step);
    const del = el('button', {
      class: 'wp-delete', type: 'button', text: '✕ Delete',
      title: 'Hide this placement for this session (Delete key)',
    });
    del.addEventListener('click', () => deletePinned());
    return el('div', { class: 'wp-edit-wrap' }, tools, el('div', { class: 'wp-edit-actions' }, del));
  }

  function pivotFor(info: any): [number, number] {
    // Occurrences and spawns share one raw room-local frame (no crop offset:
    // see the map_offset note in world/scene.js).
    const anchor = info.placementAnchor?.center || [
      Number(info.position[0]) + 0.5,
      Number(info.position[1]) + 0.5,
    ];
    return [Number(anchor[0]) * world.tileUnits, Number(anchor[1]) * world.tileUnits];
  }

  // First edit of a placement captures everything reset needs: the pristine
  // matrix, the anchor pivot (room-local), the per-path binding and (merged)
  // the pick-index snapshot plus the bucket the re-bake must target.
  function ensureEditForMember(member: any): any {
    const info = member.info;
    const existing = edits.get(info);
    if (existing) return existing;
    const original = new THREE.Matrix4();
    if (member.mode === 'graph') {
      member.object.getMatrixAt(member.instanceId, original);
      return edits.ensure(info, {
        original,
        pivot: pivotFor(info),
        roomOffset: [0, 0],
        object: member.object,
        instanceId: member.instanceId,
        entryIndex: null,
        snapshot: null,
        bucketKey: null,
        geometryBox: null,
      });
    }
    pickIndex.matrix(member.entryIndex, original);
    const frame = worldFrame?.frames.get(Number(info.room));
    const roomOffset = frame
      ? [(frame.x + worldFrame!.ox) * world.tileUnits, (frame.y + worldFrame!.oz) * world.tileUnits]
      : [0, 0];
    const cell = merged.cellOfRoom(info.room);
    const classified = merged.classifyBucket({
      category: info.category,
      renderTexture: info.renderTexture,
      flags: info.flags,
      recolors: info.recolors,
      depthRank: info.depthRank,
      z: info.z,
    }, member.geometry);
    return edits.ensure(info, {
      original,
      pivot: pivotFor(info),
      roomOffset,
      object: null,
      instanceId: -1,
      entryIndex: member.entryIndex,
      snapshot: pickIndex.snapshot(member.entryIndex),
      bucketKey: cell ? merged.bucketKeyFor(cell.cellX, cell.cellY, classified) : null,
      geometryBox: member.geometry?.boundingBox || null,
    });
  }

  function applyGraphEdit(edit: any): void {
    if (!edit.object?.parent) return;
    if (edit.deleted) {
      edit.object.setMatrixAt(edit.instanceId, zeroMatrix);
    } else {
      editedMatrix(edit, edit.original, edit.pivot[0], edit.pivot[1],
        world.tileUnits, world.layerUnits, editScratch);
      edit.object.setMatrixAt(edit.instanceId, editScratch);
    }
    edit.object.instanceMatrix.needsUpdate = true;
    edit.object.computeBoundingBox();
    edit.object.computeBoundingSphere();
    if (highlight && pinnedCtx?.mode === 'graph' && pinnedCtx.object === edit.object && !edit.deleted) {
      edit.object.getMatrixAt(edit.instanceId, highlight.matrix);
      for (let node = edit.object; node && node !== world.root; node = node.parent) {
        highlight.matrix.premultiply(node.matrix);
      }
      highlight.matrixWorldNeedsUpdate = true;
    }
  }

  function applyIndexEdit(edit: any): void {
    if (!pickIndex || edit.entryIndex == null) return;
    if (edit.deleted) {
      pickIndex.markDeleted(edit.entryIndex, true);
    } else {
      editedMatrix(edit, edit.original,
        edit.pivot[0] + edit.roomOffset[0], edit.pivot[1] + edit.roomOffset[1],
        world.tileUnits, world.layerUnits, editScratch);
      pickIndex.setMatrix(edit.entryIndex, editScratch, edit.geometryBox || null);
      if (highlight && pinnedCtx?.mode === 'index' && pinnedCtx.entryIndex === edit.entryIndex) {
        highlight.matrix.copy(editScratch);
        highlight.matrixWorldNeedsUpdate = true;
      }
    }
    queueMergedRebake(edit.bucketKey, { immediate: edit.deleted });
  }

  function nudgePinned(prop: string, delta: number): void {
    if (!pinnedCtx || destroyed) return;
    if (spawnAnim?.active) restoreSpawnStatic(spawnAnim);
    // whole-model selection: the nudge applies to every part of the group
    for (const member of pinnedMembers()) {
      const edit = ensureEditForMember(member);
      if (!edit) continue;
      edit[prop] += delta;
      if (prop === 'turns') edit.turns = Math.round(edit.turns);
      if (edit.object) applyGraphEdit(edit);
      else applyIndexEdit(edit);
      if (edits.isNoop(edit)) {
        // Fully undone: drop the record (the matrices above already restored).
        if (edit.entryIndex != null && edit.snapshot) pickIndex.restore(edit.entryIndex, edit.snapshot);
        edits.remove(edit);
      }
    }
    refreshGroupHighlights();
    if (pinnedCtx) showReadout(pinnedCtx.info, true);
    // A playing spawn composite must follow the nudge to where the static sits.
    if (spawnAnim?.active && spawnAnim.key === currentSpawnKey()) {
      updateSpawnCompositeMatrix();
      hideSpawnStatic(spawnAnim);
    }
    syncEditsUi();
  }

  function deletePinned(): void {
    if (!pinnedCtx || destroyed) return;
    for (const member of pinnedMembers()) {
      const edit = ensureEditForMember(member);
      if (!edit) continue;
      edit.deleted = true;
      if (edit.object) applyGraphEdit(edit);
      else applyIndexEdit(edit);
    }
    clearInspection(true);
    syncEditsUi();
  }

  function resetAllEdits(): void {
    const hasVariants = variantOverlay || persistentVariants.size;
    const hasAnims = spawnAnim || persistentAnims.size;
    const hasFxEdits = !!effectsLayer && effectsLayer.instanceEditCount() > 0;
    if (destroyed || (!edits.size && !hasVariants && !hasAnims && !hasFxEdits)) {
      syncEditsUi();
      return;
    }
    const bucketKeys = new Set<string>();
    for (const edit of edits.values()) {
      if (edit.object) {
        if (edit.object.parent) {
          edit.object.setMatrixAt(edit.instanceId, edit.original);
          edit.object.instanceMatrix.needsUpdate = true;
          edit.object.computeBoundingBox();
          edit.object.computeBoundingSphere();
        }
      } else if (pickIndex && edit.entryIndex != null && edit.snapshot) {
        pickIndex.restore(edit.entryIndex, edit.snapshot);
        if (edit.bucketKey) bucketKeys.add(edit.bucketKey);
      }
    }
    edits.clear();
    for (const key of bucketKeys) queueMergedRebake(key);
    if (bucketKeys.size) flushRebakeNow();
    effectsLayer?.resetAllInstanceEdits();
    clearInspection(true);         // unpin (parks the active variant/anim)…
    clearEffectInspection(true);   // …release a pinned effect instance too…
    clearAllVariantOverlays();     // …then hard-revert every variant…
    // …and every animation (active + parked): restore statics, drop composites.
    spawnAnimToken++;
    disposeSpawnAnim(spawnAnim);
    spawnAnim = null;
    for (const parked of persistentAnims.values()) disposeSpawnAnim(parked);
    persistentAnims.clear();
    syncEditsUi();
  }

  // --- merged-mode edit re-bake: bounded to the edited bucket(s) of the
  // edited cell(s), debounced so a burst of nudges bakes once, serialized on
  // a promise chain so runs never overlap. rebakeRuns is the test hook.
  let rebakeTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let rebakeChain: Promise<void> = Promise.resolve();
  let rebakeRuns = 0;
  let rebakeBusy = false;
  const pendingBucketKeys = new Set<string>();
  function queueMergedRebake(key: any, { immediate = false }: { immediate?: boolean } = {}): void {
    if (!key || !mergedActive()) return;
    pendingBucketKeys.add(key);
    if (rebakeTimer) clearTimeout(rebakeTimer);
    rebakeTimer = 0;
    if (immediate) flushRebakeNow();
    else rebakeTimer = setTimeout(flushRebakeNow, 400);
  }
  function flushRebakeNow(): void {
    if (rebakeTimer) clearTimeout(rebakeTimer);
    rebakeTimer = 0;
    if (!pendingBucketKeys.size || destroyed) return;
    const keys = [...pendingBucketKeys];
    pendingBucketKeys.clear();
    rebakeBusy = true;
    rebakeChain = rebakeChain
      .then(() => runMergedRebake(keys))
      .then(() => { rebakeRuns++; })
      .catch((error) => {
        if (destroyed) return;
        console.warn('world edit re-bake failed:', error);
        setStatus(`edit re-bake failed: ${error?.message || error}`, true);
      })
      .finally(() => { rebakeBusy = pendingBucketKeys.size > 0 || !!rebakeTimer; });
  }
  async function runMergedRebake(keys: string[]): Promise<void> {
    if (destroyed || !merged?.ready || !worldFrame) return;
    const byCell = new Map<string, string[]>();
    for (const key of keys) {
      const cellKey = key.slice(0, key.indexOf('|'));
      const list = byCell.get(cellKey) || [];
      list.push(key);
      byCell.set(cellKey, list);
    }
    const original = new THREE.Matrix4();
    const scratch = new THREE.Matrix4();
    for (const [cellKey, cellKeys] of byCell) {
      const [cellX, cellY] = cellKey.split(',').map(Number);
      // pre-seed with null so a fully-deleted bucket is still swept
      const defs = new Map<string, any>(cellKeys.map((key) => [key, null] as [string, any]));
      for (const roomId of merged.roomsInCell(cellX, cellY)) {
        if (destroyed) return;
        let shard = null;
        try { shard = await cachedShard(roomId); } catch { continue; }
        const frame = worldFrame.frames.get(Number(roomId));
        if (!frame) continue;
        const roomX = (frame.x + worldFrame.ox) * world.tileUnits;
        const roomY = (frame.y + worldFrame.oz) * world.tileUnits;
        for (const batch of world._batchRows(shard)) {
          if (batch.flags & world.flags.authoredEmpty) continue;
          // cheap prefilter before touching geometry: the bucket key embeds
          // the texture/fill token, so most batches skip without a load
          const token = Number(batch.renderTexture) >= 0
            ? `t${batch.renderTexture}` : `f${batch.category}`;
          if (!cellKeys.some((key) => key.includes(`|${token}|`))) continue;
          let geometry = null;
          try { geometry = await world._batchGeometry(batch); } catch { continue; }
          if (destroyed) return;
          const classified = merged.classifyBucket({
            category: batch.category,
            renderTexture: batch.renderTexture,
            flags: batch.flags,
            recolors: batch.recolors,
            depthRank: batch.depthRank,
            z: batch.z,
          }, geometry);
          const key = merged.bucketKeyFor(cellX, cellY, classified);
          if (!defs.has(key)) continue;
          const array = new Float32Array(batch.entries.length * 16);
          let live = 0;
          for (const entry of batch.entries) {
            const edit = edits.get({
              room: roomId, sourceKind: entry.sourceKind,
              category: batch.category, placementIndex: entry.placementIndex,
            });
            if (edit?.deleted) continue;
            // A spawn part whose animated composite is currently playing is
            // skipped, so its static bake vanishes under the overlay.
            if (entry.sourceKind === 'spawn'
                && hiddenSpawnParts.has(`${Number(roomId)}|${batch.category}|${Number(entry.placementIndex)}`)) continue;
            if (entry.sourceKind !== 'spawn'
                && hiddenOccurrenceParts.has(`${Number(roomId)}|${batch.category}|${Number(entry.placementIndex)}`)) continue;
            try {
              if (entry.sourceKind === 'spawn') world._spawnMatrix(shard, entry.row, original);
              else world._placementMatrix(shard, entry.row, original, batch.reflectLocalX);
            } catch { continue; }
            if (edit) {
              editedMatrix(edit, original, edit.pivot[0], edit.pivot[1],
                world.tileUnits, world.layerUnits, scratch);
              array.set(scratch.elements, live * 16);
            } else {
              array.set(original.elements, live * 16);
            }
            live++;
          }
          if (!live) continue;
          let def = defs.get(key);
          if (!def) {
            def = {
              key, cellX, cellY,
              materialToken: classified.materialToken,
              depthRank: classified.depthRank,
              renderTexture: classified.renderTexture,
              flatCategory: classified.flatCategory,
              alpha: classified.alpha,
              tangent: classified.tangent,
              water: classified.water,
              items: [],
            };
            defs.set(key, def);
          }
          def.items.push({
            geometry,
            count: live,
            instanceArray: live === batch.entries.length ? array : array.subarray(0, live * 16),
            roomX,
            roomY,
            room: merged.roomSlot(roomId),
            metaZ: classified.metaZ,
            metaBits: classified.metaBits,
            recolors: batch.recolors,
            fullTint: !!(batch.flags & world.flags.uniformLuminanceTint),
          });
        }
      }
      if (destroyed) return;
      hud.setStage(`re-baking edited cell ${cellKey}…`);
      await merged.replaceBuckets(defs);
      if (destroyed) return;
    }
    if (ready) hud.setStage(`ready · ${allProgress?.loaded ?? world.rooms.size} rooms`, { steady: true });
    syncStatus();
  }

  // --- merged-mode picking (CPU index broad phase + precise triangle test) ----
  const nativeRay = new THREE.Ray();
  const nativeRayMatrix = new THREE.Matrix4();
  const pickMatrix = new THREE.Matrix4();
  const pickScratchMesh = new THREE.Mesh(
    undefined,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  pickScratchMesh.matrixAutoUpdate = false;
  // Tiny LRU of shard promises: the readout needs the source rows, but merged
  // mode must not retain shard JSON world-wide: 4 rooms is plenty for
  // hovering around a seam (cleared with the view).
  const shardCache = new Map<number, Promise<any>>();
  function cachedShard(roomId: any): Promise<any> {
    const id = Number(roomId);
    if (shardCache.has(id)) {
      const hit = shardCache.get(id)!;
      shardCache.delete(id);
      shardCache.set(id, hit);
      return hit;
    }
    const promise = Promise.resolve(app.store.worldRoom(id)).then((shard) => {
      if (!shard) throw new Error(`room ${id} shard is not stored`);
      // (as the game draws it: its individuals' conditions at each room's chosen progress)
      return world.drawnShard(shard);
    }).catch((error) => {
      shardCache.delete(id);
      throw error;
    });
    shardCache.set(id, promise);
    while (shardCache.size > 4) shardCache.delete(shardCache.keys().next().value!);
    return promise;
  }

  // Pickable = what the merged shader would draw right now.
  function pickMetaFilter(meta: number): boolean {
    if (!state[WORLD_CATEGORIES[meta & PICK_CATEGORY_MASK]]) return false;
    if (!world.isZVisible(pickMetaZ(meta))) return false;
    if ((meta & PICK_UNTEXTURED_BIT) && !state.untextured) return false;
    if ((meta & PICK_WATER_BIT) && state.water) return false;   // hidden curtains
    return true;
  }

  function indexPickCandidates(clientX: number, clientY: number): any[] | null {
    if (!pickIndex?.ready || !merged) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    scene3d.camera.updateMatrixWorld();
    raycaster.setFromCamera(pointerNdc, scene3d.camera);
    confirmRaycaster.ray.copy(raycaster.ray);
    merged.root.updateMatrixWorld();
    nativeRayMatrix.copy(merged.root.matrixWorld).invert();
    nativeRay.copy(raycaster.ray).applyMatrix4(nativeRayMatrix);
    return pickIndex.raycast(nativeRay.origin, nativeRay.direction, {
      filter: pickMetaFilter, maxCandidates: 24,
    });
  }

  // Narrow phase: load each candidate's mesh through the shared geometry path
  // and triangle-test it in display space; the nearest confirmed hit wins.
  // Returns null (miss) or undefined (stale: a newer pick superseded us).
  async function resolveIndexPick(clientX: number, clientY: number, token: number): Promise<any> {
    const candidates = indexPickCandidates(clientX, clientY);
    if (!candidates || !candidates.length) return null;
    let best = null;
    for (const candidate of candidates) {
      const ref = pickIndex.ref(candidate.index);
      let geometry = null;
      try { geometry = await world._meshGeometry(ref.mesh, ref.reflect); } catch { continue; }
      if (destroyed || token !== pickToken) return undefined;
      pickIndex.matrix(candidate.index, pickMatrix);
      pickScratchMesh.geometry = geometry;
      pickScratchMesh.matrixWorld.multiplyMatrices(merged.root.matrixWorld, pickMatrix);
      const hits: any[] = [];
      pickScratchMesh.raycast(confirmRaycaster, hits);
      for (const hit of hits) {
        if (!best || hit.distance < best.distance) {
          best = { entryIndex: candidate.index, ref, geometry, distance: hit.distance };
        }
      }
    }
    return best;
  }

  async function showIndexInspection(hit: any, pinned: boolean, token: number): Promise<void> {
    let shard = null;
    try { shard = await cachedShard(hit.ref.room); } catch { clearInspection(pinned); return; }
    if (destroyed || token !== pickToken || !state.inspect) return;
    const info = world.describeShardPlacement(
      hit.ref.room, shard, hit.ref.sourceKind, hit.ref.category, hit.ref.placementIndex,
    );
    if (!info) { clearInspection(pinned); return; }
    // Hovering a different PART of the model already outlined leaves the whole-
    // model highlight in place: no clear + async rebuild, so it can't flicker.
    if (!pinned) {
      const mk = modelKeyOf(info);
      if (mk && mk === hoverModelKey && highlight?.parent) {
        showReadout(info, false);
        renderer.domElement.style.cursor = 'crosshair';
        return;
      }
      hoverModelKey = mk;
    }
    // Leaving the previous model for a different one PARKS its variant (it
    // persists, drawn, until an explicit revert); syncVariantOverlay below
    // re-adopts whatever the newly-pinned model had parked.
    if (pinned && pinnedCtx && modelKeyOf(pinnedCtx.info) !== modelKeyOf(info)) {
      parkVariantOverlay();
    }
    // A pinned effect instance and a pinned placement share one readout and
    // are mutually exclusive: pinning a placement releases any pinned effect.
    if (pinned && effectPinned) clearEffectInspection(true);
    inspectPinned = !!pinned;
    pinnedCtx = pinned
      ? { mode: 'index', entryIndex: hit.entryIndex, ref: hit.ref, info, geometry: hit.geometry, shard, group: null }
      : null;
    clearGroupHighlights();
    if (pinned) attachModelGroup(token).catch(() => {});
    else showHoverGroup({ mode: 'index', entryIndex: hit.entryIndex, ref: hit.ref, info, geometry: hit.geometry, shard }, `pick:${hit.entryIndex}`).catch(() => {});
    const key = `pick:${hit.entryIndex}`;
    if (key !== inspectedKey) {
      inspectedKey = key;
      if (!highlight) {
        highlight = new THREE.Mesh(hit.geometry, highlightMaterial);
        highlight.matrixAutoUpdate = false;
        highlight.frustumCulled = false;
        highlight.renderOrder = 1000;
      } else {
        highlight.removeFromParent();
        highlight.geometry = hit.geometry;
      }
      pickIndex.matrix(hit.entryIndex, highlight.matrix);
      highlight.matrixWorldNeedsUpdate = true;
      highlightRoot.add(highlight);
    }
    showReadout(info, inspectPinned);
    if (pinned) {
      attachIndexPreview(info, hit);
      syncSpawnAnim();
    }
    renderer.domElement.style.cursor = 'crosshair';
  }

  async function attachIndexPreview(info: any, hit: any): Promise<void> {
    let material = null;
    try {
      material = await world._material(
        info.category, info.material, Number(info.renderTexture),
        info.flags | 0, info.recolors,
      );
    } catch { material = null; }
    if (destroyed || pinnedCtx?.entryIndex !== hit.entryIndex) return;
    pickIndex.matrix(hit.entryIndex, pickMatrix);
    showPreviewMesh(hit.geometry, material, pickMatrix);
    // re-render the readout so the preview slots in above the edit tools
    if (pinnedCtx) showReadout(pinnedCtx.info, true);
  }

  // Which variant overlay (active or parked) the pointer ray hits, or null.
  // Every overlay stands in for hidden statics, so all must stay pickable: the
  // nearest hit wins so a click selects the overlay actually in front.
  function pickVariantOverlay(clientX: number, clientY: number): any {
    const overlays = allVariantOverlays();
    if (!overlays.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    scene3d.camera.updateMatrixWorld();
    raycaster.setFromCamera(pointerNdc, scene3d.camera);
    let best = null;
    for (const ov of overlays) {
      const hits = raycaster.intersectObjects(ov.meshes, false);
      if (hits.length && (!best || hits[0].distance < best.distance)) {
        best = { overlay: ov, distance: hits[0].distance };
      }
    }
    return best?.overlay || null;
  }

  // Effect-instance picking: the particle batches themselves are instanced
  // billboards sharing one geometry across every emitter in a texture x
  // blend pair, so a raycast hit on a batch could never identify WHICH
  // instance/system was struck. effects-layer.ts instead gives every
  // instance its own tiny proxy Mesh at its anchor (see the picking note
  // atop effects-layer.ts); this raycasts exactly those, so effect picking
  // works identically in single-room and merged mode (both share the same
  // camera/scene graph -- there is no index/graph split here the way
  // placement picking has). Returns null with no cost when the layer is off
  // (no proxies exist -- toggling Effects off is what makes them
  // unpickable, satisfying "only pickable when the layer is on").
  function pickEffectProxy(clientX: number, clientY: number): { key: string } | null {
    if (!effectsLayer) return null;
    const items: { object: THREE.Object3D; key: string }[] = effectsLayer.pickables();
    if (!items.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    scene3d.camera.updateMatrixWorld();
    raycaster.setFromCamera(pointerNdc, scene3d.camera);
    const hits = raycaster.intersectObjects(items.map((it) => it.object), false);
    if (!hits.length) return null;
    const hit = items.find((it) => it.object === hits[0].object);
    return hit ? { key: hit.key } : null;
  }

  // --- pinned effect instance: readout + session edits ------------------
  // Per-emitter summary rows for the pinned/hovered instance's system: rate
  // (from its burst config), life, colour swatches and a sprite thumbnail, one
  // row per EMITTER, since a system's emitters can differ.
  function buildEmitterSummary(system: any): HTMLElement {
    const wrap = el('div', { class: 'wp-fx-emitters' });
    for (let i = 0; i < (system.emitters || []).length; i++) {
      const emitter = system.emitters[i];
      const cfg = emitter.burst != null ? effectsDoc?.configs?.[String(emitter.burst)] : null;
      const rate = cfg && cfg.per_second != null ? `${fmtNum(cfg.per_second, 1)}/s` : 'no burst';
      const life = emitter.life?.ticks != null ? `${fmtInt(emitter.life.ticks)}t life` : 'no life';
      const row = el('div', { class: 'wp-fx-emitter' });
      row.appendChild(el('span', { class: 'wp-fx-emitter-text', text: `#${i + 1} · ${rate} · ${life}` }));
      const swatches = el('span', { class: 'we-swatches' });
      for (const c of [emitter.color0, emitter.color1]) {
        if (!c) continue;
        const [r, g, b, a] = c.rgba;
        swatches.appendChild(el('span', {
          class: 'we-swatch',
          title: `rgba(${r.toFixed(2)}, ${g.toFixed(2)}, ${b.toFixed(2)}, ${a.toFixed(2)})`,
          style: `background: rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`,
        }));
      }
      if (swatches.children.length) row.appendChild(swatches);
      const imgId = emitter.sprite?.images?.[0];
      if (imgId != null) {
        const { sub } = spriteDrawOf(emitter.sprite);
        row.appendChild(el('img', {
          class: 'we-thumb', loading: 'lazy', src: app.store.url(`images/${pad5(imgId)}_e${sub}.png`),
        }));
      }
      wrap.appendChild(row);
    }
    return wrap;
  }

  // System name/room/occurrence/blend/timing/per-emitter knobs + the live
  // particle count for THIS instance, following readoutRows' exact shape
  // ([term, value][] -> a dl). `key` = effectInstanceKey(room, occurrence,
  // system); the System row follows the SAME readout-link + reveal-handoff
  // idiom as effectsReadoutRow above (a pinned PLACEMENT linking out to its
  // attached system), just in the other direction.
  function effectReadoutRows(key: string, pinned: boolean): [string, any][] {
    const [roomStr, occStr, sysStr] = key.split('|');
    const roomId = Number(roomStr);
    const occurrence = Number(occStr);
    const sysSlot = Number(sysStr);
    const system = effectsDoc?.systems?.find((s: any) => Number(s.slot) === sysSlot) || null;
    const info = effectsLayer ? effectsLayer.instanceInfo(key) : null;
    const name = system?.names?.[0]?.name || `system #${sysSlot}`;
    const roomCell = `${identifier(roomId)}${world.roomMeta(roomId)?.name ? ` · ${world.roomMeta(roomId).name}` : ''}`;
    const rows: [string, any][] = [
      ['System', name],
      ['Room', `${roomCell} · occurrence ${identifier(occurrence)}`],
      ['Emitters', String(system?.emitters?.length ?? 0)],
      ['Blend', system?.blend || 'none'],
      ['Timing', system?.loop ? 'loop (ambient)' : 'timed (one-shot)'],
    ];
    if (system?.emitters?.length) rows.push(['Detail', buildEmitterSummary(system)]);
    rows.push(['Live', info ? fmtInt(info.live) : '-']);
    if (pinned && info?.edit) {
      const parts: string[] = [];
      if (info.edit.dx || info.edit.dy || info.edit.dz) {
        parts.push(`Δ ${compact(info.edit.dx)}, ${compact(info.edit.dy)} tiles · ${compact(info.edit.dz)} layers`);
      }
      if (info.edit.scaleMult !== 1) parts.push(`scale ×${compact(info.edit.scaleMult)}`);
      if (info.edit.hidden) parts.push('hidden (session only)');
      if (info.edit.paused) parts.push('paused');
      if (info.edit.clockOffset) parts.push(`time Δ ${compact(info.edit.clockOffset)} ticks`);
      if (parts.length) rows.push(['Delta', parts.join(' · ')]);
    }
    rows.push(['Inspect', pinned ? 'pinned (click again to release)' : 'hover · click to pin']);
    return rows;
  }

  // Session-edit tools for the pinned effect instance: SAME grid/classes as
  // buildEditTools() above (X/Y/Z nudge + shared step selector), plus a
  // Scale nudge pair reusing the identical grid row shape, a Time nudge pair
  // scrubbing the instance's own clock (step derived from the doc's tick
  // rate, never a hardcoded literal), and wp-edit-actions buttons for
  // pause/resume, hide/show and reset -- resetting THIS instance only
  // (the panel's global "Reset edits" button covers every placement AND
  // effect edit at once via resetAllEdits below).
  function buildEffectEditTools(key: string): HTMLElement {
    const info = effectsLayer ? effectsLayer.instanceInfo(key) : null;
    const edit: EffectInstanceEdit | null = info?.edit ?? null;
    const tools = el('div', { class: 'wp-edit' });
    const row = (label: string, axis: 'dx' | 'dy' | 'dz', minusTitle: string, plusTitle: string) => {
      const minus = el('button', { type: 'button', text: '−', title: minusTitle });
      const plus = el('button', { type: 'button', text: '+', title: plusTitle });
      minus.addEventListener('click', () => nudgeEffectPinned(axis, -fxEditStep));
      plus.addEventListener('click', () => nudgeEffectPinned(axis, fxEditStep));
      append(tools, el('span', { class: 'axis', text: label }), minus, plus);
    };
    row('X', 'dx', 'Nudge effect −X', 'Nudge effect +X');
    row('Y', 'dy', 'Nudge effect −Y', 'Nudge effect +Y');
    row('Z', 'dz', 'Nudge effect down in game Z layers', 'Nudge effect up in game Z layers');
    const step = el('select', { title: 'X/Y use tiles; Z uses game height layers' });
    for (const value of [0.25, 0.5, 1, 2]) {
      step.appendChild(el('option', { value: String(value), text: `${value} tiles · layers` }));
    }
    step.value = String(fxEditStep);
    step.addEventListener('change', () => { fxEditStep = Number(step.value); });
    append(tools, el('span', { class: 'axis', text: 'Step' }), step);

    const scaleMinus = el('button', { type: 'button', text: '−', title: 'Shrink this effect' });
    const scalePlus = el('button', { type: 'button', text: '+', title: 'Enlarge this effect' });
    scaleMinus.addEventListener('click', () => nudgeEffectScalePinned(1 / 1.1));
    scalePlus.addEventListener('click', () => nudgeEffectScalePinned(1.1));
    append(tools, el('span', { class: 'axis', text: 'Scale' }), scaleMinus, scalePlus);

    // Step derived from the LAYER's own tick rate (from the doc, guarded
    // default inside effects-sim.js) -- never the literal tick-rate value
    // itself, matching THE BOUNDARY's ban on hardcoding it.
    const clockStep = Math.max(1, Math.round((effectsLayer?.clock?.tickRate || 1) * 0.25));
    const timeMinus = el('button', { type: 'button', text: '−', title: 'Scrub this effect back in time' });
    const timePlus = el('button', { type: 'button', text: '+', title: 'Scrub this effect forward in time' });
    timeMinus.addEventListener('click', () => nudgeEffectClockPinned(-clockStep));
    timePlus.addEventListener('click', () => nudgeEffectClockPinned(clockStep));
    append(tools, el('span', { class: 'axis', text: 'Time' }), timeMinus, timePlus);

    const pauseBtn = el('button', {
      class: `wp-fx-pause${edit?.paused ? ' active' : ''}`, type: 'button', text: edit?.paused ? '▶' : '❚❚',
      title: edit?.paused ? 'Resume this effect' : 'Pause this effect',
    });
    pauseBtn.addEventListener('click', () => toggleEffectPausedPinned());
    const hideBtn = el('button', {
      class: `wp-fx-hide${edit?.hidden ? ' active' : ''}`, type: 'button', text: edit?.hidden ? 'Show' : 'Hide',
      title: edit?.hidden ? 'Show this effect again' : 'Hide this effect for this session',
    });
    hideBtn.addEventListener('click', () => toggleEffectHiddenPinned());
    const resetBtn = el('button', {
      class: 'wp-fx-reset', type: 'button', text: '↺ Reset',
      title: 'Restore this effect to its authored position, size and state',
    });
    resetBtn.addEventListener('click', () => resetEffectPinned());
    return el('div', { class: 'wp-edit-wrap' }, tools,
      el('div', { class: 'wp-edit-actions' }, pauseBtn, hideBtn, resetBtn));
  }

  function showEffectReadout(key: string, pinned: boolean): void {
    const list = el('dl', {});
    for (const [term, value] of effectReadoutRows(key, pinned)) {
      append(list, el('dt', { text: term }),
        typeof value === 'string' ? el('dd', { text: value }) : el('dd', {}, value));
    }
    clear(readout);
    readout.appendChild(list);
    if (pinned) readout.appendChild(buildEffectEditTools(key));
    readout.classList.toggle('pinned', pinned);
    readout.hidden = false;
  }

  // Pin/hover an effect instance: mirrors showInspection/showIndexInspection
  // for placements, but there is only ONE shape here (no graph/index split --
  // see the pickEffectProxy comment), so one function covers both views.
  // Pinning a NEW effect clears any pinned PLACEMENT first (the two pins are
  // mutually exclusive, sharing one readout); the reverse direction is
  // wired into showInspection/showIndexInspection below.
  function showEffectInspection(key: string, pinned: boolean): void {
    if (pinned && inspectPinned) clearInspection(true);
    if (fxHoverKey && fxHoverKey !== key) effectsLayer?.setInstanceHighlighted(fxHoverKey, false);
    fxHoverKey = key;
    effectsLayer?.setInstanceHighlighted(key, true);
    effectPinned = pinned ? { key } : null;
    showEffectReadout(key, pinned);
    renderer.domElement.style.cursor = 'crosshair';
  }

  function clearEffectInspection(force = false): void {
    // Symmetric with clearInspection: the readout is shared, so this must not
    // clear it out from under a pinned PLACEMENT either.
    if (!force && (effectPinned || inspectPinned)) return;
    if (fxHoverKey) {
      effectsLayer?.setInstanceHighlighted(fxHoverKey, false);
      fxHoverKey = null;
    }
    effectPinned = null;
    readout.hidden = true;
    readout.classList.remove('pinned');
    clear(readout);
    renderer.domElement.style.cursor = '';
  }

  // Re-render the pinned effect's readout after an edit; gracefully releases
  // the pin if the instance's room went away underneath it (single-room
  // unload / merged proximity deactivation already try to clear the pin
  // proactively -- see effectsRoomUnloaded/updateMergedEffectsActivation --
  // this is the belt-and-braces fallback for any path that doesn't).
  function refreshEffectReadout(): void {
    if (!effectPinned) return;
    if (!effectsLayer || !effectsLayer.instanceInfo(effectPinned.key)) { clearEffectInspection(true); return; }
    showEffectReadout(effectPinned.key, true);
  }

  function nudgeEffectPinned(axis: 'dx' | 'dy' | 'dz', delta: number): void {
    if (!effectPinned || !effectsLayer) return;
    effectsLayer.nudgeInstance(effectPinned.key, axis, delta);
    refreshEffectReadout();
    syncEditsUi();
  }
  function nudgeEffectScalePinned(factor: number): void {
    if (!effectPinned || !effectsLayer) return;
    effectsLayer.nudgeInstanceScale(effectPinned.key, factor);
    refreshEffectReadout();
    syncEditsUi();
  }
  function toggleEffectHiddenPinned(): void {
    if (!effectPinned || !effectsLayer) return;
    const info = effectsLayer.instanceInfo(effectPinned.key);
    if (!info) return;
    effectsLayer.setInstanceHidden(effectPinned.key, !info.edit.hidden);
    refreshEffectReadout();
    syncEditsUi();
  }
  function toggleEffectPausedPinned(): void {
    if (!effectPinned || !effectsLayer) return;
    const info = effectsLayer.instanceInfo(effectPinned.key);
    if (!info) return;
    effectsLayer.setInstancePaused(effectPinned.key, !info.edit.paused);
    refreshEffectReadout();
    syncEditsUi();
  }
  function nudgeEffectClockPinned(deltaTicks: number): void {
    if (!effectPinned || !effectsLayer) return;
    effectsLayer.nudgeInstanceClock(effectPinned.key, deltaTicks);
    refreshEffectReadout();
    syncEditsUi();
  }
  function resetEffectPinned(): void {
    if (!effectPinned || !effectsLayer) return;
    effectsLayer.resetInstanceEdit(effectPinned.key);
    refreshEffectReadout();
    syncEditsUi();
  }

  // Pin an effect instance by reference (room/occurrence/system), the same
  // idiom as pinByRef for placements: used by the effectsApi test hook and
  // available to any future non-pointer entry point.
  function pinEffectByRef(ref: { room: number | string; occurrence: number | string; system: number | string }): boolean {
    if (destroyed || !ref || !effectsLayer) return false;
    const key = effectInstanceKey(ref.room, ref.occurrence, ref.system);
    if (!effectsLayer.instanceInfo(key)) return false;
    showEffectInspection(key, true);
    return true;
  }

  // Pin a placement by reference (not a screen ray): the test hook path AND how
  // a click on a parked variant overlay re-pins its (statics-hidden) model.
  async function pinByRef(ref: any): Promise<boolean> {
    if (destroyed || !ref) return false;
    const token = ++pickToken;
    if (mergedActive()) {
      if (!pickIndex?.ready) return false;
      const entryIndex = pickIndex.find(ref);
      if (entryIndex < 0) return false;
      const entryRef = pickIndex.ref(entryIndex);
      let geometry = null;
      try { geometry = await world._meshGeometry(entryRef.mesh, entryRef.reflect); } catch { return false; }
      if (destroyed || token !== pickToken) return false;
      await showIndexInspection({ entryIndex, ref: entryRef, geometry }, true, token);
      return inspectPinned;
    }
    const room = world.rooms.get(Number(ref.room));
    if (!room) return false;
    for (const mesh of room.meshes) {
      const exact = mesh.userData.exact;
      if (!exact || exact.category !== ref.category || exact.sourceKind !== ref.sourceKind) continue;
      const instanceId = (exact.placementIndices || []).indexOf(Number(ref.placementIndex));
      if (instanceId < 0) continue;
      showInspection({ object: mesh, instanceId }, true);
      return inspectPinned;
    }
    return false;
  }

  // "Show in world" handoff (model-rooms.ts): open with that model pinned in
  // inspect mode and the camera on it.
  function revealModel(): void {
    let ask: any = null;
    try { ask = JSON.parse(sessionStorage.getItem(REVEAL_KEY) || 'null'); sessionStorage.removeItem(REVEAL_KEY); } catch { return; }
    if (!ask?.ref || !world.rooms.has(Number(ask.ref.room))) return;
    setInspect(true);
    pinByRef(ask.ref).then((pinned) => {
      if (!pinned || destroyed || !highlight?.parent) return;
      highlight.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(highlight);
      const centre = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      focusExtent(centre.x, centre.z, Math.max(size.x, size.y, size.z) * 3);
      scene3d.controls.target.y = centre.y;
      scene3d.controls.update();
    }).catch(() => { /* the room is open either way */ });
  }

  function showInspection(hit: any, pinned: boolean): void {
    const info = world.describeInstance(hit.object, hit.instanceId);
    if (!info) { clearInspection(true); return; }
    // Hovering a different PART of the model already outlined leaves the whole-
    // model highlight in place: no clear + async rebuild, so it can't flicker.
    if (!pinned) {
      const mk = modelKeyOf(info);
      if (mk && mk === hoverModelKey && highlight?.parent) {
        showReadout(info, false);
        renderer.domElement.style.cursor = 'crosshair';
        return;
      }
      hoverModelKey = mk;
    }
    // Re-pinning a DIFFERENT model PARKS the previous model's variant so it
    // persists (drawn) rather than reverting; syncVariantOverlay re-adopts the
    // new model's parked variant, if any.
    if (pinned && pinnedCtx && modelKeyOf(pinnedCtx.info) !== modelKeyOf(info)) {
      parkVariantOverlay();
    }
    // See the identical note in showIndexInspection: the two pin kinds share
    // one readout and are mutually exclusive.
    if (pinned && effectPinned) clearEffectInspection(true);
    inspectPinned = !!pinned;
    pinnedCtx = pinned
      ? { mode: 'graph', object: hit.object, instanceId: hit.instanceId, info, group: null }
      : null;
    clearGroupHighlights();
    if (pinned) attachModelGroup(pickToken).catch(() => {});
    else showHoverGroup({ mode: 'graph', object: hit.object, instanceId: hit.instanceId, info }, `${hit.object.uuid}:${hit.instanceId}`).catch(() => {});
    const key = `${hit.object.uuid}:${hit.instanceId}`;
    if (key !== inspectedKey) {
      inspectedKey = key;
      if (!highlight) {
        highlight = new THREE.Mesh(hit.object.geometry, highlightMaterial);
        highlight.matrixAutoUpdate = false;
        highlight.frustumCulled = false;
        highlight.renderOrder = 1000;
      } else {
        highlight.removeFromParent();
        highlight.geometry = hit.object.geometry;
      }
      hit.object.getMatrixAt(hit.instanceId, highlight.matrix);
      for (let node = hit.object; node && node !== world.root; node = node.parent) {
        highlight.matrix.premultiply(node.matrix);
      }
      highlight.matrixWorldNeedsUpdate = true;
      highlightRoot.add(highlight);
    }
    if (pinned) {
      hit.object.getMatrixAt(hit.instanceId, editScratch);
      showPreviewMesh(hit.object.geometry, hit.object.material, editScratch);
    }
    showReadout(info, inspectPinned);
    if (pinned) syncSpawnAnim();
    renderer.domElement.style.cursor = 'crosshair';
  }

  function clearInspection(force = false): void {
    // The readout pane is SHARED with the effect pin, so an unforced clear
    // must stand down while EITHER pin owns it, not just this one: otherwise
    // merely moving the pointer off the canvas (towards that very pane, to
    // reach its controls) fires onPointerLeave -> clearInspection() and wipes
    // a pinned effect's readout. Forced clears still release, which is how
    // the two pins stay mutually exclusive.
    if (!force && (inspectPinned || effectPinned)) return;
    inspectPoint = null;
    inspectPinned = false;
    inspectedKey = '';
    hoverModelKey = null;
    pinnedCtx = null;
    parkVariantOverlay();   // an applied variant persists past unpin (like the anim)
    clearGroupHighlights();
    parkSpawnAnim();   // a playing/posed anim persists past unpin
    hidePreview();
    highlight?.removeFromParent();
    readout.hidden = true;
    readout.classList.remove('pinned');
    clear(readout);
    renderer.domElement.style.cursor = '';
  }

  function inspectAtPendingPoint(): void {
    inspectFrame = 0;
    const point = inspectPoint;
    inspectPoint = null;
    if (!point || !state.inspect) { clearInspection(); clearEffectInspection(); return; }
    // Effect proxies are checked first and uniformly across both view modes
    // (see pickEffectProxy): a hit here shows the hover readout and stops,
    // same precedence pickVariantOverlay gets in onPointerUp below.
    const fxHit = pickEffectProxy(point[0], point[1]);
    if (fxHit) { showEffectInspection(fxHit.key, false); return; }
    clearEffectInspection();   // moved off a proxy: drop the effect hover (no-op while nothing is pinned, which is guaranteed here -- see onPointerMove's gate)
    if (mergedActive()) {
      const token = ++pickToken;
      (async () => {
        const hit = await resolveIndexPick(point[0], point[1], token);
        if (hit === undefined || destroyed || token !== pickToken
            || !state.inspect || inspectPinned) return;
        if (hit) await showIndexInspection(hit, false, token);
        else clearInspection();
      })().catch(() => { /* pick is best-effort */ });
      return;
    }
    const hit = pickInstance(point[0], point[1]);
    if (hit) showInspection(hit, false);
    else clearInspection();
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!state.inspect || inspectPinned || effectPinned || event.buttons) {
      if (event.buttons) { clearInspection(); clearEffectInspection(); }
      return;
    }
    inspectPoint = [event.clientX, event.clientY];
    if (!inspectFrame) inspectFrame = requestAnimationFrame(inspectAtPendingPoint);
  };
  const onPointerLeave = () => { clearInspection(); clearEffectInspection(); };
  const onPointerDown = (event: PointerEvent) => {
    if (!inspectPinned && !effectPinned) { clearInspection(); clearEffectInspection(); }
    if (event.button === 0) pointerDown = [event.clientX, event.clientY];
  };
  // Click-without-drag picks (the movement threshold keeps the fly camera's
  // drag-look fully available while Inspect is on).
  const onPointerUp = (event: PointerEvent) => {
    if (!pointerDown || Math.hypot(event.clientX - pointerDown[0], event.clientY - pointerDown[1]) > 4) {
      pointerDown = null;
      return;
    }
    pointerDown = null;
    if (!state.inspect) return;
    // A variant overlay (active OR parked) stands in for hidden statics, so it
    // must be pickable: otherwise a click on the recoloured model rays through
    // to the floor. Clicking the pinned model's own overlay unpins it (parks
    // the variant); clicking a parked model's overlay re-pins that model so it
    // stays interactive (change/revert its variant, read its detail).
    const hitOverlay = pickVariantOverlay(event.clientX, event.clientY);
    if (hitOverlay) {
      if (hitOverlay === variantOverlay) clearInspection(true);
      else pinByRef(hitOverlay.pinRef).catch(() => { /* best-effort */ });
      return;
    }
    // Effect proxies next: clicking the pinned instance's own proxy unpins
    // it, clicking a different one re-pins (both cases release any pinned
    // placement first, inside showEffectInspection).
    const fxHit = pickEffectProxy(event.clientX, event.clientY);
    if (fxHit) {
      if (effectPinned && fxHit.key === effectPinned.key) clearEffectInspection(true);
      else showEffectInspection(fxHit.key, true);
      return;
    }
    if (mergedActive()) {
      const token = ++pickToken;
      (async () => {
        const hit = await resolveIndexPick(event.clientX, event.clientY, token);
        if (hit === undefined || destroyed || token !== pickToken || !state.inspect) return;
        if (!hit) {
          if (inspectPinned) clearInspection(true);
          if (effectPinned) clearEffectInspection(true);
          return;
        }
        if (inspectPinned && `pick:${hit.entryIndex}` === inspectedKey) {
          clearInspection(true);
          return;
        }
        await showIndexInspection(hit, true, token);
      })().catch(() => { /* pick is best-effort */ });
      return;
    }
    const hit = pickInstance(event.clientX, event.clientY);
    if (hit) {
      if (inspectPinned && `${hit.object.uuid}:${hit.instanceId}` === inspectedKey) clearInspection(true);
      else showInspection(hit, true);
    } else if (inspectPinned) {
      clearInspection(true);
    } else if (effectPinned) {
      clearEffectInspection(true);
    }
  };
  // Delete key deletes the pinned placement (both views).
  const onInspectKeyDown = (event: KeyboardEvent) => {
    if (event.code !== 'Delete' || !state.inspect || !pinnedCtx) return;
    const target = event.target as any;
    if (target && (target.isContentEditable
        || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''))) return;
    event.preventDefault();
    deletePinned();
  };
  // While Inspect is ON in all-rooms, double-click must NOT toggle the fly
  // camera's pointer-lock mouselook (it would swallow the pick clicks). A
  // window-level capture listener runs before the fly controls' own
  // target-phase dblclick handler.
  const onDblClickCapture = (event: MouseEvent) => {
    if (state.inspect && event.target === renderer.domElement) {
      event.stopPropagation();
    }
  };
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onInspectKeyDown);
  window.addEventListener('dblclick', onDblClickCapture, { capture: true });

  // --- camera ---------------------------------------------------------------------
  // all mode: { frames: Map(id -> {x,y,w,h}), ox, oz, span }
  let worldFrame: {
    frames: Map<number, { x: number; y: number; w: number; h: number; detached?: boolean }>;
    ox: number; oz: number; span: number;
  } | null = null;

  // Framing: distance from the room footprint, the camera SW of and above the
  // target, near plane 0.05 for close inspection. Fit floor 4 tiles so tiny
  // rooms don't over-zoom.
  function focusExtent(cx: number, cz: number, extent: number): void {
    const distance = Math.max(extent, 4) * 1.35;
    scene3d.controls.target.set(cx, 1.5, cz);
    scene3d.camera.position.set(cx - distance * 0.72, distance * 0.86, cz + distance * 0.72);
    scene3d.camera.near = 0.05;
    scene3d.camera.far = Math.max(3000, distance * 30);
    scene3d.camera.updateProjectionMatrix();
    // dolly-out cap at the world span; a lone room uses its own frame so
    // zooming out never runs past the far plane / fog.
    scene3d.controls.maxDistance = worldFrame
      ? worldFrame.span * 2.4
      : distance * 20;
    scene3d.controls.update();
    if (fly) {
      fly.lookAt(scene3d.controls.target);
      // crossing a lone room at base speed takes ~8s (Shift/Tab modulate);
      // the all-rooms stitch sets its own span-scaled speed after placement
      if (!worldFrame) fly.moveSpeed = Math.max(4, extent / 8);
    }
    sunTarget.position.set(cx, 0, cz);
    sun.position.set(cx + 60, 100, cz + 40);
    worldFog.near = distance * 6;
    worldFog.far = distance * 16;
    updateSunShadow();
  }
  function focusRoom(meta: any): void {
    const w = Number(meta?.map_size?.[0] ?? meta?.size?.[0]) || 8;
    const h = Number(meta?.map_size?.[1] ?? meta?.size?.[1]) || 8;
    focusExtent(w / 2, h / 2, Math.max(w, h));
  }
  // Overhead-south framing of the whole stitch, turned into the fly camera's
  // starting pose (yaw/pitch derived from the same look).
  function focusWorld(): void {
    if (!worldFrame) return;
    const span = worldFrame.span;
    scene3d.controls.target.set(0, 0, 0);
    // start well inside the world rather than framing the whole span: the
    // fly camera makes pulling back trivial, and the close-up reads instantly
    scene3d.camera.position.set(0, span * 0.15, span * 0.16);
    scene3d.camera.near = 0.5;
    scene3d.camera.far = Math.max(3000, span * 6);
    scene3d.camera.updateProjectionMatrix();
    scene3d.controls.maxDistance = span * 2.4;
    if (fly) fly.lookAt(scene3d.controls.target);
    else scene3d.controls.update();
    sunTarget.position.set(0, 0, 0);
    sun.position.set(60, 100, 40);
    worldFog.near = span * 0.55;
    worldFog.far = span * 2.4;
    updateSunShadow();
  }
  focusBtn.addEventListener('click', () => {
    if (entry) focusRoom(world.roomMeta(entry.i) || entry);
    else focusWorld();
  });

  // World positions from the index, with a separate display grid for rooms
  // outside the connected layout, even when they have stored coordinates.
  function buildWorldFrames(rooms: any[]): NonNullable<typeof worldFrame> {
    const frames = new Map<number, { x: number; y: number; w: number; h: number; detached?: boolean }>();
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const detached = [];
    for (const room of rooms) {
      const w = Number(room.map_size?.[0] ?? room.size?.[0]) || 8;
      const h = Number(room.map_size?.[1] ?? room.size?.[1]) || 8;
      if (Number.isFinite(room.world?.x) && Number.isFinite(room.world?.y)) {
        frames.set(Number(room.id), { x: Number(room.world.x), y: Number(room.world.y), w, h });
        minX = Math.min(minX, room.world.x);
        minY = Math.min(minY, room.world.y);
        maxX = Math.max(maxX, room.world.x + w);
        maxY = Math.max(maxY, room.world.y + h);
      } else {
        detached.push({ id: Number(room.id), w, h });
      }
    }
    if (!frames.size) { minX = 0; minY = 0; maxX = 64; maxY = 64; }
    if (detached.length) {
      const cellW = Math.max(...detached.map((r) => r.w)) + 6;
      const cellH = Math.max(...detached.map((r) => r.h)) + 6;
      const columns = Math.max(1, Math.ceil(Math.sqrt(detached.length)));
      detached.forEach((room, index) => {
        frames.set(room.id, {
          x: maxX + 8 + (index % columns) * cellW,
          y: minY + Math.floor(index / columns) * cellH,
          w: room.w, h: room.h, detached: true,
        });
      });
      maxX += 8 + columns * cellW;
    }
    return {
      frames,
      ox: -(minX + maxX) / 2,
      oz: -(minY + maxY) / 2,
      span: Math.max(maxX - minX, maxY - minY),
    };
  }

  // --- room-name sprites (all-rooms) -----------------------------------------
  // Depth-test-off text sprites at each room's stitched position. Built once
  // after the index resolves, toggled purely by group visibility, released on
  // destroy.
  let namesGroup: any = null;
  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // Text sprite factory shared by room names and NPC-spawn names. The defaults
  // ARE the room-name look (fontSize 34, scale 0.03, light text): spawn labels
  // pass smaller values and the category tint, so room names stay byte-identical.
  function labelSprite(text: string, {
    fontSize = 34, scale = 0.03, color = '#eef2f7',
  }: { fontSize?: number; scale?: number; color?: string } = {}): THREE.Sprite {
    const pad = 10;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
    canvas.height = fontSize + pad * 2;
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;   // reset by the resize
    ctx.fillStyle = 'rgba(10,12,16,.72)';
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 8);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, canvas.height / 2 + 1);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      // fog off: labels are UI text (already depth-test-off). Distance fog
      // would wash far room names into the background colour
      map: texture, depthTest: false, transparent: true, fog: false,
    }));
    sprite.renderOrder = 999;   // painted after all scenery, never covered
    sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
    return sprite;
  }
  function buildNameSprites(): void {
    if (!allMode || !worldFrame || namesGroup || destroyed) return;
    namesGroup = new THREE.Group();
    namesGroup.name = 'world-room-names';
    namesGroup.visible = !!state.names;
    for (const room of world.index?.rooms || []) {
      const frame = worldFrame.frames.get(Number(room.id));
      const name = room.name ? String(room.name) : '';
      if (!frame || !name) continue;
      const sprite = labelSprite(name);
      // displayRoot space is three Y-up tiles: (x, height, z)
      sprite.position.set(
        frame.x + worldFrame.ox + frame.w / 2,
        3.2,
        frame.y + worldFrame.oz + frame.h / 2,
      );
      sprite.matrixAutoUpdate = false;   // static label: compose once
      sprite.updateMatrix();
      namesGroup.add(sprite);
    }
    namesGroup.matrixAutoUpdate = false;
    namesGroup.updateMatrix();
    displayRoot.add(namesGroup);
  }
  function applyNames(): void {
    if (namesGroup) namesGroup.visible = !!state.names;
  }

  // --- NPC-spawn name sprites (both views) -----------------------------------
  // A smaller depth-test-off label floating just above every NAMED spawn. Built
  // once when the rooms' shards are in hand (single room: the one loaded room;
  // all-rooms: every streamed room, before the merged bake releases graphs),
  // toggled purely by group visibility, released on destroy.
  //
  // Positioning is correct BY CONSTRUCTION: it reuses the exact matrix the
  // spawn's own mesh is placed with (see the wire/empty overlay bake, which
  // stamps the same recipe for spawn parts):
  //   * world._spawnMatrix(shard, partRow, m): the room-local raw matrix the
  //     renderer bakes every spawn instance with (tile-centre + facing).
  //   * spawnRoomOffset(roomId): the same raw-space room offset the overlay
  //     bake and the spawn-anim composite add (room.group.position, or the
  //     world-frame stitch once merged mode has released the graph).
  //   * world.root.matrix maps that raw point into displayRoot-local space
  //     (world.root is a direct child of displayRoot, sibling of namesGroup /
  //     spawnAnimRoot, so its LOCAL matrix is the raw->display transform,
  //     rotateX(-90°) + scale, incl. the roomYSign Y-flip). No hand axis math.
  // describeShardPlacement still supplies the label + per-spawn dedupe.
  const SPAWN_LABEL_HEIGHT = 1.6;   // displayRoot Y lift, below the 3.2 room band
  let spawnNamesGroup: any = null;
  function buildSpawnNameSprites(): void {
    if (spawnNamesGroup || destroyed) return;
    spawnNamesGroup = new THREE.Group();
    spawnNamesGroup.name = 'world-spawn-names';
    spawnNamesGroup.visible = !!state.spawnnames;
    world.root.updateMatrix();   // frozen root: ensure its local matrix is current
    const rawMatrix = new THREE.Matrix4();
    // The rooms the current view renders: the single loaded room, or every
    // streamed room (all-rooms builds this before the merged graph release).
    const roomIds = entry ? [Number(entry.i)] : [...world.rooms.keys()];
    for (const roomId of roomIds) {
      const shard = world.rooms.get(Number(roomId))?.shard;
      if (!shard) continue;
      const [offX, offY] = spawnRoomOffset(roomId);
      const seen = new Set<number>();
      const parts = shard.spawn_parts || [];
      for (let row = 0; row < parts.length; row++) {
        const info = world.describeShardPlacement(roomId, shard, 'spawn', 'spawns', row);
        if (!info) continue;
        const spawnIndex = Number(info.spawnIndex);
        if (seen.has(spawnIndex)) continue;   // one label per spawn (first part)
        seen.add(spawnIndex);
        const name = info.label ? String(info.label).trim() : '';
        if (!name || name === 'unlabelled entity') continue;   // skip placeholders
        // Same matrix the spawn mesh is baked with; every part of a spawn shares
        // the spawn's tile, so the first-seen part positions the one label.
        try { world._spawnMatrix(shard, parts[row], rawMatrix); } catch { continue; }
        const p = new THREE.Vector3().setFromMatrixPosition(rawMatrix);
        p.x += offX;   // room-local -> raw world, exactly as the overlay bake
        p.y += offY;
        p.applyMatrix4(world.root.matrix);   // raw world -> displayRoot-local
        const sprite = labelSprite(name, { fontSize: 22, scale: 0.017, color: '#f0b49c' });
        sprite.position.set(p.x, p.y + SPAWN_LABEL_HEIGHT, p.z);
        sprite.matrixAutoUpdate = false;   // static label: compose once
        sprite.updateMatrix();
        spawnNamesGroup.add(sprite);
      }
    }
    spawnNamesGroup.matrixAutoUpdate = false;
    spawnNamesGroup.updateMatrix();
    displayRoot.add(spawnNamesGroup);
  }
  function applySpawnNames(): void {
    if (spawnNamesGroup) spawnNamesGroup.visible = !!state.spawnnames;
  }
  function disposeSpawnNameSprites(): void {
    if (!spawnNamesGroup) return;
    for (const sprite of spawnNamesGroup.children) {
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    spawnNamesGroup.removeFromParent();
    spawnNamesGroup.clear();
    spawnNamesGroup = null;
  }

  // --- a room's neighbouring rooms ---------------------------------------------
  // The rooms directly through the room's doors (the world index's door
  // links), as the game loads them, at their stitched places around it. They draw like the room (in the game's frame
  // too, after it, under its vignette), and the room's floor is laid as the
  // game lays it with neighbours: theirs removes it under their ground and
  // shows their darker sea beds.
  const neighbourOffsets = new Map<number, { x: number; y: number }>();
  let neighbourSync: Promise<void> = Promise.resolve();
  let gameSetup: Promise<void> = Promise.resolve();
  function wantedNeighbours(): number[] {
    neighbourOffsets.clear();
    if (allMode || !entry || !state.neighbours) return [];
    const out = doorNeighbours(world.index, Number(entry.i));
    for (const n of out) neighbourOffsets.set(n.id, { x: n.x, y: n.y });
    return out.map((n) => n.id);
  }
  function applyNeighbours(): void {
    neighbourFadeCheck.hidden = !state.neighbours;
    neighbourSync = neighbourSync.then(syncNeighbours).catch((error) => console.warn('neighbouring rooms unavailable', error));
  }
  async function syncNeighbours(): Promise<void> {
    if (allMode || destroyed || !entry) return;
    const home = world.rooms.get(Number(entry.i));
    if (!home) return;
    const want = wantedNeighbours();
    world.setNeighbours(want);
    for (const room of [...world.rooms.values()]) {
      if (room.id !== home.id && !want.includes(room.id)) world.unloadRoom(room.id);
    }
    const missing = want.filter((id) => !world.rooms.has(id));
    if (missing.length) {
      hud.setStage(`loading neighbours 0/${missing.length}`);
      await world.loadRooms(missing, {
        concurrency: 3,
        onProgress: (progress: any) => { if (!destroyed) hud.setStage(`loading neighbours ${progress.completed}/${progress.total}`); },
      }).catch((error: any) => console.warn('some neighbouring rooms failed to load', error));
      if (destroyed) return;
    }
    applyCategories();
    applyToggles();
    await world.refreshGroundPlane(home.id);
    await gameSetup;
    if (gameFrame && !destroyed) {
      gameBuilds++;
      try {
        await gameFrame.setRoom(await world.gameRoomSource(home, world.neighbourRooms()));
      } catch (error) {
        console.warn('game shading: neighbouring rooms skipped', error);
      } finally {
        renderer.resetState();
        gameBuilds--;
      }
    }
    if (destroyed) return;
    buildZUI();
    hud.setStage(`ready · ${world.rooms.size === 1 ? `${home.meshes.length} batches` : `${world.rooms.size} rooms`}`, { steady: true });
    syncStatus();
  }

  // --- the game's ground plane over the whole world (all-rooms) --------------
  // One floor for every room at its stitched place: each tile goes to the
  // room whose floor reaches it first, so where episodes meet the floor
  // changes between their rooms (world/ground-plane). The field is worked
  // out once every room has streamed in, before the merged bake releases
  // their shards; the meshes hold the floor out to the distance's step (ten,
  // twenty, thirty, forty tiles, endless) and draw the pieces the distance
  // floors, so a shorter distance never rebuilds and a longer one rebuilds
  // once per step.
  let worldPlane: THREE.Group | null = null;
  let worldPlaneField: PlaneField | null = null;
  let worldPlaneExtent = 0;
  /** The room of each source of the world's floor field (its index). */
  let worldPlaneSourceIds: number[] = [];
  let worldPlaneBuild = 0;
  let worldPlaneTimer: ReturnType<typeof setTimeout> | null = null;
  const worldPlaneMaterials = new Map<string, THREE.MeshStandardMaterial>();
  const worldPlaneUniforms = planeUniforms(new THREE.Color(0, 0, 0));
  const planeStep = (distance: number) => (distance === Infinity ? Infinity
    : Math.min(PLANE_FIELD_REACH, Math.max(PLANE_GAME_DISTANCE, Math.ceil(distance / 10) * 10)));
  async function buildWorldGroundPlane(): Promise<void> {
    if (!allMode || !worldFrame || worldPlaneField || destroyed) return;
    const sources: PlaneSource[] = [];
    worldPlaneSourceIds = [];
    for (const room of world.rooms.values()) {
      const frame = worldFrame.frames.get(Number(room.id));
      // rooms outside the connected layout sit on a display grid: no floor
      if (!frame || frame.detached || !room.shard?.ground_plane) continue;
      sources.push({ shard: room.shard, offset: [frame.x + worldFrame.ox, frame.y + worldFrame.oz] });
      worldPlaneSourceIds.push(Number(room.id));
    }
    worldPlaneField = planeField(sources, { tileUnits: world.tileUnits });
    if (!worldPlaneField || destroyed) return;
    // its own root, the world root's frame (merged rendering detaches that)
    const group = new THREE.Group();
    group.name = 'world-ground-plane';
    group.rotation.copy(world.root.rotation);
    group.scale.copy(world.root.scale);
    group.position.copy(world.root.position);
    worldPlane = group;
    displayRoot.add(group);
    if ((scene3d.scene.background as any)?.isColor) {
      worldPlaneUniforms.planeFadeColour.value.copy((scene3d.scene.background as THREE.Color).clone().convertLinearToSRGB());
    }
    await rebuildWorldGroundPlane(planeStep(groundDistance()));
  }
  /** Lay the floor out to `extent` tiles (Infinity: endless, out past the fog). */
  async function rebuildWorldGroundPlane(extent: number): Promise<void> {
    if (!worldPlane || !worldPlaneField || destroyed) return;
    const build = ++worldPlaneBuild;
    const far = Math.max(512, Math.ceil((worldFrame?.span ?? 0) * 4));
    const meshes = planeMeshes(worldPlaneField, extent, far);
    const built: THREE.Mesh[] = [];
    for (const { record, geometry, covers } of meshes) {
      const key = `${record.material}:${record.texture}`;
      let material = worldPlaneMaterials.get(key);
      if (!material) {
        const map = record.texture >= 0 ? (await world.textureSet(record.texture).catch(() => null))?.map ?? null : null;
        material = worldPlaneMaterials.get(key) ?? planeMaterial(map, worldPlaneUniforms);
        worldPlaneMaterials.set(key, material);
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `world-ground-plane-m${record.material}-t${record.texture}`;
      mesh.userData.planeCovers = covers;
      mesh.receiveShadow = true;
      built.push(mesh);
    }
    if (build !== worldPlaneBuild || destroyed || !worldPlane) {
      for (const mesh of built) mesh.geometry.dispose();
      return;
    }
    for (const mesh of [...worldPlane.children] as THREE.Mesh[]) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    for (const mesh of built) worldPlane.add(mesh);
    worldPlaneExtent = extent;
    applyWorldGroundPlane();
  }
  function applyWorldGroundPlane(): void {
    if (!worldPlane) return;
    const distance = groundDistance();
    worldPlane.visible = !!state.ground;
    setPlaneReach(worldPlaneUniforms, distance);
    for (const mesh of worldPlane.children as THREE.Mesh[]) showPlaneMesh(mesh, distance);
    // further than the meshes hold: lay the next step once the slider rests
    const step = planeStep(distance);
    if (state.ground && step > worldPlaneExtent) {
      if (worldPlaneTimer) clearTimeout(worldPlaneTimer);
      worldPlaneTimer = setTimeout(() => {
        worldPlaneTimer = null;
        const now = planeStep(groundDistance());
        if (now > worldPlaneExtent) {
          rebuildWorldGroundPlane(now).catch((error) => console.warn('world ground plane unavailable', error));
        }
      }, 120);
    }
  }
  /** Test readback: the floor's meshes, the pieces the distance draws and all they hold. */
  function groundPlaneInfo(): { meshes: number; tiles: number; pieces: number; distance: number | null; extent: number | null } | null {
    const meshes = allMode ? (worldPlane?.children ?? []) as THREE.Mesh[]
      : [...world.rooms.values()].flatMap((room: any) => (room.groundPlane?.children ?? []) as THREE.Mesh[]);
    if (!meshes.length) return null;
    const distance = groundDistance();
    const covers = meshes.map((mesh) => mesh.userData.planeCovers as Float32Array);
    return {
      meshes: meshes.length,
      tiles: covers.reduce((n, c) => n + planeCount(c, distance), 0),
      pieces: covers.reduce((n, c) => n + c.length, 0),
      distance: Number.isFinite(distance) ? distance : null,
      extent: allMode ? (Number.isFinite(worldPlaneExtent) ? worldPlaneExtent : null) : null,
    };
  }
  function disposeWorldGroundPlane(): void {
    if (worldPlaneTimer) clearTimeout(worldPlaneTimer);
    worldPlaneTimer = null;
    worldPlaneBuild++;
    worldPlaneField = null;
    for (const material of worldPlaneMaterials.values()) material.dispose();
    worldPlaneMaterials.clear();
    if (!worldPlane) return;
    worldPlane.removeFromParent();
    for (const mesh of worldPlane.children as THREE.Mesh[]) mesh.geometry.dispose();
    worldPlane = null;
  }

  // --- high-res viewport screenshot (single room + all-rooms) ------------------
  // Re-renders the CURRENT camera framing at the selected long-edge target
  // (4K..32K) by tiling camera.setViewOffset renders. Tiles are stitched one
  // ROW at a time into a strip canvas (full width, one tile tall) whose pixels
  // stream through fflate's zlib as PNG scanlines: no full-frame canvas or
  // pixel buffer ever exists, which is what makes 16K/32K possible (Chrome
  // caps canvas area around 268 MP). The camera pose is cloned first, so the
  // capture stays coherent even if the fly camera moves while tiles render.
  // Tiled high-res PNG of the current framing (shared with mesh/rig/model).
  const captureHighRes = (resKey: string, onProgress: (msg: string) => void, transparent = false) =>
    captureTiledPng(scene3d, resKey, `brighter-atlas-${entry ? `room-${entry.i}` : 'world'}`, onProgress, () => !destroyed, transparent);

  function disposeNameSprites(): void {
    if (!namesGroup) return;
    for (const sprite of namesGroup.children) {
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    namesGroup.removeFromParent();
    namesGroup.clear();
    namesGroup = null;
  }

  // --- standalone collision / authored-empty wireframes (merged all-rooms) ----
  // Under merged rendering the per-room graph (and its collision/empty
  // objects) is released, so these render from the shard data directly: one
  // instanced wireframe box batch for every collision extent world-wide, and
  // one instanced batch per (category, mesh, z) for the rare authored-empty
  // placements. Built lazily on first enable, kept across toggles, disposed
  // with the view.
  let wire: any = null;
  let wirePromise: Promise<any> | null = null;
  const wireActive = () => allMode && mergedActive();
  async function ensureWireOverlays(): Promise<any> {
    if (wire || !allMode || !worldFrame || destroyed) return wire;
    if (wirePromise) return wirePromise;
    wirePromise = (async () => {
      const cc = world.collisionColumns;
      const oc = world.occurrenceColumns;
      const pc = world.placementColumns;
      const spc = world.spawnPartColumns;
      const ssc = world.spawnColumns;
      const emptyFlag = world.flags.authoredEmpty;
      const tileUnits = world.tileUnits;
      const layerUnits = world.layerUnits;
      const collisionMatrices: THREE.Matrix4[] = [];
      // category|mesh|reflect|z -> matrices
      const emptyBatches = new Map<string, { category: string; mesh: number; reflect: boolean; z: number; matrices: THREE.Matrix4[] }>();
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const addEmpty = (category: string, mesh: any, reflect: boolean, z: number) => {
        const key = `${category}|${mesh}|${reflect ? 1 : 0}|${z}`;
        let batch = emptyBatches.get(key);
        if (!batch) {
          batch = { category, mesh: Number(mesh), reflect, z: Number(z), matrices: [] };
          emptyBatches.set(key, batch);
        }
        batch.matrices.push(matrix.clone());
      };
      // batched reads (32 shards per IDB transaction) instead of ~451 serial
      // per-room gets: bounded, so the overlay build never holds more than
      // one batch of undelivered shards; misses fall back to per-room fetch
      const overlayMetas = (world.index?.rooms || []).filter(
        (meta: any) => worldFrame!.frames.has(Number(meta.id)));
      let sliceStart = performance.now();
      let bulkShards: Map<number, any> | null = null;
      let batchEnd = 0;
      for (let mi = 0; mi < overlayMetas.length; mi++) {
        const meta = overlayMetas[mi];
        if (destroyed) return null;
        const frame = worldFrame!.frames.get(Number(meta.id));
        if (!frame) continue;   // filtered above; keeps the type narrow
        if (mi >= batchEnd && app.store.worldRooms) {
          batchEnd = Math.min(mi + 32, overlayMetas.length);
          try {
            bulkShards = await app.store.worldRooms(
              overlayMetas.slice(mi, batchEnd).map((m: any) => m.id));
          } catch { bulkShards = null; }
        }
        let shard = bulkShards?.get(Number(meta.id)) || null;
        if (shard) bulkShards!.delete(Number(meta.id));
        else {
          try { shard = await app.store.worldRoom(meta.id); } catch { /* skip room */ }
        }
        if (!shard) continue;
        const offX = (frame.x + worldFrame!.ox) * tileUnits;
        const offY = (frame.y + worldFrame!.oz) * tileUnits;
        for (const row of shard.collision || []) {
          const width = Number(row[cc.width!]) || 0;
          const height = Number(row[cc.height!]) || 0;
          const zMin = Number(row[cc.z_min!]) || 0;
          const zMax = Number(row[cc.z_max!]) || 0;
          if (width <= 0 || height <= 0 || zMax <= zMin) continue;
          position.set(
            offX + ((Number(row[cc.x!]) || 0) + width / 2) * tileUnits,
            offY + ((Number(row[cc.y!]) || 0) + height / 2) * tileUnits,
            ((zMin + zMax) / 2) * layerUnits,
          );
          scale.set(width * tileUnits, height * tileUnits, (zMax - zMin) * layerUnits);
          collisionMatrices.push(new THREE.Matrix4().compose(position, rotation, scale));
        }
        for (const category of ['terrain', 'models', 'components']) {
          const rows = shard.placements?.[category] || [];
          for (const row of rows) {
            if (!((row[pc.flags!] | 0) & emptyFlag)) continue;
            const occurrence = shard.occurrences?.[row[pc.occurrence!]];
            if (!occurrence) continue;
            const reflect = world._placementReflectLocalX(shard, row);
            try { world._placementMatrix(shard, row, matrix, reflect); } catch { continue; }
            matrix.elements[12] += offX;
            matrix.elements[13] += offY;
            addEmpty(category, row[pc.mesh!], reflect, Number(occurrence[oc.z!]) || 0);
          }
        }
        if (spc && ssc) {
          for (const row of shard.spawn_parts || []) {
            if (!((row[spc.flags!] | 0) & emptyFlag)) continue;
            const spawn = shard.spawns?.[Number(row[spc.spawn!])];
            if (!spawn) continue;
            try { world._spawnMatrix(shard, row, matrix); } catch { continue; }
            matrix.elements[12] += offX;
            matrix.elements[13] += offY;
            addEmpty('spawns', row[spc.mesh!], false, Number(spawn[ssc.z!]) || 0);
          }
        }
        if (performance.now() - sliceStart > 15) {
          await yieldToBrowser();
          if (destroyed) return null;
          sliceStart = performance.now();
        }
      }

      const wireRoot = new THREE.Group();
      wireRoot.name = 'world-wire-overlays';
      wireRoot.rotation.copy(world.root.rotation);
      wireRoot.scale.copy(world.root.scale);
      const collisionGroup = new THREE.Group();
      collisionGroup.name = 'wire-collision';
      collisionGroup.visible = false;
      const emptyGroup = new THREE.Group();
      emptyGroup.name = 'wire-empty';
      emptyGroup.visible = false;
      const geometries: any[] = [];
      const materials: any[] = [];
      const instancedMeshes: any[] = [];
      let collisionMesh = null;
      if (collisionMatrices.length) {
        const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
        const boxMaterial = new THREE.MeshBasicMaterial({
          color: 0x65c9e8, wireframe: true, transparent: true,
          opacity: 0.32, depthWrite: false,
        });
        geometries.push(boxGeometry);
        materials.push(boxMaterial);
        collisionMesh = new THREE.InstancedMesh(boxGeometry, boxMaterial, collisionMatrices.length);
        collisionMesh.name = 'wire-collision-extents';
        collisionMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        for (let index = 0; index < collisionMatrices.length; index++) {
          collisionMesh.setMatrixAt(index, collisionMatrices[index]);
        }
        collisionMesh.instanceMatrix.needsUpdate = true;
        collisionMesh.computeBoundingBox();
        collisionMesh.computeBoundingSphere();
        instancedMeshes.push(collisionMesh);
        collisionGroup.add(collisionMesh);
      }
      const emptyMeshes = [];
      for (const batch of emptyBatches.values()) {
        let geometry = null;
        try {
          // clone: independent of the shared graph caches, which merged mode
          // releases: the overlay owns (and disposes) its own copies
          geometry = (await world._meshGeometry(batch.mesh, batch.reflect)).clone();
        } catch { continue; }
        if (destroyed) { geometry.dispose(); return null; }
        const material = gizmoMaterial(batch.category);
        geometries.push(geometry);
        materials.push(material);
        const instanced = new THREE.InstancedMesh(geometry, material, batch.matrices.length);
        instanced.name = `wire-empty-m${batch.mesh}-z${batch.z}`;
        instanced.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        for (let index = 0; index < batch.matrices.length; index++) {
          instanced.setMatrixAt(index, batch.matrices[index]);
        }
        instanced.instanceMatrix.needsUpdate = true;
        instanced.computeBoundingBox();
        instanced.computeBoundingSphere();
        instanced.userData.z = batch.z;
        instancedMeshes.push(instanced);
        emptyMeshes.push(instanced);
        emptyGroup.add(instanced);
      }
      wireRoot.add(collisionGroup, emptyGroup);
      wireRoot.traverse((node: any) => {   // static overlays: compose once
        node.matrixAutoUpdate = false;
        node.updateMatrix();
      });
      if (destroyed) {
        for (const mesh of instancedMeshes) mesh.dispose();
        for (const geometry of geometries) geometry.dispose();
        for (const material of materials) material.dispose();
        return null;
      }
      displayRoot.add(wireRoot);
      wire = {
        root: wireRoot,
        collisionGroup,
        collisionMesh,
        emptyGroup,
        emptyMeshes,
        dispose() {
          wireRoot.removeFromParent();
          for (const mesh of instancedMeshes) mesh.dispose();
          for (const geometry of geometries) geometry.dispose();
          for (const material of materials) material.dispose();
        },
      };
      return wire;
    })().finally(() => { wirePromise = null; });
    return wirePromise;
  }
  function applyWireOverlays(): void {
    const active = wireActive();
    if (active && (state.collision || state.empty) && !wire && !wirePromise) {
      ensureWireOverlays().then(() => {
        if (!destroyed) applyWireOverlays();
      }).catch(() => { /* overlay is best-effort */ });
    }
    if (!wire) return;
    wire.collisionGroup.visible = active && state.collision;
    const emptyOn = active && state.empty;
    wire.emptyGroup.visible = emptyOn;
    if (emptyOn) {
      for (const mesh of wire.emptyMeshes) mesh.visible = world.isZVisible(mesh.userData.z);
    }
  }

  // --- status ------------------------------------------------------------------
  function totalInstances(): number {
    let count = 0;
    for (const room of world.rooms.values()) {
      for (const mesh of room.meshes) count += mesh.count;
    }
    return count;
  }
  // (a stream of rooms loading: one status a frame, not one per room; each counts every loaded room's parts)
  let statusQueued = false;
  function syncStatusSoon(): void {
    if (statusQueued) return;
    statusQueued = true;
    requestAnimationFrame(() => { statusQueued = false; syncStatus(); });
  }
  function syncStatus(): void {
    if (destroyed) return;
    if (entry) {
      const room = world.rooms.get(Number(entry.i));
      if (!room) return;
      setStatus(`${fmtInt(totalInstances())} parts · ${fmtInt(room.meshes.length)} batches`);
    } else if (allProgress) {
      const { loaded = 0, total = 0, failed = 0 } = allProgress;
      const mergedText = mergedActive() ? ` · merged ${fmtInt(merged.stats?.meshes || 0)} batches` : '';
      // merged mode releases the per-room graph, so count the baked instances
      const parts = mergedActive() ? merged.stats?.instances || 0 : totalInstances();
      setStatus(`${loaded}/${total} rooms · ${fmtInt(parts)} parts`
        + `${failed ? ` · ${failed} failed` : ''}${mergedText}`);
    }
  }

  // --- animation tick -------------------------------------------------------------
  const removeTick = scene3d.addTick((dt: number) => {
    if (state.water) waterUniforms.waterTime.value = performance.now() / 1000;
    updateWaterSheetLights(waterUniforms, hemi, sun);
    if (gameWaterAvailable()) {
      // Water follows the effects clock (so waves and the splashes they time
      // agree, and frame-stepped captures stay in step); without effects it
      // keeps its own clock at the same tick rate.
      if (effectsLayer) waterTicks = effectsLayer.clock.t;
      else { waterClock.advance(dt || 16); waterTicks = waterClock.t; }
      world.updateGameWater(waterTicks);
      updateGameWaterLights(world.gameWater, hemi, sun, scene3d.camera, world.gameWater.uNativeFromWorld.value);
    }
    if (preview?.active && preview.spinner) {
      preview.spinner.rotation.y += (dt || 16) * 0.0009;
      preview.renderer.render(preview.scene, preview.camera);
    }
    // Advance the pinned spawn's clip (PlaybackBar self-gates on
    // sampler+playing; the shared render loop then poses the skinned mesh).
    if (spawnAnim?.bar) spawnAnim.bar.tick(dt);
    syncSpawnEffectAnimation(spawnAnim);
    for (const parked of persistentAnims.values()) {
      parked.bar?.tick(dt);
      syncSpawnEffectAnimation(parked);
    }
    // effects: advance the tick clock and refill the particle batches
    if (effectsLayer) effectsLayer.tick(dt, scene3d.camera);
    // merged all-rooms: re-rank proximity activation on a slow cadence
    // (never every frame -- ranking every candidate room's distance is cheap
    // once, but not worth paying 60 times a second)
    if (allMode && effectsLayer) {
      effectsActivationAccum += dt || 0;
      if (effectsActivationAccum >= MERGED_ACTIVATION_INTERVAL_MS) {
        effectsActivationAccum = 0;
        updateMergedEffectsActivation();
      }
    }
    if (revealQueue.length && renderer.info.render.frame !== revealFrame) {
      revealFrame = renderer.info.render.frame;   // only advance per real render
      let budget = Math.max(8, Math.ceil(revealQueue.length / 4));
      while (budget-- && revealQueue.length) {
        const room = world.rooms.get(revealQueue.shift()!);
        if (room) room.group.visible = true;
      }
    }
    hud.tick();
  });

  // --- load ------------------------------------------------------------------------
  const loadPromise = (async () => {
    if (allMode) {
      const proceed = await confirmGate;
      if (!proceed || destroyed) return;
    }
    await world.init();
    if (destroyed) return;
    waterRegistry = new WorldWaterRegistry(world.index.textures);
    highlightRoot.rotation.copy(world.root.rotation);
    highlightRoot.scale.copy(world.root.scale);
    highlightRoot.updateMatrix();   // frozen root: re-compose explicitly
    spawnAnimRoot.rotation.copy(world.root.rotation);
    spawnAnimRoot.scale.copy(world.root.scale);
    spawnAnimRoot.updateMatrix();
    effectsRoot.rotation.copy(world.root.rotation);
    effectsRoot.scale.copy(world.root.scale);
    effectsRoot.updateMatrix();
    applyLights();
    applyShadows();
    applyFlatten();
    applyWater();
    if (allMode) applyRenderScale();
    // each room's chosen progress (its parts at a stage of its story), kept per build
    loadRoomProgress();
    world.endlessFloor = groundDistance() > PLANE_FIELD_REACH;

    if (entry) {
      const meta = world.roomMeta(entry.i);
      if (!meta) throw new Error(`room ${entry.i} is not in the extracted world`);
      focusRoom(meta);
      setStatus('loading room…');
      hud.setStage('loading room…');
      // neighbours sit at their stitched places around the room
      world.getWorldRoom = (roomId: any) => ({ id: Number(roomId), ...(neighbourOffsets.get(Number(roomId)) ?? { x: 0, y: 0 }) });
      const room = await world.loadRoom(entry.i);
      if (destroyed || !room) return;
      setupProgress(room.id);
      hud.setStage(`ready · ${room.meshes.length} batches`, { steady: true });
      gameSetup = setupGameShading(room);
      if (state.neighbours) applyNeighbours();
      loadStats = {
        batches: room.meshes.length,
        instances: room.meshes.reduce((sum: number, mesh: any) => sum + mesh.count, 0),
      };
      buildZUI();
      applyCategories();
      applyToggles();
      buildSpawnNameSprites();   // single room: the one loaded shard
      syncStatus();
      // room counts into the details panel (main.js owns the base table)
      const counts = room.shard.counts || {};
      const pairs = Object.entries(counts)
        .filter(([, v]) => Number.isFinite(v) && (v as number) > 0)
        .slice(0, 12)
        .map(([k, v]) => [k.replaceAll('_', ' '), fmtInt(v as number)] as [string, string]);
      if (pairs.length) app.setDetailsExtra(el('div', {}, el('div', { class: 'details-section', text: 'extracted' }), kvTable(pairs)));
    } else {
      const rooms = world.index.rooms || [];
      if (!rooms.length) throw new Error('the extracted world has no rooms');
      worldFrame = buildWorldFrames(rooms);
      world.getWorldRoom = (roomId: any) => worldFrame!.frames.get(Number(roomId));
      world.origin = () => ({ x: worldFrame!.ox, y: worldFrame!.oz });
      // base fly speed scaled to the stitch: ×10 (Shift) crosses the span in ~12.5s
      if (fly) fly.moveSpeed = Math.max(20, worldFrame.span / 125);
      focusWorld();
      buildNameSprites();
      if (renderer.capabilities.isWebGL2) {
        pickIndex = new WorldPickIndex({ tileUnits: world.tileUnits });
        merged = new MergedWorld({
          scene: displayRoot, world, waterRegistry, waterUniforms, sheetMaterialCache,
          renderer,   // upload pacing: bound baked-but-not-uploaded cells
          pickIndex,  // per-placement CPU picking survives the graph release
          // While the loading overlay hides the canvas, uploaded cells stay
          // invisible so the bake's upload-pacing frames draw only the new
          // cells (not the whole growing world) until ready.
          uploadCurtain: () => !!overlay,
        });
      } else {
        state.merged = false;
        if (inputs.merged) {
          inputs.merged.checked = false;
          inputs.merged.disabled = true;
          inputs.merged.title = 'Merged rendering needs WebGL2';
        }
      }
      const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 8);
      allProgress = { loaded: 0, total: rooms.length, failed: 0 };
      syncStatus();
      // Bulk shard prefetch for the stream, CLIENT MODE only: one IDB getAll
      // transaction instead of ~451 gets. Entries are consumed as rooms take
      // them so the map drains with the stream; misses (or a failed bulk
      // read) fall back to the per-room fetch. HTTP mode keeps per-room
      // fetches: waiting on one Promise.all of every shard would pipeline
      // worse than the interleaved per-room requests.
      if (app.store.worldRooms && app.store.versionId) {
        // Rolling prefetch window: batches of 32 shards fetched at most two
        // batches ahead of consumption, so the stream never holds more than
        // ~96 undelivered shards (a whole-world prefetch spikes the heap by
        // hundreds of MB and crashed the tab). loadRoomsWithRetry consumes
        // roughly in order; out-of-window requests fall back per-room.
        const BATCH = 32;
        const orderedIds: number[] = rooms.map((room: any) => Number(room.id));
        const buffer = new Map<number, any>();
        const inFlight: Promise<void>[] = [];
        let nextBatch = 0;
        const pump = () => {
          while (nextBatch * BATCH < orderedIds.length
            && buffer.size + inFlight.length * BATCH < BATCH * 3) {
            const slice = orderedIds.slice(nextBatch * BATCH, (nextBatch + 1) * BATCH);
            nextBatch++;
            const p = app.store.worldRooms!(slice)
              .then((m: Map<number, any>) => { for (const [k, v] of m) buffer.set(k, v); })
              .catch(() => { /* misses fall back per-room */ })
              .finally(() => { inFlight.splice(inFlight.indexOf(p), 1); });
            inFlight.push(p);
          }
        };
        pump();
        world.shardSource = async (roomId: number) => {
          while (!buffer.has(roomId) && inFlight.length) { await Promise.race(inFlight); }
          const shard = buffer.get(roomId);
          if (shard) { buffer.delete(roomId); pump(); return shard; }
          return app.store.worldRoom(roomId);
        };
      }
      await loadRoomsWithRetry(world, rooms.map((room: any) => room.id), {
        concurrency: Math.min(12, Math.max(6, Math.floor(cores / 2))),
        retries: 2,
        retryConcurrency: 1,
        onProgress: (progress: any) => {
          if (destroyed) return;
          allProgress = progress;
          hud.setStage(`loading rooms ${progress.loaded}/${progress.total}`);
          setOverlayProgress(roomPhaseShare() * (progress.completed / Math.max(1, progress.total)));
          if (!(progress.completed % 5) || progress.completed === progress.total) syncStatus();
        },
      });
      world.shardSource = null;   // release the prefetch closure/map
      if (destroyed) return;
      // all rooms are streamed in (shards live in world.rooms): build spawn
      // labels and the ground plane now, before buildMerged() releases the
      // per-room graphs.
      buildSpawnNameSprites();
      await buildWorldGroundPlane().catch((error) => console.warn('world ground plane unavailable', error));
      if (destroyed) return;
      buildZUI();
      applyCategories();
      applyToggles();
      syncStatus();
      await buildMerged();
      if (destroyed) return;
      // Merged mode's effects activation has no per-room loaded/unloaded
      // trigger (see the guard on those events above), so it needs this one
      // explicit kick once the world is otherwise ready: lazily fetches the
      // doc (if not already requested) and, once it resolves, builds the
      // layer and runs the first proximity ranking. Deliberately placed
      // AFTER the heavy bake, not during it, so effects never compete with
      // the initial load for main-thread time behind the loading overlay.
      applyEffects();
      setReadyStage();
    }
    ready = true;
    syncStatus();
    if (!allMode) revealModel();
    else setupWorldGameShading();
  })().catch((error) => {
    if (destroyed) return;
    console.warn('world view load failed:', error);
    setStatus(error?.message || String(error), true);
    hud.setStage(error?.message || String(error), { bad: true });
    dismissOverlay();   // never leave a dead progress bar over the error
  });

  // Closing/hiding the tab mid-load must stop the stream and free GL work
  // just like in-app navigation. On a REAL unload additionally force a GL
  // context loss: JS-side dispose() calls queue buffer frees the browser may
  // never process before the content process dies, and Firefox's GPU process
  // then strands the world's buffers browser-wide (observed ~6GB retained
  // after tab close until Firefox was killed). An explicit context teardown
  // is the one signal that reclaims them. Skipped for bfcache navigations
  // (event.persisted): the page may come back and the renderer is shared.
  const onPageHide = (event: PageTransitionEvent) => {
    api.destroy();
    if (!event?.persisted) {
      try { getRenderer()?.forceContextLoss(); } catch { /* already lost */ }
    }
  };
  window.addEventListener('pagehide', onPageHide);

  // --- view object -------------------------------------------------------------
  const api: WorldViewHandle = {
    root,
    world,
    scene3d,
    state,
    hud,
    loaded: loadPromise,
    fly,                       // first-person fly camera (both views)
    stallProbe,                // rAF-gap probe (all-rooms; null in the room view)
    loadTimeline,              // stage-transition timestamps (all-rooms; empty in the room view)
    get cameraSpeed() { return fly ? fly.cameraSpeed : null; },
    set cameraSpeed(v) { if (fly && Number.isFinite(v) && v > 0) fly.cameraSpeed = v; },
    get ready() { return ready; },
    get merged() { return merged; },
    get loadStats() { return loadStats; },
    visibleInstanceCount() {
      let count = 0;
      for (const room of world.rooms.values()) {
        if (!room.group.visible) continue;
        for (const mesh of room.meshes) {
          if (mesh.visible && mesh.parent?.visible) count += mesh.count;
        }
      }
      return count;
    },
    waterInfo() {
      const curtains = [...roomWaterCurtains.values()].flat();
      const sheets = [...roomWaterSheets.values()].flat();
      return {
        curtains: curtains.length,
        curtainsHidden: curtains.filter((mesh) => !mesh.visible).length,
        sheets: sheets.length,
        sheetsVisible: sheets.filter((mesh) => mesh.visible).length,
      };
    },
    namesInfo() {
      return {
        sprites: namesGroup ? namesGroup.children.length : 0,
        visible: namesGroup ? namesGroup.visible : false,
      };
    },
    /** Sync broad-phase probe (tests/diagnostics): first index candidate. */
    pickProbe(clientX: number, clientY: number) {
      if (!mergedActive() || !pickIndex?.ready) return null;
      const candidates = indexPickCandidates(clientX, clientY);
      if (!candidates) return null;
      return candidates.length
        ? { count: candidates.length, ...pickIndex.ref(candidates[0].index) }
        : { count: 0 };
    },
    pickInfo() {
      return pickIndex ? pickIndex.stats() : null;
    },
    /** All rooms (tests): put the fly camera `height` tiles above and `back` tiles south of the room
     *  whose name matches, looking at its middle; returns the room's id and name. */
    lookAtRoom(name: string, height = 14, back = 16) {
      if (!allMode || !worldFrame || !fly) return null;
      const pattern = new RegExp(name, 'i');
      const room = (world.index?.rooms || []).find((r: any) => pattern.test(String(r.name ?? '')));
      const entry = room ? worldGameRooms.get(Number(room.id)) : null;
      const f = room ? worldFrame.frames.get(Number(room.id)) : null;
      if (!room || !f) return null;
      syncNativeFrame();
      const T = world.tileUnits;
      const centre = new THREE.Vector3((f.x + worldFrame.ox + f.w / 2) * T, (f.y + worldFrame.oz + f.h / 2) * T, 0).applyMatrix4(worldFromNative);
      scene3d.camera.position.copy(centre).add(new THREE.Vector3(0, height, back));
      fly.lookAt(centre);
      worldGameRanked = 0;
      return { id: Number(room.id), name: room.name, built: !!entry?.scene };
    },
    /** Tests: the plain view's animated water on or off (no longer a setting; a still frame without it). */
    setPlainWater(on: boolean) {
      state.water = !!on;
      applyWater();
      return state.water;
    },
    /** All rooms (tests): the game's frame drawing the world. */
    get worldGameFrame() { return worldGame; },
    /** All rooms (tests): what the game's shading has built and how far each is from the camera (tiles), and
     *  the rooms drawn in the plain shading. */
    worldGameState() {
      syncNativeFrame();
      const eye = scene3d.camera.position.clone().applyMatrix4(nativeFromWorld), T = world.tileUnits;
      return {
        reach: worldGameReach() / T,
        rooms: [...worldGameRooms.values()].filter((r) => r.scene || r.building)
          .map((r) => ({ id: r.id, built: !!r.scene, distance: Math.round(groundDistance2(r.box, eye) / T) })),
        cells: [...worldGameCells.values()].filter((c) => c.clusters || c.clusterBuilding)
          .map((c) => ({ key: c.key, built: !!c.clusters, distance: Math.round(groundDistance2(c.box, eye) / T) })),
        plain: [...worldGameRooms.values()].filter((r) => !r.classicHidden).length,
        mergedVisible: !!merged && !worldAllGame && mergedActive(),
        order: worldGameTimes.map((t) => t[0]),
      };
    },
    /** All rooms (tests): hold the game shading's draw budget at `draws` (null: follow the frame again). */
    setGameBudget(draws: number | null) {
      worldGameBudgetFixed = draws !== null;
      if (draws !== null) worldGameBudget = draws;
      worldGameRanked = 0;
      return worldGameBudget;
    },
    /** All rooms (tests): one frame drawn with the GPU waited on after each part (ms): the game's
     *  frame, three's view over it, and three's view alone. */
    /** All rooms (tests): hold the game frame's clock at `ticks` (null: run again). */
    freezeClock(ticks: number | null) { frozenTicks = ticks; },
    /** Tests: the rooms and clusters drawn kept as they are while the camera moves (what a view shows from
     *  where another view left them). */
    holdWorldGame(on: boolean) { worldGameHeld = on; },
    /** Tests: every surface a ray (native frame) meets in the loaded rooms, nearest first: its distance (native
     *  units), part and face normal (what overlaps where two parts draw at one depth). */
    rayHits(origin: number[], direction: number[]) {
      world.root.updateMatrixWorld(true);
      const R = world.root.matrixWorld, Ri = R.clone().invert();
      const o = new THREE.Vector3(origin[0], origin[1], origin[2]).applyMatrix4(R);
      const d = new THREE.Vector3(origin[0] + direction[0], origin[1] + direction[1], origin[2] + direction[2]).applyMatrix4(R).sub(o).normalize();
      const ray = new THREE.Raycaster(o, d, 0, Infinity);
      ray.layers.enableAll();
      const meshes = [...world.rooms.values()].flatMap((room: any) => room.meshes);
      return ray.intersectObjects(meshes, false).map((hit: any) => {
        const at = hit.point.clone().applyMatrix4(Ri);
        const e = hit.object.userData.exact ?? {};
        return { at: [at.x, at.y, at.z], distance: at.distanceTo(new THREE.Vector3(origin[0], origin[1], origin[2])),
          room: e.room, mesh: e.mesh, material: e.material, renderTexture: e.renderTexture, category: e.category, instance: hit.instanceId,
          face: hit.face ? [hit.face.a, hit.face.b, hit.face.c] : null, normal: hit.face ? [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z].map((v: number) => +v.toFixed(3)) : null };
      });
    },
    /** All rooms (tests): a room's parts as the game's frame draws them in this view (world native frame), and the
     *  rooms whose rects meet its own. */
    async gameParts(id: number, meshes: number[] | null = null) {
      const entry = worldGameRooms.get(id);
      if (!entry || !worldFrame) return null;
      const source = await worldGameSource(id);
      const parts = source.batches.flatMap((b) => (meshes && !meshes.includes(b.mesh) ? [] : b.matrices.map((m, k) => {
        const p = new THREE.Vector3().setFromMatrixPosition(m).add(entry.origin);
        return { mesh: b.mesh, material: b.material, renderTexture: b.renderTexture, category: b.category, k, at: [p.x, p.y, p.z].map(Math.round),
          basis: [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => +m.elements[i].toFixed(4)), order: b.order?.[k] ?? null };
      })));
      const f = worldFrame.frames.get(id)!;
      const near = [...worldFrame.frames].filter(([other, g]) => other !== id && g.x < f.x + f.w && g.x + g.w > f.x && g.y < f.y + f.h && g.y + g.h > f.y).map(([other]) => other);
      return { origin: [entry.origin.x, entry.origin.y], parts, overlapping: near };
    },
    /** All rooms (tests): the game's frame from a camera (native eye and target, fov 40) at `width` x `height`,
     *  what is drawn left as it is: RGBA rows as the frame's main target holds them. */
    worldStill(eye: number[], target: number[], width: number, height: number, frames = 4) {
      if (!worldGame) return null;
      syncNativeFrame();
      const cam = scene3d.camera;
      const saved = { position: cam.position.clone(), quaternion: cam.quaternion.clone(), fov: cam.fov, aspect: cam.aspect, up: cam.up.clone() };
      const held = worldGameHeld;
      worldGameHeld = true;
      try {
        cam.position.copy(new THREE.Vector3(eye[0], eye[1], eye[2]).applyMatrix4(worldFromNative));
        cam.up.set(0, 1, 0);
        cam.lookAt(new THREE.Vector3(target[0], target[1], target[2]).applyMatrix4(worldFromNative));
        cam.fov = 40; cam.aspect = width / height;
        cam.updateProjectionMatrix(); cam.updateMatrixWorld();
        worldStillSize = new THREE.Vector2(width, height);
        for (let k = 0; k < frames; k++) renderAllRooms();
        const out = worldGame.readMain();
        return out ? Array.from(out.data) : null;
      } finally {
        worldStillSize = null;
        worldGameHeld = held;
        cam.position.copy(saved.position); cam.quaternion.copy(saved.quaternion); cam.up.copy(saved.up);
        cam.fov = saved.fov; cam.aspect = saved.aspect; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
        renderer.resetState();
      }
    },
    /** All rooms (tests): the joined cells' scenes. */
    worldGameClusters() { return [...worldGameCells.values()].flatMap((c) => c.clusters ?? []); },
    worldGameProfile() {
      const gl = renderer.getContext();
      const timed = (fn: () => void) => { gl.finish(); const t0 = performance.now(); fn(); gl.finish(); return +(performance.now() - t0).toFixed(2); };
      if (worldGame) { worldGame.timePasses = true; worldGame.gl.counting = true; worldGame.gl.calls = {}; }
      const all = timed(() => renderAllRooms());
      const calls = worldGame ? { ...worldGame.gl.calls } : null;
      if (worldGame) worldGame.gl.counting = false;
      const passes = worldGame ? { ...worldGame.lastPassTimes } : null;
      if (worldGame) worldGame.timePasses = false;
      const plain = timed(() => { renderer.resetState(); renderer.render(scene3d.scene, scene3d.camera); });
      return { all, plain, game: +worldGameCost.toFixed(2), passes, calls, draws: worldGame?.lastDraws ?? null };
    },
    /** All rooms' game shading (tests): the rooms built, being built and failed, their bytes, and the
     *  rooms the merged batches leave out. */
    worldGameInfo() {
      const rooms = [...worldGameRooms.values()];
      return {
        on: worldGameOn(), built: rooms.filter((r) => r.scene).map((r) => r.id), building: rooms.some((r) => r.building),
        background: backgroundStats(),
        late: +worldLateFrames().toFixed(2),
        failed: rooms.filter((r) => r.failed).map((r) => r.id),
        bytes: rooms.reduce((n, r) => n + (r.scene?.bytes ?? 0), 0), hidden: merged ? [...merged.hiddenRooms] : [],
        split: rooms.filter((r) => r.scene).map((r) => [r.id, r.scene!.draws.length, r.scene!.actorDraws.length, r.scene!.planeDraws.length, r.scene!.waterDraws.length]),
        times: worldGameTimes.slice(-20), cost: +worldGameCost.toFixed(2), three: +worldThreeCost.toFixed(2), drawn: worldGameDrawn,
        budget: worldGameBudget, frame: +worldLoopCost.toFixed(2), dropped: worldGameDropped,
        cells: worldGameCells.size, joined: [...worldGameCells.values()].filter((c) => c.clusters).length,
        joining: worldClusterBuilding, allGame: worldAllGame, steady: worldSteady(), shadowBakes: worldShadowBakes,
        farFloor: { state: worldFarFloorState, scenes: worldFarFloor.length, plainVisible: !!worldPlane?.visible },
        shadows: [...worldGameCells.values()].filter((c) => c.shadow).map((c) => c.shadow!.size),
        clusterBytes: [...worldGameCells.values()].reduce((n, c) => n + (c.clusters ?? []).reduce((m, s) => m + s.bytes, 0), 0), draws: worldGame?.lastDraws ?? null,
      };
    },
    inspectInfo() {
      return {
        pinned: inspectPinned,
        mode: pinnedCtx?.mode || null,
        key: inspectedKey,
        room: pinnedCtx ? Number(pinnedCtx.info.room) : null,
        category: pinnedCtx?.info.category || null,
        placementIndex: pinnedCtx ? Number(pinnedCtx.info.placementIndex) : null,
        previewActive: !!preview?.active,
        highlightVisible: !!highlight && highlight.parent != null && highlight.visible,
        groupHighlights: groupHighlights.length,
        readoutRows: [...readout.querySelectorAll('dt')].map((n) => n.textContent),
        previewMeshes: (() => {
          let n = 0;
          preview?.spinner?.traverse((o: any) => { if (o.isMesh || o.isSkinnedMesh) n++; });
          return n;
        })(),
        group: pinnedCtx?.group ? {
          kind: pinnedCtx.group.kind,
          parts: pinnedCtx.group.members.length,
          occurrence: pinnedCtx.group.occurrenceIndex ?? null,
          model: pinnedCtx.group.model?.id || null,
          label: pinnedCtx.group.label || null,
          variants: Array.isArray(pinnedCtx.group.model?.variants) ? pinnedCtx.group.model.variants.length : 0,
        } : null,
        variantIndex: variantOverlay?.index ?? 0,
        variantMeshes: variantOverlay?.meshes.length ?? 0,
      };
    },
    unpinInspect() { clearInspection(true); },
    spawnAnimInfo() {
      if (!spawnAnim) return null;
      const rig = spawnAnim.rig;
      return {
        key: spawnAnim.key,
        kind: spawnAnim.resolved?.kind || (rig ? 'ready' : 'pending'),
        hasBar: !!spawnAnim.bar,
        hasClip: !!spawnAnim.bar?.sampler,
        active: !!spawnAnim.active,
        playing: !!spawnAnim.bar?.playing,
        loop: spawnAnim.bar ? !!spawnAnim.bar.loop : null,
        clips: spawnAnim.resolved?.clips?.length || 0,
        parts: spawnAnim.composite?.meshCount || 0,
        clipSelect: spawnAnim.bar?.select?.value ?? null,
        hint: spawnAnim.box?.querySelector('.wp-anim-hint')?.textContent || null,
        boneQ: rig && rig.bones.length
          ? rig.bones[Math.min(1, rig.bones.length - 1)].quaternion.toArray()
          : null,
      };
    },
    // Parked (persistent) animations: those still playing after their model
    // was unpinned. Test hook for the persistence behavior.
    persistentAnimInfo() {
      return {
        count: persistentAnims.size,
        keys: [...persistentAnims.keys()],
        playing: [...persistentAnims.values()].map((a) => !!a.bar?.playing),
        active: [...persistentAnims.values()].map((a) => !!a.active),
      };
    },
    // Parked (persistent) variants: overlays still drawn after their model was
    // unpinned. Test hook for the variant-persistence behavior.
    persistentVariantInfo() {
      return {
        count: persistentVariants.size,
        keys: [...persistentVariants.keys()],
        meshes: [...persistentVariants.values()].map((v) => v.meshes.length),
        indices: [...persistentVariants.values()].map((v) => v.index),
      };
    },
    // Test/diagnostics hook: pin a placement by reference, exercising the same
    // graph / merged-index pin paths a click would (spawns are tiny in the
    // fixture world, so a screen-space ray is impractical there).
    pinPlacement: (ref: any) => pinByRef(ref),
    // Test hook: simulate hovering a placement (unpinned inspection), so the
    // whole-model hover highlight can be asserted without a screen-space ray.
    async hoverPlacement(ref: any) {
      if (destroyed || inspectPinned) return false;
      const token = ++pickToken;
      if (mergedActive()) {
        if (!pickIndex?.ready) return false;
        const entryIndex = pickIndex.find(ref);
        if (entryIndex < 0) return false;
        const entryRef = pickIndex.ref(entryIndex);
        let geometry = null;
        try { geometry = await world._meshGeometry(entryRef.mesh, entryRef.reflect); } catch { return false; }
        if (destroyed || token !== pickToken) return false;
        await showIndexInspection({ entryIndex, ref: entryRef, geometry }, false, token);
        return true;
      }
      const room = world.rooms.get(Number(ref.room));
      if (!room) return false;
      for (const mesh of room.meshes) {
        const exact = mesh.userData.exact;
        if (!exact || exact.category !== ref.category || exact.sourceKind !== ref.sourceKind) continue;
        const instanceId = (exact.placementIndices || []).indexOf(Number(ref.placementIndex));
        if (instanceId < 0) continue;
        showInspection({ object: mesh, instanceId }, false);
        return true;
      }
      return false;
    },
    editsInfo() {
      return {
        count: edits.size,
        list: [...edits.values()].map(({ key, dx, dy, dz, turns, deleted }: any) => (
          { key, dx, dy, dz, turns, deleted })),
        rebakes: merged?.rebakes || 0,
        rebakeRuns,
        rebakeBusy,
      };
    },
    wireInfo() {
      if (!wire) return null;
      return {
        collision: wire.collisionMesh ? wire.collisionMesh.count : 0,
        collisionVisible: wire.collisionGroup.visible,
        emptyBatches: wire.emptyMeshes.length,
        emptyInstances: wire.emptyMeshes.reduce((sum: number, mesh: any) => sum + mesh.count, 0),
        emptyVisible: wire.emptyGroup.visible,
      };
    },
    // Game shading test handle: whether the game's frame is drawing, and a
    // fixed native-frame camera (eye and target in native units) for captures.
    gameApi: {
      ready: () => gameActive(),
      actors: () => gameFrame?.actorInfo() ?? null,
      plane: () => gameFrame?.planeInfo() ?? null,
      lights: () => gameFrame?.lightInfo() ?? null,
      /** The viewer's own floor (a room's, or the all-rooms one). */
      groundPlane: () => groundPlaneInfo(),
      setCamera(eye: number[] | null, target?: number[]) {
        gameCamera = eye && target ? { eye: new THREE.Vector3(eye[0], eye[1], eye[2]), target: new THREE.Vector3(target[0], target[1], target[2]) } : null;
      },
      /** A still of the game's frame from any camera (native frame; `up` defaults to z,
       *  `near`/`far` to the game's range), at any size: `frames` frames from a fresh
       *  occlusion history, drawn offscreen, the last read back as RGBA rows top first. */
      still({ eye, target, up, fov, width, height, near, far, frames = 1, water = true }: {
        eye: number[]; target: number[]; up?: number[]; fov: number; width: number; height: number;
        near?: number; far?: number; frames?: number; water?: boolean;
      }) {
        if (!gameActive()) return null;
        const v = (p: number[]) => new THREE.Vector3(p[0], p[1], p[2]);
        const camera = { eye: v(eye), target: v(target), up: up ? v(up) : undefined, fov, width, height, near, far };
        gameFrame!.skipWater = !water;
        world.root.updateMatrixWorld();
        spawnAnimRoot.updateMatrixWorld(true);
        syncActorLayers(true);
        gameFrame!.resetTemporal();
        try {
          for (let k = 0; k < frames; k++) gameFrame!.render(camera, waterTicks, camera.target.z, true);
          return gameFrame!.readMain();
        } finally {
          renderer.resetState();
          gameFrame!.skipWater = false;
        }
      },
      /** Draw `frames` game frames (no overlays) and read the last back: RGBA rows top first,
       *  with the occlusion targets of the same frame. `fresh` starts the occlusion history anew. */
      capture(frames = 1, water = true, fresh = false) {
        if (!gameActive()) return null;
        gameFrame!.skipWater = !water;
        world.root.updateMatrixWorld();
        const camera = currentGameCamera();
        if (fresh) gameFrame!.resetTemporal();
        // The last frame is also presented, as the view shows it.
          spawnAnimRoot.updateMatrixWorld(true);
        for (let k = 0; k < frames; k++) gameFrame!.render(camera, waterTicks, camera.target.z, k < frames - 1);
        const out = gameFrame!.readTarget('main');
        const gl = renderer.getContext() as WebGL2RenderingContext;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const shown = new Uint8Array(camera.width * camera.height * 4);
        gl.readPixels(0, 0, camera.width, camera.height, gl.RGBA, gl.UNSIGNED_BYTE, shown);
        const canvas: number[] = [];
        for (let y = camera.height - 1; y >= 0; y--) canvas.push(...shown.subarray(y * camera.width * 4, (y + 1) * camera.width * 4));
        const targets = Object.fromEntries((['ao', 'aoRaw', 'blur1', 'linear'] as const).map((name) => [name, gameFrame!.readTarget(name)?.data ?? null]));
        const constants = Object.fromEntries(Object.entries(gameFrame!.lastConstants).map(([k, v]) => [k, Array.from(v)]));
        renderer.resetState();
        gameFrame!.skipWater = false;
        return out ? { width: out.width, height: out.height, rgba: out.data, canvas, targets, constants } : null;
      },
    },
    // Card picture test handle: a loaded spawn's parts (with its recolours) and
    // a card render of a subject through the game's programs (card.ts).
    cardApi: {
      spawnParts(record: number, withProps = false) {
        const sc = world.spawnColumns, pc = world.spawnPartColumns;
        if (!sc || !pc) return null;
        for (const room of world.rooms.values()) {
          const shard = room.shard;
          const index = (shard?.spawns || []).findIndex((row: any[]) => Number(row[sc.record]) === record);
          if (index < 0) continue;
          const spawn = shard.spawns[index];
          const parts = (shard.spawn_parts || []).filter((row: any[]) => Number(row[pc.spawn]) === index
            && (withProps || Number(row[pc.confidence]) !== 3)).map((row: any[]) => {
            const recolours = Number(row[pc.recolor]) >= 0 ? shard.recolors?.[Number(row[pc.recolor])] ?? null : null;
            return { mesh: Number(row[pc.mesh]), material: Number(row[pc.material]), renderTexture: Number(row[pc.render_texture]),
              recolours: recolours ? recolours.slice(0, 2).map((c: any[]) => c.map(Number)) : null, tint: null };
          });
          return { room: room.id, idleClip: sc.idle_clip !== undefined ? Number(spawn[sc.idle_clip]) : -1, parts };
        }
        return null;
      },
      async render(subject: CardSubject, view: CardView, scale = 1) {
        const gl = renderer.getContext();
        if (!(gl instanceof WebGL2RenderingContext) || !world.index?.render) return null;
        try {
          const out = await renderCard({
            gl, url: (rel: string) => app.store.url(rel), payload: (rel: string) => app.store.payload(rel),
            render: world.index.render, tileUnits: world.tileUnits, textureMeta: (id: number) => world.textureMeta(id),
          }, subject, view, scale);
          return { width: out.width, height: out.height, rgba: Array.from(out.rgba) };
        } finally {
          renderer.resetState();
        }
      },
    },
    // Effects debug/test handle: live counts, the frozen-clock controls the
    // harness drives, and a camera-focus helper for screenshots.
    effectsApi: {
      info: () => ({
        systems: effectsLayer ? effectsLayer.systemCount() : 0,
        emitters: effectsLayer ? effectsLayer.emitterCount() : 0,
        live: effectsLayer ? effectsLayer.liveCount() : 0,
        draws: effectsLayer ? effectsLayer.drawCount() : 0,
        // merged all-rooms only: proximity-activated room count (0 in the
        // single-room view, where every wanted room is simply always on)
        active: activeEffectRooms.size,
      }),
      instances: () => (effectsLayer ? effectsLayer.instances() : []),
      setClock(ticks: number) { effectsLayer?.setClock(Number(ticks) || 0, scene3d.camera); },
      setRunning(on: boolean) { effectsLayer?.setRunning(!!on); },
      focus(nameOrSlot: any, extent = 10) {
        const anchor = effectsLayer?.findAnchor(nameOrSlot);
        if (!anchor) return false;
        focusExtent(anchor.x / world.tileUnits, anchor.y / world.tileUnits,
          Math.max(1, Number(extent) || 10));
        return true;
      },
      // Test/debug: jump the camera to a room's stitched (or graph) corner
      // without requiring the room's effects to already be instantiated
      // (unlike focus(), which looks up a currently-active system's anchor).
      // Used by the merged-mode harness to bring a known room within the
      // proximity activation radius before asserting on it.
      focusRoom(roomId: number, extent = 20) {
        const [ox, oy] = spawnRoomOffset(Number(roomId));
        focusExtent(ox / world.tileUnits, oy / world.tileUnits, Math.max(1, Number(extent) || 20));
        return true;
      },
      buffers: () => (effectsLayer ? effectsLayer.snapshot() : []),
      // Test/diagnostics: how many pickable proxies currently exist (one per
      // loaded effect instance), independent of DOM/readout state.
      pickableCount: () => (effectsLayer ? effectsLayer.pickables().length : 0),
      // Raw findAnchor passthrough (native units), for asserting a nudge
      // actually moved an instance without scraping the DOM.
      anchorOf: (nameOrSlot: any) => effectsLayer?.findAnchor(nameOrSlot) ?? null,
      // Screen-space point (CSS pixels) of a named/slotted instance's CURRENT
      // anchor, projected through the live camera/effectsRoot transform --
      // reuses the real render pipeline instead of a test re-deriving the
      // native-to-screen conversion by hand. Drives a real synthetic click at
      // the returned point to exercise the actual proxy-picking path.
      screenPointOf(nameOrSlot: any) {
        const anchor = effectsLayer?.findAnchor(nameOrSlot);
        if (!anchor) return null;
        const v = new THREE.Vector3(anchor.x, anchor.y, anchor.z);
        effectsRoot.updateMatrixWorld();
        v.applyMatrix4(effectsRoot.matrixWorld);
        v.project(scene3d.camera);
        const rect = renderer.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      },
      // Pin/inspect/edit an effect instance by reference, the same "pin by
      // reference" idiom pinPlacement gives placements: a screen-space ray
      // onto a proxy is exactly as impractical for a test harness as it is
      // for the fixture's tiny spawns (pinPlacement's own precedent).
      pinInstance: (ref: any) => pinEffectByRef(ref),
      unpinInstance() { clearEffectInspection(true); },
      pinnedInstanceInfo() {
        if (!effectPinned) return null;
        return effectsLayer ? effectsLayer.instanceInfo(effectPinned.key) : null;
      },
      nudgeInstance(axis: 'dx' | 'dy' | 'dz', delta: number) { nudgeEffectPinned(axis, Number(delta) || 0); },
      nudgeInstanceScale(factor: number) { nudgeEffectScalePinned(Number(factor) || 1); },
      setInstanceHidden(on: boolean) {
        if (!effectPinned || !effectsLayer) return;
        effectsLayer.setInstanceHidden(effectPinned.key, !!on);
        refreshEffectReadout();
        syncEditsUi();
      },
      setInstancePaused(on: boolean) {
        if (!effectPinned || !effectsLayer) return;
        effectsLayer.setInstancePaused(effectPinned.key, !!on);
        refreshEffectReadout();
        syncEditsUi();
      },
      nudgeInstanceClock(deltaTicks: number) { nudgeEffectClockPinned(Number(deltaTicks) || 0); },
      resetInstance() { resetEffectPinned(); },
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      gateResolve?.(false);   // unstick a pending all-rooms confirm gate
      gateResolve = null;
      window.removeEventListener('pagehide', onPageHide);
      immersive.destroy();
      if (inspectFrame) cancelAnimationFrame(inspectFrame);
      if (rebakeTimer) clearTimeout(rebakeTimer);
      pendingBucketKeys.clear();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onInspectKeyDown);
      window.removeEventListener('dblclick', onDblClickCapture, { capture: true });
      renderer.domElement.style.cursor = '';
      disposeSpawnAnim(spawnAnim);
      spawnAnim = null;
      for (const parked of persistentAnims.values()) disposeSpawnAnim(parked);
      persistentAnims.clear();
      // Variant overlays (active + parked): just drop the meshes/geometry. The
      // whole scene is going away, so restoring the authored statics is moot and
      // a merged re-bake mid-teardown would be wasted work.
      for (const ov of [variantOverlay, ...persistentVariants.values()]) {
        if (!ov) continue;
        for (const mesh of ov.meshes) { mesh.removeFromParent(); mesh.geometry?.dispose?.(); }
      }
      variantOverlay = null;
      persistentVariants.clear();
      hiddenSpawnParts.clear();
      hiddenOccurrenceParts.clear();
      spawnAnimRoot.removeFromParent();
      effectsLayer?.dispose();
      effectsLayer = null;
      effectsRooms.clear();
      activeEffectRooms.clear();
      effectsRoot.removeFromParent();
      destroyPreview();
      pickScratchMesh.material.dispose();
      edits.clear();
      shardCache.clear();
      pickIndex?.dispose();
      pickIndex = null;
      scene3d.controls.removeEventListener('change', onControlsChange);
      fly?.dispose();
      removeTick();
      hud.destroy();
      // View-built water sheets: world.dispose() detaches rooms without the
      // 'unloaded' events, so their geometries must be freed here explicitly.
      for (const id of [...roomWaterSheets.keys()]) disposeRoomWaterSheets(id);
      overlay?.remove();
      overlay = null;
      disposeNameSprites();
      disposeSpawnNameSprites();
      stopWorldGame();
      worldGame?.releaseTextures();
      worldGame?.bakeWorker?.dispose();
      worldGame = null;
      disposeWorldGroundPlane();
      wire?.dispose();
      wire = null;
      merged?.dispose();
      world.dispose();
      highlightMaterial.dispose();
      for (const material of sheetMaterialCache.values()) material.dispose();
      sheetMaterialCache.clear();
      // the renderer is shared across views: undo world-only settings
      renderer.shadowMap.enabled = false;
      renderer.setPixelRatio(savedPixelRatio);
      scene3d.destroy();
      if ((window as any).__bs?.worldView === api) delete (window as any).__bs.worldView;
    },
  };
  if ((window as any).__bs) (window as any).__bs.worldView = api;
  return api;
}
