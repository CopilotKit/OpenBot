import { settleWithin } from "./env";
import type { Screencast } from "./screencast";

/**
 * How long a cast gets to stop before the teardown moves on without it.
 *
 * Bounded because occupancy counts teardowns that are still running, and the session sweep reads
 * occupancy. A `stop` that never settles would leave the entry in the set for the life of the
 * process, so the Bot would read as watched forever and its session could never be swept, which is
 * the unbounded growth that sweep exists to stop, arriving through the fix for it.
 */
const STOP_BUDGET_MS = 5_000;

/**
 * Who owns a Bot's live screen, and what may still act on it.
 *
 * A Bot has one live screen at a time, and a second `/stream` replaces the first rather than being
 * refused: a second cast on the same page would have Chrome encoding every frame twice with both
 * sockets acking independently, which stalls both. One person drives, one cast.
 *
 * What replacement does not do is close the socket it superseded, because that socket belongs to a
 * client that may still be using it. So a superseded socket stays open and closes on its own
 * schedule, which on an ordinary make-before-break reconnect is after the replacement is already
 * casting. Anything that stops a viewer therefore has to establish that it owns the one it is
 * stopping, and that is what this module exists to make unavoidable rather than remembered.
 *
 * Ownership is held per socket, as a claim taken before the browser is asked for a page. That order
 * is the load-bearing part. `open` awaits a page, which launches Chromium when nothing is running,
 * and a close landing inside that window used to find nothing installed and so did nothing, while
 * the launch went on to install a cast and a 1Hz follow loop for a socket that had already gone. No
 * second close ever arrived. With the claim taken first there is always something to release, and
 * everything the launch produces afterwards goes through that claim and is refused once it is
 * revoked.
 *
 * The refusals hand nothing back to the caller to clean up. A refused `install` stops the cast it was
 * given and a refused `setFollow` cancels the loop it was given, because a caller that forgets leaks
 * a screencast or a timer against a browser nobody is watching, and forgetting is exactly what this
 * module is here to take off the table. For the same reason there is no way to stop a cast you do
 * not own: `release` names a socket and does nothing when that socket owns nothing.
 *
 * It lives in its own file for the reason `browser-eviction.ts`, `authorisation.ts` and `bot-id.ts`
 * do: `index.ts` imports Playwright at module scope, so anything left there needs Chrome merely to
 * be imported by a test. `Screencast` comes in as a type only, which is erased at runtime, so this
 * module and its tests stay free of the browser. Starting and stopping a cast stays in `index.ts`;
 * the decisions are here.
 */

/**
 * What a socket may do with the screen right now.
 *
 * Three answers, not two. A socket holding a claim with no cast yet is mid-launch and its screen is
 * still opening; a socket holding nothing was superseded, closed, or never connected. Both own no
 * cast, and collapsing them tells somebody whose screen is still starting that their session ended.
 * The message is the only thing either of them gets, so it has to be the true one.
 */
export type ViewerStanding =
  | { state: "casting"; cast: Screencast }
  | { state: "starting" }
  | { state: "gone" };

/** What an in-flight `open` may do with the screen it is starting. Refused once revoked. */
export type ViewerClaim = {
  /**
   * Put a cast behind this claim, replacing one already there.
   *
   * Answers whether it was accepted. A refused cast is stopped here rather than returned, so a
   * launch that lost its claim cannot leak one. The replaced cast stops only after the new one is
   * installed, so the screen does not blank between the two while the Bot moves page to page.
   */
  install(cast: Screencast): Promise<boolean>;
  /** Register the loop that keeps the cast on the Bot's current page. A refused loop is cancelled. */
  setFollow(cancel: () => void): boolean;
};

export type ViewerSlot = {
  /** Take the screen for this socket, superseding and tearing down whoever held it. */
  claim(socket: unknown, notify: (reason: string) => void): ViewerClaim;
  /** Give up the screen, if this socket is the one holding it. Its own close, so it is not told. */
  release(socket: unknown): Promise<void>;
  /** The browser went away. Tear down whoever is watching and tell them why. */
  releaseAll(reason: string): Promise<void>;
  /** What this socket may do with the screen right now. */
  standingOf(socket: unknown): ViewerStanding;
  /** Is anybody watching, or about to be? What the session sweep asks. */
  occupied(): boolean;
  /** Settle in-flight teardowns. A test seam; nothing on the acting path waits on this. */
  settled(): Promise<void>;
};

