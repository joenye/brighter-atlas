// Where Fashion's data comes from: the site serves it as files, a folder per game update, named by
// fashion-data/latest.json (asked for first, never reused unchecked); without one (a development server) it
// is at the root. Every data address in the page goes through `at`.
// (the page preloads it; the site serves it to be asked again every time, so this reuses that preload. Only JSON
// counts: the site answers a missing file with a page)
const hosted = await fetch('/fashion-data/latest.json').then(r => r.status === 200 && /json/.test(r.headers.get('content-type') ?? '') ? r.json() : null).catch(() => null);
export const BASE: string = hosted?.base ?? '/';
/** The address of a data file (`rel` without a leading slash). */
export const at = (rel: string) => BASE + rel;
/** Served by a development server (which keeps a log of what went wrong on a device under test). */
export const DEV = !hosted;
