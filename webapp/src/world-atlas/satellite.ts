// Satellite view of the world map: pictures of every room taken straight
// down, served as a tile pyramid on the map's own grid, so they line up with
// the map exactly. Level L's tiles are `tile` pixels square and span 2^L map
// tiles each; tile (x, y) starts at map tile (x * 2^L, y * 2^L). The index
// lists the tiles that exist (empty sea and sky have none), so nothing is
// fetched that is not there.
//
// Drawn on its own 2D canvas under the map's canvas: in satellite view the
// map draws its labels only, over the pictures. A tile still loading is
// stood in for by the nearest coarser tile already here.
import type { MapCamera } from '../viewers/maps/pan-zoom.js';

export interface SatelliteIndex { format: 1; tile: number; levels: Record<string, number[]> }
export interface SatelliteSource { base: string; index: SatelliteIndex }
interface View { camera: MapCamera; width: number; height: number; dpr: number }

const CACHE = 256;       // decoded tiles kept (a 256 px tile is 256 KB)
const PARALLEL = 6;      // downloads at once
const SETTLE_MS = 150;   // a level newly reached is fetched once it has held this long

export class SatelliteLayer {
  private source: SatelliteSource | null = null;
  private exists = new Map<number, Set<string>>();
  private levels: number[] = [];
  private tiles = new Map<string, ImageBitmap>();   // url -> picture, oldest first
  private loading = new Map<string, AbortController>();
  /** The level the view last drew at, and since when (a zoom passes through levels). */
  private level = -1;
  private levelSince = 0;
  private settle = 0;
  private failed = new Set<string>();
  private wanted: string[] = [];
  private warm: string[] = [];   // the coarsest tiles, fetched early: stand-ins are then always here
  /** Tiles drawn in the last frame, at their own level or a stand-in (tests read it). */
  readonly stats = { drawn: 0, standIns: 0 };

  constructor(private canvas: HTMLCanvasElement, private onLoad: () => void) {}

  /** The pictures to show (null: none). */
  setSource(source: SatelliteSource | null) {
    if (source?.base === this.source?.base) return;
    this.source = source;
    this.exists = new Map(Object.entries(source?.index.levels ?? {}).map(([level, list]) => {
      const set = new Set<string>();
      for (let i = 0; i + 1 < list.length; i += 2) set.add(`${list[i]}_${list[i + 1]}`);
      return [Number(level), set];
    }));
    this.levels = [...this.exists.keys()].sort((a, b) => a - b);
    this.wanted = [];
    this.warm = this.levels.slice(-2).flatMap((level) => [...this.exists.get(level)!].map((xy) => `${source!.base}${level}/${xy}.webp`));
    this.pump();
  }
  get ready(): boolean { return !!this.source && this.levels.length > 0; }

  private url(level: number, x: number, y: number) { return `${this.source!.base}${level}/${x}_${y}.webp`; }
  /** The level whose pixels best match the screen's at this scale (px per map tile). */
  private levelFor(pxPerTile: number): number {
    const tile = this.source!.index.tile, want = Math.floor(Math.log2(tile / pxPerTile));
    return this.levels.find((l) => l >= want) ?? this.levels.at(-1)!;
  }

  /** Draw the view into this layer's canvas (null: clear it). */
  draw(view: View | null) {
    const { canvas } = this;
    const w = Math.round((view?.width ?? 0) * (view?.dpr ?? 1)), h = Math.round((view?.height ?? 0) * (view?.dpr ?? 1));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    this.stats.drawn = 0; this.stats.standIns = 0;
    if (!view || !this.ready || !w || !h) return;
    this.paint(ctx, view.camera, w, h, view.camera.scale * view.dpr, true);
  }
  /** A small picture of the view (the view switch's thumbnail). */
  drawInto(ctx: CanvasRenderingContext2D, camera: MapCamera, w: number, h: number) {
    ctx.clearRect(0, 0, w, h);
    if (this.ready) this.paint(ctx, camera, w, h, camera.scale, false);
  }

