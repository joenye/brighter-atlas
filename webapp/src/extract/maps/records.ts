// The map's authored room records are independent of room occupancy and meshes.
// Decode their terrain and label primitives without loading either asset bundle.
import {makeRegistryRowDecoder} from '../world/effects.js';
import {deriveRoomMetadata, resolveValue, decodeGlyphText, decodeSignedPair,
  type RoomMetadata} from '../world/room-metadata.js';
import type {FillRow} from '../world/replay.js';
import type {PoolNode} from '../world/value-pool.js';
import type {WorldProfile} from '../world/profile.js';

type Color = [number, number, number, number];
type Pair = [number, number];
export interface MapValue {
  tag: number;
  value?: unknown;
  symbol?: string | null;
  text?: string | null;
  class?: number;
  fields?: MapValue[];
  values?: MapValue[];
}
export interface MapAnnotation {
  text: string;
  glyphs: number[];
  styleOwner: number;
  palette: Color[];
  parameter: number;
  marker: MapValue;
  condition: MapValue;
  source: {field: number | null; index: number; typedClass: number; tableOffset?: number};
}
export interface MapRoomRecord extends RoomMetadata {
  terrain: {
    lut: number;
    positions: Pair[];
    styles: number[];
    groupCounts: number[];
    baseColors: Color[];
  };
  labels: {
    title: string;
    glyphs: number[];
    offsets: [Pair, Pair];
    metrics: number[][];
    connector: MapValue;
    background: MapValue;
    annotations: MapAnnotation[];
    annotationEntries: MapValue[];
  };
  mapSource: {lutField: number; colorsField: number; labelField: number; annotationsField: number};
}

