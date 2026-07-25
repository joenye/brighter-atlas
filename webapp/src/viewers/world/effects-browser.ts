// World subview at #/world/effects: a searchable browser over every
// recovered particle effect system for this game version. Systems are
// listed whether or not a name was recovered for them (unnamed rows read
// "system #<slot>", grouped under a collapsed header so the named systems
// stay the headline); the search box also matches the name of every room
// the system is attached to, so an unnamed system stays findable by where
// it appears in the world. The right pane plays the selected system with
// the shared preview engine (effects-player.ts) in a plain 3D scene,
// auto-framed from the system's own decoded reach, with a scrub bar and a
// one-shot Play button for timed (non-looping) systems.

import {
  el, clear, append, badge, kvTable, fmtInt, fmtNum, debounce, placeholderCard, pad5,
} from '../../ui.js';
import { VList } from '../../virtual-list.js';
import { Scene3D } from '../three-common.js';
import { EffectsPlayer } from './effects-player.js';
import type { EffectsPlayerMode } from './effects-player.js';
import { spriteDrawOf } from './effects-sprite.js';
import type {
  WorldEffectsDoc, EffectSystem, EffectConfig, EffectEmitter,
} from '../../extract/world/effects.js';

interface SystemRow {
  system: EffectSystem;
  label: string;
  approximate: boolean;
  rooms: { room: number; controller: number | null }[];
  modelIds: string[];
  hay: string;
}
interface HeaderRow { header: true; label: string; collapsed: boolean }
type ListItem = SystemRow | HeaderRow;

// ------------------------------------------------------------- doc analysis

// Renderer fallback for an unclassified spawn shape is always a generic
// point emission (effects-sim.ts's resolveShape); the browser flags any
// system carrying one of these so the preview's approximation is visible
// rather than silently passing as exact.
function emitterIsApproxShape(emitter: EffectEmitter, configs: Record<string, EffectConfig>): boolean {
  if (emitter.shape == null) return true;
  const cfg = configs[String(emitter.shape)];
  if (!cfg || cfg.kind !== 'shape') return true;
  return (cfg.shape_kind || 'other') === 'other';
}

// Analytic framing radius: spawn-shape extent plus how far a particle can
// travel over its own life (speed * life + 0.5 * accel * life^2), the same
// closed-form terms effects-sim.ts evaluates per particle. Never exact (it
// ignores fan-out/spread), just enough to auto-frame the preview camera.
function estimateSystemRadius(system: EffectSystem, configs: Record<string, EffectConfig>, tickRate: number): number {
  const rate = tickRate > 0 ? tickRate : 1;
  let maxReach = 0;
  for (const emitter of system.emitters) {
    const life = Math.max(1, Number(emitter.life?.ticks) || rate);
    const speed = (Number(emitter.speed?.value) || 0) / rate;
    const av = emitter.acceleration?.v;
    const accelMag = Array.isArray(av)
      ? Math.hypot(Number(av[0]) || 0, Number(av[1]) || 0, Number(av[2]) || 0) / (rate * rate) : 0;
    let reach = speed * life + 0.5 * accelMag * life * life;
    const cfg = emitter.shape != null ? configs[String(emitter.shape)] : null;
    if (cfg) {
      const center = cfg.center;
      if (Array.isArray(center)) reach += Math.hypot(Number(center[0]) || 0, Number(center[1]) || 0, Number(center[2]) || 0);
      if (Number.isFinite(cfg.radius)) reach += Math.abs(Number(cfg.radius));
      if (cfg.spiral) reach += Math.abs(Number(cfg.spiral.start_radius) || 0) + Math.abs(Number(cfg.spiral.radius_rate) || 0) * life;
    }
    maxReach = Math.max(maxReach, reach);
  }
  return Math.max(48, maxReach);
}

