// A look as its links carry it: base64url of {g, s, c, e} (gender, the styles and colours in the lists' order,
// the worn slots), the same code the address, a saved look and a short link hold; a shared look adds p, the pose its
// link opens in and its preview picture shows (1 the combat-ready stance, weapons out; 0 at rest). After it, the
// address may name the place behind the character: "#<code>.<place>".
import {STYLE_CATS, COLOUR_CATS, EQUIP_SLOTS, type State, type EquipSlot} from './compose.js';

export const DEFAULT_LOOK: State = {gender: 'male', style: {hair: 7, face: 0, jaw: 8, torso: 9, legs: 1, feet: 1}, colour: {hair: 0, eyes: 12, torso: 2, legs: 25, feet: 20, skin: 5}, equip: {}};

export function encodeLook(s: State): string {
  const e: any = {g: s.gender === 'male' ? 0 : 1, s: STYLE_CATS.map(k => s.style[k]), c: COLOUR_CATS.map(k => s.colour[k]), e: {}};
  for (const slot of EQUIP_SLOTS) { const w = s.equip[slot]; if (w) e.e[slot] = [w.item, w.variant, w.colour ?? 0]; }
  return btoa(JSON.stringify(e)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The look in `code`, or null when it is not one; items `known` does not know are left out. */
export function decodeLook(code: string | null, known: (item: number) => boolean): State | null {
  if (!code) return null;
  try {
    const e = JSON.parse(atob(code.replace(/-/g, '+').replace(/_/g, '/')));
    const st: State = {gender: e.g ? 'female' : 'male', style: {...DEFAULT_LOOK.style}, colour: {...DEFAULT_LOOK.colour}, equip: {}};
    STYLE_CATS.forEach((k, i) => { if (Number.isInteger(e.s?.[i])) st.style[k] = e.s[i]; });
    COLOUR_CATS.forEach((k, i) => { if (Number.isInteger(e.c?.[i])) st.colour[k] = e.c[i]; });
    for (const [slot, v] of Object.entries(e.e ?? {}) as any) {
      if ((EQUIP_SLOTS as readonly string[]).includes(slot) && known(v[0])) st.equip[slot as EquipSlot] = {item: v[0], variant: v[1] | 0, colour: v[2] || null};
    }
    return st;
  } catch { return null; }
}

const parse = (code: string) => JSON.parse(atob(code.replace(/-/g, '+').replace(/_/g, '/')));
const pack = (e: any) => btoa(JSON.stringify(e)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** The look's code with its pose: the combat-ready stance or at rest. */
export function withPose(code: string, combat: boolean): string {
  try { const e = parse(code); delete e.p; return pack({...e, p: combat ? 1 : 0}); } catch { return code; }
}
/** The pose a code names: true the combat-ready stance, false at rest, null none (a look shared before poses were). */
export function lookPose(code: string | null | undefined): boolean | null {
  if (!code) return null;
  try { const p = parse(code).p; return p === 1 ? true : p === 0 ? false : null; } catch { return null; }
}

/** A moment of the look, as Share took it: `a` an animation stopped part way, [its name, the part playing (of a
 *  three-part one), the tick into that part]; `v` the view, [the turn in thousandths of a radian, the distance, the
 *  height looked at]. A shared code carries it, so its link's picture shows what Share showed. */
export interface Shot { a?: [string, number, number] | null; v?: [number, number, number] | null }
const ints = (x: any, n: number) => Array.isArray(x) && x.length === n && x.every((v: any) => Number.isInteger(v)) ? x as number[] : null;
const anim = (x: any) => Array.isArray(x) && x.length === 3 && typeof x[0] === 'string' && x[0] && Number.isInteger(x[1]) && Number.isInteger(x[2]) ? x as [string, number, number] : null;
/** The code with a moment (none: the code without one). */
export function withShot(code: string, shot: Shot | null): string {
  try {
    const e = parse(code); delete e.a; delete e.v;
    return pack({...e, ...(shot?.a ? {a: shot.a} : {}), ...(shot?.v ? {v: shot.v} : {})});
  } catch { return code; }
}
/** The moment a code names, or null. */
export function lookShot(code: string | null | undefined): Shot | null {
  if (!code) return null;
  try { const e = parse(code), a = anim(e.a), v = ints(e.v, 3) as Shot['v']; return a || v ? {a, v} : null; } catch { return null; }
}

// (links, saved looks and choices from before the rename name the beach by its room: East Beach)
export const placeId = (p: string | null | undefined) => p === 'east-beach' ? 'beach' : p ?? null;
/** The address's look code and place. */
export const addressLook = () => { const [code, place] = location.hash.slice(1).split('.'); return {code, place: placeId(place)}; };
