// A tool as the app's shell holds it: mounted once into its page (rendered by the shell first, so its
// elements are there to find), then shown and hidden as the visitor moves between pages. A hidden tool
// keeps its state and does no work: `active()` says whether its page is the one showing, for its
// listeners on the window and the document (keys, the address's hash).
export interface ToolContext {
  active(): boolean;
}
export interface ToolHandle {
  /** Its page is showing again (the address may have changed while it was hidden). */
  show(): void;
  /** Another page is showing: stop anything that draws or polls. */
  hide(): void;
  /** Its own name picked in the tool switch while it is showing: back to its start, in place. */
  current?(): void;
}