/** What a person is told when somebody else takes the screen they were watching. */
export const SUPERSEDED =
  "This screen is now being watched somewhere else, so it stopped here.";

type Entry = {
  socket: unknown;
  notify: (reason: string) => void;
  cast?: Screencast;
  cancelFollow?: () => void;
  /** Set the moment the entry stops owning the screen, and never unset. The one source of truth. */
  revoked: boolean;
};

export function createViewerSlot(): ViewerSlot {
  let current: Entry | undefined;
  /*
   * Teardowns still running. Occupancy counts them, because a browser whose cast is still stopping
   * is not yet a Bot nobody is watching, and the session sweep reading otherwise would drop the
   * control state out from under a screen that is mid-handover.
   */
  const tearing = new Set<Promise<void>>();

  function track(work: Promise<void>): void {
    tearing.add(work);
    void work.finally(() => tearing.delete(work));
  }

  /*
   * Everything is best effort and nothing throws. The page can go away before its cast is told to
   * stop, and the socket can be gone before we can tell it anything, and neither is a reason to
   * leave the rest of the teardown undone: one dead page must not wedge the slot for every later
   * connection.
   */
  async function tearDown(entry: Entry, reason?: string): Promise<void> {
    if (reason !== undefined) {
      try {
        entry.notify(reason);
      } catch {
        // The socket is already gone. It cannot be told, and does not need to be.
      }
    }
    if (entry.cancelFollow) {
      try {
        entry.cancelFollow();
      } catch {
        // Cancelling a timer does not fail, but a caller's callback might.
      }
      entry.cancelFollow = undefined;
    }
    const cast = entry.cast;
    entry.cast = undefined;
    await settleWithin(cast?.stop(), STOP_BUDGET_MS);
  }

  async function stopStray(cast: Screencast): Promise<void> {
    await settleWithin(cast.stop(), STOP_BUDGET_MS);
  }

  return {
    claim(socket, notify) {
      const previous = current;
      const entry: Entry = { socket, notify, revoked: false };
      /*
       * The new claim owns the screen from here, before anything is awaited. A reconnect that
       * arrives while the previous cast is still stopping must not be able to lose to it.
       */
      current = entry;
      if (previous) {
        previous.revoked = true;
        track(tearDown(previous, SUPERSEDED));
      }

      return {
        async install(cast) {
          if (entry.revoked) {
            /*
             * Tracked, not merely awaited. Occupancy and `settled` are how everything else learns
             * that nothing is casting any more, and a cast stopped outside that accounting means
             * both of them can answer "nothing" while Chrome is still encoding frames.
             */
            const work = stopStray(cast);
            track(work);
            await work;
            return false;
          }
          const replaced = entry.cast;
          entry.cast = cast;
          // After the replacement is running, so the screen does not go blank in between.
          if (replaced) {
            const work = stopStray(replaced);
            track(work);
            await work;
          }
          return true;
        },
        setFollow(cancel) {
          if (entry.revoked) {
            try {
              cancel();
            } catch {
              // Same reason the teardown swallows it.
            }
            return false;
          }
          entry.cancelFollow?.();
          entry.cancelFollow = cancel;
          return true;
        },
      };
    },

    async release(socket) {
      const entry = current;
      // Identity, never shape. Two sockets are distinct objects however alike they look, and an
      // equality that compared their contents would hand the screen to any socket resembling the
      // owner. This is also what makes a superseded socket's late close a no-op.
      if (!entry || entry.socket !== socket) return;
      current = undefined;
      entry.revoked = true;
      // Its own close, so nobody is told: the client already knows, and the socket is going away.
      const work = tearDown(entry);
      track(work);
      await work;
    },

    async releaseAll(reason) {
      const entry = current;
      if (!entry) return;
      current = undefined;
      entry.revoked = true;
      const work = tearDown(entry, reason);
      track(work);
      await work;
    },

    standingOf(socket) {
      if (!current || current.socket !== socket) return { state: "gone" };
      return current.cast
        ? { state: "casting", cast: current.cast }
        : { state: "starting" };
    },

    occupied() {
      return current !== undefined || tearing.size > 0;
    },

    async settled() {
      await Promise.all([...tearing]);
    },
  };
}
