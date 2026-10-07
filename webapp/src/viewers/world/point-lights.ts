// Point lights (the game's, from its 07-Oct-2026 update on): the light list
// and the 32 x 32 cell grid the lit material programs read.
//
// A lit pixel shader looks its pixel up in the grid: the cell is
// floor((p.xy - origin) * scale + normal.xy * 0.01), clamped to 0..31, and the
// cell's four words hold up to eight light indices, two to a word in its low
// 16 bits (index 0: none). Light i is four texels of the light list from 4i:
//
//   0: position xyz, range                  (range at least 1)
//   1: colour^2.2 * intensity, falloff      (falloff at least 0.01)
//   2: specular, start fade (offset, scale), 0
//   3: spot axis * s, -cos(cone) * s         ((0,0,0,1) for an all-round light)
//
// and adds colour * pow(saturate(1 - d/range), falloff) * spot * fade * N.L to
// the pixel's light, scaled by the grid's fourth value. The spot term is
// saturate(s * (cos(angle off the axis) - cos(cone))) with
// s = 1 / max(cos(cone - feather) - cos(cone), 0.001); the start fade
// saturate(1 - 20 + along / (0.05 * start)) lights a spot only from 95% of
// its start distance along the axis.

import { THREE } from '../three-common.js';

/** One point light in the frame's native space (room frame). */
export interface GamePointLight {
  position: [number, number, number];
  range: number;
  /** Authored colour (0..1, before the 2.2 power). */
  colour: [number, number, number];
  intensity: number;
  falloff: number;
  specular: number;
  /** The spot's axis (unit, the way the light shines), or null for all round. */
  direction: [number, number, number] | null;
  /** The spot's half angle and its soft edge, degrees. */
  cone: number;
  feather: number;
  /** The distance along the axis the light starts at (0: from the light). */
  start: number;
}

export const GRID_CELLS = 32;
export const MAX_LIGHTS = 255;
export const LIGHTS_PER_CELL = 8;
/** The high half of every cell word: a normal float's exponent, so the word is
 *  never a denormal a GPU might flush (shaders read the low 16 bits only). */
const CELL_HIGH = 0x3f800000;

const f32 = Math.fround;
const cosd = (degrees: number) => f32(Math.cos(f32(f32(f32(degrees + degrees) * f32(Math.PI)) / 360)));
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** The four texels of one light, as the game packs them. */
export function packLight(light: GamePointLight): number[] {
  const { position: p, colour: c, intensity } = light;
  const lin = (v: number) => f32(f32(Math.pow(v, 2.2)) * intensity);
  const dir = light.direction ? normalise(light.direction) : null;
  let spot = [0, 0, 0, 1], start = [1, 0];
  if (dir) {
    const cone = clamp(light.cone, 0, 180), feather = clamp(light.feather, 0, cone);
    const s = f32(1 / Math.max(f32(cosd(cone - feather) - cosd(cone)), 0.001));
    spot = [f32(dir[0] * s), f32(dir[1] * s), f32(dir[2] * s), f32(f32(-cosd(cone)) * s)];
    if (light.start > 0) {
      const k = f32(0.05 * light.start);
      start = [f32(1 - f32(light.start / k)), f32(1 / f32(k * s))];
    }
  }
  return [
    p[0], p[1], p[2], Math.max(light.range, 1),
    lin(c[0]), lin(c[1]), lin(c[2]), Math.max(light.falloff, 0.01),
    light.specular, start[0], start[1], 0,
    ...spot,
  ];
}

function normalise(v: [number, number, number]): [number, number, number] | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

export interface PackedPointLights {
  /** The light list: (MAX_LIGHTS + 1) * 4 texels of four floats (light 0 unused). */
  data: Float32Array;
  /** The cells, row by row (y, then x): four words each. */
  cells: Uint32Array;
  /** (origin x, origin y, cells per native unit). */
  grid: [number, number, number];
  count: number;
}

/** A light in the list the grid is built from: the light, its group (0: scenery, 1: models) and how bright it is. */
export interface ListedLight { light: GamePointLight; group: 0 | 1; brightness: number }

/** The game's light brightness, for ranking: the brighter of its colours times its intensity. */
export function lightBrightness(colours: number[][], intensity: number): number {
  return Math.max(...colours.map((c) => Math.max(c[0], c[1], c[2]))) * intensity;
}

/**
 * The light list and grid of a room the way the game builds them: 32 x 32
 * cells from the room's origin, each the room's larger side / 32 (at least a
 * tile, `tile` native units); each group at most 64 lights (the brightest
 * when there are more), 255 in all; scenery lights take a cell's first seven
 * slots, model lights its eighth; a light goes into every cell its range
 * reaches (a circle on the ground), the least important making way in a
 * full cell (brightness over 1 + distance).
 */
