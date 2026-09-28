// The app's addresses as its pages: the path names the tool (paths.ts); the query and hash belong to the
// tool itself (a look, a map place, a Data route). Moving between tools is history.pushState (no page
// load); each tool's own query and hash are remembered for when it is opened again without one of its own.
import { useSyncExternalStore } from 'react';
import { LEGACY, PATHS, toolAt, type Tool } from './paths.js';

const EVENT = 'bs:navigate';
const last = new Map<Tool, string>();   // tool -> its last query and hash

/** The page for the address as it is now (null: not one of the site's). */
export const currentTool = (): Tool | null => toolAt(location.pathname);

/** Go to `to` (a path, with a query or hash of its own or not) without loading a page. */
export function navigate(to: string, { replace = false }: { replace?: boolean } = {}): void {
  const from = currentTool();
  if (from) last.set(from, `${location.search}${location.hash}`);
  const url = new URL(to, location.href);
  const tool = toolAt(url.pathname);
  // (a tool opened plainly comes back as it was left)
  const target = tool && !url.search && !url.hash && last.get(tool) ? `${PATHS[tool]}${last.get(tool)}` : `${url.pathname}${url.search}${url.hash}`;
  if (target === `${location.pathname}${location.search}${location.hash}`) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', target);
  dispatchEvent(new Event(EVENT));
}

const subscribe = (fn: () => void) => {
  addEventListener('popstate', fn); addEventListener(EVENT, fn);
  return () => { removeEventListener('popstate', fn); removeEventListener(EVENT, fn); };
};
/** The tool the address names, following every move. */
export const useTool = (): Tool | null => useSyncExternalStore(subscribe, currentTool);

/**
 * Before the first page draws: the address in its one form. A trailing slash goes (relative addresses in the
 * tools resolve from the site's root); the tools' old addresses move to their paths; and links from before
 * the tools had paths of their own, which all named the landing page, go on whole: a Data route (#/mesh/3,
 * ?data=...) to Data, a map place (#r=..., #c=...) to Maps.
 */
export function settleAddress(): void {
  let path = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, '') : location.pathname;
  path = LEGACY[path] ?? path;
  const rest = `${location.search}${location.hash}`;
  if (path === '/' && (location.hash.startsWith('#/') || new URLSearchParams(location.search).has('data'))) path = PATHS.data;
  else if (path === '/' && location.hash.length > 1) path = PATHS.maps;
  if (path !== location.pathname) history.replaceState(null, '', `${path}${rest}`);
}

/** Links anywhere on the page to one of the site's own pages move without a page load. */
export function catchLinks(): void {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    const to = LEGACY[url.pathname] ?? url.pathname;
    if (!toolAt(to) || (to === location.pathname && url.hash && url.hash !== location.hash && !url.search)) return;   // (a hash on this page: the page's own)
    e.preventDefault();
    navigate(`${to}${url.search}${url.hash}`);
  });
}
