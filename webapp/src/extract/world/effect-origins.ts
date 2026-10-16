// Optional per-build bindings are produced offline purely from analysis of
// the game's own files, never by inspecting or modifying a running game
// process or its memory. Geometry values remain in the user's bundle.
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';
import {effectRange, effectScalar, effectVec3, type EffectSample} from './effect-fields.js';
import {bindingIndex, instanceLookup, validBindingList} from './effect-bindings.js';
import {ownerFields, resolveScalar, resolveVector, validValueSource, type ComputedValue,
  type ValueSource} from './effect-sources.js';

export interface RadialOriginBinding {
  instance: number;
  kind: 'radial';
  resample: number;
  center: number;
  radius: number;
  /** Absent on builds whose radial shapes are not scaled per axis (scale 1). */
  axisScale?: [number, number];
  yaw: [number, number];
  pitch: [number, number];
  samples: [number, number];
  overrides: [number, number];
  uniformClass: number;
}
// A point source: a literal position with the default cone direction. The
// samples are the azimuth and polar fractions, in that evaluation order.
export interface PointOriginBinding {
  instance: number;
  kind: 'point';
  position: number;
  axis: number;
  yaw: [number, number];
  pitch: [number, number];
  samples: [number, number];
  uniformClass: number;
}
// Compact spawns: a literal position or a segment between two literal ends,
// with a cone whose fractions are uniform over the authored bounds.
export interface PositionOriginBinding {
  instance: number;
  kind: 'position';
  position: number;
  axis: number;
  yaw: [number, number];
  pitch: [number, number];
  uniformClass: number;
}
export interface SegmentOriginBinding {
  instance: number;
  kind: 'segment';
  start: number;
  end: number;
  axis: number;
  yaw: [number, number];
  pitch: [number, number];
  uniformClass: number;
}
export type EffectOriginBinding = RadialOriginBinding | PointOriginBinding | PositionOriginBinding | SegmentOriginBinding;
// A cylinder (from 07-Oct-2026: the Halloween teleports' bats and smoke): the game draws a distance from the centre up
// to the radius (uniform: denser near the axis), an angle all the way round and a height up to the height, scales the
// across offsets per axis and adds the three to the centre; it aims through the default cone, as a point source does.
// Kept apart from the origins in the decode data (a viewer that knows only those refuses a kind it does not know).
export interface CylinderOriginBinding {
  instance: number;
  center: number;
  radius: number;
  height: number;
  axisScale: [number, number];
  axis: number;
  yaw: [number, number];
  pitch: [number, number];
  samples: [number, number];
  uniformClass: number;
}
// A disc (compact spawns): the game draws a distance from the centre up to the radius (uniform: denser near the
// centre; a ranged radius drawn first) and an angle all the way round, and adds the two across to the centre; it aims
// through the compact cone, as a position does. Kept apart from the origins too.
export interface DiscOriginBinding {
  instance: number;
  center: number;
  radius: number;
  axis: number;
  yaw: [number, number];
  pitch: [number, number];
  // the generic route: two across scales, and the default cone's sample fractions
  axisScale?: [number, number];
  samples?: [number, number];
  uniformClass: number;
}
// A segment on the generic route: a point between two ends by one uniform draw, aimed through the default cone (its
// angles interpolated by their sample fractions, as a cylinder's). Kept apart from the origins too.
export interface LineOriginBinding {
  instance: number;
  start: number;
  end: number;
  axis: number;
  yaw: [number, number];
  pitch: [number, number];
  samples: [number, number];
  uniformClass: number;
}
// A box (either route): a point drawn between the box's two corners, x, y then z; aimed through the route's cone (the
// default cone's angles interpolated by their sample fractions on the generic route). Kept apart from the origins too.
export interface BoxOriginBinding {
  instance: number;
  box: number;
  axis: number;
  yaw: [number, number];
  pitch: [number, number];
  samples?: [number, number];
  uniformClass: number;
}
export interface BoxOrigin {
  a: [number, number, number];
  b: [number, number, number];
  axis: [number, number, number];
  yaw: [number, number];
  pitch: [number, number];
}
export interface RadialOrigin {
  center: [number, number, number];
  // A sampled radius is drawn for every particle (a range, or one of a few picked per particle).
  radius: EffectSample;
  axisScale: [number, number];
  yaw: [number, number];
  pitch: [number, number];
  /** Fractions of the yaw or pitch range the class's code draws (equally likely quantiles): where they stand, a
   *  particle's angle is the range at a fraction taken through them rather than an even one. */
  yawTable?: number[];
  pitchTable?: number[];
  /** Where every particle leaves along one vector of the record, instead of out along its yaw and pitch. */
  direction?: [number, number, number];
  /** Values computed for each particle (the fixed ones above then stand at zero or one). */
  computed?: {center?: ComputedValue; radius?: ComputedValue; axisScale?: [ComputedValue | null, ComputedValue | null]};
}

