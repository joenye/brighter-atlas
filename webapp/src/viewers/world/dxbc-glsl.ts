// Shader model 4 programs (see dxbc.ts) translated to GLSL ES 3.00, so the
// viewer can draw with the same shading code the game uses.
//
// Registers are typeless 32-bit words in the source language, so every
// register is a highp uvec4 holding raw bit patterns: float instructions
// convert in and out with uintBitsToFloat / floatBitsToUint (macros F and U),
// integer and bitwise instructions work on the bits directly, moves copy
// bits, and immediates are emitted from their raw patterns. Nothing passes
// through a float register unless the source instruction treats it as one,
// so integer data (indices, packed flags) and every constant stay bit-exact.
// Constant buffers are `uniform uvec4 cb<slot>_vs[size]` / `_ps` arrays of the
// same raw words (upload the buffer bytes as a Uint32Array).
//
// Conventions (clip space, window origin):
// - Clip z runs 0..w in the source. GL's default is -w..w (gl_Position.z =
//   2z - w, one rounding step); with depth 'zeroToOne' (EXT_clip_control set
//   to ZERO_TO_ONE by the caller) z passes through unchanged.
// - y 'fragcoord' (default, for drawing into the canvas): clip y unchanged.
//   A pixel shader's position input is rebuilt with the source's top-left
//   origin as (x, u_targetHeight - y, z, 1/w) (pixel centres stay at .5) and
//   deriv_rty is negated. Render targets written this way are stored bottom
//   row first, so a later pass that samples them with source-convention
//   coordinates must flip v.
// - y 'clip' (offscreen passes): clip y is negated, which stores render
//   targets top row first exactly like the source, keeps the position input
//   and deriv_rty unchanged, and reverses triangle winding: the caller flips
//   its front face (or cull mode) to match.
// - Textures created from data need no flip (both origins are the first row).
// - Varyings are matched by register, as the source links stages. Constant
//   interpolation becomes flat (bits), centroid stays centroid, and
//   noperspective is emulated by pre-multiplying with clip w in the vertex
//   shader and multiplying by gl_FragCoord.w in the pixel shader.
// - Each (texture, sampler) pair used by a sample instruction becomes one
//   combined sampler uniform; comparison samplers become shadow samplers;
//   ld on a texture uses a fetch-only sampler; a Buffer resource is read from
//   a 2D data texture of `u_width_<name>` texels per row (element i at
//   (i mod width, i div width)), texel format matching the buffer's elements.
import {
  parseDxbc, OP, OPERAND, NAME, RESOURCE_DIM, INTERPOLATION, COMPONENT, INPUT_TYPE,
  type DxbcShader, type Instruction, type Operand, type OperandIndex,
} from './dxbc.js';

export type YConvention = 'fragcoord' | 'clip';

export interface TranslateOptions {
  y?: YConvention;
  /** The GL clip depth range the program draws under (default 'negativeOneToOne'). */
  depth?: 'zeroToOne' | 'negativeOneToOne';
}

export interface AttributeBinding {
  /** GLSL attribute name. */
  name: string;
  semantic: string;
  semanticIndex: number;
  register: number;
  componentType: 'float' | 'uint' | 'int';
  mask: number;
}

export interface ConstantBufferBinding {
  stage: 'vs' | 'ps';
  slot: number;
  /** GLSL uniform name (uvec4 array). */
  uniform: string;
  sizeVec4: number;
  name: string;
  variables: { name: string; parent: string | null; offset: number; size: number }[];
}

export interface SamplerBinding {
  /** GLSL uniform name. */
  uniform: string;
  stage: 'vs' | 'ps';
  texture: number;
  textureName: string;
  /** Source sampler slot; null for texel fetches, which ignore sampler state. */
  sampler: number | null;
  samplerName: string;
  dim: '1d' | '2d' | '3d' | 'cube' | '2darray' | 'buffer';
  comparison: boolean;
  returnType: 'float' | 'uint' | 'int';
  /** Buffer resources: the int uniform holding the data texture's width. */
  widthUniform: string | null;
}

export interface OutputBinding {
  location: number;
  name: string;
  componentType: 'float' | 'uint' | 'int';
}

export interface TranslatedProgram {
  vertex: string;
  fragment: string;
  attributes: AttributeBinding[];
  constantBuffers: { vs: ConstantBufferBinding[]; ps: ConstantBufferBinding[] };
  samplers: SamplerBinding[];
  outputs: OutputBinding[];
  /** Set when the pixel shader reads its position with the 'fragcoord' convention. */
  targetHeightUniform: string | null;
  y: YConvention;
  /** Features emulated approximately or dropped (empty for the common case). */
  notes: string[];
}

type Ty = 'f' | 'u' | 'i';
const LETTERS = 'xyzw';
const SCALAR: Record<Ty, string> = { f: 'float', u: 'uint', i: 'int' };
const VECTOR: Record<Ty, string> = { f: 'vec', u: 'uvec', i: 'ivec' };
const vtype = (ty: Ty, n: number) => (n === 1 ? SCALAR[ty] : `${VECTOR[ty]}${n}`);
const letters = (comps: number[]) => comps.map((c) => LETTERS[c]).join('');
const hex = (v: number) => `0x${(v >>> 0).toString(16)}u`;

function maskPositions(mask: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < 4; c++) if (mask & (1 << c)) out.push(c);
  return out;
}

function componentType(t: number): 'float' | 'uint' | 'int' {
  return t === COMPONENT.UINT32 ? 'uint' : t === COMPONENT.SINT32 ? 'int' : 'float';
}

const HELPERS = `#define F(x) uintBitsToFloat(x)
#define U(x) floatBitsToUint(x)
uint movc(uint c, uint a, uint b) { return c != 0u ? a : b; }
uvec2 movc(uvec2 c, uvec2 a, uvec2 b) { uvec2 m = uvec2(notEqual(c, uvec2(0u))) * 0xffffffffu; return (a & m) | (b & ~m); }
uvec3 movc(uvec3 c, uvec3 a, uvec3 b) { uvec3 m = uvec3(notEqual(c, uvec3(0u))) * 0xffffffffu; return (a & m) | (b & ~m); }
uvec4 movc(uvec4 c, uvec4 a, uvec4 b) { uvec4 m = uvec4(notEqual(c, uvec4(0u))) * 0xffffffffu; return (a & m) | (b & ~m); }
`;

