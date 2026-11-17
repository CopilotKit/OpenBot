import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { ME_PATH } from "./accounts-api";
import { type AppsFixture, answerAppsApi, type TodayServer } from "./apps-api";
import {
  confirmationResponse,
  connectionPage,
  connectionsCall,
  startResponse,
} from "./connections-api";

/**
 * A sign-in through Composio is introduced by OpenBot before it leaves, and the screens on either
 * side of it stay long enough to read.
 *
 * Reported from OpenBot 1.1.0-rc.1: Connect on Gmail went straight to Composio's own Connect Link
 * page, which flashes by on its way to Google's, and Google's then asked to let "Composio" into the
 * person's Google Account (Slack: "Allow Composio to access Slack", and "App not approved by
 * Slack"). Nothing on the way said who Composio is. And the page OpenBot Desktop's sign-in comes
 * back to handed the person back to the window at once, so it too was gone before it could be read.
 *
 * So, in a real browser, Chromium and WebKit:
 *   - Connect on an app's page under Connections shows OpenBot's step, which names Composio, says
 *     what the next page will ask, and counts down from 5. At 0 it opens the consent page in this
 *     tab, exactly where it went before; Continue now goes at once; Cancel opens nothing.
 *   - A Bot's Connect card still opens the sign-in in a new tab on the click (the popup rule), and
 *     that tab shows the same step as a page, then goes on to the consent page by itself.
 *   - The page Desktop's sign-in comes back to says the app is connected and counts down from 5
 *     before it hands back to the window.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/consent-handoff.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> every screen is also saved in light and dark, as
 * consent-handoff-<engine>-<screen>-<theme>.png.
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
/** Where the consent pages live in this test: any address outside OpenBot will do. */
const CONSENT = "https://consent.test";
/** The countdown, as the step starts it. Kept here rather than imported so main can run this. */
const SECONDS = 5;

function gmail(id: string, title: string): TodayServer {
  return {
    authScheme: "OAUTH2",
    id,
    title,
    vendor: "",
    url: `composio://${id.replace(/^composio-/, "")}`,
    summary: "",
    docsUrl: "",
    provenance: "composio",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    accountMode: "personal",
    ownerGrants: "any",
    tools: [],
    withdrawn: [],
  };
}

const DEPLOYMENT: AppsFixture = {
  servers: [gmail("composio-gmail", "Gmail"), gmail("composio-slack", "Slack")],
  composioConfigured: true,
  provider: "composio",
  botsMayCallBack: true,
};

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "consent-handoff.fixture.tsx")],
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

/** Style what is on the page now, with the app's stylesheet for every class it uses. */
async function styled(page: Page): Promise<void> {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
}

/**
 * The page's script, built before any test starts, on the bundle's own clock rather than a hook's.
 */
let script: string;
if (asked) script = await bundle();
const browsers: Browser[] = [];

afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
});