// A radial origin whose radius, centre or axis scales come from elsewhere (from 2026-10: rings sized by the emitter
// that owns them, rings that grow over their first particles, funnels): each a value source. Kept apart.
export interface RadialSourcedBinding {
  instance: number;
  /** Absent on a ring whose resample runs whatever its record's flag says. */
  resample?: number;
  yaw: [number, number];
  /** Both absent on a ring with yaw bounds only: its yaw drawn evenly between them, no pitch. */
  pitch?: [number, number]; samples?: [number, number];
  overrides: number[]; uniformClass: number;
  center: ValueSource; radius: ValueSource; axisScale?: [ValueSource, ValueSource];
}
export function validEffectRadialsSourced(v: any): v is RadialSourcedBinding[] {
  const pair = (p: any) => Array.isArray(p) && p.length === 2 && p.every(bindingIndex);
  // (a ring with yaw bounds only carries no pitch or sample fields, and one the game evaluates whatever the record's
  // flag says carries no flag)
  const yawOnly = (b: any) => b.pitch === undefined && b.samples === undefined;
  return validBindingList(v, b => bindingIndex(b.uniformClass) && pair(b.yaw)
    && (yawOnly(b) ? (b.resample === undefined || bindingIndex(b.resample))
      : bindingIndex(b.resample) && [b.pitch, b.samples].every(pair))
    && Array.isArray(b.overrides) && b.overrides.length <= 8 && b.overrides.every(bindingIndex)
    && validValueSource(b.center, true) && validValueSource(b.radius, false)
    && (b.axisScale === undefined || (Array.isArray(b.axisScale) && b.axisScale.length === 2
      && b.axisScale.every((s: any) => validValueSource(s, false)))));
}

// A radial origin whose particles all leave along one vector field of the shape's record (from 2026-10): that field.
// Kept apart.
export interface OriginDirectionBinding { instance: number; direction: number }
export function validEffectOriginDirections(v: any): v is OriginDirectionBinding[] {
  return validBindingList(v, b => bindingIndex(b.direction));
}

// A radial origin one of whose samples the class's code draws (from 2026-10: a ring whose particles are spaced
// evenly along an ellipse): that sample as quantiles of the fraction. Kept apart.
export interface RadialCodedBinding {
  instance: number; resample: number; center: number; radius: number; axisScale?: [number, number];
  yaw: [number, number]; pitch: [number, number];
  samples: [number | {quantiles: number[]}, number | {quantiles: number[]}];
  uniformClass: number;
}
export function validEffectRadialsCoded(v: any): v is RadialCodedBinding[] {
  const pair = (p: any) => Array.isArray(p) && p.length === 2 && p.every(bindingIndex);
  const sample = (x: any) => bindingIndex(x) || (x && Array.isArray(x.quantiles) && x.quantiles.length >= 2
    && x.quantiles.length <= 256 && x.quantiles.every((q: any) => Number.isFinite(q) && q >= 0 && q <= 1));
  return validBindingList(v, b => [b.resample, b.center, b.radius, b.uniformClass].every(bindingIndex)
    && [b.yaw, b.pitch].every(pair) && (b.axisScale === undefined || pair(b.axisScale))
    && Array.isArray(b.samples) && b.samples.length === 2 && b.samples.every(sample)
    && b.samples.some((x: any) => typeof x !== 'number'));
}
export interface PointOrigin {
  position: [number, number, number];
  axis: [number, number, number];
  yaw: [number, number];
  pitch: [number, number];
}
export interface SegmentOrigin {
  from: [number, number, number];
  to: [number, number, number];
  axis: [number, number, number];
  yaw: [number, number];
  pitch: [number, number];
}
export interface CylinderOrigin {
  center: [number, number, number];
  // (a disc's radius may be ranged: drawn for every particle)
  radius: number | [number, number];
  height: number;
  // a disc: no height drawn
  flat?: boolean;
  axisScale: [number, number];
  axis: [number, number, number];
  yaw: [number, number];
  pitch: [number, number];
}
export type EffectOrigin = {kind: 'radial'; radial: RadialOrigin} | {kind: 'point'; point: PointOrigin}
  | {kind: 'segment'; segment: SegmentOrigin} | {kind: 'cylinder'; cylinder: CylinderOrigin} | {kind: 'box'; box: BoxOrigin}
  | {kind: 'wander'; wander: {center: [number, number, number]; shape: WanderShapeValues}; cone?: ConeDirection}
  | {kind: 'coded'; coded: CodedOrigin; cone?: ConeDirection};

// The cone particles leave through, for shapes whose start point is bound but whose direction the record's shape
// leaves unread (from 2026-10: weather falling over a whole room, say): its axis field, the yaw and pitch bounds'
// fields (degrees) and the two fractions (azimuth, then polar), each a field of the uniform range class or the
// particle's own draw keyed by its birth tick (`seeded`, the salt). Kept apart.
export interface ConeDirectionBinding {
  instance: number; axis: number; yaw: [number, number]; pitch: [number, number];
  samples: [number | {seeded: number}, number | {seeded: number}]; uniformClass: number;
}
export function validEffectDirections(v: any): v is ConeDirectionBinding[] {
  const pair = (p: any) => Array.isArray(p) && p.length === 2 && p.every(bindingIndex);
  const sample = (x: any) => bindingIndex(x) || (x && Number.isInteger(x.seeded) && x.seeded >= 0 && x.seeded < 2 ** 32);
  return validBindingList(v, b => bindingIndex(b.axis) && bindingIndex(b.uniformClass) && pair(b.yaw) && pair(b.pitch)
    && Array.isArray(b.samples) && b.samples.length === 2 && b.samples.every(sample));
}
/** A cone as read: the axis, the yaw and pitch ranges (degrees) and each fraction's salt (-1: the particle's own
 *  draw). */
