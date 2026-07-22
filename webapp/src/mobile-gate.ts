// Mobile "desktop-only" gate. Phones and small touch devices boot into a
// full-viewport greeting instead of an app they can't run. main.ts skips the
// whole app boot when this mounts, so the gate is all the device pays for.
// DRY by construction: the brand lockup and the Discord/GitHub links are
// CLONED from the (hidden) topbar markup in index.html (their URLs and SVG
// icons exist only there), and the inline help view renders help.ts's shared
// content builder. Styling lives in the .mgate-* block of css/app.css, which
// also holds the anti-flash rule keyed off the .mgate-on/.mgate-off classes
// stamped on <html> here.

import { el, clear, DESKTOP_ONLY_LINE } from './ui.js';
import { buildHelpContent } from './help.js';

const BYPASS_KEY = 'bs.mobileGateBypass';

// the normal app boot, kept so the escape hatch can run it in-place
let bootApp: (() => void) | null = null;

// Feature-based, evaluated ONCE at boot (no live resize gating): the PRIMARY
// pointer must be coarse AND the device must be touch AND the viewport must
// be phone-sized. A desktop browser in a narrow window has a fine primary
// pointer (even on a touch-screen laptop), so it can never land here.
function isSmallTouchDevice(): boolean {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const touch = (navigator.maxTouchPoints || 0) > 0;
  const small = Math.min(screen.width, screen.height) < 768 || innerWidth < 820;
  return coarse && touch && small;
}

// clone a piece of the static topbar markup: the single source for the brand
// and the community links (URLs, target/rel and inline SVG icons)
function cloneTopbar(sel: string): HTMLElement | null {
  const src = document.querySelector<HTMLElement>(sel);
  return src ? (src.cloneNode(true) as HTMLElement) : null;
}

// the greeting: brand, the one-line reason, three big actions, escape hatch.
// Returns the Help card so the help view's back control can restore focus.
function renderHome(root: HTMLElement): HTMLElement {
  clear(root);

  const helpBtn = el('button', { class: 'mgate-action', type: 'button' },
    el('span', { class: 'mgate-action-ico', 'aria-hidden': 'true', text: '?' }),
    'Help/FAQs');
  helpBtn.addEventListener('click', () => renderHelp(root));

  const actions = el('div', { class: 'mgate-actions' }, helpBtn);
  for (const key of ['discord', 'github']) {
    const a = cloneTopbar(`#topbar .top-social.${key}`);
    if (!a) continue;   // topbar markup moved: degrade to Help only
    a.classList.remove('btn-mini');   // keep top-social (hover tints); restyle as a card
    a.classList.add('mgate-action');
    actions.appendChild(a);
  }

  // A quiet look at what desktop offers: two curated screenshots of the
  // app's own UI (webapp/assets/, the sanctioned home for these), lazy-loaded
  // below the actions so the gate itself stays featherweight.
  const previews = el('div', { class: 'mgate-previews' },
    el('h2', { class: 'mgate-previews-label', text: 'Screenshots' }),
    ...([
      ['assets/preview-world.jpg', 'The whole game world, explorable in 3D'],
      ['assets/preview-model.jpg', 'Models with their variants, textures, and animations'],
      ['assets/preview-audio.jpg', 'Play music and sound effects'],
    ] as const).map(([src, caption]) => el('figure', { class: 'mgate-preview' },
      el('img', { src, alt: caption, loading: 'lazy', decoding: 'async' }),
      el('figcaption', { text: caption }))));

  const bypass = el('button', { class: 'mgate-bypass', type: 'button', text: 'Try the desktop site anyway' });
  bypass.addEventListener('click', () => {
    try { sessionStorage.setItem(BYPASS_KEY, '1'); } catch { /* no storage: still proceed this page */ }
    root.remove();
    document.documentElement.classList.remove('mgate-on');
    document.documentElement.classList.add('mgate-off');
    bootApp?.();
  });

  root.appendChild(el('div', { class: 'mgate-inner' },
    el('div', { class: 'mgate-brand' }, cloneTopbar('#topbar .brand-link')),
    el('h1', { class: 'mgate-title', text: 'Built for desktop' }),
    el('p', { class: 'mgate-lede' },
      'Brighter Atlas is a fan-made viewer for the assets inside Brighter Shores: ',
      'everything decodes from your own game files, entirely in your browser. ',
      DESKTOP_ONLY_LINE),
    actions,
    previews,
    el('div', { class: 'mgate-foot' }, bypass)));
  root.scrollTop = 0;
  return helpBtn;
}

// the same help content the desktop modal shows, inline as a full page
function renderHelp(root: HTMLElement): void {
  clear(root);
  const back = el('button', { class: 'mgate-back', type: 'button', text: '← Back' });
  back.addEventListener('click', () => renderHome(root).focus());
  root.appendChild(el('div', { class: 'mgate-inner' },
    el('div', { class: 'mgate-help-head' }, back, el('h1', { class: 'mgate-title', text: 'Help/FAQs' })),
    buildHelpContent()));
  root.scrollTop = 0;
  back.focus();
}

// Called FIRST at boot (main.ts). Returns true when the gate mounted: the
// caller must then skip the app boot entirely; `boot` is only kept for the
// escape hatch. Detection runs once; a bypassed session never re-gates.
export function maybeMountMobileGate(boot: () => void): boolean {
  let bypassed = false;
  try { bypassed = sessionStorage.getItem(BYPASS_KEY) === '1'; } catch { /* no storage: gate normally */ }
  if (bypassed || !isSmallTouchDevice()) {
    document.documentElement.classList.add('mgate-off');   // release the CSS anti-flash hold
    return false;
  }
  bootApp = boot;
  document.documentElement.classList.add('mgate-on');      // keep #app hidden for good
  const root = el('main', { class: 'mgate', tabindex: '-1' });
  document.body.appendChild(root);
  renderHome(root);
  root.focus();
  return true;
}
