// Particle-effect recovery over the replayed registry. Detection is
// structural and per build: systems are rows whose series children all point
// back at them through an op-0 scalar; child and config fields are re-decoded
// at full retention from each row's own byte span in ab0, and every re-decode
// must land byte-exactly on the row's recorded end. Worker-safe: no DOM, no
// Node APIs.
//
// Why a re-decode at all: the replay keeps rows capture-pruned (fixed-width
// payloads are skipped, fixed program bytes and counted varints are consumed
// unlogged), so almost everything an emitter carries (colors, rates,
// durations, image handles) is invisible in the row events alone. Each fill
// row records its exact start/end byte span and the per-build decode data
// exposes every selector's fill program, so candidate rows are re-decoded
// here from their own spans, never the whole registry.
//
// Detection is anchored system-first: a candidate system is a row with a
// series whose every member points back at it through the op-0 unsigned
// scalar (the same raw-slot backpointer the animatic name join uses,
// anim-names.js) and carries at least one direct reference of its own.
// Emitter families (grouped by reader family id, observed per build as data)
// are then accepted by voting over decoded content, with an exhaustive rule
// for families too small to vote, so a family that fails its gates drops
// cleanly instead of shipping garbage. Field roles bind by order within tag
// type, never by absolute op position (older builds shift layout).
//
// The module is internally total: any detection failure degrades to a
// smaller or empty document plus an audit record, never a throw
// (cancellation excepted). The document is deterministic: ascending-slot
// iteration everywhere, floats only from the bundle bytes via DataView, no
// timestamps.

import { PoolDecoder } from './value-pool.js';
import type { PoolNode } from './value-pool.js';
import type { WorldProfile, WorldProfileSelector } from './profile.js';
import type { FillRow } from './replay.js';
import type { PoolStrings } from './models.js';
import type { RoomOccurrence } from './room.js';

export const WORLD_EFFECTS_FORMAT = 1;

const MIN_VOTERS = 8;           // family acceptance quorum; below it the exhaustive rule applies
const VOTER_CAP = 256;          // sampled voters per family
const ACCEPT_FRACTION = 0.9;    // burst fraction a voted family must reach
const ROLE_FRACTION = 0.9;      // duration-count agreement needed for fade roles
const FADE_DEMOTION = 0.1;      // voters violating fade_in + fade_out <= life
const FANOUT_CAP = 8;           // clip-walk hub cutoff (same rule as anim-names.js)
const WALK_DEPTH = 2;           // controller -> clip record reference distance
const TYPED_DEPTH_CAP = 6;      // typed/container recursion depth in retained extras
const EXTRA_CHILD_CAP = 512;    // per-row cap on nested retained entries (pooled containers re-expand)
const WINDOW_TICK_LIMIT = 1e7;  // sane burst-window bound in ticks
const BAIL_ROW_MASK = 4095;     // cancellation/progress checkpoint (row scans)
const BAIL_DECODE_MASK = 255;   // cancellation/progress checkpoint (re-decodes)

// Durations are raw tick counts; rates carry an explicit per-tick
// denominator. The seconds conversion uses the modal denominator observed in
// the data (see deriveTickRate); this guarded default only covers builds with
// too few rates to vote or no dominant mode.
const TICK_DEN_DEFAULT = 600;

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isNode = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- doc schema

// Negative `tag` values mark entries synthesized from program ops (the
// negated op letter code: -85 U, -87 W, -90 Z, -77 M, -78 N); non-negative
// tags are genuine grammar tags observed in the data. The two namespaces
// must never collide: a generic op can emit the same code points as scalars.
export type EffectExtra =        // unknown/unclassified ops ONLY
  | { op: number; kind: 'duration'; ticks: number }
  | { op: number; kind: 'rate'; value: number; den: number }
  | { op: number; kind: 'color'; rgba: [number, number, number, number] }
  | { op: number; kind: 'vec3'; v: [number, number, number] }
  | { op: number; kind: 'float'; value: number }
  | { op: number; kind: 'int'; value: number }
  | { op: number; kind: 'symbol'; index: number; name: string | null }
  | { op: number; kind: 'string'; text: string }
  | { op: number; kind: 'scalar'; tag: number; value: number }
  | { op: number; kind: 'ref'; slot: number }
  | { op: number; kind: 'series'; slots: number[] }
  | { op: number; kind: 'typed'; class: number; fields: EffectExtra[] }  // depth <= 6
  | { op: number; kind: 'list'; tag: number; values: EffectExtra[] }
  | { op: number; kind: 'fixed'; floats: number[] | null }
  | { op: number; kind: 'other'; tag: number };

export interface EffectConfig {
  slot: number; family: number;
  kind: 'burst_continuous' | 'burst_windowed' | 'shape' | 'unknown';
  per_second?: number | null;                  // burst kinds
  windows?: [number, number][] | null;         // tick ranges, burst_windowed
  shape_kind?: 'point' | 'ring' | 'spiral' | 'other';
  center?: [number, number, number] | null;    // first vec3
  axis?: [number, number, number] | null;
  radius?: number | null; sweep?: number | null;
  spread_yaw?: number | null; spread_pitch?: number | null;
  spiral?: { axis: [number, number, number]; start_radius: number; radius_rate: number;
             start_angle: number; angle_rate: number } | null;
  extra: EffectExtra[];
}

export interface EffectEmitter {
  slot: number; family: number;
  burst: number | null; shape: number | null;  // -> configs[slot]
  sprite: { material: number; images: number[] } | null;  // ab3 container ordinals
  blend: 'add' | 'mix' | null;                 // emitter override, else system's
  life: { ticks: number; op: number } | null;
  fade_in: { ticks: number; op: number } | null;
  fade_out: { ticks: number; op: number } | null;
  color0: { rgba: [number, number, number, number]; op: number } | null;
  color1: { rgba: [number, number, number, number]; op: number } | null;
  scale0: { value: number; op: number } | null;
  scale1: { value: number; op: number } | null;
  speed: { value: number; den: number; op: number } | null;
  angular_speed: { value: number; den: number; op: number } | null;
  rate: { value: number; den: number; op: number } | null;
  direction: { v: [number, number, number]; op: number } | null;
  acceleration: { v: [number, number, number]; op: number } | null;
  confidence: 'vote' | 'order';
  extra: EffectExtra[];
}

export interface EffectSystem {
  slot: number;                                // the system's registry slot in this version
  blend: 'add' | 'mix'; facing: 'screen' | 'other';
  loop: boolean; cycle_ticks: number | null;
  emitters: EffectEmitter[];                   // series order
  names: { name: string; source: 'controller' | 'row'; controller: number }[]; // sorted (name, controller)
  controllers: number[]; clips: number[];      // sorted asc
  extra: EffectExtra[];
}

export interface WorldEffectsDoc {
  format: number;
  tick_rate: { value: number; via: 'modal_denominator' | 'default'; votes: number };
  audit: {
    rows: number; candidate_systems: number; systems: number; emitters: number;
    rejected_children: number; parse_failures: number; parse_mismatches: number;
    families: Record<string, { members: number; via: 'vote' | 'exhaustive' | 'rejected';
      burst_fraction: number; origin_fraction: number; image_fraction: number }>;
    config_kinds: Record<string, number>;
    named_systems: number; attached_rooms: number; attached_actors: number;
    error?: string;
  };
  configs: Record<string, EffectConfig>;       // key = String(slot), ascending insert
  systems: EffectSystem[];                     // ascending slot
  attachments: {
    rooms: { room: number; cell: [number, number, number]; occurrence: number;
             resource: number; rot: number; via: 'resource' | 'secondary';
             system: number; controller: number | null;
             anchor: [number, number, number] }[]; // sorted (room, occurrence, system, controller)
    actors: { actor: number; label: string | null; system: number;
              controller: number | null }[];                // sorted (actor, system)
    owners: { owner: number; system: number; controller: number | null }[]; // sorted (owner, system)
  };
}