// Preview span in ticks: the last burst window's end plus that emitter's
// life for windowed bursts, else the emitter life; looping systems also
// consider the system's own cycle length. Used only to size the scrub bar.
function estimateSystemSpan(system: EffectSystem, configs: Record<string, EffectConfig>): number {
  let span = 0;
  for (const emitter of system.emitters) {
    const life = Number(emitter.life?.ticks) || 0;
    const cfg = emitter.burst != null ? configs[String(emitter.burst)] : null;
    if (cfg?.kind === 'burst_windowed' && Array.isArray(cfg.windows)) {
      for (const w of cfg.windows) span = Math.max(span, (Number(w?.[1]) || 0) + life);
    } else {
      span = Math.max(span, life);
    }
  }
  if (system.loop) span = Math.max(span, Number(system.cycle_ticks) || 0);
  return Math.max(1, span);
}

// Room names, resolved once from the world index (not the effects doc,
// which only knows room ids). Missing/unavailable index: rooms still show
// as "Room <id>" and the room-name search facet is simply empty.
async function loadWorldMeta(app: any): Promise<{ roomNames: Map<number, string>; textures: Record<string, any> }> {
  const roomNames = new Map<number, string>();
  let textures: Record<string, any> = {};
  try {
    const wi = await app.store.worldIndex?.();
    for (const r of (wi?.rooms || [])) {
      const id = Number.isInteger(r?.id) ? r.id : r?.i;
      if (Number.isInteger(id) && r?.name) roomNames.set(id, r.name);
    }
    textures = wi?.textures || {};
  } catch { /* world index unavailable: room search + thumbnails degrade gracefully */ }
  return { roomNames, textures };
}

// Inverted join from a system's owner attachments to any system model that
// resolves through the same registry slot (model.sources[].owner_slot /
// entity_owner_slot / entity_family_owner_slot), mirroring the model page's
// own forward join (viewers/model.ts modelOwnerSlots) in reverse.
async function loadModelJoin(app: any): Promise<{ byOwner: Map<number, Set<string>>; nameById: Map<string, string> }> {
  const byOwner = new Map<number, Set<string>>();
  const nameById = new Map<string, string>();
  let models: any[] = [];
  try { models = await app.loadSystemModels(); } catch { models = []; }
  for (const model of models || []) {
    if (!model || typeof model.id !== 'string') continue;
    nameById.set(model.id, model.name || model.id);
    const sources = Array.isArray(model.sources) ? model.sources : [];
    for (const source of sources) {
      for (const key of ['owner_slot', 'entity_owner_slot', 'entity_family_owner_slot']) {
        const value = source?.[key];
        if (Number.isInteger(value)) {
          let set = byOwner.get(value);
          if (!set) { set = new Set(); byOwner.set(value, set); }
          set.add(model.id);
        }
      }
    }
  }
  return { byOwner, nameById };
}

