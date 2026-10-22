/**
 * The OpenBot Browser's routes on this computer: open a person's browser with the Recorder in it and
 * connected, and act for the person in it (record, narrate, tabs, navigate, close).
 *
 * Under the computer token like every other route, with the person's browser id in
 * `x-openbot-bot-id`; `index.ts` checks the token, this checks the id. The server is the only caller:
 * it decides who the signed-in person is, mints their Recorder connection, and forwards here. The
 * shapes are the contract in `shared/openbot-browser.ts`, which every slice builds against.
 *
 * Every answer but narration's is the browser's state, so the caller never has to ask twice to show
 * what a change did.
 *
 * Its own module, taking the browsers it acts on, so a test can serve these exact routes over a
 * person's browser launched headless, which the computer's own environment refuses for a native one.
 */
import type { Page } from "playwright";
import {
  type BrowserState,
  type BrowserTab,
  browserComputerPaths,
  browserNarrationRequestSchema,
  browserNavigateRequestSchema,
  browserOpenRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
  isPersonBrowserId,
  type LauncherState,
  type Narration,
} from "../../shared/openbot-browser";
import { navigationFailure } from "./navigation";
import { BROWSER_NOT_OPEN, BrowserNotOpenError } from "./person-access";
import {
  NoInstalledBrowserError,
  PersonOpenError,
  type PersonOpenStep,
} from "./person-browser";
import type { OpenPersonBrowser, Profiles } from "./profiles";
import { findRecorder } from "./recorder";
import { RecorderUnavailableError } from "./recorder-launcher";
import { addressFrom } from "./request-validation";

export type BrowserHostOptions = {
  profiles: Profiles;
  /** `OPENBOT_RECORDER_DIR`, read at every open so a rebuilt Recorder is the one the next browser gets. */
  recorderDir: () => string | undefined;
  navigationTimeoutMs: number;
};

/** How long one tab may take to say whether it is showing, before it is left out of the question. */
const VISIBILITY_MS = 1_000;

/**
 * Where Chromium's error page lives. A tab whose page did not load shows it, and Playwright reports
 * the error page's own address, `chrome-error://chromewebdata/`, as the tab's. The tab itself still
 * names the address that failed, as a browser's address bar does: DevTools' target for the tab says
 * so. Measured on Playwright 1.62.1's Chromium for a name that does not resolve and a port that
 * refuses.
 */
const ERROR_PAGE = "chrome-error://";
/** How long a failed navigation waits for the tab to show its error page. */
const ERROR_PAGE_MS = 2_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Enough of a contract schema to check a body with, whichever copy of zod built it. */
type Schema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: { path: PropertyKey[]; message: string }[] };
      };
};

