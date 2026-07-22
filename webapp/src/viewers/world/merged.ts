// Cross-room merged renderer, built on top of WorldScene. Rebuilds the
// already-loaded per-room graph into a small set of large static meshes (one
// per world cell / texture / alpha / tangent-layout / water bucket) with
// per-vertex z+category mask bytes, a GPU recolor palette (the exact two-mask
// formula from js/recolor.js as per-vertex palette lookups), and an opt-in
// small-object distance cull. WebGL2 only (texelFetch + float palette). The
// module never mutates the per-room graph itself, but build()'s
// onRoomHarvested callback tells the host the moment a room's graph is no
// longer needed so it can be released mid-bake.

import * as THREE from '../../../vendor/three.module.js';
import { WORLD_CATEGORIES, CATEGORY_COLOURS, yieldToBrowser } from './scene.js';
import {
  isWaterWallGeometry,
  collectRoomWaterTiles, buildWaterSheetGeometry, waterSheetMaterialFor,
} from './water.js';
import { isIdentityRecolor } from '../../recolor.js';
import { MergedBakePool } from './bake-pool.js';
import type { BakeJobOutcome } from './bake-pool.js';
import type { BakeBucketArrays } from './bake-worker.js';
import type { WorldScene, WorldTextureSet } from './scene.js';
import type { WorldWaterRegistry, WaterUniforms, WaterTile } from './water.js';
import type { WorldPickIndex } from './pick-index.js';

export const MERGED_SHADER_VERSION = 'brighter-merged-v1';

const CELL_TILES = 160;            // world cell edge for frustum-culling groups
const SMALL_DIAMETER_TILES = 2.5;  // props smaller than this join the cull tier
const PALETTE_WIDTH = 1024;        // texels per palette row
const YIELD_BUDGET_MS = 24;        // bake slice before yielding to the browser
// Bake slice while nothing interactive is on screen (host overlay curtains
// the canvas, or the tab is hidden): longer slices = fewer yields per second
// of single-threaded merge work. Yields go through yieldToBrowser
// (MessageChannel), which background tabs never throttle.
const YIELD_BUDGET_CURTAINED_MS = 90;
const MAX_PENDING_UPLOADS = 24;    // baked cells allowed to await their first GPU upload

const META_CATEGORY_INDEX: Record<string, number> = Object.fromEntries(
  WORLD_CATEGORIES.map((category, index) => [category, index]),
);

// Compact uniform-luminance placements store [tint, modulation]; the merged
// palette has fixed tint1/tint2/modulation columns, so duplicate the tint.
export function mergedPaletteTuple(recolors: any, uniformLuminanceTint = false): any {
  return uniformLuminanceTint && Array.isArray(recolors) && recolors.length === 2
    ? [recolors[0], recolors[0], recolors[1]]
    : recolors;
}

// One animation frame, with a timeout fallback so a suspended rAF (background
// window) can never wedge the bake. Hidden tab: rAF never fires and background
// timers clamp to ≥1s: resume via the never-throttled channel yield instead.
function nextFrameOrTimeout(ms = 150): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden) return yieldToBrowser();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  });
}

// --- shader injection --------------------------------------------------------

const MERGED_VERTEX_DECL = `
attribute vec2 brighterMeta;
uniform vec3 brighterVisMask;
uniform float brighterCullDist;`;

const MERGED_VERTEX_COLOR_DECL = `
attribute float brighterRecolor;
uniform sampler2D brighterPalette;
varying vec3 vBrighterT1;
varying vec3 vBrighterT2;
varying vec3 vBrighterOverall;
varying vec2 vBrighterRecFlags;`;

// brighterMeta.x: biased z level (0..47). brighterMeta.y bit layout:
// category(2) | small(1) | recolor-enabled(1) | full-tint(1); bits 5..7 unused.
// brighterVisMask: x = z bits 0..23, y = z bits 24..47, z = category bits.
const MERGED_VERTEX_BODY = `
{
  float brighterZ = brighterMeta.x;
  float brighterBits = brighterMeta.y;
  float brighterCategory = mod( brighterBits, 4.0 );
  float brighterZMask = brighterZ < 24.0 ? brighterVisMask.x : brighterVisMask.y;
  float brighterZBit = mod( floor( brighterZMask / exp2( mod( brighterZ, 24.0 ) ) ), 2.0 );
  float brighterCatBit = mod( floor( brighterVisMask.z / exp2( brighterCategory ) ), 2.0 );
  bool brighterHidden = brighterZBit < 0.5 || brighterCatBit < 0.5;
  if ( !brighterHidden && mod( floor( brighterBits / 4.0 ), 2.0 ) > 0.5 ) {
    vec4 brighterWorld = modelMatrix * vec4( transformed, 1.0 );
    brighterHidden = distance( brighterWorld.xyz, cameraPosition ) > brighterCullDist;
  }
  if ( brighterHidden ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
}`;

const MERGED_VERTEX_COLOR_BODY = `
{
  int brighterIndex = 3 * int( brighterRecolor + 0.5 );
  vBrighterT1 = texelFetch( brighterPalette,
    ivec2( brighterIndex % ${PALETTE_WIDTH}, brighterIndex / ${PALETTE_WIDTH} ), 0 ).rgb;
  vBrighterT2 = texelFetch( brighterPalette,
    ivec2( ( brighterIndex + 1 ) % ${PALETTE_WIDTH}, ( brighterIndex + 1 ) / ${PALETTE_WIDTH} ), 0 ).rgb;
  vBrighterOverall = texelFetch( brighterPalette,
    ivec2( ( brighterIndex + 2 ) % ${PALETTE_WIDTH}, ( brighterIndex + 2 ) / ${PALETTE_WIDTH} ), 0 ).rgb;
  vBrighterRecFlags = vec2(
    mod( floor( brighterMeta.y / 8.0 ), 2.0 ),
    mod( floor( brighterMeta.y / 16.0 ), 2.0 ) );
}`;

const MERGED_FRAGMENT_DECL = `
uniform sampler2D brighterParameterMap;
varying vec3 vBrighterT1;
varying vec3 vBrighterT2;
varying vec3 vBrighterOverall;
varying vec2 vBrighterRecFlags;`;

// The exact two-mask formula from js/recolor.js (native-two-mask-v3), with the
// per-material tint uniforms replaced by the palette varyings.
const MERGED_MAP_FRAGMENT = `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  vec2 brighterMasks = vBrighterRecFlags.x > 0.5
    ? texture2D( brighterParameterMap, vMapUv ).rg
    : vec2( 0.0 );
  vec3 brighterEncoded = pow( max( sampledDiffuseColor.rgb, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );
  float brighterQ = ( brighterEncoded.r + brighterEncoded.g + brighterEncoded.b ) * ( 2.0 / 3.0 );
  float brighterHi = max( brighterQ - 1.0, 0.0 );
  float brighterMid = min( brighterQ, 1.0 ) - brighterHi;
  vec3 brighterTarget1 = vec3( brighterHi ) + brighterMid * vBrighterT1;
  vec3 brighterTarget2 = vec3( brighterHi ) + brighterMid * vBrighterT2;
  vec3 brighterMasked = brighterEncoded * max( 0.0, 1.0 - brighterMasks.r - brighterMasks.g )
    + brighterTarget1 * brighterMasks.r + brighterTarget2 * brighterMasks.g;
  float brighterLuminance = ( brighterEncoded.r + brighterEncoded.g + brighterEncoded.b ) / 3.0;
  vec3 brighterUniform = brighterLuminance * vBrighterT1;
  vec3 brighterMixed = mix( brighterMasked, brighterUniform, vBrighterRecFlags.y );
  vec3 brighterOutput = mix( brighterEncoded, brighterMixed, vBrighterRecFlags.x );
  sampledDiffuseColor.rgb = pow( max( brighterOutput, vec3( 0.0 ) ), vec3( 2.2 ) );
  diffuseColor *= sampledDiffuseColor;
#endif`;

