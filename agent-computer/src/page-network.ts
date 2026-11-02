import type { BrowserContext, CDPSession, Page } from "playwright";
import {
  onWebBotAuthChange,
  signedHeaders,
  webBotAuthEnabled,
} from "./web-bot-auth";

/**
 * What a Bot's browser says about itself on the network: its user agent, and its Web Bot Auth
 * signature.
 *
 * ON THE WIRE, ONE BROWSER-LEVEL SESSION. The DevTools `Fetch` domain enabled on the browser target
 * pauses every request the browser sends, whichever target sent it: pages, cross-site frames in
 * processes of their own, dedicated workers, service workers and their script fetches. Each paused
 * request is continued with its headers amended. That is after the page has decided the request and
 * before the network stack sends it, so cookies are still attached, no CORS preflight is added, TLS is
 * Chromium's own, and the request still goes through the egress filter like any other. Verified
 * against a real Chromium in `tests/web-bot-auth-browser.test.ts`, for every one of those request
 * kinds.
 *
 * Not Playwright's `route()`: routing turns off the browser's HTTP cache for the whole context (every
 * asset fetched afresh on every page, which a site sees and a person waits for), and it does not see
 * what a service worker sends.
 *
 * IN JAVASCRIPT, PER PAGE, AND ONLY HEADLESS. A headless browser names itself `HeadlessChrome` in its
 * user agent and in its client hints. The wire is fixed above for every request; what a page's script
 * reads (`navigator.userAgent`, `navigator.userAgentData`) is fixed per page with
 * `Network.setUserAgentOverride`, and per cross-site frame by auto-attaching to each one, paused
 * before it runs. A headed browser says `Chrome` already and needs none of this.
 */

type Brand = { brand: string; version: string };

type UserAgentOverride = {
  userAgent: string;
  userAgentMetadata?: {
    brands: Brand[];
    fullVersionList: Brand[];
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
  };
};

/** The two calls this needs from a DevTools session, whether Playwright's or one relayed through it. */
type Target = {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, listener: (params: never) => void): void;
};

function fromPlaywright(session: CDPSession): Target {
  return {
    send: (method, params) =>
      session.send(method as never, params as never) as Promise<unknown>,
    on: (event, listener) => {
      session.on(event as never, listener as never);
    },
  };
}

/* ----------------------------------- the wire: every request ----------------------------------- */

type BrowserNetwork = {
  target: Target;
  headless: boolean;
  /** Whether this browser's requests carry the deployment's Web Bot Auth signature: a Bot's do, a person's never. */
  signs: boolean;
  /** The words a headless browser sends that a headed one does not, and what to send instead. */
  wire?: { userAgent: string; dropBrand: string };
  intercepting: boolean;
  /** Switches are applied in order, so a quick on-off-on cannot leave the browser in the wrong state. */
  chain: Promise<void>;
};

const browsers = new Set<BrowserNetwork>();

onWebBotAuthChange(() => {
  for (const browser of browsers) follow(browser);
});

/** Intercept while there is something to change: always when headless, and while signing is on. */
function follow(browser: BrowserNetwork) {
  browser.chain = browser.chain.then(async () => {
    const want = browser.headless || (browser.signs && webBotAuthEnabled());
    if (want === browser.intercepting) return;
    browser.intercepting = want;
    try {
      if (want) {
        await browser.target.send("Fetch.enable", {
          patterns: [{ urlPattern: "*", requestStage: "Request" }],
        });
      } else {
        await browser.target.send("Fetch.disable");
      }
    } catch {
      // The browser closed between the switch and the command, which leaves nothing to switch.
    }
  });
}

/** `sec-ch-ua` and `sec-ch-ua-full-version-list` without one brand. */
function withoutBrand(value: string, brand: string): string {
  return value
    .split(/,\s*/)
    .filter((entry) => !entry.startsWith(`"${brand}"`))
    .join(", ");
}

/** A headless browser's headers as the same browser sends them headed. */
function headedHeaders(
  headers: Record<string, string>,
  wire: BrowserNetwork["wire"],
): Record<string, string> {
  if (!wire) return headers;
  // Set even where the paused request has none yet: a service worker's script fetch gets its user
  // agent from the network stack after this point, which would be the headless one.
  const out: Record<string, string> = { "User-Agent": wire.userAgent };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "user-agent") continue;
    if (lower === "sec-ch-ua" || lower === "sec-ch-ua-full-version-list")
      out[name] = withoutBrand(value, wire.dropBrand);
    else out[name] = value;
  }
  return out;
}

