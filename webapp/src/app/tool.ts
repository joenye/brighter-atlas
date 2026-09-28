// A tool as the app's shell holds it: a React component (its module's `Tool`), rendered into its page once
// its code is in (the page's placeholders until then), then shown and hidden as the visitor moves between
// pages (`active`). A hidden tool keeps its state and does no work: its listeners on the window and the
// document act only while active. Where memory is short (phones and tablets) a hidden tool is let go instead,
// its effects' cleanups freeing what it holds (its GPU memory above all), and its page is mounted afresh when
// opened again.
export interface ToolProps {
  active: boolean;
  /** Its first view is drawn: the shell's load card (the one loader a visitor sees opening a page) goes. */
  ready(): void;
  /** What the shell asks of it. */
  register(handle: ToolHandle): void;
}
export interface ToolHandle {
  /** Its own name picked in the tool switch while it is showing: back to its start, in place. */
  current?(): void;
}
/** What a tool's imperative core gets from its component (Brighter Data's app, main.ts). */
export interface ToolContext {
  active(): boolean;
  /** Aborted when the tool is let go: its listeners on the window and the document go with it. */
  signal: AbortSignal;
  ready(): void;
}
