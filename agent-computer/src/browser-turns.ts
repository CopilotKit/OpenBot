/**
 * One action at a time on a browser, in the order the actions arrived.
 *
 * A model that calls tools in parallel sends a whole form's worth of `computer_type` in one step, and every one of
 * them reaches this process at once. Each focuses its own field before it types, so side by side they took the focus
 * from each other: the text meant for one field landed in another, and the form kept some values and lost the rest.
 * The Bot then saw the gaps and filled the fields again one by one. A browser has one focus, one pointer and one
 * keyboard, so whatever the model sends, its actions take turns.
 *
 * HERE, NOT ON THE SERVER, because this process is the one place every action on a browser passes through. The server
 * runs as several replicas and a turn's tool calls can reach the computer through any of them; one browser is only
 * ever run by one computer.
 *
 * A turn never holds the browser for ever. Every Playwright call an action makes has its own timeout, so an action
 * that fails gives its turn up when it fails. `limitMs` is the backstop for one that neither finishes nor fails: past
 * it, the next action goes ahead and the overrun is logged. And an action whose caller goes away (the person pressed
 * Stop, or the server gave up) leaves the line without ever running.
 *
 * A look at the page waits for the actions sent before it, so a screenshot taken in the same step as some typing
 * shows the typing, but it holds nothing: it does not change the page, so the actions sent after it need not wait
 * for the picture to be taken.
 */
import PQueue, { TimeoutError } from "p-queue";

export type BrowserTurns = {
  /**
   * Wait for every action sent before this one, then hold the browser until the answer is called.
   *
   * Joins the line when it is called, not when it is awaited, so call it before anything else is awaited: a request
   * that read its body first would join in the order the bodies arrived, not the requests.
   */
  hold(signal?: AbortSignal): Promise<() => void>;
  /** Wait for every action sent before this one, without holding the browser. */
  after(signal?: AbortSignal): Promise<void>;
  /** Whether an action is running or waiting. A session with one is not idle, whatever its browser is doing. */
  busy(): boolean;
};

export function createBrowserTurns(options: {
  /** How long one action may hold the browser before the next goes ahead anyway. */
  limitMs: number;
  /** Told when an action overran its turn. */
  onOverrun?: (limitMs: number) => void;
}): BrowserTurns {
  const line = new PQueue({ concurrency: 1 });
  return {
    hold(signal) {
      return new Promise((granted, refused) => {
        let release = () => {};
        const held = new Promise<void>((done) => {
          release = done;
        });
        line
          .add(
            () => {
              granted(release);
              return held;
            },
            { timeout: options.limitMs, ...(signal ? { signal } : {}) },
          )
          .catch((error: unknown) => {
            // After the turn was granted this only frees it for the next action; `refused` then does nothing.
            if (error instanceof TimeoutError)
              options.onOverrun?.(options.limitMs);
            refused(error);
          });
      });
    },
    async after(signal) {
      await line.add(() => undefined, signal ? { signal } : {});
    },
    busy: () => line.pending + line.size > 0,
  };
}
