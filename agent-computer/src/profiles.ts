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
 *   - A session cookie (no expiry) does not: Chromium drops those on restart, exactly as a desktop
 *     browser does. Here a restart is a pod being deleted by an idle suspend or an image update, so
 *     `session-cookies.ts` writes them to a file in the same profile and puts them back on launch.
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

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from "playwright";
import {
  isPersonBrowserId,
  RECORDER_DIR_ENV,
} from "../../shared/openbot-browser";
import { profileDirectoryFor, seatParts } from "./bot-id";
import {
  chooseEvictions,
  chooseForMemory,
  chooseIdle,
  chooseIdleTabs,
  keptOpen,
} from "./browser-eviction";
import { type BrowserRuntime, browserRuntimeFromEnv } from "./browser-runtime";
import { type CarryOverOutcome, carryOverProfile } from "./carry-over";
import {
  type MemoryReading,
  memoryAtOrAbove,
  memoryRunsHigh,
  memoryTargetPercent,
  readContainerMemory,
} from "./container-memory";
import { egressFor, egressLabel } from "./egress";
import { numberFromEnv, settleWithin } from "./env";
import { chooseLivePage } from "./live-page";
import { attachBrowserNetwork, attachPageNetwork } from "./page-network";
import { BrowserNotOpenError } from "./person-access";
import {
  launchPersonBrowser,
  type PersonBrowser,
  personPages,
  windowPages,
} from "./person-browser";
import {
  type PersonDisplay,
  PLAYWRIGHT_DISABLED_FEATURES,
  personWindow,
  recorderLaunchOptions,
} from "./person-launch";
import { seatIdsIn } from "./profile-listing";
import { findRecorder, isRecorderPage, type Recorder } from "./recorder";
import {
  fitWindowsToViewport,
  keepRecorderCurrent,
  reachRecorder,
} from "./recorder-in-browser";
import type { RecorderLauncher } from "./recorder-launcher";
import {
  type SessionCookieKeeper,
  sessionCookieKeeper,
} from "./session-cookies";

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
const BROWSER_RUNTIME = browserRuntimeFromEnv(process.env);
// Native Chrome has no container boundary. Always retain its own process sandbox and OS keychain.
const sandboxFor = (runtime: BrowserRuntime) =>
  runtime.backend === "local-chrome" || process.env.COMPUTER_SANDBOX === "on";
const SANDBOX_ENABLED = sandboxFor(BROWSER_RUNTIME);

/**
 * Playwright's own disabled features, and AcceptCHFrame, for every browser that reaches the network
 * through the egress filter: a Bot's, and a person's on the live screen.
 *
 * WHY. Such a browser is given the filter with the Bot in its proxy credentials, and a Playwright
 * browser given proxy credentials answers the proxy's challenge itself, through DevTools request
 * interception, so every request it makes is intercepted. Google (www.google.com and
 * accounts.google.com) sends an HTTP/2 ACCEPT_CH frame while the connection is set up, asking for
 * client hints; Chromium then aborts the page's request and restarts it with those hints, and under
 * Playwright's interception the restarted request is never sent. Measured on this filter with
 * Playwright 1.62.1's Chromium: the main-frame request for https://www.google.com/ ends ERR_ABORTED
 * at "connected" and no second one follows, so the page waited until the navigation timed out,
 * while Bing and Wikipedia (no ACCEPT_CH frame) loaded. The same browser loaded Google in about 330
 * ms with this feature off, or with no proxy credentials.
 *
 * With it off, Chromium learns which hints a site wants from its Accept-CH response header, as it
 * did before the frame existed, and sends them from the next request on. Playwright itself launched
 * with it off from 2021 (microsoft/playwright#10380, for the same restart under interception) until
 * 1.58 (#38472); #40194 is this hang reported against later versions.
 *
 * Playwright's own list is repeated because Chromium keeps only the last `--disable-features` on a
 * command line (base/command_line.cc), and this one comes after Playwright's. Both lists are checked
 * against the launched browser's own command line in `person-browser.test.ts`.
 */
const BEHIND_THE_FILTER_FEATURES = `--disable-features=${[
  ...PLAYWRIGHT_DISABLED_FEATURES,
  "AcceptCHFrame",
].join(",")}`;

const launchArgsFor = (local: boolean, sandbox: boolean): string[] => [
  ...(sandbox ? [] : ["--no-sandbox"]),
  "--disable-dev-shm-usage",
  ...(local ? [] : ["--password-store=basic"]),
  // Drop the automation signals Chromium sets for itself, so a real person who takes the wheel can
  // sign in to a site that refuses obvious automation (Google among them). This is the flag, not a
  // JS patch of `navigator.webdriver`: the flag turns the property off at the source, where spoofing
  // it from a script leaves the other tells a detector cross-checks. It does not change what the Bot
  // may do; the governed path is unchanged. Full Chromium is selected explicitly in both modes;
  // headed mode also provides a window a person can use on the native desktop or virtual display.
  "--disable-blink-features=AutomationControlled",
  BEHIND_THE_FILTER_FEATURES,
];

/**
 * WebRTC kept inside the proxy, written into the profile before Chromium reads it.
 *
 * Chromium sends WebRTC over UDP straight past an HTTP proxy unless told not to, so a page in a Bot's
 * browser could reach the network around the egress filter. `disable_non_proxied_udp` allows only
 * UDP through a proxy, and an HTTP proxy carries none, so WebRTC goes over the proxy or not at all.
 * A preference rather than the `--force-webrtc-ip-handling-policy` switch, which current Chromium
 * no longer reads (measured: the switch on the command line, packets still sent). Merged into
 * whatever Preferences the profile already has, so nothing else the profile remembers is lost.
 */
export async function keepWebRtcInsideProxy(profileDir: string) {
  const file = join(profileDir, "Default", "Preferences");
  let preferences: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      preferences = parsed;
  } catch {
    // No Preferences yet (a new profile), or one Chromium never finished writing: start clean.
  }
  const webrtc =
    preferences.webrtc && typeof preferences.webrtc === "object"
      ? (preferences.webrtc as Record<string, unknown>)
      : {};
  if (webrtc.ip_handling_policy === "disable_non_proxied_udp") return;
  preferences.webrtc = {
    ...webrtc,
    ip_handling_policy: "disable_non_proxied_udp",
  };
  await mkdir(join(profileDir, "Default"), { recursive: true });
  await writeFile(file, JSON.stringify(preferences));
}

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

