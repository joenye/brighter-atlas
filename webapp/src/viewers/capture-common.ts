// Shared capture plumbing for the video wizard and the screenshot modal: draw
// the (shared) renderer canvas into a 2D composite with an optional caption bar,
// and temporarily override the scene's grid / background — capturing the
// originals so the underlying 3D view is untouched once the modal closes.

import { THREE, getRenderer } from './three-common.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { el } from '../ui.js';
import { Zlib } from '../../vendor/fflate.module.js';
import { pngChunk, pngHeader } from '../extract/png.js';

// caption geometry/style: position (x,y) and size are 0..1 fractions of the frame
export interface CaptionStyle { font: string; size: number; x: number; y: number; bg: boolean }
export interface CaptionOpts extends Partial<CaptionStyle> { text?: string }

// the subset of Scene3D the offscreen render path needs (model-preview passes a
// bare {renderer, scene, camera} object, not a full Scene3D)
export interface RenderSource { renderer: any; scene: any; camera: any }

// Grid + background overrides on a live Scene3D, with capture/restore. The
// "grid lines" toggle covers BOTH the ground GridHelper and the RGB AxesHelper
// (addGround adds both) — hiding the grid must hide the axis lines too.
export function sceneOverrides(scene: any) {
  const helpers: any[] = [];
  scene.scene.traverse((o: any) => { if (o.type === 'GridHelper' || o.type === 'AxesHelper') helpers.push(o); });
  const helperOrig = helpers.map((h) => h.visible);
  const bg = scene.scene.background;
  const bgOrig = bg && bg.isColor ? bg.clone() : (bg || null);
  const defaultBg = bg && bg.isColor ? `#${bg.getHexString()}` : '#0d0f13';
  return {
    hasGrid: helpers.length > 0,
    gridVisible: helpers.length ? helpers.every((h) => h.visible) : false,
    // true when the background is a plain colour (always, since the skybox
    // presets were removed — kept so a future texture backdrop stays safe)
    bgIsColor: !bg || !!bg.isColor,
    bgHex: defaultBg,
    defaultBg,   // the viewer's original background, for a "reset to default" button
    setGrid(on: boolean) { for (const h of helpers) h.visible = on; },
    setBackground(hex: string) { scene.scene.background = new THREE.Color(hex); },
    restore() {
      helpers.forEach((h, i) => { h.visible = helperOrig[i]; });
      scene.scene.background = bgOrig;
    },
  };
}

// --- transparent capture ---------------------------------------------------
// The shared renderer has no alpha on its canvas (alpha:true broke context
// creation on some drivers), but a render target owns its OWN RGBA framebuffer,
// so we render the scene into one with a transparent clear and read it back.
let _stage: HTMLCanvasElement | null = null, _stageCtx: CanvasRenderingContext2D | null = null;

// One render target (+ readback buffer) per requested size, tiny LRU. During a
// transparent recording the live preview (≤720 long edge) and the capture (full
// resolution) alternate every frame — resizing a single shared target would
// destroy + reallocate its MSAA framebuffer dozens of times a second, which is
// exactly what made transparent GIF capture crawl.
const _rts = new Map<string, { rt: any; buf: Uint8Array }>();
function _rtFor(w: number, h: number): { rt: any; buf: Uint8Array } {
  const key = `${w}x${h}`;
  let e = _rts.get(key);
  if (e) { _rts.delete(key); _rts.set(key, e); return e; }   // refresh LRU order
  if (_rts.size >= 3) {   // sizes churn when the user edits the resolution
    const oldest = _rts.keys().next().value!;
    _rts.get(oldest)!.rt.dispose(); _rts.delete(oldest);
  }
  e = {
    rt: new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false, samples: 4,
    }),
    buf: new Uint8Array(w * h * 4),
  };
  e.rt.texture.colorSpace = THREE.SRGBColorSpace;   // HW sRGB-encode -> bytes match the canvas
  _rts.set(key, e);
  return e;
}

