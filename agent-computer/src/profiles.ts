/**
 * The Bot's browser, and the profile that outlives it.
 *
 * A persistent profile lets a Bot remain signed in across process and container restarts.
 *
 * Persistent context, not a saved storage state. Playwright can export cookies and localStorage as
 * JSON and replay them, and that is the wrong tool here: it captures what the automation knew about,
 * on demand, and misses IndexedDB, service workers, and anything written after the snapshot.
 * `launchPersistentContext` points Chromium at a real user-data directory, so the browser persists
 * its own state the way it does on a desktop. On a mounted volume, that directory outlives the
 * container.
 *
 * Profile behavior in this image and Playwright version:
 *   - A cookie with an expiry survives close-and-reopen. So does localStorage.
 *   - A session cookie (no expiry) does not, and should not: Chromium drops those on restart, exactly
 *     as a desktop browser does. Any "stay signed in" worth the name sets an expiring cookie, but this
 *     is why a site that only ever issues session cookies will still ask a Bot to sign in again.
 *   - Killing the browser process with SIGKILL leaves no stale singleton lock in the profile, and the
 *     profile reopens with its cookies intact. The widely-reported `SingletonLock` breakage does not
 *     reproduce here. The defensive sweep below stays anyway, because it is three lines and the
 *     failure it prevents is "the computer never comes back".
 *
 * One profile per Bot. Two Bots sharing a profile share their logins, which makes "this Bot may reach
 * Salesforce" unenforceable: whatever one signs into, the other is signed into. Each Bot gets its own
 * directory, so its cookies and its storage are its own.
 *
 * A profile is not a container. Two Bots in this process are isolated from each other's cookies, not
 * from each other's kernel, filesystem or memory.
 *
 * Container-per-Bot needs something privileged to create containers, and the API server must never be
 * that: access to the Docker socket is unrestricted root on the host. Stop and reset are
 * operations this process applies to its own browser, so the same design works under Compose,
 * Kubernetes or ECS, where the orchestrator's own restart policy brings a process back.
 */

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { profileDirectoryFor } from "./bot-id";
import { chooseEvictions, chooseIdle } from "./browser-eviction";
import { egressFor, egressLabel } from "./egress";
import { numberFromEnv } from "./env";
import { botIdsIn } from "./profile-listing";

// Re-exported so callers that already import it from here do not change, while the test imports it
// from the playwright-free `./env` instead of pulling this module's browser driver in with it.
export { numberFromEnv };

/** The viewport, which is what a person's click coordinates are relative to. */
export const VIEWPORT = { width: 1280, height: 800 };

/**
 * Files Chromium uses to refuse a second instance on one profile.
 *
 * Swept on the way in rather than the way out, because the way out is the case that does not happen:
 * a container that is killed does not get to run cleanup. If this process is starting, no browser of
 * ours is running, so any lock here is by definition from a life that has already ended.
 */
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/**
 * How the browser is started, and why each flag is here.
 *
 * `--password-store=basic` makes a durable profile work in a container. Chromium normally encrypts
 * cookie values with a desktop keyring; containers have no stable gnome-keyring or kwallet, so the
 * default fallback can make stored cookies unreadable after restart.
 *
 * `basic` pins it to Chromium's own fixed fallback, which is deterministic and survives restarts.
 * This is obfuscation at rest, not protection. Anything that can read the volume can read the
 * cookies. The volume's own permissions are the security boundary.
 */
/**
 * Whether Chromium gets to use its own sandbox.
 *
 * OFF BY DEFAULT, AND THAT IS NOT A PREFERENCE. Chromium's sandbox creates user namespaces, and
 * Docker's default seccomp profile blocks the syscall it needs, so a container that does nothing
 * special gets `No usable sandbox!` and the browser will not start at all. Verified both ways in
 * this image: default profile fails, relaxed profile renders.
 *
 * TURN IT ON WHERE THE HOST ALLOWS IT. On a VM or self-hosted Docker, run with a Chromium seccomp
 * profile and set `COMPUTER_SANDBOX=on`. That is strictly better than everything below, because it
 * is the boundary Chromium itself maintains against the pages it renders.
 *
 * WHERE IT CANNOT BE ON. Serverless container platforms do not let you set a seccomp profile or add
 * capabilities; Fargate restricts `CAP_SYS_ADMIN` explicitly. There the sandbox is unavailable, and
 * the compensating controls are the ones this image already has, a non-root user, plus gVisor
 * underneath, which Cloud Run applies to everything by default.
 *
 * Said out loud at start-up either way. An operator should not have to read this file to find out
 * whether the browser rendering the open internet is sandboxed.
 */
