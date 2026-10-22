/**
 * Launching a person's browser with the Recorder in it.
 *
 * One browser per person, a computer named for them (`person-` and 32 hex digits). On OpenBot
 * Desktop it is the person's installed Chrome, or Edge, as a native window on a dedicated OpenBot
 * profile; hosted, it is this computer's bundled Chromium, which the person sees through the live
 * screen. Either way the Recorder is in it before anybody looks, its microphone is granted, and
 * none of its setup pages show: `person-launch.ts` has the switches and why, this file starts the
 * browser and puts the Recorder in.
 *
 * Proven on real browsers before this was written (2026-10-21):
 *   - Bundled Chromium loads the Recorder from `--load-extension` with `--disable-extensions-except`.
 *   - Branded Chrome ignores `--load-extension` since Chrome 137, and installs it through DevTools
 *     `Extensions.loadUnpacked` on a browser-level session, when launched with
 *     `--enable-unsafe-extension-debugging` and without Playwright's `--disable-extensions`. With that
 *     switch still on the command line the call answers an id and the extension is silently absent.
 *     Edge accepts both routes.
 *   - An extension loaded through DevTools is gone after a restart, so it is loaded at every launch;
 *     its `chrome.storage.local` survives, so the Recorder keeps what it stored.
 *   - `Browser.grantPermissions` with the extension's origin grants it the microphone without a
 *     prompt, in Chrome and in Chromium.
 * https://playwright.dev/docs/chrome-extensions
 * https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-loadUnpacked
 * https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-grantPermissions
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from "playwright";
import type {
  BrowserProduct,
  BrowserWindow,
} from "../../shared/openbot-browser";
import type { BrowserRuntime } from "./browser-runtime";
import type { Egress } from "./egress";
import { launchNativeBrowser } from "./native-browser";
import {
  copyNativeMessagingHosts,
  defaultNativeMessagingHosts,
  forgetRecorderPins,
  installedBrowserAt,
  NO_INSTALLED_BROWSER,
  type PersonDisplay,
  personLaunchOptions,
  personNativeLaunch,
  personWindow,
} from "./person-launch";
import { isRecorderPage, isRecorderSetupPage, type Recorder } from "./recorder";
import {
  createRecorderLauncher,
  type RecorderLauncher,
} from "./recorder-launcher";

/** No Chrome and no Edge on this machine: nothing to open a person's window in. */
export class NoInstalledBrowserError extends Error {
  constructor() {
    super(NO_INSTALLED_BROWSER);
    this.name = "NoInstalledBrowserError";
  }
}

/**
 * The steps of opening a person's browser, in the order they run. A failed open names the one it
 * stopped at, because the same sentence ("the Recorder did not answer in time") can come from waking
 * its worker, reloading it or connecting it, and each has a different cause.
 */
export type PersonOpenStep =
  /** The built Recorder this computer is configured with. */
  | "recorder-files"
  /** Copying the person's native messaging hosts into the profile (`copyNativeMessagingHosts`). */
  | "native-hosts"
  /** Finding and starting the browser, and opening its first tab. */
  | "launch"
  /** Installing the Recorder over DevTools, which a native window needs at every launch. */
  | "recorder-load"
  /** Reaching the Recorder's service worker, waking it when it is asleep. */
  | "worker"
  /** Loading the Recorder again because its worker ran an earlier build (`keepRecorderCurrent`). */
  | "recorder-reload"
  /** Granting the Recorder the microphone. */
  | "microphone"
  /** Handing downloads back to the browser's own setting. */
  | "downloads"
  /** Handing the Recorder its connection through the launcher API. */
  | "connect"
  /** Reading the open browser's tabs and the Recorder's report, which the open answers with. */
  | "state";

/**
 * Playwright's own words for a browser this computer cannot start at all: the browser it bundles is not installed
 * (`playwright install`), the system libraries it needs are missing (`playwright install-deps`), or the installed browser
 * a launch named is not there. These are the computer's setup, which only whoever runs OpenBot can see to, never anything
 * the person did. Matched on playwright-core 1.62.1's messages (its browser registry and its dependency check), which
 * `person-browser-rules.test.ts` pins against the real text, so a Playwright that words them differently fails there.
 */