// Render ONE frame of the scene into an offscreen target and read it back as
// straight-alpha, top-down RGBA {data, width, height}. Save/render/restore is
// synchronous so the live view is untouched. Opaque materials give a==255
// (straight==premultiplied); only MSAA silhouette edges are coverage-
// premultiplied, so we un-premultiply those. transparent=false keeps the scene
// background (used by the offline video renderer for opaque frames — the live
// canvas can't be sampled deterministically). NOTE: readRenderTargetPixels is a
// synchronous GPU readback (~tens of ms at full res) — callers must not assume
// real-time.
export function renderCaptureFrame(scene3d: RenderSource, w: number, h: number,
  { transparent = true }: { transparent?: boolean } = {}): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const { renderer, scene, camera } = scene3d;
  const { rt, buf } = _rtFor(w, h);
  const pTarget = renderer.getRenderTarget(), pAlpha = renderer.getClearAlpha();
  const pBg = scene.background, pAspect = camera.aspect;
  if (transparent) {
    scene.background = null;            // else the background clears opaque
    renderer.setClearAlpha(0);
  }
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, camera);       // MSAA resolves at render() end
  const n = w * h * 4;
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  renderer.setRenderTarget(pTarget); renderer.setClearAlpha(pAlpha);
  scene.background = pBg; camera.aspect = pAspect; camera.updateProjectionMatrix();
  const out = new Uint8ClampedArray(n), row = w * 4;
  for (let y = 0; y < h; y++) {
    const s = (h - 1 - y) * row, d = y * row;   // GL bottom-up -> canvas top-down
    if (!transparent) {                          // opaque: rgb passthrough, solid alpha
      for (let x = 0; x < row; x += 4) {
        out[d + x] = buf[s + x]; out[d + x + 1] = buf[s + x + 1]; out[d + x + 2] = buf[s + x + 2]; out[d + x + 3] = 255;
      }
      continue;
    }
    for (let x = 0; x < row; x += 4) {
      const a = buf[s + x + 3];
      if (a === 0) continue;                     // out is zero-initialised
      if (a === 255) {
        out[d + x] = buf[s + x]; out[d + x + 1] = buf[s + x + 1]; out[d + x + 2] = buf[s + x + 2]; out[d + x + 3] = 255;
      } else {
        const inv = 255 / a;                     // straight = premultiplied / alpha
        out[d + x] = buf[s + x] * inv + 0.5; out[d + x + 1] = buf[s + x + 1] * inv + 0.5;
        out[d + x + 2] = buf[s + x + 2] * inv + 0.5; out[d + x + 3] = a;
      }
    }
  }
  return { data: out, width: w, height: h };
}

export function renderTransparentFrame(scene3d: RenderSource, w: number, h: number): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  return renderCaptureFrame(scene3d, w, h, { transparent: true });
}

function drawChecker(cctx: CanvasRenderingContext2D, w: number, h: number): void {   // photoshop-style transparency indicator (preview only)
  const s = 12;
  for (let y = 0; y < h; y += s) {
    for (let x = 0; x < w; x += s) {
      cctx.fillStyle = (((x / s) + (y / s)) & 1) ? '#31363d' : '#262b31';
      cctx.fillRect(x, y, s, s);
    }
  }
}

// Draw the shared renderer canvas (src) into a 2D composite `comp`, scaled, with
// an optional caption bar burned in. With { transparent, scene3d } the model is
// rendered on a transparent background instead (checkerboard shown only when
// `preview`; the readback is capped in preview mode, full-res when capturing).
// Returns the composite {w,h}.
export function drawComposite(cctx: CanvasRenderingContext2D, comp: HTMLCanvasElement, src: HTMLCanvasElement,
  { scale = 1, caption = '' as CaptionOpts | string, transparent = false, scene3d = null as any, preview = false }:
  { scale?: number; caption?: CaptionOpts | string; transparent?: boolean; scene3d?: any; preview?: boolean } = {}): { w: number; h: number } {
  const w = Math.max(2, Math.round(src.width * scale) & ~1);
  const h = Math.max(2, Math.round(src.height * scale) & ~1);
  if (comp.width !== w || comp.height !== h) { comp.width = w; comp.height = h; }
  cctx.clearRect(0, 0, w, h);
  if (transparent && scene3d) {
    const CAP = 720, longEdge = Math.max(w, h);
    const k = (preview && longEdge > CAP) ? CAP / longEdge : 1;   // cheap live preview; full-res on capture
    const rw = Math.max(2, Math.round(w * k) & ~1), rh = Math.max(2, Math.round(h * k) & ~1);
    const f = renderTransparentFrame(scene3d, rw, rh);
    if (!_stage) { _stage = document.createElement('canvas'); _stageCtx = _stage.getContext('2d'); }
    if (_stage.width !== rw || _stage.height !== rh) { _stage.width = rw; _stage.height = rh; }
    _stageCtx!.putImageData(new ImageData(f.data, rw, rh), 0, 0);
    if (preview) drawChecker(cctx, w, h);
    cctx.drawImage(_stage, 0, 0, w, h);   // straight-alpha; drawImage scales + composites correctly
  } else {
    cctx.drawImage(src, 0, 0, w, h);
  }
  drawCaption(cctx, w, h, caption);
  return { w, h };
}

