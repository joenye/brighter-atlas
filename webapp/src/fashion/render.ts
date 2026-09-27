// Three.js preview: the player rig (the app's Rig/ClipSampler) playing a clip,
// one skinned mesh per composed part with the app's two-mask recolour shader.
// Game coordinates are mapped like the viewer's world ((x, y, z) -> (x, z, y),
// a reflection), so held items sit in the right hand.
//
// Two uses: the creator's small circular preview (the client's framing plus
// its dimmed back-view figure) and the full-body viewer (drag to spin with
// inertia, zoom from full body to face).
import {at, DEV} from './data.js';
import * as THREE from '../../vendor/three.module.js';
import {Rig, ClipSampler} from '../viewers/rig.js';
import {applyPackedRecolor} from '../recolor.js';
import {buildMeshGeometry} from '../viewers/mesh-geometry.js';
import {PartSkinnedMesh} from '../viewers/part-skinned-mesh.js';
import {EffectsPlayer} from '../viewers/world/effects-player.js';
import {EffectBoneAnimation} from '../viewers/world/effects-animation.js';
import type {DrawPart} from './compose.js';
// A failure worth knowing about on a device whose console is out of reach (a phone): sent to a local data server's log
export function report(what: string, e?: unknown) {
  const err = e as any;
  const text = `${what}: ${err?.name ?? ''} ${err?.message ?? String(e ?? '')}\n${err?.stack ?? ''}\n${location.href} dpr ${devicePixelRatio} ${innerWidth}x${innerHeight}`;
  if (!DEV) return;   // (the hosted site keeps no log)
  try { navigator.sendBeacon?.('/log', text) || fetch('/log', {method: 'POST', body: text, keepalive: true}); } catch {}
}
// (the game's renderer is a chunk of its own, fetched when a place drawn by the game is picked)
import type {GameRoom} from './gameroom.js';

const loader = new THREE.TextureLoader();
const meshCache = new Map<number, Promise<any>>();
const texCache = new Map<string, Promise<THREE.Texture | null>>();
const jsonCache = new Map<string, Promise<any>>();
const getJson = (url: string) => { let p = jsonCache.get(url); if (!p) { p = fetch(url).then(r => { if (!r.ok) throw Error(`${url}: ${r.status}`); return r.json(); }); jsonCache.set(url, p); } return p; };
const getMesh = (i: number) => {
  let p = meshCache.get(i);
  if (!p) { p = getJson(at(`mesh/${i}`)).then(m => buildMeshGeometry(m, {boneColors: false})); meshCache.set(i, p); }
  return p;
};
const getTex = (kind: 'tex' | 'param', i: number) => {
  const key = `${kind}/${i}`;
  let p = texCache.get(key);
  if (!p) {
    p = new Promise(res => loader.load(at(key), t => {
      t.colorSpace = kind === 'tex' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      res(t);
    }, undefined, () => res(null)));
    texCache.set(key, p);
  }
  return p;
};
// warm the caches (e.g. the next item in a list) without drawing anything
export function prefetch(parts: DrawPart[]) { for (const p of parts) { void getMesh(p.mesh).catch(() => {}); if (p.mat != null) { void getTex('tex', p.mat); void getTex('param', p.mat); } } }

// the head (the framings' close-ups aim at it when a stance moves it)
const HEAD_BONE = 6;
// In a place the character stands this far above the ground (units): a pose can carry a sole a unit or two
// below the rig's origin, which would sink it into the floor
const FOOT_LIFT = 8;
// the lens over a place drawn by the game (degrees, vertical)
const GAME_FOV = 16;

export interface Framing { dist: number; target: number }
export const FRAMES: Record<string, Framing> = {full: {dist: 5600, target: 760}, upper: {dist: 3000, target: 1060}, face: {dist: 1450, target: 1230}};

