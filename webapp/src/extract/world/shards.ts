// Per-room world shard + index builder: compact occurrence/link/placement/
// spawn rows, the columns/enums/semantics/coordinate_system contract, room
// index entries and totals, the "World package v1 (browser)" contract. No
// mesh/texture payloads are written (placements keep ab5 mesh ordinals and
// ab3 texture container ordinals) and no package_id/sha stamps exist: IDB is
// private; integrity comes from the ingest transaction.
//
// Per referenced ab3 texture id the texMeta input must supply:
//   { kind: 'image'|'empty'|'other',   // albedo present / authored-empty
//                                      // container / anything else (data
//                                      // file, decode failure)
//     alpha: bool,                     // authored alpha after cutout recovery
//     spreadMax: int|null,             // albedo_rgb_spread_max
//     paramMin: [4]|null, paramMax: [4]|null } // channel min/max of the LAST
//                                      // post-normal packed plane (recolours)
// (the worldtex INDEX_JOBS kind carries kind/alpha today; spreadMax and the
// last-plane channel ranges are the two additions the orchestrator needs).

import { roomOccupancy, roomIndividualAnchors } from './room.js';
import { AssetGraph, type OccurrenceHit, type PartRecord, type PoolNode, type RegistryRow } from './graph.js';
import { SpawnGraph, type RoomRowRef } from './spawns.js';
import {
  extractEnemyRosters, ownerAppearanceParts, traceAssetMaps, materialMap,
  Resolver, type EnemyRosterEntry, type EnemyDefinition,
} from './models.js';

export const TILE_UNITS = 1024;
export const LAYER_UNITS = 512;
export const MESH_FORWARD_QUARTER_TURNS = 2;
export const EXACT_SCHEMA = 2;

// Stable integer enums used by compact room rows. Never derive these from
// encounter order: incremental room exports must not reinterpret older shards.
export const ROLE: Record<string, number> = { terrain: 0, root: 1, component: 2 };
export const ANCHOR_KIND: Record<string, number> = {
  cell_center: 0,
  terrain_owner_bounds: 1,
  linked_footprint: 2,
  owner_dimensions: 3,
  owner_bounds_alignment: 4,
};
export const PART_KIND: Record<string, number> = {
  terrain_face: 0,
  terrain_custom_mesh: 1,
  terrain_model_part: 2,
  block_face: 3,
  model_part: 4,
};
export const CONFIDENCE: Record<string, number> = {
  exact_positional_face_schema: 0,
  exact_native_custom_terrain_schema: 1,
  exact_native_typed_object: 2,
  exact_native_inline_typed_object: 3,
  exact_native_positional_series: 4,
  exact_native_adjacent_fields: 5,
};
export const CATEGORY: Record<string, number> = {
  terrain: 0, models: 1, spawns: 2, components: 3,
};
export const PLACEMENT_CATEGORIES = ['terrain', 'models', 'components'];
export const CATEGORY_EVIDENCE: Record<string, number> = {
  terrain_secondary: 0,
  root_skinned: 1,
  root_static: 2,
  parent_component: 3,
};
export const SPAWN_CONFIDENCE: Record<string, number> = {
  exact_spawn_scalar_fields: 0,
  exact_spawn_parallel_series: 1,
  exact_roster_owner_appearance: 2,
};
export const SPAWN_MEMBERSHIP_KIND: Record<string, number> = { generic: 0, direct: 1 };
export const SPAWN_RECOLOR_SCOPE: Record<string, number> = {
  parallel: 0, actor_scalar: 1, actor_pair: 2, actor_pair_scalar: 3,
};
// Where a spawn row came from: a positioned actor record, a roaming-enemy
// roster marker (authored tile position), or the room-centre fallback for
// roster enemies whose markers carry no position (honestly approximate).
export const SPAWN_ORIGIN: Record<string, number> = {
  actor: 0, roster: 1, roster_center: 2,
};

// Placement flags.
export const PF_AUTHORED_EMPTY = 1 << 0;
export const PF_ALPHA = 1 << 1;
export const PF_SKINNED = 1 << 2;
export const PF_LOCAL_MATRIX = 1 << 3;
export const PF_TEXTURE_FALLBACK = 1 << 4;
export const PF_COMPONENT = 1 << 5;
export const PF_UNRENDERABLE_TEXTURE = 1 << 6;
export const PF_UNIFORM_LUMINANCE_TINT = 1 << 7;

// Collision/occupancy-envelope flags.
export const CF_COMPONENT = 1 << 1;
export const CF_SKINNED_APPEARANCE = 1 << 2;

export const OCCURRENCE_COLUMNS = [
  'record', 'resource', 'secondary', 'x', 'y', 'z', 'entry_slot',
  'packed', 'rotation_quarters', 'packed_flags', 'individual', 'role',
  'anchor_x', 'anchor_y', 'anchor_kind',
];
export const PLACEMENT_COLUMNS = [
  'occurrence', 'mesh', 'material', 'texture', 'render_texture',
  'flags', 'matrix', 'recolor', 'part_kind', 'part_index',
  'mesh_field_op', 'material_field_op', 'confidence', 'category_evidence',
];
export const LINK_COLUMNS = [
  'occurrence', 'direction', 'target_occurrence', 'dx', 'dy', 'dz',
  'target_slot',
];
export const COLLISION_COLUMNS = [
  'occurrence', 'x', 'y', 'width', 'height', 'z_min', 'z_max',
  'flags',
];
export const SPAWN_COLUMNS = [
  'record', 'room_record', 'x', 'y', 'z', 'surface_z', 'rotation_quarters',
  'direction_resource', 'label', 'label_field_op', 'location_field_op',
  'location_series_index', 'location_class', 'direction_field_op',
  'room_field_op', 'origin',
];
export const SPAWN_PART_COLUMNS = [
  'spawn', 'mesh', 'material', 'texture', 'render_texture', 'flags',
  'recolor', 'part_index', 'mesh_def_slot', 'mesh_field_op',
  'material_field_op', 'confidence', 'recolor_field_op_0',
  'recolor_field_op_1', 'recolor_scope',
];
export const SPAWN_MEMBERSHIP_COLUMNS = [
  'spawn', 'kind', 'field_op', 'series_index', 'leaf_index',
];

export const COORDINATE_SYSTEM = {
  mesh_space: 'game x/y horizontal, z up',
  tile_units: TILE_UNITS,
  layer_units: LAYER_UNITS,
  room_y_sign: 1,
  mesh_forward_quarter_turns: MESH_FORWARD_QUARTER_TURNS,
  cell_translation: 'the occurrence anchor columns use the centre of every class-351 resource\'s rotated generated-owner width/height; map_offset and z are then applied',
  map_offset: 'source-space crop origin inside map_size; because occupancy and display rows have opposite Y directions, display_offset=[map_offset.x,map_size.y-size.y-map_offset.y]',
  viewer_conversion: 'game (x,y,z) -> three.js (x,z,y)',
  composition: 'viewer_conversion * cell_translation * rotation_z((occurrence.rotation_quarters + mesh_forward_quarter_turns) * 90deg) * optional_local_x_reflection(packed_flags & 0x4) * local_matrix_game',
  spawn_translation: '((spawn.x+0.5)*tile_units,(spawn.y+0.5)*tile_units,spawn.surface_z); when surface_z is null consumers may retain the raw spawn.z compatibility placement',
  packed_orientation: 'packed low two bits are rotation_quarters; bit 0x4 reflects local X; bits 3..4 and 5..6 select optional native owner-alignment offsets composed after reflection and the native quarter-turn; bit 0x800 is retained as provenance and does not change placement; class-101 local matrices follow',
  local_matrix_game: 'row-major 3x4 affine, interned without TRS reduction',
};

