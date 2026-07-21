// Image viewer: zoom/pan stage with checkerboard alpha, sub-image strip with
// format/size labels; plus the category-level lazy grid (landing view).

import { el, clear, badge, fmtInt, notExported, idLabel } from '../ui.js';
import { addExportButton } from '../asset-export.js';
import type { IndexEntry } from '../store.js';

const CAT_BADGE: Record<string, string> = { sprite: 'b-accent', material: 'b-good', skybox: '', font: 'b-warn', lut: 'b-warn' };

export function createImageView(app: any, entry: IndexEntry) {
  const root = el('div', { class: 'viewer-pane' });
  const toolbar = el('div', { class: 'viewer-toolbar' });
  const stage = el('div', { class: 'img-stage' });
  const strip = el('div', { class: 'substrip' });
  root.append(toolbar, stage, strip);

  const view = { root, destroy() {} };

  toolbar.append(
    el('span', { class: 'viewer-title breadcrumb' },
      el('a', { href: '#/images', text: 'Images', title: 'Back to all images' }),
      el('span', { class: 'dim', text: ' ▸ ' }),
      el('span', { text: idLabel(entry) })),
    badge(`#${entry.i}`, 'b-ghost', 'Where this asset sits in the game files. The id in the title is its permanent name and never changes.'),
    badge(entry.cat || 'image', CAT_BADGE[entry.cat] || ''),
    el('span', { class: 'dim small', text: `${entry.n} resolution${entry.n === 1 ? '' : 's'}` }),
  );

  const isData = !entry.entries || entry.entries.length === 0;
  if (!entry.f || !entry.f.length) {
    stage.replaceWith(el('div', { style: 'flex:1' },
      isData
        ? el('div', { class: 'notexported' },
            badge(entry.cat || 'data', 'b-warn'),
            el('div', { class: 'small dim', text: entry.cat === 'font' ? 'Font characters — no picture to preview.' : entry.cat === 'lut' ? 'Colour lookup table (used for tinting) — no picture to preview.' : 'No picture to preview for this item.' }))
        : notExported(`Image #${entry.i}`)));
    strip.remove();
    return view;
  }

  // ---- zoom/pan stage ------------------------------------------------------
  const img = el('img', { draggable: 'false' });
  stage.appendChild(img);
  let scale = 1, tx = 0, ty = 0, natW = 0, natH = 0;

  const applyT = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const fit = () => {
    if (!natW) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    scale = Math.min(w / natW, h / natH) * 0.92;
    if (scale > 8) scale = Math.min(8, scale); // don't over-blow tiny sprites on fit
    tx = (w - natW * scale) / 2;
    ty = (h - natH * scale) / 2;
    applyT();
    zoomLbl.textContent = `${Math.round(scale * 100)}%`;
  };
  const oneToOne = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    scale = 1;
    tx = (w - natW) / 2; ty = (h - natH) / 2;
    applyT();
    zoomLbl.textContent = '100%';
  };

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    const ns = Math.min(64, Math.max(0.05, scale * k));
    tx = mx - (mx - tx) * (ns / scale);
    ty = my - (my - ty) * (ns / scale);
    scale = ns;
    applyT();
    zoomLbl.textContent = `${Math.round(scale * 100)}%`;
  }, { passive: false });

  let drag: { x: number; y: number; tx: number; ty: number } | null = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, tx, ty };
    stage.classList.add('dragging');
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    tx = drag.tx + e.clientX - drag.x;
    ty = drag.ty + e.clientY - drag.y;
    applyT();
  });
  stage.addEventListener('pointerup', (e) => { drag = null; stage.classList.remove('dragging'); stage.releasePointerCapture(e.pointerId); });

  const fitBtn = el('button', { class: 'btn', text: 'Fit' });
  fitBtn.addEventListener('click', fit);
  const oneBtn = el('button', { class: 'btn', text: '1:1' });
  oneBtn.addEventListener('click', oneToOne);
  const zoomLbl = el('span', { class: 'mono dim', text: '' });
  toolbar.append(el('span', { class: 'sep' }), fitBtn, oneBtn, zoomLbl);
  addExportButton(toolbar, app, 'images', entry);

  // ---- sub-image strip -----------------------------------------------------
  const files: string[] = entry.f;
  const meta: any[] = entry.entries || [];
  let active = -1;
  const thumbs = files.map((file, k) => {
    const info = meta[k];
    const t = el('div', { class: 'subthumb' },
      el('div', { class: 'st-box' }, el('img', { src: app.store.url(file), loading: 'lazy' })),
      el('div', { class: 'st-label', text: info ? `${info.fmt} ${info.w}×${info.h}` : `#${k}` }));
    t.addEventListener('click', () => show(k));
    strip.appendChild(t);
    return t;
  });

  function show(k: number): void {
    if (active === k) return;
    active = k;
    thumbs.forEach((t, i) => t.classList.toggle('active', i === k));
    img.style.visibility = 'hidden';
    img.onload = () => {
      natW = img.naturalWidth; natH = img.naturalHeight;
      img.style.visibility = 'visible';
      fit();
    };
    img.onerror = () => app.banner(`failed to load ${files[k]}`);
    img.src = app.store.url(files[k]);
    const info = meta[k];
    app.setStatus3(`image #${entry.i} · sub ${k}${info ? ` · ${info.fmt} ${info.w}×${info.h}` : ''}`);
  }
  // open on the highest-resolution sub-image (mip 0), not entries[0] (smallest)
  let top = 0, topArea = -1;
  meta.forEach((info, k) => {
    const area = (info?.w || 0) * (info?.h || 0);
    if (area > topArea) { topArea = area; top = k; }
  });
  show(top);
  if (files.length === 1) strip.style.display = 'none';

  return view;
}

