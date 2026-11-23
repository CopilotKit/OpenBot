import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Request } from "playwright-core";
import { compile } from "tailwindcss";
import { parse } from "yaml";
import type { ServiceTerms } from "@/lib/api/generated/model";
import {
  AcceptServiceTermsBody,
  AcceptServiceTermsResponse,
  GetServiceTermsResponse,
} from "@/lib/api/generated/people/people.zod";
import { afterTerms } from "@/lib/service-terms/queries";
import { personBody } from "./accounts-api";

/**
 * The terms of service, on OpenBot Cloud and everywhere else.
 *
 * In a real browser, through the app's own signed-in gate (`_authed`), the terms screen and
 * onboarding:
 *
 * - A new person on OpenBot Cloud is sent to the terms from anywhere. The box starts unticked and
 *   Continue waits for it. Ticking it and Continue agree to the version shown, and onboarding
 *   follows, as it always has.
 * - Somebody who agreed to an older version is asked again, told the terms changed, and once they
 *   agree goes on to the page they were headed to.
 * - Terms that change while the screen is open (409 SERVICE_TERMS_CHANGED) show the new version,
 *   unticked, with the server's sentence; agreeing then sends the new version.
 * - A self-hosted OpenBot has no terms and never shows the screen, and neither does an OpenBot
 *   older than the question. A read that fails holds a person at the screen, with Try again.
 *
 * The server is served as routes at the API's address, answering as api/openapi.yaml says: the
 * spec's own examples for the terms, every body the page sends checked against the generated
 * request schema, every answer against the response schema.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/service-terms.test.tsx
 *
 * Chromium by default; OPENBOT_APP_ENGINES=chromium,webkit adds the engine the Mac window draws
 * with, as CI runs it. With OPENBOT_APP_SHOTS=<dir> each screen is saved as
 * terms-<screen>-<engine>-<theme>-<width>.png, beside onboarding's Welcome to compare.
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
const ME = `${ORGANIZATION}/people/me`;
const TERMS = `${ME}/terms`;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
type Window = { width: number; height: number };

type Example = { value: Record<string, unknown> };
const spec = parse(
  readFileSync(join(APP, "..", "api", "openapi.yaml"), "utf8"),
) as {
  components: {
    examples: Record<string, Example>;
    responses: Record<
      string,
      {
        content: {
          "application/problem+json": { examples: Record<string, Example> };
        };
      }
    >;
  };
};
/** One of the spec's examples, as the server would send it. */
function example(name: string): Record<string, unknown> {
  const found = spec.components.examples[name]?.value;
  if (!found) throw new Error(`the spec has no ${name} example`);
  return structuredClone(found);
}
const CHANGED_PROBLEM =
  spec.components.responses.ServiceTermsConflict?.content[
    "application/problem+json"
  ].examples.changed?.value;
if (!CHANGED_PROBLEM) throw new Error("the spec has no changed example");

type Start = "toAgree" | "changed" | "none";
const START_EXAMPLE: Record<Start, string> = {
  toAgree: "ServiceTermsToAgreeExample",
  changed: "ServiceTermsChangedExample",
  none: "ServiceTermsNoneExample",
};

/** One OpenBot's server, as far as these screens ask it. */
class FakeServer {
  terms: ServiceTerms;
  onboarding: { step: number; completedAt: string | null };
  accepts: unknown[] = [];
  termsReads = 0;
  /** What reading the terms answers instead, while set: a failure, or a route an older OpenBot lacks. */
  termsAnswer: { status: number; json: unknown } | null = null;

  constructor(start: Start, onboarded = false) {
    this.terms = GetServiceTermsResponse.parse(
      example(START_EXAMPLE[start]),
    ) as ServiceTerms;
    this.onboarding = onboarded
      ? { step: 1, completedAt: "2026-11-01T09:00:00.000Z" }
      : { step: 0, completedAt: null };
  }

  /** A new version is published while the person has the screen open. */
  publish(version: string) {
    const current = this.terms.current;
    if (!current) throw new Error("no terms to change");
    this.terms = { ...this.terms, current: { ...current, version } };
    this.terms.acceptanceNeeded = this.terms.accepted?.version !== version;
  }

