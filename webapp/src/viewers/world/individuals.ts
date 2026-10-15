// A room's individuals (groups of its parts that come and go together: a building before and after work on it,
// a door open or shut, a shop's stock) each carry conditions: small programs of integers the game runs every frame
// to decide whether the individual is drawn. An individual is left out while ANY of its conditions holds; one with
// none is always drawn. Rooms that change as a story moves on keep each stage's parts as individuals, and the game
// draws one stage: drawing them all puts two versions of a staircase in one place.
//
// A program is postfix over a stack of integers. Each step is an operation and its arguments:
//
//   0 or, 1 and, 2 not, 10 a ? b : c (no arguments)
//   3 room                     the player is in that room
//   4 room, entry              5 n: individual n of this room (evaluated earlier) is left out
//   6..9 room, individual, key the player's place (one of the individual's keys, -1 any)
//   11 room                    the player is in that room
//   12 low, high               the camera's heading between low and high
//   13 room, individual, k     that individual's condition k (room -1: this room)
//   14 room, entry             15, 16 n; 17..19 three arguments
//   20 room, variable, test, value   the room's progress `variable` against value, the test one of
//                                    ==, !=, >, >=, <, <= (0 to 5)
//
// Rooms are named by their number (shard.room_number). The viewer draws each room as the player standing in it
// sees it, with the camera never facing a wall (the game hides the walls the camera faces in the player's room;
// the viewer does not), nothing else of the player's (their place, keys) known, and a room's progress at its
// latest unless chosen (roomProgress, a value past every one its conditions test). What the client checks that is
// not traced (14: a check on one of the room's neighbours; 15 to 19) is unknown, carried through not, and, or and
// the choice as unknown, and only a condition that surely holds leaves its individual out: Pier One's and Pier
// Two's boats are hidden by NOT(14 ...), and stay.

/** Arguments of each operation. */
const ARITY = [0, 0, 0, 1, 2, 1, 3, 3, 3, 3, 0, 1, 2, 3, 2, 1, 1, 3, 3, 3, 4];
/** The game stops evaluating conditions nested deeper than this. */
const DEPTH = 100;

/** Whether a program is made of known operations to its end. */
function wellFormed(program: number[]): boolean {
  let pc = 0;
  while (pc < program.length) {
    const op = program[pc];
    if (!(op >= 0 && op < ARITY.length)) return false;
    pc += 1 + ARITY[op];
  }
  return pc === program.length;
}

/** A room's progress variables its conditions test, each with the values that matter: from 0 to one past the
 *  largest value tested (the latest), as `room/variable` keys. */
export function progressVariables(shard: any): Map<string, { room: number; variable: number; latest: number; values: number[] }> {
  const out = new Map<string, { room: number; variable: number; latest: number; values: number[] }>();
  const own = shard?.room_number;
  for (const programs of shard?.individual_conditions ?? []) {
    for (const program of programs as number[][]) {
      if (!wellFormed(program)) continue;
      for (let pc = 0; pc < program.length; pc += 1 + ARITY[program[pc]]) {
        if (program[pc] !== 20) continue;
        const room = program[pc + 1] === -1 ? own : program[pc + 1], variable = program[pc + 2], value = program[pc + 4];
        const key = `${room}/${variable}`;
        let entry = out.get(key);
        if (!entry) out.set(key, entry = { room, variable, latest: 0, values: [] });
        entry.latest = Math.max(entry.latest, value + 1);
      }
    }
  }
  for (const entry of out.values()) entry.values = Array.from({ length: entry.latest + 1 }, (_, k) => k);
  return out;
}

export interface IndividualState {
  /** A room's progress value (undefined: its latest). */
  progress?: (room: number, variable: number) => number | undefined;
  /** Another room's shard by its number, when loaded (conditions that name other rooms' individuals). */
  room?: (number: number) => any | null;
}

const TESTS: ((a: number, b: number) => boolean)[] = [
  (a, b) => a === b, (a, b) => a !== b, (a, b) => a > b, (a, b) => a >= b, (a, b) => a < b, (a, b) => a <= b,
];

/** A condition's value that the viewer cannot know (an untraced check). */
const UNKNOWN = 2;

