// Where each build keeps the map's shared values, read from the user's own
// bundles by shape (the same rules on every build): the terrain style
// dictionary, the fleck atlas, the room annotation table that some builds keep
// outside the rooms, and the two label fonts, which are the fonts whose glyph
// advances reproduce the label sizes stored with every room. Record types are
// anchored by the type table's ids, which stay the same from build to build.
import {makeRegistryRowDecoder} from '../world/effects.js';
import {PoolDecoder, type PoolFrame, type PoolNode} from '../world/value-pool.js';
import {deriveRoomMetadata, resolveValue, type RoomMetadata} from '../world/room-metadata.js';
import type {ConstructorRecord, FillRow} from '../world/replay.js';
import {typesWithId, type TypeTable} from '../datatable.js';
import type {WorldProfile} from '../world/profile.js';
import {parseImageMeta} from '../image.js';
import {decodeMapAnnotationTable} from './bindings.js';
import {mapFontReader, recordKindsWhere} from './fonts.js';
import {deriveMapRoomRecords, type MapRoomRecord, type MapValue} from './records.js';

/** The registry's dictionaries, after the constructor stream: per dictionary
 *  a count, then its keys, then its record slots, read until the next value
 *  no longer reads as one (or the value pool begins). */
export function readDictionaries(bytes: Uint8Array, profile: WorldProfile, poolFrame: PoolFrame): {keys: number[]; slots: number[]}[] {
  const reader = new PoolDecoder(bytes, new Map(), new Map()), out: {keys: number[]; slots: number[]}[] = [];
  reader.pos = profile.stream.constructor_end;
  try {
    while (reader.pos < poolFrame.countOffset) {
      const count = reader.varint();
      if (count > profile.stream.object_count) break;
      const keys = Array.from({length: count}, () => reader.varint());
      const slots = Array.from({length: count}, () => reader.varint());
      if (reader.pos > poolFrame.countOffset || slots.some(slot => slot >= profile.stream.object_count)) break;
      out.push({keys, slots});
    }
  } catch { /* the end of the dictionaries */ }
  return out;
}

export interface MapStyleDictionary {index: number; defaults: Map<number, number>}
/** The terrain style type's id in the type table, and the constructor value
 *  holding a record's type. */
const STYLE_TYPE = '208427608d620db3';
const TYPE_VALUE = 2;

/** Terrain style dictionaries: records whose types all lie under the terrain
 *  style type (its type table id stays the same from build to build), every
 *  record of one kind and nothing else, each holding a single RGB555 colour,
 *  keyed by every style the rooms use. */
export function styleDictionaryCandidates(
  rows: FillRow[], objects: ConstructorRecord[], types: TypeTable, pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile,
  dictionaries: {keys: number[]; slots: number[]}[], usedKeys: Iterable<number>,
): MapStyleDictionary[] {
  const styleTypes = typesWithId(types, STYLE_TYPE);
  if (styleTypes.length !== 1) return [];
  const [styleType] = styleTypes, styleEnd = types.ends[styleType];
  const isStyle = (slot: number) => {
    const t = objects[slot]?.values?.[TYPE_VALUE];
    return typeof t === 'number' && t > styleType && t <= styleEnd;
  };
  const perKind = new Map<number, number>();
  for (const row of rows) perKind.set(row.selector, (perKind.get(row.selector) ?? 0) + 1);
  const used = [...new Set(usedKeys)], decode = makeRegistryRowDecoder(rows, bytes, profile), out: MapStyleDictionary[] = [];
  dictionaries.forEach(({keys, slots}, index) => {
    const kind = rows[slots[0]]?.selector;
    if (!keys.length || new Set(keys).size !== keys.length || !used.every(k => keys.includes(k)) || !slots.every(isStyle)) return;
    if (kind === undefined || perKind.get(kind) !== slots.length || slots.some(slot => rows[slot]?.selector !== kind)) return;
    const defaults = new Map<number, number>();
    for (const [i, slot] of slots.entries()) {
      let colors: number[] = [];
      try {
        colors = (decode(slot) ?? []).flatMap(op => {
          const n = op.kind === 'G' ? resolveValue(pool, op.node) : null;
          return n?.tag === 10 ? [n.value] : [];
        });
      } catch { return; }
      if (colors.length !== 1 || !Number.isInteger(colors[0]) || colors[0] < 0 || colors[0] > 0x7fff) return;
      defaults.set(keys[i], colors[0]);
    }
    out.push({index, defaults});
  });
  return out;
}

