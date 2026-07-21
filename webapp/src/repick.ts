// One-bundle re-pick recovery — the bottom rung of the degradation ladder
// (design §4): when a payload's raw bundle has been evicted from storage
// (typical Safari outcome), ask the user to re-pick JUST that file, verify it
// is byte-identical (sha256 must match the version record), store it, and
// retry. Browsing/search/annotations never needed the raw tier, and a re-pick
// is never a re-extract — the derived indexes are still in IndexedDB.

import { el, fmtBytes } from './ui.js';
import { hashBlob } from './extract/hash.js';
import { writeRaw } from './storage.js';
import { BUNDLE_LABEL } from './extract/ingest.js';

let open = false;

export function openRepickDialog(app: any, { n, sha }: { n: number; sha: string }): void {
  if (open) return;   // one at a time — several payloads can fail in a burst
  open = true;
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => { overlay.remove(); open = false; };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const status = el('p', { class: 'dim small', text: 'Your browser cleared its saved copy of this game file. Everything else — your library, search, names and texture assignments — is still here. Re-select this one file to view it again.' });
  const input = el('input', { type: 'file', style: 'display:none' });
  const pickBtn = el('button', { class: 'btn primary', text: `Re-select assetBundle${n}` });
  const closeBtn = el('button', { class: 'btn', text: 'Not now' });
  closeBtn.addEventListener('click', close);
  pickBtn.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    pickBtn.disabled = true;
    try {
      status.textContent = `Verifying ${f.name} (${fmtBytes(f.size)})…`;
      const got = await hashBlob(f, (done: number, total: number) => {
        status.textContent = `Verifying ${f.name}… ${fmtBytes(done)} / ${fmtBytes(total)}`;
      });
      if (got !== sha) {
        throw new Error(`this is a different copy of assetBundle${n} — it doesn't match the one saved here. `
          + `Select the assetBundle${n} from the same game install, or add it as a new version instead.`);
      }
      status.textContent = 'Storing…';
      await writeRaw(sha, f, (done, total) => {
        status.textContent = `Storing… ${fmtBytes(done)} / ${fmtBytes(total)}`;
      });
      app.store.invalidateBundle?.(n);
      app.banner(`assetBundle${n} restored — you can view it again`, 'b-info');
      close();
      app.mountView(app.cur, ++app._navToken);   // retry the open view
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('err');
      pickBtn.disabled = false;
    }
    input.value = '';
  });

  overlay.appendChild(el('div', { class: 'modal card' },
    el('h2', { text: `assetBundle${n} (${BUNDLE_LABEL[n]}) needs re-selecting` }),
    status, input,
    el('div', { class: 'modal-actions' }, pickBtn, el('span', { class: 'spacer' }), closeBtn)));
  document.body.appendChild(overlay);
}
