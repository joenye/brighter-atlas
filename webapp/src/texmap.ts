// Mesh->texture resolution + persistent user overrides.
//
// - Role resolution: an ab3 image's sub-images group into mip chains (stored
//   smallest-first; see texture-roles.js). Albedo = the largest mip of the
//   first RGB/RGBA chain, normal = the first BC5S chain; every later BC1/BC3
//   plane stays ordered so cutout and recolour do not get collapsed into one
//   role.
// - Overrides: keyed by the mesh CONTENT HASH (`h` index field, sha256/16 of
//   the decompressed object) so they survive bundle re-ordering; `idx:<i>` is
//   the fallback key when hashes are absent. Authoritative store = IndexedDB
//   'userdata' (durable, cross-version), hydrated into this module's
//   synchronous in-memory mirror at boot (hydrateOverrides());
//   localStorage is kept as a legacy/migration seed + same-machine backstop
//   (every save writes both). Persistence to disk happens ONLY through the
//   topbar "overrides" manager (asset_overrides.json,
//   {version:2, overrides, names}).

import { userdataGet, userdataPut } from './storage.js';
import { entryByOrdinal } from './store.js';
import { detectChains, resolveRoles } from './texture-roles.js';

export { detectChains, resolveRoles };

const KEY = 'bs.texOverrides';

type OverrideMode = 'replace' | 'supplement';

interface VariantRef { image: number | null; image_hash: string | null; }

// serialized override record: the value shape inside asset_overrides.json's
// {version:2, overrides} map (and the localStorage/IndexedDB mirrors)
interface StoredOverride {
  mode: OverrideMode;
  variants: VariantRef[];
  active: number | null;
  active_hash: string | null;
  active_image: number | null;
  active_system_key: string | null;
  cleared: boolean;
}

// normalized in-memory override state (norm() output)
interface OverrideState {
  variants: VariantRef[];
  active: number | null;
  activeHash: string | null;
  activeImage: number | null;
  activeSystemKey: string | null;
  activeSystemKeySpecified: boolean;
  activeSpecified: boolean;
  cleared: boolean;
  mode: OverrideMode;
}

// effective-set variant: a system/user record plus private UI bookkeeping
interface EffectiveVariant {
  image?: number | null;
  image_hash?: string | null;
  origin?: 'system' | 'user';
  _userIndex?: number | null;
  _systemIndex?: number;
  _systemKey?: string | null;
  alsoSystem?: boolean;
  [key: string]: any;
}

export interface EffectiveVariantSet {
  variants: EffectiveVariant[];
  active: number | null;
  mode: OverrideMode | null;
  user: { state: OverrideState; local: boolean } | null;
  systemCount: number;
  userCount: number;
}

// exported PNG path for sub-image k of an image entry, or null if not on disk
export function texFile(imgEntry: any, k: number | null | undefined): string | null {
  if (k == null || !imgEntry?.f?.length) return null;
  const suffix = `_e${k}.png`;
  return imgEntry.f.find((f: string) => f.endsWith(suffix)) || null;
}

// ---------------------------------------------------------------- override store

interface OverrideFile { version: number; algo: string; overrides: Record<string, any>; }

function load(): OverrideFile {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY)!);
    if (raw && typeof raw === 'object' && raw.overrides) return raw;
  } catch { /* fall through */ }
  return { version: 1, algo: 'sha256/16', overrides: {} };
}

const cur = load();

// Boot-time hydration: IndexedDB is authoritative when present; a legacy
// localStorage set migrates into it once. Await this before first render.
export async function hydrateOverrides(): Promise<void> {
  try {
    const stored = await userdataGet('texOverrides');
    if (stored?.overrides) {
      for (const k of Object.keys(cur.overrides)) delete cur.overrides[k];
      Object.assign(cur.overrides, stored.overrides);
    } else if (Object.keys(cur.overrides).length) {
      await userdataPut('texOverrides', cur);   // one-time migration
    }
  } catch { /* IDB unavailable: localStorage mirror still works */ }
}

function save(): void {
  cur.version = 2;
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* storage unavailable */ }
  userdataPut('texOverrides', JSON.parse(JSON.stringify(cur))).catch(() => {});
}

function overrideKey(meshEntry: any): string { return meshEntry.h || `idx:${meshEntry.i}`; }

