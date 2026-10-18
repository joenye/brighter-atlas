// How actors move: each actor's movement set (its walking speeds and the clips its walk plays), found by shape
// over the replayed registry, for the room view's walk test (viewers/world/walk.ts) and src/movement/.
//
//   actor record -> a movement set: a record naming a mover profile and a list of 23 locomotions
//   mover profile: its size in tiles and a list of 23 movement kinds (one per kind of step: flat, slopes,
//                  climbs, ledges ...), each a record of the step's timing
//   locomotion: per kind of step, the clips it plays: a turn, then four moves by the angle between the
//               actor's facing and its travel (forward, backward and the two sides), each with its clip and how
//               many steps one cycle of the clip covers
//
// The player has movement sets of its own: the ones whose profile carries a variant number.

import type { FillRow } from './replay.js';

export const MOVERS_FORMAT = 1;
export const KIND_COUNT = 23;

export interface MoverKindDoc { ticks: number; still: number; levels: number; turnFirst: boolean; cost: number }
export interface MoveClipDoc { clip: number; steps: number; tiles: number }
export interface LocomotionDoc { turn: number | null; move: (MoveClipDoc | null)[] }
export interface MoverProfileDoc { size: number; kinds: (number | null)[]; variant?: number }
export interface MoverSetDoc { profile: number; locomotions: (number | null)[] }
export interface MoverActorDoc {
  profile: number; set: number | null;
  /** it wanders about its spawn tile (+- radius tiles), walking straight at a random tile now and then */
  wanders?: { radius: number };
  /** an authored route: tiles in order (room record, x, y, layer) */
  route?: [number, number, number, number][];
}
export interface MoversDoc {
  format: number;
  kinds: Record<string, MoverKindDoc>;
  profiles: Record<string, MoverProfileDoc>;
  locomotions: Record<string, LocomotionDoc>;
  sets: Record<string, MoverSetDoc>;
  /** actor record -> its mover profile, and its movement set where it has one (the clips its walk plays) */
  actors: Record<string, MoverActorDoc>;
  /** the player's movement sets, by the variant of their profile (the first is the everyday one) */
  player: number[];
}

type Field = { op: number; kind: string; node?: any; value?: any };
const isInt = (v: unknown): v is number => Number.isInteger(v);