// Caption box geometry for a style, used to place the text AND to hit-test drags.
// Position (x,y) and size are 0..1 fractions of the frame so they scale across
// resolutions. Sets ctx.font as a side effect (measureText needs it).
export function captionMetrics(ctx: CanvasRenderingContext2D, w: number, h: number,
  { text = '', font = 'system-ui, sans-serif', size = 0.05, x = 0.5, y = 0.92 }: CaptionOpts = {}) {
  const fontPx = Math.max(9, Math.round(h * size));
  ctx.font = `${fontPx}px ${font}`;
  const tw = Math.min(w - 6, ctx.measureText(text || ' ').width);
  const padX = fontPx * 0.55, padY = fontPx * 0.34;
  const cx = Math.round(x * w), cy = Math.round(y * h);
  const boxW = tw + padX * 2, boxH = fontPx + padY * 2;
  return { fontPx, cx, cy, boxX: cx - boxW / 2, boxY: cy - boxH / 2, boxW, boxH };
}

// Burn a caption onto a 2D context. `opts` is a string (text only) or
// { text, font, size, x, y, bg }. Shared by the screenshot + video composites
// and the transparent-GIF frame path.
export function drawCaption(ctx: CanvasRenderingContext2D, w: number, h: number, opts: CaptionOpts | string = {}): void {
  const o: CaptionOpts = typeof opts === 'string' ? { text: opts } : (opts || {});
  if (!o.text) return;
  ctx.save();
  const m = captionMetrics(ctx, w, h, o);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (o.bg !== false) {
    ctx.fillStyle = 'rgba(10,12,16,0.66)';
    const r = Math.min(9, m.fontPx * 0.3);
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(m.boxX, m.boxY, m.boxW, m.boxH, r); ctx.fill(); }
    else ctx.fillRect(m.boxX, m.boxY, m.boxW, m.boxH);
  }
  ctx.fillStyle = '#eef2f7';
  ctx.fillText(o.text, m.cx, m.cy, w - 8);
  ctx.restore();
}

const CAPTION_FONTS: [string, string][] = [
  ['system-ui, sans-serif', 'Sans'],
  ['Georgia, "Times New Roman", serif', 'Serif'],
  ['"Courier New", monospace', 'Mono'],
  ['Impact, Haettenschweiler, sans-serif', 'Impact'],
  ['"Comic Sans MS", "Segoe Print", cursive', 'Comic'],
];
export const CAPTION_DEFAULT: CaptionStyle = { font: 'system-ui, sans-serif', size: 0.05, x: 0.5, y: 0.92, bg: true };

