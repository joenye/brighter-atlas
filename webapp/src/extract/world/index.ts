// World extraction orchestrator: turns the user's bundles into the stored
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

import {createEffectScaleReader} from './effect-scales.js';
import {createEffectWindowReader} from './effect-windows.js';
import {createEffectSpriteReader} from './effect-sprites.js';
import {createEffectFacingReader} from './effect-facing.js';
import {createEffectOriginReader} from './effect-origins.js';
import {createEffectFieldReader} from './effect-fields.js';
import {createEffectWaveReader} from './effect-waves.js';
import {readWorldWater, type WorldWater, type WaterDecodeData} from './water-materials.js';
import {readRenderMaterials, readEnvironmentPreset, archivedValue, archivedFloats, recordField, recordRef, validRenderData, type RenderDecodeData, type RenderEnvironment, type StoryEnvironment} from './render-data.js';
import {deriveRenderData, shaderFacts, type ShaderFacts} from './render-shape.js';
import {b64FromTyped} from '../b64.js';
import { loadWorldProfile, type FetchJson } from './profile.js';
import { fillRoomNames } from './room-graph.js';
import { deriveRoomAmbience } from './room-ambience.js';
import { mapRoomRecords } from '../maps/map-shape.js';
import { decodeGlyphText, deriveRoomMetadata, resolveValue } from './room-metadata.js';
import {placementDataOf,decodeDefaultAppearances,createAppearanceCandidateReader,createEffectMotionReader,type PlacementDecodeData} from './placement.js';
import {roomLayout, roomOwners, tileLayout, waterLayout} from './placement-shape.js';
import {effectLayout} from './effect-shape.js';
import {createEffectPropertyReader} from './effect-properties.js';
import { replayGraph } from './replay.js';
import { decodePool, type PoolNode } from './value-pool.js';
import { SpawnGraph } from './spawns.js';
import { decodeObject, makeSlabReader, readRaw } from '../bundles.js';
import { hashObject } from '../hash.js';

const UTF8_ENCODER = new TextEncoder();
import { poolMap, poolQueueDepth } from '../pool.js';
import { attachPortableSystemCatalog } from '../system-catalog.js';
import * as roomMod from './room.js';
import * as stitchMod from './stitch.js';
import * as shardsMod from './shards.js';
import * as graphMod from './graph.js';
import * as modelsMod from './models.js';
import * as catalogMod from './catalog.js';
import * as animNamesMod from './anim-names.js';
import * as meshNamesMod from './mesh-names.js';
import {objectDescriptionReader} from './object-descriptors.js';
import {recordNames} from './names.js';
import {annotateDisplayNames, nameFromRecords, byInternal as enemyByInternal, enemyDisplayNames, iconImageNames, referrerIndex} from './display-names.js';
import {readCards, assignModelCards, MODEL_CARDS_FORMAT} from './cards.js';
import {deriveCardData} from './card-data.js';
import {annotateObjectCatalog,appendObjectMeshNames} from './object-names.js';
import { inferMeshSlots, type RigSkeleton } from './mesh-slots.js';
import * as effectsMod from './effects.js';
import { decodeSkeleton, restWorldMatrices, type SkeletonBone } from '../skeleton.js';
import { decodeAnim } from '../anim.js';
import { idlePosePalette, encodeIdlePose, idlePoseKey, IDLE_POSES_FORMAT, type IdlePosesDoc } from './idle-poses.js';


