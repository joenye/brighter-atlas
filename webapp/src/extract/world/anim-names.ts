// Animatic clip-name recovery over the replayed registry.
//
// The datatable's ~2,690 `*_animatic*` identifier strings ARE per-clip names,
// but no positional mapping exists and the 63-bit name-hash is uncracked
// (pipeline docs/anim_names.md). The join that works is structural: each name
// row carries the name string plus an op-0 UNSIGNED SCALAR (a raw registry
// slot number, invisible to typed-reference walks) pointing at an animatic
// CONTROLLER row; the controller's generic pool fields reference the 0x61
// clip-record rows, whose single edge is the AB1 clip ordinal:
//
//   name row -(op-0 scalar)→ controller -(pool refs, ≤2 hops)→
//     clip record -(0x61)→ ab1 clip
//
// Validated on the current build far above the 2026-07 spike's chance
// baselines (human/player-prefix names -> the human rig 490/514 strict,
// 514/514 containing it; variant bases single-rig 1,388/1,418). A name set
// spanning several rigs is a genuine multi-participant animatic (coop saws,
// fishing lines, thrown nets), flagged rather than dropped. Rows whose walk
// fans out past FANOUT_CAP clips ride a shared hub, not a name edge, and are
// dropped entirely.

import { PoolStrings, makePoolRegistryRefs } from './models.js';
import type { RegistryRow } from './graph.js';

export const ANIM_NAMES_FORMAT = 1;
const FANOUT_CAP = 8;
const WALK_DEPTH = 2;

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isNode = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface AnimNameSource {
  name: string;
  name_row: number;       // registry slot of the name record
  controller: number;     // the op-0 scalar target (animatic controller slot)
  hops: number;           // controller -> clip record reference distance (1 or 2)
  multi_participant?: boolean; // the name's clip set spans several rigs
  refs?: number;          // extra name rows carrying the same (clip, name) pair
}

export interface AnimNamesDoc {
  format: number;
  name_rows: number;          // rows carrying an animatic string
  resolved_rows: number;      // rows whose walk reached >=1 clip
  capped_rows: number;        // rows dropped by the fan-out cap
  names_attached: number;     // distinct names with >=1 clip
  clips_named: number;        // distinct clips with >=1 name
  clips: Record<string, { names: string[]; sources: AnimNameSource[] }>;
}

// rows: replay.js registry rows; pool: value-pool.js values; charsetGlyphs:
// dt.charset (decodes pool-interned strings); animDir: dt.animDir (rig ids
// for the multi-participant flag). `shared` optionally supplies the
// orchestrator's memoized PoolStrings / pool-ref walk (both pure of
// (pool, charset)); absent, local instances are built exactly as before.
export function extractAnimNames(
  rows: RegistryRow[], pool: any[], charsetGlyphs: ArrayLike<string>,
  animDir: { skel: number }[],
  shared: {
    strings?: PoolStrings | null;
    poolRegistryRefs?: ((index: number) => number[]) | null;
  } = {},
): AnimNamesDoc {
  const strings = shared.strings ?? new PoolStrings(pool, charsetGlyphs);

  // clip records: slot -> ab1 clip (each carries exactly one 0x61 edge)
  const clipOfRecord = new Map<number, number>();
  for (const row of rows) {
    for (const [, , tag, value] of row.g) {
      if (tag === 0x61 && isInt(value)) { clipOfRecord.set(row.slot, value); break; }
    }
  }

  // registry refs reachable from one pool value (through reference chains):
  // the shared memoized walk (models.js makePoolRegistryRefs)
  const poolRegistryRefs = shared.poolRegistryRefs ?? makePoolRegistryRefs(pool);

  // every registry row one row references (typed, pooled, direct, series)
  const directTargets = (slot: number): number[] => {
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
    return [...out];
  };

  // depth-bounded clip collection with per-clip hop distance
  const clipsCache = new Map<number, Map<number, number>>(); // slot -> clip -> hops
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

  // ---- name rows -> clips ---------------------------------------------------
  let nameRows = 0;
  let resolvedRows = 0;
  let cappedRows = 0;
  const byClip = new Map<number, Map<string, AnimNameSource>>();
  const nameHasClip = new Set<string>();
  for (const row of rows) {
    let name: string | null = null;
    for (const [, , tag, value] of row.g) {
      let text: string | null = null;
      if (tag === 0x0e && typeof value === 'string') text = value;
      else if (tag === 0 && isInt(value)) text = strings.poolString(value);
      if (text !== null && text.includes('animatic')) { name = text; break; }
    }
    if (name === null) continue;
    nameRows++;
    let controller: number | null = null;
    for (const [op, kind, value] of row.v || []) {
      if (op === 0 && kind === 'U' && isInt(value) && value >= 0 && value < rows.length) {
        controller = value;
        break;
      }
    }
    if (controller === null) continue;
    const clips = clipsFrom(controller, WALK_DEPTH, new Set());
    if (!clips.size) continue;
    if (clips.size > FANOUT_CAP) { cappedRows++; continue; }
    resolvedRows++;
    nameHasClip.add(name);
    const rigs = new Set([...clips.keys()].map((clip) => animDir[clip]?.skel));
    const multiParticipant = rigs.size > 1;
    for (const [clip, hops] of clips) {
      let names = byClip.get(clip);
      if (!names) byClip.set(clip, names = new Map());
      const existing = names.get(name);
      if (existing !== undefined) {
        existing.refs = (existing.refs || 1) + 1;
        if (hops < existing.hops) { existing.hops = hops; existing.controller = controller; existing.name_row = row.slot; }
        continue;
      }
      const source: AnimNameSource = { name, name_row: row.slot, controller, hops };
      if (multiParticipant) source.multi_participant = true;
      names.set(name, source);
    }
  }

  const clips: AnimNamesDoc['clips'] = {};
  for (const clip of [...byClip.keys()].sort((a, b) => a - b)) {
    const sources = [...byClip.get(clip)!.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    clips[String(clip)] = { names: sources.map((source) => source.name), sources };
  }
  return {
    format: ANIM_NAMES_FORMAT,
    name_rows: nameRows,
    resolved_rows: resolvedRows,
    capped_rows: cappedRows,
    names_attached: nameHasClip.size,
    clips_named: byClip.size,
    clips,
  };
}
