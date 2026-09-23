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
// room's tile colours. Curtain: tops at or above the water level follow the
// same waves, and the banded texture's rows follow the moving height.
//
// Heights and positions are native units (z up); wave rates are per tick.
import * as THREE from '../../../vendor/three.module.js';
import type { WorldWater, WorldWaterStyle, WorldWaterMaterial } from '../../extract/world/water-materials.js';

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
  uLevel: { value: THREE.Vector2 };          // water level, style offset set per style
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
// Packed colours truncate after scaling to 255.
const unorm8 = (v: number) => Math.min(255, Math.max(0, Math.floor(f32(f32(v) * 255)))) / 255;
const positiveMod = (v: number, m: number) => { const r = v % m; return r < 0 ? r + m : r; };

export function createStyleUniforms(style: WorldWaterStyle): GameWaterStyleUniforms {
  const [r, g, b, a] = style.colour;
  return {
    uLayer0: { value: new THREE.Vector4(style.layers[0][0], style.layers[0][1], 0, 0) },
    uLayer1: { value: new THREE.Vector4(style.layers[1][0], style.layers[1][1], 0, 0) },
    uWaveX: { value: new THREE.Vector4(style.waves.amplitude[0], style.waves.frequency[0], 0, style.waves.tilt[0]) },
    uWaveY: { value: new THREE.Vector4(style.waves.amplitude[1], style.waves.frequency[1], 0, style.waves.tilt[1]) },
    // The style colour is converted to linear before packing; alpha is not.
    uStyleColour: { value: new THREE.Vector4(unorm8(srgbToLinear(r)), unorm8(srgbToLinear(g)), unorm8(srgbToLinear(b)), unorm8(a)) },
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

/** The room's tile colours as a float texture plus the mapping from native
 *  room-local position to grid texels (tile centres). */
export interface GameWaterGrid {
  texture: THREE.DataTexture;
  size: THREE.Vector2;
  origin: THREE.Vector4;   // room offset xy (native), grid min corner zw (tiles)
}

export function createWaterGrid(encoded: any, roomOffset: [number, number]): GameWaterGrid | null {
  if (!encoded || !Array.isArray(encoded.palette) || typeof encoded.cells !== 'string') return null;
  const bytes = Uint8Array.from(atob(encoded.cells), (c) => c.charCodeAt(0));
  const cells = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const { width, height } = encoded;
  if (!(width > 0 && height > 0) || cells.length !== width * height) return null;
  const data = new Float32Array(width * height * 4);
  for (let k = 0; k < cells.length; k++) {
    const c = encoded.palette[cells[k]];
    if (!c) return null;
    data.set([c[0], c[1], c[2], c[3]], k * 4);
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return {
    texture,
    size: new THREE.Vector2(width, height),
    origin: new THREE.Vector4(roomOffset[0], roomOffset[1], encoded.x0, encoded.y0),
  };
}

const COMMON = /* glsl */`
uniform mat4 uNativeFromWorld;
uniform mat4 uWorldFromNative;
uniform vec4 uWaveX;
uniform vec4 uWaveY;
uniform vec2 uLevel;
uniform float uStyleLevel;
uniform sampler2D uGrid;
uniform vec2 uGridSize;
uniform vec4 uGridOrigin;
uniform float uOpacity;
uniform float uTileUnits;

// The room's tile colour at a native position: bilinear between tile
// centres, clamped to the grid, then packed at half scale (as the game's
// vertex colours are) and restored.
vec4 waterTint(vec3 p) {
  vec2 g = (p.xy - uGridOrigin.xy) / uTileUnits - 0.5 - uGridOrigin.zw;
  g = clamp(g, vec2(0.0), uGridSize - 1.0);
  vec2 f = fract(g);
  ivec2 a = ivec2(floor(g));
  ivec2 b = ivec2(floor(g + 0.99999));
  vec3 c00 = texelFetch(uGrid, ivec2(a.x, a.y), 0).rgb;
  vec3 c10 = texelFetch(uGrid, ivec2(b.x, a.y), 0).rgb;
  vec3 c01 = texelFetch(uGrid, ivec2(a.x, b.y), 0).rgb;
  vec3 c11 = texelFetch(uGrid, ivec2(b.x, b.y), 0).rgb;
  vec3 c = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  vec3 packed = floor(c * 0.5 * 255.0) / 255.0;
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
  grid: GameWaterGrid, textures: GameWaterTextures, tileUnits: number,
): THREE.ShaderMaterial {
  const uniforms: Record<string, any> = {
    ...shared, ...style,
    uGrid: { value: grid.texture },
    uGridSize: { value: grid.size },
    uGridOrigin: { value: grid.origin },
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

/** A neutral tile colour (one half) as the game packs it at half scale and
 *  restores it: the tint that leaves a surface unchanged. */
export const NEUTRAL_TINT = (2 * 63) / 255;

/** Mirror the view's lights into the shared uniforms, in native space. The
 *  view's lights are calibrated for surfaces at a neutral tile tint; the
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



// Room tile tint for the view's standard ground materials. The game
// multiplies each baked vertex's final colour by the room's tile colour
// (bilinear between tile centres, packed at half scale); the view's lights
// are calibrated for a neutral tile, so the tint is taken relative to it.
// Rooms share materials, so the grid is bound per draw (bindRoomTint).
const ROOM_TINT_VERTEX_PARS = /* glsl */`
uniform sampler2D uRoomGrid;
uniform vec2 uRoomGridSize;
uniform vec4 uRoomGridOrigin;
uniform mat4 uRoomNativeFromWorld;
uniform float uRoomTileUnits;
uniform float uRoomTintOn;
varying vec3 vRoomTint;
vec3 roomTint(vec3 p) {
  vec2 g = (p.xy - uRoomGridOrigin.xy) / uRoomTileUnits - 0.5 - uRoomGridOrigin.zw;
  g = clamp(g, vec2(0.0), uRoomGridSize - 1.0);
  vec2 f = fract(g);
  ivec2 a = ivec2(floor(g));
  ivec2 b = ivec2(floor(g + 0.99999));
  vec3 c = mix(mix(texelFetch(uRoomGrid, a, 0).rgb, texelFetch(uRoomGrid, ivec2(b.x, a.y), 0).rgb, f.x),
    mix(texelFetch(uRoomGrid, ivec2(a.x, b.y), 0).rgb, texelFetch(uRoomGrid, b, 0).rgb, f.x), f.y);
  return floor(c * 0.5 * 255.0) / 255.0 * 2.0 / ${NEUTRAL_TINT.toFixed(9)};
}
`;
const ROOM_TINT_VERTEX = /* glsl */`
vec4 roomTintLocal = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  roomTintLocal = instanceMatrix * roomTintLocal;
#endif
vRoomTint = uRoomTintOn > 0.5 ? roomTint((uRoomNativeFromWorld * modelMatrix * roomTintLocal).xyz) : vec3(1.0);
`;

let blankGrid: THREE.DataTexture | null = null;

export function applyRoomTint(material: THREE.Material): void {
  const mat = material as any;
  if (mat.userData.roomTint) return;
  if (!blankGrid) {
    blankGrid = new THREE.DataTexture(new Float32Array([0.5, 0.5, 0.5, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    blankGrid.needsUpdate = true;
  }
  const uniforms = {
    uRoomGrid: { value: blankGrid as THREE.Texture },
    uRoomGridSize: { value: new THREE.Vector2(1, 1) },
    uRoomGridOrigin: { value: new THREE.Vector4() },
    uRoomNativeFromWorld: { value: new THREE.Matrix4() },
    uRoomTileUnits: { value: 1024 },
    uRoomTintOn: { value: 0 },
  };
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader: any, renderer: any) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROOM_TINT_VERTEX_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${ROOM_TINT_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoomTint;')
      .replace('#include <colorspace_fragment>', '#include <colorspace_fragment>\ngl_FragColor.rgb *= vRoomTint;');
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}:room-tint-1`;
  mat.userData.roomTint = uniforms;
  material.needsUpdate = true;
}

/** Bind one room's grid to a tinted material just before its draw. */
export function bindRoomTint(material: THREE.Material, grid: GameWaterGrid | null,
  nativeFromWorld: THREE.Matrix4, tileUnits: number): void {
  const u = (material as any).userData?.roomTint;
  if (!u) return;
  u.uRoomTintOn.value = grid ? 1 : 0;
  if (grid) {
    u.uRoomGrid.value = grid.texture;
    u.uRoomGridSize.value.copy(grid.size);
    u.uRoomGridOrigin.value.copy(grid.origin);
  }
  u.uRoomNativeFromWorld.value.copy(nativeFromWorld);
  u.uRoomTileUnits.value = tileUnits;
  (material as any).uniformsNeedUpdate = true;
}

export type { WorldWater };
