// Water for the world viewer — NO runtime pixel classification: the world
// index's texture routing table already carries each texture's water verdict
// ('chromatic' | 'neutral' | null), computed once at extraction
// (js/extract/jobs.js worldtex → js/water-metrics.js). Rendering covers the
// translucent animated sheet per water body, curtain hiding, per-body tints,
// and irradiated (pink/solid) handling.

import * as THREE from '../../../vendor/three.module.js';
import type { WorldScene, WorldSceneRoom } from './scene.js';

export const WATER_SHADER_VERSION = 'brighter-water-v4-fixed-palette';
export const WATER_BLUE = Object.freeze([0.12, 0.28, 0.28] as const);
// Cave of the Crystal's recovered tint, the fixed colour for the structurally
// identified irradiated river.
export const WATER_PINK_TINT = Object.freeze([
  1.458823561668396, 0.9019607901573181, 1.4901961088180542,
] as const);

/** One water tile emitted by collectRoomWaterTiles / consumed by the sheets. */
export interface WaterTile {
  x: number;
  y: number;
  z: number;
  texture: number;
  tint: number[];
  solid: number;
  level: number;
  tileUnits: number;
  originX?: number;
  originY?: number;
}

export interface WaterUniforms {
  waterTime: { value: number };
  sheetOpacity: { value: number };
  sheetColorOverride: { value: THREE.Vector4 };
  sheetSkyColor: { value: THREE.Color };
  sheetGroundColor: { value: THREE.Color };
  sheetSunColor: { value: THREE.Color };
  sheetSunDirection: { value: THREE.Vector3 };
}

/** Water verdicts straight from the world index's texture routing table. */
export class WorldWaterRegistry {
  kinds: Map<number, string>;

  constructor(textures: Record<string, any> | null | undefined) {
    this.kinds = new Map();
    for (const [id, meta] of Object.entries(textures || {})) {
      if (meta?.water === 'chromatic' || meta?.water === 'neutral') {
        this.kinds.set(Number(id), meta.water);
      }
    }
  }

  isWater(textureId: number | string): boolean {
    return this.kinds.has(Number(textureId));
  }

  kind(textureId: number | string): string | null {
    return this.kinds.get(Number(textureId)) || null;
  }

  // Post-decode classification seam kept for the merged bake's call site;
  // verdicts are extraction-time facts here, so it's a no-op.
  classify(): void {}
}

// Curtains come in two heights: full 1024-unit wave walls and 512-unit low
// ripple strips; waterfall props are excluded by this planarity test.
export const WATER_WALL_HEIGHT = 1024;

export function isWaterWallGeometry(geometry: THREE.BufferGeometry | null | undefined): boolean {
  if (!geometry?.boundingBox) geometry?.computeBoundingBox?.();
  const box = geometry?.boundingBox;
  if (!box) return false;
  const dx = box.max.x - box.min.x;
  const dy = box.max.y - box.min.y;
  const dz = box.max.z - box.min.z;
  return dz > WATER_WALL_HEIGHT * 0.375 && Math.min(dx, dy) < 1;
}

// How far the surface sits below the crest plane, in native units.
export const WATER_SHEET_DROP = 16;

interface WaterSample {
  x: number;
  y: number;
  z: number;
  crest: number;
  texture: number;
  tints: number[][];
}

/**
 * Enumerate a loaded room's water tiles. Four-neighbour tiles sharing a
 * curtain texture at the same/adjacent authored z form one body; the
 * irradiated river is recognised from exact occurrence recolors (multi-tint
 * ramps / red>=green tints) and renders solid pink, everything else
 * translucent blue.
 */
