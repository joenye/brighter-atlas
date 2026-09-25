// Room-owned gameplay actor (spawn) recovery. Purely structural: a
// source-supported actor has a typed int32-x/y/z + registry-ref location
// value, a direction resource resolving to one quarter-turn angle, and (when
// visible) equal cardinality ordered mesh/material fields before the
// position. Build-local ids are retained only as provenance in the returned
// records.

import { makeRegistryRowDecoder } from './effects.js';
import { ActorIdleResolver, type ActorIdle } from './actor-idle.js';
import { makePoolRegistryRefs } from './models.js';
import type { FillRow } from './replay.js';
import type { WorldProfile } from './profile.js';
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
  default_room_record: number | null;
  default_room_field_op: number;
  centre_offset: number | null;
  centre_field_op: number;
  direction_resource: number;
  rotation_quarters: number;
  angle_degrees: number;
  location_field_op: number;
  location_series_index: number;
  location_class: number;
  direction_field_op: number;
  label: string | null;
  authored_label: string | null;
  enemy_definitions: { record: number; name: string }[];
  label_field_op: number;
  parts: Record<string, any>[];
  appearance_confidence: string | null;
  // The clip the actor rests in (actor-idle.js); null when the build's data
  // supports none, or when the graph has no clip directory to check rigs.
  idle_clip: number | null;
  idle_source: ActorIdle['source'] | null;
  idle_field_op: number;
  // Props the resting controller hands the actor (a book, a tankard): extra
  // parts on the actor's own rig, confidence 'idle_prop', never part of the
  // authored appearance.
  idle_props: Record<string, any>[];
}

export interface SpawnMembership {
  kind: 'generic' | 'direct' | 'default_room';
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

export interface SpawnDecodeOptions {
  bytes?: Uint8Array;
  profile?: WorldProfile;
  charset?: ArrayLike<string> | null;
  enemyDefs?: { slot: number; name: string; targets: number[] }[] | null;
  /** ab0 clip directory + mesh directory: both needed to resolve idle clips */
  animDir?: { skel: number; dur?: number }[] | null;
  meshDir?: { sref: number }[] | null;
}

// Pure structural resolver for room-owned gameplay actor instances.
export class SpawnGraph {
  rows: RegistryRow[];
  pool: PoolNode[];
  assets: AssetGraph;
  private _locationCache: Map<number, SpawnLocation | null>;
  private _directionCache: Map<number, SpawnDirection | null>;
  private _spawnCache: Map<number, SpawnRecord | null>;

  private _decode: ReturnType<typeof makeRegistryRowDecoder> | null;
  private _charset: ArrayLike<string> | null;
  private _enemyDefinitions = new Map<number, { record: number; name: string }[]>();
  private _defaultActors = new Map<number, number[]>();
  private _idle: ActorIdleResolver | null = null;
  private _meshDir: { sref: number }[] | null;

