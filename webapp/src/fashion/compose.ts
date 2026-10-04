// How the game puts a player together,
// as a pure function: editor state + equipment -> the ordered parts to draw.
//
// Equipment first, in the composer's order and in two passes; an item is
// skipped when an earlier one already claimed a body slot its mask needs.
// Then the body categories, each part skipped when its slot bit is claimed
// and claiming it otherwise (a `$none` mesh claims without drawing). Held
// items (weapons, shields) last.

export type Rgb = [number, number, number];
// material: the ab0 material row (the game frame's programs); spec: its specular bytes (the game's lighting of the part);
// glow: its texture has an emissive mask
export interface DrawPart { key: string; mesh: number; mat: number | null; t1: Rgb; t2: Rgb; material?: number | null; spec?: number[] | null; glow?: boolean;
  /** A book's front cover (u0, v0, u1, v1 of its picture): the site's mark drawn on it. */
  cover?: number[];
  /** A book's open pages (u0, v0, u1, v1 of the picture both read, +v toward their top): a word of thanks across them. */
  pages?: number[];
  /** A sheet of paper (u0, v0, u1, v1 of its picture): a child's drawing on it. */
  drawing?: number[];
  /** Its texture has no recolour plane (nothing to ask for). */
  plain?: boolean }

export const STYLE_CATS = ['hair', 'face', 'jaw', 'torso', 'legs', 'feet'] as const;
export const COLOUR_CATS = ['hair', 'eyes', 'torso', 'legs', 'feet', 'skin'] as const;
export type StyleCat = typeof STYLE_CATS[number];
export type ColourCat = typeof COLOUR_CATS[number];
export const EQUIP_SLOTS = ['head', 'torso', 'legs', 'hands', 'feet', 'cape', 'shield', 'weapon'] as const;
export type EquipSlot = typeof EQUIP_SLOTS[number];

export interface Worn { item: number; variant: number; colour: number | null }   // colour: a dye row id (armour, shields)
export interface State {
  gender: 'male' | 'female';
  style: Record<StyleCat, number>;
  colour: Record<ColourCat, number>;
  equip: Partial<Record<EquipSlot, Worn>>;
}

const NEUTRAL: Rgb = [127 / 255, 127 / 255, 127 / 255];
export const hexRgb = (h: string): Rgb => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) / 255) as Rgb;
const mod = (a: number, n: number) => n ? ((a % n) + n) % n : 0;

export function makeIndex(pack: any) {
  const items = new Map<number, any>(pack.items.map((it: any) => [it.id, it]));
  const colours = new Map<number, string>();
  for (const d of pack.dyes) colours.set(d.id, d.colour);
  return {items, colours};
}

export function styleOption(pack: any, state: State, cat: StyleCat) {
  const list = pack.creator.styles[cat][state.gender];
  return list[mod(state.style[cat], list.length)];
}

// The item's appearance for this gender, and the colour object for `$rarity`.
export function itemAppearance(pack: any, index: ReturnType<typeof makeIndex>, w: Worn | undefined, gender: string) {
  if (!w) return null;
  const item = index.items.get(w.item);
  const v = item?.variants[w.variant] ?? item?.variants[0];
  const a = v?.[gender];
  if (!a) return null;
  // the item's colour object: a cosmetic's own colour, else the dye (Neutral when undyed)
  const colour = v.colour?.rgb ?? index.colours.get(w.colour ?? pack.defaultColour) ?? null;
  return {item, variant: v, a, colour: colour ? hexRgb(colour) : null};
}

