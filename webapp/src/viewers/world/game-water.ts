// Water as the game draws it. A water tile is an ordinary block: its top face
// is the moving surface and its exposed sides are the shoreline curtains.
// Their materials name a water style (colour, ripple normal map, reflected
// sky, two scrolling ripple layers and two travelling sine waves), which the
// world index carries per build (see extract/world/water-materials.ts).
//
// Surface: every vertex sinks by the two sine waves (plus the style's level
// offset), the same waves tilt its normal, and two scrolled samples of the
// ripple map perturb it per pixel. The colour is the reflected sky mixed
// toward the style colour by the style's alpha, lit by the scene's sky,
// ground and sun, encoded with a 2.2 power, then tinted per vertex by the
// part's own colour. Curtain: tops at or above the water level follow the
// same waves, and the banded texture's rows follow the moving height.
//
// Heights and positions are native units (z up); wave rates are per tick.
import * as THREE from '../../../vendor/three.module.js';
import type { WorldWaterStyle, WorldWaterMaterial } from '../../extract/world/water-materials.js';

const TWO_PI = Math.PI * 2;
const f32 = Math.fround;

/** Uniforms shared by every water material of one view. */
export interface GameWaterShared {
  uNativeFromWorld: { value: THREE.Matrix4 };
  uWorldFromNative: { value: THREE.Matrix4 };
  uCamera: { value: THREE.Vector3 };        // native
  uSky: { value: THREE.Color };
  uGround: { value: THREE.Color };
  uSun: { value: THREE.Color };
  uSunDirection: { value: THREE.Vector3 };   // native, the way the light travels
  uLevel: { value: THREE.Vector2 };          // water level in x; the per-style offset is uStyleLevel
}

export function createGameWaterShared(): GameWaterShared {
  return {
    uNativeFromWorld: { value: new THREE.Matrix4() },
    uWorldFromNative: { value: new THREE.Matrix4() },
    uCamera: { value: new THREE.Vector3() },
    uSky: { value: new THREE.Color(0.6, 0.65, 0.7) },
    uGround: { value: new THREE.Color(0.2, 0.2, 0.18) },
    uSun: { value: new THREE.Color(0.8, 0.78, 0.7) },
    uSunDirection: { value: new THREE.Vector3(-0.3, -0.4, -0.85).normalize() },
    uLevel: { value: new THREE.Vector2(1024, 0) },
  };
}

