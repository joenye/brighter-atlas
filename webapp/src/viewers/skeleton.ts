// Skeleton viewer: joints (spheres) + bones (lines), clip transport (clips
// whose anim_dir skel == this), plus a composite preview: every mesh bound to
// this skeleton can be toggled on/off (select all/none, filterable) and is
// rendered skinned on the shared rig. The full mesh-view shading toolbar
// (Lit/Textured/Normals/UV checker/Bone influence + Wireframe/2-sided/
// Skeleton/UV map) applies to ALL enabled meshes simultaneously.

import { Scene3D, THREE, makeGridToggle, makeLightToggle, mountImmersiveControls } from './three-common.js';
import { Rig, SkeletonViz, PlaybackBar } from './rig.js';
import { buildMeshGeometry } from './mesh-geometry.js';
import { effectiveTex, effectiveVariants, resolveRoles, texFile, overrideStatus,
  systemTextureStatus } from '../texmap.js';
import { effectiveName } from '../names.js';
import { el, clear, badge, fmtInt, notExported, debounce, idLabel } from '../ui.js';
import { getPref, setPref } from '../prefs.js';
import { SHOT_RES, captureTiledPng } from './capture-common.js';
import { openVideoWizard } from './video-wizard.js';
import { exportControls } from '../asset-export.js';
import { mountComposite } from './composite.js';
import { entryByOrdinal } from '../store.js';
import type { IndexEntry } from '../store.js';

// Display name for a composite mesh: a user friendly name wins, then the
// recovered wearable-item name (sn), else null (caller shows the id).
const meshLabel = (m: any): string | null => effectiveName(m, 'meshes') || m.sn?.[0] || null;

