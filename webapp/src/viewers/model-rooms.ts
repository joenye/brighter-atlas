// "Show in world" for a model: the rooms it stands in, and a jump into one of
// them with the model pinned in inspect mode. A room shows the model where one
// of its spawns or model occurrences resolves to it by the World view's own
// rule: the smallest catalog model holding every mesh of the group. Rooms are
// narrowed by the world index's per-room mesh lists before any shard is read.

import { el } from '../ui.js';

export const REVEAL_KEY = 'bs.model.reveal';

export interface ModelRoom {
  room: number;
  name: string;
  count: number;
  /** A placement of the model in the room, for the World view's pin. */
  ref: { room: number; category: string; sourceKind: string; placementIndex: number };
}

const colIndex = (cols: string[] | undefined, name: string) => (cols ?? []).indexOf(name);

export async function modelRooms(app: any, model: any, onProgress: (done: number, total: number) => void = () => {}): Promise<ModelRoom[]> {
  const index = await app.store.worldIndex();
  if (!index?.rooms?.length) return [];
  const own = new Set<number>((model.parts ?? []).map((p: any) => Number(p.mesh)));
  if (!own.size) return [];
  const all = index.rooms.filter((r: any) => Array.isArray(r.meshes) && [...own].every((m) => r.meshes.includes(m)));
  const candidates = all.length ? all : index.rooms.filter((r: any) => Array.isArray(r.meshes) && r.meshes.some((m: number) => own.has(m)));

  const byMesh = new Map<number, { id: string; size: number; meshes: Set<number> }[]>();
  for (const m of await app.loadSystemModels()) {
    const meshes = new Set<number>((m.parts ?? []).map((p: any) => Number(p.mesh)));
    for (const mesh of meshes) {
      let list = byMesh.get(mesh);
      if (!list) byMesh.set(mesh, list = []);
      list.push({ id: m.id, size: meshes.size, meshes });
    }
  }
  const resolves = (meshes: Set<number>) => {
    let best: { id: string; size: number } | null = null;
    const first = meshes.values().next().value;
    for (const c of byMesh.get(first as number) ?? []) {
      if (![...meshes].every((m) => c.meshes.has(m))) continue;
      if (!best || c.size < best.size) best = c;
    }
    return best?.id === model.id;
  };

  const pc = index.columns?.placement, sc = index.columns?.spawn_part;
  const pOcc = colIndex(pc, 'occurrence'), pMesh = colIndex(pc, 'mesh');
  const sSpawn = colIndex(sc, 'spawn'), sMesh = colIndex(sc, 'mesh');
  const out: ModelRoom[] = [];
  let done = 0;
  for (const room of candidates) {
    let shard: any = null;
    try { shard = await app.store.worldRoom(room.id); } catch { shard = null; }
    onProgress(++done, candidates.length);
    if (!shard) continue;
    const groups = new Map<string, { meshes: Set<number>; ref: ModelRoom['ref'] }>();
    const add = (key: string, mesh: number, ref: ModelRoom['ref']) => {
      let g = groups.get(key);
      if (!g) groups.set(key, g = { meshes: new Set(), ref });
      g.meshes.add(mesh);
    };
    (shard.spawn_parts ?? []).forEach((row: any[], i: number) =>
      add(`s${row[sSpawn]}`, Number(row[sMesh]), { room: room.id, category: 'spawns', sourceKind: 'spawn', placementIndex: i }));
    (shard.placements?.models ?? []).forEach((row: any[], i: number) =>
      add(`o${row[pOcc]}`, Number(row[pMesh]), { room: room.id, category: 'models', sourceKind: 'occurrence', placementIndex: i }));
    let count = 0, ref: ModelRoom['ref'] | null = null;
    for (const g of groups.values()) if (resolves(g.meshes)) { count++; ref ??= g.ref; }
    if (ref) out.push({ room: room.id, name: room.name || `Room ${room.id}`, count, ref });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The "Show in world" dialog: the model's rooms, each a jump into the room
 *  with the model pinned. */
export async function openModelRoomsModal(app: any, model: any): Promise<void> {
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => overlay.remove();
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  const status = el('p', { class: 'dim small', text: 'Finding rooms…' });
  const list = el('div', { class: 'model-rooms' });
  const closeBtn = el('button', { class: 'btn', text: 'Close' });
  closeBtn.addEventListener('click', close);
  overlay.appendChild(el('div', { class: 'modal card' },
    el('h2', { text: `Show in world: ${model.name || 'model'}` }), status, list,
    el('div', { class: 'modal-actions' }, el('span', { class: 'spacer' }), closeBtn)));
  document.body.appendChild(overlay);

  const rooms = await modelRooms(app, model, (done, total) => { status.textContent = `Finding rooms… ${done} of ${total}`; })
    .catch(() => []);
  if (!overlay.isConnected) return;
  if (!rooms.length) { status.textContent = 'This model is not placed in any room of this version.'; return; }
  status.textContent = rooms.length === 1 ? 'Placed in 1 room.' : `Placed in ${rooms.length} rooms.`;
  for (const r of rooms) {
    const btn = el('button', { class: 'btn model-room', text: r.count > 1 ? `${r.name} (${r.count})` : r.name });
    btn.addEventListener('click', () => {
      try { sessionStorage.setItem(REVEAL_KEY, JSON.stringify({ model: model.id, ref: r.ref })); } catch { /* the room still opens */ }
      close();
      location.hash = `#/world/${r.room}`;
    });
    list.appendChild(btn);
  }
}
