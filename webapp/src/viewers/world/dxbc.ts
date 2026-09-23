// Direct3D shader model 4 bytecode, as stored in the user's own shader
// bundles (vertex shaders in assetBundle7, pixel shaders in assetBundle4,
// each object a u8 blob count then blob count x (u32le size + DXBC)).
//
// parseDxbc reads the container: reflection (RDEF: constant buffers with
// their variables, resource and sampler bindings), the input and output
// signatures (ISGN/OSGN) and the SHDR token stream, decoded into
// declarations and instructions. disassemble prints the instructions in the
// usual assembly syntax (for tests and debugging). dxbc-glsl.ts turns a
// parsed pair into GLSL ES 3.00.

/** Opcode numbers (the token stream's 11-bit opcode field). */
export const OP = {
  ADD: 0, AND: 1, BREAK: 2, BREAKC: 3, CALL: 4, CALLC: 5, CASE: 6, CONTINUE: 7, CONTINUEC: 8, CUT: 9,
  DEFAULT: 10, DERIV_RTX: 11, DERIV_RTY: 12, DISCARD: 13, DIV: 14, DP2: 15, DP3: 16, DP4: 17, ELSE: 18,
  EMIT: 19, EMITTHENCUT: 20, ENDIF: 21, ENDLOOP: 22, ENDSWITCH: 23, EQ: 24, EXP: 25, FRC: 26, FTOI: 27,
  FTOU: 28, GE: 29, IADD: 30, IF: 31, IEQ: 32, IGE: 33, ILT: 34, IMAD: 35, IMAX: 36, IMIN: 37, IMUL: 38,
  INE: 39, INEG: 40, ISHL: 41, ISHR: 42, ITOF: 43, LABEL: 44, LD: 45, LD_MS: 46, LOG: 47, LOOP: 48,
  LT: 49, MAD: 50, MIN: 51, MAX: 52, CUSTOMDATA: 53, MOV: 54, MOVC: 55, MUL: 56, NE: 57, NOP: 58,
  NOT: 59, OR: 60, RESINFO: 61, RET: 62, RETC: 63, ROUND_NE: 64, ROUND_NI: 65, ROUND_PI: 66,
  ROUND_Z: 67, RSQ: 68, SAMPLE: 69, SAMPLE_C: 70, SAMPLE_C_LZ: 71, SAMPLE_L: 72, SAMPLE_D: 73,
  SAMPLE_B: 74, SQRT: 75, SWITCH: 76, SINCOS: 77, UDIV: 78, ULT: 79, UGE: 80, UMUL: 81, UMAD: 82,
  UMAX: 83, UMIN: 84, USHR: 85, UTOF: 86, XOR: 87,
  DCL_RESOURCE: 88, DCL_CONSTANT_BUFFER: 89, DCL_SAMPLER: 90, DCL_INDEX_RANGE: 91,
  DCL_GS_OUTPUT_TOPOLOGY: 92, DCL_GS_INPUT_PRIMITIVE: 93, DCL_MAX_OUTPUT_VERTEX_COUNT: 94,
  DCL_INPUT: 95, DCL_INPUT_SGV: 96, DCL_INPUT_SIV: 97, DCL_INPUT_PS: 98, DCL_INPUT_PS_SGV: 99,
  DCL_INPUT_PS_SIV: 100, DCL_OUTPUT: 101, DCL_OUTPUT_SGV: 102, DCL_OUTPUT_SIV: 103, DCL_TEMPS: 104,
  DCL_INDEXABLE_TEMP: 105, DCL_GLOBAL_FLAGS: 106, LOD: 108, GATHER4: 109, SAMPLE_POS: 110, SAMPLE_INFO: 111,
} as const;