export class Preview {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  root = new THREE.Group();
  anchor = new THREE.Group();
  camera: THREE.PerspectiveCamera;
  ghostCamera: THREE.PerspectiveCamera;
  rig: Rig | null = null;
  clips = new Map<number, ClipSampler>();
  clip: ClipSampler | null = null;
  active = new Map<string, THREE.Mesh>();
  // view
  yaw = 0; yawVel = 0; pitch = 0.04; roomPitch = 0.1;
  // over a place drawn by the game the long lens looks out nearly level: the horizon sits low enough for the ship
  gamePitch = 0.045;
  dist = 3600; target = 1030;
  want: Framing = {dist: 3600, target: 1030};
  ghost = false;
  running = true;
  // the resting clip hides held items by scaling their bones to 0.001; show them in hand instead
  showHeld = false;
  clipId: number | null = null;

  private t0 = performance.now();
  private last = performance.now();
  private parts: DrawPart[] = [];
  private gen = 0;
  onLoading: (n: number) => void = () => {};
  /** A game place's load, 0 to 1. */
  onRoomProgress: (f: number) => void = () => {};
  // worn-item particle effects (the app's EffectsPlayer, in the rig's frame)
  private skelJson: any = null;
  private clipJson: any = null;
  private effectsRoot = new THREE.Group();
  effects: EffectsPlayer | null = null;
  private effectSlots = new Set<number>();
  private effectAnim: EffectBoneAnimation | null = null;

