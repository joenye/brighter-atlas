// The site's one page (index.html): the shell, then the page the address names (Shell.tsx).
import { createRoot } from 'react-dom/client';
import { Shell } from './Shell.js';
import { settleAddress, catchLinks, currentTool, subscribe } from './router.js';
import { pageView } from '../analytics.js';
import { autoScrollbars } from '../scrollbar.js';
import { buildInfoReady } from '../build-info.js';

settleAddress();
catchLinks();
createRoot(document.getElementById('root')!).render(<Shell />);
// a page view for the page opened, and for each tool opened after it (not for a move within one)
{ let seen = currentTool(); pageView(); subscribe(() => { const tool = currentTool(); if (tool !== seen) { seen = tool; pageView(); } }); }
// every scroller the pages make takes the themed scrollbar (AGENTS.md rule 3)
autoScrollbars();
// What's new, once by itself after an update that has notes (a deployed build only)
void buildInfoReady.then((info) => {
  if (info?.version && info.version !== 'dev') void import('../changelog.js').then((m) => m.maybeAutoShowWhatsNew());
});
