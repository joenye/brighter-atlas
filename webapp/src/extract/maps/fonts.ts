// Fonts use shared glyph tables and image banks. The metadata callback reads
// font UV tables only; it never needs room occupancy or room meshes.
import {makeRegistryRowDecoder} from '../world/effects.js';
import {resolveValue} from '../world/room-metadata.js';
import {PoolDecoder, type PoolNode} from '../world/value-pool.js';
import type {FillRow} from '../world/replay.js';
import type {WorldProfile} from '../world/profile.js';
import type {GlyphImage} from '../image.js';

export interface MapFontGlyph {
  glyph: number;
  text: string;
  slot: number;
  variants: (number | null)[];
  visible: boolean;
  metrics: number[];
  auxiliary1: number[] | null;
  auxiliary2: number[] | null;
  bitmap?: {
    ab3: number; record: number; face: number; atlasOwner: number;
    color: boolean; width: number; height: number; em: number;
    storageRotation: number; correctionDegrees: number;
    rect: [number, number, number, number];
  };
}
export interface MapFont {
  slot: number;
  faces: number[];
  sizeRange: [number, number];
  ascent: number;
  descent: number;
  lineHeight: number;
  glyphs: MapFontGlyph[];
}
export interface MapFontSheet {width: number; height: number; rgba: Uint8Array}
export interface MapFontRequest {slot: number; glyphs: Iterable<number>}
export interface MapFontAtlasSchema {selector: number; uvTablesField: number}

