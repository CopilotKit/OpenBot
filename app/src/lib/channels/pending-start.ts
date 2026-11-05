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
 * The conversation each finished start became, by the placeholder's id.
 *
 * Somebody who leaves the placeholder while it is being made, and comes back to it (the browser's
 * Back button, mostly), is coming back to that conversation. The start has forgotten itself by
 * then, and a placeholder that knows nothing sends them home, to an empty composer, while the
 * conversation they asked for sits in the sidebar with their first message still waiting to go.
 * Kept for the life of the tab, like the pending starts: one id and one channel id per message
 * sent from home.
 */
const startedChannels = new Map<string, string>();

export function settlePendingStart(id: string, channelId: string): void {
  startedChannels.set(id, channelId);
}

export function startedChannelFor(id: string): string | null {
  return startedChannels.get(id) ?? null;
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

/**
 * Home pages that are open while a start fails behind them.
 *
 * Somebody can go back to home before the start fails: home's own link, from the placeholder. That
 * home page took what was stashed when it mounted, which was nothing, and a failure after that has
 * no next home page to wait for. It is the page they are looking at, so it is told.
 */
const failedStartListeners = new Set<() => void>();

export function stashFailedStart(failed: FailedStart): void {
  failedStart = failed;
  for (const listener of failedStartListeners) listener();
}

/** Called when a start fails; returns the unsubscribe. The listener takes the failure itself. */
export function onFailedStart(listener: () => void): () => void {
  failedStartListeners.add(listener);
  return () => {
    failedStartListeners.delete(listener);
  };
}

export function takeFailedStart(): FailedStart | null {
  const taken = failedStart;
  failedStart = null;
  return taken;
}