// Caption-style controls (font · size · background · reset position). Returns
// the row element and a live `style` object; the modal calls onChange(save?) to
// repaint (and persist). The caption TEXT stays in the modal's own field.
export function makeCaptionControls(saved: Partial<CaptionStyle> = {}, onChange: (save?: boolean) => void = () => {}): { row: HTMLElement; style: CaptionStyle } {
  const style: CaptionStyle = { ...CAPTION_DEFAULT, ...saved };
  const fontSel = el('select', { class: 'btn-mini', title: 'Caption font' });
  for (const [v, l] of CAPTION_FONTS) fontSel.appendChild(el('option', { value: v, text: l }));
  fontSel.value = CAPTION_FONTS.some(([v]) => v === style.font) ? style.font : CAPTION_FONTS[0][0];
  style.font = fontSel.value;
  fontSel.addEventListener('change', () => { style.font = fontSel.value; onChange(true); });

  const SIZES: [number, string][] = [[0.035, 'S'], [0.05, 'M'], [0.07, 'L'], [0.1, 'XL']];
  const sizeSel = el('select', { class: 'btn-mini', title: 'Caption text size' });
  for (const [v, l] of SIZES) sizeSel.appendChild(el('option', { value: String(v), text: l }));
  sizeSel.value = String(SIZES.some(([v]) => v === style.size) ? style.size : 0.05);
  style.size = parseFloat(sizeSel.value);
  sizeSel.addEventListener('change', () => { style.size = parseFloat(sizeSel.value); onChange(true); });

  const bgCb = el('input', { type: 'checkbox', title: 'Caption background fill' });
  bgCb.checked = style.bg !== false;
  bgCb.addEventListener('change', () => { style.bg = bgCb.checked; onChange(true); });

  const resetBtn = el('button', { class: 'btn btn-mini', text: 'reset pos', title: 'Move the caption back to the bottom centre' });
  resetBtn.addEventListener('click', () => { style.x = CAPTION_DEFAULT.x; style.y = CAPTION_DEFAULT.y; onChange(true); });

  const row = el('label', { class: 'cap-style' },
    el('span', { text: 'Caption' }), fontSel, sizeSel,
    el('span', { class: 'sep-mini' }), bgCb, el('span', { text: 'bg' }),
    el('span', { class: 'sep-mini' }), resetBtn);
  return { row, style };
}

// Drag the caption on a preview canvas: pointerdown within the caption box starts
// a drag that updates style.x/y (0..1 fractions). getText() returns the current
// caption string (empty = nothing to drag, so normal orbiting is unaffected).
export function attachCaptionDrag(comp: HTMLCanvasElement, getText: () => string, style: CaptionStyle, onChange: (committed: boolean) => void): void {
  comp.addEventListener('pointerdown', (e) => {
    const text = getText();
    if (!text) return;
    const rect = comp.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * comp.width;
    const py = ((e.clientY - rect.top) / rect.height) * comp.height;
    const m = captionMetrics(comp.getContext('2d')!, comp.width, comp.height, { ...style, text });
    if (px < m.boxX - 8 || px > m.boxX + m.boxW + 8 || py < m.boxY - 8 || py > m.boxY + m.boxH + 8) return;
    // claim this pointer so a preview-orbit control on the SAME canvas (registered
    // after us) doesn't also rotate the camera while we drag the caption
    e.preventDefault(); e.stopImmediatePropagation();
    try { comp.setPointerCapture(e.pointerId); } catch { /* non-capturable */ }
    const move = (ev: PointerEvent) => {
      style.x = Math.max(0.03, Math.min(0.97, (ev.clientX - rect.left) / rect.width));
      style.y = Math.max(0.05, Math.min(0.97, (ev.clientY - rect.top) / rect.height));
      onChange(false);
    };
    const up = () => {
      comp.removeEventListener('pointermove', move);
      comp.removeEventListener('pointerup', up);
      onChange(true);
    };
    comp.addEventListener('pointermove', move);
    comp.addEventListener('pointerup', up);
  });
}

// Orbit / zoom the live scene by dragging (and wheeling) directly ON the preview
// canvas, so framing a capture never depends on reaching the dimmed 3D view
// behind the modal. A second OrbitControls bound to the preview shares the
// scene's camera + orbit target; the scene's own controls don't fight it because
// OrbitControls.update() recomputes from the LIVE camera each frame. Returns a
// dispose fn — call it on close. Coexists with attachCaptionDrag (which claims
// its caption box via stopImmediatePropagation) and the crop lines (separate DOM).
export function attachPreviewOrbit(comp: HTMLCanvasElement, scene: any): { dispose(): void; setEnabled(on: boolean): void } {
  const controls = new OrbitControls(scene.camera, comp);
  controls.enableDamping = true;
  controls.dampingFactor = scene.controls.dampingFactor;
  controls.target = scene.controls.target;   // share the orbit centre
  let enabled = true;
  // While a turntable recording drives the camera itself, this second controls
  // must NOT also update() the shared camera each frame — its damping would drag
  // the framing off-centre and fight the spin. setEnabled(false) parks it.
  const stopTick = scene.addTick(() => { if (enabled) controls.update(); });
  comp.style.cursor = 'grab';
  return {
    dispose() { stopTick(); controls.dispose(); },
    setEnabled(on: boolean) { enabled = on; controls.enabled = on; },
  };
}

