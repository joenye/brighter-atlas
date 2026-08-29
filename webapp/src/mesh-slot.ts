// Which body slot a mesh belongs to, and how sure we are of it.
//
// Two sources, in order: `slot` is the equip slot the game's own item data
// declares for that mesh (recovered by extract/world/mesh-names.js), and
// `islot` is the slot inferred from the bone the mesh is skinned to for the
// meshes no item names (extract/world/mesh-slots.js). Facets and filters want
// both so they cover a whole rig; anything presenting a slot to the user should
// say which of the two it got, so `inferred` reads as a guess and not as a fact
// from the item tables.
import type { IndexEntry } from './store.js';

export const bodySlot = (m: IndexEntry): string | null =>
  (m as any).slot || (m as any).islot || null;

export const bodySlotInferred = (m: IndexEntry): boolean =>
  !(m as any).slot && !!(m as any).islot;

// Slot as shown next to a mesh: inferred ones are marked with a leading '~'.
export const bodySlotLabel = (m: IndexEntry): string | null => {
  const slot = bodySlot(m);
  return slot && (bodySlotInferred(m) ? `~${slot}` : slot);
};

export const bodySlotTitle = (m: IndexEntry): string | null => {
  const slot = bodySlot(m);
  if (!slot) return null;
  return bodySlotInferred(m)
    ? `${slot} (inferred from the bone this mesh is skinned to, not from the game's item data)`
    : `${slot} (the equip slot the game's item data gives this mesh)`;
};