export interface WorldEffectsShared {
  charset: ArrayLike<string>; symbols: string[];
  strings: PoolStrings; poolRegistryRefs: (i: number) => number[];
  textureSlots: Map<number, number[]>;        // material slot -> ab3 ids
  roomIds: number[];
  occupancy: (roomId: number) => { occurrences: RoomOccurrence[] }; // read-only cached
  bounds3f: (ownerSlot: number) => number[] | null; // owner's native-unit model envelope, read-only cached
  spawnActors: Map<number, { owner_slot: number; label: string | null }>;
  bail: () => void;                           // cancellation check, throws on cancel
  onStep?: (done: number, total: number) => void;
}

// ------------------------------------------------- full-retention re-decoder

// Full-retention fill-value decoder: the pool decoder (value-pool.js) plus
// the two fill-only generic tags the pool never carries. Mirror the replay
// branches EXACTLY: 0x85 is a tag followed by two varints (replay.js groups
// it with 0x7d/0x37/0x33); 0x7e is the counted present-flag structure walked
// exactly as replay.js walks it. Both are retained as opaque nodes
// ({tag, start, end}); their payloads are framing, not renderer input. The
// byte-exact postcondition in reparseRow is the proof of faithfulness.
class FillValueDecoder extends PoolDecoder {
  value(depth = 0): PoolNode {
    const start = this.pos;
    this.need(1, 'value tag');
    const tag = this.data[start];
    if (tag === 0x85) {
      this.pos = start + 1;
      const node: PoolNode = { tag, start };
      node.value = [this.varint(), this.varint()];
      node.end = this.pos;
      return node;
    }
    if (tag === 0x7e) {
      this.pos = start + 1;
      const node: PoolNode = { tag, start };
      this.varint();
      this.varint();
      const rows = this.varint();
      const lengths = new Array(rows);
      for (let k = 0; k < rows; k++) lengths[k] = this.varint();
      for (const length of lengths) {
        for (let k = 0; k < length; k++) if (this.byte('tag 0x7e present flag')) this.varint();
      }
      node.end = this.pos;
      return node;
    }
    return super.value(depth);
  }
}

type ReparsedOp =
  | { op: number; kind: 'G'; node: PoolNode }
  | { op: number; kind: 'U' | 'W' | 'Z' | 'R'; value: number }
  | { op: number; kind: 'N'; values: number[] }
  | { op: number; kind: 'M'; entries: { key: PoolNode; value: number }[] }
  | { op: number; kind: 'F'; raw: Uint8Array }
  | { op: number; kind: 'S'; refs: number[] };

interface ParseAudit { parse_failures: number; parse_mismatches: number }

// One row re-decoded from its own byte span by walking the selector's fill
// program. Series counts come from the row's already-replayed series events
// (replay resolved every count when it produced the rows). Any decode throw
// is contained per row (fill-only tags on unknown builds, arity drift); a
// decode that does not land exactly on the row's recorded end drops the row
// to the audit rather than mis-decoding it.
function reparseRow(
  dec: FillValueDecoder, sel: WorldProfileSelector, row: FillRow, audit: ParseAudit,
): ReparsedOp[] | null {
  const sCounts = new Map<number, number>();
  for (const [op, refs] of row.s) sCounts.set(op, refs.length);
  dec.pos = row.start;
  const out: ReparsedOp[] = [];
  try {
    for (let op = 0; op < sel.fill.length; op++) {
      const code = sel.fill[op];
      switch (code.charCodeAt(0)) {
        case 71: // G: one generic value, full node tree
          out.push({ op, kind: 'G', node: dec.value(0) });
          break;
        case 85: // U
          out.push({ op, kind: 'U', value: dec.varint() });
          break;
        case 87: // W
          out.push({ op, kind: 'W', value: dec.varint() });
          break;
        case 90: { // Z: zigzag, same formula as the replay
          const e = dec.varint();
          out.push({ op, kind: 'Z', value: e % 2 ? -(e + 1) / 2 : e / 2 });
          break;
        }
        case 82: // R
          out.push({ op, kind: 'R', value: dec.varint() });
          break;
        case 78: { // N: counted varints
          const n = dec.varint();
          const values = new Array(n);
          for (let k = 0; k < n; k++) values[k] = dec.varint();
          out.push({ op, kind: 'N', values });
          break;
        }
        case 77: { // M: map of generic key -> varint value
          const n = dec.varint();
          const entries = new Array(n);
          for (let k = 0; k < n; k++) {
            const key = dec.value(0);
            entries[k] = { key, value: dec.varint() };
          }
          out.push({ op, kind: 'M', entries });
          break;
        }
        case 70: { // F<width>: fixed bytes, retained raw (bare F is width 0,
                   // matching the replay's compiled programs)
          const w = code.length > 1 ? parseInt(code.slice(1), 10) : 0;
          out.push({ op, kind: 'F', raw: dec.raw(w, 'fixed field') });
          break;
        }
        case 83: { // S: series sized by the replayed series event
          const n = sCounts.get(op) ?? 0;
          const refs = new Array(n);
          for (let k = 0; k < n; k++) refs[k] = dec.varint();
          out.push({ op, kind: 'S', refs });
          break;
        }
        default:
          throw new Error(`unknown program op ${code}`);
      }
    }
  } catch {
    audit.parse_failures++;   // per-row containment: the candidate drops, nothing else moves
    return null;
  }
  if (dec.pos !== row.end) { audit.parse_mismatches++; return null; }  // byte-exact guard
  return out;
}

// -------------------------------------------------- decoded-value conversion

interface ExtraBuilder {
  pool: PoolNode[];
  glyphs: ArrayLike<string>;
  symbols: string[];
  view: DataView;       // over ab0: all float/uint reinterpretations, big-endian
  base: number;         // ab0.byteOffset, rebases raw subarray offsets
}

// pool tag-0 reference chain -> the final non-reference node, acyclic
function derefPool(pool: PoolNode[], index: any): PoolNode | null {
  let node: PoolNode | null = null;
  let cursor = index;
  const seen = new Set<number>();
  while (isInt(cursor) && cursor >= 0 && cursor < pool.length && !seen.has(cursor)) {
    seen.add(cursor);
    node = pool[cursor];
    if (!(isNode(node) && node.tag === 0)) break;
    cursor = node.value;
  }
  return node !== null && isNode(node) && node.tag !== 0 ? node : null;
}

// inline fill strings carry codepoints; pooled strings carry charset indices
function inlineText(values: any[] | undefined): string | null {
  if (!Array.isArray(values)) return null;
  let s = '';
  for (const v of values) s += isInt(v) && v <= 0x10ffff ? String.fromCodePoint(v) : '�';
  return s;
}
function pooledText(glyphs: ArrayLike<string>, values: any[] | undefined): string | null {
  if (!Array.isArray(values)) return null;
  let s = '';
  for (const v of values) {
    const glyph = glyphs[v];
    if (glyph === undefined) return null;
    s += glyph;
  }
  return s;
}