export const COLUMNS = {
  occurrence: OCCURRENCE_COLUMNS,
  placement: PLACEMENT_COLUMNS,
  link: LINK_COLUMNS,
  collision: COLLISION_COLUMNS,
  spawn: SPAWN_COLUMNS,
  spawn_part: SPAWN_PART_COLUMNS,
  spawn_membership: SPAWN_MEMBERSHIP_COLUMNS,
};

export const ENUMS = {
  role: ROLE,
  anchor_kind: ANCHOR_KIND,
  category: CATEGORY,
  category_evidence: CATEGORY_EVIDENCE,
  spawn_confidence: SPAWN_CONFIDENCE,
  spawn_membership_kind: SPAWN_MEMBERSHIP_KIND,
  spawn_recolor_scope: SPAWN_RECOLOR_SCOPE,
  spawn_origin: SPAWN_ORIGIN,
  part_kind: PART_KIND,
  confidence: CONFIDENCE,
  link_direction: { parent: 0, child: 1 },
  placement_flags: {
    authored_empty: PF_AUTHORED_EMPTY,
    alpha: PF_ALPHA,
    skinned: PF_SKINNED,
    local_matrix: PF_LOCAL_MATRIX,
    texture_fallback: PF_TEXTURE_FALLBACK,
    component: PF_COMPONENT,
    unrenderable_texture: PF_UNRENDERABLE_TEXTURE,
    uniform_luminance_tint: PF_UNIFORM_LUMINANCE_TINT,
  },
  collision_flags: {
    component: CF_COMPONENT,
    skinned_appearance: CF_SKINNED_APPEARANCE,
  },
};

export const SEMANTICS = {
  index_sentinel: '-1 means absent for placement asset, matrix, recolor, field-op and target-occurrence indices',
  placement_matrix: 'matrix=-1 is identity; otherwise index into the room matrices array',
  map_offset: 'map_offset is preserved in source row order; display consumers reflect the crop margin in Y as map_size.y-size.y-map_offset.y before translating occurrences and collision, while spawns are already in full map_size coordinates',
  render_texture: 'render_texture=-1 has no decodable image; inspect placement flags to distinguish authored-empty from decode failure',
  terrain: 'class-351 occurrence with a secondary ground resource',
  models: 'exact root-occurrence appearance parts, whether rigid or skinned',
  spawns: 'room-owned gameplay actor records with an exact typed integer XYZ/direction object and exact parallel mesh/material appearance where present',
  spawn_coordinates: 'spawn x/y are already in full map_size coordinates and do not receive the class-351 map_offset; raw z is retained as actor/navigation provenance, while surface_z is the exact native game-unit height sampled from source terrain face-index 2 triangles at the tile centre (null where this room owns no intersecting top face)',
  spawn_memberships: 'all native room-row generic/direct references are retained; repeated memberships of one registry actor slot produce one spawn row',
  spawn_origin: 'origin=actor rows are positioned native actor records; origin=roster rows come from the roaming-enemy roster markers: authored tiles in the MINIMAP frame (y-down; the extractor reflects into the y-up occupancy frame) with no direction, grounded by the same terrain sampling as actor rows; the markers\' trailing floats stay undecoded provenance (shape suggests further waypoint pairs, unproven); origin=roster_center rows are the honest fallback for roster enemies whose markers carry no position, clustered on free tiles at the room centre and explicitly approximate',
  spawn_recolors: 'two exact actor tint fields are paired by part index when serialized as series, or applied actor-wide when both fields are scalar; the actor schema has implicit neutral output modulation rather than a fabricated third stored colour',
  placement_recolors: 'three values are tint1/tint2/half-range output modulation; a two-value placement with uniform_luminance_tint stores the compact ground schema\'s exact tint/output-modulation pair because its unused second tint is absent rather than fabricated',
  skinned_is_not_spawn: 'AB5 skeleton metadata remains a placement flag only and is never used to identify gameplay actors',
  components: 'appearance parts on parent-linked class-351 occurrences',
  individual_anchors: 'class-447/448 room-space polygons and explicit centers, parallel to the class-189 individuals array',
  root_dimension_anchor: 'generated visual-owner operations 4/5/6 are exact positive XYZ cell dimensions; the root cell is the lower-left corner, odd occurrence quarter-turns swap width/height, and Z remains the root layer',
  class_127_topology: 'all resolved parent/child links remain serialized as independent component provenance; their transitive XY extent validates owner dimensions but does not replace the direct owner anchor when sparse or decorative members change that extent',
  occurrence_anchor: 'all class-351 roles start at the rotated generated-owner dimension centre; when packed axis selectors are nonzero, the native six-way owner modes combine dimensions and tag-0x25 bounds into a local offset, then compose bit-0x4 reflection and the packed quarter-turn',
  packed_reflection: 'packed bit 0x4 composes local scale(-1,1,1) after the occurrence quarter-turn and before any class-101 local matrix',
  collision: 'occupancy-derived envelope; not a decoded physics mesh',
  authored_empty: 'material container is explicitly empty (and no image fallback exists)',
  alpha_mask: 'alpha_source=parameter_blue means cutout coverage came from a post-normal BC1/BC3 parameter plane; alpha_chain identifies it',
  packed_parameter: 'texture metadata parameters preserves every post-normal BC1/BC3 plane in source order; parameter points at the last plane, whose R/G are recolor masks only for placements with an exact recolor tuple; earlier planes remain generic for future PBR decoding and B may carry cutout coverage',
};

// Texture render metadata for one referenced ab3 container (see header).
export interface TextureMeta {
  kind: 'image' | 'empty' | 'other';
  alpha: boolean;
  spreadMax?: number | null;
  paramMin?: number[] | null;
  paramMax?: number[] | null;
  [key: string]: any;
}

export interface SurfaceMesh {
  positions: Float64Array;
  triangles: Uint32Array;
}

export interface ShardContext {
  graph: AssetGraph;
  spawnGraph: SpawnGraph;
  rooms: Map<number, any>;
  roomRows: Map<number, RoomRowRef>;
  roomIds: number[];
  rostersByRoom: Map<number, EnemyRosterEntry[]>;
  rosterAssets: { meshSlots: Map<number, number>; materialTextures: Map<number, number[]> } | null;
  rosterAppearance: (ownerSlot: number) => Record<string, any>[];
  names: Map<number, string> | null;
  meshDir: any;
  profile: any;
  texMeta: (textureId: number) => TextureMeta;
  meshIsSkinned: (meshId: number) => boolean;
  surfaceMesh: (meshId: number) => SurfaceMesh;
  occupancy: (roomId: number) => ReturnType<typeof roomOccupancy>;
}

const inc = (counts: Record<string, number>, key: string, n = 1) => {
  counts[key] = (counts[key] || 0) + n;
};

