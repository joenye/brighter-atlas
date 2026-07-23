// Collapsible side panels. Each side panel (the sidebar list, the details
// panel) carries a chevron toggle on its inner edge; collapsing shrinks the
// panel to a narrow rail whose whole height is the expand button, and #main
// takes the freed width. State persists in localStorage under bs.panels
// (true = collapsed). The details panel auto-expands when navigation lands a
// selection in it (expandPanelForContent, wired in main.ts); the sidebar
// never auto-expands. [ and ] toggle the panels from the keyboard.

import { el } from './ui.js';

const KEY = 'bs.panels';

type PanelId = 'sidebar' | 'details';
const PANEL_IDS: PanelId[] = ['sidebar', 'details'];

// what: tooltip noun; key: shortcut shown in the tooltip; min/max mirror the
// makeResizable() bounds in main.ts so a restored width is always one that
// handle could have produced.
const CFG: Record<PanelId, { what: string; key: string; min: number; max: number }> = {
  sidebar: { what: 'list', key: '[', min: 220, max: 640 },
  details: { what: 'details', key: ']', min: 220, max: 720 },
};
// [collapse, expand] chevrons: each panel collapses toward its own screen edge
const GLYPHS: Record<PanelId, [string, string]> = {
  sidebar: ['‹', '›'],
  details: ['›', '‹'],
};

function load(): Partial<Record<PanelId, boolean>> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY)!);
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
const state = load();
function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

const buttons: Partial<Record<PanelId, HTMLButtonElement>> = {};

function apply(id: PanelId): void {
  const panel = document.getElementById(id);
  const btn = buttons[id];
  if (!panel || !btn) return;
  const collapsed = !!state[id];
  panel.classList.toggle('collapsed', collapsed);
  if (collapsed) {
    // drop any inline width makeResizable applied so the rail CSS can size it
    panel.style.width = '';
    panel.style.flex = '';
  } else {
    const { min, max } = CFG[id];
    const saved = parseInt(localStorage.getItem(`bs.panel.${id}`) || '', 10);   // makeResizable's store
    if (saved >= min && saved <= max) { panel.style.width = `${saved}px`; panel.style.flex = '0 0 auto'; }
  }
  const verb = collapsed ? 'Expand' : 'Collapse';
  btn.textContent = GLYPHS[id][collapsed ? 1 : 0];
  btn.title = `${verb} the ${CFG[id].what} panel  ( ${CFG[id].key} )`;
  btn.setAttribute('aria-label', `${verb} the ${CFG[id].what} panel`);
  btn.setAttribute('aria-expanded', String(!collapsed));
  // the virtual list re-measures on window resize; viewers use ResizeObserver
  window.dispatchEvent(new Event('resize'));
}

export function setPanelCollapsed(id: PanelId, collapsed: boolean): void {
  if (!!state[id] === collapsed) return;
  state[id] = collapsed;
  save();
  apply(id);
}

export function togglePanel(id: PanelId): void { setPanelCollapsed(id, !state[id]); }

// The app navigated content into the panel: make it visible. Only the details
// panel uses this (a selection made while it is collapsed would otherwise land
// nowhere the user can see); the sidebar is never auto-expanded.
export function expandPanelForContent(id: PanelId): void {
  if (state[id]) setPanelCollapsed(id, false);
}

export function initPanels(): void {
  for (const id of PANEL_IDS) {
    const panel = document.getElementById(id);
    if (!panel || buttons[id]) continue;
    const btn = el('button', { class: 'panel-toggle', 'aria-controls': id });
    btn.addEventListener('click', () => togglePanel(id));
    panel.appendChild(btn);
    buttons[id] = btn;
    apply(id);
  }
  // [ / ] toggle the panels (same typing guard as the / search shortcut)
  document.addEventListener('keydown', (e) => {
    if ((e.key !== '[' && e.key !== ']') || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const tag = (target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) return;
    e.preventDefault();
    togglePanel(e.key === '[' ? 'sidebar' : 'details');
  });
}
