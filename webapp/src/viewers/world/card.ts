// A card picture: one subject posed, turned, framed and lit the way its card
// describes, drawn with the game's own programs (game-frame.ts) into a
// transparent image. The frame follows the game's card camera:
//
//   the subject is posed at the card's clip and time and turned by its yaw
//   (about its own origin, around z);
//   the focus is the subject's focus bone in that pose, turned with it (or
//   two thirds up its bounds when it has none); an object instead has its
//   own base matrix, which does not turn;
//   the eye sits at focus + Rz(roll) Rx(pitch) (offset + (0, distance, 0)),
//   looking along that frame's -y with z up;
//   the vertical field of view is the card's zoom, the picture 372 x 255
//   reference pixels, shifted by minus the card's pan (y down);
//   the sun comes from Rz(-turn) Rx(tilt) (0, 1, 0), with the card's own sky,
//   ground and sun colours.

import { THREE } from '../three-common.js';
import { GameFrame, type GameBatchSource, type GameRenderIndex } from './game-frame.js';
import { Rig, ClipSampler } from '../rig.js';
import { skinVertices } from '../../extract/world/idle-poses.js';
import { b64f32, b64u8 } from '../../store.js';

export const CARD_WIDTH = 372;
export const CARD_HEIGHT = 255;
export const ICON_SIZE = 320;

export interface CardPart {
  mesh: number;
  material: number;
  renderTexture: number;
  /** The two recolour tints (half range RGBA), or null for neutral. */
  recolours: number[][] | null;
  tint: number[] | null;
  /** The part's place in the subject (row-major 3x4), or none. */
  matrix?: number[] | null;
}

export interface CardSubject {
  parts: CardPart[];
  rig: number | null;
  /** The bone the card centres on (its posed position), or null. */
  focusBone: number | null;
  /** Subject bounds [min x, y, z, max x, y, z], the focus without a bone. */
  bounds: number[] | null;
  /** The card camera's distance term. */
  distance: number;
  /** Objects: the camera base itself (row-major 3x4), in place of a focus. */
  base?: number[] | null;
}

export interface CardView {
  yaw: number;
  pitch: number;
  roll: number;
  offset: [number, number, number];
  clip: number | null;
  timeMs: number;
  pan: [number, number];
  zoom: number;
  /** [r, g, b, intensity] each, colours as authored; null: the default daylight. */
  lights: { sky: number[]; ground: number[]; sun: number[] } | null;
  /** The light turn: [tilt, turn] in degrees. */
  lightTurn: [number, number];
  /** The second view (the square icon view: 320 x 320 reference pixels,
   *  its own pan and zoom), in place of the card view. */
  icon?: { pan: [number, number]; zoom: number } | null;
}

export interface CardSources {
  gl: WebGL2RenderingContext;
  url: (rel: string) => string;
  payload: (rel: string) => Promise<any>;
  render: GameRenderIndex;
  tileUnits: number;
  textureMeta: (id: number) => any;
}

export interface CardImage { width: number; height: number; rgba: Uint8Array }

const pad5 = (n: number) => String(n).padStart(5, '0');
const TEXTURE_FLUSH = 40;
const frames = new WeakMap<WebGL2RenderingContext, { frame: GameFrame; render: GameRenderIndex; count: number }>();
const rad = (d: number) => d * Math.PI / 180;

/** A payload, retried once: a missing pose must fail the card, not quietly
 *  draw it unposed. */
async function required(sources: CardSources, rel: string): Promise<any> {
  try { return await sources.payload(rel); } catch { return await sources.payload(rel); }
}

/** Row-major 3x4 skin matrices of a posed rig, and its bones' posed matrices. */
async function posedRig(sources: CardSources, rigId: number, clip: number | null, timeMs: number): Promise<{ palette: Float32Array; bones: THREE.Matrix4[] }> {
  const skeleton = await required(sources, `rigs/${pad5(rigId)}.json`);
  if (!skeleton?.bones?.length) throw new Error(`card: rig ${rigId} has no bones`);
  const rig = new Rig(skeleton);
  if (clip !== null && clip >= 0) {
    const json = await required(sources, `anims/${pad5(clip)}.json`);
    if (!json?.bones) throw new Error(`card: clip ${clip} missing`);
    new ClipSampler(json).apply(rig, timeMs);
  }
  for (const root of rig.roots) root.updateMatrixWorld(true);
  const palette = new Float32Array(rig.bones.length * 12);
  const skin = new THREE.Matrix4();
  rig.bones.forEach((bone, i) => {
    skin.multiplyMatrices(bone.matrixWorld, rig.boneInverses[i]);
    const e = skin.elements, o = i * 12;
    palette.set([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]], o);
  });
  return { palette, bones: rig.bones.map((b) => b.matrixWorld.clone()) };
}

/** A copy of a mesh payload with its streams skinned into the pose. */
function posedPayload(payload: any, palette: Float32Array | null, rig: number | null): any {
  if (!palette || !payload?.skinned || !payload.bone_indices || !payload.bone_weights) return payload;
  if (rig !== null && Number(payload.skel) !== rig) return payload;
  const positions = b64f32(payload.positions).slice();
  const normals = b64f32(payload.normals).slice();
  const tangents = payload.tangents ? b64f32(payload.tangents).slice() : null;
  const index = b64u8(payload.bone_indices);
  const bytes = b64u8(payload.bone_weights);
  const weights = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) weights[i] = bytes[i] / 255;
  skinVertices(palette, index, weights, positions, normals, tangents);
  return { ...payload, positions, normals, tangents };
}

