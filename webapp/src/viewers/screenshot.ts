// Screenshot modal for the skeleton composite: shows the exact live 3D view
// (source canvas + optional caption bar) in a preview canvas, and downloads it
// as PNG / JPEG / WebP at a chosen resolution scale. Grid lines and background
// colour are adjustable (applied to the scene, restored on close), and every
// setting persists in storage. The current camera pose is captured: orbit the
// model in the viewer before opening to reframe; turntable rotation is frozen
// while the modal is open so the preview (and the shot) is a stable frame.

import { el } from '../ui.js';
import { effectiveName } from '../names.js';
import { sceneOverrides, drawComposite, makeCropOverlay, makeCaptionControls, attachCaptionDrag, attachPreviewOrbit, settingsStore } from './capture-common.js';

const store = settingsStore('bs.screenshot');

// WebP export support varies; PNG/JPEG are universal.
function webpSupported(): boolean {
  try { return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'); }
  catch { return false; }
}

// singular noun per category, for the default caption + download filename
const SINGULAR: Record<string, string> = { meshes: 'Mesh', rigs: 'Rig', models: 'Model', anims: 'Animation', audio: 'Audio', images: 'Image', strings: 'Text', world: 'Room' };

// Optional very-high-resolution capture (tiled re-render), offered by views
// whose content outgrows a canvas-scale capture (the world views).
export interface HighResCapture {
  options: Record<string, { label: string; edge: number }>;
  initial?: string;
  onPick?: (key: string) => void;
  /** Renders + downloads; resolves once done (null = failed). `transparent`
   *  mirrors the modal's Transparent toggle (clear background when set). */
  capture: (key: string, onProgress: (msg: string) => void, opts?: { transparent?: boolean }) => Promise<{ name: string; size: number } | null>;
}

export function openScreenshotModal({ app, scene, entry, activeSize, cat = 'rigs', highRes = null }:
  { app: any; scene: any; entry: any; activeSize?: number; cat?: string; highRes?: HighResCapture | null }): void {
  const noun = SINGULAR[cat] || 'Asset';
  const saved = store.load();
  const ov = sceneOverrides(scene);

  const formats: [string, string][] = [['png', 'PNG (lossless)'], ['jpeg', 'JPEG']];
  if (webpSupported()) formats.push(['webp', 'WebP']);

  const overlay = el('div', { class: 'modal-overlay' });   // normal dimmed backdrop: the app stays visible behind the modal
  let closed = false;
  // freeze turntable so the preview/shot is a stable frame; restore on close
  const rotWas = scene.controls.autoRotate;
  scene.controls.autoRotate = false;
  let stopOrbit: { dispose(): void; setEnabled(on: boolean): void } | null = null;
  const close = () => {
    closed = true; cancelAnimationFrame(rafId); stopOrbit?.dispose(); overlay.remove();
    ov.restore(); scene.controls.autoRotate = rotWas;
  };
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

  // ---- controls -------------------------------------------------------------
  const fmtSel = el('select', { class: 'btn' });
  for (const [v, label] of formats) fmtSel.appendChild(el('option', { value: v, text: label }));
  if (saved.fmt && formats.some(([v]) => v === saved.fmt)) fmtSel.value = saved.fmt;

  const scaleSel = el('select', { class: 'btn' });
  for (const [v, label] of [['1', 'full'], ['0.75', '75%'], ['0.5', '50%']]) scaleSel.appendChild(el('option', { value: v, text: `resolution: ${label}` }));
  if (saved.scale) scaleSel.value = saved.scale;

  const capCb = el('input', { type: 'checkbox' });
  capCb.checked = saved.caption !== false;
  const capIn = el('input', { type: 'text', class: 'video-cap', placeholder: 'caption text…' });
  capIn.value = effectiveName(entry, cat) || `${noun} #${entry.i}`;
  const capStyle = makeCaptionControls(saved.captionStyle, () => saveSettings());   // font/size/bg/reset (drag = attached below)

  const gridCb = el('input', { type: 'checkbox', disabled: !ov.hasGrid });
  gridCb.checked = ov.hasGrid && (saved.grid ?? ov.gridVisible);
  // a non-colour background would be kept as-is (bgIsColor guard): with the
  // skybox presets removed this is always a colour today
  const bgIn = el('input', { type: 'color', value: saved.bg || ov.bgHex, title: ov.bgIsColor ? '' : 'The scene’s backdrop is used (transparent still works)' });
  const bgDefBtn = el('button', { class: 'btn btn-mini', text: 'default', title: 'Reset the background to the viewer default' });
  const transpCb = el('input', { type: 'checkbox', title: 'Transparent background: PNG / WebP only (JPEG can’t be transparent)' });
  transpCb.checked = !!saved.transparent;

  // JPEG has no alpha channel: disable it while transparent (and move off it).
  const syncFmt = () => {
    for (const o of fmtSel.options) if (o.value === 'jpeg') o.disabled = transpCb.checked;
    if (transpCb.checked && fmtSel.value === 'jpeg') fmtSel.value = 'png';
  };
  ov.setGrid(gridCb.checked);
  if (ov.bgIsColor) ov.setBackground(bgIn.value);
  bgIn.disabled = bgDefBtn.disabled = transpCb.checked || !ov.bgIsColor;   // background colour is moot when transparent
  syncFmt();

  const saveSettings = () => store.save({
    fmt: fmtSel.value, scale: scaleSel.value, caption: capCb.checked, grid: gridCb.checked,
    bg: bgIn.value,
    transparent: transpCb.checked,
    cropL: crop.cropL, cropR: crop.cropR, captionStyle: { ...capStyle.style },
  });
  const applyView = () => {
    ov.setGrid(gridCb.checked);
    if (ov.bgIsColor) ov.setBackground(bgIn.value);
    bgIn.disabled = bgDefBtn.disabled = transpCb.checked || !ov.bgIsColor;
    syncFmt(); saveSettings();
  };
  gridCb.addEventListener('change', applyView);
  bgIn.addEventListener('input', applyView);
  transpCb.addEventListener('change', applyView);
  bgDefBtn.addEventListener('click', () => { bgIn.value = ov.defaultBg; applyView(); });
  for (const c of [fmtSel, scaleSel, capCb]) c.addEventListener('change', saveSettings);

  const dims = el('span', { class: 'mono dim small' });
  const status = el('p', {
    class: 'dim small',
    text: Number.isFinite(activeSize)
      ? `Live preview shows the current 3D view (${activeSize} mesh${activeSize === 1 ? '' : 'es'}).`
      : 'Live preview shows the current 3D view.',
  });

  // ---- live composite (shown directly) --------------------------------------
  const src = scene.renderer.domElement;
  const comp = el('canvas', { class: 'video-preview' });
  const cctx = comp.getContext('2d')!;
  // draggable width-crop guides (trim empty side bars)
  const crop = makeCropOverlay(comp, { cropL: saved.cropL, cropR: saved.cropR, onChange: (committed) => { if (committed) saveSettings(); } });
  attachCaptionDrag(comp, () => (capCb.checked ? capIn.value : ''), capStyle.style, () => saveSettings());
  stopOrbit = attachPreviewOrbit(comp, scene);   // drag the preview to orbit, wheel to zoom
  const composite = (preview: boolean) => drawComposite(cctx, comp, src, {
    scale: parseFloat(scaleSel.value),
    caption: capCb.checked && capIn.value ? { text: capIn.value, ...capStyle.style } : '',
    transparent: transpCb.checked, scene3d: scene, preview,
  });
  const paint = () => { const { h } = composite(true); dims.textContent = `${crop.rect().w}×${h}`; };
  let rafId = 0;
  const loop = () => { if (closed) return; paint(); rafId = requestAnimationFrame(loop); };
  loop();

  // ---- download -------------------------------------------------------------
  const dlBtn = el('button', { class: 'btn primary', text: '⭳ Download' });
  const closeBtn = el('button', { class: 'btn', text: 'Close' });
  closeBtn.addEventListener('click', close);
  dlBtn.addEventListener('click', () => {
    composite(false);   // full-res, checker-free frame (real alpha) at the current settings
    const fmt = fmtSel.value;
    const mime = ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[fmt];
    const { x, w, h } = crop.rect();
    let out = comp;
    if (w !== comp.width) {   // apply the width crop
      out = el('canvas'); out.width = w; out.height = h;
      out.getContext('2d')!.drawImage(comp, x, 0, w, h, 0, 0, w, h);
    }
    const done = (blob: Blob | null) => {
      if (!blob) { status.textContent = 'Capture failed (empty image).'; return; }
      const name = `${noun.toLowerCase()}_${entry.i}.${fmt === 'jpeg' ? 'jpg' : fmt}`;
      const a = el('a', { href: URL.createObjectURL(blob), download: name });
      a.click();
      URL.revokeObjectURL(a.href);
      status.textContent = `Done: downloaded ${name} (${out.width}×${out.height}, ${(blob.size / 1024).toFixed(0)} KB).`;
      app.banner(`saved ${name}`, 'b-info');
    };
    out.toBlob(done, mime, fmt === 'png' ? undefined : 0.92);
  });

  // ---- optional high-res tiled capture (world views) --------------------------
  let hiRow: HTMLElement | null = null;
  if (highRes) {
    const hiSel = el('select', { class: 'btn wp-shot-res', title: 'Long-edge target. The biggest sizes render many tiles and produce very large PNGs, so expect them to take a while.' });
    for (const [key, def] of Object.entries(highRes.options)) hiSel.appendChild(el('option', { value: key, text: def.label }));
    if (highRes.initial && highRes.initial in highRes.options) hiSel.value = highRes.initial;
    hiSel.addEventListener('change', () => highRes.onPick?.(hiSel.value));
    const hiBtn = el('button', { class: 'btn', text: '⭳ High-res PNG' });
    hiBtn.addEventListener('click', async () => {
      hiBtn.disabled = true;
      const was = hiBtn.textContent;
      try {
        const result = await highRes.capture(hiSel.value, (msg) => { hiBtn.textContent = msg; }, { transparent: transpCb.checked });
        if (result) {
          status.textContent = `Done: downloaded ${result.name} (${(result.size / 1e6).toFixed(1)} MB).`;
          app.banner(`saved ${result.name}`, 'b-info');
        } else if (!closed) status.textContent = 'High-res capture failed.';
      } finally {
        hiBtn.textContent = was;
        hiBtn.disabled = false;
      }
    });
    hiRow = el('label', { class: 'shot-hires' },
      el('span', { text: 'High-res' }), hiSel, hiBtn,
      el('span', { class: 'dim small', text: 'tiled re-render of this exact view (no caption/crop)' }));
  }

  overlay.appendChild(el('div', { class: 'modal card video-modal' },
    el('h2', { text: 'Take a screenshot' }),
    el('div', { class: 'video-form' },
      el('label', {}, el('span', { text: 'Format' }), fmtSel, el('span', { class: 'sep-mini' }), scaleSel, el('span', { class: 'sep-mini' }), dims),
      el('label', {}, capCb, el('span', { text: 'Caption' }), capIn),
      capStyle.row,
      el('label', {}, gridCb, el('span', { text: ov.hasGrid ? 'Grid lines' : 'Grid lines (none in scene)' }),
        el('span', { class: 'sep-mini' }), el('span', { text: 'Background' }), bgIn, bgDefBtn,
        el('span', { class: 'sep-mini' }), transpCb, el('span', { text: 'Transparent' })),
      hiRow),
    crop.wrap,
    status,
    el('div', { class: 'modal-actions' }, dlBtn, el('span', { class: 'spacer' }), closeBtn)));
  document.body.appendChild(overlay);
}