export function compose(pack: any, index: ReturnType<typeof makeIndex>, state: State): DrawPart[] {
  const P = pack.creator.palettes;
  const pick = (pal: string[], i: number) => hexRgb(pal[mod(i, pal.length)]);
  const c = state.colour;
  const sym: Record<string, Rgb> = {
    $skin: pick(P.skin, c.skin), $lips: pick(P.lips, c.skin), $hair: pick(P.hair, c.hair),
    $hair_fabric: pick(P.fabric, c.hair), $eyes: pick(P.eyes, c.eyes),
  };
  const resolve = (v: any, base: Rgb | null, rarity: Rgb | null): Rgb => {
    if (v == null) return NEUTRAL;
    if (Array.isArray(v)) return v as Rgb;
    if (v === '$rarity') return rarity ?? NEUTRAL;
    if (sym[v]) return sym[v];
    return base ?? NEUTRAL;   // `$base` and any other symbol: the passed base colour
  };
  const out: DrawPart[] = [];
  const add = (p: any, base: Rgb | null, rarity: Rgb | null, tag: string) => {
    if (p.mesh == null) return;
    const t1 = resolve(p.r1, base, rarity), t2 = resolve(p.r2, base, rarity);
    out.push({key: `${p.mesh}/${p.mat}/${t1.join(',')}/${t2.join(',')}/${tag}`, mesh: p.mesh, mat: p.mat ?? null, t1, t2, material: p.material ?? null, spec: p.spec ?? null, glow: !!p.glow});
  };

  // ---- equipment: worn items by position (0 feet .. 6 cape) ----
  const wornAt: any[] = [];
  const heldList: any[] = [];
  for (const slot of EQUIP_SLOTS) {
    const ap = itemAppearance(pack, index, state.equip[slot], state.gender);
    if (!ap) continue;
    if (ap.a.worn != null) { const w = pack.worn[ap.a.worn]; wornAt[w.pos] = {w, colour: ap.colour, id: ap.a.worn}; }
    // (a weapon's other pieces with it: a bow's arrow, a crossbow's bolt, the second of a pair of throwing knives)
    else if (ap.a.held != null) for (const id of [ap.a.held, ...(ap.a.also ?? [])]) heldList.push({parts: pack.held[id], colour: ap.colour, id});
  }
  const [feet, legs, torso, hands, head, back, cape] = [0, 1, 2, 3, 4, 5, 6].map(i => wornAt[i]);
  // (a torso piece marked `early`, the Shark Hoodies since the 29-Sep-2026 update, goes on with the hands before
  // the head, back and cape: it claims their places first)
  const upper = torso?.w.first ? [torso, hands] : [hands, torso];
  const order = [...(torso?.w.early ? [...upper, head, back, cape] : [head, back, cape, ...upper]),
    ...(legs?.w.first ? [legs, feet] : [feet, legs])].filter(Boolean);
  let accum = 0;
  const useAlt = new Map<any, boolean>();
  for (const pass of [0, 1]) {
    for (const e of order) {
      const w = e.w;
      if (!useAlt.has(e)) useAlt.set(e, !!w.altWhen && (accum & w.altWhen) !== 0);
      const alt = useAlt.get(e);
      const list: number[] = alt ? w.alt : w.parts;
      const mask: number = (alt ? w.altMask : w.mask)[pass];
      if (pass === 1 && !mask) continue;   // the second loop only visits items with a pass-1 mask
      if (accum & mask) continue;
      for (const id of list) { const p = pack.parts[id]; if (p.pass === pass) add(p, null, e.colour, `w${e.id}`); }
      accum |= mask;
    }
  }

  // ---- body, in the composer's order ----
  const body = (list: number[], base: Rgb | null, tag: string) => {
    let claimed = 0;
    for (const id of list) {
      const p = pack.parts[id], bit = 1 << p.slot;
      if (accum & bit) continue;
      add(p, base, null, tag);
      claimed |= bit;
    }
    accum |= claimed;
  };
  const opt = (cat: StyleCat) => styleOption(pack, state, cat);
  body(opt('legs').parts, pick(P.legs, c.legs), 'legs');
  body(pack.creator.hands[state.gender], null, 'hands');
  body(opt('feet').parts, pick(P.feet, c.feet), 'feet');
  body(opt('torso').parts, pick(P.torso, c.torso), 'torso');
  body(opt('jaw').parts, null, 'jaw');
  body(opt('face').parts, null, 'face');
  const hair = opt('hair');
  const short = head && head.w.shortHair && (accum & 1) && hair.alt?.length;
  body(short ? hair.alt : hair.parts, null, 'hair');

  // ---- held: weapons and shields ----
  for (const h of heldList) for (const p of h.parts) add(p, null, h.colour, `h${h.id}`);
  return out;
}

// RANDOM, as the game's Random: every style uniformly, clothing and hair colours over
// 0..31, skin over 0..20, then an eye colour whose level is at most the skin
// tone's limit (the per-skin limit is not known here;
// every level is allowed here).
export function randomise(pack: any, state: State, rnd = Math.random): State {
  const n = (k: number) => Math.floor(rnd() * k);
  const style = {...state.style};
  for (const cat of STYLE_CATS) style[cat] = n(pack.creator.styles[cat][state.gender].length);
  const colour = {...state.colour, feet: n(32), legs: n(32), torso: n(32), skin: n(21), hair: n(32)};
  colour.eyes = n(pack.creator.palettes.eyes.length);
  return {...state, style, colour};
}

