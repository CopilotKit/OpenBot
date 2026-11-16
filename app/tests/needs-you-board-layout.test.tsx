import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotAttention, answerBotsList, attentionOf } from "./bots-api";
import {
  CONVERSATIONS_PATH,
  conversationPage,
  taskOf,
} from "./conversations-api";
import { answerScheduleLists, pathOf } from "./schedules-api";

/**
 * A row of the Needs you board is read whole at a phone's width and a chat's.
 *
 * FOUND LIVE at 390px: a task waiting on a question, answered from its row, drew its Answer, Dismiss,
 * Mark done and Open beside its words, and the words had what was left: the title read "P..", and
 * "Needs input · 39 seconds ago · Your choice determines where to plan the dinner." ran down the row
 * a word to a line. A row now stacks where it is narrow: its title and status in full across the
 * row, its answers on a line of their own under them, and what is left of its actions (Mark done,
 * Open) in a menu when they do not fit on that line too.
 *
 * Drawn in a real browser, in the app's real frame, because where a row wraps is the browser's
 * layout to decide. The Bots page and a Bot's page each hold: a task waiting on a question, a task
 * waiting on an approval, a task that couldn't finish, and a question asked outside any task. Each
 * is checked at a phone's width (390), a chat's (650) and a narrow window's (768, where the sidebar
 * is beside the page): no row's words are cut or squeezed, no button sits on them or outside its
 * row, a row's buttons keep to one line, and every action is still on the row or in its menu.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/needs-you-board-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each page is saved as <page>-<engine>-<theme>-<width>.png, light and dark.
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
const ORIGIN = "http://openbot.test";
const ORGANIZATION = "/api/v2/organizations/default";
const TASKS = `${ORGANIZATION}/tasks`;

const WIDTHS = [390, 650, 768] as const;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const NOW = new Date().toISOString();

const DINNER = "Plan a Seattle team dinner for twelve people next Friday";
const SEEDS = "Order the basil and tomato seeds from Fernhill Garden Supply";
const CATERERS = "Compare quotes from the three caterers";
/*
 * A task the person stopped. Its line says what stopping did; cut to one line at 390 it read "You
 * stopped this. Anything it had already..." (found in the big test's fix pass).
 */
const STOPPED = "Draft the EU customer refunds guide";
const ASKED =
  "Which Seattle neighbourhood would you prefer for the team dinner: Capitol Hill, Ballard or Fremont?";
const REPORT =
  "Should I send the weekly report to the whole team or only to Dana?";

const task = (
  id: string,
  title: string,
  status: string,
  rest: Record<string, unknown> = {},
) =>
  taskOf({
    id,
    agentId: "inbox",
    channelId: `c-${id}`,
    threadId: `t-${id}`,
    title,
    why: null,
    origin: "delegated",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    originChannelId: "c-main",
    status,
    failure: null,
    failedAt: null,
    next: null,
    resolvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
  });

const TASK_LIST = [
  task("q", DINNER, "needs_input", {
    next: `Waiting for your answer: ${ASKED}`,
  }),
  task("a", SEEDS, "needs_input", {
    next: "Waiting for your approval: click the button “Place order” on shop.example",
  }),
  task("s", STOPPED, "failed", {
    failure: "you stopped it",
    failedAt: NOW,
    stoppedAt: NOW,
  }),
  task("f", CATERERS, "failed", {
    failure: "the caterers' site didn't answer",
    failedAt: NOW,
  }),
];

const INBOX = {
  enabled: true,
  questions: [
    {
      id: "question-q",
      botId: "inbox",
      threadId: "t-q",
      channelId: "c-q",
      question: ASKED,
      why: "Your choice determines where to plan the dinner.",
    },
    {
      id: "question-x",
      botId: "inbox",
      threadId: "t-x",
      channelId: "c-x",
      question: REPORT,
      why: "Dana asked for it by Friday.",
    },
  ],
  requests: [
    {
      id: "r-a",
      action: {
        botId: "inbox",
        toolRef: "computer_click",
        effect: "write",
        scope: "shop.example",
        threadId: "t-a",
        args: { element: "Place order" },
        target: null,
        policy: {
          behaviour: "ask",
          source: "kind",
          reason: "Paying, buying or moving money asks you first.",
        },
      },
    },
  ],
};

