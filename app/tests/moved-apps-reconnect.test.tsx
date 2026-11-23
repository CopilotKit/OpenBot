import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Request } from "playwright-core";
import { compile } from "tailwindcss";
import { parse } from "yaml";
import {
  CreateAppBody,
  CreateAppResponse,
} from "@/lib/api/generated/apps/apps.zod";
import { ListConnectionsResponse } from "@/lib/api/generated/connections/connections.zod";
import type {
  Import,
  PersonalAiConnection,
  ReconnectApp,
} from "@/lib/api/generated/model";
import {
  GetPersonalAiConnectionResponse,
  ReplacePersonalAiConnectionBody,
} from "@/lib/api/generated/models/models.zod";
import { ListImportsResponse } from "@/lib/api/generated/moving-to-openbot-cloud/moving-to-openbot-cloud.zod";
import {
  GetPreferencesResponse,
  UpdatePreferencesBody,
} from "@/lib/api/generated/people/people.zod";
import { personBody } from "./accounts-api";
import { type AppsFixture, answerAppsApi, appBody } from "./apps-api";
import { connectionBody } from "./connections-api";

/**
 * After a move to OpenBot Cloud, the apps the move listed to connect again (their sign-ins stay on
 * the person's computer) stay in front of the person until each is connected or dismissed.
 *
 * The whole app on its real route tree, in a real browser, against a server held in this test (so
 * what it holds survives a reload) answering at the API's addresses, every answer checked against
 * the generated response schema and every body the app sends against the request schema:
 *
 * - The reconnect list (`/reconnect`) lists both apps. Reconnect on one opens its page with a way
 *   back; once it is connected (a browser's sign-in coming back to Connections) the person is back
 *   on the list with that app marked Reconnected and the other still offering Reconnect. A reload
 *   keeps that. The last one connected (the sign-in coming back to the app's own page) takes them
 *   home, where nothing is left to say.
 * - A move names an app as the computer knew it (`gmail`); here it is the app added from
 *   `directory:gmail`, with OpenBot Cloud's own id (`composio-gmail`), and that is the page it opens.
 * - An app the organization hasn't added waits for an admin, said on its row, even when OpenBot
 *   Desktop opens `/reconnect/<appId>` for it. An admin's Reconnect adds it first; a refused add
 *   comes back to the list and says so.
 * - Home says how many are left and leads to the list; Connections says it in one row.
 * - Dismissing an app removes it and saves `moved-app-<id>` to the person's dismissed notices; a
 *   reload keeps it gone. A sign-in that failed leaves them on Connections with the failure said.
 * - An OpenBot that takes no moves (404) shows none of it, and no error.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/moved-apps-reconnect.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each screen is saved as moved-apps-<screen>-<engine>-<theme>-<width>.png.
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

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
type Theme = "light" | "dark";
type Window = { width: number; height: number };

const svg = (body: string) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`).toString("base64")}`;
/** Gmail's mark, drawn small, as the app directory gives it. */
const GMAIL_ICON = svg(
  '<path fill="#4285f4" d="M2 6.5V18a1.5 1.5 0 0 0 1.5 1.5H6V10l-4-3.5z"/><path fill="#34a853" d="M18 19.5h2.5A1.5 1.5 0 0 0 22 18V6.5L18 10z"/><path fill="#ea4335" d="M6 10V5.5L12 10l6-4.5V10l-6 4.5z"/><path fill="#fbbc04" d="M18 5.5V10l4-3.5V6a1.5 1.5 0 0 0-2.4-1.2z"/><path fill="#c5221f" d="M2 6v.5L6 10V5.5L4.4 4.3A1.5 1.5 0 0 0 2 6z"/>',
);
const CALENDAR_LOGO = svg(
  '<rect x="3" y="4" width="18" height="17" rx="2" fill="#fff" stroke="#4285f4" stroke-width="2"/><rect x="3" y="4" width="18" height="5" fill="#4285f4"/><text x="12" y="18.5" font-size="8" font-family="Arial" font-weight="700" text-anchor="middle" fill="#4285f4">31</text>',
);