function role(hit: OccurrenceHit): 'terrain' | 'root' | 'component' {
  if (hit.secondary !== null) return 'terrain';
  if (hit.parentLink === null) return 'root';
  return 'component';
}

// Grayscale, uniformly tinted surfaces from decoded semantics. Exported for
// the catalog builder: card parts/variants carry the same verdict so the
// Models/mesh viewers can apply the identical full-tint shader path the room
// renderer uses.
export function usesUniformLuminanceTint(
  part: { recolors?: any; recolor_schema?: any; [key: string]: any },
  meta: TextureMeta,
): boolean {
  const colors = part.recolors;
  if (!colors || !colors.length) return false;
  const compactUniform = part.recolor_schema === 'uniform_tint_modulation';
  if (compactUniform) {
    if (colors.length !== 2) return false;
  } else {
    if (colors.length < 2) return false;
    for (let k = 0; k < 3; k++) {
      if (!(Math.abs(colors[0][k] - colors[1][k]) <= 1e-7)) return false;
    }
  }
  if ((meta.spreadMax ?? 256) > 8) return false;
  if (meta.paramMin == null && meta.paramMax == null) {
    // A texture that ships NO packed plane cannot partition two tints at
    // all (a stronger form of "packed G is unused"), so the equal-tints and
    // grayscale proofs above suffice. The compact schema's proof is defined
    // ON the plane, so it still requires one.
    return !compactUniform;
  }
  const channelMin = meta.paramMin;
  const channelMax = meta.paramMax;
  return Array.isArray(channelMin) && channelMin.length >= 4
    && Array.isArray(channelMax) && channelMax.length >= 4
    // The decoded packed plane is RGBA. Blue may carry authored cutout;
    // only the storage alpha must be uniformly opaque (and, for the compact
    // schema, G must prove the second tint unused).
    && channelMin[3] === 255 && channelMax[3] === 255
    && (!compactUniform || (channelMin[1] === 0 && channelMax[1] === 0));
}

// The highest source-triangle intersection at one local XY point (float64
// arithmetic, per triangle).
function surfaceHeightAtXY(
  positions: Float64Array | null | undefined,
  triangles: Uint32Array | null | undefined,
  x: number, y: number, epsilon = 1e-5,
): number | null {
  if (!positions || !triangles || !triangles.length) return null;
  let best: number | null = null;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const ia = 3 * triangles[t];
    const ib = 3 * triangles[t + 1];
    const ic = 3 * triangles[t + 2];
    const ax = positions[ia];
    const ay = positions[ia + 1];
    const ab0 = positions[ib] - ax;
    const ab1 = positions[ib + 1] - ay;
    const ac0 = positions[ic] - ax;
    const ac1 = positions[ic + 1] - ay;
    const px = x - ax;
    const py = y - ay;
    const denominator = ab0 * ac1 - ac0 * ab1;
    if (!(Math.abs(denominator) > epsilon)) continue;
    const alongAb = (px * ac1 - ac0 * py) / denominator;
    const alongAc = (ab0 * py - px * ab1) / denominator;
    if (alongAb >= -epsilon && alongAc >= -epsilon && alongAb + alongAc <= 1 + epsilon) {
      const az = positions[ia + 2];
      const height = az + alongAb * (positions[ib + 2] - az) + alongAc * (positions[ic + 2] - az);
      if (best === null || height > best) best = height;
    }
  }
  return best;
}

// The highest exact walk surface over one room-local actor tile: positional
// terrain face index 2 is the source-defined inset top plane; all exact top
// faces at the cell participate and the highest triangle hit wins.
function terrainSurfaceZ(
  ctx: ShardContext, cell: number[], candidates: [OccurrenceHit, PartRecord][],
  actorZ = 0, layers: Set<number> | null = null,
): number | null {
  const pointX = cell[0] + 0.5;
  const pointY = cell[1] + 0.5;
  // Only surfaces in the tile's CONTIGUOUS occupancy span above the actor
  // ground it: Sewer Entrance's overhead arch (layers 0,1,7: a gap) must
  // not ground a floor actor, while Fallen Monument's slab (layers 0..8
  // contiguous) does.
  let span: Set<number> | null = null;
  if (layers) {
    span = new Set();
    for (let z = actorZ; layers.has(z); z++) span.add(z);
  }
  let best: number | null = null;
  for (const [hit, part] of candidates) {
    if (span !== null && !span.has(hit.cell[2])) continue;
    if (part.local_matrix_game !== undefined && part.local_matrix_game !== null) continue;
    const [anchorX, anchorY] = ctx.graph.occurrenceAnchor(hit);
    let localX = (pointX - anchorX) * TILE_UNITS;
    let localY = (pointY - anchorY) * TILE_UNITS;
    const turns = ((hit.rotationQuarters ?? 0) + MESH_FORWARD_QUARTER_TURNS) & 3;
    // The source anchor uses the positive turn (x,y)->(-y,x); undo that exact
    // integer transform before sampling the source mesh.
    for (let k = 0; k < turns; k++) { const t = localX; localX = localY; localY = -t; }
    const mesh = ctx.surfaceMesh(part.mesh);
    const localZ = surfaceHeightAtXY(mesh.positions, mesh.triangles, localX, localY);
    if (localZ !== null) {
      const height = hit.cell[2] * LAYER_UNITS + localZ;
      if (best === null || height > best) best = height;
    }
  }
  return best;
}

function occurrenceAnchorRow(ctx: ShardContext, hit: OccurrenceHit): [number, number, number] {
  const [x, y, kind] = ctx.graph.occurrenceAnchor(hit, {
    tileUnits: TILE_UNITS,
    meshForwardQuarterTurns: MESH_FORWARD_QUARTER_TURNS,
  });
  return [x, y, ANCHOR_KIND[kind]];
}

