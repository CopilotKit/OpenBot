import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { ListConnectionsResponse } from "@/lib/api/generated/connections/connections.zod";
import { ListImportsResponse } from "@/lib/api/generated/moving-to-openbot-cloud/moving-to-openbot-cloud.zod";
import { GetPreferencesResponse } from "@/lib/api/generated/people/people.zod";
import { personBody } from "./accounts-api";
import { type AppsFixture, answerAppsApi } from "./apps-api";
import { conversationPage } from "./conversations-api";

/**
 * In OpenBot Desktop on macOS the window's close, minimise and zoom buttons sit over the sidebar's
 * top-left corner, and nothing of the sidebar is drawn under them: not the strip's orb, not its
 * icons, not the open panel's heading. The top of the sidebar still moves the window, and so does
 * the rest of the window's top strip, over the page beside it, while its controls stay controls.
 *
 * The desktop marks the page `data-desktop-titlebar="overlay"` on macOS only and draws the buttons
 * 20pt in and 21 to 37pt down (`TRAFFIC_LIGHTS` in the desktop's main.rs). The strip of sections
 * beside a panel came in without making room for them: the buttons covered the orb and the first
 * letters of "Conversations", and nothing at the top of the sidebar moved the window, because the
 * desktop's drag handle was a header the new sidebar no longer has. Windows has its own title bar
 * above the page and no mark, so nothing moves there, as in a browser.
 *
 * Rendered in a real browser, because what matters is where things land once it has laid the
 * sidebar out. The shells, sidebars and the page's top bar are the app's own, with the app's
 * stylesheet (sidebar-window-buttons.fixture.tsx); only OpenBot's API is the routes below.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/sidebar-window-buttons.test.tsx
 *
 * Chromium always, WebKit too (the engine OpenBot Desktop's Mac window draws with) when
 * `OPENBOT_APP_ENGINES` names it. With OPENBOT_APP_SHOTS=<dir> it saves each case's corner, with
 * the buttons' area outlined, as sidebar-window-buttons-<engine>-<case>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

/** Where macOS draws the window's buttons over the page, as measured in OpenBot Desktop on macOS 26. */
const WINDOW_BUTTONS = { left: 19, top: 21, right: 81, bottom: 37 };

/** The desktop window's default width, and the narrowest it allows (desktop's tauri.conf.json). */
const DEFAULT_WIDTH = 1000;
const NARROWEST_WIDTH = 720;

type Case = {
  name: string;
  shell: "app" | "admin" | "settings";
  path: string;
  width: number;
  /** The sidebar left hidden (⌘B), as the person can leave it. */
  hidden?: boolean;
  /** What to do once the shell is drawn, such as opening the sheet. */
  prepare?: (page: Page) => Promise<void>;
  /**
   * The bars over the app's page showing, as after a move to OpenBot Cloud: apps to reconnect, and
   * the offer to self-host.
   */
  banners?: boolean;
};

const CASES: Case[] = [
  { name: "app-conversations", shell: "app", path: "/", width: DEFAULT_WIDTH },
  { name: "app-bots", shell: "app", path: "/bots", width: DEFAULT_WIDTH },
  // A section with no panel folds the panel away, down to the strip.
  {
    name: "app-routines",
    shell: "app",
    path: "/routines",
    width: DEFAULT_WIDTH,
  },
  {
    name: "app-panel-hidden",
    shell: "app",
    path: "/",
    width: DEFAULT_WIDTH,
    hidden: true,
  },
  // Below 768px the sidebar is a sheet over the page, closed until asked for.
  {
    name: "app-narrowest",
    shell: "app",
    path: "/",
    width: NARROWEST_WIDTH,
  },
  {
    name: "app-narrowest-sheet",
    shell: "app",
    path: "/",
    width: NARROWEST_WIDTH,
    prepare: async (page) => {
      await page.getByRole("button", { name: "Show sidebar" }).click();
      await page.locator('[data-slot="strip"]').waitFor();
      // The sheet slides in; measure where it comes to rest.
      await page.waitForTimeout(600);
    },
  },
  {
    name: "app-banners",
    shell: "app",
    path: "/",
    width: DEFAULT_WIDTH,
    banners: true,
  },
  {
    name: "app-banners-hidden",
    shell: "app",
    path: "/",
    width: DEFAULT_WIDTH,
    hidden: true,
    banners: true,
  },
  { name: "admin", shell: "admin", path: "/admin", width: DEFAULT_WIDTH },
  {
    name: "admin-hidden",
    shell: "admin",
    path: "/admin",
    width: DEFAULT_WIDTH,
    hidden: true,
  },
  {
    name: "settings",
    shell: "settings",
    path: "/settings",
    width: DEFAULT_WIDTH,
  },
  {
    name: "settings-hidden",
    shell: "settings",
    path: "/settings",
    width: DEFAULT_WIDTH,
    hidden: true,
  },
];