// Helpers with the source language's edge rules, added when used.
const OPTIONAL_HELPERS: Record<string, string> = {
  ftoi: `int ftoi(float x) { return isNaNBits(x) ? 0 : x >= 2147483648.0 ? 2147483647 : x <= -2147483648.0 ? int(0x80000000u) : int(x); }
ivec2 ftoi(vec2 x) { return ivec2(ftoi(x.x), ftoi(x.y)); }
ivec3 ftoi(vec3 x) { return ivec3(ftoi(x.x), ftoi(x.y), ftoi(x.z)); }
ivec4 ftoi(vec4 x) { return ivec4(ftoi(x.x), ftoi(x.y), ftoi(x.z), ftoi(x.w)); }
`,
  ftou: `uint ftou(float x) { return isNaNBits(x) || x <= 0.0 ? 0u : x >= 4294967296.0 ? 0xffffffffu : uint(x); }
uvec2 ftou(vec2 x) { return uvec2(ftou(x.x), ftou(x.y)); }
uvec3 ftou(vec3 x) { return uvec3(ftou(x.x), ftou(x.y), ftou(x.z)); }
uvec4 ftou(vec4 x) { return uvec4(ftou(x.x), ftou(x.y), ftou(x.z), ftou(x.w)); }
`,
  udiv: `uint udivq(uint a, uint b) { return b == 0u ? 0xffffffffu : a / b; }
uint udivr(uint a, uint b) { return b == 0u ? 0xffffffffu : a - b * (a / b); }
`,
  // Edge rules of the source language where GLSL leaves results undefined:
  // saturate maps NaN to 0, min/max return the other operand when one is
  // NaN, log(+-0) is -inf and
  // log(negative) NaN, sqrt(negative) NaN, rsq(+-0) +-inf and rsq(negative)
  // NaN. Tests read the bits, so they hold even under fast-math compilers.
  nan: `bool isNaNBits(float x) { return (floatBitsToUint(x) & 0x7fffffffu) > 0x7f800000u; }
`,
  sat: `float dsat(float x) { return isNaNBits(x) ? 0.0 : clamp(x, 0.0, 1.0); }
vec2 dsat(vec2 x) { return vec2(dsat(x.x), dsat(x.y)); }
vec3 dsat(vec3 x) { return vec3(dsat(x.x), dsat(x.y), dsat(x.z)); }
vec4 dsat(vec4 x) { return vec4(dsat(x.x), dsat(x.y), dsat(x.z), dsat(x.w)); }
`,
  min: `float dmin(float a, float b) { return isNaNBits(a) ? b : isNaNBits(b) ? a : min(a, b); }
vec2 dmin(vec2 a, vec2 b) { return vec2(dmin(a.x, b.x), dmin(a.y, b.y)); }
vec3 dmin(vec3 a, vec3 b) { return vec3(dmin(a.x, b.x), dmin(a.y, b.y), dmin(a.z, b.z)); }
vec4 dmin(vec4 a, vec4 b) { return vec4(dmin(a.x, b.x), dmin(a.y, b.y), dmin(a.z, b.z), dmin(a.w, b.w)); }
`,
  max: `float dmax(float a, float b) { return isNaNBits(a) ? b : isNaNBits(b) ? a : max(a, b); }
vec2 dmax(vec2 a, vec2 b) { return vec2(dmax(a.x, b.x), dmax(a.y, b.y)); }
vec3 dmax(vec3 a, vec3 b) { return vec3(dmax(a.x, b.x), dmax(a.y, b.y), dmax(a.z, b.z)); }
vec4 dmax(vec4 a, vec4 b) { return vec4(dmax(a.x, b.x), dmax(a.y, b.y), dmax(a.z, b.z), dmax(a.w, b.w)); }
`,
  log: `float dlog(float x) {
  uint u = floatBitsToUint(x);
  if ((u & 0x7fffffffu) == 0u) return uintBitsToFloat(0xff800000u);
  if ((u & 0x80000000u) != 0u || (u & 0x7fffffffu) > 0x7f800000u) return uintBitsToFloat(0x7fc00000u);
  return log2(x);
}
vec2 dlog(vec2 x) { return vec2(dlog(x.x), dlog(x.y)); }
vec3 dlog(vec3 x) { return vec3(dlog(x.x), dlog(x.y), dlog(x.z)); }
vec4 dlog(vec4 x) { return vec4(dlog(x.x), dlog(x.y), dlog(x.z), dlog(x.w)); }
`,
  sqrt: `float dsqrt(float x) {
  uint u = floatBitsToUint(x);
  if ((u & 0x7fffffffu) == 0u) return x;
  if ((u & 0x80000000u) != 0u || (u & 0x7fffffffu) > 0x7f800000u) return uintBitsToFloat(0x7fc00000u);
  return sqrt(x);
}
vec2 dsqrt(vec2 x) { return vec2(dsqrt(x.x), dsqrt(x.y)); }
vec3 dsqrt(vec3 x) { return vec3(dsqrt(x.x), dsqrt(x.y), dsqrt(x.z)); }
vec4 dsqrt(vec4 x) { return vec4(dsqrt(x.x), dsqrt(x.y), dsqrt(x.z), dsqrt(x.w)); }
`,
  rsq: `float drsq(float x) {
  uint u = floatBitsToUint(x);
  if ((u & 0x7fffffffu) == 0u) return uintBitsToFloat((u & 0x80000000u) | 0x7f800000u);
  if ((u & 0x80000000u) != 0u || (u & 0x7fffffffu) > 0x7f800000u) return uintBitsToFloat(0x7fc00000u);
  return inversesqrt(x);
}
vec2 drsq(vec2 x) { return vec2(drsq(x.x), drsq(x.y)); }
vec3 drsq(vec3 x) { return vec3(drsq(x.x), drsq(x.y), drsq(x.z)); }
vec4 drsq(vec4 x) { return vec4(drsq(x.x), drsq(x.y), drsq(x.z), drsq(x.w)); }
`,
  mulhi: `uint umulhi(uint a, uint b) {
  uint al = a & 0xffffu, ah = a >> 16, bl = b & 0xffffu, bh = b >> 16;
  uint ll = al * bl, lh = al * bh, hl = ah * bl, hh = ah * bh;
  uint mid = (ll >> 16) + (lh & 0xffffu) + (hl & 0xffffu);
  return hh + (lh >> 16) + (hl >> 16) + (mid >> 16);
}
uint imulhi(uint a, uint b) {
  uint h = umulhi(a, b);
  if ((a & 0x80000000u) != 0u) h -= b;
  if ((b & 0x80000000u) != 0u) h -= a;
  return h;
}
`,
};

interface ResourceInfo {
  dim: SamplerBinding['dim'];
  returnType: 'float' | 'uint' | 'int';
}

class StageWriter {
  readonly body: string[] = [];
  readonly samplers = new Map<string, SamplerBinding>();
  readonly helpers = new Set<string>();
  depth = 1;
  constructor(
    readonly sh: DxbcShader,
    readonly stage: 'vs' | 'ps',
    readonly y: YConvention,
    readonly notes: string[],
  ) {}

  line(s: string) {
    this.body.push('  '.repeat(this.depth) + s);
  }

  // ---- Operands.

  index(i: OperandIndex): string {
    if (!i.rel) return String(i.imm);
    const rel = this.src(i.rel, [0], 'i');
    return i.imm ? `(${rel} + ${i.imm})` : rel;
  }

