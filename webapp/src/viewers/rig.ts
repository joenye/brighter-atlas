// Skeleton building + clip sampling + playback UI (the skinned-animation core).
//
// ab6 skeleton JSON: bones[] of { parent, scale[3], quat[x,y,z,w], trans[3], bind[12] }
//   - local rest pose = TRS(trans, quat, scale)
//   - bind is the LOCAL bind matrix [R*S | T], row-major 3x4 (equal to
//     compose(quat,scale)+trans). World bind = parent world bind * local bind, so
//     boneInverses = inverse(world bind) composed down the tree.
// ab1 clip JSON: bones[] of { present, scale|rot|trans: {mode absent|const|track} },
//   sampled every frame_ms (20 ms); tracks are interleaved f32 (xyz / xyzw).

import { THREE } from './three-common.js';
import { b64f32 } from '../store.js';
import { el, fmtDur, debounce, makeResizable } from '../ui.js';
import { effectiveName } from '../names.js';
import { getPref, setPref } from '../prefs.js';
import type { AppStore, IndexEntry } from '../store.js';

export const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2, 4];
// Default 0.5× (not 1×): the raw clip rate plays ~2× too fast vs the in-game
// look, so 0.5× reads as in-game "1×". Only used until the user picks a speed
// (which persists via the 'speed' pref).
export const prefSpeed = (): number => (SPEEDS.includes(getPref('speed')) ? getPref('speed') : 0.5);

export function mat4From3x4(m: ArrayLike<number>): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    m[0], m[1], m[2], m[3],
    m[4], m[5], m[6], m[7],
    m[8], m[9], m[10], m[11],
    0, 0, 0, 1);
}

interface SkelBoneDef {
  parent: number;
  scale: number[];
  quat: number[];   // [x, y, z, w]
  trans: number[];
  bind: number[];   // row-major 3x4
}

interface RestPose { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 }

export class Rig {
  skelIndex: number;
  def: SkelBoneDef[];
  bones: THREE.Bone[];
  roots: THREE.Bone[];
  rest: RestPose[];
  boneInverses: THREE.Matrix4[];
  skeleton: THREE.Skeleton;

  constructor(skelJson: any) {
    this.skelIndex = skelJson.i;
    this.def = skelJson.bones;
    this.bones = this.def.map((_, i) => {
      const b = new THREE.Bone();
      b.name = `bone_${i}`;
      return b;
    });
    this.roots = [];
    this.rest = this.def.map((d) => ({
      pos: new THREE.Vector3().fromArray(d.trans),
      quat: new THREE.Quaternion(d.quat[0], d.quat[1], d.quat[2], d.quat[3]),
      scale: new THREE.Vector3().fromArray(d.scale),
    }));
    this.def.forEach((d, i) => {
      if (d.parent >= 0) this.bones[d.parent].add(this.bones[i]);
      else this.roots.push(this.bones[i]);
    });
    this.resetToRest();

    // world bind composed down the tree from the stored local bind matrices
    const worldBind: THREE.Matrix4[] = [];
    this.def.forEach((d, i) => {
      const local = mat4From3x4(d.bind);
      worldBind[i] = d.parent >= 0 ? worldBind[d.parent].clone().multiply(local) : local;
    });
    this.boneInverses = worldBind.map((m) => m.clone().invert());
    this.skeleton = new THREE.Skeleton(this.bones, this.boneInverses);
  }

  resetToRest(): void {
    this.bones.forEach((b, i) => {
      b.position.copy(this.rest[i].pos);
      b.quaternion.copy(this.rest[i].quat);
      b.scale.copy(this.rest[i].scale);
    });
  }

  // rest-pose world positions (for framing / joint sizing)
  restWorldInfo(): { positions: THREE.Vector3[]; min: THREE.Vector3; max: THREE.Vector3 } {
    const world: THREE.Vector3[] = [];
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const mats: THREE.Matrix4[] = [];
    this.def.forEach((d, i) => {
      const local = new THREE.Matrix4().compose(this.rest[i].pos, this.rest[i].quat, this.rest[i].scale);
      mats[i] = d.parent >= 0 ? mats[d.parent].clone().multiply(local) : local;
      const p = new THREE.Vector3().setFromMatrixPosition(mats[i]);
      world.push(p);
      min.min(p); max.max(p);
    });
    if (!isFinite(min.x)) { min.set(0, 0, 0); max.set(1, 1, 1); }
    return { positions: world, min, max };
  }
}