// ---------------------------------------------------------------------------
// category landing: lazy thumbnail grid of everything exported
export function createImageGrid(app: any, initialItems: IndexEntry[]) {
  const root = el('div', { class: 'viewer-pane' });
  const scroller = el('div', { style: 'flex:1;overflow:auto' });
  const grid = el('div', { class: 'img-grid' });
  const countLbl = el('span', { class: 'dim small' });
  scroller.appendChild(grid);
  root.append(
    el('div', { class: 'viewer-toolbar' },
      el('span', { class: 'viewer-title', text: 'Images' }),
      countLbl),
    scroller);

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const cell = e.target as HTMLElement;
      if (e.isIntersecting && cell.dataset.src) {
        cell.querySelector('.ic-box')!.appendChild(el('img', { src: cell.dataset.src, loading: 'lazy' }));
        delete cell.dataset.src;
        io.unobserve(cell);
      }
    }
  }, { root: scroller, rootMargin: '400px' });

  // render in chunks to keep the first paint quick; setItems() rebuilds so the
  // grid stays in sync with the sidebar's filtered/sorted list
  let items = initialItems;
  let i = 0;
  const CHUNK = 400;
  const more = el('button', { class: 'btn', style: 'margin:0 14px 20px', text: 'Load more…' });
  // infinite scroll: when the sentinel (the Load more button) nears the
  // viewport, the next chunk renders automatically — the button stays as a
  // no-JS-observer fallback
  const moreIo = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && more.style.display !== 'none') renderChunk();
  }, { root: scroller, rootMargin: '900px' });
  function renderChunk(): void {
    const end = Math.min(items.length, i + CHUNK);
    for (; i < end; i++) {
      const it = items[i];
      const cell = el('div', { class: 'img-cell' },
        el('div', { class: 'ic-box' }, it.f?.length ? null : el('span', { class: 'dim small', text: it.cat === 'font' ? 'font' : it.cat === 'lut' ? 'lut' : '∅' })),
        el('div', { class: 'small mono dim', text: `#${it.i} ${it.cat || ''}${it.n > 1 ? ` ×${it.n}` : ''}` }));
      if (it.f?.length) {
        cell.dataset.src = app.store.url(it.f[0]);
        io.observe(cell);
      }
      cell.addEventListener('click', () => { location.hash = `#/image/${it.i}`; });
      grid.appendChild(cell);
    }
    more.style.display = i < items.length ? '' : 'none';
  }
  function setItems(next: IndexEntry[]): void {
    items = next;
    i = 0;
    io.disconnect();
    clear(grid);
    countLbl.textContent = `${items.length} shown (follows the list filter) — click a tile to open`;
    renderChunk();
  }
  more.addEventListener('click', renderChunk);
  setItems(initialItems);
  scroller.appendChild(more);
  moreIo.observe(more);

  return { root, setItems, destroy() { io.disconnect(); moreIo.disconnect(); } };
}
