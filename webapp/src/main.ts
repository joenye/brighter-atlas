// App shell: category tabs, virtualized sidebar list, hash router, details
// panel, status bar, error banners, keyboard navigation, global search.

import { createStore } from './client-store.js';
import { openHelpModal } from './help.js';
import { buildVersionLabel, buildInfoReady } from './build-info.js';
import { openWhatsNew, maybeAutoShowWhatsNew } from './changelog.js';
import { animClass } from './anim-class.js';
import { mountOnboarding } from './onboard.js';
import { maybeMountMobileGate } from './mobile-gate.js';
import { derivedGet, getVersion } from './storage.js';
import { diffIndexes } from './diff.js';
import { VList } from './virtual-list.js';
import { GlobalSearch } from './search.js';
import { el, clear, append, badge, kvTable, rawJson, fmtInt, fmtDur, fmtBytes, fmtNum, debounce, placeholderCard, idLabel, makeResizable, versionLabel, platformIcon } from './ui.js';
import { initPanels, expandPanelForContent } from './panels.js';
import { effectiveName, setLocalName, buildNamesFile, replaceNames, hydrateNames } from './names.js';
import { buildOverridesFile, replaceOverrides, effectiveTex, effectiveVariants,
  overrideStatus, systemTextureStatus, hydrateOverrides } from './texmap.js';
import { hydrateModels, listModels, getModel, modelCount, combineModels,
  modelVariant, modelVariants, modelParts, modelMeshCount, buildModelsSection, replaceModels,
  renameModel, deleteModel } from './models.js';
import { createMeshView } from './viewers/mesh.js';
import { createSkeletonView } from './viewers/skeleton.js';
import { createModelView } from './viewers/model.js';
import { createAnimView } from './viewers/anim.js';
import { createAudioView } from './viewers/audio.js';
import { createImageView, createImageGrid } from './viewers/images.js';
import { createStringView } from './viewers/strings.js';
import { showPendingNotices } from './notices.js';
import { entryByOrdinal } from './store.js';
import type { AppStore, IndexEntry, FetchErrorDetail } from './store.js';
import { partRecolor } from './recolor.js';


// a parsed hash route ('#/mesh/12', '#/diff/<a>..<b>', …)
export interface Route {
  cat: string;
  id: number | string | null;
  sub?: string | null;
  pos?: unknown;
  baseId?: string;
  activeId?: string;
}

// what every mounted viewer provides (viewer modules own the concrete shapes)
interface AppView {
  root: HTMLElement;
  destroy(): void;
  togglePlay?(): void;
  setItems?(items: any[]): void;
  [k: string]: any;
}

interface CatDef { key: string; route: string; label: string; single: string; icon: string; row: number }

const CATS: CatDef[] = [
  { key: 'audio', route: 'audio', label: 'Audio', single: 'Audio', icon: '♪', row: 34 },
  { key: 'anims', route: 'anim', label: 'Animations', single: 'Animation', icon: '∿', row: 34 },
  { key: 'images', route: 'image', label: 'Images', single: 'Image', icon: '▦', row: 48 },
  { key: 'meshes', route: 'mesh', label: 'Meshes', single: 'Mesh', icon: '◆', row: 34 },
  { key: 'models', route: 'model', label: 'Models', single: 'Model', icon: '❖', row: 40 },
  { key: 'rigs', route: 'rig', label: 'Rigs', single: 'Rig', icon: '⑃', row: 34 },
  { key: 'strings', route: 'text', label: 'Text', single: 'Text', icon: '“', row: 34 },
  { key: 'world', route: 'world', label: 'World', single: 'Room', icon: '⌂', row: 34 },
];
const ALIAS: Record<string, string> = {
  mesh: 'meshes', meshes: 'meshes', audio: 'audio', image: 'images', images: 'images',
  anim: 'anims', anims: 'anims', animation: 'anims', skeleton: 'rigs', skeletons: 'rigs',
  skel: 'rigs', rig: 'rigs', rigs: 'rigs', string: 'strings', strings: 'strings',
  text: 'strings', model: 'models', models: 'models',
  world: 'world', room: 'world',
};
// user-created categories (not in the manifest): hex-string ids, records in the
// 'userdata' tier, bundled into asset_overrides.json
const USER_CATS = new Set(['models']);
const ASSET_CATS = new Set(['meshes', 'audio', 'images', 'anims', 'rigs', 'strings']);
// world rooms are ordinal-addressed like assets (numeric route ids resolved
// via it.i) but deliberately NOT an ASSET_CAT: no index/<cat>.json, no h-keyed
// annotations/diff facets, no per-asset payload/GLB machinery.
const ordinalCat = (cat: string) => ASSET_CATS.has(cat) || cat === 'world';
// World sidebar: a synthetic row pinned above the rooms that routes to the
// merged whole-world view (#/world/all). It is NOT part of this.items;
// filteredItems() prepends it AFTER filtering/sorting, so it stays first under
// any sort and remains visible under any filter (it's navigation, not a room).
const WORLD_ALL_ROW = Object.freeze({ __worldAll: true, i: -1 });
// tolerate a legacy hash query on the all route (state now lives in prefs)
const isWorldAllRoute = (r: Route | null | undefined) => r?.cat === 'world' && (r.sub || '').split('?')[0] === 'all';

const imgMaxArea = (e: any) => Math.max(0, ...(e.entries || []).map((s: any) => (s.w || 0) * (s.h || 0)));
const imgMaxDim = (e: any) => Math.max(0, ...(e.entries || []).map((s: any) => Math.max(s.w || 0, s.h || 0)));
// highest-resolution sub-image (mip level 0): what the list should headline,
// not entries[0] (the smallest in the stored mip chain).
const imgMaxEntry = (e: any) => (e.entries || []).reduce(
  (best: any, s: any) => (!best || (s.w || 0) * (s.h || 0) > (best.w || 0) * (best.h || 0)) ? s : best, null);
// sub-images sorted high→low res (for tooltips / the detail panel).
const imgSizesDesc = (e: any) => (e.entries || []).slice().sort((a: any, b: any) => (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0));
// encoded (in-bundle) byte size per format as (block-dim, block-bytes):
// BC* are 4×4-block compressed, RGBA8 is raw.
const FMT_BYTES: Record<string, [number, number]> = { RGBA8: [1, 4], BC4: [4, 8], BC5LA: [4, 16], BC5S: [4, 16], BC1: [4, 8], BC3: [4, 16] };
function texBytes(fmt: string, w: number, h: number): number {
  if (!w || !h) return 0;
  const [bdim, bsize] = FMT_BYTES[fmt] || [1, 4];   // unknown fmt → assume 32bpp
  return Math.ceil(w / bdim) * Math.ceil(h / bdim) * bsize;
}
const imgBytes = (e: any) => (e.entries || []).reduce((s: number, x: any) => s + texBytes(x.fmt, x.w || 0, x.h || 0), 0);

// rig-sharing groups: 'creatures' have a dedicated/family rig with clips of
// their own; 'parts' ride a heavily shared rig (player armor etc.).
const isCreature = (m: any) => m.sk && (m.share ?? 0) > 0 && (m.share ?? 0) <= 16 && (m.clips ?? 0) > 0;
const isPart = (m: any) => m.sk && (m.share ?? 0) > 16;

type FilterDef = [label: string, pred: (it: any) => boolean, tip?: string];

// list filters: [label, predicate]. Presented as a checkbox dropdown; multiple
// checked filters AND together (an item must satisfy every checked filter). No
// 'all' entry: nothing checked = show everything.
const FILTERS: Record<string, FilterDef[]> = {
  meshes: [
    ['named', (m) => !!effectiveName(m, 'meshes')],
    ['player gear', (m) => !!m.slot, 'Player-equippable armour, gear and cosmetics recovered from the item data, grouped by body slot.'],
    ['texture override', (m) => overrideStatus(m) === 'image'],
    ['system texture', (m) => systemTextureStatus(m) === 'image'],
    ['no texture set', (m) => effectiveVariants(m).variants.length === 0],
    ['skinned', (m) => m.sk],
    ['static', (m) => !m.sk],
    ['creatures', isCreature],
    ['parts', isPart],
  ],
  audio: [
    ['named', (a) => !!effectiveName(a, 'audio')],
    ['qoa', (a) => a.codec === 'qoa'],
    ['opus', (a) => a.codec === 'opus'],
    ['sfx', (a) => a.codec === 'bslpc'],
  ],
  images: [
    ['named', (i) => !!effectiveName(i, 'images')],
    ['sprite', (i) => i.cat === 'sprite'],
    ['material', (i) => i.cat === 'material'],
    ['skybox', (i) => i.cat === 'skybox'],
    ['font', (i) => i.cat === 'font'],
    ['lut', (i) => i.cat === 'lut'],
    ['large (≥512px)', (i) => imgMaxDim(i) >= 512],
    ['medium (128 to 511px)', (i) => { const d = imgMaxDim(i); return d >= 128 && d < 512; }],
    ['small (<128px)', (i) => { const d = imgMaxDim(i); return d > 0 && d < 128; }],
    ['square', (i) => (i.entries || []).some((s2: any) => s2.w === s2.h && s2.w > 0)],
  ],
  rigs: [
    ['named', (s) => !!effectiveName(s, 'rigs')],
  ],
  anims: [
    ['named', (a) => !!effectiveName(a, 'anims')],
    ['no motion (≤1 frame)', (a) => (a.frames ?? 99) <= 1 || (a.dur ?? 99) <= 20],
    ['long loop (≥18s)', (a) => (a.dur ?? 0) >= 18000],
  ],
  // strings: no facets. The corpus is pre-cleaned at extraction and the text
  // speaks for itself; search + sorts cover navigation.
};

// filters checked by default the first time a category is visited (an explicit
// "clear all" sticks: saveCatFilters stores the empty set)
const DEFAULT_FILTERS: Record<string, string[]> = {};

function bboxVolume(m: any): number {
  const b = m.bbox;
  if (!b) return 0;
  return Math.max(0, b[3] - b[0]) * Math.max(0, b[4] - b[1]) * Math.max(0, b[5] - b[2]);
}

type SortDef = [value: string, label: string, cmp: (a: any, b: any) => number, dir: 'asc' | 'desc'];

