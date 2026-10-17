// The game's frame, drawn with its own programs (game-shaders.ts) through
// game-gl.ts, in the order and with the constants the game uses: a shadow
// map from the fixed sun view fitted to the visible part of the scene, the
// half-resolution ambient occlusion chain (depth prepass, linear depth mips,
// spiral estimator with temporal accumulation, two bilateral blurs), then the
// main pass (ground, objects, then the actors: rigged spawns drawn with the
// skinned programs from a per-frame bone palette) and the water. Everything is computed in
// the native frame (x east, y south, z up: left handed, native units) with
// the game's camera conventions: view space x right, z up, looking along -y;
// clip depth 0..1 (EXT_clip_control where available, else the translator's
// remap). Every pass draws offscreen in the source's own image orientation,
// single sampled, and the finished frame is copied texel for texel to the
// canvas.
import { THREE } from '../three-common.js';
import { packPointLights, packLightData, flickers, lightMultiplier, placedLight, type ListedLight, type GamePointLight, type LightDefinition } from './point-lights.js';
import { fogMarchConstants } from './game-fog.js';
import { GameShaderLibrary, putFloats, ROOM_MASK_UNIFORM, ROOM_MASK_WIDTH, type GameProgram, type GameRenderTables } from './game-shaders.js';
import { GameGL, blendToGL, D3D_COMPARE_GL, type GameGLProgram, type GameTexture, type DrawState } from './game-gl.js';
import { bakeGameGeometry, bakeGameGeometryAsync, posePayload, type BakeInputs, type BakeInstance, type GameBakeWorker } from './game-geometry.js';
import { drawGroups, tieRanks, type DrawGroup, type EmissionKey } from './draw-order.js';
import { styleColourBytes } from './game-water.js';
import { detectChains } from '../../texture-roles.js';
import { PLANE_GAME_DISTANCE, planeCount, planeEdgeData, planeEdgeWidth, planeGroups, TILE_QUAD, type PlaneTile } from './ground-plane.js';

export interface GameRenderIndex extends GameRenderTables {
  waterPrograms: { surface: number[]; curtain: number[]; surfaceRing?: number[]; curtainLit?: number[] };
  /** The rooms an event haunts (07-Oct-2026 on): the environment each takes while it does. */
  haunted?: Record<string, GameRenderIndex['environments'][string]>;
  /** The volumetric fog's passes and the rooms that have it (07-Oct-2026 on): each one's fog area (room
   *  frame), the ground it lies on and the room's place on the map (tiles). */
  fog?: { programs: { noise: number; march: number; blurX: number; blurY: number; edge: number };
    rooms: { id: number; rect: [number, number, number, number]; ground: number; origin: [number, number] }[] };
  materials: Record<string, { main: number[][]; lit?: number[][]; depth: number[][]; specular: [number, number, number]; opacity: number }>;
  environments: Record<string, {
    sky: number[]; ground: number[]; sun: number[]; vignette: number[];
    height: number | 'avatar'; floor: number | 'avatar';
  }>;
  lighting: { direction: number[]; gamma: number; fade: number };
  shadow: { size: number; lightView: number[]; normalOffsetTexels: number; borderTexels: number; marginTiles: number; layerHeight: number };
  ssao: { unit: number; radius: number; falloff: number; padDivisor: number; temporalBase: number; temporalDivisor: number; frameMs: number;
    programs: { mips: number[]; sao: number; blurH: number; blurV: number }; fullscreenVertex: number };
  camera: { fov: number; near: number; far: number; pitch: number };
  vignette: { radius: number; overlayRadius: number; avatarFloor: number[]; avatarOffset: number };
  clock: { ticksPerSecond: number };
}

/** Many rooms as one source (all rooms, far from the camera): each room's parts and floor moved by its
 *  offset (native) into the cluster's frame, its resting actors posed as parts, its own lamps with `lit`; the cluster's
 *  bounds span `size` tiles. Its environment is `roomId`'s (the rooms joined share one). */
export function clusterSource(rooms: { source: GameRoomSource; offset: THREE.Vector3; slot: number }[], size: [number, number],
  roomId: number, tileUnits: number, lit = false): GameRoomSource {
  const batches: GameBatchSource[] = [];
  const plane: (PlaneTile & { slot: number })[] = [];
  const lights: ListedLight[] = [];
  for (const { source, offset, slot } of rooms) {
    withTies(source.batches);
    const move = new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z);
    for (const batch of source.batches) {
      batches.push({ ...batch, matrices: batch.matrices.map((m) => move.clone().multiply(m)), slots: batch.matrices.map(() => slot) });
    }
    // (with its lamps: each room's own lights, moved with it; the neighbours' are their own rooms' here)
    for (const l of lit ? source.lights ?? [] : []) {
      if (l.group === 'neighbour') continue;
      const p = l.light.position;
      lights.push({ ...l, light: { ...l.light, position: [p[0] + offset.x, p[1] + offset.y, p[2] + offset.z] },
        centre: l.centre ? [l.centre[0] + offset.x, l.centre[1] + offset.y] : l.centre });
    }
    const dx = offset.x / tileUnits, dy = offset.y / tileUnits;
    for (const tile of source.plane ?? []) plane.push({ ...tile, x: tile.x + dx, y: tile.y + dy, slot });
  }
  plane.sort((a, b) => a.cover - b.cover);
  const first = rooms[0].source;
  return {
    roomId, batches, actors: [], plane, water: first.water, textureMeta: first.textureMeta, grid: null,
    ...(lights.length ? { lights } : {}),
    bounds: { inner: [0, 0, size[0], size[1]], outer: [0, 0, size[0], size[1]],
      layers: Math.max(1, ...rooms.map((r) => r.source.bounds.layers)) },
  };
}

/** Each batch's tie ranks in its room (draw-order.ts tieRanks), set on the batches (kept: a room's batches are ranked
 *  once, and a cluster's copies carry their room's ranks). */
function withTies(batches: GameBatchSource[]): void {
  if (batches.some((b) => b.ties)) return;
  const ranks = tieRanks(batches);
  for (const [batch, list] of ranks ?? []) batch.ties = list;
}

/** All rooms with everything kept: a shadow map of its own for a part of the world (a cell's clusters), drawn
 *  once from the scenes that cast into it (they do not move), so its shadows never change as the camera moves. */
export interface ShadowTile {
  depth: GameTexture;
  fb: WebGLFramebuffer;
  size: number;
  /** Its fit (light space to the map's pixels), receiver (native to the map's texture space) and normal offset. */
  fit: THREE.Matrix4;
  receiver: THREE.Matrix4;
  offset: number;
}

/** A joined draw's own depth program (its depth reads its textures): the layered form, and which of the joined draw's
 *  arrays each of its textures is (its slot to the main program's). */
interface LayeredDepth { program: GameProgram; from: Record<number, number> }

/** One placed batch: a mesh drawn with one material at many placements. */
export interface GameBatchSource {
  category: string;
  mesh: number;
  material: number;
  renderTexture: number;
  payload: any;
  matrices: THREE.Matrix4[];     // native frame, raw mesh
  tints: (number[] | null)[];
  /** Per instance: the two recolour tints (half range RGBA), or null for neutral. */
  recolours?: (number[][] | null)[];
  /** Per instance: where the game's scene build emits the part (draw-order.ts). */
  order?: EmissionKey[];
  water: null | { kind: 'surface' | 'curtain'; style: number; opacity: number; window: [number, number] };
  /** Lit at full in a neighbouring room (a building's frontage, or a piece marked for its own full light): the
   *  game lights these with the room the viewer stands in instead of dimming them with their room. */
  lit?: boolean;
  /** Per instance (all rooms, a cluster): its room's slot in the room mask. */
  slots?: number[];
  /** Per instance: its tie rank in its room (draw-order.ts tieRanks), set as a room's draws are built. */
  ties?: number[];
}

/** One skinned part of an actor: its mesh in its own space, posed each frame
 *  by the bone palette the game's skinned programs read. */
export interface GameActorSource {
  mesh: number;
  material: number;
  renderTexture: number;
  payload: any;
  /** Bones in the rig (the palette's length is 12 floats each). */
  bones: number;
  tint: number[] | null;
  recolours: number[][] | null;
  /** This frame's skin matrices in the native frame (placement included),
   *  row-major 3x4 per bone; null leaves the part out of the frame. */
  palette: () => Float32Array | null;
  /** The lights the states of the actor's resting animation carry (07-Oct-2026 on). */
  lights?: GameActorLight[];
}

/** A light an actor carries: its definition with when it shines, the bone it hangs from (with that bone's
 *  bind matrix, native, to follow the pose) or the actor's placement, and its seed. */
export interface GameActorLight {
  def: LightDefinition & { windows: [number, number][] | null; fadeIn: number; fadeOut: number };
  bone: number | null;
  bind: THREE.Matrix4 | null;
  placement: THREE.Matrix4;
  seed: number;
}

/** One scene's draws, by pass. `depthDraws`: the depth passes' own draws where a scene's opaque parts
 *  share them (all rooms: one per depth program, in place of each part's own). */
interface SceneDraws { draws: Draw[]; actorDraws: Draw[]; waterDraws: Draw[]; planeDraws: Draw[]; depthDraws: Draw[]; arrays?: GameTexture[];
  /** The floor's soft edge (GameFrame.planeEdge): its pieces as the floor's, each corner's distance past the rooms. */
  planeEdge?: PlaneEdgeDraw | null }

/** The floor's soft edge on the GPU: a vertex array of the floor's pieces (corner, tiles beyond the rooms),
 *  nearest first. */
interface PlaneEdgeDraw { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; covers: Float32Array }

/** One room's draws on the GPU. A single room (with its neighbours) is the one scene, in its own frame; all
 *  rooms draw many, each built in its own room's frame and placed in the frame drawn at `origin` (native),
 *  so its lighting, vignette, lights and fog are the room's as the game draws it alone. */
export interface GameScene extends SceneDraws {
  readonly source: GameRoomSource;
  /** Where the room's frame sits in the frame drawn (native); null: at its origin. */
  readonly origin: THREE.Vector3 | null;
  /** Many rooms drawn as one (all rooms, far from the camera: clusterSource): no room's vignette, fog or
   *  lamps, its parts joined by what draws them. */
  readonly cluster: boolean;
  buffers: WebGLBuffer[];
  /** Drawn with the programs that add point lights, and the lights they read. */
  lit: boolean;
  lights: PackedLightTextures | null;
  /** The textures its draws read (keys of the frame's texture cache). */
  textures: Set<string>;
  /** Its vertex and index bytes on the GPU. */
  bytes: number;
  /** Its draw calls in the main pass. */
  drawCount: number;
  /** What its static parts and floor span (min x, y, z, max x, y, z) in its room's frame, or null with none. */
  bounds: number[] | null;
}

/** A room's point lights on the GPU: the light list and cells, the grid, and what the list is made from
 *  (refreshed each frame when a light flickers). */
export interface PackedLightTextures {
  data: GameTexture; cells: GameTexture; grid: [number, number, number]; count: number;
  words: Float32Array; lights: GamePointLight[]; flickering: boolean; seconds: number;
  /** What the list is gathered from: the room's and its neighbours' lights, the actors' (placed each
   *  frame, at their pose and how strongly each shines), and the room's area. */
  listed: ListedLight[]; actors: { actor: GameActorSource; light: GameActorLight }[];
  area: { x: number; y: number; w: number; h: number; tile: number }; ticks0: number | null;
}

/** A neighbouring room's lights against the room's (the game's scale at rest). */
const NEIGHBOUR_LIGHT = 0.1;

export interface GameRoomSource {
  roomId: number;
  bounds: {
    inner: [number, number, number, number]; outer: [number, number, number, number]; layers: number;
    /** With neighbours: the loaded rooms' extent (room tiles) and their most layers. */
    loaded?: [number, number, number, number]; loadedLayers?: number;
  };
  grid: any;                      // shard colour_grid
  batches: GameBatchSource[];
  actors?: GameActorSource[];
  water: any | null;              // world index water (styles)
  textureMeta: (id: number) => any;
  /** The floor the game lays under and around the room (room frame),
   *  nearest first, out to the endless floor's far pieces. */
  plane?: PlaneTile[];
  /** The room's point lights (room frame). */
  lights?: ListedLight[];
  /** Neighbouring rooms drawn with it (placed in the same frame): the room's
   *  own bounds, environment and vignette still govern the frame. */
  others?: { roomId: number; batches: GameBatchSource[]; actors?: GameActorSource[]; lights?: ListedLight[] }[];
}

export interface GameCamera {
  eye: THREE.Vector3;             // native frame
  target: THREE.Vector3;
  fov: number;                    // vertical degrees
  width: number;
  height: number;
  /** The camera's up (native frame); z when absent. */
  up?: THREE.Vector3;
  /** Depth range (native units) in place of the game's own: a narrow lens
   *  far above the ground needs its range around the ground. */
  near?: number;
  far?: number;
}

export interface Draw {
  /** The program in the source's own image orientation (every pass draws offscreen). */
  program: GameProgram;
  gl: GameGLProgram;
  vao: WebGLVertexArrayObject;
  count: number;
  indexType: number;
  /** A floor draw's pieces in order: the shortest distance that floors each. */
  covers?: Float32Array;
  /** Which room it draws: 0 the room shown, n its nth neighbour. */
  scene?: number;
  /** Never dimmed with its neighbouring room (GameBatchSource.lit). */
  lit?: boolean;
  textures: Record<number, GameTexture>;
  depth: null | { program: GameProgram; gl: GameGLProgram; vao: WebGLVertexArrayObject; textures: Record<number, GameTexture>;
    /** Its textures with their sampler objects (made on first draw), and its constant buffers' words. */
    bound?: Record<number, { texture: GameTexture; sampler: WebGLSampler | null }>; cbs?: Record<string, Uint32Array> };
  /** The largest of its parts (diagonal, native units): too small to see from afar, it is not drawn. */
  largest?: number;
  /** Its draw states (made on first draw) and its constant buffers' words (filled each frame). */
  mainState?: DrawState;
  depthState?: DrawState;
  cbs?: Record<string, Uint32Array>;
  /** The main pass's textures with their sampler objects, and the frame targets and lights they were made with. */
  mainBound?: { targets: unknown; lights: unknown; shadow: unknown; textures: Record<number, { texture: GameTexture; sampler: WebGLSampler | null }> };
  water: GameBatchSource['water'];
  /** Actors: the bone palette texture (3 texels per bone) and its source. */
  bones?: { texture: GameTexture; actor: GameActorSource; data: Float32Array; live: boolean; sent?: Float32Array };
}

/** The vertex stage's buffer resources (a skinned program's bone palette) bound to `bones`. */
function boneBindings(program: GameProgram, bones: GameTexture | undefined): Record<number, { texture: GameTexture; sampler: WebGLSampler | null }> | null {
  if (!bones) return null;
  const out: Record<number, { texture: GameTexture; sampler: WebGLSampler | null }> = {};
  for (const s of program.translated.samplers) if (s.stage === 'vs' && s.dim === 'buffer') out[s.texture] = { texture: bones, sampler: null };
  return out;
}

const f32 = Math.fround;
const pad5 = (n: number) => String(n).padStart(5, '0');

// Rows of a 4x4 (clip = M p) as the constant buffer stores them.
/** A depth draw's vertex constants: its matrix, the neutral vignette (as renderFrame's depth passes have them). */
function neutralWords(wvp: THREE.Matrix4): Uint32Array {
  const words = new Uint32Array(72);
  putFloats(words, 0, rows(wvp));
  putFloats(words, 64, rows(wvp));
  putFloats(words, 128, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  putFloats(words, 240, [0, 0, 0, 0, 0, 0, 0, 10000, 0, 0, 0, 1]);
  return words;
}

function rows(m: THREE.Matrix4): number[] {
  const e = m.elements;
  return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]];
}

/** The game's perspective (view space x right, z up, -y forward; depth 0..1). */
export function gameProjection(fovDeg: number, aspect: number, near: number, far: number): THREE.Matrix4 {
  const sy = f32(1 / Math.tan(fovDeg * Math.PI / 360)), sx = f32(sy / aspect);
  const a = f32(far / (far - near)), b = f32(far * near / (far - near));
  return new THREE.Matrix4().set(
    sx, 0, 0, 0,
    0, 0, sy, 0,
    0, -a, 0, -b,
    0, -1, 0, 0);
}

/** World to the game's view space (x right, y out of the screen, z up). The
 *  native frame is left handed (x east, y south, z up), so right is z x f. */