// The list index: one row per system, ascending slot (the doc's own order).
// The search haystack folds in every attached room's name (resolved above)
// and actor label so a system with no recovered name is still findable by
// where it shows up in the world.
function buildIndex(doc: WorldEffectsDoc, roomNames: Map<number, string>,
  modelsByOwner: Map<number, Set<string>>, modelNameById: Map<string, string>): SystemRow[] {
  const roomsBySystem = new Map<number, Map<number, number | null>>();
  for (const a of doc.attachments.rooms) {
    let m = roomsBySystem.get(a.system);
    if (!m) { m = new Map(); roomsBySystem.set(a.system, m); }
    if (!m.has(a.room)) m.set(a.room, a.controller);
  }
  const actorsBySystem = new Map<number, Set<string>>();
  for (const a of doc.attachments.actors) {
    let s = actorsBySystem.get(a.system);
    if (!s) { s = new Set(); actorsBySystem.set(a.system, s); }
    if (a.label) s.add(a.label);
  }
  const ownersBySystem = new Map<number, Set<number>>();
  for (const a of doc.attachments.owners) {
    let s = ownersBySystem.get(a.system);
    if (!s) { s = new Set(); ownersBySystem.set(a.system, s); }
    s.add(a.owner);
  }
  return doc.systems.map((system) => {
    const label = system.names[0]?.name || `system #${system.slot}`;
    const roomMap = roomsBySystem.get(system.slot);
    const rooms = roomMap
      ? [...roomMap.entries()].map(([room, controller]) => ({ room, controller })).sort((a, b) => a.room - b.room)
      : [];
    const actorLabels = [...(actorsBySystem.get(system.slot) || [])];
    const owners = ownersBySystem.get(system.slot);
    const modelIdSet = new Set<string>();
    if (owners) for (const owner of owners) for (const id of (modelsByOwner.get(owner) || [])) modelIdSet.add(id);
    const modelIds = [...modelIdSet];
    const hay = [
      label, `#${system.slot}`,
      ...system.names.map((n) => n.name),
      ...rooms.map((r) => roomNames.get(r.room) || ''),
      ...actorLabels,
      ...modelIds.map((id) => modelNameById.get(id) || ''),
    ].join(' ').toLowerCase();
    return {
      system,
      label,
      approximate: system.emitters.some((e) => emitterIsApproxShape(e, doc.configs)),
      rooms,
      modelIds,
      hay,
    };
  });
}

// ------------------------------------------------------------------- view

