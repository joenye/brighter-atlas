# Brighter Atlas

Fan-made tools for [Brighter Shores](https://www.brightershores.com/), all in
your browser with nothing to install. Live at
[brighteratlas.com](https://brighteratlas.com/).

| Tool | Address | Needs your game files? |
|---|---|---|
| **Brighter Fashion**: design a character and try on every piece of gear | [/fashion](https://brighteratlas.com/fashion) | No |
| **Brighter Maps**: the world map for every game update | [/maps](https://brighteratlas.com/maps) | No |
| **Brighter Data**: everything inside the game files, from your own install | [/data](https://brighteratlas.com/data) | Yes, and they never leave your computer |

The site is one page: moving between the tools loads nothing new, and each
tool's code arrives the first time you open it.

## Brighter Fashion

Design a character on the game's own "Design your character" choices (body,
hair, face, colours) and dress it in any weapon, shield, armour piece or
cosmetic, in every tier and dye, composed the way the game composes a player.
Two-handed weapons, ranged weapons and shields follow the game's own rules,
and faction gear is grouped by faction.

- **Looks**: save them on your device, give them names, undo and redo.
- **Share**: a short link (`brighteratlas.com/l/…`) whose preview in Discord
  and elsewhere shows the look's name and a picture of it. The look also lives
  in the page's address, so any long link keeps working.
- **Pictures**: take a picture of your character on the beach, on one of
  several colour backdrops, or on a transparent one.
- Built for phones as well as desktops.

## Brighter Maps

The game's 2D world map, with its room names and labels, for every game update
since launch. Slide through the updates to watch the world grow, or pick one by
date or game version (like 0.99).

- **Satellite view**: pictures of every room seen from straight above, drawn
  with the game's own shading, lighting and water, with the labels over them.
  **Roofs** off shows what is inside buildings.
- Areas the game has in its files but has not released yet show as dark,
  unnamed silhouettes marked "WIP".
- Built for phones: pinch, double tap and slide, as on a street map.

## Brighter Data

Browse everything inside the game's `assetBundle0…8` cache files from your own
install. An onboarding step asks for the files and which categories to extract,
then decodes them in your browser. Raw bundles stay in the browser's own storage
(OPFS, content-addressed, so a second visit uploads nothing), indexes in
IndexedDB, and decoded pictures and sounds are served on demand by a service
worker. Return visits open in about a second.

- **Meshes**: a three.js viewer with lit, textured, normals, UV-checker and
  bone-influence modes, wireframe, the UV layout, and glTF export.
- **Animation**: every rig with every clip that targets it, with play, scrub,
  speed and loop.
- **Rigs**: every mesh bound to a rig shown together, with body-slot filters on
  the player rig.
- **Models**: the game's own multi-part models (meshes, materials, recolours and
  variants), named the way the game names them, plus your own saved
  combinations, with picture, video and GIF capture. Every character, creature
  and object has its in-game information **card picture** (as a PNG at up to
  4x), and **Show in world** opens a room it appears in with it picked out.
- **World**: every room in 3D, and the whole world stitched together, drawn with
  the game's own shaders, lighting, materials and water. Quest-lit rooms get a
  story slider, people and creatures stand in their own resting animations, and
  particle effects follow the game. With an inspector.
- **2D Maps**: the game's own 2D map of the whole world and of every room,
  filtered by episode, with every placement searchable and inspectable, and PNG
  export at any size.
- **Audio**: a waveform player, with bit-exact QOA and Opus decoding.
- **Images**: zoom and pan, sub-image strips, fonts and colour tables.
- **Text**: the game's full text, with filters.
- **Search**: by index, content-hash prefix or name, everywhere.
- **Annotations**: your own names, saved models and texture reassignments, kept
  by content hash so they survive game updates, managed in one place and
  exportable as one JSON file.
- **Versions**: keep several game builds, switch between them, and compare two
  (added, removed and changed, by content hash).
- **Bulk export**: the decoded tree (JSON, PNG, WAV) to a folder or a .zip; an
  exported tree can itself be browsed with `?data=`.

The **World** and **2D Maps** categories need per-build decode data, which the
site serves for every build since launch. That data is produced offline, purely
from analysis of the game's own files, never by inspecting or modifying a running
game process or its memory. When a new game update is not supported yet,
everything else still works, and support usually follows shortly after.

## What the site serves

Brighter Data works only on the files you bring. Apart from the per-build decode
data above, the site serves game-derived data for the two tools that need no
files:

- **Brighter Maps**: each update's 2D map (terrain, room labels and their
  artwork) and the satellite pictures of its rooms.
- **Brighter Fashion**: the character, its equipment and one scene: meshes,
  textures, rigs, animation clips, pictures and shaders.

## Development

```bash
cd webapp
npm install
npm run build        # the site (esbuild); npm run check runs the type checks
npm run serve        # http://localhost:8321
npm run watch        # rebuild on change
npm run icons        # every icon, from brand/mark.svg
```

The app is TypeScript (`webapp/src/`), built to a static site: one
`index.html` for every address, the shell and each tool's code in `js/` (a
tool's code and stylesheet load when its page first opens) and `sw.js`, the
service worker. The shell and the tools are React components (`src/app/` is
the shell, its router and the address table in `paths.ts`). Drawing is
three.js and WebGL. The other runtime libraries (fzstd, zstd-wasm, fflate, the
Opus decoder, the MP4 encoder for video capture) are vendored in
`webapp/vendor/`.

The tools that need no files read their data from the site's own origin, and
Brighter Fashion's short links need the site's link service. Neither is part of
this repository. Locally, `npm run serve` serves any such data from the folders
named in `BS_EXTRA_ROOT` (colon-separated) beside the site; without it, those two
tools have nothing to show, and sharing falls back to long links.

### Tests

```bash
cd webapp
npm run build && node tools/smoke.ts            # the gate: synthetic fixtures, no game data needed
BS_BUNDLES=/path/to/bundles node tools/e2e.ts   # the whole user path on your own game files
```

`smoke.ts` drives the site in headless Chrome against the committed synthetic
fixtures (`webapp/data-fixtures/`) and asserts zero console errors, painted
canvases, playback, search, navigation and the page layouts. It also runs the
world map's own tests (`tools/test_world.ts`). `e2e.ts` covers the whole path
on real game files: onboarding, extraction, the game's shading, card pictures,
Show in world, names and the 2D maps.

## License

MIT (see [LICENSE](LICENSE)). Brighter Shores is © Fen Research Ltd, and this
is an unaffiliated fan project. This repository contains no game assets. The
site serves only the game-derived data listed under "What the site serves".