export function gameView(eye: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3 | null = null): THREE.Matrix4 {
  const f = target.clone().sub(eye).normalize();
  const r = new THREE.Vector3().crossVectors(up ?? new THREE.Vector3(0, 0, 1), f).normalize();
  const u = new THREE.Vector3().crossVectors(f, r);
  return new THREE.Matrix4().set(
    r.x, r.y, r.z, -r.dot(eye),
    -f.x, -f.y, -f.z, f.dot(eye),
    u.x, u.y, u.z, -u.dot(eye),
    0, 0, 0, 1);
}

/** The archived sun view (3x4 rows) as a 4x4. */
export function lightViewMatrix(v: number[]): THREE.Matrix4 {
  return new THREE.Matrix4().set(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11], 0, 0, 0, 1);
}

/** The shadow map fit: light-space extents
 *  of the visible part of the scene box, one border texel, depth / max. */
export function shadowFit(view: THREE.Matrix4, fov: number, aspect: number, near: number, far: number,
  box: number[], lightView: number[], size: number): { fit: THREE.Matrix4; receiver: THREE.Matrix4; offset: number } {
  const ty = Math.tan(f32(fov) * f32(Math.PI) / f32(360)), tx = aspect * ty;
  const camToWorld = view.clone().invert();
  const apply = (m: THREE.Matrix4, p: number[]) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m);
  const corners: THREE.Vector3[] = [];
  for (const d of [near, far]) for (const sx of [-d * tx, d * tx]) for (const sy of [-d * ty, d * ty]) corners.push(apply(camToWorld, [sx, -d, -sy]));
  const edges = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const lo = box.slice(0, 3), hi = box.slice(3), eps = 1e-3;
  const inbox = (v: THREE.Vector3) => [v.x, v.y, v.z].every((c, k) => c >= lo[k] - eps && c <= hi[k] + eps);
  const infrustum = (v: THREE.Vector3) => {
    const c = v.clone().applyMatrix4(view); const d = -c.y;
    return d >= near - eps && d <= far + eps && Math.abs(c.x) <= tx * d + eps && Math.abs(c.z) <= ty * d + eps;
  };
  const pts: THREE.Vector3[] = corners.filter(inbox);
  for (const [a, b] of edges) {
    const p0 = corners[a], dv = corners[b].clone().sub(p0);
    for (let ax = 0; ax < 3; ax++) for (const plane of [lo[ax], hi[ax]]) {
      const dc = dv.getComponent(ax);
      if (dc === 0) continue;
      const t = (plane - p0.getComponent(ax)) / dc;
      if (t >= 0 && t <= 1) { const q = p0.clone().addScaledVector(dv, t); if (inbox(q)) pts.push(q); }
    }
  }
  const bc: THREE.Vector3[] = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) bc.push(new THREE.Vector3(x, y, z));
  pts.push(...bc.filter(infrustum));
  const planes: [number[], number][] = [[[0, 0, 1], -near], [[0, 0, -1], far], [[1, 0, tx], 0], [[-1, 0, tx], 0], [[0, 1, ty], 0], [[0, -1, ty], 0]];
  const dot = (n: number[], v: THREE.Vector3) => n[0] * v.x + n[1] * v.y + n[2] * v.z;
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
    const x = a ^ b; if (x & (x - 1)) continue;
    const c0v = bc[a].clone().applyMatrix4(view), c1v = bc[b].clone().applyMatrix4(view);
    const c0 = new THREE.Vector3(c0v.x, -c0v.z, -c0v.y), c1 = new THREE.Vector3(c1v.x, -c1v.z, -c1v.y);
    for (const [n, dd] of planes) {
      const f0 = dot(n, c0) + dd, f1 = dot(n, c1) + dd;
      if ((f0 < 0) !== (f1 < 0) && f0 !== f1) {
        const cq = c0.clone().add(c1.clone().sub(c0).multiplyScalar(f0 / (f0 - f1)));
        const wq = apply(camToWorld, [cq.x, -cq.z, -cq.y]);
        if (infrustum(wq) && inbox(wq)) pts.push(wq);
      }
    }
  }
  return shadowFitPoints(pts.length ? pts : corners, lightView, size);
}

/** The shadow map fit over a box's corners (native: min x, y, z, max x, y, z), whatever the view: all
 *  rooms keeps one shadow map over the rooms near the camera while they stay the same. */
export function shadowFitBox(box: number[], lightView: number[], size: number): { fit: THREE.Matrix4; receiver: THREE.Matrix4; offset: number } {
  const pts: THREE.Vector3[] = [];
  for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) pts.push(new THREE.Vector3(x, y, z));
  return shadowFitPoints(pts, lightView, size);
}

function shadowFitPoints(use: THREE.Vector3[], lightView: number[], size: number): { fit: THREE.Matrix4; receiver: THREE.Matrix4; offset: number } {
  const L = lightViewMatrix(lightView);
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmax = -Infinity;
  for (const p of use) {
    const l = p.clone().applyMatrix4(L);
    const X = l.x, Y = -l.z, Z = -l.y;
    xmin = Math.min(xmin, X); xmax = Math.max(xmax, X); ymin = Math.min(ymin, Y); ymax = Math.max(ymax, Y); zmax = Math.max(zmax, Z);
  }
  const width = xmax - xmin, height = ymax - ymin, cx = (xmax + xmin) / 2, cy = (ymax + ymin) / 2, s = size - 2;
  const fit = new THREE.Matrix4().set(
    s / width, 0, 0, size / 2 - cx * s / width,
    0, 0, -s / height, size / 2 - cy * s / height,
    0, -1 / zmax, 0, 0,
    0, 0, 0, 1);
  const receiver = new THREE.Matrix4().makeScale(1 / size, 1 / size, 1).multiply(fit).multiply(L);
  return { fit, receiver, offset: 3 / Math.min(s / width, s / height) };
}

/** EXT_clip_control (not in the DOM typings). */
interface ClipControl {
  clipControlEXT(origin: number, depth: number): void;
  readonly LOWER_LEFT_EXT: number;
  readonly NEGATIVE_ONE_TO_ONE_EXT: number;
  readonly ZERO_TO_ONE_EXT: number;
}

/** Everything the frame needs for one room, built once per room. */
/** One level of a texture container: its format, size and data as the GPU takes it (blocks, or pixels). */
export interface TextureLevel { fmt: number; width: number; height: number; data: Uint8Array }
export type TextureLevelSource = (image: number, sub: number) => Promise<TextureLevel>;

/** All rooms: a page of shared texture arrays holds this many materials (layers). */
const LAYER_PAGE = 256;
interface LayerPage { arrays: Record<number, GameTexture>; used: number; capacity: number }
/** A plane a joined part's texture slot takes, and its shape. */
interface PlaneSpec { image: number; subs: number[]; srgb: boolean; format: number; levels: number; width: number; height: number }

export class GameFrame {
  readonly gl: GameGL;
  readonly shaders: GameShaderLibrary;
  /** The room shown (setRoom), with its neighbours. */
  private main: GameScene | null = null;
  // the room's draws by pass (the ground plane is drawn first, with its own vignette: ground-plane.ts)
  private get draws(): Draw[] { return this.main?.draws ?? []; }
  private get actorDraws(): Draw[] { return this.main?.actorDraws ?? []; }
  private set actorDraws(draws: Draw[]) { if (this.main) this.main.actorDraws = draws; }
  private get room(): GameRoomSource | null { return this.main?.source ?? null; }
  private get lit(): boolean { return this.main?.lit ?? false; }
  private get pointLights(): PackedLightTextures | null { return this.main?.lights ?? null; }
  /** Draw the ground plane. */
  showPlane = true;
  /** How far the ground plane reaches (tiles, Infinity: endless); the game's is ten. */
  planeDistance = Infinity;
  /** The ground plane's brightness, a scale on its colour (1: the game's; its height fade carries it, so the
   *  vignette still fades it to the vignette colour). */
  planeBrightness = 1;
  /** A floor that stops short ends softly: across its last tiles before the distance it blends into this colour
   *  (output colour space; the view's background, what shows past the floor), or null: it ends as the game's
   *  does, tile by tile. */
  planeEdge: [number, number, number] | null = null;
  /** The interactive view: the room's fade follows the floor's reach and the neighbours shown (sceneLook); off,
   *  the game's own (stills, parity). */
  viewerReach = false;
  /** Shade neighbouring rooms as the game does: their lights at a tenth,
   *  their water under the room's vignette. Off: lit like the room. */
  neighbourFade = true;
  private textures = new Map<string, Promise<GameTexture | null>>();
  /** How many scenes read each cached texture; those none reads, oldest first, kept while within
   *  `idleTextures` (all rooms streams scenes in and out; a single room keeps every texture it met). */
  private textureRefs = new Map<string, number>();
  private unreadTextures = new Set<string>();
  idleTextures = Infinity;
  /** A room's build under way: the share of its draws built so far (0 to 1), for a loading indicator. */
  onBuildProgress: ((fraction: number) => void) | null = null;
  /** The textures the scene being built reads. */
  private buildingTextures: Set<string> | null = null;
  /** Builds run one at a time (a build's GL calls and its program choice are the frame's state meanwhile). */
  private buildChain: Promise<unknown> = Promise.resolve();
  private targets: any = null;
  private ssaoFrame = 0;
  /** Tests: the occlusion's pattern held on one frame of its four (a still camera then settles on one picture). */
  holdOcclusion = false;
  private ssaoPrevious = 0;
  private lastView: THREE.Matrix4 | null = null;
  private fullscreen: WebGLVertexArrayObject | null = null;

  // Clip depth 0..w as the source draws it, where available: the default
  // GL range needs a remap that rounds depth differently.
  private readonly clipControl: ClipControl | null;

  /** `levels`: where a texture's levels come from, when not one file each under `url` (images/NNNNN_eK.bc). */
  /** All rooms: every program leaves out the vertices of the rooms marked hidden (setRoomHidden). */
  private readonly roomMask: { texture: GameTexture; data: Uint8Array; dirty: boolean } | null;

  constructor(private readonly context: WebGL2RenderingContext, private readonly url: (rel: string) => string,
    readonly index: GameRenderIndex, private readonly tileUnits: number, private readonly levels?: TextureLevelSource,
    { roomMask = false }: { roomMask?: boolean } = {}) {
    this.gl = new GameGL(context);
    this.roomMask = roomMask ? { texture: this.maskTexture(1), data: new Uint8Array(ROOM_MASK_WIDTH * 4), dirty: true } : null;
    if (roomMask) this.gl.fixedUnits.set(ROOM_MASK_UNIFORM, GameFrame.ROOM_MASK_UNIT);
    // the frame's own textures, read by most draws: bound once per pass, not per draw
    for (const [name, unit] of [['v_texture_shadow_map', 15], ['v_texture_ssao', 14], ['v_cbo_f1', 13], ['v_cbo_f2', 12]] as const) this.gl.fixedUnits.set(name, unit);
    this.clipControl = context.getExtension('EXT_clip_control') as ClipControl | null;
    this.shaders = new GameShaderLibrary(url, index, !!this.clipControl, roomMask);
  }

  static readonly ROOM_MASK_UNIT = 11;

  /** Hide (or show again) a room's parts in the scenes that carry room slots (clusters). Slots from 1. */
  setRoomHidden(slot: number, hidden: boolean): void {
    const mask = this.roomMask;
    if (!mask || !(slot > 0)) return;
    const rows = Math.floor(slot / ROOM_MASK_WIDTH) + 1;
    if (rows * ROOM_MASK_WIDTH * 4 > mask.data.length) {
      const data = new Uint8Array(rows * ROOM_MASK_WIDTH * 4);
      data.set(mask.data);
      mask.data = data;
      this.context.deleteTexture(mask.texture.texture);
      mask.texture = this.maskTexture(rows);
    }
    const value = hidden ? 255 : 0;
    if (mask.data[slot * 4] === value) return;
    mask.data[slot * 4] = value;
    mask.dirty = true;
  }

