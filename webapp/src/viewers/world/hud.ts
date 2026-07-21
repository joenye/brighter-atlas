// World-view loading/perf HUD — a compact overlay panel shared by the
// single-room and all-rooms views. Shows a live stage line (wired to the real
// streaming/bake counters by world.js), rolling FPS + draw calls + triangles
// from renderer.info, and a one-off environment line (WebGL tier + unmasked
// GPU adapter). Collapsible; the collapsed state persists via prefs
// ('worldhud').

import { el } from '../../ui.js';
import { getPref, setPref } from '../../prefs.js';

interface HudRenderer {
  getContext(): any;
  capabilities: { isWebGL2: boolean };
  info: { render: { frame: number; calls: number; triangles: number } };
}

export interface WorldHudState {
  fps: number;
  drawCalls: number;
  triangles: number;
  stage: string;
  steady: boolean;
  collapsed: boolean;
}

export interface WorldHud {
  root: HTMLElement;
  state: WorldHudState;
  tick: () => void;
  setStage(text: string, opts?: { steady?: boolean; bad?: boolean }): void;
  destroy(): void;
}

// The unmasked renderer is "ANGLE (<vendor>, <adapter>, <backend>)" — a naive
// comma split would truncate it to "ANGLE (NVIDIA". Prefer the adapter
// (second) field inside ANGLE(...), else the full string; the raw string
// rides along for the tooltip. Degrades to the masked GL_RENDERER when the
// extension is blocked. Exported for the smoke test.
export function gpuLabel(renderer: Pick<HudRenderer, 'getContext'>): { label: string; raw: string } {
  try {
    const gl = renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = String((extension
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER)) || '');
    if (/swiftshader/i.test(raw)) return { label: 'SwiftShader (software)', raw };
    const angle = raw.match(/^ANGLE\s*\((.*)\)\s*$/i);
    let label = raw;
    if (angle) {
      const fields = angle[1].split(',').map((part) => part.trim()).filter(Boolean);
      label = fields.length >= 2 ? fields[1] : fields[0] || raw;
    }
    label = label
      .replace(/\s*\(0x[0-9a-f]+\)/ig, '')                       // PCI device ids
      .replace(/\s+(Direct3D\d+|D3D\d+|vs_\d+_\d+|ps_\d+_\d+)\b/ig, '')   // driver suffixes
      .trim();
    return { label: label || 'unknown adapter', raw };
  } catch {
    return { label: 'unknown adapter', raw: '' };
  }
}

export type GpuTier = 'software' | 'integrated' | 'discrete' | 'unknown';

// Adapter classification for GPU-adaptive defaults + the all-rooms warning.
// 'software' = no GPU acceleration at all; 'integrated' = shared-memory iGPU
// (Apple Mx deliberately counts as capable → 'discrete'); 'unknown' when
// WEBGL_debug_renderer_info is blocked (Firefox often masks it — a masked
// adapter must NEVER be scored weak). Anything else with the extension
// available is assumed capable.
export function classifyGpu(renderer: Pick<HudRenderer, 'getContext'>): { label: string; raw: string; tier: GpuTier } {
  const { label, raw } = gpuLabel(renderer);
  let masked = true;
  try { masked = !renderer.getContext().getExtension('WEBGL_debug_renderer_info'); }
  catch { /* no context — stays masked/unknown */ }
  const s = raw || label;
  let tier: GpuTier;
  if (/swiftshader|llvmpipe|microsoft basic render/i.test(s)) {
    tier = 'software';
  } else if (masked) {
    tier = 'unknown';
  } else if (/apple (m\d|gpu)/i.test(s)) {
    tier = 'discrete';
  } else if (
    // Intel iGPU families (HD/UHD/Iris/Iris Xe) — but not the discrete Arc line
    (/\bintel\b/i.test(s) && /\b(hd|uhd|iris)\b/i.test(s) && !/\barc\b/i.test(s))
    // AMD iGPUs: bare "Radeon(TM) Graphics" APUs and the Vega-Graphics APU strings
    || /radeon\s*\(tm\)\s*graphics/i.test(s)
    || /vega.*graphics/i.test(s)
    // mobile GPU families
    || /\bmali\b|adreno|powervr/i.test(s)
  ) {
    tier = 'integrated';
  } else {
    tier = 'discrete';
  }
  return { label, raw, tier };
}

export function createWorldHud({ host, renderer }: {
  host: HTMLElement;
  renderer: HudRenderer;
}): WorldHud {
  const gpu = gpuLabel(renderer);
  const envText = `WebGL${renderer.capabilities.isWebGL2 ? '2' : '1'} · ${gpu.label}`;
  const stageEl = el('div', { class: 'wh-stage', text: 'starting…' });
  const statsEl = el('div', { class: 'wh-stats', text: '… fps · draws · tris' });
  const envEl = el('div', { class: 'wh-env', text: envText, title: gpu.raw || gpu.label });
  const body = el('div', { class: 'wh-body' }, stageEl, statsEl, envEl);
  const chipFps = el('span', { class: 'wh-chip-fps', text: '' });
  const toggle = el('button', { class: 'wh-toggle', title: 'Show/hide the performance HUD' });
  const root = el('div', { class: 'world-hud' }, el('div', { class: 'wh-head' }, toggle, chipFps), body);
  host.appendChild(root);

  const state: WorldHudState = {
    fps: 0, drawCalls: 0, triangles: 0,
    stage: 'starting…', steady: false,
    collapsed: getPref('worldhud') === true,
  };

  const applyCollapsed = () => {
    root.classList.toggle('collapsed', state.collapsed);
    body.hidden = state.collapsed;
    chipFps.hidden = !state.collapsed;
    toggle.textContent = state.collapsed ? '▸' : '−';
  };
  toggle.addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    setPref('worldhud', state.collapsed);
    applyCollapsed();
  });
  applyCollapsed();

  // Rolling FPS + last-frame renderer.info, refreshed at 2 Hz. Ticks run just
  // before each render; info carries the previous frame, and
  // info.render.frame counts ACTUAL renders — the honest rate when the
  // all-rooms view throttles presentation under load.
  let frameBase = renderer.info.render.frame;
  let windowStart = performance.now();
  let alive = true;
  const tick = () => {
    if (!alive) return;
    state.drawCalls = renderer.info.render.calls;
    state.triangles = renderer.info.render.triangles;
    const now = performance.now();
    if (now - windowStart < 500) return;
    state.fps = Math.round(((renderer.info.render.frame - frameBase) * 1000) / (now - windowStart));
    frameBase = renderer.info.render.frame;
    windowStart = now;
    const tris = state.triangles >= 1e6
      ? `${(state.triangles / 1e6).toFixed(1)}M`
      : state.triangles.toLocaleString();
    statsEl.textContent = `${state.fps} fps · ${state.drawCalls.toLocaleString()} draws · ${tris} tris`;
    chipFps.textContent = `${state.fps} fps`;
  };

  return {
    root,
    state,
    tick,
    /** The live stage line ("loading rooms 12/451", "merging batch 3/40"…). */
    setStage(text: string, { steady = false, bad = false }: { steady?: boolean; bad?: boolean } = {}) {
      state.stage = text;
      state.steady = steady;
      stageEl.textContent = text;
      stageEl.classList.toggle('steady', steady);
      stageEl.classList.toggle('bad', bad);
    },
    destroy() {
      alive = false;
      root.remove();
    },
  };
}

export default createWorldHud;
