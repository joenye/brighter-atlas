// Browser persistence for client-side extraction. Two backends, one module:
//
//   OPFS  bs/raw/<sha256>   — raw bundle copies, content-addressed by file hash
//                             (identical bundles shared across versions for free).
//                             Where OPFS is unavailable or fails, raw blobs fall
//                             back to the IndexedDB 'rawblobs' store (design §4:
//                             treat OPFS as may-fail).
//   IndexedDB 'bs-assets'   — 'versions' registry, 'derived' per-version JSON
//                             (indexes, datatable extracts, frame tables, manifest),
//                             'meta' (active version id, flags), 'userdata'
//                             (overrides + names — durable, cross-version),
//                             'rawblobs' (OPFS fallback tier).
//
// Works from both the main thread and workers; OPFS writes prefer
// createWritable and fall back to sync access handles (worker-only API).
// All large writes decorate QuotaExceededError with actionable guidance.

const DB_NAME = 'bs-assets';
const DB_VERSION = 2;

// per-bundle facts recorded at ingest (sha256 is the content address of the
// raw blob; mtime is the source file's on-disk modification time, epoch ms)
export interface BundleInfo {
  sha256: string;
  size?: number;
  mtime?: number;
  [k: string]: any;
}

// one row of the 'versions' registry (keyPath 'versionId'); created by the
// ingest pipeline, read everywhere
export interface VersionRecord {
  versionId: string;
  /** extraction-engine generation; absent = pre-0.4.0 data (see notices.ts) */
  engine?: number;
  label?: string;
  /** build label from the per-build decode data (e.g. "23-Apr-2025 (35f5efbc)") — display precedence in ui.versionLabel */
  profileLabel?: string;
  /** sha256 of the decompressed ab0 — the decode-data lookup key, kept so a label can be matched later without re-reading bundles */
  ab0RawSha256?: string;
  builtAt?: number | string;
  bundles?: Record<string, BundleInfo>;
  cats?: Record<string, { state?: string; [k: string]: any }>;
  platform?: string;
  platformSource?: string;
  [k: string]: any;
}

export type ProgressFn = (done: number, total: number) => void;

let _db: Promise<IDBDatabase> | null = null;

export function idbOpen(): Promise<IDBDatabase> {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('versions')) db.createObjectStore('versions', { keyPath: 'versionId' });
      if (!db.objectStoreNames.contains('derived')) db.createObjectStore('derived');
      if (!db.objectStoreNames.contains('userdata')) db.createObjectStore('userdata');
      if (!db.objectStoreNames.contains('rawblobs')) db.createObjectStore('rawblobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}

function tx<T = any>(db: IDBDatabase, store: string, mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<any> | void): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve((out?.result !== undefined ? out.result : undefined) as T);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('idb tx aborted'));
  });
}

export async function idbGet(store: string, key: IDBValidKey): Promise<any> {
  const db = await idbOpen();
  return tx(db, store, 'readonly', (s) => s.get(key));
}
export async function idbPut(store: string, value: any, key?: IDBValidKey): Promise<any> {
  const db = await idbOpen();
  return tx(db, store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
}
export async function idbDel(store: string, key: IDBValidKey): Promise<any> {
  const db = await idbOpen();
  return tx(db, store, 'readwrite', (s) => s.delete(key));
}
export async function idbKeys(store: string): Promise<IDBValidKey[]> {
  const db = await idbOpen();
  return tx(db, store, 'readonly', (s) => s.getAllKeys());
}

// ------------------------------------------------------------------ versions
export async function getActiveVersionId(): Promise<string | null> { return (await idbGet('meta', 'activeVersionId')) || null; }
export async function setActiveVersionId(id: string | null): Promise<any> { return idbPut('meta', id, 'activeVersionId'); }
export async function getVersion(id: string | null | undefined): Promise<VersionRecord | null> { return (id && (await idbGet('versions', id))) || null; }
export async function putVersion(rec: VersionRecord): Promise<any> { return idbPut('versions', rec); }
export async function listVersions(): Promise<VersionRecord[]> {
  const db = await idbOpen();
  return tx(db, 'versions', 'readonly', (s) => s.getAll());
}
export async function getActiveVersion(): Promise<VersionRecord | null> { return getVersion(await getActiveVersionId()); }

// ------------------------------------------------------------------ derived
const dKey = (versionId: string, name: string) => `${versionId}:${name}`;
export async function derivedGet(versionId: string, name: string): Promise<any> { return idbGet('derived', dKey(versionId, name)); }
export async function derivedPut(versionId: string, name: string, value: any): Promise<any> { return idbPut('derived', value, dKey(versionId, name)); }

// Batch write: ONE readwrite transaction for many derived records. Every
// put() is issued synchronously — an await between put()s would let the
// transaction auto-commit under us — and the promise settles on oncomplete.
export async function derivedPutMany(versionId: string, entries: [string, any][]): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const t = db.transaction('derived', 'readwrite');
    const s = t.objectStore('derived');
    for (const [name, value] of entries) s.put(value, dKey(versionId, name));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('idb tx aborted'));
  });
}