  base(o: Operand): string {
    const [i0, i1] = o.indices;
    switch (o.type) {
      case OPERAND.TEMP: return `r${i0.imm}`;
      case OPERAND.INPUT:
        if (o.indices.length > 1) throw new Error('two-dimensional inputs are not supported');
        return i0.rel ? `vin[${this.index(i0)}]` : `v${i0.imm}`;
      case OPERAND.OUTPUT: return i0.rel ? `vout[${this.index(i0)}]` : `o${i0.imm}`;
      case OPERAND.INDEXABLE_TEMP: return `x${i0.imm}[${this.index(i1)}]`;
      case OPERAND.CONSTANT_BUFFER:
        if (i0.rel) throw new Error('indexed constant buffer slots are not supported');
        return `cb${i0.imm}_${this.stage}[${this.index(i1)}]`;
      case OPERAND.IMMEDIATE_CONSTANT_BUFFER: return `icb[${this.index(i0)}]`;
      case OPERAND.OUTPUT_DEPTH: return 'oDepth';
      default: throw new Error(`unsupported operand type ${o.type}`);
    }
  }

  /** A source read at the given positions, typed float, uint or int, with modifiers applied. */
  src(o: Operand, positions: number[], ty: Ty): string {
    const n = positions.length;
    let raw: string;
    if (o.type === OPERAND.IMMEDIATE32 && o.values) {
      const vals = positions.map((p) => o.values![o.values!.length === 1 ? 0 : p]);
      if (ty === 'u') raw = n === 1 ? hex(vals[0]) : `uvec${n}(${vals.map(hex).join(', ')})`;
      else if (ty === 'i') {
        const ints = vals.map((v) => (v === 0x80000000 ? 'int(0x80000000u)' : String(v | 0)));
        raw = n === 1 ? ints[0] : `ivec${n}(${ints.join(', ')})`;
      } else raw = n === 1 ? `F(${hex(vals[0])})` : `F(uvec${n}(${vals.map(hex).join(', ')}))`;
      return this.modify(raw, o.modifier, ty, n);
    }
    if (o.type === OPERAND.IMMEDIATE64) throw new Error('64-bit immediates are not supported');
    const b = this.base(o);
    let expr: string;
    if (o.comps === 1 || o.type === OPERAND.OUTPUT_DEPTH) {
      const s = o.type === OPERAND.OUTPUT_DEPTH ? b : `${b}.x`;
      expr = n === 1 ? s : `uvec${n}(${s})`;
    } else {
      expr = `${b}.${letters(positions.map((p) => o.swizzle[p]))}`;
    }
    if (ty === 'f') raw = `F(${expr})`;
    else if (ty === 'i') raw = n === 1 ? `int(${expr})` : `ivec${n}(${expr})`;
    else raw = expr;
    return this.modify(raw, o.modifier, ty, n);
  }

  modify(x: string, modifier: number, ty: Ty, n: number): string {
    if (!modifier) return x;
    if (ty === 'u') {
      if (modifier !== 1) throw new Error('absolute value of an unsigned source');
      return `(${n === 1 ? '0u' : `uvec${n}(0u)`} - ${x})`;
    }
    if (modifier === 1) return `(-${x})`;
    if (modifier === 2) return `abs(${x})`;
    return `(-abs(${x}))`;
  }

  /** Destination positions, or null for the null register. */
  dstPositions(o: Operand): number[] | null {
    if (o.type === OPERAND.NULL) return null;
    if (o.comps === 1 || o.type === OPERAND.OUTPUT_DEPTH) return [0];
    return maskPositions(o.mask);
  }

  store(o: Operand, positions: number[], value: string, ty: Ty, sat: boolean) {
    const n = positions.length;
    let v = value;
    if (sat) {
      if (ty !== 'f') throw new Error('saturate on an integer result');
      this.helpers.add('nan');
      this.helpers.add('sat');
      v = `dsat(${v})`;
    }
    const bits = ty === 'f' ? `U(${v})` : ty === 'i' ? `${vtype('u', n)}(${v})` : v;
    if (o.comps === 1 || o.type === OPERAND.OUTPUT_DEPTH) {
      this.line(`${this.base(o)} = ${bits};`);
      return;
    }
    this.line(`${this.base(o)}.${letters(positions)} = ${bits};`);
  }

  // ---- Instruction families.

  componentwise(ins: Instruction, ty: Ty, out: Ty, fn: (...a: string[]) => string) {
    const d = ins.operands[0];
    const P = this.dstPositions(d);
    if (!P) return;
    const args = ins.operands.slice(1).map((o) => this.src(o, P, ty));
    this.store(d, P, fn(...args), out, ins.saturate);
  }

  compare(ins: Instruction, ty: Ty, scalarOp: string, vectorFn: string) {
    const d = ins.operands[0];
    const P = this.dstPositions(d);
    if (!P) return;
    const a = this.src(ins.operands[1], P, ty), b = this.src(ins.operands[2], P, ty);
    const v = P.length === 1
      ? `((${a} ${scalarOp} ${b}) ? 0xffffffffu : 0u)`
      : `(uvec${P.length}(${vectorFn}(${a}, ${b})) * 0xffffffffu)`;
    this.store(d, P, v, 'u', false);
  }

  dot(ins: Instruction, k: number) {
    const d = ins.operands[0];
    const P = this.dstPositions(d);
    if (!P) return;
    const pos = [0, 1, 2, 3].slice(0, k);
    const v = `dot(${this.src(ins.operands[1], pos, 'f')}, ${this.src(ins.operands[2], pos, 'f')})`;
    this.store(d, P, P.length === 1 ? v : `vec${P.length}(${v})`, 'f', ins.saturate);
  }

  move(ins: Instruction) {
    const [d, s] = ins.operands;
    const P = this.dstPositions(d);
    if (!P) return;
    if (ins.saturate || s.modifier) this.store(d, P, this.src(s, P, 'f'), 'f', ins.saturate);
    else this.store(d, P, this.src(s, P, 'u'), 'u', false);
  }

  select(ins: Instruction) {
    const [d, c, a, b] = ins.operands;
    const P = this.dstPositions(d);
    if (!P) return;
    const bits = (o: Operand) => (o.modifier ? `U(${this.src(o, P, 'f')})` : this.src(o, P, 'u'));
    const v = `movc(${this.src(c, P, 'u')}, ${bits(a)}, ${bits(b)})`;
    if (ins.saturate) this.store(d, P, `F(${v})`, 'f', true);
    else this.store(d, P, v, 'u', false);
  }

  /** Two-destination instructions: sources read once into a block-local temporary. */
  twoDest(ins: Instruction, ty: Ty, make: (dest: 0 | 1, a: string, b: string, c?: string) => string, out: Ty) {
    const [d0, d1, ...srcs] = ins.operands;
    const P0 = this.dstPositions(d0), P1 = this.dstPositions(d1);
    if (!P0 && !P1) return;
    this.line('{');
    this.depth++;
    const all = [0, 1, 2, 3];
    const names = srcs.map((o, k) => {
      const t = `t${k}`;
      this.line(`${vtype(ty, 4)} ${t} = ${this.src(o, all, ty)};`);
      return t;
    });
    const pick = (P: number[]) => names.map((t) => `${t}.${letters(P)}`);
    if (P0) this.store(d0, P0, make(0, ...(pick(P0) as [string, string, string?])), out, ins.saturate);
    if (P1) this.store(d1, P1, make(1, ...(pick(P1) as [string, string, string?])), out, ins.saturate);
    this.depth--;
    this.line('}');
  }

