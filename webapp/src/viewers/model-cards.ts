// Card pictures for models: the picture the game shows on an item's,
// character's or creature's information card, drawn with the game's own
// programs (world/card.ts) from the card each model carries ('model:cards',
// written by World extraction). One hidden WebGL2 canvas serves every card:
// renders run one at a time, list thumbnails are drawn when their row comes
// into view and kept per version.

import { renderCard, CARD_WIDTH, CARD_HEIGHT, type CardSubject, type CardView } from './world/card.js';
import { derivedGet, derivedPut } from '../storage.js';

/** The card's own backdrop: a vertical ramp from near black to dark grey. */
const BACKDROP_TOP = [12, 11, 12], BACKDROP_BOTTOM = [44, 43, 45];
const THUMB_SCALE = 0.4;

export type CardBackdrop = 'card' | 'none';

class ModelCards {
  private doc: Promise<any> | null = null;
  private world: Promise<any> | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private thumbs = new Map<string, Promise<string | null>>();
  private observer: IntersectionObserver | null = null;
  private pending = new WeakMap<Element, string>();

  constructor(private readonly store: any) {}

  private cards(): Promise<any> {
    if (!this.doc) this.doc = (this.store.modelCards?.() ?? Promise.resolve(null)).catch(() => null);
    return this.doc!;
  }

  private worldIndex(): Promise<any> {
    if (!this.world) this.world = this.store.worldIndex().catch(() => null);
    return this.world!;
  }

  /** The model's card, or null (no World extraction, or no card). */
  async card(modelId: string): Promise<any | null> {
    const doc = await this.cards();
    return doc?.cards?.[modelId] ?? null;
  }

  private context(): WebGL2RenderingContext | null {
    if (!this.gl) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      this.gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
    }
    return this.gl;
  }

  /** Draw a model's card at `scale` times its 372 x 255 reference size
   *  (`icon`: the square second view). null when it has none. */
  render(modelId: string, scale: number, backdrop: CardBackdrop = 'card', icon = false): Promise<HTMLCanvasElement | null> {
    const job = this.queue.then(async () => {
      const card = await this.card(modelId);
      const index = await this.worldIndex();
      const gl = this.context();
      if (!card || !index?.render || !gl) return null;
      const subject: CardSubject = { ...card.subject, parts: card.parts };
      const view: CardView = { ...card.view, icon: icon ? { pan: card.view.panB, zoom: card.view.zoomB } : null };
      const tileUnits = Number(index.coordinate_system?.tile_units) || 1024;
      const image = await renderCard({
        gl, url: (rel: string) => this.store.url(rel), payload: (rel: string) => this.store.payload(rel),
        render: index.render, tileUnits, textureMeta: (id: number) => index.textures?.[String(id)] ?? null,
      }, subject, view, scale);
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const g = canvas.getContext('2d')!;
      if (backdrop === 'card') {
        const ramp = g.createLinearGradient(0, 0, 0, image.height);
        ramp.addColorStop(0, `rgb(${BACKDROP_TOP.join(',')})`);
        ramp.addColorStop(1, `rgb(${BACKDROP_BOTTOM.join(',')})`);
        g.fillStyle = ramp; g.fillRect(0, 0, image.width, image.height);
      }
      const picture = document.createElement('canvas');
      picture.width = image.width; picture.height = image.height;
      const pg = picture.getContext('2d')!;
      const data = pg.createImageData(image.width, image.height);
      data.data.set(image.rgba);
      pg.putImageData(data, 0, 0);
      g.drawImage(picture, 0, 0);
      return canvas;
    });
    this.queue = job.catch(() => null);
    return job;
  }

  /** A small card picture for list rows (data URL), kept for the version. */
  thumbnail(modelId: string): Promise<string | null> {
    let p = this.thumbs.get(modelId);
    if (!p) {
      p = (async () => {
        const key = `card:thumb:${modelId}`;
        const versionId = this.store.versionId;
        const cached = versionId ? await derivedGet(versionId, key).catch(() => null) : null;
        if (typeof cached === 'string') return cached;
        const canvas = await this.render(modelId, THUMB_SCALE, 'card').catch(() => null);
        if (!canvas) return null;
        const url = canvas.toDataURL('image/webp', 0.85);
        if (versionId) derivedPut(versionId, key, url).catch(() => {});
        return url;
      })();
      this.thumbs.set(modelId, p);
    }
    return p;
  }

  /** Fill `host` with the model's card thumbnail once it scrolls into view. */
  attachThumbnail(host: HTMLElement, modelId: string): void {
    if (!this.observer) {
      this.observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const target = e.target as HTMLElement;
          const id = this.pending.get(target);
          this.observer!.unobserve(target);
          if (!id) continue;
          this.pending.delete(target);
          this.thumbnail(id).then((url) => {
            if (!url || target.dataset.card !== id) { if (!url) target.classList.add('r-card-none'); return; }
            const img = document.createElement('img');
            img.src = url; img.alt = '';
            target.replaceChildren(img);
          });
        }
      }, { rootMargin: '200px' });
    }
    host.dataset.card = modelId;
    this.pending.set(host, modelId);
    this.observer.observe(host);
  }
}

let shared: { versionId: string | null; cards: ModelCards } | null = null;

/** The card pictures of the active version. */
export function modelCards(store: any): ModelCards {
  if (!shared || shared.versionId !== store.versionId) shared = { versionId: store.versionId ?? null, cards: new ModelCards(store) };
  return shared.cards;
}

export { CARD_WIDTH, CARD_HEIGHT };
