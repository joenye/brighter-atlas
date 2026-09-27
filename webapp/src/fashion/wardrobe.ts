// Equipment browser: slots, a searchable list (one slot, or every slot while
// searching), tiers, colour variants, dyes, and whole sets.
import {at} from './data.js';
import type {EquipSlot, State, Worn} from './compose.js';
import {attachScrollbar} from '../scrollbar.js';

export const h = (tag: string, attrs: Record<string, any> = {}, ...kids: (Node | string | null | undefined | false)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
};

// small line icons (the app's style: no emoji, which many systems draw as boxes)
const PATHS: Record<string, string> = {
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  share: 'M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 10.7l6.8-3.4M8.6 13.3l6.8 3.4',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c.8-3.6 3.9-6 7.5-6s6.7 2.4 7.5 6',
  mask: 'M5 4.5c4.5-1.3 9.5-1.3 14 0v6.5a7 7 0 0 1-14 0zM8.2 9.3c.8-.6 1.8-.6 2.6 0M13.2 9.3c.8-.6 1.8-.6 2.6 0M9.3 14c1.6 1.4 3.8 1.4 5.4 0',
  dice: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8.5 8.5h.01M15.5 15.5h.01M12 12h.01M15.5 8.5h.01M8.5 15.5h.01',
  x: 'M6 6l12 12M18 6L6 18',
  reset: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5',
  turnLeft: 'M14 6l-6 6 6 6',
  turnRight: 'M10 6l6 6-6 6',
  image: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4',
  set: 'M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4',
  drop: 'M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z',
  head: 'M5 14c0-5 3-9 7-9s7 4 7 9M3 14h18M9 14v3h6v-3',
  torso: 'M8 4l-4 3 2 4 2-1v10h8V10l2 1 2-4-4-3c-1 2-2.5 3-4 3S9 6 8 4z',
  legs: 'M7 3h10l1 18h-4l-2-11-2 11H6z',
  hands: 'M8 21v-6L5 11l1.5-1.5L9 12V4h2v7h1V3h2v8h1V5h2v10l-2 6z',
  feet: 'M7 3h5v9l7 3v4H5V12z',
  cape: 'M8 3h8l1 3 3 15H4L7 6z',
  shield: 'M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z',
  weapon: 'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2',
  none: 'M5 5l14 14M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
};
export const icon = (name: string) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'ic');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', PATHS[name] ?? ''); svg.append(p);
  return svg;
};

export const SLOT_LABEL: Record<EquipSlot, string> = {head: 'Head', torso: 'Torso', legs: 'Legs', hands: 'Hands', feet: 'Feet', cape: 'Cape', shield: 'Shield', weapon: 'Weapon'};
const EMPTY: Record<EquipSlot, [string, string]> = {
  head: ['No hat', 'Show the hair'], torso: ['No torso armour', 'Show the character’s own top'], legs: ['No leg armour', 'Show the character’s own trousers'],
  hands: ['No gloves', 'Bare hands'], feet: ['No boots', 'Show the character’s own shoes'], cape: ['No cape', 'Nothing on the back'],
  shield: ['No shield', 'Nothing in the left hand'], weapon: ['No weapon', 'Nothing in the right hand'],
};
const TIER = /^(Journeyman|Adept|Expert|Ultimate|Champion|Master|WIP)(\s+(I{1,3}|IV|V))?\s+/;
export const clean = (s: string) => s.replace(/[\u{F0000}-\u{FFFFD}]/gu, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

export interface Member { item: any; variant: number; label: string | null }
// the game's weapon categories, in words
const WEAPON_GROUP: Record<string, string> = {'Melee 1h': 'One-handed', 'Melee 2h': 'Two-handed', 'Ranged': 'Ranged'};

export interface Entry { key: string; slot: EquipSlot; name: string; group: string; kind: string; members: Member[]; icon?: number; search: string }

// One browsable entry per look: capes fold their tiers, tiered items their tiers,
// cosmetics their colours.
export function allEntries(pack: any): Entry[] {
  const out: Entry[] = [];
  const capeGroups = new Map<string, Entry>();
  for (const it of pack.items) {
    const name = clean(it.name);
    if (it.kind === 'cape') {
      const m = name.match(TIER);
      const base = m ? name.slice(m[0].length) : name;
      let e = capeGroups.get(base);
      if (!e) {
        const group = /Combat/.test(base) ? 'Combat capes' : /Hopeport|Hopeforest|Mantuban|Crenopolis|Stonemaw|Bleakholm/.test(base) ? 'Episode capes' : 'Profession capes';
        e = {key: `cape:${base}`, slot: 'cape', name: base, group, kind: 'cape', members: [],
          search: `${base} cape ${group}${it.variants.length > 1 ? ' ' + it.variants.map((v: any) => v.grade).join(' ') : ''}`.toLowerCase()};
        capeGroups.set(base, e); out.push(e);
      }
      e.members.push({item: it, variant: 0, label: m ? m[0].trim() : name});
      if (e.icon == null) e.icon = it.variants[0]?.icon;
      continue;
    }
    const group = it.kind === 'cosmetic' ? `Cosmetics · ${it.source ?? 'other'}` : it.kind === 'weapon' ? `Weapons · ${WEAPON_GROUP[it.category] ?? it.category ?? 'other'}` : it.kind === 'shield' ? (it.dyeable ? `Shields · ${it.source}` : 'Shields · Guard') : it.dyeable ? `Armour · ${it.source}` : 'Armour · Guard';
    out.push({key: `item:${it.id}`, slot: it.slot, name, group, kind: it.kind,
      members: it.variants.map((v: any, i: number) => ({item: it, variant: i, label: it.kind === 'cosmetic' ? clean(v.name) : v.grade})),
      icon: it.variants[0]?.icon,
      search: `${name} ${it.source ?? ''} ${it.kind} ${it.slot} ${it.variants.map((v: any) => v.name ?? '').join(' ')}`.toLowerCase()});
  }
  const order = (g: string) => g.startsWith('Weapons · ') ? ['One-handed', 'Two-handed', 'Ranged'].indexOf(g.slice(10)) * 0.1 : g.startsWith('Armour · Crafted') || g.startsWith('Shields · Crafted') ? 0 : g.includes('Guard') ? 1 : g.startsWith('Profession') ? 2 : g.startsWith('Episode') ? 3 : g.startsWith('Combat') ? 4 : 5;
  return out.sort((a, b) => order(a.group) - order(b.group) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name, undefined, {numeric: true}));
}

