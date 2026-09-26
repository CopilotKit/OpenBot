/**
 * What a Bot has been doing on its computer, other than browsing.
 *
 * The screen answers "what is it looking at" and nothing answered "what is it doing". A shell
 * command rendered in the transcript as one grey line, `Ran a command  rg --version`, with the output
 * nowhere: the model saw it, decided which part mattered, and the person watching had to take its
 * word. The same was true of reading a file and listing a folder. That is a poor deal on a machine
 * holding somebody's logins, and it is the thing an operator asks about first.
 *
 * A live view of this session rather than a record. The record is the audit trail, which is on the
 * server, survives a reload and is what an investigation reads; this is the pane beside the screen,
 * and it is allowed to be gone when the tab is closed. Keeping it in the browser means no new
 * endpoint, no polling, and no second copy of command output in the database.
 *
 * Written from the tools' `render`, which is now the only place in the browser that sees a call at
 * all: the handlers moved to the server so that a Bot with no tab open still has a computer.
 *
 * `render` runs on every re-render, so recording from it needs an identity to be idempotent, and the
 * tool call has one. Entries are keyed by `toolCallId`; a second record under a key already held is
 * dropped. Without that the pane grew a fresh copy of the same command on every paint.
 */

/** One thing a Bot did on its computer. */
export type ComputerActivity = {
  id: string;
  /** When it happened, for the timestamp beside it. */
  at: number;
  kind: "command" | "read_file" | "write_file" | "list_files";
  /** The command, or the path. What the line says it acted on. */
  subject: string;
  /** What came back. Empty when a command printed nothing, which is worth showing as itself. */
  output: string;
  /** Present for a command. Non-zero is drawn as a failure. */
  exitCode?: number;
  /** A boundary refused it. Drawn differently from a command that ran and failed. */
  refused?: boolean;
  /** The far side cut the output short, or stopped the command. Said out loud rather than implied. */
  truncated?: boolean;
  timedOut?: boolean;
};

/**
 * The most recent entries per computer.
 *
 * Bounded, because a Bot working through a large job runs a lot of commands and this is a pane, not
 * an archive. The oldest go first: what somebody watching wants is what just happened.
 */
const LIMIT = 200;

const byComputer = new Map<string, ComputerActivity[]>();
/** Every tool call already recorded, so a repeated `render` adds nothing. */
const seen = new Set<string>();
const listeners = new Set<() => void>();

/** A stable empty array, so `useSyncExternalStore` does not see a new value on every render. */
const NONE: ComputerActivity[] = [];

/**
 * Record one thing a Bot did, at most once.
 *
 * `id` is the tool call's own id. It is required rather than generated because the caller is a
 * `render` that runs repeatedly for one call, and an id minted here would make every paint a new
 * entry. Recording under a key already present is a no-op, including after the entry has aged out
 * of the window: `seen` is what remembers, and it is the thing that keeps a long-running Bot's pane
 * from redrawing its oldest command as its newest.
 */
export function recordActivity(
  computerId: string,
  id: string,
  entry: Omit<ComputerActivity, "id" | "at">,
): void {
  const key = `${computerId}:${id}`;
  if (seen.has(key)) return;
  seen.add(key);
  const existing = byComputer.get(computerId) ?? [];
  const next = [...existing, { ...entry, id, at: Date.now() }];
  byComputer.set(computerId, next.slice(-LIMIT));
  /*
   * Deferred, because the caller is now a `render`.
   *
   * Notifying synchronously from inside one component's render sets state in the pane subscribed
   * through `useSyncExternalStore`, which React reports as updating a component while rendering a
   * different one. The store is already updated by the line above, so the only thing a microtask
   * delays is the repaint.
   */
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });
}

export function activityFor(computerId: string): ComputerActivity[] {
  return byComputer.get(computerId) ?? NONE;
}

/**
 * Which Bots have opened a page since the surface was loaded.
 *
 * Recorded rather than inferred from the screenshot: a screenshot always succeeds, and "the browser
 * has a page loaded" is a different fact from "this Bot opened one" — the screen belongs to the
 * computer and outlives a conversation, so a Bot that has browsed nothing still has a page on it.
 *
 * Nothing reads this today. The screen and the activity log are now stacked rather than tabbed, so
 * no view has to guess which of the two to open, and the caption that hedged about whose page it
 * was is gone with it. The note stays because the tool handler is the only place the fact exists and
 * losing it would mean re-deriving it from a screenshot, which cannot answer it.
 */
const browsed = new Set<string>();

export function noteBrowsed(computerId: string): void {
  if (browsed.has(computerId)) return;
  browsed.add(computerId);
  for (const listener of listeners) listener();
}

export function subscribeToActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forget one computer's activity.
 *
 * Wiping a computer deletes the machine those commands ran on, so leaving them on screen would
 * describe something that no longer exists.
 */
export function clearActivity(computerId: string): void {
  byComputer.delete(computerId);
  browsed.delete(computerId);
  for (const key of seen) {
    if (key.startsWith(`${computerId}:`)) seen.delete(key);
  }
  for (const listener of listeners) listener();
}
