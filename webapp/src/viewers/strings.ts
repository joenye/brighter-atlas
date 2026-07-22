// String viewer: the full decoded text, selectable, with copy + a quick
// "related" text search (an honest substring search over the corpus: string
// ownership/linkage is unknown, so we never pretend a join).

import { el, append } from '../ui.js';
import { exportButton } from '../asset-export.js';
import type { IndexEntry } from '../store.js';

export function createStringView(app: any, entry: IndexEntry) {
  const root = el('div', { class: 'string-view' });

  const copyBtn = el('button', { class: 'btn btn-mini', text: 'copy' });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(entry.text);
      copyBtn.textContent = 'copied ✓';
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
    } catch { /* clipboard unavailable */ }
  });

  const card = el('div', { class: 'card string-card' },
    el('div', { class: 'string-head' },
      el('span', {
        class: 'mono dim small',
        text: `#${entry.i} · ${entry.src === 'table' ? 'game text table' : 'data record'}`
          + `${(entry.n || 1) > 1 ? ` · appears ×${entry.n}` : ''}`,
        title: entry.src === 'table'
          ? "A row of the game's canonical text table (items, UI, dialogue)."
          : 'Text embedded in a game-data (world/entity definition) record.',
      }),
      el('span', { class: 'spacer' }), copyBtn, exportButton(app, 'strings', entry, { mini: true })),
    el('pre', { class: 'string-text', text: entry.text }));

  // Nearby table rows: the text table's row ORDER is semantic. Conversations,
  // item families and UI groups are contiguous runs (insertions preserve the
  // run structure across versions). Showing the neighbours reconstructs the
  // dialogue/topic flow.
  const nearby = entry.src === 'table'
    ? el('div', { class: 'card string-related' }, el('h3', { text: 'Nearby in the text table' }),
      el('p', { class: 'dim small', text: 'The rows just before and after this one. Related text (a conversation, an item family) is stored together, so this often reads as the surrounding dialogue or topic.' }))
    : null;

  // related strings: same leading token (identifiers) or shared rare word (prose)
  const related = el('div', { class: 'card string-related' }, el('h3', { text: 'Similar text' }),
    el('p', { class: 'dim small', text: 'Other lines of text that contain the same word. This is a plain word search. The game files don\'t say which asset a piece of text belongs to.' }));
  (async () => {
    try {
      const all: IndexEntry[] = await app.store.index('strings');
      if (nearby) {
        // index order == file order, and table rows are contiguous in the file,
        // so table neighbours are the adjacent src==='table' entries
        const at = all.findIndex((s) => s.i === entry.i);
        const rowsAround: IndexEntry[] = [];
        for (let k = at - 1, taken = 0; k >= 0 && taken < 6; k--) {
          if (all[k].src === 'table') { rowsAround.unshift(all[k]); taken++; }
        }
        rowsAround.push(entry);
        for (let k = at + 1, taken = 0; k < all.length && taken < 6; k++) {
          if (all[k].src === 'table') { rowsAround.push(all[k]); taken++; }
        }
        const list = el('div', {});
        for (const s of rowsAround) {
          const cur = s.i === entry.i;
          list.appendChild(el('a', { class: `string-rel-row${cur ? ' string-rel-cur' : ''}`, href: `#/string/${s.i}` },
            el('span', { class: 'mono dim small', text: `#${s.i}` }),
            el('span', { class: 'small', text: s.text.length > 110 ? `${s.text.slice(0, 110)}…` : s.text })));
        }
        nearby.appendChild(list);
      }
      const probe = /\s/.test(entry.text)
        ? (entry.text.match(/[A-Za-z']{7,}/) || [entry.text.slice(0, 12)])[0]
        : entry.text.split(/[._:/-]/)[0];
      const q = probe.toLowerCase();
      const hits = all.filter((s) => s.i !== entry.i && s.text.toLowerCase().includes(q)).slice(0, 12);
      if (!hits.length) { related.appendChild(el('p', { class: 'dim small', text: 'None found.' })); return; }
      const list = el('div', {});
      for (const s of hits) {
        const a = el('a', { class: 'string-rel-row', href: `#/string/${s.i}` },
          el('span', { class: 'mono dim small', text: `#${s.i}` }),
          el('span', { class: 'small', text: s.text.length > 110 ? `${s.text.slice(0, 110)}…` : s.text }));
        list.appendChild(a);
      }
      append(related, el('p', { class: 'dim small mono', text: `matching “${probe}”` }), list);
    } catch { /* index unavailable */ }
  })();

  root.append(card, ...(nearby ? [nearby] : []), related);
  return { root, destroy() {} };
}
