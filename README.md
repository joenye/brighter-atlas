# Brighter Atlas

Browse everything inside the [Brighter Shores](https://www.brightershores.com/)
asset bundles: meshes with full skinned animation playback, audio, images,
animation clips, rigs, the complete text corpus, the game's models with their
in-game card pictures, its rooms rendered in 3D the way the game draws them
(single rooms or the whole stitched world) and its own 2D maps, entirely in
your browser.

**Fan-made and fully client-side.** You bring your own game files; nothing is
uploaded anywhere and no game data ships with, or is distributed by, this
project, with one exception: the world map (below). Live at
[brighteratlas.com](https://brighteratlas.com/).

**World map, no game files needed.** The home page,
[brighteratlas.com](https://brighteratlas.com/), shows the game's 2D world
map, with its room labels, for every game update. Pick an update from the
list (search by game version, like 0.99, or by date) or slide through the
dates to watch the world change. Built for phones.
This page, alone, draws from map data the site serves (the map's terrain,
labels and their artwork, for each update).

**The viewer, with your own game files:**
[brighteratlas.com/viewer](https://brighteratlas.com/viewer).

## How it works

On first visit an onboarding wizard asks for the game's `assetBundle0…8`
cache files from your own install, lets you pick which categories to extract,
and decodes them in your browser inside a worker. Raw bundles persist in
OPFS (content-addressed, so re-visits re-upload nothing), derived indexes in
IndexedDB, and decoded PNG/WAV payloads are served on demand by a service
worker. Return visits boot from storage in under a second.

The **World** and **2D Maps** categories are available for supported game
builds (every build since launch is supported); if a new build isn't supported
yet, everything else still works and support usually follows shortly after a
game update. Support for a build is plain decode data,
derived offline purely from analysis of the game's own files: nothing ever
inspects or modifies a running game process.

## Features

- **Meshes**: three.js viewer, Lit/Textured/Normals/UV-checker/Bone-influence
  modes, wireframe, UV-layout overlay, glTF export. Meshes carry the recovered
  System texture; you can optionally reassign one by hand.
- **Skinned animation**: rig build + every clip targeting it, with full
  transport (play/scrub/speed/loop) and persisted preferences.
- **Rigs**: composite preview of every mesh bound to a rig (outfit
  building), body-slot filtering on the player rig.
- **Models**: the game's own recovered multi-part models (mesh + material +
  recolour + variants), named the way the game names them, plus your own saved
  combinations, with screenshot/video/GIF capture. Every character, creature
  and object has its in-game information **card picture** (downloadable as a
  PNG at up to 4x), and **Show in world** lists the rooms a model appears in
  and opens one with the model picked out.
- **World**: every room extracted and rendered in 3D, plus the merged
  whole-world view. Rooms are drawn with the game's own shaders, lighting,
  materials and water; quest-lit rooms get a story slider; people and
  creatures rest in their own animations; particle effects follow the game.
  With an inspector.
- **2D Maps**: the game's own 2D map for the whole world and every room, as
  the game draws it (terrain, labels, badges), filtered by episode, with each
  room's placements searchable and inspectable, and PNG export at the size you
  choose.
- **World map** (the home page, no game files needed): the 2D world map for
  every game update since launch, with a date slider to watch it change.
- **Audio**: waveform player; bit-exact QOA/Opus decoding.
- **Images**: zoom/pan viewer, sub-image strips, fonts and LUTs.
- **Text**: the game's full text corpus with facet filters.
- **Search**: by index, content-hash prefix, or friendly name, everywhere.
- **Annotations**: friendly names, saved Models, and any by-hand texture
  reassignments, keyed by content hash (they survive game updates), managed in
  one place (topbar → Manage Overrides), exportable as a single JSON file.
- **Versioning**: keep several extracted game builds, switch between them,
  and diff two builds (added/removed/changed by content hash).
- **Bulk export**: write the decoded tree (JSON/PNG/WAV) to a folder on disk
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
`sw.js`, `viewer.html` (the viewer) and `index.html` (the world map): no
framework, no backend. Runtime libraries
(three.js, fzstd, fflate, the Opus decoder) are vendored in `webapp/vendor/`.

### Tests

```bash
cd webapp
npm run build && node tools/smoke.ts     # fixtures + onboarding gate (no game data needed)
BS_BUNDLES=/path/to/bundles node tools/e2e.ts   # full user path against your own game files
```

`smoke.ts` is the pre-release gate: it drives the app in headless Chrome
against the committed synthetic fixtures and asserts zero console errors,
painted 3D canvases, working playback, search and navigation. It also runs
`tools/test_world.ts`, the world map against synthetic map data. `e2e.ts`
covers the whole user path on real game files, including the game's shading,
card pictures, Show in world, names and the 2D maps.

## Deployment

This repo is only the app: `webapp/` builds to a fully static site (plain
HTML/JS/CSS, no backend). Where and how it is hosted is not this
repository's concern: deployment happens outside it.

## License

MIT (see [LICENSE](LICENSE)). Brighter Shores is © Fen Research Ltd; this is
an unaffiliated fan project. It distributes no game assets, apart from the
world map's 2D map data on the site's home page.