// Compact occurrence + link rows, plus the source-wide anchor accounting
// (including the class-127 contradiction guards).
export function occurrenceRows(
  ctx: ShardContext, occurrences: OccurrenceHit[], counts?: Record<string, number>,
): [any[][], number[][]] {
  const byCellSlot = new Map<string, number>();
  occurrences.forEach((hit, index) => {
    byCellSlot.set(`${hit.cell[0]},${hit.cell[1]},${hit.cell[2]},${hit.entrySlot}`, index);
  });

  const links: number[][] = [];
  occurrences.forEach((hit, index) => {
    const [x, y, z] = hit.cell;
    const edges: [number, number[]][] = [];
    if (hit.parentLink !== null) edges.push([0, hit.parentLink]);
    for (const link of hit.childLinks) edges.push([1, link]);
    for (const [direction, [dx, dy, dz, targetSlot]] of edges) {
      const target = byCellSlot.get(`${x + dx},${y + dy},${z + dz},${targetSlot}`);
      links.push([index, direction, target !== undefined ? target : -1, dx, dy, dz, targetSlot]);
    }
  });

  // Class-127 links describe component topology; their transitive XY extent
  // is validation provenance, not the rendered pivot.
  const incoming = new Map<number, number[]>();
  const childOccurrences = new Set<number>();
  for (const [index, direction, target] of links) {
    if (direction === 0 && target >= 0) {
      const list = incoming.get(target);
      if (list) list.push(index); else incoming.set(target, [index]);
      childOccurrences.add(index);
    }
  }
  const rows = occurrences.map((hit, index) => {
    const [x, y, z] = hit.cell;
    const [anchorX, anchorY, anchorKind] = occurrenceAnchorRow(ctx, hit);
    return [
      hit.record, hit.resource,
      hit.secondary !== null ? hit.secondary : -1,
      x, y, z, hit.entrySlot,
      hit.packed !== null ? hit.packed : -1,
      hit.rotationQuarters !== null ? hit.rotationQuarters : 0,
      hit.packedFlags !== null ? hit.packedFlags : 0,
      hit.individual !== null ? hit.individual : -1,
      ROLE[role(hit)],
      anchorX, anchorY, anchorKind,
    ];
  });
  const audit: Record<string, number> = {};
  for (const row of rows) {
    const kind = row[14];
    if (kind === ANCHOR_KIND.owner_dimensions) inc(audit, 'anchors_owner_dimensions');
    else if (kind === ANCHOR_KIND.owner_bounds_alignment) inc(audit, 'anchors_owner_bounds_alignment');
    else if (kind === ANCHOR_KIND.terrain_owner_bounds) inc(audit, 'anchors_terrain_owner_bounds');
    else inc(audit, 'anchors_cell_center');
  }
  for (const rootIndex of incoming.keys()) {
    if (childOccurrences.has(rootIndex)
      || occurrences[rootIndex].secondary !== null
      || occurrences[rootIndex].parentLink !== null) continue;
    const members = [rootIndex];
    const visited = new Set([rootIndex]);
    const pending = [rootIndex];
    while (pending.length) {
      const parent = pending.pop()!;
      for (const child of incoming.get(parent) || []) {
        if (visited.has(child)) continue;
        visited.add(child);
        pending.push(child);
        members.push(child);
      }
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const index of members) {
      const [x, y] = occurrences[index].cell;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + 1 > maxX) maxX = x + 1;
      if (y + 1 > maxY) maxY = y + 1;
    }
    const linkedX = (minX + maxX) / 2;
    const linkedY = (minY + maxY) / 2;
    const dimensions = ctx.graph.dimensions3i(occurrences[rootIndex].resource);
    if (dimensions === null) { // occurrenceAnchor already rejects this case
      throw new Error('dimension-anchored root lost its dimensions');
    }
    let [width, height] = dimensions;
    if ((occurrences[rootIndex].rotationQuarters ?? 0) & 1) {
      const t = width; width = height; height = t;
    }
    const sizeMatches = maxX - minX === width && maxY - minY === height;
    inc(audit, sizeMatches
      ? 'anchor_dimension_link_size_agree' : 'anchor_dimension_link_size_disagree');
    const dimensionCenterX = occurrences[rootIndex].cell[0] + width / 2;
    const dimensionCenterY = occurrences[rootIndex].cell[1] + height / 2;
    inc(audit, dimensionCenterX === linkedX && dimensionCenterY === linkedY
      ? 'anchor_dimension_link_center_agree' : 'anchor_dimension_link_center_disagree');
    // Equal source sizes agree on root-cell origin and centre in every
    // validated occurrence; reject a future contradiction instead of choosing.
    if (rows[rootIndex][14] === ANCHOR_KIND.owner_dimensions && sizeMatches && (
      minX !== occurrences[rootIndex].cell[0]
      || minY !== occurrences[rootIndex].cell[1]
      || rows[rootIndex][12] !== linkedX
      || rows[rootIndex][13] !== linkedY)) {
      throw new Error('class-127 footprint contradicts owner dimensions for root '
        + `${occurrences[rootIndex].resource}`);
    }
  }
  if (counts) for (const key in audit) inc(counts, key, audit[key]);
  return [rows, links];
}

function intern(table: any[], lookup: Map<string, number>, key: string, value: any): number {
  let index = lookup.get(key);
  if (index === undefined) {
    index = table.length;
    lookup.set(key, index);
    table.push(value);
  }
  return index;
}

function collisionRows(
  occurrences: OccurrenceHit[], skinnedOccurrences: Set<number>,
): number[][] {
  const groups = new Map<string, { indices: number[]; hits: OccurrenceHit[] }>();
  occurrences.forEach((hit, index) => {
    if (hit.secondary !== null) return;
    const key = `${hit.record}|${hit.individual}|${hit.resource}`;
    let group = groups.get(key);
    if (!group) { group = { indices: [], hits: [] }; groups.set(key, group); }
    group.indices.push(index);
    group.hits.push(hit);
  });
  const rows: number[][] = [];
  for (const group of groups.values()) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const hit of group.hits) {
      const [x, y, z] = hit.cell;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    let flags = 0;
    if (group.hits.some((hit) => hit.parentLink !== null)) flags |= CF_COMPONENT;
    if (group.indices.some((index) => skinnedOccurrences.has(index))) flags |= CF_SKINNED_APPEARANCE;
    rows.push([
      group.indices[0], minX, minY, maxX - minX + 1, maxY - minY + 1,
      minZ, maxZ + 1, flags,
    ]);
  }
  return rows;
}

const sortedCounter = (counter: Map<number, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const z of Array.from(counter.keys()).sort((a, b) => a - b)) out[String(z)] = counter.get(z)!;
  return out;
};

export interface ShardContextOptions {
  rows: RegistryRow[];
  pool: PoolNode[];
  meshDir: any;
  texMeta: ((textureId: number) => TextureMeta | undefined) | Map<number, TextureMeta>;
  rooms: Map<number, any>;
  names?: Map<number, string> | null;
  loadMeshBytes: (meshId: number) => Uint8Array;
  profile?: any;
  // dt.charset: enables the roaming-enemy roster spawns (absent -> none)
  charset?: ArrayLike<string> | null;
  // Precomputed shared derivations from the orchestrator, each a pure
  // never-mutated function of the same rows/pool passed here: the
  // traceAssetMaps / materialMap results and the enemy-definition scan.
  // Absent, they are derived locally exactly as before.
  assetMaps?: { meshSlots: Map<number, number>; textureSlots: Map<number, number[]> } | null;
  materialAssets?: { handles: Set<number>; materialTextures: Map<number, number[]> } | null;
  enemyDefs?: EnemyDefinition[] | null;
}

