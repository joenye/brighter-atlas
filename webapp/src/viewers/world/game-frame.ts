// The game's frame, drawn with its own programs (game-shaders.ts) through
// game-gl.ts, in the order and with the constants the game uses: a shadow
// map from the fixed sun view fitted to the visible part of the scene, the
// half-resolution ambient occlusion chain (depth prepass, linear depth mips,
// spiral estimator with temporal accumulation, two bilateral blurs), then the
// main pass (ground and objects) and the water. Everything is computed in
// the native frame (x east, y south, z up: left handed, native units) with
// the game's camera conventions: view space x right, z up, looking along -y;
// clip depth 0..1 (EXT_clip_control where available, else the translator's
// remap). Every pass draws offscreen in the source's own image orientation,
// single sampled, and the finished frame is copied texel for texel to the
// canvas.
import { THREE } from '../three-common.js';
import { GameShaderLibrary, putFloats, type GameProgram, type GameRenderTables } from './game-shaders.js';
import { GameGL, blendToGL, D3D_COMPARE_GL, type GameGLProgram, type GameTexture, type DrawState } from './game-gl.js';
import { bakeGameGeometry } from './game-geometry.js';
import { drawGroups, type DrawGroup, type EmissionKey } from './draw-order.js';
import { detectChains } from '../../texture-roles.js';
import type { YConvention } from './dxbc-glsl.js';

export interface GameRenderIndex extends GameRenderTables {
  waterPrograms: { surface: number[]; curtain: number[] };
  materials: Record<string, { main: number[][]; depth: number[][]; specular: [number, number, number]; opacity: number }>;
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
}

export interface GameRoomSource {
  roomId: number;
  bounds: { inner: [number, number, number, number]; outer: [number, number, number, number]; layers: number };
  grid: any;                      // shard colour_grid
  batches: GameBatchSource[];
  water: any | null;              // world index water (styles)
  textureMeta: (id: number) => any;
}

export interface GameCamera {
  eye: THREE.Vector3;             // native frame
  target: THREE.Vector3;
  fov: number;                    // vertical degrees
  width: number;
  height: number;
  /** The camera's up (native frame); z when absent. */
  up?: THREE.Vector3;
}

interface Draw {
  /** The program in the source's own image orientation (every pass draws offscreen). */
  program: GameProgram;
  gl: GameGLProgram;
  vao: WebGLVertexArrayObject;
  count: number;
  indexType: number;
  textures: Record<number, GameTexture>;
  depth: null | { program: GameProgram; gl: GameGLProgram; vao: WebGLVertexArrayObject; textures: Record<number, GameTexture> };
  water: GameBatchSource['water'];
}

const f32 = Math.fround;
const pad5 = (n: number) => String(n).padStart(5, '0');

// Rows of a 4x4 (clip = M p) as the constant buffer stores them.
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
  const use = pts.length ? pts : corners;
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
export class GameFrame {
  readonly gl: GameGL;
  readonly shaders: GameShaderLibrary;
  private draws: Draw[] = [];
  private waterDraws: Draw[] = [];
  private textures = new Map<string, Promise<GameTexture | null>>();
  private room: GameRoomSource | null = null;
  private targets: any = null;
  private ssaoFrame = 0;
  private ssaoPrevious = 0;
  private lastView: THREE.Matrix4 | null = null;
  private fullscreen: WebGLVertexArrayObject | null = null;

  // Clip depth 0..w as the source draws it, where available: the default
  // GL range needs a remap that rounds depth differently.
  private readonly clipControl: ClipControl | null;

  constructor(private readonly context: WebGL2RenderingContext, private readonly url: (rel: string) => string,
    readonly index: GameRenderIndex, private readonly tileUnits: number) {
    this.gl = new GameGL(context);
    this.clipControl = context.getExtension('EXT_clip_control') as ClipControl | null;
    this.shaders = new GameShaderLibrary(url, index, !!this.clipControl);
  }

  /** The main-pass program of a material for the default settings. */
  mainProgram(material: number): number | null {
    const m = this.index.materials[String(material)];
    const row = m?.main.find((k) => k[0] === 0 && k[1] === 0 && k[2] === 1 && k[3] === 1 && k[4] === 1);
    return row ? row[5] : null;
  }

  depthProgram(material: number): number | null {
    const m = this.index.materials[String(material)];
    const row = m?.depth.find((k) => k[0] === 0 && k[1] === 0);
    return row ? row[2] : null;
  }

