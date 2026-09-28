// Each tool's page: the markup its code finds by id when it mounts (tool.ts), drawn once and never again by
// React (memo, no props), so the tool owns everything inside it from then on. Also each tool's own part of
// the top bar, drawn the same way.
import { memo } from 'react';

export const DataPage = memo(() => (
  <div id="app">
    <div id="body">
      <nav id="sidebar">
        <div id="cat-tabs"></div>
        <div id="list-tools">
          <input id="list-filter" type="search" placeholder="Search…" autoComplete="off" spellCheck={false} title="Search this list by id, content hash, or friendly name" />
          <div className="sort-row">
            <select id="list-sort" title="Sort the list" hidden></select>
            <button id="list-sort-dir" title="Sort direction" hidden></button>
          </div>
          <div id="list-chips"></div>
        </div>
        <div id="list-host"></div>
      </nav>
      <main id="main">
        <div id="banners"></div>
        <div id="viewer"></div>
      </main>
      <aside id="details">
        <div className="details-head">
          <span id="details-title">Details</span>
          <button id="raw-toggle" className="btn btn-mini" title="Toggle raw JSON">raw</button>
        </div>
        <div id="details-body"></div>
      </aside>
    </div>
    <footer id="statusbar">
      <span id="status-left"></span>
      <span id="status-mid"></span>
      <span id="status-right" className="mono"></span>
    </footer>
  </div>
));

/** Brighter Data's parts of the top bar: its search (the middle) and its own buttons (the right). */
export const DataSearch = memo(() => (
  <div className="searchwrap">
    <input id="global-search" type="text" placeholder="Search everything…  ( / )" autoComplete="off" spellCheck={false} />
    <div id="search-results" className="search-results" hidden></div>
  </div>
));
export const DataButtons = memo(() => (
  <>
    <button id="export-btn" className="btn-mini" title="Bulk export: write the decoded asset tree (JSON/PNG/WAV) to a folder on disk or a .zip" hidden>⭳ Bulk Export</button>
    <button id="overrides-btn" className="btn-mini" title="Annotations: friendly names, saved Models + any by-hand texture reassignments. Preview / load (replace) / export JSON">Manage Overrides</button>
    <span id="data-source" className="mono dim"></span>
  </>
));

export const MapsPage = memo(() => (
  <div id="world" className="world">
    <div className="map-toolbar world-toolbar">
      <div className="world-pick">
        <button id="world-prev" className="btn" type="button" aria-label="Previous update" title="Previous update">‹</button>
        <button id="world-release" className="btn world-release" type="button" aria-haspopup="dialog" aria-controls="world-picker" title="Choose a game update">Loading...</button>
        <button id="world-next" className="btn" type="button" aria-label="Next update" title="Next update">›</button>
      </div>
      <div className="world-slider">
        <div id="world-ticks" className="world-ticks" aria-hidden="true"></div>
        <input id="world-date" type="range" min="0" max="1" step="1" defaultValue="1" aria-label="Game update date" />
        <div id="world-bubble" className="world-bubble" aria-hidden="true"></div>
      </div>
    </div>
    <div className="map-canvas-host world-map">
      <canvas id="world-satellite" className="world-satellite" aria-hidden="true"></canvas>
      <canvas id="world-canvas" tabIndex={0} aria-label="World map. Drag to pan, pinch or scroll to zoom."></canvas>
      <canvas id="world-fog" className="world-fog" aria-hidden="true"></canvas>
      <div id="world-sealed" className="world-sealed"></div>
      <div className="wmap-corner">
        <button id="world-view" className="wmap-view" type="button" aria-pressed="false" title="Show satellite pictures" hidden>
          <canvas id="world-view-thumb" className="wmap-thumb" aria-hidden="true"></canvas><span id="world-view-name">Satellite</span>
        </button>
        <label className="wmap-labels" title="Show room labels"><input id="world-labels" type="checkbox" defaultChecked /><span>Labels</span></label>
        <label id="world-roofs-switch" className="wmap-labels" title="Show roofs (off: see inside the buildings)" hidden><input id="world-roofs" type="checkbox" defaultChecked /><span>Roofs</span></label>
      </div>
      <div className="wmap-zoom" role="group" aria-label="Zoom">
        <button id="world-zoom-in" type="button" aria-label="Zoom in" title="Zoom in"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button>
        <button id="world-zoom-out" type="button" aria-label="Zoom out" title="Zoom out"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg></button>
      </div>
      <p id="world-note" className="world-note" role="status"></p>
      <LoadCard id="world-loading" textId="world-loading-text" />
      <p id="world-status" className="world-status" role="status"></p>
    </div>
    <div id="world-picker" className="world-picker" role="dialog" aria-modal="true" aria-label="Choose a game update" hidden>
      <div className="world-picker-card">
        <div className="world-picker-head">
          <input id="world-search" type="search" placeholder="Search updates, for example 0.99 or Sep 2026" aria-label="Search game updates" autoComplete="off" />
          <button id="world-picker-close" className="btn" type="button" aria-label="Close">×</button>
        </div>
        <ul id="world-list" className="world-list"></ul>
      </div>
    </div>
  </div>
));

/** The load card every page shows (Fashion builds its own the same way): a ring, a name, how far. */
export const LoadCard = ({ id, textId }: { id: string; textId: string }) => (
  <div id={id} className="load-card spin" role="status" hidden>
    <svg viewBox="0 0 44 44" aria-hidden="true"><circle className="pl-track" cx="22" cy="22" r="19" /><circle className="pl-fill" cx="22" cy="22" r="19" /></svg>
    <span id={textId} className="pl-name">Loading</span><span className="pl-pct"></span>
  </div>
);

const Ic = ({ d, children }: { d?: string; children?: React.ReactNode }) => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">{d ? <path d={d} /> : children}</svg>;

export const FashionPage = memo(() => (
  <div id="fashion" className="fashion">
    <div id="of-toolbar" className="of-toolbar" hidden>
      <button id="undo" className="btn-mini of-icon" title="Undo (Ctrl+Z)" aria-label="Undo"><Ic d="M9 7H4V2M4 7a9 9 0 1 1-1.5 9" /></button>
      <button id="redo" className="btn-mini of-icon" title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Ic d="M15 7h5V2M20 7a9 9 0 1 0 1.5 9" /></button>
      <button id="shot" className="btn-mini of-icon-sm" title="Save the view as a picture" aria-label="Save picture"><Ic><path d="M4 7h3l2-3h6l2 3h3v13H4z" /><circle cx="12" cy="13" r="4" /></Ic><span>Save picture</span></button>
      <button id="share" className="btn-mini of-share" title="Your looks: save this one, wear a saved one, share a link" aria-haspopup="dialog"><Ic d="M6 3h12v18l-6-4-6 4z" /><span>Looks</span></button>
    </div>
    <main></main>
    <div className="of-rotate" role="alert"><Ic><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></Ic><b>Turn your phone upright</b><span>Brighter Fashion is made for holding your phone this way up.</span></div>
    <div id="toast" role="status" aria-live="polite"></div>
  </div>
));

/** Brighter Fashion's part of the top bar: the game update its clothes come from. */
export const FashionTopbar = memo(() => (
  <span id="game-build" className="of-gamebuild mono of-exp" title="The game update these clothes and faces come from"></span>
));
