// A place of the game drawn the way the game draws it, behind (and around) the character: the app's
// GameFrame runs the game's own programs (shadows, ambient occlusion, lighting, water, the floor) on the
// Preview's WebGL2 context, the room's ambient particles (the waves among them) draw over it as three
// overlays against the frame's depth, and the character is the frame's one actor, posed each frame from
// the Preview's rig.
//
// Everything here is in the room's native frame (x east, y south, z up, game units). The Preview places
// the room in its rig frame with `roomFromRig` (the inverse of its room group's matrix).
import {at} from './data.js';
import * as THREE from '../../vendor/three.module.js';
import {WorldScene} from '../viewers/world/scene.js';
import {GameFrame, type GameActorSource, type GameRoomSource} from '../viewers/world/game-frame.js';
import {WorldEffectsLayer} from '../viewers/world/effects-layer.js';
import {drawGroups} from '../viewers/world/draw-order.js';
import {Rig, ClipSampler} from '../viewers/rig.js';
import {buildMeshGeometry} from '../viewers/mesh-geometry.js';
import type {DrawPart} from './compose.js';

const json = new Map<string, Promise<any>>();
const getJson = (url: string) => {
  let p = json.get(url);
  if (!p) { p = fetch(url).then(r => { if (!r.ok) throw Error(`${url}: ${r.status}`); return r.json(); }); p.catch(() => json.delete(url)); json.set(url, p); }
  return p;
};
const pad5 = (n: number) => String(n).padStart(5, '0');
const gf = (rel: string) => at(`gf/${rel}`);
// A place's own data (its scene, cut index and shard, particles, props) changes as the scene is worked on;
// this names the current shape of it, so a browser holding an older copy asks again
const DATA = '?v=4';
// the character stands much nearer the camera than the game's own view ever puts anything
const NEAR = 64;
const VIGNETTE_REACH = 400 * 1024;
// the far plane, out past the ship to the sea's horizon (the game's own is 100 tiles)
const FAR = 360 * 1024;

/** The sea to the horizon: one deep tile at the room's edge (its surface, the bed under it) laid all
 *  around the room, in rings of squares that double in size outward (1, 2, 4 ... 32 tiles), out past the far
 *  plane. A square is the tile stretched (a mesh's texture coordinates are 16-bit, 0 to 1: they cannot
 *  repeat), so its ripples grow with it; doubling with the distance keeps them the same size on screen, and
 *  squares keep them round (long stretched strips drew the far sea's ripples as white streaks). Each ring's
 *  box is a multiple of the next ring's square, so the rings meet without gaps. A bed stretched under all
 *  of it, a little lower, closes any hairline crack. The room becomes an island. */
const SEA_RINGS: [number, [number, number]][] = [[1, [-8, 32]], [2, [-24, 48]], [4, [-56, 80]], [8, [-128, 160]], [16, [-256, 288]], [32, [-384, 416]]];
function extendSea(source: GameRoomSource, [w, h]: number[], T: number): GameRoomSource {
  const tileOf = (m: THREE.Matrix4) => [Math.floor(m.elements[12] / T), Math.floor(m.elements[13] / T)];
  const wet = new Set<string>();
  for (const b of source.batches) if (b.water?.kind === 'surface') for (const m of b.matrices) wet.add(tileOf(m).join(','));
  // the template: a wet corner, else any wet edge tile
  const edge = [[w - 1, h - 1], [0, h - 1], [w - 1, 0], [0, 0]];
  for (let x = 0; x < w; x++) edge.push([x, h - 1], [x, 0]);
  for (let y = 0; y < h; y++) edge.push([w - 1, y], [0, y]);
  const tile = edge.find(([x, y]) => wet.has(`${x},${y}`));
  if (!tile) return source;
  const [tx, ty] = tile;
  // the pieces to lay: [x, y, width, height] in tiles
  const pieces: [number, number, number, number][] = [];
  let inner: [number, number, number, number] = [0, 0, w, h];
  for (const [k, [lo, hi]] of SEA_RINGS) {
    for (let x = lo; x < hi; x += k) for (let y = lo; y < hi; y += k)
      if (!(x + k > inner[0] && x < inner[2] && y + k > inner[1] && y < inner[3])) pieces.push([x, y, k, k]);
    inner = [lo, lo, hi, hi];
  }
  const [f0, f1] = SEA_RINGS[SEA_RINGS.length - 1][1];
  const toOrigin = new THREE.Matrix4().makeTranslation(-(tx + 0.5) * T, -(ty + 0.5) * T, 0);
  const lay = (x: number, y: number, sx: number, sy: number, z = 0) => new THREE.Matrix4().makeTranslation((x + sx / 2) * T, (y + sy / 2) * T, z)
    .multiply(new THREE.Matrix4().makeScale(sx, sy, 1)).multiply(toOrigin);
  const lays = pieces.map(([x, y, sx, sy]) => lay(x, y, sx, sy));
  const under = lay(f0, f0, f1 - f0, f1 - f0, -48);
  const batches = source.batches.map(b => {
    if (b.category !== 'terrain' || b.water?.kind === 'curtain') return b;   // (a shoreline's curtain stays at the shore)
    const add = {matrices: [] as THREE.Matrix4[], tints: [] as any[], recolours: [] as any[], order: [] as any[]};
    b.matrices.forEach((m, i) => {
      const [x, y] = tileOf(m);
      if (x !== tx || y !== ty) return;
      for (const l of b.water ? lays : [...lays, under]) {
        add.matrices.push(l.clone().multiply(m));
        add.tints.push(b.tints[i]); add.recolours.push(b.recolours?.[i] ?? null); add.order.push(b.order?.[i]);
      }
    });
    if (!add.matrices.length) return b;
    return {...b, matrices: [...b.matrices, ...add.matrices], tints: [...b.tints, ...add.tints],
      recolours: b.recolours ? [...b.recolours, ...add.recolours] : undefined, order: b.order ? [...b.order, ...add.order] : undefined};
  });
  return {...source, batches};
}

