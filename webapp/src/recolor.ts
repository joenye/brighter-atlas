// Recovered material recolours shared by World3D, built-in Model rendering,
// scene instances, and portable GLTF previews.
//
// The native material family consumes two packed R/G masks plus two authored
// tints.  A third stored colour is separate half-range output modulation;
// five-field records retain only the first two and therefore use the native
// neutral modulation value (0.5).  Keep that distinction in data while giving
// every renderer one faithful implementation of the recovered shader formula.

import * as THREE from '../vendor/three.module.js';

const RECOLOR_SHADER_VERSION = 'native-two-mask-v3';

// a recolor input: either a raw stored tuple or a partRecolor() state
export interface PartRecolorState {
  field: string;
  values: number[][];
  schema: any;
  complete: boolean;
}

export interface RecolorState {
  applied: boolean;
  version: string;
  mode: string;
  stored: number[][];
  implicitNeutralModulation: boolean;
  compactUniformTintModulation: boolean;
  shaderInputs: number[][];
  fallback: string | null;
  sourceField?: string;
  compiled?: boolean;
}

function normalizeRecolors(value: any): number[][] | null {
  if (!Array.isArray(value) || ![2, 3].includes(value.length)) return null;
  if (value.some((color) => !Array.isArray(color) || color.length < 3
      || color.some((component: any) => !Number.isFinite(Number(component))))) return null;
  return value.map((color) => color.map(Number));
}

// System-model parts distinguish a complete three-colour value from a
// two-colour observed prefix.  User Models have neither field and remain
// untouched by this projection.
export function partRecolor(part: any): PartRecolorState | null {
  for (const field of ['recolors', 'recolors_observed']) {
    if (!Object.hasOwn(part || {}, field)) continue;
    const values = normalizeRecolors(part[field]);
    if (!values) return null;
    const schema = part?.recolor_schema;
    return { field, values, schema, complete: field === 'recolors' };
  }
  return null;
}

export function copyPartRecolor(part: any): Record<string, any> {
  const state = partRecolor(part);
  if (!state) return {};
  return {
    [state.field]: state.values.map((color) => [...color]),
    ...(state.schema ? { recolor_schema: state.schema } : {}),
  };
}

function recolorValues(input: any): number[][] | null {
  return normalizeRecolors(Array.isArray(input?.values) ? input.values : input);
}

// A tint carries no authored colour when it is one of the two native neutral
// sentinels: pure white (native x1) OR the half-range grey 127/255 (~0.498).
// Both are ubiquitous in the corpus (census over the real bundles: ~50k white
// and ~37k grey-127 tint channels) and both mean the same thing — leave the
// masked region as the albedo.
const NEUTRAL_TINT_HALF = 127 / 255;
const isNeutralTint = (color: number[]) => {
  const rgb = color.slice(0, 3);
  return rgb.every((component) => component >= 0.999)
    || rgb.every((component) => Math.abs(component - NEUTRAL_TINT_HALF) < 1.5 / 255);
};

// True when every authored TINT is a neutral sentinel (white or grey-127). The
// recovered two-mask formula colorizes a masked pixel from its luminance, so no
// tint value can preserve the albedo's own hue — but in-game, neutral-tinted
// masks demonstrably keep their authored colours: the gold Cave of the Future
// fortune table carries white/white tints over its gold trim, and the pink
// staff crystals (Troll Mystic "Sparkling", Scaramdar) carry grey-127/grey-127
// tints over a mask covering the pink gem. A neutral tint therefore means "no
// recolour" and the mask mix must not run (it would desaturate the authored hue
// to grey — the crystals washed to white); colored tints keep the recovered
// behaviour.
export function isIdentityRecolor(input: any): boolean {
  const recolors = recolorValues(input);
  if (!recolors) return false;
  const compactUniform = input?.schema === 'uniform_tint_modulation';
  const tints = recolors.length === 3 ? recolors.slice(0, 2)
    : compactUniform ? recolors.slice(0, 1) : recolors;
  return tints.every(isNeutralTint);
}

interface MaterialStateOpts {
  applied: boolean;
  mode: string;
  fallback?: string | null;
  uniformTintModulation?: boolean;
}