// Context factory: everything the per-room builder needs, resolved once.
//   rows/pool    : replay.js rows + value-pool.js values
//   meshDir      : datatable.js parseDatatable().meshDir ({v, t, u, sref})
//   texMeta      : (textureId) -> record (see header) or a Map of them
//   rooms        : Map(roomId -> room.js roomLayers() result)
//   names        : optional Map(roomId -> display name)
//   loadMeshBytes: (meshId) -> decoded ab5 object bytes (surface sampling)
//   profile      : optional per-build decode data (provenance in the index)
export function createShardContext({
  rows, pool, meshDir, texMeta, rooms, names = null, loadMeshBytes, profile = null,
  charset = null, assetMaps = null, materialAssets = null, enemyDefs = null,
}: ShardContextOptions): ShardContext {
  const graph = new AssetGraph(rows, pool);
  const spawnGraph = new SpawnGraph(rows, pool, graph);
  const roomIds = Array.from(rooms.keys()).sort((a, b) => a - b);
  const roomRows = spawnGraph.discoverRoomRows(roomIds);
  // Roaming-enemy rosters grouped per room, plus the maps the appearance
  // resolver needs. Charset absent (older callers/fixtures) -> no rosters.
  const rostersByRoom = new Map<number, EnemyRosterEntry[]>();
  let rosterAssets: {
    meshSlots: Map<number, number>; materialTextures: Map<number, number[]>;
  } | null = null;
  if (charset) {
    for (const roster of extractEnemyRosters(rows, pool, charset, enemyDefs)) {
      const list = rostersByRoom.get(roster.room);
      if (list) list.push(roster); else rostersByRoom.set(roster.room, [roster]);
    }
    if (rostersByRoom.size) {
      const { meshSlots, textureSlots } = assetMaps ?? traceAssetMaps(rows);
      const { materialTextures } = materialAssets
        ?? materialMap(pool, new Resolver(pool, meshSlots), textureSlots);
      const lookup = new Map(textureSlots);
      for (const [handle, textures] of materialTextures) lookup.set(handle, textures);
      rosterAssets = { meshSlots, materialTextures: lookup };
    }
  }
  const rosterAppearanceCache = new Map<number, Record<string, any>[]>();
  const texLookup = typeof texMeta === 'function' ? texMeta : (id: number) => texMeta.get(id);
  const surfaceMeshes = new Map<number, SurfaceMesh>();
  // roomOccupancy is deterministic per room and consumed read-only by both the
  // shard builder and the later structural-binding pass: compute once per room
  const occupancyCache = new Map<number, ReturnType<typeof roomOccupancy>>();
  const ctx: ShardContext = {
    graph,
    spawnGraph,
    rooms,
    roomRows,
    roomIds,
    rostersByRoom,
    rosterAssets,
    rosterAppearance: (ownerSlot: number) => {
      if (!rosterAssets) return [];
      let parts = rosterAppearanceCache.get(ownerSlot);
      if (parts === undefined) {
        parts = ownerAppearanceParts(
          rows, pool, ownerSlot, rosterAssets.meshSlots, rosterAssets.materialTextures,
        );
        rosterAppearanceCache.set(ownerSlot, parts);
      }
      return parts;
    },
    names,
    meshDir,
    profile,
    texMeta: (textureId: number) => {
      const meta = texLookup(textureId);
      if (!meta) throw new Error(`no texture metadata for ab3 container ${textureId}`);
      return meta;
    },
    meshIsSkinned: (meshId: number) => meshDir[meshId].sref !== 0,
    // Decoded ab5 top-face geometry for spawn grounding, cached per context.
    surfaceMesh: (meshId: number) => {
      let mesh = surfaceMeshes.get(meshId);
      if (!mesh) {
        const u8 = loadMeshBytes(meshId);
        const { v, t } = meshDir[meshId];
        let stride = 0;
        for (const s of [24, 28, 36]) {
          const used = v * s + t * 6;
          if (used === u8.length || used + 2 === u8.length) { stride = s; break; }
        }
        if (!stride) throw new Error(`mesh ${meshId}: directory counts do not fit object size`);
        const positions = new Float64Array(3 * v);
        const aligned = (u8.byteOffset & 3) === 0 ? u8 : u8.slice();
        const f32 = new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor((v * stride) / 4));
        const strideWords = stride / 4;
        for (let k = 0; k < v; k++) {
          positions[3 * k] = f32[k * strideWords];
          positions[3 * k + 1] = f32[k * strideWords + 1];
          positions[3 * k + 2] = f32[k * strideWords + 2];
        }
        const triangles = new Uint32Array(3 * t);
        const idxOff = v * stride;
        for (let k = 0; k < 3 * t; k++) {
          triangles[k] = u8[idxOff + 2 * k] | (u8[idxOff + 2 * k + 1] << 8);
        }
        mesh = { positions, triangles };
        surfaceMeshes.set(meshId, mesh);
      }
      return mesh;
    },
    occupancy: (roomId: number) => {
      let occ = occupancyCache.get(roomId);
      if (!occ) {
        occ = roomOccupancy(rooms.get(roomId));
        occupancyCache.set(roomId, occ);
      }
      return occ;
    },
  };
  return ctx;
}

