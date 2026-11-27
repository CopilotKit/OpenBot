import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { test } from "./renderer-crash";
import { screenLinkLooks } from "./screen-link-style";

/**
 * The cards OpenBot settings' read tools draw in a conversation, in a real browser: the person's
 * settings, their Bots, the organization's settings for an admin, where to change a setting
 * yourself, and how to do a job yourself, click by click. Answered, refused, failed and running,
 * from the result as the server writes it.
 *
 * Each names its settings in the words of the screen they live on and opens that screen. In the
 * app's stylesheet, light and dark, at a laptop's width and a phone's: nothing scrolls sideways and
 * every card and value is whole inside the window.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/settings-tool-cards-core.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as settings-read-cards-<engine>-<theme>-<width>.png.
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

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "settings-tool-cards-core.fixture.tsx"),
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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
  const dir = packageDir(name ?? id);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const subpath = `.${id.slice((name ?? id).length)}`;
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
): Promise<Page> {
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
    .locator('[data-part="screens-done"] [data-settings-card]')
    .waitFor({ timeout: 15_000 });
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

type Drawn = {
  state: string;
  title: string;
  caption: string;
  text: string;
  sections: string[];
  rows: Record<string, string>;
  links: { text: string; href: string }[];
  inside: boolean;
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
      const header = card.querySelectorAll("figcaption p");
      out[part.getAttribute("data-part") ?? ""] = {
        state: card.getAttribute("data-state") ?? "",
        title: words(header[0]),
        caption: words(header[1]),
        text: words(card),
        sections: [...card.querySelectorAll("[data-section]")].map(
          (section) => section.getAttribute("data-section") ?? "",
        ),
        rows: Object.fromEntries(
          [...card.querySelectorAll("[data-setting]")].map((row) => [
            row.getAttribute("data-setting") ?? "",
            words(row.querySelector("[data-value]")),
          ]),
        ),
        links: [...card.querySelectorAll("a")].map((link) => ({
          text: words(link),
          href: link.getAttribute("href") ?? "",
        })),
        inside: box.left >= 0 && box.right <= innerWidth + 0.5,
        valuesInside: [...card.querySelectorAll("[data-value], li")].every(
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

describe.skipIf(!asked)("the settings read cards", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ])
        test(`show each setting in its screen's words, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(engine, theme, window);
          try {
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `settings-read-cards-${engine}-${theme}-${window.width}.png`,
                ),
                fullPage: true,
              });
            }
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth > innerWidth,
              ),
            ).toBe(false);
            const cards = await read(page);
            expect(Object.keys(cards)).toHaveLength(11);
            for (const card of Object.values(cards)) {
              expect(card.inside).toBe(true);
              expect(card.valuesInside).toBe(true);
            }

            const mine = cards["settings-done"];
            expect(mine).toMatchObject({
              state: "done",
              title: "Your settings",
              sections: [
                "About you",
                "Preferences",
                "Where updates go",
                "Before a Bot acts",
              ],
              links: [{ text: "Open Settings", href: "/settings" }],
            });
            expect(mine?.rows).toMatchObject({
              Name: "Ada Lovelace",
              Email: "ada@acme.test",
              Role: "Admin",
              "Standing instructions":
                "Reply in British English. Lead with the decision, then the detail.",
              "Check-ins from all your Bots": "On",
              Progress: "Every way you can be reached",
              Decisions: "Push, Slack",
              "Something needs you": "Only in OpenBot",
              "Extra vigilant": "On",
              "Auto-review": "Off",
              "Commands on your computer": "Ask every time",
            });
            expect(cards["settings-running"]).toMatchObject({
              state: "running",
              title: "Your settings",
              caption: "Reading…",
              sections: [],
              links: [],
            });

            const bots = cards["bots-done"];
            expect(bots).toMatchObject({
              state: "done",
              title: "Your Bots",
              caption: "3 Bots, 2 of them yours.",
            });
            // Each Bot opens its Setup, then the Bots page.
            expect(bots?.links.map((link) => link.href)).toEqual([
              "/bots/bot-scout/setup",
              "/bots/bot-inbox/setup",
              "/bots/bot-ledger/setup",
              "/bots",
            ]);
            const [scout, inbox, ledger] = bots?.links ?? [];
            for (const words of [
              "Scout",
              "Public",
              "Research lead",
              "Claude Sonnet 4.5 · High",
            ])
              expect(scout?.text).toContain(words);
            expect(inbox?.text).toContain("Private");
            expect(ledger?.text).toContain("View only");

            const organization = cards["organization-done"];
            expect(organization).toMatchObject({
              state: "done",
              title: "Organization settings",
              caption: "Acme, for everyone in it.",
              sections: ["Settings", "Permissions", "Approvals"],
              links: [{ text: "Open Admin", href: "/admin" }],
            });
            // In the words of the Admin pages each setting lives on.
            expect(organization?.rows).toMatchObject({
              "Require SSO": "Off",
              "Action recording": "On",
              "Skill sharing": "On",
              "Check-ins daily limit": "Up to 48 a day per Bot for each person",
              "Stop inactive computers": "After 7 days without use",
              "Only allowed models":
                "On: anthropic/claude-sonnet-4-5, openai/gpt-5.5, google/gemini-3-pro",
              "Only approved connectors": "Off",
              "Use Bots": "On",
              "Browse the web": "On, 1 override",
              "Custom rules": "Off, 2 overrides",
              "Require auto-review for everyone": "Off",
              "Let members set personal rules": "On",
              "Paying and buying": "Members do it themselves",
            });

            const refused = cards["organization-refused"];
            expect(refused).toMatchObject({
              state: "refused",
              caption: "Not read",
              sections: [],
              links: [],
            });
            expect(refused?.text).toContain(
              "Only an admin of this organization can do that",
            );
            expect(refused?.text).not.toContain("Refused.");

            const where = cards["screens-done"];
            expect(where?.links.map((link) => link.href)).toEqual([
              "/settings/credentials",
              "/settings/vault",
            ]);
            expect(where?.links[0]?.text).toContain("AI connection");
            expect(where?.links[1]?.text).toContain("never in chat");

            // How to do a job yourself, click by click: found in use, a person asked their Bot how
            // to give one of their Bots a permission and it said it couldn't see its own screens.
            const guide = cards["guide-done"];
            expect(guide).toMatchObject({
              state: "done",
              title: "Give a Bot permission to use an app's actions",
              caption: "Here's how to do each one yourself.",
              // The screens that can be opened; Connections came without one.
              links: [
                { text: "Open Scout's Apps", href: "/bots/bot-scout/apps" },
                {
                  text: "Open Scout's Approvals",
                  href: "/bots/bot-scout/approvals",
                },
              ],
            });
            const steps = await page.evaluate(() =>
              [
                ...document.querySelectorAll(
                  '[data-part="guide-done"] [data-answer]',
                ),
              ].map((answer) => ({
                task: answer.getAttribute("data-answer"),
                steps: [...answer.querySelectorAll("[data-step]")].map((step) =>
                  (step.textContent ?? "").replace(/\s+/g, " "),
                ),
                bold: [...answer.querySelectorAll("[data-step] strong")].map(
                  (strong) => strong.textContent,
                ),
                botCan: answer.querySelector("[data-bot-can]") !== null,
              })),
            );
            // Opening the screen, then the job on it, numbered in one list.
            expect(steps[0]).toEqual({
              task: "Give a Bot permission to use an app's actions",
              steps: [
                "1Open Bots in the sidebar.",
                "2Choose Scout, then open Apps.",
                "3Find Gmail in the list and turn it on.",
                "4Open Gmail and turn on each action Scout may use, such as Send email.",
              ],
              bold: ["Bots", "Scout", "Apps", "Gmail", "Gmail", "Send email"],
              botCan: true,
            });
            expect(steps.map((answer) => answer.task)).toEqual([
              "Give a Bot permission to use an app's actions",
              "Ask before Scout sends email",
              "Connect your own Gmail account",
            ]);
            expect(steps.map((answer) => answer.botCan)).toEqual([
              true,
              false,
              false,
            ]);
            // The screen's words are bold, and no asterisk is ever shown.
            expect(guide?.text).not.toContain("*");
            expect(guide?.text).toContain("Or ask your Bot to do it for you.");

            const member = cards["guide-member"];
            expect(member).toMatchObject({
              state: "done",
              title: "Let a Bot use an app nobody has turned on",
              caption: "Here's how to do it yourself.",
              links: [{ text: "Open Connections", href: "/connections" }],
            });
            expect(member?.text).toContain(
              "Only an admin can turn on an app for everyone.",
            );
            expect(member?.text).not.toContain("*");

            expect(cards["guide-running"]).toMatchObject({
              state: "running",
              title: "Give Scout permission to send email",
              caption: "Reading…",
              links: [],
            });
            const guideRefused = cards["guide-refused"];
            expect(guideRefused).toMatchObject({
              state: "refused",
              caption: "Not read",
              links: [],
            });
            expect(guideRefused?.text).toContain("You can't manage this Bot.");
            expect(guideRefused?.text).not.toContain("Refused.");
            expect(cards["guide-failed"]).toMatchObject({
              state: "failed",
              caption: "Couldn't be read",
              links: [],
            });
            expect(cards["guide-failed"]?.text).toContain(
              "This didn't work. Ask your Bot to try again.",
            );

            // Every card opens its screen with the same link as the change cards: primary, a chevron.
            const links = await screenLinkLooks(page);
            expect(links.map((link) => link.text)).toEqual([
              "Open Settings",
              "Open Bots",
              "Open Admin",
              "Open Scout's Apps",
              "Open Scout's Approvals",
              "Open Connections",
            ]);
            for (const link of links)
              expect(link).toMatchObject({
                underlined: false,
                chevron: true,
                primary: true,
                weight: "500",
              });
            expect(new Set(links.map((link) => link.size)).size).toBe(1);
            // A row that opens a screen ends in a chevron, as a row that opens one does on a screen.
            expect(
              await page.evaluate(() =>
                [
                  ...document.querySelectorAll(
                    "[data-bot] > a, [data-screen] > a",
                  ),
                ].map(
                  (row) =>
                    row.lastElementChild?.classList.contains(
                      "tabler-icon-chevron-right",
                    ) ?? false,
                ),
              ),
            ).toEqual([true, true, true, true, true]);
          } finally {
            await page.close();
          }
        }, 90_000);
});