// A draggable width-crop overlay for a preview canvas: two vertical guide lines
// (DOM overlays, so they're never baked into the capture and don't fight the
// orbit controls) with dimmed side panels. Returns the wrapper to place in the
// DOM, rect() giving the crop in `comp` PIXELS, the live cropL/cropR fractions,
// and lock() to freeze it while recording. onChange(committed) fires on drag.
export function makeCropOverlay(comp: HTMLCanvasElement,
  { cropL = 0, cropR = 1, onChange }: { cropL?: number; cropR?: number; onChange?: (committed: boolean) => void } = {}) {
  let l = Math.max(0, Math.min(0.45, cropL ?? 0));
  let r = Math.min(1, Math.max(l + 0.1, cropR ?? 1));
  const dimL = el('div', { class: 'video-crop-dim' });
  const dimR = el('div', { class: 'video-crop-dim' });
  const lineL = el('div', { class: 'video-crop-line', title: 'Drag to set the left edge of the output' });
  const lineR = el('div', { class: 'video-crop-line', title: 'Drag to set the right edge of the output' });
  const wrap = el('div', { class: 'video-crop-wrap' }, comp, dimL, dimR, lineL, lineR);
  const layout = () => {
    dimL.style.left = '0'; dimL.style.width = `${l * 100}%`;
    dimR.style.right = '0'; dimR.style.width = `${(1 - r) * 100}%`;
    lineL.style.left = `${l * 100}%`;
    lineR.style.left = `${r * 100}%`;
  };
  layout();
  const drag = (line: HTMLElement, isLeft: boolean) => line.addEventListener('pointerdown', (e) => {
    if (line.classList.contains('locked')) return;
    e.preventDefault();
    try { line.setPointerCapture(e.pointerId); } catch { /* non-capturable pointer */ }
    const rect = wrap.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const f = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const gap = 0.1;   // minimum output width
      if (isLeft) l = Math.max(0, Math.min(f, r - gap)); else r = Math.min(1, Math.max(f, l + gap));
      layout(); onChange?.(false);
    };
    const up = () => {
      try { line.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      line.removeEventListener('pointermove', move);
      line.removeEventListener('pointerup', up);
      onChange?.(true);
    };
    line.addEventListener('pointermove', move);
    line.addEventListener('pointerup', up);
  });
  drag(lineL, true); drag(lineR, false);
  return {
    wrap,
    get cropL() { return l; },
    get cropR() { return r; },
    rect() {
      const w = comp.width || 2;
      let x0 = Math.round(l * w) & ~1, x1 = Math.round(r * w) & ~1;
      x0 = Math.max(0, Math.min(w - 2, x0));
      x1 = Math.max(x0 + 2, Math.min(w, x1));
      return { x: x0, w: (x1 - x0) & ~1 || 2, h: comp.height || 2 };
    },
    lock(on: boolean) { [lineL, lineR].forEach((el2) => el2.classList.toggle('locked', on)); },
  };
}

// Tiny localStorage-backed settings bag shared by the modals.
export function settingsStore(key: string): { load(): any; save(obj: any): void } {
  return {
    load() { try { return JSON.parse(localStorage.getItem(key)!) || {}; } catch { return {}; } },
    save(obj: any) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* storage unavailable */ } },
  };
}