  answer(request: Request): { status: number; json: unknown } {
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === TERMS && method === "GET") {
      this.termsReads += 1;
      if (this.termsAnswer) return this.termsAnswer;
      return { status: 200, json: GetServiceTermsResponse.parse(this.terms) };
    }
    if (path === `${TERMS}/accept` && method === "POST") {
      expect(request.headers()["idempotency-key"]?.length ?? 0).toBeGreaterThan(
        0,
      );
      const body = request.postDataJSON() as Record<string, unknown>;
      this.accepts.push(body);
      const input = AcceptServiceTermsBody.parse(body);
      for (const key of Object.keys(body))
        expect(Object.keys(input)).toContain(key);
      if (input.version !== this.terms.current?.version)
        return { status: 409, json: CHANGED_PROBLEM };
      this.terms = AcceptServiceTermsResponse.parse({
        ...this.terms,
        accepted: {
          version: input.version,
          acceptedAt: "2026-11-21T18:04:00.000Z",
        },
        acceptanceNeeded: false,
      }) as ServiceTerms;
      return { status: 200, json: this.terms };
    }
    if (path === ME && method === "GET")
      return {
        status: 200,
        json: {
          person: personBody({
            id: "dana",
            name: "Dana Whitfield",
            email: "dana@example.com",
            role: "admin",
            onboarding: this.onboarding,
          }),
          openbotVersion: "v1.1.3",
        },
      };
    if (path === `${ME}/onboarding/advance` && method === "POST") {
      const { step } = request.postDataJSON() as { step: number };
      this.onboarding = { ...this.onboarding, step };
      return { status: 200, json: { onboarding: this.onboarding } };
    }
    if (path === `${ORGANIZATION}/deployment`)
      return {
        status: 200,
        json: {
          generativeUi: true,
          selfHostBanner: false,
          localEvaluation: false,
          edition: "team",
          authProviders: [],
          ssoConfigured: false,
          ssoRequired: false,
        },
      };
    if (path === `${ME}/approval-preferences`)
      return {
        status: 200,
        json: {
          enabled: false,
          autoReview: false,
          hostCommands: "ask",
          effectiveHostCommands: "ask",
        },
      };
    if (path === `${ME}/preferences`)
      return {
        status: 200,
        json: {
          messageListEmphasis: "thread",
          selfHostBannerDismissed: false,
          narration: null,
          skin: "openbot",
          proactive: "on",
        },
      };
    return { status: 404, json: { detail: "Not found." } };
  }
}

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

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "service-terms.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // The gate's module brings the app behind it, whose chat loads a map library only when a Bot
    // draws a map. Nothing here does.
    external: ["maplibre-gl"],
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

/** The page at `path`, its server answering from `server`. */
async function open(
  path: string,
  server: FakeServer,
  engine: string,
  theme: Theme,
  window: Window,
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
    const where = new URL(route.request().url()).pathname;
    if (where === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, where.split("/").pop() ?? "");
    if (where.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (where.startsWith("/api/")) {
      const { status, json } = server.answer(route.request());
      return route.fulfill({
        status,
        json,
        headers:
          status >= 400 ? { "content-type": "application/problem+json" } : {},
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
  return page;
}

/** Style the page for every class it draws now: what just opened brings classes of its own. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function shoot(
  page: Page,
  screen: string,
  engine: string,
  theme: Theme,
  window: Window,
) {
  if (!shots) return;
  await style(page);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `terms-${screen}-${engine}-${theme}-${window.width}.png`),
    fullPage: true,
  });
}

/** The screen as a phone shows it scrolled to the end: the viewport, not the whole page. */
async function shootEnd(
  page: Page,
  screen: string,
  engine: string,
  theme: Theme,
  window: Window,
) {
  if (!shots) return;
  await style(page);
  await page.evaluate(() => {
    const root = document.documentElement;
    root.scrollTop = root.scrollHeight;
  });
  await page.waitForTimeout(100);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(
      shots,
      `terms-${screen}-end-${engine}-${theme}-${window.width}.png`,
    ),
  });
}

/** What a person would see wrong: sideways scroll, or a control cut off at the side. */
async function measured(page: Page) {
  await style(page);
  return page.evaluate(() => {
    const inside = (rect: DOMRect) =>
      rect.left >= -0.5 && rect.right <= innerWidth + 0.5;
    const cut = [...document.querySelectorAll("button, a, input")]
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        // A tickbox's own input is a 1px box out of sight; its control is what shows.
        return rect.width > 1 && rect.height > 1;
      })
      .filter((control) => !inside(control.getBoundingClientRect()))
      .map(
        (control) =>
          control.textContent?.trim() ||
          control.getAttribute("aria-label") ||
          control.tagName,
      );
    return { sideways: document.documentElement.scrollWidth > innerWidth, cut };
  });
}

