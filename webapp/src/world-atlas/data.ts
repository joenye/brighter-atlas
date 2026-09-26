// The hosted world map's data: every game release's 2D map, served from the
// site (world-data/). This is the one place the app shows game content it
// did not read from the user's own files, and only the 2D map: its terrain,
// room labels and their artwork.
//
//   manifest.json   releases (date, label, build string, style, art, rooms as piece ids),
//                   the packs, and which pack holds each piece
//   packs/*.json    room pieces: label, colours, terrain. 'latest'
//                   holds the newest release's rooms; the rest sit once in
//                   the pack of the month they first appeared
//   styles/*.json   label fonts and backgrounds
//   art/*.bin       images: zlib-deflated 'BAIM' + width + height + raw RGBA
//
// A release's map is assembled from its pieces with rooms numbered by
// position (the served pieces carry no build record numbers).
import { unzlibSync } from '../../vendor/fflate.module.js';
import type { MapDocument } from '../extract/maps/index.js';
import type { MapBitmap } from '../extract/maps/images.js';

export interface WorldRelease {
  id: string; date: string; label: string | null; style: string;
  /** The game's build string ("0.99.3-278abe752c42bda0"); absent in older data. */
  build?: string | null;
  art: { terrain: string[]; images: Record<string, string> };
  rooms: number[];
}
export interface WorldManifest {
  format: 1; releases: WorldRelease[]; packs: { file: string; count: number }[]; pieces: number[];
  /** Sealed episodes: areas shown only as silhouettes, with their logo. */
  sealed?: Record<string, { name: string; logo: string }>;
}
/** A sealed area: the whole map tiles its rooms cover (x, y pairs). */
export interface SealedArea { key: string; name: string; logo: string; cells: number[] }
interface Piece { room?: any; shingles?: number[]; sealed?: string; cells?: number[] }
export interface WorldMap { release: WorldRelease; doc: MapDocument; sealed: SealedArea[] }

const SHINGLE = 23;   // x, y, base colour, four corner colours, sixteen tiles

export function createWorldData(base = 'world-data/') {
  const get = async (path: string) => {
    const response = await fetch(base + path);
    if (!response.ok) throw Error(`${path}: HTTP ${response.status}`);
    return response;
  };
  let manifest: WorldManifest | null = null;
  const pieces = new Map<number, Piece>();
  const packs = new Map<number, Promise<void>>();
  const styles = new Map<string, Promise<any>>();
  const images = new Map<string, Promise<MapBitmap>>();
  const docs = new Map<string, WorldMap>();

  function loadPack(index: number): Promise<void> {
    let p = packs.get(index);
    if (!p) {
      p = get(manifest!.packs[index].file).then((r) => r.json()).then((pack: { pieces: [number, Piece][] }) => {
        for (const [id, piece] of pack.pieces) pieces.set(id, piece);
      });
      p.catch(() => packs.delete(index));   // a failed pack can be fetched again
      packs.set(index, p);
    }
    return p;
  }
  function loadStyle(hash: string): Promise<any> {
    let p = styles.get(hash);
    if (!p) { p = get(`styles/${hash}.json`).then((r) => r.json()); p.catch(() => styles.delete(hash)); styles.set(hash, p); }
    return p;
  }
  function loadImage(hash: string): Promise<MapBitmap> {
    let p = images.get(hash);
    if (!p) {
      p = get(`art/${hash}.bin`).then((r) => r.arrayBuffer()).then((buffer) => {
        const bytes = unzlibSync(new Uint8Array(buffer));
        if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'BAIM') throw Error(`art/${hash}.bin: not an image`);
        const view = new DataView(bytes.buffer, bytes.byteOffset, 12);
        return { width: view.getUint32(4, true), height: view.getUint32(8, true), rgba: bytes.subarray(12) };
      });
      p.catch(() => images.delete(hash));
      images.set(hash, p);
    }
    return p;
  }
  /** The packs a release needs that are not loaded yet. */
  const missingPacks = (release: WorldRelease) =>
    [...new Set(release.rooms.filter((id) => !pieces.has(id)).map((id) => manifest!.pieces[id]))];

  return {
    async manifest(): Promise<WorldManifest> {
      if (!manifest) {
        const m = await (await get('manifest.json')).json();
        if (m?.format !== 1 || !Array.isArray(m.releases) || !m.releases.length) throw Error('The world map data is not available.');
        manifest = m as WorldManifest;
      }
      return manifest;
    },
    /** True when the release can be shown without another download. */
    ready(release: WorldRelease): boolean { return !missingPacks(release).length; },
    /** Load every pack (a background fill after the first map). */
    async prefetch(): Promise<void> { for (let i = 0; i < manifest!.packs.length; i++) await loadPack(i).catch(() => {}); },
    async map(release: WorldRelease): Promise<WorldMap> {
      const cached = docs.get(release.id);
      if (cached) { docs.delete(release.id); docs.set(release.id, cached); return cached; }
      await Promise.all([...missingPacks(release).map(loadPack), loadStyle(release.style),
        ...release.art.terrain.map(loadImage), ...Object.values(release.art.images).map(loadImage)]);
      const style = await loadStyle(release.style);
      // the same image objects for releases that share art: the renderer then
      // keeps its textures when the release changes
      const artKey = JSON.stringify(release.art);
      const art = artSets.get(artKey) ?? { terrainMips: await Promise.all(release.art.terrain.map(loadImage)),
        images: Object.fromEntries(await Promise.all(Object.entries(release.art.images).map(async ([k, h]) => [k, await loadImage(h)] as const))) };
      artSets.set(artKey, art);
      const rooms: any[] = [], shingles: any[] = [], sealed = new Map<string, number[]>();
      for (const id of release.rooms) {
        const piece = pieces.get(id);
        if (!piece) throw Error(`piece ${id} is missing from its pack`);
        if (piece.sealed) {   // a sealed room: its silhouette only
          const cells = sealed.get(piece.sealed) ?? sealed.set(piece.sealed, []).get(piece.sealed)!;
          for (const c of piece.cells ?? []) cells.push(c);
          continue;
        }
        const i = rooms.length;
        rooms.push({ ...piece.room, room: i, owner: i });
        const s = piece.shingles!;
        for (let k = 0; k + SHINGLE <= s.length; k += SHINGLE) {
          shingles.push({ index: shingles.length, room: i, position: [s[k], s[k + 1]], group: 0, base555: s[k + 2],
            corners555: s.slice(k + 3, k + 7), tiles: s.slice(k + 7, k + SHINGLE) });
        }
      }
      const { format: _format, ...sceneStyle } = style;
      const doc = { format: 1, scene: { ...sceneStyle, rooms, shingles }, terrainMips: art.terrainMips, images: art.images, roomData: null } as unknown as MapDocument;
      const map = { release, doc, sealed: [...sealed].map(([key, cells]) => ({ key, cells,
        name: manifest!.sealed?.[key]?.name ?? 'Sealed', logo: base + (manifest!.sealed?.[key]?.logo ?? '') })) };
      // assembled maps are large next to their pieces: keep the last few
      docs.set(release.id, map);
      while (docs.size > 8) docs.delete(docs.keys().next().value!);
      return map;
    },
  };
}
const artSets = new Map<string, { terrainMips: MapBitmap[]; images: Record<string, MapBitmap> }>();

export type WorldData = ReturnType<typeof createWorldData>;
