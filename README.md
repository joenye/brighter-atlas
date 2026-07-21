# Brighter Atlas

Browse everything inside the [Brighter Shores](https://www.brightershores.com/)
asset bundles — meshes with full skinned animation playback, audio, images,
animation clips, rigs, the complete text corpus, and the game's rooms
rendered in 3D (single rooms or the whole stitched world) — entirely in your
browser.

**Fan-made and fully client-side.** You bring your own game files; nothing is
uploaded anywhere and no game data ships with, or is distributed by, this
project. Live at [brighteratlas.com](https://brighteratlas.com/).

## How it works

On first visit an onboarding wizard asks for the game's `assetBundle0…8`
cache files from your own install, lets you pick which categories to extract,
and decodes them in your browser inside a worker. Raw bundles persist in
OPFS (content-addressed, so re-visits re-upload nothing), derived indexes in
IndexedDB, and decoded PNG/WAV payloads are served on demand by a service
worker. Return visits boot from storage in under a second.

The **World** category is available for supported game builds; if your build
isn't supported yet, everything else still works and support usually follows
shortly after a game update. Support for a build is plain decode data,
derived offline purely from analysis of the game's own files — nothing ever
inspects or modifies a running game process.

## Features

- **Meshes** — three.js viewer, Lit/Textured/Normals/UV-checker/Bone-influence
  modes, wireframe, UV-layout overlay, glTF export. Meshes carry the recovered
  System texture; you can optionally reassign one by hand.
- **Skinned animation** — rig build + every clip targeting it, with full
  transport (play/scrub/speed/loop) and persisted preferences.
- **Rigs** — composite preview of every mesh bound to a rig (outfit
  building), body-slot filtering on the player rig.
- **Models** — the game's own recovered multi-part models (mesh + material +
  recolour + variants), plus your own saved combinations, with
  screenshot/video/GIF capture.
- **World** — every room extracted and rendered in 3D, plus the merged
  whole-world view, with water, spawn animation, and an inspector.
- **Audio** — waveform player; bit-exact QOA/Opus decoding.
- **Images** — zoom/pan viewer, sub-image strips, fonts and LUTs.
- **Text** — the game's full text corpus with facet filters.
- **Search** — by index, content-hash prefix, or friendly name, everywhere.
- **Annotations** — friendly names, saved Models, and any by-hand texture
  reassignments, keyed by content hash (they survive game updates), managed in
  one place (topbar → Manage Overrides), exportable as a single JSON file.
- **Versioning** — keep several extracted game builds, switch between them,
  and diff two builds (added/removed/changed by content hash).
- **Bulk export** — write the decoded tree (JSON/PNG/WAV) to a folder on disk
  or a .zip; the exported tree is itself browsable via `?data=`.

## Development

```bash
cd webapp
npm install
npm run build        # typecheck-free bundle (esbuild); npm run check = tsc
npm run serve        # http://localhost:8321
npm run watch        # rebuild on change
```

The app is TypeScript (`webapp/src/`) bundled to a static site: `js/*.js`,
`sw.js` and `index.html` — no framework, no backend. Runtime libraries
(three.js, fzstd, fflate, the Opus decoder) are vendored in `webapp/vendor/`.

### Tests

```bash
cd webapp
npm run build && node tools/smoke.ts     # fixtures + onboarding gate (no game data needed)
BS_BUNDLES=/path/to/bundles node tools/e2e.ts   # full user path against your own game files
```

`smoke.ts` is the pre-release gate: it drives the app in headless Chrome
against the committed synthetic fixtures and asserts zero console errors,
painted 3D canvases, working playback, search and navigation.

## Deployment

This repo is only the app: `webapp/` builds to a fully static site (plain
HTML/JS/CSS, no backend). Where and how it is hosted is not this
repository's concern — deployment happens outside it.

## License

MIT (see [LICENSE](LICENSE)). Brighter Shores is © Fen Research Ltd; this is
an unaffiliated fan project and distributes no game assets.