export function packPointLights(listed: ListedLight[], room: { x: number; y: number; w: number; h: number; tile: number }): PackedPointLights {
  const capped = ([0, 1] as const).flatMap((g) => {
    const group = listed.filter((l) => l.group === g);
    return group.length > 64 ? [...group].sort((a, b) => b.brightness - a.brightness).slice(0, 64) : group;
  }).slice(0, MAX_LIGHTS);
  const data = new Float32Array((MAX_LIGHTS + 1) * 16);
  capped.forEach((l, i) => data.set(packLight(l.light), (i + 1) * 16));
  const cellSize = Math.max(Math.max(room.w, room.h) / GRID_CELLS, room.tile);
  const scale = f32(1 / cellSize);
  const slots: ({ light: number; rank: number } | null)[][] = Array.from({ length: GRID_CELLS * GRID_CELLS },
    () => new Array(LIGHTS_PER_CELL).fill(null));
  capped.forEach((l, i) => {
    const { position: p } = l.light;
    const r = l.light.range;
    if (!(r > 0) || !(l.brightness > 0)) return;
    const cell = (v: number, o: number) => clamp(Math.floor((v - o) * scale), 0, GRID_CELLS - 1);
    for (let cy = cell(p[1] - r, room.y); cy <= cell(p[1] + r, room.y); cy++) {
      for (let cx = cell(p[0] - r, room.x); cx <= cell(p[0] + r, room.x); cx++) {
        const ax = room.x + cx * cellSize, ay = room.y + cy * cellSize;
        const dx = Math.max(ax - p[0], 0, p[0] - (ax + cellSize)), dy = Math.max(ay - p[1], 0, p[1] - (ay + cellSize));
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const rank = l.brightness / (1 + d);
        const list = slots[cy * GRID_CELLS + cx];
        const range = l.group === 0 ? [0, 6] : [7, 7];
        let free = -1, weakest = -1;
        for (let k = range[0]; k <= range[1]; k++) {
          if (!list[k]) { free = k; break; }
          if (weakest < 0 || list[k]!.rank < list[weakest]!.rank) weakest = k;
        }
        if (free >= 0) list[free] = { light: i + 1, rank };
        else if (list[weakest]!.rank < rank) list[weakest] = { light: i + 1, rank };
      }
    }
  });
  const cells = new Uint32Array(GRID_CELLS * GRID_CELLS * 4).fill(CELL_HIGH);
  slots.forEach((list, cell) => list.forEach((entry, k) => {
    if (!entry) return;
    const word = cell * 4 + (k >> 1);
    cells[word] = (cells[word] | (entry.light << ((k & 1) * 8))) >>> 0;
  }));
  return { data, cells, grid: [room.x, room.y, scale], count: capped.length };
}

/** A light definition placed by its owner's frame (native): the game's light. A spot with a pull-back
 *  width starts behind its apex, its range and intensity grown to keep the far end as authored; a still
 *  frame takes the steady light (no flicker). */
export function placedLight(def: {
  offset: number[]; range: number; direction: number[] | null; cone: number; feather: number; width: number;
  colour: number[]; intensity: number; falloff: number; specular: number; flicker: { colour: number[] | null };
  model?: boolean;
}, owner: THREE.Matrix4): ListedLight {
  const position = new THREE.Vector3(def.offset[0], def.offset[1], def.offset[2]).applyMatrix4(owner);
  const axis = def.direction ? new THREE.Vector3(def.direction[0], def.direction[1], def.direction[2]).transformDirection(owner) : null;
  const range = Math.max(def.range, 1);
  const d = axis && def.width > 0 && def.cone > 0 && def.cone < 90 ? def.width / Math.tan(def.cone * Math.PI / 180) : 0;
  if (d > 0) position.addScaledVector(axis!, -d);
  const k = d > 0 ? Math.pow((range + d) / range, Math.max(def.falloff, 0.01)) : 1;
  const intensity = f32(def.intensity * k);
  return {
    light: {
      position: [position.x, position.y, position.z], range: range + d,
      colour: [def.colour[0], def.colour[1], def.colour[2]], intensity, falloff: def.falloff, specular: def.specular,
      direction: axis ? [axis.x, axis.y, axis.z] : null, cone: def.cone, feather: def.feather, start: d,
    },
    group: def.model ? 1 : 0,
    brightness: lightBrightness([def.colour, def.flicker.colour ?? [0, 0, 0]], def.intensity * k),
  };
}