const FINE = { sideways: false, cut: [] };

/**
 * On a phone, scrolled to the end, how far the step's last content reaches into the fade above the
 * pinned buttons, in px (0 when it is clear of it). The fade is the footer's `before:`, 32px tall,
 * which says there is more below while there is; at the end there is no more, so nothing belongs
 * under it. The carousel's dots sat there, half hidden.
 */
async function underTheFade(page: Page): Promise<number> {
  await style(page);
  return page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const footer = document.querySelector("footer");
    if (!footer) throw new Error("no footer");
    const fadeTop =
      footer.getBoundingClientRect().top -
      Number.parseFloat(getComputedStyle(footer, "::before").height || "0");
    const bottoms = [
      ...document.querySelectorAll(
        "[data-onboarding-demo] *, [data-onboarding-intro] *",
      ),
    ]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => rect.bottom);
    return Math.max(0, Math.round(Math.max(...bottoms) - fadeTop));
  });
}

const primary = (page: Page) => page.locator("[data-onboarding-primary]");
const agree = (page: Page) =>
  page.getByRole("checkbox", {
    name: "I agree to the Terms of Service and Acceptable Use Policy",
  });
/** Tick the box as a person does, by pressing its sentence (not one of the links in it). */
const tick = (page: Page) =>
  page.locator("label[for=terms-agree]").click({ position: { x: 4, y: 4 } });
const heading = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name }).waitFor();
const at = (page: Page) => new URL(page.url()).pathname;

describe("where agreeing to the terms goes on to", () => {
  test("a page of this app, and nowhere else", () => {
    expect(afterTerms("/settings?tab=ai")).toBe("/settings?tab=ai");
    expect(afterTerms("/invitations/abc123")).toBe("/invitations/abc123");
    expect(afterTerms(undefined)).toBe("/");
    expect(afterTerms("https://example.com/")).toBe("/");
    expect(afterTerms("//example.com/")).toBe("/");
    expect(afterTerms("/\\example.com")).toBe("/");
    expect(afterTerms("/terms?next=%2F")).toBe("/");
  });
});

