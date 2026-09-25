// Maps worker: runs the 2D map extraction off the ingest thread, so it can
// run while the World category finishes. Spawned by ingest.js from inside the
// ingest worker (nested workers).
//
//   ingest -> worker: { ab0, files, frames, profile, includeRoomData }
//   worker -> ingest: { type:'done', result } | { type:'error', message }
import { parseDatatable } from '../datatable.js';
import { extractMaps } from './index.js';

const ctx = self as any;

ctx.onmessage = async (e: MessageEvent) => {
  const { ab0, files, frames, profile, includeRoomData } = e.data;
  try {
    const result = await extractMaps({ ab0, dt: parseDatatable(ab0), files, frames,
      fetchJson: async () => profile, includeRoomData });
    ctx.postMessage({ type: 'done', result });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