function getRaw(meshEntry: any): any { return cur.overrides[overrideKey(meshEntry)] || null; }

// A user mapping can replace the built-in set (the legacy/default behaviour)
// or supplement it. Hash-only variants are intentionally retained: they render
// as "not in this version", never as the stale ordinal stored beside the hash.
function norm(raw: any): OverrideState | null {
  if (!raw || typeof raw !== 'object') return null;
  // Default to "system + user" (supplement); switch to "user replaces system"
  // (replace) only when this record actually supplies a user texture (a variant,
  // an image, or an explicit clear). An explicit stored mode always wins.
  const userProvided = (Array.isArray(raw.variants)
      && raw.variants.some((v: any) => v && (v.image != null || v.image_hash)))
    || raw.image != null || !!raw.image_hash || !!raw.cleared;
  const mode: OverrideMode = raw.mode === 'supplement' ? 'supplement'
    : raw.mode === 'replace' ? 'replace'
    : (userProvided ? 'replace' : 'supplement');
  const activeSystemKeySpecified = Object.hasOwn(raw, 'active_system_key');
  const activeSystemKey = typeof raw.active_system_key === 'string' && raw.active_system_key
    ? raw.active_system_key : null;
  if (Array.isArray(raw.variants)) {
    const variants: VariantRef[] = raw.variants
      .filter((v: any) => v && (v.image != null || v.image_hash))
      .map((v: any) => ({ image: v.image ?? null, image_hash: v.image_hash || null }));
    let active = raw.active === undefined ? (variants.length ? 0 : null) : raw.active;
    if (active !== null && !(active >= 0 && active < variants.length)) active = variants.length ? 0 : null;
    const activeHash = typeof raw.active_hash === 'string' ? raw.active_hash : null;
    const activeImage = Number.isInteger(raw.active_image) ? raw.active_image : null;
    return {
      variants, active, activeHash, activeImage, activeSystemKey, activeSystemKeySpecified, mode,
      activeSpecified: Object.hasOwn(raw, 'active') || Object.hasOwn(raw, 'active_hash')
        || Object.hasOwn(raw, 'active_image') || Object.hasOwn(raw, 'active_system_key'),
      cleared: !!raw.cleared && !variants.length,
    };
  }
  if (raw.cleared) return {
    variants: [], active: null, activeHash: null, activeImage: null,
    activeSystemKey: null, activeSystemKeySpecified,
    activeSpecified: true, cleared: true, mode,
  };
  if (raw.image != null || raw.image_hash) return {
    variants: [{ image: raw.image ?? null, image_hash: raw.image_hash || null }],
    active: 0, activeHash: raw.image_hash || null,
    activeImage: Number.isInteger(raw.image) ? raw.image : null,
    activeSystemKey: null, activeSystemKeySpecified,
    activeSpecified: true, cleared: false, mode,
  };
  // A mode/active-only supplement is meaningful: it can select one of the
  // system variants without copying system data into the user file.
  if (raw.mode === 'supplement' || raw.active_hash || Number.isInteger(raw.active_image)
      || activeSystemKey) return {
    variants: [], active: null,
    activeHash: typeof raw.active_hash === 'string' ? raw.active_hash : null,
    activeImage: Number.isInteger(raw.active_image) ? raw.active_image : null,
    activeSystemKey, activeSystemKeySpecified,
    activeSpecified: Object.hasOwn(raw, 'active') || !!raw.active_hash
      || Number.isInteger(raw.active_image) || !!activeSystemKey,
    cleared: false, mode,
  };
  return null;
}

function serialize(n: OverrideState | null): StoredOverride | null {
  if (!n) return null;
  if (!n.variants.length && !n.cleared && n.mode !== 'supplement') return null;
  return {
    mode: n.mode === 'supplement' ? 'supplement' : 'replace',
    variants: n.variants.map((v) => ({ image: v.image ?? null, image_hash: v.image_hash || null })),
    active: n.active ?? null,
    active_hash: n.activeHash || null,
    active_image: Number.isInteger(n.activeImage) ? n.activeImage : null,
    active_system_key: n.activeSystemKey || null,
    cleared: !!n.cleared,
  };
}

function writeOverride(meshEntry: any, n: OverrideState): void {
  const key = overrideKey(meshEntry);
  const s = serialize(n);
  if (s === null) delete cur.overrides[key]; else cur.overrides[key] = s;
  save();
}

