// Shared three.js scaffolding. A single WebGLRenderer is reused across views
// (its canvas is re-parented) so navigating never leaks GL contexts.
// World convention: Z is up (Brighter Shores meshes/skeletons are Z-up, ~cm units).

import * as THREE from '../../vendor/three.module.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { el } from '../ui.js';
import { getPref, setPref } from '../prefs.js';

let _renderer: THREE.WebGLRenderer | null = null;

export function getRenderer(): THREE.WebGLRenderer {
  if (!_renderer) {
    // Some browsers/drivers (notably Firefox + ANGLE on Windows) can't find an
    // EGL config for certain attribute combinations and throw "Error creating
    // WebGL context". Try the ideal options first, then progressively drop the
    // pickiest attributes (powerPreference, then antialias/MSAA, then
    // preserveDrawingBuffer, which screenshots want) until a context is
    // created, so the app still renders.
    const attempts: THREE.WebGLRendererParameters[] = [
      { antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' },
      { antialias: true, preserveDrawingBuffer: true },
      { preserveDrawingBuffer: true },
      { antialias: true },
      {},
    ];
    let lastErr: unknown = null;
    for (const opts of attempts) {
      try { _renderer = new THREE.WebGLRenderer(opts); break; }
      catch (e) { lastErr = e; _renderer = null; }
    }
    if (!_renderer) throw lastErr || new Error('Error creating WebGL context.');
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  }
  return _renderer;
}

export { THREE };

// live-instance count: the renderer is shared, so a leaked Scene3D keeps a
// second requestAnimationFrame loop rendering its own camera into the one
// canvas. Views must keep this at 1 (destroy() decrements it).
let _aliveScenes = 0;

// Camera-controls hint, mounted on every Scene3D host (bottom-left). Orbit and
// zoom are discoverable by accident; right-drag / Ctrl-drag panning is not,
// so the card is VISIBLE by default. It has no minimise button of its own:
// the U immersive toggle hides all chrome (this card included).
function mountCamHint(host: HTMLElement): HTMLElement {
  const row = (keys: string, verb: string) => el('span', { class: 'cam-hint-row' }, el('b', { text: keys }), el('span', { text: ` ${verb}` }));
  const card = el('div', { class: 'cam-hint-card' },
    row('drag', 'orbit'), row('scroll', 'zoom'), row('ctrl-drag / right-drag', 'move'),
    row('F', 'fullscreen'), row('U', 'hide UI'));
  const wrap = el('div', { class: 'cam-hint' }, card);
  host.appendChild(wrap);
  return wrap;
}

export class Scene3D {
  host: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  hemi: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  helpers: THREE.Group;
  private _camHint: HTMLElement;
  private _helpersVisible: boolean;
  private _ticks: Set<(dt: number) => void>;
  private _alive: boolean;
  private _lastT: number;
  private _ro: ResizeObserver;

  constructor(host: HTMLElement) {
    _aliveScenes++;
    this.host = host;
    this.renderer = getRenderer();
    host.appendChild(this.renderer.domElement);
    this._camHint = mountCamHint(host);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10131a);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 500000);
    this.camera.up.set(0, 0, 1); // Z-up world

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    // lights (Z-up: hemisphere "sky" direction along +Z); intensities come
    // from the persisted viewer-lighting prefs (adjustable via the 💡 panel)
    const lights = savedLights();
    this.hemi = new THREE.HemisphereLight(0xcdd9ee, 0x33291f, lights.ambient);
    this.hemi.position.set(0, 0, 1);
    this.key = new THREE.DirectionalLight(0xffffff, lights.sun);
    this.key.position.set(1, -1.2, 1.6);
    this.fill = new THREE.DirectionalLight(0x8fb0dd, lights.fill);
    this.fill.position.set(-1.2, 0.8, 0.5);
    this.scene.add(this.hemi, this.key, this.fill);

    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);
    this._helpersVisible = true;   // grid + axes toggle (survives addGround/refit)

    this._ticks = new Set();
    this._alive = true;
    this._lastT = performance.now();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(host);
    this._resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  addTick(fn: (dt: number) => void): () => void { this._ticks.add(fn); return () => this._ticks.delete(fn); }

  private _resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private _loop(t: number): void {
    if (!this._alive) return;
    const dt = Math.min(100, t - this._lastT);
    this._lastT = t;
    for (const fn of this._ticks) fn(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._loop);
  }

  // grid in the XY plane + axes, sized to the object. `center` is the object's
  // horizontal (x,y) centre: the game authors rest poses offset from the world
  // origin, so centring the grid + axes UNDER the model (instead of at 0,0) keeps
  // the reference plane symmetric about the turntable axis: the spin then reads
  // as "on the spot" rather than the model circling an off-to-the-side origin.
  addGround(radius: number, zLevel = 0, center: { x: number; y: number } = { x: 0, y: 0 }): THREE.GridHelper {
    const size = Math.max(1e-6, radius) * 4;
    const grid = new THREE.GridHelper(size, 20, 0x39445a, 0x232936);
    grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default -> lay into XY
    grid.position.set(center.x, center.y, zLevel);
    const axes = new THREE.AxesHelper(size * 0.3);
    axes.position.set(center.x, center.y, zLevel + size * 1e-4);
    grid.visible = axes.visible = this._helpersVisible;   // honor the grid toggle
    this.helpers.add(grid, axes);
    return grid;
  }

  // show/hide the ground grid AND the RGB axes together (the "Grid" toggle)
  setHelpersVisible(on: boolean): void {
    this._helpersVisible = on;
    this.helpers.traverse((o) => { if (o.type === 'GridHelper' || o.type === 'AxesHelper') o.visible = on; });
  }

  // fov-aware fit: place the camera so the box's bounding sphere fits BOTH
  // frustum axes with a margin: no manual zoom needed to see the full model.
  // keepDirection preserves the user's current orbit angle (used on refits).
  frameBox(min: ArrayLike<number>, max: ArrayLike<number>,
    { margin = 1.12, keepDirection = false }: { margin?: number; keepDirection?: boolean } = {}): { center: THREE.Vector3; radius: number } {
    const c = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const r = Math.max(1e-3, 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * Math.max(0.2, this.camera.aspect));
    const dist = (r / Math.sin(Math.min(vHalf, hHalf))) * margin;
    // default: camera on the +Y side so characters (which face +Y) face the viewer
    let dir = new THREE.Vector3(-0.55, 0.71, 0.44);
    if (keepDirection) {
      const cur = this.camera.position.clone().sub(this.controls.target);
      if (cur.lengthSq() > 1e-9) dir = cur.normalize();
    }
    this.camera.near = Math.max((dist - r) / 50, dist / 5000);
    this.camera.far = dist + r * 100;
    this.camera.position.copy(c).addScaledVector(dir.normalize(), dist);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
    this.key.position.set(c.x - r * 2, c.y + r * 2.4, c.z + r * 3.2);
    return { center: c, radius: r };
  }

  destroy(): void {
    if (this._alive) _aliveScenes--;
    this._alive = false;
    this._ro.disconnect();
    this.controls.dispose();
    // dispose scene resources
    this.scene.traverse((o: any) => {
      o.geometry?.dispose?.();
      const mats: any[] = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        for (const v of Object.values(m) as any[]) v?.isTexture && v.dispose();
        m.dispose?.();
      }
    });
    this._camHint.remove();
    this.renderer.domElement.remove(); // keep renderer/context for the next view
  }
}

