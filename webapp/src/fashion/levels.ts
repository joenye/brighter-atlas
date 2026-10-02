// A place's textures for the game's frame (GameFrame's level source): one file per texture (levels-format.ts),
// fetched once and prepared in workers (levels-worker.ts), its levels then handed out as the frame asks. A
// texture is let go a little after it was last asked for (the frame keeps what it uploaded).
import type { TextureLevel } from '../viewers/world/game-frame.js';
import type { Level } from './levels-format.js';

const KEEP_MS = 10000;

export class TextureLevels {
  private files = new Map<number, { levels: Promise<Level[]>; timer: number }>();
  private workers: Worker[] = [];
  private turn = 0;
  private jobs = new Map<number, { resolve: (l: Level[]) => void; reject: (e: Error) => void }>();
  private seq = 0;

  /** `url`: a texture's file; `decode`: pixels for a GPU without the block formats, from `webUrl`'s WebP file
   *  where there is one (a sixth of the blocks' bytes), else from the blocks. */
  constructor(private readonly url: (image: number) => string, private readonly decode: boolean, private readonly webUrl?: (image: number) => string) {}
  private web = true;   // (off for the visit once a WebP file fails: the blocks then, as before)

  readonly level = async (image: number, sub: number): Promise<TextureLevel> => {
    let f = this.files.get(image);
    if (!f) {
      f = { levels: this.load(image), timer: 0 };
      this.files.set(image, f);
      f.levels.catch(() => this.files.delete(image));
    }
    clearTimeout(f.timer);
    f.timer = window.setTimeout(() => this.files.delete(image), KEEP_MS);
    const l = (await f.levels)[sub];
    if (!l) throw new Error(`image ${image} sub ${sub}: none`);
    return l;
  };

  private async load(image: number): Promise<Level[]> {
    if (this.decode && this.webUrl && this.web) {
      try { return await this.prepare(await this.fetch(this.webUrl(image), image)); }
      catch (e) { if (!(e instanceof Error && e.message === 'let go')) { this.web = false; console.warn('web textures off:', e); } else throw e; }
    }
    return this.prepare(await this.fetch(this.url(image), image));
  }

  private async fetch(url: string, image: number): Promise<ArrayBuffer> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`image ${image}: ${r.status}`);
    return r.arrayBuffer();
  }

  private prepare(file: ArrayBuffer): Promise<Level[]> {
    if (!this.workers.length) {
      const n = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
      for (let k = 0; k < n; k++) {
        const w = new Worker(new URL('/js/fashion/levels-worker.js', location.href), { type: 'module' });
        w.onmessage = (e) => {
          const job = this.jobs.get(e.data.id); this.jobs.delete(e.data.id);
          if (e.data.error) job?.reject(new Error(e.data.error)); else job?.resolve(e.data.levels);
        };
        this.workers.push(w);
      }
    }
    const id = ++this.seq;
    return new Promise<Level[]>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.workers[this.turn++ % this.workers.length].postMessage({ id, file, decode: this.decode }, [file]);
    });
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const job of this.jobs.values()) job.reject(new Error('let go'));
    this.jobs.clear();
    for (const f of this.files.values()) clearTimeout(f.timer);
    this.files.clear();
  }
}
