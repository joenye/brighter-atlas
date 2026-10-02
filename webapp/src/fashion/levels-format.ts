// A texture's file for a place (gf/images/NNNNN.img): every level (sub-image) of one texture container in one
// file, as stored in the game's files (blocks not yet laid out for the GPU). Little-endian:
//   u16 count, u16 0, then per level: u16 format, u16 width, u16 height, u16 0, u32 bytes; then the levels' data.
export interface Level { fmt: number; width: number; height: number; data: Uint8Array }

/** A phone's file (gf/web/): a sub-image's largest level as WebP bytes (fmt | WEB_TOP), its smaller levels to be
 *  made from it (fmt | WEB_DERIVED, no bytes); the low bits keep the level's own format. */
export const WEB_TOP = 0x4000, WEB_DERIVED = 0x8000, FMT_MASK = 0x3fff;

/** Pixels of a signed two-channel normal map, decoded (uploaded RGBA8_SNORM). */
export const SNORM_RG = 0x7025;

export function packLevels(levels: Level[]): Uint8Array {
  const head = 4 + 12 * levels.length;
  const out = new Uint8Array(head + levels.reduce((n, l) => n + l.data.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint16(0, levels.length, true);
  let at = head;
  levels.forEach((l, k) => {
    const o = 4 + 12 * k;
    dv.setUint16(o, l.fmt, true); dv.setUint16(o + 2, l.width, true); dv.setUint16(o + 4, l.height, true); dv.setUint32(o + 8, l.data.length, true);
    out.set(l.data, at); at += l.data.length;
  });
  return out;
}

export function unpackLevels(file: Uint8Array): Level[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const count = dv.getUint16(0, true), levels: Level[] = [];
  let at = 4 + 12 * count;
  for (let k = 0; k < count; k++) {
    const o = 4 + 12 * k, bytes = dv.getUint32(o + 8, true);
    if (at + bytes > file.length) throw new Error(`texture file: level ${k} runs past the end`);
    levels.push({ fmt: dv.getUint16(o, true), width: dv.getUint16(o + 2, true), height: dv.getUint16(o + 4, true), data: file.subarray(at, at + bytes) });
    at += bytes;
  }
  return levels;
}
