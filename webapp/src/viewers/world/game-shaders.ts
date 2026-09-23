// The game's own programs, read from the user's shader bundles through the
// service worker and translated to GLSL (dxbc-glsl.ts): one material template
// per (program, y convention), carrying the program's depth, blend and cull
// state. Constant buffers are raw words (upload the buffer bytes); textures
// bind per source slot with the program's sampler state.
import { THREE } from '../three-common.js';
import { translate, type TranslatedProgram, type YConvention, type SamplerBinding } from './dxbc-glsl.js';

/** The world index's render tables (see extract/world/render-data.ts). */
export interface GameRenderTables {
  programs: number[][];
  vertexShaders: number[][];
  pixelShaders: number[][];
  samplers: number[][];
  blends: number[][];
}

// D3D11 enums
const COMPARE: Record<number, THREE.DepthModes> = {
  1: THREE.NeverDepth, 2: THREE.LessDepth, 3: THREE.EqualDepth, 4: THREE.LessEqualDepth,
  5: THREE.GreaterDepth, 6: THREE.NotEqualDepth, 7: THREE.GreaterEqualDepth, 8: THREE.AlwaysDepth,
};
const TEXTURE_COMPARE: Record<number, THREE.TextureComparisonFunction> = {
  1: THREE.NeverCompare, 2: THREE.LessCompare, 3: THREE.EqualCompare, 4: THREE.LessEqualCompare,
  5: THREE.GreaterCompare, 6: THREE.NotEqualCompare, 7: THREE.GreaterEqualCompare, 8: THREE.AlwaysCompare,
};
const BLEND_FACTOR: Record<number, number> = {
  1: THREE.ZeroFactor, 2: THREE.OneFactor, 3: THREE.SrcColorFactor, 4: THREE.OneMinusSrcColorFactor,
  5: THREE.SrcAlphaFactor, 6: THREE.OneMinusSrcAlphaFactor, 7: THREE.DstAlphaFactor, 8: THREE.OneMinusDstAlphaFactor,
  9: THREE.DstColorFactor, 10: THREE.OneMinusDstColorFactor, 11: THREE.SrcAlphaSaturateFactor,
};
const BLEND_OP: Record<number, THREE.BlendingEquation> = {
  1: THREE.AddEquation, 2: THREE.SubtractEquation, 3: THREE.ReverseSubtractEquation, 4: THREE.MinEquation, 5: THREE.MaxEquation,
};
const ADDRESS: Record<number, THREE.Wrapping> = {
  1: THREE.RepeatWrapping, 2: THREE.MirroredRepeatWrapping, 3: THREE.ClampToEdgeWrapping,
};

