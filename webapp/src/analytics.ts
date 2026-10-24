// Visits counted without cookies or personal data (Umami Cloud: it tells visitors apart by a hash that changes daily,
// and keeps no address): a page view for each page opened, a few named events, and how long the page was in view.
// Sent only from the live site (or a page opened with ?track=1, to try it), never when the browser asks not to be
// tracked, never from a browser a program drives (tests, captures: navigator.webdriver), nor from one opted out with
// ?notrack=1 (kept; ?notrack=0 undoes it); a send that fails is never noticed. The page's address goes without its
// query or hash.
const WEBSITE = 'ed0c3362-b0f0-4045-85ef-66e465141ddb';
const ENDPOINT = 'https://gateway.umami.is/api/send';
const LIVE = 'brighteratlas.com';

type Data = Record<string, string | number | boolean>;

const OPT_OUT = 'bs.notrack';
const enabled = (() => {
  try {
    if (!WEBSITE || typeof location === 'undefined' || typeof fetch !== 'function') return false;
    const query = new URLSearchParams(location.search);
    if (query.has('notrack')) { if (query.get('notrack') === '0') localStorage.removeItem(OPT_OUT); else localStorage.setItem(OPT_OUT, '1'); }
    if (query.has('track')) return true;
    if ((navigator as Navigator & { doNotTrack?: string }).doNotTrack === '1' || navigator.webdriver) return false;
    if (localStorage.getItem(OPT_OUT) === '1') return false;
    return location.hostname === LIVE;
  } catch { return false; }
})();

function send(name?: string, data?: Data): void {
  if (!enabled) return;
  const payload = {
    website: WEBSITE, hostname: location.hostname, language: navigator.language, referrer: document.referrer,
    screen: `${screen.width}x${screen.height}`, title: document.title, url: location.pathname,
    ...(name ? { name, ...(data ? { data } : {}) } : {}),
  };
  try {
    void fetch(ENDPOINT, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event', payload }) }).catch(() => {});
  } catch { /* never the page's problem */ }
}

/** A page view, of the address as it is now. */
export const pageView = (): void => send();
/** A named event, with a few values about it (kept small: a level, a difficulty, a count). */
export const track = (name: string, data?: Data): void => send(name, data);

// (how long the page was in view: each time it is put away, the seconds since it was last shown, as `engaged`; their
// sum is the visit's length, which the events' own times alone miss on a page that sends nothing while in use)
let shownAt = Date.now();
if (enabled) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      const seconds = Math.round((Date.now() - shownAt) / 1000);
      if (seconds > 0) track('engaged', { seconds });
    } else shownAt = Date.now();
  });
}