export interface WardrobeHooks {
  equip(slot: EquipSlot, w: Worn | null): void;
  equipMany(changes: Partial<Record<EquipSlot, Worn>>): void;
  preview(slot: EquipSlot, w: Worn): void;
  // a rendered picture for an item the game has none for
  thumb(slot: EquipSlot, w: Worn): Promise<string>;
}

// Run `fn` once `el` comes near the screen (a row scrolled toward, a list opened), never for rows no one sees.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const seen = new WeakMap<Element, () => void>();
let watcher: IntersectionObserver | null = null;
function whenSeen(el: Element, fn: () => void) {
  if (typeof IntersectionObserver === 'undefined') { fn(); return; }
  watcher ??= new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { const f = seen.get(e.target); seen.delete(e.target); watcher!.unobserve(e.target); f?.(); }
  }, {rootMargin: '300px'});
  seen.set(el, fn);
  watcher.observe(el);
}

export class Wardrobe {
  root: HTMLElement;
  slot: EquipSlot = 'torso';
  query = '';
  entries: Entry[];
  private slotBar: HTMLElement; private list: HTMLElement; private details: HTMLElement; private search: HTMLInputElement;
  private state!: State;
  private shown: Entry[] = [];
  constructor(host: HTMLElement, private pack: any, public slots: EquipSlot[], private hooks: WardrobeHooks, header: Node) {
    this.entries = allEntries(pack);
    this.slotBar = h('div', {class: 'slots', role: 'tablist', 'aria-label': 'Equipment slots'});
    this.search = h('input', {type: 'search', placeholder: 'Search all equipment (“plate”, “santa”, “cape”)', class: 'search', 'aria-label': 'Search all equipment', enterkeyhint: 'search',
      oninput: () => { this.query = this.search.value.trim().toLowerCase(); this.renderList(); this.renderCrumbs(); }}) as HTMLInputElement;
    this.list = h('div', {class: 'items', tabindex: '0', 'aria-label': 'Items (↑ ↓ try them on)'});
    this.list.addEventListener('keydown', e => this.onKey(e));
    // ↓ from the search box goes on into the results (trying the first on)
    this.search.addEventListener('keydown', e => { if (e.key === 'ArrowDown' && this.shown.length) { e.preventDefault(); this.list.focus({preventScroll: true}); this.onKey(e); } });
    this.details = h('div', {class: 'details'});
    // phones: the slots are the master view; a slot opens its detail under a breadcrumb back to them
    this.crumbs = h('nav', {class: 'crumbs', 'aria-label': 'Equipment'});
    this.root = h('section', {class: 'wardrobe'}, header, this.slotBar, this.crumbs, this.search, this.list, this.details);
    host.append(this.root);
    attachScrollbar(this.list); attachScrollbar(this.details); attachScrollbar(this.slotBar); attachScrollbar(this.root);   // (the root: the phones' master view scrolls whole)
  }

