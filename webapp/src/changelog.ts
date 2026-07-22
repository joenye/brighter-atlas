// "What's new": renders the deploy-time changelog.json (generated at release
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
    // Only releases with a written What's-new exist as far as the app is
    // concerned: notes-free patch tags are excluded at bake time too, but
    // filtering here guarantees they can never surface in-app.
    cache = fetch('./changelog.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => (Array.isArray(v)
        ? v.filter((e) => e && typeof e.summary === 'string' && e.summary.trim()) : null))
      .then((v) => (v && v.length ? v : null))
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
// is a "YYYY-MM-DD" tag date: parse it as LOCAL (not the UTC midnight that
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

// The player-facing summary only. Commit lists are technical detail and are
// deliberately never rendered in-app (the notes convention: written for
// non-technical players).
function details(e: ChangelogEntry): HTMLElement[] {
  return e.summary ? [el('p', { class: 'wn-summary', text: e.summary })] : [];
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
    // changelogReady only yields summarized releases, so the newest entry is
    // always the headline; notes-free patch tags never appear at all.
    body.appendChild(renderLatest(list[0]));
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

// 'v1.2.3' ordering; non-parseable versions compare equal (never pop on them)
function cmpVersions(a: string, b: string): number {
  const pa = /^v(\d+)\.(\d+)\.(\d+)$/.exec(a);
  const pb = /^v(\d+)\.(\d+)\.(\d+)$/.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) { const d = (+pa[i]) - (+pb[i]); if (d) return d; }
  return 0;
}

// Auto-show once when a release WITH release notes shipped since the user's
// last visit. First-ever visit (no stored version) is recorded silently so a
// brand-new user is never interrupted, and notes-free patch releases never
// pop the modal (there is nothing new to read: the seen marker just advances).
export async function maybeAutoShowWhatsNew(): Promise<void> {
  await buildInfoReady;
  const cur = currentVersion();
  if (!cur) return; // dev build / no version
  let seen: string | null = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { /* storage unavailable */ }
  if (seen == null) { markSeen(); return; } // first run: record, don't nag
  if (seen === cur) return; // already on this version
  const list = await changelogReady();
  if (list && cmpVersions(list[0].version, seen) > 0) openWhatsNew();
  else markSeen();
}
