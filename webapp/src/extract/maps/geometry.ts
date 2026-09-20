// Terrain patches are small lookup records in the image bundle. The palette
// resolver must supply decoded style results; missing styles are never guessed.
import {parseDatafileRecords} from '../image.js';
import type {MapRoomRecord} from './records.js';

export interface MapPatch {
  index: number;
  room: number;
  position: [number, number];
  group: number;
  base555: number;
  corners555: number[];
  tiles: number[];
}
export function packMapColor(rgb: readonly number[]): number {
  const c = rgb.slice(0, 3).map(v => Math.max(0, Math.min(31,
    Math.trunc(Math.fround(Math.fround(v * 31) + 0.5)))));
  return (c[0] << 10) | (c[1] << 5) | c[2];
}
export async function extractMapGeometry(
  rooms: Iterable<Pick<MapRoomRecord, 'owner' | 'mapPosition' | 'terrain'>>,
  textures: ArrayLike<{flags: number; n: number}>,
  readLookup: (texture: number) => Promise<Uint8Array>,
  resolvePalette: (room: number) => ReadonlyMap<number, number>,
): Promise<MapPatch[]> {
  const patches: MapPatch[] = [];
  // Read sequentially: callers may provide a shared bundle slab reader.
  for (const room of rooms) {
    const t = room.terrain;
    if (!t.positions.length) continue;
    const entry = textures[t.lut];
    if (entry?.flags !== 1 || entry.n !== t.positions.length) throw Error(`map lookup count differs for room ${room.owner}`);
    const data = await readLookup(t.lut);
    const records = parseDatafileRecords(data, entry.n);
    if (records.length !== t.positions.length || !records.every(r => r.fmt === 2 && r.dimA === 16 && r.dimB === 1)) {
      throw Error(`invalid map lookup shape for room ${room.owner}`);
    }
    const palette = resolvePalette(room.owner);
    let group = 0, boundary = t.groupCounts[0] ?? t.positions.length;
    for (let i = 0; i < t.positions.length; i++) {
      while (group < t.groupCounts.length && i >= boundary) boundary += t.groupCounts[++group] ?? 0;
      const keys = [0,8,16,24].map(shift => t.styles[i] >>> shift & 255);
      const corners = keys.map(k => palette.get(k));
      if (corners.some(c => c === undefined || !Number.isInteger(c) || c < 0 || c > 0x7fff)) {
        throw Error(`unresolved map style in room ${room.owner}`);
      }
      if (!t.baseColors[group]) throw Error(`missing map base color in room ${room.owner}`);
      patches.push({index: patches.length, room: room.owner,
        position: [room.mapPosition[0] + t.positions[i][0], room.mapPosition[1] + t.positions[i][1]],
        group, base555: packMapColor(t.baseColors[group]), corners555: corners as number[],
        tiles: Array.from(data.subarray(i * 16, i * 16 + 16))});
    }
  }
  return patches;
}
