import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { personBody } from "./accounts-api";
import { conversationPage } from "./conversations-api";

/**
 * On Routines, a section with no panel, the strip lights Routines, and it can always be chosen
 * again after another section's panel was opened over the page.
 *
 * Reported from dogfooding: "Clicking routine icon on the sidebar changes the view but doesn't change
 * the highlighted icon. Actually unable to get the routine icon to be selected." The page was
 * Routines, and the strip had Bots lit with the Bots panel beside it. Two causes. On Routines, Bots
 * on the strip opened Conversations' panel instead: opening the panel on a page whose section has
 * none asks the frame for a section that has one, Conversations, and that was asked last. And once
 * Bots was open there, Routines' icon did nothing at all: its link went to the page already open, so
 * no new page came to take the strip back from Bots.
 *
 * Rendered in a real browser, because what is wrong is what a person sees and clicks: the icon lit,
 * the panel folded or not. The strip, the panels and the shell are the app's own, with the app's
 * stylesheet (section-strip-routines.fixture.tsx); only OpenBot's API is the routes below.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/section-strip-routines.test.tsx
 *
 * Chromium always, WebKit too (the engine OpenBot Desktop's Mac window draws with) when
 * `OPENBOT_APP_ENGINES` names it. With OPENBOT_APP_SHOTS=<dir> it saves the strip and the panel on
 * Routines, after Conversations, Bots and then Routines, as section-strip-routines-<engine>-<theme>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const ORGANIZATION = "/api/v2/organizations/default";

/** The person's one conversation, in the names the app's screens use. */
const CONVERSATION = {
  id: "c-1",
  name: "Slack mention monitoring",
  agentIds: ["general-assistant"],
  threadId: "t-c-1",
  active: true,
  lastMessageAt: "2026-11-20T10:00:00.000Z",
  summary: "Watching for mentions",
  lastMessage: "Watching for mentions",
  lastMessageAgentId: "general-assistant",
  createdAt: "2026-11-20T10:00:00.000Z",
  pinned: false,
  lastReadAt: "2026-11-20T10:00:00.000Z",
};

/** What the server answers: a person of a company's own OpenBot with one Bot and its conversation. */
function answer(path: string): unknown {
  switch (path) {
    case `${ORGANIZATION}/conversations`:
      return conversationPage([CONVERSATION]);
    case `${ORGANIZATION}/bots`:
      return {
        bots: [
          {
            id: "general-assistant",
            name: "General Assistant",
            title: "",
            roleDescription: "",
            avatarSeed: "General Assistant",
            lastConversationAt: "2026-11-20T10:00:00.000Z",
          },
        ],
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
          role: "user",
        }),
        openbotVersion: "v1.2.0",
      };
    case `${ORGANIZATION}/deployment`:
      return {
        generativeUi: true,
        selfHostBanner: false,
        localEvaluation: false,
        edition: "team",
        authProviders: [],
        ssoConfigured: false,
        ssoRequired: false,
      };
    case "/api/v2/people/me/organizations":
      return {
        organizations: [
          {
            id: "default",
            slug: "default",
            name: "Acme Freight",
            role: "user",
            personal: false,
            active: true,
          },
        ],
        canCreate: true,
        nextCursor: null,
      };
    default:
      return undefined;
  }
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "section-strip-routines.fixture.tsx")],
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

let script: string;
let css: string;
const engines: [string, Browser][] = [];

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  // Every class the shell, the strip, the panels and the page here can draw, read from their source.
  const sources = [
    ...["ui", "layout", "app-sidebar", "bot-profile", "agents"].flatMap((dir) =>
      readdirSync(join(APP, "src", "components", dir))
        .filter((file) => file.endsWith(".tsx"))
        .map((file) => `components/${dir}/${file}`),
    ),
    "components/browser/browser-nav-item.tsx",
    "../tests/section-strip-routines.fixture.tsx",
  ].flatMap((file) =>
    readFileSync(join(APP, "src", file), "utf8").split(/[\s"'`]+/),
  );
  css = await stylesheet([...new Set(sources)].sort());
  const { chromium, webkit } = await import("playwright-core");
  // The CI job installs full Chromium without the headless shell.
  engines.push(["chromium", await chromium.launch({ channel: "chromium" })]);
  if ((process.env.OPENBOT_APP_ENGINES ?? "").includes("webkit"))
    engines.push(["webkit", await (webkit as BrowserType).launch()]);
}, 120_000);

