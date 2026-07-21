// Wearable-item mesh-name recovery over the replayed registry.
//
// The datatable holds the game's item display names ("Easter Warden Cape",
// "Plate Torso", "Horned Helmet") but the worn ab5 mesh's own owner row carries
// no name — the two live in disconnected regions. The join is structural, the
// same shape as the animatic controller join (anim-names.ts). Two item-def
// record shapes both reference the worn-appearance owner rows (family
// 6883/16033) that own the ab5 mesh(es), and both tag the item with an
// equip-SLOT (the "head"/"torso"/"legs"/... enum, reader family 2503/11349):
//
//  1. COSMETIC / transmog items (families 6851/18963, 10801/18962): the display
//     name is DUPLICATED across field ops 2 and 4 (a third op holds the season
//     tag — "XMAS 24", "EASTER 25", or a quest title like "THE IMPOSTER"). The
//     item→mesh link is loose enough to need the full pooled+typed walk, so a
//     fan-out cap rejects the rare shared hub; dye/colour variants share one
//     mesh, so the leading colour word is stripped ("White/Brown/Golden Easter
//     Bunny Hood" -> "Easter Bunny Hood").
//
//  2. GEAR: profession armour, guard gear, etc. (family 10317/16063): the name
//     is a single inline label at field op 26; the item references a per-variant
//     series of visual rows (numbered dye/tiers) whose worn owners hold the
//     mesh. Its pooled refs fan out to a big shared hub, so the walk is
//     restricted to TYPED (tag-0x26) edges only — that collapses each item onto
//     its own meshes (e.g. Horned Helmet -> its 16 M/F+tier variant meshes)
//     essentially collision-free.
//
//  3. CAPES: per-profession / region / combat capes, each their own reader
//     family, name at field op 27 ("Ultimate Fisher Cape", "Champion IV Combat
//     Cape"). They do NOT tag the slot enum (they are always the cape slot), and
//     the tier/level prefix (Journeyman/Adept/Expert/Champion/Ultimate + a roman
//     numeral) plus a leading region emblem glyph are collapsed away, so the
//     dozens of tier items that share a cape geometry land on ONE base name
//     ("Fisher Cape", "Combat Cape") — verified 1 base per mesh, 0 cross-family
//     sharing. Profession/combat capes carry typed (tag-0x26) edges to their
//     visual rows, so the same typed-only walk as gear reaches them. The region
//     capes ("Hopeport Cape", "Crenopolis Cape", "Hopeforest Cape", "Mine of
//     Mantuban Cape"), marked by a leading region-emblem glyph, carry no typed
//     edge and reference their visual rows only through the pool, whose
//     neighbourhood also touches a couple of big shared context hubs — so for an
//     emblem cape with no typed reach the walk falls back to a hub-pruned pooled
//     one that stays on the cape's own low-degree visual rows. Each town's
//     guard-profession cape ("Guard"/"Scout"/…) shares the region cape's
//     geometry; the emblem gate keeps that non-emblem name off the shared mesh.
//
//   item-def row —(name)→ display name; —(refs, <=3 hops)→ worn-owner → ab5 mesh
//   item-def row —(typed/pooled ref)→ equip-slot enum row → "head" | "torso" | …
//
// Every named mesh is thereby a player-equippable appearance on the player rig,
// carrying its equip slot — the data the "player + equipment" grouping needs.
// Held items (weapons/tools) live in other families whose mesh join differs and
// are left for later. Creatures/NPCs keep their own rigs and are never touched.

import { PoolStrings, makePoolRegistryRefs } from './models.js';
import { normaliseModelName } from './catalog.js';
import type { RegistryRow } from './graph.js';

export const MESH_NAMES_FORMAT = 2;
const WALK_DEPTH = 3;
const COSMETIC_CAP = 8;   // pooled+typed walk: reject the rare shared hub
const GEAR_CAP = 24;      // typed-only walk: an item's own M/F + dye/tier set

