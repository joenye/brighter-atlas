// AB0 registry-stream replay, driven by the per-build decode data.
// The parser is capture-pruned — it consumes each
// generic value byte-for-byte but retains only what edge rows need (tag +
// edge value). Every varint in a supported build fits in 2^32, so values are
// plain Numbers; the 63-bit guard is a decode-failure bound, not a real range.

import type { WorldProfile } from './profile.js';

// Tag tables for the game's generic tagged-value grammar.
const V1 = new Uint8Array(256);
for (const t of [
  0x00, 0x02, 0x0f, 0x13, 0x14, 0x17, 0x1c, 0x1e, 0x26,
  0x32, 0x38, 0x3b, 0x3f, 0x40, 0x43, 0x44, 0x45, 0x46,
  0x47, 0x49, 0x4a, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66,
  0x67, 0x71, 0x73, 0x7c, 0x80, 0x81, 0x84, 0x8b, 0x8c,
  0x93, 0x9e, 0x9f,
]) V1[t] = 1;
for (let t = 0x4b; t < 0x60; t++) V1[t] = 1;
for (let t = 0x68; t < 0x6d; t++) V1[t] = 1;

const FIXED = new Uint8Array(256);
for (const [t, w] of [
  [0x0a, 4], [0x0b, 4], [0x11, 16], [0x12, 21], [0x15, 16],
  [0x16, 24], [0x18, 8], [0x19, 24], [0x1b, 8], [0x1d, 24],
  [0x1f, 8], [0x22, 12], [0x25, 24], [0x27, 8], [0x28, 8],
  [0x29, 12], [0x2a, 16], [0x2e, 8], [0x2f, 12], [0x30, 48],
  [0x31, 16], [0x39, 16], [0x3a, 64], [0x3c, 16], [0x3d, 16],
  [0x3e, 16], [0x41, 8], [0x60, 4], [0x83, 8],
] as [number, number][]) FIXED[t] = w;

const EDGE = new Uint8Array(256);
for (const t of [0x00, 0x0e, 0x13, 0x24, 0x26, 0x47, 0x61, 0x62, 0x67]) EDGE[t] = 1;

export type EdgeValue = number | string | number[] | null;

// Pruned generic-value node: only what edge rows need.
export interface GenericNode {
  tag: number;
  value: number | number[] | null | undefined;
  values: number[] | null;
  classId: number;
}

// g-row entry: [op, depth, tag, edge value]
export type GRow = [number, number, number, EdgeValue];

// Edge value of one node: tag 0x0E -> string from codepoints (0xFFFD beyond
// U+10FFFF), tag 0x24 -> class id, else scalar value with 0 for valueless
// tags. Tags 0x01/0x0C/0x0D carry an explicit null (not 0).
export function edgeValue(node: GenericNode): EdgeValue {
  if (node.tag === 0x0e) {
    let s = '';
    for (const v of node.values!) s += v <= 0x10ffff ? String.fromCodePoint(v) : '�';
    return s;
  }
  if (node.tag === 0x24) return node.classId;
  return node.value === undefined ? 0 : node.value;
}

// Cursor-based (this.pos) recursive parser for the bundle-mode generic-value
// grammar. classFields/tag6Fields: Map<id, field count> from the profile.
export class GenericValueParser {
  data: Uint8Array;
  classFields: Map<number, number>;
  tag6Fields: Map<number, number>;
  pos: number;
  capture: GRow[] | null;
  captureOp: number;

  constructor(data: Uint8Array, classFields: Map<number, number>, tag6Fields: Map<number, number>) {
    this.data = data;
    this.classFields = classFields;
    this.tag6Fields = tag6Fields;
    this.pos = 0;
    this.capture = null; // g-row sink for EDGE-tagged values, set around parse()
    this.captureOp = 0;
  }

  varint(): number {
    const data = this.data;
    let pos = this.pos;
    const start = pos;
    let value = 0, shift = 0;
    for (;;) {
      if (pos >= data.length) throw new Error(`unterminated varint at 0x${start.toString(16)}`);
      const b = data[pos++];
      value += (b & 0x7f) * 2 ** shift; // * not << : varints can exceed 31 bits
      if (b < 0x80) { this.pos = pos; return value; }
      shift += 7;
      if (shift > 63) throw new Error(`oversized varint at 0x${start.toString(16)}`);
    }
  }

