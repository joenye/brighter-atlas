// How the game draws a build: the shader pair and state of every program,
// vertex formats, samplers, the material fields that choose programs, room
// environments and frame constants. render-shape.ts reads all of it from the
// user's bundles; the optional per-build decode data adds only the rooms whose
// lighting follows a quest and the dynamic-list field (RenderBuildData). That
// data is produced offline purely from analysis of the game's own files, never
// by inspecting or modifying a running game process or its memory. Values the
// game stores (lights, the sun direction, the shadow view) are read from the
// user's bundle at the offsets found there.
import {resolveValue} from './room-metadata.js';
import type {FillRow} from './replay.js';
import {PoolDecoder, profileArities, type PoolNode} from './value-pool.js';
import type {WorldProfile} from './profile.js';


export interface RenderDecodeData {
  /** [vertex, pixel, depth comparison (0: none), depth write, blend (-1: none), cull (-1: none), index format]. */
  programs: number[][];
  /** Engine vertex formats of each vertex shader's elements, packed in order. */
  vertexShaders: number[][];
  /** Sampler index of each pixel shader binding (-1: fetch only). */
  pixelShaders: number[][];
  /** [filter, address u, v, w, comparison, min lod, max lod, lod bias, anisotropy] (D3D11 values). */
  samplers: number[][];
  /** [op, src, dst, alpha op, alpha src, alpha dst] (D3D11 values). */
  blends: number[][];
  materials: {
    families: number[];
    fields: {programs: number; depth: number; specular: [number, number, number]; opacity: number; texture: number};
    keys: {shadows: [string, string]; ssao: [string, string]; vignette: [string, string]; colours: string};
  };
  /** Water programs in key order (skinned, 32-bit indices, vignette): FFT FFF FTT FTF TFT TFF TTT TTF. */
  waterPrograms: {surface: number[]; curtain: number[]};
  lighting: {directionOffset: number; gamma: number; fade: number};
  environment: {
    assetValue: number; family: number; field: number; presetClass: number;
    slots: {sky: number; ground: number; sun: number; vignette: number; height: number; floor: number};
    light: {field: number; colour: number; intensity: number};
    avatarZ: string;
    overrides: {roomRuntime: number; presetOffset: number}[];
    /** Rooms whose environment follows a quest: the quest variable and, from
     *  each of its states on, the preset shown ([state, preset offset], -1:
     *  the room's own); with the fields that name the quest. */
    story?: {
      fields: {variableQuest: number; variableStates: number; questName: number; questRegion: number; regionName: number};
      rooms: {roomRuntime: number; variable: number; steps: [number, number][]}[];
    };
  };
  shadow: {size: number; lightViewOffset: number; normalOffsetTexels: number; borderTexels: number; marginTiles: number; layerHeight: number};
  ssao: {unit: number; radius: number; falloff: number; padDivisor: number; temporalBase: number; temporalDivisor: number; frameMs: number;
    programs: {mips: number[]; sao: number; blurH: number; blurV: number}; fullscreenVertex: number};
  /** The element record field that sends an element through the scene's
   *  dynamic list, drawn after every static group. */
  scene?: {dynamicField: number};
  camera: {fov: number; near: number; far: number; pitch: number};
  vignette: {radius: number; overlayRadius: number; avatarFloor: [number, number, number, number]; avatarOffset: number};
  clock: {ticksPerSecond: number};
}

const index = (v: any) => Number.isInteger(v) && v >= 0 && v < 1 << 30;
const signedIndex = (v: any) => Number.isInteger(v) && v >= -1 && v < 1 << 30;
const finite = (v: any) => typeof v === 'number' && Number.isFinite(v);
const table = (rows: any, width: number, cell = index) => Array.isArray(rows) && rows.length <= 65536
  && rows.every((r: any) => Array.isArray(r) && (width < 0 || r.length === width) && r.every(cell));