/** The server, as it answers right before anybody has connected Gmail or Slack. */
async function serve(context: BrowserContext, theme: "light" | "dark") {
  const connects: string[] = [];
  await context.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/app.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname.startsWith("/api/")) {
      const init = {
        method: request.method(),
        body: request.postData() ?? undefined,
      };
      const answer = (response: Response) =>
        response.text().then((body) =>
          route.fulfill({
            status: response.status,
            contentType: "application/json",
            body,
          }),
        );
      if (url.pathname === ME_PATH)
        return route.fulfill({
          json: { user: { id: "u", role: "member", email: "u@x.io" } },
        });
      const call = connectionsCall(url.pathname, init);
      if (call?.operation === "connect") {
        connects.push(call.appId ?? "");
        return answer(
          startResponse({ authorizationUrl: `${CONSENT}/${call.appId}` }),
        );
      }
      if (call?.operation === "confirm")
        return answer(confirmationResponse(false));
      if (call?.operation === "list") return answer(connectionPage([]));
      const apps = answerAppsApi(url.toString(), init, DEPLOYMENT);
      if (apps) return answer(apps);
      return route.fulfill({ status: 404, json: { error: "not here" } });
    }
    if (url.pathname.includes("."))
      return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
    });
  });
  // The consent page itself: the provider's, outside OpenBot.
  await context.route(`${CONSENT}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Consent</title><p>The provider's consent page</p>",
    }),
  );
  return { connects };
}

async function launch(
  name: "chromium" | "webkit",
  theme: "light" | "dark" = "light",
  viewport = { width: 1280, height: 860 },
) {
  const playwright = await import("playwright-core");
  const engine = playwright[name];
  const browser =
    name === "chromium"
      ? // The CI job installs full Chromium without the headless shell.
        await engine.launch({ channel: "chromium" })
      : await engine.launch();
  browsers.push(browser);
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  const server = await serve(context, theme);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(error));
  return { browser, context, page, server };
}

/** An app's page under Connections, with its Connect on screen. */
async function accountPage(page: Page, app: string) {
  await page.goto(`${ORIGIN}/connections/${app}`, {
    waitUntil: "domcontentloaded",
  });
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  await connect.waitFor();
  await styled(page);
  return connect;
}

/** The step's countdown line, as a person reads it. */
async function countdown(page: Page): Promise<string> {
  return (
    (await page.getByTestId("consent-countdown").textContent()) ?? ""
  ).trim();
}

const MS = (seconds: number) => seconds * 1_000;

describe.skipIf(!asked)("a sign-in through Composio", () => {
  for (const name of engines) {
    test(`in ${name}: Connect shows OpenBot's step, counts down from 5, then opens the consent page by itself`, async () => {
      const { page, server } = await launch(name);
      const connect = await accountPage(page, "composio-gmail");
      await connect.click();

      const step = page.getByRole("dialog");
      await step.waitFor({ timeout: 5_000 });
      expect(
        await step.getByRole("heading", { name: "Connecting Gmail" }).count(),
      ).toBe(1);
      const text = (await step.textContent()) ?? "";
      expect(text).toContain(
        "OpenBot connects to your apps through Composio, the service that holds those connections for OpenBot.",
      );
      expect(text).toContain(
        "Next, Google will ask you to allow Composio to access your Google Account.",
      );
      expect(text).toContain(
        "You can disconnect Gmail any time in Connections.",
      );
      expect(await countdown(page)).toBe(`Taking you to Google in ${SECONDS}`);
      expect(server.connects).toEqual(["composio-gmail"]);

      // It stays to be read: two seconds on, it is still counting and nothing has left.
      await page.waitForTimeout(2_000);
      expect(page.url()).toBe(`${ORIGIN}/connections/composio-gmail`);
      expect(await countdown(page)).toMatch(/^Taking you to Google in [2-4]$/);

      // At 0 it goes on by itself, to exactly the address the server answered.
      await page.waitForURL(`${CONSENT}/composio-gmail`, {
        timeout: MS(SECONDS + 2),
      });
    }, 30_000);

    test(`in ${name}: Continue now opens the consent page at once, and Cancel opens nothing`, async () => {
      const { page } = await launch(name);
      const connect = await accountPage(page, "composio-slack");

      await connect.click();
      let step = page.getByRole("dialog");
      await step.waitFor({ timeout: 5_000 });
      // The dialog's own classes, which were not on the page when it was first styled.
      await styled(page);
      const text = (await step.textContent()) ?? "";
      expect(text).toContain(
        "Next, Slack will ask you to allow Composio to access your Slack workspace.",
      );
      expect(text).toContain(
        "Slack may also say “App not approved by Slack”. That's Slack's note about Composio's app, and it's expected.",
      );
      expect(await countdown(page)).toBe(`Taking you to Slack in ${SECONDS}`);
      await step.getByRole("button", { name: "Cancel" }).click();
      await step.waitFor({ state: "hidden", timeout: 3_000 });
      // Past where the countdown would have ended: still here, nothing opened.
      await page.waitForTimeout(MS(SECONDS + 1));
      expect(page.url()).toBe(`${ORIGIN}/connections/composio-slack`);

      await connect.click();
      step = page.getByRole("dialog");
      await step.waitFor({ timeout: 5_000 });
      await step.getByRole("button", { name: "Continue now" }).click();
      await page.waitForURL(`${CONSENT}/composio-slack`, { timeout: 2_000 });
    }, 40_000);

    test(`in ${name}: a Bot's Connect card opens the step in a new tab on the click, and that tab goes on to the consent page`, async () => {
      const { page, context } = await launch(name);
      await page.goto(`${ORIGIN}/card/composio-gmail`, {
        waitUntil: "domcontentloaded",
      });
      const connect = page.getByRole("button", { name: "Connect" });
      await connect.waitFor();

      const [tab] = await Promise.all([
        context.waitForEvent("page", { timeout: 5_000 }),
        connect.click(),
      ]);
      // The step, as a page of OpenBot's own, in the tab the click opened.
      await tab.waitForURL(/\/connecting#/, { timeout: 5_000 });
      const heading = tab.getByRole("heading", { name: "Connecting Gmail" });
      await heading.waitFor({ timeout: 5_000 });
      expect(await countdown(tab)).toBe(`Taking you to Google in ${SECONDS}`);
      expect((await page.getByText("Waiting for Gmail…").count()) > 0).toBe(
        true,
      );

      await tab.waitForTimeout(2_000);
      expect(tab.url()).toContain("/connecting#");

      await tab.waitForURL(`${CONSENT}/composio-gmail`, {
        timeout: MS(SECONDS + 2),
      });
    }, 30_000);

    test(`in ${name}: the page Desktop's sign-in comes back to says Gmail is connected and counts down before it hands back`, async () => {
      const { page } = await launch(name);
      await page.goto(
        `${ORIGIN}/desktop-return?app=composio-gmail&status=success&connected_account_id=ca_test`,
        { waitUntil: "domcontentloaded" },
      );
      await page
        .getByRole("heading", { name: "Gmail is connected" })
        .waitFor({ timeout: 5_000 });
      expect(
        await page.getByText("Bots that have Gmail can use it now.").count(),
      ).toBe(1);
      const line = page.getByTestId("return-countdown");
      expect(((await line.textContent()) ?? "").trim()).toBe(
        `Back to OpenBot in ${SECONDS}`,
      );
      await page.waitForTimeout(2_000);
      expect(((await line.textContent()) ?? "").trim()).toMatch(
        /^Back to OpenBot in [2-4]$/,
      );
      // At 0 it hands back to the window, and says the tab can be closed.
      await page
        .getByText("OpenBot opens on its own. You can close this tab.")
        .waitFor({ timeout: MS(SECONDS + 2) });
    }, 30_000);
  }
});

