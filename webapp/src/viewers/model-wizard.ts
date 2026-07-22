// "Save as Model" wizard, opened from the skeleton composite toolbar. A full
// mesh picker (filter / sort / slot / all-none, like the rig's "meshes on this
// rig" panel) over EVERY mesh on the rig, a per-mesh texture-variant choice, and
// a LIVE, interactive 3D preview (independent of the main view) that updates as
// you toggle meshes / variants. Saves the result as a named Model.

import { el, clear, badge, fmtInt, idLabel } from '../ui.js';
import { effectiveName } from '../names.js';
import { effectiveTex, getVariants, getActiveIndex } from '../texmap.js';
import { buildMeshGeometry } from './mesh-geometry.js';
import { saveModel } from '../models.js';
import { createModelPreview } from './model-preview.js';
import type { ModelPreviewSelection } from './model-preview.js';
import { entryByOrdinal } from '../store.js';
import type { IndexEntry } from '../store.js';

const SORTS: Record<string, (a: IndexEntry, b: IndexEntry) => number> = {
  'tex-verts': (a, b) => (b.v || 0) - (a.v || 0),
  triangles: (a, b) => (b.t || 0) - (a.t || 0),
  name: (a, b) => (effectiveName(a, 'meshes') || `#${a.i}`).localeCompare(effectiveName(b, 'meshes') || `#${b.i}`),
  index: (a, b) => a.i - b.i,
};

