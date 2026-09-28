// The whole site as one page: the top bar, and under it the page the address names. A tool's code and
// stylesheet are fetched the first time its page opens; the tool then stays (hidden, doing no work) while
// other pages show, so coming back is instant and finds it as it was left.
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { PATHS, type Tool } from './paths.js';
import { useTool, navigate } from './router.js';
import { Topbar, type TopbarSlot } from './Topbar.js';
import { Landing } from './Landing.js';
import { DataPage, DataSearch, DataButtons, MapsPage, FashionPage, FashionTopbar } from './pages.js';
import type { ToolContext, ToolHandle } from './tool.js';

type ToolModule = { mount(root: HTMLElement, ctx: ToolContext): Promise<ToolHandle> };
interface PageDef {
  title: string;
  /** its own stylesheet (the shared css/app.css is always there), used only while it shows */
  css?: string;
  Page: ComponentType;
  /** its code (a tool), fetched when its page first opens */
  load?: () => Promise<ToolModule>;
  topbar?: Omit<TopbarSlot, 'tool'>;
  extras?: { label: string; onClick: () => void }[];
}
const PAGES: Record<Tool, PageDef> = {
  home: { title: 'Brighter Atlas', css: '/css/home.css', Page: Landing },
  fashion: { title: 'Brighter Fashion', css: '/css/fashion.css', Page: FashionPage, load: () => import('../fashion/app.js'), topbar: { left: <FashionTopbar /> } },
  maps: { title: 'Brighter Maps', css: '/css/world.css', Page: MapsPage, load: () => import('../world-atlas/main.js') },
  data: { title: 'Brighter Data', Page: DataPage, load: () => import('../main.js'), topbar: { middle: <DataSearch />, right: <DataButtons /> },
    extras: [{ label: 'Help & FAQs', onClick: () => void import('../help.js').then((m) => m.openHelpModal()) }] },
};

// each page's stylesheet: added once, then on only while its page shows
const sheets = new Map<string, { link: HTMLLinkElement; ready: Promise<void> }>();
function sheet(href: string | undefined, on: boolean): Promise<void> {
  if (!href) return Promise.resolve();
  let s = sheets.get(href);
  if (!s) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = href;
    const ready = new Promise<void>((resolve) => { link.onload = link.onerror = () => resolve(); });
    document.head.append(link);
    s = { link, ready };
    sheets.set(href, s);
  }
  s.link.disabled = !on;
  return s.ready;
}

export function Shell() {
  const tool = useTool() ?? 'home';
  const picture = tool === 'fashion' && new URLSearchParams(location.search).has('picture');
  // the pages opened so far (kept), in the order opened
  const [opened, setOpened] = useState<Tool[]>([tool]);
  useEffect(() => { if (!opened.includes(tool)) setOpened([...opened, tool]); }, [tool]);
  useEffect(() => {
    document.title = PAGES[tool].title;
    document.documentElement.dataset.tool = tool;
    for (const t of opened) void sheet(PAGES[t].css, t === tool);
  }, [tool, opened]);
  const handles = useRef(new Map<Tool, ToolHandle>());
  const shown = opened.includes(tool) ? opened : [...opened, tool];
  return (
    <div className={`shell${picture ? ' picture' : ''}`}>
      {!picture && (
        <Topbar tool={tool} extras={PAGES[tool].extras ?? []}
          slots={shown.filter((t) => PAGES[t].topbar).map((t) => ({ tool: t, ...PAGES[t].topbar }))}
          onCurrent={() => { const h = handles.current.get(tool); if (h?.current) h.current(); else if (tool !== 'home') navigate(PATHS[tool]); }} />
      )}
      <div className="pages">
        {shown.map((t) => <PageHost key={t} tool={t} active={t === tool} handles={handles.current} />)}
      </div>
    </div>
  );
}

function PageHost({ tool, active, handles }: { tool: Tool; active: boolean; handles: Map<Tool, ToolHandle> }) {
  const def = PAGES[tool];
  const root = useRef<HTMLDivElement>(null), isActive = useRef(active);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(def.load ? 'loading' : 'ready');
  isActive.current = active;
  // first opened: its stylesheet, then its code, mounted into its page
  useEffect(() => {
    if (!def.load) return;
    let gone = false;
    (async () => {
      await sheet(def.css, isActive.current);
      const mod = await def.load!();
      if (gone) return;
      // (the code is here: from now the tool shows its own loading, one card at a time)
      setState('ready');
      const handle = await mod.mount(root.current!.firstElementChild as HTMLElement, { active: () => isActive.current });
      handles.set(tool, handle);
      if (!isActive.current) handle.hide();
    })().catch((e) => { console.error(`${tool}:`, e); setState('failed'); });
    return () => { gone = true; };
  }, []);
  // shown and hidden as the address moves
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const h = handles.get(tool);
    if (active) h?.show(); else h?.hide();
  }, [active]);
  const { Page } = def;
  return (
    <div ref={root} className="page" data-page={tool} hidden={!active}>
      <Page />
      {state !== 'ready' && (
        <div className={`load-card${state === 'loading' ? ' spin' : ''} page-load`} role="status">
          <svg viewBox="0 0 44 44" aria-hidden="true"><circle className="pl-track" cx="22" cy="22" r="19" /><circle className="pl-fill" cx="22" cy="22" r="19" /></svg>
          <span className="pl-name">{state === 'failed' ? `${def.title} could not be loaded` : `Loading ${def.title}`}</span>
          <span className="pl-pct">{state === 'failed' ? 'Check your connection, then reload the page.' : ''}</span>
        </div>
      )}
    </div>
  );
}
