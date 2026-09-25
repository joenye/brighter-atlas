// Per-build decode data is produced offline, purely from analysis of the
// game's own files, never by inspecting or modifying a running game process or
// its memory. For maps it carries only what the user's bundles cannot tell:
// each room type's own terrain colour rules, and where the badge glyphs and
// colours are kept. Every part is optional: without it the map draws with the
// shared colour rules, and badges without those glyphs. Bindings point into
// user-supplied files; no glyph pixels or room palettes are included here.
import type {MapBinding} from './bindings.js';
import type {MapColorRule, MapRoomRules} from './palette.js';

export const MAP_BINDINGS = ['annotationStar', 'levelMinorGlyph', 'levelMajorGlyph', 'levelMinorColor', 'levelMajorColor'] as const;
export type MapBindingName = typeof MAP_BINDINGS[number];

export interface MapDecodeData {
  bindings: Partial<Record<MapBindingName, MapBinding>>;
  rooms: MapRoomRules | null;
}

const integer = (v: unknown, max = 0xffffffff): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function validRule(v: unknown): v is MapColorRule {
  if (!object(v)) return false;
  if (v.kind === 'default') return true;
  if (v.kind === 'constant') return integer(v.value, 0x7fff);
  return (v.kind === 'rgb' || v.kind === 'hsl') && integer(v.color, 3)
    && Array.isArray(v.multiply) && v.multiply.length === 3 && v.multiply.every(Number.isFinite);
}

/** The usable parts of a build's map decode data. Never throws: a missing or
 *  malformed part is left out, and the map draws without it. */
export function readMapDecodeData(value: unknown): MapDecodeData {
  const out: MapDecodeData = {bindings: {}, rooms: null};
  if (!object(value) || value.kind !== 'brighter-atlas-map-decode' || value.format !== 1) return out;
  const bindings = object(value.bindings) ? value.bindings : {};
  for (const name of MAP_BINDINGS) {
    const b = bindings[name];
    if (object(b) && integer(b.offset) && integer(b.tag, 255)) out.bindings[name] = {offset: b.offset, tag: b.tag};
  }
  const rooms = object(value.palette) ? value.palette.rooms : undefined;
  if (object(rooms) && Object.entries(rooms).every(([k, r]) => /^\d+$/.test(k) && object(r)
    && Object.entries(r).every(([key, rule]) => /^\d+$/.test(key) && validRule(rule)))) {
    out.rooms = rooms as MapRoomRules;
  }
  return out;
}