const GMAIL: ReconnectApp = {
  appId: "gmail",
  appName: "Gmail",
  accountLabel: "sam@example.com",
  iconUrl: GMAIL_ICON,
  botNames: ["Inbox", "Research"],
};
/** No icon from the move: the app's own logo is drawn. */
const CALENDAR: ReconnectApp = {
  appId: "googlecalendar",
  appName: "Google Calendar",
  accountLabel: "sam@example.com",
  botNames: ["Scheduler"],
};

/** In the directory, and not added in this organization yet. */
const SLACK: ReconnectApp = {
  appId: "slack",
  appName: "Slack",
  accountLabel: "Acme workspace",
  botNames: ["Inbox"],
};
/** Not added here, and the directory refuses to add it. */
const LINEAR: ReconnectApp = { appId: "linear", appName: "Linear" };

/** An app from the directory, as OpenBot Cloud adds it: its own id, from the entry it came from. */
function directoryApp(slug: string, title: string, summary: string) {
  return {
    id: `composio-${slug}`,
    title,
    provenance: "composio",
    url: `composio://${slug}`,
    authScheme: "OAUTH2",
    accountMode: "personal" as const,
    summary,
  };
}

/**
 * The apps as the organization has them: from the directory, signed in to as each person, each with
 * OpenBot Cloud's own id (`composio-gmail`) and the entry it came from (`directory:gmail`), which is
 * how a move, naming the app `gmail`, finds it.
 */
const APPS: AppsFixture = {
  composioConfigured: true,
  servers: [
    {
      id: "composio-gmail",
      title: "Gmail",
      provenance: "composio",
      url: "composio://gmail",
      authScheme: "OAUTH2",
      accountMode: "personal",
      logo: GMAIL_ICON,
      summary: "Read and send mail.",
    },
    {
      id: "composio-googlecalendar",
      title: "Google Calendar",
      provenance: "composio",
      url: "composio://googlecalendar",
      authScheme: "OAUTH2",
      accountMode: "personal",
      logo: CALENDAR_LOGO,
      summary: "Read and add events.",
    },
    directoryApp("notion", "Notion", "Read and write pages."),
  ],
};

/** A finished move, as listImports answers it, listing `reconnect`. */
function finishedMove(reconnect: ReconnectApp[]): Import {
  return {
    id: "imp_0e1f2a3b4c5d6f1d",
    status: "imported",
    sourceName: "Sam's MacBook",
    createdAt: "2026-11-21T10:00:00Z",
    finishedAt: "2026-11-21T10:03:12Z",
    recipientKey: {
      kty: "RSA",
      alg: "RSA-OAEP-256",
      kid: "imp_0e1f2a3b4c5d6f1d",
      e: "AQAB",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    },
    maxBundleBytes: 10737418240,
    maxPartBytes: 33554432,
    receivedParts: [1],
    reconnect,
  } as Import;
}

const NOT_FOUND = {
  type: "https://open.bot/errors/not-found",
  title: "Not found.",
  status: 404,
  detail: "Not found.",
  code: "NOT_FOUND",
};
/** The spec's MoveUnavailable answer, as any OpenBot but Cloud gives it. */
const MOVE_UNAVAILABLE = {
  type: "https://open.bot/errors/move-unavailable",
  title: "Moving isn't available here.",
  status: 404,
  detail: "Importing is available only on OpenBot Cloud.",
  code: "MOVE_UNAVAILABLE",
};

type Answer = { status: number; json: unknown };

const spec = parse(
  readFileSync(join(APP, "..", "api", "openapi.yaml"), "utf8"),
) as { components: { examples: Record<string, { value: unknown }> } };
/** The person's AI connection as the spec's example says it: OpenBot Cloud, with none yet. */
function personalAiNone(): PersonalAiConnection {
  return GetPersonalAiConnectionResponse.parse(
    structuredClone(
      spec.components.examples.PersonalAiConnectionNoneExample?.value,
    ),
  ) as PersonalAiConnection;
}
const GOOD_KEY = "sk-ant-api03-good";

