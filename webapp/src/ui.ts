// Small DOM + formatting helpers shared by all views.

import { getVersionName } from './prefs.js';
import type { VersionRecord } from './storage.js';
import type { IndexEntry } from './store.js';

export type ElChild = Node | string | null | undefined;
export type ElAttrs = Record<string, any>;

// The one-line desktop-only rationale, shared by the onboarding legal footer
// and the mobile gate (mobile-gate.ts) so the two can never drift apart.
export const DESKTOP_ONLY_LINE = 'Works in desktop browsers (mobile lacks the memory + storage this needs).';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: ElAttrs, ...children: (ElChild | ElChild[])[]): HTMLElementTagNameMap[K];
export function el(tag: string, attrs?: ElAttrs, ...children: (ElChild | ElChild[])[]): HTMLElement;
export function el(tag: string, attrs: ElAttrs = {}, ...children: (ElChild | ElChild[])[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v === 'boolean') (node as any)[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear<T extends Node>(node: T): T { while (node.firstChild) node.removeChild(node.firstChild); return node; }

// append that skips null/undefined (DOM's native append stringifies them)
export function append<T extends Node>(parent: T, ...kids: (ElChild | ElChild[])[]): T {
  for (const k of kids.flat()) if (k != null) parent.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return parent;
}

export function badge(text: string, kind = '', title = ''): HTMLSpanElement {
  return el('span', { class: `badge ${kind}`, title: title || null, text });
}

export function fmtInt(n: number | null | undefined): string { return n == null ? '-' : n.toLocaleString('en-US'); }

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtDur(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return '-';
  if (sec < 60) return `${sec.toFixed(2)}s`;
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// Human, unambiguous date in a fixed DD-Mon-YYYY form (e.g. 06-Jul-2026). The
// named month sidesteps the DD/MM-vs-MM/DD trap a bare numeric date creates for
// international users; the fixed form keeps it stable across locales. Accepts
// epoch ms, ISO string, or Date.
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(v: number | string | Date | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS_ABBR[d.getMonth()]}-${d.getFullYear()}`;
}

// fmtDate + HH:MM:SS (24h, local): the storage panel's detail form
export function fmtDateTime(v: number | string | Date | null | undefined): string | null {
  const date = fmtDate(v);
  if (!date) return null;
  const d = v instanceof Date ? v : new Date(v as any);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// The decode-data build label as displayed: the trailing "(hash8)" identity is
// stripped from the name ("23-Apr-2025 (35f5efbc)" -> "23-Apr-2025"): it
// lives in the storage panel's per-version details instead.
export function profileLabelDate(label: string): string {
  return label.replace(/\s*\([0-9a-f]{8,16}\)\s*$/i, '');
}

// Is the version's date a trustworthy BUILD date, or just when the files were
// written locally? `builtAt` is the newest bundle-file mtime. That equals the
// real update date only for an in-place Steam update, where unchanged bundles
// keep their old mtime, so the bundles' mtimes are spread over time. A fresh
// full download / clean install (or a depot-downloader pull) writes every
// bundle at once, so their mtimes cluster tightly and the date is merely the
// download time. A spread of at least a day is the tell for a real update.
const RELIABLE_SPREAD_MS = 24 * 60 * 60 * 1000;
export function versionDateReliable(v: VersionRecord | null | undefined): boolean {
  const m = Object.values(v?.bundles || {}).map((b) => b?.mtime).filter((x): x is number => x != null);
  if (m.length < 2) return false;
  return (Math.max(...m) - Math.min(...m)) >= RELIABLE_SPREAD_MS;
}

// The date badge for a version: "built <date>" only when the date is a real
// build date; otherwise "added <date>" (when you downloaded/imported the files).
export function versionDateLabel(v: VersionRecord | null | undefined): string | null {
  if (!v?.builtAt) return null;
  return `${versionDateReliable(v) ? 'built' : 'added'} ${fmtDate(v.builtAt)}`;
}

// A version's display name. Priority: the user's friendly name (a local pref) >
// a legacy custom label > the build label from the per-build decode data >
// an auto label. The auto label only embeds the date when it's a trustworthy
// build date; otherwise it falls back to the stable content id, since the file
// date isn't the build date. `profileLabel` sits above both auto forms: it is
// matched by content hash, so it names the build exactly ("build 23-Apr-2025")
// regardless of when the files were downloaded.
export function versionLabel(v: VersionRecord | null | undefined): string {
  if (!v) return '';
  const friendly = getVersionName(v.versionId);
  if (friendly) return friendly;
  if (v.label && !/^build /i.test(v.label)) return v.label;
  if (v.profileLabel) return `build ${profileLabelDate(v.profileLabel)}`;
  if (v.builtAt && versionDateReliable(v)) return `build ${fmtDate(v.builtAt)}`;
  return `build ${(v.versionId || '').slice(0, 8)}`;
}

// Platform (macOS / Windows) logo for a version, from its detected `platform`
// ('mac' | 'win'). Returns null for unknown. `source` distinguishes an exact
// read of the shader bundle ('bundle') from a browser guess ('ua-guess'), which
// is rendered dimmer with a caveat tooltip. Icons are inline SVG (Apple mark /
// the four-pane Windows mark), tinted via currentColor.
const PLATFORMS: Record<string, { label: string; svg: string }> = {
  mac: { label: 'macOS', svg: '<path d="M11.182.008C11.148-.03 9.923.023 8.857 1.18c-1.066 1.156-.902 2.482-.878 2.516.024.034 1.52.087 2.475-1.258.955-1.345.762-2.391.728-2.43zm3.314 11.733c-.048-.096-2.325-1.234-2.113-3.422.212-2.189 1.675-2.789 1.698-2.854.023-.065-.597-.79-1.254-1.157a3.7 3.7 0 0 0-1.563-.434c-.108-.003-.483-.095-1.254.116-.508.139-1.653.589-1.968.607-.316.018-1.256-.522-2.267-.665-.647-.125-1.333.131-1.824.328-.49.196-1.422.754-2.074 2.237-.652 1.482-.311 3.83-.067 4.56.244.729.625 1.924 1.273 2.796.576.984 1.34 1.667 1.659 1.899.319.232 1.219.386 1.843.067.502-.308 1.408-.485 1.766-.472.357.013 1.061.154 1.782.539.571.197 1.111.115 1.652-.105.541-.221 1.324-1.059 2.238-2.758.347-.79.505-1.217.473-1.282z"/>' },
  win: { label: 'Windows', svg: '<rect x="0.5" y="0.5" width="6.7" height="6.7"/><rect x="8.8" y="0.5" width="6.7" height="6.7"/><rect x="0.5" y="8.8" width="6.7" height="6.7"/><rect x="8.8" y="8.8" width="6.7" height="6.7"/>' },
};
export function platformIcon(platform: string | null | undefined, source?: string | null): HTMLSpanElement | null {
  const p = platform ? PLATFORMS[platform] : null;
  if (!p) return null;
  const guessed = source === 'ua-guess';
  const span = document.createElement('span');
  span.className = `plat-icon plat-${platform}${guessed ? ' plat-guess' : ''}`;
  span.title = guessed
    ? `${p.label} build, guessed from your browser; drop assetBundle4 or 7 for exact detection`
    : `${p.label} build`;
  span.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">${p.svg}</svg>`;
  return span;
}

export function fmtNum(x: number | null | undefined, dp = 2): string {
  if (x == null || !isFinite(x)) return '-';
  return Number(x).toFixed(dp).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m));
}

