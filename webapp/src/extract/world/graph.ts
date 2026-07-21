// Native registry asset graph — resolves replayed AB0 rows (replay.js) and
// the decoded value pool (value-pool.js) into exact terrain / block-face /
// model mesh+material parts, occurrence anchors, and recolours.
//
// Occurrences come from room.js roomOccupancy (camelCase keys: entrySlot,
// rotationQuarters, packedFlags, parentLink, childLinks). Part records keep
// snake_case keys — they flow directly into shard rows.

// One replayed registry fill row. g: [op, depth, tag, value] events,
// r: [op, ref] direct refs, v: constructor values.
export interface RegistryRow {
  slot: number;
  selector: number;
  runtime: number;
  start: number;
  g: any[][];
  r: any[][];
  s: any[][];
  m: any[][];
  v: any[][];
  [key: string]: any;
}

// One decoded value-pool node ({tag, value?, values?, fields?, class?, ...}).
export interface PoolNode {
  tag: number;
  [key: string]: any;
}

// One decoded top-level generic field (see AssetGraph.fields).
export interface DecodedField {
  poolIndices: number[];
  elements: any[];
  leaves: [number, any][][];
  series: boolean;
}

// Resolved mesh/material part record (snake_case keys flow into shard rows).
export interface PartRecord {
  kind: string;
  mesh: number;
  material_slot: number;
  texture: number;
  [key: string]: any;
}

// One room occurrence as produced by room.js roomOccupancy.
export interface OccurrenceHit {
  record: number;
  resource: number;
  secondary: number | null;
  cell: number[];
  entrySlot: number;
  packed: number | null;
  rotationQuarters: number | null;
  packedFlags: number | null;
  individual: number | null;
  parentLink: number[] | null;
  childLinks: number[][];
  [key: string]: any;
}

export interface ModelGroup {
  mesh_op: number;
  material_op: number;
  parts: PartRecord[];
}

export const FACE_NAMES = [
  'top_rim', 'top_detail', 'top', 'bottom',
  'side_neg_y', 'side_pos_x', 'side_pos_y', 'side_neg_x',
];

// The current build lays a block/terrain owner's eight-face table at
// linkOp-13 relative to its ground-registry link (see _ensureBlockFaceOffset).
// A build detected at a different offset packs the appearance block more
// tightly, which changes two downstream heuristics — the default is the guard
// that keeps every supported build byte-identical.
const BLOCK_FACE_DEFAULT_OFFSET = -13;

export const IDENTITY_LOCAL_MATRIX_GAME = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
];

function rotateXY(x: number, y: number, quarterTurns: number): [number, number] {
  for (let k = quarterTurns & 3; k > 0; k--) { const t = x; x = -y; y = t; }
  return [x, y];
}

// Decode one native packed owner-alignment axis in mesh units.
export function nativeAxisAlignment(
  mode: number, selector: number, dimension: number,
  minimum: number, maximum: number, tileUnits: number,
): number {
  selector &= 3;
  if (selector === 0) return 0;
  const halfTile = tileUnits / 2;
  const halfExtent = halfTile * dimension;
  if (mode === 0 || mode === 1) {
    if (selector === 1) return -halfExtent - minimum;
    if (selector === 2) return -(minimum + maximum) / 2;
    return halfExtent - maximum;
  }
  if (mode === 2) return selector === 2 ? -(minimum + maximum) / 2 : -(minimum + maximum);
  if (mode === 3) return selector === 1 ? -halfTile : selector === 2 ? 0 : halfTile;
  if (mode === 4) return selector === 3 ? halfTile : 0;
  if (mode === 5) return selector === 2 ? -halfTile : 0;
  throw new Error(`unsupported generated-owner anchor mode ${mode}`);
}

const isInt = (v: any) => Number.isInteger(v);
const isNode = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

function unique<T>(values: Iterable<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) if (!seen.has(v)) { seen.add(v); out.push(v); }
  return out;
}

const matKey = (m: readonly number[]) => `${m[0]},${m[1]}`; // material = [slot, texture]

// Owner-series typed components store a FULL-range third colour (white = x1
// neutral); the stored/viewer convention is half-range (0.5 neutral, shader
// x2). Exact conversion at emission — see models.js nativeThirdToHalfRange.
function nativeThirdToHalfRange(color: number[]): number[] {
  return [color[0] * 0.5, color[1] * 0.5, color[2] * 0.5, ...color.slice(3)];
}

// Position-preserving resolver over native object rows and the value pool.
export class AssetGraph {
  rows: RegistryRow[];
  pool: PoolNode[];
  meshBySlot: Map<number, number>;         // registry slot -> ab5 mesh ordinal
  texturesByMaterial: Map<number, number[]>; // material slot -> ab3 texture ids
  private _leafCache: Map<number, [number, any][]>;      // pool index -> [tag, value][]
  private _elementCache: Map<number, [any[], boolean]>;  // pool index -> [elements[], explicitSeries]
  private _fieldCache: Map<number, Map<number, DecodedField>>; // owner slot -> Map(op -> field)
  private _splitLeafCache: Map<number, [number[], number[]]>;  // pool index -> [meshSlots[], materials[]]
  private _runtimeFaceBases: Map<number, number> | null;
  private _buildingRuntimeFaceBases: boolean;
  private _blockLayoutCache: Map<number, [number, number] | null>;
  private _groundFieldBaseCache: Map<number, number | null>;
  private _roomPartTemplateCache: Map<string, PartRecord[]>;
  private _anchorEnumCache: Map<number, [number, number] | null>;
  private _dimensionsCache: Map<number, number[] | null>;
  private _boundsCache: Map<number, number[] | null>;
  private _structuralOps: { dimsOps: number[]; boundsOp: number } | null;
  // Debug/provenance: the detected dims/bounds op positions + the sample they
  // were chosen from (null until dimensions3i/bounds3f is first called).
  structuralOpsAudit: {
    dims_ops: number[]; bounds_op: number; detected: boolean;
    voters: number; dims_fraction: number;
  } | null;
  private _blockFaceOffset: number | null;
  // Debug/provenance for the detected block/terrain face-table offset (see
  // _ensureBlockFaceOffset); null until the first block/terrain part resolve.
  blockFaceOffsetAudit: {
    offset: number; detected: boolean; voters: number; fraction: number;
  } | null;
  private _oneMeshCache: WeakMap<DecodedField, [number, number] | null>;
  private _oneMaterialCache: WeakMap<DecodedField, [number, number] | null>;

  constructor(
    rows: RegistryRow[], pool: PoolNode[],
    // Another AssetGraph's constructor-scan maps over the SAME rows. The scan
    // is pure and the maps are frozen at construction (never written again by
    // any consumer), so a second graph sharing them behaves exactly like one
    // that re-ran the scan — while every LAZY cache (fields, block layouts,
    // face-base learning) stays per-graph, preserving the fresh-graph
    // requirement of the structural-binding stage.
    shared?: { meshBySlot: Map<number, number>; texturesByMaterial: Map<number, number[]> },
  ) {
    this.rows = rows;
    this.pool = pool;
    if (shared) {
      this.meshBySlot = shared.meshBySlot;
      this.texturesByMaterial = shared.texturesByMaterial;
    } else {
      this.meshBySlot = new Map();
      this.texturesByMaterial = new Map();
      for (const row of rows) {
        // single allocation-light pass (hot: 240k rows; the ingest's second
        // graph reuses this scan via `shared`); semantics identical to
        // unique(filter/map) on 0x62 / 0x47 edges
        let mesh = -1;
        let meshCount = 0;       // distinct 0x62 edge values seen (0, 1, >1)
        let textures: number[] | null = null;
        for (const e of row.g) {
          const tag = e[2];
          if (tag === 0x62) {
            if (meshCount === 0) { mesh = e[3]; meshCount = 1; } else if (e[3] !== mesh) meshCount = 2;
          } else if (tag === 0x47) {
            if (textures === null) textures = [e[3]];
            else if (!textures.includes(e[3])) textures.push(e[3]);
          }
        }
        if (meshCount === 1) this.meshBySlot.set(row.slot, mesh);
        if (textures !== null) this.texturesByMaterial.set(row.slot, textures);
      }
    }
    this._leafCache = new Map();
    this._elementCache = new Map();
    this._fieldCache = new Map();
    this._splitLeafCache = new Map();
    this._runtimeFaceBases = null;
    this._buildingRuntimeFaceBases = false;
    this._blockLayoutCache = new Map();
    this._groundFieldBaseCache = new Map();
    this._roomPartTemplateCache = new Map();
    this._anchorEnumCache = new Map();     // pure-derivation caches (identical
    this._dimensionsCache = new Map();     // results; the occurrence loops
    this._boundsCache = new Map();         // are hot)
    this._structuralOps = null;
    this.structuralOpsAudit = null;
    this._blockFaceOffset = null;
    this.blockFaceOffsetAudit = null;
    this._oneMeshCache = new WeakMap();
    this._oneMaterialCache = new WeakMap();
  }

