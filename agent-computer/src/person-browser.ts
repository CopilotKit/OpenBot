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
  personNativeLaunch,
  personWindow,
  recorderLaunchOptions,
} from "./person-launch";
import { isRecorderPage, type Recorder } from "./recorder";
import { fitWindowsToViewport, holdRecorder } from "./recorder-in-browser";
import type { RecorderLauncher } from "./recorder-launcher";

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
          ...recorderLaunchOptions(
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
    const launcher = await holdRecorder({
      session,
      context,
      recorder: input.recorder,
      recorderId,
      botId: input.botId,
      step,
    });
    if (window === "screen")
      void fitWindowsToViewport(context, input.viewport, input.botId);
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
