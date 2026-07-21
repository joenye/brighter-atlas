// World extraction orchestrator — turns the user's bundles into the stored
// world package: match the per-build decode data against ab0, replay the
// registry + value pool, parse every ab2 room, stitch the door graph into
// world placement, build per-room shards + the world index, classify every
// referenced ab3 texture (the 'worldtex' job), and recover the portable
// system catalog through the existing attachPortableSystemCatalog seam.
//
// profile/replay/value-pool are stable and imported statically; the later
// stages (room/stitch/graph/spawns/shards/models/catalog) land separately and
// are imported dynamically so a missing or drifted module fails with a clear
// per-stage error instead of sinking the whole extraction path at load time.
// This module itself is only ever dynamically imported (ingest.js), so nothing
// here loads unless the user actually selected the World category.

import { loadWorldProfile, type FetchJson } from './profile.js';
import { fillRoomNames } from './room-graph.js';
import { replayGraph } from './replay.js';
import { decodePool } from './value-pool.js';
import { decodeObject, makeSlabReader } from '../bundles.js';
import { hashObject } from '../hash.js';

const UTF8_ENCODER = new TextEncoder();
import { poolMap } from '../pool.js';
import { attachPortableSystemCatalog } from '../system-catalog.js';
import * as roomMod from './room.js';
import * as stitchMod from './stitch.js';
import * as shardsMod from './shards.js';
import * as graphMod from './graph.js';
import * as modelsMod from './models.js';
import * as catalogMod from './catalog.js';
import * as animNamesMod from './anim-names.js';
import * as meshNamesMod from './mesh-names.js';


