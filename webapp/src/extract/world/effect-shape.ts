// Where particle effects keep their values, read from the user's own bundles
// by shape (the same rule on every build). The results take the same form as
// the optional per-build decode data (produced offline, purely from analysis
// of the game's own files, never by inspecting or modifying a running game
// process or its memory), so every effect reader works unchanged.
//
//   emitters        records listed in their owner's series that hold one of
//                   the four repeated-value markers ($speed0, $color0,
//                   $scale0, $acceleration0), one family per record type
//   emitter fields  each marker names its end value's field; the start value
//                   sits just before it or, for the speed and colour of the
//                   larger emitter records, among the record's own trailing
//                   fields; rotation and spin lie between the speed and colour
//                   ends; value kinds must agree on every record of a family,
//                   and a family without some marker borrows the others' ends
//   empty fields    a property the game computes has an empty field (tag 1) on
//                   every record of its instance, so it stays unresolved
//   facing          the field holding a facing mode symbol and the one
//                   direction vector ahead of the property fields
//   windows         configs of a rate, a list of start/end durations and a
//                   repeat period or $none
//   wave bursts     configs of [a water style, a point, a count, a threshold,
//                   the translation-only flag, further flags]
//   motion          controllers (the type subtree with a stable id) whose one
//                   field references a water style
//   point sources   literal positions of the two plain point shapes
import { typesWithId, type TypeTable } from '../datatable.js';
import type { ConstructorRecord, FillRow } from './replay.js';
import type { EffectExtra } from './effects.js';
import type { EffectFieldBinding, EffectFieldData } from './effect-fields.js';
import { validEffectFields } from './effect-fields.js';
import { validEffectFacings, type EffectFacingBinding } from './effect-facing.js';
import { validEffectWindows, type EffectWindowBinding } from './effect-windows.js';
import { validEffectWaves, type EffectWaveData } from './effect-waves.js';
import { validEffectOrigins, type EffectOriginBinding } from './effect-origins.js';
import type { WaterDecodeData } from './water-materials.js';
import type { PlacementDecodeData } from './placement.js';

/** Ticks between the water height samples of a wave burst. */
export const EFFECT_WAVE_STEP = 12;
/** Controllers: the record type whose subtree holds them. */
const CONTROLLER_TYPE = '34f28ba2595bcb34';
/** Constructor values holding a record's instance and its type. */
const INSTANCE_VALUE = 1, TYPE_VALUE = 2;

export interface EffectRegistry {
  rows: FillRow[]; objects: ConstructorRecord[];
  symbols: string[]; types: TypeTable;
  extras: (slot: number) => EffectExtra[] | null;
}
export type EffectBindings = Pick<PlacementDecodeData,
  'effectFields' | 'effectFacings' | 'effectWindows' | 'effectWaves' | 'effectMotion' | 'effectOrigins'>;

const EMPTY = 'empty';
const MARKERS = { speed: '$speed0', color: '$color0', scale: '$scale0', acceleration: '$acceleration0' } as const;
const FACING = new Set(['$screen', '$direction_single', '$direction_plus', '$direction_screen', '$velocity_single', '$velocity_screen']
  .map((s) => `symbol:${s}`));
const FLAGS = new Set(['other:12', 'other:13']);

/** One value's kind: class, symbol and tag spelled out. */
function kindOf(e: EffectExtra): string {
  switch (e.kind) {
    case 'typed': return `typed:${e.class}`;
    case 'symbol': return `symbol:${e.name}`;
    case 'other': return e.tag === 1 ? EMPTY : `other:${e.tag}`;
    case 'scalar': return `scalar:${e.tag}`;
    case 'list': return `list:${e.tag}`;
    case 'fixed': return e.floats?.length === 1 ? 'float' : 'fixed';
    default: return e.kind;
  }
}

interface Row { slot: number; instance: number; ops: EffectExtra[]; kinds: string[] }
interface Family { runtime: number; rows: Row[]; census: Set<string>[] }

