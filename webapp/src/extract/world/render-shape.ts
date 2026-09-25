// How the game draws a build, read from the user's own bundles: the program
// tables of the graphics header (graphics.ts), the water and ambient occlusion
// programs picked by their shaders' constants, the material and environment
// records found by shape, and the archived sun and shadow values. The values
// the engine fixes are the same in every build. The per-build decode data adds
// only what the bundles cannot tell: the rooms whose lighting follows a quest,
// and the element field that sends an element to the dynamic list.
import type { GraphicsHeader } from '../graphics.js';
import { chunks, parseReflection, parseSignature, shaderBlobs } from '../../viewers/world/dxbc.js';
import type { RenderBuildData, RenderDecodeData } from './render-data.js';
import { resolveValue } from './room-metadata.js';
import type { FillRow } from './replay.js';
import type { PoolNode } from './value-pool.js';

// Stored state values and the D3D11 values they stand for.
const DEPTH = new Map([[3, 2], [4, 4], [7, 8]]);
const BLEND = new Map<string, number[]>([
  ['0,0,8,9,1,3', [1, 5, 6, 1, 2, 6]], ['0,0,1,1,1,3', [1, 2, 2, 1, 2, 6]],
  ['0,0,1,9,1,3', [1, 2, 6, 1, 2, 6]], ['0,0,4,9,1,3', [1, 9, 6, 1, 2, 6]],
]);
const SAMPLER = new Map<number, number[]>([
  [0x787, [21, 3, 3, 3, 1, 0, 15, 0, 1]], [0x3, [20, 3, 3, 3, 1, 0, 0, 0, 1]], [0x503, [20, 3, 3, 3, 1, 0, 10, 0, 1]],
  [0xa0787, [149, 3, 3, 3, 4, 0, 15, 0, 1]], [0x507, [21, 3, 3, 3, 1, 0, 10, 0, 1]], [0x2f87, [21, 1, 1, 3, 1, 0, 15, 0, 1]],
]);

/** Frame values the engine fixes. */
export const ENGINE = {
  lighting: { gamma: 2.2, fade: 1 },
  shadow: { size: 4096, normalOffsetTexels: 3, borderTexels: 1, marginTiles: 20, layerHeight: 512 },
  ssao: { unit: 500, radius: 1.5, falloff: -4 / 9, padDivisor: 10, temporalBase: 0.9, temporalDivisor: 10, frameMs: 16 },
  camera: { fov: 40, near: 512, far: 102400, pitch: 40 },
  vignette: { radius: 20480, overlayRadius: 10240, avatarFloor: [0, 0.75, 4096, 0.25] as [number, number, number, number], avatarOffset: -16 },
  clock: { ticksPerSecond: 600 },
  keys: {
    shadows: ['$utilise_shadows_false', '$utilise_shadows_true'] as [string, string],
    ssao: ['$utilise_ssao_false', '$utilise_ssao_true'] as [string, string],
    vignette: ['$vignette_false', '$vignette_true'] as [string, string],
    colours: '$vbo_colors',
  },
  environment: {
    slots: { sky: 0, ground: 1, sun: 3, vignette: 4, height: 5, floor: 6 },
    light: { field: 1, colour: 0, intensity: 1 },
    avatarZ: '$avatar_z',
  },
};

/** What the draw tables need from one shader. */
export interface ShaderFacts { names: Set<string>; outputs: number; mipLevel: number }

