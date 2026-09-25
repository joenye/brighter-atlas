// The game's own programs, read from the user's shader bundles through the
// service worker and translated to GLSL (dxbc-glsl.ts), cached per
// (program, y convention); game-frame.ts draws them through game-gl.ts.
import { translate, type TranslatedProgram, type YConvention } from './dxbc-glsl.js';

/** The world index's render tables (see extract/world/render-data.ts). */
export interface GameRenderTables {
  programs: number[][];
  vertexShaders: number[][];
  pixelShaders: number[][];
  samplers: number[][];
  blends: number[][];
}

export interface GameProgram {
  index: number;
  vertex: number;
  pixel: number;
  y: YConvention;
  translated: TranslatedProgram;
  /** Engine vertex formats of the vertex shader's elements. */
  elements: number[];
  /** Sampler description of each pixel shader binding (null: fetch only). */
  samplers: (number[] | null)[];
}

const pad5 = (n: number) => String(n).padStart(5, '0');

export class GameShaderLibrary {
  private readonly blobs = new Map<string, Promise<Uint8Array>>();
  private readonly programs = new Map<string, Promise<GameProgram>>();

  /** `zeroToOne`: programs draw with EXT_clip_control's ZERO_TO_ONE depth range (the source's own). */
  constructor(private readonly url: (rel: string) => string, readonly tables: GameRenderTables,
    private readonly zeroToOne = false) {}

  blob(stage: 'vs' | 'ps', ordinal: number): Promise<Uint8Array> {
    const key = `${stage}${ordinal}`;
    let p = this.blobs.get(key);
    if (!p) {
      p = fetch(this.url(`shaders/${stage}_${pad5(ordinal)}.dxbc`)).then(async (r) => {
        if (!r.ok) throw new Error(`shader ${stage} ${ordinal}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      });
      p.catch(() => this.blobs.delete(key));
      this.blobs.set(key, p);
    }
    return p;
  }

  program(index: number, y: YConvention = 'fragcoord'): Promise<GameProgram> {
    const key = `${index}:${y}`;
    let p = this.programs.get(key);
    if (!p) {
      p = this.build(index, y);
      p.catch(() => this.programs.delete(key));
      this.programs.set(key, p);
    }
    return p;
  }

  private async build(index: number, y: YConvention): Promise<GameProgram> {
    const row = this.tables.programs[index];
    if (!row) throw new Error(`no program ${index}`);
    const [vertex, pixel] = row;
    const [vs, ps] = await Promise.all([this.blob('vs', vertex), this.blob('ps', pixel)]);
    const translated = translate(vs, ps, { y, depth: this.zeroToOne ? 'zeroToOne' : 'negativeOneToOne' });
    const samplers = (this.tables.pixelShaders[pixel] ?? []).map((s) => (s >= 0 ? this.tables.samplers[s] : null));
    return {
      index, vertex, pixel, y, translated,
      elements: this.tables.vertexShaders[vertex] ?? [],
      samplers,
    };
  }
}

/** Write float values into a constant buffer's words at a byte offset. */
export function putFloats(words: Uint32Array, byteOffset: number, values: ArrayLike<number>): void {
  const f = new Float32Array(words.buffer, words.byteOffset, words.length);
  const at = byteOffset >> 2;
  // A shader declares only the registers it reads: drop values past its buffer.
  for (let k = 0; k < values.length && at + k < f.length; k++) f[at + k] = values[k];
}
