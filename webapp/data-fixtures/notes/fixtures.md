# Fixture dataset

Synthetic data matching the app's exported data-tree schema **exactly** —
used for offline development (`?data=data-fixtures`) and the automated smoke
test. Committed as-is; treat the files as the source of truth.

## Contents

| object | notes |
|---|---|
| mesh 0 | static cube (24v/12t) |
| mesh 1 | skinned tube, rig 0, clip 0 |
| mesh 2 | index-only (`f: null`) |
| mesh 3 | water wave-curtain quad (world fixture) |

- audio 0: 1 s 440 Hz sine (`qoa` badge)
- audio 1: unexported `bslpc` entry (approximate-decoder badge)
- image 0: two sub-images with alpha
- image 2: banded water curtain art (world texture routing)
- world: 2 rooms (`world/index.json` + `world/rooms/*.json`) —
  terrain, a rotated model with a recolor, a component, an
  authored-empty placement, a spawn, and one water tile; the
  columns/enums tables must stay in sync with `src/extract/world/shards.ts`

Index rows carry deterministic `f1c0de…` content hashes (`h`) so
hash-keyed features (names, overrides, Models, Scenes) work here.
