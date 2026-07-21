// Compact browser-facing system texture/model catalog: converts the
// proof-rich models.js output (plus graph.js structural binding records)
// into the portable document consumed by the attachPortableSystemCatalog
// seam — the same shape as a user-supplied system_catalog.json file.
//
// Model/variant ids are sha256 content ids over a canonical JSON
// serialization (sorted keys, compact separators, ASCII-only escapes,
// shortest-round-trip float repr). pyJson below produces that serialization;
// it must stay byte-exact — bookmarks depend on it.

import { Sha256 } from '../hash.js';
import { isTechnicalLabel, pyTitle } from './models.js';
import { usesUniformLuminanceTint, type TextureMeta } from './shards.js';

export const COMPLETE_MODEL_RULES = new Set([
  'adjacent_scalar', 'parallel_series', 'typed_meshmat',
  'typed_component_collection', 'entity_variant',
]);
// Rules a room-spawn actor's own appearance group may carry. Used by the
// single-part card promotion: a group whose owner row is a proven room-spawn
// actor (spawns.js) is a real creature/NPC appearance even with one part.
// The junk guard is the scoping — promotion additionally requires the
// composition not to be representable by any existing card.
export const ACTOR_PROMOTABLE_RULES = new Set([
  ...COMPLETE_MODEL_RULES, 'actor_appearance', 'repeated_interleaved',
]);
export const EXACT_BINDING_ONLY_RULES = new Set([
  'nested_typed_ref', 'positional_block_face',
  'indexed_visual_inherited_material',
  'indexed_material_variant',
  'occurrence_terrain_face', 'occurrence_terrain_custom_mesh',
  'occurrence_terrain_model_part',
]);
export const EXACT_RULES = new Set([...COMPLETE_MODEL_RULES, ...EXACT_BINDING_ONLY_RULES]);

export const PORTABLE_KIND = 'brighter-atlas-system-catalog';
export const PORTABLE_FORMAT = 2;

export const BINDING_COLUMNS = [
  'owner_slot', 'mesh_field_op', 'material_field_op', 'series_index',
  'ab5_mesh', 'material_handle', 'ab3_textures', 'rule',
  'confidence', 'matrix', 'recolor', 'context',
];

const isInt = (value: unknown): value is number => Number.isInteger(value);

// ------------------------------------------------- canonical json

// String comparison by code point (canonical JSON key order).
export function codePointCompare(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return (a.length - i) - (b.length - j);
}

// Shortest round-trip float repr: fixed notation for -4 <= exponent < 16,
// otherwise d.ddde±NN with a two-digit exponent.
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const neg = x < 0;
  const s = Math.abs(x).toString();
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(s)!;
  const intPart = m[1];
  const fracPart = m[2] || '';
  const e = m[3] ? parseInt(m[3], 10) : 0;
  let exp10;
  if (intPart !== '0') {
    exp10 = intPart.length - 1 + e;
  } else {
    exp10 = -(/^0*/.exec(fracPart)![0].length) - 1 + e;
  }
  let digits = (intPart + fracPart).replace(/^0+/, '').replace(/0+$/, '');
  if (!digits) digits = '0';
  let out;
  if (exp10 >= -4 && exp10 < 16) {
    if (exp10 >= 0) {
      out = digits.length <= exp10 + 1
        ? `${digits}${'0'.repeat(exp10 + 1 - digits.length)}.0`
        : `${digits.slice(0, exp10 + 1)}.${digits.slice(exp10 + 1)}`;
    } else {
      out = `0.${'0'.repeat(-exp10 - 1)}${digits}`;
    }
  } else {
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    out = `${mantissa}e${exp10 < 0 ? '-' : '+'}${String(Math.abs(exp10)).padStart(2, '0')}`;
  }
  return neg ? `-${out}` : out;
}

const STRING_ESCAPES: Record<string, string> = {
  '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f',
  '\n': '\\n', '\r': '\\r', '\t': '\\t',
};

function pyJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const escape = STRING_ESCAPES[ch];
    if (escape) {
      out += escape;
      continue;
    }
    const code = s.charCodeAt(i);
    out += code < 0x20 || code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }
  return `${out}"`;
}

// Numbers under these keys are floats (native float32 payloads); a bare
// integral double there must still serialize as "1.0".
const FLOAT_KEYS = new Set(['local_matrix', 'recolors', 'recolors_observed']);

