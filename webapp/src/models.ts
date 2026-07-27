// User-defined Models: a saved composite of a skeleton + a chosen SUBSET of its
// meshes, each with a pinned texture-variant (by image content hash). Unlike
// every other entity these are USER-created and deletable. Stored keyed by a
// synthetic id in the same IndexedDB 'userdata' tier as names/overrides (so they
// survive version switches and wipeAll), and bundled into asset_overrides.json
// by the topbar "overrides" manager. Mirror of names.ts.
//
// record: { id, name, skel: <skeletonHash | null: null = static, no rig
//           (a Model saved from a single static mesh)>, meshes: [{ h: <meshHash>,
//           img: <imageHash|null> }], created: <ISO> }

import { userdataGet, userdataPut } from './storage.js';
import { hashText } from './extract/hash.js';

// one drawable part of a Variant (system-catalog terminology)
export interface ModelPart {
  series_index?: number;
  mesh_hash?: string | null;
  image_hash?: string | null;
  [k: string]: any;
}

// a whole-model Variant: each choice may replace the complete
// mesh/material/texture/recolour part set
export interface ModelVariant {
  id?: string;
  name?: string;
  aliases?: string[];
  parts?: ModelPart[];
  [k: string]: any;
}

export interface ModelMeshRef { h: string; img?: string | null; [k: string]: any }

export interface ModelRecord {
  id: string;
  name?: string;
  skel?: string | null;
  meshes?: ModelMeshRef[];
  created?: string;
  source?: string;               // 'system' | 'user' (set by combineModels)
  variants?: ModelVariant[];
  appearances?: ModelVariant[];  // format-1 catalog field, kept for compat
  parts?: ModelPart[];
  [k: string]: any;
}

const KEY = 'bs.models';

function load(): { version: number; models: Record<string, ModelRecord> } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY)!);
    if (raw && typeof raw === 'object' && raw.models) return raw;
  } catch { /* fall through */ }
  return { version: 1, models: {} };
}

const cur = load();
const systemVariantChoice = new Map<string, number>();

export async function hydrateModels(): Promise<void> {
  try {
    const stored = await userdataGet('models');
    if (stored?.models) {
      for (const k of Object.keys(cur.models)) delete cur.models[k];
      Object.assign(cur.models, stored.models);
    } else if (Object.keys(cur.models).length) {
      await userdataPut('models', cur);   // one-time migration from localStorage
    }
  } catch { /* IDB unavailable: localStorage mirror still works */ }
}

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* storage unavailable */ }
  userdataPut('models', JSON.parse(JSON.stringify(cur))).catch(() => {});
}

// 16 hex chars, matching the content-hash id format the router/routes expect.
function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function listModels(): ModelRecord[] {
  return Object.values(cur.models).sort((a, b) =>
    (a.name || '').localeCompare(b.name || '') || (a.created || '').localeCompare(b.created || ''));
}
export function getModel(id: string): ModelRecord | null { return cur.models[id] || null; }
export function modelCount(): number { return Object.keys(cur.models).length; }

// The content identity a SYSTEM model is compared by across two game versions:
// sha256/16 over its skeleton content hash and a per-variant signature of its
// parts' (mesh, texture) content hashes. Synthesised the same way a string's
// `h` is, and for the same reason: it unifies a derived entity with the
// hash-keyed machinery everything else already uses.
//
// Deliberately NOT the model's own `sys-` id. Most of those ids are built from
// content, but three paths are not: models merged by name fold in the recovered
// display name, unlabeled lineage groups fold in a registry slot, and mixed-rig
// models fold in skeleton ORDINALS. A game update renumbers all three, so an
// untouched model would be reported as removed and added again, which is worse
// than not diffing it at all. Every input used here is a content hash the
// catalog attach step has already proven against the freshly decoded indexes,
// and sorting makes the result independent of the order variants and parts are
// emitted in.
//
// The recovered NAME is deliberately absent: `h` is a content identity, so a
// pure rename reads as unchanged exactly as a renamed mesh does, and a model
// that really changed re-pairs by name through PAIR_KEYS. Known limit: recolour
// data is not folded in, so a tint-only change reads as unchanged.
//
// Null when a model has no usable part hash: the diff then skips it exactly as
// it skips any other entry with no `h`, rather than inventing an identity.
// USER models never get one. They live outside any version (see the header),
// so both sides of a comparison hold the same set and "added" is meaningless.
export function systemModelDiffHash(model: ModelRecord | null | undefined): string | null {
  if (!model) return null;
  // One variant's drawable identity: its (mesh, texture) pairs. The texture
  // belongs in the key because a retexture is one of the commonest things a
  // game update does to a model, and a mesh-only key would call it unchanged.
  // Sorted but NOT de-duplicated: a part that appears twice is not the same
  // model as a part that appears once.
  const signature = (parts: unknown): string | null => {
    const pairs: string[] = [];
    for (const part of Array.isArray(parts) ? parts : []) {
      const mesh = (part as ModelPart)?.mesh_hash;
      if (typeof mesh !== 'string' || !mesh) continue;
      const image = (part as ModelPart)?.image_hash;
      pairs.push(`${mesh}>${typeof image === 'string' ? image : ''}`);
    }
    return pairs.length ? pairs.sort().join(',') : null;
  };
  // Variants are kept apart rather than merged into one pool, so losing a
  // colour variant stays visible. A model's own `parts` is its first variant's,
  // so only a catalog carrying no variants at all needs the fallback.
  //
  // The list is de-duplicated, unlike the parts within a variant. Name recovery
  // can fold a second same-named member into a model, which repeats every
  // variant verbatim and doubles its multiplicity while the game's model has
  // not changed at all. Counting those repeats would turn OUR merge decision
  // into a content difference: measured across one update it invented four
  // changes, and dropping them lost none of the real ones.
  const variants = modelVariants(model);
  const signatures = [...new Set(
    (variants.length ? variants.map((v) => signature(v?.parts)) : [signature(model.parts)])
      .filter((s): s is string => !!s),
  )].sort();
  if (!signatures.length) return null;
  return hashText(JSON.stringify({ skel: model.skel || null, variants: signatures }));
}

