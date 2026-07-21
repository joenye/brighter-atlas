// AB0 interned generic-value pool decode: locate the pool frame structurally,
// fully decode every pool value with full node retention, record the frame
// end. Arities come from the per-build decode data; no validation happens
// here — that is profile.js's job. Floats are big-endian IEEE-754 float32 widened to
// Numbers; opaque payloads stay as Uint8Array views into ab0.

import type { WorldProfile } from './profile.js';

const V1_TAGS = new Uint8Array(256);
for (const t of [
  0x00, 0x02, 0x0f, 0x13, 0x14, 0x17, 0x1c, 0x1e, 0x26, 0x32,
  0x38, 0x3b, 0x3f, 0x40, 0x43, 0x44, 0x45, 0x46, 0x47, 0x49,
  0x4a, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x71, 0x73,
  0x7c, 0x80, 0x81, 0x84, 0x8b, 0x8c, 0x93, 0x9e, 0x9f,
]) V1_TAGS[t] = 1;
for (let t = 0x4b; t < 0x60; t++) V1_TAGS[t] = 1;
for (let t = 0x68; t < 0x6d; t++) V1_TAGS[t] = 1;

const FLOAT_TAGS = new Uint8Array(256); // big-endian float32 count per tag
for (const [t, n] of [
  [0x0b, 1], [0x15, 4], [0x18, 2], [0x22, 3], [0x25, 6], [0x28, 2],
  [0x29, 3], [0x2e, 2], [0x2f, 3], [0x30, 12], [0x39, 4], [0x3c, 4],
  [0x3d, 4], [0x41, 2], [0x60, 1], [0x83, 2],
] as [number, number][]) FLOAT_TAGS[t] = n;

const OPAQUE_TAG_SIZES = new Uint8Array(256);
for (const [t, n] of [
  [0x10, 1], [0x11, 16], [0x12, 21], [0x16, 24], [0x19, 24], [0x1b, 8],
  [0x1d, 24], [0x1f, 8], [0x27, 8], [0x2a, 16], [0x31, 16], [0x3a, 64],
  [0x3e, 16],
] as [number, number][]) OPAQUE_TAG_SIZES[t] = n;

export class ValueDecodeError extends Error {}

const hexTag = (t: number) => `0x${t.toString(16).padStart(2, '0')}`;
const hexOff = (o: number) => `0x${o.toString(16)}`;

export interface PoolFrame {
  countOffset: number;
  start: number;
  count: number;
  materialPrefixLength: number;
  end?: number | null;
}

// Fully retained pool value node; optional fields depend on the tag.
export interface PoolNode {
  tag: number;
  start: number;
  end?: number;
  index?: number;
  value?: any;
  values?: any[];
  raw?: Uint8Array;
  selector?: number;
  fields?: PoolNode[];
  class?: number;
  guid?: Uint8Array;
  rows?: [number, Uint8Array, number, number][];
  flag?: number;
  extra?: Uint8Array;
  raw0?: Uint8Array;
  raw1?: Uint8Array;
  raw2?: Uint8Array;
  b0?: number;
  b1?: number;
  v0?: number;
  v1?: number;
  f0?: number;
  f1?: number;
}

// Decode one short varint and require it to re-encode to the same bytes
// (canonical form). -> [value, end] or null.
function canonicalVarint(data: Uint8Array, offset: number, maxBytes = 5): [number, number] | null {
  const start = offset;
  let value = 0, shift = 0;
  for (let k = 0; k < maxBytes; k++) {
    if (offset >= data.length) return null;
    const b = data[offset++];
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) {
      let rem = value;
      for (let i = start; ; i++) {
        const low = rem % 128;
        rem = Math.floor(rem / 128);
        if (data[i] !== (low | (rem ? 0x80 : 0))) return null;
        if (!rem) return i + 1 === offset ? [value, offset] : null;
      }
    }
    shift += 7;
  }
  return null;
}