// One room -> { shard, entry }. shard mirrors the exact-package
// rooms/NNNNN.json layout minus package_id; entry mirrors the index room
// entry minus file/bytes.
export function buildRoomShard(ctx: ShardContext, roomId: number): { shard: any; entry: any } {
  const room = ctx.rooms.get(roomId);
  const roomRow = ctx.roomRows.get(roomId);
  if (!room || !roomRow) throw new Error(`room ${roomId} is not a decoded room`);
  const { layers, occurrences, individuals } = ctx.occupancy(roomId);
  const individualAnchors = roomIndividualAnchors(room, individuals);
  const counts: Record<string, number> = { occurrences: occurrences.length };
  const [occurrenceRowsOut, links] = occurrenceRows(ctx, occurrences, counts);
  counts.links = links.length;
  const occurrenceIndex = new Map<OccurrenceHit, number>();
  occurrences.forEach((hit: OccurrenceHit, index: number) => occurrenceIndex.set(hit, index));

  const matrices: number[][] = [];
  const matrixLookup = new Map<string, number>();
  const recolors: number[][][] = [];
  const recolorLookup = new Map<string, number>();
  const placementRows: Record<'terrain' | 'models' | 'components', any[][]> = {
    terrain: [], models: [], components: [],
  };
  const skinnedOccurrences = new Set<number>();
  const roomMeshes = new Set<number>();
  const roomTextures = new Set<number>();
  counts.individual_anchors = individualAnchors.reduce(
    (n: number, anchors: any[]) => n + anchors.length, 0,
  );
  const placementZ = new Map<number, number>();
  const terrainZ = new Map<number, number>();
  const terrainSurfaceParts = new Map<string, [OccurrenceHit, PartRecord][]>(); // "x,y" -> [hit, part][]
  const cellLayers = new Map<string, Set<number>>(); // "x,y" -> Set(z)  (occupancy span)
  for (const hit of occurrences) {
    const key = `${hit.cell[0]},${hit.cell[1]}`;
    let set = cellLayers.get(key);
    if (!set) cellLayers.set(key, set = new Set());
    set.add(hit.cell[2]);
  }
  const bump = (map: Map<number, number>, z: number) => map.set(z, (map.get(z) || 0) + 1);

  const available = (textureId: number) => ctx.texMeta(textureId).kind === 'image';

  for (const { occurrence: hit, part } of ctx.graph.roomPlacements(occurrences)) {
    const index = occurrenceIndex.get(hit)!;
    const meshId = part.mesh;
    roomMeshes.add(meshId);

    const textureId = part.texture;
    const fallbackTexture = part.fallback_texture !== undefined ? part.fallback_texture : null;
    roomTextures.add(textureId);
    if (fallbackTexture !== null) roomTextures.add(fallbackTexture);

    const selected = AssetGraph.selectTexture(part, available);
    let flags = 0;
    let renderTexture = -1;
    if (selected !== null) {
      renderTexture = selected.texture;
      if (renderTexture !== textureId) flags |= PF_TEXTURE_FALLBACK;
      const renderMeta = ctx.texMeta(renderTexture);
      if (renderMeta.alpha) flags |= PF_ALPHA;
      if (usesUniformLuminanceTint(selected, renderMeta)) flags |= PF_UNIFORM_LUMINANCE_TINT;
    } else {
      const directEmpty = ctx.texMeta(textureId).kind === 'empty';
      const fallbackEmpty = fallbackTexture === null
        || ctx.texMeta(fallbackTexture).kind === 'empty';
      if (directEmpty && fallbackEmpty) {
        flags |= PF_AUTHORED_EMPTY;
        inc(counts, 'authored_empty');
      } else {
        flags |= PF_UNRENDERABLE_TEXTURE;
        inc(counts, 'unrenderable_texture');
      }
    }

    const skinned = ctx.meshIsSkinned(meshId);
    if (skinned) {
      flags |= PF_SKINNED;
      skinnedOccurrences.add(index);
    }
    if (hit.parentLink !== null) flags |= PF_COMPONENT;

    let matrixIndex = -1;
    if (part.local_matrix_game !== undefined && part.local_matrix_game !== null) {
      flags |= PF_LOCAL_MATRIX;
      const matrix = part.local_matrix_game.map(Number);
      matrixIndex = intern(matrices, matrixLookup, matrix.join(','), matrix);
    }
    let recolorIndex = -1;
    if (part.recolors !== undefined && part.recolors !== null) {
      const colors = part.recolors.map((row: any[]) => row.map(Number));
      recolorIndex = intern(
        recolors, recolorLookup, colors.map((row: number[]) => row.join(',')).join(';'), colors,
      );
    }

    let category: 'terrain' | 'models' | 'components';
    let categoryEvidence: string;
    if (hit.secondary !== null) {
      category = 'terrain';
      categoryEvidence = 'terrain_secondary';
    } else if (hit.parentLink !== null) {
      category = 'components';
      categoryEvidence = 'parent_component';
    } else {
      category = 'models';
      categoryEvidence = skinned ? 'root_skinned' : 'root_static';
    }

    const partIndex = part.face_index !== undefined ? part.face_index
      : part.series_index !== undefined ? part.series_index : -1;
    placementRows[category].push([
      index, meshId, part.material_slot, textureId, renderTexture,
      flags, matrixIndex, recolorIndex, PART_KIND[part.kind],
      partIndex,
      part.mesh_field_op !== undefined ? part.mesh_field_op : -1,
      part.material_field_op !== undefined ? part.material_field_op : -1,
      CONFIDENCE[part.confidence],
      CATEGORY_EVIDENCE[categoryEvidence],
    ]);
    inc(counts, category);
    inc(counts, 'placements');
    const z = hit.cell[2];
    bump(placementZ, z);
    if (category === 'terrain') bump(terrainZ, z);
    // Walk-surface candidates, kind-based across categories: terrain top
    // faces (2 = inset top plane, 0 = outer top of custom shapes), block
    // tops, and model parts (pier planks, monument slabs). Ten user-verified
    // actor positions calibrate this exact set; the contiguous-occupancy
    // filter in terrainSurfaceZ keeps unreachable overhead structure out.
    if ((part.kind === 'terrain_face' && (part.face_index === 0 || part.face_index === 2))
        || (part.kind === 'block_face' && part.face_index === 0)
        || part.kind === 'model_part') {
      const key = `${hit.cell[0]},${hit.cell[1]}`;
      const list = terrainSurfaceParts.get(key);
      if (list) list.push([hit, part]); else terrainSurfaceParts.set(key, [[hit, part]]);
    }
  }

  const mapSize = [room.mapW ?? room.w, room.mapH ?? room.h];
  const mapOffset = [
    Math.floor((mapSize[0] - room.w) / 2),
    Math.floor((mapSize[1] - room.h) / 2),
  ];
  const spawnRows: any[][] = [];
  const spawnPartRows: any[][] = [];
  const spawnMembershipRows: number[][] = [];
  const actors = ctx.spawnGraph.roomSpawns(roomId, roomRow);
  actors.forEach((actor, spawnIndex) => {
    const [x, y, z] = actor.position;
    if (!(x >= 0 && x < mapSize[0] && y >= 0 && y < mapSize[1] && z >= 0)) {
      throw new Error(`room ${roomId} spawn ${actor.record} position `
        + `${JSON.stringify(actor.position)} lies outside map size ${JSON.stringify(mapSize)}`);
    }
    // Spawn positions are room-LOCAL (cropped) like occurrences: every spawn
    // in the corpus fits the cropped size, and subtracting the crop margin
    // instead mis-grounds spawns in exactly the offset rooms.
    const localCell = [x, y];
    const surfaceZ = terrainSurfaceZ(
      ctx, localCell, terrainSurfaceParts.get(`${localCell[0]},${localCell[1]}`) || [],
      z, cellLayers.get(`${localCell[0]},${localCell[1]}`) || null,
    );
    inc(counts, surfaceZ !== null ? 'spawn_grounded' : 'spawn_ungrounded');
    spawnRows.push([
      actor.record, actor.room_record, x, y, z, surfaceZ,
      actor.rotation_quarters, actor.direction_resource,
      actor.label, actor.label_field_op,
      actor.location_field_op, actor.location_series_index,
      actor.location_class, actor.direction_field_op,
      actor.room_field_op, SPAWN_ORIGIN.actor,
    ]);
    for (const membership of actor.memberships) {
      spawnMembershipRows.push([
        spawnIndex, SPAWN_MEMBERSHIP_KIND[membership.kind],
        membership.field_op, membership.series_index, membership.leaf_index,
      ]);
    }
    if (!actor.parts.length) inc(counts, 'spawn_unrendered');
    for (const part of actor.parts) {
      const meshId = part.mesh;
      roomMeshes.add(meshId);
      const textureId = part.texture;
      roomTextures.add(textureId);

      let flags = ctx.meshIsSkinned(meshId) ? PF_SKINNED : 0;
      let recolorIndex = -1;
      if (part.recolors !== null) {
        const colors = part.recolors.map((row: any[]) => row.map(Number));
        recolorIndex = intern(
          recolors, recolorLookup, colors.map((row: number[]) => row.join(',')).join(';'), colors,
        );
      }
      let renderTexture = -1;
      const meta = ctx.texMeta(textureId);
      if (meta.kind === 'image') {
        renderTexture = textureId;
        if (meta.alpha) flags |= PF_ALPHA;
      } else if (meta.kind === 'empty') {
        flags |= PF_AUTHORED_EMPTY;
        inc(counts, 'authored_empty');
      } else {
        flags |= PF_UNRENDERABLE_TEXTURE;
        inc(counts, 'unrenderable_texture');
      }

      spawnPartRows.push([
        spawnIndex, meshId, part.material_slot, textureId,
        renderTexture, flags, recolorIndex, part.part_index,
        part.mesh_def_slot, part.mesh_field_op, part.material_field_op,
        SPAWN_CONFIDENCE[part.confidence],
        part.recolor_field_ops[0], part.recolor_field_ops[1],
        part.recolor_scope !== null && part.recolor_scope in SPAWN_RECOLOR_SCOPE
          ? SPAWN_RECOLOR_SCOPE[part.recolor_scope] : -1,
      ]);
      inc(counts, 'spawn_parts');
      bump(placementZ, z);
    }
  });
  // ---- roaming-enemy roster spawns ----------------------------------------
  // Authored 6-float roster markers carry tile positions (origin=roster);
  // rosters whose markers carry no position fall back to free tiles clustered
  // at the room centre (origin=roster_center, honestly approximate). Both
  // resolve their appearance through the enemy definition's tier owners.
  const rosters = ctx.rostersByRoom.get(roomId) || [];
  if (rosters.length && ctx.rosterAssets) {
    const occupied = new Set<string>();
    for (const hit of occurrences) occupied.add(`${hit.cell[0]},${hit.cell[1]}`);
    const claimTiles = (centerX: number, centerY: number, wanted: number): [number, number][] => {
      const out: [number, number][] = [];
      const maxRadius = Math.max(mapSize[0], mapSize[1]);
      for (let radius = 0; radius <= maxRadius && out.length < wanted; radius++) {
        for (let dy = -radius; dy <= radius && out.length < wanted; dy++) {
          for (let dx = -radius; dx <= radius && out.length < wanted; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const x = centerX + dx;
            const y = centerY + dy;
            if (x < 0 || y < 0 || x >= mapSize[0] || y >= mapSize[1]) continue;
            const key = `${x},${y}`;
            if (occupied.has(key)) continue;
            occupied.add(key);
            out.push([x, y]);
          }
        }
      }
      while (out.length < wanted) out.push([centerX, centerY]);   // pathological rooms
      return out;
    };
    for (const roster of rosters) {
      let parts: Record<string, any>[] = [];
      for (const owner of roster.owners) {
        parts = ctx.rosterAppearance(owner);
        if (parts.length) break;
      }
      const placements: { x: number; y: number; origin: number }[] = [];
      for (const position of roster.positions) {
        // Roster markers speak the minimap/display frame (y-down), like the
        // roster rows' other minimap fields; occupancy is y-up: reflect.
        const x = Math.floor(position.x);
        const y = mapSize[1] - 1 - Math.floor(position.y);
        if (!(x >= 0 && x < mapSize[0] && y >= 0 && y < mapSize[1])) continue;
        placements.push({ x, y, origin: SPAWN_ORIGIN.roster });
        occupied.add(`${x},${y}`);
        for (const [ax, ay] of claimTiles(x, y, Math.max(0, position.count - 1))) {
          placements.push({ x: ax, y: ay, origin: SPAWN_ORIGIN.roster });
        }
      }
      if (!placements.length) {
        const wanted = Math.max(1, roster.marker_count);
        for (const [x, y] of claimTiles(Math.floor(mapSize[0] / 2), Math.floor(mapSize[1] / 2), wanted)) {
          placements.push({ x, y, origin: SPAWN_ORIGIN.roster_center });
        }
      }
      for (const place of placements) {
        const spawnIndex = spawnRows.length;
        const surfaceZ = terrainSurfaceZ(
          ctx, [place.x, place.y],
          terrainSurfaceParts.get(`${place.x},${place.y}`) || [],
          0, cellLayers.get(`${place.x},${place.y}`) || null,
        );
        inc(counts, place.origin === SPAWN_ORIGIN.roster ? 'spawn_roster' : 'spawn_roster_approx');
        spawnRows.push([
          roster.roster_slot, roomRow.record, place.x, place.y, 0, surfaceZ,
          0, -1, roster.name, -1, -1, -1, -1, -1,
          roomRow.room_field_op, place.origin,
        ]);
        if (!parts.length) inc(counts, 'spawn_unrendered');
        for (const part of parts) {
          const meshId = part.mesh;
          roomMeshes.add(meshId);
          const textureId = part.texture;
          roomTextures.add(textureId);
          let flags = ctx.meshIsSkinned(meshId) ? PF_SKINNED : 0;
          let recolorIndex = -1;
          if (part.recolors !== null && part.recolors !== undefined) {
            const colors = part.recolors.map((row: any[]) => row.map(Number));
            recolorIndex = intern(
              recolors, recolorLookup, colors.map((row: number[]) => row.join(',')).join(';'), colors,
            );
          }
          let renderTexture = -1;
          const meta = ctx.texMeta(textureId);
          if (meta.kind === 'image') {
            renderTexture = textureId;
            if (meta.alpha) flags |= PF_ALPHA;
          } else if (meta.kind === 'empty') {
            flags |= PF_AUTHORED_EMPTY;
            inc(counts, 'authored_empty');
          } else {
            flags |= PF_UNRENDERABLE_TEXTURE;
            inc(counts, 'unrenderable_texture');
          }
          spawnPartRows.push([
            spawnIndex, meshId, part.material_slot, textureId,
            renderTexture, flags, recolorIndex, part.part_index,
            part.mesh_def_slot, part.mesh_field_op, part.material_field_op,
            SPAWN_CONFIDENCE.exact_roster_owner_appearance,
            part.recolor_field_ops?.[0] ?? -1, part.recolor_field_ops?.[1] ?? -1,
            part.recolor_scope !== null && part.recolor_scope in SPAWN_RECOLOR_SCOPE
              ? SPAWN_RECOLOR_SCOPE[part.recolor_scope] : -1,
          ]);
          inc(counts, 'spawn_parts');
          bump(placementZ, 0);
        }
      }
    }
  }

  counts.spawns = spawnRows.length;
  counts.spawn_memberships = spawnMembershipRows.length;

  const collisions = collisionRows(occurrences, skinnedOccurrences);
  counts.collision = collisions.length;
  const occurrenceZ = new Map<number, number>();
  for (const hit of occurrences) bump(occurrenceZ, hit.cell[2]);

  const name = ctx.names ? (ctx.names.get(roomId) ?? null) : null;
  const shard = {
    schema: EXACT_SCHEMA,
    room: roomId,
    name,
    size: [room.w, room.h],
    map_size: mapSize,
    map_offset: mapOffset,
    layers,
    individuals: individuals.map((row: any) => row.uuid),
    individual_anchors: individualAnchors,
    occurrences: occurrenceRowsOut,
    links,
    placements: placementRows,
    spawns: spawnRows,
    spawn_parts: spawnPartRows,
    spawn_memberships: spawnMembershipRows,
    matrices,
    recolors,
    collision: collisions,
    counts,
    occurrence_z: sortedCounter(occurrenceZ),
    placement_z: sortedCounter(placementZ),
    terrain_z: sortedCounter(terrainZ),
  };
  const entry = {
    id: roomId,
    name,
    size: shard.size,
    map_size: mapSize,
    map_offset: mapOffset,
    layers,
    counts,
    z_levels: Array.from(placementZ.keys()).sort((a, b) => a - b),
    terrain_z_levels: Array.from(terrainZ.keys()).sort((a, b) => a - b),
    meshes: Array.from(roomMeshes).sort((a, b) => a - b),
    textures: Array.from(roomTextures).sort((a, b) => a - b),
  };
  return { shard, entry };
}

