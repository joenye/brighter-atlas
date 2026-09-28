// The whole site as one page: the top bar, and under it the page the address names. A tool's code and
// stylesheet are fetched the first time its page opens; the tool then stays (hidden, doing no work) while
// other pages show, so coming back is instant and finds it as it was left. Where memory is short, a tool that
// draws with the GPU is let go when another page shows (two of them kept at once are more than a phone's
// browser allows a page: it throws the page away and loads it again), and opened afresh on coming back.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { PATHS, type Tool } from './paths.js';
import { useTool, navigate } from './router.js';
import { Topbar, type TopbarSlot } from './Topbar.js';
import { Landing } from './Landing.js';
import { DataPage, DataSearch, DataButtons, MapsPage, FashionPage, FashionTopbar } from './pages.js';
import type { ToolHandle, ToolProps } from './tool.js';

type ToolModule = { Tool: ComponentType<ToolProps> };
interface PageDef {
  title: string;
  /** its own stylesheet (the shared css/app.css is always there), used only while it shows */
  css?: string;
  Page: ComponentType;
  /** its code (a tool), fetched when its page first opens */
  load?: () => Promise<ToolModule>;
  topbar?: Omit<TopbarSlot, 'tool'>;
  /** it holds GPU memory: let go when hidden where memory is short (it implements destroy) */
  heavy?: boolean;
  extras?: { label: string; onClick: () => void }[];
}
const PAGES: Record<Tool, PageDef> = {
  home: { title: 'Brighter Atlas', css: '/css/home.css', Page: Landing },
  fashion: { title: 'Brighter Fashion', css: '/css/fashion.css', Page: FashionPage, load: () => import('../fashion/Fashion.js'), heavy: true, topbar: { left: <FashionTopbar /> } },
  maps: { title: 'Brighter Maps', css: '/css/world.css', Page: MapsPage, load: () => import('../world-atlas/WorldMap.js'), heavy: true },
  data: { title: 'Brighter Data', css: '/css/data.css', Page: DataPage, load: () => import('../DataTool.js'), topbar: { middle: <DataSearch />, right: <DataButtons /> },
    extras: [{ label: 'Help & FAQs', onClick: () => void import('../help.js').then((m) => m.openHelpModal()) }] },
};

// Memory short: a phone or tablet (iPadOS names itself a Mac, with touch), or a browser that says it has
// under 4 GB. (Safari names no memory; desktop Safari is roomy.)
const SHORT = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  || ((navigator as any).deviceMemory ?? 8) < 4;

// each page's stylesheet: added once, then on only while its page shows
const sheets = new Map<string, { link: HTMLLinkElement; ready: Promise<void>; loaded: boolean; want: boolean }>();
function sheet(href: string | undefined, on: boolean): Promise<void> {
  if (!href) return Promise.resolve();
  let s = sheets.get(href);
  if (!s) {
    // (one the page itself links, index.html, is already in)
    const linked = document.head.querySelector<HTMLLinkElement>(`link[rel=stylesheet][href="${href}"]`);
    const link = linked ?? document.createElement('link');
    const entry = { link, ready: Promise.resolve(), loaded: !!linked?.sheet, want: on };
    if (!entry.loaded) entry.ready = new Promise<void>((resolve) => { const done = () => { entry.loaded = true; resolve(); }; link.addEventListener('load', done); link.addEventListener('error', done); });
    if (!linked) { link.rel = 'stylesheet'; link.href = href; document.head.append(link); }
    s = entry;
    sheets.set(href, s);
  }
  // (the parsed sheet itself is switched: at once, and kept parsed; the link's own `disabled` would drop the
  // sheet, and switching it back on applies it a frame or more late: a page drawn unstyled)
  const entry = s;
  if (entry.link.sheet) entry.link.sheet.disabled = !on;
  else void entry.ready.then(() => { if (entry.link.sheet) entry.link.sheet.disabled = !entry.want; });
  entry.want = on;
  return entry.ready;
}

