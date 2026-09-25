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
