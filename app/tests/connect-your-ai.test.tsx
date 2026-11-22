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
  GetAiConnectionResponse,
  GetPersonalAiConnectionResponse,
  GetPersonalAiSignInResponse,
  ReplacePersonalAiConnectionBody,
  StartPersonalAiSignInBody,
  StartPersonalAiSignInResponse,
} from "@/lib/api/generated/models/models.zod";
import { ListOrganizationsResponse } from "@/lib/api/generated/organizations/organizations.zod";
import { personBody } from "./accounts-api";

/**
 * Connect your AI, on an OpenBot that provides no AI of its own (OpenBot Cloud).
 *
 * In a real browser, through the app's own signed-in gate (`_authed`), its onboarding route and
 * Settings → General:
 *
 * - A new person whose organization has no AI is held at Connect your AI: its button is disabled,
 *   there is no way past it, and the gate sends them back to it from anywhere in the app. A key the
 *   provider refuses says why; a good one connects, and the button takes them in.
 * - A new person whose organization has an AI never sees the step.
 * - Somebody who finished onboarding before the step existed is sent to it as their only step, and
 *   its button takes them in without finishing onboarding again.
 * - Inside OpenBot Desktop the chooser still offers no plan, and Unbiased AI signs in through the
 *   server: the code, Open the sign-in page, then Connect with the key the server kept.
 * - Settings shows Your AI: theirs, which can be removed, back to the organization's.
 *
 * The server is served as routes at the API's address, answering as api/openapi.yaml says: the
 * spec's own examples for the person's AI connection, every body the page sends checked against the
 * generated request schema, every answer against the response schema.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/connect-your-ai.test.tsx
 *
 * Chromium by default, as CI has it. With OPENBOT_APP_SHOTS=<dir> each screen is saved as
 * connect-ai-<screen>-<engine>-<theme>-<width>.png, beside onboarding's Welcome and Settings' AI
 * connection dialog from before.
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
const PERSONAL = `${ME}/ai-connection`;
const SIGN_INS = `${PERSONAL}/sign-ins`;

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
const REFUSED =
  spec.components.responses.AiConnectionRefused?.content[
    "application/problem+json"
  ].examples.keyRefused?.value;
if (!REFUSED) throw new Error("the spec has no keyRefused example");

const GOOD_KEY = "sk-ant-api03-good";
const BAD_KEY = "sk-ant-api03-refused";

type Start = "none" | "organization";

/** The person's AI connection as the spec's example for `start` says it. */
function personalFor(start: Start): PersonalAiConnection {
  return GetPersonalAiConnectionResponse.parse(
    example(
      start === "none"
        ? "PersonalAiConnectionNoneExample"
        : "PersonalAiConnectionOrganizationExample",
    ),
  ) as PersonalAiConnection;
}

/**
 * The organization's own AI, as an admin reads it, agreeing with what the person's answer says of
 * it: none on OpenBot Cloud until one is set.
 */
function organizationAi(personal: PersonalAiConnection) {
  const organization: AiConnection = {
    provider: personal.organization.provider,
    login: personal.organization.provider ? "api-key" : null,
    model: null,
    endpointHost: null,
    keySet: personal.organization.ready,
    ready: personal.organization.ready,
    source: personal.organization.ready ? "stored" : "none",
    editable: true,
    saved: [],
    changedAt: null,
  };
  return GetAiConnectionResponse.parse(organization);
}

/** A second organization the person is in, beside `default`. */
const ACME = "/api/v2/organizations/acme";

/** One organization, as the person's list of their own answers it. */
function organizationRow(id: string, name: string, active: boolean) {
  return { personal: false, id, slug: id, name, role: "member", active };
}

/** One OpenBot Cloud's server, as far as these screens ask it. */
class FakeServer {
  personal: PersonalAiConnection;
  /**
   * The person's answer in Acme, a second organization they are in, or null when they are in only
   * `default` (the list of their organizations is then not served, as OpenBot with one answers).
   */
  acme: PersonalAiConnection | null = null;
  /** The organization the session works in. */
  active = "default";
  onboarding: { step: number; completedAt: string | null };
  replaces: unknown[] = [];
  removes = 0;
  completes = 0;
  signIns: unknown[] = [];
  signInReads = 0;
  signOuts = 0;

