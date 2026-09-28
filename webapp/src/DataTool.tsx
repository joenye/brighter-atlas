// Brighter Data (/data): the viewer for the visitor's own game files. The page's chrome is drawn here from the
// app's state (main.ts App: the category tabs, the list's tools and filters, the details panel, the banners and
// the status bar); the list itself (a virtual list) and each category's viewer are the app's own, in the hosts
// this page gives them.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { App, CATS, CAT_SORTS, boot, parseHash } from './main.js';
import { maybeShowMobileNotice } from './mobile-gate.js';
import { el, rawJson, clear } from './ui.js';
import type { ToolProps } from './app/tool.js';

// (the chrome before the app has booted: the same page, nothing in it yet; the app then finds its hosts on it)
const EMPTY_UI: App['ui'] = { cat: null, sort: 'index', sortDir: 'asc', filters: new Set(), banners: [], details: null, rawMode: false, status: ['', '', ''], statusError: null };
const noSubscribe = () => () => {};
const noSnapshot = () => 0;

export function Tool({ active, ready, register }: ToolProps) {
  const root = useRef<HTMLDivElement>(null);
  const [app, setApp] = useState<App | null>(null);
  const isActive = useRef(active); isActive.current = active;
  useLayoutEffect(() => {
    // Phones get the app, with a dialog over it once per visit saying it is built for desktop (and where to go
    // on a phone instead)
    maybeShowMobileNotice(root.current!);
    const abort = new AbortController();
    let gone = false, made: App | null = null;
    void boot({ active: () => isActive.current, ready, signal: abort.signal }).then((a) => {
      if (gone) return;
      made = a; setApp(a);
      register({ current() { location.hash = ''; } });
    });
    return () => { gone = true; abort.abort(); made?.destroy(); };
  }, []);
  // hidden: its viewer goes (nothing draws); shown: the address's route, mounted again. Without game files
  // the viewer holds the onboarding, which stays as it is (what the visitor picked so far included)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!app) return;
    if (active) void app.applyRoute(parseHash(location.hash));
    else if (app.store.manifest) { app.view?.destroy(); app.view = null; clear(app.viewerEl); }
  }, [active, app]);
  return <Chrome app={app} rootRef={root} />;
}

function Chrome({ app, rootRef }: { app: App | null; rootRef: React.RefObject<HTMLDivElement | null> }) {
  useSyncExternalStore(app?.subscribe ?? noSubscribe, app?.snapshot ?? noSnapshot);
  const ui = app?.ui ?? EMPTY_UI;
  const sorts = ui.cat ? CAT_SORTS[ui.cat] : undefined;
  const filterDefs = app && ui.cat ? app.catFilters(ui.cat) : [];
  return <Page ui={ui} tabs={app ? app.tabs() : []} sorts={sorts} filterDefs={filterDefs} app={app} rootRef={rootRef} />;
}