// One decoded generic node -> the retained extras form. Every entry carries
// the top-level op it came from; containers recurse to TYPED_DEPTH_CAP and
// stop adding children once the per-row nested-entry budget is spent (the
// depth cap alone does not bound pooled containers that re-expand widely).
// pooled distinguishes the two string encodings (see anim-names.js).
function nodeExtra(b: ExtraBuilder, op: number, node: PoolNode, pooled: boolean, depth: number,
                   budget: { left: number }): EffectExtra {
  let n = node;
  if (n.tag === 0x00) {
    const target = derefPool(b.pool, n.value);
    if (!target) return { op, kind: 'scalar', tag: 0x00, value: isInt(n.value) ? n.value : -1 };
    n = target;
    pooled = true;
  }
  const tag = n.tag;
  switch (tag) {
    case 0x28: // duration pair: the second lane's bit pattern IS the tick count
      return { op, kind: 'duration', ticks: b.view.getUint32(n.start + 1 + 4, false) };
    case 0x29: // rate triple: value plus its per-tick denominator's bit pattern
      return { op, kind: 'rate', value: n.value[0], den: b.view.getUint32(n.start + 1 + 8, false) };
    case 0x15:
      return { op, kind: 'color', rgba: [n.value[0], n.value[1], n.value[2], n.value[3]] };
    case 0x22:
      return { op, kind: 'vec3', v: [n.value[0], n.value[1], n.value[2]] };
    case 0x0b:
      return { op, kind: 'float', value: n.value[0] };
    case 0x0a:
      return { op, kind: 'int', value: n.value };
    case 0x0f: {
      const index = isInt(n.value) ? n.value : -1;
      const name = index >= 0 && index < b.symbols.length ? b.symbols[index] : null;
      return { op, kind: 'symbol', index, name };
    }
    case 0x0e: {
      const text = pooled ? pooledText(b.glyphs, n.values) : inlineText(n.values);
      return text === null ? { op, kind: 'other', tag } : { op, kind: 'string', text };
    }
    case 0x26:
      return { op, kind: 'ref', slot: isInt(n.value) ? n.value : -1 };
    case 0x24: case 0x06: {
      if (depth >= TYPED_DEPTH_CAP) return { op, kind: 'other', tag };
      // tag-0x06 stores its selector in `class` (both are per-build ids, data)
      const cls = tag === 0x24 ? n.class : n.selector;
      const fields: EffectExtra[] = [];
      for (const child of (n.fields || []) as PoolNode[]) {
        if (budget.left <= 0) break;
        budget.left--;
        fields.push(nodeExtra(b, op, child, pooled, depth + 1, budget));
      }
      return { op, kind: 'typed', class: isInt(cls) ? cls : -1, fields };
    }
    case 0x08: case 0x20: case 0x2c: {
      if (depth >= TYPED_DEPTH_CAP) return { op, kind: 'other', tag };
      const values: EffectExtra[] = [];
      for (const child of (n.values || []) as PoolNode[]) {
        if (budget.left <= 0) break;
        budget.left--;
        values.push(nodeExtra(b, op, child, pooled, depth + 1, budget));
      }
      return { op, kind: 'list', tag, values };
    }
    default:
      // remaining scalar-valued tags keep their value; opaque/float-array
      // payloads are framing only here
      if (isInt(n.value)) return { op, kind: 'scalar', tag, value: n.value };
      return { op, kind: 'other', tag };
  }
}

// Re-parsed ops -> one retained extras entry per op. Top-level entries are
// bounded by the program length; nested children share the per-row
// EXTRA_CHILD_CAP budget. Program-op entries carry NEGATED op letter codes
// as tags (see the EffectExtra note): the positive code points are genuine
// grammar tags a generic op can emit, so they must not be reused.
function opsToExtras(b: ExtraBuilder, ops: ReparsedOp[]): EffectExtra[] {
  const out: EffectExtra[] = [];
  const budget = { left: EXTRA_CHILD_CAP };
  for (const p of ops) {
    switch (p.kind) {
      case 'G':
        out.push(nodeExtra(b, p.op, p.node, false, 0, budget));
        break;
      case 'U': case 'W': case 'Z':
        out.push({ op: p.op, kind: 'scalar', tag: -p.kind.charCodeAt(0), value: p.value });
        break;
      case 'R':
        out.push({ op: p.op, kind: 'ref', slot: p.value });
        break;
      case 'N': {
        const values: EffectExtra[] = [];
        for (const value of p.values) {
          if (budget.left <= 0) break;
          budget.left--;
          values.push({ op: p.op, kind: 'int', value });
        }
        out.push({ op: p.op, kind: 'list', tag: -78, values });
        break;
      }
      case 'M':
        out.push({ op: p.op, kind: 'other', tag: -77 });
        break;
      case 'F': {
        let floats: number[] | null = null;
        if (p.raw.length % 4 === 0) {
          floats = [];
          const off = p.raw.byteOffset - b.base;
          for (let k = 0; k < p.raw.length; k += 4) floats.push(b.view.getFloat32(off + k, false));
        }
        out.push({ op: p.op, kind: 'fixed', floats });
        break;
      }
      case 'S':
        out.push({ op: p.op, kind: 'series', slots: p.refs.slice() });
        break;
    }
  }
  return out;
}

function walkExtra(e: EffectExtra, fn: (e: EffectExtra) => void): void {
  fn(e);
  if (e.kind === 'typed') for (const c of e.fields) walkExtra(c, fn);
  else if (e.kind === 'list') for (const c of e.values) walkExtra(c, fn);
}

function durationsUnder(e: EffectExtra): number[] {
  const out: number[] = [];
  walkExtra(e, (n) => { if (n.kind === 'duration') out.push(n.ticks); });
  return out;
}

// Burst windows: a typed object or container whose duration leaves are
// exactly two well-ordered ticks, or a container of such pairs. Anything
// duration-bearing that is not window-shaped disqualifies the container.
function windowsOf(e: EffectExtra): [number, number][] | null {
  if (e.kind !== 'typed' && e.kind !== 'list') return null;
  const durs = durationsUnder(e);
  if (durs.length === 2) {
    const [a, b] = durs;
    return a >= 0 && a <= b && b < WINDOW_TICK_LIMIT ? [[a, b]] : null;
  }
  if (durs.length < 2) return null;
  const children = e.kind === 'typed' ? e.fields : e.values;
  const out: [number, number][] = [];
  for (const child of children) {
    if (!durationsUnder(child).length) continue;
    const w = windowsOf(child);
    if (!w) return null;
    out.push(...w);
  }
  return out.length ? out : null;
}

// ------------------------------------------------------ room-attachment anchor

// The middle of a sorted sample (even counts average the two middle values);
// null on an empty sample.
function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Native-unit offset from a room occurrence's placement pivot (tile centre,
// floor layer) to a system's world origin: XY at the owning occurrence's own
// bounding-box centre (its real centroid, not the tile corner), Z at the
// bounding-box top for a hanging system or the base for a grounded one (a
// hanging chandelier's glow belongs near its housing, not the floor it is
// nominally placed on; a grounded emitter's spray belongs at the object's
// foot, not its model-space midpoint). Absent bounds degrade to the pivot
// itself (an all-zero offset), so an occurrence with no resolvable envelope
// keeps today's tile-corner / floor placement rather than guessing.
function roomSystemAnchor(bbox: number[] | null, hanging: boolean): [number, number, number] {
  if (!bbox) return [0, 0, 0];
  return [
    Math.round((bbox[0] + bbox[3]) / 2),
    Math.round((bbox[1] + bbox[4]) / 2),
    Math.round(hanging ? bbox[5] : bbox[2]),
  ];
}

// ------------------------------------------------------------ empty document

function makeEmptyDoc(rowCount: number, error: string | null): WorldEffectsDoc {
  const audit: WorldEffectsDoc['audit'] = {
    rows: rowCount, candidate_systems: 0, systems: 0, emitters: 0,
    rejected_children: 0, parse_failures: 0, parse_mismatches: 0,
    families: {}, config_kinds: {}, named_systems: 0, attached_rooms: 0, attached_actors: 0,
  };
  if (error) audit.error = error;
  return {
    format: WORLD_EFFECTS_FORMAT,
    tick_rate: { value: TICK_DEN_DEFAULT, via: 'default', votes: 0 },
    audit,
    configs: {},
    systems: [],
    attachments: { rooms: [], actors: [], owners: [] },
  };
}

// ------------------------------------------------------------------- extract

