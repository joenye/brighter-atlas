// Storage & versions panel, opened from the topbar chip in client mode.
// One surface for: the version registry (switch active / add a new game
// build / delete), per-version bundle info, "extract more
// categories" for the active version, persistence status (+ make-permanent),
// and storage usage. The diff/compare UI (diff.ts) hangs off the same
// registry via the "compare" selector.

import { el, clear, fmtBytes, fmtDateTime, versionLabel, versionDateReliable, platformIcon } from './ui.js';
import { getVersionName, setVersionName } from './prefs.js';
import {
  listVersions, getActiveVersionId, setActiveVersionId, deleteVersion,
  storageEstimate, isPersisted, requestPersist, hasRaw, putVersion, rawFile,
} from './storage.js';
import type { VersionRecord } from './storage.js';
import { mountOnboarding } from './onboard.js';
import { ALL_CATS } from './extract/ingest.js';

export async function openStoragePanel(app: any): Promise<void> {
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const body = el('div', { class: 'modal-body' });
  const modal = el('div', { class: 'modal card' },
    el('h2', { text: 'Storage & versions' }), body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const render = async () => {
    clear(body);
    const versions = await listVersions();
    const activeId = await getActiveVersionId();
    const est = await storageEstimate();
    const persisted = await isPersisted();

    // ---- versions table -------------------------------------------------
    if (!versions.length) {
      body.appendChild(el('p', { class: 'dim', text: 'No extracted versions yet.' }));
    }
    for (const v of versions) {
      const isActive = v.versionId === activeId;
      const radio = el('input', { type: 'radio', name: 'bs-active-version', title: 'Make this the active version' });
      radio.checked = isActive;
      radio.addEventListener('change', async () => {
        await setActiveVersionId(v.versionId);
        location.reload();   // the store is constructed at boot: clean swap
      });
      const cats = ALL_CATS.filter((c: string) => v.cats?.[c]?.state === 'ready');
      const missing = ALL_CATS.filter((c: string) => !cats.includes(c));
      const bundleBytes = Object.values(v.bundles || {}).reduce((a, b) => a + (b.size || 0), 0);

      // raw presence: evicted bundles surface here before a payload 404s
      const rawNote = el('span', { class: 'dim small', text: '' });
      (async () => {
        let present = 0, total = 0;
        for (const b of Object.values(v.bundles || {})) {
          total++;
          if (await hasRaw(b.sha256, b.size)) present++;
        }
        rawNote.textContent = total
          ? (present === total ? `all ${total} bundles stored` : `⚠ ${total - present} of ${total} game files were cleared to save space. You'll be asked to re-select them when needed`)
          : '';
      })();

      const reliable = versionDateReliable(v);
      const dateTxt = v.builtAt ? `${reliable ? 'built' : 'added'} ${fmtDateTime(v.builtAt)}` : null;
      // the build's decode-data identity (the "(hash8)" that used to sit in
      // the auto name): from the stored decompressed-ab0 hash, or parsed out
      // of the label for records that predate ab0RawSha256
      const decodeId = v.ab0RawSha256?.slice(0, 8)
        || v.profileLabel?.match(/\(([0-9a-f]{8,16})\)\s*$/i)?.[1]?.slice(0, 8) || null;
      // friendly-name a version (a local user pref, not part of asset_overrides.json)
      const nameEl = el('b', { class: 'ver-name', text: versionLabel(v) || v.versionId.slice(0, 8) });
      const renameBtn = el('button', { class: 'btn btn-mini ver-rename-btn', text: '✎', title: 'Give this version a friendly name (saved on this device only)' });
      renameBtn.addEventListener('click', () => {
        const input = el('input', {
          class: 'ver-rename', type: 'text',
          value: getVersionName(v.versionId),
          placeholder: versionLabel(v) || v.versionId.slice(0, 8),
          title: 'Name this version. Press Enter to save; leave blank to use the automatic name.',
        });
        const commit = () => { setVersionName(v.versionId, input.value); app.refreshVersionChip?.(); render(); };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
        nameEl.replaceWith(input);
        input.focus();
        input.select();
      });
      const row = el('div', { class: `ver-row card${isActive ? ' active' : ''}` },
        // name gets its own line (long friendly names wrap instead of clipping);
        // the identity + timing details live on the line below
        el('div', { class: 'ver-head' },
          radio,
          nameEl,
          renameBtn,
          el('span', { class: 'spacer' }),
          platformIcon(v.platform, v.platformSource)),
        el('div', { class: 'ver-details' },
          dateTxt ? el('span', {
            class: 'badge b-ghost', text: dateTxt,
            title: reliable
              ? "When this game build was published (worked out from the update's file dates)."
              : "When you added these files. The game doesn't record its real build date, so this is just your download date. Rename the version to label it.",
          }) : null,
          decodeId ? el('span', {
            class: 'mono dim small', text: `build ${decodeId}`,
            title: 'The build\'s id in its per-build data (first 8 hex of the decompressed game-index hash).',
          }) : null,
          el('span', {
            class: 'mono dim small', text: v.versionId.slice(0, 16),
            title: 'Content id of your bundle files (first 16 hex of the game-index file hash), the stable version id.',
          }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'dim small', text: `${fmtBytes(bundleBytes)} of game files` })),
        el('div', { class: 'dim small' },
          `categories: ${cats.join(', ') || 'none'}`,
          missing.length && isActive ? el('span', {}, ' · ', (() => {
            const b = el('a', { href: '#', text: `extract ${missing.join('/')} →` });
            b.addEventListener('click', (e) => { e.preventDefault(); openExtractMore(app, v, close); });
            return b;
          })()) : null),
        rawNote,
        el('div', { class: 'ver-actions' },
          !isActive ? (() => {
            const cmp = el('button', { class: 'btn btn-mini', text: 'compare against ▸', title: 'Compare the active version with this one to see what was added, removed, or changed' });
            cmp.addEventListener('click', () => {
              sessionStorage.setItem('bs.diffBase', v.versionId);
              close();
              app.renderCompareChip?.();
              location.hash = `#/diff/${v.versionId}..${activeId}`;
            });
            return cmp;
          })() : null,
          (() => {
            const del = el('button', { class: 'btn btn-mini', text: 'delete' });
            del.addEventListener('click', async () => {
              if (!del.classList.contains('active')) {
                del.classList.add('active');
                del.textContent = 'really delete?';
                setTimeout(() => { del.classList.remove('active'); del.textContent = 'delete'; }, 3000);
                return;
              }
              const freed = await deleteVersion(v.versionId);
              app.banner(`deleted version ${v.label || v.versionId.slice(0, 8)} (freed ${fmtBytes(freed)})`, 'b-info');
              if (v.versionId === activeId) { location.reload(); return; }
              render();
            });
            return del;
          })()));
      body.appendChild(row);
    }

    // ---- add a new version ---------------------------------------------
    const addBtn = el('button', { class: 'btn', text: '+ Add version (new game build)' });
    addBtn.addEventListener('click', () => openExtractMore(app, null, close));

    // ---- persistence + usage --------------------------------------------
    const persistLine = el('p', { class: 'dim small' },
      persisted
        ? '● Your data is saved for keeps: the browser won\'t clear it to free up space.'
        : el('span', {}, '○ Your data isn\'t guaranteed: the browser may clear it after about 7 days without a visit. ',
          (() => {
            const b = el('a', { href: '#', text: 'make permanent' });
            b.addEventListener('click', async (e) => {
              e.preventDefault();
              const ok = await requestPersist();
              app.banner(ok ? 'storage marked persistent' : 'the browser declined (it may grant this after more visits)', 'b-info');
              render();
            });
            return b;
          })()));

    body.append(
      el('div', { class: 'modal-actions' }, addBtn),
      persistLine,
      el('p', { class: 'dim small', text: `Using ${fmtBytes(est.usage || 0)} of ~${fmtBytes(est.quota || 0)} available browser storage. Annotations (names + texture overrides) are stored separately and survive version deletion.` }));

    const closeBtn = el('button', { class: 'btn', text: 'Close' });
    closeBtn.addEventListener('click', close);
    body.appendChild(el('div', { class: 'modal-actions' }, el('span', { class: 'spacer' }), closeBtn));
  };

  await render();
}