function bakedRaw(meshEntry: any): any {
  const tex = meshEntry?.tex;
  if (!tex || tex.src !== 'user') return null;
  if (Array.isArray(tex.variants)) {
    const raw: any = {
      mode: tex.mode || 'replace', variants: tex.variants,
      active: tex.active, active_hash: tex.active_hash,
      active_image: tex.active_image, cleared: tex.cleared,
    };
    if (Object.hasOwn(tex, 'active_system_key')) raw.active_system_key = tex.active_system_key;
    return raw;
  }
  if (tex.a == null) return { mode: tex.mode || 'replace', cleared: true };
  return { mode: tex.mode || 'replace', image: tex.a, image_hash: tex.image_hash || null };
}

function userState(meshEntry: any): { state: OverrideState; local: boolean } | null {
  const local = norm(getRaw(meshEntry));
  if (local) return { state: local, local: true };
  const baked = norm(bakedRaw(meshEntry));
  return baked ? { state: baked, local: false } : null;
}

function cloneState(n: OverrideState | null): OverrideState | null {
  return n ? {
    ...n, variants: n.variants.map((v) => ({ ...v })),
  } : null;
}

function imageVariantKey(v: any): string | null {
  if (v?.image_hash) return `h:${v.image_hash}`;
  return Number.isInteger(v?.image) ? `i:${v.image}` : null;
}

// System variants are material bindings, not merely their first/preview
// image.  Keep the ordered full texture tuple in the identity so two
// materials that share an albedo remain independently selectable.  Hashes are
// preferred for cross-version stability; profile-scoped ordinals are the
// explicit fallback when an otherwise-valid catalog was exported without
// asset hashes.
function systemVariantKey(v: any): string | null {
  if (!Number.isInteger(v?.material) || !Array.isArray(v?.textures)) return null;
  const textures: string[] = [];
  for (const texture of v.textures) {
    const key = imageVariantKey(texture);
    if (!key) return null;
    textures.push(key);
  }
  const recolor = Array.isArray(v.recolors) ? ['complete', v.recolors]
    : Array.isArray(v.recolors_observed) ? ['observed', v.recolors_observed]
      : null;
  return `sv2:${JSON.stringify([v.material, textures, recolor, v.recolor_schema ?? null])}`;
}

function systemState(meshEntry: any): { variants: EffectiveVariant[]; active: number | null } {
  const raw = meshEntry?.sys;
  if (!raw || !Array.isArray(raw.variants)) return { variants: [], active: null };
  const variants: EffectiveVariant[] = raw.variants
    .filter((v: any) => v && (Number.isInteger(v.image) || v.image_hash))
    .map((v: any, i: number) => ({
      ...v, origin: 'system', _systemIndex: i, _systemKey: systemVariantKey(v),
    }));
  let active = raw.active ?? (variants.length ? 0 : null);
  if (active != null && !(active >= 0 && active < variants.length)) active = variants.length ? 0 : null;
  return { variants, active };
}