/** One OpenBot Cloud's server, as far as these screens ask it. */
class FakeServer {
  /** The person's moves, or null on an OpenBot that takes none. */
  imports: Import[] | null;
  connected = new Set<string>();
  dismissed: string[] = [];
  /** Every preferences change the app sent, as its body was checked. */
  saves: unknown[] = [];
  /** Every request this server could not answer. */
  unanswered: string[] = [];
  /** The organization's apps, which an admin's add grows. */
  apps: AppsFixture = { ...APPS, servers: [...(APPS.servers ?? [])] };
  /** Every app added, by the entry it was asked for. */
  added: string[] = [];
  role: "member" | "admin";
  /**
   * The person's own AI on OpenBot Cloud, where one is required: null where the server answers
   * none (404, as an OpenBot that requires none), else the connection as the server keeps it.
   */
  ai: PersonalAiConnection | null = null;
  /**
   * Whether people sign in with their OpenBot by CopilotKit account (`hostedSignIn`): OpenBot
   * Cloud, the one OpenBot that takes a move. False is a self-hosted OpenBot or the personal edition.
   */
  hosted: boolean;
  /** How many times the app asked for the person's moves. */
  importAsks = 0;
  /** Every API request answered 400 or more, as the browser's network panel would list it. */
  failed: string[] = [];

  constructor(
    imports: Import[] | null,
    role: "member" | "admin" = "member",
    hosted = true,
  ) {
    this.imports = imports;
    this.role = role;
    this.hosted = hosted;
  }

  async answer(request: Request): Promise<Answer> {
    const answer = await this.answerOf(request);
    if (answer.status >= 400)
      this.failed.push(
        `${answer.status} ${request.method()} ${new URL(request.url()).pathname}`,
      );
    return answer;
  }

  async answerOf(request: Request): Promise<Answer> {
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (path === `${ME}/ai-connection` && this.ai) {
      if (method === "PUT") {
        const sent = request.postDataJSON() as Record<string, unknown>;
        const input = ReplacePersonalAiConnectionBody.parse(sent);
        this.ai = GetPersonalAiConnectionResponse.parse({
          ...this.ai,
          connection: {
            provider: input.provider,
            login: input.login,
            model: null,
            endpointHost: null,
            keySet: true,
            ready: true,
            source: "stored",
            editable: true,
            saved: [
              {
                provider: input.provider,
                login: input.login,
                endpointHost: null,
              },
            ],
            changedAt: "2026-11-22T10:00:00.000Z",
          },
          uses: "personal",
        }) as PersonalAiConnection;
      }
      return { status: 200, json: this.ai };
    }
    if (path === `${ORGANIZATION}/imports` && method === "GET") {
      this.importAsks += 1;
      if (this.imports === null) return { status: 404, json: MOVE_UNAVAILABLE };
      return {
        status: 200,
        json: ListImportsResponse.parse({
          items: this.imports,
          nextCursor: null,
        }),
      };
    }
    if (path === `${ME}/connections` && method === "GET")
      return {
        status: 200,
        json: ListConnectionsResponse.parse({
          connections: [...this.connected].map((serverId) =>
            connectionBody({
              serverId,
              verified: true,
              verifiedAt: "2026-11-22T09:00:00.000Z",
              probe: null,
              checkable: true,
            }),
          ),
          nextCursor: null,
        }),
      };
    if (path === `${ME}/preferences` && method === "GET")
      return { status: 200, json: this.preferences() };
    if (path === `${ME}/preferences` && method === "PATCH") {
      expect(request.headers()["idempotency-key"]?.length ?? 0).toBeGreaterThan(
        0,
      );
      const sent = request.postDataJSON() as Record<string, unknown>;
      const body = UpdatePreferencesBody.parse(sent);
      for (const key of Object.keys(sent))
        expect(Object.keys(body)).toContain(key);
      this.saves.push(sent);
      for (const notice of body.dismissedNotices ?? [])
        if (!this.dismissed.includes(notice)) this.dismissed.push(notice);
      return { status: 200, json: this.preferences() };
    }
    if (path === ME && method === "GET")
      return {
        status: 200,
        json: {
          person: personBody({
            id: "sam",
            name: "Sam Rivera",
            email: "sam@example.com",
            role: this.role,
            onboarding: { step: 1, completedAt: "2026-11-21T10:05:00.000Z" },
          }),
          openbotVersion: "v1.2.0",
        },
      };
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
          hostedSignIn: this.hosted,
        },
      };
    if (path === `${ORGANIZATION}/bots` && method === "GET")
      return { status: 200, json: { bots: [], nextCursor: null } };
    if (path === `${ORGANIZATION}/conversations` && method === "GET")
      return { status: 200, json: { conversations: [], nextCursor: null } };
    // No GitHub or Slack accounts to link here, as an OpenBot without them answers.
    if (path.includes("/linked-account"))
      return {
        status: 503,
        json: {
          ...NOT_FOUND,
          status: 503,
          code: "LINKED_ACCOUNTS_UNAVAILABLE",
        },
      };
    if (path === `${ORGANIZATION}/apps` && method === "POST") {
      expect(request.headers()["idempotency-key"]?.length ?? 0).toBeGreaterThan(
        0,
      );
      expect(this.role).toBe("admin");
      const sent = request.postDataJSON() as Record<string, unknown>;
      CreateAppBody.parse(sent);
      expect(sent.from).toBe("directory");
      const entry = String(sent.directoryEntryId);
      this.added.push(entry);
      // Slack is in the directory; nothing else asked for here is.
      if (entry !== "directory:slack")
        return {
          status: 404,
          json: {
            ...NOT_FOUND,
            detail: "That app isn't in the directory.",
          },
        };
      const slack = directoryApp("slack", "Slack", "Read and send messages.");
      this.apps.servers = [...(this.apps.servers ?? []), slack];
      return { status: 201, json: CreateAppResponse.parse(appBody(slack)) };
    }
    const apps = answerAppsApi(url.toString(), { method }, this.apps);
    if (apps) return { status: apps.status, json: await apps.json() };
    this.unanswered.push(`${method} ${path}`);
    return { status: 404, json: NOT_FOUND };
  }

  preferences() {
    return GetPreferencesResponse.parse({
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
      dismissedNotices: this.dismissed,
      noticesDue: [],
      narration: null,
      skin: "openbot",
      proactive: "on",
    });
  }
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "moved-apps-reconnect.fixture.tsx")],
    target: "browser",
    // An optional map renderer a library loads only when asked to draw a map; not installed.
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

