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
// Some containers store a map's smallest level after its largest (128, 256,
// 512, then 64): the last image of a format run that is exactly half the
// chain's smallest level belongs to that chain.
export function detectChains(entries: TextureEntry[] | null | undefined): number[] {
  const list = entries || [];
  const chains = [];
  let cur = -1;
  let prev = null;
  let members: TextureEntry[] = [];
  for (let k = 0; k < list.length; k++) {
    const entry = list[k];
    let cont = false;
    if (prev && prev.fmt === entry.fmt && prev.w && prev.h) {
      const ratio = Math.sqrt((entry.w / prev.w) * (entry.h / prev.h));
      cont = (ratio >= 1.7 && ratio <= 2.35) || (ratio >= 0.42 && ratio <= 0.59);
      const lastOfRun = k + 1 === list.length || list[k + 1].fmt !== entry.fmt;
      if (!cont && lastOfRun) {
        const smallest = members.reduce((a, b) => (b.w * b.h < a.w * a.h ? b : a));
        cont = entry.w * 2 === smallest.w && entry.h * 2 === smallest.h;
      }
    }
    if (!cont) { cur++; members = []; }
    members.push(entry);
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

// ------------------------------------------------------------------- sprites

// A sprite (a particle image) is a plain single mip chain, not a material:
// resolveRoles above answers "which plane is the colour/normal/parameter of
// this material", which a sprite has no answer for. These two facts are what
// a sprite consumer needs instead, and they are deliberately independent of
// the material roles.
export interface SpriteMeta {
  sub: number;        // sub-image ordinal to draw: the LARGEST of the first chain
  w: number; h: number;
  // True when the source format carries an intensity mask and no authored
  // alpha. The decoder replicates such a mask across RGB and leaves alpha
  // opaque, so a consumer that reads it as colour draws a solid rectangle:
  // the mask is COVERAGE and belongs in the alpha channel.
  mask: boolean;
}

const MASK_FORMATS = new Set<string | number>(['BC4', 'bc4', 0x22]);

// entries: [{fmt,w,h}, ...] -> how to draw this container as a single sprite,
// or null when it carries no usable sub-image. Mip chains are stored smallest
// first, so the drawable image is the LARGEST sub-image: taking the
// container's first one yields a thumbnail.
//
// Largest of the whole container, deliberately not largest-of-chain-0: a
// sprite container IS one mip chain, and detectChains only exists to separate
// a material's planes. Its step-ratio window is calibrated for square mips
// and can split a legitimate chain whose two dimensions halve unevenly (a
// 40x20 -> 72x32 step lands just outside it), which would silently pick the
// half-size mip.
export function resolveSpriteMeta(
  entries: TextureEntry[] | null | undefined,
): SpriteMeta | null {
  if (!entries || !entries.length) return null;
  let index: number | null = null;
  for (let k = 0; k < entries.length; k++) {
    const entry = entries[k];
    if (!(Number(entry?.w) > 0 && Number(entry?.h) > 0)) continue;
    if (index == null || entry.w * entry.h > entries[index].w * entries[index].h) index = k;
  }
  if (index == null) return null;
  const entry = entries[index];
  return {
    sub: index, w: Number(entry.w), h: Number(entry.h),
    mask: MASK_FORMATS.has(entry.fmt),
  };
}
