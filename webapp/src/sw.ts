// Payload service worker: serves `cs/<versionId>/images/NNNNN_eK.png` and
// `cs/<versionId>/audio/NNNNN.wav` by decoding on demand from the OPFS raw
// bundles (written at ingest). This is what lets the viewers keep using the
// synchronous store.url() contract (thumbnails via <img>, audio via <audio>,
// textures via three.js loaders) with no HTTP data tree behind them.
//
// Decoded responses are cached in the Cache API keyed by full URL (which
// embeds the versionId, so game updates can never serve stale bytes).
//
// Bundled to the webapp root as sw.js: root scope is required for the cs/
// URL namespace.

import { getVersion, derivedGet, rawFile } from './storage.js';
import { decodeObject } from './extract/bundles.js';
import {
  parseImageMeta, decodeSubImage, applyMaterialCutout,
  parseDatafileRecords, decodeFontGlyphs, decodeLut,
} from './extract/image.js';
import { encodePng, SERVED_PNG_LEVEL, DECODED_CACHE, DECODED_CACHE_MAX_BYTES } from './extract/png.js';
import { resolveRoles } from './texture-roles.js';
import {
  parseAudioHeader, decodeQoa, decodeType00, decodeOpus, encodeWav, preloadOpusModule, rateForCodec,
} from './extract/audio.js';
import * as OpusVendor from '../vendor/opus-decoder.module.js';
import { adoptZstdWasm } from './extract/zstd.js';
import * as zstdWasm from '../vendor/zstd-wasm.module.js';

// service-worker global scope (the program compiles with the DOM lib)
const sw = self as any;

preloadOpusModule(OpusVendor);   // dynamic import() is disallowed inside service workers
// Warm WASM zstd at SW startup, the one context that keeps it: cold texture
// serves decode big single frames and the compile runs once per SW life.
// Pre-init (or failed-init) decodes take the fzstd path, byte-identically.
(globalThis as any).__zstdWasm = 'pending';
zstdWasm.init().then(
  () => { adoptZstdWasm(zstdWasm); (globalThis as any).__zstdWasm = 'ready'; },
  () => { (globalThis as any).__zstdWasm = 'unavailable'; },
);

// Bump this whenever a decoder's OUTPUT changes (e.g. the bslpc 24 kHz rate fix)
// so already-decoded payloads are re-decoded instead of served stale from cache.
// v5: clean slate after reports of stale per-entry PNGs (foreign sub-images
// on material containers) that current decoders reproduce correctly.
const CACHE = DECODED_CACHE;
const CACHE_MAX_BYTES = DECODED_CACHE_MAX_BYTES;   // don't cache monster payloads

sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (e: any) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await sw.clients.claim();
})()));

interface VersionCtx {
  rec: any;
  frames: Map<number, any>;
  dirs: Map<string, any>;
  files: Map<string, Promise<Blob>>;
}

const versions = new Map<string, VersionCtx>();   // versionId -> {rec, frames: Map<n, [[off,len]]>}
async function ctx(versionId: string): Promise<VersionCtx> {
  if (!versions.has(versionId)) {
    const rec = await getVersion(versionId);
    if (!rec) throw new Error(`unknown version ${versionId}`);
    versions.set(versionId, {
      rec, frames: new Map(), dirs: new Map(), files: new Map(),
    });
  }
  return versions.get(versionId)!;
}
// Resolved raw-bundle handles cached per sha (same lifetime as rec/frames):
// re-walking OPFS directory handles per request was pure latency. A failed
// resolve is evicted so a transient error can retry.
function rawHandle(c: VersionCtx, sha: string): Promise<Blob> {
  let file = c.files.get(sha);
  if (!file) {
    file = rawFile(sha).catch((err) => { c.files.delete(sha); throw err; });
    c.files.set(sha, file);
  }
  return file;
}
async function frameTable(c: VersionCtx, n: number): Promise<any> {
  if (!c.frames.has(n)) c.frames.set(n, await derivedGet(c.rec.versionId, `frames:${n}`));
  return c.frames.get(n);
}
async function dirTable(c: VersionCtx, name: string): Promise<any> {
  if (!c.dirs.has(name)) c.dirs.set(name, await derivedGet(c.rec.versionId, name));
  return c.dirs.get(name);
}

