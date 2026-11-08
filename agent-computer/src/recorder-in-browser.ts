/**
 * The Recorder in a browser this computer launched: its setup pages closed as they appear, its worker running the
 * Recorder on disk, and its launcher API reached over the browser's DevTools session.
 *
 * Two browsers have it. A person's (`person-browser.ts`), where it is connected from the moment the browser opens, and
 * a Bot's (`profiles.ts`), where it is loaded at every launch and stays disconnected and silent until a person holding
 * the wheel presses Record (`shared/bot-browser.ts`). How it is put in differs (by flag for bundled Chromium, over
 * DevTools for a native window); what is done with it once it is in is the same, and lives here.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { FILTER_CREDENTIALS_HOST } from "./egress";
import { isRecorderSetupPage, type Recorder } from "./recorder";
import {
  createRecorderLauncher,
  type RecorderLauncher,
} from "./recorder-launcher";

/** The parts of holding the Recorder that can fail on their own, which a person's open names when one does. */
export type RecorderStep = "recorder-files" | "worker" | "recorder-reload";

/** Runs one part, so a caller can name the part that failed. By default the part runs as it is. */
export type RunStep = <T>(
  name: RecorderStep,
  work: () => Promise<T>,
) => Promise<T>;

const asItIs: RunStep = (_name, work) => work();

/**
 * Close the Recorder's setup and connect pages whenever one appears, for the life of the browser.
 *
 * The Recorder opens its setup page when it is installed, and every launch installs it afresh, so
 * this is not a one-off at start. The url a new tab reports can still be the blank one it started
 * on, so each page is checked again as it navigates.
 */
export function closeRecorderSetupPages(
  context: BrowserContext,
  recorderId: string,
) {
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
 * Make a browser behind the egress filter hold the filter's credentials before its Recorder asks
 * anything, by asking the filter once from one of its pages.
 *
 * WHY. The filter's browser listener answers 407 to a request without credentials. Chromium is not
 * given them at launch: Playwright answers the challenge over DevTools (`Fetch.authRequired`), and
 * only for the targets it attaches to, which are pages and service workers. It detaches from the
 * Recorder's offscreen document, so the document's requests are answered by nobody and its fetch
 * gets the 407 itself. They go with the credentials only once the browser holds them, which it does
 * from the first challenge Playwright answered: Chromium keeps a proxy's credentials for the whole
 * profile (`HttpAuthCache` never partitions proxy entries) and sends them up front from then on. A
 * computer that starts again opens the person's browser on the profile it had, where the Recorder
 * still holds its connection and asks OpenBot nothing, so the first request of that browser to go
 * through the filter was the capture pass Record asks for from the offscreen document: the 407 held
 * the recording, and every one made before a page had loaded was not saved.
 *
 * Asked over https, because only a tunnel's CONNECT is challenged whatever Playwright does with a
 * plain request's headers, and for a host the filter answers itself (`FILTER_CREDENTIALS_HOST`), so
 * nothing leaves the computer. The fetch fails, as it should: the credentials are kept when they
 * are sent, whatever the answer. Never fatal: a browser that does not hold them is the browser as it
 * was before this, and is said so.
 * https://chromium.googlesource.com/chromium/src/+/main/net/http/http_auth_cache.cc
 * https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#event-authRequired
 */
export async function holdFilterCredentials(
  page: Page,
  botId: string,
): Promise<void> {
  try {
    await page.evaluate(
      (url) =>
        fetch(url, { mode: "no-cors", cache: "no-store" }).then(
          () => undefined,
          () => undefined,
        ),
      `https://${FILTER_CREDENTIALS_HOST}/`,
    );
  } catch (error) {
    console.info(
      JSON.stringify({
        type: "computer-filter-credentials-not-held",
        botId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
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
 *
 * Settles once the tabs open now are fitted; each tab opened later is fitted as it opens.
 * https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setContentsSize
 */
export async function fitWindowsToViewport(
  context: BrowserContext,
  viewport: { width: number; height: number },
  botId: string,
): Promise<void> {
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
    fit(page).catch((error: unknown) => {
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
  context.on("page", (page) => void fitting(page));
  await Promise.all(context.pages().map(fitting));
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
export async function keepRecorderCurrent(input: {
  session: CDPSession;
  launcher: RecorderLauncher;
  recorder: Recorder;
  recorderId: string;
  botId: string;
  step?: RunStep;
}): Promise<void> {
  const { recorder, launcher } = input;
  const step = input.step ?? asItIs;
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
 * Reach the Recorder in a browser that has just started with it in: its setup pages closed for the life of the
 * browser, and its launcher, through which everything is asked of it, over the browser-level DevTools session.
 */
export function reachRecorder(input: {
  /** A browser-level session (`browser.newBrowserCDPSession()`), which alone can reach the worker. */
  session: CDPSession;
  context: BrowserContext;
  /** The Recorder's id in this browser, which says which pages and which worker are its own. */
  recorderId: string;
}): RecorderLauncher {
  closeRecorderSetupPages(input.context, input.recorderId);
  return createRecorderLauncher(input);
}

/** Reach the Recorder, and make its worker run the Recorder on disk before it is used. */
export async function holdRecorder(input: {
  session: CDPSession;
  context: BrowserContext;
  recorder: Recorder;
  recorderId: string;
  botId: string;
  step?: RunStep;
}): Promise<RecorderLauncher> {
  const launcher = reachRecorder(input);
  await keepRecorderCurrent({ ...input, launcher });
  return launcher;
}
