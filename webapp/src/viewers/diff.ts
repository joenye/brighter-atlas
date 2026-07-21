// #/diff/A..B — the version-diff view (design §5). Groups added / removed /
// changed / moved per category, with carry-annotation on changed pairs and
// an on-demand image pixel-diff (decodes strictly on click, via the service
// worker's cs/<versionId>/ namespace — both versions are addressable).

import { el, clear, fmtInt, badge, idLabel, versionDateLabel, versionLabel } from '../ui.js';
import { getVersion, derivedGet } from '../storage.js';
import { diffBundles, diffVersions, diffRoomPair } from '../diff.js';
import { effectiveName, setLocalName } from '../names.js';
import { carryOverride } from '../texmap.js';
import type { IndexEntry } from '../store.js';
import type { ChangedPair } from '../diff.js';

const ROUTE: Record<string, string> = { meshes: 'mesh', images: 'image', audio: 'audio', anims: 'anim', rigs: 'rig', strings: 'string', world: 'world' };

// World rooms diff through their index entries (world:index rooms carry the
// ordinal-free content hash `h`); the pinned "All rooms" view is derived and
// never enters the diff. Older extractions without room hashes return null so
// the category skips honestly.
export async function loadWorldDiffIndex(versionId: string): Promise<IndexEntry[] | null> {
  const wi = await derivedGet(versionId, 'world:index');
  const rooms = wi?.rooms;
  if (!Array.isArray(rooms) || !rooms.length || !rooms.every((r) => r?.h)) return null;
  return rooms.map((r) => ({ ...r, i: r.id }));
}

async function loadIndex(versionId: string, cat: string): Promise<IndexEntry[] | null> {
  if (cat === 'world') return loadWorldDiffIndex(versionId);
  const idx = await derivedGet(versionId, `index:${cat}`);
  return idx ? idx.filter(Boolean) : null;
}