  constructor(public canvas: HTMLCanvasElement, opts: {fov?: number, ghost?: boolean, floor?: boolean} = {}) {
    this.baseFov = opts.fov ?? 18;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, 1, 10, 30000);
    this.ghostCamera = new THREE.PerspectiveCamera(opts.fov ?? 18, 1, 10, 30000);
    this.ghost = !!opts.ghost;
    this.renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, preserveDrawingBuffer: true});
    // at least twice the screen's pixels (on a 1x desktop the frame, which has no antialiasing of its own, is
    // drawn at 2x and scaled down: supersampled), the phone's own 3x at most
    this.renderer.setPixelRatio(Math.min(3, Math.max(2, devicePixelRatio)));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    // (x, y, z) -> (x, z, y)
    this.root.matrixAutoUpdate = false;
    this.root.matrix.set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    this.root.add(this.anchor, this.effectsRoot);
    this.scene.add(this.root);
    this.scene.add(this.lights);
    this.lights.add(new THREE.HemisphereLight(0xe4e9ff, 0x2e2820, 1.25));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.2); key.position.set(-900, 1900, 1700); this.lights.add(key);
    const fill = new THREE.DirectionalLight(0xc8d6ff, 0.55); fill.position.set(1400, 900, 900); this.lights.add(fill);
    const rim = new THREE.DirectionalLight(0xd6e2ff, 1.0); rim.position.set(900, 1500, -1800); this.lights.add(rim);
    if (opts.floor) { this.floorGroup = floorShadow(); this.scene.add(this.floorGroup); }
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('webglcontextlost', () => report('webgl context lost'));
    const loop = () => { if (this.running) this.frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  async init(skeleton: number, clip: number) {
    const skel = await getJson(at(`skel/${skeleton}`));
    this.skelJson = skel;
    this.rig = new Rig(skel);
    this.anchor.add(...this.rig.roots);
    this.restClip = clip;
    await this.setClip(clip);
    await this.apply(this.parts);
  }
  private restClip: number | null = null;
  private headRest: THREE.Vector3 | null = null;   // the aim point in the head's frame at rest
  private headAt = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private focusOff = new THREE.Vector3();

  private wantClip: number | null = null;
  async setClip(i: number) {
    this.wantClip = i;
    let c = this.clips.get(i);
    const json = await getJson(at(`clip/${i}`));
    if (this.wantClip !== i) return;
    if (!c) { c = new ClipSampler(json); this.clips.set(i, c); }
    this.clip = c; this.clipJson = json; this.clipId = i;
    this.effectAnim?.dispose(); this.effectAnim = null;
  }

  resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    for (const cam of [this.camera, this.ghostCamera]) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
  }

  // ease to a heading (radians)
  turnTo(a: number) { this.yawGoal = a; }
  private yawGoal: number | null = null;
  frameTo(f: Framing, instant = false) { this.want = {...f}; if (instant) { this.dist = f.dist; this.target = f.target; } }
  zoomBy(factor: number) {
    // slide between the full-body and face framings along the distance
    const {full, face} = FRAMES;
    const d = Math.max(face.dist, Math.min(full.dist * (this.roomPlace ? 1.8 : 1.15), this.want.dist * factor));   // in a place, pull back to see more of it
    const t = (d - face.dist) / (full.dist - face.dist);
    this.want = {dist: d, target: face.target + (full.target - face.target) * Math.max(0, Math.min(1, t))};
  }

  async apply(parts: DrawPart[]) {
    this.parts = parts;
    if (!this.rig) return;
    const gen = ++this.gen;
    const wanted = new Map(parts.map(p => [p.key, p]));
    const missing = parts.filter(p => !this.active.has(p.key));
    this.onLoading(missing.length);
    const built = await Promise.all(missing.map(p => this.build(p).catch(e => { console.warn('part', p, e); return null; })));
    if (gen !== this.gen) { for (const m of built) if (m) (m.material as THREE.Material).dispose(); return; }
    for (const [key, m] of this.active) if (!wanted.has(key)) { this.root.remove(m); (m.material as THREE.Material).dispose(); this.active.delete(key); }
    missing.forEach((p, i) => { const m = built[i]; if (m) { this.root.add(m); this.active.set(p.key, m); } });
    parts.forEach((p, i) => { const m = this.active.get(p.key); if (m) m.renderOrder = i; });
    if (this.game) await this.game.setActors(parts, this.rig).catch(e => console.warn('game actors', e));
    this.onLoading(0);
  }

  private async build(p: DrawPart) {
    const [{geo, skinned}, map, param] = await Promise.all([getMesh(p.mesh), p.mat != null ? getTex('tex', p.mat) : null, p.mat != null ? getTex('param', p.mat) : null]);
    const mat = new THREE.MeshStandardMaterial({color: map ? 0xffffff : 0xb9c2cf, map: map ?? null, metalness: 0.02, roughness: 0.82, alphaTest: 0.35, side: THREE.DoubleSide});
    applyPackedRecolor(mat, param, [p.t1, p.t2]);
    // skin in the rig frame, then apply the part's own world (the root's basis) once
    const mesh = skinned ? new PartSkinnedMesh(geo, mat, this.anchor) : new THREE.Mesh(geo, mat);
    if (skinned) (mesh as any).bind(this.rig!.skeleton, new THREE.Matrix4());
    mesh.frustumCulled = false;
    mesh.userData.part = p;
    return mesh;
  }

  // Show exactly these effect systems (by id); others stop. Their bones follow the playing clip.
  async setEffects(slots: number[]) {
    const want = new Set(slots);
    if (want.size && !this.effects) {
      const doc = await getJson(at('effects.json')).catch(() => null);
      if (!doc || !this.rig) return;
      this.effects = new EffectsPlayer({root: this.effectsRoot, doc, url: at,
        rig: {id: this.rig.skelIndex, bones: this.rig.boneInverses.map(m => m.clone().invert().elements)}});
    }
    if (!this.effects) return;
    for (const s of want) if (this.effectSlots.has(s) && !this.wantEffects.has(s)) this.effects.play(s);   // back on: restart it
    for (const s of want) if (!this.effectSlots.has(s)) {
      const sys = this.effects.doc.systems.find((x: any) => x.slot === s);
      if (sys) sys.triggered = false;   // the game loops it while the item is worn
      if (this.effects.addSystem(s)) this.effectSlots.add(s);
    }
    for (const s of [...this.effectSlots]) if (!want.has(s)) { this.effects.stop(s); }
    this.effectsRoot.visible = want.size > 0;
    this.effects.setRunning(want.size > 0);
    this.wantEffects = want;
  }
  private wantEffects = new Set<number>();

  // ---- a room behind the character (a game place as the backdrop) ----
  private roomGroup = new THREE.Group();
  private floorGroup: THREE.Object3D | null = null;
  // the disc under the character: 'ring' (shadow and ring), 'shadow', or 'none'
  floorMode: 'ring' | 'shadow' | 'none' = 'ring';
  setFloor(mode: 'ring' | 'shadow' | 'none') { this.floorMode = mode; this.showFloor(); }
  private showFloor() {
    if (!this.floorGroup) return;
    // (never in a place: its floor takes the figure's own shadow)
    this.floorGroup.visible = this.floorMode !== 'none' && !this.roomPlace;
    this.floorGroup.children[1].visible = this.floorMode === 'ring';
  }
  roomId: number | null = null;
  private wide = 1;
  // a place, drawn by the game's own programs (gameroom.ts)
  game: GameRoom | null = null;
  // while a game frame builds, its GL work lands between three's frames, behind three's state cache
  private gameBuilds = 0;
  async setRoom(room: {id: number} | null) {
    this.roomId = room?.id ?? null;
    if (this.game) { this.game.fxRoot.removeFromParent(); this.game.dispose(); this.game = null; this.renderer.resetState(); }
    this.roomPlace = null;
    this.setWide(false);
    if (!room) { this.showFloor(); return; }
    if (!this.roomGroup.parent) { this.roomGroup.matrixAutoUpdate = false; this.root.add(this.roomGroup); }
    const gl = this.renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) throw Error('a place needs WebGL 2');
    try {
      this.gameBuilds++;
      // (a page older than the site's build asks for a chunk that has moved on: reload it, once)
      const {GameRoom} = await import('./gameroom.js').catch(e => {
        let again = false;
        try { again = !sessionStorage.getItem('fashion.reloaded'); sessionStorage.setItem('fashion.reloaded', '1'); } catch {}
        if (again) location.reload();
        throw e;
      });
      const g = await GameRoom.load(gl, room.id, {progress: f => { if (this.roomId === room.id) this.onRoomProgress(f); },
        cancelled: () => this.roomId !== room.id}).finally(() => this.gameBuilds--);
      this.renderer.resetState();
      if (this.roomId !== room.id || this.game) { g.dispose(); this.renderer.resetState(); return; }
      // (the scene names its own view: where the character stands, and the turn that puts the view behind)
      const [sx, sy] = [g.view!.spot[0] * 1024, g.view!.spot[1] * 1024];
      this.roomPlace = {face: g.view!.face, sx, sy, z: g.standAt(sx, sy)};
      g.aim(this.roomPlace);
      if (this.roomId !== room.id || this.game) { g.dispose(); this.renderer.resetState(); return; }
      // the character in it before it shows (the place never appears without them)
      const dressed = this.parts;
      if (this.rig) { this.gameBuilds++; await g.setActors(dressed, this.rig).finally(() => this.gameBuilds--); }
      if (this.roomId !== room.id || this.game) { g.dispose(); this.renderer.resetState(); return; }
      this.game = g;
      this.roomGroup.add(g.fxRoot);
      this.placeRoom(0);
      if (this.parts !== dressed && this.rig) void g.setActors(this.parts, this.rig);   // (changed meanwhile)
      this.onRoomProgress(1);
      this.renderer.resetState();
      this.showFloor();
      this.yaw = 0; this.yawGoal = null; this.yawVel = 0;
      this.setWide(true);
      return;
    } catch (e) {
      this.renderer.resetState();
      if ((e as Error)?.name === 'LoadCancelled' || this.roomId !== room.id) return;   // another place (or none) was picked meanwhile
      report('game frame failed', e);
      throw e;
    }
  }
  // In a place the scene stays put and the character turns (a game's character screen): the camera still
  // orbits by `yaw`, so the room turns with it and the chosen view stays behind the character.
  private roomPlace: {face: number, sx: number, sy: number, z: number} | null = null;
  // in a place the lights turn with the camera too, so the room stays lit the same way
  private lights = new THREE.Group();
  private placeRoom(yaw: number) {
    const p = this.roomPlace; if (!p) return;
    this.roomGroup.matrix.makeRotationZ(p.face - yaw).multiply(new THREE.Matrix4().makeTranslation(-p.sx, -p.sy, -p.z - FOOT_LIFT));
    this.roomGroup.matrixWorldNeedsUpdate = true;
  }
  // A place takes a long lens from further back (the character kept the same size): the game's own camera stands some
  // 15,000 units off, so its scenes show next to no perspective, and near the lens the floor's tiles would
  // loom over a character (who then looks small beside them).
  private setWide(on: boolean) {
    const fov = on ? GAME_FOV : this.baseFov;
    this.wide = Math.tan(this.baseFov * Math.PI / 360) / Math.tan(fov * Math.PI / 360);
    this.camera.fov = fov; this.camera.far = on ? 60000 : 30000; this.camera.near = 10;
    // over the game's frame, three's overlays test against its depth: the same range
    if (on && this.game) { this.camera.near = this.game.near; this.camera.far = this.game.far; }
    this.camera.updateProjectionMatrix();
  }
  private baseFov = 18;

  frame() {
    const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000); this.last = now;
    const t = now - this.t0;
    if (this.rig && this.clip) {
      this.clip.apply(this.rig, this.clip.duration ? t % this.clip.duration : 0);
      // a clip that hides the held bones (the resting clip scales them to 0.001) shows them at rest instead
      if (this.showHeld) this.clip.bones.forEach((b, i) => {
        if (b?.scale.mode === 'const' && (b.scale as any).value[0] < 0.01) this.rig!.resetBoneToRest(i);
      });
    }
    // inertia and eased framing
    if (this.yawGoal != null) { this.yaw += (this.yawGoal - this.yaw) * (1 - Math.pow(0.004, dt)); if (Math.abs(this.yawGoal - this.yaw) < 0.002 || this.yawVel) this.yawGoal = null; }
    // a flick coasts: gentle friction, then a quicker stop once it is slow
    this.yaw += this.yawVel * dt; this.yawVel *= Math.pow(Math.abs(this.yawVel) > 1.5 ? 0.35 : 0.05, dt);
    if (Math.abs(this.yawVel) < 0.02) this.yawVel = 0;
    const k = 1 - Math.pow(0.0015, dt);
    this.dist += (this.want.dist - this.dist) * k; this.target += (this.want.target - this.target) * k;
    const a = this.yaw, d = this.dist * this.wide, lift = Math.sin(this.roomPlace ? (this.game ? this.gamePitch : this.roomPitch) : this.pitch) * d;   // a little more of the place's ground than sky
    // close framings follow the head: a combat stance crouches and leans it away from where it rests
    const f = this.focus.set(0, this.target, 0);
    if (this.rig) {
      const head = this.rig.bones[HEAD_BONE];
      head.updateWorldMatrix(true, false);
      // the face close-up's aim point, carried in the head's own frame (so a head that tips forward takes it along)
      const {full, face} = FRAMES;
      if (this.clipId === this.restClip && !this.headRest) this.headRest = new THREE.Vector3(0, face.target, 0).applyMatrix4(head.matrixWorld.clone().invert());
      // (at rest the framings are the client's own; the offset eases in and out as the stance changes)
      const w = Math.max(0, Math.min(1, (full.dist - this.dist) / (full.dist - face.dist)));
      const want = this.headRest && this.clipId !== this.restClip
        ? this.headAt.copy(this.headRest).applyMatrix4(head.matrixWorld).sub(this.focus.set(0, face.target, 0)).multiplyScalar(w) : this.headAt.set(0, 0, 0);
      f.set(0, this.target, 0);
      this.focusOff.lerp(want, k);
      f.add(this.focusOff);
    }
    this.camera.position.set(f.x + Math.sin(a) * d, f.y + lift, f.z + Math.cos(a) * d);
    this.camera.lookAt(f);
    this.camera.updateMatrixWorld();
    this.placeRoom(a);
    this.lights.rotation.y = this.roomPlace ? a : 0;
    this.tickEffects(dt * 1000);
    const r = this.renderer;
    if (this.game && this.roomPlace && this.rig) { this.gameFrame(dt * 1000, f); return; }
    if (this.gameBuilds) r.resetState();
    r.clear();
    if (this.ghost && this.active.size) {
      // the client's preview: the same figure from behind, dimmed, up and to the left
      this.ghostCamera.position.set(-Math.sin(a) * d, this.target + lift, -Math.cos(a) * d);
      this.ghostCamera.lookAt(0, this.target, 0);
      this.ghostCamera.setViewOffset(1000, 1000, 170, 22, 1000, 1000);
      // the client draws it as itself, textured, only dimmed
      const lit: [THREE.Color, THREE.Color][] = [];
      for (const m of this.active.values()) { const c = (m.material as THREE.MeshStandardMaterial).color; lit.push([c, c.clone()]); c.multiplyScalar(0.42); }
      const fog = this.scene.fog; this.scene.fog = null;
      r.render(this.scene, this.ghostCamera);
      for (const [c, was] of lit) c.copy(was);
      this.scene.fog = fog;
      r.clearDepth();
    }
    r.render(this.scene, this.camera);
  }

  // The game's frame (the place and the character in it), then three's overlays over it: the worn
  // item's effects, depth tested against the frame.
  private roomFromWorld = new THREE.Matrix4();
  private skinFrame = new THREE.Matrix4();
  private gameFrame(dtMs: number, focus: THREE.Vector3) {
    const g = this.game!, r = this.renderer;
    this.scene.updateMatrixWorld(true);
    const toRoom = this.roomFromWorld.copy(this.roomGroup.matrixWorld).invert();
    // bones skin in the rig frame, then the root's basis (PartSkinnedMesh): into the room from there
    this.anchor.updateWorldMatrix(true, false);
    g.pose(this.rig!, this.skinFrame.copy(toRoom).multiply(this.root.matrixWorld).multiply(this.anchor.matrixWorld.clone().invert()));
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const eye = this.camera.position.clone().applyMatrix4(toRoom), target = focus.clone().applyMatrix4(toRoom);
    const up = new THREE.Vector3(0, 1, 0).transformDirection(toRoom);
    g.render({eye, target, up, fov: this.camera.fov, width: size.x, height: size.y}, dtMs, this.roomPlace!.z, this.camera);
    r.resetState();
    // the frame drew the character: three draws only what the frame does not
    for (const m of this.active.values()) m.visible = false;
    const fog = this.scene.fog; this.scene.fog = null;
    // (the sky turns with the place, as the character turns in it: its clouds keep their places over the sea)
    this.sky.position.copy(this.camera.position); this.sky.rotation.y = this.yaw; this.sky.scale.setScalar(this.camera.far * 0.9); this.sky.updateMatrixWorld(); this.sky.visible = true;
    (this.sky.material as THREE.ShaderMaterial).uniforms.time.value = (performance.now() - this.t0) / 1000;
    this.haze.position.copy(this.camera.position); this.haze.updateMatrixWorld(); this.haze.visible = true;
    const height = Math.max(200, eye.z - this.roomPlace!.z), u = (this.haze.material as THREE.ShaderMaterial).uniforms;
    u.lo.value = -height / Preview.HAZE_FROM; u.hi.value = -height / Preview.HAZE_TO;
    r.render(this.scene, this.camera);
    this.sky.visible = this.haze.visible = false;
    this.scene.fog = fog;
    for (const m of this.active.values()) m.visible = true;
  }
  // The game never looks up far enough to see past its rooms; this view does. A sky fills whatever the
  // frame left empty (its depth still at the far plane): the room's own sky light at the horizon, deeper
  // overhead.
  private static HORIZON = new THREE.Color(0.80, 0.87, 0.94);
  // the haze's reach: clear to 190 tiles out (the ship stands nearer, even from the camera pulled right back),
  // whole by the far plane (360 tiles)
  private static HAZE_FROM = 190 * 1024;
  private static HAZE_TO = 340 * 1024;
  // and a haze at the horizon: a band around the camera, past the beach, that fades whatever lies beyond it
  // (the sea running out) into the sky's horizon, strongest at eye level
  private haze = (() => {
    const R = Preview.HAZE_FROM;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.6 * R, 64, 1, true), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, transparent: true,
      uniforms: {horizon: {value: Preview.HORIZON}, lo: {value: -0.08}, hi: {value: -0.04}},
      vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      // (below the horizon the band crosses the sea at lo: clear there, the haze thickening with the
      // distance out to the sea's end at hi)
      fragmentShader: `uniform vec3 horizon; uniform float lo; uniform float hi; varying vec3 vDir;
        void main() { float e = normalize(vDir).y; float a = e < 0.0 ? smoothstep(lo, hi, e) : 1.0 - smoothstep(0.0, 0.04, e);
          gl_FragColor = vec4(horizon, a); }`,
    }));
    m.visible = false; m.frustumCulled = false; m.renderOrder = 10;
    this.scene.add(m);
    return m;
  })();
  private sky = (() => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {horizon: {value: Preview.HORIZON}, zenith: {value: new THREE.Color(0.36, 0.55, 0.78)}, time: {value: 0}},
      vertexShader: `varying vec3 vDir; void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p; }`,
      // Clouds: a layer overhead (the view ray met with a plane above, so they crowd and flatten toward the
      // horizon), its cover from layered noise, drifting on the wind; lit from above, their undersides and
      // thick middles greyer, and thinning into the haze near the horizon.
      fragmentShader: `precision highp float;
        uniform vec3 horizon; uniform vec3 zenith; uniform float time; varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5; mat2 r = mat2(1.6, 1.2, -1.2, 1.6);
          for (int i = 0; i < 6; i++) { v += a * noise(p); p = r * p; a *= 0.5; }
          return v;
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 sky = mix(horizon, zenith, pow(h, 0.6));
          if (d.y > 0.0) {
            vec2 uv = d.xz / (d.y + 0.1) * 1.6 + vec2(time * 0.006, time * 0.002);
            float n = fbm(uv), cover = smoothstep(0.5, 0.78, n);
            float lit = clamp(0.75 - (fbm(uv + vec2(0.05, 0.08)) - n) * 5.0 - cover * 0.3, 0.0, 1.0);
            vec3 cloud = mix(vec3(0.70, 0.74, 0.80), vec3(1.0, 0.985, 0.95), lit);
            sky = mix(sky, cloud, cover * smoothstep(0.0, 0.1, d.y) * 0.95);
          }
          gl_FragColor = vec4(sky, 1.0);
        }`,
    }));
    m.visible = false; m.frustumCulled = false; m.renderOrder = -10;
    this.scene.add(m);
    return m;
  })();

  private tickEffects(dtMs: number) {
    if (!this.effects || !this.wantEffects.size) return;
    if (!this.effectAnim && this.skelJson && this.clipJson) this.effectAnim = new EffectBoneAnimation(this.skelJson, this.clipJson, true, this.effects.clock.tickRate, () => performance.now() - this.t0);
    for (const s of this.wantEffects) this.effects.setAnimation(s, this.effectAnim);
    this.effects.tick(dtMs, this.camera);
  }

  // a picture at least `minHeight` pixels tall, whatever the canvas's size on screen
  snapshot(minHeight = 0): string {
    const pr = this.renderer.getPixelRatio(), h = this.canvas.clientHeight || 1;
    if (minHeight > h * pr) { this.renderer.setPixelRatio(Math.min(4, minHeight / h)); this.resize(); }
    this.frame();
    const url = this.canvas.toDataURL('image/png');
    if (this.renderer.getPixelRatio() !== pr) { this.renderer.setPixelRatio(pr); this.resize(); }
    return url;
  }
}

