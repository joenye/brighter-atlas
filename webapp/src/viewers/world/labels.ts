// Floating name labels (room names, NPC names): drawn in the 3D scene (so screenshots and videos keep them),
// but sized and placed in screen pixels like map labels. Each is a quad at its anchor whose vertex shader puts
// it a fixed number of pixels wide and tall, its corner snapped to the pixel grid; its text is rasterised for
// the renderer's own pixel ratio (CSS size times the ratio), so texels land on pixels one for one and the text
// is as sharp as the page's own. A change of render scale rasterises again (refresh); a passing change (a
// high-resolution screenshot) scales the same texture to keep the label's size in the picture.
import { THREE } from '../three-common.js';

export interface LabelStyle {
  /** Font size, CSS pixels. */
  size: number;
  weight: number;
  /** Text colour, its halo (an outline for contrast) and the backing plate (or none). */
  color: string;
  halo: string;
  plate: string | null;
  /** The plate's edge, and its padding (CSS pixels). */
  edge: string | null;
  padX: number;
  padY: number;
  radius: number;
  /** Where the anchor sits on the label, from its bottom: 0 (the label stands on it, as over a head) to 0.5
   *  (centred on it, as over a room). */
  anchorY: number;
}

const FONT = '-apple-system, "Segoe UI", system-ui, Roboto, sans-serif';

/** Room names: the page's light text on its dark panel colour. */
export const ROOM_LABEL: LabelStyle = {
  size: 17, weight: 700, color: '#eef2f7', halo: 'rgba(8,10,14,0.85)', plate: 'rgba(16,19,25,0.8)',
  edge: 'rgba(120,183,255,0.4)', padX: 10, padY: 4, radius: 7, anchorY: 0.5,
};
/** NPC names: smaller, warm, a lighter plate, so they read apart from room names. */
export const NPC_LABEL: LabelStyle = {
  size: 13, weight: 600, color: '#f6c7b2', halo: 'rgba(8,10,14,0.9)', plate: 'rgba(16,19,25,0.6)',
  edge: null, padX: 5, padY: 2, radius: 4, anchorY: 0,
};

const VERTEX = /* glsl */`
uniform vec2 uViewport;   // drawing buffer, pixels
uniform vec2 uPixels;     // the label's texture, pixels
uniform float uScale;     // the pixel ratio now over the one it was drawn for (1 but for a passing change)
uniform float uAnchorY;   // where the anchor sits on the label, from its bottom (0..1)
varying vec2 vUv;
void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 size = uPixels * uScale;
  // the anchor in pixels; the label's lower left corner on the pixel grid
  vec2 anchor = (clip.xy / clip.w * 0.5 + 0.5) * uViewport;
  vec2 corner = floor(anchor - size * vec2(0.5, uAnchorY) + 0.5);
  vec2 p = corner + (position.xy + 0.5) * size;
  gl_Position = vec4((p / uViewport * 2.0 - 1.0) * clip.w, clip.z, clip.w);
  vUv = uv;
}`;
const FRAGMENT = /* glsl */`
uniform sampler2D map;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(map, vUv);
  #include <colorspace_fragment>
}`;

interface LabelData { text: string; style: LabelStyle; ratio: number }

/** One quad shared by every label (its corners at -0.5..0.5, as the shader expects). */
const QUAD = new THREE.PlaneGeometry(1, 1);
const viewport = new THREE.Vector2(1, 1);

function measure(ctx: CanvasRenderingContext2D, style: LabelStyle, text: string): [number, number] {
  ctx.font = `${style.weight} ${style.size}px ${FONT}`;
  const width = Math.ceil(ctx.measureText(text).width);
  return [width + style.padX * 2 + 2, Math.ceil(style.size * 1.25) + style.padY * 2 + 2];
}

