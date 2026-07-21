// Texture override picker, docked over the right-hand details panel so the
// 3D viewport stays fully visible while trying textures. Lists ab3 MATERIAL
// images only (the texture class world props actually use); thumbnails are the
// smallest albedo mip (f[0]) and lazy-load as they scroll into view (the grid
// can hold ~9.5k cells — decoding all of them up front serialized behind the
// service worker). Fast try-before-commit:
//   click / ↑↓←→  = select + live-preview on the mesh (debounced)
//   Enter / double-click / "use" = commit the override (persisted) and close
//   Esc / ✕                      = cancel and revert to the saved assignment
// Colour search: add one or more required colours (picker + or a pasted image's
//   palette); results are ranked to those that CONTAIN ALL the colours.

import { el, clear, fmtInt } from '../ui.js';
import { effectiveName } from '../names.js';
import { derivedGet, derivedPut } from '../storage.js';
import { localOverrideCount } from '../texmap.js';
import { buildFitFeatures } from './fit-score.js';
import type { FitFeatures } from './fit-score.js';
import type { AppStore, IndexEntry } from '../store.js';

// Fit scores + features are cached per mesh for the whole session, so re-opening
// the picker for the same mesh re-sorts instantly instead of re-scoring.
const _fitScores = new Map<string, Map<number, number>>();   // mesh key -> Map(image index -> fit score 0..1)
const _fitFeat = new Map<string, FitFeatures | null>();      // mesh key -> UV features (or null if no UVs)

// ---- colour analysis (session-cached) --------------------------------------
// Per-material colour SIGNATURE = the set of distinct colours PRESENT in the
// thumbnail (4-bit/channel bins over a 12x12 downsample), not just the average
// — so "contains colour X" is answerable. ~3,800 images take a couple of
// seconds on first use, then it's free for the rest of the session.
const _palette = new Map<number, Float32Array>();    // image index -> [r,g,b, r,g,b, ...] present colours

async function ensureSignatures(items: IndexEntry[], store: AppStore, onProgress?: (done: number, total: number) => void): Promise<void> {
  const todo = items.filter((e) => !_palette.has(e.i));
  const total = todo.length;
  if (!total) return;
  const N = 12;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  let done = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (todo.length) {
      const e = todo.pop()!;
      try {
        const img = new Image();
        img.src = store.url(e.f[0]);
        await img.decode();
        g.clearRect(0, 0, N, N);
        g.drawImage(img, 0, 0, N, N);   // sync draw+read: safe to share the canvas
        const d = g.getImageData(0, 0, N, N).data;
        const bins = new Map<number, number[]>();
        for (let k = 0; k < d.length; k += 4) {
          if (d[k + 3] <= 64) continue;
          const key = (d[k] >> 4) << 8 | (d[k + 1] >> 4) << 4 | (d[k + 2] >> 4);
          const b = bins.get(key) || [0, 0, 0, 0];
          b[0] += d[k]; b[1] += d[k + 1]; b[2] += d[k + 2]; b[3]++;
          bins.set(key, b);
        }
        const pal = new Float32Array(bins.size * 3);
        let i = 0;
        for (const b of bins.values()) { pal[i++] = b[0] / b[3]; pal[i++] = b[1] / b[3]; pal[i++] = b[2] / b[3]; }
        _palette.set(e.i, pal);
      } catch { _palette.set(e.i, new Float32Array(0)); }
      onProgress?.(++done, total);
    }
  }));
}

// dominant palette (up to 5 colours) of a pasted image, via 4-bit RGB bins
function extractPalette(img: HTMLImageElement): number[][] {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const g = cv.getContext('2d')!;
  g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();   // 12-bit bin
  for (let k = 0; k < d.length; k += 4) {
    if (d[k + 3] < 64) continue;
    const key = (d[k] >> 4) << 8 | (d[k + 1] >> 4) << 4 | (d[k + 2] >> 4);
    const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += d[k]; b.g += d[k + 1]; b.b += d[k + 2];
    bins.set(key, b);
  }
  return [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 5)
    .map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
}

