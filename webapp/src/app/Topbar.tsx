// The top bar every page shares: the brand (the mark, "Brighter" and the page's name) is the tool switch,
// whose menu lists Home and the tools, the page's own entries (Help & FAQs on Data) and the app's version
// (What's new); each tool's own parts sit beside it (kept while the tool is, shown with its page); Discord
// and GitHub on the right.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PATHS, type Tool } from './paths.js';
import { navigate } from './router.js';
import { buildVersionLabel, buildInfoReady } from '../build-info.js';
import { DiscordIcon, GitHubIcon, DISCORD_URL, GITHUB_URL } from './icons.js';

export const NAMES: Record<Tool, string> = { home: 'atlas', fashion: 'fashion', maps: 'maps', data: 'data' };
const TOOL_LINES: [Exclude<Tool, 'home'>, string, string][] = [
  ['fashion', 'Fashion', 'Try on every outfit and dye'],
  ['maps', 'Maps', 'The world map for every game update'],
  ['data', 'Data', 'Everything in your own game files'],
];

export interface TopbarSlot { tool: Tool; left?: ReactNode; middle?: ReactNode; right?: ReactNode }

export function Topbar({ tool, slots, extras, onCurrent }: {
  tool: Tool;
  /** each visited tool's own parts, shown only with its page */
  slots: TopbarSlot[];
  /** the page's own entries in the switch's menu */
  extras: { label: string; onClick: () => void }[];
  /** the page's own name picked in the switch */
  onCurrent: () => void;
}) {
  const part = (key: 'left' | 'middle' | 'right') => slots.filter((s) => s[key]).map((s) =>
    <span key={s.tool} className="topbar-slot" hidden={s.tool !== tool}>{s[key]}</span>);
  return (
    <header id="topbar">
      <div className="brand">
        <ToolSwitch tool={tool} extras={extras} onCurrent={onCurrent} />
        {part('left')}
      </div>
      {part('middle')}
      <div className="top-right">
        {part('right')}
        <a className="btn-mini top-social discord" href={DISCORD_URL} target="_blank" rel="noopener noreferrer" title="Join the Brighter Atlas Discord"><DiscordIcon /> Discord</a>
        <a className="btn-mini top-social github" href={GITHUB_URL} target="_blank" rel="noopener noreferrer" title="Brighter Atlas on GitHub"><GitHubIcon /> GitHub</a>
      </div>
    </header>
  );
}

function ToolSwitch({ tool, extras, onCurrent }: { tool: Tool; extras: { label: string; onClick: () => void }[]; onCurrent: () => void }) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(buildVersionLabel());
  const wrap = useRef<HTMLSpanElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  useEffect(() => { void buildInfoReady.then(() => setVersion(buildVersionLabel())); }, []);
  // (open: the page's own entry takes focus; a click anywhere else, or focus leaving, closes it)
  useEffect(() => {
    if (!open) return;
    (menu.current?.querySelector<HTMLElement>('.on') ?? menu.current?.querySelector<HTMLElement>('a, button'))?.focus();
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('click', away);
    return () => document.removeEventListener('click', away);
  }, [open]);
  const close = (refocus = false) => { setOpen(false); if (refocus) button.current?.focus(); };
  const go = (e: React.MouseEvent, to: Tool) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // (a new tab: the browser's)
    e.preventDefault(); close(true);
    if (to === tool) onCurrent(); else navigate(PATHS[to]);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...menu.current!.querySelectorAll<HTMLElement>('a, button')], at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
  };
  const rule = (k: string) => <div key={k} className="tool-switch-rule" role="separator" />;
  return (
    <span className="tool-switch" ref={wrap}>
      <button ref={button} type="button" className="tool-switch-btn" title="Switch to another Brighter Atlas tool" aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <span className="brand-link">
          <img className="brand-mark" src="/brand/mark.svg" alt="" width={18} height={18} />
          <span className="brand-name">Brighter</span>
          <span className="brand-sub">{NAMES[tool]}</span>
        </span>
        <span className="tool-switch-chevron"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg></span>
      </button>
      <div ref={menu} className="tool-switch-menu" role="menu" hidden={!open} onKeyDown={onKey}
        onBlur={(e) => { const to = e.relatedTarget as Node | null; if (to && !wrap.current?.contains(to)) setOpen(false); }}>
        <a role="menuitem" href={PATHS.home} className={`tool-switch-home${tool === 'home' ? ' on' : ''}`} aria-current={tool === 'home' ? 'page' : undefined} onClick={(e) => go(e, 'home')}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5" /></svg><span>Home</span>
        </a>
        {rule('r1')}
        {TOOL_LINES.map(([t, name, line]) => (
          <a key={t} role="menuitem" href={PATHS[t]} className={`tool-switch-item${t === tool ? ' on' : ''}`} aria-current={t === tool ? 'page' : undefined} onClick={(e) => go(e, t)}>
            <span className="tool-switch-name"><span className="brand-name">Brighter</span> <span className="brand-sub">{name}</span></span>
            <span className="tool-switch-line">{line}</span>
          </a>
        ))}
        {extras.length > 0 && rule('r2')}
        {extras.map((x) => (
          <button key={x.label} type="button" role="menuitem" className="tool-switch-home tool-switch-extra" onClick={() => { close(); x.onClick(); }}>{x.label}</button>
        ))}
        <button type="button" role="menuitem" className="tool-switch-news" title="What's new: this release's changes"
          onClick={() => { close(); void import('../changelog.js').then((m) => m.openWhatsNew()); }}>{`What's new · ${version}`}</button>
      </div>
    </span>
  );
}
