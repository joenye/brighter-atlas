// The top bar's tool switch: beside each tool's "Brighter <name>", a small button that opens a menu of the
// three tools (the one open marked), each with a line on what it does, and the landing page. Arrow keys move
// through it, Escape closes it back to its button.
import { toolUrl, type Tool } from './sites.js';

const TOOLS: { tool: Tool; name: string; line: string }[] = [
  { tool: 'maps', name: 'Maps', line: 'The world map for every game update' },
  { tool: 'data', name: 'Data', line: 'Everything in your own game files' },
  { tool: 'fashion', name: 'Fashion', line: 'Try on every outfit and dye' },
];

/** Put the switch into `#topbar .brand`, for the page of `current`. */
export function attachToolSwitch(current: Tool, root: ParentNode = document): void {
  const brand = root.querySelector<HTMLElement>('#topbar .brand');
  if (!brand || brand.querySelector('.tool-switch')) return;
  const wrap = document.createElement('span');
  wrap.className = 'tool-switch';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-switch-btn';
  button.title = 'Switch to another Brighter Atlas tool';
  button.setAttribute('aria-label', 'Switch tool');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
  const menu = document.createElement('div');
  menu.className = 'tool-switch-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  for (const t of TOOLS) {
    const a = document.createElement('a');
    a.setAttribute('role', 'menuitem');
    a.href = toolUrl(t.tool);
    a.className = `tool-switch-item${t.tool === current ? ' on' : ''}`;
    if (t.tool === current) a.setAttribute('aria-current', 'page');
    a.innerHTML = '<span class="tool-switch-name"><span class="brand-name">Brighter</span> <span class="brand-sub"></span></span><span class="tool-switch-line"></span>';
    a.querySelector('.brand-sub')!.textContent = t.name;
    a.querySelector('.tool-switch-line')!.textContent = t.line;
    menu.append(a);
  }
  const home = document.createElement('a');
  home.setAttribute('role', 'menuitem');
  home.href = toolUrl('home');
  home.className = 'tool-switch-home';
  home.textContent = 'All tools';
  menu.append(home);
  wrap.append(button, menu);
  brand.querySelector('.brand-link')?.after(wrap);

  const items = () => [...menu.querySelectorAll<HTMLAnchorElement>('a')];
  const open = (on: boolean, focus = false) => {
    menu.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    if (on && focus) (menu.querySelector<HTMLElement>('a.on') ?? items()[0])?.focus();
  };
  button.addEventListener('click', (e) => { e.stopPropagation(); open(menu.hidden, true); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !wrap.contains(e.target as Node)) open(false); });
  menu.addEventListener('keydown', (e) => {
    const list = items(), at = list.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open(false); button.focus(); }
  });
  menu.addEventListener('focusout', (e) => { const to = e.relatedTarget as Node | null; if (to && !wrap.contains(to)) open(false); });
}
