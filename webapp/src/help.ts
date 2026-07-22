// Help / FAQ content + modal. buildHelpContent() returns the content column,
// shared verbatim by the desktop modal here and the mobile gate's inline view
// (mobile-gate.ts); openHelpModal() adds the modal chrome. The overlay /
// overlay-click-close / capture-phase Escape pattern mirrors main.js
// openOverridesPanel(); the content reuses only existing app.css classes plus
// a small scoped .help-* block. Copy follows the app's terse, second-person,
// local-first voice (see onboard.js).

import { el } from './ui.js';
import { buildLabel, buildInfoReady } from './build-info.js';

// inline helpers
const b = (t: string) => el('b', { text: t });
const code = (t: string) => el('code', { text: t });

// one answer paragraph (strings + inline elements)
const p = (...inline: (string | Node)[]) => el('p', { class: 'help-a' }, ...inline);

// a question followed by one or more answer paragraphs
const qa = (q: string, ...paras: Node[]) => el('div', { class: 'help-qa' },
  el('div', { class: 'help-q', text: q }), ...paras);

// an all-caps divider label followed by its blocks
const section = (title: string, ...blocks: Node[]) => [el('div', { class: 'help-section', text: title }), ...blocks];

// The full help content column (.help-body): everything except the modal
// chrome, so the mobile gate can render the very same nodes full-page.
export function buildHelpContent(): HTMLElement {
  const body = el('div', { class: 'help-body' },
    el('p', { class: 'help-intro' },
      'Brighter Atlas is an independent, fan-made tool for exploring the 3D assets inside ',
      'Brighter Shores: meshes, rigs, animations, images, audio and text, in your browser. ',
      'It is a hobby project.'),

    ...section('Privacy: your data stays on your machine',
      qa('Does anything leave my computer?',
        p('No. Your game files and everything decoded from them stay in your browser. ',
          'Decoding runs locally, and the results are cached in your browser’s own storage. ',
          'There is no upload, no account, and no analytics or telemetry of any kind.'),
        p(el('span', { class: 'dim' }, 'The only thing downloaded is the app’s own code, exactly like any other web page.')))),

    ...section('Getting started',
      qa('What do I need?',
        p('A desktop browser and your own Brighter Shores install. Mobile isn’t supported: it lacks the memory and storage this needs.')),
      qa('Where do the assets come from? (bring your own)',
        p('You supply your own ', code('assetBundle0'), ' … ', code('assetBundle8'),
          ' files from your own Brighter Shores install. The app ships no game data: nothing is hosted, served or uploaded. ',
          code('assetBundle0'), ' (the game’s master index) is always required; the others are only needed for the categories you choose to extract.')),
      qa('How do I use it?',
        p('Point it at your bundle files, pick what to extract, and it decodes everything in your browser. Return visits load instantly from storage.'))),

    ...section('What you’re looking at',
      qa('What can I browse?',
        p(b('Meshes'), ': 3D geometry, with skinned animation playback and lit / textured / normals / UV / bone-weight views. ',
          b('Rigs'), ': the animation rigs that skinned meshes bind to. ',
          b('Animations'), ': rig clips.'),
        p(b('Images'), ': textures, sprites, icons and fonts. ',
          b('Audio'), ': music and sound effects, with a waveform player. ',
          b('Text'), ': all of the game’s text.'),
        p(b('World'), ': the game world in 3D, every room with its placed meshes and spawns, ',
          'one room at a time or merged into the whole map. Extracting it also recovers room names and the ',
          b('System'), ' texture and model catalog: the game’s own mesh-to-texture pairings and models, ',
          'which the rest of the app uses for texturing. ',
          'World is available for supported game builds; if yours is not supported yet, everything else still works. ',
          'Build support is plain decode data, derived purely from analysis of the game’s own files: nothing ever inspects or modifies a running game.')),
      qa('What are “bundles”?',
        p('The ', code('assetBundle0'), ' to ', code('assetBundle8'), ' files are the game’s on-disk asset cache. Roughly: ',
          b('0'), ' is the master index (it points to everything else), ',
          b('1'), ' animations, ', b('2'), ' metadata, ', b('3'), ' images, ',
          b('5'), ' meshes, ', b('6'), ' rigs, ', b('8'), ' audio. ',
          'They’re packed and compressed to save space, so you can’t open them directly. The app unpacks them for you.'))),

    el('p', { class: 'help-legal small dim' },
      'A fan-made project, not affiliated with or endorsed by Fen Research. ',
      'Brighter Shores, its assets and trademarks belong to Fen Research. ',
      'Bring your own game files; no game data is hosted, served or uploaded.'));

  // build version (Git tag + commit), baked in at deploy time; "dev build" locally
  const verEl = el('b', { text: buildLabel() });
  buildInfoReady.then(() => { verEl.textContent = buildLabel(); });
  body.appendChild(el('p', { class: 'help-ver small dim' }, 'Brighter Atlas · ', verEl));

  return body;
}

export function openHelpModal(): void {
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const closeBtn = el('button', { class: 'btn primary', text: 'Close', onclick: close });

  overlay.appendChild(el('div', { class: 'modal card help-modal' },
    el('h2', { text: 'Help/FAQs' }),
    buildHelpContent(),
    el('div', { class: 'modal-actions' }, el('span', { class: 'spacer' }), closeBtn)));
  document.body.appendChild(overlay);
}
