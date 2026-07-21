// Pure material-plane role recovery shared by browser extraction and every
// viewer. An AB3 image is a sequence of mip chains; standard materials store
// base colour first, then (usually) a BC5-SNORM normal, then one or more packed
// BC1/BC3 parameter planes. Keep every post-anchor parameter plane because the
// first can carry cutout coverage while the final one is the recolour input.

export interface TextureEntry { fmt: string | number; w: number; h: number }

export interface TextureRoles {
  albedo: number | null;
  normal: number | null;
  parameter: number | null;
  parameters: number[];
}

const FORMAT: Record<string, Set<string | number>> = {
  RGBA8: new Set(['RGBA8', 'rgba8', 0x16]),
  BC5S: new Set(['BC5S', 'bc5s', 0x25]),
  BC1: new Set(['BC1', 'bc1', 0x26]),
  BC3: new Set(['BC3', 'bc3', 0x28]),
};

const isFormat = (entry: TextureEntry | null | undefined, name: string) =>
  FORMAT[name].has(entry?.fmt as string | number);
const isColour = (entry: TextureEntry) => isFormat(entry, 'RGBA8')
  || isFormat(entry, 'BC1') || isFormat(entry, 'BC3');
const isParameter = (entry: TextureEntry) => isFormat(entry, 'BC1') || isFormat(entry, 'BC3');

// entries: [{fmt,w,h}, ...] -> chain id per entry (mip runs of one map).
export function detectChains(entries: TextureEntry[] | null | undefined): number[] {
  const chains = [];
  let cur = -1;
  let prev = null;
  for (const entry of entries || []) {
    let cont = false;
    if (prev && prev.fmt === entry.fmt && prev.w && prev.h) {
      const ratio = Math.sqrt((entry.w / prev.w) * (entry.h / prev.h));
      cont = (ratio >= 1.7 && ratio <= 2.35) || (ratio >= 0.42 && ratio <= 0.59);
    }
    cur = cont ? cur : cur + 1;
    chains.push(cur);
    prev = entry;
  }
  return chains;
}

const largestInChain = (
  entries: TextureEntry[], chains: number[], chain: number,
  predicate: (entry: TextureEntry) => boolean,
): number | null => {
  let best = null;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (chains[index] !== chain || !predicate(entry)) continue;
    if (best == null || entry.w * entry.h > entries[best].w * entries[best].h) best = index;
  }
  return best;
};

// image index entry -> largest sub-image ordinals for the material planes.
// `parameters` is source ordered; `parameter` is its final member for the
// native two-mask recolour shader. Cutout recovery must inspect every member.
export function resolveRoles(
  imgEntry: { entries?: TextureEntry[] | null } | null | undefined,
): TextureRoles {
  const entries = imgEntry?.entries || [];
  const chains = detectChains(entries);
  const orderedChains = [...new Set(chains)].sort((a, b) => a - b);

  let albedo = null;
  for (const chain of orderedChains) {
    albedo = largestInChain(entries, chains, chain, isColour);
    if (albedo != null) break;
  }

  let normal = null;
  for (const chain of orderedChains) {
    normal = largestInChain(entries, chains, chain, (entry) => isFormat(entry, 'BC5S'));
    if (normal != null) break;
  }

  const anchor = normal != null ? chains[normal]
    : albedo != null ? chains[albedo] : -1;
  const parameters = [];
  for (const chain of orderedChains) {
    if (chain <= anchor) continue;
    const index = largestInChain(entries, chains, chain, isParameter);
    if (index != null) parameters.push(index);
  }
  return {
    albedo, normal,
    parameter: parameters.length ? parameters[parameters.length - 1] : null,
    parameters,
  };
}