const MERGED_COLORSPACE_FRAGMENT = `#include <colorspace_fragment>
gl_FragColor.rgb *= mix( vec3( 1.0 ),
  clamp( 2.0 * vBrighterOverall, vec3( 0.0 ), vec3( 2.0 ) ), vBrighterRecFlags.x );`;

// --- the merged world -------------------------------------------------------

/** Bucket classification shared by the bake and the session-edit re-bake. */
export interface MergedBucketClass {
  materialToken: string;
  renderTexture: number;
  flatCategory: string | null;
  alpha: boolean;
  tangent: boolean;
  water: boolean;
  hasRecolor: boolean;
  fullTint: boolean;
  metaZ: number;
  metaBits: number;
}

export interface MergedBucketItem {
  geometry: THREE.BufferGeometry;
  count: number;
  instanceArray: ArrayLike<number>;
  roomX: number;
  roomY: number;
  metaZ: number;
  metaBits: number;
  palette: number;
  recolors?: any;
  fullTint?: boolean;
}

export interface MergedBucketDef {
  key: string;
  cellX: number;
  cellY: number;
  materialToken: string;
  renderTexture: number;
  flatCategory: string | null;
  alpha: boolean;
  tangent: boolean;
  water: boolean;
  items: MergedBucketItem[] | null;
  vertices: number;
  indices: number;
}

interface MergedWaterGroup {
  cellX: number;
  cellY: number;
  texture: number;
  tiles: WaterTile[];
}

interface MergedHarvest {
  buckets: MergedBucketDef[];
  paletteTuples: any[];
  waterGroups: Map<string, MergedWaterGroup>;
  totalVertices: number;
  totalIndices: number;
  totalInstances: number;
}

// Byte-level equality across the worker-vs-main determinism gate (bakeVerify).
function sameBytes(a: ArrayBufferView | null, b: ArrayBufferView | null): boolean {
  if (!a || !b) return a === b;
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let index = 0; index < ua.length; index++) {
    if (ua[index] !== ub[index]) return false;
  }
  return true;
}

function sameBakeArrays(a: BakeBucketArrays, b: BakeBucketArrays): boolean {
  return sameBytes(a.positions, b.positions) && sameBytes(a.normals, b.normals)
    && sameBytes(a.uvs, b.uvs) && sameBytes(a.tangents, b.tangents)
    && sameBytes(a.metas, b.metas) && sameBytes(a.recolors, b.recolors)
    && sameBytes(a.indices, b.indices) && sameBytes(a.bounds, b.bounds);
}

export interface MergedStats {
  meshes: number;
  vertices: number;
  triangles: number;
  instances: number;
  paletteTuples: number;
  waterMeshes: number;
  waterSheets: number;
}

export class MergedWorld {
  scene: THREE.Object3D;
  world: WorldScene;
  waterRegistry: WorldWaterRegistry;
  waterUniforms: WaterUniforms;
  sheetMaterialCache: Map<number, THREE.ShaderMaterial>;
  renderer: THREE.WebGLRenderer | null;
  pickIndex: WorldPickIndex | null;
  uploadCurtain: (() => boolean) | null;
  root: THREE.Group;
  ready: boolean;
  building: boolean;
  stats: MergedStats | null;
  rebakes: number;
  /** 'auto': fan the bucket bake across the worker pool (automatic
   * main-thread fallback); 'main': force the single-threaded path. */
  bakeMode: 'auto' | 'main';
  /** Test hook (smoke): with the worker path, ALSO bake every bucket on the
   * main thread and byte-compare: result lands in verifyResult. */
  bakeVerify: boolean;
  lastBakeMode: 'worker' | 'main' | null;
  verifyResult: { buckets: number; mismatches: number } | null;
  /** Where the bucket phase's wall-clock went (observational; perf harness
   * reads it): mathWaitMs = main thread blocked on worker results,
   * drainWaitMs = blocked on the frame-paced GPU-upload drain. */
  buildStats: { mode: string | null; bucketLoopMs: number; mathWaitMs: number; drainWaitMs: number } | null;
  _bakePool: MergedBakePool | null;
  _generation: number;
  _zBias: number;
  _paletteIndex: Map<string, number>;
  _paletteTuples: any[];
  _roomCells: Map<number, { cellX: number; cellY: number }>;
  _cellRooms: Map<string, number[]>;
  _buckets: { mesh: THREE.Mesh; water: boolean }[];
  _sheetMeshes: THREE.Mesh[];
  _pendingUploads: THREE.Mesh[];
  _curtainedMeshes: THREE.Mesh[];
  _sheetsVisible: boolean;
  _curtainsVisible: boolean;
  _materialCache: Map<string, THREE.MeshStandardMaterial>;
  _depthCache: Map<string, THREE.MeshDepthMaterial>;
  _paletteUniform: { value: THREE.DataTexture | null };
  _blackParameterMap: THREE.DataTexture | null;
  _visMask: { value: THREE.Vector3 };
  _cullDist: { value: number };
  _categoryVisible: Record<string, boolean>;

  /**
   * `scene`: host group (the display root). `waterUniforms`: rig from
   * createWaterUniforms. `sheetMaterialCache`: view-owned water material
   * cache. `renderer` enables upload pacing. `pickIndex`: view-owned CPU
   * picking index, filled during the harvest (one entry per placement) so
   * Inspect mode works after the graph release. `uploadCurtain`: while it
   * returns true (the host's loading overlay hides the canvas), cells whose
   * GPU upload has completed are kept INVISIBLE until the build finishes:
   * upload-pacing frames then only rasterise the ≤MAX_PENDING_UPLOADS new
   * cells instead of the whole growing world, which on slow/software GPUs
   * turns an O(cells²) bake-long raster bill into O(cells).
   */
  constructor({
    scene, world, waterRegistry, waterUniforms, sheetMaterialCache,
    renderer = null, pickIndex = null, uploadCurtain = null,
  }: {
    scene: THREE.Object3D;
    world: WorldScene;
    waterRegistry: WorldWaterRegistry;
    waterUniforms: WaterUniforms;
    sheetMaterialCache?: Map<number, THREE.ShaderMaterial> | null;
    renderer?: THREE.WebGLRenderer | null;
    pickIndex?: WorldPickIndex | null;
    uploadCurtain?: (() => boolean) | null;
  }) {
    this.scene = scene;
    this.world = world;
    this.waterRegistry = waterRegistry;
    this.waterUniforms = waterUniforms;
    this.sheetMaterialCache = sheetMaterialCache || new Map();
    this.renderer = renderer;
    this.pickIndex = pickIndex;
    this.uploadCurtain = uploadCurtain;
    this.root = new THREE.Group();
    this.root.name = 'merged-world';
    this.root.visible = false;
    // Static between _syncRootTransform calls (which re-compose explicitly).
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);