export function deriveMapRoomRecords(
  rows: FillRow[], pool: PoolNode[], bytes: Uint8Array, profile: WorldProfile,
  charset: ArrayLike<string>, symbols: ArrayLike<string>,
  metadata = deriveRoomMetadata(rows, pool, bytes, profile, charset),
  annotationTable?: {offset:number; entries:Map<number,PoolNode[]>},
): Map<number, MapRoomRecord> {
  const decode = makeRegistryRowDecoder(rows, bytes, profile);
  const resolve = (n: PoolNode | undefined | null) => resolveValue(pool, n ?? undefined);
  const fields = (slot: number) => (decode(slot) ?? []).flatMap(p =>
    p.kind === 'G' ? [{op: p.op, node: resolve(p.node)}] : []);
  const number = (n: PoolNode | null, tag = 10) => n?.tag === tag && Number.isInteger(n.value) ? n.value as number : null;
  const vector = (n: PoolNode | null, tag: number, length: number): number[] | null =>
    n?.tag === tag && Array.isArray(n.value) && n.value.length === length && n.value.every(Number.isFinite)
      ? [...n.value] : null;
  const list = (n: PoolNode | null): (PoolNode | null)[] | null =>
    n?.tag === 32 && Array.isArray(n.values) ? n.values.map(resolve) : null;
  const metrics = (n: PoolNode | null): number[] | null => {
    if (n?.tag !== 36 || ![4,5].includes(n.fields?.length ?? 0)) return null;
    const v = n.fields!.map(resolve).map(n => vector(n, 11, 1)?.[0]);
    return v.every(x => x !== undefined) ? v as number[] : null;
  };
  const snapshot = (node: PoolNode | null, depth = 0): MapValue => {
    if (!node || depth > 32) throw Error('invalid map value');
    const result: MapValue = {tag: node.tag};
    if ('value' in node) result.value = node.value;
    if (node.tag === 15) result.symbol = symbols[node.value] ?? null;
    if (node.tag === 14) result.text = decodeGlyphText(node, charset);
    if (node.class !== undefined) result.class = node.class;
    if (Array.isArray(node.fields)) result.fields = node.fields.map(v => snapshot(resolve(v), depth + 1));
    if (Array.isArray(node.values) && node.tag !== 14) result.values = node.values.map(v => snapshot(resolve(v), depth + 1));
    return result;
  };
  const palettes = new Map<number, Color[]>();
  const palette = (slot: number): Color[] => {
    if (!palettes.has(slot)) {
      const colors = fields(slot).map(f => vector(f.node, 21, 4)).filter(v => v !== null) as Color[];
      if (colors.length !== 6) throw Error(`map annotation palette ${slot} is not six colors`);
      palettes.set(slot, colors);
    }
    return palettes.get(slot)!;
  };
  const out = new Map<number, MapRoomRecord>();
  for (const room of metadata.values()) {
    const f = fields(room.owner);
    const luts = f.flatMap((field, i) => {
      const positions = list(f[i + 1]?.node), styles = list(f[i + 2]?.node);
      return field.node?.tag === 71 && positions && styles
        && positions.length === styles.length && positions.every(n => n?.tag === 46)
        && styles.every(n => number(n) !== null) ? [i] : [];
    });
    if (!luts.length) continue;
    if (luts.length !== 1) throw Error(`ambiguous map terrain in room ${room.room}`);
    const lutIndex = luts[0];
    // Find the continuous color/layout block by shape. Earlier fields and
    // schema extensions can move it without changing what these values mean.
    const layouts: {colorIndex: number; colorCount: number; labelIndex: number;
      annotationIndex: number; measurements: number[][]}[] = [];
    for (let i = lutIndex + 3; i < f.length; i++) {
      if (!vector(f[i]?.node, 21, 4) || vector(f[i - 1]?.node, 21, 4)) continue;
      let j = i;
      while (vector(f[j]?.node, 21, 4)) j++;
      const colorCount = j - i, labelIndex = j;
      if (![3,4].includes(colorCount) || ![0,1].every(k => vector(f[j + k]?.node, 24, 2))) continue;
      j += 3; // two offsets and a connector value
      const measurements: number[][] = [];
      while (metrics(f[j]?.node)) measurements.push(metrics(f[j++]?.node)!);
      if (!measurements.length || measurements.length > 2 || f[j]?.node?.tag !== 15 || !list(f[j + 1]?.node)) continue;
      layouts.push({colorIndex: i, colorCount, labelIndex, annotationIndex: j + 1, measurements});
    }
    if (layouts.length !== 1) throw Error(`unsupported map layout in room ${room.room}`);
    const {colorIndex, colorCount, labelIndex, annotationIndex, measurements} = layouts[0];
    const counts = f.slice(colorIndex - colorCount + 1, colorIndex).map(p => number(p.node));
    const positions = list(f[lutIndex + 1].node)!.map(n => decodeSignedPair(n, bytes));
    const styles = list(f[lutIndex + 2].node)!.map(n => number(n)! >>> 0);
    if (counts.length !== colorCount - 1 || counts.some(n => n === null || n < 0)
      || (counts as number[]).reduce((a,b) => a+b, 0) > positions.length || positions.some(p => !p)) {
      throw Error(`invalid map terrain counts in room ${room.room}`);
    }
    const providerNodes = list(f[annotationIndex].node)!;
    if(annotationTable&&providerNodes.some(n=>n?.tag!==38))throw Error('unexpected room annotation providers');
    const annotationNodes = annotationTable
      ? (annotationTable.entries.get(room.owner)??[]).map(resolve) : providerNodes;
    const annotations = annotationNodes.flatMap((n, index): MapAnnotation[] => {
      // Older schemas retain resource references for their label providers.
      // Keep them in annotationEntries until their provider is resolved; do
      // not manufacture text, palette or visibility from unrelated fields.
      if (n?.tag === 38) return [];
      const v = n?.tag === 36 && n.fields?.length === 5 ? n.fields.map(resolve) : null;
      const text = v ? decodeGlyphText(v[0], charset) : null;
      const style = v ? number(v[1], 38) : null, parameter = v ? number(v[2]) : null;
      if (!v || text === null || style === null || parameter === null) throw Error(`invalid map annotation in room ${room.room}`);
      return [{text, glyphs: [...v[0]!.values!], styleOwner: style, palette: palette(style), parameter,
        marker: snapshot(v[3]), condition: snapshot(v[4]),
        source: {field: annotationTable?null:f[annotationIndex].op, index, typedClass: n!.class!,
          ...(annotationTable?{tableOffset:annotationTable.offset}:{})}}];
    });
    const title = f.find(p => p.op === room.source.nameField)?.node;
    if (!title || decodeGlyphText(title, charset) !== room.displayName) throw Error('map title differs from room header');
    out.set(room.room, {...room,
      terrain: {lut: f[lutIndex].node!.value, positions: positions as Pair[], styles,
        groupCounts: counts as number[],
        baseColors: Array.from({length: colorCount}, (_,k) => k).map(k => vector(f[colorIndex + k].node, 21, 4) as Color)},
      labels: {title: room.displayName, glyphs: [...title.values!],
        offsets: [0,1].map(k => vector(f[labelIndex + k].node, 24, 2)) as [Pair, Pair],
        metrics: measurements,
        connector: snapshot(f[labelIndex + 2].node), background: snapshot(f[annotationIndex - 1].node), annotations, annotationEntries: providerNodes.map(n => snapshot(n))},
      mapSource: {lutField: f[lutIndex].op, colorsField: f[colorIndex].op,
        labelField: f[labelIndex].op, annotationsField: f[annotationIndex].op},
    });
  }
  return out;
}