export function createSkeletonView(app: any, entry: IndexEntry) {
  const root = el('div', { class: 'viewer-pane' });
  const toolbar = el('div', { class: 'viewer-toolbar' });
  const host = el('div', { class: 'canvas-host' });
  const statsRow = el('div', { class: 'stats-row' });
  root.append(toolbar, host, statsRow);

  let destroyed = false, scene: any = null, bar: any = null, cleanup: (() => void) | null = null;
  const immersive = mountImmersiveControls({ pane: root, host, toolbar });
  const view = { root, destroy() { destroyed = true; immersive.destroy(); cleanup?.(); scene?.destroy(); bar?.destroy(); } };

  toolbar.appendChild(el('span', { class: 'viewer-title', text: `Rig ${idLabel(entry)}` }));
  toolbar.appendChild(badge(`#${entry.i}`, 'b-ghost', 'Where this asset sits in the game files. The id in the title is its permanent name and never changes.'));
  toolbar.appendChild(badge(`${entry.bones} bones`, 'b-accent'));

  if (!entry.f) {
    host.appendChild(notExported(`Rig #${entry.i}`));
    statsRow.append(el('span', {}, 'bones ', el('b', { text: String(entry.bones) })));
    return view;
  }

  (async () => {
    let skelJson: any, clips: IndexEntry[] = [], boundMeshes: IndexEntry[] = [], imagesIdx: IndexEntry[] | null = null;
    try {
      skelJson = await app.store.json(entry.f);
      const anims = await app.store.index('anims');
      clips = anims.filter((a: IndexEntry) => a.skel === entry.i);
      const meshes = await app.store.index('meshes');
      boundMeshes = meshes.filter((m: IndexEntry) => m.skel === entry.i);
    } catch { return; }
    try { imagesIdx = await app.store.index('images'); } catch { /* untextured */ }
    if (destroyed) return;

    const rig = new Rig(skelJson);
    const { min, max } = rig.restWorldInfo();
    const dim = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1);

    scene = new Scene3D(host);
    scene.frameBox([min.x, min.y, min.z], [max.x, max.y, max.z]);
    scene.addGround(Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1) / 2, Math.min(0, min.z),
      { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 });

    // anchor bones to the scene
    const anchor = new THREE.Group();
    anchor.add(...rig.roots);
    scene.scene.add(anchor);

    const viz = new SkeletonViz(scene.scene, rig, { jointRadius: Math.max(dim * 0.018, 0.12), onTop: true });
    viz.update();

    bar = new PlaybackBar({
      host: root, clips, store: app.store, rig,
      onApplied: () => { if (viz.group.visible) viz.update(); },
      onError: (msg: string) => app.banner(msg),
      autoSelect: true,   // pick + (if the autoplay pref is on) play the first clip
    });
    scene.addTick((dt: number) => { bar.tick(dt); if (viz.group.visible && bar.playing) viz.update(); });

    // ---- composite mesh state ----------------------------------------------
    const active = new Map<number, any>();   // mesh index -> THREE.Mesh/SkinnedMesh (userData: texMat, wire)
    const pending = new Set<number>();       // toggles in flight (payload loading)
    const meshCountLbl = el('b', { text: '0' });
    // materials + full shading toolbar (Lit/Textured/…/UV-map), shared with the
    // Model composite; mounts its buttons onto `toolbar` here.
    const { mats, wireMat, texLoader, po, matFor, refit, refreshUv, getMode } = mountComposite({
      scene, toolbar, host, viz, active, min, max,
      isDestroyed: () => destroyed,
      applyTitle: 'Applies to every enabled mesh',
      uvTitle: 'Combined UV layout of every enabled mesh',
    });
    const setVis = (obj: any, vis: boolean) => { obj.visible = vis; if (obj.userData?.wire) obj.userData.wire.visible = vis && getPref('wireframe'); };

    async function makeTexMat(m: IndexEntry) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.02, roughness: 0.88, alphaTest: 0.35, ...po });
      mat.side = mats.lit.side;
      const st = imagesIdx ? effectiveTex(m, imagesIdx) : null;
      if (st?.a != null) {
        const img = entryByOrdinal(imagesIdx, st.a);
        const roles: any = img ? resolveRoles(img as any) : {};
        const albFile = texFile(img, roles.albedo);
        try {
          if (albFile) {
            const map = await texLoader.loadAsync(app.store.url(albFile));
            map.colorSpace = THREE.SRGBColorSpace;
            map.anisotropy = 8;
            mat.map = map;
            mat.color.set(0xffffff);
          }
        } catch { /* neutral lit fallback */ }
      }
      return mat;
    }

    async function enableMesh(m: IndexEntry, cb?: HTMLInputElement): Promise<void> {
      if (active.has(m.i) || pending.has(m.i) || !m.f) return;
      pending.add(m.i);
      try {
        const payload = await app.store.payload(m.f);
        if (destroyed || !pending.has(m.i)) return;
        const { geo, skinned } = buildMeshGeometry(payload);
        const texMat = await makeTexMat(m);
        if (destroyed || !pending.has(m.i)) { geo.dispose(); texMat.map?.dispose(); texMat.dispose(); return; }
        const Cls = (skinned ? THREE.SkinnedMesh : THREE.Mesh) as any;
        const obj = new Cls(geo, mats.lit);
        const wire = new Cls(geo, wireMat);
        if (skinned) {
          // explicit identity bind matrix (bones live under the scene anchor):
          // parameterless bind() would recalculate skeleton.boneInverses from
          // the bones' CURRENT matrixWorld: wrong while a clip is posing the
          // rig, and identity before the first render, clobbering Rig's
          // stored inverses for every mesh on this skeleton
          (obj as any).bind(rig.skeleton, new THREE.Matrix4());
          (wire as any).bind(rig.skeleton, (obj as any).bindMatrix);
          obj.frustumCulled = wire.frustumCulled = false;
        }
        obj.userData = { texMat, wire };
        wire.visible = getPref('wireframe');
        scene.scene.add(obj, wire);
        active.set(m.i, obj);
        obj.material = matFor(obj);
        meshCountLbl.textContent = fmtInt(active.size);
        refreshUv();
        refit();
        saveState();
        updateAllNone?.();
      } catch (e) {
        app.banner(`mesh #${m.i} failed to load: ${e.message}`);
        if (cb) cb.checked = false;
      } finally {
        pending.delete(m.i);
      }
    }

    function disableMesh(i: number): void {
      pending.delete(i);
      if (tempI === i) tempI = null;
      if (highlighted === i) highlighted = null;
      const obj = active.get(i);
      if (!obj) return;
      active.delete(i);
      scene.scene.remove(obj, obj.userData.wire);
      obj.geometry.dispose();
      obj.userData.texMat.map?.dispose();
      obj.userData.texMat.dispose();
      meshCountLbl.textContent = fmtInt(active.size);
      refreshUv();
      refit();
      saveState();
      updateAllNone?.();
    }

    // small concurrency pool so "select all" doesn't fire hundreds of fetches at once
    async function enableMany(list: IndexEntry[]): Promise<void> {
      const queue = [...list];
      const workers = Array.from({ length: 6 }, async () => {
        while (queue.length && !destroyed) await enableMesh(queue.shift()!);
      });
      await Promise.all(workers);
      renderList();
    }


    // ---- export group: ⭳ download · ▣ screenshot · ◉ video ----------------
    const vidBtn = el('button', { class: 'btn', text: '◉ Video', title: 'Record the current composite: formats WEBM/MP4/GIF, multiple clips, turntable, caption, live preview' });
    vidBtn.addEventListener('click', () => {
      if (!active.size) { app.banner('enable at least one mesh (checkboxes in the details panel) before recording'); return; }
      openVideoWizard({ app, scene, bar, clips, entry, activeSize: active.size });
    });
    const shotBtn = el('button', { class: 'btn', text: '▣ Screenshot', title: 'Capture the current 3D view as a PNG/JPEG/WebP image, with caption, grid and background options' });
    shotBtn.addEventListener('click', async () => {
      if (!active.size) { app.banner('enable at least one mesh (checkboxes in the details panel) before capturing'); return; }
      const { openScreenshotModal } = await import('./screenshot.js');
      const shotRes = getPref('shotRes') || '8k';
      openScreenshotModal({
        app, scene, entry, activeSize: active.size,
        highRes: {
          options: SHOT_RES,
          initial: shotRes in SHOT_RES ? shotRes : '8k',
          onPick: (key: string) => setPref('shotRes', key),
          capture: (key: string, onProgress: (msg: string) => void, opts?: { transparent?: boolean }) =>
            captureTiledPng(scene, key, `brighter-atlas-rig-${entry.i}`, onProgress, () => !destroyed, opts?.transparent),
        },
      });
    });
    // ❖ Save as Model: save the current meshes + textures as a reusable Model
    const modelBtn = el('button', { class: 'btn btn-cta', text: '❖ Save as Model', title: 'Save the current mesh selection + textures as a reusable, named Model' });
    modelBtn.addEventListener('click', async () => {
      if (!active.size) { app.banner('enable at least one mesh before creating a model'); return; }
      const { openModelWizard } = await import('./model-wizard.js');
      openModelWizard({ app, entry, active, boundMeshes, imagesIdx });
    });
    // Export shares the capture group (per-asset download of the rig payload)
    toolbar.append(makeGridToggle(scene), makeLightToggle(scene), el('span', { class: 'sep' }), modelBtn, ...exportControls(app, 'rigs', entry), shotBtn, vidBtn);

    // ---- details panel: filterable select-all/none checkbox list -----------
    // no pagination: even the 2,562-mesh player rig renders in full.
    // Keyboard spotlight: click a row (or the list) to take the arrows, ↑/↓
    // previews the cursor row's mesh WITH its own texture and hides every other
    // selected mesh; on key-off the full selection is shown again (transient
    // meshes dropped unless their checkbox is on). Space/Enter toggles the
    // checkbox; Esc / clicking away releases. Checkboxes + scrollbar as before.
    const listEl = el('div', { class: 'sm-list', tabindex: '-1' });
    const shownLbl = el('span', { class: 'dim small' });
    const filterEl = el('input', { class: 'sm-filter', type: 'search', placeholder: `filter ${fmtInt(boundMeshes.length)} meshes…` });
    let kbOn = false, cursor = -1, tempI: number | null = null, highlighted: number | null = null;
    let rowEls: HTMLElement[] = [];   // rendered rows, rowEls[k] <-> matches()[k]

    // body-slot filter (player rig: head/neck/torso/hand_l/hand_r/… from
    // skinning-weight classification; hidden on rigs without slot data)
    const slotSel = el('select', { class: 'btn-mini sm-slot', title: 'Filter by body slot (from skinning weights)', hidden: true });
    let slotFilter = 'all';
    {
      const counts = new Map<string, number>();
      for (const m of boundMeshes) if (m.slot) counts.set(m.slot, (counts.get(m.slot) || 0) + 1);
      if (counts.size) {
        slotSel.hidden = false;
        slotSel.appendChild(el('option', { value: 'all', text: 'slot: all' }));
        for (const [s, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
          slotSel.appendChild(el('option', { value: s, text: `${s} (${n})` }));
        }
      }
    }

    // sortable like the main mesh list; default puts TEXTURED meshes first,
    // then highest vertex count: the meshes most likely to matter
    const texRank = (m: IndexEntry) => (effectiveVariants(m).variants.length ? 1 : 0);
    const SM_SORTS: Record<string, (a: IndexEntry, b: IndexEntry) => number> = {
      'tex-verts': (a, b) => (texRank(b) - texRank(a)) || (b.v - a.v) || (a.i - b.i),
      vertices: (a, b) => (b.v - a.v) || (a.i - b.i),
      triangles: (a, b) => (b.t - a.t) || (a.i - b.i),
      name: (a, b) => {
        const na = meshLabel(a), nb = meshLabel(b);
        if (na && nb) return na.localeCompare(nb) || (a.i - b.i);
        if (na || nb) return na ? -1 : 1;
        return a.i - b.i;
      },
      index: (a, b) => a.i - b.i,
    };
    let smSort = 'tex-verts';
    const sortSel2 = el('select', { class: 'btn-mini sm-sort', title: 'Sort the mesh list' });
    for (const [v, label] of [['tex-verts', 'textured · verts'], ['vertices', 'vertices'], ['triangles', 'triangles'], ['name', 'name'], ['index', 'index']]) {
      sortSel2.appendChild(el('option', { value: v, text: `sort: ${label}` }));
    }

    const matches = (): IndexEntry[] => {
      const q = filterEl.value.trim().toLowerCase();
      let arr = slotFilter === 'all' ? boundMeshes : boundMeshes.filter((m) => m.slot === slotFilter);
      if (q) arr = arr.filter((m) => `#${m.i} ${m.i} ${m.h || ''} ${m.slot || ''} ${(meshLabel(m) || '').toLowerCase()}`.includes(q));
      return [...arr].sort(SM_SORTS[smSort] || SM_SORTS['tex-verts']);
    };

    // per-skeleton view state (committed selections, filter, scroll, spotlight
    // cursor) survives navigating away and BACK within the session
    const stateKey = `bs.skelState.${entry.h || entry.i}`;
    const saveNow = () => {
      try {
        sessionStorage.setItem(stateKey, JSON.stringify({
          checked: [...active.keys()].filter((i) => i !== tempI),
          cursor: matches()[cursor]?.i ?? null,
          kb: kbOn,
          filter: filterEl.value,
          slot: slotFilter,
          sort: smSort,
          scroll: listEl.scrollTop,
        }));
      } catch { /* storage unavailable */ }
    };
    const saveState = debounce(saveNow, 200);

    const setKb = (on: boolean) => {
      kbOn = on;
      listEl.classList.toggle('kb-target', on);
      document.getElementById('list-host')?.classList.toggle('kb-target', !on);
      if (!on) {
        rowEls[cursor]?.classList.remove('sel');
        cursor = -1;
        clearSpotlight();
      }
      saveState();
    };

    function clearSpotlight(): void {
      if (highlighted != null) {
        const o = active.get(highlighted);
        if (o) o.material = matFor(o);
        highlighted = null;
      }
      if (tempI != null) {
        const t = tempI;
        tempI = null;
        disableMesh(t);
        renderList();
      }
      for (const obj of active.values()) setVis(obj, true);   // reveal the full selection again
    }

    async function spotlight(): Promise<void> {
      const m = matches()[cursor];
      if (highlighted != null && highlighted !== m?.i) {
        const o = active.get(highlighted);
        if (o) o.material = matFor(o);
        highlighted = null;
      }
      if (tempI != null && tempI !== m?.i) {
        const t = tempI;
        tempI = null;
        disableMesh(t);
      }
      if (!m?.f || destroyed) return;
      if (!active.has(m.i) && !pending.has(m.i)) {
        tempI = m.i;               // shown only while the cursor is on it
        await enableMesh(m);
        if (tempI !== m.i || destroyed) return;
      }
      const o = active.get(m.i);
      if (o) {
        o.material = o.userData.texMat;   // preview with its own texture, not a flat highlight
        highlighted = m.i;
        for (const [i, obj] of active) setVis(obj, i === m.i);   // show ONLY the previewed mesh
      }
    }
    const scheduleSpotlight = debounce(() => { spotlight(); }, 140);

    const setCursor = (k: number) => {
      const match = matches();
      if (!match.length) return;
      k = Math.max(0, Math.min(match.length - 1, k));
      rowEls[cursor]?.classList.remove('sel');
      cursor = k;
      rowEls[cursor]?.classList.add('sel');
      rowEls[cursor]?.scrollIntoView({ block: 'nearest' });
      scheduleSpotlight();
      saveState();
    };

    function renderList(): void {
      clear(listEl);
      rowEls = [];
      const match = matches();
      match.forEach((m, k) => {
        // temp-spotlighted meshes are visible but NOT checked (not committed)
        const cb = el('input', { type: 'checkbox', checked: (active.has(m.i) || pending.has(m.i)) && m.i !== tempI, disabled: !m.f });
        cb.addEventListener('change', () => {
          if (cb.checked) {
            if (tempI === m.i) tempI = null;   // commit the spotlighted mesh
            enableMesh(m, cb);
          } else {
            disableMesh(m.i);
          }
        });
        const name = meshLabel(m);
        const texState = overrideStatus(m);   // 'image' = a texture is assigned; 'cleared' = explicit none
        const sysTex = systemTextureStatus(m);
        const row = el('div', { class: `sm-row${k === cursor ? ' sel' : ''}` },
          cb,
          el('a', { href: `#/mesh/${m.i}`, text: name || idLabel(m), title: `#${m.i}${m.h ? ` · ${m.h}` : ''}${m.slot ? ` · ${m.slot}` : ''} (open in mesh view)`, class: name ? '' : 'mono' }),
          sysTex === 'image' ? badge('Tˢ', 'b-good b-ghost', `${m.sys.variants.length} built-in texture variant${m.sys.variants.length === 1 ? '' : 's'}`) : null,
          texState === 'image' ? badge('T', 'b-good b-ghost', 'texture override set') : (texState === 'cleared' ? badge('T∅', 'b-ghost', 'override: no texture (cleared)') : null),
          el('span', { class: 'dim', text: `${m.slot && slotFilter === 'all' ? `${m.slot} · ` : ''}${fmtInt(m.v)}v · #${m.i}${m.f ? '' : ' · ∅'}` }));
        // row click = take keyboard + spotlight (checkbox still toggles, link still navigates)
        row.addEventListener('click', (ev) => {
          if (ev.target === cb || (ev.target as HTMLElement).tagName === 'A') return;
          setKb(true);
          setCursor(k);
        });
        rowEls.push(row);
        listEl.appendChild(row);
      });
      shownLbl.textContent = `${fmtInt(match.length)} of ${fmtInt(boundMeshes.length)} shown · ${fmtInt(active.size)} visible`;
      updateAllNone?.();
    }
    filterEl.addEventListener('input', debounce(() => { rowEls[cursor]?.classList.remove('sel'); cursor = -1; clearSpotlight(); renderList(); saveState(); }, 120));
    sortSel2.addEventListener('change', () => {
      smSort = sortSel2.value;
      rowEls[cursor]?.classList.remove('sel');
      cursor = -1;
      clearSpotlight();
      renderList();
      saveState();
    });
    slotSel.addEventListener('change', () => {
      slotFilter = slotSel.value;
      rowEls[cursor]?.classList.remove('sel');
      cursor = -1;
      clearSpotlight();
      renderList();
      saveState();
    });
    listEl.addEventListener('scroll', saveState);

    // keyboard ownership (capture; stops the sidebar list from moving)
    const onListKey = (ev: KeyboardEvent) => {
      if (destroyed) { document.removeEventListener('keydown', onListKey, true); return; }
      if (!kbOn || document.querySelector('.texpicker')) return;
      if (ev.key === 'Escape') { ev.stopPropagation(); setKb(false); return; }
      if ((ev.key === ' ' || ev.key === 'Enter') && cursor >= 0) {
        ev.preventDefault();
        ev.stopPropagation();
        const cb = rowEls[cursor]?.querySelector('input');
        if (cb && !cb.disabled) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
        return;
      }
      const step = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : null;
      if (step == null) return;
      ev.preventDefault();
      ev.stopPropagation();
      setCursor(cursor < 0 ? 0 : cursor + step);
    };
    const onDocClick = (ev: MouseEvent) => {
      if (kbOn && !meshSection.contains(ev.target as Node)) setKb(false);
    };
    document.addEventListener('keydown', onListKey, true);
    document.addEventListener('click', onDocClick, true);
    cleanup = () => {
      saveNow();   // final state flush so back-navigation restores exactly this
      document.removeEventListener('keydown', onListKey, true);
      document.removeEventListener('click', onDocClick, true);
      document.getElementById('list-host')?.classList.add('kb-target');
    };
    const selectAll = () => {
      enableMany(matches().filter((m) => m.f && !active.has(m.i) && !pending.has(m.i)));
      renderList();
    };
    // all/none are sticky across skeleton pages (pref 'skelmesh'); choosing one
    // supersedes any per-skeleton state saved earlier in the session
    const clearSkelStates = () => {
      const dead: string[] = [];
      for (let k = 0; k < sessionStorage.length; k++) {
        const key = sessionStorage.key(k);
        if (key?.startsWith('bs.skelState.')) dead.push(key);
      }
      dead.forEach((key) => sessionStorage.removeItem(key));
    };
    const allBtn = el('button', { class: 'btn-mini', text: 'all', title: 'Show every (filtered) mesh. Persists across rigs.' });
    allBtn.addEventListener('click', () => { setPref('skelmesh', 'all'); clearSkelStates(); selectAll(); });
    const noneBtn = el('button', { class: 'btn-mini', text: 'none', title: 'Hide all meshes. Persists across rigs.' });
    noneBtn.addEventListener('click', () => {
      setPref('skelmesh', 'none');
      clearSkelStates();
      pending.clear();
      for (const i of [...active.keys()]) disableMesh(i);
      renderList();
    });
    // reflect the current selection on the buttons: `all` is highlighted when
    // every (filtered) mesh is shown, `none` when nothing is shown, so it's
    // obvious which state is active.
    const updateAllNone = () => {
      const loadable = matches().filter((m) => m.f);
      allBtn.classList.toggle('active', loadable.length > 0 && loadable.every((m) => active.has(m.i) || pending.has(m.i)));
      noneBtn.classList.toggle('active', active.size === 0 && pending.size === 0);
    };
    renderList();

    // initial selection: state saved for THIS skeleton earlier in the session
    // (back-navigation) wins; otherwise default to showing every mesh, unless
    // the user's sticky choice was 'none'
    let savedState: any = null;
    try { savedState = JSON.parse(sessionStorage.getItem(stateKey)!); } catch { /* fresh */ }
    if (savedState) {
      if (savedState.slot && [...slotSel.options].some((o) => o.value === savedState.slot)) {
        slotFilter = savedState.slot;
        slotSel.value = savedState.slot;
      }
      if (savedState.filter) filterEl.value = savedState.filter;
      if (savedState.sort && SM_SORTS[savedState.sort]) { smSort = savedState.sort; sortSel2.value = savedState.sort; }
      if (savedState.slot !== 'all' || savedState.filter || (savedState.sort && savedState.sort !== 'tex-verts')) renderList();
      const byI = new Map(boundMeshes.map((m) => [m.i, m]));
      const toEnable = (savedState.checked || []).map((i: number) => byI.get(i)).filter((m: IndexEntry | undefined) => m?.f);
      enableMany(toEnable).then(() => {
        if (destroyed) return;
        listEl.scrollTop = savedState.scroll || 0;
        if (savedState.kb && savedState.cursor != null) {
          const k = matches().findIndex((m) => m.i === savedState.cursor);
          if (k >= 0) { setKb(true); setCursor(k); }   // re-spotlights the cursor mesh
        }
      });
    } else if (getPref('skelmesh') !== 'none') {
      // default: show every mesh on the rig (unless the user chose 'none'), but
      // skip auto-loading on pathologically large rigs (the ~2000-mesh player
      // skeleton), where it would hang the browser; there 'all' stays a click away
      const AUTO_ALL_CAP = 200;
      if (boundMeshes.filter((m) => m.f).length <= AUTO_ALL_CAP) selectAll();
    }

    const meshSection = el('div', { class: 'skel-meshes' },
      el('div', { class: 'details-section', text: `meshes on this rig (${fmtInt(boundMeshes.length)})` }),
      el('div', { class: 'sm-tools' }, filterEl, sortSel2, slotSel, allBtn, noneBtn),
      shownLbl,
      listEl);

    // debug/test hook
    if ((window as any).__bs) (window as any).__bs.skelView = { entry, rig, bar, active, boundMeshes, enableMesh, disableMesh, scene, jointExtent: { min, max }, get mode() { return getMode(); } };

    // bone tree in the details panel
    const treeLines = skelJson.bones.map((b: any, i: number) => {
      let depth = 0, p = b.parent;
      while (p >= 0) { depth++; p = skelJson.bones[p].parent; }
      return `${'  '.repeat(depth)}${i}${b.parent >= 0 ? '' : ' (root)'}`;
    });
    // collapsed by default: the mesh list is the composite's working surface.
    // The bone tree only takes space when explicitly wanted
    app.setDetailsExtra(el('div', {},
      meshSection,
      el('details', { class: 'bone-tree-acc' },
        el('summary', { class: 'details-section', text: `bone tree (${skelJson.bones.length})` }),
        el('div', { class: 'rawjson', text: treeLines.join('\n') }))));

    statsRow.append(
      el('span', {}, 'bones ', el('b', { text: fmtInt(skelJson.bones.length) })),
      el('span', {}, 'clips ', el('b', { text: fmtInt(clips.length) })),
      el('span', {}, 'meshes ', el('b', { text: fmtInt(boundMeshes.length) })),
      el('span', {}, 'visible ', meshCountLbl),
      el('span', {}, 'rest extent ', el('b', { text: `${dim.toFixed(1)} u` })),
    );
    app.setStatus3(`rig #${entry.i} · ${skelJson.bones.length} bones · ${clips.length} clips · ${boundMeshes.length} meshes`);
  })();

  return view;
}
