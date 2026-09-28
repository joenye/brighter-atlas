// Brighter Data on a phone: a dialog over the app, not a page in its place. Data is built for desktop (it
// decodes the whole game in the browser), so a phone is told so once per visit, with the tools that do work on
// a phone (Brighter Fashion, Brighter Maps) and the Discord; the dialog then gets out of the way (Continue, the
// close button, Escape or a tap outside), and the app beneath works as it can. The Discord link is CLONED from
// the top bar's markup in viewer.html (its URL and icon live only there). Styles: the .mgate-* block of
// css/app.css.

import { toolUrl } from './sites.js';
import { el, DESKTOP_ONLY_LINE } from './ui.js';

const SEEN_KEY = 'bs.mobileGateBypass';   // (dismissed this visit)

// Feature-based, evaluated once: the PRIMARY pointer must be coarse AND the device must be touch AND the
// viewport must be phone-sized. A desktop browser in a narrow window has a fine primary pointer (even on a
// touch-screen laptop), so it never sees the dialog.
function isSmallTouchDevice(): boolean {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const touch = (navigator.maxTouchPoints || 0) > 0;
  const small = Math.min(screen.width, screen.height) < 768 || innerWidth < 820;
  return coarse && touch && small;
}

/** On a phone, once per visit: the desktop-only dialog over the app. */
export function maybeShowMobileNotice(host: HTMLElement = document.body): void {
  let seen = false;
  try { seen = sessionStorage.getItem(SEEN_KEY) === '1'; } catch { /* no storage: show it */ }
  if (seen || !isSmallTouchDevice()) return;

  const overlay = el('div', { class: 'modal-overlay mgate-overlay' });
  const close = () => {
    try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* no storage: this page only */ }
    overlay.remove(); document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const mark = () => el('img', { class: 'mgate-action-ico', src: 'brand/mark.svg', alt: '', width: '20', height: '20' });
  // (the tools open in place: the dialog is done with)
  const actions = el('div', { class: 'mgate-actions' },
    el('a', { class: 'mgate-action', href: toolUrl('fashion'), onclick: close }, mark(), 'Brighter Fashion'),
    el('a', { class: 'mgate-action', href: toolUrl('maps'), onclick: close }, mark(), 'Brighter Maps'));
  const discord = document.querySelector<HTMLElement>('#topbar .top-social.discord')?.cloneNode(true) as HTMLElement | undefined;
  if (discord) { discord.classList.remove('btn-mini'); discord.classList.add('mgate-action'); actions.append(discord); }

  const cont = el('button', { class: 'btn btn-cta mgate-continue', type: 'button', text: 'Continue to Brighter Data', onclick: close });
  overlay.append(el('div', { class: 'modal card mgate', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mgate-title' },
    el('button', { class: 'mgate-close', type: 'button', 'aria-label': 'Close', text: '✕', onclick: close }),
    el('h2', { class: 'mgate-title', id: 'mgate-title', text: 'Brighter Data is built for desktop' }),
    el('p', { class: 'mgate-lede' },
      'It opens everything inside Brighter Shores from your own game files, entirely in your browser. ',
      DESKTOP_ONLY_LINE),
    el('p', { class: 'mgate-lede' }, 'On your phone, try these instead:'),
    actions,
    cont));
  host.append(overlay);   // (in Data's page: it goes with the page when another shows)
  // (on the screen as it is: the desktop app beneath is wider than a phone, which widens the page itself)
  const vv = window.visualViewport;
  const fit = () => { if (vv) Object.assign(overlay.style, { left: `${vv.offsetLeft}px`, top: `${vv.offsetTop}px`, width: `${vv.width}px`, height: `${vv.height}px`, right: 'auto', bottom: 'auto' }); };
  fit(); vv?.addEventListener('resize', fit); vv?.addEventListener('scroll', fit);
  cont.focus();
}