/** The terrain's fleck atlas: the texture the registry refers to whose top
 *  level is twelve 40-pixel cells wide and a whole number of cells high, each
 *  smaller level half the one before. readTail reads the last bytes of a
 *  texture, where its level list is kept. */
export async function fleckAtlasCandidates(
  rows: FillRow[], pool: PoolNode[], textures: ArrayLike<{flags: number; n: number}>,
  readTail: (id: number, length: number) => Promise<Uint8Array | null>,
): Promise<number[]> {
  const referenced = new Set<number>();
  for (const row of rows) for (const g of row.g) if (g[1] === 0 && g[2] === 71 && Number.isInteger(g[3])) referenced.add(g[3] as number);
  for (const n of pool) if (n?.tag === 71 && Number.isInteger(n.value)) referenced.add(n.value);
  const out: number[] = [];
  // One small read per texture, in order.
  for (const id of [...referenced].sort((a, b) => a - b)) {
    const entry = textures[id];
    if (entry?.flags !== 0 || !(entry.n > 1)) continue;
    const tail = await readTail(id, 13 * entry.n);
    if (!tail) continue;
    let levels;
    try { levels = parseImageMeta(tail); } catch { continue; }
    if (levels[0]?.w !== 12 * 40 || !levels[0].h || levels[0].h % 40) continue;
    if (levels.every((m, i) => !i || (m.w === Math.max(1, levels[i - 1].w >> 1) && m.h === Math.max(1, levels[i - 1].h >> 1)))) out.push(id);
  }
  return out;
}

/** Room annotation tables: a room-keyed table between the value pool and the
 *  fill stream (or in the pool) whose keys are all rooms and whose values are
 *  lists. */
export function annotationTableCandidates(
  bytes: Uint8Array, pool: PoolNode[], profile: WorldProfile, poolFrame: PoolFrame, rooms: Set<number>,
): {offset: number; entries: Map<number, PoolNode[]>}[] {
  const offsets: number[] = [];
  const end = Math.min(bytes.length, profile.stream.fill_start);
  for (let p = poolFrame.end ?? end; p < end; p++) if (bytes[p] === 0x2c) offsets.push(p);
  for (const n of pool) if (n?.tag === 0x2c && Number.isInteger(n.start)) offsets.push(n.start);
  const out: {offset: number; entries: Map<number, PoolNode[]>}[] = [];
  for (const offset of offsets) {
    // A table's count, then its first key: a room reference, direct or pooled.
    let count = 0, shift = 0, p = offset + 1;
    while (p < bytes.length && bytes[p] & 0x80 && shift < 28) { count += (bytes[p++] & 0x7f) << shift; shift += 7; }
    if (p >= bytes.length) continue;
    count += (bytes[p++] & 0x7f) << shift;
    if (!count || count > rooms.size || (bytes[p] !== 0x00 && bytes[p] !== 0x26)) continue;
    try {
      const entries = decodeMapAnnotationTable(bytes, pool, profile, {offset, tag: 44});
      if ([...entries.keys()].every(owner => rooms.has(owner))) out.push({offset, entries});
    } catch { /* not a table */ }
  }
  return out;
}

/** The map's room records. Rooms that list only references to annotation
 *  providers take their annotations from the build's room annotation table. */
export function mapRoomRecords(
  rows: FillRow[], pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile, poolFrame: PoolFrame,
  charset: ArrayLike<string>, symbols: ArrayLike<string>, metadata?: Map<number, RoomMetadata>,
): {records: Map<number, MapRoomRecord>; table: {offset: number; entries: Map<number, PoolNode[]>} | null} {
  const all = () => deriveRoomMetadata(rows, pool, bytes, profile, charset);
  const rooms = metadata ?? all();
  const records = deriveMapRoomRecords(rows, pool, bytes, profile, charset, symbols, rooms);
  const providers = [...records.values()].some(r => r.labels.annotationEntries.length
    && r.labels.annotationEntries.every(n => n.tag === 38));
  if (!providers) return {records, table: null};
  const owners = new Set([...(metadata ? all() : rooms).values()].map(r => r.owner));
  const tables = annotationTableCandidates(bytes, pool, profile, poolFrame, owners);
  if (tables.length !== 1) return {records, table: null};
  return {records: deriveMapRoomRecords(rows, pool, bytes, profile, charset, symbols, rooms, tables[0]), table: tables[0]};
}

