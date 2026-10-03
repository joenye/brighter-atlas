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
// A failure worth knowing about on a device whose console is out of reach (a phone): sent to a development server's log
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
// A download on a weak connection can fail: tried three times (0.8 s, then 1.6 s apart), and a failure is forgotten,
// so the next ask tries again (the export writes every file the page can ask for: a failure is the network's).
const retry = async <T,>(f: () => Promise<T>, tries = 3): Promise<T> => {
  for (let k = 1, wait = 800; ; k++, wait *= 2) { try { return await f(); } catch (e) { if (k >= tries) throw e; await new Promise(r => setTimeout(r, wait)); } }
};
const getJson = (url: string) => {
  let p = jsonCache.get(url);
  if (!p) { p = retry(() => fetch(url).then(r => { if (!r.ok) throw Error(`${url}: ${r.status}`); return r.json(); })); p.catch(() => jsonCache.delete(url)); jsonCache.set(url, p); }
  return p;
};
const getMesh = (i: number) => {
  let p = meshCache.get(i);
  if (!p) { p = getJson(at(`mesh/${i}`)).then(m => buildMeshGeometry(m, {boneColors: false})); p.catch(() => meshCache.delete(i)); meshCache.set(i, p); }
  return p;
};
const getTex = (kind: 'tex' | 'param' | 'light' | 'glow', i: number) => {
  const key = `${kind}/${i}`;
  let p = texCache.get(key);
  if (!p) {
    p = retry(() => new Promise<THREE.Texture>((res, rej) => loader.load(at(key), t => {
      t.colorSpace = kind === 'tex' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      res(t);
    }, undefined, rej))).catch(() => { texCache.delete(key); return null; });
    texCache.set(key, p);
  }
  return p;
};
// the place's code, once fetched (its own data cache goes with these)
let gameroomChunk: typeof import('./gameroom.js') | null = null;
/** Let go of everything fetched and built (the tool is leaving the page): meshes and textures freed. */
export function forgetCaches() {
  for (const p of texCache.values()) void p.then(t => t?.dispose());
  for (const p of meshCache.values()) void p.then(m => m?.geo?.dispose(), () => {});
  texCache.clear(); meshCache.clear(); jsonCache.clear();
  gameroomChunk?.forget();
}
// warm the caches (e.g. the next item in a list) without drawing anything
export function prefetch(parts: DrawPart[]) {
  const game = rendering.lighting === 'game';
  for (const p of parts) { void getMesh(p.mesh).catch(() => {}); if (p.mat != null) { void getTex('tex', p.mat); if (!p.plain) void getTex('param', p.mat); if (game && p.spec) { void getTex('light', p.mat); if (p.glow) void getTex('glow', p.mat); } } }
}

// ---- the game's own lighting of a character part ----
// The game draws every worn and held part with one pixel shader family (the character materials' programs; with
// shadows and ambient occlusion off it is exactly this, and those add only their own factors): the albedo, the
// normal plane, the specular plane's mask, and the material's specular bytes as its vertex shader passes them
// (strength / 16, exponent, emissive / 128), lit by the scene's sky, ground and sun (the daylight preset, as
// pow(rgb, 2.2) x intensity) from its fixed sun direction. Besides the sun's highlight it adds a second, from the
// sky (a quarter as strong, half the exponent, around the direction halfway between the view and straight up):
// on a strong, broad material over a gold albedo (the golden Easter bunny) that is the metal sheen. No
// reflection map is involved. `light` holds the normal plane (R, G) and the specular mask (B), from the data;
// `glow`, for the few textures that have one, the emissive mask (the specular plane's green), added at the
// material's emissive strength (the scene's emissive strength is its light fade, 1 at rest).
// World directions are the game's (x east, y south, z up), which the preview's root maps to three's (x, z, y).
const DAYLIGHT = {sky: [0.8156862854957581, 0.8784313797950745, 0.9411764740943909, 1], ground: [0.4313725531101227, 0.2862745225429535, 0.15294118225574493, 1],
  sun: [1, 0.8784313797950745, 0.5647059082984924, 1.5], direction: [-32000, -31999.998046875, -45254.8359375]};
const linear = (c: number[]) => new THREE.Vector3(Math.pow(c[0], 2.2) * c[3], Math.pow(c[1], 2.2) * c[3], Math.pow(c[2], 2.2) * c[3]);

/** How the plain view is drawn (the page's Rendering settings). `game`: the game's lighting (below); `studio`: three's
 *  own lights, as before it. The sun's turn and height move the game's sun (0 and 45 degrees: where the game has it). */
export interface Rendering { lighting: 'game' | 'studio'; shadows: boolean; glow: boolean; sunTurn: number; sunHeight: number }
export const RENDERING_DEFAULTS: Rendering = {lighting: 'game', shadows: true, glow: true, sunTurn: 0, sunHeight: 45};
let rendering: Rendering = {...RENDERING_DEFAULTS};
// the uniforms every lit part shares: a setting moves them all at once
const SHARED = {gLightDir: {value: new THREE.Vector3()}, gGlowOn: {value: 1}, gShadowOn: {value: 1}};
/** The game's sun travels along this (three's world: the preview's root maps the game's (x, y, z) to (x, z, y)). */
function sunDirection(r: Rendering, out = new THREE.Vector3()) {
  const d = DAYLIGHT.direction, base = Math.atan2(d[0], d[1]);   // (the game's azimuth, in its own x, y)
  const turn = base + r.sunTurn * Math.PI / 180, h = r.sunHeight * Math.PI / 180;
  // travelling down and away from the sun: game (x, y, z) = (sin, cos) * cos(h), -sin(h), to three (x, z, y)
  return out.set(Math.sin(turn) * Math.cos(h), -Math.sin(h), Math.cos(turn) * Math.cos(h)).normalize();
}
/** The settings the next views and parts start with (before any is built: a studio view never fetches the
 *  game's lighting pictures). */
export function configureRendering(r: Rendering) { rendering = {...r}; applyShared(rendering); }
function applyShared(r: Rendering) {
  sunDirection(r, SHARED.gLightDir.value);
  SHARED.gGlowOn.value = r.glow ? 1 : 0;
  SHARED.gShadowOn.value = r.shadows ? 1 : 0;
}
applyShared(rendering);