function family(reg: EffectRegistry, runtime: number, slots: number[]): Family | null {
  const rows: Row[] = [];
  for (const slot of slots) {
    const ops = reg.extras(slot);
    const instance = reg.objects[slot]?.values?.[INSTANCE_VALUE];
    if (!ops || !Number.isInteger(instance)) continue;
    rows.push({ slot, instance: instance!, ops, kinds: ops.map(kindOf) });
  }
  if (!rows.length || rows.some((r) => r.kinds.length !== rows[0].kinds.length)) return null;
  const census = rows[0].kinds.map(() => new Set<string>());
  for (const r of rows) r.kinds.forEach((k, op) => { if (k !== EMPTY) census[op].add(k); });
  return { runtime, rows, census };
}

// ------------------------------------------------------------ value classes

interface Classes { range: number | null; rate: number | null; vector: number | null; colour: number | null }

/** Value classes by their fields: a range holds two scalars, a rate a
 *  sample and a duration, a vector three samples and a colour four. */
function valueClasses(families: Family[]): Classes | null {
  const shapes = new Map<number, Set<string>>();
  const walk = (e: EffectExtra) => {
    if (e.kind === 'typed') {
      let set = shapes.get(e.class);
      if (!set) shapes.set(e.class, set = new Set());
      set.add(e.fields.map(kindOf).join(','));
      e.fields.forEach(walk);
    } else if (e.kind === 'list') e.values.forEach(walk);
  };
  for (const f of families) for (const r of f.rows) r.ops.forEach(walk);
  const all = (cls: number, test: (parts: string[]) => boolean) => [...shapes.get(cls)!].every((s) => test(s.split(',')));
  const one = (found: number[]) => (found.length === 1 ? found[0] : found.length ? undefined : null);
  const range = one([...shapes.keys()].filter((c) => all(c, (p) => p.length === 2 && p.every((k) => k === 'float'))));
  if (range === undefined) return null;
  const sample = (k: string) => k === 'float' || (range !== null && k === `typed:${range}`);
  const others = [...shapes.keys()].filter((c) => c !== range);
  const rate = one(others.filter((c) => all(c, (p) => p.length === 2 && sample(p[0]) && p[1] === 'duration')));
  const vector = one(others.filter((c) => all(c, (p) => p.length === 3 && p.every(sample))));
  const colour = one(others.filter((c) => all(c, (p) => p.length === 4 && p.every(sample))));
  if (rate === undefined || vector === undefined || colour === undefined) return null;
  return { range, rate, vector, colour };
}

// ------------------------------------------------------------ emitter layout

type Role = 'speed0' | 'speed1' | 'rotation' | 'angularSpeed' | 'color0' | 'color1'
  | 'scale0' | 'scale1' | 'acceleration0' | 'acceleration1';
type Layout = Record<Role, number | null>;
type Ends = [number, number, number, number];   // speed, colour, scale and acceleration ends

function kindSets(c: Classes) {
  const typed = (cls: number | null) => (cls === null ? [] : [`typed:${cls}`]);
  return {
    rate: new Set(['rate', ...typed(c.rate)]),
    scalar: new Set(['float', ...typed(c.range)]),
    vector: new Set(['vec3', ...typed(c.vector)]),
    colour: new Set(['color', ...typed(c.colour)]),
  };
}

/** A family's property fields from its end markers (or borrowed ends). */
function propertyLayout(census: Set<string>[], c: Classes, ends: Ends): Layout | null {
  const k = kindSets(c);
  const fits = (op: number, allowed: Set<string>, marker?: string) =>
    op >= 0 && op < census.length && [...census[op]].every((x) => allowed.has(x) || x === marker);
  const solid = (op: number, allowed: Set<string>) => fits(op, allowed) && census[op].size > 0;
  const [s1, c1, sc1, a1] = ends;
  if (!(s1 < c1 && c1 < sc1 - 1 && sc1 < a1 - 1)) return null;
  if (!fits(s1, k.rate, `symbol:${MARKERS.speed}`) || !fits(c1, k.colour, `symbol:${MARKERS.color}`)
    || !fits(sc1, k.scalar, `symbol:${MARKERS.scale}`) || !fits(a1, k.vector, `symbol:${MARKERS.acceleration}`)
    || !fits(sc1 - 1, k.scalar) || !fits(a1 - 1, k.vector)) return null;
  const trailing = (allowed: Set<string>) => {
    const found = census.map((_, op) => op).filter((op) => op > a1 && solid(op, allowed));
    return found.length ? found[found.length - 1] : null;
  };
  const color0 = solid(c1 - 1, k.colour) ? c1 - 1 : trailing(k.colour);
  const speed0 = solid(s1 - 1, k.rate) ? s1 - 1 : trailing(k.rate);
  const between = census.map((_, op) => op).filter((op) => op > s1 && op < c1 && op !== color0 && census[op].size);
  const rotation = between.filter((op) => solid(op, k.scalar)), angular = between.filter((op) => solid(op, k.rate));
  if (rotation.length > 1 || angular.length > 1 || rotation.length + angular.length !== between.length) return null;
  return {
    speed0, speed1: s1, rotation: rotation[0] ?? null, angularSpeed: angular[0] ?? null, color0, color1: c1,
    scale0: sc1 - 1, scale1: sc1, acceleration0: a1 - 1, acceleration1: a1,
  };
}