function materialState(recolors: number[][], {
  applied, mode, fallback = null, uniformTintModulation = false,
}: MaterialStateOpts) {
  const compactUniform = uniformTintModulation && recolors.length === 2;
  const hasOverallModulation = recolors.length === 3 || compactUniform;
  const overallHalf = recolors.length === 3
    ? new THREE.Vector3(...recolors[2].slice(0, 3))
    : compactUniform
      ? new THREE.Vector3(...recolors[1].slice(0, 3))
      : new THREE.Vector3(0.5, 0.5, 0.5);
  const tint1 = new THREE.Vector3(...recolors[0].slice(0, 3));
  const tint2 = compactUniform
    ? tint1.clone()
    : new THREE.Vector3(...recolors[1].slice(0, 3));
  const state: RecolorState = {
    applied, version: RECOLOR_SHADER_VERSION, mode,
    stored: recolors.map((color) => [...color]),
    implicitNeutralModulation: !hasOverallModulation,
    compactUniformTintModulation: compactUniform,
    // Native shader input order is modulation, tint 1, tint 2. The stored
    // modulation is half-range, hence the explicit factor of two.
    shaderInputs: [overallHalf.clone().multiplyScalar(2), tint1, tint2]
      .map((color) => color.toArray()),
    fallback,
  };
  return { state, tint1, tint2, overallHalf };
}

// Shared 1x1 black stand-in mask for uniform-luminance-tint materials whose
// texture ships no packed plane (mask samples are ignored in that mode, but
// the sampler must be bound). Module-owned; never disposed per material.
let _blackParameterMap: THREE.DataTexture | null = null;
function blackParameterMap(): THREE.DataTexture {
  if (!_blackParameterMap) {
    _blackParameterMap = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat,
    );
    _blackParameterMap.needsUpdate = true;
  }
  return _blackParameterMap;
}

export function applyPackedRecolor(material: THREE.Material, parameterMap: THREE.Texture | null, input: any, {
  fullTint = false, uniformTintModulation = false,
}: { fullTint?: boolean; uniformTintModulation?: boolean } = {}): RecolorState {
  const mat = material as any;
  const compactUniform = input?.schema === 'uniform_tint_modulation';
  fullTint ||= compactUniform;
  uniformTintModulation ||= compactUniform;
  const recolors = recolorValues(input);
  if (!recolors) throw new Error('invalid recolor tuple');
  // White tints are the native identity: keep the albedo untouched (the
  // uniform-luminance-tint mode is extraction-guarded to grayscale albedos
  // and stays live). The parameter map still attaches for lifecycle so the
  // caller's disposal contract holds.
  if (!fullTint && isIdentityRecolor(input)) {
    const { state } = materialState(recolors, {
      applied: false,
      mode: 'two-mask',
      fallback: 'identity-neutral-tints',
      uniformTintModulation,
    });
    if (input?.field) state.sourceField = input.field;
    material.userData.exactRecolor = state;
    if (parameterMap) mat.brighterParameterMap = parameterMap;
    return state;
  }
  // The uniform-luminance-tint mode never reads the packed masks, so a
  // texture without a parameter plane still recolours (grey rock/sand whose
  // only colour input is the authored tint); the shader just needs SOME
  // bound sampler. Two-mask without masks stays a no-op fallback.
  const effectiveMap = parameterMap || (fullTint ? blackParameterMap() : null);
  const { state, tint1, tint2, overallHalf } = materialState(recolors, {
    applied: !!effectiveMap,
    mode: fullTint ? 'uniform-luminance-tint' : 'two-mask',
    fallback: effectiveMap ? null : 'base-albedo-no-packed-parameter-map',
    uniformTintModulation,
  });
  if (input?.field) state.sourceField = input.field;
  material.userData.exactRecolor = state;
  if (!effectiveMap) return state;

  // Keep the packed texture reachable for resource disposal without putting a
  // Texture object in userData (which glTF serializes as JSON extras). The
  // shared black stand-in is module-owned and never disposed with a material.
  if (parameterMap) mat.brighterParameterMap = parameterMap;
  mat.brighterRecolorEnabled = { value: 1 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.brighterParameterMap = { value: effectiveMap };
    shader.uniforms.brighterTint1 = { value: tint1 };
    shader.uniforms.brighterTint2 = { value: tint2 };
    shader.uniforms.brighterOverallHalf = { value: overallHalf };
    shader.uniforms.brighterFullTint = { value: fullTint ? 1 : 0 };
    shader.uniforms.brighterRecolorEnabled = mat.brighterRecolorEnabled;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_pars_fragment>',
      `#include <map_pars_fragment>
uniform sampler2D brighterParameterMap;
uniform vec3 brighterTint1;
uniform vec3 brighterTint2;
uniform vec3 brighterOverallHalf;
uniform float brighterFullTint;
uniform float brighterRecolorEnabled;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  #ifdef DECODE_VIDEO_TEXTURE
    sampledDiffuseColor = vec4( mix( pow( sampledDiffuseColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), sampledDiffuseColor.rgb * 0.0773993808, vec3( lessThanEqual( sampledDiffuseColor.rgb, vec3( 0.04045 ) ) ) ), sampledDiffuseColor.w );
  #endif
  vec2 brighterMasks = texture2D( brighterParameterMap, vMapUv ).rg;
  vec3 brighterEncoded = pow( max( sampledDiffuseColor.rgb, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );
  float brighterQ = ( brighterEncoded.r + brighterEncoded.g + brighterEncoded.b ) * ( 2.0 / 3.0 );
  float brighterHi = max( brighterQ - 1.0, 0.0 );
  float brighterMid = min( brighterQ, 1.0 ) - brighterHi;
  vec3 brighterTarget1 = vec3( brighterHi ) + brighterMid * brighterTint1;
  vec3 brighterTarget2 = vec3( brighterHi ) + brighterMid * brighterTint2;
  vec3 brighterMasked = brighterEncoded * max( 0.0, 1.0 - brighterMasks.r - brighterMasks.g )
    + brighterTarget1 * brighterMasks.r + brighterTarget2 * brighterMasks.g;
  float brighterLuminance = ( brighterEncoded.r + brighterEncoded.g + brighterEncoded.b ) / 3.0;
  vec3 brighterUniform = brighterLuminance * brighterTint1;
  vec3 brighterMixed = mix( brighterMasked, brighterUniform, brighterFullTint );
  vec3 brighterOutput = mix( brighterEncoded, brighterMixed, brighterRecolorEnabled );
  sampledDiffuseColor.rgb = pow( max( brighterOutput, vec3( 0.0 ) ), vec3( 2.2 ) );
  diffuseColor *= sampledDiffuseColor;
#endif`,
    );
    // The native c3 value is output modulation, not part of the mask mix.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <colorspace_fragment>',
      `#include <colorspace_fragment>
gl_FragColor.rgb *= mix( vec3( 1.0 ), clamp( 2.0 * brighterOverallHalf, vec3( 0.0 ), vec3( 2.0 ) ), brighterRecolorEnabled );`,
    );
    state.compiled = true;
  };
  material.customProgramCacheKey = () => `${RECOLOR_SHADER_VERSION}:${fullTint ? 'full' : 'masks'}`;
  material.needsUpdate = true;
  return state;
}