  deref(node: any, active: Set<number> | null = null): any {
    while (isNode(node) && node.tag === 0) {
      const index = node.value;
      if (!isInt(index) || index < 0 || index >= this.pool.length
        || (active !== null && active.has(index))) break;
      if (active === null) active = new Set();
      active.add(index);
      node = this.pool[index];
    }
    return node;
  }

  // Ordered pool field -> [elements, explicitSeries].
  elements(poolIndex: number): [any[], boolean] {
    const cached = this._elementCache.get(poolIndex);
    if (cached) return cached;
    const node = this.deref({ tag: 0, value: poolIndex });
    const computed: [any[], boolean] = isNode(node) && node.tag === 0x20
      ? [node.values || [], true] : [[node], false];
    this._elementCache.set(poolIndex, computed);
    return computed;
  }

  // Ordered [tag, value] asset leaves below one pool value.
  leaves(node: any, active: Set<number> | null = null): [number, any][] {
    if (!isNode(node)) return [];
    const tag = node.tag;
    const value = node.value;
    if (tag === 0) {
      if (!isInt(value) || value < 0 || value >= this.pool.length
        || (active !== null && active.has(value))) return [];
      const cached = this._leafCache.get(value);
      if (cached) return cached;
      if (active === null) active = new Set();
      active.add(value);
      const result = this.leaves(this.pool[value], active);
      active.delete(value);
      this._leafCache.set(value, result);
      return result;
    }
    const result: [number, any][] = [];
    if (tag === 0x02 || tag === 0x26 || tag === 0x47 || tag === 0x61 || tag === 0x62) {
      result.push([tag, value]);
    }
    for (const key of ['fields', 'values']) {
      const children = node[key];
      if (Array.isArray(children)) {
        for (const child of children) result.push(...this.leaves(child, active));
      }
    }
    if (isNode(value)) result.push(...this.leaves(value, active));
    return result;
  }

  // Top-level generic fields keyed by native reader operation number.
  fields(ownerSlot: number): Map<number, DecodedField> {
    let decoded = this._fieldCache.get(ownerSlot);
    if (decoded) return decoded;
    const grouped = new Map<number, number[]>(); // op -> pool indices, first-occurrence order
    for (const [op, depth, tag, value] of this.rows[ownerSlot].g) {
      if (depth === 0 && tag === 0 && value >= 0 && value < this.pool.length) {
        const list = grouped.get(op);
        if (list) list.push(value); else grouped.set(op, [value]);
      }
    }
    decoded = new Map();
    for (const [op, indices] of grouped) {
      const elements: any[] = [];
      let explicitSeries = false;
      for (const poolIndex of indices) {
        const [part, isSeries] = this.elements(poolIndex);
        elements.push(...part);
        explicitSeries = explicitSeries || isSeries;
      }
      decoded.set(op, {
        poolIndices: indices,
        elements,
        leaves: elements.map((element) => this.leaves(element)),
        series: explicitSeries || elements.length > 1,
      });
    }
    this._fieldCache.set(ownerSlot, decoded);
    return decoded;
  }

  static tagValues(field: DecodedField | null | undefined, tag: number): any[] {
    if (!field) return [];
    const out: any[] = [];
    for (const element of field.leaves) {
      for (const [leafTag, value] of element) if (leafTag === tag) out.push(value);
    }
    return unique(out);
  }

  // oneMesh/oneMaterial are pure functions of an immutable cached field +
  // graph state frozen at construction; the face/ground schema derivations
  // re-query the same fields many times, so memoize per field object.
  oneMesh(field: DecodedField | null | undefined): [number, number] | null {
    if (!field) return null;
    let result = this._oneMeshCache.get(field);
    if (result === undefined) {
      const slots = AssetGraph.tagValues(field, 0x26).filter((s) => this.meshBySlot.has(s));
      result = slots.length !== 1 ? null : [slots[0], this.meshBySlot.get(slots[0])!];
      this._oneMeshCache.set(field, result);
    }
    return result;
  }

  oneMaterial(field: DecodedField | null | undefined): [number, number] | null {
    if (!field) return null;
    let result = this._oneMaterialCache.get(field);
    if (result === undefined) {
      const slots = AssetGraph.tagValues(field, 0x02);
      if (slots.length !== 1) {
        result = null;
      } else {
        const textures = this.texturesByMaterial.get(slots[0]);
        result = !textures || textures.length !== 1 ? null : [slots[0], textures[0]];
      }
      this._oneMaterialCache.set(field, result);
    }
    return result;
  }

  private _oneRegistryCache = new WeakMap<DecodedField, number | null>();

  oneRegistry(field: DecodedField | null | undefined): number | null {
    if (!field) return null;
    let result = this._oneRegistryCache.get(field);
    if (result === undefined) {
      const slots = AssetGraph.tagValues(field, 0x26);
      result = slots.length === 1 ? (slots[0] as number) : null;
      this._oneRegistryCache.set(field, result);
    }
    return result;
  }

  // Resolve [family start, runtime, ordinal] for a six-way enum member.
  private _registryEnumFamilyMember(
    field: DecodedField | null | undefined,
  ): [number, number, number] | null {
    const slot = this.oneRegistry(field);
    if (slot === null || slot < 0 || slot >= this.rows.length) return null;
    const row = this.rows[slot];
    const values = row.v.filter((v) => v[0] === 1).map((v) => v[2]);
    if (values.length !== 1 || !isInt(values[0])) return null;
    const ordinal = values[0];
    if (ordinal < 0 || ordinal >= 6) return null;
    const start = slot - ordinal;
    const runtime = row.runtime;
    if (start < 0 || start + 6 > this.rows.length) return null;
    for (let expected = 0; expected < 6; expected++) {
      const member = this.rows[start + expected];
      const v = member.v;
      if (member.runtime !== runtime
        || v.length !== 2
        || v[0][0] !== 0 || v[0][1] !== 'U' || v[0][2] !== 0xFFFFFFFF
        || v[1][0] !== 1 || v[1][1] !== 'U' || v[1][2] !== expected
        || member.g.length || member.r.length || member.s.length || member.m.length) {
        return null;
      }
    }
    return [start, runtime, ordinal];
  }

  // The generated visual owner's two source anchor enums; located as the
  // unique adjacent field pair referencing one six-member enum family
  // (operations and registry ordinals both move between builds).
  ownerAnchorEnums(ownerSlot: number): [number, number] | null {
    if (this._anchorEnumCache.has(ownerSlot)) return this._anchorEnumCache.get(ownerSlot)!;
    const fields = this.fields(ownerSlot);
    const candidates: [number, number][] = [];
    for (const op of Array.from(fields.keys()).sort((a, b) => a - b)) {
      const first = this._registryEnumFamilyMember(fields.get(op));
      const second = this._registryEnumFamilyMember(fields.get(op + 1));
      if (first !== null && second !== null
        && first[0] === second[0] && first[1] === second[1]) {
        candidates.push([first[2], second[2]]);
      }
    }
    const result = candidates.length === 1 ? candidates[0] : null;
    this._anchorEnumCache.set(ownerSlot, result);
    return result;
  }

  // One exact tag-0x15 colour from a decoded generic field.
  color4f(field: DecodedField | null | undefined): number[] | null {
    if (!field || field.elements.length !== 1) return null;
    const node = this.deref(field.elements[0]);
    if (!isNode(node) || node.tag !== 0x15
      || !Array.isArray(node.value) || node.value.length !== 4
      || !node.value.every((v: any) => typeof v === 'number')) return null;
    return node.value.slice();
  }

