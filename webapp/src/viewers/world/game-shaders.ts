// The game's own programs, read from the user's shader bundles through the
// service worker and translated to GLSL (dxbc-glsl.ts), cached per
// (program, y convention); game-frame.ts draws them through game-gl.ts.
import { LAYER_VARYING, translate, type TranslatedProgram, type YConvention } from './dxbc-glsl.js';
import { TIE_DEPTH_STEP } from './draw-order.js';

/** The world index's render tables (see extract/world/render-data.ts). */
export interface GameRenderTables {
  programs: number[][];
  vertexShaders: number[][];
  pixelShaders: number[][];
  samplers: number[][];
  blends: number[][];
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
  /** A layered program (all rooms' joined parts): the texture registers read from a layer of an array. */
  layered?: number[];
}

/** The layered programs' layer: the attribute, its register and the pixel stage's flat varying (dxbc-glsl.ts). */
export const LAYER_ATTRIBUTE = 'a_layer';
export const LAYER_REGISTER = 14;
/** The textures a layered program reads from arrays: the material's own planes (the frame's are bound alone). */
const LAYERED_TEXTURES = new Set(['v_texture_albedo_plane', 'v_texture_normal_plane', 'v_texture_specular_plane', 'v_texture_recol_plane']);

/** A program's layered form: its material textures read from a layer of an array, the layer a per-vertex attribute
 *  passed to the pixel stage unchanged. Null where it cannot be (its inputs reach the layer's register, or it reads
 *  no material texture). */
function layeredProgram(plain: TranslatedProgram, retranslate: (layered: number[]) => TranslatedProgram): TranslatedProgram | null {
  if (plain.attributes.some((a) => a.register === LAYER_REGISTER)) return null;
  const textures = [...new Set(plain.samplers.filter((s) => s.stage === 'ps' && s.dim === '2d' && !s.comparison
    && LAYERED_TEXTURES.has(s.textureName)).map((s) => s.texture))];
  if (!textures.length) return null;
  const t = retranslate(textures);
  const vertex = t.vertex.split('\n');
  const version = vertex.findIndex((l) => l.startsWith('#version'));
  vertex.splice(version + 1, 0, `in float ${LAYER_ATTRIBUTE};`, `flat out float ${LAYER_VARYING};`);
  vertex.splice(vertex.lastIndexOf('}'), 0, `  ${LAYER_VARYING} = ${LAYER_ATTRIBUTE};`);
  const fragment = t.fragment.split('\n');
  const precision = fragment.findIndex((l) => l.startsWith('precision highp float'));
  fragment.splice(precision + 1, 0, `flat in float ${LAYER_VARYING};`);
  return {
    ...t, vertex: vertex.join('\n'), fragment: fragment.join('\n'),
    attributes: [...t.attributes, { name: LAYER_ATTRIBUTE, semantic: 'LAYER', semanticIndex: 0, register: LAYER_REGISTER, componentType: 'float', mask: 1 }],
  };
}

const pad5 = (n: number) => String(n).padStart(5, '0');

/** The room mask (all rooms): the attribute naming a vertex's room, its register, and the mask's sampler. */
export const ROOM_SLOT_ATTRIBUTE = 'a_room';
export const ROOM_SLOT_REGISTER = 15;
export const ROOM_MASK_UNIFORM = 'u_roomHide';
export const ROOM_MASK_WIDTH = 1024;

/** A program's vertex stage that leaves out the vertices of hidden rooms: a vertex whose room slot (from
 *  1) is marked in the mask (red > 0.5) lands outside the clip volume. Slot 0 (no slot: the attribute is
 *  not fed) is never hidden. Programs whose inputs or samplers reach the slot's register or the mask's unit
 *  are left as they are. */
function withRoomMask(t: TranslatedProgram): TranslatedProgram {
  if (t.attributes.some((a) => a.register === ROOM_SLOT_REGISTER) || t.samplers.length > 11) return t;
  const lines = t.vertex.split('\n');
  const version = lines.findIndex((l) => l.startsWith('#version'));
  lines.splice(version + 1, 0, `in float ${ROOM_SLOT_ATTRIBUTE};`, `uniform highp sampler2D ${ROOM_MASK_UNIFORM};`);
  const end = lines.lastIndexOf('}');
  lines.splice(end, 0,
    `  if (${ROOM_SLOT_ATTRIBUTE} > 0.5) {`,
    `    int roomSlot = int(${ROOM_SLOT_ATTRIBUTE} + 0.5);`,
    `    if (texelFetch(${ROOM_MASK_UNIFORM}, ivec2(roomSlot % ${ROOM_MASK_WIDTH}, roomSlot / ${ROOM_MASK_WIDTH}), 0).r > 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`,
    '  }');
  return {
    ...t, vertex: lines.join('\n'),
    attributes: [...t.attributes, { name: ROOM_SLOT_ATTRIBUTE, semantic: 'ROOMSLOT', semanticIndex: 0, register: ROOM_SLOT_REGISTER, componentType: 'float', mask: 1 }],
  };
}

