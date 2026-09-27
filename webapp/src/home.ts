// The landing page (index.html, the bare domain): the three tools. Links from before the tools had
// addresses of their own arrive here and go on whole: a viewer route (#/mesh/3, ?data=...) to Brighter Data,
// the world map's place in the world (#x=...) to Brighter Maps.
import { toolUrl } from './sites.js';
import { initTopbar } from './topbar.js';

const rest = `${location.search}${location.hash}`;
if (location.hash.startsWith('#/') || new URLSearchParams(location.search).has('data')) location.replace(toolUrl('data', rest));
else if (location.hash.length > 1) location.replace(toolUrl('maps', rest));
else initTopbar('home');
