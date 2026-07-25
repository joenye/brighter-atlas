// Per-room ambience, recovered from the room's own registry row.
//
// The game multiplies EVERY particle by a global half-range modulation (the
// particle vertex shader's last step), and that modulation is fed from the
// room, not from the effect. It is why an effect authored with no colour of
// its own still reads as coloured in game: a candle glow is a single-channel
// mask with nothing to tint it, and the room supplies the tint. Without this,
// every such effect renders plain white.
//
// The room's registry row carries both an `$ambienceN` level symbol and a
// short run of colours. Rooms are joined to their row by BYTE SPAN rather than
// by name: room.js's roomSelfAnchors already yields a byte position per room
// id, and every replayed row records its own start/end, so the row whose span
// contains a room's anchor IS that room's row. Joining on the name instead
// would be ambiguous (several rooms share one).
//
// Worker-safe: no DOM, no Node APIs. Internally total: any failure leaves a
// room without ambience rather than failing the extraction.

import { roomSelfAnchors } from './room.js';
import type { FillRow } from './replay.js';

export interface RoomAmbience {
  level: string | null;                 // e.g. "$ambience1"
  colors: [number, number, number, number][];
}

export interface AmbienceInputs {
  rows: FillRow[];
  ab0: Uint8Array;
  roomIds: Iterable<number>;
  // (slot) -> the row's decoded top-level entries, from the SAME re-decoder
  // the effect recovery uses, so this adds no second grammar to keep in step.
  decodeRow: (slot: number) => { kind: string; name?: string | null;
    rgba?: [number, number, number, number] }[] | null;
}

/** room id -> ambience, for every room whose row could be decoded. */
export function deriveRoomAmbience(
  { rows, ab0, roomIds, decodeRow }: AmbienceInputs,
): Map<number, RoomAmbience> {
  const out = new Map<number, RoomAmbience>();
  const ids = new Set<number>();
  for (const id of roomIds) ids.add(Number(id));
  if (!ids.size || !rows.length) return out;

  let anchors: Map<number, number>;
  try { ({ anchors } = roomSelfAnchors(ab0, ids)); } catch { return out; }
  if (!anchors.size) return out;

  // rows sorted by start once, so each anchor is one binary search
  const ordered = rows.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .sort((a, b) => a.start - b.start);
  const starts = ordered.map((r) => r.start);
  const rowAt = (offset: number): FillRow | null => {
    let lo = 0; let hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= offset) lo = mid + 1; else hi = mid; }
    const row = ordered[lo - 1];
    return row && offset >= row.start && offset < row.end ? row : null;
  };

  for (const [roomId, anchor] of anchors) {
    const row = rowAt(anchor);
    if (!row) continue;
    let entries;
    try { entries = decodeRow(row.slot); } catch { entries = null; }
    if (!entries) continue;
    let level: string | null = null;
    const colors: [number, number, number, number][] = [];
    for (const e of entries) {
      if (e.kind === 'symbol' && typeof e.name === 'string' && e.name.startsWith('$ambience')) {
        if (level === null) level = e.name;
      } else if (e.kind === 'color' && Array.isArray(e.rgba) && e.rgba.length === 4) {
        colors.push([Number(e.rgba[0]), Number(e.rgba[1]), Number(e.rgba[2]), Number(e.rgba[3])]);
      }
    }
    if (level !== null || colors.length) out.set(roomId, { level, colors });
  }
  return out;
}
