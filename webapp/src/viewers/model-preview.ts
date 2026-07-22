// A small, self-contained 3D preview for the Save-as-Model wizard. It renders
// its OWN scene (the selected mesh geometries at bind pose, each with its chosen
// texture variant) to a render target via the shared renderer and blits the
// result to a 2D canvas, the same render-to-target-and-composite trick the
// screenshot/video previews use, so it never touches the live composite behind
// the modal. Geometries are BORROWED from the skeleton view's loaded meshes and
// must NOT be disposed here; only the materials we build are ours to dispose.

import { THREE, getRenderer , savedLights } from './three-common.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { renderTransparentFrame } from './capture-common.js';
import { resolveRoles, texFile, resolveVariantImage } from '../texmap.js';
import { entryByOrdinal } from '../store.js';
import type { IndexEntry } from '../store.js';

export interface ModelPreviewSelection { geo: any; imgHash: string | null }

export function createModelPreview(canvas: HTMLCanvasElement, { app, imagesIdx }: { app: any; imagesIdx: IndexEntry[] | null }) {
  const ctx = canvas.getContext('2d')!;
  const stage = document.createElement('canvas');
  const sctx = stage.getContext('2d')!;
  const BG = '#0d0f13';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 500000);
  camera.up.set(0, 0, 1);   // Z-up world, matching Scene3D
  const controls = new OrbitControls(camera, canvas);   // drag to orbit, wheel to zoom, right-drag to pan
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  // lights lifted from Scene3D so the preview shades like the real viewer
  const lights = savedLights();   // match the shared viewers' persisted lighting
  const hemi = new THREE.HemisphereLight(0xcdd9ee, 0x33291f, lights.ambient); hemi.position.set(0, 0, 1);
  const key = new THREE.DirectionalLight(0xffffff, lights.sun); key.position.set(1, -1.2, 1.6);
  const fill = new THREE.DirectionalLight(0x8fb0dd, lights.fill); fill.position.set(-1.2, 0.8, 0.5);
  scene.add(hemi, key, fill);
  const group = new THREE.Group();
  scene.add(group);

  const texLoader = new THREE.TextureLoader();
  const po = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };

  let raf = 0, destroyed = false, token = 0;
  let center = new THREE.Vector3();

  async function makeMat(imgHash: string | null) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.03, roughness: 0.85, alphaTest: 0.35, side: THREE.DoubleSide, ...po });
    const a = (imagesIdx && imgHash) ? resolveVariantImage({ image_hash: imgHash }, imagesIdx) : null;
    if (a != null) {
      const img = entryByOrdinal(imagesIdx, a);
      const roles: any = img ? resolveRoles(img as any) : {};
      const albFile = texFile(img, roles.albedo);
      if (albFile) {
        try {
          const map = await texLoader.loadAsync(app.store.url(albFile));
          map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
          mat.map = map; mat.color.set(0xffffff);
        } catch { /* neutral fallback */ }
      }
    }
    return mat;
  }

  function clearGroup(): void {
    for (const c of [...group.children] as any[]) {
      group.remove(c);
      c.material?.map?.dispose?.();
      c.material?.dispose?.();
    }
  }

  function frame(): void {
    const bb = new THREE.Box3();
    for (const c of group.children as any[]) { if (!c.geometry.boundingBox) c.geometry.computeBoundingBox(); bb.union(c.geometry.boundingBox); }
    if (bb.isEmpty()) { center.set(0, 0, 0); return; }
    center = bb.getCenter(new THREE.Vector3());
    const r = Math.max(1e-3, 0.5 * bb.getSize(new THREE.Vector3()).length());
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.1;
    const dir = new THREE.Vector3(-0.55, 0.71, 0.44).normalize();   // characters face +Y toward the viewer
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = Math.max(dist / 500, 0.05); camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.minDistance = r * 0.12;
    controls.maxDistance = dist * 6;
    controls.update();
  }

  // list: [{ geo: BufferGeometry (borrowed), imgHash: string|null }]
  async function setSelection(list: ModelPreviewSelection[]): Promise<void> {
    const my = ++token;
    clearGroup();
    for (const item of list) {
      const mat = await makeMat(item.imgHash);
      if (destroyed || my !== token) { mat.map?.dispose?.(); mat.dispose(); return; }
      const m = new THREE.Mesh(item.geo, mat);
      m.frustumCulled = false;
      group.add(m);
    }
    frame();
  }

  function loop(): void {
    if (destroyed) return;
    controls.update();   // damped orbit/zoom/pan
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, w, h);
    if (group.children.length) {
      const f = renderTransparentFrame({ renderer: getRenderer(), scene, camera }, w, h);
      if (stage.width !== w || stage.height !== h) { stage.width = w; stage.height = h; }
      sctx.putImageData(new ImageData(f.data, w, h), 0, 0);
      ctx.drawImage(stage, 0, 0);   // straight-alpha composite over the solid bg
    }
    raf = requestAnimationFrame(loop);
  }
  loop();

  return {
    setSelection,
    destroy() { destroyed = true; cancelAnimationFrame(raf); controls.dispose(); clearGroup(); },
  };
}
