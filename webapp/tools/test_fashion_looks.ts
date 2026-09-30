// Brighter Fashion's looks on a synthetic wardrobe: a look's code (item numbers, a variant's place, dye numbers)
// round-trips; what the data does not know drops out and the rest stays; and the order pieces go on (an `early`
// torso piece before the cape) decides which one hides the other.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'atlas-fashion-looks-'));
try {
  const file = path.join(tmp, 'test.mjs');
  await build({ stdin: { contents: "export * from './src/fashion/look-code.ts'; export * from './src/fashion/compose.ts';", resolveDir: path.resolve(import.meta.dirname, '..') },
    bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'error' });
  const L = await import(pathToFileURL(file).href);
  (globalThis as any).atob ??= (s: string) => Buffer.from(s, 'base64').toString('binary');
  (globalThis as any).btoa ??= (s: string) => Buffer.from(s, 'binary').toString('base64');
  let checks = 0;
  const ok = (c: unknown, what: string) => { assert.ok(c, what); checks++; };

  // a wardrobe: a part per body slot bit, a torso piece that also claims the cape's bit (12), a cape, a helmet in
  // six tiers, a two-colour cosmetic, two dyes
  const part = (slot: number, mesh: number | null) => ({ slot, mesh, mat: null, material: null, r1: null, r2: null, pass: 0 });
  const parts: Record<number, any> = { 1: part(4, 11), 2: part(12, 12), 3: part(0, 13), 4: part(0, 14), 5: part(4, 15) };
  const worn = (o: any) => ({ parts: [], mask: [0, 0], ...o });
  const pack = (early: boolean) => ({
    creator: { styles: Object.fromEntries(['hair', 'face', 'jaw', 'torso', 'legs', 'feet'].map((k) => [k, { male: [{ parts: [] }], female: [{ parts: [] }] }])),
      hands: { male: [], female: [] }, palettes: Object.fromEntries(['hair', 'fabric', 'eyes', 'torso', 'legs', 'feet', 'skin', 'lips'].map((k) => [k, ['#808080']])) },
    parts,
    worn: { 100: worn({ cls: 'torso', pos: 2, parts: [1, 2], mask: [4096 | 16, 0], ...(early ? { early: true } : {}) }), 101: worn({ cls: 'cape', pos: 6, parts: [2], mask: [4096, 0] }),
      102: worn({ cls: 'head', pos: 4, parts: [3], mask: [1, 0] }), 103: worn({ cls: 'head', pos: 4, parts: [4], mask: [1, 0] }), 104: worn({ cls: 'torso', pos: 2, parts: [5], mask: [16, 0] }) },
    held: {},
    items: [
      { id: 10, kind: 'cosmetic', slot: 'torso', name: 'Hoodie', variants: [{ name: 'Hoodie', male: { worn: 100 }, female: { worn: 100 } }] },
      { id: 9000100, kind: 'cape', slot: 'cape', name: 'Cape', variants: [{ grade: null, male: { worn: 101 }, female: { worn: 101 } }] },
      { id: 500, kind: 'armour', slot: 'head', name: 'Helm', variants: ['Basic', 'Moderate', 'Fine', 'Sturdy', 'Excellent', 'Perfect'].map((g) => ({ grade: g, colourable: true, male: { worn: 102 }, female: { worn: 102 } })) },
      { id: 501, kind: 'cosmetic', slot: 'head', name: 'Hat', variants: [{ name: 'Red Hat', male: { worn: 103 }, female: { worn: 103 } }, { name: 'Blue Hat', male: { worn: 103 }, female: { worn: 103 } }] },
      { id: 12, kind: 'armour', slot: 'torso', name: 'Shirt', variants: [{ grade: 'Basic', male: { worn: 104 }, female: { worn: 104 } }] },
    ],
    dyes: [{ id: 71, colour: '#aa0000', name: 'Red' }, { id: 70, colour: '#00aa00', name: 'Green' }],
    defaultColour: 71,
  });
  const P = pack(false), I = L.makeIndex(P), known = (i: number) => I.items.has(i);
  const look = (equip: any) => ({ ...structuredClone(L.DEFAULT_LOOK), gender: 'female', equip });
  const code = (e: any) => Buffer.from(JSON.stringify({ g: 1, s: [7, 0, 8, 9, 1, 1], c: [0, 12, 2, 25, 20, 5], e })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // a look in, the same look out: [item, the variant's place, dye]
  const st = look({ head: { item: 500, variant: 4, colour: 70 }, cape: { item: 9000100, variant: 0, colour: null } });
  assert.deepEqual(L.decodeLook(L.encodeLook(st), known), st); checks++;
  ok(L.encodeLook(st) === code({ head: [500, 4, 70], cape: [9000100, 0, 0] }), 'the code is the one links have always carried');
  assert.deepEqual(L.decodeLook(code({ head: [501, 1, 0] }), known)!.equip.head, { item: 501, variant: 1, colour: null }); checks++;
  // what the data no longer has drops out (an item gone, an unknown number), the rest stays
  const partial = L.decodeLook(code({ head: [502, 0, 0], torso: [999, 0, 0], cape: [9000100, 0, 0] }), known)!;
  assert.deepEqual(Object.keys(partial.equip), ['cape']); checks++;
  ok(L.decodeLook('not a look', known) === null, 'not a look: nothing');

  // the order pieces go on: a cape before the torso hides a torso piece that claims its bit; an early one goes on
  // first and hides the cape (and, with a hat on, claims nothing of the head here: its mask has no head bit)
  const both = look({ torso: { item: 10, variant: 0, colour: null }, cape: { item: 9000100, variant: 0, colour: null } });
  assert.deepEqual([...L.hiddenItems(P, I, both)], [['torso', ['cape']]]); checks++;
  const E = pack(true);
  assert.deepEqual([...L.hiddenItems(E, L.makeIndex(E), both)], [['cape', ['torso']]]); checks++;
  const keys = L.compose(E, L.makeIndex(E), both).map((p: any) => p.key);
  ok(keys.some((k: string) => k.endsWith('/w100')) && !keys.some((k: string) => k.endsWith('/w101')), 'the early piece draws, the cape does not');

  console.log(`fashion looks: ${checks} checks passed`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
