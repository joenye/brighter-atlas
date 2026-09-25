// Record names: the name the game shows for a registry row, recovered from the
// shape of the data alone (no record, runtime or field numbers).
//
// A row's text members take several value shapes: a plain string, a styled or
// composed text (a typed value whose leaves are only strings, colours and
// numbers: its leaves joined), a descriptor (name, subtitle, icon, category,
// flag) or a reference to a row that has a name of its own. The rules, in
// order:
//
//   type row    an internal snake_case id, a reference to a family row and a
//               qualifier (or the none symbol), consistent with the id's words:
//               qualifier + " " + the family's singular ("Belligerent" +
//               "Goblin Miner"); enemy, item and resource types share it
//   tier row    one short qualifier and a family that lists the row back
//               ("Basic" + "Fishing Spear"), the qualifier shared by several
//               families
//   stated twice  a text held by two or more members of the row (actors,
//               objects and items restate their name); a restated reference
//               counts when it points at a type, family or tier row
//   family      a row stating a singular and its plural: the singular
//   title       the one name-shaped title at a position that is a name
//               position across the row's runtime
//   reference   a reference at such a position to a type or family row
//
// Then: a row named only by a family (an enemy template) takes the name of the
// one type row of that family that references it; a row naming a stack plural
// keeps the singular. Action words are the one text a runtime states on nearly
// every row and several runtimes share ("Talk to", "Use item on").

import type {FillRow} from './replay.js';
import type {PoolNode} from './value-pool.js';
import type {ReparsedOp} from './effects.js';
import {isDescriptorShape} from './object-descriptors.js';

export interface RecordName {
  name: string;
  /** The singular form, when the name is a stack plural. */
  singular?: string;
  /** The family's singular, for type and tier rows and rows that restate them. */
  base?: string;
  rule: string;
}

export interface RecordNames {
  nameOf(slot: number): RecordName | null;
  /** internal id -> display name, for type rows ("glinteye_deathcrow"). */
  byInternal: Map<string, string>;
}

type TextValue =
  | { kind: 'str' | 'composed' | 'descriptor'; text: string }
  | { kind: 'ref'; ref: number }
  | { kind: 'list'; items: TextValue[] };

