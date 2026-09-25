// Card pictures: the game shows every actor, enemy, item and piece of
// scenery on an information card, as a picture of its own model posed, framed
// and lit by a card record the model's record carries. This reads those card
// records and the subjects they picture, and gives each catalogue model the
// card whose subject shares its meshes. The viewer draws them with the game's
// own programs (viewers/world/card.ts).
//
// A card record holds: yaw, pitch, roll, an offset, the clip (or the
// resting clip, or none), the time into it, the pan and zoom of the card
// view, the pan and zoom of a second (square) view, the lights (an
// environment preset) and the light's tilt and turn.
//
// Subjects:
//   actors   the placed (or never placed) actor's parts, its rig and the
//            rig's focus bone, its card distance, its held items and the
//            props of the card's clip;
//   enemies  an enemy definition's parallel mesh, material and tint fields;
//   objects  items and scenery: after the card record a base matrix and a
//            distance, the mesh definitions and the object's material table.
import type {FillRow} from './replay.js';
import {decodeGlyphText, resolveValue} from './room-metadata.js';
import type {PoolNode} from './value-pool.js';
import {readEnvironmentPreset, type RenderDecodeData} from './render-data.js';
import {cardDistance, carriesCard, type CardConstants} from './card-data.js';
import {clipRecords} from './actor-idle.js';
import type {SpawnGraph} from './spawns.js';

export const MODEL_CARDS_FORMAT = 1;

type Decode = (slot: number) => { op: number; kind: string; node?: any; raw?: ArrayLike<number>; value?: any }[] | null;

export interface CardSpec {
  record: number;
  kind: 'actor' | 'enemy' | 'object';
  label: string | null;
  view: {
    yaw: number; pitch: number; roll: number; offset: [number, number, number];
    clip: number | null; timeMs: number; pan: [number, number]; zoom: number;
    panB: [number, number]; zoomB: number;
    lights: { sky: number[]; ground: number[]; sun: number[] } | null;
    lightTurn: [number, number];
  };
  subject: { rig: number | null; focusBone: number | null; bounds: number[] | null; distance: number; base: number[] | null };
  parts: { mesh: number; material: number; renderTexture: number; recolours: number[][] | null; tint: null; matrix?: number[] | null }[];
  /** How many of the parts are the subject's own (the rest are props and held items). */
  own: number;
}

const isInt = (v: unknown): v is number => Number.isInteger(v);
const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer);
const asInt = (v: number) => { f32[0] = v; return i32[0]; };

export interface CardSources {
  rows: FillRow[];
  pool: PoolNode[];
  symbols: string[];
  charset: ArrayLike<string>;
  decode: Decode;
  /** The build's card constants (card-data.ts). */
  cards: CardConstants;
  /** The build's render data, for the cards' lights; null: default lights. */
  render: RenderDecodeData | null;
  meshBySlot: Map<number, number>;
  texturesByMaterial: Map<number, number[]>;
  /** The mesh's rig (null: not skinned). */
  meshRig: (mesh: number) => number | null;
  /** The clip's rig. */
  clipRig: (clip: number) => number | null;
  /** The clip's length in milliseconds (0: unknown). */
  clipDuration: (clip: number) => number;
  spawnGraph: SpawnGraph;
  /** Display names of enemy definitions (display-names.ts). */
  enemyNames: Map<number, { name: string }>;
  /** The record's own name (names.ts). */
  nameOf?: (slot: number) => string | null;
}