/**
 * How long a change of the page in front of a person's browser waits before it is logged. A person
 * who closes their browser's window, or quits it, closes its tabs one after another, each making the
 * next the page in front, and none of those is a change the browser stays open for. A quit of Google
 * Chrome 156 (headless, three tabs) closed the tabs within 20 ms and the browser within 60 ms.
 */
const PAGE_CHANGE_SETTLE_MS = 500;

/**
 * How long telling a viewer its browser went away may take before the close carries on without it.
 *
 * The close is what has to happen; the announcement is courtesy. Unbounded, one screencast that will
 * not stop would hold a browser close open, and because the cap evicts from inside another Bot's
 * launch, it would hold that launch and everything queued behind it too. On the way out it would
 * keep every profile from flushing until the container was killed.
 */
const ANNOUNCE_BUDGET_MS = 2_000;

/**
 * How long a stop or reset waits for a launch it is racing.
 *
 * Long enough for a cold Chromium start, which is what it is waiting for, and bounded so a launch
 * that never finishes cannot hold a request open forever. Timing out leaves the browser running,
 * which is the same answer the caller got before this waited at all.
 */
const LAUNCH_WAIT_MS = 30_000;

/** What a Bot's browser looks like from outside. */
export type BotBrowser = {
  botId: string;
  context: BrowserContext;
  page: Page;
};

