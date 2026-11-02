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
 *
 * The `Map` below is per-process state, and is allowed to be: it is one container's view of the
 * browsers it is running, not state that has to survive a replica or agree with one. A restart
 * dropping it is precisely the case the run exists for. Request identities are the exception: the
 * separate control store retains their outcomes and marks active handoffs interrupted on reload.
 */
import type { Page } from "playwright";
import { type Control, createControl } from "./control";
import { createControlStore } from "./control-store";
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
  /** Context identity separates popup changes from actual browser replacement. */
  browserContext?: object;
  /**
   * This Bot's live screen, and who owns it.
   *
   * Always present, because the slot is the answer to "is anybody watching" as well as the holder of
   * whoever is. An empty slot is a Bot nobody is watching; there is no second way to say that.
   */
  viewer: ViewerSlot;
  /**
   * How many inputs a person has sent this browser. A background page restore compares it before
   * navigating, so it never moves a page out from under someone who has started driving.
   */
  humanInputs: number;
};

export type SessionsOptions = {
  /** Whether this Bot has a browser right now, so the sweep keeps what belongs to a running one. */
  isLive: (botId: string) => boolean;
  /** How many sessions may accumulate before the sweep runs. */
  cap?: number;
  /** Atomic handoff history outside each Chromium profile. */
  profilesDirectory?: string;
  /** Injected so a test can name the run it expects rather than match a uuid. */
  mintRun?: () => string;
  /** Told when the wheel leaves the person who held this Bot's browser (see `createControl`'s `onWheelLeft`). */
  onWheelLeft?: (botId: string) => Promise<unknown> | undefined;
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
      if (wheelWithPerson(session)) continue;
      sessions.delete(botId);
    }
  }

  /**
   * Whether a person holds this Bot's wheel, or the Bot has asked one to take it and is waiting.
   *
   * Either way the browser is somebody's to work in or about to be, so it is kept: here, when the map
   * is trimmed, and by the computer when it closes browsers for memory or closes a Bot's idle tabs.
   * A request that has waited past its time has expired by the time this asks (`get` expires it), so
   * a Bot that asked and was never answered does not hold its browser for ever.
   */
  function wheelWithPerson(session: BotSession): boolean {
    const state = session.control.get();
    return state.request?.status === "waiting" || state.holder === "human";
  }

  function sessionFor(botId: string): BotSession {
    const existing = sessions.get(botId);
    if (existing) return existing;
    let generation = 0;
    const created: BotSession = {
      control: createControl(undefined, {
        ...(options.profilesDirectory
          ? { store: createControlStore(options.profilesDirectory, botId) }
          : {}),
        invalidateSnapshot: () => {
          generation += 1;
        },
        onWheelLeft: () => options.onWheelLeft?.(botId),
      }),
      get snapshotId() {
        return generation;
      },
      set snapshotId(value: number) {
        generation = value;
      },
      run: mintRun(),
      viewer: createViewerSlot(),
      humanInputs: 0,
    };
    sessions.set(botId, created);
    // Cheap, and only ever on the path that adds one, so the map cannot grow without this running.
    if (sessions.size > cap) forgetIdle();
    return created;
  }

  return {
    for: sessionFor,

    observeBrowser(botId: string, context: object): boolean {
      const session = sessionFor(botId);
      const replaced =
        session.browserContext !== undefined &&
        session.browserContext !== context;
      if (replaced) this.renewRun(botId);
      session.browserContext = context;
      return replaced;
    },

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
     * Whether a person holds this Bot's wheel or has been asked to take it (`wheelWithPerson`).
     *
     * Asks without answering, like `get`: a Bot with no session has nobody at its wheel, and this is
     * asked on the paths that close browsers, where creating an entry would grow the map.
     */
    personHasTheWheel(botId: string): boolean {
      const session = sessions.get(botId);
      return session ? wheelWithPerson(session) : false;
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
    renewRun(
      botId: string,
      {
        keepWheel = false,
      }: {
        /**
         * The browser went because the person holding the wheel cleared it, which is not a restart under them: they
         * keep the wheel and work the fresh browser. Every ref handed out before is retired all the same.
         */
        keepWheel?: boolean;
      } = {},
    ): string {
      const existing = sessions.get(botId);
      // Nothing to renew: a Bot nobody has touched yet gets a session, and its run is already new.
      if (!existing) return sessionFor(botId).run;
      // A browser that closed or was replaced underneath the request is a restart, so its page stays
      // for a request raised from the blank browser that follows. A deliberate stop or reset clears
      // it straight after, in its own route. A clear leaves the wheel where it is, and retires the
      // refs as the interruption would have.
      if (keepWheel) existing.snapshotId += 1;
      else
        existing.control.interrupt(
          "The browser was stopped or replaced; request help again to continue.",
          { keepPage: true },
        );
      existing.livePage = undefined;
      existing.browserContext = undefined;
      existing.run = mintRun();
      return existing.run;
    },
  };
}
