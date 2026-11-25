import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Request } from "playwright-core";
import { compile } from "tailwindcss";
import type { Import } from "@/lib/api/generated/model";
import {
  ApplyImportHeader,
  ApplyImportResponse,
  CreateImportBody,
  CreateImportHeader,
  CreateImportResponse,
  GetImportResponse,
  GetImportVerificationResponse,
  ListImportsResponse,
} from "@/lib/api/generated/moving-to-openbot-cloud/moving-to-openbot-cloud.zod";
import { ListOrganizationsResponse } from "@/lib/api/generated/organizations/organizations.zod";
import {
  GetPreferencesResponse,
  UpdatePreferencesBody,
} from "@/lib/api/generated/people/people.zod";
import { movedElsewhereNoticeId } from "@/lib/moves/moved-elsewhere";
import { personBody } from "./accounts-api";

/**
 * After a move to OpenBot Cloud, the person can tell where their Bots went and as whom they are
 * signed in.
 *
 * OpenBot Desktop moves everything into the person's own organization. A browser can sign in
 * working in another of theirs (their company's), where none of it is. Seen on 1.2.0-rc.3: a person
 * went to OpenBot Cloud after the move, found none of their Bots, and nothing said where they were
 * or which account the app used.
 *
 * In a real browser, Chromium and WebKit, light and dark, against a server held in this test that
 * answers at the API's addresses, each answer checked against the generated schema:
 *
 * - Working in Acme, with their move in Sam's organization: a bar names where the Bots are, Switch
 *   moves the session there (`set-active`) and the bar goes, and a reload keeps it gone.
 * - Dismiss saves the bar's notice to their preferences, and a reload keeps it gone in Acme.
 * - Move them to Acme moves the Bots across from Sam's organization (createImport with
 *   fromOrganizationId, applyImport, getImport until imported, getImportVerification), says it is
 *   moving while it runs, and the bar goes once they are here, after a reload too.
 * - A move that stops says the server's sentence, and Try again goes on with the same move.
 * - Where Acme doesn't let them use Bots, a sentence says so in place of Move; where the list says
 *   nothing (an older OpenBot Cloud) and the server refuses, its own sentence is shown.
 * - In the organization the Bots left, the bar names the one they went to: the newest move decides.
 * - Working where their newest move is, nothing is said.
 * - Settings → Computer inside OpenBot Desktop connected to OpenBot Cloud names the account and the
 *   organization this app is signed in as.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/moved-elsewhere.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each step is saved as moved-elsewhere-<step>-<engine>-<theme>.png.
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
const WINDOW = { width: 1280, height: 800 };
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const ACME = { id: "org_acme", slug: "acme", name: "Acme" };
const OWN = { id: "org_sam", slug: "sam", name: "Sam's organization" };

/** The move OpenBot Desktop made into Sam's own organization, as listImports answers it. */
const MOVE: Import = {
  id: "imp_7a1c2e9d4b6f0a3c",
  status: "imported",
  sourceName: "OpenBot on Sam's MacBook",
  createdAt: "2026-11-23T16:20:00Z",
  finishedAt: "2026-11-23T16:24:10Z",
  recipientKey: {
    kty: "RSA",
    alg: "RSA-OAEP-256",
    kid: "imp_7a1c2e9d4b6f0a3c",
    e: "AQAB",
    n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
  },
  maxBundleBytes: 10737418240,
  maxPartBytes: 33554432,
  receivedParts: [1],
  reconnect: [],
} as Import;

const NOT_FOUND = {
  type: "https://open.bot/errors/not-found",
  title: "Not found.",
  status: 404,
  detail: "Not found.",
  code: "NOT_FOUND",
};

/**
 * A move of Sam's Bots from Sam's organization into Acme, finished after the move from the
 * computer: the newest, as listImports in Acme answers it.
 */
const MOVED_ACROSS: Import = {
  ...MOVE,
  id: "imp_3c9e1b7a5d2f4e8b",
  sourceName: OWN.name,
  fromOrganizationId: OWN.id,
  createdAt: "2026-11-24T09:00:00Z",
  finishedAt: "2026-11-24T09:01:30Z",
  receivedParts: [],
};