  constructor(start: Start, onboarded = false) {
    this.personal = personalFor(start);
    this.onboarding = onboarded
      ? { step: 1, completedAt: "2026-11-01T09:00:00.000Z" }
      : { step: 0, completedAt: null };
  }

  answer(request: Request): { status: number; json: unknown } {
    const url = new URL(request.url());
    const method = request.method();
    // Acme answers as `default` does, but for the person's AI there.
    const inAcme = url.pathname.startsWith(`${ACME}/`) && this.acme !== null;
    const path = inAcme
      ? `${ORGANIZATION}${url.pathname.slice(ACME.length)}`
      : url.pathname;
    if (inAcme && this.acme && path === PERSONAL && method === "GET")
      return { status: 200, json: this.acme };
    if (inAcme && this.acme && path === `${ORGANIZATION}/ai-connection`)
      return { status: 200, json: organizationAi(this.acme) };
    if (url.pathname === "/api/v2/people/me/organizations" && this.acme)
      return {
        status: 200,
        json: ListOrganizationsResponse.parse({
          organizations: [
            organizationRow("default", "Default", this.active === "default"),
            organizationRow("acme", "Acme", this.active === "acme"),
          ],
          canCreate: false,
          nextCursor: null,
        }),
      };
    if (url.pathname === "/api/auth/organization/set-active") {
      this.active = (
        request.postDataJSON() as { organizationId: string }
      ).organizationId;
      return { status: 200, json: {} };
    }
    if (url.pathname === "/api/auth/sign-out") {
      this.signOuts += 1;
      return { status: 200, json: { success: true } };
    }
    if (path === PERSONAL && method === "GET")
      return { status: 200, json: this.personal };
    if (path === PERSONAL && method === "PUT") {
      expect(request.headers()["idempotency-key"]?.length ?? 0).toBeGreaterThan(
        0,
      );
      const body = request.postDataJSON() as Record<string, unknown>;
      this.replaces.push(body);
      const input = ReplacePersonalAiConnectionBody.parse(body);
      for (const key of Object.keys(body))
        expect(Object.keys(input)).toContain(key);
      if (input.apiKey === BAD_KEY) return { status: 422, json: REFUSED };
      const host = input.baseUrl ? new URL(input.baseUrl).host : null;
      this.personal = GetPersonalAiConnectionResponse.parse({
        ...this.personal,
        connection: {
          provider: input.provider,
          login: input.login,
          model: input.model ?? null,
          endpointHost: host,
          keySet: true,
          ready: true,
          source: "stored",
          editable: true,
          saved: [
            {
              provider: input.provider,
              login: input.login,
              endpointHost: host,
            },
          ],
          changedAt: "2026-11-21T10:00:00.000Z",
        },
        uses: "personal",
      }) as PersonalAiConnection;
      return { status: 200, json: this.personal };
    }
    if (path === PERSONAL && method === "DELETE") {
      this.removes += 1;
      const none = example("PersonalAiConnectionNoneExample") as {
        connection: unknown;
      };
      this.personal = GetPersonalAiConnectionResponse.parse({
        ...this.personal,
        connection: none.connection,
        uses: this.personal.organization.ready ? "organization" : "none",
      }) as PersonalAiConnection;
      return { status: 200, json: this.personal };
    }
    if (path === SIGN_INS && method === "POST") {
      const body = StartPersonalAiSignInBody.parse(request.postDataJSON());
      this.signIns.push(body);
      // The spec's example, read again every second rather than five so the test is quick.
      return {
        status: 201,
        json: StartPersonalAiSignInResponse.parse({
          ...example("AiSignInExample"),
          interval: 1,
        }),
      };
    }
    if (path.startsWith(`${SIGN_INS}/`) && method === "GET") {
      this.signInReads += 1;
      return {
        status: 200,
        json: GetPersonalAiSignInResponse.parse({
          ...example(
            this.signInReads < 2
              ? "AiSignInPendingExample"
              : "AiSignInApprovedExample",
          ),
          interval: 1,
        }),
      };
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
    if (path === `${ME}/onboarding/complete` && method === "POST") {
      this.completes += 1;
      this.onboarding = {
        ...this.onboarding,
        completedAt: "2026-11-21T10:05:00.000Z",
      };
      return { status: 200, json: { onboarding: this.onboarding } };
    }
    if (path === `${ORGANIZATION}/ai-connection` && method === "GET")
      return { status: 200, json: organizationAi(this.personal) };
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
    entrypoints: [join(import.meta.dir, "connect-your-ai.fixture.tsx")],
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

/** The page at `path`, its server answering from `server`; `desktop` puts it in a Desktop window. */
async function open(
  path: string,
  server: FakeServer,
  engine: string,
  theme: Theme,
  window: Window,
  desktop = false,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  if (desktop)
    // OpenBot Desktop's window, as the page sees it: Tauri's IPC, answering nothing it is asked.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async () => null,
      };
    });
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
    path: join(
      shots,
      `connect-ai-${screen}-${engine}-${theme}-${window.width}.png`,
    ),
    fullPage: true,
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
        // A switch's or a radio's own input is a 1px box out of sight; its control is what shows.
        return rect.width > 1 && rect.height > 1;
      })
      .filter((control) => !control.matches("[data-sidebar=rail]"))
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
const primary = (page: Page) => page.locator("[data-onboarding-primary]");
const heading = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name }).waitFor();

