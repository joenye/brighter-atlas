// Display names recovered after the model catalogue is built, and names for
// the stored icon pictures. Like object-names.ts these change only names and
// aliases: never ids, composition or variant order.
//
// Enemy names. An enemy type record carries an internal snake-case name
// ("raider_goblin_soldier"), the tier qualifier as a display string ("Raider",
// the internal name's leading words) and a combat template holding the plural
// display name ("Goblin Soldiers", the internal name's trailing words). The
// display name is the qualifier and the singular: "Raider Goblin Soldier". A
// type record and its enemy definitions reference each other; the definitions
// own the models.
//
// Icon names. An item's card shows a stored icon picture: the item record
// holds a material whose texture is an icon-sized picture. Interface frames
// share their material across many records and are left out.
import type {SystemCatalog} from './catalog.js';
import type {PoolStrings} from './models.js';

const isInt = (v: unknown): v is number => Number.isInteger(v);
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const title = (ws: string[]) => ws.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

interface Row { slot: number; g?: any[] }

/** Registry rows a row references: direct tag-0x26 values and through pool values. */
function refsOf(row: Row, poolRefs: (index: number) => number[]): number[] {
  const out = new Set<number>();
  for (const event of row.g || []) {
    if (!Array.isArray(event) || event.length !== 4) continue;
    const [, , tag, value] = event;
    if (tag === 0x26 && isInt(value)) out.add(value);
    else if (tag === 0 && isInt(value)) for (const r of poolRefs(value)) out.add(r);
  }
  return [...out];
}

/** Every string held under a pool value (lists, typed values, chains). */
function stringsUnder(strings: PoolStrings, index: number): string[] {
  const out: string[] = [];
  const walk = (node: any, depth: number, active: Set<number>) => {
    if (!node || depth > 8) return;
    if (node.tag === 0 && isInt(node.value)) {
      if (active.has(node.value) || node.value < 0 || node.value >= strings.pool.length) return;
      active.add(node.value); walk(strings.pool[node.value], depth + 1, active); active.delete(node.value);
      return;
    }
    if (node.tag === 0x0e && Array.isArray(node.values)) {
      let t = '';
      for (const g of node.values) { const ch = strings.glyphs[g]; if (ch === undefined) return; t += ch; }
      out.push(t); return;
    }
    for (const x of node.fields ?? []) walk(x, depth + 1, active);
    if (Array.isArray(node.values) && node.tag !== 0x0e) for (const x of node.values) if (x && typeof x === 'object') walk(x, depth + 1, active);
  };
  walk({ tag: 0, value: index }, 0, new Set());
  return out;
}

/** The display name (and base name) of an enemy type record, or null. */
function enemyTypeName(row: Row, strings: PoolStrings): { name: string; base: string; internal: string } | null {
  const direct = strings.directStrings(row).map((e) => e.text);
  const internal = direct.find((t) => SNAKE.test(t));
  if (!internal) return null;
  const parts = internal.split('_');
  // the qualifier: a display string naming the internal name's leading words
  let qualifier: string | null = null, lead = 0;
  for (const t of direct) {
    if (t === internal || !t.trim() || t.length > 40) continue;
    const w = words(t);
    if (w.length && w.length < parts.length && w.every((x, i) => x === parts[i]) && w.length > lead) { qualifier = t.trim(); lead = w.length; }
  }
  // the plural: a template string naming the internal name's trailing words
  // (the template is held inline or in the pool: strings at any depth)
  const templates: string[] = [];
  for (const event of row.g || []) {
    if (!Array.isArray(event) || event.length !== 4) continue;
    const [, , tag, value] = event;
    if (tag === 0x0e && typeof value === 'string') templates.push(value);
    else if (tag === 0 && isInt(value)) templates.push(...stringsUnder(strings, value));
  }
  let base: string[] | null = null;
  for (let k = parts.length - lead; k >= 1 && !base; k--) {
    const tail = parts.slice(-k), singular = tail.join(' ');
    for (const t of templates) {
      const p = t.trim().toLowerCase();
      if (p === `${singular}s` || p === `${singular}es` || p === singular
        || (p.split(' ').length === k && p.startsWith(singular.slice(0, Math.max(1, singular.length - 2))) && Math.abs(p.length - singular.length) <= 3)) {
        base = tail; break;
      }
    }
  }
  if (!base) return null;
  return { name: qualifier ? `${qualifier} ${title(base)}` : title(base), base: title(base), internal };
}