/** The eye, target and pixel shift of a card's camera. */
export function cardCamera(view: CardView, focus: number[], distance: number, width: number, height: number, base: number[] | null = null) {
  // camera to scene: offset, then pitch, then roll, then the base (a focus
  // translation, or an object's own base matrix)
  const b = base
    ? new THREE.Matrix4().set(base[0], base[1], base[2], base[3], base[4], base[5], base[6], base[7], base[8], base[9], base[10], base[11], 0, 0, 0, 1)
    : new THREE.Matrix4().makeTranslation(focus[0], focus[1], focus[2]);
  const r = b.clone().multiply(new THREE.Matrix4().makeRotationZ(rad(view.roll))).multiply(new THREE.Matrix4().makeRotationX(rad(view.pitch)));
  const eye = new THREE.Vector3(view.offset[0], view.offset[1] + distance, view.offset[2]).applyMatrix4(r);
  const forward = new THREE.Vector3(0, -1, 0).transformDirection(r);
  const up = new THREE.Vector3(0, 0, 1).transformDirection(r);
  const target = eye.clone().addScaledVector(forward, 1000);
  const pan = view.icon ? view.icon.pan : view.pan;
  const refW = view.icon ? ICON_SIZE : CARD_WIDTH, refH = view.icon ? ICON_SIZE : CARD_HEIGHT;
  const shift: [number, number] = [-pan[0] * width / refW, -pan[1] * height / refH];
  return { eye, target, up, shift };
}

const partMatrix = (turn: THREE.Matrix4, m: number[] | null): THREE.Matrix4 => m
  ? turn.clone().multiply(new THREE.Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1))
  : turn.clone();

/** The sun direction (towards the scene) of a card's light turn. */
export function cardLightDirection(lightTurn: [number, number]): number[] {
  const m = new THREE.Matrix4().makeRotationZ(rad(-lightTurn[1])).multiply(new THREE.Matrix4().makeRotationX(rad(lightTurn[0])));
  const p = new THREE.Vector3(0, 1, 0).applyMatrix4(m);
  return [-p.x, -p.y, -p.z];
}

/** Draw a card picture at `scale` times the reference size. Rows top first. */
export async function renderCard(sources: CardSources, subject: CardSubject, view: CardView, scale = 1): Promise<CardImage> {
  const width = Math.round((view.icon ? ICON_SIZE : CARD_WIDTH) * scale), height = Math.round((view.icon ? ICON_SIZE : CARD_HEIGHT) * scale);
  const pose = subject.rig !== null ? await posedRig(sources, subject.rig, view.clip, view.timeMs) : null;
  let focus = [0, 0, 0];
  if (pose && subject.focusBone !== null && pose.bones[subject.focusBone]) {
    const e = pose.bones[subject.focusBone].elements;
    focus = [e[12], e[13], e[14]];
  } else if (subject.bounds) focus = [0, 0, 2 * (subject.bounds[5] - subject.bounds[2]) / 3];

  const turn = new THREE.Matrix4().makeRotationZ(rad(view.yaw));
  focus = new THREE.Vector3(focus[0], focus[1], focus[2]).applyMatrix4(turn).toArray();
  const batches: GameBatchSource[] = [];
  for (const part of subject.parts) {
    const payload = await required(sources, `meshes/${pad5(part.mesh)}.json`);
    if (!payload) throw new Error(`card: mesh ${part.mesh} missing`);
    batches.push({
      category: 'spawns', mesh: part.mesh, material: part.material, renderTexture: part.renderTexture,
      payload: posedPayload(payload, pose?.palette ?? null, subject.rig), matrices: [partMatrix(turn, part.matrix ?? null)],
      tints: [part.tint], recolours: [part.recolours], water: null,
    });
  }
  // One frame per context: programs are built once, each card's geometry is
  // freed after its read back, and cached textures are dropped now and then.
  let shared = frames.get(sources.gl);
  if (!shared || shared.render !== sources.render) {
    shared = { frame: new GameFrame(sources.gl, sources.url, sources.render, sources.tileUnits), render: sources.render, count: 0 };
    frames.set(sources.gl, shared);
  }
  const frame = shared.frame;
  if (++shared.count % TEXTURE_FLUSH === 0) frame.releaseTextures();
  await frame.setRoom({
    roomId: -1,
    bounds: { inner: [-2, -2, 2, 2], outer: [-2, -2, 2, 2], layers: 1 },
    grid: null, batches, water: null, textureMeta: sources.textureMeta,
  });
  // Without lights of its own a card keeps the frame's default daylight.
  frame.environmentOverride = (view.lights ?? {}) as GameRenderIndex['environments'][string];
  const camera = cardCamera(view, focus, subject.distance, width, height, subject.base ?? null);
  frame.card = { direction: cardLightDirection(view.lightTurn), shift: camera.shift };
  frame.resetTemporal();
  frame.render({ eye: camera.eye, target: camera.target, up: camera.up, fov: view.icon ? view.icon.zoom : view.zoom, width, height }, 0, 0, true);
  const out = frame.readMain();
  frame.releaseRoom();
  if (!out) throw new Error('card: no frame');
  return { width: out.width, height: out.height, rgba: out.data };
}