  skip(n: number): void {
    const end = this.pos + n;
    if (end > this.data.length) throw new Error(`fixed value overruns stream at 0x${this.pos.toString(16)}`);
    this.pos = end;
  }

  byte(what: string): number {
    if (this.pos >= this.data.length) throw new Error(`${what} overruns stream at 0x${this.pos.toString(16)}`);
    return this.data[this.pos++];
  }

  // One generic value; returns a pruned node {tag, value, values, classId}.
  // value stays undefined for tags whose node has no scalar value at all.
  parse(depth: number): GenericNode {
    const data = this.data;
    const start = this.pos;
    if (start >= data.length) throw new Error(`generic value starts beyond stream at 0x${start.toString(16)}`);
    const tag = data[start];
    this.pos = start + 1;
    const node: GenericNode = { tag, value: undefined, values: null, classId: -1 };

    if (V1[tag]) {
      node.value = this.varint();
    } else if (tag === 0x7d || tag === 0x37 || tag === 0x33 || tag === 0x85) {
      node.value = [this.varint(), this.varint()];
    } else if (tag === 0x10) {
      this.skip(1);
    } else if (FIXED[tag]) {
      this.skip(FIXED[tag]);
    } else if (tag === 0x1a) {
      node.value = this.varint();
      this.skip(12);
    } else if (tag === 0x06) {
      const selector = this.varint();
      const arity = this.tag6Fields.get(selector);
      if (arity === undefined) throw new Error(`unknown tag-0x06 selector ${selector} at 0x${start.toString(16)}`);
      for (let k = 0; k < arity; k++) this.parse(depth + 1);
    } else if (tag === 0x07) {
      const n = this.varint();
      for (let k = 0; k < n; k++) this.varint();
    } else if (tag === 0x23) {
      node.value = this.varint();
      this.skip(16); // guid
      const n = this.varint();
      for (let k = 0; k < n; k++) { this.varint(); this.skip(4); this.varint(); this.varint(); }
      if (this.byte('tag 0x23 flag')) this.skip(24);
    } else if (tag === 0x74) {
      const n = this.varint();
      for (let k = 0; k < n; k++) this.varint();
      this.skip(8);
      this.pos += 1; // unchecked skip; the next varint bounds-checks
      this.varint();
      if (this.byte('tag 0x74 flag')) { this.skip(4); this.pos += 1; this.varint(); }
    } else if (tag === 0x6e || tag === 0x6f) {
      this.skip(100);
    } else if (tag === 0x72) {
      this.skip(52);
      if (this.byte('tag 0x72 flag')) this.skip(100);
      if (this.byte('tag 0x72 flag')) this.skip(100);
      this.varint();
    } else if (tag === 0x01 || tag === 0x0c || tag === 0x0d) {
      node.value = null;
    } else if (tag === 0x0e) {
      const n = this.varint();
      const values = new Array(n);
      for (let k = 0; k < n; k++) values[k] = this.varint();
      node.values = values;
    } else if (tag === 0x08 || tag === 0x20) {
      const n = this.varint();
      for (let k = 0; k < n; k++) this.parse(depth + 1);
    } else if (tag === 0x24) {
      const classId = this.varint();
      const arity = this.classFields.get(classId);
      if (arity === undefined) throw new Error(`unknown typed class ${classId} at 0x${start.toString(16)}`);
      node.classId = classId;
      for (let k = 0; k < arity; k++) this.parse(depth + 1);
    } else if (tag === 0x2c) {
      const n = this.varint();
      for (let k = 0; k < 2 * n; k++) this.parse(depth + 1);
    } else if (tag === 0x7e) {
      this.varint();
      this.varint();
      const rows = this.varint();
      const lengths = new Array(rows);
      for (let k = 0; k < rows; k++) lengths[k] = this.varint();
      for (const length of lengths) {
        for (let k = 0; k < length; k++) if (this.byte('tag 0x7e present flag')) this.varint();
      }
    } else {
      let preview = '';
      for (let k = this.pos; k < Math.min(this.pos + 30, data.length); k++) {
        preview += (preview ? ' ' : '') + data[k].toString(16).padStart(2, '0');
      }
      throw new Error(`unknown generic tag 0x${tag.toString(16)} at 0x${start.toString(16)}: ${preview}`);
    }

    // Post-order: children captured before their parent.
    if (this.capture !== null && EDGE[tag]) {
      this.capture.push([this.captureOp, depth, tag, edgeValue(node)]);
    }
    return node;
  }
}

