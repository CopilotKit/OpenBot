import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Locator, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { personBody } from "./accounts-api";
import { conversationPage } from "./conversations-api";

/**
 * A conversation with a Bot starts from the Bots panel, under the Bot.
 *
 * Reported from dogfooding, on the web: "you can't start a conversation with a bot from the Bot
 * panel (or at least it's confusing enough that I wasn't able to find it)". Each Bot in the panel
 * said "No conversations with this Bot yet." with nothing to click; the only way in was the Bot's
 * name, its page, and Message there. Now a Bot with none says "Start one", and a Bot with some has a
 * New conversation row first under it. Both open a new conversation with that Bot, as its page's
 * Message does.
 *
 * Rendered in a real browser, because what was wrong is what a person sees and clicks. The strip,
 * the panel and the shell are the app's own, with the app's stylesheet
 * (bots-panel-start-conversation.fixture.tsx); only OpenBot's API is the routes below.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/bots-panel-start-conversation.test.tsx
 *
 * Chromium always, WebKit too (the engine OpenBot Desktop's Mac window draws with) when
 * `OPENBOT_APP_ENGINES` names it. With OPENBOT_APP_SHOTS=<dir> it saves the panel, light and dark,
 * in a desktop window and a narrow one, as bots-panel-<engine>-<width>-<theme>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const ORGANIZATION = "/api/v2/organizations/default";

const bot = (id: string, name: string, lastConversationAt: string | null) => ({
  id,
  name,
  title: "",
  roleDescription: "",
  avatarSeed: name,
  lastConversationAt,
});

/** The three Bots of the report; Chief of Staff has one conversation, the others none. */
const BOTS = [
  bot("chief-of-staff", "Chief of Staff", "2026-11-20T10:00:00.000Z"),
  bot("general-assistant", "General Assistant", null),
  bot("knowledge", "Knowledge", null),
];

const CONVERSATION = {
  id: "c-1",
  name: "",
  agentIds: ["chief-of-staff"],
  threadId: "t-c-1",
  active: true,
  lastMessageAt: "2026-11-20T10:00:00.000Z",
  summary: "Weekly priorities",
  lastMessage: "Weekly priorities",
  lastMessageAgentId: "chief-of-staff",
  createdAt: "2026-11-20T10:00:00.000Z",
  pinned: false,
  lastReadAt: "2026-11-20T10:00:00.000Z",
};

