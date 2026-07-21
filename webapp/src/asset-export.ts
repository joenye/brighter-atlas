// Per-asset export: download ONE selected asset, any category. 3D assets
// (mesh / skeleton / anim) export as GLB — the glTF 2.0 binary that Blender,
// Unity, Unreal and Godot import directly (conversion in gltf-export.js, loaded
// lazily) — with the raw decoded JSON still available via the format picker.
// audio = WAV, image = PNG (zip when an object has several sub-images),
// string = .txt. Complements the topbar "bulk export" (whole tree).

import { el } from './ui.js';
import { getPref, setPref } from './prefs.js';
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from '../vendor/fflate.module.js';

const pad5 = (i: number) => String(i).padStart(5, '0');

// categories with a GLB conversion (and a raw-JSON fallback)
const GLB_CATS = new Set(['meshes', 'anims', 'rigs']);

export function download(blob: Blob, name: string): void {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function zipOf(files: { name: string; data: Uint8Array; compress?: boolean }[]): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => { if (!err && chunk) chunks.push(chunk); });
  for (const f of files) {
    const entry = f.compress ? new ZipDeflate(f.name, { level: 6 }) : new ZipPassThrough(f.name);
    zip.add(entry);
    entry.push(f.data, true);
  }
  zip.end();
  return new Blob(chunks as BlobPart[], { type: 'application/zip' });
}

// -> the downloaded filename (throws on failure). fmt applies to 3D categories:
// 'glb' (default) or 'json' (the raw decoded payload).
async function exportAsset(app: any, cat: string, e: any, fmt: string = 'glb'): Promise<string> {
  const base = `${cat.replace(/s$/, '')}_${pad5(e.i ?? 0)}${e.h ? `_${e.h.slice(0, 8)}` : ''}`;

  if (GLB_CATS.has(cat)) {
    if (!e.f) throw new Error('this asset has no file to download');
    if (fmt === 'json') {
      const payload = await app.store.payload(e.f);
      const name = `${base}.json`;
      download(new Blob([JSON.stringify(payload)], { type: 'application/json' }), name);
      return name;
    }
    const { assetGLB } = await import('./gltf-export.js');
    const bytes = await assetGLB(app, cat, e);
    const name = `${base}.glb`;
    download(new Blob([bytes], { type: 'model/gltf-binary' }), name);
    return name;
  }

  if (cat === 'audio') {
    if (!e.f) throw new Error('this asset has no file to download');
    const res = await fetch(app.store.url(e.f));
    if (!res.ok) throw new Error(`WAV decode failed (HTTP ${res.status})`);
    const name = `${base}.wav`;
    download(await res.blob(), name);
    return name;
  }

  if (cat === 'images') {
    if (!e.f?.length) throw new Error('this image has no file to download');
    if (e.f.length === 1) {
      const res = await fetch(app.store.url(e.f[0]));
      if (!res.ok) throw new Error(`PNG decode failed (HTTP ${res.status})`);
      const name = `${base}.png`;
      download(await res.blob(), name);
      return name;
    }
    const files = [];
    for (const rel of e.f) {
      const res = await fetch(app.store.url(rel));
      if (!res.ok) throw new Error(`${rel}: PNG decode failed (HTTP ${res.status})`);
      files.push({ name: rel.split('/').pop(), data: new Uint8Array(await res.arrayBuffer()) });
    }
    const name = `${base}.zip`;
    download(await zipOf(files), name);
    return name;
  }

  if (cat === 'strings') {
    const name = `${base}.txt`;
    download(new Blob([e.text], { type: 'text/plain;charset=utf-8' }), name);
    return name;
  }

  throw new Error(`no exporter for category ${cat}`);
}

// the persisted 3D export format: 'glb' (default) | 'json'
const exportFormat = (): string => (getPref('exportfmt') === 'json' ? 'json' : 'glb');

// small format picker rendered next to the Export button on 3D assets
function formatSelect({ mini = false }: { mini?: boolean } = {}): HTMLSelectElement {
  const sel = el('select', {
    class: `btn${mini ? ' btn-mini' : ''} asset-export-fmt`,
    title: 'Export format: GLB (glTF binary — opens in Blender, Unity, Unreal, Godot) or the raw decoded JSON',
  });
  sel.append(
    el('option', { value: 'glb', text: '.glb' }),
    el('option', { value: 'json', text: '.json (raw)' }),
  );
  sel.value = exportFormat();
  sel.addEventListener('change', () => setPref('exportfmt', sel.value));
  return sel;
}

export interface ExportButtonOpts {
  mini?: boolean;
  getFmt?: () => string;
}

// the standard per-asset Export button (same look + behaviour everywhere it
// appears — one per viewer toolbar). getFmt: () => 'glb'|'json', for callers
// that render a formatSelect alongside.
export function exportButton(app: any, cat: string, e: any, { mini = false, getFmt }: ExportButtonOpts = {}): HTMLButtonElement {
  const btn = el('button', {
    class: `btn${mini ? ' btn-mini' : ''} asset-export-btn`,
    text: '⭳ Export',
    title: GLB_CATS.has(cat)
      ? 'Download this asset (GLB for Blender & other 3D tools, or raw JSON)'
      : 'Download this asset (WAV / PNG / text)',
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'exporting…';
    try {
      const name = await exportAsset(app, cat, e, getFmt ? getFmt() : exportFormat());
      app.banner(`exported ${name}`, 'b-info');
      btn.textContent = 'exported ✓';
    } catch (err) {
      app.banner(`export failed: ${err.message}`);
      btn.textContent = '⭳ Export';
    }
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '⭳ Export'; }, 1500);
  });
  return btn;
}

// Export button + (for 3D assets) the format picker, as one group. Skeletons
// handle their own placement (Export sits inside the capture group).
export function exportControls(app: any, cat: string, e: any, opts: ExportButtonOpts = {}): HTMLElement[] {
  if (!GLB_CATS.has(cat)) return [exportButton(app, cat, e, opts)];
  const sel = formatSelect(opts);
  return [exportButton(app, cat, e, { ...opts, getFmt: () => sel.value }), sel];
}

// Append the Export controls to a viewer toolbar, preceded by a divider so it
// reads as its own "export this asset" group.
export function addExportButton(toolbar: HTMLElement, app: any, cat: string, e: any): void {
  toolbar.append(el('span', { class: 'sep' }), ...exportControls(app, cat, e));
}
