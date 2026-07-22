// Content-based water fingerprint, shared by extraction (world texture meta,
// full-RGBA input) and the world viewer (canvas ImageData input). AB3 texture
// ordinals are build-specific but the wave-curtain art is stable, so water is
// recognised by decoded-albedo structure: strong smooth horizontal banding
// with a tiny per-pixel horizontal gradient.

export const WATER_SAMPLE = 32;

export type WaterClass = 'chromatic' | 'neutral' | null;

export interface WaterMetrics {
  rowVariation: number;
  colVariation: number;
  gradX: number;
  luminance: number;
  meanSat: number;
}

// The shared signature of the curtain art is structural, not hue: high
// row-mean variance (>=12 vs column ~0.5-1) AND a small horizontal gradient.
// The gradient bound rejects pebbly building-foundation strata (gx >= 2.4);
// waterfalls/foam fail the band ratio (~5x); the still fountain pool is ~1x.
export function classifyWaterMetrics({
  rowVariation, colVariation, gradX, luminance, meanSat,
}: WaterMetrics): WaterClass {
  const chromaticBands = rowVariation > 8
    && rowVariation > colVariation * 6
    && gradX < 1.8
    && luminance > 15 && luminance < 130
    && meanSat > 5 && meanSat < 100;
  if (chromaticBands) return 'chromatic';

  // This family is neutral because its recovered material recolor supplies
  // the hue. Tighter shape/luminance gates keep grey building strata out.
  const neutralBands = meanSat < 2
    && rowVariation > 4.5
    && rowVariation > colVariation * 10
    && gradX < 0.7
    && luminance > 40 && luminance < 90;
  return neutralBands ? 'neutral' : null;
}

// data: RGBA bytes of a WATER_SAMPLE x WATER_SAMPLE downsample.
export function waterMetricsFromSample(data: Uint8Array | Uint8ClampedArray): WaterMetrics {
  const S = WATER_SAMPLE;
  let meanR = 0; let meanG = 0; let meanB = 0; let meanSat = 0; let gradX = 0;
  const rowMeans = new Float64Array(S * 3);
  const colMeans = new Float64Array(S * 3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const at = (y * S + x) * 4;
      const r = data[at];
      const g = data[at + 1];
      const b = data[at + 2];
      meanR += r; meanG += g; meanB += b;
      meanSat += Math.max(r, g, b) - Math.min(r, g, b);
      rowMeans[y * 3] += r; rowMeans[y * 3 + 1] += g; rowMeans[y * 3 + 2] += b;
      colMeans[x * 3] += r; colMeans[x * 3 + 1] += g; colMeans[x * 3 + 2] += b;
      if (x + 1 < S) {
        gradX += Math.abs((data[at + 4] + data[at + 5] + data[at + 6])
          - (r + g + b)) / 3;
      }
    }
  }
  const pixels = S * S;
  meanR /= pixels; meanG /= pixels; meanB /= pixels; meanSat /= pixels;
  gradX /= S * (S - 1);
  const axisVariation = (means: Float64Array, channel: number) => {
    let sum = 0;
    let sumSq = 0;
    for (let index = 0; index < S; index++) {
      const value = means[index * 3 + channel] / S;
      sum += value; sumSq += value * value;
    }
    return Math.sqrt(Math.max(0, sumSq / S - (sum / S) ** 2));
  };
  const rowVariation = (axisVariation(rowMeans, 0) + axisVariation(rowMeans, 1)
    + axisVariation(rowMeans, 2)) / 3;
  const colVariation = (axisVariation(colMeans, 0) + axisVariation(colMeans, 1)
    + axisVariation(colMeans, 2)) / 3;
  const luminance = (meanR + meanG + meanB) / 3;
  return { rowVariation, colVariation, gradX, luminance, meanSat };
}

// Box-average an RGBA image down to the sample grid (extraction path: the
// viewer path samples via canvas drawImage, whose filtering differs slightly;
// the classifier's margins absorb that).
export function sampleRgba(
  rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
): Uint8ClampedArray {
  const S = WATER_SAMPLE;
  const out = new Uint8ClampedArray(S * S * 4);
  for (let sy = 0; sy < S; sy++) {
    const y0 = Math.floor((sy * height) / S);
    const y1 = Math.max(y0 + 1, Math.floor(((sy + 1) * height) / S));
    for (let sx = 0; sx < S; sx++) {
      const x0 = Math.floor((sx * width) / S);
      const x1 = Math.max(x0 + 1, Math.floor(((sx + 1) * width) / S));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const at = (y * width + x) * 4;
          r += rgba[at]; g += rgba[at + 1]; b += rgba[at + 2]; a += rgba[at + 3];
          n++;
        }
      }
      const to = (sy * S + sx) * 4;
      out[to] = r / n; out[to + 1] = g / n; out[to + 2] = b / n; out[to + 3] = a / n;
    }
  }
  return out;
}

export function classifyWaterRgba(
  rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
): WaterClass {
  if (!width || !height) return null;
  return classifyWaterMetrics(waterMetricsFromSample(sampleRgba(rgba, width, height)));
}
