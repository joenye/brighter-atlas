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

// -> true when this browser's ACTIVE version was extracted by an engine
// older than `generation` (every fresh extraction stamps `engine` on the
// version record; pre-0.4.0 records have none and count as 0).
async function engineOlderThan(app: any, generation: number): Promise<boolean> {
  if (!app.store.versionId) return false;   // classic HTTP mode: nothing to re-extract
  try {
    const { getVersion } = await import('./storage.js');
    const rec = await getVersion(app.store.versionId);
    return !!rec && (rec.engine ?? 0) < generation;
  } catch { return false; }
}

const pre040Extraction = (app: any) => engineOlderThan(app, 1);

// World notices: only for data on the current engine (older data is already
// sent to re-extract by the engine notices below) whose saved World index
// predates a coordinate_system revision.
const worldStale = (stale: (system: any) => boolean) => async (app: any): Promise<boolean> => {
  if (!app.store.versionId || await engineOlderThan(app, 3)) return false;
  const index = await app.store.worldIndex();
  return !!index && stale(index.coordinate_system ?? {});
};
// The World index revisions 0.7.0 extractions carry.
const WORLD_070: Record<string, number> = {
  owner_alignment_revision: 2, room_world_position_revision: 1, occurrence_draw_revision: 2,
  effect_anchor_revision: 8, effect_property_revision: 5, water_revision: 1, scenery_trim_revision: 1,
  draw_order_revision: 1, spawn_idle_revision: 1,
};
const WORLD_UPDATE = 'To update saved World data, open the version menu, choose "Add version (new game build)", and select World after choosing your current game files.';

const NOTICES: Notice[] = [
  {
    id: 'world-0.7.0',
    title: 'Brighter Atlas 0.7.0: the world as the game draws it',
    paras: [
      'Rooms now use the game’s own lighting and materials, seas and rivers move and reflect the sky, people and creatures rest in their own animations, and effects and room pieces sit where the game puts them. Models also gain their in-game information card picture and the names the game gives them.',
      'All of this is worked out when your game files are read, so your saved World data still has the old version. ' + WORLD_UPDATE,
      'Your names, texture assignments and Models are keyed by stable ids, so they all survive the re-extraction.',
    ],
    when: worldStale((s) => Object.entries(WORLD_070).some(([key, revision]) => (s[key] ?? 0) < revision)),
  },
  {
    id: 'extraction-engine-3-equipment',
    title: 'Equipment names and body slots: time for a fresh extraction',
    paras: [
      'Armour, boots, gloves and capes get their in-game names back (a recent game update moved where those names are kept), and every piece on the player now says which part of the body it belongs to, so you can browse a rig a slot at a time.',
      'That is worked out when your game files are read, so your stored data still has the old version. To pick it up, click the version chip in the top-right, choose "Add build", and drop in your assetBundle files.',
      'Your names, texture assignments and Models are keyed by stable ids, so they all survive the re-extraction.',
    ],
    // Same rule as the notice below: only for data no OLDER notice already
    // sends to the same place.
    when: async (app: any) => (await engineOlderThan(app, 3))
      && !(await engineOlderThan(app, 2)),
  },
  {
    id: 'extraction-engine-2-effects',
    title: 'Particle effects: time for a fresh extraction',
    paras: [
      'Effects now sit where the game puts them, at the size and colour it draws them, and effects that were being shown on the wrong objects are gone.',
      'Most of that is decided when your game files are read, so your stored data still has the old version. To pick it up, click the version chip in the top-right, choose "Add build", and drop in your assetBundle files.',
      'Your names, texture assignments and Models are keyed by stable ids, so they all survive the re-extraction.',
    ],
    // Only for data the 0.4.0 notice does NOT already cover: someone still on
    // pre-0.4.0 data is being told to re-extract by that notice already, and
    // two stacked prompts saying the same thing is worse than one.
    when: async (app: any) => (await engineOlderThan(app, 2))
      && !(await engineOlderThan(app, 1)),
  },
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
