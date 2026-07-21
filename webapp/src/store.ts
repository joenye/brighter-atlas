// Data service: resolves the data directory, loads + caches manifest/indexes/payloads,
// decodes base64 little-endian buffers into typed arrays, reports fetch errors.

import type { VersionRecord } from './storage.js';

// One row of a category index. `i` is the bundle ordinal (the public asset
// identity), `h` the stable 16-hex content hash when known. Category-specific
// fields (verts, codec, …) ride along untyped.
export interface IndexEntry {
  i: number;
  h?: string;
  name?: string;
  [key: string]: any;
}

export interface Manifest {
  categories?: Record<string, { index?: string; exported?: boolean; [k: string]: any }>;
  system?: { models?: string; bindings?: string; [k: string]: any };
  [k: string]: any;
}

// detail payload of the 'fetcherror' CustomEvent both stores dispatch
export interface FetchErrorDetail { url: string; message: string }

// The app-wide data-store contract: the union of what the HTTP `Store` and
// `ClientStore` (client-store.ts) provide. Viewers type against this and never
// know where the bytes came from. Events: 'fetcherror' (both, detail:
// FetchErrorDetail) and 'bundlemissing' (client mode, detail: {n, sha}).
export interface AppStore extends EventTarget {
  base: string;
  manifest: Manifest | null;
  url(rel: string): string;
  loadManifest(): Promise<Manifest | null>;
  index(cat: string): Promise<IndexEntry[]>;
  worldIndex(): Promise<any>;
  worldRoom(id: number | string): Promise<any>;
  /** Bulk shard fetch keyed by room id (client mode: one IDB transaction per
   *  call). Callers must pass BOUNDED id batches — fetching every shard at
   *  once spikes the heap by hundreds of MB on a full world. */
  worldRooms?(ids: (number | string)[]): Promise<Map<number, any>>;
  json(rel: string): Promise<any>;
  payload(rel: string): Promise<any>;
  arrayBuffer(rel: string): Promise<ArrayBuffer>;
  fetchJSON(rel: string, opts?: { silent?: boolean }): Promise<any>;
  fetchText(rel: string): Promise<string>;
  // client-mode only
  versionId?: string;
  version?: VersionRecord;
  invalidateBundle?(n: number): void;
  validateBundleConsistency?(sampleSize?: number): Promise<{
    checked: number;
    mismatches: { i: number; actual: number; expected: number }[];
  } | null>;
}

// Static exports are ordinarily dense and happen to permit index[ordinal], but
// ClientStore deliberately filters absent rows.  Asset ordinals remain the
// public identity in either case, so consumers must resolve the entry's `i`
// field rather than treating an ordinal as an array offset.  Cache the sparse
// lookup per immutable index while retaining the dense fast path.
const ORDINAL_MAPS = new WeakMap<object, Map<number, IndexEntry>>();
export function entryByOrdinal(index: IndexEntry[] | null | undefined, ordinal: number): IndexEntry | null {
  if (!Array.isArray(index) || !Number.isInteger(ordinal)) return null;
  const direct = index[ordinal];
  if (direct?.i === ordinal) return direct;
  let byOrdinal = ORDINAL_MAPS.get(index);
  if (!byOrdinal) {
    byOrdinal = new Map(index.filter(Boolean).map((entry) => [entry.i, entry]));
    ORDINAL_MAPS.set(index, byOrdinal);
  }
  return byOrdinal.get(ordinal) || null;
}

export class Store extends EventTarget implements AppStore {
  base: string;
  manifest: Manifest | null;
  private _indexes: Map<string, Promise<any>>;
  private _json: Map<string, Promise<any>>;
  private _payloadCache: Map<string, any>;
  private _payloadCap: number;

  constructor() {
    super();
    const params = new URLSearchParams(location.search);
    this.base = (params.get('data') || 'data').replace(/\/+$/, '');
    this.manifest = null;
    this._indexes = new Map();     // cat -> Promise<array>
    this._json = new Map();        // path -> Promise<obj>   (small payloads: skeletons)
    this._payloadCache = new Map();// path -> obj            (bounded LRU for big payloads)
    this._payloadCap = 24;
  }

  url(rel: string): string { return `${this.base}/${rel}`; }

  private _fail(url: string, err: any): never {
    const msg = `${url}: ${err.message || err}`;
    this.dispatchEvent(new CustomEvent('fetcherror', { detail: { url, message: msg } }));
    throw err instanceof Error ? err : new Error(msg);
  }

  async fetchJSON(rel: string, { silent = false }: { silent?: boolean } = {}): Promise<any> {
    const url = this.url(rel);
    let res: Response;
    try { res = await fetch(url); } catch (e) {
      if (silent) return null;
      this._fail(url, e);
    }
    if (!res.ok) {
      if (silent) return null;
      this._fail(url, new Error(`HTTP ${res.status}`));
    }
    try { return await res.json(); } catch (e) {
      if (silent) return null;
      this._fail(url, new Error(`bad JSON (${e.message})`));
    }
  }

