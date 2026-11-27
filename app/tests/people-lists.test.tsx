import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Locator, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { still } from "./page-still";
import {
  answer,
  ORGANIZATION,
  OUTSIDERS,
  SALES_EMEA,
  SARA,
  SARAH,
  SARITA,
  SUPPORT_NORDICS,
} from "./people-lists-api";
import { test } from "./renderer-crash";

/**
 * Every list of people pages and searches the way Admin's People does, and a person is only ever
 * picked from inside the organization.
 *
 * Organization settings' Members and Invitations, the Teams list and a team's people each show a
 * page, with Show more only while the server says there is another page, and a search box above the
 * rows that asks the server: typing "sar" narrows the list to Sarah, Sara and Sarita, matched
 * anywhere in the name or address whatever the case. Adding somebody to a team, to a group
 * conversation, or to who a Bot is published to is a type-ahead over the organization's own members,
 * a page at a time: it never asks any other address and never shows anybody from outside it.
 *
 * Drawn in a real browser from people-lists.fixture.tsx, the server's answers served at the API's
 * addresses as the spec has them (people-lists-api.ts: 50 a page by default, cursors bound to their
 * search, nextCursor null at the end). Each screen is also drawn at 1440 and 390, light and dark,
 * and the page never scrolls sideways.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/people-lists.test.tsx
 *
 * Chromium by default. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit, as CI's WebKit job runs it.
 * With OPENBOT_APP_SHOTS=<dir> each screen is saved as <prefix>-<screen>-<width>-<theme>.png, the
 * prefix from OPENBOT_APP_SHOT_PREFIX (Admin's People is saved as admin-people-<width>-<theme>.png).
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;
const prefix = process.env.OPENBOT_APP_SHOT_PREFIX ?? "after";
const engines = (process.env.OPENBOT_APP_ENGINES ?? "chromium")
  .split(",")
  .map((engine) => engine.trim())
  .filter((engine) => engine === "chromium" || engine === "webkit") as (
  | "chromium"
  | "webkit"
)[];

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
type Window = { width: number; height: number };

const SARS = [SARAH.name, SARA.name, SARITA.name];

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "people-lists.fixture.tsx")],
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

/** One request the page sent to the API. */
type Sent = { method: string; url: URL; body: unknown };

/** An open page, and every request it has sent the API so far. */
type Opened = { page: Page; sent: Sent[] };

async function open(
  engine: string,
  path: string,
  ready: (page: Page) => Promise<unknown>,
  theme: Theme = "light",
  window: Window = WIDE,
): Promise<Opened> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const sent: Sent[] = [];
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, url.pathname.split("/").pop() ?? "");
    if (url.pathname.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (url.pathname.startsWith("/api/")) {
      const raw = request.postData();
      const body = raw ? JSON.parse(raw) : undefined;
      sent.push({ method: request.method(), url, body });
      const answered = answer(request.method(), url, body) ?? null;
      if (!answered)
        return route.fulfill({
          status: 404,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Not found",
            status: 404,
            detail: "Not found.",
          }),
        });
      return route.fulfill({
        status: answered.status,
        contentType: answered.headers.get("content-type") ?? "application/json",
        body: await answered.text(),
      });
    }
    // Every other address is the app's own page, as its server answers it.
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
  await ready(page);
  await restyle(page);
  return { page, sent };
}

/** Styles the page for the classes it draws now, as the app's build would have. */
async function restyle(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
}

/** A section of a page, by its heading. */
function section(page: Page, heading: string): Locator {
  return page.locator("section", {
    has: page.getByRole("heading", { name: heading, exact: true }),
  });
}

/** The title of every row drawn in `where`, in order. */
async function rowTitles(where: Locator | Page): Promise<string[]> {
  return where
    .locator("[data-slot=item-title]")
    .evaluateAll((titles) =>
      titles.map((title) => (title.textContent ?? "").replace(/You$/, "")),
    );
}

/**
 * Waits until `read` answers `expected`, then holds the test to it: what it answered last, if it
 * never did within 10 seconds.
 */
async function until<T>(read: () => T | Promise<T>, expected: T) {
  const deadline = Date.now() + 10_000;
  let last = await read();
  while (!Bun.deepEquals(last, expected) && Date.now() < deadline) {
    await Bun.sleep(100);
    last = await read();
  }
  expect(last as unknown).toEqual(expected);
}

/** Waits until the rows drawn in `where` are `count`. */
async function rowsAre(where: Locator | Page, count: number) {
  await until(async () => (await rowTitles(where)).length, count);
}

