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
import {
  copyNativeMessagingHosts,
  defaultNativeMessagingHosts,
  installedBrowser,
  NO_INSTALLED_BROWSER,
  type PersonDisplay,
  personLaunchOptions,
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
 * Start a person's browser, with the Recorder loaded and its microphone granted.
 *
 * All or nothing: a browser whose Recorder could not be put in is closed again rather than handed
 * back, because a person's browser without the Recorder is the one thing this must never open.
 */
export async function launchPersonBrowser(
  input: PersonLaunch,
): Promise<{ context: BrowserContext; person: PersonBrowser }> {
  const window = personWindow(input.runtime);
  let product: BrowserProduct = "chromium";
  if (window === "native") {
    const installed = await installedBrowser(process.env);
    if (!installed) throw new NoInstalledBrowserError();
    product = installed;
    /*
     * The person's password manager and other desktop hookups, copied from their own profile of the
     * same browser into this profile's folder, which is where a browser on a dedicated user data
     * directory reads them. Manifests only, at every launch. Windows reads them from the registry.
     */
    const from = defaultNativeMessagingHosts(installed, process.env);
    if (from) {
      const copied = await copyNativeMessagingHosts(
        from,
        join(input.dir, "NativeMessagingHosts"),
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

  const options = personLaunchOptions(
    {
      window,
      recorderDir: input.recorder.dir,
      headless: input.runtime.mode === "headless",
      sandbox: input.sandbox,
      botArgs: input.botArgs,
      display: input.display,
    },
    input.viewport,
  );
  const context = await chromium.launchPersistentContext(input.dir, {
    channel: product,
    ...options,
    // This process owns shutdown, as for a Bot's browser: Playwright's own handlers would kill the
    // browser before its profile is written.
    handleSIGTERM: false,
    handleSIGINT: false,
    handleSIGHUP: false,
    ...(input.proxy ? { proxy: input.proxy } : {}),
  });

  try {
    const browser = context.browser();
    if (!browser) throw new Error("The browser did not start.");
    const session = await browser.newBrowserCDPSession();
    let recorderId = input.recorder.id;
    if (window === "native") {
      const { id } = await session.send("Extensions.loadUnpacked", {
        path: input.recorder.dir,
      });
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
    // Narration in a native window is the Recorder hearing the person, and it asks nobody first.
    // The hosted browser has no microphone; the grant costs nothing there and keeps one launch.
    await session.send("Browser.grantPermissions", {
      origin: `chrome-extension://${recorderId}`,
      permissions: ["audioCapture"],
    });
    if (window === "native") {
      /*
       * Downloads where the person's browser puts them. Playwright sends every download to a
       * temporary folder of its own under a random name and deletes it when the browser closes,
       * which is right for a test and loses a person's files. The browser's own behaviour is the
       * Downloads folder its settings name.
       */
      await session.send("Browser.setDownloadBehavior", {
        behavior: "default",
      });
    }
    const launcher = createRecorderLauncher({ session, context, recorderId });
    return {
      context,
      person: { product, window, recorderId, launcher, session },
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}
