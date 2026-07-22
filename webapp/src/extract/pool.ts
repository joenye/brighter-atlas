// poolMap: run per-object index jobs across CPU cores when the environment
// allows (nested Workers: Chrome/Firefox/Safari 15+), falling back to the
// exact same jobs.js code inline otherwise (node tests, old browsers).
//
// One worker fleet serves ALL pooled passes of an ingest: workers spawn
// lazily at the first pooled poolMap and are torn down by shutdownPool()
// (ingest end/error/abort). Jobs dispatch as contiguous chunks pulled from a
// shared cursor, so one heavy stretch of the bundle levels out across the
// fleet instead of becoming a single worker's long pole. Results land in the
// results array by ABSOLUTE job index, preserving entry order and the
// { i, err } failure shape exactly.

import { makeSlabReader } from './bundles.js';
import { runIndexJob } from './jobs.js';
import { hashBlob, HASH_ONE_SHOT } from './hash.js';

interface PoolJob { i: number; offset: number; length: number; extra?: any }

export function poolSize(): number {
  if (typeof Worker !== 'function') return 1;
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  // capped: each worker slabs 16 MB (cap 8 matches the viewers' own worker
  // fan-outs; only machines with >8 hardware threads go above the old 6)
  return Math.max(1, Math.min(hc - 1, 8));
}

// jobs per dispatch: small enough to level-load across workers, large
// enough to amortize the postMessage round-trip and keep reads slab-friendly
const CHUNK_JOBS = 128;

// ---- worker fleet -----------------------------------------------------------

let fleet: Worker[] = [];
let fleetLock: Promise<void> = Promise.resolve(); // passes serialize on the fleet
let passSeq = 0; // stamps every chunk so a stale reply from a failed pass is ignored

function workerUrl(): URL {
  // This module is bundled into BOTH js/main.js and js/extract/worker.js
  // (different depths), so anchor on the js/ root rather than a relative hop.
  return new URL(import.meta.url.replace(/\/js\/.*$/, '/js/extract/pool-worker.js'));
}

function ensureFleet(count: number): Worker[] {
  while (fleet.length < count) {
    fleet.push(new Worker(workerUrl(), { type: 'module' })); // throws -> caller falls back inline
  }
  return fleet.slice(0, count);
}

// A worker that errored is in an unknown state: terminate it and let the
// next pass spawn a replacement, so one bad pass cannot poison later passes.
function dropWorker(worker: Worker): void {
  worker.terminate();
  const at = fleet.indexOf(worker);
  if (at >= 0) fleet.splice(at, 1);
}

// Finishers of passes still in flight, so shutdown can settle them: a
// fire-and-forget pass whose consumer threw before awaiting it would
// otherwise never resolve once its workers die, wedging the fleet lock.
const activePasses = new Set<(err: Error) => void>();

// Hard-terminate every pooled worker. Called at ingest end/error/abort: the
// fleet must never outlive its ingest. Safe to call repeatedly / when empty.
export function shutdownPool(): void {
  for (const w of fleet) w.terminate();
  fleet = [];
  for (const finish of [...activePasses]) finish(new Error('cancelled'));
}