// procedural UV-checker texture (with gradient tint so orientation is visible)
export function checkerTexture(cells = 10, px = 512): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const g = cv.getContext('2d')!;
  const s = px / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const on = (x + y) % 2 === 0;
      const hue = (x / cells) * 90 + 190, light = 30 + (y / cells) * 35;
      g.fillStyle = on ? `hsl(${hue},45%,${light}%)` : `hsl(${hue},25%,${light * 0.45}%)`;
      g.fillRect(x * s, y * s, s, s);
    }
  }
  g.fillStyle = 'rgba(255,255,255,.85)';
  g.font = `${Math.floor(s * 0.5)}px monospace`;
  g.textBaseline = 'top';
  g.fillText('0,0', 4, 4);
  g.fillText('1,0', px - s + 4, 4);
  g.fillText('0,1', 4, px - s + 4);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// A toolbar "Grid" toggle button wired to a scene's grid+axes visibility and
// persisted (shared across every 3D view via the 'showGrid' pref). Applies the
// stored state to the scene immediately so it holds through refits.
// ---- persisted viewer lighting ---------------------------------------------
// One shared light rig serves every generic 3D view (mesh / rig / model /
// previews). The user's adjustments persist in prefs and apply everywhere,
// so the look stays consistent between assets and across reloads.
export const LIGHT_DEFAULTS = Object.freeze({ ambient: 1.1, sun: 2.0, fill: 0.55 });
type ViewerLights = { ambient: number; sun: number; fill: number };

export function savedLights(): ViewerLights {
  const saved = getPref('viewerLights');
  const pick = (k: keyof ViewerLights) => {
    const v = saved && typeof saved === 'object' ? Number((saved as any)[k]) : NaN;
    return Number.isFinite(v) ? v : LIGHT_DEFAULTS[k];
  };
  return { ambient: pick('ambient'), sun: pick('sun'), fill: pick('fill') };
}

function applyLightsTo(scene: Scene3D, v: ViewerLights): void {
  scene.hemi.intensity = v.ambient;
  scene.key.intensity = v.sun;
  scene.fill.intensity = v.fill;
}

