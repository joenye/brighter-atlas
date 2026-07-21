// Session-transient placement edits for the world views: nudge (X/Y in
// tiles, Z in game height layers), quarter-turn rotation about the placement
// anchor, and delete. Edits are keyed by (room, source kind, category,
// placement row) so both display paths — the per-room instanced graph and the
// merged bake — apply the SAME record; they are deliberately never persisted
// (lost on reload) and each view owns its own store.
//
// The transform composition:
//   edited = T(Δ·units) · T(pivot) · Rz(turns·90°) · T(−pivot) · original
// with the pivot at the placement anchor in ROOM-LOCAL native units (callers
// add the room's stitched offset when the original matrix is world-space).

import * as THREE from '../../../vendor/three.module.js';

const _pivot = new THREE.Matrix4();
const _rotation = new THREE.Matrix4();
const _unpivot = new THREE.Matrix4();

/** The identity of one placement/spawn-part row across both display paths. */
export interface WorldEditRef {
  room: number | string;
  sourceKind: string;
  category: string;
  placementIndex: number | string;
}

export interface WorldEdit {
  key: string;
  room: number;
  sourceKind: string;
  category: string;
  placementIndex: number;
  dx: number;
  dy: number;
  dz: number;
  turns: number;
  deleted: boolean;
  [extra: string]: any;
}

export function editKey(ref: WorldEditRef): string {
  return `${Number(ref.room)}|${ref.sourceKind}|${ref.category}|${Number(ref.placementIndex)}`;
}

export class WorldEdits {
  _map: Map<string, WorldEdit>;

  constructor() {
    this._map = new Map();
  }

  get size(): number {
    return this._map.size;
  }

  values(): IterableIterator<WorldEdit> {
    return this._map.values();
  }

  get(ref: WorldEditRef): WorldEdit | null {
    return this._map.get(editKey(ref)) || null;
  }

  /** Get-or-create the edit record for one placement; `init` seeds captured
   *  originals (matrix, pivot, per-view binding) exactly once. */
  ensure(ref: WorldEditRef, init: Record<string, any> = {}): WorldEdit {
    const key = editKey(ref);
    let edit = this._map.get(key);
    if (!edit) {
      edit = {
        key,
        room: Number(ref.room),
        sourceKind: ref.sourceKind,
        category: ref.category,
        placementIndex: Number(ref.placementIndex),
        dx: 0,
        dy: 0,
        dz: 0,
        turns: 0,
        deleted: false,
        ...init,
      };
      this._map.set(key, edit);
    }
    return edit;
  }

  remove(ref: WorldEditRef): void {
    this._map.delete(editKey(ref));
  }

  clear(): void {
    this._map.clear();
  }

  /** True when the record carries no visible change (safe to drop). */
  isNoop(edit: WorldEdit): boolean {
    return !edit.deleted && !edit.dx && !edit.dy && !edit.dz && !edit.turns;
  }
}

/**
 * Compose the edited matrix into `target`: translation deltas in
 * tiles/layers, rotation in quarter turns about the (pivotX, pivotY)
 * native-unit anchor. `original` is left untouched.
 */
export function editedMatrix(
  edit: WorldEdit,
  original: THREE.Matrix4,
  pivotX: number,
  pivotY: number,
  tileUnits: number,
  layerUnits: number,
  target: THREE.Matrix4,
): THREE.Matrix4 {
  target.makeTranslation(
    edit.dx * tileUnits,
    edit.dy * tileUnits,
    edit.dz * layerUnits,
  );
  if (edit.turns) {
    target.multiply(_pivot.makeTranslation(pivotX, pivotY, 0));
    target.multiply(_rotation.makeRotationZ(edit.turns * Math.PI / 2));
    target.multiply(_unpivot.makeTranslation(-pivotX, -pivotY, 0));
  }
  target.multiply(original);
  return target;
}

export default WorldEdits;
