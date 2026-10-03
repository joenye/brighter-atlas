// GIF frames made off the page's thread: each frame arrives as a picture (an ImageBitmap the page made of its canvas,
// so the page never waits for its pixels), is read here and encoded at once, and goes back as its bytes. A recording
// shares its frames among a few of these, each its own palettes; the page puts the frames in order.
// Messages: {start: {w, h, delayMs, transparent, palette}} {frame: ImageBitmap, i} -> {i, bytes}. One palette for the
// whole GIF (the page makes it from a few frames first), so no frame is coloured differently from the next.
import {GifFrames} from '../viewers/gif-encoder.js';

let enc: GifFrames | null = null, g: OffscreenCanvasRenderingContext2D | null = null, w = 0, h = 0;
self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.start) {
    ({w, h} = m.start);
    enc = new GifFrames(w, h, {delayMs: m.start.delayMs, transparent: m.start.transparent, palette: m.start.palette});
    g = new OffscreenCanvas(w, h).getContext('2d', {willReadFrequently: true});
  } else if (m.frame) {
    const bmp = m.frame as ImageBitmap;
    g!.clearRect(0, 0, w, h); g!.drawImage(bmp, 0, 0); bmp.close();
    const bytes = enc!.frame(g!.getImageData(0, 0, w, h).data);
    (self as any).postMessage({i: m.i, bytes}, [bytes.buffer]);
  }
};