  constructor(rows: RegistryRow[], pool: PoolNode[], assetGraph: AssetGraph, options: SpawnDecodeOptions = {}) {
    this.rows = rows;
    this.pool = pool;
    this.assets = assetGraph;
    this._decode = options.bytes && options.profile
      ? makeRegistryRowDecoder(rows as FillRow[], options.bytes, options.profile) : null;
    this._charset = options.charset ?? null;
    for (const def of options.enemyDefs ?? []) {
      for (const target of def.targets) {
        const list = this._enemyDefinitions.get(target) ?? [];
        list.push({ record: def.slot, name: def.name }); this._enemyDefinitions.set(target, list);
      }
    }
    this._locationCache = new Map();
    this._directionCache = new Map();
    this._spawnCache = new Map();
    this._meshDir = options.meshDir ?? null;
    if (options.animDir && options.meshDir) {
      this._idle = new ActorIdleResolver(rows as FillRow[], pool, assetGraph, options.animDir, {
        // A location value marks an actor row cheaply and without recursion
        // (spawn() itself is what calls the resolver).
        isActor: (slot) => this._location(slot) !== null,
        decode: this._decode ? (slot) => this._decode!(slot) as any : null,
        poolRegistryRefs: makePoolRegistryRefs(pool),
      });
    }
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
  // pool (a depth-0 tag-0 field, most actors), or INLINE in the row's own
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
    if (this._decode) {
      for (const field of this._decode(ownerSlot) ?? []) {
        if (field.kind !== 'G') continue;
        const node = this.assets.deref(field.node);
        if (node?.tag === 0x24) consider(field.op, 0, node.class,
          (node.fields ?? []).map((v: any) => this.assets.deref(v)));
      }
      const result = matches.length === 1 ? matches[0] : null;
      this._locationCache.set(ownerSlot, result);
      return result;
    }
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
    // (postorder: everything after the previous depth<=0 event).
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

  static _decodeString(node: any, charset: ArrayLike<string> | null = null): string | null {
    const values = node.values;
    if (node.tag !== 0x0E || !Array.isArray(values)) return null;
    let value = '';
    for (const character of values) {
      if (!isInt(character) || character < 0 || character > 0x10FFFF) return null;
      const glyph = charset ? charset[character] : String.fromCodePoint(character);
      if (typeof glyph !== 'string') return null;
      value += glyph;
    }
    return normalizeSpaces(value);
  }

  private _fieldLabel(field: DecodedField): string | null {
    const strings: string[] = [];
    for (const element of field.elements) {
      for (const node of this._walk(element)) {
        const string = SpawnGraph._decodeString(node, this._charset);
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
        if (tag === 0x0E && typeof value === 'string' && value.trim()) referenced.push(this._charset ? Array.from(value, c => this._charset![c.codePointAt(0)!] ?? c).join('') : value);
      }
    }
    const distinctReferenced = unique(referenced);
    if (distinctReferenced.length === 1) return normalizeSpaces(distinctReferenced[0]);
    return null;
  }

  private _label(ownerSlot: number, beforeOp: number): [string | null, number] {
    if (this._decode) {
      const fields = (this._decode(ownerSlot) ?? []).filter(f => f.kind === 'G' && f.op < beforeOp);
      for (const field of fields.reverse()) {
        if (field.kind !== 'G') continue;
        const node = this.assets.deref(field.node);
        if (!node) continue;
        const label = SpawnGraph._decodeString(node, this._charset);
        if (label !== null) return [label, field.op];
      }
    }
    const fields = this.assets.fields(ownerSlot);
    const ops = Array.from(fields.keys()).filter((op) => op < beforeOp).sort((a, b) => b - a);
    for (const operation of ops) {
      const label = this._fieldLabel(fields.get(operation)!);
      if (label !== null) return [label, operation];
    }
    return [null, -1];
  }

  // One exact actor record, or null for a non-actor row.
  /** The resting-clip resolver (null without animation data). */
  get idleResolver(): ActorIdleResolver | null { return this._idle; }

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
    // The default-placement group ends with a typed XYZ/direction value,
    // preceded by its room reference and scalar centre offset. Discover it
    // relative to the validated location rather than a build-specific index.
    const scalar = (op: number): any => {
      if (this._decode) {
        const field = (this._decode(ownerSlot) ?? []).find(f => f.op === op && f.kind === 'G');
        return field?.kind === 'G' ? this.assets.deref(field.node) : null;
      }
      const field = this.assets.fields(ownerSlot).get(op);
      return field?.elements.length === 1 ? this.assets.deref(field.elements[0]) : null;
    };
    let roomOp = location.field_op - 1;
    // Some schemas retain an additional integer between room and location.
    if (scalar(roomOp)?.tag === 0x0a) roomOp--;
    const centreOp = roomOp - 1;
    const room = scalar(roomOp), centre = scalar(centreOp);
    const hasDefault = room?.tag === 0x26 && isInt(room.value)
      && centre?.tag === 0x0b && centre.value?.length === 1 && Number.isFinite(centre.value[0]);
    const result: SpawnRecord = {
      record: ownerSlot,
      position: location.position,
      default_room_record: hasDefault ? room.value : null,
      default_room_field_op: hasDefault ? roomOp : -1,
      centre_offset: hasDefault ? centre.value[0] : null,
      centre_field_op: hasDefault ? centreOp : -1,
      direction_resource: location.direction_resource,
      rotation_quarters: direction.rotation_quarters,
      angle_degrees: direction.angle_degrees,
      location_field_op: location.field_op,
      location_series_index: location.series_index,
      location_class: location.typed_class,
      direction_field_op: direction.field_op,
      label: this._enemyDefinitions.has(ownerSlot)
        ? unique(this._enemyDefinitions.get(ownerSlot)!.map(d => d.name)).join(' / ') : label,
      authored_label: label,
      enemy_definitions: this._enemyDefinitions.get(ownerSlot) ?? [],
      label_field_op: labelOp,
      parts: appearance === null ? [] : appearance.parts,
      appearance_confidence: appearance === null ? null : appearance.confidence,
      idle_clip: null,
      idle_source: null,
      idle_field_op: -1,
      idle_props: [],
    };
    // The resting clip must belong to the rig of the actor's own meshes.
    if (this._idle && appearance !== null) {
      const rigs = new Set<number>();
      for (const part of appearance.parts) {
        const sref = this._meshDir?.[part.mesh]?.sref;
        if (typeof sref === 'number' && sref >= 2) rigs.add(sref - 2);
      }
      const idle = this._idle.resolve(ownerSlot, rigs);
      if (idle) {
        result.idle_clip = idle.clip;
        result.idle_source = idle.source;
        result.idle_field_op = idle.field_op;
        const meshRig = (mesh: number) => { const sref = this._meshDir?.[mesh]?.sref; return typeof sref === 'number' && sref >= 2 ? sref - 2 : null; };
        result.idle_props = this._idle.props(idle.controller, rigs, meshRig).map((prop, index) => ({
          mesh_def_slot: prop.mesh_def_slot,
          mesh: prop.mesh,
          material_slot: prop.material_slot,
          texture: prop.texture,
          part_index: appearance.parts.length + index,
          mesh_field_op: -1,
          material_field_op: -1,
          confidence: 'idle_prop',
          recolors: prop.recolors,
          recolor_field_ops: [-1, -1],
          recolor_scope: prop.recolors ? 'actor_scalar' : null,
          local_matrix: prop.local_matrix,
        }));
      }
    }
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
    this._defaultActors.clear();
    const owners = new Set([...result.values()].map(r => r.record));
    for (const row of this.rows) {
      // Inspect only top-level room references. A definition's nested list of
      // rooms is not an actor's own default placement.
      const candidate = row.g.some(([, depth, tag, value]) => {
        if (depth !== 0) return false;
        const node = tag === 0 ? this.assets.deref({ tag, value }) : { tag, value };
        return node?.tag === 0x26 && owners.has(node.value);
      });
      if (!candidate) continue;
      const actor = this.spawn(row.slot);
      if (actor?.default_room_record == null || !owners.has(actor.default_room_record)) continue;
      const list = this._defaultActors.get(actor.default_room_record) ?? [];
      list.push(row.slot); this._defaultActors.set(actor.default_room_record, list);
    }
    return result;
  }

