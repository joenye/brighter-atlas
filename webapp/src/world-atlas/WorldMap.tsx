// The world map (Brighter Maps, /maps): the 2D map of every game release, no game files needed. Pick a release
// from the list or slide through the dates; the camera stays put so the world can be watched changing. Like a
// street map it can show satellite pictures instead: the rooms seen from straight above, the labels over them.
// The state lives in the address (#r=<release id or YYYY-MM-DD>&c=<x>,<y>,<scale>&l=0&v=satellite&roofs=0
// &ui=0) and window.__world drives it from a script (a time-lapse capture). The drawing is engine.ts's.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createWorldData, type WorldMap as WorldMapData, type WorldRelease } from './data.js';
import { MapView } from './engine.js';
import { gameVersion } from '../game-build.js';
import { LoadCard } from '../app/pages.js';
import type { ToolProps } from '../app/tool.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateOf = (r: WorldRelease) => new Date(r.date);
const minutes = (r: WorldRelease) => Math.round(dateOf(r).getTime() / 60000);
// every update as the viewer writes dates (21-Sep-2026), with its UTC time
const dateText = (r: WorldRelease) => {
  const d = dateOf(r), p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
};
// with the game's own version after the date when the data has it: "21-Sep-2026 15:20 UTC (v0.99.3)"
const releaseText = (r: WorldRelease) => { const v = gameVersion(r.build); return v ? `${dateText(r)} (v${v})` : dateText(r); };
/** The release in force at a date: the last one on or before it. */
const nearest = (releases: WorldRelease[], value: number) => { let pick = releases[0]; for (const r of releases) if (minutes(r) <= value) pick = r; return pick; };