let signingFailureLogged = false;

type RequestPaused = {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string> };
};

async function continueRequest(browser: BrowserNetwork, event: RequestPaused) {
  const original = event.request.headers;
  const fixed = headedHeaders(original, browser.wire);
  let headers: { name: string; value: string }[] | undefined;
  if (browser.signs)
    try {
      headers = await signedHeaders(
        event.request.method,
        event.request.url,
        fixed,
      );
    } catch (error) {
      // Sent unsigned rather than held: a request that never continues is a page that never loads.
      if (!signingFailureLogged) {
        signingFailureLogged = true;
        console.warn(
          JSON.stringify({
            type: "computer-web-bot-auth-sign-failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  if (!headers && fixed !== original) {
    headers = Object.entries(fixed).map(([name, value]) => ({ name, value }));
  }
  await browser.target
    .send("Fetch.continueRequest", {
      requestId: event.requestId,
      ...(headers ? { headers } : {}),
    })
    .catch(() => undefined);
}

/**
 * Attach a launched browser. Awaited before its first navigation, so the first request a site sees is
 * already signed and already says `Chrome`. `signs: false` for a person's browser: it says `Chrome` as a
 * Bot's does, but a person browsing is not the deployment's automated agent, so it never signs.
 */
export async function attachBrowserNetwork(
  context: BrowserContext,
  options: { headless: boolean; signs?: boolean },
): Promise<void> {
  const owner = context.browser();
  if (!owner) {
    console.warn(
      JSON.stringify({
        type: "computer-browser-network-unavailable",
        note: "No browser-level DevTools session, so requests go out unsigned.",
      }),
    );
    return;
  }
  const session = await owner.newBrowserCDPSession();
  const target = fromPlaywright(session);
  const browser: BrowserNetwork = {
    target,
    headless: options.headless,
    signs: options.signs ?? true,
    intercepting: false,
    chain: Promise.resolve(),
  };
  if (options.headless) {
    const version = (await target
      .send("Browser.getVersion")
      .catch(() => undefined)) as { userAgent?: string } | undefined;
    if (version?.userAgent?.includes("HeadlessChrome")) {
      browser.wire = {
        // The browser-reported string is the full version; what a page sends is the reduced one,
        // which is what a site expects from Chrome. Taken from the page below when it can be.
        userAgent: version.userAgent.replace("HeadlessChrome/", "Chrome/"),
        dropBrand: "HeadlessChrome",
      };
    }
  }
  target.on("Fetch.requestPaused", (event: RequestPaused) => {
    void continueRequest(browser, event);
  });
  browsers.add(browser);
  context.once("close", () => browsers.delete(browser));
  follow(browser);
  await browser.chain;
  const page = context.pages()[0];
  if (options.headless && page) {
    const override = await userAgentFor(context, page);
    if (override && browser.wire) browser.wire.userAgent = override.userAgent;
  }
}

/* ------------------------------- what scripts read: headless only ------------------------------ */

/** A child target reached through its parent's session (non-flattened auto-attach). */
function relayed(parent: Target, sessionId: string) {
  let next = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const target: Target = {
    send(method, params = {}) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        parent
          .send("Target.sendMessageToTarget", {
            sessionId,
            message: JSON.stringify({ id, method, params }),
          })
          .catch((error: unknown) => {
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    },
    // Nothing listens for a child's events: it is only told things.
    on() {},
  };
  return {
    target,
    receive(raw: string) {
      const message = JSON.parse(raw) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (message.id === undefined) return;
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        waiting?.reject(new Error(message.error.message ?? "CDP error"));
      else waiting?.resolve(message.result);
    },
    gone() {
      for (const waiting of pending.values())
        waiting.reject(new Error("The target went away."));
      pending.clear();
    },
  };
}

const userAgents = new WeakMap<
  BrowserContext,
  Promise<UserAgentOverride | undefined>
>();

/**
 * What the same browser reports headed: the page's own (already reduced, `Chrome/151.0.0.0`) user
 * agent with the word changed, and its client hints without the `HeadlessChrome` brand. Read once per
 * browser, from a page, because the high-entropy hints are only asked of a page.
 */
async function headlessUserAgent(
  target: Target,
): Promise<UserAgentOverride | undefined> {
  const evaluated = (await target.send("Runtime.evaluate", {
    expression: `(navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "fullVersionList", "wow64"]) : Promise.resolve({})).then((values) => JSON.stringify({ ...values, userAgent: navigator.userAgent, platform: navigator.userAgentData?.platform, mobile: navigator.userAgentData?.mobile }))`,
    awaitPromise: true,
    returnByValue: true,
  })) as { result: { value?: string } };
  const reported = JSON.parse(evaluated.result.value ?? "{}") as Partial<
    NonNullable<UserAgentOverride["userAgentMetadata"]>
  > & { userAgent?: string };
  if (!reported.userAgent?.includes("HeadlessChrome")) return undefined;
  const userAgent = reported.userAgent.replace("HeadlessChrome/", "Chrome/");
  if (!reported.brands) {
    // The string alone still drops the word; Chromium then sends no client hints rather than wrong ones.
    return { userAgent };
  }
  const real = (list: Brand[] = []) =>
    list.filter((entry) => entry.brand !== "HeadlessChrome");
  return {
    userAgent,
    userAgentMetadata: {
      brands: real(reported.brands),
      fullVersionList: real(reported.fullVersionList),
      platform: reported.platform ?? "",
      platformVersion: reported.platformVersion ?? "",
      architecture: reported.architecture ?? "",
      model: reported.model ?? "",
      mobile: reported.mobile ?? false,
      bitness: reported.bitness ?? "",
      wow64: reported.wow64 ?? false,
    },
  };
}

const pageSessions = new WeakMap<Page, Promise<Target | undefined>>();

function sessionFor(context: BrowserContext, page: Page) {
  let session = pageSessions.get(page);
  if (!session) {
    session = context
      .newCDPSession(page)
      .then(fromPlaywright)
      .catch(() => undefined);
    pageSessions.set(page, session);
  }
  return session;
}

async function userAgentFor(context: BrowserContext, page: Page) {
  let pending = userAgents.get(context);
  if (!pending) {
    pending = sessionFor(context, page).then((target) =>
      target ? headlessUserAgent(target).catch(() => undefined) : undefined,
    );
    userAgents.set(context, pending);
  }
  return pending;
}

/** How long a cross-site frame is held for its user agent before it is let go regardless. */
const CHILD_SETUP_BUDGET_MS = 2_000;

/** Override one target's user agent, and every cross-site frame's inside it as each one starts. */
async function overrideUserAgent(target: Target, override: UserAgentOverride) {
  await target
    .send("Network.setUserAgentOverride", override)
    .catch(() => undefined);
  const children = new Map<string, ReturnType<typeof relayed>>();
  target.on(
    "Target.receivedMessageFromTarget",
    (event: { sessionId: string; message: string }) => {
      children.get(event.sessionId)?.receive(event.message);
    },
  );
  target.on(
    "Target.attachedToTarget",
    (event: { sessionId: string; waitingForDebugger: boolean }) => {
      const child = relayed(target, event.sessionId);
      children.set(event.sessionId, child);
      void (async () => {
        try {
          await Promise.race([
            child.target.send("Network.setUserAgentOverride", override),
            new Promise((resolve) =>
              setTimeout(resolve, CHILD_SETUP_BUDGET_MS),
            ),
          ]);
        } catch {
          // A frame that cannot take the override still runs, with the browser's own.
        } finally {
          // Always let it go: a frame left waiting for a debugger is a frame that never loads.
          if (event.waitingForDebugger) {
            await child.target
              .send("Runtime.runIfWaitingForDebugger")
              .catch(() => undefined);
          }
        }
      })();
    },
  );
  target.on("Target.detachedFromTarget", (event: { sessionId: string }) => {
    children.get(event.sessionId)?.gone();
    children.delete(event.sessionId);
  });
  // Non-flattened, with messages relayed through this session: a flattened child session would be
  // addressed on Playwright's connection, which has no way to hand it to us.
  await target
    .send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    })
    .catch(() => undefined);
}

const overridden = new WeakSet<Page>();

/**
 * A page's script sees `Chrome`, not `HeadlessChrome`. Headless only; awaited for the page a browser
 * launches with, and run as each later page (a popup) opens.
 */
export async function attachPageNetwork(
  context: BrowserContext,
  page: Page,
  options: { headless: boolean },
): Promise<void> {
  if (!options.headless || overridden.has(page)) return;
  overridden.add(page);
  const override = await userAgentFor(context, page);
  if (!override) return;
  const target = await sessionFor(context, page);
  if (target) await overrideUserAgent(target, override);
}
