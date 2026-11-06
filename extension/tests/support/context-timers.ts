/**
 * Real timers for one extension context (a service worker or an offscreen document) that end when the test ends it.
 *
 * Chrome ends a closed document's page and a stopped service worker, and every timer either had goes with it. A test
 * that hands the Recorder plain `setTimeout` has no such end: `bun test` runs every file in one process, so a recording
 * a test left running goes on reconnecting its streams, reporting its activity and checking its connection for the rest
 * of the suite, minutes after its own file finished. Those calls reach the global `fetch`, and a later file that
 * replaces it to watch its own requests (server/tests/composio-adapter.test.ts) records them as its own. That is how a
 * leftover stream's reconnect, with no Composio key on it, failed the Composio key test on CI.
 *
 * `end()` is that end: every timer still waiting is cancelled, and one asked for afterwards is never set. The second
 * half is the one that matters, because ending a context is what makes it ask: the gateway closing under a streaming
 * document is a dropped socket to the streamer, which schedules a reconnect after the test has already cleared its
 * timers.
 */
export type ContextTimers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  end(): void;
};

export function contextTimers(): ContextTimers {
  const waiting = new Set<ReturnType<typeof setTimeout>>();
  let ended = false;
  return {
    set(fn, ms) {
      if (ended) return undefined;
      const handle = setTimeout(() => {
        waiting.delete(handle);
        fn();
      }, ms);
      waiting.add(handle);
      return handle;
    },
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      waiting.delete(handle as ReturnType<typeof setTimeout>);
    },
    end() {
      ended = true;
      for (const handle of waiting) clearTimeout(handle);
      waiting.clear();
    },
  };
}
