// Per-object index jobs — the CPU-bound decode+hash work of an ingest index
// pass, factored out so it can run EITHER inline on the ingest thread (node
// tests, browsers without nested workers) or sharded across a pool of workers
// (pool.js / pool-worker.js). Every job is a pure function of (raw bytes,
// small extra), so the two paths are byte-identical by construction — the
// ingest coordinator derives all ab0-side fields itself.

import { decodeObject } from './bundles.js';
import { hashObject } from './hash.js';
import { audioIndexEntry } from './audio.js';
import {
  categorize, parseDatafileRecords, decodeFontGlyphs,
  parseImageMeta, decodeSubImage, applyMaterialCutout,
  type ImageMeta,
} from './image.js';
import { resolveRoles, type TextureRoles } from '../texture-roles.js';
import { classifyWaterRgba } from '../water-metrics.js';
import { encodePng, SERVED_PNG_LEVEL, DECODED_CACHE, DECODED_CACHE_MAX_BYTES } from './png.js';

// ---- worldtex cache pre-warm ------------------------------------------------
// During world extraction the albedo/normal/parameter pixels are already
// decoded, so PNG-encode them here and put them straight into the service
// worker's Cache API cache under the exact URLs sw.js serves
// (<origin>/cs/<versionId>/images/NNNNN_eK.png). That turns the first
// #/world/all load from ~2k on-demand sw.js decodes into plain cache hits.
// The bytes must stay role-identical to sw.js servePng: same decodeSubImage,
// same applyMaterialCutout on the albedo plane (the caller passes the
// already-cutout albedo buffer), same encodePng. The cache name/cap are the
// SHARED constants from png.js — sw.js uses the same ones, so the two writers
// cannot drift.
//
// CRITICAL: the pool hands worldtex jobs a DENSE SUBSET of ab3 (only the
// world-referenced containers), so the job-local `i` is a position, NOT the
// ab3 ordinal. Warm URLs must be keyed by the true ordinal (extra.ord) —
// keying by position once cached foreign images under other containers' URLs.

// base: absolute `<origin>/cs/<versionId>/images/` URL prefix; entries/subs:
// the container's parsed metadata + raw sub-image planes; decodedRgba holds
// the planes the job already decoded (albedo post-cutout). A warm failure of
// any kind degrades silently — the cache is an optimization, never a
// correctness dependency (and node tests have no Cache API at all).
async function warmWorldTexturePngs({ base, ord, entries, subs, roles, decodedRgba }: {
  base: string; ord: number; entries: ImageMeta[]; subs: Uint8Array[];
  roles: TextureRoles; decodedRgba: Record<number, Uint8Array>;
}): Promise<void> {
  try {
    const cache = await caches.open(DECODED_CACHE);
    const planes = [...new Set(
      [roles.albedo, roles.normal, roles.parameter].filter((k): k is number => k != null),
    )];
    const urls = planes.map((k) => `${base}${String(ord).padStart(5, '0')}_e${k}.png`);
    // one PARALLEL match round instead of a serial await per plane: a fresh
    // extraction sees all misses at once, a re-extraction still skips the
    // encode work (nothing observes the skips — the cache is the only output)
    const warm = await Promise.all(urls.map((url) => cache.match(url)));
    const puts: Promise<void>[] = [];
    for (let p = 0; p < planes.length; p++) {
      if (warm[p]) continue;   // re-extraction: already warm
      const k = planes[p];
      // albedo = the cutout-applied buffer servePng would encode; the other
      // roles are served raw, exactly decodeSubImage's output.
      const rgba = decodedRgba[k] ?? decodeSubImage(entries[k], subs[k]).rgba;
      const png = encodePng(entries[k].w, entries[k].h, rgba, { channels: 4, level: SERVED_PNG_LEVEL });
      if (png.byteLength > DECODED_CACHE_MAX_BYTES) continue;   // sw.js wouldn't cache it either
      // fire the puts without awaiting between planes; all awaited at the end
      puts.push(cache.put(urls[p], new Response(png, {
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
      })));
    }
    await Promise.all(puts);
  } catch { /* quota/security/... — stay silent, sw.js decodes on demand */ }
}

