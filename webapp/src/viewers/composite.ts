// Shared "composite of skinned meshes on one rig" plumbing for the skeleton and
// Model viewers: the material set + the full shading toolbar (Lit / Textured /
// Normals / UV-checker / Bone-influence, plus Wireframe / 2-sided / Skeleton /
// UV-map), and the matFor / refit / refreshUv helpers both need. The mesh SET
// and per-mesh texture resolution differ per viewer, so those stay in the
// callers — this owns only what is identical between the two.
//
// Assumes each `active` mesh carries userData { texMat, wire } (the caller sets
// them up in its enableMesh()). Call this once, at the point the caller has its
// scene/viz/rig-bbox ready and its toolbar built up to the shading section.

import { THREE, checkerTexture } from './three-common.js';
import { drawUVLayout } from './mesh-geometry.js';
import { el, debounce } from '../ui.js';
import { getPref, setPref } from '../prefs.js';
import type { Scene3D } from './three-common.js';
import type { SkeletonViz } from './rig.js';

export interface CompositeOpts {
  scene: Scene3D;                 // the shared scene (frameBox/helpers/addGround)
  toolbar: HTMLElement;           // the viewer toolbar to append shading controls to
  host: HTMLElement;              // the canvas host (the UV-map overlay attaches here)
  viz: SkeletonViz;               // the bone overlay (the Skeleton toggle drives it)
  active: Map<number, THREE.Mesh>; // mesh index -> THREE.Mesh (userData: texMat, wire)
  min: { x: number; y: number; z: number };  // rig bind-pose bbox (refit floor)
  max: { x: number; y: number; z: number };
  isDestroyed: () => boolean;     // guards the debounced refit after teardown
  applyTitle: string;             // tooltip for the shading-mode buttons
  uvTitle: string;                // tooltip for the UV-map toggle
}

export interface CompositeControls {
  mats: Record<string, THREE.Material>;
  wireMat: THREE.MeshBasicMaterial;
  texLoader: THREE.TextureLoader;
  po: { polygonOffset: boolean; polygonOffsetFactor: number; polygonOffsetUnits: number };
  matFor: (obj: THREE.Mesh) => THREE.Material;
  refit: () => void;
  refreshUv: () => void;
  getMode: () => string;
}

export function mountComposite({ scene, toolbar, host, viz, active, min, max, isDestroyed, applyTitle, uvTitle }: CompositeOpts): CompositeControls {
  const po = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const mats: Record<string, THREE.Material> = {
    lit: new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.04, roughness: 0.82, ...po }),
    normals: new THREE.MeshNormalMaterial({ ...po }),
    uv: new THREE.MeshBasicMaterial({ map: checkerTexture(), ...po }),
    bones: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.9, ...po }),
  };
  const wireMat = new THREE.MeshBasicMaterial({ wireframe: true, color: 0x8fd0ff, transparent: true, opacity: 0.28 });
  const texLoader = new THREE.TextureLoader();
  let mode = 'lit';
  let uvCanvas: HTMLCanvasElement | null = null;

  const matFor = (obj: THREE.Mesh): THREE.Material => {
    if (mode === 'tex') return obj.userData.texMat;
    if (mode === 'bones' && !obj.geometry.attributes.color) return mats.lit;
    return mats[mode] || mats.lit;
  };
  const applyAll = () => { for (const obj of active.values()) obj.material = matFor(obj); };

  // fit the camera to the rig bbox ∪ every enabled mesh, keeping the orbit angle;
  // the ground grid resizes with it.
  const refit = debounce(() => {
    if (isDestroyed()) return;
    const bb = new THREE.Box3(new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(max.x, max.y, max.z));
    for (const obj of active.values()) {
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      bb.union(obj.geometry.boundingBox!);
    }
    scene.frameBox([bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.max.y, bb.max.z], { keepDirection: true });
    scene.helpers.clear();
    scene.addGround(Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, 1) / 2, Math.min(0, bb.min.z));
  }, 250);

  const refreshUv = () => {
    if (!uvCanvas) return;
    const keep = uvCanvas;
    uvCanvas = drawUVLayout([...active.values()].map((o) => o.geometry), 236, [...active.keys()]);
    keep.replaceWith(uvCanvas);
  };

  // ---- shading toolbar ----------------------------------------------------
  const modeBtns: Record<string, HTMLButtonElement> = {};
  const setMode = (name: string, persist = true) => {
    mode = name;
    applyAll();
    for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle('active', k === name);
    if (persist) setPref('shading', name);
  };
  toolbar.appendChild(el('span', { class: 'sep' }));
  for (const [key, label] of [['lit', 'Lit'], ['tex', 'Textured'], ['normals', 'Normals'], ['uv', 'UV checker'], ['bones', 'Bone influence']]) {
    const b = el('button', { class: 'btn', text: label, title: applyTitle });
    b.addEventListener('click', () => setMode(key));
    modeBtns[key] = b;
    toolbar.appendChild(b);
  }
  setMode(modeBtns[getPref('shading')] ? getPref('shading') : 'lit', false);
  toolbar.appendChild(el('span', { class: 'sep' }));

  const wireBtn = el('button', { class: 'btn', text: 'Wireframe' });
  const applyWire = (on: boolean, persist = true) => {
    for (const obj of active.values()) obj.userData.wire.visible = on;
    wireBtn.classList.toggle('active', on);
    if (persist) setPref('wireframe', on);
  };
  wireBtn.addEventListener('click', () => applyWire(!wireBtn.classList.contains('active')));
  toolbar.appendChild(wireBtn);
  applyWire(getPref('wireframe'), false);

  const dsBtn = el('button', { class: 'btn', text: '2-sided', title: 'Also draw the back of each surface (helps when a model looks see-through).' });
  const applyDs = (on: boolean, persist = true) => {
    const side = on ? THREE.DoubleSide : THREE.FrontSide;
    for (const mm of Object.values(mats)) { mm.side = side; mm.needsUpdate = true; }
    for (const obj of active.values()) { obj.userData.texMat.side = side; obj.userData.texMat.needsUpdate = true; }
    dsBtn.classList.toggle('active', on);
    if (persist) setPref('twosided', on);
  };
  dsBtn.addEventListener('click', () => applyDs(!dsBtn.classList.contains('active')));
  toolbar.appendChild(dsBtn);
  applyDs(getPref('twosided'), false);

  const skBtn = el('button', { class: 'btn', text: 'Rig' });
  const applySk = (on: boolean, persist = true) => {
    viz.setVisible(on);
    if (on) viz.update();
    skBtn.classList.toggle('active', on);
    if (persist) setPref('skelviz', on);
  };
  skBtn.addEventListener('click', () => applySk(!viz.group.visible));
  toolbar.appendChild(skBtn);
  applySk(getPref('skelviz') !== false, false);

  const uvBtn = el('button', { class: 'btn', text: 'UV map', title: uvTitle });
  const applyUv = (on: boolean, persist = true) => {
    if (on && !uvCanvas) {
      uvCanvas = drawUVLayout([...active.values()].map((o) => o.geometry), 236, [...active.keys()]);
      host.appendChild(uvCanvas);
    } else if (!on && uvCanvas) {
      uvCanvas.remove();
      uvCanvas = null;
    }
    uvBtn.classList.toggle('active', on);
    if (persist) setPref('uvmap', on);
  };
  uvBtn.addEventListener('click', () => applyUv(!uvCanvas));
  toolbar.appendChild(uvBtn);
  applyUv(getPref('uvmap'), false);

  return { mats, wireMat, texLoader, po, matFor, refit, refreshUv, getMode: () => mode };
}
