// Version diff engine (design §5). Pure functions over version records +
// index arrays, no DOM. Two tiers:
//
//   Tier 0, bundle diff: nine sha256 comparisons. Instant "which bundles
//            changed"; drives the bundle strip before any per-asset work.
//   Tier 1, per-asset diff keyed on the content hash `h`, O(n), using
//            COUNT-maps (content-duplicate multiplicity handled): an asset
//            that moves index but keeps its hash is UNCHANGED (sub-flagged
//            `moved`): never a false add/remove on reorder.
//
// "Changed" is heuristic pairing of added × removed on a stable non-content
// key, emitted with a confidence label; unpaired items honestly stay
// added/removed. Strings carry a synthetic h = sha256/16(text), so they diff
// by text like everything else.

import type { VersionRecord, BundleInfo } from './storage.js';
import type { IndexEntry } from './store.js';

// ---------------------------------------------------------------- tier 0

export interface BundleDiffRow {
  n: number;
  state: 'same' | 'changed' | 'onlyA' | 'onlyB' | 'absent';
  a: BundleInfo | null;
  b: BundleInfo | null;
}

// -> [{n, state:'same'|'changed'|'onlyA'|'onlyB'|'absent', a?, b?}]
export function diffBundles(recA: VersionRecord | null | undefined, recB: VersionRecord | null | undefined): BundleDiffRow[] {
  const out: BundleDiffRow[] = [];
  for (let n = 0; n <= 8; n++) {
    const a = recA?.bundles?.[n] || null;
    const b = recB?.bundles?.[n] || null;
    let state: BundleDiffRow['state'] = 'absent';
    if (a && b) state = a.sha256 === b.sha256 ? 'same' : 'changed';
    else if (a) state = 'onlyA';
    else if (b) state = 'onlyB';
    out.push({ n, state, a, b });
  }
  return out;
}

// ---------------------------------------------------------------- tier 1

export interface ChangedPair { base: IndexEntry; active: IndexEntry; key: string; confidence: string }

export interface IndexDiff {
  added: IndexEntry[];
  removed: IndexEntry[];
  moved: { a: IndexEntry; b: IndexEntry }[];
  unchanged: number;
  changed: ChangedPair[];
}

function countMap(idx: IndexEntry[]): Map<string, { count: number; entries: IndexEntry[] }> {
  const m = new Map<string, { count: number; entries: IndexEntry[] }>();   // h -> {count, entries:[...]}
  for (const e of idx) {
    if (!e?.h) continue;
    if (!m.has(e.h)) m.set(e.h, { count: 0, entries: [] });
    const v = m.get(e.h)!;
    v.count++;
    v.entries.push(e);
  }
  return m;
}

// per-category stable non-content pairing keys (design §5: weak signatures.
// Pair only when the key is UNIQUE on both sides, otherwise stay honest
// add/remove)
const PAIR_KEYS: Record<string, { key: (e: any) => string; confidence: string }> = {
  meshes: { key: (e) => `v${e.v}t${e.t}s${e.sk ? e.skel : '-'}`, confidence: 'medium' },
  images: { key: (e) => `${e.cat}:${e.n}:${e.entries?.[0] ? `${e.entries[0].w}x${e.entries[0].h}${e.entries[0].fmt}` : ''}`, confidence: 'low' },
  anims: { key: (e) => `sk${e.skel}d${e.dur}`, confidence: 'medium' },
  rigs: { key: (e) => `b${e.bones}`, confidence: 'low' },
  audio: { key: (e) => `${e.codec}:${e.n}:${e.ch}`, confidence: 'medium' },
  // rooms: the derived name is the strongest stable key (hash-keyed overrides
  // survive renumbering); unnamed rooms fall back to their footprint shape
  world: {
    key: (e) => (e.name ? `n:${e.name}` : `s:${(e.size || []).join('x')}m${(e.map_size || []).join('x')}l${e.layers ?? ''}`),
    confidence: 'medium',
  },
};

// idxA = base version's category index, idxB = active. Entries need `h`.
// -> { added:[eB], removed:[eA], moved:[{a,b}], unchanged, changed:[{base,active,key,confidence}] }
export function diffIndexes(idxA: IndexEntry[] | null | undefined, idxB: IndexEntry[] | null | undefined, cat: string): IndexDiff {
  const A = countMap(idxA || []);
  const B = countMap(idxB || []);
  const added: IndexEntry[] = [], removed: IndexEntry[] = [], moved: { a: IndexEntry; b: IndexEntry }[] = [];
  let unchanged = 0;

  for (const [h, b] of B) {
    const a = A.get(h);
    const extra = b.count - (a?.count || 0);
    for (let k = 0; k < Math.max(0, extra); k++) added.push(b.entries[b.entries.length - 1 - k]);
    if (a) {
      const common = Math.min(a.count, b.count);
      unchanged += common;
      // moved: same content, different ordinal (first instances compared)
      if (a.entries[0].i !== b.entries[0].i) moved.push({ a: a.entries[0], b: b.entries[0] });
    }
  }
  for (const [h, a] of A) {
    const b = B.get(h);
    const extra = a.count - (b?.count || 0);
    for (let k = 0; k < Math.max(0, extra); k++) removed.push(a.entries[a.entries.length - 1 - k]);
  }

  // heuristic changed-pairing over the add/remove sets
  const changed: ChangedPair[] = [];
  const pk = PAIR_KEYS[cat];
  if (pk && added.length && removed.length) {
    const byKeyAdded = new Map<string, IndexEntry | null>(), byKeyRemoved = new Map<string, IndexEntry | null>();
    const tally = (map: Map<string, IndexEntry | null>, e: IndexEntry) => {
      const k = pk.key(e);
      map.set(k, map.has(k) ? null : e);   // null marks non-unique
    };
    for (const e of added) tally(byKeyAdded, e);
    for (const e of removed) tally(byKeyRemoved, e);
    for (const [k, b] of byKeyAdded) {
      const a = byKeyRemoved.get(k);
      if (a && b) changed.push({ base: a, active: b, key: k, confidence: pk.confidence });
    }
  }
  const pairedA = new Set(changed.map((c) => c.base));
  const pairedB = new Set(changed.map((c) => c.active));
  return {
    added: added.filter((e) => !pairedB.has(e)),
    removed: removed.filter((e) => !pairedA.has(e)),
    moved, unchanged, changed,
  };
}

