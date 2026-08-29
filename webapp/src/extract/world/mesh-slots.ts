// Body-slot inference for the meshes an item definition never names.
//
// mesh-names.ts recovers an equip slot ("head", "torso", ...) only for the
// meshes it can join to an item-definition row: on the player rig that is a few
// hundred of the ~2600 meshes bound to it, so a slot facet built from item data
// alone shows a fraction of the wardrobe. The rest are the same garments in
// their other gender/tier/dye variants, plus hair, beards and every held prop,
// and nothing in the item tables points at them.
//
// The skinning weights do. A mesh is bound to the rig it deforms with, and the
// bone carrying most of its weight says WHERE on the body it sits: a hat is
// weighted to the head bone whatever item (if any) declares it. So the item
// slots become training labels for their bones, and every other mesh on the rig
// inherits the slot of the bone it hangs off:
//
//   item-slotted meshes --(dominant bone)--> bone votes --> bone slot
//   unnamed mesh --(dominant bone)--> bone slot --> inferred equip slot
//
// Three things make the vote hold up on a real rig:
//
//  * MIRRORED BONES VOTE TOGETHER. A humanoid rig's limbs are exact mirrors
//    (rest translation x negated, y/z equal), and the handful of item-slotted
//    meshes lands unevenly across a left/right pair -- enough for the left
//    forearm to learn "hands" from a glove while the right learns "torso" from
//    a sleeve. Pairing mirrored bones and pooling their votes removes that
//    coin-flip, and is what the rig itself says about its own symmetry.
//
//  * A BONE WITH NO VOTES CLIMBS. Sleeves and pauldrons hang off arm bones no
//    item-slotted mesh happens to dominate; the nearest labelled ancestor
//    (the chest, "torso") is the honest answer for them.
//
//  * GRIP BONES ARE NOT WORN. Some bones exist only to hang props on: every
//    mesh dominated by them is bound to that ONE bone at full weight (weapons,
//    tools, torches), never blended across neighbours the way a garment is.
//    Those meshes take the synthetic 'held' slot instead of the wearable slot
//    their bone's parent would hand down (a sword is not a glove). The test is
//    structural, and rigid binding alone is NOT enough on its own: plate helmets
//    are rigid too, which is why a bone that any item-slotted mesh votes for can
//    never be a grip bone.
//
// Only rigs carrying enough item slots to learn from are inferred at all, which
// in practice means the player rig: a wolf's bones have no equip slots to
// spread and would only produce confident nonsense. Every result is marked
// inferred in the doc and the viewers show it as such: this is a body region
// read off the skinning, not a fact from the game's item tables.

// 1: initial inference (dominant bone vote, mirror pooling, parent climb, grip
// bones).
export const MESH_SLOTS_FORMAT = 1;
// A rig needs this many item-slotted meshes before any of its bones are taken
// to be labelled. The player rig has hundreds; nothing else has more than a few.
const MIN_LABELLED = 8;
// How far up the parent chain an unlabelled bone looks for a labelled one.
// Beyond this the bone is left unclassified rather than adopting a slot from
// halfway across the body.
const CLIMB_MAX = 4;
// A grip bone: at least this many meshes dominated by it, and at least this
// fraction of them bound to that single bone at full weight.
const GRIP_MIN_MESHES = 4;
const GRIP_RIGID_RATIO = 0.8;
// The slot for props hung on a grip bone. Not an equip slot the game declares:
// held items live in item families whose mesh join is still unrecovered, so
// this names the attachment, which is what the skinning actually proves.
export const HELD_SLOT = 'held';
// Mirror tolerance, relative to the rig's own scale (rest translations are
// authored, and the mirrored pairs measured so far agree to the float).
const MIRROR_EPS = 1e-4;

export interface RigSkeleton {
  parents: number[];      // per bone, its parent index (-1 at the root)
  rest: number[][];       // per bone, its rest-WORLD translation
}

export interface MeshSlotsInput {
  i: number;              // ab5 mesh ordinal
  skel: number;           // ab6 rig ordinal, <0 when not skinned to one
  bone?: number;          // dominant bone (extract/mesh.js skinSummary)
  bones?: number;         // how many bones weight the mesh
}

export interface MeshSlotsDoc {
  format: number;
  rigs: number[];                    // rigs that carried enough labels to infer
  slots: Record<string, number>;     // slot -> inferred mesh count
  meshes: Record<string, string>;    // ab5 mesh ordinal -> inferred slot
}

