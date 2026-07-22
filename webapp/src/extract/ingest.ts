// The client-side ingest pipeline: user-picked bundle Files -> hashed, copied
// to OPFS, parsed, per-category indexes built (with per-object content hash h)
// and persisted. Pure logic (storage goes through a `sink`, progress through a
// callback) so node tests can drive it with the real bundles and an in-memory
// sink. The browser worker (worker.js) is a thin postMessage wrapper.
//
// Category selection is first-class: only the bundles the chosen categories
// need are required, hashed, copied and indexed. ab0 (the master datatable) is
// always required: it identifies the game build (versionId = sha256(ab0)) and
// feeds every cross-bundle join.

import {
  parseBundleHeader, readRaw, decodeObject, makeSlabReader,
  type BundleEntry, type BundleFrames,
} from './bundles.js';
import { poolMap, poolHashBlob, shutdownPool } from './pool.js';
import { zstdDecompress, zstdContentSize } from './zstd.js';
import { hashObject, hashText } from './hash.js';
import { parseDatatable } from './datatable.js';
import { bboxesForMeshes } from './metadata.js';
import {
  attachPortableSystemCatalog, preserveSystemMappings, readSystemCatalog,
} from './system-catalog.js';

// Blob with the optional File fields the ingest reads when present.
export type BundleFile = Blob & { name?: string; lastModified?: number };

export interface IngestSink {
  hasRaw(sha256: string, size: number): Promise<any>;
  writeRaw(sha256: string, blob: Blob, onProgress?: (done: number, total: number) => void): Promise<any>;
  derivedGet?(versionId: string, key: string): Promise<any>;
  derivedPut(versionId: string, key: string, value: any): Promise<any>;
  /** optional batch write (one transaction); falls back to serial derivedPut */
  derivedPutMany?(versionId: string, entries: [string, any][]): Promise<any>;
  putVersion(rec: any): Promise<any>;
  getVersion(versionId: string): Promise<any>;
  setActive(versionId: string): Promise<any>;
}

// bundles each category needs beyond ab0 (anims uses ab6 only for bone counts,
// optional; skeletons make it required)
export const CAT_BUNDLES: Record<string, number[]> = {
  meshes: [5, 2],
  images: [3],
  audio: [8],
  anims: [1],
  rigs: [6],
  strings: [],
  world: [2, 3, 5, 6],
};
export const ALL_CATS = Object.keys(CAT_BUNDLES);

export const BUNDLE_LABEL: Record<number, string> = {
  0: 'datatable', 1: 'animations', 2: 'metadata', 3: 'images',
  5: 'meshes', 6: 'rigs', 8: 'audio',
};

export function requiredBundles(cats: string[]): number[] {
  const need = new Set([0]);
  for (const c of cats) for (const b of CAT_BUNDLES[c] || []) need.add(b);
  if (cats.includes('anims')) need.add(6); // bone counts + viewer rig pairing
  return [...need].sort((a, b) => a - b);
}

// Ordinals still address the selected bundle, while skel_h identifies the
// relationship across reordered builds.  Keep the companion absent when no
// validated skeleton hash is available (for example a meshes-only ingest that
// deliberately did not request assetBundle6).
export function attachRelationHashes(
  indexes: Record<string, any[] | null | undefined>,
  skeletons: any[] | null | undefined = indexes.rigs,
): void {
  const byOrdinal = new Map((skeletons || []).filter(Boolean)
    .filter((entry) => entry.h).map((entry) => [entry.i, entry.h]));
  for (const cat of ['meshes', 'anims']) {
    for (const entry of indexes[cat] || []) {
      if (!entry) continue;
      const h = byOrdinal.get(entry.skel);
      if (h) entry.skel_h = h;
    }
  }
}

// round(x, 2) with ties-to-even on the exact double (the index's bbox rounding
// rule). bbox floats come from f32, so x*100 is exactly representable and the
// tie test is faithful.
function pyRound2(x: number): number {
  const y = x * 100;
  const f = Math.floor(y);
  if (y - f === 0.5) return (f % 2 === 0 ? f : f + 1) / 100;
  return Math.round(y) / 100;
}

