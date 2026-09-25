// A small WebGL2 layer for drawing with the game's translated programs:
// sampler objects carry the source's sampler state exactly (filters,
// addressing, comparison, LOD range), textures keep their authored mip
// count, integer and depth targets render per mip level, and every draw sets
// its full pipeline state. It shares the page's WebGL2 context with three.js;
// callers reset three's cached state afterwards (renderer.resetState()).
import type { TranslatedProgram } from './dxbc-glsl.js';

export interface GameGLProgram {
  program: WebGLProgram;
  translated: TranslatedProgram;
  attributes: Map<string, number>;
  uniforms: Map<string, WebGLUniformLocation>;
  /** Texture unit of each sampler uniform. */
  units: Map<string, number>;
}

export interface GameTexture {
  texture: WebGLTexture;
  target: number;            // TEXTURE_2D or TEXTURE_CUBE_MAP
  width: number;
  height: number;
  levels: number;
  integer: boolean;
  depth: boolean;
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

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    this.s3tcSrgb = gl.getExtension('WEBGL_compressed_texture_s3tc_srgb');
    this.rgtc = gl.getExtension('EXT_texture_compression_rgtc');
    gl.getExtension('EXT_color_buffer_float');
  }

  /** Buffers created while this list is set are appended to it (so a
   *  caller can free one scene's buffers without touching the others). */
  collect: WebGLBuffer[] | null = null;
  private readonly compiledPrograms = new WeakMap<TranslatedProgram, GameGLProgram>();

  /** A linked program per translated program, built once. */
  compile(translated: TranslatedProgram): GameGLProgram {
    let p = this.compiledPrograms.get(translated);
    if (!p) { p = this.link(translated); this.compiledPrograms.set(translated, p); }
    return p;
  }

  private link(translated: TranslatedProgram): GameGLProgram {
    const gl = this.gl;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader compile: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, translated.vertex));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, translated.fragment));
    // Attributes sit at their source register, so every convention of a
    // program shares one vertex array.
    for (const a of translated.attributes) gl.bindAttribLocation(program, a.register, a.name);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program link: ${gl.getProgramInfoLog(program)}`);
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
    translated.samplers.forEach((s, k) => {
      units.set(s.uniform, k);
      const location = uniforms.get(s.uniform);
      if (location) gl.uniform1i(location, k);
    });
    return { program, translated, attributes, uniforms, units };
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
    const depth = internalFormat === gl.DEPTH_COMPONENT32F || internalFormat === gl.DEPTH_COMPONENT24;
    // Integer and float depth formats are not filterable: with the default
    // filters the texture would be incomplete and every fetch would read 0.
    if (integer || depth) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    return { texture, target: gl.TEXTURE_2D, width, height, levels, integer, depth };
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
    return { texture, target: glTarget, width: first.width, height: first.height, levels: levels.length, integer: false, depth: false };
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

  buffer(data: ArrayBufferView, index = false): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    const target = index ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    this.collect?.push(b);
    return b;
  }

  applyState(s: DrawState): void {
    const gl = this.gl;
    if (s.depthTest) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(s.depthFunc); } else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(s.depthWrite);
    if (s.blend) {
      gl.enable(gl.BLEND);
      gl.blendEquationSeparate(s.blend[0], s.blend[3]);
      gl.blendFuncSeparate(s.blend[1], s.blend[2], s.blend[4], s.blend[5]);
    } else gl.disable(gl.BLEND);
    if (s.cull === null) gl.disable(gl.CULL_FACE);
    else { gl.enable(gl.CULL_FACE); gl.cullFace(s.cull); gl.frontFace(gl.CCW); }
    gl.colorMask(s.colourWrite, s.colourWrite, s.colourWrite, s.colourWrite);
  }

  private readonly samplerUnits = new Set<number>();

  /** Unbind every sampler object bound here. three.js samples with its
   *  textures' own parameters and knows nothing of sampler objects, so one
   *  left on a unit overrides its filtering there, and the shadow map's
   *  comparison sampler fails its draws outright (a format mismatch). */
  releaseSamplers(): void {
    for (const unit of this.samplerUnits) this.gl.bindSampler(unit, null);
    this.samplerUnits.clear();
  }

  /** Bind constant buffers (raw words), textures with their sampler objects, and the target height. */
  bindResources(p: GameGLProgram, cbs: Record<string, Uint32Array>, textures: Record<number, { texture: GameTexture; sampler: WebGLSampler | null }>,
    stage: 'vs' | 'ps' | 'both', targetHeight: number): void {
    const gl = this.gl;
    gl.useProgram(p.program);
    for (const [name, words] of Object.entries(cbs)) {
      const location = p.uniforms.get(name);
      if (location) gl.uniform4uiv(location, words);
    }
    for (const s of p.translated.samplers) {
      if (stage !== 'both' && s.stage !== stage) continue;
      const unit = p.units.get(s.uniform)!;
      const bound = textures[s.texture];
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(bound ? bound.texture.target : (s.dim === 'cube' ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D), bound ? bound.texture.texture : null);
      gl.bindSampler(unit, bound?.sampler ?? null);
      if (bound?.sampler) this.samplerUnits.add(unit);
    }
    if (p.translated.targetHeightUniform) {
      const location = p.uniforms.get(p.translated.targetHeightUniform);
      if (location) gl.uniform1f(location, targetHeight);
    }
  }
}
