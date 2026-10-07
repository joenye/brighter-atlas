// Point lights (the game's, from its 07-Oct-2026 update on): the light list
// and the 32 x 32 cell grid the lit material programs (and the fog) read.
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
//
// The game gathers a room's lights in three groups: the room's own scenery
// lights (at most 127), its neighbours' scenery lights (64) and model lights
// (street lamps, characters: 64), each over its cap keeping the lights that
// weigh most on the room. Each light covers the cells its footprint reaches,
// weighted by brightness * (1 - distance / footprint)^falloff; a cell keeps
// the eight that weigh most, scenery lights first.

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
  /** How it flickers: depth (how far the intensity dips), rate (steps a second, at most 6), the colour it
   *  moves toward (or none) and the light's own seed. */
  flicker?: { depth: number; rate: number; colour: [number, number, number] | null; seed: number };
}

export const GRID_CELLS = 32;
export const MAX_LIGHTS = 255;
export const LIGHTS_PER_CELL = 8;
/** The high half of every cell word (shaders read the low 16 bits only). */
const CELL_HIGH = 0x40000000;
/** The game's caps: the room's own scenery lights, its neighbours', model lights. */
const CAPS = { own: 127, neighbour: 64, model: 64 } as const;

const f32 = Math.fround;
const radians = (degrees: number) => f32(f32(f32(degrees + degrees) * f32(Math.PI)) / 360);
const cosd = (degrees: number) => f32(Math.cos(radians(degrees)));
const sind = (degrees: number) => f32(Math.sin(radians(degrees)));
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** The game's hash of two numbers to a value in [0, 1) (32-bit unsigned arithmetic, 24 bits kept). */
export function flickerHash(a: number, b: number): number {
  let h = a >>> 0;
  h = (h + (h << 10)) >>> 0; h = (h ^ (h >>> 6)) >>> 0;
  h = (h + (b >>> 0)) >>> 0;
  h = (h + (h << 10)) >>> 0; h = (h ^ (h >>> 6)) >>> 0;
  h = (h + (h << 3)) >>> 0; h = (h ^ (h >>> 11)) >>> 0; h = (h + (h << 15)) >>> 0;
  return f32((h & 0xffffff) * 2 ** -24);
}

/** A light's flicker at `seconds` on the game's clock: a smooth step between random values, `rate` steps a
 *  second (at most 6); 0 for a light that does not flicker. */
export function flickerValue(f: GamePointLight['flicker'], seconds: number): number {
  if (!f || (f.depth <= 0 && !f.colour)) return 0;
  const x = f32(Math.min(f.rate, 6) * seconds);
  const i = Math.floor(x), t = f32(x - i);
  const a = flickerHash(f.seed, i), b = flickerHash(f.seed, i + 1);
  return f32(a + (b - a) * f32(t * t * (3 - 2 * t)));
}

/** Whether a light changes with the clock. */
export const flickers = (light: GamePointLight) => !!light.flicker && (light.flicker.depth > 0 || !!light.flicker.colour);

/** The four texels of one light, as the game packs them, at a flicker value (0: steady). */
export function packLight(light: GamePointLight, flicker = 0): number[] {
  const { position: p, flicker: f } = light;
  const intensity = f ? f32(f32(1 - f32(f.depth * flicker)) * light.intensity) : light.intensity;
  const k = clamp(flicker, 0, 1);
  const c = f?.colour ? light.colour.map((v, i) => f32(v + (f.colour![i] - v) * k)) : light.colour;
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
  /** The lights in list order (light i at texel 4 (i + 1)). */
  lights: GamePointLight[];
  /** The cells, row by row (y, then x): four words each. */
  cells: Uint32Array;
  /** (origin x, origin y, cells per native unit). */
  grid: [number, number, number];
  count: number;
}

/** A light as the game gathers it: the light, its group, how bright it is (its colours' brightest channel
 *  times its intensity) and what shapes its footprint: what widens it (a pull-back, an attachment's
 *  reach), the centre it is measured from when not the light itself, the axis it leans along when not the
 *  light's own, the spread an attached spot's cone adds, and the margin of its square cull. */
export interface ListedLight {
  light: GamePointLight;
  group: 'own' | 'neighbour' | 'model';
  brightness: number;
  extra?: number;
  centre?: [number, number] | null;
  axis?: [number, number, number] | null;
  spread?: number;
  margin?: number;
  /** A character's light: its footprint is measured from the centre of the grid cell it is in. */
  cellCentred?: boolean;
}

/** The game's light brightness, for ranking: the brighter of its colours times its intensity. */
export function lightBrightness(colours: number[][], intensity: number): number {
  return Math.max(...colours.map((c) => Math.max(c[0], c[1], c[2]))) * intensity;
}

/** How far a light's footprint reaches on the ground. */
export function footprintRadius(l: ListedLight): number {
  const extra = l.extra ?? 0, range = l.light.range;
  const own = l.light.direction ? normalise(l.light.direction) : null;
  const axis = l.axis !== undefined ? (l.axis ? normalise(l.axis) : null) : own;
  if (!axis) return extra + range;
  const g = clamp(l.light.cone + (l.centre ? l.spread ?? 0 : 0), 0, 90);
  const s = sind(g), z = Math.abs(axis[2]), hxy = Math.hypot(axis[0], axis[1]);
  return extra + range * (s > z ? z * s + cosd(g) * hxy : 1);
}