/** Assembly mnemonics by opcode number. */
export const OPCODE_NAMES: readonly string[] = [
  'add', 'and', 'break', 'breakc', 'call', 'callc', 'case', 'continue', 'continuec', 'cut',
  'default', 'deriv_rtx', 'deriv_rty', 'discard', 'div', 'dp2', 'dp3', 'dp4', 'else', 'emit',
  'emit_then_cut', 'endif', 'endloop', 'endswitch', 'eq', 'exp', 'frc', 'ftoi', 'ftou', 'ge',
  'iadd', 'if', 'ieq', 'ige', 'ilt', 'imad', 'imax', 'imin', 'imul', 'ine',
  'ineg', 'ishl', 'ishr', 'itof', 'label', 'ld', 'ld_ms', 'log', 'loop', 'lt',
  'mad', 'min', 'max', 'customdata', 'mov', 'movc', 'mul', 'ne', 'nop', 'not',
  'or', 'resinfo', 'ret', 'retc', 'round_ne', 'round_ni', 'round_pi', 'round_z', 'rsq', 'sample',
  'sample_c', 'sample_c_lz', 'sample_l', 'sample_d', 'sample_b', 'sqrt', 'switch', 'sincos', 'udiv', 'ult',
  'uge', 'umul', 'umad', 'umax', 'umin', 'ushr', 'utof', 'xor', 'dcl_resource', 'dcl_constantbuffer',
  'dcl_sampler', 'dcl_indexRange', 'dcl_outputtopology', 'dcl_inputprimitive', 'dcl_maxout', 'dcl_input',
  'dcl_input_sgv', 'dcl_input_siv', 'dcl_input_ps', 'dcl_input_ps_sgv', 'dcl_input_ps_siv', 'dcl_output',
  'dcl_output_sgv', 'dcl_output_siv', 'dcl_temps', 'dcl_indexableTemp', 'dcl_globalFlags', 'reserved',
  'lod', 'gather4', 'sample_pos', 'sample_info',
];

/** Operand register files. */
export const OPERAND = {
  TEMP: 0, INPUT: 1, OUTPUT: 2, INDEXABLE_TEMP: 3, IMMEDIATE32: 4, IMMEDIATE64: 5, SAMPLER: 6,
  RESOURCE: 7, CONSTANT_BUFFER: 8, IMMEDIATE_CONSTANT_BUFFER: 9, LABEL: 10, INPUT_PRIMITIVEID: 11,
  OUTPUT_DEPTH: 12, NULL: 13, RASTERIZER: 14, OUTPUT_COVERAGE_MASK: 15,
} as const;

/** System value names used by declarations and signatures. */
export const NAME = {
  UNDEFINED: 0, POSITION: 1, CLIP_DISTANCE: 2, CULL_DISTANCE: 3, RENDER_TARGET_ARRAY_INDEX: 4,
  VIEWPORT_ARRAY_INDEX: 5, VERTEX_ID: 6, PRIMITIVE_ID: 7, INSTANCE_ID: 8, IS_FRONT_FACE: 9,
  SAMPLE_INDEX: 10, TARGET: 64, DEPTH: 65, COVERAGE: 66,
} as const;

/** Resource dimensions of dcl_resource. */
export const RESOURCE_DIM = {
  UNKNOWN: 0, BUFFER: 1, TEXTURE1D: 2, TEXTURE2D: 3, TEXTURE2DMS: 4, TEXTURE3D: 5, TEXTURECUBE: 6,
  TEXTURE1DARRAY: 7, TEXTURE2DARRAY: 8, TEXTURE2DMSARRAY: 9, TEXTURECUBEARRAY: 10,
} as const;
const RESOURCE_DIM_NAMES = ['unknown', 'buffer', 'texture1d', 'texture2d', 'texture2dms', 'texture3d',
  'texturecube', 'texture1darray', 'texture2darray', 'texture2dmsarray', 'texturecubearray'];

/** Per-component return types of dcl_resource (1 unorm, 2 snorm, 3 sint, 4 uint, 5 float, 6 mixed). */
const RETURN_NAMES = ['', 'unorm', 'snorm', 'sint', 'uint', 'float', 'mixed', 'double', 'continued', 'unused'];

/** Interpolation modes of dcl_input_ps. */
export const INTERPOLATION = {
  UNDEFINED: 0, CONSTANT: 1, LINEAR: 2, LINEAR_CENTROID: 3, LINEAR_NOPERSPECTIVE: 4,
  LINEAR_NOPERSPECTIVE_CENTROID: 5, LINEAR_SAMPLE: 6, LINEAR_NOPERSPECTIVE_SAMPLE: 7,
} as const;
const INTERPOLATION_NAMES = ['undefined', 'constant', 'linear', 'linear centroid', 'linear noperspective',
  'linear noperspective centroid', 'linear sample', 'linear noperspective sample'];

/** Signature component types (0 unknown, 1 uint32, 2 sint32, 3 float32). */
export const COMPONENT = { UNKNOWN: 0, UINT32: 1, SINT32: 2, FLOAT32: 3 } as const;

/** Reflection shader input types (resource bindings). */
export const INPUT_TYPE = { CBUFFER: 0, TBUFFER: 1, TEXTURE: 2, SAMPLER: 3 } as const;

export interface SignatureElement {
  name: string;
  index: number;
  systemValue: number;
  componentType: number;
  register: number;
  mask: number;
  /** ISGN: components the shader reads; OSGN: components it never writes. */
  rwMask: number;
}