export function clearPackedRecolor(material: THREE.Material | null): THREE.Texture | null {
  if (!material) return null;
  const mat = material as any;
  const packed = mat.brighterParameterMap || null;
  delete mat.brighterParameterMap;
  delete mat.brighterRecolorEnabled;
  if (material.userData) delete material.userData.exactRecolor;
  material.onBeforeCompile = THREE.Material.prototype.onBeforeCompile;
  material.customProgramCacheKey = THREE.Material.prototype.customProgramCacheKey;
  material.needsUpdate = true;
  return packed;
}

// A uniform-only switch used by deterministic visual QA (and useful to future
// comparison tools). It never recompiles the material or changes scene/camera
// state, so before/after pixels share one renderer frame contract.
export function setPackedRecolorEnabled(material: THREE.Material | null, enabled: boolean): boolean {
  const mat = material as any;
  if (!mat?.brighterRecolorEnabled) return false;
  mat.brighterRecolorEnabled.value = enabled ? 1 : 0;
  return true;
}

// Core glTF PBR has no equivalent of the packed two-mask material.  Use tint 0
// as a conservative baseColorFactor and retain the complete ordered tuple in
// material extras for custom importers.
export function applyRecolorPreview(material: THREE.MeshStandardMaterial, input: any): RecolorState | null {
  const recolors = recolorValues(input);
  if (!recolors) return null;
  const { state } = materialState(recolors, {
    applied: false,
    mode: 'portable-pbr-preview',
    fallback: 'baseColorFactor-uses-recolors[0]',
    uniformTintModulation: input?.schema === 'uniform_tint_modulation',
  });
  if (input?.field) state.sourceField = input.field;
  material.color.setRGB(
    THREE.MathUtils.clamp(recolors[0][0], 0, 1),
    THREE.MathUtils.clamp(recolors[0][1], 0, 1),
    THREE.MathUtils.clamp(recolors[0][2], 0, 1),
  );
  material.userData.exactRecolor = state;
  return state;
}