// kind -> async (bundleIndex, i, raw, extra) -> per-object result
export const INDEX_JOBS: Record<string,
  (n: number, i: number, raw: Uint8Array, extra?: any) => Promise<any>> = {
  // meshes/anims: everything except h derives from ab0 on the coordinator
  hash: async (n, i, raw) => ({ i, h: await hashObject(decodeObject(n, raw)) }),

  audio: async (n, i, raw) => ({ ...audioIndexEntry(raw, i), h: await hashObject(raw) }),

  // extra = the ab0 texture_dir pair {flags, n} for this object. A font-glyph
  // decode failure degrades to f: [] with the error reported (ferr).
  images: async (n, i, raw, extra) => {
    const decoded = decodeObject(3, raw);            // { tail, subs }
    const h = await hashObject(decoded);
    // The datatable's per-object sub-frame count is the cross-bundle
    // consistency contract: a disagreement means this assetBundle3 does not
    // belong with the ingested assetBundle0 (mixed game versions). Surface
    // it as a dedicated marker so the coordinator can fail the ingest hard
    // instead of indexing impostor entries.
    const dirFlags = Array.isArray(extra) ? extra[0] : extra.flags;
    const dirN = Array.isArray(extra) ? extra[1] : extra.n;
    if (dirFlags === 0 && dirN > 0 && decoded.subs.length !== dirN) {
      return {
        i, h, mixedVersion: true,
        err: `has ${decoded.subs.length} sub-frames but the datatable expects ${dirN}`,
      };
    }
    const { cat, n: nSub, entries } = categorize(raw, extra);
    const p = (k: number) => `images/${String(i).padStart(5, '0')}_e${k}.png`;
    let f: string[] = [];
    let ferr = null;
    try {
      if (cat === 'lut') f = [p(0)];
      else if (cat === 'font') f = decodeFontGlyphs(decoded.subs[0], parseDatafileRecords(decoded.subs[0], extra.n)).map((g) => p(g.e));
      else if (entries.length) f = entries.map((_, k) => p(k));
    } catch (err) { ferr = `images[${i}] f-list: ${err.message}`; }
    return { i, n: nSub, cat, entries, f, h, ...(ferr ? { ferr } : {}) };
  },

  // World texture render metadata for one referenced AB3 container: material
  // role sub-images, authored alpha + albedo RGB spread AFTER packed-blue
  // cutout recovery, last packed plane channel ranges (the
  // uniform-luminance-tint inputs), and the content-based water fingerprint —
  // all decided once at extraction so the world shard builder and viewer need
  // no pixel access. Keep in lockstep with the shard flag rules in
  // world/shards.js.
  //
  // extra.warmPngBase (browser world extraction only): pre-encode the role
  // sub-images as PNGs into the service worker's cache — see
  // warmWorldTexturePngs above. Guarded on the Cache API existing.
  worldtex: async (n, i, raw, extra) => {
    const out: {
      i: number; kind: string; alpha: boolean; spreadMax: number | null;
      paramMin: number[] | null; paramMax: number[] | null; water: string | null;
      albedo: number | null; normal: number | null; parameter: number | null;
    } = {
      i, kind: 'other', alpha: false, spreadMax: null,
      paramMin: null, paramMax: null, water: null,
      albedo: null, normal: null, parameter: null,
    };
    const { tail, subs } = decodeObject(3, raw);
    decode: {
      if (tail.length === 0) {
        if (!subs.length) out.kind = 'empty';
        break decode;   // frames without metadata = a data file ('other')
      }
      if (tail.length !== 13 * subs.length) break decode;
      let entries: ImageMeta[];
      try { entries = parseImageMeta(tail); } catch { break decode; }
      const roles = resolveRoles({ entries });
      if (roles.albedo == null) break decode;
      const albedoMeta = entries[roles.albedo];
      const decodedRgba: Record<number, Uint8Array> = {
        [roles.albedo]: decodeSubImage(albedoMeta, subs[roles.albedo]).rgba,
      };
      let last = null;
      // Only two kinds of parameter plane feed the verdicts: albedo-sized
      // planes (cutout recovery inputs, kept in decodedRgba) and the FINAL
      // plane (the paramMin/Max channel-range source — `last` only ever kept
      // its decode). Planes that are neither were decoded and dropped; skip
      // them. The warm path re-decodes on demand for anything it needs that
      // is not in decodedRgba, exactly as before.
      const lastParam = roles.parameters.length
        ? roles.parameters[roles.parameters.length - 1] : -1;
      for (const index of roles.parameters) {
        const sameSize = entries[index].w === albedoMeta.w && entries[index].h === albedoMeta.h;
        if (!sameSize && index !== lastParam) continue;
        const packed = decodeSubImage(entries[index], subs[index]).rgba;
        if (sameSize) decodedRgba[index] = packed;
        if (index === lastParam) last = packed;
      }
      if (last !== null) {
        const channelMin = [255, 255, 255, 255];
        const channelMax = [0, 0, 0, 0];
        for (let p = 0; p < last.length; p += 4) {
          for (let c = 0; c < 4; c++) {
            const v = last[p + c];
            if (v < channelMin[c]) channelMin[c] = v;
            if (v > channelMax[c]) channelMax[c] = v;
          }
        }
        out.paramMin = channelMin;
        out.paramMax = channelMax;
      }
      applyMaterialCutout(entries, decodedRgba);
      const rgba = decodedRgba[roles.albedo];
      let spread = 0;
      let alpha = false;
      for (let p = 0; p < rgba.length; p += 4) {
        const r = rgba[p];
        const g = rgba[p + 1];
        const b = rgba[p + 2];
        const hi = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const lo = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (hi - lo > spread) spread = hi - lo;
        if (rgba[p + 3] < 250) alpha = true;
      }
      out.kind = 'image';
      out.alpha = alpha;
      out.spreadMax = spread;
      out.water = classifyWaterRgba(rgba, albedoMeta.w, albedoMeta.h);
      out.albedo = roles.albedo;
      out.normal = roles.normal;
      out.parameter = roles.parameter;
      if (extra?.warmPngBase && Number.isInteger(extra?.ord) && typeof caches !== 'undefined') {
        await warmWorldTexturePngs({
          base: extra.warmPngBase, ord: extra.ord, entries, subs, roles, decodedRgba,
        });
      }
    }
    return out;
  },
};

export async function runIndexJob(
  kind: string, n: number, i: number, raw: Uint8Array, extra?: any,
): Promise<any> {
  return INDEX_JOBS[kind](n, i, raw, extra);
}
