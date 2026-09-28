// The site's addresses: one page (index.html) at every one of them, each tool at a path of its own.
// Shared by the app's shell, the dev server (tools/serve.ts) and the tests; plain data, no DOM.
export type Tool = 'home' | 'fashion' | 'maps' | 'data';

export const TOOLS: Tool[] = ['home', 'fashion', 'maps', 'data'];
export const PATHS: Record<Tool, string> = { home: '/', fashion: '/fashion', maps: '/maps', data: '/data' };

// Addresses from before the tools were one page, moved on whole (query and hash kept)
export const LEGACY: Record<string, string> = {
  '/index.html': '/', '/viewer': '/data', '/viewer.html': '/data', '/maps.html': '/maps', '/map': '/maps', '/world': '/maps',
  '/fashion.html': '/fashion',
};

/** The tool at `path` (a trailing slash allowed), or null. */
export function toolAt(path: string): Tool | null {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return TOOLS.find((t) => PATHS[t] === p) ?? null;
}

/** A tool's address, with an optional `rest` (a query and/or hash, e.g. "?data=x#/mesh/3"). */
export const toolUrl = (tool: Tool, rest = ''): string => `${PATHS[tool]}${rest}`;