/*
 * THE SCREENS, SAVED FOR A PERSON TO LOOK AT, in light and dark. Only with OPENBOT_APP_SHOTS set:
 * nothing is asserted here that the cases above do not already.
 */
describe.skipIf(!asked || !shots)("the screens, for a look", () => {
  for (const name of engines) {
    for (const theme of ["light", "dark"] as const) {
      test(`in ${name}, ${theme}`, async () => {
        const dir = shots as string;
        mkdirSync(dir, { recursive: true });
        const file = (screen: string) =>
          join(dir, `consent-handoff-${name}-${screen}-${theme}.png`);

        for (const [app, title] of [
          ["composio-gmail", "Gmail"],
          ["composio-slack", "Slack"],
        ] as const) {
          // The app's page under Connections, then the step over it.
          const { page, context } = await launch(name, theme);
          const connect = await accountPage(page, app);
          await page.screenshot({ path: file(`${title}-page`) });
          await connect.click();
          await page.getByRole("dialog").waitFor();
          await styled(page);
          await page.waitForTimeout(1_200);
          await page.screenshot({ path: file(`${title}-dialog`) });
          await page.getByRole("button", { name: "Cancel" }).click();

          // The same step as the page a new tab shows.
          await page.goto(`${ORIGIN}/card/${app}`, {
            waitUntil: "domcontentloaded",
          });
          const card = page.getByRole("button", { name: "Connect" });
          await card.waitFor();
          const [tab] = await Promise.all([
            context.waitForEvent("page"),
            card.click(),
          ]);
          await tab
            .getByRole("heading", { name: `Connecting ${title}` })
            .waitFor();
          await styled(tab);
          await tab.waitForTimeout(1_200);
          await tab.screenshot({ path: file(`${title}-tab`) });
          await tab.setViewportSize({ width: 390, height: 844 });
          await tab.screenshot({ path: file(`${title}-tab-phone`) });
          await context.close();
        }

        // The page Desktop's sign-in comes back to.
        const { page } = await launch(name, theme);
        await page.goto(
          `${ORIGIN}/desktop-return?app=composio-gmail&status=success`,
          { waitUntil: "domcontentloaded" },
        );
        await page
          .getByRole("heading", { name: "Gmail is connected" })
          .waitFor();
        await styled(page);
        // The button eases its colours in once styled; let it land.
        await page.waitForTimeout(1_200);
        await page.screenshot({ path: file("Gmail-return") });
      }, 120_000);
    }
  }
});
