import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { screenLinkLooks } from "./screen-link-style";

/**
 * The cards a Bot's personal settings changes are drawn as, in a real browser: `update_my_settings`
 * and `update_my_bot`, saved, refused and still running, drawn by the call's name and result as the
 * transcript draws them, from the result as the server writes it.
 *
 * Each saved card is titled with what changed (your settings, your approvals, the Bot by its name),
 * names every setting in the words of the screen it lives on with what it was and what it is now,
 * and opens that screen with the link every settings card uses. A call still waiting on the person
 * is its approval card, titled in plain words ("Change your settings", "Change Scout's settings").
 * A refusal says why in the server's words and draws nothing as changed. In
 * the app's stylesheet, light and dark, at a laptop's width and a phone's: nothing scrolls sideways
 * and every card is whole inside the window.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/settings-tool-cards-personal.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as settings-cards-<engine>-<theme>-<width>.png.
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

/** The vendored marks as data URIs, as Vite's `import.meta.glob` hands them to `@/lib/marks`. */
function marksModule(): string {
  const dir = join(APP, "..", "shared", "marks");
  const marks = Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith(".svg"))
      .map((file) => [
        file.replace(".svg", ""),
        `data:image/svg+xml;base64,${readFileSync(join(dir, file)).toString("base64")}`,
      ]),
  );
  return `const marks = ${JSON.stringify(marks)}; export const markFor = (id) => (id && marks[id]) || null;`;
}

async function bundle(fixture: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, fixture)],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // A Bot's Setup page draws the marks of what runs it, which Vite loads by glob.
    plugins: [
      {
        name: "marks",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
            path: "marks",
            namespace: "marks",
          }));
          build.onLoad({ filter: /.*/, namespace: "marks" }, () => ({
            contents: marksModule(),
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

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
/** The cards in every state, and each card beside the screen it changes. */
const scripts = new Map<"cards" | "screens", string>();

beforeAll(async () => {
  if (!asked) return;
  scripts.set(
    "cards",
    await bundle("settings-tool-cards-personal.fixture.tsx"),
  );
  scripts.set(
    "screens",
    await bundle("settings-tool-cards-personal-screens.fixture.tsx"),
  );
  const playwright = await import("playwright-core");
  for (const engine of engines) {
    const type: BrowserType = playwright[engine];
    browsers.set(
      engine,
      await type.launch(engine === "chromium" ? { channel: "chromium" } : {}),
    );
  }
}, 120_000);

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
});

async function open(
  engine: string,
  theme: "light" | "dark",
  window: { width: number; height: number },
  which: "cards" | "screens" = "cards",
): Promise<Page> {
  const script = scripts.get(which) ?? "";
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/cards.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/cards.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page
    .locator(
      which === "cards"
        ? '[data-part="bot-running"] [data-settings-card]'
        : '[data-pair="bot"] [data-side="screen"] [data-slot="item"]',
    )
    .first()
    .waitFor({ timeout: 15_000 });
  // The calls still waiting on the person, as their approval cards.
  if (which === "cards")
    await page
      .locator('[data-part="approval-bot"] [data-slot="decision-card"]')
      .waitFor({ timeout: 15_000 });
  // The screens' reads answer, and their rows draw what they answered.
  if (which === "screens")
    await page
      .getByText("Keep answers short and lead with the decision.")
      .last()
      .waitFor({ timeout: 15_000 });
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({
    content: await stylesheet([...new Set(classes)]),
  });
  await page.evaluate(() => document.fonts.ready);
  // An approval card unfolds its answers as it opens; it is looked at once it has.
  await page.waitForTimeout(400);
  return page;
}

type Drawn = {
  state: string;
  title: string;
  badge: string;
  text: string;
  rows: { label: string; was: string; now: string }[];
  /** What a call still under way is changing. */
  asked: string[];
  link: { text: string; href: string } | null;
  inside: boolean;
  /** Every value is wholly inside the card, never cut or run past its edge. */
  valuesInside: boolean;
};

function read(page: Page): Promise<Record<string, Drawn>> {
  return page.evaluate(() => {
    const words = (node: Element | null | undefined) =>
      (node?.textContent ?? "").replace(/\s+/g, " ").trim();
    const out: Record<string, Drawn> = {};
    for (const part of document.querySelectorAll("[data-part]")) {
      const card = part.querySelector("[data-settings-card]");
      if (!card) continue;
      const box = card.getBoundingClientRect();
      const link = card.querySelector("a");
      out[part.getAttribute("data-part") ?? ""] = {
        state: card.getAttribute("data-state") ?? "",
        title: words(card.querySelector("figcaption p")),
        badge: words(card.querySelector("figcaption span")),
        text: words(card),
        rows: [...card.querySelectorAll("[data-setting]")].map((row) => ({
          label: row.getAttribute("data-setting") ?? "",
          was: words(row.querySelector('[data-value="before"]')),
          now: words(row.querySelector('[data-value="after"]')),
        })),
        asked: [...card.querySelectorAll("[data-asked] li")].map(words),
        link: link
          ? { text: words(link), href: link.getAttribute("href") ?? "" }
          : null,
        inside: box.left >= 0 && box.right <= innerWidth + 0.5,
        valuesInside: [...card.querySelectorAll("[data-value]")].every(
          (value) => {
            const inner = value.getBoundingClientRect();
            return inner.right <= box.right + 0.5 && inner.left >= box.left;
          },
        ),
      };
    }
    return out;
  }) as Promise<Record<string, Drawn>>;
}

/** Each waiting call's approval card title, by its part of the page. */
function approvalTitles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-part]")].flatMap((part) => {
        const title = part.querySelector(
          "[data-slot=decision-card] figcaption p",
        );
        return title
          ? [
              [
                part.getAttribute("data-part") ?? "",
                (title.textContent ?? "").trim(),
              ],
            ]
          : [];
      }),
    ),
  );
}

