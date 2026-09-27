// A room's neighbours as the game loads them: the rooms directly through its
// doors (the world index's door links), at their places in the stitched
// world relative to the room. Rooms outside the connected layout have no
// stitched place and stay out, as does a room without one itself.

export interface DoorNeighbour {
  id: number;
  /** Where the neighbour's tile (0, 0) sits from the room's (whole tiles). */
  x: number;
  y: number;
}

export function doorNeighbours(index: { rooms?: any[]; links?: any[] } | null | undefined, roomId: number): DoorNeighbour[] {
  const rooms = new Map<number, any>((index?.rooms ?? []).map((r: any) => [Number(r.id), r]));
  const placed = (id: number) => {
    const at = rooms.get(id)?.world;
    return !!at && Number.isFinite(at.x) && Number.isFinite(at.y);
  };
  if (!placed(roomId)) return [];
  const home = rooms.get(roomId).world;
  const through = new Set<number>();
  // every room through a door, whatever height its doors sit at
  for (const link of index?.links ?? []) {
    const a = Number(link.a), b = Number(link.b);
    if (a === roomId) through.add(b);
    if (b === roomId) through.add(a);
  }
  through.delete(roomId);
  return [...through].filter(placed).map((id) => {
    const at = rooms.get(id).world;
    return { id, x: at.x - home.x, y: at.y - home.y };
  });
}