// Canonical JSON: sorted keys, compact separators, ASCII-only escapes.
export function pyJson(value: any, floatMode = false): string {
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    return floatMode || !isInt(value) || Object.is(value, -0)
      ? pyFloatRepr(value) : String(value);
  }
  if (type === 'string') return pyJsonString(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => pyJson(v, floatMode)).join(',')}]`;
  }
  const keys = Object.keys(value).sort(codePointCompare);
  return `{${keys.map((key) => `${pyJsonString(key)}:${pyJson(value[key], floatMode || FLOAT_KEYS.has(key))}`).join(',')}}`;
}

const UTF8 = new TextEncoder();

function contentId(prefix: string, encoded: string): string {
  const digest = new Sha256().update(UTF8.encode(encoded)).digest();
  let hex = '';
  for (let i = 0; i < 8; i++) hex += digest[i].toString(16).padStart(2, '0');
  return prefix + hex;
}

// ------------------------------------------------------------- validation

function fail(message: string): never {
  throw new Error(message);
}

// The format-2 artifact's embedded bundle signatures -> Map<number, sig>.
export function embeddedBundleProfile(assetModels: any): Map<number, any> {
  if (assetModels?.format !== 2) {
    fail(`asset-model catalog format ${assetModels?.format} is not supported`);
  }
  const raw = assetModels.profile?.profile?.asset_bundles;
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) {
    fail('asset-model catalog has no embedded asset-bundle profile');
  }
  const out = new Map<number, any>();
  for (const [key, signature] of Object.entries(raw) as [string, any][]) {
    const number = Number(key);
    if (!isInt(number)) fail(`invalid bundle number in asset-model profile: ${key}`);
    if (!signature || typeof signature !== 'object') {
      fail(`invalid profile record for assetBundle${number}`);
    }
    if (!isInt(signature.size) || !signature.sha256) {
      fail(`incomplete profile record for assetBundle${number}`);
    }
    out.set(number, signature);
  }
  return out;
}

// Validate the embedded bundle profile against pre-computed signatures: the
// browser ingest already holds every bundle's exact size + sha256.
export function checkedBundleProfile(assetModels: any, bundleSignatures: any): {
  name: string | null;
  bundle_sha256: string | null;
  asset_bundles: Record<string, { size: number; sha256: string }>;
} {
  const expected = embeddedBundleProfile(assetModels);
  const checked: Record<string, { size: number; sha256: string }> = {};
  const problems = [];
  for (const number of [...expected.keys()].sort((a, b) => a - b)) {
    const signature = expected.get(number)!;
    const actual = bundleSignatures?.[String(number)] ?? bundleSignatures?.[number];
    if (!actual || !isInt(actual.size) || !actual.sha256) {
      problems.push(`assetBundle${number}: missing`);
      continue;
    }
    if (actual.size !== signature.size) {
      problems.push(`assetBundle${number}: size ${actual.size} != catalog ${signature.size}`);
      continue;
    }
    if (actual.sha256 !== signature.sha256) {
      problems.push(`assetBundle${number}: sha256 ${actual.sha256} != catalog ${signature.sha256}`);
      continue;
    }
    checked[String(number)] = { size: actual.size, sha256: actual.sha256 };
  }
  if (problems.length) {
    fail('asset-model profile does not match the selected game bundles; '
      + `refusing to mix versions:\n  ${problems.join('\n  ')}`);
  }
  const source = assetModels.profile?.profile || {};
  return {
    name: source.name ?? null,
    bundle_sha256: source.bundle_sha256 ?? null,
    asset_bundles: checked,
  };
}

function indexByOrdinal(index: any[], label: string): Map<number, any> {
  const out = new Map<number, any>();
  for (const entry of index) {
    const ordinal = entry?.i;
    if (!isInt(ordinal) || out.has(ordinal)) {
      fail(`${label} index has invalid/duplicate ordinal ${ordinal}`);
    }
    out.set(ordinal, entry);
  }
  return out;
}

class Interner {
  table: any[];
  lookup: Map<string, number>;

  constructor() {
    this.table = [];
    this.lookup = new Map();
  }

  intern(value: any): number | null {
    if (value === null || value === undefined) return null;
    const key = pyJson(value);
    let index = this.lookup.get(key);
    if (index === undefined) {
      index = this.table.length;
      this.lookup.set(key, index);
      this.table.push(value);
    }
    return index;
  }
}

// Normalise native two/three-colour records to the portable contract.
export function portableRecolor(source: any, context: string): {
  complete: boolean;
  field: string;
  schema: string | null;
  values: any[];
} | null {
  const hasComplete = 'recolors' in source;
  const hasObserved = 'recolors_observed' in source;
  if (hasComplete && hasObserved) fail(`${context} carries both complete and observed recolours`);
  if (!hasComplete && !hasObserved) return null;
  const values = hasComplete ? source.recolors : source.recolors_observed;
  const schema = source.recolor_schema ?? null;
  if (schema !== null && schema !== 'two_tints_modulation' && schema !== 'uniform_tint_modulation') {
    fail(`${context} has invalid recolour schema`);
  }
  const expected = hasObserved || schema === 'uniform_tint_modulation' ? 2 : 3;
  if (!Array.isArray(values) || values.length !== expected) {
    fail(`${context} has invalid recolours`);
  }
  if (hasObserved && schema !== null) fail(`${context} observed recolours carry a complete schema`);
  if (values.some((color: any) => !Array.isArray(color) || color.length !== 4
      || color.some((component: any) => typeof component !== 'number' || !Number.isFinite(component)))) {
    fail(`${context} has invalid recolours`);
  }
  return {
    complete: hasComplete,
    field: hasComplete ? 'recolors' : 'recolors_observed',
    schema,
    values,
  };
}

function assetRef(index: Map<number, any>, ordinal: number, label: string): Record<string, any> {
  const entry = index.get(ordinal);
  if (entry === undefined) fail(`asset-model catalog references absent ${label} ordinal ${ordinal}`);
  return { [label]: ordinal, [`${label}_hash`]: entry.h ?? null };
}

// False only for a known empty/unexported image container; absent payload
// metadata is unknown rather than empty.
function hasExportedImage(entry: any): boolean {
  if ('entries' in entry) return Boolean(entry.entries?.length);
  if ('f' in entry) return Boolean(entry.f?.length);
  return true;
}

// ------------------------------------------------------------ content ids

function partVisualSignature(part: any) {
  return {
    series_index: part.series_index,
    mesh: part.mesh,
    material: part.material,
    textures: part.textures.map((texture: any) => texture.image),
    local_matrix: part.local_matrix ?? null,
    recolors: part.recolors ?? null,
    recolors_observed: part.recolors_observed ?? null,
    recolor_schema: part.recolor_schema ?? null,
  };
}

function partBaseSignature(part: any) {
  return {
    series_index: part.series_index,
    mesh: part.mesh_hash || part.mesh,
    local_matrix: part.local_matrix ?? null,
  };
}

function systemModelId(parts: any[], skeletonHash: string | null = null): string {
  return contentId('sys-', pyJson({
    skeleton: skeletonHash,
    parts: parts.map(partBaseSignature),
  }));
}

function modelVariantId(parts: any[]): string {
  return contentId('var-', pyJson(parts.map(partVisualSignature)));
}

function namedSystemModelId(kind: string, nameKey: string, skeletonHash: string | null): string {
  return contentId('sys-', pyJson({ kind, name: nameKey, skeleton: skeletonHash }));
}

// -------------------------------------------------------- names/coalescing

// NFKC + whitespace folding + casefold. JS has no true casefold();
// toLowerCase() is equivalent for the recovered ASCII game labels.
export function normaliseModelName(name: string): string {
  return name.normalize('NFKC').split(/[\s\x1c-\x1f\x85]+/u).filter(Boolean).join(' ').toLowerCase();
}

const GENERIC_MODEL_NAMES = new Set([
  'appearance', 'default', 'female', 'human', 'male', 'model', 'npc',
  'unknown', 'unnamed', 'variant',
]);

const NAME_KIND_RANK: Record<string, number> = {
  entity_family: -1,
  direct_family_string: 0,
  owner_label_string: 1,
  mutual_reference_label: 1,
  one_hop_technical_string: 2,
  entity_family_variant: 3,
};
const OWNERLESS = 2 ** 63;

const TRUSTED_DIRECT_NAME_KINDS = new Set([
  'direct_family_string', 'owner_label_string', 'mutual_reference_label',
]);

interface NamedModelIdentity {
  kind: string;
  name_key: string;
  name: string | null;
  skeleton: string | null;
  lineage: number | null;
}

// Safe grouping identity, or null. Entity families group on their exact
// family-owner lineage — the native family row already proves every variant
// belongs to one creature, so neither a display name nor a shared rig is
// required (a family may mix body meshes, attachments and rig kinds).
// Direct display strings still require one rig+skeleton.
function trustedNamedModelIdentity(model: any): NamedModelIdentity | null {
  // A room-spawn-promoted card never joins a name-coalesced group: letting it
  // in would flip a previously single-member group onto the named-group id
  // and break the pre-existing card's stable identity/bookmarks.
  if (model.actor_promoted === true) return null;
  const familyNames = new Map<string, Set<string>>();
  const familyOwners = new Set<number>();
  for (const source of model.sources || []) {
    const owner = source.entity_family_owner_slot;
    if (!isInt(owner)) continue;
    familyOwners.add(owner);
    const name = source.entity_family_name;
    if (typeof name === 'string' && name.trim()) {
      const key = normaliseModelName(name);
      let display = familyNames.get(key);
      if (!display) familyNames.set(key, display = new Set());
      display.add(name.trim());
    }
  }
  if (familyOwners.size === 1) {
    const lineage = familyOwners.values().next().value!;
    if (familyNames.size === 1) {
      const [nameKey, displayNames] = familyNames.entries().next().value!;
      if (!GENERIC_MODEL_NAMES.has(nameKey)) {
        return {
          kind: 'entity_family',
          name_key: nameKey,
          name: [...displayNames].sort((a, b) => codePointCompare(a.toLowerCase(), b.toLowerCase())
            || codePointCompare(a, b))[0],
          skeleton: null,
          lineage,
        };
      }
    }
    if (!familyNames.size) {
      // No family display label; the lineage plus the variants' stable
      // technical identifiers still prove one selectable model.
      return {
        kind: 'entity_family_lineage',
        name_key: `lineage:${lineage}`,
        name: null,
        skeleton: null,
        lineage,
      };
    }
  }

  const skeletonHash = model.skel;
  if (model.rig !== 'single' || typeof skeletonHash !== 'string') return null;

  const directNames = new Map<string, Set<string>>();
  for (const source of model.sources || []) {
    const provenance = source.source_name_provenance || {};
    const name = source.source_name;
    if (TRUSTED_DIRECT_NAME_KINDS.has(provenance.kind) && typeof name === 'string' && name.trim()) {
      const key = normaliseModelName(name);
      let display = directNames.get(key);
      if (!display) directNames.set(key, display = new Set());
      display.add(name.trim());
    }
  }
  if (directNames.size === 1) {
    const [nameKey, displayNames] = directNames.entries().next().value!;
    if (!GENERIC_MODEL_NAMES.has(nameKey) && !nameKey.startsWith('recovered model ')) {
      return {
        kind: 'direct_family_string',
        name_key: nameKey,
        name: [...displayNames].sort((a, b) => codePointCompare(a.toLowerCase(), b.toLowerCase())
          || codePointCompare(a, b))[0],
        skeleton: skeletonHash,
        lineage: null,
      };
    }
  }
  return null;
}

// Combine proven identity groups into whole-model variants. Entity families
// merge without a rig requirement; an unnamed lineage keys its portable id
// on the variants' build-stable technical identifiers.
function coalesceNamedModels(models: any[]): any[] {
  const identities = new Map(models.map((model) => [model.id, trustedNamedModelIdentity(model)]));
  const entityLineages = new Map<string, Set<number | null>>();
  for (const identity of identities.values()) {
    if (!identity || identity.kind !== 'entity_family') continue;
    const base = `${identity.name_key}\u0000${identity.skeleton}`;
    let lineages = entityLineages.get(base);
    if (!lineages) entityLineages.set(base, lineages = new Set());
    lineages.add(identity.lineage);
  }

  const grouped = new Map<string, { identity: NamedModelIdentity; models: any[] }>();
  const untouched = [];
  for (const model of [...models].sort((a, b) => codePointCompare(a.id, b.id))) {
    const identity = identities.get(model.id);
    if (!identity) {
      untouched.push(model);
      continue;
    }
    if (identity.kind === 'entity_family'
        && entityLineages.get(`${identity.name_key}\u0000${identity.skeleton}`)!.size !== 1) {
      // Same family name + rig but more than one exact lineage: a
      // generic-name collision, not evidence for one selectable model.
      untouched.push(model);
      continue;
    }
    const key = `${identity.kind}\u0000${identity.name_key}\u0000${identity.skeleton}`;
    let group = grouped.get(key);
    if (!group) grouped.set(key, group = { identity, models: [] });
    group.models.push(model);
  }

  const combined = [...untouched];
  // Groups sort by the (kind, name_key, skeleton) tuple; null skeletons only
  // occur on entity kinds whose groups never differ by skeleton alone.
  const cmpNullable = (a: any, b: any) => codePointCompare(String(a ?? ''), String(b ?? ''));
  const sortedGroups = [...grouped.values()].sort((a, b) => codePointCompare(a.identity.kind, b.identity.kind)
    || cmpNullable(a.identity.name_key, b.identity.name_key)
    || cmpNullable(a.identity.skeleton, b.identity.skeleton));
  for (const group of sortedGroups) {
    const members = group.models;
    if (members.length === 1) {
      // Preserve deep links when there is nothing to combine: the portable
      // family id exists only for a genuine 2+ composition coalescence.
      combined.push(members[0]);
      continue;
    }
    const { kind, name_key: nameKey, skeleton } = group.identity;
    const merged = { ...members[0] };
    const entityKind = kind === 'entity_family' || kind === 'entity_family_lineage';
    if (entityKind) {
      // A family's variants may use different body meshes, attachment parts
      // and rigs; the portable id must not depend on which member happened
      // to be first.
      let idKey = nameKey;
      if (kind === 'entity_family_lineage') {
        const labels = new Set<string>();
        for (const member of members) {
          for (const source of member.sources) {
            if (typeof source.entity_variant_name === 'string') labels.add(source.entity_variant_name);
          }
        }
        const sortedLabels = [...labels].sort(codePointCompare);
        idKey = sortedLabels.join('|') || nameKey;
      }
      merged.id = namedSystemModelId(kind, idKey, skeleton);
      const rigs = new Set(members.map((member) => member.rig));
      const skels = new Set(members.map((member) => member.skel));
      const skelIs = new Set(members.map((member) => member.skel_i));
      merged.rig = rigs.size === 1 ? members[0].rig : 'mixed';
      merged.skel = skels.size === 1 ? skels.values().next().value : null;
      merged.skel_i = skelIs.size === 1 ? skelIs.values().next().value : null;
      const skeletons = new Set<number>();
      for (const member of members) {
        for (const skeletonI of member.skeletons || []) skeletons.add(skeletonI);
      }
      merged.skeletons = [...skeletons].sort((a, b) => a - b);
    } else {
      merged.id = namedSystemModelId(kind, nameKey, skeleton);
    }
    merged.sources = [];
    const variants = new Map<string, any>();
    for (const member of members) {
      if (!entityKind && (member.rig !== merged.rig || member.skel !== skeleton)) {
        fail('named model grouping crossed incompatible rigs');
      }
      merged.sources.push(...member.sources);
      for (const variant of member.variants) {
        const existing = variants.get(variant.id);
        if (existing === undefined) {
          variants.set(variant.id, { ...variant, sources: [...variant.sources] });
        } else {
          if (modelVariantId(existing.parts) !== modelVariantId(variant.parts)) {
            fail('variant id collision while grouping named models');
          }
          existing.sources.push(...variant.sources);
        }
      }
    }
    merged.variants = [...variants.values()];
    merged.variant_group = {
      kind, name: group.identity.name, name_key: nameKey, skeleton,
    };
    combined.push(merged);
  }
  return combined;
}

// Deterministic labels and the default whole-model variant.
function finalizeSystemModel(model: any): void {
  const candidates: [number, number, string][] = [];
  for (const source of model.sources) {
    const familyName = source.entity_family_name;
    if (typeof familyName === 'string' && familyName) {
      const owner = source.entity_family_owner_slot;
      candidates.push([NAME_KIND_RANK.entity_family, isInt(owner) ? owner : OWNERLESS, familyName]);
    }
    const name = source.source_name;
    if (typeof name !== 'string' || !name) continue;
    const provenance = source.source_name_provenance || {};
    const owner = source.owner_slot;
    candidates.push([
      NAME_KIND_RANK[provenance.kind] ?? 2,
      isInt(owner) ? owner : OWNERLESS,
      name,
    ]);
  }
  candidates.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || codePointCompare(a[2], b[2]));
  const names: string[] = [];
  for (const [, , name] of candidates) if (!names.includes(name)) names.push(name);
  delete model.aliases;
  if (names.length) {
    model.name = names[0];
    if (names.length > 1) model.aliases = names.slice(1);
  }

  for (const variant of model.variants) {
    // Unlike the whole-model name, a variant is named best by its own
    // entity-variant provenance ("Slimy Fire Toad"); annotation labels
    // attached to the same visual owner are aliases.
    const ranked: [number, number, string][] = [];
    for (let order = 0; order < variant.sources.length; order++) {
      const source = variant.sources[order];
      const name = source.source_name;
      if (typeof name !== 'string' || !name) continue;
      const kind = (source.source_name_provenance || {}).kind;
      ranked.push([kind === 'entity_family_variant' ? 0 : 1, order, name]);
    }
    ranked.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const variantNames: string[] = [];
    for (const [, , name] of ranked) if (!variantNames.includes(name)) variantNames.push(name);
    delete variant.aliases;
    if (variantNames.length) {
      variant.name = variantNames[0];
      if (variantNames.length > 1) variant.aliases = variantNames.slice(1);
    }
  }
  const variantIndex = (variant: any): number => {
    let minimum = OWNERLESS;
    for (const source of variant.sources) {
      if (isInt(source.entity_variant_index)) minimum = Math.min(minimum, source.entity_variant_index);
    }
    return minimum;
  };
  model.variants.sort((a: any, b: any) => ((a.synthesized ? 1 : 0) - (b.synthesized ? 1 : 0))
    || (variantIndex(a) - variantIndex(b))
    || codePointCompare(a.name, b.name) || codePointCompare(a.id, b.id));
  model.parts = model.variants[0].parts;
}

// Add unnamed texture variants for authored skins no variant selects: each
// unused *exact* per-mesh variant becomes one explicitly synthesized
// whole-model variant that swaps a single part's material. Member
// exclusivity has already kept attachment/body skins apart in the per-mesh
// projection, and materials selected by any named variant are skipped.
function synthesizeTextureVariants(model: any, meshSystem: Map<number, any>, maxNew = 40): number {
  if (!model.variants?.length) return 0;
  const usedMaterials = new Set<number>();
  for (const variant of model.variants) {
    for (const part of variant.parts) usedMaterials.add(part.material);
  }
  const existingIds = new Set(model.variants.map((variant: any) => variant.id));
  const base = model.variants[0];
  let added = 0;
  let counter = 1;
  for (let partIndex = 0; partIndex < base.parts.length; partIndex++) {
    const part = base.parts[partIndex];
    const system = meshSystem.get(part.mesh);
    if (system === undefined) continue;
    for (const option of system.variants) {
      if (!option.exact || usedMaterials.has(option.material)) continue;
      const newPart = { ...part };
      newPart.material = option.material;
      newPart.textures = option.textures;
      newPart.image = option.image;
      newPart.image_hash = option.image_hash ?? null;
      newPart.binding = option.bindings[0];
      for (const key of ['recolors', 'recolors_observed', 'recolor_schema']) {
        delete newPart[key];
        if (key in option) newPart[key] = option[key];
      }
      const parts = base.parts.map(
        (existingPart: any, index: number) => (index === partIndex ? newPart : existingPart),
      );
      const variantId = modelVariantId(parts);
      if (existingIds.has(variantId)) continue;
      existingIds.add(variantId);
      usedMaterials.add(option.material);
      model.variants.push({
        id: variantId,
        name: `Texture variant ${counter}`,
        parts,
        sources: [{
          kind: 'mesh_texture_variant',
          part_index: partIndex,
          mesh: part.mesh,
          material: option.material,
          rules: [...(option.rules || [])],
          exact: Boolean(option.exact),
        }],
        synthesized: true,
      });
      counter++;
      added++;
      if (added >= maxNew) return added;
    }
  }
  return added;
}

function profileSummary(assetModels: any) {
  const source = assetModels.profile?.profile || {};
  return { name: source.name ?? null, bundle_sha256: source.bundle_sha256 ?? null };
}

// A card already carrying any authored name candidate (entity family label or
// annotated source name) must never be renamed by a spawn label.
function hasAuthoredName(model: any): boolean {
  for (const source of model.sources || []) {
    if (typeof source.entity_family_name === 'string' && source.entity_family_name.trim()) return true;
    if (typeof source.source_name === 'string' && source.source_name.trim()) return true;
  }
  return false;
}

// Technical spawn labels ("q1_4s_feral_cat") display like entity-variant
// technical identifiers do; authored labels ("Lucy") pass through untouched.
function spawnLabelDisplay(label: string): string {
  return isTechnicalLabel(label) ? pyTitle(label.replace(/_/g, ' ')) : label;
}

// Name otherwise-unnamed cards from room-spawn actor labels: each labeled
// actor whose complete appearance composition a card can represent is
// assigned to its most specific such card (smallest variant mesh set, id as
// the tiebreak); a card matched by exactly one distinct label takes that
// label as its display name. Ambiguous cards keep their recovered fallback
// but retain the label set as provenance. Returns the number of cards named.
function applySpawnLabels(
  systemModels: any[],
  actors: { owner_slot: number; label: string | null; meshes: number[] }[],
): number {
  if (!actors.length || !systemModels.length) return 0;
  const meshSets = systemModels.map((model) => {
    const meshSet = new Set<number>();
    for (const variant of model.variants || []) {
      for (const part of variant.parts || []) meshSet.add(part.mesh);
    }
    return meshSet;
  });
  const byModel = new Map<number, Map<string, number[]>>(); // model idx -> label -> actor slots
  for (const actor of actors) {
    if (!actor.label) continue;
    let best = -1;
    for (let index = 0; index < systemModels.length; index++) {
      const meshSet = meshSets[index];
      if (!meshSet.size || !actor.meshes.every((mesh) => meshSet.has(mesh))) continue;
      if (best === -1 || meshSet.size < meshSets[best].size
          || (meshSet.size === meshSets[best].size
            && codePointCompare(systemModels[index].id, systemModels[best].id) < 0)) {
        best = index;
      }
    }
    if (best === -1) continue;
    let labels = byModel.get(best);
    if (!labels) byModel.set(best, labels = new Map());
    let slots = labels.get(actor.label);
    if (!slots) labels.set(actor.label, slots = []);
    slots.push(actor.owner_slot);
  }
  let named = 0;
  for (const [index, labels] of byModel) {
    const model = systemModels[index];
    if (hasAuthoredName(model)) continue;
    const sorted = [...labels.keys()].sort(codePointCompare);
    model.spawn_labels = sorted;
    let label: string | null = null;
    if (sorted.length === 1) {
      label = sorted[0];
    } else {
      // Shared-base labels ("Street Hag" / "Powerful Street Hag"): when one
      // label is a word-boundary suffix of every other, it is the family
      // base name; the longer labels keep their qualifiers as variants.
      for (const candidate of [...sorted].sort((a, b) => a.length - b.length)) {
        if (sorted.every((other) => other === candidate || other.endsWith(` ${candidate}`))) {
          label = candidate;
          break;
        }
      }
    }
    if (label === null) continue;
    model.name = spawnLabelDisplay(label);
    model.spawn_label = {
      label,
      actor_slots: (labels.get(label) || []).slice().sort((a, b) => a - b),
    };
    named++;
  }
  return named;
}

// Rename enemy cards from the roaming-enemy definition catalog: a card whose
// source owners resolve to exactly one enemy base name takes it, unless a
// STRONG authored name (entity family, direct family string) or an in-room
// spawn label already names the card. The weak annotation tiers
// (owner_label_string, one_hop, mutual_reference_label) are exactly the ones
// that pick up the per-tier QUALIFIER rows ("Powerful"), so the base name
// outranks them and the qualifier survives as an alias.
const ENEMY_OVERRIDABLE_NAME_KINDS = new Set([
  'owner_label_string', 'one_hop_technical_string', 'mutual_reference_label',
]);

// Maintainer rule: same-named creature cards are ONE Models entry. Cards
// sharing a resolved display name AND rig identity merge — including the
// actor-promoted/parallel-series cards the trusted-identity guard excludes —
// with variants = the union across the merged compositions. Same name on a
// DIFFERENT rig stays separate; unnamed/fallback-named cards never merge.
// The merged id is deterministic from the merged identity (name + rig
// signature), so it is stable across re-extractions; member ids and owner
// slots are retained as provenance in name_group/sources.
function mergeSameNameModels(systemModels: any[]): {
  models: any[]; merged_groups: number; entries_removed: number; max_variants: number;
} {
  const grouped = new Map<string, any[]>();
  const out: any[] = [];
  for (const model of systemModels) {
    const name = typeof model.name === 'string' ? model.name.trim() : '';
    if (!name || /^Recovered model /.test(name)) { out.push(model); continue; }
    const rigKey = model.rig === 'single' && typeof model.skel === 'string' ? model.skel
      : model.rig === 'static' ? ''
        : (model.skeletons || []).join(',');
    const key = `${normaliseModelName(name)} ${model.rig} ${rigKey}`;
    let members = grouped.get(key);
    if (!members) grouped.set(key, members = []);
    members.push(model);
  }
  let mergedGroups = 0;
  let entriesRemoved = 0;
  let maxVariants = 0;
  for (const members of grouped.values()) {
    if (members.length === 1) { out.push(members[0]); continue; }
    mergedGroups++;
    entriesRemoved += members.length - 1;
    members.sort((a, b) => codePointCompare(a.id, b.id));
    const first = members[0];
    const rigKey = first.rig === 'single' && typeof first.skel === 'string' ? first.skel
      : first.rig === 'static' ? '' : (first.skeletons || []).join(',');
    const merged = { ...first };
    // a merged card inherits the strongest single-part proof of its members
    if (members.some((member) => member.actor_promoted === true)) merged.actor_promoted = true;
    merged.id = contentId('sys-', pyJson({
      kind: 'display_name_rig_group',
      name: normaliseModelName(first.name),
      rig: first.rig,
      skeleton: rigKey,
    }));
    merged.sources = [];
    const aliases = new Set<string>();
    const skeletons = new Set<number>();
    const variants = new Map<string, any>();
    const spawnLabels = new Set<string>();
    for (const member of members) {
      merged.sources.push(...member.sources);
      for (const alias of member.aliases || []) if (alias !== merged.name) aliases.add(alias);
      for (const skeleton of member.skeletons || []) skeletons.add(skeleton);
      for (const label of member.spawn_labels || []) spawnLabels.add(label);
      if (!merged.spawn_label && member.spawn_label) merged.spawn_label = member.spawn_label;
      if (!merged.enemy_base && member.enemy_base) merged.enemy_base = member.enemy_base;
      for (const variant of member.variants) {
        const existing = variants.get(variant.id);
        if (existing === undefined) {
          variants.set(variant.id, { ...variant, sources: [...variant.sources] });
        } else {
          if (modelVariantId(existing.parts) !== modelVariantId(variant.parts)) {
            fail('variant id collision while merging same-named models');
          }
          existing.sources.push(...variant.sources);
        }
      }
    }
    if (aliases.size) merged.aliases = [...aliases].sort(codePointCompare);
    else delete merged.aliases;
    if (spawnLabels.size) merged.spawn_labels = [...spawnLabels].sort(codePointCompare);
    merged.skeletons = [...skeletons].sort((a, b) => a - b);
    merged.variants = [...variants.values()];
    // Disambiguate colliding variant display names: qualifier/alias labels
    // ("Powerful") survive untouched; structurally identical labels gain a
    // compact honest suffix (part count when it differs, else an ordinal).
    const byName = new Map<string, any[]>();
    for (const variant of merged.variants) {
      const label = typeof variant.name === 'string' && variant.name ? variant.name : 'Variant';
      let list = byName.get(label);
      if (!list) byName.set(label, list = []);
      list.push(variant);
    }
    for (const [label, list] of byName) {
      if (list.length < 2) continue;
      const counts = new Set(list.map((variant) => variant.parts.length));
      list.sort((a, b) => codePointCompare(a.id, b.id));
      list.forEach((variant, ordinal) => {
        variant.name = counts.size === list.length
          ? `${label} · ${variant.parts.length} part${variant.parts.length === 1 ? '' : 's'}`
          : `${label} #${ordinal + 1}`;
      });
    }
    const variantIndex = (variant: any): number => {
      let minimum = OWNERLESS;
      for (const source of variant.sources) {
        if (isInt(source.entity_variant_index)) minimum = Math.min(minimum, source.entity_variant_index);
      }
      return minimum;
    };
    merged.variants.sort((a: any, b: any) => ((a.synthesized ? 1 : 0) - (b.synthesized ? 1 : 0))
      || (variantIndex(a) - variantIndex(b))
      || codePointCompare(a.name, b.name) || codePointCompare(a.id, b.id));
    merged.parts = merged.variants[0].parts;
    merged.name_group = {
      kind: 'display_name_rig_group',
      name: merged.name,
      member_ids: members.map((member) => member.id),
    };
    maxVariants = Math.max(maxVariants, merged.variants.length);
    out.push(merged);
  }
  return { models: out, merged_groups: mergedGroups, entries_removed: entriesRemoved, max_variants: maxVariants };
}

