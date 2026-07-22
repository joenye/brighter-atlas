// ClientStore: the Store drop-in backed by browser storage instead of a
// static HTTP tree. Same surface as store.ts's Store (loadManifest / index /
// json / payload / arrayBuffer / url / base / manifest / 'fetcherror'), so no
// viewer knows where the bytes came from.
//
//   indexes + datatable  -> IndexedDB 'derived' (built at ingest)
//   JSON payloads        -> decoded on demand from OPFS raw (mesh/anim/skeleton)
//   url() payloads       -> `cs/<versionId>/...` URLs served by the Service
//                           Worker (sw.js) decoding images->PNG / audio->WAV
//
// createStore() picks the data source for the app: ?data= keeps the classic
// HTTP tree (tests, exported-tree browsing); otherwise client data when present.

import { Store } from './store.js';
import type { AppStore, IndexEntry, Manifest } from './store.js';
import {
  getActiveVersionId, getVersion, derivedGet, rawFile, idbOpen,
} from './storage.js';
import type { VersionRecord } from './storage.js';
import { decodeObject, splitAb3 } from './extract/bundles.js';
import { decodeMesh } from './extract/mesh.js';
import { decodeAnim } from './extract/anim.js';
import { decodeSkeleton } from './extract/skeleton.js';
import { correctAudioRate } from './extract/audio.js';

export class ClientStore extends EventTarget implements AppStore {
  versionId: string;
  version: VersionRecord;
  base: string;
  manifest: Manifest | null;
  private _indexes: Map<string, Promise<any>>;
  private _json: Map<string, Promise<any>>;
  private _payloadCache: Map<string, any>;
  private _payloadCap: number;
  private _derived: Map<string, any>;
  private _blobs: Map<number, Promise<Blob>>;

  constructor(versionId: string, versionRec: VersionRecord) {
    super();
    this.versionId = versionId;
    this.version = versionRec;
    this.base = `cs/${versionId}`;          // sw.js owns this URL namespace
    this.manifest = null;
    this._indexes = new Map();              // cat -> Promise<array>
    this._json = new Map();
    this._payloadCache = new Map();         // LRU for decoded payloads
    this._payloadCap = 48;
    this._derived = new Map();              // small derived blobs (dirs)
    this._blobs = new Map();                // bundle n -> Promise<File> (OPFS)
  }

  url(rel: string): string { return `${this.base}/${rel}`; }

  private _fail(rel: string, err: any): never {
    const msg = `${rel}: ${err.message || err}`;
    this.dispatchEvent(new CustomEvent('fetcherror', { detail: { url: rel, message: msg } }));
    throw err instanceof Error ? err : new Error(msg);
  }

  async loadManifest(): Promise<Manifest | null> {
    this.manifest = (await derivedGet(this.versionId, 'manifest')) || null;
    return this.manifest;
  }

  index(cat: string): Promise<IndexEntry[]> {
    if (!this._indexes.has(cat)) {
      this._indexes.set(cat, derivedGet(this.versionId, `index:${cat}`)
        .then(async (idx) => {
          const arr = (idx || []).filter(Boolean);
          if (cat === 'anims') return this._annotateAnimNames(arr);
          if (cat === 'meshes') return this._annotateMeshNames(arr);
          // fix sr/dur for audio indexes built before the bslpc 24 kHz change
          return cat === 'audio' ? arr.map(correctAudioRate) : arr;
        })
        .catch((e) => { this._indexes.delete(cat); throw e; }));
    }
    return this._indexes.get(cat)!;
  }

  // Recovered clip names ('anim:names', written by World extraction) merged
  // onto the anims index entries as `sn`, a display/search layer distinct
  // from the hash-keyed user names, which continue to outrank it in the
  // viewers. Older extractions have no doc; entries stay untouched.
  private async _annotateAnimNames(arr: IndexEntry[]): Promise<IndexEntry[]> {
    try {
      const doc = await derivedGet(this.versionId, 'anim:names');
      const clips = doc?.clips;
      if (!clips || typeof clips !== 'object') return arr;
      for (const entry of arr) {
        const names = clips[String(entry.i)]?.names;
        if (Array.isArray(names) && names.length) (entry as any).sn = names;
      }
    } catch { /* recovered names are optional */ }
    return arr;
  }