/** A bundle shader object's first shader, or null when it is not DXBC. */
export function shaderFacts(object: Uint8Array): ShaderFacts | null {
  try {
    const parts = chunks(shaderBlobs(object)[0]);
    const names = new Set<string>();
    for (const cb of parseReflection(parts.get('RDEF'))?.constantBuffers ?? []) {
      for (const v of cb.variables) { names.add(v.name); if (v.parent) names.add(v.parent); }
    }
    // A mip pass reads its level through the literal (2^L - 1, 2^L - 1, 0, 0).
    const code = parts.get('SHDR') ?? parts.get('SHEX');
    let mipLevel = 0;
    if (code) {
      const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
      for (let level = 1; level <= 5 && !mipLevel; level++) {
        const k = (1 << level) - 1;
        for (let at = 0; at + 16 <= code.length; at += 4) {
          if (view.getUint32(at, true) === k && view.getUint32(at + 4, true) === k
            && view.getUint32(at + 8, true) === 0 && view.getUint32(at + 12, true) === 0) { mipLevel = level; break; }
        }
      }
    }
    return { names, outputs: parseSignature(parts.get('OSGN')).length, mipLevel };
  } catch {
    return null;
  }
}

type Tables = Pick<RenderDecodeData, 'programs' | 'vertexShaders' | 'pixelShaders' | 'samplers' | 'blends' | 'waterPrograms'>
  & { ssaoPrograms: RenderDecodeData['ssao']['programs']; fullscreenVertex: number };

/** The draw tables, or null when a value is outside the engine's known set or a pick is not unique. */
export function renderTables(g: GraphicsHeader, vs: ShaderFacts[], ps: ShaderFacts[]): Tables | null {
  if (vs.length !== g.vertexShaders.length || ps.length !== g.pixelShaders.length) return null;
  const dedupe = (rows: number[][], index: Map<string, number>, row: number[]) => {
    const k = row.join(',');
    let i = index.get(k);
    if (i === undefined) { index.set(k, i = rows.length); rows.push(row); }
    return i;
  };
  const blends: number[][] = [], blendIndex = new Map<string, number>();
  const samplers: number[][] = [], samplerIndex = new Map<string, number>();
  const programs: number[][] = [];
  for (const p of g.programs) {
    const [v, s] = g.pairs[p.pair];
    const d = p.depth >= 0 ? g.depths[p.depth] : null;
    const comparison = d ? DEPTH.get(d.comparison) : 0;
    const blend = p.blend >= 0 ? BLEND.get(g.blends[p.blend].join(',')) : null;
    if (comparison === undefined || blend === undefined) return null;
    programs.push([v, s, comparison, d?.write ? 1 : 0, blend ? dedupe(blends, blendIndex, blend) : -1, p.cull, p.indexFormat]);
  }
  const vertexShaders = g.vertexShaders.map((v) => (v.layouts.length ? g.layouts[v.layouts[0]].formats : []));
  const pixelShaders: number[][] = [];
  for (const p of g.pixelShaders) {
    const row: number[] = [];
    for (const t of p.textures) {
      if (t.sampler < 0) { row.push(-1); continue; }
      const sampler = SAMPLER.get(g.samplers[t.sampler]);
      if (!sampler) return null;
      row.push(dedupe(samplers, samplerIndex, sampler));
    }
    pixelShaders.push(row);
  }

  const skinned = (i: number) => g.vertexShaders[i].constants.some((c) => c.kind === 2);
  // Water programs: shaders with the wave constants; the surface also scrolls
  // its first texture. Keys (skinned, 32-bit indices, vignette), where the
  // vignette variant is the twin with more outputs.
  const water = (surface: boolean): number[] | null => {
    const shaders = vs.map((f, i) => i).filter((i) => vs[i].names.has('v_sine_wave_x')
      && vs[i].names.has('v_uv0_scale_and_translate') === surface);
    const rows = new Map<string, number>();
    for (let i = 0; i < g.programs.length; i++) {
      const v = g.pairs[g.programs[i].pair][0];
      if (!shaders.includes(v)) continue;
      const twins = shaders.filter((j) => skinned(j) === skinned(v));
      if (twins.length !== 2 || vs[twins[0]].outputs === vs[twins[1]].outputs) return null;
      const vignette = vs[v].outputs === Math.max(...twins.map((j) => vs[j].outputs));
      const key = `${skinned(v)},${g.programs[i].indexFormat === 1},${vignette}`;
      if (rows.has(key)) return null;
      rows.set(key, i);
    }
    const order: number[] = [];
    for (const s of [false, true]) for (const w of [false, true]) for (const vig of [true, false]) {
      const p = rows.get(`${s},${w},${vig}`);
      if (p === undefined) return null;
      order.push(p);
    }
    return order;
  };
  const surface = water(true), curtain = water(false);
  const one = (list: number[]) => (list.length === 1 ? list[0] : -1);
  const programOf = (s: number) => one(g.programs.map((p, i) => i).filter((i) => g.pairs[g.programs[i].pair][1] === s));
  const out = (p: { outputs: number[] }, v: number) => p.outputs.length === 1 && p.outputs[0] === v;
  const mips = g.pixelShaders.map((p, i) => i).filter((i) => out(g.pixelShaders[i], 16))
    .sort((a, b) => ps[a].mipLevel - ps[b].mipLevel);
  const sao = one(ps.map((f, i) => i).filter((i) => ps[i].names.has('v_reprojection_matrix')));
  const blurV = one(g.pixelShaders.map((p, i) => i).filter((i) => out(g.pixelShaders[i], 0)));
  const blurH = one(g.pixelShaders.map((p, i) => i).filter((i) => {
    const p = g.pixelShaders[i];
    return !p.constants.length && p.textures.length === 1 && p.textures[0].sampler < 0 && out(p, 3);
  }));
  if (!surface || !curtain || mips.length !== 5 || new Set(mips.map((i) => ps[i].mipLevel)).size !== 5
    || sao < 0 || blurV < 0 || blurH < 0) return null;
  const ssaoPrograms = { mips: mips.map(programOf), sao: programOf(sao), blurH: programOf(blurH), blurV: programOf(blurV) };
  const all = [...ssaoPrograms.mips, ssaoPrograms.sao, ssaoPrograms.blurH, ssaoPrograms.blurV];
  if (all.some((p) => p < 0)) return null;
  const fullscreen = [...new Set(all.map((p) => programs[p][0]))];
  if (fullscreen.length !== 1) return null;
  return { programs, vertexShaders, pixelShaders, samplers, blends, waterPrograms: { surface, curtain }, ssaoPrograms,
    fullscreenVertex: fullscreen[0] };
}

