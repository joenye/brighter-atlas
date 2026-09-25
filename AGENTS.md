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

## The world map page (the one exception to "bring your own files")

`webapp/index.html` (the site's home page) draws the game's 2D map
for every game update from data the site itself serves under `world-data/`
(see `webapp/src/world-atlas/data.ts` for the layout). That is the only game
content the site distributes, and it is limited to the 2D map: terrain, room
labels and their artwork. Nothing else from
the game is ever served. Areas the game has not shown (sealed episodes) are
never served at all: the data carries only their silhouette, which the page
draws dark under fog with the episode's logo. A new feature that wants hosted game content is a
decision for the maintainer, never a default. The page stays small and
simple: the labels switch, the update list and the date slider.