export function validRenderData(d: any): d is RenderDecodeData {
  if (!d || !table(d.programs, 7, signedIndex) || !table(d.vertexShaders, -1) || !table(d.pixelShaders, -1, signedIndex)
    || !table(d.samplers, 9, finite) || !table(d.blends, 6)) return false;
  const nv = d.vertexShaders.length, np = d.pixelShaders.length;
  if (d.programs.some((p: number[]) => p[0] >= nv || p[1] >= np || p[4] >= d.blends.length)) return false;
  if (d.pixelShaders.some((p: number[]) => p.some(s => s >= d.samplers.length))) return false;
  const m = d.materials, f = m?.fields, k = m?.keys;
  const names = (v: any) => Array.isArray(v) && v.length === 2 && v.every((s: any) => typeof s === 'string');
  if (!m || !Array.isArray(m.families) || !m.families.every(index) || !f
    || ![f.programs, f.depth, f.opacity, f.texture].every(index) || !Array.isArray(f.specular) || f.specular.length !== 3
    || !f.specular.every(index) || !k || !names(k.shadows) || !names(k.ssao) || !names(k.vignette) || typeof k.colours !== 'string') return false;
  const water = d.waterPrograms;
  if (!water || !['surface', 'curtain'].every(w => Array.isArray(water[w]) && water[w].length === 8
    && water[w].every((p: any) => index(p) && p < d.programs.length))) return false;
  const e = d.environment;
  if (!e || ![e.assetValue, e.family, e.field, e.presetClass].every(index)
    || !['sky', 'ground', 'sun', 'vignette', 'height', 'floor'].every(s => index(e.slots?.[s]))
    || !['field', 'colour', 'intensity'].every(s => index(e.light?.[s])) || typeof e.avatarZ !== 'string'
    || !Array.isArray(e.overrides) || !e.overrides.every((o: any) => index(o?.roomRuntime) && index(o?.presetOffset))) return false;
  if (e.story !== undefined && (!e.story?.fields
    || !['variableQuest', 'variableStates', 'questName', 'questRegion', 'regionName'].every(k => index(e.story.fields[k]))
    || !Array.isArray(e.story.rooms) || !e.story.rooms.every((r: any) => index(r?.roomRuntime) && index(r?.variable)
      && Array.isArray(r.steps) && r.steps.length > 0 && r.steps.every((st: any) => Array.isArray(st) && st.length === 2
        && index(st[0]) && (st[1] === -1 || index(st[1])))))) return false;
  if (d.scene !== undefined && !index(d.scene?.dynamicField)) return false;
  const s = d.shadow, a = d.ssao, c = d.camera, v = d.vignette;
  return !!d.lighting && index(d.lighting.directionOffset) && finite(d.lighting.gamma) && finite(d.lighting.fade)
    && !!s && [s.size, s.lightViewOffset, s.normalOffsetTexels, s.borderTexels, s.marginTiles, s.layerHeight].every(index)
    && !!a && [a.unit, a.radius, a.falloff, a.padDivisor, a.temporalBase, a.temporalDivisor, a.frameMs].every(finite)
    && Array.isArray(a.programs?.mips) && a.programs.mips.length === 5
    && [...a.programs.mips, a.programs.sao, a.programs.blurH, a.programs.blurV].every((p: any) => index(p) && p < d.programs.length)
    && index(a.fullscreenVertex) && a.fullscreenVertex < nv
    && !!c && [c.fov, c.near, c.far, c.pitch].every(finite) && c.near > 0 && c.far > c.near
    && !!v && [v.radius, v.overlayRadius, v.avatarOffset].every(finite) && Array.isArray(v.avatarFloor)
    && v.avatarFloor.length === 4 && v.avatarFloor.every(finite)
    && finite(d.clock?.ticksPerSecond) && d.clock.ticksPerSecond > 0;
}

/** What only the per-build decode data can tell about how a build draws
 *  (render-shape.ts reads the rest from the user's bundles): the rooms whose
 *  lighting follows a quest, and the element field of the dynamic list. */
export interface RenderBuildData {
  story?: {rooms: {roomRuntime: number; variable: number; steps: [number, number][]}[]};
  scene?: {dynamicField: number};
}

export function validRenderBuildData(d: any): d is RenderBuildData {
  if (!d || typeof d !== 'object') return false;
  if (d.story !== undefined && !(Array.isArray(d.story?.rooms) && d.story.rooms.every((r: any) => index(r?.roomRuntime)
    && index(r?.variable) && Array.isArray(r.steps) && r.steps.length > 0 && r.steps.every((st: any) => Array.isArray(st)
      && st.length === 2 && index(st[0]) && (st[1] === -1 || index(st[1])))))) return false;
  return d.scene === undefined || index(d.scene?.dynamicField);
}