/** The searches the page asked `path` for, as sent. */
function searchesOf(sent: readonly Sent[], path: string): string[] {
  return sent
    .filter(
      (one) => one.url.pathname === path && one.url.searchParams.has("search"),
    )
    .map((one) => one.url.searchParams.get("search") ?? "");
}

/** A list that pages and searches: where it is, the rows it holds, and its search box. */
type PagedList = {
  name: string;
  path: string;
  /** Where its rows are drawn. */
  rows: (page: Page) => Locator | Page;
  /** The address the list is read from. */
  api: string;
  /** How many there are in all, and on the first page. */
  total: number;
  search: string;
  /** What "sar" finds. */
  found: string[];
  /** What typing "zzz" says. */
  nothing: string;
  ready: (page: Page) => Promise<unknown>;
};

const LISTS: PagedList[] = [
  {
    name: "members",
    path: "/organization",
    rows: (page) => section(page, "Members"),
    api: `${ORGANIZATION}/members`,
    total: 55,
    search: "Search members",
    found: SARS,
    nothing: 'Nobody matches "zzz".',
    ready: (page) => page.getByText(SARAH.name).first().waitFor(),
  },
  {
    name: "invitations",
    path: "/organization",
    rows: (page) => section(page, "Invitations"),
    api: `${ORGANIZATION}/invitations`,
    total: 55,
    search: "Search invitations",
    found: [
      "sarah.okafor@northwind.example",
      "sara.berg@northwind.example",
      "sarita.mendes@northwind.example",
    ],
    nothing: 'No invitation matches "zzz".',
    ready: (page) => page.getByText("aaron.blake@northwind.example").waitFor(),
  },
  {
    name: "teams",
    path: "/teams",
    rows: (page) => page,
    api: `${ORGANIZATION}/teams`,
    total: 58,
    search: "Search teams",
    found: ["Sarasota office", "Sarajevo desk", "Sarah's launch crew"],
    nothing: 'No team matches "zzz".',
    ready: (page) => page.getByText("Sales EMEA").first().waitFor(),
  },
  {
    name: "team-people",
    path: `/teams/${SALES_EMEA}`,
    rows: (page) => section(page, "People"),
    api: `${ORGANIZATION}/teams/${SALES_EMEA}/members`,
    total: 55,
    search: "Search people in this team",
    found: SARS,
    nothing: 'Nobody in this team matches "zzz".',
    ready: (page) => page.getByText(SARAH.name).first().waitFor(),
  },
];

describe.skipIf(!asked)("lists of people page and search", () => {
  for (const engine of engines)
    for (const list of LISTS) {
      test(`${list.name}: a page at a time, Show more for the rest, and "sar" asks the server, in ${engine}`, async () => {
        const { page, sent } = await open(engine, list.path, list.ready);
        const rows = list.rows(page);
        const more = rows.getByRole("button", { name: "Show more" });

        // The first page, and Show more because the server said there is another.
        await rowsAre(rows, 50);
        expect(await more.count()).toBe(1);
        await more.click();
        await rowsAre(rows, list.total);
        // The last page says so (nextCursor null), and the button goes.
        await until(() => more.count(), 0);

        // What is typed is sent to the server, which finds them anywhere in the name or address.
        const box = page.getByRole("textbox", { name: list.search });
        await box.fill("sar");
        await until(
          async () => (await rowTitles(rows)).sort(),
          [...list.found].sort(),
        );
        expect(searchesOf(sent, list.api)).toContain("sar");
        // Three is one page: no Show more.
        expect(await more.count()).toBe(0);

        // Whatever the case.
        await box.fill("SAR");
        await until(() => searchesOf(sent, list.api).includes("SAR"), true);
        await until(
          async () => (await rowTitles(rows)).sort(),
          [...list.found].sort(),
        );

        await box.fill("zzz");
        await rows.getByText("No matches", { exact: true }).waitFor();
        await rows.getByText(list.nothing, { exact: true }).waitFor();
        await page.close();
      }, 60_000);
    }
});

/** A place a person is picked from inside the organization, and what choosing them sends. */
type Picker = {
  name: string;
  path: string;
  /** What the page shows once it has loaded. */
  ready: (page: Page) => Promise<unknown>;
  /** Opens the type-ahead and returns its box. */
  openBox: (page: Page) => Promise<Locator>;
  /** Who is already there, offered as such and not to be chosen. */
  already: string;
  /** Choosing somebody, and what the server is sent for them. */
  choose: string;
  sent: (sent: readonly Sent[]) => unknown;
  expected: unknown;
  /** Any request the picker made besides the organization's members' search. */
  alsoAsks?: string;
};

