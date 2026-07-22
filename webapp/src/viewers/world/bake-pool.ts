// Main-thread side of the merged-bake worker pool. MergedWorld.build() fans
// per-bucket bake jobs across the pool; the workers run the byte-identical
// port of the bucket math (bake-worker.ts) and return the merged buffers as
// transferables. The pool lives for exactly one bake (build() disposes it in
// its finally, and MergedWorld.dispose() sweeps a live one), so a cancelled
// or destroyed bake never leaves threads behind.
//
// Job promises always RESOLVE (never reject) with a BakeJobOutcome; failed or
// cancelled jobs resolve { ok:false }, so a torn-down bake can never surface
// an unhandled rejection. Replies are matched by job id and stamped with the
// bake generation: a stale or post-dispose reply is dropped on the floor.
//
// Mesh attribute arrays are sent to each worker at most once and cached
// worker-side by mesh id. The cache policy is driven entirely from HERE:
// per-worker Map bookkeeping (insertion order = LRU recency, refreshed on
// reuse) with a total-bytes cap, evictions shipped inside the next job's
// `evict` list. The worker never evicts on its own, so both sides always
// agree on residency.

import type {
  BakeBucketArrays, BakeJobMesh, BakeJobMessage, BakeResultMessage,
} from './bake-worker.js';
import type { MergedBucketDef } from './merged.js';

export interface BakeJobOutcome {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  arrays?: BakeBucketArrays;
}

// Per-worker cap on cached source mesh bytes. Meshes repeat heavily across
// buckets, so the cache is what makes "send once per worker" hold; the cap
// bounds worst-case worker heap on huge worlds (LRU eviction past it).
const WORKER_CACHE_CAP_BYTES = 192 * 1024 * 1024;

interface PoolWorker {
  worker: Worker;
  cache: Map<number, number>;   // meshId -> bytes; insertion order = LRU
  cacheBytes: number;
  job: PendingJob | null;
  dead: boolean;
}

interface PendingJob {
  id: number;
  generation: number;
  bucket: MergedBucketDef;
  originX: number;
  originY: number;
  resolve: (outcome: BakeJobOutcome) => void;
  onSettled: ((outcome: BakeJobOutcome) => void) | null;
}

export class MergedBakePool {
  size: number;
  _workers: PoolWorker[];
  _queue: PendingJob[];
  _jobs: Map<number, PendingJob>;
  _meshIds: WeakMap<object, number>;
  _nextMeshId: number;
  _nextJobId: number;
  _disposed: boolean;

  /** Spawn a pool of `size` workers, or null when workers are unavailable. */
  static spawn(size: number): MergedBakePool | null {
    try {
      return new MergedBakePool(size);
    } catch {
      return null;   // CSP / no Worker / spawn failure -> main-thread bake
    }
  }

  constructor(size: number) {
    this.size = Math.max(1, size);
    this._workers = [];
    this._queue = [];
    this._jobs = new Map();
    this._meshIds = new WeakMap();
    this._nextMeshId = 1;
    this._nextJobId = 1;
    this._disposed = false;
    try {
      for (let index = 0; index < this.size; index++) {
        // Bundle-relative like fit-worker: this code ships inside js/main.js
        // and the worker entry is emitted at js/viewers/world/bake-worker.js
        // (tools/build.ts).
        const worker = new Worker(
          new URL('./viewers/world/bake-worker.js', import.meta.url),
          { type: 'module' },
        );
        const entry: PoolWorker = {
          worker, cache: new Map(), cacheBytes: 0, job: null, dead: false,
        };
        worker.onmessage = (ev: MessageEvent) => this._onResult(entry, ev.data);
        worker.onerror = () => this._onWorkerDead(entry, 'bake worker error');
        worker.onmessageerror = () => this._onWorkerDead(entry, 'bake worker message error');
        this._workers.push(entry);
      }
    } catch (error) {
      for (const entry of this._workers) {
        try { entry.worker.terminate(); } catch { /* already dead */ }
      }
      throw error;
    }
  }

  /**
   * Queue one bucket bake. `onSettled` fires when the outcome arrives (in
   * completion order, unlike the returned promise which the caller awaits in
   * bucket order): build() uses it for aggregate progress.
   */
  submit(
    bucket: MergedBucketDef,
    cellUnits: number,
    generation: number,
    onSettled: ((outcome: BakeJobOutcome) => void) | null = null,
  ): Promise<BakeJobOutcome> {
    return new Promise((resolve) => {
      const job: PendingJob = {
        id: this._nextJobId++,
        generation,
        bucket,
        originX: bucket.cellX * cellUnits,
        originY: bucket.cellY * cellUnits,
        resolve,
        onSettled,
      };
      if (this._disposed) {
        this._settle(job, { ok: false, cancelled: true, error: 'bake pool disposed' });
        return;
      }
      if (this._workers.every((entry) => entry.dead)) {
        this._settle(job, { ok: false, error: 'bake workers unavailable' });
        return;
      }
      this._queue.push(job);
      this._pump();
    });
  }

  _settle(job: PendingJob, outcome: BakeJobOutcome): void {
    job.resolve(outcome);
    try { job.onSettled?.(outcome); } catch { /* caller callback */ }
  }