/** Per-style animated uniforms (texture layers and wave phases). */
export interface GameWaterStyleUniforms {
  uLayer0: { value: THREE.Vector4 };   // scale xy, offset zw
  uLayer1: { value: THREE.Vector4 };
  uWaveX: { value: THREE.Vector4 };    // amplitude, frequency, phase, tilt
  uWaveY: { value: THREE.Vector4 };
  uStyleColour: { value: THREE.Vector4 };
  uStyleLevel: { value: number };
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** A style colour as the game packs it: RGB converted to linear, alpha raw, each truncated to a byte after scaling. */
export function styleColourBytes([r, g, b, a]: readonly number[]): [number, number, number, number] {
  const byte = (v: number) => Math.min(255, Math.max(0, Math.floor(f32(f32(v) * 255))));
  return [byte(srgbToLinear(r)), byte(srgbToLinear(g)), byte(srgbToLinear(b)), byte(a)];
}
const positiveMod = (v: number, m: number) => { const r = v % m; return r < 0 ? r + m : r; };

export function createStyleUniforms(style: WorldWaterStyle): GameWaterStyleUniforms {
  const [r, g, b, a] = styleColourBytes(style.colour);
  return {
    uLayer0: { value: new THREE.Vector4(style.layers[0][0], style.layers[0][1], 0, 0) },
    uLayer1: { value: new THREE.Vector4(style.layers[1][0], style.layers[1][1], 0, 0) },
    uWaveX: { value: new THREE.Vector4(style.waves.amplitude[0], style.waves.frequency[0], 0, style.waves.tilt[0]) },
    uWaveY: { value: new THREE.Vector4(style.waves.amplitude[1], style.waves.frequency[1], 0, style.waves.tilt[1]) },
    uStyleColour: { value: new THREE.Vector4(r / 255, g / 255, b / 255, a / 255) },
    uStyleLevel: { value: style.level },
  };
}

/** Advance one style to `ticks`: layer offsets scroll, wave phases travel.
 *  Offsets wrap by whole repeats and phases by whole turns, which leaves the
 *  sampled pattern unchanged while keeping float precision. */
export function updateStyleUniforms(u: GameWaterStyleUniforms, style: WorldWaterStyle, ticks: number): void {
  for (const [k, layer] of [[0, style.layers[0]], [1, style.layers[1]]] as const) {
    const target = k === 0 ? u.uLayer0.value : u.uLayer1.value;
    target.z = positiveMod(layer[2] * ticks, 1);
    target.w = positiveMod(layer[3] * ticks, 1);
  }
  u.uWaveX.value.z = positiveMod(style.waves.rate[0] * ticks, TWO_PI);
  u.uWaveY.value.z = positiveMod(style.waves.rate[1] * ticks, TWO_PI);
}

const COMMON = /* glsl */`
uniform mat4 uNativeFromWorld;
uniform mat4 uWorldFromNative;
uniform vec4 uWaveX;
uniform vec4 uWaveY;
uniform vec2 uLevel;
uniform float uStyleLevel;
uniform vec3 uTint;
uniform float uOpacity;
uniform float uTileUnits;

// The part's colour as the game bakes it into the vertex: packed at half
// scale (truncated), restored by the vertex shader. Block faces carry their
// ground's colour only; the room's tile colours tint none of them.
vec4 waterTint(vec3 p) {
  vec3 packed = floor(uTint * 0.5 * 255.0) / 255.0;
  return vec4(packed * 2.0, floor(uOpacity * 255.0) / 255.0);
}

vec3 nativePosition(mat4 local, vec3 position) {
  return (uNativeFromWorld * local * vec4(position, 1.0)).xyz;
}
`;

const LIGHTING = /* glsl */`
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uSun;
uniform vec3 uSunDirection;
// Hemisphere by the normal's height, brightened toward +x, plus the sun.
vec3 waterLight(vec3 n) {
  vec3 hemi = mix(uGround, uSky, n.z * 0.5 + 0.5);
  return hemi * (n.x * 0.5 + 1.0) + uSun * max(dot(n, -uSunDirection), 0.0);
}
`;

const SURFACE_VERTEX = /* glsl */`
${COMMON}
uniform vec4 uLayer0;
uniform vec4 uLayer1;
varying vec3 vTangent;
varying vec3 vBitangent;
varying vec3 vNormal;
varying vec4 vLayers;
varying vec3 vNative;
varying vec4 vTint;
void main() {
  mat4 local = modelMatrix;
  #ifdef USE_INSTANCING
    local = modelMatrix * instanceMatrix;
  #endif
  vec3 p = nativePosition(local, position);
  vec3 n = normalize(mat3(uNativeFromWorld * local) * normal);
  float px = p.x * uWaveX.y + uWaveX.z;
  float py = p.y * uWaveY.y + uWaveY.z;
  float height = uWaveX.x * sin(px) + uWaveY.x * sin(py) + uStyleLevel;
  float slope = uWaveX.w * cos(px) + uWaveY.w * cos(py);
  vec3 moved = vec3(p.xy, p.z + height);
  vec3 tilted = normalize(n + vec3(slope));
  vec3 axis = abs(tilted.x) > 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(axis - dot(axis.xy, tilted.xy) * tilted);
  vTangent = tangent;
  vBitangent = cross(tangent, tilted);
  vNormal = tilted;
  vLayers = vec4(p.xy * uLayer0.xy + uLayer0.zw, p.xy * uLayer1.xy + uLayer1.zw);
  vNative = moved;
  vTint = waterTint(p);
  gl_Position = projectionMatrix * viewMatrix * uWorldFromNative * vec4(moved, 1.0);
}`;

const SURFACE_FRAGMENT = /* glsl */`
uniform sampler2D uRipples;
uniform samplerCube uSkyCube;
uniform vec3 uCamera;
uniform vec4 uStyleColour;
${LIGHTING}
varying vec3 vTangent;
varying vec3 vBitangent;
varying vec3 vNormal;
varying vec4 vLayers;
varying vec3 vNative;
varying vec4 vTint;
void main() {
  vec2 ripple = (texture2D(uRipples, vLayers.xy).rg + texture2D(uRipples, vLayers.zw).rg) * 0.5;
  float up = sqrt(max(1.0 - ripple.x * ripple.x - ripple.y * ripple.y, 0.0));
  vec3 n = normalize(vTangent * ripple.x + vBitangent * ripple.y + vNormal * up);
  vec3 view = normalize(uCamera - vNative);
  vec3 sky = textureCube(uSkyCube, reflect(-view, n)).rgb;
  vec3 colour = mix(sky, uStyleColour.rgb, uStyleColour.a);
  vec3 lit = pow(max(colour * waterLight(n), vec3(0.0)), vec3(1.0 / 2.2));
  gl_FragColor = vec4(lit * vTint.rgb, vTint.a);
}`;

const CURTAIN_VERTEX = /* glsl */`
${COMMON}
uniform vec2 uWindow;
varying vec3 vNormal;
varying vec2 vUv;
varying vec4 vTint;
void main() {
  mat4 local = modelMatrix;
  #ifdef USE_INSTANCING
    local = modelMatrix * instanceMatrix;
  #endif
  vec3 p = nativePosition(local, position);
  vNormal = normalize(mat3(uNativeFromWorld * local) * normal);
  float waves = uWaveX.x + uWaveY.x + uStyleLevel;
  float span = waves + uLevel.x;
  float height = uWaveX.x * sin(p.x * uWaveX.y + uWaveX.z) + uWaveY.x * sin(p.y * uWaveY.y + uWaveY.z) + uStyleLevel;
  float z = p.z + (p.z >= uLevel.x ? height : 0.0);
  float row = (waves * 0.75 + uLevel.x + height * 0.25 - z) / span;
  vUv = vec2(uv.x, uWindow.x + row * (uWindow.y - uWindow.x));
  vTint = waterTint(p);
  gl_Position = projectionMatrix * viewMatrix * uWorldFromNative * vec4(p.xy, z, 1.0);
}`;

const CURTAIN_FRAGMENT = /* glsl */`
uniform sampler2D uBands;
${LIGHTING}
varying vec3 vNormal;
varying vec2 vUv;
varying vec4 vTint;
void main() {
  vec3 n = normalize(vNormal);
  vec3 lit = pow(max(texture2D(uBands, vUv).rgb * waterLight(n), vec3(0.0)), vec3(1.0 / 2.2));
  gl_FragColor = vec4(lit * vTint.rgb, vTint.a);
}`;

/** Source-over blending with depth writes and a strict depth test. */
function waterBlend(material: THREE.ShaderMaterial): THREE.ShaderMaterial {
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  material.depthWrite = true;
  material.depthTest = true;
  material.depthFunc = THREE.LessDepth;
  material.side = THREE.FrontSide;
  return material;
}

export interface GameWaterTextures {
  ripples: THREE.Texture;
  sky: THREE.CubeTexture;
  bands?: THREE.Texture | null;
}

export function createGameWaterMaterial(
  info: WorldWaterMaterial, style: GameWaterStyleUniforms, shared: GameWaterShared,
  tint: number[] | null, textures: GameWaterTextures, tileUnits: number,
): THREE.ShaderMaterial {
  const uniforms: Record<string, any> = {
    ...shared, ...style,
    uTint: { value: new THREE.Vector3(tint?.[0] ?? 1, tint?.[1] ?? 1, tint?.[2] ?? 1) },
    uOpacity: { value: info.opacity },
    uTileUnits: { value: tileUnits },
  };
  if (info.kind === 'surface') {
    uniforms.uRipples = { value: textures.ripples };
    uniforms.uSkyCube = { value: textures.sky };
    return waterBlend(new THREE.ShaderMaterial({
      name: 'game-water-surface', uniforms,
      vertexShader: SURFACE_VERTEX, fragmentShader: SURFACE_FRAGMENT,
    }));
  }
  uniforms.uBands = { value: textures.bands ?? null };
  uniforms.uWindow = { value: new THREE.Vector2(info.window[0], info.window[1]) };
  return waterBlend(new THREE.ShaderMaterial({
    name: 'game-water-curtain', uniforms,
    vertexShader: CURTAIN_VERTEX, fragmentShader: CURTAIN_FRAGMENT,
  }));
}

/** A neutral part colour (one half) as the game packs it at half scale and
 *  restores it: the vertex colour that leaves a surface unchanged. */
export const NEUTRAL_TINT = (2 * 63) / 255;

/** Mirror the view's lights into the shared uniforms, in native space. The
 *  view's lights are calibrated for surfaces with a neutral vertex colour; the
 *  game's lights are brighter by the inverse tint raised to its 2.2 encoding
 *  power, so the water's own arithmetic stays unchanged. The 1/pi matches
 *  the energy the standard materials give the same lights. */
export function updateGameWaterLights(
  shared: GameWaterShared, hemisphere: THREE.HemisphereLight, sun: THREE.DirectionalLight,
  camera: THREE.Camera, nativeFromWorld: THREE.Matrix4,
): void {
  const k = Math.pow(1 / NEUTRAL_TINT, 2.2) / Math.PI;
  shared.uSky.value.copy(hemisphere.color).multiplyScalar(hemisphere.intensity * k);
  shared.uGround.value.copy(hemisphere.groundColor).multiplyScalar(hemisphere.intensity * k);
  shared.uSun.value.copy(sun.color).multiplyScalar(sun.intensity * k);
  const toSun = new THREE.Vector3().copy(sun.position).sub(sun.target.position);
  shared.uSunDirection.value.copy(toSun).transformDirection(nativeFromWorld).negate();
  shared.uCamera.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(nativeFromWorld);
}
