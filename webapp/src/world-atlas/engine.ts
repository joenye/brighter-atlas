// The world map's drawing: the map renderer and its camera (pan, pinch, zoom), the satellite pictures under it,
// the sealed areas' fog over it, and the live thumbnail of the other view in the corner switch. It knows no
// page: the component (WorldMap.tsx) hands it its elements and says what to show.
import { MapRenderer } from '../viewers/maps/renderer.js';
import { attachPanZoom, fitCamera, type MapCamera } from '../viewers/maps/pan-zoom.js';
import { SealedLayer } from './sealed.js';
import { SatelliteLayer, type SatelliteSource } from './satellite.js';
import type { WorldMap } from './data.js';

export interface MapElements { host: HTMLElement; canvas: HTMLCanvasElement; satellite: HTMLCanvasElement; fog: HTMLCanvasElement; sealed: HTMLElement; thumb: HTMLCanvasElement }

export class MapView {
  readonly camera: MapCamera = { cx: 0, cy: 0, scale: 1 };
  renderer: MapRenderer | null = null;
  /** what is shown: labels, the satellite view, whether the corner switch (and so its thumbnail) is there */
  labels = true;
  satelliteView = false;
  thumbShown = false;
  /** the pictures the satellite layer holds (release and roofs), null for none */
  satelliteFor: string | null = null;
  private readonly sealed: SealedLayer;
  private readonly satellite: SatelliteLayer;
  private readonly panZoom: ReturnType<typeof attachPanZoom>;
  private readonly resize: ResizeObserver;
  private raf = 0;
  private thumbTimer = 0;
  private dead = false;

  /** `moved`: the camera moved (by the visitor, or fitted) */
  constructor(private readonly els: MapElements, private readonly moved: () => void) {
    this.sealed = new SealedLayer(els.fog, els.sealed,
      () => ({ camera: this.camera, width: els.host.clientWidth, height: els.host.clientHeight, dpr: devicePixelRatio }));
    this.satellite = new SatelliteLayer(els.satellite, () => this.requestDraw());
    this.panZoom = attachPanZoom(els.canvas, els.host, this.camera, { changed: () => { this.requestDraw(); moved(); }, fit: () => this.fit() });
    this.resize = new ResizeObserver(() => this.requestDraw());
    this.resize.observe(els.host);
  }

  /** Satellite pictures are on screen: chosen, and the map shown has them (`key`: its release and roofs). */
  picturesShown(key: string | null): boolean { return this.satelliteView && !!key && this.satelliteFor === key && this.satellite.ready; }
  private shownKey: string | null = null;

  /** The map of a release; `fit` frames the whole world. */
  setMap(map: WorldMap, key: string, fit: boolean) {
    this.shownKey = key;
    this.sealed.setAreas(map.sealed);
    if (!this.renderer) { this.renderer = new MapRenderer(this.els.canvas, map.doc); this.renderer.setRooms(null); }
    else this.renderer.setDoc(map.doc);
    if (fit) this.fit();
    this.requestDraw();
  }
  /** The key of the pictures a release shows now (it changes with the roofs switch). */
  setShownKey(key: string | null) { this.shownKey = key; this.requestDraw(); }
  setSatellite(source: SatelliteSource | null, key: string) {
    this.satellite.setSource(source); this.satelliteFor = source ? key : null;
    this.requestDraw();
  }

  requestDraw = () => { if (!this.raf && !this.dead) this.raf = requestAnimationFrame(() => this.draw()); };
  draw() {
    this.raf = 0;
    const { renderer, camera, els } = this;
    if (!renderer || this.dead) return;
    this.sealed.draw();
    const view = { ...camera, width: els.host.clientWidth, height: els.host.clientHeight, dpr: devicePixelRatio };
    const pictures = this.picturesShown(this.shownKey);
    this.satellite.draw(pictures ? { camera, width: view.width, height: view.height, dpr: view.dpr } : null);
    renderer.draw({ ...view, labels: this.labels, terrain: !pictures });
    const root = document.documentElement.dataset;   // for tests and scripts
    root.tiles = String(renderer.stats.terrainTiles);
    root.view = pictures ? 'satellite' : 'map';
    root.pictures = String(pictures ? this.satellite.stats.drawn : 0);
    clearTimeout(this.thumbTimer); this.thumbTimer = window.setTimeout(() => this.drawThumb(), 120);
  }
  fit() {
    if (!this.renderer) return;
    const b = this.renderer.bounds(this.labels), s = this.sealed.bounds();
    const x0 = Math.min(b.x, s?.x ?? Infinity), y0 = Math.min(b.y, s?.y ?? Infinity);
    const x1 = Math.max(b.x + b.width, s ? s.x + s.width : -Infinity), y1 = Math.max(b.y + b.height, s ? s.y + s.height : -Infinity);
    fitCamera(this.camera, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, this.els.host.clientWidth, this.els.host.clientHeight, .95);
    this.requestDraw(); this.moved();
  }
  zoomBy(k: number) { this.panZoom.zoomBy(k); }

  // the corner switch's thumbnail: the OTHER view around the middle of the screen
  private drawThumb() {
    const { renderer, camera, els } = this;
    if (!renderer || !this.thumbShown) return;
    const dpr = devicePixelRatio, size = Math.round(els.thumb.clientWidth * dpr);
    if (!size) return;
    if (els.thumb.width !== size || els.thumb.height !== size) { els.thumb.width = size; els.thumb.height = size; }
    const g = els.thumb.getContext('2d')!;
    // it spans a third of the screen's shorter side
    const span = Math.min(els.host.clientWidth, els.host.clientHeight) / 3 / camera.scale;   // map tiles
    if (!this.satelliteView) { this.satellite.drawInto(g, { cx: camera.cx, cy: camera.cy, scale: size / span }, size, size); return; }
    // satellite view: the map's own terrain, drawn for a moment and copied in the same task (the frame is put
    // back before the browser shows anything)
    const w = els.host.clientWidth, h = els.host.clientHeight;
    renderer.draw({ ...camera, width: w, height: h, dpr, labels: false, terrain: true });
    const side = span * camera.scale * dpr, main = renderer.canvas;
    g.fillStyle = '#0e1014'; g.fillRect(0, 0, size, size);
    g.drawImage(main, (main.width - side) / 2, (main.height - side) / 2, side, side, 0, 0, size, size);
    renderer.draw({ ...camera, width: w, height: h, dpr, labels: this.labels, terrain: !this.picturesShown(this.shownKey) });
  }

  /** Let go: nothing more drawn or loaded, the GPU freed. */
  destroy() {
    this.dead = true; cancelAnimationFrame(this.raf); clearTimeout(this.thumbTimer);
    this.resize.disconnect(); this.panZoom.destroy(); this.renderer?.destroy(); this.renderer = null;
    this.sealed.destroy(); this.satellite.destroy();
  }
}