/** OpenBot Cloud's own sentence for MOVE_NOT_ALLOWED (api/openapi/moves.yaml, MoveNotAllowed). */
const NOT_ALLOWED = {
  type: "https://open.bot/errors/move-not-allowed",
  title: "You can't move Bots into this organization.",
  status: 403,
  detail:
    "An admin of Acme hasn't let you use Bots there, so your Bots can't move in. Ask an admin of Acme to turn on Use Bots for you.",
  code: "MOVE_NOT_ALLOWED",
  category: "permission",
  retryable: false,
  requestId: "req_test",
  traceId: "trace_test",
};

const INVALID = {
  type: "https://open.bot/errors/invalid-request",
  title: "Invalid request.",
  status: 400,
  detail: "That request isn't one this address takes.",
  code: "INVALID_REQUEST",
};

/** The sentence a stopped move says in `error`, as getImport answers it when failed. */
const STOPPED = "The move stopped before everything arrived. Try again.";

type Answer = { status: number; json: unknown };

/** OpenBot Cloud's server, as far as these screens ask it. */
class FakeServer {
  /** The organization the session works in. */
  active: string;
  dismissed: string[] = [];
  /** Every organization whose moves the app asked for, in order. */
  importsAsked: string[] = [];
  /** Every organization the app asked the session to work in. */
  switched: string[] = [];
  unanswered: string[] = [];
  /** Each organization's moves, newest first, as listImports answers them. */
  imports: Record<string, Import[]> = { [ACME.id]: [], [OWN.id]: [MOVE] };
  /** Organization.canMoveIn for each: undefined leaves it out, as an older OpenBot Cloud does. */
  canMoveIn: Record<string, boolean | undefined> = {
    [ACME.id]: true,
    [OWN.id]: true,
  };
  /** Each createImport the app made: where, the body, and its Idempotency-Key. */
  created: { organization: string; body: unknown; key: string | undefined }[] =
    [];
  /** Each applyImport the app made: where, which import, and its Idempotency-Key. */
  applied: { organization: string; id: string; key: string | undefined }[] = [];
  /** Each import whose check was read. */
  verified: string[] = [];
  /** The first move applied stops (failed, with `STOPPED`); applying it again goes on. */
  stopFirst = false;
  /** Organizations whose rules refuse a move in although the list says nothing (no canMoveIn). */
  refuseIn = new Set<string>();
  /** The moves being carried out: how many times each was read since it was applied. */
  private running = new Map<string, number>();

  constructor(active: string) {
    this.active = active;
  }

  organization(id: string) {
    return [ACME, OWN].find((one) => one.id === id);
  }

  move(organization: string, id: string): Import | undefined {
    return this.imports[organization]?.find((one) => one.id === id);
  }

