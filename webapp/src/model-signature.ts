// A system model's diff signature (models.ts systemModelDiffHash hashes it):
// its skeleton and, per distinct variant, the sorted (mesh, texture) content
// hash pairs of its parts. Pure, so the version diff (diff.ts) can rebuild it
// with re-encoded textures read as the pictures they are (`alias`: an image
// hash, either version's -> one hash for every encoding of the same picture).
export function modelDiffSignature(
  model: { skel?: string | null; parts?: unknown; variants?: unknown; appearances?: unknown } | null | undefined,
  alias?: Map<string, string> | null,
): string | null {
  if (!model) return null;
  const signature = (parts: unknown): string | null => {
    const pairs: string[] = [];
    for (const part of Array.isArray(parts) ? parts : []) {
      const mesh = (part as any)?.mesh_hash;
      if (typeof mesh !== 'string' || !mesh) continue;
      const image = (part as any)?.image_hash;
      pairs.push(`${mesh}>${typeof image === 'string' ? alias?.get(image) ?? image : ''}`);
    }
    return pairs.length ? pairs.sort().join(',') : null;
  };
  const variants: any[] = Array.isArray(model.variants) ? model.variants
    : Array.isArray(model.appearances) ? model.appearances : [];
  const signatures = [...new Set(
    (variants.length ? variants.map((v) => signature(v?.parts)) : [signature(model.parts)])
      .filter((s): s is string => !!s),
  )].sort();
  if (!signatures.length) return null;
  return JSON.stringify({ skel: model.skel || null, variants: signatures });
}
