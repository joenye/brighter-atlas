// Card constants, found in the user's own bundle at extraction time: which
// records carry an information card and where a card's subject is read from
// (cards.ts). Every rule is a data shape, so any game build works without
// build-specific data:
//
//   record class  the typed class with the card signature: yaw, pitch and
//                 roll floats, an offset vector, a pan pair, a zoom float and
//                 the second view's pan pair and zoom
//   held class    typed values [mesh definition, material, tint, tint]
//   mesh defs     kinds of record holding a mesh; their placement is the field
//                 whose typed value carries the local matrix
//   rigs          kinds of record holding a rig id and a role list; the focus
//                 role is the role nearly every rig names
//   appearance    the (kind, field) through which the most distinct records
//                 link card-carrying records to a rig
//   enemy defs    kinds of card-carrying record that link a type record (an
//                 internal snake_case name) first and list their parts as
//                 parallel mesh-definition and material fields
//   distance      the most common card distance of card-carrying records
import type {FillRow} from './replay.js';
import type {PoolNode} from './value-pool.js';
import type {ReparsedOp} from './effects.js';

export interface CardConstants {
  /** Class of the card record value. */
  recordClass: number;
  /** Class of a held item value (mesh definition, material, tint 1, tint 2). */
  heldClass: number;
  /** Record kinds that describe a rig (id and role map), held directly or
   *  through an appearance record's field. */
  rigRecords: number[];
  appearance: {runtime: number; rigField: number};
  rig: {idField: number; rolesField: number; focusRole: number};
  /** Mesh definition records and their placement value (the local matrix at
   *  its field). */
  meshDefs: {runtimes: number[]; placementField: number; placementMatrix: number};
  /** Enemy definition records. */
  enemyDefs: number[];
  /** The card distance of an actor built at run time. */
  actorDistance: number;
}

const isInt = (v: unknown): v is number => Number.isInteger(v);
const SNAKE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;

function tally<K>(m: Map<K, number>, k: K, n = 1): void { m.set(k, (m.get(k) ?? 0) + n); }
function top<K>(m: Map<K, number>): K | null {
  let best: K | null = null, count = -1;
  for (const [k, n] of m) if (n > count) { best = k; count = n; }
  return best;
}

