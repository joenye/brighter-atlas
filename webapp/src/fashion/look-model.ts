// The look being designed and worn, with its undo history: the page edits `state` in place and says so
// (changed), React re-renders from `version`. The designer is one undo step: while it holds (holdUndo) edits
// are not committed, Done commits them, Cancel drops them.
import type {State} from './compose.js';

export class LookModel {
  state: State;
  readonly past: string[] = [];
  readonly future: string[] = [];
  private lastSaved: string;
  holdUndo = false;
  version = 0;
  private readonly subs = new Set<() => void>();

  /** `previous`: the look this one replaces (a link opened over your own): one Undo away */
  constructor(state: State, previous: State | null) {
    this.state = state;
    if (previous) this.past.push(JSON.stringify(previous));
    this.lastSaved = JSON.stringify(state);
  }
  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  snapshot = () => this.version;
  /** re-render without an edit (the look shown changed its view, not itself) */
  touch() { this.version++; for (const fn of this.subs) fn(); }

  commit() {
    if (this.holdUndo) return;
    const now = JSON.stringify(this.state);
    if (now === this.lastSaved) return;
    this.past.push(this.lastSaved); if (this.past.length > 200) this.past.shift();
    this.future.length = 0; this.lastSaved = now;
  }
  /** an edit: kept in the history, and drawn */
  changed() { this.commit(); this.touch(); }
  set(state: State) { this.state = state; this.changed(); }
  undo() { const p = this.past.pop(); if (!p) return; this.future.push(this.lastSaved); this.lastSaved = p; this.state = JSON.parse(p); this.touch(); }
  redo() { const f = this.future.pop(); if (!f) return; this.past.push(this.lastSaved); this.lastSaved = f; this.state = JSON.parse(f); this.touch(); }
  /** Cancel in the designer: back to `before`, the dropped design one Redo away; true when there was one */
  cancel(before: string): boolean {
    const dropped = JSON.stringify(this.state);
    this.state = JSON.parse(before); this.holdUndo = false;
    const kept = dropped !== this.lastSaved;
    if (kept) this.future.push(dropped);
    this.touch();
    return kept;
  }
}