// Locate the pool count/start structurally: the pool opens with thousands of
// back-to-back scalar tag-0x02 material handles — the longest such canonical
// run in AB0 — and the count is the unique canonical varint ending exactly at
// that run. -> {countOffset, start, count, materialPrefixLength}.
export function discoverPoolFrame(data: Uint8Array, minimumRun = 256): PoolFrame {
  // Growable typed-array candidate lists (uint32 offsets when ab0 fits, else
  // float64 lanes) instead of number[]s — millions of 0x02 hits made the
  // boxed arrays + Map DP the hot spot here.
  const Lane = data.length <= 0xfffffffe ? Uint32Array : Float64Array;
  let starts = new Lane(4096);
  let ends = new Lane(4096);
  let m = 0;
  for (let p = data.indexOf(0x02); p >= 0; p = data.indexOf(0x02, p + 1)) {
    const d = canonicalVarint(data, p + 1);
    if (!d) continue;
    if (m === starts.length) {
      const s2 = new Lane(m * 2); s2.set(starts); starts = s2;
      const e2 = new Lane(m * 2); e2.set(ends); ends = e2;
    }
    starts[m] = p;
    ends[m] = d[1];
    m++;
  }
  // Dynamic-program chain lengths, walked backwards. starts is strictly
  // ascending and unique, so "the run of the candidate starting at ends[k]"
  // (the old Map lookup) is an exact binary-search hit among candidates > k
  // (ends[k] > starts[k], so an equal start can only sit later) — identical
  // bestRun/bestStart by construction.
  const runs = new Int32Array(m);
  let bestRun = 0, bestStart = -1;
  for (let k = m - 1; k >= 0; k--) {
    const target = ends[k];
    let lo = k + 1, hi = m;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < target) lo = mid + 1; else hi = mid; }
    const run = 1 + (lo < m && starts[lo] === target ? runs[lo] : 0);
    runs[k] = run;
    if (run > bestRun) { bestRun = run; bestStart = starts[k]; }
  }
  if (bestRun < minimumRun) {
    throw new ValueDecodeError(`could not find generic pool material prefix (longest run ${bestRun})`);
  }
  const preceding: [number, number][] = [];
  for (let co = Math.max(0, bestStart - 10); co < bestStart; co++) {
    const d = canonicalVarint(data, co, 10);
    if (d && d[1] === bestStart && d[0] >= bestRun && d[0] <= 10_000_000) preceding.push([co, d[0]]);
  }
  if (preceding.length !== 1) {
    throw new ValueDecodeError(`generic pool prefix has no unique preceding count: ${JSON.stringify(preceding)}`);
  }
  return {
    countOffset: preceding[0][0],
    start: bestStart,
    count: preceding[0][1],
    materialPrefixLength: bestRun,
  };
}

// Recursive decoder for the game's generic tagged-value grammar, full
// retention (cursor-based; raw payloads kept as Uint8Array views into ab0).
export class PoolDecoder {
  data: Uint8Array;
  view: DataView;
  classArities: Map<number, number>;
  tag6Arities: Map<number, number>;
  pos: number;