const PICKERS: Picker[] = [
  {
    name: "a team's Add person",
    path: `/teams/${SUPPORT_NORDICS}`,
    ready: (page) => page.getByText(SARAH.name).first().waitFor(),
    openBox: async (page) => {
      await page.getByRole("button", { name: "Add person" }).first().click();
      return page.getByRole("combobox", { name: "Name or email", exact: true });
    },
    already: SARAH.name,
    choose: SARA.name,
    sent: (sent) =>
      sent
        .filter((one) => one.method === "PUT")
        .map((one) => [one.url.pathname, one.body]),
    expected: [
      [
        `${ORGANIZATION}/teams/${SUPPORT_NORDICS}/members/${SARA.id}`,
        { role: "member" },
      ],
    ],
    alsoAsks: `${ORGANIZATION}/teams/${SUPPORT_NORDICS}/members`,
  },
  {
    name: "a group conversation's people",
    path: "/group",
    ready: (page) => page.getByRole("button", { name: "2 people" }).waitFor(),
    openBox: async (page) => {
      await page.getByRole("button", { name: "2 people" }).click();
      return page.getByRole("combobox", { name: "Name or email", exact: true });
    },
    already: SARAH.name,
    choose: SARA.name,
    sent: (sent) =>
      sent
        .filter((one) => one.method === "POST")
        .map((one) => [one.url.pathname, one.body]),
    expected: [
      [`${ORGANIZATION}/conversations/grp/members`, { email: SARA.email }],
    ],
  },
  {
    name: "who a Bot is published to",
    path: "/bots/expenses/sharing",
    ready: (page) => page.getByRole("button", { name: /Audience/ }).waitFor(),
    openBox: async (page) => {
      await page.getByRole("button", { name: /Audience/ }).click();
      return page.getByRole("combobox", { name: "People", exact: true });
    },
    already: SARAH.name,
    choose: SARITA.name,
    sent: (sent) =>
      sent
        .filter((one) => one.method === "PUT")
        .map((one) => (one.body as { emails?: string[] }).emails),
    expected: [[SARAH.email, SARITA.email]],
  },
];

describe.skipIf(!asked)("a person is picked from the organization only", () => {
  for (const engine of engines)
    for (const picker of PICKERS) {
      test(`${picker.name} offers only the organization's members, in ${engine}`, async () => {
        const { page, sent } = await open(engine, picker.path, picker.ready);
        const box = await picker.openBox(page);
        await restyle(page);
        await box.waitFor();
        const before = sent.length;
        await box.pressSequentially("sar");
        const options = page.getByRole("option");
        await until(async () => (await options.allTextContents()).length, 3);
        const offered = await options.evaluateAll((all) =>
          all.map((one) => one.getAttribute("aria-label") ?? ""),
        );
        // Sarah, Sara and Sarita, each from the organization; the one already there says so.
        expect(offered.map((one) => one.split(",")[0])).toEqual(SARS);
        expect(offered.find((one) => one.startsWith(picker.already))).toMatch(
          /, (in this team|in this group|chosen)$/,
        );
        for (const outsider of OUTSIDERS)
          expect(await page.getByText(outsider.name).count()).toBe(0);

        // Every search went to this organization's members (and, for a team, who of them is in it),
        // and nothing was asked of another organization or of everybody who uses OpenBot.
        const asked = sent.slice(before);
        const searched = asked.filter((one) =>
          one.url.searchParams.has("search"),
        );
        expect(searched.length).toBeGreaterThan(0);
        for (const one of searched)
          expect([`${ORGANIZATION}/members`, picker.alsoAsks]).toContain(
            one.url.pathname,
          );
        for (const one of asked) {
          expect(one.url.pathname.startsWith(`${ORGANIZATION}/`)).toBe(true);
          expect(one.url.pathname).not.toBe(`${ORGANIZATION}/people`);
        }
        expect(searchesOf(asked, `${ORGANIZATION}/members`)).toContain("sar");

        await page
          .getByRole("option", { name: new RegExp(`^${picker.choose},`) })
          .click();
        if (picker.name === "who a Bot is published to") {
          await page.getByRole("button", { name: "Update" }).click();
        }
        await until(() => picker.sent(sent), picker.expected);
        await page.close();
      }, 60_000);
    }
});