const BROWSER_NOT_INSTALLED = [
  /Executable doesn't exist at /,
  /Host system is missing dependencies/,
  /Chromium distribution '[^']+' is not found at /,
];

/** Whether a launch failed because this computer's browser is not installed, by Playwright's message. */
export function isBrowserNotInstalled(message: string): boolean {
  return BROWSER_NOT_INSTALLED.some((pattern) => pattern.test(message));
}

/**
 * Opening a person's browser failed at `step`, for the reason its message gives. `setup` when the reason is this
 * computer's setup rather than anything about this open: the built Recorder's files unreadable, or a browser that is not
 * installed or cannot run here. The routes answer those 503, which the server tells the person is for an admin.
 */
export class PersonOpenError extends Error {
  readonly step: PersonOpenStep;
  readonly setup: boolean;
  constructor(step: PersonOpenStep, cause: unknown, setup?: boolean) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, { cause });
    this.name = "PersonOpenError";
    this.step = step;
    this.setup =
      setup ?? (step === "recorder-files" || isBrowserNotInstalled(message));
  }
}

/** Run one step of an open, so a failure says which step it was. A failure already named keeps its name. */
async function step<T>(
  name: PersonOpenStep,
  work: () => Promise<T>,
  setup?: boolean,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PersonOpenError) throw error;
    throw new PersonOpenError(name, error, setup);
  }
}

/** What a person's running browser is, beyond what any browser here is. */
export type PersonBrowser = {
  product: BrowserProduct;
  window: BrowserWindow;
  /** The Recorder's id in this browser, which says which pages and which worker are its own. */
  recorderId: string;
  launcher: RecorderLauncher;
  /** The browser-level DevTools session, which the tab list reads titles from. */
  session: CDPSession;
};

export type PersonLaunch = {
  botId: string;
  /** The profile directory, which is also the browser's user data directory. */
  dir: string;
  runtime: BrowserRuntime;
  recorder: Recorder;
  /** The egress filter for a hosted browser. A native window has none: it is the person's own. */
  proxy: Egress | null;
  sandbox: boolean;
  botArgs: readonly string[];
  viewport: { width: number; height: number };
  /** The person's own display, which a native window opens on. See `personBrowserEnv`. */
  display: PersonDisplay;
};

/**
 * Every page in the browser's windows: the person's tabs and any of the Recorder's own pages a tab
 * shows (its options, say), but not DevTools. The Recorder's offscreen document is not one: Chromium
 * reports it as a background page, which Playwright does not count among the context's pages.
 *
 * A person's browser is open while there is any: a window on the screen is an open browser, whatever
 * it shows.
 */
export function windowPages(context: BrowserContext): Page[] {
  return context
    .pages()
    .filter(
      (page) => !page.isClosed() && !page.url().startsWith("devtools://"),
    );
}

/** The person's pages: page targets that are not the Recorder's own and not DevTools. */
export function personPages(
  context: BrowserContext,
  recorderId: string,
): Page[] {
  return context
    .pages()
    .filter(
      (page) =>
        !page.isClosed() &&
        !isRecorderPage(page.url(), recorderId) &&
        !page.url().startsWith("devtools://"),
    );
}

/**
 * Close the Recorder's setup and connect pages whenever one appears, for the life of the browser.
 *
 * The Recorder opens its setup page when it is installed, and every launch installs it afresh, so
 * this is not a one-off at start. The url a new tab reports can still be the blank one it started
 * on, so each page is checked again as it navigates.
 */
function closeRecorderSetupPages(context: BrowserContext, recorderId: string) {
  const check = (page: Page) => {
    if (isRecorderSetupPage(page.url(), recorderId))
      void page.close().catch(() => undefined);
  };
  const watch = (page: Page) => {
    check(page);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) check(page);
    });
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
}

/**
 * Make a hosted browser's window hold exactly the page the live screen shows, as each tab opens.
 *
 * Playwright sizes the window to the viewport with its own allowance for the browser's toolbars, and
 * that allowance is none when headless, though headless Chromium lays its toolbars out all the same
 * (87 pixels here). The page is told it is 800 high, and a tab that has been laid out again (switched
 * away from and back, say) is then shown in what is left of the window: the live screen lost the
 * bottom of the page, 713 of 800, while the page's own viewport still said 800. Measured on bundled
 * Chromium, headless, with Playwright 1.62.1. `Browser.setContentsSize` grows the window around the
 * contents, so the toolbars come out of the window and not the page, headed or headless. After
 * Playwright's own resize, which it makes as each tab starts and then leaves alone.
 * https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setContentsSize
 */