/** Thrown out of a load its caller has given up on (another place picked meanwhile). */
export class LoadCancelled extends Error { name = 'LoadCancelled'; }
export interface LoadOptions {
  /** How far the load has come, 0 to 1: the data (5%), the meshes (to 40%), the frame's draws (to 95%), the
   *  particles and crab (97%; the caller's actors finish it). */
  progress?: (f: number) => void;
  /** True once the load is no longer wanted: it stops at its next step. */
  cancelled?: () => boolean;
}

export class GameRoom {
  /** The room's particles, in the room's native frame: the Preview hangs it under its room group. */
  readonly fxRoot = new THREE.Group();
  private frame: GameFrame;
  private effects: WorldEffectsLayer | null = null;
  private actorBuffers: WebGLBuffer[] = [];
  private actorGen = 0;
  private palette = new Float32Array(0);
  private paletteLive = false;
  private skin = new THREE.Matrix4();
  readonly near: number;
  readonly far: number;

  private constructor(readonly id: number, private gl: WebGL2RenderingContext, private world: WorldScene, render: any, private source: GameRoomSource) {
    // The game's textures are block compressed (S3TC, RGTC), which iPhones' WebGL does not take: there the
    // site sends them decoded (.rgba in place of .bc), the signed normal maps as signed bytes.
    const blocks = !/[?&]nobc\b/.test(location.search) && !!gl.getExtension('WEBGL_compressed_texture_s3tc') && !!gl.getExtension('EXT_texture_compression_rgtc');
    this.frame = new GameFrame(gl, blocks ? gf : (rel: string) => gf(rel.replace(/\.bc$/, '.rgba')), render, world.tileUnits);
    if (!blocks) acceptSignedRG((this.frame as any).gl, gl);
    this.near = render.camera.near; this.far = render.camera.far;
  }