type Channel =
  | { mode: 'absent' }
  | { mode: 'const'; value: number[] }
  | { mode: 'track'; data: Float32Array; width: number };

function decodeChannel(ch: any, width: number): Channel {
  if (!ch || ch.mode === 'absent') return { mode: 'absent' };
  if (ch.mode === 'const') return { mode: 'const', value: ch.value };
  return { mode: 'track', data: b64f32(ch.data), width };
}

interface ClipBone { scale: Channel; rot: Channel; trans: Channel }

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

export class ClipSampler {
  index: number;
  skel: number;
  duration: number;
  frameMs: number;
  frames: number;
  bones: (ClipBone | null)[];

  constructor(clipJson: any) {
    this.index = clipJson.i;
    this.skel = clipJson.skel;
    this.duration = clipJson.duration_ms;
    this.frameMs = clipJson.frame_ms || 20;
    this.frames = Math.max(1, clipJson.frames);
    this.bones = clipJson.bones.map((b: any) => (b && b.present ? {
      scale: decodeChannel(b.scale, 3),
      rot: decodeChannel(b.rot, 4),
      trans: decodeChannel(b.trans, 3),
    } : null));
  }

  // apply pose at tMs to a Rig (bones without clip data stay at rest pose)
  apply(rig: Rig, tMs: number): void {
    const t = Math.max(0, Math.min(this.duration, tMs));
    const f = this.frames > 1 ? Math.min(t / this.frameMs, this.frames - 1) : 0;
    const i0 = Math.floor(f);
    const i1 = Math.min(i0 + 1, this.frames - 1);
    const a = f - i0;
    for (let i = 0; i < rig.bones.length; i++) {
      const bone = rig.bones[i];
      const rest = rig.rest[i];
      const cb = i < this.bones.length ? this.bones[i] : null;
      if (!cb) {
        bone.position.copy(rest.pos);
        bone.quaternion.copy(rest.quat);
        bone.scale.copy(rest.scale);
        continue;
      }
      this._vec(cb.trans, i0, i1, a, bone.position, rest.pos);
      this._vec(cb.scale, i0, i1, a, bone.scale, rest.scale);
      const r = cb.rot;
      if (r.mode === 'absent') bone.quaternion.copy(rest.quat);
      else if (r.mode === 'const') bone.quaternion.set(r.value[0], r.value[1], r.value[2], r.value[3]);
      else {
        _qa.fromArray(r.data, i0 * 4);
        if (i1 !== i0 && a > 0) {
          _qb.fromArray(r.data, i1 * 4);
          _qa.slerp(_qb, a); // three's slerp takes the short path across q/-q flips
        }
        bone.quaternion.copy(_qa).normalize();
      }
    }
  }

  private _vec(ch: Channel, i0: number, i1: number, a: number, target: THREE.Vector3, rest: THREE.Vector3): void {
    if (ch.mode === 'absent') { target.copy(rest); return; }
    if (ch.mode === 'const') { target.set(ch.value[0], ch.value[1], ch.value[2]); return; }
    const d = ch.data, o0 = i0 * 3, o1 = i1 * 3;
    target.set(
      d[o0] + (d[o1] - d[o0]) * a,
      d[o0 + 1] + (d[o1 + 1] - d[o0 + 1]) * a,
      d[o0 + 2] + (d[o1 + 2] - d[o0 + 2]) * a);
  }
}

// ---------------------------------------------------------------------------
// joints + bone-lines visualization
export class SkeletonViz {
  rig: Rig;
  group: THREE.Group;
  jointMat: THREE.MeshBasicMaterial;
  rootMat: THREE.MeshBasicMaterial;
  joints: THREE.Mesh[];
  edges: [number, number][];
  lineGeo: THREE.BufferGeometry;
  lineMat: THREE.LineBasicMaterial;
  lines: THREE.LineSegments;
  private _wp: THREE.Vector3;

