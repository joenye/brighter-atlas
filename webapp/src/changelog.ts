// "What's new" — renders the deploy-time changelog.json (generated at release
// from git tags + Conventional-Commit-grouped commits). Opens from the topbar
// version badge, and auto-shows ONCE when the app has updated to a version the
// user hasn't seen. Modal shell mirrors help.ts.
//
// changelog.json is baked into the deploy only; local/dev builds have none and
// the UI degrades gracefully ("No release notes in this build").

import { el, fmtDate } from './ui.js';
import { buildInfo, buildInfoReady } from './build-info.js';

const SEEN_KEY = 'bs.lastSeenVersion';

interface ChangelogCommit { shortSha: string; subject: string }
interface ChangelogGroup { label: string; commits: ChangelogCommit[] }
export interface ChangelogEntry {
  version: string;
  name?: string;
  date?: string;
  summary?: string;
  groups?: ChangelogGroup[];
}

let cache: Promise<ChangelogEntry[] | null> | undefined; // Promise<array|null>
export function changelogReady(): Promise<ChangelogEntry[] | null> {
  if (!cache) {
    cache = fetch('./changelog.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => (Array.isArray(v) && v.length ? v : null))
      .catch(() => null);
  }
  return cache;
}

// the running deployed version (null for a "dev build")
function currentVersion(): string | null {
  const info = buildInfo();
  return info && info.version && info.version !== 'dev' ? info.version : null;
}
function markSeen(): void {
  const v = currentVersion();
  if (v) { try { localStorage.setItem(SEEN_KEY, v); } catch { /* storage unavailable */ } }
}

// The app shows dates as DD-MMM-YYYY everywhere (ui.fmtDate). The changelog date
// is a "YYYY-MM-DD" tag date — parse it as LOCAL (not the UTC midnight that
// new Date('YYYY-MM-DD') yields) so the day never slips across a timezone.
function fmtWnDate(s: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? fmtDate(new Date(+m[1], +m[2] - 1, +m[3]))! : (s || '');
}

function head(e: ChangelogEntry): HTMLElement {
  return el('div', { class: 'wn-head' },
    el('span', { class: 'wn-ver', text: e.name || e.version }),
    el('span', { class: 'wn-meta small dim', text: `${e.version} · ${fmtWnDate(e.date)}` }));
}

// the summary paragraph + grouped commit lines — shared by the prominent latest
// entry and the collapsed older ones
function details(e: ChangelogEntry): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (e.summary) parts.push(el('p', { class: 'wn-summary', text: e.summary }));
  for (const g of e.groups || []) {
    parts.push(el('div', { class: 'wn-group-label small', text: g.label }));
    const ul = el('ul', { class: 'wn-commits' });
    for (const c of g.commits) {
      ul.appendChild(el('li', {},
        el('span', { class: 'wn-sha mono', text: c.shortSha }),
        ' ', el('span', { text: c.subject })));
    }
    parts.push(ul);
  }
  return parts;
}

// latest release: shown in full and prominent
function renderLatest(e: ChangelogEntry): HTMLElement {
  return el('div', { class: 'wn-entry wn-latest' }, head(e), ...details(e));
}

// an older release: collapsed to a one-line header; expand for the detail
function renderOld(e: ChangelogEntry): HTMLElement {
  return el('details', { class: 'wn-entry wn-old' },
    el('summary', { class: 'wn-old-summary' },
      el('span', { class: 'wn-ver', text: e.name || e.version }),
      el('span', { class: 'wn-meta small dim', text: `${e.version} · ${fmtWnDate(e.date)}` })),
    ...details(e));
}

export async function openWhatsNew(): Promise<void> {
  const list = await changelogReady();
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const body = el('div', { class: 'wn-body' });
  if (list && list.length) {
    body.appendChild(renderLatest(list[0]));           // newest, in full
    if (list.length > 1) {
      const earlier = el('details', { class: 'wn-earlier' },
        el('summary', { class: 'wn-earlier-summary', text: `Earlier releases (${list.length - 1})` }));
      for (const e of list.slice(1)) earlier.appendChild(renderOld(e));
      body.appendChild(earlier);
    }
  } else {
    body.appendChild(el('p', { class: 'dim', text: 'No release notes in this build.' }));
  }

  const closeBtn = el('button', { class: 'btn primary', text: 'Close', onclick: close });
  overlay.appendChild(el('div', { class: 'modal card wn-modal' },
    el('h2', { text: "What's new" }),
    body,
    el('div', { class: 'modal-actions' }, el('span', { class: 'spacer' }), closeBtn)));
  document.body.appendChild(overlay);
  markSeen(); // opening it counts as seeing the current version
}

// Auto-show once when the app updated since the user's last visit. First-ever
// visit (no stored version) is recorded silently so a brand-new user is never
// interrupted — only genuine upgrades pop the modal.
export async function maybeAutoShowWhatsNew(): Promise<void> {
  await buildInfoReady;
  const cur = currentVersion();
  if (!cur) return; // dev build / no version
  let seen: string | null = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { /* storage unavailable */ }
  if (seen == null) { markSeen(); return; } // first run: record, don't nag
  if (seen === cur) return; // already on this version
  const list = await changelogReady();
  if (list) openWhatsNew(); else markSeen();
}