// files: {n: Blob}; cats: string[]; sink: storage adapter; onProgress(ev); signal?: AbortSignal
// ab4/ab7 (shaders) are the ONLY platform-forked bundles: macOS ships Apple
// 'MTLB' metallibs, Windows ships DirectX 'DXBC' blobs (every other bundle is
// byte-identical across platforms). Decompress the first object of whichever
// shader bundle the user dropped and read its magic -> 'mac' | 'win' | null.
async function sniffBundlePlatform(files: Record<number, BundleFile>): Promise<'mac' | 'win' | null> {
  for (const n of [4, 7]) {
    const blob = files[n];
    if (!blob) continue;
    try {
      const { entries } = await parseBundleHeader(blob, n);
      if (!entries.length) continue;
      const obj = decodeObject(n, await readRaw(blob, entries[0]));   // Uint8Array
      const at = (o: number) => String.fromCharCode(obj[o], obj[o + 1], obj[o + 2], obj[o + 3]);
      if (at(4) === 'MTLB') return 'mac';
      if (at(5) === 'DXBC') return 'win';
    } catch { /* unreadable shader bundle: try the other */ }
  }
  return null;
}

// weak fallback when neither shader bundle was dropped: the browser's own OS.
// Wrong when you extract someone else's cache, so it's flagged as a guess.
function uaPlatformGuess(): 'mac' | 'win' | null {
  try {
    const ua = self.navigator?.userAgent || '';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
    if (/Windows/i.test(ua)) return 'win';
  } catch { /* no navigator */ }
  return null;
}

export interface RunIngestOptions {
  files: Record<number, BundleFile>;
  cats: string[];
  label?: string | null;
  systemCatalog?: any;
  fetchJson?: ((url: string) => Promise<any>) | null;
  sink: IngestSink;
  onProgress?: (ev: any) => void;
  signal?: AbortSignal;
}

export async function runIngest(
  options: RunIngestOptions,
): Promise<{ versionId: string; manifest: any; errors: string[]; seconds: number }> {
  try {
    return await ingest(options);
  } finally {
    // the pooled worker fleet is per-ingest: spawned lazily at the first
    // pooled pass, hard-terminated here on end, error AND abort
    shutdownPool();
  }
}

