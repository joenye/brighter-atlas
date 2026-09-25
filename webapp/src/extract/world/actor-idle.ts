// Actor default-animation ("idle") recovery. Purely structural over the
// replayed registry, per game build, with no fixed field positions:
//
//   1. The actor row's first generic field that references (directly, or as
//      a short list) an animation ROW: a clip record (its one 0x61 edge is
//      the AB1 clip), a controller (direct clip-record references on the
//      actor's own rig; three clips are an intro/loop/outro triple whose
//      loop is the longest), or a set (a direct registry reference, the R
//      field, names the resting controller; the S series holds the
//      movement controllers). Room rows and other actor rows never count.
//   2. Otherwise the actor's presentation record: a typed value whose fifth
//      field is a clip record (the pose it shows when it is inspected).
//   3. Otherwise a rig that carries exactly one clip plays that clip.
//
// A clip that is not on the rig of the actor's meshes is never accepted.
//
// A controller can also hand the actor props while it rests (a book on a
// bench, a tankard at a table): typed attachment records of a mesh, a
// material, three tints and a local matrix, or parallel mesh/material
// lists. They are skinned to the actor's own rig, so they draw as extra parts.

import type { AssetGraph, DecodedField } from './graph.js';
import type { FillRow } from './replay.js';

export type ActorIdleSource = 'animatic' | 'portrait' | 'rig_single';

export interface ActorIdle {
  clip: number;               // AB1 clip ordinal
  source: ActorIdleSource;
  field_op: number;           // the actor field the clip came from (-1 for rig_single)
  controller: number | null;  // the controller row the clip came from, when there is one
}

export interface ActorIdleProp {
  mesh_def_slot: number;      // registry slot of the mesh definition
  mesh: number;               // ab5 ordinal
  material_slot: number;
  texture: number;            // the material's one texture
  recolors: number[][] | null;
  local_matrix: number[] | null;   // row-major 3x4 when the record carries one
}

export interface ActorIdleOptions {
  /** registry-slot -> is this row itself an actor (never an animation row) */
  isActor?: ((slot: number) => boolean) | null;
  /** exact per-row generic fields (makeRegistryRowDecoder); AssetGraph.fields otherwise */
  decode?: ((slot: number) => { op: number; kind: string; node?: any }[] | null) | null;
  /** registry rows reachable from one pool value (models.js makePoolRegistryRefs) */
  poolRegistryRefs?: ((index: number) => number[]) | null;
  /** the longest reference list still read as one animation choice */
  maxRefs?: number;
}

const isInt = (v: unknown): v is number => Number.isInteger(v);

type Classified =
  | { kind: 'clips'; clips: number[]; controller: number | null }
  | { kind: 'set'; primary: number[]; controller: number };

export class ActorIdleResolver {
  private _clipOfRecord: Map<number, number> | null = null;
  private _roomRows: Set<number> | null = null;
  private _rigClips: Map<number, number[]> | null = null;
  private _classified = new Map<string, Classified | null>();
  private readonly _maxRefs: number;

  constructor(
    private readonly rows: FillRow[],
    private readonly pool: any[],
    private readonly assets: AssetGraph,
    private readonly animDir: { skel: number; dur?: number }[],
    private readonly options: ActorIdleOptions = {},
  ) {
    this._maxRefs = options.maxRefs ?? 4;
  }

  /** slot -> AB1 clip for every row whose single asset edge is a clip */
  clipOfRecord(): Map<number, number> {
    if (!this._clipOfRecord) {
      this._clipOfRecord = new Map();
      for (const row of this.rows) {
        if (!row) continue;
        for (const [, , tag, value] of row.g) {
          if (tag === 0x61 && isInt(value)) { this._clipOfRecord.set(row.slot, value); break; }
        }
      }
    }
    return this._clipOfRecord;
  }

  private _isRoom(slot: number): boolean {
    if (!this._roomRows) {
      this._roomRows = new Set();
      for (const row of this.rows) {
        if (row?.g.some(([, depth, tag]) => depth === 0 && tag === 0x13)) this._roomRows.add(row.slot);
      }
    }
    return this._roomRows.has(slot);
  }

  private _rigClipList(rig: number): number[] {
    if (!this._rigClips) {
      this._rigClips = new Map();
      this.animDir.forEach((entry, clip) => {
        const list = this._rigClips!.get(entry.skel);
        if (list) list.push(clip); else this._rigClips!.set(entry.skel, [clip]);
      });
    }
    return this._rigClips.get(rig) ?? [];
  }