/** How much a light weighs on a rectangle: brightness * (1 - distance / footprint)^falloff, 0 out of reach. */
function weigh(l: ListedLight, centre: [number, number], radius: number, x0: number, y0: number, x1: number, y1: number): number {
  const cx = centre[0] - x0, cy = centre[1] - y0, w = x1 - x0, h = y1 - y0;
  const dx = cx < 0 ? -cx : Math.max(cx - w, 0), dy = cy < 0 ? -cy : Math.max(cy - h, 0);
  const d = Math.hypot(dx, dy);
  return l.light.range > 0 && l.brightness > 0 && radius > 0 && d < radius
    ? f32(l.brightness * Math.pow(1 - d / radius, l.light.falloff)) : 0;
}

/**
 * The light list and grid of a room the way the game builds them: the
 * room's area from its corner (x, y, w, h native units), 32 x 32 cells each
 * the larger side / 32 (at least a tile); the three groups gathered (scenery
 * lights whose square reaches the room, model lights that weigh on it) and
 * capped; then every light covers the cells its footprint reaches, scenery
 * lights in a cell's first seven slots, model lights in any slot no scenery
 * light holds, a full cell giving way only to a light that weighs more.
 */
export function packPointLights(listed: ListedLight[], room: { x: number; y: number; w: number; h: number; tile: number }): PackedPointLights {
  const cellSize = Math.max(Math.max(room.w, room.h) / GRID_CELLS, room.tile);
  const scale = f32(1 / cellSize);
  const x1 = room.x + room.w, y1 = room.y + room.h;
  const centreOf = (l: ListedLight): [number, number] => {
    if (l.cellCentred) {
      const at = (v: number, o: number) => o + (Math.floor((v - o) * scale) + 0.5) * cellSize;
      return [at(l.light.position[0], room.x), at(l.light.position[1], room.y)];
    }
    return l.centre ?? [l.light.position[0], l.light.position[1]];
  };
  const radiusOf = (l: ListedLight) => footprintRadius(l.cellCentred ? { ...l, extra: f32(cellSize * 0.7072) } : l);
  const weight = (l: ListedLight) => weigh(l, centreOf(l), radiusOf(l), room.x, room.y, x1, y1);
  // a scenery light whose square (range plus margin about it) reaches into the room
  const inSquare = (l: ListedLight) => {
    const r = l.light.range + (l.margin ?? 0), [x, y] = l.light.position;
    return x - r < x1 && x + r > room.x && y - r < y1 && y + r > room.y;
  };
  // each group in the game's order (gathered by prepending), over its cap the ones that weigh most
  const group = (name: ListedLight['group']) => {
    const g = listed.filter((l) => l.group === name && (name === 'model' ? weight(l) > 0 : inSquare(l))).reverse();
    if (g.length <= CAPS[name]) return g;
    const weighed = g.map((l, k) => ({ l, k, w: weight(l) }));
    weighed.sort((a, b) => b.w - a.w || a.k - b.k);
    return weighed.slice(0, CAPS[name]).map((e) => e.l);
  };
  const lights = [...group('own'), ...group('neighbour'), ...group('model')].slice(0, MAX_LIGHTS);
  const data = new Float32Array((MAX_LIGHTS + 1) * 16);
  lights.forEach((l, i) => data.set(packLight(l.light), (i + 1) * 16));
  // the cells: each slot's light (index + 1) and how much it weighs there
  const slotLight = new Int32Array(GRID_CELLS * GRID_CELLS * LIGHTS_PER_CELL);
  const slotCov = new Float32Array(slotLight.length);
  const scenery = (index: number) => index > 0 && lights[index - 1].group !== 'model';
  const cell = (v: number, o: number) => clamp(Math.floor((v - o) * scale), 0, GRID_CELLS - 1);
  for (const pass of [0, 1]) {
    lights.forEach((l, i) => {
      if ((l.group === 'model' ? 1 : 0) !== pass) return;
      const R = radiusOf(l), [cx, cy] = centreOf(l);
      if (!(l.light.range > 0 && l.brightness > 0 && R > 0)) return;
      for (let y = cell(cy - R, room.y); y <= cell(cy + R, room.y); y++) {
        for (let x = cell(cx - R, room.x); x <= cell(cx + R, room.x); x++) {
          const ax = room.x + x * cellSize, ay = room.y + y * cellSize;
          const cov = weigh(l, [cx, cy], R, ax, ay, ax + cellSize, ay + cellSize);
          if (cov <= 0) continue;
          const base = (y * GRID_CELLS + x) * LIGHTS_PER_CELL;
          let best = -1, least = cov;
          for (let k = base; k < base + (pass === 0 ? 7 : 8); k++) {
            if (pass === 1 && scenery(slotLight[k])) continue;
            if (slotCov[k] < least) { best = k; least = slotCov[k]; }
          }
          if (best >= 0) { slotLight[best] = i + 1; slotCov[best] = cov; }
        }
      }
    });
  }
  const cells = new Uint32Array(GRID_CELLS * GRID_CELLS * 4);
  const before = (a: number, b: number) => scenery(slotLight[a]) !== scenery(slotLight[b]) ? scenery(slotLight[a]) : slotCov[a] > slotCov[b];
  for (let c = 0; c < GRID_CELLS * GRID_CELLS; c++) {
    const base = c * LIGHTS_PER_CELL;
    // the cell's slots: scenery lights first, each kind by weight
    for (let k = 1; k < LIGHTS_PER_CELL; k++) {
      for (let j = base + k; j > base && before(j, j - 1); j--) {
        [slotLight[j], slotLight[j - 1]] = [slotLight[j - 1], slotLight[j]];
        [slotCov[j], slotCov[j - 1]] = [slotCov[j - 1], slotCov[j]];
      }
    }
    for (let j = 0; j < 4; j++) cells[c * 4 + j] = (CELL_HIGH + slotLight[base + 2 * j] + (slotLight[base + 2 * j + 1] << 8)) >>> 0;
  }
  return { data, lights: lights.map((l) => l.light), cells, grid: [room.x, room.y, scale], count: lights.length };
}