const SANDBOX_ENABLED = process.env.COMPUTER_SANDBOX === "on";

const LAUNCH_ARGS = [
  ...(SANDBOX_ENABLED ? [] : ["--no-sandbox"]),
  "--disable-dev-shm-usage",
  "--password-store=basic",
];

console.info(
  JSON.stringify({
    type: "computer-sandbox",
    sandbox: SANDBOX_ENABLED ? "on" : "off",
    ...(SANDBOX_ENABLED
      ? {
          note: "Chromium's own sandbox is in use. It will refuse to start if the host does not permit user namespaces.",
        }
      : {
          note: "Chromium runs without its own sandbox, which is the only thing that works under a default container seccomp profile. Set COMPUTER_SANDBOX=on where the host allows it.",
        }),
  }),
);

/**
 * How long to let a closing browser finish writing before moving on.
 *
 * The profile's Cookies file may be rewritten shortly after `close()` is called. This delay stays
 * clear of that window while remaining inside the container's
 * 30s stop grace period, so a shutdown never becomes the reason a computer does not come back.
 */
const CLOSE_SETTLE_MS = 2_000;

/** What a Bot's browser looks like from outside. */
export type BotBrowser = {
  botId: string;
  context: BrowserContext;
  page: Page;
};

export type ProfileSummary = {
  botId: string;
  /** Whether a browser is running for this Bot right now. */
  running: boolean;
  /** When this Bot's browser was last started, or null if it is not running. */
  startedAt: string | null;
  /** The proxy its traffic leaves through, by host only. Never the credentials. */
  egress: string | null;
};

/**
 * Close a context and wait for Chromium to finish writing.
 *
 * Chromium batches cookie writes and commits them as it exits, while `close()` only asks it to exit.
 * Bounded, because a shutdown that hangs must never be the reason a computer does not come back. We
 * would rather lose the last few seconds of cookies than never restart.
 */
async function closeAndWait(context: BrowserContext): Promise<void> {
  await context.close().catch(() => undefined);
  // A fixed settle is used because persistent contexts do not expose a reliable browser-exit signal.
  await new Promise((resolve) => setTimeout(resolve, CLOSE_SETTLE_MS));
}

/**
 * How many browsers one computer holds at once.
 *
 * There was no cap. A context was started the first time each Bot was used and kept, and the only
 * things that dropped one were an explicit stop, a browser that had already died, and shutdown. A
 * deployment where every employee has a Bot therefore trends toward one resident Chromium per
 * employee in a single container, at a few hundred MB each, until the container is killed for memory
 * and `page()` relaunches its way back to the same state.
 *
 * A cap rather than only an idle timeout, because the failure is concurrent breadth rather than age:
 * fifty people using their Bots inside the same minute are fifty live browsers and none of them are
 * idle. The least recently used is closed, which is the one whose Bot has been quiet longest.
 *
 * Closing is not losing anything. The profile is on disk, so a Bot whose browser was closed starts
 * again where it left off, which is what `stop` already means here.
 */
const MAX_LIVE_BROWSERS = numberFromEnv("COMPUTER_MAX_BROWSERS", 8);

/**
 * How long a browser may sit untouched before it is closed.
 *
 * The other half. A deployment under the cap still holds a browser per Bot that was used once last
 * Tuesday, and that memory is doing nothing for anybody.
 */
const IDLE_TIMEOUT_MS = numberFromEnv("COMPUTER_BROWSER_IDLE_MS", 30 * 60_000);

