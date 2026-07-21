// Room-owned gameplay actor (spawn) recovery. Purely structural: a
// source-supported actor has a typed int32-x/y/z + registry-ref location
// value, a direction resource resolving to one quarter-turn angle, and (when
// visible) equal cardinality ordered mesh/material fields before the
// position. Build-local ids are retained only as provenance in the returned
// records.

import type { AssetGraph, DecodedField, PoolNode, RegistryRow } from './graph.js';

const POSITION_TAGS = [0x0A, 0x0A, 0x0A, 0x26];
const ANGLE_EPSILON = 1e-6;

const isInt = (v: any) => Number.isInteger(v);
const isNode = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

function unique<T>(values: Iterable<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) if (!seen.has(v)) { seen.add(v); out.push(v); }
  return out;
}

// Collapse whitespace runs into single spaces; whitespace-only -> null.
function normalizeSpaces(value: string): string | null {
  const parts = value.split(/\s+/u).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

interface SpawnLocation {
  field_op: number;
  series_index: number;
  typed_class: number;
  position: [number, number, number];
  direction_resource: number;
}

interface SpawnDirection {
  field_op: number;
  angle_degrees: number;
  rotation_quarters: number;
}

interface SpawnAppearance {
  mesh_field_op: number;
  material_field_op: number;
  confidence: string;
  parts: Record<string, any>[];
}

export interface SpawnRecord {
  record: number;
  position: [number, number, number];
  direction_resource: number;
  rotation_quarters: number;
  angle_degrees: number;
  location_field_op: number;
  location_series_index: number;
  location_class: number;
  direction_field_op: number;
  label: string | null;
  label_field_op: number;
  parts: Record<string, any>[];
  appearance_confidence: string | null;
}

export interface SpawnMembership {
  kind: 'generic' | 'direct';
  field_op: number;
  series_index: number;
  leaf_index: number;
}

export interface RoomRowRef {
  record: number;
  room_field_op: number;
}

export type RoomSpawn = SpawnRecord & {
  room: number;
  room_record: number;
  room_field_op: number;
  memberships: SpawnMembership[];
};

// Pure structural resolver for room-owned gameplay actor instances.
export class SpawnGraph {
  rows: RegistryRow[];
  pool: PoolNode[];
  assets: AssetGraph;
  private _locationCache: Map<number, SpawnLocation | null>;
  private _directionCache: Map<number, SpawnDirection | null>;
  private _spawnCache: Map<number, SpawnRecord | null>;

  constructor(rows: RegistryRow[], pool: PoolNode[], assetGraph: AssetGraph) {
    this.rows = rows;
    this.pool = pool;
    this.assets = assetGraph;
    this._locationCache = new Map();
    this._directionCache = new Map();
    this._spawnCache = new Map();
  }

  // Recursively decoded nodes below one value, following pool refs acyclically.
  private * _walk(node: any, active: Set<number> | null = null): Generator<any, void, unknown> {
    if (!isNode(node)) return;
    if (node.tag === 0) {
      const index = node.value;
      if (isInt(index) && index >= 0 && index < this.pool.length
        && !(active !== null && active.has(index))) {
        if (active === null) active = new Set();
        active.add(index);
        yield* this._walk(this.pool[index], active);
        active.delete(index);
      }
      return;
    }
    yield node;
    for (const key of ['fields', 'values']) {
      const children = node[key];
      if (Array.isArray(children)) {
        for (const child of children) yield* this._walk(child, active);
      }
    }
    if (isNode(node.value)) yield* this._walk(node.value, active);
  }

  // The unique typed integer XYZ + direction value on one row, or null.
  //
  // The location typed object serializes in TWO forms: interned in the value
  // pool (a depth-0 tag-0 field — most actors), or INLINE in the row's own
  // event stream as a postorder tag-0x24 completion marker whose direct
  // depth+1 children are pool references (bosses/one-offs whose unique
  // position was never worth interning: Thruntyx, the Bear Clearing bears).
  // Both forms are the same authored value; the uniqueness guard spans both.
  private _location(ownerSlot: number): SpawnLocation | null {
    if (this._locationCache.has(ownerSlot)) return this._locationCache.get(ownerSlot)!;
    if (!isInt(ownerSlot) || ownerSlot < 0 || ownerSlot >= this.rows.length) return null;
    const matches: SpawnLocation[] = [];
    const consider = (
      operation: number, seriesIndex: number, typedClass: number, values: any[],
    ): void => {
      if (values.length !== 4
        || values.some((v: any, k: number) => !isNode(v) || v.tag !== POSITION_TAGS[k])
        || values.some((v: any) => !isInt(v.value))) return;
      matches.push({
        field_op: operation,
        series_index: seriesIndex,
        typed_class: typedClass,
        position: [values[0].value, values[1].value, values[2].value],
        direction_resource: values[3].value,
      });
    };
    for (const [operation, field] of this.assets.fields(ownerSlot)) {
      for (let seriesIndex = 0; seriesIndex < field.elements.length; seriesIndex++) {
        for (const node of this._walk(field.elements[seriesIndex])) {
          if (node.tag !== 0x24) continue;
          consider(operation, seriesIndex, node.class,
            (node.fields || []).map((v: any) => this.assets.deref(v)));
        }
      }
    }
    // Inline typed completions: group the row's events per operation, find
    // depth-0 tag-0x24 markers, and take their direct depth+1 tag-0 children
    // (postorder — everything after the previous depth<=0 event).
    const byOperation = new Map<number, any[][]>();
    for (const event of this.rows[ownerSlot].g) {
      const list = byOperation.get(event[0]);
      if (list) list.push(event); else byOperation.set(event[0], [event]);
    }
    for (const [operation, events] of byOperation) {
      let markerIndex = 0;
      for (let position = 0; position < events.length; position++) {
        const [, depth, tag, typedClass] = events[position];
        if (tag !== 0x24 || depth !== 0) continue;
        const index = markerIndex;
        markerIndex++;
        let boundary = -1;
        for (let previous = position - 1; previous >= 0; previous--) {
          if (events[previous][1] <= depth) { boundary = previous; break; }
        }
        const values: any[] = [];
        for (let k = boundary + 1; k < position; k++) {
          if (events[k][1] === depth + 1 && events[k][2] === 0 && isInt(events[k][3])) {
            values.push(this.assets.deref({ tag: 0, value: events[k][3] }));
          } else if (events[k][1] === depth + 1) {
            values.push(null);   // a non-reference child disqualifies via shape
          }
        }
        if (isInt(typedClass)) consider(operation, index, typedClass, values);
      }
    }
    const result = matches.length === 1 ? matches[0] : null;
    this._locationCache.set(ownerSlot, result);
    return result;
  }

  // A direction resource's unique scalar quarter-turn angle, or null.
  private _direction(resourceSlot: number): SpawnDirection | null {
    if (this._directionCache.has(resourceSlot)) return this._directionCache.get(resourceSlot)!;
    if (!isInt(resourceSlot) || resourceSlot < 0 || resourceSlot >= this.rows.length) return null;
    const matches: [number, number, number][] = [];
    const seen = new Set<string>();
    for (const [operation, field] of this.assets.fields(resourceSlot)) {
      for (const element of field.elements) {
        const node = this.assets.deref(element);
        if (!isNode(node) || node.tag !== 0x0B
          || !Array.isArray(node.value) || node.value.length !== 1
          || typeof node.value[0] !== 'number') continue;
        const angle = ((node.value[0] % 360) + 360) % 360;
        const quarters = Math.round(angle / 90) & 3;
        if (Math.abs(angle - quarters * 90) <= ANGLE_EPSILON) {
          const key = `${operation}|${angle}|${quarters}`;
          if (!seen.has(key)) { seen.add(key); matches.push([operation, angle, quarters]); }
        }
      }
    }
    let result: SpawnDirection | null = null;
    if (matches.length === 1) {
      const [operation, angle, quarters] = matches[0];
      result = { field_op: operation, angle_degrees: angle, rotation_quarters: quarters };
    }
    this._directionCache.set(resourceSlot, result);
    return result;
  }

  private _meshField(field: DecodedField): [number, number][] | null {
    const parts: [number, number][] = [];
    for (const leaves of field.leaves) {
      if (leaves.length !== 1 || leaves[0][0] !== 0x26) return null;
      const meshSlot = leaves[0][1];
      if (!this.assets.meshBySlot.has(meshSlot)) return null;
      parts.push([meshSlot, this.assets.meshBySlot.get(meshSlot)!]);
    }
    return parts.length ? parts : null;
  }

  private _materialField(field: DecodedField): [number, number][] | null {
    const parts: [number, number][] = [];
    for (const leaves of field.leaves) {
      if (leaves.length !== 1 || leaves[0][0] !== 0x02) return null;
      const material = leaves[0][1];
      const textures = this.assets.texturesByMaterial.get(material);
      if (!textures || textures.length !== 1) return null;
      parts.push([material, textures[0]]);
    }
    return parts.length ? parts : null;
  }

  private _colorField(field: DecodedField): number[][] | null {
    const colors: number[][] = [];
    for (const element of field.elements) {
      const node = this.assets.deref(element);
      if (!isNode(node) || node.tag !== 0x15
        || !Array.isArray(node.value) || node.value.length !== 4
        || !node.value.every((v: any) => typeof v === 'number')) return null;
      colors.push(node.value.slice());
    }
    return colors.length ? colors : null;
  }

  private _hasMatrix(field: DecodedField): boolean {
    for (const element of field.elements) {
      for (const node of this._walk(element)) if (node.tag === 0x30) return true;
    }
    return false;
  }

  static _hasAssets(field: DecodedField): boolean {
    for (const leaves of field.leaves) {
      for (const [tag] of leaves) if (tag === 0x02 || tag === 0x26) return true;
    }
    return false;
  }

  // The unique exact mesh/material group before the actor position, or null.
  private _appearance(ownerSlot: number, positionOp: number): SpawnAppearance | null {
    const fields = this.assets.fields(ownerSlot);
    const meshFields = new Map<number, [number, number][]>();
    const materialFields = new Map<number, [number, number][]>();
    for (const [operation, field] of fields) {
      if (operation >= positionOp) continue;
      const meshes = this._meshField(field);
      if (meshes !== null) meshFields.set(operation, meshes);
      const materials = this._materialField(field);
      if (materials !== null) materialFields.set(operation, materials);
    }
    const candidates: [number, number, [number, number][], [number, number][]][] = [];
    for (const [meshOp, meshes] of meshFields) {
      for (const [materialOp, materials] of materialFields) {
        if (!(meshOp < materialOp) || meshes.length !== materials.length) continue;
        let blocked = false;
        for (const [operation, field] of fields) {
          if (operation > meshOp && operation < materialOp
            && SpawnGraph._hasAssets(field)) { blocked = true; break; }
        }
        if (!blocked) candidates.push([meshOp, materialOp, meshes, materials]);
      }
    }
    if (candidates.length !== 1) return null;
    const [meshOp, materialOp, meshes, materials] = candidates[0];
    for (const [operation, field] of fields) {
      // The current actor schema has no per-part affine; refuse a plausible
      // but incomplete appearance if a future schema introduces one.
      if (operation > meshOp && operation < positionOp && this._hasMatrix(field)) return null;
    }
    const colorFields: [number, number[][]][] = [];
    for (const [operation, field] of fields) {
      if (operation <= materialOp || operation >= positionOp) continue;
      const colors = this._colorField(field);
      if (colors !== null) colorFields.push([operation, colors]);
    }
    colorFields.sort((a, b) => a[0] - b[0]);
    let recolorScope: string | null = null;
    let recolors: number[][][] | null = null;
    let recolorOps = [-1, -1];
    if (colorFields.length) {
      if (colorFields.length !== 2
        || colorFields[0][1].length !== colorFields[1][1].length
        || (colorFields[0][1].length !== 1 && colorFields[0][1].length !== meshes.length)) {
        return null;
      }
      recolorOps = [colorFields[0][0], colorFields[1][0]];
      recolorScope = colorFields[0][1].length === 1 ? 'actor_scalar' : 'parallel';
      recolors = meshes.map((_, index) => {
        const pick = recolorScope === 'actor_scalar' ? 0 : index;
        return [colorFields[0][1][pick], colorFields[1][1][pick]];
      });
    }
    const confidence = fields.get(meshOp)!.series || fields.get(materialOp)!.series
      ? 'exact_spawn_parallel_series' : 'exact_spawn_scalar_fields';
    return {
      mesh_field_op: meshOp,
      material_field_op: materialOp,
      confidence,
      parts: meshes.map(([meshSlot, mesh], index) => ({
        mesh_def_slot: meshSlot,
        mesh,
        material_slot: materials[index][0],
        texture: materials[index][1],
        part_index: index,
        mesh_field_op: meshOp,
        material_field_op: materialOp,
        confidence,
        recolors: recolors === null ? null : recolors[index].map((color) => color.slice()),
        recolor_field_ops: recolorOps,
        recolor_scope: recolorScope,
      })),
    };
  }

  static _decodeString(node: any): string | null {
    const values = node.values;
    if (node.tag !== 0x0E || !Array.isArray(values)) return null;
    let value = '';
    for (const character of values) {
      if (!isInt(character) || character < 0 || character > 0x10FFFF) return null;
      value += String.fromCodePoint(character);
    }
    return normalizeSpaces(value);
  }

  private _fieldLabel(field: DecodedField): string | null {
    const strings: string[] = [];
    for (const element of field.elements) {
      for (const node of this._walk(element)) {
        const string = SpawnGraph._decodeString(node);
        if (string !== null) strings.push(string);
      }
    }
    const distinct = unique(strings);
    if (distinct.length === 1) return distinct[0];

    const refs = unique(
      field.leaves.flat().filter(([tag, value]) => tag === 0x26 && isInt(value)
        && value >= 0 && value < this.rows.length
        && !this.assets.meshBySlot.has(value)).map(([, value]) => value),
    );
    const referenced: string[] = [];
    for (const ref of refs) {
      for (const [, , tag, value] of this.rows[ref].g) {
        if (tag === 0x0E && typeof value === 'string' && value.trim()) referenced.push(value);
      }
    }
    const distinctReferenced = unique(referenced);
    if (distinctReferenced.length === 1) return normalizeSpaces(distinctReferenced[0]);
    return null;
  }

  private _label(ownerSlot: number, beforeOp: number): [string | null, number] {
    const fields = this.assets.fields(ownerSlot);
    const ops = Array.from(fields.keys()).filter((op) => op < beforeOp).sort((a, b) => b - a);
    for (const operation of ops) {
      const label = this._fieldLabel(fields.get(operation)!);
      if (label !== null) return [label, operation];
    }
    return [null, -1];
  }

  // One exact actor record, or null for a non-actor row.
  spawn(ownerSlot: number): SpawnRecord | null {
    if (this._spawnCache.has(ownerSlot)) return this._spawnCache.get(ownerSlot)!;
    const location = this._location(ownerSlot);
    if (location === null) {
      this._spawnCache.set(ownerSlot, null);
      return null;
    }
    const direction = this._direction(location.direction_resource);
    if (direction === null) {
      this._spawnCache.set(ownerSlot, null);
      return null;
    }
    const appearance = this._appearance(ownerSlot, location.field_op);
    const nameBefore = appearance !== null ? appearance.mesh_field_op : location.field_op;
    const [label, labelOp] = this._label(ownerSlot, nameBefore);
    const result: SpawnRecord = {
      record: ownerSlot,
      position: location.position,
      direction_resource: location.direction_resource,
      rotation_quarters: direction.rotation_quarters,
      angle_degrees: direction.angle_degrees,
      location_field_op: location.field_op,
      location_series_index: location.series_index,
      location_class: location.typed_class,
      direction_field_op: direction.field_op,
      label,
      label_field_op: labelOp,
      parts: appearance === null ? [] : appearance.parts,
      appearance_confidence: appearance === null ? null : appearance.confidence,
    };
    this._spawnCache.set(ownerSlot, result);
    return result;
  }

  // Map AB2 room ordinals to their unique native registry owner rows.
  discoverRoomRows(roomIds: Iterable<number>): Map<number, RoomRowRef> {
    const wanted = new Set(roomIds);
    const matches = new Map<number, [number, number][]>();
    for (const row of this.rows) {
      for (const [operation, depth, tag, value] of row.g) {
        if (depth === 0 && tag === 0x13 && wanted.has(value)) {
          const list = matches.get(value);
          if (list) list.push([row.slot, operation]);
          else matches.set(value, [[row.slot, operation]]);
        }
      }
    }
    const ambiguous = Array.from(matches).filter(([, rows]) => rows.length !== 1);
    const missing = Array.from(wanted).filter((id) => !matches.has(id)).sort((a, b) => a - b);
    if (ambiguous.length || missing.length) {
      throw new Error('native room-row discovery is not one-to-one: '
        + `missing=${JSON.stringify(missing)}, ambiguous=${JSON.stringify(ambiguous)}`);
    }
    const result = new Map<number, RoomRowRef>();
    for (const [roomId, rows] of matches) {
      result.set(roomId, { record: rows[0][0], room_field_op: rows[0][1] });
    }
    return result;
  }

  // Deduplicated actors and every source membership for one room.
  roomSpawns(roomId: number, roomRow: RoomRowRef): RoomSpawn[] {
    const roomSlot = roomRow.record;
    const memberships = new Map<number, SpawnMembership[]>();
    const add = (target: number, membership: SpawnMembership) => {
      const list = memberships.get(target);
      if (list) list.push(membership); else memberships.set(target, [membership]);
    };
    for (const [operation, field] of this.assets.fields(roomSlot)) {
      for (let seriesIndex = 0; seriesIndex < field.leaves.length; seriesIndex++) {
        const leaves = field.leaves[seriesIndex];
        for (let leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
          const [tag, target] = leaves[leafIndex];
          if (tag !== 0x26 || this.spawn(target) === null) continue;
          add(target, {
            kind: 'generic', field_op: operation, series_index: seriesIndex, leaf_index: leafIndex,
          });
        }
      }
    }
    const direct = this.rows[roomSlot].r;
    for (let leafIndex = 0; leafIndex < direct.length; leafIndex++) {
      const [operation, target] = direct[leafIndex];
      if (this.spawn(target) === null) continue;
      add(target, {
        kind: 'direct', field_op: operation, series_index: -1, leaf_index: leafIndex,
      });
    }

    const result: RoomSpawn[] = [];
    for (const target of Array.from(memberships.keys()).sort((a, b) => a - b)) {
      result.push({
        ...this.spawn(target)!,
        room: roomId,
        room_record: roomSlot,
        room_field_op: roomRow.room_field_op,
        memberships: memberships.get(target)!,
      });
    }
    return result;
  }
}
