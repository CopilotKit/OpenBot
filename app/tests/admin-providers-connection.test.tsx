import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Request } from "playwright-core";
import { compile } from "tailwindcss";
import { parse } from "yaml";
import type {
  AiConnection,
  PersonalAiConnection,
} from "@/lib/api/generated/model";
import {
  DeleteAiConnectionResponse,
  GetAiConnectionResponse,
  GetModelCatalogueResponse,
  GetPersonalAiConnectionResponse,
  ReplaceAiConnectionBody,
} from "@/lib/api/generated/models/models.zod";
import { personBody } from "./accounts-api";
import {
  DEPLOYMENT_PATH,
  deploymentBody,
  MODEL_USAGE_PATH,
  overviewResponse,
} from "./admin-settings-api";

/**
 * Admin → Providers: an admin changes the organization's AI, disconnects it and connects another,
 * with the same chooser Settings and Connect your AI use. On OpenBot Cloud it says which AI is the
 * organization's and which is the admin's own, and links to Settings → Your AI to change their own.
 * Somebody who isn't an admin never reaches it.
 *
 * The finding behind it: on OpenBot Cloud an admin who connected a Claude plan as their own AI saw
 * "Connected: Claude plan" here, as if it were the organization's, with no way to change anything.
 * The page read the model catalogue, which the server reads with the viewer's own AI ahead of the
 * organization's. So the fake server here answers the catalogue as it does for that admin (their
 * Claude plan), and the organization's connection as OpenAI: the page must name OpenAI as the
 * organization's and the Claude plan as theirs.
 *
 * In a real browser, in Admin's real frame behind its own gate. Every answer is checked against
 * the generated response schema and every body against the request schema, from api/openapi.yaml.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/admin-providers-connection.test.tsx
 *
 * Chromium by default, as CI has it. With OPENBOT_APP_SHOTS=<dir> each state is saved as
 * admin-providers-<state>-<engine>-<theme>-<width>.png.
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
const PERSONAL_AI_CONNECTION = `${ORGANIZATION}/people/me/ai-connection`;
const MODEL_CATALOGUE = `${ORGANIZATION}/model-catalogue`;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
type Window = { width: number; height: number };

type Problem = Record<string, unknown>;
type Examples = Record<string, { value: Problem }>;
const spec = parse(
  readFileSync(join(APP, "..", "api", "openapi.yaml"), "utf8"),
) as {
  components: {
    responses: Record<
      string,
      { content: { "application/problem+json": { examples: Examples } } }
    >;
    examples: Record<string, { value: unknown }>;
  };
};
/** The spec's own refusal of somebody who isn't an admin. */
const NOT_ADMIN =
  spec.components.responses.AdminOnly?.content["application/problem+json"]
    .examples.notAdmin?.value;
if (!NOT_ADMIN) throw new Error("the spec has no AdminOnly example");

/** The spec's own examples of a person's AI on OpenBot Cloud. */
function personalExample(name: string): PersonalAiConnection {
  const example = spec.components.examples[name]?.value;
  if (!example) throw new Error(`the spec has no ${name}`);
  return GetPersonalAiConnectionResponse.parse(example) as PersonalAiConnection;
}

/** The admin's own Claude plan, ahead of the organization's OpenAI: what David had. */
function ownClaudePlan(): PersonalAiConnection {
  const own = personalExample("PersonalAiConnectionExample");
  return {
    ...own,
    connection: {
      ...own.connection,
      provider: "anthropic",
      login: "plan",
      keySet: false,
    },
  };
}

const GOOD_KEY = "sk-ant-api03-good";

/** One OpenBot's server, as far as these screens ask it. */
class FakeServer {
  role: "admin" | "member" = "admin";
  connection: AiConnection = GetAiConnectionResponse.parse(
    spec.components.examples.AiConnectionExample?.value,
  ) as AiConnection;
  personal: PersonalAiConnection | null = ownClaudePlan();
  /** Every request to the organization's AI connection, by method. */
  aiConnectionRequests: string[] = [];
  writes: { method: string; body: unknown; idempotencyKey: string | null }[] =
    [];

  constructor() {
    // The organization's: OpenAI, by key, with Anthropic's key kept from before.
    this.connection = {
      ...this.connection,
      provider: "openai",
      saved: [
        { provider: "openai", login: "api-key", endpointHost: null },
        { provider: "anthropic", login: "api-key", endpointHost: null },
      ],
    };
  }

