// Mesh viewer: BufferGeometry from the exported typed arrays, render modes,
// wireframe/UV overlays and, for skinned meshes, full skeletal animation
// (Rig + ClipSampler + PlaybackBar from rig.js).
//
// Conventions handled here:
//  - stored triangle winding is CW (Direct3D)  -> indices flipped to CCW
//  - stored UV v is DirectX-style (origin top) -> v flipped for GL sampling
//  - vertex bone indices are GLOBAL ab6 bone ids -> map 1:1 onto Rig.bones

import { Scene3D, THREE, checkerTexture, makeGridToggle, makeLightToggle, mountImmersiveControls } from './three-common.js';
import { Rig, SkeletonViz, PlaybackBar } from './rig.js';
import { b64f32, b64u16, b64u32, b64u8, entryByOrdinal } from '../store.js';
import { el, badge, fmtInt, fmtNum, notExported, hashColorRGB, idLabel } from '../ui.js';
import { getPref, setPref } from '../prefs.js';
import { SHOT_RES, captureTiledPng } from './capture-common.js';
import { effectiveTex, resolveRoles, texFile, clearLocalTexture, removeLocalOverride,
  addVariant, setActiveVariant, removeVariant, getVariants, getActiveIndex,
  effectiveVariants, setOverrideMode, resolveVariantImage } from '../texmap.js';
import { openTexturePicker } from './texpicker.js';
import { drawUVLayout } from './mesh-geometry.js';
import { addExportButton } from '../asset-export.js';
import { effectiveName } from '../names.js';
import { saveModel } from '../models.js';
import { applyPackedRecolor, clearPackedRecolor, partRecolor } from '../recolor.js';
import type { IndexEntry } from '../store.js';

