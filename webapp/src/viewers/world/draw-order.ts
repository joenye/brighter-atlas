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

/** Group batches' placements into the game's draws. Without emission keys
 *  every comparison ties, so batches keep their own order. */
export function drawGroups<B extends OrderedBatch>(batches: B[]): DrawGroup<B>[] {
  const groups = new Map<string, { batch: B; parts: { part: { batch: B; index: number }; key: EmissionKey }[] }>();
  for (const batch of batches) {
    batch.matrices.forEach((_, index) => {
      const key = batch.order?.[index] ?? [];
      const id = [key[0] === 1 ? 'dynamic' : 'static',
        batch.water ? `water ${batch.water.kind} ${batch.water.style}` : `material ${batch.material}`, batch.renderTexture].join('|');
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
