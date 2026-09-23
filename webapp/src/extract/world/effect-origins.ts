// Optional per-build bindings are produced offline purely from analysis of
// the game's own files, never by inspecting or modifying a running game
// process or its memory. Geometry values remain in the user's bundle.
import type {ConstructorRecord} from './replay.js';
import type {EffectExtra} from './effects.js';

export interface RadialOriginBinding {
  instance: number;
  kind: 'radial';
  resample: number;
  center: number;
  radius: number;
  axisScale: [number, number];
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
export type EffectOrigin = {kind: 'radial'; radial: RadialOrigin} | {kind: 'point'; point: PointOrigin}
  | {kind: 'segment'; segment: SegmentOrigin};

export function validEffectOrigins(v: any): v is EffectOriginBinding[] {
  const integer = (n: any) => Number.isInteger(n) && n >= 0 && n < 65536;
  const pair = (p: any) => Array.isArray(p) && p.length === 2 && p.every(integer);
  return Array.isArray(v) && v.length <= 65536 && v.every(b => b && integer(b.instance) && integer(b.uniformClass)
    && [b.yaw, b.pitch].every(pair) && (b.kind === 'radial'
      ? pair(b.samples) && integer(b.resample) && integer(b.center) && integer(b.radius) && pair(b.axisScale) && pair(b.overrides)
      : b.kind === 'point' ? pair(b.samples) && integer(b.position) && integer(b.axis)
      : b.kind === 'position' ? integer(b.position) && integer(b.axis)
      : b.kind === 'segment' && integer(b.start) && integer(b.end) && integer(b.axis)))
    && new Set(v.map(b => b.instance)).size === v.length;
}
export function createEffectOriginReader(bindings: EffectOriginBinding[] | undefined,
  objects: ConstructorRecord[]) {
  if (bindings !== undefined && !validEffectOrigins(bindings)) throw Error('invalid effect origin bindings');
  const byInstance = new Map((bindings || []).map(b => [b.instance, b]));
  return (slot: number, ops: EffectExtra[]): EffectOrigin | null => {
    const b = byInstance.get(objects[slot]?.values[1]);
    if (!b) return null;
    const fields = new Map(ops.map(e => [e.op, e]));
    const scalar = (e: EffectExtra | undefined): number | null => {
      const n = e?.kind === 'float' ? e.value : e?.kind === 'fixed' && e.floats?.length === 1 ? e.floats[0] : null;
      return n !== null && Number.isFinite(n) ? n : null;
    };
    const range = (e: EffectExtra | undefined): [number, number] | null => {
      if (e?.kind !== 'typed' || e.class !== b.uniformClass || e.fields.length !== 2) return null;
      const lo = scalar(e.fields[0]), hi = scalar(e.fields[1]);
      return lo !== null && hi !== null ? [lo, hi] : null;
    };
    const vector = (e: EffectExtra | undefined): [number, number, number] | null =>
      e?.kind === 'vec3' && e.v.every(Number.isFinite) ? [...e.v] : null;
    // A sample field selects a sub-interval of its authored angle range. The
    // game interpolates the endpoints by the sampled fraction.
    const angles = (bounds: [number, number], sampleOp: number): [number, number] | null => {
      const lo = scalar(fields.get(bounds[0])), hi = scalar(fields.get(bounds[1]));
      const sample = fields.get(sampleOp);
      if (lo === null || hi === null) return null;
      const fraction = range(sample) ?? (() => { const n = scalar(sample); return n === null ? null : [n, n] as [number, number]; })();
      if (!fraction) return null;
      const result: [number, number] = [lo + (hi - lo) * fraction[0], lo + (hi - lo) * fraction[1]];
      return result.every(Number.isFinite) ? result : null;
    };
    if (b.kind === 'position' || b.kind === 'segment') {
      const axis = vector(fields.get(b.axis));
      const bounds = (ops: [number, number]): [number, number] | null => {
        const v = ops.map(op => scalar(fields.get(op)));
        return v.every(n => n !== null) ? v as [number, number] : null;
      };
      const yaw = bounds(b.yaw), pitch = bounds(b.pitch);
      if (!axis || !yaw || !pitch) return null;
      if (b.kind === 'position') {
        const position = vector(fields.get(b.position));
        return position ? {kind: 'point', point: {position, axis, yaw, pitch}} : null;
      }
      const from = vector(fields.get(b.start)), to = vector(fields.get(b.end));
      return from && to ? {kind: 'segment', segment: {from, to, axis, yaw, pitch}} : null;
    }
    if (b.kind === 'point') {
      const position = vector(fields.get(b.position)), axis = vector(fields.get(b.axis));
      const yaw = angles(b.yaw, b.samples[0]), pitch = angles(b.pitch, b.samples[1]);
      return position && axis && yaw && pitch ? {kind: 'point', point: {position, axis, yaw, pitch}} : null;
    }
    const resample = fields.get(b.resample);
    if (resample?.kind !== 'other' || resample.tag !== 12) return null;
    // Explicit expressions must not silently become literal geometry.
    if (b.overrides.some(op => { const e = fields.get(op); return e?.kind !== 'other' || e.tag !== 1; })) return null;
    const center = vector(fields.get(b.center));
    const radiusField = fields.get(b.radius);
    const radius = scalar(radiusField) ?? range(radiusField);
    if (!center || radius === null) return null;
    const scales = b.axisScale.map(op => scalar(fields.get(op)));
    if (scales.some(n => n === null)) return null;
    const yaw = angles(b.yaw, b.samples[0]), pitch = angles(b.pitch, b.samples[1]);
    if (!yaw || !pitch) return null;
    return {kind: 'radial', radial: {center, radius, axisScale: scales as [number, number], yaw, pitch}};
  };
}
