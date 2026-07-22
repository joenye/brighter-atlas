// ab2 ROOM object decoder: container grammar, occupancy stack, class-351
// items, individuals + anchors, door records, room-name derivation.
//
// Inputs: decoded ab2 object bytes (bundles.js decodeObject(2, raw)); class
// record arities come from the per-build decode data (class_fields),
// applied via configureFields. Room names need the
// decompressed ab0 bytes + the charset glyphs from datatable.js
// parseDatatable, plus (for the name-hash-gated rooms) the shipped
// defaults/room_name_overrides.json and per-room content hashes the caller
// computes (sha256 hex[:16] of the decoded object bytes).
//
// Worker-safe: no DOM, no Node APIs.

import { readVarint } from '../bundles.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

// tag -> fixed payload size
const FIXED_SIZE = new Uint8Array(0x40);
for (const [tag, size] of [
  [0x0a, 4], [0x0b, 4], [0x18, 8], [0x1f, 8], [0x28, 8], [0x2e, 8],
  [0x22, 12], [0x2f, 12], [0x15, 16], [0x2a, 16], [0x39, 16], [0x3c, 16],
  [0x25, 24], [0x30, 48],
] as [number, number][]) FIXED_SIZE[tag] = size;
const VARINT_TAGS = new Set([0x00, 0x0f, 0x20, 0x24, 0x26, 0x2c]);
const MARKER_TAGS = new Set([0x0c, 0x0d, 0x48]); // annotations in the room grammar

// Per-class direct generic-value call counts, loaded from the world decode
// profile. Empty until configureFields is called.
const FIELDS = new Map<number, number>();

// source: the world profile object ({ class_fields }), a { fields } wrapper,
// or a plain {classId: count} mapping.
export function configureFields(source: any): Map<number, number> {
  const mapping = source.class_fields ?? source.fields ?? source;
  const parsed: [number, number][] = [];
  for (const [key, value] of Object.entries(mapping)) {
    const k = Number(key), v = Number(value);
    if (!Number.isInteger(k) || !Number.isInteger(v) || v < 0 || v > 64) {
      throw new Error('room schema needs non-negative field counts');
    }
    parsed.push([k, v]);
  }
  if (!parsed.length) throw new Error('room schema needs non-negative field counts');
  FIELDS.clear();
  for (const [k, v] of parsed) FIELDS.set(k, v);
  return FIELDS;
}

const hex = (u8: Uint8Array, off: number, n: number) =>
  Array.from(u8.subarray(off, off + n), (b) => b.toString(16).padStart(2, '0')).join('');

// Flat (tag, value) token list; exact byte consumption or throws. Values:
// 0x0a signed i32, floats BE (0x3c LE), 8/16-byte blobs as lowercase hex
// strings, strings utf-8 (hex on decode failure).
function tokenize(u8: Uint8Array): { nTable: number; tokens: [number, any][] } {
  const len = u8.length;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 0;
  const varint = (): number => {
    if (off >= len) throw new Error('ab2: varint overruns object');
    let r: number;
    [r, off] = readVarint(u8, off);
    if (off > len) throw new Error('ab2: varint overruns object');
    return r;
  };
  const nTable = varint();
  const tokens: [number, any][] = [];
  while (off < len) {
    const tag = u8[off++];
    if (VARINT_TAGS.has(tag)) { tokens.push([tag, varint()]); continue; }
    if (tag === 0x0c || tag === 0x0d) { tokens.push([tag, null]); continue; }
    if (tag === 0x0e) {
      const n = varint();
      if (off + n > len) throw new Error('ab2: string overruns object');
      let text;
      try { text = UTF8.decode(u8.subarray(off, off + n)); }
      catch { text = hex(u8, off, n); }
      off += n;
      tokens.push([tag, text]);
      continue;
    }
    if (tag === 0x48) {
      const nPages = varint();
      const pages: [number, number][] = [];
      for (let k = 0; k < nPages; k++) pages.push([varint(), varint()]);
      const nSprites = varint();
      const sprites: [number, number][] = [];
      for (let k = 0; k < nSprites; k++) sprites.push([varint(), varint()]);
      const placements: [number, number, number][] = [];
      for (let k = 0; k < nSprites; k++) placements.push([varint(), varint(), varint()]);
      tokens.push([tag, { pages, sprites, placements }]);
      continue;
    }
    const size = tag < FIXED_SIZE.length ? FIXED_SIZE[tag] : 0;
    if (!size) throw new Error(`ab2: unknown tag 0x${tag.toString(16)} at ${off - 1}`);
    if (off + size > len) throw new Error('ab2: fixed payload overruns object');
    let value;
    if (tag === 0x0b) value = dv.getFloat32(off, false);
    else if (tag === 0x0a) value = dv.getInt32(off, false);
    else if (tag === 0x15 || tag === 0x18 || tag === 0x22 || tag === 0x25 || tag === 0x30) {
      value = [];
      for (let k = 0; k < size; k += 4) value.push(dv.getFloat32(off + k, false));
    } else if (tag === 0x3c) {
      value = [];
      for (let k = 0; k < 16; k += 4) value.push(dv.getFloat32(off + k, true));
    } else if (tag === 0x2e || tag === 0x2f || tag === 0x39) {
      value = [];
      for (let k = 0; k < size; k += 4) value.push(dv.getUint32(off + k, false));
    } else value = hex(u8, off, size); // 0x1f / 0x28 / 0x2a
    off += size;
    tokens.push([tag, value]);
  }
  return { nTable, tokens };
}