  cond(o: Operand, nonZero: boolean): string {
    return `${this.src(o, [0], 'u')} ${nonZero ? '!=' : '=='} 0u`;
  }

  // ---- Resources.

  resource(slot: number): ResourceInfo {
    const d = this.sh.decls.resources.find((r) => r.slot === slot);
    if (!d) throw new Error(`t${slot} is not declared`);
    const dims: Record<number, SamplerBinding['dim']> = {
      [RESOURCE_DIM.BUFFER]: 'buffer', [RESOURCE_DIM.TEXTURE1D]: '1d', [RESOURCE_DIM.TEXTURE2D]: '2d',
      [RESOURCE_DIM.TEXTURE3D]: '3d', [RESOURCE_DIM.TEXTURECUBE]: 'cube', [RESOURCE_DIM.TEXTURE2DARRAY]: '2darray',
    };
    const dim = dims[d.dimension];
    if (!dim) throw new Error(`unsupported resource dimension ${d.dimension}`);
    const rt = d.returnType[0];
    return { dim, returnType: rt === 3 ? 'int' : rt === 4 ? 'uint' : 'float' };
  }

  bindingName(type: number, slot: number): string {
    const b = this.sh.reflection?.bindings.find((x) => x.type === type && x.bindPoint <= slot && slot < x.bindPoint + x.bindCount);
    return b ? b.name : '';
  }

  samplerUniform(texture: number, sampler: number | null, comparison: boolean): { name: string; info: ResourceInfo } {
    const info = this.resource(texture);
    const name = sampler === null
      ? `${info.dim === 'buffer' ? 'b' : 't'}${texture}_${this.stage}`
      : `${comparison ? 'c' : 's'}${texture}_${sampler}_${this.stage}`;
    if (!this.samplers.has(name)) {
      this.samplers.set(name, {
        uniform: name, stage: this.stage, texture, textureName: this.bindingName(INPUT_TYPE.TEXTURE, texture),
        sampler, samplerName: sampler === null ? '' : this.bindingName(INPUT_TYPE.SAMPLER, sampler),
        dim: info.dim, comparison, returnType: info.returnType,
        widthUniform: info.dim === 'buffer' ? `u_width_${name}` : null,
      });
    }
    return { name, info };
  }

  samplerType(b: SamplerBinding): string {
    const prefix = b.returnType === 'uint' ? 'u' : b.returnType === 'int' ? 'i' : '';
    if (b.comparison) {
      if (b.dim === 'cube') return 'samplerCubeShadow';
      if (b.dim === '2darray') return 'sampler2DArrayShadow';
      return 'sampler2DShadow';
    }
    const dim = b.dim === 'cube' ? 'Cube' : b.dim === '3d' ? '3D' : b.dim === '2darray' ? '2DArray' : '2D';
    return `${prefix}sampler${dim}`;
  }

  addressCount(dim: SamplerBinding['dim']): number {
    return dim === '2d' ? 2 : dim === '1d' ? 1 : 3;
  }

  /** Coordinates as a float vector for the GLSL sampler (1D reads the middle row of a 2D texture). */
  address(o: Operand, dim: SamplerBinding['dim']): string {
    if (dim === '1d') return `vec2(${this.src(o, [0], 'f')}, 0.5)`;
    return this.src(o, [0, 1, 2, 3].slice(0, this.addressCount(dim)), 'f');
  }

  offsetArg(ins: Instruction, dim: SamplerBinding['dim']): string | null {
    if (!ins.offsets || ins.offsets.every((v) => v === 0)) return null;
    const [u, v, w] = ins.offsets;
    if (dim === '3d') return `ivec3(${u}, ${v}, ${w})`;
    if (dim === 'cube') throw new Error('texel offsets on a cube');
    return `ivec2(${u}, ${dim === '1d' ? 0 : v})`;
  }

  /** Stores a vec4-shaped lookup result through the resource swizzle into the destination. */
  storeLookup(ins: Instruction, resourceOp: Operand, value: string, ty: Ty) {
    const d = ins.operands[0];
    const P = this.dstPositions(d);
    if (!P) return;
    const comps = P.map((p) => resourceOp.swizzle[p]);
    this.store(d, P, `${value}.${letters(comps)}`, ty, ins.saturate);
  }

  sample(ins: Instruction) {
    const op = ins.opcode;
    const [, addr, res, smp, e1, e2] = ins.operands;
    const texture = res.indices[0].imm, sampler = smp.indices[0].imm;
    const comparison = op === OP.SAMPLE_C || op === OP.SAMPLE_C_LZ;
    const { name, info } = this.samplerUniform(texture, sampler, comparison);
    if (info.dim === 'buffer') throw new Error('sampling a buffer');
    const uv = this.address(addr, info.dim);
    const off = this.offsetArg(ins, info.dim);
    let call: string;
    if (comparison) {
      const ref = this.src(e1, [0], 'f');
      const coord = info.dim === '2d' || info.dim === '1d' ? `vec3(${uv}, ${ref})` : `vec4(${uv}, ${ref})`;
      if (op === OP.SAMPLE_C) call = off ? `textureOffset(${name}, ${coord}, ${off})` : `texture(${name}, ${coord})`;
      else if (info.dim === 'cube' || info.dim === '2darray') {
        if (off) throw new Error('offset comparison lookup at level zero');
        const g = info.dim === 'cube' ? 'vec3(0.0)' : 'vec2(0.0)';
        call = `textureGrad(${name}, ${coord}, ${g}, ${g})`;
      } else call = off ? `textureLodOffset(${name}, ${coord}, 0.0, ${off})` : `textureLod(${name}, ${coord}, 0.0)`;
      this.storeLookup(ins, res, `vec4(${call})`, 'f');
      return;
    }
    switch (op) {
      case OP.SAMPLE:
        call = off ? `textureOffset(${name}, ${uv}, ${off})` : `texture(${name}, ${uv})`;
        break;
      case OP.SAMPLE_B: {
        const bias = this.src(e1, [0], 'f');
        call = off ? `textureOffset(${name}, ${uv}, ${off}, ${bias})` : `texture(${name}, ${uv}, ${bias})`;
        break;
      }
      case OP.SAMPLE_L: {
        const lod = this.src(e1, [0], 'f');
        call = off ? `textureLodOffset(${name}, ${uv}, ${lod}, ${off})` : `textureLod(${name}, ${uv}, ${lod})`;
        break;
      }
      case OP.SAMPLE_D: {
        const n = info.dim === '1d' ? 1 : this.addressCount(info.dim);
        const pos = [0, 1, 2].slice(0, n);
        let gx = this.src(e1, pos, 'f'), gy = this.src(e2, pos, 'f');
        if (info.dim === '1d') { gx = `vec2(${gx}, 0.0)`; gy = `vec2(${gy}, 0.0)`; }
        call = off ? `textureGradOffset(${name}, ${uv}, ${gx}, ${gy}, ${off})` : `textureGrad(${name}, ${uv}, ${gx}, ${gy})`;
        break;
      }
      default: throw new Error(`unsupported sample opcode ${ins.name}`);
    }
    this.storeLookup(ins, res, call, info.returnType === 'float' ? 'f' : info.returnType === 'uint' ? 'u' : 'i');
  }

