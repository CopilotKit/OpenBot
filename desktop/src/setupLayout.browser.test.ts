import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * The AI step's form holds still while the install behind it comes and goes.
 *
 * Seen on Windows: on "Connect your AI", the back end's download card appeared above the endpoint
 * form while the person typed in it, and went when the download ended. Base URL and Model jumped
 * about 100px each time, a click meant for a field landed on "Advanced compatible endpoint options",
 * and the window grew taller and moved to fit. The install's row now has one slot under the form,
 * its height held (`BehindSlot`).
 *
 * The real window (`main.tsx` and `styles.css`), bundled as the app is, in a real Chromium, because
 * where a field lands is the browser's layout to decide. Only the native side is scripted, as it
 * answers on a first run: install done, the account passed, the rest of OpenBot setting up behind
 * the step, its download arriving and ending.
 *
 *   OPENBOT_APP_BROWSER=1 bun test src/setupLayout.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

/*
 * Playwright comes from the root install, which the real-browser CI job has. The desktop's own
 * jobs install only the desktop's dependencies and typecheck this file, so it names the module
 * by a variable and types only the part of it used here.
 */
const PLAYWRIGHT: string = "playwright-core";
type Box = { x: number; y: number; width: number; height: number } | null;
type Locator = {
  click(): Promise<void>;
  waitFor(options?: { state?: "hidden" | "visible" }): Promise<void>;
  boundingBox(): Promise<Box>;
  textContent(): Promise<string | null>;
  count(): Promise<number>;
};
type Route = {
  request(): { url(): string };
  fulfill(response: {
    status?: number;
    contentType?: string;
    body: string;
  }): Promise<void>;
};
type Page = {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  goto(url: string): Promise<unknown>;
  getByRole(role: string, options?: { name: string; exact?: boolean }): Locator;
  locator(selector: string, options?: { hasText?: string }): Locator;
  getByText(text: string, options?: { exact?: boolean }): Locator;
  getByLabel(text: string, options: { exact: boolean }): Locator;
  evaluate<T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
};
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
  }): Promise<Page>;
  close(): Promise<void>;
};
type Chromium = { launch(options: { channel: string }): Promise<Browser> };

/**
 * `@tauri-apps/api/core`, scripted. The page's `__fake.download` is what the download poll answers,
 * and `__fake.emit` sends setup progress as the native side does. `#start` is a relaunch whose
 * Start updates OpenBot; otherwise it is a first run.
 */
const FAKE_CORE = `
const fake = (globalThis.__fake ??= { listeners: {}, download: null });
const emit = (name, payload) => {
  for (const listener of fake.listeners[name] ?? []) listener({ payload });
};
fake.emit = emit;
const relaunch = location.hash === "#start";
const signingIn = location.hash === "#signin";
const licence = location.hash === "#licence";
let finishSetUp;
const setUp = new Promise((resolve) => (finishSetUp = resolve));
const stack = {
  id: "local-abc123",
  installedRelease: "0.16.0-rc.10",
  step: "ready",
  urls: { api: "http://127.0.0.1:64770", dashboard: "http://127.0.0.1:64771", gateway: "ws://127.0.0.1:64772" },
  hasFailedStep: false,
  updateInProgress: false,
  unfinishedUpdate: null,
  observed: null,
};
const status = (readiness, licence) => ({
  outcome: "completed", stack, reason: null, readiness, licence, licenceExpiresAt: null, checksPassed: false,
});
fake.finishSetUp = () => finishSetUp(status("starting", "valid"));
const none = { openai: false, anthropic: false };
export function convertFileSrc(path) { return path; }
fake.calls = [];
export async function invoke(command) {
  fake.calls.push(command);
  switch (command) {
    case "windows_restart_pending":
    case "take_ai_connection_change":
    case "already_running":
      return false;
    case "default_root":
      return "/Users/you/OpenBot";
    case "already_configured":
      return relaunch
        ? {
            values: {},
            saved: { modelApiKeys: { openai: true, anthropic: false }, modelSessions: none, model: "open-ai-api-key" },
            launch: { harness: { id: "langgraph" } },
            localEval: { stack: "local-abc123", ownership: "created", phase: "installed", connected: true },
          }
        : { values: {}, saved: { modelApiKeys: none, modelSessions: none } };
    case "upgrade_due":
      return relaunch ? { from: "1.0.0", to: "1.0.1" } : null;
    case "upgrade_and_start":
      return new Promise(() => {});
    case "providers":
      return [
        { id: "openai", name: "OpenAI", summary: "Use OpenAI.", logins: ["api-key"], mark: null, caution: null },
        { id: "openai-compatible", name: "Any OpenAI-compatible endpoint", summary: "Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.", logins: ["endpoint"], mark: null, caution: null },
      ];
    case "prepare_installation":
      emit("setup:progress", { step: "engine", ok: true, running: false, detail: "The software OpenBot runs on is ready." });
      return new Promise((resolve) => setTimeout(() => resolve(null), 50));
    case "sign_in_to_copilotkit":
      return signingIn ? new Promise(() => {}) : { signedIn: true };
    case "copilotkit_sign_in_page":
      return signingIn
        ? { url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345", userCode: "WXYZ-2345" }
        : null;
    case "local_eval_terms":
      return { status: "required", accepted: !licence, version: "developer-edition-2026-10-01-web", url: "https://copilotkit.ai/legal/developer-edition", organizationName: "Acme" };
    case "set_up_local_eval":
      return setUp;
    case "local_eval_download":
      return fake.download;
    case "connect_local_eval":
      return { outcome: "completed", stack, reason: null, conflicted: false };
    case "run_local_eval":
      return status("ready", "valid");
    default:
      return null;
  }
}
`;