export interface RoomNode {
  kind: 'marker' | 'ref' | 'array' | 'pairs' | 'group' | 'lit';
  tag: number | null;
  value: any;
  cls: number | null;
  elems: RoomNode[] | null;
  index: number | null;
}

const node = (
  kind: RoomNode['kind'],
  tag: number | null = null,
  value: any = null,
  cls: number | null = null,
  elems: RoomNode[] | null = null,
): RoomNode => ({ kind, tag, value, cls, elems, index: null });

// Drop annotation values, flatten tag-0x2c pair containers.
function semanticChildren(nodes: (RoomNode | null)[]): RoomNode[] {
  const result: RoomNode[] = [];
  for (const n of nodes) {
    if (n === null || n.kind === 'marker') continue;
    if (n.kind === 'pairs') result.push(...semanticChildren(n.elems!));
    else result.push(n);
  }
  return result;
}

export interface ParsedRoom {
  nTable: number;
  top: RoomNode[];
  table: RoomNode[];
}

// -> { nTable, top, table }. table[k] resolves 0x00-k refs.
export function parse(u8: Uint8Array): ParsedRoom {
  const { nTable, tokens } = tokenize(u8);
  let pos = 0;
  const value = (): RoomNode => {
    if (pos >= tokens.length) throw new Error('truncated AB2 counted container');
    const [t, v] = tokens[pos++];
    if (MARKER_TAGS.has(t)) return node('marker', t, v);
    if (t === 0x00) return node('ref', t, v);
    if (t === 0x20) {
      const raw = [];
      for (let k = 0; k < v; k++) raw.push(value());
      return node('array', t, v, null, semanticChildren(raw));
    }
    if (t === 0x2c) {
      const raw = [];
      for (let k = 0; k < 2 * v; k++) raw.push(value());
      return node('pairs', t, v, null, semanticChildren(raw));
    }
    if (t === 0x24) {
      if (!FIELDS.has(v)) throw new Error(`class ${v} is absent from the loaded schema`);
      const raw = [];
      for (let k = 0, n = FIELDS.get(v)!; k < n; k++) raw.push(value());
      return node('group', t, null, v, semanticChildren(raw));
    }
    return node('lit', t, v);
  };
  const top: RoomNode[] = [];
  while (pos < tokens.length) {
    const n = value();
    if (n && n.kind !== 'marker') top.push(n);
  }
  const table = top.slice(0, nTable);
  if (table.length !== nTable) {
    throw new Error(`AB2 table truncated: header=${nTable}, top-level=${top.length}`);
  }
  if (table.some((n) => n.kind === 'ref')) throw new Error('AB2 table contains a forward/root reference');
  table.forEach((n, k) => { n.index = k; });
  return { nTable, top, table };
}

export function* walk(n: RoomNode): Generator<RoomNode> {
  yield n;
  for (const e of n.elems ?? []) yield* walk(e);
}

// Same pre-order traversal as walk() without generator overhead (hot: every
// room object is fully traversed several times). fn returning true stops.
function visit(n: RoomNode, fn: (node: RoomNode) => boolean): boolean {
  if (fn(n)) return true;
  const elems = n.elems;
  if (elems) for (const e of elems) if (visit(e, fn)) return true;
  return false;
}

// Resolve one room-local table reference, leaving literals inline.
export function deref(n: RoomNode, table: RoomNode[]): RoomNode {
  if (n.kind === 'ref' && n.value >= 0 && n.value < table.length) return table[n.value];
  return n;
}

export function signed32(value: any): any {
  if (typeof value === 'number' && value >= 2 ** 31) return value - 2 ** 32;
  return value;
}

export function groupFields(n: RoomNode, table: RoomNode[]): RoomNode[] | null {
  n = deref(n, table);
  if (n.kind !== 'group') return null;
  return n.elems!.map((field) => deref(field, table));
}

// Four signed int32 values form a relative cell link.
export function isLinkGroup(n: RoomNode, table: RoomNode[]): boolean {
  const fields = groupFields(n, table);
  return !!(fields && fields.length === 4
    && fields.slice(0, 3).every((f) => f.kind === 'lit' && f.tag === 0x0a)
    && fields[3].kind === 'lit' && (fields[3].tag === 0x0a || fields[3].tag === 0x0f));
}

// Six-field room placement, recognized by value shape (class ids move between builds).
export function isPlacementGroup(n: RoomNode, table: RoomNode[]): boolean {
  const fields = groupFields(n, table);
  if (fields === null || fields.length !== 6) return false;
  return !!(fields[0].kind === 'lit' && fields[0].tag === 0x26
    && fields[1].kind === 'lit' && (fields[1].tag === 0x0f || fields[1].tag === 0x26)
    && fields[2].kind === 'lit' && fields[2].tag === 0x0a
    && (isLinkGroup(fields[3], table) || (fields[3].kind === 'lit' && fields[3].tag === 0x0f))
    && fields[4].kind === 'array'
    && fields[5].kind === 'lit' && fields[5].tag === 0x0a);
}