// Toolbar 💡 button + a floating "Lighting" overlay (the world panel's
// Lighting & effects controls, ported to the generic viewers). The panel
// mounts inside the scene host; values write through to prefs live.
export function makeLightToggle(scene: Scene3D): HTMLButtonElement {
  const panel = el('div', { class: 'world-panel light-overlay', hidden: 'hidden' });
  const cur = savedLights();
  const row = (k: keyof ViewerLights, label: string, max: number) => {
    const out = el('output', { text: cur[k].toFixed(2) });
    const input = el('input', {
      type: 'range', min: '0', max: String(max), step: '0.05', value: String(cur[k]),
    });
    input.addEventListener('input', () => {
      cur[k] = Number(input.value);
      out.textContent = cur[k].toFixed(2);
      applyLightsTo(scene, cur);
      setPref('viewerLights', { ...cur });
    });
    return el('div', { class: 'wp-range' },
      el('div', { class: 'wp-range-head' }, el('span', { text: label }), out),
      input);
  };
  const resetBtn = el('button', { class: 'btn btn-mini', text: 'reset', title: 'Back to the default lighting' });
  panel.append(
    el('div', { class: 'wp-section' },
      el('div', { class: 'wp-title' }, document.createTextNode('Lighting'), resetBtn),
      row('ambient', 'Ambient / sky', 2.5),
      row('sun', 'Sun', 3),
      row('fill', 'Fill', 1.5)),
  );
  resetBtn.addEventListener('click', () => {
    Object.assign(cur, LIGHT_DEFAULTS);
    applyLightsTo(scene, cur);
    setPref('viewerLights', { ...cur });
    for (const [i, k] of (['ambient', 'sun', 'fill'] as const).entries()) {
      const r = panel.querySelectorAll('input[type=range]')[i] as HTMLInputElement;
      r.value = String(cur[k]);
      (panel.querySelectorAll('output')[i] as HTMLOutputElement).textContent = cur[k].toFixed(2);
    }
  });
  scene.host.appendChild(panel);
  const btn = el('button', { class: 'btn', text: '💡', title: 'Adjust the viewer lighting (persists across assets)' });
  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    btn.classList.toggle('active', !panel.hidden);
  });
  return btn;
}

export function makeGridToggle(scene: Scene3D): HTMLButtonElement {
  const on0 = getPref('showGrid') !== false;   // default ON
  scene.setHelpersVisible(on0);
  const btn = el('button', {
    class: `btn${on0 ? ' active' : ''}`, text: 'Grid',
    title: 'Show/hide the ground grid and the red/green/blue axes',
  });
  btn.addEventListener('click', () => {
    const on = getPref('showGrid') === false;   // flip
    setPref('showGrid', on);
    scene.setHelpersVisible(on);
    btn.classList.toggle('active', on);
  });
  return btn;
}

// Immersive controls shared by every 3D viewer (world/mesh/model/skeleton/
// scene/anim): F fullscreens just the renderer pane, U toggles all chrome
// (toolbar, side panels, hints, HUD via the .ui-hidden class) for a UI-free
// view. Both are also on-screen buttons in the toolbar. Returns { destroy }.
// The keys skip editable targets and modifier chords (so Ctrl+R etc. pass
// through) and pause while the pinned-model animation picker is focused.
export function mountImmersiveControls({ pane, toolbar }:
  { pane: HTMLElement; host?: HTMLElement; toolbar: HTMLElement }): { destroy(): void } {
  const fsBtn = el('button', { class: 'btn', text: '⛶ Full', title: 'Fullscreen the viewer (F)' });
  const uiBtn = el('button', { class: 'btn', text: '⤢ Immersive', title: 'Hide all controls for an immersive view (U)' });
  toolbar.append(fsBtn, uiBtn);

  const fsTarget = pane;
  const fsActive = () => document.fullscreenElement === fsTarget;
  async function toggleFullscreen() {
    try {
      if (fsActive()) await document.exitFullscreen();
      else await fsTarget.requestFullscreen?.();
    } catch { /* denied / unsupported: ignore */ }
  }
  const syncFs = () => fsBtn.classList.toggle('active', fsActive());
  document.addEventListener('fullscreenchange', syncFs);

  function toggleImmersive() {
    const hidden = pane.classList.toggle('ui-hidden');
    uiBtn.classList.toggle('active', hidden);
  }
  fsBtn.addEventListener('click', toggleFullscreen);
  uiBtn.addEventListener('click', toggleImmersive);

  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable
        || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''))) return;
    if (event.code === 'KeyF') { event.preventDefault(); toggleFullscreen(); }
    else if (event.code === 'KeyU') { event.preventDefault(); toggleImmersive(); }
  };
  window.addEventListener('keydown', onKey);

  return {
    destroy() {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', syncFs);
      if (fsActive()) document.exitFullscreen().catch(() => {});
    },
  };
}