export interface CBufferVariable {
  name: string;
  /** Enclosing struct variable, when the member came from one. */
  parent: string | null;
  offset: number;
  size: number;
  class: number;
  type: number;
  rows: number;
  columns: number;
  elements: number;
}

export interface CBufferReflection {
  name: string;
  size: number;
  type: number;
  flags: number;
  /** Members flattened out of struct variables, absolute byte offsets. */
  variables: CBufferVariable[];
}

export interface ResourceBinding {
  name: string;
  type: number;
  returnType: number;
  dimension: number;
  samples: number;
  bindPoint: number;
  bindCount: number;
  flags: number;
}

export interface Reflection {
  constantBuffers: CBufferReflection[];
  bindings: ResourceBinding[];
  creator: string;
  target: number;
}

export interface OperandIndex {
  imm: number;
  rel: Operand | null;
}

export interface Operand {
  type: number;
  /** 0, 1 or 4 components (3 = N, unused by shader model 4 code). */
  comps: number;
  /** 'mask' for destinations, 'swizzle' or 'select1' for sources; null otherwise. */
  sel: 'mask' | 'swizzle' | 'select1' | null;
  mask: number;
  /** Source component per position (identity for masks and immediates). */
  swizzle: [number, number, number, number];
  indices: OperandIndex[];
  /** Raw 32-bit immediate values (1 or 4) for immediate operands. */
  values: Uint32Array | null;
  /** 0 none, 1 neg, 2 abs, 3 abs then neg. */
  modifier: number;
}

export interface Instruction {
  opcode: number;
  name: string;
  saturate: boolean;
  /** Conditional ops: true tests non-zero (_nz), false tests zero (_z). */
  testNonZero: boolean;
  /** Opcode-specific control bits 11 to 23. */
  controls: number;
  operands: Operand[];
  /** Immediate texel offsets (aoffimmi) of sample and ld. */
  offsets: [number, number, number] | null;
  /** resinfo return type: 0 float, 1 rcpFloat, 2 uint. */
  resinfoReturn: number;
  /** Token offset of the instruction in the program (dwords after the two header tokens). */
  at: number;
}

export interface InputDecl {
  register: number;
  mask: number;
  interpolation: number;
  systemValue: number;
  opcode: number;
}

export interface OutputDecl {
  register: number;
  mask: number;
  systemValue: number;
  depth: boolean;
}

export interface ResourceDecl {
  slot: number;
  dimension: number;
  returnType: [number, number, number, number];
  samples: number;
}

export interface SamplerDecl {
  slot: number;
  /** 0 default, 1 comparison, 2 mono. */
  mode: number;
}

export interface ConstantBufferDecl {
  slot: number;
  size: number;
  dynamic: boolean;
}

export interface Declarations {
  temps: number;
  indexableTemps: { register: number; size: number; comps: number }[];
  inputs: InputDecl[];
  outputs: OutputDecl[];
  resources: ResourceDecl[];
  samplers: SamplerDecl[];
  constantBuffers: ConstantBufferDecl[];
  immediateConstantBuffer: Uint32Array | null;
  globalFlags: number;
}

export interface DxbcShader {
  stage: 'pixel' | 'vertex' | 'geometry' | 'hull' | 'domain' | 'compute';
  major: number;
  minor: number;
  reflection: Reflection | null;
  inputs: SignatureElement[];
  outputs: SignatureElement[];
  decls: Declarations;
  /** Executable instructions (declarations removed). */
  instructions: Instruction[];
  /** Every token-stream entry in order, declarations included. */
  all: Instruction[];
}

const STAGES: DxbcShader['stage'][] = ['pixel', 'vertex', 'geometry', 'hull', 'domain', 'compute'];

