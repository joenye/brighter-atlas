// Viewer preferences persisted in localStorage so they survive selection
// changes and full reloads (auto-play, loop, playback speed, shading mode).

const KEY = 'bs.prefs';
const DEFAULTS: Record<string, any> = {
  autoplay: true, loop: true, speed: 1, shading: 'tex',
  wireframe: false, twosided: false, skeleton: false, uvmap: false,
  skelviz: false,  // bone overlay in the skeleton view, off by default (show the clean textured model)
  skelmesh: 'auto', // composite mesh selection across skeleton pages: auto (all, capped on huge rigs) | all | none
  clipsort: 'index', // clip-picker order in the playback bar: index | seconds | frames | name
  exportfmt: 'glb', // per-asset export format for 3D assets: glb (Blender-ready) | json (raw payload)
  camhint: true, // camera-controls hint card on 3D views: expanded (fresh users) | minimised to a ? chip
};

function load(): Record<string, any> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY)!);
    return raw && typeof raw === 'object' ? { ...DEFAULTS, ...raw } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

const cur = load();

export function getPref(k: string): any { return cur[k]; }

export function setPref(k: string, v: any): void {
  cur[k] = v;
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* storage unavailable */ }
}

// Friendly names the user gives to versions (game builds), keyed by versionId.
// These are a LOCAL user preference, deliberately kept OUT of the shareable
// asset_overrides.json (which is only per-asset names + texture assignments).
const VNAMES_KEY = 'bs.versionNames';
function loadVNames(): Record<string, string> {
  try { const raw = JSON.parse(localStorage.getItem(VNAMES_KEY)!); return raw && typeof raw === 'object' ? raw : {}; }
  catch { return {}; }
}
const vnames = loadVNames();

export function getVersionName(id: string | null | undefined): string { return (id && vnames[id]) || ''; }

export function setVersionName(id: string | null | undefined, name: string | null | undefined): void {
  if (!id) return;
  const n = (name || '').trim();
  if (n) vnames[id] = n; else delete vnames[id];   // empty clears -> falls back to the auto label
  try { localStorage.setItem(VNAMES_KEY, JSON.stringify(vnames)); } catch { /* storage unavailable */ }
}