describe.skipIf(!asked)("The terms on OpenBot Cloud", () => {
  for (const engine of engines)
    test(`a new person agrees before anything else, then onboarding follows, in ${engine}`, async () => {
      const server = new FakeServer("toAgree");
      const page = await open("/settings", server, engine, "light", WIDE);
      try {
        await heading(page, "Agree to the terms");
        expect(at(page)).toBe("/terms");
        expect(new URL(page.url()).searchParams.get("next")).toBe("/settings");
        // Unticked, and Continue waits for it. Sign out is the only other way.
        expect(await agree(page).isChecked()).toBe(false);
        expect(await primary(page).isDisabled()).toBe(true);
        expect(
          await page.locator("[data-onboarding-secondary]").textContent(),
        ).toBe("Sign out");
        // Both names link to their page, in a new tab.
        for (const [name, href] of [
          ["Terms of Service", "https://open.bot/legal/terms"],
          ["Acceptable Use Policy", "https://open.bot/legal/acceptable-use"],
        ]) {
          const link = page.getByRole("link", { name });
          expect(await link.getAttribute("href")).toBe(href);
          expect(await link.getAttribute("target")).toBe("_blank");
        }
        // Pressing Continue while unticked does nothing.
        await primary(page).click({ force: true });
        expect(server.accepts).toEqual([]);

        // Onboarding and home are behind it too.
        await page.goto(`${ORIGIN}/onboarding`);
        await heading(page, "Agree to the terms");
        expect(at(page)).toBe("/terms");
        await page.goto(`${ORIGIN}/`);
        await heading(page, "Agree to the terms");

        // The sentence is the box's label.
        await tick(page);
        expect(await agree(page).isChecked()).toBe(true);
        expect(await primary(page).isDisabled()).toBe(false);
        await primary(page).click();
        await heading(page, "Welcome to OpenBot");
        expect(at(page)).toBe("/onboarding");
        expect(server.accepts).toEqual([{ version: "2026-11-21" }]);
        // Agreed: the terms screen sends them on.
        await page.goto(`${ORIGIN}/terms`);
        await heading(page, "Welcome to OpenBot");
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`terms that changed are asked again, then the page they were headed to, in ${engine}`, async () => {
      const server = new FakeServer("changed", true);
      const page = await open("/settings", server, engine, "light", WIDE);
      try {
        await heading(page, "The terms have changed");
        expect(at(page)).toBe("/terms");
        expect(await agree(page).isChecked()).toBe(false);
        await tick(page);
        await primary(page).click();
        await page.locator("[data-app-settings]").waitFor();
        expect(at(page)).toBe("/settings");
        expect(server.accepts).toEqual([{ version: "2027-03-01" }]);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`terms that change while the screen is open show the new version, in ${engine}`, async () => {
      const server = new FakeServer("toAgree", true);
      const page = await open("/", server, engine, "light", WIDE);
      try {
        await heading(page, "Agree to the terms");
        await tick(page);
        server.publish("2027-03-01");
        await primary(page).click();
        const alert = page.getByRole("alert");
        await alert.waitFor();
        expect(await alert.textContent()).toBe(
          "The terms have changed since you opened them. Read the new version and agree again.",
        );
        // The new version, unticked: the tick was for the one they saw.
        await page.waitForFunction(
          () =>
            document
              .querySelector("[data-terms-agree]")
              ?.getAttribute("aria-checked") === "false",
        );
        expect(await primary(page).isDisabled()).toBe(true);
        await tick(page);
        expect(await alert.count()).toBe(0);
        await primary(page).click();
        await page.locator("[data-app-home]").waitFor();
        expect(server.accepts).toEqual([
          { version: "2026-11-21" },
          { version: "2027-03-01" },
        ]);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`a forged address to go on to is never followed off the app, in ${engine}`, async () => {
      for (const forged of ["https://evil.example/", "//evil.example/"]) {
        const server = new FakeServer("toAgree", true);
        const page = await open(
          `/terms?next=${encodeURIComponent(forged)}`,
          server,
          engine,
          "light",
          WIDE,
        );
        try {
          await heading(page, "Agree to the terms");
          await tick(page);
          await primary(page).click();
          await page.locator("[data-app-home]").waitFor();
          expect(new URL(page.url()).origin).toBe(ORIGIN);
          expect(at(page)).toBe("/");
          // Opened again once agreed, the terms send them on, never back to the forged address.
          await page.goto(`${ORIGIN}/terms?next=${encodeURIComponent(forged)}`);
          await page.locator("[data-app-home]").waitFor();
          expect(new URL(page.url()).origin).toBe(ORIGIN);
        } finally {
          await page.close();
        }
      }
    }, 60_000);

  for (const engine of engines)
    test(`a read that fails holds the person at the terms, with Try again, in ${engine}`, async () => {
      const server = new FakeServer("toAgree", true);
      server.termsAnswer = {
        status: 503,
        json: { detail: "Service unavailable.", status: 503 },
      };
      const page = await open("/settings", server, engine, "light", WIDE);
      try {
        await heading(page, "Agree to the terms");
        expect(at(page)).toBe("/terms");
        await page
          .getByText("Couldn't load the terms. Try again to continue.")
          .waitFor();
        expect(await agree(page).count()).toBe(0);
        expect(await primary(page).isDisabled()).toBe(true);
        server.termsAnswer = null;
        await page.getByRole("button", { name: "Try again" }).click();
        await page.locator("label[for=terms-agree]").waitFor();
        await tick(page);
        await primary(page).click();
        await page.locator("[data-app-settings]").waitFor();
        expect(server.accepts).toEqual([{ version: "2026-11-21" }]);
      } finally {
        await page.close();
      }
    }, 60_000);
});

describe.skipIf(!asked)("A refusal is never read as no terms", () => {
  /*
   * Only the API's plain not found is an OpenBot older than the terms. Any other 404 is a refusal
   * about this request, the organization it names included, and says nothing about whether the
   * person has agreed: read as no terms, it let them past the terms on OpenBot Cloud.
   */
  for (const engine of engines)
    test(`an organization not found holds the person at the terms, in ${engine}`, async () => {
      const server = new FakeServer("toAgree", true);
      server.termsAnswer = {
        status: 404,
        json: {
          status: 404,
          code: "ORGANIZATION_NOT_FOUND",
          detail: "That organization wasn't found.",
        },
      };
      const page = await open("/settings", server, engine, "light", WIDE);
      try {
        // Wherever the gate sends them, the first page they see is the terms.
        const first = page.getByRole("heading", { level: 1 }).first();
        await first.waitFor();
        expect(await first.textContent()).toBe("Agree to the terms");
        expect(at(page)).toBe("/terms");
        // Once the read answers, the person agrees and goes on, as after any failed read.
        server.termsAnswer = null;
        await page.getByRole("button", { name: "Try again" }).click();
        await tick(page);
        await primary(page).click();
        await page.locator("[data-app-settings]").waitFor();
        expect(server.accepts).toEqual([{ version: "2026-11-21" }]);
      } finally {
        await page.close();
      }
    }, 60_000);
});

describe.skipIf(!asked)("On a phone", () => {
  for (const engine of engines)
    test(`nothing at the end of the terms or of Welcome sits under the fade above the buttons, in ${engine}`, async () => {
      const found: Record<string, number> = {};
      // Welcome as it was before the terms, on an OpenBot with none.
      const welcome = await open(
        "/",
        new FakeServer("none"),
        engine,
        "light",
        PHONE,
      );
      try {
        await heading(welcome, "Welcome to OpenBot");
        found.welcome = await underTheFade(welcome);
      } finally {
        await welcome.close();
      }
      const page = await open(
        "/",
        new FakeServer("toAgree"),
        engine,
        "light",
        PHONE,
      );
      try {
        await heading(page, "Agree to the terms");
        found.terms = await underTheFade(page);
        await tick(page);
        await primary(page).click();
        await heading(page, "Welcome to OpenBot");
        found.welcomeAfterTerms = await underTheFade(page);
      } finally {
        await page.close();
      }
      expect(found).toEqual({ welcome: 0, terms: 0, welcomeAfterTerms: 0 });
    }, 60_000);
});

describe.skipIf(!asked)("No terms to agree to", () => {
  for (const engine of engines)
    test(`a self-hosted OpenBot never shows the terms, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open("/settings", server, engine, "light", WIDE);
      try {
        await page.locator("[data-app-settings]").waitFor();
        expect(at(page)).toBe("/settings");
        // Asked for by its address, it sends them home.
        await page.goto(`${ORIGIN}/terms`);
        await page.locator("[data-app-home]").waitFor();
        expect(at(page)).toBe("/");
        expect(server.accepts).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`a new person on a self-hosted OpenBot goes to onboarding as before, in ${engine}`, async () => {
      const server = new FakeServer("none");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        await heading(page, "Welcome to OpenBot");
        expect(at(page)).toBe("/onboarding");
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`an OpenBot older than the terms never shows them, in ${engine}`, async () => {
      const server = new FakeServer("toAgree", true);
      // A route it doesn't have: a 404 that isn't about the person.
      server.termsAnswer = { status: 404, json: { detail: "Not found." } };
      const page = await open("/settings", server, engine, "light", WIDE);
      try {
        await page.locator("[data-app-settings]").waitFor();
        expect(at(page)).toBe("/settings");
        expect(server.termsReads).toBeGreaterThan(0);
      } finally {
        await page.close();
      }
    }, 60_000);
});

// The screen, light and dark, wide and at a phone's width, its changed version, and the Welcome
// step after it, beside onboarding's Welcome from before to compare.
test.skipIf(!asked || !shots)(
  "screenshots of the terms, beside Welcome",
  async () => {
    for (const engine of engines)
      for (const theme of THEMES)
        for (const window of [WIDE, PHONE]) {
          const before = await open(
            "/",
            new FakeServer("none"),
            engine,
            theme,
            window,
          );
          try {
            await heading(before, "Welcome to OpenBot");
            await shoot(before, "compare-welcome", engine, theme, window);
            await shootEnd(before, "compare-welcome", engine, theme, window);
          } finally {
            await before.close();
          }

          const page = await open(
            "/",
            new FakeServer("toAgree"),
            engine,
            theme,
            window,
          );
          try {
            await heading(page, "Agree to the terms");
            expect(await measured(page)).toEqual(FINE);
            await shoot(page, "screen", engine, theme, window);
            await shootEnd(page, "screen", engine, theme, window);
            await tick(page);
            await shoot(page, "screen-ticked", engine, theme, window);
            await primary(page).click();
            await heading(page, "Welcome to OpenBot");
            await shoot(page, "after-welcome", engine, theme, window);
            await shootEnd(page, "after-welcome", engine, theme, window);
          } finally {
            await page.close();
          }

          const changed = await open(
            "/",
            new FakeServer("changed", true),
            engine,
            theme,
            window,
          );
          try {
            await heading(changed, "The terms have changed");
            expect(await measured(changed)).toEqual(FINE);
            await shoot(changed, "changed", engine, theme, window);
          } finally {
            await changed.close();
          }
        }
  },
  600_000,
);