  // Recovered wearable-item names ('mesh:names', written by World extraction)
  // merged onto the meshes index entries as `sn`, the same display/search
  // layer as anims, distinct from the hash-keyed user names that outrank it.
  // The item's equip slot ('head'/'torso'/…) rides along as `slot`, marking the
  // mesh player-equippable and feeding the slot facet. Older extractions have no
  // doc; entries stay untouched.
  private async _annotateMeshNames(arr: IndexEntry[]): Promise<IndexEntry[]> {
    try {
      const doc = await derivedGet(this.versionId, 'mesh:names');
      const meshes = doc?.meshes;
      if (!meshes || typeof meshes !== 'object') return arr;
      for (const entry of arr) {
        const rec = meshes[String(entry.i)];
        if (!rec) continue;
        if (Array.isArray(rec.names) && rec.names.length) (entry as any).sn = rec.names;
        if (typeof rec.slot === 'string') (entry as any).slot = rec.slot;
      }
    } catch { /* recovered names are optional */ }
    return arr;
  }

  private async _dir(name: string): Promise<any> {
    if (!this._derived.has(name)) this._derived.set(name, await derivedGet(this.versionId, name));
    return this._derived.get(name);
  }

  // world extraction results: the rooms list + routing tables ('world:index',
  // cached like other indexes) and one columnar shard per room (NOT cached:
  // shards are big and a room load is deliberately one IDB get).
  worldIndex(): Promise<any> {
    if (!this._indexes.has('world:index')) {
      this._indexes.set('world:index', derivedGet(this.versionId, 'world:index')
        .then((idx) => idx || null)
        .catch((e) => { this._indexes.delete('world:index'); throw e; }));
    }
    return this._indexes.get('world:index')!;
  }

  async worldRoom(id: number | string): Promise<any> {
    return (await derivedGet(this.versionId, `world:room:${id}`)) || null;
  }