// per-category sorts: [value, label, ASCENDING comparator, default direction].
// The comparators sort ascending by the key; a direction toggle (asc/desc) is
// applied on top, so every sort supports both directions. 'name' ties back to
// index order; other keys tie-break on index.
const byName = (cat: string) => (a: any, b: any) => {
  const na = effectiveName(a, cat), nb = effectiveName(b, cat);
  if (na && nb) return na.localeCompare(nb) || (a.i - b.i);
  if (na || nb) return na ? -1 : 1;
  return a.i - b.i;
};
const modelIdTie = (a: any, b: any) => String(a.id || '').localeCompare(String(b.id || ''));
const modelName = (m: any) => (m.name || 'Untitled model');
const modelRig = (m: any) => m.rig || (m.skel ? 'single' : 'static');
// System-model variants are exact selectable whole-model part sets recovered
// from the asset graph. User models pin one composition and do not carry a
// recovered variant catalogue. `modelVariants` also reads the legacy
// `appearances` catalog field.
const modelVariantCount = (m: any) => modelVariants(m).length;
const MODEL_VERTEX_COUNT = Symbol('modelVertexCount');
const modelVertexCount = (m: any) => m[MODEL_VERTEX_COUNT] || 0;
function attachModelVertexCounts(models: any[], meshes: IndexEntry[]): any[] {
  const byOrdinal = new Map(meshes.map((mesh) => [mesh.i, mesh] as [number, IndexEntry]));
  const byHash = new Map(meshes.map((mesh) => [mesh.h, mesh] as [any, IndexEntry]));
  for (const model of models) {
    let total = 0;
    for (const part of modelParts(model)) {
      // System models are profile-scoped and resolve ordinal-first; user models
      // remain content-hash based so they survive bundle reordering. Do not
      // deduplicate: repeated parts contribute their vertices each time.
      const mesh = model.source === 'system' && Number.isInteger(part.mesh)
        ? byOrdinal.get(part.mesh as number)
        : byHash.get(part.mesh_hash);
      if (Number.isFinite(mesh?.v)) total += mesh!.v;
    }
    // List-only derived data must never leak into raw model details or exports.
    Object.defineProperty(model, MODEL_VERTEX_COUNT, { value: total });
  }
  return models;
}
const modelOwner = (m: any) => Math.min(
  ...((m.sources || []).map((source: any) => source.owner_slot).filter(Number.isFinite)),
  Number.POSITIVE_INFINITY,
);
const modelSkeleton = (m: any) => Number.isFinite(m.skel_i)
  ? m.skel_i
  : Math.min(...((m.skeletons || []).filter(Number.isFinite)), Number.POSITIVE_INFINITY);
const CAT_SORTS: Record<string, SortDef[]> = {
  meshes: [
    ['index', 'sort: index', (a, b) => a.i - b.i, 'asc'],
    ['vertices', 'sort: vertices', (a, b) => (a.v - b.v) || (a.i - b.i), 'desc'],
    ['triangles', 'sort: triangles', (a, b) => (a.t - b.t) || (a.i - b.i), 'desc'],
    ['volume', 'sort: bbox volume', (a, b) => (bboxVolume(a) - bboxVolume(b)) || (a.i - b.i), 'desc'],
    ['name', 'sort: name', byName('meshes'), 'asc'],
  ],
  rigs: [
    ['index', 'sort: index', (a, b) => a.i - b.i, 'asc'],
    ['bones', 'sort: bones', (a, b) => (a.bones - b.bones) || (a.i - b.i), 'desc'],
    ['name', 'sort: name', byName('rigs'), 'asc'],
  ],
  audio: [
    ['index', 'sort: index', (a, b) => a.i - b.i, 'asc'],
    ['duration', 'sort: duration', (a, b) => (a.dur - b.dur) || (a.i - b.i), 'desc'],
    ['codec', 'sort: codec', (a, b) => a.codec.localeCompare(b.codec) || (a.i - b.i), 'asc'],
    ['name', 'sort: name', byName('audio'), 'asc'],
  ],
  images: [
    ['index', 'sort: index', (a, b) => a.i - b.i, 'asc'],
    ['resolution', 'sort: resolution', (a, b) => (imgMaxArea(a) - imgMaxArea(b)) || (a.i - b.i), 'desc'],
    ['bytes', 'sort: file size', (a, b) => (imgBytes(a) - imgBytes(b)) || (a.i - b.i), 'desc'],
    ['subs', 'sort: resolutions', (a, b) => (a.n - b.n) || (a.i - b.i), 'desc'],
    ['category', 'sort: category', (a, b) => String(a.cat || '').localeCompare(String(b.cat || '')) || (a.i - b.i), 'asc'],
    ['name', 'sort: name', byName('images'), 'asc'],
  ],
  strings: [
    ['index', 'sort: index', (a, b) => a.i - b.i, 'asc'],
    ['text', 'sort: text', (a, b) => a.text.localeCompare(b.text) || (a.i - b.i), 'asc'],
    ['length', 'sort: length', (a, b) => (a.text.length - b.text.length) || (a.i - b.i), 'desc'],
    ['uses', 'sort: occurrences', (a, b) => ((a.n || 1) - (b.n || 1)) || (a.i - b.i), 'desc'],
  ],
  anims: [
    // named clips first (a friendly name OR a recovered animatic name),
    // then plain index order: matches the clip pickers' default
    ['named', 'sort: named first', (a, b) => {
      const an = effectiveName(a, 'anims') || a.sn?.length ? 1 : 0;
      const bn = effectiveName(b, 'anims') || b.sn?.length ? 1 : 0;
      return (bn - an) || (a.i - b.i);
    }, 'asc'],
    ['index', 'sort: index', (a, b) => a.i - b.i, 'asc'],
    ['duration', 'sort: duration', (a, b) => (a.dur - b.dur) || (a.i - b.i), 'desc'],
    ['skeleton', 'sort: rig', (a, b) => (a.skel - b.skel) || (a.i - b.i), 'asc'],
    ['name', 'sort: name', byName('anims'), 'asc'],
  ],
  world: [
    ['index', 'sort: index', (a, b) => a.i - b.i, 'asc'],
    ['name', 'sort: name', (a, b) => {
      const na = a.name || '', nb = b.name || '';
      if (na && nb) return na.localeCompare(nb) || (a.i - b.i);
      if (na || nb) return na ? -1 : 1;
      return a.i - b.i;
    }, 'asc'],
    ['size', 'sort: size (tiles)', (a, b) => ((a.w || 0) * (a.h || 0)) - ((b.w || 0) * (b.h || 0)) || (a.i - b.i), 'desc'],
    ['placements', 'sort: placements', (a, b) => ((a.counts?.placements || 0) - (b.counts?.placements || 0)) || (a.i - b.i), 'desc'],
    ['spawns', 'sort: spawns', (a, b) => ((a.counts?.spawns || 0) - (b.counts?.spawns || 0)) || (a.i - b.i), 'desc'],
    ['levels', 'sort: height levels', (a, b) => ((a.z_levels?.length || 0) - (b.z_levels?.length || 0)) || (a.i - b.i), 'desc'],
  ],
  models: [
    ['name', 'sort: name', (a, b) => modelName(a).localeCompare(modelName(b)) || modelIdTie(a, b), 'asc'],
    ['owner', 'sort: owner', (a, b) => (modelOwner(a) - modelOwner(b)) || modelIdTie(a, b), 'asc'],
    ['meshes', 'sort: meshes', (a, b) => (modelMeshCount(a) - modelMeshCount(b)) || modelName(a).localeCompare(modelName(b)) || modelIdTie(a, b), 'desc'],
    ['vertices', 'sort: total vertices', (a, b) => (modelVertexCount(a) - modelVertexCount(b)) || modelName(a).localeCompare(modelName(b)) || modelIdTie(a, b), 'desc'],
    ['variants', 'sort: variants', (a, b) => (modelVariantCount(a) - modelVariantCount(b)) || modelName(a).localeCompare(modelName(b)) || modelIdTie(a, b), 'desc'],
    ['skeleton', 'sort: rig #', (a, b) => (modelSkeleton(a) - modelSkeleton(b)) || modelName(a).localeCompare(modelName(b)) || modelIdTie(a, b), 'asc'],
    ['rig', 'sort: rig name', (a, b) => modelRig(a).localeCompare(modelRig(b)) || modelName(a).localeCompare(modelName(b)) || modelIdTie(a, b), 'asc'],
    ['source', 'sort: source', (a, b) => String(a.source || 'user').localeCompare(String(b.source || 'user')) || modelName(a).localeCompare(modelName(b)) || modelIdTie(a, b), 'asc'],
  ],
};
const sortDef = (cat: string | null | undefined, key: string) => CAT_SORTS[cat ?? '']?.find(([v]) => v === key);
const defaultDir = (cat: string | null | undefined, key: string): 'asc' | 'desc' => sortDef(cat, key)?.[3] || 'asc';

// opinionated per-category default sorts (the most useful browse order);
// a user-chosen sort persists per category in localStorage
const DEFAULT_SORT: Record<string, string> = { meshes: 'triangles', rigs: 'bones', audio: 'duration', images: 'resolution', models: 'name', world: 'name', anims: 'named' };
const SORTS_KEY = 'bs.listSorts';
function loadCatSort(cat: string): { sort?: string; dir?: 'asc' | 'desc' } | null {
  try { return (JSON.parse(localStorage.getItem(SORTS_KEY)!) || {})[cat] || null; } catch { return null; }
}
function saveCatSort(cat: string, sort: string, dir: string): void {
  let all: Record<string, any> = {};
  try { all = JSON.parse(localStorage.getItem(SORTS_KEY)!) || {}; } catch { /* */ }
  all[cat] = { sort, dir };
  try { localStorage.setItem(SORTS_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}

// active list filters persist per category (localStorage) so they survive
// navigating away and back, and page reloads.
const FILTERS_KEY = 'bs.listFilters';
// filter labels double as the persisted keys; renamed labels map old -> new
// here so saved filter state survives the rename (the old key holds the
// legacy en dash, written as \u2013 so the source itself stays dash-free)
const FILTER_KEY_RENAMES: Record<string, string> = { 'medium (128\u2013511px)': 'medium (128 to 511px)' };
function loadCatFilters(cat: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(FILTERS_KEY)!) || {};
    if (cat in all) {
      return new Set((all[cat] as string[]).map((k) => FILTER_KEY_RENAMES[k] ?? k));
    }
  } catch { /* fall through */ }
  return new Set(DEFAULT_FILTERS[cat] || []);            // first visit
}
function saveCatFilters(cat: string | undefined, filters: Set<string>): void {
  let all: Record<string, any> = {};
  try { all = JSON.parse(localStorage.getItem(FILTERS_KEY)!) || {}; } catch { /* */ }
  all[cat as string] = [...filters];   // empty array = deliberately cleared (beats defaults)
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}

