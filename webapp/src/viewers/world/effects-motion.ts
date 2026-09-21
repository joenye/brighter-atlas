import type { EffectMotion, EffectMotionAxis } from '../../extract/world/effect-motion.js';

// Inputs use game units and the attachment clock. Room display offsets must
// not enter this calculation. The returned affine matrix is column-major.
export function proceduralEffectFrame(
  motion: EffectMotion, position: readonly [number, number],
  footprint: readonly [number, number], ticks: number,
  phaseOrigin: readonly [number, number],
): number[] | null {
  const inputs = [ticks, ...position, ...footprint, ...phaseOrigin,
    ...[motion.x, motion.y].flatMap(a => [a.amplitude, a.spatialFrequency, a.temporalFrequency])];
  if (!inputs.every(Number.isFinite) || footprint.some(n => n <= 0)) return null;
  const f = Math.fround, tau = f(2 * Math.PI);
  const phase = (a: EffectMotionAxis, origin: number) => {
    let wrapped = f(f(origin * a.spatialFrequency) % tau);
    if (wrapped < 0) wrapped = f(wrapped + tau);
    return f(f(f(ticks) * a.temporalFrequency) - wrapped);
  };
  const px = phase(motion.x, phaseOrigin[0]), py = phase(motion.y, phaseOrigin[1]);
  const height = (x: number, y: number) => f(
    f(f(Math.sin(f(f(x * motion.x.spatialFrequency) + px))) * motion.x.amplitude) +
    f(f(Math.sin(f(f(y * motion.y.spatialFrequency) + py))) * motion.y.amplitude));
  const [x, y] = position, dx = f(footprint[0] * 512), dy = f(footprint[1] * 512);
  const left = height(f(x - dx), y), right = height(f(x + dx), y);
  const below = height(x, f(y - dy)), above = height(x, f(y + dy));
  const baseline = Math.max(height(x, y), f(f(left + right) * .5), f(f(below + above) * .5));
  const slope = (edge: number, extent: number) => f(f(f(Math.atan(f(f(edge - baseline) / extent))) * 360) / tau);
  const ax = f(-f(slope(left, dx) + f(slope(right, -dx) * .5)) * .5) * Math.PI / 180;
  const ay = f(-f(slope(below, dy) + f(slope(above, -dy) * .5)) * .5) * Math.PI / 180;
  const z = f(f(baseline * .5) + f(f(motion.x.amplitude + motion.y.amplitude) * .5));
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
  // Translation * rotation about Y * rotation about X.
  return [cy, 0, -sy, 0, sy * sx, cx, cy * sx, 0, sy * cx, -sx, cy * cx, 0, 0, 0, z, 1];
}
