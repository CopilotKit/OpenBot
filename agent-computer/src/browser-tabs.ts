/**
 * The bar above a browser OpenBot shows: its tabs (new, switch, close) and the tab in front's address, back, forward
 * and reload.
 *
 * Two browsers have it. A person's own (`browser-host.ts`), which is theirs at every moment, and a Bot's
 * (`bot-browser-host.ts`), which a person works only while they hold its wheel. Who may use the bar is each host's to
 * decide; what the bar does, and what it says when a page does not open, is the same in both and lives here.
 *
 * Playwright's own types, and nothing of either host's, so both hand it the browser they have.
 */
import type { BrowserContext, CDPSession, Page } from "playwright";
import type {
  BrowserNavigateRequest,
  BrowserTab,
  BrowserTabsRequest,
  BrowserWindow,
} from "../../shared/openbot-browser";
import { navigationFailure } from "./navigation";
import { addressFrom } from "./request-validation";

/** A browser whose tabs the bar works. */
export type TabbedBrowser = {
  context: BrowserContext;
  /** The browser-level DevTools session, which the tab list reads titles from. */
  session: CDPSession;
  /** `screen`: OpenBot decides which tab is in front and the live screen shows it. `native`: the person's own window. */
  window: BrowserWindow;
  /** The tab in front: the one the live screen shows and the bar acts on. */
  active(): Page;
  /** Put a tab in front. */
  activate(page: Page): void;
  /** The tabs, oldest first, never the Recorder's own pages. */
  pages(): Page[];
};

/** What the bar did: done, or a refusal in a sentence for the person, with the status it is answered with. */
export type BarOutcome =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 502; error: string };

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

const NOT_AN_ADDRESS = "That is not a web address.";

export function createTabBar(options: { navigationTimeoutMs: number }) {
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
    browser: TabbedBrowser,
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
    browser: TabbedBrowser,
    tabId: string,
  ): Promise<Page | undefined> => {
    for (const page of browser.pages()) {
      if ((await tabIdOf(browser, page).catch(() => undefined)) === tabId)
        return page;
    }
    return undefined;
  };

  /** The address a tab shows: its page's, or on an error page the address that failed. */
  const shownUrl = (page: Page, target: { url: string } | undefined): string =>
    page.url().startsWith(ERROR_PAGE) && target?.url ? target.url : page.url();

  /** The tabs as the bar lists them, the one in front marked. */
  const tabsOf = async (browser: TabbedBrowser): Promise<BrowserTab[]> => {
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
    browser: TabbedBrowser,
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

  /** Bring a tab to the front: in its window, and so on the live screen and for the Recorder. */
  const putInFront = async (browser: TabbedBrowser, page: Page) => {
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
  ): Promise<BarOutcome> => {
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
    return {
      ok: false,
      status: 502,
      error: navigationFailure(address, error),
    };
  };

  /** Open a tab (at an address, or blank), bring one to the front, or close one. */
  async function tabs(
    browser: TabbedBrowser,
    action: BrowserTabsRequest,
  ): Promise<BarOutcome> {
    if (action.action === "new") {
      const address =
        action.url === undefined ? undefined : addressFrom(action.url);
      if (action.url !== undefined && !address)
        return { ok: false, status: 400, error: NOT_AN_ADDRESS };
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
      return { ok: true };
    }
    const page = await pageFor(browser, action.tabId);
    if (!page)
      return { ok: false, status: 404, error: "There is no such tab." };
    if (action.action === "activate") {
      await putInFront(browser, page);
      return { ok: true };
    }
    // A browser on the screen always keeps a tab: the live screen needs a page to show, and the
    // person has no window of their own to close instead.
    if (browser.window === "screen" && browser.pages().length === 1)
      await putInFront(browser, await browser.context.newPage());
    await page.close();
    return { ok: true };
  }

  /** Go to an address in the tab in front, or back, forward, or reload it. */
  async function navigate(
    browser: TabbedBrowser,
    go: BrowserNavigateRequest,
  ): Promise<BarOutcome> {
    const page = browser.active();
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
        if (!asked) return { ok: false, status: 400, error: NOT_AN_ADDRESS };
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
    return { ok: true };
  }

  return { tabsOf, putInFront, tabs, navigate };
}

export type TabBar = ReturnType<typeof createTabBar>;