function applyEnemyBaseNames(
  systemModels: any[],
  enemyBases: Map<number, { name: string; plural: string; def_slot: number; tier_slot: number }>,
): number {
  let named = 0;
  for (const model of systemModels) {
    if (model.spawn_label) continue;
    const bases = new Map<string, { name: string; def_slot: number; tier_slot: number }>();
    for (const source of model.sources || []) {
      if (!isInt(source.owner_slot)) continue;
      const hit = enemyBases.get(source.owner_slot);
      if (hit) bases.set(hit.name, hit);
    }
    if (bases.size !== 1) continue;
    const base = bases.values().next().value!;
    let strong = false;
    for (const source of model.sources || []) {
      if (typeof source.entity_family_name === 'string' && source.entity_family_name.trim()) strong = true;
      const name = source.source_name;
      if (typeof name === 'string' && name.trim()
          && !ENEMY_OVERRIDABLE_NAME_KINDS.has(source.source_name_provenance?.kind)) {
        strong = true;
      }
    }
    if (strong || model.name === base.name) continue;
    const previous = model.name;
    model.name = base.name;
    model.enemy_base = { ...base };
    if (typeof previous === 'string' && previous.trim()
        && !/^Recovered model /.test(previous) && previous !== base.name) {
      const aliases = Array.isArray(model.aliases) ? model.aliases : [];
      if (!aliases.includes(previous)) model.aliases = [...aliases, previous];
    }
    named++;
  }
  return named;
}