  static async load(gl: WebGL2RenderingContext, id: number, opts: LoadOptions = {}): Promise<GameRoom> {
    const check = () => { if (opts.cancelled?.()) throw new LoadCancelled(); };
    let shown = 0;
    const step = (f: number) => { check(); if (f > shown) { shown = f; opts.progress?.(f); } };
    const store = {
      worldIndex: () => getJson(gf(`index/${id}.json${DATA}`)),
      worldRoom: (r: number) => getJson(gf(`rooms/${r}.json${DATA}`)),
      payload: (rel: string) => getJson(gf(rel)),
      url: gf,
      worldIdlePoses: async () => null,
    };
    const world = new WorldScene({scene: new THREE.Group() as any, store: store as any});
    const index = await world.init();
    const [shard, scene] = await Promise.all([getJson(gf(`rooms/${id}.json${DATA}`)), getJson(gf(`scene/${id}.json${DATA}`)).catch(() => ({}))]);
    const props = await Promise.all((scene.props ?? []).map((pr: any) => getJson(gf(`props/${id}/${pr.name}.json${DATA}`)).catch(() => null)));
    step(0.05);
    // every mesh the place draws, fetched ahead (the scene's builders then find them cached): the first
    // stretch of the progress
    const mc = (index.columns.placement as string[]).indexOf('mesh'), meshes = new Set<number>();
    for (const sh of [shard, ...props]) for (const rows of Object.values(sh?.placements ?? {}) as any[][]) for (const r of rows) if (r[mc] >= 0) meshes.add(r[mc]);
    for (const p of [scene.crab, ...(scene.bather?.parts ?? []), ...(scene.birds?.parts ?? [])]) if (p) meshes.add(p.mesh);
    const list = [...meshes];
    let got = 0;
    const next = async (): Promise<void> => {
      for (let m = list.pop(); m !== undefined; m = list.pop()) {
        check();
        await getJson(gf(`meshes/${pad5(m)}.json`)).catch(() => null);
        step(0.05 + 0.35 * ++got / meshes.size);
      }
    };
    await Promise.all(Array.from({length: 6}, next));
    const room = {id, meta: world.roomMeta(id), shard, worldRoom: null, origin: {x: 0, y: 0}, group: new THREE.Group()} as any;
    const source = extendSea(await world.gameRoomSource(room, []), shard.size ?? [0, 0], world.tileUnits);
    // (the game's floor around the room is a plain of soil: the sea and the sky take its place)
    source.plane = [];
    // (the game's view never reaches past the room, so its vignette fades everything beyond it to dark: this
    // view looks out to sea, so the fade starts far out instead)
    const render = {...index.render, camera: {...index.render.camera, near: NEAR, far: FAR}, vignette: {...index.render.vignette, radius: VIGNETTE_REACH}};
    const g = new GameRoom(id, gl, world, render, source);
    g.view = scene.view ?? null;
    // the place's own scene: a ship out at sea, shells by the character's feet, a crab about the sand
    await g.addProps(scene.props ?? []);
    g.addShells(scene.shells ?? []);
    // the frame's draws (their programs and textures fetched as each is built): the second stretch
    const f = g.frame as any, build = f.buildDraw.bind(f), groups = drawGroups(source.batches).length;
    let built = 0;
    // (the frame skips a draw whose build throws, so a load given up on skips the rest quietly instead)
    f.buildDraw = async (group: any) => {
      if (opts.cancelled?.()) return null;
      const d = await build(group);
      if (!opts.cancelled?.()) step(0.4 + 0.55 * Math.min(1, ++built / groups));
      return d;
    };
    try { await g.frame.setRoom(source); } catch (e) { g.dispose(); throw e; } finally { f.buildDraw = build; }
    if (opts.cancelled?.()) { g.dispose(); throw new LoadCancelled(); }
    if (scene.crab) await g.addCrab(scene.crab).catch(e => console.warn('crab', e));
    if (scene.bather) await g.addBather(scene.bather).catch(e => console.warn('bather', e));
    if (scene.birds) await g.addBirds(scene.birds).catch(e => console.warn('birds', e));
    // the room's ambient particles (the waves on the shore among them)
    const doc = await getJson(gf(`effects/${id}.json${DATA}`)).catch(() => null);
    if (doc?.systems?.length) {
      g.fxRoot.matrixAutoUpdate = false;
      g.effects = new WorldEffectsLayer({root: g.fxRoot, doc, url: at, textures: index.textures ?? {},
        tileUnits: world.tileUnits, layerUnits: world.layerUnits, meshForwardQuarterTurns: world.meshForwardQuarterTurns} as any);
      g.effects.addRoom(id, [0, 0]);
      // (the layer marks each instance with a pick target for the world viewer's inspector: not here)
      for (const {object} of g.effects.pickables()) object.visible = false;
    }
    opts.progress?.(0.97);   // (the rest: the caller dressing the character)
    return g;
  }

