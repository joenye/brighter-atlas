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

import { el, clear, append, kvTable, fmtInt, placeholderCard } from '../ui.js';
import { getPref, setPref } from '../prefs.js';
import { Scene3D, getRenderer, mountImmersiveControls } from './three-common.js';
import * as THREE from '../../vendor/three.module.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import WorldScene, {
  WORLD_CATEGORIES, CATEGORY_COLOURS, loadRoomsWithRetry, yieldToBrowser,
} from './world/scene.js';
import { FlyControls } from './world/fly-controls.js';
import {
  WorldWaterRegistry, createWaterUniforms, updateWaterSheetLights,
  collectRoomWaterTiles, buildWaterSheetGeometry, waterSheetMaterialFor,
  isWaterWallGeometry,
} from './world/water.js';
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
  1: 'roster spawn: authored tile from the roaming-enemy roster',
  2: 'approx. position: roster enemy without an authored tile, placed at the room centre',
};
const CATEGORY_LABELS: Record<string, [string, string]> = {
  terrain: ['Terrain', '#65976f'],
  models: ['Scenery / models', '#d6b772'],
  spawns: ['NPC / enemy spawns', '#dc8268'],
  components: ['Components', '#a4aeba'],
};
const RENDER_SCALES: (number | 'native')[] = [0.5, 0.75, 1, 'native', 1.5, 2];
const TEXTURE_ANISOTROPY = 8;   // fixed: the user-facing control was removed

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
  names: true,
  spawnnames: false,
  inspect: false,
  water: true,
  wcolor: 'auto',
  wopacity: 50,
  ambient: 1.85,
  sun: 2.8,
  shadows: false,
  flatten: false,
  merged: true,
  scale: 2,       // RENDER_SCALES index (1x)
  cull: false,
  culld: 160,
  floor: 'none',    // all-rooms under-world surface: none | table | void
  tableLight: 1,    // wooden-table material brightness multiplier
  shotRes: '8k',    // high-res screenshot long-edge target (see SHOT_RES)
});
// z (level csv) and inspect are per-visit; everything else persists.
const PERSISTED = Object.keys(DEFAULT_STATE).filter((k) => k !== 'inspect');