function ownEnds(census: Set<string>[]): (number | null)[] {
  return Object.values(MARKERS).map((m) => {
    const at = census.map((s, op) => (s.has(`symbol:${m}`) ? op : -1)).filter((op) => op >= 0);
    return at.length === 1 ? at[0] : at.length ? -1 : null;
  });
}

/** Each family's layout; a family missing a marker borrows the most common
 *  ends of the others that its own fields agree with. */
function emitterLayouts(families: Family[], c: Classes): Map<number, Layout> {
  const out = new Map<number, Layout>();
  const votes = new Map<string, number>();
  const missing: Family[] = [];
  for (const f of families) {
    const ends = ownEnds(f.census);
    const layout = ends.every((e) => e !== null && e >= 0) ? propertyLayout(f.census, c, ends as Ends) : null;
    if (layout) {
      out.set(f.runtime, layout);
      const key = ends.join(',');
      votes.set(key, (votes.get(key) ?? 0) + 1);
    } else if (!ends.includes(-1)) missing.push(f);
  }
  const ranked = [...votes].sort((a, b) => b[1] - a[1]).map(([key]) => key.split(',').map(Number) as Ends);
  for (const f of missing) {
    const own = ownEnds(f.census);
    for (const ends of ranked) {
      if (own.some((e, i) => e !== null && e !== ends[i])) continue;
      const layout = propertyLayout(f.census, c, ends);
      if (layout) { out.set(f.runtime, layout); break; }
    }
  }
  return out;
}

/** Per instance: its family's field, or null where every one of its records
 *  leaves the field empty. Instances spread over families must agree. */
function byInstance<T>(families: Family[], bind: (f: Family, rows: Row[]) => T | null): Map<number, T> {
  const out = new Map<number, T | null>();
  for (const f of families) {
    const groups = new Map<number, Row[]>();
    for (const r of f.rows) {
      const list = groups.get(r.instance);
      if (list) list.push(r); else groups.set(r.instance, [r]);
    }
    for (const [instance, rows] of groups) {
      const b = bind(f, rows);
      if (out.has(instance) && JSON.stringify(out.get(instance)) !== JSON.stringify(b)) out.set(instance, null);
      else if (!out.has(instance)) out.set(instance, b);
    }
  }
  return new Map([...out].filter(([instance, b]) => b !== null && instance < 65536) as [number, T][]);
}
const filled = (rows: Row[], op: number | null) => (op !== null && rows.some((r) => r.kinds[op] !== EMPTY) ? op : null);

// ------------------------------------------------------------ registry scans

function slotsByRuntime(rows: FillRow[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const row of rows) {
    const list = out.get(row.runtime);
    if (list) list.push(row.slot); else out.set(row.runtime, [row.slot]);
  }
  return out;
}

/** Runtimes of the emitter-like records: members of an owner's series that
 *  point back at the owner (op 0) and reference a config of their own. */
function seriesMemberRuntimes(rows: FillRow[]): Set<number> {
  const ownerOf = (row: FillRow | undefined) => row?.v.find(([op, kind]) => op === 0 && kind === 'U')?.[2];
  const out = new Set<number>();
  for (const row of rows) {
    for (const [, refs] of row.s) {
      if (!refs.length || !refs.every((ref) => ownerOf(rows[ref]) === row.slot && rows[ref].r.length > 0)) continue;
      for (const ref of refs) out.add(rows[ref].runtime);
    }
  }
  return out;
}