/** Enemy display names by the type record's internal name ("grumpy_pirate"),
 *  filled by enemyDisplayNames. */
export const byInternal = new Map<string, { name: string; base: string }>();

/** Display names of enemy definition records (by registry slot), with the
 *  base name (the singular without its qualifier) for shared model names. */
export function enemyDisplayNames(rows: Row[], strings: PoolStrings, poolRefs: (index: number) => number[]): Map<number, { name: string; base: string }> {
  byInternal.clear();
  const typeName = new Map<number, { name: string; base: string }>();
  for (const row of rows) {
    const named = enemyTypeName(row, strings);
    if (named) {
      const { internal, ...entry } = named;
      typeName.set(row.slot, entry);
      if (!byInternal.has(internal)) byInternal.set(internal, entry);
    }
  }
  // A type record names the records it references when it is their only
  // naming type (its variant definitions); a record several types reference
  // (a shared table) stays unnamed. A definition that references one type is
  // named by it too.
  const out = new Map<number, { name: string; base: string }>();
  const referrers = new Map<number, number[]>();
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  for (const [slot] of typeName) {
    for (const r of refsOf(bySlot.get(slot)!, poolRefs)) {
      if (typeName.has(r)) continue;
      let list = referrers.get(r);
      if (!list) referrers.set(r, list = []);
      list.push(slot);
    }
  }
  for (const [r, types] of referrers) if (types.length === 1) out.set(r, typeName.get(types[0])!);
  for (const row of rows) {
    if (typeName.has(row.slot) || out.has(row.slot)) continue;
    const types = refsOf(row, poolRefs).filter((r) => typeName.has(r));
    if (types.length === 1) out.set(row.slot, typeName.get(types[0])!);
  }
  return out;
}

// A model name that is only a placeholder: the catalogue's "Recovered model",
// "Variant", or a lowercase technical token (an animation's mode word).
const PLACEHOLDER = /^(?:Recovered model \d+|Variant|[a-z0-9]+)$/;
export const isWeakName = (name: unknown): boolean => typeof name !== 'string' || !name.trim() || PLACEHOLDER.test(name);
// A candidate that is not a name: a placeholder, an internal snake-case name,
// or an action phrase ("pump the bellows", "Investigate at").
const ACTION = /^[a-z]|_|\s(?:at|on|to|in|with|from|into)$/;
const isNameLike = (name: unknown): name is string => typeof name === 'string' && !isWeakName(name) && !ACTION.test(name);
const allSources = (model: any): any[] => [...(model.sources ?? []), ...(model.variants ?? []).flatMap((v: any) => v.sources ?? [])];

/** Records referencing each record (direct and through pool values). */
export function referrerIndex(rows: Row[], poolRefs: (index: number) => number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const row of rows) {
    for (const r of refsOf(row, poolRefs)) {
      if (r === row.slot) continue;
      let list = out.get(r);
      if (!list) out.set(r, list = []);
      list.push(row.slot);
    }
  }
  return out;
}

/** Name models and variants owned by enemy definitions, and give models still
 *  carrying a placeholder or a technical token their object label. */