  // Bulk shard read for the all-rooms world view: every world:room:* doc in
  // ONE readonly transaction (getAll over a key range) instead of ~450
  // sequential gets. getAll returns keys in LEXICOGRAPHIC order (room 100
  // sorts before room 2), so results are keyed by each shard's own `room`
  // field, never by key position. The range's ':'-suffixed lower bound
  // excludes 'world:index' ('i' < 'r'). `ids` filters when provided.
  async worldRooms(ids: (number | string)[]): Promise<Map<number, any>> {
    // One readonly transaction issuing direct gets for exactly these ids \u2014
    // callers pass BOUNDED batches (a whole-range getAll materializes every
    // shard at once; that heap spike crashed a 451-room all-rooms load).
    const db = await idbOpen();
    const map = new Map<number, any>();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('derived', 'readonly');
      const st = t.objectStore('derived');
      for (const id of ids) {
        const req = st.get(`${this.versionId}:world:room:${id}`);
        req.onsuccess = () => {
          const shard = req.result;
          if (shard && Number.isFinite(Number(shard.room))) map.set(Number(shard.room), shard);
        };
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    return map;
  }

  // Sampled cross-bundle consistency audit for an ALREADY-STORED version:
  // the datatable's per-object sub-frame counts must agree with the stored
  // assetBundle3 bytes. Versions ingested before the per-object ingest gate
  // could hold a bundle from a different game build (same object count,
  // patched content), which surfaces as impostor sub-images. Returns
  // {checked, mismatches:[{i, actual, expected}]} or null when images/raw
  // data isn't stored. Cheap: ~32 header-only reads, no decompression.
  async validateBundleConsistency(sampleSize = 32): Promise<{
    checked: number;
    mismatches: { i: number; actual: number; expected: number }[];
  } | null> {
    try {
      const [textureDir, frames] = await Promise.all([
        this._dir('datatable:texturedir'),
        this._dir('frames:3'),
      ]);
      if (!textureDir?.length || !frames?.length) return null;
      const candidates: [number, number][] = [];
      for (let i = 0; i < textureDir.length && i < frames.length; i++) {
        const dir = textureDir[i];
        const flags = Array.isArray(dir) ? dir[0] : dir?.flags;
        const n = Array.isArray(dir) ? dir[1] : dir?.n;
        if (flags === 0 && n > 0) candidates.push([i, n]);
      }
      if (!candidates.length) return null;
      const step = Math.max(1, Math.floor(candidates.length / sampleSize));
      const mismatches: { i: number; actual: number; expected: number }[] = [];
      let checked = 0;
      for (let k = 0; k < candidates.length; k += step) {
        const [i, expected] = candidates[k];
        const raw = await this._rawObject(3, i);
        const actual = splitAb3(raw).frames.length;
        checked++;
        if (actual !== expected) mismatches.push({ i, actual, expected });
      }
      return { checked, mismatches };
    } catch {
      return null;   // raw tier evicted / images never extracted: nothing to audit
    }
  }

  private _bundleBlob(n: number): Promise<Blob> {
    if (!this._blobs.has(n)) {
      const sha = this.version.bundles?.[n]?.sha256;
      const p = (sha
        ? rawFile(sha)
        : Promise.reject(new Error(`assetBundle${n} not stored: extract its category first`))
      ).catch((e) => {
        this._blobs.delete(n);   // a later re-pick must be able to retry
        if (sha && e?.code === 'RAW_MISSING') {
          // raw tier evicted (the expected Safari outcome, design §4): the
          // shell offers a one-bundle re-pick, never a full re-extract
          this.dispatchEvent(new CustomEvent('bundlemissing', { detail: { n, sha } }));
        }
        throw e;
      });
      this._blobs.set(n, p);
    }
    return this._blobs.get(n)!;
  }

  // after a successful re-pick, drop the cached (rejected) blob promise
  invalidateBundle(n: number): void { this._blobs.delete(n); }

  private async _rawObject(n: number, i: number): Promise<Uint8Array> {
    const frames = await this._dir(`frames:${n}`);
    if (!frames || !frames[i]) throw new Error(`no frame table for ab${n}[${i}]`);
    const [offset, length] = frames[i];
    const blob = await this._bundleBlob(n);
    return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
  }

  // 'datatable/symbols.json' | 'datatable/strings.json' | payload rels
  json(rel: string): Promise<any> {
    if (!this._json.has(rel)) {
      this._json.set(rel, this._resolveJson(rel).catch((e) => { this._json.delete(rel); this._fail(rel, e); }));
    }
    return this._json.get(rel)!;
  }

  private async _resolveJson(rel: string): Promise<any> {
    if (rel === 'datatable/symbols.json') return (await derivedGet(this.versionId, 'datatable:symbols')) || [];
    if (rel === 'datatable/strings.json') return (await derivedGet(this.versionId, 'datatable:strings')) || [];
    if (rel === this.manifest?.system?.models) {
      return (await derivedGet(this.versionId, 'system:models')) || [];
    }
    if (rel === this.manifest?.system?.bindings) {
      return (await derivedGet(this.versionId, 'system:bindings')) || null;
    }
    return this._decodePayload(rel);
  }

  // big payloads with a bounded LRU (mirrors Store.payload)
  async payload(rel: string): Promise<any> {
    if (this._payloadCache.has(rel)) {
      const v = this._payloadCache.get(rel);
      this._payloadCache.delete(rel);
      this._payloadCache.set(rel, v);
      return v;
    }
    const obj = await this._decodePayload(rel).catch((e) => this._fail(rel, e));
    this._payloadCache.set(rel, obj);
    while (this._payloadCache.size > this._payloadCap) {
      this._payloadCache.delete(this._payloadCache.keys().next().value!);
    }
    return obj;
  }

  private async _decodePayload(rel: string): Promise<any> {
    const m = rel.match(/^(meshes|anims|rigs)\/(\d{5})\.json$/);
    if (!m) throw new Error(`unsupported client payload: ${rel}`);
    const [, cat, num] = m;
    const i = parseInt(num, 10);
    if (cat === 'meshes') {
      const dir = (await this._dir('datatable:meshdir'))?.[i];
      if (!dir) throw new Error(`no mesh_dir entry for ${i}`);
      const bbox = (await this._dir('datatable:bboxes'))?.[i] || null;   // full precision (ab2)
      const dec = decodeObject(5, await this._rawObject(5, i));
      return decodeMesh(dec, { i, v: dir.v, t: dir.t, sref: dir.sref, bbox });
    }
    if (cat === 'anims') {
      const dir = (await this._dir('datatable:animdir'))?.[i];
      if (!dir) throw new Error(`no anim_dir entry for ${i}`);
      const dec = decodeObject(1, await this._rawObject(1, i));
      return decodeAnim(dec, { i, skel: dir.skel, dur: dir.dur, frameMs: 20 });
    }
    // skeletons
    const dec = decodeObject(6, await this._rawObject(6, i));
    return decodeSkeleton(dec, { i });
  }

  async arrayBuffer(rel: string): Promise<ArrayBuffer> {
    // SW-served payloads (audio WAV for the WebAudio player, image PNGs):
    // fetch our own cs/ namespace: the service worker decodes from OPFS raw
    // and caches, so this shares one decode path with <img>/<audio> consumers
    if (/^(?:audio\/\d{5}\.wav|images\/\d{5}_e\d+\.png)$/.test(rel)) {
      const res = await fetch(this.url(rel));
      if (!res.ok) throw new Error(`${rel}: decode failed (HTTP ${res.status})`);
      return res.arrayBuffer();
    }
    throw new Error(`unsupported client arrayBuffer: ${rel}`);
  }

  async fetchText(rel: string): Promise<string> { this._fail(rel, new Error('no text assets in client mode')); }
  async fetchJSON(rel: string, { silent = false }: { silent?: boolean } = {}): Promise<any> {
    try { return await this.json(rel); } catch (e) { if (silent) return null; throw e; }
  }
}

// Register the payload service worker; resolve when it controls this page (so
// cs/ URLs work on the very first load after onboarding).
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) throw new Error('service workers unavailable (need https or localhost)');
  const reg = await navigator.serviceWorker.register('sw.js', { type: 'module' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    // first install: claim() fires 'controllerchange', so wait briefly, then
    // reload if still uncontrolled (one-time cost on the very first visit)
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1500);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (!navigator.serviceWorker.controller) location.reload();
  }
  return reg;
}

export async function hasClientData(): Promise<boolean> {
  try {
    const id = await getActiveVersionId();
    if (!id) return false;
    return !!(await getVersion(id));
  } catch { return false; }
}

// The one place that decides where the app's data comes from:
//   1. explicit ?data=  -> that HTTP tree (tests, exported-tree browsing)
//   2. client data      -> ClientStore (extracted in this browser)
//   3. otherwise        -> onboarding. Deliberately NO auto-mount of data/:
//      a fresh visitor must get the wizard regardless of what the server
//      happens to host (browse a local export explicitly with ?data=data).
export async function createStore(): Promise<AppStore> {
  const params = new URLSearchParams(location.search);
  if (params.get('data')) return new Store();
  if (await hasClientData()) {
    const id = await getActiveVersionId();
    const rec = await getVersion(id);
    await ensureServiceWorker();
    return new ClientStore(id!, rec!);
  }
  const s = new Store();
  s.loadManifest = async () => null;   // never probe data/ implicitly
  return s;
}