describe.skipIf(!asked)("Connect your AI on OpenBot Cloud", () => {
  for (const engine of engines)
    test(`a new person is held at Connect your AI until they connect, then goes in, in ${engine}`, async () => {
      const server = new FakeServer("none");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        // The gate sends a new person to onboarding; Welcome first, then Connect your AI.
        await heading(page, "Welcome to OpenBot");
        await page.waitForFunction(
          () =>
            !document
              .querySelector("[data-onboarding-primary]")
              ?.hasAttribute("disabled"),
        );
        await primary(page).click();
        await heading(page, "Connect your AI");
        expect(new URL(page.url()).searchParams.get("step")).toBe("ai");
        expect(await primary(page).isDisabled()).toBe(true);
        // No way past it.
        expect(await page.locator("[data-onboarding-secondary]").count()).toBe(
          0,
        );

        // Anywhere else in the app sends them back to it.
        await page.goto(`${ORIGIN}/settings`);
        await heading(page, "Connect your AI");
        expect(new URL(page.url()).pathname).toBe("/onboarding");

        const chooser = page.locator("[data-ai-chooser]");
        // A key for every provider, and no plan: the server runs this person's Bots.
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        await chooser.getByLabel("OpenAI API key").waitFor();
        expect(await chooser.getByText("Sign in with my plan").count()).toBe(0);
        await chooser.getByRole("button", { name: "Back" }).click();

        await chooser.getByRole("button", { name: /^Anthropic/ }).click();
        const key = chooser.getByLabel("Anthropic API key");
        await key.fill(BAD_KEY);
        await chooser.getByRole("button", { name: "Connect" }).click();
        const alert = chooser.getByRole("alert");
        await alert.waitFor();
        expect(await alert.textContent()).toBe(
          "Anthropic didn't accept that key. Check it and paste it again.",
        );
        expect(server.personal.uses).toBe("none");
        expect(await primary(page).isDisabled()).toBe(true);

        await key.fill(GOOD_KEY);
        await chooser.getByRole("button", { name: "Connect" }).click();
        await chooser.getByRole("status").waitFor();
        expect(await chooser.textContent()).not.toContain(GOOD_KEY);
        expect(server.replaces).toEqual([
          { provider: "anthropic", login: "api-key", apiKey: BAD_KEY },
          { provider: "anthropic", login: "api-key", apiKey: GOOD_KEY },
        ]);
        expect(await measured(page)).toEqual(FINE);

        // Connected: the step's button is the way in, and it finishes onboarding.
        expect(await primary(page).textContent()).toContain("Get started");
        await primary(page).click();
        await page.locator("[data-app-home]").waitFor();
        expect(server.completes).toBe(1);
        expect(new URL(page.url()).pathname).toBe("/");
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`a person whose organization has an AI goes straight in, in ${engine}`, async () => {
      const server = new FakeServer("organization");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        await heading(page, "Welcome to OpenBot");
        // One step: no "Step 1 of 2", no Connect your AI.
        expect(await page.locator("[data-onboarding-steps]").count()).toBe(0);
        await page.waitForFunction(
          () =>
            !document
              .querySelector("[data-onboarding-primary]")
              ?.hasAttribute("disabled"),
        );
        await primary(page).click();
        await page.locator("[data-app-home]").waitFor();
        // And once in, nothing sends them back.
        await page.goto(`${ORIGIN}/settings`);
        await page.getByRole("heading", { name: "Your AI" }).waitFor();
        await page
          .getByRole("button", { name: /Your organization's AI/ })
          .waitFor();
        expect(new URL(page.url()).pathname).toBe("/settings");
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`somebody who finished onboarding before has the step alone, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open("/settings", server, engine, "light", WIDE);
      try {
        await heading(page, "Connect your AI");
        expect(await page.locator("[data-onboarding-steps]").count()).toBe(0);
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^Anthropic/ }).click();
        await chooser.getByLabel("Anthropic API key").fill(GOOD_KEY);
        await chooser.getByRole("button", { name: "Connect" }).click();
        await chooser.getByRole("status").waitFor();
        await primary(page).click();
        await page.locator("[data-app-home]").waitFor();
        // Already finished: not finished again, and no place in it saved.
        expect(server.completes).toBe(0);
        expect(server.onboarding.step).toBe(1);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`inside OpenBot Desktop: no plan, and Unbiased AI signs in through the server, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
        true,
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        await chooser.getByLabel("OpenAI API key").waitFor();
        expect(await chooser.getByRole("tab").count()).toBe(0);
        expect(await chooser.getByText("Sign in with my plan").count()).toBe(0);
        await chooser.getByRole("button", { name: "Back" }).click();

        await chooser.getByRole("button", { name: /^Unbiased AI/ }).click();
        // Sign-in first, a key as the alternative.
        expect(await chooser.getByRole("tab").allTextContents()).toEqual([
          "Sign in",
          "Use an API key",
        ]);
        await chooser
          .getByRole("button", {
            name: "Sign in with Unbiased AI",
            exact: true,
          })
          .click();
        await chooser.getByText("BCDF-GHJK").waitFor();
        await chooser
          .getByRole("link", { name: "Open the sign-in page" })
          .waitFor();
        await shoot(page, "sign-in-waiting", engine, "light", WIDE);
        await chooser.getByText("Signed in to Unbiased AI.").waitFor();
        expect(server.signIns).toEqual([{ provider: "unbiased" }]);
        await chooser.getByRole("button", { name: "Connect" }).click();
        await chooser.getByRole("status").waitFor();
        expect(server.replaces).toEqual([
          {
            provider: "unbiased",
            login: "endpoint",
            baseUrl: "https://api.unbiased.ai/v1",
            model: "pareto",
            useSavedKey: true,
          },
        ]);
        expect(await primary(page).isDisabled()).toBe(false);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`Settings shows Your AI, and removing it goes back to the organization's, in ${engine}`, async () => {
      const server = new FakeServer("organization", true);
      server.personal = GetPersonalAiConnectionResponse.parse(
        example("PersonalAiConnectionExample"),
      ) as PersonalAiConnection;
      const page = await open("/settings", server, engine, "light", WIDE);
      try {
        await page.getByRole("heading", { name: "Your AI" }).waitFor();
        // The admin's section for the organization's AI says it is the organization's.
        await page
          .getByRole("heading", { name: "Organization's AI" })
          .waitFor();
        await page
          .getByRole("button", {
            name: /Anthropic.*Uses your Anthropic API key\./,
          })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog.getByText("Your AI", { exact: true }).waitFor();
        await style(page);
        await dialog.getByRole("button", { name: "Remove" }).click();
        await page
          .getByRole("button", { name: /Your organization's AI/ })
          .waitFor();
        expect(server.removes).toBe(1);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`switching into an organization with no AI sends them to the step at once, in ${engine}`, async () => {
      // Default has an AI for everyone; Acme has none, and the person has none of their own.
      const server = new FakeServer("organization", true);
      server.acme = personalFor("none");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        await page.locator("[data-app-home]").waitFor();
        await page.getByRole("button", { name: "Work in Acme" }).click();
        // No second click: the gate decides again in Acme as soon as the app works there.
        await heading(page, "Connect your AI");
        expect(server.active).toBe("acme");
        expect(new URL(page.url()).searchParams.get("step")).toBe("ai");
        expect(await page.locator("[data-app-home]").count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`the step lets them work in another organization of theirs, or sign out, in ${engine}`, async () => {
      // Default has no AI and neither do they; Acme has one for everyone.
      const server = new FakeServer("none", true);
      server.acme = personalFor("organization");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        await heading(page, "Connect your AI");
        // Styled: the way out is drawn beside the words on a desktop and under the chooser on a
        // phone, and the stylesheet is what shows one of them.
        await page.getByText("Signed in as dana@example.com").first().waitFor();
        await style(page);
        await page
          .getByRole("heading", { name: "Or work in another organization" })
          .waitFor();
        // Only the others: Default is where they are.
        const others = page.getByRole("group", {
          name: "Or work in another organization",
        });
        expect(
          await others.locator("[data-slot=item-title]").allTextContents(),
        ).toEqual(["Acme"]);
        await others.getByRole("button", { name: /Acme/ }).click();
        await page.locator("[data-app-home]").waitFor();
        expect(server.active).toBe("acme");
      } finally {
        await page.close();
      }

      // In one organization there is no list, and Sign out is always there.
      const alone = new FakeServer("none", true);
      const single = await open("/", alone, engine, "light", WIDE);
      try {
        await heading(single, "Connect your AI");
        await single
          .getByText("Signed in as dana@example.com")
          .first()
          .waitFor();
        await style(single);
        // One of the two is shown: beside the words here, at a desktop's width.
        expect(
          await single
            .getByText("Signed in as dana@example.com")
            .filter({ visible: true })
            .count(),
        ).toBe(1);
        expect(
          await single
            .getByRole("heading", { name: "Or work in another organization" })
            .count(),
        ).toBe(0);
        await single.getByRole("button", { name: "Sign out" }).click();
        await single.locator("[data-sign-in]").waitFor();
        expect(alone.signOuts).toBe(1);
      } finally {
        await single.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`on Cloud the organization's AI is said to be the organization's, in ${engine}`, async () => {
      const server = new FakeServer("organization", true);
      server.personal = GetPersonalAiConnectionResponse.parse(
        example("PersonalAiConnectionExample"),
      ) as PersonalAiConnection;
      const page = await open("/settings", server, engine, "light", WIDE);
      try {
        // Its key is the organization's, not the admin's own.
        await page
          .getByRole("button", {
            name: /OpenAI.*Uses your organization's OpenAI API key\./,
          })
          .waitFor();
      } finally {
        await page.close();
      }

      // With none set yet, the dialog sets one up rather than changing it.
      const unset = new FakeServer("organization", true);
      unset.personal = GetPersonalAiConnectionResponse.parse({
        ...example("PersonalAiConnectionExample"),
        organization: { ready: false, provider: null },
      }) as PersonalAiConnection;
      const second = await open("/settings", unset, engine, "light", WIDE);
      try {
        await second
          .getByRole("button", {
            name: /Not chosen yet.*Choose an AI for everyone in your organization\./,
          })
          .click();
        const dialog = second.getByRole("dialog");
        await dialog
          .getByText("Set up your organization's AI", { exact: true })
          .waitFor();
        expect(await dialog.getByText("Change AI connection").count()).toBe(0);
      } finally {
        await second.close();
      }
    }, 60_000);

  // Every screen this adds, light and dark, wide and at a phone's width, beside the screens from
  // before they should match: onboarding's Welcome and Settings' AI connection dialog.
  test.skipIf(!shots)(
    "screenshots of the step and Settings, beside Welcome and the AI connection dialog",
    async () => {
      for (const engine of engines)
        for (const theme of THEMES)
          for (const window of [WIDE, PHONE]) {
            const fresh = new FakeServer("none");
            const page = await open("/", fresh, engine, theme, window);
            try {
              await heading(page, "Welcome to OpenBot");
              await shoot(page, "compare-welcome", engine, theme, window);
              await page.waitForFunction(
                () =>
                  !document
                    .querySelector("[data-onboarding-primary]")
                    ?.hasAttribute("disabled"),
              );
              await primary(page).click();
              await heading(page, "Connect your AI");
              expect(await measured(page)).toEqual(FINE);
              await shoot(page, "step", engine, theme, window);
              const chooser = page.locator("[data-ai-chooser]");
              await chooser
                .getByRole("button", { name: /^Unbiased AI/ })
                .click();
              expect(await measured(page)).toEqual(FINE);
              await shoot(page, "step-unbiased", engine, theme, window);
              await chooser
                .getByRole("tab", { name: "Use an API key" })
                .click();
              await chooser.getByLabel("Unbiased AI API key").fill("ub-key");
              await chooser.getByRole("button", { name: "Connect" }).click();
              await chooser.getByRole("status").waitFor();
              expect(await measured(page)).toEqual(FINE);
              await shoot(page, "step-connected", engine, theme, window);
            } finally {
              await page.close();
            }

            const own = new FakeServer("organization", true);
            own.personal = GetPersonalAiConnectionResponse.parse(
              example("PersonalAiConnectionExample"),
            ) as PersonalAiConnection;
            const settings = await open(
              "/settings",
              own,
              engine,
              theme,
              window,
            );
            try {
              await settings
                .getByRole("heading", { name: "Your AI" })
                .waitFor();
              await settings
                .getByRole("heading", { name: "Organization's AI" })
                .waitFor();
              expect(await measured(settings)).toEqual(FINE);
              await shoot(settings, "settings", engine, theme, window);
              await settings
                .getByRole("button", { name: /Anthropic.*Uses your Anthropic/ })
                .click();
              await settings.getByRole("dialog").waitFor();
              await shoot(settings, "settings-dialog", engine, theme, window);
              await settings
                .getByRole("dialog")
                .getByRole("button", { name: "Change", exact: true })
                .click();
              await settings
                .getByRole("dialog")
                .getByRole("button", { name: /^Unbiased AI/ })
                .waitFor();
              await shoot(settings, "settings-chooser", engine, theme, window);
              await settings.keyboard.press("Escape");
              await settings.getByRole("dialog").waitFor({ state: "detached" });
              // The organization's AI connection dialog from before, to compare.
              await settings
                .getByRole("button", { name: /Not chosen yet|OpenAI/ })
                .first()
                .click();
              await settings.getByRole("dialog").waitFor();
              await shoot(
                settings,
                "compare-org-dialog",
                engine,
                theme,
                window,
              );
            } finally {
              await settings.close();
            }

            // The step for somebody in two organizations: the other one to work in instead.
            const two = new FakeServer("none", true);
            two.acme = personalFor("organization");
            const both = await open("/", two, engine, theme, window);
            try {
              await heading(both, "Connect your AI");
              await both
                .getByRole("heading", {
                  name: "Or work in another organization",
                })
                .first()
                .waitFor();
              expect(await measured(both)).toEqual(FINE);
              await shoot(
                both,
                "step-other-organizations",
                engine,
                theme,
                window,
              );
            } finally {
              await both.close();
            }

            // The organization's AI with none set yet: the dialog sets one up.
            const unset = new FakeServer("organization", true);
            unset.personal = GetPersonalAiConnectionResponse.parse({
              ...example("PersonalAiConnectionExample"),
              organization: { ready: false, provider: null },
            }) as PersonalAiConnection;
            const setup = await open("/settings", unset, engine, theme, window);
            try {
              await setup
                .getByRole("button", { name: /Not chosen yet/ })
                .click();
              await setup.getByRole("dialog").waitFor();
              await shoot(setup, "org-setup-dialog", engine, theme, window);
            } finally {
              await setup.close();
            }
          }
    },
    600_000,
  );
});