// ------------------------------------------------------------ configs

/** Windows: a rate, the start/end duration ranges and a period or $none. */
function windowBindings(configs: Family[], none: number): EffectWindowBinding[] {
  const out: EffectWindowBinding[] = [];
  for (const f of configs) {
    if (f.census.length !== 4 || ![...f.census[0]].every((k) => k.startsWith('scalar:'))) continue;
    const ops = [1, 2, 3];
    const role = (test: (k: string) => boolean) => ops.filter((op) => f.census[op].size && [...f.census[op]].every(test));
    const rate = role((k) => k === 'int');
    const windows = role((k) => (k.startsWith('list:') && k !== 'list:-78') || k.startsWith('typed:'));
    const period = role((k) => k === 'duration' || k === 'symbol:$none');
    if (rate.length !== 1 || windows.length !== 1 || period.length !== 1) continue;
    // every window: a start and an end duration, all of one class
    const range = new Set<number>();
    const window = (e: EffectExtra): boolean => e.kind === 'list' ? e.values.every(window)
      : e.kind === 'typed' && e.fields.length === 2 && e.fields.every((x) => x.kind === 'duration') && !!range.add(e.class);
    if (!f.rows.every((r) => window(r.ops[windows[0]])) || range.size !== 1) continue;
    for (const instance of new Set(f.rows.map((r) => r.instance))) {
      out.push({ instance, rate: rate[0], windows: windows[0], period: period[0], rangeClass: [...range][0], noneSymbol: none });
    }
  }
  return out;
}

/** Wave bursts: a reference to a water style, then its point, count,
 *  threshold and translation-only flag, then only further flags. */
function waveBindings(reg: EffectRegistry, configs: Family[], styleRuntime: number, water: WaterDecodeData): EffectWaveData['bindings'] {
  const out: EffectWaveData['bindings'] = [];
  const only = (op: number, kinds: Set<string> | string) => {
    const set = typeof kinds === 'string' ? new Set([kinds]) : kinds;
    return (f: Family) => f.census[op]?.size > 0 && [...f.census[op]].every((k) => set.has(k));
  };
  for (const f of configs) {
    const refs = f.census.map((_, op) => op).filter((op) => f.census[op].has('ref') && f.rows.every((r) => {
      const e = r.ops[op];
      return e.kind === 'ref' && reg.rows[e.slot]?.runtime === styleRuntime;
    }));
    if (refs.length !== 1) continue;
    const w = refs[0], n = f.census.length;
    if (!(only(w + 1, 'other:24')(f) && only(w + 2, 'int')(f) && only(w + 3, 'float')(f) && only(w + 4, FLAGS)(f))) continue;
    if ([...Array(n - w - 5)].some((_, i) => !only(w + 5 + i, FLAGS)(f))) continue;
    if ([...Array(w - 1)].some((_, i) => !only(1 + i, 'int')(f))) continue;
    const { amplitude, frequency, rate } = water.styleFields;
    for (const instance of new Set(f.rows.map((r) => r.instance))) {
      out.push({ instance, water: w, point: w + 1, count: w + 2, threshold: w + 3, translation: w + 4,
        waterFields: { amplitude: [...amplitude], frequency: [...frequency], rate: [...rate] } });
    }
  }
  return out;
}

/** Plain point sources: every field literal but the one that stays empty.
 *  Two record shapes: [flag, position, an empty field, two sample ranges,
 *  axis, yaw and pitch bounds] and [position, an empty field, axis, yaw and
 *  pitch bounds]. */