/** `@tauri-apps/api/event`, scripted: `FAKE_CORE` emits through the same listeners. */
const FAKE_EVENT = `
const fake = (globalThis.__fake ??= { listeners: {}, download: null });
export async function listen(name, listener) {
  (fake.listeners[name] ??= new Set()).add(listener);
  return () => fake.listeners[name].delete(listener);
}
`;

type Window = { script: string; style: string };

/** The window as the app builds it, with the native side scripted and the marks left out. */
async function buildWindow(): Promise<Window> {
  const built = await Bun.build({
    entrypoints: [new URL("./main.tsx", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "scripted-native-side",
        setup(build) {
          build.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({
            path: "event",
            namespace: "scripted",
          }));
          build.onResolve({ filter: /^@tauri-apps\/api\// }, () => ({
            path: "core",
            namespace: "scripted",
          }));
          // Brand marks come from Vite's glob import, which this build has not got.
          build.onResolve({ filter: /^\.\/Mark$/ }, () => ({
            path: "mark",
            namespace: "scripted",
          }));
          build.onLoad({ filter: /.*/, namespace: "scripted" }, (args) => ({
            contents:
              args.path === "event"
                ? FAKE_EVENT
                : args.path === "mark"
                  ? "export const Mark = () => null; export const ButtonMark = () => null;"
                  : FAKE_CORE,
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "build failed");
  const script = await built.outputs
    .find((out) => out.kind === "entry-point")
    ?.text();
  const style = await built.outputs
    .find((out) => out.path.endsWith(".css"))
    ?.text();
  if (!script) throw new Error("the build has no entry point");
  return { script, style: style ?? "" };
}

/** Served as the shell serves the window: its page, its script and its stylesheet. */
async function open(page: Page, hash = "") {
  await page.route("https://openbot.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/main.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: built.script,
      });
    if (path === "/main.css")
      return route.fulfill({ contentType: "text/css", body: built.style });
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      });
    return route.fulfill({ status: 404, body: "" });
  });
  // A secure origin, as the shell's own is: the window's calls are named with `crypto.randomUUID`.
  await page.goto(`https://openbot.test/${hash}`);
}

let browser: Browser;
let built: Window;