// Stored label sizes: the text advance at the label's font size, plus fixed
// margins. Rooms keep one measurement record ('single'), or one per label
// mode ('dual'). The annotation sizes read here are the ones without badges.
const TITLE = {single: [{size: 64}], dual: [{size: 58}, {size: 64}]};
const ANNOTATION = {single: [{record: 0, size: 64, badge: 90, margin: 35}], dual: [{record: 1, size: 64, badge: 0, margin: 20}]};
const TOLERANCE = 0.01;
const hasBadge = (marker: MapValue) => !(marker.tag === 15 && marker.symbol === '$none');
/** Type table ids of the two label fonts' records, which stay the same from
 *  build to build: the fonts of a build whose labels have nothing to measure. */
const FONT_TYPE = {title: '3d8168ebf1e00455', annotation: '4a30f815e78357ef'};

/** The measurement form of the room labels, or null when rooms disagree. */
export function labelForm(records: Iterable<MapRoomRecord>): 'single' | 'dual' | null {
  const forms = new Set([...records].map(r => r.labels.metrics.length === 1 && r.labels.metrics[0].length === 5 ? 'single'
    : r.labels.metrics.length === 2 && r.labels.metrics.every(m => m.length >= 4) ? 'dual' : 'other'));
  return forms.size === 1 && !forms.has('other') ? [...forms][0] as 'single' | 'dual' : null;
}

/** Fonts whose advances reproduce every stored title size, and every stored
 *  annotation size, respectively. */
export function labelFontCandidates(
  rows: FillRow[], pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile, records: Iterable<MapRoomRecord>,
): {title: number[]; annotation: number[]} {
  const rooms = [...records], form = labelForm(rooms);
  if (!form) return {title: [], annotation: []};
  const reader = mapFontReader(rows, pool, bytes, profile);
  const kinds = recordKindsWhere(rows, reader.fields, f => f.some(n => n.tag === 0x7e));
  const title: number[] = [], annotation: number[] = [];
  for (const {slot} of rows.filter(row => kinds.has(row.selector))) {
    let font: ReturnType<typeof reader.font>;
    try { font = reader.font(slot); } catch { continue; }
    const metrics = new Map<number, number[] | null>();
    const glyph = (g: number) => {
      if (!metrics.has(g)) {
        try { metrics.set(g, reader.glyph(font.table.lookup!, g).metrics); } catch { metrics.set(g, null); }
      }
      return metrics.get(g)!;
    };
    // The same advance as the viewer's text line.
    const advance = (glyphs: number[], size: number, tracking: number): number | null => {
      let x = 0, previous: number[] | undefined;
      for (const g of glyphs) {
        const m = glyph(g);
        if (!m) return null;
        x += (previous ? Math.max(...[6, 8, 10, 12].map(i => previous![i] - m[i - 1])) + tracking : m[3]) * size;
        previous = m;
      }
      return x + (previous?.[4] ?? 0) * size;
    };
    const close = (a: number | null, b: number) => a !== null && Math.abs(a - b) < TOLERANCE;
    const titles = rooms.every(r => {
      const lines: number[][] = [[]];
      for (const g of r.labels.glyphs) g === 10 ? lines.push([]) : lines.at(-1)!.push(g);
      return TITLE[form].every(({size}, k) => {
        const widths = lines.map(line => advance(line, size, .02));
        if (widths.some(w => w === null)) return false;
        const height = (font.ascent + font.descent + (lines.length - 1) * font.lineHeight) * size;
        return close(Math.max(...widths as number[]) + 50, r.labels.metrics[k][0]) && close(height, r.labels.metrics[k][1]);
      });
    });
    if (titles) title.push(slot);
    const annotated = rooms.filter(r => r.labels.annotations.length);
    const annotations = annotated.length > 0 && annotated.every(r => ANNOTATION[form].every(({record, size, badge, margin}) => {
      const widths = r.labels.annotations.map(a => {
        const w = advance(a.glyphs, size, .01);
        return w === null ? null : w + (hasBadge(a.marker) ? badge : 0);
      });
      return !widths.some(w => w === null) && close(Math.max(...widths as number[]) + margin, r.labels.metrics[record][2]);
    }));
    if (annotations) annotation.push(slot);
  }
  return {title, annotation};
}

