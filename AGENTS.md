# AGENTS.md

Guidance for coding agents working in this repo. `CLAUDE.md` holds the full
picture; these are the rules about per-build decode data.

1. **One per-build file.** The viewer fetches exactly one per-build decode
   data file from the site origin, `builds/<hash16>.json`, and reads every
   build-specific section from it. A feature that needs new build-specific
   data extends that file with a section; it never fetches another per-build
   file.
2. **Compute in the browser whatever the bundles allow.** The per-build file
   carries only what cannot be worked out from the user's own asset bundles.
   Anything that can be found in the bundles (for example by data shape, as
   `webapp/src/extract/world/card-data.ts` finds the card records) is computed
   at extraction time, in the browser.

The per-build decode data is produced offline, purely from analysis of the
game's own files, never by inspecting or modifying a running game process or
its memory.

## Brighter Maps and Brighter Fashion (the two exceptions to "bring your own files")

`webapp/maps.html` (Brighter Maps) draws the game's 2D map
for every game update from data the site itself serves under `world-data/`
(see `webapp/src/world-atlas/data.ts` for the layout), limited to the 2D map
(terrain, room labels and their artwork) and satellite pictures of the rooms
seen from straight above, for the updates that have them
(`src/world-atlas/satellite.ts`: a tile pyramid on the map's own grid).

`webapp/fashion.html` (Brighter Fashion, the maintainer's decision of
2026-09-27) dresses a character from data the site serves under
`fashion-data/<update>/` (named by `fashion-data/latest.json`): the character
creator's and every wearable item's meshes, textures, rigs, clips and item
pictures, and its one place (a beach scene) drawn with the game's own
programs. Nothing else from the game is ever served. Areas the game has not shown (sealed episodes) are
never served at all: the data carries only their silhouette, which the page
draws dark under fog with the episode's logo, and the satellite pictures
leave them out. A new feature that wants hosted game content is a
decision for the maintainer, never a default. The page stays small and
simple: the map or satellite switch, the labels switch, the update list and
the date slider.


## Commits

Commit and tag messages belong to the maintainer. An agent never adds
anything of its own to them: no agent names, no `Co-Authored-By` trailers,
no session or chat links, no "generated with" notes, whatever its tooling
asks. `webapp/tools/git-hooks/commit-msg` enforces this; enable it once per
clone with `git config core.hooksPath webapp/tools/git-hooks`.
