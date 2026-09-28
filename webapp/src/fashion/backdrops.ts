// What stands behind the character: a colour (a radial gradient, or nothing: transparent), or a place from the
// game, drawn by its own programs (its view and what is in it come with the place's data). A place's sky is one
// flat colour, the room's fog fading into it: its middle stop.
export interface Backdrop { id: string; name: string; stops: string[]; room?: {id: number} }

export const BACKDROPS: Backdrop[] = [
  {id: 'atlas', name: 'Atlas', stops: ['#1f2531', '#14171d', '#0d0f13']},
  {id: 'dusk', name: 'Dusk', stops: ['#4a3b52', '#231c2b', '#120e16']},
  {id: 'meadow', name: 'Meadow', stops: ['#6f8a5a', '#3a4d31', '#1d2618']},
  {id: 'sand', name: 'Parchment', stops: ['#e8dcc0', '#bfae8a', '#8a7a5c']},
  {id: 'studio', name: 'Studio grey', stops: ['#8a8f99', '#5b6068', '#33363c']},
  {id: 'none', name: 'Transparent', stops: []},
  {id: 'beach', name: 'Beach', stops: ['#2a3a48', '#18222c', '#0d1116'], room: {id: 8996}},
];

/** Its colours as a CSS background (transparent: the checkerboard): a menu's swatch. */
export const swatchOf = (b: Backdrop) => b.stops.length ? `radial-gradient(ellipse at 50% 40%, ${b.stops[0]} 0%, ${b.stops[1]} 55%, ${b.stops[2]} 100%)`
  : 'repeating-conic-gradient(#2a2d33 0% 25%, #1f2227 0% 50%) 50% / 20px 20px';
/** As the view's CSS background (a place: its flat sky). */
export const cssOf = (b: Backdrop) => b.room ? b.stops[1] : swatchOf(b);

/** Painted under a picture (transparent: nothing). */
export function paintBackdrop(g: CanvasRenderingContext2D, b: Backdrop, w: number, h: number) {
  if (b.room) { g.fillStyle = b.stops[1]; g.fillRect(0, 0, w, h); return; }
  if (!b.stops.length) return;
  const gr = g.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h) * 0.75);
  b.stops.forEach((c, i) => gr.addColorStop([0, .55, 1][i], c));
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}
