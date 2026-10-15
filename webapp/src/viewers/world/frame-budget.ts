// Background work that shares the page's frames with drawing (the all-rooms view joining the world: bakes,
// buffer and texture uploads). It runs in the time left once a frame has been drawn, a few milliseconds at a
// time, then waits for the next frame. Handing the thread back with scheduler.yield() was not enough: its
// continuations go ahead of rendering, so a run of them held a frame back until the browser's own limit (about
// a tenth of a second).

/** The background's share of each frame: milliseconds of its own work between two frames (setBackgroundShare). */
let shareMs = 6;
/** Bytes the background may hand the GPU between two frames: uploads cost the page little of its own time but
 *  Chrome's GPU process the more, and many at once held a frame back for half a second. */
const BYTES_PER_FRAME = 16 << 20;
/** Waiting for a frame that does not come (a hidden page): go on after this long. */
const NO_FRAME_MS = 50;

const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
const posted: (() => void)[] = [];
if (channel) channel.port1.onmessage = () => posted.shift()?.();
/** A task of its own, at once (a message: unlike a timer it is never held back by nesting). */
function post(run: () => void): void {
  if (!channel) { setTimeout(run, 0); return; }
  posted.push(run);
  channel.port2.postMessage(0);
}

/** Once the next frame is drawn (a task after its frame callbacks), or a little later with no frame coming. */
function afterFrame(run: () => void): void {
  let done = false;
  const go = () => { if (!done) { done = true; run(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, NO_FRAME_MS);
}

// One waiting piece of work goes on per task, in turn, while the frame's share lasts: its slice runs (to its next
// turn) before the next one is let go, so many waiting at once still take only the share between them.
const waiting: { resolve: () => void; label: string; bytes: number }[] = [];
let pumping = false;
let used = 0;   // (the work done since the last frame was drawn)
let usedBytes = 0;   // (and the bytes handed to the GPU)
const stats = { turns: 0, frames: 0 };
// the longest turns by what took them (tests)
const longest = new Map<string, number>();
const totals = new Map<string, [number, number]>();   // (turns and milliseconds by label)
let turn: { label: string; at: number } | null = null;
function pump(): void {
  if (turn) {
    const took = performance.now() - turn.at;
    used += took;
    if (took > (longest.get(turn.label) ?? 0)) longest.set(turn.label, took);
    const total = totals.get(turn.label) ?? [0, 0];
    total[0]++; total[1] += took;
    totals.set(turn.label, total);
    turn = null;
  }
  if (!waiting.length) { pumping = false; return; }
  if (used < shareMs && (!usedBytes || usedBytes + waiting[0].bytes <= BYTES_PER_FRAME)) {
    stats.turns++;
    const next = waiting.shift()!;
    usedBytes += next.bytes;
    turn = { label: next.label, at: performance.now() };
    next.resolve();
    post(pump);
  } else afterFrame(() => { stats.frames++; used = 0; usedBytes = 0; pump(); });
}

/** The share follows what drawing leaves: the page's own frame time `frameMs` against `targetMs`, within 6 to
 *  12 ms (a frame drawn in 5 ms leaves room for 11 of work; one of 10 or more for the least). */
export function setBackgroundShare(frameMs: number, targetMs = 16): void {
  shareMs = Math.min(12, Math.max(6, targetMs - frameMs));
}

/** Turns given and frames waited for since the page opened, how many wait now and the longest turns (tests). */
export function backgroundStats(): { turns: number; frames: number; waiting: number; share: number; longest: Record<string, number>; totals: Record<string, [number, number]> } {
  return { ...stats, waiting: waiting.length, share: shareMs, totals: Object.fromEntries([...totals].map(([k, [n, ms]]) => [k, [n, Math.round(ms)]])), longest: Object.fromEntries([...longest].map(([k, v]) => [k, Math.round(v)])) };
}

/** A turn for background work: soon while this frame's share lasts, else after the next frame is drawn. */
export function backgroundTurn(label = 'work', bytes = 0): Promise<void> {
  return new Promise((resolve) => {
    waiting.push({ resolve, label, bytes });
    if (!pumping) {
      pumping = true;
      // (work starting afresh starts with a share of its own)
      used = 0;
      usedBytes = 0;
      post(pump);
    }
  });
}