  private passPrograms = new Map<number, GameProgram>();
  /** Test switch: draw the frame without its water. */
  skipWater = false;
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

  private roomBuffers: WebGLBuffer[] = [];

  async setRoom(room: GameRoomSource): Promise<void> {
    const p = this.index.ssao.programs;
    for (const index of [...p.mips, p.sao, p.blurH, p.blurV]) {
      if (!this.passPrograms.has(index)) this.passPrograms.set(index, await this.shaders.program(index, 'clip'));
    }
    this.releaseRoom();
    this.room = room;
    this.gl.collect = this.roomBuffers;
    try {
      await this.buildDraws(room);
    } finally {
      this.gl.collect = null;
    }
  }

  /** Free the current scene's vertex arrays and buffers (programs and
   *  textures stay cached for the next scene). */
  releaseRoom(): void {
    const gl = this.context;
    for (const d of [...this.draws, ...this.waterDraws]) {
      gl.deleteVertexArray(d.vao);
      if (d.depth) gl.deleteVertexArray(d.depth.vao);
    }
    for (const b of this.roomBuffers) gl.deleteBuffer(b);
    this.roomBuffers = [];
    this.draws = [];
    this.waterDraws = [];
  }

  /** Free the cached textures too (the frame stays usable). */
  releaseTextures(): void {
    const textures = [...this.textures.values()];
    this.textures.clear();
    for (const p of textures) p.then((t) => { if (t) this.context.deleteTexture(t.texture); }).catch(() => {});
  }

  private async buildDraws(room: GameRoomSource): Promise<void> {
    for (const group of drawGroups(room.batches)) {
      const draw = await this.buildDraw(group).catch((error) => {
        console.warn('game shading: group skipped', group.batch.material, group.batch.renderTexture, error);
        return null;
      });
      if (!draw) continue;
      (group.batch.water ? this.waterDraws : this.draws).push(draw);
    }
  }

  private async buildDraw(group: DrawGroup<GameBatchSource>): Promise<Draw | null> {
    const batch = group.batch;
    const instances = group.parts.map(({ batch: b, index: k }) => ({
      payload: b.payload, matrix: b.matrices[k], tint: b.tints[k], recolours: b.recolours?.[k] ?? null,
    }));
    let programIndex: number | null;
    if (batch.water) {
      // key (skinned, 32-bit, vignette) = (false, false, true)
      programIndex = this.index.waterPrograms[batch.water.kind][0];
    } else programIndex = this.mainProgram(batch.material);
    if (programIndex === null) return null;
    const program = await this.shaders.program(programIndex, 'clip');
    const material = this.index.materials[String(batch.material)];
    const style = batch.water?.kind === 'surface' ? this.room!.water.styles[batch.water.style] : null;
    const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const byte = (v: number) => Math.min(255, Math.max(0, Math.floor(f32(f32(v) * 255))));
    const geometry = bakeGameGeometry({
      instances, elements: program.elements, attributes: program.translated.attributes,
      specular: material?.specular ?? [0, 0, 0],
      opacity: batch.water ? batch.water.opacity : (material?.opacity ?? 1),
      grid: null, tileUnits: this.tileUnits,
      style: style ? [byte(srgbToLinear(style.colour[0])), byte(srgbToLinear(style.colour[1])), byte(srgbToLinear(style.colour[2])), byte(style.colour[3])] : undefined,
      window: batch.water?.kind === 'curtain' ? [Math.round(batch.water.window[0] * 65535), Math.round(batch.water.window[1] * 65535)] : undefined,
    });
    const glProgram = this.gl.compile(program.translated);
    const vao = this.vertexArray(glProgram, geometry);
    const index = geometry.getIndex()!;
    const textures = await this.bindTexturesFor(program, batch);
    let depth: Draw['depth'] = null;
    if (!batch.water) {
      const depthIndex = this.depthProgram(batch.material);
      if (depthIndex !== null) {
        const depthProgram = await this.shaders.program(depthIndex, 'clip');
        const depthGeometry = bakeGameGeometry({
          instances, elements: depthProgram.elements, attributes: depthProgram.translated.attributes,
          specular: material?.specular ?? [0, 0, 0], opacity: material?.opacity ?? 1,
          grid: null, tileUnits: this.tileUnits,
        });
        const depthGl = this.gl.compile(depthProgram.translated);
        // cutout depth programs discard by the parameter plane: bind it too
        depth = { program: depthProgram, gl: depthGl, vao: this.vertexArray(depthGl, depthGeometry),
          textures: await this.bindTexturesFor(depthProgram, batch) };
      }
    }
    return {
      program, gl: glProgram, vao, count: index.count,
      indexType: index.array instanceof Uint32Array ? this.context.UNSIGNED_INT : this.context.UNSIGNED_SHORT,
      textures, depth, water: batch.water,
    };
  }