export interface ConeDirection { axis: [number, number, number]; yaw: [number, number]; pitch: [number, number]; salts: [number, number] }

// An origin the code makes from random draws, constants and its system's own numbers, its owner's class choosing the
// case (from 2026-10: a streak straight up from the system, an area high over a room, say): per shape and owner
// instance, each axis a multilinear polynomial over its variables, the draws then the system's fields (coefficient k
// for the product of the variables whose bits k sets). A draw is a fraction, or a whole number (`steps`: draw k
// takes steps[k] + 1 even values, its variable their index over steps[k]), or the same for every particle born on a
// tick (`seeded`: the salt of the tick's seeded draw, -1 for an ordinary draw). Kept apart.
export interface CodedOrigin {
  /** Each axis a polynomial over the variables; or, for a tabulated origin (below), a grid or a table instead. */
  draws: number; axes?: [number[], number[], number[]]; steps?: number[]; seeded?: number[];
  /** The system's numbers, in the order of the binding's fields. */
  fieldValues?: number[];
  /** 1 for a variable that is the particle's number in its emitter's stream itself, not a fraction. */
  counted?: number[];
  /** Samples per draw (draw 0 fastest) and, per axis, the point at every grid point: interpolated between them. */
  grid?: OriginGrid;
  /** Equally likely points: a particle takes one at random. */
  table?: [number, number, number][];
}
export interface OriginGrid { res: number[]; values: [number[], number[], number[]] }

// An origin like a coded one that its rows cannot carry (from 2026-10): a polynomial that also takes the particle's
// number in its emitter's stream (`counted`), a grid over the draws' fractions (a point through angles or a wrap), or a
// table of equally likely points (a point the particle's number steps round a circle). Kept apart.
export interface TabulatedOriginBinding {
  instance: number; owner: number; draws: number; steps?: number[]; seeded?: number[]; counted?: number[];
  axes?: [number[], number[], number[]]; grid?: OriginGrid; table?: [number, number, number][];
}
const TABLE_MAX = 4096, GRID_MAX = 8192;
export function validEffectOriginsTabulated(v: any): v is TabulatedOriginBinding[] {
  const ints = (a: any, n: number, ok: (x: number) => boolean) => Array.isArray(a) && a.length === n
    && a.every((x: any) => Number.isInteger(x) && ok(x));
  const triple = (a: any, n: number) => Array.isArray(a) && a.length === 3
    && a.every((x: any) => Array.isArray(x) && x.length === n && x.every(Number.isFinite));
  return Array.isArray(v) && v.length <= 65536 && v.every((b: any) => {
    if (!b || !bindingIndex(b.instance) || !bindingIndex(b.owner) || !Number.isInteger(b.draws) || b.draws < 1
      || b.draws > 6) return false;
    if (b.steps !== undefined && !ints(b.steps, b.draws, x => x >= 0 && x < 65536)) return false;
    if (b.seeded !== undefined && !ints(b.seeded, b.draws, x => x >= -1 && x < 2 ** 32)) return false;
    if (b.counted !== undefined && !ints(b.counted, b.draws, x => x === 0 || x === 1)) return false;
    const kinds = ['axes', 'grid', 'table'].filter(k => b[k] !== undefined);
    if (kinds.length !== 1) return false;
    if (b.axes !== undefined) return triple(b.axes, 1 << b.draws);
    if (b.grid !== undefined) {
      const res = b.grid?.res;
      if (!ints(res, b.draws, x => x >= 2 && x <= 65537) || b.counted?.some((c: number) => c)) return false;
      if ((b.steps ?? []).some((s: number, i: number) => s > 0 && res[i] !== s + 1)) return false;
      const n = res.reduce((p: number, r: number) => p * r, 1);
      return n <= GRID_MAX && triple(b.grid.values, n);
    }
    return Array.isArray(b.table) && b.table.length >= 1 && b.table.length <= TABLE_MAX
      && b.table.every((p: any) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite));
  }) && new Set(v.map((b: any) => `${b.instance}|${b.owner}`)).size === v.length;
}
// An origin like a coded or tabulated one for a single shape record (from 2026-10): where the records of one shape
// and owner instance put their particles at different points (a system whose emitters each stand at their own spot,
// worked out from their own records), a row for each record, `slot` naming it. Kept apart.
export type PerRecordOriginBinding = (CodedOriginBinding | TabulatedOriginBinding) & { slot: number };
export function validEffectOriginsPerRecord(v: any): v is PerRecordOriginBinding[] {
  return Array.isArray(v) && v.length <= 65536 && v.every((b: any) => {
    if (!b || !Number.isInteger(b.slot) || b.slot < 0 || b.slot >= 2 ** 31) return false;
    const {slot, ...row} = b;
    return validEffectOriginsCoded([row]) || validEffectOriginsTabulated([row]);
  }) && new Set(v.map((b: any) => b.slot)).size === v.length;
}
export interface CodedOriginBinding {
  instance: number; owner: number; draws: number; axes: [number[], number[], number[]];
  steps?: number[]; seeded?: number[];
  /** Fields of the system listing the owner, after the draws among the variables. */
  fields?: number[];
}
export function validEffectOriginsCoded(v: any): v is CodedOriginBinding[] {
  const ints = (a: any, n: number, ok: (x: number) => boolean) => Array.isArray(a) && a.length === n
    && a.every((x: any) => Number.isInteger(x) && ok(x));
  return Array.isArray(v) && v.length <= 65536 && v.every((b: any) => {
    if (!b || !bindingIndex(b.instance) || !bindingIndex(b.owner) || !Number.isInteger(b.draws) || b.draws < 1) return false;
    const fields = b.fields === undefined ? 0 : Array.isArray(b.fields) && b.fields.every(bindingIndex) ? b.fields.length : -1;
    const k = b.draws + fields;
    return fields >= 0 && k <= 6 && Array.isArray(b.axes) && b.axes.length === 3
      && b.axes.every((a: any) => Array.isArray(a) && a.length === 1 << k && a.every(Number.isFinite))
      && (b.steps === undefined || ints(b.steps, b.draws, x => x >= 0 && x < 65536))
      && (b.seeded === undefined || ints(b.seeded, b.draws, x => x >= -1 && x < 2 ** 32));
  }) && new Set(v.map((b: any) => `${b.instance}|${b.owner}`)).size === v.length;
}