/** Which of a room's individuals the game leaves out (true), or null when it has no conditions (none). */
export function hiddenIndividuals(shard: any, state: IndividualState = {}): boolean[] | null {
  const conditions: number[][][] | undefined = shard?.individual_conditions;
  if (!Array.isArray(conditions) || !conditions.length) return null;
  const own: number | undefined = shard.room_number;
  const latest = progressVariables(shard);
  const progress = (room: number, variable: number) =>
    state.progress?.(room, variable) ?? latest.get(`${room}/${variable}`)?.latest ?? 0;
  const roomOf = (number: number) => (number === -1 || number === own ? shard : state.room?.(number) ?? null);
  const hidden: boolean[] = [];
  const results: number[] = [];   // each individual's value: 1 left out, 0 drawn, UNKNOWN (drawn)

  const run = (program: number[], depth: number): number => {
    if (depth > DEPTH || !wellFormed(program)) return 0;
    const stack: number[] = [];
    const pop = () => stack.pop() ?? 0;
    for (let pc = 0; pc < program.length;) {
      const op = program[pc], a = program.slice(pc + 1, pc + 1 + ARITY[op]);
      pc += 1 + ARITY[op];
      switch (op) {
        case 0: { const x = pop(), y = pop(); stack.push(x === 1 || y === 1 ? 1 : x === UNKNOWN || y === UNKNOWN ? UNKNOWN : 0); break; }
        case 1: { const x = pop(), y = pop(); stack.push(x === 0 || y === 0 ? 0 : x === UNKNOWN || y === UNKNOWN ? UNKNOWN : 1); break; }
        case 2: { const x = pop(); stack.push(x === UNKNOWN ? UNKNOWN : x ? 0 : 1); break; }
        case 10: { const x = pop(), y = pop(), c = pop(); stack.push(c === UNKNOWN ? (x === y ? x : UNKNOWN) : c ? y : x); break; }
        // the player stands in the room drawn
        case 3: case 11: stack.push(a[0] === own ? 1 : 0); break;
        case 5: stack.push(a[0] >= 0 && a[0] < results.length ? results[a[0]] : 0); break;
        case 13: {
          const other = roomOf(a[0]);
          const program = other?.individual_conditions?.[a[1]]?.[a[2]];
          stack.push(Array.isArray(program) ? run(program, depth + 1) : 0);
          break;
        }
        case 20: {
          const room = a[0] === -1 ? own : a[0];
          const test = TESTS[a[2]];
          stack.push(test && room !== undefined && test(progress(room, a[1]), a[3]) ? 1 : 0);
          break;
        }
        // untraced: a neighbour's check, and the rest
        case 14: case 15: case 16: case 17: case 18: case 19: stack.push(UNKNOWN); break;
        // the player's place and keys, the camera facing a wall: not so
        default: stack.push(0);
      }
    }
    return pop();
  };

  for (let i = 0; i < conditions.length; i++) {
    const values = (conditions[i] ?? []).map((program) => run(program, 0));
    results.push(values.includes(1) ? 1 : values.includes(UNKNOWN) ? UNKNOWN : 0);
    hidden.push(results[i] === 1);
  }
  return hidden;
}

/** The shard as drawn: its own object (the stored shard kept as it is) naming the occurrences of the individuals
 *  left out (`left_out`: their placements are not drawn; placement indices stay as stored), without their lights.
 *  The shard itself where nothing is left out. */
export function drawnShard(shard: any, hidden: boolean[] | null, occurrenceColumns: string[] | undefined): any {
  if (!hidden?.some(Boolean) || !Array.isArray(shard?.occurrences)) return shard;
  const column = occurrenceColumns?.indexOf('individual') ?? -1;
  if (column < 0) return shard;
  const leftOut = new Set<number>();
  shard.occurrences.forEach((row: any[], occurrence: number) => {
    const individual = row?.[column];
    if (Number.isInteger(individual) && individual >= 0 && hidden[individual]) leftOut.add(occurrence);
  });
  if (!leftOut.size) return shard;
  return {
    ...shard, left_out: leftOut,
    ...(Array.isArray(shard.point_lights) ? { point_lights: shard.point_lights.filter((l: any) => !leftOut.has(l.occurrence)) } : {}),
  };
}
