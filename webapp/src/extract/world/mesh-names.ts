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
//     is a single inline label at one field op (26, then 27 after an update:
//     detected per build by pickNameOp, as the op whose labels are near-unique
//     per row, unlike the vendor and the "Equip" verb sharing the row). The item
//     references a per-variant series of visual rows (numbered dye/tiers)
//     whose worn owners hold the mesh. Its pooled refs fan out to a big shared
//     hub, so the walk is restricted to TYPED (tag-0x26) edges only, which
//     collapses each item onto its own meshes (e.g. Horned Helmet -> its 16
//     M/F+tier variant meshes) essentially collision-free.
//
//  3. CAPES: per-profession / region / combat capes, each their own reader
//     family, name at one field op (27 then 28, detected registry-wide as the
//     op the "... Cape" labels concentrate at): "Ultimate Fisher Cape",
//     "Champion IV Combat Cape". They do NOT tag the slot enum (they are always
//     the cape slot), and the tier/level prefix (Journeyman/Adept/Expert/
//     Champion/Ultimate + a roman numeral) plus a leading region emblem glyph
//     are collapsed away, so the dozens of tier items that share a cape
//     geometry land on ONE base name
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

// 3: families are discovered per build instead of pinned. The pinned ids only
// ever matched ONE build (checked against four archived builds, all of which
// matched zero rows), so every other build's doc was missing every cosmetic and
// gear name and gains them now. The output changes, so the format moves with it
// rather than leaving those builds on a stale cached doc.
// 4: the gear and cape NAME FIELD OPS are discovered per build too (see
// pickNameOp). They were pinned at 26/27, which a game update shifted to
// 27/28 -- silently emptying gear and capes (and with them the hands/feet/
// shield/amulet equip slots) on every build after the shift.
export const MESH_NAMES_FORMAT = 4;
const WALK_DEPTH = 3;
const COSMETIC_CAP = 8;   // pooled+typed walk: reject the rare shared hub
const GEAR_CAP = 24;      // typed-only walk: an item's own M/F + dye/tier set

// Reader families are per-build ids: a game update renumbers them wholesale
// (measured across one update: the equip-slot enum moved 2503/11349 ->
// 2527/11578, the cosmetic family 6851/18963 -> 6944/19309). Pinning them
// silently strips every cosmetic and gear name from a new build while capes,
// which are recognised by their label shape instead, keep working. So the
// families below are DETECTED from the data (detectFamilies), and these sets
// are only the fallback for a build where detection finds nothing, which
// keeps older builds decoding exactly as before.
//
// Cosmetic/transmog item-definition families: name duplicated at field ops 2/4.
const COSMETIC_FAMILIES_FALLBACK = new Set(['6851/18963', '10801/18962']);
const COSMETIC_NAME_OP = 2;
const COSMETIC_NAME_OP_DUP = 4;
// Gear (profession armour / guard equipment): name inline at a single field op.
// That op is DETECTED per build (pickNameOp) because a game update shifted
// it 26 -> 27; the pin below is only the fallback for a build where detection
// finds nothing.
const GEAR_FAMILIES_FALLBACK = new Set(['10317/16063']);
const GEAR_NAME_OP_FALLBACK = 26;
// Capes: name at one field op, always ending "Cape"; each profession/region/
// combat cape is its own reader family, so they are recognised by the label
// shape rather than a fixed family set. Always the cape equip slot. The op
// moved 27 -> 28 in the same update and is detected the same way.
const CAPE_NAME_OP_FALLBACK = 27;
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
const SLOT_FAMILY_FALLBACK = '2503/11349';
// The equip-slot enum declares its words at field op 1; a family must show at
// least this many DISTINCT ones to be taken as the enum (a decoy family
// carrying a single 'shield' exists in every build examined).
const SLOT_LABEL_OP = 1;
const SLOT_MIN_LABELS = 4;
// The op-2/op-4 duplicated name is unique to the cosmetic families, so one row
// proves it, and one of the two real families has exactly one row.
const COSMETIC_MIN_ROWS = 1;
// A gear label is common; gear also resolves exactly one equip slot.
const GEAR_MIN_ROWS = 4;
// An item NAME is what tells one row of a family from the next, so the name op
// is the one whose labels are near-unique across the family's rows. The other
// label ops on a gear row are boilerplate that repeats: the vendor
// ("Quartermaster"), the action verb ("Equip"). A description is near-unique
// too, so among the ops that clear this ratio the SHORTEST labels win -- names
// are a few words, descriptions are sentences ("Bears the heraldry of
// Hopeport."). Most descriptions are already dropped by isLabelString (they end
// in a full stop), which is why the ratio alone was enough until now.
const NAME_OP_DISTINCT_RATIO = 0.8;
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
// A cape label always ends in the word: that shape, not a family id, is what
// recognises capes (and nominates the cape name op).
const CAPE_LABEL = /\bCape$/;

