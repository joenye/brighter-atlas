// Sealed areas on the world map: parts of the files the game has not shown,
// drawn only as a silhouette. Each is a dark ground with a soft halo, a faint
// rim in its episode's colour and slow fog drifting across it, with the
// episode's logo and name over it. A second canvas above the map draws the
// fog (the map renderer is untouched); the badges are HTML above that.
import type { SealedArea } from './data.js';
import type { MapCamera } from '../viewers/maps/pan-zoom.js';

const TEXELS = 4;     // mask texels per map tile
const MARGIN = 4;     // tiles of room for the halo around an area
// the rim's colour per episode, taken from its logo (unknown keys: pale blue)
const RIMS: Record<string, number[]> = { stonemaw: [0.96, 0.62, 0.28], bleakholm: [0.36, 0.72, 0.98] };

const VERTEX = `#version 300 es
void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D mask; uniform vec2 origin, size, camera, viewport; uniform float scale, time; uniform vec3 rim;
out vec4 color;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; } return v; }
void main(){
  vec2 w = camera + (vec2(gl_FragCoord.x, viewport.y - gl_FragCoord.y) - viewport * 0.5) / scale;   // map tiles
  vec2 uv = (w - origin) / size;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
  float c = texture(mask, uv).r;
  if (c < 0.004) discard;
  float f1 = fbm(w * 0.09 + vec2(time * 0.018, time * 0.007));
  float f2 = fbm(w * 0.035 - vec2(time * 0.011, -time * 0.004) + f1 * 0.8);
  float fog = smoothstep(0.35, 0.85, f2 * 0.65 + f1 * 0.35);
  float inside = smoothstep(0.42, 0.58, c);
  float halo = (1.0 - inside) * smoothstep(0.0, 0.42, c);
  float edge = exp(-pow((c - 0.5) / 0.07, 2.0));
  vec3 ground = vec3(0.018, 0.02, 0.026) + rim * 0.035 * fog;
  vec3 mist = mix(vec3(0.33, 0.36, 0.42), rim, 0.25);
  float a = inside * 0.97 + halo * 0.55;
  vec3 col = mix(ground, mist, fog * 0.42 * inside) * a;
  col += rim * edge * (0.35 + 0.35 * f1) * (0.7 + 0.3 * sin(time * 0.6 + w.x * 0.05 + w.y * 0.03));
  color = vec4(col, clamp(a + edge * 0.2, 0.0, 1.0));
}`;

interface Region { area: SealedArea; texture: WebGLTexture; origin: number[]; size: number[]; centre: number[]; extent: number; badge: HTMLElement }