// Indexed class-189 individual row: UUID16 then four arrays (regions instead
// own a string/polygon/vec2/array: the structural distinction matters).
export function isIndividualGroup(n: RoomNode, table: RoomNode[]): boolean {
  const fields = groupFields(n, table);
  return !!(fields && fields.length === 5
    && fields[0].kind === 'lit' && fields[0].tag === 0x2a
    && fields.slice(1).every((f) => f.kind === 'array'));
}

// (slot, placement) pairs from either cell-container grammar (variable array
// now, fixed two-field group with 0x0f sentinels on the June 2026 depot).
function cellItems(entry: RoomNode, table: RoomNode[]): [number, RoomNode][] {
  const container = deref(entry, table);
  if (container.kind !== 'array' && container.kind !== 'group') return [];
  const out: [number, RoomNode][] = [];
  container.elems!.forEach((item, slot) => {
    const typed = deref(item, table);
    if (isPlacementGroup(typed, table)) out.push([slot, typed]);
  });
  return out;
}

export interface MinimapRecord {
  node: RoomNode;
  fields: RoomNode[];
  innerRect: number[];
  outerRect: number[];
  grid: RoomNode;
}

// Structurally identified room minimap record (two 0x39 rects + a matching
// grid). Memoized per parsed room (keyed by the top array identity): the
// rooms loop and roomLayers both derive it from the same parse.
const MINIMAP_CACHE = new WeakMap<RoomNode[], MinimapRecord | null>();
export function minimapRecord(top: RoomNode[], table: RoomNode[]): MinimapRecord | null {
  const cached = MINIMAP_CACHE.get(top);
  if (cached !== undefined) return cached;
  let found: MinimapRecord | null = null;
  for (const n of top) {
    visit(n, (group) => {
      const fields = groupFields(group, table);
      if (!fields) return false;
      const rects = fields.filter((f) => f.kind === 'lit' && f.tag === 0x39);
      const arrays = fields.filter((f) => f.kind === 'array');
      if (rects.length !== 2 || !arrays.length) return false;
      const outer = rects[1].value.map(signed32);
      const width = outer[2] - outer[0], height = outer[3] - outer[1];
      const grid = arrays.find((a) => width > 0 && height > 0 && a.elems!.length === width * height);
      if (!grid) return false;
      found = {
        node: group,
        fields,
        innerRect: rects[0].value.map(signed32),
        outerRect: outer,
        grid,
      };
      return true;
    });
    if (found) break;
  }
  MINIMAP_CACHE.set(top, found);
  return found;
}

interface RoomLike {
  table: RoomNode[];
  top: RoomNode[];
  w: number;
  h: number;
}

// Structural evidence for one ambiguous occupancy-grid shape: class-351 links
// resolved locally, then anchor-distance score, then per-cell vertical
// coherence for rooms without either.
function stackDimensionScore(top: RoomNode[], table: RoomNode[], width: number, height: number): number[] {
  let occurrences, individuals;
  try {
    ({ occurrences, individuals } = roomOccupancy({ table, top, w: width, h: height }));
  } catch {
    return [-1, -Infinity, -Infinity];
  }
  const slots = new Set(occurrences.map((h) => `${h.cell[0]},${h.cell[1]},${h.cell[2]},${h.entrySlot}`));
  let resolved = 0;
  for (const h of occurrences) {
    const [x, y, z] = h.cell;
    const links = h.childLinks.slice();
    if (h.parentLink !== null) links.push(h.parentLink);
    for (const [dx, dy, dz, targetSlot] of links) {
      if (slots.has(`${x + dx},${y + dy},${z + dz},${targetSlot}`)) resolved++;
    }
  }

  const coherence = verticalCoherence(top, width, width * height);
  const anchors = roomIndividualAnchors({ table }, individuals);
  const hitsByIndividual = new Map<number, RoomOccurrence[]>();
  for (const h of occurrences) {
    if (Number.isInteger(h.individual) && (h.individual as number) >= 0) {
      if (!hitsByIndividual.has(h.individual!)) hitsByIndividual.set(h.individual!, []);
      hitsByIndividual.get(h.individual!)!.push(h);
    }
  }
  const distances: number[] = [];
  anchors.forEach((regions, index) => {
    const hits = hitsByIndividual.get(index);
    if (!regions.length || !hits) return;
    for (const h of hits) {
      const [x, y] = h.cell;
      let best = Infinity;
      for (const region of regions) {
        const [cx, cy] = region.center;
        const d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5;
        if (d < best) best = d;
      }
      distances.push(best);
    }
  });
  const anchorScore = distances.length
    ? -distances.reduce((a, b) => a + b, 0) / distances.length : -Infinity;
  return [resolved, anchorScore, coherence];
}