afterAll(async () => {
  for (const [, browser] of engines) await browser.close();
});

/** The app opened on `path`, in a window as wide as OpenBot Desktop's by default. */
async function open(
  browser: Browser,
  path: string,
  theme: "light" | "dark" = "light",
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 640 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const at = new URL(route.request().url()).pathname;
    if (at === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/shell.js"></script></body></html>`,
      });
    if (at === "/shell.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, at.split("/").pop() ?? "");
    if (at.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (at.startsWith("/api/")) {
      const json = answer(at);
      return json === undefined
        ? route.fulfill({ status: 404, json: { detail: "Not found." } })
        : route.fulfill({ json });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/?${new URLSearchParams({ path })}`);
  await page.locator("[data-page]").waitFor();
  // The strip's sections, once the person's menu has loaded.
  await strip(page).getByRole("link", { name: "Routines" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

function strip(page: Page) {
  return page.locator('[data-slot="strip"]');
}

/** Click a section's icon on the strip, then move the pointer off it so no tooltip stays. */
async function choose(page: Page, name: "Conversations" | "Bots" | "Routines") {
  const item =
    name === "Routines"
      ? strip(page).getByRole("link", { name, exact: true })
      : strip(page).getByRole("button", { name, exact: true });
  await item.click();
  await page.mouse.move(700, 500);
}

/** What a person sees: which icons are lit, whether the panel shows, and whose it is. */
async function seen(page: Page) {
  return page.evaluate(() => {
    const item = (selector: string) =>
      document.querySelector(`[data-slot="strip"] ${selector}`);
    const routines = item('a[href="/routines"]');
    const bots = [
      ...document.querySelectorAll('[data-slot="strip"] button'),
    ].find((button) => button.textContent?.trim() === "Bots");
    const sidebar = document.querySelector(
      '[data-slot="sidebar-wrapper"] > [data-slot="sidebar"]',
    );
    const inner = document.querySelector('[data-slot="sidebar-inner"]');
    const stripBox = document
      .querySelector('[data-slot="strip"]')
      ?.getBoundingClientRect();
    const innerBox = inner?.getBoundingClientRect();
    // The panel's heading, drawn beside the strip and not folded away or hidden.
    const panel = [
      ...document.querySelectorAll('[data-slot="sidebar-inner"] h2'),
    ].find((heading) => {
      const box = heading.getBoundingClientRect();
      return (
        heading.closest("[hidden]") === null &&
        box.width > 0 &&
        innerBox !== undefined &&
        box.left < innerBox.right - 1
      );
    });
    return {
      routinesLit: routines?.hasAttribute("data-active") ?? false,
      routinesCurrent: routines?.getAttribute("aria-current") ?? null,
      botsLit: bots?.getAttribute("aria-pressed") ?? null,
      sidebar: sidebar?.getAttribute("data-state") ?? null,
      // Folded away, the sidebar is the strip and its gutter; open, the panel takes the rest.
      panelShown:
        stripBox !== undefined &&
        innerBox !== undefined &&
        innerBox.width > stripBox.width + 40,
      panel: panel?.textContent?.trim() ?? null,
    };
  });
}

type Seen = Awaited<ReturnType<typeof seen>>;

/** Routines lit and current, Bots not, and the panel folded away: a section with no panel. */
const ON_ROUTINES: Seen = {
  routinesLit: true,
  routinesCurrent: "page",
  botsLit: "false",
  sidebar: "collapsed",
  panelShown: false,
  panel: null,
};

/** Bots lit with its panel beside Routines, which stays the page (and so is still said current). */
const BOTS_OVER_ROUTINES: Seen = {
  routinesLit: false,
  routinesCurrent: "page",
  botsLit: "true",
  sidebar: "expanded",
  panelShown: true,
  panel: "Bots",
};

/** What the page shows once the sidebar has finished moving, or what it last showed. */
async function settled(page: Page, want: Seen): Promise<Seen> {
  const deadline = Date.now() + 3_000;
  let now = await seen(page);
  while (Date.now() < deadline) {
    if (JSON.stringify(now) === JSON.stringify(want)) return now;
    await page.waitForTimeout(50);
    now = await seen(page);
  }
  return now;
}

describe.skipIf(!asked)("Routines on the strip", () => {
  test("opened directly, Routines is lit and current and the panel is folded away", async () => {
    for (const [engine, browser] of engines) {
      const page = await open(browser, "/routines");
      try {
        expect({ engine, ...(await settled(page, ON_ROUTINES)) }).toEqual({
          engine,
          ...ON_ROUTINES,
        });
      } finally {
        await page.close();
      }
    }
  }, 120_000);

  test("on Routines, Bots lights Bots with its panel, Routines lights Routines again, and back", async () => {
    for (const [engine, browser] of engines) {
      const page = await open(browser, "/routines");
      try {
        await choose(page, "Bots");
        expect({
          engine,
          step: "Bots",
          ...(await settled(page, BOTS_OVER_ROUTINES)),
        }).toEqual({ engine, step: "Bots", ...BOTS_OVER_ROUTINES });
        await choose(page, "Routines");
        expect({
          engine,
          step: "Routines",
          ...(await settled(page, ON_ROUTINES)),
        }).toEqual({ engine, step: "Routines", ...ON_ROUTINES });
        await choose(page, "Bots");
        expect({
          engine,
          step: "Bots again",
          ...(await settled(page, BOTS_OVER_ROUTINES)),
        }).toEqual({ engine, step: "Bots again", ...BOTS_OVER_ROUTINES });
        await choose(page, "Routines");
        expect({
          engine,
          step: "Routines again",
          ...(await settled(page, ON_ROUTINES)),
        }).toEqual({ engine, step: "Routines again", ...ON_ROUTINES });
        // All of it on the one page: the strip never took the person anywhere else.
        expect(
          await page.locator("[data-page]").getAttribute("data-page"),
        ).toBe("/routines");
      } finally {
        await page.close();
      }
    }
  }, 120_000);

  // The second cause alone: Bots reached by way of Conversations' panel, as it was in the report.
  test("on Routines, Conversations, Bots and then Routines lights Routines again", async () => {
    for (const [engine, browser] of engines) {
      const page = await open(browser, "/routines");
      try {
        await choose(page, "Conversations");
        await choose(page, "Bots");
        expect({
          engine,
          step: "Bots",
          ...(await settled(page, BOTS_OVER_ROUTINES)),
        }).toEqual({ engine, step: "Bots", ...BOTS_OVER_ROUTINES });
        await choose(page, "Routines");
        expect({
          engine,
          step: "Routines",
          ...(await settled(page, ON_ROUTINES)),
        }).toEqual({ engine, step: "Routines", ...ON_ROUTINES });
      } finally {
        await page.close();
      }
    }
  }, 120_000);

  test("from home, Bots and then Routines opens Routines with Routines lit", async () => {
    for (const [engine, browser] of engines) {
      const page = await open(browser, "/");
      try {
        await choose(page, "Bots");
        await choose(page, "Routines");
        await page.locator('[data-page="/routines"]').waitFor();
        expect({ engine, ...(await settled(page, ON_ROUTINES)) }).toEqual({
          engine,
          ...ON_ROUTINES,
        });
      } finally {
        await page.close();
      }
    }
  }, 120_000);

  test.skipIf(!shots)(
    "screenshots of the strip and the panel on Routines, after Conversations, Bots and then Routines",
    async () => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      for (const [engine, browser] of engines) {
        for (const theme of ["light", "dark"] as const) {
          const page = await open(browser, "/routines", theme);
          try {
            await choose(page, "Conversations");
            await choose(page, "Bots");
            await choose(page, "Routines");
            await page.waitForTimeout(400);
            await page.screenshot({
              path: join(
                shots,
                `section-strip-routines-${engine}-${theme}.png`,
              ),
              clip: { x: 0, y: 0, width: 640, height: 400 },
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
