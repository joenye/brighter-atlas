// DXBC decoding and GLSL translation (src/viewers/world/dxbc.ts and
// dxbc-glsl.ts) against synthetic shaders (tools/dxbc-fixtures.ts): container,
// reflection and signatures, the decoded instruction stream against the
// compiler's own disassembly, and the translated GLSL's bindings, linkage,
// conventions and bit-exact constants. Synthetic data only.
//
//   node tools/test_dxbc.ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { FIXTURES } from './dxbc-fixtures.ts';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-dxbc-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({
    stdin: {
      contents: "export * from './src/viewers/world/dxbc.ts'; export * as G from './src/viewers/world/dxbc-glsl.ts';",
      resolveDir: path.resolve(import.meta.dirname, '..'),
    },
    bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'warning',
  });
  const D = await import(pathToFileURL(file).href);
  let checks = 0;
  const ok = (c: unknown, m: string) => { assert(c, m); checks++; };
  const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
  const vsBytes = bytes(FIXTURES.vertex.dxbc), psBytes = bytes(FIXTURES.pixel.dxbc);
  const vs = D.parseDxbc(vsBytes), ps = D.parseDxbc(psBytes);

  // ---- Container, signatures and reflection.
  ok(vs.stage === 'vertex' && vs.major === 4 && vs.minor === 0, 'vertex shader model 4.0');
  ok(ps.stage === 'pixel' && ps.major === 4 && ps.minor === 0, 'pixel shader model 4.0');
  assert.throws(() => D.parseDxbc(new Uint8Array(64)), /not a DXBC container/); checks++;
  const sig = (els: any[]) => els.map((e) => `${e.name}${e.index}:${e.register}:${e.mask}:${e.componentType}:${e.systemValue}`).join(' ');
  assert.equal(sig(vs.inputs), 'FIELD_A0:0:7:3:0 FIELD_B0:1:15:3:0 FIELD_C0:2:3:3:0 FIELD_D0:3:15:1:0 FIELD_E0:4:15:3:0 SV_VertexID0:5:1:1:6'); checks++;
  assert.equal(sig(vs.outputs), 'VARYING_A0:0:7:3:0 VARYING_B0:1:3:3:0 VARYING_C0:2:3:1:0 VARYING_D0:3:3:3:0 VARYING_E0:4:15:3:0 SV_POSITION0:5:15:3:1'); checks++;
  // Targets and depth carry no system value in the raw signature (the name says it).
  assert.equal(sig(ps.outputs), 'SV_Target0:0:15:3:0 SV_Target1:1:15:3:0 SV_Depth0:4294967295:1:3:0'); checks++;
  const vcb = vs.reflection.constantBuffers[0];
  assert.deepEqual(vcb.variables.map((v: any) => [v.name, v.parent, v.offset, v.size]),
    [['v_world_view_projection', 'v_cbo', 0, 64], ['v_misc', 'v_cbo', 64, 16], ['v_table', 'v_cbo', 80, 64]]); checks++;
  const bindings = ps.reflection.bindings.map((b: any) => `${b.name}:${b.type}:${b.bindPoint}`).join(' ');
  assert.equal(bindings, 'albedoSampler:3:0 skySampler:3:1 shadowSampler:3:2 albedo:2:0 sky:2:1 shadow:2:2 lookup:2:3 cb0:0:0'); checks++;
  ok(ps.decls.samplers.find((s: any) => s.slot === 2)?.mode === 1, 'comparison sampler declaration');
  ok(ps.decls.resources.find((r: any) => r.slot === 1)?.dimension === D.RESOURCE_DIM.TEXTURECUBE, 'cube resource');
  ok(ps.decls.resources.find((r: any) => r.slot === 3)?.returnType.join() === '4,4,4,4', 'uint resource');
  ok(vs.decls.resources[0].dimension === D.RESOURCE_DIM.BUFFER, 'buffer resource');
  ok(ps.decls.constantBuffers[0].dynamic && ps.decls.constantBuffers[0].size === 10, 'dynamically indexed constant buffer');
  ok(ps.decls.immediateConstantBuffer?.length === 16, 'immediate constant buffer');
  const interp = ps.decls.inputs.map((d: any) => d.interpolation).join();
  assert.equal(interp, '2,2,1,4,2,4'); checks++;

  // ---- Instruction stream against the compiler's disassembly.
  assert.deepEqual(vs.instructions.map((i: any) => D.mnemonic(i)), FIXTURES.vertex.mnemonics); checks++;
  assert.deepEqual(ps.instructions.map((i: any) => D.mnemonic(i)), FIXTURES.pixel.mnemonics); checks++;
  const lines = D.disassemble(ps);
  ok(lines.includes('sample_c r1.y, v1.xyxx, t2.xxxx, s2, v4.w'), 'sample_c operands');
  ok(lines.includes('mad r2.z, icb[r2.x + 0].x, cb0[r2.x + 2].x, r1.w'), 'relative indices');
  ok(lines.includes('mad r1.yzw, r1.wwww, l(0.000000, 0.000000, 0.000000, 2.000000), -r1.yyzw'), 'negated source, immediate vector');
  ok(lines.includes('mad_sat oDepth, v5.z, l(0.500000), l(0.250000)'), 'saturate, depth output');
  ok(D.disassemble(vs).includes('udiv null, o2.y, r0.x, l(5)'), 'two destinations with null');

  // ---- Translation of the pair (default: drawing into the canvas).
  const t = D.G.translate(vsBytes, psBytes);
  ok(t.y === 'fragcoord' && t.targetHeightUniform === 'u_targetHeight', 'canvas convention reads the target height');
  assert.deepEqual(t.attributes.map((a: any) => `${a.name}:${a.semantic}:${a.componentType}`),
    ['a0:FIELD_A:float', 'a1:FIELD_B:float', 'a2:FIELD_C:float', 'a3:FIELD_D:uint', 'a4:FIELD_E:float']); checks++;
  ok(t.vertex.includes('in uvec4 a3;') && t.vertex.includes('v3 = a3;'), 'integer attribute keeps its bits');
  ok(t.vertex.includes('v5 = uvec4(uint(gl_VertexID), 0u, 0u, 0u);'), 'vertex id');
  ok(t.vertex.includes('gl_Position = vec4(p.x, p.y, 2.0 * p.z - p.w, p.w);'), 'clip z from 0..w to -w..w');
  ok(t.vertex.includes('flat out uvec4 vr2;') && t.fragment.includes('flat in uvec4 vr2;'), 'constant interpolation is flat bits');
  ok(t.vertex.includes('vr3 = F(o3) * p.w;') && t.fragment.includes('v3 = U(vr3 * gl_FragCoord.w);'), 'noperspective emulation');
  ok(t.fragment.includes('v5 = U(vec4(gl_FragCoord.x, u_targetHeight - gl_FragCoord.y, gl_FragCoord.z, 1.0 / gl_FragCoord.w));'), 'position input with a top-left origin');
  ok(t.fragment.includes('(-dFdy('), 'deriv_rty negated for the canvas convention');
  assert.deepEqual(t.samplers.map((s: any) => `${s.uniform}:${s.textureName}:${s.samplerName}:${s.dim}:${s.comparison}:${s.returnType}`),
    ['b0_vs:palette::buffer:false:float', 's0_0_ps:albedo:albedoSampler:2d:false:float', 's1_1_ps:sky:skySampler:cube:false:float',
      'c2_2_ps:shadow:shadowSampler:2d:true:float', 't3_ps:lookup::2d:false:uint']); checks++;
  ok(t.vertex.includes('uniform highp sampler2D b0_vs;') && t.vertex.includes('uniform int u_width_b0_vs;'), 'buffer as a data texture');
  ok(t.vertex.includes('texelFetch(b0_vs, ivec2((int(r0.x)) % u_width_b0_vs, (int(r0.x)) / u_width_b0_vs), 0)'), 'buffer element addressing');
  ok(t.fragment.includes('uniform highp sampler2DShadow c2_2_ps;') && t.fragment.includes('texture(c2_2_ps, vec3(F(v1.xy), F(v4.w)))'), 'comparison lookup');
  ok(t.fragment.includes('textureLod(c2_2_ps, vec3(F(r1.zw), F(v4.z)), 0.0)'), 'comparison lookup at level zero');
  ok(t.fragment.includes('texelFetch(t3_ps, ivec2(r5.xz), int(r5.w))'), 'texel fetch with mip');
  ok(t.fragment.includes('texture(s0_0_ps, F(r1.xy), F(cb0_ps[1].x))'), 'lookup with bias');
  ok(t.fragment.includes('textureGrad(s0_0_ps, F(v1.xy), F(r1.yz), F(r2.xz))'), 'lookup with gradients');
  ok(t.fragment.includes('cb0_ps[(int(r2.x) + 2)]') && t.fragment.includes('icb[int(r2.x)]'), 'relative constant reads');
  ok(t.fragment.includes('while (true) {') && t.fragment.includes('if (r2.z != 0u) break;'), 'loop with a conditional break');
  ok(t.fragment.includes('if (r0.w != 0u) discard;'), 'discard');
  ok(/r2\.x = U\(sin\(t0\.x\)\);\s*r3\.x = U\(cos\(t0\.x\)\);/.test(t.fragment), 'sincos reads its source once');
  ok(t.fragment.includes('layout(location = 1) out vec4 frag1;') && t.fragment.includes('gl_FragDepth = F(oDepth);'), 'targets and depth');
  assert.deepEqual(t.outputs.map((o: any) => o.location), [0, 1]); checks++;
  assert.deepEqual(t.constantBuffers.ps[0].variables.map((v: any) => [v.name, v.offset]), [['v_light', 0], ['v_params', 16], ['v_table', 32]]); checks++;
  ok(t.notes.length === 0, 'no approximations needed: ' + t.notes.join('; '));

  // ---- Offscreen convention: clip y flipped, position and derivatives unchanged.
  const c = D.G.translate(vs, ps, { y: 'clip' });
  ok(c.vertex.includes('gl_Position = vec4(p.x, -p.y, 2.0 * p.z - p.w, p.w);'), 'clip convention flips y');
  ok(c.targetHeightUniform === null && c.fragment.includes('v5 = U(vec4(gl_FragCoord.xy, gl_FragCoord.z, 1.0 / gl_FragCoord.w));'), 'clip convention position');
  ok(!c.fragment.includes('(-dFdy(') && c.fragment.includes('dFdy('), 'clip convention derivative');
  // ---- Zero-to-one clip depth (EXT_clip_control): z passes through.
  const z = D.G.translate(vs, ps, { y: 'clip', depth: 'zeroToOne' });
  ok(z.vertex.includes('gl_Position = vec4(p.x, -p.y, p.z, p.w);'), 'zero-to-one depth keeps clip z');

  // ---- Constants are emitted from their raw bits: every immediate of a float
  // instruction appears as its exact pattern and reads back as the HLSL value.
  const f32 = (bits: number) => new Float32Array(new Uint32Array([bits]).buffer)[0];
  for (const [src, program] of [[t.vertex, vs], [t.fragment, ps]] as const) {
    for (const ins of program.instructions) {
      for (const o of ins.operands) {
        if (o.type !== D.OPERAND.IMMEDIATE32) continue;
        for (const v of o.values) {
          if (v === 0) continue;
          const pattern = `0x${(v >>> 0).toString(16)}u`;
          const asInt = String(v | 0);
          ok(src.includes(pattern) || src.includes(asInt), `immediate ${pattern} kept`);
        }
      }
    }
  }
  ok(t.vertex.includes('0x40002010u') && Math.abs(f32(0x40002010) - 2.001957) < 1e-6, 'unpack scale bits');
  ok(t.fragment.includes('0x3ee8ba2fu') && Math.abs(f32(0x3ee8ba2f) - 1 / 2.2) < 1e-7, 'gamma exponent bits');

  // ---- Standalone stages (validation partners).
  const vOnly = D.G.translate(vsBytes, null);
  ok(vOnly.fragment.includes('frag0 = vec4(0.0);') && vOnly.vertex.includes('out vec4 vr4;'), 'vertex stage alone');
  const pOnly = D.G.translate(null, psBytes);
  ok(pOnly.vertex.includes('flat out uvec4 vr2;') && pOnly.vertex.includes('vr2 = uvec4(0u);'), 'pixel stage alone');
  assert.throws(() => D.G.translate(psBytes, null), /expected a vertex shader/); checks++;

  // ---- Bundle framing: u8 count, then u32le size + container per blob.
  const framed = new Uint8Array(1 + 4 + psBytes.length);
  framed[0] = 1;
  new DataView(framed.buffer).setUint32(1, psBytes.length, true);
  framed.set(psBytes, 5);
  ok(D.shaderBlobs(framed).length === 1 && D.shaderBlobs(framed)[0].length === psBytes.length, 'shader object framing');

  console.log(`dxbc: ${checks} container, decode, translation and constant checks passed`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
