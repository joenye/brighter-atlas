// Fit-scoring worker: decodes material textures off the main thread and scores
// each against the mesh's UV features (fit-score.js). N of these run in parallel
// (one per core) so a full sweep of ~3,800 materials stays a few seconds.
//
// Protocol (main -> worker):  { features, jobs:[{i,url}], sample }
//          (worker -> main):  { i, fit }  per texture, then { done:true }
// A failed decode reports { i, fit:null } so it sorts last without aborting.

import { scoreTexture } from './fit-score.js';
import type { FitFeatures } from './fit-score.js';

const ctx = self as any;   // worker globals (the program is typed with the DOM lib)

let canvas: OffscreenCanvas | null = null;
let g2d: OffscreenCanvasRenderingContext2D | null = null;

interface FitJob { i: number; url: string; nativeRes?: number }

async function scoreOne(features: FitFeatures, job: FitJob, S: number): Promise<number | null> {
  try {
    const res = await fetch(job.url);
    const bmp = await createImageBitmap(await res.blob());
    g2d!.clearRect(0, 0, S, S);
    g2d!.drawImage(bmp, 0, 0, S, S);
    bmp.close?.();
    const { data } = g2d!.getImageData(0, 0, S, S);
    // native resolution comes from the index (job.nativeRes), NOT the fetched
    // pixels: f[0] is the smallest mip, so bmp.width would be ~native/4.
    const nr = job.nativeRes || 0;
    const { fit } = scoreTexture(features, data, S, S, nr, nr);
    return Number.isFinite(fit) ? fit : null;
  } catch {
    return null;
  }
}

ctx.onmessage = async (ev: MessageEvent) => {
  const { features, jobs, sample } = ev.data as { features: FitFeatures; jobs: FitJob[]; sample?: number };
  const S = sample || 64;
  if (!canvas) { canvas = new OffscreenCanvas(S, S); g2d = canvas.getContext('2d', { willReadFrequently: true }); }

  // small in-worker concurrency to overlap fetch latency with decode/score
  let next = 0;
  const CONC = 3;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const fit = await scoreOne(features, job, S);
      ctx.postMessage({ i: job.i, fit });
    }
  }));
  ctx.postMessage({ done: true });
};