function cstring(bytes: Uint8Array, at: number): string {
  let end = at;
  while (end < bytes.length && bytes[end] !== 0) end++;
  let s = '';
  for (let i = at; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Locates the DXBC container in a bundle shader object (u8 count, then u32le size + DXBC per blob). */
export function shaderBlobs(object: Uint8Array): Uint8Array[] {
  const view = new DataView(object.buffer, object.byteOffset, object.byteLength);
  const count = object[0];
  const out: Uint8Array[] = [];
  let at = 1;
  for (let k = 0; k < count; k++) {
    if (at + 4 > object.length) throw new Error('truncated shader object');
    const size = view.getUint32(at, true);
    at += 4;
    const blob = object.subarray(at, at + size);
    if (blob.length !== size || cstring(blob.subarray(0, 4), 0) !== 'DXBC') throw new Error('shader object without a DXBC container');
    out.push(blob);
    at += size;
  }
  return out;
}

function chunks(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length < 32 || cstring(bytes.subarray(0, 4), 0) !== 'DXBC') throw new Error('not a DXBC container');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(24, true);
  if (total > bytes.length) throw new Error('truncated DXBC container');
  const count = view.getUint32(28, true);
  const out = new Map<string, Uint8Array>();
  for (let k = 0; k < count; k++) {
    const at = view.getUint32(32 + 4 * k, true);
    const fourcc = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > bytes.length) throw new Error(`truncated ${fourcc} chunk`);
    out.set(fourcc, bytes.subarray(at + 8, at + 8 + size));
  }
  return out;
}

function parseSignature(chunk: Uint8Array | undefined): SignatureElement[] {
  if (!chunk) return [];
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const count = view.getUint32(0, true);
  const out: SignatureElement[] = [];
  for (let k = 0; k < count; k++) {
    const at = 8 + 24 * k;
    out.push({
      name: cstring(chunk, view.getUint32(at, true)),
      index: view.getUint32(at + 4, true),
      systemValue: view.getUint32(at + 8, true),
      componentType: view.getUint32(at + 12, true),
      register: view.getUint32(at + 16, true),
      mask: chunk[at + 20],
      rwMask: chunk[at + 21],
    });
  }
  return out;
}

function parseReflection(chunk: Uint8Array | undefined): Reflection | null {
  if (!chunk) return null;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const u32 = (at: number) => view.getUint32(at, true);
  const u16 = (at: number) => view.getUint16(at, true);
  const cbCount = u32(0), cbAt = u32(4), bindCount = u32(8), bindAt = u32(12);
  const target = u32(16), creatorAt = u32(24);
  // Shader model 5 reflection adds an 'RD11' header and longer variable
  // records; shader model 4 records are 24 bytes.
  const rd11 = chunk.length >= 32 && cstring(chunk.subarray(28, 32), 0) === 'RD11';
  const variableStride = rd11 ? 40 : 24;
  const bindings: ResourceBinding[] = [];
  for (let k = 0; k < bindCount; k++) {
    const at = bindAt + 32 * k;
    bindings.push({
      name: cstring(chunk, u32(at)), type: u32(at + 4), returnType: u32(at + 8), dimension: u32(at + 12),
      samples: u32(at + 16), bindPoint: u32(at + 20), bindCount: u32(at + 24), flags: u32(at + 28),
    });
  }
  const constantBuffers: CBufferReflection[] = [];
  const flatten = (out: CBufferVariable[], name: string, parent: string | null, typeAt: number, offset: number, size: number) => {
    const cls = u16(typeAt), type = u16(typeAt + 2), rows = u16(typeAt + 4), columns = u16(typeAt + 6);
    const elements = u16(typeAt + 8), members = u16(typeAt + 10), membersAt = u32(typeAt + 12);
    if (cls === 5 && members > 0) {
      // Struct: members carry their offsets relative to the struct.
      for (let m = 0; m < members; m++) {
        const at = membersAt + 12 * m;
        const memberName = cstring(chunk, u32(at));
        flatten(out, memberName, parent ?? name, u32(at + 4), offset + u32(at + 8), 0);
      }
      return;
    }
    out.push({ name, parent, offset, size, class: cls, type, rows, columns, elements });
  };
  for (let k = 0; k < cbCount; k++) {
    const at = cbAt + 24 * k;
    const variables: CBufferVariable[] = [];
    const count = u32(at + 4), varsAt = u32(at + 8);
    for (let v = 0; v < count; v++) {
      const vat = varsAt + variableStride * v;
      flatten(variables, cstring(chunk, u32(vat)), null, u32(vat + 16), u32(vat + 4), u32(vat + 8));
    }
    // Member sizes are not recorded; derive them from the next offset.
    variables.sort((a, b) => a.offset - b.offset);
    const size = u32(at + 12);
    for (let v = 0; v < variables.length; v++) {
      if (variables[v].size) continue;
      const next = v + 1 < variables.length ? variables[v + 1].offset : size;
      const x = variables[v];
      const natural = x.class === 2 || x.class === 3
        ? (x.class === 2 ? x.rows : x.columns) * 16 - 16 + 4 * (x.class === 2 ? x.columns : x.rows)
        : 4 * Math.max(1, x.columns) * Math.max(1, x.rows);
      x.size = x.elements > 1 ? next - x.offset : Math.min(natural, next - x.offset);
    }
    constantBuffers.push({ name: cstring(chunk, u32(at)), size, type: u32(at + 20), flags: u32(at + 16), variables });
  }
  return { constantBuffers, bindings, creator: creatorAt ? cstring(chunk, creatorAt) : '', target };
}

