/**
 * A conversation that has been asked for and does not exist yet.
 *
 * Starting one from home used to keep the person on the composer until a Bot had been picked and the
 * channel created, and picking a Bot is a model call. So pressing send did nothing visible for
 * seconds. Now the placeholder at `/start/$startId` opens the moment send is pressed, showing the
 * message, and the work runs behind it; when the channel exists the placeholder is replaced by it.
 *
 * Module-level, like `stashFirstMessage`, and for the same reasons: it outlives the home page that
 * started it, it is never persisted (a reload of the placeholder finds nothing and goes home), and
 * it holds nothing a second tab would need.
 */
export type PendingStart = {
  text: string;
  /** The Bot the person named with `@`, when they did; null while one is still being picked. */
  agentId: string | null;
};

const pendingStarts = new Map<string, PendingStart>();

export function beginPendingStart(id: string, start: PendingStart): void {
  pendingStarts.set(id, start);
}

export function readPendingStart(id: string): PendingStart | null {
  return pendingStarts.get(id) ?? null;
}

export function endPendingStart(id: string): void {
  pendingStarts.delete(id);
}

/** Where the placeholder for a pending start lives. */
export function pendingStartPath(id: string): string {
  return `/start/${id}`;
}

/**
 * A start that failed, waiting for the home composer to put its words back.
 *
 * The composer used to keep a failed draft in the box itself, with the reason under it. The box is
 * gone by the time a start fails behind its placeholder, so the words and the reason are kept here
 * for the next home page to take, once.
 */
export type FailedStart = { text: string; error: string };

let failedStart: FailedStart | null = null;

export function stashFailedStart(failed: FailedStart): void {
  failedStart = failed;
}

export function takeFailedStart(): FailedStart | null {
  const taken = failedStart;
  failedStart = null;
  return taken;
}
