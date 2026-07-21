// Global search across all catalogs: index numbers, content-hash prefixes,
// friendly names and image categories. Indexes are pulled lazily the first
// time the search box is used.

import { el, clear, debounce, idLabel } from './ui.js';
import { effectiveName } from './names.js';
import type { IndexEntry } from './store.js';

const MAX_PER_GROUP = 8;

interface SearchItem {
  label: string;
  meta: string;
  hash?: string;
  footer?: boolean;
  action?: () => void;
}

// per-category result formatting: [index key, group title, route, meta fn]
const CAT_DEFS: [string, string, string, (e: any) => string][] = [
  ['meshes', 'Meshes', 'mesh', (m) => `${m.v} verts · ${m.t} tris${m.sk ? ' · skinned' : ''}`],
  ['audio', 'Audio', 'audio', (a) => `${a.codec} ${a.dur}s`],
  ['images', 'Images', 'image', (im) => `${im.cat} ×${im.n}`],
  ['anims', 'Animations', 'anim', (a) => `Rig #${a.skel} · ${a.frames} frames`],
  ['rigs', 'Rigs', 'rig', (s) => `${s.bones} bones`],
];

export class GlobalSearch {
  app: any;
  input: HTMLInputElement;
  host: HTMLElement;
  items: SearchItem[];
  active: number;
  ready: Promise<Record<string, IndexEntry[]>> | null;

  constructor(app: any, input: HTMLInputElement, resultsHost: HTMLElement) {
    this.app = app;
    this.input = input;
    this.host = resultsHost;
    this.items = [];   // flattened result rows
    this.active = -1;
    this.ready = null;

    input.addEventListener('input', debounce(() => this.run(), 120));
    input.addEventListener('focus', () => { if (input.value.trim()) this.run(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.hide(); input.blur(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.moveActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.moveActive(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const it = this.items[this.active] || this.items[0];
        if (it) this.go(it);
      }
    });
    document.addEventListener('click', (e) => {
      if (!this.host.contains(e.target as Node) && e.target !== input) this.hide();
    });
  }

  async ensureSources(): Promise<Record<string, IndexEntry[]>> {
    if (this.ready) return this.ready;
    const { store } = this.app;
    this.ready = (async () => {
      const cats = Object.keys(store.manifest?.categories || {});
      const src: Record<string, IndexEntry[]> = {};
      await Promise.all(cats.map(async (c) => { try { src[c] = await store.index(c); } catch { src[c] = []; } }));
      return src;
    })();
    return this.ready;
  }

  hide(): void { this.host.hidden = true; }

  moveActive(d: number): void {
    if (!this.items.length) return;
    this.active = (this.active + d + this.items.length) % this.items.length;
    this.host.querySelectorAll('.search-item').forEach((n, i) => n.classList.toggle('active', i === this.active));
    this.host.querySelector('.search-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  go(item: SearchItem): void {
    this.hide();
    this.input.blur();
    if (item.action) item.action();
    else location.hash = item.hash!;
  }

  async run(): Promise<void> {
    const q = this.input.value.trim().toLowerCase();
    if (!q) { this.hide(); return; }
    const src = await this.ensureSources();
    if (this.input.value.trim().toLowerCase() !== q) return; // stale
    const groups: { title: string; items: SearchItem[] }[] = [];
    const num = /^\d+$/.test(q);          // index-number query
    const hex = /^[0-9a-f]{2,16}$/.test(q); // content-hash prefix query (hex, incl. all-digit)
    const qq = q.replace(/^#/, '');

    const push = (title: string, arr: SearchItem[], cap = MAX_PER_GROUP) => { if (arr.length) groups.push({ title, items: arr.slice(0, cap) }); };

    // every category: by index number, content-hash prefix, or friendly name
    for (const [key, title, route, metaFn] of CAT_DEFS) {
      const matches = (src[key] || []).filter((e) => {
        if (num && String(e.i).startsWith(qq)) return true;
        if (hex && e.h && e.h.startsWith(q)) return true;
        const name = effectiveName(e, key);
        if (name && name.toLowerCase().includes(q)) return true;
        if (key === 'images' && e.cat && e.cat.toLowerCase().includes(q)) return true;
        return false;
      });
      push(title, matches.map((e) => ({
        label: effectiveName(e, key) || `${route} ${idLabel(e)}`,
        meta: `#${e.i} · ${metaFn(e)}`,
        hash: `#/${route}/${e.i}`,
      })));
    }

    // strings: substring over the whole corpus, hard-capped per group, with a
    // "see all N ▸" footer that routes to the Strings tab with the query
    // pre-loaded in the list filter
    if (q.length >= 2) {
      const matches = (src.strings || []).filter((s) => s.text.toLowerCase().includes(q)
        || (s.h && hex && s.h.startsWith(q)));
      const items: SearchItem[] = matches.slice(0, MAX_PER_GROUP).map((s) => ({
        label: s.text.length > 70 ? `${s.text.slice(0, 70)}…` : s.text,
        meta: `#${s.i}`, hash: `#/string/${s.i}`,
      }));
      if (matches.length > MAX_PER_GROUP) {
        items.push({
          label: `see all ${matches.length} in Text ▸`,
          meta: '', footer: true,
          action: () => {
            if (this.app.cur?.cat === 'strings') {
              this.app.filterEl.value = q;
              this.app.refreshList();
            } else {
              this.app.pendingListFilter = q;
              location.hash = '#/strings';
            }
          },
        });
      }
      push('Text', items, MAX_PER_GROUP + 1);
    }

    this.renderResults(groups);
  }

  renderResults(groups: { title: string; items: SearchItem[] }[]): void {
    clear(this.host);
    this.items = [];
    this.active = -1;
    if (!groups.length) {
      this.host.appendChild(el('div', { class: 'center-note small', text: 'No matches.' }));
      this.host.hidden = false;
      return;
    }
    for (const g of groups) {
      this.host.appendChild(el('div', { class: 'search-group', text: g.title }));
      for (const item of g.items) {
        const node = el('div', { class: `search-item${item.footer ? ' dim' : ''}` },
          el('span', { class: 'si-label', text: item.label }),
          el('span', { class: 'si-meta', text: item.meta }));
        node.addEventListener('click', () => this.go(item));
        this.host.appendChild(node);
        this.items.push(item);
      }
    }
    this.host.hidden = false;
  }
}