// rows: replay.js registry rows (carry exact byte spans); pool: value-pool.js
// values; ab0: decompressed bundle bytes (the re-decode source); profile: the
// per-build decode data (selector fill programs). `shared` supplies the
// orchestrator's memoized derivations plus cancellation/progress. Internally
// total: detection failure returns an empty doc + audit, never throws except
// on cancellation.
export function extractWorldEffects(
  rows: FillRow[], pool: PoolNode[], ab0: Uint8Array, profile: WorldProfile,
  shared: WorldEffectsShared,
): WorldEffectsDoc {
  try {
    return extractEffects(rows, pool, ab0, profile, shared);
  } catch (err) {
    if (err?.message === 'cancelled') throw err;
    return makeEmptyDoc(rows.length, String(err?.message || err));
  }
}

function extractEffects(
  rows: FillRow[], pool: PoolNode[], ab0: Uint8Array, profile: WorldProfile,
  shared: WorldEffectsShared,
): WorldEffectsDoc {
  const { bail } = shared;
  const onStep = shared.onStep ?? (() => {});
  // coarse cumulative progress: discovery + re-decode + three row-scale
  // sweeps + room joins; the re-decode share is added once its size is known
  let progressBase = 0;
  let progressTotal = rows.length * 4 + shared.roomIds.length;

  const audit: WorldEffectsDoc['audit'] = {
    rows: rows.length, candidate_systems: 0, systems: 0, emitters: 0,
    rejected_children: 0, parse_failures: 0, parse_mismatches: 0,
    families: {}, config_kinds: {}, named_systems: 0, attached_rooms: 0, attached_actors: 0,
  };

  // ---- E1: candidate discovery (topology only, no re-decode) ----------------
  // The op-0 unsigned scalar is the child's owner backpointer (bounds-checked
  // exactly like anim-names.js). A series is a candidate emitter series iff
  // every member is in range, points back at this row, and carries at least
  // one direct reference of its own (emitters reference their configs).
  const ownerOf = (row: FillRow): number | null => {
    for (const [op, kind, value] of row.v) {
      if (op === 0 && kind === 'U' && isInt(value) && value >= 0 && value < rows.length) return value;
    }
    return null;
  };
  const candidates = new Map<number, { row: FillRow; series: [number, number[]][] }>();
  const emitterSlots = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    if ((i & BAIL_ROW_MASK) === 0) { bail(); onStep(progressBase + i, progressTotal); }
    const row = rows[i];
    if (!row.s.length) continue;
    let series: [number, number[]][] | null = null;
    for (const [op, refs] of row.s) {
      if (!refs.length) continue;
      let all = true;
      for (const ref of refs) {
        if (!isInt(ref) || ref < 0 || ref >= rows.length
          || ownerOf(rows[ref]) !== row.slot || rows[ref].r.length < 1) { all = false; break; }
      }
      if (all) (series || (series = [])).push([op, refs]);
    }
    if (series) {
      candidates.set(row.slot, { row, series });
      for (const [, refs] of series) for (const ref of refs) emitterSlots.add(ref);
    }
  }
  audit.candidate_systems = candidates.size;
  progressBase += rows.length;

  // ---- E2: full-retention re-decode of the candidate neighbourhood ----------
  // Candidate systems (cycle duration + blend/facing/loop symbols), candidate
  // emitters, and every distinct direct-reference target of an emitter (the
  // burst/shape configs). Short spans only, never the whole registry.
  const targets = new Set<number>();
  for (const slot of candidates.keys()) targets.add(slot);
  for (const slot of emitterSlots) {
    targets.add(slot);
    for (const [, ref] of rows[slot].r) {
      if (isInt(ref) && ref >= 0 && ref < rows.length) targets.add(ref);
    }
  }
  const targetList = [...targets].sort((a, b) => a - b);
  progressTotal += targetList.length;

  const arities = (obj: Record<string, number>) => {
    const map = new Map<number, number>();
    for (const key in obj) map.set(+key, obj[key]);
    return map;
  };
  const dec = new FillValueDecoder(ab0, arities(profile.class_fields), arities(profile.tag6_fields));
  const builder: ExtraBuilder = {
    pool,
    glyphs: shared.charset,
    symbols: shared.symbols,
    view: new DataView(ab0.buffer, ab0.byteOffset, ab0.byteLength),
    base: ab0.byteOffset,
  };
  const decoded = new Map<number, EffectExtra[] | null>();   // slot -> retained ops
  for (let k = 0; k < targetList.length; k++) {
    if ((k & BAIL_DECODE_MASK) === 0) { bail(); onStep(progressBase + k, progressTotal); }
    const slot = targetList[k];
    const row = rows[slot];
    const sel = profile.selectors[String(row.selector)];
    if (!sel) { audit.parse_failures++; decoded.set(slot, null); continue; }
    const ops = reparseRow(dec, sel, row, audit);
    decoded.set(slot, ops && opsToExtras(builder, ops));
  }
  progressBase += targetList.length;

  // ---- E3: config classification by decoded content, never by ref position --
  interface ConfigInfo {
    slot: number; family: number;
    kind: EffectConfig['kind'];
    perSecond: number | null;
    windows: [number, number][] | null;
    shapeKind: 'point' | 'ring' | 'spiral' | 'other' | null;
    center: [number, number, number] | null;
    axis: [number, number, number] | null;
    radius: number | null; sweep: number | null;
    spreadYaw: number | null; spreadPitch: number | null;
    spiral: EffectConfig['spiral'];
    extra: EffectExtra[];
  }
  const configInfo = new Map<number, ConfigInfo | null>();
  const classifyConfig = (slot: number): ConfigInfo | null => {
    if (configInfo.has(slot)) return configInfo.get(slot)!;
    const ops = decoded.get(slot);
    if (!ops) { configInfo.set(slot, null); return null; }
    // whole-tree counts decide vec3/float presence; the burst int census is
    // top-level decoded generic ints ONLY (direct or pooled): counted
    // program varints and program scalar ops are framing, never a burst
    // configuration value
    let vec3Count = 0; let fixedLaneCount = 0; let floatCount = 0;
    for (const e of ops) {
      walkExtra(e, (n) => {
        if (n.kind === 'vec3') vec3Count++;
        else if (n.kind === 'float') floatCount++;
        else if (n.kind === 'fixed' && n.floats) { fixedLaneCount += n.floats.length; floatCount += n.floats.length; }
      });
    }
    const consumed = new Set<number>();   // indices into ops
    const windows: [number, number][] = [];
    const windowIndices: number[] = [];
    for (let i = 0; i < ops.length; i++) {
      const w = windowsOf(ops[i]);
      if (w) { windows.push(...w); windowIndices.push(i); }
    }
    const info: ConfigInfo = {
      slot, family: rows[slot].runtime,
      kind: 'unknown', perSecond: null, windows: null, shapeKind: null,
      center: null, axis: null, radius: null, sweep: null,
      spreadYaw: null, spreadPitch: null, spiral: null, extra: [],
    };
    const topInts: { value: number; i: number }[] = [];
    const topVec3: { v: [number, number, number]; i: number }[] = [];
    const topFloats: { value: number; i: number }[] = [];
    const topRates: { value: number; den: number; i: number }[] = [];
    for (let i = 0; i < ops.length; i++) {
      const e = ops[i];
      if (e.kind === 'int') topInts.push({ value: e.value, i });
      else if (e.kind === 'vec3') topVec3.push({ v: e.v, i });
      else if (e.kind === 'float') topFloats.push({ value: e.value, i });
      else if (e.kind === 'fixed' && e.floats) for (const value of e.floats) topFloats.push({ value, i });
      else if (e.kind === 'rate') topRates.push({ value: e.value, den: e.den, i });
    }
    if (topInts.length === 1 && topInts[0].value >= 0
      && !windows.length && vec3Count === 0 && fixedLaneCount === 0) {
      // exactly one non-negative top-level int, nothing window or shape typed
      info.kind = 'burst_continuous';
      info.perSecond = topInts[0].value;
      consumed.add(topInts[0].i);
    } else if (topInts.length >= 1 && windows.length) {
      info.kind = 'burst_windowed';
      // bind and consume the SAME selection: the first top-level int
      info.perSecond = topInts[0].value >= 0 ? topInts[0].value : null;
      info.windows = windows;
      for (const i of windowIndices) consumed.add(i);
      consumed.add(topInts[0].i);
    } else if (vec3Count >= 1 || floatCount >= 2) {
      info.kind = 'shape';
      if (topVec3.length) { info.center = topVec3[0].v; consumed.add(topVec3[0].i); }
      if (topVec3.length >= 2) { info.axis = topVec3[1].v; consumed.add(topVec3[1].i); }
      const fixedLanes = topFloats.filter((f) => ops[f.i].kind === 'fixed');
      if (topVec3.length >= 2 && topRates.length >= 2 && fixedLanes.length >= 2) {
        // spiral arrangement: two vectors, two rates, two fixed float lanes
        info.shapeKind = 'spiral';
        info.spiral = {
          axis: info.axis!,
          start_radius: fixedLanes[0].value, radius_rate: topRates[0].value,
          start_angle: fixedLanes[1].value, angle_rate: topRates[1].value,
        };
        consumed.add(fixedLanes[0].i); consumed.add(fixedLanes[1].i);
        consumed.add(topRates[0].i); consumed.add(topRates[1].i);
      } else {
        const sweepAt = topFloats.findIndex((f) => f.value >= 270 && f.value <= 450);
        const radiusAt = topFloats.findIndex((f, at) => at !== sweepAt && f.value > 0);
        if (sweepAt >= 0 && radiusAt >= 0) {
          // a positive radius paired with a roughly full-turn sweep
          info.shapeKind = 'ring';
          info.radius = topFloats[radiusAt].value;
          info.sweep = topFloats[sweepAt].value;
          consumed.add(topFloats[radiusAt].i); consumed.add(topFloats[sweepAt].i);
        } else if (topVec3.length >= 1
          && topFloats.every((f) => f.value >= 0 && f.value <= 180)) {
          // a leading position with small spread angles
          info.shapeKind = 'point';
          if (topFloats.length) { info.spreadYaw = topFloats[0].value; consumed.add(topFloats[0].i); }
          if (topFloats.length >= 2) { info.spreadPitch = topFloats[1].value; consumed.add(topFloats[1].i); }
        } else {
          info.shapeKind = 'other';   // renderer falls back to point emission
        }
      }
    }
    for (let i = 0; i < ops.length; i++) if (!consumed.has(i)) info.extra.push(ops[i]);
    configInfo.set(slot, info);
    return info;
  };

  // ---- E4: emitter/family acceptance (voting + exhaustive small families) ---
  interface EmitterEval {
    slot: number; family: number;
    pass: boolean; hasShape: boolean; hasImage: boolean;
  }
  const emitterEval = new Map<number, EmitterEval>();
  const families = new Map<number, number[]>();   // family runtime -> member slots (asc)
  let droppedCandidates = 0;
  for (const slot of [...emitterSlots].sort((a, b) => a - b)) {
    const ops = decoded.get(slot);
    if (!ops) { droppedCandidates++; continue; }   // re-decode failed: dropped in E2
    const row = rows[slot];
    let hasBurst = false; let hasShape = false;
    for (const [, ref] of row.r) {
      if (!isInt(ref) || ref < 0 || ref >= rows.length) continue;
      const info = classifyConfig(ref);
      if (!info) continue;
      if (info.kind === 'burst_continuous' || info.kind === 'burst_windowed') hasBurst = true;
      else if (info.kind === 'shape') hasShape = true;
    }
    let hasTiming = false; let hasImage = false;
    for (const e of ops) {
      if (e.kind === 'duration' || e.kind === 'rate') hasTiming = true;
      else if (e.kind === 'scalar' && e.tag === 0x02) hasImage = true;
    }
    const ev: EmitterEval = {
      slot, family: row.runtime,
      pass: hasBurst && hasTiming, hasShape, hasImage,
    };
    emitterEval.set(slot, ev);
    const list = families.get(ev.family);
    if (list) list.push(slot); else families.set(ev.family, [slot]);
  }
  const familyVia = new Map<number, 'vote' | 'exhaustive' | 'rejected'>();
  for (const family of [...families.keys()].sort((a, b) => a - b)) {
    const members = families.get(family)!;
    const voters = members.slice(0, Math.min(members.length, VOTER_CAP));
    let passing = 0; let withShape = 0; let withImage = 0;
    for (const slot of voters) {
      const ev = emitterEval.get(slot)!;
      if (ev.pass) passing++;
      if (ev.hasShape) withShape++;
      if (ev.hasImage) withImage++;
    }
    const burstFraction = voters.length ? passing / voters.length : 0;
    let via: 'vote' | 'exhaustive' | 'rejected';
    if (voters.length >= MIN_VOTERS && burstFraction >= ACCEPT_FRACTION) via = 'vote';
    else if (members.length < MIN_VOTERS && passing === members.length) via = 'exhaustive';
    else { via = 'rejected'; audit.rejected_children += members.length; }
    familyVia.set(family, via);
    // image/shape presence are voting features, never requirements: recall on
    // families whose layout only markers infer. Keyed by the family id as data.
    audit.families[String(family)] = {
      members: members.length, via,
      burst_fraction: burstFraction,
      origin_fraction: voters.length ? withShape / voters.length : 0,
      image_fraction: voters.length ? withImage / voters.length : 0,
    };
  }
  audit.rejected_children += droppedCandidates;

  // confirmed systems: at least one accepted child survives
  const accepted = (slot: number): boolean => {
    const ev = emitterEval.get(slot);
    return !!ev && familyVia.get(ev.family) !== 'rejected';
  };
  const confirmed: number[] = [];
  for (const slot of [...candidates.keys()].sort((a, b) => a - b)) {
    const { series } = candidates.get(slot)!;
    let any = false;
    for (const [, refs] of series) { if (refs.some(accepted)) { any = true; break; } }
    if (any) confirmed.push(slot);
  }

  // tick rate is derivable with or without confirmed systems
  const tickRate = deriveTickRate(decoded);

  if (!confirmed.length) {
    audit.error = candidates.size ? 'no effect systems confirmed' : 'no candidate effect systems';
    onStep(progressTotal, progressTotal);
    const doc = makeEmptyDoc(rows.length, null);
    doc.tick_rate = tickRate;
    doc.audit = audit;
    return doc;
  }

  // ---- E5: per-family role templates (order within tag type, voted) ---------
  interface RoleTemplate { fades: 'none' | 'two' | 'three'; confidence: 'vote' | 'order' }
  const roleTemplates = new Map<number, RoleTemplate>();
  for (const family of [...families.keys()].sort((a, b) => a - b)) {
    const via = familyVia.get(family)!;
    if (via === 'rejected') continue;
    const members = families.get(family)!;
    const voters = members.slice(0, Math.min(members.length, VOTER_CAP));
    // duration-count agreement: a same-size multiset across >= 90% of voters
    const counts = new Map<number, number>();
    const durLists: number[][] = [];
    for (const slot of voters) {
      const durs: number[] = [];
      for (const e of decoded.get(slot)!) if (e.kind === 'duration') durs.push(e.ticks);
      durLists.push(durs);
      counts.set(durs.length, (counts.get(durs.length) || 0) + 1);
    }
    let modeCount = -1; let modeVotes = 0;
    for (const [count, votes] of counts) {
      if (votes > modeVotes || (votes === modeVotes && count < modeCount)) { modeCount = count; modeVotes = votes; }
    }
    const agreed = voters.length > 0 && modeVotes / voters.length >= ROLE_FRACTION;
    let fades: RoleTemplate['fades'] = 'none';
    if (agreed && modeCount >= 3) fades = 'three';
    else if (agreed && modeCount === 2) fades = 'two';
    // demotion: fades that cannot fit inside the life span are mis-bound
    if (fades !== 'none') {
      let violations = 0;
      for (const durs of durLists) {
        if (!durs.length) continue;
        const life = durs[0];
        const fadeIn = fades === 'three' && durs.length >= 3 ? durs[1] : 0;
        const fadeOut = fades === 'three' ? (durs.length >= 3 ? durs[durs.length - 1] : 0)
          : (durs.length >= 2 ? durs[1] : 0);
        if (fadeIn + fadeOut > life) violations++;
      }
      if (violations / voters.length > FADE_DEMOTION) fades = 'none';
    }
    roleTemplates.set(family, { fades, confidence: via === 'vote' && agreed ? 'vote' : 'order' });
  }

  // ---- names, controllers, clips --------------------------------------------
  // Name rows carry an animatic string plus the op-0 scalar of their
  // controller (the anim-names.js mechanism); controllers of a system are
  // every row referencing the system slot through typed edges, direct refs,
  // series, or pool-interned refs. The pool-mediated sweep is mandatory: many
  // systems are reachable ONLY through interned pool constants.
  const namesByController = new Map<number, string[]>();
  for (let i = 0; i < rows.length; i++) {
    if ((i & BAIL_ROW_MASK) === 0) { bail(); onStep(progressBase + i, progressTotal); }
    const row = rows[i];
    let name: string | null = null;
    for (const [, , tag, value] of row.g) {
      let text: string | null = null;
      if (tag === 0x0e && typeof value === 'string') text = value;
      else if (tag === 0 && isInt(value)) text = shared.strings.poolString(value);
      if (text !== null && text.includes('animatic')) { name = text; break; }
    }
    if (name === null) continue;
    const controller = ownerOf(row);
    if (controller === null) continue;
    const list = namesByController.get(controller);
    if (list) { if (!list.includes(name)) list.push(name); } else namesByController.set(controller, [name]);
  }
  progressBase += rows.length;

  // every slot one row references: typed g-edges, depth-0 pool refs (through
  // the shared memoized walk), direct refs, series refs
  const confirmedSet = new Set(confirmed);
  const referencedOf = (row: FillRow, member: Set<number>): number[] | null => {
    let out: Set<number> | null = null;
    const add = (slot: number) => {
      if (slot !== row.slot && member.has(slot)) (out || (out = new Set())).add(slot);
    };
    for (const [, depth, tag, value] of row.g) {
      if (tag === 0x26 && isInt(value)) add(value);
      else if (tag === 0 && depth === 0 && isInt(value) && value >= 0 && value < pool.length) {
        for (const target of shared.poolRegistryRefs(value)) add(target);
      }
    }
    for (const [, target] of row.r) if (isInt(target)) add(target);
    for (const [, refs] of row.s) for (const target of refs) if (isInt(target)) add(target);
    return out ? [...(out as Set<number>)].sort((a, b) => a - b) : null;
  };
  // sweep 1: rows -> the confirmed systems they reference
  const systemsRefBy = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    if ((i & BAIL_ROW_MASK) === 0) { bail(); onStep(progressBase + i, progressTotal); }
    const hits = referencedOf(rows[i], confirmedSet);
    if (hits) systemsRefBy.set(rows[i].slot, hits);
  }
  progressBase += rows.length;
  const controllerSet = new Set(systemsRefBy.keys());
  // sweep 2: rows -> the controllers they reference
  const controllersRefBy = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    if ((i & BAIL_ROW_MASK) === 0) { bail(); onStep(progressBase + i, progressTotal); }
    const hits = referencedOf(rows[i], controllerSet);
    if (hits) controllersRefBy.set(rows[i].slot, hits);
  }
  progressBase += rows.length;
  const controllersOf = new Map<number, number[]>();   // system -> controllers asc
  for (const [slot, systems] of systemsRefBy) {
    for (const sys of systems) {
      const list = controllersOf.get(sys);
      if (list) list.push(slot); else controllersOf.set(sys, [slot]);
    }
  }
  for (const list of controllersOf.values()) list.sort((a, b) => a - b);

  // clip records + the depth-bounded fan-out-capped walk (anim-names.js)
  const clipOfRecord = new Map<number, number>();
  for (const row of rows) {
    for (const [, , tag, value] of row.g) {
      if (tag === 0x61 && isInt(value)) { clipOfRecord.set(row.slot, value); break; }
    }
  }
  const directTargets = (slot: number): number[] => {
    const row = rows[slot];
    const out = new Set<number>();
    for (const [, , tag, value] of row.g) {
      if (tag === 0x26 && isInt(value)) out.add(value);
      else if (tag === 0 && isInt(value) && value >= 0 && value < pool.length) {
        for (const target of shared.poolRegistryRefs(value)) out.add(target);
      }
    }
    for (const [, target] of row.r) if (isInt(target)) out.add(target);
    for (const [, targets2] of row.s) for (const target of targets2) if (isInt(target)) out.add(target);
    return [...out];
  };
  const clipsCache = new Map<number, Map<number, number>>();
  const clipsFrom = (slot: number, depth: number, active: Set<number>): Map<number, number> => {
    const direct = clipOfRecord.get(slot);
    if (direct !== undefined) return new Map([[direct, 0]]);
    if (depth <= 0 || active.has(slot) || slot < 0 || slot >= rows.length) return new Map();
    const cached = clipsCache.get(slot);
    if (cached) return cached;
    active.add(slot);
    const out = new Map<number, number>();
    for (const target of directTargets(slot)) {
      for (const [clip, hops] of clipsFrom(target, depth - 1, active)) {
        const total = hops + 1;
        const existing = out.get(clip);
        if (existing === undefined || total < existing) out.set(clip, total);
      }
    }
    active.delete(slot);
    clipsCache.set(slot, out);
    return out;
  };

  // ---- assemble configs + systems (ascending slot everywhere) ---------------
  const view = builder.view;
  const shippedConfigs = new Set<number>();
  const systemDocs: EffectSystem[] = [];
  let emitterTotal = 0;
  for (const sysSlot of confirmed) {
    const { row: sysRow, series } = candidates.get(sysSlot)!;
    const sysOps = decoded.get(sysSlot);
    const consumed = new Set<number>();
    let blend: 'add' | 'mix' = 'mix';
    let facing: 'screen' | 'other' = 'other';
    let loop = false;
    let cycleTicks: number | null = null;
    const seriesOps = new Set(series.map(([op]) => op));
    if (sysOps) {
      for (let i = 0; i < sysOps.length; i++) {
        const e = sysOps[i];
        if (e.kind === 'duration' && cycleTicks === null) { cycleTicks = e.ticks; consumed.add(i); }
        else if (e.kind === 'symbol' && e.name !== null) {
          // symbol strings are shipped data, matched as values only
          if (e.name.endsWith('additive')) { blend = 'add'; consumed.add(i); }
          else if (e.name.includes('screen')) { facing = 'screen'; consumed.add(i); }
          else if (e.name.includes('infinite')) { loop = true; consumed.add(i); }
        } else if (e.kind === 'series' && seriesOps.has(e.op)) consumed.add(i);
      }
    }
    // emitters in series order, accepted members only, deduplicated
    const emitters: EffectEmitter[] = [];
    const seen = new Set<number>();
    for (const [, refs] of series) {
      for (const ref of refs) {
        if (seen.has(ref) || !accepted(ref)) continue;
        seen.add(ref);
        emitters.push(buildEmitter(rows[ref], decoded.get(ref)!, sysSlot,
          roleTemplates.get(rows[ref].runtime) ?? { fades: 'none', confidence: 'order' },
          classifyConfig, shippedConfigs, shared.textureSlots));
      }
    }
    emitterTotal += emitters.length;
    // names: the controller join plus each controller row's own strings
    const controllers = controllersOf.get(sysSlot) || [];
    // NUL-separated dedupe keys (names are free text, separators must not
    // collide); the controller-join source outranks the row-string source
    const nameMap = new Map<string, { name: string; source: 'controller' | 'row'; controller: number }>();
    for (const controller of controllers) {
      for (const name of namesByController.get(controller) || []) {
        const key = `${name}\u0000${controller}`;
        nameMap.set(key, { name, source: 'controller', controller });
      }
      for (const event of shared.strings.directStrings(rows[controller])) {
        const key = `${event.text}\u0000${controller}`;
        if (!nameMap.has(key)) nameMap.set(key, { name: event.text, source: 'row', controller });
      }
    }
    const names = [...nameMap.values()].sort((a, b) => (a.name < b.name ? -1
      : a.name > b.name ? 1 : a.controller - b.controller));
    if (names.length) audit.named_systems++;
    // clips through the controllers; hub controllers contribute nothing
    const clipSet = new Set<number>();
    for (const controller of controllers) {
      const clips = clipsFrom(controller, WALK_DEPTH, new Set());
      if (!clips.size || clips.size > FANOUT_CAP) continue;
      for (const clip of clips.keys()) clipSet.add(clip);
    }
    const extra: EffectExtra[] = [];
    if (sysOps) for (let i = 0; i < sysOps.length; i++) if (!consumed.has(i)) extra.push(sysOps[i]);
    systemDocs.push({
      slot: sysSlot, blend, facing, loop, cycle_ticks: cycleTicks,
      emitters, names, controllers, clips: [...clipSet].sort((a, b) => a - b), extra,
    });
  }
  audit.systems = systemDocs.length;
  audit.emitters = emitterTotal;

  // A system "hangs" when its emitters' own spawn-shape origins sit, on the
  // median, below their attach point (negative local Z: the room-attachment
  // anchor below picks the owning occurrence's bounding-box top for these,
  // its base otherwise). Systems with no shape-classified emitter default to
  // grounded (their emitters have no local origin to vote hanging with).
  const hangingBySystem = new Map<number, boolean>();
  for (const sys of systemDocs) {
    const originZ: number[] = [];
    for (const emitter of sys.emitters) {
      if (emitter.shape == null) continue;
      const info = configInfo.get(emitter.shape);
      if (info && info.kind === 'shape' && info.center) originZ.push(info.center[2]);
    }
    const median = medianOf(originZ);
    hangingBySystem.set(sys.slot, median !== null && median < 0);
  }

  // configs record: every classified reference target of a shipped emitter
  const configs: Record<string, EffectConfig> = {};
  for (const slot of [...shippedConfigs].sort((a, b) => a - b)) {
    const info = configInfo.get(slot);
    if (!info) continue;
    const cfg = { slot: info.slot, family: info.family, kind: info.kind } as EffectConfig;
    if (info.kind === 'burst_continuous' || info.kind === 'burst_windowed') {
      cfg.per_second = info.perSecond;
      if (info.kind === 'burst_windowed') cfg.windows = info.windows;
    } else if (info.kind === 'shape') {
      cfg.shape_kind = info.shapeKind ?? 'other';
      cfg.center = info.center;
      cfg.axis = info.axis;
      cfg.radius = info.radius;
      cfg.sweep = info.sweep;
      cfg.spread_yaw = info.spreadYaw;
      cfg.spread_pitch = info.spreadPitch;
      cfg.spiral = info.spiral;
    }
    cfg.extra = info.extra;   // assigned last so the retained-extras key lands last
    configs[String(slot)] = cfg;
  }
  for (const kind of ['burst_continuous', 'burst_windowed', 'shape', 'unknown'] as const) {
    let count = 0;
    for (const key in configs) if (configs[key].kind === kind) count++;
    if (count) audit.config_kinds[kind] = count;
  }

  // ---- attachments (inverted ref maps, never per-occurrence walks) ----------
  const pairsCache = new Map<number, { system: number; controller: number | null }[]>();
  const pairsFor = (slot: number): { system: number; controller: number | null }[] => {
    let pairs = pairsCache.get(slot);
    if (pairs) return pairs;
    pairs = [];
    const seenPairs = new Set<string>();
    for (const system of systemsRefBy.get(slot) || []) {
      const key = `${system}\u0000`;
      if (!seenPairs.has(key)) { seenPairs.add(key); pairs.push({ system, controller: null }); }
    }
    for (const controller of controllersRefBy.get(slot) || []) {
      for (const system of systemsRefBy.get(controller) || []) {
        const key = `${system}\u0000${controller}`;
        if (!seenPairs.has(key)) { seenPairs.add(key); pairs.push({ system, controller }); }
      }
    }
    pairsCache.set(slot, pairs);
    return pairs;
  };
  const hasPairs = (slot: number) => systemsRefBy.has(slot) || controllersRefBy.has(slot);

  const roomAtt: WorldEffectsDoc['attachments']['rooms'] = [];
  const roomIds = [...shared.roomIds].sort((a, b) => a - b);
  for (let r = 0; r < roomIds.length; r++) {
    bail();
    onStep(progressBase + r, progressTotal);
    const roomId = roomIds[r];
    const { occurrences } = shared.occupancy(roomId);
    for (let index = 0; index < occurrences.length; index++) {
      const hit = occurrences[index];
      // the owning occurrence's native-unit model envelope: read once per
      // occurrence (bounds3f is itself memoized by owner slot), never per
      // attachment. An inverted-bounds throw on a malformed owner degrades to
      // "no envelope" like every other absence here, never fails the room.
      let bbox: number[] | null = null;
      try { bbox = shared.bounds3f(hit.resource); } catch { bbox = null; }
      // deterministic tie order: resource-derived pairs first; secondary pairs
      // only when they add a (system, controller) pair the occurrence lacks
      const emitted = new Set<string>();
      const emit = (slot: number | null, via: 'resource' | 'secondary') => {
        if (!isInt(slot) || !hasPairs(slot)) return;
        for (const { system, controller } of pairsFor(slot)) {
          const key = `${system}\u0000${controller ?? ''}`;
          if (emitted.has(key)) continue;
          emitted.add(key);
          roomAtt.push({
            room: roomId,
            cell: [hit.cell[0], hit.cell[1], hit.cell[2]],
            occurrence: index,
            resource: slot,
            rot: hit.rotationQuarters ?? 0,
            via, system, controller,
            anchor: roomSystemAnchor(bbox, hangingBySystem.get(system) === true),
          });
        }
      };
      emit(hit.resource, 'resource');
      emit(hit.secondary, 'secondary');
    }
  }
  progressBase += roomIds.length;
  roomAtt.sort((a, b) => a.room - b.room || a.occurrence - b.occurrence
    || a.system - b.system || (a.controller ?? -1) - (b.controller ?? -1));

  const actorAtt: WorldEffectsDoc['attachments']['actors'] = [];
  for (const [slot, actor] of [...shared.spawnActors].sort(([a], [b]) => a - b)) {
    if (!hasPairs(slot)) continue;
    for (const { system, controller } of pairsFor(slot)) {
      actorAtt.push({ actor: slot, label: actor.label, system, controller });
    }
  }
  actorAtt.sort((a, b) => a.actor - b.actor || a.system - b.system
    || (a.controller ?? -1) - (b.controller ?? -1));

  // owners: the generic superset every referencing row contributes; model
  // pages join on these registry slots at runtime
  const ownerAtt: WorldEffectsDoc['attachments']['owners'] = [];
  const ownerSlots = new Set<number>([...systemsRefBy.keys(), ...controllersRefBy.keys()]);
  for (const slot of [...ownerSlots].sort((a, b) => a - b)) {
    for (const { system, controller } of pairsFor(slot)) {
      ownerAtt.push({ owner: slot, system, controller });
    }
  }
  ownerAtt.sort((a, b) => a.owner - b.owner || a.system - b.system
    || (a.controller ?? -1) - (b.controller ?? -1));

  audit.attached_rooms = roomAtt.length;
  audit.attached_actors = actorAtt.length;
  onStep(progressTotal, progressTotal);

  return {
    format: WORLD_EFFECTS_FORMAT,
    tick_rate: tickRate,
    audit,
    configs,
    systems: systemDocs,
    attachments: { rooms: roomAtt, actors: actorAtt, owners: ownerAtt },
  };
}