// default JSON fetch for world data files (same contract as profile.js):
// rel is site-root-relative: 'builds/…' for the per-build decode data on the
// site origin, 'defaults/…' for files shipped with the app.
const defaultFetchJson: FetchJson = async (rel) => {
  const url = new URL(`../../../${rel}`, import.meta.url);
  // Revalidate, for the same reason profile.ts does: a host that answers a
  // missing path with index.html returns HTML as a 200, which a cache may keep
  // like any other success and then serve under this URL long after the real
  // file ships. These two files are fetched on every extraction, so a poisoned
  // entry here costs room names and the room reference, not just world data.
  const res = await fetch(url, { cache: 'no-cache' });
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
  /** called once the texture workers are done: from here on this thread
   *  works alone, so other work can use the idle cores */
  onTexturesDone?: () => void;
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
  sink, onProgress = () => {}, signal, fetchJson, onTexturesDone,
}: ExtractWorldOptions): Promise<{ attachedSystem: any; roomsCount: number; worldIndex: any }> {
  const bail = () => { if (signal?.aborted) throw new Error('cancelled'); };
  const step = (s: string, done: number, total: number) => onProgress({ stage: 'world', step: s, done, total });

  // ---- (a) decode profile: no match -> World is unavailable for this build --
  step('profile', 0, 1);
  const { profile, error } = await loadWorldProfile(ab0, { fetchJson });
  if (!profile) throw new Error(error || 'no world decode profile for this game build yet');
  const placementData=placementDataOf(profile);
  step('profile', 1, 1);
  bail();

  // ---- (b) registry replay (constructor + fill streams) --------------------
  const { rows, objects } = replayGraph(ab0, profile, {
    onProgress: (done, total) => { bail(); step('replay', done, total); },
  });
  bail();

  // ---- (e) worldtex: render metadata for every referenced ab3 container -----
  // Referenced = every ab3 container a registry row points at (tag-0x47
  // edges), the superset of what materials and spawn parts can use. texIds
  // derive from the replay rows ONLY, so the pooled pass is kicked off HERE,
  // immediately after replay, and works the other cores while this thread
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
    texPromise.catch(() => {});   // surfaced at the await below, never unhandled
  }

  // ---- (c) interned value pool ---------------------------------------------
  // Everything from here to the texture verdicts needs none of them, so it
  // runs while the texture workers are still busy. This thread hands the
  // workers their chunks, so they hold a deeper queue through these long
  // synchronous passes, and each pass is followed by a turn to top it up.
  poolQueueDepth(5);
  step('pool', 0, 1);
  const pool = decodePool(ab0, profile);
  // A macrotask turn: the texture pool's messages are handled between the
  // long synchronous passes that run while it works.
  const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  // One registry row's full fields, re-decoded per call (nothing is kept
  // between calls), shared by every reader below.
  const rowDecoder = effectsMod.makeRegistryRowDecoder(rows, ab0, profile);
  // Water materials resolved from the user's bundle through the optional
  // per-build decode data; absent or unreadable data leaves water to the
  // viewer's plain surfaces.
  const shapeRegistry = { rows, objects, pool: pool.values, decode: rowDecoder, types: dt.types };
  let waterFields: WaterDecodeData | null = null;
  let worldWater: WorldWater | null = null;
  try {
    waterFields = waterLayout(shapeRegistry);
    worldWater = readWorldWater(waterFields ?? undefined, rows, rowDecoder, pool.values);
  } catch { /* unreadable water data: plain surfaces */ }
  await breathe();
  // How the game draws this build (render-shape.ts): from the bundles, with
  // the per-build decode data's quest-lit rooms. Needs both shader bundles.
  let renderData: RenderDecodeData | null = null;
  try {
    const facts = async (n: number) => {
      if (!files[n] || !frames[n]) return null;
      const out: (ShaderFacts | null)[] = [];
      for (const e of frames[n].entries) out.push(shaderFacts(decodeObject(n as 4, await readRaw(files[n], e))));
      return out as ShaderFacts[];
    };
    const [vertex, pixel] = [await facts(7), await facts(4)];
    renderData = deriveRenderData({
      graphics: dt.graphics, vertex, pixel, ab0, globals: [profile.stream.constructor_end, profile.stream.fill_start],
      reg: { rows, pool: pool.values, decode: rowDecoder, symbols: dt.symbols },
      text: (n) => decodeGlyphText(n, dt.charset),
    }, placementData?.render ?? null);
  } catch { renderData = null; }
  await breathe();
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
  // ascending ab2 idx: stitch ordering contract
  const rooms: {
    idx: number; exits: any[]; name: string | null;
    w: number | null; h: number | null; gridW: number; gridH: number;
    ambience?: { level: string | null; colors: number[][] } | null;
  }[] = [];
  const layersById = new Map<number, any>();     // ab2 idx -> roomLayers() result (decodable rooms)
  // ab2 idx -> the room's per-tile colour grid (its outer rectangle): the
  // game tints the room's ground and water by it.
  const colourGrids = new Map<number, {x0: number; y0: number; width: number; height: number; colours: number[][]}>();
  const contentHashes = new Map<number, string>(); // ab2 idx -> sha256/16 of decoded bytes
  const environmentSlots = new Map<number, number>(); // ab2 idx -> environment record slot
  const environmentPresets = new Map<number, PoolNode>(); // ab2 idx -> inline environment preset
  const environmentCandidates = new Map<number, { rooms: number; slots: Map<number, number>; presets: Map<number, PoolNode> }>();
  // An inline preset in pool form. The room drops the preset's boolean (a bare
  // marker), so its values fill the slots the environment reads, in order.
  const inlinePreset = (group: any, table: any[], slots: number[]): PoolNode | null => {
    const node = (n: any): PoolNode | null => {
      n = roomMod.deref(n, table);
      if (n?.kind === 'lit') return { tag: n.tag, start: -1, value: n.tag === 0x0b ? [n.value] : n.value };
      if (n?.kind === 'group') return { tag: 0x24, start: -1, class: n.cls, fields: n.elems.map(node) };
      return null;
    };
    if (group.elems.length !== slots.length) return null;
    const fields: PoolNode[] = [];   // the dropped boolean stays a hole
    slots.forEach((slot, k) => { const value = node(group.elems[k]); if (value) fields[slot] = value; });
    return { tag: 0x24, start: -1, class: group.cls, fields };
  };
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
      const [ox0, oy0, ox1, oy1] = minimap.outerRect;
      const colours = minimap.grid.elems!.map((e: any) => {
        const c = roomMod.deref(e, parsed!.table);
        return c?.tag === 0x15 && Array.isArray(c.value) && c.value.length === 4 ? c.value.map(Number) : null;
      });
      if (colours.every((c: any) => c)) {
        colourGrids.set(i, {x0: ox0, y0: oy0, width: ox1 - ox0, height: oy1 - oy0, colours: colours as number[][]});
      }
      // The room's scene environment (lights, vignette colour, height fade):
      // a record, or a preset held inline in the room, at the room value most
      // rooms use for one (chosen after the loop).
      if (renderData) {
        const env = renderData.environment;
        const values = parsed!.top.slice(parsed!.table.length);
        values.forEach((value: any, v: number) => {
          const ref = roomMod.deref(value, parsed!.table);
          let c = environmentCandidates.get(v);
          if (ref?.kind === 'lit' && ref.tag === 0x26 && Number.isInteger(ref.value)) {
            if (!c) environmentCandidates.set(v, c = { rooms: 0, slots: new Map(), presets: new Map() });
            c.slots.set(i, ref.value);
            if (rows[ref.value]?.runtime === env.family) c.rooms++;
          } else if (ref?.kind === 'group' && ref.cls === env.presetClass) {
            const slots = [...new Set(Object.values(env.slots))].sort((a, b) => a - b);
            const preset = inlinePreset(ref, parsed!.table, slots);
            if (!preset) return;
            if (!c) environmentCandidates.set(v, c = { rooms: 0, slots: new Map(), presets: new Map() });
            c.presets.set(i, preset);
            c.rooms++;
          }
        });
      }
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
  if (!layersById.size) throw new Error('no rooms found in assetBundle2. Mixed game versions?');
  if (renderData) {
    let best = -1;
    for (const [v, c] of environmentCandidates) if (best < 0 || c.rooms > environmentCandidates.get(best)!.rooms) best = v;
    if (best < 0) renderData = null;
    else {
      renderData.environment.assetValue = best;
      for (const [room, slot] of environmentCandidates.get(best)!.slots) environmentSlots.set(room, slot);
      for (const [room, preset] of environmentCandidates.get(best)!.presets) environmentPresets.set(room, preset);
    }
  }
  environmentCandidates.clear();
  // Where rooms, heights and tiles keep their values (placement-shape.ts),
  // with the per-build decode data's other sections.
  await breathe();
  const owners = roomOwners(shapeRegistry, new Set(layersById.keys()));
  const roomFields = roomLayout(shapeRegistry, layersById, owners);
  const tileFields = tileLayout(shapeRegistry, profile, owners);
  await breathe();
  // Where effects keep their values (effect-shape.ts). The per-build decode
  // data, produced offline purely from analysis of the game's own files,
  // never by inspecting or modifying a running game process or its memory,
  // adds the computed colours, sprite choices and the other origins.
  let effectShapes: ReturnType<typeof effectLayout> = {};
  try {
    effectShapes = effectLayout({ rows, objects, symbols: dt.symbols, types: dt.types,
      extras: effectsMod.makeRowDecoder(rows, pool.values, ab0, profile, dt.charset, dt.symbols) }, waterFields);
  } catch { /* no derived effect fields: the decode data's, if any */ }
  await breathe();
  const fileOrigins = (placementData?.effectOrigins ?? []).filter((b) => b.kind === 'radial' || b.kind === 'segment');
  const shapeOrigins = (effectShapes.effectOrigins ?? []).filter((b) => !fileOrigins.some((f) => f.instance === b.instance));
  const origins = [...shapeOrigins, ...fileOrigins].sort((a, b) => a.instance - b.instance);
  const placementBindings: PlacementDecodeData | null = roomFields || Object.keys(effectShapes).length ? {
    ...(placementData ?? { kind: 'brighter-atlas-placement-decode', format: 1, bundle0_raw_sha256: profile.bundle0!.raw_sha256! }),
    ...(roomFields ?? {}), ...(tileFields ? { tiles: tileFields } : {}),
    ...effectShapes, ...(origins.length ? { effectOrigins: origins } : {}),
  } : placementData;

  const roomMetadata = deriveRoomMetadata(rows, pool.values, ab0, profile, dt.charset, rooms.map(r => r.idx));
  // Room annotations: in the rooms, or in a room annotation table found by shape.
  const mapRecords = mapRoomRecords(rows, pool.values, ab0, profile, pool.frame, dt.charset, dt.symbols, roomMetadata).records;
  // Historical naming remains a fallback for rooms without a complete header.
  // Direct titles always win over shipped or cross-build name suggestions.
  const names = roomMod.deriveRoomNames(ab0, dt.charset, rooms.filter(r => !roomMetadata.has(r.idx)).map(r => r.idx));
  try {
    // Ships with the app at defaults/room_name_overrides.json.
    const doc = await (fetchJson || defaultFetchJson)('defaults/room_name_overrides.json');
    if (doc?.overrides) roomMod.applyRoomNameOverrides(names, doc.overrides, contentHashes);
  } catch { /* no shipped overrides: derived names only */ }
  for (const [id, metadata] of roomMetadata) names.set(id, metadata.name);
  for (const r of rooms) r.name = names.get(r.idx) ?? null;

  // Per-room ambience. The game multiplies every particle by a global
  // half-range modulation fed from the ROOM, which is why effects authored
  // with no colour of their own still read as coloured in game and plain
  // white for us (see room-ambience.js). Derived here so the room records
  // carry it; a failure just leaves rooms without ambience.
  let ambienceByRoom = new Map<number, any>();
  try {
    const decodeRow = effectsMod.makeRowDecoder(
      rows, pool.values, ab0, profile, dt.charset, dt.symbols,
    );
    ambienceByRoom = deriveRoomAmbience({
      rows, ab0, roomIds: rooms.map((r) => r.idx), decodeRow,
    }) as any;
  } catch { /* no ambience: rooms simply carry none */ }
  for (const r of rooms) r.ambience = ambienceByRoom.get(r.idx) ?? null;

  // World placement runs AFTER the shard loop: the jigsaw connector meshes
  // that calibrate room joins (stitch.js CONNECTOR_MESH_HASHES) are only
  // known once shard placements exist.
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
  const entityVariantRecords = modelsMod.extractEntityVariantRecords(rows, pool.values, assetMaps.meshSlots,
    new Map([...assetMaps.textureSlots, ...materialAssets.materialTextures]), poolStrings,
    modelsMod.extractIndexedMaterialVariantBatches(rows));
  const enemyDefs = modelsMod.scanEnemyDefinitions(rows, pool.values, dt.charset, {
    strings: poolStrings, poolRegistryRefs, entityVariantRecords,
  });
  bail();
  await breathe();

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
  // Record names (names.ts): the name the game shows for each record. They
  // override the enemy names and internal-id table the naming passes use, and
  // name placed actors: the actor record's own name, else its authored label
  // mapped through the internal ids ("glinteye_deathcrow", or quest-prefixed
  // "q2_0_giant_two_headed_bear").
  const recNames = recordNames({ rows, pool: pool.values, charset: dt.charset, symbols: dt.symbols, decode: rowDecoder });
  const enemyNames = enemyDisplayNames(rows, poolStrings, poolRegistryRefs);
  // enemy definitions keep their slots; the record names correct their text
  for (const [slot, e] of enemyNames) {
    const n = recNames.nameOf(slot);
    if (n) enemyNames.set(slot, { name: n.singular ?? n.name, base: n.base ?? e.base });
  }
  for (const [internal, name] of recNames.byInternal) {
    enemyByInternal.set(internal, { name, base: enemyByInternal.get(internal)?.base ?? name });
  }
  const displayLabel = (label: string | null, record?: number) => {
    const own = record !== undefined ? recNames.nameOf(record) : null;
    if (own) return own.singular ?? own.name;
    if (!label || !/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(label)) return label;
    const hit = enemyByInternal.get(label) ?? enemyByInternal.get(label.replace(/^q\d+_\d+s?_/, ''));
    return hit ? hit.name : label;
  };
  await breathe();
  const ctx = createShardContext({
    displayLabel,
    rows,
    symbols: dt.symbols,
    pool: pool.values,
    meshDir: dt.meshDir,
    texMeta,
    rooms: layersById,
    names,
    loadMeshBytes,
    profile,
    charset: dt.charset,
    placement: placementBindings,
    objects,
    bytes: ab0,
    enemyDefs,             // shared pure derivation (computed once above)
    animDir: dt.animDir,
  });
  await breathe();

  // ---- card pictures (cards.ts): each model's card, drawn by the viewer ------
  // Card constants found in this bundle (card-data.ts); the lights need the
  // render data, else the viewer's default lights apply.
  let cards: ReturnType<typeof readCards> | null = null;
  const cardData = deriveCardData({ rows, pool: pool.values, charset: dt.charset, decode: rowDecoder });
  if (cardData) {
    const meshRig = (mesh: number) => { const sref = (dt.meshDir as any)?.[mesh]?.sref; return Number.isInteger(sref) && sref >= 2 ? sref - 2 : null; };
    const clipRig = (clip: number) => { const skel = (dt.animDir as any)?.[clip]?.skel; return Number.isInteger(skel) ? skel : null; };
    const clipDuration = (clip: number) => { const d = (dt.animDir as any)?.[clip]?.dur; return Number.isFinite(d) && d > 0 ? d : 0; };
    // Graphs of its own: the shard loop's must not be warmed out of room order.
    const graph = new graphMod.AssetGraph(rows, pool.values, {
      meshBySlot: ctx.graph.meshBySlot, texturesByMaterial: ctx.graph.texturesByMaterial,
    }, { bytes: ab0, profile, symbols: dt.symbols, defaultGround: placementBindings?.tiles?.defaultGround ?? null });
    await breathe();
    cards = readCards({
      rows, pool: pool.values, symbols: dt.symbols, charset: dt.charset, decode: rowDecoder,
      cards: cardData, render: renderData, meshBySlot: graph.meshBySlot, texturesByMaterial: graph.texturesByMaterial,
      meshRig, clipRig, clipDuration, enemyNames,
      spawnGraph: new SpawnGraph(rows, pool.values, graph, { bytes: ab0, profile, charset: dt.charset, enemyDefs, animDir: dt.animDir, meshDir: dt.meshDir }),
      nameOf: (slot: number) => { const n = recNames.nameOf(slot); return n ? n.singular ?? n.name : null; },
    });
  }
  await breathe();

  // Icon names (display-names.ts), applied to the catalog in the package stage.
  const materialsOf = (slot: number): number[] => {
    const out: number[] = [];
    for (const f of rowDecoder(slot) ?? []) {
      if (f.kind !== 'G') continue;
      const n = resolveValue(pool.values, f.node);
      if (n?.tag === 0x02 && Number.isInteger(n.value)) out.push(n.value as number);
    }
    return out;
  };
  const iconNames = iconImageNames(rows, poolStrings, ctx.graph.texturesByMaterial, indexes.images ?? [], materialsOf);
  bail();
  await breathe();

  // AB2 structural records: occurrence-qualified terrain/block texture
  // bindings, appended to the catalog records before packaging. A FRESH graph
  // is required: face-base learning is order-sensitive, and this structural
  // stage must run on its own AssetGraph, not the room exporter's. Only the
  // constructor's pure row scan is shared (the maps are frozen at
  // construction and never written afterwards); every lazy cache, including
  // the order-sensitive face-base learning, starts empty here.
  const structuralGraph = new graphMod.AssetGraph(rows, pool.values, {
    meshBySlot: ctx.graph.meshBySlot, texturesByMaterial: ctx.graph.texturesByMaterial,
  }, { bytes: ab0, profile });
  const occurrenceGroups: [number, any][] = [];
  for (const roomId of layersById.keys()) {
    // the deterministic occupancy the shard loop reuses (read-only)
    occurrenceGroups.push([roomId, ctx.occupancy(roomId).occurrences]);
  }
  const structuralRecords = structuralGraph.structuralBindingRecords(occurrenceGroups);
  poolQueueDepth(1);

  // ---- (e, results) worldtex verdicts, started right after replay above.
  // Awaited here because per-placement flags (alpha, authored-empty,
  // unrenderable) come from these verdicts: the shard loop below is the first
  // consumer (the context reads them lazily), and a texture-stage failure
  // must throw before shards.
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
  onTexturesDone?.();
  bail();

  // Jigsaw connector meshes, resolved to this build's ab5 ordinals by content
  // hash. Missing pieces (no meshes index, or a stale-cached stitch.js from a
  // mid-session update) degrade to the plain door-tile stitch: the connector
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

  // stream each shard to storage: writes batch into one transaction per ~32
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
    const metadata = roomMetadata.get(roomId);
    if (metadata) {
      const extra = { displayName: metadata.displayName, episode: metadata.episode,
        mapPosition: metadata.mapPosition, mapSize: metadata.mapSize,
        roomOwner: metadata.owner, nameSource: 'room-record' };
      Object.assign(shard, extra); Object.assign(entry, extra);
    }
    const mapRecord = mapRecords.get(roomId);
    if (mapRecord) {
      Object.assign(shard, {mapLabels: mapRecord.labels});
      Object.assign(entry, {mapAnnotations: mapRecord.labels.annotations.map(a => a.text)});
    }
    const grid = colourGrids.get(roomId);
    if (grid) shard.colour_grid = encodeColourGrid(grid);
    putBatch.push([`world:room:${roomId}`, shard]);
    if (putBatch.length >= 32) await flushShards();
    // ordinal-free room content hash: the diff identity for this room, so
    // version diffs pair rooms as unchanged/moved/changed like every other
    // asset category. The signature string is fixed here, synchronously:
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
  // Resting clips per actor (actor-idle.js), for the Models view, and the
  // distinct (rig, clip) pairs whose first frame the world poses statically.
  const idleActors: Record<string, { clip: number; source: string; label: string | null }> = {};
  const idlePairs = new Map<string, { rig: number; clip: number }>();
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
      if (actor.idle_clip !== null && actor.idle_source) {
        idleActors[String(actor.record)] = { clip: actor.idle_clip, source: actor.idle_source, label: actor.label };
        for (const mesh of meshes) {
          const sref = dt.meshDir[mesh]?.sref ?? 0;
          if (sref >= 2) idlePairs.set(idlePoseKey(sref - 2, actor.idle_clip), { rig: sref - 2, clip: actor.idle_clip });
        }
      }
    }
  }
  await sink.derivedPut(versionId, 'anim:idle', { format: 1, actors: idleActors });
  // Rig rest-world bone translations, needed for particle-effect bone
  // binding (effects.js): every distinct rig ANY mesh references, decoded
  // once from ab6 and reduced via forward kinematics to rest-WORLD bone
  // translations (extract/skeleton.js). 'world' always requires bundle 6
  // (CAT_BUNDLES.world), so files[6]/frames[6] are expected present; the
  // guard below is belt-and-braces, matching this module's own "never let a
  // recovery-only stage fail the extraction" discipline. A rig that fails to
  // decode (malformed skeleton) simply stays out of the map: effects.js
  // degrades any reference to it to bone:null (root) placement.
  // The bone PARENTS come along for the ride: the body-slot inference below
  // walks them to give an unlabelled bone its nearest labelled ancestor's slot.
  // The decoded bones themselves pose the idle clips below.
  const rigBoneTranslations = new Map<number, number[][]>();
  const rigWorldMatrices = new Map<number, number[][]>();
  const rigSkeletons = new Map<number, RigSkeleton>();
  const rigBones = new Map<number, SkeletonBone[]>();
  if (files[6] && frames[6]) {
    const rigIds = new Set<number>();
    for (const entry of dt.meshDir) if (entry.sref >= 2) rigIds.add(entry.sref - 2);
    if (rigIds.size) {
      try {
        const ab6 = new Uint8Array(await files[6].arrayBuffer());
        for (const rigId of rigIds) {
          const e = frames[6].entries[rigId];
          if (!e) continue;
          try {
            const dec = decodeObject(6, ab6.subarray(e.offset, e.offset + e.length));
            const { bones } = decodeSkeleton(dec, { i: rigId });
            rigBones.set(rigId, bones);
            const matrices = restWorldMatrices(bones);
            const rest = matrices.map(m => [m[12], m[13], m[14]]);
            rigWorldMatrices.set(rigId, matrices);
            rigBoneTranslations.set(rigId, rest);
            rigSkeletons.set(rigId, { parents: bones.map((b) => b.parent), rest });
          } catch { /* malformed skeleton: this rig stays unresolved */ }
        }
      } catch { /* bundle 6 unreadable: every rig stays unresolved */ }
    }
  }
  // Frame-0 skin palettes need the clips themselves (assetBundle1), which the
  // World category only uses when it was supplied; without them the world
  // keeps drawing rigged actors in their bind pose.
  step('idle poses', 0, 1);
  if (files[1] && frames[1] && idlePairs.size) {
    try {
      const ab1 = new Uint8Array(await files[1].arrayBuffer());
      const poses: IdlePosesDoc['poses'] = {};
      for (const [key, { rig, clip }] of idlePairs) {
        bail();
        try {
          const bones = rigBones.get(rig);
          const e1 = frames[1].entries[clip];
          if (!bones || !e1) continue;
          const anim = decodeAnim(decodeObject(1, ab1.subarray(e1.offset, e1.offset + e1.length)), { i: clip, skel: rig, flags: dt.animDir[clip]?.flags });
          const palette = idlePosePalette(bones, anim);
          if (palette) poses[key] = encodeIdlePose(palette);
        } catch { /* a malformed clip or rig simply stays unposed */ }
      }
      await sink.derivedPut(versionId, 'world:idle-poses', { format: IDLE_POSES_FORMAT, poses } as IdlePosesDoc);
    } catch { /* bundle unreadable: no poses this time */ }
  }
  step('idle poses', 1, 1);

  // ---- recovered particle effect systems ------------------------------------
  // Structural per-build detection over the replayed rows + value pool (see
  // effects.js); stores room-local cells, so it needs nothing from stitch and
  // nothing from the catalog. Stored as its own derived doc; its absence
  // changes nothing. An EMPTY doc (zero systems) is stored deliberately: its
  // audit stays inspectable, and the store probe gates effects UI on stored
  // systems, so empty and absent docs gate identically. Unlike anim:names
  // this call IS wrapped: it is a
  // shape-detected stage shipping against builds it has never seen, and it
  // must not be able to fail World extraction (the module is internally total
  // already; the catch is belt-and-braces against module bugs, re-throwing
  // only cancellation). Byte-identity of every existing output is untouched:
  // the stage only reads shared state and writes one new key.
  step('effects', 0, 1);
  const defaultAppearances=decodeDefaultAppearances(placementBindings,ab0,profile,pool.values,dt.symbols,rows.length);
  const appearanceCandidates=createAppearanceCandidateReader(placementBindings,rows,ab0,profile,pool.values,dt.symbols);
  const effectMotion=createEffectMotionReader(placementBindings,rows,ab0,profile,pool.values,dt.symbols);
  try {
    const effects = effectsMod.extractWorldEffects(rows, pool.values, ab0, profile, {
      charset: dt.charset, symbols: dt.symbols, strings: poolStrings, poolRegistryRefs,
      textureSlots: assetMaps.textureSlots, roomIds: ctx.roomIds,
      spriteMeta: (texId) => texMeta.get(texId)?.sprite ?? null,
      occupancy: (id) => ctx.occupancy(id),
      spawnActors: spawnActorsBySlot,
      meshSkeletonRef: (meshId) => (dt.meshDir[meshId]?.sref ?? 0),
      roomPlacements: (occurrences) => ctx.graph.roomPlacements(occurrences as any) as any,
      drawOccurrence: (hit) => ctx.graph.drawOccurrence(hit as any) as any,
      staticAppearance: (slot) => defaultAppearances.get(rows[slot]?.runtime) ?? ctx.graph.staticAppearance(slot),
      appearanceCandidates,
      effectScales: createEffectScaleReader(placementBindings?.effectScales, objects),
      effectWindow: createEffectWindowReader(placementBindings?.effectWindows, objects),
      effectSprites: createEffectSpriteReader(placementBindings?.effectSprites, objects, ab0, profile, pool.values),
      effectFacing: createEffectFacingReader(placementBindings?.effectFacings, objects),
      effectOrigin: createEffectOriginReader(placementBindings?.effectOrigins, objects),
      effectProperties: createEffectPropertyReader(placementBindings?.effectProperties,objects,ab0,profile,pool.values),
      effectFields: createEffectFieldReader(placementBindings?.effectFields, objects),
      effectWave: createEffectWaveReader(placementBindings?.effectWaves, objects, rowDecoder, pool.values),
      effectMotion: (controller,hit,roomId) => {
        const motion=effectMotion(controller);
        if(!motion||!placementBindings?.rooms)return null;
        const room=layersById.get(roomId),dimensions=ctx.graph.dimensions3i(hit.resource);
        if(!room||!dimensions)return null;
        const source=roomMod.deref(room.top.slice(room.table.length)[placementBindings.rooms.origin],room.table);
        if(source.tag!==46||source.value?.length!==2||!source.value.every(Number.isInteger))return null;
        const turn=(hit.rotationQuarters??0)&1;
        return {...motion,footprint:[dimensions[turn],dimensions[turn^1]],origin:[source.value[0]|0,source.value[1]|0]};
      },
      occurrenceAnchor: (hit) => ctx.graph.occurrenceAnchor(hit as any, {
        tileUnits: shardsMod.TILE_UNITS, meshForwardQuarterTurns: shardsMod.MESH_FORWARD_QUARTER_TURNS,
      }),
      rigBoneTranslations,
      rigWorldMatrices,
      bail, onStep: (d, t) => step('effects', d, t),
    });
    await sink.derivedPut(versionId, 'world:effects', effects);
  } catch (e) {
    if (signal?.aborted || e?.message === 'cancelled') throw e;
    // recovered effects are optional: no doc, nothing else changes
  }
  step('effects', 1, 1);

  // ---- door-graph world placement, calibrated by the jigsaw connectors ------
  step('stitch', 0, 1);
  const placement = stitchMod.stitchWorld(rooms, connectorTiles.size ? connectorTiles : null);
  const authoredPositions = new Map<number, [number, number]>();
  for (const room of rooms) {
    const layers = layersById.get(room.idx);
    const position = layers && roomMod.roomWorldPosition(layers.top, roomMetadata.get(room.idx)?.mapPosition);
    if (position) authoredPositions.set(room.idx, position);
  }
  const worldPositions = stitchMod.resolveRoomPositions(placement.positions, authoredPositions);
  step('stitch', 1, 1);
  for (const entry of shardsMeta) {
    // per-room ambience rides the index record, next to the room's own name
    const ambience = ambienceByRoom.get(entry.id);
    if (ambience) entry.ambience = ambience;
    const pos = worldPositions.get(entry.id) || null;
    entry.world = {
      x: pos ? pos[0] : null,
      y: pos ? pos[1] : null,
      plane: placement.planes.get(entry.id) ?? 0,
      source: !pos ? null : authoredPositions.has(entry.id) ? 'authored' : 'doors',
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
  } catch { /* no reference room list: derived names only */ }
  const worldIndex = buildWorldIndex(ctx, shardsMeta);
  // texture routing table (sw.js worldtex/ routes decode from it)
  // + paired door adjacency for the merged all-rooms view
  worldIndex.textures = Object.fromEntries([...texMeta].map(([id, meta]) => [id, meta]));
  worldIndex.links = placement.links;
  if (worldWater) worldIndex.water = worldWater;
  // How the game draws the world: program tables, materials and each room's
  // scene environment, from the optional per-build render bindings.
  try {
    const render = renderData;
    if (render && validRenderData(render)) {
      const environments: Record<string, RenderEnvironment> = {};
      const story: Record<string, StoryEnvironment> = {};
      const field = (slot: number, op: number) => recordField(rows, rowDecoder, pool.values, slot, op);
      const text = (n: PoolNode | null) => (n?.tag === 0x0e && Array.isArray(n.values) ? String.fromCodePoint(...(n.values as number[])) : null);
      for (const roomId of new Set([...environmentSlots.keys(), ...environmentPresets.keys()])) {
        const slot = environmentSlots.get(roomId) ?? -1;
        const owner = roomMetadata.get(roomId)?.owner;
        const runtime = rows[owner as number]?.runtime;
        const override = render.environment.overrides.find(o => runtime === o.roomRuntime);
        // The room's own environment: held inline, or in its environment record.
        let own: PoolNode | null = null;
        if (environmentPresets.has(roomId)) own = environmentPresets.get(roomId)!;
        else if (rows[slot]?.runtime === render.environment.family) own = field(slot, render.environment.field);
        const read = (p: PoolNode | null) => readEnvironmentPreset(render, p, rows, rowDecoder, pool.values, dt.symbols);
        const env = read(override ? archivedValue(ab0, profile, override.presetOffset) : own);
        if (env) environments[roomId] = env;
        // Rooms whose lighting follows a quest: every step, named by the quest
        // and its region ("Main Story (Hopeforest)").
        const s = render.environment.story;
        const entry = s?.rooms.find(r => r.roomRuntime === runtime);
        if (s && entry) {
          const f = s.fields;
          const states = field(entry.variable, f.variableStates);
          const quest = recordRef(field(entry.variable, f.variableQuest));
          const name = text(field(quest, f.questName));
          const region = text(field(recordRef(field(quest, f.questRegion)), f.regionName));
          const steps = entry.steps.map(([from, offset]) => ({from, environment: read(offset < 0 ? own : archivedValue(ab0, profile, offset))}));
          const count = Array.isArray(states?.values) ? states!.values.length : entry.steps[entry.steps.length - 1][0] + 1;
          if (name && steps.every(st => st.environment)) {
            story[roomId] = {quest: region ? `${name} (${region})` : name, states: count, steps: steps as StoryEnvironment['steps']};
          }
        }
      }
      worldIndex.render = {
        programs: render.programs, vertexShaders: render.vertexShaders, pixelShaders: render.pixelShaders,
        samplers: render.samplers, blends: render.blends, waterPrograms: render.waterPrograms,
        materials: readRenderMaterials(render, rows, rowDecoder, pool.values, dt.symbols),
        environments,
        ...(Object.keys(story).length ? {story} : {}),
        lighting: {direction: archivedFloats(ab0, profile, render.lighting.directionOffset, 0x22, 3),
          gamma: render.lighting.gamma, fade: render.lighting.fade},
        shadow: {...render.shadow, lightView: archivedFloats(ab0, profile, render.shadow.lightViewOffset, 0x30, 12)},
        ssao: render.ssao, camera: render.camera, vignette: render.vignette, clock: render.clock,
      };
    }
  } catch { /* unreadable render data: no render bindings */ }
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
    entityVariantRecords,
  });
  bail();
  // Own step key: this phase follows the row-scale 'catalog' pass and would
  // otherwise rewind its finished 240k-row bar to 0/1 on the same line.
  step('package', 0, 1);
  core.records.push(...structuralRecords);
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
  const describeObject=objectDescriptionReader(rows,pool.values,ab0,profile,dt.charset);
  annotateObjectCatalog(catalog,describeObject);
  // Display names from the records behind each model (display-names.ts):
  // enemy type names, item records' own names, and the one name every
  // named record using an appearance agrees on. Names and aliases only.
  const labelOf = (slot: number): string | null => {
    const spawn = spawnActorsBySlot.get(slot) as any;
    if (typeof spawn?.label === 'string' && spawn.label.trim()) return spawn.label;
    try { return describeObject(slot)?.descriptors?.[0]?.name ?? null; } catch { return null; }
  };
  annotateDisplayNames(catalog, enemyNames, iconNames.rowNames, { referrers: referrerIndex(rows, poolRegistryRefs), labelOf });
  nameFromRecords(catalog, (slot) => { const n = recNames.nameOf(slot); return n ? { name: n.singular ?? n.name, base: n.base } : null; });
  await sink.derivedPut(versionId, 'image:names', { format: iconNames.format, images: iconNames.images });

  if (cards) await sink.derivedPut(versionId, 'model:cards', { format: MODEL_CARDS_FORMAT, cards: assignModelCards(catalog.models as any[], cards) });
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
  appendObjectMeshNames(meshNames,meshOwnerPairs,describeObject);
  await sink.derivedPut(versionId, 'mesh:names', meshNames);

  // ---- inferred body slots for the meshes no item names --------------------
  // The item slots above are the labels; the skinning weights (the mesh index's
  // dominant bone, written by the mesh pass) spread them across the rest of the
  // rig, so the slot facet covers a whole wardrobe instead of the few hundred
  // meshes an item definition happens to reach (see mesh-slots.js). Its own
  // doc, kept apart from the recovered names because it is inference, not
  // recovery; a meshes-less ingest simply has nothing to infer from.
  const itemSlots = new Map<number, string>();
  for (const [ordinal, rec] of Object.entries<any>(meshNames.meshes)) {
    if (rec?.slot) itemSlots.set(Number(ordinal), rec.slot);
  }
  const meshSlots = inferMeshSlots(indexes?.meshes || [], rigSkeletons, itemSlots);
  await sink.derivedPut(versionId, 'mesh:slots', meshSlots);

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

// Per-tile colours as a palette plus one 16-bit index per cell (row-major
// from the grid's minimum corner), base64 encoded.
function encodeColourGrid(grid: {x0: number; y0: number; width: number; height: number; colours: number[][]}) {
  const palette: number[][] = [];
  const index = new Map<string, number>();
  const cells = new Uint16Array(grid.colours.length);
  grid.colours.forEach((c, k) => {
    const key = c.join(',');
    let at = index.get(key);
    if (at === undefined) { at = palette.length; palette.push(c); index.set(key, at); }
    cells[k] = at;
  });
  return {x0: grid.x0, y0: grid.y0, width: grid.width, height: grid.height, palette, cells: b64FromTyped(cells)};
}
