// First-person fly camera for the all-rooms world view, matching osrs.world's
// map-viewer controls: left/right-drag looks (deltas consumed per frame),
// double-click toggles pointer-lock mouselook, WASD moves in the horizontal
// plane relative to yaw only, E/R rise + Q/C sink at half speed, arrows turn
// at a constant rate, Shift ×10, Tab ×0.1. No orbit target — pure yaw/pitch on
// a Y-up camera. The view calls update(dt) every frame and dispose() on
// destroy.

import type { Camera } from '../../../vendor/three.module.js';

// osrs.world constants, converted from its 2048-unit circle: arrows turn at
// 320 units/s (≈56°/s); vertical travel is half of horizontal (8 vs 16).
const TURN_RATE = Math.PI * (320 / 1024);        // rad/s
const VERTICAL_RATIO = 0.5;
const FAST_MULT = 10;                            // Shift
const SLOW_MULT = 0.1;                           // Tab
const PITCH_LIMIT = (89 / 180) * Math.PI;
// Drag sensitivity in CSS pixels (render-scale independent): a full
// canvas-width drag sweeps 360° of yaw, a full-height drag ≈120° of pitch.
const YAW_SWEEP = Math.PI * 2;
const PITCH_SWEEP = (120 / 180) * Math.PI;
const WHEEL_STEP = 0.35;                         // seconds of base travel per notch

const HANDLED_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'KeyE', 'KeyR', 'KeyQ', 'KeyC',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'Tab',
]);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isEditable = (node: any) => !!node
  && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName || ''));

export class FlyControls {
  camera: Camera;
  domElement: HTMLElement;
  onChange: (() => void) | null;
  enabled: boolean;
  disposed: boolean;
  moveSpeed: number;
  cameraSpeed: number;
  yaw: number;
  pitch: number;
  hover: boolean;
  keys: Set<string>;
  _dx: number;
  _dy: number;
  _wheel: number;
  _dragId: number | null;
  _lastX: number;
  _lastY: number;
  _onPointerDown: (event: PointerEvent) => void;
  _onPointerMove: (event: PointerEvent) => void;
  _onPointerEnd: (event: PointerEvent) => void;
  _onPointerEnter: () => void;
  _onPointerLeave: () => void;
  _onDblClick: () => void;
  _onContextMenu: (event: Event) => void;
  _onWheel: (event: WheelEvent) => void;
  _onKeyDown: (event: KeyboardEvent) => void;
  _onKeyUp: (event: KeyboardEvent) => void;
  _onBlur: () => void;