  fetch(ins: Instruction) {
    const [, addr, res] = ins.operands;
    const texture = res.indices[0].imm;
    const { name, info } = this.samplerUniform(texture, null, false);
    const ty: Ty = info.returnType === 'float' ? 'f' : info.returnType === 'uint' ? 'u' : 'i';
    let call: string;
    if (info.dim === 'buffer') {
      const i = this.src(addr, [0], 'i');
      const w = `u_width_${name}`;
      call = `texelFetch(${name}, ivec2((${i}) % ${w}, (${i}) / ${w}), 0)`;
    } else {
      const lod = this.src(addr, [3], 'i');
      const off = this.offsetArg(ins, info.dim);
      let coord: string;
      if (info.dim === '1d') coord = `ivec2(${this.src(addr, [0], 'i')}, 0)`;
      else if (info.dim === '2d') coord = this.src(addr, [0, 1], 'i');
      else if (info.dim === 'cube') throw new Error('ld on a cube');
      else coord = this.src(addr, [0, 1, 2], 'i');
      call = off ? `texelFetchOffset(${name}, ${coord}, ${lod}, ${off})` : `texelFetch(${name}, ${coord}, ${lod})`;
    }
    this.storeLookup(ins, res, call, ty);
  }

  resinfo(ins: Instruction) {
    const [d, mip, res] = ins.operands;
    const P = this.dstPositions(d);
    if (!P) return;
    const texture = res.indices[0].imm;
    const { name, info } = this.samplerUniform(texture, null, false);
    if (info.dim === 'buffer') throw new Error('resinfo on a buffer');
    const lod = this.src(mip, [0], 'i');
    const size = info.dim === '2d' || info.dim === 'cube' || info.dim === '1d'
      ? `ivec4(textureSize(${name}, ${lod}), 0, 1)` : `ivec4(textureSize(${name}, ${lod}), 1)`;
    this.notes.push('resinfo reports one mip level (GLSL ES 3.00 cannot query the level count)');
    const kind = ins.resinfoReturn;
    const v = kind === 2 ? `uvec4(${size})` : kind === 1 ? `(1.0 / vec4(${size}))` : `vec4(${size})`;
    this.store(d, P, `${v}.${letters(P.map((p) => res.swizzle[p]))}`, kind === 2 ? 'u' : 'f', ins.saturate);
  }

  // ---- The program body.

  instruction(ins: Instruction) {
    const o = ins.operands;
    const I = (fn: (...a: string[]) => string) => this.componentwise(ins, 'u', 'u', fn);
    switch (ins.opcode) {
      case OP.ADD: return this.componentwise(ins, 'f', 'f', (a, b) => `(${a} + ${b})`);
      case OP.MUL: return this.componentwise(ins, 'f', 'f', (a, b) => `(${a} * ${b})`);
      case OP.MAD: return this.componentwise(ins, 'f', 'f', (a, b, c) => `(${a} * ${b} + ${c})`);
      case OP.DIV: return this.componentwise(ins, 'f', 'f', (a, b) => `(${a} / ${b})`);
      case OP.MIN: return this.edge(ins, 'min', 'dmin');
      case OP.MAX: return this.edge(ins, 'max', 'dmax');
      case OP.SQRT: return this.edge(ins, 'sqrt', 'dsqrt');
      case OP.RSQ: return this.edge(ins, 'rsq', 'drsq');
      case OP.LOG: return this.edge(ins, 'log', 'dlog');
      case OP.EXP: return this.componentwise(ins, 'f', 'f', (a) => `exp2(${a})`);
      case OP.FRC: return this.componentwise(ins, 'f', 'f', (a) => `fract(${a})`);
      case OP.ROUND_NE: return this.componentwise(ins, 'f', 'f', (a) => `roundEven(${a})`);
      case OP.ROUND_NI: return this.componentwise(ins, 'f', 'f', (a) => `floor(${a})`);
      case OP.ROUND_PI: return this.componentwise(ins, 'f', 'f', (a) => `ceil(${a})`);
      case OP.ROUND_Z: return this.componentwise(ins, 'f', 'f', (a) => `trunc(${a})`);
      case OP.DERIV_RTX: return this.componentwise(ins, 'f', 'f', (a) => `dFdx(${a})`);
      case OP.DERIV_RTY: return this.componentwise(ins, 'f', 'f', (a) => (this.y === 'clip' ? `dFdy(${a})` : `(-dFdy(${a}))`));
      case OP.DP2: return this.dot(ins, 2);
      case OP.DP3: return this.dot(ins, 3);
      case OP.DP4: return this.dot(ins, 4);
      case OP.MOV: return this.move(ins);
      case OP.MOVC: return this.select(ins);
      case OP.EQ: return this.compare(ins, 'f', '==', 'equal');
      case OP.NE: return this.compare(ins, 'f', '!=', 'notEqual');
      case OP.LT: return this.compare(ins, 'f', '<', 'lessThan');
      case OP.GE: return this.compare(ins, 'f', '>=', 'greaterThanEqual');
      case OP.IEQ: return this.compare(ins, 'i', '==', 'equal');
      case OP.INE: return this.compare(ins, 'i', '!=', 'notEqual');
      case OP.ILT: return this.compare(ins, 'i', '<', 'lessThan');
      case OP.IGE: return this.compare(ins, 'i', '>=', 'greaterThanEqual');
      case OP.ULT: return this.compare(ins, 'u', '<', 'lessThan');
      case OP.UGE: return this.compare(ins, 'u', '>=', 'greaterThanEqual');
      case OP.SINCOS:
        return this.twoDest(ins, 'f', (k, a) => (k === 0 ? `sin(${a})` : `cos(${a})`), 'f');
      case OP.ITOF: return this.componentwise(ins, 'i', 'f', (a) => `${vtype('f', this.dstPositions(o[0])?.length ?? 1)}(${a})`);
      case OP.UTOF: return this.componentwise(ins, 'u', 'f', (a) => `${vtype('f', this.dstPositions(o[0])?.length ?? 1)}(${a})`);
      case OP.FTOI:
        this.helpers.add('nan');
        this.helpers.add('ftoi');
        return this.componentwise(ins, 'f', 'i', (a) => `ftoi(${a})`);
      case OP.FTOU:
        this.helpers.add('nan');
        this.helpers.add('ftou');
        return this.componentwise(ins, 'f', 'u', (a) => `ftou(${a})`);
      // Integer arithmetic on the raw words: two's complement add/multiply
      // low words are sign-agnostic, so they run as uint (wrapping).
      case OP.IADD: return I((a, b) => `(${a} + ${b})`);
      case OP.IMAD: return I((a, b, c) => `(${a} * ${b} + ${c})`);
      case OP.UMAD: return I((a, b, c) => `(${a} * ${b} + ${c})`);
      case OP.INEG: return I((a) => `(${vtype('u', this.dstPositions(o[0])?.length ?? 1)}(0u) - ${a})`);
      case OP.AND: return I((a, b) => `(${a} & ${b})`);
      case OP.OR: return I((a, b) => `(${a} | ${b})`);
      case OP.XOR: return I((a, b) => `(${a} ^ ${b})`);
      case OP.NOT: return I((a) => `(~${a})`);
      case OP.ISHL: return I((a, b) => `(${a} << (${b} & ${this.splat(o[0], '31u')}))`);
      case OP.USHR: return I((a, b) => `(${a} >> (${b} & ${this.splat(o[0], '31u')}))`);
      case OP.ISHR: {
        const n = this.dstPositions(o[0])?.length ?? 1;
        return I((a, b) => `${vtype('u', n)}(${vtype('i', n)}(${a}) >> ${vtype('i', n)}(${b} & ${this.splat(o[0], '31u')}))`);
      }
      case OP.UMIN: return I((a, b) => `min(${a}, ${b})`);
      case OP.UMAX: return I((a, b) => `max(${a}, ${b})`);
      case OP.IMIN: return this.componentwise(ins, 'i', 'i', (a, b) => `min(${a}, ${b})`);
      case OP.IMAX: return this.componentwise(ins, 'i', 'i', (a, b) => `max(${a}, ${b})`);
      case OP.IMUL:
      case OP.UMUL: {
        const signed = ins.opcode === OP.IMUL;
        if (o[0].type !== OPERAND.NULL) this.helpers.add('mulhi');
        return this.twoDest(ins, 'u', (k, a, b) => {
          if (k === 1) return `(${a} * ${b})`;
          const n = this.dstPositions(o[0])!.length;
          const f = signed ? 'imulhi' : 'umulhi';
          if (n === 1) return `${f}(${a}, ${b})`;
          return `uvec${n}(${[...Array(n)].map((_, c) => `${f}(${a}.${LETTERS[c]}, ${b}.${LETTERS[c]})`).join(', ')})`;
        }, 'u');
      }
      case OP.UDIV: {
        this.helpers.add('udiv');
        return this.twoDest(ins, 'u', (k, a, b) => {
          const n = this.dstPositions(o[k])!.length;
          const f = k === 0 ? 'udivq' : 'udivr';
          if (n === 1) return `${f}(${a}, ${b})`;
          return `uvec${n}(${[...Array(n)].map((_, c) => `${f}(${a}.${LETTERS[c]}, ${b}.${LETTERS[c]})`).join(', ')})`;
        }, 'u');
      }
      case OP.SAMPLE:
      case OP.SAMPLE_B:
      case OP.SAMPLE_L:
      case OP.SAMPLE_D:
      case OP.SAMPLE_C:
      case OP.SAMPLE_C_LZ:
        return this.sample(ins);
      case OP.LD: return this.fetch(ins);
      case OP.RESINFO: return this.resinfo(ins);
      case OP.IF:
        this.line(`if (${this.cond(o[0], ins.testNonZero)}) {`);
        this.depth++;
        return;
      case OP.ELSE:
        this.depth--;
        this.line('} else {');
        this.depth++;
        return;
      case OP.ENDIF:
      case OP.ENDLOOP:
      case OP.ENDSWITCH:
        this.depth--;
        this.line('}');
        return;
      case OP.LOOP:
        this.line('while (true) {');
        this.depth++;
        return;
      case OP.BREAK: return this.line('break;');
      case OP.BREAKC: return this.line(`if (${this.cond(o[0], ins.testNonZero)}) break;`);
      case OP.CONTINUE: return this.line('continue;');
      case OP.CONTINUEC: return this.line(`if (${this.cond(o[0], ins.testNonZero)}) continue;`);
      case OP.RET: return this.line('return;');
      case OP.RETC: return this.line(`if (${this.cond(o[0], ins.testNonZero)}) return;`);
      case OP.DISCARD:
        if (this.stage !== 'ps') throw new Error('discard outside a pixel shader');
        return this.line(`if (${this.cond(o[0], ins.testNonZero)}) discard;`);
      case OP.SWITCH:
        this.line(`switch (${this.src(o[0], [0], 'i')}) {`);
        this.depth++;
        return;
      case OP.CASE:
        return this.line(`case ${o[0].values ? o[0].values[0] | 0 : 0}:`);
      case OP.DEFAULT: return this.line('default:');
      case OP.NOP: return;
      default:
        throw new Error(`unsupported instruction ${ins.name}`);
    }
  }

