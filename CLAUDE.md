# CLAUDE.md — Brighter Atlas

A fully client-side viewer for the **Brighter Shores** asset bundles
(engine "mahogany", Fen Research). Users provide their own `assetBundle0–8`
cache files; everything decodes in-browser. **No game data is committed or
distributed — ever.**

## Layout
- `webapp/` — the app. TypeScript in `src/`, bundled by esbuild
  (`npm run build`) to the static runtime layout: `js/*.js` (main + worker
  entries) and `sw.js` at the webapp root. `vendor/` holds the runtime
  libraries (npm devDeps exist only for their types). `defaults/` ships the
  shared room-name override table (no user annotations). `data-fixtures/` is
  the committed synthetic dataset the smoke test runs against.
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
- **The runtime layout is a contract.** `index.html` loads `js/main.js`;
  workers are spawned by path (`js/extract/worker.js`, …); the service worker
  must stay at the webapp root (`sw.js`) so its scope covers the page, and it
  serves decoded payloads at `cs/<versionId>/…`. The esbuild config
  (`tools/build.ts`) maps entry points to exactly these paths — keep it
  that way.
- **World support is per game build**: the app looks up per-build data on
  the site origin at extraction time; an unsupported build simply lacks the
  World category and everything else keeps working.
- **World decode is build-agnostic** (older builds shift their structural
  layout). Never hardcode an absolute generic-field op position or a
  fixed-offset field base in `extract/world/*` — older builds pack these
  differently. Detect the position/offset from the data per build and GUARD it
  to fall back to the current-build default, so supported builds stay
  byte-identical (the e2e must not move). Working examples that carry an older
  build (`a14d7c…`, 2024): `graph.ts` `_ensureStructuralOps` (visual-owner
  dims/bounds ops), `_ensureBlockFaceOffset` (block face-table base + the
  `terrainParts` custom-mesh guard), and `room.ts` `ownerAnchored` (room-name
  heap self-instance anchor). How the per-build profile is derived is out of
  scope for this repo: here it is only opaque per-build decode data, produced
  offline purely from analysis of the game's own files — no running game
  process is ever inspected or modified. Any public copy that mentions this
  data must stress that fact.
- **The production host serves a Content-Security-Policy** that must stay in
  sync with the app's loading behavior. Verify the app runs clean under a
  policy locally: `BS_CSP="<policy>" node tools/smoke.ts`.

## Git
- Never commit game assets, bulk extraction output, `webapp/data/`,
  build output (`webapp/js/`, `webapp/sw.js`), or screenshots.
- Conventional Commits (`type: summary`); one coherent change per commit;
  smoke green before committing app changes.
- Releases are annotated `v*` tags carrying a structured, player-facing
  What's-new (subject + body — the in-app changelog and version name are
  generated from it). Tagging and shipping are done by external tooling,
  never by hand from this repo.
