// System model/material/texture ownership recovery over the ab0 object graph.
//
// Inputs: replay.js registry rows (per-row reader events, replayed from the
// per-build decode data) and value-pool.js
// pool values. The AB2 structural stage lives in graph.js: its
// occurrence/block-face records are appended to `records` by the caller
// before catalog packaging. Record/model key names feed the catalog's
// content ids (catalog.js) — keep them stable, bookmarks depend on them.

// Registry row shape consumed here (produced by replay.js).
export interface RegistryRow {
  slot: number;
  selector: number | string;
  runtime: number | string;
  start: number;
  g: any[]; // graph events: [field_op, depth, tag, value]
  v?: any[]; // scalar events: [op, kind, value]
  r?: any[]; // direct registry references: [field_op, target]
  s?: any[]; // series edges: [field_op, target slots]
}

// Flat mesh/material assignment record; metadata fields vary per rule.
export interface AssetRecord {
  owner_slot: number;
  owner_selector: number | string;
  owner_runtime: number | string;
  owner_start: number;
  mesh_field_op: number;
  material_field_op: number;
  series_index: number;
  mesh_pool: number | null;
  material_pool: number | null;
  mesh_def_slot: number;
  ab5_mesh: number;
  material_handle: number;
  material_object_slot: number;
  ab3_textures: number[];
  rule: string;
  confidence: string;
  [extra: string]: any;
}

// Ordered owner/field grouping of records (buildModels).
export interface AssetModel {
  owner_slot: number;
  owner_selector: number | string;
  owner_runtime: number | string;
  owner_start: number;
  mesh_field_op: number;
  material_field_op: number;
  rule: string;
  confidence: string;
  parts: Record<string, any>[];
  model_index?: number;
  [extra: string]: any;
}

export interface StringEvent {
  text: string;
  field_op: number | null;
  depth?: number;
  relation: string;
  event_index: number | null;
  pool_index?: number;
}

export interface MeshDefinitionBatch {
  batch_index: number;
  reader_selector: number | string;
  reader_runtime: number | string;
  index_field_op: number;
  first_mesh_def_slot: number;
  last_mesh_def_slot: number;
  members: { index: number; mesh_def_slot: number; ab5_mesh: number }[];
}

export interface MaterialVariantBatch {
  batch_index: number;
  reader_selector: number | string;
  reader_runtime: number | string;
  index_field_op: number;
  first_material_handle: number;
  last_material_handle: number;
  members: { index: number; material_handle: number; ab3_textures: number[] }[];
}