// Effective variant set. System entries are never copied into user storage.
// Private _userIndex/_systemIndex fields let the UI edit only user-owned chips.
export function effectiveVariants(meshEntry: any): EffectiveVariantSet {
  const system = systemState(meshEntry);
  const user = userState(meshEntry);
  if (!user) return {
    variants: system.variants, active: system.active, mode: null,
    user: null, systemCount: system.variants.length, userCount: 0,
  };
  const n = user.state;
  const userVariants: EffectiveVariant[] = n.variants.map((v, i) => ({ ...v, origin: 'user', _userIndex: i }));
  let variants: EffectiveVariant[];
  if (n.mode === 'supplement') {
    variants = system.variants.map((v) => ({ ...v }));
    // Image-only user variants can overlay a built-in only when that primary
    // image identifies exactly one system variant.  On a collision the user
    // entry remains separate, preserving every material/full-texture binding.
    const systemByImage = new Map<string, number[]>();
    variants.forEach((v, i) => {
      const key = imageVariantKey(v);
      if (!key) return;
      const matches = systemByImage.get(key) || [];
      matches.push(i);
      systemByImage.set(key, matches);
    });
    const userByImage = new Map<string, number>();
    for (const v of userVariants) {
      const key = imageVariantKey(v);
      const systemMatches = key == null ? [] : (systemByImage.get(key) || []);
      const existing = systemMatches.length === 1
        ? systemMatches[0] : (key == null ? null : userByImage.get(key));
      if (existing != null) {
        variants[existing] = {
          ...variants[existing], ...v,
          ...(existing < system.variants.length ? { alsoSystem: true } : {}),
        };
      }
      else {
        if (key != null) userByImage.set(key, variants.length);
        variants.push(v);
      }
    }
  } else {
    variants = userVariants;
  }

  let active: number | null = null;
  if (n.activeSystemKey) active = variants.findIndex((v) => v._systemKey === n.activeSystemKey);
  // New records explicitly carry the system-key field (null for a user
  // choice), so their user-variant index is unambiguous even when system
  // variants share its primary image. Legacy records retain their historical
  // hash/image precedence below.
  if ((active == null || active < 0) && n.activeSystemKeySpecified) {
    active = n.activeSpecified && n.active != null
      ? variants.findIndex((v) => v._userIndex === n.active) : -1;
  }
  if ((active == null || active < 0) && n.activeHash) {
    active = variants.findIndex((v) => v.image_hash === n.activeHash);
  }
  if (active == null || active < 0) {
    active = Number.isInteger(n.activeImage)
      ? variants.findIndex((v) => v.image === n.activeImage) : -1;
  }
  if (active != null && active < 0 && n.activeSpecified && n.active != null) {
    active = variants.findIndex((v) => v._userIndex === n.active);
  }
  if (active != null && active < 0) {
    active = n.activeSpecified ? null
      : (n.mode === 'supplement' ? system.active : (variants.length ? 0 : null));
  }
  return {
    variants, active, mode: n.mode, user, systemCount: system.variants.length,
    userCount: userVariants.length,
  };
}

export function getVariants(meshEntry: any): EffectiveVariant[] { return effectiveVariants(meshEntry).variants; }
export function getActiveIndex(meshEntry: any): number | null { return effectiveVariants(meshEntry).active; }

// Resolve a variant's ab3 image ordinal for the CURRENT images index. Overrides
// store both a raw `image` ordinal and its `image_hash`; the ordinal is only
// valid for the game version the override was authored against, so a hash match
// (content-addressed) takes precedence. Callers rendering a variant directly
// (e.g. cycling a mesh's skin variants) MUST go through this, exactly as effectiveTex
// does. Otherwise vended defaults resolve to the wrong image on a different
// game build.
export function resolveVariantImage(variant: any, imagesIndex: any): number | null {
  if (!variant) return null;
  // A system catalog is validated against one specific build before export,
  // so its ordinal is authoritative for this index. (Hashes may be absent
  // when the catalog was exported without content hashes.)
  if (variant.origin === 'system' && Number.isInteger(variant.image)) {
    return entryByOrdinal(imagesIndex, variant.image) ? variant.image : null;
  }
  // The content hash is the ONLY stable cross-version key. If the variant was
  // authored with an image_hash, resolve strictly by hash: a stored ab3 ordinal
  // points at a different asset in another bundle build, so it must NOT be used
  // as a fallback (that is what rendered wrong textures after a bundle change).
  // A missing hash match => the texture isn't in this build => render nothing.
  if (variant.image_hash) return imageByHash(imagesIndex, variant.image_hash);
  return variant.image ?? null;   // legacy override with no hash: ordinal is all there is
}

function editableState(meshEntry: any, preferredMode: OverrideMode | null = null): OverrideState {
  const existing = userState(meshEntry)?.state;
  if (existing) return cloneState(existing)!;
  return {
    variants: [], active: null, activeHash: null, activeImage: null,
    activeSystemKey: null, activeSystemKeySpecified: false,
    activeSpecified: false, cleared: false,
    mode: preferredMode || (systemState(meshEntry).variants.length ? 'supplement' : 'replace'),
  };
}

function selectInState(n: OverrideState, variant: EffectiveVariant | null, userIndex: number | null = null): void {
  n.active = userIndex;
  n.activeHash = variant?.image_hash || null;
  n.activeImage = Number.isInteger(variant?.image) ? (variant!.image as number) : null;
  n.activeSystemKey = variant?._systemKey || null;
  n.activeSystemKeySpecified = true;
  n.activeSpecified = true;
  n.cleared = false;
}

