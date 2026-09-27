// Satellite still fingerprints (src/satellite/fingerprint.ts) on synthetic
// render tables: the same inputs give the same digest; a build that numbers
// the same content differently (meshes, textures, materials, programs,
// shaders) gives the same digest too; any change the frame would draw
// differently (a placement, a tint, shader bytes, a blend, a texture's
// content or routing, a water style, the room's lighting, the still's
// settings) gives another.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-satellite-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({ stdin: { contents: "export * from './src/satellite/fingerprint.ts';", resolveDir: path.resolve(import.meta.dirname, '..') },
    bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error' });
  const { FrameInputs } = await import(pathToFileURL(file).href);
  let checks = 0;

  // One build's tables. Program 0 draws material 7; shaders by ordinal.
  const tables = (o: { vs?: number; ps?: number; blend?: number[]; mesh?: number; texture?: number; material?: string; program?: number } = {}) => {
    const vs = o.vs ?? 0, ps = o.ps ?? 0, program = o.program ?? 0;
    const programs: number[][] = [];
    programs[program] = [vs, ps, 3, 1, 0, 0];
    const vertexShaders: number[][] = []; vertexShaders[vs] = [1, 2, 3];
    const pixelShaders: number[][] = []; pixelShaders[ps] = [0];
    return {
      index: {
        coordinate_system: { tile_units: 1024 },
        textures: { [String(o.texture ?? 5)]: { albedo: 2, subs: [[64, 64, 38]] } },
        water: { level: 1024, styles: [{ colour: [0.2, 0.4, 0.4, 0.25], normal: o.texture ?? 5, cube: o.texture ?? 5, layers: [], waves: {}, level: 0 }] },
        render: {
          programs, vertexShaders, pixelShaders, samplers: [[21, 3, 3, 3, 1, 0, 15, 0, 1]], blends: [o.blend ?? [1, 5, 6, 1, 2, 6]],
          materials: { [o.material ?? '7']: { main: [[0, 0, 1, 1, 1, program]], depth: [[0, 0, program]], specular: 0, opacity: 1 } },
          environments: { 41: { sky: [0.8, 0.9, 0.9, 1], sun: [1, 0.9, 0.6, 1.5] } },
          lighting: { direction: [-1, -1, -1.4], gamma: 2.2, fade: 1 }, shadow: { size: 4096 }, camera: { fov: 40, near: 512, far: 102400 },
          ssao: { unit: 500, programs: { mips: [program], sao: program, blurH: program, blurV: program } }, vignette: { radius: 20480 }, clock: { ticksPerSecond: 600 },
          waterPrograms: { surface: [program], curtain: [program] },
        },
      },
      mesh: o.mesh ?? 3, texture: o.texture ?? 5, material: Number(o.material ?? 7), vs, ps,
    };
  };
  const shaderBytes = (stage: string, ordinal: number, vsBytes = [1, 2, 3], psBytes = [4, 5, 6]) =>
    Promise.resolve(new Uint8Array(stage === 'vs' ? vsBytes : psBytes));
  const matrix = (x: number) => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] });
  const source = (t: ReturnType<typeof tables>, o: { x?: number; tint?: number[]; water?: boolean; room?: number } = {}) => ({
    roomId: o.room ?? 41,
    bounds: { inner: [0, 0, 10, 10], outer: [0, 0, 10, 10], layers: 1 },
    grid: null,
    batches: [{ category: 'terrain', mesh: t.mesh, material: t.material, renderTexture: t.texture, payload: {}, matrices: [matrix(o.x ?? 0)],
      tints: [o.tint ?? [1, 1, 1, 1]], recolours: [null], order: [[0, 0, -1, 0, 0, 0, 0]],
      water: o.water ? { kind: 'surface', style: 0, opacity: 0.4, window: [0, 1] } : null }],
    actors: [], water: t.index.water, textureMeta: () => null, others: [],
    plane: [{ x: 0, y: 0, size: [1, 1], record: { material: t.material, texture: t.texture, colour: [1, 1, 1], repeat: 4, tint: true, alternate: null }, cell: [0, 0], tints: [], beyond: [], cover: 0 }],
  });
  const digest = async (t: ReturnType<typeof tables>, src: any, o: { meshHash?: string; imageHash?: string; vsBytes?: number[]; settings?: unknown } = {}) => {
    const inputs = new FrameInputs(t.index, { blob: (stage: string, n: number) => shaderBytes(stage, n, o.vsBytes) },
      (id: number) => (id === t.texture ? (o.imageHash ?? 'bbbb') : null));
    // the mesh as its payload: geometry plus the build's own ordinals
    for (const b of src.batches) b.payload = { i: t.mesh, skel: -1, positions: o.meshHash ?? 'aaaa', indices: 'AAAB' };
    return (await inputs.digest(src, o.settings ?? { code: 'c1', still: { pxPerTile: 32 } })).fingerprint;
  };

  const base = tables();
  const d0 = await digest(base, source(base));
  assert.match(d0, /^[0-9a-f]{64}$/); checks++;
  assert.equal(await digest(base, source(base)), d0, 'the same inputs, the same digest'); checks++;
  // another build numbering the same content: mesh, texture, material, program and shaders renumbered
  const renumbered = tables({ mesh: 90, texture: 77, material: '1200', program: 4, vs: 9, ps: 11 });
  assert.equal(await digest(renumbered, source(renumbered)), d0, 'renumbered content, the same digest'); checks++;
  // what the frame draws differently
  const differs = async (label: string, d: Promise<string>) => { assert.notEqual(await d, d0, label); checks++; };
  await differs('a placement moved', digest(base, source(base, { x: 1 })));
  await differs('a tint', digest(base, source(base, { tint: [1, 0.5, 1, 1] })));
  await differs('the mesh geometry', digest(base, source(base), { meshHash: 'aaab' }));
  await differs('the texture content', digest(base, source(base), { imageHash: 'bbbc' }));
  await differs('vertex shader bytes', digest(base, source(base), { vsBytes: [1, 2, 4] }));
  await differs('the blend state', digest(tables({ blend: [1, 5, 6, 1, 2, 5] }), source(tables({ blend: [1, 5, 6, 1, 2, 5] }))));
  await differs('water on the part', digest(base, source(base, { water: true })));
  await differs('another room (its lighting)', digest(base, source(base, { room: 42 })));
  await differs('the still settings', digest(base, source(base), { settings: { code: 'c1', still: { pxPerTile: 16 } } }));
  await differs('the drawing code', digest(base, source(base), { settings: { code: 'c2', still: { pxPerTile: 32 } } }));
  const routed = tables(); routed.index.textures['5'] = { albedo: 1, subs: [[64, 64, 38]] };
  await differs('the texture routing', digest(routed, source(routed)));
  const moved = tables(); (moved.index.render as any).shadow = { size: 4096, lightViewOffset: 999 };
  assert.equal(await digest(moved, source(moved)), d0, 'where the build stores a value is not the value'); checks++;
  const lit = tables(); lit.index.render.environments[41].sun = [1, 1, 1, 1];
  await differs('the room lighting', digest(lit, source(lit)));
  const styled = tables(); styled.index.water.styles[0].colour = [0, 0, 1, 1];
  await differs('a water style', digest(styled, source(styled, { water: true })).then(async (d) => (d === await digest(base, source(base, { water: true })) ? d0 : d)));
  console.log(`satellite fingerprints: ${checks} checks passed`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