describe.skipIf(!asked)("the personal settings cards", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ])
        test(`say what changed, before and after, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window);
          try {
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `settings-cards-${engine}-${theme}-${window.width}.png`,
                ),
                fullPage: true,
              });
            }
            const sideways = await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            );
            expect(sideways).toBe(false);
            const cards = await read(page);
            expect(Object.keys(cards)).toHaveLength(7);
            for (const card of Object.values(cards)) {
              expect(card.inside).toBe(true);
              expect(card.valuesInside).toBe(true);
            }

            const done = cards["settings-done"];
            expect(done).toMatchObject({
              state: "done",
              title: "Your settings",
              badge: "Changed",
              link: { text: "Open Settings", href: "/settings" },
            });
            expect(done?.rows).toEqual([
              { label: "Name", was: "Dave", now: "David McKay" },
              {
                label: "Standing instructions",
                was: "Reply in British English.",
                now: "Reply in British English. Keep answers short and lead with the decision.",
              },
              { label: "Skin", was: "OpenBot", now: "OpenDuet" },
              { label: "Check-ins from all your Bots", was: "Off", now: "On" },
              {
                label: "Where updates go: Progress",
                was: "Every way you can be reached",
                now: "Slack",
              },
              {
                label: "Notifications from Scout",
                was: "Everything",
                now: "Only when it needs me",
              },
            ]);

            // Approvals alone open the Approvals screen.
            expect(cards["approvals-done"]).toMatchObject({
              state: "done",
              title: "Your approvals",
              link: { text: "Open Approvals", href: "/settings/approvals" },
            });

            const refused = cards["settings-refused"];
            expect(refused).toMatchObject({
              state: "refused",
              badge: "Not changed",
              link: null,
              rows: [],
            });
            expect(refused?.text).toContain(
              `An admin has turned off "Custom rules" for you, so that wasn't done.`,
            );
            expect(refused?.text).not.toContain("Refused.");

            expect(cards["settings-running"]).toMatchObject({
              state: "running",
              badge: "Changing",
              link: null,
              rows: [],
              asked: ["Name", "Notifications from Ledger"],
            });

            const bot = cards["bot-done"];
            expect(bot).toMatchObject({
              state: "done",
              title: "Scout Prime",
              badge: "Changed",
              link: { text: "Open Setup", href: "/bots/bot-scout/setup" },
            });
            expect(bot?.rows).toEqual([
              { label: "Name", was: "Scout", now: "Scout Prime" },
              { label: "Title", was: "Research", now: "Research lead" },
              {
                label: "Default model",
                was: "OpenBot's default",
                now: "Claude Sonnet 4.5 · High",
              },
              { label: "Visibility", was: "Private", now: "Public" },
            ]);

            // Every card opens its screen with the same link as the admin cards: primary, a chevron.
            const links = await screenLinkLooks(page);
            expect(links.map((link) => link.text)).toEqual([
              "Open Settings",
              "Open Approvals",
              "Open Setup",
            ]);
            for (const link of links)
              expect(link).toMatchObject({
                underlined: false,
                chevron: true,
                primary: true,
                weight: "500",
              });
            expect(new Set(links.map((link) => link.size)).size).toBe(1);

            // A call waiting on the person asks in words a person would use, never the tool's name.
            expect(await approvalTitles(page)).toEqual({
              "approval-settings": "Change your settings",
              "approval-bot": "Change Scout's settings",
            });

            expect(cards["bot-refused"]).toMatchObject({
              state: "refused",
              title: "Ledger",
              link: null,
            });
            expect(cards["bot-refused"]?.text).toContain(
              "You can't manage this Bot.",
            );
            // Named by the Bot the call names, before it has an answer.
            expect(cards["bot-running"]).toMatchObject({
              state: "running",
              title: "Ledger",
              asked: ["Visibility"],
            });
          } finally {
            await page.close();
          }
        }, 90_000);
});

