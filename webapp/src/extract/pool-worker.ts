// Index-pool worker: runs chunks of per-object index jobs (jobs.js) against
// its own reads over the bundle File. Spawned by pool.js from inside the
// ingest worker (nested workers) and REUSED across chunks and passes.
//
//   pool -> worker: { pass, base, file, n, kind, jobs: [{ i, offset, length, extra? }] }
//                   { kind:'blobhash', file }         (whole-blob sha256)
//   worker -> pool: { type:'progress', pass, base, done }   (every PROGRESS_EVERY)
//                   { type:'done', pass, base, results }    (per-object results;
//                     a failed object yields { i, err } so the coordinator can
//                     keep its null-entry + error-list semantics)
//   blobhash:       { type:'progress', done, total } then
//                   { type:'done', sha } | { type:'error', message }

import { runIndexJob } from './jobs.js';
import { hashBlob } from './hash.js';


const ctx = self as any;

const PROGRESS_EVERY = 64;

// Chunk-bounded slab reader: like bundles.js makeSlabReader but slabs never
// read past the chunk's last byte. With many small chunks per pass, a plain
// 16 MB slab tail-overshoots on EVERY chunk and multiplies total disk reads.
function chunkSlabReader(
  file: Blob, chunkEnd: number, slabBytes = 16 * 1024 * 1024,
): (entry: { offset: number; length: number }) => Promise<Uint8Array> {
  let start = -1, end = -1, buf: ArrayBuffer | null = null;
  return async ({ offset, length }) => {
    if (offset >= start && offset + length <= end) {
      return new Uint8Array(buf!, offset - start, length);
    }
    if (length > slabBytes) {   // oversized object: direct read
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    }
    start = offset;
    end = Math.min(file.size, chunkEnd, offset + slabBytes);
    buf = await file.slice(start, end).arrayBuffer();
    return new Uint8Array(buf, 0, length);
  };
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.kind === 'blobhash') {
    try {
      const sha = await hashBlob(msg.file, (done: number, total: number) =>
        ctx.postMessage({ type: 'progress', done, total }));
      ctx.postMessage({ type: 'done', sha });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: err?.message || String(err) });
    }
    return;
  }
  const { pass, base, file, n, kind, jobs } = msg;
  const lastJob = jobs[jobs.length - 1];
  const read = chunkSlabReader(file, lastJob.offset + lastJob.length);
  const results = new Array(jobs.length);
  for (let k = 0; k < jobs.length; k++) {
    const j = jobs[k];
    try {
      results[k] = await runIndexJob(kind, n, j.i, await read(j), j.extra);
    } catch (err) {
      results[k] = { i: j.i, err: err.message };
    }
    if ((k + 1) % PROGRESS_EVERY === 0) ctx.postMessage({ type: 'progress', pass, base, done: k + 1 });
  }
  ctx.postMessage({ type: 'done', pass, base, results });
};