// file: Blob/File; n: bundle index; kind: jobs.js kind; entries: frame entries
// extraFor?: (i) => small cloneable extra for jobs that need one
// -> results array in entry order ({ i, err } for failed objects)
export async function poolMap({ file, n, kind, entries, extraFor, onProgress, signal }: {
  file: Blob;
  n: number;
  kind: string;
  entries: { offset: number; length: number }[];
  extraFor?: (i: number) => any;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<any[]> {
  const total = entries.length;
  const jobs: PoolJob[] = entries.map((e, i) => ({
    i, offset: e.offset, length: e.length, ...(extraFor ? { extra: extraFor(i) } : {}),
  }));
  const workers = total >= 256 ? poolSize() : 1;   // pooling tiny passes costs more than it saves

  if (workers > 1) {
    try {
      return await pooled({ file, n, kind, jobs, workers, onProgress, signal });
    } catch (err) {
      if (signal?.aborted || err.message === 'cancelled') throw new Error('cancelled');
      // nested workers unavailable / worker died: same jobs, inline
    }
  }

  const read = makeSlabReader(file);
  const results = new Array(total);
  for (let k = 0; k < total; k++) {
    if (signal?.aborted) throw new Error('cancelled');
    const j = jobs[k];
    try {
      results[k] = await runIndexJob(kind, n, j.i, await read(j), j.extra);
    } catch (err) {
      results[k] = { i: j.i, err: err.message };
    }
    if (k % 50 === 0 || k === total - 1) onProgress?.(k + 1, total);
  }
  return results;
}

async function pooled({ file, n, kind, jobs, workers, onProgress, signal }: {
  file: Blob;
  n: number;
  kind: string;
  jobs: PoolJob[];
  workers: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<any[]> {
  const total = jobs.length;
  const results = new Array(total);
  const fleetWorkers = ensureFleet(workers);
  // Serialize passes on the shared fleet: message handlers are per-pass.
  const prev = fleetLock;
  let release!: () => void;
  fleetLock = new Promise((r) => { release = r; });
  await prev;
  const pass = ++passSeq;
  try {
    if (signal?.aborted) throw new Error('cancelled');
    await new Promise<void>((resolve, reject) => {
      let cursor = 0;    // shared job cursor: workers pull the next chunk when done
      let completed = 0; // jobs whose results have landed
      let active = 0;    // chunks in flight
      let settled = false;
      const inflight = new Map<Worker, number>(); // partial progress of the current chunk
      const report = () => {
        let done = completed;
        for (const d of inflight.values()) done += d;
        onProgress?.(done, total);
      };
      const onAbort = () => { shutdownPool(); finish(new Error('cancelled')); };
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        activePasses.delete(finish);
        signal?.removeEventListener('abort', onAbort);
        for (const w of fleetWorkers) { w.onmessage = null; w.onerror = null; }
        if (err) reject(err); else resolve();
      };
      activePasses.add(finish);
      const feed = (worker: Worker) => {
        if (settled) return;
        if (cursor >= total) {
          if (active === 0) finish();
          return;
        }
        const base = cursor;
        const chunk = jobs.slice(base, Math.min(base + CHUNK_JOBS, total));
        cursor += chunk.length;
        active++;
        inflight.set(worker, 0);
        worker.postMessage({ pass, base, file, n, kind, jobs: chunk });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      for (const worker of fleetWorkers) {
        worker.onerror = (ev) => {
          dropWorker(worker);
          finish(new Error(`pool worker: ${ev.message || 'error'}`));
        };
        worker.onmessage = (ev) => {
          const msg = ev.data;
          if (msg.pass !== pass) return; // stale chunk from an earlier failed pass
          if (msg.type === 'progress') { inflight.set(worker, msg.done); report(); return; }
          // absolute-index write-back preserves entry order across chunks
          for (let k = 0; k < msg.results.length; k++) results[msg.base + k] = msg.results[k];
          completed += msg.results.length;
          inflight.delete(worker);
          active--;
          report();
          feed(worker);
        };
      }
      for (const worker of fleetWorkers) feed(worker);
    });
  } finally {
    release();
  }
  return results;
}

// Whole-blob sha256 without serializing the ingest thread: blobs above the
// native one-shot ceiling stream through the JS SHA-256 in a dedicated
// short-lived worker (a Blob posts as a cheap handle; the digest is identical
// wherever it is computed). Small blobs and worker-less environments hash
// inline exactly as before.
export async function poolHashBlob(
  blob: Blob, onProgress?: (done: number, total: number) => void, signal?: AbortSignal,
): Promise<string> {
  if (blob.size <= HASH_ONE_SHOT || typeof Worker !== 'function') return hashBlob(blob, onProgress);
  let worker: Worker | null = null;
  let onAbort: (() => void) | null = null;
  try {
    return await new Promise<string>((resolve, reject) => {
      try { worker = new Worker(workerUrl(), { type: 'module' }); } catch (err) { reject(err); return; }
      onAbort = () => reject(new Error('cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.onerror = (ev) => reject(new Error(`pool worker: ${ev.message || 'error'}`));
      worker.onmessage = (ev) => {
        if (ev.data.type === 'progress') { onProgress?.(ev.data.done, ev.data.total); return; }
        if (ev.data.type === 'error') reject(new Error(ev.data.message));
        else resolve(ev.data.sha);
      };
      worker.postMessage({ kind: 'blobhash', file: blob });
    });
  } catch (err) {
    if (signal?.aborted || err?.message === 'cancelled') throw new Error('cancelled');
    return hashBlob(blob, onProgress); // same bytes, same digest: inline fallback
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    (worker as Worker | null)?.terminate();
  }
}