// ---- build-label backfill --------------------------------------------------
// Per-build decode data can ship AFTER a build was extracted (a fresh game
// update usually reaches users before its data is published), leaving the
// version stuck with a fallback name like "build 6cba3cbd". Called once at
// boot: any stored version with no profileLabel yet is re-matched against the
// shipped data and stamped, so builds name themselves ("build 23-Apr-2025
// (35f5efbc)") without a re-extract. Versions stored before ab0RawSha256
// existed derive it once from their stored ab0 (decompress + hash, a few MB,
// only for still-unlabeled versions), and the key is persisted so later loads
// are a single cheap fetch. Returns versionId -> new label so callers can
// refresh live UI. Failures (offline, no data yet) are silent and simply
// retried on a future load.
export async function backfillProfileLabels(): Promise<Map<string, string>> {
  const updated = new Map<string, string>();
  let versions: VersionRecord[] = [];
  try { versions = await listVersions(); } catch { return updated; }
  for (const v of versions) {
    if (v.profileLabel) continue;
    try {
      const profile = await import('./extract/world/profile.js');
      let entry = null;
      if (v.ab0RawSha256) {
        ({ entry } = await profile.matchWorldProfileEntryByHash(v.ab0RawSha256));
        if (!entry?.label) continue;   // no data yet: nothing to persist
      } else {
        const ab0Sha = v.bundles?.[0]?.sha256;
        if (!ab0Sha) continue;
        const [{ parseBundleHeader, readRaw }, { zstdDecompress }] = await Promise.all([
          import('./extract/bundles.js'),
          import('./extract/zstd.js'),
        ]);
        const blob = await rawFile(ab0Sha);
        const header = await parseBundleHeader(blob, 0);
        const ab0 = zstdDecompress(new Uint8Array(await readRaw(blob, header.entries[0])));
        const m = await profile.matchWorldProfileEntry(ab0);
        v.ab0RawSha256 = m.rawSha256;   // persist the key even when unmatched
        entry = m.entry;
      }
      if (entry?.label) {
        v.profileLabel = entry.label;
        updated.set(v.versionId, entry.label);
      }
      await putVersion(v);
    } catch { /* best-effort: offline or an unreadable stored bundle */ }
  }
  return updated;
}

// "extract more" / "add version": full-screen onboarding overlay. With a
// version record the wizard locks done categories and merges; without one it
// runs the normal fresh flow (a different game build lands as a new version).
function openExtractMore(app: any, existing: VersionRecord | null, closeParent?: () => void): void {
  closeParent?.();
  const overlay = el('div', { class: 'modal-overlay' });
  const host = el('div', { class: 'modal card onboard-host' });
  overlay.appendChild(host);
  document.body.appendChild(overlay);
  const cancel = el('button', { class: 'btn bn-close-corner', text: '✕' });
  cancel.addEventListener('click', () => overlay.remove());
  host.appendChild(cancel);
  const inner = el('div');
  host.appendChild(inner);
  mountOnboarding(inner, {
    existing,
    onDone: () => location.reload(),
  });
}
