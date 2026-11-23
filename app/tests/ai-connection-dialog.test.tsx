import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Request } from "playwright-core";
import { compile } from "tailwindcss";
import { parse } from "yaml";
import type { AiConnection } from "@/lib/api/generated/model";
import {
  GetAiConnectionResponse,
  ReplaceAiConnectionBody,
} from "@/lib/api/generated/models/models.zod";
import { personBody } from "./accounts-api";

/**
 * Settings → General → AI model changes the AI connection in the app, with OpenBot running.
 *
 * In a real browser, Chromium and WebKit, in the app's real settings frame: open the AI model row,
 * choose Change, pick Anthropic, paste a key. A key the provider refuses shows the server's one
 * sentence and changes nothing; a good one shows the connection in use, and the row under the
 * dialog reads the new provider (the connection's query was read again). Before this the row's
 * Change could only stop OpenBot and open Desktop's setup window, and a plain browser had no row.
 *
 * The server is served as routes at the API's address, answering as api/openapi.yaml says: every
 * body the page sends is checked against the generated request schema, every answer against the
 * response schema, and a refusal is the spec's own example for AI_CONNECTION_KEY_REFUSED.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/ai-connection-dialog.test.tsx
 *
 * Chromium by default, as CI has it. With OPENBOT_APP_SHOTS=<dir> each step is saved as
 * ai-connection-<step>-<engine>-<theme>-<width>.png, beside General and API keys from before.
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
const AI_CONNECTION = `${ORGANIZATION}/ai-connection`;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
type Window = { width: number; height: number };

/** The spec, for the refusal the server answers with: its own example, word for word. */
const spec = parse(
  readFileSync(join(APP, "..", "api", "openapi.yaml"), "utf8"),
) as {
  components: {
    responses: Record<
      string,
      {
        content: {
          "application/problem+json": {
            examples: Record<string, { value: Record<string, unknown> }>;
          };
        };
      }
    >;
  };
};
const REFUSED =
  spec.components.responses.AiConnectionRefused?.content[
    "application/problem+json"
  ].examples.keyRefused?.value;
if (!REFUSED) throw new Error("the spec has no keyRefused example");

const GOOD_KEY = "sk-ant-api03-good";
const BAD_KEY = "sk-ant-api03-refused";

/** One OpenBot's server, as far as these screens ask it. */
class FakeServer {
  connection: AiConnection = {
    provider: "openai",
    login: "api-key",
    model: null,
    endpointHost: null,
    keySet: true,
    ready: true,
    source: "stored",
    editable: true,
    saved: [{ provider: "openai", login: "api-key", endpointHost: null }],
    changedAt: "2026-11-14T09:00:00.000Z",
  };
  reads = 0;
  replaces: { body: unknown; idempotencyKey: string | null }[] = [];

  answer(request: Request): { status: number; json: unknown } {
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === AI_CONNECTION && request.method() === "GET") {
      this.reads += 1;
      return {
        status: 200,
        json: GetAiConnectionResponse.parse(this.connection),
      };
    }
    if (path === AI_CONNECTION && request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      this.replaces.push({
        body,
        idempotencyKey: request.headers()["idempotency-key"] ?? null,
      });
      const input = ReplaceAiConnectionBody.parse(body);
      // As the spec's input schema: nothing it doesn't name.
      for (const key of Object.keys(body))
        expect(Object.keys(input)).toContain(key);
      if (input.apiKey === BAD_KEY) return { status: 422, json: REFUSED };
      const stillSaved = this.connection.saved.filter(
        (saved) => saved.provider !== input.provider,
      );
      this.connection = GetAiConnectionResponse.parse({
        provider: input.provider,
        login: input.login,
        model: input.model ?? null,
        endpointHost: input.baseUrl ? new URL(input.baseUrl).host : null,
        keySet: true,
        ready: true,
        source: "stored",
        editable: true,
        saved: [
          ...stillSaved,
          {
            provider: input.provider,
            login: input.login,
            endpointHost: input.baseUrl ? new URL(input.baseUrl).host : null,
          },
        ],
        changedAt: "2026-11-17T23:30:00.000Z",
      }) as AiConnection;
      return { status: 200, json: this.connection };
    }
    if (path === `${ORGANIZATION}/people/me`)
      return {
        status: 200,
        json: {
          person: personBody({
            id: "dana",
            name: "Dana Whitfield",
            email: "dana@example.com",
            role: "admin",
          }),
          openbotVersion: "v1.1.0",
        },
      };
    if (path === `${ORGANIZATION}/deployment`)
      return {
        status: 200,
        json: {
          generativeUi: true,
          selfHostBanner: false,
          localEvaluation: false,
          edition: "personal",
          authProviders: [],
          ssoConfigured: false,
          ssoRequired: false,
        },
      };
    // The rest of General, as a person who chose nothing yet sees it.
    if (path === `${ORGANIZATION}/people/me/preferences`)
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
    if (path === `${ORGANIZATION}/people/me/api-keys`)
      return { status: 200, json: { apiKeys: [], nextCursor: null } };
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
    entrypoints: [join(import.meta.dir, "ai-connection-dialog.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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
  // A dialog scales in: looked at once it is still.
  await page.waitForTimeout(250);
}

async function shoot(
  page: Page,
  step: string,
  engine: string,
  theme: Theme,
  window: Window,
) {
  if (!shots) return;
  await style(page);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(
      shots,
      `ai-connection-${step}-${engine}-${theme}-${window.width}.png`,
    ),
  });
}