// how well a palette CONTAINS query colour q: min squared-distance to any present colour
function presence(pal: Float32Array, q: number[]): number {
  let best = Infinity;
  for (let i = 0; i < pal.length; i += 3) {
    const d = (pal[i] - q[0]) ** 2 + (pal[i + 1] - q[1]) ** 2 + (pal[i + 2] - q[2]) ** 2;
    if (d < best) best = d;
  }
  return best;
}
// "contains ALL queries": rank by the worst-matched required colour (ascending).
// A texture missing any query colour has a large presence for it -> ranks last.
function containsScore(i: number, queries: number[][]): number {
  const pal = _palette.get(i);
  if (!pal || !pal.length) return Infinity;
  let worst = 0;
  for (const q of queries) { const p = presence(pal, q); if (p > worst) worst = p; }
  return worst;
}
const cssColor = (c: number[]) => `rgb(${c.map((x) => Math.round(x)).join(',')})`;
export const paletteOf = (i: number): Float32Array | undefined => _palette.get(i);   // test/debug hook

export interface TexturePickerOpts {
  host: HTMLElement;               // element to dock over (#details)
  store: AppStore;
  imagesIdx: IndexEntry[];         // images index array
  current: number | null;          // effective ab3 index
  baked: any;                      // mesh.tex baked into the export (user override) | null
  fitMesh?: { key: string; positions: ArrayLike<number>; uvs: ArrayLike<number>; index: ArrayLike<number> } | null;
  onPreview?: (imgEntry: IndexEntry) => void;   // live, non-persisted try-out
  onPick?: (imgEntry: IndexEntry) => void;      // commit override (persist)
  onPickMulti?: (imgEntries: IndexEntry[]) => void;
  onReset?: () => void;            // back to mapped
  onClear?: () => void;            // persist "no texture"
  onCancel?: () => void;           // closed without committing — revert any preview
  onBanner?: (msg: string) => void;
}