  // Typed six-scalar boxes remain geometry metadata, never actor positions.
  // Preserve source class and field identity; no gameplay purpose is inferred.
  roomVolumes(roomSlot: number): { field_op: number; typed_class: number; path: (string | number)[];
    origin: number[]; extent: number[] }[] {
    const result: ReturnType<SpawnGraph['roomVolumes']> = [];
    const walk = (value: any, op: number, path: (string | number)[], active = new Set<number>()) => {
      if (!isNode(value)) return;
      if (value.tag === 0) {
        if (active.has(value.value)) return;
        active.add(value.value); walk(this.pool[value.value], op, path, active); active.delete(value.value);
        return;
      }
      if (value.tag === 0x24 && value.fields?.length === 6) {
        const fields = value.fields.map((v: any) => this.assets.deref(v));
        if (fields.every((v: any) => v?.tag === 0x0b && v.value?.length === 1 && Number.isFinite(v.value[0]))) {
          const raw = fields.map((v: any) => v.value[0]);
          result.push({ field_op: op, typed_class: value.class, path, origin: raw.slice(0, 3), extent: raw.slice(3) });
          return;
        }
      }
      for (const key of ['values', 'fields']) if (Array.isArray(value[key])) {
        value[key].forEach((v: any, i: number) => walk(v, op, [...path, key, i], active));
      }
    };
    for (const field of this._decode?.(roomSlot) ?? []) if (field.kind === 'G') walk(field.node, field.op, []);
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

    for (const target of this._defaultActors.get(roomSlot) ?? []) {
      add(target, { kind: 'default_room', field_op: this.spawn(target)!.default_room_field_op,
        series_index: -1, leaf_index: -1 });
    }
    const result: RoomSpawn[] = [];
    for (const target of Array.from(memberships.keys()).sort((a, b) => a - b)) {
      const actor = this.spawn(target)!;
      // A cross-room reference is an association, not a placement here.
      if (actor.default_room_record !== null && actor.default_room_record !== roomSlot) continue;
      result.push({
        ...actor,
        room: roomId,
        room_record: roomSlot,
        room_field_op: roomRow.room_field_op,
        memberships: memberships.get(target)!,
      });
    }
    return result;
  }
}