type RawField = {op: number; kind: string; node?: any; value?: any};
type Decode = (slot: number) => RawField[] | null;

/** A record reference's slot (-1: not a reference). */
export const recordRef = (n: PoolNode | null): number => (n && (n.tag === 0x26 || n.tag === 0x02) && Number.isInteger(n.value) ? n.value as number : -1);

/** A record's generic field, resolved through the pool. */
export function recordField(rows: FillRow[], decode: Decode, pool: PoolNode[], slot: number, op: number): PoolNode | null {
  const e = slot >= 0 && rows[slot] ? decode(slot)?.find(x => x.op === op) : null;
  return e?.kind === 'G' ? resolveValue(pool, e.node) : null;
}

/** A material's programs: main-pass keys [skinned, 32-bit, shadows, ssao, vignette, program],
 *  depth-pass keys [skinned, 32-bit, program], its specular bytes and opacity. */
export interface RenderMaterial {
  main: number[][];
  depth: number[][];
  specular: [number, number, number];
  opacity: number;
}

/** A room whose lighting follows a quest: the quest's name, its number of
 *  states, and the environment shown from each state on. */
export interface StoryEnvironment {
  quest: string;
  states: number;
  steps: {from: number; environment: RenderEnvironment}[];
}

/** Light values of one scene environment (colours authored, before the 2.2 power). */
export interface RenderEnvironment {
  sky: number[]; ground: number[]; sun: number[];   // [r, g, b, intensity]
  vignette: number[];                                // [r, g, b, a]
  height: number | 'avatar';                         // height fade range, or follows the focus
  floor: number | 'avatar';                          // height fade floor, or follows the focus
}

/** Program tables of every standard material. */
export function readRenderMaterials(data: RenderDecodeData, rows: FillRow[], decode: Decode,
  pool: PoolNode[], symbols: string[]): Record<string, RenderMaterial> {
  const families = new Set(data.materials.families);
  const f = data.materials.fields, keys = data.materials.keys;
  const field = (slot: number, op: number) => recordField(rows, decode, pool, slot, op);
  const flag = (n: PoolNode | null) => (n?.tag === 0x0c ? 1 : n?.tag === 0x0d ? 0 : -1);
  const symbol = (n: PoolNode | null) => (n?.tag === 0x0f && Number.isInteger(n.value) ? symbols[n.value] : null);
  const pick = (n: PoolNode | null, pair: [string, string]) => {
    const s = symbol(n);
    return s === pair[0] ? 0 : s === pair[1] ? 1 : -1;
  };
  const pairs = (n: PoolNode | null): [PoolNode, PoolNode][] | null => {
    if (n?.tag !== 0x2c || !Array.isArray(n.values) || n.values.length % 2) return null;
    const half = n.values.length / 2, out: [PoolNode, PoolNode][] = [];
    for (let i = 0; i < half; i++) {
      const key = resolveValue(pool, n.values[i]), value = resolveValue(pool, n.values[half + i]);
      if (!key || !value) return null;
      out.push([key, value]);
    }
    return out;
  };
  const program = (n: PoolNode) => (n.tag === 0x67 && Number.isInteger(n.value) && n.value < data.programs.length ? n.value : -1);
  const out: Record<string, RenderMaterial> = {};
  for (const row of rows) {
    if (!row || !families.has(row.runtime)) continue;
    const main: number[][] = [], depth: number[][] = [];
    for (const [key, value] of pairs(field(row.slot, f.programs)) ?? []) {
      const k = (key.fields ?? []).map(n => resolveValue(pool, n));
      const p = program(value);
      if (k.length < 6 || p < 0 || symbol(k[5]) !== keys.colours) continue;
      const width = k[1]?.value;
      const row6 = [flag(k[0]), width, pick(k[2], keys.shadows), pick(k[3], keys.ssao), pick(k[4], keys.vignette), p];
      if (row6.slice(0, 5).some(v => v !== 0 && v !== 1)) continue;
      main.push(row6);
    }
    for (const [key, value] of pairs(field(row.slot, f.depth)) ?? []) {
      const k = (key.fields ?? []).map(n => resolveValue(pool, n));
      const p = program(value);
      if (k.length < 3 || p < 0 || symbol(k[2]) !== keys.colours) continue;
      const r = [flag(k[0]), k[1]?.value, p];
      if (r.slice(0, 2).some(v => v !== 0 && v !== 1)) continue;
      depth.push(r);
    }
    if (!main.length) continue;
    const byte = (op: number) => {
      const n = field(row.slot, op);
      return n?.tag === 0x0a && Number.isInteger(n.value) ? n.value & 0xff : 0;
    };
    const opacity = field(row.slot, f.opacity);
    out[row.slot] = {main, depth, specular: [byte(f.specular[0]), byte(f.specular[1]), byte(f.specular[2])],
      opacity: opacity?.tag === 0x0b && Array.isArray(opacity.value) && Number.isFinite(opacity.value[0]) ? opacity.value[0] : 1};
  }
  return out;
}