const ORGANIZATION = "/api/v2/organizations/default";

/** The one conversation the person has, in the names the app's screens use. */
const CONVERSATION = {
  id: "c-1",
  name: "Research",
  agentIds: ["research"],
  threadId: "t-c-1",
  active: true,
  lastMessageAt: "2026-11-20T10:00:00.000Z",
  summary: "Single-word reply: kiwi",
  lastMessage: "kiwi",
  lastMessageAgentId: "research",
  createdAt: "2026-11-20T10:00:00.000Z",
  pinned: false,
  lastReadAt: "2026-11-20T10:00:00.000Z",
};

/** Gmail, as OpenBot Cloud's organization has it, for the move's app to reconnect. */
const APPS: AppsFixture = {
  servers: [
    {
      id: "composio-gmail",
      title: "Gmail",
      provenance: "composio",
      url: "composio://gmail",
      authScheme: "OAUTH2",
      accountMode: "personal",
      summary: "Read and send mail.",
    },
  ],
};

/** A finished move to OpenBot Cloud that left Gmail to connect again. */
const MOVE = {
  id: "imp_0e1f2a3b4c5d6f1d",
  status: "imported",
  sourceName: "Sam's MacBook",
  createdAt: "2026-11-21T10:00:00Z",
  finishedAt: "2026-11-21T10:03:12Z",
  recipientKey: {
    kty: "RSA",
    alg: "RSA-OAEP-256",
    kid: "imp_0e1f2a3b4c5d6f1d",
    e: "AQAB",
    n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
  },
  maxBundleBytes: 10737418240,
  maxPartBytes: 33554432,
  receivedParts: [1],
  reconnect: [
    { appId: "gmail", appName: "Gmail", accountLabel: "dana@example.com" },
  ],
};

/**
 * What the server answers: an admin of a company's own OpenBot with one conversation. With
 * `banners`, OpenBot Cloud after a move: Gmail to connect again, and the offer to self-host open.
 */