  async answer(request: Request): Promise<{ status: number; json: unknown }> {
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === AI_CONNECTION) {
      this.aiConnectionRequests.push(method);
      if (this.role !== "admin") return { status: 403, json: NOT_ADMIN };
      if (method === "GET")
        return {
          status: 200,
          json: GetAiConnectionResponse.parse(this.connection),
        };
      const idempotencyKey = request.headers()["idempotency-key"] ?? null;
      if (method === "DELETE") {
        this.writes.push({ method, body: null, idempotencyKey });
        // The key in use is revoked; the others stay kept.
        const used = this.connection.provider;
        this.connection = DeleteAiConnectionResponse.parse({
          provider: null,
          login: null,
          model: null,
          endpointHost: null,
          keySet: false,
          ready: false,
          source: "none",
          editable: true,
          saved: this.connection.saved.filter(
            (saved) => saved.provider !== used,
          ),
          changedAt: "2026-11-21T10:00:00.000Z",
        }) as AiConnection;
        if (this.personal)
          this.personal = {
            ...this.personal,
            organization: { ready: false, provider: null },
          };
        return { status: 200, json: this.connection };
      }
      if (method === "PUT") {
        const body = request.postDataJSON() as Record<string, unknown>;
        this.writes.push({ method, body, idempotencyKey });
        const input = ReplaceAiConnectionBody.parse(body);
        for (const key of Object.keys(body))
          expect(Object.keys(input)).toContain(key);
        this.connection = GetAiConnectionResponse.parse({
          provider: input.provider,
          login: input.login,
          model: input.model ?? null,
          endpointHost: null,
          keySet: true,
          ready: true,
          source: "stored",
          editable: true,
          saved: [
            ...this.connection.saved.filter(
              (saved) => saved.provider !== input.provider,
            ),
            {
              provider: input.provider,
              login: input.login,
              endpointHost: null,
            },
          ],
          changedAt: "2026-11-21T10:05:00.000Z",
        }) as AiConnection;
        if (this.personal)
          this.personal = {
            ...this.personal,
            organization: { ready: true, provider: input.provider },
          };
        return { status: 200, json: this.connection };
      }
    }
    if (path === PERSONAL_AI_CONNECTION) {
      if (!this.personal)
        return { status: 404, json: { detail: "Not found." } };
      return {
        status: 200,
        json: GetPersonalAiConnectionResponse.parse(this.personal),
      };
    }
    if (path === MODEL_CATALOGUE) {
      // As the server reads it for this admin: with their own AI, the Claude plan, first.
      const own = this.personal?.uses === "personal";
      return {
        status: 200,
        json: GetModelCatalogueResponse.parse({
          provider: own ? "anthropic" : "openai",
          source: own ? "claude" : "openai",
          exposure: "allowed",
          default: own ? "claude-sonnet-5-5" : "gpt-6.1-terra",
          models: [
            own
              ? {
                  id: "claude-sonnet-5-5",
                  label: "Claude Sonnet 5.5",
                  vendor: "anthropic",
                }
              : {
                  id: "gpt-6.1-terra",
                  label: "GPT-6.1 Terra",
                  vendor: "openai",
                },
          ],
          choosable: false,
          listed: true,
        }),
      };
    }
    if (path === `${ORGANIZATION}/people/me`)
      return {
        status: 200,
        json: {
          person: personBody({
            id: "dana",
            name: "Dana Whitfield",
            email: "dana@example.com",
            role: this.role,
          }),
          openbotVersion: "v1.2.0",
        },
      };
    if (path === DEPLOYMENT_PATH)
      return { status: 200, json: deploymentBody({ edition: "team" }) };
    if (path === MODEL_USAGE_PATH)
      return { status: 200, json: { days: 30, summary: [], recent: [] } };
    const overview = overviewResponse(`${path}${url.search}`, {});
    if (overview) return { status: 200, json: await overview.json() };
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
    entrypoints: [
      join(import.meta.dir, "admin-providers-connection.fixture.tsx"),
    ],
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
  await page.route(`${ORIGIN}/**`, async (route) => {
    const where = new URL(route.request().url()).pathname;
    if (where === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, where.split("/").pop() ?? "");
    if (where.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (where.startsWith("/api/")) {
      const { status, json } = await server.answer(route.request());
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
  state: string,
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
      `admin-providers-${state}-${engine}-${theme}-${window.width}.png`,
    ),
    fullPage: true,
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
      // A switch's own hidden checkbox, 1px and clipped, which nobody sees or presses.
      .filter((control) => !control.matches("input[aria-hidden=true]"))
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

/** A section of the page, by its heading. */
function section(page: Page, title: string) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  });
}

describe.skipIf(!asked)("Admin → Providers: the organization's AI", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of [WIDE, PHONE])
        test(`on OpenBot Cloud it names the organization's AI and the admin's own apart, in ${engine}, ${theme}, ${window.width}`, async () => {
          const server = new FakeServer();
          const page = await open(
            "/admin/providers",
            server,
            engine,
            theme,
            window,
          );
          try {
            const organization = section(page, "Organization's AI");
            await organization
              .getByRole("button", {
                name: /OpenAI.*Uses your organization's OpenAI API key\./,
              })
              .waitFor();
            // The admin's own Claude plan is never shown as the organization's.
            expect(await organization.textContent()).not.toContain("Claude");
            const yours = section(page, "Your AI");
            const link = yours.getByRole("link", {
              name: /Anthropic.*Signed in with your Claude plan\. Only you use it\./,
            });
            await link.waitFor();
            expect(await link.getAttribute("href")).toBe("/settings#your-ai");
            // One model listed is one model, not "1 models".
            await section(page, "In conversations")
              .getByText("1 model, kept current from your provider.")
              .waitFor();
            expect(await measured(page)).toEqual(FINE);
            await shoot(page, "cloud-own", engine, theme, window);
          } finally {
            await page.close();
          }
        }, 60_000);

