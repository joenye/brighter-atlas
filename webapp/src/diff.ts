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
import { modelDiffSignature } from './model-signature.js';

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
  /** Of `unchanged`: images whose bytes changed but not their picture (sameImages); rooms and models that
   *  differ only by such images (DiffContext). */
  reencoded?: number;
  /** images: each re-encoded picture's hash (either side) -> its cluster's (the same picture). */
  aliases?: Map<string, string>;
}

/** What a room or model diff needs to see past re-encoded pictures: the image diff's aliases and both sides'
 *  mesh and image indexes (rooms list their assets by ordinal). */
export interface DiffContext {
  aliases: Map<string, string>;
  meshesA?: IndexEntry[] | null; meshesB?: IndexEntry[] | null;
  imagesA?: IndexEntry[] | null; imagesB?: IndexEntry[] | null;
}

// Images the game re-encoded without changing them: an added and a removed
// image with the same category and sizes whose pixel fingerprints (`px`, 8x8
// RGB averages of the albedo plane's smallest level, extract/jobs.ts) differ
// by at most PX_MEAN on average and PX_MAX anywhere, closest pairs first,
// each image in one pair at most. -> [added, removed] pairs.
const PX_MEAN = 3, PX_MAX = 24;
function sameImages(added: IndexEntry[], removed: IndexEntry[], all: { a: IndexEntry[]; b: IndexEntry[] }):
  { pairs: [IndexEntry, IndexEntry][]; clusters: Map<string, string> } {
  // (the picture's own shape: its category and first level; a container that gained or lost a plane, a
  // material given a lighting map, still holds the same picture)
  const shape = (e: IndexEntry) => `${e.cat}:${e.entries?.[0] ? `${e.entries[0].w}x${e.entries[0].h}${e.entries[0].fmt}` : ''}`;
  const bytes = (px: string) => Uint8Array.from(atob(px), (c) => c.charCodeAt(0));
  const mean = (b: Uint8Array) => { let t = 0; for (const v of b) t += v; return t / b.length; };
  type Print = { e: IndexEntry; b: Uint8Array; m: number };
  const prints = (list: IndexEntry[]) => {
    const groups = new Map<string, Print[]>();
    for (const e of list) {
      if (typeof e?.px !== 'string' || !e.h) continue;
      const b = bytes(e.px);
      const k = shape(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push({ e, b, m: mean(b) });
    }
    return groups;
  };
  // every pair of an image of `from` and one of `to` within the bounds
  const near = (from: IndexEntry[], to: Map<string, Print[]>) => {
    const out: { x: IndexEntry; y: IndexEntry; d: number }[] = [];
    for (const e of from) {
      if (typeof e?.px !== 'string' || !e.h) continue;
      const b = bytes(e.px), m = mean(b);
      for (const c of to.get(shape(e)) ?? []) {
        // the means differ by no more than the mean difference: a cheap first gate
        if (Math.abs(c.m - m) > PX_MEAN || c.b.length !== b.length) continue;
        let sum = 0, max = 0;
        for (let k = 0; k < b.length && max <= PX_MAX; k++) {
          const d = Math.abs(b[k] - c.b[k]);
          sum += d; if (d > max) max = d;
        }
        if (max <= PX_MAX && sum / b.length <= PX_MEAN) out.push({ x: e, y: c.e, d: sum / b.length });
      }
    }
    return out;
  };
  // added images against every earlier image, removed ones against every newer image
  const toA = near(added, prints(all.a)), toB = near(removed, prints(all.b));
  // the pairs: an added and a removed image, closest pairs first (first come would hand a picture to a
  // similar one, a stone variant, that came first), each image in one pair at most
  const gone = new Set(removed);
  const candidates = toA.filter((c) => gone.has(c.y)).sort((x, y) => x.d - y.d);
  const pairs: [IndexEntry, IndexEntry][] = [];
  const taken = new Set<IndexEntry>();
  for (const { x, y } of candidates) {
    if (taken.has(x) || taken.has(y)) continue;
    taken.add(x); taken.add(y);
    pairs.push([x, y]);
  }
  // the same picture, for rooms and models: images joined by any pair within the bounds are one cluster
  // (near-identical variants of a material re-encode into one another's neighbourhood, and a picture can
  // stay unchanged in one place while a re-encoded copy replaces it in another, so one-to-one pairs alone
  // would read a room keeping its picture as a change)
  const parent = new Map<string, string>();
  const root = (h: string): string => {
    let r = h;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(h, r);
    return r;
  };
  for (const { x, y } of [...toA, ...toB]) {
    const p = root(x.h!), q = root(y.h!);
    if (p !== q) parent.set(p < q ? q : p, p < q ? p : q);
  }
  const clusters = new Map<string, string>();
  for (const h of parent.keys()) clusters.set(h, root(h));
  return { pairs, clusters };
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
  // system models: the recovered game name is the strongest stable key, the same
  // choice rooms make above. Auto-generated "Recovered model <slot>" names embed
  // a registry slot that a game update renumbers, so those fall back to rig
  // identity plus part count. The part count is deliberately absent from the
  // NAMED key: gaining or losing a part is exactly the change we want paired and
  // reported as "changed", not split into a removal plus an add.
  models: {
    key: (e) => (e.name && !/^Recovered model /.test(e.name)
      ? `n:${e.name}|r:${e.rig || ''}`
      : `s:${e.skel || ''}|r:${e.rig || ''}|p:${(e.parts || []).length}`),
    confidence: 'medium',
  },
};

// idxA = base version's category index, idxB = active. Entries need `h`.
// -> { added:[eB], removed:[eA], moved:[{a,b}], unchanged, changed:[{base,active,key,confidence}] }
export function diffIndexes(idxA: IndexEntry[] | null | undefined, idxB: IndexEntry[] | null | undefined, cat: string,
  ctx?: DiffContext | null): IndexDiff {
  const A = countMap(idxA || []);
  const B = countMap(idxB || []);
  let added: IndexEntry[] = [], removed: IndexEntry[] = [];
  const moved: { a: IndexEntry; b: IndexEntry }[] = [];
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

  // images the game re-encoded: the same picture, unchanged; models whose only difference is such pictures too
  let reencoded = 0;
  let aliases: Map<string, string> | undefined;
  const drop = (pairs: [IndexEntry, IndexEntry][]) => {
    if (!pairs.length) return;
    const a = new Set(pairs.map((p) => p[0])), r = new Set(pairs.map((p) => p[1]));
    added = added.filter((e) => !a.has(e));
    removed = removed.filter((e) => !r.has(e));
    reencoded += pairs.length;
    unchanged += pairs.length;
  };
  // (the same picture in a container whose planes changed: one image changed, not one removed and one added)
  const repacked: ChangedPair[] = [];
  if (cat === 'images' && added.length && removed.length) {
    const { pairs, clusters } = sameImages(added, removed, { a: (idxA || []).filter(Boolean), b: (idxB || []).filter(Boolean) });
    if (clusters.size) aliases = clusters;
    const planes = (e: IndexEntry) => (e.entries || []).map((x: any) => `${x.w}x${x.h}${x.fmt}`).join(',');
    const same = pairs.filter(([b, a]) => planes(b) === planes(a));
    const other = pairs.filter(([b, a]) => planes(b) !== planes(a));
    drop(same);
    if (other.length) {
      const b = new Set(other.map((p) => p[0])), a = new Set(other.map((p) => p[1]));
      added = added.filter((e) => !b.has(e));
      removed = removed.filter((e) => !a.has(e));
      for (const [active, base] of other) repacked.push({ base, active, key: 'same picture, planes changed', confidence: 'high' });
    }
  }
  if (cat === 'models' && ctx?.aliases.size && added.length && removed.length) {
    const bySignature = new Map<string, IndexEntry[]>();
    for (const e of removed) {
      const k = modelDiffSignature(e as any, ctx.aliases);
      if (k !== null) (bySignature.get(k) ?? bySignature.set(k, []).get(k)!).push(e);
    }
    const pairs: [IndexEntry, IndexEntry][] = [];
    for (const e of added) {
      const k = modelDiffSignature(e as any, ctx.aliases);
      const match = k === null ? undefined : bySignature.get(k)?.pop();
      if (match) pairs.push([e, match]);
    }
    drop(pairs);
  }

  // heuristic changed-pairing over the add/remove sets
  const changed: ChangedPair[] = [...repacked];
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
  // a room paired by name whose fields, meshes and pictures (re-encoded ones read as they were) all agree
  let kept = changed;
  if (cat === 'world' && ctx?.aliases.size) {
    kept = changed.filter((c) => {
      const d = diffRoomPair(c.base, c.active, { meshesA: ctx.meshesA, meshesB: ctx.meshesB,
        imagesA: ctx.imagesA, imagesB: ctx.imagesB, aliases: ctx.aliases });
      return d.fields.length || d.meshes.added.length || d.meshes.removed.length
        || d.textures.added.length || d.textures.removed.length;
    });
    reencoded += changed.length - kept.length;
    unchanged += changed.length - kept.length;
  }
  return {
    added: added.filter((e) => !pairedB.has(e)),
    removed: removed.filter((e) => !pairedA.has(e)),
    moved, unchanged, changed: kept,
    ...(reencoded ? { reencoded } : {}),
    ...(aliases ? { aliases } : {}),
  };
}

/** The context a room or model comparison needs (DiffContext), from both versions' mesh and image indexes:
 *  null when no picture was re-encoded between them. */
export function reencodeContext(meshesA: IndexEntry[] | null | undefined, meshesB: IndexEntry[] | null | undefined,
  imagesA: IndexEntry[] | null | undefined, imagesB: IndexEntry[] | null | undefined): DiffContext | null {
  if (!imagesA?.length || !imagesB?.length) return null;
  const aliases = diffIndexes(imagesA, imagesB, 'images').aliases;
  return aliases?.size ? { aliases, meshesA, meshesB, imagesA, imagesB } : null;
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
  const loaded: Record<string, [IndexEntry[], IndexEntry[]]> = {};
  // 'models' covers the SYSTEM catalog only. User models are not per-version
  // (see systemModelDiffHash), so the loader returns them to nobody and the
  // category skips honestly on a version extracted without one.
  for (const cat of ['meshes', 'images', 'audio', 'anims', 'rigs', 'strings', 'world', 'models']) {
    const [ia, ib] = await Promise.all([loadIndex(recA.versionId, cat), loadIndex(recB.versionId, cat)]);
    if (!ia || !ib) {
      skipped.push({ cat, reason: !ia && !ib ? 'not extracted in either version' : `not extracted in ${!ia ? 'the base' : 'the active'} version` });
      continue;
    }
    // (images come before rooms and models: their re-encoded pictures are what those two must see past)
    const ctx: DiffContext | null = cats.images?.aliases?.size ? {
      aliases: cats.images.aliases,
      meshesA: loaded.meshes?.[0], meshesB: loaded.meshes?.[1], imagesA: loaded.images?.[0], imagesB: loaded.images?.[1],
    } : null;
    loaded[cat] = [ia, ib];
    cats[cat] = diffIndexes(ia, ib, cat, ctx);
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
export function diffRoomPair(base: any, active: any, { meshesA, meshesB, imagesA, imagesB, aliases }: {
  meshesA: IndexEntry[] | null | undefined; meshesB: IndexEntry[] | null | undefined;
  imagesA: IndexEntry[] | null | undefined; imagesB: IndexEntry[] | null | undefined;
  /** a re-encoded picture's hash, either side -> its cluster's (IndexDiff.aliases) */
  aliases?: Map<string, string> | null;
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
    idxA: IndexEntry[] | null | undefined, idxB: IndexEntry[] | null | undefined, alias?: Map<string, string> | null) => {
    const as = (h: string) => alias?.get(h) ?? h;
    const byI = (idx: IndexEntry[] | null | undefined) => new Map((idx || []).map((e) => [e.i, e]));
    const aByI = byI(idxA);
    const bByI = byI(idxB);
    const aByH = new Map<string, IndexEntry>();
    for (const i of ordinalsA || []) {
      const e = aByI.get(i);
      if (e?.h) aByH.set(as(e.h), e);
    }
    const added: IndexEntry[] = [];
    const bH = new Set<string>();
    for (const i of ordinalsB || []) {
      const e = bByI.get(i);
      if (!e?.h) continue;
      bH.add(as(e.h));
      if (!aByH.has(as(e.h))) added.push(e);
    }
    const removed = [...aByH.values()].filter((e) => !bH.has(as(e.h!)));
    return { added, removed };
  };
  return {
    fields,
    meshes: setDiff(base.meshes, active.meshes, meshesA, meshesB),
    textures: setDiff(base.textures, active.textures, imagesA, imagesB, aliases),
  };
}