/** Decode one archived value at an AB0 byte offset. */
export function archivedValue(ab0: Uint8Array, profile: WorldProfile, offset: number): PoolNode {
  const decoder = new PoolDecoder(ab0.subarray(offset), ...profileArities(profile));
  return decoder.value();
}

/** Archived floats (tag and count checked). */
export function archivedFloats(ab0: Uint8Array, profile: WorldProfile, offset: number, tag: number, count: number): number[] {
  const node = archivedValue(ab0, profile, offset);
  if (node.tag !== tag || !Array.isArray(node.value) || node.value.length !== count || !node.value.every(Number.isFinite)) {
    throw Error(`archived value at ${offset} is not ${count} floats`);
  }
  return node.value.map(Number);
}

/** Resolve a scene environment preset (a class-345 value). */
export function readEnvironmentPreset(data: RenderDecodeData, preset: PoolNode | null, rows: FillRow[],
  decode: Decode, pool: PoolNode[], symbols: string[]): RenderEnvironment | null {
  const env = data.environment;
  if (preset?.tag !== 0x24 || preset.class !== env.presetClass || !Array.isArray(preset.fields)) return null;
  const slot = (i: number) => resolveValue(pool, preset.fields![i]);
  const linked = (n: PoolNode | null) => recordField(rows, decode, pool, recordRef(n), env.light.field);
  // A light is a {colour, intensity} value held inline or in a record.
  const light = (n: PoolNode | null): number[] | null => {
    const value = n?.tag === 0x24 ? n : linked(n);
    if (value?.tag !== 0x24 || !Array.isArray(value.fields)) return null;
    const colour = resolveValue(pool, value.fields[env.light.colour]);
    const intensity = resolveValue(pool, value.fields[env.light.intensity]);
    if (colour?.tag !== 0x15 || !Array.isArray(colour.value) || intensity?.tag !== 0x0b) return null;
    return [colour.value[0], colour.value[1], colour.value[2], intensity.value[0]].map(Number);
  };
  // A height or floor is a number held inline or in a record, or the
  // avatar-height symbol.
  const scalar = (n: PoolNode | null): number | 'avatar' | null => {
    const value = n?.tag === 0x0b || n?.tag === 0x0a || n?.tag === 0x0f ? n : linked(n);
    if (value?.tag === 0x0b && Array.isArray(value.value)) return Number(value.value[0]);
    if (value?.tag === 0x0a && Number.isInteger(value.value)) return value.value;
    if (value?.tag === 0x0f && symbols[value.value] === env.avatarZ) return 'avatar';
    return null;
  };
  const sky = light(slot(env.slots.sky)), ground = light(slot(env.slots.ground)), sun = light(slot(env.slots.sun));
  const vignetteSlot = slot(env.slots.vignette);
  const vignetteNode = vignetteSlot?.tag === 0x15 ? vignetteSlot : linked(vignetteSlot);
  const vignette = vignetteNode?.tag === 0x15 && Array.isArray(vignetteNode.value) ? vignetteNode.value.map(Number) : null;
  const height = scalar(slot(env.slots.height)), floor = scalar(slot(env.slots.floor));
  if (!sky || !ground || !sun || !vignette || height === null || floor === null) return null;
  return {sky, ground, sun, vignette, height, floor};
}