class TokenReader {
  pos = 0;
  constructor(readonly tokens: Uint32Array, readonly end: number) {}
  next(): number {
    if (this.pos >= this.end) throw new Error('truncated shader token stream');
    return this.tokens[this.pos++];
  }
}

function readOperand(r: TokenReader): Operand {
  const token = r.next();
  const compsCode = token & 3;
  const comps = compsCode === 0 ? 0 : compsCode === 1 ? 1 : compsCode === 2 ? 4 : 3;
  let sel: Operand['sel'] = null;
  let mask = 0;
  let swizzle: [number, number, number, number] = [0, 1, 2, 3];
  if (compsCode === 2) {
    const mode = (token >>> 2) & 3;
    if (mode === 0) {
      sel = 'mask';
      mask = (token >>> 4) & 15;
    } else if (mode === 1) {
      sel = 'swizzle';
      swizzle = [(token >>> 4) & 3, (token >>> 6) & 3, (token >>> 8) & 3, (token >>> 10) & 3];
      mask = 15;
    } else {
      sel = 'select1';
      const c = (token >>> 4) & 3;
      swizzle = [c, c, c, c];
      mask = 1 << c;
    }
  } else if (compsCode === 1) {
    mask = 1;
    swizzle = [0, 0, 0, 0];
  }
  const type = (token >>> 12) & 0xff;
  const dims = (token >>> 20) & 3;
  const reps = [(token >>> 22) & 7, (token >>> 25) & 7, (token >>> 28) & 7];
  let modifier = 0;
  let extended = (token >>> 31) !== 0;
  while (extended) {
    const ext = r.next();
    if ((ext & 0x3f) === 1) modifier = (ext >>> 6) & 0xff;
    extended = (ext >>> 31) !== 0;
  }
  let values: Uint32Array | null = null;
  if (type === OPERAND.IMMEDIATE32) {
    const n = comps === 4 ? 4 : 1;
    values = new Uint32Array(n);
    for (let k = 0; k < n; k++) values[k] = r.next();
  } else if (type === OPERAND.IMMEDIATE64) {
    const n = comps === 4 ? 4 : 1;
    values = new Uint32Array(2 * n);
    for (let k = 0; k < 2 * n; k++) values[k] = r.next();
  }
  const indices: OperandIndex[] = [];
  for (let d = 0; d < dims; d++) {
    const rep = reps[d];
    let imm = 0;
    let rel: Operand | null = null;
    if (rep === 0 || rep === 3) imm = r.next() | 0;
    else if (rep === 1 || rep === 4) {
      const hi = r.next(), lo = r.next();
      if (hi) throw new Error('64-bit operand index');
      imm = lo | 0;
    }
    if (rep === 2 || rep === 3 || rep === 4) rel = readOperand(r);
    indices.push({ imm, rel });
  }
  return { type, comps, sel, mask, swizzle, indices, values, modifier };
}

const DCL_WITH_NAME = new Set<number>([OP.DCL_INPUT_SGV, OP.DCL_INPUT_SIV, OP.DCL_INPUT_PS_SGV,
  OP.DCL_INPUT_PS_SIV, OP.DCL_OUTPUT_SGV, OP.DCL_OUTPUT_SIV]);