export function Tool({ active, ready, register }: ToolProps) {
  const els = {
    host: useRef<HTMLDivElement>(null), canvas: useRef<HTMLCanvasElement>(null), satellite: useRef<HTMLCanvasElement>(null),
    fog: useRef<HTMLCanvasElement>(null), sealed: useRef<HTMLDivElement>(null), thumb: useRef<HTMLCanvasElement>(null),
    slider: useRef<HTMLInputElement>(null), release: useRef<HTMLButtonElement>(null), search: useRef<HTMLInputElement>(null), list: useRef<HTMLUListElement>(null),
  };
  const data = useMemo(() => createWorldData(), []);
  const view = useRef<MapView | null>(null);
  const [releases, setReleases] = useState<WorldRelease[]>([]);
  const [wanted, setWanted] = useState<WorldRelease | null>(null);     // the release asked for
  const [current, setCurrent] = useState<WorldMapData | null>(null);   // the release shown
  const [loading, setLoading] = useState<string | null>(null);         // an update on its way (after the first)
  const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false });
  const [labels, setLabels] = useState(true), [roofs, setRoofs] = useState(true), [satelliteView, setSatelliteView] = useState(false);
  const [bare, setBare] = useState(false);
  const [picking, setPicking] = useState(false), [search, setSearch] = useState('');
  const [pictures, setPictures] = useState(false);   // the satellite layer holds the shown release's pictures
  const [known, setKnown] = useState(false);         // the site's updates are known (the corner switch keeps its place until then)
  const [dragging, setDragging] = useState(false), [slider, setSlider] = useState<number | null>(null);
  // (what the async work and the listeners read: the latest, not the render's)
  const live = useRef({ releases, wanted, labels, roofs, satelliteView, active, shown: null as WorldRelease | null, opened: false, cameraFromUrl: false, refit: false, prefetching: false });
  Object.assign(live.current, { releases, wanted, labels, roofs, satelliteView, active });

  const roofless = (r: WorldRelease, withRoofs = live.current.roofs) => !withRoofs && !!r.satelliteRoofless;
  const pictureKey = (r: WorldRelease, withRoofs = live.current.roofs) => `${r.id}:${roofless(r, withRoofs) ? 'roofless' : 'roofs'}`;

  // ---- the address ----
  const saveTimer = useRef(0);
  const saveState = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const { wanted: w, labels: l, satelliteView: sat, roofs: rf } = live.current, cam = view.current?.camera;
      if (!w || !cam) return;
      const parts = [`r=${w.id}`, `c=${cam.cx.toFixed(2)},${cam.cy.toFixed(2)},${cam.scale.toFixed(4)}`];
      if (!l) parts.push('l=0');
      if (sat) parts.push('v=satellite');
      if (!rf) parts.push('roofs=0');
      if (document.getElementById('world')?.classList.contains('bare')) parts.push('ui=0');
      history.replaceState(null, '', `#${parts.join('&')}`);
    }, 250);
  }, []);
  /** The address's view (switches and camera), and the release it names. */
  const readState = useCallback((): WorldRelease => {
    const q = new URLSearchParams(location.hash.slice(1)), all = live.current.releases, v = view.current!;
    const l = q.get('l') !== '0', sat = q.get('v') === 'satellite', rf = q.get('roofs') !== '0';
    Object.assign(live.current, { labels: l, satelliteView: sat, roofs: rf });
    setLabels(l); setSatelliteView(sat); setRoofs(rf); setBare(q.get('ui') === '0');
    v.labels = l; v.satelliteView = sat;
    const c = q.get('c')?.split(',').map(Number);
    if (c?.length === 3 && c.every(Number.isFinite) && c[2] > 0) { [v.camera.cx, v.camera.cy, v.camera.scale] = c; live.current.cameraFromUrl = true; }
    const r = q.get('r');
    if (r) {
      const byId = all.find((x) => x.id.startsWith(r));
      if (byId) return byId;
      const t = Date.parse(r);   // a date: the update in force then
      if (Number.isFinite(t)) return nearest(all, Math.round(t / 60000) + 24 * 60 - 1);
    }
    return all.at(-1)!;
  }, []);

  // ---- showing a release: at once when its data is here, else once it arrives (a newer request made meanwhile wins) ----
  const syncSatellite = useCallback(async (release: WorldRelease) => {
    const v = view.current!, key = pictureKey(release);
    if (v.satelliteFor === key) { v.setShownKey(key); setPictures(true); return; }
    const source = await data.satellite(release, !roofless(release)).catch(() => null);
    if (live.current.wanted !== release || key !== pictureKey(release)) return;
    // (none, or its index failed to load: asked again the next time this update shows)
    v.setSatellite(source, key); v.setShownKey(key); setPictures(!!source);
  }, []);
  const show = useCallback(async (release: WorldRelease): Promise<void> => {
    live.current.wanted = release; setWanted(release);
    if (els.slider.current) els.slider.current.value = String(minutes(release));
    setSlider(minutes(release));
    if (!data.ready(release) && live.current.opened) setLoading(releaseText(release));
    try {
      const map = await data.map(release);
      const v = view.current;
      if (live.current.wanted !== release || !v) return;
      const fit = (!v.renderer && !live.current.cameraFromUrl) || live.current.refit;
      live.current.refit = false;
      v.setMap(map, pictureKey(release), fit); live.current.shown = release;
      setCurrent(map); setLoading(null); setStatus({ text: '', error: false }); setPictures(v.satelliteFor === pictureKey(release));
      const root = document.documentElement.dataset;   // tests and scripts read the counts here
      root.rooms = String(map.doc.scene.rooms.length);
      root.wip = map.sealed.map((a) => a.name).join(', ');
      saveState();
      void syncSatellite(release);
      root.release = release.id;
    } catch (e) {
      if (live.current.wanted === release) { setLoading(null); setStatus({ text: `This update could not be loaded: ${(e as Error).message}`, error: true }); }
    }
  }, []);
  const step = (by: number) => {
    const all = live.current.releases, i = Math.max(0, Math.min(all.length - 1, all.indexOf(live.current.wanted!) + by));
    void show(all[i]);
  };

  // ---- start: the engine on the page's elements, the updates, the address's view ----
  useLayoutEffect(() => {
    const v = view.current = new MapView({
      host: els.host.current!, canvas: els.canvas.current!, satellite: els.satellite.current!, fog: els.fog.current!,
      sealed: els.sealed.current!, thumb: els.thumb.current!,
    }, saveState);
    // Safari's own pinch zoom (its gesture events) would zoom the whole page: the map does its own pinch
    const noGesture = (e: Event) => { if (live.current.active) e.preventDefault(); };
    for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, noGesture, { passive: false });
    // a new address (typed, or set by a script) applies at once; the page's own updates use replaceState
    const onHash = () => {
      if (!live.current.active || !live.current.releases.length) return;
      const r = readState();
      if (r !== live.current.wanted) void show(r); else { v.requestDraw(); saveState(); }
    };
    addEventListener('hashchange', onHash);
    let gone = false;
    (async () => {
      try {
        const manifest = await data.manifest();
        if (gone) return;
        const all = [...manifest.releases].sort((a, b) => a.date.localeCompare(b.date));
        live.current.releases = all; setReleases(all); setKnown(true);
        await show(readState());
      } catch (e) {
        setStatus({ text: (e as Error).message, error: true }); setKnown(true);
      }
      live.current.opened = true; ready();
    })();
    // (for scripts, a time-lapse capture: the releases, and show() resolving once the release is drawn)
    const api = {
      releases: () => live.current.releases.map((r) => ({ id: r.id, date: r.date, label: r.label, build: r.build ?? null })),
      async show(id: string) {
        const r = live.current.releases.find((x) => x.id === id || x.id.startsWith(id));
        if (!r) throw Error(`no release ${id}`);
        await show(r); v.draw(); await new Promise((resolve) => requestAnimationFrame(resolve));
        return live.current.shown === r;
      },
      camera: v.camera,
      get current() { return live.current.wanted?.id ?? null; },
      /** Map or satellite view: set it, or read it with no argument. */
      satellite(on?: boolean) { if (on !== undefined) setSatellite(!!on); return live.current.satelliteView; },
    };
    (window as any).__world = api;
    // Maps picked in the tool switch: back to the latest update and the whole world, without a reload
    register({
      current() {
        const all = live.current.releases;
        if (!all.length) { location.reload(); return; }
        const latest = all.at(-1)!;
        setLabels(true); live.current.labels = true; v.labels = true;
        if (latest === live.current.wanted) v.fit(); else { live.current.cameraFromUrl = false; live.current.refit = true; void show(latest); }
      },
    });
    return () => {
      gone = true; clearTimeout(saveTimer.current);
      for (const type of ['gesturestart', 'gesturechange']) document.removeEventListener(type, noGesture);
      removeEventListener('hashchange', onHash);
      v.destroy(); view.current = null;
      if ((window as any).__world === api) delete (window as any).__world;
    };
  }, []);

  // back on the page: the address may name another place, as the browser's back and forward do
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && view.current && live.current.releases.length) {
      if (location.hash.length > 1) { const r = readState(); if (r !== live.current.wanted) void show(r); else view.current.requestDraw(); }
      else { saveState(); view.current.requestDraw(); }
    }
    wasActive.current = active;
  }, [active]);

  // ---- the switches ----
  const setSatellite = (on: boolean) => {
    if (live.current.satelliteView === on) return;
    live.current.satelliteView = on; setSatelliteView(on);
    const v = view.current!; v.satelliteView = on; v.requestDraw(); saveState();
  };
  useEffect(() => { const v = view.current; if (v) { v.labels = labels; v.requestDraw(); } }, [labels]);
  useEffect(() => { const w = live.current.wanted; if (w && view.current) void syncSatellite(w); }, [roofs]);
  const hasPictures = !!current?.release.satellite;
  const offered = known && data.hasSatellite();
  useEffect(() => { if (view.current) { view.current.thumbShown = offered; view.current.requestDraw(); } }, [offered, satelliteView, pictures]);

  // ---- the slider: native listeners (a script sets its value and fires input, as a hand does) ----
  useEffect(() => {
    const s = els.slider.current!;
    const onInput = () => {
      const all = live.current.releases; if (!all.length) return;
      setSlider(Number(s.value));
      const r = nearest(all, Number(s.value));
      if (r !== live.current.wanted) void show(r);
      if (!live.current.prefetching) { live.current.prefetching = true; void data.prefetch(); }   // scrubbing: fetch the rest of history once
    };
    const onChange = () => { const w = live.current.wanted; if (w) { s.value = String(minutes(w)); setSlider(minutes(w)); } };
    const down = () => setDragging(true), up = () => setDragging(false);
    s.addEventListener('input', onInput); s.addEventListener('change', onChange);
    for (const e of ['pointerdown', 'touchstart']) s.addEventListener(e, down, { passive: true });
    for (const e of ['pointerup', 'pointercancel', 'touchend', 'blur']) s.addEventListener(e, up);
    return () => {
      s.removeEventListener('input', onInput); s.removeEventListener('change', onChange);
      for (const e of ['pointerdown', 'touchstart']) s.removeEventListener(e, down);
      for (const e of ['pointerup', 'pointercancel', 'touchend', 'blur']) s.removeEventListener(e, up);
    };
  }, []);
  const lo = releases.length ? minutes(releases[0]) : 0, hi = releases.length ? minutes(releases.at(-1)!) : 1, span = Math.max(1, hi - lo);
  const frac = slider != null && hi > lo ? (slider - lo) / (hi - lo) : 1;
  const bubble = releases.length && slider != null ? releaseText(nearest(releases, slider)) : '';
  const years: number[] = [];
  if (releases.length) for (let y = dateOf(releases[0]).getUTCFullYear() + 1; y <= dateOf(releases.at(-1)!).getUTCFullYear(); y++) years.push(y);

  // ---- the picker ----
  const openPicker = () => { setSearch(''); setPicking(true); };
  const closePicker = () => { setPicking(false); els.release.current?.focus(); };
  const pick = (r: WorldRelease) => { closePicker(); void show(r); };
  useEffect(() => {
    if (!picking) return;
    els.search.current?.focus();
    els.list.current?.querySelector('.current')?.scrollIntoView({ block: 'center' });
  }, [picking]);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = picking ? [...releases].reverse().filter((r) => {
    const text = `${releaseText(r)} ${r.build ?? ''} ${r.label ?? ''} ${r.date.slice(0, 10)} ${r.id}`.toLowerCase();
    return words.every((w) => text.includes(w));
  }) : [];

  const i = wanted ? releases.indexOf(wanted) : -1;
  const note = satelliteView && current && !hasPictures ? 'No satellite pictures of this update yet: showing the street map.' : '';
  return (
    <div id="world" className={`world${satelliteView ? ' satellite' : ''}${bare ? ' bare' : ''}`}>
      <div className="map-toolbar world-toolbar">
        <div className="world-pick">
          <button id="world-prev" className="btn" type="button" aria-label="Previous update" title="Previous update" disabled={i <= 0} onClick={() => step(-1)}>‹</button>
          <button ref={els.release} id="world-release" className="btn world-release" type="button" aria-haspopup="dialog" aria-controls="world-picker" title="Choose a game update"
            onClick={openPicker}>{wanted ? releaseText(wanted) : status.error ? 'Unavailable' : ' '}</button>
          <button id="world-next" className="btn" type="button" aria-label="Next update" title="Next update" disabled={i < 0 || i >= releases.length - 1} onClick={() => step(1)}>›</button>
        </div>
        <div className={`world-slider${dragging ? ' dragging' : ''}`} style={{ '--pos': `calc(9px + (100% - 18px) * ${frac})`, '--frac': String(frac) } as React.CSSProperties}>
          <div id="world-ticks" className="world-ticks" aria-hidden="true">
            {releases.map((r) => <span key={r.id} style={{ left: `${((minutes(r) - lo) / span) * 100}%` }} />)}
            {years.map((y) => <span key={y} className="year" data-year={y} style={{ left: `${((Date.UTC(y, 0, 1) / 60000 - lo) / span) * 100}%` }} />)}
          </div>
          <input ref={els.slider} id="world-date" type="range" min={lo} max={hi} step="1" defaultValue="1" aria-label="Game update date" />
          <div id="world-bubble" className="world-bubble" aria-hidden="true">{bubble}</div>
        </div>
      </div>
      <div ref={els.host} className={`map-canvas-host world-map${loading && current ? ' loading' : ''}`}>
        <canvas ref={els.satellite} id="world-satellite" className="world-satellite" aria-hidden="true"></canvas>
        <canvas ref={els.canvas} id="world-canvas" tabIndex={0} aria-label="World map. Drag to pan, pinch or scroll to zoom."></canvas>
        <canvas ref={els.fog} id="world-fog" className="world-fog" aria-hidden="true"></canvas>
        <div ref={els.sealed} id="world-sealed" className="world-sealed"></div>
        <div className="wmap-corner">
          {/* (its place is kept from the first frame, the map's other controls never moving when it comes) */}
          <button id="world-view" className={`wmap-view${known ? '' : ' pending'}`} type="button" hidden={known && !offered}
            aria-pressed={satelliteView} disabled={!satelliteView && !hasPictures} onClick={() => setSatellite(!satelliteView)}
            title={satelliteView ? 'Show the street map' : hasPictures ? 'Show satellite pictures' : 'No satellite pictures of this update yet'}>
            <canvas ref={els.thumb} id="world-view-thumb" className="wmap-thumb" aria-hidden="true"></canvas><span id="world-view-name">{satelliteView ? 'Street' : 'Satellite'}</span>
          </button>
          <label className="wmap-labels" title="Show room labels">
            <input id="world-labels" type="checkbox" checked={labels} onChange={(e) => { setLabels(e.target.checked); live.current.labels = e.target.checked; saveState(); }} /><span>Labels</span>
          </label>
          <label id="world-roofs-switch" className="wmap-labels" title="Show roofs (off: see inside the buildings)" hidden={!satelliteView || !current?.release.satelliteRoofless}>
            <input id="world-roofs" type="checkbox" checked={roofs} onChange={(e) => { setRoofs(e.target.checked); live.current.roofs = e.target.checked; saveState(); }} /><span>Roofs</span>
          </label>
        </div>
        <div className="wmap-zoom" role="group" aria-label="Zoom">
          <button id="world-zoom-in" type="button" aria-label="Zoom in" title="Zoom in" onClick={() => view.current?.zoomBy(2)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button>
          <button id="world-zoom-out" type="button" aria-label="Zoom out" title="Zoom out" onClick={() => view.current?.zoomBy(0.5)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg></button>
        </div>
        <p id="world-note" className="world-note" role="status">{note}</p>
        <LoadCard id="world-loading" label={loading ? `Loading the map of ${loading}` : 'Loading the map'} hidden={!loading} />
        <p id="world-status" className={`world-status${status.error ? ' error' : ''}`} role="status">{status.text}</p>
      </div>
      <div id="world-picker" className="world-picker" role="dialog" aria-modal="true" aria-label="Choose a game update" hidden={!picking}
        onClick={(e) => { if (e.target === e.currentTarget) closePicker(); }} onKeyDown={(e) => { if (e.key === 'Escape') closePicker(); }}>
        <div className="world-picker-card">
          <div className="world-picker-head">
            <input ref={els.search} id="world-search" type="search" placeholder="Search updates, for example 0.99 or Sep 2026" aria-label="Search game updates" autoComplete="off"
              value={search} onChange={(e) => setSearch(e.target.value)}
              // Enter picks the first match (without preventDefault the same key would then click the release button
              // that gets the focus back)
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (matches[0]) pick(matches[0]); } }} />
            <button id="world-picker-close" className="btn" type="button" aria-label="Close" onClick={closePicker}>×</button>
          </div>
          <ul ref={els.list} id="world-list" className="world-list">
            {matches.length ? matches.map((r) => {
              const version = gameVersion(r.build);
              return (
                <li key={r.id}>
                  <button type="button" className={r === wanted ? 'current' : undefined} title={version ? r.build! : undefined} onClick={() => pick(r)}>
                    <span>{dateText(r)}{version && <>{' '}<b>{`(v${version})`}</b></>}</span><span className="when">{r.id.slice(0, 8)}</span>
                  </button>
                </li>
              );
            }) : <li className="empty">No update matches.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