/** How often the idle sweep looks. Cheap: it walks a map of at most `MAX_LIVE_BROWSERS`. */
const IDLE_SWEEP_MS = 60_000;

export function createProfiles(root: string) {
  /** One running browser per Bot, up to {@link MAX_LIVE_BROWSERS}. */
  const live = new Map<
    string,
    {
      context: BrowserContext;
      page: Page;
      startedAt: string;
      /** When this Bot last asked for its page. Decides what the cap and the sweep close. */
      usedAt: number;
    }
  >();
  /** Launches in flight, so a cold computer is started once however many callers ask at once. */
  const starting = new Map<string, Promise<Page>>();

  // Checked, not joined. `join(root, botId)` normalizes `..` away, so a Bot id of `../workspace`
  // used to resolve outside the root and `reset` would delete whatever was there.
  const directoryFor = (botId: string): string =>
    profileDirectoryFor(root, botId);

  /**
   * Close one Bot's browser and forget it.
   *
   * Gracefully, so Chromium flushes the profile: the whole point of closing one is that the Bot's
   * logins survive and its next request starts where it left off.
   */
  const evict = async (botId: string, reason: string): Promise<void> => {
    const running = live.get(botId);
    if (!running) return;
    live.delete(botId);
    console.info(
      JSON.stringify({ type: "computer-browser-closed", botId, reason }),
    );
    await closeAndWait(running.context).catch(() => undefined);
  };

  /**
   * Keep the number of running browsers under the cap.
   *
   * Least recently used first, which is the Bot that has been quiet longest. Called after a launch
   * rather than before, so the Bot that just asked is never the one closed.
   */
  const enforceCap = async (): Promise<void> => {
    for (const botId of chooseEvictions(live.entries(), MAX_LIVE_BROWSERS)) {
      await evict(botId, "the cap on running browsers was reached");
    }
  };

  /**
   * Close browsers nothing has touched for a while.
   *
   * The cap answers concurrent breadth; this answers a Bot used once last Tuesday whose browser is
   * still resident and doing nothing for anybody.
   */
  const sweepIdle = async (): Promise<void> => {
    for (const botId of chooseIdle(
      live.entries(),
      IDLE_TIMEOUT_MS,
      Date.now(),
    )) {
      await evict(botId, "it had been idle");
    }
  };

  const idleSweep = setInterval(() => {
    void sweepIdle().catch(() => undefined);
  }, IDLE_SWEEP_MS);
  // Housekeeping must not hold the process open on the way out.
  idleSweep.unref?.();

  const sweepLocks = async (dir: string): Promise<void> => {
    await Promise.all(
      SINGLETON_FILES.map((name) =>
        rm(join(dir, name), { force: true }).catch(() => undefined),
      ),
    );
  };

  return {
    /**
     * The Bot's page, starting its browser if it is not running.
     *
     * Started on first use rather than at boot, and re-created if it died: a crashed Chromium would
     * otherwise leave this process alive and answering the same error for every request until the
     * container restarts. This turns that into one slow request instead of an outage.
     */
    async page(botId: string): Promise<Page> {
      /*
       * One launch at a time per Bot. Calls that arrive during a launch wait for that launch instead
       * of starting another browser against the same profile directory.
       */
      const launching = starting.get(botId);
      if (launching) return launching;

      const existing = live.get(botId);
      if (
        existing?.context.browser()?.isConnected() &&
        !existing.page.isClosed()
      ) {
        // Touched on every use, which is what makes "least recently used" mean anything.
        existing.usedAt = Date.now();
        return existing.page;
      }
      if (existing) {
        // Half-dead: the browser went away, or its page did. Dropped rather than repaired, because a
        // context whose browser has gone is not usable for anything.
        await existing.context.close().catch(() => undefined);
        live.delete(botId);
      }

      const launch = (async () => {
        const dir = directoryFor(botId);
        await sweepLocks(dir);
        const proxy = egressFor(botId, process.env);
        const context = await chromium.launchPersistentContext(dir, {
          args: LAUNCH_ARGS,
          // Playwright adds `--no-sandbox` on its own unless told otherwise, so leaving this out
          // means the flag above decides nothing and a deployment that asked for the sandbox does
          // not get one. Verified by reading the launched process arguments, not by trusting either.
          chromiumSandbox: SANDBOX_ENABLED,
          viewport: VIEWPORT,
          // This process owns shutdown. Playwright's signal handlers kill Chromium immediately on
          // SIGTERM, before pending cookie writes have time to flush.
          handleSIGTERM: false,
          handleSIGINT: false,
          handleSIGHUP: false,
          ...(proxy ? { proxy } : {}),
        });
        // Persistent contexts open with a page already; reuse it rather than leaving an extra blank tab.
        const page = context.pages()[0] ?? (await context.newPage());
        live.set(botId, {
          context,
          page,
          startedAt: new Date().toISOString(),
          usedAt: Date.now(),
        });
        // After the new one is in the map, so the cap counts what is really running and the Bot that
        // just asked is the most recently used and therefore never the one closed.
        await enforceCap();
        return page;
      })();

      starting.set(botId, launch);
      try {
        return await launch;
      } finally {
        // Cleared whether it worked or not so a failed launch does not pin future calls to a rejected
        // promise.
        starting.delete(botId);
      }
    },

    /**
     * Close this Bot's browser without touching what it knows.
     *
     * Gracefully, so Chromium flushes its profile. This is what "kill" means for a Bot's computer: the
     * browser stops, the login survives, and the next request starts it again where it left off.
     */
    async stop(botId: string): Promise<boolean> {
      const existing = live.get(botId);
      if (!existing) return false;
      live.delete(botId);
      await closeAndWait(existing.context);
      return true;
    },

    /**
     * Forget everything this Bot knows and start over.
     *
     * The browser is closed before the directory is deleted: deleting a profile
     * out from under a running Chromium is how you get a browser that is alive, writing to files that
     * no longer exist, and reporting success. Nothing is recreated here, the next request starts a
     * clean browser, which is the same path as a first ever start and so needs no second code path.
     */
    async reset(botId: string): Promise<void> {
      await this.stop(botId);
      await rm(directoryFor(botId), { recursive: true, force: true });
    },

    /**
     * Every Bot that has a computer, whether or not one is running.
     *
     * Read from disk rather than from memory, because a Bot's computer exists as long as its profile
     * does: after a restart nothing is running and every login is still there, and an admin page that
     * listed only live browsers would show an empty screen and imply the logins were gone.
     */
    async known(): Promise<string[]> {
      const onDisk = await readdir(root, { withFileTypes: true }).catch(
        () => [],
      );
      /*
       * The rule lives in its own module, so the test that covers it imports the same one this uses.
       * It had a copy before, which meant deleting this filter left the suite green.
       */
      return [...new Set([...botIdsIn(onDisk), ...live.keys()])].sort();
    },

    /** What the admin surface lists. Running or not, because a Bot that has a profile has a computer. */
    summary(botIds: string[]): ProfileSummary[] {
      const known = new Set([...botIds, ...live.keys()]);
      return [...known].sort().map((botId) => {
        const running = live.get(botId);
        return {
          botId,
          running: Boolean(running),
          startedAt: running?.startedAt ?? null,
          egress: egressLabel(botId, process.env),
        };
      });
    },

    /**
     * Close every browser, for shutdown.
     *
     * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait. Closing the contexts
     * here gives Chromium the chance to flush its profile within that grace period.
     */
    async closeAll(): Promise<void> {
      clearInterval(idleSweep);
      const contexts = [...live.values()];
      live.clear();
      await Promise.all(contexts.map((c) => closeAndWait(c.context)));
    },

    /** How many browsers are running. For the idle sweep's own tests, and for a status reader. */
    liveCount(): number {
      return live.size;
    },

    /** Whether this Bot has a browser right now, so a caller can drop state that belongs to one. */
    isLive(botId: string): boolean {
      return live.has(botId);
    },

    /** Run the idle sweep now. Exposed so a test does not have to wait a minute for the interval. */
    sweepIdleNow(): Promise<void> {
      return sweepIdle();
    },
  };
}

export type Profiles = ReturnType<typeof createProfiles>;
