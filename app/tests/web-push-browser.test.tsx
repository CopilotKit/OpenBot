import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { servedHeaders } from "../serve";
import { ME_PATH, meResponse } from "./accounts-api";
import { notificationsResponse } from "./notifications-api";
import { still } from "./page-still";
import {
  WEB_PUSH_KEY,
  WEB_PUSH_SUBSCRIPTIONS_PATH,
  type WebPushServer,
  webPushResponse,
} from "./web-push-api";

/**
 * Push notifications in this browser, in a real browser: Settings, Notifications' "Notifications in
 * this browser" turned on saves the browser's subscription through the API, turned off removes it,
 * and OpenBot saves it again each time it starts. The service worker at /sw.js shows a push the
 * server sends, in the server's Declarative Web Push format, and a click on it opens its
 * conversation in the OpenBot already open.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/web-push-browser.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, for how the
 * row looks (the push and click run in Chromium, which delivers a push through its DevTools
 * protocol). With OPENBOT_APP_SHOTS=<dir> each look is saved as
 * web-push-<state>-<engine>-<theme>-<width>.png.
 *
 * Served from 127.0.0.1, a secure address, as a service worker and the Push API need: the page,
 * the service worker from public/sw.js with the headers app/serve.ts gives it, and the API at the
 * page's own address, as the server answers it.
 *
 * THE ONE STAND-IN. A headless browser has no push service: Chromium refuses to subscribe
 * ("Registration failed - permission denied") and WebKit too. So `PushManager`'s `subscribe` and
 * `getSubscription` are replaced in the page with ones that answer as Chromium's do, a subscription
 * whose `toJSON()` is `{ endpoint, expirationTime: null, keys: { p256dh, auth } }` and whose
 * `options.applicationServerKey` is the key's bytes. Everything else is the browser's own: the
 * permission, the service worker, its registration, the push it is sent and the notification it
 * shows.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;
const engines = (process.env.OPENBOT_APP_ENGINES ?? "chromium")
  .split(",")
  .map((engine) => engine.trim())
  .filter((engine) => engine === "chromium" || engine === "webkit") as (
  | "chromium"
  | "webkit"
)[];

const APP = join(import.meta.dir, "..");
const TITLE = "Notifications in this browser";
const THEMES = ["light", "dark"] as const;
const WINDOWS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const STATES = ["off", "on", "blocked", "home-screen"] as const;

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1";

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "web-push.fixture.tsx")],
    target: "browser",
    external: ["maplibre-gl"],
    // `@/lib/marks` is Vite's `import.meta.glob`, so no brand marks, as in the other browser tests.
    plugins: [
      {
        name: "no-marks",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
            path: "marks",
            namespace: "no-marks",
          }));
          build.onLoad({ filter: /.*/, namespace: "no-marks" }, () => ({
            contents: "export const markFor = () => null;",
            loader: "js",
          }));
        },
      },
    ],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
      "import.meta.env.MODE": JSON.stringify("production"),
    },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

/** The directory of an installed package, from the app or the repository root. */
function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = packageDir(name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const subpath = `.${id.slice(name.length)}`;
  const entry = pkg.exports?.[subpath];
  const file =
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? pkg.main ?? "index.css");
  return join(dir, file);
}