  async fetchText(rel: string): Promise<string> {
    const url = this.url(rel);
    let res: Response;
    try { res = await fetch(url); } catch (e) { this._fail(url, e); }
    if (!res.ok) this._fail(url, new Error(`HTTP ${res.status}`));
    return res.text();
  }

  // manifest.json — null means "no data exported yet" (drives onboarding screen)
  async loadManifest(): Promise<Manifest | null> {
    this.manifest = await this.fetchJSON('manifest.json', { silent: true });
    return this.manifest;
  }

  // full category catalog (index/<cat>.json); cached forever (immutable per export)
  index(cat: string): Promise<IndexEntry[]> {
    if (!this._indexes.has(cat)) {
      const rel = this.manifest?.categories?.[cat]?.index || `index/${cat}.json`;
      this._indexes.set(cat, this.fetchJSON(rel).catch((e) => { this._indexes.delete(cat); throw e; }));
    }
    return this._indexes.get(cat)!;
  }

  // world data only exists when the export carries an extracted World
  // category (manifest-gated so fixtures/classic trees never see a request)
  worldIndex(): Promise<any> {
    if (!this.manifest?.categories?.world?.exported) return Promise.resolve(null);
    if (!this._indexes.has('world:index')) {
      this._indexes.set('world:index', this.fetchJSON('world/index.json')
        .catch((e) => { this._indexes.delete('world:index'); throw e; }));
    }
    return this._indexes.get('world:index')!;
  }

  async worldRoom(id: number | string): Promise<any> {
    if (!this.manifest?.categories?.world?.exported) return null;
    return this.json(`world/rooms/${String(id).padStart(5, '0')}.json`);
  }

  // HTTP mode keeps per-room fetches — this is just their parallel form, so
  // callers get one Map regardless of the backing store. Failed rooms are
  // simply absent (callers fall back to worldRoom for its error surface).
  async worldRooms(ids: (number | string)[]): Promise<Map<number, any>> {
    const map = new Map<number, any>();
    if (!this.manifest?.categories?.world?.exported) return map;
    const list = ids;
    await Promise.all(list!.map(async (id) => {
      try {
        const shard = await this.worldRoom(id);
        if (shard) map.set(Number(id), shard);
      } catch { /* absent from the map — caller retries per room */ }
    }));
    return map;
  }

  // small JSON payloads, cached forever (skeletons)
  json(rel: string): Promise<any> {
    if (!this._json.has(rel)) {
      this._json.set(rel, this.fetchJSON(rel).catch((e) => { this._json.delete(rel); throw e; }));
    }
    return this._json.get(rel)!;
  }

  // large payloads (meshes, anims) — bounded LRU cache
  async payload(rel: string): Promise<any> {
    if (this._payloadCache.has(rel)) {
      const v = this._payloadCache.get(rel);
      this._payloadCache.delete(rel);
      this._payloadCache.set(rel, v); // refresh LRU position
      return v;
    }
    const obj = await this.fetchJSON(rel);
    this._payloadCache.set(rel, obj);
    while (this._payloadCache.size > this._payloadCap) {
      this._payloadCache.delete(this._payloadCache.keys().next().value!);
    }
    return obj;
  }

  async arrayBuffer(rel: string): Promise<ArrayBuffer> {
    const url = this.url(rel);
    let res: Response;
    try { res = await fetch(url); } catch (e) { this._fail(url, e); }
    if (!res.ok) this._fail(url, new Error(`HTTP ${res.status}`));
    return res.arrayBuffer();
  }
}

// ---- base64 (little-endian) -> typed arrays -------------------------------
// Files are written little-endian; JS typed arrays are little-endian on every
// platform this app targets (x86/ARM), so a plain view over the bytes is exact.

export function b64Bytes(s: string): Uint8Array {
  // Native decoder when available (V8 13+): same standard-alphabet padded
  // input, same bytes out, minus the per-char loop (mesh/anim payload decode
  // is a main-thread hot path).
  if (typeof (Uint8Array as any).fromBase64 === 'function') {
    return (Uint8Array as any).fromBase64(s) as Uint8Array;
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64f32(s: string): Float32Array { const b = b64Bytes(s); return new Float32Array(b.buffer, 0, b.byteLength >> 2); }
export function b64u16(s: string): Uint16Array { const b = b64Bytes(s); return new Uint16Array(b.buffer, 0, b.byteLength >> 1); }
export function b64u32(s: string): Uint32Array { const b = b64Bytes(s); return new Uint32Array(b.buffer, 0, b.byteLength >> 2); }
export function b64u8(s: string): Uint8Array { return b64Bytes(s); }