export function pad5(i: number | string): string { return String(i).padStart(5, '0'); }

// primary visual identifier: stable content hash (short) when available,
// bundle ordinal as fallback (and always shown as the secondary id)
export function hash8(e: Partial<IndexEntry> | null | undefined): string | null { return e?.h ? e.h.slice(0, 8) : null; }
export function idLabel(e: Partial<IndexEntry> | null | undefined): string { return hash8(e) || `#${e!.i}`; }

// key/value table for the details panel
export function kvTable(pairs: Iterable<readonly [string, any]>): HTMLTableElement {
  const t = el('table', { class: 'kv' });
  for (const [k, v] of pairs) {
    if (v == null) continue;
    const td = el('td');
    if (v instanceof Node) td.appendChild(v);
    else td.textContent = String(v);
    t.appendChild(el('tr', {}, el('td', { text: k }), td));
  }
  return t;
}

// Raw JSON view with base64 payloads truncated so the panel stays usable.
export function rawJson(obj: any): HTMLDivElement {
  const shorten = (o: any): any => {
    if (typeof o === 'string') return o.length > 96 ? `${o.slice(0, 64)}… (${o.length} chars)` : o;
    if (Array.isArray(o)) return o.length > 64 ? [...o.slice(0, 64).map(shorten), `… ${o.length - 64} more`] : o.map(shorten);
    if (o && typeof o === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(o)) out[k] = shorten(v);
      return out;
    }
    return o;
  };
  return el('div', { class: 'rawjson', text: JSON.stringify(shorten(obj), null, 1) });
}