const BOT = {
  ...getGetBotResponseMock().bot,
  id: "inbox",
  name: "Inbox Bot",
  mine: true,
  canManage: true,
};

/** The API's answer to one request, as the routes of a real server would give it. */
async function answer(
  url: string,
  method: string,
): Promise<{ status: number; body: string } | undefined> {
  const path = pathOf(url);
  const json = (value: unknown) => ({
    status: 200,
    body: JSON.stringify(value),
  });
  if (method !== "GET") return json({});
  if (path === TASKS) return json({ tasks: TASK_LIST, nextCursor: null });
  if (path === CONVERSATIONS_PATH) return json(conversationPage([]));
  const served =
    approvalInboxResponse(url, INBOX) ??
    answerScheduleLists(url, { method }) ??
    answerBotsList(url, { method }, { visible: [BOT] }) ??
    answerBotAttention(
      url,
      { method },
      {
        bots: [
          attentionOf("inbox", "Inbox Bot", {
            questions: 1,
            tasks: { needsInput: 2, ready: 0, failed: 1 },
          }),
        ],
      },
    );
  return served
    ? { status: served.status, body: await served.text() }
    : undefined;
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "needs-you-board.fixture.tsx")],
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

const browsers = new Map<string, Browser>();
let script: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const playwright = await import("playwright-core");
  for (const engine of engines) {
    const type: BrowserType = playwright[engine];
    browsers.set(
      engine,
      // The CI job installs full Chromium without the headless shell.
      await type.launch(engine === "chromium" ? { channel: "chromium" } : {}),
    );
  }
}, 120_000);

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
});

const PAGES = [
  { name: "bots-page", path: "/bots" },
  { name: "bot-page", path: "/bots/inbox" },
] as const;

/** Every class the page draws with, styled by one stylesheet built from them. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({
    content: await stylesheet([...new Set(classes)]),
  });
}

async function open(
  path: string,
  engine: string,
  theme: Theme,
  width: number,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width, height: 1100 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = route.request().url();
    const path = new URL(url).pathname;
    if (path === "/board.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) {
      const served = await answer(url, route.request().method());
      return served
        ? route.fulfill({
            status: served.status,
            contentType: "application/json",
            body: served.body,
          })
        : route.fulfill({ status: 404, json: { detail: "Not found." } });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/board.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
  // Every row is drawn: the tasks, and the question outside any of them.
  for (const words of [DINNER, SEEDS, CATERERS, STOPPED, REPORT])
    await page.getByText(words, { exact: true }).first().waitFor();
  await style(page);
  await page.evaluate(() => document.fonts.ready);
  // Styled, the rows lay out again; a row that folds its actions does so once it is measured.
  await page.waitForTimeout(400);
  await style(page);
  await page.waitForTimeout(200);
  return page;
}

type RowLook = {
  title: string;
  /** The title is cut (an ellipsis, or a line hidden). */
  titleCut: boolean;
  /** The words' column, narrower than a phone line can be read in. */
  squeezed: boolean;
  /** A button sits on the title or the status line. */
  onWords: boolean;
  /** A button is outside the row, or the window. */
  outside: boolean;
  /** The row's buttons run onto more than one line. */
  buttonLines: number;
  /** Each of these is a button on the row, or (Mark done, Open) in the row's menu. */
  missing: string[];
  /** Mark done is not a button on the row: it is in the row's last menu. */
  inMenu: boolean;
  /** What the row waits on, its detail line, is cut: a line hidden, or an ellipsis. */
  detailCut: boolean;
};