// default JSON fetch for world data files (same contract as profile.js):
// rel is site-root-relative — 'builds/…' for the per-build decode data on the
// site origin, 'defaults/…' for files shipped with the app.
const defaultFetchJson: FetchJson = async (rel) => {
  const url = new URL(`../../../${rel}`, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${rel}: HTTP ${res.status}`);
  return res.json();
};

export interface ExtractWorldOptions {
  ab0: Uint8Array;
  dt: any;
  files: Record<string, Blob>;
  frames: Record<string, { entries: any[] }>;
  shas: Record<string, string>;
  versionId: string;
  indexes: { meshes?: any[]; images?: any[]; rigs?: any[] };
  /** decoded ab2 objects handed over by the ingest's bbox pass (meshes+world)
   *  so ab2 is only decompressed once; entries are released as consumed */
  ab2Objects?: (Uint8Array | null)[] | null;
  sink: {
    derivedPut: (versionId: string, key: string, value: any) => Promise<any>;
    derivedPutMany?: (versionId: string, entries: [string, any][]) => Promise<any>;
  };
  onProgress?: (p: { stage: string; step: string; done: number; total: number }) => void;
  signal?: AbortSignal;
  fetchJson?: FetchJson;
}

// ab0: decompressed assetBundle0 bytes; dt: parseDatatable(ab0) result;
// files/frames/shas: the ingest's bundle Blobs, frame tables and whole-file
// sha256s (needs 0, 2, 3, 5, 6); indexes: meshes/images/skeletons index arrays
// (already extracted or loaded from the sink); sink.derivedPut streams the
// per-room shards; fetchJson overrides the shipped-defaults fetch (node tests).
// -> { attachedSystem, roomsCount, worldIndex }. The caller persists
// worldIndex ('world:index') and attachedSystem (system:models/bindings).
export async function extractWorld({
  ab0, dt, files, frames, shas, versionId, indexes, ab2Objects,
  sink, onProgress = () => {}, signal, fetchJson,
}: ExtractWorldOptions): Promise<{ attachedSystem: any; roomsCount: number; worldIndex: any }> {
  const bail = () => { if (signal?.aborted) throw new Error('cancelled'); };
  const step = (s: string, done: number, total: number) => onProgress({ stage: 'world', step: s, done, total });

  // ---- (a) decode profile: no match -> World is unavailable for this build --
  step('profile', 0, 1);
  const { profile, error } = await loadWorldProfile(ab0, { fetchJson });
  if (!profile) throw new Error(error || 'no world decode profile for this game build yet');
  step('profile', 1, 1);
  bail();

  // ---- (b) registry replay (constructor + fill streams) --------------------
  const { rows } = replayGraph(ab0, profile, {
    onProgress: (done, total) => { bail(); step('replay', done, total); },
  });
  bail();

  // ---- (e) worldtex: render metadata for every referenced ab3 container -----
  // Referenced = every ab3 container a registry row points at (tag-0x47
  // edges), the superset of what materials and spawn parts can use. texIds
  // derive from the replay rows ONLY, so the pooled pass is kicked off HERE —
  // immediately after replay — and works the other cores while this thread
  // decodes the value pool and parses rooms. Its results are awaited below,
  // before the shard context first consumes texMeta, so a texture-stage
  // failure still fails before the shard loop (progress bars interleave).
  const referenced = new Set<any>();
  for (const row of rows) {
    for (const e of row.g) if (e[2] === 0x47) referenced.add(e[3]);
  }
  const texMeta = new Map<any, any>();   // ab3 id -> worldtex record (texMeta + routing)
  const texIds: number[] = [];
  for (const id of [...referenced].sort((a, b) => a - b)) {
    if (Number.isInteger(id) && frames[3].entries[id]) texIds.push(id);
    else texMeta.set(id, { kind: 'other' });   // out-of-range edge value
  }
  // Cache pre-warm: the job has the decoded pixels in hand, so it also
  // PNG-encodes the albedo/normal/parameter planes and cache.put()s them under
  // the exact sw.js URLs (see warmWorldTexturePngs in ../jobs.js). Encoding +
  // putting INSIDE the pooled job was measured faster than transferring the
  // PNGs back here: the deflate work fans out across the pool workers, the
  // bytes never cross a thread boundary (no structured clone / transfer, no
  // 100s-of-MB 'done' message), and the Cache API is directly writable from
  // workers. Gated on the Cache API existing (node tests have none) and every
  // failure inside the warm path degrades silently.
  const warmPngBase = typeof caches !== 'undefined'
    ? new URL(`../../../cs/${versionId}/images/`, import.meta.url).href
    : null;
  let texPromise: Promise<any[]> | null = null;
  if (texIds.length) {
    texPromise = poolMap({
      file: files[3],
      n: 3,
      kind: 'worldtex',
      entries: texIds.map((id) => frames[3].entries[id]),
      extraFor: warmPngBase ? (k: number) => ({ warmPngBase, ord: texIds[k] }) : undefined,
      signal,
      onProgress: (done: number, total: number) => step('textures', done, total),
    });
    texPromise.catch(() => {});   // surfaced at the await below — never unhandled
  }

  // ---- (c) interned value pool ---------------------------------------------
  step('pool', 0, 1);
  const pool = decodePool(ab0, profile);
  step('pool', 1, 1);
  bail();

  // ---- (d) ab2 rooms + door-graph world placement ---------------------------
  roomMod.configureFields(profile);

  const entries2 = frames[2].entries;
  const read2 = makeSlabReader(files[2]);
  // meshes+world ingests hand over the bbox pass's decoded ab2 objects, so
  // ab2 is only decompressed once; the bytes are identical (zstd is
  // deterministic) and the loop below still visits ascending ab2 idx.
  const sharedAb2 = ab2Objects && ab2Objects.length === entries2.length ? ab2Objects : null;
  // ascending ab2 idx — stitch ordering contract
  const rooms: {
    idx: number; exits: any[]; name: string | null;
    w: number | null; h: number | null; gridW: number; gridH: number;
  }[] = [];
  const layersById = new Map<number, any>();     // ab2 idx -> roomLayers() result (decodable rooms)
  const contentHashes = new Map<number, string>(); // ab2 idx -> sha256/16 of decoded bytes
  step('rooms', 0, entries2.length);
  for (let i = 0; i < entries2.length; i++) {
    bail();
    let dec = sharedAb2 ? sharedAb2[i] : null;
    if (dec) sharedAb2![i] = null;   // release as consumed
    else dec = decodeObject(2, await read2(entries2[i]));
    let parsed = null;
    try { parsed = roomMod.parse(dec); } catch { /* not a counted-container object */ }
    const minimap = parsed ? roomMod.minimapRecord(parsed.top, parsed.table) : null;
    if (minimap) {
      contentHashes.set(i, await hashObject(dec));
      const layers = roomMod.roomLayers(parsed!, i);
      if (layers) layersById.set(i, layers);
      const [x0, y0, x1, y1] = minimap.innerRect;
      rooms.push({
        idx: i,
        exits: roomMod.roomExits(parsed!),
        name: null,                        // filled below
        w: layers?.w ?? null,
        h: layers?.h ?? null,
        gridW: x1 - x0,
        gridH: y1 - y0,
      });
    }
    if (i % 10 === 0 || i === entries2.length - 1) step('rooms', i + 1, entries2.length);
  }
  if (!layersById.size) throw new Error('no rooms found in assetBundle2 — mixed game versions?');

  // room names straight from ab0, then the shipped content-hash overrides
  // for the name-hash-gated rooms (a missing file just means no overrides).
  const names = roomMod.deriveRoomNames(ab0, dt.charset, rooms.map((r) => r.idx));
  try {
    // Ships with the app at defaults/room_name_overrides.json.
    const doc = await (fetchJson || defaultFetchJson)('defaults/room_name_overrides.json');
    if (doc?.overrides) roomMod.applyRoomNameOverrides(names, doc.overrides, contentHashes);
  } catch { /* no shipped overrides — derived names only */ }
  for (const r of rooms) r.name = names.get(r.idx) ?? null;

  // World placement runs AFTER the shard loop: the jigsaw connector meshes
  // that calibrate room joins (stitch.js CONNECTOR_MESH_HASHES) are only
  // known once shard placements exist.
  bail();

  // ---- (e, results) worldtex verdicts, started right after replay above.
  // Awaited here because per-placement flags (alpha, authored-empty,
  // unrenderable) come from these verdicts — the shard context below is the
  // first consumer, and a texture-stage failure must throw before shards.
  if (texPromise) {
    const results = await texPromise;
    for (let k = 0; k < results.length; k++) {
      const { i, err, ...meta } = results[k] || {};
      // a decode failure is an honest 'other'
      texMeta.set(texIds[k], err ? { kind: 'other', error: err } : {
        spreadMax: null, paramMin: null, paramMax: null, ...meta,
      });
    }
  }
  bail();

  // ---- shared pure derivations, computed ONCE and threaded through ----------
  // traceAssetMaps (a full registry-row scan), materialMap (a leaves() walk
  // over every pool index), the enemy-definition scan and the PoolStrings /
  // pool-ref caches are all pure, never-mutated functions of (rows, pool,
  // charset). The shard context, the model catalog and the name-recovery
  // passes each used to re-derive their own copies; passing these exact
  // instances to every consumer changes no byte of output (identical inputs
  // produce identical maps in identical insertion order).
  const assetMaps = modelsMod.traceAssetMaps(rows);
  const materialAssets = modelsMod.materialMap(
    pool.values, new modelsMod.Resolver(pool.values, assetMaps.meshSlots), assetMaps.textureSlots,
  );
  const poolStrings = new modelsMod.PoolStrings(pool.values, dt.charset);
  const poolRegistryRefs = modelsMod.makePoolRegistryRefs(pool.values);
  const enemyDefs = modelsMod.scanEnemyDefinitions(rows, pool.values, dt.charset, {
    strings: poolStrings, poolRegistryRefs,
  });
  bail();

  // ---- (f) shard context -> per-room shards + world index -------------------
  const { createShardContext, buildRoomShard, buildWorldIndex, roomContentSignature } = shardsMod;
  // ordinal -> content hash, for the per-room diff identity (design §5)
  const meshHashByOrdinal = new Map((indexes?.meshes || []).map((e: any) => [e.i, e.h]));
  const imageHashByOrdinal = new Map((indexes?.images || []).map((e: any) => [e.i, e.h]));
  // Spawn grounding samples ab5 top faces synchronously: hold the raw meshes
  // bundle in memory for the duration of this stage (decode stays per-object).
  const ab5 = new Uint8Array(await files[5].arrayBuffer());
  const loadMeshBytes = (meshId: number) => {
    const e = frames[5].entries[meshId];
    if (!e) throw new Error(`mesh ${meshId} is outside assetBundle5`);
    return decodeObject(5, ab5.subarray(e.offset, e.offset + e.length));
  };
  const ctx = createShardContext({
    rows,
    pool: pool.values,
    meshDir: dt.meshDir,
    texMeta,
    rooms: layersById,
    names,
    loadMeshBytes,
    profile,
    charset: dt.charset,   // enables roaming-enemy roster spawns
    assetMaps,             // shared pure derivations (computed once above)
    materialAssets,
    enemyDefs,
  });
  // Jigsaw connector meshes, resolved to this build's ab5 ordinals by content
  // hash. Missing pieces (no meshes index, or a stale-cached stitch.js from a
  // mid-session update) degrade to the plain door-tile stitch — the connector
  // calibration is an enhancement and must never fail the extraction.
  const pcOccurrence = shardsMod.PLACEMENT_COLUMNS.indexOf('occurrence');
  const pcMesh = shardsMod.PLACEMENT_COLUMNS.indexOf('mesh');
  const ocX = shardsMod.OCCURRENCE_COLUMNS.indexOf('x');
  const ocY = shardsMod.OCCURRENCE_COLUMNS.indexOf('y');
  const maleMeshes = new Set<any>();
  const femaleMeshes = new Set<any>();
  const connectorHashes = stitchMod.CONNECTOR_MESH_HASHES;
  if (connectorHashes?.male && connectorHashes?.female) {
    for (const [ordinal, hash] of meshHashByOrdinal) {
      if (connectorHashes.male.includes(hash)) maleMeshes.add(ordinal);
      else if (connectorHashes.female.includes(hash)) femaleMeshes.add(ordinal);
    }
  }
  const connectorTiles = new Map<number, { m: number[][]; f: number[][] }>(); // room idx -> connector tiles

  // stream each shard to storage — writes batch into one transaction per ~32
  // rooms (sink.derivedPutMany when available) and the per-room content hash
  // is pipelined in a small window, so room N+1's shard is computed while
  // room N's write/hash are still in flight. shardsMeta stays pushed in exact
  // room order and every write/hash settles before shardsMeta is consumed.
  const shardsMeta: any[] = [];
  const putBatch: [string, any][] = [];
  let flushInFlight: Promise<any> | null = null;
  const putMany = async (entries: [string, any][]) => {
    if (sink.derivedPutMany) { await sink.derivedPutMany(versionId, entries); return; }
    for (const [key, value] of entries) await sink.derivedPut(versionId, key, value);
  };
  const flushShards = async () => {
    if (!putBatch.length) return;
    const batch = putBatch.splice(0);
    if (flushInFlight) await flushInFlight;   // at most one write transaction in flight
    flushInFlight = putMany(batch);
  };
  const hashPending: Promise<void>[] = [];    // bounded in-flight window (4)
  step('shards', 0, ctx.roomIds.length);
  for (const roomId of ctx.roomIds) {
    bail();
    let outcome;
    try {
      outcome = buildRoomShard(ctx, roomId);
    } catch (err) {
      throw new Error(`room ${roomId}: ${err.message}`);
    }
    const { shard, entry } = outcome;
    putBatch.push([`world:room:${roomId}`, shard]);
    if (putBatch.length >= 32) await flushShards();
    // ordinal-free room content hash: the diff identity for this room, so
    // version diffs pair rooms as unchanged/moved/changed like every other
    // asset category. The signature string is fixed here, synchronously —
    // only the digest itself is deferred, so pipelining cannot change it.
    hashPending.push(hashObject(UTF8_ENCODER.encode(roomContentSignature({
      shard,
      meshHash: meshHashByOrdinal,
      imageHash: imageHashByOrdinal,
    }))).then((h) => { entry.h = h; }));
    if (hashPending.length >= 4) await hashPending.shift();
    // connector tiles for the placement stitch below (dedup per tile)
    if (maleMeshes.size || femaleMeshes.size) {
      const male = new Set<string>();
      const female = new Set<string>();
      for (const category of ['terrain', 'models', 'components']) {
        for (const row of shard.placements[category] || []) {
          const target = maleMeshes.has(row[pcMesh]) ? male
            : femaleMeshes.has(row[pcMesh]) ? female : null;
          if (!target) continue;
          const occurrence = shard.occurrences[row[pcOccurrence]];
          target.add(`${occurrence[ocX]},${occurrence[ocY]}`);
        }
      }
      if (male.size || female.size) {
        const parse = (set: Set<string>) => [...set].map((t) => t.split(',').map(Number));
        connectorTiles.set(roomId, { m: parse(male), f: parse(female) });
      }
    }
    shardsMeta.push(entry);
    step('shards', shardsMeta.length, ctx.roomIds.length);
  }
  // drain the pipeline: every shard written and every entry.h assigned before
  // anything reads shardsMeta
  await flushShards();
  if (flushInFlight) await flushInFlight;
  while (hashPending.length) await hashPending.shift();
  const roomsCount = shardsMeta.length;
  if (!roomsCount) throw new Error('the room shard stage produced no shards');

  // Room-spawn actor table (registry slot, recovered label, exact appearance
  // meshes) for the catalog stage: it gates the scoped actor_appearance
  // record rule, the single-part card promotion, and the spawn-label naming
  // pass. The spawn graph's caches are already warm from the shard loop, so
  // this is a cheap replay.
  const spawnActorsBySlot = new Map<number, { owner_slot: number; label: string | null; meshes: number[] }>();
  for (const roomId of ctx.roomIds) {
    const roomRow = ctx.roomRows.get(roomId);
    if (!roomRow) continue;
    for (const actor of ctx.spawnGraph.roomSpawns(roomId, roomRow)) {
      if (!actor.parts.length || spawnActorsBySlot.has(actor.record)) continue;
      const meshes = new Set<number>();
      for (const part of actor.parts) meshes.add(part.mesh);
      spawnActorsBySlot.set(actor.record, {
        owner_slot: actor.record,
        label: actor.label,
        meshes: [...meshes],
      });
    }
  }

  // ---- door-graph world placement, calibrated by the jigsaw connectors ------
  step('stitch', 0, 1);
  const placement = stitchMod.stitchWorld(rooms, connectorTiles.size ? connectorTiles : null);
  step('stitch', 1, 1);
  for (const entry of shardsMeta) {
    const pos = placement.positions.get(entry.id) || null;
    entry.world = {
      x: pos ? pos[0] : null,
      y: pos ? pos[1] : null,
      plane: placement.planes.get(entry.id) ?? 0,
    };
  }
  // Cross-build name fill: still-unnamed rooms take the name of the reference
  // room (builds/rooms.json, per-build decode data on the site origin) at
  // their aligned world position. Placement only exists after the shard loop,
  // so this runs last and patches the world-index entries; a missing file
  // just means derived names only.
  try {
    const reference = await (fetchJson || defaultFetchJson)('builds/rooms.json');
    if (Array.isArray(reference?.rooms)) {
      const placed = [];
      for (const r of rooms) {
        const pos = placement.positions.get(r.idx);
        if (!pos) continue;
        placed.push({
          idx: r.idx,
          name: names.get(r.idx) ?? null,
          plane: placement.planes.get(r.idx) ?? 0,
          x: pos[0],
          y: pos[1],
          w: r.gridW,
          h: r.gridH,
        });
      }
      const filled = fillRoomNames(placed, reference).names;
      for (const entry of shardsMeta) {
        const name = filled.get(entry.id);
        if (name != null) { entry.name = name; names.set(entry.id, name); }
      }
    }
  } catch { /* no reference room list — derived names only */ }
  const worldIndex = buildWorldIndex(ctx, shardsMeta);
  // texture routing table (sw.js worldtex/ routes decode from it)
  // + paired door adjacency for the merged all-rooms view
  worldIndex.textures = Object.fromEntries([...texMeta].map(([id, meta]) => [id, meta]));
  worldIndex.links = placement.links;
  bail();

  // ---- (g) portable system catalog through the existing validation seam -----
  const bundleSignatures: Record<string, { size: number; sha256: string }> = {};
  for (const [n, sha] of Object.entries(shas)) {
    if (files[n]) bundleSignatures[n] = { size: files[n].size, sha256: sha };
  }
  // model ownership recovery from the registry graph; the charset glyphs
  // decode pool-interned display names (entity families, definition-row
  // labels)
  const core = modelsMod.extractAssetModels(rows, pool.values, {
    onProgress: (done: number, total: number) => { bail(); step('catalog', done, total); },
    charsetGlyphs: dt.charset,
    actorSlots: new Set(spawnActorsBySlot.keys()),
    assetMaps,             // shared pure derivations (computed once above)
    materialAssets,
    strings: poolStrings,
  });
  bail();
  // AB2 structural records: occurrence-qualified terrain/block texture
  // bindings appended before catalog packaging. A FRESH graph is required —
  // face-base learning is order-sensitive, and this structural stage must run
  // on its own AssetGraph, not the room exporter's warmed one. Only the
  // constructor's pure row scan is shared (the maps are frozen at
  // construction and never written afterwards); every lazy cache — including
  // the order-sensitive face-base learning — starts empty here.
  // Own step key: this phase follows the row-scale 'catalog' pass and would
  // otherwise rewind its finished 240k-row bar to 0/1 on the same line.
  step('package', 0, 1);
  const structuralGraph = new graphMod.AssetGraph(rows, pool.values, {
    meshBySlot: ctx.graph.meshBySlot, texturesByMaterial: ctx.graph.texturesByMaterial,
  });
  const occurrenceGroups: [number, any][] = [];
  for (const roomId of layersById.keys()) {
    // same deterministic occupancy the shard loop already computed (read-only)
    occurrenceGroups.push([roomId, ctx.occupancy(roomId).occurrences]);
  }
  core.records.push(...structuralGraph.structuralBindingRecords(occurrenceGroups));
  bail();
  // The format-2 artifact embeds per-bundle signatures: they are what
  // buildPortableCatalog re-checks and attachPortableSystemCatalog validates
  // against this exact build.
  const assetModels = {
    format: 2,
    profile: {
      profile: {
        name: profile.name ?? null,
        bundle_sha256: shas[0],
        asset_bundles: bundleSignatures,
      },
    },
    records: core.records,
    models: core.models,
  };
  const catalog = catalogMod.buildSystemCatalog(
    assetModels, indexes.meshes!, indexes.images!, indexes.rigs!,
    [...spawnActorsBySlot.values()],
    // worldtex verdicts: parts/variants carry the room renderer's exact
    // uniform-luminance-tint decision (the grayscale-crystal tint machinery)
    (id: number) => texMeta.get(id),
    // roaming-enemy definition catalog: base names ("Street Hag") outrank the
    // per-tier qualifier labels ("Powerful") the annotation tiers pick up
    modelsMod.extractEnemyBaseNames(rows, pool.values, dt.charset, enemyDefs),
  );
  // "Set catalog.profile to the checkedBundleProfile() result first" (catalog.js)
  catalog.profile = catalogMod.checkedBundleProfile(
    assetModels, bundleSignatures,
  );
  const doc = catalogMod.buildPortableCatalog(
    catalog, indexes.meshes!,
  );
  const attachedSystem = attachPortableSystemCatalog(doc, {
    bundle0Sha256: shas[0],
    bundle0Size: files[0].size,
    bundleSignatures,
    indexes,
  });

  // ---- recovered wearable-item mesh names -----------------------------------
  // Cosmetic/transmog item-definition rows carry the item display name and
  // reference the worn ab5 mesh through their visual owner (see mesh-names.js).
  // The mesh<-owner bindings come straight from the asset-model records/models
  // this build just produced. Stored as its own derived doc: the Meshes list,
  // mesh viewer and search merge it as a display layer (`sn`) that hash-keyed
  // user names always override; its absence changes nothing.
  const meshOwnerPairs: [number, number][] = [];
  for (const rec of core.records) {
    if (Number.isInteger(rec.ab5_mesh) && Number.isInteger(rec.owner_slot)) {
      meshOwnerPairs.push([rec.ab5_mesh, rec.owner_slot]);
    }
  }
  for (const model of core.models) {
    for (const part of model.parts || []) {
      if (Number.isInteger(part.ab5_mesh) && Number.isInteger(model.owner_slot)) {
        meshOwnerPairs.push([part.ab5_mesh, model.owner_slot]);
      }
    }
  }
  const meshNames = meshNamesMod.extractMeshNames(rows, pool.values, dt.charset, meshOwnerPairs, {
    strings: poolStrings, poolRegistryRefs,
  });
  await sink.derivedPut(versionId, 'mesh:names', meshNames);

  // ---- (h) recovered animation clip names -----------------------------------
  // The animatic name records join to AB1 clips through their op-0 scalar and
  // the controller rows (see anim-names.js). Stored as its own derived doc:
  // the Animations viewers merge it into clip display labels when present;
  // its absence (older extraction, unknown build) changes nothing.
  const animNames = animNamesMod.extractAnimNames(rows, pool.values, dt.charset, dt.animDir, {
    strings: poolStrings, poolRegistryRefs,
  });
  await sink.derivedPut(versionId, 'anim:names', animNames);
  step('package', 1, 1);

  return { attachedSystem, roomsCount, worldIndex };
}