  // details first: their height decides the list's, which decides where the selected row scrolls to
  update(state: State) { this.state = state; this.renderSlots(); this.renderCrumbs(); this.renderDetails(); this.renderList(); }
  crumbs: HTMLElement;
  /** back to the slots (the master view, phones) */
  showSlots() { this.root.classList.remove('in-slot', 'adjusting'); this.query = ''; this.search.value = ''; this.update(this.state); }
  /** a worn piece in a few words: its tier (or a combat cape's faction) and its colour or dye */
  wornSummary(e: Entry, w: Worn) {
    const it = e.members.find(m => m.item.id === w.item)?.item, v = it?.variants[w.variant] ?? it?.variants[0];
    if (!it) return '';
    const bits = [
      e.kind === 'cosmetic' ? (e.members.length > 1 ? clean(v.name).split(' ')[0] : null)
        : e.members.length > 1 ? e.members.find(m => m.item.id === it.id && (e.kind === 'cape' || m.variant === w.variant))?.label : null,
      e.kind === 'cape' && it.variants.length > 1 ? v.grade : null,
      v?.colourable && it.dyeable ? this.pack.dyes.find((d: any) => d.id === (w.colour ?? this.pack.defaultColour))?.name : null,
    ].filter(Boolean);
    return bits.join(' · ') || (e.kind === 'cosmetic' ? 'Cosmetic' : '');
  }
  /** the worn item's choices, in place of the list (phones: a level of its own) */
  // (the summary is drawn again: focus stays on it when it had it, or goes to it when asked, as from Escape)
  setAdjusting(on: boolean, focus = false) {
    const had = focus || this.details.contains(document.activeElement);
    this.root.classList.toggle('adjusting', on); this.renderDetails(); this.renderCrumbs(); this.details.scrollTop = 0;
    const summary = this.details.querySelector<HTMLElement>('.details-summary');
    if (had && summary?.getClientRects().length) summary.focus({preventScroll: true});
  }
  hasChoices(e: Entry) { const it = e.members[0].item; return e.members.length > 1 || dyeable(e) || (e.kind === 'cape' && it.variants.length > 1); }
  private renderCrumbs() {
    const w = this.state.equip[this.slot], e = this.entryOf(w);
    if (this.root.classList.contains('adjusting') && e) {
      this.crumbs.replaceChildren(
        h('button', {class: 'crumb-back', onclick: () => this.setAdjusting(false)}, icon('turnLeft'), SLOT_LABEL[this.slot]),
        h('span', {class: 'crumb-sep', 'aria-hidden': 'true'}, '/'),
        h('span', {class: 'crumb-here', 'aria-current': 'page'}, e.name));
      return;
    }
    this.crumbs.replaceChildren(
      h('button', {class: 'crumb-back', onclick: () => this.showSlots()}, icon('turnLeft'), 'Equipment'),
      h('span', {class: 'crumb-sep', 'aria-hidden': 'true'}, '/'),
      h('span', {class: 'crumb-here', 'aria-current': 'page'}, this.query ? 'Search' : SLOT_LABEL[this.slot]),
      ...(!this.query && e ? [h('span', {class: 'crumb-item'}, e.name)] : []));
  }
  focusSlot(slot: EquipSlot) {
    this.root.classList.remove('adjusting');
    this.root.classList.add('in-slot');
    this.slot = slot; this.query = ''; this.search.value = ''; this.update(this.state);
    this.list.scrollTop = 0; reveal(this.list, this.list.querySelector('.item.on'));
    reveal(this.slotBar, this.slotBar.querySelector('.slot.on'));
  }

  // the game's picture, else a rendered thumbnail (filled in when ready), else the slot glyph
  // `colour`: the item's colour as the game tints its picture with (a cosmetic's own colour, the dye on a
  // dyeable piece); null leaves the picture as stored
  picture(slot: EquipSlot, m: Member, cls: string, colour: string | null = null, dye: number | null = null) {
    const v = m.item.variants[m.variant];
    if (v?.icon != null) {
      // a tinted picture is drawn from the stored one: fetched (both) only once its row is about to show
      const img = h('img', {src: colour ? BLANK : at(`icon/${v.icon}`), alt: '', loading: 'lazy', class: cls}) as HTMLImageElement;
      if (colour) whenSeen(img, () => void tintedIcon(v.icon, colour).then(url => { img.src = url || at(`icon/${v.icon}`); }));
      return img;
    }
    const glyph = h('span', {class: cls === 'thumb-lg' ? 'item-glyph thumb-lg' : cls === 'slot-img' ? 'slot-glyph' : 'item-glyph'}, icon(slot));
    // a rendered thumbnail loads the item's meshes and textures: only for rows about to show
    whenSeen(glyph, () => void this.hooks.thumb(slot, {item: m.item.id, variant: m.variant, colour: dye}).then(url => {
      if (url && glyph.isConnected) glyph.replaceWith(h('img', {src: url, alt: '', class: `${cls} rendered`.trim(), title: 'Rendered here: the game has no picture for this yet'}));
    }));
    return glyph;
  }

