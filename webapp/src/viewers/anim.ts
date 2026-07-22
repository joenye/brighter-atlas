// Animation viewer: playback preview on the clip's ab6 skeleton (loaded via the
// skel field from ab0's anim_dir).

import { Scene3D, makeGridToggle, mountImmersiveControls } from './three-common.js';
import { Rig, SkeletonViz, ClipSampler, SPEEDS, prefSpeed } from './rig.js';
import { el, badge, fmtDur, notExported, idLabel } from '../ui.js';
import { getPref, setPref } from '../prefs.js';
import { addExportButton } from '../asset-export.js';
import type { IndexEntry } from '../store.js';

export function createAnimView(app: any, entry: IndexEntry) {
  const root = el('div', { class: 'viewer-pane' });
  const toolbar = el('div', { class: 'viewer-toolbar' });
  root.appendChild(toolbar);

  let destroyed = false, scene: any = null, immersive: any = null;
  const view = { root, destroy() { destroyed = true; immersive?.destroy(); scene?.destroy(); } };

  const sourceNames = (entry as any).sn as string[] | undefined;
  toolbar.append(
    el('span', { class: 'viewer-title', text: `Animation ${idLabel(entry)}` }),
    badge(`#${entry.i}`, 'b-ghost', 'Where this asset sits in the game files. The id in the title is its permanent name and never changes.'),
    badge(`rig #${entry.skel}`, 'b-accent'),
    // recovered animatic name (world extraction); user names still outrank it
    ...(sourceNames?.length ? [badge(sourceNames[0], 'b-ghost',
      `Name recovered from the game data by the World extraction${sourceNames.length > 1 ? `; aliases:\n${sourceNames.slice(1).join('\n')}` : ''}.`)] : []),
    el('span', { class: 'dim small', text: `${entry.bones} bones · ${entry.frames} frames · ${fmtDur(entry.dur / 1000)}` }),
    el('span', { class: 'spacer' }),
    el('a', { href: `#/rig/${entry.skel}`, class: 'small', text: 'open in rig view →' }),
  );

  if (!entry.f) {
    root.appendChild(notExported(`Animation #${entry.i}`));
    return view;
  }
  addExportButton(toolbar, app, 'anims', entry);

  (async () => {
    let clip: any;
    try { clip = await app.store.payload(entry.f); } catch { return; }
    if (destroyed) return;

    // full-width preview column (the low-level per-bone S/R/T channel table was
    // dropped: it only restated the clip's data structure, not useful browsing)
    const previewCol = el('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' });
    root.appendChild(previewCol);

    // ---- skeleton preview ---------------------------------------------------
    const host = el('div', { class: 'canvas-host' });
    previewCol.appendChild(host);

    let skelEntry: IndexEntry | undefined;
    try {
      const skels = await app.store.index('rigs');
      skelEntry = skels.find((s: IndexEntry) => s.i === entry.skel);
    } catch { /* banner already raised */ }
    if (destroyed) return;

    if (!skelEntry?.f) {
      host.appendChild(el('div', { class: 'notexported' },
        badge('rig not available', 'b-warn'),
        el('div', { class: 'small dim', text: `Rig #${entry.skel} isn't in your files, so there's nothing to preview.` })));
      return;
    }

    const rig = new Rig(await app.store.json(skelEntry.f));
    if (destroyed) return;
    const { min, max } = rig.restWorldInfo();
    const dim = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1);

    scene = new Scene3D(host);
    immersive = mountImmersiveControls({ pane: root, host, toolbar });
    const { radius } = scene.frameBox([min.x, min.y, min.z], [max.x, max.y, max.z]);
    scene.addGround(radius, Math.min(0, min.z));
    scene.scene.add(...rig.roots);

    const viz = new SkeletonViz(scene.scene, rig, { jointRadius: Math.max(dim * 0.018, 0.12) });
    // Grid lives in the toolbar on every 3D view (before the export group)
    toolbar.insertBefore(makeGridToggle(scene), toolbar.querySelector('.sep'));

    // simple built-in transport (this view has exactly one clip);
    // autoplay/speed follow the persisted viewer prefs
    const sampler = new ClipSampler(clip);
    let t = 0, playing = !!getPref('autoplay'), speed = prefSpeed();
    const playBtn = el('button', { class: 'btn', text: playing ? '❚❚' : '▶' });
    playBtn.addEventListener('click', () => { playing = !playing; playBtn.textContent = playing ? '❚❚' : '▶'; });
    const speedSel = el('select', { class: 'btn' });
    for (const s of SPEEDS) speedSel.appendChild(el('option', { value: String(s), text: `${s}×`, selected: s === speed }));
    speedSel.addEventListener('change', () => { speed = parseFloat(speedSel.value); setPref('speed', speed); });
    const autoBtn = el('button', {
      class: `btn${getPref('autoplay') ? ' active' : ''}`, text: 'auto',
      title: 'Auto-play clips when selected (persists across selections and reloads)',
    });
    autoBtn.addEventListener('click', () => {
      setPref('autoplay', !getPref('autoplay'));
      autoBtn.classList.toggle('active', getPref('autoplay'));
    });
    const scrub = el('input', { type: 'range', min: '0', max: '1000', value: '0' });
    scrub.addEventListener('input', () => { playing = false; playBtn.textContent = '▶'; t = (parseInt(scrub.value, 10) / 1000) * sampler.duration; applyNow(); });
    const timeLbl = el('span', { class: 'anim-time' });
    previewCol.appendChild(el('div', { class: 'anim-bar' }, playBtn, speedSel, autoBtn, scrub, timeLbl));

    const applyNow = () => {
      sampler.apply(rig, t);
      viz.update();
      scrub.value = String(sampler.duration > 0 ? Math.round((t / sampler.duration) * 1000) : 0);
      timeLbl.textContent = `${fmtDur(t / 1000)} / ${fmtDur(sampler.duration / 1000)} · f${Math.round(t / sampler.frameMs)}`;
    };
    scene.addTick((dt: number) => {
      if (!playing) return;
      t = sampler.duration > 0 ? (t + dt * speed) % sampler.duration : 0;
      applyNow();
    });
    applyNow();
    app.setStatus3(`anim #${entry.i} · rig ${entry.skel} · ${entry.frames}f`);
  })();

  return view;
}
