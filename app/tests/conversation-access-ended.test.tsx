import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import { personBody } from "./accounts-api";
import { botGrantsBody } from "./bot-grants-api";

/**
 * A person whose Bot was taken away mid-conversation is told so, in a real browser.
 *
 * Seen on a real server: Lena had a conversation open with a Bot shared with her team, and an admin
 * took her out of the team. Her next message was refused, rightly, and the conversation said
 * "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen
 * OpenBot." From then on the open conversation asked who had control of the Bot's computer every
 * second and was answered "not found" every time.
 *
 * The real conversation is drawn in the app's frame, bundled from the fixture beside this file,
 * with the app's stylesheet. The server's answers are routes at the API's and the runtime's
 * addresses. The page opens while the Bot is still hers; then the Bot is taken away, and she types
 * a message and sends it, with a real keyboard and a real click.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/conversation-access-ended.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each is saved as conversation-access-ended-<engine>-<theme>-<width>.png.
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
const BOT_PATH = `${ORGANIZATION}/bots/pipeline-bot`;
const CONTROL_PATH = `${ORGANIZATION}/computers/pipeline-bot/control`;

const SENTENCE =
  "This Bot isn't shared with you any more, so your message wasn't sent. Its owner or an admin can share it again.";

const BOT = {
  ...getGetBotResponseMock().bot,
  id: "pipeline-bot",
  name: "Pipeline Bot",
  mine: false,
  canManage: false,
  systemOwned: false,
  visibility: "private" as const,
};
const LENA = {
  id: "lena",
  name: "Lena Okafor",
  email: "lena.okafor@northwind.example",
};

/** The API's "not found" for a Bot that is not this person's, as api/openapi/bots.yaml gives it. */
const BOT_NOT_FOUND = {
  type: "https://open.bot/errors/bot-not-found",
  title: "Bot not found.",
  status: 404,
  detail: "Couldn't find that Bot.",
  code: "BOT_NOT_FOUND",
  category: "not_found",
  retryable: false,
};

/** One page's server: whether the Bot is still this person's, and what it was asked. */
type Server = { gone: boolean; asked: string[] };

/** What the server answers: a status and a body, or nothing for an address it does not have. */
function answer(
  path: string,
  server: Server,
): { status?: number; json?: unknown } | undefined {
  // The runtime, running through Intelligence: a run is a request for join credentials first.
  if (path === "/api/copilotkit/info")
    return {
      json: {
        version: "fixture",
        agents: {
          "pipeline-bot": { description: "Fixture", capabilities: {} },
        },
        mode: "intelligence",
        intelligence: { wsUrl: "ws://openbot.test/client" },
        telemetryDisabled: true,
      },
    };
  // Joining a thread with nothing to replay.
  if (path.endsWith("/connect")) return { status: 204 };
  // The runtime's own answer for a Bot that is not among the caller's.
  if (path.endsWith("/run"))
    return {
      status: 404,
      json: {
        error: "Agent not found",
        message: "Agent 'pipeline-bot' does not exist",
      },
    };
  if (path === BOT_PATH || path === CONTROL_PATH) {
    if (server.gone) return { status: 404, json: BOT_NOT_FOUND };
    return path === BOT_PATH
      ? { json: { bot: BOT } }
      : {
          json: {
            holder: "bot",
            since: "2026-11-15T09:00:00.000Z",
            requested: false,
          },
        };
  }
  if (path === `${ORGANIZATION}/bots`)
    return { json: { bots: server.gone ? [] : [BOT], nextCursor: null } };
  if (path === `${BOT_PATH}/grants`) return { json: botGrantsBody() };
  if (path === `${BOT_PATH}/components`)
    return { json: { components: [], nextCursor: null } };
  if (path === `${ORGANIZATION}/people/me/capabilities`)
    return { json: { capabilities: {}, enforced: false } };
  if (path === `${ORGANIZATION}/people/me`)
    return {
      json: {
        person: personBody({ ...LENA, role: "member" }),
        openbotVersion: "v1.0.3",
      },
    };
  if (path === `${ORGANIZATION}/deployment`)
    return {
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
  if (/\/conversations\/[^/]+\/(activity|signal-busy)$/.test(path))
    return { status: 204 };
  if (/\/conversations\/[^/]+\/voice-sessions$/.test(path))
    return { json: { sessions: [], nextCursor: null } };
  // What was said before, which stays readable.
  if (/\/threads\/[^/]+\/messages$/.test(path))
    return {
      json: {
        messages: [
          {
            id: "asked",
            role: "user",
            content: "What is 586 plus 637? Reply with the number only.",
          },
          { id: "answered", role: "assistant", content: "1223" },
        ],
      },
    };
  return undefined;
}

/** The fixture bundled for the browser. `@/lib/marks` is Vite's `import.meta.glob`, so no marks. */
async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "conversation-access-ended.fixture.tsx"),
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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

/** Styled for everything now on the page. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
}

/** The conversation open while the Bot is still this person's, and its server. */
async function open(
  engine: string,
  theme: "light" | "dark",
  window: { width: number; height: number },
): Promise<{ page: Page; server: Server }> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const server: Server = { gone: false, asked: [] };
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/conversation.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) {
      server.asked.push(path);
      const said = answer(path, server);
      if (!said)
        return route.fulfill({ status: 404, json: { detail: "Not found." } });
      return said.json === undefined
        ? route.fulfill({ status: said.status ?? 200 })
        : route.fulfill({ status: said.status ?? 200, json: said.json });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/conversation.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/channel/pipeline-conversation`);
  await page.getByText("1223").waitFor({ timeout: 15_000 });
  await style(page);
  await page.evaluate(() => document.fonts.ready);
  return { page, server };
}

describe.skipIf(!asked)("a Bot taken away in an open conversation", () => {
  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ])
        test(`says the Bot isn't shared any more and stops asking about its computer, in ${engine}, ${theme}, ${window.width}px`, async () => {
          const { page, server } = await open(engine, theme, window);
          try {
            // An admin takes her out of the team the Bot was shared with.
            server.gone = true;
            const box = page.getByRole("textbox", { name: "Message" });
            await box.click();
            await page.keyboard.type(
              "What is 110 plus 707? Reply with the number only.",
            );
            await page.getByRole("button", { name: "Send message" }).click();
            const stopped = page.getByTestId("transcript-stopped");
            await stopped.waitFor({ timeout: 15_000 });
            await style(page);
            // Long enough for three of the control read's seconds to have gone by.
            await page.waitForTimeout(3_300);
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `conversation-access-ended-${engine}-${theme}-${window.width}.png`,
                ),
              });
            }

            expect(await stopped.textContent()).toBe(SENTENCE);
            // What was said before is still there, and nothing sends her to retry or reopen.
            expect(await page.getByText("1223").count()).toBe(1);
            expect(await page.getByText(/quit and reopen/).count()).toBe(0);
            // The sentence is the app's own error style, inside the window.
            const drawn = await stopped.evaluate((line) => {
              const rect = line.getBoundingClientRect();
              return {
                inside: rect.left >= 0 && rect.right <= innerWidth,
                sideways: document.documentElement.scrollWidth > innerWidth,
              };
            });
            expect(drawn).toEqual({ inside: true, sideways: false });
            // Asked once after the Bot was gone, answered "not found", and not asked again.
            const refused = server.asked.indexOf(
              server.asked.find((path) => path.endsWith("/run")) ?? "",
            );
            const after = server.asked
              .slice(refused)
              .filter((path) => path === CONTROL_PATH);
            expect(after.length).toBeLessThanOrEqual(1);
          } finally {
            await page.close();
          }
        }, 90_000);
});