  // The two structural op positions dimensions3i / bounds3f read are NOT fixed
  // across builds: the generated visual-owner header shifts wholesale (the
  // current build stores the XYZ cell dims at ops 4/5/6 with the tag-0x25
  // model-envelope box at op 8; the older 24090293 build stores them at ops
  // 1/2/3 with the box at op 5). Detect them lazily, build-agnostically, from
  // the owner data itself: a generated visual owner carries three consecutive
  // ops that are each a single positive tag-0x0A int (the cell dims),
  // IMMEDIATELY followed by a single tag-0x0B op, then a single tag-0x25
  // six-float box — a header no other class reproduces. Vote the run start and
  // the box op over a sample of owners matching that exact header and take the
  // modes. If too few match or the mode is not dominant, fall back to the
  // current-build positions (4/5/6, 8) — so a supported build stays
  // byte-identical and no build can silently mis-anchor.
  private _ensureStructuralOps(): { dimsOps: number[]; boundsOp: number } {
    if (this._structuralOps) return this._structuralOps;
    const DEFAULT_DIMS = [4, 5, 6];
    const DEFAULT_BOUNDS = 8;
    const singleNode = (fields: Map<number, DecodedField>, op: number): PoolNode | null => {
      const f = fields.get(op);
      if (!f || f.elements.length !== 1) return null;
      const node = this.deref(f.elements[0]);
      return isNode(node) ? node : null;
    };
    const isPositiveInt = (fields: Map<number, DecodedField>, op: number): boolean => {
      const node = singleNode(fields, op);
      return node !== null && node.tag === 0x0A && isInt(node.value) && node.value > 0;
    };
    const isTag0B = (fields: Map<number, DecodedField>, op: number): boolean => {
      const node = singleNode(fields, op);
      return node !== null && node.tag === 0x0B;
    };
    const isBox6 = (fields: Map<number, DecodedField>, op: number): boolean => {
      const node = singleNode(fields, op);
      return node !== null && node.tag === 0x25
        && Array.isArray(node.value) && node.value.length === 6
        && node.value.every((v: any) => typeof v === 'number');
    };
    const dimsVotes = new Map<number, number>();
    const boundsVotes = new Map<number, number>();
    let voters = 0;
    const VOTER_CAP = 4000;   // a decisive sample; extraction owners number 5-7k
    for (const row of this.rows) {
      if (voters >= VOTER_CAP) break;
      // cheap pre-gate: only rows rich enough in depth-0 generic fields to be a
      // generated visual owner are worth decoding.
      const seenOps = new Set<number>();
      for (const e of row.g) if (e[1] === 0 && e[2] === 0) seenOps.add(e[0]);
      if (seenOps.size < 5) continue;
      const fields = this.fields(row.slot);
      let start = -1;
      for (const s of Array.from(fields.keys()).sort((a, b) => a - b)) {
        if (isPositiveInt(fields, s) && isPositiveInt(fields, s + 1)
          && isPositiveInt(fields, s + 2) && isTag0B(fields, s + 3) && isBox6(fields, s + 4)) {
          start = s;
          break;
        }
      }
      if (start < 0) continue;
      voters++;
      dimsVotes.set(start, (dimsVotes.get(start) || 0) + 1);
      boundsVotes.set(start + 4, (boundsVotes.get(start + 4) || 0) + 1);
    }
    const mode = (m: Map<number, number>): [number, number] | null => {
      let best: [number, number] | null = null;
      for (const [key, count] of m) if (!best || count > best[1]) best = [key, count];
      return best;
    };
    const dm = mode(dimsVotes);
    const bm = mode(boundsVotes);
    const MIN_VOTERS = 8;
    const dimsFraction = dm && voters ? dm[1] / voters : 0;
    let dimsOps = DEFAULT_DIMS;
    let boundsOp = DEFAULT_BOUNDS;
    let detected = false;
    // A dominant, well-supported mode wins; anything else stays on the safe
    // current-build defaults (which cannot mis-anchor a supported build).
    if (dm && bm && voters >= MIN_VOTERS && dimsFraction >= 0.9) {
      dimsOps = [dm[0], dm[0] + 1, dm[0] + 2];
      boundsOp = bm[0];
      detected = true;
    }
    this.structuralOpsAudit = {
      dims_ops: dimsOps, bounds_op: boundsOp, detected, voters, dims_fraction: dimsFraction,
    };
    this._structuralOps = { dimsOps, boundsOp };
    return this._structuralOps;
  }

  // The block/terrain face table's start relative to its ground-registry link
  // op is NOT fixed across builds. The current build lays face 0 at linkOp-13
  // (the direct-material fallback sits at linkOp-3, the eight-face run 10 ops
  // below it); the older a14d7c633469a266 build packs the shape-owner
  // appearance block one field tighter — face 0 at linkOp-12, fallback still at
  // linkOp-3, the run only 9 ops below. Reading the current -13 there lands the
  // base one op too low: every face mesh is tagged one face_index too high, the
  // eighth face (at faceBase+8) falls outside the 0..7 window and is dropped,
  // and positional ground materials pair to the wrong face. _candidateBlockOwners
  // / _blockLayout / _faceBase / faceParts all consume this offset.
  //
  // Detect it build-agnostically. For every shape owner, take firstMeshOp minus
  // the closest registry link that carries a fallback material at linkOp-3 (that
  // -3 relation is stable on every build) and sits in the plausible face-table
  // window above the first mesh. When the rim (face 0) is present firstMeshOp ==
  // faceBase, so that difference IS the offset; owners whose rim/detail faces are
  // empty vote offset+1/+2 and stay behind the rim-present mode. A decisive,
  // dominant, clearly-winning mode is taken; anything else falls back to the
  // current-build -13, so a supported build stays byte-identical.
  private _ensureBlockFaceOffset(): number {
    if (this._blockFaceOffset !== null) return this._blockFaceOffset;
    const DEFAULT = BLOCK_FACE_DEFAULT_OFFSET;
    const votes = new Map<number, number>();
    let voters = 0;
    const VOTER_CAP = 8000;
    for (const row of this.rows) {
      if (voters >= VOTER_CAP) break;
      // cheap pre-gate: only rows with enough depth-0 generic field markers to
      // be a shape owner are worth decoding (same gate _ensureStructuralOps uses).
      let markers = 0;
      for (const e of row.g) if (e[1] === 0 && e[2] === 0) markers++;
      if (markers < 5) continue;
      const fields = this.fields(row.slot);
      const ops = Array.from(fields.keys()).sort((a, b) => a - b);
      let firstMesh = -1;
      for (const op of ops) { if (this.oneMesh(fields.get(op)) !== null) { firstMesh = op; break; } }
      if (firstMesh < 0) continue;
      // closest registry link above the first mesh, in the plausible face-table
      // window, whose fallback material is at linkOp-3.
      let linkOp = -1;
      for (const op of ops) {
        const delta = op - firstMesh;
        if (delta < 9 || delta > 16) continue;
        if (this.oneRegistry(fields.get(op)) === null) continue;
        if (this.oneMaterial(fields.get(op - 3)) === null) continue;
        linkOp = op;
        break;
      }
      if (linkOp < 0) continue;
      voters++;
      const d = firstMesh - linkOp;
      votes.set(d, (votes.get(d) || 0) + 1);
    }
    let best: [number, number] | null = null;      // [offset, count]
    let second = -1;
    for (const [offset, count] of votes) {
      if (!best || count > best[1]) { second = best ? best[1] : -1; best = [offset, count]; }
      else if (count > second) second = count;
    }
    const MIN_VOTERS = 64;
    let offset = DEFAULT;
    let detected = false;
    const fraction = best && voters ? best[1] / voters : 0;
    // Decisive mode: enough voters, a clear plurality, and at least double the
    // runner-up so an adjacent offset can never edge it out.
    if (best && voters >= MIN_VOTERS && fraction >= 0.5 && (second < 0 || best[1] >= 2 * second)) {
      offset = best[0];
      detected = true;
    }
    this.blockFaceOffsetAudit = { offset, detected, voters, fraction };
    this._blockFaceOffset = offset;
    return offset;
  }

  // The direct-material fallback op relative to a block face base: the eight
  // faces plus (build-specific) trailing gap sit between it and the ground link.
  private _fallbackRel(): number { return -this._ensureBlockFaceOffset() - 3; }

  // One exact tag-0x25 min/max box; generated visual owners store their
  // model-space envelope at the detected bounds op (8 on the current build).
  bounds3f(ownerSlot: number, operation?: number): number[] | null {
    const boundsOp = this._ensureStructuralOps().boundsOp;
    const op = operation ?? boundsOp;
    if (op === boundsOp && this._boundsCache.has(ownerSlot)) {
      return this._boundsCache.get(ownerSlot)!;
    }
    let result: number[] | null = null;
    const field = this.fields(ownerSlot).get(op);
    if (field && field.elements.length === 1) {
      const node = this.deref(field.elements[0]);
      if (isNode(node) && node.tag === 0x25
        && Array.isArray(node.value) && node.value.length === 6
        && node.value.every((v: any) => typeof v === 'number')) {
        result = node.value.slice();
        for (let k = 0; k < 3; k++) {
          if (result![k] > result![k + 3]) {
            throw new Error(`owner ${ownerSlot} operation ${op} has inverted bounds`);
          }
        }
      }
    }
    if (op === boundsOp) this._boundsCache.set(ownerSlot, result);
    return result;
  }

  // One visual owner's exact positive XYZ cell dimensions at the detected dims
  // ops (4/5/6 on the current build; auto-detected per build via
  // _ensureStructuralOps).
  dimensions3i(ownerSlot: number): number[] | null {
    if (this._dimensionsCache.has(ownerSlot)) return this._dimensionsCache.get(ownerSlot)!;
    const { dimsOps } = this._ensureStructuralOps();
    let result: number[] | null = [];
    const fields = this.fields(ownerSlot);
    for (const operation of dimsOps) {
      const field = fields.get(operation);
      if (!field || field.elements.length !== 1) { result = null; break; }
      const node = this.deref(field.elements[0]);
      if (!isNode(node) || node.tag !== 0x0A || !isInt(node.value) || node.value <= 0) {
        result = null;
        break;
      }
      result.push(node.value);
    }
    this._dimensionsCache.set(ownerSlot, result);
    return result;
  }