  // Registry rows one row references through its generic events (typed and
  // pool-interned references alike), in event order.
  private _referenced(slot: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    const add = (target: number) => { if (isInt(target) && !seen.has(target)) { seen.add(target); out.push(target); } };
    for (const [, , tag, value] of this.rows[slot]?.g ?? []) {
      if (tag === 0x26 && isInt(value)) add(value);
      else if (tag === 0 && isInt(value) && value >= 0 && value < this.pool.length) {
        for (const target of this.options.poolRegistryRefs?.(value) ?? []) add(target);
      }
    }
    return out;
  }

  // Clips directly referenced by one row (clip-record targets only).
  private _directClips(slot: number, rigs: Set<number>): number[] {
    const records = this.clipOfRecord();
    const clips: number[] = [];
    for (const target of this._referenced(slot)) {
      const clip = records.get(target);
      if (clip === undefined || clips.includes(clip) || !rigs.has(this.animDir[clip]?.skel)) continue;
      clips.push(clip);
    }
    return clips;
  }

  private _classify(slot: number, rigs: Set<number>, depth: number): Classified | null {
    if (!isInt(slot) || slot < 0 || slot >= this.rows.length || !this.rows[slot]) return null;
    const key = `${slot}|${[...rigs].sort((a, b) => a - b).join(',')}|${depth}`;
    if (this._classified.has(key)) return this._classified.get(key)!;
    let result: Classified | null = null;
    if (!this._isRoom(slot) && !this.options.isActor?.(slot)) {
      const clip = this.clipOfRecord().get(slot);
      if (clip !== undefined) {
        result = rigs.has(this.animDir[clip]?.skel) ? { kind: 'clips', clips: [clip], controller: null } : null;
      } else {
        const clips = this._directClips(slot, rigs);
        if (clips.length) result = { kind: 'clips', clips, controller: slot };
        else if (depth === 0) {
          // a set: its direct registry reference is the resting controller
          for (const [, target] of this.rows[slot].r || []) {
            const primary = this._classify(target, rigs, 1);
            if (primary?.kind === 'clips') { result = { kind: 'set', primary: primary.clips, controller: target }; break; }
          }
        }
      }
    }
    this._classified.set(key, result);
    return result;
  }

  // One controller's resting clip: a lone clip, or the loop of a triple.
  private _restClip(clips: number[]): number | null {
    if (!clips.length) return null;
    if (clips.length !== 3) return clips[0];
    let best = clips[0];
    for (const clip of clips) {
      if ((this.animDir[clip]?.dur ?? 0) > (this.animDir[best]?.dur ?? 0)) best = clip;
    }
    return best;
  }

  // The reference(s) one generic field holds: a reference, or a list of them.
  private _fieldRefs(node: any): number[] | null {
    const value = this.assets.deref(node);
    if (!value || typeof value !== 'object') return null;
    if (value.tag === 0x26) return isInt(value.value) ? [value.value] : null;
    if (value.tag === 0x20 && Array.isArray(value.values)) {
      const refs: number[] = [];
      for (const element of value.values) {
        const item = this.assets.deref(element);
        if (item?.tag === 0x26 && isInt(item.value)) refs.push(item.value);
        else if (item?.tag === 0x0c || item?.tag === 0x0d) continue;   // null padding
        else return null;
      }
      return refs.length ? refs : null;
    }
    return null;
  }

  private _genericFields(slot: number): { op: number; node: any }[] {
    const decoded = this.options.decode?.(slot);
    if (decoded) return decoded.filter((f) => f.kind === 'G').map((f) => ({ op: f.op, node: f.node }));
    const out: { op: number; node: any }[] = [];
    for (const [op, field] of this.assets.fields(slot) as Map<number, DecodedField>) {
      if (field.elements.length === 1) out.push({ op, node: field.elements[0] });
      else if (field.elements.length > 1) out.push({ op, node: { tag: 0x20, values: field.elements } });
    }
    return out.sort((a, b) => a.op - b.op);
  }

