// The game's draw order for one room. Its scene build walks the room's cells
// from the top layer down, then row by row, then column by column, then each
// cell's entries, and every element emits its parts in slot order. Static
// elements go into one list per individual layer (the element's individual
// plus one; none is layer 0), and the layer lists are joined in order;
// elements the game redraws on the fly go into a second list, walked the same
// way and drawn after the first. Each list is baked into groups of one
// material and texture (water: one kind and style), a group's parts kept in
// list order and the groups drawn in the order they first appear.
//
// Coplanar parts show whichever draws last, so the order is visible wherever
// the game overlaps them (honeycomb, rugs, puddles).

import type { ColumnMap } from './scene.js';

/** A part's place in the game's draw order: [dynamic, layer, -z, y, x, entry, part]. */
export type EmissionKey = number[];

/** The emission key of a placement row, from its occurrence row. Columns the
 *  data lacks read as zero, so older data keeps a consistent order. */
export function emissionKey(occurrence: any[] | undefined, row: any[], oc: ColumnMap, pc: ColumnMap): EmissionKey {
  const at = (column: number | undefined) => Number(column === undefined ? 0 : occurrence?.[column] ?? 0);
  const place = [-at(oc.z), at(oc.y), at(oc.x), at(oc.entry_slot), Number(row[pc.part_index] ?? 0)];
  return at(oc.dynamic) === 1 ? [1, 0, ...place] : [0, at(oc.individual) + 1, ...place];
}

export interface OrderedBatch {
  material: number;
  renderTexture: number;
  water: null | { kind: string; style: number };
  matrices: readonly unknown[];
  /** Per instance, its emission key. */
  order?: EmissionKey[];
  /** Lit at full in a neighbouring room: drawn apart from the room's dimmed pieces. */
  lit?: boolean;
}

/** The placements of one draw, in the order they draw. */
export interface DrawGroup<B extends OrderedBatch> {
  batch: B;
  parts: { batch: B; index: number }[];
}

const compare = (a: EmissionKey, b: EmissionKey) => {
  for (let k = 0; k < a.length && k < b.length; k++) if (a[k] !== b[k]) return a[k] - b[k];
  return 0;
};

/** A step in the depth of a part that the game draws after another in its cell (the tie rank's unit, in the
 *  depth range: a few steps of a 32-bit depth near its far end, where coplanar parts' depths part by one or two). */
export const TIE_DEPTH_STEP = 2 ** -22;
/** The most tie steps a part is moved by. */
export const TIE_RANK_MAX = 15;

/** Each part's tie rank: where several parts sit in one cell, their place in the order the game draws them (the
 *  first 0), so that a part drawn later is drawn a few depth steps nearer and wins where they lie in one plane,
 *  as the game's draw order makes it win (its depth test passes ties; two different triangles in one plane
 *  give depths a step or two apart either way, so the parts flickered as the camera moved, and the joined world's
 *  draws do not keep each room's order). Per batch, per instance; null where no part ties. Water is left out. */
export function tieRanks<B extends OrderedBatch>(batches: B[]): Map<B, number[]> | null {
  const sequence = new Map<B, number[]>();
  let next = 0;
  for (const group of drawGroups(batches.filter((b) => !b.water && b.order))) {
    for (const { batch, index } of group.parts) {
      let list = sequence.get(batch);
      if (!list) sequence.set(batch, list = new Array(batch.matrices.length).fill(0));
      list[index] = next++;
    }
  }
  const cells = new Map<string, { batch: B; index: number; at: number }[]>();
  for (const [batch, list] of sequence) {
    batch.order!.forEach((key, index) => {
      const cell = `${key[2]},${key[3]},${key[4]}`;
      let parts = cells.get(cell);
      if (!parts) cells.set(cell, parts = []);
      parts.push({ batch, index, at: list[index] });
    });
  }
  let out: Map<B, number[]> | null = null;
  for (const parts of cells.values()) {
    if (parts.length < 2) continue;
    parts.sort((a, b) => a.at - b.at);
    parts.forEach(({ batch, index }, rank) => {
      if (!rank) return;
      out ??= new Map();
      let ranks = out.get(batch);
      if (!ranks) out.set(batch, ranks = new Array(batch.matrices.length).fill(0));
      ranks[index] = Math.min(rank, TIE_RANK_MAX);
    });
  }
  return out;
}

/** Group batches' placements into the game's draws. Without emission keys
 *  every comparison ties, so batches keep their own order. */
export function drawGroups<B extends OrderedBatch>(batches: B[]): DrawGroup<B>[] {
  const groups = new Map<string, { batch: B; parts: { part: { batch: B; index: number }; key: EmissionKey }[] }>();
  for (const batch of batches) {
    batch.matrices.forEach((_, index) => {
      const key = batch.order?.[index] ?? [];
      const id = [key[0] === 1 ? 'dynamic' : 'static',
        batch.water ? `water ${batch.water.kind} ${batch.water.style}` : `material ${batch.material}`, batch.renderTexture,
        ...(batch.lit ? ['lit'] : [])].join('|');
      let group = groups.get(id);
      if (!group) groups.set(id, group = { batch, parts: [] });
      group.parts.push({ part: { batch, index }, key });
    });
  }
  const ranked = [...groups.values()].map((group) => {
    group.parts.sort((a, b) => compare(a.key, b.key));   // stable: ties keep their batch order
    return { batch: group.batch, parts: group.parts.map((p) => p.part), first: group.parts[0].key };
  });
  ranked.sort((a, b) => compare(a.first, b.first));
  return ranked.map(({ batch, parts }) => ({ batch, parts }));
}