/** What each screen is drawn as, to be looked at, at both widths in both themes. */
const LOOKS: {
  name: string;
  path: string;
  ready: (page: Page) => Promise<unknown>;
  /** What is done once the page is styled: opening a dialog and typing in it. */
  act?: (page: Page) => Promise<unknown>;
  /** Saved without before- or after-: it is the page the others are compared with. */
  reference?: boolean;
  /** A state there was none of before: drawn only when the screenshots are not "before". */
  afterOnly?: boolean;
}[] = [
  {
    name: "organization-members",
    path: "/organization",
    ready: (page) => page.getByText(SARAH.name).first().waitFor(),
  },
  {
    name: "organization-invitations",
    path: "/organization",
    ready: (page) => page.getByText("aaron.blake@northwind.example").waitFor(),
    act: (page) =>
      page
        .getByRole("heading", { name: "Invitations", exact: true })
        .evaluate((heading) => heading.scrollIntoView({ block: "start" })),
  },
  {
    name: "teams-list",
    path: "/teams",
    ready: (page) => page.getByText("Sales EMEA").first().waitFor(),
  },
  {
    name: "team-people",
    path: `/teams/${SALES_EMEA}`,
    ready: (page) => page.getByText(SARAH.name).first().waitFor(),
  },
  {
    name: "team-typeahead",
    path: `/teams/${SUPPORT_NORDICS}`,
    ready: (page) => page.getByText(SARAH.name).first().waitFor(),
    act: async (page) => {
      await page.getByRole("button", { name: "Add person" }).first().click();
      await restyle(page);
      await page
        .getByRole("combobox", { name: "Name or email", exact: true })
        .pressSequentially("sar");
      await page.getByRole("option").nth(2).waitFor();
    },
  },
  {
    name: "group-typeahead",
    path: "/group",
    ready: (page) => page.getByRole("button", { name: "2 people" }).waitFor(),
    act: async (page) => {
      await page.getByRole("button", { name: "2 people" }).click();
      await restyle(page);
      const box = page
        .getByRole("combobox", { name: "Name or email", exact: true })
        .or(page.getByRole("textbox", { name: "Their email" }));
      await box.pressSequentially("sar");
      await page.waitForTimeout(600);
    },
  },
  {
    name: "publish-typeahead",
    path: "/bots/expenses/sharing",
    ready: (page) => page.getByRole("button", { name: /Audience/ }).waitFor(),
    act: async (page) => {
      await page.getByRole("button", { name: /Audience/ }).click();
      await restyle(page);
      const box = page
        .getByRole("combobox", { name: "People", exact: true })
        .or(page.getByLabel("People, by email"));
      await box.click();
      await box.pressSequentially("sar");
      await page.waitForTimeout(600);
    },
  },
  // The foot of a list, where Show more is, and a search's answer.
  {
    name: "teams-list-end",
    path: "/teams",
    ready: (page) => page.getByText("Sales EMEA").first().waitFor(),
    act: (page) =>
      page.evaluate(() => {
        const scroller = document.querySelector(".overflow-auto");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      }),
  },
  {
    name: "organization-members-search",
    path: "/organization",
    afterOnly: true,
    ready: (page) => page.getByText(SARAH.name).first().waitFor(),
    act: async (page) => {
      await page.getByRole("textbox", { name: "Search members" }).fill("sar");
      await page.getByText(SARITA.name).waitFor();
      await rowsAre(section(page, "Members"), 3);
    },
  },
  {
    name: "team-people-no-match",
    path: `/teams/${SALES_EMEA}`,
    afterOnly: true,
    ready: (page) => page.getByText(SARAH.name).first().waitFor(),
    act: async (page) => {
      await page
        .getByRole("textbox", { name: "Search people in this team" })
        .fill("zzz");
      await page.getByText("No matches", { exact: true }).waitFor();
    },
  },
  {
    name: "admin-people",
    path: "/admin/people",
    reference: true,
    ready: (page) => page.getByText(SARAH.name).first().waitFor(),
  },
];

describe.skipIf(!asked)("each screen at every width and theme", () => {
  for (const engine of engines)
    for (const look of LOOKS.filter(
      (one) => !(one.afterOnly && prefix === "before"),
    ))
      for (const theme of THEMES)
        for (const window of [WIDE, PHONE])
          test(`${look.name} holds its layout in ${engine}, ${theme}, ${window.width}px`, async () => {
            const { page } = await open(
              engine,
              look.path,
              look.ready,
              theme,
              window,
            );
            await look.act?.(page);
            // What opened after the first styling (a dialog, a list) is styled too.
            await restyle(page);
            await still(page);
            const sideways = await page.evaluate(
              () =>
                document.documentElement.scrollWidth > innerWidth ||
                document.body.scrollWidth > innerWidth,
            );
            if (shots && engine === "chromium") {
              mkdirSync(shots, { recursive: true });
              const name = look.reference
                ? `${look.name}-${window.width}-${theme}.png`
                : `${prefix}-${look.name}-${window.width}-${theme}.png`;
              await page.screenshot({ path: join(shots, name) });
            }
            expect(sideways).toBe(false);
            await page.close();
          }, 60_000);
});
