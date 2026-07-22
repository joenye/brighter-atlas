// One-time migration notices: release-specific messages shown once on boot to
// EXISTING users whose stored data would benefit from an action (re-extract,
// re-assign, …). Generic on purpose: future releases add an entry to NOTICES.
//
// Rules:
//  - a notice shows only while its when(app) predicate holds, so it self-limits
//    to the users it actually concerns (fresh extractions never see it);
//  - it goes away ONLY via the explicit "Understood" button (no Escape, no
//    overlay click): anything less re-shows it on the next visit;
//  - acknowledgements persist per-browser in localStorage (bs.noticesAck):
//    if the user later wipes storage and re-extracts, the predicate is false
//    anyway, so a lost ack never nags.

import { el } from './ui.js';

const KEY = 'bs.noticesAck';

interface Notice {
  id: string;
  title: string;
  paras: string[];
  when: (app: any) => boolean | Promise<boolean>;
}

const acked = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(KEY)!) || {}; } catch { return {}; }
};
const ack = (id: string): void => {
  try { localStorage.setItem(KEY, JSON.stringify({ ...acked(), [id]: new Date().toISOString() })); }
  catch { /* storage unavailable: it will simply show again */ }
};

// -> true when this browser holds a client extraction whose strings index
// predates the 0.3.1 resolver (old entries have no `src` field)
async function oldStringsExtraction(app: any): Promise<boolean> {
  if (!app.store.versionId) return false;   // classic HTTP mode: nothing to re-extract
  try {
    const strings = await app.store.index('strings');
    return strings.length > 0 && strings[0].src === undefined;
  } catch { return false; }
}

// -> true when this browser's ACTIVE version was extracted by a pre-0.4.0
// engine (fresh 0.4.0 extractions stamp `engine` on the version record)
async function pre040Extraction(app: any): Promise<boolean> {
  if (!app.store.versionId) return false;   // classic HTTP mode: nothing to re-extract
  try {
    const { getVersion } = await import('./storage.js');
    const rec = await getVersion(app.store.versionId);
    return !!rec && (rec.engine ?? 0) < 1;
  } catch { return false; }
}

const NOTICES: Notice[] = [
  {
    id: 'extraction-engine-0.4.0',
    title: 'Brighter Atlas 0.4.0: time for a fresh extraction',
    paras: [
      'This release overhauls how the world is extracted: room names now stay correct across game updates, and per-build support arrives without waiting for an app update.',
      'Your stored data was extracted by the previous engine. To get the improvements, add your current game files as a new build: click the version chip in the top-right, then "Add build", and drop in your assetBundle files.',
      'Your names, texture assignments and Models are keyed by stable ids, so they all survive the re-extraction.',
    ],
    when: pre040Extraction,
  },
  {
    id: 'strings-resolver-0.3.1',
    title: 'Game text extraction has improved',
    paras: [
      'This update decodes the game’s text far more cleanly: the garbled junk and duplicates are gone, and dialogue reads in order.',
      'Your stored text was extracted with the old decoder. To get the improvement, delete this version (click the version chip in the top-right) and re-add your assetBundle files.',
      'Your names, texture assignments and Models are keyed by stable ids, so they all survive the re-extraction.',
    ],
    when: oldStringsExtraction,
  },
];

// Show pending notices SEQUENTIALLY: one modal at a time, and the next only
// appears after the previous is acknowledged, so a user who missed several
// releases clears the backlog in one sitting without ever seeing a stack.
// Called fire-and-forget after boot.
export async function showPendingNotices(app: any): Promise<void> {
  const done = acked();
  for (const n of NOTICES) {
    if (done[n.id]) continue;
    let show = false;
    try { show = await n.when(app); } catch { /* predicate failure = skip */ }
    if (!show) continue;
    await new Promise<void>((resolve) => {
      const overlay = el('div', { class: 'modal-overlay' });
      const okBtn = el('button', { class: 'btn primary', text: 'Understood' });
      okBtn.addEventListener('click', () => { ack(n.id); overlay.remove(); resolve(); });
      // deliberately NO Escape / overlay-click close: dismissal must be explicit
      overlay.appendChild(el('div', { class: 'modal card notice-modal' },
        el('h2', { text: n.title }),
        ...n.paras.map((t) => el('p', { class: 'help-a', text: t })),
        el('div', { class: 'modal-actions' }, okBtn)));
      document.body.appendChild(overlay);
    });
  }
}