/** How each row of the board is drawn, as a person would judge it. */
async function rows(page: Page): Promise<RowLook[]> {
  return page.evaluate(() => {
    const shown = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        getComputedStyle(element).visibility !== "hidden"
      );
    };
    const apart = (a: DOMRect, b: DOMRect) =>
      a.right <= b.left + 0.5 ||
      b.right <= a.left + 0.5 ||
      a.bottom <= b.top + 0.5 ||
      b.bottom <= a.top + 0.5;
    const looks: RowLook[] = [];
    for (const row of document.querySelectorAll(
      "[data-needs-you-bot] [data-slot=item]",
    )) {
      if (!shown(row)) continue;
      const title = row.querySelector("[data-slot=item-title]") as HTMLElement;
      const name = title?.textContent?.trim() ?? "";
      const words = title.getBoundingClientRect();
      // The quiet line under the title: the task's status and when.
      const status = [...row.querySelectorAll("div")].find(
        (element) =>
          element.classList.contains("text-xs") &&
          element.classList.contains("flex-wrap"),
      );
      const buttons = [...row.querySelectorAll("button, a")].filter(
        (control) =>
          shown(control) &&
          // The words themselves are a button that opens the row.
          !control.contains(title),
      );
      const card = row.getBoundingClientRect();
      const lines = new Set(
        buttons.map((button) =>
          Math.round(button.getBoundingClientRect().top / 8),
        ),
      );
      const names = buttons.map(
        (button) =>
          button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
      );
      const menu = buttons.some(
        (button) => button.getAttribute("aria-haspopup") === "menu",
      );
      // A task that waits on the person can be stopped from its row, as from its card.
      const wanted = name.startsWith("Should I")
        ? ["Answer"]
        : name.startsWith("Compare") || name.startsWith("Draft the EU")
          ? ["Try again", "Mark done", "Open"]
          : ["Stop", "Mark done", "Open"];
      // The line under the title: what the row waits on.
      const detail = title.nextElementSibling;
      looks.push({
        title: name,
        titleCut:
          title.scrollWidth > title.clientWidth + 1 ||
          title.scrollHeight > title.clientHeight + 1,
        squeezed:
          words.width < 200 ||
          (status ? status.getBoundingClientRect().width < 200 : false),
        onWords: buttons.some(
          (button) =>
            !apart(button.getBoundingClientRect(), words) ||
            (status
              ? !apart(
                  button.getBoundingClientRect(),
                  status.getBoundingClientRect(),
                )
              : false),
        ),
        outside: buttons.some((button) => {
          const rect = button.getBoundingClientRect();
          return (
            rect.left < card.left - 0.5 ||
            rect.right > card.right + 0.5 ||
            rect.right > innerWidth + 0.5
          );
        }),
        buttonLines: lines.size,
        missing: wanted.filter(
          (label) =>
            !names.includes(label) &&
            !(
              menu &&
              (label === "Stop" || label === "Mark done" || label === "Open")
            ),
        ),
        inMenu: wanted.includes("Mark done") && !names.includes("Mark done"),
        detailCut: detail
          ? detail.scrollHeight > detail.clientHeight + 1 ||
            detail.scrollWidth > detail.clientWidth + 1
          : false,
      });
    }
    return looks;
  });
}

/** The open menu: whether every item reads on one line, and the menu is inside the window. */
async function menuLook(page: Page) {
  return page.evaluate(async () => {
    // Measured once it has opened: it grows in from its corner.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const menu = document.querySelector("[role=menu]");
    if (!menu) throw new Error("no menu open");
    // How many lines an item's words run to: its height inside its padding, in lines of its text.
    const lines = [...menu.querySelectorAll("[role=menuitem]")].map((item) => {
      const css = getComputedStyle(item);
      const inner =
        item.getBoundingClientRect().height -
        Number.parseFloat(css.paddingTop) -
        Number.parseFloat(css.paddingBottom);
      const line =
        Number.parseFloat(css.lineHeight) ||
        Number.parseFloat(css.fontSize) * 1.43;
      return Math.round(inner / line);
    });
    const box = menu.getBoundingClientRect();
    return {
      oneLine: lines.every((count) => count <= 1),
      inside: box.left >= -0.5 && box.right <= innerWidth + 0.5,
    };
  });
}

