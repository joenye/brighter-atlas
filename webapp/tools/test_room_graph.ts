// Unit test for src/extract/world/room-graph.ts (the cross-build room-name
// fill). Runs on plain node: node's type stripping does not remap the .js
// import specifiers used inside src/, so the module under test is bundled
// with esbuild into a temp file at test runtime and imported from there.
//
//   node tools/test_room_graph.ts
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP = path.resolve(TOOLS, '..');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bs-room-graph-'));
const bundled = path.join(tmp, 'room-graph.mjs');
execFileSync('npx', [
  'esbuild', 'src/extract/world/room-graph.ts',
  '--bundle', '--platform=node', '--format=esm', `--outfile=${bundled}`,
], { cwd: WEBAPP, stdio: ['ignore', 'ignore', 'inherit'] });
const { fillRoomNames } = await import(pathToFileURL(bundled).href);

let passed = 0;
let failed = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  cond ? passed++ : failed++;
};

type Room = { idx: number; name: string | null; plane: number; x: number; y: number; w: number; h: number };
type Ref = { n: string; p: number; x: number; y: number; w: number; h: number };

const room = (idx: number, name: string | null, x: number, y: number, over: Partial<Room> = {}): Room =>
  ({ idx, name, plane: 0, x, y, w: 10, h: 10, ...over });
const ref = (n: string, x: number, y: number, over: Partial<Ref> = {}): Ref =>
  ({ n, p: 0, x, y, w: 10, h: 10, ...over });
const reference = (rooms: Ref[]) => ({ v: 1, rooms });

// Four uniquely-named anchor rooms at identical positions in both sets — a
// clean, agreeing plane-0 alignment (delta 0,0) for the cases below to extend.
const anchors: Room[] = [
  room(1, 'Fish Market', 0, 0),
  room(2, 'Town Square', 20, 0),
  room(3, 'Old Mill', 0, 20),
  room(4, 'Harbour', 20, 20),
];
const anchorRefs: Ref[] = [
  ref('Fish Market', 0, 0),
  ref('Town Square', 20, 0),
  ref('Old Mill', 0, 20),
  ref('Harbour', 20, 20),
];

console.log('== room-graph fillRoomNames ==');

// ---- 1. perfect match: everything already named -> nothing filled ----------
{
  const { names, stats } = fillRoomNames(anchors, reference(anchorRefs));
  ok(names.size === 0, 'all-named perfect match fills nothing');
  ok(stats[0]?.anchors === 4 && stats[0]?.skipped === false, 'plane 0 aligns (4 anchors, not skipped)');
  ok(stats[0]?.delta?.[0] === 0 && stats[0]?.delta?.[1] === 0, 'modal delta is (0,0)');
}

// ---- 2. unnamed room filled via modal-delta alignment ----------------------
{
  const rooms = [...anchors, room(5, null, 40, 0)];
  const refs = [...anchorRefs, ref('Beach', 40, 0)];
  const { names, stats } = fillRoomNames(rooms, reference(refs));
  ok(names.get(5) === 'Beach', 'unnamed room at an aligned position is filled');
  ok(stats[0]?.filled === 1, 'plane stats count the fill');
}

// ---- 3. global translation between builds ----------------------------------
{
  const rooms = [...anchors, room(5, null, 40, 0)];
  const refs = [
    ...anchorRefs.map((r) => ({ ...r, x: r.x + 7, y: r.y - 13 })),
    ref('Beach', 47, -13),
  ];
  const { names, stats } = fillRoomNames(rooms, reference(refs));
  ok(names.get(5) === 'Beach', 'a uniform reference translation still fills');
  ok(stats[0]?.delta?.[0] === 7 && stats[0]?.delta?.[1] === -13, 'modal delta carries the translation');
}

// ---- 4. a plane with <3 anchors is skipped ---------------------------------
{
  const rooms = [
    room(1, 'Fish Market', 0, 0), room(2, 'Town Square', 20, 0),
    room(5, null, 40, 0),
  ];
  const refs = [
    ref('Fish Market', 0, 0), ref('Town Square', 20, 0), ref('Beach', 40, 0),
  ];
  const { names, stats } = fillRoomNames(rooms, reference(refs));
  ok(names.size === 0, 'two anchors are not enough — nothing filled');
  ok(stats[0]?.skipped === true && stats[0]?.anchors === 2, 'plane reported skipped with 2 anchors');
}

// ---- 4b. modal delta below the 60% agreement bar -> skipped ----------------
{
  // 4 anchors, deltas (0,0)/(0,0)/(5,5)/(9,9): modal holds for 50% < 60%
  const rooms = [...anchors, room(5, null, 40, 0)];
  const refs = [
    ref('Fish Market', 0, 0),
    ref('Town Square', 20, 0),
    ref('Old Mill', 5, 25),
    ref('Harbour', 29, 29),
    ref('Beach', 40, 0),
  ];
  const { names, stats } = fillRoomNames(rooms, reference(refs));
  ok(names.size === 0 && stats[0]?.skipped === true, 'disagreeing anchors (modal < 60%) skip the plane');
}

// ---- 5. ambiguous target: two reference rooms on the aligned spot ----------
{
  const rooms = [...anchors, room(5, null, 40, 0)];
  const refs = [...anchorRefs, ref('Beach', 40, 0), ref('Cove', 40, 0)];
  const { names } = fillRoomNames(rooms, reference(refs));
  ok(!names.has(5), 'two reference rooms at the aligned position -> not filled');
}

// ---- 6. dimension drift: <=2 per axis fills, >2 does not -------------------
{
  const rooms = [...anchors, room(5, null, 40, 0, { w: 10, h: 10 })];
  const drifted = fillRoomNames(rooms, reference([...anchorRefs, ref('Beach', 40, 0, { w: 12, h: 8 })]));
  ok(drifted.names.get(5) === 'Beach', 'dims drifted by 2 still fill');
  const tooFar = fillRoomNames(rooms, reference([...anchorRefs, ref('Beach', 40, 0, { w: 13, h: 10 })]));
  ok(!tooFar.names.has(5), 'dims drifted by 3 do not fill');
}

// ---- 7. renamed room: name absent from the reference is left alone ---------
{
  const rooms = [...anchors, room(5, 'Brand New Plaza', 40, 0)];
  const refs = [...anchorRefs, ref('Beach', 40, 0)];
  const { names } = fillRoomNames(rooms, reference(refs));
  ok(!names.has(5), 'a room named this build (absent from the reference) is untouched');
}

// ---- planes stay independent ----------------------------------------------
{
  const rooms = [
    ...anchors,
    room(10, 'Cellar A', 0, 0, { plane: 1 }), room(11, null, 20, 0, { plane: 1 }),
  ];
  const refs = [
    ...anchorRefs,
    ref('Cellar A', 0, 0, { p: 1 }), ref('Cellar B', 20, 0, { p: 1 }),
  ];
  const { names, stats } = fillRoomNames(rooms, reference(refs));
  ok(!names.has(11) && stats[1]?.skipped === true, 'plane 1 (1 anchor) skipped even though plane 0 aligns');
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