export function openTexturePicker({ host, store, imagesIdx, current, baked, fitMesh, onPreview, onPick, onPickMulti, onReset, onClear, onCancel }: TexturePickerOpts): { root: HTMLElement; close: () => void } {
  const items = imagesIdx.filter((e) => e.f?.length && e.cat === 'material');
  let match = items;
  let sel = -1;          // index into match (keyboard/click cursor)
  let cells: HTMLElement[] = [];   // rendered cells, cells[k] <-> match[k]
  let committed = false;
  let previewT = 0;
  let queries: number[][] = [];    // pinned required colours: [[r,g,b], ...]; "contains all"
  let pickTarget: number[] | null = null; // live single "target colour" from the picker (null = none by default)
  const activeColors = () => (pickTarget ? [...queries, pickTarget] : queries);
  let fitOn = false;          // whether Fit scores are being considered (independent of colour queries)
  let fitScores: Map<number, number> | null = fitMesh ? _fitScores.get(fitMesh.key) || null : null;
  let fitWorkers: Worker[] = [];
  let fitBtn: HTMLButtonElement | null = null, fitProg: HTMLProgressElement | null = null;   // assigned below when fitMesh is available

  const root = el('div', { class: 'texpicker' });
  const close = () => root.remove();
  const finish = (fn: ((...a: any[]) => void) | undefined, ...args: any[]) => { committed = true; fn?.(...args); close(); };

  // ctrl/cmd-click builds a multi-selection; Enter / "use" applies them all as
  // variants at once (else it commits the single keyboard/click cursor).
  const chosen = new Set<number>();   // image ids
  const chosenImgs = () => match.filter((e) => chosen.has(e.i));
  const doCommit = () => {
    const multi = chosenImgs();
    if (multi.length > 1 && onPickMulti) finish(onPickMulti, multi);
    else if (multi.length) finish(onPick, multi[0]);
    else if (match[sel]) finish(onPick, match[sel]);
  };

  const recomputeMatch = () => {
    const q = input.value.trim().toLowerCase();
    // haystack matches the rest of the app: index, content hash, friendly name
    match = q ? items.filter((e) => `#${e.i} ${e.i} ${e.h || ''} ${(effectiveName(e, 'images') || '').toLowerCase()}`.includes(q)) : items;
    const cols = activeColors(), useFit = fitOn && fitScores;
    if (useFit && cols.length) {
      // colour is the active query (primary); fit refines WITHIN the scored list.
      // badness = colour-absence (0 present … 1 absent) + a fit penalty, so a
      // clear colour match still wins but better-fitting textures rank higher.
      const badness = (i: number) => Math.min(1, containsScore(i, cols) / 12000) + 0.45 * (1 - (fitScores!.get(i) ?? 0));
      match = [...match].sort((a, b) => badness(a.i) - badness(b.i));
    } else if (useFit) {
      match = [...match].sort((a, b) => (fitScores!.get(b.i) ?? -Infinity) - (fitScores!.get(a.i) ?? -Infinity));
    } else if (cols.length) {
      match = [...match].sort((a, b) => containsScore(a.i, cols) - containsScore(b.i, cols));
    }
    sel = -1;
    renderGrid();
  };

  // ---- header: filter + close
  const input = el('input', {
    class: 'tp-filter', type: 'search',
    placeholder: `${fmtInt(items.length)} textures — ↑↓←→ preview · Enter use · Esc cancel`,
    title: 'Filter by image index, content hash or name; pick a colour (or paste an image) to sort by similarity. Arrows move + live-preview on the mesh, Enter commits, Esc cancels.',
  });
  input.addEventListener('input', recomputeMatch);
  const closeBtn = el('button', { class: 'btn', text: '✕', title: 'Close without applying your choice (Esc)' });
  closeBtn.addEventListener('click', close);

  // ---- actions: use selected / reset to mapped / clear
  const useBtn = el('button', { class: 'btn', text: '✓ use', disabled: true, title: 'Add the highlighted texture as a variant (Enter). Ctrl/⌘-click multiple to add several at once.' });
  useBtn.addEventListener('click', doCommit);
  const syncUse = () => {
    const n = chosen.size;
    useBtn.textContent = n > 1 ? `✓ use ${n}` : '✓ use';
    useBtn.disabled = n === 0 && sel < 0;
    useBtn.title = n > 1 ? `Add the ${n} selected textures as variants (Enter)` : 'Add the highlighted texture as a variant (Enter). Ctrl/⌘-click multiple to add several at once.';
  };
  const actions = el('div', { class: 'tp-actions' }, useBtn);
  if (baked && baked.a != null) {
    const b = el('button', { class: 'btn', text: `↩ saved #${baked.a}`, title: 'Discard your change and go back to the saved texture' });
    b.addEventListener('click', () => finish(onReset));
    actions.appendChild(b);
  }
  const clearBtn = el('button', { class: 'btn', text: '∅ none', title: 'Show this mesh with no texture at all' });
  clearBtn.addEventListener('click', () => finish(onClear));
  actions.appendChild(clearBtn);
  const selLbl = el('span', { class: 'dim small' });

  // ---- colour sort: a live "target colour" from the picker (changing it re-sorts
  // as you go), plus optional pinned colours (+ / paste) for a strict "contains
  // ALL" filter. Colours re-sort WITHIN the fit-scored list when Fit is on. No
  // target colour is set by default; clear the picker target with its ✕.
  const colorInput = el('input', { type: 'color', class: 'tp-color', value: '#999999', title: 'Target colour — changing it sorts textures by how well they contain it (live). Clear with ✕.' });
  const pickClearBtn = el('button', { class: 'btn tp-pickclear', text: '✕', hidden: true, title: 'Clear the target colour' });
  const addColorBtn = el('button', { class: 'btn tp-addcolor', text: '+', title: 'Pin this colour too — results must contain ALL pinned colours' });
  const swatches = el('span', { class: 'tp-swatches', title: 'Pinned colours (click a swatch to remove) — results contain ALL of them' });
  const colorOffBtn = el('button', { class: 'btn', text: '✕ colours', hidden: true, title: 'Clear all pinned colours' });
  const hexToRgb = (v: string) => [1, 3, 5].map((k) => parseInt(v.slice(k, k + 2), 16));

  const colorLabel = () => {
    const withFit = fitOn && fitScores, n = activeColors().length;
    return n ? `${n} colour(s)${withFit ? ' · within fit' : ''} — textures containing all`
      : (withFit ? `${fmtInt(fitScores!.size)} textures ranked by fit — best first` : '');
  };
  async function ensureColorSigs(): Promise<boolean> {
    if (!activeColors().length) return true;
    selLbl.textContent = 'analysing colours…';
    await ensureSignatures(items, store, (d, t) => { if (d % 500 === 0 || d === t) selLbl.textContent = `analysing colours… ${d}/${t}`; });
    return root.isConnected;
  }
  async function applyColors(): Promise<void> {
    if (!await ensureColorSigs()) return;
    clear(swatches);
    queries.forEach((c, qi) => {
      const sw = el('span', { class: 'tp-swatch', style: `background:${cssColor(c)}`, title: 'click to remove' });
      sw.addEventListener('click', () => { queries.splice(qi, 1); applyColors(); });
      swatches.appendChild(sw);
    });
    colorOffBtn.hidden = queries.length === 0;
    pickClearBtn.hidden = !pickTarget;
    colorInput.classList.toggle('tp-color-set', !!pickTarget);
    selLbl.textContent = colorLabel();
    recomputeMatch();
    grid.scrollTop = 0;
  }
  // changing the picker sets the live target and re-sorts immediately
  colorInput.addEventListener('input', () => { pickTarget = hexToRgb(colorInput.value); applyColors(); });
  pickClearBtn.addEventListener('click', () => { pickTarget = null; applyColors(); });
  addColorBtn.addEventListener('click', () => { queries.push(hexToRgb(colorInput.value)); pickTarget = null; applyColors(); });
  colorOffBtn.addEventListener('click', () => { queries = []; applyColors(); });
  const onPaste = (ev: ClipboardEvent) => {
    const file = [...(ev.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    ev.preventDefault();
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      queries.push(...extractPalette(img));   // pin the pasted image's dominant colours
      applyColors();
    };
    img.src = url;
  };
  document.addEventListener('paste', onPaste);
  actions.append(colorInput, pickClearBtn, addColorBtn, swatches, colorOffBtn, selLbl);

  // ---- "Fit" sort: score every material by how well it WRAPS this mesh -------
  // On-demand (never precomputed), parallelised across cores. Seam-colour
  // continuity + UV-island coverage; a candidate RANKER, not ground truth.
  async function runFit(): Promise<void> {
    if (!fitMesh) return;
    // toggle off -> stop considering the fit scores (colour/default order remains)
    if (fitOn) {
      fitOn = false;
      fitBtn!.classList.remove('active');
      selLbl.textContent = colorLabel();
      recomputeMatch();
      return;
    }
    // already scored this mesh this session -> just switch fit back on
    if (!_fitScores.has(fitMesh.key) && store.versionId) {
      // scores persist across sessions in client mode (they depend only on the
      // mesh UVs + this version's textures, both content-addressed)
      try {
        const arr = await derivedGet(store.versionId, `fitscores:${fitMesh.key}`);
        if (Array.isArray(arr) && arr.length) _fitScores.set(fitMesh.key, new Map(arr));
      } catch { /* idb unavailable (http mode) */ }
    }
    if (_fitScores.has(fitMesh.key)) {
      fitScores = _fitScores.get(fitMesh.key)!;
      fitOn = true;
      fitBtn!.classList.add('active');
      selLbl.textContent = colorLabel();
      recomputeMatch();
      grid.scrollTop = 0;
      return;
    }
    let feat = _fitFeat.get(fitMesh.key);
    if (feat === undefined) {
      try { feat = buildFitFeatures(fitMesh); } catch { feat = null; }
      _fitFeat.set(fitMesh.key, feat);
    }
    if (!feat) { selLbl.textContent = 'fit unavailable (no UVs)'; return; }

    fitBtn!.disabled = true;
    fitProg!.hidden = false; fitProg!.value = 0;
    selLbl.textContent = 'scoring fit… 0%';
    const jobs = items.map((e) => ({
      i: e.i, url: new URL(store.url(e.f[0]), location.href).href,
      nativeRes: Math.max(0, ...(e.entries || []).map((x: any) => x.w || 0)),   // for the texel-density prior
    }));
    const scores = new Map<number, number>();
    const N = Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4));
    const chunk = Math.ceil(jobs.length / N);
    const slices: typeof jobs[] = [];
    for (let w = 0; w < N; w++) { const s = jobs.slice(w * chunk, (w + 1) * chunk); if (s.length) slices.push(s); }
    let done = 0, finished = 0;
    await new Promise<void>((resolve) => {
      if (!slices.length) return resolve();
      slices.forEach((slice) => {
        // Bundle-relative: this code ships inside js/main.js, and the worker
        // entry is emitted at js/viewers/fit-worker.js (tools/build.ts).
        const worker = new Worker(new URL('./viewers/fit-worker.js', import.meta.url), { type: 'module' });
        fitWorkers.push(worker);
        worker.onmessage = (ev) => {
          const d = ev.data;
          if (d.done) { if (++finished === slices.length) resolve(); return; }
          if (d.fit != null) scores.set(d.i, d.fit);
          if (++done % 64 === 0 || done === jobs.length) {
            fitProg!.value = done / jobs.length;
            selLbl.textContent = `scoring fit… ${Math.round(100 * done / jobs.length)}%`;
          }
        };
        worker.onerror = () => { if (++finished === slices.length) resolve(); };
        worker.postMessage({ features: feat, jobs: slice, sample: 64 });
      });
    });
    fitWorkers.forEach((w) => w.terminate());
    fitWorkers = [];
    if (!root.isConnected) return;   // picker closed mid-scoring
    _fitScores.set(fitMesh.key, scores);
    if (store.versionId) derivedPut(store.versionId, `fitscores:${fitMesh.key}`, [...scores]).catch(() => {});
    fitScores = scores;
    fitOn = true;
    fitBtn!.disabled = false;
    fitBtn!.classList.add('active');
    fitProg!.hidden = true;
    selLbl.textContent = colorLabel();
    recomputeMatch();
    grid.scrollTop = 0;
  }
  if (fitMesh) {
    fitBtn = el('button', {
      class: 'btn tp-fitbtn', text: '✦ fit',
      title: 'Rank textures by how well they fit this mesh\'s shape, best first. A smart guess to help you find the right one faster — not a guaranteed match.',
    });
    fitBtn.addEventListener('click', runFit);
    fitProg = el('progress', { class: 'tp-fitprog', max: 1, value: 0, hidden: true });
    if (fitScores) fitBtn.classList.add('active'), fitOn = true;   // reuse cached scores on reopen
    actions.append(fitBtn, fitProg);
  }

  // ---- grid: all cells rendered up-front, thumbnails load eagerly ---------
  const grid = el('div', { class: 'tp-grid', tabindex: '-1' });

  const schedulePreview = () => {
    clearTimeout(previewT);
    const e = match[sel];
    if (e) previewT = window.setTimeout(() => onPreview?.(e), 140);
  };

  const setSel = (k: number, { preview = true } = {}) => {
    if (!match.length) return;
    k = Math.max(0, Math.min(match.length - 1, k));
    cells[sel]?.classList.remove('sel');
    sel = k;
    const cell = cells[sel];
    if (cell) {
      cell.classList.add('sel');
      cell.scrollIntoView({ block: 'nearest' });
    }
    syncUse();
    const e = match[sel];
    const top = e.entries?.[e.entries.length - 1];
    selLbl.textContent = `#${e.i}${top ? ` · ${top.w}×${top.h}` : ''}`;
    if (preview) schedulePreview();
  };
  const toggleChosen = (e: IndexEntry, cell: HTMLElement) => {
    if (chosen.has(e.i)) { chosen.delete(e.i); cell.classList.remove('chosen'); }
    else { chosen.add(e.i); cell.classList.add('chosen'); }
    syncUse();
  };

  // One CACHED cell per image, reused across every re-render (filter/sort):
  // a reused <img> keeps its decoded pixels, so re-filtering never re-fetches
  // thumbnails — and lazy loading means only cells scrolled into view decode
  // at all (the grid can hold ~9.5k; decoding everything up front serialized
  // behind the service worker and starved the preview fetch).
  const cellCache = new Map<number, { cell: HTMLElement }>();   // image i -> { cell }
  function cellFor(e: IndexEntry): HTMLElement {
    let c = cellCache.get(e.i);
    if (!c) {
      const cell = el('div', {},
        // f[0] = the smallest albedo mip — plenty for a 78px cell
        el('img', { src: store.url(e.f[0]), alt: `#${e.i}`, loading: 'lazy', decoding: 'async' }),
        el('div', { class: 'tp-label', text: `#${e.i}` }));
      cell.addEventListener('click', (ev) => {
        if (ev.ctrlKey || ev.metaKey) toggleChosen(e, cell); else setSel(+cell.dataset.k!);
      });
      cell.addEventListener('dblclick', () => finish(onPick, e));
      c = { cell };
      cellCache.set(e.i, c);
    }
    return c.cell;
  }

  function renderGrid(): void {
    clear(grid);
    cells = [];
    if (!match.length) {
      grid.appendChild(el('div', { class: 'dim small', text: 'no textures match' }));
      return;
    }
    const frag = document.createDocumentFragment();
    for (let k = 0; k < match.length; k++) {
      const e = match[k];
      const cell = cellFor(e);
      cell.dataset.k = String(k);   // position in the CURRENT match (click/sel target)
      cell.className = `tp-cell${e.i === current ? ' active' : ''}${chosen.has(e.i) ? ' chosen' : ''}`;
      cell.querySelector('.tp-fit')?.remove();
      if (fitOn && fitScores) {
        const sc = fitScores.get(e.i);
        if (sc != null) cell.appendChild(el('div', { class: 'tp-fit', text: sc.toFixed(2) }));
      }
      cells.push(cell);
      frag.appendChild(cell);
    }
    grid.appendChild(frag);
    if (sel >= 0 && cells[sel]) cells[sel].classList.add('sel');
  }
  recomputeMatch();   // honour a reused sort (fit/colour) on open, not just default order
  // start the cursor on the currently applied texture when it's a material
  const curPos = match.findIndex((e) => e.i === current);
  if (curPos >= 0) setSel(curPos, { preview: false });

  // ---- keyboard: arrows preview, Enter commits, Esc cancels
  const cols = () => Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
  const onKey = (ev: KeyboardEvent) => {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey, true); return; } // view torn down around us
    if (ev.key === 'Escape') { ev.stopPropagation(); close(); return; }
    if (ev.key === 'Enter') { if (chosen.size || match[sel]) { ev.preventDefault(); ev.stopPropagation(); doCommit(); } return; }
    const inFilter = document.activeElement === input;
    const step = ({ ArrowDown: cols(), ArrowUp: -cols(), ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[ev.key];
    if (step == null) return;
    if (inFilter && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && input.value) return; // keep text caret
    ev.preventDefault();
    ev.stopPropagation();   // the picker owns arrow keys while open (not the sidebar list)
    setSel(sel < 0 ? 0 : sel + step);
  };
  document.addEventListener('keydown', onKey, true);

  // ---- footer: persistence lives in the topbar "overrides" manager only
  root.append(
    el('div', { class: 'tp-head' }, input, closeBtn),
    actions,
    grid,
    el('div', { class: 'tp-foot' },
      el('span', { class: 'dim small', text: `${fmtInt(localOverrideCount())} unsaved texture change(s) — save them with the “overrides” button up top` })),
  );
  // one picker per host: tear down any stray previous instance first, so
  // re-opening never stacks another ~3,800-thumbnail grid (piles of <img>
  // layers crash Firefox). Each element's own remove() runs full cleanup.
  host.querySelectorAll('.texpicker').forEach((n) => n.remove());
  host.appendChild(root);
  // the pre-selected (currently applied) texture jumps into view — this must
  // happen after the grid is actually in the DOM, or scrollIntoView is a no-op
  if (sel >= 0) cells[sel]?.scrollIntoView({ block: 'center' });

  // keyboard-owner indicator: the picker takes over arrow keys from the sidebar list
  root.classList.add('kb-target');
  const listHost = document.getElementById('list-host');
  listHost?.classList.remove('kb-target');

  const origRemove = root.remove.bind(root);
  root.remove = () => {
    clearTimeout(previewT);
    fitWorkers.forEach((w) => w.terminate());   // stop any in-flight fit scoring
    fitWorkers = [];
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('paste', onPaste);
    listHost?.classList.add('kb-target');
    origRemove();
    if (!committed) onCancel?.();
  };

  input.focus();
  return { root, close };
}
