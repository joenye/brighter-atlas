// The nameplate: the label the game draws over a player's head, drawn over the view as the game draws it.
// Up to three lines, centred over the head, bottom to top: the faction's emblem and the total level in the
// faction's colour (with a guild or lone-wolf badge after it), the name (a free account's number after it in grey),
// and a laurel wreath. Set in the game's own font (a sheet of distance-field glyphs, outlined in black), its
// pictures the game's own, from Fashion's data (nameplate.json and nameplate.png). Like the game's, it keeps one
// size on screen whatever the distance, a little larger as the view closes in; here sized against the view so it
// stands over the character as it does in the game at its usual distance.

export type PlateFaction = 'none' | 'cryoknight' | 'guardian' | 'hammermage';
export type PlateGuild = 'none' | 'guild' | 'wolf';
/** The nameplate as Settings sets it (kept on this device, not part of the look). */
export interface Nameplate { on: boolean; name: string; faction: PlateFaction; level: number; tag: number | null; wreath: boolean; guild: PlateGuild }
export const NAMEPLATE_DEFAULTS: Nameplate = {on: false, name: 'Adventurer', faction: 'none', level: 3, tag: null, wreath: false, guild: 'none'};
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
    tag: int(v.tag, 1, TAG_MAX), wreath: v.wreath === true, guild: PLATE_GUILDS.some(([k]) => k === v.guild) ? v.guild : d.guild};
}

// ---- the game's layout, in its interface pixels (a label unit) ----
/** The label's height over the head, in label units: the gap under it, its lines, a little room above. */
export const plateUnits = (p: Nameplate) => 10 + (p.wreath ? 18 : 0) + 27 + 6;

// ---- its size: the game's interface pixel against the character, at the game's usual distance ----
// The game's camera: 15360 units from the character at its usual zoom, 40 degrees high; an interface pixel there
// taken on a view 1080 pixels high. The label grows as the camera closes in: 1 + clamp(18 - distance / 1024, 0, 16) / 16.
const GAME_DISTANCE = 15360, GAME_UNIT = 2 * GAME_DISTANCE * Math.tan(20 * Math.PI / 180) / 1080;
export const zoomFactor = (distance: number) => 1 + Math.max(0, Math.min(16, 18 - distance / 1024)) / 16;
/** A label unit as a share of the view's height, for a view `fovDeg` high whose full-figure framing is `fullDist`
 *  away, now `dist` away (the full-figure framing standing for the game's usual distance). */
export function plateUnit(dist: number, fullDist: number, fovDeg: number) {
  return zoomFactor(GAME_DISTANCE * dist / fullDist) * GAME_UNIT / (2 * fullDist * Math.tan(fovDeg * Math.PI / 360));
}
