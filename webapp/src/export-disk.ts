// "Download the extracted directories": write the decoded assets to a real
// folder on disk via the File System Access API (Chromium), or, where FSA is
// unavailable (Safari/Firefox), stream the same tree into a .zip download
// built with the vendored fflate. Two output formats:
//   - raw data tree: the app's re-servable data-tree shape (manifest.json +
//     index/ + JSON payloads), so a folder export is itself servable/browsable
//     with ?data=<dir>;
//   - standard formats: 3D assets converted to .glb (same gltf-export.js path
//     as the per-asset Export button), images stay PNG, audio stays WAV: for
//     Blender & other tools, not re-servable.

import { el, fmtInt, fmtBytes, pad5 } from './ui.js';
import { Zip, AsyncZipDeflate, ZipPassThrough, strToU8 } from '../vendor/fflate.module.js';

const CAT_PAYLOADS: Record<string, (e: any) => string[]> = {
  meshes: (e) => (e.f ? [e.f] : []),
  anims: (e) => (e.f ? [e.f] : []),
  rigs: (e) => (e.f ? [e.f] : []),
  images: (e) => e.f || [],
  audio: (e) => (e.f ? [e.f] : []),
  strings: () => [],
};

type SinkData = string | Blob | ArrayBuffer | Uint8Array;

interface Sink {
  bytes?: () => number;
  write(rel: string, data: SinkData): Promise<void>;
  finish(): Promise<number | void>;
}

async function ensureDir(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
  let dir = root;
  for (const seg of path.split('/').slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
  return dir.getFileHandle(path.split('/').pop()!, { create: true });
}

// ---- the two sinks: a real directory (FSA) or a zip stream (fallback) ------

function dirSink(root: FileSystemDirectoryHandle): Sink {
  return {
    async write(rel, data) {
      const fh = await ensureDir(root, rel);
      const w = await fh.createWritable();
      await w.write(data as FileSystemWriteChunkType);
      await w.close();
    },
    async finish() { /* files land as they are written */ },
  };
}

function zipSink(zipName: string): Sink {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let zipErr: Error | null = null;
  let onFinal: (() => void) | null = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) { zipErr = err; onFinal?.(); return; }
    if (chunk) { chunks.push(chunk); bytes += chunk.length; }
    if (final) onFinal?.();
  });
  return {
    bytes: () => bytes,
    async write(rel, data) {
      if (zipErr) throw zipErr;
      const u8 = typeof data === 'string' ? strToU8(data)
        : data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
          : new Uint8Array(data as ArrayBuffer);
      // PNG/WAV payloads are already compressed: store; JSON deflates well,
      // and AsyncZipDeflate compresses in a WORKER so the main thread only
      // shuttles bytes (this was the "zip is very slow" hotspot: level-6
      // deflate of thousands of mesh JSONs on the main thread)
      const entry = rel.endsWith('.json') || rel.endsWith('.glb')
        ? new AsyncZipDeflate(rel, { level: 3 })
        : new ZipPassThrough(rel);
      zip.add(entry);
      entry.push(u8, true);
    },
    async finish() {
      // AsyncZipDeflate compresses off-thread: the stream is complete only
      // when the callback fires with final=true (after end())
      const finalDone = new Promise<void>((res) => { onFinal = res; });
      zip.end();
      await finalDone;
      if (zipErr) throw zipErr;
      const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
      const a = el('a', { href: URL.createObjectURL(blob), download: zipName });
      a.click();
      URL.revokeObjectURL(a.href);
      return blob.size;
    },
  };
}