export function openModelWizard({ app, entry, active, boundMeshes, imagesIdx }:
  { app: any; entry: any; active: Map<number, any>; boundMeshes: IndexEntry[]; imagesIdx: IndexEntry[] | null }): void {
  if (!boundMeshes.length) { app.banner('this rig has no meshes'); return; }
  const byI = new Map(boundMeshes.map((m) => [m.i, m]));

  let previewApi: ReturnType<typeof createModelPreview> | null = null, closed = false;
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => { closed = true; previewApi?.destroy(); overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // ---- selection state (over ALL rig meshes) --------------------------------
  const selected = new Set([...active.keys()]);   // start from the current composite
  const variantChoice = new Map<number, number | 'none'>();   // ordinal -> variant index | 'none' (overrides the active one)
  let sort = 'tex-verts', slotFilter = 'all';

  // geometry cache for the preview, seeded with the meshes already loaded on the rig
  const geoCache = new Map<number, any>();
  for (const [i, mesh] of active) geoCache.set(i, mesh.geometry);
  async function geoFor(m: IndexEntry): Promise<any> {
    if (geoCache.has(m.i)) return geoCache.get(m.i);
    if (!m.f) return null;
    try { const { geo } = buildMeshGeometry(await app.store.payload(m.f)); geoCache.set(m.i, geo); return geo; }
    catch { return null; }
  }

  // the pinned image hash for a mesh's chosen (or active) variant
  const imgHashFor = (m: IndexEntry): string | null => {
    const variants = imagesIdx ? getVariants(m) : [];
    if (variants.length > 1) {
      const idx = variantChoice.has(m.i) ? variantChoice.get(m.i)! : getActiveIndex(m);
      return (idx == null || idx === 'none') ? null : (variants[idx]?.image_hash || null);
    }
    const st = imagesIdx ? effectiveTex(m, imagesIdx) : null;
    return st?.a != null ? (entryByOrdinal(imagesIdx, st.a)?.h || null) : null;
  };
  const variantNum = (m: IndexEntry | undefined): number | null => {   // 1-based variant number for the default-name suffix
    if (!m) return null;
    const variants = imagesIdx ? getVariants(m) : [];
    if (variants.length <= 1) return null;
    const idx = variantChoice.has(m.i) ? variantChoice.get(m.i)! : getActiveIndex(m);
    return (idx == null || idx === 'none') ? null : idx + 1;
  };

  // ---- mesh picker (reuses the .skel-meshes styling) ------------------------
  const filterEl = el('input', { class: 'sm-filter', type: 'search', placeholder: `filter ${fmtInt(boundMeshes.length)} meshes…` });
  const sortSel = el('select', { class: 'btn-mini sm-sort', title: 'Sort the mesh list' });
  for (const [v, l] of [['tex-verts', 'verts'], ['triangles', 'triangles'], ['name', 'name'], ['index', 'index']]) {
    sortSel.appendChild(el('option', { value: v, text: `sort: ${l}` }));
  }
  const slots = [...new Set(boundMeshes.map((m) => m.slot).filter(Boolean))].sort();
  const slotSel = el('select', { class: 'btn-mini sm-slot', title: 'Filter by body slot', hidden: !slots.length });
  slotSel.appendChild(el('option', { value: 'all', text: 'all slots' }));
  for (const s of slots) slotSel.appendChild(el('option', { value: s, text: s }));
  const allBtn = el('button', { class: 'btn-mini', text: 'all', title: 'Select every (filtered) mesh' });
  const noneBtn = el('button', { class: 'btn-mini', text: 'none', title: 'Deselect all' });
  const listEl = el('div', { class: 'sm-list' });
  const shownLbl = el('span', { class: 'dim small' });

  const matches = (): IndexEntry[] => {
    const q = filterEl.value.trim().toLowerCase();
    let arr = slotFilter === 'all' ? boundMeshes : boundMeshes.filter((m) => m.slot === slotFilter);
    if (q) arr = arr.filter((m) => `#${m.i} ${m.i} ${m.h || ''} ${m.slot || ''} ${(effectiveName(m, 'meshes') || '').toLowerCase()}`.includes(q));
    return [...arr].sort(SORTS[sort] || SORTS['tex-verts']);
  };

  function renderRows(): void {
    clear(listEl);
    for (const m of matches()) {
      const cb = el('input', { type: 'checkbox', checked: selected.has(m.i), disabled: !m.f });
      cb.addEventListener('change', () => { if (cb.checked) selected.add(m.i); else selected.delete(m.i); onChange(); });
      const variants = imagesIdx ? getVariants(m) : [];
      let sel: HTMLSelectElement | null = null;
      if (variants.length > 1) {
        sel = el('select', { class: 'btn-mini' });
        sel.appendChild(el('option', { value: 'none', text: 'no texture' }));
        variants.forEach((v, k) => sel!.appendChild(el('option', { value: String(k), text: `variant ${k + 1}${v.image_hash ? ` · ${v.image_hash.slice(0, 8)}` : ''}` })));
        const cur = variantChoice.has(m.i) ? variantChoice.get(m.i)! : getActiveIndex(m);
        sel.value = (cur == null || cur === 'none') ? 'none' : String(cur);
        sel.addEventListener('change', () => { variantChoice.set(m.i, sel!.value === 'none' ? 'none' : +sel!.value); onChange(); });
      }
      const name = effectiveName(m, 'meshes');
      const row = el('div', { class: 'sm-row' },
        cb,
        el('a', { href: `#/mesh/${m.i}`, class: name ? '' : 'mono', text: name || idLabel(m), title: `#${m.i}${m.h ? ` · ${m.h}` : ''}` }),
        el('span', { class: 'dim', text: `${fmtInt(m.v)}v · #${m.i}${m.f ? '' : ' · ∅'}` }),
        sel || el('span'));
      listEl.appendChild(row);
    }
    shownLbl.textContent = `${fmtInt(matches().length)} of ${fmtInt(boundMeshes.length)} shown · ${fmtInt(selected.size)} selected`;
  }

  filterEl.addEventListener('input', renderRows);
  sortSel.addEventListener('change', () => { sort = sortSel.value; renderRows(); });
  slotSel.addEventListener('change', () => { slotFilter = slotSel.value; renderRows(); });
  allBtn.addEventListener('click', () => { for (const m of matches()) if (m.f) selected.add(m.i); renderRows(); onChange(); });
  noneBtn.addEventListener('click', () => { selected.clear(); renderRows(); onChange(); });

  // ---- default name (skeleton + agreed variant number) ----------------------
  const baseName = effectiveName(entry, 'rigs') || `Rig ${entry.i}`;
  const defaultName = () => {
    const uniq = [...new Set([...selected].map((i) => byI.get(i)).map(variantNum).filter((n) => n != null))];
    return baseName + (uniq.length === 1 ? ` (v${uniq[0]})` : '');
  };
  let autoName = defaultName();
  const nameIn = el('input', { type: 'text', class: 'video-cap', placeholder: 'model name…', value: autoName });

  // ---- live preview (debounced; loads geometries on demand) -----------------
  const preview = el('canvas', { class: 'mw-preview', width: 512, height: 256 });
  let previewToken = 0, previewTimer: ReturnType<typeof setTimeout> | undefined;
  const syncPreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const my = ++previewToken;
      const list: ModelPreviewSelection[] = [];
      for (const i of selected) {
        const m = byI.get(i); if (!m || !m.f) continue;
        const geo = await geoFor(m);
        if (closed || my !== previewToken) return;
        if (geo) list.push({ geo, imgHash: imgHashFor(m) });
      }
      if (my === previewToken) previewApi?.setSelection(list);
    }, 120);
  };
  const syncName = () => { const nd = defaultName(); if (nameIn.value === autoName) nameIn.value = nd; autoName = nd; };
  const onChange = () => { shownLbl.textContent = `${fmtInt(matches().length)} of ${fmtInt(boundMeshes.length)} shown · ${fmtInt(selected.size)} selected`; syncPreview(); syncName(); };

  // ---- actions --------------------------------------------------------------
  const status = el('p', { class: 'dim small', text: 'Pick the meshes to include and their texture variants. The preview updates live.' });
  const createBtn = el('button', { class: 'btn primary', text: '＋ Save model' });
  const cancelBtn = el('button', { class: 'btn', text: 'Cancel' });
  cancelBtn.addEventListener('click', close);
  createBtn.addEventListener('click', () => {
    const picked = [...selected].map((i) => byI.get(i)).filter((m): m is IndexEntry => !!(m && m.f));
    if (!picked.length) { status.textContent = 'Select at least one mesh.'; return; }
    const meshDefs = picked.map((m) => ({ h: m.h!, img: imgHashFor(m) }));
    const rec = saveModel({ name: nameIn.value, skel: entry.h || null, meshes: meshDefs });
    app.renderTabs?.();
    app.banner(`created model “${rec.name}” (${picked.length} meshes)`, 'b-info');
    close();
    location.hash = `#/model/${rec.id}`;
  });

  overlay.appendChild(el('div', { class: 'modal card model-wizard' },
    el('h2', { text: 'Save as Model' }),
    el('p', { class: 'dim small' }, 'Save a chosen set of meshes + textures as a reusable, named composite in the ',
      badge('Models', 'b-ghost'), ' category (rename / delete later).'),
    el('div', { class: 'mw-preview-wrap' }, preview),
    el('label', { class: 'mw-namerow' }, el('span', { text: 'Name' }), nameIn),
    el('div', { class: 'skel-meshes mw-picker' },
      el('div', { class: 'sm-tools' }, filterEl, sortSel, slotSel, allBtn, noneBtn),
      shownLbl,
      listEl),
    status,
    el('div', { class: 'modal-actions' }, createBtn, el('span', { class: 'spacer' }), cancelBtn)));
  document.body.appendChild(overlay);

  renderRows();
  previewApi = createModelPreview(preview, { app, imagesIdx });
  syncPreview();
}