  constructor(parent: THREE.Object3D, rig: Rig,
    { jointRadius = 1, color = 0x78b7ff, onTop = false }: { jointRadius?: number; color?: number; onTop?: boolean } = {}) {
    this.rig = rig;
    this.group = new THREE.Group();
    parent.add(this.group);

    const jointGeo = new THREE.SphereGeometry(jointRadius, 12, 9);
    this.jointMat = new THREE.MeshBasicMaterial({ color, depthTest: !onTop, transparent: onTop, opacity: onTop ? 0.85 : 1 });
    this.rootMat = new THREE.MeshBasicMaterial({ color: 0xe8b45a, depthTest: !onTop, transparent: onTop, opacity: onTop ? 0.9 : 1 });
    this.joints = rig.bones.map((_, i) => {
      const m = new THREE.Mesh(jointGeo, rig.def[i].parent < 0 ? this.rootMat : this.jointMat);
      if (onTop) m.renderOrder = 998;
      this.group.add(m);
      return m;
    });

    this.edges = [];
    rig.def.forEach((d, i) => { if (d.parent >= 0) this.edges.push([d.parent, i]); });
    const pos = new Float32Array(this.edges.length * 6);
    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xaeb6c4, depthTest: !onTop, transparent: onTop, opacity: onTop ? 0.8 : 1 });
    this.lines = new THREE.LineSegments(this.lineGeo, this.lineMat);
    if (onTop) this.lines.renderOrder = 999;
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    this._wp = new THREE.Vector3();
    this.update();
  }

  update(): void {
    for (const root of this.rig.roots) root.updateMatrixWorld(true);
    const posAttr = this.lineGeo.attributes.position as THREE.BufferAttribute;
    this.joints.forEach((j, i) => {
      this._wp.setFromMatrixPosition(this.rig.bones[i].matrixWorld);
      j.position.copy(this._wp);
    });
    this.edges.forEach(([p, c], k) => {
      const a = this.joints[p].position, b = this.joints[c].position;
      posAttr.setXYZ(k * 2, a.x, a.y, a.z);
      posAttr.setXYZ(k * 2 + 1, b.x, b.y, b.z);
    });
    posAttr.needsUpdate = true;
  }

  setVisible(v: boolean): void { this.group.visible = v; }

  dispose(): void {
    this.group.removeFromParent();
    this.joints[0]?.geometry.dispose();
    this.jointMat.dispose(); this.rootMat.dispose();
    this.lineGeo.dispose(); this.lineMat.dispose();
  }
}

// ---------------------------------------------------------------------------
// transport bar: clip <select> · play/pause · loop · speed · scrub · time
export interface PlaybackBarOpts {
  host: HTMLElement;
  clips: IndexEntry[];        // anims-index entries (same skeleton)
  store: AppStore;
  rig: Rig;
  onApplied?: () => void;     // called after each pose application
  onError?: (msg: string) => void;
  autoSelect?: boolean;       // pick first exported clip immediately
}

export class PlaybackBar {
  store: AppStore;
  rig: Rig;
  clips: IndexEntry[];
  onApplied?: () => void;
  onError: (msg: string) => void;
  sampler: ClipSampler | null;
  clipJson: any;
  playing: boolean;
  loop: boolean;
  speed: number;
  t: number;
  root: HTMLDivElement;
  select: HTMLSelectElement;
  sortSel: HTMLSelectElement;
  filterIn: HTMLInputElement;
  playBtn: HTMLButtonElement;
  loopBtn: HTMLButtonElement;
  speedSel: HTMLSelectElement;
  autoBtn: HTMLButtonElement;
  scrub: HTMLInputElement;
  timeLbl: HTMLSpanElement;
  controls: HTMLDivElement;