type Pair = {
  /** Each row of the card: its label and what it says now. */
  rows: { label: string; now: string }[];
  /** The screen's words, and its switches and choices by name. */
  screen: string;
  switches: Record<string, boolean>;
  side: boolean;
};

function pairs(page: Page): Promise<Record<string, Pair>> {
  return page.evaluate(() => {
    const words = (node: Element | null | undefined) =>
      (node?.textContent ?? "").replace(/\s+/g, " ").trim();
    const out: Record<string, Pair> = {};
    for (const pair of document.querySelectorAll("[data-pair]")) {
      const card = pair.querySelector('[data-side="card"]');
      const screen = pair.querySelector('[data-side="screen"]');
      const cardBox = card?.getBoundingClientRect();
      const screenBox = screen?.getBoundingClientRect();
      out[pair.getAttribute("data-pair") ?? ""] = {
        rows: [...(card?.querySelectorAll("[data-setting]") ?? [])].map(
          (row) => ({
            label: row.getAttribute("data-setting") ?? "",
            now: words(row.querySelector('[data-value="after"]')),
          }),
        ),
        screen: words(screen),
        switches: Object.fromEntries(
          [...(screen?.querySelectorAll('[role="switch"]') ?? [])].map(
            (control) => [
              control.getAttribute("aria-label") ??
                words(
                  document.getElementById(
                    control.getAttribute("aria-labelledby") ?? "",
                  ),
                ),
              control.getAttribute("aria-checked") === "true",
            ],
          ),
        ),
        // Beside each other on a laptop, one over the other on a phone.
        side:
          cardBox !== undefined &&
          screenBox !== undefined &&
          Math.abs(cardBox.top - screenBox.top) < 4 &&
          cardBox.right <= screenBox.left,
      };
    }
    return out;
  }) as Promise<Record<string, Pair>>;
}

describe.skipIf(!asked)("each card beside the screen it changes", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ])
        test(`names each setting as its screen does, and the screen shows what the card says, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window, "screens");
          try {
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `settings-cards-beside-screens-${engine}-${theme}-${window.width}.png`,
                ),
                fullPage: true,
              });
            }
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
              ),
            ).toBe(false);
            const drawn = await pairs(page);
            expect(Object.keys(drawn)).toEqual([
              "general",
              "notifications",
              "approvals",
              "bot",
            ]);
            for (const pair of Object.values(drawn)) {
              expect(pair.side).toBe(window.width >= 1024);
              // Every row the card draws is titled as its screen titles it.
              for (const row of pair.rows)
                for (const part of row.label.split(": "))
                  expect(pair.screen).toContain(part);
            }

            const general = drawn.general;
            for (const now of [
              "David McKay",
              "Keep answers short and lead with the decision.",
              "OpenDuet",
            ])
              expect(general?.screen).toContain(now);
            expect(general?.rows.map((row) => row.now)).toEqual([
              "David McKay",
              "Reply in British English. Keep answers short and lead with the decision.",
              "OpenDuet",
              "On",
            ]);
            expect(general?.switches["Check-ins for all your Bots"]).toBe(true);

            const notifications = drawn.notifications;
            expect(notifications?.rows).toEqual([
              { label: "Where updates go: Progress", now: "Slack" },
            ]);
            expect(notifications?.switches["Progress by Slack"]).toBe(true);
            expect(notifications?.switches["Progress by Push"]).toBe(false);

            const approvals = drawn.approvals;
            expect(approvals?.switches["Auto-review"]).toBe(true);
            expect(approvals?.screen).toContain("Never");

            const bot = drawn.bot;
            for (const row of bot?.rows ?? [])
              expect(bot?.screen).toContain(row.now);
          } finally {
            await page.close();
          }
        }, 90_000);
});