function fitWindowsToViewport(
  context: BrowserContext,
  viewport: { width: number; height: number },
  botId: string,
) {
  const fit = async (page: Page) => {
    const session = await context.newCDPSession(page);
    try {
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setContentsSize", { windowId, ...viewport });
    } finally {
      await session.detach().catch(() => undefined);
    }
  };
  const fitting = (page: Page) =>
    void fit(page).catch((error: unknown) => {
      // A tab that closed while it was being fitted needs nothing; anything else is said, because
      // the live screen then shows less than the whole page.
      if (page.isClosed()) return;
      console.info(
        JSON.stringify({
          type: "computer-window-not-fitted",
          botId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  for (const page of context.pages()) fitting(page);
  context.on("page", fitting);
}

/**
 * Make the Recorder's worker run the Recorder on disk, loading it again when it runs an earlier one.
 *
 * WHY. A browser keeps an extension's service worker registered in the profile, its scripts cached
 * in `Service Worker/ScriptCache`, from one run to the next: closing the browser unloads nothing.
 * Loaded at the next start, by `--load-extension` or DevTools `Extensions.loadUnpacked`, the Recorder
 * is installed as if new rather than updated, so nothing unregisters that worker; registering the
 * same script again is, by the service worker rules, the registration already there; and the
 * browser's own update check never runs for an extension's worker. So a profile kept running the
 * Recorder it first cached, whatever had been built since: every Recorder fix was invisible in a
 * browser that had run an earlier one, and an update of OpenBot would never have updated it.
 * Measured on Google Chrome 156 and Playwright's Chromium, for a changed script and for a changed
 * manifest version alike, which makes no difference. Loading the Recorder again while it is loaded
 * is an update, and an update unregisters the worker and registers the one on disk: measured the
 * same way, the new script then runs, and keeps running at later launches.
 *
 * Compared byte for byte, as a service worker's own update check compares, so a browser already
 * running the Recorder on disk is left alone and its worker is not restarted.
 * https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/service_worker/service_worker_task_queue.cc
 * https://chromium.googlesource.com/chromium/src/+/main/content/browser/service_worker/service_worker_register_job.cc
 * https://w3c.github.io/ServiceWorker/#register-algorithm
 * https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-loadUnpacked
 */
async function keepRecorderCurrent(input: {
  session: CDPSession;
  launcher: RecorderLauncher;
  recorder: Recorder;
  recorderId: string;
  botId: string;
}): Promise<void> {
  const { recorder, launcher } = input;
  const built = await step("recorder-files", () =>
    readFile(join(recorder.dir, recorder.worker), "utf8"),
  );
  const url = `chrome-extension://${input.recorderId}/${recorder.worker}`;
  // The first call to the worker since the launch: it finds it, and wakes it if it has not started.
  if ((await step("worker", () => launcher.workerSource(url))) === built)
    return;
  console.info(
    JSON.stringify({
      type: "computer-recorder-reloaded",
      botId: input.botId,
      reason:
        "Its service worker ran an earlier build than the Recorder on disk.",
    }),
  );
  await step("recorder-reload", async () => {
    await input.session.send("Extensions.loadUnpacked", { path: recorder.dir });
    if ((await launcher.workerSource(url)) !== built)
      throw new Error(
        "The Recorder in this browser runs an earlier build, and loading the current one did not replace it.",
      );
  });
}

/**
 * Start a person's browser, with the Recorder loaded and its microphone granted.
 *
 * All or nothing: a browser whose Recorder could not be put in is closed again rather than handed
 * back, because a person's browser without the Recorder is the one thing this must never open.
 *
 * A failure is a `PersonOpenError` naming the step it stopped at, and whether it is this computer's
 * setup, except that no installed browser is a `NoInstalledBrowserError`, which the routes answer
 * differently.
 */
export async function launchPersonBrowser(
  input: PersonLaunch,
): Promise<{ context: BrowserContext; person: PersonBrowser }> {
  const window = personWindow(input.runtime);
  let product: BrowserProduct = "chromium";
  let executable: string | undefined;
  if (window === "native") {
    // Looking for Chrome or Edge fails only on a platform with no place to look, or a folder this computer cannot read.
    const installed = await step(
      "launch",
      () => installedBrowserAt(process.env),
      true,
    );
    if (!installed) throw new NoInstalledBrowserError();
    product = installed.browser;
    executable = installed.executable;
    /*
     * The person's password manager and other desktop hookups, copied from their own profile of the
     * same browser into this profile's folder, which is where a browser on a dedicated user data
     * directory reads them. Manifests only, at every launch. Windows reads them from the registry.
     */
    const from = defaultNativeMessagingHosts(installed.browser, process.env);
    if (from) {
      const copied = await step("native-hosts", () =>
        copyNativeMessagingHosts(from, join(input.dir, "NativeMessagingHosts")),
      );
      console.info(
        JSON.stringify({
          type: "computer-person-native-hosts",
          botId: input.botId,
          hosts: copied,
        }),
      );
    }
  }

  await step("launch", () => forgetRecorderPins(input.dir, input.recorder.id));
  const headless = input.runtime.mode === "headless";
  /*
   * A native window is started here and attached to, with none of Playwright's test defaults and none
   * of its focus emulation (`native-browser.ts`): its tabs behind the one in front are behind it, as
   * in any browser. The hosted browser is Playwright's launch, as a Bot's is.
   */
  const context = await step("launch", () =>
    executable
      ? launchNativeBrowser({
          executable,
          ...personNativeLaunch({
            dir: input.dir,
            headless,
            display: input.display,
          }),
        })
      : chromium.launchPersistentContext(input.dir, {
          channel: product,
          ...personLaunchOptions(
            {
              recorderDir: input.recorder.dir,
              headless,
              sandbox: input.sandbox,
              botArgs: input.botArgs,
            },
            input.viewport,
          ),
          // This process owns shutdown, as for a Bot's browser: Playwright's own handlers would kill
          // the browser before its profile is written.
          handleSIGTERM: false,
          handleSIGINT: false,
          handleSIGHUP: false,
          ...(input.proxy ? { proxy: input.proxy } : {}),
        }),
  );

  try {
    const session = await step("launch", async () => {
      const browser = context.browser();
      if (!browser) throw new Error("The browser did not start.");
      return browser.newBrowserCDPSession();
    });
    let recorderId = input.recorder.id;
    if (window === "native") {
      const { id } = await step("recorder-load", () =>
        session.send("Extensions.loadUnpacked", { path: input.recorder.dir }),
      );
      if (id !== recorderId) {
        // The browser's answer is the truth about which pages and worker are the Recorder's. The
        // manifest key decides it in every Chromium, so a difference is worth saying out loud.
        console.info(
          JSON.stringify({
            type: "computer-recorder-id-differs",
            expected: recorderId,
            loaded: id,
          }),
        );
        recorderId = id;
      }
    }
    closeRecorderSetupPages(context, recorderId);
    const launcher = createRecorderLauncher({ session, context, recorderId });
    await keepRecorderCurrent({
      session,
      launcher,
      recorder: input.recorder,
      recorderId,
      botId: input.botId,
    });
    if (window === "screen")
      fitWindowsToViewport(context, input.viewport, input.botId);
    // Narration in a native window is the Recorder hearing the person, and it asks nobody first.
    // The hosted browser has no microphone; the grant costs nothing there and keeps one launch.
    await step("microphone", () =>
      session.send("Browser.grantPermissions", {
        origin: `chrome-extension://${recorderId}`,
        permissions: ["audioCapture"],
      }),
    );
    if (window === "native") {
      /*
       * Downloads where the person's browser puts them. A browser Playwright launches sends every
       * download to a temporary folder of its own under a random name and deletes it when the
       * browser closes, which is right for a test and loses a person's files. Attached with
       * `noDefaults`, Playwright leaves downloads alone; they are handed back here all the same, so
       * no change in Playwright's defaults can take a person's files. The browser's own behaviour is
       * the Downloads folder its settings name.
       */
      await step("downloads", () =>
        session.send("Browser.setDownloadBehavior", { behavior: "default" }),
      );
    }
    return {
      context,
      person: { product, window, recorderId, launcher, session },
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}