  /** The colour the game tints a member's picture with, and the dye row behind it (worn: the equipped piece). */
  colourFor(m: Member, worn?: Worn): [string | null, number | null] {
    const it = m.item, v = it.variants[m.variant];
    // a cosmetic whose colours are fixed in its parts (the Snowman Hat's ten): its picture takes the part's two tints
    if (!v?.colourable) {
      if (it.kind !== 'cosmetic' || it.variants.length < 2) return [null, null];
      const w = this.pack.worn[v.male?.worn ?? v.female?.worn], p = w && this.pack.parts[w.parts?.find((x: number) => this.pack.parts[x]?.mesh != null)];
      const hex = (c: any) => Array.isArray(c) ? '#' + c.slice(0, 3).map((x: number) => Math.round(x * 255).toString(16).padStart(2, '0')).join('') : '#7f7f7f';
      return p && (Array.isArray(p.r1) || Array.isArray(p.r2)) ? [`${hex(p.r1)}|${hex(p.r2)}`, null] : [null, null];
    }
    if (it.kind === 'cosmetic') return [v.colour?.rgb ?? null, null];
    if (!it.dyeable) return [null, null];
    const id = (worn && worn.item === it.id ? worn.colour : null) ?? this.pack.defaultColour;
    return [this.pack.dyes.find((d: any) => d.id === id)?.colour ?? null, worn && worn.item === it.id ? worn.colour : null];
  }

  entryOf(w: Worn | undefined) { return w ? this.entries.find(e => e.members.some(m => m.item.id === w.item)) : undefined; }

  private renderSlots() {
    this.slotBar.replaceChildren(...this.slots.map(slot => {
      const w = this.state.equip[slot];
      const e = this.entryOf(w);
      // the worn look itself (a cape's style is a variant its tier's member doesn't carry)
      const mm = e?.members.find(x => x.item.id === w!.item && (e.kind === 'cape' || x.variant === w!.variant));
      const m = mm ? {...mm, variant: w!.variant} : e?.members[0];
      const on = slot === this.slot && !this.query;
      const take = () => { this.refocus = slot; this.hooks.equip(slot, null); };
      const tab = h('button', {class: `slot${on ? ' on' : ''}${w ? ' filled' : ''}${this.hidden.has(slot) ? ' covered' : ''}`, role: 'tab', 'aria-selected': String(on), 'data-slot': slot, title: e ? `${SLOT_LABEL[slot]}: ${e.name}` : `${SLOT_LABEL[slot]}: nothing`,
        'aria-label': e ? `${SLOT_LABEL[slot]}: ${e.name}` : `${SLOT_LABEL[slot]}: nothing`, onclick: () => this.focusSlot(slot)},
        m ? this.picture(slot, m, 'slot-img', ...this.colourFor(m, w)) : h('span', {class: 'slot-glyph'}, icon(slot)),
        h('span', {class: 'slot-name'}, SLOT_LABEL[slot]),
        // (phones' slot list: what is worn there, and its tier and colour)
        h('span', {class: 'slot-info'}, h('span', {class: 'slot-label'}, SLOT_LABEL[slot]),
          h('span', {class: 'slot-item'}, e ? e.name : 'Empty'),
          e ? h('span', {class: 'slot-sub'}, this.wornSummary(e, w!)) : null));
      // the × beside the tab, not inside it (a button in a button is no button to a screen reader)
      return h('div', {class: 'slot-cell'}, tab,
        w ? h('button', {class: 'slot-x', 'aria-label': `Take off ${e?.name ?? SLOT_LABEL[slot]}`, title: `Take off ${e?.name ?? ''}`, onclick: take}, '×') : null);
    }));
    if (this.refocus) { (this.slotBar.querySelector(`[data-slot="${this.refocus}"]`) as HTMLElement | null)?.focus({preventScroll: true}); this.refocus = null; }
  }
  private refocus: EquipSlot | null = null;
  /** equipped slots the composer dropped whole, with the slot covering each (set before update) */
  hidden = new Map<EquipSlot, EquipSlot[]>();