export class SealedLayer {
  private gl: WebGL2RenderingContext | null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private regions: Region[] = [];
  private raf = 0;
  private last = 0;
  private readonly still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private canvas: HTMLCanvasElement, private overlay: HTMLElement, private view: () => { camera: MapCamera; width: number; height: number; dpr: number }) {
    this.gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!this.gl) return;   // no fog: the badges still mark the areas
    const gl = this.gl, compile = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s) ?? 'fog shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERTEX)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(p);
    this.program = p;
    for (const k of ['mask', 'origin', 'size', 'camera', 'viewport', 'scale', 'time', 'rim']) this.uniforms[k] = gl.getUniformLocation(p, k);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** The sealed areas of the map shown now. */
  setAreas(areas: SealedArea[]): void {
    const same = areas.length === this.regions.length && areas.every((a, i) => a.key === this.regions[i].area.key
      && a.cells.length === this.regions[i].area.cells.length && a.cells.every((v, k) => v === this.regions[i].area.cells[k]));
    if (same) return;
    for (const r of this.regions) { this.gl?.deleteTexture(r.texture); r.badge.remove(); }
    this.regions = areas.filter((a) => a.cells.length).map((a) => this.region(a));
    this.loop();
  }

  /** The areas' extent in map tiles, or null. */
  bounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.regions.length) return null;
    const x0 = Math.min(...this.regions.map((r) => r.origin[0] + MARGIN)), y0 = Math.min(...this.regions.map((r) => r.origin[1] + MARGIN));
    const x1 = Math.max(...this.regions.map((r) => r.origin[0] + r.size[0] - MARGIN)), y1 = Math.max(...this.regions.map((r) => r.origin[1] + r.size[1] - MARGIN));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  private region(area: SealedArea): Region {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sx = 0, sy = 0;
    const n = area.cells.length / 2;
    for (let i = 0; i < area.cells.length; i += 2) {
      const x = area.cells[i], y = area.cells[i + 1];
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); sx += x + .5; sy += y + .5;
    }
    const origin = [x0 - MARGIN, y0 - MARGIN], size = [x1 - x0 + MARGIN * 2, y1 - y0 + MARGIN * 2];
    // the badge sits on the area: the cell nearest its centroid
    let centre = [sx / n, sy / n], best = Infinity;
    for (let i = 0; i < area.cells.length; i += 2) {
      const d = (area.cells[i] + .5 - sx / n) ** 2 + (area.cells[i + 1] + .5 - sy / n) ** 2;
      if (d < best) { best = d; centre = [area.cells[i] + .5, area.cells[i + 1] + .5]; }
    }
    const badge = document.createElement('div');
    badge.className = `sealed-badge sealed-${area.key}`;
    const img = document.createElement('img'); img.src = area.logo; img.alt = ''; img.decoding = 'async';
    const name = document.createElement('span'); name.className = 'sealed-name'; name.textContent = area.name;
    const note = document.createElement('span'); note.className = 'sealed-note'; note.textContent = 'WIP';
    badge.append(img, name, note);
    this.overlay.append(badge);
    return { area, texture: this.mask(area.cells, origin, size), origin, size, centre, extent: Math.max(x1 - x0, y1 - y0), badge };
  }

  // coverage at TEXELS per tile, blurred twice by a tile so the edge sits
  // soft on the cell boundary (0.5 there)
  private mask(cells: number[], origin: number[], size: number[]): WebGLTexture {
    const w = size[0] * TEXELS, h = size[1] * TEXELS;
    let a = new Float32Array(w * h);
    for (let i = 0; i < cells.length; i += 2) {
      const bx = (cells[i] - origin[0]) * TEXELS, by = (cells[i + 1] - origin[1]) * TEXELS;
      for (let y = 0; y < TEXELS; y++) a.fill(1, (by + y) * w + bx, (by + y) * w + bx + TEXELS);
    }
    const blur = (src: Float32Array, dx: number, dy: number, r: number) => {
      const out = new Float32Array(src.length), len = dx ? w : h, lines = dx ? h : w;
      for (let line = 0; line < lines; line++) {
        let sum = 0;
        const at = (k: number) => (dx ? line * w + k : k * w + line);
        for (let k = -r; k <= r; k++) sum += k >= 0 && k < len ? src[at(k)] : 0;
        for (let k = 0; k < len; k++) {
          out[at(k)] = sum / (2 * r + 1);
          const add = k + r + 1, drop = k - r;
          if (add < len) sum += src[at(add)];
          if (drop >= 0) sum -= src[at(drop)];
        }
      }
      return out;
    };
    for (let pass = 0; pass < 2; pass++) a = blur(blur(a, 1, 0, TEXELS >> 1), 0, 1, TEXELS >> 1);
    const bytes = new Uint8Array(w * h);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, a[i]) * 255);
    const gl = this.gl;
    if (!gl) return null as unknown as WebGLTexture;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Draw at the current camera (the map calls this on every change). */
  draw(time = performance.now() / 1000): void {
    const { camera, width, height, dpr } = this.view();
    const w = Math.round(width * dpr), h = Math.round(height * dpr);
    for (const r of this.regions) {   // badges: over the area, sized by it, clamped to stay legible
      const x = (r.centre[0] - camera.cx) * camera.scale + width / 2, y = (r.centre[1] - camera.cy) * camera.scale + height / 2;
      const px = Math.max(28, Math.min(72, r.extent * camera.scale * 0.12));
      r.badge.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      r.badge.style.setProperty('--logo', `${px}px`);
    }
    const gl = this.gl;
    if (!gl || !this.program || !w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.regions.length) return;
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.uniform2f(u.camera, camera.cx, camera.cy); gl.uniform2f(u.viewport, w, h); gl.uniform1f(u.scale, camera.scale * dpr);
    gl.uniform1f(u.time, this.still ? 0 : time); gl.uniform1i(u.mask, 0); gl.activeTexture(gl.TEXTURE0);
    for (const r of this.regions) {
      gl.bindTexture(gl.TEXTURE_2D, r.texture);
      gl.uniform2f(u.origin, r.origin[0], r.origin[1]); gl.uniform2f(u.size, r.size[0], r.size[1]);
      const rim = RIMS[r.area.key] ?? [0.6, 0.7, 0.9];
      gl.uniform3f(u.rim, rim[0], rim[1], rim[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  // the fog drifts at up to 30 frames a second while there is fog to show
  // (none when motion is reduced: the map's own draws keep it placed)
  private loop(): void {
    if (this.raf || this.still) return;
    const tick = (now: number) => {
      this.raf = 0;
      if (!this.regions.length) return;
      if (now - this.last >= 33) { this.last = now; this.draw(now / 1000); }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
