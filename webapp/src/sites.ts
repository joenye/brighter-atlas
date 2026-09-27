// Where each tool lives. On the site each has a subdomain of its own (maps., data., fashion.) and the landing
// page is the bare domain; served anywhere else (a local copy, a preview) the tools are pages side by side:
// /maps, /viewer, /fashion and the landing page at /.
export type Tool = 'home' | 'maps' | 'data' | 'fashion';

const SITE = 'brighteratlas.com';
const PAGES: Record<Tool, string> = { home: '', maps: 'maps', data: 'viewer', fashion: 'fashion' };

/** On the site itself (the bare domain or one of its subdomains). */
export function onSite(): boolean {
  const host = location.hostname;
  return host === SITE || host.endsWith(`.${SITE}`);
}

/** A tool's address, with an optional `rest` (a query and/or hash, e.g. "?data=x#/mesh/3"). */
export function toolUrl(tool: Tool, rest = ''): string {
  if (onSite()) return `https://${tool === 'home' ? '' : `${tool}.`}${SITE}/${rest}`;
  return `/${PAGES[tool]}${rest}`;
}

/** Point every link marked data-tool="<tool>" at that tool. */
export function linkTools(root: ParentNode = document): void {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[data-tool]')) a.href = toolUrl(a.dataset.tool as Tool);
}
