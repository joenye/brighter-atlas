// A small WebGL2 layer for drawing with the game's translated programs:
// sampler objects carry the source's sampler state exactly (filters,
// addressing, comparison, LOD range), textures keep their authored mip
// count, integer and depth targets render per mip level, and every draw sets
// its full pipeline state. It shares the page's WebGL2 context with three.js;
// callers reset three's cached state afterwards (renderer.resetState()).
import type { TranslatedProgram, AttributeBinding } from './dxbc-glsl.js';

export interface GameGLProgram {
  program: WebGLProgram;
  translated: TranslatedProgram;
  attributes: Map<string, number>;
  uniforms: Map<string, WebGLUniformLocation>;
  /** Texture unit of each sampler uniform. */
  units: Map<string, number>;
  /** Constant buffers drawn from uniform buffers: each one's binding point and size in bytes. */
  blocks: Map<string, { point: number; bytes: number }>;
}

/** The units a material's planes take by role (game-frame: the frame's own textures keep units 11 to 15). */
const MATERIAL_UNITS: Record<string, number> = { v_texture_albedo_plane: 0, v_texture_normal_plane: 1, v_texture_specular_plane: 2, v_texture_recol_plane: 3 };

/** Uniform buffer binding points: a vertex stage's constant buffer slot s at s, a pixel stage's at 12 + s. */
const PIXEL_BLOCKS = 12;

export interface GameTexture {
  texture: WebGLTexture;
  target: number;            // TEXTURE_2D, TEXTURE_CUBE_MAP or TEXTURE_2D_ARRAY
  width: number;
  height: number;
  /** A plane's texture: what it was made from (all rooms: the same levels again as a layer of an array). */
  plane?: { image: number; subs: number[]; srgb: boolean; format: number; levels: number };
}

export interface DrawState {
  depthTest: boolean;
  depthFunc: number;         // GL enum
  depthWrite: boolean;
  /** [equation, src, dst, alpha equation, alpha src, alpha dst] as GL enums, or null. */
  blend: number[] | null;
  cull: number | null;       // GL FRONT / BACK, or null for none
  colourWrite: boolean;
}

// D3D11 -> GL
export const D3D_COMPARE_GL = [0, 0x0200, 0x0201, 0x0202, 0x0203, 0x0204, 0x0205, 0x0206, 0x0207];   // NEVER..ALWAYS
const D3D_BLEND_GL: Record<number, number> = {
  1: 0, 2: 1, 3: 0x0300, 4: 0x0301, 5: 0x0302, 6: 0x0303, 7: 0x0304, 8: 0x0305, 9: 0x0306, 10: 0x0307, 11: 0x0308,
};
const D3D_BLEND_OP_GL: Record<number, number> = { 1: 0x8006, 2: 0x800a, 3: 0x800b, 4: 0x8007, 5: 0x8008 };
const D3D_ADDRESS_GL: Record<number, number> = { 1: 0x2901, 2: 0x8370, 3: 0x812f, 4: 0x812f, 5: 0x812f };

export function blendToGL(b: number[] | null): number[] | null {
  if (!b) return null;
  return [D3D_BLEND_OP_GL[b[0]], D3D_BLEND_GL[b[1]], D3D_BLEND_GL[b[2]], D3D_BLEND_OP_GL[b[3]], D3D_BLEND_GL[b[4]], D3D_BLEND_GL[b[5]]];
}

export class GameGL {
  readonly gl: WebGL2RenderingContext;
  private readonly samplers = new Map<string, WebGLSampler>();
  readonly s3tc: any;
  readonly s3tcSrgb: any;
  readonly rgtc: any;
  /** KHR_parallel_shader_compile: the driver compiles off the page's thread and says when it is done. */
  private readonly parallel: { COMPLETION_STATUS_KHR: number } | null;