  // [x, y, semanticKind] for one class-351 occurrence: the rotated direct
  // generated-owner cardinal centre, plus optional native axis alignment from
  // packed bits 3..6 composed after bit-0x4 reflection and the quarter-turn.
  occurrenceAnchor(
    hit: OccurrenceHit,
    { tileUnits = 1024, meshForwardQuarterTurns = 2 }:
      { tileUnits?: number; meshForwardQuarterTurns?: number } = {},
  ): [number, number, string] {
    const [x, y] = hit.cell;
    const dimensions = this.dimensions3i(hit.resource);
    if (dimensions === null) {
      throw new Error(`owner ${hit.resource} has no positive XYZ dimensions`);
    }
    let [width, height] = dimensions;
    const turns = ((hit.rotationQuarters ?? 0) + meshForwardQuarterTurns) & 3;
    if (turns & 1) { const t = width; width = height; height = t; }
    let kind = 'owner_dimensions';
    if ((hit.secondary !== null || hit.parentLink !== null) && width === 1 && height === 1) {
      kind = 'cell_center';
    }
    let anchorX = x + width / 2;
    let anchorY = y + height / 2;

    const packed = hit.packedFlags ?? 0;
    const selectorX = (packed >> 3) & 3;
    const selectorY = (packed >> 5) & 3;
    const modes = this.ownerAnchorEnums(hit.resource);
    const bounds = this.bounds3f(hit.resource);
    if (modes !== null && bounds !== null && (selectorX || selectorY)) {
      let localX = nativeAxisAlignment(
        modes[0], selectorX, dimensions[0], bounds[0], bounds[3], tileUnits,
      );
      const localY = nativeAxisAlignment(
        modes[1], selectorY, dimensions[1], bounds[1], bounds[4], tileUnits,
      );
      if (packed & 0x4) localX = -localX;
      const [offsetX, offsetY] = rotateXY(localX, localY, hit.rotationQuarters ?? 0);
      if (offsetX || offsetY) {
        anchorX += offsetX / tileUnits;
        anchorY += offsetY / tileUnits;
        kind = 'owner_bounds_alignment';
      }
    }
    return [anchorX, anchorY, kind];
  }

  // Derive the generated ground material field base from value shape: uniform
  // colours immediately follow the first material, per-face colours finish 33
  // operations after it (operation numbers move between builds).
  private _groundFieldBase(groundSlot: number | null | undefined): number | null {
    if (groundSlot === null || groundSlot === undefined
      || groundSlot < 0 || groundSlot >= this.rows.length) return null;
    if (this._groundFieldBaseCache.has(groundSlot)) {
      return this._groundFieldBaseCache.get(groundSlot)!;
    }
    const fields = this.fields(groundSlot);
    const ops = Array.from(fields.keys()).sort((a, b) => a - b);
    const materials = ops.filter((op) => this.oneMaterial(fields.get(op)) !== null);
    const colors = ops.filter((op) => this.color4f(fields.get(op)) !== null);
    let base: number | null = null;
    if (colors.length) {
      if (colors.length >= 20 || colors[colors.length - 1] - colors[0] >= 20) {
        const candidate = colors[colors.length - 1] - 33;
        const colorMatches = colors.filter(
          (op) => candidate + 8 <= op && op <= candidate + 33,
        ).length;
        const materialMatches = materials.filter(
          (op) => candidate <= op && op <= candidate + 7,
        ).length;
        if (candidate >= 0 && colorMatches === colors.length
          && (!materials.length || materialMatches >= 6)) {
          base = candidate;
        }
      } else {
        const candidate = colors[0] - 1;
        if (candidate >= 0
          && colors.every((op) => candidate + 1 <= op && op <= candidate + 3)
          && materials.every((op) => candidate <= op && op <= candidate + 7)) {
          base = candidate;
        }
      }
    } else if (materials.length) {
      let best: [number, number] | null = null; // max (count, candidate)
      for (const candidate of materials) {
        const count = materials.filter((op) => candidate <= op && op <= candidate + 7).length;
        if (!best || count > best[0] || (count === best[0] && candidate > best[1])) {
          best = [count, candidate];
        }
      }
      if (best![0] >= 6) base = best![1];
    }
    this._groundFieldBaseCache.set(groundSlot, base);
    return base;
  }

  // Exact stored ground colours plus their generated schema. A compact
  // uniform family omits the unused second tint (uniform_tint_modulation).
  groundRecolorData(
    groundSlot: number | null | undefined, faceIndex = 0,
  ): { recolors: number[][]; recolor_schema: string } | null {
    if (groundSlot === null || groundSlot === undefined
      || faceIndex < 0 || faceIndex >= FACE_NAMES.length) return null;
    const base = this._groundFieldBase(groundSlot);
    if (base === null) return null;
    const fields = this.fields(groundSlot);
    const decoded = (start: number) => {
      const colors = [0, 1, 2].map((k) => this.color4f(fields.get(start + k)));
      if (colors.every((c) => c !== null)) {
        return { recolors: colors.map((c) => c!.slice()), recolor_schema: 'two_tints_modulation' };
      }
      if (colors[0] !== null && colors[1] === null && colors[2] !== null) {
        return {
          recolors: [colors[0].slice(), colors[2].slice()],
          recolor_schema: 'uniform_tint_modulation',
        };
      }
      if (colors[0] !== null && colors[1] !== null && colors[2] === null) {
        // Two tints with the output-modulation colour absent. An absent
        // modulation is the native neutral half-range (0.5) — the same default
        // recolor.ts materialState falls back to — so make it explicit and let
        // the standard 3-value two_tints_modulation schema handle it unchanged.
        // Without this the whole triple (incl. the two authored tints) was
        // dropped, losing real colours on block-face objects.
        return {
          recolors: [colors[0].slice(), colors[1].slice(), [0.5, 0.5, 0.5, 1]],
          recolor_schema: 'two_tints_modulation',
        };
      }
      return null;
    };
    // Two owner-wide defaults precede the per-face triples.
    return decoded(base + 10 + 3 * faceIndex) || decoded(base + 1);
  }

  groundRecolors(groundSlot: number | null | undefined, faceIndex = 0): number[][] | null {
    const data = this.groundRecolorData(groundSlot, faceIndex);
    return data === null ? null : data.recolors;
  }

  // Typed recolours plus (on the current build) a row-major game-space affine on
  // one pooled element. Older builds pack the same meshmat one field shorter:
  // arity 5 (mesh, material, 3 colours) with NO trailing matrix, vs the current
  // build's arity 6 (…, 0x30 matrix). The colour triple sits at [2,3,4] on every
  // build — detect the arity and only expect/emit the matrix when it's there, so
  // the recolour is recovered on old builds while the current build stays
  // byte-identical (it has no arity-5 meshmat nodes with a colour triple here).
  private _typedPartMetadata(element: any): Record<string, any> {
    const node = this.deref(element);
    if (!isNode(node) || node.tag !== 0x24 || !Array.isArray(node.fields)
      || (node.fields.length !== 6 && node.fields.length !== 5)) return {};
    const hasMatrix = node.fields.length === 6;
    const fields = node.fields.map((f: any) => this.deref(f));
    const colors = fields.slice(2, 5);
    if (!colors.every((c: any) => isNode(c) && c.tag === 0x15
        && Array.isArray(c.value) && c.value.length === 4)) return {};
    const matrix = hasMatrix ? fields[5] : null;
    if (hasMatrix && (!isNode(matrix) || matrix.tag !== 0x30
        || !Array.isArray(matrix.value) || matrix.value.length !== 12)) return {};
    const recolors = colors.map((c: any) => c.value.slice());
    recolors[2] = nativeThirdToHalfRange(recolors[2]);
    const metadata: Record<string, any> = {
      typed_class: node.class,
      typed_schema: hasMatrix ? 'mesh_material_colors3_matrix3x4' : 'mesh_material_colors3',
      recolors,
    };
    if (hasMatrix) metadata.local_matrix_game = matrix.value.slice();
    return metadata;
  }

  // ---------------------------------------------------------- block faces

