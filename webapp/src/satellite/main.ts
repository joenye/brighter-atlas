// The satellite stills page (satellite.html): a SatelliteHarness over a World
// extraction stored in this browser, driven from a script through
// window.__satellite. `?build=<hash16>` picks the stored version of that
// build (the first 16 hex of its assetBundle0's sha256); without it, the
// active version.
//
//   await __satellite.ready        -> { build, buildString, label, renderer, codeKey, rooms }
//                                     or { missing: true, builds } when the build is not stored
//   __satellite.builds()           -> the builds stored in this browser
//   __satellite.rooms()            -> SatelliteRoom[]
//   __satellite.know(fingerprints) -> stills already held elsewhere (not drawn again)
//   await __satellite.still(roomId, settings)
//                                  -> StillResult with `png` (base64), or `known: true`
//   await __satellite.explain(roomId) -> the room's meshes, a digest per payload field
//   await __satellite.explainCut(roomId) -> what roofs off leaves out of the room
//   await __satellite.forget(hash16) -> removes that build's stored version
//
// The page draws nothing on screen: every still is drawn offscreen by the
// game's frame and handed over as a PNG.
import { createStore } from '../client-store.js';
import { deleteVersion, gcRaw, getActiveVersionId, listVersions, setActiveVersionId, type VersionRecord } from '../storage.js';
import { SatelliteHarness, DEFAULT_STILL, type StillSettings } from './harness.js';
import { sha256 } from './fingerprint.js';

const status = document.getElementById('satellite-status')!;
const say = (text: string) => { status.textContent = text; };
const buildOf = (v: VersionRecord) => v.ab0RawSha256?.slice(0, 16) ?? null;

async function builds() {
  return (await listVersions()).map((v) => ({ build: buildOf(v), buildString: v.buildString ?? null, label: v.profileLabel ?? v.label ?? null, versionId: v.versionId }));
}

async function pngBase64(canvas: HTMLCanvasElement, rgba: Uint8Array, width: number, height: number): Promise<string> {
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the still could not be encoded');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

async function start() {
  const api: Record<string, unknown> = {
    builds,
    async forget(build: string) {
      const v = (await listVersions()).find((x) => buildOf(x) === build);
      if (!v) return false;
      await deleteVersion(v.versionId);
      await gcRaw();
      return true;
    },
  };
  Object.assign((window as any).__satellite, api);
  // the build asked for, made the active version
  const wanted = new URLSearchParams(location.search).get('build');
  if (wanted) {
    const v = (await listVersions()).find((x) => buildOf(x) === wanted);
    if (!v) { say(`Build ${wanted} is not stored in this browser.`); return { missing: true, builds: await builds() }; }
    if ((await getActiveVersionId()) !== v.versionId) await setActiveVersionId(v.versionId);
  }
  const store = await createStore();
  const version = (store as any).versionId as string | undefined;
  const record = (await listVersions()).find((x) => x.versionId === version);
  if (!version || !record) { say('No extraction is stored in this browser.'); return { missing: true, builds: await builds() }; }
  const gl = document.createElement('canvas').getContext('webgl2', { antialias: false, alpha: false, depth: true, preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL 2 is not available');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  // the drawing code's identity: this bundle's own bytes
  const codeKey = await sha256(await (await fetch(import.meta.url)).text());
  const harness = await SatelliteHarness.open(store, gl, codeKey);
  const known = new Set<string>();
  const encoder = document.createElement('canvas');
  Object.assign((window as any).__satellite, {
    defaults: DEFAULT_STILL,
    rooms: () => harness.rooms(),
    know(fingerprints: string[]) { for (const f of fingerprints) known.add(f); return known.size; },
    async still(roomId: number, settings: Partial<StillSettings> = {}) {
      const result = await harness.still(roomId, settings, (f) => known.has(f));
      const { rgba, ...rest } = result;
      if (!rgba) return { ...rest, known: true };
      const t = performance.now();
      const png = await pngBase64(encoder, rgba, result.width, result.height);
      rest.timings.encode = Math.round(performance.now() - t);
      return { ...rest, known: false, png };
    },
    explain: (roomId: number, settings: Partial<StillSettings> = {}) => harness.explain(roomId, settings),
    explainCut: (roomId: number) => harness.explainCut(roomId),
    release: () => harness.release(),
  });
  say(`Ready: ${harness.rooms().length} rooms of build ${record.profileLabel ?? record.label ?? version}, drawing on ${renderer}.`);
  return { build: buildOf(record), buildString: record.buildString ?? null, label: record.profileLabel ?? record.label ?? null,
    renderer, codeKey, rooms: harness.rooms().length };
}

(window as any).__satellite = {};
const ready = start();
(window as any).__satellite.ready = ready;
ready.catch((error) => say(`Unavailable: ${(error as Error).message}`));
