// Optional friendly names for every asset, keyed by CONTENT HASH (the `h`
// index field) so they survive bundle re-ordering — same pattern as the
// texture-override store. Authoritative store = IndexedDB 'userdata'
// (hydrateNames() at boot; localStorage stays as the migration seed +
// backstop, dual-written). Persistence to disk happens ONLY through the
// topbar "overrides" manager, which bundles names + texture overrides into
// one asset_overrides.json.

import { userdataGet, userdataPut } from './storage.js';
import type { IndexEntry } from './store.js';

const KEY = 'bs.assetNames';

interface NamesFile { version: number; algo: string; names: Record<string, string> }

function load(): NamesFile {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY)!);
    if (raw && typeof raw === 'object' && raw.names) return raw;
  } catch { /* fall through */ }
  return { version: 1, algo: 'sha256/16', names: {} };
}

const cur = load();

// Boot-time hydration: IndexedDB is authoritative when present; a legacy
// localStorage set migrates into it once. Await this before first render.
export async function hydrateNames(): Promise<void> {
  try {
    const stored = await userdataGet('assetNames');
    if (stored?.names) {
      for (const k of Object.keys(cur.names)) delete cur.names[k];
      Object.assign(cur.names, stored.names);
    } else if (Object.keys(cur.names).length) {
      await userdataPut('assetNames', cur);   // one-time migration
    }
  } catch { /* IDB unavailable — localStorage mirror still works */ }
}

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* storage unavailable */ }
  userdataPut('assetNames', JSON.parse(JSON.stringify(cur))).catch(() => {});
}

// cat disambiguates the index-fallback key only; hash keys are global
export function nameKey(entry: IndexEntry, cat: string): string {
  return entry.h || `idx:${cat}:${entry.b != null ? `${entry.b}:` : ''}${entry.i}`;
}

// local edit > name baked into the export > null
export function effectiveName(entry: IndexEntry, cat: string): string | null {
  const local = cur.names[nameKey(entry, cat)];
  if (local !== undefined) return local || null;   // '' = locally cleared
  return entry.name || null;
}

export function setLocalName(entry: IndexEntry, cat: string, name: string | null | undefined): void {
  const key = nameKey(entry, cat);
  const trimmed = (name || '').trim();
  if (!trimmed && !entry.name) delete cur.names[key];  // nothing to shadow
  else cur.names[key] = trimmed;                       // '' shadows a baked name
  save();
}

export function localNameCount(): number { return Object.keys(cur.names).length; }

// Full replacement names file: baked names ∪ local edits (local wins).
export function buildNamesFile(indexesByCat: Record<string, IndexEntry[] | null | undefined> | null | undefined): NamesFile {
  const names: Record<string, string> = {};
  for (const [cat, idx] of Object.entries(indexesByCat || {})) {
    for (const e of idx || []) {
      if (e.name) names[nameKey(e, cat)] = e.name;
    }
  }
  for (const [k, v] of Object.entries(cur.names)) {
    if (v) names[k] = v;
    else delete names[k];   // locally cleared
  }
  return { version: 1, algo: 'sha256/16', names };
}

// MERGE a lower-priority name map in: only keys with no local value are
// taken (vended defaults must never stomp user edits). Returns count added.
export function mergeNames(map: Record<string, any> | null | undefined): number {
  let n = 0;
  for (const [k, v] of Object.entries(map || {})) {
    if (cur.names[k] === undefined && typeof v === 'string' && v.trim()) {
      cur.names[k] = v.trim();
      n++;
    }
  }
  if (n) save();
  return n;
}

// REPLACE the local name set from a parsed {hash: name} map; returns count
export function replaceNames(map: Record<string, any> | null | undefined): number {
  for (const k of Object.keys(cur.names)) delete cur.names[k];
  let n = 0;
  for (const [k, v] of Object.entries(map || {})) {
    if (typeof v === 'string' && v.trim()) { cur.names[k] = v.trim(); n++; }
  }
  save();
  return n;
}