  // Derive the eight-face field base from paired structure (June uses 33..40
  // where the current build uses 36..43; only the relative schema is stable).
  private _faceBase(shapeSlot: number, groundSlot: number | null | undefined): number | null {
    const fallbackRel = this._fallbackRel();   // direct-material op relative to face 0
    const shape = this.fields(shapeSlot);
    const ground = groundSlot !== null && groundSlot !== undefined
      ? this.fields(groundSlot) : new Map<number, DecodedField>();
    const groundBase = this._groundFieldBase(groundSlot ?? null);
    let groundMaterialCount = 0;
    if (groundBase !== null) {
      for (let k = 0; k < 8; k++) {
        if (this.oneMaterial(ground.get(groundBase + k)) !== null) groundMaterialCount++;
      }
    }
    // A single ground material is the generated uniform-material form and
    // carries no face-zero alignment evidence.
    const positionalGround = groundMaterialCount > 1;
    const candidates = new Set<number>();
    for (const [op, field] of shape) {
      if (this.oneMesh(field) === null) continue;
      for (let k = 0; k < 8 && op >= k; k++) candidates.add(op - k);
    }
    const ranked: [number[], number][] = [];
    for (const base of candidates) {
      let faces = 0;
      let aligned = 0;
      for (let k = 0; k < 8; k++) {
        const hasMesh = this.oneMesh(shape.get(base + k)) !== null;
        if (hasMesh) faces++;
        if (hasMesh && positionalGround && groundBase !== null
          && this.oneMaterial(ground.get(groundBase + k)) !== null) aligned++;
      }
      const fallback = this.oneMaterial(shape.get(base + fallbackRel)) !== null ? 1 : 0;
      if (aligned || (faces && fallback)) ranked.push([[aligned, faces, fallback], base]);
    }
    if (!ranked.length) return null;
    let top = ranked[0][0];
    for (const [score] of ranked) {
      if (score[0] > top[0] || (score[0] === top[0] && (score[1] > top[1]
        || (score[1] === top[1] && score[2] > top[2])))) top = score;
    }
    const tied = ranked.filter(([score]) => score[0] === top[0]
      && score[1] === top[1] && score[2] === top[2]).map(([, base]) => base);
    if (tied.length > 1) {
      const runtimeBase = this._runtimeFaceBase(shapeSlot);
      return runtimeBase !== null && tied.includes(runtimeBase) ? runtimeBase : null;
    }
    // Unique top score: the max-score entry's base.
    return tied[0];
  }

  private _candidateBlockOwnersCache: number[] | null = null;

  private _candidateBlockOwners(): number[] {
    if (this._candidateBlockOwnersCache) return this._candidateBlockOwnersCache;
    const offset = this._ensureBlockFaceOffset();   // face 0 relative to the ground link
    const owners: number[] = [];
    for (const row of this.rows) {
      const ops = new Set<number>();
      for (const [op, depth, tag] of row.g) if (depth === 0 && tag === 0) ops.add(op);
      let found = false;
      for (const linkOp of ops) {
        if (linkOp + offset < 0 || !ops.has(linkOp - 3)) continue;
        for (let k = 0; k < 8; k++) {
          if (ops.has(linkOp + offset + k)) { found = true; break; }
        }
        if (found) break;
      }
      if (found) owners.push(row.slot);
    }
    this._candidateBlockOwnersCache = owners;
    return owners;
  }

  // Use self-proving layouts to resolve ambiguous generated face runs; fall
  // back to the unique dominant base across the whole registry (36 current,
  // 33 June).
  private _runtimeFaceBase(ownerSlot: number): number | null {
    if (this._buildingRuntimeFaceBases) return null;
    if (this._runtimeFaceBases === null) {
      this._buildingRuntimeFaceBases = true;
      const byRuntime = new Map<number, Map<number, number>>(); // runtime -> Map(base -> count)
      try {
        for (const candidate of this._candidateBlockOwners()) {
          const layout = this._blockLayout(candidate);
          if (layout === null) continue;
          const runtime = this.rows[candidate].runtime;
          let counts = byRuntime.get(runtime);
          if (!counts) { counts = new Map(); byRuntime.set(runtime, counts); }
          counts.set(layout[0], (counts.get(layout[0]) || 0) + 1);
        }
        this._runtimeFaceBases = new Map();
        for (const [runtime, counts] of byRuntime) {
          let best: number | null = null;
          let bestCount = -1;
          let unique = true;
          for (const [base, count] of counts) {
            if (count > bestCount) { best = base; bestCount = count; unique = true; }
            else if (count === bestCount) unique = false;
          }
          if (counts.size === 1 || unique) this._runtimeFaceBases.set(runtime, best!);
        }
      } finally {
        this._buildingRuntimeFaceBases = false;
        // Ambiguous owners examined while learning had no fallback yet; let
        // their real call retry against the completed evidence.
        for (const [slot, layout] of Array.from(this._blockLayoutCache)) {
          if (layout === null) this._blockLayoutCache.delete(slot);
        }
      }
    }
    const bases = this._runtimeFaceBases!;
    const runtimeBase = bases.get(this.rows[ownerSlot].runtime);
    if (runtimeBase !== undefined) return runtimeBase;
    const counts = new Map<number, number>();
    for (const base of bases.values()) {
      counts.set(base, (counts.get(base) || 0) + 1);
    }
    let best: number | null = null;
    let bestCount = -1;
    let second = -1;
    for (const [base, count] of counts) {
      if (count > bestCount) { second = bestCount; best = base; bestCount = count; }
      else if (count > second) second = count;
    }
    if (bestCount < 4 || (counts.size > 1 && bestCount <= second)) return null;
    return best;
  }

  // An owner's unique repeated generated face fallback (base+10 relative to
  // the base+13 ground link); repeated newer face-table copies bind it only.
  private _repeatedFaceFallbackMaterial(
    fields: Map<number, DecodedField>,
  ): [number, number] | null {
    const counts = new Map<string, [number, [number, number]]>(); // key -> [count, material]
    for (const [linkOp, field] of fields) {
      if (linkOp < 3 || this.oneRegistry(field) === null) continue;
      const material = this.oneMaterial(fields.get(linkOp - 3));
      if (material === null) continue;
      const key = matKey(material);
      const entry = counts.get(key);
      if (entry) entry[0]++; else counts.set(key, [1, material]);
    }
    let best: [number, number] | null = null;
    let bestCount = -1;
    let second = -1;
    for (const [, [count, material]] of counts) {
      if (count > bestCount) { second = bestCount; best = material; bestCount = count; }
      else if (count > second) second = count;
    }
    if (bestCount < 2 || (counts.size > 1 && bestCount <= second)) return null;
    return best;
  }

  // A structurally proven [face base, ground owner] pair, or null.
  private _blockLayout(ownerSlot: number): [number, number] | null {
    if (this._blockLayoutCache.has(ownerSlot)) return this._blockLayoutCache.get(ownerSlot)!;
    const shape = this.fields(ownerSlot);
    const repeatedDefault = this._repeatedFaceFallbackMaterial(shape);
    const repeatedKey = repeatedDefault === null ? null : matKey(repeatedDefault);
    const offset = this._ensureBlockFaceOffset();   // face 0 relative to the ground link
    const fallbackRel = this._fallbackRel();
    const candidates: { score: [number, number, number]; base: number; ground: number }[] = [];
    for (const [linkOp, field] of shape) {
      const groundSlot = this.oneRegistry(field);
      const base = linkOp + offset;
      if (groundSlot === null || base < 0 || groundSlot >= this.rows.length) continue;
      const ground = this.fields(groundSlot);
      const groundBase = this._groundFieldBase(groundSlot);
      let aligned = 0;
      let informativeAligned = 0;
      let faces = 0;
      for (let k = 0; k < 8; k++) {
        const hasMesh = this.oneMesh(shape.get(base + k)) !== null;
        if (hasMesh) faces++;
        if (!hasMesh || groundBase === null) continue;
        const material = this.oneMaterial(ground.get(groundBase + k));
        if (material === null) continue;
        aligned++;
        if (repeatedKey === null || matKey(material) !== repeatedKey) informativeAligned++;
      }
      const fallback = this.oneMaterial(shape.get(base + fallbackRel)) !== null;
      if (!aligned && !(faces && fallback)) continue;
      candidates.push({ score: [informativeAligned, aligned, faces], base, ground: groundSlot });
    }
    if (!candidates.length) {
      this._blockLayoutCache.set(ownerSlot, null);
      return null;
    }
    let top = candidates[0].score;
    for (const { score } of candidates) {
      if (score[0] > top[0] || (score[0] === top[0] && (score[1] > top[1]
        || (score[1] === top[1] && score[2] > top[2])))) top = score;
    }
    let best = candidates.filter(({ score }) => score[0] === top[0]
      && score[1] === top[1] && score[2] === top[2]);
    if (best.length > 1) {
      const learnedBase = this._runtimeFaceBase(ownerSlot);
      const learned = best.filter((c) => c.base === learnedBase);
      if (learned.length === 1) {
        best = learned;
      } else {
        const signature = ({ base, ground: groundSlot }: { base: number; ground: number }) => {
          const ground = this.fields(groundSlot);
          const groundBase = this._groundFieldBase(groundSlot);
          const materials: ([number, number] | null)[] = [];
          for (let k = 0; k < 8; k++) {
            materials.push(groundBase !== null
              ? this.oneMaterial(ground.get(groundBase + k)) : null);
          }
          const present = materials.filter((m) => m !== null);
          const uniform = present.length === 1 ? present[0] : null;
          const fallback = this.oneMaterial(shape.get(base + fallbackRel));
          const bindings: any[] = [];
          for (let k = 0; k < 8; k++) {
            const mesh = this.oneMesh(shape.get(base + k));
            const material = materials[k] || uniform || fallback;
            if (mesh !== null && material !== null) bindings.push([k, mesh, material]);
          }
          // The ground owner remains part of the identity because equal
          // material slots can carry different recolour fields.
          return [groundSlot, bindings] as [number, any[]];
        };
        const signatures = new Set(best.map((c) => JSON.stringify(signature(c))));
        if (signatures.size !== 1 || !signature(best[0])[1].length) {
          this._blockLayoutCache.set(ownerSlot, null);
          return null;
        }
        // Equal ground+binding signatures prove tied runs are visual copies;
        // retain the first run.
        best = best.slice().sort((a, b) => a.base - b.base);
      }
    }
    const layout: [number, number] = [best[0].base, best[0].ground];
    this._blockLayoutCache.set(ownerSlot, layout);
    return layout;
  }