  private paint(ctx: CanvasRenderingContext2D, camera: MapCamera, w: number, h: number, scale: number, main: boolean) {
    const level = this.levelFor(scale), span = 2 ** level;
    const left = camera.cx - w / 2 / scale, top = camera.cy - h / 2 / scale;
    const x0 = Math.floor(left / span), y0 = Math.floor(top / span);
    const x1 = Math.floor((left + w / scale) / span), y1 = Math.floor((top + h / scale) / span);
    const px = (mapX: number) => Math.round((mapX - left) * scale), py = (mapY: number) => Math.round((mapY - top) * scale);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const wanted: string[] = [], tile = this.source!.index.tile;
    // centre first: the middle of the screen fills in before its edges
    const order: [number, number][] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) order.push([x, y]);
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    order.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my));
    for (const [x, y] of order) {
      if (!this.exists.get(level)?.has(`${x}_${y}`)) continue;
      const dx = px(x * span), dy = py(y * span), dw = px((x + 1) * span) - dx, dh = py((y + 1) * span) - dy;
      const url = this.url(level, x, y), bitmap = this.take(url);
      if (bitmap) { ctx.drawImage(bitmap, dx, dy, dw, dh); if (main) this.stats.drawn++; continue; }
      if (!this.failed.has(url)) wanted.push(url);
      // a coarser tile that is here stands in, cut to this tile's square
      for (const up of this.levels) {
        if (up <= level) continue;
        const k = 2 ** (up - level), ux = Math.floor(x / k), uy = Math.floor(y / k);
        const parent = this.take(this.url(up, ux, uy));
        if (!parent) continue;
        const part = tile / k;
        ctx.drawImage(parent, (x - ux * k) * part, (y - uy * k) * part, part, part, dx, dy, dw, dh);
        if (main) this.stats.standIns++;
        break;
      }
    }
    if (main) {
      this.wanted = wanted;
      // a zoom passes through levels: tiles of a level only fetch once the
      // view has stayed at it (the coarser tiles stand in meanwhile), and
      // downloads for levels it has left are dropped
      const now = performance.now();
      if (level !== this.level) { this.level = level; this.levelSince = now; }
      for (const [url, abort] of this.loading) if (!url.startsWith(`${this.source!.base}${level}/`) && !this.warm.includes(url)) abort.abort();
      const wait = this.levelSince + SETTLE_MS - now;
      clearTimeout(this.settle);
      if (wait > 0) this.settle = window.setTimeout(() => this.pump(), wait);
      else this.pump();
    }
    else for (const url of wanted) if (!this.wanted.includes(url)) this.wanted.push(url);
    if (!main) this.pump();
  }
  /** A decoded tile, marked as just used. */
  private take(url: string): ImageBitmap | undefined {
    const bitmap = this.tiles.get(url);
    if (bitmap) { this.tiles.delete(url); this.tiles.set(url, bitmap); }
    return bitmap;
  }
  private pump() {
    // the view's own tiles once its level has settled; the coarse warm-up any time
    const settled = performance.now() >= this.levelSince + SETTLE_MS;
    while (this.loading.size < PARALLEL && ((settled && this.wanted.length) || this.warm.length)) {
      const url = (settled ? this.wanted.shift() : undefined) ?? this.warm.shift()!;
      if (this.loading.has(url) || this.tiles.has(url)) continue;
      const abort = new AbortController();
      this.loading.set(url, abort);
      fetch(url, { signal: abort.signal }).then((r) => {
        // a missing file can come back as the site's page: never a picture
        if (!r.ok || /text\/html/.test(r.headers.get('content-type') ?? '')) throw Error(`${url}: HTTP ${r.status}`);
        return r.blob();
      }).then((blob) => createImageBitmap(blob)).then((bitmap) => {
        this.tiles.set(url, bitmap);
        while (this.tiles.size > CACHE) { const [old, b] = this.tiles.entries().next().value!; b.close(); this.tiles.delete(old); }
        this.onLoad();
      }).catch((error) => { if (!abort.signal.aborted) this.failed.add(url); void error; })
        .finally(() => { this.loading.delete(url); if (this.source) this.pump(); });
    }
  }
}