export function collectRoomWaterTiles(
  world: WorldScene,
  room: WorldSceneRoom,
  registry: WorldWaterRegistry,
): WaterTile[] {
  const samples = new Map<string, WaterSample>();
  const layer = world.layerUnits;
  const tileUnits = world.tileUnits;
  const oc = world.occurrenceColumns;
  const pc = world.placementColumns;
  for (const mesh of room.meshes) {
    const exact = mesh.userData.exact;
    if (!exact || exact.authoredEmpty || exact.sourceKind !== 'occurrence') continue;
    const id = Number(exact.renderTexture);
    if (!(id >= 0) || !registry.isWater(id)) continue;
    if (!isWaterWallGeometry(mesh.geometry)) continue;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const wallTop = mesh.geometry.boundingBox!.max.z;
    const tint = Array.isArray(exact.recolors)
      ? exact.recolors[0].slice(0, 3).map((value: any, index: number) => (
        Number(value) * 2 * Number(exact.recolors[2]?.[index] ?? 0.5)
      ))
      : [1, 1, 1];
    for (const row of exact.placementRows) {
      const occurrence = room.shard.occurrences[row[pc.occurrence]];
      if (!occurrence) continue;
      // Raw room-local coordinates — the same no-crop-offset frame as
      // _placementMatrix, so sheets stay glued to the baked terrain.
      const x = Number(occurrence[oc.x]);
      const y = Number(occurrence[oc.y]);
      const z = Number(occurrence[oc.z]) || 0;
      const crest = z * layer + wallTop;
      const key = `${x},${y},${z},${id}`;
      const existing = samples.get(key);
      if (!existing) {
        samples.set(key, { x, y, z, crest, texture: id, tints: [tint] });
      } else {
        if (crest > existing.crest) existing.crest = crest;
        existing.tints.push(tint);
      }
    }
  }
  if (!samples.size) return [];

  const chromaOf = (tint: number[]) => Math.max(...tint) - Math.min(...tint);
  const unseen = new Set(samples.keys());
  const result: WaterTile[] = [];
  while (unseen.size) {
    const first = unseen.values().next().value as string;
    unseen.delete(first);
    const queue = [samples.get(first)!];
    const body: WaterSample[] = [];
    while (queue.length) {
      const entry = queue.pop()!;
      body.push(entry);
      for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const key = `${entry.x + dx},${entry.y + dy},${entry.z + dz},${entry.texture}`;
          if (!unseen.delete(key)) continue;
          queue.push(samples.get(key)!);
        }
      }
    }

    const bodyTints = body.flatMap(entry => entry.tints);
    const chromaticTints = registry.kind(body[0].texture) === 'neutral'
      ? []
      : bodyTints.filter(tint => chromaOf(tint) > 0.05);
    const distinct = new Set(chromaticTints.map(tint => (
      tint.map(value => Number(value).toFixed(6)).join(',')
    )));
    const pink = distinct.size >= 2
      || chromaticTints.some(tint => tint[0] >= tint[1]);
    const level = Math.max(...body.map(entry => entry.crest)) - WATER_SHEET_DROP;
    const bodyTiles = new Map<string, WaterSample>();
    for (const entry of body) {
      const key = `${entry.x},${entry.y}`;
      if (!bodyTiles.has(key)) bodyTiles.set(key, entry);
    }
    for (const entry of bodyTiles.values()) {
      result.push({
        x: entry.x,
        y: entry.y,
        z: entry.z,
        texture: entry.texture,
        tint: pink ? [...WATER_PINK_TINT] : [1, 1, 1],
        solid: pink ? 1 : 0,
        level,
        tileUnits,
      });
    }
  }
  return result;
}

/**
 * One quad per water tile at its body surface level, in room-local native
 * coordinates (parent the mesh to the room group / merged root).
 */