// ---- high-res tiled screenshot (shared: world + mesh/rig/model viewers) -----
// Long-edge targets. The capture re-renders the CURRENT camera framing at the
// target resolution by tiling camera.setViewOffset, streaming tiles one row at
// a time through fflate as PNG scanlines — no full-frame canvas ever exists, so
// 16K/32K/… stay under the browser's canvas dimension caps.
export const SHOT_RES: Record<string, { label: string; edge: number }> = {
  '2k': { label: '2K', edge: 1920 },
  '4k': { label: '4K', edge: 3840 },
  '8k': { label: '8K', edge: 7680 },
  '16k': { label: '16K', edge: 15360 },
  '32k': { label: '32K', edge: 30720 },
  '64k': { label: '64K', edge: 61440 },
  '128k': { label: '128K', edge: 122880 },
};

// scene3d: a Scene3D (renderer/scene/camera). filenameBase: '…-mesh-12' etc.
// onProgress reports per-tile; isAlive() lets the caller abort on view teardown.
// transparent: emit an RGBA PNG with the model on a clear background (each tile
// rendered offscreen with an alpha clear, mirroring the screenshot/video path);
// otherwise an opaque RGB PNG that keeps the scene background.
export async function captureTiledPng(
  scene3d: any, resKey: string, filenameBase: string,
  onProgress: (msg: string) => void, isAlive: () => boolean = () => true,
  transparent = false,
): Promise<{ name: string; size: number } | null> {
  if (!isAlive()) return null;
  const renderer = getRenderer();
  const camera = scene3d.camera.clone();
  try {
    const source: HTMLCanvasElement = renderer.domElement;
    const tileW = source.width;
    const tileH = source.height;
    const edge = (SHOT_RES[resKey] || SHOT_RES['8k']).edge;
    const scale = Math.max(1, Math.round(edge / Math.max(tileW, tileH)));
    const outW = tileW * scale;
    const outH = tileH * scale;

    const ch = transparent ? 4 : 3;   // RGBA keeps alpha; RGB drops it (opaque)
    const rtSource: RenderSource = { renderer, scene: scene3d.scene, camera };
    const tileCanvas = document.createElement('canvas');   // opaque path: canvas readback
    tileCanvas.width = tileW;
    tileCanvas.height = tileH;
    const tileCtx = tileCanvas.getContext('2d', { willReadFrequently: true })!;
    const parts: BlobPart[] = [...pngHeader(outW, outH, ch)];
    const zlib = new Zlib({ level: 6 }, (chunk: Uint8Array) => parts.push(pngChunk('IDAT', chunk)));
    const rowStride = outW * ch + 1;   // scanline = filter byte + row
    const scanlines = new Uint8Array(rowStride * tileH);
    for (let y = 0; y < tileH; y++) scanlines[y * rowStride] = 0;   // filter: none

    for (let row = 0; row < scale; row++) {
      for (let col = 0; col < scale; col++) {
        onProgress(`tile ${row * scale + col + 1}/${scale * scale}…`);
        camera.setViewOffset(outW, outH, col * tileW, row * tileH, tileW, tileH);
        let rgba: Uint8ClampedArray;
        if (transparent) {
          // offscreen RGBA render with a transparent clear (straight-alpha, top-down)
          rgba = renderCaptureFrame(rtSource, tileW, tileH, { transparent: true }).data;
        } else {
          renderer.render(scene3d.scene, camera);
          tileCtx.drawImage(source, 0, 0);   // same-task copy: tile still in the drawing buffer
          rgba = tileCtx.getImageData(0, 0, tileW, tileH).data;
        }
        for (let y = 0; y < tileH; y++) {
          let at = y * rowStride + 1 + col * tileW * ch;
          let px = y * tileW * 4;
          for (let x = 0; x < tileW; x++) {
            scanlines[at++] = rgba[px];
            scanlines[at++] = rgba[px + 1];
            scanlines[at++] = rgba[px + 2];
            if (transparent) scanlines[at++] = rgba[px + 3];
            px += 4;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));   // keep the tab breathing
        if (!isAlive()) return null;
      }
      zlib.push(scanlines.slice(), row === scale - 1);   // fflate keeps chunks — hand it a fresh copy
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!isAlive()) return null;
    }
    parts.push(pngChunk('IEND', new Uint8Array(0)));
    const blob = new Blob(parts, { type: 'image/png' });
    const name = `${filenameBase}-${outW}x${outH}.png`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    return { name, size: blob.size };
  } catch {
    return null;
  } finally {
    camera.clearViewOffset();
  }
}