  // Pair a block's eight directional mesh/material fields by position.
  faceParts(
    shapeSlot: number, groundSlot: number | null = null,
    kind = 'block_face', faceBase: number | null = null,
  ): PartRecord[] {
    const shape = this.fields(shapeSlot);
    const ground = groundSlot !== null ? this.fields(groundSlot) : new Map<number, DecodedField>();
    if (faceBase === null) faceBase = this._faceBase(shapeSlot, groundSlot);
    if (faceBase === null) return [];
    const groundBase = this._groundFieldBase(groundSlot);
    const fallbackOp = faceBase + this._fallbackRel();
    const fallback = this.oneMaterial(shape.get(fallbackOp));
    const groundMaterials: [number, [number, number]][] = [];
    if (groundBase !== null) {
      for (let op = groundBase; op < groundBase + 8; op++) {
        const material = this.oneMaterial(ground.get(op));
        if (material !== null) groundMaterials.push([op, material]);
      }
    }
    const distinctGround = new Set(groundMaterials.map(([, m]) => matKey(m)));
    const isUniformGround = groundMaterials.length === 1;
    const uniformGround = isUniformGround && distinctGround.size === 1
      ? groundMaterials[0] : null;
    const result: PartRecord[] = [];
    for (let index = 0; index < FACE_NAMES.length; index++) {
      const mesh = this.oneMesh(shape.get(faceBase + index));
      let materialOp = groundBase !== null ? groundBase + index : -1;
      let material = materialOp >= 0 ? this.oneMaterial(ground.get(materialOp)) : null;
      let usedUniformGround = false;
      if (material === null && uniformGround !== null) {
        [materialOp, material] = uniformGround;
        usedUniformGround = true;
      }
      if (material === null) { materialOp = fallbackOp; material = fallback; }
      if (mesh === null || material === null) continue;
      const part: PartRecord = {
        kind,
        face_index: index,
        face_name: FACE_NAMES[index],
        mesh_field_op: faceBase + index,
        material_field_op: materialOp,
        mesh_def_slot: mesh[0],
        mesh: mesh[1],
        material_slot: material[0],
        texture: material[1],
        ground_resource: groundSlot,
        confidence: 'exact_positional_face_schema',
      };
      if (usedUniformGround) part.used_uniform_ground_material = true;
      const recolorData = this.groundRecolorData(groundSlot, index);
      if (recolorData !== null) Object.assign(part, recolorData);
      if (fallback !== null && matKey(fallback) !== matKey(material)) {
        part.fallback_material_slot = fallback[0];
        part.fallback_texture = fallback[1];
      }
      result.push(part);
    }
    return result;
  }

  // Use a direct material when a face table names an empty sentinel.
  static selectTexture(
    part: PartRecord, available: (texture: number) => boolean,
  ): PartRecord | null {
    if (available(part.texture)) return part;
    const fallback = part.fallback_texture;
    if (fallback === undefined || fallback === null || !available(fallback)) return null;
    return {
      ...part,
      material_slot: part.fallback_material_slot,
      texture: fallback,
      used_material_fallback: true,
    };
  }

  terrainParts(shapeSlot: number, groundSlot: number | null): PartRecord[] {
    const shape = this.fields(shapeSlot);
    const ground = groundSlot !== null && groundSlot !== undefined
      ? this.fields(groundSlot) : new Map<number, DecodedField>();
    const groundBase = this._groundFieldBase(groundSlot ?? null);
    const material = groundBase !== null ? this.oneMaterial(ground.get(groundBase)) : null;
    const customCandidates: [number, [number, number], [number, number]][] = [];
    for (const [op, field] of shape) {
      if (op <= 0) continue;
      const mesh = this.oneMesh(shape.get(op - 1));
      const fieldMaterial = this.oneMaterial(field);
      if (mesh !== null && fieldMaterial !== null) customCandidates.push([op, mesh, fieldMaterial]);
    }
    let custom = customCandidates.length === 1 ? customCandidates[0] : null;
    // The single-(mesh,material) custom-terrain heuristic assumes such a pair
    // means the whole tile is one authored mesh. On a build whose appearance
    // block is packed tighter than the current one (detected offset != the
    // default), a NORMAL eight-face block's repeated face-table copy leaves its
    // trailing face mesh immediately before the shape's fallback material,
    // forging exactly one such pair — so the block collapses to a single wall
    // slab (85% of the older build's terrain, vs a real custom mesh being a
    // rare exact subtype). If the owner still resolves a genuine multi-face
    // block, it is a block, not a custom mesh; prefer the faces. Guarded on the
    // detected offset, so the current build's exact custom-terrain subtype (its
    // faces alias the same heuristic there) ships byte-identical.
    if (custom !== null && this._ensureBlockFaceOffset() !== BLOCK_FACE_DEFAULT_OFFSET) {
      const guardBase = this._faceBase(shapeSlot, groundSlot);
      if (guardBase !== null
        && this.faceParts(shapeSlot, groundSlot, 'terrain_face', guardBase).length >= 2) {
        custom = null;
      }
    }
    const mesh = custom !== null ? custom[1] : null;
    const fallback = custom !== null ? custom[2] : null;
    if (mesh !== null && material !== null) {
      const fallbackOp = custom![0];
      const part: PartRecord = {
        kind: 'terrain_custom_mesh',
        mesh_field_op: fallbackOp - 1,
        material_field_op: groundBase,
        mesh_def_slot: mesh[0],
        mesh: mesh[1],
        material_slot: material[0],
        texture: material[1],
        ground_resource: groundSlot,
        confidence: 'exact_native_custom_terrain_schema',
      };
      const recolorData = this.groundRecolorData(groundSlot, 0);
      if (recolorData !== null) Object.assign(part, recolorData);
      if (fallback !== null && matKey(fallback) !== matKey(material)) {
        part.fallback_material_slot = fallback[0];
        part.fallback_texture = fallback[1];
      }
      return [part];
    }
    const typedGroups: PartRecord[] = [];
    const typedOps = new Set<number>();
    for (const group of this.modelGroups(shapeSlot)) {
      for (const staticPart of group.parts) {
        if (staticPart.typed_schema !== 'mesh_material_colors3_matrix3x4') continue;
        typedGroups.push({
          ...staticPart,
          kind: 'terrain_model_part',
          ground_resource: groundSlot,
        });
        typedOps.add(group.mesh_op);
      }
    }
    if (typedOps.size === 1) return typedGroups;
    const faceBase = this._faceBase(shapeSlot, groundSlot);
    return this.faceParts(shapeSlot, groundSlot, 'terrain_face', faceBase);
  }

  blockParts(ownerSlot: number): PartRecord[] {
    const layout = this._blockLayout(ownerSlot);
    if (layout === null) return [];
    return this.faceParts(ownerSlot, layout[1], 'block_face', layout[0]);
  }

