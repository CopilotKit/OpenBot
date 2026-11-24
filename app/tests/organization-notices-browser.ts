/**
 * The real-browser harness organization-moving.test.tsx and organization-removed.test.tsx share: a
 * server that answers at the API's addresses for a person in two organizations, each answer checked
 * against the generated schema, and the app (organization-notices.fixture.tsx) loaded in Chromium or
 * WebKit with the app's own stylesheet and font.
 *
 * The server can be put in the two states these tests are about, as OpenBot's server answers them:
 *
 * - Moving: every request about Northwind is refused 503 in problem details, with the sentence a
 *   person reads and `Retry-After` (organizations/holds.ts in the backend), until the move ends.
 * - Removed: the person is no longer a member of Northwind. An address that names it answers as an
 *   organization that does not exist (404 `ORGANIZATION_NOT_FOUND`), or, as the addresses the session
 *   decides do, 403 in the server's sentence. Their organizations no longer list it, and none is
 *   active while the session still names it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Request } from "playwright-core";
import { compile } from "tailwindcss";
import { ListCheckInsResponse } from "@/lib/api/generated/check-ins/check-ins.zod";
import { ListGoalsResponse } from "@/lib/api/generated/goals/goals.zod";
import { ListOrganizationsResponse } from "@/lib/api/generated/organizations/organizations.zod";
import { GetPreferencesResponse } from "@/lib/api/generated/people/people.zod";
import { ListRoutinesResponse } from "@/lib/api/generated/routines/routines.zod";
import { personBody } from "./accounts-api";
import { conversationPage, problemBody } from "./conversations-api";

export const asked = process.env.OPENBOT_APP_BROWSER === "1";
export const shots = process.env.OPENBOT_APP_SHOTS;
export const engines = (process.env.OPENBOT_APP_ENGINES ?? "chromium")
  .split(",")
  .map((engine) => engine.trim())
  .filter((engine) => engine === "chromium" || engine === "webkit") as (
  | "chromium"
  | "webkit"
)[];

/** The desktop width and a phone's, each light and dark. */
export const LOOKS = [
  { width: 1440, height: 900, theme: "light" },
  { width: 1440, height: 900, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
] as const;
export type Look = (typeof LOOKS)[number];

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";

export const NORTHWIND = {
  id: "org_northwind",
  slug: "northwind",
  name: "Northwind Freight",
};
export const OWN = {
  id: "org_dana",
  slug: "dana",
  name: "Dana's organization",
};

/** What a person reads while their organization is moved (organizations/holds.ts in the backend). */
export const MOVING =
  "OpenBot is moving this organization. Try again in a moment.";
/** What an address the session decides answers somebody who left it (organizations/request.ts). */
export const LEFT_REFUSAL =
  "You're no longer a member of the organization you were working in. Switch to another one.";

/** Each organization's one routine, so a page drawn from the right one is told by its row. */
const ROUTINE_TITLE: Record<string, string> = {
  [NORTHWIND.id]: "Northwind check",
  [OWN.id]: "Morning briefing",
};

function routine(organization: string) {
  return {
    id: `routine-${organization}`,
    botId: "general-assistant",
    schedule: "Weekdays at 16:55",
    cron: "55 16 * * 1-5",
    timezone: "UTC",
    instruction: "Say what changed since yesterday.",
    title: ROUTINE_TITLE[organization] ?? "A routine",
    conversation: {
      id: `conversation-${organization}`,
      name: "General Assistant",
      title: "Checks",
      gone: false,
    },
    enabled: true,
    nextRunAt: "2026-11-24T16:55:00.000Z",
    lastRun: null,
    goalId: null,
    createdAt: "2026-11-20T09:00:00.000Z",
  };
}

type Answer = {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
  contentType?: string;
};

export class FakeServer {
  /** The organization the session works in. */
  active: string = NORTHWIND.id;
  /** Until when Northwind is being moved, as a time from `Date.now()`; 0 when it is not. */
  movingUntil = 0;
  /** How long the server asks a client to wait while it moves Northwind. */
  retryAfterSeconds = 2;
  /** How an address refuses somebody removed from Northwind; undefined while they are a member. */
  removed: "404" | "403" | undefined;
  /** Every organization the app asked the session to work in. */
  switched: string[] = [];
  /** Each address refused for the move, by how many times. */
  refusedForMove = new Map<string, number>();
  /** Each list asked for, by organization and address, in order. */
  asked: string[] = [];

  answer(request: Request): Answer {
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/api/v2/people/me/organizations")
      return { status: 200, json: this.organizations() };
    if (path === "/api/auth/organization/set-active" && method === "POST") {
      const { organizationId } = request.postDataJSON() as {
        organizationId: string;
      };
      if (organizationId === NORTHWIND.id && this.removed)
        return { status: 403, json: { error: LEFT_REFUSAL } };
      this.switched.push(organizationId);
      this.active = organizationId;
      return { status: 200, json: { id: organizationId } };
    }
    const scoped = path.match(/^\/api\/v2\/organizations\/([^/]+)(\/.*)$/);
    if (!scoped) return this.notFound();
    const [, organization = "", rest = ""] = scoped;
    if (rest === "/deployment") return { status: 200, json: DEPLOYMENT };
    if (organization === NORTHWIND.id && this.removed === "404")
      return {
        status: 404,
        json: problemBody(
          404,
          "Couldn't find that organization.",
          "ORGANIZATION_NOT_FOUND",
        ),
        contentType: "application/problem+json",
      };
    if (organization === NORTHWIND.id && this.removed === "403")
      return { status: 403, json: { error: LEFT_REFUSAL } };
    if (organization === NORTHWIND.id && Date.now() < this.movingUntil) {
      this.refusedForMove.set(rest, (this.refusedForMove.get(rest) ?? 0) + 1);
      return {
        status: 503,
        json: problemBody(503, MOVING, "SERVICE_UNAVAILABLE"),
        contentType: "application/problem+json",
        headers: { "Retry-After": String(this.retryAfterSeconds) },
      };
    }
    if (organization !== NORTHWIND.id && organization !== OWN.id)
      return this.notFound();
    if (method !== "GET") return this.notFound();
    this.asked.push(`${organization} ${rest}`);
    switch (rest) {
      case "/people/me":
        return {
          status: 200,
          json: {
            person: personBody({
              id: "dana",
              name: "Dana Whitfield",
              email: "dana@example.com",
              role: organization === OWN.id ? "owner" : "user",
            }),
            openbotVersion: "v1.2.0",
          },
        };
      case "/people/me/preferences":
        return { status: 200, json: PREFERENCES };
      case "/routines":
        return {
          status: 200,
          json: ListRoutinesResponse.parse({
            routines: [routine(organization)],
            nextCursor: null,
          }),
        };
      case "/goals":
        return {
          status: 200,
          json: ListGoalsResponse.parse({ goals: [], nextCursor: null }),
        };
      case "/check-ins":
        return {
          status: 200,
          json: ListCheckInsResponse.parse({
            checkIns: [],
            allowed: true,
            nextCursor: null,
          }),
        };
      // Only what the strip and the routine rows read of a Bot, as section-strip-routines answers it.
      case "/bots":
        return {
          status: 200,
          json: {
            bots: [
              {
                id: "general-assistant",
                name: "General Assistant",
                title: "",
                roleDescription: "",
                avatarSeed: "General Assistant",
                lastConversationAt: null,
              },
            ],
            nextCursor: null,
          },
        };
      case "/conversations":
        return { status: 200, json: conversationPage([]) };
      case "/people/me/bot-attention":
        return {
          status: 200,
          json: { attention: [], lastPingId: null, nextCursor: null },
        };
      default:
        return this.notFound();
    }
  }

  organizations() {
    const listed = [
      ...(this.removed
        ? []
        : [{ ...NORTHWIND, role: "member", personal: false }]),
      { ...OWN, role: "owner", personal: true },
    ];
    return ListOrganizationsResponse.parse({
      organizations: listed.map((one) => ({
        ...one,
        active: one.id === this.active,
      })),
      canCreate: true,
      nextCursor: null,
    });
  }

  notFound(): Answer {
    return {
      status: 404,
      json: problemBody(404, "Not found.", "NOT_FOUND"),
      contentType: "application/problem+json",
    };
  }
}

const DEPLOYMENT = {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
  authProviders: [],
  ssoConfigured: false,
  ssoRequired: false,
  hostedSignIn: true,
};

const PREFERENCES = GetPreferencesResponse.parse({
  messageListEmphasis: "thread",
  selfHostBannerDismissed: false,
  dismissedNotices: [],
  noticesDue: [],
  narration: null,
  skin: "openbot",
  proactive: "on",
});

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
    entrypoints: [join(import.meta.dir, "organization-notices.fixture.tsx")],
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

/** Build the app and start each browser asked for. */
export async function start(): Promise<void> {
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
}

export async function stop(): Promise<void> {
  for (const browser of browsers.values()) await browser.close();
  browsers.clear();
}

/** The app opened at `path`, signed in, in a window of `look`'s size and theme. */
export async function open(
  engine: string,
  look: Look,
  server: FakeServer,
  path: string,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: { width: look.width, height: look.height },
    colorScheme: look.theme,
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
      let answer: Answer;
      try {
        answer = server.answer(route.request());
      } catch (error) {
        // A test's own answer that breaks the schema is said, never left hanging.
        console.error(where, error);
        return route.fulfill({ status: 500, body: "the test's server broke" });
      }
      const { status, json, headers, contentType } = answer;
      return route.fulfill({
        status,
        headers,
        contentType: contentType ?? "application/json",
        body: JSON.stringify(json),
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
  await style(page);
  return page;
}

/** Move to `to` in the app, as a link does. */
export async function go(page: Page, to: string): Promise<void> {
  await page.evaluate(
    (where) =>
      (
        window as unknown as {
          openbotRouter: { navigate: (to: { to: string }) => Promise<void> };
        }
      ).openbotRouter.navigate({ to: where }),
    to,
  );
}

/** Style the page for every class it draws now: what just opened brings classes of its own. */
export async function style(page: Page): Promise<void> {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

/** Save the page as `<name>-<step>-<engine>-<width>-<theme>.png` when screenshots are asked for. */
export async function shoot(
  page: Page,
  name: string,
  step: string,
  engine: string,
  look: Look,
): Promise<void> {
  await style(page);
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(
      shots,
      `${name}-${step}-${engine}-${look.width}-${look.theme}.png`,
    ),
  });
}

/** Sideways scroll, or a control past the window's edge. */
export async function cutOff(page: Page) {
  return page.evaluate(() => ({
    sideways: document.documentElement.scrollWidth > innerWidth,
    cut: [...document.querySelectorAll("button, a")]
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          (rect.left < -0.5 || rect.right > innerWidth + 0.5)
        );
      })
      .filter((control) => !control.matches("[data-sidebar=rail]"))
      .map((control) => control.textContent?.trim() || control.tagName),
  }));
}

/** The words of the page's alerts, in order. */
export async function alerts(page: Page): Promise<string[]> {
  return page
    .getByRole("alert")
    .evaluateAll((all) => all.map((one) => one.textContent?.trim() ?? ""));
}