// Add a user variant (or activate an existing effective/system variant). The
// first edit on a mesh with built-ins defaults to supplement, preserving them.
export function addVariant(meshEntry: any, imgEntry: any, { mode = null }: { mode?: OverrideMode | null } = {}): void {
  const effective = effectiveVariants(meshEntry);
  const key = imageVariantKey({ image: imgEntry.i, image_hash: imgEntry.h || null });
  const matches = effective.variants.filter((v) => imageVariantKey(v) === key);
  const already = matches.length === 1 ? matches[0] : null;
  const n = editableState(meshEntry, mode);
  if (mode === 'replace' || mode === 'supplement') n.mode = mode;
  if (already && already._userIndex == null && n.mode === 'supplement') {
    selectInState(n, already, null);
    writeOverride(meshEntry, n);
    return;
  }
  let idx = n.variants.findIndex((v) => imageVariantKey(v) === key);
  if (idx < 0) {
    n.variants.push({ image: imgEntry.i, image_hash: imgEntry.h || null });
    idx = n.variants.length - 1;
  }
  selectInState(n, n.variants[idx], idx);
  writeOverride(meshEntry, n);
}

// Effective-set index, or null = show no texture. Selecting a system chip only
// stores its stable selection key; the system record itself remains read-only.
export function setActiveVariant(meshEntry: any, index: number | null): void {
  const effective = effectiveVariants(meshEntry);
  const n = editableState(meshEntry);
  if (index == null) {
    n.active = null; n.activeHash = null; n.activeImage = null; n.activeSystemKey = null;
    n.activeSpecified = true; n.cleared = n.mode === 'replace' && !n.variants.length;
  } else {
    const clamped = Math.max(0, Math.min(effective.variants.length - 1, index));
    const v = effective.variants[clamped];
    if (!v) return;
    selectInState(n, v, v._userIndex ?? null);
  }
  writeOverride(meshEntry, n);
}

export function removeVariant(meshEntry: any, index: number): boolean {
  const effective = effectiveVariants(meshEntry);
  const selected = effective.variants[index];
  if (!selected || selected._userIndex == null) return false; // system-only chip
  const n = editableState(meshEntry);
  const userIndex = selected._userIndex;
  n.variants.splice(userIndex, 1);
  if (n.active != null) {
    if (n.active === userIndex) n.active = null;
    else if (n.active > userIndex) n.active -= 1;
  }
  const activeWasRemoved = effective.active === index;
  if (activeWasRemoved) {
    const fallback = n.mode === 'supplement' ? systemState(meshEntry).variants[0] : n.variants[0];
    if (fallback) selectInState(n, fallback, n.mode === 'replace' ? 0 : null);
    else {
      n.active = null; n.activeHash = null; n.activeImage = null; n.activeSystemKey = null;
      n.activeSpecified = true; n.cleared = n.mode === 'replace';
    }
  }
  writeOverride(meshEntry, n);
  return true;
}

export function clearLocalTexture(meshEntry: any): void {            // explicit "no texture"
  writeOverride(meshEntry, {
    variants: [], active: null, activeHash: null, activeImage: null, activeSystemKey: null,
    activeSystemKeySpecified: false, activeSpecified: true, cleared: true, mode: 'replace',
  });
}

export function setOverrideMode(meshEntry: any, mode: OverrideMode): void {
  if (mode !== 'replace' && mode !== 'supplement') return;
  const n = editableState(meshEntry, mode);
  n.mode = mode;
  if (mode === 'replace' && !n.variants.length) {
    n.active = null; n.activeHash = null; n.activeImage = null; n.activeSystemKey = null;
    n.activeSpecified = true; n.cleared = true;
  } else if (mode === 'supplement' && n.cleared) {
    n.cleared = false;
    const first = systemState(meshEntry).variants[0] || n.variants[0];
    if (first) selectInState(n, first, first.origin === 'system' ? null : 0);
  }
  writeOverride(meshEntry, n);
}
export function removeLocalOverride(meshEntry: any): void {
  delete cur.overrides[overrideKey(meshEntry)];
  save();
}

export function localOverrideCount(): number { return Object.keys(cur.overrides).length; }