/** The one record of the type with this type table id, or null. */
export function recordOfType(objects: ConstructorRecord[], types: TypeTable, id: string): number | null {
  const found = typesWithId(types, id);
  if (found.length !== 1) return null;
  let slot: number | null = null;
  for (let i = 0; i < objects.length; i++) {
    if (objects[i]?.values?.[TYPE_VALUE] !== found[0]) continue;
    if (slot !== null) return null;
    slot = i;
  }
  return slot;
}

/** The record of a font type, when it reads as a font. */
export function fontOfType(
  rows: FillRow[], objects: ConstructorRecord[], types: TypeTable, pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile, id: string,
): number | null {
  const slot = recordOfType(objects, types, id);
  if (slot === null) return null;
  try { mapFontReader(rows, pool, bytes, profile).font(slot); } catch { return null; }
  return slot;
}

/** The label images: the rounded whole-label panel, the title and annotation
 *  panel, the connector and the badge, each the one record of its type. */
export const MAP_SPRITE_TYPES = {round: '4c144ea26b6e4541', panel: '34b2268bc1fb84da',
  connector: '16097c154bb99301', badge: '5dd19547238e15a9'} as const;
export type MapSpriteName = keyof typeof MAP_SPRITE_TYPES;

export interface MapFacts {
  records: Map<number, MapRoomRecord>;
  annotationTable: {offset: number; entries: Map<number, PoolNode[]>} | null;
  styles: MapStyleDictionary | null;
  atlas: number | null;
  fonts: {title: number | null; annotation: number | null};
  sprites: Partial<Record<MapSpriteName, number>>;
  form: 'single' | 'dual' | null;
}

/** Everything the map reads by shape. A fact that is not found exactly once
 *  is null. */
export async function deriveMapFacts(src: {
  ab0: Uint8Array; profile: WorldProfile; rows: FillRow[]; objects: ConstructorRecord[]; types: TypeTable;
  pool: PoolNode[]; poolFrame: PoolFrame;
  charset: ArrayLike<string>; symbols: ArrayLike<string>; textures: ArrayLike<{flags: number; n: number}>;
  readTail: (id: number, length: number) => Promise<Uint8Array | null>;
}): Promise<MapFacts> {
  const {ab0, profile, rows, pool, poolFrame} = src;
  const {records, table} = mapRoomRecords(rows, pool, ab0, profile, poolFrame, src.charset, src.symbols);
  const used = new Set([...records.values()].flatMap(r => r.terrain.styles.flatMap(w => [0, 8, 16, 24].map(s => w >>> s & 255))));
  const styles = styleDictionaryCandidates(rows, src.objects, src.types, pool, ab0, profile, readDictionaries(ab0, profile, poolFrame), used);
  const atlases = await fleckAtlasCandidates(rows, pool, src.textures, src.readTail);
  const fonts = labelFontCandidates(rows, pool, ab0, profile, records.values());
  // The font the label sizes single out; with nothing to measure, the font of
  // that font's type.
  const pick = (found: number[], kind: 'title' | 'annotation') => {
    if (found.length === 1) return found[0];
    const typed = fontOfType(rows, src.objects, src.types, pool, ab0, profile, FONT_TYPE[kind]);
    return typed !== null && (!found.length || found.includes(typed)) ? typed : null;
  };
  return {records, annotationTable: table, styles: styles.length === 1 ? styles[0] : null,
    atlas: atlases.length === 1 ? atlases[0] : null,
    fonts: {title: pick(fonts.title, 'title'), annotation: pick(fonts.annotation, 'annotation')},
    sprites: Object.fromEntries(Object.entries(MAP_SPRITE_TYPES).flatMap(([name, id]) => {
      const slot = recordOfType(src.objects, src.types, id);
      return slot === null ? [] : [[name, slot]];
    })),
    form: labelForm(records.values())};
}