export function deriveCardData(src: {
  rows: FillRow[]; pool: PoolNode[]; charset: ArrayLike<string>;
  decode: (slot: number) => ReparsedOp[] | null;
}): CardConstants | null {
  const { rows, pool, charset } = src;
  const deref = (n: any): any => { let k = 0; while (n && n.tag === 0 && k++ < 64) n = pool[n.value]; return n; };
  const cache = new Map<number, { op: number; n: any }[]>();
  const fields = (slot: number) => {
    let f = cache.get(slot);
    if (!f) {
      let ops: ReparsedOp[] = [];
      try { ops = src.decode(slot) ?? []; } catch { ops = []; }
      f = ops.filter((x) => x.kind === 'G').map((x: any) => ({ op: x.op, n: deref(x.node) }));
      cache.set(slot, f);
    }
    return f;
  };
  const listOf = (n: any): any[] => Array.isArray(n?.values) && n.tag !== 0x0e ? n.values.map(deref) : n ? [n] : [];
  const refsIn = (n: any): number[] => listOf(n).filter((v) => v?.tag === 0x26 && isInt(v.value)).map((v) => v.value);

  const meshDefs = new Set<number>();
  for (const row of rows) for (const e of row.g ?? []) if (e[2] === 0x62) { meshDefs.add(row.runtime as number); break; }

  const cardClasses = new Map<number, number>(), heldClasses = new Map<number, number>();
  for (const v of pool as any[]) {
    if (v?.tag !== 0x24 || !Array.isArray(v.fields)) continue;
    const f = v.fields.map(deref);
    if (f.length >= 10 && [0, 1, 2, 7, 9].every((i) => f[i]?.tag === 0x0b) && f[3]?.tag === 0x22 && f[6]?.tag === 0x18 && f[8]?.tag === 0x18) tally(cardClasses, v.class);
    if (f.length >= 4 && f[0]?.tag === 0x26 && meshDefs.has(rows[f[0].value]?.runtime as number)
      && f[1]?.tag === 0x02 && f[2]?.tag === 0x15 && f[3]?.tag === 0x15) tally(heldClasses, v.class);
  }
  const recordClass = top(cardClasses), heldClass = top(heldClasses);
  if (recordClass === null || heldClass === null) return null;

  const placement = new Map<string, number>();
  for (const row of rows) {
    if (!meshDefs.has(row.runtime as number)) continue;
    for (const { op, n } of fields(row.slot)) {
      if (n?.tag !== 0x24 || !Array.isArray(n.fields)) continue;
      n.fields.forEach((x: any, i: number) => { if (deref(x)?.tag === 0x30) tally(placement, `${op}:${i}`); });
    }
  }
  const place = top(placement);
  if (place === null) return null;

  // rig kinds: one record per kind is enough to tell
  const rigKinds = new Map<number, string>();
  const tried = new Set<number>();
  for (const row of rows) {
    const rt = row.runtime as number;
    if (tried.has(rt)) continue;
    tried.add(rt);
    const g = fields(row.slot);
    const id = g.find((x) => x.n?.tag === 0x64);
    const roles = g.find((x) => Array.isArray(x.n?.values) && x.n.tag !== 0x0e && x.op !== id?.op);
    if (id && roles) rigKinds.set(rt, `${id.op}:${roles.op}`);
  }
  const rigOps = new Map<string, number>();
  for (const k of rigKinds.values()) tally(rigOps, k);
  const rigOp = top(rigOps);
  if (rigOp === null) return null;
  const [idField, rolesField] = rigOp.split(':').map(Number);
  const roleCount = new Map<number, number>();
  for (const row of rows) {
    if (!rigKinds.has(row.runtime as number)) continue;
    const v = listOf(fields(row.slot).find((x) => x.op === rolesField)?.n);
    for (let i = 0; i + 1 < v.length; i += 2) if (v[i]?.tag === 0x26) tally(roleCount, v[i].value);
  }
  const focusRole = top(roleCount);
  if (focusRole === null) return null;

  // records carrying a card value, directly or through the pool
  const cardRows: number[] = [];
  for (const row of rows) {
    for (const e of row.g ?? []) {
      if (e[2] === 0x24 && e[3] === recordClass) { cardRows.push(row.slot); break; }
      if (e[1] === 0 && e[2] === 0 && isInt(e[3])) {
        const n = deref({ tag: 0, value: e[3] });
        if (n?.tag === 0x24 && n.class === recordClass) { cardRows.push(row.slot); break; }
      }
    }
  }
  const isRig = (slot: number) => rigKinds.has(rows[slot]?.runtime as number);
  const via = new Map<string, Set<number>>();
  for (const slot of cardRows) {
    for (const { n } of fields(slot)) for (const r of refsIn(n)) {
      const rt = rows[r]?.runtime as number;
      if (rt === undefined || rigKinds.has(rt) || meshDefs.has(rt)) continue;
      for (const { op, n: m } of fields(r)) {
        if (!refsIn(m).some(isRig)) continue;
        const k = `${rt}:${op}`;
        let s = via.get(k);
        if (!s) via.set(k, s = new Set());
        s.add(r);
      }
    }
  }
  const appearance = top(new Map([...via].map(([k, s]) => [k, s.size])));
  if (appearance === null) return null;

  const typeRow = new Map<number, boolean>();
  const isTypeRow = (slot: number) => {
    let v = typeRow.get(slot);
    if (v === undefined) {
      const first = fields(slot).find((x) => x.n?.tag === 0x0e);
      v = !!first && SNAKE.test((first.n.values ?? []).map((c: number) => charset[c] ?? '').join(''));
      typeRow.set(slot, v);
    }
    return v;
  };
  const enemyDefs = new Set<number>();
  for (const slot of cardRows) {
    const g = fields(slot);
    const one = g.find((x) => x.op === 1)?.n;
    if (one?.tag !== 0x26 || !isTypeRow(one.value)) continue;
    const byOp = new Map(g.map((x) => [x.op, listOf(x.n)]));
    const parallel = [...byOp].some(([op, l]) => l.length && l.every((d) => d?.tag === 0x26 && meshDefs.has(rows[d.value]?.runtime as number))
      && (byOp.get(op + 1) ?? []).length === l.length && byOp.get(op + 1)!.every((m) => m?.tag === 0x02));
    if (parallel) enemyDefs.add(rows[slot].runtime as number);
  }

  const distances = new Map<number, number>();
  const view = new DataView(new ArrayBuffer(4));
  for (const slot of cardRows) {
    let ops: ReparsedOp[] = [];
    try { ops = src.decode(slot) ?? []; } catch { continue; }
    const f4 = ops.filter((x: any) => x.kind === 'F' && x.raw?.length === 4) as any[];
    if (f4.length !== 1) continue;
    for (let i = 0; i < 4; i++) view.setUint8(i, f4[0].raw[i]);
    tally(distances, view.getFloat32(0, false));
  }
  const actorDistance = top(distances);
  if (actorDistance === null) return null;

  const [aRt, aOp] = appearance.split(':').map(Number);
  const [pOp, pIdx] = place.split(':').map(Number);
  const sorted = (s: Iterable<number>) => [...s].sort((a, b) => a - b);
  return {
    recordClass, heldClass, rigRecords: sorted(rigKinds.keys()),
    appearance: { runtime: aRt, rigField: aOp },
    rig: { idField, rolesField, focusRole },
    meshDefs: { runtimes: sorted(meshDefs), placementField: pOp, placementMatrix: pIdx },
    enemyDefs: sorted(enemyDefs), actorDistance,
  };
}
