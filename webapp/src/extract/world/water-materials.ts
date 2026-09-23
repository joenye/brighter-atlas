// Optional per-build decode data is produced offline purely from analysis of
// the game's own files, never by inspecting or modifying a running game
// process or its memory. It locates the fields of the water surface and
// shoreline materials; every value is read from the user's bundle.
import {resolveValue} from './room-metadata.js';
import type {FillRow} from './replay.js';
import type {PoolNode} from './value-pool.js';

export interface WaterDecodeData {
  // A standard material links to its water material through one reference field.
  link: {families: number[]; field: number};
  surface: number; curtain: number;   // water material classes
  style: number;                      // their style reference field
  opacity: number;                    // the linking material's opacity field
  textureRect: number;                // its texture rectangle (u0, v0, u1, v1)
  styleFields: {
    colour: number; normal: number; cube: number;
    uv0: [number, number]; uv1: [number, number];   // scale, scroll
    amplitude: [number, number]; frequency: [number, number];
    rate: [number, number]; tilt: [number, number]; level: number;
  };
  textures: {plane: {family: number; image: number}; cube: {family: number; image: number}};
  waterLevel: number;                 // curtain tops at or above this height move
}

/** Two travelling sine waves (the first along x, the second along y) and a
 *  normal tilt per wave; heights in native units, rates in radians per tick. */
export interface WorldWaterWaves {
  amplitude: [number, number];
  frequency: [number, number];
  rate: [number, number];
  tilt: [number, number];
}
export interface WorldWaterStyle {
  colour: [number, number, number, number];      // authored RGBA
  normal: number;                                // image of the ripple normal map
  cube: number;                                  // image of the reflected sky
  // Per layer: texture scale per native unit, then scroll per tick.
  layers: [[number, number, number, number], [number, number, number, number]];
  waves: WorldWaterWaves;
  level: number;                                 // surface height offset
}
export interface WorldWaterMaterial {
  kind: 'surface' | 'curtain';
  style: number;                                 // index into styles
  opacity: number;
  window: [number, number];                      // curtain texture v range
}
export interface WorldWater {
  level: number;
  styles: WorldWaterStyle[];
  materials: Record<string, WorldWaterMaterial>;   // keyed by material slot
}

export function validWaterData(value: any): value is WaterDecodeData {
  const index = (v: any) => Number.isInteger(v) && v >= 0 && v < 65536;
  const pair = (v: any) => Array.isArray(v) && v.length === 2 && v.every(index);
  const f = value?.styleFields;
  return !!value && Array.isArray(value.link?.families) && value.link.families.length > 0
    && value.link.families.every(index) && index(value.link.field)
    && [value.surface, value.curtain, value.style, value.opacity, value.textureRect].every(index)
    && !!f && [f.colour, f.normal, f.cube, f.level].every(index)
    && [f.uv0, f.uv1, f.amplitude, f.frequency, f.rate, f.tilt].every(pair)
    && ['plane', 'cube'].every(k => index(value.textures?.[k]?.family) && index(value.textures?.[k]?.image))
    && Number.isFinite(value.waterLevel);
}

type RawField = {op: number; kind: string; node?: any; value?: any};

/** Resolve every material that draws through a water material. Returns null
 *  when the data is absent or nothing in the bundle matches it. */
export function readWorldWater(data: WaterDecodeData | undefined, rows: FillRow[],
  decode: (slot: number) => RawField[] | null, pool: PoolNode[]): WorldWater | null {
  if (data === undefined) return null;
  if (!validWaterData(data)) throw Error('invalid water bindings');
  const field = (slot: number, op: number): PoolNode | null => {
    const f = decode(slot)?.find(e => e.op === op);
    return f?.kind === 'G' ? resolveValue(pool, f.node) : null;
  };
  const floats = (n: PoolNode | null, tag: number, count: number): number[] | null =>
    n?.tag === tag && Array.isArray(n.value) && n.value.length === count && n.value.every(Number.isFinite)
      ? n.value.map(Number) : null;
  const float = (n: PoolNode | null) => floats(n, 0x0b, 1)?.[0] ?? null;
  const ref = (n: PoolNode | null, tag: number) => n?.tag === tag && Number.isInteger(n.value) ? n.value as number : null;
  const families = new Set(data.link.families);
  const styleIndex = new Map<number, number>();
  const styles: WorldWaterStyle[] = [];
  const f = data.styleFields;
  const readStyle = (slot: number): number | null => {
    if (styleIndex.has(slot)) return styleIndex.get(slot)!;
    const colour = floats(field(slot, f.colour), 0x15, 4);
    const image = (op: number, kind: 'plane' | 'cube') => {
      const record = ref(field(slot, op), 0x02);
      const binding = data.textures[kind];
      if (record === null || rows[record]?.runtime !== binding.family) return null;
      return ref(field(record, binding.image), 0x47);
    };
    const normal = image(f.normal, 'plane'), cube = image(f.cube, 'cube');
    const vec = (op: number) => floats(field(slot, op), 0x18, 2);
    const layer = ([scale, scroll]: [number, number]) => {
      const a = vec(scale), b = vec(scroll);
      return a && b ? [a[0], a[1], b[0], b[1]] as [number, number, number, number] : null;
    };
    const two = (ops: [number, number]) => {
      const v = ops.map(op => float(field(slot, op)));
      return v.every(x => x !== null) ? v as [number, number] : null;
    };
    const layers = [layer(f.uv0), layer(f.uv1)];
    const amplitude = two(f.amplitude), frequency = two(f.frequency), rate = two(f.rate), tilt = two(f.tilt);
    const level = float(field(slot, f.level));
    if (!colour || normal === null || cube === null || !layers[0] || !layers[1]
      || !amplitude || !frequency || !rate || !tilt || level === null) return null;
    styles.push({colour: colour as [number, number, number, number], normal, cube,
      layers: layers as WorldWaterStyle['layers'], waves: {amplitude, frequency, rate, tilt}, level});
    styleIndex.set(slot, styles.length - 1);
    return styles.length - 1;
  };
  // The rectangle's floats are stored little-endian; the generic value
  // reader decodes them big-endian, so reinterpret each one's bytes.
  const swapped = (v: number) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, v, false);
    return view.getFloat32(0, true);
  };
  const materials: Record<string, WorldWaterMaterial> = {};
  for (const row of rows) {
    if (!row || !families.has(row.runtime)) continue;
    const link = row.r?.find(([op]) => op === data.link.field)?.[1];
    if (link === undefined) continue;
    const water = rows[link];
    const kind = water?.runtime === data.surface ? 'surface' : water?.runtime === data.curtain ? 'curtain' : null;
    if (!kind) continue;
    const styleSlot = ref(field(link, data.style), 0x26);
    const style = styleSlot === null ? null : readStyle(styleSlot);
    const opacity = float(field(row.slot, data.opacity));
    const rect = floats(field(row.slot, data.textureRect), 0x3c, 4)?.map(swapped);
    if (style === null || opacity === null || !rect || !rect.every(Number.isFinite)) continue;
    materials[String(row.slot)] = {kind, style, opacity, window: [rect[1], rect[3]]};
  }
  return Object.keys(materials).length ? {level: data.waterLevel, styles, materials} : null;
}
