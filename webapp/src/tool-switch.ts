// The top bar's tool switch: the brand itself (the mark, "Brighter", the tool's name and a chevron, in one
// faint pill) is the button that opens a menu of the three tools (the one open marked), each with a line on
// what it does, and the landing page (Home). Arrow keys move through it, Escape closes it back to its button.
import { toolUrl, type Tool } from './sites.js';

const TOOLS: { tool: Tool; name: string; line: string }[] = [
  { tool: 'fashion', name: 'Fashion', line: 'Try on every outfit and dye' },
  { tool: 'maps', name: 'Maps', line: 'The world map for every game update' },
  { tool: 'data', name: 'Data', line: 'Everything in your own game files' },
];

/** Make `#topbar .brand`'s link the switch, for the page of `current`. `onCurrent`, when given, handles a
 *  pick of this page's own tool in place (the map back to its latest update) instead of loading it again. */
export function attachToolSwitch(current: Tool, root: ParentNode = document, onCurrent?: () => void): void {
  const brand = root.querySelector<HTMLElement>('#topbar .brand');
  const link = brand?.querySelector<HTMLElement>('.brand-link');
  if (!brand || !link || brand.querySelector('.tool-switch')) return;
  const wrap = document.createElement('span');
  wrap.className = 'tool-switch';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-switch-btn';
  button.title = 'Switch to another Brighter Atlas tool';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  // the brand's own content (mark and name) goes inside, then the chevron
  const face = document.createElement('span');
  face.className = 'brand-link';
  face.append(...link.childNodes);
  const chevron = document.createElement('span');
  chevron.className = 'tool-switch-chevron';
  chevron.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
  button.append(face, chevron);
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
  // the landing page, under a rule: an entry of its own, as plain as the tools
  const rule = () => { const r = document.createElement('div'); r.className = 'tool-switch-rule'; r.setAttribute('role', 'separator'); return r; };
  const home = document.createElement('a');
  home.setAttribute('role', 'menuitem');
  home.href = toolUrl('home');
  home.className = `tool-switch-home${current === 'home' ? ' on' : ''}`;
  if (current === 'home') home.setAttribute('aria-current', 'page');
  home.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5"/></svg><span>Home</span>';
  menu.append(rule(), home);
  wrap.append(button, menu);
  link.replaceWith(wrap);
  if (onCurrent) menu.querySelector<HTMLElement>('a.on')?.addEventListener('click', (e) => { e.preventDefault(); open(false); button.focus(); onCurrent(); });

  const items = () => [...menu.querySelectorAll<HTMLElement>('a, button')];
  const open = (on: boolean, focus = false) => {
    menu.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    if (on && focus) (menu.querySelector<HTMLElement>('a.on') ?? items()[0])?.focus();
  };
  button.addEventListener('click', (e) => { e.stopPropagation(); open(menu.hidden, true); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !wrap.contains(e.target as Node)) open(false); });
  menu.addEventListener('keydown', (e) => {
    const list = items(), at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open(false); button.focus(); }
  });
  menu.addEventListener('focusout', (e) => { const to = e.relatedTarget as Node | null; if (to && !wrap.contains(to)) open(false); });
}