// full cross-category diff of two versions given an index loader
//   loadIndex(versionId, cat) -> entries[] | null
// Skips categories either side lacks. -> { cats: {cat: diff}, skipped: [{cat, reason}] }
export async function diffVersions(
  recA: VersionRecord, recB: VersionRecord,
  loadIndex: (versionId: string, cat: string) => Promise<IndexEntry[] | null | undefined>,
): Promise<{ cats: Record<string, IndexDiff>; skipped: { cat: string; reason: string }[] }> {
  const cats: Record<string, IndexDiff> = {};
  const skipped: { cat: string; reason: string }[] = [];
  for (const cat of ['meshes', 'images', 'audio', 'anims', 'rigs', 'strings', 'world']) {
    const [ia, ib] = await Promise.all([loadIndex(recA.versionId, cat), loadIndex(recB.versionId, cat)]);
    if (!ia || !ib) {
      skipped.push({ cat, reason: !ia && !ib ? 'not extracted in either version' : `not extracted in ${!ia ? 'the base' : 'the active'} version` });
      continue;
    }
    cats[cat] = diffIndexes(ia, ib, cat);
  }
  return { cats, skipped };
}

// -------------------------------------------------------------- room detail

// Which per-room count keys are meaningful "what changed" facts. The rest of
// `counts` is anchor-audit accounting, and link/collision counts are
// build-decoding provenance (see roomContentSignature): none of it is room
// content.
const ROOM_COUNT_LABELS: Record<string, string> = {
  occurrences: 'placements',
  spawns: 'NPC spawns',
  spawn_parts: 'spawn parts',
};

export interface RoomPairDiff {
  fields: { label: string; before: any; after: any }[];
  meshes: { added: IndexEntry[]; removed: IndexEntry[] };
  textures: { added: IndexEntry[]; removed: IndexEntry[] };
}

// What changed inside one paired room: pure index-level computation over the
// two versions' room entries plus their mesh/image indexes (no shard loads).
// meshesA/B + imagesA/B are the per-version category index arrays; mesh and
// texture deltas are CONTENT-hash set differences, so a renumbered-but-
// identical asset never shows up as a change.
export function diffRoomPair(base: any, active: any, { meshesA, meshesB, imagesA, imagesB }: {
  meshesA: IndexEntry[] | null | undefined; meshesB: IndexEntry[] | null | undefined;
  imagesA: IndexEntry[] | null | undefined; imagesB: IndexEntry[] | null | undefined;
}): RoomPairDiff {
  const fields: { label: string; before: any; after: any }[] = [];
  const field = (label: string, a: any, b: any) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) fields.push({ label, before: a, after: b });
  };
  field('name', base.name ?? null, active.name ?? null);
  field('size', base.size || null, active.size || null);
  field('map size', base.map_size || null, active.map_size || null);
  field('layers', base.layers ?? null, active.layers ?? null);
  field('z levels', base.z_levels || null, active.z_levels || null);
  for (const [key, label] of Object.entries(ROOM_COUNT_LABELS)) {
    field(label, base.counts?.[key] ?? 0, active.counts?.[key] ?? 0);
  }

  // ordinal -> entry maps per side; set-diff by content hash
  const setDiff = (ordinalsA: number[] | null | undefined, ordinalsB: number[] | null | undefined,
    idxA: IndexEntry[] | null | undefined, idxB: IndexEntry[] | null | undefined) => {
    const byI = (idx: IndexEntry[] | null | undefined) => new Map((idx || []).map((e) => [e.i, e]));
    const aByI = byI(idxA);
    const bByI = byI(idxB);
    const aByH = new Map<string, IndexEntry>();
    for (const i of ordinalsA || []) {
      const e = aByI.get(i);
      if (e?.h) aByH.set(e.h, e);
    }
    const added: IndexEntry[] = [];
    const bH = new Set<string>();
    for (const i of ordinalsB || []) {
      const e = bByI.get(i);
      if (!e?.h) continue;
      bH.add(e.h);
      if (!aByH.has(e.h)) added.push(e);
    }
    const removed = [...aByH.values()].filter((e) => !bH.has(e.h!));
    return { added, removed };
  };
  return {
    fields,
    meshes: setDiff(base.meshes, active.meshes, meshesA, meshesB),
    textures: setDiff(base.textures, active.textures, imagesA, imagesB),
  };
}