// carry an override to new content (diff "carry annotation": base.h -> active.h)
export function carryOverride(fromEntry: any, toEntry: any): boolean {
  const raw = getRaw(fromEntry);
  if (!raw) return false;
  cur.overrides[overrideKey(toEntry)] = JSON.parse(JSON.stringify(raw));
  save();
  return true;
}

// Override state of a mesh for the list badge/filter: 'image' (>=1 variant),
// 'cleared' (explicit no texture), or null (untouched). Local override wins.
export function overrideStatus(meshEntry: any): 'image' | 'cleared' | 'selection' | null {
  const n = userState(meshEntry)?.state;
  if (n) return n.variants.length ? 'image' : (n.cleared ? 'cleared' : 'selection');
  return null;
}

export function systemTextureStatus(meshEntry: any): 'image' | null {
  return systemState(meshEntry).variants.length ? 'image' : null;
}

// hash -> image index lookup, memoized per images-index array
const _hashLut = new WeakMap<object, Map<string, number>>();
function imageByHash(imagesIndex: any, h: string | null): number | null {
  if (!h || !imagesIndex) return null;
  let lut = _hashLut.get(imagesIndex);
  if (!lut) {
    lut = new Map();
    for (const e of imagesIndex) if (e.h) lut.set(e.h, e.i);
    _hashLut.set(imagesIndex, lut);
  }
  return lut.has(h) ? lut.get(h)! : null;
}

// Effective assignment after replace/supplement composition.
export function effectiveTex(meshEntry: any, imagesIndex: any): any {
  const effective = effectiveVariants(meshEntry);
  if (!effective.variants.length && !effective.user) return null;
  const v = effective.active != null ? effective.variants[effective.active] : null;
  const a = v ? resolveVariantImage(v, imagesIndex) : null;
  const src = v?.origin || (effective.user ? 'user' : 'system');
  return {
    a, conf: null, src,
    local: src === 'user' ? !!effective.user?.local : false,
    userLocal: !!effective.user?.local,
    mode: effective.mode,
    variants: effective.variants.length,
    systemVariants: effective.systemCount,
    userVariants: effective.userCount,
    active: effective.active,
    variant: v || null,
  };
}

// ---------------------------------------------------------------- round-trip

// Full replacement overrides file: local overrides ∪ overrides already baked
// into the export (tex.src === 'user') that aren't superseded locally.
export function buildOverridesFile(meshesIndex: any, imagesIndex?: any): OverrideFile {
  const overrides: Record<string, StoredOverride> = {};
  for (const m of meshesIndex || []) {
    if (m.tex?.src !== 'user') continue;
    const key = overrideKey(m);
    const raw = bakedRaw(m);
    const n = norm(raw);
    if (n) overrides[key] = serialize(n)!;
  }
  for (const [key, raw] of Object.entries(cur.overrides)) {
    const n = norm(raw);
    if (n) overrides[key] = serialize(n)!;     // local wins; system never exported
  }
  return { version: 2, algo: 'sha256/16', overrides };
}


// MERGE a lower-priority override map in: only keys with no local value are
// taken (vended defaults must never stomp user edits). Returns count added.
export function mergeOverrides(map: Record<string, any> | null | undefined): number {
  let n = 0;
  for (const [k, v] of Object.entries(map || {})) {
    if (cur.overrides[k] === undefined && v && typeof v === 'object'
        && (v.cleared || v.image != null || v.image_hash || Array.isArray(v.variants)
          || v.mode === 'supplement' || v.active_hash || Number.isInteger(v.active_image)
          || v.active_system_key)) {
      cur.overrides[k] = v;
      n++;
    }
  }
  if (n) save();
  return n;
}

// REPLACE the local override set from a parsed {hash: override} map; returns count
export function replaceOverrides(map: Record<string, any> | null | undefined): number {
  for (const k of Object.keys(cur.overrides)) delete cur.overrides[k];
  let n = 0;
  for (const [k, v] of Object.entries(map || {})) {
    if (v && typeof v === 'object' && (v.cleared || v.image != null || v.image_hash
      || Array.isArray(v.variants) || v.mode === 'supplement' || v.active_hash
      || Number.isInteger(v.active_image) || v.active_system_key)) {
      cur.overrides[k] = v;
      n++;
    }
  }
  save();
  return n;
}