  /** Float instructions whose edge cases follow the source rules (see OPTIONAL_HELPERS). */
  edge(ins: Instruction, helper: string, fn: string) {
    this.helpers.add('nan');
    this.helpers.add(helper);
    return this.componentwise(ins, 'f', 'f', (...a) => `${fn}(${a.join(', ')})`);
  }

  /** A uint splat sized like the destination (shift counts). */
  splat(d: Operand, value: string): string {
    const n = this.dstPositions(d)?.length ?? 1;
    return n === 1 ? value : `uvec${n}(${value})`;
  }

  emit() {
    for (const ins of this.sh.instructions) this.instruction(ins);
    if (this.usesRelativeRegister(OPERAND.INPUT) || this.usesRelativeRegister(OPERAND.OUTPUT)) throw new Error('indexed input or output registers are not supported');
  }

  /** main()'s zeroing of the temp registers ('' when there are none). */
  tempsInit(): string {
    const n = this.sh.decls.temps;
    return n ? `  ${[...Array(n)].map((_, k) => `r${k} = uvec4(0u);`).join(' ')}\n` : '';
  }

  /** Uniform, constant and sampler declarations for this stage. */
  declarations(): string[] {
    const out: string[] = [];
    for (const cb of this.sh.decls.constantBuffers) out.push(`uniform uvec4 cb${cb.slot}_${this.stage}[${Math.max(1, cb.size)}];`);
    const icb = this.sh.decls.immediateConstantBuffer;
    if (icb) {
      const n = icb.length >> 2;
      const items: string[] = [];
      for (let k = 0; k < n; k++) items.push(`uvec4(${[0, 1, 2, 3].map((c) => hex(icb[4 * k + c])).join(', ')})`);
      out.push(`const uvec4 icb[${n}] = uvec4[${n}](${items.join(', ')});`);
    }
    for (const s of this.samplers.values()) {
      out.push(`uniform highp ${this.samplerType(s)} ${s.uniform};`);
      if (s.widthUniform) out.push(`uniform int ${s.widthUniform};`);
    }
    if (this.sh.decls.temps) out.push(`uvec4 ${[...Array(this.sh.decls.temps)].map((_, k) => `r${k}`).join(', ')};`);
    for (const x of this.sh.decls.indexableTemps) out.push(`uvec4 x${x.register}[${x.size}];`);
    return out;
  }

  helperSource(): string {
    let s = HELPERS;
    for (const h of ['nan', 'sat', 'min', 'max', 'log', 'sqrt', 'rsq', 'ftoi', 'ftou', 'udiv', 'mulhi']) if (this.helpers.has(h)) s += OPTIONAL_HELPERS[h];
    return s;
  }