export function openExportDialog(app: any): void {
  const hasFsa = !!(window as any).showDirectoryPicker;
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e: Event) => { if (e.target === overlay) close(); });

  const manifest = app.store.manifest;
  const cats = Object.entries(manifest?.categories || {}).filter(([, v]: [string, any]) => v.exported > 0).map(([k]) => k);
  const checks: Record<string, HTMLInputElement> = {};
  const rows = cats.map((c) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = true;
    checks[c] = cb;
    return el('label', { class: 'filter-opt' }, cb, el('span', { text: `${c} (${fmtInt(manifest.categories[c].exported)})` }));
  });
  // output format: the re-servable JSON data tree, or standard files (3D → GLB)
  const fmtGlb = el('input', { type: 'radio', name: 'bulkfmt' });
  const fmtTree = el('input', { type: 'radio', name: 'bulkfmt' });
  fmtGlb.checked = true;
  const fmtRows = el('div', { class: 'filter-panel', style: 'position:static;box-shadow:none' },
    el('label', { class: 'filter-opt', title: 'glTF binary: opens in Blender, Unity, Unreal, Godot' },
      fmtGlb, el('span', { text: 'Standard formats: meshes/rigs/animations as .glb, images PNG, audio WAV' })),
    el('label', { class: 'filter-opt', title: 'The raw decoded data tree (manifest + indexes + JSON payloads), servable back into this app with ?data=<dir>' },
      fmtTree, el('span', { text: 'Raw data tree: decoded JSON payloads + indexes' })));
  const status = el('p', { class: 'dim small', text: 'Saves the decoded files so you can use or keep them outside the app.' });
  const note = hasFsa ? null : el('p', { class: 'dim small' },
    'This browser can\'t save straight to a folder, so the files are bundled into a single .zip. ',
    'That\'s fine for a category or two; for the full multi-GB set, use a Chromium-based browser like Chrome or Edge.');
  const goBtn = el('button', { class: 'btn primary', text: hasFsa ? 'Choose folder & export' : 'Build .zip & download' });
  const closeBtn = el('button', { class: 'btn', text: 'Close' });
  closeBtn.addEventListener('click', close);

  let cancelled = false;
  goBtn.addEventListener('click', async () => {
    let sink: Sink;
    if (hasFsa) {
      let root;
      try { root = await (window as any).showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
      sink = dirSink(root);
    } else {
      sink = zipSink(`bs-assets-${(app.store.versionId || 'export').slice(0, 8)}.zip`);
    }
    const chosen = cats.filter((c) => checks[c].checked);
    const asGlb = fmtGlb.checked;
    goBtn.disabled = true;
    goBtn.textContent = 'Exporting…';
    let texCache: any = null;
    try {
      const indexes: Record<string, any> = {};
      for (const c of chosen) {
        if (c === 'world') continue;   // rooms live under world/, not index/
        indexes[c] = await app.store.index(c);
      }
      if (!asGlb) {
        // indexes + datatable + manifest first (cheap, makes the tree valid
        // early); the GLB output isn't a servable tree, so it skips these
        await sink.write('manifest.json', JSON.stringify({
          ...manifest,
          categories: Object.fromEntries(chosen.map((c) => [c, manifest.categories[c]])),
        }, null, 1));
        for (const c of chosen) await sink.write(`index/${c}.json`, JSON.stringify(indexes[c]));
        for (const rel of ['datatable/symbols.json', 'datatable/strings.json']) {
          try { await sink.write(rel, JSON.stringify(await app.store.json(rel))); } catch { /* absent */ }
        }
      }
      // payload jobs: JSON via the store decode path, PNG/WAV via the service
      // worker, GLB via the same gltf-export.js conversion as the per-asset
      // Export button (with one shared texture cache), PIPELINED: up to 8
      // jobs decode/convert ahead of the writer, so decode latency overlaps
      // the zip/disk writes instead of serializing with them
      const GLB_CATS = new Set(['meshes', 'anims', 'rigs']);
      let gltf: typeof import('./gltf-export.js') | null = null;
      if (asGlb && chosen.some((c) => GLB_CATS.has(c))) {
        gltf = await import('./gltf-export.js');
        texCache = gltf.makeTextureCache(app.store);
      }
      const fetchBlob = (rel: string) => fetch(app.store.url(rel)).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      });
      const jobs: { out: string; load: () => Promise<SinkData> }[] = [];
      for (const c of chosen) {
        if (c === 'world') {
          // world rooms only exist in the re-servable tree (there is no GLB
          // form); the exported world/ dir is exactly what the HTTP store
          // reads back via ?data=<dir>.
          if (asGlb) continue;
          const wi = await app.store.worldIndex();
          if (!wi) continue;
          await sink.write('world/index.json', JSON.stringify(wi));
          for (const r of wi.rooms) {
            jobs.push({
              out: `world/rooms/${pad5(r.id)}.json`,
              load: () => app.store.worldRoom(r.id).then((s: any) => JSON.stringify(s)),
            });
          }
          continue;
        }
        for (const e of indexes[c]) {
          if (asGlb && GLB_CATS.has(c)) {
            if (!e.f) continue;
            const out = `${c}/${c.replace(/s$/, '')}_${pad5(e.i ?? 0)}${e.h ? `_${e.h.slice(0, 8)}` : ''}.glb`;
            jobs.push({ out, load: () => gltf!.assetGLB(app, c, e, { texCache }) });
          } else {
            for (const rel of CAT_PAYLOADS[c](e)) {
              jobs.push({
                out: rel,
                load: () => (rel.endsWith('.json') ? app.store.payload(rel).then((p: any) => JSON.stringify(p)) : fetchBlob(rel)),
              });
            }
          }
        }
      }
      const total = jobs.length;
      let done = 0, failed = 0;
      const AHEAD = 8;
      const inflight: { out: string; p: Promise<SinkData> }[] = [];
      let next = 0;
      const top = () => { while (next < jobs.length && inflight.length < AHEAD) { const j = jobs[next++]; inflight.push({ out: j.out, p: j.load() }); } };
      top();
      while (inflight.length) {
        if (cancelled) throw new Error('cancelled');
        const { out, p } = inflight.shift()!;
        top();   // keep the window full while we await the oldest
        try {
          await sink.write(out, await p);
        } catch { failed++; }
        done++;
        if (done % 25 === 0) {
          status.textContent = `Writing files… ${fmtInt(done)} / ${fmtInt(total)}${failed ? ` (${failed} failed)` : ''}`
            + (sink.bytes ? ` · ${fmtBytes(sink.bytes())} zipped` : '');
        }
      }
      const zipped = await sink.finish();
      status.textContent = `Done: wrote ${fmtInt(done - failed)} of ${fmtInt(total)} files`
        + `${failed ? ` (${failed} failed)` : ''}${zipped ? ` · ${fmtBytes(zipped)} .zip downloaded` : ''}.`;
      goBtn.textContent = 'Export again';
    } catch (err) {
      status.textContent = `Export stopped: ${err.message}`;
    } finally {
      texCache?.dispose();
      goBtn.disabled = false;
      if (goBtn.textContent === 'Exporting…') goBtn.textContent = hasFsa ? 'Choose folder & export' : 'Build .zip & download';
    }
  });

  overlay.appendChild(el('div', { class: 'modal card' },
    el('h2', { text: 'Export decoded assets to disk' }),
    el('div', { class: 'filter-panel', style: 'position:static;box-shadow:none' }, ...rows),
    fmtRows, note, status,
    el('div', { class: 'modal-actions' }, goBtn, el('span', { class: 'spacer' }), closeBtn)));
  document.body.appendChild(overlay);
  overlay.addEventListener('remove', () => { cancelled = true; });
}