function Page({ ui, tabs, sorts, filterDefs, app, rootRef }: { ui: App['ui']; tabs: ReturnType<App['tabs']>; sorts: typeof CAT_SORTS[string] | undefined; filterDefs: ReturnType<App['catFilters']>; app: App | null; rootRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div id="app" ref={rootRef}>
      <div id="body">
        <nav id="sidebar">
          <div id="cat-tabs">
            {tabs.map((t) => (
              <div key={t.key} className="cat-tab-row">
                <button className={`cat-tab${t.key === ui.cat ? ' active' : ''}`} data-cat={t.key} onClick={() => app?.openTab(t.key)}>
                  <span className="ct-icon">{t.icon}</span><span className="ct-name">{t.label}</span>
                  <span className={`ct-count${t.partial ? ' partial' : ''}`} title={t.partial ? `${t.exportedText} of ${t.countText} exported` : ''}>{t.countText}</span>
                </button>
                {/* "?" opens the category overview (the id-less route): a sibling of the tab, each independently
                    focusable, reached without restoring the last item, so a tab click still reopens it */}
                <button className="ct-help" type="button" title={`What's in ${t.label}? Open the overview`} aria-label={`About ${t.label}`} onClick={() => { location.hash = t.overviewHash; }}>?</button>
              </div>
            ))}
          </div>
          <div id="list-tools">
            <input id="list-filter" type="search" placeholder="Search…" autoComplete="off" spellCheck={false} title="Search this list by id, content hash, or friendly name" />
            <div className="sort-row">
              <select id="list-sort" title="Sort the list" hidden={!sorts} value={ui.sort} onChange={(e) => app?.setSort(e.target.value)}>
                {sorts?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button id="list-sort-dir" hidden={!sorts} title={`Sort direction: ${ui.sortDir === 'desc' ? 'descending' : 'ascending'} (click to flip)`} onClick={() => app?.flipSortDir()}>{ui.sortDir === 'desc' ? '↓' : '↑'}</button>
            </div>
            <div id="list-chips">
              {filterDefs.length > 0 && (
                // checkbox-dropdown filter for the current category (facets AND, episodes OR; see matchesFilters), made
                // afresh (closed) for each category
                <details key={ui.cat ?? ''} className="filter-dd">
                  <summary title="Match all selected filters. Multiple episodes include rooms from any selected episode.">{ui.filters.size ? `Filter · ${ui.filters.size}` : 'Filter'}</summary>
                  <div className="filter-panel">
                    {filterDefs.map(([label, , tip]) => (
                      <label key={label} className="filter-opt" title={tip || undefined}>
                        <FilterCheck on={ui.filters.has(label)} onToggle={(on) => app?.setFilter(label, on)} /><span>{label}</span>
                      </label>
                    ))}
                    <button className="filter-clear" onClick={() => app?.clearFilters()}>clear all</button>
                  </div>
                </details>
              )}
            </div>
          </div>
          <div id="list-host"></div>
        </nav>
        <main id="main">
          <div id="banners">
            {ui.banners.map((b) => (
              <div key={b.msg} className={`banner ${b.kind}`}><span>{b.msg}</span><button className="bn-close" onClick={() => app?.dismissBanner(b.msg)}>✕</button></div>
            ))}
          </div>
          <div id="viewer"></div>
        </main>
        <aside id="details">
          <div className="details-head">
            <span id="details-title">{ui.details?.title || 'Details'}</span>
            <button id="raw-toggle" className={`btn btn-mini${ui.rawMode ? ' active' : ''}`} title="Toggle raw JSON" onClick={() => app?.toggleRaw()}>raw</button>
          </div>
          <DetailsBody details={ui.details} rawMode={ui.rawMode} />
        </aside>
      </div>
      <footer id="statusbar">
        <span id="status-left">{ui.status[0]}</span>
        <span id="status-mid">{ui.statusError ? <span className="err">⚠ {ui.statusError.slice(0, 80)}</span> : ui.status[1]}</span>
        <span id="status-right" className="mono">{ui.status[2]}</span>
      </footer>
    </div>
  );
}

/** A filter's box: the box itself (not React's controlled one, which puts a click's toggle back before the
 *  change event tells of it), set from the app's filters and telling the app of every change, a script's too. */
function FilterCheck({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const latest = useRef(onToggle); latest.current = onToggle;
  useLayoutEffect(() => { ref.current!.checked = on; }, [on]);
  useEffect(() => { const cb = ref.current!; const h = () => latest.current(cb.checked); cb.addEventListener('change', h); return () => cb.removeEventListener('change', h); }, []);
  return <input ref={ref} type="checkbox" />;
}

/** The details panel's body: what the app built for the selection (ui.ts el), or its raw JSON. */
function DetailsBody({ details, rawMode }: { details: App['ui']['details']; rawMode: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = ref.current!;
    if (!details) { body.replaceChildren(el('div', { class: 'center-note small', text: 'Nothing selected.' })); return; }
    if (rawMode && details.raw != null) { body.replaceChildren(rawJson(details.raw)); return; }
    body.replaceChildren(...[details.node ?? (details.raw != null ? rawJson(details.raw) : null), details.extra].filter((n): n is HTMLElement => !!n));
  }, [details, rawMode]);
  return <div id="details-body" ref={ref} />;
}