// Rate of same-value vertical-neighbour pairs across the room's per-cell
// arrays: every array whose length is a multiple of cellCount is treated as
// layer-major planes of the candidate grid; within each plane, count cells
// equal to the cell `width` positions later (their vertical neighbour). The
// true width keeps authored spatial coherence; a sheared one turns vertical
// neighbours into noise (Vacant Pier: 12x15 vs 10x18 with only same-row
// links and no anchors). Returned as agreements/pairs: a narrower width
// yields more pairs per plane, so raw counts would bias toward it. Refs key
// by their table index: no deref, so distinct rows never alias (group rows
// all carry value=null and would falsely compare equal after dereferencing).
function verticalCoherence(top: RoomNode[], width: number, cellCount: number): number {
  const cellKey = (entry: RoomNode) => {
    const value = entry.value;
    const scalar = (value === null || value === undefined
      || typeof value === 'number' || typeof value === 'string') ? value : JSON.stringify(value);
    return `${entry.kind}|${entry.tag}|${scalar}`;
  };
  let total = 0, pairs = 0;
  for (const node of top) {
    if (node.kind !== 'array') continue;
    const n = node.elems!.length;
    if (n < cellCount || n % cellCount !== 0) continue;
    const values = node.elems!.map(cellKey);
    for (let plane = 0; plane < n / cellCount; plane++) {
      const base = plane * cellCount;
      for (let i = base; i < base + cellCount - width; i++) {
        total += values[i] === values[i + width] ? 1 : 0;
        pairs++;
      }
    }
  }
  return pairs ? total / pairs : -Infinity;
}

// Resolve occupancy dimensions against the authoritative minimap dimensions.
// Axis order is not evidence: ambiguous factorings are scored structurally.
export function stackDimensions(top: RoomNode[], gridWidth: number, gridHeight: number): number[] | null {
  const arrays = top.filter((n) => n.kind === 'array' && n.elems!.length >= 8);
  const byLength = new Map<number, number>(); // insertion order = first-occurrence order
  for (const a of arrays) byLength.set(a.elems!.length, (byLength.get(a.elems!.length) ?? 0) + 1);
  const table = () => top.filter((n) => n.index !== null).sort((a, b) => a.index! - b.index!);
  const pickScored = <T>(rows: [T, number[]][]): T => { // rows: [shapeOrRow, [resolved, anchorScore, coherence]]
    let best = rows[0];
    for (const row of rows.slice(1)) {
      const [sr, sa, sc] = row[1], [br, ba, bc] = best[1];
      if (sr > br || (sr === br && (sa > ba || (sa === ba && sc > bc)))) best = row;
    }
    return best[0];
  };

  const candidates = [...byLength.keys()]
    .filter((length) => byLength.get(2 * length))
    .map((length): [number, number] => [byLength.get(length)! >= 2 ? 1 : 0, length])
    .sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]))
    .map(([, length]) => length);
  for (const length of candidates) {
    if (length === gridWidth * gridHeight) return [gridWidth, gridHeight, length];
    let shapes: [number, number][] = [];
    if (length % gridWidth === 0 && length / gridWidth <= gridHeight) {
      shapes.push([gridWidth, length / gridWidth]);
    }
    if (length % gridHeight === 0 && length / gridHeight <= gridWidth) {
      shapes.push([length / gridHeight, gridHeight]);
    }
    shapes = [...new Map(shapes.map((s): [string, [number, number]] => [`${s[0]}x${s[1]}`, s])).values()];
    if (shapes.length === 1) return [...shapes[0], length];
    if (shapes.length > 1) {
      const t = table();
      const shape = pickScored(shapes.map((s): [[number, number], number[]] =>
        [s, stackDimensionScore(top, t, s[0], s[1])]));
      return [...shape, length];
    }
  }
  const largest = Math.max(0, ...arrays.map((a) => a.elems!.length));
  let fallbacks: number[][] = [];
  for (let height = gridHeight; height > 0; height--) {
    const length = gridWidth * height;
    if (largest && largest % length === 0 && largest / length >= 3 && largest / length <= 64) {
      fallbacks.push([gridWidth, height, length]);
    }
  }
  for (let width = gridWidth; width > 0; width--) {
    const length = width * gridHeight;
    if (largest && largest % length === 0 && largest / length >= 3 && largest / length <= 64) {
      fallbacks.push([width, gridHeight, length]);
    }
  }
  fallbacks = [...new Map(fallbacks.map((r): [string, number[]] => [r.join('x'), r])).values()];
  if (!fallbacks.length) return null;
  const length = fallbacks[0][2];
  const sameLength = fallbacks.filter((r) => r[2] === length);
  if (sameLength.length === 1) return sameLength[0];
  const t = table();
  return pickScored(sameLength.map((r): [number[], number[]] =>
    [r, stackDimensionScore(top, t, r[0], r[1])]));
}

// The room's layer-major K*L class-351 occupancy array, selected by the number
// of class-351 items reached through its per-cell lists (length is ambiguous).
export function occupancyStack(room: RoomLike): RoomNode | null {
  const { table, top } = room;
  const L = room.w * room.h;
  let selected: [number, number, RoomNode] | null = null;
  for (const n of top) {
    if (n.kind !== 'array' || n.elems!.length < L || n.elems!.length % L !== 0) continue;
    let hits = 0;
    for (const entry of n.elems!) hits += cellItems(entry, table).length;
    if (!hits) continue;
    if (!selected || hits > selected[0] || (hits === selected[0] && n.elems!.length > selected[1])) {
      selected = [hits, n.elems!.length, n];
    }
  }
  return selected ? selected[2] : null;
}

export interface RoomIndividual {
  index: number;
  uuid: string | null;
  node: RoomNode;
}

