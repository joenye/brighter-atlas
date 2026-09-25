# CLAUDE.md: Brighter Atlas

A fully client-side viewer for the **Brighter Shores** asset bundles
(engine "mahogany", Fen Research). Users provide their own `assetBundle0` to
`assetBundle8` cache files; everything decodes in-browser. **No game data is
committed, ever, and none is distributed, with one exception:** the world map
page (`index.html`, the site's home page) draws every game update's 2D map
(terrain, room labels and their artwork)
from data the site serves under `world-data/`. Nothing else from the game is
served; widening that is the maintainer's decision (AGENTS.md).

## Layout
- `webapp/`: the app. TypeScript in `src/`, bundled by esbuild
  (`npm run build`) to the static runtime layout: `js/*.js` (main + worker
  entries) and `sw.js` at the webapp root. `vendor/` holds the runtime
  libraries (npm devDeps exist only for their types). `defaults/` ships the
  shared room-name override table (no user annotations). `data-fixtures/` is
  the committed synthetic dataset the smoke test runs against.
- Two pages. `index.html` (the home page, `/`) is the world map:
  `src/world-atlas/` + `css/world.css`, entry `js/world.js`, no game files
  needed. `viewer.html` (`/viewer`) is the viewer for the user's own files,
  entry `js/main.js`. The world map forwards old viewer links (`/#/...`,
  `/?data=...`) to `/viewer` unchanged. Sealed areas (episodes the game has
  not shown) arrive as silhouettes only and are drawn dark under fog by
  `src/world-atlas/sealed.ts`. The world map reuses the
  Maps renderer and camera (`viewers/maps/renderer.ts`, `pan-zoom.ts`);
  `tools/test_world.ts` (run by smoke) covers it on synthetic data.
- Hosting, deployment and release tooling are **not part of this repo**: it
  builds a static site and deliberately knows nothing about where or how
  that site is served.

## Commands
```bash
cd webapp && npm install
npm run check      # tsc --noEmit (the typecheck gate)
npm run build      # esbuild bundle -> js/ + sw.js
npm run serve      # dev server on :8321
node tools/smoke.ts                       # pre-release gate (no game data needed)
BS_BUNDLES=/path/to/bundles node tools/e2e.ts  # full user path, local-only
```

## Load-bearing facts
- **Content hashes are the stable IDs.** Every asset carries `h`
  (sha256/16 of its decompressed bundle object), computed during extraction.
  All user annotations (texture overrides + friendly names) are keyed by `h`
  so they survive bundle re-ordering across game updates.
- **One annotations file.** User overrides + names form a single
  `asset_overrides.json` (`{version:2, overrides, names}`), managed ONLY via
  the topbar "Manage Overrides" dialog. Don't scatter save/load UI.
  Deliberately outside it: dye colours (`dyes.ts`), which say how you are
  looking at a mesh rather than what it IS. They persist the same way
  (IndexedDB `userdata`, keyed by mesh content hash) but are not part of the
  portable file, and they add no save/load UI of their own.
- **The runtime layout is a contract.** `viewer.html` loads `js/main.js`,
  `index.html` loads `js/world.js`;
  workers are spawned by path (`js/extract/worker.js`, …); the service worker
  must stay at the webapp root (`sw.js`) so its scope covers the page, and it
  serves decoded payloads at `cs/<versionId>/…`. The esbuild config
  (`tools/build.ts`) maps entry points to exactly these paths. Keep it
  that way.
- **World and 2D Maps support is per game build**: the app looks up per-build
  data on the site origin at extraction time; an unsupported build simply
  lacks those categories and everything else keeps working.
- **Categories.** Meshes, Images, Audio, Animations, Rigs, Text, World, 2D
  Maps and Models. 2D Maps (`extract/maps/`, `viewers/maps.ts` +
  `viewers/maps/`) reads the game's own map records and draws them with its
  terrain and label artwork; the world map page reuses its renderer. Card
  pictures (`extract/world/card-data.ts`, `viewers/world/card.ts`,
  `viewers/card-modal.ts`) render a model's in-game Info card with the
  game's own camera, pose and lights.
- **World decode is build-agnostic** (older builds shift their structural
  layout). Never hardcode an absolute generic-field op position or a
  fixed-offset field base in `extract/world/*`: older builds pack these
  differently. Detect the position/offset from the data per build and GUARD it
  to fall back to the current-build default, so supported builds stay
  byte-identical (the e2e must not move). Working examples that carry an older
  build (`a14d7c…`, 2024): `graph.ts` `_ensureStructuralOps` (visual-owner
  dims/bounds ops), `_ensureBlockFaceOffset` (block face-table base + the
  `terrainParts` custom-mesh guard), and `room.ts` `ownerAnchored` (room-name
  heap self-instance anchor). How the per-build profile is derived is out of
  scope for this repo: here it is only opaque per-build decode data, produced
  offline purely from analysis of the game's own files: no running game
  process is ever inspected or modified. Any public copy that mentions this
  data must stress that fact.
- **One per-build file (AGENTS.md).** Build-specific decode data is one file,
  `builds/<hash16>.json`; new build-specific data extends it rather than adding
  a file, and anything computable from the user's bundles is computed at
  extraction instead of shipped.
- **Derive by shape.** Build-specific values the user's bundles can tell are
  found by data shape at extraction, the same rule on every build:
  `extract/world/render-shape.ts` (draw tables, materials, environments),
  `placement-shape.ts` (rooms, water, tiles), `effect-shape.ts`,
  `card-data.ts`, `extract/maps/map-shape.ts`. Anchor record types by the type
  table's ids (`typesWithId`), which stay the same across builds; never by
  runtime class numbers, which change every build. A regression here is
  silent (the viewer falls back to plain drawing), so the e2e asserts the
  derived data directly.
- **Extraction timing.** The texture pass runs in pooled workers while the
  ingest thread does every pass that needs no texture results; the ingest
  thread also hands the pool its chunks, so it keeps a deeper queue
  (`poolQueueDepth`) through long synchronous passes. That window is full:
  new extraction work goes in its own worker (the 2D map runs beside World)
  or must be measured against the previous release. A large derived record
  made of many small objects costs the ingest thread its structured clone
  twice (worker message, then store): hand it over as JSON text built off
  that thread (the 2D map's room data). Never read scattered
  bundle objects through the sequential slab reader (a fresh 16 MB slab per
  object); read them individually.
- **The production host serves a Content-Security-Policy** that must stay in
  sync with the app's loading behavior. Verify the app runs clean under a
  policy locally: `BS_CSP="<policy>" node tools/smoke.ts`.

## Git
- Never commit game assets, bulk extraction output, `webapp/data/`,
  build output (`webapp/js/`, `webapp/sw.js`), or screenshots. One sanctioned
  exception: `webapp/assets/` holds the small set of curated app-UI preview
  images the mobile gate shows (screenshots OF the app, deliberately sized
  and named `preview-*`); nothing else lands there.
- Conventional Commits (`type: summary`); one coherent change per commit;
  smoke green before committing app changes.
- No em dashes, en dashes, or emojis anywhere: code, comments, docs,
  commits, PR text, or player-facing copy. Use commas, colons, parentheses,
  or "to" for ranges. (An emoji that stands in for a real label still needs
  its real t() text.)
- Releases are annotated `v*` tags carrying a structured, player-facing
  What's-new (subject + body: the in-app changelog and version name are
  generated from it). Tagging and shipping are done by external tooling,
  never by hand from this repo.
- Release notes are for players: written for amateur, non-technical users.
  No build, code, RE or AI/LLM jargon, no commit-level detail (the in-app
  What's new renders summaries only, never commit lists). Patch releases
  that do not warrant notes get a subject-only tag (`Brighter Atlas X.Y.Z`,
  empty body) and NEVER appear in the in-app changelog: the newest release
  with a written What's-new stays the headline.