// -------------------------------------------------------------- emitter roles

// One accepted emitter row -> its doc record. Roles bind by order within tag
// type over the row's own top-level decoded fields; the family template only
// decides whether fade roles exist. Ops not consumed by a role or a known
// payload are retained in `extra`; classified fields are never duplicated
// there.
function buildEmitter(
  row: FillRow, ops: EffectExtra[], ownerSlot: number,
  template: { fades: 'none' | 'two' | 'three'; confidence: 'vote' | 'order' },
  classifyConfig: (slot: number) => { kind: EffectConfig['kind'] } | null,
  shippedConfigs: Set<number>,
  textureSlots: Map<number, number[]>,
): EffectEmitter {
  const consumed = new Set<number>();
  const durations: { ticks: number; op: number; i: number }[] = [];
  const colors: { rgba: [number, number, number, number]; op: number; i: number }[] = [];
  const rates: { value: number; den: number; op: number; i: number }[] = [];
  const floats: { value: number; op: number; i: number }[] = [];
  const vec3s: { v: [number, number, number]; op: number; i: number }[] = [];
  let blend: 'add' | 'mix' | null = null;
  let sprite: EffectEmitter['sprite'] = null;
  for (let i = 0; i < ops.length; i++) {
    const e = ops[i];
    if (e.kind === 'duration') durations.push({ ticks: e.ticks, op: e.op, i });
    else if (e.kind === 'color') colors.push({ rgba: e.rgba, op: e.op, i });
    else if (e.kind === 'rate') rates.push({ value: e.value, den: e.den, op: e.op, i });
    else if (e.kind === 'float') floats.push({ value: e.value, op: e.op, i });
    else if (e.kind === 'fixed' && e.floats && e.floats.length === 1) floats.push({ value: e.floats[0], op: e.op, i });
    else if (e.kind === 'vec3') vec3s.push({ v: e.v, op: e.op, i });
    else if (e.kind === 'symbol' && e.name !== null && e.name.endsWith('additive')) {
      blend = 'add';   // the emitter's own blend override; other symbols stay data
      consumed.add(i);
    } else if (e.kind === 'scalar' && e.tag === 0x02 && sprite === null) {
      sprite = { material: e.value, images: textureSlots.get(e.value) ?? [] };
      consumed.add(i);
    } else if (e.kind === 'scalar' && e.tag === -85 && e.op === 0 && e.value === ownerSlot) {
      consumed.add(i);   // the op-0 owner backpointer (negated letter code), consumed by detection
    }
  }
  // burst/shape configs: the first reference target of each classified kind
  let burst: number | null = null;
  let shape: number | null = null;
  const refIndexByOp = new Map<number, number>();
  for (let i = 0; i < ops.length; i++) if (ops[i].kind === 'ref') refIndexByOp.set(ops[i].op, i);
  for (const [op, target] of row.r) {
    if (!isInt(target)) continue;
    const info = classifyConfig(target);
    if (!info) continue;
    shippedConfigs.add(target);
    if ((info.kind === 'burst_continuous' || info.kind === 'burst_windowed') && burst === null) {
      burst = target;
      const at = refIndexByOp.get(op);
      if (at !== undefined) consumed.add(at);
    } else if (info.kind === 'shape' && shape === null) {
      shape = target;
      const at = refIndexByOp.get(op);
      if (at !== undefined) consumed.add(at);
    }
  }
  // durations: life first, fades only when the family template voted them in
  const take = <T extends { i: number }>(entry: T | undefined): T | null => {
    if (!entry) return null;
    consumed.add(entry.i);
    return entry;
  };
  const life = take(durations[0]);
  let fadeIn: typeof life = null;
  let fadeOut: typeof life = null;
  if (template.fades === 'three' && durations.length >= 3) {
    fadeIn = take(durations[1]);
    fadeOut = take(durations[durations.length - 1]);
  } else if (template.fades === 'two' && durations.length >= 2) {
    fadeOut = take(durations[1]);
  }
  const color0 = take(colors[0]);
  const color1 = take(colors[1]) ?? color0;
  const speed = take(rates[0]);
  const angularSpeed = take(rates[1]);
  const rate = take(rates[2]);
  const scale0 = take(floats[0]);
  const scale1 = take(floats[1]);
  let direction: { v: [number, number, number]; op: number } | null = null;
  let acceleration: { v: [number, number, number]; op: number } | null = null;
  if (vec3s.length === 1) acceleration = take(vec3s[0]);
  else if (vec3s.length >= 2) {
    direction = take(vec3s[0]);
    acceleration = take(vec3s[vec3s.length - 1]);
  }
  const extra: EffectExtra[] = [];
  for (let i = 0; i < ops.length; i++) if (!consumed.has(i)) extra.push(ops[i]);
  return {
    slot: row.slot, family: row.runtime,
    burst, shape, sprite, blend,
    life: life && { ticks: life.ticks, op: life.op },
    fade_in: fadeIn && { ticks: fadeIn.ticks, op: fadeIn.op },
    fade_out: fadeOut && { ticks: fadeOut.ticks, op: fadeOut.op },
    color0: color0 && { rgba: color0.rgba, op: color0.op },
    color1: color1 && { rgba: color1.rgba, op: color1.op },
    scale0: scale0 && { value: scale0.value, op: scale0.op },
    scale1: scale1 && { value: scale1.value, op: scale1.op },
    speed: speed && { value: speed.value, den: speed.den, op: speed.op },
    angular_speed: angularSpeed && { value: angularSpeed.value, den: angularSpeed.den, op: angularSpeed.op },
    rate: rate && { value: rate.value, den: rate.den, op: rate.op },
    direction, acceleration,
    confidence: template.confidence,
    extra,
  };
}