// Canonical, ordinal-free content signature for one room: the string whose
// hash becomes the room's diff identity `h`. Two versions of the game where
// a room is authored identically produce the same signature even when every
// registry slot, reader operation and bundle ordinal shifted: the shard is
// projected onto room-local indices plus mesh/texture CONTENT hashes and
// interned matrix/recolour VALUES, and every registry-slot or reader-op
// column is dropped (the raw ab2 bytes embed global registry slots, so a
// source-byte hash would mark every room changed on every build). Rooms then
// pair as unchanged/moved across builds by this hash exactly like every
// other asset category; the "All rooms" view is derived and deliberately
// carries no signature.
export function roomContentSignature({ shard, meshHash, imageHash }: {
  shard: any;
  meshHash: Map<number, string>;
  imageHash: Map<number, string>;
}): string {
  const hashOf = (map: Map<number, string>, ordinal: number) => map.get(ordinal) ?? `#${ordinal}`;
  const matrixOf = (index: number) => (index >= 0 ? (shard.matrices[index] || []).join(',') : '');
  const recolorOf = (index: number) => (index >= 0
    ? (shard.recolors[index] || []).map((row: number[]) => row.join(',')).join(';') : '');

  // occurrences: [record, resource, secondary, x, y, z, entry_slot, packed,
  // rotation_quarters, packed_flags, individual, role, anchor_x, anchor_y,
  // anchor_kind]: record/resource/secondary are registry slots, entry_slot
  // is an internal table pointer, and the individual index is replaced by
  // its room-local UUID. Same-cell source row order tiebreaks on the (also
  // dropped) registry record, so every projected list sorts canonically and
  // placements embed their occurrence projection instead of its row index.
  const individuals = (shard.individuals || []).map(
    (uuid: any) => Array.from(uuid || []).join(','),
  );
  const occProjection = (shard.occurrences || []).map((row: any[]) => [
    row[3], row[4], row[5], row[7], row[8], row[9],
    row[10] >= 0 ? individuals[row[10]] : '',
    row[11], row[12], row[13], row[14],
  ]);
  const occurrences = occProjection.map((row: any[]) => JSON.stringify(row)).sort();

  // placements: [occurrence, mesh, material, texture, render_texture, flags,
  // matrix, recolor, part_kind, part_index, mesh_field_op, material_field_op,
  // confidence, category_evidence]: material is a registry slot, the field
  // ops are reader identities, render_texture is derived from availability.
  const placement = (row: any[]) => JSON.stringify([
    occProjection[row[0]] ?? null,
    hashOf(meshHash, row[1]), row[3] >= 0 ? hashOf(imageHash, row[3]) : '',
    row[5], matrixOf(row[6]), recolorOf(row[7]), row[8], row[9], row[12], row[13],
  ]);
  const placements = {
    terrain: (shard.placements?.terrain || []).map(placement).sort(),
    models: (shard.placements?.models || []).map(placement).sort(),
    components: (shard.placements?.components || []).map(placement).sort(),
  };

  // Links and collision extents are deliberately absent: class-127 link
  // closure is build-decoding provenance (one validated depot closes no
  // links at all) and collision merging derives from it, so both would mark
  // every room changed on every build without being room content.

  // spawns: [record, room_record, x, y, z, surface_z, rotation_quarters,
  // direction_resource, label, ...field ops]; parts: [spawn, mesh, material,
  // texture, render_texture, flags, recolor, part_index, mesh_def_slot,
  // ...field ops]. Registry record order is not content, so the projected
  // spawns sort canonically with their parts attached.
  const partsBySpawn = new Map<number, any[][]>();
  for (const part of shard.spawn_parts || []) {
    let list = partsBySpawn.get(part[0]);
    if (!list) partsBySpawn.set(part[0], list = []);
    list.push([
      hashOf(meshHash, part[1]), part[3] >= 0 ? hashOf(imageHash, part[3]) : '',
      part[5], recolorOf(part[6]), part[7], part[11],
    ]);
  }
  const spawns = (shard.spawns || []).map((row: any[], index: number) => JSON.stringify([
    row[2], row[3], row[4], row[5], row[6], row[8], partsBySpawn.get(index) || [],
  ])).sort();

  return JSON.stringify({
    size: shard.size,
    map_size: shard.map_size,
    map_offset: shard.map_offset,
    occurrences,
    placements,
    spawns,
    individuals: [...individuals].sort(),
  });
}