export function createMeshView(app: any, entry: IndexEntry): { root: HTMLElement; destroy(): void } {
  const root = el('div', { class: 'viewer-pane' });
  const toolbar = el('div', { class: 'viewer-toolbar' });
  const host = el('div', { class: 'canvas-host' });
  const statsRow = el('div', { class: 'stats-row' });
  root.append(toolbar, host, statsRow);

  const immersive = mountImmersiveControls({ pane: root, host, toolbar });
  const view = { root, destroy() { destroyed = true; immersive.destroy(); scene?.destroy(); bar?.destroy(); picker?.close(); modalClose?.(); } };
  let destroyed = false;
  let scene: Scene3D | null = null;
  let modalClose: (() => void) | null = null;   // Save-as-Model dialog: must not outlive the view
  let bar: PlaybackBar | null = null;
  let picker: { root: HTMLElement; close: () => void } | null = null;

  toolbar.appendChild(el('span', { class: 'viewer-title', text: `Mesh ${idLabel(entry)}` }));
  toolbar.appendChild(badge(`#${entry.i}`, 'b-ghost', 'Where this asset sits in the game files. The id in the title is its permanent name and never changes.'));
  toolbar.appendChild(badge(entry.sk ? 'skinned' : 'static', entry.sk ? 'b-accent' : ''));
  if (entry.skel === -2) toolbar.appendChild(badge('no rig', 'b-ghost', 'This mesh is pinned to a single point instead of having a rig.'));

  if (!entry.f) {
    host.appendChild(notExported(`Mesh #${entry.i}`));
    statsRow.append(stat('vertices', fmtInt(entry.v)), stat('triangles', fmtInt(entry.t)), bboxStat(entry.bbox));
    return view;
  }

  (async () => {
    let m: any;
    try { m = await app.store.payload(entry.f); } catch {
      host.appendChild(el('div', { class: 'notexported' }, badge('load failed', 'b-bad')));
      return;
    }
    if (destroyed) return;

    // ---- geometry ---------------------------------------------------------
    const geo = new THREE.BufferGeometry();
    const positions = b64f32(m.positions);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b64f32(m.normals), 3));
    const uvs = b64f32(m.uvs);
    for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i]; // DirectX v -> GL v
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (m.tangents) geo.setAttribute('tangent', new THREE.BufferAttribute(b64f32(m.tangents), 4));
    const idx = m.idx_dtype === 'u32' ? b64u32(m.indices) : b64u16(m.indices);
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } // CW -> CCW
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const skinned = !!(m.skinned && m.bone_indices && m.bone_weights && m.skel >= 0);
    let boneIdx: Uint8Array | null = null, boneWgt: Uint8Array | null = null;
    if (m.bone_indices) {
      boneIdx = b64u8(m.bone_indices);
      boneWgt = b64u8(m.bone_weights);
      if (skinned) {
        geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(boneIdx), 4));
        const w = new Float32Array(boneWgt.length);
        for (let i = 0; i < w.length; i++) w[i] = boneWgt[i] / 255;
        geo.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
      }
    }
    // bone-influence vertex colors (weighted palette by GLOBAL bone id)
    if (boneIdx) {
      const col = new Float32Array(m.v * 3);
      for (let v = 0; v < m.v; v++) {
        let r = 0, g = 0, b = 0;
        for (let k = 0; k < 4; k++) {
          const w = boneWgt![v * 4 + k] / 255;
          if (!w) continue;
          const c = hashColorRGB(boneIdx[v * 4 + k]);
          r += c[0] * w; g += c[1] * w; b += c[2] * w;
        }
        col[v * 3] = r; col[v * 3 + 1] = g; col[v * 3 + 2] = b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }

    // images catalog (for textured mode + override picker); null = unavailable
    let imagesIdx: IndexEntry[] | null = null;
    try { imagesIdx = await app.store.index('images'); } catch { /* no textured mode */ }
    if (destroyed) return;

    // ---- scene ------------------------------------------------------------
    scene = new Scene3D(host);
    // frame the union of the catalog bbox and the actual vertex extent, so the
    // camera always fits the real model without manual zooming
    geo.computeBoundingBox();
    const gb = geo.boundingBox!;
    const ib = m.bbox || entry.bbox || [gb.min.x, gb.min.y, gb.min.z, gb.max.x, gb.max.y, gb.max.z];
    const bbox = [
      Math.min(ib[0], gb.min.x), Math.min(ib[1], gb.min.y), Math.min(ib[2], gb.min.z),
      Math.max(ib[3], gb.max.x), Math.max(ib[4], gb.max.y), Math.max(ib[5], gb.max.z),
    ];
    const { radius } = scene.frameBox(bbox.slice(0, 3), bbox.slice(3, 6));
    scene.addGround(radius, Math.min(0, bbox[2]), { x: (bbox[0] + bbox[3]) / 2, y: (bbox[1] + bbox[4]) / 2 });

    // rig (skinned only)
    let rig: Rig | null = null, viz: SkeletonViz | null = null, clips: IndexEntry[] = [];
    let skelNote: string | null = null;
    if (skinned) {
      try {
        const skels = await app.store.index('rigs');
        const skelEntry = skels.find((s: IndexEntry) => s.i === m.skel);
        if (skelEntry?.f) {
          rig = new Rig(await app.store.json(skelEntry.f));
          const anims = await app.store.index('anims');
          clips = anims.filter((a: IndexEntry) => a.skel === m.skel);
        } else {
          skelNote = `Rig #${m.skel} isn't in your files. Showing the default pose.`;
        }
      } catch {
        skelNote = `rig #${m.skel} failed to load`;
      }
    }
    if (destroyed) { scene.destroy(); return; }

    // ---- materials & mesh -------------------------------------------------
    const mats: Record<string, THREE.Material> = {
      lit: new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.04, roughness: 0.82, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      normals: new THREE.MeshNormalMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      uv: new THREE.MeshBasicMaterial({ map: checkerTexture(), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    };
    if (geo.attributes.color) {
      mats.bones = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    }
    // textured mode: albedo (+normal) from the mapped/overridden ab3 image,
    // punch-through alpha like the game's BC1 cutouts
    const texMat = imagesIdx
      ? new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.02, roughness: 0.88, alphaTest: 0.35, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
      : null;
    if (texMat) mats.tex = texMat;
    const wireMat = new THREE.MeshBasicMaterial({ wireframe: true, color: 0x8fd0ff, transparent: true, opacity: 0.28 });

    let mesh: THREE.Mesh, wire: THREE.Mesh;
    if (rig) {
      const smesh = new THREE.SkinnedMesh(geo, mats.lit);
      const swire = new THREE.SkinnedMesh(geo, wireMat);
      smesh.add(...rig.roots);
      // explicit identity bind matrix: parameterless bind() recalculates
      // skeleton.boneInverses from the bones' current matrixWorld, clobbering
      // Rig's stored (authoritative) inverses
      smesh.bind(rig.skeleton, new THREE.Matrix4());
      swire.bind(rig.skeleton, smesh.bindMatrix);
      smesh.frustumCulled = swire.frustumCulled = false;
      viz = new SkeletonViz(scene.scene, rig, { jointRadius: Math.max(radius * 0.015, 0.15), onTop: true });
      viz.setVisible(false);
      mesh = smesh; wire = swire;
    } else {
      mesh = new THREE.Mesh(geo, mats.lit);
      wire = new THREE.Mesh(geo, wireMat);
    }
    wire.visible = false;
    scene.scene.add(mesh, wire);

    // ---- toolbar controls ---------------------------------------------------
    const modeBtns: Record<string, HTMLButtonElement> = {};
    const setMode = (name: string, persist = true) => {
      mesh.material = mats[name];
      for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle('active', k === name);
      if (persist) setPref('shading', name);   // shading mode persists across selections/reloads
    };
    const modes: [string, string][] = [['lit', 'Lit']];
    if (texMat) modes.push(['tex', 'Textured']);
    modes.push(['normals', 'Normals'], ['uv', 'UV checker']);
    if (mats.bones) modes.push(['bones', 'Bone influence']);
    for (const [key, label] of modes) {
      const b = el('button', { class: 'btn', text: label });
      b.addEventListener('click', () => setMode(key));
      modeBtns[key] = b;
      toolbar.appendChild(b);
    }
    setMode(mats[getPref('shading')] ? getPref('shading') : 'lit', false);
    toolbar.appendChild(el('span', { class: 'sep' }));

    // ---- texture assignment (v1 map + persistent user overrides) ----------
    if (texMat) {
      const texBadgeEl = badge('…', 'b-ghost');
      const texLoader = new THREE.TextureLoader();
      let texToken = 0;
      const setBadge = (text: string, kind: string, title?: string) => {
        texBadgeEl.textContent = text;
        texBadgeEl.className = `badge ${kind}`;
        texBadgeEl.title = title || '';
      };
      // previewImg (images-index entry) = live try-out from the picker, not persisted
      const applyTexState = async (previewImg: IndexEntry | null = null) => {
        const t = ++texToken;
        const st = previewImg
          ? { a: previewImg.i, conf: null, src: 'preview', local: true }
          : effectiveTex(entry, imagesIdx);
        const old = {
          map: texMat.map,
          normalMap: texMat.normalMap,
          parameterMap: clearPackedRecolor(texMat),
        };
        if (!st) {
          setBadge('no texture', 'b-ghost', 'No texture is assigned yet. Use Texture… to add one.');
        } else if (st.a == null) {
          setBadge(`no texture (override${st.local ? '' : ', saved'})`, 'b-accent b-ghost', 'User override: texture cleared');
        } else {
          const img = entryByOrdinal(imagesIdx, st.a);
          const roles: any = img ? resolveRoles(img as any) : {};
          const albFile = texFile(img, roles.albedo);
          const nrmFile = texFile(img, roles.normal);
          const recolor = st.src === 'system' ? partRecolor(st.variant) : null;
          const parameterFile = recolor ? texFile(img, roles.parameter) : null;
          let map: THREE.Texture | null = null, normalMap: THREE.Texture | null = null, parameterMap: THREE.Texture | null = null;
          try { if (albFile) map = await texLoader.loadAsync(app.store.url(albFile)); } catch { /* badge below */ }
          try { if (nrmFile) normalMap = await texLoader.loadAsync(app.store.url(nrmFile)); } catch { /* albedo-only */ }
          try { if (parameterFile) parameterMap = await texLoader.loadAsync(app.store.url(parameterFile)); } catch { /* base albedo fallback */ }
          if (t !== texToken || destroyed) {
            map?.dispose(); normalMap?.dispose(); parameterMap?.dispose(); return;
          }
          if (map) {
            map.colorSpace = THREE.SRGBColorSpace;
            map.anisotropy = 8;
            texMat.map = map;
          }
          if (normalMap) { normalMap.anisotropy = 8; texMat.normalMap = normalMap; }
          else texMat.normalMap = null;
          if (parameterMap) {
            parameterMap.colorSpace = THREE.NoColorSpace;
            parameterMap.anisotropy = 8;
          }
          if (recolor) {
            // the extraction-baked uniform-luminance verdict (grayscale
            // albedo × equal tints): the same full-tint path as the room renderer
            applyPackedRecolor(texMat, map ? parameterMap : null, recolor, {
              fullTint: (st.variant as any)?.uniform_luminance_tint === true,
            });
            if (!map) parameterMap?.dispose();
          } else {
            parameterMap?.dispose();
          }
          if (!map) {
            texMat.map = null;
            setBadge(`#${st.a} missing`, 'b-bad', 'This image has no colour texture to show.');
          } else if (st.src === 'preview') {
            setBadge(`#${st.a} · preview`, 'b-warn', 'Previewing: Enter/✓ commits as an override, Esc reverts');
          } else if (st.src === 'system') {
            setBadge(`#${st.a} · system`, 'b-good',
              `${st.systemVariants} built-in variant${st.systemVariants === 1 ? '' : 's'} recovered from owner-qualified asset data.`);
          } else {
            setBadge(`#${st.a} · override${st.local ? '' : ' (saved)'}`, 'b-accent',
              st.local ? 'Saved in this browser. Use the “overrides” manager in the top bar to save it to a file you can share.' : 'Saved to your overrides file.');
          }
        }
        if (st == null || st.a == null) { texMat.map = null; texMat.normalMap = null; }
        texMat.needsUpdate = true;
        if (old.map && old.map !== texMat.map) old.map.dispose();
        if (old.normalMap && old.normalMap !== texMat.normalMap) old.normalMap.dispose();
        if (old.parameterMap && old.parameterMap !== (texMat as any).brighterParameterMap) {
          old.parameterMap.dispose();
        }
        // committed changes (not transient previews) refresh the details panel
        if (!previewImg && !destroyed) app.setEntryDetails('meshes', entry);
      };
      await applyTexState();

      // ---- texture variants: a mesh can hold several assigned textures; click
      // a swatch to make it active, × to remove, ∅ to show none. Texture… adds one.
      const variantsEl = el('span', { class: 'tex-variants' });
      const modeSel = entry.sys?.variants?.length ? el('select', {
        class: 'btn tex-mode',
        title: 'How user textures combine with the recovered built-in variants',
      },
      el('option', { value: 'supplement', text: 'system + user' }),
      el('option', { value: 'replace', text: 'user replaces system' })) : null;
      const syncMode = () => {
        if (modeSel) modeSel.value = effectiveVariants(entry).mode || 'supplement';
      };
      modeSel?.addEventListener('change', () => {
        setOverrideMode(entry, modeSel!.value as any);
        applyTexState(); renderVariants();
      });
      function renderVariants() {
        variantsEl.replaceChildren();
        const vs = getVariants(entry);
        syncMode();
        variantsEl.hidden = vs.length === 0;
        if (!vs.length) return;
        const active = getActiveIndex(entry);
        vs.forEach((v, i) => {
          const on = i === active;
          // resolve the swatch image by CONTENT HASH, not the stored ordinal:
          // the ordinal is only valid for the bundle build the override was made
          // against, so indexing the current images by it shows the wrong asset.
          const ai = resolveVariantImage(v, imagesIdx);
          const img = ai != null ? imagesIdx?.[ai] : null;
          const missing = v.image_hash && img == null;
          const source = v.alsoSystem ? 'user + system' : v.origin || 'user';
          const chip = el('span', { class: `tv-chip tv-${v.origin || 'user'}${on ? ' active' : ''}${missing ? ' tv-missing' : ''}`, title: `${source} variant ${i + 1}${img ? ` · image #${ai}` : missing ? ' · not in your files' : ` · image #${v.image}`}${v.material != null ? ` · material ${v.material}` : ''}${on ? ' (active)' : ' (click to use)'}` });
          chip.appendChild(img?.f?.length ? el('img', { src: app.store.url(img.f[0]), alt: `#${ai}` }) : el('span', { class: 'tv-id', text: missing ? '⃠' : `#${ai ?? v.image}` }));
          chip.appendChild(el('span', { class: 'tv-origin', text: v.origin === 'system' ? 'S' : 'U', title: source }));
          if (v._userIndex != null) {
            const x = el('span', { class: 'tv-x', text: '×', title: 'remove this user variant' });
            x.addEventListener('click', (ev) => { ev.stopPropagation(); removeVariant(entry, i); applyTexState(); renderVariants(); });
            chip.appendChild(x);
          }
          chip.addEventListener('click', () => { setActiveVariant(entry, i); applyTexState(); setMode('tex'); renderVariants(); });
          variantsEl.appendChild(chip);
        });
        const none = el('span', { class: `tv-chip tv-none${active == null ? ' active' : ''}`, text: '∅', title: active == null ? 'no texture active' : 'show no texture (keeps the variants)' });
        none.addEventListener('click', () => { setActiveVariant(entry, null); applyTexState(); renderVariants(); });
        variantsEl.appendChild(none);
      }

      const texBtn = el('button', { class: 'btn btn-cta', text: '▦ Texture…', title: 'Add or change this mesh’s texture. You can assign several and click the swatches to switch between them.' });
      texBtn.addEventListener('click', () => {
        picker?.close();   // never stack pickers: each docks ~3800 <img> cells over
        // #details, and re-clicking Texture… would pile them up (Firefox crash)
        const st = effectiveTex(entry, imagesIdx);
        // docked over the details panel so the 3D live preview stays visible
        picker = openTexturePicker({
          host: document.getElementById('details')!, store: app.store, imagesIdx: imagesIdx!,
          current: st?.a ?? null, baked: entry.tex || null,
          // UV geometry for on-demand "fit" scoring (key = stable content hash)
          fitMesh: {
            key: String(entry.h ?? entry.i),
            positions, uvs: geo.attributes.uv.array, index: geo.index!.array,
          },
          onPreview: (img) => { if (mesh.material !== texMat) setMode('tex'); applyTexState(img); },
          onPick: (img) => { addVariant(entry, img); applyTexState(); setMode('tex'); renderVariants(); },
          onPickMulti: (imgs) => { imgs.forEach((img) => addVariant(entry, img)); applyTexState(); setMode('tex'); renderVariants(); },
          onReset: () => { removeLocalOverride(entry); applyTexState(); renderVariants(); },
          onClear: () => { clearLocalTexture(entry); applyTexState(); setMode('tex'); renderVariants(); },
          onCancel: () => applyTexState(),
          onBanner: (msg) => app.banner(msg, 'b-info'),
        });
      });
      toolbar.appendChild(texBtn);
      if (modeSel) toolbar.appendChild(modeSel);
      toolbar.appendChild(variantsEl);
      toolbar.appendChild(texBadgeEl);
      toolbar.appendChild(el('span', { class: 'sep' }));
      renderVariants();
    }

    const wireBtn = el('button', { class: 'btn', text: 'Wireframe' });
    const applyWire = (on: boolean, persist = true) => {
      wire.visible = on;
      wireBtn.classList.toggle('active', on);
      if (persist) setPref('wireframe', on);
    };
    wireBtn.addEventListener('click', () => applyWire(!wire.visible));
    toolbar.appendChild(wireBtn);
    applyWire(getPref('wireframe'), false);

    const dsBtn = el('button', { class: 'btn', text: '2-sided', title: 'Also draw the back of each surface (helps when a model looks see-through).' });
    const applyDs = (on: boolean, persist = true) => {
      for (const mm of Object.values(mats)) { mm.side = on ? THREE.DoubleSide : THREE.FrontSide; mm.needsUpdate = true; }
      dsBtn.classList.toggle('active', on);
      if (persist) setPref('twosided', on);
    };
    dsBtn.addEventListener('click', () => applyDs(mats.lit.side !== THREE.DoubleSide));
    toolbar.appendChild(dsBtn);
    applyDs(getPref('twosided'), false);

    if (viz) {
      const vz = viz;
      const skBtn = el('button', { class: 'btn', text: 'Rig' });
      const applySk = (on: boolean, persist = true) => {
        vz.setVisible(on);
        skBtn.classList.toggle('active', on);
        if (persist) setPref('skeleton', on);
      };
      skBtn.addEventListener('click', () => applySk(!vz.group.visible));
      toolbar.appendChild(skBtn);
      applySk(getPref('skeleton'), false);
    }

    // UV layout overlay
    const uvBtn = el('button', { class: 'btn', text: 'UV map' });
    let uvCanvas: HTMLCanvasElement | null = null;
    const applyUv = (on: boolean, persist = true) => {
      if (on && !uvCanvas) { uvCanvas = drawUVLayout([geo], 236); host.appendChild(uvCanvas); }
      else if (!on && uvCanvas) { uvCanvas.remove(); uvCanvas = null; }
      uvBtn.classList.toggle('active', on);
      if (persist) setPref('uvmap', on);
    };
    uvBtn.addEventListener('click', () => applyUv(!uvCanvas));
    toolbar.appendChild(uvBtn);
    applyUv(getPref('uvmap'), false);

    toolbar.append(makeGridToggle(scene), makeLightToggle(scene));

    if (skelNote) toolbar.appendChild(badge(skelNote, 'b-warn'));

    addExportButton(toolbar, app, 'meshes', entry);

    // ▣ Screenshot: capture the current 3D view as a still (same modal as the
    // skeleton/model viewers). No Video: a single mesh has nothing to animate on
    // its own beyond a turntable, so a still is the useful capture here.
    const shotBtn = el('button', { class: 'btn', text: '▣ Screenshot', title: 'Capture the current 3D view as a PNG/JPEG/WebP image, with caption, grid and background options' });
    shotBtn.addEventListener('click', async () => {
      const { openScreenshotModal } = await import('./screenshot.js');
      const shotRes = getPref('shotRes') || '8k';
      openScreenshotModal({
        app, scene, entry, activeSize: 1, cat: 'meshes',
        highRes: {
          options: SHOT_RES,
          initial: shotRes in SHOT_RES ? shotRes : '8k',
          onPick: (key: string) => setPref('shotRes', key),
          capture: (key: string, onProgress: (msg: string) => void, opts?: { transparent?: boolean }) =>
            captureTiledPng(scene, key, `brighter-atlas-mesh-${entry.i}`, onProgress, () => !destroyed, opts?.transparent),
        },
      });
    });
    toolbar.appendChild(shotBtn);

    // ❖ Save as Model: a single-mesh Model (no picker: it's just this mesh)
    // with the CURRENTLY ACTIVE texture pinned by content hash, so it can be
    // placed in Scenes like any skeleton-built Model.
    const modelBtn = el('button', { class: 'btn', text: '❖ Save as Model', title: 'Save this mesh (with its currently active texture) as a Model, usable in Scenes' });
    modelBtn.addEventListener('click', async () => {
      if (!entry.h) { app.banner('this export has no content ids. Re-export to save Models'); return; }
      picker?.close();   // a transient picker PREVIEW is never saved: close (and revert) it so the viewport matches what gets pinned
      // the pinned image hash = the active variant, else the effective texture
      const imgHashFor = (): string | null => {
        const vs = imagesIdx ? getVariants(entry) : [];
        if (vs.length) {
          const idx = getActiveIndex(entry);
          return idx == null ? null : (vs[idx]?.image_hash || null);
        }
        const st = imagesIdx ? effectiveTex(entry, imagesIdx) : null;
        return st?.a != null ? (entryByOrdinal(imagesIdx, st.a)?.h || null) : null;
      };
      let skelH: string | null = null;
      if (entry.sk && entry.skel >= 0) {
        try { skelH = (await app.store.index('rigs')).find((s: IndexEntry) => s.i === entry.skel)?.h ?? null; }
        catch { /* static fallback below */ }
      }
      const overlay = el('div', { class: 'modal-overlay' });
      const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); modalClose = null; };
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
      modalClose = close;
      const nameIn = el('input', {
        type: 'text', class: 'video-cap', placeholder: 'model name…',
        value: effectiveName(entry, 'meshes') || `Mesh ${idLabel(entry)}`,
      });
      const createBtn = el('button', { class: 'btn primary', text: '＋ Save model' });
      const cancelBtn = el('button', { class: 'btn', text: 'Cancel' });
      cancelBtn.addEventListener('click', close);
      createBtn.addEventListener('click', () => {
        const rec = saveModel({ name: nameIn.value, skel: skelH, meshes: [{ h: entry.h!, img: imgHashFor() }] });
        app.renderTabs?.();
        app.banner(`created model “${rec.name}”`, 'b-info');
        close();
        location.hash = `#/model/${rec.id}`;
      });
      overlay.appendChild(el('div', { class: 'modal card mesh-model-modal' },
        el('h2', { text: 'Save as Model' }),
        el('p', { class: 'dim small', text: `This mesh${imgHashFor() ? ' with its active texture' : ' (untextured)'}${skelH ? ', on its rig,' : ''} becomes a reusable Model. Place it in Scenes, rename or delete it any time.` }),
        el('label', { class: 'mw-namerow' }, el('span', { text: 'Name' }), nameIn),
        el('div', { class: 'modal-actions' }, createBtn, el('span', { class: 'spacer' }), cancelBtn)));
      document.body.appendChild(overlay);
      nameIn.select();
    });
    toolbar.appendChild(modelBtn);

    // ---- animation transport ----------------------------------------------
    if (rig) {
      const pb = new PlaybackBar({
        host: root, clips, store: app.store, rig,
        onApplied: () => { if (viz?.group.visible) viz.update(); },
        onError: (msg) => app.banner(msg),
      });
      bar = pb;
      scene.addTick((dt) => { pb.tick(dt); if (viz?.group.visible && pb.playing) viz.update(); });
    }

    // debug/test hook
    if ((window as any).__bs) (window as any).__bs.meshView = { entry, rig, viz, mats, scene, bbox, get bar() { return bar; }, get tex() { return effectiveTex(entry, imagesIdx); } };

    // ---- stats -------------------------------------------------------------
    statsRow.append(
      stat('vertices', fmtInt(m.v)),
      stat('triangles', fmtInt(m.t)),
      bboxStat(bbox),
    );
    if (entry.skel >= 0) {
      const link = el('a', { href: `#/rig/${entry.skel}`, text: `#${entry.skel}` });
      statsRow.append(stat('rig', link), stat('clips', fmtInt(clips.length)));
    } else {
      statsRow.append(stat('rig', entry.skel === -2 ? 'pinned (no rig)' : 'none (static)'));
    }
    app.setStatus3(`mesh #${entry.i} · ${fmtInt(m.v)}v ${fmtInt(m.t)}t`);
  })();

  return view;
}

function stat(label: string, value: any): HTMLSpanElement {
  const span = el('span', {}, `${label} `);
  span.appendChild(value instanceof Node ? value : el('b', { text: String(value) }));
  return span;
}

function bboxStat(bbox: number[] | null | undefined): HTMLSpanElement {
  if (!bbox) return el('span');
  const d = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]];
  return stat('size', `${fmtNum(d[0], 1)} × ${fmtNum(d[1], 1)} × ${fmtNum(d[2], 1)}`);
}
