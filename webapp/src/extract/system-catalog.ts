// Portable system-catalog validation and attachment.
//
// The system catalog is produced outside the browser; its compact result
// crosses this deliberately small, data-only boundary.  A catalog is accepted
// only when:
//   * its assetBundle0 signature is the exact build being ingested; and
//   * every referenced mesh, image and skeleton content hash agrees with the
//     indexes decoded by this browser.
//
// This keeps build-bound ordinals from leaking across versions while making
// the pure conversion/validation seam straightforward to port to WASM later.

export const SYSTEM_CATALOG_KIND = 'brighter-atlas-system-catalog';
export const SYSTEM_CATALOG_FORMAT = 2;
export const LEGACY_SYSTEM_CATALOG_FORMAT = 1;

const fail = (message: string): never => { throw new Error(`system catalog: ${message}`); };

function byOrdinal(index: any[] | null | undefined, label: string): Map<number, any> {
  const out = new Map<number, any>();
  for (const entry of index || []) {
    if (!entry || !Number.isInteger(entry.i) || out.has(entry.i)) {
      fail(`${label} index has an invalid or duplicate ordinal`);
    }
    out.set(entry.i, entry);
  }
  return out;
}

function exactRef(
  ref: any, ordinalKey: string, hashKey: string,
  index: Map<number, any>, label: string, context: string,
): any {
  if (!ref || !Number.isInteger(ref[ordinalKey])) {
    fail(`${context} has no valid ${label} ordinal`);
  }
  const entry = index.get(ref[ordinalKey]);
  if (!entry) fail(`${context} references absent ${label} ${ref[ordinalKey]}`);
  if (ref[hashKey] === null || ref[hashKey] === undefined) {
    if (typeof entry.h !== 'string' || !entry.h) {
      fail(`${context} ${label} ${ref[ordinalKey]} has no decoded content hash`);
    }
    ref[hashKey] = entry.h;
  } else if (typeof ref[hashKey] !== 'string' || !ref[hashKey]) {
    fail(`${context} ${label} ${ref[ordinalKey]} has an invalid content hash`);
  } else if (entry.h !== ref[hashKey]) {
    fail(`${context} ${label} ${ref[ordinalKey]} hash ${ref[hashKey]} != decoded ${entry.h || 'missing'}`);
  }
  return entry;
}

function validateTextures(textures: any, images: Map<number, any>, context: string): void {
  if (!Array.isArray(textures)) fail(`${context} textures must be an array`);
  for (let i = 0; i < textures.length; i++) {
    exactRef(textures[i], 'image', 'image_hash', images, 'image', `${context} texture ${i}`);
  }
}

function validateBinding(binding: any, rowCount: number, context: string): void {
  if (!Number.isInteger(binding) || binding < 0 || binding >= rowCount) {
    fail(`${context} binding ${binding} is outside 0..${Math.max(0, rowCount - 1)}`);
  }
}

function validateRecolor(value: any, context: string): void {
  const complete = value?.recolors;
  const observed = value?.recolors_observed;
  const schema = value?.recolor_schema;
  if (complete !== undefined && observed !== undefined) {
    fail(`${context} carries both complete and observed recolours`);
  }
  if (schema !== undefined && !['two_tints_modulation', 'uniform_tint_modulation'].includes(schema)) {
    fail(`${context} has invalid recolour schema`);
  }
  if (observed !== undefined && schema !== undefined) {
    fail(`${context} observed recolours carry a complete schema`);
  }
  const colors = complete ?? observed;
  if (colors === undefined) return;
  const expected = observed !== undefined || schema === 'uniform_tint_modulation' ? 2 : 3;
  if (!Array.isArray(colors) || colors.length !== expected
      || colors.some((color: any) => !Array.isArray(color) || color.length !== 4
        || color.some((component: any) => !Number.isFinite(component)))) {
    fail(`${context} has invalid recolours`);
  }
}

export async function readSystemCatalog(source: any): Promise<any> {
  if (!source) return null;
  if (typeof source === 'object' && !(source instanceof Blob)) return source;
  let text;
  try { text = await source.text(); } catch (err) { fail(`cannot read file: ${err.message || err}`); }
  try { return JSON.parse(text); } catch (err) { fail(`invalid JSON: ${err.message || err}`); }
}

// Re-indexing a category for an already stored build must not erase its
// immutable system projection.  The ingest coordinator first verifies the raw
// bundle SHA-256 against the stored version, then this copies only hash-equal
// mesh rows (ordinal is merely the lookup accelerator).
export function preserveSystemMappings(nextMeshes: any, previousMeshes: any): number {
  if (!Array.isArray(nextMeshes) || !Array.isArray(previousMeshes)) return 0;
  const previous = byOrdinal(previousMeshes.filter(Boolean), 'previous mesh');
  let preserved = 0;
  for (const mesh of nextMeshes) {
    if (!mesh) continue;
    const old = previous.get(mesh.i);
    if (!old?.sys || typeof mesh.h !== 'string' || mesh.h !== old.h) continue;
    mesh.sys = old.sys;
    preserved++;
  }
  return preserved;
}