  /** The actor's resting clip, or null when nothing structural supports one. */
  resolve(slot: number, rigs: Set<number>): ActorIdle | null {
    if (!rigs.size) return null;
    let portrait: ActorIdle | null = null;
    for (const { op, node } of this._genericFields(slot)) {
      const refs = this._fieldRefs(node);
      if (refs) {
        if (refs.length > this._maxRefs) continue;
        for (const ref of refs) {
          const classified = this._classify(ref, rigs, 0);
          if (!classified) continue;
          const clip = this._restClip(classified.kind === 'set' ? classified.primary : classified.clips);
          if (clip !== null) return { clip, source: 'animatic', field_op: op, controller: classified.controller };
        }
        continue;
      }
      if (portrait) continue;
      const value = this.assets.deref(node);
      if (value?.tag === 0x24 && Array.isArray(value.fields) && value.fields.length >= 5) {
        const fifth = this.assets.deref(value.fields[4]);
        const clip = fifth?.tag === 0x26 ? this.clipOfRecord().get(fifth.value) : undefined;
        if (clip !== undefined && rigs.has(this.animDir[clip]?.skel)) portrait = { clip, source: 'portrait', field_op: op, controller: null };
      }
    }
    if (portrait) return portrait;
    if (rigs.size === 1) {
      const clips = this._rigClipList([...rigs][0]);
      if (clips.length === 1) return { clip: clips[0], source: 'rig_single', field_op: -1, controller: null };
    }
    return null;
  }

  /** The props a controller attaches while its clip plays, in record order. */
  props(controller: number | null, rigs: Set<number>, meshRig: (mesh: number) => number | null): ActorIdleProp[] {
    if (controller === null || !this.rows[controller]) return [];
    const meshBySlot = this.assets.meshBySlot;
    const texturesByMaterial = this.assets.texturesByMaterial;
    const prop = (meshSlot: number, material: number, recolors: number[][] | null, matrix: number[] | null): ActorIdleProp | null => {
      const mesh = meshBySlot.get(meshSlot);
      const textures = texturesByMaterial.get(material);
      if (mesh === undefined || !textures || textures.length !== 1) return null;
      const rig = meshRig(mesh);
      if (rig === null || !rigs.has(rig)) return null;
      return { mesh_def_slot: meshSlot, mesh, material_slot: material, texture: textures[0], recolors, local_matrix: matrix };
    };
    const colour = (node: any): number[] | null => {
      const value = this.assets.deref(node);
      return value?.tag === 0x15 && Array.isArray(value.value) && value.value.length === 4
        && value.value.every((v: any) => Number.isFinite(v)) ? value.value.map(Number) : null;
    };
    const out: ActorIdleProp[] = [];
    let meshList: number[] | null = null;
    let materialList: number[] | null = null;
    for (const { node } of this._genericFields(controller)) {
      const value = this.assets.deref(node);
      if (value?.tag !== 0x20 || !Array.isArray(value.values) || !value.values.length) continue;
      const items = value.values.map((v: any) => this.assets.deref(v));
      // typed attachment records: mesh, material, tints, matrix
      if (items.every((item: any) => item?.tag === 0x24 && Array.isArray(item.fields) && item.fields.length >= 2)) {
        const records: ActorIdleProp[] = [];
        for (const item of items) {
          const fields = item.fields.map((f: any) => this.assets.deref(f));
          if (fields[0]?.tag !== 0x26 || fields[1]?.tag !== 0x02) { records.length = 0; break; }
          const tints = fields.slice(2).map(colour).filter((c: number[] | null) => c !== null) as number[][];
          const matrixNode = fields.find((f: any) => f?.tag === 0x30);
          const matrix = matrixNode && Array.isArray(matrixNode.value) && matrixNode.value.length === 12
            && matrixNode.value.every((v: any) => Number.isFinite(v)) ? matrixNode.value.map(Number) : null;
          const built = prop(fields[0].value, fields[1].value, tints.length >= 2 ? tints.slice(0, 3) : null, matrix);
          if (!built) { records.length = 0; break; }
          records.push(built);
        }
        if (records.length) return records;
        continue;
      }
      if (meshList === null && items.every((item: any) => item?.tag === 0x26 && meshBySlot.has(item.value))) {
        meshList = items.map((item: any) => item.value);
      } else if (materialList === null && items.every((item: any) => item?.tag === 0x02 && isInt(item.value))) {
        materialList = items.map((item: any) => item.value);
      }
    }
    if (meshList && materialList && meshList.length === materialList.length) {
      for (let i = 0; i < meshList.length; i++) {
        const built = prop(meshList[i], materialList[i], null, null);
        if (built) out.push(built);
      }
    }
    return out;
  }
}
