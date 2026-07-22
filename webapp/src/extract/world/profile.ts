// Per-build world decode data loader. The app hashes the user's decompressed
// assetBundle0 (sha256) and fetches `builds/<hash16>.json` from the site
// origin, where hash16 is the first 16 hex chars of that hash. No data for
// the hash -> the World category is unavailable for that build (everything
// else still extracts).

export const WORLD_PROFILE_KIND = 'brighter-atlas-world-profile';
export const WORLD_PROFILE_FORMAT = 1;

export interface WorldProfileStream {
  object_count: number;
  constructor_start: number;
  constructor_end: number;
  fill_start: number;
  fill_end?: number | null;
}

export interface WorldProfileSelector {
  runtime: number;
  ctor_varints: number;
  fill: string[];
}

// Per-build decode data: structural metadata for one game build.
export interface WorldProfile {
  kind: string;
  format: number;
  label?: string;
  bundle0?: { raw_sha256?: string };
  stream: WorldProfileStream;
  class_fields: Record<string, number>;
  tag6_fields: Record<string, number>;
  selectors: Record<string, WorldProfileSelector>;
  [key: string]: any;
}

// Display-plumbing view of a matched build (see matchWorldProfileEntry).
export interface WorldProfileIndexEntry {
  file: string;
  bundle0_raw_sha256: string;
  label?: string;
  [key: string]: any;
}

export type FetchJson = (rel: string) => Promise<any>;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes : bytes.slice();
  const digest = await crypto.subtle.digest('SHA-256', view as BufferSource);
  let s = '';
  for (const b of new Uint8Array(digest)) s += b.toString(16).padStart(2, '0');
  return s;
}

export function validateWorldProfile(profile: any, rawSha256: string): WorldProfile {
  if (profile?.kind !== WORLD_PROFILE_KIND || profile?.format !== WORLD_PROFILE_FORMAT) {
    throw new Error('not a world decode profile');
  }
  if (profile.bundle0?.raw_sha256 !== rawSha256) {
    throw new Error('world decode profile is for a different game build');
  }
  for (const key of ['stream', 'class_fields', 'tag6_fields', 'selectors']) {
    if (!profile[key] || typeof profile[key] !== 'object') {
      throw new Error(`world decode profile has no ${key}`);
    }
  }
  if (!(profile.stream.object_count > 0)) {
    throw new Error('world decode profile has no object count');
  }
  return profile as WorldProfile;
}

// rel is a site-root-relative path ('builds/<hash16>.json'). The ../../../
// prefix clamps at the origin root from BOTH bundle URLs this module ships in
// (js/main.js and js/extract/worker.js), so the same code works everywhere.
const defaultFetchJson: FetchJson = async (rel) => {
  const url = new URL(`../../../${rel}`, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${rel}: HTTP ${res.status}`);
  return res.json();
};

const NO_DATA_ERROR = 'no decode data for this game build yet';

export const profileFileFor = (rawSha256: string): string => `builds/${rawSha256.slice(0, 16)}.json`;

// One cached fetch+validate per (fetch function, build): the display-label
// match (ingest/onboarding) and the actual extraction load share it, so the
// decode data is never fetched twice. Failures are not cached.
const PROFILE_CACHE = new WeakMap<FetchJson, Map<string, Promise<WorldProfile>>>();

function fetchProfile(get: FetchJson, rawSha256: string): Promise<WorldProfile> {
  let perGet = PROFILE_CACHE.get(get);
  if (!perGet) { perGet = new Map(); PROFILE_CACHE.set(get, perGet); }
  let pending = perGet.get(rawSha256);
  if (!pending) {
    pending = get(profileFileFor(rawSha256)).then((doc) => validateWorldProfile(doc, rawSha256));
    pending.catch(() => perGet!.delete(rawSha256));
    perGet.set(rawSha256, pending);
  }
  return pending;
}

// Cheap match for display plumbing (the ingest's default version label,
// onboarding's build check): hash the decompressed ab0 and fetch its decode
// data by convention. entry.label carries the build's human-readable label
// when it has one. Never throws: any failure (offline, unknown build, a host
// that rewrites missing files to HTML) comes back as { entry: null, error }
// so callers can degrade gracefully. The fetched data is cached, so a
// following loadWorldProfile costs nothing extra.
export async function matchWorldProfileEntry(
  ab0: Uint8Array,
  opts: { fetchJson?: FetchJson } = {},
): Promise<{ entry: WorldProfileIndexEntry | null; rawSha256: string; error?: string }> {
  return matchWorldProfileEntryByHash(await sha256Hex(ab0), opts);
}

// Same match when only the decompressed-ab0 hash is at hand (a stored version
// record re-checking for decode data that shipped after it was extracted).
export async function matchWorldProfileEntryByHash(
  rawSha256: string,
  { fetchJson }: { fetchJson?: FetchJson } = {},
): Promise<{ entry: WorldProfileIndexEntry | null; rawSha256: string; error?: string }> {
  const get = fetchJson || defaultFetchJson;
  try {
    const profile = await fetchProfile(get, rawSha256);
    const entry: WorldProfileIndexEntry = {
      file: profileFileFor(rawSha256),
      bundle0_raw_sha256: rawSha256,
    };
    if (profile.label) entry.label = profile.label;
    return { entry, rawSha256 };
  } catch {
    return { entry: null, rawSha256, error: NO_DATA_ERROR };
  }
}

// ab0: decompressed assetBundle0 bytes. fetchJson can be injected (node tests,
// worker contexts with different base URLs); the default resolves against
// this module so it works from both the window and the extraction worker.
export async function loadWorldProfile(
  ab0: Uint8Array,
  { fetchJson }: { fetchJson?: FetchJson } = {},
): Promise<{ profile: WorldProfile | null; rawSha256: string; error?: string }> {
  const get = fetchJson || defaultFetchJson;
  const rawSha256 = await sha256Hex(ab0);
  try {
    return { profile: await fetchProfile(get, rawSha256), rawSha256 };
  } catch {
    return { profile: null, rawSha256, error: NO_DATA_ERROR };
  }
}