  constructor({ host, clips, store, rig, onApplied, onError, autoSelect = false }: PlaybackBarOpts) {
    this.store = store;
    this.rig = rig;
    this.clips = clips;
    this.onApplied = onApplied;
    this.onError = onError || (() => {});
    this.sampler = null;
    this.playing = false;
    this.loop = getPref('loop') !== false;
    this.speed = prefSpeed();
    this.t = 0;

    this.root = el('div', { class: 'anim-bar pb' });
    host.appendChild(this.root);
    // the whole transport pane is height-resizable (drag its top edge); the clip
    // listbox fills the space above a pinned control row (see .anim-bar.pb CSS),
    // so shrinking the bar never hides the transport controls
    makeResizable(this.root, { edge: 'top', key: 'animbar', min: 110, max: 600 });

    // Clip picker as a keyboard-navigable LISTBOX (size>1), not a dropdown:
    // ↑/↓ move the selection and fire 'change' on every step, so arrowing
    // through the list live-loads (and auto-plays, when 'auto' is on) the keyed
    // clip. A dropdown only commits on click. Sortable by index/seconds/frames/
    // name via the adjacent sort control. Stays the first <select> in .anim-bar.
    const rows = clips.length ? Math.min(7, clips.length + 1) : 1;
    this.select = el('select', {
      class: 'btn clip-select', size: String(rows),
      title: 'Animation clip (same rig): ↑/↓ to preview',
    });
    this.select.disabled = !clips.length;

    // User names outrank the recovered animatic names (`sn`, world
    // extraction); either way the picker shows a human-readable label.
    const clipName = (c: IndexEntry) => effectiveName(c, 'anims') || (c as any).sn?.[0] || null;
    const CLIP_SORTS: Record<string, (a: IndexEntry, b: IndexEntry) => number> = {
      // named clips first, then index, the default everywhere clips are listed
      named: (a, b) => {
        const an = clipName(a), bn = clipName(b);
        if (!!an !== !!bn) return an ? -1 : 1;
        return a.i - b.i;
      },
      index: (a, b) => a.i - b.i,
      seconds: (a, b) => (a.dur - b.dur) || (a.i - b.i),
      frames: (a, b) => (a.frames - b.frames) || (a.i - b.i),
      name: (a, b) => {
        const an = clipName(a), bn = clipName(b);
        if (!!an !== !!bn) return an ? -1 : 1;   // named clips first
        return (an && bn ? an.localeCompare(bn) : 0) || (a.i - b.i);
      },
    };
    const buildOptions = (sortKey: string, query = '') => {
      const keep = this.select.value;
      const q = query.trim().toLowerCase();
      const match = (c: IndexEntry) => {
        if (!q) return true;
        if (`#${c.i}`.includes(q) || String(c.i).includes(q)) return true;
        const nm = clipName(c);
        if (nm && nm.toLowerCase().includes(q)) return true;
        return ((c as any).sn as string[] | undefined || []).some((n) => n.toLowerCase().includes(q));
      };
      const arr = clips.length
        ? [...clips].filter(match).sort(CLIP_SORTS[sortKey] || CLIP_SORTS.index) : [];
      this.select.replaceChildren(el('option', {
        value: '-1',
        text: clips.length
          ? `clip (${q ? `${arr.length}/${clips.length}` : clips.length})`
          : 'no clips for this rig',
      }));
      for (const c of arr) {
        const nm = clipName(c);
        const aliases = (c as any).sn as string[] | undefined;
        this.select.appendChild(el('option', {
          value: String(c.i),
          text: `#${c.i}${nm ? ` · ${nm}` : ''} · ${(c.dur / 1000).toFixed(2)}s · ${c.frames}f${c.f ? '' : ' (not loaded)'}`,
          disabled: !c.f,
          // recovered-name aliases (multi-name clips list every candidate)
          ...(aliases?.length ? { title: aliases.join('\n') } : {}),
        }));
      }
      if (keep && [...this.select.options].some((o) => o.value === keep)) this.select.value = keep;
      else this.select.value = '-1';
      this.select.selectedOptions[0]?.scrollIntoView?.({ block: 'nearest' });
    };

    this.filterIn = el('input', {
      type: 'search', class: 'clip-filter', placeholder: 'filter clips…',
      autocomplete: 'off', spellcheck: 'false', title: 'Filter clips by name or #index',
      hidden: clips.length <= 1 ? 'hidden' : undefined,
    });
    this.filterIn.addEventListener('input', () => buildOptions(this.sortSel.value, this.filterIn.value));
    this.sortSel = el('select', { class: 'btn clip-sort', title: 'Sort clips', hidden: clips.length <= 1 });
    for (const [k, label] of [['named', 'sort: named first'], ['index', 'sort: index'], ['seconds', 'sort: seconds'], ['frames', 'sort: frames'], ['name', 'sort: name']]) {
      this.sortSel.appendChild(el('option', { value: k, text: label }));
    }
    this.sortSel.value = CLIP_SORTS[getPref('clipsort')] ? getPref('clipsort') : 'named';
    this.sortSel.addEventListener('change', () => { setPref('clipsort', this.sortSel.value); buildOptions(this.sortSel.value, this.filterIn.value); });
    buildOptions(this.sortSel.value);

    // debounced so holding ↑/↓ through many clips only loads the settled one
    const loadFromSelect = debounce(() => {
      const id = parseInt(this.select.value, 10);
      const entry = clips.find((c) => c.i === id);
      if (entry) this.loadClip(entry);
      else this.clearClip();
    }, 90);
    this.select.addEventListener('change', loadFromSelect);
    // Space toggles play/pause while the clip listbox has focus (the play button
    // hints "(space)"); the listbox itself only navigates with ↑/↓, so Space is free.
    this.select.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        this.toggle();
      }
    });

    this.playBtn = el('button', { class: 'btn', text: '▶', title: 'Play/pause (space)', disabled: true });
    this.playBtn.addEventListener('click', () => this.toggle());

    this.loopBtn = el('button', { class: `btn${this.loop ? ' active' : ''}`, text: '⟳', title: 'Loop (persists)' });
    this.loopBtn.addEventListener('click', () => {
      this.loop = !this.loop;
      this.loopBtn.classList.toggle('active', this.loop);
      setPref('loop', this.loop);
    });

    this.speedSel = el('select', { class: 'btn', title: 'Playback speed' });
    for (const s of SPEEDS) {
      this.speedSel.appendChild(el('option', { value: String(s), text: `${s}×`, selected: s === this.speed }));
    }
    this.speedSel.addEventListener('change', () => {
      this.speed = parseFloat(this.speedSel.value);
      setPref('speed', this.speed);
    });

    this.autoBtn = el('button', {
      class: `btn${getPref('autoplay') ? ' active' : ''}`, text: 'auto',
      title: 'Auto-play a clip when it is selected (persists across selections and reloads)',
    });
    this.autoBtn.addEventListener('click', () => {
      setPref('autoplay', !getPref('autoplay'));
      this.autoBtn.classList.toggle('active', getPref('autoplay'));
    });

    this.scrub = el('input', { type: 'range', min: '0', max: '1000', value: '0', disabled: true });
    this.scrub.addEventListener('input', () => {
      if (!this.sampler) return;
      this.pause();
      this.t = (parseInt(this.scrub.value, 10) / 1000) * this.sampler.duration;
      this.applyPose();
    });

    this.timeLbl = el('span', { class: 'anim-time', text: '' });
    // clip listbox fills the top; transport controls live in a pinned row below.
    // `this.controls` is public so callers can append extras (skin selector, …)
    // without pushing the listbox around.
    this.controls = el('div', { class: 'pb-controls' });
    this.controls.append(this.filterIn, this.sortSel, this.playBtn, this.loopBtn, this.speedSel, this.autoBtn, this.scrub, this.timeLbl);
    this.root.append(this.select, this.controls);

    if (autoSelect) {
      const first = clips.find((c) => c.f);
      if (first) { this.select.value = String(first.i); this.loadClip(first); }
    }
  }

  async loadClip(entry: IndexEntry): Promise<void> {
    if (!entry.f) { this.onError(`clip #${entry.i} is not exported`); return; }
    this.pause();
    try {
      const json = await this.store.payload(entry.f);
      this.sampler = new ClipSampler(json);
      this.clipJson = json;
      this.t = 0;
      this.playBtn.disabled = false;
      this.scrub.disabled = false;
      this.applyPose();
      if (getPref('autoplay')) this.play();   // autoplay pref persists across selections/reloads
    } catch (e) {
      this.onError(`failed to load clip #${entry.i}: ${e.message}`);
    }
  }

  clearClip(): void {
    this.pause();
    this.sampler = null;
    this.clipJson = null;
    this.playBtn.disabled = true;
    this.scrub.disabled = true;
    this.scrub.value = '0';
    this.timeLbl.textContent = '-';
    this.rig.resetToRest();
    this.onApplied?.();
  }

  play(): void {
    if (!this.sampler) return;
    // A non-looping clip ends parked at its final frame; pressing play again
    // should replay it from the start rather than sit stuck at the end.
    if (this.t >= this.sampler.duration) this.t = 0;
    this.playing = true;
    this.playBtn.textContent = '❚❚';
  }

  pause(): void {
    this.playing = false;
    this.playBtn.textContent = '▶';
  }

  toggle(): void { this.playing ? this.pause() : this.play(); }

  // called from the Scene3D tick loop
  tick(dt: number): void {
    if (!this.sampler || !this.playing) return;
    this.t += dt * this.speed;
    if (this.t > this.sampler.duration) {
      if (this.loop) this.t = this.sampler.duration > 0 ? this.t % this.sampler.duration : 0;
      else { this.t = this.sampler.duration; this.pause(); }
    }
    this.applyPose();
  }

  applyPose(): void {
    if (!this.sampler) return;
    this.sampler.apply(this.rig, this.t);
    const d = this.sampler.duration;
    this.scrub.value = String(d > 0 ? Math.round((this.t / d) * 1000) : 0);
    const frame = Math.round(this.t / this.sampler.frameMs);
    this.timeLbl.textContent = `${fmtDur(this.t / 1000)} / ${fmtDur(d / 1000)} · f${frame}`;
    this.onApplied?.();
  }

  destroy(): void { this.pause(); }
}