class App {
  store: AppStore;
  viewerEl: HTMLElement;
  bannersEl: HTMLElement;
  detailsBody: HTMLElement;
  detailsTitle: HTMLElement;
  listHost: HTMLElement;
  tabsEl: HTMLElement;
  chipsEl: HTMLElement;
  filterEl: HTMLInputElement;
  sortEl: HTMLSelectElement;
  sortDirEl: HTMLButtonElement;
  searchInput: HTMLInputElement;
  search: GlobalSearch;

  cur: Route | null;
  view: AppView | null;
  vlist: VList | null;
  items: any[];
  filters: Set<string>;
  sort: string;
  sortDir: 'asc' | 'desc';
  pendingListFilter: string | null = null;   // set by global search's "see all in <cat>" footer
  private _navToken: number;
  private _rawMode: boolean;
  private _details: { title: string; node: HTMLElement | null; raw: any; extra: HTMLElement | null } | null;
  private _imagesIdx: IndexEntry[] | null;   // cached images index, for hash-resolving mesh texture rows
  private _imagesIdxLoading = false;
  private _systemModels: any[];  // read-only, active-version catalog
  private _systemModelsLoaded: boolean;
  private _bannerMsgs: Set<string>;
  private _diffFacets: FilterDef[] = [];
  private _pendingDiffFacet: { cat: string; kind: string } | null = null;

  constructor(store: AppStore) {
    this.store = store;
    this.viewerEl = document.getElementById('viewer')!;
    this.bannersEl = document.getElementById('banners')!;
    this.detailsBody = document.getElementById('details-body')!;
    this.detailsTitle = document.getElementById('details-title')!;
    this.listHost = document.getElementById('list-host')!;
    this.listHost.classList.add('kb-target');   // sidebar list owns ↑/↓ by default (picker takes over while open)
    this.tabsEl = document.getElementById('cat-tabs')!;
    this.chipsEl = document.getElementById('list-chips')!;
    this.filterEl = document.getElementById('list-filter') as HTMLInputElement;
    this.sortEl = document.getElementById('list-sort') as HTMLSelectElement;
    this.sortDirEl = document.getElementById('list-sort-dir') as HTMLButtonElement;

    this.cur = null;          // {cat,id,sub,pos}
    this.view = null;
    this.vlist = null;
    this.items = [];          // current category full item list
    this.filters = new Set();   // active list-filter labels (AND); empty = all
    this.sort = 'index';
    this.sortDir = 'asc';
    this._navToken = 0;
    this._rawMode = false;
    this._details = null;     // {title, node, raw, extra}
    this._imagesIdx = null;
    this._systemModels = [];
    this._systemModelsLoaded = false;
    this._bannerMsgs = new Set();

    this.store.addEventListener('fetcherror', (e) => this.banner((e as CustomEvent<FetchErrorDetail>).detail.message));
    // Background audit for stored client versions: a bundle that does not
    // belong with this version's datatable (mixed game versions, possible
    // for versions ingested before the per-object ingest gate) silently
    // shows impostor sub-images. Sampled, header-only, never blocks boot.
    if (typeof this.store.validateBundleConsistency === 'function') {
      setTimeout(async () => {
        try {
          const audit = await this.store.validateBundleConsistency!();
          if (audit?.mismatches?.length) {
            const sample = audit.mismatches.slice(0, 3).map((m) => `#${m.i}`).join(', ');
            this.banner(`This version's game images don't match its data tables `
              + `(${audit.mismatches.length}/${audit.checked} sampled objects differ, e.g. ${sample}): `
              + 'mixed game versions. Re-extract this version from one clean game folder '
              + '(Storage panel) to fix wrong textures.');
          }
        } catch { /* audit is best-effort */ }
      }, 4000);
    }
    // raw bundle evicted from storage -> one-file re-pick (never a re-extract)
    this.store.addEventListener('bundlemissing', async (e) => {
      const { openRepickDialog } = await import('./repick.js');
      openRepickDialog(this, (e as CustomEvent).detail);
    });

    document.getElementById('raw-toggle')!.addEventListener('click', () => {
      this._rawMode = !this._rawMode;
      document.getElementById('raw-toggle')!.classList.toggle('active', this._rawMode);
      this.renderDetails();
    });

    this.filterEl.addEventListener('input', debounce(() => this.refreshList(), 120));

    this.sortEl.addEventListener('change', () => {
      this.sort = this.sortEl.value;
      this.sortDir = defaultDir(this.cur?.cat, this.sort);   // each sort opens in its natural direction
      if (this.cur?.cat) saveCatSort(this.cur.cat, this.sort, this.sortDir);
      this.syncSortDir();
      this.refreshList({ keepScroll: false });
    });
    this.sortDirEl.addEventListener('click', () => {
      this.sortDir = this.sortDir === 'desc' ? 'asc' : 'desc';
      if (this.cur?.cat) saveCatSort(this.cur.cat, this.sort, this.sortDir);
      this.syncSortDir();
      this.refreshList({ keepScroll: false });
    });

    window.addEventListener('hashchange', () => {
      const route = parseHash(location.hash);
      // navigating to an item lands its details in the right panel: surface it
      // if collapsed. Deliberately NOT done for the initial (load-time) route,
      // so a collapsed panel stays collapsed across reloads; the sidebar is
      // never auto-expanded.
      if (route?.id != null) expandPanelForContent('details');
      this.applyRoute(route);
    });

    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      const tag = (target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        this.searchInput.focus();
        this.searchInput.select();
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && this.vlist && !this.vlist.root.contains(target)
                 && !document.querySelector('.texpicker')) {   // picker owns arrows while open
        e.preventDefault();
        this.vlist.move(e.key === 'ArrowDown' ? 1 : -1);
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing
                 && (this.view as any)?.variantNav && !document.querySelector('.texpicker')) {
        // model variant strip: → enters/advances, ← retreats/exits to the list
        if ((this.view as any).variantNav(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
      } else if ((e.key === ' ' || e.key === 'Enter') && !typing
                 && tag !== 'button' && tag !== 'a' && this.view?.togglePlay
                 && !document.querySelector('.texpicker')) {
        // Space/Enter previews the selected track: toggle the mounted viewer's
        // playback. Works regardless of focus (like the arrow keys above); only
        // audio implements togglePlay, so it's inert for other categories. Native
        // Space/Enter on buttons/links is left alone.
        e.preventDefault();   // Space would otherwise scroll the list
        this.view.togglePlay();
      }
    });

    // every fixed panel is user-resizable (widths persist in localStorage)
    makeResizable(document.getElementById('sidebar'), { edge: 'right', key: 'sidebar', min: 220, max: 640 });
    makeResizable(document.getElementById('details'), { edge: 'left', key: 'details', min: 220, max: 720 });
    // ... and both side panels collapse to a chevron rail (panels.ts; runs
    // after makeResizable so a collapsed boot can clear its inline width)
    initPanels();

    this.searchInput = document.getElementById('global-search') as HTMLInputElement;
    this.search = new GlobalSearch(this, this.searchInput, document.getElementById('search-results')!);

    document.getElementById('help-btn')?.addEventListener('click', () => openHelpModal());
    document.getElementById('overrides-btn')!.addEventListener('click', () => this.openOverridesPanel());

    // Build version in the topbar: click it to open "What's new" (the current
    // release's changelog). The full version + commit also lives in Help.
    const badgeEl = document.getElementById('build-badge');
    if (badgeEl) {
      const setBadge = () => { badgeEl.textContent = buildVersionLabel(); };
      setBadge();
      buildInfoReady.then(setBadge);
      badgeEl.title = "What's new: this release's changes";
      badgeEl.addEventListener('click', () => openWhatsNew());
    }
    // Auto-show "What's new" once when the app has updated since the last visit.
    maybeAutoShowWhatsNew();

    // client-extracted data can be materialized back to disk (Chromium FSA)
    const exportBtn = document.getElementById('export-btn');
    if (exportBtn && this.store.versionId) {
      exportBtn.hidden = false;
      exportBtn.addEventListener('click', async () => {
        const { openExportDialog } = await import('./export-disk.js');
        openExportDialog(this);
      });
    }
  }

  // ------------------------------------------------------------------ overrides manager
  // THE key persistent artifact: one asset_overrides.json holding texture
  // overrides + friendly names (both hash-keyed). Edits anywhere in the app
  // update it live (via localStorage); this modal is the ONLY place to
  // preview it, export it to disk, or load one in (replacing the local sets).
  // index fetch guarded by the manifest: categories a data source doesn't have
  // resolve to [] with no request
  async idx(cat: string): Promise<IndexEntry[]> {
    if (!this.store.manifest?.categories?.[cat]) return [];
    try { return await this.store.index(cat); } catch { return []; }
  }

  async loadSystemModels(): Promise<any[]> {
    if (this._systemModelsLoaded) return this._systemModels;
    this._systemModelsLoaded = true;
    const rel = this.store.manifest?.system?.models;
    if (!rel) return this._systemModels;
    try {
      const models = await this.store.fetchJSON(rel);
      this._systemModels = Array.isArray(models) ? models : [];
    } catch { this._systemModels = []; }
    return this._systemModels;
  }

  allModels(): any[] { return combineModels(this._systemModels, listModels()); }

  async buildAnnotationsFile() {
    const idxs: Record<string, IndexEntry[]> = {};
    // world rooms have no content-hash identity, so they carry no annotations
    for (const c of CATS) { if (USER_CATS.has(c.key) || c.key === 'world') continue; idxs[c.key] = await this.idx(c.key); }
    return {
      version: 2,
      algo: 'sha256/16',
      overrides: buildOverridesFile(idxs.meshes || [], idxs.images || []).overrides,
      names: buildNamesFile(idxs).names,
      models: buildModelsSection(),
    };
  }