  precision(): string {
    const types = new Set([...this.samplers.values()].map((s) => this.samplerType(s)));
    return ['precision highp float;', 'precision highp int;', ...[...types].sort().map((t) => `precision highp ${t};`)].join('\n');
  }

  private usesRelativeRegister(type: number): boolean {
    const hit = (o: Operand): boolean => o.type === type && !!o.indices[0]?.rel
      || o.indices.some((i) => !!i.rel && hit(i.rel));
    return this.sh.instructions.some((ins) => ins.operands.some(hit));
  }
}

/** Registers the vertex stage must pass on, and how the pixel stage interpolates each. */
interface Linkage {
  register: number;
  interpolation: number;
}

function outputRegisters(sh: DxbcShader): { position: number | null; others: number[] } {
  let position: number | null = null;
  const others = new Set<number>();
  for (const d of sh.decls.outputs) {
    if (d.depth || d.register < 0) continue;
    if (d.systemValue === NAME.POSITION) position = d.register;
    else others.add(d.register);
  }
  for (const e of sh.outputs) {
    if (e.systemValue === NAME.POSITION && position === null) position = e.register;
  }
  if (position !== null) others.delete(position);
  return { position, others: [...others].sort((a, b) => a - b) };
}

function pixelLinkage(ps: DxbcShader): { varyings: Linkage[]; position: number | null; frontFace: number | null } {
  const varyings = new Map<number, number>();
  let position: number | null = null;
  let frontFace: number | null = null;
  for (const d of ps.decls.inputs) {
    if (d.register < 0) continue;
    if (d.systemValue === NAME.POSITION) { position = d.register; continue; }
    if (d.systemValue === NAME.IS_FRONT_FACE) { frontFace = d.register; continue; }
    if (d.systemValue !== 0) continue;
    const prev = varyings.get(d.register);
    if (prev !== undefined && prev !== d.interpolation) throw new Error(`mixed interpolation in v${d.register}`);
    varyings.set(d.register, d.interpolation);
  }
  return { varyings: [...varyings].map(([register, interpolation]) => ({ register, interpolation })).sort((a, b) => a.register - b.register), position, frontFace };
}

function qualifier(interpolation: number, notes: string[]): { flat: boolean; centroid: boolean; noperspective: boolean } {
  switch (interpolation) {
    case INTERPOLATION.CONSTANT: return { flat: true, centroid: false, noperspective: false };
    case INTERPOLATION.LINEAR_CENTROID: return { flat: false, centroid: true, noperspective: false };
    case INTERPOLATION.LINEAR_NOPERSPECTIVE: return { flat: false, centroid: false, noperspective: true };
    case INTERPOLATION.LINEAR_NOPERSPECTIVE_CENTROID: return { flat: false, centroid: true, noperspective: true };
    case INTERPOLATION.LINEAR_SAMPLE:
      notes.push('per-sample interpolation runs at pixel rate');
      return { flat: false, centroid: false, noperspective: false };
    case INTERPOLATION.LINEAR_NOPERSPECTIVE_SAMPLE:
      notes.push('per-sample interpolation runs at pixel rate');
      return { flat: false, centroid: false, noperspective: true };
    default: return { flat: false, centroid: false, noperspective: false };
  }
}

function cbBindings(sh: DxbcShader | null, stage: 'vs' | 'ps'): ConstantBufferBinding[] {
  if (!sh) return [];
  return sh.decls.constantBuffers.map((cb) => {
    const binding = sh.reflection?.bindings.find((b) => b.type === INPUT_TYPE.CBUFFER && b.bindPoint === cb.slot);
    const refl = binding ? sh.reflection!.constantBuffers.find((c) => c.name === binding.name) : undefined;
    return {
      stage, slot: cb.slot, uniform: `cb${cb.slot}_${stage}`, sizeVec4: cb.size, name: binding?.name ?? `cb${cb.slot}`,
      variables: (refl?.variables ?? []).map((v) => ({ name: v.name, parent: v.parent, offset: v.offset, size: v.size })),
    };
  });
}

function asShader(s: Uint8Array | DxbcShader | null): DxbcShader | null {
  if (!s) return null;
  return s instanceof Uint8Array ? parseDxbc(s) : s;
}

/**
 * Translates a vertex/pixel pair. Either stage may be null for validation:
 * a missing pixel stage becomes a shader writing zero, a missing vertex
 * stage one that feeds zeros to every input the pixel stage reads.
 */
