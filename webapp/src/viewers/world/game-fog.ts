// The game's volumetric fog (07-Oct-2026 on): a height fog ray-marched over
// the half-resolution depth, blurred along x then y with a depth-aware
// weight, smoothed along depth edges and laid over the frame premultiplied.
// The game asks the room for its fog each frame. The rooms that have one
// build it from a live amount (an event's progress and what is happening in
// the room), which a viewer cannot know: the viewer draws it at full amount,
// as a player sees it while the event haunts the room. These are the
// settings the game builds at full amount, and the march pass's constants
// from them: the fog lies on the room's ground over the room's fog area, its
// noise anchored to the map, lit by the sun and by the room's point lights.

import { THREE } from '../three-common.js';

const f32 = Math.fround;

/** The game's fog settings at full amount (lengths in native units, seconds). */
export const FOG = {
  density: 1 / 614.4,
  base: 0,
  thickness: 71.68,
  falloffAbove: 102.4,
  falloffBelow: 51.2,
  opacity: 1,
  colour: [234 / 255, 225 / 255, 1] as [number, number, number],
  phase: 0.3,
  noiseScale: 358.4,
  noiseStrength: 0.8,
  tendrils: 0.4,
  wind: [-400, -250] as [number, number],
  edge: 512,
  edgeNoise: 768,
  inset: 1536,
  edgeDetail: 1024,
  edgeNoiseScale: 3072,
  edgeWidth: 1024,
  edgeTendrils: 0.7,
  edgeDrop: 1280,
  wake: [819.2, 5120, 0.4, 1] as [number, number, number, number],
  lightSamples: 1,
  steps: 24,
  maxDistance: 40000,
};

/** What the march needs from the frame. */
export interface FogFrame {
  /** The half-resolution target (unpadded size), its pad and focal length in pixels. */
  w: number; h: number; pad: number; focal: number;
  near: number; far: number;
  /** Camera space (x right, y down, z forward) to the native frame. */
  viewToWorld: THREE.Matrix4;
  eye: THREE.Vector3;
  /** The room's fog area (native x0, y0, x1, y1) and the ground the fog lies on. */
  area: [number, number, number, number];
  ground: number;
  /** The clock in seconds, and the noise's anchor: minus the room's place on the map (native xy). */
  seconds: number;
  focus: [number, number];
  /** The frame's vignette: ellipse (cx, cy, 1/hx, 1/hy), colour, outer ratio, height fade (z0, scale, floor). */
  ellipse: number[]; vignette: number[]; reach: number; fade: [number, number, number];
  /** The point light grid (origin x, y, cells per unit) and strength, or null for a room without lights. */
  lights: [number, number, number, number] | null;
  /** The shadow map's transform (world to (u, v, depth)), rows. */
  shadow: number[];
  /** The sun: direction (native, not normalised) and authored colour. */
  sunDirection: number[]; sunColour: number[];
}

const wrap256 = (x: number) => { const m = x % 256; return m < 0 ? m + 256 : m; };