// What one field op of one reader family holds, over that family's rows.
interface OpLabels { rows: number; chars: number; labels: Set<string> }

// The op an item family keeps its NAME at: near-unique across the family's rows
// (NAME_OP_DISTINCT_RATIO), and the shortest such op. Null when no op qualifies.
function pickNameOp(ops: Map<number, OpLabels>): number | null {
  let best: number | null = null;
  let bestLen = Infinity;
  for (const [op, stat] of ops) {
    if (stat.rows < GEAR_MIN_ROWS) continue;
    if (stat.labels.size / stat.rows < NAME_OP_DISTINCT_RATIO) continue;
    const meanLen = stat.chars / stat.rows;
    if (meanLen < bestLen || (meanLen === bestLen && best !== null && op < best)) {
      best = op;
      bestLen = meanLen;
    }
  }
  return best;
}

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
  // the reader families this build was read with (detected, see detectFamilies):
  // worth surfacing because a wrong pick here silently empties the whole doc
  families: { slot: string; cosmetic: string[]; gear: string[] };
  // the detected name field ops (gear per family, capes registry-wide),
  // surfaced for the same reason: a wrong op empties gear or capes with no
  // other symptom
  name_ops: { gear: Record<string, number>; cape: number };
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

  // Which families ARE the equip-slot enum, the cosmetics and the gear on THIS
  // build, decided by the shape of their rows rather than by id:
  //   slot enum  - rows whose op-1 string is one of the equip-slot words
  //   cosmetic   - rows carrying the same name at BOTH ops 2 and 4
  //   gear       - rows carrying an inline label at op 26 AND one equip slot
  // Each role has its own row threshold below, tuned to the decoys that share
  // its shape. A role that detects nothing falls back to its pinned id, so a
  // build this cannot read decodes exactly as it did before.
  //
  // Part 1 is ONE walk collecting all three shapes: the gear test needs
  // equipSlot(), which needs slotByRow, which needs the slot family, so the
  // decision is finished in stages after this scan. Keeping the walk free of
  // the per-family extractors below is deliberate: calling one of those consts
  // from here would read it before its declaration and throw at runtime.
  const familyScan = () => {
    const slotLabels = new Map<string, Set<string>>();
    const cosmeticHits = new Map<string, number>();
    // family -> field op -> label stats, the raw material pickNameOp picks
    // the gear name op out of
    const labelOps = new Map<string, Map<number, OpLabels>>();
    // field op -> how many rows carry a "... Cape" label there (families are
    // per cape, so this one is counted registry-wide)
    const capeOps = new Map<number, number>();
    for (const row of rows) {
      const family = `${row.selector}/${row.runtime}`;
      let atName: string | null = null;
      let atNameDup: string | null = null;
      let ops: Map<number, OpLabels> | undefined;
      const capeSeen = new Set<number>();
      for (const event of strings.directStrings(row)) {
        const text = event.text;
        if (typeof text !== 'string') continue;
        if (event.field_op === SLOT_LABEL_OP && EQUIP_SLOTS.has(text)) {
          let seen = slotLabels.get(family);
          if (!seen) { seen = new Set(); slotLabels.set(family, seen); }
          seen.add(text);
        }
        if (!isLabelString(text)) continue;
        if (event.field_op === COSMETIC_NAME_OP && atName === null) atName = text;
        else if (event.field_op === COSMETIC_NAME_OP_DUP && atNameDup === null) atNameDup = text;
        const op = event.field_op;
        if (op === null) continue;   // a heap string with no field op names nothing
        if (!ops) {
          ops = labelOps.get(family);
          if (!ops) labelOps.set(family, ops = new Map());
        }
        let stat = ops.get(op);
        if (!stat) ops.set(op, stat = { rows: 0, chars: 0, labels: new Set() });
        stat.rows++;
        stat.chars += text.length;
        stat.labels.add(text);
        if (!capeSeen.has(op) && CAPE_LABEL.test(stripEmblem(text))) {
          capeSeen.add(op);
          capeOps.set(op, (capeOps.get(op) || 0) + 1);
        }
      }
      if (atName !== null && atName === atNameDup) {
        cosmeticHits.set(family, (cosmeticHits.get(family) || 0) + 1);
      }
    }
    // The enum family is the one declaring the most DISTINCT slot words. The
    // threshold is not ceremony: a decoy family carrying a lone 'shield' sits
    // alongside it in every build examined, and would win a ">= 1" test.
    let slotFamily = SLOT_FAMILY_FALLBACK;
    let best = SLOT_MIN_LABELS - 1;
    for (const [family, seen] of slotLabels) {
      if (seen.size > best) { best = seen.size; slotFamily = family; }
    }
    return { slotFamily, cosmeticHits, labelOps, capeOps };
  };
  const { slotFamily, cosmeticHits, labelOps, capeOps } = familyScan();

  // The cape name op: the ONE op carrying "... Cape" labels. Each cape is its
  // own family, so this is decided registry-wide rather than per family, and
  // the label shape that already recognises capes is what nominates the op --
  // a stray "Cape" elsewhere loses to the dozens of real cape rows.
  const capeNameOp = (() => {
    let op = CAPE_NAME_OP_FALLBACK;
    let best = GEAR_MIN_ROWS - 1;
    for (const [candidate, n] of capeOps) if (n > best) { best = n; op = candidate; }
    return op;
  })();

  // Cosmetic families: a name repeated at BOTH ops 2 and 4 is a shape nothing
  // else in the registry shows, so a single row is proof. Counting higher would
  // be worse than useless here: one of the two real families has exactly one
  // row, and a threshold of 3 silently drops it.
  const cosmeticFamilies = (() => {
    const out = new Set<string>();
    for (const [family, n] of cosmeticHits) if (n >= COSMETIC_MIN_ROWS) out.add(family);
    return out.size ? out : COSMETIC_FAMILIES_FALLBACK;
  })();

  // equip-slot enum: registry slot of an enum row -> its slot label
  const slotByRow = new Map<number, string>();
  for (const row of rows) {
    if (`${row.selector}/${row.runtime}` !== slotFamily) continue;
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

  // Gear families and the gear NAME OP, decided last because the test needs
  // equipSlot. A display label on its own is NOT enough: around eight other
  // families carry one and are recipe/upgrade/description rows ("Trim",
  // "Cabbage", quest sentences). Requiring the rows to also resolve exactly one
  // equip slot separates them cleanly, and the count keeps a stray match from
  // claiming a family.
  //
  // Within a qualifying family the name op is then read off the labels
  // themselves (NAME_OP_DISTINCT_RATIO): near-unique per row, and the shortest
  // of the ops that manage it. Detecting it is what keeps this working across
  // the update that shifted gear names from op 26 to op 27 -- and the op is
  // decided per family, so two families are free to disagree.
  const slottedRows = new Map<string, number>();
  for (const row of rows) {
    const family = `${row.selector}/${row.runtime}`;
    if (!labelOps.has(family)) continue;
    if (equipSlot(row) !== null) slottedRows.set(family, (slottedRows.get(family) || 0) + 1);
  }
  const gearNameOps = new Map<string, number>();
  for (const [family, slotted] of slottedRows) {
    if (slotted < GEAR_MIN_ROWS) continue;
    const op = pickNameOp(labelOps.get(family)!);
    if (op !== null) gearNameOps.set(family, op);
  }
  const gearFamilies = new Set(gearNameOps.keys());
  if (!gearFamilies.size) {
    // Nothing detected: read the build exactly as the pinned pair did.
    for (const family of GEAR_FAMILIES_FALLBACK) {
      gearFamilies.add(family);
      gearNameOps.set(family, GEAR_NAME_OP_FALLBACK);
    }
  }

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
  // The gear item name: a single inline display label at the family's detected
  // name op (the other label ops on the row are the vendor, the action verb and
  // the description).
  const gearName = (row: RegistryRow, nameOp: number): string | null => {
    for (const event of strings.directStrings(row)) {
      if (event.field_op === nameOp && isLabelString(event.text)) return event.text;
    }
    return null;
  };
  // The cape item name: a display label ending "Cape" at the detected cape op
  // (any family).
  const capeName = (row: RegistryRow): string | null => {
    for (const event of strings.directStrings(row)) {
      if (event.field_op !== capeNameOp || !isLabelString(event.text)) continue;
      if (CAPE_LABEL.test(stripEmblem(event.text))) return event.text;
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
    if (cosmeticFamilies.has(family)) {
      const label = cosmeticName(row);
      if (label === null) { ambiguousRows++; continue; }
      cosmeticRows++;
      const meshes = collectMeshes(row.slot, pooledTargetsOf);
      if (!meshes.size) continue;
      if (meshes.size > COSMETIC_CAP) { cappedRows++; continue; }
      resolvedRows++;
      assign(row, label, baseName(label), 'cosmetic', equipSlot(row), meshes);
    } else if (gearFamilies.has(family)) {
      const label = gearName(row, gearNameOps.get(family)!);
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
    families: {
      slot: slotFamily,
      cosmetic: [...cosmeticFamilies].sort(),
      gear: [...gearFamilies].sort(),
    },
    name_ops: {
      gear: Object.fromEntries([...gearNameOps].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      cape: capeNameOp,
    },
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