function floorShadow() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)'); grad.addColorStop(0.6, 'rgba(0,0,0,0.25)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1300, 1300), new THREE.MeshBasicMaterial({map: tex, transparent: true, depthWrite: false}));
  m.rotation.x = -Math.PI / 2; m.position.y = 1;
  const ring = new THREE.Mesh(new THREE.RingGeometry(560, 572, 96), new THREE.MeshBasicMaterial({color: 0xc8b27a, transparent: true, opacity: 0.18, depthWrite: false}));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 2;
  const grp = new THREE.Group(); grp.add(m, ring);
  return grp;
}

// Thumbnails of single items, rendered once each on a small shared offscreen canvas:
// the item's own parts on the rig at rest, framed on their bounds, seen from the front.
export class Thumbnailer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private root = new THREE.Group();
  private anchor = new THREE.Group();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
  private rig: Rig | null = null;
  private cache = new Map<string, Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private size = 112) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    this.renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, preserveDrawingBuffer: true});
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.root.matrixAutoUpdate = false;
    this.root.matrix.set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    this.root.add(this.anchor); this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xe4e9ff, 0x2e2820, 1.4));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.2); key.position.set(-900, 1600, 1800); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xd6e2ff, 1.3); rim.position.set(1200, 1400, -1600); this.scene.add(rim);
  }
  thumb(key: string, parts: DrawPart[], skeleton: number): Promise<string> {
    let p = this.cache.get(key);
    if (!p) { p = this.queue.then(() => this.render(parts, skeleton)); this.queue = p.catch(() => {}); this.cache.set(key, p); }
    return p;
  }
  private async render(parts: DrawPart[], skeleton: number): Promise<string> {
    if (!this.rig) { this.rig = new Rig(await getJson(at(`skel/${skeleton}`))); this.anchor.add(...this.rig.roots); }
    const meshes: THREE.Mesh[] = [];
    const box = new THREE.Box3();
    for (const p of parts) {
      const [{geo, skinned}, map, param] = await Promise.all([getMesh(p.mesh), p.mat != null ? getTex('tex', p.mat) : null, p.mat != null ? getTex('param', p.mat) : null]);
      const mat = new THREE.MeshStandardMaterial({color: map ? 0xffffff : 0xb9c2cf, map: map ?? null, metalness: 0.02, roughness: 0.8, alphaTest: 0.35, side: THREE.DoubleSide});
      applyPackedRecolor(mat, param, [p.t1, p.t2]);
      const mesh = skinned ? new PartSkinnedMesh(geo, mat, this.anchor) : new THREE.Mesh(geo, mat);
      if (skinned) (mesh as any).bind(this.rig.skeleton, new THREE.Matrix4());
      mesh.frustumCulled = false;
      this.root.add(mesh); meshes.push(mesh);
      geo.computeBoundingBox();
      box.union(geo.boundingBox!.clone().applyMatrix4(this.root.matrix));
    }
    if (!meshes.length || box.isEmpty()) return '';
    // a three-quarter view from a little above (a hat's crown and brim, a boot's side), framed on the
    // bounds as seen from there
    const c = box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector3(0.5, 0.32, 1).normalize();
    this.camera.position.copy(c).addScaledVector(dir, 5000); this.camera.lookAt(c); this.camera.updateMatrixWorld();
    const inv = this.camera.matrixWorldInverse, seen = new THREE.Box3();
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) seen.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(inv));
    const sc = seen.getCenter(new THREE.Vector3()), ss = seen.getSize(new THREE.Vector3());
    const half = Math.max(ss.x, ss.y) * 0.54;
    Object.assign(this.camera, {left: sc.x - half, right: sc.x + half, top: sc.y + half, bottom: sc.y - half});
    this.camera.updateProjectionMatrix();
    this.renderer.setClearColor(0x000000, 0); this.renderer.clear();
    this.scene.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    for (const m of meshes) { this.root.remove(m); (m.material as THREE.Material).dispose(); }
    return url;
  }
}
