// The persistent themed scrollbar, on every scroller of every page. Where the platform's own scrollbars take no
// room and hide between scrolls (iOS and Android, macOS by default in Firefox), and so ignore the themed
// ::-webkit-scrollbar the Brighter Atlas stylesheet gives the rest, each scroller gets a thin track of the site's
// own in a gutter at its right edge, shown whenever it can scroll; the thumb follows the scroll and can be
// dragged. Elsewhere the themed native scrollbar already stays.
//
// autoScrollbars() (run by the site's shell, app/main.tsx) gives it to every element that scrolls
// vertically, now and whenever one is added; attachScrollbar() gives it to one. A scroller that must keep
// the platform's own carries data-native-scroll.

/** The platform's scrollbars take no room (they float over the content and hide). */
export const overlayScrollbars: () => boolean = (() => {
  let known: boolean | null = null;
  return () => {
    if (known != null) return known;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;top:-999px;width:80px;height:80px;overflow:scroll';
    document.body.append(probe);
    known = probe.offsetWidth - probe.clientWidth === 0 || matchMedia('(pointer: coarse)').matches;
    probe.remove();
    return known;
  };
})();

const scrolls = (el: Element) => { const y = getComputedStyle(el).overflowY; return y === 'auto' || y === 'scroll'; };

/** The themed scrollbar on every vertical scroller of the page, as they come. */
export function autoScrollbars(root: HTMLElement = document.body): void {
  if (!overlayScrollbars()) return;
  const seen = new WeakSet<Element>();
  const scan = (node: Element) => {
    for (const el of [node, ...node.querySelectorAll('*')]) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el instanceof HTMLElement && !el.closest('[data-native-scroll]') && el !== document.body && scrolls(el)) attachScrollbar(el);
    }
  };
  scan(root);
  let pending: Element[] = [], frame = 0;
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof Element && !n.classList.contains('vbar')) pending.push(n);
    if (pending.length && !frame) frame = requestAnimationFrame(() => { frame = 0; const list = pending; pending = []; for (const n of list) if (n.isConnected) scan(n); });
  }).observe(root, { childList: true, subtree: true });
}

// One listener on the window for every scroller, holding each weakly: a scroller that leaves the page (a tool
// let go) is not kept alive by it.
const resizing = new Set<WeakRef<() => void>>();
let resizeListening = false;
function onResize(fn: () => void) {
  if (!resizeListening) {
    resizeListening = true;
    addEventListener('resize', () => { for (const r of resizing) { const f = r.deref(); if (f) f(); else resizing.delete(r); } });
  }
  resizing.add(new WeakRef(fn));
}

export function attachScrollbar(el: HTMLElement): void {
  if (!overlayScrollbars() || el.classList.contains('vbar-host')) return;
  el.classList.add('vbar-host');
  const track = document.createElement('div'); track.className = 'vbar';
  const thumb = document.createElement('div'); thumb.className = 'vbar-thumb';
  track.append(thumb);
  let frame = 0;
  const place = () => {
    frame = 0;
    const parent = el.parentElement;
    if (!parent || !el.isConnected) { track.remove(); return; }   // (a scroller gone: its bar with it)
    if (track.parentElement !== parent) parent.append(track);
    // (shown: on screen by its boxes, as a fixed sheet has no offset parent)
    const can = el.scrollHeight > el.clientHeight + 1 && el.getClientRects().length > 0 && el.clientHeight > 0;
    track.hidden = !can; el.classList.toggle('vbar-on', can);   // (the gutter only while there is something to scroll)
    if (!can) return;
    // over its scroller, however high that sits (a popover's own stacking)
    const z = parseInt(getComputedStyle(el).zIndex, 10);
    track.style.zIndex = String(Number.isFinite(z) ? z + 1 : 3);
    const r = el.getBoundingClientRect();
    if (parent === document.body) {
      // (a scroller of the page's own, an overlay: the track stays in the window's frame, the page's own
      // positioning untouched)
      track.style.position = 'fixed';
      track.style.top = `${r.top + 2}px`; track.style.left = `${r.right - 7}px`;
    } else {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      // the scroller's box in its parent's frame
      const p = parent.getBoundingClientRect();
      track.style.top = `${r.top - p.top + parent.scrollTop + 2}px`;
      track.style.left = `${r.right - p.left + parent.scrollLeft - 7}px`;
    }
    track.style.height = `${r.height - 4}px`;
    const th = Math.max(28, (r.height - 4) * el.clientHeight / el.scrollHeight);
    const room = r.height - 4 - th, at = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
    thumb.style.height = `${th}px`;
    thumb.style.transform = `translateY(${room * at}px)`;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
  el.addEventListener('scroll', schedule, {passive: true});
  new ResizeObserver(schedule).observe(el);
  // (hidden from above, a class on an ancestor (a drawer giving way to another): Safari reports no resize for it,
  // and a bar left standing would sit beside the next drawer's own; its leaving the screen is reported everywhere)
  new IntersectionObserver(schedule).observe(el);
  // (`open`: a <details> inside folding or unfolding changes what there is to scroll without resizing the scroller)
  new MutationObserver(schedule).observe(el, {childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style', 'open']});
  onResize(schedule);
  // drag the thumb (or tap the track) to scroll
  track.addEventListener('pointerdown', e => {
    e.preventDefault(); track.setPointerCapture(e.pointerId);
    const r = track.getBoundingClientRect(), th = thumb.getBoundingClientRect().height;
    const to = (y: number) => { el.scrollTop = Math.max(0, Math.min(1, (y - r.top - th / 2) / Math.max(1, r.height - th))) * (el.scrollHeight - el.clientHeight); };
    to(e.clientY);
    const move = (ev: PointerEvent) => to(ev.clientY);
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', () => track.removeEventListener('pointermove', move), {once: true});
  });
  schedule();
}
