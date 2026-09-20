// Structured room metadata shared by room and map extraction. Field positions
// are discovered from each record, never assumed from a particular build.
import { makeRegistryRowDecoder } from './effects.js';
import type { FillRow } from './replay.js';
import type { PoolNode } from './value-pool.js';
import type { WorldProfile } from './profile.js';

export interface RoomMetadata {
  room: number;
  owner: number;
  name: string;
  displayName: string;
  episode: { owner: number; name: string | null; displayName: string | null } | null;
  mapPosition: [number, number];
  mapSize: [number, number];
  source: { roomField: number; nameField: number; episodeField: number; mapPositionField: number };
}

export function resolveValue(pool: PoolNode[], value: PoolNode | undefined): PoolNode | null {
  const seen = new Set<number>();
  while (value?.tag === 0) {
    const index = value.value;
    if (!Number.isInteger(index) || seen.has(index)) return null;
    seen.add(index); value = pool[index];
  }
  return value ?? null;
}

export function decodeGlyphText(value: PoolNode | null, charset: ArrayLike<string>): string | null {
  if (value?.tag !== 0x0e || !Array.isArray(value.values)) return null;
  const glyphs = value.values.map(i => Number.isInteger(i) ? charset[i] : undefined);
  return glyphs.every(g => typeof g === 'string') ? glyphs.join('') : null;
}

export function decodeSignedPair(value: PoolNode | null, bytes: Uint8Array): [number, number] | null {
  if (value?.tag !== 0x2e || !Number.isInteger(value.start) || value.start < 0 || value.start + 9 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getInt32(value.start + 1, false), view.getInt32(value.start + 5, false)];
}

const normalize = (s: string): string => s.replace(/\s+/gu, ' ').trim();

export function deriveRoomMetadata(
  rows: FillRow[], pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile,
  charset: ArrayLike<string>, roomIds?: Iterable<number>,
): Map<number, RoomMetadata> {
  const wanted = roomIds ? new Set(roomIds) : null;
  const decode = makeRegistryRowDecoder(rows, bytes, profile);
  const fields = (slot: number) => new Map((decode(slot) ?? []).flatMap(p =>
    p.kind === 'G' ? [[p.op, resolveValue(pool, p.node)] as const] : []));
  const candidates = new Map<number, RoomMetadata[]>();
  const episodes = new Map<number, RoomMetadata['episode']>();
  for (const row of rows) {
    if (!row.g.some(([, depth, tag, id]) => depth === 0 && tag === 0x13 && typeof id === 'number' && (!wanted || wanted.has(id)))) continue;
    const f = fields(row.slot);
    for (const [op, value] of f) {
      if (value?.tag !== 0x13 || (wanted && !wanted.has(value.value))) continue;
      const position = decodeSignedPair(f.get(op + 1) ?? null, bytes);
      const width = f.get(op + 2), height = f.get(op + 3);
      if (!position || width?.tag !== 10 || height?.tag !== 10
        || !Number.isInteger(width.value) || !Number.isInteger(height.value)
        || width.value <= 0 || height.value <= 0) continue;
      // The room header is a registry reference followed by its title, before
      // its room asset. Require one candidate, rather than choosing a nearby
      // string or borrowing another release's room name.
      const headers = [...f].filter(([i, n]) => i < op && n?.tag === 0x26 && f.get(i + 1)?.tag === 0x0e);
      if (headers.length !== 1) continue;
      const [episodeOp, episodeRef] = headers[0];
      const title = decodeGlyphText(f.get(episodeOp + 1) ?? null, charset);
      if (title === null || !normalize(title)) continue;
      const episodeOwner = episodeRef!.value;
      if (!episodes.has(episodeOwner)) {
        const ef = fields(episodeOwner);
        // Episode titles lead their generic header. Later text can be a long
        // description, so uniqueness across every string would lose the name.
        const first = ef.values().next().value;
        const displayName = decodeGlyphText(first ?? null, charset);
        episodes.set(episodeOwner, { owner: episodeOwner,
          name: displayName === null ? null : normalize(displayName), displayName });
      }
      const result: RoomMetadata = {
        room: value.value, owner: row.slot, name: normalize(title), displayName: title,
        episode: episodes.get(episodeOwner) ?? null, mapPosition: position, mapSize: [width.value, height.value],
        source: { roomField: op, nameField: episodeOp + 1, episodeField: episodeOp, mapPositionField: op + 1 },
      };
      const list = candidates.get(result.room) ?? []; list.push(result); candidates.set(result.room, list);
    }
  }
  return new Map([...candidates].filter(([, values]) => values.length === 1).map(([id, values]) => [id, values[0]]));
}