  async openOverridesPanel(): Promise<void> {
    const overlay = el('div', { class: 'modal-overlay' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const body = el('div', { class: 'modal-body' });
    const render = async () => {
      const fileObj = await this.buildAnnotationsFile();
      clear(body);
      append(body,
        el('p', { class: 'dim small' },
          `${fmtInt(Object.keys(fileObj.overrides).length)} texture override(s) · `
          + `${fmtInt(Object.keys(fileObj.names).length)} name(s) · `
          + `${fmtInt(Object.keys(fileObj.models || {}).length)} model(s)`),
        el('pre', { class: 'rawjson modal-json', text: JSON.stringify(fileObj, null, 1) }));
      return fileObj;
    };

    const exportBtn = el('button', { class: 'btn', text: '⭳ export JSON' });
    exportBtn.addEventListener('click', async () => {
      const fileObj = await this.buildAnnotationsFile();
      const blob = new Blob([JSON.stringify(fileObj, null, 1)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: 'asset_overrides.json' });
      a.click();
      URL.revokeObjectURL(a.href);
      this.banner(`Saved ${fmtInt(Object.keys(fileObj.overrides).length)} texture assignment(s) and ${fmtInt(Object.keys(fileObj.names).length)} name(s) to asset_overrides.json.`, 'b-info');
    });
    const fileInput = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        if (!obj || (typeof obj.overrides !== 'object' && typeof obj.names !== 'object' && typeof obj.models !== 'object')) {
          throw new Error('this file has no names, texture assignments or models in it');
        }
        const nOv = obj.overrides ? replaceOverrides(obj.overrides) : null;
        const nNm = obj.names ? replaceNames(obj.names) : null;
        const nMd = obj.models ? replaceModels(obj.models) : null;
        this.banner(`Loaded${nOv != null ? ` ${nOv} texture assignment(s)` : ''}${nNm != null ? ` ${nNm} name(s)` : ''}${nMd != null ? ` ${nMd} model(s)` : ''}, replacing what was saved in this browser.`, 'b-info');
        await render();
        this.renderTabs();
        this.reloadUserItems();   // user-cat sidebars list store snapshots: resync
        this.refreshList();
        this.mountView(this.cur!, ++this._navToken);   // re-texture/re-label the open view
      } catch (err) { this.banner(`Couldn't load that file: ${err.message}`); }
      fileInput.value = '';
    });
    const loadBtn = el('button', { class: 'btn', text: '⭱ load (replace)', title: 'Replace the names and texture assignments saved in this browser with an asset_overrides.json file' });
    loadBtn.addEventListener('click', () => fileInput.click());
    const clearBtn = el('button', { class: 'btn', text: '✕ clear', title: 'Delete every name and texture assignment saved in this browser.' });
    clearBtn.addEventListener('click', async () => {
      if (!clearBtn.classList.contains('active')) {   // click twice to confirm
        clearBtn.classList.add('active');
        clearBtn.textContent = '✕ really clear?';
        setTimeout(() => { clearBtn.classList.remove('active'); clearBtn.textContent = '✕ clear'; }, 3000);
        return;
      }
      replaceOverrides({});
      replaceNames({});
      replaceModels({});
      clearBtn.classList.remove('active');
      clearBtn.textContent = '✕ clear';
      this.banner('cleared all local overrides + names + models', 'b-info');
      await render();
      this.renderTabs();
      this.reloadUserItems();
      this.refreshList();
      this.mountView(this.cur!, ++this._navToken);
    });
    const closeBtn = el('button', { class: 'btn', text: 'Close' });
    closeBtn.addEventListener('click', close);