function gameLit(mat: THREE.MeshStandardMaterial, light: THREE.Texture, spec: number[], glow: THREE.Texture | null) {
  mat.normalMap = light;   // (so three carries the mesh's tangents and the texture's coordinates: USE_TANGENT, vNormalMapUv)
  const uniforms = {gLight: {value: light}, gSpec: {value: new THREE.Vector3(spec[0] / 16, spec[1], spec[2] / 128)},
    gSky: {value: linear(DAYLIGHT.sky)}, gGround: {value: linear(DAYLIGHT.ground)}, gSun: {value: linear(DAYLIGHT.sun)}, gGlow: {value: glow}, ...SHARED};
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader: any, r: any) => {
    prev.call(mat, shader, r);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform sampler2D gLight; uniform vec3 gSpec; uniform vec3 gSky; uniform vec3 gGround; uniform vec3 gSun; uniform vec3 gLightDir; uniform float gGlowOn; uniform float gShadowOn;${glow ? ' uniform sampler2D gGlow;' : ''}`)
      // the game's one filtered comparison: its sampler compares the 2x2 nearest texels and blends the four results
      // by the position between them (a linear comparison filter), so an edge grades over a texel rather than
      // stepping. three's PCF at radius 0 makes 17 taps at one spot: a single hard comparison (the squares)
      .replace('#include <shadowmap_pars_fragment>', `#include <shadowmap_pars_fragment>
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
float gShadow2x2( sampler2D map, vec2 size, float bias, vec4 c ) {
  c.xyz /= c.w; c.z += bias;
  if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
  vec2 t = c.xy * size - 0.5, f = fract( t ), ts = 1.0 / size, b = ( floor( t ) + 0.5 ) * ts;
  return mix( mix( texture2DCompare( map, b, c.z ), texture2DCompare( map, b + vec2( ts.x, 0.0 ), c.z ), f.x ),
              mix( texture2DCompare( map, b + vec2( 0.0, ts.y ), c.z ), texture2DCompare( map, b + ts, c.z ), f.x ), f.y );
}
#endif`)
      .replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
{
  vec3 gS = texture2D( gLight, vNormalMapUv ).rgb;
  vec2 gXY = gS.xy * ( 255.0 / 127.5 ) - 1.0;
  float gZ = sqrt( max( 1.0 - dot( gXY, gXY ), 0.0 ) );
  #ifdef USE_TANGENT
    vec3 gN0 = normalize( vNormal ) * faceDirection;
    vec3 gT0 = normalize( vTangent );
    gT0 = normalize( gT0 - dot( gT0, gN0 ) * gN0 );
    vec3 gB0 = normalize( vBitangent ) * faceDirection;
    vec3 gN = normalize( gT0 * gXY.x + gB0 * gXY.y + gN0 * gZ );
  #else
    vec3 gN = normalize( tbn * vec3( gXY, gZ ) );
  #endif
  vec3 gV = normalize( vViewPosition );
  vec3 gL = normalize( ( viewMatrix * vec4( gLightDir, 0.0 ) ).xyz );
  vec3 gUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  vec3 gEast = normalize( ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
  float gs = gS.b * gSpec.x, gp = gSpec.y;
  vec3 gAmbient = ( gGround + ( gSky - gGround ) * ( dot( gN, gUp ) * 0.5 + 0.5 ) ) * ( dot( gN, gEast ) * 0.5 + 1.0 );
  float gSkySpec = gs * 0.25 * pow( max( dot( normalize( gV + gUp ), gN ), 0.0 ), gp * 0.5 );
  float gSunSpec = gs * pow( max( dot( normalize( gV - gL ), gN ), 0.0 ), gp );
  // (the game's shadowed lighting takes the sun's two terms times one filtered comparison with its shadow map; the
  // plain view's is the character's own, from the same sun)
  float gShadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    if ( receiveShadow && gShadowOn > 0.5 ) gShadow = gShadow2x2( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowBias, vDirectionalShadowCoord[ 0 ] );
  #endif
  vec3 gLit = ( gSunSpec + max( dot( gN, -gL ), 0.0 ) ) * gShadow * gSun + gAmbient + gSkySpec * gSky${glow ? ' + texture2D( gGlow, vNormalMapUv ).r * gSpec.z * gGlowOn' : ''};
  gl_FragColor.rgb = pow( max( gLit * diffuseColor.rgb, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) ) * ( 254.0 / 255.0 );
}`);
  };
  mat.customProgramCacheKey = () => `game-lit${glow ? '-glow' : ''}:${prevKey()}`;
  mat.needsUpdate = true;
}
// A book's cover with the site's mark on it (the Read animation's book is an atlas): its picture drawn four times as
// large and bound in the site's grey, the mark and the name in gold on the cover's corner of it, upright as the book is held (the picture's +u is
// the book's top, +v its right, so the drawing is turned a quarter clockwise).
const covers = new Map<string, Promise<THREE.Texture>>();
const coverMark = new Image(); coverMark.src = '/brand/mark.svg';
function covered(map: THREE.Texture, rect: number[], key: string) {
  let p = covers.get(key);
  if (!p) covers.set(key, p = (async () => {
    await Promise.all([coverMark.decode().catch(() => {}), document.fonts?.load('600 40px "BA Brighter"').catch(() => {})]);
    const src = map.image as HTMLImageElement, k = 4, W = src.width * k, H = src.height * k;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d', {willReadFrequently: true})!; g.drawImage(src, 0, 0, W, H);
    // (bound in the site's own dark grey, its raised panels' (--bg2, #1a1e26), not the game's red: the binding's reds,
    // their shading kept, the pages and the glyphs on the spine left as they are. The texture's grey is lighter: the
    // game's lighting keeps about 55% of it, measured, so the cover comes out at the site's)
    const img = g.getImageData(0, 0, W, H), d = img.data, grey = [0x30, 0x37, 0x46];
    for (let k = 0; k < d.length; k += 4) {
      const r = d[k], gr = d[k + 1], b = d[k + 2];
      if (r < 60 || r < gr * 1.25 || r < b * 1.25) continue;
      const shade = Math.min(1.6, r / 165);
      d[k] = grey[0] * shade; d[k + 1] = grey[1] * shade; d[k + 2] = grey[2] * shade;
    }
    g.putImageData(img, 0, 0);
    const [x0, y0, x1, y1] = [rect[0] * W, rect[1] * H, rect[2] * W, rect[3] * H];
    const w = y1 - y0, h = x1 - x0;   // (the cover as the drawing sees it, turned)
    // (centred across the cover, a little toward its top: the reader's thumb holds its fore edge low down)
    g.save(); g.translate((x0 + x1) / 2 + (x1 - x0) * 0.08, (y0 + y1) / 2); g.rotate(Math.PI / 2);
    const gold = '#e9d49a', size = Math.min(w * 0.42, h * 0.4), sans = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    g.shadowColor = 'rgba(40, 8, 8, .55)'; g.shadowBlur = size * 0.04; g.shadowOffsetY = size * 0.02;
    if (coverMark.naturalWidth) g.drawImage(coverMark, -size / 2, -h * 0.38, size, size);
    g.fillStyle = gold; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.font = `600 ${size * 0.34}px "BA Brighter", ${sans}`; g.fillText('Brighter', 0, -h * 0.38 + size + size * 0.36);
    g.font = `600 ${size * 0.2}px ${sans}`; (g as any).letterSpacing = `${size * 0.06}px`; g.fillText('ATLAS', 0, -h * 0.38 + size + size * 0.66);
    g.restore();
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.flipY = map.flipY;
    return t;
  })());
  return p;
}
/** A part's material: its texture, recoloured as the game does, lit as the game does where the data says how. */
async function partMaterial(p: DrawPart) {
  const game = rendering.lighting === 'game' && p.mat != null && !!p.spec;
  const [plain, param, light, glow] = await Promise.all([p.mat != null ? getTex('tex', p.mat) : null, p.mat != null && !p.plain ? getTex('param', p.mat) : null,
    game ? getTex('light', p.mat!) : null, game && p.glow ? getTex('glow', p.mat!) : null]);
  const map = plain && p.cover ? await covered(plain, p.cover, `${p.mat}/${p.cover.join(',')}`) : plain;
  if (p.mat != null && !map) throw Error(`part texture ${p.mat}: not loaded`);
  const mat = new THREE.MeshStandardMaterial({color: map ? 0xffffff : 0xb9c2cf, map: map ?? null, metalness: 0.02, roughness: 0.82, alphaTest: 0.35, side: THREE.FrontSide});   // (one side, as the game: its rasterizer culls the engine's back faces in every pass; drawn from both, a part's close inner and outer sheets fight for the same pixels and flicker as it moves)
  applyPackedRecolor(mat, param, [p.t1, p.t2]);
  if (light && p.spec) gameLit(mat, light, p.spec, glow);
  return mat;
}

// The game's animation clock: 600 ticks a second. Every time in the clips and the idle records is in ticks: a clip's
// "duration_ms" and "frame_ms" too (keys 20 ticks apart, 30 a second).
const TICKS_PER_MS = 0.6;
// The game's crossfade between the rest loop and a flourish, both ways: 150 ticks (250 ms), a linear weight.
const BLEND_TICKS = 150;

// Worn effects follow the pose drawn (the rest loop, a flourish, the blend between them, a stance): the rig's bones
// relative to the anchor, as the effects' own sampling rig gave them, once a frame. (The effects' clock stays theirs.)
class DrawnBones extends EffectBoneAnimation {
  private stamp = -1; private drawn: number[][] = []; private inv = new THREE.Matrix4(); private m = new THREE.Matrix4();
  constructor(skel: any, clip: any, tickRate: number, elapsedMs: () => number, private live: () => {rig: Rig; anchor: THREE.Object3D; frame: number} | null) {
    super(skel, clip, true, tickRate, elapsedMs);
  }
  override sample(tick: number): readonly (readonly number[])[] {
    const l = this.live();
    if (!l) return super.sample(tick);
    if (l.frame !== this.stamp) {
      l.anchor.updateMatrixWorld(true);
      this.inv.copy(l.anchor.matrixWorld).invert();
      this.drawn = l.rig.bones.map(b => this.m.multiplyMatrices(this.inv, b.matrixWorld).elements.slice());
      this.stamp = l.frame;
    }
    return this.drawn;
  }
}

// the head (the framings' close-ups aim at it when a stance moves it)
const HEAD_BONE = 6;
// In a place the character stands this far above the ground (units): a pose can carry a sole a unit or two
// below the rig's origin, which would sink it into the floor
const FOOT_LIFT = 8;
// the lens over a place drawn by the game (degrees, vertical)
const GAME_FOV = 16;

// A box's corners, and the box cut by a frustum: every face clipped by every plane (Sutherland-Hodgman), the
// vertices of the solid they share (the view is always outside the figure's box here, so no frustum corner falls
// inside it; nothing in view at all leaves the fit to the whole box).
const CORNERS = Array.from({length: 8}, () => new THREE.Vector3());
function boxCorners(b: THREE.Box3) { for (let i = 0; i < 8; i++) CORNERS[i].set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z); return CORNERS; }
const FACES = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
function clipBoxToFrustum(b: THREE.Box3, f: THREE.Frustum, out: THREE.Vector3[]): THREE.Vector3[] {
  out.length = 0;
  const c = boxCorners(b).map(v => v.clone());
  for (const face of FACES) {
    let poly = face.map(i => c[i]);
    for (const pl of f.planes) {
      const next: THREE.Vector3[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], z = poly[(i + 1) % poly.length], da = pl.distanceToPoint(a), dz = pl.distanceToPoint(z);
        if (da >= 0) next.push(a);
        if ((da >= 0) !== (dz >= 0)) next.push(a.clone().lerp(z, da / (da - dz)));
      }
      poly = next; if (!poly.length) break;
    }
    out.push(...poly);
  }
  return out;
}

// (a fixed drawing resolution, set in this browser's storage, `fashion.pixelRatio`: the test suite draws at 1, as
// its browser draws on the processor; nothing else sets it)
function fixedPixelRatio(): number | null {
  try { const v = Number(localStorage.getItem('fashion.pixelRatio')); return v > 0 && v <= 4 ? v : null; } catch { return null; }
}
export interface Framing { dist: number; target: number }
/** A figure an animation plays beside the character (Preview.setAnimActors): a rig of its own (`skel`), its parts,
 *  each of the animation's parts' clips for it, where it stands in the character's space (`at`, game units, +y
 *  ahead), its particle systems, or what is thrown (`thrown`: its release and flight in ticks, how far it goes). */
export interface AnimActor { skel: number; parts: DrawPart[]; clips: (number | null)[]; at?: number[] | null; fx?: number[];
  thrown?: {release: number; flight: number; distance: number} }
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
  private dead = false;
  private resizing = new ResizeObserver(() => this.resize());
  /** Let go: nothing more drawn, the place and the GPU context freed (the caches are forgetCaches'). */
  dispose() {
    this.dead = true; this.running = false; this.roomId = null;   // (a place on its way bails: another room is wanted)
    this.resizing.disconnect();
    if (this.game) { this.game.fxRoot.removeFromParent(); this.game.dispose(); this.game = null; }
    this.effectAnim?.dispose(); this.effectAnim = null;
    this.scene.traverse(o => { const m = (o as THREE.Mesh).material; if (m) for (const x of Array.isArray(m) ? m : [m]) x.dispose(); });
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
  // the resting clip hides held items by scaling their bones to 0.001; show them in hand instead
  showHeld = false;
  clipId: number | null = null;

  private t0 = performance.now();
  private last = performance.now();
  private parts: DrawPart[] = [];
  /** Parts drawn now (none before the first look). */
  get drawn() { return this.active.size; }
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

  /** `pixelRatio`: the view's own (a thumbnail's picture: 1, the screen's pixels and no more). */
  constructor(public canvas: HTMLCanvasElement, opts: {fov?: number, ghost?: boolean, floor?: boolean, pixelRatio?: number} = {}) {
    this.baseFov = opts.fov ?? 18;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, 1, 10, 30000);
    this.ghostCamera = new THREE.PerspectiveCamera(opts.fov ?? 18, 1, 10, 30000);
    this.ghost = !!opts.ghost;
    this.renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, preserveDrawingBuffer: true});
    // at least twice the screen's pixels (on a 1x desktop the frame, which has no antialiasing of its own, is
    // drawn at 2x and scaled down: supersampled), the phone's own 3x at most
    this.renderer.setPixelRatio(opts.pixelRatio ?? fixedPixelRatio() ?? Math.min(3, Math.max(2, devicePixelRatio)));
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
    // the game's sun, for the character's own shadow on the plain backgrounds (on itself only: the ground disc takes
    // none; a place drawn by the game casts its own) (three's light, at no intensity: the
    // game's lighting is the materials' own; this only draws the shadow map). A single filtered comparison, as the
    // game's (radius 0: every tap of three's kernel at the same place)
    const small = Math.min(screen.width, screen.height) < 700;
    this.sun.castShadow = true;
    // (the game's map is 4096 on D3D11 hardware; a phone takes half: 4096 would be 64 MB of its graphics memory; a
    // browser drawing without a graphics card a quarter: measured, its frame took 37 ms at 1024, 110 ms at 4096,
    // where an RTX 5090's took 0.50 and 0.59)
    const gl = this.renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
    const software = /swiftshader|llvmpipe|softpipe|software/i.test(String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : ''));
    const mapSize = Math.min(software ? 1024 : small ? 2048 : 4096, this.renderer.capabilities.maxTextureSize);
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    Object.assign(this.sun.shadow.camera, {left: -1400, right: 1400, top: 1400, bottom: -1400, near: 100, far: 16000});
    this.sun.shadow.bias = 0; this.sun.shadow.normalBias = 3; this.sun.shadow.radius = 0;
    this.sun.target.position.set(0, 1000, 0);
    this.scene.add(this.sun, this.sun.target);
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.setRendering(rendering);
    this.resize();
    this.resizing.observe(canvas);
    canvas.addEventListener('webglcontextlost', () => { if (!this.dead) report('webgl context lost'); });
    const loop = () => { if (this.dead) return; if (this.running) this.frame(); requestAnimationFrame(loop); };
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
  // the bones the resting clip hides (scaled to 0.001): what is held
  private held: number[] | null = null;
  private heldBones(): number[] {
    if (this.held) return this.held;
    const rest = this.restClip != null ? this.clips.get(this.restClip) : null;
    if (!rest) return [];
    return this.held = rest.bones.flatMap((b, i) => b?.scale.mode === 'const' && (b.scale as any).value[0] < 0.01 ? [i] : []);
  }
  private headRest: THREE.Vector3 | null = null;   // the aim point in the head's frame at rest
  private headAt = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private focusOff = new THREE.Vector3();

  private wantClip: number | null = null;
  /** The pose: `clip` (with `upper` over it), and whether held items show (`held`). Both change together, once the
   *  clips are in, so a weapon never shows in the old pose nor the new pose without it. */
  async setClip(i: number, upper: number | null = null, held: boolean = this.showHeld, fromStart = false, blend = true) {
    this.wantClip = i; this.wantUpper = upper; this.wantHeld = held;
    const [json, upperJson] = await Promise.all([getJson(at(`clip/${i}`)), upper != null ? getJson(at(`clip/${upper}`)) : null]);
    if (this.wantClip !== i || this.wantUpper !== upper || this.wantHeld !== held) return;
    // (a change of pose crossfades as the game's do, over BLEND_TICKS: from the pose drawn at this moment)
    // (not between the parts of one animation: they are authored to join)
    if (blend && this.rig && this.clip && (this.clipId !== i || this.upperId !== upper)) {
      const rig = this.rig, kept = rig.bones.map(b => [b.position.clone(), b.quaternion.clone(), b.scale.clone()] as const);
      this.blendFrom = {t0: this.clock, pose: () => rig.bones.forEach((b, k) => { b.position.copy(kept[k][0]); b.quaternion.copy(kept[k][1]); b.scale.copy(kept[k][2]); })};
    }
    this.showHeld = held;
    if (fromStart) this.clipT0 = this.clock;   // (an animation picked to play: from its first frame)
    let c = this.clips.get(i);
    if (!c) { c = new ClipSampler(json); this.clips.set(i, c); }
    this.clip = c; this.clipJson = json; this.clipId = i;
    this.upper = upper != null && this.upperBones ? (this.clips.get(upper) ?? this.clips.set(upper, new ClipSampler(upperJson)).get(upper)!) : null;
    this.upperId = this.upper ? upper : null;
    this.flourish = null; this.nextFlourish = 0;
    this.effectAnim?.dispose(); this.effectAnim = null;
  }
  // a stance in two clips: `clip` on the whole figure, `upper` over it on the upper body's bones (the game's two bone
  // masks: hips and legs from the stance every weapon shares, everything above from the weapon's own)
  private wantUpper: number | null = null;
  private wantHeld = false;
  // the clips' own clock: from the page's start, or from when an animation was picked to play
  private clipT0 = 0;
  /** The animations' own clock (ms): it stands still while `paused`, so the character, its effects and a place's
   *  actors freeze where they are; the camera still turns. */
  clock = 0;
  paused = false;
  /** How long the clip picked last has played (ms of the animations' clock). */
  clipElapsed() { return this.clock - this.clipT0; }
  /** Fetch clips ahead (the stances of what is worn), so a later setClip need not wait. */
  prefetchClips(ids: (number | null | undefined)[]) { for (const i of ids) if (i != null) void getJson(at(`clip/${i}`)).catch(() => {}); }
  private upper: ClipSampler | null = null;
  upperId: number | null = null;
  private upperBones: Set<number> | null = null;
  setMasks(masks: number[][] | undefined) { this.upperBones = masks?.length === 2 ? new Set(masks[1]) : null; }
  // the resting idle's flourishes: at rest, after a wait drawn evenly between the two durations of `wait` (ms), one of
  // them, each as likely, plays once from its start, then the rest loop again from a random point of its cycle
  // (never while designing or with weapons out, and not in a picture)
  private idle: {clips: number[]; wait: number[]} | null = null;
  private flourish: {c: ClipSampler; t0: number} | null = null;
  private nextFlourish = 0;
  private restShift = 0;
  private fetchingFlourish = false;
  // (each flourish's clip fetched when its turn first comes: none of them on the first visit)
  setFlourishes(clips: number[] | undefined, wait: number[] | undefined) { this.idle = clips?.length && wait?.length === 2 ? {clips, wait} : null; }
  // the game crossfades both ways, rest loop to flourish and back, over BLEND_TICKS (a linear weight), the side faded
  // from still moving
  private blendFrom: {t0: number; pose: (now: number) => void} | null = null;
  private beginFlourish(c: ClipSampler) {
    const now = this.clock, rest = this.clip, shift = this.restShift, t0 = this.clipT0, rig = this.rig;
    if (rest && rig) this.blendFrom = {t0: now, pose: (n) => rest.apply(rig, rest.duration ? ((((n - t0) * TICKS_PER_MS + shift) % rest.duration) + rest.duration) % rest.duration : 0)};
    this.flourish = {c, t0: now};
  }
  private blendPose: {p: THREE.Vector3[]; q: THREE.Quaternion[]; s: THREE.Vector3[]} | null = null;
  private keepPose(rig: Rig) {
    const n = rig.bones.length;
    if (!this.blendPose || this.blendPose.p.length !== n) this.blendPose = {p: Array.from({length: n}, () => new THREE.Vector3()), q: Array.from({length: n}, () => new THREE.Quaternion()), s: Array.from({length: n}, () => new THREE.Vector3())};
    rig.bones.forEach((b, i) => { this.blendPose!.p[i].copy(b.position); this.blendPose!.q[i].copy(b.quaternion); this.blendPose!.s[i].copy(b.scale); });
  }
  // the game's mix: rotations by nlerp (the shorter way, then normalised), positions by lerp,
  // scales by lerp only when both are above the clips' 0.002 threshold, else the near-zero one (a hidden bone snaps)
  private mixPose(rig: Rig, w: number) {
    const k = this.blendPose!;
    rig.bones.forEach((b, i) => {
      b.position.lerpVectors(k.p[i], b.position, w);
      const a = k.s[i], tiny = (v: THREE.Vector3) => Math.min(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) <= 0.002;
      if (tiny(a)) b.scale.copy(a); else if (!tiny(b.scale)) b.scale.lerpVectors(a, b.scale, w);
      const qa = k.q[i], qb = b.quaternion, sign = qa.dot(qb) < 0 ? -1 : 1;
      qb.set(qa.x * (1 - w) + qb.x * w * sign, qa.y * (1 - w) + qb.y * w * sign, qa.z * (1 - w) + qb.z * w * sign, qa.w * (1 - w) + qb.w * w * sign).normalize();
      // (the sampler composed each bone's matrix itself, automatic updates off: the mix is drawn only once composed)
      b.matrix.compose(b.position, b.quaternion, b.scale); b.matrixWorldNeedsUpdate = true;
    });
  }
  private startFlourish() {
    const cs = this.idle!.clips, i = cs[Math.floor(Math.random() * cs.length)], have = this.clips.get(i);
    if (have) { this.beginFlourish(have); return; }
    if (this.fetchingFlourish) return;
    this.fetchingFlourish = true;
    void getJson(at(`clip/${i}`)).then((json) => {
      this.clips.set(i, new ClipSampler(json));
      // (played once it is in, if still at rest; else at the next turn)
      if (this.nextFlourish === -1) { this.beginFlourish(this.clips.get(i)!); this.nextFlourish = 0; }
    }).catch(() => { if (this.nextFlourish === -1) this.nextFlourish = 0; }).finally(() => { this.fetchingFlourish = false; });
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

  private applyRounds = 0;
  async apply(parts: DrawPart[]) {
    if (parts !== this.parts) this.applyRounds = 0;
    this.parts = parts;
    if (!this.rig) return;
    const gen = ++this.gen;
    const wanted = new Map(parts.map(p => [p.key, p]));
    const missing = parts.filter(p => !this.active.has(p.key));
    this.loadingParts = missing.length; this.onLoading(missing.length);
    const built = await Promise.all(missing.map(p => this.build(p).catch(e => { console.warn('part', p, e); return null; })));
    if (gen !== this.gen) { for (const m of built) if (m) (m.material as THREE.Material).dispose(); return; }
    // (nothing swaps in half: while a new part could not be built, the outfit drawn stays and the loader with it, and
    // the build is tried again; after three rounds what did build is shown, as a broken file would never come)
    if (built.some(m => !m) && this.applyRounds < 3) {
      for (const m of built) if (m) (m.material as THREE.Material).dispose();
      this.applyRounds++;
      setTimeout(() => { if (gen === this.gen) void this.apply(this.parts); }, 1500);
      return;
    }
    this.applyRounds = 0;
    this.holdingProps = parts.some(p => /\/prop\d+(-cover)?$/.test(p.key));
    for (const [key, m] of this.active) if (!wanted.has(key)) { this.root.remove(m); (m.material as THREE.Material).dispose(); this.active.delete(key); }
    missing.forEach((p, i) => { const m = built[i]; if (m) { this.root.add(m); this.active.set(p.key, m); } });
    this.syncLights();
    parts.forEach((p, i) => { const m = this.active.get(p.key); if (m) m.renderOrder = i; });
    if (this.game) await this.game.setActors(this.gameParts(this.propsShown), this.rig).catch(e => console.warn('game actors', e));
    this.loadingParts = 0; this.onLoading(0);
  }
  /** The look drawn holds an animation's props (their bones are the clip's to show and hide). */
  private holdingProps = false;
  /** The clips an animation's props show in: until one plays they are hidden and the weapons stay in hand (then
   *  the other way round), so nothing it holds is seen on the pose before it. */
  propClips: Set<number> | null = null;
  private propsShown = false;
  // (the game's frame draws the parts it is given: the props or the weapons, as the plain view shows them)
  private gameParts(propsOn: boolean) {
    return this.parts.filter(p => /\/prop\d+(-cover)?$/.test(p.key) ? propsOn : !(propsOn && /\/h\d+$/.test(p.key)));
  }
  /** Parts of the look asked for last still to be drawn (0: the look is all in). */
  loadingParts = 0;

  private async build(p: DrawPart) {
    const [{geo, skinned}, mat] = await Promise.all([getMesh(p.mesh), partMaterial(p)]);
    // (its shadow: cut out where the texture is, as the part is)
    const depth = new THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking, map: mat.map, alphaTest: 0.35, side: THREE.FrontSide});
    mat.addEventListener('dispose', () => depth.dispose());
    // skin in the rig frame, then apply the part's own world (the root's basis) once
    const mesh = skinned ? new PartSkinnedMesh(geo, mat, this.anchor) : new THREE.Mesh(geo, mat);
    if (skinned) (mesh as any).bind(this.rig!.skeleton, new THREE.Matrix4());
    mesh.frustumCulled = false;
    mesh.userData.part = p;
    mesh.customDepthMaterial = depth;
    mesh.onAfterRender = () => { mesh.userData.drawn = true; };
    // (the shadow map from the same faces, with no depth bias, as the game: acne is left to the receiver's offset
    // along its normal)
    mat.shadowSide = THREE.FrontSide;
    mesh.castShadow = mesh.receiveShadow = this.shadowsOn();
    return mesh;
  }

  // Show exactly these effect systems (by id); others stop. Their bones follow the playing clip.
  /** The particle player, its systems (effects.json) fetched the first time any is wanted. */
  private async effectsPlayer(): Promise<EffectsPlayer | null> {
    if (!this.effects) {
      const doc = await getJson(at('effects.json')).catch(() => null);
      if (!doc || !this.rig || this.effects) return this.effects;
      this.effects = new EffectsPlayer({root: this.effectsRoot, doc, url: at,
        rig: {id: this.rig.skelIndex, bones: this.rig.boneInverses.map(m => m.clone().invert().elements)}});
    }
    return this.effects;
  }
  async setEffects(slots: number[]) {
    const want = new Set(slots);
    if (want.size) await this.effectsPlayer();
    if (!this.effects) return;
    for (const s of want) if (this.effectSlots.has(s) && !this.wantEffects.has(s)) this.effects.play(s);   // back on: restart it
    for (const s of want) if (!this.effectSlots.has(s)) {
      const sys = this.effects.doc.systems.find((x: any) => x.slot === s);
      if (sys) sys.triggered = false;   // the game loops it while the item is worn
      if (this.effects.addSystem(s)) this.effectSlots.add(s);
    }
    for (const s of [...this.effectSlots]) if (!want.has(s) && !this.animFx?.slots.some(a => a.slot === s) && !this.fading.some(f => f.slot === s)) this.dropSystem(s);
    this.wantEffects = want;
    this.effectsOn();
  }
  private effectsOn() {
    const on = this.wantEffects.size > 0 || !!this.animFx || this.fading.length > 0;
    this.effectsRoot.visible = on;
    this.effects?.setRunning(on);
  }
  // An animation's own particle effects (the systems its controller names): their clock is the animation's (ticks
  // since it began, plus where a loop clip starts within its controller), so they pause and repeat with it. When it
  // ends, or another takes its place, the game releases them: nothing new is born, and what is out lives its life
  // (`fading`, each on its own clock from where it was let go). Asked for again, a system's clock starts over with
  // its new animation, as does a loop's each time round, while the particles already out run on: they live on the
  // system's own clock, the controller's only opening its windows. Here a copy of the system takes those over
  // (`passOn`, a key of its own), released.
  private animFx: {slots: {slot: number, offset: number}[], t0: number, loop: number | null, last: number} | null = null;
  private fading: {slot: number, offset: number, endT: number, at: number}[] = [];
  private copies = -1;
  // A system no longer played leaves the player: the particle budget is shared among the systems it holds (thinning
  // them all past it), so one kept after it is done would take its share from every effect played after (fifteen
  // animations' effects left Teleport an eighth of its particles). Asked for again, it is added afresh.
  private dropSystem(slot: number) {
    this.effects?.removeSystem(slot);
    this.effectSlots.delete(slot);
  }
  /** The live particles of `slot`, at animation tick `t`, on to a released copy of their system. */
  private passOn(e: EffectsPlayer, slot: number, offset: number, t: number) {
    if (!e.liveCount(slot)) return;
    const key = this.copies--;
    if (!e.addSystem(slot, key)) return;
    e.setAnimation(key, this.effectAnim);
    e.syncClock(key, (t + offset) * e.clock.tickRate / 600);
    e.release(key);
    this.fading.push({slot: key, offset, endT: t, at: this.clock});
  }
  async setAnimEffects(fx: {system: number, offset?: number}[] | null, loop = false) {
    const e = fx?.length ? await this.effectsPlayer() : this.effects;
    if (this.animFx && e) {
      const t = this.animTick(this.animFx);
      for (const s of this.animFx.slots) {
        if (fx?.some(f => f.system === s.slot)) this.passOn(e, s.slot, s.offset, t);   // (asked for again: starts over)
        else { e.release(s.slot); this.fading.push({slot: s.slot, offset: s.offset, endT: t, at: this.clock}); }
      }
    }
    this.animFx = null;
    if (!fx?.length || !e) { this.effectsOn(); return; }
    for (const f of fx) if (!this.effectSlots.has(f.system)) {
      const sys = e.doc.systems.find((x: any) => x.slot === f.system); if (!sys) continue;
      // (driven by the animation, never looping on its own: its windows open once each time round the controller's
      // clock, which the animation restarts; a loop period of the system's own would fire its bursts again)
      sys.triggered = true; sys.loop = false;
      if (e.addSystem(f.system)) this.effectSlots.add(f.system);
    }
    const slots = fx.filter(f => this.effectSlots.has(f.system)).map(f => ({slot: f.system, offset: f.offset ?? 0}));
    for (const s of slots) {
      // (a released one still out: its particles go on as a copy, the system itself starts over)
      const was = this.fading.find(f => f.slot === s.slot);
      if (was) { this.fading = this.fading.filter(f => f !== was); this.passOn(e, s.slot, was.offset, was.endT + (this.clock - was.at) * TICKS_PER_MS); }
      e.release(s.slot, false);
    }
    this.animFx = {slots, t0: this.clipT0, loop: loop && this.clip?.duration ? this.clip.duration : null, last: 0};
    // (on its new clock at once: not a frame drawn beside its copy)
    const t = this.animTick(this.animFx);
    for (const s of slots) e.syncClock(s.slot, (t + s.offset) * e.clock.tickRate / 600);
    this.effectsOn();
  }
  private animTick(a: NonNullable<typeof this.animFx>) {
    const t = (this.clock - a.t0) * TICKS_PER_MS;
    return a.loop ? t % a.loop : t;
  }
  private wantEffects = new Set<number>();

  // ---- an animation's other figures: what the game plays beside the character on a rig of its own (a fishing rod,
  // the rift a deposit opens one tile ahead), each part's clip with the character's, and what is thrown (a snowball,
  // the throw's own pose kept from its release and carried ahead). Their particle effects play where they stand. ----
  private actors: {frame: THREE.Group, rig: Rig, meshes: THREE.Mesh[], clips: (ClipSampler | null)[], partClips: number[], at: number[],
    thrown: AnimActor['thrown'] | null, effects: EffectsPlayer | null, fx: number[], t0: number}[] = [];
  private actorsGen = 0;
  async setAnimActors(list: AnimActor[] | null, partClips: number[]) {
    const gen = ++this.actorsGen;
    for (const a of this.actors) { this.anchor.remove(a.frame); for (const m of a.meshes) { this.root.remove(m); (m.material as THREE.Material).dispose(); } a.effects?.dispose(); }
    this.actors = [];
    if (!list?.length || !this.rig) return;
    const t0 = NaN;   // (set as its first clip starts: poseActors)
    const doc = list.some(a => a.fx?.length) ? await getJson(at('effects.json')).catch(() => null) : null;
    const built = await Promise.all(list.map(async a => {
      const rig = new Rig(await getJson(at(`skel/${a.skel}`)));
      const frame = new THREE.Group(); frame.add(...rig.roots);
      const clips = await Promise.all(a.clips.map(async c => c == null ? null : this.clips.get(c) ?? this.clips.set(c, new ClipSampler(await getJson(at(`clip/${c}`)))).get(c)!));
      const meshes = await Promise.all(a.parts.map(async p => {
        const [{geo, skinned}, mat] = await Promise.all([getMesh(p.mesh), partMaterial(p)]);
        // (skinned in the character's frame, as its own parts: the figure's place is its bones', moved with its frame)
        const m = skinned ? new PartSkinnedMesh(geo, mat, this.anchor) : new THREE.Mesh(geo, mat);
        if (skinned) (m as any).bind(rig.skeleton, new THREE.Matrix4());
        m.frustumCulled = false; m.castShadow = true;
        return m;
      }));
      // (its effects where it stands: a player of their own, in the character's space, moved to its place)
      let effects: EffectsPlayer | null = null;
      if (doc && a.fx?.length) {
        const root = new THREE.Group(); root.position.fromArray(a.at ?? [0, 0, 0]); this.root.add(root);
        effects = new EffectsPlayer({root, doc, url: at});
        for (const sys of a.fx) { const d = doc.systems.find((x: any) => x.slot === sys); if (d) { d.triggered = true; d.loop = false; } effects.addSystem(sys); }
        const dispose = effects.dispose.bind(effects); effects.dispose = () => { dispose(); this.root.remove(root); };
      }
      return {frame, rig, meshes, clips, partClips, at: a.at ?? [0, 0, 0], thrown: a.thrown ?? null, effects, fx: a.fx ?? [], t0};
    }));
    if (gen !== this.actorsGen) { for (const a of built) { for (const m of a.meshes) (m.material as THREE.Material).dispose(); a.effects?.dispose(); } return; }
    for (const a of built) { this.anchor.add(a.frame); for (const m of a.meshes) this.root.add(m); }
    this.actors = built;
  }
  private poseActors(t: number) {
    for (const a of this.actors) {
      const i = a.partClips.indexOf(this.clipId ?? -1), c = i >= 0 ? a.clips[i] : null;
      if (a.thrown) {
        // (thrown: hidden till its release, then the throw's own pose at the release, carried ahead along a straight
        // line over its flight, as the game moves a projectile)
        const k = (t - a.thrown.release) / a.thrown.flight, on = i >= 0 && k >= 0 && k <= 1;
        for (const m of a.meshes) m.visible = on;
        // (its pose the last tick the hand still shows it: the clip puts it away over the ticks of the release)
        if (on && c) c.apply(a.rig, Math.min(Math.max(0, a.thrown.release - 10), c.duration));
        a.frame.position.set(0, on ? a.thrown.distance * k : 0, 0);
      } else {
        a.frame.position.fromArray(a.at);
        for (const m of a.meshes) m.visible = i >= 0;
        if (c) c.apply(a.rig, c.duration ? Math.min(t, c.duration) : 0);
      }
      // (their effects' clock: from the animation's first frame, each time it starts again)
      if (i === 0 && a.t0 !== this.clipT0) a.t0 = this.clipT0;
      if (a.effects && i >= 0) {
        const ticks = (this.clock - a.t0) * TICKS_PER_MS;
        for (const sys of a.fx) a.effects.syncClock(sys, ticks * a.effects.clock.tickRate / 600, this.camera);
      }
    }
  }

  // ---- a room behind the character (a game place as the backdrop) ----
  private roomGroup = new THREE.Group();
  private floorGroup: THREE.Object3D | null = null;
  private sun = new THREE.DirectionalLight(0xffffff, 0);
  /** Draw the plain view as `r` says (the page's Rendering settings): the sun moves, glow and shadows switch at once;
   *  the lighting itself (the game's or three's) builds every part again, the old ones shown until the new are ready. */
  setRendering(r: Rendering) {
    const relight = r.lighting !== rendering.lighting;
    rendering = {...r}; applyShared(rendering);
    this.sun.position.copy(this.sun.target.position).addScaledVector(sunDirection(rendering), -8000);
    this.syncShadows();
    if (relight && this.rig) void this.rebuildAll();
  }
  /** The character designer shows this view: no shadows (hair and hoods would shade the face being designed). */
  private designing = false;
  setDesigning(on: boolean) { this.designing = on; this.syncShadows(); }
  private shadowsOn() { return rendering.lighting === 'game' && rendering.shadows && !this.roomPlace && !this.designing; }
  private syncShadows() {
    const on = this.shadowsOn();
    if (this.renderer.shadowMap.enabled !== on) for (const m of this.active.values()) (m.material as THREE.Material).needsUpdate = true;
    // (the sun is there only for its shadow map: a light three counts costs every part's shader, even at no intensity)
    this.renderer.shadowMap.enabled = on; this.sun.castShadow = this.sun.visible = on;
    for (const m of this.active.values()) m.castShadow = m.receiveShadow = on;
    this.syncLights();
  }
  /** three's own lights only where a part uses them: the studio lighting, a part the game's could not light (its
   *  pictures failed), a place (its effects). Parts lit the game's way work them out and throw them away. */
  private syncLights() {
    const needed = rendering.lighting === 'studio' || !!this.roomPlace
      || [...this.active.values()].some(m => !String((m.material as any).customProgramCacheKey?.() ?? '').startsWith('game-lit'));
    if (this.lights.visible !== needed) { this.lights.visible = needed; for (const m of this.active.values()) (m.material as THREE.Material).needsUpdate = true; }
  }
  /** Every part built again (the lighting changed); the old ones stay until the new are ready. */
  private async rebuildAll() {
    const parts = this.parts, gen = ++this.gen;
    const built = await Promise.all(parts.map(p => this.build(p).catch(e => { console.warn('part', p, e); return null; })));
    if (gen !== this.gen) { for (const m of built) if (m) (m.material as THREE.Material).dispose(); return; }
    for (const m of this.active.values()) { this.root.remove(m); (m.material as THREE.Material).dispose(); }
    this.active.clear();
    parts.forEach((p, i) => { const m = built[i]; if (m) { m.renderOrder = i; this.root.add(m); this.active.set(p.key, m); } });
    this.syncLights();
  }
  // the disc under the character: 'ring' (shadow and ring), 'shadow', or 'none'
  floorMode: 'ring' | 'shadow' | 'none' = 'shadow';
  setFloor(mode: 'ring' | 'shadow' | 'none') { this.floorMode = mode; this.showFloor(); }
  private showFloor() {
    if (!this.floorGroup) return;
    // (never in a place: its floor takes the figure's own shadow)
    this.floorGroup.visible = this.floorMode !== 'none' && !this.roomPlace;
    this.floorGroup.children[1].visible = this.floorMode === 'ring';
    this.syncShadows();
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
      const chunk = await import('./gameroom.js').catch(e => {
        let again = false;
        try { again = !sessionStorage.getItem('fashion.reloaded'); sessionStorage.setItem('fashion.reloaded', '1'); } catch {}
        if (again) location.reload();
        throw e;
      });
      gameroomChunk = chunk;
      const {GameRoom} = chunk;
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
  private frameNo = 0;

  frame() {
    const real = performance.now(), dt = Math.min(0.1, (real - this.last) / 1000);
    if (!this.paused) this.clock += real - this.last;
    this.last = real;
    const now = this.clock;
    const t = (now - this.clipT0) * TICKS_PER_MS;   // (ticks)
    this.frameNo++;
    // (an animation's props: shown, and the weapons hidden, only while one of its clips plays)
    const propsOn = this.holdingProps && !!this.propClips?.has(this.clipId ?? -1);
    if (this.holdingProps || this.propsShown) {
      for (const [key, m] of this.active) if (/\/prop\d+(-cover)?$/.test(key)) m.visible = propsOn; else if (/\/h\d+$/.test(key)) m.visible = !propsOn;
      if (propsOn !== this.propsShown && this.game && this.rig) void this.game.setActors(this.gameParts(propsOn), this.rig).catch(e => console.warn('game actors', e));
      this.propsShown = propsOn;
    }
    if (this.rig && this.clip) {
      // (a flourish, at rest: started after its wait, played once, then the rest loop again)
      const resting = !!this.idle && this.clipId === this.restClip && !this.designing && !this.showHeld;
      if (!resting) { this.flourish = null; this.nextFlourish = 0; }
      else if (!this.flourish) {
        // (the game's wait: a whole number of ticks uniform between the set's two durations, whichever order they are
        // stored in (4800 to 12000: 8 to 20 s), counted from the hand back)
        if (!this.nextFlourish) { const [a, b] = this.idle!.wait, lo = Math.min(a, b), hi = Math.max(a, b); this.nextFlourish = now + (lo + Math.floor(Math.random() * (hi - lo + 1))) / TICKS_PER_MS; }
        else if (this.nextFlourish > 0 && now >= this.nextFlourish) { this.nextFlourish = -1; this.startFlourish(); if (this.flourish) this.nextFlourish = 0; }
      }
      // (the hand back: once a flourish has BLEND_TICKS or less to play, the rest loop starts again at a random whole
      // tick of its cycle and fades in over the flourish's last ticks, the flourish still playing under it)
      if (this.flourish && (now - this.flourish.t0) * TICKS_PER_MS >= this.flourish.c.duration - BLEND_TICKS) {
        const f = this.flourish, rig = this.rig;
        this.blendFrom = {t0: now, pose: (n) => f.c.apply(rig, (n - f.t0) * TICKS_PER_MS)};
        this.flourish = null;
        if (this.clip.duration) this.restShift = Math.floor(Math.random() * this.clip.duration) - t;
      }
      const blendT = this.blendFrom ? (now - this.blendFrom.t0) * TICKS_PER_MS : Infinity;
      const from = blendT < BLEND_TICKS ? this.blendFrom : null;
      if (!from) this.blendFrom = null;
      else { from.pose(now); this.keepPose(this.rig); }
      if (this.flourish) this.flourish.c.apply(this.rig, (now - this.flourish.t0) * TICKS_PER_MS);
      else this.clip.apply(this.rig, !this.clip.duration ? 0 : (((t + (resting ? this.restShift : 0)) % this.clip.duration) + this.clip.duration) % this.clip.duration);
      if (from) this.mixPose(this.rig, blendT / BLEND_TICKS);
      if (this.upper && !this.flourish) this.upper.apply(this.rig, this.upper.duration ? t % this.upper.duration : 0, this.upperBones);
      // a clip that hides the held bones (the resting clip scales them to 0.001) shows them at rest instead
      if (this.showHeld) this.clip.bones.forEach((b, i) => {
        if (b?.scale.mode === 'const' && (b.scale as any).value[0] < 0.01) this.rig!.resetBoneToRest(i);
      });
      // and with weapons away nothing is in hand, whatever plays: the held bones go as the resting clip puts them away;
      // but for an animation's props, which its clip shows and hides itself on those bones (the weapons are out of the
      // look meanwhile)
      else if (!propsOn) for (const i of this.heldBones()) {
        const b = this.rig.bones[i]; if (!b) continue;
        b.scale.setScalar(0.001); b.matrix.compose(b.position, b.quaternion, b.scale); b.matrixWorldNeedsUpdate = true;
      }
      if (this.actors.length) this.poseActors(t);
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
    this.tickEffects(this.paused ? 0 : dt * 1000);
    const r = this.renderer;
    if (this.game && this.roomPlace && this.rig) { this.gameFrame(this.paused ? 0 : dt * 1000, f); return; }
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
    if (this.sun.castShadow) this.fitShadow();
    r.render(this.scene, this.camera);
  }

  // The shadow map fitted as the game fits its own (docs: the frame's shadow pass): to the part of the scene the
  // camera sees, here the character's bounds (the scene the plain view draws) cut by the view's frustum, in the
  // sun's frame, with a texel of border; depth from the sun to the far side of the whole figure, so a part outside
  // the view (a hat's brim above the frame) still casts. Close up, the same map covers only what shows: finer.
  private fitBox = new THREE.Box3(); private fitFrustum = new THREE.Frustum(); private fitM = new THREE.Matrix4();
  private fitPts: THREE.Vector3[] = []; private fitTmp = new THREE.Vector3(); private fitPart = new THREE.Box3(); private fitCount = 0; private fitted = new WeakSet<THREE.Object3D>(); private lastFit = new THREE.Box3();
  private fitShadow() {
    // (a skinned part's bounds come from its skinning, in the rig's frame (the game's axes); its own transform, the
    // root's turn to the scene's, takes them to the scene. Worked out again every 30 frames, as a stance moves the
    // parts)
    const box = this.fitBox.makeEmpty(), again = (this.fitCount = (this.fitCount + 1) % 30) === 0;
    for (const m of this.active.values()) {
      if (!m.visible) continue;
      // (a part just swapped in is skinned for the first time when it is first drawn: until then the previous fit's
      // bounds stand in for it, then its own are worked out at once; its bounds from before that are in another
      // frame and pointed the shadow map at the wrong place for half a second)
      m.updateWorldMatrix(true, false);
      const sk = m as unknown as THREE.SkinnedMesh;
      if (sk.isSkinnedMesh && !m.userData.drawn) { if (!this.lastFit.isEmpty()) box.union(this.lastFit); continue; }
      if (sk.isSkinnedMesh) { if (!this.fitted.has(sk) || again) { sk.computeBoundingBox(); this.fitted.add(sk); } box.union(this.fitPart.copy(sk.boundingBox!).applyMatrix4(m.matrixWorld)); }
      else { if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); box.union(this.fitPart.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld)); }
    }
    if (box.isEmpty()) return;
    this.lastFit.copy(box);
    box.expandByScalar(Math.max(40, box.getSize(this.fitTmp).y * 0.06));   // (a pose moves parts past their resting bounds)
    this.camera.updateMatrixWorld();
    this.fitFrustum.setFromProjectionMatrix(this.fitM.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const pts = clipBoxToFrustum(box, this.fitFrustum, this.fitPts);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    this.sun.position.copy(this.sun.target.position).addScaledVector(sunDirection(rendering), -8000);
    this.sun.updateMatrixWorld(); this.sun.target.updateMatrixWorld();
    sc.position.copy(this.sun.position); sc.lookAt(this.sun.target.position); sc.updateMatrixWorld();
    const toLight = this.fitM.copy(sc.matrixWorldInverse);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of pts.length ? pts : boxCorners(box)) { const q = this.fitTmp.copy(p).applyMatrix4(toLight); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    for (const p of boxCorners(box)) { const q = this.fitTmp.copy(p).applyMatrix4(toLight); z0 = Math.min(z0, -q.z); z1 = Math.max(z1, -q.z); }
    // (held still between frames: a texel's size in steps of an eighth of an octave and the map's corner on whole
    // texels, so the bounds changing as the figure breathes, or a few pixels of turn, never slide the texel grid
    // across the figure: a slid grid moves every shadow edge's steps, which reads as flicker)
    const size = this.sun.shadow.mapSize.x;
    const axis = (lo: number, hi: number) => {
      const texel = Math.pow(2, Math.ceil(Math.log2(Math.max(hi - lo, 1) / (size - 2)) * 8) / 8), c = Math.round((lo + hi) / 2 / texel) * texel;
      return [c - texel * size / 2, c + texel * size / 2];
    };
    [sc.left, sc.right] = axis(x0, x1); [sc.bottom, sc.top] = axis(y0, y1);
    sc.near = Math.max(1, Math.floor((z0 - 50) / 64) * 64); sc.far = Math.ceil((z1 + 50) / 64) * 64;
    sc.updateProjectionMatrix();
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
    // the frame drew the character: three draws only what the frame does not (each part's own visibility back after:
    // an animation's props, or the weapons they stand in for, are hidden in turn)
    const shown = [...this.active.values()].map(m => m.visible);
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
    [...this.active.values()].forEach((m, i) => { m.visible = shown[i] ?? true; });
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
    if (!this.effects || (!this.wantEffects.size && !this.animFx && !this.fading.length)) return;
    if (!this.effectAnim && this.skelJson && this.clipJson) this.effectAnim = new DrawnBones(this.skelJson, this.clipJson, this.effects.clock.tickRate, () => this.clock,
      () => this.rig ? {rig: this.rig, anchor: this.anchor, frame: this.frameNo} : null);
    for (const s of this.wantEffects) this.effects.setAnimation(s, this.effectAnim);
    const a = this.animFx, rate = this.effects.clock.tickRate / 600;
    if (a) {
      const t = this.animTick(a);
      // (round again: what is out goes on, the system starts over)
      if (a.loop && t < a.last) for (const s of a.slots) this.passOn(this.effects, s.slot, s.offset, t + a.loop);
      a.last = t;
      for (const s of a.slots) { this.effects.setAnimation(s.slot, this.effectAnim); this.effects.syncClock(s.slot, (t + s.offset) * rate); }
    }
    if (this.fading.length) {
      for (const f of this.fading) { this.effects.setAnimation(f.slot, this.effectAnim); this.effects.syncClock(f.slot, (f.endT + (this.clock - f.at) * TICKS_PER_MS + f.offset) * rate); }
      // (gone: once its last particle is, and at least a second on)
      const gone = this.fading.filter(f => this.clock - f.at > 1000 && !this.effects!.liveCount(f.slot));
      if (gone.length) {
        this.fading = this.fading.filter(f => !gone.includes(f));
        for (const f of gone) if (this.wantEffects.has(f.slot)) this.effects.play(f.slot); else if (!this.animFx?.slots.some(a => a.slot === f.slot)) this.dropSystem(f.slot);
        this.effectsOn();
      }
    }
    this.effects.tick(dtMs, this.camera);
  }

  // a picture at least `minHeight` pixels tall, whatever the canvas's size on screen
  /** The look as its link's preview picture draws it (the ?picture page): `w` x `h`, the camera at `yaw` and
   *  `framing`, the floor's shadow alone, no place behind and no flourish; the live view is left as it was. A PNG
   *  data URL (transparent where nothing is drawn). */
  picture(w: number, h: number, framing: Framing, yaw: number): string {
    const fg = this.floorGroup, r = this.renderer;
    const was = {yaw: this.yaw, yawVel: this.yawVel, yawGoal: this.yawGoal, dist: this.dist, target: this.target, want: this.want, focusOff: this.focusOff.clone(),
      flourish: this.flourish, blendFrom: this.blendFrom, room: this.roomPlace, roomVis: this.roomGroup.visible, fog: this.scene.fog, floor: fg?.visible, ring: fg?.children[1].visible,
      wide: this.wide, fov: this.camera.fov, near: this.camera.near, far: this.camera.far, pr: r.getPixelRatio(), ghost: this.ghost, paused: this.paused};
    try {
      this.yaw = yaw; this.yawVel = 0; this.yawGoal = null; this.want = {...framing}; this.dist = framing.dist; this.target = framing.target;
      this.flourish = null; this.blendFrom = null; this.ghost = false; this.paused = true;   // (the pose of this moment)
      if (this.roomPlace) { this.roomPlace = null; this.roomGroup.visible = false; this.scene.fog = null; this.setWide(false); }
      if (fg) { fg.visible = true; fg.children[1].visible = false; }
      r.setPixelRatio(1); r.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      // (a few frames, so the close framing's follow of the head settles where the picture page's has)
      for (let i = 0; i < 12; i++) { this.last = performance.now() - 100; this.frame(); }
      return this.canvas.toDataURL('image/png');
    } finally {
      Object.assign(this, {yaw: was.yaw, yawVel: was.yawVel, yawGoal: was.yawGoal, dist: was.dist, target: was.target, want: was.want, flourish: was.flourish, blendFrom: was.blendFrom, ghost: was.ghost, paused: was.paused});
      this.focusOff.copy(was.focusOff);
      if (was.room) { this.roomPlace = was.room; this.roomGroup.visible = was.roomVis; this.scene.fog = was.fog; this.wide = was.wide; Object.assign(this.camera, {fov: was.fov, near: was.near, far: was.far}); }
      if (fg) { fg.visible = !!was.floor; fg.children[1].visible = !!was.ring; }
      r.setPixelRatio(was.pr); this.resize(); this.last = performance.now();
    }
  }
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
  /** Let go: its GPU context freed. */
  dispose() { this.cache.clear(); this.renderer.dispose(); this.renderer.forceContextLoss(); }
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
      const [{geo, skinned}, mat] = await Promise.all([getMesh(p.mesh), partMaterial(p)]);
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