export function createDiffView(app: any, baseId: string, activeId: string) {
  const root = el('div', { class: 'viewer-pane diff-view' });
  const body = el('div', { class: 'diff-body' });
  root.append(body);
  body.appendChild(el('div', { class: 'center-note', text: 'Computing diff…' }));

  (async () => {
    const [recA, recB] = await Promise.all([getVersion(baseId), getVersion(activeId)]);
    clear(body);
    if (!recA || !recB) {
      body.appendChild(el('div', { class: 'center-note', text: 'One of these versions isn\'t on this device — open both versions here first.' }));
      return;
    }

    // ---- header + tier-0 bundle diff ------------------------------------
    const t0 = diffBundles(recA, recB);
    body.appendChild(el('div', { class: 'card diff-head' },
      el('h2', { text: 'Version comparison' }),
      el('p', { class: 'dim small' },
        (() => {
          const d = (r: any) => versionDateLabel(r) || '';
          return `before: ${versionLabel(recA) || baseId.slice(0, 8)}${d(recA) ? ` (${d(recA)})` : ''} → `
            + `after: ${versionLabel(recB) || activeId.slice(0, 8)}${d(recB) ? ` (${d(recB)})` : ''}`;
        })()),
      el('div', { class: 'diff-bundles' }, ...t0.map(({ n, state }) =>
        el('span', {
          class: `badge ${state === 'same' ? 'b-ghost' : state === 'changed' ? 'b-accent' : 'b-good'}`,
          text: `file ${n} ${state === 'same' ? '=' : state === 'changed' ? '≠' : state}`,
          title: `Game data file ${n}: ${state}`,
        })))));

    const { cats, skipped } = await diffVersions(recA, recB, loadIndex);

    for (const { cat, reason } of skipped) {
      body.appendChild(el('p', { class: 'dim small', text: `${cat}: skipped — ${reason}` }));
    }

    // ---- per-category groups --------------------------------------------
    for (const [cat, d] of Object.entries(cats)) {
      // all groups start COLLAPSED — the summary line carries the counts, and
      // opening is a deliberate act (large groups stay cheap until wanted)
      // "jump to diff": open this category's list filtered to just the added
      // entries (other filters cleared). Only when there are additions + a route.
      const jump = (ROUTE[cat] && d.added.length)
        ? (() => {
            const b = el('button', {
              class: 'btn btn-mini diff-jump',
              text: `open +${fmtInt(d.added.length)} added ▸`,
              title: `Open the ${cat} list filtered to the ${fmtInt(d.added.length)} added entries (other filters cleared)`,
            });
            b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); app.jumpToDiffFacet(cat, 'added', baseId); });
            return b;
          })()
        : null;
      const sec = el('details', { class: 'card diff-cat' },
        el('summary', {},
          el('span', { class: 'diff-sum' },
            el('b', { text: cat }), ' ',
            el('span', { class: 'dim small', text: `+${fmtInt(d.added.length)} added · −${fmtInt(d.removed.length)} removed · ~${fmtInt(d.changed.length)} changed · ${fmtInt(d.moved.length)} moved · ${fmtInt(d.unchanged)} unchanged` })),
          jump));

      const list = (title: string, entries: any[], cls: string, rowFn: (e: any) => HTMLElement) => {
        if (!entries.length) return;
        sec.appendChild(el('h4', { text: `${title} (${fmtInt(entries.length)})` }));
        const host = el('div', { class: `diff-list${cat === 'images' ? ' with-thumbs' : ''}` });
        const CAP = 400;
        entries.slice(0, CAP).forEach((e) => host.appendChild(rowFn(e)));
        if (entries.length > CAP) host.appendChild(el('p', { class: 'dim small', text: `… and ${fmtInt(entries.length - CAP)} more` }));
        sec.appendChild(host);
      };

      const label = (e: IndexEntry) => {
        if (cat === 'strings') return e.text.length > 60 ? `${e.text.slice(0, 60)}…` : e.text;
        if (cat === 'world') return `${e.name || 'room'} #${e.i}`;
        return effectiveName(e, cat) || idLabel(e);
      };

      // image rows get an inline thumbnail via the service worker's cs/
      // namespace — removed images decode from the BASE version's raw bundles
      const thumb = (versionId: string, i: number) => (cat === 'images'
        ? el('img', { class: 'diff-thumb', loading: 'lazy', src: `cs/${versionId}/images/${String(i).padStart(5, '0')}_e0.png` })
        : null);

      list('added', d.added, 'add', (e: IndexEntry) => el('a', {
        class: 'diff-row add',
        href: ROUTE[cat] ? `#/${ROUTE[cat]}/${e.i}` : '#',
      }, badge('+', 'b-good'), thumb(activeId, e.i), el('span', { text: label(e) }), el('span', { class: 'dim small mono', text: e.h || '' })));

      list('removed', d.removed, 'del', (e: IndexEntry) => el('div', { class: 'diff-row del' },
        badge('−', 'b-accent'), thumb(baseId, e.i), el('span', { text: label(e) }),
        el('span', { class: 'dim small mono', text: e.h || '' })));

      list('changed', d.changed, 'chg', (pair: ChangedPair) => {
        const row = el('div', { class: 'diff-row chg' },
          badge('~', 'b-ghost'),
          thumb(baseId, pair.base.i), cat === 'images' ? el('span', { class: 'dim', text: '→' }) : null, thumb(activeId, pair.active.i),
          el('span', {}, `${label(pair.base)} → `,
            ROUTE[cat] ? el('a', { href: `#/${ROUTE[cat]}/${pair.active.i}`, text: label(pair.active) }) : el('span', { text: label(pair.active) })),
          el('span', { class: 'dim small', text: `${pair.confidence} confidence` }));
        if (cat === 'world') {
          // rooms aren't hash-named assets — instead of carry, an on-demand
          // "what changed" summary (pure index-level, no shard decode)
          row.appendChild(roomChangeButton(baseId, activeId, pair));
          return row;
        }
        // carry annotation: copy name/texture from base.h to active.h
        const carry = el('button', { class: 'btn btn-mini', text: 'carry over my edits →', title: 'Copy this asset\'s name (and texture for meshes) from the before version to the after version' });
        carry.addEventListener('click', () => {
          let did = 0;
          const nm = effectiveName(pair.base, cat);
          if (nm && !effectiveName(pair.active, cat)) { setLocalName(pair.active, cat, nm); did++; }
          if (cat === 'meshes' && carryOverride(pair.base, pair.active)) did++;
          carry.textContent = did ? 'carried ✓' : 'nothing to carry';
          carry.disabled = true;
        });
        row.appendChild(carry);
        if (cat === 'images') row.appendChild(pixelDiffButton(baseId, activeId, pair));
        return row;
      });

      list('moved (same asset, new position)', d.moved, 'mv', ({ a, b }: { a: IndexEntry; b: IndexEntry }) => el('div', { class: 'diff-row mv' },
        badge('=', 'b-ghost'), el('span', { text: `${label(b)}: #${a.i} → #${b.i}` }),
        el('span', { class: 'dim small mono', text: b.h || '' })));

      body.appendChild(sec);
    }
  })().catch((e) => {
    clear(body);
    body.appendChild(el('div', { class: 'center-note', text: `Diff failed: ${e.message}` }));
  });

  return { root, destroy() {} };
}