async function ingest({
  files, cats, label = null, systemCatalog = null, fetchJson = null,
  sink, onProgress = () => {}, signal,
}: RunIngestOptions): Promise<{ versionId: string; manifest: any; errors: string[]; seconds: number }> {
  const t0 = Date.now();
  const bail = () => { if (signal?.aborted) throw new Error('cancelled'); };
  const errors: string[] = [];
  const need = requiredBundles(cats);
  const missing = need.filter((n) => !files[n]);
  if (missing.length) {
    throw new Error(`missing bundle file(s): ${missing.map((n) => `assetBundle${n} (${BUNDLE_LABEL[n]})`).join(', ')}`);
  }

  // ---- 1. identity: whole-file hashes (versionId = sha256(ab0), 16 hex) ----
  // bundles hash concurrently: sha256 of one file is sequential, but the
  // per-bundle streams overlap (WebCrypto digests off-thread; bundles above
  // the native ceiling stream in their own workers via poolHashBlob, so the
  // giant bundles no longer serialize on this thread)
  const shas: Record<number, string> = {};
  await Promise.all(need.map(async (n) => {
    shas[n] = await poolHashBlob(files[n], (done, total) =>
      onProgress({ stage: 'hash', bundle: n, done, total }), signal);
    bail();
  }));
  bail();
  const versionId = shas[0].slice(0, 16);
  const existing = (await sink.getVersion(versionId)) || null;
  // A version id is anchored by ab0, but category re-ingest can also supply
  // ab3/5/etc. Refuse a different raw bundle under the same ab0 instead of
  // silently mixing depots (especially important for attached system ordinals).
  for (const number of need) {
    const stored = existing?.bundles?.[number];
    if (stored && (stored.size !== files[number].size || stored.sha256 !== shas[number])) {
      throw new Error(`assetBundle${number} differs from the copy already stored for build ${versionId}; refusing to mix versions`);
    }
  }

  // ---- 2. framing + cheap validation --------------------------------------
  const frames: Record<number, BundleFrames> = {};
  for (const n of need) {
    bail();
    frames[n] = await parseBundleHeader(files[n], n);
  }

  // ---- 3. copy raw into OPFS (content-addressed: skip blobs already there) --
  await Promise.all(need.map(async (n) => {
    if (await sink.hasRaw(shas[n], files[n].size)) {
      onProgress({ stage: 'copy', bundle: n, done: files[n].size, total: files[n].size, skipped: true });
      return;
    }
    await sink.writeRaw(shas[n], files[n], (done, total) =>
      onProgress({ stage: 'copy', bundle: n, done, total }));
    bail();
  }));
  bail();

  // ---- 4. ab0 datatable -----------------------------------------------------
  onProgress({ stage: 'datatable', done: 0, total: 1 });
  const ab0 = zstdDecompress(await readRaw(files[0], frames[0].entries[0]));
  const dt = parseDatatable(ab0);
  onProgress({ stage: 'datatable', done: 1, total: 1 });

  // Build label from the per-build decode data (display only;
  // versionId stays the id): the bundles carry no build string, but a known
  // build's profile entry does. Best-effort: any failure (offline, node
  // without the defaults, unknown build) just leaves the mtime-derived
  // fallback label in place. Never fails the ingest.
  let profileBuildLabel = null;
  let ab0RawSha256 = null;
  try {
    const { matchWorldProfileEntry } = await import('./world/profile.js');
    const matched = await matchWorldProfileEntry(ab0, { fetchJson: fetchJson as any });
    ab0RawSha256 = matched.rawSha256 || null;
    profileBuildLabel = matched.entry?.label || null;
  } catch { /* label lookup is optional */ }

  // cross-checks: a bundle from a different game build than ab0 is a hard
  // error. frames[] only holds the bundles this ingest NEEDS: a provided but
  // unselected bundle (e.g. the whole game folder dropped for a strings-only
  // extract) has no frame and is simply not checked.
  const check = (n: number, want: number, what: string) => {
    if (frames[n] && frames[n].count !== want) {
      throw new Error(`assetBundle${n} has ${frames[n].count} objects but the datatable expects ${want} ${what}. Mixed game versions?`);
    }
  };
  check(5, dt.meshDir.length, 'meshes');
  check(1, dt.animDir.length, 'animations');
  check(3, dt.textureDir.length, 'images');
  check(8, dt.audioDir.length, 'audio objects');

  // ---- 5. per-category indexes + h ------------------------------------------
  const indexes: Record<string, any[]> = {};

  // slab reader: sequential object reads come from 16 MB contiguous slabs
  // instead of one File.slice().arrayBuffer() per object: ~32k tiny async
  // disk round-trips dominated the index pass otherwise
  const slabReaders = new Map<number, (e: BundleEntry) => Promise<Uint8Array>>();
  const slabRead = (n: number, e: BundleEntry) => {
    if (!slabReaders.has(n)) slabReaders.set(n, makeSlabReader(files[n]));
    return slabReaders.get(n)!(e);
  };

  // CPU-bound index passes fan out across cores (pool.js; sequential fallback
  // is the same jobs.js code). The coordinator derives every ab0-side field
  // itself, so pooled results carry only what the object bytes determine.
  const pooledPass = async (n: number, cat: string, kind: string, extraFor?: (i: number) => any) => {
    const results = await poolMap({
      file: files[n], n, kind, entries: frames[n].entries, extraFor, signal,
      onProgress: (done, total) => onProgress({ stage: 'index', cat, done, total }),
    });
    for (const r of results) if (r?.err) errors.push(`${cat}[${r.i}]: ${r.err}`);
    return results;
  };

  const perObject = async (n: number, cat: string, fn: (i: number, e: BundleEntry) => Promise<any>) => {
    const { count, entries } = frames[n];
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      bail();
      try {
        out[i] = await fn(i, entries[i]);
      } catch (e) {
        errors.push(`${cat}[${i}]: ${e.message}`);
        out[i] = null;
      }
      if (i % 50 === 0 || i === count - 1) onProgress({ stage: 'index', cat, done: i + 1, total: count });
    }
    return out;
  };

  // skeleton bone counts (needed by skeletons AND anims indexes) without
  // decompressing: the zstd frame header carries the content size. frames[6]
  // only exists when a selected category needed ab6: a merely-provided file
  // (whole game folder dropped for a narrower extract) is not framed.
  let skelBones: number[] | null = null;
  if (files[6] && frames[6]) {
    skelBones = [];
    for (const e of frames[6].entries) {
      const raw = await slabRead(6, e);   // sequential reads: slab, not per-object round-trips
      skelBones.push((zstdContentSize(raw) ?? zstdDecompress(raw).length) / 89 | 0);
    }
  }

  if (cats.includes('strings')) {
    indexes.strings = dt.strings.map((s, i) => {
      // synthetic h = sha256/16(utf8(text)): strings are ab0 heap records with
      // no object frame, so this stands in as their stable content id
      // (annotation key + cross-version diff key: always diff by text)
      return { i, off: s.off, text: s.text, src: s.src, n: s.n, h: hashText(s.text) };
    });
    onProgress({ stage: 'index', cat: 'strings', done: indexes.strings.length, total: indexes.strings.length });
  }

  if (cats.includes('rigs')) {
    // pooled decode+hash (same 'hash' job as meshes/anims). bones comes from
    // skelBones, which is (zstdContentSize ?? full-decode length)/89|0 over
    // the same frames: exactly the dec.length/89|0 the serial pass computed
    // (the anims index already trusts skelBones for the identical field).
    const hs = await pooledPass(6, 'rigs', 'hash');
    indexes.rigs = hs.map((r, i) => (!r || r.err ? null
      : { i, bones: skelBones![i], f: `rigs/${String(i).padStart(5, '0')}.json`, h: r.h }));
  }

  if (cats.includes('anims')) {
    const hs = await pooledPass(1, 'anims', 'hash');
    indexes.anims = hs.map((r, i) => {
      if (!r || r.err) return null;
      const [skel, dur] = [dt.animDir[i].skel, dt.animDir[i].dur];
      return {
        i, skel, bones: skelBones && skel >= 0 && skel < skelBones.length ? skelBones[skel] : null,
        dur, frames: Math.ceil(dur / 20) + 1,
        f: `anims/${String(i).padStart(5, '0')}.json`, h: r.h,
      };
    });
  }

  let fullBboxes = null;
  let ab2Shared: (Uint8Array | null)[] | null = null;   // decoded ab2, handed to the world stage
  if (cats.includes('meshes')) {
    // ab2 bboxes first (the i-th bbox-bearing record describes mesh ab5[i]).
    // The pooled ab5 hash pass starts FIRST so the serial ab2 decode below
    // overlaps it on this thread instead of gating it; results are awaited
    // after. ab2objs is still built strictly in bundle order: the bbox
    // alignment contract is untouched.
    onProgress({ stage: 'index', cat: 'meshes', done: 0, total: frames[5].count, note: 'metadata' });
    const hsPromise = pooledPass(5, 'meshes', 'hash');
    hsPromise.catch(() => {});   // a bbox-loop throw must not leave an unhandled rejection
    const ab2objs: Uint8Array[] = [];
    for (const e of frames[2].entries) ab2objs.push(decodeObject(2, await slabRead(2, e)));
    const bboxes = bboxesForMeshes(ab2objs);
    fullBboxes = bboxes;   // full precision, persisted for payload decoding
    // meshes+world: the world stage reuses this decode instead of
    // decompressing all of ab2 a second time (entries released as consumed)
    if (cats.includes('world')) ab2Shared = ab2objs;

    const share: Record<number, number> = {}, clipCounts: Record<number, number> = {};
    const skelOf = (i: number) => { const s = dt.meshDir[i].sref; return s >= 2 ? s - 2 : (s === 0 ? -1 : -2); };
    for (let j = 0; j < dt.meshDir.length; j++) { const s = skelOf(j); if (s >= 0) share[s] = (share[s] || 0) + 1; }
    for (const a of dt.animDir) clipCounts[a.skel] = (clipCounts[a.skel] || 0) + 1;

    const hs = await hsPromise;
    indexes.meshes = hs.map((r, i) => {
      if (!r || r.err) return null;
      const { v, t, sref } = dt.meshDir[i];
      const skel = skelOf(i);
      const bb = bboxes[i];
      return {
        i, v, t, sk: sref >= 1, skel,
        share: skel >= 0 ? (share[skel] || 0) : 0,
        clips: skel >= 0 ? (clipCounts[skel] || 0) : 0,
        bbox: bb ? bb.map(pyRound2) : null,
        f: `meshes/${String(i).padStart(5, '0')}.json`, h: r.h,
      };
    });
  }

  if (cats.includes('audio')) {
    const rs = await pooledPass(8, 'audio', 'audio');
    indexes.audio = rs.map((r, i) => (!r || r.err ? null
      : { ...r, f: `audio/${String(i).padStart(5, '0')}.wav` }));
  }

  if (cats.includes('images')) {
    const rs = await pooledPass(3, 'images', 'images', (i) => dt.textureDir[i]);
    // Per-object cross-check against the datatable's texture directory: the
    // whole-bundle object-count check above cannot catch a same-count build
    // whose image content was patched in place, but the per-object sub-frame
    // counts do. Indexing such a bundle would produce impostor entries whose
    // metadata disagrees with the pixels the payload decoder later serves.
    const mixed = rs.filter((r) => r?.mixedVersion);
    if (mixed.length) {
      const sample = mixed.slice(0, 3).map((r) => `#${r.i} ${r.err}`).join('; ');
      throw new Error(`assetBundle3 content disagrees with the datatable for `
        + `${mixed.length} object${mixed.length === 1 ? '' : 's'} (${sample}). Mixed game versions?`);
    }
    indexes.images = rs.map((r) => {
      if (!r || r.err) return null;
      if (r.ferr) errors.push(r.ferr);
      const { ferr, ...rec } = r;
      return rec;
    });
  }

  let relationSkeletons = indexes.rigs || null;
  if (!relationSkeletons && indexes.anims && frames[6]) {
    // Anim ingest already requires ab6 for exact rig pairing.  Hash its small
    // skeleton objects so anim->rig references are stable even when the user
    // did not also select the Skeletons browsing category.
    relationSkeletons = await perObject(6, 'anims', async (i, e) => {
      const dec = decodeObject(6, await slabRead(6, e));
      return { i, h: await hashObject(dec) };
    });
  } else if (!relationSkeletons && indexes.meshes && sink.derivedGet) {
    // Mesh-only extraction intentionally keeps ab6 optional.  Reuse a
    // previously extracted skeleton catalog for this same build when present.
    relationSkeletons = await sink.derivedGet(versionId, 'index:rigs');
  }
  attachRelationHashes(indexes, relationSkeletons);

  // Preserve an attached catalog if this is a category repair/re-index rather
  // than a catalog replacement. Raw bundle equality was enforced above.
  if (!systemCatalog && existing?.system && indexes.meshes && sink.derivedGet) {
    const previousMeshes = await sink.derivedGet(versionId, 'index:meshes');
    preserveSystemMappings(indexes.meshes, previousMeshes);
  }

  // Optional portable system catalog, produced outside the browser but
  // consumed by the normal browser storage path.  Existing versions may
  // attach one later without re-indexing: load the three exact content-hash
  // indexes from IndexedDB.
  let attachedSystem = null;
  if (systemCatalog) {
    onProgress({ stage: 'system', done: 0, total: 1 });
    for (const cat of ['meshes', 'images', 'rigs']) {
      if (!indexes[cat] && sink.derivedGet) {
        indexes[cat] = await sink.derivedGet(versionId, `index:${cat}`);
      }
    }
    const portable = await readSystemCatalog(systemCatalog);
    const bundleSignatures: Record<string, { size: number; sha256: string }> = {};
    for (const [number, signature] of Object.entries(existing?.bundles || {}) as [string, any][]) {
      bundleSignatures[number] = {
        size: signature.size,
        sha256: signature.sha256,
      };
    }
    for (const number of need) {
      bundleSignatures[number] = { size: files[number].size, sha256: shas[number] };
    }
    attachedSystem = attachPortableSystemCatalog(portable, {
      bundle0Sha256: shas[0],
      bundle0Size: files[0].size,
      bundleSignatures,
      indexes,
    });
    onProgress({ stage: 'system', done: 1, total: 1 });
  }

  // ---- 5.5 optional World extraction (rooms + placement + system catalog) ---
  // Runs entirely off the already-hashed bundles + the per-build decode
  // data. A failure here (unknown build, stage
  // module drift) must not sink the rest of the ingest: the error is reported
  // and the category is marked failed.
  let worldOutcome = null;   // { attachedSystem?, roomsCount, worldIndex }
  let worldError = null;
  if (cats.includes('world')) {
    try {
      // like the system-catalog path: the world pipeline validates against the
      // exact content-hash indexes, extracted this run or already stored
      for (const cat of ['meshes', 'images', 'rigs']) {
        if (!indexes[cat] && sink.derivedGet) {
          indexes[cat] = await sink.derivedGet(versionId, `index:${cat}`);
        }
      }
      const { extractWorld } = await import('./world/index.js');
      worldOutcome = await extractWorld({
        ab0, dt, files, frames, shas, versionId, indexes,
        ab2Objects: ab2Shared,
        sink, onProgress, signal, fetchJson: fetchJson as any,
      });
      // a user-supplied catalog file (validated above) outranks the generated one
      if (worldOutcome.attachedSystem && !attachedSystem) {
        attachedSystem = worldOutcome.attachedSystem;
      }
    } catch (err) {
      if (signal?.aborted || err?.message === 'cancelled') throw err;
      worldError = err?.message || String(err);
      errors.push(`world: ${worldError}`);
    }
  }

  // ---- 6. persist ------------------------------------------------------------
  onProgress({ stage: 'finalize', done: 0, total: 1 });
  // build date: the newest file mtime across the picked bundles. Steam stamps
  // bundle files when an update writes them, so this is the update's date and
  // a far clearer version label than a content hash (which stays as the id)
  const builtAt = Math.max(0, ...need.map((n) => files[n].lastModified || 0)) || null;
  // DD-Mon-YYYY label date, matching ui.fmtDate (which the worker can't import).
  // Display re-derives this from builtAt anyway, so an old label never sticks.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const buildDate = builtAt
    ? (() => { const d = new Date(builtAt); return `${String(d.getDate()).padStart(2, '0')}-${MON[d.getMonth()]}-${d.getFullYear()}`; })()
    : null;
  // label precedence lives in ui.versionLabel: user-passed/friendly > profile
  // build label (stored separately below) > bundle-mtime date > versionId prefix
  const rec = existing || {
    versionId,
    // engine generation. 0.4.0 is a clean break: the counter starts at 1, and
    // any stored data with no `engine` (pre-0.4.0) is prompted to re-extract.
    // Releases after 0.4.0 stay backwards-compatible; only bump this AND the
    // notices.ts check together if a future release again invalidates old data.
    engine: 1,
    label: label || (buildDate ? `build ${buildDate}` : `build ${versionId.slice(0, 8)}`),
    created: new Date().toISOString(), bundles: {}, cats: {},
  };
  // decode-data identity refreshes on EVERY ingest (existing records too):
  // the per-build data can ship after a build was first extracted, and the
  // stored hash lets the app match a label later without re-reading bundles.
  if (ab0RawSha256) rec.ab0RawSha256 = ab0RawSha256;
  if (profileBuildLabel) rec.profileLabel = profileBuildLabel;
  if (builtAt && (!rec.builtAt || builtAt > rec.builtAt)) rec.builtAt = builtAt;
  // platform (macOS / Windows): exact from the shader bundle when present, else a
  // browser guess. Only fill if unknown, so a re-ingest / user choice isn't lost.
  if (!rec.platform) {
    const sniffed = await sniffBundlePlatform(files);
    if (sniffed) { rec.platform = sniffed; rec.platformSource = 'bundle'; }
    else { const g = uaPlatformGuess(); if (g) { rec.platform = g; rec.platformSource = 'ua-guess'; } }
  }
  for (const n of need) {
    rec.bundles[n] = {
      sha256: shas[n], size: files[n].size, name: files[n].name || `assetBundle${n}`,
      mtime: files[n].lastModified || null,
    };
  }
  for (const c of cats) {
    if (c === 'world') continue;   // no index array: stamped from the outcome below
    rec.cats[c] = { state: 'ready', count: indexes[c]?.filter(Boolean).length ?? 0 };
  }
  if (cats.includes('world')) {
    rec.cats.world = worldOutcome
      ? { state: 'ready', count: worldOutcome.roomsCount }
      : { state: 'error', error: worldError };
  }

  // finalize writes batch into ONE transaction where the sink supports it
  // (same keys, same values, just not ~15 serial round-trips)
  const derivedEntries: [string, any][] = [];
  for (const n of need) derivedEntries.push([`frames:${n}`, frames[n].entries.map((e) => [e.offset, e.length])]);
  for (const [cat, idx] of Object.entries(indexes)) derivedEntries.push([`index:${cat}`, idx]);
  if (worldOutcome) derivedEntries.push(['world:index', worldOutcome.worldIndex]);
  if (attachedSystem) {
    derivedEntries.push(['system:models', attachedSystem.models]);
    derivedEntries.push(['system:bindings', attachedSystem.bindings]);
  }
  derivedEntries.push(['datatable:symbols', dt.symbols]);
  derivedEntries.push(['datatable:strings', dt.strings]);
  if (fullBboxes) derivedEntries.push(['datatable:bboxes', fullBboxes]);
  derivedEntries.push(['datatable:meshdir', dt.meshDir]);
  derivedEntries.push(['datatable:animdir', dt.animDir]);
  derivedEntries.push(['datatable:texturedir', dt.textureDir]);

  // counts for categories not extracted (so the UI can show what exists)
  const countOf: Record<string, number> = {
    meshes: dt.meshDir.length, images: dt.textureDir.length, audio: dt.audioDir.length,
    anims: dt.animDir.length, rigs: skelBones?.length ?? (rec.cats.rigs?.count || 0),
    strings: dt.strings.length,
  };
  // world: room count only exists after extraction (0 = not/never extracted);
  // there is no index/world.json: the rooms list lives in derived world:index
  const worldCount = rec.cats.world?.state === 'ready' ? (rec.cats.world.count || 0) : 0;
  const manifest: any = {
    generated: new Date().toISOString().slice(0, 19),
    game: 'Brighter Shores', mode: 'client', versionId,
    categories: Object.fromEntries(ALL_CATS.map((c) => [c, c === 'world'
      ? { count: worldCount, exported: worldCount, index: null }
      : {
        count: countOf[c] ?? 0,
        exported: rec.cats[c]?.state === 'ready' ? (indexes[c]?.filter(Boolean).length ?? rec.cats[c].count) : 0,
        index: `index/${c}.json`,
      }])),
    datatable: { symbols: 'datatable/symbols.json', strings: 'datatable/strings.json' },
    docs: [],
  };
  if (attachedSystem) {
    manifest.system = attachedSystem.manifest;
    rec.system = {
      profile: attachedSystem.manifest.profile,
      counts: attachedSystem.manifest.counts,
    };
  } else if (existing?.system) {
    // Category-only re-ingests preserve an already attached system catalog.
    const oldManifest = await sink.derivedGet?.(versionId, 'manifest');
    if (oldManifest?.system) manifest.system = oldManifest.system;
  }
  derivedEntries.push(['manifest', manifest]);
  if (sink.derivedPutMany) await sink.derivedPutMany(versionId, derivedEntries);
  else for (const [key, value] of derivedEntries) await sink.derivedPut(versionId, key, value);
  await sink.putVersion(rec);
  await sink.setActive(versionId);
  onProgress({ stage: 'finalize', done: 1, total: 1 });

  return { versionId, manifest, errors, seconds: (Date.now() - t0) / 1000 };
}