/** What a person would see wrong: sideways scroll, a control cut off, the dialog off screen. */
async function measured(page: Page) {
  await style(page);
  return page.evaluate(() => {
    const inside = (rect: DOMRect) =>
      rect.left >= -0.5 && rect.right <= innerWidth + 0.5;
    const dialog = document.querySelector("[data-slot=dialog-content]");
    const scope: Element = dialog ?? document.body;
    const cut = [...scope.querySelectorAll("button, a, input")]
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .filter((control) => !control.matches("[data-sidebar=rail]"))
      .filter((control) => !inside(control.getBoundingClientRect()))
      .map(
        (control) =>
          control.textContent?.trim() ||
          control.getAttribute("aria-label") ||
          control.tagName,
      );
    const box = dialog?.getBoundingClientRect();
    return {
      sideways: document.documentElement.scrollWidth > innerWidth,
      cut,
      dialogInside: box
        ? inside(box) && box.top >= 0 && box.bottom <= innerHeight + 0.5
        : true,
    };
  });
}

const FINE = { sideways: false, cut: [], dialogInside: true };

describe.skipIf(!asked)("changing the AI connection in Settings", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      test(`a refused key says why and changes nothing; a good one connects, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer();
        const window = WIDE;
        const page = await open("/settings", server, engine, theme, window);
        try {
          const row = page.getByRole("button", {
            name: /OpenAI.*Uses your OpenAI API key\./,
          });
          await row.waitFor();
          await shoot(page, "row", engine, theme, window);
          await row.click();

          const dialog = page.getByRole("dialog");
          await dialog.getByText("AI connection", { exact: true }).waitFor();
          // Styled before anything in it is pressed, screenshots or not: unstyled, the dialog is
          // not lifted over the modal's backdrop, which then takes the press, as it never does in
          // the app.
          await style(page);
          await expect(
            dialog.getByText("API key", { exact: true }).count(),
          ).resolves.toBe(1);
          await shoot(page, "current", engine, theme, window);
          await dialog
            .getByRole("button", { name: "Change", exact: true })
            .click();

          // Every provider the setup window offers, in its order.
          const providers = dialog.getByRole("group", { name: "AI provider" });
          await dialog.getByRole("button", { name: /^Anthropic/ }).waitFor();
          expect(
            await providers.locator("[data-slot=item-title]").allTextContents(),
          ).toEqual([
            "OpenAI",
            "Anthropic",
            "Google Gemini",
            "xAI",
            "Unbiased AI",
            "TrustedRouter",
            "Any OpenAI-compatible endpoint",
          ]);
          expect(await measured(page)).toEqual(FINE);
          await shoot(page, "providers", engine, theme, window);

          await dialog.getByRole("button", { name: /^Anthropic/ }).click();
          const key = dialog.getByLabel("Anthropic API key");
          await key.waitFor();
          // A plain browser offers keys only: a plan signs in through OpenBot Desktop.
          expect(await dialog.getByText("Sign in with my plan").count()).toBe(
            0,
          );
          const connect = dialog.getByRole("button", { name: "Connect" });
          expect(await connect.isDisabled()).toBe(true);

          await key.fill(BAD_KEY);
          await connect.click();
          const alert = dialog.getByRole("alert");
          await alert.waitFor();
          expect(await alert.textContent()).toBe(
            "Anthropic didn't accept that key. Check it and paste it again.",
          );
          expect(server.connection.provider).toBe("openai");
          expect(await measured(page)).toEqual(FINE);
          await shoot(page, "refused", engine, theme, window);

          await key.fill(GOOD_KEY);
          // Typing again takes the old sentence away.
          expect(await dialog.getByRole("alert").count()).toBe(0);
          await connect.click();
          await dialog.getByText("Connected to Anthropic").waitFor();
          expect(await dialog.textContent()).not.toContain(GOOD_KEY);
          expect(await measured(page)).toEqual(FINE);
          await shoot(page, "connected", engine, theme, window);

          // Two presses, two writes, each with its own Idempotency-Key, each a body the spec takes.
          expect(server.replaces.map((replace) => replace.body)).toEqual([
            { provider: "anthropic", login: "api-key", apiKey: BAD_KEY },
            { provider: "anthropic", login: "api-key", apiKey: GOOD_KEY },
          ]);
          const keys = server.replaces.map((replace) => replace.idempotencyKey);
          expect(
            keys.every((one) => typeof one === "string" && one.length > 0),
          ).toBe(true);
          expect(new Set(keys).size).toBe(2);

          // The row under the dialog was read again: it names the new provider.
          await dialog.getByRole("button", { name: "Done" }).click();
          await page
            .getByRole("button", {
              name: /Anthropic.*Uses your Anthropic API key\./,
            })
            .waitFor();
        } finally {
          await page.close();
        }
      }, 90_000);

  for (const engine of engines)
    test(`a provider whose key is still kept connects with it, no key pasted, in ${engine}`, async () => {
      const server = new FakeServer();
      server.connection = {
        ...server.connection,
        provider: "anthropic",
        saved: [
          { provider: "openai", login: "api-key", endpointHost: null },
          { provider: "anthropic", login: "api-key", endpointHost: null },
        ],
      };
      const page = await open("/settings", server, engine, "light", WIDE);
      try {
        await page.getByRole("button", { name: /^Anthropic/ }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        await style(page);
        await dialog
          .getByRole("button", { name: "Change", exact: true })
          .click();
        await dialog.getByRole("button", { name: /^OpenAI/ }).click();
        const saved = dialog.getByRole("checkbox", {
          name: "Use the saved key",
        });
        await saved.waitFor();
        expect(await saved.getAttribute("aria-checked")).toBe("true");
        expect(await dialog.getByLabel("OpenAI API key").count()).toBe(0);
        await dialog.getByRole("button", { name: "Connect" }).click();
        await dialog.getByText("Connected to OpenAI").waitFor();
        expect(server.replaces.map((replace) => replace.body)).toEqual([
          { provider: "openai", login: "api-key", useSavedKey: true },
        ]);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    for (const theme of THEMES)
      test(`at a phone's width the dialog fits, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer();
        const page = await open("/settings", server, engine, theme, PHONE);
        try {
          await page.getByRole("button", { name: /^OpenAI/ }).click();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          await style(page);
          await dialog
            .getByRole("button", { name: "Change", exact: true })
            .click();
          await dialog
            .getByRole("button", { name: /^Any OpenAI-compatible/ })
            .click();
          await dialog.getByLabel("Address").fill("https://llm.example.com/v1");
          await dialog.getByLabel("Model name").fill("llama-5-70b");
          expect(await measured(page)).toEqual(FINE);
          await shoot(page, "endpoint", engine, theme, PHONE);
        } finally {
          await page.close();
        }
      }, 60_000);

  // Two Settings pages from before, to look at beside the new dialog.
  test.skipIf(!shots)(
    "screenshots of General and API keys from before",
    async () => {
      for (const engine of engines)
        for (const theme of THEMES) {
          const server = new FakeServer();
          const page = await open(
            "/settings/api-keys",
            server,
            engine,
            theme,
            WIDE,
          );
          try {
            await page
              .getByRole("button", { name: /Create/ })
              .first()
              .waitFor();
            await style(page);
            await page
              .getByRole("button", { name: /Create/ })
              .first()
              .click();
            await page.getByRole("dialog").waitFor();
            await shoot(page, "compare-api-keys", engine, theme, WIDE);
          } finally {
            await page.close();
          }
        }
    },
    120_000,
  );
});