describe.skipIf(!asked)("a row of the Needs you board", () => {
  for (const { name, path } of PAGES)
    for (const engine of engines)
      for (const width of WIDTHS)
        test(`is read whole on the ${name} in ${engine} at ${width}px`, async () => {
          for (const theme of shots ? THEMES : (["light"] as const)) {
            const page = await open(path, engine, theme, width);
            try {
              if (shots) {
                mkdirSync(shots, { recursive: true });
                await page.screenshot({
                  path: join(shots, `${name}-${engine}-${theme}-${width}.png`),
                  fullPage: true,
                });
              }
              const looks = await rows(page);
              expect(looks.map((look) => look.title).sort()).toEqual(
                [DINNER, SEEDS, CATERERS, STOPPED, REPORT].sort(),
              );
              for (const look of looks)
                expect(look).toEqual({
                  title: look.title,
                  titleCut: false,
                  squeezed: false,
                  onWords: false,
                  outside: false,
                  buttonLines: 1,
                  missing: [],
                  inMenu: look.inMenu,
                  // A task waiting on the person says what it waits on in full, at every width.
                  detailCut: false,
                });
              // What a row folded into its menu is there: Mark done and Open.
              for (const look of looks.filter((one) => one.inMenu)) {
                await page
                  .locator("[data-needs-you-bot] [data-slot=item]")
                  .filter({ hasText: look.title })
                  .locator("[aria-haspopup=menu]")
                  .last()
                  .click();
                await page
                  .getByRole("menuitem", { name: "Mark done" })
                  .waitFor();
                await page.getByRole("menuitem", { name: "Open" }).waitFor();
                if (look.title !== CATERERS && look.title !== STOPPED)
                  await page.getByRole("menuitem", { name: "Stop" }).waitFor();
                // The menu's own classes, which were not on the page until it opened.
                await style(page);
                // Each item on one line, the menu inside the window.
                expect(await menuLook(page)).toEqual({
                  oneLine: true,
                  inside: true,
                });
                await page.keyboard.press("Escape");
                await page.getByRole("menu").waitFor({ state: "detached" });
              }
            } finally {
              await page.close();
            }
          }
        }, 120_000);
});

/*
 * The approval's own menu, with its standing answers: "Allow for this conversation" reads on one
 * line, and the menu stays inside the window. At the trigger's 128px it broke in two at every width.
 */
describe.skipIf(!asked)("a row's menu on the Needs you board", () => {
  for (const { name, path } of PAGES)
    for (const engine of engines)
      for (const width of WIDTHS)
        test(`reads each item on one line on the ${name} in ${engine} at ${width}px`, async () => {
          for (const theme of shots ? THEMES : (["light"] as const)) {
            const page = await open(path, engine, theme, width);
            try {
              await page
                .locator("[data-needs-you-bot] [data-slot=item]")
                .filter({ hasText: SEEDS })
                .locator("[aria-haspopup=menu]")
                .last()
                .click();
              await page
                .getByRole("menuitem", { name: "Allow for this conversation" })
                .waitFor();
              // The menu's own classes, which were not on the page until it opened.
              await style(page);
              const look = await menuLook(page);
              if (shots)
                await page.screenshot({
                  path: join(
                    shots,
                    `${name}-${engine}-${theme}-${width}-menu.png`,
                  ),
                });
              expect(look).toEqual({ oneLine: true, inside: true });
            } finally {
              await page.close();
            }
          }
        }, 120_000);
});