export function placeholderCard(title: string, ...body: (ElChild | ElChild[])[]): HTMLDivElement {
  return el('div', { class: 'placeholder' }, el('div', { class: 'card' }, el('h2', { text: title }), ...body));
}

export function notExported(what: string): HTMLDivElement {
  return el('div', { class: 'notexported' },
    badge('not loaded', 'b-warn b-ghost'),
    el('div', { class: 'small', text: `${what} isn't loaded yet. Add it from your game files to view it.` }));
}

export function debounce<A extends any[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// stable distinct color per integer (used for bone tinting)
export function hashColor(i: number, s = 70, l = 60): string {
  const h = (i * 137.508) % 360; // golden angle
  return `hsl(${h.toFixed(1)},${s}%,${l}%)`;
}
export function hashColorRGB(i: number): [number, number, number] {
  const h = ((i * 137.508) % 360) / 360, s = 0.7, l = 0.6;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number): number => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

// ---------------------------------------------------------------------------
// draggable panel resizer: drop a slim handle on one edge of `panel`; dragging
// adjusts its width (vertical edges) or height (horizontal edges), persisted
// in localStorage under bs.panel.<key>. The panel must be a flex-none block
// whose size is its inline width/height style.
export function makeResizable(panel: HTMLElement | null | undefined,
  { edge = 'right', key, min = 160, max = 900 }: { edge?: 'left' | 'right' | 'top' | 'bottom'; key?: string; min?: number; max?: number } = {}): void {
  if (!panel || panel.querySelector(':scope > .rz-handle')) return;
  const horizontal = edge === 'left' || edge === 'right';
  const prop = horizontal ? 'width' : 'height';
  const storeKey = key ? `bs.panel.${key}` : null;
  const apply = (px: number) => {
    panel.style[prop] = `${px}px`;
    panel.style.flex = '0 0 auto';   // beat any flex-basis the layout set
  };
  if (storeKey) {
    const saved = parseInt(localStorage.getItem(storeKey) || '', 10);
    if (saved >= min && saved <= max) apply(saved);
  }
  if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
  const handle = el('div', { class: `rz-handle rz-${edge}`, title: 'Drag to resize' });
  panel.appendChild(handle);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = horizontal ? e.clientX : e.clientY;
    const size0 = horizontal ? panel.getBoundingClientRect().width : panel.getBoundingClientRect().height;
    const sign = (edge === 'left' || edge === 'top') ? -1 : 1;
    const move = (ev: PointerEvent) => {
      const d = ((horizontal ? ev.clientX : ev.clientY) - start) * sign;
      apply(Math.round(Math.min(max, Math.max(min, size0 + d))));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      if (storeKey) {
        try { localStorage.setItem(storeKey, String(Math.round(panel.getBoundingClientRect()[prop === 'width' ? 'width' : 'height']))); } catch { /* */ }
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}
