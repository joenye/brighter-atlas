// Every page's top bar, the same everywhere: the brand (the mark, "Brighter" and the tool's name) is the tool
// switch, and its menu ends with the page's own entries and the app's version, which opens What's new (shown
// once by itself after an update that has notes). What's new is its own chunk, fetched only when it opens (or
// might open), so a first visit to a page never waits for it.
import { linkTools, type Tool } from './sites.js';
import { attachToolSwitch } from './tool-switch.js';
import { buildVersionLabel, buildInfoReady } from './build-info.js';
import { autoScrollbars } from './scrollbar.js';

export interface TopbarOptions {
  /** A pick of this page's own tool in the switch, handled in place (see attachToolSwitch). */
  onCurrent?: () => void;
  /** The page's own entries in the switch's menu, under Home (the viewer's Help & FAQs). */
  extras?: { label: string; onClick: () => void }[];
}

export function initTopbar(tool: Tool, { onCurrent, extras = [] }: TopbarOptions = {}): void {
  linkTools();
  // every page's scrollers take the themed scrollbar (scrollbar.ts), whatever the platform does with its own
  autoScrollbars();
  attachToolSwitch(tool, document, onCurrent);
  const menu = document.querySelector<HTMLElement>('#topbar .tool-switch-menu');
  if (!menu) return;
  const close = () => { menu.hidden = true; document.querySelector('#topbar .tool-switch-btn')?.setAttribute('aria-expanded', 'false'); };
  const entry = (cls: string, text: string, onClick: () => void) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = cls;
    item.setAttribute('role', 'menuitem');
    item.textContent = text;
    item.addEventListener('click', () => { close(); onClick(); });
    menu.append(item);
    return item;
  };
  // the page's own entries under the tools, a rule between
  if (extras.length) { const r = document.createElement('div'); r.className = 'tool-switch-rule'; r.setAttribute('role', 'separator'); menu.append(r); }
  for (const x of extras) entry('tool-switch-home tool-switch-extra', x.label, x.onClick);
  // the app's version, last: it opens What's new
  const news = entry('tool-switch-news', '', () => { void import('./changelog.js').then((m) => m.openWhatsNew()); });
  news.title = "What's new: this release's changes";
  const setNews = () => { news.textContent = `What's new · ${buildVersionLabel()}`; };
  setNews(); void buildInfoReady.then(setNews);
  // shown by itself once after an update with notes (a deployed build only: a dev build has no version to have seen)
  void buildInfoReady.then((info) => {
    if (info?.version && info.version !== 'dev') void import('./changelog.js').then((m) => m.maybeAutoShowWhatsNew());
  });
}