/** The app's stylesheet, built by Tailwind for these classes, as the app's build does. */
async function stylesheet(classes: string[]): Promise<string> {
  const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", APP));
  const entry = join(APP, "src", "styles.css");
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: dirname(entry),
    loadStylesheet: async (id, base) => {
      const path =
        id === "tailwindcss"
          ? join(tailwind, "index.css")
          : id.startsWith(".")
            ? join(base, id)
            : packageStylesheet(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(classes);
}

/** Styles what is on the page now. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await still(page);
}

/** Every request the API was sent, as the server saw it. */
type Seen = { method: string; path: string; body: unknown; headers: Headers };

let script = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let origin = "";
const seen: Seen[] = [];
const pushServer: WebPushServer = { saved: new Map() };
const browsers: Browser[] = [];

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/app.js")
        return new Response(script, {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/sw.js")
        return new Response(Bun.file(join(APP, "public", "sw.js")), {
          headers: servedHeaders("/sw.js"),
        });
      if (url.pathname.startsWith("/api/")) {
        const text = await request.text();
        const body = text ? JSON.parse(text) : undefined;
        seen.push({
          method: request.method,
          path: url.pathname,
          body,
          headers: request.headers,
        });
        if (url.pathname === ME_PATH)
          return meResponse({
            user: {
              id: "dana",
              email: "dana@acme.test",
              name: "Dana Whitfield",
              role: "member",
            },
          });
        return (
          webPushResponse(
            request.method,
            url.pathname,
            pushServer,
            body,
            request.headers,
          ) ??
          notificationsResponse(request.method, url.pathname, {
            available: { push: true },
            devices: [{ id: "d1", platform: "ios" }],
            deliveries: [
              {
                id: "x1",
                transport: "push",
                kind: "reply",
                state: "delivered",
                error: null,
                createdAt: "2026-11-26T09:00:00Z",
              },
            ],
          }) ??
          Response.json({ detail: "not served" }, { status: 404 })
        );
      }
      if (url.pathname.includes("."))
        return new Response("not found", { status: 404 });
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      return new Response(
        `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
}, 120_000);

afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
  await server?.stop(true);
});

/**
 * The Push API's subscribe and getSubscription, answering as Chromium's do. The subscription is
 * kept in the page's storage, so it outlives a reload as a real one does.
 */
function standInPushManager() {
  const STORE = "test:push-subscription";
  const toBase64 = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const fromBase64 = (text: string) =>
    Uint8Array.from(
      atob(
        text.replace(/-/g, "+").replace(/_/g, "/") +
          "===".slice((text.length + 3) % 4),
      ),
      (char) => char.charCodeAt(0),
    );
  type Kept = {
    endpoint: string;
    key: string;
    keys: { p256dh: string; auth: string };
  };
  const subscription = (kept: Kept) => ({
    endpoint: kept.endpoint,
    expirationTime: null,
    options: {
      userVisibleOnly: true,
      applicationServerKey: fromBase64(kept.key).buffer,
    },
    getKey: (name: "p256dh" | "auth") => fromBase64(kept.keys[name]).buffer,
    toJSON: () => ({
      endpoint: kept.endpoint,
      expirationTime: null,
      keys: { ...kept.keys },
    }),
    unsubscribe: async () => {
      localStorage.removeItem(STORE);
      return true;
    },
  });
  PushManager.prototype.getSubscription = async () => {
    const kept = localStorage.getItem(STORE);
    return (kept
      ? subscription(JSON.parse(kept))
      : null) as unknown as PushSubscription | null;
  };
  PushManager.prototype.subscribe = async (options) => {
    if (Notification.permission !== "granted")
      throw new DOMException(
        "Registration failed - permission denied",
        "NotAllowedError",
      );
    if (!options?.userVisibleOnly)
      throw new DOMException(
        "Registration failed - userVisibleOnly",
        "NotAllowedError",
      );
    const given = options.applicationServerKey;
    const key =
      typeof given === "string"
        ? fromBase64(given)
        : given instanceof ArrayBuffer
          ? new Uint8Array(given)
          : new Uint8Array(
              (given as ArrayBufferView).buffer,
              (given as ArrayBufferView).byteOffset,
              (given as ArrayBufferView).byteLength,
            );
    const p256dh = crypto.getRandomValues(new Uint8Array(65));
    p256dh[0] = 4;
    const kept: Kept = {
      endpoint: `https://fcm.googleapis.com/fcm/send/${toBase64(crypto.getRandomValues(new Uint8Array(32)))}`,
      key: toBase64(key),
      keys: {
        p256dh: toBase64(p256dh),
        auth: toBase64(crypto.getRandomValues(new Uint8Array(16))),
      },
    };
    localStorage.setItem(STORE, JSON.stringify(kept));
    return subscription(kept) as unknown as PushSubscription;
  };
}

/**
 * The browser's permission, where the test can't have the browser's own: WebKit headless keeps it
 * "default" whatever it is granted, and no browser can be told to refuse it. Its prompt answers
 * Allow.
 */
function standInPermission(initial: NotificationPermission) {
  // Kept for the tab, as a browser keeps a site's answer across its pages.
  const KEY = "test:notification-permission";
  let permission =
    (sessionStorage.getItem(KEY) as NotificationPermission | null) ?? initial;
  Object.defineProperty(Notification, "permission", {
    configurable: true,
    get: () => permission,
  });
  Notification.requestPermission = async () => {
    if (permission === "default") permission = "granted";
    sessionStorage.setItem(KEY, permission);
    return permission;
  };
}

/** Safari on an iPhone, in a tab: no Push API and no notifications. */
function inSafariOnAnIphone() {
  delete (window as { PushManager?: unknown }).PushManager;
  delete (window as { Notification?: unknown }).Notification;
}

async function launch(name: "chromium" | "webkit"): Promise<Browser> {
  const playwright = await import("playwright-core");
  const browser =
    name === "chromium"
      ? // The CI job installs full Chromium without the headless shell.
        await playwright.chromium.launch({ channel: "chromium" })
      : await playwright.webkit.launch();
  browsers.push(browser);
  return browser;
}

/** A fresh browser profile at Settings, Notifications, with nothing saved on the server. */
async function openNotifications(
  browser: Browser,
  options: {
    theme?: (typeof THEMES)[number];
    window?: { width: number; height: number };
    permission?: NotificationPermission | "granted-by-browser";
    iphone?: boolean;
    /** Another place that offers them, and the words it is waited on by. */
    path?: string;
    shows?: string;
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const theme = options.theme ?? "light";
  const context = await browser.newContext({
    viewport: options.window ?? WINDOWS[0],
    colorScheme: theme,
    reducedMotion: "reduce",
    ...(options.iphone ? { userAgent: IPHONE, hasTouch: true } : {}),
  });
  if (options.iphone) await context.addInitScript(inSafariOnAnIphone);
  else {
    await context.addInitScript(standInPushManager);
    if (options.permission === "granted-by-browser")
      await context.grantPermissions(["notifications"], { origin });
    else
      await context.addInitScript(
        standInPermission,
        options.permission ?? "default",
      );
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(error));
  await page.goto(
    `${origin}${options.path ?? "/settings/notifications"}?theme=${theme}`,
  );
  await page.getByText(options.shows ?? TITLE, { exact: true }).waitFor();
  // Unstyled, the switch has no size and can't be pressed.
  await style(page);
  return { context, page };
}

function saves(): Seen[] {
  return seen.filter(
    (one) =>
      one.method === "PUT" &&
      one.path.startsWith(`${WEB_PUSH_SUBSCRIPTIONS_PATH}/`),
  );
}

function removals(): Seen[] {
  return seen.filter(
    (one) =>
      one.method === "DELETE" &&
      one.path.startsWith(`${WEB_PUSH_SUBSCRIPTIONS_PATH}/`),
  );
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await Bun.sleep(50);
  }
}

/** The key's bytes, as the browser compares them. */
function keyBytes(key: string): number[] {
  return [...Buffer.from(key.replace(/-/g, "+").replace(/_/g, "/"), "base64")];
}

describe.skipIf(!asked || !engines.includes("chromium"))(
  "notifications in this browser, in Chromium",
  () => {
    test("turned on, the browser's subscription is saved through the API; turned off, removed", async () => {
      seen.length = 0;
      pushServer.saved.clear();
      const browser = await launch("chromium");
      const { context, page } = await openNotifications(browser, {
        permission: "granted-by-browser",
      });
      const toggle = page.getByRole("switch", { name: TITLE });
      expect(await toggle.getAttribute("aria-checked")).toBe("false");

      await toggle.click();
      await until(() => saves().length === 1, "the subscription is saved");
      await page.getByRole("switch", { name: TITLE, checked: true }).waitFor();
      const [save] = saves();
      const id = save?.path.slice(WEB_PUSH_SUBSCRIPTIONS_PATH.length + 1);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(save?.headers.get("idempotency-key")).toBeTruthy();
      // Exactly what the browser's subscription says, and nothing else: no expirationTime.
      const held = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        return {
          worker: registration?.active?.scriptURL,
          scope: registration?.scope,
          json: subscription?.toJSON(),
          key: subscription?.options.applicationServerKey
            ? [...new Uint8Array(subscription.options.applicationServerKey)]
            : null,
        };
      });
      expect(held.worker).toBe(`${origin}/sw.js`);
      expect(held.scope).toBe(`${origin}/`);
      expect(held.key).toEqual(keyBytes(WEB_PUSH_KEY));
      expect(save?.body).toEqual({
        endpoint: held.json?.endpoint,
        keys: held.json?.keys,
      });
      expect(pushServer.saved.size).toBe(1);

      await toggle.click();
      await until(() => removals().length === 1, "the subscription is removed");
      await page.getByRole("switch", { name: TITLE, checked: false }).waitFor();
      expect(removals()[0]?.path).toBe(save?.path);
      expect(pushServer.saved.size).toBe(0);
      expect(
        await page.evaluate(async () =>
          (await navigator.serviceWorker.getRegistration("/"))?.pushManager
            .getSubscription()
            .then(Boolean),
        ),
      ).toBe(false);
      await context.close();
    }, 60_000);

    test("OpenBot saves it again each time it starts, under the same id", async () => {
      seen.length = 0;
      pushServer.saved.clear();
      const browser = await launch("chromium");
      const { context, page } = await openNotifications(browser, {
        permission: "granted-by-browser",
      });
      await page.getByRole("switch", { name: TITLE }).click();
      await until(() => saves().length === 1, "the subscription is saved");

      await page.reload();
      await until(() => saves().length === 2, "it is saved again on start");
      await style(page);
      const [first, again] = saves();
      expect(again?.path).toBe(first?.path);
      expect(again?.body).toEqual(first?.body);
      await page.getByRole("switch", { name: TITLE, checked: true }).waitFor();
      await context.close();
    }, 60_000);

    test("a push shows as its notification, and a click opens its conversation in the open OpenBot", async () => {
      seen.length = 0;
      pushServer.saved.clear();
      const browser = await launch("chromium");
      const { context, page } = await openNotifications(browser, {
        permission: "granted-by-browser",
      });
      await page.getByRole("switch", { name: TITLE }).click();
      await page.getByRole("switch", { name: TITLE, checked: true }).waitFor();

      const cdp = await context.newCDPSession(page);
      const registrations = new Map<string, string>();
      cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
        for (const one of event.registrations)
          registrations.set(one.scopeURL, one.registrationId);
      });
      await cdp.send("ServiceWorker.enable");
      await until(
        () => registrations.has(`${origin}/`),
        "the service worker's registration is known",
      );
      const push = (data: unknown) =>
        cdp.send("ServiceWorker.deliverPushMessage", {
          origin: `${origin}/`,
          registrationId: registrations.get(`${origin}/`) as string,
          data: JSON.stringify(data),
        });
      const shown = () =>
        page.evaluate(async () =>
          (await (await navigator.serviceWorker.ready).getNotifications()).map(
            (one) => ({
              title: one.title,
              body: one.body,
              tag: one.tag,
              icon: one.icon,
              data: one.data,
            }),
          ),
        );

      // A reply, as the server sends it.
      await push({
        web_push: 8030,
        notification: {
          title: "Research",
          body: "Here are last quarter's freight costs by lane.",
          navigate: `${origin}/channel/c-1`,
          lang: "en",
          dir: "auto",
          tag: "openbot-c-1",
          silent: false,
        },
      });
      let notifications: Awaited<ReturnType<typeof shown>> = [];
      const deadline = Date.now() + 10_000;
      while (notifications.length === 0 && Date.now() < deadline) {
        notifications = await shown();
        if (notifications.length === 0) await Bun.sleep(100);
      }
      expect(notifications).toEqual([
        {
          title: "Research",
          body: "Here are last quarter's freight costs by lane.",
          tag: "openbot-c-1",
          icon: `${origin}/icon-192.png`,
          data: { navigate: `${origin}/channel/c-1` },
        },
      ]);

      // One that points anywhere but this OpenBot opens OpenBot's home instead.
      await push({
        web_push: 8030,
        notification: {
          title: "Elsewhere",
          body: "",
          navigate: "https://example.com/phish",
          tag: "elsewhere",
        },
      });
      const elsewhereDeadline = Date.now() + 10_000;
      let elsewhere: Awaited<ReturnType<typeof shown>>[number] | undefined;
      while (!elsewhere && Date.now() < elsewhereDeadline) {
        elsewhere = (await shown()).find((one) => one.tag === "elsewhere");
        if (!elsewhere) await Bun.sleep(100);
      }
      expect(elsewhere?.data).toEqual({ navigate: `${origin}/` });

      // A click: headless, the notification can't be clicked, so the worker's own click handler
      // is called on the notification it showed.
      const [worker] = context.serviceWorkers();
      expect(worker?.url()).toBe(`${origin}/sw.js`);
      await worker?.evaluate(async () => {
        // The worker's own global; the app's types describe a page's.
        const self = globalThis as unknown as {
          registration: ServiceWorkerRegistration;
          openbotNotifications: {
            openFrom: (notification: Notification) => Promise<void>;
          };
        };
        const [notification] = await self.registration.getNotifications({
          tag: "openbot-c-1",
        });
        if (!notification) throw new Error("no notification");
        await self.openbotNotifications.openFrom(notification);
      });
      await page.getByText("Conversation c-1").waitFor();
      expect(new URL(page.url()).pathname).toBe("/channel/c-1");
      await context.close();
    }, 60_000);

    test("a browser that blocks notifications is told how to allow them, with no switch to press", async () => {
      const browser = await launch("chromium");
      const { context, page } = await openNotifications(browser, {
        permission: "denied",
      });
      await page
        .getByText("Your browser blocks notifications from OpenBot.", {
          exact: false,
        })
        .waitFor();
      expect(await page.getByRole("switch", { name: TITLE }).isDisabled()).toBe(
        true,
      );
      await context.close();
    }, 60_000);
  },
);