export function buildWaterSheetGeometry(tiles: WaterTile[], {
  offsetX = 0,
  offsetY = 0,
}: { offsetX?: number; offsetY?: number } = {}): THREE.BufferGeometry {
  const positions = new Float32Array(tiles.length * 4 * 3);
  const tints = new Float32Array(tiles.length * 4 * 4);
  const indices = new Uint32Array(tiles.length * 6);
  tiles.forEach((entry, index) => {
    const x0 = entry.x * entry.tileUnits + (entry.originX ?? offsetX);
    const y0 = entry.y * entry.tileUnits + (entry.originY ?? offsetY);
    const x1 = x0 + entry.tileUnits;
    const y1 = y0 + entry.tileUnits;
    const z = entry.level;
    positions.set([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], index * 12);
    for (let corner = 0; corner < 4; corner++) {
      tints.set([...entry.tint, entry.solid ?? 0], (index * 4 + corner) * 4);
    }
    // CCW from +z in game space, like decoded meshes after their winding fix.
    indices.set([0, 1, 2, 0, 2, 3].map((i) => index * 4 + i), index * 6);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('waterTint', new THREE.BufferAttribute(tints, 4));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.boundingSphere = new THREE.Sphere();
  geometry.boundingBox!.getBoundingSphere(geometry.boundingSphere);
  return geometry;
}

/**
 * Shared water uniforms: the ripple clock, the user's opacity and colour
 * override, and the scene's light rig (mirrored by the view each frame).
 */
export function createWaterUniforms(): WaterUniforms {
  return {
    waterTime: { value: 0 },
    sheetOpacity: { value: 0.62 },
    sheetColorOverride: { value: new THREE.Vector4(0.12, 0.28, 0.28, 0) },
    sheetSkyColor: { value: new THREE.Color(0xcfe0ff) },
    sheetGroundColor: { value: new THREE.Color(0x55584d) },
    sheetSunColor: { value: new THREE.Color(0xfff4e0) },
    sheetSunDirection: { value: new THREE.Vector3(0.5, 0.75, 0.35) },
  };
}

/** Mirror the view's hemisphere + directional light into the sheet shader. */
export function updateWaterSheetLights(
  shared: WaterUniforms,
  hemisphere: THREE.HemisphereLight,
  sun: THREE.DirectionalLight,
): void {
  shared.sheetSkyColor.value.copy(hemisphere.color)
    .multiplyScalar(hemisphere.intensity);
  shared.sheetGroundColor.value.copy(hemisphere.groundColor)
    .multiplyScalar(hemisphere.intensity);
  shared.sheetSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
  shared.sheetSunDirection.value.copy(sun.position)
    .sub(sun.target.position).normalize();
}

const SHEET_VERTEX = `
attribute vec4 waterTint;
varying vec3 vSheetWorld;
varying vec4 vSheetTint;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vSheetWorld = world.xyz;
  vSheetTint = waterTint;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

// Gently animated ripple normal, hemisphere reflection + sun glint, the fixed
// body colour (or the user's override), and the per-body tint. Irradiated
// (solid) bodies glow in their normalised tint.
const SHEET_FRAGMENT = `
uniform float waterTime;
uniform float sheetOpacity;
uniform vec4 sheetColorOverride;
uniform vec3 sheetSkyColor;
uniform vec3 sheetGroundColor;
uniform vec3 sheetSunColor;
uniform vec3 sheetSunDirection;
uniform vec3 sheetWaterColor;
varying vec3 vSheetWorld;
varying vec4 vSheetTint;
#include <common>
#include <fog_pars_fragment>

vec2 sheetRipple( vec2 point, float time ) {
  vec2 slope = vec2( 0.0 );
  slope += 0.16 * vec2( 1.0, 0.4 ) * cos( dot( point, vec2( 1.0, 0.4 ) ) * 5.1 + time * 1.3 );
  slope += 0.12 * vec2( -0.5, 1.0 ) * cos( dot( point, vec2( -0.5, 1.0 ) ) * 7.3 + time * 0.9 );
  slope += 0.06 * vec2( 0.3, -1.0 ) * cos( dot( point, vec2( 0.3, -1.0 ) ) * 13.0 + time * 2.1 );
  return slope;
}

void main() {
  vec2 point = vSheetWorld.xz;
  vec2 slope = 0.5 * ( sheetRipple( point + vec2( waterTime * 0.07, 0.0 ), waterTime )
    + sheetRipple( point * 1.31 - vec2( 0.0, waterTime * 0.05 ), -waterTime ) );
  vec3 normal = normalize( vec3( -slope.x, 1.0, -slope.y ) );
  vec3 view = normalize( cameraPosition - vSheetWorld );
  vec3 reflected = reflect( -view, normal );
  vec3 reflection = 0.35 * mix( sheetGroundColor, sheetSkyColor,
    clamp( reflected.y * 0.5 + 0.5, 0.0, 1.0 ) );
  reflection += sheetSunColor
    * pow( clamp( dot( reflected, sheetSunDirection ), 0.0, 1.0 ), 90.0 );
  vec3 waterColor = mix( sheetWaterColor, sheetColorOverride.rgb, sheetColorOverride.w );
  vec3 surface = mix( reflection, waterColor, 0.65 );
  float hemi = clamp( normal.y * 0.5 + 0.5, 0.0, 1.0 );
  float eastWest = normal.x * 0.5 + 1.0;
  // 1/pi matches the energy scale the standard material applies to the same
  // scene lights, so the sheet sits in the same exposure as its surroundings.
  vec3 lit = ( mix( sheetGroundColor, sheetSkyColor, hemi ) * eastWest
    + sheetSunColor * clamp( dot( normal, sheetSunDirection ), 0.0, 1.0 ) )
    * 0.318;
  vec3 color = surface * lit * vSheetTint.rgb;
  if ( vSheetTint.a > 0.9 ) {
    vec3 glow = vSheetTint.rgb
      / max( max( vSheetTint.r, max( vSheetTint.g, vSheetTint.b ) ), 0.001 );
    color = lit * pow( glow, vec3( 2.0 ) ) * 0.55;
  }
  gl_FragColor = vec4( color, mix( sheetOpacity, 1.0, vSheetTint.a ) );
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/**
 * One sheet material per water texture. `cache` is a Map owned by the view
 * (never module-global): materials capture the view's shared uniforms, so
 * they must not outlive the view that created them.
 */
export function waterSheetMaterialFor(
  textureId: number | string,
  sharedUniforms: WaterUniforms,
  cache: Map<number, THREE.ShaderMaterial>,
): THREE.ShaderMaterial {
  const id = Number(textureId);
  let material = cache.get(id);
  if (material) return material;
  material = new THREE.ShaderMaterial({
    name: `water-sheet-${id}`,
    vertexShader: SHEET_VERTEX,
    fragmentShader: SHEET_FRAGMENT,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...sharedUniforms,
      sheetWaterColor: {
        value: new THREE.Color(...WATER_BLUE).convertSRGBToLinear(),
      },
    },
    fog: true,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
  });
  cache.set(id, material);
  return material;
}

export default WorldWaterRegistry;
