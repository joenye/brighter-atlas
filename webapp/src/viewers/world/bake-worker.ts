// Merged-bake worker: bakes one merged-world bucket (see merged.ts) off the
// main thread. The loop in bakeBucket() is a VERBATIM port of
// MergedWorld._bakeBucketArrays — same operations in the same order with the
// same float64 intermediates and float32/int8 stores — so a bucket's output
// is BYTE-IDENTICAL to the main-thread path (tools/smoke.ts byte-compares
// the two paths as a permanent regression gate). THREE is deliberately NOT
// imported: the two helpers the loop relies on (Matrix4.fromArray element
// reads, Matrix3.getNormalMatrix = setFromMatrix4().invert().transpose())
// are inlined below with the vendored implementation's exact arithmetic.
// If the bake loop in merged.ts changes, this port MUST change in lockstep.
//
// Protocol (main -> worker), one message per bucket job:
//   { type:'job', id, generation, tangent, originX, originY, vertexCount,
//     indexCount, evict:[meshId…], meshes:[{id, positions, normals, uvs,
//     tangents, index}…], items:[{mesh, count, instanceArray, roomX, roomY,
//     metaZ, metaBits, palette}…] }
// (worker -> main):
//   { type:'result', id, generation, ok:true, arrays }   (buffers transferred)
//   { type:'result', id, generation, ok:false, error }
//
// Source mesh attribute arrays arrive ONCE per worker and are cached here by
// mesh id. ALL cache policy (LRU recency, the byte cap, evictions) lives on
// the main thread (bake-pool.ts), which drives this side via `evict` — the
// worker never decides evictions itself, so the two bookkeeping maps can
// never disagree about what is resident.

export interface BakeBucketArrays {
  positions: Float32Array;
  normals: Int8Array;
  uvs: Float32Array;
  tangents: Int8Array | null;
  metas: Uint8Array;
  recolors: Uint16Array;
  indices: Uint32Array;
  bounds: Float64Array;   // [minX, minY, minZ, maxX, maxY, maxZ]
}

export interface BakeJobMesh {
  id: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  tangents: Float32Array | null;
  index: Uint16Array | Uint32Array;
}

export interface BakeJobItem {
  mesh: number;
  count: number;
  instanceArray: Float32Array;
  roomX: number;
  roomY: number;
  metaZ: number;
  metaBits: number;
  palette: number;
}

export interface BakeJobMessage {
  type: 'job';
  id: number;
  generation: number;
  tangent: boolean;
  originX: number;
  originY: number;
  vertexCount: number;
  indexCount: number;
  evict: number[];
  meshes: BakeJobMesh[];
  items: BakeJobItem[];
}

export interface BakeResultMessage {
  type: 'result';
  id: number;
  generation: number;
  ok: boolean;
  error?: string;
  arrays?: BakeBucketArrays;
}

const ctx = self as any;   // worker globals (the program is typed with the DOM lib)

const meshCache = new Map<number, BakeJobMesh>();