// ---------------------------------------------------------------- catalog

export interface SystemCatalog {
  mesh_system: Map<number, { active: number | null; variants: Record<string, any>[] }>;
  bindings: Record<string, any>;
  models: Record<string, any>[];
  counts: Record<string, number>;
  profile?: Record<string, any>;
}

// One room-spawn actor as collected from spawns.js roomSpawns(): the actor's
// registry slot, its recovered source label (may be null) and the distinct
// AB5 meshes of its exact appearance parts.
export interface SpawnActorRef {
  owner_slot: number;
  label?: string | null;
  meshes?: number[];
}

// Convert a validated format-2 artifact ({format, profile, records, models})
// to compact web catalog objects. mesh_system is a
// Map<ab5 ordinal, {active, variants}>. spawnActors (optional) enables the
// room-spawn card promotion + spawn-label naming passes.
// texMeta (optional): worldtex render verdicts keyed by ab3 container id.
// With it, every part/variant carrying a recolor also carries the exact
// uniform-luminance-tint verdict the room renderer uses (grayscale albedo +
// equal tints + opaque packed storage), so the Models/mesh viewers can apply
// the identical full-tint shader instead of rendering those surfaces white.
export function buildSystemCatalog(
  assetModels: any, meshesIndex: any[], imagesIndex: any[], skeletonsIndex: any[],
  spawnActors: SpawnActorRef[] | null = null,
  texMeta: ((id: number) => TextureMeta | undefined) | null = null,
  enemyBases: Map<number, { name: string; plural: string; def_slot: number; tier_slot: number }> | null = null,
): SystemCatalog {
  // Uniform-luminance verdict for one recolor + its primary texture.
  const uniformTintFor = (
    colorValue: { values: any[]; schema: string | null } | null,
    textureId: number | null | undefined,
  ): boolean => {
    if (texMeta === null || colorValue === null || !isInt(textureId)) return false;
    const meta = texMeta(textureId);
    if (!meta) return false;
    return usesUniformLuminanceTint(
      { recolors: colorValue.values, recolor_schema: colorValue.schema } as any, meta,
    );
  };
  embeddedBundleProfile(assetModels); // validates format/profile shape
  const meshByI = indexByOrdinal(meshesIndex, 'mesh');
  const imageByI = indexByOrdinal(imagesIndex, 'image');
  const skelByI = indexByOrdinal(skeletonsIndex, 'skeleton');

  const rules = new Interner();
  const confidences = new Interner();
  const matrices = new Interner();
  const recolors = new Interner();
  const contexts = new Interner();
  const rows: any[][] = [];
  const perMesh = new Map<number, Map<string, Record<string, any>>>();
  let emptyTextureBindings = 0;

  const records = assetModels.records;
  if (!Array.isArray(records)) fail('asset-model catalog records must be an array');

  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex];
    const meshI = record.ab5_mesh;
    const material = record.material_handle;
    const textures = record.ab3_textures;
    if (!isInt(meshI) || !isInt(material)) {
      fail(`asset-model record ${recordIndex} has invalid mesh/material`);
    }
    if (!Array.isArray(textures) || textures.some((i: any) => !isInt(i))) {
      fail(`asset-model record ${recordIndex} has invalid textures`);
    }
    assetRef(meshByI, meshI, 'mesh');
    const textureRefs = textures.map((imageI: number) => assetRef(imageByI, imageI, 'image'));
    let texturesExported = Boolean(textures.length)
      && textures.every((imageI: number) => hasExportedImage(imageByI.get(imageI)));
    const fallbackMaterial = record.fallback_material_handle ?? null;
    const fallbackTextures = record.fallback_ab3_textures ?? null;
    if ((fallbackMaterial === null) !== (fallbackTextures === null)) {
      fail(`asset-model record ${recordIndex} has an incomplete fallback material`);
    }
    if (fallbackTextures !== null && (!isInt(fallbackMaterial)
        || !Array.isArray(fallbackTextures) || fallbackTextures.some((i: any) => !isInt(i)))) {
      fail(`asset-model record ${recordIndex} has an invalid fallback material`);
    }
    const fallbackRefs = fallbackTextures !== null
      ? fallbackTextures.map((imageI: number) => assetRef(imageByI, imageI, 'image')) : [];
    const fallbackExported = Boolean(fallbackTextures?.length)
      && (fallbackTextures || []).every((imageI: number) => hasExportedImage(imageByI.get(imageI)));
    let selectedMaterial = material;
    let selectedTextures = textures;
    let selectedRefs = textureRefs;
    let selectedFallback = false;
    if (!texturesExported && fallbackExported) {
      selectedMaterial = fallbackMaterial;
      selectedTextures = fallbackTextures;
      selectedRefs = fallbackRefs;
      texturesExported = true;
      selectedFallback = true;
    }

    const rule = record.rule;
    const confidence = record.confidence;
    if (typeof rule !== 'string' || typeof confidence !== 'string') {
      fail(`asset-model record ${recordIndex} has invalid proof metadata`);
    }
    const ruleI = rules.intern(rule);
    const confidenceI = confidences.intern(confidence);
    const matrixI = matrices.intern(record.local_matrix_game ?? null);
    const colorValue = portableRecolor(record, `asset-model record ${recordIndex}`);
    const recolorI = recolors.intern(colorValue === null ? null : {
      complete: colorValue.complete,
      schema: colorValue.schema,
      values: colorValue.values,
    });
    let contextValue = record.structural_context ?? null;
    if (contextValue !== null) {
      if (typeof contextValue !== 'object' || Array.isArray(contextValue)) {
        fail(`asset-model record ${recordIndex} has invalid structural context`);
      }
      contextValue = { ...contextValue };
      if (selectedFallback) {
        contextValue.selected_fallback = true;
        contextValue.authored_material = material;
        contextValue.authored_textures = [...textures];
      }
    }
    const contextI = contexts.intern(contextValue);
    rows.push([
      record.owner_slot ?? null, record.mesh_field_op ?? null,
      record.material_field_op ?? null, record.series_index ?? null,
      meshI, selectedMaterial, selectedTextures, ruleI, confidenceI,
      matrixI, recolorI, contextI,
    ]);

    // actor_appearance records exist to recover actor model GROUPS (their
    // mesh/material pairs are texture-wise redundant with the exact rules);
    // keeping them out of the per-mesh variant accumulation preserves the
    // pre-existing mesh_system variants and active-texture ordering exactly.
    if (rule === 'actor_appearance') continue;

    if (!texturesExported) {
      emptyTextureBindings++;
      continue;
    }
    const recolorKey = colorValue === null ? '\u0000' : pyJson(colorValue);
    const key = `${selectedMaterial}|${selectedTextures.join(',')}|${recolorKey}`;
    let variants = perMesh.get(meshI);
    if (!variants) perMesh.set(meshI, variants = new Map());
    let variant = variants.get(key);
    if (!variant) {
      variants.set(key, variant = {
        image: selectedTextures[0],
        image_hash: selectedRefs[0].image_hash,
        material: selectedMaterial,
        textures: selectedRefs,
        bindings: [],
        rules: new Set(),
        exact_uses: 0,
        inferred_uses: 0,
      });
    }
    if (colorValue !== null) {
      variant[colorValue.field] = colorValue.values;
      if (colorValue.schema !== null) variant.recolor_schema = colorValue.schema;
      if (uniformTintFor(colorValue, selectedTextures[0])) variant.uniform_luminance_tint = true;
    }
    variant.bindings.push(recordIndex);
    variant.rules.add(rule);
    if (EXACT_RULES.has(rule)) variant.exact_uses++;
    else variant.inferred_uses++;
  }

  const meshSystem: SystemCatalog['mesh_system'] = new Map();
  for (const [meshI, grouped] of perMesh) {
    const variants = [];
    for (const variant of grouped.values()) {
      variant.rules = [...variant.rules].sort(codePointCompare);
      variant.exact = variant.exact_uses > 0;
      variants.push(variant);
    }
    variants.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      const uses = (b.exact_uses + b.inferred_uses) - (a.exact_uses + a.inferred_uses);
      if (uses) return uses;
      if (a.material !== b.material) return a.material - b.material;
      const ta = a.textures;
      const tb = b.textures;
      for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
        if (ta[i].image !== tb[i].image) return ta[i].image - tb[i].image;
      }
      return ta.length - tb.length;
    });
    meshSystem.set(meshI, { active: variants.length ? 0 : null, variants });
  }

  const modelsById = new Map<string, any>();
  let emptyTextureModelSources = 0;
  const models = assetModels.models;
  if (!Array.isArray(models)) fail('asset-model catalog models must be an array');

  // Room-spawn actor table: owner slots gate the single-part promotion; the
  // label/mesh rows drive the spawn-label naming pass after coalescing.
  const actorOwners = new Set<number>();
  const actorAppearances: { owner_slot: number; label: string | null; meshes: number[] }[] = [];
  for (const actor of spawnActors || []) {
    if (!actor || !isInt(actor.owner_slot)) continue;
    const meshes = Array.isArray(actor.meshes) ? [...new Set(actor.meshes.filter(isInt))] : [];
    if (!meshes.length) continue;
    actorOwners.add(actor.owner_slot);
    actorAppearances.push({
      owner_slot: actor.owner_slot,
      label: typeof actor.label === 'string' && actor.label.trim() ? actor.label.trim() : null,
      meshes,
    });
  }

  const addModelSource = (sourceModel: any, modelIndex: number, promoted: boolean): void => {
    const sourceParts = sourceModel.parts;
    const parts = [];
    const partSkels: number[] = [];
    let texturesExported = true;
    for (let partIndex = 0; partIndex < sourceParts.length; partIndex++) {
      const sourcePart = sourceParts[partIndex];
      const meshI = sourcePart.ab5_mesh;
      const material = sourcePart.material_handle;
      const textures = sourcePart.ab3_textures;
      if (!isInt(meshI) || !isInt(material)) {
        fail(`asset-model model ${modelIndex} part ${partIndex} is malformed`);
      }
      if (!Array.isArray(textures) || textures.some((i: any) => !isInt(i))) {
        fail(`asset-model model ${modelIndex} part ${partIndex} has invalid textures`);
      }
      const meshEntry = meshByI.get(meshI);
      if (meshEntry === undefined) {
        fail(`asset-model model ${modelIndex} references absent mesh ${meshI}`);
      }
      const textureRefs = textures.map((imageI: number) => assetRef(imageByI, imageI, 'image'));
      if (!textures.length || textures.some((imageI: number) => !hasExportedImage(imageByI.get(imageI)))) {
        texturesExported = false;
        break;
      }
      const recordIndex = sourcePart.record_index;
      if (!isInt(recordIndex) || recordIndex < 0 || recordIndex >= rows.length) {
        fail(`asset-model model ${modelIndex} part ${partIndex} has invalid record reference`);
      }
      const skelI = meshEntry.skel ?? -1;
      if (skelI >= 0 && !skelByI.has(skelI)) {
        fail(`mesh ${meshI} references absent skeleton ${skelI}`);
      }
      partSkels.push(skelI);
      const part: Record<string, any> = {
        series_index: sourcePart.series_index ?? partIndex,
        mesh: meshI,
        mesh_hash: meshEntry.h ?? null,
        material,
        textures: textureRefs,
        image: textures.length ? textures[0] : null,
        image_hash: textureRefs.length ? textureRefs[0].image_hash : null,
        binding: recordIndex,
      };
      if (sourcePart.entity_attachment) part.entity_attachment = true;
      if ('local_matrix_game' in sourcePart) part.local_matrix = sourcePart.local_matrix_game;
      const partColor = portableRecolor(sourcePart, `asset-model model ${modelIndex} part ${partIndex}`);
      if (partColor !== null) {
        part[partColor.field] = partColor.values;
        if (partColor.schema !== null) part.recolor_schema = partColor.schema;
        if (uniformTintFor(partColor, textures[0])) part.uniform_luminance_tint = true;
      }
      parts.push(part);
    }

    if (!texturesExported) {
      emptyTextureModelSources++;
      return;
    }

    // buildModels already orders these, but make the contract explicit.
    parts.sort((a, b) => (a.series_index - b.series_index) || (a.binding - b.binding));
    const nonStatic = new Set(partSkels.filter((skel) => skel >= 0));
    let rigKind;
    let skelI;
    if (!nonStatic.size) {
      rigKind = 'static';
      skelI = null;
    } else if (nonStatic.size === 1 && partSkels.every((skel) => skel >= 0)) {
      rigKind = 'single';
      skelI = nonStatic.values().next().value!;
    } else {
      rigKind = 'mixed';
      skelI = null;
    }
    const skelHash = skelI !== null ? (skelByI.get(skelI)!.h ?? null) : null;
    const modelId = systemModelId(parts, skelHash);
    const variantId = modelVariantId(parts);
    const source: Record<string, any> = {
      owner_slot: sourceModel.owner_slot ?? null,
      owner_selector: sourceModel.owner_selector ?? null,
      owner_runtime: sourceModel.owner_runtime ?? null,
      mesh_field_op: sourceModel.mesh_field_op ?? null,
      material_field_op: sourceModel.material_field_op ?? null,
      rule: sourceModel.rule ?? null,
      confidence: sourceModel.confidence ?? null,
      model_index: sourceModel.model_index ?? modelIndex,
    };
    for (const field of [
      'composition_kind', 'collection_ordinal',
      'typed_container_class', 'typed_container_depth',
      'typed_collection_scope', 'catalog_index',
      'catalog_index_field_op',
      'source_name', 'source_name_provenance',
      'source_description', 'source_description_provenance',
      'source_description_aliases',
      'entity_family_owner_slot', 'entity_family_field_op',
      'entity_family_name', 'entity_owner_slot',
      'entity_visual_field_op', 'entity_variant_index',
      'entity_variant_index_field_op', 'entity_variant_name',
      'entity_predecessor_field_op', 'entity_predecessor_owner_slot',
      'material_inherited', 'material_source_owner_slot',
    ]) {
      if (field in sourceModel) source[field] = sourceModel[field];
    }
    const existing = modelsById.get(modelId);
    if (existing) {
      existing.sources.push(source);
      const variant = existing.variants.find((value: any) => value.id === variantId);
      if (variant === undefined) {
        existing.variants.push({
          id: variantId,
          name: source.source_name || 'Variant',
          parts,
          sources: [source],
        });
      } else {
        variant.sources.push(source);
      }
      return;
    }
    modelsById.set(modelId, {
      id: modelId,
      source: 'system',
      name: `Recovered model ${sourceModel.owner_slot}`,
      rig: rigKind,
      skel: skelHash,
      skel_i: skelI,
      skeletons: [...nonStatic].sort((a, b) => a - b),
      parts,
      sources: [source],
      variants: [{
        id: variantId,
        name: source.source_name || 'Variant',
        parts,
        sources: [source],
      }],
      ...(promoted ? { actor_promoted: true } : {}),
    });
  };

  const deferredActorGroups: [any, number][] = [];
  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const sourceModel = models[modelIndex];
    const sourceParts = sourceModel.parts;
    if (!Array.isArray(sourceParts) || !sourceParts.length) continue;
    if (COMPLETE_MODEL_RULES.has(sourceModel.rule)
        && (sourceParts.length >= 2 || sourceModel.rule === 'entity_variant')) {
      addModelSource(sourceModel, modelIndex, false);
    } else if (actorOwners.has(sourceModel.owner_slot)
        && ACTOR_PROMOTABLE_RULES.has(sourceModel.rule)) {
      deferredActorGroups.push([sourceModel, modelIndex]);
    }
  }

  // Room-spawn actor promotion: a proven actor's own appearance group becomes
  // a card even when it has one part — but only when no existing card already
  // represents its complete composition (the Kobold guard: named actors whose
  // family card exists must not spawn a duplicate). Same-composition promoted
  // groups then merge naturally through the content model id.
  let actorPromotedModels = 0;
  if (deferredActorGroups.length) {
    const baselineMeshSets: Set<number>[] = [];
    for (const model of modelsById.values()) {
      const meshSet = new Set<number>();
      for (const variant of model.variants) {
        for (const part of variant.parts) meshSet.add(part.mesh);
      }
      baselineMeshSets.push(meshSet);
    }
    for (const [sourceModel, modelIndex] of deferredActorGroups) {
      const meshes = [...new Set(
        sourceModel.parts.map((part: any) => part.ab5_mesh).filter(isInt),
      )] as number[];
      if (!meshes.length) continue;
      if (baselineMeshSets.some((meshSet) => meshes.every((mesh) => meshSet.has(mesh)))) continue;
      const before = modelsById.size;
      addModelSource(sourceModel, modelIndex, true);
      if (modelsById.size > before) actorPromotedModels++;
    }
  }

  for (const model of modelsById.values()) finalizeSystemModel(model);
  const systemModels = coalesceNamedModels([...modelsById.values()]);
  let synthesizedModelVariants = 0;
  for (const model of systemModels) {
    finalizeSystemModel(model);
    synthesizedModelVariants += synthesizeTextureVariants(model, meshSystem);
    finalizeSystemModel(model);
  }
  const spawnNamedModels = applySpawnLabels(systemModels, actorAppearances);
  const enemyNamedModels = enemyBases !== null && enemyBases.size
    ? applyEnemyBaseNames(systemModels, enemyBases) : 0;
  // Same-named creature cards collapse to one entry (maintainer rule); runs
  // after every naming pass so the merge sees final display names.
  const nameMerge = mergeSameNameModels(systemModels);
  const finalModels = nameMerge.models;
  finalModels.sort((a, b) => codePointCompare(a.name, b.name) || codePointCompare(a.id, b.id));

  const bindings = {
    format: 1,
    profile: profileSummary(assetModels),
    columns: [...BINDING_COLUMNS],
    rules: rules.table,
    confidences: confidences.table,
    matrices: matrices.table,
    recolors: recolors.table,
    contexts: contexts.table,
    rows,
  };
  let textureVariants = 0;
  for (const system of meshSystem.values()) textureVariants += system.variants.length;
  let modelSources = 0;
  let modelVariants = 0;
  for (const model of finalModels) {
    modelSources += model.sources.length;
    modelVariants += model.variants.length;
  }
  return {
    mesh_system: meshSystem,
    bindings,
    models: finalModels,
    counts: {
      bindings: rows.length,
      mapped_meshes: meshSystem.size,
      texture_variants: textureVariants,
      models: finalModels.length,
      model_sources: modelSources,
      model_variants: modelVariants,
      synthesized_model_variants: synthesizedModelVariants,
      empty_texture_bindings: emptyTextureBindings,
      empty_texture_model_sources: emptyTextureModelSources,
      actor_promoted_models: actorPromotedModels,
      spawn_named_models: spawnNamedModels,
      enemy_named_models: enemyNamedModels,
      name_merged_groups: nameMerge.merged_groups,
      name_merged_entries_removed: nameMerge.entries_removed,
      name_merged_max_variants: nameMerge.max_variants,
    },
  };
}

// Package the compact graph for exact browser-side attachment. Set
// catalog.profile to the checkedBundleProfile() result first.
export function buildPortableCatalog(catalog: SystemCatalog, meshesIndex: any[]): Record<string, any> {
  const profile = catalog.profile;
  const bundle0 = profile?.asset_bundles?.['0'] ?? profile?.asset_bundles?.[0];
  if (!bundle0 || !isInt(bundle0.size) || typeof bundle0.sha256 !== 'string') {
    fail('validated system catalog has no exact assetBundle0 profile');
  }
  const meshByI = indexByOrdinal(meshesIndex, 'mesh');
  const mappings = [];
  for (const ordinal of [...catalog.mesh_system.keys()].sort((a, b) => a - b)) {
    const mesh = meshByI.get(ordinal);
    if (mesh === undefined) fail(`portable system mapping references absent mesh ${ordinal}`);
    mappings.push({
      mesh: ordinal,
      mesh_hash: mesh.h ?? null,
      system: catalog.mesh_system.get(ordinal),
    });
  }
  return {
    kind: PORTABLE_KIND,
    format: PORTABLE_FORMAT,
    profile,
    counts: catalog.counts,
    mesh_system: mappings,
    models: catalog.models,
    bindings: catalog.bindings,
  };
}