export function translate(
  vsSource: Uint8Array | DxbcShader | null,
  psSource: Uint8Array | DxbcShader | null,
  options: TranslateOptions = {},
): TranslatedProgram {
  const y = options.y ?? 'fragcoord';
  const vs = asShader(vsSource), ps = asShader(psSource);
  if (vs && vs.stage !== 'vertex') throw new Error(`expected a vertex shader, got ${vs.stage}`);
  if (ps && ps.stage !== 'pixel') throw new Error(`expected a pixel shader, got ${ps.stage}`);
  const notes: string[] = [];
  const link = ps ? pixelLinkage(ps) : null;
  const vsOut = vs ? outputRegisters(vs) : { position: null, others: [] as number[] };
  const linked: Linkage[] = link
    ? link.varyings
    : vsOut.others.map((register) => ({ register, interpolation: INTERPOLATION.LINEAR }));
  const quals = new Map(linked.map((l) => [l.register, qualifier(l.interpolation, notes)]));
  const varyingDecl = (dir: 'in' | 'out', l: Linkage) => {
    const q = quals.get(l.register)!;
    if (q.flat) return `flat ${dir} uvec4 vr${l.register};`;
    return `${q.centroid ? 'centroid ' : ''}${dir} vec4 vr${l.register};`;
  };

  // ---- Vertex stage.
  const attributes: AttributeBinding[] = [];
  let vertex: string;
  let vsWriter: StageWriter | null = null;
  if (vs) {
    const w = new StageWriter(vs, 'vs', y, notes);
    vsWriter = w;
    w.emit();
    const inputs: string[] = [];
    const prologue: string[] = [];
    const inputRegs = new Set<number>();
    for (const d of vs.decls.inputs) {
      if (inputRegs.has(d.register)) continue;
      inputRegs.add(d.register);
      if (d.systemValue === NAME.VERTEX_ID) { prologue.push(`v${d.register} = uvec4(uint(gl_VertexID), 0u, 0u, 0u);`); continue; }
      if (d.systemValue === NAME.INSTANCE_ID) { prologue.push(`v${d.register} = uvec4(uint(gl_InstanceID), 0u, 0u, 0u);`); continue; }
      if (d.systemValue !== 0) throw new Error(`unsupported vertex input system value ${d.systemValue}`);
      const el = vs.inputs.find((e) => e.register === d.register);
      const ct = el ? componentType(el.componentType) : 'float';
      const name = `a${d.register}`;
      attributes.push({ name, semantic: el?.name ?? '', semanticIndex: el?.index ?? 0, register: d.register, componentType: ct, mask: el?.mask ?? d.mask });
      inputs.push(`in ${ct === 'float' ? 'vec4' : ct === 'uint' ? 'uvec4' : 'ivec4'} ${name};`);
      prologue.push(`v${d.register} = ${ct === 'float' ? `U(${name})` : ct === 'uint' ? name : `uvec4(${name})`};`);
    }
    const inputGlobals = [...inputRegs].sort((a, b) => a - b).map((r) => `v${r}`);
    const outRegs = new Set<number>(vsOut.others);
    if (vsOut.position !== null) outRegs.add(vsOut.position);
    for (const l of linked) outRegs.add(l.register);
    const outGlobals = [...outRegs].sort((a, b) => a - b).map((r) => `o${r}`);
    const epilogue: string[] = [];
    if (vsOut.position === null) throw new Error('vertex shader without a position output');
    epilogue.push(`vec4 p = F(o${vsOut.position});`);
    epilogue.push(`gl_Position = vec4(p.x, ${y === 'clip' ? '-p.y' : 'p.y'}, ${options.depth === 'zeroToOne' ? 'p.z' : '2.0 * p.z - p.w'}, p.w);`);
    for (const l of linked) {
      const q = quals.get(l.register)!;
      if (q.flat) epilogue.push(`vr${l.register} = o${l.register};`);
      else if (q.noperspective) epilogue.push(`vr${l.register} = F(o${l.register}) * p.w;`);
      else epilogue.push(`vr${l.register} = F(o${l.register});`);
    }
    vertex = [
      '#version 300 es',
      w.precision(),
      w.helperSource(),
      ...w.declarations(),
      ...inputs,
      ...linked.map((l) => varyingDecl('out', l)),
      inputGlobals.length ? `uvec4 ${inputGlobals.join(', ')};` : '',
      outGlobals.length ? `uvec4 ${outGlobals.join(', ')};` : '',
      'void body() {',
      ...w.body,
      '}',
      'void main() {',
      ...prologue.map((s) => '  ' + s),
      ...outGlobals.map((o) => `  ${o} = uvec4(0u);`),
      w.tempsInit() + '  body();',
      ...epilogue.map((s) => '  ' + s),
      '}',
      '',
    ].filter((s) => s !== '').join('\n');
  } else {
    const lines = ['#version 300 es', 'precision highp float;', 'precision highp int;',
      ...linked.map((l) => varyingDecl('out', l)), 'void main() {',
      ...linked.map((l) => (quals.get(l.register)!.flat ? `  vr${l.register} = uvec4(0u);` : `  vr${l.register} = vec4(0.0);`)),
      '  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);', '}', ''];
    vertex = lines.join('\n');
  }

  // ---- Pixel stage.
  const outputs: OutputBinding[] = [];
  let fragment: string;
  let targetHeightUniform: string | null = null;
  let psWriter: StageWriter | null = null;
  if (ps) {
    const w = new StageWriter(ps, 'ps', y, notes);
    psWriter = w;
    w.emit();
    const prologue: string[] = [];
    const inputRegs = new Set<number>();
    for (const l of link!.varyings) {
      inputRegs.add(l.register);
      const q = quals.get(l.register)!;
      if (q.flat) prologue.push(`v${l.register} = vr${l.register};`);
      else if (q.noperspective) prologue.push(`v${l.register} = U(vr${l.register} * gl_FragCoord.w);`);
      else prologue.push(`v${l.register} = U(vr${l.register});`);
    }
    if (link!.position !== null) {
      inputRegs.add(link!.position);
      if (y === 'clip') prologue.push(`v${link!.position} = U(vec4(gl_FragCoord.xy, gl_FragCoord.z, 1.0 / gl_FragCoord.w));`);
      else {
        targetHeightUniform = 'u_targetHeight';
        prologue.push(`v${link!.position} = U(vec4(gl_FragCoord.x, u_targetHeight - gl_FragCoord.y, gl_FragCoord.z, 1.0 / gl_FragCoord.w));`);
      }
    }
    if (link!.frontFace !== null) {
      inputRegs.add(link!.frontFace);
      prologue.push(`v${link!.frontFace} = uvec4(gl_FrontFacing ? 0xffffffffu : 0u);`);
    }
    for (const d of ps.decls.inputs) {
      if (d.register < 0 || inputRegs.has(d.register)) continue;
      notes.push(`pixel input system value ${d.systemValue} reads zero`);
      inputRegs.add(d.register);
      prologue.push(`v${d.register} = uvec4(0u);`);
    }
    const outDecls: string[] = [];
    const epilogue: string[] = [];
    const outRegs: number[] = [];
    let depth = false;
    for (const d of ps.decls.outputs) {
      if (d.depth) { depth = true; continue; }
      if (d.register < 0) continue;
      outRegs.push(d.register);
      const el = ps.outputs.find((e) => e.register === d.register && e.systemValue === NAME.TARGET)
        ?? ps.outputs.find((e) => e.register === d.register);
      const ct = el ? componentType(el.componentType) : 'float';
      outputs.push({ location: d.register, name: `frag${d.register}`, componentType: ct });
      outDecls.push(`layout(location = ${d.register}) out ${ct === 'float' ? 'vec4' : ct === 'uint' ? 'uvec4' : 'ivec4'} frag${d.register};`);
      epilogue.push(`frag${d.register} = ${ct === 'float' ? `F(o${d.register})` : ct === 'uint' ? `o${d.register}` : `ivec4(o${d.register})`};`);
    }
    if (depth) epilogue.push('gl_FragDepth = F(oDepth);');
    const inputGlobals = [...inputRegs].sort((a, b) => a - b).map((r) => `v${r}`);
    const outGlobals = outRegs.sort((a, b) => a - b).map((r) => `o${r}`);
    fragment = [
      '#version 300 es',
      w.precision(),
      w.helperSource(),
      ...w.declarations(),
      targetHeightUniform ? `uniform float ${targetHeightUniform};` : '',
      ...link!.varyings.map((l) => varyingDecl('in', l)),
      ...outDecls,
      inputGlobals.length ? `uvec4 ${inputGlobals.join(', ')};` : '',
      outGlobals.length ? `uvec4 ${outGlobals.join(', ')};` : '',
      depth ? 'uint oDepth;' : '',
      'void body() {',
      ...w.body,
      '}',
      'void main() {',
      ...prologue.map((s) => '  ' + s),
      ...outGlobals.map((o) => `  ${o} = uvec4(0u);`),
      depth ? '  oDepth = 0u;' : '',
      w.tempsInit() + '  body();',
      ...epilogue.map((s) => '  ' + s),
      '}',
      '',
    ].filter((s) => s !== '').join('\n');
  } else {
    fragment = ['#version 300 es', 'precision highp float;',
      'layout(location = 0) out vec4 frag0;', 'void main() {', '  frag0 = vec4(0.0);', '}', ''].join('\n');
  }

  const samplers = [...(vsWriter?.samplers.values() ?? []), ...(psWriter?.samplers.values() ?? [])];
  return {
    vertex, fragment, attributes,
    constantBuffers: { vs: cbBindings(vs, 'vs'), ps: cbBindings(ps, 'ps') },
    samplers, outputs, targetHeightUniform, y, notes: [...new Set(notes)],
  };
}
