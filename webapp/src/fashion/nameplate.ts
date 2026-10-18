// The nameplate: the label the game draws over a player's head, drawn over the view as the game draws it.
// Up to three lines, centred over the head, bottom to top: the faction's emblem and the total level in the
// faction's colour (with a guild or lone-wolf badge after it), the name (a free account's number after it in grey),
// and a laurel wreath. Set in the game's own font (a sheet of distance-field glyphs, outlined in black), its
// pictures the game's own, from Fashion's data (nameplate.json and nameplate.png). The game keeps it one size on
// screen whatever the distance (a little larger as its camera closes in); Fashion's views are far closer than the
// game's, so here it keeps its size against the character instead: 0.65 of the size it stands over a character in
// the game seen close (checked against an in-game picture; the game's own reads large over Fashion's close views),
// whatever the framing, times the setting's size.

export type PlateFaction = 'none' | 'cryoknight' | 'guardian' | 'hammermage';
export type PlateGuild = 'none' | 'guild' | 'wolf';
/** The nameplate as Settings sets it (kept on this device, not part of the look). */
export interface Nameplate { on: boolean; name: string; faction: PlateFaction; level: number; tag: number | null; wreath: boolean; guild: PlateGuild; scale: number }
export const NAMEPLATE_DEFAULTS: Nameplate = {on: false, name: 'Adventurer', faction: 'none', level: 3, tag: null, wreath: false, guild: 'none', scale: 1};
/** The size setting's range (1: Fashion's own size, 0.65 of the game's). */
export const SCALE_MIN = 0.2, SCALE_MAX = 1.5;
export const PLATE_FACTIONS: [PlateFaction, string][] = [['none', 'None'], ['cryoknight', 'Cryoknight'], ['guardian', 'Guardian'], ['hammermage', 'Hammermage']];
export const PLATE_GUILDS: [PlateGuild, string, string][] = [['none', 'None', 'No guild badge'], ['guild', 'Guild', 'The guild member’s shield'], ['wolf', 'Lone wolf', 'The lone wolf’s badge']];
export const NAME_MAX = 20, LEVEL_MAX = 99999, TAG_MAX = 9999;
/** The crown the game's own team carry in their names (the one picture a name holds). */
export const CROWN = '\u{1F451}';
/** A name as the label can set it: the printable characters of the game's font and the crown, at most NAME_MAX. */
export const plateName = (s: string) => Array.from(s.replace(/[^\x20-\x7e\u{1F451}]/gu, '')).slice(0, NAME_MAX).join('');
/** The name with the crown before it (and a space), or without it. */
export const crowned = (s: string, on: boolean) => { const bare = s.replace(new RegExp(`^${CROWN} ?`, 'u'), ''); return plateName(on ? `${CROWN} ${bare}` : bare); };
/** The setting from what was kept (or a link's), every field checked: the defaults where one is wrong. */
export function readNameplate(v: any): Nameplate {
  const d = NAMEPLATE_DEFAULTS, int = (x: any, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x <= hi ? x : null;
  if (!v || typeof v !== 'object') return {...d};
  return {on: v.on === true, name: typeof v.name === 'string' ? plateName(v.name) : d.name,
    faction: PLATE_FACTIONS.some(([k]) => k === v.faction) ? v.faction : d.faction, level: int(v.level, 0, LEVEL_MAX) ?? d.level,
    tag: int(v.tag, 1, TAG_MAX), wreath: v.wreath === true, guild: PLATE_GUILDS.some(([k]) => k === v.guild) ? v.guild : d.guild,
    scale: typeof v.scale === 'number' && v.scale >= SCALE_MIN && v.scale <= SCALE_MAX ? v.scale : d.scale};
}

// ---- the game's layout, in its interface pixels (a label unit) ----
/** The label's height over the head, in label units: the gap under it, its lines, a little room above. */
export const plateUnits = (p: Nameplate) => 10 + (p.wreath ? 18 : 0) + 27 + 6;

// ---- its size: a label unit in the scene, as the game's stands over a character ----
// The game's camera: 15360 units from the character at its usual zoom, a 40 degree view; a label unit there is an
// interface pixel of a view 1080 pixels high, grown 1 + clamp(18 - distance / 1024, 0, 16) / 16 times (1.1875).
const GAME_DISTANCE = 15360, LABEL_UNIT = (1 + (18 - GAME_DISTANCE / 1024) / 16) * 2 * GAME_DISTANCE * Math.tan(20 * Math.PI / 180) / 1080;
/** Fashion's own size (the setting's 100%) against the game's. */
const OWN_SIZE = 0.65;
/** A label unit as a share of the view's height, the view `fovDeg` high and the character `dist` away, at size `scale`. */
export function plateUnit(dist: number, fovDeg: number, scale = 1) {
  return scale * OWN_SIZE * LABEL_UNIT / (2 * dist * Math.tan(fovDeg * Math.PI / 360));
}
/** The parts the label stands on: the head's own (a part's key ends in its tag), never what is worn or held on it nor
 *  the rest of the body (headgear that hides the whole head would otherwise bring the label down to the shoulders). */
export const isHeadPart = (key: string) => /\/(face|jaw|hair)$/.test(key);
/** Headgear: a worn piece (a part's key ends `w<item>`) that stays about the head, its lowest point no more than
 *  `HEADGEAR_DROP` below the head bone (a torso piece or a cape reaches far lower). */
export const HEADGEAR_DROP = 250;
/** Clear space between the top of the head (or what is worn on it) and the label, in the scene's units. */
export const PLATE_CLEARANCE = 30;
/** How far over the head bone the label stands: over the head's own parts and any headgear, with a little clear space
 *  (`parts`: each part's key and its lowest and highest point; `headY` the head bone's height). Null with neither. */
export function plateTopOf(parts: {key: string, minY: number, maxY: number}[], headY: number): number | null {
  let top = -Infinity;
  for (const p of parts) {
    const headgear = /\/w\d+$/.test(p.key) && p.minY > headY - HEADGEAR_DROP;
    if (isHeadPart(p.key) || headgear) top = Math.max(top, p.maxY);
  }
  return Number.isFinite(top) ? top - headY + PLATE_CLEARANCE : null;
}