/** A D3D11 sampler description applied to a texture (filters, addressing, comparison). */
export function applySampler(texture: THREE.Texture, desc: number[] | null, hasMips: boolean): void {
  if (!desc) {
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    return;
  }
  const [filter, u, v, , compare] = desc;
  const base = filter & 0x7f;   // comparison filters add 0x80
  const minLinear = !!(base & 0x10), magLinear = !!(base & 0x04), mipLinear = !!(base & 0x01);
  texture.magFilter = magLinear ? THREE.LinearFilter : THREE.NearestFilter;
  texture.minFilter = !hasMips ? (minLinear ? THREE.LinearFilter : THREE.NearestFilter)
    : minLinear ? (mipLinear ? THREE.LinearMipmapLinearFilter : THREE.LinearMipmapNearestFilter)
    : (mipLinear ? THREE.NearestMipmapLinearFilter : THREE.NearestMipmapNearestFilter);
  texture.wrapS = ADDRESS[u] ?? THREE.ClampToEdgeWrapping;
  texture.wrapT = ADDRESS[v] ?? THREE.ClampToEdgeWrapping;
  if (filter & 0x80 && (texture as any).isDepthTexture) {
    (texture as THREE.DepthTexture).compareFunction = TEXTURE_COMPARE[compare] ?? THREE.LessEqualCompare;
  }
  texture.needsUpdate = true;
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
  /** A fresh material for this program (its own uniform values). */
  material(): THREE.RawShaderMaterial;
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
    const [vertex, pixel, depthCompare, depthWrite, blendIndex, cull] = row;
    const [vs, ps] = await Promise.all([this.blob('vs', vertex), this.blob('ps', pixel)]);
    const translated = translate(vs, ps, { y, depth: this.zeroToOne ? 'zeroToOne' : 'negativeOneToOne' });
    const samplers = (this.tables.pixelShaders[pixel] ?? []).map((s) => (s >= 0 ? this.tables.samplers[s] : null));
    const blend = blendIndex >= 0 ? this.tables.blends[blendIndex] : null;
    const template = new THREE.RawShaderMaterial({
      vertexShader: translated.vertex,
      fragmentShader: translated.fragment,
      uniforms: {},
      depthTest: depthCompare !== 0,
      depthWrite: depthCompare !== 0 && depthWrite === 1,
      depthFunc: COMPARE[depthCompare] ?? THREE.LessDepth,
    });
    if (blend) {
      template.transparent = true;
      template.blending = THREE.CustomBlending;
      template.blendEquation = BLEND_OP[blend[0]];
      template.blendSrc = BLEND_FACTOR[blend[1]] as THREE.BlendingSrcFactor;
      template.blendDst = BLEND_FACTOR[blend[2]] as THREE.BlendingDstFactor;
      template.blendEquationAlpha = BLEND_OP[blend[3]];
      template.blendSrcAlpha = BLEND_FACTOR[blend[4]] as THREE.BlendingSrcFactor;
      template.blendDstAlpha = BLEND_FACTOR[blend[5]] as THREE.BlendingDstFactor;
    } else {
      template.blending = THREE.NoBlending;
    }
    // Every 3D program shares one rasteriser (fronts clockwise on the target,
    // CULL_FRONT): in GL terms back faces go. The clip convention mirrors y.
    template.side = cull === 0 ? (y === 'fragcoord' ? THREE.FrontSide : THREE.BackSide)
      : cull === 1 ? (y === 'fragcoord' ? THREE.BackSide : THREE.FrontSide) : THREE.DoubleSide;
    const uniforms: Record<string, THREE.IUniform> = {};
    for (const cb of [...translated.constantBuffers.vs, ...translated.constantBuffers.ps]) {
      uniforms[cb.uniform] = { value: new Uint32Array(cb.sizeVec4 * 4) };
    }
    for (const s of translated.samplers) {
      uniforms[s.uniform] = { value: null };
      if (s.widthUniform) uniforms[s.widthUniform] = { value: 1 };
    }
    if (translated.targetHeightUniform) uniforms[translated.targetHeightUniform] = { value: 1 };
    template.uniforms = uniforms;
    return {
      index, vertex, pixel, y, translated,
      elements: this.tables.vertexShaders[vertex] ?? [],
      samplers,
      material: () => {
        const m = template.clone();
        m.uniforms = THREE.UniformsUtils.clone(uniforms);
        // UniformsUtils.clone copies typed arrays; keep them as Uint32Array.
        for (const cb of [...translated.constantBuffers.vs, ...translated.constantBuffers.ps]) {
          m.uniforms[cb.uniform].value = new Uint32Array(cb.sizeVec4 * 4);
        }
        return m;
      },
    };
  }
}

/** The pixel shader binding (by source texture slot) a sampler uniform reads. */
export function samplerSlots(program: GameProgram): Map<number, SamplerBinding[]> {
  const out = new Map<number, SamplerBinding[]>();
  for (const s of program.translated.samplers) {
    if (s.stage !== 'ps') continue;
    if (!out.has(s.texture)) out.set(s.texture, []);
    out.get(s.texture)!.push(s);
  }
  return out;
}

/** Write float values into a constant buffer's words at a byte offset. */
export function putFloats(words: Uint32Array, byteOffset: number, values: ArrayLike<number>): void {
  const f = new Float32Array(words.buffer, words.byteOffset, words.length);
  const at = byteOffset >> 2;
  // A shader declares only the registers it reads: drop values past its buffer.
  for (let k = 0; k < values.length && at + k < f.length; k++) f[at + k] = values[k];
}
