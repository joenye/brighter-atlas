// What a satellite still is made of, as one digest: every input the game's
// frame draws a room from, with the build's own numbering (mesh, texture,
// material, program and shader ordinals) replaced by the content it names.
// Two stills with the same fingerprint are the same picture, whichever build
// they come from; any change that can alter a pixel changes it:
//
//   - the frame source: placements (matrices), tints and recolours, draw
//     order, actors' resting poses, the floor's pieces, the room's bounds and
//     colour grid, for the room and each neighbour, at its offset;
//   - meshes by their decoded payloads (the geometry the frame uploads; the
//     game re-exports many meshes each build with other bytes that draw the
//     same), textures by their content hashes, with the texture routing;
//   - materials with their programs resolved: vertex and pixel shader bytes,
//     vertex formats, sampler and blend descriptions, depth and cull state;
//   - water styles (their textures resolved), the room's lighting preset, the
//     frame's lighting, shadow, occlusion, camera, vignette and clock data;
//   - the still's own settings and the code that draws it (the caller's key).
import type { GameRoomSource } from '../viewers/world/game-frame.js';
import type { GameShaderLibrary } from '../viewers/world/game-shaders.js';

const HEX = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return HEX(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/** Content keys for one build's numbering (cached for the build). */
export class FrameInputs {
  private readonly programs = new Map<number, Promise<string>>();
  private readonly materials = new Map<number, Promise<string>>();
  private readonly shaders = new Map<string, Promise<string>>();
  private readonly payloads = new WeakMap<object, Promise<string>>();
  private global: Promise<string> | null = null;

  constructor(
    private readonly index: any,
    private readonly library: GameShaderLibrary,
    private readonly imageHash: (id: number) => string | null,
  ) {}

  private get render() { return this.index.render; }

  /** A mesh by what the frame draws of it: its payload without the build's
   *  ordinals (its own and its rig's; the rig's pose is in the actor's palette). */
  mesh(payload: any): Promise<string> {
    if (!payload || typeof payload !== 'object') return Promise.resolve(String(payload));
    let p = this.payloads.get(payload);
    if (!p) {
      const { i: _i, skel: _skel, f: _f, h: _h, ...geometry } = payload;
      p = sha256(JSON.stringify(geometry)).then((h) => `g${h.slice(0, 32)}`);
      this.payloads.set(payload, p);
    }
    return p;
  }

  texture(id: number): string {
    if (!(id >= 0)) return String(id);
    const h = this.imageHash(id);
    if (!h) throw new Error(`texture ${id} has no content hash`);
    return `t${h}:${JSON.stringify(this.index.textures?.[String(id)] ?? null)}`;
  }

  private shader(stage: 'vs' | 'ps', ordinal: number): Promise<string> {
    const key = `${stage}${ordinal}`;
    let p = this.shaders.get(key);
    if (!p) { p = this.library.blob(stage, ordinal).then(sha256); this.shaders.set(key, p); }
    return p;
  }

  program(index: number): Promise<string> {
    let p = this.programs.get(index);
    if (!p) {
      p = (async () => {
        const row = this.render.programs[index];
        if (!row) return 'none';
        const [vs, ps, compare, write, blend, cull, ...rest] = row;
        const samplers = (this.render.pixelShaders[ps] ?? []).map((s: number) => (s >= 0 ? this.render.samplers[s] : null));
        return sha256(JSON.stringify([await this.shader('vs', vs), await this.shader('ps', ps), this.render.vertexShaders[vs] ?? [], samplers,
          compare, write, blend >= 0 ? this.render.blends[blend] : null, cull, rest]));
      })();
      this.programs.set(index, p);
    }
    return p;
  }

  material(id: number): Promise<string> {
    let p = this.materials.get(id);
    if (!p) {
      p = (async () => {
        const m = this.render.materials[String(id)];
        if (!m) return 'none';
        // main rows end with their program, depth rows hold it third
        const main = await Promise.all((m.main ?? []).map(async (k: number[]) => [...k.slice(0, -1), await this.program(k[k.length - 1])]));
        const depth = await Promise.all((m.depth ?? []).map(async (k: number[]) => [...k.slice(0, 2), await this.program(k[2]), ...k.slice(3)]));
        const lit = m.lit ? await Promise.all(m.lit.map(async (k: number[]) => [...k.slice(0, -1), await this.program(k[k.length - 1])])) : null;
        const { main: _m, depth: _d, lit: _l, ...other } = m;
        return sha256(JSON.stringify(lit ? [main, depth, other, lit] : [main, depth, other]));
      })();
      this.materials.set(id, p);
    }
    return p;
  }

  private waterStyle(style: number): unknown {
    const s = this.index.water?.styles?.[style];
    return s ? { ...s, normal: this.texture(s.normal), cube: this.texture(s.cube) } : null;
  }

  /** The build-wide frame data every still depends on. */
  frame(): Promise<string> {
    if (!this.global) {
      this.global = (async () => {
        const r = this.render;
        const ssao = r.ssao ? { ...r.ssao, programs: {
          mips: await Promise.all(r.ssao.programs.mips.map((i: number) => this.program(i))),
          sao: await this.program(r.ssao.programs.sao), blurH: await this.program(r.ssao.programs.blurH), blurV: await this.program(r.ssao.programs.blurV),
        } } : null;
        const water = r.waterPrograms ? Object.fromEntries(await Promise.all(Object.entries(r.waterPrograms)
          .map(async ([k, list]) => [k, await Promise.all((list as number[]).map((i) => this.program(i)))]))) : null;
        // what the frame reads, never where the build stores it (file offsets)
        const { lightViewOffset: _offset, ...shadow } = r.shadow ?? {};
        return sha256(JSON.stringify({ lighting: r.lighting, shadow, ssao, camera: r.camera, vignette: r.vignette, clock: r.clock,
          waterPrograms: water, waterLevel: this.index.water?.level ?? null, units: this.index.coordinate_system ?? null }));
      })();
    }
    return this.global;
  }

  /** The digest of one still: its frame source, the room's lighting preset,
   *  the build-wide frame data and the caller's settings (code key included),
   *  with a digest per part (to tell what changed between two builds). */
  async digest(source: GameRoomSource, settings: unknown): Promise<{ fingerprint: string; parts: Record<string, string> }> {
    const materials = new Set<number>();
    const note = (m: any) => { if (Number.isFinite(Number(m))) materials.add(Number(m)); };
    for (const scene of [source, ...(source.others ?? [])]) {
      for (const b of scene.batches) note(b.material);
      for (const a of scene.actors ?? []) note(a.material);
    }
    for (const t of source.plane ?? []) note(t.record.material);
    const keys = new Map<number, string>();
    await Promise.all([...materials].map(async (m) => keys.set(m, await this.material(m))));
    const meshes = new Map<object, string>();
    for (const scene of [source, ...(source.others ?? [])]) {
      for (const x of [...scene.batches, ...(scene.actors ?? [])]) if (x.payload && !meshes.has(x.payload)) meshes.set(x.payload, await this.mesh(x.payload));
    }
    const meshOf = (x: { payload: any }) => meshes.get(x.payload) ?? String(x.payload);
    const batch = (b: GameRoomSource['batches'][number]) => ({
      category: b.category, mesh: meshOf(b), material: keys.get(b.material), texture: this.texture(b.renderTexture),
      matrices: b.matrices.map((m) => Array.from(m.elements)), tints: b.tints, recolours: b.recolours ?? null, order: b.order ?? null,
      water: b.water ? { ...b.water, style: this.waterStyle(b.water.style) } : null,
    });
    const actor = (a: NonNullable<GameRoomSource['actors']>[number]) => ({
      mesh: meshOf(a), material: keys.get(a.material), texture: this.texture(a.renderTexture), bones: a.bones,
      tint: a.tint, recolours: a.recolours, palette: Array.from(a.palette() ?? []),
    });
    const scene = (s: { batches: GameRoomSource['batches']; actors?: GameRoomSource['actors']; lights?: GameRoomSource['lights'] }) => ({
      batches: s.batches.map(batch), actors: (s.actors ?? []).map(actor), ...(s.lights?.length ? { lights: s.lights } : {}),
    });
    const inputs: Record<string, unknown> = {
      settings, frame: await this.frame(),
      environment: this.render.environments?.[String(source.roomId)] ?? null,
      bounds: source.bounds, grid: source.grid ?? null, room: scene(source),
      others: (source.others ?? []).map((o) => scene(o)),
      plane: (source.plane ?? []).map((t) => ({ ...t, record: { ...t.record, material: keys.get(t.record.material), texture: this.texture(t.record.texture) } })),
    };
    // the room and its neighbours by field too, to tell which input changed
    const fields = (scenes: any[], prefix: string) => {
      const out: Record<string, unknown> = {};
      for (const f of ['mesh', 'material', 'texture', 'matrices', 'tints', 'recolours', 'order', 'water']) {
        out[`${prefix}.${f}`] = scenes.map((sc) => sc.batches.map((b: any) => b[f]));
      }
      out[`${prefix}.actors`] = scenes.map((sc) => sc.actors);
      return out;
    };
    const room = inputs.room as any, others = inputs.others as any[];
    const all = { ...inputs, ...fields([room], 'room'), ...fields(others, 'others') };
    const parts: Record<string, string> = {};
    for (const [name, value] of Object.entries(all)) parts[name] = (await sha256(JSON.stringify(value))).slice(0, 16);
    // the fingerprint covers the whole parts only (the fields are their breakdown)
    const whole = Object.fromEntries(Object.keys(inputs).map((k) => [k, parts[k]]));
    return { fingerprint: await sha256(JSON.stringify(whole)), parts };
  }
}