// Mirrored-bone pairing: bone -> the canonical bone of its left/right pair
// (the lower index of the two). Bones with no mirror map to themselves.
function mirrorMap(rest: number[][]): number[] {
  const n = rest.length;
  const canonical = new Array<number>(n);
  for (let b = 0; b < n; b++) canonical[b] = b;
  let scale = 0;
  for (const p of rest) for (const c of p) scale = Math.max(scale, Math.abs(c));
  const eps = Math.max(scale * MIRROR_EPS, Number.MIN_VALUE);
  for (let a = 0; a < n; a++) {
    if (canonical[a] !== a) continue;         // already paired to a lower bone
    const [ax, ay, az] = rest[a] || [0, 0, 0];
    if (Math.abs(ax) <= eps) continue;        // on the centre line: no mirror
    for (let b = a + 1; b < n; b++) {
      if (canonical[b] !== b) continue;
      const [bx, by, bz] = rest[b] || [0, 0, 0];
      if (Math.abs(bx + ax) <= eps && Math.abs(by - ay) <= eps && Math.abs(bz - az) <= eps) {
        canonical[b] = a;
        break;
      }
    }
  }
  return canonical;
}

// meshes: the mesh index entries (i/skel/bone/bones).
// rigs: rig ordinal -> its bone parents + rest-world translations.
// itemSlots: mesh ordinal -> the equip slot its item definition declares
// (mesh-names.js). Those meshes are the labels and are NOT re-emitted: the doc
// carries only what inference adds.
export function inferMeshSlots(
  meshes: Iterable<MeshSlotsInput>,
  rigs: Map<number, RigSkeleton>,
  itemSlots: Map<number, string>,
): MeshSlotsDoc {
  // rig -> its meshes, ascending by ordinal (the whole pass is order-stable)
  const byRig = new Map<number, MeshSlotsInput[]>();
  for (const mesh of meshes) {
    if (!mesh || !Number.isInteger(mesh.bone) || !rigs.has(mesh.skel)) continue;
    let list = byRig.get(mesh.skel);
    if (!list) byRig.set(mesh.skel, list = []);
    list.push(mesh);
  }

  const inferred: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const usedRigs: number[] = [];

  for (const rig of [...byRig.keys()].sort((a, b) => a - b)) {
    const rigMeshes = byRig.get(rig)!.sort((a, b) => a.i - b.i);
    const skeleton = rigs.get(rig)!;
    const labelled = rigMeshes.filter((m) => itemSlots.has(m.i));
    if (labelled.length < MIN_LABELLED) continue;

    const canonical = mirrorMap(skeleton.rest);
    const canon = (bone: number) => (canonical[bone] ?? bone);

    // 1. votes from the item-slotted meshes
    const votes = new Map<number, Map<string, number>>();
    for (const mesh of labelled) {
      const bone = canon(mesh.bone!);
      let tally = votes.get(bone);
      if (!tally) votes.set(bone, tally = new Map());
      const slot = itemSlots.get(mesh.i)!;
      tally.set(slot, (tally.get(slot) || 0) + 1);
    }
    const boneSlot = new Map<number, string>();
    for (const [bone, tally] of votes) {
      // most votes; ties broken by name so the doc is deterministic
      const best = [...tally].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0];
      boneSlot.set(bone, best[0]);
    }

    // 2. grip bones (unvoted, and holding rigidly bound props)
    const perBone = new Map<number, { total: number; rigid: number }>();
    for (const mesh of rigMeshes) {
      const bone = canon(mesh.bone!);
      let stat = perBone.get(bone);
      if (!stat) perBone.set(bone, stat = { total: 0, rigid: 0 });
      stat.total++;
      if (mesh.bones === 1) stat.rigid++;
    }
    for (const [bone, stat] of perBone) {
      if (boneSlot.has(bone)) continue;
      if (stat.total >= GRIP_MIN_MESHES && stat.rigid / stat.total >= GRIP_RIGID_RATIO) {
        boneSlot.set(bone, HELD_SLOT);
      }
    }

    // 3. the remaining bones inherit from the nearest labelled ancestor
    const climbed = new Map<number, string | null>();
    const slotOf = (bone: number): string | null => {
      const direct = boneSlot.get(bone);
      if (direct) return direct;
      const seen = climbed.get(bone);
      if (seen !== undefined) return seen;
      let at = bone;
      let found: string | null = null;
      for (let hop = 0; hop < CLIMB_MAX; hop++) {
        const parent = skeleton.parents[at];
        if (!Number.isInteger(parent) || parent < 0) break;
        at = canon(parent);
        const slot = boneSlot.get(at);
        if (slot) { found = slot; break; }
      }
      climbed.set(bone, found);
      return found;
    };

    // 4. every mesh the item tables did not name
    let added = 0;
    for (const mesh of rigMeshes) {
      if (itemSlots.has(mesh.i)) continue;
      const slot = slotOf(canon(mesh.bone!));
      if (!slot) continue;
      inferred[String(mesh.i)] = slot;
      counts[slot] = (counts[slot] || 0) + 1;
      added++;
    }
    if (added) usedRigs.push(rig);
  }

  return { format: MESH_SLOTS_FORMAT, rigs: usedRigs, slots: counts, meshes: inferred };
}
