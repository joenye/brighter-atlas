// A place's texture file (levels.ts), prepared off the page's thread: each level's blocks laid out as the GPU
// takes them or, for GPUs without the block formats (iPhones), decoded to pixels that sample as the blocks
// would: one channel (BC4) as (r, 0, 0, 1), two (BC5) as (r, g, 0, 1), the signed two-channel normal maps as
// signed bytes (format SNORM_RG, uploaded RGBA8_SNORM).
import { decodeSubImage, interleaveBlocks } from '../extract/image.js';
import { unpackLevels, SNORM_RG, WEB_TOP, WEB_DERIVED, FMT_MASK, type Level } from './levels-format.js';

function decoded(l: Level): Level {
  if (l.fmt === 0x16) return { ...l, data: l.data.slice() };
  const { rgba } = decodeSubImage({ fmt: l.fmt, w: l.width, h: l.height }, l.data);
  // (the decoder's view is for pictures: grey replicated, a second channel in alpha)
  if (l.fmt === 0x24) for (let o = 0; o < rgba.length; o += 4) { rgba[o + 1] = rgba[o + 3]; rgba[o + 3] = 255; }
  return asPixels(l.fmt, l.width, l.height, rgba);
}
/** Decoded pixels (a two-channel mask's second channel in green) as the frame samples the format. */
function asPixels(fmt: number, width: number, height: number, rgba: Uint8Array): Level {
  const l = { fmt, width, height };
  if (l.fmt === 0x22) for (let o = 0; o < rgba.length; o += 4) { rgba[o + 1] = 0; rgba[o + 2] = 0; rgba[o + 3] = 255; }
  if (l.fmt === 0x24) for (let o = 0; o < rgba.length; o += 4) { rgba[o + 2] = 0; rgba[o + 3] = 255; }
  if (l.fmt === 0x25) {
    // (the decoder maps [-1, 1] to bytes as (x + 1) / 2 * 255: back to signed)
    const s = new Int8Array(rgba.buffer, rgba.byteOffset, rgba.length);
    for (let o = 0; o < rgba.length; o += 4) {
      s[o] = Math.round((rgba[o] / 127.5 - 1) * 127); s[o + 1] = Math.round((rgba[o + 1] / 127.5 - 1) * 127); s[o + 2] = 0; s[o + 3] = 127;
    }
    return { fmt: SNORM_RG, width: l.width, height: l.height, data: rgba };
  }
  return { fmt: 0x16, width: l.width, height: l.height, data: rgba };
}
const laidOut = (l: Level): Level => l.fmt === 0x16 ? { ...l, data: l.data.slice() } : { ...l, data: interleaveBlocks(l.fmt, l.width, l.height, l.data) };

// A phone's file (gf/web/): each sub-image's largest level from its WebP, the smaller ones drawn from it scaled down.
async function fromWeb(levels: Level[]): Promise<Level[]> {
  const out: Level[] = new Array(levels.length);
  for (let k = 0; k < levels.length; k++) {
    if (!(levels[k].fmt & WEB_TOP)) continue;
    const fmt = levels[k].fmt & FMT_MASK;
    const picture = await createImageBitmap(new Blob([levels[k].data as BlobPart], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    let first = k;
    while (first > 0 && (levels[first - 1].fmt & WEB_DERIVED) && (levels[first - 1].fmt & FMT_MASK) === fmt) first--;
    for (let m = first; m <= k; m++) {
      const { width, height } = levels[m], c = new OffscreenCanvas(width, height), g = c.getContext('2d', { willReadFrequently: true })!;
      g.imageSmoothingQuality = 'high'; g.drawImage(picture, 0, 0, width, height);
      out[m] = asPixels(fmt, width, height, new Uint8Array(g.getImageData(0, 0, width, height).data.buffer));
    }
    picture.close();
  }
  if (out.some((l) => !l) || out.length !== levels.length) throw new Error('web texture: a level without its picture');
  return out;
}

self.onmessage = async (e: MessageEvent<{ id: number; file: ArrayBuffer; decode: boolean }>) => {
  const { id, file, decode } = e.data;
  try {
    const all = unpackLevels(new Uint8Array(file));
    const levels = all.some((l) => l.fmt & (WEB_TOP | WEB_DERIVED)) ? await fromWeb(all) : all.map(decode ? decoded : laidOut);
    (self as any).postMessage({ id, levels }, levels.map((l) => l.data.buffer));
  } catch (error) {
    (self as any).postMessage({ id, error: String((error as Error)?.message ?? error) });
  }
};