    this.ready = false;
    this.building = false;
    this.stats = null;
    this.rebakes = 0;              // completed session-edit re-bakes
    this.bakeMode = 'auto';
    this.bakeVerify = false;
    this.lastBakeMode = null;
    this.verifyResult = null;
    this.buildStats = null;
    this._bakePool = null;
    this._generation = 0;
    this._zBias = 0;
    this._paletteIndex = new Map();   // recolor tuple JSON -> palette slot
    this._paletteTuples = [];
    this._roomCells = new Map();      // room id -> {cellX, cellY}
    this._cellRooms = new Map();      // "cx,cy" -> [room ids]
    this._buckets = [];
    this._sheetMeshes = [];
    this._pendingUploads = [];
    this._curtainedMeshes = [];
    this._sheetsVisible = true;
    this._curtainsVisible = true;
    this._materialCache = new Map();
    this._depthCache = new Map();
    // Stable uniform holder: rebuilds swap the texture without recompiling.
    this._paletteUniform = { value: null };
    this._blackParameterMap = null;
    this._visMask = { value: new THREE.Vector3(0xffffff, 0xffffff, 15) };
    this._cullDist = { value: 1e9 };
    this._categoryVisible = Object.fromEntries(
      WORLD_CATEGORIES.map((category) => [category, true]),
    );
  }

  get hasWater(): boolean {
    return this._buckets.some((bucket) => bucket.water);
  }

  _syncRootTransform(): void {
    const source = this.world.root;
    this.root.rotation.copy(source.rotation);
    this.root.scale.copy(source.scale);
    this.root.position.copy(source.position);
    this.root.updateMatrix();   // root is frozen (matrixAutoUpdate=false)
  }

  _applyMergedProgram<T extends THREE.Material>(material: T, { colors }: { colors: boolean }): T {
    const visMask = this._visMask;
    const cullDist = this._cullDist;
    const palette = this._paletteUniform;
    const parameterMap = (material as any).brighterMergedParameterMap || this._blackParameterMap;
    material.onBeforeCompile = (shader: any) => {
      shader.uniforms.brighterVisMask = visMask;
      shader.uniforms.brighterCullDist = cullDist;
      let vertexDecl = MERGED_VERTEX_DECL;
      let vertexBody = MERGED_VERTEX_BODY;
      if (colors) {
        shader.uniforms.brighterPalette = palette;
        shader.uniforms.brighterParameterMap = { value: parameterMap };
        vertexDecl += MERGED_VERTEX_COLOR_DECL;
        vertexBody += MERGED_VERTEX_COLOR_BODY;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <map_pars_fragment>',
            `#include <map_pars_fragment>${MERGED_FRAGMENT_DECL}`)
          .replace('#include <map_fragment>', MERGED_MAP_FRAGMENT)
          .replace('#include <colorspace_fragment>', MERGED_COLORSPACE_FRAGMENT);
      }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>${vertexDecl}`)
        .replace('#include <project_vertex>', `#include <project_vertex>${vertexBody}`);
    };
    material.customProgramCacheKey = () => (
      `${MERGED_SHADER_VERSION}:${colors ? 'colors' : 'plain'}`
    );
    material.needsUpdate = true;
    return material;
  }

  _authoredMaterial(
    bucket: MergedBucketDef,
    textures: WorldTextureSet | null,
    parameterMap: THREE.Texture | null,
  ): THREE.MeshStandardMaterial {
    const cacheKey = `${bucket.materialToken}|a${bucket.alpha ? 1 : 0}`;
    let material = this._materialCache.get(cacheKey);
    if (material) return material;
    if (bucket.renderTexture < 0) {
      material = new THREE.MeshStandardMaterial({
        color: CATEGORY_COLOURS[bucket.flatCategory!] ?? 0xb9c2cf,
        metalness: 0.02,
        roughness: 0.88,
        side: THREE.FrontSide,
      });
      this._applyMergedProgram(material, { colors: true });
    } else {
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: textures!.map,
        // Per-room parity: the normal map applies whenever the texture ships
        // one; geometry without tangents falls back to derivative normals.
        normalMap: textures!.normalMap || null,
        metalness: 0.02,
        roughness: 0.88,
        side: THREE.FrontSide,
      });
      if (bucket.alpha) material.alphaTest = 0.35;
      (material as any).brighterMergedParameterMap = parameterMap;
      this._applyMergedProgram(material, { colors: true });
    }
    material.name = `merged-${cacheKey}`;
    this._materialCache.set(cacheKey, material);
    return material;
  }

  _depthMaterial(bucket: MergedBucketDef, textures: WorldTextureSet | null): THREE.MeshDepthMaterial {
    const cacheKey = bucket.alpha ? `alpha|${bucket.materialToken}` : 'opaque';
    let material = this._depthCache.get(cacheKey);
    if (material) return material;
    material = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    });
    if (bucket.alpha && textures?.map) {
      material.map = textures.map;
      material.alphaTest = 0.35;
    }
    this._applyMergedProgram(material, { colors: false });
    this._depthCache.set(cacheKey, material);
    return material;
  }

  _ensureSharedTextures(): void {
    if (!this._blackParameterMap) {
      this._blackParameterMap = new THREE.DataTexture(
        new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat,
      );
      this._blackParameterMap.needsUpdate = true;
    }
  }

  _buildPalette(tuples: any[]): THREE.DataTexture {
    const texels = Math.max(1, tuples.length) * 3;
    const rows = Math.max(1, Math.ceil(texels / PALETTE_WIDTH));
    const data = new Float32Array(PALETTE_WIDTH * rows * 4);
    for (let index = 0; index < tuples.length; index++) {
      const tuple = tuples[index];
      const overall = tuple.length === 3 ? tuple[2] : [0.5, 0.5, 0.5];
      const colors = [tuple[0], tuple[1], overall];
      for (let slot = 0; slot < 3; slot++) {
        const at = (index * 3 + slot) * 4;
        data[at] = Number(colors[slot][0]) || 0;
        data[at + 1] = Number(colors[slot][1]) || 0;
        data[at + 2] = Number(colors[slot][2]) || 0;
        data[at + 3] = 1;
      }
    }
    const texture = new THREE.DataTexture(
      data, PALETTE_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType,
    );
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Classify one placement batch for bucketing: the shared seam between the
   * live-graph harvest and the session-edit cell re-bake, so both produce
   * byte-identical bucket keys and per-vertex meta bits. `exact` needs
   * category / renderTexture / flags / recolors / z.
   */
  classifyBucket(exact: any, geometry: THREE.BufferGeometry): MergedBucketClass {
    const world = this.world;
    const flags = world.flags;
    const renderTexture = Number(exact.renderTexture);
    const textured = Number.isFinite(renderTexture) && renderTexture >= 0;
    const meta = textured ? world.textureMeta(renderTexture) : null;
    const alpha = textured
      && (!!(exact.flags & flags.alpha) || !!meta?.alpha);
    // Water wave-curtain geometry keeps its authored form in its own
    // bucket so the water toggle can hide it; waterfall props stay plain.
    const water = textured && this.waterRegistry.isWater(renderTexture)
      && isWaterWallGeometry(geometry);
    const tangent = textured && meta?.normal != null
      && !!geometry.attributes.tangent;
    const materialToken = textured ? `t${renderTexture}` : `f${exact.category}`;
    const hasRecolor = Array.isArray(exact.recolors) && !!exact.recolors.length;
    const fullTint = !!(Number(exact.flags) & Number(flags.uniformLuminanceTint));
    // White tints are the native identity (see recolor.js); the extraction-
    // guarded uniform-luminance-tint mode stays live.
    const recolorEnabled = hasRecolor && textured
      && (fullTint
        ? true   // uniform tint never reads the packed plane (black fallback binds)
        : meta?.parameter != null && !isIdentityRecolor(exact.recolors));
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const small = geometry.boundingSphere!.radius * 2
      < SMALL_DIAMETER_TILES * world.tileUnits;
    const categoryBits = META_CATEGORY_INDEX[exact.category] ?? 1;
    const metaZ = Math.min(47, Math.max(0, Math.round(Number(exact.z) - this._zBias)));
    const metaBits = categoryBits
      | (small ? 4 : 0)
      | (recolorEnabled ? 8 : 0)
      | (fullTint ? 16 : 0);
    return {
      materialToken,
      renderTexture: textured ? renderTexture : -1,
      flatCategory: textured ? null : exact.category,
      alpha,
      tangent,
      water,
      hasRecolor,
      fullTint,
      metaZ,
      metaBits,
    };
  }

  bucketKeyFor(cellX: number, cellY: number, classified: MergedBucketClass): string {
    return `${cellX},${cellY}|${classified.materialToken}`
      + `|a${classified.alpha ? 1 : 0}|g${classified.tangent ? 1 : 0}`
      + `|w${classified.water ? 1 : 0}`;
  }

  /** The world cell a room was harvested into (rooms map to exactly one). */
  cellOfRoom(roomId: number | string): { cellX: number; cellY: number } | null {
    return this._roomCells.get(Number(roomId)) || null;
  }

  roomsInCell(cellX: number, cellY: number): number[] {
    return this._cellRooms.get(`${cellX},${cellY}`) || [];
  }

  /**
   * Intern one recolor tuple into the GPU palette. During the bake the
   * texture is built once afterwards; a post-build intern (cell re-bake met
   * a tuple the bake never saw) rebuilds the palette texture in place.
   */
  _internTuple(recolors: any): number {
    const key = JSON.stringify(recolors);
    let index = this._paletteIndex.get(key);
    if (index === undefined) {
      index = this._paletteTuples.length;
      this._paletteTuples.push(recolors);
      this._paletteIndex.set(key, index);
      if (this.ready && this._paletteUniform.value) {
        const previous = this._paletteUniform.value;
        this._paletteUniform.value = this._buildPalette(this._paletteTuples);
        previous.dispose();
      }
    }
    return index;
  }

  // Current cooperative slice budget for the harvest/bake/water loops: tight
  // when the merged scene is live (input + rAF stay responsive), generous
  // while the host's loading overlay hides the canvas or the tab is hidden.
  // Only the yield frequency changes: operation order (and therefore float
  // output) is identical either way.
  _sliceBudgetMs(): number {
    const hidden = typeof document !== 'undefined' && document.hidden;
    return (hidden || this.uploadCurtain?.()) ? YIELD_BUDGET_CURTAINED_MS : YIELD_BUDGET_MS;
  }

  /**
   * Harvest every loaded room's batches into bucket descriptors. Water tiles
   * are collected here too (they need the live room graph), so once a room is
   * harvested nothing reads its graph objects again: `onRoomHarvested` lets
   * the host free that room immediately, spreading the graph release across
   * the bake instead of one end-of-bake avalanche. The bucket items keep only
   * shared-cache geometries and CPU instance arrays, both of which survive a
   * room release. The pick index (when present) copies each batch's instance
   * data here too, the last moment the graph is guaranteed alive.
   */
  async _harvest(cancelled: (() => boolean) | null, { onRoomHarvested = null, onProgress = null }: {
    onRoomHarvested?: ((roomId: number) => void) | null;
    onProgress?: ((detail: any) => void) | null;
  } = {}): Promise<MergedHarvest | null> {
    const world = this.world;
    const tileUnits = world.tileUnits;
    const cellUnits = CELL_TILES * tileUnits;
    const buckets = new Map<string, MergedBucketDef>();
    this._paletteIndex = new Map();
    this._paletteTuples = [];
    this._roomCells = new Map();
    this._cellRooms = new Map();
    this._internTuple([[1, 1, 1], [1, 1, 1], [0.5, 0.5, 0.5]]);   // index 0: neutral

    let zMin = Infinity;
    for (const room of world.rooms.values()) {
      for (const mesh of room.meshes) {
        const exact = mesh.userData.exact;
        if (!exact || exact.authoredEmpty) continue;
        zMin = Math.min(zMin, Number(exact.z) || 0);
      }
    }
    this._zBias = Number.isFinite(zMin) ? zMin : 0;

    let totalVertices = 0;
    let totalIndices = 0;
    let totalInstances = 0;
    const waterGroups = new Map<string, MergedWaterGroup>();
    const totalRooms = world.rooms.size;
    let harvestedRooms = 0;
    let sliceStart = performance.now();
    for (const room of world.rooms.values()) {
      // Bounded slices even at 451-room scale, and an abort seam per room.
      if (performance.now() - sliceStart > this._sliceBudgetMs()) {
        await yieldToBrowser();
        if (cancelled?.()) return null;
        sliceStart = performance.now();
      }
      const roomX = room.group.position.x;
      const roomY = room.group.position.y;
      const cellX = Math.floor(roomX / cellUnits);
      const cellY = Math.floor(roomY / cellUnits);
      this._roomCells.set(Number(room.id), { cellX, cellY });
      const cellRoomsKey = `${cellX},${cellY}`;
      const cellRooms = this._cellRooms.get(cellRoomsKey) || [];
      cellRooms.push(Number(room.id));
      this._cellRooms.set(cellRoomsKey, cellRooms);
      for (const mesh of room.meshes) {
        const exact = mesh.userData.exact;
        if (!exact || exact.authoredEmpty) continue;
        const geometry = mesh.geometry;
        if (!geometry?.attributes?.position || !geometry.index) continue;
        const classified = this.classifyBucket(exact, geometry);
        const key = this.bucketKeyFor(cellX, cellY, classified);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            key,
            cellX,
            cellY,
            materialToken: classified.materialToken,
            renderTexture: classified.renderTexture,
            flatCategory: classified.flatCategory,
            alpha: classified.alpha,
            tangent: classified.tangent,
            water: classified.water,
            items: [],
            vertices: 0,
            indices: 0,
          };
          buckets.set(key, bucket);
        }
        bucket.items!.push({
          geometry,
          count: mesh.count,
          instanceArray: mesh.instanceMatrix.array,
          roomX,
          roomY,
          metaZ: classified.metaZ,
          metaBits: classified.metaBits,
          palette: classified.hasRecolor
            ? this._internTuple(mergedPaletteTuple(exact.recolors, classified.fullTint))
            : 0,
        });
        if (this.pickIndex) {
          this.pickIndex.addBatch({
            geometry,
            count: mesh.count,
            instanceArray: mesh.instanceMatrix.array,
            roomX,
            roomY,
            exact,
            water: classified.water,
          });
        }
        const vertices = geometry.attributes.position.count * mesh.count;
        const indices = geometry.index.count * mesh.count;
        bucket.vertices += vertices;
        bucket.indices += indices;
        totalVertices += vertices;
        totalIndices += indices;
        totalInstances += mesh.count;
      }
      // Water tiles come off the live graph, so gather them before the room
      // can be released (deleting the visited entry mid-iteration is safe).
      for (const tile of collectRoomWaterTiles(world, room, this.waterRegistry)) {
        const key = `${cellX},${cellY}|${tile.texture}`;
        let group = waterGroups.get(key);
        if (!group) {
          group = { cellX, cellY, texture: tile.texture, tiles: [] };
          waterGroups.set(key, group);
        }
        group.tiles.push({
          ...tile,
          originX: roomX - cellX * cellUnits,
          originY: roomY - cellY * cellUnits,
        });
      }
      if (onRoomHarvested) {
        try { onRoomHarvested(room.id); } catch { /* host callback */ }
      }
      harvestedRooms++;
      if (onProgress) {
        try {
          onProgress({ phase: 'harvest', rooms: harvestedRooms, totalRooms });
        } catch { /* host callback */ }
      }
    }
    return {
      buckets: [...buckets.values()],
      paletteTuples: this._paletteTuples,
      waterGroups,
      totalVertices,
      totalIndices,
      totalInstances,
    };
  }

  /**
   * The main-thread bucket bake. DETERMINISM CONTRACT: bake-worker.ts is a
   * verbatim port of this loop (same operations, same order, same float
   * stores) and MUST be kept in lockstep: the smoke test byte-compares the
   * two paths. Only the yield cadence may differ (yields never change the
   * math).
   */
  async _bakeBucketArrays(
    bucket: MergedBucketDef,
    cellUnits: number,
    cancelled: (() => boolean) | null,
  ): Promise<BakeBucketArrays | null> {
    const vertexCount = bucket.vertices;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Int8Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const tangents = bucket.tangent ? new Int8Array(vertexCount * 4) : null;
    const metas = new Uint8Array(vertexCount * 2);
    const recolors = new Uint16Array(vertexCount);
    const indices = new Uint32Array(bucket.indices);
    const originX = bucket.cellX * cellUnits;
    const originY = bucket.cellY * cellUnits;

    const matrix = new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3();
    let vertexBase = 0;
    let indexBase = 0;
    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
    let sliceStart = performance.now();

    for (const item of bucket.items!) {
      const geometry = item.geometry;
      const sourcePositions = geometry.attributes.position.array;
      const sourceNormals = geometry.attributes.normal.array;
      const sourceUvs = geometry.attributes.uv.array;
      const sourceTangents = bucket.tangent ? geometry.attributes.tangent.array : null;
      const sourceIndex = geometry.index!.array;
      const vertsPerInstance = geometry.attributes.position.count;
      const indicesPerInstance = sourceIndex.length;
      for (let instance = 0; instance < item.count; instance++) {
        matrix.fromArray(item.instanceArray, instance * 16);
        const e = matrix.elements;
        const tx = e[12] + item.roomX;
        const ty = e[13] + item.roomY;
        const tz = e[14];
        normalMatrix.getNormalMatrix(matrix);
        const n = normalMatrix.elements;
        for (let v = 0; v < vertsPerInstance; v++) {
          const sx = sourcePositions[v * 3];
          const sy = sourcePositions[v * 3 + 1];
          const sz = sourcePositions[v * 3 + 2];
          const px = e[0] * sx + e[4] * sy + e[8] * sz + tx - originX;
          const py = e[1] * sx + e[5] * sy + e[9] * sz + ty - originY;
          const pz = e[2] * sx + e[6] * sy + e[10] * sz + tz;
          const at = (vertexBase + v) * 3;
          positions[at] = px; positions[at + 1] = py; positions[at + 2] = pz;
          if (px < minX) minX = px; if (px > maxX) maxX = px;
          if (py < minY) minY = py; if (py > maxY) maxY = py;
          if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;

          const nx0 = sourceNormals[v * 3];
          const ny0 = sourceNormals[v * 3 + 1];
          const nz0 = sourceNormals[v * 3 + 2];
          const nx = n[0] * nx0 + n[3] * ny0 + n[6] * nz0;
          const ny = n[1] * nx0 + n[4] * ny0 + n[7] * nz0;
          const nz = n[2] * nx0 + n[5] * ny0 + n[8] * nz0;
          // 1/sqrt normalization (Math.hypot is ~10x slower and this loop
          // runs per vertex, tens of millions of times per bake)
          const nLenSq = nx * nx + ny * ny + nz * nz;
          const nInv = nLenSq > 0 ? 127 / Math.sqrt(nLenSq) : 127;
          normals[at] = Math.round(nx * nInv);
          normals[at + 1] = Math.round(ny * nInv);
          normals[at + 2] = Math.round(nz * nInv);

          uvs[(vertexBase + v) * 2] = sourceUvs[v * 2];
          uvs[(vertexBase + v) * 2 + 1] = sourceUvs[v * 2 + 1];

          if (tangents) {
            const tx0 = sourceTangents![v * 4];
            const ty0 = sourceTangents![v * 4 + 1];
            const tz0 = sourceTangents![v * 4 + 2];
            const ax = e[0] * tx0 + e[4] * ty0 + e[8] * tz0;
            const ay = e[1] * tx0 + e[5] * ty0 + e[9] * tz0;
            const az = e[2] * tx0 + e[6] * ty0 + e[10] * tz0;
            const tLenSq = ax * ax + ay * ay + az * az;
            const tInv = tLenSq > 0 ? 127 / Math.sqrt(tLenSq) : 127;
            const ta = (vertexBase + v) * 4;
            tangents[ta] = Math.round(ax * tInv);
            tangents[ta + 1] = Math.round(ay * tInv);
            tangents[ta + 2] = Math.round(az * tInv);
            tangents[ta + 3] = Math.round((sourceTangents![v * 4 + 3] || 1) * 127);
          }
        }
        metas.fill(item.metaZ, vertexBase * 2, (vertexBase + vertsPerInstance) * 2);
        for (let v = 0; v < vertsPerInstance; v++) {
          metas[(vertexBase + v) * 2 + 1] = item.metaBits;
        }
        recolors.fill(item.palette, vertexBase, vertexBase + vertsPerInstance);

        // Winding is copied verbatim: a negative-determinant local matrix
        // flips screen winding identically in the per-room instanced path.
        for (let i = 0; i < indicesPerInstance; i++) {
          indices[indexBase + i] = vertexBase + sourceIndex[i];
        }
        vertexBase += vertsPerInstance;
        indexBase += indicesPerInstance;
        if (performance.now() - sliceStart > this._sliceBudgetMs()) {
          await yieldToBrowser();
          // Abort mid-bucket: a big cell must not keep baking megabytes of
          // vertex data after the view is gone.
          if (cancelled?.()) return null;
          sliceStart = performance.now();
        }
      }
    }

    return {
      positions, normals, uvs, tangents, metas, recolors, indices,
      bounds: Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ),
    };
  }

  /** Wrap baked bucket arrays (main-thread or worker) into the display geometry. */
  _assembleBucketGeometry(arrays: BakeBucketArrays): THREE.BufferGeometry {
    const { positions, normals, uvs, tangents, metas, recolors, indices, bounds } = arrays;
    const geometry = new THREE.BufferGeometry();
    const releasable: THREE.BufferAttribute[] = [];
    const attach = (name: string, attribute: THREE.BufferAttribute) => {
      releasable.push(attribute);
      geometry.setAttribute(name, attribute);
    };
    attach('position', new THREE.BufferAttribute(positions, 3));
    attach('normal', new THREE.BufferAttribute(normals, 3, true));
    attach('uv', new THREE.BufferAttribute(uvs, 2));
    if (tangents) attach('tangent', new THREE.BufferAttribute(tangents, 4, true));
    attach('brighterMeta', new THREE.BufferAttribute(metas, 2));
    attach('brighterRecolor', new THREE.BufferAttribute(recolors, 1));
    const index = new THREE.BufferAttribute(indices, 1);
    releasable.push(index);
    geometry.setIndex(index);
    // Free the CPU copies once uploaded: the merged world is static and
    // never raycast; holding the baked arrays in the JS heap serves no reader.
    for (const attribute of releasable) {
      attribute.onUpload(function release(this: any) { this.array = null; });
    }
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(bounds[0], bounds[1], bounds[2]),
      new THREE.Vector3(bounds[3], bounds[4], bounds[5]),
    );
    geometry.boundingSphere = new THREE.Sphere();
    geometry.boundingBox.getBoundingSphere(geometry.boundingSphere);
    return geometry;
  }

  async _bakeBucket(
    bucket: MergedBucketDef,
    cellUnits: number,
    cancelled: (() => boolean) | null,
  ): Promise<THREE.BufferGeometry | null> {
    const arrays = await this._bakeBucketArrays(bucket, cellUnits, cancelled);
    return arrays ? this._assembleBucketGeometry(arrays) : null;
  }

  /**
   * Lazy per-bake worker pool: min(cores-1, 8) workers (>=1), capped by the
   * bucket count. Spawned when a bake starts, terminated in build()'s finally
   * (and by dispose()). Spawn failure (no Worker, CSP, load error) returns
   * null and the bake stays on the main thread.
   */
  _ensureBakePool(maxSize: number): MergedBakePool | null {
    if (typeof Worker === 'undefined' || typeof navigator === 'undefined') return null;
    const cores = Number(navigator.hardwareConcurrency) || 4;
    const size = Math.max(1, Math.min(cores - 1, 8, maxSize));
    this._bakePool?.dispose();   // a superseded bake's pool: sweep it now
    this._bakePool = MergedBakePool.spawn(size);
    return this._bakePool;
  }

  // Drop pending entries whose CPU arrays onUpload already freed, restoring
  // their normal frustum culling. Behind the host's loading overlay
  // (uploadCurtain), uploaded cells go invisible until the build finishes so
  // pacing frames only draw the new cells (see the constructor doc).
  _pruneUploads(): void {
    const curtained = this.uploadCurtain?.() && this.building;
    this._pendingUploads = this._pendingUploads.filter((mesh) => {
      const geometry = mesh.geometry;
      const uploaded = !geometry.attributes.position.array
        && (!geometry.index || !geometry.index.array);
      if (uploaded) {
        mesh.frustumCulled = true;
        if (curtained) {
          mesh.visible = false;
          this._curtainedMeshes.push(mesh);
        }
      }
      return !uploaded;
    });
  }

  // Restore curtained cells to their normal visibility (water buckets honour
  // the curtain toggle; everything else is always visible).
  _uncurtainAll(): void {
    for (const mesh of this._curtainedMeshes) {
      mesh.visible = mesh.userData.mergedBucket?.water ? this._curtainsVisible : true;
    }
    this._curtainedMeshes = [];
  }

  // Bound the baked-but-not-yet-uploaded backlog: pending cells attach with
  // frustumCulled=false, so every REAL rendered frame uploads all of them and
  // onUpload frees their CPU arrays. Without this the bake outruns rendering
  // and every cell's arrays sit resident until an end-of-bake flush.
  async _drainUploads(cancelled: (() => boolean) | null, flush = false): Promise<void> {
    const target = flush ? 0 : MAX_PENDING_UPLOADS;
    this._pruneUploads();
    const deadline = performance.now() + 3000;   // safety valve, not a pace
    while (this._pendingUploads.length > target
        && this.renderer && !cancelled?.()
        && !(typeof document !== 'undefined' && document.hidden)
        && performance.now() < deadline) {
      const frame = this.renderer.info.render.frame;
      await nextFrameOrTimeout();
      if (this.renderer.info.render.frame !== frame) this._pruneUploads();
    }
    if (flush) {
      // Leftovers (hidden tab, curtains never drawn) keep their arrays until
      // first render (the pre-pacing behaviour) but cull normally again.
      for (const mesh of this._pendingUploads) mesh.frustumCulled = true;
      this._pendingUploads = [];
      this._uncurtainAll();
    }
  }

  /**
   * Create one bucket's display mesh (textures + material + depth material)
   * and attach it to the merged root, shared by build() and the session-edit
   * replaceBuckets(). Texture/parameter promises are the scene's caches, so
   * post-prefetch awaits resolve immediately.
   */
  async _createBucketMesh(bucket: MergedBucketDef, geometry: THREE.BufferGeometry): Promise<THREE.Mesh> {
    let textures: WorldTextureSet | null = null;
    if (bucket.renderTexture >= 0) {
      try {
        textures = await this.world.textureSet(bucket.renderTexture);
      } catch {
        textures = null;   // missing texture: falls back like the per-room path
      }
    }
    let parameterMap: THREE.Texture | null = null;
    if (bucket.renderTexture >= 0 && textures?.meta?.parameter != null) {
      try {
        parameterMap = await this.world.parameterMap(bucket.renderTexture);
      } catch {
        parameterMap = null;
      }
    }
    const cellUnits = CELL_TILES * this.world.tileUnits;
    const material = this._authoredMaterial(bucket, textures, parameterMap);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `merged-${bucket.key}`;
    mesh.position.set(bucket.cellX * cellUnits, bucket.cellY * cellUnits, 0);
    mesh.matrixAutoUpdate = false;   // static once placed at its cell origin
    mesh.updateMatrix();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = this._depthMaterial(bucket, textures);
    if (bucket.water) mesh.visible = this._curtainsVisible;
    mesh.userData.mergedBucket = { key: bucket.key, water: bucket.water };
    this.root.add(mesh);
    // Track output immediately so a cancelled build's meshes are still swept
    // by disposeMeshes (they used to orphan in this.root).
    this._buckets.push({ mesh, water: bucket.water });
    return mesh;
  }

  /** Build (or rebuild) the merged world from the currently loaded rooms. */
  async build({ onProgress = null, onRoomHarvested = null }: {
    onProgress?: ((detail: any) => void) | null;
    onRoomHarvested?: ((roomId: number) => void) | null;
  } = {}): Promise<MergedStats | null> {
    const generation = ++this._generation;
    this.disposeMeshes();
    this.pickIndex?.reset();
    this.building = true;
    this.ready = false;
    const cancelled = () => generation !== this._generation;
    const progress = (detail: any) => {
      if (!onProgress) return;
      try { onProgress(detail); } catch { /* host callback */ }
    };
    let bakePool: MergedBakePool | null = null;   // this bake's pool (see finally)
    try {
      this._syncRootTransform();
      this._ensureSharedTextures();

      // Every used texture has already been fetched by the per-room loads,
      // so these resolve from the scene's decode cache.
      const world = this.world;
      const textureIds = new Set<number>();
      for (const room of world.rooms.values()) {
        for (const mesh of room.meshes) {
          const exact = mesh.userData.exact;
          if (!exact || exact.authoredEmpty) continue;
          const id = Number(exact.renderTexture);
          if (Number.isFinite(id) && id >= 0) textureIds.add(id);
        }
      }
      const textureSets = new Map<number, WorldTextureSet>();
      let texturesDone = 0;
      for (const id of textureIds) {
        try {
          const set = await world.textureSet(id);
          textureSets.set(id, set);
        } catch {
          // Missing texture: those placements fall back per-room too.
        }
        if (cancelled()) return null;
        texturesDone++;
        if (!(texturesDone % 16) || texturesDone === textureIds.size) {
          progress({ phase: 'textures', textures: texturesDone, totalTextures: textureIds.size });
        }
      }

      const harvest = await this._harvest(cancelled, { onRoomHarvested, onProgress: progress });
      if (!harvest || cancelled()) {
        this.pickIndex?.reset();
        return null;
      }
      this.pickIndex?.finalize();
      this._paletteUniform.value?.dispose();
      this._paletteUniform.value = this._buildPalette(harvest.paletteTuples);

      const cellUnits = CELL_TILES * world.tileUnits;
      const meshes: THREE.Mesh[] = [];
      const totalBuckets = harvest.buckets.length;
      // Fan the per-bucket math across the worker pool. The main thread stays
      // the assembler: results attach strictly in bucket-index order (never
      // completion order), so the final scene arrays are order-identical to
      // the single-threaded path, and the GPU-upload drain below is
      // unchanged. No pool (bakeMode 'main' / spawn failure) or a worker
      // failing mid-bake falls back to the main-thread bake, per bucket.
      bakePool = this.bakeMode === 'main' || !totalBuckets
        ? null : this._ensureBakePool(totalBuckets);
      const pool = bakePool;
      this.lastBakeMode = pool ? 'worker' : 'main';
      const verify = pool && this.bakeVerify ? { buckets: 0, mismatches: 0 } : null;
      this.verifyResult = null;
      let bakedVertices = 0;
      let bakedBuckets = 0;
      const tickBucket = (bucket: MergedBucketDef) => {
        bakedBuckets++;
        bakedVertices += bucket.vertices;
        progress({
          phase: 'bake',
          vertices: bakedVertices,
          totalVertices: harvest.totalVertices,
          meshes: bakedBuckets,
          totalMeshes: totalBuckets,
        });
      };
      const jobs: Promise<BakeJobOutcome>[] = new Array(totalBuckets);
      let dispatched = 0;
      const bucketLoopT0 = performance.now();
      let mathWaitMs = 0;
      let drainWaitMs = 0;
      // Dispatch window: keeps every worker fed while bounding how many
      // finished-but-unattached result buffers sit in the heap at once (the
      // CPU-side analogue of MAX_PENDING_UPLOADS).
      const pump = (assembled: number) => {
        if (!pool) return;
        const ahead = pool.size * 2;
        while (dispatched < totalBuckets && dispatched - assembled < ahead) {
          const bucket = harvest.buckets[dispatched];
          jobs[dispatched] = pool.submit(bucket, cellUnits, generation, (outcome) => {
            // progress ticks as workers finish (any order, aggregate count);
            // failed buckets tick after their main-thread fallback instead
            if (outcome.ok && !cancelled()) tickBucket(bucket);
          });
          dispatched++;
        }
      };
      pump(0);
      for (let index = 0; index < totalBuckets; index++) {
        const bucket = harvest.buckets[index];
        let geometry: THREE.BufferGeometry | null = null;
        if (pool) {
          const mathT0 = performance.now();
          const outcome = await jobs[index];
          mathWaitMs += performance.now() - mathT0;
          pump(index + 1);   // refill the pool before assembling this result
          if (cancelled()) return null;
          if (outcome.ok && outcome.arrays) {
            if (verify) {
              // Determinism gate (smoke): re-bake this bucket on the main
              // thread and byte-compare every merged buffer.
              const reference = await this._bakeBucketArrays(bucket, cellUnits, cancelled);
              if (!reference || cancelled()) return null;
              verify.buckets++;
              if (!sameBakeArrays(outcome.arrays, reference)) verify.mismatches++;
            }
            geometry = this._assembleBucketGeometry(outcome.arrays);
          } else if (!outcome.cancelled) {
            geometry = await this._bakeBucket(bucket, cellUnits, cancelled);
            if (geometry && !cancelled()) tickBucket(bucket);
          }
        } else {
          geometry = await this._bakeBucket(bucket, cellUnits, cancelled);
          if (geometry && !cancelled()) tickBucket(bucket);
        }
        if (!geometry || cancelled()) {
          geometry?.dispose();
          return null;
        }
        const mesh = await this._createBucketMesh(bucket, geometry);
        if (cancelled()) return null;
        meshes.push(mesh);
        bucket.items = null;   // release harvest references early
        if (this.renderer && mesh.visible) {
          mesh.frustumCulled = false;   // guarantee the next real frame uploads it
          this._pendingUploads.push(mesh);
          if (this._pendingUploads.length > MAX_PENDING_UPLOADS) {
            const drainT0 = performance.now();
            await this._drainUploads(cancelled);
            drainWaitMs += performance.now() - drainT0;
            if (cancelled()) return null;
          }
        }
      }
      if (verify) this.verifyResult = verify;
      this.buildStats = {
        mode: this.lastBakeMode,
        bucketLoopMs: Math.round(performance.now() - bucketLoopT0),
        mathWaitMs: Math.round(mathWaitMs),
        drainWaitMs: Math.round(drainWaitMs),
      };

      await this._buildWaterSheets(cellUnits, cancelled, harvest.waterGroups, progress);
      if (cancelled()) return null;

      progress({ phase: 'upload' });
      await this._drainUploads(cancelled, true);
      if (cancelled()) return null;

      this.stats = {
        meshes: meshes.length,
        vertices: harvest.totalVertices,
        triangles: Math.floor(harvest.totalIndices / 3),
        instances: harvest.totalInstances,
        paletteTuples: harvest.paletteTuples.length,
        waterMeshes: meshes.filter((mesh) => mesh.userData.mergedBucket.water).length,
        waterSheets: this._sheetMeshes.length,
      };
      this.ready = true;
      return this.stats;
    } finally {
      // The pool lives for exactly one bake: completion, cancellation and
      // failure all land here. Guarded so a superseded build can never sweep
      // its successor's pool.
      if (bakePool) {
        bakePool.dispose();
        if (this._bakePool === bakePool) this._bakePool = null;
      }
      if (generation === this._generation) this.building = false;
    }
  }

  setVisible(visible: boolean): void {
    this.root.visible = !!visible;
  }

  /**
   * Session-edit cell re-bake: replace ONLY the named buckets. `defs` maps
   * bucket key -> descriptor {key, cellX, cellY, materialToken, renderTexture,
   * flatCategory, alpha, tangent, water, items} (or null to just remove the
   * bucket, e.g. every placement in it was deleted). Items carry raw
   * `recolors`/`fullTint`: palette slots are interned here against the
   * retained build-time palette so recolors keep their exact GPU tuples.
   * Reuses the same _bakeBucket machinery (yielded, bounded to the edited
   * texture within one cell) and the upload pacing from the main build.
   * Deliberately stays on the MAIN thread: a cell re-bake is small, and the
   * worker pool (torn down after each full bake) isn't worth respawning here.
   */
  async replaceBuckets(defs: Map<string, any> | null | undefined): Promise<number | null> {
    if (!this.ready || !defs?.size) return null;
    const generation = this._generation;
    const cancelled = () => generation !== this._generation;
    const cellUnits = CELL_TILES * this.world.tileUnits;
    const keys = new Set(defs.keys());
    const kept: { mesh: THREE.Mesh; water: boolean }[] = [];
    const removed: THREE.Mesh[] = [];
    for (const bucket of this._buckets) {
      if (keys.has(bucket.mesh.userData.mergedBucket?.key)) removed.push(bucket.mesh);
      else kept.push(bucket);
    }
    this._buckets = kept;
    this._pendingUploads = this._pendingUploads.filter((mesh) => !removed.includes(mesh));
    for (const mesh of removed) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    for (const def of defs.values()) {
      if (!def?.items?.length) continue;
      def.vertices = 0;
      def.indices = 0;
      for (const item of def.items) {
        item.palette = Array.isArray(item.recolors) && item.recolors.length
          ? this._internTuple(mergedPaletteTuple(item.recolors, item.fullTint))
          : 0;
        def.vertices += item.geometry.attributes.position.count * item.count;
        def.indices += item.geometry.index.count * item.count;
      }
      const geometry = await this._bakeBucket(def, cellUnits, cancelled);
      if (!geometry || cancelled()) {
        geometry?.dispose();
        return null;
      }
      const mesh = await this._createBucketMesh(def, geometry);
      if (cancelled()) return null;
      if (this.renderer && mesh.visible) {
        mesh.frustumCulled = false;   // next real frame uploads it
        this._pendingUploads.push(mesh);
      }
    }
    this.rebakes++;
    await this._drainUploads(cancelled, true);
    return this.rebakes;
  }

  /**
   * Flat animated water surfaces: one merged mesh per (cell, water texture).
   * Tiles were gathered at harvest time (the room graph may be gone by now).
   */
  async _buildWaterSheets(
    cellUnits: number,
    cancelled: (() => boolean) | null,
    groups: Map<string, MergedWaterGroup>,
    onProgress: ((detail: any) => void) | null = null,
  ): Promise<void> {
    let built = 0;
    let sliceStart = performance.now();
    for (const group of groups.values()) {
      if (performance.now() - sliceStart > this._sliceBudgetMs()) {
        await yieldToBrowser();
        if (cancelled?.()) return;
        sliceStart = performance.now();
      }
      const mesh = new THREE.Mesh(
        buildWaterSheetGeometry(group.tiles),
        waterSheetMaterialFor(group.texture, this.waterUniforms, this.sheetMaterialCache),
      );
      mesh.name = `merged-water-sheet-${group.cellX},${group.cellY}-t${group.texture}`;
      mesh.position.set(group.cellX * cellUnits, group.cellY * cellUnits, 0);
      mesh.matrixAutoUpdate = false;   // static once placed at its cell origin
      mesh.updateMatrix();
      mesh.visible = this._sheetsVisible;
      this.root.add(mesh);
      this._sheetMeshes.push(mesh);
      built++;
      if (onProgress) {
        try { onProgress({ phase: 'water', sheets: built, totalSheets: groups.size }); } catch { /* host */ }
      }
    }
  }

  _applySheetVisibility(): void {
    for (const mesh of this._sheetMeshes) {
      mesh.visible = this._sheetsVisible;
    }
  }

  setWaterSheetsVisible(visible: boolean): void {
    this._sheetsVisible = !!visible;
    this._applySheetVisibility();
  }

  /** The authored wave-curtain lattices; shown only when water is off. */
  setWaterCurtainsVisible(visible: boolean): void {
    this._curtainsVisible = !!visible;
    for (const bucket of this._buckets) {
      if (bucket.water) bucket.mesh.visible = this._curtainsVisible;
    }
  }

  /** Recompute the z-level mask from a per-level visibility predicate. */
  refreshZMask(isZVisible: (z: number) => boolean): void {
    let low = 0;
    let high = 0;
    for (let bit = 0; bit < 48; bit++) {
      if (!isZVisible(bit + this._zBias)) continue;
      if (bit < 24) low += 2 ** bit;
      else high += 2 ** (bit - 24);
    }
    this._visMask.value.x = low;
    this._visMask.value.y = high;
  }

  setCategoryVisible(category: string, visible: boolean): void {
    if (!(category in this._categoryVisible)) return;
    this._categoryVisible[category] = !!visible;
    let mask = 0;
    for (const [name, index] of Object.entries(META_CATEGORY_INDEX)) {
      if (this._categoryVisible[name]) mask += 2 ** index;
    }
    this._visMask.value.z = mask;
  }

  /** Distance (in tiles / three.js units) beyond which small props hide. */
  setSmallCullDistance(distance: number): void {
    this._cullDist.value = Number.isFinite(distance) && distance > 0
      ? distance
      : 1e9;
  }

  disposeMeshes(): void {
    this._pendingUploads = [];
    this._curtainedMeshes = [];
    for (const bucket of this._buckets) {
      bucket.mesh.removeFromParent();
      bucket.mesh.geometry.dispose();
    }
    this._buckets = [];
    for (const mesh of this._sheetMeshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    this._sheetMeshes = [];
    this.ready = false;
    this.stats = null;
  }

  dispose(): void {
    this._generation++;
    this._bakePool?.dispose();   // orphan a mid-bake pool before anything else
    this._bakePool = null;
    this.disposeMeshes();
    for (const material of this._materialCache.values()) material.dispose();
    for (const material of this._depthCache.values()) material.dispose();
    this._materialCache.clear();
    this._depthCache.clear();
    this._paletteUniform.value?.dispose();
    this._paletteUniform.value = null;
    this._blackParameterMap?.dispose();
    this._blackParameterMap = null;
    this.root.removeFromParent();
    this.building = false;
  }
}

export default MergedWorld;
