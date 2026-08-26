/**
 * What this process remembers about a Bot between requests, and which run of its browser that is.
 *
 * ITS OWN MODULE BECAUSE THE RUN IS A DECISION, not bookkeeping. `index.ts` imports Playwright at
 * module scope, so anything left in there can only be tested by launching a browser, and the rules
 * below are exactly the ones with a wrong answer available: which events start a new run, and which
 * leave the one in progress alone. Same reason `browser-eviction.ts` and `profile-listing.ts` are
 * separate files. `Page` comes in as a type only, which is erased at runtime, so this module and its
 * tests stay free of the browser.
 *
 * The generation counter orders snapshots within one run of a browser and says nothing across two.
 * It is minted at zero for a session that is new, and a session is new after a container restart, a
 * redeploy, an eviction from the sweep below, and a reset. None of those reach the server, so a ref
 * it is still holding from the run before matches a row nothing has overwritten, and the boundary
 * decides about an element on a page that no longer exists.
 *
 * The run carries that difference to the server, which orders on `(run, generation)` rather than on
 * the generation alone. A Bot with its own container gets one from the container and a sandbox gets
 * one from the moment its browser last became ready; the shared computer is one process serving
 * every Bot, outliving every reset, so here the answer has to come from the session itself.
 */
import type { Page } from "playwright";
import { type Control, createControl } from "./control";
import { createViewerSlot, type ViewerSlot } from "./viewer";

/** Per-Bot browser-control state. Profiles are isolated, but this process is not a security boundary. */
export type BotSession = {
  control: Control;
  /** This Bot's snapshot generation. Ordered within this run, and meaningless across two. */
  snapshotId: number;
  /**
   * Which run of this Bot's browser this is, for the server to order snapshots across.
   *
   * Per Bot rather than per process: they share this container and nothing else, so a run naming the
   * container would be one string for every Bot and would never change when one of their browsers
   * was replaced.
   */
  run: string;
  /** The page this Bot was last handed, so a change of page can retire its refs. */
  livePage?: Page;
  /**
   * This Bot's live screen, and who owns it.
   *
   * Always present, because the slot is the answer to "is anybody watching" as well as the holder of
   * whoever is. An empty slot is a Bot nobody is watching; there is no second way to say that.
   */
  viewer: ViewerSlot;
};

export type SessionsOptions = {
  /** Whether this Bot has a browser right now, so the sweep keeps what belongs to a running one. */
  isLive: (botId: string) => boolean;
  /** How many sessions may accumulate before the sweep runs. */
  cap?: number;
  /** Injected so a test can name the run it expects rather than match a uuid. */
  mintRun?: () => string;
};

/**
 * A factory rather than a module-level `Map`, so a test can have its own and two cannot accidentally
 * share state. The same shape `createControl` uses, for the same reason.
 */
export function createSessions(options: SessionsOptions) {
  const sessions = new Map<string, BotSession>();
  const cap = options.cap ?? 32;
  const mintRun = options.mintRun ?? (() => crypto.randomUUID());

  /**
   * Forget the sessions of Bots whose browsers are no longer running.
   *
   * The map gained an entry per Bot id this process had ever seen and lost none, so a deployment
   * where every employee has a Bot accumulated one small object per employee for the life of the
   * container. Small, but unbounded, which is the same shape as the browsers themselves.
   *
   * Only entries with no live browser and nobody watching are dropped: the state is the generation
   * counter, the run, and the control handover, and all three belong to a running browser. A Bot
   * whose browser has been closed starts a fresh session next time, which is what starting a fresh
   * browser means, and the new run is what says so.
   *
   * "Nobody watching" starts at the claim, not at the first frame. A viewer whose browser is still
   * launching holds a claim and no cast, and reading occupancy from the cast would call that Bot
   * idle for the whole cold launch: this runs on the path that adds a session, so another Bot
   * connecting then would drop the control handover out from under a screen that is seconds from
   * live. It stays occupied until teardown finishes, for the same reason at the other end.
   */
  function forgetIdle(): void {
    for (const [botId, session] of [...sessions.entries()]) {
      if (session.viewer.occupied()) continue;
      if (options.isLive(botId)) continue;
      sessions.delete(botId);
    }
  }

  function sessionFor(botId: string): BotSession {
    const existing = sessions.get(botId);
    if (existing) return existing;
    const created: BotSession = {
      control: createControl(),
      snapshotId: 0,
      run: mintRun(),
      viewer: createViewerSlot(),
    };
    sessions.set(botId, created);
    // Cheap, and only ever on the path that adds one, so the map cannot grow without this running.
    if (sessions.size > cap) forgetIdle();
    return created;
  }

  return {
    for: sessionFor,

    /**
     * The session this Bot already has, or nothing.
     *
     * Separate from `for` because the teardown paths need to ask without answering. A browser
     * closing, or a socket closing for a Bot with no session, has nothing to take down, and creating
     * an entry there would grow the map on exactly the paths it is meant to shrink on.
     */
    get(botId: string): BotSession | undefined {
      return sessions.get(botId);
    },

    /**
     * Start a new run for this Bot, because its browser session is over.
     *
     * A reset closes the browser and deletes the profile, and the session survives it: nothing takes
     * the entry out of the map, so the generation counter carries on from where it was. Without a new
     * run the server cannot tell a save that was in flight when the wipe landed from the fresh
     * browser's own, and the wiped page comes back with nothing willing to refuse it.
     *
     * The generation is deliberately left alone. It belongs to the browser, which restarts it at zero
     * on its own when a session is genuinely new, and zeroing it here would hand the server a fresh
     * generation one under a fresh run for a counter that never restarted.
     */
    renewRun(botId: string): string {
      const existing = sessions.get(botId);
      // Nothing to renew: a Bot nobody has touched yet gets a session, and its run is already new.
      if (!existing) return sessionFor(botId).run;
      existing.run = mintRun();
      return existing.run;
    },
  };
}
