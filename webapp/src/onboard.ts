// Onboarding wizard, shared by the Simple viewer and the Studio. Stage
// machine: PICK (with the welcome/legal framing) -> SELECT+VALIDATE (category
// picker with size/time estimates) -> EXTRACT (per-stage progress incl.
// content-id hashing) -> DONE (summary, then hand-off).
// Everything runs locally (worker + WASM-free JS decoders); no bytes leave
// the browser.
//
// Also serves the "extract more categories later" flow: pass opts.existing
// (the stored version record) and already-extracted categories show as done,
// only the missing ones are offered, and the ingest merges into the record.

import { el, clear, fmtBytes, fmtInt, versionLabel, profileLabelDate, DESKTOP_ONLY_LINE } from './ui.js';
import { CAT_BUNDLES, ALL_CATS, BUNDLE_LABEL, requiredBundles } from './extract/ingest.js';
import { requestPersist, storageEstimate } from './storage.js';

const CAT_INFO: Record<string, { label: string; desc: string; icon: string }> = {
  meshes: { label: 'Meshes', desc: '3D geometry', icon: '◆' },
  rigs: { label: 'Rigs', desc: 'animation rigs for skinned meshes', icon: '⑃' },
  anims: { label: 'Animations', desc: 'rig clips', icon: '∿' },
  images: { label: 'Images', desc: 'textures, sprites, icons (biggest)', icon: '▦' },
  audio: { label: 'Audio', desc: 'music + sfx', icon: '♪' },
  strings: { label: 'Text', desc: 'dialogue, UI copy + identifiers', icon: '"' },
  world: { label: 'World', desc: '3D rooms + the System model catalog (includes Meshes, Images + Rigs)', icon: '⌂' },
};

// friendly labels for the world extraction's sub-stages (progress bars)
const WORLD_STEPS: Record<string, string> = {
  profile: 'World: matching your game build',
  replay: 'World: replaying the game index',
  pool: 'World: decoding shared values',
  rooms: 'World: reading rooms',
  stitch: 'World: placing rooms on the map',
  shards: 'World: packing room data',
  textures: 'World: scanning textures',
  catalog: 'World: recovering models + textures',
  package: 'World: packaging the model catalog',
};

// measured end-to-end ingest throughput (hash + copy + parse + index) on a
// mid-range machine, used only for the rough one-time cost estimate
const INGEST_BYTES_PER_SEC = 25e6;

export interface OnboardingOpts {
  requireCats?: string[];
  existing?: any;
  onDone?: (result: any) => void;
}