// The view state: DEFAULT_STATE plus the per-visit z csv. Keys are also
// accessed dynamically (category toggles, the inputs registry).
interface WorldState {
  terrain: boolean; models: boolean; spawns: boolean; components: boolean;
  untextured: boolean; collision: boolean; empty: boolean; names: boolean;
  spawnnames: boolean;
  inspect: boolean; water: boolean;
  wcolor: string; wopacity: number; ambient: number; sun: number;
  shadows: boolean; flatten: boolean; merged: boolean;
  scale: number; cull: boolean; culld: number;
  floor: string; tableLight: number; shotRes: string;
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
  if (gpu && !hasSavedWorldState()) {
    if (gpu.tier === 'software') {
      state.scale = RENDER_SCALES.indexOf(0.5);
      state.water = false;
      state.cull = true;
    } else if (gpu.tier === 'integrated') {
      state.scale = RENDER_SCALES.indexOf(0.75);
      state.cull = true;
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
  {
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
        this.renderer.render(this.scene, this.camera);
        renderEnd = performance.now();
        renderCost = renderEnd - start;
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

  // --- water + status state -------------------------------------------------
  const waterUniforms = createWaterUniforms();
  const sheetMaterialCache = new Map<any, any>();
  const roomWaterSheets = new Map<number, any[]>();     // room id -> [sheet meshes]
  const roomWaterCurtains = new Map<number, any[]>();   // room id -> [curtain meshes]
  let waterRegistry: any = null;
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
        }
        syncStatus();
      }
      if (event.state === 'unloaded') {
        for (const id of event.rooms || [event.room]) {
          roomWaterCurtains.delete(Number(id));
          disposeRoomWaterSheets(Number(id));
        }
      }
    },
  });

  // --- control panel ---------------------------------------------------------
  const hud = createWorldHud({ host, renderer });

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
    if (!state.inspect) clearInspection(true);
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
  const applyToggles = () => {
    world.setUntexturedVisible(state.untextured);
    world.setCollisionVisible(state.collision);
    world.setAuthoredEmptyVisible(state.empty);
    applyWireOverlays();   // merged all-rooms path for collision/empty
    applyWater();   // authored-empty/z passes re-show hidden curtains
  };

  const visSection = section('Visible',
    ...WORLD_CATEGORIES.map((category: string) => check(category, CATEGORY_LABELS[category][0], () => {
      clearInspection(true);
      applyCategories();
    }, { swatch: CATEGORY_LABELS[category][1] })),
    check('untextured', 'Untextured fills', applyToggles,
      { swatch: '#6a7d55', title: 'Placements with no decodable texture, drawn in flat category colours' }),
    check('collision', 'Collision extents', applyToggles, { swatch: '#79a9c9' }),
    check('empty', 'Empty materials', applyToggles,
      { swatch: '#d87dc0', title: 'Placements whose material is authored empty, as wireframes' }),
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

  // water ----------------------------------------------------------------------
  const waterColor = el('input', { type: 'color', class: 'wp-color', value: state.wcolor === 'auto' ? '#1f4a50' : `#${state.wcolor}` });
  const waterAuto = el('input', { type: 'checkbox' });
  waterAuto.checked = state.wcolor === 'auto';
  waterAuto.addEventListener('change', () => {
    state.wcolor = waterAuto.checked ? 'auto' : waterColor.value.slice(1);
    applyWater();
    syncState();
  });
  waterColor.addEventListener('input', () => {
    if (!waterAuto.checked) state.wcolor = waterColor.value.slice(1);
    applyWater();
    syncState();
  });
  const waterSection = section('Water',
    check('water', 'Animated water', applyWater,
      { swatch: '#2e6f77', title: 'Hide the authored wave curtains and render each body as an animated surface' }),
    el('div', { class: 'wp-range' },
      el('div', { class: 'wp-range-head' },
        el('span', { text: 'Colour' }),
        el('label', { class: 'wp-inline' }, waterAuto, el('span', { text: 'auto' }))),
      waterColor),
    range('wopacity', 'Opacity', 10, 100, 2, (v) => `${v}%`, applyWater));

  function applyWater(): void {
    const enabled = !!state.water;
    const auto = state.wcolor === 'auto';
    waterColor.disabled = auto;
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

  // lighting ---------------------------------------------------------------------
  function applyLights(): void {
    hemi.intensity = state.ambient;
    sun.intensity = state.sun;
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

  const lightSection = section('Lighting & effects',
    range('ambient', 'Ambient / sky', 0, 2.5, 0.05, (v) => v.toFixed(2), applyLights),
    range('sun', 'Sun', 0, 3, 0.05, (v) => v.toFixed(2), applyLights),
    check('shadows', 'Shadows', applyShadows, { swatch: '#5f6670' }),
    check('flatten', 'Flatten heights', applyFlatten,
      { swatch: '#3a4759', title: 'Squash the vertical axis to read the room like a map' }));

  // performance (all-rooms only) ----------------------------------------------
  let perfSection: HTMLElement | null = null;
  function applyRenderScale(): void {
    const mode = RENDER_SCALES[state.scale] ?? 1;
    renderer.setPixelRatio(mode === 'native' ? (devicePixelRatio || 1) : Number(mode));
    (scene3d as any)._resize();
  }
  const scaleLabel = (v: number) => (RENDER_SCALES[v] === 'native'
    ? `Native ${Math.round((devicePixelRatio || 1) * 100)}%`
    : `${Math.round(Number(RENDER_SCALES[v]) * 100)}%`);
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
    const cullRange = range('culld', 'Cull distance', 40, 400, 20, (v) => `${v} tiles`, () => applyCull());
    cullRange.hidden = !state.cull;
    perfSection = section('Performance',
      range('scale', 'Render scale', 0, RENDER_SCALES.length - 1, 1, scaleLabel, applyRenderScale),
      check('cull', 'Hide small distant objects', () => { cullRange.hidden = !state.cull; applyCull(); },
        { swatch: '#c99a5b' }),
      cullRange,
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

  // the under-world surface: board-game table / black void plane (buildFloor)
  let tableSection: HTMLElement | null = null;
  if (allMode) {
    if (!['none', 'table', 'void'].includes(state.floor)) state.floor = 'none';
    const floorSelect = el('select', { class: 'wp-floor-select', title: 'What the world sits on' });
    for (const [value, label] of [['none', 'None'], ['table', 'Wooden table'], ['void', 'Black void plane']]) {
      floorSelect.appendChild(el('option', { value, text: label }));
    }
    floorSelect.value = state.floor;
    floorSelect.addEventListener('change', () => {
      state.floor = floorSelect.value;
      applyFloor();
      syncState();
    });
    inputs.floor = floorSelect;
    tableSection = section('Surface',
      el('div', { class: 'wp-range' },
        el('div', { class: 'wp-range-head' }, el('span', { text: 'Under the world' })),
        floorSelect),
      range('tableLight', 'Table brightness', 0.2, 2, 0.05, (v) => Number(v).toFixed(2), () => applyFloor()));
  }

  // Advanced accordion: collapsed by default, its open state persisted.
  // Category/wireframe/names toggles and the Inspect mode stay top-level.
  const advanced = el('details', { class: 'wp-advanced' },
    el('summary', { text: 'Advanced' }));
  advanced.open = getPref('worldadv') === true;
  advanced.addEventListener('toggle', () => setPref('worldadv', advanced.open));
  append(advanced, waterSection, lightSection, perfSection, zSection, tableSection);

  append(panel, inspectBtn, resetEditsBtn, readout, statusEl, visSection, advanced);

  // --- pref sync (state lives ONLY in prefs/localStorage, no URL mirroring) ---
  function syncState(): void {
    persistState(state);
  }

  // --- inspector -----------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
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

  function memberWorldMatrix(member: any, target: THREE.Matrix4): THREE.Matrix4 {
    if (member.mode === 'graph') {
      member.object.getMatrixAt(member.instanceId, target);
      for (let node = member.object; node && node !== world.root; node = node.parent) {
        target.premultiply(node.matrix);
      }
    } else {
      pickIndex.matrix(member.entryIndex, target);
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
        const set = isSpawn ? hiddenSpawnParts : hiddenModelParts;
        const key = `${Number(member.info.room)}|${Number(member.info.placementIndex)}`;
        set.add(key);
        let bucketKey = null;
        if (cell) {
          try {
            const geometry = await world._meshGeometry(member.info.mesh, false);
            const classified = merged.classifyBucket({
              category: member.info.category, renderTexture: member.info.renderTexture,
              flags: member.info.flags, recolors: member.info.recolors, z: member.info.z,
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
    const built = [];
    for (let i = 0; i < members.length; i++) {
      const vpart = vparts[i] || vparts[members.length === vparts.length ? i : 0];
      if (!vpart) continue;
      let geometry = null;
      try { geometry = await world._meshGeometry(Number(vpart.mesh ?? members[i].info.mesh), false); } catch { continue; }
      if (destroyed || inspectedKey !== guardKey) return;
      let material = null;
      try {
        material = await world._material('models', vpart.material ?? members[i].info.material,
          Number(vpart.image ?? members[i].info.renderTexture), members[i].info.flags | 0, vpart.recolors || null);
      } catch { material = null; }
      if (destroyed || inspectedKey !== guardKey) return;
      const mesh = new THREE.Mesh(geometry, material || highlightMaterial);
      mesh.matrixAutoUpdate = false;
      memberWorldMatrix(members[i], mesh.matrix);
      mesh.matrixWorldNeedsUpdate = true;
      built.push(mesh);
    }
    if (destroyed || inspectedKey !== guardKey || !built.length) { for (const m of built) m.geometry?.dispose?.(); return; }
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
  // Merged-mode transient hide: "room|placementIndex" of spawn parts whose
  // baked static must be skipped by the cell re-bake while the composite plays.
  const hiddenSpawnParts = new Set<string>();
  // Same, for a whole-model group whose composite is playing (models-category
  // placement indexes live in their own namespace).
  const hiddenModelParts = new Set<string>();

  // --- session edits (move/delete/reset, never persisted) -------------------
  const edits = new WorldEdits();
  let editStep = 0.5;      // tiles for X/Y, height layers for Z
  const editScratch = new THREE.Matrix4();
  const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

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

  function readoutRows(info: any, pinned: boolean): [string, any][] {
    const isSpawn = info.sourceKind === 'spawn';
    const group = pinned && pinnedCtx?.info === info ? pinnedCtx.group : null;
    const roomCell = `${identifier(info.room)}${world.roomMeta(info.room)?.name ? ` · ${world.roomMeta(info.room).name}` : ''}`;
    const tileCell = `${info.position.join(', ')} · ${Number(info.rotationQuarters || 0) * 90}°`;
    const rows: [string, any][] = [['Room', roomCell]];

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
      rows.push(['Parts', `${group.members.length} mesh${group.members.length === 1 ? '' : 'es'} (moved & animated together)`]);
      if (isSpawn) rows.push(['Spawn', `${identifier(info.record)} · row ${identifier(info.spawnIndex)}`]);
      if (isSpawn && SPAWN_ORIGIN_NOTES[info.origin]) rows.push(['Position', SPAWN_ORIGIN_NOTES[info.origin]]);
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
          ...(SPAWN_ORIGIN_NOTES[info.origin] ? [['Position', SPAWN_ORIGIN_NOTES[info.origin]] as [string, string]] : []),
        );
      } else {
        const source = [identifier(info.occurrenceIndex), `resource ${identifier(info.resource)}`];
        if (info.secondary !== null && info.secondary !== undefined) source.push(`secondary ${identifier(info.secondary)}`);
        rows.push(['Occurrence', source.join(' · ')]);
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

  // The spawn's native world matrix, honouring any session edit, so the
  // composite tracks exactly where the static spawn would sit (including nudges).
  function computeSpawnBaseMatrix(info: any, shard: any): THREE.Matrix4 | null {
    const partRow = info.parts?.[0]?.row;
    if (!partRow) return null;
    const matrix = new THREE.Matrix4();
    try { world._spawnMatrix(shard, partRow, matrix); } catch { return null; }
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

  function updateSpawnCompositeMatrix(): void {
    if (!spawnAnim?.composite || !spawnAnim.shard) return;
    const matrix = spawnAnim.members
      ? memberWorldMatrix(spawnAnim.members[0], new THREE.Matrix4())
      : computeSpawnBaseMatrix(spawnAnim.info, spawnAnim.shard);
    if (matrix) spawnAnim.composite.setBaseMatrix(matrix);
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
      try { geometry = await world._meshGeometry(Number(part.mesh), false); } catch { continue; }
      if (destroyed) return;
      const classified = merged.classifyBucket({
        category: sa.category,
        renderTexture: part.renderTexture,
        flags: part.flags,
        recolors: resolveShardRecolors(sa.shard, part.recolorIndex),
        z: part.z ?? sa.info.z,
      }, geometry);
      keys.add(merged.bucketKeyFor(cell.cellX, cell.cellY, classified));
    }
    for (const key of keys) queueMergedRebake(key, { immediate: true });
  }

  function hideSpawnStaticMerged(sa: any): void {
    sa._hiddenMerged = [];
    const set = sa.category === 'models' ? hiddenModelParts : hiddenSpawnParts;
    for (const part of sa.parts || []) {
      const key = `${Number(sa.info.room)}|${Number(part.rowIndex)}`;
      set.add(key);
      sa._hiddenMerged.push(key);
    }
    queueSpawnBucketRebake(sa).catch(() => { /* re-bake is best-effort */ });
  }

  function restoreSpawnStaticMerged(sa: any): void {
    const set = sa.category === 'models' ? hiddenModelParts : hiddenSpawnParts;
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

  function deactivateSpawnComposite(): void {
    if (!spawnAnim) return;
    spawnAnim.active = false;
    if (spawnAnim.composite) spawnAnim.composite.group.visible = false;
    restoreSpawnStatic(spawnAnim);
    setInspectHighlightsVisible(true);
  }

  async function activateSpawnComposite(token: number): Promise<void> {
    if (destroyed || !spawnAnim || token !== spawnAnimToken || !spawnAnim.composite) return;
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
      updateSpawnCompositeMatrix();
    }
    if (destroyed || !spawnAnim || token !== spawnAnimToken) return;
    clearVariantOverlay();   // variant + animation are mutually exclusive
    hideSpawnStatic(spawnAnim);
    setInspectHighlightsVisible(false);
    spawnAnim.composite.group.visible = true;
    spawnAnim.active = true;
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
    const n = edits.size + (variantOverlay ? 1 : 0) + persistentVariants.size;
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
    if (spawnAnim?.active && spawnAnim.key === currentSpawnKey()) updateSpawnCompositeMatrix();
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
    if (destroyed || (!edits.size && !hasVariants && !hasAnims)) {
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
    clearInspection(true);         // unpin (parks the active variant/anim)…
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
          try { geometry = await world._meshGeometry(batch.mesh, batch.reflectLocalX); } catch { continue; }
          if (destroyed) return;
          const classified = merged.classifyBucket({
            category: batch.category,
            renderTexture: batch.renderTexture,
            flags: batch.flags,
            recolors: batch.recolors,
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
                && hiddenSpawnParts.has(`${Number(roomId)}|${Number(entry.placementIndex)}`)) continue;
            if (entry.sourceKind !== 'spawn' && batch.category === 'models'
                && hiddenModelParts.has(`${Number(roomId)}|${Number(entry.placementIndex)}`)) continue;
            try {
              if (entry.sourceKind === 'spawn') world._spawnMatrix(shard, entry.row, original);
              else world._placementMatrix(shard, entry.row, original, true);
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
      return shard;
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
    if (inspectPinned && !force) return;
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
    if (!point || !state.inspect) { clearInspection(); return; }
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
    if (!state.inspect || inspectPinned || event.buttons) {
      if (event.buttons) clearInspection();
      return;
    }
    inspectPoint = [event.clientX, event.clientY];
    if (!inspectFrame) inspectFrame = requestAnimationFrame(inspectAtPendingPoint);
  };
  const onPointerLeave = () => clearInspection();
  const onPointerDown = (event: PointerEvent) => {
    if (!inspectPinned) clearInspection();
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
    if (mergedActive()) {
      const token = ++pickToken;
      (async () => {
        const hit = await resolveIndexPick(event.clientX, event.clientY, token);
        if (hit === undefined || destroyed || token !== pickToken || !state.inspect) return;
        if (!hit) {
          if (inspectPinned) clearInspection(true);
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

  // Stitched world placement for the all-rooms view: door-graph positions from
  // the index; rooms the stitch could not place park in a grid to the east.
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

  // --- board-game tabletop (all-rooms) ---------------------------------------
  // A flat wooden "table" plane just under z=0 spanning the stitched world, so
  // the merged map reads like a board game. Viewer-only: the wood is drawn
  // procedurally on a canvas (seamlessly tiling planks + grain) so the app
  // stays self-contained: no image asset, nothing in the extraction.
  let tableTop: any = null;
  let voidPlane: any = null;
  function woodTexture(): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const planks = 6;
    const plankH = size / planks;
    for (let p = 0; p < planks; p++) {
      // deterministic per-plank warm brown (Knuth-hash jitter, no RNG)
      const tone = ((p * 2654435761) % 97) / 97;
      ctx.fillStyle = `rgb(${(134 + tone * 28) | 0},${(90 + tone * 22) | 0},${(52 + tone * 15) | 0})`;
      ctx.fillRect(0, p * plankH, size, plankH);
      // grain: faint wavy streaks with whole sine periods so the left/right
      // edges meet and the texture tiles seamlessly
      for (let s = 0; s < 7; s++) {
        const yBase = p * plankH + ((s + 0.5) / 7) * plankH;
        const amp = 1.5 + ((s * 37) % 5);
        const periods = 1 + (s + p) % 3;
        const phase = (((p * 7 + s) * 61) % 100) / 100 * Math.PI * 2;
        ctx.strokeStyle = `rgba(58,36,19,${0.10 + (s % 3) * 0.05})`;
        ctx.lineWidth = 0.8 + (s % 2);
        ctx.beginPath();
        for (let x = 0; x <= size; x += 4) {
          const y = yBase + Math.sin((x / size) * Math.PI * 2 * periods + phase) * amp;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(38,22,11,0.55)';   // plank seam
      ctx.fillRect(0, p * plankH, size, 1.5);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  }
  function buildTableTop(): void {
    if (!allMode || !worldFrame || tableTop || destroyed) return;
    let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
    for (const frame of worldFrame.frames.values()) {
      minX = Math.min(minX, frame.x);
      minZ = Math.min(minZ, frame.y);
      maxX = Math.max(maxX, frame.x + frame.w);
      maxZ = Math.max(maxZ, frame.y + frame.h);
    }
    if (!Number.isFinite(minX)) return;
    const margin = Math.max(16, worldFrame.span * 0.06);
    const width = (maxX - minX) + margin * 2;
    const depth = (maxZ - minZ) + margin * 2;
    // real-table proportions scaled to the world span: a thick slab whose TOP
    // sits at z=-0.01 (z=0 belongs to the game's ground floors), four chunky
    // rectangular legs under the corners
    const span = Math.max(width, depth);
    const slabThick = Math.max(3, span * 0.014);
    const legSide = Math.max(6, span * 0.035);
    const legHeight = Math.max(14, span * 0.2);
    const topY = -0.01;

    const slabTexture = woodTexture();
    slabTexture.repeat.set(width / 48, depth / 48);   // 48-tile texture square -> 8-tile planks
    const slabMaterial = new THREE.MeshStandardMaterial({
      map: slabTexture, roughness: 0.88, metalness: 0.02,
    });
    const legTexture = slabTexture.clone();
    legTexture.needsUpdate = true;
    legTexture.repeat.set(legSide / 48, legHeight / 48);
    const legMaterial = new THREE.MeshStandardMaterial({
      map: legTexture, roughness: 0.9, metalness: 0.02,
    });

    tableTop = new THREE.Group();
    tableTop.name = 'world-tabletop';
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(width, slabThick, depth), slabMaterial,
    );
    slab.position.y = topY - slabThick / 2;
    slab.receiveShadow = true;
    tableTop.add(slab);
    const legGeometry = new THREE.BoxGeometry(legSide, legHeight, legSide);
    const legY = topY - slabThick - legHeight / 2 + 0.5;   // embed into the slab: no seam
    const legX = width / 2 - legSide / 2 - legSide * 0.4;
    const legZ = depth / 2 - legSide / 2 - legSide * 0.4;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(legGeometry, legMaterial);
      leg.position.set(sx * legX, legY, sz * legZ);
      leg.receiveShadow = true;
      tableTop.add(leg);
    }
    // displayRoot space is three Y-up tiles
    tableTop.position.set(
      minX + worldFrame.ox + (maxX - minX) / 2,
      0,
      minZ + worldFrame.oz + (maxZ - minZ) / 2,
    );
    tableTop.traverse((node: any) => {   // static furniture: compose once
      node.matrixAutoUpdate = false;
      node.updateMatrix();
    });
    displayRoot.add(tableTop);

    // the alternative surface: a huge matte-black plane at the same height.
    // fog:false keeps it pure black to the horizon: a hard void edge
    // instead of fading into the fog colour.
    voidPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(worldFrame.span * 12, worldFrame.span * 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, fog: false, side: THREE.DoubleSide }),
    );
    voidPlane.name = 'world-void-plane';
    voidPlane.rotation.x = -Math.PI / 2;
    voidPlane.position.copy(tableTop.position);
    voidPlane.position.y = topY;
    voidPlane.matrixAutoUpdate = false;
    voidPlane.updateMatrix();
    displayRoot.add(voidPlane);
    applyFloor();
  }
  function applyFloor(): void {
    if (!tableTop) return;
    tableTop.visible = state.floor === 'table';
    voidPlane.visible = state.floor === 'void';
    const brightness = Math.max(0.05, Number(state.tableLight) || 1);
    for (const mesh of tableTop.children) mesh.material.color.setScalar(brightness);
  }
  function disposeTableTop(): void {
    if (!tableTop) return;
    tableTop.removeFromParent();
    const disposed = new Set<any>();
    for (const mesh of tableTop.children) {
      if (!disposed.has(mesh.geometry)) { mesh.geometry.dispose(); disposed.add(mesh.geometry); }
      if (!disposed.has(mesh.material)) {
        mesh.material.map?.dispose();
        mesh.material.dispose();
        disposed.add(mesh.material);
      }
    }
    tableTop = null;
    voidPlane.removeFromParent();
    voidPlane.geometry.dispose();
    voidPlane.material.dispose();
    voidPlane = null;
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
            const reflect = oc.packed_flags !== undefined
              && (Number(occurrence[oc.packed_flags]) & 0x4) !== 0;
            try { world._placementMatrix(shard, row, matrix, true); } catch { continue; }
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
        const material = new THREE.MeshBasicMaterial({
          color: CATEGORY_COLOURS[batch.category] ?? 0xd87dc0, wireframe: true,
          transparent: true, opacity: 0.24, depthWrite: false,
        });
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
    if (preview?.active && preview.spinner) {
      preview.spinner.rotation.y += (dt || 16) * 0.0009;
      preview.renderer.render(preview.scene, preview.camera);
    }
    // Advance the pinned spawn's clip (PlaybackBar self-gates on
    // sampler+playing; the shared render loop then poses the skinned mesh).
    if (spawnAnim?.bar) spawnAnim.bar.tick(dt);
    for (const parked of persistentAnims.values()) parked.bar?.tick(dt);
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
    applyLights();
    applyShadows();
    applyFlatten();
    applyWater();
    if (allMode) applyRenderScale();

    if (entry) {
      const meta = world.roomMeta(entry.i);
      if (!meta) throw new Error(`room ${entry.i} is not in the extracted world`);
      focusRoom(meta);
      setStatus('loading room…');
      hud.setStage('loading room…');
      const room = await world.loadRoom(entry.i);
      if (destroyed || !room) return;
      hud.setStage(`ready · ${room.meshes.length} batches`, { steady: true });
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
      buildTableTop();
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
      // labels now, before buildMerged() releases the per-room graphs.
      buildSpawnNameSprites();
      buildZUI();
      applyCategories();
      applyToggles();
      syncStatus();
      await buildMerged();
      if (destroyed) return;
      setReadyStage();
    }
    ready = true;
    syncStatus();
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
      hiddenModelParts.clear();
      spawnAnimRoot.removeFromParent();
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
      disposeTableTop();
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