export const NAMEABLE_MODEL_RULES = new Set([
  'adjacent_scalar', 'parallel_series', 'typed_meshmat',
  'typed_component_collection',
]);
export const DIRECT_EXACT_BINDING_RULES = new Set([
  'adjacent_scalar', 'parallel_series', 'typed_meshmat',
  'typed_component_collection', 'nested_typed_ref', 'entity_variant',
  'indexed_visual_inherited_material',
]);
const TECHNICAL_LABEL_RE = /^[a-z0-9][a-z0-9_./#[\]-]*$/;

const isInt = (value: unknown): value is number => Number.isInteger(value);
type Leaves = [number[], number[]];
const EMPTY = Object.freeze([Object.freeze([]), Object.freeze([])]) as unknown as Leaves;

function oneUnique<T>(values: Iterable<T>): T | null {
  let first: T | undefined;
  const seen = new Set<T>();
  for (const value of values) {
    if (!seen.size) first = value;
    seen.add(value);
  }
  return seen.size === 1 ? (first as T) : null;
}

function orderedUnique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

const isNode = (v: any): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

// -------------------------------------------------------------- pool strings

// Depth-zero row strings, including pool-interned ones. Pool tag-0x0E values
// store varint charset indices, not UTF-8; `glyphs` is dt.charset (the ab0
// glyph table).
export class PoolStrings {
  pool: any[];
  glyphs: ArrayLike<string>;
  private _cache: Map<number, string | null>;
  private _templateCache: Map<number, string[] | null>;

  constructor(pool: any[], glyphs: ArrayLike<string>) {
    this.pool = pool;
    this.glyphs = glyphs;
    this._cache = new Map();
    this._templateCache = new Map();
  }

  // Text of pool[index] when it is (a chain to) one string, else null.
  poolString(index: number): string | null {
    const cached = this._cache.get(index);
    if (cached !== undefined) return cached;
    let node = null;
    let cursor = index;
    const seen = new Set<number>();
    while (isInt(cursor) && cursor >= 0 && cursor < this.pool.length && !seen.has(cursor)) {
      seen.add(cursor);
      node = this.pool[cursor];
      if (!(isNode(node) && node.tag === 0)) break;
      cursor = node.value;
    }
    let text: string | null = null;
    if (isNode(node) && node.tag === 0x0e && Array.isArray(node.values)) {
      text = '';
      for (const glyphIndex of node.values) {
        const glyph = this.glyphs[glyphIndex];
        if (glyph === undefined) { text = null; break; }
        text += glyph;
      }
    }
    this._cache.set(index, text);
    return text;
  }

  // All strings under pool[index] when every leaf is a string, optionally
  // styled by colour spans; anything else disqualifies the value.
  templateStrings(index: number): string[] | null {
    if (!isInt(index) || index < 0 || index >= this.pool.length) return null;
    const cached = this._templateCache.get(index);
    if (cached !== undefined) return cached;
    const out: string[] = [];
    const walk = (node: any, active: Set<number>): boolean => {
      if (!isNode(node)) return false;
      const tag = node.tag;
      const value = node.value;
      if (tag === 0) {
        if (!isInt(value) || value < 0 || value >= this.pool.length || active.has(value)) return false;
        active.add(value);
        const ok = walk(this.pool[value], active);
        active.delete(value);
        return ok;
      }
      if (tag === 0x0e) {
        if (!Array.isArray(node.values)) return false;
        let text = '';
        for (const glyphIndex of node.values) {
          const glyph = this.glyphs[glyphIndex];
          if (glyph === undefined) return false;
          text += glyph;
        }
        out.push(text);
        return true;
      }
      if (tag === 0x15) return true; // colour spans style template text
      if (tag === 0x20 || tag === 0x24) {
        const children = [];
        if (Array.isArray(node.fields)) children.push(...node.fields);
        if (Array.isArray(node.values)) children.push(...node.values);
        if (!children.length) return false;
        return children.every((child) => walk(child, active));
      }
      return false;
    };
    const ok = walk({ tag: 0, value: index }, new Set());
    const result = ok && out.length >= 2 ? out : null;
    this._templateCache.set(index, result);
    return result;
  }

  // Ordered depth-zero strings with exact reader provenance.
  directStrings(row: { g?: any[] }): StringEvent[] {
    const events: StringEvent[] = [];
    const g = row.g || [];
    for (let eventIndex = 0; eventIndex < g.length; eventIndex++) {
      const event = g[eventIndex];
      if (!Array.isArray(event) || event.length !== 4) continue;
      const [fieldOp, depth, tag, value] = event;
      if (depth !== 0) continue;
      if (tag === 0x0e && typeof value === 'string') {
        events.push({
          text: value, field_op: fieldOp, depth, relation: 'direct', event_index: eventIndex,
        });
      } else if (tag === 0 && isInt(value)) {
        const text = this.poolString(value);
        if (text !== null) {
          events.push({
            text, field_op: fieldOp, depth, relation: 'direct_pool',
            event_index: eventIndex, pool_index: value,
          });
        }
      }
    }
    return events;
  }
}

// Memoized pure walk shared by the name/label recovery passes: the registry
// refs (tag-0x26) reachable through one pool value, following tag-0 chains
// acyclically. The result depends only on `pool`; the enemy scans,
// mesh-names and anim-names each used to carry an identical private copy of
// this walk, so threading ONE instance through them changes no output.
export function makePoolRegistryRefs(pool: any[]): (index: number) => number[] {
  const cache = new Map<number, number[]>();
  return (index: number): number[] => {
    const cached = cache.get(index);
    if (cached) return cached;
    const out = new Set<number>();
    const active = new Set<number>();
    const walk = (node: any) => {
      if (!isNode(node)) return;
      if (node.tag === 0 && isInt(node.value)) {
        if (node.value < 0 || node.value >= pool.length || active.has(node.value)) return;
        active.add(node.value);
        walk(pool[node.value]);
        return;
      }
      if (node.tag === 0x26 && isInt(node.value)) out.add(node.value);
      if (Array.isArray(node.fields)) for (const child of node.fields) walk(child);
      if (Array.isArray(node.values)) for (const child of node.values) walk(child);
      if (isNode(node.value)) walk(node.value);
    };
    walk({ tag: 0, value: index });
    const result = [...out];
    cache.set(index, result);
    return result;
  };
}

// Node equality is by value (nodes carry start/end offsets, so equal content
// implies the same pool node); identity plus a deep fallback reproduces that.
function deepNodeEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepNodeEqual(a[i], b[i])) return false;
    return true;
  }
  if (isNode(a) && isNode(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!(key in b) || !deepNodeEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

const nodesEqual = (a: any[], b: any[]): boolean => a.length === b.length
  && a.every((node, i) => node === b[i] || deepNodeEqual(node, b[i]));

// ---------------------------------------------------------------- resolver

// Resolve pool indirections while preserving series element order.
export class Resolver {
  pool: any[];
  meshSlots: Map<number, number>;
  private _leafCache: Map<number, Leaves>;
  private _elementsCache: Map<number, [any[], boolean]>;

  constructor(pool: any[], meshSlots: Map<number, number>) {
    this.pool = pool;           // value-pool.js values
    this.meshSlots = meshSlots; // Map<registry slot, ab5 mesh>
    this._leafCache = new Map();
    this._elementsCache = new Map();
  }

  deref(node: any, active: Set<number> | null = null): any {
    active = active || new Set();
    while (isNode(node) && node.tag === 0) {
      const index = node.value;
      if (!isInt(index) || index < 0 || index >= this.pool.length || active.has(index)) break;
      active.add(index);
      node = this.pool[index];
    }
    return node;
  }

  elementsForIndex(index: number): [any[], boolean] {
    const cached = this._elementsCache.get(index);
    if (cached) return cached;
    const node = this.deref({ tag: 0, value: index });
    const result: [any[], boolean] = isNode(node) && node.tag === 0x20
      ? [node.values || [], true]
      : [[node], false];
    this._elementsCache.set(index, result);
    return result;
  }

  // Ordered [mesh-definition slots, material slots].
  leaves(node: any, active: Set<number> | null = null): Leaves {
    active = active || new Set();
    if (!isNode(node)) return EMPTY;
    const tag = node.tag;
    if (tag === 0) {
      const index = node.value;
      if (!isInt(index) || index < 0 || index >= this.pool.length || active.has(index)) return EMPTY;
      const cached = this._leafCache.get(index);
      if (cached) return cached;
      active.add(index);
      const result = this.leaves(this.pool[index], active);
      active.delete(index);
      this._leafCache.set(index, result);
      return result;
    }
    if (tag === 0x26 && isInt(node.value)) {
      return [this.meshSlots.has(node.value) ? [node.value] : [], []];
    }
    if (tag === 0x02 && isInt(node.value)) return [[], [node.value]];

    const meshes: number[] = [];
    const materials: number[] = [];
    const walk = (child: any) => {
      const [childMeshes, childMaterials] = this.leaves(child, active);
      for (const value of childMeshes) meshes.push(value);
      for (const value of childMaterials) materials.push(value);
    };
    if (Array.isArray(node.fields)) for (const child of node.fields) walk(child);
    if (Array.isArray(node.values)) for (const child of node.values) walk(child);
    if (isNode(node.value)) walk(node.value);
    return [meshes, materials];
  }
}

// -------------------------------------------------------------- asset maps

// Registry mesh slots (row tag 0x62 -> ab5 mesh) and material texture slots
// (row tag 0x47 -> ab3 containers).
export function traceAssetMaps(rows: RegistryRow[]): {
  meshSlots: Map<number, number>;
  textureSlots: Map<number, number[]>;
} {
  const meshSlots = new Map<number, number>();
  const textureSlots = new Map<number, number[]>();
  for (const row of rows) {
    let meshes: Set<number> | null = null;
    let textures: Set<number> | null = null;
    for (const event of row.g) {
      if (event[2] === 0x62) (meshes || (meshes = new Set())).add(event[3]);
      else if (event[2] === 0x47) (textures || (textures = new Set())).add(event[3]);
    }
    if (meshes && meshes.size === 1) meshSlots.set(row.slot, meshes.values().next().value!);
    if (textures && textures.size) textureSlots.set(row.slot, [...textures]);
  }
  return { meshSlots, textureSlots };
}

// Every material handle used by the pool, with its resolved texture row.
export function materialMap(
  pool: any[], resolver: Resolver, textureSlots: Map<number, number[]>,
): { handles: Set<number>; materialTextures: Map<number, number[]> } {
  const handles = new Set<number>();
  for (let index = 0; index < pool.length; index++) {
    const [, materials] = resolver.leaves({ tag: 0, value: index });
    for (const handle of materials) handles.add(handle);
  }
  const materialTextures = new Map<number, number[]>();
  for (const handle of handles) materialTextures.set(handle, textureSlots.get(handle) || []);
  return { handles, materialTextures };
}

export interface DecodedField {
  pool: number | null;
  elements: Leaves[];
  nodes: any[];
  series: boolean;
  scope: 'pooled' | 'inline';
}

// Top-level generic fields keyed by reader operation. A depth-zero tag-0
// event is an interned pool reference; a *bare* native array instead emits
// its ordered elements as depth-one tag-0 events with no depth-zero
// completion event at all (the humanoid appearance slot arrays). Operations
// owning a depth-zero completion marker of another tag keep their dedicated
// decoders and are deliberately not treated as bare series here.
export function decodeOwnerFields(
  row: RegistryRow, pool: any[], resolver: Resolver,
): Map<number, DecodedField> {
  const fields = new Map<number, number[]>();
  const bare = new Map<number, number[]>();
  const depthZeroOps = new Set<number>();
  for (const [op, depth] of row.g) {
    if (depth === 0) depthZeroOps.add(op);
  }
  for (const [op, depth, tag, value] of row.g) {
    if (tag === 0 && isInt(value) && value >= 0 && value < pool.length) {
      if (depth === 0) {
        let list = fields.get(op);
        if (!list) fields.set(op, list = []);
        list.push(value);
      } else if (depth === 1 && !depthZeroOps.has(op)) {
        let list = bare.get(op);
        if (!list) bare.set(op, list = []);
        list.push(value);
      }
    }
  }
  const decoded = new Map<number, DecodedField>();
  for (const [op, indices] of fields) {
    const elements: any[] = [];
    let explicitSeries = false;
    for (const poolIndex of indices) {
      const [part, isSeries] = resolver.elementsForIndex(poolIndex);
      for (const element of part) elements.push(element);
      explicitSeries = explicitSeries || isSeries;
    }
    decoded.set(op, {
      pool: indices.length === 1 ? indices[0] : null,
      elements: elements.map((element) => resolver.leaves(element)),
      nodes: elements,
      series: explicitSeries || elements.length > 1,
      scope: 'pooled',
    });
  }
  for (const [op, indices] of bare) {
    if (decoded.has(op)) continue;
    const elements: any[] = [];
    for (const poolIndex of indices) {
      const [part] = resolver.elementsForIndex(poolIndex);
      for (const element of part) elements.push(element);
    }
    decoded.set(op, {
      pool: indices.length === 1 ? indices[0] : null,
      elements: elements.map((element) => resolver.leaves(element)),
      nodes: elements,
      series: elements.length > 1,
      scope: 'inline',
    });
  }
  return decoded;
}

// ------------------------------------------------------- typed components

interface TypedPart {
  mesh_pool: number;
  material_pool: number;
  mesh_slot: number;
  material: number;
  metadata: Record<string, any>;
  series_index?: number;
  marker_position?: number;
  operation?: number;
}


// The owner-series schemas store their third colour as FULL-range output
// modulation (white = x1 neutral; census: 23k+ records all white or >0.5,
// incl. exact values above 1.0 like [1.2, 0.486, 0.4]). The stored/shard/
// viewer convention is the ground schema's HALF-range form (0.5 = neutral,
// the shader multiplies by 2*c3). Canonicalize at emission: rgb * 0.5 is an
// exact semantic conversion between the two declared conventions, not a
// fabricated value.
function nativeThirdToHalfRange(color: number[]): number[] {
  return [color[0] * 0.5, color[1] * 0.5, color[2] * 0.5, ...color.slice(3)];
}

// Structural mesh/material/three-colour/matrix component metadata.
function typedPartMetadata(resolver: Resolver, element: any): Record<string, any> {
  const node = resolver.deref(element);
  if (!(isNode(node) && node.tag === 0x24 && (node.fields || []).length === 6)) return {};
  const fields = node.fields.map((field: any) => resolver.deref(field));
  const colors = fields.slice(2, 5);
  const matrix = fields[5];
  if (!(colors.every((color: any) => isNode(color) && color.tag === 0x15
          && (color.value || []).length === 4)
        && isNode(matrix) && matrix.tag === 0x30 && (matrix.value || []).length === 12)) {
    return {};
  }
  const recolors = colors.map((color: any) => [...color.value]);
  recolors[2] = nativeThirdToHalfRange(recolors[2]);
  return {
    typed_class: node.class,
    typed_schema: 'mesh_material_colors3_matrix3x4',
    recolors,
    local_matrix_game: [...matrix.value],
  };
}

// One exact six-field typed visual component. The first two fields are proven
// independently: leaves() on the whole object would only prove containment,
// not that the mesh/material occupy this schema's native fields.
function typedPartRecord(resolver: Resolver, element: any): TypedPart | null {
  let typedPartPool = null;
  if (isNode(element) && element.tag === 0 && isInt(element.value)) typedPartPool = element.value;
  const node = resolver.deref(element);
  const metadata = typedPartMetadata(resolver, node);
  if (!Object.keys(metadata).length) return null;
  const fields = node.fields;
  for (let i = 0; i < 2; i++) {
    if (fields[i].tag !== 0 || !isInt(fields[i].value)) return null;
  }
  const meshPool = fields[0].value;
  const materialPool = fields[1].value;
  const [meshes, meshMaterials] = resolver.leaves(fields[0]);
  const [materialMeshes, materials] = resolver.leaves(fields[1]);
  const meshSlot = oneUnique(meshes);
  const material = oneUnique(materials);
  if (meshMaterials.length || materialMeshes.length || meshSlot === null || material === null) return null;
  const meta = { ...metadata };
  if (typedPartPool !== null) meta.typed_part_pool = typedPartPool;
  return {
    mesh_pool: meshPool, material_pool: materialPool,
    mesh_slot: meshSlot, material, metadata: meta,
  };
}

// `typed outer -> one series -> ordered typed visual parts`, decoded
// atomically: a partially understood collection is never promoted.
function pooledTypedCollection(resolver: Resolver, element: any): TypedPart[] | null {
  const outer = resolver.deref(element);
  if (!(isNode(outer) && outer.tag === 0x24 && isInt(outer.class)
        && (outer.fields || []).length === 1)) return null;
  const series = resolver.deref(outer.fields[0]);
  if (!(isNode(series) && series.tag === 0x20 && Array.isArray(series.values)
        && series.values.length)) return null;
  const parts = series.values.map((value: any) => typedPartRecord(resolver, value));
  if (parts.some((part: TypedPart | null) => part === null)) return null;
  const typedParts = parts as TypedPart[];
  if (new Set(typedParts.map((part) => part.metadata.typed_class)).size !== 1) return null;
  typedParts.forEach((part, seriesIndex) => {
    part.series_index = seriesIndex;
    part.metadata = {
      ...part.metadata,
      typed_container_class: outer.class,
      typed_container_depth: 0,
      typed_collection: true,
      typed_collection_scope: 'pooled',
    };
  });
  return typedParts;
}

interface RecolorSeries {
  values: any[][];
  field_ops: number[];
  scope: string;
  channel_scopes: string[];
}

// Exact positional RGBA inputs following a material series: three
// same-cardinality colour series; or the material series repeated verbatim,
// two colour series, then one scalar colour broadcast to every part; or the
// ACTOR TINT PAIR — exactly two colour series at materialOp+2/+3 (the same
// two fields spawns.js recovers on actor rows), scalar or per-part.
function parallelRecolors(
  decoded: Map<number, DecodedField>, resolver: Resolver, materialOp: number,
  partCount: number, row: RegistryRow | null = null,
): RecolorSeries | null {
  const colorSeries = (operation: number, count = partCount): [number[][], string] | null => {
    const field = decoded.get(operation);
    let elements: any[];
    let scope: string;
    if (field !== undefined && field.nodes.length === count) {
      elements = field.nodes;
      scope = (field.scope ?? 'pooled') === 'pooled' ? 'pooled' : 'inline';
    } else if (row !== null) {
      const events = row.g.filter((event: any) => event[0] === operation);
      if (events.length !== count || events.some(
        ([, depth, tag, value]: any[]) => depth !== 1 || tag !== 0 || !isInt(value),
      )) return null;
      elements = events.map(([, , , value]: any[]) => ({ tag: 0, value }));
      scope = 'inline';
    } else return null;
    const values: number[][] = [];
    for (const element of elements) {
      const node = resolver.deref(element);
      if (!(isNode(node) && node.tag === 0x15 && (node.value || []).length === 4)) return null;
      values.push([...node.value]);
    }
    return [values, scope];
  };

  const directOps = [materialOp + 1, materialOp + 2, materialOp + 3];
  // NOT `.map(colorSeries)`: map would pass its index as the count parameter
  // and silently break the three-channel match (the black-skin regression).
  const direct = directOps.map((operation) => colorSeries(operation));
  if (direct.every((channel) => channel !== null)) {
    const values = direct.map((channel) => channel![0]);
    const channelScopes = direct.map((channel) => channel![1]);
    return {
      values: Array.from({ length: partCount }, (_, index) => {
        const triple = values.map((channel) => channel[index]);
        triple[2] = nativeThirdToHalfRange(triple[2]);
        return triple;
      }),
      field_ops: directOps,
      scope: channelScopes.every((scope) => scope === 'pooled') ? 'parallel' : 'parallel_mixed',
      channel_scopes: channelScopes,
    };
  }

  const pairForm = () => actorPairRecolors(decoded, resolver, materialOp, partCount, row, colorSeries);
  const materialField = decoded.get(materialOp);
  const repeatedMaterial = decoded.get(materialOp + 1);
  const broadcastField = decoded.get(materialOp + 4);
  if (!(materialField !== undefined && repeatedMaterial !== undefined
        && nodesEqual(repeatedMaterial.nodes, materialField.nodes)
        && broadcastField !== undefined && broadcastField.nodes.length === 1)) return pairForm();
  const colors = [colorSeries(materialOp + 2), colorSeries(materialOp + 3)];
  const broadcast = resolver.deref(broadcastField.nodes[0]);
  if (!(colors.every((channel) => channel !== null)
        && isNode(broadcast) && broadcast.tag === 0x15
        && (broadcast.value || []).length === 4)) return pairForm();
  const broadcastValue = nativeThirdToHalfRange([...broadcast.value]);
  const values = colors.map((channel) => channel![0]);
  const channelScopes = colors.map((channel) => channel![1]);
  return {
    values: Array.from({ length: partCount }, (_, index) => [
      values[0][index], values[1][index], broadcastValue,
    ]),
    field_ops: [materialOp + 2, materialOp + 3, materialOp + 4],
    scope: 'parallel_broadcast',
    channel_scopes: [...channelScopes, 'broadcast'],
  };
}

// The two-tint actor pair (tint1/tint2 with implicit neutral output
// modulation — the spawn-actor appearance schema and the humanoid style
// owners): exactly two colour series at materialOp+2 and materialOp+3, each
// per-part or scalar (actor-wide). Reached only after the exact
// three-channel forms above fail, and emitted as OBSERVED colours — the
// schema stores no third modulation colour and none is fabricated.
function actorPairRecolors(
  decoded: Map<number, DecodedField>, resolver: Resolver, materialOp: number,
  partCount: number, row: RegistryRow | null,
  colorSeries: (operation: number, count?: number) => [number[][], string] | null,
): RecolorSeries | null {
  for (const count of partCount === 1 ? [1] : [partCount, 1]) {
    const pair = [colorSeries(materialOp + 2, count), colorSeries(materialOp + 3, count)];
    if (pair.some((channel) => channel === null)) continue;
    const values = pair.map((channel) => channel![0]);
    const channelScopes = pair.map((channel) => channel![1]);
    return {
      values: Array.from({ length: partCount }, (_, index) => [
        values[0][count === 1 ? 0 : index], values[1][count === 1 ? 0 : index],
      ]),
      field_ops: [materialOp + 2, materialOp + 3],
      scope: count === 1 && partCount !== 1 ? 'actor_pair_scalar' : 'actor_pair',
      channel_scopes: channelScopes,
    };
  }
  return null;
}

// ----------------------------------------------------- inline typed events

function eventsByOperation(row: RegistryRow): Map<number, any[]> {
  const map = new Map<number, any[]>();
  for (const event of row.g) {
    let list = map.get(event[0]);
    if (!list) map.set(event[0], list = []);
    list.push(event);
  }
  return map;
}

// The typed marker at `position` from postorder completion events.
function inlineTypedComponent(events: any[], position: number, resolver: Resolver): TypedPart | null {
  const [, depth, tag, value] = events[position];
  if (tag !== 0x24) return null;
  let boundary = -1;
  for (let previous = position - 1; previous >= 0; previous--) {
    if (events[previous][1] <= depth) { boundary = previous; break; }
  }
  const direct = [];
  for (let i = boundary + 1; i < position; i++) {
    if (events[i][1] === depth + 1) direct.push(events[i]);
  }
  if (!(direct.length === 5 || direct.length === 6)
      || direct.some((child) => child[2] !== 0 || !isInt(child[3]))) return null;
  const meshPool = direct[0][3];
  const materialPool = direct[1][3];
  const [meshes, meshMaterials] = resolver.leaves({ tag: 0, value: meshPool });
  const [materialMeshes, materials] = resolver.leaves({ tag: 0, value: materialPool });
  const meshSlot = oneUnique(meshes);
  const material = oneUnique(materials);
  if (meshMaterials.length || materialMeshes.length || meshSlot === null || material === null) return null;
  const trailing = direct.slice(2).map((child) => resolver.deref({ tag: 0, value: child[3] }));
  const colors = trailing.filter((node) => isNode(node) && node.tag === 0x15
    && (node.value || []).length === 4);
  const matrices = trailing.filter((node) => isNode(node) && node.tag === 0x30
    && (node.value || []).length === 12);
  const metadata: Record<string, any> = {
    typed_class: value,
    typed_schema: 'mesh_material_colors3_matrix3x4',
    inline_typed: true,
    typed_depth: depth,
    captured_fields: direct.length,
  };
  if (colors.length === 3) {
    metadata.recolors = colors.map((color) => [...color.value]);
    metadata.recolors[2] = nativeThirdToHalfRange(metadata.recolors[2]);
  } else if (colors.length) metadata.recolors_observed = colors.map((color) => [...color.value]);
  if (matrices.length === 1) metadata.local_matrix_game = [...matrices[0].value];
  return {
    mesh_pool: meshPool, material_pool: materialPool,
    mesh_slot: meshSlot, material, metadata, marker_position: position,
  };
}

interface InlineCollection {
  operation: number;
  marker_position: number;
  parts: TypedPart[];
  inline_markers: Set<number>;
  entry_positions: Set<number>;
}

// Atomic mixed inline/pooled typed collections in event order.
function inlineTypedCollections(
  row: RegistryRow, resolver: Resolver, byOperation: Map<number, any[]>,
): [InlineCollection[], Map<number, Set<number>>] {
  const collectionsFound: InlineCollection[] = [];
  const consumed = new Map<number, Set<number>>();
  for (const [operation, events] of byOperation) {
    const operationCollections: InlineCollection[] = [];
    for (let position = 0; position < events.length; position++) {
      const [, depth, tag, containerClass] = events[position];
      if (tag !== 0x24 || !isInt(containerClass)) continue;
      let boundary = -1;
      for (let previous = position - 1; previous >= 0; previous--) {
        if (events[previous][1] <= depth) { boundary = previous; break; }
      }
      // A tag-0x20 container has no edge event of its own: its ordered
      // completion events sit two levels below the outer typed marker. A
      // direct depth+1 edge proves a different shape.
      let directChild = false;
      for (let i = boundary + 1; i < position; i++) {
        if (events[i][1] === depth + 1) { directChild = true; break; }
      }
      if (directChild) continue;
      const entries: [number, any][] = [];
      for (let i = boundary + 1; i < position; i++) {
        if (events[i][1] === depth + 2) entries.push([i, events[i]]);
      }
      if (!entries.length) continue;

      let parts: TypedPart[] = [];
      const inlineMarkers = new Set<number>();
      for (let seriesIndex = 0; seriesIndex < entries.length; seriesIndex++) {
        const [childPosition, child] = entries[seriesIndex];
        let part;
        if (child[2] === 0x24) {
          part = inlineTypedComponent(events, childPosition, resolver);
          if (part === null || part.metadata.captured_fields !== 6
              || !('recolors' in part.metadata) || !('local_matrix_game' in part.metadata)) {
            parts = [];
            break;
          }
          inlineMarkers.add(childPosition);
        } else if (child[2] === 0 && isInt(child[3])) {
          part = typedPartRecord(resolver, { tag: 0, value: child[3] });
          if (part === null) { parts = []; break; }
        } else {
          parts = [];
          break;
        }
        part = { ...part, series_index: seriesIndex };
        part.metadata = {
          ...part.metadata,
          typed_container_class: containerClass,
          typed_container_depth: depth,
          typed_collection: true,
          typed_collection_scope: 'inline',
        };
        parts.push(part);
      }
      if (!parts.length) continue;
      if (new Set(parts.map((part) => part.metadata.typed_class)).size !== 1) continue;
      operationCollections.push({
        operation,
        marker_position: position,
        parts,
        inline_markers: inlineMarkers,
        entry_positions: new Set(entries.map(([i]) => i)),
      });
    }

    operationCollections.sort((a, b) => a.marker_position - b.marker_position);
    operationCollections.forEach((collection, collectionOrdinal) => {
      for (const part of collection.parts) part.metadata.collection_ordinal = collectionOrdinal;
      let set = consumed.get(operation);
      if (!set) consumed.set(operation, set = new Set());
      for (const p of collection.entry_positions) set.add(p);
      collectionsFound.push(collection);
    });
  }
  return [collectionsFound, consumed];
}

// Standalone inline typed components from postorder events.
function* inlineTypedComponents(
  row: RegistryRow, resolver: Resolver, consumed: Map<number, Set<number>>,
  byOperation: Map<number, any[]>,
): Generator<TypedPart> {
  for (const [operation, events] of byOperation) {
    const consumedSet = consumed.get(operation);
    let markerIndex = 0;
    for (let position = 0; position < events.length; position++) {
      if (events[position][2] !== 0x24) continue;
      const index = markerIndex++;
      if (consumedSet && consumedSet.has(position)) continue;
      const component = inlineTypedComponent(events, position, resolver);
      if (component === null) continue;
      delete component.marker_position;
      component.operation = operation;
      component.series_index = index;
      yield component;
    }
  }
}

// Optional scalar-index provenance immediately before a collection.
function adjacentCatalogIndex(
  decoded: Map<number, DecodedField>, resolver: Resolver, operation: number,
): Record<string, any> {
  const field = decoded.get(operation - 1);
  if (!field || field.series || field.nodes.length !== 1) return {};
  const node = resolver.deref(field.nodes[0]);
  if (!(isNode(node) && node.tag === 0x0a && isInt(node.value))) return {};
  return { catalog_index: node.value, catalog_index_field_op: operation - 1 };
}

// Exact typed parts referenced by nested tag-0 edges; repeated lifecycle
// references to the same pooled object collapse per owner/op.
function* nestedTypedReferences(
  row: RegistryRow, resolver: Resolver, consumed: Map<number, Set<number>>,
  partCache: Map<number, TypedPart | null>, byOperation: Map<number, any[]>,
): Generator<TypedPart> {
  for (const [operation, events] of byOperation) {
    const consumedSet = consumed.get(operation);
    const seenPoolRefs = new Set<number>();
    for (let eventPosition = 0; eventPosition < events.length; eventPosition++) {
      const [, depth, tag, poolIndex] = events[eventPosition];
      if (depth <= 0 || tag !== 0 || !isInt(poolIndex)
          || (consumedSet && consumedSet.has(eventPosition))) continue;
      if (!partCache.has(poolIndex)) {
        partCache.set(poolIndex, typedPartRecord(resolver, { tag: 0, value: poolIndex }));
      }
      const part = partCache.get(poolIndex);
      if (part === null || part === undefined) continue;
      if (seenPoolRefs.has(poolIndex)) continue;
      seenPoolRefs.add(poolIndex);
      yield {
        ...part,
        operation,
        metadata: {
          ...part.metadata,
          nested_typed_ref: true,
          typed_ref_depth: depth,
          typed_ref_event_index: eventPosition,
          typed_ref_pool: poolIndex,
        },
      };
    }
  }
}

// ------------------------------------------------------------ extraction

export function extractRecords(
  rows: RegistryRow[], pool: any[], meshSlots: Map<number, number>,
  materialTextures: Map<number, number[]>,
  onProgress: ((done: number, total: number) => void) | null = null,
  actorSlots: Set<number> | null = null,
): AssetRecord[] {
  const resolver = new Resolver(pool, meshSlots);
  const records: AssetRecord[] = [];
  const seen = new Set<string>();
  const nestedPartCache = new Map<number, TypedPart | null>();

  const emit = (
    row: RegistryRow, meshOp: number, materialOp: number, seriesIndex: number,
    meshSlot: number, material: number, rule: string, confidence: string,
    meshPool: number | null = null, materialPool: number | null = null,
    metadata: Record<string, any> | null = null,
  ) => {
    metadata = metadata || {};
    const key = `${row.slot}|${meshOp}|${materialOp}|${seriesIndex}|${meshSlot}|${material}|${rule}|${metadata.collection_ordinal ?? 'None'}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({
      owner_slot: row.slot,
      owner_selector: row.selector,
      owner_runtime: row.runtime,
      owner_start: row.start,
      mesh_field_op: meshOp,
      material_field_op: materialOp,
      series_index: seriesIndex,
      mesh_pool: meshPool,
      material_pool: materialPool,
      mesh_def_slot: meshSlot,
      ab5_mesh: meshSlots.get(meshSlot)!,
      material_handle: material,
      material_object_slot: material,
      ab3_textures: [...(materialTextures.get(material) || [])],
      rule,
      confidence,
      ...metadata,
    });
  };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (onProgress && rowIndex % 16384 === 0) onProgress(rowIndex, rows.length);
    const rowRecordStart = records.length;
    const decoded = decodeOwnerFields(row, pool, resolver);
    const byOperation = eventsByOperation(row);

    // Pooled typed collections first, so even a singleton collection retains
    // its collection proof and is not emitted twice under two rules.
    const pooledByOperation = new Map<number, TypedPart[][]>();
    const pooledElements = new Set<string>();
    for (const [op, field] of decoded) {
      // Bare depth-one references to typed visual objects are the
      // nested-reference scanner's territory; decoding them here as well
      // would emit every such part twice.
      if (field.scope !== 'pooled') continue;
      for (let elementIndex = 0; elementIndex < field.nodes.length; elementIndex++) {
        const parts = pooledTypedCollection(resolver, field.nodes[elementIndex]);
        if (parts === null) continue;
        let list = pooledByOperation.get(op);
        if (!list) pooledByOperation.set(op, list = []);
        const collectionOrdinal = list.length;
        const provenance = adjacentCatalogIndex(decoded, resolver, op);
        for (const part of parts) {
          part.metadata = { ...part.metadata, ...provenance, collection_ordinal: collectionOrdinal };
        }
        list.push(parts);
        pooledElements.add(`${op}|${elementIndex}`);
      }
    }
    for (const [op, collectionsForOp] of pooledByOperation) {
      for (const parts of collectionsForOp) {
        for (const part of parts) {
          emit(row, op, op, part.series_index!, part.mesh_slot, part.material,
            'typed_component_collection', 'exact_native_typed_collection',
            part.mesh_pool, part.material_pool, part.metadata);
        }
      }
    }

    // One structured element containing exactly one mesh and material.
    for (const [op, field] of decoded) {
      if (field.scope !== 'pooled') continue;
      for (let index = 0; index < field.elements.length; index++) {
        if (pooledElements.has(`${op}|${index}`)) continue;
        const [meshes, materials] = field.elements[index];
        const meshSlot = oneUnique(meshes);
        const material = oneUnique(materials);
        if (meshSlot !== null && material !== null) {
          emit(row, op, op, index, meshSlot, material,
            'typed_meshmat', 'exact_native_typed_object',
            field.pool, field.pool, typedPartMetadata(resolver, field.nodes[index]));
        }
      }
    }

    // Inline/default-expanded collection entries are postorder completion
    // events; recover mixed inline/ref siblings atomically, then standalone
    // typed objects that were not consumed by a complete collection.
    const [inlineCollections, consumed] = inlineTypedCollections(row, resolver, byOperation);
    for (const collection of inlineCollections) {
      const op = collection.operation;
      const ordinalOffset = (pooledByOperation.get(op) || []).length;
      const provenance = adjacentCatalogIndex(decoded, resolver, op);
      for (const component of collection.parts) {
        const metadata = {
          ...component.metadata,
          ...provenance,
          collection_ordinal: component.metadata.collection_ordinal + ordinalOffset,
        };
        emit(row, op, op, component.series_index!, component.mesh_slot, component.material,
          'typed_component_collection', 'exact_native_inline_typed_collection',
          component.mesh_pool, component.material_pool, metadata);
      }
    }
    for (const component of inlineTypedComponents(row, resolver, consumed, byOperation)) {
      emit(row, component.operation!, component.operation!, component.series_index!,
        component.mesh_slot, component.material, 'typed_meshmat',
        'exact_native_inline_typed_object', component.mesh_pool, component.material_pool,
        component.metadata);
    }

    // Compiled static_mesh/static_material fields and parallel _series.
    for (const [meshOp, meshField] of decoded) {
      const materialOp = meshOp + 1;
      const materialField = decoded.get(materialOp);
      if (materialField === undefined) continue;
      if (meshField.elements.length !== materialField.elements.length) continue;
      let pairs: [number, number, number][] = [];
      for (let index = 0; index < meshField.elements.length; index++) {
        const [meshes, meshMats] = meshField.elements[index];
        const [matMeshes, materials] = materialField.elements[index];
        if (meshMats.length || matMeshes.length) { pairs = []; break; }
        const meshSlot = oneUnique(meshes);
        const material = oneUnique(materials);
        if (meshSlot === null || material === null) { pairs = []; break; }
        pairs.push([index, meshSlot, material]);
      }
      if (!pairs.length) continue;
      const isSeries = meshField.series || materialField.series;
      const rule = isSeries ? 'parallel_series' : 'adjacent_scalar';
      const confidence = isSeries ? 'exact_native_positional' : 'exact_native_adjacent_fields';
      const recolors = parallelRecolors(decoded, resolver, materialOp, pairs.length, row);
      // The two-tint actor pair has no third modulation colour; it travels as
      // OBSERVED colours rather than a fabricated complete triple.
      const recolorField = recolors !== null && recolors.scope.startsWith('actor_pair')
        ? 'recolors_observed' : 'recolors';
      for (const [index, meshSlot, material] of pairs) {
        emit(row, meshOp, materialOp, index, meshSlot, material, rule, confidence,
          meshField.pool, materialField.pool,
          recolors === null ? null : {
            [recolorField]: recolors.values[index],
            recolor_field_ops: recolors.field_ops,
            recolor_scope: recolors.scope,
            recolor_channel_scopes: recolors.channel_scopes,
          });
      }
    }

    // Nested tag-0 edges pointing directly at already-pooled six-field
    // visual components.
    const nestedOrdinals = new Map<number, number>();
    for (const component of nestedTypedReferences(row, resolver, consumed, nestedPartCache, byOperation)) {
      const op = component.operation!;
      const seriesIndex = nestedOrdinals.get(op) || 0;
      nestedOrdinals.set(op, seriesIndex + 1);
      emit(row, op, op, seriesIndex, component.mesh_slot, component.material,
        'nested_typed_ref', 'exact_native_nested_typed_ref',
        component.mesh_pool, component.material_pool, component.metadata);
    }

    const ownerMeshes: number[] = [];
    const ownerMaterials: number[] = [];
    const meshOps: number[] = [];
    const materialOps: number[] = [];
    const meshOccurrences = new Map<number, Set<number>>();
    const materialOccurrences = new Map<number, Set<number>>();
    for (const [op, field] of decoded) {
      for (const [meshes, materials] of field.elements) {
        for (const value of meshes) ownerMeshes.push(value);
        for (const value of materials) ownerMaterials.push(value);
        if (meshes.length) meshOps.push(op);
        if (materials.length) materialOps.push(op);
        for (const value of new Set(meshes)) {
          let set = meshOccurrences.get(value);
          if (!set) meshOccurrences.set(value, set = new Set());
          set.add(op);
        }
        for (const value of new Set(materials)) {
          let set = materialOccurrences.get(value);
          if (!set) materialOccurrences.set(value, set = new Set());
          set.add(op);
        }
      }
    }

    // Inherited active-block schemas can repeat one authored visual pair in
    // several lifecycle subobjects: a qualified structural inference,
    // suppressed whenever an exact rule already assigns this owner+mesh.
    for (const [repeatedMesh, meshPositionsSet] of meshOccurrences) {
      const meshPositions = [...meshPositionsSet].sort((a, b) => a - b);
      if (meshPositions.length < 2) continue;
      const candidates: [number, number[]][] = [];
      for (const [repeatedMaterial, materialPositionsSet] of materialOccurrences) {
        const materialPositions = [...materialPositionsSet].sort((a, b) => a - b);
        if (materialPositions.length !== meshPositions.length) continue;
        const overlap = Math.min(meshPositions[meshPositions.length - 1],
          materialPositions[materialPositions.length - 1])
          - Math.max(meshPositions[0], materialPositions[0]);
        if (overlap <= 0) continue;
        const nearest = (a: number[], b: number[]) => {
          let worst = -Infinity;
          for (const p of a) {
            let best = Infinity;
            for (const o of b) best = Math.min(best, Math.abs(p - o));
            worst = Math.max(worst, best);
          }
          return worst;
        };
        const maxNearest = Math.max(nearest(meshPositions, materialPositions),
          nearest(materialPositions, meshPositions));
        if (maxNearest <= 16) candidates.push([repeatedMaterial, materialPositions]);
      }
      if (candidates.length !== 1) continue;
      const [repeatedMaterial, materialPositions] = candidates[0];
      let alreadyStrong = false;
      for (let i = rowRecordStart; i < records.length; i++) {
        if (records[i].mesh_def_slot === repeatedMesh) { alreadyStrong = true; break; }
      }
      if (!alreadyStrong) {
        emit(row, meshPositions[0], materialPositions[0], 0, repeatedMesh, repeatedMaterial,
          'repeated_interleaved', 'inferred_native_repeated_interleaving');
      }
    }

    // Explicitly weaker tier: the entire owner collapses to one mesh and one
    // material after all inherited fields collapse.
    const meshSlot = oneUnique(ownerMeshes);
    const material = oneUnique(ownerMaterials);
    if (meshSlot !== null && material !== null) {
      let alreadyStrong = false;
      for (let i = rowRecordStart; i < records.length; i++) {
        const record = records[i];
        if (record.mesh_def_slot === meshSlot && record.material_handle === material
            && record.rule !== 'unique_owner') { alreadyStrong = true; break; }
      }
      if (!alreadyStrong) {
        emit(row, Math.min(...meshOps), Math.min(...materialOps), 0, meshSlot, material,
          'unique_owner', 'strong_owner_uniqueness');
      }
    }

    // Room-spawn actor appearance (a port of the proven spawns.js rule): the
    // actor schema serializes its mesh series and its material series at
    // NON-adjacent reader operations (11 -> 14 in the supported builds), which
    // the materialOp === meshOp + 1 rule above cannot see. One unique
    // (mesh series, later material series) candidate with equal cardinality
    // and no other asset field between the two operations is exact; anything
    // ambiguous stays skipped. Deliberately scoped to room-spawn actor rows
    // that produced no record at all, and emitted last, so it can never
    // suppress, reorder, or re-rank an existing rule's output (the broad
    // all-rows form was measured to add 657 owner/mesh pairs with zero new
    // mesh coverage and a texture-variant reordering risk — not taken).
    if (actorSlots !== null && actorSlots.has(row.slot) && records.length === rowRecordStart) {
      const meshFields: [number, DecodedField, number[]][] = [];
      const materialFields: [number, DecodedField, number[]][] = [];
      const assetOps: number[] = [];
      for (const [op, field] of decoded) {
        if (field.scope !== 'pooled') continue;
        let meshes: number[] | null = field.elements.length ? [] : null;
        let materials: number[] | null = field.elements.length ? [] : null;
        let hasAssets = false;
        for (const [elementMeshes, elementMaterials] of field.elements) {
          if (elementMeshes.length || elementMaterials.length) hasAssets = true;
          if (meshes !== null) {
            const slot = oneUnique(elementMeshes);
            meshes = slot !== null && !elementMaterials.length ? [...meshes, slot] : null;
          }
          if (materials !== null) {
            const handle = oneUnique(elementMaterials);
            materials = handle !== null && !elementMeshes.length
              && (materialTextures.get(handle) || []).length === 1
              ? [...materials, handle] : null;
          }
        }
        if (hasAssets) assetOps.push(op);
        if (meshes !== null && meshes.length) meshFields.push([op, field, meshes]);
        if (materials !== null && materials.length) materialFields.push([op, field, materials]);
      }
      const candidates: [number, number, DecodedField, DecodedField, number[], number[]][] = [];
      for (const [meshOp, meshField, meshes] of meshFields) {
        for (const [materialOp, materialField, materials] of materialFields) {
          if (!(meshOp < materialOp) || meshes.length !== materials.length) continue;
          let blocked = false;
          for (const op of assetOps) {
            if (op > meshOp && op < materialOp) { blocked = true; break; }
          }
          if (!blocked) {
            candidates.push([meshOp, materialOp, meshField, materialField, meshes, materials]);
          }
        }
      }
      if (candidates.length === 1) {
        const [meshOp, materialOp, meshField, materialField, meshes, materials] = candidates[0];
        const recolors = parallelRecolors(decoded, resolver, materialOp, meshes.length, row);
        const recolorField = recolors !== null && recolors.scope.startsWith('actor_pair')
          ? 'recolors_observed' : 'recolors';
        for (let index = 0; index < meshes.length; index++) {
          emit(row, meshOp, materialOp, index, meshes[index], materials[index],
            'actor_appearance', 'exact_native_actor_appearance',
            meshField.pool, materialField.pool,
            recolors === null ? null : {
              [recolorField]: recolors.values[index],
              recolor_field_ops: recolors.field_ops,
              recolor_scope: recolors.scope,
              recolor_channel_scopes: recolors.channel_scopes,
            });
        }
      }
    }
  }
  if (onProgress) onProgress(rows.length, rows.length);
  return records;
}

// ------------------------------------------------- entity variant families

export const isTechnicalLabel = (value: any): value is string => typeof value === 'string'
  && TECHNICAL_LABEL_RE.test(value) && /[_./#[\]-]/.test(value);

// Title-case: uppercase every cased char that follows an uncased one.
export function pyTitle(s: string): string {
  let out = '';
  let prevCased = false;
  for (const ch of s) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    const cased = lower !== upper;
    out += cased ? (prevCased ? lower : upper) : ch;
    prevCased = cased;
  }
  return out;
}

// Indexed enemy-family appearances, including inherited material.
// With `strings`, pool-interned family names and per-entity display prefixes
// participate ("Slimy" + "Fire Toad"); with `materialBatches`, an *omitted*
// (inherited) material selects the member of its authored 0..k family at the
// variant's own index (Cave Hyena). Explicit materials always win.
export function extractEntityVariantRecords(
  rows: RegistryRow[], pool: any[], meshSlots: Map<number, number>,
  materialTextures: Map<number, number[]>, strings: PoolStrings | null = null,
  materialBatches: MaterialVariantBatch[] | null = null,
): AssetRecord[] {
  const resolver = new Resolver(pool, meshSlots);
  const rowsBySlot = new Map<number, RegistryRow>();
  for (const row of rows) if (row && isInt(row.slot)) rowsBySlot.set(row.slot, row);
  const registryCache = new Map<number, number[]>();

  const registryRefs = (node: any, active: Set<number> | null = null): number[] => {
    active = active || new Set();
    if (!isNode(node)) return [];
    const { tag, value } = node;
    if (tag === 0) {
      if (!isInt(value) || value < 0 || value >= pool.length || active.has(value)) return [];
      if (registryCache.has(value)) return registryCache.get(value)!;
      active.add(value);
      const result = registryRefs(pool[value], active);
      active.delete(value);
      registryCache.set(value, result);
      return result;
    }
    const result: number[] = [];
    if (tag === 0x26 && isInt(value)) result.push(value);
    if (Array.isArray(node.fields)) for (const child of node.fields) result.push(...registryRefs(child, active));
    if (Array.isArray(node.values)) for (const child of node.values) result.push(...registryRefs(child, active));
    if (isNode(value)) result.push(...registryRefs(value, active));
    return orderedUnique(result);
  };

  const poolRegistry = (poolIndex: any): number | null => {
    if (!isInt(poolIndex) || poolIndex < 0 || poolIndex >= pool.length) return null;
    const values = registryRefs({ tag: 0, value: poolIndex });
    return values.length === 1 ? values[0] : null;
  };

  const rowStringEvents = (row: RegistryRow): StringEvent[] => (strings !== null
    ? strings.directStrings(row) : directSourceStrings(row));

  // The entity row's single depth-zero technical identifier.
  const technicalName = (row: RegistryRow): string | null => {
    const names = [];
    for (const event of rowStringEvents(row)) {
      if (isTechnicalLabel(event.text)) names.push(event.text);
    }
    return names.length === 1 ? names[0] : null;
  };

  // The row's first short label string; family rows carry the display name
  // at their lowest string field, before the plural form.
  const firstLabel = (row: RegistryRow): string | null => {
    for (const event of rowStringEvents(row)) {
      const text = event.text;
      if (text.trim() && isLabelString(text) && !isSentenceLike(text)) return text;
    }
    return null;
  };

  // The entity row's single non-technical label ("Slimy", "Grayspot").
  const displayPrefix = (row: RegistryRow, technical: string | null): [string | null, StringEvent | null] => {
    const labels: [string, StringEvent][] = [];
    for (const event of rowStringEvents(row)) {
      const text = event.text;
      if (text.trim() && isLabelString(text) && !isSentenceLike(text)
          && !isTechnicalLabel(text) && text !== technical) {
        labels.push([text, event]);
      }
    }
    const unique = orderedUnique(labels.map(([text]) => text));
    if (unique.length !== 1) return [null, null];
    const event = labels.find(([text]) => text === unique[0])![1];
    return [unique[0], event];
  };

  const indexedOperation = (visualRows: RegistryRow[]): number | null => {
    let operations: Set<number> | null = null;
    for (const row of visualRows) {
      const current = new Set<number>();
      for (const [op, kind, value] of row.v || []) {
        if (kind === 'U' && isInt(value)) current.add(op);
      }
      operations = operations === null ? current
        : new Set([...operations].filter((op: number) => current.has(op)));
    }
    const matches = [];
    for (const operation of operations || []) {
      let all = true;
      for (let index = 0; index < visualRows.length; index++) {
        const values = [];
        for (const [op, kind, value] of visualRows[index].v || []) {
          if (op === operation && kind === 'U') values.push(value);
        }
        if (values.length !== 1 || values[0] !== index) { all = false; break; }
      }
      if (all) matches.push(operation);
    }
    return matches.length === 1 ? matches[0] : null;
  };

  const predecessorOperation = (entityRows: RegistryRow[], entitySlots: (number | null)[]): number | null => {
    let candidates: Set<number> | null = null;
    for (let index = 1; index < entityRows.length; index++) {
      const current = new Map<number, number[]>();
      for (const [op, depth, tag, value] of entityRows[index].g || []) {
        if (depth === 0 && tag === 0 && isInt(value)) {
          const target = poolRegistry(value);
          if (target !== null) {
            let list = current.get(op);
            if (!list) current.set(op, list = []);
            list.push(target);
          }
        }
      }
      const matching = new Set<number>();
      for (const [op, targets] of current) {
        if (targets.length === 1 && targets[0] === entitySlots[index - 1]) matching.add(op);
      }
      candidates = candidates === null ? matching
        : new Set([...candidates].filter((op: number) => matching.has(op)));
    }
    const valid = [];
    for (const operation of candidates || []) {
      const firstTargets = [];
      for (const [op, depth, tag, value] of entityRows[0].g || []) {
        if (op === operation && depth === 0 && tag === 0) firstTargets.push(poolRegistry(value));
      }
      if (!firstTargets.some((target) => target !== null)) valid.push(operation);
    }
    return valid.length === 1 ? valid[0] : null;
  };

  const records: AssetRecord[] = [];
  const seenFamilies = new Set<string>();
  for (const familyRow of rows) {
    const seriesFields = new Map<number, number[]>();
    for (const [op, depth, tag, value] of familyRow.g || []) {
      if (depth > 0 && tag === 0 && isInt(value)) {
        let list = seriesFields.get(op);
        if (!list) seriesFields.set(op, list = []);
        list.push(value);
      }
    }
    for (const [familyOperation, poolIndices] of seriesFields) {
      if (poolIndices.length < 2) continue;
      const entitySlots = poolIndices.map(poolRegistry);
      if (entitySlots.some((slot) => slot === null || !rowsBySlot.has(slot))
          || new Set(entitySlots).size !== entitySlots.length) continue;
      const entityRows = entitySlots.map((slot) => rowsBySlot.get(slot!)!);
      const entityReader = new Set(entityRows.map((row) => `${row.selector}\u0000${row.runtime}`));
      const entityNames = entityRows.map(technicalName);
      if (entityReader.size !== 1 || entityNames.some((name) => !isTechnicalLabel(name))) continue;

      // The one reader operation pointing every named entity at one unique
      // visual owner of a shared generated class.
      let visualOperations: Set<number> | null = null;
      const directVisuals: Map<number, number[]>[] = [];
      for (const row of entityRows) {
        const byOp = new Map<number, number[]>();
        for (const [op, depth, tag, value] of row.g || []) {
          if (depth > 0 && tag === 0x26 && rowsBySlot.has(value)) {
            let list = byOp.get(op);
            if (!list) byOp.set(op, list = []);
            list.push(value);
          }
        }
        directVisuals.push(byOp);
        const operations = new Set<number>();
        for (const [op, values] of byOp) if (values.length === 1) operations.add(op);
        visualOperations = visualOperations === null ? operations
          : new Set([...visualOperations].filter((op: number) => operations.has(op)));
      }
      const visualCandidates: [number, number[], RegistryRow[], number][] = [];
      for (const visualOperation of visualOperations || []) {
        const visualSlots = directVisuals.map((byOp) => byOp.get(visualOperation)![0]);
        if (new Set(visualSlots).size !== visualSlots.length) continue;
        const visualRows = visualSlots.map((slot) => rowsBySlot.get(slot)!);
        if (new Set(visualRows.map((row) => `${row.selector}\u0000${row.runtime}`)).size !== 1) continue;
        const catalogIndexOperation = indexedOperation(visualRows);
        if (catalogIndexOperation !== null) {
          visualCandidates.push([visualOperation, visualSlots, visualRows, catalogIndexOperation]);
        }
      }
      if (visualCandidates.length !== 1) continue;
      const [visualOperation, visualSlots, visualRows, catalogIndexOperation] = visualCandidates[0];
      const familyKey = visualSlots.join(',');
      if (seenFamilies.has(familyKey)) continue;

      const predecessorOp = predecessorOperation(entityRows, entitySlots);
      if (predecessorOp === null) continue;

      const decodedRows = visualRows.map((row) => decodeOwnerFields(row, pool, resolver));

      const exactMeshSeries = (field: DecodedField | undefined): number[] | null => {
        if (!field || !field.elements.length) return null;
        const out = [];
        for (const [elementMeshes, elementMaterials] of field.elements) {
          const slot = oneUnique(elementMeshes);
          if (slot === null || elementMaterials.length) return null;
          out.push(slot);
        }
        return out;
      };
      const exactMaterialSeries = (field: DecodedField | undefined): number[] | null => {
        if (!field || !field.elements.length) return null;
        const out = [];
        for (const [elementMeshes, elementMaterials] of field.elements) {
          const handle = oneUnique(elementMaterials);
          if (handle === null || elementMeshes.length) return null;
          out.push(handle);
        }
        return out;
      };

      // Every visual row must expose one ordered mesh composition at a shared
      // operation whose next operation is its equal-cardinality material
      // series (or is omitted and inherited); the complete family closure
      // must select exactly one operation.
      let candidateOps: Set<number> | null = null;
      const rowMeshSeries: Map<number, [number[], DecodedField]>[] = [];
      for (const decoded of decodedRows) {
        const current = new Map<number, [number[], DecodedField]>();
        for (const [operation, field] of decoded) {
          const meshes = exactMeshSeries(field);
          if (meshes && meshes.length) current.set(operation, [meshes, field]);
        }
        rowMeshSeries.push(current);
        candidateOps = candidateOps === null ? new Set(current.keys())
          : new Set([...candidateOps].filter((op: number) => current.has(op)));
      }
      type ClosureEntry = [number[], DecodedField, [number[], DecodedField] | null];
      const closedOps: [number, ClosureEntry[]][] = [];
      for (const operation of [...(candidateOps || [])].sort((a, b) => a - b)) {
        let closure: ClosureEntry[] | null = [];
        for (let rowIndex = 0; rowIndex < decodedRows.length; rowIndex++) {
          const decoded = decodedRows[rowIndex];
          const [meshes, meshField] = rowMeshSeries[rowIndex].get(operation)!;
          const materialField = decoded.get(operation + 1);
          if (materialField === undefined) {
            closure.push([meshes, meshField, null]);
            continue;
          }
          const handles = exactMaterialSeries(materialField);
          if (handles === null || handles.length !== meshes.length) { closure = null; break; }
          closure.push([meshes, meshField, [handles, materialField]]);
        }
        if (closure !== null && closure[0][2] !== null) closedOps.push([operation, closure]);
      }
      if (closedOps.length !== 1) continue;
      const [meshOperation, closure] = closedOps[0];
      const materialOperation = meshOperation + 1;

      const batchMembersByHandle = new Map<number, [MaterialVariantBatch, number]>();
      if (materialBatches) {
        for (const batch of materialBatches) {
          for (const member of batch.members || []) {
            batchMembersByHandle.set(member.material_handle, [batch, member.index]);
          }
        }
      }

      const familyName = firstLabel(familyRow);
      let activeMaterials: number[] | null = null;
      let activeMaterialPool: number | null = null;
      let activeMaterialOwner: number | null = null;
      const pending: AssetRecord[] = [];
      let familyValid = true;
      for (let index = 0; index < visualRows.length; index++) {
        const visualRow = visualRows[index];
        const decoded = decodedRows[index];
        const [meshes, meshField, materialInfo] = closure[index];
        if (materialInfo !== null) {
          activeMaterials = materialInfo[0];
          activeMaterialPool = materialInfo[1].pool;
          activeMaterialOwner = visualRow.slot;
        }
        if (activeMaterials === null || activeMaterials.length !== meshes.length) {
          familyValid = false;
          break;
        }
        const recolors = parallelRecolors(decoded, resolver, materialOperation, meshes.length, visualRow);
        const [prefix, prefixEvent] = displayPrefix(entityRows[index], entityNames[index]);
        let displayName;
        if (prefix && familyName) displayName = `${prefix} ${familyName}`;
        else if (prefix) displayName = prefix;
        else displayName = pyTitle(entityNames[index]!.replace(/_/g, ' '));
        const nameProvenance: Record<string, any> = {
          kind: 'entity_family_variant',
          entity_owner_slot: entitySlots[index],
          field_op: rowStringEvents(entityRows[index]).find(
            (event) => event.text === entityNames[index],
          )!.field_op,
          raw: entityNames[index],
        };
        if (prefix) {
          nameProvenance.display_prefix = prefix;
          nameProvenance.display_prefix_field_op = prefixEvent!.field_op;
        }

        for (let partIndex = 0; partIndex < meshes.length; partIndex++) {
          const meshSlot = meshes[partIndex];
          let material = activeMaterials[partIndex];
          let materialSelection: Record<string, any> | null = null;
          if (materialInfo === null && batchMembersByHandle.size) {
            const batchAndMember = batchMembersByHandle.get(material);
            if (batchAndMember !== undefined) {
              const [batch] = batchAndMember;
              const members = batch.members || [];
              if (members.length >= visualRows.length && index < members.length) {
                materialSelection = {
                  source: 'native_entity_family',
                  kind: 'indexed_material_selection',
                  batch_index: batch.batch_index,
                  member_index: index,
                  member_count: members.length,
                  anchor_material_handle: material,
                };
                material = members[index].material_handle;
              }
            }
          }
          const record: AssetRecord = {
            owner_slot: visualRow.slot,
            owner_selector: visualRow.selector,
            owner_runtime: visualRow.runtime,
            owner_start: visualRow.start,
            mesh_field_op: meshOperation,
            material_field_op: materialOperation,
            series_index: partIndex,
            mesh_pool: meshField.pool,
            material_pool: activeMaterialPool,
            mesh_def_slot: meshSlot,
            ab5_mesh: meshSlots.get(meshSlot)!,
            material_handle: material,
            material_object_slot: material,
            ab3_textures: [...(materialTextures.get(material) || [])],
            rule: 'entity_variant',
            confidence: 'exact_native_entity_predecessor',
            entity_family_owner_slot: familyRow.slot,
            entity_family_field_op: familyOperation,
            entity_family_name: familyName,
            entity_owner_slot: entitySlots[index],
            entity_visual_field_op: visualOperation,
            entity_variant_index: index,
            entity_variant_index_field_op: catalogIndexOperation,
            entity_variant_name: entityNames[index],
            entity_predecessor_field_op: predecessorOp,
            entity_predecessor_owner_slot: index ? entitySlots[index - 1] : null,
            material_inherited: materialInfo === null,
            material_source_owner_slot: activeMaterialOwner,
            source_name: displayName,
            source_name_provenance: { ...nameProvenance },
          };
          if (materialSelection !== null) record.structural_context = materialSelection;
          if (recolors !== null) {
            // the two-tint actor pair stays observed (no fabricated third colour)
            if (recolors.scope.startsWith('actor_pair')) {
              record.recolors_observed = recolors.values[partIndex];
            } else {
              record.recolors = recolors.values[partIndex];
            }
            record.recolor_field_ops = recolors.field_ops;
            record.recolor_scope = recolors.scope;
            record.recolor_channel_scopes = recolors.channel_scopes;
          }
          pending.push(record);
        }
      }
      if (!familyValid) continue;
      seenFamilies.add(familyKey);
      records.push(...pending);
    }
  }
  return records;
}

// ------------------------------------------------ indexed mesh-def batches

// Explicit `0..k` mesh-definition arrays from registry rows: the Rot Imp
// definition rows index body styles 0..2 plus the cape/weapon mesh 3.
export function extractIndexedMeshDefinitionBatches(rows: RegistryRow[]): MeshDefinitionBatch[] {
  const meshOrdinals = (row: RegistryRow): number[] => {
    const out = new Set<number>();
    for (const [, , tag, value] of row.g || []) {
      if (tag === 0x62 && isInt(value)) out.add(value);
    }
    return [...out];
  };

  const batches: MeshDefinitionBatch[] = [];
  let index = 0;
  while (index < rows.length) {
    const first = rows[index];
    if (meshOrdinals(first).length !== 1) { index++; continue; }
    const candidates: [number, number, RegistryRow[]][] = [];
    for (const [operation, values] of unsignedValues(first)) {
      if (!(values.length === 1 && values[0] === 0)) continue;
      const run = [];
      let cursor = index;
      let expected = 0;
      while (cursor < rows.length) {
        const row = rows[cursor];
        const rowValues = unsignedValues(row).get(operation);
        if (row.selector !== first.selector || row.runtime !== first.runtime
            || meshOrdinals(row).length !== 1
            || !(rowValues && rowValues.length === 1 && rowValues[0] === expected)) break;
        run.push(row);
        cursor++;
        expected++;
      }
      if (run.length >= 2) candidates.push([run.length, operation, run]);
    }
    if (!candidates.length) { index++; continue; }
    const longest = Math.max(...candidates.map(([length]) => length));
    const best = candidates.filter(([length]) => length === longest);
    if (best.length !== 1) { index++; continue; }
    const [, operation, run] = best[0];
    batches.push({
      batch_index: batches.length,
      reader_selector: first.selector,
      reader_runtime: first.runtime,
      index_field_op: operation,
      first_mesh_def_slot: run[0].slot,
      last_mesh_def_slot: run[run.length - 1].slot,
      members: run.map((row, memberIndex) => ({
        index: memberIndex,
        mesh_def_slot: row.slot,
        ab5_mesh: meshOrdinals(row)[0],
      })),
    });
    index += run.length;
  }
  return batches;
}

// ------------------------------------------------ entity family attachments

// Constant attachment parts proven by exact combos over indexed
// mesh-definition batches: a batch member never selected by any variant, but
// exactly combined with a selected member under one consistent material
// elsewhere, attaches to every variant. Nothing attaches without an exact
// combination or on disagreement.
export function extractEntityFamilyAttachmentRecords(
  records: AssetRecord[], rows: RegistryRow[], meshSlots: Map<number, number>,
  materialTextures: Map<number, number[]>, meshdefBatches: MeshDefinitionBatch[],
): AssetRecord[] {
  const batchByDefSlot = new Map<number, [MeshDefinitionBatch, number]>();
  for (const batch of meshdefBatches) {
    for (const member of batch.members || []) {
      batchByDefSlot.set(member.mesh_def_slot, [batch, member.index]);
    }
  }

  // Exact multipart owner groups: owner/field group -> ordered records.
  const combos = new Map<string, AssetRecord[]>();
  for (const record of records) {
    if (!NAMEABLE_MODEL_RULES.has(record.rule)) continue;
    const key = `${record.owner_slot}|${record.mesh_field_op}|${record.material_field_op}|`
      + `${record.rule}|${record.collection_ordinal ?? 'None'}`;
    let list = combos.get(key);
    if (!list) combos.set(key, list = []);
    list.push(record);
  }

  const families = new Map<number, AssetRecord[]>();
  for (const record of records) {
    if (record.rule === 'entity_variant' && !record.entity_attachment) {
      let list = families.get(record.entity_family_owner_slot);
      if (!list) families.set(record.entity_family_owner_slot, list = []);
      list.push(record);
    }
  }

  const attachmentRecords: AssetRecord[] = [];
  for (const familySlot of [...families.keys()].sort((a, b) => a - b)) {
    const familyRecords = families.get(familySlot)!;
    const byVariant = new Map<number, AssetRecord[]>();
    for (const record of familyRecords) {
      let list = byVariant.get(record.entity_variant_index);
      if (!list) byVariant.set(record.entity_variant_index, list = []);
      list.push(record);
    }
    const selectedDefSlots = new Set(familyRecords.map((record) => record.mesh_def_slot));
    const touchedBatches = new Map<number, MeshDefinitionBatch>();
    for (const defSlot of selectedDefSlots) {
      const hit = batchByDefSlot.get(defSlot);
      if (hit !== undefined) touchedBatches.set(hit[0].batch_index, hit[0]);
    }
    const attachments: [number, number, number, number, number[], AssetRecord][] = [];
    for (const batchIndex of [...touchedBatches.keys()].sort((a, b) => a - b)) {
      const batch = touchedBatches.get(batchIndex)!;
      for (const member of batch.members) {
        const defSlot = member.mesh_def_slot;
        if (selectedDefSlots.has(defSlot)) continue;
        // Exact combinations pairing this unselected member with a selected
        // member of the same family.
        const materials = new Map<number, AssetRecord>();
        const proofOwners: number[] = [];
        for (const comboRecords of combos.values()) {
          const comboDefSlots = new Set(comboRecords.map((record) => record.mesh_def_slot));
          if (!comboDefSlots.has(defSlot)) continue;
          let overlaps = false;
          for (const slot of comboDefSlots) {
            if (selectedDefSlots.has(slot)) { overlaps = true; break; }
          }
          if (!overlaps) continue;
          for (const record of comboRecords) {
            if (record.mesh_def_slot === defSlot) {
              if (!materials.has(record.material_handle)) materials.set(record.material_handle, record);
              proofOwners.push(record.owner_slot);
            }
          }
        }
        if (materials.size !== 1) continue;
        const [material, proof] = materials.entries().next().value!;
        attachments.push([
          batchIndex, member.index, defSlot, material,
          orderedUnique(proofOwners).sort((a, b) => a - b), proof,
        ]);
      }
    }
    if (!attachments.length) continue;
    for (const variantIndex of [...byVariant.keys()].sort((a, b) => a - b)) {
      const variantRecords = byVariant.get(variantIndex)!;
      const base = variantRecords[0];
      const nextSeries = 1 + Math.max(...variantRecords.map((record) => record.series_index));
      for (let offset = 0; offset < attachments.length; offset++) {
        const [batchIndex, memberIndex, defSlot, material, proofOwners, proof] = attachments[offset];
        const record: Record<string, any> = {};
        for (const field of [
          'owner_slot', 'owner_selector', 'owner_runtime',
          'owner_start', 'mesh_field_op', 'material_field_op',
          'entity_family_owner_slot', 'entity_family_field_op',
          'entity_family_name', 'entity_owner_slot',
          'entity_visual_field_op', 'entity_variant_index',
          'entity_variant_index_field_op', 'entity_variant_name',
          'entity_predecessor_field_op',
          'entity_predecessor_owner_slot',
          'source_name', 'source_name_provenance',
        ]) {
          if (field in base) record[field] = base[field];
        }
        record.series_index = nextSeries + offset;
        record.mesh_pool = null;
        record.material_pool = null;
        record.mesh_def_slot = defSlot;
        record.ab5_mesh = meshSlots.get(defSlot);
        record.material_handle = material;
        record.material_object_slot = material;
        record.ab3_textures = [...(materialTextures.get(material) || [])];
        record.rule = 'entity_variant';
        record.confidence = 'structural_entity_family_attachment';
        record.material_inherited = false;
        record.material_source_owner_slot = proof.owner_slot;
        record.entity_attachment = true;
        record.structural_context = {
          source: 'native_entity_family',
          kind: 'family_attachment',
          mesh_def_batch_index: batchIndex,
          mesh_def_member_index: memberIndex,
          proof_owner_slots: proofOwners,
          proof_rule: proof.rule,
        };
        attachmentRecords.push(record as AssetRecord);
      }
    }
  }
  return attachmentRecords;
}

// --------------------------------------------------- alias/sibling materials

// Exact materials across explicit mesh-definition alias edges — binding-only,
// for meshes no direct record covers.
export function extractMeshDefAliasRecords(
  rows: RegistryRow[], records: AssetRecord[], pool: any[],
  meshSlots: Map<number, number>, materialTextures: Map<number, number[]>,
): AssetRecord[] {
  const resolver = new Resolver(pool, meshSlots);
  const edges: [number, number, number][] = [];
  for (const slot of [...meshSlots.keys()].sort((a, b) => a - b)) {
    const row = rows[slot];
    for (const [op, depth, tag, value] of row.g || []) {
      if (depth !== 0 || tag !== 0 || !isInt(value)) continue;
      const node = resolver.deref({ tag: 0, value });
      if (!(isNode(node) && node.tag === 0x26)) continue;
      const target = node.value;
      if (isInt(target) && meshSlots.has(target) && target !== slot) {
        edges.push([slot, target, op]);
      }
    }
  }

  const sourceByMesh = new Map<number, AssetRecord[]>();
  const coveredMeshes = new Set<number>();
  for (const record of records) {
    coveredMeshes.add(record.ab5_mesh);
    if (record.rule !== 'mesh_def_alias_material') {
      let list = sourceByMesh.get(record.ab5_mesh);
      if (!list) sourceByMesh.set(record.ab5_mesh, list = []);
      list.push(record);
    }
  }

  const aliasRecords: AssetRecord[] = [];
  const seen = new Set<string>();
  for (const [sourceSlot, targetSlot, op] of edges) {
    for (const [fromSlot, toSlot, direction] of [
      [sourceSlot, targetSlot, 'forward'],
      [targetSlot, sourceSlot, 'reverse'],
    ] as [number, number, string][]) {
      const fromMesh = meshSlots.get(fromSlot)!;
      const toMesh = meshSlots.get(toSlot)!;
      if (coveredMeshes.has(toMesh)) continue;
      for (const record of sourceByMesh.get(fromMesh) || []) {
        const key = `${toMesh}|${record.material_handle}`;
        if (seen.has(key)) continue;
        seen.add(key);
        aliasRecords.push({
          owner_slot: record.owner_slot,
          owner_selector: record.owner_selector,
          owner_runtime: record.owner_runtime,
          owner_start: record.owner_start,
          mesh_field_op: record.mesh_field_op,
          material_field_op: record.material_field_op,
          series_index: record.series_index,
          mesh_pool: null,
          material_pool: null,
          mesh_def_slot: toSlot,
          ab5_mesh: toMesh,
          material_handle: record.material_handle,
          material_object_slot: record.material_handle,
          ab3_textures: [...(materialTextures.get(record.material_handle) || [])],
          rule: 'mesh_def_alias_material',
          confidence: 'inferred_mesh_definition_alias',
          structural_context: {
            source: 'native_mesh_definition_alias',
            kind: 'alias_material',
            alias_field_op: op,
            alias_direction: direction,
            source_mesh_def_slot: fromSlot,
            target_mesh_def_slot: toSlot,
            source_ab5_mesh: fromMesh,
            anchor_owner_slot: record.owner_slot,
            anchor_rule: record.rule,
          },
        });
      }
    }
  }
  return aliasRecords;
}

// One shared exact material across a mesh-only selection series — an
// ambiguous series stays unresolved rather than guessing.
export function extractMeshGroupSiblingRecords(
  rows: RegistryRow[], records: AssetRecord[], pool: any[],
  meshSlots: Map<number, number>, materialTextures: Map<number, number[]>,
): AssetRecord[] {
  const resolver = new Resolver(pool, meshSlots);
  const exactMaterialsByMesh = new Map<number, Set<number>>();
  const coveredMeshes = new Set<number>();
  const recordByMeshMaterial = new Map<string, AssetRecord>();
  for (const record of records) {
    coveredMeshes.add(record.ab5_mesh);
    if (DIRECT_EXACT_BINDING_RULES.has(record.rule)) {
      let set = exactMaterialsByMesh.get(record.ab5_mesh);
      if (!set) exactMaterialsByMesh.set(record.ab5_mesh, set = new Set());
      set.add(record.material_handle);
      const key = `${record.ab5_mesh}|${record.material_handle}`;
      if (!recordByMeshMaterial.has(key)) recordByMeshMaterial.set(key, record);
    }
  }

  const siblingRecords: AssetRecord[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (meshSlots.has(row.slot)) continue;
    const decoded = decodeOwnerFields(row, pool, resolver);
    let hasMaterials = false;
    for (const field of decoded.values()) {
      if (field.elements.some(([, elementMaterials]) => elementMaterials.length)) {
        hasMaterials = true;
        break;
      }
    }
    if (hasMaterials) continue;
    for (const operation of [...decoded.keys()].sort((a, b) => a - b)) {
      const field = decoded.get(operation)!;
      if (field.elements.length < 2) continue;
      let memberSlots: number[] = [];
      for (const [elementMeshes, elementMaterials] of field.elements) {
        const slot = oneUnique(elementMeshes);
        if (slot === null || elementMaterials.length) { memberSlots = []; break; }
        memberSlots.push(slot);
      }
      if (new Set(memberSlots).size < 2) continue;
      const memberMeshes = memberSlots.map((slot) => meshSlots.get(slot)!);
      const uncovered = memberMeshes.filter((mesh) => !coveredMeshes.has(mesh));
      if (!uncovered.length) continue;
      const shared = new Set<number>();
      for (const mesh of memberMeshes) {
        for (const material of exactMaterialsByMesh.get(mesh) || []) shared.add(material);
      }
      if (shared.size !== 1) continue;
      const material = shared.values().next().value!;
      const anchorMesh = memberMeshes.find(
        (mesh) => (exactMaterialsByMesh.get(mesh) || new Set()).has(material),
      )!;
      const anchor = recordByMeshMaterial.get(`${anchorMesh}|${material}`)!;
      for (const mesh of orderedUnique(uncovered)) {
        const key = `${mesh}|${material}`;
        if (seen.has(key)) continue;
        seen.add(key);
        siblingRecords.push({
          owner_slot: row.slot,
          owner_selector: row.selector,
          owner_runtime: row.runtime,
          owner_start: row.start,
          mesh_field_op: operation,
          material_field_op: anchor.material_field_op,
          series_index: memberMeshes.indexOf(mesh),
          mesh_pool: field.pool ?? null,
          material_pool: null,
          mesh_def_slot: memberSlots[memberMeshes.indexOf(mesh)],
          ab5_mesh: mesh,
          material_handle: material,
          material_object_slot: material,
          ab3_textures: [...(materialTextures.get(material) || [])],
          rule: 'mesh_group_sibling_material',
          confidence: 'inferred_mesh_group_shared_material',
          structural_context: {
            source: 'native_mesh_selection_series',
            kind: 'sibling_shared_material',
            group_owner_slot: row.slot,
            group_field_op: operation,
            member_count: memberMeshes.length,
            anchor_ab5_mesh: anchorMesh,
            anchor_owner_slot: anchor.owner_slot,
            anchor_rule: anchor.rule,
          },
        });
      }
    }
  }
  return siblingRecords;
}

// ---------------------------------------- indexed visual family inheritance

function unsignedValues(row: RegistryRow): Map<number, number[]> {
  const values = new Map<number, number[]>();
  for (const [op, kind, value] of row.v || []) {
    if (kind === 'U' && isInt(value)) {
      let list = values.get(op);
      if (!list) values.set(op, list = []);
      list.push(value);
    }
  }
  return values;
}

// Material inheritance inside native indexed visual families — binding-only
// records, added after Model grouping.
export function extractIndexedVisualInheritedMaterialRecords(
  rows: RegistryRow[], pool: any[], meshSlots: Map<number, number>,
  materialTextures: Map<number, number[]>,
): [AssetRecord[], Record<string, any>[]] {
  const resolver = new Resolver(pool, meshSlots);

  const exactSeries = (field: DecodedField | undefined, wantMesh: boolean): number[] | null => {
    if (!field || !field.series || field.elements.length < 2) return null;
    const result = [];
    for (const [meshes, materials] of field.elements) {
      let value;
      if (wantMesh) {
        value = oneUnique(meshes);
        if (value === null || materials.length) return null;
      } else {
        value = oneUnique(materials);
        if (value === null || meshes.length) return null;
      }
      result.push(value);
    }
    return result;
  };

  const families: Record<string, any>[] = [];
  const records: AssetRecord[] = [];
  let index = 0;
  while (index < rows.length) {
    const firstRow = rows[index];
    const candidates: [number, number, RegistryRow[]][] = [];
    for (const [indexOperation, values] of unsignedValues(firstRow)) {
      if (!(values.length === 1 && values[0] === 0)) continue;
      const run = [];
      let cursor = index;
      let expected = 0;
      while (cursor < rows.length) {
        const row = rows[cursor];
        const rowValues = unsignedValues(row).get(indexOperation);
        if (row.selector !== firstRow.selector || row.runtime !== firstRow.runtime
            || !(rowValues && rowValues.length === 1 && rowValues[0] === expected)) break;
        run.push(row);
        cursor++;
        expected++;
      }
      if (run.length >= 2) candidates.push([run.length, indexOperation, run]);
    }
    if (!candidates.length) { index++; continue; }
    const longest = Math.max(...candidates.map(([length]) => length));
    const best = candidates.filter(([length]) => length === longest);
    if (best.length !== 1) { index++; continue; }
    const [, indexOperation, run] = best[0];
    index += run.length;

    // This family shape is proven on interned series fields; a bare
    // depth-one array is a different serialization and must not widen the
    // asset-operation closure below.
    const decoded = run.map((row) => {
      const fields = decodeOwnerFields(row, pool, resolver);
      const pooled = new Map<number, DecodedField>();
      for (const [operation, field] of fields) {
        if (field.scope === 'pooled') pooled.set(operation, field);
      }
      return pooled;
    });
    const first = decoded[0];
    const roots: [number, number[], number[], DecodedField, DecodedField][] = [];
    for (const [meshOperation, meshField] of first) {
      const meshDefSlots = exactSeries(meshField, true);
      const materialHandles = exactSeries(first.get(meshOperation + 1), false);
      if (meshDefSlots !== null && materialHandles !== null
          && meshDefSlots.length === materialHandles.length) {
        roots.push([meshOperation, meshDefSlots, materialHandles,
          meshField, first.get(meshOperation + 1)!]);
      }
    }
    if (roots.length !== 1) continue;
    const [meshOperation, rootMeshDefs, materialHandles, rootMeshField, rootMaterialField] = roots[0];

    const assetOperations = (fields: Map<number, DecodedField>): Set<number> => {
      const out = new Set<number>();
      for (const [operation, field] of fields) {
        if (field.elements.some(([meshes, materials]) => meshes.length || materials.length)) {
          out.add(operation);
        }
      }
      return out;
    };
    const firstAssets = assetOperations(first);
    if (!(firstAssets.size === 2 && firstAssets.has(meshOperation) && firstAssets.has(meshOperation + 1))) continue;

    const members = [];
    let valid = true;
    for (let memberIndex = 0; memberIndex < run.length; memberIndex++) {
      const row = run[memberIndex];
      const fields = decoded[memberIndex];
      const memberAssets = assetOperations(fields);
      let meshDefs;
      let meshField;
      if (memberIndex === 0) {
        meshDefs = rootMeshDefs;
        meshField = rootMeshField;
      } else if (!memberAssets.size) {
        continue;
      } else {
        if (!(memberAssets.size === 1 && memberAssets.has(meshOperation))
            || fields.has(meshOperation + 1)) { valid = false; break; }
        meshField = fields.get(meshOperation)!;
        meshDefs = exactSeries(meshField, true);
        if (meshDefs === null || meshDefs.length !== materialHandles.length) { valid = false; break; }
      }
      members.push({
        member_index: memberIndex,
        owner_slot: row.slot,
        mesh_def_slots: meshDefs,
        mesh_pool: meshField.pool,
      });
    }
    if (!valid) continue;

    const compositions = new Map<string, number>();
    for (const member of members) {
      const key = member.mesh_def_slots.join(',');
      compositions.set(key, (compositions.get(key) || 0) + 1);
    }
    if (compositions.size < 2 || [...compositions.values()].some((count) => count < 2)) continue;

    const familyIndex = families.length;
    families.push({
      family_index: familyIndex,
      first_owner_slot: run[0].slot,
      last_owner_slot: run[run.length - 1].slot,
      reader_selector: firstRow.selector,
      reader_runtime: firstRow.runtime,
      index_field_op: indexOperation,
      mesh_field_op: meshOperation,
      material_field_op: meshOperation + 1,
      member_count: run.length,
      root_mesh_def_slots: [...rootMeshDefs],
      root_material_handles: [...materialHandles],
      members: members.map((member) => ({
        member_index: member.member_index,
        owner_slot: member.owner_slot,
        mesh_def_slots: [...member.mesh_def_slots],
        ab5_meshes: member.mesh_def_slots.map((meshDef: number) => meshSlots.get(meshDef)),
      })),
    });

    const rootPairs = new Set(rootMeshDefs.map((meshDef, i) => `${meshDef}|${materialHandles[i]}`));
    const inherited = new Map<string, Record<string, any>>();
    for (const member of members.slice(1)) {
      for (let seriesIndex = 0; seriesIndex < member.mesh_def_slots.length; seriesIndex++) {
        const meshDef = member.mesh_def_slots[seriesIndex];
        const material = materialHandles[seriesIndex];
        if (rootPairs.has(`${meshDef}|${material}`)) continue;
        const key = `${meshDef}|${material}`;
        let evidence = inherited.get(key);
        if (!evidence) {
          inherited.set(key, evidence = {
            meshDef,
            material,
            member_indices: [],
            owner_slots: [],
            series_indices: [],
            mesh_pool: member.mesh_pool,
          });
        }
        evidence.member_indices.push(member.member_index);
        evidence.owner_slots.push(member.owner_slot);
        evidence.series_indices.push(seriesIndex);
      }
    }

    for (const evidence of inherited.values()) {
      const sourceRow = rows[evidence.owner_slots[0]];
      records.push({
        owner_slot: sourceRow.slot,
        owner_selector: sourceRow.selector,
        owner_runtime: sourceRow.runtime,
        owner_start: sourceRow.start,
        mesh_field_op: meshOperation,
        material_field_op: meshOperation + 1,
        series_index: evidence.series_indices[0],
        mesh_pool: evidence.mesh_pool,
        material_pool: rootMaterialField.pool,
        mesh_def_slot: evidence.meshDef,
        ab5_mesh: meshSlots.get(evidence.meshDef)!,
        material_handle: evidence.material,
        material_object_slot: evidence.material,
        ab3_textures: [...(materialTextures.get(evidence.material) || [])],
        rule: 'indexed_visual_inherited_material',
        confidence: 'exact_native_indexed_visual_family_inheritance',
        structural_context: {
          source: 'native_indexed_visual_family',
          kind: 'inherited_material',
          family_index: familyIndex,
          member_indices: evidence.member_indices,
          member_owner_slots: evidence.owner_slots,
          member_series_indices: evidence.series_indices,
          member_count: run.length,
          composition_count: compositions.size,
          reader_selector: firstRow.selector,
          reader_runtime: firstRow.runtime,
          index_field_op: indexOperation,
          root_owner_slot: firstRow.slot,
          root_material_handle: evidence.material,
        },
      });
    }
  }
  return [records, families];
}

// -------------------------------------------- indexed material alternatives

// Explicit `0..k` material arrays from native reader rows.
export function extractIndexedMaterialVariantBatches(rows: RegistryRow[]): MaterialVariantBatch[] {
  const textures = (row: RegistryRow): number[] => {
    const out = new Set<number>();
    for (const [, , tag, value] of row.g || []) {
      if (tag === 0x47 && isInt(value)) out.add(value);
    }
    return [...out];
  };

  const batches: MaterialVariantBatch[] = [];
  let index = 0;
  while (index < rows.length) {
    const first = rows[index];
    if (textures(first).length !== 1) { index++; continue; }
    const candidates: [number, number, RegistryRow[]][] = [];
    for (const [operation, values] of unsignedValues(first)) {
      if (!(values.length === 1 && values[0] === 0)) continue;
      const run = [];
      let cursor = index;
      let expected = 0;
      while (cursor < rows.length) {
        const row = rows[cursor];
        const rowValues = unsignedValues(row).get(operation);
        if (row.selector !== first.selector || row.runtime !== first.runtime
            || textures(row).length !== 1
            || !(rowValues && rowValues.length === 1 && rowValues[0] === expected)) break;
        run.push(row);
        cursor++;
        expected++;
      }
      if (run.length >= 2) candidates.push([run.length, operation, run]);
    }
    if (!candidates.length) { index++; continue; }
    const longest = Math.max(...candidates.map(([length]) => length));
    const best = candidates.filter(([length]) => length === longest);
    if (best.length !== 1) { index++; continue; }
    const [, operation, run] = best[0];
    batches.push({
      batch_index: batches.length,
      reader_selector: first.selector,
      reader_runtime: first.runtime,
      index_field_op: operation,
      first_material_handle: run[0].slot,
      last_material_handle: run[run.length - 1].slot,
      members: run.map((row, memberIndex) => ({
        index: memberIndex,
        material_handle: row.slot,
        ab3_textures: textures(row),
      })),
    });
    index += run.length;
  }
  return batches;
}

// Project explicit material-family members onto exactly bound meshes —
// binding-only, added after grouping. Co-part exclusion: two meshes
// serialized as distinct parts of one exact owner group play different roles
// of one object (the Rot Imp body and its cape/weapon), so a member exactly
// bound to one of them never projects onto the other; members with no exact
// edge anywhere project unrestricted.
export function expandIndexedMaterialVariants(
  records: AssetRecord[], batches: MaterialVariantBatch[],
): AssetRecord[] {
  const batchByMaterial = new Map<number, MaterialVariantBatch>();
  for (const batch of batches) {
    for (const member of batch.members || []) {
      const material = member.material_handle;
      if (!isInt(material) || batchByMaterial.has(material)) {
        throw new Error(`indexed material variant handle is invalid/duplicated: ${material}`);
      }
      batchByMaterial.set(material, batch);
    }
  }

  const exactMeshesByMaterial = new Map<number, Set<number>>();
  for (const record of records) {
    if (DIRECT_EXACT_BINDING_RULES.has(record.rule)) {
      let set = exactMeshesByMaterial.get(record.material_handle);
      if (!set) exactMeshesByMaterial.set(record.material_handle, set = new Set());
      set.add(record.ab5_mesh);
    }
  }

  const groupMeshes = new Map<string, Set<number>>();
  for (const record of records) {
    if (DIRECT_EXACT_BINDING_RULES.has(record.rule)) {
      const key = `${record.owner_slot}|${record.mesh_field_op}|${record.material_field_op}|`
        + `${record.rule}|${record.collection_ordinal ?? 'None'}|${record.entity_variant_index ?? 'None'}`;
      let set = groupMeshes.get(key);
      if (!set) groupMeshes.set(key, set = new Set());
      set.add(record.ab5_mesh);
    }
  }
  const coPartMeshes = new Map<number, Set<number>>();
  for (const meshes of groupMeshes.values()) {
    if (meshes.size < 2) continue;
    for (const mesh of meshes) {
      let set = coPartMeshes.get(mesh);
      if (!set) coPartMeshes.set(mesh, set = new Set());
      for (const other of meshes) if (other !== mesh) set.add(other);
    }
  }

  const memberAllowsMesh = (material: number, mesh: number): boolean => {
    const bound = exactMeshesByMaterial.get(material);
    if (!bound || bound.has(mesh)) return true;
    for (const other of bound) {
      if (coPartMeshes.get(other)?.has(mesh)) return false;
    }
    return true;
  };

  const existing = new Set(records.map(
    (record) => `${record.ab5_mesh}|${record.material_handle}`,
  ));
  const anchors = new Map<string, { mesh: number; batchIndex: number; records: AssetRecord[] }>();
  for (const record of records) {
    if (!DIRECT_EXACT_BINDING_RULES.has(record.rule)) continue;
    const batch = batchByMaterial.get(record.material_handle);
    if (batch === undefined) continue;
    const key = `${record.ab5_mesh}|${batch.batch_index}`;
    let sources = anchors.get(key);
    if (!sources) anchors.set(key, sources = { mesh: record.ab5_mesh, batchIndex: batch.batch_index, records: [] });
    sources.records.push(record);
  }

  const expanded: AssetRecord[] = [];
  for (const { mesh, batchIndex, records: sources } of anchors.values()) {
    const source = sources[0];
    const batch = batches[batchIndex];
    for (const member of batch.members) {
      const material = member.material_handle;
      if (existing.has(`${mesh}|${material}`)) continue;
      if (!memberAllowsMesh(material, mesh)) continue;
      expanded.push({
        owner_slot: source.owner_slot,
        owner_selector: source.owner_selector,
        owner_runtime: source.owner_runtime,
        owner_start: source.owner_start,
        mesh_field_op: source.mesh_field_op,
        material_field_op: source.material_field_op,
        series_index: source.series_index,
        mesh_pool: source.mesh_pool ?? null,
        material_pool: null,
        mesh_def_slot: source.mesh_def_slot,
        ab5_mesh: mesh,
        material_handle: material,
        material_object_slot: material,
        ab3_textures: [...member.ab3_textures],
        rule: 'indexed_material_variant',
        confidence: 'exact_native_indexed_material_family',
        structural_context: {
          source: 'native_indexed_material_family',
          kind: 'material_variant',
          batch_index: batchIndex,
          member_index: member.index,
          member_count: batch.members.length,
          reader_selector: batch.reader_selector,
          reader_runtime: batch.reader_runtime,
          index_field_op: batch.index_field_op,
          anchor_material_handle: source.material_handle,
          anchor_rule: source.rule,
          anchor_owner_slot: source.owner_slot,
          anchor_count: sources.length,
        },
      });
      existing.add(`${mesh}|${material}`);
    }
  }
  return expanded;
}

// --------------------------------------------------------- model grouping

const MODEL_GROUP_FIELDS = [
  'typed_container_class', 'typed_container_depth',
  'typed_collection_scope', 'catalog_index',
  'catalog_index_field_op', 'entity_family_owner_slot',
  'entity_family_field_op', 'entity_family_name',
  'entity_owner_slot', 'entity_visual_field_op',
  'entity_variant_index', 'entity_variant_index_field_op',
  'entity_variant_name', 'entity_predecessor_field_op',
  'entity_predecessor_owner_slot', 'material_inherited',
  'material_source_owner_slot', 'source_name',
  'source_name_provenance',
];
const MODEL_PART_FIELDS = [
  'typed_class', 'typed_schema', 'inline_typed', 'typed_depth',
  'captured_fields', 'typed_container_class',
  'typed_container_depth', 'typed_collection',
  'typed_collection_scope', 'collection_ordinal',
  'catalog_index', 'catalog_index_field_op',
  'nested_typed_ref', 'typed_ref_depth',
  'typed_ref_event_index', 'typed_ref_pool', 'typed_part_pool',
  'recolors', 'recolors_observed', 'recolor_field_ops',
  'recolor_scope', 'recolor_channel_scopes', 'local_matrix_game',
  'entity_attachment', 'material_inherited',
];

// Group flat assignments into ordered owner/field model records.
export function buildModels(records: AssetRecord[]): AssetModel[] {
  const grouped = new Map<string, AssetModel>();
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex];
    const key = `${record.owner_slot}|${record.mesh_field_op}|${record.material_field_op}|`
      + `${record.rule}|${record.collection_ordinal ?? 'None'}`;
    let group = grouped.get(key);
    if (!group) {
      grouped.set(key, group = {
        owner_slot: record.owner_slot,
        owner_selector: record.owner_selector,
        owner_runtime: record.owner_runtime,
        owner_start: record.owner_start,
        mesh_field_op: record.mesh_field_op,
        material_field_op: record.material_field_op,
        rule: record.rule,
        confidence: record.confidence,
        parts: [],
      });
    }
    if ('collection_ordinal' in record) {
      group.collection_ordinal = record.collection_ordinal;
      group.composition_kind = 'typed_component_collection';
    }
    for (const field of MODEL_GROUP_FIELDS) {
      if (field in record) group[field] = record[field];
    }
    const part: Record<string, any> = {
      record_index: recordIndex,
      series_index: record.series_index,
      mesh_def_slot: record.mesh_def_slot,
      ab5_mesh: record.ab5_mesh,
      material_handle: record.material_handle,
      ab3_textures: record.ab3_textures,
    };
    for (const field of MODEL_PART_FIELDS) {
      if (field in record) part[field] = record[field];
    }
    group.parts.push(part);
  }
  const models = [];
  let modelIndex = 0;
  for (const group of grouped.values()) {
    group.model_index = modelIndex++;
    group.parts.sort((a, b) => (a.series_index - b.series_index) || (a.record_index - b.record_index));
    models.push(group);
  }
  return models;
}

// ------------------------------------------------------------ model names

// Depth-zero source strings with reader provenance; with a PoolStrings
// decoder the pool-interned form of the same authored field participates too.
function directSourceStrings(row: { g?: any[] }, strings: PoolStrings | null = null): StringEvent[] {
  if (strings !== null) return strings.directStrings(row);
  const events: StringEvent[] = [];
  const g = row.g || [];
  for (let eventIndex = 0; eventIndex < g.length; eventIndex++) {
    const event = g[eventIndex];
    if (!Array.isArray(event) || event.length !== 4) continue;
    const [fieldOp, depth, tag, value] = event;
    if (depth === 0 && tag === 0x0e && typeof value === 'string') {
      events.push({
        text: value, field_op: fieldOp, depth, relation: 'direct', event_index: eventIndex,
      });
    }
  }
  return events;
}

// Trailing-whitespace strip (incl. FS..US and NEL), then closing punctuation.
const rstripWs = (s: string): string => s.replace(/[\s\x1c-\x1f\x85]+$/u, '');
const withoutClosingPunctuation = (value: string): string => rstripWs(rstripWs(value).replace(/["'’”)\]}]+$/u, ''));

function isLabelString(value: any): boolean {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return false;
  if (value.includes('\n') || value.includes('\r')) return false;
  const trimmed = withoutClosingPunctuation(value);
  return Boolean(trimmed) && !'.?!:;'.includes(trimmed[trimmed.length - 1]);
}

function isSentenceLike(value: any): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (value.length > 64) return true;
  const trimmed = withoutClosingPunctuation(value);
  return Boolean(trimmed) && '.?!'.includes(trimmed[trimmed.length - 1]);
}

// Transfer a definition row's display label onto its mutual model owner:
// reciprocity plus the native room signature (a depth-zero tag-0x13 AB2
// ordinal) keeps one-way room/location labels out. When the definition row
// has no direct label, the one corpus-rare component of its combat template
// is accepted ("fight " + "Helfar's Guards").
function annotateMutualReferenceLabels(
  rows: RegistryRow[], rowsBySlot: Map<number, RegistryRow>, pool: any[],
  strings: PoolStrings | null, eligibleReaders: Map<number, Record<string, any>>,
  nameKinds: Map<number, string>, allModelsByOwner: Map<number, AssetModel[]>,
  labelRowCounts: Map<string, number>,
): void {
  const unnamed = new Set<number>();
  for (const slot of eligibleReaders.keys()) if (!nameKinds.has(slot)) unnamed.add(slot);
  if (!unnamed.size) return;
  const refCache = new Map<number, number[]>();

  const poolRefs = (index: number, active: Set<number> | null = null): number[] => {
    active = active || new Set();
    if (!isInt(index) || index < 0 || index >= pool.length) return [];
    const cached = refCache.get(index);
    if (cached !== undefined) return cached;
    if (active.has(index)) return [];
    active.add(index);
    const out: number[] = [];
    const walk = (node: any) => {
      if (!isNode(node)) return;
      const tag = node.tag;
      const value = node.value;
      if (tag === 0 && isInt(value)) {
        out.push(...poolRefs(value, active));
        return;
      }
      if (tag === 0x26 && isInt(value)) out.push(value);
      if (Array.isArray(node.fields)) for (const child of node.fields) walk(child);
      if (Array.isArray(node.values)) for (const child of node.values) walk(child);
      if (isNode(value)) walk(value);
    };
    walk(pool[index]);
    active.delete(index);
    const result = orderedUnique(out);
    refCache.set(index, result);
    return result;
  };

  const outbound = (row: RegistryRow): Set<number> => {
    const out = new Set<number>();
    for (const [, depth, tag, value] of row.g || []) {
      if (tag === 0x26 && isInt(value)) out.add(value);
      else if (depth === 0 && tag === 0 && isInt(value)) {
        for (const target of poolRefs(value)) out.add(target);
      }
    }
    for (const [, target] of row.r || []) if (isInt(target)) out.add(target);
    for (const [, targets] of row.s || []) {
      for (const target of targets) if (isInt(target)) out.add(target);
    }
    return out;
  };

  const rowTemplateLabels = (row: RegistryRow): string[] => {
    const texts: string[] = [];
    for (const [, , tag, value] of row.g || []) {
      if (tag === 0 && isInt(value)) {
        const parts = strings!.templateStrings(value);
        if (parts) texts.push(...parts);
      }
    }
    return orderedUnique(texts).filter((text) => text.trim() && isLabelString(text)
      && !isSentenceLike(text) && !isTechnicalLabel(text));
  };

  // Corpus-wide usage of every string a row can reach directly: inline
  // events, pool string references at any depth, and composed-template
  // components. Shared verbs/captions ("fight ") are referenced by many rows
  // in one of these forms even when one serialization of a template is rare.
  const usageCounts = new Map<string, number>();
  if (strings !== null) {
    for (const row of rows) {
      const texts = new Set<string>();
      for (const [, , tag, value] of row.g || []) {
        if (tag === 0x0e && typeof value === 'string') texts.add(value);
        else if (tag === 0 && isInt(value)) {
          const direct = strings.poolString(value);
          if (direct !== null) texts.add(direct);
          else {
            const parts = strings.templateStrings(value);
            if (parts) for (const part of parts) texts.add(part);
          }
        }
      }
      for (const text of texts) usageCounts.set(text, (usageCounts.get(text) || 0) + 1);
    }
  }

  const candidates = new Map<number, [string, number, StringEvent][]>();
  for (const row of rows) {
    const events = directSourceStrings(row, strings).filter((event) => event.text.trim()
      && isLabelString(event.text) && !isSentenceLike(event.text)
      && !isTechnicalLabel(event.text));
    const distinct = orderedUnique(events.map((event) => event.text));
    let event: StringEvent | null = null;
    let label: string | null = null;
    if (distinct.length === 1 && (labelRowCounts.get(distinct[0]) || 0) <= 8) {
      label = distinct[0];
      event = events.find((e) => e.text === label)!;
    } else if (!distinct.length && strings !== null) {
      // A name recurs on its owner's few quest/encounter rows (tens at
      // most); the template verbs are shared by every combat row (hundreds).
      const rare = rowTemplateLabels(row).filter((text) => (usageCounts.get(text) || 0) <= 32);
      if (rare.length === 1) {
        label = rare[0];
        event = {
          text: label, field_op: null, relation: 'template_string', event_index: null,
        };
      }
    }
    if (event === null) continue;
    let isRoomRow = false;
    for (const [, depth, tag] of row.g || []) {
      if (depth === 0 && tag === 0x13) { isRoomRow = true; break; }
    }
    if (isRoomRow) continue;
    const hits = [];
    for (const target of outbound(row)) if (unnamed.has(target)) hits.push(target);
    if (!hits.length) continue;
    for (const ownerSlot of hits) {
      let list = candidates.get(ownerSlot);
      if (!list) candidates.set(ownerSlot, list = []);
      list.push([label!, row.slot, event]);
    }
  }

  for (const ownerSlot of [...candidates.keys()].sort((a, b) => a - b)) {
    const options = candidates.get(ownerSlot)!;
    const ownerRow = rowsBySlot.get(ownerSlot);
    if (ownerRow === undefined) continue;
    const ownerRefs = outbound(ownerRow);
    const reciprocal = options.filter(([, refSlot]) => ownerRefs.has(refSlot));
    const labels = orderedUnique(reciprocal.map(([label]) => label));
    if (labels.length !== 1) continue;
    const [label, refSlot, event] = reciprocal.find(([l]) => l === labels[0])!;
    const provenance = {
      kind: 'mutual_reference_label',
      definition_slot: refSlot,
      field_op: event.field_op,
      relation: event.relation,
      definition_rows: orderedUnique(reciprocal.map(([, slot]) => slot)).sort((a, b) => a - b),
    };
    for (const model of allModelsByOwner.get(ownerSlot)!) {
      // Record-level names (entity variants) always outrank annotation.
      if (model.source_name) continue;
      model.source_name = label;
      model.source_name_provenance = { ...provenance };
    }
    nameKinds.set(ownerSlot, provenance.kind);
  }
}

export interface ModelNameCounts {
  model_owners_with_source_strings: number;
  named_model_owners: number;
  direct_named_model_owners: number;
  owner_label_named_model_owners: number;
  mutual_reference_named_model_owners: number;
  one_hop_named_model_owners: number;
  described_model_owners: number;
}

// Conservative source labels/descriptions for complete model owners, in
// policy order: pool-aware complete reader label families, corroborated
// owner labels, mutual definition-row references, then the one-hop technical
// fallback. Record-level names are never overwritten.
export function annotateModelNames(
  rows: RegistryRow[], models: AssetModel[], strings: PoolStrings | null = null,
  pool: any[] | null = null,
): ModelNameCounts {
  const rowsBySlot = new Map<number, RegistryRow>();
  for (const row of rows) if (row && isInt(row.slot)) rowsBySlot.set(row.slot, row);
  const allModelsByOwner = new Map<number, AssetModel[]>();
  const eligibleOwnersByReader = new Map<string, Set<number>>();
  const eligibleReaders = new Map<number, Record<string, any>>(); // owner -> {selector, runtime}
  for (const model of models) {
    const ownerSlot = model.owner_slot;
    if (!isInt(ownerSlot)) continue;
    let list = allModelsByOwner.get(ownerSlot);
    if (!list) allModelsByOwner.set(ownerSlot, list = []);
    list.push(model);
    if (NAMEABLE_MODEL_RULES.has(model.rule) && Array.isArray(model.parts) && model.parts.length >= 2) {
      const readerKey = `${model.owner_selector}\u0000${model.owner_runtime}`;
      let owners = eligibleOwnersByReader.get(readerKey);
      if (!owners) eligibleOwnersByReader.set(readerKey, owners = new Set());
      owners.add(ownerSlot);
      eligibleReaders.set(ownerSlot, { selector: model.owner_selector, runtime: model.owner_runtime });
    }
  }

  const directStringsByOwner = new Map<number, StringEvent[]>();
  for (const ownerSlot of eligibleReaders.keys()) {
    const directStrings = directSourceStrings(rowsBySlot.get(ownerSlot) || { g: [] }, strings);
    directStringsByOwner.set(ownerSlot, directStrings);
    if (directStrings.length) {
      for (const model of allModelsByOwner.get(ownerSlot)!) {
        model.source_strings = directStrings.map((event) => ({ ...event }));
      }
    }
  }

  const directCandidates = new Map<number, [StringEvent, number | null, string, number][]>();
  for (const [readerKey, owners] of eligibleOwnersByReader) {
    if (owners.size < 2) continue;
    const stringsByField = new Map<number | null, Map<number, StringEvent[]>>();
    for (const ownerSlot of owners) {
      for (const event of directStringsByOwner.get(ownerSlot) || []) {
        let byOwner = stringsByField.get(event.field_op);
        if (!byOwner) stringsByField.set(event.field_op, byOwner = new Map());
        let events = byOwner.get(ownerSlot);
        if (!events) byOwner.set(ownerSlot, events = []);
        events.push(event);
      }
    }
    for (const [fieldOp, ownerEvents] of stringsByField) {
      if (ownerEvents.size !== owners.size) continue;
      let complete = true;
      for (const events of ownerEvents.values()) {
        if (events.length !== 1 || !isLabelString(events[0].text)) { complete = false; break; }
      }
      if (!complete) continue;
      for (const [ownerSlot, events] of ownerEvents) {
        let list = directCandidates.get(ownerSlot);
        if (!list) directCandidates.set(ownerSlot, list = []);
        list.push([events[0], fieldOp, readerKey, owners.size]);
      }
    }
  }

  const nameKinds = new Map<number, string>();
  const describedOwners = new Set<number>();
  for (const [ownerSlot, reader] of eligibleReaders) {
    const candidates = directCandidates.get(ownerSlot) || [];
    if (candidates.length === 1) {
      const [event, fieldOp, , familyOwners] = candidates[0];
      const provenance = {
        kind: 'direct_family_string',
        field_op: fieldOp,
        depth: 0,
        reader_selector: reader.selector,
        reader_runtime: reader.runtime,
        family_owners: familyOwners,
      };
      for (const model of allModelsByOwner.get(ownerSlot)!) {
        if (model.source_name) continue;
        model.source_name = event.text;
        model.source_name_provenance = { ...provenance };
      }
      nameKinds.set(ownerSlot, provenance.kind);
    }

    const descriptions = (directStringsByOwner.get(ownerSlot) || [])
      .filter((event) => isSentenceLike(event.text));
    if (descriptions.length) {
      const primary = descriptions[0];
      const provenance = {
        kind: 'direct_source_string',
        field_op: primary.field_op,
        depth: primary.depth,
        event_index: primary.event_index,
      };
      const aliases = [];
      const seenTexts = new Set([primary.text]);
      for (const event of descriptions.slice(1)) {
        if (!seenTexts.has(event.text)) {
          aliases.push(event.text);
          seenTexts.add(event.text);
        }
      }
      for (const model of allModelsByOwner.get(ownerSlot)!) {
        model.source_description = primary.text;
        model.source_description_provenance = { ...provenance };
        if (aliases.length) model.source_description_aliases = [...aliases];
      }
      describedOwners.add(ownerSlot);
    }
  }

  // Corpus-wide direct-string usage: a display name is quasi-unique to its
  // object; a shared interaction verb or ui caption is neither.
  const labelRowCounts = new Map<string, number>();
  const unnamedOwners = [];
  for (const ownerSlot of eligibleReaders.keys()) {
    if (!nameKinds.has(ownerSlot)) unnamedOwners.push(ownerSlot);
  }
  if (unnamedOwners.length) {
    for (const row of rows) {
      const texts = new Set<string>();
      for (const event of directSourceStrings(row, strings)) texts.add(event.text);
      for (const text of texts) labelRowCounts.set(text, (labelRowCounts.get(text) || 0) + 1);
    }
  }

  for (const ownerSlot of unnamedOwners) {
    const labels = (directStringsByOwner.get(ownerSlot) || []).filter(
      (event) => event.text.trim() && isLabelString(event.text) && !isSentenceLike(event.text),
    );
    const distinct = orderedUnique(labels.map((event) => event.text));
    const nonTechnical = distinct.filter((text) => !isTechnicalLabel(text));
    let picked;
    if (nonTechnical.length === 1) picked = nonTechnical[0];
    else if (distinct.length === 1) picked = distinct[0];
    else continue;
    const pickedOps = orderedUnique(
      labels.filter((event) => event.text === picked).map((event) => event.field_op as number),
    ).sort((a, b) => a - b);
    // A display name is corroborated by repeated serialization on its own
    // row and is quasi-unique to its object; a shared caption is neither.
    if (pickedOps.length < 2 || (labelRowCounts.get(picked) || 0) > 8) continue;
    const event = labels.find((e) => e.text === picked)!;
    const provenance = {
      kind: 'owner_label_string',
      field_op: event.field_op,
      field_ops: pickedOps,
      depth: 0,
      relation: event.relation,
      event_index: event.event_index,
      distinct_labels: distinct.length,
    };
    for (const model of allModelsByOwner.get(ownerSlot)!) {
      if (model.source_name) continue;
      model.source_name = picked;
      model.source_name_provenance = { ...provenance };
    }
    nameKinds.set(ownerSlot, provenance.kind);
  }

  if (pool !== null) {
    annotateMutualReferenceLabels(
      rows, rowsBySlot, pool, strings, eligibleReaders, nameKinds,
      allModelsByOwner, labelRowCounts,
    );
  }

  for (const ownerSlot of eligibleReaders.keys()) {
    if (nameKinds.has(ownerSlot)) continue;
    const row: { s?: any[] } = rowsBySlot.get(ownerSlot) || { s: [] };
    const candidates = new Map<string, [number, number, StringEvent]>();
    for (const edge of row.s || []) {
      if (!Array.isArray(edge) || edge.length !== 2) continue;
      const [edgeFieldOp, childSlots] = edge;
      if (!Array.isArray(childSlots) || childSlots.length !== 1) continue;
      const childSlot = childSlots[0];
      if (!isInt(childSlot) || childSlot === ownerSlot) continue;
      const childStrings = directSourceStrings(rowsBySlot.get(childSlot) || { g: [] }, strings);
      if (childStrings.length !== 1) continue;
      const childString = childStrings[0];
      if (!isTechnicalLabel(childString.text)) continue;
      const key = `${childString.text}\u0000${edgeFieldOp}\u0000${childSlot}\u0000${childString.field_op}`;
      candidates.set(key, [edgeFieldOp, childSlot, childString]);
    }
    if (candidates.size !== 1) continue;
    const [edgeFieldOp, childSlot, childString] = candidates.values().next().value!;
    const provenance = {
      kind: 'one_hop_technical_string',
      edge_kind: 'bare_series',
      edge_field_op: edgeFieldOp,
      child_slot: childSlot,
      child_string_field_op: childString.field_op,
      depth: 0,
    };
    for (const model of allModelsByOwner.get(ownerSlot)!) {
      if (model.source_name) continue;
      model.source_name = childString.text;
      model.source_name_provenance = { ...provenance };
    }
    nameKinds.set(ownerSlot, provenance.kind);
  }

  let withStrings = 0;
  for (const events of directStringsByOwner.values()) if (events.length) withStrings++;
  let direct = 0;
  let ownerLabel = 0;
  let mutual = 0;
  let oneHop = 0;
  for (const kind of nameKinds.values()) {
    if (kind === 'direct_family_string') direct++;
    else if (kind === 'owner_label_string') ownerLabel++;
    else if (kind === 'mutual_reference_label') mutual++;
    else if (kind === 'one_hop_technical_string') oneHop++;
  }
  return {
    model_owners_with_source_strings: withStrings,
    named_model_owners: nameKinds.size,
    direct_named_model_owners: direct,
    owner_label_named_model_owners: ownerLabel,
    mutual_reference_named_model_owners: mutual,
    one_hop_named_model_owners: oneHop,
    described_model_owners: describedOwners.size,
  };
}

// ------------------------------------------------------- enemy base names

export interface EnemyBaseName {
  name: string;
  plural: string;
  def_slot: number;
  tier_slot: number;
}

// One roaming-enemy definition row (exactly one singular+plural display pair
// — "Street Hag"/"Street Hags"), with its referenced rows pre-resolved:
// `targets` is every registry row the definition references (typed 0x26 +
// pooled + direct + series, first-occurrence order) and `targetTargets[i]`
// is the identical projection of `targets[i]`. extractEnemyBaseNames and
// extractEnemyRosters previously EACH ran this exact full-registry scan
// (same predicate, same reference projection, verbatim-identical code);
// computing it once and handing it to both halves that pass without
// reordering a single loop.
export interface EnemyDefinition {
  slot: number;
  name: string;                  // singular
  plural: string;
  targets: number[];
  targetTargets: number[][];
}

// The shared definition scan. `shared` optionally supplies the memoized
// PoolStrings / pool-ref walk (both pure of (pool, charset)); absent, local
// instances are built exactly as the per-function copies used to.
export function scanEnemyDefinitions(
  rows: RegistryRow[], pool: any[], charsetGlyphs: ArrayLike<string>,
  shared: {
    strings?: PoolStrings | null;
    poolRegistryRefs?: ((index: number) => number[]) | null;
  } = {},
): EnemyDefinition[] {
  const strings = shared.strings ?? new PoolStrings(pool, charsetGlyphs);
  const poolRegistryRefs = shared.poolRegistryRefs ?? makePoolRegistryRefs(pool);
  const targetsOf = (slot: number): number[] => {
    const row = rows[slot];
    const out = new Set<number>();
    for (const [, , tag, value] of row.g) {
      if (tag === 0x26 && isInt(value)) out.add(value);
      else if (tag === 0 && isInt(value) && value >= 0 && value < pool.length) {
        for (const target of poolRegistryRefs(value)) out.add(target);
      }
    }
    for (const [, target] of row.r || []) if (isInt(target)) out.add(target);
    for (const [, targets] of row.s || []) {
      for (const target of targets || []) if (isInt(target)) out.add(target);
    }
    return [...out].filter((target) => target >= 0 && target < rows.length);
  };

  const defs: EnemyDefinition[] = [];
  for (const row of rows) {
    // exactly one singular+plural label pair on the definition row
    const labels: string[] = [];
    for (const [, , tag, value] of row.g) {
      if (tag === 0x0e && typeof value === 'string') labels.push(value);
      else if (tag === 0 && isInt(value)) {
        const text = strings.poolString(value);
        if (text !== null) labels.push(text);
      }
    }
    const distinct = orderedUnique(labels).filter(
      (text) => text.trim() && isLabelString(text) && !isSentenceLike(text) && !isTechnicalLabel(text),
    );
    if (distinct.length !== 2) continue;
    let singular: string | null = null;
    let plural: string | null = null;
    for (const [a, b] of [[distinct[0], distinct[1]], [distinct[1], distinct[0]]]) {
      if (b === `${a}s` || b === `${a}es`) { singular = a; plural = b; break; }
    }
    if (singular === null) continue;
    const targets = targetsOf(row.slot);
    defs.push({
      slot: row.slot,
      name: singular,
      plural: plural!,
      targets,
      targetTargets: targets.map((target) => targetsOf(target)),
    });
  }
  return defs;
}

// The roaming-enemy catalog: definition rows carrying exactly one
// singular+plural display pair ("Street Hag"/"Street Hags" — 133 in the
// current build) reference small per-tier rows, each of which references the
// tier's visual/style owner. The tier rows carry only the QUALIFIER label
// ("Powerful"), which the mutual-reference naming tier would otherwise
// transfer onto the card; the definition row carries the family BASE name.
// -> Map<visual owner slot, base name>, dropping any owner reached by two
// different bases. Structural throughout: no selector or class ids.
// `defs` optionally supplies the shared scanEnemyDefinitions result.
export function extractEnemyBaseNames(
  rows: RegistryRow[], pool: any[], charsetGlyphs: ArrayLike<string>,
  defs: EnemyDefinition[] | null = null,
): Map<number, EnemyBaseName> {
  const scanned = defs ?? scanEnemyDefinitions(rows, pool, charsetGlyphs);
  const byOwner = new Map<number, EnemyBaseName>();
  const collided = new Set<number>();
  for (const def of scanned) {
    // definition -> small tier rows -> the tier's visual owner. The roster
    // rows a definition also references fan out into hundreds of shared
    // controllers; the tier bound keeps the projection tight.
    for (let index = 0; index < def.targets.length; index++) {
      const tier = def.targets[index];
      const owners = def.targetTargets[index];
      if (owners.length > 16) continue;
      for (const owner of owners) {
        if (collided.has(owner)) continue;
        const existing = byOwner.get(owner);
        if (existing !== undefined && existing.name !== def.name) {
          byOwner.delete(owner);
          collided.add(owner);
          continue;
        }
        if (existing === undefined) {
          byOwner.set(owner, {
            name: def.name, plural: def.plural, def_slot: def.slot, tier_slot: tier,
          });
        }
      }
    }
  }
  return byOwner;
}

// One roaming-enemy roster: a per-room row (referenced by an enemy
// definition, carrying exactly one depth-0 tag-0x13 room link) that lists the
// room's enemy placements as INLINE typed float markers. The 6-float class
// carries authored TILE positions ([x, y, radius?, 1, 1, count] — 188/188
// in-bounds across the corpus); the short 2–4-float classes are not
// positional (0/89 in-bounds raw) and only contribute a count hint.
export interface EnemyRosterEntry {
  room: number;
  def_slot: number;
  roster_slot: number;
  name: string;
  plural: string;
  owners: number[];               // tier visual owners, definition order
  positions: { x: number; y: number; count: number; raw: number[] }[];
  marker_count: number;           // every float marker (count fallback hint)
}

// Roaming-enemy rosters per room. Same definition predicate as
// extractEnemyBaseNames (both consume the shared scanEnemyDefinitions scan);
// placement markers are read with the inline-marker treatment (the same
// serialization that hid Thruntyx's location). `defs` optionally supplies
// the precomputed scan.
export function extractEnemyRosters(
  rows: RegistryRow[], pool: any[], charsetGlyphs: ArrayLike<string>,
  defs: EnemyDefinition[] | null = null,
): EnemyRosterEntry[] {
  const scanned = defs ?? scanEnemyDefinitions(rows, pool, charsetGlyphs);
  const derefPool = (index: number): any => {
    let node = pool[index];
    const seen = new Set<number>();
    while (isNode(node) && node.tag === 0 && isInt(node.value) && !seen.has(node.value)) {
      seen.add(node.value);
      node = pool[node.value];
    }
    return node;
  };

  const rosters: EnemyRosterEntry[] = [];
  const seenRosters = new Set<string>();
  for (const def of scanned) {
    // tier visual owners in definition order (small tier rows only)
    const owners: number[] = [];
    for (let index = 0; index < def.targets.length; index++) {
      const tierTargets = def.targetTargets[index];
      if (tierTargets.length > 16) continue;
      for (const owner of tierTargets) if (!owners.includes(owner)) owners.push(owner);
    }
    for (const rosterSlot of def.targets) {
      const links = orderedUnique(rows[rosterSlot].g
        .filter((event: any) => event[1] === 0 && event[2] === 0x13)
        .map((event: any) => event[3]));
      if (links.length !== 1 || !isInt(links[0])) continue;
      const key = `${rosterSlot} ${def.slot}`;
      if (seenRosters.has(key)) continue;
      seenRosters.add(key);
      // inline typed float markers on the roster row
      const byOperation = new Map<number, any[]>();
      for (const event of rows[rosterSlot].g) {
        const list = byOperation.get(event[0]);
        if (list) list.push(event); else byOperation.set(event[0], [event]);
      }
      const positions: EnemyRosterEntry['positions'] = [];
      let markerCount = 0;
      for (const [, events] of byOperation) {
        for (let position = 0; position < events.length; position++) {
          const [, depth, tag] = events[position];
          if (tag !== 0x24) continue;
          let boundary = -1;
          for (let previous = position - 1; previous >= 0; previous--) {
            if (events[previous][1] <= depth) { boundary = previous; break; }
          }
          const floats: number[] = [];
          let clean = true;
          for (let k = boundary + 1; k < position; k++) {
            if (events[k][1] !== depth + 1) continue;
            if (events[k][2] !== 0 || !isInt(events[k][3])) { clean = false; break; }
            const node = derefPool(events[k][3]);
            if (isNode(node) && node.tag === 0x0b
                && Array.isArray(node.value) && node.value.length === 1) {
              floats.push(node.value[0]);
            } else { clean = false; break; }
          }
          if (!clean || floats.length < 2) continue;
          markerCount++;
          if (floats.length >= 5) {
            // One marker = one spawn anchor at (f1, f2). The trailing floats
            // are retained as undecoded provenance: they are NOT a count
            // (early guess, retracted) — their shape is consistent with
            // further waypoint pairs, unproven.
            positions.push({ x: floats[0], y: floats[1], count: 1, raw: floats });
          }
        }
      }
      rosters.push({
        room: links[0],
        def_slot: def.slot,
        roster_slot: rosterSlot,
        name: def.name,
        plural: def.plural,
        owners,
        positions,
        marker_count: markerCount,
      });
    }
  }
  return rosters;
}

// One style/visual owner's appearance parts for roster spawn synthesis: the
// unique (mesh series, later material series) pair with no asset field
// between (pooled or bare humanoid slot arrays), plus the two-tint actor
// recolors — the same rules the actor rows use.
export function ownerAppearanceParts(
  rows: RegistryRow[], pool: any[], ownerSlot: number,
  meshSlots: Map<number, number>, materialTextures: Map<number, number[]>,
): Record<string, any>[] {
  if (!isInt(ownerSlot) || ownerSlot < 0 || ownerSlot >= rows.length) return [];
  const resolver = new Resolver(pool, meshSlots);
  const row = rows[ownerSlot];
  const decoded = decodeOwnerFields(row, pool, resolver);
  const meshFields: [number, DecodedField, number[]][] = [];
  const materialFields: [number, DecodedField, number[]][] = [];
  const assetOps: number[] = [];
  for (const [op, field] of decoded) {
    let meshes: number[] | null = field.elements.length ? [] : null;
    let materials: number[] | null = field.elements.length ? [] : null;
    let hasAssets = false;
    for (const [elementMeshes, elementMaterials] of field.elements) {
      if (elementMeshes.length || elementMaterials.length) hasAssets = true;
      if (meshes !== null) {
        const slot = oneUnique(elementMeshes);
        meshes = slot !== null && !elementMaterials.length ? [...meshes, slot] : null;
      }
      if (materials !== null) {
        const handle = oneUnique(elementMaterials);
        materials = handle !== null && !elementMeshes.length
          && (materialTextures.get(handle) || []).length === 1
          ? [...materials, handle] : null;
      }
    }
    if (hasAssets) assetOps.push(op);
    if (meshes !== null && meshes.length) meshFields.push([op, field, meshes]);
    if (materials !== null && materials.length) materialFields.push([op, field, materials]);
  }
  const candidates: [number, number, number[], number[]][] = [];
  for (const [meshOp, , meshes] of meshFields) {
    for (const [materialOp, , materials] of materialFields) {
      if (!(meshOp < materialOp) || meshes.length !== materials.length) continue;
      let blocked = false;
      for (const op of assetOps) if (op > meshOp && op < materialOp) { blocked = true; break; }
      if (!blocked) candidates.push([meshOp, materialOp, meshes, materials]);
    }
  }
  if (candidates.length !== 1) return [];
  const [meshOp, materialOp, meshes, materials] = candidates[0];
  const recolors = parallelRecolors(decoded, resolver, materialOp, meshes.length, row);
  return meshes.map((meshSlot, index) => ({
    mesh_def_slot: meshSlot,
    mesh: meshSlots.get(meshSlot)!,
    material_slot: materials[index],
    texture: (materialTextures.get(materials[index]) || [])[0],
    part_index: index,
    mesh_field_op: meshOp,
    material_field_op: materialOp,
    recolors: recolors === null ? null : recolors.values[index].map((color) => [...color]),
    recolor_field_ops: recolors === null ? [-1, -1] : recolors.field_ops,
    recolor_scope: recolors === null ? null : recolors.scope,
  }));
}

// ------------------------------------------------------------ orchestrator

const EXACT_RULES = new Set([
  'adjacent_scalar', 'parallel_series', 'typed_meshmat',
  'typed_component_collection', 'nested_typed_ref', 'entity_variant',
  'indexed_visual_inherited_material', 'indexed_material_variant',
  'positional_block_face', 'occurrence_terrain_face',
  'occurrence_terrain_custom_mesh', 'occurrence_terrain_model_part',
  'actor_appearance',
]);

export interface ExtractAssetModelsOptions {
  onProgress?: ((done: number, total: number) => void) | null;
  charsetGlyphs?: ArrayLike<string> | null;
  // Room-spawn actor registry slots (spawns.js): enables the scoped
  // actor_appearance record rule for rows no other rule reaches.
  actorSlots?: Set<number> | null;
  // Precomputed shared derivations (the world orchestrator computes each
  // ONCE and threads it through every consumer). All are pure functions of
  // the same rows/pool/charset passed here and are never mutated after
  // construction; absent, they are derived locally exactly as before.
  assetMaps?: { meshSlots: Map<number, number>; textureSlots: Map<number, number[]> } | null;
  materialAssets?: { handles: Set<number>; materialTextures: Map<number, number[]> } | null;
  strings?: PoolStrings | null;
}

export interface AssetModelsResult {
  records: AssetRecord[];
  models: AssetModel[];
  counts: Record<string, any>;
  meshSlots: Map<number, number>;
  materialTextures: Map<number, number[]>;
  materialHandles: Set<number>;
  entityVariantRecords: AssetRecord[];
  entityAttachmentRecords: AssetRecord[];
  indexedVisualRecords: AssetRecord[];
  indexedVisualFamilies: Record<string, any>[];
  indexedMaterialBatches: MaterialVariantBatch[];
  indexedMeshDefinitionBatches: MeshDefinitionBatch[];
  indexedMaterialVariantRecords: AssetRecord[];
  meshDefAliasRecords: AssetRecord[];
  meshGroupSiblingRecords: AssetRecord[];
  nameCounts: ModelNameCounts;
}

// Full recovery in fixed stage order, minus the AB2 structural stage:
// structural records from graph.js are appended to `records` by the caller
// before catalog packaging; counts are recomputed there. `charsetGlyphs` is
// dt.charset — without it pool-interned strings stay undecoded and naming
// falls back to inline strings only.
export function extractAssetModels(
  rows: RegistryRow[], pool: any[],
  {
    onProgress, charsetGlyphs = null, actorSlots = null,
    assetMaps = null, materialAssets = null, strings: sharedStrings = null,
  }: ExtractAssetModelsOptions = {},
): AssetModelsResult {
  const { meshSlots, textureSlots } = assetMaps ?? traceAssetMaps(rows);
  const { handles: materialHandles, materialTextures } = materialAssets
    ?? materialMap(pool, new Resolver(pool, meshSlots), textureSlots);
  // Indexed-family members are registry rows that no pool value needs to
  // reference; their texture containers come straight from the per-row
  // tag-0x47 map.
  const materialLookup = new Map(textureSlots);
  for (const [handle, textures] of materialTextures) materialLookup.set(handle, textures);
  const strings = sharedStrings ?? (charsetGlyphs ? new PoolStrings(pool, charsetGlyphs) : null);
  const indexedMaterialBatches = extractIndexedMaterialVariantBatches(rows);
  const indexedMeshDefinitionBatches = extractIndexedMeshDefinitionBatches(rows);
  const records = extractRecords(rows, pool, meshSlots, materialTextures, onProgress, actorSlots);
  const entityVariantRecords = extractEntityVariantRecords(
    rows, pool, meshSlots, materialLookup, strings, indexedMaterialBatches,
  );
  records.push(...entityVariantRecords);
  const entityAttachmentRecords = extractEntityFamilyAttachmentRecords(
    records, rows, meshSlots, materialLookup, indexedMeshDefinitionBatches,
  );
  records.push(...entityAttachmentRecords);
  // Model grouping and source naming operate only on generic owner-local
  // model rules; the later stages are exact texture bindings, not Models.
  const models = buildModels(records);
  const nameCounts = annotateModelNames(rows, models, strings, pool);
  const [indexedVisualRecords, indexedVisualFamilies] = extractIndexedVisualInheritedMaterialRecords(
    rows, pool, meshSlots, materialTextures,
  );
  records.push(...indexedVisualRecords);
  const indexedMaterialVariantRecords = expandIndexedMaterialVariants(records, indexedMaterialBatches);
  records.push(...indexedMaterialVariantRecords);
  const meshDefAliasRecords = extractMeshDefAliasRecords(
    rows, records, pool, meshSlots, materialLookup,
  );
  records.push(...meshDefAliasRecords);
  const meshGroupSiblingRecords = extractMeshGroupSiblingRecords(
    rows, records, pool, meshSlots, materialLookup,
  );
  records.push(...meshGroupSiblingRecords);

  const ruleCounts = new Map<string, number>();
  let exactRecords = 0;
  const owners = new Set<number>();
  const meshDefs = new Set<number>();
  const ab5Meshes = new Set<number>();
  const materials = new Set<number>();
  for (const record of records) {
    ruleCounts.set(record.rule, (ruleCounts.get(record.rule) || 0) + 1);
    if (EXACT_RULES.has(record.rule)) exactRecords++;
    owners.add(record.owner_slot);
    meshDefs.add(record.mesh_def_slot);
    ab5Meshes.add(record.ab5_mesh);
    materials.add(record.material_handle);
  }
  let withTexture = 0;
  for (const textures of materialTextures.values()) if (textures.length) withTexture++;
  const counts = {
    registry_rows: rows.length,
    mesh_definition_slots: meshSlots.size,
    material_handles: materialHandles.size,
    material_handles_with_texture: withTexture,
    material_handles_without_texture: materialHandles.size - withTexture,
    records: records.length,
    exact_records: exactRecords,
    inferred_records: records.length - exactRecords,
    models: models.length,
    entity_variant_records: entityVariantRecords.length,
    entity_variant_families: new Set(entityVariantRecords.map((r) => r.entity_family_owner_slot)).size,
    entity_variant_named_families: new Set(
      entityVariantRecords.filter((r) => r.entity_family_name)
        .map((r) => r.entity_family_owner_slot),
    ).size,
    entity_family_attachment_records: entityAttachmentRecords.length,
    indexed_mesh_definition_batches: indexedMeshDefinitionBatches.length,
    mesh_def_alias_records: meshDefAliasRecords.length,
    mesh_group_sibling_records: meshGroupSiblingRecords.length,
    indexed_visual_inherited_material_families: indexedVisualFamilies.length,
    indexed_visual_inherited_material_records: indexedVisualRecords.length,
    indexed_material_variant_batches: indexedMaterialBatches.length,
    indexed_material_variant_anchored_batches: new Set(
      indexedMaterialVariantRecords.map((r) => r.structural_context.batch_index),
    ).size,
    indexed_material_variant_records: indexedMaterialVariantRecords.length,
    multipart_models: models.filter((model) => model.parts.length > 1).length,
    owners: owners.size,
    mesh_definition_coverage: meshDefs.size,
    ab5_mesh_coverage: ab5Meshes.size,
    material_coverage: materials.size,
    rule_counts: Object.fromEntries([...ruleCounts.entries()].sort(
      (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )),
    ...nameCounts,
  };
  return {
    records,
    models,
    counts,
    meshSlots,
    materialTextures,
    materialHandles,
    entityVariantRecords,
    entityAttachmentRecords,
    indexedVisualRecords,
    indexedVisualFamilies,
    indexedMaterialBatches,
    indexedMeshDefinitionBatches,
    indexedMaterialVariantRecords,
    meshDefAliasRecords,
    meshGroupSiblingRecords,
    nameCounts,
  };
}