export function extractMovers(
  rows: FillRow[], pool: any[], decode: (slot: number) => Field[] | null,
  clipOfRecord: Map<number, number>, actorRecords: Iterable<number>, symbols: string[] = [],
): MoversDoc | null {
  const R = (n: any) => { for (let k = 0; n?.tag === 0 && k < 64; k++) n = pool[n.value]; return n; };
  const cache = new Map<number, Map<number, any>>();
  const fields = (slot: number) => {
    let m = cache.get(slot);
    if (!m) { m = new Map(); for (const f of decode(slot) ?? []) {
      if (f.kind === 'G') m.set(f.op, R(f.node));
      else if (f.kind === 'U' && isInt(f.value)) m.set(f.op, { tag: -1, value: f.value });   // (a plain number)
    } cache.set(slot, m); }
    return m;
  };
  const ref = (n: any): number | null => n?.tag === 0x26 && isInt(n.value) ? n.value : null;
  const list = (n: any): any[] | null => (n?.tag === 0x20 || n?.tag === 0x2c) && Array.isArray(n.values) ? n.values.map(R) : null;
  // (a 64-bit value comes as its two 32-bit halves read as floats: their bits are the number)
  const f2u = (x: number) => { const v = new DataView(new ArrayBuffer(4)); v.setFloat32(0, x); return v.getUint32(0); };
  const num = (n: any): number | undefined => {
    if (!n) return undefined;
    const v = n.value ?? n.values;
    if (n.tag === 0x28 && Array.isArray(v) && v.length === 2) return f2u(v[0]) * 2 ** 32 + f2u(v[1]);
    if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'number') return v[0];
    return typeof v === 'number' ? v : undefined;
  };
  const bool = (n: any) => n?.tag === 0x0c ? true : n?.tag === 0x0d ? false : undefined;

  // a mover profile: a size (1..3) and a list of 23 kind references
  const profiles = new Map<number, MoverProfileDoc | null>();
  const profileOf = (slot: number): MoverProfileDoc | null => {
    if (profiles.has(slot)) return profiles.get(slot)!;
    const fs = fields(slot), size = num(fs.get(1)), kinds = list(fs.get(2))?.map(ref) ?? null;
    let p: MoverProfileDoc | null = null;
    if (kinds && kinds.length === KIND_COUNT && kinds.some(k => k != null) && isInt(size) && size >= 1 && size <= 3) {
      const variant = num(fs.get(3));
      p = { size, kinds, ...(isInt(variant) ? { variant } : {}) };
    }
    profiles.set(slot, p);
    return p;
  };
  // a movement set: a profile and a list of 23 locomotions (absent ones are a placeholder value)
  const sets = new Map<number, MoverSetDoc | null>();
  const setOf = (slot: number): MoverSetDoc | null => {
    if (sets.has(slot)) return sets.get(slot)!;
    const fs = fields(slot), profile = ref(fs.get(1)), locos = list(fs.get(3));
    const s = profile != null && profileOf(profile) && locos?.length === KIND_COUNT ? { profile, locomotions: locos.map(ref) } : null;
    sets.set(slot, s);
    return s;
  };
  // an actor names a movement set, or (some creatures) its mover profile alone
  const actors: Record<string, MoverActorDoc> = {};
  for (const actor of new Set(actorRecords)) {
    if (!isInt(actor) || !rows[actor]) continue;
    let found: MoverActorDoc | null = null;
    // (a set named directly or in a short list; a profile named directly)
    for (const n of fields(actor).values()) {
      for (const target of [ref(n), ...(list(n)?.slice(0, 16).map(ref) ?? [])]) {
        if (target == null || !rows[target] || target === actor) continue;
        const s = setOf(target);
        if (s && (!found?.set)) found = { profile: s.profile, set: target };
        else if (!found && profileOf(target)) found = { profile: target, set: null };
      }
      if (found?.set) break;
    }
    if (found) actors[String(actor)] = found;
  }
  if (!Object.keys(actors).length) return null;
  // Wandering: every actor of a class any of whose records starts in a wandering or fighting state (a symbol
  // field) wanders; its radius is the whole number three fields on (10 when not found). Routes: a list of
  // (room, x, y, layer) positions.
  const STATES = new Set(['$wandering', '$fighting']);
  const stateOp = (slot: number) => { for (const [op, n] of fields(slot)) if (n?.tag === 0x0f && STATES.has(symbols[n.value])) return op; return -1; };
  const wanderClasses = new Set<number>();
  for (const a of Object.keys(actors)) if (stateOp(+a) >= 0) wanderClasses.add(rows[+a].runtime);
  for (const [a, doc] of Object.entries(actors)) {
    const fs = fields(+a);
    if (wanderClasses.has(rows[+a].runtime)) {
      let op = stateOp(+a);
      if (op < 0) for (const other of Object.keys(actors)) if (rows[+other].runtime === rows[+a].runtime && (op = stateOp(+other)) >= 0) break;
      const r = num(fs.get(op + 3));
      doc.wanders = { radius: isInt(r) && r > 0 && r < 64 ? r : 10 };
    }
    for (const n of fs.values()) {
      const l = list(n);
      if (!l?.length) continue;
      const tiles = l.map(t => list(t) ?? (Array.isArray(t?.fields) ? t.fields.map(R) : null));
      if (tiles.every(t => t?.length === 4 && ref(t[0]) != null && t.slice(1).every((v: any) => isInt(num(v))))) {
        doc.route = tiles.map(t => [ref(t![0])!, num(t![1])!, num(t![2])!, num(t![3])!]);
        break;
      }
    }
  }
  // the player's profiles (profiles carrying a variant: one record of each class is tried, then every record of
  // a class whose first is a profile), then the sets naming them
  const firstOfClass = new Map<number, number>();
  for (const row of rows) if (row && !firstOfClass.has(row.runtime)) firstOfClass.set(row.runtime, row.slot);
  const profileClasses = new Set<number>();
  for (const [runtime, slot] of firstOfClass) if (profileOf(slot)) profileClasses.add(runtime);
  for (const row of rows) if (row && profileClasses.has(row.runtime)) profileOf(row.slot);
  const playerProfiles = new Map<number, number>();
  for (const [slot, p] of profiles) if (p?.variant != null) playerProfiles.set(slot, p.variant);
  const player: [number, number][] = [];
  if (playerProfiles.size) for (const row of rows) {
    if (!row) continue;
    for (const [op, depth, tag, value] of row.g) {
      if (depth !== 0 || op < 1) continue;
      if (op > 1) break;
      const target = tag === 0x26 ? value : tag === 0 && isInt(value) ? ref(R(pool[value])) : null;
      if (target != null && playerProfiles.has(target as number) && setOf(row.slot)) player.push([playerProfiles.get(target as number)!, row.slot]);
      break;
    }
  }
  player.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // the kinds and locomotions the sets name
  const kinds: Record<string, MoverKindDoc> = {}, locomotions: Record<string, LocomotionDoc> = {};
  const moveClip = (slot: number | null): MoveClipDoc | null => {
    if (slot == null || !rows[slot]) return null;
    const fs = fields(slot), record = ref(fs.get(35)), clip = record != null ? clipOfRecord.get(record) : undefined;
    const steps = num(fs.get(37)), tiles = num(fs.get(38));
    return clip !== undefined && isInt(steps) && steps > 0 ? { clip, steps, tiles: typeof tiles === 'number' ? tiles : 1 } : null;
  };
  const turnClip = (slot: number | null): number | null => {
    if (slot == null || !rows[slot]) return null;
    for (const n of fields(slot).values()) { const r = ref(n), c = r != null ? clipOfRecord.get(r) : undefined; if (c !== undefined) return c; }
    return null;
  };
  const outSets: Record<string, MoverSetDoc> = {}, outProfiles: Record<string, MoverProfileDoc> = {};
  const usedProfiles = new Set<number>(Object.values(actors).map(a => a.profile));
  for (const slot of new Set<number>([...Object.values(actors).flatMap(a => a.set != null ? [a.set] : []), ...player.map(p => p[1])])) {
    const s = sets.get(slot)!;
    outSets[String(slot)] = s;
    usedProfiles.add(s.profile);
    for (const l of s.locomotions) if (l != null && !(l in locomotions)) {
      // (a locomotion, or (creatures) the one move it plays)
      const fs = fields(l), direct = moveClip(l);
      locomotions[String(l)] = direct ? { turn: null, move: [direct, null, null, null] }
        : { turn: turnClip(ref(fs.get(3))), move: [4, 5, 6, 7].map(op => moveClip(ref(fs.get(op)))) };
    }
  }
  for (const slot of usedProfiles) {
    const p = profiles.get(slot)!;
    outProfiles[String(slot)] = p;
    for (const k of p.kinds) if (k != null && !(k in kinds)) {
      const fs = fields(k);
      kinds[String(k)] = { ticks: num(fs.get(1)) ?? 0, still: num(fs.get(3)) ?? 0, levels: num(fs.get(4)) ?? 0, turnFirst: bool(fs.get(6)) ?? false, cost: num(fs.get(8)) ?? 0 };
    }
  }
  return { format: MOVERS_FORMAT, kinds, profiles: outProfiles, locomotions, sets: outSets, actors, player: player.map(p => p[1]) };
}