/** The light list again at `seconds` on the game's clock (each light at its flicker). */
export function packLightData(lights: GamePointLight[], seconds: number, data: Float32Array): void {
  lights.forEach((light, i) => { if (flickers(light)) data.set(packLight(light, flickerValue(light.flicker, seconds)), (i + 1) * 16); });
}

/** The game's fade over `duration`: a smooth step over the time since it began (1 with no duration). */
export function fade(time: number, duration: number): number {
  if (duration <= 0) return 1;
  const c = clamp(time / duration, 0, 1);
  return c * c * (3 - 2 * c);
}

/** How strongly a model's light shines `time` ticks into its state (an open-ended resting state): always
 *  (fading in), within one of its windows (fading in from the window's start and out toward its end), or
 *  not at all. */
export function lightMultiplier(holder: { windows: [number, number][] | null; fadeIn: number; fadeOut: number }, time: number): number {
  if (!holder.windows) return fade(time, holder.fadeIn);
  for (const [start, end] of holder.windows) {
    if (start <= time && time < end) return fade(time - start, holder.fadeIn) * fade(end - time, holder.fadeOut);
  }
  return 0;
}

/** A light definition as a room shard or an actor keeps it. */
export interface LightDefinition {
  offset: number[]; range: number; direction: number[] | null; cone: number; feather: number; width: number;
  colour: number[]; intensity: number; falloff: number; specular: number;
  flicker: { depth: number; rate: number; colour: number[] | null };
  model?: boolean; attach?: number | null; margin?: number; spread?: number;
}

/** A light definition placed by its owner's frame (native): the game's light. A spot with a pull-back
 *  width starts behind its apex, its range and intensity grown to keep the far end as authored; it
 *  flickers from its seed. `at` places a character's light instead: its point (a bone's, or the model's
 *  with the offset unturned) and its axis; `multiplier` is how strongly it shines at the moment. */
export function placedLight(def: LightDefinition, owner: THREE.Matrix4, seed = 0, group: ListedLight['group'] = 'own',
  at?: { point: THREE.Vector3; axis: THREE.Vector3 | null }, multiplier = 1): ListedLight {
  const point = at ? at.point.clone() : new THREE.Vector3(def.offset[0], def.offset[1], def.offset[2]).applyMatrix4(owner);
  const axis = at ? at.axis : def.direction
    ? new THREE.Vector3(def.direction[0], def.direction[1], def.direction[2]).transformDirection(owner) : null;
  const range = Math.max(def.range, 1);
  const d = axis && def.width > 0 && def.cone > 0 && def.cone < 90 ? def.width / Math.tan(radians(def.cone)) : 0;
  if (d > 0) point.addScaledVector(axis!, -d);
  const k = d > 0 ? Math.pow((range + d) / range, Math.max(def.falloff, 0.01)) : 1;
  return {
    light: {
      position: [point.x, point.y, point.z], range: range + d,
      colour: [def.colour[0], def.colour[1], def.colour[2]], intensity: f32(def.intensity * multiplier * k),
      falloff: def.falloff, specular: def.specular,
      direction: axis ? [axis.x, axis.y, axis.z] : null, cone: def.cone, feather: def.feather, start: d,
      flicker: {
        depth: def.flicker.depth, rate: def.flicker.rate, seed: seed >>> 0,
        colour: def.flicker.colour ? [def.flicker.colour[0], def.flicker.colour[1], def.flicker.colour[2]] : null,
      },
    },
    group,
    brightness: lightBrightness([def.colour, def.flicker.colour ?? [0, 0, 0]], def.intensity * k),
    extra: d,
    margin: def.margin ?? 0,
    spread: def.spread ?? 0,
    ...(at ? { cellCentred: true } : {}),
  };
}