// The room's class-189 individual table (placement field 5 indexes this column).
export function roomIndividuals(room: { table: RoomNode[]; top: RoomNode[] }, expectedCount: number): RoomIndividual[] {
  if (expectedCount === 0) return [];
  const { table } = room;
  const records: RoomNode[] = [];
  const seen = new Set<RoomNode>();
  for (const n of room.top) {
    visit(n, (child) => {
      const record = deref(child, table);
      if (isIndividualGroup(record, table) && !seen.has(record)) {
        seen.add(record);
        records.push(record);
      }
      return false;
    });
  }
  if (records.length < expectedCount) {
    throw new Error(`found ${records.length} individual records for ${expectedCount} indices`);
  }
  // Placement indices address this source-order column; extras stay unindexed.
  return records.slice(0, expectedCount).map((record, index) => {
    const first = record.elems!.length ? deref(record.elems![0], table) : null;
    const raw = first && first.kind === 'lit' && first.tag === 0x2a ? first.value : null;
    const uuid = raw && /^[0-9a-f]{32}$/.test(raw)
      ? `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
      : null;
    return { index, uuid, node: record };
  });
}

export interface IndividualAnchor {
  center: number[];
  polygon: number[][];
}

// class-447/448 polygons + explicit room-space centers, parallel to individuals.
export function roomIndividualAnchors(room: { table: RoomNode[] }, individuals: RoomIndividual[]): IndividualAnchor[][] {
  const { table } = room;
  const result: IndividualAnchor[][] = [];
  for (const individual of individuals) {
    const n = individual.node;
    const anchors: IndividualAnchor[] = [];
    const regions = n.elems!.length > 1 ? deref(n.elems![1], table) : null;
    if (regions === null || regions.kind !== 'array') { result.push(anchors); continue; }
    for (const child of regions.elems!) {
      const regionFields = groupFields(deref(child, table), table);
      if (regionFields === null || regionFields.length !== 5) continue;
      const polygonNode = regionFields[2];
      const centerNode = regionFields[3];
      if (polygonNode.kind !== 'array' || centerNode.kind !== 'lit' || centerNode.tag !== 0x18
        || !Array.isArray(centerNode.value) || centerNode.value.length !== 2) continue;
      let polygon: number[][] = [];
      for (const pointNode of polygonNode.elems!) {
        const pointFields = groupFields(deref(pointNode, table), table);
        if (pointFields === null || pointFields.length < 2) { polygon = []; break; }
        const xy = pointFields.slice(0, 2);
        if (xy.some((v) => v.kind !== 'lit' || v.tag !== 0x0b)) { polygon = []; break; }
        polygon.push([xy[0].value, xy[1].value]);
      }
      if (polygon.length) {
        anchors.push({ center: centerNode.value.slice(), polygon });
      }
    }
    result.push(anchors);
  }
  return result;
}

// Structural signed (dx, dy, dz, target-entry-slot) link, or null.
function cellLink(n: RoomNode, table: RoomNode[]): number[] | null {
  n = deref(n, table);
  if (!isLinkGroup(n, table)) return null;
  const values: number[] = [];
  for (let field of n.elems!) {
    field = deref(field, table);
    if (field.kind !== 'lit' || (field.tag !== 0x0a && field.tag !== 0x0f)) return null;
    values.push(signed32(field.value));
  }
  return values;
}

export interface RoomOccurrence {
  record: number;
  resource: number;
  secondary: number | null;
  cell: number[];
  tile: number;
  entrySlot: number;
  overlay: boolean;
  packed: number | null;
  rotationQuarters: number | null;
  packedFlags: number | null;
  individual: number | null;
  individualUuid: string | null;
  parentLink: number[] | null;
  childLinks: number[][];
  fields: RoomNode[];
  node: RoomNode;
}

// Every class-351 cell occurrence, identity preserved: the lossless placement
// primitive. -> { layers: K, ground, occurrences, individuals }.
export function roomOccupancy(room: RoomLike): {
  layers: number; ground: number[]; occurrences: RoomOccurrence[]; individuals: RoomIndividual[];
} {
  const { table, w, h } = room;
  const L = w * h;
  const stack = occupancyStack(room);
  if (stack === null) return { layers: 0, ground: new Array(L).fill(0), occurrences: [], individuals: [] };

  const K = Math.floor(stack.elems!.length / L);
  const ground: number[] = new Array(L).fill(0);
  const occurrences: RoomOccurrence[] = [];
  const inlineKeys = new Map<RoomNode, number>();
  stack.elems!.forEach((entry, linear) => {
    const tile = linear % L, layer = Math.floor(linear / L);
    const x = tile % w, y = Math.floor(tile / w);
    for (const [entrySlot, typed] of cellItems(entry, table)) {
      const fields = typed.elems!.map((f) => deref(f, table));
      const resource = fields[0];
      if (resource.kind !== 'lit' || resource.tag !== 0x26) continue;
      const overlay = fields.length > 1 && fields[1].kind === 'lit' && fields[1].tag === 0x26;
      const secondary = overlay ? fields[1].value : null;
      if (overlay && layer > ground[tile]) ground[tile] = layer;

      let record;
      if (typed.index !== null) record = typed.index;
      else {
        if (!inlineKeys.has(typed)) inlineKeys.set(typed, inlineKeys.size);
        record = -(inlineKeys.get(typed)! + 1);
      }

      let packed = null;
      if (fields.length > 2 && fields[2].kind === 'lit' && fields[2].tag === 0x0a) {
        packed = signed32(fields[2].value);
      }
      let individual = null;
      if (fields.length > 5 && fields[5].kind === 'lit' && fields[5].tag === 0x0a) {
        individual = signed32(fields[5].value);
      }
      const parentLink = fields.length > 3 ? cellLink(fields[3], table) : null;
      const childLinks: number[][] = [];
      if (fields.length > 4 && fields[4].kind === 'array') {
        for (const child of fields[4].elems!) {
          const link = cellLink(child, table);
          if (link !== null) childLinks.push(link);
        }
      }
      occurrences.push({
        record,
        resource: resource.value,
        secondary,
        cell: [x, y, layer],
        tile,
        entrySlot,
        overlay,
        packed,
        rotationQuarters: packed !== null ? packed & 3 : null,
        packedFlags: packed !== null ? packed & ~3 : null,
        individual,
        individualUuid: null,
        parentLink,
        childLinks,
        fields,
        node: typed,
      });
    }
  });
  let expected = 0;
  for (const h2 of occurrences) {
    if (Number.isInteger(h2.individual) && h2.individual! >= 0 && h2.individual! + 1 > expected) {
      expected = h2.individual! + 1;
    }
  }
  const individuals = roomIndividuals(room, expected);
  for (const h2 of occurrences) {
    const index = h2.individual;
    if (Number.isInteger(index) && index! >= 0 && index! < individuals.length) {
      h2.individualUuid = individuals[index!].uuid;
    }
  }
  return { layers: K, ground, occurrences, individuals };
}

const asParsed = (source: Uint8Array | ParsedRoom): ParsedRoom =>
  (source instanceof Uint8Array ? parse(source) : source);

// A room carries two rectangles and a matching authored colour grid.
export function isRoom(source: Uint8Array | ParsedRoom): boolean {
  let parsed;
  try { parsed = asParsed(source); } catch { return false; }
  return minimapRecord(parsed.top, parsed.table) !== null;
}

export interface RoomLayers {
  idx: number;
  w: number;
  h: number;
  mapW: number;
  mapH: number;
  words: any[];
  blocks: number[] | null;
  materials: RoomNode[] | null;
  table: RoomNode[];
  top: RoomNode[];
}

// Decode one room object -> per-tile layers dict, or null if not a room.
// source: decoded ab2 object bytes (or a prior parse() result to reuse).
export function roomLayers(source: Uint8Array | ParsedRoom, idx: number): RoomLayers | null {
  let parsed;
  try { parsed = asParsed(source); } catch { return null; }
  const { top, table } = parsed;
  const record = minimapRecord(top, table);
  if (record === null) return null;
  const [x0, y0, x1, y1] = record.innerRect;
  const gridWidth = x1 - x0, gridHeight = y1 - y0;
  if (gridWidth <= 0 || gridHeight <= 0) return null;
  const arrs = top.filter((n) => n.kind === 'array' && n.elems!.length >= 8);
  const dimensions = stackDimensions(top, gridWidth, gridHeight);
  if (dimensions === null) return null;
  const [w, h, L] = dimensions;
  let words = null, blocks = null;
  for (const a of arrs) {
    if (a.elems!.length !== L) continue;
    const vals = a.elems!.map((e) => deref(e, table));
    const tags = new Map<number | null, number>();
    for (const v of vals) if (v.kind === 'lit') tags.set(v.tag, (tags.get(v.tag) ?? 0) + 1);
    if ((tags.get(0x0a) ?? 0) > L * 0.9) words = vals.map((v) => v.value);
    else if ((tags.get(0x1f) ?? 0) > L * 0.9 && blocks === null) {
      blocks = vals.map((v) => (typeof v.value === 'string' ? parseInt(v.value, 16) : 0));
    }
  }
  if (words === null) return null;
  const matArr = arrs.find((a) => a.elems!.length === 2 * L);
  const materials = matArr ? matArr.elems!.map((e) => deref(e, table)) : null;
  return { idx, w, h, mapW: gridWidth, mapH: gridHeight, words, blocks, materials, table, top };
}

// ------------------------------------------------------------------ door records

export interface RoomExit {
  x: number;
  y: number;
  z: number;
  type: number | null;
  code: number;
  dest: [number, number];
}

// All class-391/392 exit records, matched by their stable value shape (owns a
// world vec3 0x2f AND a destination tile vec2 0x2e).
// -> [{ x, y, z, type, code, dest: [ex, ey] }]; exits without a room-number
// code are dropped, exits without a direction (type null) are ferry teleports.
export function roomExits(source: Uint8Array | ParsedRoom): RoomExit[] {
  let parsed;
  try { parsed = asParsed(source); } catch { return []; }
  const { top, table } = parsed;
  const out: RoomExit[] = [];
  const seen = new Set<RoomNode>();
  for (const n of top) {
    visit(n, (g) => {
      if (g.kind !== 'group' || seen.has(g)) return false;
      // cheap tag scan first: the per-group field array only materializes
      // for the rare groups that actually carry both marker tags
      let has2f = false, has2e = false;
      for (const e of g.elems!) {
        const x = deref(e, table);
        if (x.kind === 'lit') {
          if (x.tag === 0x2f) has2f = true;
          else if (x.tag === 0x2e) has2e = true;
        }
      }
      if (!has2f || !has2e) return false;
      seen.add(g);
      const f = g.elems!.map((e) => deref(e, table));
      const xyz = f.find((x) => x.kind === 'lit' && x.tag === 0x2f)?.value ?? null;
      const dest = f.find((x) => x.kind === 'lit' && x.tag === 0x2e)?.value ?? null;
      const type = f.find((x) => x.kind === 'lit' && x.tag === 0x26)?.value ?? null;
      if (xyz === null || dest === null) return false;
      let code = null;
      for (let k = 0; k < f.length; k++) {
        if (f[k].kind === 'lit' && f[k].tag === 0x2e) {
          for (let back = k - 1; back >= 0; back--) {
            if (f[back].kind === 'lit' && f[back].tag === 0x0a) { code = f[back].value; break; }
          }
          break;
        }
      }
      if (code !== null) out.push({ x: xyz[0], y: xyz[1], z: xyz[2], type, code, dest: [dest[0], dest[1]] });
      return false;
    });
  }
  return out;
}

// ------------------------------------------------------------------ room names

// Safe LSB-first varint that refuses to run off the end.
function rdvSafe(u8: Uint8Array, off: number): [number, number] | null {
  let value = 0, shift = 0;
  for (;;) {
    if (off >= u8.length) return null;
    const b = u8[off++];
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b & 0x80)) return [value, off];
  }
}

function encVarint(v: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b7 = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) out.push(b7 | 0x80);
    else { out.push(b7); return out; }
  }
}

function findBytes(data: Uint8Array, needle: number[], from: number): number {
  const n = data.length - needle.length;
  // indexOf (native memchr) jumps between first-byte hits instead of a manual
  // byte-at-a-time outer loop; candidates are visited in the same ascending
  // order, so the returned offset is identical.
  for (let i = data.indexOf(needle[0], from); i >= 0 && i <= n; i = data.indexOf(needle[0], i + 1)) {
    let hit = true;
    for (let k = 1; k < needle.length; k++) if (data[i + k] !== needle[k]) { hit = false; break; }
    if (hit) return i;
  }
  return -1;
}

// True if the 0x13 tag at `p` is a room self-instance reference:
// `{0f <class> | 00 <owner>} [0c|0d]* 0x13 <idx>`: an owner varint (a 0x0f
// class field or a 0x00 back-ref) ending exactly at the marker/tag boundary,
// which rejects the 0x13 bytes that occur inside floats. Build-agnostic: the
// current build writes `0f <class> 0d 13 <idx>`, older builds the marker-less
// `00 <owner> 13 <idx>` (with no 513 self-instance class at all).
function ownerAnchored(data: Uint8Array, p: number): boolean {
  let j = p;
  while (j - 1 >= 0 && (data[j - 1] === 0x0c || data[j - 1] === 0x0d)) j--;
  for (let length = 1; length <= 3; length++) {
    const t = j - 1 - length;
    if (t < 0) continue;
    if (data[t] === 0x0f || data[t] === 0x00) {
      const r = rdvSafe(data, t + 1);
      if (r !== null && r[1] === j) return true;
    }
  }
  return false;
}

// Every room's self-instance anchor in the ab0 heap definition stream:
// `0x0f 513 [0c|0d]* 0x13 <ab2-room-index>` (interior rooms: a UNIQUE
// `0x0d 0x13 <idx>`; older builds: a UNIQUE owner-anchored `0x13 <idx>`, see
// ownerAnchored). -> { anchors: Map(room -> 0x13 offset), allPos: sorted [] }.
export function roomSelfAnchors(data: Uint8Array, rooms: Set<number>): {
  anchors: Map<number, number>; allPos: number[];
} {
  const anchors = new Map<number, number>();
  const allPos: number[] = [];
  const n = data.length;
  const sig = [0x0f, 0x81, 0x04]; // 0x0f (field) + varint 513
  let pos = 0;
  for (;;) {
    pos = findBytes(data, sig, pos);
    if (pos === -1) break;
    let j = pos + 3;
    while (j < pos + 7 && j < n && (data[j] === 0x0c || data[j] === 0x0d)) j++;
    if (j < n && data[j] === 0x13) {
      const r = rdvSafe(data, j + 1);
      if (r !== null) {
        allPos.push(j);
        if (rooms.has(r[0]) && !anchors.has(r[0])) anchors.set(r[0], j);
      }
    }
    pos += 1;
  }
  let missing = [...rooms].filter((idx) => !anchors.has(idx)).sort((a, b) => a - b);
  if (missing.length) {
    // One indexed pass instead of a full-file scan per missing room: a varint's
    // (value, byte length) pair identifies its bytes, so bucketing every
    // `0x0d 0x13 <varint>` site equals a per-needle scan exactly.
    const hitsBy = new Map<string, number[]>(); // `${value}:${len}` -> [offset of the 0x13]
    // indexOf jump scan: same ascending hit order as the byte loop it replaces
    for (let i = data.indexOf(0x0d, 0); i >= 0 && i + 1 < n; i = data.indexOf(0x0d, i + 1)) {
      if (data[i + 1] !== 0x13) continue;
      const r = rdvSafe(data, i + 2);
      if (r === null) continue;
      const key = `${r[0]}:${r[1] - (i + 2)}`;
      if (!hitsBy.has(key)) hitsBy.set(key, []);
      hitsBy.get(key)!.push(i + 1);
    }
    for (const idx of missing) {
      const hits = hitsBy.get(`${idx}:${encVarint(idx).length}`) ?? [];
      if (hits.length === 1) { anchors.set(idx, hits[0]); allPos.push(hits[0]); }
    }
  }
  // Generalized owner-anchor (build-agnostic): pre-513 builds emit neither the
  // 513 class nor the marker before 0x13, so both strategies above miss every
  // room. For each still-unmatched room take a UNIQUE owner-anchored 0x13 <idx>.
  // Additive by construction: a build the strategies above fully cover reaches
  // here with nothing to do, so its anchors (and derived names) are identical.
  missing = [...rooms].filter((idx) => !anchors.has(idx)).sort((a, b) => a - b);
  if (missing.length) {
    const hitsBy = new Map<string, number[]>(); // `${value}:${len}` -> [offset of the 0x13]
    // indexOf jump scan: same ascending hit order as the byte loop it replaces
    for (let i = data.indexOf(0x13, 0); i >= 0; i = data.indexOf(0x13, i + 1)) {
      const r = rdvSafe(data, i + 1);
      if (r === null || !ownerAnchored(data, i)) continue;
      const key = `${r[0]}:${r[1] - (i + 1)}`;
      if (!hitsBy.has(key)) hitsBy.set(key, []);
      hitsBy.get(key)!.push(i);
    }
    for (const idx of missing) {
      const hits = hitsBy.get(`${idx}:${encVarint(idx).length}`) ?? [];
      if (hits.length === 1) { anchors.set(idx, hits[0]); allPos.push(hits[0]); }
    }
  }
  allPos.sort((a, b) => a - b);
  return { anchors, allPos };
}

// Deterministic in-game room names straight from ab0 (see
// applyRoomNameOverrides for the override merge). charset = the glyph array
// from datatable.js parseDatatable; roomIds = the ab2 room ordinals.
// -> Map(ab2 index -> name); ~437/451 covered on the current build.
export function deriveRoomNames(data: Uint8Array, charset: string[], roomIds: Iterable<number>): Map<number, string> {
  const rooms = new Set(roomIds);
  const { anchors, allPos } = roomSelfAnchors(data, rooms);
  const nGlyphs = charset.length;

  const decodeString = (i: number): [string, number] | null => { // charset-indexed string
    let r = rdvSafe(data, i);
    if (r === null || r[0] > 4096) return null;
    const [count, start] = r;
    let j = start;
    const parts = new Array(count);
    for (let k = 0; k < count; k++) {
      r = rdvSafe(data, j);
      if (r === null || r[0] >= nGlyphs) return null;
      parts[k] = charset[r[0]];
      j = r[1];
    }
    return [parts.join(''), j];
  };

  const isLetter = /\p{L}/u;
  const nameBefore = (anc: number, radius = 2600): string | null => {
    let lo = anc - radius;
    let k = 0, hi = allPos.length; // bisect_left(allPos, anc)
    while (k < hi) { const mid = (k + hi) >> 1; if (allPos[mid] < anc) k = mid + 1; else hi = mid; }
    if (k > 0) lo = Math.max(lo, allPos[k - 1] + 1);
    for (let i = anc - 1; i > lo; i--) {
      if (data[i] !== 0x0e) continue;
      const dec = decodeString(i + 1);
      if (dec === null) continue;
      const [txt, end] = dec;
      // A name record is a plain-text 0x0e string immediately followed by a
      // 0x0d/0x0c marker, which separates room names from UI/spawn-label strings.
      const chars = [...txt];
      if (chars.length < 2 || chars.length > 48 || end > anc + 2) continue;
      if (end >= data.length || (data[end] !== 0x0c && data[end] !== 0x0d)) continue;
      let alpha = 0;
      let puaFree = true;
      for (const c of chars) {
        if (isLetter.test(c)) alpha++;
        if (c.codePointAt(0)! >= 0xe000) { puaFree = false; break; }
      }
      if (!puaFree || alpha < 2) continue;
      return txt.split(/\s+/u).filter(Boolean).join(' ');
    }
    return null;
  };

  const out = new Map<number, string>();
  for (const [idx, anc] of anchors) {
    const nm = nameBefore(anc);
    if (nm) out.set(idx, nm);
  }
  return out;
}

// Merge content-hash room-name overrides (defaults/room_name_overrides.json
// `overrides` object) into `names`. contentHashes: Map(ab2 index -> sha256
// hex[:16] of the DECODED object bytes) for every room: the caller computes
// them, so both the hint fast path and the rescan are pure lookups.
export function applyRoomNameOverrides(
  names: Map<number, string>,
  overrides: Record<string, { name: string; ab2_hint: number }>,
  contentHashes: Map<number, string>,
): Map<number, string> {
  const pending = new Map(Object.entries(overrides).map(([h, v]): [string, string] => [h, v.name]));
  for (const [contentHash, value] of Object.entries(overrides)) { // fast path: verify hint
    const hint = value.ab2_hint;
    if (!contentHashes.has(hint)) continue;
    if (contentHashes.get(hint) === contentHash) {
      names.set(hint, value.name);
      pending.delete(contentHash);
    }
  }
  if (pending.size) { // hints stale -> full rescan
    for (const [idx, contentHash] of contentHashes) {
      if (pending.has(contentHash)) names.set(idx, pending.get(contentHash)!);
    }
  }
  return names;
}
