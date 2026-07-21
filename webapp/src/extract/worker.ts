// Ingest worker: a thin postMessage wrapper around ingest.js with the real
// browser storage sink. Spawn with new Worker('js/extract/worker.js', {type:'module'}).
//
//   main -> worker: { type:'ingest', files:{n:File}, cats:[...], label? }
//                   { type:'cancel' }
//   worker -> main: { type:'progress', ...ev } | { type:'done', result } |
//                   { type:'error', message }

import { runIngest } from './ingest.js';
import {
  hasRaw, writeRaw, derivedGet, derivedPut, derivedPutMany, putVersion, getVersion, setActiveVersionId,
} from '../storage.js';


const ctx = self as any;

const sink = {
  hasRaw,       // OPFS with IDB-blob fallback (storage.js owns the split)
  writeRaw,
  derivedGet,
  derivedPut,
  derivedPutMany,   // batched finalize/shard writes (one transaction each)
  putVersion,
  getVersion,
  setActive: setActiveVersionId,
};

let aborter: AbortController | null = null;

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'cancel') { aborter?.abort(); return; }
  if (msg.type !== 'ingest') return;
  aborter = new AbortController();
  try {
    const result = await runIngest({
      files: msg.files,
      cats: msg.cats,
      label: msg.label,
      systemCatalog: msg.systemCatalog,
      sink,
      signal: aborter.signal,
      onProgress: (ev) => ctx.postMessage({ type: 'progress', ...ev }),
    });
    ctx.postMessage({ type: 'done', result });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
