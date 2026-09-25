// The graphics header of assetBundle0: how the game draws. It sits in two
// runs around the mesh and clip directories:
//
//   texture_dir | layouts, constant layouts, blends, depths, stencils,
//                 samplers, tag sets | mesh_dir, anim_dir |
//   vertex shaders, pixel shaders, shader pairs, two state sets, programs | ab2_classes
//
// Vertex shaders are the objects of assetBundle7 and pixel shaders those of
// assetBundle4, in order. Varints are 7 bits per byte, low group first.

export interface ConstantItem { kind: number; def: number; count?: number }
export interface TextureItem { sampler: number }

export interface GraphicsHeader {
  /** Vertex layouts: the engine vertex format of each element. */
  layouts: { formats: number[] }[];
  /** Blend states as stored: six signed bytes each. */
  blends: number[][];
  depths: { comparison: number; write: number }[];
  /** Sampler states as stored: packed flags. */
  samplers: number[];
  vertexShaders: { layouts: number[]; constants: ConstantItem[]; textures: TextureItem[] }[];
  pixelShaders: { constants: ConstantItem[]; textures: TextureItem[]; outputs: number[] }[];
  /** [vertex shader, pixel shader]. */
  pairs: [number, number][];
  programs: { pair: number; indexFormat: number; depth: number; cull: number; blend: number }[];
}

class Reader {
  constructor(readonly b: Uint8Array, public p: number) {}
  u8(): number { if (this.p >= this.b.length) throw new Error('graphics header overrun'); return this.b[this.p++]; }
  s8(): number { const v = this.u8(); return v > 127 ? v - 256 : v; }
  vi(): number {
    let n = 0, mul = 1;
    for (;;) {
      const x = this.u8();
      n += (x & 127) * mul;
      if (x < 128) return n;
      mul *= 128;
      if (mul > 2 ** 35) throw new Error('graphics header varint');
    }
  }
  u32be(): number { const v = ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0; return v; }
  u32le(): number { const v = (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>> 0; return v; }
  skip(n: number): void { this.p += n; if (this.p > this.b.length) throw new Error('graphics header overrun'); }
  list<T>(n: number, f: () => T): T[] {
    if (n > 1 << 20) throw new Error('graphics header count');
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(f());
    return out;
  }
}

function constants(r: Reader): ConstantItem[] {
  return r.list(r.u8(), () => {
    const kind = r.u8(), def = r.vi(), item: ConstantItem = { kind, def };
    if (kind > 2) throw new Error(`graphics header: constant kind ${kind}`);
    if (kind === 0 || kind === 2) item.count = r.vi();
    if (kind === 1 || kind === 2) { r.vi(); r.u8(); }
    return item;
  });
}

function textures(r: Reader): TextureItem[] {
  return r.list(r.u8(), () => { r.u8(); r.u8(); const sampler = r.vi() - 1; r.u8(); return { sampler }; });
}

/**
 * Parses both runs; null when either does not end exactly where the next
 * directory begins (then this build draws with the viewer's own shading).
 * start: end of texture_dir; meshStart: start of mesh_dir; animEnd: end of
 * anim_dir; classStart: start of ab2_classes.
 */
export function parseGraphicsHeader(u8: Uint8Array, start: number, meshStart: number,
  animEnd: number, classStart: number): GraphicsHeader | null {
  try {
    const r = new Reader(u8, start);
    const layouts = r.list(r.vi(), () => {
      const formats = r.list(r.u8(), () => r.u8());
      r.skip(11);   // semantic slots
      return { formats };
    });
    for (let i = 0; i < layouts.length; i++) r.list(r.vi(), () => [r.vi(), r.vi()]);
    r.list(r.vi(), () => r.skip(r.u32be()));   // constant layouts
    const blends = r.list(r.vi(), () => r.list(6, () => r.s8()));
    const depths = r.list(r.vi(), () => ({ comparison: r.s8(), write: r.u8() }));
    if (r.vi() !== 0) return null;   // stencil states: none in any build seen
    const samplers = r.list(r.vi(), () => r.u32le());
    r.list(r.vi(), () => r.vi());
    if (r.p !== meshStart) return null;

    r.p = animEnd;
    const vertexShaders = r.list(r.vi(), () => {
      const slots = r.list(r.u8(), () => { const layout = r.vi(); r.u8(); return layout; });
      return { layouts: slots, constants: constants(r), textures: textures(r) };
    });
    const pixelShaders = r.list(r.vi(), () => {
      const c = constants(r), t = textures(r), outputs = r.list(r.u8(), () => r.s8());
      r.skip(6);   // alpha to coverage, mask, flag
      return { constants: c, textures: t, outputs };
    });
    const pairs = r.list(r.vi(), () => [r.vi(), r.vi()] as [number, number]);
    r.list(r.vi(), () => { r.u8(); r.skip(r.u8()); r.skip(r.u8()); });
    r.list(r.vi(), () => { r.skip(r.u8()); r.s8(); r.vi(); });
    const programs = r.list(r.vi(), () => {
      const pair = r.vi(), indexFormat = r.s8();
      r.skip(4);   // write mask
      r.s8();      // topology
      r.vi();      // stencil
      const depth = r.vi() - 1, cull = r.s8(), blend = r.vi() - 1;
      r.u8();      // alpha to coverage
      return { pair, indexFormat, depth, cull, blend };
    });
    if (r.p !== classStart) return null;
    const ok = programs.every((p) => p.pair < pairs.length && p.depth < depths.length && p.blend < blends.length)
      && pairs.every(([v, p]) => v < vertexShaders.length && p < pixelShaders.length)
      && vertexShaders.every((v) => v.layouts.every((l) => l < layouts.length))
      && [...vertexShaders, ...pixelShaders].every((s) => s.textures.every((t) => t.sampler < samplers.length));
    return ok ? { layouts, blends, depths, samplers, vertexShaders, pixelShaders, pairs, programs } : null;
  } catch {
    return null;
  }
}