/** The archived sun direction and shadow light view: the one orthonormal
 *  rotation (tag 0x30) whose second row points against a stored direction
 *  (tag 0x22). Byte offsets of both values, or null unless exactly one pair.
 *  Both are global values, stored between the constructor and fill streams
 *  (every build so far); the scan keeps to [from, to). */
export function lightOffsets(ab0: Uint8Array, from = 0, to = ab0.length): { direction: number; lightView: number } | null {
  const view = new DataView(ab0.buffer, ab0.byteOffset, ab0.byteLength);
  const f = (at: number) => view.getFloat32(at, false);
  const rotations: { at: number; y: number[] }[] = [];
  for (let at = from; at + 49 <= to; at++) {
    if (ab0[at] !== 0x30) continue;
    const m: number[] = [];
    for (let k = 0; k < 12; k++) m.push(f(at + 1 + 4 * k));
    if (!m.every(Number.isFinite)) continue;
    const r = [m.slice(0, 3), m.slice(4, 7), m.slice(8, 11)];
    let ok = r[1].every((x) => Math.abs(x) > 1e-3);
    for (let p = 0; p < 3 && ok; p++) for (let q = 0; q < 3 && ok; q++) {
      const dot = r[p][0] * r[q][0] + r[p][1] * r[q][1] + r[p][2] * r[q][2];
      if (Math.abs(dot - (p === q ? 1 : 0)) > 1e-4) ok = false;
    }
    if (ok) rotations.push({ at, y: r[1] });
  }
  if (!rotations.length) return null;
  const pairs: { direction: number; lightView: number }[] = [];
  for (let at = from; at + 13 <= to; at++) {
    if (ab0[at] !== 0x22) continue;
    const d = [f(at + 1), f(at + 5), f(at + 9)];
    const length = Math.hypot(d[0], d[1], d[2]);
    if (!(length > 1e-6)) continue;
    for (const r of rotations) {
      if (d.every((x, k) => Math.abs(x / length + r.y[k]) < 1e-4)) pairs.push({ direction: at, lightView: r.at });
    }
  }
  return pairs.length === 1 ? pairs[0] : null;
}