export type ProfileSummary = {
  /** The seat: the Bot, or the person and the Bot on a computer many people share. */
  seat: string;
  botId: string;
  /** Whose seat it is, where this computer serves more than one person. */
  personId?: string;
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
 *
 * Zero is the documented way to say "keep them resident", which is why it is read as a value here
 * rather than as a value that is not set. Read like the cap, an operator who wrote it got the
 * default back and the sweep they had switched off carried on closing their browsers.
 */
const IDLE_TIMEOUT_MS = numberFromEnv("COMPUTER_BROWSER_IDLE_MS", 30 * 60_000, {
  zeroSwitchesItOff: true,
});

/**
 * How often the idle sweep looks. Cheap: it walks a map of at most `MAX_LIVE_BROWSERS`, their tabs,
 * and three small files under `/sys/fs/cgroup`.
 */
const IDLE_SWEEP_MS = 60_000;

/**
 * At what share of the computer's memory it starts closing browsers, least recently used first.
 *
 * The cap counts browsers, and a browser is not a fixed size: a few heavy pages can take a container
 * past its memory limit well under the cap, and the OOM killer does not choose by use. On Kubernetes
 * with cgroup v2 it kills every process in the container together, every Bot's browser at once, and
 * nothing can reach the computer until it comes back. So memory is read the way Kubernetes reads it
 * (`container-memory.ts`) before every launch, which is when memory jumps, and on every tick of the
 * idle sweep. At or above this share of the limit, browsers are closed one at a time, least recently
 * used first, until memory is ten points under it (`memoryTargetPercent`). Closing one costs its Bot
 * a relaunch and nothing else, the same as the cap.
 *
 * A check, not a guarantee. Between two checks a page can grow on its own, and memory can run out
 * before the next launch or the next minute comes round. What this removes is the computer filling
 * itself up one launch at a time with browsers nobody is using.
 *
 * Eighty-five leaves room for the launch that asked, and for a page that grows after the check,
 * before the limit is reached. Zero switches it off, as it does for the idle sweep. A computer with no
 * cgroup of its own (OpenBot Desktop's, on a person's Mac) has no limit to read and closes nothing
 * for memory either way. In the all-in-one image the share counts the database and the API server as
 * well, deliberately: the OOM kill counts them too, and a browser closed first is what keeps them up.
 */
const MEMORY_HIGH_PERCENT = numberFromEnv("COMPUTER_MEMORY_HIGH_PERCENT", 85, {
  zeroSwitchesItOff: true,
  max: 100,
});

/**
 * How long a Bot's background tab may sit untouched before the idle sweep closes it.
 *
 * A Bot is always on its newest page, so a tab it left behind (the page a sign-in popup opened from,
 * a link a site opened in a new tab) is one it cannot get back to, holding a renderer and its memory
 * for as long as the browser is up. Ten minutes is long enough for a popup's sign-in to come back to
 * the page that opened it, and a third of the thirty after which a whole idle browser is closed, so a
 * tab left behind in a browser that is still in use does not wait for the browser to go. See
 * `chooseIdleTabs` for what is never closed. Zero switches it off.
 *
 * No count of tabs alongside it. A count is the wrong measure for the same reason the browser cap is
 * not enough on its own: one heavy tab outweighs twenty light ones, and memory is now watched
 * directly. A count would also close tabs a site opened a moment ago, in the middle of the flow they
 * were opened for, where a timeout only ever closes what has been left alone.
 */
const TAB_IDLE_MS = numberFromEnv("COMPUTER_TAB_IDLE_MS", 10 * 60_000, {
  zeroSwitchesItOff: true,
});

/**
 * Told whenever a Bot's browser is closed and forgotten, before the close is waited on.
 *
 * Exists because closing a browser is not the whole of stopping a computer: anything still pointed
 * at the page it was showing has to be taken down with it, and the live screen's follow loop calls
 * back in for a page every second, which is a launch path. A viewer left running therefore relaunches
 * whatever was just closed, so a stopped computer restarts itself and an idle one never goes away.
 *
 * It is announced here rather than called from the two request handlers because a browser closes
 * from more places than those: the cap after a launch and the idle sweep close one without any
 * request being involved. Hanging the teardown off the close itself covers those by construction,
 * where remembering to add a call at each new handler does not.
 *
 * Awaited before the context closes, so a follow loop cannot squeeze a relaunch into the gap.
 */
export type BrowserClosed = (botId: string) => void | Promise<void>;

export type ProfilesOptions = {
  /**
   * How browsers start here. The computer's own, read from its environment, unless a test needs a
   * combination the environment refuses: a person's native browser launched headless, which is how
   * that launch is tested without opening a window on the machine running the tests.
   */
  runtime?: BrowserRuntime;
  /**
   * The display the person's desktop session had, captured before this process pointed `DISPLAY`
   * at its own Xvfb. A person's native window opens there. Defaults to this process's environment
   * as it is now.
   */
  personDisplay?: PersonDisplay;
  /**
   * The built Recorder (`OPENBOT_RECORDER_DIR`), read at every launch of a Bot's browser, so a rebuilt Recorder is the
   * one the next browser gets. Defaults to this process's environment as it is at that launch.
   */
  recorderDir?: () => string | undefined;
  /**
   * The computer's memory now, or nothing when it has no limit to read. The container's own cgroup
   * unless a test hands in the reading it wants the computer to see.
   */
  memory?: () => Promise<MemoryReading | undefined>;
  /** {@link MEMORY_HIGH_PERCENT}, for a test. */
  memoryHighPercent?: number;
  /** {@link TAB_IDLE_MS}, for a test that cannot wait ten minutes. */
  tabIdleMs?: number;
  /**
   * The clock every use, idle timeout and memory decision here is measured by. `Date.now` unless a
   * test needs a browser to have gone quiet a minute ago without waiting a minute for it.
   */
  now?: () => number;
  /**
   * Whether a person holds this Bot's wheel, or has been asked to take it. Such a browser is never
   * closed for memory, and none of its tabs are closed for being idle: a person may be working across
   * them. The computer's sessions answer it (`sessions.personHasTheWheel`); without it, nobody does.
   */
  heldByPerson?: (botId: string) => boolean;
};

/** Opening a person's browser, which is the one way it starts. See `person-browser.ts`. */
export type PersonOpen = { recorder: Recorder };

/**
 * The Recorder in a Bot's browser (`shared/bot-browser.ts`): loaded at every launch on a computer that has it, and
 * disconnected and silent until a person holding the wheel presses Record.
 */
export type BotRecorder = {
  /** The Recorder's id in this browser, which says which pages and which worker are its own. */
  recorderId: string;
  launcher: RecorderLauncher;
  /**
   * Why it cannot be used, when taking hold of it at launch failed. The Bot's browser carries on without it: a
   * Recorder that will not start is never a reason a Bot cannot work.
   */
  problem?: string;
};

/** A Bot's Recorder as this module holds it: with the browser-level session its launcher speaks over. */
type HeldRecorder = BotRecorder & { session: CDPSession };

/** A Bot's running browser, for the bar a person holding its wheel works (`bot-browser-host.ts`). */
export type OpenBotBrowser = {
  context: BrowserContext;
  /** Absent where this computer has no Recorder, or runs Bots in local Chrome. */
  recorder?: BotRecorder;
  /** The browser-level DevTools session, which the tab list reads titles from. */
  session(): Promise<CDPSession>;
  /** The page the Bot is on, which the live screen shows and the bar acts on. */
  active(): Page;
  /**
   * Put a tab in front for the Bot as well as on the screen: it stays the Bot's page until another tab opens or it
   * closes, so the Bot carries on where the person left it.
   */
  activate(page: Page): void;
  /** The Bot's tabs, oldest first, never the Recorder's own pages. */
  pages(): Page[];
  /**
   * Make the window hold exactly the page the live screen shows, from the first time a person switches its tabs (see
   * `fitWindowsToViewport`). Not at launch: a Bot's browser nobody works stays exactly as it launches.
   */
  fitWindows(): Promise<void>;
};

/** A person's open browser, for the browser routes. */
export type OpenPersonBrowser = PersonBrowser & {
  context: BrowserContext;
  /** The tab the person is on, which the live screen shows. */
  active(): Page;
  /** Put a tab in front: the one the live screen follows and the routes act on. */
  activate(page: Page): void;
  /** The person's tabs, oldest first, never the Recorder's own pages. */
  pages(): Page[];
};

export function createProfiles(
  root: string,
  onClosed: BrowserClosed,
  options: ProfilesOptions = {},
) {
  const runtime = options.runtime ?? BROWSER_RUNTIME;
  const local = runtime.backend === "local-chrome";
  const sandbox = sandboxFor(runtime);
  const launchArgs = launchArgsFor(local, sandbox);
  const personDisplay: PersonDisplay = options.personDisplay ?? {
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
  };
  const recorderDir =
    options.recorderDir ?? (() => process.env[RECORDER_DIR_ENV]);
  const readMemory = options.memory ?? (() => readContainerMemory());
  const memoryHighPercent = options.memoryHighPercent ?? MEMORY_HIGH_PERCENT;
  const tabIdleMs = options.tabIdleMs ?? TAB_IDLE_MS;
  const now = options.now ?? Date.now;
  const heldByPerson = options.heldByPerson ?? (() => false);
  /*
   * A wheel that cannot be read counts as held. The control state throws when its store has failed,
   * and the answer decides whether a browser or a tab is closed: keeping one is the mistake that
   * costs nothing, and a throw here must never fail the launch that asked.
   */
  const spared = (botId: string): boolean => {
    try {
      return heldByPerson(botId);
    } catch {
      return true;
    }
  };

  type LiveBrowser = {
    context: BrowserContext;
    page: Page;
    startedAt: string;
    /** When this Bot last asked for its page. Decides what the cap and the sweep close. */
    usedAt: number;
    /** Point `page` at whatever is open now. Called on every page opening and closing. */
    retarget: () => void;
    /** Keeps this browser's session cookies on the profile volume. Absent for a native Chrome. */
    sessionCookies?: SessionCookieKeeper;
    /** Present for a person's browser, which has the Recorder in it and no Bot acting in it. */
    person?: PersonBrowser;
    /** Present for a Bot's browser: what the bar a person holding its wheel works needs of it. */
    bot?: {
      recorder?: BotRecorder;
      /** Whether a page is one of the Bot's own, rather than one of the Recorder's. */
      own(page: Page): boolean;
      /** Put a page in front, and keep it there (see `OpenBotBrowser.activate`). */
      pin(page: Page): void;
      session(): Promise<CDPSession>;
      fitWindows(): Promise<void>;
    };
  };

  /**
   * Write a browser's session cookies one last time and stop checking them.
   *
   * Before the close, because a closed context has no cookies to read. Bounded like the
   * announcement, because a browser that will not answer must not hold a close open.
   */
  const keepSessionCookies = async (running: LiveBrowser): Promise<void> => {
    const keeper = running.sessionCookies;
    if (!keeper) return;
    await settleWithin(
      keeper.save().then(() => keeper.stop()),
      ANNOUNCE_BUDGET_MS,
    );
  };

  /** One running browser per Bot, up to {@link MAX_LIVE_BROWSERS}. */
  const live = new Map<string, LiveBrowser>();
  /** A person's native window: the idle sweep leaves it and the cap takes it last. See `keptOpen`. */
  const stays = keptOpen(personWindow(runtime));
  /**
   * When each of a Bot's tabs was last used: acted on, navigated, or in front. Decides which
   * background tabs the idle sweep closes. Weak, so a closed page takes its entry with it.
   */
  const tabUsedAt = new WeakMap<Page, number>();
  const touchTab = (page: Page): void => {
    tabUsedAt.set(page, now());
  };
  /** A tab never seen before counts as used now, so one this process missed is not closed at once. */
  const tabLastUsed = (page: Page): number => {
    const at = tabUsedAt.get(page) ?? now();
    tabUsedAt.set(page, at);
    return at;
  };
  /** A tab that navigates is in use, a background one included: a site moving it on, a sign-in finishing. */
  const touchOnNavigation = (page: Page): void => {
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) touchTab(page);
    });
  };
  /** Launches in flight, so a cold computer is started once however many callers ask at once. */
  const starting = new Map<string, Promise<Page>>();
  /** Closes and resets in flight, so a Bot's browser is never reopened from a profile being closed or deleted. */
  const closing = new Map<string, Promise<void>>();

  const whileClosing = async (
    botId: string,
    work: () => Promise<void>,
  ): Promise<void> => {
    const { promise: done, resolve } = Promise.withResolvers<void>();
    const held = Promise.all([closing.get(botId), done]).then(() => undefined);
    closing.set(botId, held);
    try {
      await work();
    } finally {
      resolve();
      void held.then(() => {
        if (closing.get(botId) === held) closing.delete(botId);
      });
    }
  };

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
  const evict = async (botId: string, reason: string): Promise<boolean> => {
    const running = live.get(botId);
    if (!running) return false;
    live.delete(botId);
    console.info(
      JSON.stringify({ type: "computer-browser-closed", botId, reason }),
    );
    // Before the close, so whatever was watching this browser is taken down while it is still the
    // browser being closed. A live screen surviving here relaunches it a second later.
    //
    // Bounded, because this now sits on the launch path: `enforceCap` evicts from inside another
    // Bot's launch, so a teardown that never answers would pin that launch and every caller waiting
    // on it. The close is the thing that must happen; being told about it is best effort.
    await whileClosing(botId, async () => {
      await settleWithin(Promise.resolve(onClosed(botId)), ANNOUNCE_BUDGET_MS);
      await keepSessionCookies(running);
      await closeAndWait(running.context).catch(() => undefined);
    });
    return true;
  };

  /**
   * Keep the number of running browsers under the cap.
   *
   * Least recently used first, which is the Bot that has been quiet longest. Called after a launch
   * rather than before, so the Bot that just asked is never the one closed.
   */
  const enforceCap = async (): Promise<void> => {
    for (const botId of chooseEvictions(
      live.entries(),
      MAX_LIVE_BROWSERS,
      stays,
    )) {
      await evict(botId, "the cap on running browsers was reached");
    }
  };

  /**
   * Close browsers, least recently used first, once the computer's memory runs high, until it is ten
   * points under the line.
   *
   * One at a time, reading memory again after each close, because what one browser was holding is
   * not known until it has gone. Starts at {@link MEMORY_HIGH_PERCENT} and goes on to
   * `memoryTargetPercent` under it, so the launch after it does not cross the line again at once.
   * Stops when memory is there, when nothing is left that may be closed (`chooseForMemory`: never
   * the browser launching, the most recently used, one in use within the last minute, one a person
   * holds the wheel of, or a person's own), or when the same browser comes up twice.
   */
  const relieveMemoryOnce = async (): Promise<void> => {
    if (memoryHighPercent <= 0) return;
    // A reading that fails is a computer with nothing to act on, the same as one with no cgroup.
    const read = () => readMemory().catch(() => undefined);
    let reading = await read();
    if (!reading || !memoryRunsHigh(reading, memoryHighPercent)) return;
    const target = memoryTargetPercent(memoryHighPercent);
    const tried = new Set<string>();
    while (reading && memoryAtOrAbove(reading, target)) {
      const next = chooseForMemory(live.entries(), now(), { spared });
      if (!next || tried.has(next)) return;
      tried.add(next);
      console.info(
        JSON.stringify({
          type: "computer-browser-closed-for-memory",
          botId: next,
          workingSetBytes: reading.workingSet,
          limitBytes: reading.limit,
        }),
      );
      await evict(next, "the computer's memory ran high");
      reading = await read();
    }
  };

  /**
   * One pass at a time, which every caller waits on.
   *
   * A burst of launches each ran a pass of its own, and each read memory before any close had given
   * any back: a browser's memory is released when its Chromium exits, seconds after it was taken out
   * of the map. So K launches at once read the same high number and closed K browsers where one was
   * enough. A launch that arrives while a pass is running waits for that pass and launches after it.
   */
  let relieving: Promise<void> | undefined;
  const relieveMemory = (): Promise<void> => {
    relieving ??= relieveMemoryOnce().finally(() => {
      relieving = undefined;
    });
    return relieving;
  };

  /**
   * Close the background tabs of every Bot's browser that nothing has touched for a while.
   *
   * Never a person's browser, whose tabs are theirs and which has no Bot in it, and never a Bot's
   * while a person holds its wheel, because they may be working across its tabs. Within a Bot's
   * browser, `chooseIdleTabs` decides, and the page the Bot is on is never one of them, so it is
   * still the newest open page afterwards and the record does not move. The address is not logged:
   * a page left behind can be a sign-in link with a one-time token in it.
   */
  const closeIdleTabs = async (): Promise<number> => {
    if (tabIdleMs <= 0) return 0;
    const sweptAt = now();
    let closed = 0;
    for (const [botId, running] of [...live.entries()]) {
      if (running.person || isPersonBrowserId(botId) || spared(botId)) continue;
      // Closed while an earlier Bot's tabs were being closed: nothing of it is left to sweep.
      if (live.get(botId) !== running) continue;
      running.retarget();
      const tabs = running.context
        .pages()
        .filter((page) => !page.isClosed())
        .map((page) => ({
          page,
          usedAt: tabLastUsed(page),
          front: page === running.page,
          kept:
            page.url().startsWith("chrome-extension://") ||
            page.url().startsWith("devtools://"),
        }));
      for (const { page } of chooseIdleTabs(tabs, tabIdleMs, sweptAt)) {
        console.info(
          JSON.stringify({
            type: "computer-tab-closed",
            botId,
            reason: "it had been idle",
          }),
        );
        await page.close().catch(() => undefined);
        closed += 1;
      }
    }
    return closed;
  };

  /**
   * Close browsers nothing has touched for a while, then the tabs Bots left behind, then, if memory
   * still runs high, browsers by use.
   *
   * The cap answers concurrent breadth; this answers a Bot used once last Tuesday whose browser is
   * still resident and doing nothing for anybody. In that order because each step is gentler than the
   * next: a browser nobody is using goes before a tab of one somebody is, and a tab nobody can reach
   * goes before a browser that is still in use.
   */
  const sweepIdle = async (): Promise<void> => {
    for (const botId of chooseIdle(
      live.entries(),
      IDLE_TIMEOUT_MS,
      now(),
      stays,
    )) {
      await evict(botId, "it had been idle");
    }
    const tabsClosed = await closeIdleTabs().catch(() => 0);
    // A closed tab's renderer exits a moment after the tab does, so memory read at once would still
    // count it, and a browser could be closed for memory the tabs had already given back.
    if (tabsClosed > 0)
      await new Promise((resolve) => setTimeout(resolve, CLOSE_SETTLE_MS));
    await relieveMemory();
  };

  const idleSweep = setInterval(() => {
    void sweepIdle().catch(() => undefined);
  }, IDLE_SWEEP_MS);
  // Housekeeping must not hold the process open on the way out.
  idleSweep.unref?.();

  /**
   * Close a browser a person asked to close, including one that is still starting.
   *
   * `evict` only knows about browsers already in `live`, and a launch does not land there until it
   * finishes. A request arriving inside that window therefore passed straight through: it answered
   * "nothing was running", the launch completed a moment later, and the browser the person asked to
   * close was up with the live screen still on it and the follow loop keeping it marked recently
   * used, so the idle sweep would not reclaim it either. Reset was worse, deleting the profile
   * directory that the finishing launch then recreated.
   *
   * So a request waits for the launch it is racing and closes what it produced. This is deliberately
   * NOT inside `evict`: the cap evicts from inside a launch, and an `evict` that waited on `starting`
   * could wait on the very launch it is running under.
   */
  const closeOnRequest = async (
    botId: string,
    reason: string,
  ): Promise<boolean> => {
    // Its failure is the launch's own to report; here it only means there is nothing left to close.
    await settleWithin(starting.get(botId), LAUNCH_WAIT_MS);
    return evict(botId, reason);
  };

  const sweepLocks = async (dir: string): Promise<void> => {
    await Promise.all(
      SINGLETON_FILES.map((name) =>
        rm(join(dir, name), { force: true }).catch(() => undefined),
      ),
    );
  };

  /*
   * Session cookies back before anything navigates, so the first request a site sees from this
   * launch is already signed in. Not for a native Chrome: its cookies are protected by the OS
   * keychain, and a plain file beside them would undo that. The container profile uses the
   * basic password store, so the file adds no exposure the volume did not already have.
   */
  const keepSessionCookiesFrom = async (
    botId: string,
    dir: string,
    context: BrowserContext,
  ): Promise<SessionCookieKeeper | undefined> => {
    if (local) return undefined;
    const sessionCookies = sessionCookieKeeper(botId, dir, context);
    await sessionCookies.restore().catch((error: unknown) => {
      console.info(
        JSON.stringify({
          type: "computer-session-cookies-not-restored",
          botId,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    sessionCookies.start();
    return sessionCookies;
  };

  /** The built Recorder a Bot's browser launches with, or none: none configured, or one that is not a built Recorder. */
  const recorderForBot = async (
    botId: string,
  ): Promise<Recorder | undefined> => {
    const configured = recorderDir();
    if (!configured?.trim()) return undefined;
    const found = await findRecorder(configured);
    if (found.ok) return found.recorder;
    console.info(
      JSON.stringify({
        type: "computer-bot-recorder-unavailable",
        botId,
        reason: found.error,
      }),
    );
    return undefined;
  };

  /**
   * Take hold of the Recorder a Bot's browser launched with, as a person's is held: its setup pages closed as they
   * appear, its launcher reached, its worker made to run the Recorder on disk. Before the Bot's first page is chosen,
   * so a setup page the launch or a reload opens has come and gone by then.
   *
   * Never fatal. A Recorder that will not start costs the Bot nothing: the browser runs on, the failure is said in the
   * log, and Record answers that this browser cannot record.
   */
  const holdBotRecorder = async (
    botId: string,
    context: BrowserContext,
    recorder: Recorder,
  ): Promise<HeldRecorder | undefined> => {
    const reason = (error: unknown) =>
      error instanceof Error ? error.message : String(error);
    let session: CDPSession;
    try {
      const browser = context.browser();
      if (!browser) throw new Error("The browser did not start.");
      session = await browser.newBrowserCDPSession();
    } catch (error) {
      console.info(
        JSON.stringify({
          type: "computer-bot-recorder-unavailable",
          botId,
          reason: reason(error),
        }),
      );
      return undefined;
    }
    // Loaded by flag, so its id is the one its manifest key fixes (`findRecorder`).
    const recorderId = recorder.id;
    const launcher = reachRecorder({ session, context, recorderId });
    try {
      await keepRecorderCurrent({
        session,
        launcher,
        recorder,
        recorderId,
        botId,
      });
      return { recorderId, launcher, session };
    } catch (error) {
      console.info(
        JSON.stringify({
          type: "computer-bot-recorder-unavailable",
          botId,
          reason: reason(error),
        }),
      );
      return { recorderId, launcher, session, problem: reason(error) };
    }
  };

  /**
   * A person's browser: the Recorder in it, their tabs, and the one they are on.
   *
   * The tab in front is kept rather than recomputed. A Bot's browser follows the newest page,
   * because a window a site opened is where the Bot's work went; a person moves between tabs, so
   * the one they put in front stays in front until they choose another, a new tab opens (which a
   * browser brings to the front), or it closes. The live screen follows whichever that is.
   *
   * It is closed when the person closes it. Quitting the browser ends the context, and closing the
   * last window ends it too: on macOS Chrome keeps running with no window, and a browser nobody can
   * see is one the person closed. A native window is not closed by the idle sweep, and goes last at
   * the cap; a cloud browser, which the person reaches only through the Browser page, closes when
   * nobody has touched it for as long as a Bot's would (`keptOpen`).
   *
   * A window is a window whatever it shows. One left on one of the Recorder's own pages (its
   * options, say) is still the person's browser on the screen: it is open, it is not closed under
   * them, and opening it again brings it forward rather than relaunching it. The Recorder's pages are
   * never put in front over a tab of the person's, but when they are all there is, the one in front
   * is one of them.
   */
  const launchPerson = async (
    botId: string,
    dir: string,
    open: PersonOpen,
  ): Promise<Page> => {
    const window = personWindow(runtime);
    const { context, person } = await launchPersonBrowser({
      botId,
      dir,
      runtime,
      recorder: open.recorder,
      // A hosted browser runs on OpenBot's network, so it goes through the egress filter like any
      // other browser here. A native window is the person's own browser on their own machine, and
      // reaches the network the way their everyday browser does.
      proxy: window === "screen" ? egressFor(botId, process.env) : null,
      sandbox,
      botArgs: launchArgs,
      viewport: VIEWPORT,
      display: personDisplay,
    });
    const sessionCookies = await keepSessionCookiesFrom(botId, dir, context);
    const { recorderId } = person;
    let page = personPages(context, recorderId).at(-1);
    try {
      page ??= await context.newPage();
      /*
       * What a hosted Bot's browser says about itself, said by the hosted person's browser too:
       * both are this computer's Chromium on its network, and a person's search or sign-in is
       * judged by the same signals. Without it a headless one sent `HeadlessChrome` in its user
       * agent and its client hints, and Google answered searches with its "unusual traffic" check
       * and refused sign-in as a browser that "may not be secure", from an address where Chrome was
       * fine. Before the person's first page loads, and for every tab as it opens. Read from one of
       * the person's own tabs first, because what the browser says is read once per browser from
       * a page, and the Recorder's setup page may be the other one there, closing. A native window
       * is the person's own browser, which says who it is already, as a local Bot's does. Never the
       * Web Bot Auth signature: that says the deployment's automated agent sent the request, and a
       * person browsing is not it.
       */
      if (window === "screen") {
        const network = { headless: runtime.mode === "headless" };
        await attachPageNetwork(context, page, network);
        await attachBrowserNetwork(context, { ...network, signs: false });
        for (const opened of context.pages())
          void attachPageNetwork(context, opened, network);
        context.on("page", (opened) => {
          void attachPageNetwork(context, opened, network);
        });
      }
    } catch (error) {
      // Not left running unrecorded: a browser that never made it into the map is closed here.
      await sessionCookies?.stop();
      await context.close().catch(() => undefined);
      throw error;
    }
    const record: LiveBrowser = {
      context,
      page,
      startedAt: new Date().toISOString(),
      usedAt: now(),
      retarget: () => {},
      ...(sessionCookies ? { sessionCookies } : {}),
      person,
    };
    const bringForward = (next: Page) => {
      if (next === record.page) return;
      record.page = next;
      // In front at once; said once the browser has stayed open with it in front.
      setTimeout(() => {
        if (live.get(botId) !== record || record.page !== next) return;
        if (next.isClosed() || !context.browser()?.isConnected()) return;
        console.info(
          JSON.stringify({
            type: "computer-page-changed",
            botId,
            url: next.url(),
          }),
        );
      }, PAGE_CHANGE_SETTLE_MS).unref();
    };
    record.retarget = () => {
      if (
        !record.page.isClosed() &&
        !isRecorderPage(record.page.url(), recorderId)
      )
        return;
      // The person's newest tab; failing that, while the one in front has closed, whatever window
      // is left.
      const next =
        personPages(context, recorderId).at(-1) ??
        (record.page.isClosed() ? windowPages(context).at(-1) : undefined);
      if (next) bringForward(next);
    };
    const closed = () => {
      // A browser being closed closes its tabs one by one, and none of them is a page change: a
      // close takes the browser out of `live` before it closes it.
      if (live.get(botId) !== record) return;
      record.retarget();
      if (windowPages(context).length === 0)
        void evict(botId, "its last window was closed");
    };
    const follow = (opened: Page) => {
      opened.on("close", closed);
      // A tab that becomes one of the Recorder's own pages is never the one in front.
      opened.on("framenavigated", (frame) => {
        if (frame === opened.mainFrame() && opened === record.page)
          record.retarget();
      });
    };
    for (const existing of context.pages()) follow(existing);
    context.on("page", (opened) => {
      follow(opened);
      if (!isRecorderPage(opened.url(), recorderId)) bringForward(opened);
    });
    context.on("close", () => {
      if (live.get(botId) === record) void evict(botId, "it was closed");
    });
    live.set(botId, record);
    await enforceCap();
    return record.page;
  };

  return {
    /**
     * The Bot's page, starting its browser if it is not running.
     *
     * Started on first use rather than at boot, and re-created if it died: a crashed Chromium would
     * otherwise leave this process alive and answering the same error for every request until the
     * container restarts. This turns that into one slow request instead of an outage.
     */
    async page(
      botId: string,
      request: { open?: PersonOpen } = {},
    ): Promise<Page> {
      // Only when something is closing: an unconditional await would let a stop slip in ahead of the launch.
      const closingNow = closing.get(botId);
      if (closingNow) await closingNow;
      /*
       * One launch at a time per Bot. Calls that arrive during a launch wait for that launch instead
       * of starting another browser against the same profile directory.
       */
      const launching = starting.get(botId);
      if (launching) return launching;

      const existing = live.get(botId);
      // Asked before the page is judged, so a close that has not been delivered yet does not read as
      // a browser that has gone.
      existing?.retarget();
      // A person's browser whose one window shows a Recorder page is open like any other (see
      // `launchPerson`), so the page in front is judged only by whether it is still there.
      if (
        existing?.context.browser()?.isConnected() &&
        !existing.page.isClosed()
      ) {
        // Touched on every use, which is what makes "least recently used" mean anything. The page in
        // front with it: a Bot's next action, and a person's input on the live screen, land there.
        existing.usedAt = now();
        touchTab(existing.page);
        return existing.page;
      }
      if (existing) {
        // Half-dead: the browser went away, or its page did. Dropped rather than repaired, because a
        // context whose browser has gone is not usable for anything.
        //
        // The one close that does not announce itself, deliberately. A replacement is launched on the
        // next line and the live screen's follow loop re-attaches to it within the second, so this is
        // a browser being swapped rather than one going away. Telling the viewer here would end a
        // screen that is about to be fine, which is the opposite of what the announcement is for.
        await existing.sessionCookies?.stop();
        await existing.context.close().catch(() => undefined);
        live.delete(botId);
      }
      /*
       * A person's browser starts only when they open it. Anything else asking for its page (the
       * live screen's follow loop, a person's input arriving late) finds it closed and says so,
       * rather than opening a window on somebody's desktop they have just closed.
       */
      const { open } = request;
      if (isPersonBrowserId(botId) && !open) throw new BrowserNotOpenError();

      const launch = (async () => {
        // Before the launch, which is when memory jumps: a cold Chromium and its first page are the
        // largest single step up a computer takes, and the OOM killer does not wait for the cap.
        await relieveMemory();
        const dir = directoryFor(botId);
        // A second native helper can target the same data root on another port. Do not remove an
        // active Chrome profile's lock; Chrome reports contention and handles its own stale locks.
        if (!local) {
          await sweepLocks(dir);
          await keepWebRtcInsideProxy(dir);
        }
        if (open && isPersonBrowserId(botId))
          return launchPerson(botId, dir, open);
        // The Bot's own proxy and policy, whoever's seat this is: a seat is a Bot's place on this
        // computer (see `seatIdFor`), and what it may reach is decided per Bot.
        const proxy = egressFor(seatParts(botId).botId, process.env);
        // The Recorder, where this computer has one. Never in local Chrome, whose Bot browser is a window on the
        // person's own desktop, and absent the Bot's browser launches exactly as it always has.
        const recorder = local ? undefined : await recorderForBot(botId);
        const headless = runtime.mode === "headless";
        const context = await chromium.launchPersistentContext(dir, {
          channel: runtime.channel,
          ...(recorder
            ? // A Bot's launch with the Recorder let in, as the hosted person's browser launches.
              recorderLaunchOptions(
                {
                  recorderDir: recorder.dir,
                  headless,
                  sandbox,
                  botArgs: launchArgs,
                },
                VIEWPORT,
              )
            : {
                headless,
                args: launchArgs,
                // Playwright launches with `--enable-automation`, which sets `navigator.webdriver` and the
                // "controlled by automated software" banner. Dropped for the same reason as the flag above:
                // a person who takes the wheel should be able to sign in. Named explicitly so the sandbox
                // default args Playwright still supplies are otherwise left intact.
                ignoreDefaultArgs: ["--enable-automation"],
                // Playwright adds `--no-sandbox` on its own unless told otherwise, so leaving this out
                // means the flag above decides nothing and a deployment that asked for the sandbox does
                // not get one. Verified by reading the launched process arguments, not by trusting either.
                chromiumSandbox: sandbox,
                viewport: VIEWPORT,
              }),
          // This process owns shutdown. Playwright's signal handlers kill Chromium immediately on
          // SIGTERM, before pending cookie writes have time to flush.
          handleSIGTERM: false,
          handleSIGINT: false,
          handleSIGHUP: false,
          ...(proxy ? { proxy } : {}),
        });
        const held = recorder
          ? await holdBotRecorder(botId, context, recorder)
          : undefined;
        const recorderId = recorder?.id;
        /*
         * A Bot's page is never one of the Recorder's own. The Recorder opens its setup page each time a launch
         * installs it, and that page closes the moment it shows (`holdRecorder`), but until then it is the newest
         * page, which the Bot would otherwise have followed as a window the site opened.
         */
        const own = (opened: Page) =>
          recorderId === undefined || !isRecorderPage(opened.url(), recorderId);
        const sessionCookies = await keepSessionCookiesFrom(
          botId,
          dir,
          context,
        );
        // Persistent contexts open with a page already; reuse it rather than leaving an extra blank tab.
        const page =
          context.pages().filter(own)[0] ?? (await context.newPage());
        /*
         * The user agent fix and the Web Bot Auth signature, before the first navigation so the first
         * request a site sees already carries both. Not for a native Chrome: that is the person's own
         * browser, which says who it is already and should not announce a deployment on their behalf.
         */
        const network = { headless };
        if (!local) {
          await attachBrowserNetwork(context, network);
          await attachPageNetwork(context, page, network);
        }
        /*
         * The tab a person holding the wheel put in front with the bar. It stays the Bot's page until another tab
         * opens (a browser brings a new tab to the front) or it closes, so the Bot carries on in the tab the person
         * left in front. Without one, the Bot follows the newest page, as it always has.
         */
        let pinned: Page | undefined;
        let browserSession: Promise<CDPSession> | undefined;
        let fitted: Promise<void> | undefined;
        const record: LiveBrowser = {
          context,
          page,
          startedAt: new Date().toISOString(),
          usedAt: now(),
          retarget: () => {},
          ...(sessionCookies ? { sessionCookies } : {}),
          bot: {
            ...(held ? { recorder: held } : {}),
            own,
            pin: (chosen: Page) => {
              pinned = chosen;
              record.retarget();
            },
            // The Recorder's session when there is one, which the launcher already holds; otherwise one opened the
            // first time the bar asks, so a Bot nobody works the bar of opens none.
            session: () => {
              browserSession ??= held
                ? Promise.resolve(held.session)
                : (async () => {
                    const browser = context.browser();
                    if (!browser) throw new BrowserNotOpenError();
                    return browser.newBrowserCDPSession();
                  })();
              return browserSession;
            },
            // A window on the person's own desktop (local Chrome) is theirs to size.
            fitWindows: () => {
              if (local) return Promise.resolve();
              fitted ??= fitWindowsToViewport(context, VIEWPORT, botId);
              return fitted;
            },
          },
        };
        touchTab(page);
        touchOnNavigation(page);
        record.retarget = () => {
          const next =
            pinned && !pinned.isClosed() && own(pinned)
              ? pinned
              : chooseLivePage(context.pages().filter(own));
          if (!next || next === record.page) return;
          // Both are in use at this moment: the one going behind was in front until now.
          touchTab(record.page);
          touchTab(next);
          record.page = next;
          console.info(
            JSON.stringify({
              type: "computer-page-changed",
              botId,
              url: next.url(),
            }),
          );
        };
        /*
         * A page that closes while the browser stays open moves the record on. One closing because the
         * browser is being closed (out of `live` already) moves nothing: it is not a page change, and
         * saying so for every tab as it went only filled the log.
         */
        const closed = () => {
          if (live.get(botId) === record) record.retarget();
        };
        // A tab that turns out to be one of the Recorder's own (it can report the blank page it started on when it
        // opens) is never the Bot's page.
        const watchForRecorderPages = (opened: Page) => {
          if (recorderId === undefined) return;
          opened.on("framenavigated", (frame) => {
            if (frame === opened.mainFrame() && opened === record.page)
              record.retarget();
          });
        };
        watchForRecorderPages(page);
        // Without this the Bot stays pinned to the page it launched with, so a sign-in the site opens
        // in a new window is neither shown to the person taking the wheel nor reachable by input.
        context.on("page", (opened) => {
          if (!local) void attachPageNetwork(context, opened, network);
          if (own(opened)) pinned = undefined;
          touchTab(opened);
          touchOnNavigation(opened);
          record.retarget();
          watchForRecorderPages(opened);
          // A popup closes itself when it succeeds, and the record must move back to the opener
          // rather than leave a closed page to be read as a dead browser.
          opened.on("close", closed);
        });
        page.on("close", closed);
        live.set(botId, record);
        // After the new one is in the map, so the cap counts what is really running and the Bot that
        // just asked is the most recently used and therefore never the one closed.
        await enforceCap();
        // Not `page`: a window opened while the browser was starting is already the live one.
        return record.page;
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
     * Stop this Bot's browser, keeping what it knows.
     *
     * The same close the cap and the idle sweep make, so it goes through the same path rather than
     * repeating it: a request is one more reason a browser closes, not a different kind of closing,
     * and anything watching has to come down either way. `reason` is what the close is logged with,
     * when the caller knows better than "it was stopped".
     */
    async stop(botId: string, reason = "it was stopped"): Promise<boolean> {
      return closeOnRequest(botId, reason);
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
      // Its own reason rather than borrowing stop's, so the trail says which of the two happened.
      await whileClosing(botId, async () => {
        await closeOnRequest(botId, "it was reset");
        await rm(directoryFor(botId), { recursive: true, force: true });
      });
    },

    /**
     * Give a person the profile their private Bot had before seats were per person. See carry-over.ts.
     *
     * Held as a close of the seat, so a request for it cannot launch a browser on a directory that is
     * half way through arriving.
     */
    async carryOver(botId: string, seatId: string): Promise<CarryOverOutcome> {
      let outcome: CarryOverOutcome = "absent";
      await whileClosing(seatId, async () => {
        outcome = await carryOverProfile(root, botId, seatId, () =>
          closeOnRequest(
            botId,
            "its profile moved to the person it belongs to",
          ),
        );
      });
      return outcome;
    },

    /**
     * Wipe this browser's data, at the request of the person working it (`shared/bot-browser.ts`, CLEARING A BROWSER):
     * closed, its whole profile deleted, and nothing recreated, as `reset` does to the profile.
     *
     * NOT A CLOSE ANYTHING WATCHING IS TOLD OF. Every other close announces itself (`onClosed`), which ends the live
     * screen and hands the wheel back to the Bot, because a browser that went from under a person is a restart they
     * have to look at again. This one is the person's own doing, and the browser is about to start again under them,
     * as the half-dead browser `page` drops is swapped: the live screen's follow loop finds the fresh one within the
     * second, and the wheel stays where it is. `forget` is told after the close and before anything can start the
     * browser again, so the computer forgets the browser it described (its run, its page) before the fresh one is
     * seen. Whatever has to happen while the browser can still be told (a recording ending) is the caller's, first.
     *
     * Its session cookies are not written on the way out: they are part of what goes. Answers whether a browser was
     * running.
     */
    async clear(botId: string, forget: () => void): Promise<boolean> {
      let wasRunning = false;
      await whileClosing(botId, async () => {
        // A launch it is racing finishes first, and is closed with the rest, as a reset closes it.
        await settleWithin(starting.get(botId), LAUNCH_WAIT_MS);
        const running = live.get(botId);
        if (running) {
          wasRunning = true;
          live.delete(botId);
          console.info(
            JSON.stringify({
              type: "computer-browser-closed",
              botId,
              reason: "its data was cleared",
            }),
          );
          await running.sessionCookies?.stop();
          await closeAndWait(running.context);
        }
        forget();
        await rm(directoryFor(botId), { recursive: true, force: true });
      });
      return wasRunning;
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
      return [...new Set([...seatIdsIn(onDisk), ...live.keys()])].sort();
    },

    /** What the admin surface lists. Running or not, because a Bot that has a profile has a computer. */
    summary(botIds: string[]): ProfileSummary[] {
      const known = new Set([...botIds, ...live.keys()]);
      return [...known].sort().map((seat) => {
        const running = live.get(seat);
        const { botId, personId } = seatParts(seat);
        return {
          seat,
          botId,
          ...(personId ? { personId } : {}),
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
      const entries = [...live.entries()];
      live.clear();
      // Told for each, the same as any other close. On the way out it changes nothing that survives,
      // but a viewer whose socket outlives this by a moment is still owed the message.
      await Promise.all(
        entries.map(([botId]) =>
          settleWithin(Promise.resolve(onClosed(botId)), ANNOUNCE_BUDGET_MS),
        ),
      );
      // Written before the close, so a pod deleted by a suspend or an image update keeps its sign-ins.
      await Promise.all(entries.map(([, c]) => keepSessionCookies(c)));
      await Promise.all(entries.map(([, c]) => closeAndWait(c.context)));
    },

    /** How many browsers are running. For the idle sweep's own tests, and for a status reader. */
    liveCount(): number {
      return live.size;
    },

    /** Whether this Bot has a browser right now, so a caller can drop state that belongs to one. */
    isLive(botId: string): boolean {
      return live.has(botId);
    },

    /**
     * A person's browser when it is open, touched like any page request so the cap sees it in use.
     * Undefined when it is closed, still starting, or has no window left. A window showing only one
     * of the Recorder's own pages is open: its tab list is then empty, and the page in front is that
     * Recorder page.
     */
    person(botId: string): OpenPersonBrowser | undefined {
      const running = live.get(botId);
      const person = running?.person;
      if (!running || !person) return undefined;
      if (!running.context.browser()?.isConnected()) return undefined;
      running.retarget();
      const pages = () => personPages(running.context, person.recorderId);
      if (!windowPages(running.context).includes(running.page))
        return undefined;
      running.usedAt = now();
      return {
        ...person,
        context: running.context,
        active: () => {
          running.retarget();
          return running.page;
        },
        activate: (page: Page) => {
          running.page = page;
        },
        pages,
      };
    },

    /**
     * A Bot's browser when it is running, for the bar. Never starts it, and does not count as a use: the app reads the
     * bar's state while the Bot's screen is open, and that alone must not keep an idle browser from being closed.
     */
    bot(botId: string): OpenBotBrowser | undefined {
      const running = live.get(botId);
      const bot = running?.bot;
      if (!running || !bot) return undefined;
      if (!running.context.browser()?.isConnected()) return undefined;
      running.retarget();
      if (running.page.isClosed()) return undefined;
      return {
        context: running.context,
        ...(bot.recorder ? { recorder: bot.recorder } : {}),
        session: bot.session,
        active: () => {
          running.retarget();
          return running.page;
        },
        activate: bot.pin,
        pages: () =>
          running.context
            .pages()
            .filter((page) => !page.isClosed() && bot.own(page)),
        fitWindows: bot.fitWindows,
      };
    },

    /** Run the idle sweep now. Exposed so a test does not have to wait a minute for the interval. */
    sweepIdleNow(): Promise<void> {
      return sweepIdle();
    },
  };
}

export type Profiles = ReturnType<typeof createProfiles>;