const isInt = (v: unknown): v is number => Number.isInteger(v);
const SNAKE = /^[a-z0-9]+(?:_[a-z0-9()%.×#+\u{F0000}-\u{FFFFF}]+)+$|^[a-z][a-z0-9]*$/u;
const SENTENCE = /[.!?…]["')]?$/;
/** Display text without the font's private-use symbol glyphs, spaces collapsed. */
const clean = (t: string) => t.replace(/[\u{F0000}-\u{FFFFF}]/gu, ' ').replace(/\s+/g, ' ')
  .replace(/ ([)\],.])/g, '$1').replace(/([([]) /g, '$1').trim();
/** A text that can be a name: short, not a sentence, id or symbol, with letters,
 *  not lowercase-led (lowercase-led composed texts are verb phrases: "fight "). */
const nameLike = (t: string) => !!t && t.length <= 60 && !SENTENCE.test(t) && !SNAKE.test(t) && !t.startsWith('$')
  && /[A-Za-zÀ-ɏ].*[A-Za-zÀ-ɏ]/u.test(t) && !/^\p{Ll}/u.test(t);
const words = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
function isPlural(sing: string, t: string): boolean {
  if (t === sing) return false;
  if (t === sing + 's' || t === sing + 'es') return true;
  if (sing.endsWith('y') && t === sing.slice(0, -1) + 'ies') return true;
  if (sing.endsWith('f') && t === sing.slice(0, -1) + 'ves') return true;
  if (sing.endsWith('fe') && t === sing.slice(0, -2) + 'ves') return true;
  if (/man$/.test(sing) && t === sing.replace(/man$/, 'men')) return true;
  const sw = sing.split(' '), tw = t.split(' ');
  return sw.length > 1 && tw.length === sw.length && tw.slice(0, -1).join(' ') === sw.slice(0, -1).join(' ')
    && isPlural(sw[sw.length - 1], tw[tw.length - 1]);
}

export function recordNames(src: {
  rows: FillRow[]; pool: PoolNode[]; charset: ArrayLike<string>; symbols: string[];
  decode: (slot: number) => ReparsedOp[] | null;
}): RecordNames {
  const { rows, pool, charset, symbols } = src;
  const deref = (n: any): any => { let k = 0; while (n && n.tag === 0 && k++ < 64) n = pool[n.value]; return n; };
  const glyphs = (vals: number[]) => { let s = ''; for (const v of vals) s += charset[v] ?? ''; return s; };
  const cache = new Map<number, ReparsedOp[]>();
  const fields = (slot: number): ReparsedOp[] => {
    let f = cache.get(slot);
    if (!f) { try { f = src.decode(slot) ?? []; } catch { f = []; } cache.set(slot, f); }
    return f;
  };

  // ---- text values ----------------------------------------------------------
  function textValue(node: any, depth = 0): TextValue | null {
    const n = deref(node);
    if (!n || depth > 8) return null;
    if (n.tag === 0x0e) return { kind: 'str', text: glyphs(n.values) };
    if (n.tag === 0x26 && isInt(n.value)) return { kind: 'ref', ref: n.value };
    if (n.tag === 0x24 && n.fields) {
      const f = n.fields.map(deref);
      if (isDescriptorShape(f)) return { kind: 'descriptor', text: glyphs(f[0].values) };
      const parts: string[] = [];
      let ok = true, any = false;
      const walk = (x: any, d: number) => {
        const m = deref(x);
        if (!m || d > 10) return;
        if (m.tag === 0x0e) { parts.push(glyphs(m.values)); any = true; return; }
        if (m.tag === 0x24 && m.fields) { for (const y of m.fields) walk(y, d + 1); return; }
        if (m.tag === 0x20 || m.tag === 0x2c) { for (const y of m.values ?? []) walk(y, d + 1); return; }
        if ([0x15, 0x0b, 0x0a, 0x01, 0x0c, 0x0d].includes(m.tag)) return;
        ok = false;
      };
      walk(n, 0);
      return ok && any ? { kind: 'composed', text: parts.join('') } : null;
    }
    if (Array.isArray(n.values) && n.tag !== 0x0e) {
      const items = n.values.map((x: any) => textValue(x, depth + 1)).filter(Boolean) as TextValue[];
      if (items.length && items.length === n.values.length) return { kind: 'list', items };
    }
    return null;
  }
  type Member = { op: number; v: TextValue };
  const members = new Map<number, Member[]>();
  for (const row of rows) {
    const out: Member[] = [];
    for (const f of fields(row.slot)) {
      if (f.kind === 'G') { const v = textValue(f.node); if (v) out.push({ op: f.op, v }); }
      else if (f.kind === 'N' && f.values.length && f.values.every((x) => x >= 32 && x < 0x110000)) {
        out.push({ op: f.op, v: { kind: 'str', text: String.fromCodePoint(...f.values) } });
      }
    }
    if (out.length) members.set(row.slot, out);
  }
  const textOf = (v: TextValue) => 'text' in v ? clean(v.text) : '';

  // ---- member positions: per (runtime, op) statistics ------------------------
  type Pos = { rows: number; texts: Map<string, number>; title: number; ref: number; dup: number };
  const pos = new Map<string, Pos>();
  const key = (rt: number, op: number) => `${rt}:${op}`;
  const valueKey = (v: TextValue) => v.kind === 'ref' ? `r${v.ref}` : v.kind === 'list' ? null : `t${textOf(v)}`;
  for (const [slot, m] of members) {
    const rt = rows[slot].runtime, keys = m.map((x) => valueKey(x.v));
    m.forEach(({ op, v }, i) => {
      let s = pos.get(key(rt, op));
      if (!s) pos.set(key(rt, op), s = { rows: 0, texts: new Map(), title: 0, ref: 0, dup: 0 });
      s.rows++;
      if (keys[i] && keys.some((k, j) => j !== i && k === keys[i])) s.dup++;
      if (v.kind === 'ref') { s.ref++; return; }
      if (v.kind === 'list') return;
      const t = textOf(v);
      if (!t) return;
      s.texts.set(t, (s.texts.get(t) ?? 0) + 1);
      if (!SNAKE.test(v.text.trim()) && !SENTENCE.test(t)) s.title++;
    });
  }
  // action words: one text on >= 90% of a runtime's rows, never restated in the
  // row, and the same text at such positions in three or more runtimes
  const verbPos = new Set<string>();
  {
    const single = [...pos].filter(([, s]) => s.texts.size === 1 && [...s.texts.values()][0] >= s.rows * 0.9 && s.dup < s.rows * 0.5);
    const runtimesOf = new Map<string, Set<number>>();
    for (const [k, s] of single) {
      const t = [...s.texts.keys()][0];
      let r = runtimesOf.get(t);
      if (!r) runtimesOf.set(t, r = new Set());
      r.add(+k.split(':')[0]);
    }
    for (const [k, s] of single) {
      const t = [...s.texts.keys()][0];
      if ((runtimesOf.get(t)?.size ?? 0) >= 3 && !SENTENCE.test(t) && t.split(' ').length <= 4) verbPos.add(k);
    }
  }
  const atVerb = (slot: number, op: number) => verbPos.has(key(rows[slot].runtime, op));

  // ---- families, type rows, tier rows -----------------------------------------
  const family = new Map<number, { singular: string; plural: string | null }>();
  const leadName = (slot: number) => {
    for (const { v } of members.get(slot) ?? []) { if (v.kind !== 'str') continue; const t = textOf(v); return nameLike(t) ? t : null; }
    return null;
  };
  for (const [slot, m] of members) {
    const texts = m.filter((x) => x.v.kind === 'str').map((x) => textOf(x.v));
    const sing = texts.find((t) => nameLike(t));
    if (!sing) continue;
    const pl = texts.find((t) => isPlural(sing, t));
    if (pl) family.set(slot, { singular: sing, plural: pl });
  }
  const typeRow = new Map<number, { internal: string; qualifier: string | null; family: number }>();
  const typedFamilies = new Set<number>();
  for (const row of rows) {
    const f = fields(row.slot);
    if (!f.length) continue;
    let internal: string | null = null, fam: number | null = null, qualifier: string | null | undefined;
    for (const x of f) {
      if (x.kind !== 'G') continue;
      const n = deref(x.node);
      if (!internal) { if (n?.tag === 0x0e) { const t = glyphs(n.values); if (SNAKE.test(t) && t.includes('_')) internal = t; } continue; }
      if (fam === null) { if (n?.tag === 0x26 && n.value !== row.slot && (family.has(n.value) || leadName(n.value) !== null)) fam = n.value; continue; }
      if (qualifier === undefined) {
        const tv = textValue(x.node);
        if (tv && (tv.kind === 'str' || tv.kind === 'composed')) { const t = textOf(tv); if (nameLike(t) && t.split(' ').length <= 5) qualifier = t; }
        else if (n?.tag === 0x0f && symbols[n.value] === '$none') qualifier = null;
      }
    }
    if (!internal || fam === null || qualifier === undefined) continue;
    // the internal id's words end with the family's last word and contain the qualifier's
    if (!family.has(fam)) family.set(fam, { singular: leadName(fam)!, plural: null });
    const iw = words(internal), fw = words(family.get(fam)!.singular), qw = qualifier ? words(qualifier) : [];
    if (!iw.includes(fw[fw.length - 1]) || (qw.length && !qw.every((w) => iw.includes(w)))) {
      if (family.get(fam)!.plural === null && !typedFamilies.has(fam)) family.delete(fam);
      continue;
    }
    typeRow.set(row.slot, { internal, qualifier: qualifier ?? null, family: fam });
    typedFamilies.add(fam);
  }
  const tierRow = new Map<number, { qualifier: string; family: number }>();
  {
    const listsOf = (slot: number) => {
      const out = new Set<number>();
      for (const f of fields(slot)) {
        if (f.kind !== 'G') continue;
        const n = deref(f.node);
        if (Array.isArray(n?.values)) for (const x of n.values) { const y = deref(x); if (y?.tag === 0x26) out.add(y.value); }
      }
      return out;
    };
    for (const [slot, m] of members) {
      if (typeRow.has(slot)) continue;
      const refs = m.filter((x) => x.v.kind === 'ref').map((x) => (x.v as { ref: number }).ref);
      const quals = m.filter((x) => (x.v.kind === 'str' || x.v.kind === 'composed') && nameLike(textOf(x.v)) && !atVerb(slot, x.op)).map((x) => textOf(x.v));
      if (quals.length !== 1 || quals[0].split(' ').length > 3) continue;
      // a tier row that also states an internal id must agree with it
      const iid = m.find((x) => x.v.kind === 'str' && SNAKE.test(x.v.text.trim()) && x.v.text.includes('_'));
      for (const r of refs) {
        const lead = leadName(r);
        if (!lead || lead === quals[0]) continue;
        if (iid && iid.v.kind === 'str') {
          const iw = new Set(words(iid.v.text));
          if (!words(quals[0]).every((w) => iw.has(w)) || !words(lead).some((w) => iw.has(w))) continue;
        }
        if (listsOf(r).has(slot)) { tierRow.set(slot, { qualifier: quals[0], family: r }); break; }
      }
    }
    // tier qualifiers are shared vocabulary (three or more families), a tier
    // family lists two or more tiers of one runtime
    const famsOf = new Map<string, Set<number>>(), tiersOf = new Map<number, number>(), rtsOf = new Map<number, Set<number>>();
    for (const [slot, t] of tierRow) {
      let f = famsOf.get(t.qualifier); if (!f) famsOf.set(t.qualifier, f = new Set()); f.add(t.family);
      tiersOf.set(t.family, (tiersOf.get(t.family) ?? 0) + 1);
      let r = rtsOf.get(t.family); if (!r) rtsOf.set(t.family, r = new Set()); r.add(rows[slot].runtime);
    }
    for (const [slot, t] of tierRow) {
      if (famsOf.get(t.qualifier)!.size < 3 || tiersOf.get(t.family)! < 2 || rtsOf.get(t.family)!.size !== 1) tierRow.delete(slot);
    }
  }
  const nameableType = (slot: number) => typeRow.has(slot) || family.has(slot) || tierRow.has(slot);
  // name positions: a title string or a reference to a nameable type on >= 80% of rows
  const namePos = new Set<string>();
  {
    const cnt = new Map<string, number>();
    for (const [slot, m] of members) {
      const rt = rows[slot].runtime;
      for (const { op, v } of m) if (v.kind === 'ref' && nameableType(v.ref)) cnt.set(key(rt, op), (cnt.get(key(rt, op)) ?? 0) + 1);
    }
    for (const [k, s] of pos) if (!verbPos.has(k) && s.title + (cnt.get(k) ?? 0) >= s.rows * 0.8 && s.title > 0) namePos.add(k);
  }

  // ---- row names --------------------------------------------------------------
  type Named = RecordName & { via?: number };
  const memo = new Map<number, Named | null>();
  const visiting = new Set<number>();
  const nameOf = (slot: number, depth = 0): Named | null => {
    if (memo.has(slot)) return memo.get(slot)!;
    if (visiting.has(slot) || depth > 4) return null;
    visiting.add(slot);
    const r = resolve(slot, depth);
    visiting.delete(slot);
    memo.set(slot, r);
    return r;
  };
  function resolve(slot: number, depth: number): Named | null {
    const t = typeRow.get(slot);
    if (t) { const fam = family.get(t.family)!; return { name: t.qualifier ? `${t.qualifier} ${fam.singular}` : fam.singular, base: fam.singular, rule: 'type row', via: t.family }; }
    const tier = tierRow.get(slot);
    if (tier) return { name: `${tier.qualifier} ${leadName(tier.family)}`, base: leadName(tier.family)!, rule: 'tier row', via: tier.family };
    const fam = family.get(slot);
    const m = members.get(slot) ?? [];
    const rt = rows[slot]?.runtime;
    const counts = new Map<string, { n: number; op: number; v: TextValue }>();
    for (const { op, v } of m) {
      if (atVerb(slot, op)) continue;
      let k: string | null = null;
      if (v.kind === 'ref') k = `r${v.ref}`;
      else if (v.kind !== 'list') { const tx = textOf(v); if (nameLike(tx)) k = `t${tx}`; }
      if (!k) continue;
      const e = counts.get(k);
      if (e) e.n++; else counts.set(k, { n: 1, op, v });
    }
    const dups = [...counts.values()].filter((e) => e.n >= 2)
      .sort((a, b) => (a.v.kind === 'ref' ? 1 : 0) - (b.v.kind === 'ref' ? 1 : 0) || b.n - a.n || a.op - b.op);
    for (const d of dups) {
      if (d.v.kind === 'ref') {
        if (!nameableType(d.v.ref)) continue;
        const n = nameOf(d.v.ref, depth + 1);
        if (n) return { ...n, rule: `stated twice (reference) -> ${n.rule}`, via: d.v.ref };
        continue;
      }
      return { name: textOf(d.v), rule: 'stated twice' };
    }
    if (fam) return { name: fam.singular, rule: 'family singular' };
    const titles = m.filter(({ op, v }) => (v.kind === 'str' || v.kind === 'descriptor' || v.kind === 'composed') && nameLike(textOf(v)) && !atVerb(slot, op))
      .filter(({ op }) => { const s = pos.get(key(rt, op))!; return namePos.has(key(rt, op)) && (s.rows < 3 || s.texts.size >= 2 || s.ref > 0); });
    if (titles.length === 1) return { name: textOf(titles[0].v), rule: 'single title' };
    for (const { op, v } of m) {
      if (v.kind !== 'ref' || !namePos.has(key(rt, op)) || (!typeRow.has(v.ref) && !family.has(v.ref))) continue;
      const n = nameOf(v.ref, depth + 1);
      if (n) return { ...n, rule: `name member reference -> ${n.rule}`, via: v.ref };
    }
    return null;
  }
  const refsOf = (slot: number): number[] => {
    const out = new Set<number>();
    const walk = (n: any, d: number, active: Set<number>) => {
      if (!n || d > 12) return;
      if (n.tag === 0) { if (active.has(n.value)) return; active.add(n.value); walk(pool[n.value], d, active); active.delete(n.value); return; }
      if (n.tag === 0x26 && isInt(n.value)) { out.add(n.value); return; }
      for (const x of n.fields ?? []) walk(x, d + 1, active);
      if (Array.isArray(n.values) && n.tag !== 0x0e) for (const x of n.values) if (x && typeof x === 'object') walk(x, d + 1, active);
    };
    for (const f of fields(slot)) if (f.kind === 'G') walk(f.node, 0, new Set());
    for (const [, t] of rows[slot].r) if (isInt(t) && t < rows.length) out.add(t);
    out.delete(slot);
    return [...out];
  };
  const names = new Map<number, Named>();
  for (const row of rows) { const n = nameOf(row.slot); if (n) names.set(row.slot, { ...n }); }
  // an enemy template named only by its family takes the name of the one type
  // row of that family that references it
  {
    const typesReferencing = new Map<number, number[]>();
    for (const [t, info] of typeRow) for (const r of refsOf(t)) {
      if (r === info.family) continue;
      const l = typesReferencing.get(r) ?? [];
      l.push(t);
      typesReferencing.set(r, l);
    }
    for (const [slot, n] of names) {
      if (!/-> family singular$/.test(n.rule) || n.via === undefined) continue;
      const types = (typesReferencing.get(slot) ?? []).filter((t) => typeRow.get(t)!.family === n.via);
      if (types.length === 1) names.set(slot, { ...n, name: nameOf(types[0])!.name, rule: `${n.rule} + template of one type`, via: types[0] });
    }
  }
  // a stack plural keeps its singular: from a referenced type row, else a family
  const pluralFamilies = new Map<string, string>();
  for (const f of family.values()) if (f.plural) pluralFamilies.set(f.plural, f.singular);
  for (const [slot, n] of names) {
    for (const r of refsOf(slot)) {
      if (!typeRow.has(r)) continue;
      const tn = nameOf(r)!.name;
      if (isPlural(tn, n.name)) { n.singular = tn; break; }
    }
    if (!n.singular && pluralFamilies.has(n.name)) n.singular = pluralFamilies.get(n.name);
  }

  const byInternal = new Map<string, string>();
  for (const [slot, t] of typeRow) if (!byInternal.has(t.internal)) byInternal.set(t.internal, nameOf(slot)!.name);
  cache.clear();

  return {
    nameOf: (slot) => { const n = names.get(slot); return n ? { name: n.name, singular: n.singular, base: n.base, rule: n.rule } : null; },
    byInternal,
  };
}