export function annotateDisplayNames(catalog: SystemCatalog, enemies: Map<number, { name: string; base: string }>,
  items: Map<number, string> = new Map(),
  referred: { referrers: Map<number, number[]>; labelOf: (slot: number) => string | null } | null = null) {
  const alias = (target: any, names: string[]) => {
    const all = [...new Set([...(target.aliases ?? []), ...names])].filter((s) => s && s !== target.name).sort((a, b) => a.localeCompare(b));
    if (all.length) target.aliases = all;
  };
  const namesOf = (sources: any[]) => [...new Set(sources.map((s: any) => enemies.get(s.owner_slot)?.name).filter(Boolean) as string[])].sort();
  for (const model of catalog.models as any[]) {
    const previous = model.name;
    // a model named with an enemy's internal name ("grumpy_pirate")
    const internal = typeof model.name === 'string' ? byInternal.get(model.name) : undefined;
    if (internal) model.name = internal.name;
    for (const variant of model.variants ?? []) {
      const vi = typeof variant.name === 'string' ? byInternal.get(variant.name) : undefined;
      if (vi) { alias(variant, [variant.name]); variant.name = vi.name; }
    }
    const names = namesOf(model.sources ?? []);
    for (const variant of model.variants ?? []) {
      const vn = namesOf(variant.sources ?? []);
      if (vn.length === 1 && isWeakName(variant.name)) {
        if (variant.name && variant.name !== 'Variant') alias(variant, [variant.name]);
        variant.name = vn[0];
      }
      names.push(...vn);
    }
    const distinct = [...new Set(names)];
    if (distinct.length && (isWeakName(model.name) || !model.spawn_label)) {
      if (isWeakName(model.name)) {
        if (distinct.length === 1) model.name = distinct[0];
        else {
          // variants of one enemy family share its base name
          const bases = [...new Set(allSources(model).map((s: any) => enemies.get(s.owner_slot)?.base).filter(Boolean))];
          if (bases.length === 1) model.name = bases[0];
        }
      }
      alias(model, distinct);
    }
    if (isWeakName(model.name)) {
      // an item record's own display name
      const own = [...new Set(allSources(model).map((s: any) => items.get(s.owner_slot)).filter(isNameLike))];
      if (own.length === 1) model.name = own[0];
      else if (own.length > 1) alias(model, own);
    }
    if (isWeakName(model.name)) {
      const labels = [...new Set((model.object_labels ?? []).map((l: any) => l.name).filter(isNameLike))];
      if (labels.length === 1) model.name = labels[0];
    }
    if (isWeakName(model.name) && referred) {
      // an appearance record: the name every named record using it agrees on
      const owners = new Set(allSources(model).map((s: any) => s.owner_slot));
      const names = new Set<string>();
      for (const o of owners) for (const r of referred.referrers.get(o) ?? []) {
        const n = enemies.get(r)?.name ?? items.get(r) ?? referred.labelOf(r);
        if (isNameLike(n)) names.add(n);
      }
      // an animation's prop (its records hold only a lowercase mode word) is
      // the named user's prop
      const prop = typeof model.name === 'string' && /^[a-z0-9]+$/.test(model.name);
      if (names.size === 1) model.name = prop ? `${[...names][0]} prop` : [...names][0];
      else if (names.size > 1 && names.size <= 6) alias(model, [...names]);
    }
    if (model.name !== previous && previous && !/^Recovered model /.test(previous)) alias(model, [previous]);
  }
}

/** A display string without the font's inline symbol glyphs (charges,
 *  profession marks), whitespace collapsed. */
export function cleanName(text: string): string {
  return text.replace(/[^\u0020-\u007E\u00A0-\u024F\u2018-\u201F]/gu, ' ').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
}

const LEADING_GLYPH = /^[^\u0020-\u007E\u00A0-\u024F]/u;

export const ICON_NAMES_FORMAT = 1;
const ICON_MIN = 128, ICON_MAX = 300, SHARED_MATERIAL = 64, COMMON_STRING = 40;