export interface ConstructorRecord {
  slot: number;
  selector: number;
  runtime: number;
  values: number[];
}

export interface FillRow {
  slot: number;
  selector: number;
  runtime: number;
  start: number;
  g: GRow[];
  r: [number, number][];
  s: [number, number[]][];
  m: [number, { key_tag: number; key_value: EdgeValue; value: number }[]][];
  v: [number, string, number][];
  end: number;
}

interface CompiledSelector {
  runtime: number;
  ctorVarints: number;
  kinds: Uint8Array;
  args: Int32Array;
}

interface CompiledProfile {
  stream: WorldProfile['stream'];
  classFields: Map<number, number>;
  tag6Fields: Map<number, number>;
  selectors: Map<number, CompiledSelector>;
}

// Profile -> lookup structures, cached per profile object. Accepts any object
// carrying the profile's stream / class_fields / tag6_fields / selectors
// payload.
const COMPILED = new WeakMap<object, CompiledProfile>();

function compileProfile(profile: WorldProfile): CompiledProfile {
  let c = COMPILED.get(profile);
  if (c) return c;
  for (const key of ['stream', 'class_fields', 'tag6_fields', 'selectors']) {
    if (!profile[key]) throw new Error(`decode profile has no ${key}`);
  }
  const arities = (obj: Record<string, number>) => {
    const map = new Map<number, number>();
    for (const key in obj) map.set(+key, obj[key]);
    return map;
  };
  const selectors = new Map<number, CompiledSelector>();
  for (const key in profile.selectors) {
    const sel = profile.selectors[key];
    const n = sel.fill.length;
    const kinds = new Uint8Array(n); // op letter char codes
    const args = new Int32Array(n);  // F width / S ctor-varint index (-1 = S?)
    for (let i = 0; i < n; i++) {
      const op = sel.fill[i];
      kinds[i] = op.charCodeAt(0);
      if (op.length > 1) args[i] = op === 'S?' ? -1 : parseInt(op.slice(1), 10);
    }
    selectors.set(+key, { runtime: sel.runtime, ctorVarints: sel.ctor_varints, kinds, args });
  }
  c = {
    stream: profile.stream,
    classFields: arities(profile.class_fields),
    tag6Fields: arities(profile.tag6_fields),
    selectors,
  };
  COMPILED.set(profile, c);
  return c;
}

// Constructor-stream replay -> [{slot, selector, runtime, values}] (values are
// the K constructor varints; S<i> fill ops index into them).
export function replayConstructors(ab0: Uint8Array, profile: WorldProfile): ConstructorRecord[] {
  const { stream, classFields, tag6Fields, selectors } = compileProfile(profile);
  const p = new GenericValueParser(ab0, classFields, tag6Fields);
  p.pos = stream.constructor_start;
  const count = p.varint();
  if (count !== stream.object_count) {
    throw new Error(`constructor stream count ${count} != profile ${stream.object_count}`);
  }
  const objects = new Array(count);
  for (let slot = 0; slot < count; slot++) {
    const selector = p.varint();
    const program = selectors.get(selector);
    if (!program) throw new Error(`slot ${slot}: unknown selector ${selector} at 0x${p.pos.toString(16)}`);
    const values = new Array(program.ctorVarints);
    for (let k = 0; k < program.ctorVarints; k++) values[k] = p.varint();
    objects[slot] = { slot, selector, runtime: program.runtime, values };
  }
  if (p.pos !== stream.constructor_end) {
    throw new Error(`constructor replay ended at 0x${p.pos.toString(16)}, expected 0x${stream.constructor_end.toString(16)}`);
  }
  return objects;
}