  constructor(data: Uint8Array, classArities: Map<number, number>, tag6Arities: Map<number, number>) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.classArities = classArities; // Map<classId, arity>
    this.tag6Arities = tag6Arities;   // Map<selector, arity>
    this.pos = 0;
  }

  need(size: number, context: string): void {
    if (this.pos + size > this.data.length) {
      throw new ValueDecodeError(
        `truncated ${context} at ${hexOff(this.pos)}: need ${size} bytes, have ${this.data.length - this.pos}`,
      );
    }
  }

  varint(): number {
    const data = this.data;
    let pos = this.pos;
    const start = pos;
    let value = 0, shift = 0;
    for (;;) {
      if (pos >= data.length) throw new ValueDecodeError(`truncated varint at ${hexOff(pos)}`);
      const b = data[pos++];
      value += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) { this.pos = pos; return value; }
      shift += 7;
      if (shift > 63) throw new ValueDecodeError(`overlong varint at ${hexOff(start)}`);
    }
  }

  raw(size: number, context: string): Uint8Array {
    this.need(size, context);
    const out = this.data.subarray(this.pos, this.pos + size);
    this.pos += size;
    return out;
  }

  byte(context: string): number {
    this.need(1, context);
    return this.data[this.pos++];
  }

  children(count: number, depth: number): PoolNode[] {
    const values = new Array(count);
    for (let k = 0; k < count; k++) values[k] = this.value(depth + 1);
    return values;
  }

  value(depth = 0): PoolNode {
    const start = this.pos;
    this.need(1, 'value tag');
    const tag = this.data[this.pos++];
    const node: PoolNode = { tag, start };

    if (V1_TAGS[tag]) {
      node.value = this.varint();
    } else if (tag === 0x0a) {
      this.need(4, 'tag 0x0a signed integer payload');
      node.value = this.view.getInt32(this.pos, false);
      this.pos += 4;
    } else if (tag === 0x33 || tag === 0x37 || tag === 0x7d) {
      node.value = [this.varint(), this.varint()];
    } else if (FLOAT_TAGS[tag]) {
      const n = FLOAT_TAGS[tag];
      this.need(4 * n, `tag ${hexTag(tag)} float payload`);
      const values = new Array(n);
      for (let k = 0; k < n; k++) values[k] = this.view.getFloat32(this.pos + 4 * k, false);
      node.value = values;
      this.pos += 4 * n;
    } else if (OPAQUE_TAG_SIZES[tag]) {
      node.raw = this.raw(OPAQUE_TAG_SIZES[tag], `tag ${hexTag(tag)} payload`);
    } else if (tag === 0x1a) {
      node.value = this.varint();
      node.raw = this.raw(12, 'tag 0x1a payload');
    } else if (tag === 0x06) {
      const selector = this.varint();
      const arity = this.tag6Arities.get(selector);
      if (arity === undefined) {
        throw new ValueDecodeError(`unknown tag-0x06 selector ${selector} at ${hexOff(start)}`);
      }
      node.selector = selector;
      node.fields = this.children(arity, depth);
    } else if (tag === 0x07) {
      const n = this.varint();
      node.values = new Array(n);
      for (let k = 0; k < n; k++) node.values[k] = this.varint();
    } else if (tag === 0x23) {
      node.value = this.varint();
      node.guid = this.raw(16, 'tag 0x23 GUID');
      const n = this.varint();
      const rows: [number, Uint8Array, number, number][] = new Array(n);
      for (let k = 0; k < n; k++) {
        const first = this.varint();
        const raw = this.raw(4, 'tag 0x23 row payload');
        rows[k] = [first, raw, this.varint(), this.varint()];
      }
      node.rows = rows;
      node.flag = this.byte('tag 0x23 flag');
      if (node.flag) node.extra = this.raw(24, 'tag 0x23 optional payload');
    } else if (tag === 0x74) {
      const n = this.varint();
      node.values = new Array(n);
      for (let k = 0; k < n; k++) node.values[k] = this.varint();
      node.raw0 = this.raw(8, 'tag 0x74 payload');
      node.b0 = this.byte('tag 0x74 byte');
      node.v0 = this.varint();
      node.flag = this.byte('tag 0x74 flag');
      if (node.flag) {
        node.raw1 = this.raw(4, 'tag 0x74 optional payload');
        node.b1 = this.byte('tag 0x74 optional byte');
        node.v1 = this.varint();
      }
    } else if (tag === 0x6e || tag === 0x6f) {
      node.raw = this.raw(100, `tag ${hexTag(tag)} payload`);
    } else if (tag === 0x72) {
      node.raw0 = this.raw(52, 'tag 0x72 payload');
      node.f0 = this.byte('tag 0x72 first flag');
      if (node.f0) node.raw1 = this.raw(100, 'tag 0x72 first optional payload');
      node.f1 = this.byte('tag 0x72 second flag');
      if (node.f1) node.raw2 = this.raw(100, 'tag 0x72 second optional payload');
      node.value = this.varint();
    } else if (tag === 0x01 || tag === 0x0c || tag === 0x0d) {
      node.value = null;
    } else if (tag === 0x0e) {
      const n = this.varint();
      node.values = new Array(n);
      for (let k = 0; k < n; k++) node.values[k] = this.varint();
    } else if (tag === 0x08 || tag === 0x20) {
      node.values = this.children(this.varint(), depth);
    } else if (tag === 0x24) {
      const classId = this.varint();
      const arity = this.classArities.get(classId);
      if (arity === undefined) {
        throw new ValueDecodeError(`unknown tag-0x24 class ${classId} at ${hexOff(start)}`);
      }
      node.class = classId;
      node.fields = this.children(arity, depth);
    } else if (tag === 0x2c) {
      node.values = this.children(2 * this.varint(), depth);
    } else {
      let preview = '';
      for (let k = this.pos; k < Math.min(this.pos + 30, this.data.length); k++) {
        preview += (preview ? ' ' : '') + this.data[k].toString(16).padStart(2, '0');
      }
      throw new ValueDecodeError(`unknown generic tag ${hexTag(tag)} at ${hexOff(start)}; next: ${preview}`);
    }
    node.end = this.pos;
    return node;
  }

  // Decode every pool value under the discovered frame -> {values, end}.
  pool(frame: PoolFrame): { values: PoolNode[]; end: number } {
    this.pos = frame.countOffset;
    const count = this.varint();
    if (count !== frame.count || this.pos !== frame.start) {
      throw new ValueDecodeError(
        `pool framing mismatch: count=${count} start=${hexOff(this.pos)}, `
        + `expected count=${frame.count} start=${hexOff(frame.start)}`,
      );
    }
    const values = new Array(count);
    for (let index = 0; index < count; index++) {
      let value;
      try {
        value = this.value(0);
      } catch (exc) {
        throw new ValueDecodeError(`pool index ${index}: ${exc.message}`);
      }
      value.index = index;
      values[index] = value;
    }
    if (frame.end != null && this.pos !== frame.end) {
      throw new ValueDecodeError(`pool ended at ${hexOff(this.pos)}, expected ${hexOff(frame.end)}`);
    }
    return { values, end: this.pos };
  }
}

// Frame the pool from the data itself, decode all values, record the end.
// ab0 = decompressed bundle bytes; profile supplies the build's
// class/tag-0x06 arities.
export function decodePool(
  ab0: Uint8Array,
  profile: Pick<WorldProfile, 'class_fields' | 'tag6_fields'>,
): { values: PoolNode[]; frame: PoolFrame } {
  const arities = (obj: Record<string, number>) => {
    const map = new Map<number, number>();
    for (const key in obj) map.set(+key, obj[key]);
    return map;
  };
  const frame = discoverPoolFrame(ab0);
  const decoder = new PoolDecoder(ab0, arities(profile.class_fields), arities(profile.tag6_fields));
  const { values, end } = decoder.pool(frame);
  frame.end = end;
  return { values, frame };
}