function pointOrigins(configs: Family[], range: number): EffectOriginBinding[] {
  const samples = new Set(['float', `typed:${range}`]);
  const shapes: { kinds: (Set<string> | null)[]; bind: (instance: number) => EffectOriginBinding }[] = [
    { kinds: [FLAGS, new Set(['vec3']), null, samples, samples, new Set(['vec3']), ...Array(4).fill(new Set(['float']))],
      bind: (instance) => ({ instance, kind: 'point', position: 2, axis: 6, yaw: [7, 8], pitch: [9, 10], samples: [4, 5], uniformClass: range }) },
    { kinds: [new Set(['vec3']), null, new Set(['vec3']), ...Array(4).fill(new Set(['float']))],
      bind: (instance) => ({ instance, kind: 'position', position: 1, axis: 3, yaw: [4, 5], pitch: [6, 7], uniformClass: range }) },
  ];
  const out: EffectOriginBinding[] = [];
  for (const f of configs) {
    const shape = shapes.find((s) => f.census.length === s.kinds.length + 1 && [...f.census[0]].every((k) => k.startsWith('scalar:'))
      && s.kinds.every((allowed, i) => (allowed === null ? f.census[i + 1].size === 0 : [...f.census[i + 1]].every((k) => allowed.has(k)))));
    if (!shape) continue;
    const literal = shape.kinds.map((k, i) => (k === null ? -1 : i + 1)).filter((op) => op > 0);
    const groups = new Map<number, Row[]>();
    for (const r of f.rows) groups.set(r.instance, [...(groups.get(r.instance) ?? []), r]);
    for (const [instance, rows] of groups) {
      if (rows.every((r) => literal.every((op) => r.kinds[op] !== EMPTY))) out.push(shape.bind(instance));
    }
  }
  return out;
}

/** Controllers that move with the water: their water style field, and the
 *  style's wave fields for each axis. */
function motionBindings(reg: EffectRegistry, byRuntime: Map<number, number[]>, styleRuntime: number,
  water: WaterDecodeData): PlacementDecodeData['effectMotion'] | null {
  const found = typesWithId(reg.types, CONTROLLER_TYPE);
  if (found.length !== 1) return null;
  const first = found[0], last = reg.types.ends[first];
  const runtimes = new Set<number>();
  for (const row of reg.rows) {
    const t = reg.objects[row.slot]?.values?.[TYPE_VALUE];
    if (t !== undefined && t >= first && t <= last) runtimes.add(row.runtime);
  }
  const fields = new Map<number, number>();
  const decoded = new Map<number, EffectExtra[][]>();
  for (const runtime of runtimes) {
    const rows = (byRuntime.get(runtime) ?? []).map((slot) => reg.extras(slot)).filter((x): x is EffectExtra[] => !!x);
    decoded.set(runtime, rows);
    for (const ops of rows) for (const e of ops) {
      if (e.kind === 'ref' && reg.rows[e.slot]?.runtime === styleRuntime) fields.set(e.op, (fields.get(e.op) ?? 0) + 1);
    }
  }
  if (fields.size !== 1) return null;
  const field = [...fields.keys()][0];
  const controllers = [...runtimes].filter((runtime) => decoded.get(runtime)!.every((ops) => {
    const e = ops[field];
    return e?.kind === 'ref' || (e?.kind === 'symbol' && e.name === '$none');
  })).sort((a, b) => a - b).map((runtime) => ({ runtime, field }));
  const { amplitude: a, frequency: f, rate: r } = water.styleFields;
  const x: [number, number, number] = [a[0], f[0], r[0]], y: [number, number, number] = [a[1], f[1], r[1]];
  const index = (n: number) => Number.isInteger(n) && n >= 0 && n < 65536;
  if (!index(field) || !index(styleRuntime) || controllers.some((c) => !index(c.runtime))
    || ![...x, ...y].every(index) || new Set([...x, ...y]).size !== 6) return null;
  return { controllers, settings: [{ runtime: styleRuntime, x, y }] };
}

// ------------------------------------------------------------ entry

/** Every effect binding found by shape; sections that do not resolve, or do
 *  not pass their reader's checks, are left out. */