// Cosmetic/transmog item-definition families: name duplicated at field ops 2/4.
const COSMETIC_FAMILIES = new Set(['6851/18963', '10801/18962']);
const COSMETIC_NAME_OP = 2;
const COSMETIC_NAME_OP_DUP = 4;
// Gear (profession armour / guard equipment): name inline at field op 26.
const GEAR_FAMILIES = new Set(['10317/16063']);
const GEAR_NAME_OP = 26;
// Capes: name at field op 27, always ending "Cape"; each profession/region/
// combat cape is its own reader family, so they are recognised by the label
// shape rather than a fixed family set. Always the cape equip slot.
const CAPE_NAME_OP = 27;
const CAPE_CAP = 16;
// Region capes carry a leading region-emblem glyph (a private-use icon char) in
// their label ("Journeyman <glyph>Hopeport Cape"); profession/combat capes do
// not. Only the emblem (region) capes reference their worn series through the
// pool alone, and they SHARE that geometry with the town's guard-profession cape
// ("Guard"/"Scout"/…). Gating the pooled fallback on the emblem both targets the
// region capes and keeps the non-emblem guard cape off the same mesh (one name
// per mesh preserved).
const CAPE_REGION_EMBLEM = /[^\x20-\x7e]/;
// The emblem (region) capes reach their worn series only through pooled edges,
// whose neighbourhood also includes a couple of big shared context hubs; the
// hub-pruned pooled walk skips any row whose pooled fan-out exceeds this (the
// cape's own visual rows fan out to a handful, the shared hubs to dozens).
const CAPE_HUB_DEGREE = 12;
// Cape tier/level prefix collapsed to a base name so tier variants sharing one
// geometry get a single name.
const CAPE_TIER = /^(?:journeyman|adept|expert|champion|ultimate|master|grandmaster)\s+/i;
const CAPE_RANK = /^(?:i{1,3}|iv|vi{0,3}|ix|x)\s+/i;
// Equip-slot enum rows (a paper-doll slot each) live in this reader family.
const SLOT_FAMILY = '2503/11349';
const EQUIP_SLOTS = new Set([
  'head', 'amulet', 'torso', 'cape', 'hands', 'shield', 'legs', 'feet', 'ring', 'ammo',
]);
// Leading words that distinguish dye/colour variants sharing one mesh.
const COLOUR_WORDS = new Set([
  'white', 'black', 'brown', 'golden', 'gold', 'red', 'blue', 'green',
  'yellow', 'orange', 'pink', 'purple', 'cyan', 'fuchsia', 'ghost', 'silver',
  'grey', 'gray', 'undyed',
]);

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isNode = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A display label, not a description sentence (mirrors models.ts isLabelString).
const wsStrip = (s: string): string => s.replace(/[\s\x1c-\x1f\x85]+$/u, '');
const withoutClosing = (s: string): string => wsStrip(wsStrip(s).replace(/["'’”)\]}]+$/u, ''));
function isLabelString(value: any): boolean {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return false;
  if (value.includes('\n') || value.includes('\r')) return false;
  const trimmed = withoutClosing(value);
  return Boolean(trimmed) && !'.?!:;'.includes(trimmed[trimmed.length - 1]);
}

// Drop a leading colour word: dye variants of one item share one mesh.
function baseName(label: string): string {
  const parts = label.split(' ');
  if (parts.length > 1 && COLOUR_WORDS.has(parts[0].toLowerCase())) return parts.slice(1).join(' ');
  return label;
}

// Strip a leading region emblem glyph (a private-use icon char) and fold spaces.
function stripEmblem(label: string): string {
  return label.replace(/[^\x20-\x7e]+/g, '').replace(/\s+/g, ' ').trim();
}

// Cape base name: emblem + tier prefix + rank numeral removed. "Journeyman
// <glyph>Hopeport Cape" -> "Hopeport Cape"; "Champion IV Combat Cape" ->
// "Combat Cape".
function capeBaseName(label: string): string {
  return stripEmblem(label).replace(CAPE_TIER, '').replace(CAPE_RANK, '').trim();
}

export interface MeshNameSource {
  name: string;        // display name (colour/tier-coalesced)
  kind: string;        // 'cosmetic' | 'gear' | 'cape'
  def_row: number;     // registry slot of the item-definition row
  owner: number;       // worn-appearance owner slot the walk reached
  hops: number;        // def_row -> owner reference distance (1..3)
  slot?: string;       // equip slot the item declares
  variants?: string[]; // raw labels collapsed into this name (colour variants)
}

export interface MeshNamesDoc {
  format: number;
  cosmetic_rows: number;  // cosmetic item-def rows resolved to a display name
  gear_rows: number;      // gear item-def rows resolved to a display name
  cape_rows: number;      // cape item-def rows resolved to a display name
  resolved_rows: number;  // rows whose walk reached >=1 mesh
  capped_rows: number;    // rows dropped by the fan-out cap (shared hub)
  ambiguous_rows: number; // cosmetic rows with no field_op-2/4 name (meta/quest)
  names_attached: number; // distinct names attached
  meshes_named: number;   // distinct meshes with >=1 name
  slots: Record<string, number>;   // equip slot -> distinct mesh count
  // Each mesh: display names, its equip slot (when known), and provenance. The
  // client merges `names` as the `sn` display layer and `slot` onto the index
  // entry; `slot`'s presence is the player-equippable flag.
  meshes: Record<string, { names: string[]; slot?: string; sources: MeshNameSource[] }>;
}

// rows/pool/charsetGlyphs: replay + value-pool + charset (as anim-names).
// meshOwners: [ab5 mesh ordinal, owner registry slot] pairs, taken from the
// asset-model records/models (their ab5_mesh <- owner_slot bindings).
// `shared` optionally supplies the orchestrator's memoized PoolStrings /
// pool-ref walk (both pure of (pool, charset)); absent, local instances are
// built exactly as before.
export function extractMeshNames(
  rows: RegistryRow[], pool: any[], charsetGlyphs: ArrayLike<string>,
  meshOwners: Iterable<readonly [number, number]>,
  shared: {
    strings?: PoolStrings | null;
    poolRegistryRefs?: ((index: number) => number[]) | null;
  } = {},
): MeshNamesDoc {
  const strings = shared.strings ?? new PoolStrings(pool, charsetGlyphs);

  // owner registry slot -> the ab5 meshes it owns
  const ownerMeshes = new Map<number, Set<number>>();
  for (const [mesh, owner] of meshOwners) {
    if (!isInt(mesh) || !isInt(owner)) continue;
    let set = ownerMeshes.get(owner);
    if (!set) ownerMeshes.set(owner, set = new Set());
    set.add(mesh);
  }

  // registry refs reachable through one pool value (reference chains) —
  // the shared memoized walk (models.js makePoolRegistryRefs)
  const poolRegistryRefs = shared.poolRegistryRefs ?? makePoolRegistryRefs(pool);

  // every registry row one row references — typed 0x26 + pooled + direct + series
  const pooledTargetsOf = (slot: number): number[] => {
    const row = rows[slot];
    if (!row) return [];
    const out = new Set<number>();
    for (const [, , tag, value] of row.g) {
      if (tag === 0x26 && isInt(value)) out.add(value);
      else if (tag === 0 && isInt(value) && value >= 0 && value < pool.length) {
        for (const target of poolRegistryRefs(value)) out.add(target);
      }
    }
    for (const [, target] of row.r || []) if (isInt(target)) out.add(target);
    for (const [, targets] of row.s || []) {
      for (const target of targets || []) if (isInt(target)) out.add(target);
    }
    return [...out].filter((t) => t >= 0 && t < rows.length);
  };

  // TYPED edges only (tag-0x26 + direct + series). No pooled fan-out: this keeps
  // a gear item on its own visual rows instead of a big shared context hub.
  const typedTargetsOf = (slot: number): number[] => {
    const row = rows[slot];
    if (!row) return [];
    const out = new Set<number>();
    for (const [, , tag, value] of row.g) if (tag === 0x26 && isInt(value)) out.add(value);
    for (const [, target] of row.r || []) if (isInt(target)) out.add(target);
    for (const [, targets] of row.s || []) {
      for (const target of targets || []) if (isInt(target)) out.add(target);
    }
    return [...out].filter((t) => t >= 0 && t < rows.length);
  };

  // POOLED edges, but never traversing INTO a shared context hub (a row with a
  // large pooled fan-out). Region (emblem) capes reference their worn visual
  // rows ONLY through the pool (they carry no tag-0x26 typed edge), and that
  // same pooled neighbourhood also reaches a couple of big shared hubs; pruning
  // the hubs keeps the walk on the cape's own low-degree visual rows.
  const nonHubPooledTargetsOf = (slot: number): number[] =>
    pooledTargetsOf(slot).filter((target) => pooledTargetsOf(target).length <= CAPE_HUB_DEGREE);

  // meshes reachable within WALK_DEPTH via `targetsOf`, each with nearest
  // owner + hop count
  const collectMeshes = (
    start: number, targetsOf: (slot: number) => number[],
  ): Map<number, { owner: number; hops: number }> => {
    const out = new Map<number, { owner: number; hops: number }>();
    const seen = new Set<number>([start]);
    let frontier = [start];
    for (let depth = 1; depth <= WALK_DEPTH; depth++) {
      const next: number[] = [];
      for (const slot of frontier) {
        for (const target of targetsOf(slot)) {
          if (seen.has(target)) continue;
          seen.add(target);
          const owned = ownerMeshes.get(target);
          if (owned) for (const mesh of owned) if (!out.has(mesh)) out.set(mesh, { owner: target, hops: depth });
          next.push(target);
        }
      }
      frontier = next;
    }
    return out;
  };

  // equip-slot enum: registry slot of a 2503/11349 row -> its slot label
  const slotByRow = new Map<number, string>();
  for (const row of rows) {
    if (`${row.selector}/${row.runtime}` !== SLOT_FAMILY) continue;
    for (const event of strings.directStrings(row)) {
      if (typeof event.text === 'string' && EQUIP_SLOTS.has(event.text)) { slotByRow.set(row.slot, event.text); break; }
    }
  }
  // The single equip slot an item declares (typed or one-hop pooled ref).
  const equipSlot = (row: RegistryRow): string | null => {
    const found = new Set<string>();
    for (const [, , tag, value] of row.g) {
      if (tag === 0x26 && isInt(value)) { const s = slotByRow.get(value); if (s) found.add(s); }
      else if (tag === 0 && isInt(value) && value >= 0 && value < pool.length) {
        for (const ref of poolRegistryRefs(value)) { const s = slotByRow.get(ref); if (s) found.add(s); }
      }
    }
    return found.size === 1 ? [...found][0] : null;
  };

  // The cosmetic item name: the label present at BOTH field ops 2 and 4. The
  // duplication distinguishes the real name from the season/collection tag
  // (field op 5) and drops placeholder rows ("Default"/"Hidden") lacking it.
  const cosmeticName = (row: RegistryRow): string | null => {
    const atOp = new Map<number, string>();
    for (const event of strings.directStrings(row)) {
      if (!isLabelString(event.text)) continue;
      if (event.field_op === COSMETIC_NAME_OP && !atOp.has(COSMETIC_NAME_OP)) atOp.set(COSMETIC_NAME_OP, event.text);
      else if (event.field_op === COSMETIC_NAME_OP_DUP && !atOp.has(COSMETIC_NAME_OP_DUP)) atOp.set(COSMETIC_NAME_OP_DUP, event.text);
    }
    const primary = atOp.get(COSMETIC_NAME_OP);
    return primary && primary === atOp.get(COSMETIC_NAME_OP_DUP) ? primary : null;
  };
  // The gear item name: a single inline display label at field op 26 (field op 2
  // there is the vendor, field op 1 the description).
  const gearName = (row: RegistryRow): string | null => {
    for (const event of strings.directStrings(row)) {
      if (event.field_op === GEAR_NAME_OP && isLabelString(event.text)) return event.text;
    }
    return null;
  };
  // The cape item name: a field-op-27 display label ending "Cape" (any family).
  const capeName = (row: RegistryRow): string | null => {
    for (const event of strings.directStrings(row)) {
      if (event.field_op !== CAPE_NAME_OP || !isLabelString(event.text)) continue;
      if (/\bCape$/.test(stripEmblem(event.text))) return event.text;
    }
    return null;
  };

  // ---- item-def rows -> meshes ----------------------------------------------
  let cosmeticRows = 0;
  let gearRows = 0;
  let capeRows = 0;
  let resolvedRows = 0;
  let cappedRows = 0;
  let ambiguousRows = 0;
  // mesh -> name key -> aggregated source
  const byMesh = new Map<number, Map<string, MeshNameSource & { rawLabels: Set<string> }>>();
  const meshSlot = new Map<number, string>();
  const namesSeen = new Set<string>();

  const assign = (
    row: RegistryRow, rawLabel: string, display: string, kind: string, slot: string | null,
    meshes: Map<number, { owner: number; hops: number }>,
  ): void => {
    const key = `${kind} ${normaliseModelName(display)}`;
    namesSeen.add(key);
    for (const [mesh, { owner, hops }] of meshes) {
      if (slot && !meshSlot.has(mesh)) meshSlot.set(mesh, slot);
      let names = byMesh.get(mesh);
      if (!names) byMesh.set(mesh, names = new Map());
      let source = names.get(key);
      if (!source) {
        names.set(key, source = {
          name: display, kind, def_row: row.slot, owner, hops, ...(slot ? { slot } : {}), rawLabels: new Set(),
        });
      } else if (hops < source.hops) {
        source.hops = hops; source.owner = owner; source.def_row = row.slot;
      }
      source.rawLabels.add(rawLabel);
    }
  };

  for (const row of rows) {
    const family = `${row.selector}/${row.runtime}`;
    if (COSMETIC_FAMILIES.has(family)) {
      const label = cosmeticName(row);
      if (label === null) { ambiguousRows++; continue; }
      cosmeticRows++;
      const meshes = collectMeshes(row.slot, pooledTargetsOf);
      if (!meshes.size) continue;
      if (meshes.size > COSMETIC_CAP) { cappedRows++; continue; }
      resolvedRows++;
      assign(row, label, baseName(label), 'cosmetic', equipSlot(row), meshes);
    } else if (GEAR_FAMILIES.has(family)) {
      const label = gearName(row);
      if (label === null) continue;
      gearRows++;
      const meshes = collectMeshes(row.slot, typedTargetsOf);
      if (!meshes.size) continue;
      if (meshes.size > GEAR_CAP) { cappedRows++; continue; }
      resolvedRows++;
      assign(row, label, label, 'gear', equipSlot(row), meshes);
    } else {
      // Capes: recognised by the label shape (each cape is its own family). Tier
      // variants collapse to the profession/region base; slot is always cape.
      const label = capeName(row);
      if (label === null) continue;
      capeRows++;
      // Profession/combat capes carry typed edges to their visual rows; region
      // (emblem) capes reach theirs only through the pool, so when the typed
      // walk finds nothing and the label bears a region emblem, fall back to the
      // hub-pruned pooled walk. The emblem gate keeps the town guard-profession
      // cape (no emblem, same shared geometry) from double-naming the mesh.
      let meshes = collectMeshes(row.slot, typedTargetsOf);
      if (!meshes.size && CAPE_REGION_EMBLEM.test(label)) {
        meshes = collectMeshes(row.slot, nonHubPooledTargetsOf);
      }
      if (!meshes.size) continue;
      if (meshes.size > CAPE_CAP) { cappedRows++; continue; }
      resolvedRows++;
      assign(row, stripEmblem(label), capeBaseName(label), 'cape', 'cape', meshes);
    }
  }

  const meshes: MeshNamesDoc['meshes'] = {};
  const slotCounts: Record<string, number> = {};
  for (const mesh of [...byMesh.keys()].sort((a, b) => a - b)) {
    const sources = [...byMesh.get(mesh)!.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((source) => {
        const out: MeshNameSource = {
          name: source.name, kind: source.kind, def_row: source.def_row, owner: source.owner, hops: source.hops,
        };
        if (source.slot) out.slot = source.slot;
        if (source.rawLabels.size > 1) out.variants = [...source.rawLabels].sort();
        return out;
      });
    const names: string[] = [];
    for (const source of sources) if (!names.includes(source.name)) names.push(source.name);
    const slot = meshSlot.get(mesh);
    const entry: { names: string[]; slot?: string; sources: MeshNameSource[] } = { names, sources };
    if (slot) { entry.slot = slot; slotCounts[slot] = (slotCounts[slot] || 0) + 1; }
    meshes[String(mesh)] = entry;
  }

  return {
    format: MESH_NAMES_FORMAT,
    cosmetic_rows: cosmeticRows,
    gear_rows: gearRows,
    cape_rows: capeRows,
    resolved_rows: resolvedRows,
    capped_rows: cappedRows,
    ambiguous_rows: ambiguousRows,
    names_attached: namesSeen.size,
    meshes_named: byMesh.size,
    slots: slotCounts,
    meshes,
  };
}