/** The offer a conversation makes above its message box once a task has started (`NotifyPrompt`). */
const OFFER = "Get notified when your Bot finishes or needs your approval.";
/** A Bot's page's row (`NotificationsOfferRow`). */
const BOT_ROW = "Browser notifications";

/**
 * EVERY PLACE THAT TURNS THEM ON ENDS IN THE SAME STATE. Found on 1.2.1 and after web push: a
 * conversation's "Enable notifications" asked only for the page's permission, which shows notices
 * while OpenBot is open, and saved no push subscription, so nothing reached a browser with OpenBot
 * closed unless the person also found Settings' switch.
 */
describe.skipIf(!asked || !engines.includes("chromium"))(
  "every place that turns notifications on, in Chromium",
  () => {
    test("Enable notifications in a conversation saves this browser's push subscription, as Settings' switch does", async () => {
      seen.length = 0;
      pushServer.saved.clear();
      const browser = await launch("chromium");
      // Not asked yet, as the person meets it, and they answer Allow.
      const { context, page } = await openNotifications(browser, {
        permission: "default",
        path: "/conversation-offer",
        shows: OFFER,
      });
      await page.getByRole("button", { name: "Enable notifications" }).click();
      await until(() => saves().length === 1, "the subscription is saved");
      await page
        .getByText(OFFER, { exact: true })
        .waitFor({ state: "detached" });
      const held = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration("/");
        return (await registration?.pushManager.getSubscription())?.toJSON();
      });
      expect(saves()[0]?.body).toEqual({
        endpoint: held?.endpoint,
        keys: held?.keys,
      });
      // Settings says it is on: one state, whichever place it was turned on from.
      // Read off the switch's state, drawn or not: styled before the row arrives, it has no size.
      await page.goto(`${origin}/settings/notifications`);
      await page
        .getByRole("switch", { name: TITLE, checked: true })
        .waitFor({ state: "attached" });
      await context.close();
    }, 60_000);

    test("Turn on on a Bot's page saves it too, and the row goes", async () => {
      seen.length = 0;
      pushServer.saved.clear();
      const browser = await launch("chromium");
      const { context, page } = await openNotifications(browser, {
        permission: "default",
        path: "/bot-offer",
        shows: BOT_ROW,
      });
      await page.getByRole("button", { name: "Turn on" }).click();
      await until(() => saves().length === 1, "the subscription is saved");
      await page
        .getByText(BOT_ROW, { exact: true })
        .waitFor({ state: "detached" });
      expect(pushServer.saved.size).toBe(1);
      await context.close();
    }, 60_000);

    test("on an iPhone in Safari, each offer says to add OpenBot to the Home Screen, with no button that can't work", async () => {
      const browser = await launch("chromium");
      for (const [path, shows, button] of [
        ["/conversation-offer", OFFER, "Enable notifications"],
        ["/bot-offer", BOT_ROW, "Turn on"],
      ] as const) {
        const { context, page } = await openNotifications(browser, {
          iphone: true,
          path,
          shows,
        });
        const row = page
          .getByText(shows, { exact: true })
          .locator("xpath=ancestor::*[@data-slot='item'][1]");
        expect(await row.innerText()).toContain(
          "add OpenBot to your Home Screen first",
        );
        expect(await row.innerText()).toContain("iOS 16.4 or later");
        expect(await page.getByRole("button", { name: button }).count()).toBe(
          0,
        );
        await context.close();
      }
    }, 60_000);
  },
);