/** What the server answers: a person of a company's own OpenBot with the three Bots. */
function answer(path: string, search: URLSearchParams): unknown {
  switch (path) {
    case `${ORGANIZATION}/conversations`:
      return conversationPage(
        search.get("botId") === "chief-of-staff" ? [CONVERSATION] : [],
      );
    case `${ORGANIZATION}/bots`:
      return { bots: BOTS, nextCursor: null };
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
    entrypoints: [
      join(import.meta.dir, "bots-panel-start-conversation.fixture.tsx"),
    ],
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
    "../tests/bots-panel-start-conversation.fixture.tsx",
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

/** The app opened on the Bots page, its panel beside it; in a narrow window, the sheet opened. */
async function open(
  browser: Browser,
  {
    theme = "light",
    width = 1000,
  }: { theme?: "light" | "dark"; width?: number } = {},
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width, height: width < 768 ? 820 : 640 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const at = url.pathname;
    if (at === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/shell.js"></script></body></html>`,
      });
    if (at === "/shell.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, at.split("/").pop() ?? "");
    if (at.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (at.startsWith("/api/")) {
      const json = answer(at, url.searchParams);
      return json === undefined
        ? route.fulfill({ status: 404, json: { detail: "Not found." } })
        : route.fulfill({ json });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/?${new URLSearchParams({ path: "/bots" })}`);
  await page.locator("[data-page]").waitFor();
  if (width < 768)
    await page
      .getByRole("button", { name: "Show sidebar" })
      .filter({ visible: true })
      .first()
      .click();
  // Every Bot's conversations read: Chief of Staff's one, and the others' none.
  await panel(page).getByText("Weekly priorities").waitFor();
  await panel(page)
    .getByText("No conversations with this Bot yet.", { exact: false })
    .nth(1)
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** The Bots panel, the one section panel on screen with the heading Bots. */
function panel(page: Page): Locator {
  return page.locator('[data-slot="section-panel"]', {
    has: page.getByRole("heading", { level: 2, name: "Bots" }),
  });
}

/** One Bot's entry in the panel: its row and what is open under it. */
function botItem(page: Page, name: string): Locator {
  return panel(page)
    .locator("li")
    .filter({ has: page.locator('[data-slot="bot-row"]', { hasText: name }) });
}

/** Where the app is now, and which Bot a new conversation there is for. */
async function where(page: Page) {
  return page.evaluate(() => {
    const shown = document.querySelector("[data-page]");
    return {
      page: shown?.getAttribute("data-page") ?? null,
      agent: shown?.getAttribute("data-agent") ?? null,
    };
  });
}

describe.skipIf(!asked)("starting a conversation from the Bots panel", () => {
  test("a Bot with no conversations says Start one, which opens a new conversation with that Bot", async () => {
    for (const [engine, browser] of engines) {
      const page = await open(browser);
      try {
        const general = botItem(page, "General Assistant");
        expect({ engine, says: (await general.textContent())?.trim() }).toEqual(
          {
            engine,
            says: "General AssistantNo conversations with this Bot yet. Start one.",
          },
        );
        // A link in the sentence, drawn as the app's other inline links: underlined, muted text.
        const start = general.getByRole("link", {
          name: "Start one with General Assistant",
        });
        expect(
          await start.evaluate((link) => {
            const style = getComputedStyle(link);
            const sentence = getComputedStyle(link.parentElement as Element);
            return {
              underlined: style.textDecorationLine.includes("underline"),
              sameColour: style.color === sentence.color,
              // Never split over two lines, where it reads as two links.
              oneLine: link.getClientRects().length === 1,
            };
          }),
        ).toEqual({ underlined: true, sameColour: true, oneLine: true });
        await start.click();
        await page.locator('[data-page="/channel/new"]').waitFor();
        expect({ engine, ...(await where(page)) }).toEqual({
          engine,
          page: "/channel/new",
          agent: "general-assistant",
        });
      } finally {
        await page.close();
      }
    }
  }, 120_000);

  test("a Bot with conversations has New conversation first under it, opening a new one with that Bot", async () => {
    for (const [engine, browser] of engines) {
      const page = await open(browser);
      try {
        const chief = botItem(page, "Chief of Staff");
        const under = chief.locator('[data-slot="bot-row"] ~ div a');
        expect({ engine, rows: await under.allTextContents() }).toEqual({
          engine,
          rows: [
            "New conversation",
            expect.stringContaining("Weekly priorities"),
          ],
        });
        // The same row as Show more, the one other row in that list that is not a conversation.
        const row = chief.getByRole("link", {
          name: "New conversation with Chief of Staff",
        });
        const conversationRow = chief.locator(
          '[data-slot="bot-conversation-row"]',
        );
        const [rowBox, conversationBox] = await Promise.all([
          row.boundingBox(),
          conversationRow.boundingBox(),
        ]);
        expect({
          engine,
          sameLeft: rowBox?.x === conversationBox?.x,
          sameWidth: rowBox?.width === conversationBox?.width,
        }).toEqual({ engine, sameLeft: true, sameWidth: true });
        await row.click();
        await page.locator('[data-page="/channel/new"]').waitFor();
        expect({ engine, ...(await where(page)) }).toEqual({
          engine,
          page: "/channel/new",
          agent: "chief-of-staff",
        });
      } finally {
        await page.close();
      }
    }
  }, 120_000);

  test("in a narrow window, Start one closes the sidebar over the new conversation", async () => {
    for (const [engine, browser] of engines) {
      const page = await open(browser, { width: 400 });
      try {
        await botItem(page, "Knowledge")
          .getByRole("link", { name: "Start one with Knowledge" })
          .click();
        await page.locator('[data-page="/channel/new"]').waitFor();
        await page
          .locator('[data-slot="sidebar"][data-mobile="true"]')
          .waitFor({ state: "detached" });
        expect({ engine, ...(await where(page)) }).toEqual({
          engine,
          page: "/channel/new",
          agent: "knowledge",
        });
      } finally {
        await page.close();
      }
    }
  }, 120_000);

  test.skipIf(!shots)(
    "screenshots of the Bots panel, light and dark, in a desktop window and a narrow one",
    async () => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      for (const [engine, browser] of engines) {
        for (const width of [1000, 400]) {
          for (const theme of ["light", "dark"] as const) {
            const page = await open(browser, { theme, width });
            try {
              await page.mouse.move(width - 5, 600);
              await page.waitForTimeout(400);
              await page.screenshot({
                path: join(
                  shots,
                  `bots-panel-${engine}-${width < 768 ? "narrow" : "desktop"}-${theme}.png`,
                ),
                clip:
                  width < 768
                    ? { x: 0, y: 0, width, height: 520 }
                    : { x: 0, y: 0, width: 520, height: 460 },
                animations: "disabled",
              });
            } finally {
              await page.close();
            }
          }
        }
      }
    },
    240_000,
  );
});