/** Parses one DXBC container (shader model 4 or 5 token stream). */
export function parseDxbc(bytes: Uint8Array): DxbcShader {
  const parts = chunks(bytes);
  const code = parts.get('SHDR') ?? parts.get('SHEX');
  if (!code) throw new Error('DXBC container without a shader program');
  const tokens = new Uint32Array(code.buffer.slice(code.byteOffset, code.byteOffset + (code.byteLength & ~3)));
  const version = tokens[0];
  const length = tokens[1];
  if (length > tokens.length) throw new Error('truncated shader program');
  const stage = STAGES[(version >>> 16) & 0xffff];
  if (!stage) throw new Error(`unknown shader program type ${version >>> 16}`);
  const decls: Declarations = {
    temps: 0, indexableTemps: [], inputs: [], outputs: [], resources: [], samplers: [], constantBuffers: [],
    immediateConstantBuffer: null, globalFlags: 0,
  };
  const all: Instruction[] = [];
  const instructions: Instruction[] = [];
  let pos = 2;
  while (pos < length) {
    const token = tokens[pos];
    const opcode = token & 0x7ff;
    const at = pos - 2;
    if (opcode === OP.CUSTOMDATA) {
      const dataClass = token >>> 11;
      const size = tokens[pos + 1];
      if (size < 2) throw new Error('bad custom data block');
      if (dataClass === 3) decls.immediateConstantBuffer = tokens.slice(pos + 2, pos + size);
      all.push({ opcode, name: dataClass === 3 ? 'dcl_immediateConstantBuffer' : 'customdata', saturate: false,
        testNonZero: false, controls: dataClass, operands: [], offsets: null, resinfoReturn: 0, at });
      pos += size;
      continue;
    }
    const size = (token >>> 24) & 0x7f;
    if (!size) throw new Error(`zero-length instruction at token ${pos}`);
    const r = new TokenReader(tokens, pos + size);
    r.pos = pos + 1;
    let offsets: [number, number, number] | null = null;
    let extended = (token >>> 31) !== 0;
    while (extended) {
      const ext = r.next();
      if ((ext & 0x3f) === 1) {
        const s4 = (v: number) => (v & 8 ? v - 16 : v);
        offsets = [s4((ext >>> 9) & 15), s4((ext >>> 13) & 15), s4((ext >>> 17) & 15)];
      }
      extended = (ext >>> 31) !== 0;
    }
    const controls = (token >>> 11) & 0x1fff;
    const ins: Instruction = {
      opcode, name: OPCODE_NAMES[opcode] ?? `op${opcode}`, saturate: (token & 0x2000) !== 0,
      testNonZero: (token & 0x40000) !== 0, controls, operands: [], offsets,
      resinfoReturn: (token >>> 11) & 3, at,
    };
    if (opcode === OP.DCL_TEMPS) {
      decls.temps = r.next();
    } else if (opcode === OP.DCL_INDEXABLE_TEMP) {
      decls.indexableTemps.push({ register: r.next(), size: r.next(), comps: r.next() });
    } else if (opcode === OP.DCL_GLOBAL_FLAGS) {
      decls.globalFlags = controls;
    } else if (opcode === OP.DCL_MAX_OUTPUT_VERTEX_COUNT || opcode === OP.DCL_GS_INPUT_PRIMITIVE
      || opcode === OP.DCL_GS_OUTPUT_TOPOLOGY) {
      while (r.pos < r.end) r.next();
    } else {
      while (r.pos < r.end) {
        if (opcode === OP.DCL_RESOURCE && ins.operands.length === 1) {
          const rt = r.next();
          decls.resources.push({
            slot: ins.operands[0].indices[0]?.imm ?? 0, dimension: (token >>> 11) & 31,
            returnType: [rt & 15, (rt >>> 4) & 15, (rt >>> 8) & 15, (rt >>> 12) & 15], samples: (token >>> 16) & 0x7f,
          });
          continue;
        }
        if (DCL_WITH_NAME.has(opcode) && ins.operands.length === 1) {
          ins.controls = (ins.controls & 0xffff) | (r.next() << 16);
          continue;
        }
        if (opcode === OP.DCL_INDEX_RANGE && ins.operands.length === 1) {
          r.next();
          continue;
        }
        ins.operands.push(readOperand(r));
      }
    }
    all.push(ins);
    if (opcode >= OP.DCL_RESOURCE && opcode <= OP.DCL_GLOBAL_FLAGS) {
      const o = ins.operands[0];
      const reg = o?.indices[0]?.imm ?? 0;
      const name = ins.controls >>> 16;
      switch (opcode) {
        case OP.DCL_CONSTANT_BUFFER:
          decls.constantBuffers.push({ slot: reg, size: o.indices[1]?.imm ?? 0, dynamic: (controls & 1) === 1 });
          break;
        case OP.DCL_SAMPLER:
          decls.samplers.push({ slot: reg, mode: (token >>> 11) & 15 });
          break;
        case OP.DCL_INPUT:
        case OP.DCL_INPUT_SGV:
        case OP.DCL_INPUT_SIV:
          decls.inputs.push({ register: reg, mask: o.mask, interpolation: 0,
            systemValue: opcode === OP.DCL_INPUT ? 0 : name, opcode });
          break;
        case OP.DCL_INPUT_PS:
        case OP.DCL_INPUT_PS_SGV:
        case OP.DCL_INPUT_PS_SIV:
          decls.inputs.push({ register: o.type === OPERAND.INPUT ? reg : -1, mask: o.mask,
            interpolation: (token >>> 11) & 15, systemValue: opcode === OP.DCL_INPUT_PS ? 0 : name, opcode });
          break;
        case OP.DCL_OUTPUT:
        case OP.DCL_OUTPUT_SGV:
        case OP.DCL_OUTPUT_SIV:
          decls.outputs.push({ register: o.type === OPERAND.OUTPUT ? reg : -1, mask: o.mask,
            systemValue: opcode === OP.DCL_OUTPUT ? 0 : name, depth: o.type === OPERAND.OUTPUT_DEPTH });
          break;
        default:
          break;
      }
    } else {
      instructions.push(ins);
    }
    pos += size;
  }
  return {
    stage, major: (version >>> 4) & 15, minor: version & 15,
    reflection: parseReflection(parts.get('RDEF')),
    inputs: parseSignature(parts.get('ISGN')),
    outputs: parseSignature(parts.get('OSGN')),
    decls, instructions, all,
  };
}