describe.skipIf(!asked)("notifications in this browser, on screen", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of WINDOWS)
        for (const state of STATES) {
          test(`${state}, in ${engine}, ${theme}, ${window.width}px`, async () => {
            const browser = await launch(engine);
            const { context, page } = await openNotifications(browser, {
              theme,
              window,
              iphone: state === "home-screen",
              permission:
                state === "blocked"
                  ? "denied"
                  : engine === "chromium"
                    ? "granted-by-browser"
                    : "default",
            });
            const toggle = page.getByRole("switch", { name: TITLE });
            if (state === "on") {
              await toggle.click();
              await page
                .getByRole("switch", { name: TITLE, checked: true })
                .waitFor();
            }
            await style(page);
            await page
              .getByText(TITLE, { exact: true })
              .scrollIntoViewIfNeeded();
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `web-push-${state}-${engine}-${theme}-${window.width}.png`,
                ),
                fullPage: true,
              });
            }
            const sideways = await page.evaluate(
              () =>
                document.documentElement.scrollWidth > innerWidth ||
                document.body.scrollWidth > innerWidth,
            );
            expect(sideways).toBe(false);
            const row = page
              .getByText(TITLE, { exact: true })
              .locator("xpath=ancestor::*[@data-slot='item'][1]");
            const rowBox = await row.boundingBox();
            expect(rowBox).toBeTruthy();
            if (state === "home-screen") {
              // On an iPhone in Safari, what to do first, and no switch that would fail.
              expect(await toggle.count()).toBe(0);
              expect(await row.innerText()).toContain("Add to Home Screen");
              expect(await row.innerText()).toContain("iOS 16.4 or later");
            } else {
              const box = await toggle.boundingBox();
              expect(box && rowBox).toBeTruthy();
              if (box && rowBox) {
                expect(box.x).toBeGreaterThanOrEqual(rowBox.x);
                expect(box.x + box.width).toBeLessThanOrEqual(
                  rowBox.x + rowBox.width,
                );
              }
            }
            await context.close();
          }, 60_000);
        }
});