  /** A height probe over the ground about (x, y) out to `reach` (native units): the highest solid surface
   *  at a point (not water), cast from above; -Infinity where there is none. */
  groundProbe(x: number, y: number, reach: number, terrainOnly = false): (px: number, py: number) => number {
    const near = reach + 2 * this.world.tileUnits;
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({side: THREE.DoubleSide});
    for (const b of this.source.batches) {
      if (b.water || !b.payload || (terrainOnly && b.category !== 'terrain')) continue;
      const at = b.matrices.filter(m => Math.hypot(m.elements[12] - x, m.elements[13] - y) < near);
      if (!at.length) continue;
      const {geo} = buildMeshGeometry(b.payload, {boneColors: false});
      for (const m of at) {
        const mesh = new THREE.Mesh(geo, material);
        mesh.matrixAutoUpdate = false; mesh.matrix.copy(m); mesh.matrixWorld.copy(m);
        group.add(mesh);
      }
    }
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, 0, -1), from = new THREE.Vector3();
    return (px, py) => {
      ray.set(from.set(px, py, 1e5), down);
      const hit = ray.intersectObjects(group.children, false)[0];
      return hit ? hit.point.z : -Infinity;
    };
  }
  /** Where a figure stands at (x, y): the commonest ground height about it (a point on a seam between
   *  bevelled tiles, or on a shell, is not where the feet go). */
  standAt(x: number, y: number): number {
    const ground = this.groundProbe(x, y, 512), n = new Map<number, number>();
    for (let u = -384; u <= 384; u += 64) for (let v = -384; v <= 384; v += 64) {
      const z = ground(x + u, y + v);
      if (Number.isFinite(z)) n.set(Math.round(z / 4) * 4, (n.get(Math.round(z / 4) * 4) ?? 0) + 1);
    }
    return n.size ? [...n].sort((a, b) => b[1] - a[1])[0][0] : 0;
  }
  /** The scene's view (from the place's scene data), when it names one: the character's spot (tiles) and turn. */
  view: {spot: [number, number], face: number} | null = null;
  private crabSpec: any = null;
  /** The character stands at `place` (native units, turned by `face`): the crab settles in view, in front and
   *  to the right, facing the camera. */
  aim(place: {sx: number, sy: number, face: number}) {
    if (!Array.isArray(this.crabSpec?.place)) return;
    const T = this.world.tileUnits;
    const [cx, cy] = viewPoint({spot: [place.sx / T, place.sy / T], face: place.face}, this.crabSpec.place).map(c => c * T);
    this.crab?.settle(sandAround(this.groundProbe(cx, cy, this.crabSpec.radius * T), cx, cy, this.crabSpec.radius * T));
  }

  /** The level of the water surfaces among `batches` (their most common height), or null. */
  private static waterLevel(batches: GameRoomSource['batches']): number | null {
    const n = new Map<number, number>();
    for (const b of batches) if (b.water?.kind === 'surface') for (const m of b.matrices) {
      const z = Math.round(m.elements[14] + (b.payload?.bbox?.[2] ?? 0));
      n.set(z, (n.get(z) ?? 0) + 1);
    }
    return n.size ? [...n].sort((a, b) => b[1] - a[1])[0][0] : null;
  }

  /** Pieces of other rooms (a ship, a bathtub), centred at `at` (tiles) and turned by `turn` about their middle:
   *  their solid parts floated at this room's water level (their own water left behind), or, given `float`, all
   *  of them (a tub's bathwater too) with their lowest point `float` units below it. Their placements are kept
   *  (`place`, the prop's room to this one) for what rides in them. */
  private async addProps(props: {name: string, room: number, at: [number, number], turn: number, float?: number}[]) {
    const T = this.world.tileUnits, level = GameRoom.waterLevel(this.source.batches);
    for (const pr of props) {
      const shard = await getJson(gf(`props/${this.id}/${pr.name}.json${DATA}`)).catch(() => null);
      if (!shard) continue;
      const room = {id: pr.room, meta: this.world.roomMeta(pr.room), shard, worldRoom: null, origin: {x: 0, y: 0}, group: new THREE.Group()} as any;
      const parts = await this.world._gameRoomParts(room);
      const own = GameRoom.waterLevel(parts.batches);
      const floated = pr.float != null;
      const solid = floated ? parts.batches : parts.batches.filter(b => !b.water);
      let cx = 0, cy = 0, n = 0, base = Infinity;
      for (const b of solid) for (const m of b.matrices) { cx += m.elements[12]; cy += m.elements[13]; n++; base = Math.min(base, m.elements[14] + (b.payload?.bbox?.[2] ?? 0)); }
      if (!n) continue;
      const dz = level == null ? 0 : floated ? level - pr.float! - base : own != null ? level - own : 0;
      const place = new THREE.Matrix4().makeTranslation(pr.at[0] * T, pr.at[1] * T, dz)
        .multiply(new THREE.Matrix4().makeRotationZ(pr.turn)).multiply(new THREE.Matrix4().makeTranslation(-cx / n, -cy / n, 0));
      this.props.push({name: pr.name, level, own, centre: [cx / n, cy / n], base, place});
      for (const b of solid) this.source.batches.push({...b, matrices: b.matrices.map(m => place.clone().multiply(m))});
    }
  }

  props: any[] = [];

  /** Copies of the room's own models (shells) laid at `at` (tiles), turned by `turn`, on the ground there. */
  private addShells(shells: {mesh: number, place: [number, number], turn: number}[]) {
    const T = this.world.tileUnits, v = this.view;
    if (!v) return;
    for (const sh of shells) {
      if (!Array.isArray(sh.place)) continue;
      const b = this.source.batches.find(x => x.category === 'models' && x.mesh === sh.mesh);
      if (!b) continue;
      const m0 = b.matrices[0], [x, y] = viewPoint(v, sh.place).map(c => c * T);
      // its height above the ground where it lies in the room, kept
      const lift = m0.elements[14] - this.groundProbe(m0.elements[12], m0.elements[13], 0, true)(m0.elements[12], m0.elements[13]);
      const ground = this.groundProbe(x, y, 0, true)(x, y);
      const local = m0.clone().setPosition(0, 0, 0);
      const m = new THREE.Matrix4().makeTranslation(x, y, (Number.isFinite(ground) ? ground : 0) + (Number.isFinite(lift) ? lift : 0))
        .multiply(new THREE.Matrix4().makeRotationZ(sh.turn)).multiply(local);
      this.source.batches.push({...b, matrices: [m], tints: [b.tints[0]], recolours: b.recolours ? [b.recolours[0]] : undefined, order: b.order ? [b.order[0]] : undefined});
    }
  }

  /** The scene's other actors (the crab, the bather, the gulls): each posed by its own rig, drawn with its
   *  parts' skinned programs; their draws sit beside the character's. */
  private crab: Crab | null = null;
  private extras: {actor: SceneActor, draws: any[]}[] = [];
  private extraBuffers: WebGLBuffer[] = [];
  private get extraDraws() { return this.extras.flatMap(e => e.draws); }
  private async addActor(actor: SceneActor, parts: {mesh: number, material: number, renderTexture: number, recolours: number[][] | null}[], bones: number) {
    const f = this.frame as any, draws: any[] = [];
    f.gl.collect = this.extraBuffers;
    try {
      for (const p of parts) {
        const payload = await getJson(gf(`meshes/${pad5(p.mesh)}.json`)).catch(() => null);
        if (!payload?.skinned || !f.index.materials[String(p.material)]) continue;
        const d = await f.buildActorDraw({mesh: p.mesh, material: p.material, renderTexture: p.renderTexture, payload, bones, tint: null,
          recolours: p.recolours, palette: () => actor.ready ? actor.palette : null}).catch(() => null);
        if (d) { d.scene = 0; draws.push(d); }
      }
    } finally { f.gl.collect = null; }
    this.extras.push({actor, draws});
    f.actorDraws = [...draws, ...f.actorDraws];
  }
  private async rigOf(mesh: number) {
    const payload = await getJson(gf(`meshes/${pad5(mesh)}.json`));
    return new Rig(await getJson(at(`skel/${payload.skel}`)));
  }
  private clip = async (i: number) => new ClipSampler(await getJson(at(`clip/${i}`)));
  private async addCrab(spec: any) {
    const rig = await this.rigOf(spec.mesh);
    this.crabSpec = spec;
    const crab = new Crab(rig, await this.clip(spec.walk), await this.clip(spec.idle), await Promise.all((spec.fidgets ?? []).map(this.clip)), spec.pace);
    await this.addActor(crab, [spec], rig.bones.length);
    this.crab = crab;
  }
  /** Someone riding in a prop (the servant in his tub): where he stands in his own room, carried by the prop's
   *  placement, turned as his room turns him (a quarter turn a step), his resting clip looping. */
  private async addBather(spec: any) {
    const prop = this.props.find(p => p.name === spec.prop);
    if (!prop || !spec.parts?.length) return;
    const rig = await this.rigOf(spec.parts[0].mesh), T = this.world.tileUnits;
    const at = prop.place.clone().multiply(new THREE.Matrix4().makeTranslation(spec.at[0] * T, spec.at[1] * T, spec.at[2]))
      .multiply(new THREE.Matrix4().makeRotationZ((spec.quarters & 3) * Math.PI / 2));
    await this.addActor(new Posed(rig, spec.clip != null ? await this.clip(spec.clip) : null, at), spec.parts, rig.bones.length);
  }
  /** Gulls circling out over the sea. */
  private async addBirds(spec: any) {
    if (!spec.parts?.length) return;
    const clip = await this.clip(spec.clip), T = this.world.tileUnits, level = GameRoom.waterLevel(this.source.batches) ?? 0;
    for (const b of spec.flock) {
      const rig = await this.rigOf(spec.parts[0].mesh);
      await this.addActor(new Bird(rig, clip, [b.centre[0] * T, b.centre[1] * T, level + b.height], b.radius * T, b.speed, b.phase), spec.parts, rig.bones.length);
    }
  }

  /** The character's parts as the frame's actors (their programs by material row), posed by `rig`. */
  async setActors(parts: DrawPart[], rig: Rig) {
    const gen = ++this.actorGen;
    const bones = rig.bones.length;
    if (this.palette.length !== bones * 12) this.palette = new Float32Array(bones * 12);
    const f = this.frame as any;
    const actors: GameActorSource[] = [];
    for (const p of parts) {
      if (p.material == null || !f.index.materials[String(p.material)]) continue;
      const payload = await getJson(gf(`meshes/${pad5(p.mesh)}.json`)).catch(() => null);
      if (!payload?.skinned) continue;
      actors.push({mesh: p.mesh, material: p.material, renderTexture: p.mat ?? -1, payload, bones, tint: null,
        recolours: [[...p.t1, 1], [...p.t2, 1]], palette: () => this.paletteLive ? this.palette : null});
    }
    if (gen !== this.actorGen) return;
    // build the new actor draws beside the old, then swap (the frame keeps drawing the old meanwhile)
    const buffers: WebGLBuffer[] = [], draws: any[] = [];
    f.gl.collect = buffers;
    try {
      for (const a of actors) {
        const d = await f.buildActorDraw(a).catch((e: any) => { console.warn('actor part skipped', a.mesh, a.material, e); return null; });
        if (d) { d.scene = 0; draws.push(d); }
      }
    } finally { f.gl.collect = null; }
    if (gen !== this.actorGen) { f.freeDraws(draws, buffers); return; }
    const extra = this.extraDraws;
    const old = f.actorDraws.filter((d: any) => !extra.includes(d)), oldBuffers = this.actorBuffers;
    f.actorDraws = [...extra, ...draws]; this.actorBuffers = buffers;
    f.freeDraws(old, oldBuffers);
  }

  /** This frame's skin matrices: each bone's posed matrix in the room (through `roomFromRigWorld`, which
   *  takes three's world to the room's frame), times its inverse bind. */
  pose(rig: Rig, roomFromWorld: THREE.Matrix4) {
    const out = this.palette;
    if (out.length !== rig.bones.length * 12) { this.paletteLive = false; return; }
    for (let b = 0; b < rig.bones.length; b++) {
      this.skin.multiplyMatrices(roomFromWorld, rig.bones[b].matrixWorld).multiply(rig.boneInverses[b]);
      const e = this.skin.elements, o = b * 12;
      out[o] = e[0]; out[o + 1] = e[4]; out[o + 2] = e[8]; out[o + 3] = e[12];
      out[o + 4] = e[1]; out[o + 5] = e[5]; out[o + 6] = e[9]; out[o + 7] = e[13];
      out[o + 8] = e[2]; out[o + 9] = e[6]; out[o + 10] = e[10]; out[o + 11] = e[14];
    }
    this.paletteLive = true;
  }

  /** Draw the frame to the canvas (colour and depth), the camera in the room's frame. */
  render(camera: {eye: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3, fov: number, width: number, height: number}, dtMs: number, avatarZ: number, three: THREE.Camera) {
    this.effects?.tick(dtMs, three);
    for (const e of this.extras) e.actor.step(dtMs, camera.eye);
    const ticks = this.effects ? this.effects.clock.t : (this.ticks += dtMs * 0.6);
    this.frame.render(camera, ticks, avatarZ);
    // the frame's alpha is the programs' own; the canvas shows it opaque
    const gl = this.gl;
    gl.colorMask(false, false, false, true); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.colorMask(true, true, true, true);
  }
  private ticks = 0;

  dispose() {
    this.actorGen++;
    const f = this.frame as any;
    const extra = this.extraDraws;
    f.freeDraws(f.actorDraws.filter((d: any) => !extra.includes(d)), this.actorBuffers); f.actorDraws = []; this.actorBuffers = [];
    f.freeDraws(extra, this.extraBuffers); this.extras = []; this.extraBuffers = []; this.crab = null;
    this.frame.releaseRoom(); this.frame.releaseTextures();
    this.effects?.dispose(); this.effects = null;
    this.world.dispose?.();
  }
}