  /** A room mask's texture (read texel by texel: nearest, no mips, else it is incomplete and reads 0). */
  private maskTexture(rows: number): GameTexture {
    const gl = this.context;
    const texture = this.gl.texture2D(ROOM_MASK_WIDTH, rows, gl.RGBA8);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  /** The room mask on its unit for this frame (uploaded when it changed). */
  private bindRoomMask(): void {
    const mask = this.roomMask;
    if (!mask) return;
    const gl = this.context;
    gl.activeTexture(gl.TEXTURE0 + GameFrame.ROOM_MASK_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, mask.texture.texture);
    gl.bindSampler(GameFrame.ROOM_MASK_UNIT, null);
    if (mask.dirty) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ROOM_MASK_WIDTH, mask.data.length / (ROOM_MASK_WIDTH * 4), gl.RGBA, gl.UNSIGNED_BYTE, mask.data);
      mask.dirty = false;
    }
  }

  /** The main-pass program of a material for the default settings (shadows,
   *  occlusion and vignette on); `skinned` and `wide` (32-bit indices) pick the
   *  actor and large-mesh variants. */
  mainProgram(material: number, skinned = false, wide = false, lit = this.building ? this.buildingLit : this.lit): number | null {
    const m = this.index.materials[String(material)];
    // with point lights in the scene, the programs that add them (from 07-Oct-2026)
    if (lit && m?.lit) {
      const row = m.lit.find((k) => k[0] === +skinned && k[1] === +wide && k[2] === 1 && k[3] === 1)
        ?? m.lit.find((k) => k[0] === +skinned && k[1] === 0 && k[2] === 1 && k[3] === 1);
      if (row) return row[4];
    }
    const row = m?.main.find((k) => k[0] === +skinned && k[1] === +wide && k[2] === 1 && k[3] === 1 && k[4] === 1)
      ?? m?.main.find((k) => k[0] === +skinned && k[1] === 0 && k[2] === 1 && k[3] === 1 && k[4] === 1);
    return row ? row[5] : null;
  }

  /** Whether the scene being built draws with point lights (the scene's own lights: GameScene). */
  private buildingLit = false;
  /** The game's point light strength (the grid's fourth value) at full scene light. */
  pointLightStrength = 1;

  private packLights(room: GameRoomSource): PackedLightTextures | null {
    // the room's lights (its scenery's, its scenery models'), its neighbours' and its actors'
    const u = this.tileUnits, area = { x: 0, y: 0, w: room.bounds.inner[2] * u, h: room.bounds.inner[3] * u, tile: u };
    const listed = [...(room.lights ?? []),
      ...(room.others ?? []).flatMap((o) => (o.lights ?? []).map((l): ListedLight => (l.group === 'own' ? { ...l, group: 'neighbour' } : l)))];
    const actors = (room.actors ?? []).flatMap((actor) => (actor.lights ?? []).map((light) => ({ actor, light })));
    if (!listed.length && !actors.length) return null;
    const packed = packPointLights(listed, area);
    const gl = this.context;
    const make = (words: Float32Array) => this.gl.texture2D(words.length / 4, 1, gl.RGBA32F);
    const textures = { data: make(packed.data), cells: make(new Float32Array(packed.cells.buffer)) };
    const out: PackedLightTextures = { ...textures, grid: packed.grid, count: 0, words: packed.data, lights: [],
      flickering: false, seconds: NaN, listed, actors, area, ticks0: null };
    this.uploadLights(out, packed);
    return out;
  }

  /** A new light list and cells onto the GPU (the cells' words keep their bits: a float view of them). */
  private uploadLights(l: PackedLightTextures, packed: ReturnType<typeof packPointLights>): void {
    const gl = this.context;
    for (const [t, words] of [[l.data, packed.data], [l.cells, new Float32Array(packed.cells.buffer)]] as const) {
      gl.bindTexture(gl.TEXTURE_2D, t.texture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.width, 1, gl.RGBA, gl.FLOAT, words);
    }
    Object.assign(l, { grid: packed.grid, count: packed.count, words: packed.data, lights: packed.lights,
      flickering: packed.lights.some(flickers), seconds: NaN });
  }

  /** The lights at the frame's clock. Actors' lights follow their pose and shine as their state's time
   *  says (gathered and binned again each frame); every light flickers on the game's clock, in seconds
   *  that wrap every hour (`ticks` mod 2,160,000 over 600). */
  private updateLights(scene: GameScene, ticks: number): void {
    const l = scene.lights;
    if (!l) return;
    if (l.actors.length) {
      l.ticks0 ??= ticks;
      const placed = l.actors.flatMap(({ actor, light }) => {
        const shine = lightMultiplier(light.def, ticks - l.ticks0!);
        if (!(shine > 0)) return [];
        const at = this.actorLightPoint(actor, light);
        return at ? [placedLight(light.def, light.placement, light.seed, 'model', at, shine)] : [];
      });
      this.uploadLights(l, packPointLights([...l.listed, ...placed], l.area));
    }
    if (!l.flickering) return;
    const tps = this.index.clock.ticksPerSecond;
    const seconds = (((ticks % (3600 * tps)) + 3600 * tps) % (3600 * tps)) / tps;
    if (seconds === l.seconds) return;
    l.seconds = seconds;
    packLightData(l.lights, seconds, l.words);
    const gl = this.context;
    gl.bindTexture(gl.TEXTURE_2D, l.data.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, l.data.width, 1, gl.RGBA, gl.FLOAT, l.words);
  }

  /** Where an actor's light is this frame: on its bone (the bone's posed matrix: this frame's skin matrix
   *  times its bind matrix), offset and axis turned with it; or at the actor's place with the offset and
   *  axis as authored (unturned). */
  private actorLightPoint(actor: GameActorSource, light: GameActorLight): { point: THREE.Vector3; axis: THREE.Vector3 | null } | null {
    const { offset, direction } = light.def;
    const axis = direction ? new THREE.Vector3(direction[0], direction[1], direction[2]) : null;
    if (light.bone === null || !light.bind) {
      const point = new THREE.Vector3().setFromMatrixPosition(light.placement).add(new THREE.Vector3(offset[0], offset[1], offset[2]));
      return { point, axis };
    }
    const palette = actor.palette();
    const o = light.bone * 12;
    if (!palette || palette.length < o + 12) return null;
    const bone = new THREE.Matrix4().set(
      palette[o], palette[o + 1], palette[o + 2], palette[o + 3],
      palette[o + 4], palette[o + 5], palette[o + 6], palette[o + 7],
      palette[o + 8], palette[o + 9], palette[o + 10], palette[o + 11],
      0, 0, 0, 1).multiply(light.bind);
    return { point: new THREE.Vector3(offset[0], offset[1], offset[2]).applyMatrix4(bone), axis: axis ? axis.transformDirection(bone) : null };
  }

  /** The point lights drawn (test handle): how many, the grid, and what they were gathered from (each
   *  light's group, position, range and margin; the room's area). */
  lightInfo(): { lit: boolean; count: number; grid: [number, number, number] | null; gathered: unknown[]; area: unknown; actors: number } {
    const l = this.pointLights;
    return { lit: this.lit, count: l?.count ?? 0, grid: l?.grid ?? null, area: l?.area ?? null, actors: l?.actors.length ?? 0,
      gathered: (l?.listed ?? []).map((g) => [g.group, g.light.position.map(Math.round), g.light.range, g.margin ?? 0]) };
  }

  private freeLights(lights: { data: GameTexture; cells: GameTexture } | null): void {
    if (!lights) return;
    this.context.deleteTexture(lights.data.texture);
    this.context.deleteTexture(lights.cells.texture);
  }

  depthProgram(material: number, skinned = false, wide = false): number | null {
    const m = this.index.materials[String(material)];
    const row = m?.depth.find((k) => k[0] === +skinned && k[1] === +wide) ?? m?.depth.find((k) => k[0] === +skinned && k[1] === 0);
    return row ? row[2] : null;
  }

  private passPrograms = new Map<number, GameProgram>();
  /** All rooms: what the shadow map holds (its box and casters), and whether an actor posed since. */
  private shadowKey: string | null = null;
  private actorsMoved = false;
  private readonly serials = new WeakMap<GameScene, number>();
  private serialNext = 0;
  /** A scene's number, for telling one set of scenes from another. */
  private sceneSerial(scene: GameScene): number {
    let n = this.serials.get(scene);
    if (n === undefined) this.serials.set(scene, n = ++this.serialNext);
    return n;
  }
  private readonly zeros = new Map<number, Uint32Array>();
  /** Words of zeros (never written to). */
  private zeroWords(length: number): Uint32Array {
    let words = this.zeros.get(length);
    if (!words) this.zeros.set(length, words = new Uint32Array(length));
    return words;
  }
  /** Test switch: draw the frame without its water. */
  skipWater = false;
  /** Draw the volumetric fog where the room has it (the game's "Volumetric Fog" setting, on by default). */
  showFog = true;
  /** The room's lighting at a chosen story step, in place of its own
   *  story-complete one (null: the room's own). */
  environmentOverride: GameRenderIndex['environments'][string] | null = null;
  /** A presentation frame (a card picture): its own light direction (native
   *  frame, towards the scene), the neutral vignette, no shadow map or ambient
   *  occlusion, and the image shifted by `shift` pixels (x right, y down).
   *  null: the room frame. */
  card: { direction: number[]; shift: [number, number] } | null = null;
  /** The last frame's vertex constant words per pass (test readback). */
  lastConstants: Record<string, Uint32Array> = {};
  /** Test switch: wait for the GPU after each pass and keep the times (ms) in `lastPassTimes`. */
  timePasses = false;
  lastPassTimes: Record<string, number> = {};
  /** The last frame's draw calls per pass (test readback). */
  lastDraws = { shadow: 0, prepass: 0, main: 0, water: 0, fog: 0 };

  /** The scene being built (the frame keeps drawing the last one meanwhile). */
  private building: GameRoomSource | null = null;

  /** Build a room's scene and show it in place of the last (built beside the one shown, then swapped). */
  async setRoom(room: GameRoomSource): Promise<void> {
    const scene = await this.buildScene(room);
    this.releaseRoom();
    this.main = scene;
  }

  /** Build a room's draws as a scene of its own, placed at `origin` (native; null: the frame's origin).
   *  `shareDepth`: the opaque parts' depth draws joined, one per depth program (fewer draws, the same
   *  depth). `restingActors`: actors drawn in the pose they rest in, posed once and drawn with the room's
   *  parts by material (far fewer draws; they do not move). Scenes build one after another. */
  buildScene(room: GameRoomSource, origin: THREE.Vector3 | null = null,
    { shareDepth = false, restingActors = false, cluster = false }: { shareDepth?: boolean; restingActors?: boolean; cluster?: boolean } = {}): Promise<GameScene> {
    const run = this.buildChain.then(() => this.buildSceneNow(restingActors ? this.restActors(room) : room, origin, shareDepth, cluster));
    this.buildChain = run.catch(() => {});
    return run;
  }

  /** While a build joins its parts' depth draws: the parts each depth program draws (their instances). */
  private sharedDepth: Map<number, { program: GameProgram; instances: BakeInstance[] }> | null = null;

  private async buildSceneNow(room: GameRoomSource, origin: THREE.Vector3 | null, shareDepth: boolean, cluster = false): Promise<GameScene> {
    const p = this.index.ssao.programs;
    const fogPasses = this.index.fog ? Object.values(this.index.fog.programs) : [];
    for (const index of [...p.mips, p.sao, p.blurH, p.blurV, ...fogPasses]) {
      if (!this.passPrograms.has(index)) this.passPrograms.set(index, await this.shaders.program(index, 'clip'));
    }
    const next: SceneDraws = { draws: [], actorDraws: [], waterDraws: [], planeDraws: [], depthDraws: [], arrays: [] };
    this.buildingCluster = cluster;
    const buffers: WebGLBuffer[] = [];
    const textures = new Set<string>();
    this.sharedDepth = shareDepth ? new Map() : null;
    const bounds = this.buildingBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    this.building = room;
    const lit = this.buildingLit = this.sceneLit(room);
    this.gl.collect = buffers;
    this.buildingTextures = textures;
    const bytes0 = this.gl.bytes;
    try {
      await this.buildDraws(room, next);
      if (this.sharedDepth) next.depthDraws = await this.sharedDepthDraws(this.sharedDepth);
      // a cluster is seen from afar: its draws by program, so consecutive draws share it (and its constants)
      if (cluster) next.draws.sort((a, b) => a.program.index - b.program.index);
    } catch (error) {
      this.freeDraws([...next.draws, ...next.actorDraws, ...next.waterDraws, ...next.planeDraws, ...next.depthDraws], buffers);
      for (const t of next.arrays ?? []) this.context.deleteTexture(t.texture);
      this.freePlaneEdge(next.planeEdge);
      throw error;
    } finally {
      this.buildingCluster = false;
      this.gl.collect = null;
      this.building = null;
      this.buildingTextures = null;
      this.sharedDepth = null;
      this.buildingBounds = null;
    }
    for (const key of textures) {
      this.textureRefs.set(key, (this.textureRefs.get(key) ?? 0) + 1);
      this.unreadTextures.delete(key);
    }
    return { ...next, source: room, origin, cluster, buffers, lit, lights: lit ? this.packLights(room) : null, textures,
      bytes: this.gl.bytes - bytes0, drawCount: next.draws.length + next.actorDraws.length + next.waterDraws.length + next.planeDraws.length,
      bounds: Number.isFinite(bounds[0]) ? bounds : null };
  }

  /** One depth draw per depth program, of every part it draws (the parts' main draws keep no depth draw). */
  private async sharedDepthDraws(shared: Map<number, { program: GameProgram; instances: BakeInstance[] }>): Promise<Draw[]> {
    const out: Draw[] = [];
    for (const { program, instances } of shared.values()) {
      const [geometry] = await this.bakeBatch({ instances, layouts: [{ elements: program.elements, attributes: program.translated.attributes }],
        specular: [0, 0, 0], opacity: 1 });
      const glProgram = this.gl.compile(program.translated);
      const vao = await this.vertexArray(glProgram, geometry);
      const index = geometry.getIndex()!;
      out.push({ program, gl: glProgram, vao, count: index.count,
        indexType: index.array instanceof Uint32Array ? this.context.UNSIGNED_INT : this.context.UNSIGNED_SHORT,
        textures: {}, depth: { program, gl: glProgram, vao, textures: {} }, water: null });
    }
    return out;
  }

  /** A texture asked for: read by the scene being built, or (asked for outside a build: prepared, or
   *  drawn by hand) one no scene reads yet. */
  private noteTexture(key: string): void {
    if (this.buildingTextures) this.buildingTextures.add(key);
    else if (!this.textureRefs.has(key)) this.unreadTextures.add(key);
  }

  /** Free a scene's vertex arrays, buffers and lights; the textures no scene reads any more are kept
   *  while within `idleTextures`, the oldest freed first. */
  disposeScene(scene: GameScene): void {
    this.freeDraws([...scene.draws, ...scene.actorDraws, ...scene.waterDraws, ...scene.planeDraws, ...scene.depthDraws], scene.buffers);
    for (const t of scene.arrays ?? []) this.context.deleteTexture(t.texture);
    scene.arrays = [];
    this.freeLights(scene.lights);
    this.freePlaneEdge(scene.planeEdge);
    scene.planeEdge = null;
    scene.draws = []; scene.actorDraws = []; scene.waterDraws = []; scene.planeDraws = []; scene.depthDraws = []; scene.buffers = []; scene.lights = null;
    for (const key of scene.textures) {
      const refs = (this.textureRefs.get(key) ?? 1) - 1;
      if (refs > 0) { this.textureRefs.set(key, refs); continue; }
      this.textureRefs.delete(key);
      this.unreadTextures.add(key);
    }
    scene.textures.clear();
    for (const key of this.unreadTextures) {
      if (this.unreadTextures.size <= this.idleTextures) break;
      if (this.buildingTextures?.has(key)) continue;   // the build under way has just taken it
      this.unreadTextures.delete(key);
      const p = this.textures.get(key);
      this.textures.delete(key);
      p?.then((t) => { if (t) this.context.deleteTexture(t.texture); }).catch(() => {});
    }
  }

  /** Free the current scene's vertex arrays and buffers (programs and
   *  textures stay cached for the next scene). */
  releaseRoom(): void {
    if (!this.main) return;
    this.disposeScene(this.main);
    this.main = null;
  }

  /** Free the cached textures too (the frame stays usable). */
  releaseTextures(): void {
    const textures = [...this.textures.values()];
    this.textures.clear();
    this.textureRefs.clear();
    this.unreadTextures.clear();
    for (const p of textures) p.then((t) => { if (t) this.context.deleteTexture(t.texture); }).catch(() => {});
    for (const pool of this.layerPages.values()) {
      for (const page of pool.pages) for (const t of Object.values(page.arrays)) this.context.deleteTexture(t.texture);
    }
    this.layerPages.clear();
  }

  private freeDraws(draws: Draw[], buffers: WebGLBuffer[]): void {
    const gl = this.context;
    for (const d of draws) {
      gl.deleteVertexArray(d.vao);
      if (d.depth) gl.deleteVertexArray(d.depth.vao);
      if (d.bones) gl.deleteTexture(d.bones.texture.texture);
    }
    for (const b of buffers) gl.deleteBuffer(b);
  }

  private async buildDraws(room: GameRoomSource, next: SceneDraws): Promise<void> {
    // the room, then each neighbour, each in its own draw order
    const scenes = [room, ...(room.others ?? [])];
    await this.warmPrograms(scenes);
    for (let k = 0; k < scenes.length; k++) {
      const scene = scenes[k];
      // (six built at once, their textures and shaders fetched side by side: one after another, a phone's slow
      // connection paid a round trip per draw, 20 s of a Beach; each step of a build makes its GL calls in one go,
      // and textures are shared through their promises, so builds may interleave; the draws keep their order)
      if (!this.buildingCluster) withTies(scene.batches);
      const groups = drawGroups(scene.batches), built: (Draw | null)[] = new Array(groups.length);
      // all rooms: a cluster's parts drawn by the same program from textures of the same shape are joined into one
      // draw, their textures layers of arrays (the groups so joined are built here, the rest as before)
      // (and, in all rooms, the rooms drawn on their own: their depth goes to the scene's shared depth draw)
      const joined = this.joinLayers && (this.buildingCluster || this.sharedDepth) ? await this.joinGroups(groups, built, next) : new Set<number>();
      let at = 0, done = 0;
      const worker = async () => {
        for (let i = at++; i < groups.length; i = at++) {
          if (joined.has(i)) continue;
          const group = groups[i];
          built[i] = await this.buildDraw(group).catch((error) => {
            console.warn('game shading: group skipped', group.batch.material, group.batch.renderTexture, error);
            return null;
          });
          this.onBuildProgress?.((k + ++done / groups.length) / scenes.length);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      groups.forEach((group, i) => {
        const draw = built[i];
        if (!draw) return;
        draw.scene = k;
        draw.lit = !!group.batch.lit;
        (group.batch.water ? next.waterDraws : next.draws).push(draw);
      });
      for (const actor of scene.actors ?? []) {
        const draw = await this.buildActorDraw(actor).catch((error) => {
          console.warn('game shading: actor part skipped', actor.mesh, actor.material, error);
          return null;
        });
        if (draw) {
          draw.scene = k;
          next.actorDraws.push(draw);
        }
      }
    }
    // The ground plane: one part per tile, the game's tile quad at the tile's
    // centre, its texture repeat cell and the area colour at each corner.
    // The endless floor's far pieces are the quad stretched over several
    // tiles, within one repeat (texture coordinates are 16-bit units).
    const units = this.tileUnits;
    for (const { record, tiles } of planeGroups(room.plane ?? [])) {
      const batch: GameBatchSource = {
        category: 'terrain', mesh: -1, material: record.material, renderTexture: record.texture,
        payload: TILE_QUAD,
        matrices: tiles.map((t) => new THREE.Matrix4().makeTranslation((t.x + t.size[0] / 2) * units, (t.y + t.size[1] / 2) * units, 0)
          .multiply(new THREE.Matrix4().makeScale(t.size[0], t.size[1], 1))),
        tints: tiles.map(() => record.colour), water: null,
      };
      // texture transform: scale size/n, then the piece's cell in the repeat / n
      const instances = tiles.map((t, k) => ({
        payload: TILE_QUAD, matrix: batch.matrices[k], tint: record.colour,
        uvAffine: [f32(t.size[0] / record.repeat), 0, f32(t.cell[0] / record.repeat),
          0, f32(t.size[1] / record.repeat), f32(t.cell[1] / record.repeat)],
        vertexTints: t.tints, slot: (t as PlaneTile & { slot?: number }).slot,
      }));
      const draw = await this.buildPartDraw(batch, instances).catch((error) => {
        console.warn('game shading: ground plane skipped', record.material, error);
        return null;
      });
      if (draw) {
        draw.covers = Float32Array.from(tiles, (t) => t.cover);
        next.planeDraws.push(draw);
      }
    }
    if (room.plane?.length) next.planeEdge = this.planeEdgeOf(room.plane);
  }

  /** The floor's pieces as the soft edge draws them (a vertex array of its own). */
  private planeEdgeOf(tiles: readonly PlaneTile[]): PlaneEdgeDraw {
    const gl = this.context;
    const { vertices, indices, covers } = planeEdgeData(tiles, this.tileUnits);
    const vao = gl.createVertexArray()!, vbo = gl.createBuffer()!, ibo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.gl.forgetState();
    return { vao, buffers: [vbo, ibo], covers };
  }

  private freePlaneEdge(edge: PlaneEdgeDraw | null | undefined): void {
    if (!edge) return;
    this.context.deleteVertexArray(edge.vao);
    for (const b of edge.buffers) this.context.deleteBuffer(b);
  }

  private planeEdgeProgram: { program: WebGLProgram; wvp: WebGLUniformLocation; flip: WebGLUniformLocation; zeroToOne: WebGLUniformLocation;
    colour: WebGLUniformLocation; reach: WebGLUniformLocation; width: WebGLUniformLocation } | null = null;

  /** Blend the background colour over the scene's floor across its last tiles: only where the floor drew (the
   *  colour weighed by the target's alpha, which the floor writes and an empty pixel lacks), at the floor's depth,
   *  writing neither depth nor alpha. `wvp` is the floor's own clip matrix; `y` its programs' convention. */
  private drawPlaneEdge(edge: PlaneEdgeDraw, wvp: THREE.Matrix4, y: string, count: number): void {
    const gl = this.context;
    if (!this.planeEdgeProgram) {
      const program = this.gl.linkSources(`#version 300 es
layout(location = 0) in vec4 a_corner;
uniform mat4 u_wvp;
uniform float u_flip;
uniform bool u_zeroToOne;
out float v_beyond;
void main() {
  vec4 p = u_wvp * vec4(a_corner.xyz, 1.0);
  v_beyond = a_corner.w;
  gl_Position = vec4(p.x, p.y * u_flip, u_zeroToOne ? p.z : 2.0 * p.z - p.w, p.w);
}`, `#version 300 es
precision highp float;
uniform vec3 u_colour;
uniform float u_reach;
uniform float u_width;
in float v_beyond;
out vec4 o;
void main() {
  float f = smoothstep(u_reach - u_width, u_reach, v_beyond);
  if (f <= 0.0) discard;
  o = vec4(u_colour * f, f);
}`);
      const at = (name: string) => gl.getUniformLocation(program, name)!;
      this.planeEdgeProgram = { program, wvp: at('u_wvp'), flip: at('u_flip'), zeroToOne: at('u_zeroToOne'), colour: at('u_colour'),
        reach: at('u_reach'), width: at('u_width') };
    }
    const p = this.planeEdgeProgram;
    // (out = dst (1 - f) + colour f dst.a: an empty pixel, alpha and colour 0, stays empty; alpha kept)
    this.gl.applyState({ depthTest: true, depthFunc: gl.LEQUAL, depthWrite: false, cull: null, colourWrite: true,
      blend: [gl.FUNC_ADD, gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.FUNC_ADD, gl.ZERO, gl.ONE] });
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.wvp, false, wvp.elements);
    gl.uniform1f(p.flip, y === 'clip' ? -1 : 1);
    gl.uniform1i(p.zeroToOne, this.clipControl ? 1 : 0);
    gl.uniform3f(p.colour, this.planeEdge![0], this.planeEdge![1], this.planeEdge![2]);
    gl.uniform1f(p.reach, this.planeDistance);
    gl.uniform1f(p.width, planeEdgeWidth(this.planeDistance));
    // (a hair nearer than the floor, which drew this depth with the game's own rounding)
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    gl.bindVertexArray(edge.vao);
    gl.drawElements(gl.TRIANGLES, count * 6, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    this.gl.forgetState();   // (its program bound behind the cache)
  }

  /** One actor part: the skinned programs of its material, its mesh baked in
   *  its own space with the bone indices and weights, and a bone palette
   *  texture the frame refills before drawing. */
  private async buildActorDraw(actor: GameActorSource): Promise<Draw | null> {
    if (!(actor.bones > 0)) return null;   // (an actor kept for its lights only)
    const wide = actor.payload?.idx_dtype === 'u32';
    const programIndex = this.mainProgram(actor.material, true, wide);
    if (programIndex === null) return null;
    const program = await this.shaders.program(programIndex, 'clip');
    const depthIndex = this.depthProgram(actor.material, true, wide);
    const depthProgram = depthIndex === null ? null : await this.shaders.program(depthIndex, 'clip');
    const material = this.index.materials[String(actor.material)];
    const [geometry, depthGeometry] = bakeGameGeometry({
      instances: [{ payload: actor.payload, matrix: new THREE.Matrix4(), tint: actor.tint, recolours: actor.recolours }],
      layouts: [program, depthProgram].flatMap((p) => (p ? [{ elements: p.elements, attributes: p.translated.attributes }] : [])),
      specular: material?.specular ?? [0, 0, 0],
      opacity: material?.opacity ?? 1,
      skinned: true,
    });
    const batch: GameBatchSource = {
      category: 'spawns', mesh: actor.mesh, material: actor.material, renderTexture: actor.renderTexture,
      payload: actor.payload, matrices: [], tints: [], water: null,
    };
    const glProgram = this.gl.compile(program.translated);
    const vao = await this.vertexArray(glProgram, geometry);
    const index = geometry.getIndex()!;
    let depth: Draw['depth'] = null;
    if (depthProgram) {
      const depthGl = this.gl.compile(depthProgram.translated);
      depth = { program: depthProgram, gl: depthGl, vao: await this.vertexArray(depthGl, depthGeometry),
        textures: await this.bindTexturesFor(depthProgram, batch) };
    }
    // Three float4 rows per bone, element i at (i mod width, i div width).
    const texels = actor.bones * 3, width = Math.min(texels, 4096), height = Math.ceil(texels / width);
    const texture = this.gl.texture2D(width, height, this.context.RGBA32F);
    return {
      program, gl: glProgram, vao, count: index.count,
      indexType: index.array instanceof Uint32Array ? this.context.UNSIGNED_INT : this.context.UNSIGNED_SHORT,
      textures: await this.bindTexturesFor(program, batch), depth, water: null,
      bones: { texture, actor, data: new Float32Array(width * height * 4), live: false },
    };
  }

  /** Refill every actor's bone palette for this frame; parts without one sit it out. */
  private updateActors(scene: GameScene): void {
    const gl = this.context;
    for (const d of scene.actorDraws) {
      const bones = d.bones!;
      const palette = bones.actor.palette();
      bones.live = !!palette && palette.length >= bones.actor.bones * 12;
      if (!bones.live) continue;
      // a resting actor hands back the same palette every frame: on the GPU already
      if (bones.sent === palette) continue;
      bones.sent = palette!;
      this.actorsMoved = true;
      bones.data.set(palette!.subarray(0, bones.actor.bones * 12));
      const t = bones.texture;
      gl.bindTexture(gl.TEXTURE_2D, t.texture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.width, t.height, gl.RGBA, gl.FLOAT, bones.data);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Test readback: the ground plane's draws (one per floor material), the
   *  pieces the distance draws and all it has. */
  planeInfo(): { draws: number; tiles: number; pieces: number; distance: number | null; shown: boolean } {
    const count = (d: Draw) => (d.covers ? planeCount(d.covers, this.planeDistance) : d.count / 6);
    const planeDraws = this.main?.planeDraws ?? [];
    return {
      draws: planeDraws.length, tiles: planeDraws.reduce((n, d) => n + count(d), 0),
      pieces: planeDraws.reduce((n, d) => n + (d.covers?.length ?? d.count / 6), 0),
      distance: Number.isFinite(this.planeDistance) ? this.planeDistance : null, shown: this.showPlane,
    };
  }

  /** Test readback: the actor parts built for the room, and those posed last frame. */
  actorInfo(): { built: number; live: number; meshes: number[] } {
    return { built: this.actorDraws.length, live: this.actorDraws.filter((d) => d.bones!.live).length,
      meshes: this.actorDraws.map((d) => d.bones!.actor.mesh) };
  }

  /** A scene's static draws, then its actors posed this frame. */
  private solidDraws(scene: GameScene): Draw[] {
    return [...scene.draws, ...scene.actorDraws.filter((d) => d.bones!.live)];
  }

  /** Tests: each texture array uploaded (when, how long the page waited, its bytes, layers, size and format). */
  readonly arrayLog: { at: number; ms: number; bytes: number; layers: number; size: number; format: number }[] = [];
  /** All rooms: join a cluster's parts drawn alike (a texture array per layered slot). */
  joinLayers = false;
  /** All rooms: clusters built from now on cast shadows and occlude as a room does (their joined parts in their
   *  shared depth draws, joined only where that depth needs no texture). Off, a cluster has no depth of its
   *  own beyond its parts left unjoined (seen from afar, it casts into no shadow map). */
  clusterDepth = false;
  private buildingCluster = false;

  /** A cluster's groups joined where they can be: drawn by one program with a layered form, their textures planes
   *  of one shape on every layered slot and nothing else to bind of their own, opaque (no water). Each material's
   *  planes sit at one layer of a page of shared arrays (one array per layered slot); groups drawn by one program
   *  from one page become one draw in `built` (at its first group's place). Returns the groups it took. */
  private async joinGroups(groups: DrawGroup<GameBatchSource>[], built: (Draw | null)[], _next: SceneDraws): Promise<Set<number>> {
    const sets = new Map<string, { at: number[]; layers: number[]; program: GameProgram; page: LayerPage;
      depth: GameProgram | null; depthIndex: number | null; depthLayered: LayeredDepth | null }>();
    for (let i = 0; i < groups.length; i++) {
      const batch = groups[i].batch;
      if (batch.water || batch.renderTexture < 0 || batch.mesh < 0) continue;
      const [programIndex, depthIndex] = this.batchPrograms(batch);
      if (programIndex === null) continue;
      // a room drawn on its own casts and occludes: its parts' depth joins the shared depth draw where it needs no
      // texture, else the joined draw has a depth draw of its own reading the same layers
      let depth: GameProgram | null = null, textured = false;
      if ((!this.buildingCluster || this.clusterDepth) && depthIndex !== null) {
        depth = await this.shaders.program(depthIndex, 'clip').catch(() => null);
        if (!depth) continue;
        textured = depth.translated.samplers.length > 0;
        if (!textured && !this.sharedDepth) continue;
      }
      const program = await this.shaders.program(programIndex, 'clip', true).catch(() => null);
      if (!program?.layered?.length) continue;
      const plain = await this.shaders.program(programIndex, 'clip');
      // (a part that blends is drawn in its own place: blending follows the order things are drawn in)
      if (this.state(plain).blend) continue;
      const specs = this.planeSpecsFor(plain, batch);
      if (!specs) continue;
      // every texture the program reads is one of the layered planes
      const slots = plain.translated.samplers.filter((s) => s.stage === 'ps').map((s) => s.texture);
      if (slots.some((slot) => specs[slot] && !program.layered!.includes(slot))) continue;
      if (program.layered.some((slot) => !specs[slot])) continue;
      const depthLayered = textured ? await this.layeredDepth(depth!, batch, specs, program.layered) : null;
      if (textured && !depthLayered) continue;
      const placed = await this.materialLayer(program.layered, specs).catch(() => null);
      if (!placed) continue;
      const key = `${programIndex}|${depthIndex ?? -1}|${depthLayered ? JSON.stringify(depthLayered.from) : ''}|${batch.lit ? 'l' : ''}|${batch.category === 'terrain' ? 't' : 'p'}|${placed.shape}#${placed.pageIndex}`;
      let set = sets.get(key);
      if (!set) sets.set(key, set = { at: [], layers: [], program, page: placed.page, depth: textured ? null : depth, depthIndex, depthLayered });
      set.at.push(i);
      set.layers.push(placed.layer);
    }
    // (their programs compiled off the page beforehand, as warmPrograms does the plain ones)
    await Promise.all([...new Set([...sets.values()].filter((set) => set.at.length > 1).flatMap((set) => [set.program, ...(set.depthLayered ? [set.depthLayered.program] : [])]))]
      .map((program) => this.gl.compileAsync(program.translated).catch(() => { /* the draw reports it */ })));
    const taken = new Set<number>();
    for (const set of sets.values()) {
      if (set.at.length < 2) continue;
      const draw = await this.buildJoinedDraw(set.at.map((i) => groups[i]), set.layers, set.program, set.page, set.depth, set.depthIndex, set.depthLayered).catch((error) => {
        console.warn('game shading: joined draw skipped', set.program.index, error);
        return null;
      });
      if (!draw) continue;
      for (const i of set.at) taken.add(i);
      built[set.at[set.at.length - 1]] = draw;
    }
    return taken;
  }

  /** Pages of shared texture arrays by the shape of their planes (format, size, levels, colour space per layered
   *  slot); each material's planes at one layer of one page, uploaded once for every cluster that draws it. */
  private readonly layerPages = new Map<string, { pages: LayerPage[]; at: Map<string, [number, number]> }>();
  private async materialLayer(slots: number[], textures: Record<number, PlaneSpec>): Promise<{ shape: string; page: LayerPage; pageIndex: number; layer: number }> {
    const shape = slots.map((slot) => { const p = textures[slot]; return `${slot}:${p.format}:${p.width}x${p.height}:${p.levels}:${p.srgb}`; }).join(',');
    let pool = this.layerPages.get(shape);
    if (!pool) this.layerPages.set(shape, pool = { pages: [], at: new Map() });
    const material = slots.map((slot) => { const p = textures[slot]; return `${p.image}:${p.subs.join(',')}:${p.srgb}`; }).join('|');
    const found = pool.at.get(material);
    if (found) return { shape, page: pool.pages[found[0]], pageIndex: found[0], layer: found[1] };
    let pageIndex = pool.pages.length - 1;
    if (pageIndex < 0 || pool.pages[pageIndex].used >= pool.pages[pageIndex].capacity) {
      // (pages grow: 64 layers, then twice the last, up to LAYER_PAGE: a shape few materials have takes less)
      const capacity = Math.min(LAYER_PAGE, 64 << pool.pages.length);
      const arrays: Record<number, GameTexture> = {};
      for (const slot of slots) {
        const p = textures[slot];
        arrays[slot] = this.gl.textureArray(p.width, p.height, p.levels, capacity, p.format, p.srgb);
      }
      pool.pages.push({ arrays, used: 0, capacity });
      pageIndex = pool.pages.length - 1;
    }
    const page = pool.pages[pageIndex], layer = page.used++;
    pool.at.set(material, [pageIndex, layer]);
    for (const slot of slots) {
      const plane = textures[slot];
      const chain = (await Promise.all(plane.subs.map((sub) => this.blocks(plane.image, sub)))).sort((a, b) => b.width - a.width);
      const bytes = chain.reduce((n, l) => n + l.data.byteLength, 0);
      if (this.pace) await this.pace('texture', bytes);
      const t0 = performance.now();
      this.gl.uploadTextureLayer(page.arrays[slot], layer, chain, plane.format, plane.srgb);
      if (this.arrayLog.length < 5000) this.arrayLog.push({ at: t0, ms: performance.now() - t0, bytes, layers: 1, size: plane.width, format: plane.format });
    }
    return { shape, page, pageIndex, layer };
  }

  /** A depth program that reads the part's textures (an alpha test) in its layered form: each of its textures one of
   *  the joined draw's own planes (`from`: its slot to the main program's), else null. */
  private async layeredDepth(depth: GameProgram, batch: GameBatchSource, mainSpecs: Record<number, PlaneSpec>, mainLayered: number[]): Promise<LayeredDepth | null> {
    const program = await this.shaders.program(depth.index, 'clip', true).catch(() => null);
    if (!program?.layered?.length) return null;
    const specs = this.planeSpecsFor(depth, batch);
    if (!specs) return null;
    if (depth.translated.samplers.some((s) => !specs[s.texture] || !program.layered!.includes(s.texture))) return null;
    const same = (a: PlaneSpec, b: PlaneSpec) => a.image === b.image && a.srgb === b.srgb && a.subs.join(',') === b.subs.join(',');
    const from: Record<number, number> = {};
    for (const slot of program.layered) {
      const main = mainLayered.find((m) => mainSpecs[m] && same(mainSpecs[m], specs[slot]));
      if (main === undefined) return null;
      from[slot] = main;
    }
    return { program, from };
  }

  private async buildJoinedDraw(members: DrawGroup<GameBatchSource>[], layers: number[], program: GameProgram, page: LayerPage,
    depth: GameProgram | null, depthIndex: number | null, depthLayered: LayeredDepth | null = null): Promise<Draw | null> {
    const instances: BakeInstance[] = [];
    members.forEach((group, k) => {
      const material = this.index.materials[String(group.batch.material)];
      for (const { batch: b, index: i } of group.parts) {
        instances.push({ payload: b.payload, matrix: b.matrices[i], tint: b.tints[i], recolours: b.recolours?.[i] ?? null, slot: b.slots?.[i], tie: b.ties?.[i],
          layer: layers[k], specular: material?.specular ?? [0, 0, 0], opacity: material?.opacity ?? 1 });
      }
    });
    const layouts = [{ elements: program.elements, attributes: program.translated.attributes }];
    if (depthLayered) layouts.push({ elements: depthLayered.program.elements, attributes: depthLayered.program.translated.attributes });
    const [geometry, depthGeometry] = await this.bakeBatch({ instances, layouts, specular: [0, 0, 0], opacity: 1 });
    // (a room's joined parts in its shared depth draw, as each part alone would be)
    if (depth && depthIndex !== null && this.sharedDepth) {
      let entry = this.sharedDepth.get(depthIndex);
      if (!entry) this.sharedDepth.set(depthIndex, entry = { program: depth, instances: [] });
      entry.instances.push(...instances);
    }
    const glProgram = this.gl.compile(program.translated);
    const vao = await this.vertexArray(glProgram, geometry);
    const index = geometry.getIndex()!;
    let ownDepth: Draw['depth'] = null;
    if (depthLayered && depthGeometry) {
      const depthGl = this.gl.compile(depthLayered.program.translated);
      ownDepth = { program: depthLayered.program, gl: depthGl, vao: await this.vertexArray(depthGl, depthGeometry),
        textures: Object.fromEntries(Object.entries(depthLayered.from).map(([slot, main]) => [slot, page.arrays[main]])) };
    }
    const span: number[] | undefined = geometry.userData.bounds;
    if (this.buildingBounds && span) {
      for (let k = 0; k < 3; k++) {
        this.buildingBounds[k] = Math.min(this.buildingBounds[k], span[k]);
        this.buildingBounds[k + 3] = Math.max(this.buildingBounds[k + 3], span[k + 3]);
      }
    }
    return {
      program, gl: glProgram, vao, count: index.count,
      indexType: index.array instanceof Uint32Array ? this.context.UNSIGNED_INT : this.context.UNSIGNED_SHORT,
      textures: page.arrays, depth: ownDepth, water: null,
      largest: members.some((g) => g.batch.category === 'terrain') ? Infinity : geometry.userData.largest,
    };
  }

  private async buildDraw(group: DrawGroup<GameBatchSource>): Promise<Draw | null> {
    const instances = group.parts.map(({ batch: b, index: k }) => ({
      payload: b.payload, matrix: b.matrices[k], tint: b.tints[k], recolours: b.recolours?.[k] ?? null, slot: b.slots?.[k], tie: b.ties?.[k],
    }));
    return this.buildPartDraw(group.batch, instances);
  }

  /** A batch's main and depth programs (indices), in `scene` (the one being built, or shown) drawn with
   *  point lights or not. */
  private batchPrograms(batch: GameBatchSource, lit = this.building ? this.buildingLit : this.lit,
    scene = this.building ?? this.room): [number | null, number | null] {
    // water: key (skinned, 32-bit, vignette) = (false, false, true); a style
    // with radial ripples draws with its ring twin
    const curtainLit = batch.water?.kind === 'curtain' && lit ? this.index.waterPrograms.curtainLit?.[0] : undefined;
    const main = batch.water ? (this.ringProgram(batch, scene) ?? curtainLit ?? this.index.waterPrograms[batch.water.kind][0]) : this.mainProgram(batch.material, false, false, lit);
    return [main, batch.water ? null : this.depthProgram(batch.material)];
  }

  /** The ring twin of a water surface whose style has radial ripples (key (false, false)), else null. */
  private ringProgram(batch: GameBatchSource, scene = this.building ?? this.room): number | null {
    if (batch.water?.kind !== 'surface') return null;
    const style = scene?.water?.styles[batch.water.style];
    return style?.radial ? this.index.waterPrograms.surfaceRing?.[0] ?? null : null;
  }

  /** A room with its actors (those whose material has a static program) as static parts in the pose they
   *  rest in: each part's mesh posed by its palette (placement included), the actor kept for the lights it
   *  carries only. */
  restActors(room: GameRoomSource): GameRoomSource {
    if (!room.actors?.length) return room;
    const batches = [...room.batches], actors: GameActorSource[] = [];
    for (const actor of room.actors) {
      const palette = actor.palette();
      if (!palette) continue;   // left out of the view (its category hidden, or deleted)
      const payload = this.mainProgram(actor.material, false, actor.payload?.idx_dtype === 'u32') !== null ? posePayload(actor.payload, palette) : null;
      if (!payload) { actors.push(actor); continue; }
      batches.push({ category: 'spawns', mesh: actor.mesh, material: actor.material, renderTexture: actor.renderTexture, payload,
        matrices: [new THREE.Matrix4()], tints: [actor.tint], recolours: [actor.recolours], water: null });
      // (the lights it carries stay with it: a part with no draw)
      if (actor.lights?.length) actors.push({ ...actor, bones: 0 });
    }
    return { ...room, batches, actors };
  }

  /** The environment a room is drawn in (its own, or its event's while the event's fog shows), as a key:
   *  rooms that share one can be drawn as one (clusterSource). */
  environmentKey(roomId: number): string {
    const idx = this.index;
    const haunting = this.showFog && idx.fog?.rooms.some((f) => f.id === roomId) ? idx.haunted?.[String(roomId)] : undefined;
    return JSON.stringify(haunting ?? idx.environments[String(roomId)] ?? null);
  }

  /** Whether a room's scene draws with the programs that add point lights. */
  private sceneLit(room: GameRoomSource): boolean {
    return !!(room.lights?.length || room.others?.some((o) => o.lights?.length) || room.actors?.some((a) => a.lights?.length))
      && Object.values(this.index.materials).some((m) => m.lit?.length);
  }

  /** Ready a room for its build, without building it (any number at once, beside a build): every program
   *  its draws use compiled and every texture they read fetched and uploaded, so the build that follows
   *  finds them all cached. Textures no scene comes to read are freed with the oldest unread ones. */
  async prepare(source: GameRoomSource, concurrency = 8, restingActors = false, cluster = false): Promise<void> {
    const room = restingActors ? this.restActors(source) : source;
    const lit = this.sceneLit(room);
    const work: (() => Promise<unknown>)[] = [];
    const seen = new Set<string>();
    const add = (index: number | null, batch: GameBatchSource) => {
      if (index === null) return;
      const key = `${index}|${batch.renderTexture}|${batch.water ? `${batch.water.kind}${batch.water.style}` : ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      work.push(async () => {
        const program = await this.shaders.program(index, 'clip');
        await this.gl.compileAsync(program.translated).catch(() => {});
        // (a part that will be joined takes its textures from shared arrays: none of its own; one that is not after
        // all gets them as its draw is made)
        if (await this.joinable(batch, cluster)) return;
        await this.bindTexturesFor(program, batch, room);
      });
    };
    for (const scene of [room, ...(room.others ?? [])]) {
      for (const group of drawGroups(scene.batches)) for (const index of this.batchPrograms(group.batch, lit, room)) add(index, group.batch);
      for (const actor of (scene.actors ?? []).filter((a) => a.bones > 0)) {
        const wide = actor.payload?.idx_dtype === 'u32';
        const batch: GameBatchSource = { category: 'spawns', mesh: actor.mesh, material: actor.material, renderTexture: actor.renderTexture,
          payload: actor.payload, matrices: [], tints: [], water: null };
        for (const index of [this.mainProgram(actor.material, true, wide, lit), this.depthProgram(actor.material, true, wide)]) add(index, batch);
      }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, async () => {
      for (let k = next++; k < work.length; k = next++) await work[k]().catch(() => { /* the build reports it */ });
    }));
  }

  /** Every program the scenes will draw with, compiled together before the draws are built, the page
   *  free meanwhile (GameGL.compileAsync): a place's first load no longer holds a phone's taps. */
  private async warmPrograms(scenes: { batches: GameBatchSource[]; actors?: GameActorSource[] }[]): Promise<void> {
    const indices = new Set<number>();
    for (const scene of scenes) {
      for (const group of drawGroups(scene.batches)) for (const i of this.batchPrograms(group.batch)) if (i !== null) indices.add(i);
      for (const actor of scene.actors ?? []) {
        const wide = actor.payload?.idx_dtype === 'u32';
        for (const i of [this.mainProgram(actor.material, true, wide), this.depthProgram(actor.material, true, wide)]) if (i !== null) indices.add(i);
      }
    }
    await Promise.all([...indices].map(async (i) => {
      try { await this.gl.compileAsync((await this.shaders.program(i, 'clip')).translated); } catch { /* the draw that needs it reports it */ }
    }));
  }

  /** While a scene builds: what its static parts span so far. */
  private buildingBounds: number[] | null = null;

  private async buildPartDraw(batch: GameBatchSource, instances: BakeInstance[]): Promise<Draw | null> {
    const [programIndex, depthIndex] = this.batchPrograms(batch);
    if (programIndex === null) return null;
    const program = await this.shaders.program(programIndex, 'clip');
    const depthProgram = depthIndex === null ? null : await this.shaders.program(depthIndex, 'clip');
    const material = this.index.materials[String(batch.material)];
    const style = batch.water?.kind === 'surface' ? (this.building ?? this.room)!.water.styles[batch.water.style] : null;
    // One bake serves the main and depth programs; each names the shared streams its own way.
    const [geometry, depthGeometry] = await this.bakeBatch({
      instances,
      layouts: [program, depthProgram].flatMap((p) => (p ? [{ elements: p.elements, attributes: p.translated.attributes }] : [])),
      specular: material?.specular ?? [0, 0, 0],
      opacity: batch.water ? batch.water.opacity : (material?.opacity ?? 1),
      style: style ? styleColourBytes(style.colour) : undefined,
      window: batch.water?.kind === 'curtain' ? [Math.round(batch.water.window[0] * 65535), Math.round(batch.water.window[1] * 65535)] : undefined,
      ringCentre: programIndex === this.ringProgram(batch),
    });
    const glProgram = this.gl.compile(program.translated);
    const vao = await this.vertexArray(glProgram, geometry);
    const index = geometry.getIndex()!;
    const span: number[] | undefined = geometry.userData.bounds;
    if (this.buildingBounds && span) {
      for (let k = 0; k < 3; k++) {
        this.buildingBounds[k] = Math.min(this.buildingBounds[k], span[k]);
        this.buildingBounds[k + 3] = Math.max(this.buildingBounds[k + 3], span[k + 3]);
      }
    }
    const textures = await this.bindTexturesFor(program, batch);
    let depth: Draw['depth'] = null;
    // an opaque part's depth (its depth program reads no texture) joins the scene's shared depth draw
    const shared = this.sharedDepth && depthProgram && depthIndex !== null && !batch.water && batch.mesh >= 0
      && !depthProgram.translated.samplers.length ? this.sharedDepth : null;
    if (shared && depthProgram && depthIndex !== null) {
      let entry = shared.get(depthIndex);
      if (!entry) shared.set(depthIndex, entry = { program: depthProgram, instances: [] });
      entry.instances.push(...instances);
    } else if (depthProgram) {
      const depthGl = this.gl.compile(depthProgram.translated);
      // cutout depth programs discard by the parameter plane: bind it too
      depth = { program: depthProgram, gl: depthGl, vao: await this.vertexArray(depthGl, depthGeometry),
        textures: await this.bindTexturesFor(depthProgram, batch) };
    }
    return {
      program, gl: glProgram, vao, count: index.count,
      indexType: index.array instanceof Uint32Array ? this.context.UNSIGNED_INT : this.context.UNSIGNED_SHORT,
      textures, depth, water: batch.water,
      // (terrain is laid of many small pieces that together cover the room: never left out for its size)
      largest: batch.category === 'terrain' ? Infinity : geometry.userData.largest,
    };
  }

  /** Builds share the page's frames: bakes and uploads go on a turn of this at a time (all rooms; none: at once). */
  pace: ((label?: string, bytes?: number) => Promise<void>) | null = null;
  /** All rooms: bakes run in this worker (none: on the page, a turn of `pace` at a time). */
  bakeWorker: GameBakeWorker | null = null;
  /** Tests: every worker bake is baked on the page too and the two compared byte for byte. */
  bakeVerify: { bakes: number; mismatches: number } | null = null;
  private async bakeBatch(input: BakeInputs): Promise<THREE.BufferGeometry[]> {
    if (!this.bakeWorker) return bakeGameGeometryAsync(input, this.pace);
    const baked = await this.bakeWorker.bake(input);
    if (this.bakeVerify) {
      const page = bakeGameGeometry(input);
      const bytes = (a: any) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const same = (a: any, b: any) => { const x = bytes(a), y = bytes(b); return x.length === y.length && x.every((v, k) => v === y[k]); };
      const ok = baked.length === page.length && baked.every((g, k) => {
        const h = page[k];
        const names = Object.keys(g.attributes);
        return same(g.getIndex()!.array, h.getIndex()!.array) && names.length === Object.keys(h.attributes).length
          && names.every((n) => !!h.attributes[n] && same(g.attributes[n].array, h.attributes[n].array));
      });
      this.bakeVerify.bakes++;
      if (!ok) this.bakeVerify.mismatches++;
    }
    return baked;
  }

  /** All rooms: a cluster's parts smaller than this many pixels where its nearest point is are not drawn. */
  clusterDetailPixels = 10;

  /** Each baked array goes up once: a part's main and depth geometries name the same arrays (positions,
   *  indices) and share their buffers. */
  private readonly uploads = new WeakMap<ArrayBufferView, Promise<WebGLBuffer>>();
  private upload(array: ArrayBufferView, index: boolean): Promise<WebGLBuffer> {
    let buffer = this.uploads.get(array);
    if (!buffer) this.uploads.set(array, buffer = this.gl.bufferSliced(array, index, this.pace));
    return buffer;
  }

  private async vertexArray(p: GameGLProgram, geometry: THREE.BufferGeometry): Promise<WebGLVertexArrayObject> {
    const gl = this.context;
    const used: { a: GameGLProgram['translated']['attributes'][number]; location: number; attribute: THREE.BufferAttribute; buffer: WebGLBuffer }[] = [];
    for (const a of p.translated.attributes) {
      const location = p.attributes.get(a.name);
      const attribute = geometry.getAttribute(a.name) as THREE.BufferAttribute | undefined;
      if (location === undefined || location < 0 || !attribute) continue;
      used.push({ a, location, attribute, buffer: await this.upload(attribute.array as ArrayBufferView, false) });
    }
    const index = await this.upload(geometry.getIndex()!.array as ArrayBufferView, true);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    for (const { a, location, attribute, buffer } of used) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      const array = attribute.array;
      const type = array instanceof Float32Array ? gl.FLOAT : array instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE;
      if (a.componentType === 'float') gl.vertexAttribPointer(location, attribute.itemSize, type, attribute.normalized, 0, 0);
      else gl.vertexAttribIPointer(location, attribute.itemSize, type, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bindVertexArray(null);
    return vao;
  }

  // ---- textures -------------------------------------------------------------

  private async blocks(image: number, sub: number): Promise<TextureLevel> {
    if (this.levels) return this.levels(image, sub);
    const r = await fetch(this.url(`images/${pad5(image)}_e${sub}.bc`));
    if (!r.ok) throw new Error(`image ${image} sub ${sub}: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const dv = new DataView(bytes.buffer);
    return { fmt: dv.getUint16(0, true), width: dv.getUint16(2, true), height: dv.getUint16(4, true), data: bytes.subarray(8) };
  }

  /** A plane (its mip chain, largest first) of a texture container. */
  texturePlane(image: number, subs: number[], srgb: boolean): Promise<GameTexture | null> {
    const key = `${image}:${subs.join(',')}:${srgb}`;
    this.noteTexture(key);
    let p = this.textures.get(key);
    if (!p) {
      p = (async () => {
        const levels = await Promise.all(subs.map((s) => this.blocks(image, s)));
        levels.sort((a, b) => b.width - a.width);
        if (!this.gl.supports(levels[0].fmt)) return null;
        if (this.pace) await this.pace('texture', levels.reduce((n, l) => n + l.data.byteLength, 0));
        const texture = this.gl.uploadTexture('texture', levels.map((l) => [l]), levels[0].fmt, srgb);
        texture.plane = { image, subs, srgb, format: levels[0].fmt, levels: levels.length };
        return texture;
      })();
      this.textures.set(key, p);
    }
    return p;
  }

  cube(image: number, count: number): Promise<GameTexture | null> {
    const key = `cube:${image}`;
    this.noteTexture(key);
    let p = this.textures.get(key);
    if (!p) {
      p = (async () => {
        const subs = await Promise.all([...Array(count)].map((_, k) => this.blocks(image, k)));
        const levels: typeof subs[] = [];
        for (let k = 0; k < subs.length; k += 6) levels.push(subs.slice(k, k + 6));
        if (!this.gl.supports(subs[0].fmt)) return null;
        return this.gl.uploadTexture('cube', levels, subs[0].fmt, true);
      })();
      this.textures.set(key, p);
    }
    return p;
  }

  /** The sub-images of the plane holding `top`, largest first: its chain's
   *  levels while width and height both halve. A level carrying its own
   *  border (36 after 68, or 312 high after 620) ends the plane. */
  private planeSubs(meta: any, top: number): number[] {
    const subs: number[][] = meta.subs ?? [];
    if (subs.length && subs.every((s) => s.length >= 3)) {
      const chains = detectChains(subs.map(([w, h, fmt]) => ({ w, h, fmt })));
      const members = subs.map((_, k) => k).filter((k) => chains[k] === chains[top])
        .sort((a, b) => subs[b][0] * subs[b][1] - subs[a][0] * subs[a][1]);
      const levels = [members[0]];
      for (const k of members.slice(1)) {
        const [w, h] = subs[levels[levels.length - 1]];
        if (subs[k][0] * 2 !== w || subs[k][1] * 2 !== h) break;
        levels.push(k);
      }
      return levels;
    }
    return [top];
  }

  /** The planes a part's textures would be made from, by slot, with their shape from the texture's own listing (no
   *  upload: joined parts take theirs from shared arrays). Null when a slot's plane is not a plain listed one. */
  private planeSpecsFor(program: GameProgram, batch: GameBatchSource, scene: GameRoomSource | null = this.building ?? this.room): Record<number, PlaneSpec> | null {
    if (batch.water || batch.renderTexture < 0 || !scene) return null;
    const meta = scene.textureMeta(batch.renderTexture);
    const listed: number[][] = meta?.subs ?? [];
    const out: Record<number, PlaneSpec> = {};
    for (const s of program.translated.samplers) {
      const name = s.textureName;
      const role = name === 'v_texture_albedo_plane' ? meta?.albedo : name === 'v_texture_normal_plane' ? meta?.normal
        : name === 'v_texture_specular_plane' ? meta?.specular ?? meta?.parameter
        : name === 'v_texture_recol_plane' ? meta?.parameter : null;
      if (role == null) continue;
      const subs = this.planeSubs(meta, role);
      const top = listed[subs[0]];
      if (!top || top.length < 3 || !this.gl.supports(top[2])) return null;
      out[s.texture] = { image: batch.renderTexture, subs, srgb: name === 'v_texture_albedo_plane', format: top[2], levels: subs.length, width: top[0], height: top[1] };
    }
    return out;
  }

  /** Whether a part can be joined (all rooms): a program with a layered form, opaque, and (a room drawn on its own)
   *  a depth program reading no texture. Its planes are checked when it is joined. */
  private async joinable(batch: GameBatchSource, cluster: boolean): Promise<boolean> {
    if (!this.joinLayers || batch.water || batch.renderTexture < 0 || batch.mesh < 0) return false;
    const [programIndex, depthIndex] = this.batchPrograms(batch);
    if (programIndex === null) return false;
    if ((!cluster || this.clusterDepth) && depthIndex !== null) {
      const depth = await this.shaders.program(depthIndex, 'clip').catch(() => null);
      if (!depth) return false;
      // (one reading a texture: in its layered form)
      if (depth.translated.samplers.length && !(await this.shaders.program(depthIndex, 'clip', true).catch(() => null))?.layered?.length) return false;
    }
    const program = await this.shaders.program(programIndex, 'clip', true).catch(() => null);
    if (!program?.layered?.length) return false;
    return !this.state(await this.shaders.program(programIndex, 'clip')).blend;
  }

  private async bindTexturesFor(program: GameProgram, batch: GameBatchSource,
    scene: GameRoomSource | null = this.building ?? this.room): Promise<Record<number, GameTexture>> {
    const out: Record<number, GameTexture> = {};
    const names = new Map(program.translated.samplers.map((s) => [s.texture, s.textureName]));
    for (const [slot, name] of names) {
      let texture: GameTexture | null = null;
      if (batch.water && scene?.water) {
        const style = scene.water.styles[batch.water.style];
        if (name === 'v_texture_normal') texture = await this.texturePlane(style.normal, [0, 1, 2], false);
        else if (name === 'v_texture_cubemap') texture = await this.cube(style.cube, 18);
        else if (name === 'v_texture_ring' && style.radial) texture = await this.texturePlane(style.radial.image, [0, 1, 2], false);
        else if (name === 'v_texture_albedo_plane' && batch.renderTexture >= 0) {
          const meta = scene.textureMeta(batch.renderTexture);
          if (meta?.albedo != null) texture = await this.texturePlane(batch.renderTexture, this.planeSubs(meta, meta.albedo), true);
        }
      } else if (batch.renderTexture >= 0) {
        const meta = scene!.textureMeta(batch.renderTexture);
        // The first parameter plane after the normal map carries the specular
        // and cutout channels, the last the recolour masks (red, green); a
        // material with one parameter plane uses it for both.
        const role = name === 'v_texture_albedo_plane' ? meta?.albedo : name === 'v_texture_normal_plane' ? meta?.normal
          : name === 'v_texture_specular_plane' ? meta?.specular ?? meta?.parameter
          : name === 'v_texture_recol_plane' ? meta?.parameter : null;
        if (role != null) texture = await this.texturePlane(batch.renderTexture, this.planeSubs(meta, role), name === 'v_texture_albedo_plane');
      }
      if (texture) out[slot] = texture;
    }
    return out;
  }

  private bound(program: GameProgram, textures: Record<number, GameTexture>): Record<number, { texture: GameTexture; sampler: WebGLSampler | null }> {
    const out: Record<number, { texture: GameTexture; sampler: WebGLSampler | null }> = {};
    for (const s of program.translated.samplers) {
      const texture = textures[s.texture];
      if (texture) out[s.texture] = { texture, sampler: s.sampler === null ? null : this.gl.sampler(program.samplers[s.sampler] ?? null) };
    }
    return out;
  }

  // ---- targets --------------------------------------------------------------

  private ensureTargets(width: number, height: number) {
    const gl = this.context;
    const w = Math.trunc(f32(width * 0.5)), h = Math.trunc(f32(height * 0.5));
    const pad = Math.trunc(h / this.index.ssao.padDivisor);
    const key = `${width}x${height}`;
    if (this.targets?.key === key) return this.targets;
    const size = this.index.shadow.size;
    const shadowDepth = this.gl.texture2D(size, size, gl.DEPTH_COMPONENT32F);
    const wa = w + 2 * pad, ha = h + 2 * pad;
    const prepassDepth = this.gl.texture2D(wa, ha, gl.DEPTH_COMPONENT32F);
    const linear = this.gl.texture2D(wa, ha, gl.R32UI, 5);
    const ao = [this.gl.texture2D(wa, ha, gl.RGBA8), this.gl.texture2D(wa, ha, gl.RGBA8)];
    const blur1 = this.gl.texture2D(wa, ha, gl.RGBA8);
    const blur3 = this.gl.texture2D(wa, ha, gl.R8);
    this.targets = {
      key, w, h, pad, wa, ha, shadowDepth, prepassDepth, linear, ao, blur1, blur3,
      shadowFb: this.gl.framebuffer(null, shadowDepth),
      prepassFb: this.gl.framebuffer(null, prepassDepth),
      linearFb: [0, 1, 2, 3, 4].map((level) => this.gl.framebuffer(linear, null, level)),
      aoFb: ao.map((t) => this.gl.framebuffer(t, null)),
      blur1Fb: this.gl.framebuffer(blur1, null),
      blur3Fb: this.gl.framebuffer(blur3, null),
      mainColour: null as GameTexture | null, mainDepth: null as GameTexture | null, mainFb: null as WebGLFramebuffer | null,
    };
    // the fog: its half-resolution target and the blur's, and the noise it reads (made once)
    const fog = [this.gl.texture2D(w, h, gl.RGBA16F), this.gl.texture2D(w, h, gl.RGBA16F)];
    const noise = this.gl.texture2D(256, 256, gl.RGBA8);
    Object.assign(this.targets, { fog, fogFb: fog.map((t) => this.gl.framebuffer(t, null)), noise,
      noiseFb: this.gl.framebuffer(noise, null), noiseReady: false });
    this.targets.mainColour = this.gl.texture2D(width, height, gl.RGBA8);
    this.targets.mainDepth = this.gl.texture2D(width, height, gl.DEPTH_COMPONENT32F);
    this.targets.mainFb = this.gl.framebuffer(this.targets.mainColour, this.targets.mainDepth);
    // AO history starts empty (validity 0): the first frame takes its own value.
    for (const fb of this.targets.aoFb) { gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    return this.targets;
  }

  private fullscreenVao(p: GameGLProgram): WebGLVertexArrayObject {
    const gl = this.context;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const a = p.translated.attributes[0];
    const location = a ? p.attributes.get(a.name) : undefined;
    if (location !== undefined && location >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gl.buffer(new Float32Array([-1, 1, 1, 1, -1, -1, 1, -1])));
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  private readonly states = new Map<string, DrawState>();
  /** A program's draw state (made once per program and colour write; the GL layer compares it by value). */
  private state(program: GameProgram, override: Partial<DrawState> = {}): DrawState {
    const keys = Object.keys(override);
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'colourWrite')) return this.makeState(program, override);
    const key = `${program.index}|${program.y}|${override.colourWrite === false ? 0 : 1}`;
    let state = this.states.get(key);
    if (!state) this.states.set(key, state = this.makeState(program, override));
    return state;
  }

  private makeState(program: GameProgram, override: Partial<DrawState>): DrawState {
    const row = this.index.programs[program.index];
    const [, , compare, write, blend, cull] = row;
    const gl = this.context;
    // D3D fronts are clockwise as seen on the target, GL fronts (CCW default)
    // counter-clockwise, so the source's CULL_FRONT removes what GL calls
    // back faces; the clip convention mirrors the image and so the winding.
    const mirrored = program.y === 'clip';
    const cullFace = cull === 0 ? (mirrored ? gl.FRONT : gl.BACK) : cull === 1 ? (mirrored ? gl.BACK : gl.FRONT) : null;
    return {
      depthTest: compare !== 0, depthFunc: D3D_COMPARE_GL[compare] || gl.LESS, depthWrite: compare !== 0 && write === 1,
      blend: blendToGL(blend >= 0 ? this.index.blends[blend] : null), cull: cullFace, colourWrite: true, ...override,
    };
  }

  // ---- the frame ------------------------------------------------------------

  /** Draw the frame, then copy it to the canvas unless `offscreen` (captures
   *  read the offscreen frame with readTarget('main')). */
  render(camera: GameCamera, ticks: number, avatarZ: number, offscreen = false): void {
    if (!this.main) return;
    this.withClipControl(() => this.renderFrame(camera, ticks, avatarZ, offscreen, [this.main!], [this.main!], null));
  }

  /** All rooms: draw `scenes` (those in view, nearest first), with the shadow map fitted over `box`
   *  (native: min x, y, z, max x, y, z) and cast by `casters`, and the ambient occlusion of
   *  `occluders` (default: every scene), then copy the frame to the canvas where it drew (the canvas
   *  keeps what it holds elsewhere: the view beyond the rooms drawn). */
  renderWorld(camera: GameCamera, ticks: number, avatarZ: number, scenes: GameScene[], casters: GameScene[], box: number[],
    occluders: GameScene[] = scenes, shadowTiles: Map<GameScene, ShadowTile> | null = null): void {
    if (!scenes.length) return;
    this.withClipControl(() => this.renderFrame(camera, ticks, avatarZ, false, scenes, casters, box, occluders, shadowTiles));
  }

  /** All rooms with everything kept: a shadow map over `box` (native: min x, y, z, max x, y, z) of `size`
   *  pixels, drawn once from `casters` (into `reuse`'s texture when it is the same size). */
  bakeShadowTile(box: number[], casters: GameScene[], size: number, reuse: ShadowTile | null = null): ShadowTile {
    const gl = this.context, idx = this.index;
    const { fit, receiver, offset } = shadowFitBox(box, idx.shadow.lightView, size);
    let tile = reuse && reuse.size === size ? reuse : null;
    if (reuse && !tile) this.freeShadowTile(reuse);
    if (!tile) {
      const depth = this.gl.texture2D(size, size, gl.DEPTH_COMPONENT32F);
      tile = { depth, fb: this.gl.framebuffer(null, depth), size, fit, receiver, offset };
    }
    Object.assign(tile, { fit, receiver, offset });
    const L = lightViewMatrix(idx.shadow.lightView);
    const clip = new THREE.Matrix4().set(2 / size, 0, 0, -1, 0, -2 / size, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1).multiply(fit).multiply(L);
    this.withClipControl(() => {
      this.bindRoomMask();
      this.gl.forgetState();
      gl.bindFramebuffer(gl.FRAMEBUFFER, tile!.fb);
      gl.viewport(0, 0, size, size);
      gl.depthMask(true); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
      this.gl.forgetState();
      for (const scene of casters) {
        const place = scene.origin ? new THREE.Matrix4().makeTranslation(scene.origin.x, scene.origin.y, scene.origin.z) : null;
        const words = neutralWords(place ? clip.clone().multiply(place) : clip);
        for (const d of [...scene.depthDraws, ...this.solidDraws(scene)]) if (d.depth) this.drawDepth(d, words, size);
      }
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    });
    return tile;
  }

  freeShadowTile(tile: ShadowTile): void {
    this.context.deleteFramebuffer(tile.fb);
    this.context.deleteTexture(tile.depth.texture);
  }

  /** One depth draw (a shadow caster, the occlusion prepass) with its vertex constants. */
  private drawDepth(d: Draw, words: Uint32Array, targetHeight: number): void {
    const gl = this.context;
    this.gl.applyState(d.depthState ??= this.state(d.depth!.program, { colourWrite: false }));
    d.depth!.bound ??= this.bound(d.depth!.program, d.depth!.textures);
    const cbs = d.depth!.cbs ??= {};
    cbs[d.depth!.program.translated.constantBuffers.vs[0]?.uniform ?? 'cb0_vs'] = words;
    this.gl.bindResources(d.depth!.gl, cbs, d.depth!.bound, 'ps', targetHeight, boneBindings(d.depth!.program, d.bones?.texture));
    gl.bindVertexArray(d.depth!.vao);
    gl.drawElements(gl.TRIANGLES, d.count, d.indexType, 0);
  }

  private withClipControl(draw: () => void): void {
    const clip = this.clipControl;
    if (clip) clip.clipControlEXT(clip.LOWER_LEFT_EXT, clip.ZERO_TO_ONE_EXT);
    this.gl.beginFrame();
    this.gl.forgetState();   // three drew since
    try {
      draw();
    } finally {
      if (clip) clip.clipControlEXT(clip.LOWER_LEFT_EXT, clip.NEGATIVE_ONE_TO_ONE_EXT);
      this.gl.releaseSamplers();
    }
  }

  /** A scene's lighting and vignette as the game sets them for its room, in the room's frame. */
  private sceneLook(scene: GameScene, avatarZ: number) {
    const idx = this.index, room = scene.source;
    // a room an event haunts takes its haunted lighting while its fog shows (the event's state the fog draws)
    const haunting = this.showFog && idx.fog?.rooms.some((f) => f.id === room.roomId) ? idx.haunted?.[String(room.roomId)] : undefined;
    const override = scene === this.main ? this.environmentOverride : null;
    const env = override ?? haunting ?? idx.environments[String(room.roomId)] ?? null;
    // Vignette and height fade.
    const height = env?.height === 'avatar' ? avatarZ + idx.vignette.avatarOffset : (env?.height ?? 0);
    const [z0, w0, z1, w1] = idx.vignette.avatarFloor;
    const floorValue = env?.floor === 'avatar'
      ? (avatarZ <= z0 ? w0 : avatarZ >= z1 ? w1 : w0 + (w1 - w0) * (avatarZ - z0) / (z1 - z0))
      : (env?.floor ?? 1);
    // The vignette object as the game builds it, in single precision.
    const rect = [0, 0, f32(room.bounds.inner[2] * this.tileUnits), f32(room.bounds.inner[3] * this.tileUnits)];
    const hx = f32(f32(rect[2] - rect[0]) * 0.5), hy = f32(f32(rect[3] - rect[1]) * 0.5);
    const vignetteColour = env?.vignette ?? [0, 0, 0, 1];
    const reachK = (radius: number) => f32(f32(radius / Math.max(hx, hy)) + 1);
    // The ground plane's vignette reaches its own edge and has no height fade;
    // a longer floor stretches it (an endless one has none).
    const planeRadius = Number.isFinite(this.planeDistance)
      ? idx.vignette.overlayRadius * this.planeDistance / PLANE_GAME_DISTANCE : 1e12;
    // where the room's frame sits (translation), and its inverse
    const place = scene.origin ? new THREE.Matrix4().makeTranslation(scene.origin.x, scene.origin.y, scene.origin.z) : null;
    // (a cluster of rooms has no room's vignette: nothing fades)
    const far = 1e12;
    // the view's reach (viewerReach): the room's fade stretches with the floor as the floor's does, gone with an
    // endless floor or with the neighbouring rooms shown (a free camera sees well past the game's)
    let radius = idx.vignette.radius;
    if (this.viewerReach) {
      const stretch = Number.isFinite(this.planeDistance) ? Math.max(1, this.planeDistance / PLANE_GAME_DISTANCE) : Infinity;
      radius = room.others?.length || stretch === Infinity ? far : radius * stretch;
    }
    return { env, height, floorValue, rect, hx, hy, vignetteColour, k: reachK(scene.cluster ? far : radius),
      kPlane: reachK(scene.cluster ? far : planeRadius), place };
  }

  private renderFrame(camera: GameCamera, ticks: number, avatarZ: number, offscreen: boolean,
    scenes: GameScene[], casters: GameScene[], worldBox: number[] | null, occluders: GameScene[] = scenes,
    shadowTiles: Map<GameScene, ShadowTile> | null = null): void {
    if (!scenes.length || !this.passPrograms.size) return;
    for (const scene of scenes) this.updateLights(scene, ticks);
    const gl = this.context;
    const idx = this.index;
    const near = camera.near ?? idx.camera.near, far = camera.far ?? idx.camera.far;
    const aspect = camera.width / camera.height;
    const view = gameView(camera.eye, camera.target, camera.up ?? null);
    const projection = gameProjection(camera.fov, aspect, near, far);
    const card = this.card;
    if (card) {
      // pixel shift after the projection: clip x,y move by 2*shift/size times w
      projection.premultiply(new THREE.Matrix4().set(
        1, 0, 0, 2 * card.shift[0] / camera.width,
        0, 1, 0, -2 * card.shift[1] / camera.height,
        0, 0, 1, 0,
        0, 0, 0, 1));
    }
    const viewProjection = projection.clone().multiply(view);
    const t = this.ensureTargets(camera.width, camera.height);
    for (const scene of scenes) this.updateActors(scene);
    this.bindRoomMask();
    this.gl.forgetState();   // the uploads above bound their textures
    const looks = new Map(scenes.map((scene) => [scene, this.sceneLook(scene, avatarZ)]));
    for (const scene of casters) if (!looks.has(scene)) looks.set(scene, this.sceneLook(scene, avatarZ));
    // a matrix taking the frame to clip space, for a scene placed off the origin: it times the scene's place
    const placed = (m: THREE.Matrix4, look: ReturnType<GameFrame['sceneLook']>) => (look.place ? m.clone().multiply(look.place) : m);

    // Shadow receiver fit over the scene box.
    // (a room: its rect grown by the margin, within the loaded rooms, merged
    // with the outer rect; the height of the most layers loaded. All rooms:
    // the box given)
    let box = worldBox;
    if (!box) {
      const room = scenes[0].source;
      const { inner, outer } = room.bounds;
      const loaded = room.bounds.loaded ?? inner;
      const layers = room.bounds.loadedLayers ?? room.bounds.layers;
      const margin = idx.shadow.marginTiles;
      box = [
        Math.min(Math.max(inner[0] - margin, loaded[0]), outer[0]) * this.tileUnits,
        Math.min(Math.max(inner[1] - margin, loaded[1]), outer[1]) * this.tileUnits, 0,
        Math.max(Math.min(inner[2] + margin, loaded[2]), outer[2]) * this.tileUnits,
        Math.max(Math.min(inner[3] + margin, loaded[3]), outer[3]) * this.tileUnits, idx.shadow.layerHeight * layers];
    }
    // (all rooms: over the box itself, so the map holds while the rooms casting it and their actors do)
    const shadow = worldBox ? shadowFitBox(box, idx.shadow.lightView, idx.shadow.size)
      : shadowFit(view, camera.fov, aspect, near, far, box, idx.shadow.lightView, idx.shadow.size);
    const shadowKey = worldBox ? `${box.join(',')}|${casters.map((c) => this.sceneSerial(c)).join(',')}|${this.showPlane}` : null;
    const shadowHeld = !!shadowKey && shadowKey === this.shadowKey && !this.actorsMoved && !this.timePasses && t.shadowKey === shadowKey;
    this.shadowKey = shadowKey;
    this.actorsMoved = false;
    const size = idx.shadow.size;
    const L = lightViewMatrix(idx.shadow.lightView);
    const pixelToClip = new THREE.Matrix4().set(2 / size, 0, 0, -1, 0, -2 / size, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1);
    const casterClip = pixelToClip.clone().multiply(shadow.fit).multiply(L);

    // The main pass fades to the vignette colour away from the room and
    // darkens low ground; depth passes and the water (neutral vignette, as in
    // the game) do not.
    const vsWords = (look: ReturnType<GameFrame['sceneLook']>, wvp: THREE.Matrix4, receiver: THREE.Matrix4 | null, offset: number, neutral = false, plane = false) => {
      const { rect, hx, hy, vignetteColour, k, kPlane, height, floorValue } = look;
      const words = new Uint32Array(72);
      putFloats(words, 0, rows(wvp));
      putFloats(words, 64, rows(wvp));
      putFloats(words, 128, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
      if (receiver) putFloats(words, 176, rows(receiver));
      if (neutral) {
        putFloats(words, 240, [0, 0, 0, 0, 0, 0, 0, 10000, offset, 0, 0, 1]);
      } else {
        putFloats(words, 240, [f32(f32(rect[0] + rect[2]) * 0.5), f32(f32(rect[1] + rect[3]) * 0.5), f32(1 / hx), f32(1 / hy)]);
        putFloats(words, 256, [vignetteColour[0] * idx.lighting.fade, vignetteColour[1] * idx.lighting.fade, vignetteColour[2] * idx.lighting.fade, plane ? kPlane : k]);
        // (the floor's brightness through its height fade: hf = saturate((z - 0) / 1) (1 - b) + b = b at z = 0;
        // at 1 the game's own words)
        putFloats(words, 272, plane ? (this.planeBrightness === 1 ? [offset, 0, 0, 1] : [offset, 0, 1, f32(this.planeBrightness)])
          : [offset, 0, height, floorValue]);
      }
      return words;
    };
    // Depth-only draws of every caster (none for a card) into the bound
    // target; the ambient occlusion prepass also takes the ground plane.
    const planeOf = (scene: GameScene) => (this.showPlane && !card ? scene.planeDraws : []);
    for (const scene of scenes) for (const d of planeOf(scene)) if (d.covers) d.count = planeCount(d.covers, this.planeDistance) * 6;
    const counts = this.lastDraws = { shadow: 0, prepass: 0, main: 0, water: 0, fog: 0 };
    let passStart = performance.now();
    const passDone = (name: string) => {
      if (!this.timePasses) return;
      // the page's time submitting the pass, then the GPU's finishing it
      const submitted = performance.now();
      gl.finish();
      const now = performance.now();
      this.lastPassTimes[name] = +(now - passStart).toFixed(2);
      this.lastPassTimes[`${name}Cpu`] = +(submitted - passStart).toFixed(2);
      passStart = now;
    };
    if (this.timePasses) { gl.finish(); passStart = performance.now(); this.lastPassTimes = {}; }
    const drawDepths = (draws: Draw[], words: Uint32Array, targetHeight: number, pass: 'shadow' | 'prepass') => {
      for (const d of card ? [] : draws) {
        if (!d.depth) continue;
        counts[pass]++;
        this.drawDepth(d, words, targetHeight);
      }
    };

    // ---- shadow pass (all rooms: kept from the last frame when nothing it draws has changed)
    if (!shadowHeld) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.shadowFb);
      gl.viewport(0, 0, size, size);
      gl.depthMask(true); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
      this.gl.forgetState();
    }
    t.shadowKey = shadowKey;
    let casterWords: Uint32Array | null = null;
    for (const scene of shadowHeld ? [] : casters) {
      const look = looks.get(scene)!;
      const words = vsWords(look, placed(casterClip, look), null, 0, true);
      casterWords ??= words;
      drawDepths([...scene.depthDraws, ...this.solidDraws(scene)], words, size, 'shadow');
    }

    passDone('shadow');
    // ---- ambient occlusion
    const ssao = idx.ssao;
    const fAo = (t.h / 2) / Math.tan(camera.fov * Math.PI / 360);
    // Pixel projection of the padded half-resolution view, then to clip space.
    const aoProjection = new THREE.Matrix4().set(
      fAo, 0, t.w / 2 + t.pad, 0,
      0, fAo, t.h / 2 + t.pad, 0,
      0, 0, f32(far / (far - near)), -f32(far * near / (far - near)),
      0, 0, 1, 0);
    // camera z_in_y_down: (x right, y down, z forward) from the game view space (x, y out, z up)
    const toInYDown = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
    const aoPixelToClip = new THREE.Matrix4().set(2 / t.wa, 0, 0, -1, 0, -2 / t.ha, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1);
    const prepassClip = aoPixelToClip.clone().multiply(aoProjection).multiply(toInYDown).multiply(view);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.prepassFb);
    gl.viewport(0, 0, t.wa, t.ha);
    gl.depthMask(true); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    this.gl.forgetState();
    let prepassWords: Uint32Array | null = null;
    for (const scene of occluders) {
      const look = looks.get(scene)!;
      const words = vsWords(look, placed(prepassClip, look), null, 0, true);
      prepassWords ??= words;
      drawDepths([...planeOf(scene), ...scene.depthDraws, ...this.solidDraws(scene)], words, t.ha, 'prepass');
    }
    passDone('prepass');
    const n5 = f32(near / ssao.unit), f5 = f32(far / ssao.unit);
    const hp2 = (v: number) => { let b = 1; while (b * 2 <= v) b *= 2; return b; };
    const S = f32(2 * hp2(Math.trunc(0x7fffffff / Math.trunc(f5))));
    const linearParams = [f32(n5 * f5), f32(n5 - f5), f5, S];
    const fullscreen = (programIndex: number, fb: WebGLFramebuffer, w: number, h: number,
      cbs: (p: GameProgram) => Record<string, Uint32Array>, textures: Record<number, GameTexture>) => {
      const program = this.passPrograms.get(programIndex)!;
      const glProgram = this.gl.compile(program.translated);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, w, h);
      this.gl.applyState({ depthTest: false, depthFunc: gl.LESS, depthWrite: false, blend: null, cull: null, colourWrite: true });
      this.gl.bindResources(glProgram, cbs(program), this.bound(program, textures), 'ps', h);
      if (!this.fullscreen) this.fullscreen = this.fullscreenVao(glProgram);
      gl.bindVertexArray(this.fullscreen);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const cb = (program: GameProgram, values: number[]) => {
      const binding = program.translated.constantBuffers.ps[0];
      const words = new Uint32Array((binding?.sizeVec4 ?? 1) * 4);
      putFloats(words, 0, values);
      return binding ? { [binding.uniform]: words } : {};
    };
    for (let level = 0; level < 5; level++) {
      fullscreen(ssao.programs.mips[level], t.linearFb[level], Math.max(1, t.wa >> level), Math.max(1, t.ha >> level),
        (p) => cb(p, linearParams), { 0: t.prepassDepth });
    }
    // Temporal reprojection: previous view from the current camera space.
    const current = view;
    const previous = this.lastView ?? view;
    const relative = toInYDown.clone().multiply(previous).multiply(current.clone().invert()).multiply(toInYDown.clone().invert());
    const scale500 = new THREE.Matrix4().makeScale(ssao.unit, ssao.unit, ssao.unit);
    const uv = new THREE.Matrix4().makeScale(1 / t.wa, 1 / t.ha, 1);
    const reprojection = uv.multiply(new THREE.Matrix4().set(
      fAo, 0, t.w / 2 + t.pad, 0,
      0, fAo, t.h / 2 + t.pad, 0,
      0, 0, 1, 0,
      0, 0, 1, 0)).multiply(relative).multiply(scale500);
    if (!this.holdOcclusion) this.ssaoFrame = (this.ssaoFrame + 1) % 4;
    const weight = f32(Math.pow(ssao.temporalBase, ssao.frameMs / ssao.temporalDivisor));
    const current_ = this.ssaoPrevious ^ 1;
    fullscreen(ssao.programs.sao, t.aoFb[current_], t.wa, t.ha, (p) => cb(p, [
      fAo, fAo, 0.5 - (t.w / 2 + t.pad), 0.5 - (t.h / 2 + t.pad),
      ssao.radius, ssao.falloff, 1 / f5, 1 / S,
      this.ssaoFrame * 10, this.lastView ? weight : 1, 0, 0,
      ...rows(reprojection),
    ]), { 0: t.linear, 1: t.ao[this.ssaoPrevious] });
    this.ssaoPrevious = current_;
    fullscreen(ssao.programs.blurH, t.blur1Fb, t.wa, t.ha, () => ({}), { 0: t.ao[current_] });
    fullscreen(ssao.programs.blurV, t.blur3Fb, t.wa, t.ha, () => ({}), { 0: t.blur1 });
    if (card) {
      // no occlusion: the occlusion the main pass reads is 1 everywhere
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.blur3Fb);
      gl.viewport(0, 0, t.wa, t.ha);
      gl.colorMask(true, true, true, true);
      gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      this.gl.forgetState();
    }
    this.lastView = view.clone();
    passDone('ssao');
    const ssaoOffsetScale = [
      t.pad / (t.w / camera.width), t.pad / (t.h / camera.height),
      (t.w / camera.width) / t.wa, (t.h / camera.height) / t.ha,
    ];

    // ---- main pass, offscreen in the source's own orientation (its rasteriser
    // tie rules and derivative quads, single sample), then copied to the canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.mainFb);
    gl.viewport(0, 0, camera.width, camera.height);
    gl.depthMask(true); gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.gl.forgetState();
    const d0 = card?.direction ?? idx.lighting.direction;
    const dir = new THREE.Vector3(d0[0], d0[1], d0[2]).normalize();
    // A scene's lights at a scale: the room shown at the fade, a neighbour
    // at a tenth of it (the game's neighbour lighting buffer at rest), except
    // the neighbour's pieces marked lit (its frontage: the shown room's lights).
    // The eye is in the room's frame.
    const lighting = (scene: GameScene, look: ReturnType<GameFrame['sceneLook']>, scale: number) => {
      const { env } = look;
      const light = (c: number[] | undefined, fallback: number[]) => {
        const v = c ?? fallback;
        return [0, 1, 2].map((k) => f32(f32(Math.pow(v[k], idx.lighting.gamma)) * v[3] * scale));
      };
      const o = scene.origin;
      return [
        o ? camera.eye.x - o.x : camera.eye.x, o ? camera.eye.y - o.y : camera.eye.y, o ? camera.eye.z - o.z : camera.eye.z, 0,
        ...light(env?.ground, [0.4314, 0.2863, 0.1529, 1]), 1,
        ...light(env?.sky, [0.8157, 0.8784, 0.9412, 1]), 1,
        ...light(env?.sun, [1, 0.8784, 0.5647, 1.5]), 1,
        dir.x, dir.y, dir.z, 0,
        ...ssaoOffsetScale,
        scale, 0, 0, 0,
        // the point light grid: origin, cells per unit, strength (07-Oct-2026 on; older programs stop before it)
        ...(scene.lights ? [...scene.lights.grid, f32(this.pointLightStrength * scale)] : [0, 0, 0, 0]),
      ];
    };
    const faded = (d: Draw) => this.neighbourFade && !!d.scene;
    const shadowSampler = this.gl.sampler([0x95, 3, 3, 3, 4, 0, 15, 0, 1]);
    // each scene's constants for the main pass, made once per frame
    const sceneWords = new Map<GameScene, { main: Uint32Array; plane: Uint32Array; water: Uint32Array; ps: number[]; psNeighbour: number[];
      psWords: Map<number, Uint32Array> }>();
    for (const scene of scenes) {
      const look = looks.get(scene)!;
      // (its own shadow map's, where it has one)
      const tile = shadowTiles?.get(scene);
      const wvp = placed(viewProjection, look), receiver = placed(tile?.receiver ?? shadow.receiver, look);
      const offset = tile?.offset ?? shadow.offset;
      sceneWords.set(scene, {
        main: vsWords(look, wvp, receiver, offset, !!card),
        plane: vsWords(look, wvp, receiver, offset, !!card, true),
        water: vsWords(look, wvp, receiver, offset, true),
        ps: lighting(scene, look, idx.lighting.fade),
        psNeighbour: lighting(scene, look, f32(idx.lighting.fade * NEIGHBOUR_LIGHT)),
        psWords: new Map(),
      });
    }
    const first = sceneWords.get(scenes[0])!;
    this.lastConstants = { caster: casterWords ?? vsWords(looks.get(scenes[0])!, casterClip, null, 0, true),
      prepass: prepassWords!, main: first.main, plane: first.plane };
    const drawMain = (scene: GameScene, d: Draw, waterWords: Uint32Array | null, words = sceneWords.get(scene)!.main) => {
      const sw = sceneWords.get(scene)!;
      counts[d.water ? 'water' : 'main']++;
      this.gl.applyState(d.mainState ??= this.state(d.program));
      const cbs = d.cbs ??= {};
      for (const b of d.program.translated.constantBuffers.vs) {
        // a neighbour's water takes the main vignette, the room's own the neutral one
        cbs[b.uniform] = b.slot === 0 ? (waterWords ? (faded(d) ? sw.main : sw.water) : words) : (waterWords ?? this.zeroWords(b.sizeVec4 * 4));
      }
      // water keeps the scene's own lights (the overlay pass)
      const neighbour = faded(d) && !d.water && !d.lit;
      for (const b of d.program.translated.constantBuffers.ps) {
        // (made once per scene and size: the same words are not sent to a program twice)
        const key = neighbour ? -b.sizeVec4 : b.sizeVec4;
        let words = sw.psWords.get(key);
        if (!words) { words = new Uint32Array(b.sizeVec4 * 4); putFloats(words, 0, neighbour ? sw.psNeighbour : sw.ps); sw.psWords.set(key, words); }
        cbs[b.uniform] = words;
      }
      // its textures (the frame's targets, its shadow map and the scene's lights among them), made again when those change
      const shadowDepth = shadowTiles?.get(scene)?.depth ?? t.shadowDepth;
      if (!d.mainBound || d.mainBound.targets !== t || d.mainBound.lights !== scene.lights || d.mainBound.shadow !== shadowDepth) {
        const textures: Record<number, { texture: GameTexture; sampler: WebGLSampler | null }> = {};
        d.program.translated.samplers.forEach((s) => {
          const desc = d.program.samplers[s.sampler ?? -1] ?? null;
          if (s.textureName === 'v_texture_shadow_map') textures[s.texture] = { texture: shadowDepth, sampler: shadowSampler };
          else if (s.textureName === 'v_cbo_f1' && scene.lights) textures[s.texture] = { texture: scene.lights.data, sampler: null };
          else if (s.textureName === 'v_cbo_f2' && scene.lights) textures[s.texture] = { texture: scene.lights.cells, sampler: null };
          else if (s.textureName === 'v_texture_ssao') textures[s.texture] = { texture: t.blur3, sampler: this.gl.sampler(desc) };
          else if (d.textures[s.texture]) textures[s.texture] = { texture: d.textures[s.texture], sampler: this.gl.sampler(desc) };
        });
        d.mainBound = { targets: t, lights: scene.lights, shadow: shadowDepth, textures };
      }
      this.gl.bindResources(d.gl, cbs, d.mainBound.textures, 'ps', camera.height, boneBindings(d.program, d.bones?.texture));
      gl.bindVertexArray(d.vao);
      gl.drawElements(gl.TRIANGLES, d.count, d.indexType, 0);
    };
    // the ground plane first, then the room (a cluster: without its parts too small to see from where it is)
    const pixelsPerUnitAt1 = camera.height / (2 * Math.tan(camera.fov * Math.PI / 360));
    const edged = this.planeEdge && Number.isFinite(this.planeDistance) && this.showPlane && !card;
    for (const scene of scenes) {
      const sw = sceneWords.get(scene)!;
      for (const d of planeOf(scene)) drawMain(scene, d, null, sw.plane);
      const edge = edged ? scene.planeEdge : null, floor = planeOf(scene)[0];
      if (edge && floor) {
        const n = planeCount(edge.covers, this.planeDistance);
        if (n) this.drawPlaneEdge(edge, placed(viewProjection, looks.get(scene)!), floor.program.y, n);
      }
      let minLargest = 0;
      if (scene.cluster && scene.bounds && this.clusterDetailPixels > 0) {
        const o = scene.origin ?? new THREE.Vector3(), b = scene.bounds, e = camera.eye;
        const dist = Math.hypot(Math.max(o.x + b[0] - e.x, 0, e.x - o.x - b[3]), Math.max(o.y + b[1] - e.y, 0, e.y - o.y - b[4]),
          Math.max(o.z + b[2] - e.z, 0, e.z - o.z - b[5]));
        minLargest = this.clusterDetailPixels * dist / pixelsPerUnitAt1;
      }
      for (const d of this.solidDraws(scene)) if (!minLargest || (d.largest ?? Infinity) >= minLargest) drawMain(scene, d, null);
    }
    passDone('main');
    // then the water (all rooms: the farthest room's first, as it blends over what is behind it)
    for (const scene of worldBox ? [...scenes].reverse() : scenes) {
      const water = scene.source.water;
      for (const d of this.skipWater ? [] : scene.waterDraws) {
        const style = water.styles[d.water!.style];
        const [l0, l1] = style.layers;
        const words = new Uint32Array(d.water!.kind === 'surface' ? 20 : 12);
        const sine = [
          style.waves.amplitude[0], style.waves.frequency[0], f32(style.waves.rate[0] * ticks), style.waves.tilt[0],
          style.waves.amplitude[1], style.waves.frequency[1], f32(style.waves.rate[1] * ticks), style.waves.tilt[1],
          water.level, style.level, 0, 0,
        ];
        // From 07-Oct-2026 the surface's buffer goes on: the outer fade (start, radius) in the level's
        // last two words, then the rings (amplitude, frequency, phase, inner radius); every style writes it.
        const ringBuffer = d.program.translated.constantBuffers.vs.find((b) => b.slot === 1);
        const ringWords = d.water!.kind === 'surface' && ringBuffer && ringBuffer.sizeVec4 * 4 >= 24 ? new Uint32Array(24) : null;
        if (ringWords) {
          const r = style.radial;
          const outer = Math.max(r?.outer ?? 0, 2);
          sine[10] = f32(Math.min(r?.fadeStart ?? 0.6, 0.99) * outer); sine[11] = outer;
          const phase = r ? f32(r.speed * ticks) % 1 : 0;
          putFloats(ringWords, 80, r ? [r.amplitude, r.frequency, phase < 0 ? phase + 1 : phase, Math.max(r.inner, 1)] : [0, 0, 0, 1]);
        }
        if (d.water!.kind === 'surface') {
          putFloats(ringWords ?? words, 0, [l0[0], l0[1], f32(l0[2] * ticks), f32(l0[3] * ticks), l1[0], l1[1], f32(l1[2] * ticks), f32(l1[3] * ticks), ...sine]);
        } else putFloats(words, 0, sine);
        drawMain(scene, d, ringWords ?? words);
      }
    }
    passDone('water');
    // the volumetric fog of the rooms that have it
    for (const scene of this.showFog && !card ? scenes.filter((s) => !s.cluster) : []) {
      const fogRoom = idx.fog?.rooms.find((f) => f.id === scene.source.roomId);
      if (!fogRoom) continue;
      const look = looks.get(scene)!;
      const { rect, hx, hy, vignetteColour, k, height, floorValue } = look;
      // the view in the room's frame
      const viewToWorld = toInYDown.clone().multiply(view).invert();
      const viewToRoom = look.place ? new THREE.Matrix4().makeTranslation(-scene.origin!.x, -scene.origin!.y, -scene.origin!.z).multiply(viewToWorld) : viewToWorld;
      const eye = scene.origin ? camera.eye.clone().sub(scene.origin) : camera.eye;
      const u = this.tileUnits, lights = scene.lights;
      const words = fogMarchConstants({
        w: t.w, h: t.h, pad: t.pad, focal: fAo, near, far, viewToWorld: viewToRoom, eye,
        area: fogRoom.rect, ground: fogRoom.ground, seconds: ticks / idx.clock.ticksPerSecond,
        focus: [-fogRoom.origin[0] * u, -fogRoom.origin[1] * u],
        lights: lights ? [...lights.grid, this.pointLightStrength] : null,
        ellipse: [f32(f32(rect[0] + rect[2]) * 0.5), f32(f32(rect[1] + rect[3]) * 0.5), f32(1 / hx), f32(1 / hy)],
        vignette: [vignetteColour[0] * idx.lighting.fade, vignetteColour[1] * idx.lighting.fade, vignetteColour[2] * idx.lighting.fade],
        reach: k, fade: [0, height, floorValue],
        shadow: rows(placed(shadow.receiver, look)), sunDirection: idx.lighting.direction, sunColour: [1, 224 / 255, 144 / 255],
      });
      counts.fog++;
      this.renderFog(t, words, fullscreen, camera.width, camera.height, lights);
      this.gl.forgetState();   // the fog's composite binds its own
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.mainFb);
      gl.viewport(0, 0, camera.width, camera.height);
    }
    passDone('fog');
    gl.bindVertexArray(null);
    if (!offscreen) this.present(t, camera.width, camera.height, !!worldBox);
    passDone('present');
  }

  private compositeProgram: { program: WebGLProgram; size: WebGLUniformLocation } | null = null;

  /** The fog's passes: the noise (once), the march over the half-resolution depth, the blur along x then
   *  y, the edge pass, then the fog laid over the frame premultiplied (one, one minus source alpha). */
  private renderFog(t: any, march: number[], fullscreen: (programIndex: number, fb: WebGLFramebuffer, w: number, h: number,
    cbs: (p: GameProgram) => Record<string, Uint32Array>, textures: Record<number, GameTexture>) => void, width: number, height: number,
    pointLights: PackedLightTextures | null): void {
    const gl = this.context;
    const fog = this.index.fog!.programs;
    const constants = (values: number[]) => (p: GameProgram) => {
      const binding = p.translated.constantBuffers.ps[0];
      if (!binding) return {};
      const words = new Uint32Array(binding.sizeVec4 * 4);
      putFloats(words, 0, values);
      return { [binding.uniform]: words };
    };
    // textures by name for a pass (its resources by slot)
    const named = (program: number, byName: Record<string, GameTexture>) => {
      const out: Record<number, GameTexture> = {};
      for (const s of this.passPrograms.get(program)!.translated.samplers) if (byName[s.textureName]) out[s.texture] = byName[s.textureName];
      return out;
    };
    if (!t.noiseReady) {
      fullscreen(fog.noise, t.noiseFb, 256, 256, () => ({}), {});
      t.noiseReady = true;
    }
    const depth = t.prepassDepth;
    // the march reads the room's point lights too (the same list and cells the materials read)
    const lights: Record<string, GameTexture> = pointLights ? { v_point_lights: pointLights.data, v_point_light_cells: pointLights.cells } : {};
    fullscreen(fog.march, t.fogFb[0], t.w, t.h, constants(march), named(fog.march, {
      v_texture_depth: depth, v_texture_noise: t.noise, v_texture_shadow_map: t.shadowDepth, ...lights }));
    fullscreen(fog.blurX, t.fogFb[1], t.w, t.h, constants(march), { 0: t.fog[0], 1: depth });
    fullscreen(fog.blurY, t.fogFb[0], t.w, t.h, constants(march), { 0: t.fog[1], 1: depth });
    fullscreen(fog.edge, t.fogFb[1], t.w, t.h, constants(march), { 0: t.fog[0], 1: depth });
    if (!this.compositeProgram) {
      const program = this.gl.linkSources(`#version 300 es
void main() {
  gl_Position = vec4(float((gl_VertexID & 1) * 4) - 1.0, float((gl_VertexID & 2) * 2) - 1.0, 0.0, 1.0);
}`, `#version 300 es
precision highp float;
uniform highp sampler2D u_fog;
uniform vec2 u_size;
out vec4 o;
void main() {
  o = texture(u_fog, gl_FragCoord.xy / u_size);
}`);
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'u_fog'), 0);
      this.compositeProgram = { program, size: gl.getUniformLocation(program, 'u_size')! };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.mainFb);
    gl.viewport(0, 0, width, height);
    this.gl.applyState({ depthTest: false, depthFunc: gl.ALWAYS, depthWrite: false, cull: null, colourWrite: true,
      blend: [gl.FUNC_ADD, gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.FUNC_ADD, gl.ONE, gl.ONE_MINUS_SRC_ALPHA] });
    gl.useProgram(this.compositeProgram.program);
    gl.uniform2f(this.compositeProgram.size, width, height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.fog[1].texture);
    gl.bindSampler(0, this.gl.sampler([20, 3, 3, 3, 1, 0, 10, 0, 1]));
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private presentProgram: { program: WebGLProgram; height: WebGLUniformLocation; drawn: WebGLUniformLocation } | null = null;

  /** Copy the frame's colour and depth to the canvas (bottom row first there),
   *  texel for texel, so the canvas shows the exact frame and later overlays
   *  depth test against it. `drawn`: only where the frame drew, opaque (all
   *  rooms: the canvas keeps the view beyond the rooms drawn). */
  private present(t: any, width: number, height: number, drawn = false): void {
    const gl = this.context;
    if (!this.presentProgram) {
      const program = this.gl.linkSources(`#version 300 es
void main() {
  gl_Position = vec4(float((gl_VertexID & 1) * 4) - 1.0, float((gl_VertexID & 2) * 2) - 1.0, 0.0, 1.0);
}`, `#version 300 es
precision highp float;
uniform highp sampler2D u_colour;
uniform highp sampler2D u_depth;
uniform int u_height;
uniform bool u_drawn;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = u_height - 1 - p.y;
  o = texelFetch(u_colour, p, 0);
  float depth = texelFetch(u_depth, p, 0).r;
  if (u_drawn) {
    if (depth >= 1.0) discard;
    o.a = 1.0;
  }
  gl_FragDepth = depth;
}`);
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'u_colour'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'u_depth'), 1);
      this.presentProgram = { program, height: gl.getUniformLocation(program, 'u_height')!, drawn: gl.getUniformLocation(program, 'u_drawn')! };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    this.gl.applyState({ depthTest: true, depthFunc: gl.ALWAYS, depthWrite: true, blend: null, cull: null, colourWrite: true });
    gl.useProgram(this.presentProgram.program);
    gl.uniform1i(this.presentProgram.height, height);
    gl.uniform1i(this.presentProgram.drawn, drawn ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.mainColour.texture); gl.bindSampler(0, null);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t.mainDepth.texture); gl.bindSampler(1, null);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Start the occlusion history afresh, as on the game's first frame: empty
   *  history (validity 0) and frame index 0. */
  resetTemporal(): void {
    this.ssaoFrame = 0;
    this.ssaoPrevious = 1;
    this.lastView = null;
    const t = this.targets;
    if (!t) return;
    const gl = this.context;
    for (const fb of t.aoFb) { gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Read back the finished frame's bytes (rows as the source stores them). */
  readMain(): { width: number; height: number; data: Uint8Array } | null {
    const t = this.targets;
    if (!t) return null;
    const gl = this.context;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.mainFb);
    const data = new Uint8Array(t.mainColour.width * t.mainColour.height * 4);
    gl.readPixels(0, 0, t.mainColour.width, t.mainColour.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width: t.mainColour.width, height: t.mainColour.height, data };
  }

  /** Read back an intermediate target (rows as the source stores them). */
  readTarget(name: 'ao' | 'aoRaw' | 'blur1' | 'linear' | 'main'): { width: number; height: number; data: number[] } | null {
    const t = this.targets;
    if (!t) return null;
    const gl = this.context;
    if (name === 'main') {
      const out = this.readMain()!;
      return { width: out.width, height: out.height, data: Array.from(out.data) };
    }
    if (name === 'linear') {
      // All five levels, level after level.
      const out: number[] = [];
      for (let level = 0; level < 5; level++) {
        const w = Math.max(1, t.wa >> level), h = Math.max(1, t.ha >> level);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.linearFb[level]);
        const data = new Uint32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data);
        for (let k = 0; k < data.length; k += 4) out.push(data[k]);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { width: t.wa, height: t.ha, data: out };
    }
    const fb = name === 'ao' ? t.blur3Fb : name === 'blur1' ? t.blur1Fb : t.aoFb[this.ssaoPrevious];
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const data = new Uint8Array(t.wa * t.ha * 4);
    gl.readPixels(0, 0, t.wa, t.ha, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width: t.wa, height: t.ha, data: Array.from(data) };
  }
}