  private renderList() {
    const q = this.query;
    const words = q.split(/\s+/).filter(Boolean);
    let all = q ? this.entries.filter(e => words.every(w => e.search.includes(w))) : this.entries.filter(e => e.slot === this.slot);
    if (q) all = [...all].sort((a, b) => this.slots.indexOf(a.slot) - this.slots.indexOf(b.slot));   // one heading per slot
    this.shown = all;
    const frag: Node[] = [];
    let group = '';
    if (!q) frag.push(this.rowNone());
    for (const e of all) {
      const g = q ? SLOT_LABEL[e.slot] : e.group;
      if (g !== group) { group = g; frag.push(h('div', {class: 'group'}, group)); }
      const cur = this.state.equip[e.slot];
      const on = !!cur && e.members.some(m => m.item.id === cur.item);
      // the worn row shows the worn look (its colour or tier); the others their first
      const wornM = on ? e.members.find(m => m.item.id === cur!.item && (e.kind === 'cape' || m.variant === cur!.variant)) : undefined;
      const first = wornM ? {...wornM, variant: cur!.variant} : e.members[0];
      const count = `${e.members.length} ${e.kind === 'cosmetic' ? 'colours' : 'tiers'}`;
      const row = h('button', {class: `item${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': `${e.name}${on ? ', wearing' : ''}${dyeable(e) ? ', can be dyed' : ''}${e.members.length > 1 ? ', ' + count : ''}`, 'data-key': e.key, onclick: () => this.pick(e), onmouseenter: () => this.hooks.preview(e.slot, this.wornFor(e))},
        this.picture(e.slot, first, '', ...this.colourFor(first, this.state.equip[e.slot])),
        h('span', {class: 'item-text'}, h('span', {class: 'item-name'}, e.name, dyeable(e) ? h('span', {class: 'dye-badge', title: 'Can be dyed'}) : null, e.members.some(m => this.hasEffect(m.item, m.variant)) ? h('span', {class: 'fx-badge', title: 'Has a particle effect'}, '✦') : null), h('span', {class: 'item-sub'}, q ? e.group : subtitle(e))),
        e.members.length > 1 ? h('span', {class: 'item-count', title: count}, String(e.members.length)) : null);
      // phones: the worn row opens its choices (tier, faction, colour, dye), when it has any, as the next level
      frag.push(on && this.hasChoices(e) ? h('div', {class: 'item-wrap'}, row, h('button', {class: 'btn-mini item-customise', onclick: () => this.setAdjusting(true)},
        'Customise', icon('turnRight'))) : row);
    }
    if (!all.length) frag.push(h('div', {class: 'empty'}, `Nothing matches “${this.query}”.`));
    this.list.replaceChildren(...frag);
    reveal(this.list, this.list.querySelector('.item.on'));
  }

  private rowNone() {
    const on = !this.state.equip[this.slot];
    const [name, sub] = EMPTY[this.slot];
    return h('button', {class: `item none${on ? ' on' : ''}`, onclick: () => this.hooks.equip(this.slot, null)},
      h('span', {class: 'item-glyph'}, icon('none')), h('span', {class: 'item-text'}, h('span', {class: 'item-name'}, name), h('span', {class: 'item-sub'}, sub)));
  }

  // keep the tier/colour you had when switching between looks of one entry
  private wornFor(e: Entry): Worn {
    const cur = this.state.equip[e.slot];
    const keep = cur && e.members.find(m => m.item.id === cur.item);
    if (keep) return {item: keep.item.id, variant: cur!.variant, colour: cur!.colour};
    const m = e.members[e.kind === 'cape' ? e.members.length - 1 : 0];
    return {item: m.item.id, variant: m.variant, colour: m.item.dyeable ? cur?.colour ?? null : null};
  }
  private pick(e: Entry) {
    if (this.query) this.slot = e.slot;
    this.hooks.equip(e.slot, this.wornFor(e));
  }

  private onKey(ev: KeyboardEvent) {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const list = this.shown;
    if (!list.length) return;
    const cur = this.state.equip[this.slot];
    let i = cur ? list.findIndex(e => e.slot === this.slot && e.members.some(m => m.item.id === cur.item)) : -1;
    i = ev.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(-1, i - 1);
    if (i < 0) this.hooks.equip(this.slot, null); else this.pick(list[i]);
    const next = list[i + (ev.key === 'ArrowDown' ? 1 : -1)];
    if (next) this.hooks.preview(next.slot, this.wornFor(next));
  }

  // matching pieces in the other armour slots, by material: the name without its slot words
  // ("Angular Bone Torso" -> "Angular Bone"); an exact material first, else its family ("Bone")
  setFor(e: Entry): Entry[] {
    const it = e.members[0].item;
    if (it.kind !== 'armour') return [];
    const mine = materialOf(e.name);
    if (!mine) return [];
    const out: Entry[] = [];
    for (const slot of ['head', 'torso', 'legs', 'hands', 'feet'] as EquipSlot[]) {
      if (slot === e.slot) continue;
      const cands = this.entries.filter(o => o.slot === slot && o.kind === 'armour' && !!o.members[0].item.dyeable === !!it.dyeable);
      const exact = cands.find(o => materialOf(o.name) === mine);
      const family = it.dyeable ? cands.find(o => { const m = materialOf(o.name); return !!m && m !== mine && mine.endsWith(' ' + m); }) : undefined;
      if (exact ?? family) out.push((exact ?? family)!);
    }
    return out;
  }

  // an equipped item that plays a particle effect in the game
  hasEffect(item: any, variant: number) {
    const v = item.variants[variant];
    return (this.pack.wornEffects ?? []).some((w: any) => ['male', 'female'].some(g => v?.[g]?.worn != null && w[g].includes(v[g].worn)));
  }

  private renderDetails() {
    const w = this.state.equip[this.slot];
    const e = this.entryOf(w);
    if (!w || !e) {
      this.root.classList.remove('adjusting');
      this.details.replaceChildren(h('p', {class: 'hint'}, !matchMedia('(pointer: coarse)').matches ? 'Click an item to try it on; ↑ ↓ step through the list.' : 'Tap an item to try it on.'));
      return;
    }
    const it = e.members.find(m => m.item.id === w.item)!.item;
    const v = it.variants[w.variant] ?? it.variants[0];
    // a one-line summary that opens the full controls in place of the list (on phones the worn row's Customise does)
    const bits = [e.members.length > 1 ? (e.kind === 'cosmetic' ? clean(v.name).split(' ')[0] : e.members.find(m => m.item.id === it.id && (e.kind === 'cape' || m.variant === w.variant))?.label) : null,
      e.kind === 'cape' && it.variants.length > 1 ? v.grade : null,
      v.colourable && it.dyeable ? this.pack.dyes.find((d: any) => d.id === (w.colour ?? this.pack.defaultColour))?.name : null].filter(Boolean);
    const adjusting = this.root.classList.contains('adjusting');
    // name what's inside: a weapon has tiers but no dye, a cosmetic colours
    const can = [e.members.length > 1 ? (e.kind === 'cosmetic' ? 'Colour' : 'Tier') : '', e.kind === 'cape' && it.variants.length > 1 ? 'faction' : '', dyeable(e) ? 'dye' : ''].filter(Boolean);
    const go = can.length ? `${can.join(' & ').replace(/^./, c => c.toUpperCase())} ›` : 'Details ›';
    const summary = h('button', {class: 'details-summary', 'aria-expanded': String(adjusting), onclick: () => this.setAdjusting(!this.root.classList.contains('adjusting'))},
      adjusting ? h('span', {class: 'ds-text'}, '‹ Back to the list') : h('span', {class: 'ds-text'}, h('b', {}, e.name), bits.length ? ` · ${bits.join(' · ')}` : ''),
      adjusting ? null : h('span', {class: 'ds-go'}, go));
    const kids: Node[] = [summary, h('div', {class: 'detail-head'},
      (() => { const mm = e.members.find(m => m.item.id === it.id && (e.kind === 'cape' || m.variant === w.variant)); const m = mm ? {...mm, variant: w.variant} : e.members[0]; return this.picture(e.slot, m, 'thumb-lg', ...this.colourFor(m, w)); })(),
      h('div', {class: 'detail-title'}, h('h3', {}, it.kind === 'cosmetic' ? clean(v.name) : e.kind === 'cape' ? clean(it.name) : e.name), h('div', {class: 'item-sub'}, subtitle(e))),
      h('button', {class: 'btn-mini', onclick: () => this.hooks.equip(this.slot, null)}, 'Take off'))];
    const examine = v.examine ?? it.examine;
    if (examine && !/<placeholder/i.test(examine)) kids.push(h('p', {class: 'examine'}, `“${examine}”`));
    // the composer dropped it whole: something drawn earlier covers the same place (the game does the same)
    if (this.hidden.has(this.slot)) {
      const by = this.hidden.get(this.slot)!, names = by.map(s => this.entryOf(this.state.equip[s])?.name ?? SLOT_LABEL[s].toLowerCase());
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
      kids.push(h('div', {class: 'hidden-note'}, h('p', {}, list
        ? `Not showing: your ${list} ${names.length > 1 ? 'cover' : 'covers'} the same place and the game draws ${names.length > 1 ? 'them' : 'it'} first, so this doesn't show while worn together (as in the game).`
        : 'Not showing: something else you wear covers the same place (as in the game).'),
        by.length ? h('button', {class: 'btn-mini', onclick: () => this.hooks.equipMany(Object.fromEntries(by.map(s => [s, undefined])))}, `Take off the ${list}`) : null));
    }
    if (this.hasEffect(it, w.variant)) kids.push(h('p', {class: 'fx-note'}, h('span', {class: 'fx-badge'}, '✦'), ' In the game this gives off a swirling ghostly effect while worn, shown here too.'));
    // a combat cape's faction first (Cryoknight, Guardian, Hammermage): it sets the look of every tier below
    if (e.kind === 'cape' && it.variants.length > 1) {
      kids.push(h('div', {class: 'label'}, 'Faction'));
      kids.push(h('div', {class: 'chips'}, ...it.variants.map((sv: any, i: number) => {
        const on = i === w.variant;
        return h('button', {class: on ? 'on' : '', 'aria-pressed': String(on), onclick: () => this.hooks.equip(e.slot, {item: it.id, variant: i, colour: null})}, sv.grade ?? `Faction ${i + 1}`);
      })));
    }
    if (e.members.length > 1) {
      const isColour = e.kind === 'cosmetic';
      // capes: a tier is an item (its factions are that item's variants, kept when changing tier)
      const same = (m: Member) => m.item.id === it.id && (e.kind === 'cape' || m.variant === w.variant);
      const cur = e.members.find(same);
      kids.push(h('div', {class: 'label'}, isColour ? 'Colour' : 'Tier', isColour ? h('b', {}, clean(v.name).split(' ')[0]) : null));
      kids.push(h('div', {class: isColour ? 'swatches' : 'chips'}, ...e.members.map(m => {
        const on = same(m);
        const mv = m.item.variants[m.variant];
        const variant = e.kind === 'cape' ? Math.min(w.variant, m.item.variants.length - 1) : m.variant;
        const pick = () => this.hooks.equip(e.slot, {item: m.item.id, variant, colour: m.item.dyeable ? w.colour : null});
        return isColour
          ? h('button', {class: `swatch${on ? ' on' : ''}`, 'aria-pressed': String(on), title: clean(mv.name), 'aria-label': clean(mv.name), style: `background:${mv.swatch ?? mv.colour?.rgb ?? '#777'}`, onclick: pick})
          : h('button', {class: on ? 'on' : '', 'aria-pressed': String(on), onclick: pick,
            title: m.item.wip ? 'In the game files, not in the game yet' : undefined}, m.label ?? '');
      })));
    }
    // matching pieces in the other slots, in this tier and dye
    const set = this.setFor(e);
    if (set.length) {
      const worn = set.filter(o => this.state.equip[o.slot] && o.members.some(m => m.item.id === this.state.equip[o.slot]!.item));
      const material = materialOf(e.name);
      if (worn.length < set.length) kids.push(h('button', {class: 'btn of-wide of-set', onclick: () => {
        const changes: Partial<Record<EquipSlot, Worn>> = {};
        for (const o of set) { const m = o.members[Math.min(w.variant, o.members.length - 1)]; changes[o.slot] = {item: m.item.id, variant: m.variant, colour: m.item.dyeable ? w.colour : null}; }
        this.hooks.equipMany(changes);
      }}, icon('set'), `Wear the matching ${material} pieces (${set.length + 1} in all)`));
      const offGrade = worn.filter(o => this.state.equip[o.slot]!.variant !== w.variant);
      if (offGrade.length && e.members.length > 1) kids.push(h('button', {class: 'btn of-wide of-set', onclick: () => {
        const changes: Partial<Record<EquipSlot, Worn>> = {};
        for (const o of offGrade) { const cur = this.state.equip[o.slot]!; changes[o.slot] = {...cur, variant: Math.min(w.variant, o.members.length - 1)}; }
        this.hooks.equipMany(changes);
      }}, icon('set'), `Make the other ${material} pieces ${e.members[w.variant]?.label ?? 'this tier'} too`));
    }
    if (v.colourable && it.dyeable) {
      const cur = w.colour ?? this.pack.defaultColour;
      const dye = this.pack.dyes.find((d: any) => d.id === cur);
      kids.push(h('div', {class: 'label'}, 'Dye', h('b', {}, dye?.name ?? '')));
      const others = this.slots.filter(s => s !== this.slot && this.state.equip[s] && this.entryOf(this.state.equip[s])?.members[0].item.dyeable && this.state.equip[s]!.colour !== cur);
      if (others.length) kids.push(h('button', {class: 'btn of-wide of-dyeall', onclick: () => {
        const changes: Partial<Record<EquipSlot, Worn>> = {};
        for (const s of others) changes[s] = {...this.state.equip[s]!, colour: cur};
        this.hooks.equipMany(changes);
      }}, icon('drop'), `Dye your other pieces ${dye?.name ?? 'this colour'} too`));
      for (const vendor of ['The Color Wheel', 'City Dyes']) {
        kids.push(h('div', {class: 'sublabel'}, vendor === 'City Dyes' ? 'City Dyes (Crenopolis)' : 'The Color Wheel (Hopeforest)'));
        kids.push(h('div', {class: 'swatches'}, ...this.pack.dyes.filter((d: any) => d.vendor === vendor).map((d: any) =>
          h('button', {class: `swatch${cur === d.id ? ' on' : ''}`, 'aria-pressed': String(cur === d.id), title: d.name ?? d.colour, 'aria-label': d.name, style: `background:${d.colour}`, onclick: () => this.hooks.equip(e.slot, {...w, colour: d.id})}))));
      }
    } else if (it.kind === 'armour' || it.kind === 'shield') {
      kids.push(h('p', {class: 'hint small'}, it.dyeable ? 'This tier has no dyeable areas.' : 'Guard gear can’t be dyed; only crafted armour and shields can.'));
    }
    this.details.replaceChildren(...kids);
  }
}