/** A point placed from the view (tiles): `right` of the character as the camera sees it, `toward` the camera. */
function viewPoint(v: {spot: [number, number], face: number}, [right, toward]: [number, number]): [number, number] {
  const f = v.face;
  return [v.spot[0] + Math.cos(f) * right + Math.sin(f) * toward, v.spot[1] - Math.sin(f) * right + Math.cos(f) * toward];
}

/** Teach the frame's GL wrapper the decoded signed normal maps (format SNORM_RG: RGBA signed bytes). */
const SNORM_RG = 0x7025;
function acceptSignedRG(ggl: any, gl: WebGL2RenderingContext) {
  const supports = ggl.supports.bind(ggl), upload = ggl.uploadTexture.bind(ggl);
  ggl.supports = (f: number) => f === SNORM_RG || supports(f);
  ggl.uploadTexture = (target: 'texture' | 'cube', levels: {width: number, height: number, data: Uint8Array}[][], format: number, srgb: boolean) => {
    if (format !== SNORM_RG) return upload(target, levels, format, srgb);
    const texture = gl.createTexture()!, glTarget = target === 'cube' ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    gl.bindTexture(glTarget, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const first = levels[0][0];
    gl.texStorage2D(glTarget, levels.length, gl.RGBA8_SNORM, first.width, first.height);
    levels.forEach((faces, level) => faces.forEach((face, f) => gl.texSubImage2D(target === 'cube' ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + f : gl.TEXTURE_2D,
      level, 0, 0, face.width, face.height, gl.RGBA, gl.BYTE, new Int8Array(face.data.buffer, face.data.byteOffset, face.data.length))));
    gl.texParameteri(glTarget, gl.TEXTURE_BASE_LEVEL, 0); gl.texParameteri(glTarget, gl.TEXTURE_MAX_LEVEL, levels.length - 1);
    return {texture, target: glTarget, width: first.width, height: first.height};
  };
}

/** The sand about (cx, cy): points on a quarter-tile grid within `reach` at the ground's level there (a shell,
 *  a step or the sea is not sand), as a lookup the crab walks by. */
function sandAround(ground: (x: number, y: number) => number, cx: number, cy: number, reach: number) {
  const step = 256, pts: {x: number, y: number, z: number}[] = [], ok = new Set<string>();
  const all: {x: number, y: number, z: number}[] = [], count = new Map<number, number>();
  for (let x = cx - reach; x <= cx + reach; x += step) for (let y = cy - reach; y <= cy + reach; y += step) {
    if (Math.hypot(x - cx, y - cy) > reach) continue;
    const z = ground(x, y);
    if (!Number.isFinite(z)) continue;
    all.push({x, y, z}); count.set(Math.round(z / 8), (count.get(Math.round(z / 8)) ?? 0) + 1);
  }
  // the sand's level: the commonest height there
  const level = count.size ? [...count].sort((a, b) => b[1] - a[1])[0][0] * 8 : 0;
  for (const p of all) if (Math.abs(p.z - level) <= 24) { pts.push(p); ok.add(`${Math.round(p.x / step)},${Math.round(p.y / step)}`); }
  return {pts, level, cx, cy, walkable: (x: number, y: number) => ok.has(`${Math.round(x / step)},${Math.round(y / step)}`)};
}

/** Something alive in the scene beside the character, posed each frame by its own rig: its skin matrices
 *  (row-major 3x4 per bone, the room's frame) are `palette`. */
interface SceneActor { palette: Float32Array; readonly ready: boolean; step(dtMs: number, eye: THREE.Vector3): void }

/** The palette of `rig` placed by `m` (bones in the rig's frame, then `m`). */
function skinInto(out: Float32Array, rig: Rig, m: THREE.Matrix4, s: THREE.Matrix4) {
  rig.bones.forEach((b, i) => {
    const e = s.multiplyMatrices(m, b.matrixWorld).multiply(rig.boneInverses[i]).elements, o = i * 12;
    out[o] = e[0]; out[o + 1] = e[4]; out[o + 2] = e[8]; out[o + 3] = e[12];
    out[o + 4] = e[1]; out[o + 5] = e[5]; out[o + 6] = e[9]; out[o + 7] = e[13];
    out[o + 8] = e[2]; out[o + 9] = e[6]; out[o + 10] = e[10]; out[o + 11] = e[14];
  });
}

/** Someone in one place, playing one clip over and over. */
class Posed implements SceneActor {
  palette: Float32Array; ready = true;
  private t = Math.random() * 5000; private s = new THREE.Matrix4();
  constructor(private rig: Rig, private clip: ClipSampler | null, private at: THREE.Matrix4) { this.palette = new Float32Array(rig.bones.length * 12); }
  step(dtMs: number) {
    this.t += Math.min(100, dtMs);
    // (no clip: the model as it was made, its bind pose)
    if (this.clip) this.clip.apply(this.rig, this.clip.duration ? this.t % this.clip.duration : 0);
    for (const r of this.rig.roots) r.updateMatrixWorld(true);
    skinInto(this.palette, this.rig, this.at, this.s);
  }
}

/** A gull on a circle out over the sea (`centre` and `radius` in native units, `speed` units a second), its
 *  wings beating, banked into the turn. It flies along its own +y. */
class Bird implements SceneActor {
  palette: Float32Array; ready = true;
  private t = Math.random() * 4000; private m = new THREE.Matrix4(); private s = new THREE.Matrix4(); private r = new THREE.Matrix4();
  constructor(private rig: Rig, private clip: ClipSampler, private centre: number[], private radius: number, private speed: number, private angle: number) {
    this.palette = new Float32Array(rig.bones.length * 12);
  }
  step(dtMs: number) {
    const dt = Math.min(100, dtMs);
    this.t += dt; this.angle += this.speed * dt / 1000 / this.radius;
    this.clip.apply(this.rig, this.clip.duration ? this.t % this.clip.duration : 0);
    for (const r of this.rig.roots) r.updateMatrixWorld(true);
    const a = this.angle, x = this.centre[0] + Math.cos(a) * this.radius, y = this.centre[1] + Math.sin(a) * this.radius;
    const z = this.centre[2] + Math.sin(a * 2.3) * 180;   // (rising and falling a little as it goes round)
    // heading: along the circle (counter-clockwise), +y forward; banked toward the middle
    this.m.makeRotationZ(a).setPosition(x, y, z).multiply(this.r.makeRotationY(0.35));
    skinInto(this.palette, this.rig, this.m, this.s);
  }
}

/** A crab about the sand, for the camera: it sits facing the camera (its idle, now and then a fidget), now
 *  and then scuttles a short way over sand and settles facing the camera again. Its front is its own -x
 *  (claws and eyes) and its walk cycle carries it along its y, sideways as crabs go: going the other way it
 *  plays the cycle backwards. Its skin matrices (row-major 3x4 per bone, the room's frame) are `palette`. */
class Crab implements SceneActor {
  palette: Float32Array;
  private x = 0; private y = 0; private heading = 0;
  private sand: ReturnType<typeof sandAround> | null = null;
  private to: {x: number, y: number} | null = null;
  private back = false;   // scuttling toward its -y
  private rest = 2500; private t = 0;
  private playing: ClipSampler;
  private m = new THREE.Matrix4(); private s = new THREE.Matrix4();
  constructor(private rig: Rig, private walk: ClipSampler, private idle: ClipSampler, private fidgets: ClipSampler[], private pace: number) {
    this.palette = new Float32Array(rig.bones.length * 12);
    this.playing = idle;
  }
  get ready() { return !!this.sand; }
  /** Its patch of sand (it starts in the middle of it). */
  settle(sand: ReturnType<typeof sandAround>) {
    if (!sand.pts.length) return;
    this.sand = sand;
    const mid = sand.pts.reduce((a, p) => Math.hypot(p.x - sand.cx, p.y - sand.cy) < Math.hypot(a.x - sand.cx, a.y - sand.cy) ? p : a);
    this.x = mid.x; this.y = mid.y; this.to = null;
  }
  step(dtMs: number, eye: THREE.Vector3) {
    if (!this.sand) return;
    const dt = Math.min(100, dtMs);
    this.t += dt;
    const turnTo = (want: number) => {
      const turn = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading)), most = 6 * dt / 1000;
      this.heading += Math.max(-most, Math.min(most, turn));
      return Math.abs(turn);
    };
    if (!this.to) {
      turnTo(Math.atan2(this.y - eye.y, this.x - eye.x));   // its -x toward the camera
      this.rest -= dt;
      if (this.playing !== this.idle && this.t >= this.playing.duration) this.play(this.idle);
      if (this.rest <= 0) this.pick();
    } else {
      const dx = this.to.x - this.x, dy = this.to.y - this.y, d = Math.hypot(dx, dy);
      if (turnTo(Math.atan2(-dx, dy) + (this.back ? Math.PI : 0)) < 0.3) {
        const go = Math.min(d, this.pace * dt / 1000);
        this.x += dx / d * go; this.y += dy / d * go;
        if (d - go < 1) { this.to = null; this.rest = 2500 + Math.random() * 3500; this.play(this.idle); }
      }
    }
    this.pose();
  }
  private play(c: ClipSampler) { this.playing = c; this.t = 0; }
  /** Now a fidget, now a spot a little way off reached over sand. */
  private pick() {
    const {pts, walkable} = this.sand!;
    if (this.fidgets.length && Math.random() < 0.4) { this.play(this.fidgets[Math.floor(Math.random() * this.fidgets.length)]); this.rest = this.playing.duration + 1500; return; }
    for (let k = 0; k < 24; k++) {
      const p = pts[Math.floor(Math.random() * pts.length)];
      const d = Math.hypot(p.x - this.x, p.y - this.y);
      if (d < 200 || d > 700) continue;
      let clear = true;
      for (let u = 0.1; u < 1 && clear; u += 0.1) clear = walkable(this.x + (p.x - this.x) * u, this.y + (p.y - this.y) * u);
      if (!clear) continue;
      // sideways whichever way is the lesser turn from facing the camera
      const along = Math.atan2(-(p.x - this.x), p.y - this.y), off = Math.atan2(Math.sin(along - this.heading), Math.cos(along - this.heading));
      this.back = Math.abs(off) > Math.PI / 2;
      this.to = {x: p.x, y: p.y}; this.play(this.walk);
      return;
    }
    this.rest = 1500;
  }
  private pose() {
    const c = this.playing;
    const looped = c.duration ? this.t % c.duration : 0;
    c.apply(this.rig, !c.duration ? 0 : c === this.walk ? (this.back ? c.duration - looped : looped) : c === this.idle ? looped : Math.min(this.t, c.duration));
    for (const r of this.rig.roots) r.updateMatrixWorld(true);
    this.m.makeRotationZ(this.heading).setPosition(this.x, this.y, this.sand!.level);
    const out = this.palette;
    this.rig.bones.forEach((b, i) => {
      const e = this.s.multiplyMatrices(this.m, b.matrixWorld).multiply(this.rig.boneInverses[i]).elements, o = i * 12;
      out[o] = e[0]; out[o + 1] = e[4]; out[o + 2] = e[8]; out[o + 3] = e[12];
      out[o + 4] = e[1]; out[o + 5] = e[5]; out[o + 6] = e[9]; out[o + 7] = e[13];
      out[o + 8] = e[2]; out[o + 9] = e[6]; out[o + 10] = e[10]; out[o + 11] = e[14];
    });
  }
}