/** The offer in a conversation and on a Bot's page, as a browser sees them and on an iPhone. */
const OFFERS = [
  { surface: "conversation", path: "/conversation-offer", shows: OFFER },
  { surface: "bot", path: "/bot-offer", shows: BOT_ROW },
] as const;

describe.skipIf(!asked)(
  "the offers to turn notifications on, on screen",
  () => {
    for (const engine of engines)
      for (const theme of THEMES)
        for (const window of WINDOWS)
          for (const { surface, path, shows } of OFFERS)
            for (const iphone of [false, true]) {
              const state = iphone ? "iphone" : "offer";
              test(`${surface} ${state}, in ${engine}, ${theme}, ${window.width}px`, async () => {
                const browser = await launch(engine);
                const { context, page } = await openNotifications(browser, {
                  theme,
                  window,
                  iphone,
                  path,
                  shows,
                  permission:
                    engine === "chromium" ? "granted-by-browser" : "default",
                });
                if (shots) {
                  mkdirSync(shots, { recursive: true });
                  await page.screenshot({
                    path: join(
                      shots,
                      `web-push-${surface}-${state}-${engine}-${theme}-${window.width}.png`,
                    ),
                    fullPage: true,
                  });
                }
                const sideways = await page.evaluate(
                  () =>
                    document.documentElement.scrollWidth > innerWidth ||
                    document.body.scrollWidth > innerWidth,
                );
                expect(sideways).toBe(false);
                const row = page
                  .getByText(shows, { exact: true })
                  .locator("xpath=ancestor::*[@data-slot='item'][1]");
                const rowBox = await row.boundingBox();
                expect(rowBox).toBeTruthy();
                // Every button inside its row, on a phone too.
                for (const button of await row.getByRole("button").all()) {
                  const box = await button.boundingBox();
                  expect(box && rowBox).toBeTruthy();
                  if (box && rowBox) {
                    expect(box.x).toBeGreaterThanOrEqual(rowBox.x);
                    expect(box.x + box.width).toBeLessThanOrEqual(
                      rowBox.x + rowBox.width,
                    );
                  }
                }
                await context.close();
              }, 60_000);
            }
  },
);
