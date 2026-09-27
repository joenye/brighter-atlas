// A scrollbar that stays visible, for touch screens. iOS Safari ignores the ::-webkit-scrollbar styling the
// Brighter Atlas stylesheet gives desktop browsers: its own bar floats over the content and only shows while
// scrolling. On coarse pointers each scroller given here gets a thin, themed track in a gutter of its own at
// its right edge, shown whenever it can scroll; the thumb follows the scroll and can be dragged.
const coarse = () => matchMedia('(pointer: coarse)').matches;

export function attachScrollbar(el: HTMLElement) {
  if (!coarse()) return;
  el.classList.add('vbar-host');
  const track = document.createElement('div'); track.className = 'vbar';
  const thumb = document.createElement('div'); thumb.className = 'vbar-thumb';
  track.append(thumb);
  let frame = 0;
  const place = () => {
    frame = 0;
    const parent = el.parentElement;
    if (!parent || !el.isConnected) return;
    if (track.parentElement !== parent) parent.append(track);
    const can = el.scrollHeight > el.clientHeight + 1 && el.offsetParent !== null && el.clientHeight > 0;
    track.hidden = !can; el.classList.toggle('vbar-on', can);   // (the gutter only while there is something to scroll)
    if (!can) return;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    // the scroller's box in its parent's frame
    const p = parent.getBoundingClientRect(), r = el.getBoundingClientRect();
    track.style.top = `${r.top - p.top + parent.scrollTop + 2}px`;
    track.style.height = `${r.height - 4}px`;
    track.style.left = `${r.right - p.left + parent.scrollLeft - 7}px`;
    const th = Math.max(28, (r.height - 4) * el.clientHeight / el.scrollHeight);
    const room = r.height - 4 - th, at = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
    thumb.style.height = `${th}px`;
    thumb.style.transform = `translateY(${room * at}px)`;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
  el.addEventListener('scroll', schedule, {passive: true});
  new ResizeObserver(schedule).observe(el);
  new MutationObserver(schedule).observe(el, {childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style']});
  window.addEventListener('resize', schedule);
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