// ----------------------------------------------------------------- tick rate

// Every decoded rate carries its own denominator; durations do not. The
// build's tick rate is the modal denominator across all decoded rates,
// guarded to the default when too few vote or no mode dominates.
function deriveTickRate(decoded: Map<number, EffectExtra[] | null>): WorldEffectsDoc['tick_rate'] {
  const votes = new Map<number, number>();
  let total = 0;
  for (const slot of [...decoded.keys()].sort((a, b) => a - b)) {
    const ops = decoded.get(slot);
    if (!ops) continue;
    for (const e of ops) {
      walkExtra(e, (n) => {
        if (n.kind === 'rate' && isInt(n.den) && n.den > 0) {
          total++;
          votes.set(n.den, (votes.get(n.den) || 0) + 1);
        }
      });
    }
  }
  let mode = -1; let modeVotes = 0;
  for (const [den, count] of votes) {
    if (count > modeVotes || (count === modeVotes && den < mode)) { mode = den; modeVotes = count; }
  }
  if (total >= MIN_VOTERS && mode > 0 && modeVotes / total >= ACCEPT_FRACTION) {
    return { value: mode, via: 'modal_denominator', votes: modeVotes };
  }
  return { value: TICK_DEN_DEFAULT, via: 'default', votes: total };
}