// ---- Disassembly (tests and debugging).

const COMPONENTS = 'xyzw';

function hexWord(v: number): string {
  return '0x' + (v >>> 0).toString(16).padStart(8, '0');
}

/** Float formatting in the assembler's %f style. */
function fixed(bits: number): string {
  const f = new Float32Array(new Uint32Array([bits]).buffer)[0];
  if (Number.isNaN(f)) return 'NaN';
  if (!Number.isFinite(f)) return f > 0 ? 'inf' : '-inf';
  return f.toFixed(6);
}

function registerName(o: Operand, index: (i: OperandIndex) => string): string {
  const i0 = o.indices[0], i1 = o.indices[1];
  switch (o.type) {
    case OPERAND.TEMP: return 'r' + index(i0);
    case OPERAND.INPUT: return o.indices.length > 1 ? `v[${index(i0)}][${index(i1)}]` : 'v' + index(i0);
    case OPERAND.OUTPUT: return 'o' + index(i0);
    case OPERAND.INDEXABLE_TEMP: return `x${index(i0)}[${index(i1)}]`;
    case OPERAND.SAMPLER: return 's' + index(i0);
    case OPERAND.RESOURCE: return 't' + index(i0);
    case OPERAND.CONSTANT_BUFFER: return `cb${index(i0)}[${index(i1)}]`;
    case OPERAND.IMMEDIATE_CONSTANT_BUFFER: return `icb[${index(i0)}]`;
    case OPERAND.LABEL: return 'l' + index(i0);
    case OPERAND.INPUT_PRIMITIVEID: return 'vPrim';
    case OPERAND.OUTPUT_DEPTH: return 'oDepth';
    case OPERAND.NULL: return 'null';
    case OPERAND.RASTERIZER: return 'rasterizer';
    case OPERAND.OUTPUT_COVERAGE_MASK: return 'oMask';
    default: return `?${o.type}`;
  }
}

/** One operand in assembly syntax; `integer` picks the immediate style. */
export function operandText(o: Operand, integer = false): string {
  if (o.type === OPERAND.IMMEDIATE32 && o.values) {
    const parts = [...o.values].map((v) => (integer ? String(v | 0) : fixed(v)));
    return `l(${parts.join(', ')})`;
  }
  const index = (i: OperandIndex): string => {
    if (!i.rel) return String(i.imm);
    const rel = operandText(i.rel, true);
    return i.imm ? `${rel} + ${i.imm}` : `${rel} + 0`;
  };
  let s = registerName(o, index);
  if (o.comps === 4) {
    if (o.sel === 'mask' && o.mask !== 15 && o.mask !== 0) s += '.' + [0, 1, 2, 3].filter((c) => o.mask & (1 << c)).map((c) => COMPONENTS[c]).join('');
    else if (o.sel === 'swizzle') s += '.' + o.swizzle.map((c) => COMPONENTS[c]).join('');
    else if (o.sel === 'select1') s += '.' + COMPONENTS[o.swizzle[0]];
    else if (o.sel === 'mask' && o.mask === 15 && o.type !== OPERAND.RESOURCE && o.type !== OPERAND.SAMPLER) s += '.xyzw';
  }
  if (o.modifier === 1) s = '-' + s;
  else if (o.modifier === 2) s = `|${s}|`;
  else if (o.modifier === 3) s = `-|${s}|`;
  return s;
}

