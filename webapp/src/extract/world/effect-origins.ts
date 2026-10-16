// Optional per-build bindings are produced offline purely from analysis of
// the game's own files, never by inspecting or modifying a running game
// process or its memory. Geometry values remain in the user's bundle.
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';
import {effectRange, effectScalar, effectVec3} from './effect-fields.js';
import {bindingIndex, instanceLookup, validBindingList} from './effect-bindings.js';

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
  // A sampled radius is drawn for every particle.
  radius: number | [number, number];
  axisScale: [number, number];
  yaw: [number, number];
  pitch: [number, number];
  /** Fractions of the yaw or pitch range the class's code draws (equally likely quantiles): where they stand, a
   *  particle's angle is the range at a fraction taken through them rather than an even one. */
  yawTable?: number[];
  pitchTable?: number[];
  /** Where every particle leaves along one vector of the record, instead of out along its yaw and pitch. */
  direction?: [number, number, number];
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
  | {kind: 'wander'; wander: {center: [number, number, number]; shape: WanderShapeValues}}
  | {kind: 'coded'; coded: CodedOrigin};

// An origin the code makes from uniform draws and constants alone, its owner's class choosing the case (from 2026-10:
// a streak straight up from the system, say): per shape and owner instance, each axis a multilinear polynomial over
// the draws' fractions (coefficient k for the product of the draws whose bits k sets). Kept apart.
export interface CodedOrigin { draws: number; axes: [number[], number[], number[]] }
export interface CodedOriginBinding extends CodedOrigin { instance: number; owner: number }
export function validEffectOriginsCoded(v: any): v is CodedOriginBinding[] {
  return Array.isArray(v) && v.length <= 65536 && v.every((b: any) => b && bindingIndex(b.instance) && bindingIndex(b.owner)
    && Number.isInteger(b.draws) && b.draws >= 1 && b.draws <= 4 && Array.isArray(b.axes) && b.axes.length === 3
    && b.axes.every((a: any) => Array.isArray(a) && a.length === 1 << b.draws && a.every(Number.isFinite)))
    && new Set(v.map((b: any) => `${b.instance}|${b.owner}`)).size === v.length;
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
  codedOrigins?: CodedOriginBinding[], directions?: OriginDirectionBinding[]) {
  if (directions !== undefined && !validEffectOriginDirections(directions)) throw Error('invalid effect origin direction bindings');
  const directionOf = instanceLookup((directions || []).map(b => [b.instance, b] as const), objects);
  if (codedOrigins !== undefined && !validEffectOriginsCoded(codedOrigins)) throw Error('invalid effect coded origin bindings');
  const coded = new Map((codedOrigins || []).map(b => [`${b.instance}|${b.owner}`, b] as const));
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
  const read = (slot: number, ops: EffectExtra[]): EffectOrigin | null => {
    const b = bindingOf(slot), c = b ? undefined : cylinderOf(slot), d = b || c ? undefined : discOf(slot);
    const l = b || c || d ? undefined : lineOf(slot);
    const x = b || c || d || l ? undefined : boxOf(slot);
    const w = b || c || d || l || x ? undefined : wanderOf(slot);
    const k = b || c || d || l || x || w ? undefined : codedOf(slot);
    if (!b && !c && !d && !l && !x && !w && !k) {
      if (!coded.size) return null;
      const own = ops.find(e => e.op === 0 && e.kind === 'scalar');
      const inst = instanceOf(slot), owner = own && 'value' in own ? instanceOf(Number(own.value)) : null;
      const got = inst !== null && owner !== null ? coded.get(`${inst}|${owner}`) : undefined;
      return got ? {kind: 'coded', coded: {draws: got.draws, axes: got.axes.map(a => [...a]) as [number[], number[], number[]]}} : null;
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
  return (slot: number, ops: EffectExtra[]): EffectOrigin | null => {
    const origin = read(slot, ops), d = directionOf(slot);
    if (!d || origin?.kind !== 'radial') return origin;
    const direction = effectVec3(ops.find(e => e.op === d.direction));
    return direction ? {kind: 'radial', radial: {...origin.radial, direction}} : null;
  };
}