// A wandering source (from 2026-10): each batch of `period` particles spawns about one seeded spot along a tilted
// streak (angle round the centre, tilt, half length and sign, height, base radius). Each value is a multilinear
// polynomial over seeded draws (the batch's or the particle's place in it, with a salt); its terms name the draws by
// bit mask, the record's fields they multiply (scalar fields, by number) and a coefficient. Kept apart.
export type WanderDraw = ['cycle' | 'index', number];
export interface WanderValueBinding { draws: WanderDraw[]; terms: [number, number[], number][] }
export interface WanderOriginBinding {
  instance: number; center: number; period: number;
  values: Record<'angle' | 'tilt' | 'amp' | 'height' | 'base', WanderValueBinding>;
}
/** A wander value with the record's numbers in: coefficient k for the product of the draws whose bits k sets. */
export interface WanderValue { draws: WanderDraw[]; coef: number[] }
export type WanderShapeValues = {period: number} & Record<'angle' | 'tilt' | 'amp' | 'height' | 'base', WanderValue>;
const WANDER_VALUES = ['angle', 'tilt', 'amp', 'height', 'base'] as const;
export function validEffectWanders(v: any): v is WanderOriginBinding[] {
  const value = (x: any) => x && Array.isArray(x.draws) && x.draws.length <= 6
    && x.draws.every((d: any) => Array.isArray(d) && d.length === 2 && (d[0] === 'cycle' || d[0] === 'index')
      && Number.isInteger(d[1]) && d[1] >= 0 && d[1] < 2 ** 32)
    && Array.isArray(x.terms) && x.terms.length <= 4096 && x.terms.every((t: any) => Array.isArray(t) && t.length === 3
      && Number.isInteger(t[0]) && t[0] >= 0 && t[0] < 1 << x.draws.length && Array.isArray(t[1]) && t[1].length <= 4
      && t[1].every(bindingIndex) && Number.isFinite(t[2]));
  return validBindingList(v, b => bindingIndex(b.center) && Number.isInteger(b.period) && b.period > 0 && b.period <= 65536
    && b.values && WANDER_VALUES.every(k => value(b.values[k])));
}

export function validEffectCylinders(v: any): v is CylinderOriginBinding[] {
  const pair = (p: any) => Array.isArray(p) && p.length === 2 && p.every(bindingIndex);
  return validBindingList(v, b => [b.center, b.radius, b.height, b.axis, b.uniformClass].every(bindingIndex)
    && [b.axisScale, b.yaw, b.pitch, b.samples].every(pair));
}

export function validEffectDiscs(v: any): v is DiscOriginBinding[] {
  const pair = (p: any) => Array.isArray(p) && p.length === 2 && p.every(bindingIndex);
  return validBindingList(v, b => [b.center, b.radius, b.axis, b.uniformClass].every(bindingIndex)
    && [b.yaw, b.pitch].every(pair) && (b.axisScale === undefined || pair(b.axisScale)) && (b.samples === undefined || pair(b.samples)));
}

export function validEffectSegments(v: any): v is LineOriginBinding[] {
  const pair = (p: any) => Array.isArray(p) && p.length === 2 && p.every(bindingIndex);
  return validBindingList(v, b => [b.start, b.end, b.axis, b.uniformClass].every(bindingIndex)
    && [b.yaw, b.pitch, b.samples].every(pair));
}