type Decode = (slot: number) => { op: number; kind: string; node?: any }[] | null;

interface Registry { rows: FillRow[]; pool: PoolNode[]; decode: Decode; symbols: string[] }

const tally = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
const top = <K>(m: Map<K, number>): K | null => {
  let best: K | null = null, n = -1;
  for (const [k, c] of m) if (c > n) { best = k; n = c; }
  return best;
};

/** A record's generic fields, resolved. */
function fieldsOf(reg: Registry, slot: number): Map<number, PoolNode> {
  const out = new Map<number, PoolNode>();
  let decoded: ReturnType<Decode> = null;
  try { decoded = reg.decode(slot); } catch { decoded = null; }
  for (const f of decoded ?? []) {
    if (f.kind !== 'G') continue;
    const n = resolveValue(reg.pool, f.node);
    if (n) out.set(f.op, n);
  }
  return out;
}

/** Records with a depth-0 value of this shape (inline or pooled). */
function rowsHolding(reg: Registry, test: (n: PoolNode) => boolean): number[] {
  const pooled = new Map<number, boolean>();
  const out: number[] = [];
  for (const row of reg.rows) {
    for (const e of row.g ?? []) {
      if (e[1] !== 0) continue;
      let hit = false;
      if (e[2] === 0 && Number.isInteger(e[3])) {
        const index = e[3] as number;
        let v = pooled.get(index);
        if (v === undefined) { const n = resolveValue(reg.pool, { tag: 0, value: index } as PoolNode); pooled.set(index, v = !!n && test(n)); }
        hit = v;
      } else if (e[2] === 0x2c || e[2] === 0x24) hit = true;   // inline: confirmed on decode
      if (hit) { out.push(row.slot); break; }
    }
  }
  return out;
}

/** Standard materials: the records mapping draw keys to programs, found by
 *  their key shapes (a six-value main key and a three-value depth key, each
 *  ending in the vertex colours symbol). */
export function materialLayout(reg: Registry): RenderDecodeData['materials'] | null {
  const colours = reg.symbols.indexOf(ENGINE.keys.colours);
  if (colours < 0) return null;
  const keyWidth = (n: PoolNode): number => {
    if (n.tag !== 0x2c || !Array.isArray(n.values) || n.values.length < 2 || n.values.length % 2) return 0;
    const half = n.values.length / 2;
    const key = resolveValue(reg.pool, n.values[0]), value = resolveValue(reg.pool, n.values[half]);
    if (key?.tag !== 0x24 || !Array.isArray(key.fields) || value?.tag !== 0x67) return 0;
    const last = resolveValue(reg.pool, key.fields[key.fields.length - 1]);
    return last?.tag === 0x0f && last.value === colours ? key.fields.length : 0;
  };
  const main = new Map<string, number>(), depth = new Map<string, number>();
  const rowsOf = new Map<string, Set<number>>();
  for (const slot of rowsHolding(reg, (n) => keyWidth(n) > 0)) {
    const rt = reg.rows[slot].runtime as number;
    for (const [op, n] of fieldsOf(reg, slot)) {
      const w = keyWidth(n);
      const k = `${rt}:${op}`;
      if (w === 6) tally(main, k); else if (w === 3) tally(depth, k); else continue;
      let s = rowsOf.get(k);
      if (!s) rowsOf.set(k, s = new Set());
      s.add(slot);
    }
  }
  const opOf = (m: Map<string, number>) => {
    const byOp = new Map<number, number>();
    for (const [k, c] of m) byOp.set(Number(k.split(':')[1]), (byOp.get(Number(k.split(':')[1])) ?? 0) + c);
    return top(byOp);
  };
  const programsOp = opOf(main), depthOp = opOf(depth);
  if (programsOp === null || depthOp === null) return null;
  const families = [...new Set([...main.keys()].filter((k) => Number(k.split(':')[1]) === programsOp)
    .map((k) => Number(k.split(':')[0])))].sort((a, b) => a - b);
  // Per-material values: three small integers in a row (specular) and a
  // float in [0, 1] (opacity), at the same ops in nearly every material.
  const slots = [...new Set(families.flatMap((rt) => [...(rowsOf.get(`${rt}:${programsOp}`) ?? [])]))];
  const fields = slots.map((s) => fieldsOf(reg, s));
  const byte = (n: PoolNode) => n.tag === 0x0a && Number.isInteger(n.value) && (n.value as number) >= 0 && (n.value as number) <= 255;
  const unit = (n: PoolNode) => n.tag === 0x0b && Array.isArray(n.value) && n.value.length === 1 && n.value[0] >= 0 && n.value[0] <= 1;
  const bytes = new Map<number, number>(), units = new Map<number, number>();
  for (const f of fields) for (const [op, n] of f) { if (byte(n)) tally(bytes, op); else if (unit(n)) tally(units, op); }
  const everywhere = (m: Map<number, number>, op: number) => (m.get(op) ?? 0) >= 0.95 * fields.length;
  const ops = [...new Set(fields.flatMap((f) => [...f.keys()]))].sort((a, b) => a - b);
  const specular = ops.find((op) => [op, op + 1, op + 2].every((o) => everywhere(bytes, o)));
  const opacity = ops.find((op) => everywhere(units, op));
  if (specular === undefined || opacity === undefined) return null;
  return {
    families, keys: ENGINE.keys,
    fields: { programs: programsOp, depth: depthOp, specular: [specular, specular + 1, specular + 2], opacity, texture: 0 },
  };
}