/** The page at `path`, its server answering from `server`. */
async function open(
  path: string,
  server: FakeServer,
  engine: string,
  theme: Theme = "light",
  window: Window = WIDE,
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
  // Nothing leaves for another site: a vendor's page is an empty one.
  await page.context().route(
    (url) => url.origin !== ORIGIN && url.protocol.startsWith("http"),
    (route) => route.fulfill({ contentType: "text/html", body: "" }),
  );
  await page.route(`${ORIGIN}/**`, async (route) => {
    const where = new URL(route.request().url()).pathname;
    if (where === "/app.js")
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
    if (where.includes(".")) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
  return page;
}

/** Style the page for every class it draws now. */
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
      `moved-apps-${screen}-${engine}-${theme}-${window.width}.png`,
    ),
  });
}

/** What a person would see wrong: sideways scroll, or a control cut off at the side. */
async function measured(page: Page) {
  await style(page);
  return page.evaluate(() => {
    const inside = (rect: DOMRect) =>
      rect.left >= -0.5 && rect.right <= innerWidth + 0.5;
    // The page's own column (under its title) and the bars over it.
    const column = document.querySelector(
      "[data-slot=page-header]",
    )?.parentElement;
    const cut = [
      ...(column?.querySelectorAll("button, a, input, [data-moved-app] *") ??
        []),
      ...document.querySelectorAll("aside button, aside a"),
    ]
      .filter((control) => {
        const rect = control.getBoundingClientRect();
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

const heading = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name }).waitFor();
const row = (page: Page, appId: string) =>
  page.locator(`[data-moved-app="${appId}"]`);
const path = (page: Page) => new URL(page.url()).pathname;

/** Connect your AI with a key, and its button. */
async function connectAi(page: Page) {
  const chooser = page.locator("[data-ai-chooser]");
  await chooser.getByRole("button", { name: /^Anthropic/ }).click();
  await chooser.getByRole("tab", { name: "Use an API key" }).click();
  await chooser.getByLabel("Anthropic API key").fill(GOOD_KEY);
  await chooser.getByRole("button", { name: "Connect" }).click();
  await chooser.getByRole("status").waitFor();
  await page.locator("[data-onboarding-primary]").click();
}

/** Reconnect on the list: the app's page, its sign-in, and back to the list connected. */
async function reconnectThrough(
  page: Page,
  server: FakeServer,
  appId: string,
  cloudId: string,
) {
  await row(page, appId).getByRole("button", { name: "Reconnect" }).click();
  await page.waitForURL(`${ORIGIN}/connections/${cloudId}`);
  server.connected.add(cloudId);
  await page.goto(`${ORIGIN}/connections?connected=${cloudId}`);
  await page.waitForURL(`${ORIGIN}/reconnect`);
}

describe.skipIf(!asked)("apps to reconnect after a move", () => {
  for (const engine of engines)
    test(`the person works through the list and is taken home when done, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([GMAIL, CALENDAR])]);
      const page = await open("/", server, engine);
      try {
        // Home says there is something to do, and leads to the list.
        const bar = page.getByRole("complementary", {
          name: "Apps to reconnect",
        });
        await bar.waitFor();
        expect(await bar.textContent()).toContain(
          "2 apps from your move still need reconnecting.",
        );
        await shoot(page, "home-bar", engine, "light", WIDE);
        await bar.getByRole("button", { name: "Reconnect" }).click();
        await heading(page, "Reconnect your apps");
        expect(path(page)).toBe("/reconnect");
        await row(page, "googlecalendar").waitFor();
        expect(await row(page, "gmail").textContent()).toContain(
          "sam@example.com · Used by Inbox and Research",
        );
        for (const app of ["gmail", "googlecalendar"])
          await row(page, app)
            .getByRole("button", { name: "Reconnect" })
            .waitFor();
        // No bar over the list that already says it.
        expect(await bar.count()).toBe(0);
        expect(await measured(page)).toEqual(FINE);

        // Gmail: its page, with the way back to the list.
        await row(page, "gmail")
          .getByRole("button", { name: "Reconnect" })
          .click();
        // The move named it `gmail`; here it is the app added from `directory:gmail`.
        await page.waitForURL(`${ORIGIN}/connections/composio-gmail`);
        await page
          .getByRole("button", { name: "Your apps to reconnect" })
          .waitFor();
        await page.getByRole("heading", { level: 1, name: "Gmail" }).waitFor();
        // Off to Google's sign-in, which connects it; the browser's sign-in comes back to Connections.
        await page.goto("https://accounts.google.test/signin");
        server.connected.add("composio-gmail");
        await page.goto(`${ORIGIN}/connections?connected=composio-gmail`);
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "gmail").getByText("Reconnected").waitFor();
        expect(
          await row(page, "gmail")
            .getByRole("button", { name: "Reconnect" })
            .count(),
        ).toBe(0);
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();

        // A reload shows the same.
        await page.reload();
        await row(page, "gmail").getByText("Reconnected").waitFor();
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();
        await page.getByRole("button", { name: "Go to OpenBot" }).waitFor();

        // Google Calendar, whose sign-in comes back to its own page: the last one, so home.
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.waitForURL(`${ORIGIN}/connections/composio-googlecalendar`);
        await page.goto("https://accounts.google.test/signin");
        server.connected.add("composio-googlecalendar");
        await page.goto(
          `${ORIGIN}/connections/composio-googlecalendar?status=success&connected_account_id=ca_1`,
        );
        await page.waitForURL(`${ORIGIN}/`);
        // Nothing left to say anywhere.
        await page.waitForTimeout(500);
        expect(
          await page
            .getByRole("complementary", { name: "Apps to reconnect" })
            .count(),
        ).toBe(0);
        // The list, opened again, shows both connected and the way on.
        await page.goto(`${ORIGIN}/reconnect`);
        await row(page, "googlecalendar").getByText("Reconnected").waitFor();
        await page.getByRole("button", { name: "Done" }).click();
        await page.waitForURL(`${ORIGIN}/`);
        expect(server.saves).toEqual([]);
      } finally {
        await page.close();
      }
    }, 120_000);

  /*
   * Reported on 1.2.0-rc.1: Reconnect after the move met Connect your AI, whose button then left
   * the person on home, with no app connected and the list gone. Connect your AI comes first (OpenBot
   * Desktop opens the list, and the gate asks for the AI on the way), then the list, each app's page,
   * back to the list after each, and home after the last.
   */
  for (const engine of engines)
    test(`after the move, Connect your AI first, then the list, each app and back, then home, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([GMAIL, CALENDAR])]);
      server.ai = personalAiNone();
      // Where OpenBot Desktop's "Connect your AI" opens OpenBot Cloud.
      const page = await open("/reconnect", server, engine);
      try {
        await heading(page, "Connect your AI");
        expect(new URL(page.url()).searchParams.get("next")).toBe("/reconnect");
        await connectAi(page);
        await heading(page, "Reconnect your apps");
        expect(path(page)).toBe("/reconnect");

        await reconnectThrough(page, server, "gmail", "composio-gmail");
        await row(page, "gmail").getByText("Reconnected").waitFor();
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();
        await page.reload();
        await row(page, "gmail").getByText("Reconnected").waitFor();
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();

        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.waitForURL(`${ORIGIN}/connections/composio-googlecalendar`);
        server.connected.add("composio-googlecalendar");
        await page.goto(
          `${ORIGIN}/connections?connected=composio-googlecalendar`,
        );
        await page.waitForURL(`${ORIGIN}/`);
      } finally {
        await page.close();
      }
    }, 120_000);

  for (const engine of engines)
    test(`an app's Reconnect that meets Connect your AI lands on that app's page once the AI is connected, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([GMAIL, CALENDAR])]);
      server.ai = personalAiNone();
      // Where OpenBot Desktop's Reconnect on Gmail opens OpenBot Cloud.
      const page = await open("/reconnect/gmail", server, engine);
      try {
        await heading(page, "Connect your AI");
        await connectAi(page);
        await page.waitForURL(`${ORIGIN}/connections/composio-gmail`);
        await page.getByRole("heading", { level: 1, name: "Gmail" }).waitFor();
        // And connecting it comes back to the list, with the other still to do.
        server.connected.add("composio-gmail");
        await page.goto(`${ORIGIN}/connections?connected=composio-gmail`);
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "gmail").getByText("Reconnected").waitFor();
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();
      } finally {
        await page.close();
      }
    }, 120_000);

  for (const engine of engines)
    test(`an app not added here waits for an admin, a dismissed app stays gone, and a failed sign-in stays on Connections, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([GMAIL, CALENDAR, SLACK])]);
      const page = await open("/reconnect", server, engine);
      try {
        await row(page, "googlecalendar").waitFor();
        // Slack isn't added in this organization, and only an admin may add it.
        await row(page, "slack")
          .getByText("An admin has to turn Slack on before you can connect it.")
          .waitFor();
        expect(
          await row(page, "slack")
            .getByRole("button", { name: "Reconnect" })
            .count(),
        ).toBe(0);
        // Opened straight from OpenBot Desktop: back to the list, never a page that isn't there.
        await page.goto(`${ORIGIN}/reconnect/slack`);
        await page.waitForURL((url) => url.pathname === "/reconnect");
        await row(page, "slack")
          .getByText("An admin has to turn Slack on before you can connect it.")
          .waitFor();
        expect(server.added).toEqual([]);
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Dismiss Google Calendar" })
          .click();
        await row(page, "googlecalendar").waitFor({ state: "detached" });
        expect(server.saves).toEqual([
          { dismissedNotices: ["moved-app-googlecalendar"] },
        ]);
        await page.reload();
        await row(page, "gmail").waitFor();
        expect(await row(page, "googlecalendar").count()).toBe(0);

        // Connections says it in one row, and it leads back to the list.
        await page.goto(`${ORIGIN}/connections`);
        const notice = page.locator("[data-moved-apps-notice]");
        await notice.waitFor();
        expect(await notice.textContent()).toContain(
          "2 apps from your move still need reconnecting",
        );
        // A sign-in that failed: nothing connected, so the person stays where the failure is said.
        await page.goto(`${ORIGIN}/reconnect/gmail`);
        await page.waitForURL(`${ORIGIN}/connections/composio-gmail`);
        await page.goto(`${ORIGIN}/connections?connected=failed`);
        await page.getByText("Couldn't connect that account.").waitFor();
        await page.waitForTimeout(500);
        expect(path(page)).toBe("/connections");
        await notice.getByRole("button", { name: "Reconnect" }).click();
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "gmail").waitFor();
      } finally {
        await page.close();
      }
    }, 120_000);

  for (const engine of engines)
    test(`an admin's Reconnect adds an app the organization hasn't yet, and says so when it can't, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([SLACK, LINEAR])], "admin");
      const page = await open("/reconnect", server, engine);
      try {
        await row(page, "slack")
          .getByRole("button", { name: "Reconnect" })
          .click();
        // Added from its directory entry, then its own page, with the way back.
        await page.waitForURL(`${ORIGIN}/connections/composio-slack`);
        await page.getByRole("heading", { level: 1, name: "Slack" }).waitFor();
        await page
          .getByRole("button", { name: "Your apps to reconnect" })
          .click();
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "slack")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();
        // The directory refuses Linear: back on the list, the row says so.
        await row(page, "linear")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await row(page, "linear")
          .getByText("Couldn't turn Linear on here. Try again in a moment.")
          .waitFor();
        expect(path(page)).toBe("/reconnect");
        await row(page, "linear")
          .getByRole("button", { name: "Try again" })
          .waitFor();
        expect(server.added).toEqual(["directory:slack", "directory:linear"]);
        await shoot(page, "admin-refused", engine, "light", WIDE);
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`an OpenBot that takes no moves shows none of it, in ${engine}`, async () => {
      const server = new FakeServer(null);
      const page = await open("/connections", server, engine);
      try {
        await page.locator('[data-testid="account-composio-gmail"]').waitFor();
        await page.waitForTimeout(500);
        expect(await page.locator("[data-moved-apps-notice]").count()).toBe(0);
        expect(await page.getByRole("alert").allTextContents()).toEqual([]);
        await page.goto(`${ORIGIN}/reconnect`);
        await page.waitForURL(`${ORIGIN}/`);
        await page.waitForTimeout(500);
        expect(
          await page
            .getByRole("complementary", { name: "Apps to reconnect" })
            .count(),
        ).toBe(0);
        expect(await page.getByRole("alert").count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 60_000);

  /*
   * Found by the server's personal-edition journey on the 1.2.0-rc.2 candidate: every page of a
   * self-hosted OpenBot or the personal edition asked for the person's moves, which only OpenBot
   * Cloud takes, and each answer was a 404 in the network panel. Nothing showed, but every page
   * made a failing request. An OpenBot that isn't hosted is never asked.
   */
  for (const engine of engines)
    test(`an OpenBot that isn't OpenBot Cloud is never asked for moves, on any page, in ${engine}`, async () => {
      const server = new FakeServer(null, "member", false);
      const page = await open("/", server, engine);
      try {
        // Home, drawn in the frame that carries the reconnect bar, with every read it made answered.
        await page.waitForLoadState("networkidle");
        expect(server.importAsks).toBe(0);
        await page.goto(`${ORIGIN}/connections`);
        await page.locator('[data-testid="account-composio-gmail"]').waitFor();
        await page.goto(`${ORIGIN}/reconnect`);
        await page.waitForURL(`${ORIGIN}/`);
        await page.waitForTimeout(500);
        expect(server.importAsks).toBe(0);
        expect(
          server.failed.filter((line) => line.endsWith("/imports")),
        ).toEqual([]);
        expect(
          await page
            .getByRole("complementary", { name: "Apps to reconnect" })
            .count(),
        ).toBe(0);
        expect(await page.locator("[data-moved-apps-notice]").count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [WIDE, PHONE])
        test(`the screens fit and look like the app, ${theme} at ${window.width}, in ${engine}`, async () => {
          const server = new FakeServer([
            finishedMove([GMAIL, CALENDAR, SLACK]),
          ]);
          const page = await open("/reconnect", server, engine, theme, window);
          try {
            await row(page, "slack").waitFor();
            await page.waitForTimeout(300);
            expect(await measured(page)).toEqual(FINE);
            await shoot(page, "list", engine, theme, window);
            server.connected.add("composio-gmail");
            await page.reload();
            await row(page, "gmail").getByText("Reconnected").waitFor();
            expect(await measured(page)).toEqual(FINE);
            await shoot(page, "list-one-done", engine, theme, window);
            await page.goto(`${ORIGIN}/connections`);
            await page.locator("[data-moved-apps-notice]").waitFor();
            await page
              .locator('[data-testid="account-composio-notion"]')
              .waitFor();
            expect(await measured(page)).toEqual(FINE);
            await shoot(page, "connections", engine, theme, window);
            // Beside it, Connections as it was: nothing moved here.
            server.imports = null;
            await page.reload();
            await page
              .locator('[data-testid="account-composio-notion"]')
              .waitFor();
            await page.waitForTimeout(300);
            await shoot(page, "connections-before", engine, theme, window);
          } finally {
            await page.close();
          }
        }, 90_000);
});