export function validEffectBoxes(v: any): v is BoxOriginBinding[] {
  const pair = (p: any) => Array.isArray(p) && p.length === 2 && p.every(bindingIndex);
  return validBindingList(v, b => [b.box, b.axis, b.uniformClass].every(bindingIndex)
    && [b.yaw, b.pitch].every(pair) && (b.samples === undefined || pair(b.samples)));
}

export function validEffectOrigins(v: any): v is EffectOriginBinding[] {
  const pair = (p: any) => Array.isArray(p) && p.length === 2 && p.every(bindingIndex);
  return validBindingList(v, b => bindingIndex(b.uniformClass)
    && [b.yaw, b.pitch].every(pair) && (b.kind === 'radial'
      ? pair(b.samples) && [b.resample, b.center, b.radius].every(bindingIndex) && (b.axisScale === undefined || pair(b.axisScale)) && pair(b.overrides)
      : b.kind === 'point' ? pair(b.samples) && bindingIndex(b.position) && bindingIndex(b.axis)
      : b.kind === 'position' ? bindingIndex(b.position) && bindingIndex(b.axis)
      : b.kind === 'segment' && [b.start, b.end, b.axis].every(bindingIndex)));
}
export function createEffectOriginReader(bindings: EffectOriginBinding[] | undefined,
  objects: ConstructorRecord[], cylinders?: CylinderOriginBinding[], discs?: DiscOriginBinding[], lines?: LineOriginBinding[],
  boxes?: BoxOriginBinding[], wanders?: WanderOriginBinding[], codedRadials?: RadialCodedBinding[],
  codedOrigins?: CodedOriginBinding[], directions?: OriginDirectionBinding[], sourced?: RadialSourcedBinding[],
  tabulated?: TabulatedOriginBinding[], perRecord?: PerRecordOriginBinding[], cones?: ConeDirectionBinding[]) {
  if (cones !== undefined && !validEffectDirections(cones)) throw Error('invalid effect direction bindings');
  const coneOf = instanceLookup((cones || []).map(b => [b.instance, b] as const), objects);
  if (perRecord !== undefined && !validEffectOriginsPerRecord(perRecord)) throw Error('invalid effect per-record origin bindings');
  const recordRows = new Map<number, CodedOriginBinding | TabulatedOriginBinding>((perRecord || []).map(b => [b.slot, b] as const));
  if (tabulated !== undefined && !validEffectOriginsTabulated(tabulated)) throw Error('invalid effect tabulated origin bindings');
  if (sourced !== undefined && !validEffectRadialsSourced(sourced)) throw Error('invalid effect sourced radial bindings');
  const sourcedOf = instanceLookup((sourced || []).map(b => [b.instance, b] as const), objects);
  if (directions !== undefined && !validEffectOriginDirections(directions)) throw Error('invalid effect origin direction bindings');
  const directionOf = instanceLookup((directions || []).map(b => [b.instance, b] as const), objects);
  if (codedOrigins !== undefined && !validEffectOriginsCoded(codedOrigins)) throw Error('invalid effect coded origin bindings');
  const coded = new Map<string, CodedOriginBinding | TabulatedOriginBinding>(
    [...(codedOrigins || []), ...(tabulated || [])].map(b => [`${b.instance}|${b.owner}`, b] as const));
  // (the shape's own instance, and its owner's: the record its op 0 names)
  const instanceOf = (slot: number): number | null => {
    const v = objects[slot]?.values?.[1];
    return Number.isInteger(v) ? v as number : null;
  };
  if (wanders !== undefined && !validEffectWanders(wanders)) throw Error('invalid effect wander bindings');
  if (codedRadials !== undefined && !validEffectRadialsCoded(codedRadials)) throw Error('invalid effect coded radial bindings');
  const codedOf = instanceLookup((codedRadials || []).map(b => [b.instance, b] as const), objects);
  const wanderOf = instanceLookup((wanders || []).map(b => [b.instance, b] as const), objects);
  if (bindings !== undefined && !validEffectOrigins(bindings)) throw Error('invalid effect origin bindings');
  if (cylinders !== undefined && !validEffectCylinders(cylinders)) throw Error('invalid effect cylinder bindings');
  if (discs !== undefined && !validEffectDiscs(discs)) throw Error('invalid effect disc bindings');
  if (lines !== undefined && !validEffectSegments(lines)) throw Error('invalid effect segment bindings');
  if (boxes !== undefined && !validEffectBoxes(boxes)) throw Error('invalid effect box bindings');
  const bindingOf = instanceLookup((bindings || []).map(b => [b.instance, b] as const), objects);
  const cylinderOf = instanceLookup((cylinders || []).map(b => [b.instance, b] as const), objects);
  const discOf = instanceLookup((discs || []).map(b => [b.instance, b] as const), objects);
  const lineOf = instanceLookup((lines || []).map(b => [b.instance, b] as const), objects);
  const boxOf = instanceLookup((boxes || []).map(b => [b.instance, b] as const), objects);
  // (opsOf: any record's fields by slot, for values read from the records up the owner chain)
  const read = (slot: number, ops: EffectExtra[], opsOf?: (slot: number) => EffectExtra[] | null): EffectOrigin | null => {
    const b = bindingOf(slot), c = b ? undefined : cylinderOf(slot), d = b || c ? undefined : discOf(slot);
    const l = b || c || d ? undefined : lineOf(slot);
    const x = b || c || d || l ? undefined : boxOf(slot);
    const w = b || c || d || l || x ? undefined : wanderOf(slot);
    const k = b || c || d || l || x || w ? undefined : codedOf(slot);
    if (!b && !c && !d && !l && !x && !w && !k) {
      if (!coded.size && !recordRows.size) return null;
      const own = ops.find(e => e.op === 0 && e.kind === 'scalar');
      const inst = instanceOf(slot), owner = own && 'value' in own ? instanceOf(Number(own.value)) : null;
      // (a row for this shape record itself first, then the shape and owner instance's)
      const got = recordRows.get(slot) ?? (inst !== null && owner !== null ? coded.get(`${inst}|${owner}`) : undefined);
      if (!got) return null;
      let fieldValues: number[] | undefined;
      if ('fields' in got && got.fields?.length) {
        const sys = ownerFields(ops, opsOf)(2);
        if (!sys) return null;
        const values = got.fields.map(op => effectScalar(sys.get(op)));
        if (values.some(n => n === null)) return null;
        fieldValues = values as number[];
      }
      const t = got as TabulatedOriginBinding;
      return {kind: 'coded', coded: {draws: got.draws,
        ...(got.axes ? {axes: got.axes.map(a => [...a]) as [number[], number[], number[]]} : {}),
        ...(t.grid ? {grid: {res: [...t.grid.res], values: t.grid.values.map(a => [...a]) as [number[], number[], number[]]}} : {}),
        ...(t.table ? {table: t.table.map(p => [...p] as [number, number, number])} : {}),
        ...(t.counted ? {counted: [...t.counted]} : {}),
        ...(got.steps ? {steps: [...got.steps]} : {}), ...(got.seeded ? {seeded: [...got.seeded]} : {}),
        ...(fieldValues ? {fieldValues} : {})}};
    }
    const fields = new Map(ops.map(e => [e.op, e]));
    if (k) {
      const resample = fields.get(k.resample);
      if (resample?.kind !== 'other' || resample.tag !== 12) return null;
      const center = effectVec3(fields.get(k.center));
      const radiusField = fields.get(k.radius);
      const radius = effectScalar(radiusField) ?? effectRange(radiusField, k.uniformClass);
      const scales = k.axisScale ? k.axisScale.map(op => effectScalar(fields.get(op))) : [1, 1];
      if (!center || radius === null || scales.some(n => n === null)) return null;
      const side = (bounds: [number, number], sample: number | {quantiles: number[]}) => {
        if (typeof sample === 'number') {
          const lo = effectScalar(fields.get(bounds[0])), hi = effectScalar(fields.get(bounds[1]));
          const s = fields.get(sample), n = effectScalar(s);
          const fraction = effectRange(s, k.uniformClass) ?? (n === null ? null : [n, n] as [number, number]);
          return lo === null || hi === null || !fraction ? null
            : {range: [lo + (hi - lo) * fraction[0], lo + (hi - lo) * fraction[1]] as [number, number]};
        }
        const lo = effectScalar(fields.get(bounds[0])), hi = effectScalar(fields.get(bounds[1]));
        return lo === null || hi === null ? null : {range: [lo, hi] as [number, number], table: [...sample.quantiles]};
      };
      const yaw = side(k.yaw, k.samples[0]), pitch = side(k.pitch, k.samples[1]);
      if (!yaw || !pitch) return null;
      return {kind: 'radial', radial: {center, radius, axisScale: scales as [number, number], yaw: yaw.range, pitch: pitch.range,
        ...(yaw.table ? {yawTable: yaw.table} : {}), ...(pitch.table ? {pitchTable: pitch.table} : {})}};
    }
    if (w) {
      const center = effectVec3(fields.get(w.center));
      if (!center) return null;
      const shape: any = {period: w.period};
      for (const k of WANDER_VALUES) {
        const v = w.values[k], coef = new Array(1 << v.draws.length).fill(0);
        for (const [mask, ops, c] of v.terms) {
          let term = c;
          for (const op of ops) {
            const n = effectScalar(fields.get(op));
            if (n === null) return null;
            term *= n;
          }
          coef[mask] += term;
        }
        shape[k] = {draws: v.draws.map(([kind, salt]) => [kind, salt]), coef};
      }
      return {kind: 'wander', wander: {center, shape}};
    }
    // A sample field selects a sub-interval of its authored angle range. The
    // game interpolates the endpoints by the sampled fraction.
    const angles = (bounds: [number, number], sampleOp: number): [number, number] | null => {
      const lo = effectScalar(fields.get(bounds[0])), hi = effectScalar(fields.get(bounds[1]));
      const sample = fields.get(sampleOp);
      if (lo === null || hi === null) return null;
      const n = effectScalar(sample);
      const fraction = effectRange(sample, (b ?? c ?? d ?? l ?? x)!.uniformClass) ?? (n === null ? null : [n, n] as [number, number]);
      if (!fraction) return null;
      const result: [number, number] = [lo + (hi - lo) * fraction[0], lo + (hi - lo) * fraction[1]];
      return result.every(Number.isFinite) ? result : null;
    };
    if (d) {
      const center = effectVec3(fields.get(d.center)), axis = effectVec3(fields.get(d.axis));
      const radiusField = fields.get(d.radius);
      const radius = effectScalar(radiusField) ?? effectRange(radiusField, d.uniformClass);
      const bounds = (pair: [number, number]): [number, number] | null => {
        const v = pair.map(op => effectScalar(fields.get(op)));
        return v.every(n => n !== null) ? v as [number, number] : null;
      };
      const yaw = d.samples ? angles(d.yaw, d.samples[0]) : bounds(d.yaw);
      const pitch = d.samples ? angles(d.pitch, d.samples[1]) : bounds(d.pitch);
      const scales = d.axisScale ? d.axisScale.map(op => effectScalar(fields.get(op))) : [1, 1];
      return center && axis && yaw && pitch && radius !== null && scales.every(n => n !== null)
        ? {kind: 'cylinder', cylinder: {center, radius, height: 0, flat: true, axisScale: scales as [number, number], axis, yaw, pitch}} : null;
    }
    if (x) {
      const field = fields.get(x.box), axis = effectVec3(fields.get(x.axis));
      const bounds = (pair: [number, number]): [number, number] | null => {
        const v = pair.map(op => effectScalar(fields.get(op)));
        return v.every(n => n !== null) ? v as [number, number] : null;
      };
      const yaw = x.samples ? angles(x.yaw, x.samples[0]) : bounds(x.yaw);
      const pitch = x.samples ? angles(x.pitch, x.samples[1]) : bounds(x.pitch);
      return field?.kind === 'box' && axis && yaw && pitch ? {kind: 'box', box: {a: field.a, b: field.b, axis, yaw, pitch}} : null;
    }
    if (l) {
      const from = effectVec3(fields.get(l.start)), to = effectVec3(fields.get(l.end)), axis = effectVec3(fields.get(l.axis));
      const yaw = angles(l.yaw, l.samples[0]), pitch = angles(l.pitch, l.samples[1]);
      return from && to && axis && yaw && pitch ? {kind: 'segment', segment: {from, to, axis, yaw, pitch}} : null;
    }
    if (c) {
      const center = effectVec3(fields.get(c.center)), axis = effectVec3(fields.get(c.axis));
      const [radius, height, sx, sy] = [c.radius, c.height, ...c.axisScale].map(op => effectScalar(fields.get(op)));
      const yaw = angles(c!.yaw, c!.samples[0]), pitch = angles(c!.pitch, c!.samples[1]);
      return center && axis && yaw && pitch && radius !== null && height !== null && sx !== null && sy !== null
        ? {kind: 'cylinder', cylinder: {center, radius, height, axisScale: [sx, sy], axis, yaw, pitch}} : null;
    }
    if (!b) return null;
    if (b.kind === 'position' || b.kind === 'segment') {
      const axis = effectVec3(fields.get(b.axis));
      const bounds = (ops: [number, number]): [number, number] | null => {
        const v = ops.map(op => effectScalar(fields.get(op)));
        return v.every(n => n !== null) ? v as [number, number] : null;
      };
      const yaw = bounds(b.yaw), pitch = bounds(b.pitch);
      if (!axis || !yaw || !pitch) return null;
      if (b.kind === 'position') {
        const position = effectVec3(fields.get(b.position));
        return position ? {kind: 'point', point: {position, axis, yaw, pitch}} : null;
      }
      const from = effectVec3(fields.get(b.start)), to = effectVec3(fields.get(b.end));
      return from && to ? {kind: 'segment', segment: {from, to, axis, yaw, pitch}} : null;
    }
    if (b.kind === 'point') {
      const position = effectVec3(fields.get(b.position)), axis = effectVec3(fields.get(b.axis));
      const yaw = angles(b.yaw, b.samples[0]), pitch = angles(b.pitch, b.samples[1]);
      return position && axis && yaw && pitch ? {kind: 'point', point: {position, axis, yaw, pitch}} : null;
    }
    const resample = fields.get(b.resample);
    if (resample?.kind !== 'other' || resample.tag !== 12) return null;
    // Explicit expressions must not silently become literal geometry.
    if (b.overrides.some(op => { const e = fields.get(op); return e?.kind !== 'other' || e.tag !== 1; })) return null;
    const center = effectVec3(fields.get(b.center));
    const radiusField = fields.get(b.radius);
    const radius = effectScalar(radiusField) ?? effectRange(radiusField, b.uniformClass);
    if (!center || radius === null) return null;
    const scales = b.axisScale ? b.axisScale.map(op => effectScalar(fields.get(op))) : [1, 1];
    if (scales.some(n => n === null)) return null;
    const yaw = angles(b.yaw, b.samples[0]), pitch = angles(b.pitch, b.samples[1]);
    if (!yaw || !pitch) return null;
    return {kind: 'radial', radial: {center, radius, axisScale: scales as [number, number], yaw, pitch}};
  };
  // (a radial origin with value sources: the shape's own fields as a radial's, the rest resolved)
  const readSourced = (b: RadialSourcedBinding, ops: EffectExtra[],
    opsOf?: (slot: number) => EffectExtra[] | null): EffectOrigin | null => {
    const fields = new Map(ops.map(e => [e.op, e]));
    if (b.resample !== undefined) {
      const resample = fields.get(b.resample);
      if (resample?.kind !== 'other' || resample.tag !== 12) return null;
    }
    if (b.overrides.some(op => { const e = fields.get(op); return e?.kind !== 'other' || e.tag !== 1; })) return null;
    const owners = ownerFields(ops, opsOf);
    const center = resolveVector(b.center, fields, owners);
    const radius = resolveScalar(b.radius, fields, owners, b.uniformClass);
    const scales = b.axisScale ? b.axisScale.map(s => resolveScalar(s, fields, owners, b.uniformClass)) : null;
    if (!center || !radius || scales?.some(s => !s || ('value' in s && typeof s.value !== 'number'))) return null;
    const side = (bounds: [number, number], sampleOp: number): [number, number] | null => {
      const lo = effectScalar(fields.get(bounds[0])), hi = effectScalar(fields.get(bounds[1]));
      const sample = fields.get(sampleOp), n = effectScalar(sample);
      const fraction = effectRange(sample, b.uniformClass) ?? (n === null ? null : [n, n] as [number, number]);
      if (lo === null || hi === null || !fraction) return null;
      const r: [number, number] = [lo + (hi - lo) * fraction[0], lo + (hi - lo) * fraction[1]];
      return r.every(Number.isFinite) ? r : null;
    };
    // (yaw bounds only: the yaw drawn evenly between them, no pitch)
    const bounds = (pair: [number, number]): [number, number] | null => {
      const lo = effectScalar(fields.get(pair[0])), hi = effectScalar(fields.get(pair[1]));
      return lo === null || hi === null ? null : [lo, hi];
    };
    const yaw = b.samples ? side(b.yaw, b.samples[0]) : bounds(b.yaw);
    const pitch: [number, number] | null = b.samples && b.pitch ? side(b.pitch, b.samples[1]) : [0, 0];
    if (!yaw || !pitch) return null;
    const computed: NonNullable<RadialOrigin['computed']> = {};
    if ('computed' in center) computed.center = center.computed;
    if ('computed' in radius) computed.radius = radius.computed;
    if (scales?.some(s => s && 'computed' in s)) {
      computed.axisScale = scales.map(s => s && 'computed' in s ? s.computed : null) as [ComputedValue | null, ComputedValue | null];
    }
    const radial: RadialOrigin = {
      center: 'value' in center ? center.value : [0, 0, 0],
      radius: 'value' in radius ? radius.value : 0,
      axisScale: (scales ? scales.map(s => s && 'value' in s ? s.value as number : 1) : [1, 1]) as [number, number],
      yaw, pitch, ...(Object.keys(computed).length ? {computed} : {}),
    };
    return {kind: 'radial', radial};
  };
  return (slot: number, ops: EffectExtra[], opsOf?: (slot: number) => EffectExtra[] | null): EffectOrigin | null => {
    const sb = sourcedOf(slot);
    const origin = sb ? readSourced(sb, ops, opsOf) : read(slot, ops, opsOf), d = directionOf(slot);
    const cb = origin?.kind === 'coded' || origin?.kind === 'wander' ? coneOf(slot) : undefined;
    if (cb && (origin?.kind === 'coded' || origin?.kind === 'wander')) {
      const fields = new Map(ops.map(e => [e.op, e]));
      const axis = effectVec3(fields.get(cb.axis));
      const side = (bounds: [number, number], sample: number | {seeded: number}): {range: [number, number]; salt: number} | null => {
        const lo = effectScalar(fields.get(bounds[0])), hi = effectScalar(fields.get(bounds[1]));
        if (lo === null || hi === null) return null;
        let fraction: [number, number] | null = [0, 1], salt = -1;
        if (typeof sample === 'number') {
          const f = fields.get(sample), n = effectScalar(f);
          fraction = effectRange(f, cb.uniformClass) ?? (n === null ? null : [n, n]);
        } else salt = sample.seeded;
        if (!fraction) return null;
        const range: [number, number] = [lo + (hi - lo) * fraction[0], lo + (hi - lo) * fraction[1]];
        return range.every(Number.isFinite) ? {range, salt} : null;
      };
      const yaw = side(cb.yaw, cb.samples[0]), pitch = side(cb.pitch, cb.samples[1]);
      // (a cone that does not read leaves the start point bound and the direction as the shape reads it)
      if (axis && yaw && pitch) return {...origin, cone: {axis, yaw: yaw.range, pitch: pitch.range, salts: [yaw.salt, pitch.salt]}};
      return origin;
    }
    if (!d || origin?.kind !== 'radial') return origin;
    const direction = effectVec3(ops.find(e => e.op === d.direction));
    return direction ? {kind: 'radial', radial: {...origin.radial, direction}} : null;
  };
}