/** Room scene environments: the preset class (seven values: three lights
 *  around a flag, a vignette colour, a height and a floor), the environment
 *  records holding one, and the field that holds it. */
export function environmentLayout(reg: Registry): { family: number; field: number; presetClass: number } | null {
  const light = (n: PoolNode | null) => !!n && (n.tag === 0x26 || (n.tag === 0x24 && Array.isArray(n.fields)
    && n.fields.length === 2 && resolveValue(reg.pool, n.fields[0])?.tag === 0x15 && resolveValue(reg.pool, n.fields[1])?.tag === 0x0b));
  const preset = (n: PoolNode): boolean => {
    if (n.tag !== 0x24 || !Array.isArray(n.fields) || n.fields.length !== 7) return false;
    const f = n.fields.map((x) => resolveValue(reg.pool, x));
    const tag = (i: number, ...tags: number[]) => !!f[i] && tags.includes(f[i]!.tag);
    return light(f[0]) && light(f[1]) && tag(2, 0x0c, 0x0d) && light(f[3]) && tag(4, 0x15, 0x26)
      && tag(5, 0x0b, 0x0a, 0x26) && tag(6, 0x0b, 0x0a, 0x26, 0x0f);
  };
  const classes = new Map<number, number>();
  for (const n of reg.pool) if (n && preset(n)) tally(classes, n.class as number);
  const presetClass = top(classes);
  if (presetClass === null) return null;
  const holders = new Map<string, number>();
  for (const slot of rowsHolding(reg, (n) => n.tag === 0x24 && n.class === presetClass)) {
    for (const [op, n] of fieldsOf(reg, slot)) {
      if (n.tag === 0x24 && n.class === presetClass) tally(holders, `${reg.rows[slot].runtime}:${op}`);
    }
  }
  const holder = top(holders);
  if (holder === null) return null;
  const [family, field] = holder.split(':').map(Number);
  return { family, field, presetClass };
}

/** Which fields name a quest-lit room's quest: on the quest variable, its
 *  state list and its quest; on the quest, its name and region; on the
 *  region, its name. */