export function effectLayout(reg: EffectRegistry, water: WaterDecodeData | null): EffectBindings {
  const out: EffectBindings = {};
  const byRuntime = slotsByRuntime(reg.rows);
  const markers = new Set(Object.values(MARKERS).map((m) => `symbol:${m}`));
  const emitters = [...seriesMemberRuntimes(reg.rows)].sort((a, b) => a - b)
    .map((rt) => family(reg, rt, byRuntime.get(rt)!))
    .filter((f): f is Family => !!f && f.census.some((k) => [...k].some((x) => markers.has(x))));
  const classes = valueClasses(emitters);
  if (classes) {
    const layouts = emitterLayouts(emitters, classes);
    const bound = emitters.filter((f) => layouts.has(f.runtime));
    const fields = byInstance<Omit<EffectFieldBinding, 'instance'>>(bound, (f, rows) => {
      const l = layouts.get(f.runtime)!, at = (role: Role) => filled(rows, l[role]);
      return { speed: [at('speed0'), at('speed1')], angularSpeed: at('angularSpeed'),
        acceleration: [at('acceleration0'), at('acceleration1')], scale: [at('scale0'), at('scale1')],
        rotation: at('rotation'), color: [at('color0'), at('color1')] };
    });
    const unused = 65535;   // a class no value of this build has
    const data: EffectFieldData = {
      classes: { range: classes.range ?? unused, rate: classes.rate ?? unused, vector: classes.vector ?? unused, colour: classes.colour ?? unused },
      bindings: [...fields].sort((a, b) => a[0] - b[0]).map(([instance, b]) => ({ instance, ...b })),
    };
    if (data.bindings.length && validEffectFields(data)) out.effectFields = data;
    // Facing: one mode field, and the one direction vector ahead of the
    // property fields (a lone empty field counts when no vector is found).
    const vector = kindSets(classes).vector;
    const facings = byInstance<Omit<EffectFacingBinding, 'instance'>>(bound, (f, rows) => {
      const modes = f.census.map((_, op) => op).filter((op) => f.census[op].size && [...f.census[op]].every((k) => FACING.has(k)));
      if (modes.length !== 1) return null;
      const l = layouts.get(f.runtime)!, start = l.speed0 === l.speed1! - 1 ? l.speed0! : l.speed1!;
      const before = f.census.map((_, op) => op).filter((op) => op < start && [...f.census[op]].every((k) => vector.has(k)));
      const solid = before.filter((op) => f.census[op].size);
      const axis = solid.length === 1 ? solid[0] : !solid.length && before.length === 1 ? before[0] : null;
      return { modeField: modes[0], axisField: filled(rows, axis) };
    });
    const facingData = [...facings].sort((a, b) => a[0] - b[0]).map(([instance, b]) => ({ instance, ...b }));
    if (facingData.length && validEffectFacings(facingData)) out.effectFacings = facingData;
  }
  // configs: every record type an emitter references directly
  const configRuntimes = new Set<number>();
  for (const f of emitters) for (const r of f.rows) for (const [, ref] of reg.rows[r.slot].r) {
    const rt = reg.rows[ref]?.runtime;
    if (rt !== undefined) configRuntimes.add(rt);
  }
  const configs = [...configRuntimes].sort((a, b) => a - b)
    .map((rt) => family(reg, rt, byRuntime.get(rt)!)).filter((f): f is Family => !!f);
  const none = reg.symbols.indexOf('$none');
  if (none >= 0) {
    const windows = windowBindings(configs, none).sort((a, b) => a.instance - b.instance);
    if (windows.length && validEffectWindows(windows)) out.effectWindows = windows;
  }
  if (classes?.range != null) {
    const origins = pointOrigins(configs, classes.range).sort((a, b) => a.instance - b.instance);
    if (origins.length && validEffectOrigins(origins)) out.effectOrigins = origins;
  }
  const styleRuntime = water ? waterStyleRuntime(reg, byRuntime, water) : null;
  if (water && styleRuntime !== null) {
    const waves: EffectWaveData = { step: EFFECT_WAVE_STEP, bindings: waveBindings(reg, configs, styleRuntime, water).sort((a, b) => a.instance - b.instance) };
    if (waves.bindings.length && validEffectWaves(waves)) out.effectWaves = waves;
    const motion = motionBindings(reg, byRuntime, styleRuntime, water);
    if (motion?.controllers.length) out.effectMotion = motion;
  }
  return out;
}

/** The runtime of the water style records the water materials reference. */
function waterStyleRuntime(reg: EffectRegistry, byRuntime: Map<number, number[]>, water: WaterDecodeData): number | null {
  const styles = new Set<number>();
  for (const material of [water.surface, water.curtain]) {
    for (const slot of byRuntime.get(material) ?? []) {
      const e = reg.extras(slot)?.[water.style];
      if (e?.kind === 'ref' && reg.rows[e.slot]) styles.add(reg.rows[e.slot].runtime);
    }
  }
  return styles.size === 1 ? [...styles][0] : null;
}