// Mount the wizard into `host`.
//   opts.requireCats: categories to pre-check + lock in the picker (a caller
//                     can force the set it needs, e.g. meshes+skeletons+anims).
//   opts.existing:    version record when extending an existing extraction
//                     ("extract more"): done categories lock, ingest merges.
//   opts.onDone:      called after a successful extraction.
export function mountOnboarding(host: HTMLElement, { requireCats = [], existing = null, onDone }: OnboardingOpts = {}): void {
  clear(host);
  const root = el('div', { class: 'onboard' });
  host.appendChild(root);

  const picked: Record<number, File> = {};   // bundle n -> File
  const doneCats = new Set(Object.entries(existing?.cats || {})
    .filter(([, v]: [string, any]) => v.state === 'ready').map(([k]) => k));
  let step = 'pick';

  const render = () => {
    clear(root);
    if (step === 'pick') renderPick();
    else if (step === 'select') renderSelect();
  };

  // ---------------------------------------------------------------- pick
  const takeFiles = (fileList: Iterable<File>) => {
    for (const f of fileList) {
      const m = f.name.match(/assetBundle(\d)\b/);
      if (m) picked[+m[1]] = f;
    }
    render();
  };

  function renderPick() {
    const drop = el('div', { class: 'ob-drop' },
      el('div', { class: 'ob-drop-icon', text: '⇩' }),
      el('p', {}, el('b', { text: 'Drop your assetBundle files here' }), ' or ',
        el('label', { class: 'ob-browse' }, 'browse',
          (() => {
            const inp = el('input', { type: 'file', multiple: true, style: 'display:none' });
            inp.addEventListener('change', () => takeFiles(inp.files!));
            return inp;
          })())),
      el('p', { class: 'dim small' },
        'From your Brighter Shores install cache: the files named assetBundle0 … assetBundle8. ',
        'They are read locally in your browser. Nothing is uploaded anywhere.'));
    drop.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault(); drop.classList.remove('over');
      takeFiles([...e.dataTransfer!.files]);
    });

    const grid = el('div', { class: 'ob-bundles' });
    for (let n = 0; n <= 8; n++) {
      const f = picked[n];
      grid.appendChild(el('div', { class: `ob-bundle${f ? ' ok' : ''}` },
        el('span', { class: 'mono', text: `assetBundle${n}` }),
        el('span', { class: 'dim small', text: BUNDLE_LABEL[n] }),
        el('span', { class: 'small', text: f ? fmtBytes(f.size) : '-' })));
    }
    const next = el('button', { class: 'btn primary', text: 'Continue →', disabled: !picked[0] });
    next.addEventListener('click', () => { step = 'select'; render(); });

    // Where the game files live on disk: Steam install locations per OS.
    const wherePaths = el('div', { class: 'ob-paths' },
      el('p', { class: 'dim small', text: 'Where are these? They install with the game. Look for the files named assetBundle0 to assetBundle8 in your Brighter Shores folder:' }),
      el('div', { class: 'ob-path' },
        el('span', { class: 'ob-path-os', text: 'Windows' }),
        el('code', { class: 'mono', text: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Brighter Shores' })),
      el('div', { class: 'ob-path' },
        el('span', { class: 'ob-path-os', text: 'macOS' }),
        el('code', { class: 'mono', text: '~/Library/Application Support/Steam/steamapps/common/Brighter Shores/x64arm64/Brighter Shores.app/Contents/Resources/' })));

    root.append(
      el('h2', { text: existing ? 'Extract more categories' : 'Load your game assets' }),
      existing
        ? el('p', { class: 'dim' },
          `Re-pick the same game files (version ${versionLabel(existing) || existing.versionId.slice(0, 8)}). `
          + 'Already-stored bundles are recognised and skipped; only new categories are processed.')
        : el('p', { class: 'dim' },
          'This app decodes the Brighter Shores asset bundles entirely in your browser. ',
          'Pick the files once: they are stored locally so next time it loads instantly.'),
      wherePaths,
      drop, grid,
      el('div', { class: 'ob-actions' },
        picked[0] ? el('span', { class: 'dim small', text: 'assetBundle0 found. The rest are only needed for the categories you choose next.' })
          : el('span', { class: 'dim small', text: 'assetBundle0 (the game\'s master index) is required.' }),
        el('span', { class: 'spacer' }), next),
      el('p', { class: 'dim small ob-legal' },
        'A fan-made project, not affiliated with or endorsed by Fen Research. ',
        'Bring your own game files; no game data is hosted, served or uploaded. ',
        DESKTOP_ONLY_LINE));
  }

  // ---------------------------------------------------------------- select (+validate)
  function renderSelect() {
    const checks: Record<string, HTMLInputElement> = {};
    const systemCats = new Set(['meshes', 'images', 'rigs']);
    const missingFor = (cat: string): number[] => requiredBundles([cat]).filter((n: number) => !picked[n]);
    const bundlesOf = (cat: string): number[] => [...new Set([...(CAT_BUNDLES[cat] || []), ...(cat === 'anims' ? [6] : [])])] as number[];
    const sizeOf = (cat: string) => bundlesOf(cat).reduce((a, n) => a + (picked[n]?.size || 0), 0);

    const totalLine = el('span', { class: 'dim small' });
    const syncTotal = () => {
      const cats = ALL_CATS.filter((c: string) => checks[c].checked && !doneCats.has(c));
      const bundles = new Set<number>([0]);
      for (const c of cats) for (const n of bundlesOf(c)) bundles.add(n);
      const bytes = [...bundles].reduce((a, n) => a + (picked[n]?.size || 0), 0);
      totalLine.textContent = cats.length
        ? `Selected: ${fmtBytes(bytes)} stored locally · rough one-time cost ~${Math.max(5, Math.round(bytes / INGEST_BYTES_PER_SEC))}s`
        : 'Nothing selected.';
    };

    const rowParts: Record<string, { row: any; text: any; est: any }> = {};   // world build-check updates
    const rows = ALL_CATS.map((cat: string) => {
      const info = CAT_INFO[cat];
      const missing = missingFor(cat);
      const size = sizeOf(cat);
      const done = doneCats.has(cat);
      const locked = requireCats.includes(cat) && !done;
      const cb = el('input', { type: 'checkbox' });
      cb.checked = done || locked || !missing.length;   // select-all by default
      cb.disabled = done || locked || !!missing.length;
      cb.addEventListener('change', syncTotal);
      checks[cat] = cb;
      const est = done ? 'extracted ✓'
        : missing.length ? `needs ${missing.map((n) => `assetBundle${n}`).join(', ')}`
          : size ? `${fmtBytes(size)} · ~${Math.max(1, Math.round(size / INGEST_BYTES_PER_SEC))}s`
            : 'free';
      const text = el('span', {}, el('b', { text: info.label }),
        el('span', { class: 'dim small', text: `: ${info.desc}` }));
      const estEl = el('span', { class: 'dim small mono', text: est });
      const row = el('label', { class: `ob-cat${missing.length && !done ? ' missing' : ''}${done ? ' done' : ''}` }, cb,
        el('span', { class: 'ob-cat-icon', text: info.icon }),
        text,
        el('span', { class: 'spacer' }),
        estEl);
      rowParts[cat] = { row, text, est: estEl };
      return row;
    });

    // Checking World force-locks Meshes + Images + Skeletons (its rooms
    // reference them directly).
    const syncWorldLock = () => {
      const world = checks.world;
      if (!world) return;
      const worldOn = world.checked && !world.disabled && !doneCats.has('world');
      for (const cat of systemCats) {
        const dep = checks[cat];
        if (doneCats.has(cat) || missingFor(cat).length) continue;   // state already fixed
        const otherwiseLocked = requireCats.includes(cat);
        if (worldOn) { dep.checked = true; dep.disabled = true; }
        else if (!otherwiseLocked) dep.disabled = false;
      }
    };
    checks.world?.addEventListener('change', () => { syncWorldLock(); syncTotal(); });
    syncWorldLock();

    // validate panel: build identity check, before anything runs
    const validate = el('div', { class: 'ob-validate dim small', text: 'Checking the picked bundles…' });
    (async () => {
      let header = null;
      try {
        const { parseBundleHeader } = await import('./extract/bundles.js');
        const parts = [];
        header = await parseBundleHeader(picked[0], 0);
        parts.push(`game index ok (${fmtBytes(picked[0].size)})`);
        validate.textContent = `✓ ${parts.join(' · ')}`;
      } catch (e) {
        validate.textContent = `⚠ bundle validation failed: ${e.message}`;
        validate.classList.add('err');
      }
      // Build fingerprint: decompress + hash ab0 (7 MB, fast) and match it
      // against the shipped per-build decode data, BEFORE anything runs. A
      // recognized build shows its human label on the validate line ("· build
      // 23-Apr-2025"); an unrecognized one locks the World row
      // with an honest explanation (everything else still extracts). Purely
      // best-effort: any failure here leaves the panel as it was (extraction
      // re-checks anyway).
      if (!header) return;
      try {
        const [{ readRaw }, { zstdDecompress }, { matchWorldProfileEntry }] = await Promise.all([
          import('./extract/bundles.js'),
          import('./extract/zstd.js'),
          import('./extract/world/profile.js'),
        ]);
        const ab0 = zstdDecompress(new Uint8Array(await readRaw(picked[0], header.entries[0])));
        const { entry } = await matchWorldProfileEntry(ab0);
        if (entry?.label) {
          validate.appendChild(el('span', { text: ` · build ${profileLabelDate(entry.label)}` }));
        }
        const world = rowParts.world;
        if (!entry && world && !doneCats.has('world')) {
          checks.world.checked = false;
          checks.world.disabled = true;
          world.row.classList.add('missing');
          world.est.textContent = 'unsupported';
          world.text.appendChild(el('span', {
            class: 'dim small',
            text: '. Brighter Atlas doesn\'t have support for world data on this bundle yet. Everything else still works.',
          }));
          syncWorldLock();
          syncTotal();
        }
      } catch { /* offline / unreadable ab0: leave the panel untouched */ }
    })();

    const allBtn = el('button', { class: 'btn btn-mini', text: 'select all' });
    allBtn.addEventListener('click', () => {
      for (const cat of ALL_CATS) if (!checks[cat].disabled) checks[cat].checked = true;
      syncWorldLock();
      syncTotal();
    });
    const noneBtn = el('button', { class: 'btn btn-mini', text: 'none' });
    noneBtn.addEventListener('click', () => {
      // release the world lock first so its dependent categories can clear too
      if (checks.world && !checks.world.disabled) {
        checks.world.checked = requireCats.includes('world');
        syncWorldLock();
      }
      for (const cat of ALL_CATS) if (!checks[cat].disabled) checks[cat].checked = requireCats.includes(cat);
      syncTotal();
    });

    const back = el('button', { class: 'btn', text: '← Back' });
    back.addEventListener('click', () => { step = 'pick'; render(); });
    const go = el('button', { class: 'btn primary', text: 'Extract' });
    go.addEventListener('click', () => {
      const cats = ALL_CATS.filter((c: string) => checks[c].checked && !doneCats.has(c));
      if (!cats.length) return;
      runExtract(cats);
    });

    root.append(
      el('h2', { text: 'What should be extracted?' }),
      el('p', { class: 'dim' },
        'Only the bundles these categories need are processed and stored. ',
        'You can extract more later (studio topbar → storage). Heavier categories take longer (one-time: results are cached).'),
      validate,
      el('div', { class: 'ob-cats' }, ...rows),
      el('div', { class: 'ob-actions' }, allBtn, noneBtn, totalLine, el('span', { class: 'spacer' }), back, go));
    syncTotal();
  }

  // ---------------------------------------------------------------- extract
  function runExtract(cats: string[]) {
    clear(root);
    const bars = new Map<string, { bar: any; pct: any; label: string }>();  // stage key -> row
    const barsHost = el('div', { class: 'ob-progress' });
    const status = el('p', { class: 'dim', text: 'Starting…' });
    const cancelBtn = el('button', { class: 'btn', text: 'Cancel' });
    root.append(el('h2', { text: 'Extracting: all in your browser' }), status, barsHost,
      el('div', { class: 'ob-actions' }, el('span', { class: 'spacer' }), cancelBtn));

    requestPersist();   // best effort: resist idle eviction

    const worker = new Worker(new URL('extract/worker.js', import.meta.url), { type: 'module' });
    cancelBtn.addEventListener('click', () => { worker.postMessage({ type: 'cancel' }); cancelBtn.disabled = true; });

    const barFor = (key: string, label: string) => {
      if (!bars.has(key)) {
        const bar = el('div', { class: 'ob-bar-fill' });
        const pct = el('span', { class: 'ob-bar-pct mono small', text: '' });
        const row = el('div', { class: 'ob-bar-row' },
          el('span', { class: 'ob-bar-label small', text: label }),
          el('div', { class: 'ob-bar' }, bar), pct);
        barsHost.appendChild(row);
        bars.set(key, { bar, pct, label });
      }
      return bars.get(key)!;
    };

    // Per-stage first/last-message times, logged once at 'done' as a single
    // [perf] line the e2e harness can scrape. Timing is observational only.
    const stageT = new Map<string, { t0: number; t1: number }>();
    worker.onmessage = async (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        let key, label;
        if (msg.stage === 'hash') { key = `hash${msg.bundle}`; label = `Checking assetBundle${msg.bundle}`; }
        else if (msg.stage === 'copy') { key = `copy${msg.bundle}`; label = `Storing assetBundle${msg.bundle}`; }
        else if (msg.stage === 'datatable') { key = 'dt'; label = 'Reading the game index'; }
        else if (msg.stage === 'system') { key = 'system'; label = 'Validating system mappings'; }
        else if (msg.stage === 'world') { key = `world-${msg.step}`; label = WORLD_STEPS[msg.step] || `World: ${msg.step}`; }
        else if (msg.stage === 'index') { key = `idx-${msg.cat}`; label = `Extracting ${CAT_INFO[msg.cat]?.label || msg.cat}`; }
        else { key = msg.stage; label = msg.stage; }
        const now = Date.now();
        const st = stageT.get(key);
        if (st) st.t1 = now; else stageT.set(key, { t0: now, t1: now });
        const b = barFor(key, label);
        const frac = msg.total ? msg.done / msg.total : 0;
        b.bar.style.width = `${(frac * 100).toFixed(1)}%`;
        b.pct.textContent = msg.total > 1000000 ? `${fmtBytes(msg.done)} / ${fmtBytes(msg.total)}`
          : `${fmtInt(msg.done)} / ${fmtInt(msg.total)}`;
        status.textContent = msg.skipped ? `${label}: already stored, skipped` : `${label}…`;
      } else if (msg.type === 'done') {
        worker.terminate();
        const stages: Record<string, number> = {};
        for (const [k, t] of stageT) stages[k] = +((t.t1 - t.t0) / 1000).toFixed(2);
        console.log(`[perf] extract ${JSON.stringify({ seconds: msg.result.seconds, stages })}`);
        renderDone(msg.result, cats);
      } else if (msg.type === 'error') {
        worker.terminate();
        status.textContent = `Extraction failed: ${msg.message}`;
        status.classList.add('err');
        root.appendChild(el('div', { class: 'ob-actions' },
          el('span', { class: 'spacer' }),
          (() => { const b = el('button', { class: 'btn', text: 'Start over' }); b.addEventListener('click', render); return b; })()));
      }
    };

    worker.postMessage({ type: 'ingest', files: picked, cats });
  }

  // ---------------------------------------------------------------- done
  async function renderDone(result: any, cats: string[]) {
    const est = await storageEstimate();
    clear(root);
    const catLine = [
      ...cats.map((c) => CAT_INFO[c]?.label || c),
      ...(result.manifest?.system
        ? [`System catalog (${fmtInt(result.manifest.system.counts.mapped_meshes)} mapped meshes, ${fmtInt(result.manifest.system.counts.models)} models)`]
        : []),
    ].join(', ');
    const goBtn = el('button', { class: 'btn primary', text: 'Open the viewer →' });
    goBtn.addEventListener('click', () => onDone?.(result));
    // A failed world stage is a whole-category failure, not a skipped item:
    // surface its actual error message instead of hiding it in the count.
    const worldErr = cats.includes('world')
      ? result.errors.find((e: any) => typeof e === 'string' && e.startsWith('world: ')) : null;
    const otherErrors = result.errors.length - (worldErr ? 1 : 0);
    root.append(
      el('h2', { text: 'Done: everything stays on this machine' }),
      el('div', { class: 'ob-done card' },
        el('p', {}, el('b', { text: `Extracted in ${result.seconds.toFixed(1)}s: ` }), catLine),
        el('p', { class: 'dim small', text: `Game build ${result.versionId.slice(0, 8)} · using ${fmtBytes(est.usage || 0)} of local browser storage.` }),
        ...(worldErr ? [el('p', { class: 'small err',
          text: `World couldn't be extracted: ${worldErr.slice('world: '.length)}` })] : []),
        otherErrors
          ? el('p', { class: 'small err', text: `${otherErrors} item(s) couldn't be read and were skipped.` })
          : worldErr ? null : el('p', { class: 'dim small', text: 'Everything decoded cleanly. Next time, it loads instantly from your device.' })),
      el('div', { class: 'ob-actions' }, el('span', { class: 'spacer' }), goBtn));
    if (result.errors.length) console.warn('ingest errors:', result.errors);
    setTimeout(() => onDone?.(result), 2500);   // auto-continue; the button is for the impatient
  }

  render();
}