// on-demand per-room change summary: which fields moved and which meshes/
// textures entered or left the room — content-hash set differences over the
// two versions' indexes, computed strictly on click (no shard decode)
function roomChangeButton(baseId: string, activeId: string, pair: ChangedPair): HTMLButtonElement {
  const btn = el('button', { class: 'btn btn-mini', text: 'what changed?' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const host = el('div', { class: 'diff-room-detail' });
    btn.parentElement!.after(host);
    try {
      const [meshesA, meshesB, imagesA, imagesB] = await Promise.all([
        derivedGet(baseId, 'index:meshes'), derivedGet(activeId, 'index:meshes'),
        derivedGet(baseId, 'index:images'), derivedGet(activeId, 'index:images'),
      ]);
      const d = diffRoomPair(pair.base, pair.active, {
        meshesA: meshesA?.filter(Boolean), meshesB: meshesB?.filter(Boolean),
        imagesA: imagesA?.filter(Boolean), imagesB: imagesB?.filter(Boolean),
      });
      const fmt = (v: any) => (Array.isArray(v) ? v.join('×') : v === null ? '—' : String(v));
      for (const f of d.fields) {
        host.appendChild(el('div', { class: 'small' },
          el('b', { text: `${f.label}: ` }), `${fmt(f.before)} → ${fmt(f.after)}`));
      }
      const assetList = (title: string, cat: string, added: IndexEntry[], removed: IndexEntry[]) => {
        if (!added.length && !removed.length) return;
        const line = el('div', { class: 'small' }, el('b', { text: `${title}: ` }),
          el('span', { class: 'dim', text: `+${fmtInt(added.length)} / −${fmtInt(removed.length)} ` }));
        const CAP = 12;
        added.slice(0, CAP).forEach((e) => line.append(
          el('a', { class: 'diff-room-asset add', href: `#/${ROUTE[cat]}/${e.i}`, text: `+${effectiveName(e, cat) || idLabel(e)}` }), ' '));
        removed.slice(0, CAP).forEach((e) => line.append(
          el('span', { class: 'diff-room-asset del dim', text: `−${effectiveName(e, cat) || idLabel(e)}` }), ' '));
        const overflow = Math.max(0, added.length - CAP) + Math.max(0, removed.length - CAP);
        if (overflow) line.append(el('span', { class: 'dim small', text: `… +${fmtInt(overflow)} more` }));
        host.appendChild(line);
      };
      assetList('meshes', 'meshes', d.meshes.added, d.meshes.removed);
      assetList('textures', 'images', d.textures.added, d.textures.removed);
      if (!d.fields.length && !d.meshes.added.length && !d.meshes.removed.length
          && !d.textures.added.length && !d.textures.removed.length) {
        host.appendChild(el('p', { class: 'dim small', text: 'Same footprint, meshes and textures — the change is inside the room source (placement moves/rotations or recolours).' }));
      }
    } catch (e) {
      host.appendChild(el('p', { class: 'err small', text: e.message }));
    }
  });
  return btn;
}

// on-demand image pixel-diff: side-by-side + |delta| heatmap, decoded only on
// click (both versions' PNGs come from the service worker)
function pixelDiffButton(baseId: string, activeId: string, pair: ChangedPair): HTMLButtonElement {
  const btn = el('button', { class: 'btn btn-mini', text: 'pixel diff' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const host = el('div', { class: 'diff-pixels' });
    btn.parentElement!.after(host);
    const urlA = `cs/${baseId}/images/${String(pair.base.i).padStart(5, '0')}_e0.png`;
    const urlB = `cs/${activeId}/images/${String(pair.active.i).padStart(5, '0')}_e0.png`;
    const load = (url: string) => new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('Couldn\'t load one of the images to compare — try opening the version again.'));
      img.src = url;
    });
    try {
      const [a, b] = await Promise.all([load(urlA), load(urlB)]);
      const w = Math.min(a.naturalWidth, b.naturalWidth);
      const h = Math.min(a.naturalHeight, b.naturalHeight);
      const canvas = el('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(a, 0, 0);
      const da = ctx.getImageData(0, 0, w, h);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(b, 0, 0);
      const db = ctx.getImageData(0, 0, w, h);
      let diffPx = 0;
      const out = ctx.createImageData(w, h);
      for (let i = 0; i < da.data.length; i += 4) {
        const d = Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i + 1] - db.data[i + 1])
          + Math.abs(da.data[i + 2] - db.data[i + 2]);
        if (d > 12) diffPx++;
        out.data[i] = 255;
        out.data[i + 3] = Math.min(255, d);
      }
      ctx.putImageData(out, 0, 0);
      const pct = (100 * diffPx / (w * h)).toFixed(1);
      const wrap = (img: HTMLImageElement | HTMLCanvasElement, cap: string) => el('figure', {}, img, el('figcaption', { class: 'dim small', text: cap }));
      host.append(wrap(a, 'before'), wrap(b, 'after'), wrap(canvas, `changes — ${pct}% of pixels differ`));
    } catch (e) {
      host.appendChild(el('p', { class: 'err small', text: e.message }));
    }
  });
  return btn;
}