/** Every card in the build, one per record that carries one. */
export function readCards(src: CardSources): CardSpec[] {
  const { rows, pool, decode, render } = src;
  const k = src.cards;
  const node = (n: any): any => resolveValue(pool, n);
  const num = (n: any) => { n = node(n); return n?.tag === 0x0b && Array.isArray(n.value) ? Number(n.value[0]) : null; };
  const vec = (n: any): number[] | null => { n = node(n); return Array.isArray(n?.value) ? n.value.map(Number) : null; };
  const colour = (n: any): number[] | null => { n = node(n); return n?.tag === 0x15 && Array.isArray(n.value) ? n.value.map(Number) : null; };
  const texOf = (m: number) => src.texturesByMaterial.get(m)?.[0] ?? -1;
  const partFrom = (mesh: number, material: number, a: number[] | null, b: number[] | null): CardSpec['parts'][number] =>
    ({ mesh, material, renderTexture: texOf(material), recolours: a && b ? [a, b] : null, tint: null });
  const fieldCache = new Map<number, NonNullable<ReturnType<Decode>>>();
  const fieldsOf = (slot: number) => {
    let f = fieldCache.get(slot);
    if (!f) { try { f = decode(slot) ?? []; } catch { f = []; } fieldCache.set(slot, f); }
    return f;
  };
  const text = (n: any): string | null => decodeGlyphText(node(n), src.charset);
  const clipOfRecord = src.spawnGraph.idleResolver?.clipOfRecord() ?? clipRecords(rows);
  const lightsOf = (n: any) => {
    if (!render) return null;
    n = node(n);
    if (n?.tag === 0x26 && isInt(n.value)) {
      const f = fieldsOf(n.value).find((x) => x.op === render.environment.field);
      n = f?.kind === 'G' ? node(f.node) : null;
    }
    const env = readEnvironmentPreset(render, n, rows, fieldsOf, pool, src.symbols);
    return env ? { sky: env.sky, ground: env.ground, sun: env.sun } : null;
  };
  const viewOf = (f: any[]): [CardSpec['view'], any] => {
    const anim = node(f[4]);
    let clip: any = null;
    let timeMs = asInt(vec(f[5])?.[1] ?? 0);
    if (anim?.tag === 0x26) clip = clipOfRecord.get(anim.value) ?? null;
    else if (anim?.tag === 0x0f) clip = src.symbols[anim.value];
    else if (Array.isArray(anim?.values) && anim.values.length) {
      // a list of clips plays as one sequence: the time falls in one of them
      const seq = anim.values.map(node).map((n: any) => n?.tag === 0x26 ? clipOfRecord.get(n.value) ?? null : null);
      if (seq.every(isInt)) {
        const durs = seq.map((c: number) => src.clipDuration(c));
        const total = durs.reduce((a: number, b: number) => a + b, 0);
        let t = total > 0 ? timeMs % total : timeMs, i = 0;
        while (i < seq.length - 1 && t >= durs[i]) { t -= durs[i]; i++; }
        clip = seq[i]; timeMs = t;
      }
    }
    const vec2 = (n: any, d: [number, number]): [number, number] => { const v = vec(n); return v && v.length >= 2 ? [v[0], v[1]] : d; };
    const off = vec(f[3]);
    return [{
      yaw: num(f[0]) ?? 0, pitch: num(f[1]) ?? 0, roll: num(f[2]) ?? 0,
      offset: off && off.length >= 3 ? [off[0], off[1], off[2]] : [0, 0, 0],
      clip, timeMs, pan: vec2(f[6], [0, 0]), zoom: num(f[7]) ?? 15,
      panB: vec2(f[8], [0, 0]), zoomB: num(f[9]) ?? 10,
      lights: lightsOf(f[10]), lightTurn: [num(f[11]) ?? 0, num(f[12]) ?? 0],
    }, anim];
  };
  const isCard = (x: any) => x.kind === 'G' && node(x.node)?.tag === 0x24 && node(x.node)?.class === k.recordClass;
  const cardField = (fs: any[]) => fs.find(isCard);
  const runtime = (slot: number) => rows[slot]?.runtime;
  const rigKinds = new Set(k.rigRecords);
  const isRigRecord = (slot: number) => rigKinds.has(runtime(slot)!);
  const readRig = (record: number) => {
    let rig: number | null = null, focusBone: number | null = null;
    for (const y of fieldsOf(record)) {
      const n = node(y.node);
      if (y.op === k.rig.idField && isInt(n?.value)) rig = n.value;
      if (y.op === k.rig.rolesField && Array.isArray(n?.values)) {
        const v = n.values.map(node);
        for (let i = 0; i + 1 < v.length; i += 2) if (v[i]?.tag === 0x26 && v[i].value === k.rig.focusRole && isInt(v[i + 1]?.value)) focusBone = v[i + 1].value;
      }
    }
    return { rig, focusBone };
  };
  // every rig's focus bone (for subjects whose own record names no rig record)
  let focusByRig: Map<number, number> | null = null;
  const focusOf = (rig: number) => {
    if (!focusByRig) {
      focusByRig = new Map();
      for (const row of rows) {
        if (!rigKinds.has(row.runtime)) continue;
        const r = readRig(row.slot);
        if (r.rig !== null && r.focusBone !== null && !focusByRig.has(r.rig)) focusByRig.set(r.rig, r.focusBone);
      }
    }
    return focusByRig.get(rig) ?? null;
  };
  const refsIn = (n: any): number[] => {
    n = node(n);
    if (n?.tag === 0x26 && isInt(n.value)) return [n.value];
    if (Array.isArray(n?.values)) return n.values.map(node).filter((v: any) => v?.tag === 0x26 && isInt(v.value)).map((v: any) => v.value);
    return [];
  };
  // the rig record: directly, through an appearance record, or through the
  // record's own animation records
  const rigOf = (fs: any[]): { rig: number | null; focusBone: number | null } => {
    const gs = fs.filter((x) => x.kind === 'G');
    let record: number | null = null;
    const direct = gs.flatMap((x) => refsIn(x.node)).find(isRigRecord);
    if (direct !== undefined) record = direct;
    for (const x of gs) {
      if (record !== null) break;
      for (const r of refsIn(x.node)) {
        if (runtime(r) !== k.appearance.runtime) continue;
        const f = fieldsOf(r).find((y) => y.op === k.appearance.rigField);
        const hit = f ? refsIn(f.node).find(isRigRecord) : undefined;
        if (hit !== undefined) { record = hit; break; }
      }
    }
    if (record === null) {
      for (const r of gs.flatMap((x) => refsIn(x.node))) {
        const hit = fieldsOf(r).filter((y) => y.kind === 'G').flatMap((y) => refsIn(y.node)).find(isRigRecord);
        if (hit !== undefined) { record = hit; break; }
      }
    }
    return record !== null ? readRig(record) : { rig: null, focusBone: null };
  };
  // the rig must be the parts' own: a record naming another rig is not this subject's
  const checkRig = (r: { rig: number | null; focusBone: number | null }, meshes: number[], clip: any) => {
    const own = meshes.map(src.meshRig).filter((x): x is number => x !== null);
    if (!own.length || (r.rig !== null && own.includes(r.rig))) return r;
    const cr = typeof clip === 'number' ? src.clipRig(clip) : null;
    const rig = cr !== null && own.includes(cr) ? cr : own[0];
    return { rig, focusBone: focusOf(rig) };
  };
  const heldOf = (fs: any[]) => {
    for (const x of fs) {
      if (x.kind !== 'G') continue;
      const n = node(x.node), vals = Array.isArray(n?.values) ? n.values.map(node) : [];
      if (!vals.length || !vals.every((v: any) => v?.tag === 0x24 && v.class === k.heldClass)) continue;
      const out: CardSpec['parts'] = [];
      for (const v of vals) {
        const def = node(v.fields[0]), mat = node(v.fields[1]);
        const mesh = def?.tag === 0x26 ? src.meshBySlot.get(def.value) : undefined;
        if (!isInt(mesh) || mat?.tag !== 0x02) continue;
        out.push(partFrom(mesh, mat.value, colour(v.fields[2]), colour(v.fields[3])));
      }
      return out;
    }
    return [];
  };
  const boundsOf = (fs: any[]) => { for (const x of fs) { const n = node(x.node); if (n?.tag === 0x25 && Array.isArray(n.value) && n.value.length === 6) return n.value.map(Number); } return null; };
  const partOf = (p: any) => ({ mesh: p.mesh, material: p.material_slot, renderTexture: p.texture,
    recolours: p.recolors ? p.recolors.slice(0, 2).map((r: any) => r.map(Number)) : null, tint: null as null });
  const propsOf = (anim: any, rigs: Set<number>) => (anim?.tag === 0x26 && src.spawnGraph.idleResolver && rigs.size > 0)
    ? src.spawnGraph.idleResolver.props(anim.value, rigs, src.meshRig).map(partOf) : [];
  const meshDefs = new Set(k.meshDefs.runtimes), enemyDefs = new Set(k.enemyDefs);
  const isDef = (v: any) => v?.tag === 0x26 && meshDefs.has(runtime(v.value)!);
  const listOf = (n: any) => { n = node(n); return Array.isArray(n?.values) && n.tag !== 0x0e && n.tag !== 0x15 ? n.values.map(node) : n ? [n] : []; };

  const cards: CardSpec[] = [];
  const actor = (slot: number, fs: any[], card: any) => {
    let s: any = null;
    try { s = src.spawnGraph.spawn(slot); } catch { s = null; }
    let parts: any[] = s?.parts ?? [];
    let label: string | null = s?.label ?? null;
    let unplaced = false;
    if (!parts.length) {
      const app = src.spawnGraph.unplacedAppearance(slot);
      if (!app) return;
      parts = app.parts; label = app.label; unplaced = true;
    }
    const [view, anim] = viewOf(node(card.node).fields);
    const found = rigOf(fs);
    if (unplaced && found.rig === null) return;
    const { rig, focusBone } = checkRig(found, parts.map((p: any) => p.mesh), view.clip);
    const rigs = new Set(rig !== null ? [rig] : []);
    let clip: any = view.clip, idleProps: any[] = [];
    if (clip === '$idle') {
      if (s) { clip = s.idle_clip ?? null; idleProps = s.idle_props ?? []; }
      else {
        const r = src.spawnGraph.idleResolver?.resolve(slot, rigs);
        clip = r?.clip ?? null;
        idleProps = r ? src.spawnGraph.idleResolver!.props(r.controller, rigs, src.meshRig) : [];
      }
    } else if (typeof clip !== 'number') clip = null;
    view.clip = clip;
    cards.push({ record: slot, kind: 'actor', label: src.nameOf?.(slot) ?? label, view,
      subject: { rig, focusBone, bounds: boundsOf(fs), distance: cardDistance(fs) ?? k.actorDistance, base: null },
      parts: [...parts.map(partOf), ...idleProps.map(partOf), ...propsOf(anim, rigs), ...heldOf(fs)], own: parts.length });
  };
  // an enemy's template actor: a record the definition references holds a
  // typed value naming an actor with its own card and card distance
  const templateOf = (fs: any[]): any[] | null => {
    for (const x of fs) {
      const t = x.kind === 'G' ? node(x.node) : null;
      if (t?.tag !== 0x26 || !isInt(t.value)) continue;
      for (const y of fieldsOf(t.value)) {
        const n = y.kind === 'G' ? node(y.node) : null;
        if (n?.tag !== 0x24 || !Array.isArray(n.fields)) continue;
        for (const f of n.fields) {
          const r = node(f);
          if (r?.tag !== 0x26 || !isInt(r.value)) continue;
          const rf = fieldsOf(r.value);
          if (cardField(rf) && cardDistance(rf) !== null) return rf;
        }
      }
    }
    return null;
  };
  const enemy = (slot: number, fs: any[], card: any) => {
    const [view, anim] = viewOf(node(card.node).fields);
    const template = templateOf(fs);
    const gs = new Map(fs.filter((x) => x.kind === 'G').map((x) => [x.op, listOf(x.node)]));
    let parts: CardSpec['parts'] = [];
    for (const [op, list] of gs) {
      if (!list.length || !list.every(isDef)) continue;
      const mats = gs.get(op + 1) ?? [], t1 = gs.get(op + 2) ?? [], t2 = gs.get(op + 3) ?? [];
      parts = list.map((v: any, i: number) => {
        const mesh = src.meshBySlot.get(v.value), mat = mats[i];
        if (!isInt(mesh) || mat?.tag !== 0x02) return null;
        return partFrom(mesh, mat.value, colour(t1[i]), colour(t2[i]));
      }).filter(Boolean) as CardSpec['parts'];
      break;
    }
    if (!parts.length) return;
    let found = rigOf(fs);
    if (found.rig === null && template) found = rigOf(template);
    const { rig, focusBone } = checkRig(found, parts.map((p) => p.mesh), view.clip);
    const rigs = new Set(rig !== null ? [rig] : []);
    if ((view.clip as any) === '$idle') view.clip = src.spawnGraph.idleResolver?.resolve(slot, rigs)?.clip ?? null;
    else if (typeof view.clip !== 'number') view.clip = null;
    cards.push({ record: slot, kind: 'enemy', label: src.nameOf?.(slot) ?? src.enemyNames.get(slot)?.name ?? null, view,
      subject: { rig, focusBone, bounds: boundsOf(fs) ?? (template ? boundsOf(template) : null),
        // 0: the build names no distance for this enemy (the viewer takes one by size)
        distance: template ? cardDistance(template) ?? k.actorDistance : 0, base: null },
      parts: [...parts, ...propsOf(anim, rigs), ...heldOf(fs)], own: parts.length });
  };
  // an object's material table: N material slots from op7, then colour fields
  // ending in one (tint, tint, extra) triple per slot
  const tableOf = (n: any): { materials: number[]; colours: any[] } | null => {
    if (n?.tag !== 0x26 || !isInt(n.value)) return null;
    const f = fieldsOf(n.value);
    const at = (op: number) => node(f.find((y) => y.op === op)?.node);
    const materials: number[] = [];
    let op = 7;
    for (; at(op)?.tag === 0x02; op++) materials.push(at(op).value);
    if (!materials.length) return null;
    const colours: any[] = [];
    for (; at(op)?.tag === 0x15; op++) colours.push(at(op));
    return colours.length >= 3 * materials.length ? { materials, colours: colours.slice(colours.length - 3 * materials.length) } : null;
  };
  // the empty (untextured) material is the one material tables most often
  // leave in a slot: counted over every table read, resolved after the pass
  const slotCounts = new Map<number, number>();
  const pending: { part: CardSpec['parts'][number]; own: number; slotMaterial: number | null }[] = [];
  const object = (slot: number, fs: any[]) => {
    const cardsHere = fs.filter(isCard);
    const baseField = fs.find((x) => x.kind === 'G' && node(x.node)?.tag === 0x30 && x.op > cardsHere[0].op);
    if (!baseField) return;
    const card = [...cardsHere].reverse().find((x) => x.op < baseField.op)!;
    const dField = fs.find((x) => x.kind === 'F' && x.raw?.length === 4 && x.op > baseField.op);
    if (!dField) return;
    // the mesh definitions (consecutive fields), the object's material, its material table
    const after = fs.filter((x) => x.kind === 'G' && x.op > dField.op).sort((a, b) => a.op - b.op);
    const start = after.findIndex((x) => { const l = listOf(x.node); return l.length && l.every(isDef); });
    if (start < 0) return;
    // a part's slot is its place among the object's eight part fields ($none
    // marks an unused one)
    const defs: number[] = [], slots: number[] = [];
    let i = start;
    for (; i < after.length; i++) {
      const at = after[i].op - after[start].op;
      if (at >= 8 && defs.length) break;
      const l = listOf(after[i].node);
      if (!l.length || !l.every(isDef)) {
        const n = node(after[i].node);
        if (n?.tag === 0x0f && src.symbols[n.value] === '$none') continue;
        break;
      }
      l.forEach((v: any, j: number) => { defs.push(v.value); slots.push(at + j); });
    }
    const matField = after.slice(i).find((x) => node(x.node)?.tag === 0x02);
    if (!matField) return;
    const objectMaterial = node(matField.node).value;
    const table = after.filter((x) => x.op > matField.op).map((x) => tableOf(node(x.node))).find(Boolean) ?? null;
    if (table) for (const m of table.materials) slotCounts.set(m, (slotCounts.get(m) ?? 0) + 1);
    const parts: CardSpec['parts'] = [];
    defs.forEach((def, j) => {
      const mesh = src.meshBySlot.get(def);
      if (!isInt(mesh)) return;
      const df = fieldsOf(def);
      // a one-slot table serves every part; an empty slot leaves the object's own material
      const slot = table ? Math.min(slots[j], table.materials.length - 1) : -1;
      const material = slot >= 0 ? table!.materials[slot] : objectMaterial;
      const a = slot >= 0 ? colour(table!.colours[3 * slot]) : null, b = slot >= 0 ? colour(table!.colours[3 * slot + 1]) : null;
      const placement = node(df.find((y) => y.op === k.meshDefs.placementField)?.node);
      const local = placement?.tag === 0x24 && Array.isArray(placement.fields) ? node(placement.fields[k.meshDefs.placementMatrix]) : null;
      parts.push({ mesh, material, renderTexture: texOf(material),
        recolours: a && b ? [a, b].map((c) => [c[0] / 2, c[1] / 2, c[2] / 2, c[3]]) : null, tint: null,
        matrix: local?.tag === 0x30 && Array.isArray(local.value) ? local.value.map(Number) : null });
      pending.push({ part: parts[parts.length - 1], own: objectMaterial, slotMaterial: slot >= 0 ? material : null });
    });
    if (!parts.length) return;
    const [view] = viewOf(node(card.node).fields);
    view.clip = null;
    const names = fs.map((x) => text(x.node)).filter((t): t is string => !!t && t.length < 60 && !/[.!?]$/.test(t.trim()));
    const twice = names.find((t, j) => names.indexOf(t) !== j) ?? null;
    cards.push({ record: slot, kind: 'object', label: src.nameOf?.(slot) ?? twice, view,
      subject: { rig: null, focusBone: null, bounds: boundsOf(fs), distance: cardDistance([dField])!, base: vec(baseField.node) },
      parts, own: parts.length });
  };

  for (const row of rows) {
    // cheap gate: records holding a value of the card class
    if (!carriesCard(row, k.recordClass, node)) continue;
    const fs = fieldsOf(row.slot);
    const card = cardField(fs);
    if (!card) continue;
    try {
      if (enemyDefs.has(row.runtime)) enemy(row.slot, fs, card);
      else {
        const before = cards.length;
        actor(row.slot, fs, card);
        if (cards.length === before) object(row.slot, fs);
      }
    } catch { /* a record this reader cannot follow has no card */ }
  }
  let empty: number | null = null, most = 0;
  for (const [m, n] of slotCounts) if (n > most) { empty = m; most = n; }
  for (const p of pending) if (p.slotMaterial !== null && p.slotMaterial === empty) {
    p.part.material = p.own; p.part.renderTexture = texOf(p.own);
  }
  return cards;
}