/** The label's text drawn for `ratio` pixels per CSS pixel. */
function raster(text: string, style: LabelStyle, ratio: number): { canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const size = measure(ctx, style, text);
  canvas.width = Math.max(1, Math.round(size[0] * ratio));
  canvas.height = Math.max(1, Math.round(size[1] * ratio));
  ctx.scale(canvas.width / size[0], canvas.height / size[1]);
  const [w, h] = size;
  if (style.plate) {
    ctx.beginPath();
    ctx.roundRect(1, 1, w - 2, h - 2, style.radius);
    ctx.fillStyle = style.plate;
    ctx.fill();
    if (style.edge) { ctx.strokeStyle = style.edge; ctx.lineWidth = 1; ctx.stroke(); }
  }
  ctx.font = `${style.weight} ${style.size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = style.halo;
  ctx.lineWidth = 3;
  ctx.strokeText(text, w / 2, h / 2 + 0.5);
  ctx.fillStyle = style.color;
  ctx.fillText(text, w / 2, h / 2 + 0.5);
  return { canvas };
}

function texture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  // texel for pixel: no filtering to blur, no mipmaps to fetch
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

/** A label at the origin of its parent (position it as any object). */
export function makeLabel(text: string, style: LabelStyle, ratio: number): THREE.Mesh {
  const { canvas } = raster(text, style, ratio);
  const uniforms = {
    map: { value: texture(canvas) },
    uViewport: { value: viewport },
    uPixels: { value: new THREE.Vector2(canvas.width, canvas.height) },
    uScale: { value: 1 },
    uAnchorY: { value: style.anchorY },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT,
    // labels are UI text: over everything, no fog, no depth
    transparent: true, depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(QUAD, material);
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;   // (a point anchor: its quad is placed in the shader)
  mesh.raycast = () => {};      // (never picked: its geometry is not where it draws)
  const data: LabelData = { text, style, ratio };
  mesh.userData.label = data;
  // (the drawing buffer and pixel ratio as this render has them, and a tiled screenshot's magnification: each
  // tile is a view onto a picture several times the screen's size, so the label keeps its size in the picture)
  mesh.onBeforeRender = (renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera) => {
    renderer.getDrawingBufferSize(viewport);
    const view = (camera as THREE.PerspectiveCamera).view;
    const zoom = view?.enabled && view.width > 0 ? view.fullWidth / view.width : 1;
    uniforms.uScale.value = renderer.getPixelRatio() / data.ratio * zoom;
  };
  return mesh;
}

/** Rasterise every label under `root` again for `ratio` (a new render scale), where it differs. */
export function refreshLabels(root: THREE.Object3D | null, ratio: number): void {
  root?.traverse((o: any) => {
    const data: LabelData | undefined = o.userData?.label;
    if (!data || data.ratio === ratio) return;
    const { canvas } = raster(data.text, data.style, ratio);
    const u = o.material.uniforms;
    u.map.value.dispose();
    u.map.value = texture(canvas);
    u.uPixels.value.set(canvas.width, canvas.height);
    data.ratio = ratio;
  });
}

/** Free a label's texture and material. */
export function disposeLabel(o: any): void {
  o.material?.uniforms?.map?.value?.dispose?.();
  o.material?.dispose?.();
}

/** Keeps labels from piling on one another, as map labels do: whenever the view changes, the labels of the
 *  registered groups are projected and, nearest first, each is shown only where it overlaps none already
 *  shown (a few pixels apart). A tiled screenshot's tiles keep the screen's choice, so they agree. */
export class LabelDeclutter {
  private readonly groups = new Set<THREE.Object3D>();
  private readonly lastView = new THREE.Matrix4();
  private readonly lastProj = new THREE.Matrix4();
  private lastKey = '';
  private readonly v = new THREE.Vector3();
  private readonly size = new THREE.Vector2();

  constructor(scene: THREE.Scene) {
    const before = scene.onBeforeRender as (...args: any[]) => void;
    (scene as any).onBeforeRender = (...args: any[]) => {
      before.apply(scene, args);
      this.update(args[0], args[2]);
    };
  }

  add(group: THREE.Object3D): void { this.groups.add(group); this.lastKey = ''; }
  remove(group: THREE.Object3D): void { this.groups.delete(group); }

  private update(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if ((camera as THREE.PerspectiveCamera).view?.enabled) return;   // (a screenshot tile: keep the screen's)
    renderer.getDrawingBufferSize(this.size);
    const groups = [...this.groups].filter((g) => g.visible && g.parent);
    const key = `${this.size.x}x${this.size.y}|${groups.map((g) => `${g.id}:${g.children.length}`).join(',')}|${renderer.getPixelRatio()}`;
    if (key === this.lastKey && this.lastView.equals(camera.matrixWorldInverse) && this.lastProj.equals(camera.projectionMatrix)) return;
    this.lastKey = key;
    this.lastView.copy(camera.matrixWorldInverse);
    this.lastProj.copy(camera.projectionMatrix);
    const W = this.size.x, H = this.size.y, ratio = renderer.getPixelRatio(), gap = 3 * ratio;
    const found: { o: any; x: number; y: number; w: number; h: number; d: number }[] = [];
    for (const group of groups) {
      for (const o of group.children as any[]) {
        const data: LabelData | undefined = o.userData?.label;
        if (!data) continue;
        this.v.setFromMatrixPosition(o.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
        const d = -this.v.z;
        this.v.applyMatrix4(camera.projectionMatrix);
        const px = (this.v.x * 0.5 + 0.5) * W, py = (this.v.y * 0.5 + 0.5) * H;
        const u = o.material.uniforms, scale = ratio / data.ratio;
        const w = u.uPixels.value.x * scale, h = u.uPixels.value.y * scale;
        const x = px - w / 2, y = py - h * data.style.anchorY;
        if (!(d > 0) || x > W || y > H || x + w < 0 || y + h < 0) { o.visible = false; continue; }
        found.push({ o, x, y, w, h, d });
      }
    }
    found.sort((a, b) => a.d - b.d);
    // (a coarse grid of the shown labels' boxes: each candidate checks only the cells it covers)
    const CELL = 96 * ratio, grid = new Map<number, typeof found>();
    const cells = (r: (typeof found)[0], add: boolean) => {
      const out: (typeof found)[] = [];
      for (let cx = Math.floor(r.x / CELL); cx <= Math.floor((r.x + r.w) / CELL); cx++) {
        for (let cy = Math.floor(r.y / CELL); cy <= Math.floor((r.y + r.h) / CELL); cy++) {
          const k = cx * 65536 + cy;
          let list = grid.get(k);
          if (!list && add) grid.set(k, list = []);
          if (list) out.push(list);
        }
      }
      return out;
    };
    for (const r of found) {
      const clash = cells(r, false).some((list) => list.some((s) =>
        r.x < s.x + s.w + gap && s.x < r.x + r.w + gap && r.y < s.y + s.h + gap && s.y < r.y + r.h + gap));
      r.o.visible = !clash;
      if (!clash) for (const list of cells(r, true)) list.push(r);
    }
  }
}