/** Names for stored icon pictures: {format, images: {ordinal: {names}}}. */
export function iconImageNames(rows: Row[], strings: PoolStrings, texturesByMaterial: Map<number, number[]>,
  images: any[], materialsOf: (slot: number) => number[]): { format: number; images: Record<string, { names: string[] }>; rowNames: Map<number, string> } {
  const iconSized = new Set<number>();
  for (const e of images) {
    if (!e || !String(e.cat ?? '').startsWith('sprite')) continue;
    const top = (e.entries ?? []).reduce((a: number, b: any) => Math.max(a, b.w ?? 0, b.h ?? 0), 0);
    if (top >= ICON_MIN && top <= ICON_MAX) iconSized.add(e.i);
  }
  const iconOf = (material: number) => (texturesByMaterial.get(material) ?? []).find((t) => iconSized.has(t)) ?? null;
  const users = new Map<number, number>();
  const statedNames = new Set<number>();
  const found: [Row, number, number][] = [];
  const stringRows = new Map<string, number>();
  const labels = new Map<number, string[]>();
  for (const row of rows) {
    // (a line led by one of the font's symbol glyphs is an annotation, such as
    // an effect, not a name)
    const texts = [...new Set(strings.directStrings(row).filter((e) => !LEADING_GLYPH.test(e.text)).map((e) => cleanName(e.text))
      .filter((t) => t && t.length <= 60 && !/[.!?:]$/.test(t) && !SNAKE.test(t)))];
    if (!texts.length) continue;
    // A name composed of a qualifier and a singular ("Appetizing" +
    // "Boiled Lobster") when the row states it only in the plural.
    const nested = new Map<number, string[]>();
    for (const event of row.g || []) {
      if (!Array.isArray(event) || event.length !== 4 || event[1] < 1) continue;
      const [op, , tag, value] = event;
      const t = tag === 0x0e && typeof value === 'string' ? value : tag === 0 && isInt(value) ? strings.poolString(value) : null;
      if (t === null) continue;
      let list = nested.get(op);
      if (!list) nested.set(op, list = []);
      list.push(cleanName(t));
    }
    const composedNames: string[] = [];
    for (const raw of nested.values()) {
      const list = raw.filter(Boolean);
      if (list.length < 2) continue;
      const composed = `${list[0]} ${list[1]}`;
      if (texts.includes(`${composed}s`) || texts.includes(`${composed}es`) || texts.includes(composed)) composedNames.push(composed);
    }
    // The item's name: stated twice (display and inventory), or composed of
    // qualifier and singular; other strings (effects, actions) only when the
    // row states no name that way.
    const all = strings.directStrings(row).map((e) => cleanName(e.text));
    const twice = texts.filter((t) => all.filter((x) => x === t).length > 1);
    const named = [...new Set([...composedNames, ...twice])];
    if (named.length) { texts.splice(0, texts.length, ...named); statedNames.add(row.slot); }
    const seen = new Set<number>();
    for (const material of materialsOf(row.slot)) {
      if (seen.has(material)) continue;
      seen.add(material);
      const icon = iconOf(material);
      if (icon === null) continue;
      users.set(material, (users.get(material) ?? 0) + 1);
      found.push([row, material, icon]);
    }
    if (!seen.size) continue;
    labels.set(row.slot, texts);
    for (const t of texts) stringRows.set(t, (stringRows.get(t) ?? 0) + 1);
  }
  const byIcon = new Map<number, Map<string, number>>();
  // icons some record names outright ignore the unstated strings of the others
  const statedIcon = new Set<number>();
  for (const [row, material, icon] of found) if (statedNames.has(row.slot) && (users.get(material) ?? 0) <= SHARED_MATERIAL) statedIcon.add(icon);
  // the record's own display name: its singular when it states one
  const rowNames = new Map<number, string>();
  for (const [row, material, icon] of found) {
    if ((users.get(material) ?? 0) > SHARED_MATERIAL) continue;
    if (statedIcon.has(icon) && !statedNames.has(row.slot)) continue;
    const names = (labels.get(row.slot) ?? []).filter((t) => (stringRows.get(t) ?? 0) < COMMON_STRING);
    if (!names.length) continue;
    if (!rowNames.has(row.slot)) {
      const singular = names.find((n) => names.some((o) => o === `${n}s` || o === `${n}es`)) ?? names[0];
      rowNames.set(row.slot, singular);
    }
    let m = byIcon.get(icon);
    if (!m) byIcon.set(icon, m = new Map());
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  }
  const out: Record<string, { names: string[] }> = {};
  for (const [icon, m] of [...byIcon].sort((a, b) => a[0] - b[0])) {
    // a plural goes when its singular is there ("Boiled Lobsters", "Boiled Lobster")
    const all = new Set(m.keys());
    const keep = [...m].filter(([n]) => !((n.endsWith('es') && all.has(n.slice(0, -2))) || (n.endsWith('s') && all.has(n.slice(0, -1)))));
    out[String(icon)] = { names: keep.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([n]) => n) };
  }
  return { format: ICON_NAMES_FORMAT, images: out, rowNames };
}

/** The last naming pass: a model still without a name takes its source records'
 *  own names (names.ts): the one name they state, else the family they share,
 *  else a two-thirds majority. Variants likewise. */
export function nameFromRecords(catalog: SystemCatalog, nameOf: (slot: number) => { name: string; base?: string } | null) {
  const pick = (sources: any[]): string | null => {
    const found = sources.map((s: any) => nameOf(s.owner_slot)).filter((n): n is { name: string; base?: string } => !!n && isNameLike(n.name));
    if (!found.length) return null;
    const distinct = [...new Set(found.map((n) => n.name))];
    if (distinct.length === 1) return distinct[0];
    const bases = [...new Set(found.map((n) => n.base))];
    if (bases.length === 1 && bases[0]) return bases[0];
    const counts = new Map<string, number>();
    for (const n of found) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
    const [top, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
    return count * 3 >= found.length * 2 ? top : null;
  };
  for (const model of catalog.models as any[]) {
    for (const variant of model.variants ?? []) {
      if (!isWeakName(variant.name)) continue;
      const n = pick(variant.sources ?? []);
      if (n) variant.name = n;
    }
    if (!isWeakName(model.name)) continue;
    const n = pick(allSources(model));
    if (n) model.name = n;
  }
}