/** Each catalogue model's card: the card whose subject's meshes best match the
 *  model's (default variant first), by overlap of mesh sets. */
export function assignModelCards(models: any[], cards: CardSpec[]): Record<string, CardSpec> {
  const byMesh = new Map<number, number[]>();
  const sets = cards.map((c) => new Set(c.parts.slice(0, c.own).map((p) => p.mesh)));
  sets.forEach((s, i) => { for (const m of s) { let l = byMesh.get(m); if (!l) byMesh.set(m, l = []); l.push(i); } });
  const out: Record<string, CardSpec> = {};
  for (const model of models) {
    if (typeof model?.id !== 'string') continue;
    const groups = [model.parts ?? [], ...(model.variants ?? []).map((v: any) => v.parts ?? [])]
      .map((ps: any[]) => new Set(ps.map((p: any) => Number(p.mesh ?? p.ab5_mesh)).filter(isInt)));
    let best: [number, number] | null = null;
    groups.forEach((meshes, g) => {
      const seen = new Set<number>();
      for (const m of meshes) for (const i of byMesh.get(m) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        let inter = 0;
        for (const x of sets[i]) if (meshes.has(x)) inter++;
        const score = inter / (sets[i].size + meshes.size - inter) - g * 1e-3;
        if (!best || score > best[1] || (score === best[1] && cards[i].record < cards[best[0]].record)) best = [i, score];
      }
    });
    if (best && best[1] >= 0.5) out[model.id] = cards[best[0]];
  }
  return out;
}