  answer(request: Request): Answer {
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/v2/people/me/organizations")
      return {
        status: 200,
        json: ListOrganizationsResponse.parse({
          organizations: [
            {
              ...ACME,
              role: "member",
              personal: false,
              active: this.active === ACME.id,
              ...(this.canMoveIn[ACME.id] === undefined
                ? {}
                : { canMoveIn: this.canMoveIn[ACME.id] }),
            },
            {
              ...OWN,
              role: "owner",
              personal: true,
              active: this.active === OWN.id,
              ...(this.canMoveIn[OWN.id] === undefined
                ? {}
                : { canMoveIn: this.canMoveIn[OWN.id] }),
            },
          ],
          canCreate: true,
          nextCursor: null,
        }),
      };
    if (path === "/api/auth/organization/set-active" && method === "POST") {
      const { organizationId } = request.postDataJSON() as {
        organizationId: string;
      };
      this.switched.push(organizationId);
      this.active = organizationId;
      return { status: 200, json: { id: organizationId } };
    }
    const scoped = path.match(/^\/api\/v2\/organizations\/([^/]+)(\/.*)$/);
    if (!scoped) {
      this.unanswered.push(`${method} ${path}`);
      return { status: 404, json: NOT_FOUND };
    }
    const [, organization, rest] = scoped;
    // Before the app knows where the person works, it asks what OpenBot offers at `default`, with no
    // session (`credentials: "omit"`), and the server answers that to anybody.
    const offers = rest === "/deployment" && organization === "default";
    if (organization !== ACME.id && organization !== OWN.id && !offers) {
      this.unanswered.push(`${method} ${path}`);
      return { status: 404, json: NOT_FOUND };
    }
    if (rest === "/deployment")
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
          hostedSignIn: true,
        },
      };
    if (rest === "/imports" && method === "GET") {
      this.importsAsked.push(organization as string);
      return {
        status: 200,
        json: ListImportsResponse.parse({
          items: this.imports[organization as string] ?? [],
          nextCursor: null,
        }),
      };
    }
    if (rest === "/imports" && method === "POST")
      return this.createImport(organization as string, request);
    const one = rest?.match(/^\/imports\/([^/]+)(\/apply|\/verification)?$/);
    if (one) {
      const [, id, what] = one;
      const move = this.move(organization as string, id as string);
      if (!move)
        return {
          status: 404,
          json: {
            type: "https://open.bot/errors/import-not-found",
            title: "Import not found.",
            status: 404,
            detail: "That import isn't here. Start the move again.",
            code: "IMPORT_NOT_FOUND",
          },
        };
      if (what === "/apply" && method === "POST") {
        const key = request.headers()["idempotency-key"];
        this.applied.push({
          organization: organization as string,
          id: move.id,
          key,
        });
        if (!ApplyImportHeader.safeParse({ "Idempotency-Key": key }).success)
          return { status: 400, json: INVALID };
        if (move.status !== "imported") {
          move.status = "importing";
          delete move.error;
          this.running.set(move.id, 0);
        }
        return { status: 202, json: ApplyImportResponse.parse(move) };
      }
      if (what === "/verification" && method === "GET") {
        this.verified.push(move.id);
        if (move.status !== "imported")
          return {
            status: 409,
            json: {
              type: "https://open.bot/errors/import-not-finished",
              title: "The import hasn't finished.",
              status: 409,
              detail: "This move hasn't finished yet.",
              code: "IMPORT_NOT_FINISHED",
            },
          };
        return {
          status: 200,
          json: GetImportVerificationResponse.parse({
            importId: move.id,
            matches: true,
            kinds: [
              { kind: "bots", expected: 4, found: 4, leftOut: 0 },
              { kind: "conversations", expected: 37, found: 37, leftOut: 0 },
            ],
            notes: [],
            reconnect: [],
          }),
        };
      }
      if (!what && method === "GET") {
        this.carryOut(move);
        return { status: 200, json: GetImportResponse.parse(move) };
      }
    }
    if (rest === "/people/me" && method === "GET")
      return {
        status: 200,
        json: {
          person: personBody({
            id: "sam",
            name: "Sam Rivera",
            email: "sam@example.com",
            role: organization === OWN.id ? "owner" : "member",
            onboarding: { step: 1, completedAt: "2026-11-23T16:25:00.000Z" },
          }),
          openbotVersion: "v1.2.0",
        },
      };
    if (rest === "/people/me/preferences" && method === "GET")
      return { status: 200, json: this.preferences() };
    if (rest === "/people/me/preferences" && method === "PATCH") {
      const body = UpdatePreferencesBody.parse(request.postDataJSON());
      for (const notice of body.dismissedNotices ?? [])
        if (!this.dismissed.includes(notice)) this.dismissed.push(notice);
      return { status: 200, json: this.preferences() };
    }
    this.unanswered.push(`${method} ${path}`);
    return { status: 404, json: NOT_FOUND };
  }

  /** createImport with fromOrganizationId, by the spec: ready at once, nothing to upload. */
  createImport(organization: string, request: Request): Answer {
    const key = request.headers()["idempotency-key"];
    const body = request.postDataJSON() as unknown;
    this.created.push({ organization, body, key });
    if (!CreateImportHeader.safeParse({ "Idempotency-Key": key }).success)
      return { status: 400, json: INVALID };
    const input = CreateImportBody.safeParse(body);
    if (!input.success) return { status: 400, json: INVALID };
    if (
      this.canMoveIn[organization] === false ||
      this.refuseIn.has(organization)
    )
      return { status: 403, json: NOT_ALLOWED };
    const from = input.data.fromOrganizationId;
    const source = from ? this.organization(from) : undefined;
    if (!source || source.id === organization)
      return { status: 400, json: INVALID };
    const move: Import = {
      ...MOVE,
      id: `imp_across_${this.created.length}`,
      status: "ready",
      sourceName: input.data.sourceName ?? source.name,
      fromOrganizationId: source.id,
      createdAt: "2026-11-24T09:00:00Z",
      receivedParts: [],
    };
    delete move.finishedAt;
    this.imports[organization] = [move, ...(this.imports[organization] ?? [])];
    return { status: 201, json: CreateImportResponse.parse(move) };
  }

  /** A move applied finishes on the next read: imported, or the first one stops if `stopFirst`. */
  private carryOut(move: Import) {
    if (!this.running.has(move.id)) return;
    this.running.delete(move.id);
    if (this.stopFirst) {
      this.stopFirst = false;
      move.status = "failed";
      move.error = STOPPED;
      return;
    }
    move.status = "imported";
    move.finishedAt = "2026-11-24T09:01:30Z";
    move.expected = [{ kind: "bots", count: 4 }];
    move.imported = [{ kind: "bots", count: 4 }];
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

/**
 * OpenBot Desktop connected to OpenBot Cloud, as the page meets it (`__TAURI_INTERNALS__`), in the
 * organization the move went into.
 */
function desktopConnected() {
  const status = {
    openbotRunning: false,
    openbotHeld: false,
    processes: [],
    containers: [],
    intelligenceStack: null,
    intelligenceContainers: [],
    engine: null,
    root: null,
    appPort: null,
    version: "1.2.0",
    build: "Built 2026-11-23 from main",
    logFolder: "/Users/sam/Library/Logs/ai.copilotkit.openbot.desktop",
  };
  const answers: Record<string, unknown> = {
    connection: {
      mode: "connected",
      address: "https://api.open.bot",
      organizationId: "org_sam",
      moveToCloud: false,
    },
    status,
    update_offer: { version: null, current: "1.2.0", installing: null },
    usage_data: { shared: true, offByEnvironment: false },
    set_organization: null,
  };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string) => {
      const name = command.replace("plugin:openbot-desktop|", "");
      if (name in answers) return answers[name];
      throw `command ${command} not found`;
    },
  };
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
    entrypoints: [join(import.meta.dir, "moved-elsewhere.fixture.tsx")],
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