    overlay.appendChild(el('div', { class: 'modal card' },
      el('h2', { text: 'Overrides: texture assignments + names (any asset type)' }),
      body,
      el('div', { class: 'modal-actions' }, exportBtn, loadBtn, clearBtn, fileInput, el('span', { class: 'spacer' }), closeBtn)));
    await render();
    document.body.appendChild(overlay);
  }

  // the user-created categories' sidebar lists snapshot their stores: resync
  // after an overrides-file import/clear replaces the records wholesale
  reloadUserItems(): void {
    if (this.cur?.cat === 'models') this.items = this.allModels();
  }

  // topbar version chip: the active version's friendly name/label + platform
  // icon. Re-called after a rename so the chip tracks the new name live.
  refreshVersionChip(): void {
    const chip = document.getElementById('data-source');
    if (!chip || !this.store.versionId) return;
    chip.textContent = versionLabel(this.store.version) || this.store.versionId.slice(0, 8);
    const pIcon = platformIcon(this.store.version?.platform, this.store.version?.platformSource);
    if (pIcon) chip.append(' ', pIcon);
  }

  // ------------------------------------------------------------------ boot
  async start(): Promise<void> {
    const chip = document.getElementById('data-source')!;
    if (this.store.versionId) {
      this.refreshVersionChip();
      chip.title = `Extracted in this browser from your bundles (version ${this.store.versionId}`
        + '). Click for storage & versions: switch/add/delete '
        + 'versions, extract more categories, persistence.';
      chip.classList.add('chip-btn', 'btn-mini');
      chip.addEventListener('click', async () => {
        const { openStoragePanel } = await import('./versions.js');
        openStoragePanel(this);
      });
      // build labels can ship after a build was extracted: backfill stored
      // versions in the background and live-refresh the chip if the active
      // version just gained its real name
      void (async () => {
        try {
          const { backfillProfileLabels } = await import('./versions.js');
          const updated = await backfillProfileLabels();
          const fresh = updated.get(this.store.versionId!);
          if (fresh && this.store.version) {
            this.store.version.profileLabel = fresh;
            this.refreshVersionChip();
          }
        } catch { /* best-effort */ }
      })();
    } else {
      chip.textContent = `${this.store.base}/`;
    }
    const manifest = await this.store.loadManifest();
    if (manifest) await this.loadSystemModels();
    this.renderTabs();
    this.renderCompareChip();
    if (!manifest) {
      this.searchInput.placeholder = 'no data exported yet';
      this.searchInput.disabled = true;
      this.setStatus1('no data');
      this.showOnboarding();
      return;
    }
    this.setStatus1(`${this.store.base}/ · exported ${manifest.generated || '?'}`);
    const h = location.hash;
    const parsed = parseHash(h);
    // First entry (no route) and unknown/removed routes land on the meshes
    // category card, the same plain landing box every category shows.
    const route = parsed || { cat: 'meshes', id: null };
    await this.applyRoute(route, { replace: true });
    showPendingNotices(this);   // one-time migration notices (fire-and-forget)
  }

  showOnboarding(): void {
    // explicit ?data= means the user asked for a specific HTTP tree: keep the
    // static-tree guidance instead of the client-extraction wizard
    if (new URLSearchParams(location.search).get('data')) {
      clear(this.viewerEl);
      this.viewerEl.appendChild(placeholderCard('No data found',
        el('p', { text: 'Nothing was found at:' }),
        el('pre', { text: `webapp/${this.store.base}/manifest.json` }),
        el('p', { text: 'Place a pre-exported data tree there, then serve the app:' }),
        el('pre', { text: 'cd webapp && python3 -m http.server 8321' }),
        el('p', {},
          'Or try the tiny built-in demo dataset: ',
          el('a', { href: '?data=data-fixtures', text: 'load fixtures' }), '.')));
      return;
    }
    clear(this.viewerEl);
    mountOnboarding(this.viewerEl, { onDone: () => location.reload() });
  }

  // the version being compared against (sessionStorage-backed), or null
  diffBaseId(): string | null {
    const id = sessionStorage.getItem('bs.diffBase');
    return id && id !== this.store.versionId ? id : null;
  }

  // "jump to diff" from the diff view: open a category's list with only its
  // requested diff facet (added/changed/moved) applied (see applySelection).
  // Setting the diff base turns on compare mode so the list gains diff facets.
  jumpToDiffFacet(cat: string, kind = 'added', baseId: string | null = null): void {
    if (baseId) sessionStorage.setItem('bs.diffBase', baseId);
    this._pendingDiffFacet = { cat, kind };
    const route = CATS.find((c) => c.key === cat)?.route;
    if (route) location.hash = `#/${route}`;
  }

  // ------------------------------------------------------------------ compare chip
  // when a diff base is set, a compact topbar chip opens the diff view /
  // leaves compare mode (compare is entered from the storage panel)
  async renderCompareChip(): Promise<void> {
    document.getElementById('compare-chip')?.remove();
    const baseId = this.diffBaseId();
    if (!baseId || !this.store.versionId) return;
    const base = await getVersion(baseId);
    const host = el('span', { id: 'compare-chip' });
    const open = el('button', { class: 'btn-mini diff-link', text: `Δ diff vs ${versionLabel(base) || baseId.slice(0, 8)}`, title: 'Compare mode is on. Open the full diff view (list filters gain diff facets)' });
    open.addEventListener('click', () => { location.hash = `#/diff/${baseId}..${this.store.versionId}`; });
    const stop = el('button', { class: 'btn-mini', text: '✕', title: 'Leave compare mode' });
    stop.addEventListener('click', () => {
      sessionStorage.removeItem('bs.diffBase');
      this.renderCompareChip();
      this.loadCategoryList(this.cur!.cat, ++this._navToken);
    });
    host.append(open, stop);
    document.getElementById('data-source')!.before(host);
  }

  // ------------------------------------------------------------------ tabs
  renderTabs(): void {
    clear(this.tabsEl);
    const m = this.store.manifest;
    for (const cat of CATS) {
      // user-created categories (not in the manifest) count from their stores
      const userCount = cat.key === 'models' ? modelCount() + this._systemModels.length : null;
      const catInfo: any = m?.categories?.[cat.key];
      const count = userCount ?? (catInfo?.count ?? 0);
      const exported = userCount ?? (catInfo?.exported ?? 0);
      const partial = exported != null && exported < count;
      const btn = el('button', { class: 'cat-tab', dataset: { cat: cat.key } },
        el('span', { class: 'ct-icon', text: cat.icon }),
        el('span', { class: 'ct-name', text: cat.label }),
        el('span', {
          class: `ct-count${partial ? ' partial' : ''}`,
          text: count == null ? '' : fmtInt(count),
          title: partial ? `${fmtInt(exported)} of ${fmtInt(count)} exported` : '',
        }));
      btn.addEventListener('click', () => {
        // images: the tab IS the master grid, so always go there (the breadcrumb
        // in the detail view is the way back too)
        if (cat.key === 'images') { location.hash = '#/images'; return; }
        const last = sessionStorage.getItem(`bs.last.${cat.key}`);
        if (last != null && last !== '') location.hash = `#/${cat.route}/${last}`;
        else location.hash = `#/${cat.key}`;
      });
      // "?" opens the category overview (the id-less route). It's a SIBLING of the
      // tab button (never nested inside it) so the markup stays valid and each
      // control is independently focusable/announced. It reaches the overview
      // WITHOUT restoring bs.last.<cat>, so a normal tab click still reopens the
      // last-viewed item.
      const help = el('button', {
        class: 'ct-help', type: 'button',
        title: `What's in ${cat.label}? Open the overview`,
        'aria-label': `About ${cat.label}`,
      }, '?');
      // images has no id-less "list landing" (its root is the grid), so its "?"
      // targets a dedicated overview sub-route; every other category's root IS
      // its overview.
      const overviewHash = cat.key === 'images' ? '#/image/about' : `#/${cat.route}`;
      help.addEventListener('click', () => { location.hash = overviewHash; });
      this.tabsEl.appendChild(el('div', { class: 'cat-tab-row' }, btn, help));
    }
  }

  // ------------------------------------------------------------------ routing
  async applyRoute(route: Route | null, { replace = false }: { replace?: boolean } = {}): Promise<void> {
    if (!this.store.manifest) return;
    route ||= { cat: 'meshes', id: null };
    const token = ++this._navToken;
    const catChanged = route.cat !== this.cur?.cat;
    this.cur = route;

    this.tabsEl.querySelectorAll<HTMLElement>('.cat-tab').forEach((t) => t.classList.toggle('active', t.dataset.cat === route.cat));

    if (route.cat === 'diff') {   // full-viewer route, no sidebar list
      this.mountView(route, token);
      return;
    }

    // reload the list when the category changed, or when a previous load was
    // cancelled mid-flight by a navigation (items empty for an asset category)
    if (catChanged || (ordinalCat(route.cat) && !this.items.length)) {
      if (catChanged) {
        this.filters = loadCatFilters(route.cat);   // restore the saved filters for this category
        this.filterEl.value = '';
      }
      await this.loadCategoryList(route.cat, token);
      if (token !== this._navToken) return;
    }
    await this.applySelection(route, token, catChanged);
  }

  async loadCategoryList(cat: string, token: number): Promise<void> {
    this.vlist?.destroy();
    this.vlist = null;
    clear(this.chipsEl);
    this.items = [];

    if (ASSET_CATS.has(cat)) {
      const idx = await this.idx(cat);
      if (token !== this._navToken) return;
      this.items = idx;
    } else if (cat === 'models') {
      await this.loadSystemModels();
      if (token !== this._navToken) return;
      const meshes = await this.idx('meshes');
      if (token !== this._navToken) return;
      this.items = attachModelVertexCounts(this.allModels(), meshes);
    } else if (cat === 'world') {
      // the rooms list lives in the world index (derived world:index /
      // world/index.json), not a manifest category index
      try {
        const wi = await this.store.worldIndex?.();
        if (token !== this._navToken) return;
        this.items = (wi?.rooms || []).map((r: any) => ({
          ...r, i: r.id ?? r.i, w: r.size?.[0] ?? r.w ?? null, h: r.size?.[1] ?? r.h ?? null,
        }));
      } catch { this.items = []; }
    }

    // compare mode: added/changed/moved/unchanged facets vs the diff base
    // (h-set membership, zero payload decode). World rooms carry the same
    // content-hash contract via their index entries; the pinned "All rooms"
    // row is derived and never enters the diff.
    this._diffFacets = [];
    const baseId = this.diffBaseId();
    if (baseId && this.store.versionId && (ASSET_CATS.has(cat) || cat === 'world')) {
      try {
        const baseIdx = cat === 'world'
          ? await import('./viewers/diff.js').then(({ loadWorldDiffIndex }) => loadWorldDiffIndex(baseId))
          : (await derivedGet(baseId, `index:${cat}`))?.filter(Boolean);
        if (baseIdx?.length && this.items.some((e) => e.h)) {
          const d = diffIndexes(baseIdx, this.items, cat);
          const addedH = new Set(d.added.map((e) => e.h));
          const changedH = new Set(d.changed.map((c) => c.active.h));
          const movedH = new Set(d.moved.map((m) => m.b.h));
          this._diffFacets = [
            [`diff: +added (${d.added.length})`, (e) => addedH.has(e.h)],
            [`diff: ~changed (${d.changed.length})`, (e) => changedH.has(e.h)],
            [`diff: moved (${d.moved.length})`, (e) => movedH.has(e.h)],
            ['diff: =unchanged', (e) => !addedH.has(e.h) && !changedH.has(e.h)],
          ];
          if (d.removed.length) {
            this.setStatus3(`${d.removed.length} removed vs base (see the diff view)`);
          }
        }
      } catch { /* base version index unavailable */ }
    }

    // a pending "jump to diff" from the diff view: apply ONLY the requested diff
    // facet (added/changed/moved), clearing every other filter for this category
    if (this._pendingDiffFacet?.cat === cat) {
      const prefix = ({ added: 'diff: +added', changed: 'diff: ~changed', moved: 'diff: moved' } as Record<string, string>)[this._pendingDiffFacet.kind];
      const facet = this._diffFacets.find(([l]) => l.startsWith(prefix));
      if (facet) { this.filters = new Set([facet[0]]); saveCatFilters(cat, this.filters); }
      this._pendingDiffFacet = null;
    }

    // a pending list-filter query (search's "see all N in <cat> ▸" footer)
    if (this.pendingListFilter != null) {
      this.filterEl.value = this.pendingListFilter;
      this.pendingListFilter = null;
    }

    // sort dropdown (per-category options) + direction toggle
    const sorts = CAT_SORTS[cat];
    this.sortEl.hidden = !sorts;
    if (sorts) {
      clear(this.sortEl);
      for (const [value, label] of sorts) this.sortEl.appendChild(el('option', { value, text: label }));
      // saved per-category choice > opinionated default > index order
      const saved = loadCatSort(cat);
      this.sort = (saved?.sort && sorts.some(([v]) => v === saved.sort)) ? saved.sort
        : (DEFAULT_SORT[cat] && sorts.some(([v]) => v === DEFAULT_SORT[cat])) ? DEFAULT_SORT[cat] : 'index';
      this.sortDir = saved?.dir || defaultDir(cat, this.sort);
      this.sortEl.value = this.sort;
    } else {
      this.sort = 'index';
    }
    this.syncSortDir();

    // filter dropdown (checkboxes, AND semantics)
    this.buildFilterUI(cat);

    const catDef = CATS.find((c) => c.key === cat)!;
    this.vlist = new VList({
      host: this.listHost,
      rowHeight: catDef.row,
      render: (item, row, io) => this.renderRow(cat, item, row, io),
      onSelect: (item) => this.onListSelect(cat, item),
    });
    this.refreshList({ keepScroll: false });
    this.setStatus2(`${CATS.find((c) => c.key === cat)!.label}: ${fmtInt(this.items.length)} entries`);
  }

  // reflect the current sort direction on the toggle button (↓ desc / ↑ asc)
  syncSortDir(): void {
    if (!this.sortDirEl) return;
    const on = !this.sortEl.hidden;
    this.sortDirEl.hidden = !on;
    this.sortDirEl.textContent = this.sortDir === 'desc' ? '↓' : '↑';
    this.sortDirEl.title = `Sort direction: ${this.sortDir === 'desc' ? 'descending' : 'ascending'} (click to flip)`;
  }

  // static per-category filters + dynamic facets (strings namespaces,
  // compare-mode diff states)
  catFilters(cat: string | undefined): FilterDef[] {
    return [...(FILTERS[cat ?? ''] || []), ...(this._diffFacets || [])];
  }

  // checkbox-dropdown filter for the current category (multiple check = AND)
  buildFilterUI(cat: string | undefined): void {
    clear(this.chipsEl);
    const filters = this.catFilters(cat);
    if (!filters.length) return;
    const dd = el('details', { class: 'filter-dd' });
    const sum = el('summary', { title: 'Filter the list: shows items matching ALL checked filters (AND)' });
    const panel = el('div', { class: 'filter-panel' });
    const syncSum = () => { sum.textContent = this.filters.size ? `Filter · ${this.filters.size}` : 'Filter'; };
    for (const [label, , tip] of filters) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = this.filters.has(label);
      cb.addEventListener('change', () => {
        if (cb.checked) this.filters.add(label); else this.filters.delete(label);
        saveCatFilters(cat, this.filters);
        syncSum();
        this.refreshList();
      });
      panel.appendChild(el('label', { class: 'filter-opt', ...(tip ? { title: tip } : {}) }, cb, el('span', { text: label })));
    }
    const clr = el('button', { class: 'filter-clear', text: 'clear all' });
    clr.addEventListener('click', () => {
      this.filters.clear();
      saveCatFilters(cat, this.filters);
      panel.querySelectorAll('input').forEach((x) => { x.checked = false; });
      syncSum();
      this.refreshList();
    });
    panel.appendChild(clr);
    syncSum();
    dd.append(sum, panel);
    this.chipsEl.appendChild(dd);
  }

  filteredItems(): any[] {
    const cat = this.cur?.cat;
    let arr = this.items;
    const filters = this.catFilters(cat);
    if (filters.length && this.filters.size) {
      const preds = filters.filter(([l]) => this.filters.has(l)).map(([, p]) => p);
      if (preds.length) arr = arr.filter((it) => preds.every((p) => p(it)));   // AND
    }
    const q = this.filterEl.value.trim().toLowerCase();
    if (q) arr = arr.filter((it) => this.hay(cat, it).includes(q));
    const cmp = sortDef(cat, this.sort)?.[2];
    if (cmp) {
      const dir = this.sortDir === 'desc' ? -1 : 1;
      arr = [...arr].sort((a, b) => dir * cmp(a, b));
    }
    // the pinned merged-world entry rides above the rooms, immune to
    // sort/filter (prepended last so comparators/predicates never see it)
    if (cat === 'world' && this.items.length) arr = [WORLD_ALL_ROW, ...arr];
    return arr;
  }

  hay(cat: string | undefined, it: any): string {
    const extra = `${it.h || ''} ${(effectiveName(it, cat!) || '').toLowerCase()}`;
    switch (cat) {
      case 'meshes': return `${it.i} ${it.sk ? 'skinned' : 'static'} ${it.slot || ''} ${((it.sn || []) as string[]).join(' ')} ${extra}`.toLowerCase();
      case 'audio': return `${it.i} ${it.codec} ${extra}`;
      case 'images': return `${it.i} ${it.cat || ''} ${extra}`;
      case 'anims': return `${it.i} skel ${it.skel} ${((it.sn || []) as string[]).join(' ').toLowerCase()} ${extra}`;
      case 'rigs': return `${it.i} ${it.bones} ${extra}`;
      case 'strings': return `${it.i} ${it.src || ''} ${it.text} ${it.h || ''}`.toLowerCase();
      case 'models': return `${(it.name || '').toLowerCase()} ${it.id}`;
      case 'world': return `${it.i} ${(it.name || '').toLowerCase()}`;
      default: return String(it.i ?? '');
    }
  }

  refreshList({ keepScroll = true }: { keepScroll?: boolean } = {}): void {
    if (!this.vlist) return;
    const items = this.filteredItems();
    this.vlist.setItems(items, { keepScroll });
    this.view?.setItems?.(items);   // grid landings (images) mirror the list
    // keep selection highlighted if still present
    const selIdx = this.findSelectionIndex(items);
    this.vlist.setSelectedIndex(selIdx, { reveal: false });
    const shown = items.length - (items[0]?.__worldAll ? 1 : 0);   // pinned row isn't an entry
    this.setStatus2(`${CATS.find((c) => c.key === this.cur?.cat)?.label || ''}: ${fmtInt(shown)}${shown !== this.items.length ? ` / ${fmtInt(this.items.length)}` : ''} entries`);
  }

  findSelectionIndex(items: any[]): number {
    const r = this.cur;
    if (!r) return -1;
    if (isWorldAllRoute(r)) return items.findIndex((it) => it.__worldAll);
    if (ordinalCat(r.cat) && r.id != null) {
      return items.findIndex((it) => it.i === r.id);
    }
    if (USER_CATS.has(r.cat) && r.id != null) return items.findIndex((it) => it.id === r.id);
    return -1;
  }

  onListSelect(cat: string, item: any): void {
    if (cat === 'world' && item.__worldAll) {
      sessionStorage.setItem('bs.last.world', 'all');   // World tab returns here
      location.hash = '#/world/all';
      return;
    }
    if (USER_CATS.has(cat)) {
      sessionStorage.setItem(`bs.last.${cat}`, item.id);
      location.hash = `#/${CATS.find((c) => c.key === cat)!.route}/${item.id}`;
      return;
    }
    if (!ordinalCat(cat)) return;
    const id = item.i;
    sessionStorage.setItem(`bs.last.${cat}`, String(id));
    const route = CATS.find((c) => c.key === cat)!.route;
    location.hash = `#/${route}/${id}`;
  }

  // ------------------------------------------------------------------ rows
  renderRow(cat: string, item: any, row: HTMLElement, io: IntersectionObserver): void {
    const notEx = ASSET_CATS.has(cat) && !(item.f && item.f.length !== 0);
    // primary visual id = stable content hash (short); ordinal in the tooltip
    const rid = (it: any) => el('span', { class: 'r-id', text: idLabel(it), title: `#${it.i}${it.h ? ` · ${it.h}` : ''}` });
    const name = effectiveName(item, cat);
    const main = (txt: string) => el('span', { class: `r-main${name ? '' : ' dim'}`, text: name ? `${name} · ${txt}` : txt, title: name || '' });
    switch (cat) {
      case 'models': {
        const variants = modelVariantCount(item);
        append(row,
          el('span', { class: 'r-id r-model-id', text: item.source === 'system' ? '❖ˢ' : '❖', title: item.id }),
          el('span', { class: `r-main${item.name ? '' : ' dim'}`, text: item.name || 'Untitled model', title: item.name || '' }),
          el('span', {
            class: 'r-meta',
            text: `${fmtInt(modelMeshCount(item))}m · ${fmtInt(modelVertexCount(item))}v · ${fmtInt(variants)}var`,
            title: `${fmtInt(modelMeshCount(item))} mesh${modelMeshCount(item) === 1 ? '' : 'es'} · ${fmtInt(modelVertexCount(item))} vertices · ${fmtInt(variants)} recovered whole-model variant${variants === 1 ? '' : 's'}`,
          }));
        break;
      }
      case 'meshes': {
        const ovs = overrideStatus(item);
        const sys = systemTextureStatus(item);
        append(row,
          rid(item),
          main(`${fmtInt(item.v)}v · ${fmtInt(item.t)}t`),
          item.sk ? badge('S', 'b-accent b-ghost', `skinned, rig ${item.skel} (shared by ${fmtInt(item.share)} meshes, ${fmtInt(item.clips)} clips)`) : null,
          sys === 'image' ? badge('Tˢ', 'b-good b-ghost', `${item.sys.variants.length} built-in texture variant${item.sys.variants.length === 1 ? '' : 's'}`) : null,
          ovs === 'image' ? badge('T', 'b-good b-ghost', 'texture override set') : ovs === 'cleared' ? badge('T∅', 'b-ghost', 'override: no texture (cleared)') : null,
          // recovered wearable-item name (world extraction): display layer only,
          // the hash-keyed user name (via main()) still outranks it
          !name && item.sn?.length ? el('span', {
            class: 'r-meta', text: item.sn[0], title: item.sn.join('\n'),
          }) : null,
          el('span', { class: 'r-meta', text: notEx ? '∅' : '' }));
        break;
      }
      case 'audio':
        append(row,
          rid(item),
          main(item.codec + (item.approx ? ' ~' : '')),
          el('span', { class: 'r-meta', text: notEx ? '∅' : `${fmtDur(item.dur)} · ${item.ch}ch` }));
        break;
      case 'images': {
        const thumb = el('div', { class: 'r-thumb' });
        if (item.f && item.f.length) {
          thumb.dataset.src = this.store.url(item.f[0]);
          io.observe(thumb);
        } else {
          thumb.appendChild(el('span', { class: 'dim small', text: item.cat === 'font' ? 'F' : item.cat === 'lut' ? 'L' : '∅' }));
        }
        // headline the HIGHEST-res sub-image (mip 0); flag when the object holds
        // several stored resolutions rather than silently showing one.
        const top = imgMaxEntry(item);
        const nSizes = (item.entries || []).length;
        const sizesTip = nSizes > 1
          ? `${nSizes} stored sizes: ${imgSizesDesc(item).map((s: any) => `${s.w}×${s.h}`).join(', ')} · ${fmtBytes(imgBytes(item))} total`
          : (top ? `${top.fmt} · ${fmtBytes(imgBytes(item))}` : '');
        const metaTxt = top
          ? `${top.w}×${top.h}${nSizes > 1 ? ` · ${nSizes} sizes` : ''}`
          : (notEx ? '∅' : '');
        append(row,
          thumb,
          rid(item),
          main(item.cat || 'image'),
          el('span', { class: 'r-meta', text: metaTxt, title: sizesTip }));
        break;
      }
      case 'anims': {
        const ac = animClass(item);
        append(row,
          rid(item),
          main(`rig ${item.skel} · ${item.bones}b`),
          // recovered animatic name (world extraction): display layer only,
          // the hash-keyed user name (rid) still outranks it
          item.sn?.length ? el('span', {
            class: 'r-meta', text: item.sn[0], title: item.sn.join('\n'),
          }) : null,
          ac ? badge(ac.tag, ac.cls, ac.title) : null,
          el('span', { class: 'r-meta', text: notEx ? '∅' : `${item.frames}f · ${fmtDur(item.dur / 1000)}` }));
        break;
      }
      case 'rigs':
        append(row,
          rid(item),
          main(`${item.bones} bones`),
          el('span', { class: 'r-meta', text: notEx ? '∅' : '' }));
        break;
      case 'world': {
        if (item.__worldAll) {   // pinned merged-world entry (see WORLD_ALL_ROW)
          row.classList.add('vrow-all');
          append(row,
            el('span', { class: 'r-id', text: '⌂' }),
            el('span', { class: 'r-main', text: 'All' }),
            el('span', {
              class: 'r-meta', text: `${fmtInt(this.items.length)} rooms`,
              title: 'Open the whole world: every room merged into one 3D scene (heavy)',
            }));
          break;
        }
        const size = item.w && item.h ? `${item.w}×${item.h}` : '';
        append(row,
          el('span', { class: 'r-id', text: `#${item.i}`, title: `room #${item.i}` }),
          el('span', { class: `r-main${item.name ? '' : ' dim'}`, text: item.name || `Room ${item.i}`, title: item.name || '' }),
          el('span', { class: 'r-meta', text: size, title: size ? `${item.w} × ${item.h} tiles` : '' }));
        break;
      }
      case 'strings': {
        const snip = item.text.length > 90 ? `${item.text.slice(0, 90)}…` : item.text;
        append(row,
          el('span', { class: 'r-id', text: `#${item.i}`, title: `offset 0x${item.off.toString(16)}${item.h ? ` · ${item.h}` : ''}` }),
          el('span', { class: 'r-main', text: snip, title: item.text }),
          // meta only when it says something: how often the text repeats
          el('span', { class: 'r-meta', text: (item.n || 1) > 1 ? `×${item.n}` : '', title: (item.n || 1) > 1 ? `This exact text appears ${item.n} times in the game data.` : '' }));
        break;
      }
    }
  }

  // ------------------------------------------------------------------ selection / viewer
  async applySelection(route: Route, token: number, catChanged: boolean): Promise<void> {
    const items = this.filteredItems();
    let selIdx = this.findSelectionIndex(items);

    // navigated to an entry hidden by the current filter -> reset filters
    if (selIdx < 0 && ordinalCat(route.cat) && route.id != null && this.items.length) {
      if (this.filterEl.value || this.filters.size) {
        this.filterEl.value = '';
        this.filters.clear();
        this.buildFilterUI(this.cur?.cat);   // rebuild dropdown reflecting the cleared state
        this.refreshList();
        selIdx = this.findSelectionIndex(this.filteredItems());
      }
    }
    this.vlist?.setSelectedIndex(selIdx, { reveal: true, center: true });   // deep-link/refresh: centre the item

    this.mountView(route, token);
  }

  mountView(route: Route, token: number): void {
    if (token !== this._navToken) return;
    this.view?.destroy();
    this.view = null;
    clear(this.viewerEl);
    this._details = null;
    this.renderDetails();

    const { cat, id } = route;
    let entry: any = null;
    if (ASSET_CATS.has(cat) && id != null) {
      entry = this.items.find((it) => it.i === id);
      if (!entry && this.items.length) {
        this.viewerEl.appendChild(placeholderCard('Not found', el('p', { text: `No ${cat} entry with id ${id} in your files.` })));
        return;
      }
    }

    switch (cat) {
      case 'models': {
        if (id == null) return this.showCatLanding('Models', 'Open any rig, arrange its meshes and textures, then use ❖ Save as Model. Your saved models show up here. A single mesh can be saved too, from its own viewer.');
        const model = this.items.find((item) => item.id === id) || getModel(id as string);
        if (!model) return this.showCatLanding('Models', 'That model no longer exists. Pick another from the list.');
        this.setModelDetails(model);
        this.view = createModelView(this, model);
        break;
      }
      case 'meshes':
        if (!entry) return this.showCatLanding('Meshes', 'Pick a mesh from the list. Skinned meshes play their animations.');
        this.setEntryDetails(cat, entry);
        this.view = createMeshView(this, entry);
        break;
      case 'audio':
        if (!entry) return this.showCatLanding('Audio', 'Pick a sound to play it. Every clip plays right here in your browser.');
        this.setEntryDetails(cat, entry);
        this.view = createAudioView(this, entry);
        break;
      case 'images':
        if (!entry) {
          // the "?" lands here (#/image/about): show the section overview, like
          // every other category. A plain Images-tab click (#/images) skips this
          // and goes straight to the browsable grid.
          if (route.sub === 'about') {
            return this.showCatLanding('Images',
              'Every picture the game draws: textures, sprites, icons, skyboxes and fonts. Open one to see it full-size, zoom and pan, and step through its different resolutions.',
              el('p', {}, el('a', { class: 'landing-cta', href: '#/images', text: 'Browse all images →' })));
          }
          this.view = createImageGrid(this, this.filteredItems()); break;
        }
        this.setEntryDetails(cat, entry);
        this.view = createImageView(this, entry);
        break;
      case 'anims':
        if (!entry) return this.showCatLanding('Animations', 'Pick a clip to see how it moves, and play it back on its rig.');
        this.setEntryDetails(cat, entry);
        this.view = createAnimView(this, entry);
        break;
      case 'rigs':
        if (!entry) return this.showCatLanding('Rigs', 'Pick a rig to see its joints and bones, plus every animation that plays on it.');
        this.setEntryDetails(cat, entry);
        this.view = createSkeletonView(this, entry);
        break;
      case 'strings':
        if (!entry) return this.showCatLanding('Text', 'Every piece of text in the game: dialogue, on-screen labels, identifiers and symbols. Use the box above the list to filter.');
        this.setEntryDetails(cat, entry);
        this.view = createStringView(this, entry);
        break;
      case 'world': {
        // lazily loaded like diff: the room viewer (three.js) must not weigh
        // down the shell for users who never open the World tab
        const roomEntry = id != null ? (this.items.find((it) => it.i === id) || null) : null;
        if (roomEntry) this.setWorldDetails(roomEntry);
        const token2 = this._navToken;
        import('./viewers/world.js').then(({ createWorldView }) => {
          if (token2 !== this._navToken) return;
          this.view = createWorldView(this, roomEntry);
          this.viewerEl.appendChild(this.view!.root);
        });
        return;
      }
      case 'diff': {
        const token2 = this._navToken;
        import('./viewers/diff.js').then(({ createDiffView }) => {
          if (token2 !== this._navToken) return;
          this.view = createDiffView(this, route.baseId!, route.activeId!);
          this.viewerEl.appendChild(this.view!.root);
        });
        return;
      }
    }
    if (this.view) this.viewerEl.appendChild(this.view.root);
  }

  showCatLanding(title: string, text: string, ...extra: (HTMLElement | null)[]): void {
    const m: any = this.store.manifest?.categories?.[this.cur!.cat];
    this.viewerEl.appendChild(placeholderCard(title,
      el('p', { text }),
      ...extra,
      m ? el('p', { class: 'dim' }, `${fmtInt(m.exported)} of ${fmtInt(m.count)} loaded.`,
        m.exported < m.count ? ' The rest can be added from your game files.' : '') : null,
      el('p', { class: 'dim small' }, 'Keys: ', el('kbd', { text: '↑' }), ' ', el('kbd', { text: '↓' }), ' navigate list · ', el('kbd', { text: '/' }), ' search')));
  }

  // ------------------------------------------------------------------ details
  // Load + cache the images index once, then re-render the current mesh details
  // so its texture row can hash-resolve the override to a real image link.
  _ensureImagesIdx(cat: string, e: any): void {
    if (this._imagesIdx || this._imagesIdxLoading) return;
    this._imagesIdxLoading = true;
    this.store.index('images').then((idx) => {
      this._imagesIdx = idx;
      this._imagesIdxLoading = false;
      if (this._details?.raw === e && this.cur?.cat === cat) this.setEntryDetails(cat, e);
    }).catch(() => { this._imagesIdxLoading = false; });
  }

  setEntryDetails(cat: string, e: any): void {
    let pairs: [string, any][] = [];
    let extraNote: HTMLElement | null = null;
    if (cat === 'meshes') {
      pairs = [
        ['index', `#${e.i}`],
        ['vertices', fmtInt(e.v)], ['triangles', fmtInt(e.t)],
        ['skinned', e.sk ? 'yes' : 'no'],
        ['rig', e.skel >= 0 ? el('a', { href: `#/rig/${e.skel}`, text: `#${e.skel}` }) : (e.skel === -2 ? 'rigid (single bone)' : 'static')],
        ['group', isCreature(e) ? 'creature (its own rig)' : isPart(e) ? 'part (shared rig)' : e.sk ? 'skinned' : 'static'],
        ['slot', e.slot ? el('span', { text: e.slot, title: 'Which body part this piece covers (armour and clothing meshes).' }) : null],
        ['item name', e.sn?.length ? el('span', {
          title: 'Name recovered from the game data by the World extraction; your own names still override it in lists and pickers.',
          text: e.sn.join(' · '),
        }) : null],
        ['share', fmtInt(e.share ?? 0)],
        ['clips', fmtInt(e.clips ?? 0)],
        ['bounds min', e.bbox ? e.bbox.slice(0, 3).map((x: number) => fmtNum(x, 1)).join(', ') : null],
        ['bounds max', e.bbox ? e.bbox.slice(3, 6).map((x: number) => fmtNum(x, 1)).join(', ') : null],
        ['texture', (() => {   // live replace/supplement composition
          // resolve strictly by content hash (needs the images index), never by
          // a stale ordinal from another bundle build.
          if (this._imagesIdx == null) this._ensureImagesIdx(cat, e);
          const st = effectiveTex(e, this._imagesIdx);
          if (!st) return 'none';
          if (st.a == null) {
            if (st.local && st.active != null && st.variants > 0) {
              return this._imagesIdx == null ? 'resolving…' : "assigned texture isn't in your files";
            }
            if (st.src === 'system') return 'built-in texture unavailable in this export';
            return `none (${st.userLocal ? 'user choice in this browser' : 'user override'})`;
          }
          const image = entryByOrdinal(this._imagesIdx, st.a);
          if (!image) return st.src === 'system'
            ? 'built-in texture unavailable in this export'
            : "assigned texture isn't in your files";
          return el('span', {}, el('a', { href: `#/image/${image.i}`, text: `#${image.i}` }),
            ` · ${st.src === 'system' ? 'built-in system mapping' : st.local ? 'user override in this browser' : 'saved user override'}`);
        })()],
        ['texture variants', e.sys?.variants?.length
          ? `${fmtInt(e.sys.variants.length)} system${effectiveVariants(e).userCount ? ` + ${fmtInt(effectiveVariants(e).userCount)} user` : ''}`
          : null],
        ['file', e.f || 'not included'],
      ];
      extraNote = el('p', { class: 'small dim', text: 'share = other meshes that use this same rig; clips = animations that play on it (both 0 for static meshes).' });
    } else if (cat === 'audio') {
      pairs = [
        ['index', `#${e.i}`], ['codec', e.codec === 'bslpc' ? 'SFX' : e.codec],
        ['channels', e.ch], ['sample rate', `${fmtInt(e.sr)} Hz`],
        ['samples', fmtInt(e.n)], ['duration', fmtDur(e.dur)],
        ['file', e.f || 'not included'],
      ];
    } else if (cat === 'images') {
      pairs = [
        ['index', `#${e.i}`], ['category', e.cat],
        ['resolutions', e.n],
        ['formats', (e.entries || []).map((s: any) => s.fmt).filter((v: any, i: number, a: any[]) => a.indexOf(v) === i).join(', ') || '-'],
        ['sizes', imgSizesDesc(e).slice(0, 8).map((s: any) => `${s.w}×${s.h}`).join(', ') || '-'],
        ['data size', imgBytes(e) ? fmtBytes(imgBytes(e)) : '-'],
        ['files', e.f?.length ? `${e.f.length} file(s)` : 'not included'],
      ];
    } else if (cat === 'anims') {
      const ac = animClass(e);
      pairs = [
        ['index', `#${e.i}`],
        ['rig', el('a', { href: `#/rig/${e.skel}`, text: `#${e.skel}` })],
        ['bones', e.bones], ['duration', `${e.dur} ms`], ['frames', e.frames],
        ['behaviour', ac ? el('span', { title: ac.title, text: ac.tag }) : null],
        ['animatic', e.sn?.length ? el('span', {
          title: 'Name recovered from the game data by the World extraction; your own names still override it in lists and pickers.',
          text: e.sn.join(' · '),
        }) : null],
        ['file', e.f || 'not included'],
      ];
      extraNote = el('p', { class: 'small dim', text: 'Behaviour is worked out from how long the clip runs: a single-frame clip is a still pose, and 18 seconds or more is a long loop. Clips don\'t carry their in-game names.' });
    } else if (cat === 'rigs') {
      pairs = [['index', `#${e.i}`], ['bones', e.bones], ['file', e.f || 'not included']];
    } else if (cat === 'strings') {
      pairs = [
        ['index', `#${e.i}`],
        ['offset', el('span', { class: 'mono', text: `0x${e.off.toString(16)}`, title: "Where this text sits in the game's text data (first occurrence)." })],
        ['source', e.src === 'table' ? 'game text table' : 'data record'],
        ['occurrences', (e.n || 1) > 1 ? `×${e.n}` : null],
        ['length', fmtInt(e.text.length)],
      ];
    }
    if (e.h) pairs.push(['content id', el('span', { class: 'mono', text: e.h, title: 'A stable id for this asset: it stays the same across game updates, so the names and textures you add stay attached to it.' })]);
    const catDef = CATS.find((c) => c.key === cat)!;
    const body = el('div', {},
      cat === 'strings' ? null : this.nameEditor(cat, e),   // strings: the text IS the name
      kvTable(pairs),
      extraNote);
    const name = cat === 'strings' ? null : effectiveName(e, cat);
    this.setDetails(`${catDef.single} ${name || (cat === 'strings' ? `#${e.i}` : idLabel(e))}`, body, e);
  }

  // Details panel for a world room (read-only: rooms carry their in-game
  // names, so there is no name editor and no hash-keyed annotation row).
  setWorldDetails(r: any): void {
    const pairs: [string, any][] = [
      ['room', `#${r.i}`],
      ['name', r.name || null],
      ['size', r.w && r.h ? `${r.w} × ${r.h} tiles` : null],
      ['plane', r.world?.plane ?? null],
      ['world position', r.world && Number.isFinite(r.world.x) ? `${r.world.x}, ${r.world.y}` : null],
    ];
    this.setDetails(`Room ${r.name || `#${r.i}`}`, el('div', {}, kvTable(pairs)), r);
  }

  // optional friendly name, keyed by content hash (persisted locally; bundled
  // into asset_overrides.json via the topbar overrides manager)
  nameEditor(cat: string, e: any): HTMLElement {
    const input = el('input', {
      class: 'name-input', type: 'text',
      value: effectiveName(e, cat) || '',
      placeholder: 'add friendly name…',
      title: 'Optional name, persisted by content id. Enter to save.',
    });
    const commit = async () => {
      if ((effectiveName(e, cat) || '') === input.value.trim()) return;
      setLocalName(e, cat, input.value);
      // naming a mesh that is the ONLY mesh on its skeleton also names the rig
      if (cat === 'meshes' && e.skel >= 0 && e.share === 1) {
        try {
          const sk = (await this.store.index('rigs')).find((s) => s.i === e.skel);
          if (sk) setLocalName(sk, 'rigs', input.value);
        } catch { /* rigs index unavailable */ }
      }
      this.refreshList();
      this.setEntryDetails(cat, e);   // re-render title/rows with the new name
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
    return el('div', { class: 'name-edit' }, input);   // persistence: topbar "overrides" manager only
  }



  // Details panel for a Model: rename, a read-only mesh manifest, and delete.
  setModelDetails(model: any): void {
    if (model.source === 'system') {
      const parts = modelParts(model);
      const variant = modelVariant(model);
      const variants = modelVariants(model);
      const manifest = el('div', { class: 'model-manifest' },
        ...parts.map((part: any) => {
          const recolor = partRecolor(part);
          return el('div', { class: 'mm-item' },
            el('a', {
              class: 'mono small', href: `#/mesh/${part.mesh}`,
              text: part.mesh_hash?.slice(0, 8) || `#${part.mesh}`,
              title: `mesh #${part.mesh}`,
            }),
            el('span', { class: 'dim small', text: part.image != null
              ? `→ image #${part.image} · material ${part.material}` : `· material ${part.material} · untextured` }),
            part.local_matrix ? badge('xform', 'b-ghost', 'Recovered per-part local transform') : null,
            recolor ? badge(
              recolor.complete ? 'recolor ×3' : 'recolor ×2', 'b-ghost',
              recolor.complete
              ? 'Recovered two mask tints and output modulation'
              : 'Recovered two mask tints; native neutral output modulation is implicit',
            ) : null);
        }));
      const first = model.sources?.[0];
      const body = el('div', {},
        el('p', { class: 'small dim', text: 'Read-only built-in model recovered from exact owner-qualified mesh/material fields.' }),
        kvTable([
          ['source groups', fmtInt(model.sources?.length || 0)],
          ['variants', variants.length > 1
            ? `${fmtInt(variants.length)} · ${variant?.name || 'selected'}` : null],
          ['owner', first?.owner_slot != null ? `slot ${first.owner_slot}` : null],
          ['rule', first?.rule || null],
          ['rig', model.rig],
          ['rig #', model.skel_i != null
            ? el('a', { href: `#/rig/${model.skel_i}`, text: `#${model.skel_i}` }) : 'none / mixed'],
          ['meshes', fmtInt(parts.length)],
        ]),
        el('div', { class: 'details-section', text: 'ordered parts' }), manifest);
      this.setDetails(`System Model ${model.name}`, body, model);
      return;
    }
    const nameIn = el('input', {
      class: 'name-input', type: 'text', value: model.name || '', placeholder: 'model name…',
      title: 'Rename this model. Enter to save.',
    });
    const commit = () => {
      const v = nameIn.value.trim();
      if (!v || v === model.name) return;
      renameModel(model.id, v);
      model.name = v;
      this.refreshList();
      this.mountView(this.cur!, ++this._navToken);   // re-render title + viewer with the new name
    };
    nameIn.addEventListener('change', commit);
    nameIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') nameIn.blur(); });

    const manifest = el('div', { class: 'model-manifest' },
      ...model.meshes.map((m: any) => el('div', { class: 'mm-item' },
        el('span', { class: 'mono small', text: (m.h || '').slice(0, 8) }),
        el('span', { class: 'dim small', text: m.img ? `→ ${m.img.slice(0, 8)}` : '· untextured' }))));

    const del = el('button', { class: 'btn btn-mini', text: '✕ delete model' });
    del.addEventListener('click', () => {
      if (!del.classList.contains('active')) {   // click twice to confirm
        del.classList.add('active');
        del.textContent = '✕ really delete?';
        setTimeout(() => { del.classList.remove('active'); del.textContent = '✕ delete model'; }, 3000);
        return;
      }
      deleteModel(model.id);
      this.banner(`deleted model “${model.name}”`, 'b-info');
      this.renderTabs();
      if (this.cur?.cat === 'models') { this.items = this.allModels(); this.refreshList(); }
      location.hash = '#/models';
    });

    const body = el('div', {},
      el('div', { class: 'name-edit' }, nameIn),
      kvTable([
        ['rig', model.skel
          ? el('span', { class: 'mono', text: model.skel.slice(0, 8), title: model.skel })
          : 'none (static)'],
        ['meshes', fmtInt(model.meshes.length)],
        ['created', (model.created || '').slice(0, 10)],
      ]),
      el('div', { class: 'details-section', text: 'meshes' }),
      manifest,
      el('div', { class: 'asset-actions', style: 'margin-top:10px' }, del));
    this.setDetails(`Model ${model.name}`, body, model);
  }

  setDetails(title: string, node: HTMLElement | null, raw: any): void {
    this._details = { title, node, raw, extra: null };
    this.renderDetails();
  }

  setDetailsExtra(node: HTMLElement | null): void {
    if (!this._details) return;
    this._details.extra = node;
    this.renderDetails();
  }

  renderDetails(): void {
    const d = this._details;
    this.detailsTitle.textContent = d?.title || 'Details';
    clear(this.detailsBody);
    if (!d) {
      this.detailsBody.appendChild(el('div', { class: 'center-note small', text: 'Nothing selected.' }));
      return;
    }
    if (this._rawMode && d.raw != null) {
      this.detailsBody.appendChild(rawJson(d.raw));
      return;
    }
    if (d.node) this.detailsBody.appendChild(d.node);
    else if (d.raw != null) this.detailsBody.appendChild(rawJson(d.raw));
    if (d.extra) this.detailsBody.appendChild(d.extra);
  }

  // ------------------------------------------------------------------ chrome
  banner(msg: string, kind = ''): void {
    if (this._bannerMsgs.has(msg)) return;
    this._bannerMsgs.add(msg);
    while (this.bannersEl.children.length >= 4) this.bannersEl.firstChild!.remove();
    const node = el('div', { class: `banner ${kind}` },
      el('span', { text: msg }),
      el('button', { class: 'bn-close', text: '✕' }));
    node.querySelector('.bn-close')!.addEventListener('click', () => { node.remove(); this._bannerMsgs.delete(msg); });
    this.bannersEl.appendChild(node);
    document.getElementById('status-mid')!.innerHTML = `<span class="err">⚠ ${escapeText(msg).slice(0, 80)}</span>`;
  }

  setStatus1(t: string): void { document.getElementById('status-left')!.textContent = t; }
  setStatus2(t: string): void { document.getElementById('status-mid')!.textContent = t; }
  setStatus3(t: string): void { document.getElementById('status-right')!.textContent = t; }
}

function escapeText(s: string): string { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

export function parseHash(h: string | null | undefined): Route | null {
  const dm = (h || '').match(/^#\/?diff\/([0-9a-f]{16})\.\.([0-9a-f]{16})/);
  if (dm) return { cat: 'diff', baseId: dm[1], activeId: dm[2], id: null, sub: null, pos: null };
  const segs = (h || '').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!segs.length) return null;
  const cat = ALIAS[segs[0].toLowerCase()];
  if (!cat) return null;
  if (cat === 'models') return { cat, id: segs[1] || null, sub: null, pos: null };   // user-entity ids are hex strings, not ordinals
  const numeric = segs[1] != null && segs[1] !== '' && !Number.isNaN(parseInt(segs[1], 10));
  const id = numeric ? parseInt(segs[1], 10) : null;
  // a non-numeric second segment is a named sub-view, e.g. #/image/about
  const sub = !numeric && segs[1] ? segs[1].toLowerCase() : null;
  return { cat, id, sub, pos: null };
}

// annotations hydrate from IndexedDB (authoritative) before first render;
// a legacy localStorage set migrates transparently on first boot
async function boot(): Promise<void> {
  const [store] = await Promise.all([createStore(), hydrateOverrides(), hydrateNames(), hydrateModels()]);
  const app = new App(store);
  (window as any).__bs = { app };   // exposed for the smoke test
  app.start();
}

// Phones get the desktop-only gate INSTEAD of the app: when it mounts, the
// whole boot is skipped (no store, no service worker, no hydration): the
// gate is all the device pays for. Its escape hatch calls back into boot().
if (!maybeMountMobileGate(boot)) await boot();
