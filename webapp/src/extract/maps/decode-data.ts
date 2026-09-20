// Per-build decode data is produced offline, purely from analysis of the
// game's own files. No running game process or its memory is inspected or
// modified. Bindings point into user-supplied files; no glyph pixels or room
// palettes are included here.
import type {MapBinding} from './bindings.js';
import type {MapFontAtlasSchema} from './fonts.js';
import type {MapPaletteRules} from './palette.js';

export interface MapDecodeData {
  kind: 'brighter-atlas-map-decode';
  format: 1;
  bundle0_raw_sha256: string;
  bindings: Record<string, MapBinding>;
  fontAtlas: MapFontAtlasSchema;
  palette: MapPaletteRules;
}

export function validateMapDecodeData(value: unknown, hash: string): MapDecodeData {
  const data = value as MapDecodeData | null;
  if (data?.kind !== 'brighter-atlas-map-decode' || data.format !== 1) throw Error('unsupported map decode data');
  if (!/^[0-9a-f]{64}$/.test(hash) || data.bundle0_raw_sha256 !== hash) throw Error('map decode data is for a different game build');
  for (const name of ['styleDictionary','titleFont','annotationFont']) {
    const binding = data.bindings?.[name];
    if (!binding || !Number.isInteger(binding.offset) || binding.offset < 0 || !Number.isInteger(binding.tag)) {
      throw Error(`missing map binding ${name}`);
    }
  }
  if (!Number.isInteger(data.fontAtlas?.selector) || data.fontAtlas.selector < 0
    || !Number.isInteger(data.fontAtlas.uvTablesField) || data.fontAtlas.uvTablesField < 0
    || !data.palette?.base || !data.palette.rooms) throw Error('incomplete map decode data');
  return data;
}
