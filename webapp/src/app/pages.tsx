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

// (the world map's layout before its code: its bar and its map; the controls come with the map, WorldMap.tsx)
export const MapsPage = memo(() => (
  <div id="world" className="world">
    <div className="map-toolbar world-toolbar" />
    <div className="map-canvas-host world-map" />
  </div>
));

/** The loader every page shows (Fashion builds its own the same way): a ring alone, what it loads its label. */
export const LoadCard = ({ id, label, hidden = true }: { id: string; label: string; hidden?: boolean }) => (
  <div id={id} className="load-card spin" role="status" aria-label={label} hidden={hidden}>
    <svg viewBox="0 0 44 44" aria-hidden="true"><circle className="pl-track" cx="22" cy="22" r="19" /><circle className="pl-fill" cx="22" cy="22" r="19" /></svg>
  </div>
);

const Ic = ({ d, children }: { d?: string; children?: React.ReactNode }) => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">{d ? <path d={d} /> : children}</svg>;

// (a phone's divider where Fashion will put it, read from what it remembers: the view's share of the height, or the
// whole height with the drawer folded away, so the drawer does not move when the character arrives)
const fashionView = (): React.CSSProperties | undefined => {
  try {
    if (!matchMedia('(max-width: 860px)').matches) return undefined;
    if (localStorage.getItem('fashion.panel') === '1') return { flex: '1 1 auto' };
    const s = Number(localStorage.getItem('fashion.split'));
    return s ? { flex: `0 0 ${(Math.max(0.22, Math.min(0.72, s)) * 100).toFixed(3)}%` } : undefined;
  } catch { return undefined; }
};

export const FashionPage = memo(() => (
  <div id="fashion" className="fashion">
    <div id="of-toolbar" className="of-toolbar" hidden>
      <button id="undo" className="btn-mini of-icon" title="Undo (Ctrl+Z)" aria-label="Undo"><Ic d="M9 7H4V2M4 7a9 9 0 1 1-1.5 9" /></button>
      <button id="redo" className="btn-mini of-icon" title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Ic d="M15 7h5V2M20 7a9 9 0 1 0 1.5 9" /></button>
      <button id="share" className="btn-mini of-share" title="Your looks: save this one, wear a saved one, share a link" aria-haspopup="dialog"><Ic d="M6 3h12v18l-6-4-6 4z" /><span>Looks</span></button>
    </div>
    {/* the layout before the code: the view and the equipment panel, replaced by the real ones on mount */}
    <main><div className="ph ph-view" style={fashionView()} /><div className="ph ph-panel" /></main>
    <div className="of-rotate" role="alert"><Ic><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></Ic><b>Turn your phone upright</b><span>Brighter Fashion is made for holding your phone this way up.</span></div>
    <div id="toast" role="status" aria-live="polite"></div>
  </div>
));

/** Brighter Fashion's part of the top bar: the game update its clothes come from. */
export const FashionTopbar = memo(() => (
  <span id="game-build" className="of-gamebuild mono of-exp" title="The game update these clothes and faces come from"></span>
));