// Fill-stream replay: one edge row per object via onRow: {slot, selector,
// runtime, start, g, r, s, m, v, end} with g: [op, depth, tag, value],
// r: [op, ref], s: [op, refs[]], m: [op, [{key_tag, key_value, value}]],
// v: [op, kind, value].
export function replayFill(
  ab0: Uint8Array,
  profile: WorldProfile,
  objects: ConstructorRecord[],
  onRow: (row: FillRow) => void,
): number {
  const { stream, classFields, tag6Fields, selectors } = compileProfile(profile);
  const p = new GenericValueParser(ab0, classFields, tag6Fields);
  p.pos = stream.fill_start;
  const len = ab0.length;
  for (let i = 0; i < objects.length; i++) {
    const rec = objects[i];
    const program = selectors.get(rec.selector);
    if (!program) throw new Error(`slot ${rec.slot}: unknown selector ${rec.selector}`);
    const { kinds, args } = program;
    const start = p.pos;
    const g: GRow[] = [];
    const r: [number, number][] = [];
    const s: [number, number[]][] = [];
    const m: FillRow['m'] = [];
    const v: [number, string, number][] = [];
    for (let op = 0; op < kinds.length; op++) {
      switch (kinds[op]) {
        case 71: // G: generic value, EDGE-tagged nodes captured into g
          p.capture = g;
          p.captureOp = op;
          p.parse(0);
          p.capture = null;
          break;
        case 85: // U
          v.push([op, 'U', p.varint()]);
          break;
        case 87: // W
          v.push([op, 'W', p.varint()]);
          break;
        case 90: { // Z: zigzag ((e >> 1) ^ -(e & 1), kept exact for doubles)
          const e = p.varint();
          v.push([op, 'Z', e % 2 ? -(e + 1) / 2 : e / 2]);
          break;
        }
        case 82: // R
          r.push([op, p.varint()]);
          break;
        case 78: { // N: counted varints, consumed but never logged
          const n = p.varint();
          for (let k = 0; k < n; k++) p.varint();
          break;
        }
        case 77: { // M: map of generic key -> varint value
          const n = p.varint();
          const entries = new Array(n);
          for (let k = 0; k < n; k++) {
            const node = p.parse(0);
            entries[k] = { key_tag: node.tag, key_value: edgeValue(node), value: p.varint() };
          }
          m.push([op, entries]);
          break;
        }
        case 70: // F<width>: fixed bytes, consumed but never logged
          p.pos += args[op];
          if (p.pos > len) throw new Error(`fixed read overruns stream in slot ${rec.slot}`);
          break;
        case 83: { // S<i>: series sized by constructor varint i (S? -> 0)
          const n = args[op] < 0 ? 0 : rec.values[args[op]];
          const refs = new Array(n);
          for (let k = 0; k < n; k++) refs[k] = p.varint();
          s.push([op, refs]);
          break;
        }
        default:
          throw new Error(`unknown program op ${String.fromCharCode(kinds[op])}`);
      }
    }
    onRow({
      slot: rec.slot, selector: rec.selector, runtime: rec.runtime,
      start, g, r, s, m, v, end: p.pos,
    });
  }
  if (stream.fill_end != null && p.pos !== stream.fill_end) {
    throw new Error(`fill replay ended at 0x${p.pos.toString(16)}, expected 0x${stream.fill_end.toString(16)}`);
  }
  return p.pos;
}

// Both phases in one call -> {objects, rows}. onProgress(done, total) fires
// every few thousand rows (worker progress reporting).
export function replayGraph(
  ab0: Uint8Array,
  profile: WorldProfile,
  { onProgress }: { onProgress?: (done: number, total: number) => void } = {},
): { objects: ConstructorRecord[]; rows: FillRow[] } {
  const objects = replayConstructors(ab0, profile);
  const rows: FillRow[] = new Array(objects.length);
  let n = 0;
  replayFill(ab0, profile, objects, (row) => {
    rows[n++] = row;
    if (onProgress && n % 8192 === 0) onProgress(n, objects.length);
  });
  if (onProgress) onProgress(n, objects.length);
  return { objects, rows };
}
