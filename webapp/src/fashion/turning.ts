// Turning the character as a game's character screen does: a drag turns it the way the finger goes (its front
// follows the finger), a flick keeps it spinning with the speed of the drag's last ~100 ms, slowing gradually;
// two fingers pinch to zoom (`onZoom`: the view's framing is the visitor's own from then on). In a place whose view
// turns, a drag begun on the scene rather than the character turns the view about the place instead (the camera
// and the character going round it together), flicked the same way; the pointer shows which over each. Up and down,
// begun beside the character on any background (never on the character), takes the camera a little up or down round
// them.
import type {Preview} from './render.js';

const K = 0.012;   // radians per pixel

export function attachTurning(target: HTMLElement, pv: Preview, onZoom?: () => void) {
  const pointers = new Map<number, {x: number, y: number}>();
  let drag: {view: boolean, around: boolean, samples: {t: number, a: number}[]} | null = null, pinch = 0;
  const angle = (view: boolean) => view ? pv.viewTurn : pv.yaw;
  const viewAt = (x: number, y: number) => !!pv.viewReach && !pv.onCharacter(x, y);
  target.addEventListener('pointerdown', e => {
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); target.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      const around = !pv.onCharacter(e.clientX, e.clientY), view = around && !!pv.viewReach;
      drag = {view, around, samples: [{t: performance.now(), a: angle(view)}]};
      if (view) pv.viewVel = 0; else pv.yawVel = 0;
      target.classList.add('dragging');
    }
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); drag = null; }
  });
  target.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId);
    // (a mouse over the canvas, no button: which a drag from here would turn)
    if (!prev) { if (e.pointerType === 'mouse') target.dataset.turn = viewAt(e.clientX, e.clientY) ? 'view' : ''; return; }
    const cur = {x: e.clientX, y: e.clientY}; pointers.set(e.pointerId, cur);
    if (pointers.size === 2 && onZoom) {
      const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) { pv.zoomBy(pinch / d); onZoom(); }
      pinch = d; return;
    }
    if (!drag) return;
    const now = performance.now(), d = -(cur.x - prev.x) * K;
    // (across: the view about the place, or the character; down, begun beside the character (never on it), takes the
    // camera up round the character)
    if (drag.view) pv.turnView(d); else pv.yaw += d;
    if (drag.around) pv.orbitUp((cur.y - prev.y) * K * 0.5);
    drag.samples.push({t: now, a: angle(drag.view)});
    while (drag.samples.length > 2 && now - drag.samples[0].t > 100) drag.samples.shift();
  });
  const end = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (drag && pointers.size === 0) {
      const now = performance.now(), s = drag.samples, a = s[0], b = s[s.length - 1];
      // held still before letting go: no spin; otherwise the flick's speed carries on
      const vel = now - b.t < 60 && b.t - a.t > 8 ? Math.max(-40, Math.min(40, (b.a - a.a) / ((b.t - a.t) / 1000))) : 0;
      if (drag.view) pv.viewVel = vel; else pv.yawVel = vel;
    }
    if (pointers.size === 0) { drag = null; pinch = 0; target.classList.remove('dragging'); }
  };
  target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
  target.addEventListener('pointerleave', () => { target.dataset.turn = ''; });
}