export function storyFields(reg: Registry, variable: number, charsetText: (n: PoolNode | null) => string | null):
  NonNullable<RenderDecodeData['environment']['story']>['fields'] | null {
  const v = fieldsOf(reg, variable);
  const ref = (n: PoolNode | null | undefined) => (n?.tag === 0x26 && Number.isInteger(n.value) ? n.value as number : -1);
  const firstText = (f: Map<number, PoolNode>) => [...f].find(([, n]) => charsetText(n) !== null)?.[0];
  let variableStates: number | undefined, variableQuest: number | undefined;
  for (const [op, n] of v) {
    if (variableStates === undefined && Array.isArray(n.values) && n.values.length
      && n.values.every((x) => ref(resolveValue(reg.pool, x)) >= 0)) variableStates = op;
    else if (variableQuest === undefined && ref(n) >= 0 && firstText(fieldsOf(reg, ref(n))) !== undefined) variableQuest = op;
  }
  if (variableStates === undefined || variableQuest === undefined) return null;
  const quest = fieldsOf(reg, ref(v.get(variableQuest)));
  const questName = firstText(quest);
  let questRegion: number | undefined, regionName: number | undefined;
  // the region: the first record named in words (icon glyphs are not letters)
  const named = (f: Map<number, PoolNode>) => [...f].find(([, n]) => /\p{L}/u.test(charsetText(n) ?? ''))?.[0];
  for (const [op, n] of quest) {
    if (ref(n) < 0) continue;
    const name = named(fieldsOf(reg, ref(n)));
    if (name !== undefined) { questRegion = op; regionName = name; break; }
  }
  if (questName === undefined || questRegion === undefined || regionName === undefined) return null;
  return { variableQuest, variableStates, questName, questRegion, regionName };
}

/** Everything the viewer needs to draw a build as the game does, or null
 *  when the bundles do not give it (no graphics header or shaders, or a
 *  value outside the engine's known set). The environment's room value is
 *  chosen from the rooms (environment.assetValue, set by the caller). */
export function deriveRenderData(src: {
  graphics: GraphicsHeader | null; vertex: ShaderFacts[] | null; pixel: ShaderFacts[] | null;
  ab0: Uint8Array; globals?: [number, number]; reg: Registry; text: (n: PoolNode | null) => string | null;
}, build: RenderBuildData | null): RenderDecodeData | null {
  if (!src.graphics || !src.vertex || !src.pixel || src.vertex.some((f) => !f) || src.pixel.some((f) => !f)) return null;
  const tables = renderTables(src.graphics, src.vertex, src.pixel);
  const lights = lightOffsets(src.ab0, ...(src.globals ?? []));
  const materials = materialLayout(src.reg);
  const environment = environmentLayout(src.reg);
  if (!tables || !lights || !materials || !environment) return null;
  const rooms = build?.story?.rooms ?? [];
  const fields = rooms.length ? storyFields(src.reg, rooms[0].variable, src.text) : null;
  const overrides = rooms.flatMap((r) => {
    const preset = r.steps[r.steps.length - 1][1];
    return preset >= 0 ? [{ roomRuntime: r.roomRuntime, presetOffset: preset }] : [];
  });
  const { ssaoPrograms, fullscreenVertex, ...draw } = tables;
  return {
    ...draw, materials,
    lighting: { directionOffset: lights.direction, ...ENGINE.lighting },
    environment: { assetValue: 0, ...environment, ...ENGINE.environment, overrides,
      ...(fields ? { story: { fields, rooms } } : {}) },
    shadow: { size: ENGINE.shadow.size, lightViewOffset: lights.lightView, normalOffsetTexels: ENGINE.shadow.normalOffsetTexels,
      borderTexels: ENGINE.shadow.borderTexels, marginTiles: ENGINE.shadow.marginTiles, layerHeight: ENGINE.shadow.layerHeight },
    ssao: { ...ENGINE.ssao, programs: ssaoPrograms, fullscreenVertex },
    ...(build?.scene ? { scene: build.scene } : {}),
    camera: ENGINE.camera, vignette: ENGINE.vignette, clock: ENGINE.clock,
  };
}
