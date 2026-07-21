// Virtualized list: absolute-positioned rows inside a sized scroller.
// Handles 15k+ rows; rows outside the viewport (+overscan) are dropped.
// An IntersectionObserver is provided to row renderers for lazy thumbnails.

import { el, clear } from './ui.js';

export interface VListOptions<T = any> {
  /** container element (positioned) */
  host: HTMLElement;
  /** px per row */
  rowHeight?: number;
  /** fill a row */
  render: (item: T, rowEl: HTMLElement, lazyObserver: IntersectionObserver) => void;
  /** click / keyboard selection */
  onSelect?: (item: T, index: number) => void;
}

export class VList<T = any> {
  host: HTMLElement;
  rowHeight: number;
  render: (item: T, rowEl: HTMLElement, lazyObserver: IntersectionObserver) => void;
  onSelect?: (item: T, index: number) => void;
  items: T[];
  selectedIndex: number;
  rows: Map<number, HTMLElement>;
  root: HTMLDivElement;
  sizer: HTMLDivElement;
  io: IntersectionObserver;
  empty?: HTMLDivElement;
  private _resize: () => void;

  constructor({ host, rowHeight = 40, render, onSelect }: VListOptions<T>) {
    this.host = host;
    this.rowHeight = rowHeight;
    this.render = render;
    this.onSelect = onSelect;
    this.items = [];
    this.selectedIndex = -1;
    this.rows = new Map(); // index -> element

    this.root = el('div', { class: 'vlist', tabindex: '0' });
    this.sizer = el('div', { class: 'vlist-sizer' });
    this.root.appendChild(this.sizer);
    host.appendChild(this.root);

    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const target = e.target as HTMLElement;
        if (e.isIntersecting && target.dataset.src) {
          const img = target.querySelector('img') || target.appendChild(el('img'));
          img.src = target.dataset.src;
          delete target.dataset.src;
          this.io.unobserve(target);
        }
      }
    }, { root: this.root, rootMargin: '200px' });

    this.root.addEventListener('scroll', () => this._update());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
      else if (e.key === 'PageDown') { e.preventDefault(); this.move(Math.floor(this.root.clientHeight / this.rowHeight)); }
      else if (e.key === 'PageUp') { e.preventDefault(); this.move(-Math.floor(this.root.clientHeight / this.rowHeight)); }
      else if (e.key === 'Home') { e.preventDefault(); this.moveTo(0); }
      else if (e.key === 'End') { e.preventDefault(); this.moveTo(this.items.length - 1); }
    });
    this._resize = () => this._update();
    window.addEventListener('resize', this._resize);
  }

  destroy(): void {
    window.removeEventListener('resize', this._resize);
    this.io.disconnect();
    this.root.remove();
  }

  setItems(items: T[], { keepScroll = false }: { keepScroll?: boolean } = {}): void {
    this.items = items;
    this.rows.forEach((r) => r.remove());
    this.rows.clear();
    this.sizer.style.height = `${items.length * this.rowHeight}px`;
    if (!keepScroll) this.root.scrollTop = 0;
    if (!items.length) {
      this.empty ||= el('div', { class: 'vlist-empty', text: 'No entries match.' });
      this.sizer.appendChild(this.empty);
    } else if (this.empty) { this.empty.remove(); }
    this._update();
  }

  setSelectedIndex(i: number, { reveal = true, center = false }: { reveal?: boolean; center?: boolean } = {}): void {
    if (this.selectedIndex === i) return;
    const prev = this.rows.get(this.selectedIndex);
    if (prev) prev.classList.remove('selected');
    this.selectedIndex = i;
    const cur = this.rows.get(i);
    if (cur) cur.classList.add('selected');
    if (reveal && i >= 0) this.revealIndex(i, center);
  }

  // center=true centers the row ONLY when it is currently off-screen (e.g. a
  // deep-link/refresh jump); a row that is already visible stays put.
  revealIndex(i: number, center = false): void {
    const top = i * this.rowHeight, bottom = top + this.rowHeight;
    const vTop = this.root.scrollTop, vBottom = vTop + this.root.clientHeight;
    const visible = top >= vTop && bottom <= vBottom;
    if (center && !visible) {
      const target = top - (this.root.clientHeight - this.rowHeight) / 2;
      const max = this.root.scrollHeight - this.root.clientHeight;
      this.root.scrollTop = Math.max(0, Math.min(target, max));
    } else if (top < vTop) this.root.scrollTop = top - this.rowHeight;
    else if (bottom > vBottom) this.root.scrollTop = bottom - this.root.clientHeight + this.rowHeight;
    this._update();
  }

  move(delta: number): void {
    if (!this.items.length) return;
    const i = Math.max(0, Math.min(this.items.length - 1, (this.selectedIndex < 0 ? 0 : this.selectedIndex + delta)));
    this.moveTo(i);
  }

  moveTo(i: number): void {
    if (i < 0 || i >= this.items.length) return;
    this.setSelectedIndex(i);
    this.onSelect?.(this.items[i], i);
  }

  focus(): void { this.root.focus({ preventScroll: true }); }

  private _update(): void {
    const n = this.items.length;
    if (!n) return;
    const overscan = 6;
    const first = Math.max(0, Math.floor(this.root.scrollTop / this.rowHeight) - overscan);
    const last = Math.min(n - 1, Math.ceil((this.root.scrollTop + this.root.clientHeight) / this.rowHeight) + overscan);
    for (const [i, row] of this.rows) {
      if (i < first || i > last) {
        this.rows.delete(i);
        row.querySelectorAll('[data-src]').forEach((t) => this.io.unobserve(t));
        row.remove();
      }
    }
    for (let i = first; i <= last; i++) {
      if (this.rows.has(i)) continue;
      const row = el('div', { class: 'vrow' });
      row.style.top = `${i * this.rowHeight}px`;
      row.style.height = `${this.rowHeight}px`;
      if (i === this.selectedIndex) row.classList.add('selected');
      row.addEventListener('click', () => this.moveTo(i));
      this.render(this.items[i], row, this.io);
      this.rows.set(i, row);
      this.sizer.appendChild(row);
    }
  }
}