// Bulk read of every derived record whose name starts with keyPrefix, in one
// getAll. The exclusive upper bound is the prefix's successor string, so a
// sibling key family can never fall inside the range ('world:index' sorts
// before 'world:room:' and 'world:room;' bounds it above).
export async function derivedGetMany(
  versionId: string, keyPrefix: string,
): Promise<{ name: string; value: any }[]> {
  const db = await idbOpen();
  const lo = dKey(versionId, keyPrefix);   // always non-empty: `${versionId}:` at minimum
  const hi = lo.slice(0, -1) + String.fromCharCode(lo.charCodeAt(lo.length - 1) + 1);
  const range = IDBKeyRange.bound(lo, hi, false, true);
  return new Promise((resolve, reject) => {
    const t = db.transaction('derived', 'readonly');
    const s = t.objectStore('derived');
    const keysReq = s.getAllKeys(range);
    const valsReq = s.getAll(range);
    t.oncomplete = () => resolve((keysReq.result as IDBValidKey[]).map((k, at) => ({
      name: String(k).slice(versionId.length + 1),
      value: valsReq.result[at],
    })));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('idb tx aborted'));
  });
}
export async function derivedDeleteVersion(versionId: string): Promise<void> {
  const keys = await idbKeys('derived');
  for (const k of keys) if (String(k).startsWith(`${versionId}:`)) await idbDel('derived', k);
}

// ------------------------------------------------------------------ userdata
// Durable, version-independent user annotations (texture overrides + names).
// texmap.js/names.js keep synchronous in-memory mirrors; these are the
// persistence primitives they hydrate from / write through to.
export async function userdataGet(key: string): Promise<any> { return idbGet('userdata', key); }
export async function userdataPut(key: string, value: any): Promise<any> { return idbPut('userdata', value, key); }

// ------------------------------------------------------------------ quota
// Decorate QuotaExceededError with actionable guidance (design §4: always
// catch it — a silent quota failure reads as data corruption to the user).
async function quotaError(err: any, what: string): Promise<any> {
  if (err?.name !== 'QuotaExceededError') return err;
  let detail = '';
  try {
    const { usage, quota } = await navigator.storage.estimate();
    detail = ` (using ${(usage! / 1e9).toFixed(2)} GB of ~${(quota! / 1e9).toFixed(1)} GB)`;
  } catch { /* estimate unavailable */ }
  return new Error(`browser storage quota exceeded while ${what}${detail} — `
    + 'free disk space, delete an old version from storage, or extract fewer categories');
}

// ------------------------------------------------------------------ raw store
// OPFS when available; IndexedDB 'rawblobs' as the fallback tier.

let _opfsOk: boolean | null = null;
export async function opfsAvailable(): Promise<boolean> {
  if (_opfsOk !== null) return _opfsOk;
  try {
    if (!navigator.storage?.getDirectory) throw new Error('no OPFS');
    await navigator.storage.getDirectory();
    _opfsOk = true;
  } catch { _opfsOk = false; }
  return _opfsOk;
}

async function rawDir(create = false): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const bs = await root.getDirectoryHandle('bs', { create });
  return bs.getDirectoryHandle('raw', { create });
}

async function opfsHasRaw(sha: string, size: number | null = null): Promise<boolean> {
  try {
    const dir = await rawDir();
    const fh = await dir.getFileHandle(sha);
    const f = await fh.getFile();
    return size == null || f.size === size;
  } catch { return false; }
}

// Copy a user-picked File into OPFS in chunks (progress by bytes). Prefers
// sync access handles (worker-only API) — they write IN PLACE, where
// createWritable stages a swap file that is copied over on close(), doubling
// the IO of a multi-hundred-MB bundle copy. Falls back to createWritable on
// the main thread / on error.
async function opfsWriteRaw(sha: string, blob: Blob, onProgress?: ProgressFn): Promise<void> {
  const dir = await rawDir(true);
  const fh: any = await dir.getFileHandle(sha, { create: true });
  const CHUNK = 32 * 1024 * 1024;
  if (fh.createSyncAccessHandle) {
    let h: any = null;
    try { h = await fh.createSyncAccessHandle(); } catch { /* main thread / handle locked */ }
    if (h) {
      try {
        let pos = 0;
        // prefetch the next slice while the current one writes synchronously
        let next: Promise<ArrayBuffer> | null = blob.size
          ? blob.slice(0, Math.min(CHUNK, blob.size)).arrayBuffer() : null;
        while (next) {
          const buf = new Uint8Array(await next);
          const off = pos + buf.length;
          next = off < blob.size ? blob.slice(off, Math.min(off + CHUNK, blob.size)).arrayBuffer() : null;
          h.write(buf, { at: pos });
          pos = off;
          onProgress?.(pos, blob.size);
        }
        h.truncate(blob.size);
        h.flush();
      } finally { h.close(); }
      return;
    }
  }
  const w = await fh.createWritable();
  for (let off = 0; off < blob.size; off += CHUNK) {
    await w.write(await blob.slice(off, Math.min(off + CHUNK, blob.size)).arrayBuffer());
    onProgress?.(Math.min(off + CHUNK, blob.size), blob.size);
  }
  await w.close();
}

