// Help / FAQ modal. The overlay / overlay-click-close / capture-phase Escape
// pattern mirrors main.js openOverridesPanel(); the content reuses only existing
// app.css classes plus a small scoped .help-* block. Copy follows the app's
// terse, second-person, local-first voice (see onboard.js).

import { el } from './ui.js';
import { buildLabel, buildInfoReady } from './build-info.js';

// inline helpers
const b = (t: string) => el('b', { text: t });
const code = (t: string) => el('code', { text: t });
const kbd = (t: string) => el('kbd', { text: t });

// one answer paragraph (strings + inline elements)
const p = (...inline: (string | Node)[]) => el('p', { class: 'help-a' }, ...inline);

// a question followed by one or more answer paragraphs
const qa = (q: string, ...paras: Node[]) => el('div', { class: 'help-qa' },
  el('div', { class: 'help-q', text: q }), ...paras);

// an all-caps divider label followed by its blocks
const section = (title: string, ...blocks: Node[]) => [el('div', { class: 'help-section', text: title }), ...blocks];

export function openHelpModal(): void {
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const keyboardSection = section('Keyboard',
    el('div', { class: 'help-kbds' },
      el('span', {}, kbd('↑'), ' ', kbd('↓'), ' browse the list'),
      el('span', {}, kbd('Space'), ' / ', kbd('Enter'), ' play / pause the selected audio'),
      el('span', {}, kbd('/'), ' focus search'),
      el('span', {}, kbd('Esc'), ' close this / the search')));

  const body = el('div', { class: 'help-body' },
    el('p', { class: 'help-intro' },
      'Brighter Atlas is an independent, fan-made tool for exploring the 3D assets inside ',
      'Brighter Shores: meshes, rigs, animations, images, audio and text, in your browser. ',
      'It is a hobby project.'),

    ...section('Privacy — your data stays on your machine',
      qa('Does anything leave my computer?',
        p('No. Your game files and everything decoded from them stay in your browser. ',
          'Decoding runs locally, and the results are cached in your browser’s own storage. ',
          'There is no upload, no account, and no analytics or telemetry of any kind.'),
        p(el('span', { class: 'dim' }, 'The only thing downloaded is the app’s own code, exactly like any other web page.')))),

    ...section('Getting started',
      qa('Where do the assets come from? (bring your own)',
        p('You supply your own ', code('assetBundle0'), ' … ', code('assetBundle8'),
          ' files from your own Brighter Shores install. The app ships no game data — nothing is hosted, served or uploaded. ',
          code('assetBundle0'), ' (the game’s master index) is always required; the others are only needed for the categories you choose to extract.')),
      qa('How do I use it?',
        p('Point it at your bundle files, pick what to extract, and it decodes everything in your browser. Return visits load instantly from storage.'),
        p('It opens every category with search, a details panel, recovered textures, your names and Models, version comparisons, and bulk export. Skinned meshes play their animations right in the viewer.')),
      qa('What do I need?',
        p('A desktop browser, served over HTTPS or localhost. Mobile isn’t supported — it lacks the memory and storage this needs.'))),

    ...section('What you’re looking at',
      qa('What can I browse?',
        p(b('Meshes'), ' — 3D geometry, with skinned animation playback and lit / textured / normals / UV / bone-weight views. ',
          b('Rigs'), ' — the animation rigs that skinned meshes bind to. ',
          b('Animations'), ' — rig clips.'),
        p(b('Images'), ' — textures, sprites, icons and fonts. ',
          b('Audio'), ' — music and sound effects, with a waveform player. ',
          b('Text'), ' — all of the game’s text.'),
        p(b('World'), ' — the game world in 3D: every room with its placed meshes and spawns, ',
          'one room at a time or merged into the whole map. Extracting it also recovers room names and the ',
          b('System'), ' texture and model catalog: the game’s own mesh-to-texture pairings and models, ',
          'which the rest of the app uses for texturing. ',
          'World is available for supported game builds; if yours is not supported yet, everything else still works. ',
          'Build support is plain decode data, derived purely from analysis of the game’s own files — nothing ever inspects or modifies a running game.')),
      qa('What is a Model?',
        p(b('Models'), ' are yours to make, from either a rig or a single mesh. Open a ', b('rig'),
          ', choose the meshes and textures you want, then hit ', b('❖ Save as Model'),
          ' — it saves that exact composite as a named, reusable entry in the ',
          b('Models'), ' category (the building block for outfits). Or open a single ', b('mesh'),
          ' and hit ', b('❖ Save as Model'), ' there — it becomes a Model with its currently active texture ',
          '(a static mesh has no rig, so no animations). ',
          'Models can be renamed or deleted, and ride along in your ', code('asset_overrides.json'), '.')),
      qa('What are “bundles”?',
        p('The ', code('assetBundle0–8'), ' files are the game’s on-disk asset cache. Roughly: ',
          b('0'), ' is the master index (it points to everything else), ',
          b('1'), ' animations, ', b('2'), ' metadata, ', b('3'), ' images, ',
          b('5'), ' meshes, ', b('6'), ' rigs, ', b('8'), ' audio. ',
          'They’re packed and compressed to save space, so you can’t open them directly — the app unpacks them for you.'))),

    ...section('Textures',
      qa('Do meshes come with their textures?',
        p('Yes. Extracting the ', b('World'), ' category recovers the game’s own ',
          b('System'), ' mesh→texture pairings, so meshes and Models show up already textured — ',
          'switch a mesh to its ', b('Textured'), ' view to see it, and Models carry their full ',
          'recovered material, recolour and variant set.'),
        p('If you want to experiment you can still reassign a texture by hand: the picker lists every image and puts the likeliest first. Any change you make, ',
          'and any friendly names, are saved by a stable id, so they carry across game updates even when assets move around.'))),

    ...section('Comparing game versions',
      qa('What does comparing versions show?',
        p('If you’ve loaded two game versions, you can compare them to see exactly what changed in an update: ',
          'which game files changed, and for each asset whether it was ', b('added / removed / changed / moved'),
          '. Assets are matched by their stable id, so a moved asset shows as moved, never a false add or remove. Images can be compared side by side, pixel for pixel.'))),

    ...section('Saving your work',
      qa('Where do my names and Models go?',
        p('Your friendly names, saved Models and any by-hand texture changes live only in your browser, ',
          'tied to each asset’s stable id. ',
          b('Manage Overrides'), ' previews, loads or exports them as a single ', code('asset_overrides.json'), '. ',
          b('Bulk Export'), ' writes every decoded asset to a folder on disk or a ', code('.zip'),
          ' — either in standard formats (3D as ', code('.glb'), ' for Blender & other tools, images PNG, audio WAV) or as the raw JSON data tree. ',
          'Each viewer also has an ', b('Export'), ' button for the one asset (or Model) on screen.'))),

    ...keyboardSection,

    el('p', { class: 'help-legal small dim' },
      'A fan-made project — not affiliated with or endorsed by Fen Research. ',
      'Brighter Shores, its assets and trademarks belong to Fen Research. ',
      'Bring your own game files; no game data is hosted, served or uploaded.'));

  // build version (Git tag + commit), baked in at deploy time; "dev build" locally
  const verEl = el('b', { text: buildLabel() });
  buildInfoReady.then(() => { verEl.textContent = buildLabel(); });
  body.appendChild(el('p', { class: 'help-ver small dim' }, 'Brighter Atlas · ', verEl));

  const closeBtn = el('button', { class: 'btn primary', text: 'Close', onclick: close });

  overlay.appendChild(el('div', { class: 'modal card help-modal' },
    el('h2', { text: 'Help/FAQs' }),
    body,
    el('div', { class: 'modal-actions' }, el('span', { class: 'spacer' }), closeBtn)));
  document.body.appendChild(overlay);
}