/** The first thing wrong with a body, in the words of the field it is about. */
function parseBody<T>(
  schema: Schema<T>,
  body: unknown,
): { ok: true; value: T } | { ok: false; error: string; response: Response } {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length
    ? `${issue.path.map(String).join(".")}: `
    : "";
  const error = `${where}${issue?.message ?? "That request is not valid."}`;
  return { ok: false, error, response: json({ error }, 400) };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createBrowserHost(options: BrowserHostOptions) {
  const { profiles } = options;
  /** Each tab's DevTools target id, which stays the same for the life of the tab. */
  const tabIds = new WeakMap<Page, string>();
  /** How many documents each tab's main frame has committed, counted from when it was first asked. */
  const commits = new WeakMap<Page, { count: number }>();

  const commitsOf = (page: Page): number => {
    let counted = commits.get(page);
    if (!counted) {
      const counter = { count: 0 };
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) counter.count += 1;
      });
      commits.set(page, counter);
      counted = counter;
    }
    return counted.count;
  };

  const tabIdOf = async (
    browser: OpenPersonBrowser,
    page: Page,
  ): Promise<string | undefined> => {
    const known = tabIds.get(page);
    if (known) return known;
    const session = await browser.context.newCDPSession(page);
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      tabIds.set(page, targetInfo.targetId);
      return targetInfo.targetId;
    } finally {
      await session.detach().catch(() => undefined);
    }
  };

  const pageFor = async (
    browser: OpenPersonBrowser,
    tabId: string,
  ): Promise<Page | undefined> => {
    for (const page of browser.pages()) {
      if ((await tabIdOf(browser, page).catch(() => undefined)) === tabId)
        return page;
    }
    return undefined;
  };

  /**
   * In a native window the person changes tabs in the browser itself, which tells this process
   * nothing, so the tab in front is asked of the pages: the one the browser is showing. The tab
   * already in front stays when it is still showing (two windows show two tabs), and a minimised
   * browser, where none is, keeps the one it had.
   */
  const followNativeTabs = async (browser: OpenPersonBrowser) => {
    if (browser.window !== "native") return;
    const pages = browser.pages();
    const showing = await Promise.all(
      pages.map((page) =>
        Promise.race([
          page
            .evaluate(() => document.visibilityState === "visible")
            .catch(() => false),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), VISIBILITY_MS),
          ),
        ]),
      ),
    );
    const visible = pages.filter((_, index) => showing[index]);
    if (visible.length === 0 || visible.includes(browser.active())) return;
    const front = visible.at(-1);
    if (front) browser.activate(front);
  };

  /** The address a tab shows: its page's, or on an error page the address that failed. */
  const shownUrl = (page: Page, target: { url: string } | undefined): string =>
    page.url().startsWith(ERROR_PAGE) && target?.url ? target.url : page.url();

  const tabsOf = async (browser: OpenPersonBrowser): Promise<BrowserTab[]> => {
    const { targetInfos } = await browser.session.send("Target.getTargets");
    const targets = new Map(
      targetInfos.map((target) => [target.targetId, target]),
    );
    const active = browser.active();
    const tabs: BrowserTab[] = [];
    for (const page of browser.pages()) {
      const id = await tabIdOf(browser, page).catch(() => undefined);
      if (!id) continue;
      tabs.push({
        id,
        url: shownUrl(page, targets.get(id)),
        title: targets.get(id)?.title ?? "",
        active: page === active,
      });
    }
    return tabs;
  };

  /** One tab's shown address, for a sentence about a page that did not open. */
  const addressOf = async (
    browser: OpenPersonBrowser,
    page: Page,
  ): Promise<string> => {
    if (!page.url().startsWith(ERROR_PAGE)) return page.url();
    const id = await tabIdOf(browser, page).catch(() => undefined);
    const { targetInfos } = await browser.session
      .send("Target.getTargets")
      .catch(() => ({ targetInfos: [] }));
    return shownUrl(
      page,
      targetInfos.find((target) => target.targetId === id),
    );
  };

  const stateOf = async (
    browser: OpenPersonBrowser,
    recorder?: LauncherState,
  ): Promise<BrowserState> => {
    // The Recorder's own report, when it answers. A Recorder that is starting or busy leaves it out
    // rather than failing the whole answer: the tabs are still worth showing.
    const report =
      recorder ?? (await browser.launcher.state().catch(() => undefined));
    return {
      open: true,
      browser: browser.product,
      window: browser.window,
      ...(report ? { recorder: report } : {}),
      tabs: await tabsOf(browser),
    };
  };

  const closedState: BrowserState = { open: false, tabs: [] };

  /** Bring a tab to the front: in its window, and so on the live screen and for the Recorder. */
  const putInFront = async (browser: OpenPersonBrowser, page: Page) => {
    browser.activate(page);
    await page.bringToFront().catch(() => undefined);
  };

  /**
   * A page that did not open, said in a sentence once the tab shows that it did not.
   *
   * Chromium commits its error page a moment after the navigation fails: when `goto` threw, the tab
   * still reported the address it had before (or none, for a new tab), and the error page with the
   * failed address about 100 ms later, measured on Playwright 1.62.1's Chromium and on Chrome. The
   * app asks for the tabs as soon as this answers, and showed the earlier address beside the error
   * page, so this waits for that commit first, briefly, and answers either way. Only for a network
   * error: a navigation that timed out is still loading, and one that became a download or was
   * aborted shows no error page.
   */
  const navigation = async (
    page: Page,
    since: number,
    address: string,
    error: unknown,
  ) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/net::ERR_/.test(message) && !/net::ERR_ABORTED/.test(message)) {
      // A document committed since the navigation began, and it is the error page: a reload of a
      // page that had already failed is on one before its own commits.
      const deadline = Date.now() + ERROR_PAGE_MS;
      while (
        Date.now() < deadline &&
        !page.isClosed() &&
        !(commitsOf(page) > since && page.url().startsWith(ERROR_PAGE))
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return json({ error: navigationFailure(address, error) }, 502);
  };

  async function open(botId: string, body: unknown): Promise<Response> {
    const arrived = Date.now();
    /*
     * Every open that fails says why in the log, with the step it stopped at: which part of opening
     * (the launch, the Recorder's load or reload, its worker, the microphone, the connect) gave the
     * sentence the caller is answered with. Without it a failed open said only that the browser was
     * then stopped.
     */
    const failed = (
      step: PersonOpenStep | "request",
      status: number,
      error: string,
    ): Response => {
      console.info(
        JSON.stringify({
          type: "computer-browser-open-failed",
          botId,
          step,
          status,
          error,
          ms: Date.now() - arrived,
        }),
      );
      return json({ error }, status);
    };
    const parsed = parseBody(browserOpenRequestSchema, body);
    if (!parsed.ok) return failed("request", 400, parsed.error);
    const found = await findRecorder(options.recorderDir());
    if (!found.ok) return failed("recorder-files", 503, found.error);

    const wasOpen = profiles.person(botId) !== undefined;
    let page: Page;
    try {
      page = await profiles.page(botId, { open: { recorder: found.recorder } });
    } catch (error) {
      if (error instanceof NoInstalledBrowserError)
        return failed("launch", 503, error.message);
      return failed(
        error instanceof PersonOpenError ? error.step : "launch",
        502,
        `The browser could not be opened: ${messageOf(error)}`,
      );
    }
    const browser = profiles.person(botId);
    if (!browser) return failed("launch", 409, BROWSER_NOT_OPEN);
    // Already open: the window comes to the front and nothing new opens.
    if (wasOpen && browser.window === "native") await putInFront(browser, page);

    // Who hears the person: the Recorder itself in a native window, the app's page in a hosted one.
    const narration: Narration =
      browser.window === "native" ? "own" : "external";
    let connected: Awaited<ReturnType<typeof browser.launcher.connect>>;
    try {
      // Every open, not only the first: idempotent, and the connection the server sends is the one
      // the Recorder should hold.
      connected = await browser.launcher.connect({
        connection: parsed.value.connection,
        narration,
      });
    } catch (error) {
      connected = {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "The Recorder did not answer.",
      };
    }
    if (!connected.ok) {
      // A browser that has just opened and cannot be connected is closed again: the person was
      // promised one that is connected. One that was already open stays, with the person's tabs.
      if (!wasOpen)
        await profiles.stop(botId, "its Recorder could not be connected");
      return failed(
        "connect",
        502,
        `The Recorder could not be connected: ${connected.error}`,
      );
    }
    try {
      return json(await stateOf(browser));
    } catch (error) {
      // The browser went away between the connect and its state: closed by the person, or crashed.
      return failed(
        "state",
        502,
        `The browser could not be opened: ${messageOf(error)}`,
      );
    }
  }

  async function handle(
    request: Request,
    pathname: string,
    botId: string,
  ): Promise<Response> {
    if (!isPersonBrowserId(botId))
      return json(
        {
          error:
            "The browser routes are for a person's browser: send its id (person- and 32 hex digits) in x-openbot-bot-id.",
        },
        400,
      );
    const method = pathname === browserComputerPaths.state ? "GET" : "POST";
    if (request.method !== method)
      return json({ error: `Use ${method} for ${pathname}.` }, 405);
    const body =
      method === "POST" ? await request.json().catch(() => null) : null;

    if (pathname === browserComputerPaths.open) return open(botId, body);

    if (pathname === browserComputerPaths.close) {
      await profiles.stop(botId);
      return json(closedState);
    }

    /*
     * OpenBot revoked this browser's connection: the Recorder forgets it now rather than at its next
     * call to OpenBot. A closed browser has no Recorder running to tell, and is not opened to tell
     * it: the next open hands the Recorder whatever connection OpenBot gives it then.
     */
    if (pathname === browserComputerPaths.disconnect) {
      const browser = profiles.person(botId);
      if (!browser) return json(closedState);
      try {
        const result = await browser.launcher.disconnect();
        if (!result.ok) return json({ error: result.error }, 409);
      } catch (error) {
        if (error instanceof RecorderUnavailableError)
          return json({ error: error.message }, 502);
        throw error;
      }
      return json(await stateOf(browser));
    }

    // Validated before asking whether the browser is open, so a malformed call says what is wrong
    // with it rather than that there is nothing to act on.
    const recording =
      pathname === browserComputerPaths.recording
        ? parseBody(browserRecordingRequestSchema, body)
        : undefined;
    const narration =
      pathname === browserComputerPaths.narration
        ? parseBody(browserNarrationRequestSchema, body)
        : undefined;
    const tabs =
      pathname === browserComputerPaths.tabs
        ? parseBody(browserTabsRequestSchema, body)
        : undefined;
    const navigate =
      pathname === browserComputerPaths.navigate
        ? parseBody(browserNavigateRequestSchema, body)
        : undefined;
    for (const parsed of [recording, narration, tabs, navigate])
      if (parsed && !parsed.ok) return parsed.response;

    const browser = profiles.person(botId);
    if (pathname === browserComputerPaths.state) {
      if (!browser) return json(closedState);
      await followNativeTabs(browser);
      return json(await stateOf(browser));
    }
    if (!browser) return json({ error: BROWSER_NOT_OPEN }, 409);

    try {
      if (recording?.ok) {
        await followNativeTabs(browser);
        // The Recorder records the tab the browser has in front, so a hosted browser's front tab is
        // made the one the live screen shows before it starts.
        if (recording.value.action === "start" && browser.window === "screen")
          await putInFront(browser, browser.active());
        const result = await browser.launcher.record(recording.value);
        if (!result.ok) return json({ error: result.error }, 409);
        return json(await stateOf(browser, result.state));
      }

      if (narration?.ok) {
        /*
         * A phrase, or the person starting or stopping one. The times are already on the server's
         * clock, which corrected them by `sentAt` on the way (see the contract); `sentAt` itself is
         * the server's own and goes no further.
         */
        const said = narration.value;
        const result =
          "text" in said
            ? await browser.launcher.narrate({
                text: said.text,
                startedAt: said.startedAt,
                endedAt: said.endedAt,
              })
            : await browser.launcher.speaking({
                since: said.speaking ? said.since : null,
              });
        if (!result.ok) return json({ error: result.error }, 409);
        return json({ ok: true });
      }

      if (tabs?.ok) {
        const action = tabs.value;
        if (action.action === "new") {
          const address =
            action.url === undefined ? undefined : addressFrom(action.url);
          if (action.url !== undefined && !address)
            return json({ error: "That is not a web address." }, 400);
          const page = await browser.context.newPage();
          await putInFront(browser, page);
          if (address) {
            const since = commitsOf(page);
            try {
              await page.goto(address, {
                waitUntil: "domcontentloaded",
                timeout: options.navigationTimeoutMs,
              });
            } catch (error) {
              return navigation(page, since, address, error);
            }
          }
          return json(await stateOf(browser));
        }
        const page = await pageFor(browser, action.tabId);
        if (!page) return json({ error: "There is no such tab." }, 404);
        if (action.action === "activate") {
          await putInFront(browser, page);
          return json(await stateOf(browser));
        }
        // The hosted browser always keeps a tab: the live screen needs a page to show, and the
        // person has no window of their own to close instead.
        if (browser.window === "screen" && browser.pages().length === 1)
          await putInFront(browser, await browser.context.newPage());
        await page.close();
        const after = profiles.person(botId);
        return json(after ? await stateOf(after) : closedState);
      }

      if (navigate?.ok) {
        await followNativeTabs(browser);
        const page = browser.active();
        const go = navigate.value;
        const waiting = {
          waitUntil: "domcontentloaded" as const,
          timeout: options.navigationTimeoutMs,
        };
        // The address the person asked for, or for back, forward and reload the page they were on.
        let address = await addressOf(browser, page);
        const since = commitsOf(page);
        try {
          if ("url" in go) {
            const asked = addressFrom(go.url);
            if (!asked)
              return json({ error: "That is not a web address." }, 400);
            address = asked;
            await page.goto(asked, waiting);
          } else if (go.action === "reload") await page.reload(waiting);
          else {
            /*
             * Back and Forward wait only for the page to commit. A person's native browser keeps
             * the back and forward cache, which brings a page back whole without loading it again,
             * so it never fires the load events a fresh page does and waiting for one never ends.
             */
            const history = { ...waiting, waitUntil: "commit" as const };
            if (go.action === "back") await page.goBack(history);
            else await page.goForward(history);
          }
        } catch (error) {
          return navigation(page, since, address, error);
        }
        return json(await stateOf(browser));
      }
    } catch (error) {
      if (error instanceof BrowserNotOpenError)
        return json({ error: error.message }, 409);
      if (error instanceof RecorderUnavailableError)
        return json({ error: error.message }, 502);
      throw error;
    }
    return json({ error: "Not found." }, 404);
  }

  return { handle };
}

export type BrowserHost = ReturnType<typeof createBrowserHost>;

/** Whether a path is one of these routes, so the dispatcher hands it over. */
export function isBrowserPath(pathname: string): boolean {
  return (Object.values(browserComputerPaths) as string[]).includes(pathname);
}