// System models are supplied by the active version's static catalog; user
// models remain in this store. Keep the combination pure so switching game
// versions cannot persist or mutate built-ins.
export function combineModels(systemModels: ModelRecord[] = [], userModels: ModelRecord[] = listModels()): ModelRecord[] {
  return [
    ...(systemModels || []).map((model) => ({ ...model, source: 'system' })),
    ...(userModels || []).map((model) => ({ ...model, source: model.source || 'user' })),
  ].sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id));
}

// `appearances` is the format-1 catalog field retained for backwards
// compatibility. In the editor these are whole-model Variants: each choice may
// replace the complete mesh/material/texture/recolour part set.
export function modelVariants(model: ModelRecord | null | undefined): ModelVariant[] {
  if (Array.isArray(model?.variants)) return model.variants;
  return Array.isArray(model?.appearances) ? model.appearances : [];
}

export function modelVariantIndex(model: ModelRecord): number {
  const variants = modelVariants(model);
  if (!variants.length) return 0;
  const selected = systemVariantChoice.get(model.id) ?? 0;
  return Number.isInteger(selected) && selected >= 0 && selected < variants.length
    ? selected : 0;
}

export function setModelVariant(model: ModelRecord, index: number): boolean {
  const variants = modelVariants(model);
  if (!Number.isInteger(index) || index < 0 || index >= variants.length) return false;
  systemVariantChoice.set(model.id, index);
  return true;
}

export function modelVariant(model: ModelRecord): ModelVariant | null {
  const variants = modelVariants(model);
  return variants[modelVariantIndex(model)] || null;
}

export function modelVariantLabels(model: ModelRecord): string[] {
  const variants = modelVariants(model);
  const base = variants.map((variant, index) => {
    const names = [variant.name, ...(Array.isArray(variant.aliases) ? variant.aliases : [])]
      .filter((name) => typeof name === 'string' && name);
    return names.join(' / ') || `Variant ${index + 1}`;
  });
  const totals = new Map<string, number>();
  for (const label of base) totals.set(label, (totals.get(label) || 0) + 1);
  const seen = new Map<string, number>();
  return variants.map((variant, index) => {
    const label = base[index];
    if (totals.get(label) === 1) return label;
    const number = (seen.get(label) || 0) + 1;
    seen.set(label, number);
    const textures = [...new Set((variant.parts || []).map((part) => (
      typeof part.image_hash === 'string' ? part.image_hash.slice(0, 8) : null
    )).filter(Boolean))];
    const hint = textures.join('+') || (typeof variant.id === 'string' ? variant.id.slice(-8) : 'exact');
    return `${label} ${number} · ${hint}`;
  });
}

export function modelParts(model: ModelRecord | null | undefined): ModelPart[] {
  const variant = model ? modelVariant(model) : null;
  if (Array.isArray(variant?.parts)) return variant.parts;
  if (Array.isArray(model?.parts)) return model.parts;
  return (model?.meshes || []).map((part, index) => ({
    series_index: index,
    mesh_hash: part.h,
    image_hash: part.img || null,
  }));
}

// Compatibility exports for extensions compiled against the original editor
// terminology. New UI code uses Variant throughout.
export const modelAppearanceIndex = modelVariantIndex;
export const setModelAppearance = setModelVariant;
export const modelAppearance = modelVariant;

export function modelMeshCount(model: ModelRecord | null | undefined): number { return modelParts(model).length; }

// Create (or overwrite by id) a model. Returns the stored record.
export function saveModel({ id, name, skel, meshes, created }: {
  id?: string | null; name?: string | null; skel: string | null;
  meshes?: ModelMeshRef[] | null; created?: string | null;
}): ModelRecord {
  const mid = id || newId();
  const rec: ModelRecord = {
    id: mid,
    name: (name || '').trim() || 'Untitled model',
    skel,
    meshes: (meshes || []).map((m) => ({ h: m.h, img: m.img || null })),
    created: created || new Date().toISOString(),
  };
  cur.models[mid] = rec;
  save();
  return rec;
}

export function renameModel(id: string, name: string | null | undefined): void {
  const m = cur.models[id];
  if (!m) return;
  m.name = (name || '').trim() || 'Untitled model';
  save();
}

export function deleteModel(id: string): boolean {
  if (!cur.models[id]) return false;
  delete cur.models[id];
  save();
  return true;
}

// { id: record } map for the exported asset_overrides.json
export function buildModelsSection(): Record<string, ModelRecord> { return JSON.parse(JSON.stringify(cur.models)); }

// REPLACE the local model set from a parsed { id: record } map; returns count
export function replaceModels(map: Record<string, any> | null | undefined): number {
  for (const k of Object.keys(cur.models)) delete cur.models[k];
  let n = 0;
  for (const [k, v] of Object.entries(map || {})) {
    // skel is a hash string, or null for static (rig-less) models
    if (v && typeof v === 'object' && (typeof v.skel === 'string' || v.skel === null) && Array.isArray(v.meshes)) {
      cur.models[k] = { ...v, id: k };
      n++;
    }
  }
  save();
  return n;
}
