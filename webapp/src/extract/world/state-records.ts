// Records a class picks by story progress. Some objects name one record in their own data (a giant crystal names its
// colours) but the game chooses another as a quest moves on: the crystal of Cave of the Crystal is red until the
// story reaches a step, then blue. From per-build decode data, for each such class and quest variable: the record the
// game draws from each step of that variable on (the other quests at their start).
//
// The extraction keeps, for every part whose colours come from such a record, the colours of each step; the viewer
// draws the step its story slider shows (a room's own story, at its end by default, as its lighting).

export interface StateRecordBinding {
  /** The class of the objects (their records' runtime class). */
  runtime: number;
  /** The quest variable the game reads. */
  variable: number;
  /** How many states the variable has. */
  states: number;
  /** [the first state position, the record drawn from it on], in order, the first at 0. */
  steps: [number, number][];
}

const record = (v: any) => Number.isInteger(v) && v >= 0 && v < 2 ** 24;

export function validStateRecords(values: any): values is StateRecordBinding[] {
  if (!Array.isArray(values) || values.length > 65536) return false;
  const seen = new Set<string>();
  for (const v of values) {
    if (!v || !Number.isInteger(v.runtime) || v.runtime < 0 || v.runtime >= 65536 || !record(v.variable)
      || !Number.isInteger(v.states) || v.states < 2 || v.states > 65536
      || !Array.isArray(v.steps) || v.steps.length < 2 || v.steps.length > 256) return false;
    let last = -1;
    for (const step of v.steps) {
      if (!Array.isArray(step) || step.length !== 2 || !Number.isInteger(step[0]) || step[0] <= last
        || step[0] >= v.states || !record(step[1])) return false;
      last = step[0];
    }
    if (v.steps[0][0] !== 0) return false;
    const key = `${v.runtime}/${v.variable}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** A shard's parts whose colours follow a story: the colours entry the part uses (`recolor`), and per quest variable
 *  the entry to use from each step on. */
export interface StoryRecolor {
  recolor: number;
  variable: number;
  states: number;
  steps: [number, number][];
}

/** The shard with each story-dependent part's colours at the story's position: `position(variable)` is the step the
 *  room shows for that quest (null: the room follows another, and the part keeps the colours its object names). */
export function storyRecolors(shard: any, position: (variable: number) => number | null | undefined): any {
  const entries: StoryRecolor[] | undefined = shard?.state_recolors;
  if (!Array.isArray(entries) || !entries.length || !Array.isArray(shard.recolors)) return shard;
  let recolors: any[] | null = null;
  for (const entry of entries) {
    const at = position(entry.variable);
    if (at === null || at === undefined || !Array.isArray(entry.steps) || !entry.steps.length) continue;
    let pick = entry.steps[0][1];
    for (const [from, index] of entry.steps) if (from <= at) pick = index;
    const colours = shard.recolors[pick];
    if (!Array.isArray(colours) || pick === entry.recolor) continue;
    const next: any[] = recolors ?? (recolors = shard.recolors.slice());
    next[entry.recolor] = colours;
  }
  return recolors ? { ...shard, recolors } : shard;
}