  _pump(): void {
    if (this._disposed) return;
    for (const entry of this._workers) {
      if (!this._queue.length) return;
      if (entry.dead || entry.job) continue;
      const job = this._queue.shift()!;
      entry.job = job;
      this._jobs.set(job.id, job);
      try {
        entry.worker.postMessage(this._buildJobMessage(entry, job));
      } catch (error: any) {
        // Payload build/serialize failed: this bucket falls back to the
        // main-thread bake; the pool keeps serving the rest.
        entry.job = null;
        this._jobs.delete(job.id);
        this._settle(job, { ok: false, error: String(error?.message || error) });
      }
    }
  }

  _buildJobMessage(entry: PoolWorker, job: PendingJob): BakeJobMessage {
    const bucket = job.bucket;
    const items: BakeJobMessage['items'] = [];
    const meshes: BakeJobMesh[] = [];
    const jobMeshIds = new Set<number>();
    for (const item of bucket.items!) {
      const geometry: any = item.geometry;
      let id = this._meshIds.get(geometry);
      if (id === undefined) {
        id = this._nextMeshId++;
        this._meshIds.set(geometry, id);
      }
      if (!jobMeshIds.has(id)) {
        jobMeshIds.add(id);
        const cachedBytes = entry.cache.get(id);
        if (cachedBytes !== undefined) {
          entry.cache.delete(id);          // refresh LRU recency
          entry.cache.set(id, cachedBytes);
        } else {
          const positions = geometry.attributes.position.array as Float32Array;
          const normals = geometry.attributes.normal.array as Float32Array;
          const uvs = geometry.attributes.uv.array as Float32Array;
          // Always ship tangents when the geometry has them: a later
          // tangent-layout bucket may reuse this cache entry.
          const tangents = geometry.attributes.tangent
            ? geometry.attributes.tangent.array as Float32Array : null;
          const index = geometry.index.array as Uint16Array | Uint32Array;
          const bytes = positions.byteLength + normals.byteLength + uvs.byteLength
            + (tangents ? tangents.byteLength : 0) + index.byteLength;
          meshes.push({ id, positions, normals, uvs, tangents, index });
          entry.cache.set(id, bytes);
          entry.cacheBytes += bytes;
        }
      }
      items.push({
        mesh: id,
        count: item.count,
        instanceArray: item.instanceArray as Float32Array,
        roomX: item.roomX,
        roomY: item.roomY,
        metaZ: item.metaZ,
        metaBits: item.metaBits,
        palette: item.palette,
      });
    }
    // LRU-evict down to the cap, never a mesh THIS job needs (if one job's
    // meshes alone exceed the cap, the cap is soft for that job).
    const evict: number[] = [];
    if (entry.cacheBytes > WORKER_CACHE_CAP_BYTES) {
      for (const [id, bytes] of entry.cache) {
        if (entry.cacheBytes <= WORKER_CACHE_CAP_BYTES) break;
        if (jobMeshIds.has(id)) continue;
        entry.cache.delete(id);
        entry.cacheBytes -= bytes;
        evict.push(id);
      }
    }
    return {
      type: 'job',
      id: job.id,
      generation: job.generation,
      tangent: bucket.tangent,
      originX: job.originX,
      originY: job.originY,
      vertexCount: bucket.vertices,
      indexCount: bucket.indices,
      evict,
      meshes,
      items,
    };
  }

  _onResult(entry: PoolWorker, data: BakeResultMessage): void {
    if (this._disposed || !data || data.type !== 'result') return;
    const job = this._jobs.get(data.id);
    if (!job) return;   // stale reply (already settled / superseded)
    this._jobs.delete(data.id);
    if (entry.job === job) entry.job = null;
    // Generation stamp: a reply minted for a superseded bake never reaches
    // its caller as a success (belt-and-braces: the pool is per-bake).
    const outcome: BakeJobOutcome = data.ok && data.generation === job.generation && data.arrays
      ? { ok: true, arrays: data.arrays }
      : { ok: false, error: data.error || 'stale bake generation' };
    this._settle(job, outcome);
    this._pump();
  }

  _onWorkerDead(entry: PoolWorker, message: string): void {
    if (this._disposed || entry.dead) return;
    entry.dead = true;
    try { entry.worker.terminate(); } catch { /* already dead */ }
    const job = entry.job;
    entry.job = null;
    if (job) {
      this._jobs.delete(job.id);
      this._settle(job, { ok: false, error: message });
    }
    if (this._workers.every((other) => other.dead)) {
      const queued = this._queue.splice(0);
      for (const orphan of queued) this._settle(orphan, { ok: false, error: message });
    } else {
      this._pump();
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const entry of this._workers) {
      try { entry.worker.terminate(); } catch { /* already dead */ }
      entry.dead = true;
      entry.job = null;
      entry.cache.clear();
    }
    const pending = [...this._jobs.values(), ...this._queue];
    this._jobs.clear();
    this._queue.length = 0;
    for (const job of pending) {
      this._settle(job, { ok: false, cancelled: true, error: 'bake cancelled' });
    }
  }
}

export default MergedBakePool;