// Mutates `indexes.meshes` only after the complete catalog validates.  Returns
// the compact pieces to persist in IndexedDB and expose through manifest.system.
export function attachPortableSystemCatalog(doc: any, {
  bundle0Sha256,
  bundle0Size,
  bundleSignatures = null,
  indexes,
}: {
  bundle0Sha256?: string;
  bundle0Size?: number;
  bundleSignatures?: any;
  indexes?: any;
} = {}): { models: any; bindings: any; manifest: any } {
  if (!doc || doc.kind !== SYSTEM_CATALOG_KIND
      || ![LEGACY_SYSTEM_CATALOG_FORMAT, SYSTEM_CATALOG_FORMAT].includes(doc.format)) {
    fail(`expected ${SYSTEM_CATALOG_KIND} format ${LEGACY_SYSTEM_CATALOG_FORMAT} or ${SYSTEM_CATALOG_FORMAT}`);
  }
  const profile = doc.profile;
  const provided = bundleSignatures || {
    0: { size: bundle0Size, sha256: bundle0Sha256 },
  };
  // These are the raw stores whose ordinals/content the compact catalog uses.
  // Matching their full SHA-256 signatures also permits an exporter with a
  // stale optional per-object hash cache: missing object hashes are then filled
  // from the browser's freshly decoded indexes below.
  // New catalogs can contain occurrence-qualified terrain bindings and bind
  // assetBundle2 as well.  Keep accepting older catalogs that predate those
  // records, but never attach a structural catalog against a different AB2.
  const requiredBundles = [0, 3, 5, 6];
  if (profile?.asset_bundles?.['2'] ?? profile?.asset_bundles?.[2]) {
    requiredBundles.splice(1, 0, 2);
  }
  for (const number of requiredBundles) {
    const expected = profile?.asset_bundles?.[String(number)]
      ?? profile?.asset_bundles?.[number];
    const actual = provided?.[String(number)] ?? provided?.[number];
    if (!expected || !Number.isInteger(expected.size) || typeof expected.sha256 !== 'string') {
      fail(`profile has no exact assetBundle${number} signature`);
    }
    if (!actual || expected.size !== actual.size || expected.sha256 !== actual.sha256) {
      fail(`assetBundle${number} does not match this game build; refusing to mix versions`);
    }
  }

  if (!Array.isArray(indexes?.meshes) || !Array.isArray(indexes?.images)
      || !Array.isArray(indexes?.rigs)) {
    fail('meshes, images and rigs must be extracted before attachment');
  }
  if (!Array.isArray(doc.mesh_system) || !Array.isArray(doc.models)
      || !doc.bindings || !Array.isArray(doc.bindings.rows)) {
    fail('portable payload is incomplete');
  }

  const meshes = byOrdinal(indexes.meshes, 'mesh');
  const images = byOrdinal(indexes.images, 'image');
  const skeletons = byOrdinal(indexes.rigs, 'skeleton');
  const rowCount = doc.bindings.rows.length;
  const attachments: [any, any][] = [];
  const seenMeshes = new Set<number>();
  let variantCount = 0;

  for (let n = 0; n < doc.mesh_system.length; n++) {
    const row = doc.mesh_system[n];
    const mesh = exactRef(row, 'mesh', 'mesh_hash', meshes, 'mesh', `mapping ${n}`);
    if (seenMeshes.has(row.mesh)) fail(`duplicate mapping for mesh ${row.mesh}`);
    seenMeshes.add(row.mesh);
    const system = row.system;
    if (!system || !Array.isArray(system.variants)) fail(`mapping ${n} has no variants`);
    if (system.active !== null && system.active !== undefined
        && (!Number.isInteger(system.active) || system.active < 0 || system.active >= system.variants.length)) {
      fail(`mapping ${n} has invalid active variant`);
    }
    for (let v = 0; v < system.variants.length; v++) {
      const variant = system.variants[v];
      if (!Number.isInteger(variant?.material)) fail(`mapping ${n} variant ${v} has no material`);
      validateTextures(variant.textures, images, `mapping ${n} variant ${v}`);
      validateRecolor(variant, `mapping ${n} variant ${v}`);
      const preview = variant.textures[0];
      if (!preview || variant.image !== preview.image) {
        fail(`mapping ${n} variant ${v} preview image disagrees with its ordered texture set`);
      }
      if (variant.image_hash !== null && variant.image_hash !== undefined
          && variant.image_hash !== preview.image_hash) {
        fail(`mapping ${n} variant ${v} preview image hash disagrees with its ordered texture set`);
      }
      variant.image_hash = preview.image_hash;
      if (!Array.isArray(variant.bindings)) fail(`mapping ${n} variant ${v} bindings must be an array`);
      for (const binding of variant.bindings) {
        validateBinding(binding, rowCount, `mapping ${n} variant ${v}`);
      }
      variantCount++;
    }
    attachments.push([mesh, system]);
  }

  let modelSources = 0;
  let modelVariantCount = 0;
  const modelIds = new Set<string>();
  for (let n = 0; n < doc.models.length; n++) {
    const model = doc.models[n];
    if (!model || typeof model.id !== 'string' || !model.id.startsWith('sys-')
        || model.source !== 'system' || !Array.isArray(model.parts) || !model.parts.length) {
      fail(`model ${n} is not a valid read-only system model`);
    }
    if (modelIds.has(model.id)) fail(`duplicate model id ${model.id}`);
    modelIds.add(model.id);
    if (!Array.isArray(model.sources) || !model.sources.length) fail(`model ${n} has no source proof`);
    // A single-part composition needs a complete entity proof: an
    // entity-variant source, a room-spawn actor promotion, or membership in a
    // display-name merge group (catalog.js mergeSameNameModels: the resolved
    // creature name is itself the grouping proof).
    if (model.parts.length < 2 && model.actor_promoted !== true
        && !model.name_group
        && !model.sources.some((source: any) => source?.rule === 'entity_variant')) {
      fail(`model ${n} single-part composition has no complete entity proof`);
    }
    modelSources += model.sources.length;
    if (model.skel_i !== null && model.skel_i !== undefined) {
      const skeletonRef = { skeleton: model.skel_i, skeleton_hash: model.skel };
      exactRef(
        skeletonRef,
        'skeleton', 'skeleton_hash', skeletons, 'skeleton', `model ${n}`,
      );
      model.skel = skeletonRef.skeleton_hash;
    }
    const validatePart = (part: any, p: number, context = `model ${n}`) => {
      exactRef(part, 'mesh', 'mesh_hash', meshes, 'mesh', `${context} part ${p}`);
      validateTextures(part.textures, images, `${context} part ${p}`);
      validateRecolor(part, `${context} part ${p}`);
      const preview = part.textures[0];
      if (preview) {
        if (part.image !== preview.image) {
          fail(`${context} part ${p} preview image disagrees with its ordered texture set`);
        }
        if (part.image_hash !== null && part.image_hash !== undefined
            && part.image_hash !== preview.image_hash) {
          fail(`${context} part ${p} preview image hash disagrees with its ordered texture set`);
        }
        part.image_hash = preview.image_hash;
      }
      validateBinding(part.binding, rowCount, `${context} part ${p}`);
    };
    for (let p = 0; p < model.parts.length; p++) {
      validatePart(model.parts[p], p);
    }
    const modelVariants = doc.format === LEGACY_SYSTEM_CATALOG_FORMAT
      ? model.variants ?? model.appearances : model.variants;
    if (modelVariants !== undefined) {
      if (!Array.isArray(modelVariants) || !modelVariants.length) {
        fail(`model ${n} variants must be a non-empty array`);
      }
      const variantIds = new Set<string>();
      for (let v = 0; v < modelVariants.length; v++) {
        const variant = modelVariants[v];
        if (!variant || typeof variant.id !== 'string' || variantIds.has(variant.id)
            || !Array.isArray(variant.parts) || !variant.parts.length
            || !Array.isArray(variant.sources) || !variant.sources.length) {
          fail(`model ${n} variant ${v} is invalid`);
        }
        variantIds.add(variant.id);
        for (let p = 0; p < variant.parts.length; p++) {
          validatePart(variant.parts[p], p, `model ${n} variant ${v}`);
        }
      }
      modelVariantCount += modelVariants.length;
      // Normalize format-1 catalogs in memory so the main editor exposes only
      // the current user-facing terminology while still ingesting legacy data.
      if (model.variants === undefined) model.variants = modelVariants;
    }
  }

  const actualCounts: Record<string, number> = {
    bindings: rowCount,
    mapped_meshes: attachments.length,
    texture_variants: variantCount,
    models: doc.models.length,
    model_sources: modelSources,
  };
  if (doc.counts?.model_variants !== undefined) {
    actualCounts.model_variants = modelVariantCount;
  } else if (doc.counts?.model_appearances !== undefined) {
    actualCounts.model_appearances = modelVariantCount;
  }
  for (const [key, value] of Object.entries(actualCounts)) {
    if (doc.counts?.[key] !== value) fail(`count ${key} ${doc.counts?.[key]} != payload ${value}`);
  }

  // Validation is atomic: only now replace a prior catalog projection.
  for (const mesh of meshes.values()) delete mesh.sys;
  for (const [mesh, system] of attachments) mesh.sys = system;

  return {
    models: doc.models,
    bindings: doc.bindings,
    manifest: {
      format: doc.format,
      profile,
      counts: actualCounts,
      models: 'index/system_models.json',
      bindings: 'index/system_bindings.json',
    },
  };
}