const SLOT_WORDS = new Set(['Torso', 'Legs', 'Boots', 'Gauntlets', 'Gloves', 'Helmet', 'Helm', 'Hood', 'Cap', 'Circlet', 'Robe', 'Top', 'Bottom', 'Hat']);
export const materialOf = (name: string) => name.split(' ').filter(w => !SLOT_WORDS.has(w)).join(' ');
// An inventory picture tinted as the game tints it: the same two-mask recolour its textures get (the icon
// carries a parameter image whose R channel marks the colourable part; G stays neutral).
const tintCache = new Map<string, Promise<string | null>>();
function tintedIcon(icon: number, hex: string): Promise<string | null> {
  const key = `${icon}/${hex}`;
  let p = tintCache.get(key);
  if (!p) {
    p = (async () => {
      const mr = await fetch(at(`iconmask/${icon}`));
      // (none: 204 from a development server, an empty file on the site)
      const mb = mr.status === 200 ? await mr.blob() : null;
      if (!mb?.size) return null;
      const [pic, mask] = await Promise.all([fetch(at(`icon/${icon}`)).then(r => r.blob()).then(b => createImageBitmap(b)), createImageBitmap(mb)]).catch(() => [null, null]);
      if (!pic || !mask) return null;
      const c = document.createElement('canvas'); c.width = pic.width; c.height = pic.height;
      const g = c.getContext('2d', {willReadFrequently: true})!;
      g.drawImage(mask, 0, 0, c.width, c.height); const mk = g.getImageData(0, 0, c.width, c.height).data;
      g.clearRect(0, 0, c.width, c.height); g.drawImage(pic, 0, 0); const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
      // one colour tints the R-masked part; "#r1|#r2" tints both masks, as the parts' own two tints do
      const [h1, h2] = hex.split('|'), rgb = (x: string) => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16) / 255);
      const t = rgb(h1), t2 = h2 ? rgb(h2) : [0.498, 0.498, 0.498];
      for (let i = 0; i < d.length; i += 4) {
        const r = mk[i] / 255, gm = mk[i + 1] / 255; if (!r && !gm) continue;
        const e = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
        const q = (e[0] + e[1] + e[2]) * (2 / 3), hi = Math.max(q - 1, 0), mid = Math.min(q, 1) - hi, keep = Math.max(0, 1 - r - gm);
        for (let k = 0; k < 3; k++) d[i + k] = Math.round(255 * Math.min(1, e[k] * keep + (hi + mid * t[k]) * r + (hi + mid * t2[k]) * gm));
      }
      g.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    })().catch(() => null);
    tintCache.set(key, p);
  }
  return p;
}
// Scroll an element into view within its own scroller only. (scrollIntoView also scrolls every ancestor,
// overflow: hidden ones included, which carried the phone's grab bar out of sight.)
function reveal(box: HTMLElement, el: Element | null) {
  if (!el) return;
  const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top; else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  if (r.left < b.left) box.scrollLeft -= b.left - r.left; else if (r.right > b.right) box.scrollLeft += r.right - b.right;
}
const dyeable = (e: Entry) => !!e.members[0].item.dyeable && e.members.some(m => m.item.variants[m.variant]?.colourable);
function subtitle(e: Entry) {
  const it = e.members[0].item;
  if (e.kind === 'cosmetic') return `Cosmetic · ${it.source ?? ''}${e.members.length > 1 ? ` · ${e.members.length} colours` : ''}`;
  if (e.kind === 'cape') return `${e.group.replace(/s$/, '')}${e.members.length > 1 ? ` · ${e.members.length} tiers` : ''}`;
  if (e.kind === 'weapon') return `${it.guard ? 'Guard gear' : it.source}${e.members.length > 1 ? ` · ${e.members.length} tiers` : ''}`;
  return `${it.dyeable ? it.source : 'Guard gear'}${e.members.length > 1 ? ` · ${e.members.length} tiers` : ''}`;
}