export async function extractMapFonts(
  rows: FillRow[], pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile,
  charset: ArrayLike<string>, requests: Record<string, MapFontRequest>, atlasSchema: MapFontAtlasSchema,
  readFontTable: (id: number) => Promise<Uint8Array>,
  readGlyphBank: (id: number) => Promise<GlyphImage[]>,
): Promise<{fonts: Record<string, MapFont>; sheet: MapFontSheet}> {
  const decode = makeRegistryRowDecoder(rows, bytes, profile);
  const resolve = (n: PoolNode | undefined): PoolNode => {
    const v = resolveValue(pool, n);
    if (!v) throw Error('invalid font value');
    return v;
  };
  const fields = (slot: number): PoolNode[] => {
    const ops = decode(slot);
    if (!ops) throw Error(`invalid font record ${slot}`);
    return ops.flatMap(op => op.kind === 'G' ? [resolve(op.node)] : []);
  };
  const list = (n: PoolNode, tag: number): PoolNode[] | null => {
    if (n.tag !== 32 || !n.values) return null;
    const values = n.values.map(resolve);
    return values.every(v => v.tag === tag) ? values : null;
  };
  const one = <T>(items: T[], what: string): T => {
    if (items.length !== 1) throw Error(`ambiguous or missing ${what}`);
    return items[0];
  };
  const faceList = (f: PoolNode[], what: string): number[] =>
    one(f.flatMap(n => {const refs = list(n, 2); return refs?.length ? [refs.map(r => r.value as number)] : [];}), what);
  const glyphMetrics = new Map<number, {metrics: PoolNode; key: number[]}>();
  const glyphRecord = (slot: number) => {
    if (!glyphMetrics.has(slot)) {
      const f = fields(slot);
      const metrics = one(f.filter(n => n.tag === 0x72), 'glyph metrics');
      const key = one(f.filter(n => n.tag === 0x7d), 'glyph key').value;
      if (metrics.raw0?.length !== 52 || !Array.isArray(key) || key.length !== 2) throw Error('invalid glyph record');
      glyphMetrics.set(slot, {metrics, key});
    }
    return glyphMetrics.get(slot)!;
  };
  const fonts: Record<string, MapFont> = {};
  for (const [name, request] of Object.entries(requests)) {
    const f = fields(request.slot);
    const table = one(f.filter(n => n.tag === 0x7e), 'font glyph lookup');
    if (!table.lookup || !table.range) throw Error('missing font lookup payload');
    const faces = faceList(f, 'font faces');
    const dimensions = f.slice(f.indexOf(table) + 1, f.indexOf(table) + 4);
    if (dimensions.length !== 3 || dimensions.some(n => n.tag !== 11 || !Number.isFinite(n.value?.[0]))) throw Error('invalid font dimensions');
    const glyphs = [...new Set(request.glyphs)].filter(g => g !== 10).map(glyph => {
      const variants = table.lookup![glyph], slot = variants?.[0];
      if (!Number.isInteger(glyph) || slot === undefined || slot === null || !rows[slot]) throw Error(`missing default glyph ${glyph}`);
      const {metrics: m, key} = glyphRecord(slot);
      if (key[0] !== glyph || key[1] !== 0) throw Error('glyph lookup disagrees with its key');
      const raw = m.raw0!, view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const metrics = Array.from({length: 13}, (_, i) => view.getFloat32(i * 4, false));
      if (!metrics.every(Number.isFinite) || typeof charset[glyph] !== 'string') throw Error('invalid glyph metrics or character');
      return {glyph, text: charset[glyph], slot, variants: [...variants], visible: m.value !== 0, metrics,
        auxiliary1: m.f0 ? Array.from(m.raw1!) : null,
        auxiliary2: m.f1 ? Array.from(m.raw2!) : null};
    });
    fonts[name] = {slot: request.slot, faces, sizeRange: [...table.range],
      ascent: dimensions[0].value[0], descent: dimensions[1].value[0], lineHeight: dimensions[2].value[0], glyphs};
  }

  const wantedFaces = new Set(Object.values(fonts).flatMap(font => font.faces));
  const atlases = rows.filter(row => row.selector === atlasSchema.selector).flatMap(row => {
    const f = fields(row.slot);
    const faces = faceList(f, 'atlas faces');
    if (!faces.some(face => wantedFaces.has(face))) return [];
    const images = one(f.flatMap(n => {const refs = list(n, 0x33); return refs ? [refs.map(n => n.value as [number, number])] : [];}), 'atlas glyph images');
    const packing = one(f.filter(n => n.tag === 36), 'font atlas layout');
    const tableRefs = list(resolve(packing.fields?.[atlasSchema.uvTablesField]), 0x13);
    if (!tableRefs?.length) throw Error('missing font UV tables');
    const tables = tableRefs.map(n => n.value as number);
    return [{slot: row.slot, faces, images, tables}];
  }).sort((a, b) => a.faces.length - b.faces.length);

  const sources = new Map<number, {image: [number, number]; face: number; atlas: number}>();
  const rotated = new Map<number, boolean>();
  const arities = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [+k, v]));
  // The callbacks may use bundle slab readers, so every read is sequential.
  for (const atlas of atlases) {
    let imageIndex = 0;
    const slots: number[] = [];
    for (const face of atlas.faces) {
      const maps = rows[face]?.m;
      if (maps?.length !== 1) throw Error('invalid font face map');
      for (const entry of maps[0][1]) {
        const slot = entry.value;
        slots.push(slot);
        if (!glyphRecord(slot).metrics.value) continue;
        const image = atlas.images[imageIndex++], previous = sources.get(slot);
        if (!image || (previous && previous.image.join() !== image.join())) throw Error('font atlas image disagreement');
        sources.set(slot, {image, face, atlas: previous?.atlas ?? atlas.slot});
      }
    }
    if (imageIndex !== atlas.images.length) throw Error('font atlas image count differs');
    for (const id of atlas.tables) {
      const data = await readFontTable(id);
      const reader = new PoolDecoder(data, arities(profile.class_fields), arities(profile.tag6_fields));
      const count = reader.varint();
      if (count > data.length) throw Error('invalid font UV pool count');
      const localPool = Array.from({length: count}, () => reader.value());
      const local = (n: PoolNode) => {
        const v = resolveValue(localPool, n);
        if (!v) throw Error('invalid font UV reference');
        return v;
      };
      const root = local(reader.value());
      if (reader.pos !== data.length || root.tag !== 32 || root.values?.length !== slots.length) throw Error('font UV count differs');
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      root.values.forEach((value, index) => {
        const node = local(value);
        if (node.tag !== 36 || node.fields?.length !== 2) throw Error('invalid font UV entry');
        const page = local(node.fields[0]), rectangle = local(node.fields[1]);
        if (page.tag !== 10 || !Number.isInteger(page.value)) throw Error('invalid font UV page');
        if (page.value < 0) return;
        if (rectangle.tag !== 0x3c) throw Error('invalid font UV rectangle');
        const uv = Array.from({length: 4}, (_, i) => view.getFloat32(rectangle.start + 1 + i * 4, true));
        if (!uv.every(v => Number.isFinite(v) && v >= 0 && v <= 1) || uv[1] >= uv[3] || uv[0] === uv[2]) throw Error('invalid font UV extent');
        const rotation = uv[0] > uv[2], previous = rotated.get(slots[index]);
        if (previous !== undefined && previous !== rotation) throw Error('font atlas rotation disagreement');
        rotated.set(slots[index], rotation);
      });
    }
  }

  const banks = new Map<number, Map<number, GlyphImage>>(), sprites = new Map<number, GlyphImage>();
  for (const font of Object.values(fonts)) for (const glyph of font.glyphs) {
    if (!glyph.visible) continue;
    const source = sources.get(glyph.slot), rotation = rotated.get(glyph.slot);
    if (!source || rotation === undefined) throw Error(`missing glyph image or orientation ${glyph.slot}`);
    const [id, record] = source.image;
    if (!banks.has(id)) banks.set(id, new Map((await readGlyphBank(id)).map(g => [g.e, g])));
    let bitmap = banks.get(id)!.get(record);
    if (!bitmap || ![1,4].includes(bitmap.channels)) throw Error('missing glyph bitmap');
    const em = bitmap.channels === 4 ? 64 : 50;
    const correction = bitmap.channels === 1 && !rotation ? 90 : bitmap.channels === 4 && rotation ? -90 : 0;
    if (correction) {
      const {w, h, channels, pixels} = bitmap;
      const output = new Uint8Array(pixels.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const src = (y * w + x) * channels;
        const dst = (correction > 0 ? x * h + h - 1 - y : (w - 1 - x) * h + y) * channels;
        output.set(pixels.subarray(src, src + channels), dst);
      }
      bitmap = {...bitmap, w: h, h: w, pixels: output};
    }
    if (bitmap.channels === 1 && (bitmap.w !== Math.round(glyph.metrics[2] * em + 2)
      || bitmap.h !== Math.round((glyph.metrics[0] + glyph.metrics[1]) * em + 2))) throw Error('glyph dimensions disagree with metrics');
    glyph.bitmap = {ab3: id, record, face: source.face, atlasOwner: source.atlas,
      color: bitmap.channels === 4, width: bitmap.w, height: bitmap.h, em,
      storageRotation: rotation ? 90 : 0, correctionDegrees: correction, rect: [0,0,bitmap.w,bitmap.h]};
    sprites.set(glyph.slot, bitmap);
  }
  const width = 512, rects = new Map<number, [number, number, number, number]>();
  let x = 0, y = 0, rowHeight = 0;
  for (const [slot, bitmap] of sprites) {
    if (bitmap.w > width) throw Error('glyph exceeds sheet width');
    if (x + bitmap.w > width) {x = 0; y += rowHeight + 2; rowHeight = 0;}
    rects.set(slot, [x,y,bitmap.w,bitmap.h]); x += bitmap.w + 2; rowHeight = Math.max(rowHeight, bitmap.h);
  }
  const height = Math.max(1, y + rowHeight), rgba = new Uint8Array(width * height * 4);
  for (const [slot, bitmap] of sprites) {
    const [left, top] = rects.get(slot)!;
    for (let y = 0; y < bitmap.h; y++) for (let x = 0; x < bitmap.w; x++) {
      const src = (y * bitmap.w + x) * bitmap.channels, dst = ((top + y) * width + left + x) * 4;
      rgba.set(bitmap.channels === 4 ? bitmap.pixels.subarray(src, src + 4) : [255,255,255,bitmap.pixels[src]], dst);
    }
  }
  for (const font of Object.values(fonts)) for (const glyph of font.glyphs) {
    if (glyph.bitmap) glyph.bitmap.rect = rects.get(glyph.slot)!;
  }
  return {fonts, sheet: {width, height, rgba}};
}