  constructor({ camera, domElement, onChange = null }: {
    camera: Camera;
    domElement: HTMLElement;
    onChange?: (() => void) | null;
  }) {
    this.camera = camera;
    this.domElement = domElement;
    this.onChange = onChange;
    this.enabled = true;
    this.disposed = false;
    this.moveSpeed = 60;      // world units/s at ×1 — the view scales it to the world span
    this.cameraSpeed = 1;     // user-tunable multiplier (exposed on the view)
    this.yaw = 0;
    this.pitch = 0;
    this.hover = false;       // keys only act while the pointer is over the canvas (or locked)
    this.keys = new Set();
    this._dx = 0;
    this._dy = 0;
    this._wheel = 0;
    this._dragId = null;
    this._lastX = 0;
    this._lastY = 0;
    camera.rotation.order = 'YXZ';

    this._onPointerDown = (event) => {
      if (!this.enabled || (event.button !== 0 && event.button !== 2)) return;
      this._dragId = event.pointerId;
      this._lastX = event.clientX;
      this._lastY = event.clientY;
      try { domElement.setPointerCapture(event.pointerId); } catch { /* detached */ }
    };
    this._onPointerMove = (event) => {
      if (!this.enabled) return;
      if (this._locked()) {
        this._dx += event.movementX || 0;
        this._dy += event.movementY || 0;
        return;
      }
      if (event.pointerId !== this._dragId) return;
      this._dx += event.clientX - this._lastX;
      this._dy += event.clientY - this._lastY;
      this._lastX = event.clientX;
      this._lastY = event.clientY;
    };
    this._onPointerEnd = (event) => {
      if (event.pointerId === this._dragId) this._dragId = null;
    };
    this._onPointerEnter = () => { this.hover = true; };
    this._onPointerLeave = () => { this.hover = false; };
    this._onDblClick = () => {
      if (!this.enabled) return;
      if (this._locked()) document.exitPointerLock();
      else Promise.resolve(domElement.requestPointerLock?.()).catch(() => {});
    };
    this._onContextMenu = (event) => event.preventDefault();
    this._onWheel = (event) => {
      if (!this.enabled) return;
      event.preventDefault();
      this._wheel += event.deltaY < 0 ? 1 : -1;
    };
    this._onKeyDown = (event) => {
      if (!this.enabled || !HANDLED_CODES.has(event.code)) return;
      // Never swallow a browser/OS chord — Ctrl+R reload, Cmd+W, etc. No fly
      // control uses a modifier, and KeyR/KeyF/etc. would otherwise block them.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!(this.hover || this._locked() || this._dragId !== null)) return;
      if (isEditable(event.target)) return;
      event.preventDefault();     // arrows scroll the page, Tab steals focus
      event.stopPropagation();    // …and the app's list navigation owns arrows too
      this.keys.add(event.code);
    };
    this._onKeyUp = (event) => { this.keys.delete(event.code); };
    this._onBlur = () => { this.keys.clear(); };

    domElement.addEventListener('pointerdown', this._onPointerDown);
    domElement.addEventListener('pointermove', this._onPointerMove);
    domElement.addEventListener('pointerup', this._onPointerEnd);
    domElement.addEventListener('pointercancel', this._onPointerEnd);
    domElement.addEventListener('pointerenter', this._onPointerEnter);
    domElement.addEventListener('pointerleave', this._onPointerLeave);
    domElement.addEventListener('dblclick', this._onDblClick);
    domElement.addEventListener('contextmenu', this._onContextMenu);
    domElement.addEventListener('wheel', this._onWheel, { passive: false });
    // capture phase: beat the app's document-level list-navigation keydowns
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  _locked(): boolean {
    return document.pointerLockElement === this.domElement;
  }

  /** Face a world position from where the camera stands (initial framing / Focus). */
  lookAt(target: { x: number; y: number; z: number }): void {
    const p = this.camera.position;
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const dz = target.z - p.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    this.pitch = clamp(Math.asin(dy / len), -PITCH_LIMIT, PITCH_LIMIT);
    this.yaw = Math.atan2(-dx, -dz);
    this._apply();
  }

  _apply(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.onChange?.();
  }

  /** Integrate one frame; dt in ms. Returns true when the camera moved. */
  update(dt: number): boolean {
    if (this.disposed || !this.enabled) return false;
    const t = Math.min(dt || 16, 100) / 1000;
    let changed = false;

    if (this._dx || this._dy) {
      const rect = this.domElement.getBoundingClientRect();
      this.yaw -= this._dx * (YAW_SWEEP / Math.max(1, rect.width));
      this.pitch -= this._dy * (PITCH_SWEEP / Math.max(1, rect.height));
      this._dx = 0;
      this._dy = 0;
      changed = true;
    }

    const { keys } = this;
    let mult = 1;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) mult = FAST_MULT;
    if (keys.has('Tab')) mult = SLOW_MULT;

    if (keys.has('ArrowUp')) { this.pitch += TURN_RATE * t; changed = true; }
    if (keys.has('ArrowDown')) { this.pitch -= TURN_RATE * t; changed = true; }
    if (keys.has('ArrowLeft')) { this.yaw += TURN_RATE * t; changed = true; }
    if (keys.has('ArrowRight')) { this.yaw -= TURN_RATE * t; changed = true; }
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);

    let forward = 0;
    let strafe = 0;
    let lift = 0;
    if (keys.has('KeyW')) forward += 1;
    if (keys.has('KeyS')) forward -= 1;
    if (keys.has('KeyA')) strafe -= 1;
    if (keys.has('KeyD')) strafe += 1;
    if (keys.has('KeyE') || keys.has('KeyR')) lift += 1;
    if (keys.has('KeyQ') || keys.has('KeyC')) lift -= 1;

    const speed = this.moveSpeed * this.cameraSpeed * mult;
    const p = this.camera.position;
    if (forward || strafe) {
      // yaw only: WASD stays in the horizontal plane regardless of pitch
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      p.x += (-sin * forward + cos * strafe) * speed * t;
      p.z += (-cos * forward - sin * strafe) * speed * t;
      changed = true;
    }
    if (lift) {
      p.y += lift * speed * VERTICAL_RATIO * t;
      changed = true;
    }
    if (this._wheel) {
      // gentle dolly along the full view direction (osrs.world has no wheel)
      const d = this._wheel * this.moveSpeed * this.cameraSpeed * WHEEL_STEP;
      const cp = Math.cos(this.pitch);
      p.x += -Math.sin(this.yaw) * cp * d;
      p.y += Math.sin(this.pitch) * d;
      p.z += -Math.cos(this.yaw) * cp * d;
      this._wheel = 0;
      changed = true;
    }

    if (changed) this._apply();
    return changed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.keys.clear();
    this._dragId = null;
    if (this._locked()) document.exitPointerLock();
    const dom = this.domElement;
    dom.removeEventListener('pointerdown', this._onPointerDown);
    dom.removeEventListener('pointermove', this._onPointerMove);
    dom.removeEventListener('pointerup', this._onPointerEnd);
    dom.removeEventListener('pointercancel', this._onPointerEnd);
    dom.removeEventListener('pointerenter', this._onPointerEnter);
    dom.removeEventListener('pointerleave', this._onPointerLeave);
    dom.removeEventListener('dblclick', this._onDblClick);
    dom.removeEventListener('contextmenu', this._onContextMenu);
    dom.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }
}

export default FlyControls;
