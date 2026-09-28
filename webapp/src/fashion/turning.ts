// Turning the character as a game's character screen does: a drag turns it the way the finger goes (its front
// follows the finger), a flick keeps it spinning with the speed of the drag's last ~100 ms, slowing gradually;
// two fingers pinch to zoom (`onZoom`: the view's framing is the visitor's own from then on).
import type {Preview} from './render.js';

const K = 0.012;   // radians per pixel

export function attachTurning(target: HTMLElement, pv: Preview, onZoom?: () => void) {
  const pointers = new Map<number, {x: number, y: number}>();
  let drag: {samples: {t: number, yaw: number}[]} | null = null, pinch = 0;
  target.addEventListener('pointerdown', e => {
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); target.setPointerCapture(e.pointerId);
    if (pointers.size === 1) { drag = {samples: [{t: performance.now(), yaw: pv.yaw}]}; pv.yawVel = 0; target.classList.add('dragging'); }
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); drag = null; }
  });
  target.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId); if (!prev) return;
    const cur = {x: e.clientX, y: e.clientY}; pointers.set(e.pointerId, cur);
    if (pointers.size === 2 && onZoom) {
      const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) { pv.zoomBy(pinch / d); onZoom(); }
      pinch = d; return;
    }
    if (!drag) return;
    const now = performance.now();
    pv.yaw -= (cur.x - prev.x) * K;
    drag.samples.push({t: now, yaw: pv.yaw});
    while (drag.samples.length > 2 && now - drag.samples[0].t > 100) drag.samples.shift();
  });
  const end = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (drag && pointers.size === 0) {
      const now = performance.now(), s = drag.samples, a = s[0], b = s[s.length - 1];
      // held still before letting go: no spin; otherwise the flick's speed carries on
      pv.yawVel = now - b.t < 60 && b.t - a.t > 8 ? Math.max(-40, Math.min(40, (b.yaw - a.yaw) / ((b.t - a.t) / 1000))) : 0;
    }
    if (pointers.size === 0) { drag = null; pinch = 0; target.classList.remove('dragging'); }
  };
  target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
}
