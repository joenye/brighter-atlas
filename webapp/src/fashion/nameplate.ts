// The nameplate: the label the game draws over a player's head, drawn over the view as the game draws it.
// Up to three lines, centred over the head, bottom to top: the faction's emblem and the combat level in the
// faction's colour (with a guild or lone-wolf badge after it), the name (a free account's number after it in grey),
// and a laurel wreath. Set in the game's own font (a sheet of distance-field glyphs, outlined in black), its
// pictures the game's own, from Fashion's data (nameplate.json and nameplate.png). Like the game's, it keeps one
// size on screen whatever the distance, a little larger as the view closes in; here sized against the view so it
// stands over the character as it does in the game at its usual distance.
import * as THREE from '../../vendor/three.module.js';
import {at} from './data.js';

export type PlateFaction = 'none' | 'cryoknight' | 'guardian' | 'hammermage';
export type PlateGuild = 'none' | 'guild' | 'wolf';
/** The nameplate as Settings sets it (kept on this device, not part of the look). */
export interface Nameplate { on: boolean; name: string; faction: PlateFaction; level: number; tag: number | null; wreath: boolean; guild: PlateGuild }
export const NAMEPLATE_DEFAULTS: Nameplate = {on: false, name: 'Adventurer', faction: 'none', level: 3, tag: null, wreath: false, guild: 'none'};
export const PLATE_FACTIONS: [PlateFaction, string][] = [['none', 'None'], ['cryoknight', 'Cryoknight'], ['guardian', 'Guardian'], ['hammermage', 'Hammermage']];
export const PLATE_GUILDS: [PlateGuild, string, string][] = [['none', 'None', 'No guild badge'], ['guild', 'Guild', 'The guild member’s shield'], ['wolf', 'Lone wolf', 'The lone wolf’s badge']];
export const NAME_MAX = 20, LEVEL_MAX = 9999, TAG_MAX = 9999;
/** A name as the label can set it: the printable characters of the game's font, at most NAME_MAX. */
export const plateName = (s: string) => s.replace(/[^\x20-\x7e]/g, '').slice(0, NAME_MAX);
/** The setting from what was kept (or a link's), every field checked: the defaults where one is wrong. */
export function readNameplate(v: any): Nameplate {
  const d = NAMEPLATE_DEFAULTS, int = (x: any, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x <= hi ? x : null;
  if (!v || typeof v !== 'object') return {...d};
  return {on: v.on === true, name: typeof v.name === 'string' ? plateName(v.name) : d.name,
    faction: PLATE_FACTIONS.some(([k]) => k === v.faction) ? v.faction : d.faction, level: int(v.level, 0, LEVEL_MAX) ?? d.level,
    tag: int(v.tag, 1, TAG_MAX), wreath: v.wreath === true, guild: PLATE_GUILDS.some(([k]) => k === v.guild) ? v.guild : d.guild};
}

// ---- the game's layout, in its interface pixels (a label unit) ----
const NAME = [0.8784, 0.8784, 0.8784], NUMBER = [0.5765, 0.5765, 0.5765], WHITE = [1, 1, 1];
// (each line: its font size, its lettering's weight and the gap to its outline)
const LINE = {wreath: {size: 16, weight: 0.55, spacing: 0.25}, name: {size: 12, weight: 0.55, spacing: 0.25}, level: {size: 11, weight: 0.6, spacing: 0.4}};
/** The label's height over the head, in label units: the gap under it, its lines, a little room above. */
export const plateUnits = (p: Nameplate) => 10 + (p.wreath ? 18 : 0) + 27 + 6;

interface Glyph { ch?: string; icon?: string; m: number[]; r?: [number, number, number, number]; em?: number; color?: boolean }
interface PlateData { ascent: number; descent: number; sheet: [number, number]; glyphs: Glyph[]; factions: Record<string, {colour: number[]}> }
let loading: Promise<{doc: PlateData, tex: THREE.Texture}> | null = null;
function loadPlate() {
  return loading ??= (async () => {
    const [doc, pic] = await Promise.all([fetch(at('nameplate.json')).then(r => { if (!r.ok) throw Error(`nameplate data ${r.status}`); return r.json(); }),
      // (the pictures' colour kept where they are see-through: no premultiplying, no colour conversion)
      fetch(at('nameplate.png')).then(r => { if (!r.ok) throw Error(`nameplate sheet ${r.status}`); return r.blob(); }).then(b => createImageBitmap(b, {premultiplyAlpha: 'none', colorSpaceConversion: 'none'}))]);
    const tex = new THREE.Texture(pic as any);
    tex.flipY = false; tex.colorSpace = THREE.NoColorSpace; tex.premultiplyAlpha = false;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return {doc: doc as PlateData, tex};
  })().catch(e => { loading = null; throw e; });
}

// The outlined lettering's four edges for a font drawn `screenSize` pixels high (the map labels' painter, with the
// nameplate's weights): the letter's edge (high, low), then its outline's (high, low), in the distance field's values.
function outlineEdges(screenSize: number, weight: number, spacing: number) {
  const f = Math.fround, s = f(Math.max(1e-3, screenSize));
  let a = f(5 / s), d = f(4 / s);
  const b = f(4 / s), c = f(3 / s);
  const base = Math.min(f(f(f(f(weight) + f(-.5)) + f(64 / 255)) - a), 1);
  const high = f(1 - base), gap = Math.min(f(f(f(spacing) - b) - c), high);
  a = f(a + b); d = f(d + c);
  if (f(f(f(base + a) + gap) + d) > 1) { const ratio = f(a / f(d + a)), avail = f(high - gap); d = f(f(1 - ratio) * avail); a = f(avail * ratio); }
  const low = f(high - a), oHigh = f(low - gap), oLow = f(oHigh - d);
  return [high, low, oHigh, oLow].map(v => Math.trunc(f(Math.max(0, Math.min(1, v)) * 255)) / 255);
}

const VERT = `attribute vec4 fill; attribute vec4 edges; varying vec2 vUv; varying vec4 vFill; varying vec4 vEdges;
  void main() { vUv = uv; vFill = fill; vEdges = edges; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// (premultiplied: the letter over its outline, opaque; the outline's soft outer edge; a picture as it is)
const FRAG = `uniform sampler2D sheet; varying vec2 vUv; varying vec4 vFill; varying vec4 vEdges;
  float cover(float v, float lo, float hi) { float t = clamp((v - lo) / max(hi - lo, 1e-7), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
  void main() {
    vec4 t = texture2D(sheet, vUv);
    if (vFill.a > 0.5) { gl_FragColor = vec4(t.rgb * t.a, t.a); return; }
    float v = t.a;
    if (v >= vEdges.y) gl_FragColor = vec4(vFill.rgb * cover(v, vEdges.y, vEdges.x), 1.0);
    else gl_FragColor = vec4(0.0, 0.0, 0.0, cover(v, vEdges.w, vEdges.z));
  }`;

/** The nameplate over a view: `set` what it says, `draw` it over a frame already drawn. */
export class NameplateLayer {
  private plate: Nameplate | null = null;
  private data: {doc: PlateData, tex: THREE.Texture} | null = null;
  private glyphs = new Map<string, Glyph>();
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 0, -1, -1, 1);
  private mesh: THREE.Mesh;
  private built = '';
  /** Called when its data arrives (the view draws again). */
  onReady: () => void = () => {};
  constructor() {
    const mat = new THREE.ShaderMaterial({uniforms: {sheet: {value: null}}, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, premultipliedAlpha: true, blending: THREE.NormalBlending, depthTest: false, depthWrite: false});
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  /** Shown (on, and its data in). */
  get shown() { return !!this.plate?.on && !!this.data; }
  /** Its height over the head in label units (0: not shown). */
  get units() { return this.shown ? plateUnits(this.plate!) : 0; }
  set(p: Nameplate | null) {
    this.plate = p?.on ? {...p} : null; this.built = '';
    if (this.plate && !this.data) loadPlate().then(d => {
      this.data = d; this.glyphs = new Map(d.doc.glyphs.map(g => [g.icon ? `icon:${g.icon}` : g.ch!, g]));
      (this.mesh.material as THREE.ShaderMaterial).uniforms.sheet.value = d.tex; this.built = ''; this.onReady();
    }).catch(e => console.warn('nameplate', e));
  }
  dispose() { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.data?.tex.dispose(); }

  /** Draw it over what `r` drew last: its anchor `anchor` (the top of the head, in the scene), seen by `camera`, one
   *  label unit `unit` of the whole view's height (a view drawn in parts, `camera.view`, draws its part of it). */
  draw(r: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, anchor: THREE.Vector3, unit: number) {
    if (!this.shown) return;
    const p = anchor.clone().project(camera);
    if (p.z > 1 || p.z < -1) return;
    const size = r.getDrawingBufferSize(new THREE.Vector2()), v = camera.view?.enabled ? camera.view : null;
    const [fw, fh, ox, oy, w, h] = v ? [v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height] : [size.x, size.y, 0, 0, size.x, size.y];
    if (!(fw > 0 && fh > 0)) return;
    const u = unit * fh;   // (pixels of the whole view per label unit)
    const key = `${u.toFixed(3)}`;
    if (this.built !== key) { this.build(u); this.built = key; }
    const c = this.camera;
    c.left = ox; c.right = ox + w; c.top = -oy; c.bottom = -(oy + h); c.updateProjectionMatrix();
    this.mesh.position.set(ox + (p.x + 1) / 2 * w, -(oy + (1 - p.y) / 2 * h), 0);
    this.mesh.updateMatrixWorld();
    r.render(this.scene, c);
  }

  // the lines laid out as the game lays them, in pixels from the anchor (y down), as quads
  private build(u: number) {
    const pl = this.plate!, doc = this.data!.doc, [sw, sh] = doc.sheet;
    const g = (k: string) => this.glyphs.get(k);
    const chars = (s: string) => Array.from(s).map(ch => g(ch)).filter((x): x is Glyph => !!x);
    type Run = {glyphs: Glyph[], colours: number[][]};
    const run = (): Run => ({glyphs: [], colours: []});
    const add = (r: Run, gs: Glyph[], colour: number[]) => { for (const x of gs) { r.glyphs.push(x); r.colours.push(colour); } };
    const facColour = doc.factions[pl.faction]?.colour ?? doc.factions.none?.colour ?? [0.753, 0.753, 0.753];
    const wreath = run(), name = run(), level = run();
    if (pl.wreath) { const x = g('icon:wreath'); if (x) add(wreath, [x], WHITE); }
    add(name, chars(pl.name), NAME);
    if (pl.tag) add(name, chars(`#${pl.tag}`), NUMBER);
    const emblem = pl.faction !== 'none' ? g(`icon:${pl.faction}`) : null;
    if (emblem) add(level, [emblem], facColour);
    add(level, chars(String(pl.level)), facColour);
    const badge = pl.guild !== 'none' ? g(`icon:${pl.guild}`) : null;
    if (badge) add(level, [...chars(' '), badge], facColour);
    const h3 = pl.wreath ? 18 : 0;
    const lines = [...(pl.wreath ? [{r: wreath, ...LINE.wreath, y: 0}] : []), {r: name, ...LINE.name, y: h3 - 1}, {r: level, ...LINE.level, y: h3 + 13}];
    // (the text line's advance: each glyph after the one before it by the closest its outlines come, plus tracking)
    const layout = (gs: Glyph[], size: number) => {
      const xs: number[] = []; let x = 0, prev: number[] | undefined;
      for (const gl of gs) { const m = gl.m; x += (prev ? Math.max(...[6, 8, 10, 12].map(i => prev![i] - m[i - 1])) : m[3]) * size; xs.push(x); prev = m; }
      return {xs, width: x + (prev?.[4] ?? 0) * size};
    };
    const laid = lines.map(l => layout(l.r.glyphs, l.size));
    const w = Math.max(...laid.map(l => l.width)) + 4, h = h3 + 27;
    const pos: number[] = [], uv: number[] = [], fill: number[] = [], edges: number[] = [], index: number[] = [];
    // (the label's top left, from the anchor: centred, its bottom 10 units above it; then each line centred in it)
    const left0 = -w / 2, top0 = -(10 + h);
    lines.forEach((l, k) => {
      const {xs, width} = laid[k], left = left0 + (w - width) / 2, baseline = top0 + l.y + doc.ascent * l.size;
      const e = outlineEdges(l.size * u, l.weight, l.spacing);
      l.r.glyphs.forEach((gl, i) => {
        if (!gl.r) return;
        const [rx, ry, rw, rh] = gl.r, em = gl.em!, s = l.size / em;
        const x0 = (left + xs[i] - s) * u, y0 = (baseline - gl.m[0] * l.size - s) * u, x1 = x0 + rw * s * u, y1 = y0 + rh * s * u;
        const n = pos.length / 3, col = l.r.colours[i];
        pos.push(x0, -y0, 0, x1, -y0, 0, x1, -y1, 0, x0, -y1, 0);
        uv.push(rx / sw, ry / sh, (rx + rw) / sw, ry / sh, (rx + rw) / sw, (ry + rh) / sh, rx / sw, (ry + rh) / sh);
        for (let c = 0; c < 4; c++) { fill.push(col[0], col[1], col[2], gl.color ? 1 : 0); edges.push(...e); }
        index.push(n, n + 2, n + 1, n, n + 3, n + 2);
      });
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('fill', new THREE.Float32BufferAttribute(fill, 4));
    geo.setAttribute('edges', new THREE.Float32BufferAttribute(edges, 4));
    geo.setIndex(index);
    this.mesh.geometry.dispose(); this.mesh.geometry = geo;
  }
}

// ---- its size: the game's interface pixel against the character, at the game's usual distance ----
// The game's camera: 15360 units from the character at its usual zoom, 40 degrees high; an interface pixel there
// taken on a view 1080 pixels high. The label grows as the camera closes in: 1 + clamp(18 - distance / 1024, 0, 16) / 16.
const GAME_DISTANCE = 15360, GAME_UNIT = 2 * GAME_DISTANCE * Math.tan(20 * Math.PI / 180) / 1080;
export const zoomFactor = (distance: number) => 1 + Math.max(0, Math.min(16, 18 - distance / 1024)) / 16;
/** A label unit as a share of the view's height, for a view `fovDeg` high whose full-figure framing is `fullDist`
 *  away, now `dist` away (the full-figure framing standing for the game's usual distance). */
export function plateUnit(dist: number, fullDist: number, fovDeg: number) {
  return zoomFactor(GAME_DISTANCE * dist / fullDist) * GAME_UNIT / (2 * fullDist * Math.tan(fovDeg * Math.PI / 360));
}