// unified raw API — every consumer (ingest sink, ClientStore, sw.js) goes
// through these; the OPFS/IDB split is invisible above this line
export async function hasRaw(sha: string, size: number | null = null): Promise<boolean> {
  if (await opfsAvailable()) {
    if (await opfsHasRaw(sha, size)) return true;
  }
  try {
    const blob = await idbGet('rawblobs', sha);
    return !!blob && (size == null || blob.size === size);
  } catch { return false; }
}

export async function writeRaw(sha: string, blob: Blob, onProgress?: ProgressFn): Promise<void> {
  if (await opfsAvailable()) {
    try {
      await opfsWriteRaw(sha, blob, onProgress);
      return;
    } catch (e) {
      if (e?.name === 'QuotaExceededError') throw await quotaError(e, `storing a ${(blob.size / 1e6).toFixed(0)} MB bundle`);
      // OPFS failed for another reason — fall through to the IDB tier
    }
  }
  try {
    await idbPut('rawblobs', blob, sha);
    onProgress?.(blob.size, blob.size);
  } catch (e) {
    throw await quotaError(e, `storing a ${(blob.size / 1e6).toFixed(0)} MB bundle`);
  }
}

export async function rawFile(sha: string): Promise<Blob> {
  if (await opfsAvailable()) {
    try {
      const dir = await rawDir();
      const fh = await dir.getFileHandle(sha);
      return await fh.getFile();
    } catch { /* not in OPFS — try the IDB tier */ }
  }
  const blob = await idbGet('rawblobs', sha);
  if (!blob) {
    const err = new Error(`assetBundle blob ${sha.slice(0, 8)}… not in storage`) as Error & { code?: string; sha?: string };
    err.code = 'RAW_MISSING';
    err.sha = sha;
    throw err;
  }
  return blob;
}

export async function deleteRaw(sha: string): Promise<void> {
  try { const dir = await rawDir(); await dir.removeEntry(sha); } catch { /* absent is fine */ }
  try { await idbDel('rawblobs', sha); } catch { /* absent */ }
}

export async function listRaw(): Promise<{ sha: string; size: number }[]> {
  const out: { sha: string; size: number }[] = [];
  try {
    const dir = await rawDir();
    for await (const [name, handle] of (dir as any).entries()) {
      const f = await handle.getFile().catch(() => null);
      out.push({ sha: name, size: f?.size ?? 0 });
    }
  } catch { /* no raw dir yet */ }
  try {
    const db = await idbOpen();
    const keys = await tx<IDBValidKey[]>(db, 'rawblobs', 'readonly', (s) => s.getAllKeys());
    for (const sha of keys) {
      if (!out.some((e) => e.sha === sha)) {
        const blob = await idbGet('rawblobs', sha);
        out.push({ sha: sha as string, size: blob?.size ?? 0 });
      }
    }
  } catch { /* no rawblobs store yet */ }
  return out;
}

// delete raw blobs referenced by NO remaining version (content-addressed GC)
export async function gcRaw(): Promise<number> {
  const versions = await listVersions();
  const live = new Set<string>();
  for (const v of versions) for (const b of Object.values(v.bundles || {})) live.add(b.sha256);
  let freed = 0;
  for (const { sha, size } of await listRaw()) {
    if (!live.has(sha)) { await deleteRaw(sha); freed += size; }
  }
  return freed;
}

export async function deleteVersion(versionId: string): Promise<number> {
  await derivedDeleteVersion(versionId);
  await idbDel('versions', versionId);
  if ((await getActiveVersionId()) === versionId) {
    const rest = await listVersions();
    await setActiveVersionId(rest[0]?.versionId ?? null);
  }
  return gcRaw();
}

// ------------------------------------------------------------------ quota
export async function requestPersist(): Promise<boolean> {
  try { return await navigator.storage.persist(); } catch { return false; }
}
export async function isPersisted(): Promise<boolean> {
  try { return await navigator.storage.persisted(); } catch { return false; }
}
export async function storageEstimate(): Promise<StorageEstimate> {
  try { return await navigator.storage.estimate(); } catch { return { usage: 0, quota: 0 }; }
}

export async function wipeAll(): Promise<void> {
  const db = await idbOpen();
  // 'userdata' (overrides/names) is deliberately NOT wiped — it is the only
  // irreplaceable tier and carries across versions by design (§4 tier 4)
  for (const s of ['meta', 'versions', 'derived', 'rawblobs']) await tx(db, s, 'readwrite', (st) => st.clear());
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('bs', { recursive: true });
  } catch { /* absent */ }
}
