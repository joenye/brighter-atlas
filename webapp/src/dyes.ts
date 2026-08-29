// Dye colours the user has put on a mesh's dyeable regions.
//
// Equipment textures carry a recolour mask: its RED and GREEN channels select
// the two regions the game dyes at runtime (texture-roles.js `parameter`, the
// last packed plane). The game applies the player's chosen dye there, so the
// albedo authors those regions as flat grey and the viewer, having no dye to
// apply, shows exactly that grey. This module holds the colours to put in their
// place; recolor.js already implements the game's own shader for them.
//
// Persistence mirrors texmap.js's override store, deliberately WITHOUT joining
// it: keyed by the mesh CONTENT HASH (`h`, sha256/16 of the decompressed
// object) so a dye survives bundle re-ordering and re-extraction, authoritative
// copy in IndexedDB 'userdata', localStorage kept as a same-machine backstop,
// and hydrated into a synchronous in-memory mirror at boot. It stays out of
// asset_overrides.json: that file is the portable record of what a mesh IS
// (its textures and its name), while a dye is how you are currently looking at
// it, the same class of thing as which variant is active on screen.

import { userdataGet, userdataPut } from './storage.js';
import type { IndexEntry } from './store.js';

const KEY = 'bs.dyes';
const STORE_KEY = 'dyes';
// Mask channels, in the order the shader reads them (R then G).
export const DYE_REGIONS = 2;

// One mesh's dye: a colour per mask region, null where the region is undyed
// (the shader's neutral white, which leaves that region as the albedo).
export type DyeColor = [number, number, number];
export type MeshDye = (DyeColor | null)[];

interface DyeFile { version: number; dyes: Record<string, MeshDye> }

const cur: DyeFile = { version: 1, dyes: {} };

// The native identity tint: "leave this region as the albedo".
const NEUTRAL: DyeColor = [1, 1, 1];
// The third recolour value is output modulation, half-range, neutral at 0.5
// (see recolor.js). A user dye never modulates the whole surface.
const NEUTRAL_MODULATION: DyeColor = [0.5, 0.5, 0.5];

const isColor = (value: any): value is DyeColor => Array.isArray(value) && value.length === 3
  && value.every((component) => Number.isFinite(component) && component >= 0 && component <= 1);

function normalize(raw: any): MeshDye | null {
  if (!Array.isArray(raw)) return null;
  const dye: MeshDye = [];
  for (let region = 0; region < DYE_REGIONS; region++) {
    dye.push(isColor(raw[region]) ? [...raw[region]] as DyeColor : null);
  }
  return dye.some(Boolean) ? dye : null;
}

// Seed the synchronous mirror from localStorage at module load; hydrateDyes()
// replaces it with the durable IndexedDB copy once that resolves.
try {
  const seed = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (seed?.dyes) {
    for (const [key, raw] of Object.entries(seed.dyes)) {
      const dye = normalize(raw);
      if (dye) cur.dyes[key] = dye;
    }
  }
} catch { /* no seed: an empty mirror is correct */ }

export async function hydrateDyes(): Promise<void> {
  try {
    const stored = await userdataGet(STORE_KEY);
    if (stored?.dyes) {
      for (const key of Object.keys(cur.dyes)) delete cur.dyes[key];
      for (const [key, raw] of Object.entries(stored.dyes)) {
        const dye = normalize(raw);
        if (dye) cur.dyes[key] = dye;
      }
    } else if (Object.keys(cur.dyes).length) {
      await userdataPut(STORE_KEY, JSON.parse(JSON.stringify(cur)));   // one-time migration
    }
  } catch { /* IDB unavailable: the localStorage mirror still works */ }
}

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* storage unavailable */ }
  userdataPut(STORE_KEY, JSON.parse(JSON.stringify(cur))).catch(() => {});
}

// Content hash first, ordinal only when a build has no hashes (as texmap.js).
const dyeKey = (meshEntry: IndexEntry): string => (meshEntry as any).h || `idx:${meshEntry.i}`;

export function meshDye(meshEntry: IndexEntry | null | undefined): MeshDye | null {
  if (!meshEntry) return null;
  const dye = cur.dyes[dyeKey(meshEntry)];
  return dye ? dye.map((color) => (color ? [...color] as DyeColor : null)) : null;
}

// Set (or clear, with null) ONE region's colour. Clearing the last coloured
// region drops the record entirely, so an undyed mesh leaves no trace.
export function setMeshDyeRegion(
  meshEntry: IndexEntry, region: number, color: DyeColor | null,
): void {
  if (region < 0 || region >= DYE_REGIONS) return;
  const key = dyeKey(meshEntry);
  const dye = cur.dyes[key] ? [...cur.dyes[key]] : new Array(DYE_REGIONS).fill(null);
  dye[region] = color && isColor(color) ? [...color] as DyeColor : null;
  if (dye.some(Boolean)) cur.dyes[key] = dye;
  else delete cur.dyes[key];
  save();
}

export function clearMeshDye(meshEntry: IndexEntry): void {
  if (!cur.dyes[dyeKey(meshEntry)]) return;
  delete cur.dyes[dyeKey(meshEntry)];
  save();
}

export function dyedMeshCount(): number { return Object.keys(cur.dyes).length; }

// A dye as recolor.js consumes it: tint per mask region, undyed regions taking
// the native identity, plus the neutral output modulation. `field` names the
// source in the material's recorded recolour state, so a dye is never mistaken
// for a tint recovered from the game data.
export function dyeRecolorInput(dye: MeshDye | null): { field: string; values: number[][] } | null {
  if (!dye || !dye.some(Boolean)) return null;
  return {
    field: 'dye',
    values: [dye[0] || NEUTRAL, dye[1] || NEUTRAL, NEUTRAL_MODULATION].map((c) => [...c]),
  };
}

// #rrggbb <-> the 0..1 triples the shader multiplies by. No colour-space
// conversion on purpose: the recolour formula tints in gamma-ENCODED space
// (recolor.js raises the albedo to 1/2.2 before mixing), which is the same
// space the picker's sRGB bytes are already in, so what you pick is what the
// region becomes and a round trip through the picker is lossless.
export function hexToDyeColor(hex: string): DyeColor | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function dyeColorToHex(color: DyeColor | null): string {
  const [r, g, b] = color || NEUTRAL;
  const byte = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
  return `#${((byte(r) << 16) | (byte(g) << 8) | byte(b)).toString(16).padStart(6, '0')}`;
}