export function createEffectsBrowserView(app: any): { root: HTMLElement; destroy(): void; [key: string]: any } {
  const root = el('div', { class: 'viewer-pane we-view' });
  root.appendChild(el('div', { class: 'center-note', text: 'Loading effects…' }));

  let destroyed = false;
  let doc: WorldEffectsDoc | null = null;
  let rows: SystemRow[] = [];
  let filtered: ListItem[] = [];
  let selected: SystemRow | null = null;
  let unnamedCollapsed = true;
  let roomNames = new Map<number, string>();
  let modelNames = new Map<string, string>();
  let textures: Record<string, any> = {};

  let vlist: VList<ListItem> | null = null;
  let scene: Scene3D | null = null;
  let tickOff: (() => void) | null = null;
  let player: EffectsPlayer | null = null;
  let running = true;
  let transportEls: { scrub: HTMLInputElement; timeLbl: HTMLElement; max: number } | null = null;
  let lastTransportSync = 0;

  let search!: HTMLInputElement;
  let countBadge!: HTMLElement;
  let canvasHost!: HTMLElement;
  let transportHost!: HTMLElement;
  let detailsHost!: HTMLElement;

  const api = { count, select, previewInfo };

  const view = {
    root,
    destroy(): void {
      destroyed = true;
      tickOff?.();
      tickOff = null;
      player?.dispose();
      player = null;
      scene?.destroy();
      scene = null;
      vlist?.destroy();
      vlist = null;
      if ((window as any).__bs?.effectsView === api) delete (window as any).__bs.effectsView;
    },
  };
  if ((window as any).__bs) (window as any).__bs.effectsView = api;

  function count(): number { return rows.length; }

  function previewInfo(): { system: number | null; label: string | null; mode: string | null; live: number } {
    if (!selected || !player) return { system: null, label: null, mode: null, live: 0 };
    const info = player.info();
    const entry = info.systems.find((sys) => sys.slot === selected!.system.slot);
    return { system: selected.system.slot, label: selected.label, mode: entry?.mode || null, live: info.live };
  }

  function select(nameOrSlot: string | number): boolean {
    if (!vlist) return false;
    const bySlot = Number(nameOrSlot);
    const row = (Number.isFinite(bySlot) ? rows.find((r) => r.system.slot === bySlot) : undefined)
      || rows.find((r) => r.label.toLowerCase() === String(nameOrSlot).toLowerCase())
      || rows.find((r) => r.system.names.some((n) => n.name.toLowerCase() === String(nameOrSlot).toLowerCase()));
    if (!row) return false;
    if (row.system.names.length === 0) unnamedCollapsed = false;
    search.value = '';
    selected = row;
    applyFilter();
    if (vlist.selectedIndex >= 0) vlist.revealIndex(vlist.selectedIndex, true);
    mountPreview(row);
    return true;
  }

  // ---- list --------------------------------------------------------------

  function applyFilter(): void {
    if (!vlist) return;
    const q = search.value.trim().toLowerCase();
    const src = q ? rows.filter((r) => r.hay.includes(q)) : rows;
    const named = src.filter((r) => r.system.names.length > 0);
    const unnamed = src.filter((r) => r.system.names.length === 0);
    const list: ListItem[] = [...named];
    if (unnamed.length) {
      const collapsed = unnamedCollapsed && !q;   // a live search always reveals matches
      list.push({ header: true, label: `Unnamed systems (${fmtInt(unnamed.length)})`, collapsed });
      if (!collapsed) list.push(...unnamed);
    }
    filtered = list;
    vlist.setItems(filtered, { keepScroll: true });
    countBadge.textContent = q ? `${fmtInt(src.length)} / ${fmtInt(rows.length)} systems` : `${fmtInt(rows.length)} systems`;
    syncSelectionHighlight();
  }

  function syncSelectionHighlight(): void {
    if (!vlist) return;
    const idx = selected
      ? filtered.findIndex((it) => !('header' in it) && (it as SystemRow).system.slot === selected!.system.slot)
      : -1;
    vlist.setSelectedIndex(idx, { reveal: false });
  }

  function renderRow(item: ListItem, rowEl: HTMLElement): void {
    if ('header' in item) {
      rowEl.classList.add('we-row-header');
      append(rowEl,
        el('span', { class: 'we-row-toggle', text: item.collapsed ? '▸' : '▾' }),
        el('span', { class: 'r-main', text: item.label }));
      return;
    }
    const s = item.system;
    // Two lines: the name gets the full row width on its own line (system
    // names run long and are the primary way a system is found), badges +
    // where-used share a tighter line below.
    append(rowEl, el('div', { class: 'we-row-lines' },
      el('div', { class: 'we-row-top' }, el('span', { class: 'r-main', text: item.label })),
      el('div', { class: 'we-row-bottom' },
        badge(s.loop ? 'loop' : 'timed', s.loop ? 'b-good b-ghost' : 'b-accent b-ghost'),
        item.approximate ? badge('approximate', 'b-warn b-ghost',
          'At least one emitter\'s spawn shape isn\'t classified; the preview falls back to a generic point emission.') : null,
        el('span', {
          class: 'r-meta',
          text: `${fmtInt(s.emitters.length)} em · ${fmtInt(item.rooms.length)} rooms / ${fmtInt(item.modelIds.length)} models`,
        }))));
  }

  // ---- preview -------------------------------------------------------------

  function ensureScene(): void {
    if (scene) return;
    scene = new Scene3D(canvasHost);
    tickOff = scene.addTick((dt: number) => {
      player?.tick(dt, scene!.camera);
      syncTransport();
    });
  }

  // addGround() only ever ADDS helpers; since the preview reframes to a
  // different radius on every selection, the previous grid/axes are disposed
  // first so switching systems can never accumulate stale geometry.
  function resetGround(radius: number): void {
    if (!scene) return;
    const helpers = scene.helpers;
    while (helpers.children.length) {
      const child = helpers.children.pop()! as any;
      child.geometry?.dispose?.();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m: any) => m?.dispose?.()); else mat?.dispose?.();
    }
    scene.addGround(radius, 0);
  }

  function mountPreview(row: SystemRow): void {
    player?.dispose();
    player = null;
    clear(transportHost);
    if (!doc) return;
    ensureScene();
    const radius = estimateSystemRadius(row.system, doc.configs, doc.tick_rate.value);
    resetGround(radius);
    scene!.frameBox([-radius, -radius, -radius], [radius, radius, radius]);
    const p = new EffectsPlayer({
      root: scene!.scene, doc, url: (rel: string) => app.store.url(rel), anisotropy: 8,
    });
    const mode = p.addSystem(row.system.slot);
    player = p;
    buildTransport(row, mode);
    syncDetails(row);
  }

  function buildTransport(row: SystemRow, mode: EffectsPlayerMode | null): void {
    clear(transportHost);
    transportEls = null;
    if (!mode || !player) {
      transportHost.appendChild(el('p', { class: 'dim small', text: 'This system has no emitters to preview.' }));
      return;
    }
    running = true;
    player.setRunning(true);
    const span = estimateSystemSpan(row.system, doc!.configs);
    const scrubMax = Math.max(60, Math.round(span * (row.system.loop ? 3 : 1)));
    const scrub = el('input', { class: 'we-scrub', type: 'range', min: '0', max: String(scrubMax), step: '1', value: '0' });
    const timeLbl = el('span', { class: 'we-time dim small mono' });
    const runBtn = el('button', { class: 'btn btn-mini', text: 'Pause' });
    const syncRunLabel = () => { runBtn.textContent = running ? 'Pause' : 'Play'; };
    runBtn.addEventListener('click', () => {
      running = !running;
      player?.setRunning(running);
      syncRunLabel();
    });
    scrub.addEventListener('input', () => {
      running = false;
      player?.setRunning(false);
      player?.setClock(Number(scrub.value), scene?.camera);
      syncRunLabel();
      syncTransport(true);
    });
    const controls = el('div', { class: 'we-transport-row' }, runBtn, scrub, timeLbl);
    if (mode === 'timed') {
      const once = el('button', { class: 'btn btn-mini', text: '▶ Play once' });
      once.addEventListener('click', () => {
        player?.play(row.system.slot);
        running = true;
        player?.setRunning(true);
        syncRunLabel();
      });
      controls.insertBefore(once, runBtn);
    }
    transportHost.appendChild(controls);
    transportEls = { scrub, timeLbl, max: scrubMax };
    syncTransport(true);
  }

  // Throttled (~6Hz) so scrubbing feedback never fights per-frame DOM writes;
  // `force` bypasses the throttle right after a seek so the bar snaps at once.
  function syncTransport(force = false): void {
    if (!transportEls || !player) return;
    const now = performance.now();
    if (!force && now - lastTransportSync < 150) return;
    lastTransportSync = now;
    const t = player.clock.t;
    const span = transportEls.max;
    const shown = span > 0 ? ((t % span) + span) % span : 0;
    transportEls.scrub.value = String(Math.round(shown));
    transportEls.timeLbl.textContent = `${fmtInt(Math.round(t))} ticks`;
  }

  function syncDetails(row: SystemRow): void {
    clear(detailsHost);
    if (!doc) return;
    const s = row.system;
    const rates = s.emitters
      .map((e) => {
        const cfg = e.burst != null ? doc!.configs[String(e.burst)] : null;
        return cfg && cfg.per_second != null ? `${fmtNum(cfg.per_second, 1)}/s` : null;
      })
      .filter((v): v is string => !!v)
      .join(', ') || '-';
    const swatches = el('div', { class: 'we-swatches' });
    for (const e of s.emitters) {
      for (const c of [e.color0, e.color1]) {
        if (!c) continue;
        const [r, g, b, a] = c.rgba;
        swatches.appendChild(el('span', {
          class: 'we-swatch',
          title: `rgba(${r.toFixed(2)}, ${g.toFixed(2)}, ${b.toFixed(2)}, ${a.toFixed(2)})`,
          style: `background: rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`,
        }));
      }
    }
    const thumbs = el('div', { class: 'we-thumbs' });
    for (const e of s.emitters) {
      const imgId = e.sprite?.images?.[0];
      if (imgId == null) continue;
      // the drawable image, same rule the renderers use (effects-sprite.js)
      const { sub } = spriteDrawOf(e.sprite);
      thumbs.appendChild(el('img', { class: 'we-thumb', loading: 'lazy', src: app.store.url(`images/${pad5(imgId)}_e${sub}.png`) }));
    }
    detailsHost.appendChild(kvTable([
      ['kind', s.loop ? 'loop (ambient)' : 'timed (one-shot)'],
      ['blend', s.blend],
      ['facing', s.facing],
      ['emitters', String(s.emitters.length)],
      ['rates', rates],
      ['colors', swatches.children.length ? swatches : null],
      ['sprites', thumbs.children.length ? thumbs : null],
    ]));

    const nav = el('div', { class: 'we-nav' });
    for (const { room, controller } of row.rooms) {
      const name = roomNames.get(room) || `Room ${room}`;
      const btn = el('button', { class: 'btn btn-mini', text: `View in room: ${name}` });
      btn.addEventListener('click', () => {
        try {
          sessionStorage.setItem('bs.effects.reveal', JSON.stringify({ system: s.slot, controller: controller ?? null }));
        } catch { /* storage unavailable: navigation still works, just no reveal handoff */ }
        location.hash = `#/world/${room}`;
      });
      nav.appendChild(btn);
    }
    for (const modelId of row.modelIds) {
      const name = modelNames.get(modelId) || 'model';
      nav.appendChild(el('a', { class: 'btn btn-mini', href: `#/model/${modelId}`, text: `Used by model: ${name}` }));
    }
    if (nav.children.length) detailsHost.appendChild(nav);
  }

  // ---- shell + boot --------------------------------------------------------

  function buildUI(): void {
    clear(root);
    const titleEl = el('span', { class: 'viewer-title', text: 'Particle effects' });
    countBadge = badge('0 systems', 'b-ghost');
    const toolbar = el('div', { class: 'viewer-toolbar' }, titleEl, countBadge);

    search = el('input', {
      class: 'we-search', type: 'search', placeholder: 'Search systems or rooms…',
      autocomplete: 'off', spellcheck: 'false',
    });
    search.addEventListener('input', debounce(() => applyFilter(), 120));
    const listHost = el('div', { class: 'we-list-host' });
    const left = el('div', { class: 'we-left' }, el('div', { class: 'we-search-row' }, search), listHost);

    canvasHost = el('div', { class: 'canvas-host we-canvas' });
    transportHost = el('div', { class: 'we-transport' });
    detailsHost = el('div', { class: 'we-details' });
    const right = el('div', { class: 'we-right' }, canvasHost, transportHost, detailsHost);

    root.append(toolbar, el('div', { class: 'we-body' }, left, right));

    vlist = new VList<ListItem>({
      host: listHost,
      rowHeight: 48,
      render: renderRow,
      onSelect: (item) => {
        if ('header' in item) { unnamedCollapsed = !unnamedCollapsed; applyFilter(); return; }
        selected = item;
        mountPreview(item);
      },
    });
  }

  (async () => {
    let d: WorldEffectsDoc | null = null;
    try { d = (await app.store.worldEffects?.()) || null; } catch { d = null; }
    if (destroyed) return;
    if (!d || !Array.isArray(d.systems) || !d.systems.length) {
      clear(root);
      root.appendChild(placeholderCard('Effects',
        el('p', { text: 'No effects data for this game version. Add the game files again to enable effects.' })));
      return;
    }
    doc = d;
    const [meta, join] = await Promise.all([loadWorldMeta(app), loadModelJoin(app)]);
    if (destroyed) return;
    roomNames = meta.roomNames;
    textures = meta.textures;
    modelNames = join.nameById;
    rows = buildIndex(doc, roomNames, join.byOwner, join.nameById);

    buildUI();
    applyFilter();
    const first = filtered.find((it) => !('header' in it)) as SystemRow | undefined;
    if (first) {
      selected = first;
      syncSelectionHighlight();
      mountPreview(first);
    }
  })();

  return view;
}

export default createEffectsBrowserView;