function answer(path: string, banners = false): unknown {
  if (banners) {
    switch (path) {
      case `${ORGANIZATION}/imports`:
        return ListImportsResponse.parse({ items: [MOVE], nextCursor: null });
      case `${ORGANIZATION}/people/me/connections`:
        return ListConnectionsResponse.parse({
          connections: [],
          nextCursor: null,
        });
      case `${ORGANIZATION}/people/me/preferences`:
        return GetPreferencesResponse.parse({
          messageListEmphasis: "thread",
          selfHostBannerDismissed: false,
          dismissedNotices: [],
          noticesDue: [],
          narration: null,
          skin: "openbot",
          proactive: "on",
        });
    }
  }
  switch (path) {
    case `${ORGANIZATION}/conversations`:
      return conversationPage([CONVERSATION]);
    case `${ORGANIZATION}/bots`:
      return {
        bots: ["Research", "Invoice Review"].map((name) => ({
          id: name.toLowerCase().replace(" ", "-"),
          name,
          title: "",
          roleDescription: "",
          avatarSeed: name,
          lastConversationAt: null,
        })),
        nextCursor: null,
      };
    case `${ORGANIZATION}/people/me/bot-attention`:
      return { attention: [], lastPingId: null, nextCursor: null };
    case `${ORGANIZATION}/people/me`:
      return {
        person: personBody({
          id: "dana",
          name: "Dana Whitfield",
          email: "dana@example.com",
          role: "admin",
        }),
        openbotVersion: "v1.1.0",
      };
    case `${ORGANIZATION}/deployment`:
      return {
        generativeUi: true,
        selfHostBanner: banners,
        localEvaluation: false,
        edition: "team",
        authProviders: [],
        ssoConfigured: false,
        ssoRequired: false,
        hostedSignIn: banners,
      };
    case "/api/v2/people/me/organizations":
      return {
        organizations: [
          {
            id: "default",
            slug: "default",
            name: "Acme Freight",
            role: "admin",
            personal: false,
            active: true,
          },
        ],
        canCreate: true,
        nextCursor: null,
      };
    case `${ORGANIZATION}/management`:
      return { state: "not-connected", agentInstalledByChart: true };
    default:
      return undefined;
  }
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "sidebar-window-buttons.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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

/** The desktop's macOS page script, read from its source, as the shell evaluates it in the page. */
const overlayScript = (() => {
  const source = readFileSync(
    join(APP, "..", "desktop", "src-tauri", "src", "main.rs"),
    "utf8",
  );
  const found = source.match(
    /const OVERLAY_TITLE_BAR_PAGE: &str = r#"([\s\S]*?)"#;/,
  );
  if (!found?.[1]) throw new Error("OVERLAY_TITLE_BAR_PAGE is not in main.rs");
  return found[1];
})();

let script: string;
let css: string;
/** Every change to the person's preferences the pages sent, such as closing a bar. */
const preferenceSaves: Record<string, unknown>[] = [];
const engines: [string, Browser][] = [];

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  // Every class the shells, sidebars and pages here can draw, read from their source.
  const sources = [
    ...["ui", "layout", "app-sidebar"].flatMap((dir) =>
      readdirSync(join(APP, "src", "components", dir))
        .filter((file) => file.endsWith(".tsx"))
        .map((file) => `components/${dir}/${file}`),
    ),
    "components/admin/admin-sidebar.tsx",
    "components/settings/settings-sidebar.tsx",
    "components/moves/moved-apps-notice.tsx",
    "components/agents/bot-orb.tsx",
    "../tests/sidebar-window-buttons.fixture.tsx",
  ].flatMap((file) =>
    readFileSync(join(APP, "src", file), "utf8").split(/[\s"'`]+/),
  );
  css = await stylesheet([...new Set(sources)].sort());
  const { chromium, webkit } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  engines.push(["chromium", await chromium.launch({ channel: "chromium" })]);
  if ((process.env.OPENBOT_APP_ENGINES ?? "").includes("webkit"))
    engines.push(["webkit", await (webkit as BrowserType).launch()]);
});

afterAll(async () => {
  for (const [, browser] of engines) await browser.close();
});

/** The case's shell, in a window marked as the macOS desktop marks it, or not. */
async function open(
  browser: Browser,
  shown: Case,
  macDesktop: boolean,
  theme: "light" | "dark" = "light",
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: shown.width, height: 640 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  const mark = macDesktop ? ' data-desktop-titlebar="overlay"' : "";
  const stored = shown.hidden
    ? `<script>localStorage.setItem("openbot-sidebar", "collapsed")</script>`
    : "";
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}"${mark}><head><meta charset="utf-8"><style>${css}</style>${stored}</head><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/shell.js"></script></body></html>`,
      });
    if (path === "/shell.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    // The app's own typeface, so a heading is as wide here as it is in the app.
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) {
      const method = route.request().method();
      if (method === "PATCH" && path.endsWith("/people/me/preferences")) {
        const sent = route.request().postDataJSON() as Record<string, unknown>;
        preferenceSaves.push(sent);
        return route.fulfill({
          json: GetPreferencesResponse.parse({
            messageListEmphasis: "thread",
            selfHostBannerDismissed: sent.selfHostBannerDismissed === true,
            dismissedNotices: [],
            noticesDue: [],
            narration: null,
            skin: "openbot",
            proactive: "on",
          }),
        });
      }
      const apps = shown.banners
        ? answerAppsApi(route.request().url(), { method }, APPS)
        : undefined;
      if (apps)
        return route.fulfill({ status: apps.status, json: await apps.json() });
      const json = answer(path, shown.banners);
      return json === undefined
        ? route.fulfill({ status: 404, json: { detail: "Not found." } })
        : route.fulfill({ json });
    }
    return route.fulfill({ status: 404 });
  });
  const search = new URLSearchParams({ shell: shown.shell, path: shown.path });
  await page.goto(`${ORIGIN}/?${search}`);
  await page.locator("[data-page]").waitFor();
  if (shown.banners) {
    await page.locator('aside[aria-label="Apps to reconnect"]').waitFor();
    await page.locator('aside[aria-label="Self-host OpenBot"]').waitFor();
  }
  await shown.prepare?.(page);
  // The strip's sections, once the person's menu has loaded (in a narrow window, once the sheet is open).
  if (shown.shell === "app" && (shown.width >= 768 || shown.prepare))
    await page.locator('[data-slot="strip"] nav a').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/**
 * What the window's buttons would cover: every control, picture and run of text drawn in their
 * area, named by its accessible name or its words.
 */
async function covered(page: Page): Promise<string[]> {
  return page.evaluate((area) => {
    const overlaps = (rect: DOMRect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left < area.right &&
      rect.right > area.left &&
      rect.top < area.bottom &&
      rect.bottom > area.top;
    /*
     * Drawn there and on top: the middle of its part under the buttons is the element itself or
     * inside it, not something over it (the page behind an open sheet, a screen reader's clipped
     * words).
     */
    const hits = (rect: DOMRect, owner: Element) => {
      if (!overlaps(rect)) return false;
      const x =
        (Math.max(rect.left, area.left) + Math.min(rect.right, area.right)) / 2;
      const y =
        (Math.max(rect.top, area.top) + Math.min(rect.bottom, area.bottom)) / 2;
      const top = document.elementFromPoint(x, y);
      return top !== null && (owner.contains(top) || top.contains(owner));
    };
    const seen = (element: Element) => {
      const style = getComputedStyle(element);
      return (
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        element.closest("[hidden], [aria-hidden=true][inert]") === null
      );
    };
    const found: string[] = [];
    for (const element of document.querySelectorAll(
      "a, button:not([data-slot=sidebar-rail]), [role=button], svg, img, input, textarea, .bot-orb-still",
    )) {
      if (!seen(element) || !hits(element.getBoundingClientRect(), element))
        continue;
      found.push(
        `${element.tagName.toLowerCase()} ${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""}`,
      );
    }
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const words = node.textContent?.trim();
      const parent = node.parentElement;
      if (!words || !parent || !seen(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if ([...range.getClientRects()].some((rect) => hits(rect, parent)))
        found.push(`text ${words}`);
    }
    return found;
  }, WINDOW_BUTTONS);
}

/**
 * Every place along the top of the sidebar, beside and below the window's buttons, where a press
 * neither moves the window nor reaches a control, after the desktop's macOS script has marked the
 * page. Pressed every 8px on two rows across the sidebar (the whole window while the sidebar is
 * hidden, when the page's top is the handle), leaving out the window's buttons themselves. Whether
 * a press drags is Tauri's own rule (tauri 2.12, window/scripts/drag.js `isDragRegion`), as
 * skins-window-buttons.test.tsx copies it: walking up from what was pressed, a button or link
 * without a mark stops it, "deep" drags from anything inside, and a bare mark drags only from the
 * marked element itself.
 */
async function deadTop(page: Page): Promise<string[]> {
  await page.evaluate(overlayScript);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(0))),
  );
  return page.evaluate((area) => {
    const DRAG = "data-tauri-drag-region";
    const CLICKABLE = new Set([
      "A",
      "BUTTON",
      "INPUT",
      "SELECT",
      "TEXTAREA",
      "LABEL",
      "SUMMARY",
    ]);
    const ROLES = new Set([
      "button",
      "link",
      "menuitem",
      "tab",
      "checkbox",
      "radio",
      "switch",
      "option",
    ]);
    const clickable = (el: HTMLElement) =>
      CLICKABLE.has(el.tagName) ||
      (el.hasAttribute("contenteditable") &&
        el.getAttribute("contenteditable") !== "false") ||
      (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
      ROLES.has(el.getAttribute("role") ?? "");
    const press = (target: Element) => {
      // An open sheet's scrim closes it when pressed, as it should.
      if (target.getAttribute("data-slot") === "sheet-overlay")
        return "control";
      for (let el: Element | null = target; el; el = el.parentElement) {
        if (!(el instanceof HTMLElement)) continue;
        const attr = el.getAttribute(DRAG);
        if (clickable(el) && attr === null) return "control";
        if (attr === null) continue;
        if (attr === "false") return "dead";
        if (attr === "deep") return "drag";
        if (attr === "" || attr === "true")
          return el === target ? "drag" : "dead";
      }
      return "dead";
    };
    // The sidebar as drawn: its inset panel beside the page, or the sheet over it.
    const sidebar =
      document.querySelector('[data-slot="sidebar"][data-mobile="true"]') ??
      document.querySelector('[data-slot="sidebar-inner"]');
    const hidden =
      document.querySelector(
        '[data-slot="sidebar-wrapper"] > [data-slot="sidebar"][data-state="collapsed"]',
      ) !== null;
    const box = sidebar?.getBoundingClientRect();
    // With no sidebar beside the page, the page's top across the window.
    const from = box && !hidden ? box.left + 2 : 2;
    const to = box && !hidden ? box.right - 2 : window.innerWidth - 2;
    const dead: string[] = [];
    for (const y of [12, 30]) {
      for (let x = from; x < to; x += 8) {
        if (
          x >= area.left &&
          x <= area.right &&
          y >= area.top &&
          y <= area.bottom
        )
          continue;
        const target = document.elementFromPoint(x, y);
        if (!target || press(target) !== "dead") continue;
        // The 8px of window tint around the inset page, and past its rounded corners, which no mark
        // makes a handle: a press there is lent one as it comes (`topStrip` presses it).
        const slot = target.getAttribute("data-slot");
        if (slot === "sidebar-wrapper" || slot === "sidebar-container")
          continue;
        const name =
          target.getAttribute("aria-label") ??
          target.getAttribute("data-slot") ??
          target.className;
        dead.push(
          `${Math.round(x)},${y} ${target.tagName.toLowerCase()} ${String(name).slice(0, 40)}`,
        );
      }
    }
    return dead;
  }, WINDOW_BUTTONS);
}

/**
 * What pressing across the window's top strip does, with the desktop's macOS script running, over
 * the sidebar and over the page beside it alike.
 *
 * The strip runs down to the lowest of: the sidebar's top row (the open panel's title, or the
 * sidebar's header), the bars over the page, and the page's own top bar (the app page's, or
 * `PageShell`'s while the sidebar is hidden). Each press is a real mousedown and mouseup at that
 * point, dispatched on what is drawn there, and what Tauri's drag script would do with it is read
 * (as `deadTop` reads it) from a listener on the document, where Tauri's own listens, so whatever
 * the desktop's script does before it on the way down is seen as Tauri sees it.
 *
 * `dead` lists every point that neither moves the window nor reaches a control; `controls` names
 * what each named control does when pressed; `below` is what a press under the strip, on the
 * middle of the page, does.
 */
async function topStrip(page: Page, controls: string[] = []) {
  await page.evaluate(overlayScript);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(0))),
  );
  return page.evaluate(
    ({ area, controls }) => {
      const DRAG = "data-tauri-drag-region";
      const CLICKABLE = new Set([
        "A",
        "BUTTON",
        "INPUT",
        "SELECT",
        "TEXTAREA",
        "LABEL",
        "SUMMARY",
      ]);
      const ROLES = new Set([
        "button",
        "link",
        "menuitem",
        "tab",
        "checkbox",
        "radio",
        "switch",
        "option",
      ]);
      const clickable = (el: HTMLElement) =>
        CLICKABLE.has(el.tagName) ||
        (el.hasAttribute("contenteditable") &&
          el.getAttribute("contenteditable") !== "false") ||
        (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
        ROLES.has(el.getAttribute("role") ?? "");
      // Tauri's `isDragRegion`, walking the pressed element's path as its listener does.
      const tauri = (path: readonly (EventTarget | undefined)[]) => {
        for (const el of path) {
          if (!(el instanceof HTMLElement)) continue;
          const attr = el.getAttribute(DRAG);
          if (clickable(el) && attr === null) return "control";
          if (attr === null) continue;
          if (attr === "false") return "dead";
          if (attr === "deep") return "drag";
          if (attr === "" || attr === "true")
            return el === path[0] ? "drag" : "dead";
        }
        return "dead";
      };
      const marks = document.querySelectorAll(`[${DRAG}]`).length;
      let seen = "dead";
      let lent = false;
      const listen = (event: MouseEvent) => {
        seen = tauri(event.composedPath());
      };
      document.addEventListener("mousedown", listen);
      const press = (target: Element, x: number, y: number) => {
        seen = "dead";
        const before = target.hasAttribute(DRAG);
        lent = false;
        const check = () => {
          lent = !before && target.hasAttribute(DRAG);
        };
        document.addEventListener("mousedown", check, { once: true });
        const init = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          button: 0,
          detail: 1,
        };
        target.dispatchEvent(new MouseEvent("mousedown", init));
        target.dispatchEvent(new MouseEvent("mouseup", init));
        // Nothing the press was lent is left behind.
        if (document.querySelectorAll(`[${DRAG}]`).length !== marks)
          return "left a mark";
        return seen;
      };

      const shownHere = (el: Element) => {
        const box = el.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return false;
        const x = Math.min(
          Math.max((box.left + box.right) / 2, 1),
          window.innerWidth - 1,
        );
        const y = Math.min(Math.max((box.top + box.bottom) / 2, 1), 400);
        const top = document.elementFromPoint(x, y);
        return top !== null && (el.contains(top) || top.contains(el));
      };
      // The sidebar beside the page, when it is: down to its top row (the window buttons' room
      // where the panel is folded away and only the strip shows).
      const beside = document.querySelector(
        '[data-slot="sidebar-wrapper"] > [data-slot="sidebar"] [data-slot="sidebar-inner"]',
      );
      const sidebarBox =
        beside && shownHere(beside) ? beside.getBoundingClientRect() : null;
      const sidebarBottom = Math.max(
        40,
        ...[
          ...document.querySelectorAll(
            '[data-slot="section-panel"]:not([hidden]) > [data-desktop-drag], [data-slot="sidebar-wrapper"] [data-slot="sidebar-header"]',
          ),
        ]
          .filter(shownHere)
          .map((el) => el.getBoundingClientRect().bottom),
      );
      // The page: down to the sidebar's top row, the bars over the page and the page's top bar.
      const bottoms = [sidebarBox ? sidebarBottom : 0];
      for (const el of document.querySelectorAll(
        "main > aside, [data-page-bar]",
      ))
        bottoms.push(el.getBoundingClientRect().bottom);
      const toggle = document.querySelector('main [aria-label="Show sidebar"]');
      if (toggle?.parentElement)
        bottoms.push(toggle.parentElement.getBoundingClientRect().bottom);
      const bottom = Math.max(...bottoms);

      const dead: string[] = [];
      const rows: number[] = [];
      for (let y = 2; y < bottom - 2; y += 6) rows.push(y);
      rows.push(Math.floor(bottom) - 2);
      for (const y of rows) {
        for (let x = 2; x < window.innerWidth - 2; x += 8) {
          if (sidebarBox && x < sidebarBox.right && y >= sidebarBottom - 2)
            continue;
          if (
            x >= area.left &&
            x <= area.right &&
            y >= area.top &&
            y <= area.bottom
          )
            continue;
          const target = document.elementFromPoint(x, y);
          if (!target) continue;
          const did = press(target, x, y);
          if (did === "drag" || did === "control") continue;
          const name =
            target.getAttribute("aria-label") ??
            target.getAttribute("data-slot") ??
            target.className;
          dead.push(
            `${Math.round(x)},${y} ${did} ${target.tagName.toLowerCase()} ${String(name).slice(0, 40)}`,
          );
        }
      }

      const pressed: Record<string, string> = {};
      for (const name of controls) {
        const el = [...document.querySelectorAll("main button, main a")].find(
          (each) =>
            (each.getAttribute("aria-label") ?? each.textContent?.trim()) ===
            name,
        );
        if (!el) {
          pressed[name] = "missing";
          continue;
        }
        const box = el.getBoundingClientRect();
        const x = (box.left + box.right) / 2;
        const y = (box.top + box.bottom) / 2;
        const target = document.elementFromPoint(x, y);
        pressed[name] = target
          ? `${y < bottom ? "in the strip" : "below it"}: ${press(target, x, y)}`
          : "not drawn";
      }

      const main = document.querySelector(
        '[data-slot="sidebar-wrapper"] > main',
      );
      const box = main?.getBoundingClientRect();
      const x = box ? (box.left + box.right) / 2 : 0;
      const y = Math.max(bottom + 40, window.innerHeight - 60);
      const under = document.elementFromPoint(x, y);
      if (under) press(under, x, y);
      // Under the strip a press is never lent the mark: what it does is what it always did.
      const below = under
        ? lent
          ? "lent the mark"
          : "as before"
        : "not drawn";
      document.removeEventListener("mousedown", listen);
      return { dead, controls: pressed, below };
    },
    { area: WINDOW_BUTTONS, controls },
  );
}

/** Where the corner's pieces start, rounded to the pixel: the orb, the panel's heading, Back to app. */
async function corner(page: Page) {
  return page.evaluate(() => {
    const at = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: Math.round(box.left), y: Math.round(box.top) };
    };
    return {
      orb: at('[data-slot="strip"] .bot-orb-still'),
      firstSection: at('[data-slot="strip"] nav > *'),
      heading: at('[data-slot="section-panel"]:not([hidden]) h2'),
      back: at('[data-slot="sidebar-header"] a'),
    };
  });
}

/** The window's buttons drawn where macOS puts them, since a browser draws none of its own. */
async function drawButtons(page: Page) {
  await page.evaluate((area) => {
    const row = document.createElement("div");
    Object.assign(row.style, {
      position: "fixed",
      left: `${area.left}px`,
      top: `${area.top}px`,
      width: `${area.right - area.left}px`,
      height: `${area.bottom - area.top}px`,
      display: "flex",
      gap: "8px",
      alignItems: "center",
      padding: "0 2px",
      zIndex: "2147483647",
      pointerEvents: "none",
    });
    for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
      const dot = document.createElement("span");
      Object.assign(dot.style, {
        width: "12px",
        height: "12px",
        borderRadius: "50%",
        background: color,
        boxShadow: "inset 0 0 0 0.5px rgb(0 0 0 / 0.2)",
      });
      row.append(dot);
    }
    document.body.append(row);
  }, WINDOW_BUTTONS);
}

describe.skipIf(!asked)("the sidebar and the window's buttons", () => {
  for (const shown of CASES) {
    test(`${shown.name}: in the macOS desktop, nothing is drawn under the window's buttons and the top moves the window`, async () => {
      for (const [engine, browser] of engines) {
        const page = await open(browser, shown, true);
        try {
          expect({ engine, covered: await covered(page) }).toEqual({
            engine,
            covered: [],
          });
          expect({ engine, dead: await deadTop(page) }).toEqual({
            engine,
            dead: [],
          });
        } finally {
          await page.close();
        }
      }
    }, 120_000);
  }

  /*
   * The window moves from its whole top strip, over the page as well as over the sidebar. MEASURED
   * in OpenBot Desktop on a Mac: only the top of the sidebar moved it, and a press over the page
   * beside it (on the bars over the page, the page's top bar, the window's tint above them) did
   * nothing. The controls in the strip stay controls. Not the open sheet's case: there the scrim
   * covers the page, and pressing it closes the sheet (`deadTop` covers the sheet's own top).
   */
  for (const shown of CASES.filter((each) => !each.prepare)) {
    test(`${shown.name}: in the macOS desktop, the window's whole top strip moves the window, its controls stay controls`, async () => {
      const controls = [
        ...(shown.banners ? ["Reconnect", "Book a call", "Dismiss"] : []),
        ...(shown.shell === "app" ? ["This conversation's Bot"] : []),
        ...(shown.hidden || shown.width < 768 ? ["Show sidebar"] : []),
      ];
      for (const [engine, browser] of engines) {
        const page = await open(browser, shown, true);
        try {
          expect({ engine, ...(await topStrip(page, controls)) }).toEqual({
            engine,
            dead: [],
            controls: Object.fromEntries(
              controls.map((name) => [name, "in the strip: control"]),
            ),
            below: "as before",
          });
        } finally {
          await page.close();
        }
      }
    }, 120_000);
  }

  test("in the macOS desktop, the bars' controls in the top strip still do what they say", async () => {
    for (const [engine, browser] of engines) {
      const shown = CASES.find((each) => each.name === "app-banners") as Case;
      const page = await open(browser, shown, true);
      try {
        await page.evaluate(overlayScript);
        preferenceSaves.length = 0;
        await page
          .locator('aside[aria-label="Self-host OpenBot"]')
          .getByRole("button", { name: "Dismiss" })
          .click();
        await page
          .locator('aside[aria-label="Self-host OpenBot"]')
          .waitFor({ state: "detached" });
        expect({ engine, saves: preferenceSaves }).toEqual({
          engine,
          saves: [{ selfHostBannerDismissed: true }],
        });
        // Reconnect leads to the list, where the bar no longer shows.
        await page
          .locator('aside[aria-label="Apps to reconnect"] a', {
            hasText: "Reconnect",
          })
          .click();
        await page
          .locator('aside[aria-label="Apps to reconnect"]')
          .waitFor({ state: "detached" });
      } finally {
        await page.close();
      }
    }
  }, 120_000);

  test("in the macOS desktop, the orb and the panel's heading start below the window's buttons", async () => {
    for (const [engine, browser] of engines) {
      const page = await open(browser, CASES[0] as Case, true);
      try {
        const { orb, heading, firstSection } = await corner(page);
        expect({ engine, orb: (orb?.y ?? 0) > WINDOW_BUTTONS.bottom }).toEqual({
          engine,
          orb: true,
        });
        expect({
          engine,
          heading: (heading?.y ?? 0) > WINDOW_BUTTONS.bottom,
        }).toEqual({ engine, heading: true });
        // The strip and the panel move down together, so the orb stays level with the heading.
        expect(Math.abs((orb?.y ?? 0) - (heading?.y ?? 0))).toBeLessThan(12);
        expect(firstSection?.y ?? 0).toBeGreaterThan(orb?.y ?? 0);
      } finally {
        await page.close();
      }
    }
  }, 120_000);

  test("without the mark, on Windows or in a browser, every corner is where it has always been", async () => {
    // Measured on main without the mark, so a sidebar that moves outside the desktop fails. Measured
    // again after the strip was redrawn wider (#2124), which moved its pieces on purpose.
    const before: Record<string, Awaited<ReturnType<typeof corner>>> = {
      "app-conversations": {
        orb: { x: 22, y: 22 },
        firstSection: { x: 8, y: 64 },
        heading: { x: 80, y: 21 },
        back: null,
      },
      admin: {
        orb: null,
        firstSection: null,
        heading: null,
        back: { x: 16, y: 16 },
      },
    };
    for (const [engine, browser] of engines) {
      const seen: Record<string, Awaited<ReturnType<typeof corner>>> = {};
      for (const name of Object.keys(before)) {
        const shown = CASES.find((each) => each.name === name) as Case;
        const page = await open(browser, shown, false);
        try {
          seen[name] = await corner(page);
        } finally {
          await page.close();
        }
      }
      expect({ engine, seen }).toEqual({ engine, seen: before });
    }
  }, 120_000);

  test.skipIf(!shots)(
    "screenshots of each corner",
    async () => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      for (const [engine, browser] of engines) {
        for (const shown of CASES) {
          const page = await open(browser, shown, true);
          try {
            await drawButtons(page);
            await page.screenshot({
              path: join(
                shots,
                `sidebar-window-buttons-${engine}-${shown.name}.png`,
              ),
              clip: { x: 0, y: 0, width: 480, height: 240 },
              animations: "disabled",
            });
          } finally {
            await page.close();
          }
        }
      }
    },
    240_000,
  );
});