/** The march pass's constants (36 float4s, the layout of the fog programs' cb0). */
export function fogMarchConstants(fr: FogFrame): number[] {
  const S = FOG;
  const b = S.base + fr.ground;
  const zMin = b - S.edgeDrop - 4.6 * S.falloffBelow;
  const zMax = b + S.thickness + 4.6 * S.falloffAbove;
  const margin = (S.edgeNoise + S.edgeDetail) / 2 + S.edge;
  const [x0, y0, x1, y1] = fr.area;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2, hy = (y1 - y0) / 2;
  const inset = Math.min(Math.max(S.inset, 0), Math.min(hx, hy));
  const v = [-S.wind[0] * fr.seconds - fr.focus[0], -S.wind[1] * fr.seconds - fr.focus[1]];
  const wl = Math.hypot(S.wind[0], S.wind[1]);
  const wd = [S.wind[0] / wl, S.wind[1] / wl];
  const along = v[0] * wd[0] + v[1] * wd[1], across = -v[0] * wd[1] + v[1] * wd[0];
  const sun = new THREE.Vector3(fr.sunDirection[0], fr.sunDirection[1], fr.sunDirection[2]).normalize();
  const m = fr.viewToWorld.elements;
  const row = (r: number) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const pow = (c: number) => f32(Math.pow(c, 2.2));
  const n = fr.near, f = fr.far;
  return [
    fr.focal, fr.focal, -fr.w / 2, -fr.h / 2,                                         // 0 projection info
    f32(n * f), f32(n - f), f, S.maxDistance,                                         // 1 depth parameters
    fr.pad, fr.pad, fr.w, fr.h,                                                       // 2 depth texel offset
    ...row(0), ...row(1), ...row(2), ...row(3),                                       // 3-6 view to world
    fr.eye.x, fr.eye.y, fr.eye.z, 0,                                                  // 7 camera
    S.density, b, 1 / Math.max(S.falloffAbove, 1), 1 / Math.max(S.falloffBelow, 1),   // 8 fog shape
    S.thickness, S.opacity, S.noiseStrength, 1 / S.noiseScale,                        // 9 fog layer
    x0 - margin, y0 - margin, zMin, 1 / (S.edge + S.edgeWidth),                       // 10 march box min
    x1 + margin, y1 + margin, zMax, S.steps / Math.max(zMax - b, 1),                  // 11 march box max
    wrap256(v[0] / S.noiseScale), wrap256(v[1] / S.noiseScale),
    wrap256(v[0] / S.edgeNoiseScale), wrap256(v[1] / S.edgeNoiseScale),               // 12 noise offset
    cx, cy, hx - inset, hy - inset,                                                   // 13 footprint
    inset, S.edgeNoise, S.edgeDetail, 1 / S.edgeNoiseScale,                           // 14 edge shape
    S.edgeWidth, Math.min(Math.max(S.edgeTendrils, 0), 1), S.edgeDrop, Math.min(Math.max(S.tendrils, 0), 1), // 15 edge detail
    wd[0], wd[1], wrap256(along / S.noiseScale * 0.25), wrap256(across / S.noiseScale * 1.25),               // 16 tendril frame
    pow(S.colour[0]), pow(S.colour[1]), pow(S.colour[2]), 0.5,                        // 17 fog colour
    sun.x, sun.y, sun.z, Math.min(Math.max(S.phase, -0.99), 0.99),                     // 18 light direction
    f32(pow(fr.sunColour[0]) * 1.5), f32(pow(fr.sunColour[1]) * 1.5), f32(pow(fr.sunColour[2]) * 1.5), 0, // 19 light colour
    ...fr.ellipse,                                                                    // 20 vignette ellipse
    fr.vignette[0], fr.vignette[1], fr.vignette[2], Math.max(fr.reach, 1.0001),        // 21 vignette colour
    fr.fade[0], fr.fade[1], fr.fade[2], fr.fade[2] !== 1 ? 1 : 0,                     // 22 vignette chasm
    0, 0, 0, 0,                                                                       // 23 wake box: no wake
    ...S.wake,                                                                        // 24 wake shape
    ...(fr.lights ?? [0, 0, 0, 0]),                                                   // 25 point lights in the fog
    S.lightSamples, 0, S.steps, 0,                                                    // 26 light samples, steps
    0, fr.ground, 0, 1,                                                               // 27 haze: none
    0, fr.ground, 0, 1,                                                               // 28 global haze: none
    ...fr.shadow,                                                                     // 29-32 shadow matrix
    0, 0, 0, 0,                                                                       // 33 terrain box: none
    0, 0, 0, 0,                                                                       // 34 terrain shape
    0, 0, 1, 1 / Math.max(S.thickness / 4, 1),                                        // 35 terrain fall
  ];
}