async function open(
  engine: string,
  theme: Theme,
  server: FakeServer,
  path: string,
  desktop = false,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: WINDOW,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  if (desktop) await page.addInitScript(desktopConnected);
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
      return route.fulfill({ status, json });
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

async function shoot(page: Page, step: string, engine: string, theme: Theme) {
  await style(page);
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(shots, `moved-elsewhere-${step}-${engine}-${theme}.png`),
  });
}

/** Sideways scroll, or a control past the window's edge. */
async function cutOff(page: Page) {
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

const BAR =
  "Your Bots from OpenBot on Sam's MacBook are in Sam's organization.";

describe.skipIf(!asked)("after a move, where the Bots are", () => {
  for (const engine of engines)
    for (const theme of THEMES) {
      test(`working in another organization, the bar names where the moved Bots are and Switch goes there, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer(ACME.id);
        const page = await open(engine, theme, server, "/");
        try {
          const bar = page.getByRole("complementary", {
            name: "Your moved Bots",
          });
          // Shot before anything is asserted, so a run against the earlier page keeps its picture.
          await page.getByRole("heading", { name: "Home" }).waitFor();
          await page.waitForTimeout(800);
          await shoot(page, "bar", engine, theme);
          await bar.getByText(BAR, { exact: true }).waitFor({ timeout: 5_000 });
          expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });
          await bar
            .getByRole("button", { name: "Switch to Sam's organization" })
            .click();
          await bar.waitFor({ state: "detached" });
          expect(server.switched).toEqual([OWN.id]);
          await shoot(page, "switched", engine, theme);
          // Working there now, whatever reloads: nothing more to say.
          await page.reload();
          await page.getByRole("heading", { name: "Home" }).waitFor();
          await page.waitForTimeout(500);
          expect(await bar.count()).toBe(0);
          expect(server.unanswered).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`Dismiss keeps the bar closed for that move, after a reload too, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer(ACME.id);
        const page = await open(engine, theme, server, "/");
        try {
          const bar = page.getByRole("complementary", {
            name: "Your moved Bots",
          });
          await bar.getByText(BAR, { exact: true }).waitFor();
          await bar.getByRole("button", { name: "Dismiss" }).click();
          await bar.waitFor({ state: "detached" });
          expect(server.dismissed).toEqual([movedElsewhereNoticeId(MOVE.id)]);
          await page.reload();
          await page.getByRole("heading", { name: "Home" }).waitFor();
          await page.waitForTimeout(500);
          expect(await bar.count()).toBe(0);
          // Still working in Acme: dismissing moves nothing.
          expect(server.switched).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`connected from OpenBot Desktop, Settings says the account and organization it is signed in as, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer(OWN.id);
        const page = await open(
          engine,
          theme,
          server,
          "/settings/computer",
          true,
        );
        try {
          await page
            .getByText("https://api.open.bot", { exact: true })
            .waitFor();
          // Shot before anything is asserted, so a run against the earlier page keeps its picture.
          await page.waitForTimeout(500);
          await shoot(page, "settings-connected", engine, theme);
          await page.getByText("Signed in as", { exact: true }).waitFor();
          await page
            .getByText("sam@example.com, in Sam's organization", {
              exact: true,
            })
            .waitFor();
          expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });
        } finally {
          await page.close();
        }
      }, 60_000);
    }

  test("working where the newest move is, nothing is said", async () => {
    const server = new FakeServer(OWN.id);
    const page = await open(engines[0] ?? "chromium", "light", server, "/");
    try {
      await page.getByRole("heading", { name: "Home" }).waitFor();
      await page.waitForTimeout(800);
      expect(
        await page
          .getByRole("complementary", { name: "Your moved Bots" })
          .count(),
      ).toBe(0);
      // Every organization is asked: a move here may since have moved on to another.
      expect([...new Set(server.importsAsked)].sort()).toEqual(
        [ACME.id, OWN.id].sort(),
      );
      expect(server.created).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe.skipIf(!asked)("moving the Bots to where the person works", () => {
  for (const engine of engines)
    for (const theme of THEMES) {
      test(`Move them to Acme moves the Bots across and the bar goes, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer(ACME.id);
        const page = await open(engine, theme, server, "/");
        try {
          const bar = page.getByRole("complementary", {
            name: "Your moved Bots",
          });
          await bar.getByText(BAR, { exact: true }).waitFor();
          await bar.getByRole("button", { name: "Move them to Acme" }).click();
          const moving = bar.getByRole("button", {
            name: "Moving them to Acme…",
          });
          await moving.waitFor();
          expect(await moving.isDisabled()).toBe(true);
          await shoot(page, "moving", engine, theme);
          await bar.waitFor({ state: "detached", timeout: 15_000 });
          // Asked once, in Acme, from Sam's organization, each write with its own key.
          expect(server.created).toHaveLength(1);
          expect(server.created[0]?.organization).toBe(ACME.id);
          expect(server.created[0]?.body).toEqual({
            fromOrganizationId: OWN.id,
          });
          expect(server.created[0]?.key).toBeTruthy();
          expect(server.applied.map((one) => one.organization)).toEqual([
            ACME.id,
          ]);
          expect(server.applied[0]?.key).toBeTruthy();
          expect(server.applied[0]?.key).not.toBe(server.created[0]?.key);
          expect(server.verified).toEqual([server.applied[0]?.id]);
          // Moved, not switched: the person is still in Acme.
          expect(server.switched).toEqual([]);
          await shoot(page, "moved", engine, theme);
          await page.reload();
          await page.getByRole("heading", { name: "Home" }).waitFor();
          await page.waitForTimeout(800);
          expect(await bar.count()).toBe(0);
          expect(server.unanswered).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`a move that stops says the server's sentence, and Try again goes on with it, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer(ACME.id);
        server.stopFirst = true;
        const page = await open(engine, theme, server, "/");
        try {
          const bar = page.getByRole("complementary", {
            name: "Your moved Bots",
          });
          await bar.getByRole("button", { name: "Move them to Acme" }).click();
          await bar.getByRole("alert").getByText(STOPPED).waitFor({
            timeout: 15_000,
          });
          await shoot(page, "stopped", engine, theme);
          expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });
          await bar.getByRole("button", { name: "Try again" }).click();
          await bar.waitFor({ state: "detached", timeout: 15_000 });
          // The same move, applied again: nothing started twice.
          expect(server.created).toHaveLength(1);
          expect(server.applied.map((one) => one.id)).toEqual([
            server.applied[0]?.id,
            server.applied[0]?.id,
          ]);
          expect(server.unanswered).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`where Acme doesn't let them use Bots, the bar says so in place of Move, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer(ACME.id);
        server.canMoveIn[ACME.id] = false;
        const page = await open(engine, theme, server, "/");
        try {
          const bar = page.getByRole("complementary", {
            name: "Your moved Bots",
          });
          await page.getByRole("heading", { name: "Home" }).waitFor();
          await page.waitForTimeout(800);
          await shoot(page, "not-allowed", engine, theme);
          await bar
            .getByText(
              "You can't move them to Acme. Ask an admin to let you use Bots there.",
              { exact: true },
            )
            .waitFor({ timeout: 5_000 });
          expect(
            await bar.getByRole("button", { name: /^Move them/ }).count(),
          ).toBe(0);
          await bar
            .getByRole("button", { name: "Switch to Sam's organization" })
            .waitFor();
          expect(await cutOff(page)).toEqual({ sideways: false, cut: [] });
          expect(server.created).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`in the organization the Bots left, the bar names the one they went to, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer(OWN.id);
        server.imports[ACME.id] = [{ ...MOVED_ACROSS }];
        const page = await open(engine, theme, server, "/");
        try {
          const bar = page.getByRole("complementary", {
            name: "Your moved Bots",
          });
          await page.getByRole("heading", { name: "Home" }).waitFor();
          await page.waitForTimeout(800);
          await shoot(page, "left", engine, theme);
          await bar
            .getByText("Your Bots from Sam's organization are in Acme.", {
              exact: true,
            })
            .waitFor({ timeout: 5_000 });
          await bar
            .getByRole("button", { name: "Move them to Sam's organization" })
            .waitFor();
          await bar.getByRole("button", { name: "Switch to Acme" }).click();
          await bar.waitFor({ state: "detached" });
          expect(server.switched).toEqual([ACME.id]);
        } finally {
          await page.close();
        }
      }, 60_000);
    }

  test("where the list says nothing and OpenBot Cloud refuses, its own sentence is shown and nothing moves", async () => {
    const server = new FakeServer(ACME.id);
    server.canMoveIn[ACME.id] = undefined;
    server.refuseIn.add(ACME.id);
    const page = await open(engines[0] ?? "chromium", "light", server, "/");
    try {
      const bar = page.getByRole("complementary", { name: "Your moved Bots" });
      await bar.getByRole("button", { name: "Move them to Acme" }).click();
      await bar.getByRole("alert").getByText(NOT_ALLOWED.detail).waitFor();
      await bar.getByRole("button", { name: "Try again" }).waitFor();
      expect(server.created).toHaveLength(1);
      expect(server.applied).toEqual([]);
      expect(server.imports[OWN.id]).toEqual([MOVE]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
