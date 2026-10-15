// The game frame's bake off the page's thread (all rooms: a joined cell's parts run to thousands of instances).
// It runs the bake's own arithmetic (game-geometry.ts bakeArraysSteps), so its bytes are the page's.
//
// Protocol (page -> worker): { id, meshes: [{ id, mesh }] (decoded meshes the worker keeps, sent once),
//   once: [DecodedMesh] (meshes used by this job alone), instances: [{ mesh, once, matrix, tint, recolours,
//   uvAffine, vertexTints, slot }], options }
// (worker -> page): { id, ok: true, arrays } (buffers transferred) or { id, ok: false, error }
import * as THREE from '../../../vendor/three.module.js';
import { bakeArraysSteps, type BakedArrays, type DecodedMesh } from './game-geometry.js';

const kept = new Map<number, DecodedMesh>();

self.onmessage = (event: MessageEvent) => {
  const { id, meshes, once, instances, options } = event.data;
  try {
    for (const entry of meshes) kept.set(entry.id, entry.mesh);
    const decoded: DecodedMesh[] = instances.map((i: any) => (i.once ? once[i.mesh] : kept.get(i.mesh)));
    if (decoded.some((m) => !m)) throw new Error('game bake: a mesh the worker was never sent');
    const placements = instances.map((i: any) => ({
      matrix: new THREE.Matrix4().fromArray(i.matrix), tint: i.tint, recolours: i.recolours,
      uvAffine: i.uvAffine, vertexTints: i.vertexTints, slot: i.slot, layer: i.layer, specular: i.specular, opacity: i.opacity, tie: i.tie,
    }));
    const steps = bakeArraysSteps(decoded, placements, options);
    let step = steps.next();
    while (!step.done) step = steps.next();
    const arrays: BakedArrays = step.value;
    const buffers = [arrays.index, arrays.pos, arrays.nrm, arrays.tan, arrays.uv, arrays.spec, arrays.col, arrays.sty,
      arrays.tints0, arrays.tints1, arrays.win, arrays.centre, arrays.slots, arrays.bones, arrays.weights, arrays.layers, arrays.ties]
      .filter((a): a is NonNullable<typeof a> => !!a).map((a) => a.buffer);
    (self as any).postMessage({ id, ok: true, arrays }, buffers);
  } catch (error: any) {
    (self as any).postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
};