beforeAll(async () => {
  if (!asked) return;
  built = await buildWindow();
  const { chromium } = (await import(PLAYWRIGHT)) as { chromium: Chromium };
  // The CI job installs full Chromium without the headless shell.
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

/** Where the form's first field is, and how tall the page is: what the window is sized to. */
async function measure(page: Page) {
  const field = await page
    .getByLabel("Base URL", { exact: true })
    .boundingBox();
  const advanced = await page
    .getByText("Advanced compatible endpoint options")
    .boundingBox();
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  return { field: field?.y, advanced: advanced?.y, height };
}

/*
 * Seen on Windows F: the window opened at 1016x839, grew to 853 when the sign-in card appeared,
 * then jumped 54 px up and to 992 tall on "Connect your AI". The window keeps its size and place
 * now: the page is never taller than it, the window is never asked to grow, and a step taller than
 * the room it has scrolls inside its card.
 */
describe.skipIf(!asked)("the window through a first run", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the page never outgrows the window and a tall step scrolls in its card`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        const fits = () =>
          page.evaluate(() => ({
            page: document.documentElement.scrollHeight,
            window: window.innerHeight,
            asked: (
              globalThis as unknown as { __fake: { calls: string[] } }
            ).__fake.calls.filter((call) => call === "fit_setup_window").length,
          }));
        const check = async () => {
          const now = await fits();
          expect(now.page).toBeLessThanOrEqual(now.window);
          expect(now.asked).toBe(0);
        };
        await check();
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
        await page.waitForTimeout(600);
        await check();
        await page.getByText("Any OpenAI-compatible endpoint").click();
        await page.getByLabel("Base URL", { exact: true }).waitFor();
        await page.waitForTimeout(600);
        await check();
        // Taller than the room it has at the smaller size: its card scrolls, the page does not.
        const card = await page.evaluate(() => {
          const sheet = document.querySelector("main > .sheet") as HTMLElement;
          return { scroll: sheet.scrollHeight, client: sheet.clientHeight };
        });
        if (height < 600) expect(card.scroll).toBeGreaterThan(card.client);
        expect(card.client).toBeLessThanOrEqual(height);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/*
 * Seen on Windows F (a 1016x839 window): "Connect your AI" was taller than the window and scrolled
 * in its card, and the "Installing OpenBot in the background" row sat below the fold at y 822-839,
 * seen only by scrolling. It is pinned to the bottom of the card's visible area now, and Continue
 * still scrolls into view above it.
 */
/*
 * Seen on Windows F (a 1016x839 window): "Connect your AI" was taller than the window and scrolled
 * in its card. First the "Installing OpenBot in the background" row sat below the fold; then, with
 * only that row pinned, Continue sat under it with a grey sliver showing until the person
 * scrolled. A step's foot is pinned now: its action and the background row, both in view, with the
 * step scrolling above them.
 */
describe.skipIf(!asked)("a setup step's foot", () => {
  for (const [width, height] of [
    [1016, 839],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, its action and the background row are in view and uncovered on Account, Licence and AI`, async () => {
      const inView = async (_page: Page, box: Box, what: string) => {
        expect({ what, found: box !== null }).toEqual({ what, found: true });
        expect({ what, top: (box?.y ?? -1) >= 0 }).toEqual({ what, top: true });
        expect({
          what,
          bottom: (box?.y ?? 0) + (box?.height ?? 0) <= height,
        }).toEqual({ what, bottom: true });
      };
      const background = async (page: Page) =>
        inView(
          page,
          await page
            .getByRole("listitem", {
              name: "Installing OpenBot in the background",
            })
            .boundingBox(),
          "the background row",
        );
      /** The button is in view, and what is at its middle is the button: nothing covers it. */
      const pressable = async (page: Page, name: string) => {
        const button = page.getByRole("button", { name, exact: true });
        await inView(page, await button.boundingBox(), name);
        const covered = await page.evaluate((label) => {
          const found = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === label,
          );
          if (!found) return "missing";
          const box = found.getBoundingClientRect();
          const top = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return top && (top === found || found.contains(top))
            ? null
            : (top?.textContent ?? "nothing").slice(0, 60);
        }, name);
        expect({ name, coveredBy: covered }).toEqual({ name, coveredBy: null });
      };
      const account = await browser.newPage({ viewport: { width, height } });
      try {
        await open(account, "#signin");
        await account
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await account
          .getByRole("heading", { name: "Self-Contained OpenBot" })
          .waitFor();
        await account.waitForTimeout(600);
        await background(account);
      } finally {
        await account.close();
      }
      const licence = await browser.newPage({ viewport: { width, height } });
      try {
        await open(licence, "#licence");
        await licence
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await licence
          .getByRole("heading", { name: "Accept the license agreement" })
          .waitFor();
        await licence.waitForTimeout(600);
        await pressable(licence, "Accept");
        await background(licence);
      } finally {
        await licence.close();
      }
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
        await page.waitForTimeout(600);
        // Before a choice, and after it, with its form open and the step scrolling above.
        await pressable(page, "Continue");
        await background(page);
        await page.getByText("Any OpenAI-compatible endpoint").click();
        await page.getByLabel("Base URL", { exact: true }).waitFor();
        await page.waitForTimeout(600);
        await pressable(page, "Continue");
        await background(page);
      } finally {
        await page.close();
      }
    }, 40_000);
  }
});