// Validate the source-wide anchor accounting emitted by room shards.
export function validateAnchorCounts(counts: Record<string, number>): void {
  const occurrences = counts.occurrences || 0;
  const anchored = (counts.anchors_owner_dimensions || 0)
    + (counts.anchors_owner_bounds_alignment || 0)
    + (counts.anchors_terrain_owner_bounds || 0)
    + (counts.anchors_cell_center || 0);
  if (anchored !== occurrences) {
    throw new Error('anchor accounting does not exhaust occurrences: '
      + `anchors=${anchored}, occurrences=${occurrences}`);
  }
  const sizeEvidence = (counts.anchor_dimension_link_size_agree || 0)
    + (counts.anchor_dimension_link_size_disagree || 0);
  const centerEvidence = (counts.anchor_dimension_link_center_agree || 0)
    + (counts.anchor_dimension_link_center_disagree || 0);
  if (sizeEvidence !== centerEvidence) {
    throw new Error('class-127 dimension audit is incomplete: '
      + `size=${sizeEvidence}, center=${centerEvidence}`);
  }
  if ((counts.anchor_dimension_link_size_agree || 0)
    > (counts.anchor_dimension_link_center_agree || 0)) {
    throw new Error('equal-size class-127 trees contradict owner-dimension centers');
  }
}

// World index over the built shards' entries (derived['world:index'] body):
// the exact-package contract tables plus room entries and totals. Storage
// concerns (world placement from stitch.js, texture routing) layer on top.
export function buildWorldIndex(ctx: ShardContext, shardsMeta: any[]): any {
  const counts: Record<string, number> = {};
  const zLevels = new Set<number>();
  const terrainZLevels = new Set<number>();
  const meshes = new Set<number>();
  const textures = new Set<number>();
  for (const room of shardsMeta) {
    for (const key in room.counts) inc(counts, key, room.counts[key]);
    for (const z of room.z_levels) zLevels.add(z);
    for (const z of room.terrain_z_levels) terrainZLevels.add(z);
    for (const id of room.meshes) meshes.add(id);
    for (const id of room.textures) textures.add(id);
  }
  const totals = {
    rooms: shardsMeta.length,
    counts,
    z_levels: Array.from(zLevels).sort((a, b) => a - b),
    terrain_z_levels: Array.from(terrainZLevels).sort((a, b) => a - b),
    meshes: meshes.size,
    textures: textures.size,
  };
  validateAnchorCounts(counts);
  const profile = ctx.profile;
  return {
    format: 1,
    schema: EXACT_SCHEMA,
    profile: profile === null ? null : {
      name: profile.name ?? null,
      executable_sha256: profile.executable_sha256 ?? null,
      bundle0_raw_sha256: profile.bundle0?.raw_sha256 ?? null,
    },
    coordinate_system: COORDINATE_SYSTEM,
    columns: COLUMNS,
    enums: ENUMS,
    semantics: SEMANTICS,
    source_room_count: ctx.roomIds.length,
    rooms: shardsMeta,
    totals,
  };
}