// One item's own parts (every pass, primary list), tinted as it would be worn:
// for thumbnails of items the game has no picture for.
/** What an animation holds while it plays (its props: the meshes its controller lists, skinned to the player's rig,
 *  shown and hidden by the clip itself), as parts drawn like the rest of the look (tagged `prop`). */
export function propParts(props: any[] | null | undefined): DrawPart[] {
  return (props ?? []).filter(p => p?.mesh != null).map((p, i) => {
    const t1: Rgb = Array.isArray(p.r1) ? p.r1 : NEUTRAL, t2: Rgb = Array.isArray(p.r2) ? p.r2 : NEUTRAL;
    return {key: `${p.mesh}/${p.mat}/${t1.join(',')}/${t2.join(',')}/prop${i}${p.cover ? '-cover' : ''}`, mesh: p.mesh, mat: p.mat ?? null, t1, t2, material: p.material ?? null,
      spec: p.spec ?? null, glow: !!p.glow, ...(Array.isArray(p.cover) && p.cover.length === 4 ? {cover: p.cover} : {}), ...(Array.isArray(p.pages) && p.pages.length === 4 ? {pages: p.pages} : {}), ...(Array.isArray(p.drawing) && p.drawing.length === 4 ? {drawing: p.drawing} : {}), ...(p.plain ? {plain: true} : {})};
  });
}

export function itemParts(pack: any, index: ReturnType<typeof makeIndex>, w: Worn, gender: string, state: State): DrawPart[] {
  const ap = itemAppearance(pack, index, w, gender);
  if (!ap) return [];
  const P = pack.creator.palettes, c = state.colour;
  const pick = (pal: string[], i: number) => hexRgb(pal[mod(i, pal.length)]);
  const sym: Record<string, Rgb> = {$skin: pick(P.skin, c.skin), $lips: pick(P.lips, c.skin), $hair: pick(P.hair, c.hair), $hair_fabric: pick(P.fabric, c.hair), $eyes: pick(P.eyes, c.eyes)};
  const res = (v: any): Rgb => v == null ? NEUTRAL : Array.isArray(v) ? v as Rgb : v === '$rarity' ? ap.colour ?? NEUTRAL : sym[v] ?? NEUTRAL;
  const list: any[] = ap.a.worn != null ? pack.worn[ap.a.worn].parts.map((id: number) => pack.parts[id]) : pack.held[ap.a.held];
  return list.filter(p => p.mesh != null && !/^\$(skin|lips)$/.test(p.r1 ?? '')).map(p => {
    const t1 = res(p.r1), t2 = res(p.r2);
    return {key: `${p.mesh}/${p.mat}/${t1.join(',')}/${t2.join(',')}/t`, mesh: p.mesh, mat: p.mat ?? null, t1, t2, material: p.material ?? null, spec: p.spec ?? null, glow: !!p.glow};
  });
}

// Worn items the composer dropped whole: an item is skipped when an earlier one (head, back, cape, then
// torso/hands, legs/feet; an `early` torso piece before the head) already claimed any bit of its mask. The
// Shark Hoodies claim the back (bit 12) as every cape does: before the 29-Sep-2026 update a cape hid them;
// since, they go on first and hide the cape (and the hood up, a hat), in the game as here.
// Returns each hidden slot with the equipped slots that cover it (drawn, sharing a bit of its mask).
export function hiddenItems(pack: any, index: ReturnType<typeof makeIndex>, state: State): Map<EquipSlot, EquipSlot[]> {
  const keys = compose(pack, index, state).map(p => p.key);
  const worn = new Map<EquipSlot, {id: number, w: any}>();   // (id: the appearance's, inside the data)
  for (const slot of EQUIP_SLOTS) {
    const ap = itemAppearance(pack, index, state.equip[slot], state.gender);
    if (ap?.a.worn != null) worn.set(slot, {id: ap.a.worn, w: pack.worn[ap.a.worn]});
  }
  const drawn = (id: number) => keys.some(k => k.endsWith(`/w${id}`));
  const out = new Map<EquipSlot, EquipSlot[]>();
  for (const [slot, {id, w}] of worn) {
    if (drawn(id) || !w.parts?.some((p: number) => pack.parts[p]?.mesh != null)) continue;
    const mask = (w.mask?.[0] ?? 0) | (w.altMask?.[0] ?? 0);
    out.set(slot, [...worn].filter(([s, o]) => s !== slot && drawn(o.id) && ((o.w.mask?.[0] ?? 0) & mask)).map(([s]) => s));
  }
  return out;
}