describe.skipIf(!asked)("the AI step while OpenBot installs behind it", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the form does not move and the page does not grow as the download comes and goes`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
        await page.getByText("Any OpenAI-compatible endpoint").click();
        await page.getByLabel("Base URL", { exact: true }).waitFor();
        // The entrance animation settles before anything is measured.
        await page.waitForTimeout(600);
        const before = await measure(page);
        expect(before.field).toBeGreaterThan(0);

        // The rest of OpenBot starts downloading, while the person types in the form.
        await page.evaluate(() => {
          (
            globalThis as unknown as { __fake: { download: unknown } }
          ).__fake.download = { done: 400_000_000, total: 1_600_000_000 };
        });
        await page.getByText("400.0 MB of 1.6 GB").waitFor();
        expect(await measure(page)).toEqual(before);

        // The download ends.
        await page.evaluate(() => {
          (
            globalThis as unknown as { __fake: { download: unknown } }
          ).__fake.download = null;
        });
        await page.getByText("400.0 MB of 1.6 GB").waitFor({ state: "hidden" });
        expect(await measure(page)).toEqual(before);

        // Everything is installed, and the row says so.
        await page.evaluate(() =>
          (
            globalThis as unknown as { __fake: { finishSetUp: () => void } }
          ).__fake.finishSetUp(),
        );
        await page.getByText("OpenBot is installed").waitFor();
        expect(await measure(page)).toEqual(before);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/** Where the step's heading and its first row are: what a person is reading. */
async function anchors(page: Page) {
  const heading = await page
    .getByRole("heading", { name: "Starting OpenBot" })
    .boundingBox();
  const first = await page
    .getByRole("listitem", { name: "Setting up OpenBot" })
    .boundingBox();
  return { heading: heading?.y, first: first?.y };
}

/*
 * Seen on Windows: Start's card re-centred as rows came and went while OpenBot updated, so the
 * heading and the rows jumped up 31px when the update's row appeared, up 20px when its download
 * bar did, and down 20px when the bar went. The card is held from the top now, and the update is
 * the Start journey's: its download's measure sits on the journey's time line, so neither the
 * heading nor the rows move as it comes and goes.
 */
describe.skipIf(!asked)("the Start screen while OpenBot updates", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, nothing on screen moves as the update and its download come and go`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page, "#start");
        await page.getByRole("listitem", { name: "Opening OpenBot" }).waitFor();
        await page.waitForTimeout(600);
        const before = await anchors(page);
        expect(before.heading).toBeGreaterThan(0);
        const said = page.locator(".journey-said");
        const time = page.locator(".journey-time");

        const emit = (payload: Record<string, unknown>) =>
          page.evaluate(
            (sent) =>
              (
                globalThis as unknown as {
                  __fake: { emit: (name: string, payload: unknown) => void };
                }
              ).__fake.emit("setup:progress", sent),
            payload,
          );
        // The update begins: the journey says so.
        await emit({
          step: "release",
          ok: true,
          running: true,
          detail: "Downloading the update.",
        });
        await page
          .locator(".journey-said", { hasText: "Downloading the update" })
          .waitFor();
        expect(await anchors(page)).toEqual(before);
        const lines = await time.boundingBox();
        // Its download, measured on the journey's time line, and one bar on the screen.
        await emit({
          step: "images",
          ok: true,
          running: true,
          detail: "Downloading local software.",
          downloads: {
            done: 1,
            total: 5,
            bytes: 100_000_000,
            size: 944_200_000,
          },
        });
        await page
          .getByText("100.0 MB of 944.2 MB", { exact: false })
          .waitFor();
        expect(await anchors(page)).toEqual(before);
        expect((await time.boundingBox())?.height).toBe(lines?.height);
        expect(await page.getByRole("progressbar").count()).toBe(1);
        // The download ends, and its measure goes.
        await emit({
          step: "images",
          ok: true,
          running: false,
          detail: "Local software is downloaded (5/5).",
        });
        await page
          .getByText("100.0 MB of 944.2 MB", { exact: false })
          .waitFor({ state: "hidden" });
        expect(await anchors(page)).toEqual(before);
        // Its download done, the update is on to installing what it downloaded.
        expect(await said.textContent()).toBe("Installing the update");
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