  private vertexArray(p: GameGLProgram, geometry: THREE.BufferGeometry): WebGLVertexArrayObject {
    const gl = this.context;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    for (const a of p.translated.attributes) {
      const location = p.attributes.get(a.name);
      const attribute = geometry.getAttribute(a.name) as THREE.BufferAttribute | undefined;
      if (location === undefined || location < 0 || !attribute) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gl.buffer(attribute.array as ArrayBufferView));
      gl.enableVertexAttribArray(location);
      const array = attribute.array;
      const type = array instanceof Float32Array ? gl.FLOAT : array instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE;
      if (a.componentType === 'float') gl.vertexAttribPointer(location, attribute.itemSize, type, attribute.normalized, 0, 0);
      else gl.vertexAttribIPointer(location, attribute.itemSize, type, 0, 0);
    }
    this.gl.buffer(geometry.getIndex()!.array as ArrayBufferView, true);
    gl.bindVertexArray(null);
    return vao;
  }

  // ---- textures -------------------------------------------------------------

  private async blocks(image: number, sub: number): Promise<{ fmt: number; width: number; height: number; data: Uint8Array }> {
    const r = await fetch(this.url(`images/${pad5(image)}_e${sub}.bc`));
    if (!r.ok) throw new Error(`image ${image} sub ${sub}: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const dv = new DataView(bytes.buffer);
    return { fmt: dv.getUint16(0, true), width: dv.getUint16(2, true), height: dv.getUint16(4, true), data: bytes.subarray(8) };
  }

  /** A plane (its mip chain, largest first) of a texture container. */
  texturePlane(image: number, subs: number[], srgb: boolean): Promise<GameTexture | null> {
    const key = `${image}:${subs.join(',')}:${srgb}`;
    let p = this.textures.get(key);
    if (!p) {
      p = (async () => {
        const levels = await Promise.all(subs.map((s) => this.blocks(image, s)));
        levels.sort((a, b) => b.width - a.width);
        if (!this.gl.supports(levels[0].fmt)) return null;
        return this.gl.uploadTexture('texture', levels.map((l) => [l]), levels[0].fmt, srgb);
      })();
      this.textures.set(key, p);
    }
    return p;
  }

  cube(image: number, count: number): Promise<GameTexture | null> {
    const key = `cube:${image}`;
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
    // Older metadata without formats: walk the neighbours of `top`.
    const out = [top];
    // the chain is stored either smallest or largest first around its top
    for (const step of [-1, 1]) {
      let k = top, w = subs[top]?.[0] ?? 0, h = subs[top]?.[1] ?? 0;
      while (subs[k + step] && subs[k + step][0] * 2 === w && subs[k + step][1] * 2 === h) {
        k += step; [w, h] = subs[k]; out.push(k);
      }
    }
    return out;
  }

  private async bindTexturesFor(program: GameProgram, batch: GameBatchSource): Promise<Record<number, GameTexture>> {
    const out: Record<number, GameTexture> = {};
    const names = new Map(program.translated.samplers.map((s) => [s.texture, s.textureName]));
    for (const [slot, name] of names) {
      let texture: GameTexture | null = null;
      if (batch.water && this.room?.water) {
        const style = this.room.water.styles[batch.water.style];
        if (name === 'v_texture_normal') texture = await this.texturePlane(style.normal, [0, 1, 2], false);
        else if (name === 'v_texture_cubemap') texture = await this.cube(style.cube, 18);
        else if (name === 'v_texture_albedo_plane' && batch.renderTexture >= 0) {
          const meta = this.room.textureMeta(batch.renderTexture);
          if (meta?.albedo != null) texture = await this.texturePlane(batch.renderTexture, this.planeSubs(meta, meta.albedo), true);
        }
      } else if (batch.renderTexture >= 0) {
        const meta = this.room!.textureMeta(batch.renderTexture);
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

  private state(program: GameProgram, override: Partial<DrawState> = {}): DrawState {
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
    const clip = this.clipControl;
    if (clip) clip.clipControlEXT(clip.LOWER_LEFT_EXT, clip.ZERO_TO_ONE_EXT);
    try {
      this.renderFrame(camera, ticks, avatarZ, offscreen);
    } finally {
      if (clip) clip.clipControlEXT(clip.LOWER_LEFT_EXT, clip.NEGATIVE_ONE_TO_ONE_EXT);
      this.gl.releaseSamplers();
    }
  }

  private renderFrame(camera: GameCamera, ticks: number, avatarZ: number, offscreen: boolean): void {
    if (!this.room || !this.passPrograms.size) return;
    const gl = this.context;
    const idx = this.index;
    const { near, far } = idx.camera;
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
    const env = this.environmentOverride ?? idx.environments[String(this.room.roomId)] ?? null;

    // Shadow receiver fit over the scene box.
    const { inner, outer, layers } = this.room.bounds;
    const margin = idx.shadow.marginTiles;
    const box = [
      Math.min(Math.max(inner[0] - margin, inner[0]), outer[0]) * this.tileUnits,
      Math.min(Math.max(inner[1] - margin, inner[1]), outer[1]) * this.tileUnits, 0,
      Math.max(Math.min(inner[2] + margin, inner[2]), outer[2]) * this.tileUnits,
      Math.max(Math.min(inner[3] + margin, inner[3]), outer[3]) * this.tileUnits, idx.shadow.layerHeight * layers];
    const shadow = shadowFit(view, camera.fov, aspect, near, far, box, idx.shadow.lightView, idx.shadow.size);
    const size = idx.shadow.size;
    const L = lightViewMatrix(idx.shadow.lightView);
    const pixelToClip = new THREE.Matrix4().set(2 / size, 0, 0, -1, 0, -2 / size, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1);
    const casterClip = pixelToClip.clone().multiply(shadow.fit).multiply(L);

    // Vignette and height fade.
    const height = env?.height === 'avatar' ? avatarZ + idx.vignette.avatarOffset : (env?.height ?? 0);
    const [z0, w0, z1, w1] = idx.vignette.avatarFloor;
    const floorValue = env?.floor === 'avatar'
      ? (avatarZ <= z0 ? w0 : avatarZ >= z1 ? w1 : w0 + (w1 - w0) * (avatarZ - z0) / (z1 - z0))
      : (env?.floor ?? 1);
    const rect = [0, 0, this.room.bounds.inner[2] * this.tileUnits, this.room.bounds.inner[3] * this.tileUnits];
    const hx = (rect[2] - rect[0]) / 2, hy = (rect[3] - rect[1]) / 2;
    const vignetteColour = env?.vignette ?? [0, 0, 0, 1];
    const k = idx.vignette.radius / Math.max(hx, hy) + 1;
    // The main pass fades to the vignette colour away from the room and
    // darkens low ground; depth passes and the water (drawn by the overlay
    // renderer, which gets the neutral vignette in the player's own room) do not.
    const vsWords = (wvp: THREE.Matrix4, receiver: THREE.Matrix4 | null, offset: number, neutral = false) => {
      const words = new Uint32Array(72);
      putFloats(words, 0, rows(wvp));
      putFloats(words, 64, rows(wvp));
      putFloats(words, 128, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
      if (receiver) putFloats(words, 176, rows(receiver));
      if (neutral) {
        putFloats(words, 240, [0, 0, 0, 0, 0, 0, 0, 10000, offset, 0, 0, 1]);
      } else {
        putFloats(words, 240, [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2, 1 / hx, 1 / hy]);
        putFloats(words, 256, [vignetteColour[0] * idx.lighting.fade, vignetteColour[1] * idx.lighting.fade, vignetteColour[2] * idx.lighting.fade, k]);
        putFloats(words, 272, [offset, 0, height, floorValue]);
      }
      return words;
    };

    // ---- shadow pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.shadowFb);
    gl.viewport(0, 0, size, size);
    gl.depthMask(true); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    const casterWords = vsWords(casterClip, null, 0, true);
    for (const d of card ? [] : this.draws) {
      if (!d.depth) continue;
      this.gl.applyState(this.state(d.depth.program, { colourWrite: false }));
      this.gl.bindResources(d.depth.gl, { [d.depth.program.translated.constantBuffers.vs[0]?.uniform ?? 'cb0_vs']: casterWords },
        this.bound(d.depth.program, d.depth.textures), 'ps', size);
      gl.bindVertexArray(d.depth.vao);
      gl.drawElements(gl.TRIANGLES, d.count, d.indexType, 0);
    }

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
    const prepassWords = vsWords(prepassClip, null, 0, true);
    for (const d of card ? [] : this.draws) {
      if (!d.depth) continue;
      this.gl.applyState(this.state(d.depth.program, { colourWrite: false }));
      this.gl.bindResources(d.depth.gl, { [d.depth.program.translated.constantBuffers.vs[0]?.uniform ?? 'cb0_vs']: prepassWords },
        this.bound(d.depth.program, d.depth.textures), 'ps', t.ha);
      gl.bindVertexArray(d.depth.vao);
      gl.drawElements(gl.TRIANGLES, d.count, d.indexType, 0);
    }
    const n5 = f32(near / ssao.unit), f5 = f32(far / ssao.unit);
    const hp2 = (v: number) => { let b = 1; while (b * 2 <= v) b *= 2; return b; };
    const S = f32(2 * hp2(Math.trunc(0x7fffffff / Math.trunc(f5))));
    const linearParams = [f32(n5 * f5), f32(n5 - f5), f5, S];
    const fullscreen = (programIndex: number, fb: WebGLFramebuffer, w: number, h: number,
      cbs: (p: GameProgram) => Record<string, Uint32Array>, textures: Record<number, GameTexture>) => {
      const program = this.passPrograms.get(programIndex)!;
      const glProgram = this.compiled(program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, w, h);
      this.gl.applyState({ depthTest: false, depthFunc: gl.LESS, depthWrite: false, blend: null, cull: null, colourWrite: true });
      const bound: Record<number, { texture: GameTexture; sampler: WebGLSampler | null }> = {};
      for (const s of program.translated.samplers) {
        if (!textures[s.texture]) continue;
        bound[s.texture] = { texture: textures[s.texture], sampler: s.sampler === null ? null : this.gl.sampler(program.samplers[s.sampler] ?? null) };
      }
      this.gl.bindResources(glProgram, cbs(program), bound, 'ps', h);
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
    this.ssaoFrame = (this.ssaoFrame + 1) % 4;
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
    }
    this.lastView = view.clone();
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
    const light = (c: number[] | undefined, fallback: number[]) => {
      const v = c ?? fallback;
      return [0, 1, 2].map((k) => f32(f32(Math.pow(v[k], idx.lighting.gamma)) * v[3] * idx.lighting.fade));
    };
    const d0 = card?.direction ?? idx.lighting.direction;
    const dir = new THREE.Vector3(d0[0], d0[1], d0[2]).normalize();
    const psLight = [
      camera.eye.x, camera.eye.y, camera.eye.z, 0,
      ...light(env?.ground, [0.4314, 0.2863, 0.1529, 1]), 1,
      ...light(env?.sky, [0.8157, 0.8784, 0.9412, 1]), 1,
      ...light(env?.sun, [1, 0.8784, 0.5647, 1.5]), 1,
      dir.x, dir.y, dir.z, 0,
      ...ssaoOffsetScale,
      idx.lighting.fade, 0, 0, 0,
    ];
    const mainWords = vsWords(viewProjection, shadow.receiver, shadow.offset, !!card);
    this.lastConstants = { caster: casterWords, prepass: prepassWords, main: mainWords };
    const waterVsWords = vsWords(viewProjection, shadow.receiver, shadow.offset, true);
    const shadowSampler = this.gl.sampler([0x95, 3, 3, 3, 4, 0, 15, 0, 1]);
    const drawMain = (d: Draw, waterWords: Uint32Array | null) => {
      this.gl.applyState(this.state(d.program));
      const cbs: Record<string, Uint32Array> = {};
      for (const b of d.program.translated.constantBuffers.vs) {
        cbs[b.uniform] = b.slot === 0 ? (waterWords ? waterVsWords : mainWords) : (waterWords ?? new Uint32Array(b.sizeVec4 * 4));
      }
      for (const b of d.program.translated.constantBuffers.ps) {
        const words = new Uint32Array(b.sizeVec4 * 4); putFloats(words, 0, psLight); cbs[b.uniform] = words;
      }
      const textures: Record<number, { texture: GameTexture; sampler: WebGLSampler | null }> = {};
      d.program.translated.samplers.forEach((s) => {
        const desc = d.program.samplers[s.sampler ?? -1] ?? null;
        if (s.textureName === 'v_texture_shadow_map') textures[s.texture] = { texture: t.shadowDepth, sampler: shadowSampler };
        else if (s.textureName === 'v_texture_ssao') textures[s.texture] = { texture: t.blur3, sampler: this.gl.sampler(desc) };
        else if (d.textures[s.texture]) textures[s.texture] = { texture: d.textures[s.texture], sampler: this.gl.sampler(desc) };
      });
      this.gl.bindResources(d.gl, cbs, textures, 'ps', camera.height);
      gl.bindVertexArray(d.vao);
      gl.drawElements(gl.TRIANGLES, d.count, d.indexType, 0);
    };
    for (const d of this.draws) drawMain(d, null);
    const water = this.room.water;
    for (const d of this.skipWater ? [] : this.waterDraws) {
      const style = water.styles[d.water!.style];
      const [l0, l1] = style.layers;
      const words = new Uint32Array(d.water!.kind === 'surface' ? 20 : 12);
      const sine = [
        style.waves.amplitude[0], style.waves.frequency[0], f32(style.waves.rate[0] * ticks), style.waves.tilt[0],
        style.waves.amplitude[1], style.waves.frequency[1], f32(style.waves.rate[1] * ticks), style.waves.tilt[1],
        water.level, style.level, 0, 0,
      ];
      if (d.water!.kind === 'surface') {
        putFloats(words, 0, [l0[0], l0[1], f32(l0[2] * ticks), f32(l0[3] * ticks), l1[0], l1[1], f32(l1[2] * ticks), f32(l1[3] * ticks), ...sine]);
      } else putFloats(words, 0, sine);
      drawMain(d, words);
    }
    gl.bindVertexArray(null);
    if (!offscreen) this.present(t, camera.width, camera.height);
  }

  private presentProgram: { program: WebGLProgram; height: WebGLUniformLocation } | null = null;

  /** Copy the frame's colour and depth to the canvas (bottom row first there),
   *  texel for texel, so the canvas shows the exact frame and later overlays
   *  depth test against it. */
  private present(t: any, width: number, height: number): void {
    const gl = this.context;
    if (!this.presentProgram) {
      const shader = (type: number, source: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`present shader: ${gl.getShaderInfoLog(s)}`);
        return s;
      };
      const program = gl.createProgram()!;
      gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
void main() {
  gl_Position = vec4(float((gl_VertexID & 1) * 4) - 1.0, float((gl_VertexID & 2) * 2) - 1.0, 0.0, 1.0);
}`));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform highp sampler2D u_colour;
uniform highp sampler2D u_depth;
uniform int u_height;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = u_height - 1 - p.y;
  o = texelFetch(u_colour, p, 0);
  gl_FragDepth = texelFetch(u_depth, p, 0).r;
}`));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`present program: ${gl.getProgramInfoLog(program)}`);
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, 'u_colour'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'u_depth'), 1);
      this.presentProgram = { program, height: gl.getUniformLocation(program, 'u_height')! };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    this.gl.applyState({ depthTest: true, depthFunc: gl.ALWAYS, depthWrite: true, blend: null, cull: null, colourWrite: true });
    gl.useProgram(this.presentProgram.program);
    gl.uniform1i(this.presentProgram.height, height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.mainColour.texture); gl.bindSampler(0, null);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t.mainDepth.texture); gl.bindSampler(1, null);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Start the occlusion history afresh, as on the client's first frame: empty
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

  /** Read back an intermediate target (rows as the source stores them). */
  readTarget(name: 'ao' | 'aoRaw' | 'blur1' | 'shadow' | 'linear' | 'main'): { width: number; height: number; data: number[] } | null {
    const t = this.targets;
    if (!t) return null;
    const gl = this.context;
    if (name === 'shadow') return null;
    if (name === 'main') {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.mainFb);
      const data = new Uint8Array(t.mainColour.width * t.mainColour.height * 4);
      gl.readPixels(0, 0, t.mainColour.width, t.mainColour.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { width: t.mainColour.width, height: t.mainColour.height, data: Array.from(data) };
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

  private compiledPrograms = new Map<GameProgram, GameGLProgram>();
  private compiled(program: GameProgram): GameGLProgram {
    let p = this.compiledPrograms.get(program);
    if (!p) { p = this.gl.compile(program.translated); this.compiledPrograms.set(program, p); }
    return p;
  }

  dispose(): void {
    this.draws = [];
    this.waterDraws = [];
  }
}

export type { YConvention };