  for (const engine of engines)
    for (const theme of THEMES)
      test(`an admin changes the organization's AI, disconnects it and connects another, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer();
        const window = WIDE;
        const page = await open(
          "/admin/providers",
          server,
          engine,
          theme,
          window,
        );
        try {
          const organization = section(page, "Organization's AI");
          await organization.getByRole("button", { name: /^OpenAI/ }).click();
          const dialog = page.getByRole("dialog");
          await dialog
            .getByText("Organization's AI", { exact: true })
            .waitFor();
          // Styled before anything in it is pressed: unstyled, the backdrop takes the press.
          await style(page);
          expect(await measured(page)).toEqual(FINE);
          await shoot(page, "dialog-current", engine, theme, window);

          // Change: the same chooser as Settings, keys in a browser.
          await dialog
            .getByRole("button", { name: "Change", exact: true })
            .click();
          await dialog.getByRole("button", { name: /^Anthropic/ }).click();
          await dialog
            .getByRole("checkbox", { name: "Use the saved key" })
            .click();
          await dialog.getByLabel("Anthropic API key").fill(GOOD_KEY);
          await shoot(page, "dialog-change", engine, theme, window);
          await dialog.getByRole("button", { name: "Connect" }).click();
          await dialog.getByText("Connected to Anthropic").waitFor();
          await dialog.getByRole("button", { name: "Done" }).click();
          await organization
            .getByRole("button", {
              name: /Anthropic.*Uses your organization's Anthropic API key\./,
            })
            .waitFor();
          await shoot(page, "changed", engine, theme, window);

          // Disconnect: nothing in use, and the row says so.
          await organization
            .getByRole("button", { name: /^Anthropic/ })
            .click();
          await dialog
            .getByText(
              "Disconnect it and Bots work only for people who connected their own AI.",
            )
            .waitFor();
          await style(page);
          await dialog.getByRole("button", { name: "Disconnect" }).click();
          await dialog.waitFor({ state: "hidden" });
          await organization
            .getByRole("button", { name: /Not chosen yet/ })
            .waitFor();
          await shoot(page, "disconnected", engine, theme, window);

          // Connect another: OpenAI, whose key is still kept, no key pasted.
          await organization
            .getByRole("button", { name: /Not chosen yet/ })
            .click();
          await dialog.getByRole("button", { name: /^OpenAI/ }).click();
          const saved = dialog.getByRole("checkbox", {
            name: "Use the saved key",
          });
          await saved.waitFor();
          expect(await saved.getAttribute("aria-checked")).toBe("true");
          await dialog.getByRole("button", { name: "Connect" }).click();
          await dialog.getByText("Connected to OpenAI").waitFor();
          await dialog.getByRole("button", { name: "Done" }).click();
          await organization
            .getByRole("button", {
              name: /OpenAI.*Uses your organization's OpenAI API key\./,
            })
            .waitFor();

          // Three writes, each a body the spec takes, each with its own Idempotency-Key.
          expect(
            server.writes.map((write) => [write.method, write.body]),
          ).toEqual([
            [
              "PUT",
              { provider: "anthropic", login: "api-key", apiKey: GOOD_KEY },
            ],
            ["DELETE", null],
            [
              "PUT",
              { provider: "openai", login: "api-key", useSavedKey: true },
            ],
          ]);
          const keys = server.writes.map((write) => write.idempotencyKey);
          expect(keys.every((key) => typeof key === "string" && key)).toBe(
            true,
          );
          expect(new Set(keys).size).toBe(3);
          // The admin's own AI never changed.
          expect(server.personal?.connection.provider).toBe("anthropic");
        } finally {
          await page.close();
        }
      }, 90_000);

  for (const engine of engines)
    test(`the admin's own AI opens Settings → Your AI, where they change it, in ${engine}`, async () => {
      const server = new FakeServer();
      const page = await open(
        "/admin/providers",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await section(page, "Your AI").getByRole("link").click();
        await page.waitForURL(`${ORIGIN}/settings#your-ai`);
        const yours = section(page, "Your AI");
        await yours
          .getByRole("button", {
            name: /Anthropic.*Signed in with your Claude plan\./,
          })
          .waitFor();
        await style(page);
        await shoot(page, "settings-your-ai", engine, "light", WIDE);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`somebody who isn't an admin never reaches it, in ${engine}`, async () => {
      const server = new FakeServer();
      server.role = "member";
      const page = await open(
        "/admin/providers",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await page.locator("[data-app-home]").waitFor();
        expect(new URL(page.url()).pathname).toBe("/");
        expect(server.aiConnectionRequests).toEqual([]);
        expect(server.writes).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

  /*
   * The page's other states, to look at: an admin with no AI of their own (theirs is the
   * organization's), a self-hosted OpenBot (no "Your AI"), one whose AI is set where it runs, and
   * the chooser at a phone's width.
   */
  for (const engine of engines)
    test(`each state of the page holds its layout, in ${engine}`, async () => {
      const states: [string, (server: FakeServer) => void][] = [
        [
          "cloud-uses-organization",
          (server) => {
            server.personal = personalExample(
              "PersonalAiConnectionOrganizationExample",
            );
          },
        ],
        [
          "self-hosted",
          (server) => {
            server.personal = null;
          },
        ],
        [
          "fixed",
          (server) => {
            server.personal = null;
            server.connection = GetAiConnectionResponse.parse(
              spec.components.examples.AiConnectionFixedExample?.value,
            ) as AiConnection;
          },
        ],
      ];
      for (const theme of THEMES)
        for (const window of [WIDE, PHONE])
          for (const [state, given] of states) {
            const server = new FakeServer();
            given(server);
            const page = await open(
              "/admin/providers",
              server,
              engine,
              theme,
              window,
            );
            try {
              if (state === "cloud-uses-organization") {
                await section(page, "Your AI")
                  .getByRole("link", { name: /Your organization's AI/ })
                  .waitFor();
              } else {
                const provider = section(page, "AI provider");
                await provider.getByText("OpenAI", { exact: true }).waitFor();
                expect(await section(page, "Your AI").count()).toBe(0);
                if (state === "fixed") {
                  // Set where OpenBot runs: a row that states it, nothing to press.
                  await provider
                    .getByText(/Set by whoever runs OpenBot\./)
                    .waitFor();
                  expect(await provider.getByRole("button").count()).toBe(0);
                }
              }
              expect(await measured(page)).toEqual(FINE);
              await shoot(page, state, engine, theme, window);
              if (state === "self-hosted" && window === PHONE) {
                await section(page, "AI provider")
                  .getByRole("button", { name: /^OpenAI/ })
                  .click();
                const dialog = page.getByRole("dialog");
                await dialog.waitFor();
                await style(page);
                await dialog
                  .getByRole("button", { name: "Change", exact: true })
                  .click();
                await dialog
                  .getByRole("button", { name: /^Anthropic/ })
                  .waitFor();
                expect(await measured(page)).toEqual(FINE);
                await shoot(page, "chooser", engine, theme, window);
              }
            } finally {
              await page.close();
            }
          }
    }, 240_000);
});