function bakeBucket(msg: BakeJobMessage): BakeBucketArrays {
  const vertexCount = msg.vertexCount;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Int8Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tangents = msg.tangent ? new Int8Array(vertexCount * 4) : null;
  const metas = new Uint8Array(vertexCount * 2);
  const recolors = new Uint16Array(vertexCount);
  const indices = new Uint32Array(msg.indexCount);
  const originX = msg.originX;
  const originY = msg.originY;

  let vertexBase = 0;
  let indexBase = 0;
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;

  for (const item of msg.items) {
    const mesh = meshCache.get(item.mesh);
    if (!mesh) throw new Error(`bake mesh ${item.mesh} is not cached`);
    const sourcePositions = mesh.positions;
    const sourceNormals = mesh.normals;
    const sourceUvs = mesh.uvs;
    const sourceTangents = msg.tangent ? mesh.tangents : null;
    const sourceIndex = mesh.index;
    const vertsPerInstance = sourcePositions.length / 3;
    const indicesPerInstance = sourceIndex.length;
    const instances = item.instanceArray;
    for (let instance = 0; instance < item.count; instance++) {
      // Matrix4.fromArray: float32 element reads widened to float64, exactly
      // like matrix.elements after fromArray on the main thread.
      const base = instance * 16;
      const e0 = instances[base]; const e1 = instances[base + 1]; const e2 = instances[base + 2];
      const e4 = instances[base + 4]; const e5 = instances[base + 5]; const e6 = instances[base + 6];
      const e8 = instances[base + 8]; const e9 = instances[base + 9]; const e10 = instances[base + 10];
      const tx = instances[base + 12] + item.roomX;
      const ty = instances[base + 13] + item.roomY;
      const tz = instances[base + 14];
      // Matrix3.getNormalMatrix(matrix) verbatim: setFromMatrix4's upper-left
      // picks, invert()'s cofactor expressions in source order, and the final
      // transpose baked into the n0..n8 names (n1 <- inverse[3], n3 <-
      // inverse[1], …) so n0..n8 read exactly like normalMatrix.elements.
      const t11 = e10 * e5 - e6 * e9;
      const t12 = e6 * e8 - e10 * e4;
      const t13 = e9 * e4 - e5 * e8;
      const det = e0 * t11 + e1 * t12 + e2 * t13;
      let n0 = 0; let n1 = 0; let n2 = 0;
      let n3 = 0; let n4 = 0; let n5 = 0;
      let n6 = 0; let n7 = 0; let n8 = 0;
      if (det !== 0) {   // det===0 leaves the zero matrix, like THREE's set(0,…)
        const detInv = 1 / det;
        n0 = t11 * detInv;
        n3 = (e2 * e9 - e10 * e1) * detInv;
        n6 = (e6 * e1 - e2 * e5) * detInv;
        n1 = t12 * detInv;
        n4 = (e10 * e0 - e2 * e8) * detInv;
        n7 = (e2 * e4 - e6 * e0) * detInv;
        n2 = t13 * detInv;
        n5 = (e1 * e8 - e9 * e0) * detInv;
        n8 = (e5 * e0 - e1 * e4) * detInv;
      }
      for (let v = 0; v < vertsPerInstance; v++) {
        const sx = sourcePositions[v * 3];
        const sy = sourcePositions[v * 3 + 1];
        const sz = sourcePositions[v * 3 + 2];
        const px = e0 * sx + e4 * sy + e8 * sz + tx - originX;
        const py = e1 * sx + e5 * sy + e9 * sz + ty - originY;
        const pz = e2 * sx + e6 * sy + e10 * sz + tz;
        const at = (vertexBase + v) * 3;
        positions[at] = px; positions[at + 1] = py; positions[at + 2] = pz;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;

        const nx0 = sourceNormals[v * 3];
        const ny0 = sourceNormals[v * 3 + 1];
        const nz0 = sourceNormals[v * 3 + 2];
        const nx = n0 * nx0 + n3 * ny0 + n6 * nz0;
        const ny = n1 * nx0 + n4 * ny0 + n7 * nz0;
        const nz = n2 * nx0 + n5 * ny0 + n8 * nz0;
        // 1/sqrt normalization (Math.hypot is ~10x slower and this loop
        // runs per vertex, tens of millions of times per bake)
        const nLenSq = nx * nx + ny * ny + nz * nz;
        const nInv = nLenSq > 0 ? 127 / Math.sqrt(nLenSq) : 127;
        normals[at] = Math.round(nx * nInv);
        normals[at + 1] = Math.round(ny * nInv);
        normals[at + 2] = Math.round(nz * nInv);

        uvs[(vertexBase + v) * 2] = sourceUvs[v * 2];
        uvs[(vertexBase + v) * 2 + 1] = sourceUvs[v * 2 + 1];

        if (tangents) {
          const tx0 = sourceTangents![v * 4];
          const ty0 = sourceTangents![v * 4 + 1];
          const tz0 = sourceTangents![v * 4 + 2];
          const ax = e0 * tx0 + e4 * ty0 + e8 * tz0;
          const ay = e1 * tx0 + e5 * ty0 + e9 * tz0;
          const az = e2 * tx0 + e6 * ty0 + e10 * tz0;
          const tLenSq = ax * ax + ay * ay + az * az;
          const tInv = tLenSq > 0 ? 127 / Math.sqrt(tLenSq) : 127;
          const ta = (vertexBase + v) * 4;
          tangents[ta] = Math.round(ax * tInv);
          tangents[ta + 1] = Math.round(ay * tInv);
          tangents[ta + 2] = Math.round(az * tInv);
          tangents[ta + 3] = Math.round((sourceTangents![v * 4 + 3] || 1) * 127);
        }
      }
      metas.fill(item.metaZ, vertexBase * 2, (vertexBase + vertsPerInstance) * 2);
      for (let v = 0; v < vertsPerInstance; v++) {
        metas[(vertexBase + v) * 2 + 1] = item.metaBits;
      }
      recolors.fill(item.palette, vertexBase, vertexBase + vertsPerInstance);

      // Winding is copied verbatim: a negative-determinant local matrix
      // flips screen winding identically in the per-room instanced path.
      for (let i = 0; i < indicesPerInstance; i++) {
        indices[indexBase + i] = vertexBase + sourceIndex[i];
      }
      vertexBase += vertsPerInstance;
      indexBase += indicesPerInstance;
    }
  }

  return {
    positions, normals, uvs, tangents, metas, recolors, indices,
    bounds: Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ),
  };
}

ctx.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as BakeJobMessage;
  if (!msg || msg.type !== 'job') return;
  try {
    // Main-driven cache maintenance: evictions first, then the new entries.
    for (const id of msg.evict) meshCache.delete(id);
    for (const mesh of msg.meshes) meshCache.set(mesh.id, mesh);
    const arrays = bakeBucket(msg);
    const transfers: Transferable[] = [
      arrays.positions.buffer, arrays.normals.buffer, arrays.uvs.buffer,
      arrays.metas.buffer, arrays.recolors.buffer, arrays.indices.buffer,
      arrays.bounds.buffer,
    ];
    if (arrays.tangents) transfers.push(arrays.tangents.buffer);
    const reply: BakeResultMessage = {
      type: 'result', id: msg.id, generation: msg.generation, ok: true, arrays,
    };
    ctx.postMessage(reply, transfers);
  } catch (error: any) {
    const reply: BakeResultMessage = {
      type: 'result', id: msg.id, generation: msg.generation, ok: false,
      error: String(error?.message || error),
    };
    ctx.postMessage(reply);
  }
};