const INTEGER_OPS = new Set<number>([OP.AND, OP.IADD, OP.IEQ, OP.IGE, OP.ILT, OP.IMAD, OP.IMAX, OP.IMIN,
  OP.IMUL, OP.INE, OP.INEG, OP.ISHL, OP.ISHR, OP.ITOF, OP.NOT, OP.OR, OP.UDIV, OP.ULT, OP.UGE, OP.UMUL,
  OP.UMAD, OP.UMAX, OP.UMIN, OP.USHR, OP.UTOF, OP.XOR, OP.LD, OP.LD_MS, OP.SWITCH, OP.CASE]);

/** The instruction mnemonic with its _sat, _z/_nz and offset suffixes. */
export function mnemonic(ins: Instruction): string {
  let m = ins.name;
  if (ins.offsets) m += `_aoffimmi(${ins.offsets[0]},${ins.offsets[1]},${ins.offsets[2]})`;
  if ([OP.IF, OP.BREAKC, OP.CONTINUEC, OP.RETC, OP.DISCARD, OP.CALLC].includes(ins.opcode as any)) m += ins.testNonZero ? '_nz' : '_z';
  if (ins.opcode === OP.RESINFO) m += ['', '_rcpFloat', '_uint'][ins.resinfoReturn] ?? '';
  if (ins.saturate) m += '_sat';
  return m;
}

/** Prints the program in assembly syntax (declarations in a compact form). */
export function disassemble(shader: DxbcShader): string[] {
  const lines: string[] = [];
  for (const ins of shader.all) {
    const op = ins.opcode;
    if (op === OP.CUSTOMDATA) {
      lines.push(ins.controls === 3 ? `dcl_immediateConstantBuffer (${shader.decls.immediateConstantBuffer?.length ?? 0} words)` : 'customdata');
      continue;
    }
    if (op === OP.DCL_TEMPS) { lines.push(`dcl_temps ${shader.decls.temps}`); continue; }
    if (op === OP.DCL_GLOBAL_FLAGS) { lines.push(`dcl_globalFlags ${ins.controls}`); continue; }
    if (op === OP.DCL_RESOURCE) {
      const d = shader.decls.resources.find((x) => x.slot === ins.operands[0].indices[0].imm);
      const rt = d ? d.returnType.map((t) => RETURN_NAMES[t]).join(',') : '';
      lines.push(`dcl_resource_${RESOURCE_DIM_NAMES[d?.dimension ?? 0]} (${rt}) ${operandText(ins.operands[0])}`);
      continue;
    }
    if (op === OP.DCL_CONSTANT_BUFFER) {
      const o = ins.operands[0];
      lines.push(`dcl_constantbuffer CB${o.indices[0].imm}[${o.indices[1]?.imm ?? 0}], ${ins.controls & 1 ? 'dynamicIndexed' : 'immediateIndexed'}`);
      continue;
    }
    if (op === OP.DCL_SAMPLER) {
      lines.push(`dcl_sampler ${operandText(ins.operands[0])}, ${['mode_default', 'mode_comparison', 'mode_mono'][(ins.controls & 15)] ?? 'mode_?'}`);
      continue;
    }
    if (op === OP.DCL_INPUT_PS || op === OP.DCL_INPUT_PS_SIV || op === OP.DCL_INPUT_PS_SGV) {
      const interp = INTERPOLATION_NAMES[ins.controls & 15] ?? '';
      const nm = op === OP.DCL_INPUT_PS ? '' : `, ${systemValueName(ins.controls >>> 16)}`;
      lines.push(`${ins.name} ${op === OP.DCL_INPUT_PS_SGV && !interp ? '' : interp + ' '}${operandText(ins.operands[0])}${nm}`.replace('  ', ' '));
      continue;
    }
    if (DCL_WITH_NAME.has(op)) {
      lines.push(`${ins.name} ${operandText(ins.operands[0])}, ${systemValueName(ins.controls >>> 16)}`);
      continue;
    }
    if (op === OP.DCL_INDEXABLE_TEMP) continue;
    const integer = INTEGER_OPS.has(op);
    const ops = ins.operands.map((o, k) => {
      // ld/ld_ms addresses and resinfo mips are integers; sample offsets are floats.
      const intOperand = integer || (op === OP.RESINFO && k === 1);
      return operandText(o, intOperand);
    });
    lines.push(ops.length ? `${mnemonic(ins)} ${ops.join(', ')}` : mnemonic(ins));
  }
  return lines;
}

export function systemValueName(name: number): string {
  return ['undefined', 'position', 'clip_distance', 'cull_distance', 'rendertarget_array_index',
    'viewport_array_index', 'vertex_id', 'primitive_id', 'instance_id', 'is_front_face', 'sampleIndex'][name] ?? `sv${name}`;
}

export { hexWord };
