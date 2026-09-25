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

/** Font records, their glyph records and the face lists they share. */
export function mapFontReader(rows: FillRow[], pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile) {
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
  // A font: its glyph lookup, its faces, then ascent, descent and line height.
  const font = (slot: number) => {
    const f = fields(slot);
    const table = one(f.filter(n => n.tag === 0x7e), 'font glyph lookup');
    if (!table.lookup || !table.range) throw Error('missing font lookup payload');
    const faces = faceList(f, 'font faces');
    const dimensions = f.slice(f.indexOf(table) + 1, f.indexOf(table) + 4);
    if (dimensions.length !== 3 || dimensions.some(n => n.tag !== 11 || !Number.isFinite(n.value?.[0]))) throw Error('invalid font dimensions');
    return {table, faces, ascent: dimensions[0].value[0] as number, descent: dimensions[1].value[0] as number,
      lineHeight: dimensions[2].value[0] as number};
  };
  // A glyph's default record: its 13 metric floats and whether it draws.
  const glyph = (lookup: (number | null)[][], index: number) => {
    const variants = lookup[index], slot = variants?.[0];
    if (!Number.isInteger(index) || slot === undefined || slot === null || !rows[slot]) throw Error(`missing default glyph ${index}`);
    const {metrics: m, key} = glyphRecord(slot);
    if (key[0] !== index || key[1] !== 0) throw Error('glyph lookup disagrees with its key');
    const raw = m.raw0!, view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const metrics = Array.from({length: 13}, (_, i) => view.getFloat32(i * 4, false));
    if (!metrics.every(Number.isFinite)) throw Error('invalid glyph metrics');
    return {slot, variants, visible: m.value !== 0, metrics, record: m};
  };
  return {resolve, fields, list, one, faceList, glyphRecord, font, glyph};
}

/** Record kinds (records of one kind share their field layout) whose first
 *  few records pass a test. */
export function recordKindsWhere(rows: FillRow[], fields: (slot: number) => PoolNode[], test: (f: PoolNode[]) => boolean): Set<number> {
  const tried = new Map<number, number>(), out = new Set<number>();
  for (const row of rows) {
    const n = tried.get(row.selector) ?? 0;
    if (n >= 4 || out.has(row.selector)) continue;
    tried.set(row.selector, n + 1);
    try { if (test(fields(row.slot))) out.add(row.selector); } catch { /* not this kind */ }
  }
  return out;
}

// Font atlases hold an ordered list of glyph images and a packing record; the
// atlas records sharing a face with the requested fonts all use one record
// kind.
function atlasSelector(rows: FillRow[], reader: ReturnType<typeof mapFontReader>, faces: Set<number>): number {
  const kinds = recordKindsWhere(rows, reader.fields, f => f.some(n => reader.list(n, 0x33)?.length) && f.some(n => n.tag === 36));
  const selectors = new Set<number>();
  for (const row of rows) {
    if (!kinds.has(row.selector) || selectors.has(row.selector)) continue;
    try {
      if (reader.faceList(reader.fields(row.slot), 'atlas faces').some(face => faces.has(face))) selectors.add(row.selector);
    } catch { /* not an atlas record */ }
  }
  if (selectors.size !== 1) throw Error('font atlas records not found');
  return [...selectors][0];
}

// A shared UV table: a local value pool, then one entry per face glyph.
function parseUvTable(data: Uint8Array, profile: WorldProfile) {
  const arities = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [+k, v]));
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
  if (reader.pos !== data.length || root.tag !== 32) throw Error('font UV count differs');
  return {root, local};
}

export async function extractMapFonts(
  rows: FillRow[], pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile,
  charset: ArrayLike<string>, requests: Record<string, MapFontRequest>, atlasSchema: Partial<MapFontAtlasSchema>,
  readFontTable: (id: number) => Promise<Uint8Array>,
  readGlyphBank: (id: number) => Promise<GlyphImage[]>,
): Promise<{fonts: Record<string, MapFont>; sheet: MapFontSheet; schema: MapFontAtlasSchema}> {
  const reader = mapFontReader(rows, pool, bytes, profile);
  const {resolve, fields, list, one, faceList, glyphRecord} = reader;
  const fonts: Record<string, MapFont> = {};
  for (const [name, request] of Object.entries(requests)) {
    const {table, faces, ascent, descent, lineHeight} = reader.font(request.slot);
    const glyphs = [...new Set(request.glyphs)].filter(g => g !== 10).map(glyph => {
      const {slot, variants, visible, metrics, record: m} = reader.glyph(table.lookup!, glyph);
      if (typeof charset[glyph] !== 'string') throw Error('invalid glyph metrics or character');
      return {glyph, text: charset[glyph], slot, variants: [...variants], visible, metrics,
        auxiliary1: m.f0 ? Array.from(m.raw1!) : null,
        auxiliary2: m.f1 ? Array.from(m.raw2!) : null};
    });
    fonts[name] = {slot: request.slot, faces, sizeRange: [...table.range!], ascent, descent, lineHeight, glyphs};
  }

  const wantedFaces = new Set(Object.values(fonts).flatMap(font => font.faces));
  const selector = atlasSchema.selector ?? atlasSelector(rows, reader, wantedFaces);
  const atlases = rows.filter(row => row.selector === selector).flatMap(row => {
    const f = fields(row.slot);
    const faces = faceList(f, 'atlas faces');
    if (!faces.some(face => wantedFaces.has(face))) return [];
    const images = one(f.flatMap(n => {const refs = list(n, 0x33); return refs ? [refs.map(n => n.value as [number, number])] : [];}), 'atlas glyph images');
    const packing = one(f.filter(n => n.tag === 36), 'font atlas layout');
    return [{slot: row.slot, faces, images, packing}];
  }).sort((a, b) => a.faces.length - b.faces.length);
  // Each atlas face lists its glyph records in order; the UV tables follow it.
  const faceSlots = (faces: number[]) => faces.flatMap(face => {
    const maps = rows[face]?.m;
    if (maps?.length !== 1) throw Error('invalid font face map');
    return maps[0][1].map(entry => entry.value);
  });
  const uvTables = (packing: PoolNode, field: number) => list(resolve(packing.fields?.[field]), 0x13)?.map(n => n.value as number) ?? [];
  // The packing record lists its geometry and its UV tables as references of
  // one kind; the UV tables are the list whose table holds one entry per glyph.
  let uvTablesField = atlasSchema.uvTablesField;
  if (uvTablesField === undefined) {
    const first = atlases[0], fits: number[] = [];
    if (!first) throw Error('missing font UV tables');
    for (const [field] of (first.packing.fields ?? []).entries()) {
      const tables = uvTables(first.packing, field);
      if (!tables.length) continue;
      try {
        if (parseUvTable(await readFontTable(tables[0]), profile).root.values!.length === faceSlots(first.faces).length) fits.push(field);
      } catch { /* not a UV table */ }
    }
    uvTablesField = one(fits, 'font UV tables');
  }

  const sources = new Map<number, {image: [number, number]; face: number; atlas: number}>();
  const rotated = new Map<number, boolean>();
  // The callbacks may use bundle slab readers, so every read is sequential.
  for (const atlas of atlases) {
    const tables = uvTables(atlas.packing, uvTablesField);
    if (!tables.length) throw Error('missing font UV tables');
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
    for (const id of tables) {
      const data = await readFontTable(id);
      const {root, local} = parseUvTable(data, profile);
      if (root.values?.length !== slots.length) throw Error('font UV count differs');
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
  return {fonts, sheet: {width, height, rgba}, schema: {selector, uvTablesField}};
}