  // Deduplicated exact face/material bindings for the editor catalog. Shape
  // owners carry meshes, the linked ground object the materials; records are
  // qualified by owner, ground, kind and face, and repeated room occurrences
  // only increment provenance counts. Texture bindings only — never promoted
  // to Models. roomOccurrenceGroups: iterable of [roomId, occurrences].
  structuralBindingRecords(
    roomOccurrenceGroups: Iterable<[number, OccurrenceHit[]]> = [],
  ): any[] {
    const grouped = new Map<string, { record: any; rooms: Set<number> }>();

    const freeze = (value: any): string => {
      if (Array.isArray(value)) return `[${value.map(freeze).join(',')}]`;
      if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((k) => `${k}:${freeze(value[k])}`).join(',')}}`;
      }
      return `${typeof value}:${value}`;
    };

    // The same immutable cached part template is added once per occurrence
    // (hundreds of times across rooms); resolve its grouped entry once per
    // (part, rule|owner) and reuse it — the contextKey/freeze computation is
    // unchanged, so identical parts from different caches still merge.
    const entryMemo = new WeakMap<PartRecord, Map<string, { record: any; rooms: Set<number> }>>();

    const add = (
      ownerSlot: number, part: PartRecord, rule: string, source: string,
      roomId: number | null = null,
    ) => {
      if (!(ownerSlot >= 0 && ownerSlot < this.rows.length)) return;
      const row = this.rows[ownerSlot];
      const texture = part.texture;
      const material = part.material_slot;
      if (!Number.isInteger(texture) || !Number.isInteger(material)) return;
      const memoKey = `${rule}|${ownerSlot}`;
      let perPart = entryMemo.get(part);
      const memoized = perPart?.get(memoKey);
      if (memoized !== undefined) {
        if (roomId !== null) {
          memoized.record.structural_context.occurrence_count += 1;
          memoized.rooms.add(roomId);
        }
        return;
      }
      const fallbackMaterial = part.fallback_material_slot ?? null;
      const fallbackTexture = part.fallback_texture ?? null;
      const seriesIndex = 'face_index' in part ? part.face_index
        : ('series_index' in part ? part.series_index : 0);
      const contextKey = freeze([
        rule, ownerSlot, part.ground_resource ?? null, part.kind ?? null,
        part.face_index ?? null, seriesIndex, part.mesh_def_slot ?? null,
        part.mesh ?? null, material, texture,
        fallbackMaterial, fallbackTexture,
        part.recolors ?? null, part.recolor_schema ?? null,
        part.local_matrix_game ?? null,
      ]);
      let existing = grouped.get(contextKey);
      if (existing === undefined) {
        const context: Record<string, any> = {
          source,
          kind: part.kind ?? null,
          ground_resource: part.ground_resource ?? null,
          occurrence_count: 0,
          room_ids: [],
        };
        if ('face_index' in part) context.face_index = part.face_index;
        if ('face_name' in part) context.face_name = part.face_name;
        const record: Record<string, any> = {
          owner_slot: ownerSlot,
          owner_selector: row.selector,
          owner_runtime: row.runtime,
          owner_start: row.start,
          mesh_field_op: part.mesh_field_op ?? null,
          material_field_op: part.material_field_op ?? null,
          series_index: seriesIndex,
          mesh_pool: null,
          material_pool: null,
          mesh_def_slot: part.mesh_def_slot ?? null,
          ab5_mesh: part.mesh ?? null,
          material_handle: material,
          material_object_slot: material,
          ab3_textures: [texture],
          rule,
          confidence: part.confidence ?? null,
          structural_context: context,
        };
        if (fallbackMaterial !== null && fallbackTexture !== null) {
          record.fallback_material_handle = fallbackMaterial;
          record.fallback_ab3_textures = [fallbackTexture];
        }
        for (const key of ['recolors', 'recolor_schema', 'local_matrix_game']) {
          if (key in part) record[key] = part[key];
        }
        existing = { record, rooms: new Set() };
        grouped.set(contextKey, existing);
      }
      if (!perPart) { perPart = new Map(); entryMemo.set(part, perPart); }
      perPart.set(memoKey, existing);
      if (roomId !== null) {
        existing.record.structural_context.occurrence_count += 1;
        existing.rooms.add(roomId);
      }
    };

    // A block's field-49 ground link is owner-local and recoverable even when
    // that block never appears in the decoded room corpus.
    const blockCache = new Map<number, PartRecord[]>();
    for (const ownerSlot of this._candidateBlockOwners().slice().sort((a, b) => a - b)) {
      blockCache.set(ownerSlot, this.blockParts(ownerSlot));
    }
    for (const [ownerSlot, parts] of blockCache) {
      for (const part of parts) add(ownerSlot, part, 'positional_block_face', 'block_owner_field49');
    }

    const terrainRules: Record<string, string> = {
      terrain_face: 'occurrence_terrain_face',
      terrain_custom_mesh: 'occurrence_terrain_custom_mesh',
      terrain_model_part: 'occurrence_terrain_model_part',
    };
    const terrainCache = new Map<string, PartRecord[]>();
    for (const [roomId, occurrences] of roomOccurrenceGroups) {
      for (const hit of occurrences) {
        const ownerSlot = hit.resource;
        const secondary = hit.secondary;
        if (!Number.isInteger(ownerSlot)) continue;
        if (secondary === null || secondary === undefined) {
          for (const part of blockCache.get(ownerSlot) || []) {
            add(ownerSlot, part, 'positional_block_face', 'block_owner_field49', roomId);
          }
          continue;
        }
        const terrainKey = `${ownerSlot}:${secondary}`;
        let parts = terrainCache.get(terrainKey);
        if (parts === undefined) {
          parts = this.terrainParts(ownerSlot, secondary);
          terrainCache.set(terrainKey, parts);
        }
        for (const part of parts) {
          const rule = terrainRules[part.kind];
          if (rule !== undefined) add(ownerSlot, part, rule, 'room_occurrence_secondary', roomId);
        }
      }
    }

    const records: any[] = [];
    for (const { record, rooms } of grouped.values()) {
      record.structural_context.room_ids = [...rooms].sort((a, b) => a - b);
      records.push(record);
    }
    // Tuple sort including the deliberate `|| -1` quirk (falsy ground -> -1);
    // string rules compare by code points on both sides; stable for the
    // remainder.
    const key = (r: any) => [
      r.owner_slot, r.structural_context.ground_resource || -1,
      r.rule, r.series_index, r.ab5_mesh, r.material_handle,
    ];
    records.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) {
          return typeof ka[i] === 'string' ? (ka[i] < kb[i] ? -1 : 1) : ka[i] - kb[i];
        }
      }
      const ta = a.ab3_textures;
      const tb = b.ab3_textures;
      for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
        if (ta[i] !== tb[i]) return ta[i] - tb[i];
      }
      return ta.length - tb.length;
    });
    return records;
  }

  // ---------------------------------------------------------- model groups

  // Split leaves for typed-component recovery: ordered (mesh-definition
  // slots filtered by meshBySlot, material slots).
  private _splitLeaves(node: any, active: Set<number> | null = null): [number[], number[]] {
    if (!isNode(node)) return [[], []];
    const tag = node.tag;
    if (tag === 0) {
      const index = node.value;
      if (!isInt(index) || index < 0 || index >= this.pool.length
        || (active !== null && active.has(index))) return [[], []];
      const cached = this._splitLeafCache.get(index);
      if (cached) return cached;
      if (active === null) active = new Set();
      active.add(index);
      const result = this._splitLeaves(this.pool[index], active);
      active.delete(index);
      this._splitLeafCache.set(index, result);
      return result;
    }
    if (tag === 0x26 && isInt(node.value)) {
      return [this.meshBySlot.has(node.value) ? [node.value] : [], []];
    }
    if (tag === 0x02 && isInt(node.value)) return [[], [node.value]];
    const meshes: number[] = [];
    const materials: number[] = [];
    const children: any[] = [];
    for (const key of ['fields', 'values']) {
      if (Array.isArray(node[key])) children.push(...node[key]);
    }
    if (isNode(node.value)) children.push(node.value);
    for (const child of children) {
      const [childMeshes, childMaterials] = this._splitLeaves(child, active);
      meshes.push(...childMeshes);
      materials.push(...childMaterials);
    }
    return [meshes, materials];
  }

  static _oneUnique(values: any[]): any {
    const distinct = unique(values);
    return distinct.length === 1 ? distinct[0] : null;
  }

  // The typed marker at `position` of one op's postorder events, decoded as a
  // standalone visual component.
  private _inlineTypedComponent(events: any[][], position: number): Record<string, any> | null {
    const [, depth, tag, value] = events[position];
    if (tag !== 0x24) return null;
    let boundary = -1;
    for (let previous = position - 1; previous >= 0; previous--) {
      if (events[previous][1] <= depth) { boundary = previous; break; }
    }
    const direct: any[][] = [];
    for (let k = boundary + 1; k < position; k++) {
      if (events[k][1] === depth + 1) direct.push(events[k]);
    }
    if ((direct.length !== 5 && direct.length !== 6)
      || direct.some((child) => child[2] !== 0 || !isInt(child[3]))) return null;
    const meshPool = direct[0][3];
    const materialPool = direct[1][3];
    const [meshes, meshMaterials] = this._splitLeaves({ tag: 0, value: meshPool });
    const [materialMeshes, materials] = this._splitLeaves({ tag: 0, value: materialPool });
    const meshSlot = AssetGraph._oneUnique(meshes);
    const material = AssetGraph._oneUnique(materials);
    if (meshMaterials.length || materialMeshes.length
      || meshSlot === null || material === null) return null;
    const trailing = direct.slice(2).map((child) => this.deref({ tag: 0, value: child[3] }));
    const colors = trailing.filter((c) => isNode(c) && c.tag === 0x15
      && Array.isArray(c.value) && c.value.length === 4);
    const matrices = trailing.filter((c) => isNode(c) && c.tag === 0x30
      && Array.isArray(c.value) && c.value.length === 12);
    const metadata: Record<string, any> = {
      typed_class: value,
      typed_schema: 'mesh_material_colors3_matrix3x4',
      inline_typed: true,
      typed_depth: depth,
      captured_fields: direct.length,
    };
    if (colors.length === 3) {
      metadata.recolors = colors.map((c) => c.value.slice());
      metadata.recolors[2] = nativeThirdToHalfRange(metadata.recolors[2]);
    } else if (colors.length) metadata.recolors_observed = colors.map((c) => c.value.slice());
    if (matrices.length === 1) metadata.local_matrix_game = matrices[0].value.slice();
    return {
      mesh_pool: meshPool,
      material_pool: materialPool,
      mesh_slot: meshSlot,
      material,
      metadata,
    };
  }

  // Standalone inline typed components from postorder events, in stream order.
  private _inlineTypedComponents(row: RegistryRow): Record<string, any>[] {
    const byOperation = new Map<number, any[][]>();
    for (const event of row.g) {
      const list = byOperation.get(event[0]);
      if (list) list.push(event); else byOperation.set(event[0], [event]);
    }
    const out: Record<string, any>[] = [];
    for (const [operation, events] of byOperation) {
      let markerIndex = 0;
      for (let position = 0; position < events.length; position++) {
        if (events[position][2] !== 0x24) continue;
        const index = markerIndex;
        markerIndex++;
        const component = this._inlineTypedComponent(events, position);
        if (component === null) continue;
        component.operation = operation;
        component.series_index = index;
        out.push(component);
      }
    }
    return out;
  }

  // Exact typed or adjacent ordered mesh/material groups on one owner.
  modelGroups(ownerSlot: number): ModelGroup[] {
    const fields = this.fields(ownerSlot);
    const groups: ModelGroup[] = [];

    for (const [op, field] of fields) {
      let parts: PartRecord[] = [];
      for (let seriesIndex = 0; seriesIndex < field.elements.length; seriesIndex++) {
        const leaves = field.leaves[seriesIndex];
        const meshSlots = unique(
          leaves.filter(([t, v]) => t === 0x26 && this.meshBySlot.has(v)).map(([, v]) => v),
        );
        const materials = unique(leaves.filter(([t]) => t === 0x02).map(([, v]) => v));
        if (meshSlots.length !== 1 || materials.length !== 1) { parts = []; break; }
        const textures = this.texturesByMaterial.get(materials[0]);
        if (!textures || textures.length !== 1) { parts = []; break; }
        parts.push(this._modelPart(
          op, op, seriesIndex, meshSlots[0], materials[0], textures[0],
          'exact_native_typed_object',
          this._typedPartMetadata(field.elements[seriesIndex]),
        ));
      }
      if (parts.length) groups.push({ mesh_op: op, material_op: op, parts });
    }

    const inlineGroups = new Map<number, PartRecord[]>();
    for (const component of this._inlineTypedComponents(this.rows[ownerSlot])) {
      const textures = this.texturesByMaterial.get(component.material);
      if (!textures || textures.length !== 1) continue;
      const operation = component.operation;
      const part = this._modelPart(
        operation, operation, component.series_index,
        component.mesh_slot, component.material, textures[0],
        'exact_native_inline_typed_object', component.metadata,
      );
      const list = inlineGroups.get(operation);
      if (list) list.push(part); else inlineGroups.set(operation, [part]);
    }
    for (const [operation, parts] of inlineGroups) {
      groups.push({ mesh_op: operation, material_op: operation, parts });
    }

    for (const [meshOp, meshField] of fields) {
      const materialOp = meshOp + 1;
      const materialField = fields.get(materialOp);
      if (!materialField) continue;
      if (meshField.leaves.length !== materialField.leaves.length) continue;
      let parts: PartRecord[] = [];
      for (let seriesIndex = 0; seriesIndex < meshField.leaves.length; seriesIndex++) {
        const meshLeaves = meshField.leaves[seriesIndex];
        const materialLeaves = materialField.leaves[seriesIndex];
        const meshSlots = unique(
          meshLeaves.filter(([t, v]) => t === 0x26 && this.meshBySlot.has(v)).map(([, v]) => v),
        );
        const embeddedMaterials = meshLeaves.some(([t]) => t === 0x02);
        const embeddedMeshes = materialLeaves.some(
          ([t, v]) => t === 0x26 && this.meshBySlot.has(v),
        );
        const materials = unique(materialLeaves.filter(([t]) => t === 0x02).map(([, v]) => v));
        if (embeddedMaterials || embeddedMeshes
          || meshSlots.length !== 1 || materials.length !== 1) { parts = []; break; }
        const textures = this.texturesByMaterial.get(materials[0]);
        if (!textures || textures.length !== 1) { parts = []; break; }
        const confidence = meshField.series || materialField.series
          ? 'exact_native_positional_series' : 'exact_native_adjacent_fields';
        parts.push(this._modelPart(
          meshOp, materialOp, seriesIndex, meshSlots[0], materials[0],
          textures[0], confidence,
        ));
      }
      if (parts.length) groups.push({ mesh_op: meshOp, material_op: materialOp, parts });
    }
    return groups;
  }

  private _modelPart(
    meshOp: number, materialOp: number, seriesIndex: number, meshSlot: number,
    material: number, texture: number, confidence: string,
    metadata?: Record<string, any>,
  ): PartRecord {
    return {
      kind: 'model_part',
      mesh_field_op: meshOp,
      material_field_op: materialOp,
      series_index: seriesIndex,
      mesh_def_slot: meshSlot,
      mesh: this.meshBySlot.get(meshSlot)!,
      material_slot: material,
      texture,
      confidence,
      ...(metadata || {}),
    };
  }

  // Choose one qualified appearance group without changing exact edges:
  // prefer the static-appearance field region around 35, else earliest.
  private _selectedStaticParts(ownerSlot: number): PartRecord[] {
    const groups = this.modelGroups(ownerSlot);
    if (!groups.length) return [];
    const candidates = groups.filter((g) => g.mesh_op >= 35 && g.mesh_op <= 64);
    const selectionRule = candidates.length
      ? 'qualified_preferred_static_field_region' : 'qualified_earliest_model_group';
    const key = (g: ModelGroup) => [
      Math.abs(g.mesh_op - 35), g.mesh_op, g.material_op, -g.parts.length,
    ];
    let selected: ModelGroup | null = null;
    let selectedKey: number[] | null = null;
    for (const group of (candidates.length ? candidates : groups)) {
      const k = key(group);
      if (selected === null
        || k[0] < selectedKey![0] || (k[0] === selectedKey![0] && (k[1] < selectedKey![1]
        || (k[1] === selectedKey![1] && (k[2] < selectedKey![2]
        || (k[2] === selectedKey![2] && k[3] < selectedKey![3])))))) {
        selected = group;
        selectedKey = k;
      }
    }
    const seen = new Set<string>();
    const result: PartRecord[] = [];
    for (const part of selected!.parts) {
      const dedup = `${part.mesh}|${part.material_slot}|${part.series_index}`;
      if (!seen.has(dedup)) {
        seen.add(dedup);
        result.push({ ...part, selection_rule: selectionRule });
      }
    }
    return result;
  }

  // A selected group that only repeats identity block faces is inherited.
  private _isInheritedBlockFaceCopy(ownerSlot: number, staticParts: PartRecord[]): boolean {
    const blockParts = this.blockParts(ownerSlot);
    if (!blockParts.length || !staticParts.length) return false;
    for (const staticPart of staticParts) {
      const matrix = staticPart.local_matrix_game;
      if (matrix !== undefined && matrix !== null) {
        if (matrix.length !== 12
          || matrix.some((v: number, k: number) => v !== IDENTITY_LOCAL_MATRIX_GAME[k])) {
          return false;
        }
      }
      let matched = false;
      for (const face of blockParts) {
        if (staticPart.mesh !== face.mesh) continue;
        if (staticPart.material_slot === face.material_slot
          || (face.fallback_material_slot !== undefined
            && staticPart.material_slot === face.fallback_material_slot)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  }

  // The qualified static group, excluding inherited face copies.
  staticParts(ownerSlot: number): PartRecord[] {
    const selected = this._selectedStaticParts(ownerSlot);
    return this._isInheritedBlockFaceCopy(ownerSlot, selected) ? [] : selected;
  }

  // Resolve lossless room occurrences into exact mesh/material instances.
  // Templates are cached and shared: callers must treat parts as immutable
  // (the shard builder never mutates).
  roomPlacements(
    occurrences: Iterable<OccurrenceHit>,
  ): { occurrence: OccurrenceHit; part: PartRecord }[] {
    const result: { occurrence: OccurrenceHit; part: PartRecord }[] = [];
    for (const hit of occurrences) {
      const includeStatic = hit.secondary === null && hit.parentLink === null;
      const templateKey = `${hit.resource}|${hit.secondary}|${includeStatic}`;
      let templates = this._roomPartTemplateCache.get(templateKey);
      if (!templates) {
        let parts: PartRecord[];
        if (hit.secondary !== null) {
          parts = this.terrainParts(hit.resource, hit.secondary);
        } else {
          parts = this.blockParts(hit.resource).slice();
          if (includeStatic) parts.push(...this.staticParts(hit.resource));
        }
        const seen = new Set<string>();
        templates = [];
        for (const part of parts) {
          const key = `${part.kind}|${part.mesh}|${part.material_slot}`
            + `|${part.face_index ?? 'n'}|${part.series_index ?? 'n'}`;
          if (!seen.has(key)) { seen.add(key); templates.push(part); }
        }
        this._roomPartTemplateCache.set(templateKey, templates);
      }
      for (const part of templates) result.push({ occurrence: hit, part });
    }
    return result;
  }
}