export function Shell() {
  const tool = useTool() ?? 'home';
  const picture = tool === 'fashion' && new URLSearchParams(location.search).has('picture');
  // the pages opened so far (kept), in the order opened
  const [opened, setOpened] = useState<Tool[]>([tool]);
  // (memory short: the heavy tools not showing leave, destroyed as their pages unmount)
  useEffect(() => {
    const keep = (t: Tool) => t === tool || !SHORT || !PAGES[t].heavy;
    const next = [...opened.filter(keep), ...(opened.includes(tool) ? [] : [tool])];
    if (next.length !== opened.length || next.some((t, i) => t !== opened[i])) setOpened(next);
  }, [tool]);
  // (before the browser paints: a page never shows a frame with its sheet still off, nor the last one's on)
  useLayoutEffect(() => {
    document.title = PAGES[tool].title;
    document.documentElement.dataset.tool = tool;
    for (const t of new Set([...opened, tool])) void sheet(PAGES[t].css, t === tool);
  }, [tool, opened]);
  const handles = useRef(new Map<Tool, ToolHandle>());
  const shown = opened.includes(tool) ? opened.filter((t) => t === tool || !SHORT || !PAGES[t].heavy) : [...opened, tool];
  return (
    <div className={`shell${picture ? ' picture' : ''}`}>
      {!picture && (
        <Topbar tool={tool} extras={PAGES[tool].extras ?? []}
          slots={shown.filter((t) => PAGES[t].topbar).map((t) => ({ tool: t, ...PAGES[t].topbar }))}
          onCurrent={() => { const h = handles.current.get(tool); if (h?.current) h.current(); else if (tool !== 'home') navigate(PATHS[tool]); }} />
      )}
      <div className="pages">
        {shown.map((t) => <PageHost key={t} tool={t} active={t === tool} handles={handles.current} bare={picture} />)}
      </div>
    </div>
  );
}

// One loader from the visitor's click to the tool's first view: the page's layout is drawn at once (its
// placeholders, pages.tsx), and this card stays over it while the code arrives and the tool draws, until the
// tool says it is ready (the tools show no first-load card of their own).
function PageHost({ tool, active, handles, bare }: { tool: Tool; active: boolean; handles: Map<Tool, ToolHandle>; bare: boolean }) {
  const def = PAGES[tool];
  const root = useRef<HTMLDivElement>(null), isActive = useRef(active);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(def.load ? 'loading' : 'ready');
  const [Tool, setTool] = useState<ComponentType<ToolProps> | null>(null);
  const late = useRef(0);
  const ready = useCallback(() => { clearTimeout(late.current); setState((s) => (s === 'loading' ? 'ready' : s)); }, []);
  const register = useCallback((h: ToolHandle) => { handles.set(tool, h); }, []);
  // (never drawn without its stylesheet: hidden, but for its load card, until the sheet is in)
  const [styled, setStyled] = useState(() => !def.css || (sheets.get(def.css)?.loaded ?? !!document.head.querySelector<HTMLLinkElement>(`link[rel=stylesheet][href="${def.css}"]`)?.sheet));
  useEffect(() => { if (!styled) void sheet(def.css, isActive.current).then(() => setStyled(true)); }, []);
  isActive.current = active;
  // first opened: its stylesheet, then its code, rendered into its page
  useEffect(() => {
    if (!def.load) return;
    let gone = false;
    (async () => {
      await sheet(def.css, isActive.current);
      const mod = await def.load!();
      if (gone) return;
      // (a tool that never says so still lets its page go after a while)
      late.current = window.setTimeout(ready, 30000);
      setTool(() => mod.Tool);
    })().catch((e) => { console.error(`${tool}:`, e); setState('failed'); });
    // let go (the page leaves the document, the tool's own effects freeing what it holds)
    return () => { gone = true; handles.delete(tool); clearTimeout(late.current); };
  }, []);
  const { Page } = def;
  return (
    <div ref={root} className={`page${styled ? '' : ' unstyled'}`} data-page={tool} hidden={!active}>
      {Tool ? <Tool active={active} ready={ready} register={register} /> : <Page />}
      {state === 'loading' && !bare && (
        <div className="load-card spin page-load" role="status" aria-label={`Loading ${def.title}`}>
          <svg viewBox="0 0 44 44" aria-hidden="true"><circle className="pl-track" cx="22" cy="22" r="19" /><circle className="pl-fill" cx="22" cy="22" r="19" /></svg>
        </div>
      )}
      {state === 'failed' && !bare && <p className="page-failed" role="alert">{def.title} could not be loaded. Check your connection, then reload the page.</p>}
    </div>
  );
}