  /** The largest uniform block the context takes, in bytes, and how many binding points it has (0: no blocks). */
  private readonly blockLimit: number;
  private readonly blockPoints: number;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.blockLimit = Number(gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE)) || 0;
    this.blockPoints = Math.min(Number(gl.getParameter(gl.MAX_VERTEX_UNIFORM_BLOCKS)) || 0,
      Number(gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_BLOCKS)) || 0, PIXEL_BLOCKS,
      Math.floor((Number(gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS)) || 0) / 2));
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    this.s3tcSrgb = gl.getExtension('WEBGL_compressed_texture_s3tc_srgb');
    this.rgtc = gl.getExtension('EXT_texture_compression_rgtc');
    gl.getExtension('EXT_color_buffer_float');
  }

  /** Buffers created while this list is set are appended to it (so a
   *  caller can free one scene's buffers without touching the others). */
  collect: WebGLBuffer[] | null = null;
  /** Texture units kept for textures many draws share (by binding name), so they stay bound from draw to
   *  draw; a program's other textures take the units from 0. */
  fixedUnits = new Map<string, number>();
  /** Bytes put in buffers so far (a scene's share: the difference across its build). */
  bytes = 0;
  private readonly compiledPrograms = new WeakMap<TranslatedProgram, GameGLProgram>();
  private readonly pendingPrograms = new WeakMap<TranslatedProgram, Promise<GameGLProgram>>();

  /** A linked program per translated program, built once (at once: the page waits for the driver). */
  /** Tests: each program compiled (when, how long the page waited, and whether it waited at once). */
  readonly compileLog: { at: number; ms: number; sync: boolean }[] = [];
  compile(translated: TranslatedProgram): GameGLProgram {
    let p = this.compiledPrograms.get(translated);
    if (!p) {
      const t0 = performance.now();
      const { vertex, fragment } = this.blockSources(translated);
      p = this.describe(translated, this.finishLink(this.startLink(vertex, fragment, translated.attributes)));
      this.compiledPrograms.set(translated, p);
      if (this.compileLog.length < 2000) this.compileLog.push({ at: t0, ms: performance.now() - t0, sync: true });
    }
    return p;
  }

  /** The same, without holding the page: the compile and link are started, and the driver is asked each
   *  frame whether it is done (with KHR_parallel_shader_compile; without it, once after a frame). Start
   *  many at once (Promise.all) so the driver works on them together; compile() then finds them ready. */
  compileAsync(translated: TranslatedProgram): Promise<GameGLProgram> {
    const done = this.compiledPrograms.get(translated);
    if (done) return Promise.resolve(done);
    let p = this.pendingPrograms.get(translated);
    if (!p) {
      p = (async () => {
        const t0 = performance.now();
        const { vertex, fragment } = this.blockSources(translated);
        const started = this.startLink(vertex, fragment, translated.attributes);
        const frame = () => new Promise((r) => setTimeout(r, 16));
        if (this.parallel) { while (!this.gl.getProgramParameter(started.program, this.parallel.COMPLETION_STATUS_KHR)) await frame(); }
        else await frame();
        const linked = this.compiledPrograms.get(translated) ?? this.describe(translated, this.finishLink(started));
        this.compiledPrograms.set(translated, linked);
        if (this.compileLog.length < 2000) this.compileLog.push({ at: t0, ms: performance.now() - t0, sync: false });
        return linked;
      })();
      p.finally(() => this.pendingPrograms.delete(translated)).catch(() => {});
      this.pendingPrograms.set(translated, p);
    }
    return p;
  }

  /** Compile and link a program, binding attributes to their registers before the link. */
  linkSources(vertex: string, fragment: string, attributes: readonly AttributeBinding[] = []): WebGLProgram {
    return this.finishLink(this.startLink(vertex, fragment, attributes));
  }

  /** Hand the driver a program to compile and link (no status asked: asking is what waits). Attributes sit
   *  at their source register, so every convention of a program shares one vertex array. */
  private startLink(vertex: string, fragment: string, attributes: readonly AttributeBinding[]) {
    const gl = this.gl;
    const shader = (type: number, source: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s); return s; };
    const program = gl.createProgram()!, vs = shader(gl.VERTEX_SHADER, vertex), fs = shader(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    for (const a of attributes) gl.bindAttribLocation(program, a.register, a.name);
    gl.linkProgram(program);
    return { program, vs, fs };
  }

  /** The linked program, or the compiler's or linker's message. */
  private finishLink({ program, vs, fs }: { program: WebGLProgram; vs: WebGLShader; fs: WebGLShader }): WebGLProgram {
    const gl = this.gl;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      for (const s of [vs, fs]) if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader compile: ${gl.getShaderInfoLog(s)}`);
      throw new Error(`program link: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  /** A program's constant buffers as uniform blocks where the context allows them: set once per frame per
   *  scene and bound per draw, where a uniform array is sent again to every program that draws it (thousands
   *  of uploads a frame in the all-rooms view). The values, and so the pictures, are the same. */
  private readonly sources = new WeakMap<TranslatedProgram, { vertex: string; fragment: string; blocks: Map<string, { point: number; bytes: number }> }>();
  private blockSources(t: TranslatedProgram) {
    let out = this.sources.get(t);
    if (out) return out;
    const blocks = new Map<string, { point: number; bytes: number }>();
    const convert = (source: string, stage: 'vs' | 'ps') => source.replace(/^uniform uvec4 (cb(\d+)_(vs|ps))\[(\d+)\];$/gm,
      (line, name: string, slot: string, of: string, size: string) => {
        const bytes = Number(size) * 16, point = (of === 'ps' ? PIXEL_BLOCKS : 0) + Number(slot);
        if (of !== stage || Number(slot) >= this.blockPoints || bytes > this.blockLimit) return line;
        blocks.set(name, { point, bytes });
        return `layout(std140) uniform B_${name} { uvec4 ${name}[${size}]; };`;
      });
    out = { vertex: convert(t.vertex, 'vs'), fragment: convert(t.fragment, 'ps'), blocks };
    this.sources.set(t, out);
    return out;
  }

  private describe(translated: TranslatedProgram, program: WebGLProgram): GameGLProgram {
    const gl = this.gl;
    const blocks = new Map<string, { point: number; bytes: number }>();
    for (const [name, block] of this.blockSources(translated).blocks) {
      const index = gl.getUniformBlockIndex(program, `B_${name}`);
      if (index === gl.INVALID_INDEX) continue;   // (not read: left out by the compiler)
      gl.uniformBlockBinding(program, index, block.point);
      blocks.set(name, block);
    }
    const attributes = new Map<string, number>();
    for (const a of translated.attributes) attributes.set(a.name, gl.getAttribLocation(program, a.name));
    const uniforms = new Map<string, WebGLUniformLocation>();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)!;
      const name = info.name.replace(/\[0\]$/, '');
      const location = gl.getUniformLocation(program, info.name);
      if (location) uniforms.set(name, location);
    }
    const units = new Map<string, number>();
    gl.useProgram(program);
    this.lastProgram = program;
    const lowest = Math.min(...this.fixedUnits.values());
    const fixed = translated.samplers.length < lowest;   // (else its own units would reach the kept ones)
    // A material's planes take one unit each by their role whatever the program, so draws in a row by different
    // programs reading the same planes bind nothing between them; the rest take the free units in order.
    const taken = new Set<number>();
    const wanted = (s: { textureName: string; uniform: string }) => (fixed ? this.fixedUnits.get(s.textureName) ?? MATERIAL_UNITS[s.textureName] : undefined);
    const chosen = translated.samplers.map((s) => {
      const unit = wanted(s);
      if (unit === undefined || taken.has(unit) || (!this.fixedUnits.has(s.textureName) && unit >= translated.samplers.length + 4)) return undefined;
      taken.add(unit);
      return unit;
    });
    let free = 0;
    translated.samplers.forEach((s, k) => {
      let unit = chosen[k];
      if (unit === undefined) { while (taken.has(free)) free++; unit = free; taken.add(unit); }
      units.set(s.uniform, unit);
      const location = uniforms.get(s.uniform);
      if (location) gl.uniform1i(location, unit);
    });
    // a sampler the translation does not list (the room mask) on its kept unit
    for (const [name, unit] of this.fixedUnits) {
      const location = uniforms.get(name);
      if (location && !translated.samplers.some((s) => s.uniform === name)) gl.uniform1i(location, unit);
    }
    return { program, translated, attributes, uniforms, units, blocks };
  }

  /** A sampler object for a D3D11 sampler description (null: point, clamp). */
  sampler(desc: number[] | null): WebGLSampler {
    const key = desc ? desc.join(',') : 'point';
    let s = this.samplers.get(key);
    if (s) return s;
    const gl = this.gl;
    s = gl.createSampler()!;
    const [filter = 0, u = 3, v = 3, w = 3, compare = 1, minLod = 0, maxLod = 1000] = desc ?? [];
    const base = filter & 0x7f;
    const minLinear = !!(base & 0x10), magLinear = !!(base & 0x04), mipLinear = !!(base & 0x01);
    gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, magLinear ? gl.LINEAR : gl.NEAREST);
    gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, minLinear
      ? (mipLinear ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_NEAREST)
      : (mipLinear ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST));
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, D3D_ADDRESS_GL[u] ?? gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, D3D_ADDRESS_GL[v] ?? gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_R, D3D_ADDRESS_GL[w] ?? gl.CLAMP_TO_EDGE);
    gl.samplerParameterf(s, gl.TEXTURE_MIN_LOD, minLod);
    gl.samplerParameterf(s, gl.TEXTURE_MAX_LOD, maxLod);
    if (filter & 0x80) {
      gl.samplerParameteri(s, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.samplerParameteri(s, gl.TEXTURE_COMPARE_FUNC, D3D_COMPARE_GL[compare] || gl.LEQUAL);
    }
    this.samplers.set(key, s);
    return s;
  }

  /** An empty 2D texture with `levels` mips (render target, integer or depth). */
  texture2D(width: number, height: number, internalFormat: number, levels = 1): GameTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, levels, internalFormat, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
    const integer = internalFormat === gl.R32UI || internalFormat === gl.RGBA8UI;
    const float = internalFormat === gl.RGBA32F;
    const depth = internalFormat === gl.DEPTH_COMPONENT32F || internalFormat === gl.DEPTH_COMPONENT24;
    // Integer, 32-bit float (data) and float depth formats are not filterable:
    // with the default filters the texture would be incomplete and every
    // fetch would read 0.
    if (integer || float || depth) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    return { texture, target: gl.TEXTURE_2D, width, height };
  }

  /** Upload block-compressed or RGBA8 levels (largest first). */
  uploadTexture(target: 'texture' | 'cube', levels: { width: number; height: number; data: Uint8Array }[][],
    format: number, srgb: boolean): GameTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    const glTarget = target === 'cube' ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    gl.bindTexture(glTarget, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const internal = this.internalFormat(format, srgb);
    const first = levels[0][0];
    gl.texStorage2D(glTarget, levels.length, internal.format, first.width, first.height);
    levels.forEach((faces, level) => faces.forEach((face, f) => {
      const t = target === 'cube' ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + f : gl.TEXTURE_2D;
      if (internal.compressed) gl.compressedTexSubImage2D(t, level, 0, 0, face.width, face.height, internal.format, face.data);
      else gl.texSubImage2D(t, level, 0, 0, face.width, face.height, gl.RGBA, gl.UNSIGNED_BYTE, face.data);
    }));
    gl.texParameteri(glTarget, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(glTarget, gl.TEXTURE_MAX_LEVEL, levels.length - 1);
    return { texture, target: glTarget, width: first.width, height: first.height };
  }

  /** A 2D texture array's storage: `layers` planes of one size, format and level count, filled a layer at a time
   *  (uploadTextureLayer; all rooms: the textures of many parts, drawn as one). */
  textureArray(width: number, height: number, levels: number, layers: number, format: number, srgb: boolean): GameTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, this.internalFormat(format, srgb).format, width, height, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, levels - 1);
    return { texture, target: gl.TEXTURE_2D_ARRAY, width, height };
  }

  /** Every layer of a texture array at once, a level a call (one update of the whole array per level: a layer at a
   *  time stalled the GPU for a tenth of a second a frame). */
  uploadTextureLayers(array: GameTexture, chains: { width: number; height: number; data: Uint8Array }[][], format: number, srgb: boolean): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, array.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const internal = this.internalFormat(format, srgb);
    for (let k = 0; k < chains[0].length; k++) {
      const { width, height } = chains[0][k];
      const bytes = new Uint8Array(chains.reduce((n, c) => n + c[k].data.byteLength, 0));
      let at = 0;
      for (const chain of chains) { bytes.set(chain[k].data, at); at += chain[k].data.byteLength; }
      if (internal.compressed) {
        gl.compressedTexSubImage3D(gl.TEXTURE_2D_ARRAY, k, 0, 0, 0, width, height, chains.length, internal.format, bytes);
      } else gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, k, 0, 0, 0, width, height, chains.length, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }
  }

  /** One layer of a texture array: a plane's mip chain, largest first. */
  uploadTextureLayer(array: GameTexture, layer: number, chain: { width: number; height: number; data: Uint8Array }[], format: number, srgb: boolean): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, array.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const internal = this.internalFormat(format, srgb);
    chain.forEach((level, k) => {
      if (internal.compressed) {
        gl.compressedTexSubImage3D(gl.TEXTURE_2D_ARRAY, k, 0, 0, layer, level.width, level.height, 1, internal.format, level.data);
      } else gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, k, 0, 0, layer, level.width, level.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, level.data);
    });
  }

  /** Whether the GPU path accepts an image format (else the caller decodes). */
  supports(format: number): boolean {
    if (format === 0x16) return true;
    if (format === 0x26 || format === 0x28) return !!this.s3tc;
    if (format === 0x22 || format === 0x24 || format === 0x25) return !!this.rgtc;
    return false;
  }

  private internalFormat(format: number, srgb: boolean): { format: number; compressed: boolean } {
    const gl = this.gl;
    if (format === 0x16) return { format: srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, compressed: false };
    if (format === 0x26) return { format: srgb && this.s3tcSrgb ? this.s3tcSrgb.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT : this.s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT, compressed: true };
    if (format === 0x28) return { format: srgb && this.s3tcSrgb ? this.s3tcSrgb.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT : this.s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT, compressed: true };
    if (format === 0x22) return { format: this.rgtc.COMPRESSED_RED_RGTC1_EXT, compressed: true };
    if (format === 0x24) return { format: this.rgtc.COMPRESSED_RED_GREEN_RGTC2_EXT, compressed: true };
    if (format === 0x25) return { format: this.rgtc.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT, compressed: true };
    throw new Error(`no GPU format for 0x${format.toString(16)}`);
  }

  framebuffer(colour: GameTexture | null, depth: GameTexture | null, level = 0): WebGLFramebuffer {
    const gl = this.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    if (colour) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour.texture, level);
    if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth.texture, level);
    gl.drawBuffers(colour ? [gl.COLOR_ATTACHMENT0] : [gl.NONE]);
    gl.readBuffer(colour ? gl.COLOR_ATTACHMENT0 : gl.NONE);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete 0x${status.toString(16)}`);
    return fb;
  }

  /** A buffer uploaded a slice at a time, each slice on a turn of `pace` (a joined cell's part runs to tens of
   *  megabytes: one upload held up frames for most of half a second). No pace: at once. */
  async bufferSliced(data: ArrayBufferView, index: boolean, pace: ((label?: string, bytes?: number) => Promise<void>) | null, slice = 2 << 20): Promise<WebGLBuffer> {
    // (a small one goes at once)
    if (!pace || data.byteLength < (256 << 10)) return this.buffer(data, index);
    const gl = this.gl;
    const b = gl.createBuffer()!;
    this.collect?.push(b);
    const target = index ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (let at = 0; at < bytes.length || !at; at += slice) {
      await pace('buffer', Math.min(slice, bytes.length - at));
      // (an index buffer binds to the vertex array bound: none)
      if (index) gl.bindVertexArray(null);
      gl.bindBuffer(target, b);
      if (!at) gl.bufferData(target, bytes.length, gl.STATIC_DRAW);
      if (bytes.length) gl.bufferSubData(target, at, bytes, at, Math.min(slice, bytes.length - at));
    }
    this.bytes += data.byteLength;
    return b;
  }

  buffer(data: ArrayBufferView, index = false): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    const target = index ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
    // (an index buffer binds to the vertex array bound: none, so the upload never changes another draw's; the
    // caller binds it to its own vertex array)
    if (index) gl.bindVertexArray(null);
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    this.bytes += data.byteLength;
    this.collect?.push(b);
    return b;
  }

  // What this layer last set on the context: a draw sets only what changed. Anything else that binds
  // (three's frames, a direct upload, the frame's own composite passes) must call forgetState() first.
  private lastState: DrawState | null = null;
  private lastProgram: WebGLProgram | null = null;
  private readonly unitTextures = new Map<number, WebGLTexture | null>();
  private readonly unitSamplers = new Map<number, WebGLSampler | null>();
  /** Per program: the words each constant buffer last took (the same array is not sent twice). */
  private readonly sentWords = new WeakMap<GameGLProgram, Map<string, Uint32Array>>();
  /** Per program: the scalar uniforms' last values (texture widths, the target height). */
  private readonly sentValues = new WeakMap<GameGLProgram, Map<string, number>>();

  /** Forget what the context is known to hold (someone else may have changed it). */
  /** Test counters: the calls this layer made, by kind (counted while `counting`). */
  counting = false;
  calls: Record<string, number> = {};
  private count(kind: string, n = 1): void { if (this.counting) this.calls[kind] = (this.calls[kind] ?? 0) + n; }

  forgetState(): void {
    this.lastState = null;
    this.lastProgram = null;
    this.unitTextures.clear();
    this.unitSamplers.clear();
    this.boundBlocks.clear();
    this.activeUnit = -1;
  }
  private activeUnit = -1;

  // ---- constant buffers as uniform buffers: each words array goes up once a frame, into a buffer kept for
  // three frames before it is filled again (the GPU may still be reading it)
  private frame = 0;
  private readonly frameWords = new Map<Uint32Array, { buffer: WebGLBuffer; bytes: number }>();
  private readonly wordBuffers: { buffer: WebGLBuffer; bytes: number; frame: number }[] = [];
  private readonly spareWordBuffers = new Map<number, WebGLBuffer[]>();
  private readonly boundBlocks = new Map<number, WebGLBuffer>();

  /** A frame begins: the words of the last one are not reused (they may change between frames). */
  beginFrame(): void {
    this.frame++;
    this.frameWords.clear();
    while (this.wordBuffers.length && this.wordBuffers[0].frame <= this.frame - 3) {
      const { buffer, bytes } = this.wordBuffers.shift()!;
      let spare = this.spareWordBuffers.get(bytes);
      if (!spare) this.spareWordBuffers.set(bytes, spare = []);
      spare.push(buffer);
    }
  }

  private wordsBuffer(words: Uint32Array, least: number): WebGLBuffer {
    const done = this.frameWords.get(words);
    if (done && done.bytes >= least) return done.buffer;
    const gl = this.gl;
    // (a block longer than its words reads zeros past them)
    const bytes = Math.max(least, done?.bytes ?? 0, Math.ceil(words.byteLength / 16) * 16);
    const buffer = this.spareWordBuffers.get(bytes)?.pop() ?? gl.createBuffer()!;
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer);
    if (bytes === words.byteLength) gl.bufferData(gl.UNIFORM_BUFFER, words, gl.DYNAMIC_DRAW);
    else {
      const padded = new Uint32Array(bytes / 4);
      padded.set(words.subarray(0, Math.min(words.length, padded.length)));
      gl.bufferData(gl.UNIFORM_BUFFER, padded, gl.DYNAMIC_DRAW);
    }
    this.wordBuffers.push({ buffer, bytes, frame: this.frame });
    this.frameWords.set(words, { buffer, bytes });
    this.count('words', words.length);
    return buffer;
  }

  applyState(s: DrawState): void {
    const gl = this.gl, last = this.lastState;
    if (!last || last.depthTest !== s.depthTest || (s.depthTest && last.depthFunc !== s.depthFunc)) {
      if (s.depthTest) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(s.depthFunc); } else gl.disable(gl.DEPTH_TEST);
    }
    if (!last || last.depthWrite !== s.depthWrite) gl.depthMask(s.depthWrite);
    const sameBlend = !!last && (last.blend === s.blend || (!!last.blend && !!s.blend && last.blend.every((v, k) => v === s.blend![k])));
    if (!sameBlend) {
      if (s.blend) {
        gl.enable(gl.BLEND);
        gl.blendEquationSeparate(s.blend[0], s.blend[3]);
        gl.blendFuncSeparate(s.blend[1], s.blend[2], s.blend[4], s.blend[5]);
      } else gl.disable(gl.BLEND);
    }
    if (!last || last.cull !== s.cull) {
      if (s.cull === null) gl.disable(gl.CULL_FACE);
      else { gl.enable(gl.CULL_FACE); gl.cullFace(s.cull); gl.frontFace(gl.CCW); }
    }
    if (!last || last.colourWrite !== s.colourWrite) gl.colorMask(s.colourWrite, s.colourWrite, s.colourWrite, s.colourWrite);
    this.lastState = s;
  }

  private readonly samplerUnits = new Set<number>();

  /** Unbind every sampler object bound here. three.js samples with its
   *  textures' own parameters and knows nothing of sampler objects, so one
   *  left on a unit overrides its filtering there, and the shadow map's
   *  comparison sampler fails its draws outright (a format mismatch). */
  releaseSamplers(): void {
    for (const unit of this.samplerUnits) this.gl.bindSampler(unit, null);
    this.samplerUnits.clear();
    this.forgetState();
  }

  /** Bind constant buffers (raw words), textures with their sampler objects, and the target height.
   *  `vsTextures`: the vertex stage's own resources (a skinned program's bone buffer), bound
   *  alongside `stage`'s; a buffer resource also gets its data texture's width. */
  bindResources(p: GameGLProgram, cbs: Record<string, Uint32Array>, textures: Record<number, { texture: GameTexture; sampler: WebGLSampler | null }>,
    stage: 'vs' | 'ps' | 'both', targetHeight: number,
    vsTextures: Record<number, { texture: GameTexture; sampler: WebGLSampler | null }> | null = null): void {
    const gl = this.gl;
    this.count('bind');
    if (this.lastProgram !== p.program) { gl.useProgram(p.program); this.lastProgram = p.program; this.count('useProgram'); }
    let sent = this.sentWords.get(p);
    if (!sent) this.sentWords.set(p, sent = new Map());
    let sentValues = this.sentValues.get(p);
    if (!sentValues) this.sentValues.set(p, sentValues = new Map());
    for (const name in cbs) {
      const words = cbs[name];
      const block = p.blocks.get(name);
      if (block) {
        const buffer = this.wordsBuffer(words, block.bytes);
        if (this.boundBlocks.get(block.point) !== buffer) {
          gl.bindBufferBase(gl.UNIFORM_BUFFER, block.point, buffer);
          this.boundBlocks.set(block.point, buffer);
          this.count('bindBlock');
        }
        continue;
      }
      if (sent.get(name) === words) continue;
      const location = p.uniforms.get(name);
      if (location) { gl.uniform4uiv(location, words); this.count('uniform4uiv'); this.count('words', words.length); }
      sent.set(name, words);
    }
    for (const s of p.translated.samplers) {
      const own = vsTextures && s.stage === 'vs';
      if (!own && stage !== 'both' && s.stage !== stage) continue;
      const unit = p.units.get(s.uniform)!;
      const bound = own ? vsTextures[s.texture] : textures[s.texture];
      if (s.widthUniform) {
        const location = p.uniforms.get(s.widthUniform);
        const width = bound?.texture.width ?? 1;
        if (location && sentValues.get(s.widthUniform) !== width) { gl.uniform1i(location, width); sentValues.set(s.widthUniform, width); }
      }
      const texture = bound ? bound.texture.texture : null;
      if (!this.unitTextures.has(unit) || this.unitTextures.get(unit) !== texture) {
        // (the unit made active only when it is not already: every draw binds its textures unit by unit)
        if (this.activeUnit !== unit) { gl.activeTexture(gl.TEXTURE0 + unit); this.activeUnit = unit; }
        this.count('bindTexture');
        gl.bindTexture(bound ? bound.texture.target : (s.dim === 'cube' ? gl.TEXTURE_CUBE_MAP : s.dim === '2darray' ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D), texture);
        // (a unit holds one texture per target: a null bind leaves the other target's, so it is not cached)
        if (texture) this.unitTextures.set(unit, texture); else this.unitTextures.delete(unit);
      }
      const sampler = bound?.sampler ?? null;
      if (!this.unitSamplers.has(unit) || this.unitSamplers.get(unit) !== sampler) {
        gl.bindSampler(unit, sampler);
        this.count('bindSampler');
        this.unitSamplers.set(unit, sampler);
      }
      if (sampler) this.samplerUnits.add(unit);
    }
    if (p.translated.targetHeightUniform) {
      const location = p.uniforms.get(p.translated.targetHeightUniform);
      if (location && sentValues.get(p.translated.targetHeightUniform) !== targetHeight) {
        gl.uniform1f(location, targetHeight);
        sentValues.set(p.translated.targetHeightUniform, targetHeight);
      }
    }
  }
}