/** Ties (draw-order.ts tieRanks): the attribute holding a vertex's tie rank and its register. */
export const TIE_ATTRIBUTE = 'a_tie';
export const TIE_REGISTER = 13;

/** A program's vertex stage that draws a part `a_tie` depth steps nearer (none where the attribute is not fed, which
 *  reads 0). `step`: one step in clip depth per unit of w (the depth range's own, doubled for -1..1). Programs whose
 *  inputs reach the register are left as they are. */
function withTies(t: TranslatedProgram, step: number): TranslatedProgram {
  if (t.attributes.some((a) => a.register === TIE_REGISTER)) return t;
  const lines = t.vertex.split('\n');
  const version = lines.findIndex((l) => l.startsWith('#version'));
  lines.splice(version + 1, 0, `in float ${TIE_ATTRIBUTE};`);
  lines.splice(lines.lastIndexOf('}'), 0, `  gl_Position.z -= ${TIE_ATTRIBUTE} * ${step.toExponential()} * gl_Position.w;`);
  return {
    ...t, vertex: lines.join('\n'),
    attributes: [...t.attributes, { name: TIE_ATTRIBUTE, semantic: 'TIE', semanticIndex: 0, register: TIE_REGISTER, componentType: 'float', mask: 1 }],
  };
}

export class GameShaderLibrary {
  private readonly blobs = new Map<string, Promise<Uint8Array>>();
  private readonly programs = new Map<string, Promise<GameProgram>>();

  /** `zeroToOne`: programs draw with EXT_clip_control's ZERO_TO_ONE depth range (the source's own).
   *  `roomMask`: every program leaves out the vertices of hidden rooms (withRoomMask). */
  constructor(private readonly url: (rel: string) => string, readonly tables: GameRenderTables,
    private readonly zeroToOne = false, readonly roomMask = false) {}

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

  program(index: number, y: YConvention = 'fragcoord', layered = false): Promise<GameProgram> {
    const key = `${index}:${y}${layered ? ':layered' : ''}`;
    let p = this.programs.get(key);
    if (!p) {
      p = this.build(index, y, layered);
      p.catch(() => this.programs.delete(key));
      this.programs.set(key, p);
    }
    return p;
  }

  private async build(index: number, y: YConvention, layered: boolean): Promise<GameProgram> {
    const row = this.tables.programs[index];
    if (!row) throw new Error(`no program ${index}`);
    const [vertex, pixel] = row;
    const [vs, ps] = await Promise.all([this.blob('vs', vertex), this.blob('ps', pixel)]);
    const options = { y, depth: this.zeroToOne ? 'zeroToOne' as const : 'negativeOneToOne' as const };
    const plain = translate(vs, ps, options);
    const layers = layered ? layeredProgram(plain, (textures) => translate(vs, ps, { ...options, layered: textures })) : null;
    if (layered && !layers) throw new Error(`program ${index} has no layered form`);
    const base = layers ?? plain;
    const translated = withTies(this.roomMask ? withRoomMask(base) : base, this.zeroToOne ? TIE_DEPTH_STEP : 2 * TIE_DEPTH_STEP);
    const samplers = (this.tables.pixelShaders[pixel] ?? []).map((s) => (s >= 0 ? this.tables.samplers[s] : null));
    return {
      index, vertex, pixel, y, translated,
      ...(layers ? { layered: [...new Set(layers.samplers.filter((s) => s.dim === '2darray').map((s) => s.texture))] } : {}),
      elements: this.tables.vertexShaders[vertex] ?? [],
      samplers,
    };
  }
}

/** Write float values into a constant buffer's words at a byte offset. */
export function putFloats(words: Uint32Array, byteOffset: number, values: ArrayLike<number>): void {
  const f = new Float32Array(words.buffer, words.byteOffset, words.length);
  const at = byteOffset >> 2;
  // A shader declares only the registers it reads: drop values past its buffer.
  for (let k = 0; k < values.length && at + k < f.length; k++) f[at + k] = values[k];
}
