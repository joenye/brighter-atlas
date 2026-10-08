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
export interface RadialOrigin {
  center: [number, number, number];
  // A sampled radius is drawn for every particle.
  radius: number | [number, number];
  axisScale: [number, number];
  yaw: [number, number];
  pitch: [number, number];
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
  radius: number;
  height: number;
  axisScale: [number, number];
  axis: [number, number, number];
  yaw: [number, number];
  pitch: [number, number];
}
export type EffectOrigin = {kind: 'radial'; radial: RadialOrigin} | {kind: 'point'; point: PointOrigin}
  | {kind: 'segment'; segment: SegmentOrigin} | {kind: 'cylinder'; cylinder: CylinderOrigin};

export function validEffectCylinders(v: any): v is CylinderOriginBinding[] {
  const pair = (p: any) => Array.isArray(p) && p.length === 2 && p.every(bindingIndex);
  return validBindingList(v, b => [b.center, b.radius, b.height, b.axis, b.uniformClass].every(bindingIndex)
    && [b.axisScale, b.yaw, b.pitch, b.samples].every(pair));
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
  objects: ConstructorRecord[], cylinders?: CylinderOriginBinding[]) {
  if (bindings !== undefined && !validEffectOrigins(bindings)) throw Error('invalid effect origin bindings');
  if (cylinders !== undefined && !validEffectCylinders(cylinders)) throw Error('invalid effect cylinder bindings');
  const bindingOf = instanceLookup((bindings || []).map(b => [b.instance, b] as const), objects);
  const cylinderOf = instanceLookup((cylinders || []).map(b => [b.instance, b] as const), objects);
  return (slot: number, ops: EffectExtra[]): EffectOrigin | null => {
    const b = bindingOf(slot), c = b ? undefined : cylinderOf(slot);
    if (!b && !c) return null;
    const fields = new Map(ops.map(e => [e.op, e]));
    // A sample field selects a sub-interval of its authored angle range. The
    // game interpolates the endpoints by the sampled fraction.
    const angles = (bounds: [number, number], sampleOp: number): [number, number] | null => {
      const lo = effectScalar(fields.get(bounds[0])), hi = effectScalar(fields.get(bounds[1]));
      const sample = fields.get(sampleOp);
      if (lo === null || hi === null) return null;
      const n = effectScalar(sample);
      const fraction = effectRange(sample, (b ?? c)!.uniformClass) ?? (n === null ? null : [n, n] as [number, number]);
      if (!fraction) return null;
      const result: [number, number] = [lo + (hi - lo) * fraction[0], lo + (hi - lo) * fraction[1]];
      return result.every(Number.isFinite) ? result : null;
    };
    if (c) {
      const center = effectVec3(fields.get(c.center)), axis = effectVec3(fields.get(c.axis));
      const [radius, height, sx, sy] = [c.radius, c.height, ...c.axisScale].map(op => effectScalar(fields.get(op)));
      const yaw = angles(c.yaw, c.samples[0]), pitch = angles(c.pitch, c.samples[1]);
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
}