async function rawObject(c: VersionCtx, n: number, i: number): Promise<Uint8Array> {
  const frames = await frameTable(c, n);
  if (!frames?.[i]) throw new Error(`no frame ab${n}[${i}]`);
  const sha = c.rec.bundles?.[n]?.sha256;
  if (!sha) throw new Error(`assetBundle${n} not stored`);
  const file = await rawHandle(c, sha);
  const [off, len] = frames[i];
  try {
    return new Uint8Array(await file.slice(off, off + len).arrayBuffer());
  } catch (err) {
    c.files.delete(sha);   // stale handle (raw tier evicted since caching)
    throw err;
  }
}

async function servePng(c: VersionCtx, i: number, k: number): Promise<Response> {
  const dt = await dirTable(c, 'datatable:texturedir');
  const { flags, n } = dt?.[i] ?? { flags: 0, n: 0 };
  const decoded = decodeObject(3, await rawObject(c, 3, i));
  let pixels, w, h, channels = 4;
  if (flags === 1) {
    // data file: font glyph bank (k = record index) or LUT (single _e0 render)
    const payload = decoded.subs[0];
    const recs = parseDatafileRecords(payload, n);
    const px = recs.every((r: any) => r.fmt === 0x02)
      ? decodeLut(payload, recs)
      : decodeFontGlyphs(payload, recs).find((g: any) => g.e === k);
    if (!px) throw new Error(`glyph ${k} empty/out of range`);
    ({ w, h, channels } = px);
    pixels = px.pixels;
  } else {
    const meta = parseImageMeta(decoded.tail);
    if (!meta[k]) throw new Error(`sub ${k} out of range`);
    const px = decodeSubImage(meta[k], decoded.subs[k]);
    ({ w, h } = px);
    pixels = px.rgba;
    // The material albedo PNG is the render-ready view used by every main
    // editor surface and GLB export. Recover the same packed-blue silhouette
    // as World3D while leaving the other raw parameter PNGs untouched.
    const decodedRgba: Record<number, any> = { [k]: pixels };
    const roles = resolveRoles({ entries: meta });
    if (k === roles.albedo) {
      for (const index of roles.parameters) {
        if (meta[index]?.w !== w || meta[index]?.h !== h) continue;
        decodedRgba[index] = decodeSubImage(meta[index], decoded.subs[index]).rgba;
      }
      applyMaterialCutout(meta, decodedRgba);
    }
  }
  return new Response(encodePng(w, h, pixels, { channels, level: SERVED_PNG_LEVEL }) as unknown as BodyInit, {
    headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
  });
}

async function serveWav(c: VersionCtx, i: number): Promise<Response> {
  const raw = await rawObject(c, 8, i);
  const { codec, ch } = parseAudioHeader(raw);   // codec is the NAME ('qoa'|'bslpc'|'opus')
  let pcm;
  if (codec === 'qoa') pcm = decodeQoa(raw);
  else if (codec === 'bslpc') pcm = decodeType00(raw);
  else pcm = await decodeOpus(raw);
  return new Response(encodeWav(pcm, ch, rateForCodec(codec)), {
    headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' },
  });
}

sw.addEventListener('fetch', (event: any) => {
  const m = new URL(event.request.url).pathname.match(
    /\/cs\/([0-9a-f]{16})\/(?:images\/(\d{5})_e(\d+)\.png|audio\/(\d{5})\.wav)$/);
  if (!m || event.request.method !== 'GET') return;   // not ours: passthrough
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    try {
      const c = await ctx(m[1]);
      const res = m[2] !== undefined
        ? await servePng(c, parseInt(m[2], 10), parseInt(m[3], 10))
        : await serveWav(c, parseInt(m[4], 10));
      // Respond immediately; persist the copy in the background (waitUntil,
      // called while the fetch event is still active). Racing puts for the
      // same URL write identical bytes, so last-write-wins is harmless.
      const copy = res.clone();
      event.waitUntil((async () => {
        const body = await copy.arrayBuffer();
        if (body.byteLength <= CACHE_MAX_BYTES) {
          await cache.put(event.request, new Response(body, { headers: res.headers }));
        }
      })().catch(() => {}));
      return res;
    } catch (err) {
      return new Response(`decode failed: ${err.message}`, { status: 500 });
    }
  })());
});
