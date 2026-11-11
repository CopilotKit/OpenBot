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
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByLabel(text: string, options: { exact: boolean }): Locator;
  evaluate<T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  mouse: {
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  close(): Promise<void>;
};
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
  }): Promise<Page>;
  close(): Promise<void>;
};
type Chromium = {
  launch(options: {
    channel: string;
    ignoreDefaultArgs?: string[];
  }): Promise<Browser>;
};

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
const installing = location.hash === "#licence-installing";
const pausing = location.hash === "#pause-podman";
// Signed in already, the CLI taking two seconds to say so, as on Windows G.
const slowCheck = location.hash === "#licence-slow";
const licence = location.hash === "#licence" || installing || slowCheck;
let finishInstall;
const installed = new Promise((resolve) => (finishInstall = resolve));
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
fake.finishInstall = () => finishInstall(null);
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
      // As provider::catalogue lists them.
      return [
        { id: "openai", name: "OpenAI", summary: "Sign in with ChatGPT Plus, Pro, Team or Enterprise.", logins: ["plan", "api-key"], mark: "openai", caution: null },
        { id: "anthropic", name: "Anthropic", summary: "Sign in with a Claude Pro, Max, Team or Enterprise plan.", logins: ["plan", "api-key"], mark: "anthropic", caution: null },
        { id: "google", name: "Google Gemini", summary: "Use a Google AI Studio key or sign in for Gemini API access.", logins: ["endpoint", "oauth"], mark: "google-color", caution: null },
        { id: "xai", name: "xAI", summary: "Use an xAI API key or sign in to your xAI account.", logins: ["endpoint", "oauth"], mark: "xai", caution: null },
        { id: "unbiased", name: "Unbiased AI", summary: "Sign in with Unbiased AI to use Pareto, or use an API key.", logins: ["oauth", "endpoint"], mark: "unbiased", caution: null },
        { id: "openai-compatible", name: "Any OpenAI-compatible endpoint", summary: "Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.", logins: ["endpoint"], mark: null, caution: null },
      ];
    case "prepare_installation":
      if (pausing) {
        // A Mac whose own Podman OpenBot can't use: Install waits for the person's yes.
        emit("setup:progress", { step: "pause-podman", ok: true, running: true, asks: true, detail: "Your Podman is set up in a way OpenBot can't use. OpenBot will use its own, and pause yours while OpenBot is running. Yours starts again when you quit OpenBot." });
        return new Promise(() => {});
      }
      emit("setup:progress", { step: "engine", ok: true, running: false, detail: "The software OpenBot runs on is ready." });
      return installing ? installed : new Promise((resolve) => setTimeout(() => resolve(null), 50));
    case "sign_in_to_copilotkit":
      if (slowCheck) return new Promise((resolve) => setTimeout(() => resolve({ signedIn: true }), 1500));
      return signingIn ? new Promise(() => {}) : { signedIn: true };
    case "copilotkit_sign_in_page":
      return signingIn
        ? { url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345", userCode: "WXYZ-2345" }
        : null;
    case "allow_pause_podman":
      return true;
    case "local_eval_terms":
      if (pausing) return { status: "engine-not-ready" };
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
let chromium: Chromium;

beforeAll(async () => {
  if (!asked) return;
  built = await buildWindow();
  ({ chromium } = (await import(PLAYWRIGHT)) as { chromium: Chromium });
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
/**
 * The longest lines the background row is given, as the native side says them, and whether each
 * sends the person to another window. Kept in step with `docker_desktop_update.rs`,
 * `docker_desktop.rs`, `install.rs` and `engine.rs`.
 */
const LONGEST_ROW_LINES: [string, boolean][] = [
  [
    "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it. Windows will ask for your approval.",
    true,
  ],
  [
    "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it. Your Mac will ask for your password.",
    true,
  ],
  [
    "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it. About 25 minutes left.",
    false,
  ],
  [
    "The Podman on this computer is too old for OpenBot, so OpenBot is updating it. Your Mac will ask for your password.",
    true,
  ],
  [
    "Docker Desktop is starting in its own window. If it asks you to accept its terms or sign in, do that there. OpenBot comes back when Docker is ready.",
    true,
  ],
  [
    "Docker Desktop hasn't started yet. It may be waiting for you in its own window. Accept its terms or sign in there, and OpenBot carries on by itself.",
    true,
  ],
  [
    "Preparing this computer to run OpenBot. If a window asks to install a Windows feature OpenBot needs, allow it. Windows then asks for your approval and a restart.",
    true,
  ],
];

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
          .getByRole("heading", { name: "Self-contained OpenBot" })
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

/*
 * Seen on Windows F: on "Connect your AI", Continue moved up 14 px and back down with no input. It
 * shares the pinned foot with the background row, which was 118 px as a plain line and 132 px with
 * a download's bar and bytes. The row has one height now, so the action above it never moves.
 */
describe.skipIf(!asked)(
  "the foot holds still as the background row changes",
  () => {
    for (const [width, height] of [
      [1016, 839],
      [720, 560],
    ] as const) {
      test(`at ${width}x${height}, Accept and Continue never move through every state of the row`, async () => {
        const top = async (page: Page, name: string) =>
          (await page.getByRole("button", { name, exact: true }).boundingBox())
            ?.y;
        const emit = (page: Page, payload: Record<string, unknown>) =>
          page.evaluate(
            (sent) =>
              (
                globalThis as unknown as {
                  __fake: { emit: (name: string, payload: unknown) => void };
                }
              ).__fake.emit("setup:progress", sent),
            payload,
          );
        /*
         * Minutes into the install, as on F ("Step 3 of 4 · 3m 26s elapsed"): the wider badge is
         * what pushed the row's name onto a second line there, and the row from 118 px to 132.
         */
        const minutesIn = (page: Page) =>
          page.evaluate(() => {
            const real = Date.now;
            Date.now = () => real() + 10 * 60 * 1000;
            // Wider type than this browser sets: on Windows F the row's name or its line took a
            // second line, and the row grew 14 px. A little letter spacing does the same here.
            const wider = document.createElement("style");
            wider.textContent = ".behind-slot { letter-spacing: 0.12em; }";
            document.head.append(wider);
          });
        const licence = await browser.newPage({ viewport: { width, height } });
        try {
          await open(licence, "#licence-installing");
          await licence
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await licence
            .getByRole("heading", { name: "Accept the license agreement" })
            .waitFor();
          await minutesIn(licence);
          await licence.waitForTimeout(1200);
          const seen: (number | undefined)[] = [];
          // The longest lines that reach this row, each read whole: an engine update with its
          // prompt (on Windows G they were cut at "...so OpenBo…"), and Docker Desktop's own window
          // ("...when Docker is…"). Each in full, and the step's button where it was.
          for (const [detail, elsewhere] of LONGEST_ROW_LINES) {
            await emit(licence, {
              step: "engine",
              ok: true,
              running: true,
              elsewhere,
              detail,
            });
            const row = licence.locator(".behind-slot .step .detail", {
              hasText: detail,
            });
            await row.waitFor();
            expect({
              detail,
              cut: await licence.evaluate(() => {
                const shown = document.querySelector(
                  ".behind-slot .step .detail",
                ) as HTMLElement;
                return shown.scrollHeight > shown.clientHeight + 1;
              }),
            }).toEqual({ detail, cut: false });
            seen.push(await top(licence, "Accept"));
          }
          // A plain line.
          await emit(licence, {
            step: "images",
            ok: true,
            running: true,
            detail: "Checking what OpenBot needs to download.",
          });
          await licence
            .getByText("Checking what OpenBot needs to download.")
            .waitFor();
          seen.push(await top(licence, "Accept"));
          // Downloading, with its bar and bytes.
          await emit(licence, {
            step: "images",
            ok: true,
            running: true,
            detail: "Downloading OpenBot.",
            downloads: {
              done: 1,
              total: 5,
              bytes: 300_000_000,
              size: 1_100_000_000,
              bytesPerSecond: 9_000_000,
            },
          });
          await licence
            .getByText("300.0 MB of 1.1 GB", { exact: false })
            .waitFor();
          seen.push(await top(licence, "Accept"));
          // Unpacking.
          await emit(licence, {
            step: "images",
            ok: true,
            running: true,
            detail: "Downloading OpenBot.",
            downloads: {
              done: 3,
              total: 5,
              bytes: 1_100_000_000,
              size: 1_100_000_000,
            },
          });
          await licence.getByText(/Unpacking OpenBot/).waitFor();
          seen.push(await top(licence, "Accept"));
          // Installed, and the rest waiting for the person.
          await licence.evaluate(() =>
            (
              globalThis as unknown as { __fake: { finishInstall: () => void } }
            ).__fake.finishInstall(),
          );
          await licence.getByText(/Waiting for you/).waitFor();
          seen.push(await top(licence, "Accept"));
          expect(seen.every((y) => y !== undefined && y === seen[0])).toBe(
            true,
          );
        } finally {
          await licence.close();
        }

        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await open(page);
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Connect your AI" })
            .waitFor();
          await minutesIn(page);
          await page.waitForTimeout(1200);
          const seen: (number | undefined)[] = [];
          // A plain line: setting up, with nothing downloading.
          await page.getByText(/Setting up OpenBot on this computer/).waitFor();
          seen.push(await top(page, "Continue"));
          // Downloading the rest, with its bar and bytes.
          await page.evaluate(() => {
            (
              globalThis as unknown as { __fake: { download: unknown } }
            ).__fake.download = { done: 400_000_000, total: 1_600_000_000 };
          });
          await page.getByText("400.0 MB of 1.6 GB").waitFor();
          seen.push(await top(page, "Continue"));
          // Installed.
          await page.evaluate(() =>
            (
              globalThis as unknown as { __fake: { finishSetUp: () => void } }
            ).__fake.finishSetUp(),
          );
          await page.getByText("OpenBot is installed").waitFor();
          seen.push(await top(page, "Continue"));
          expect(seen.every((y) => y !== undefined && y === seen[0])).toBe(
            true,
          );
        } finally {
          await page.close();
        }
      }, 40_000);
    }
  },
);

/*
 * Seen on the Account step while the person signs in: its Cancel sits above the foot, the foot's
 * own actions row is empty, and the background row sat flush against Cancel with no gap at all. The
 * row sits the card's one gap (24px) under the step's button on every step, Cancel included.
 */
describe.skipIf(!asked)("the background row under the step's button", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, is one card gap below Cancel, Accept and Continue`, async () => {
      /** The gap from the button's bottom to the background row's top, the card scrolled to its end. */
      const gap = async (page: Page, name: string) => {
        await page.waitForTimeout(600);
        return page.evaluate((label) => {
          const sheet = document.querySelector("main > .sheet") as HTMLElement;
          sheet.scrollTop = sheet.scrollHeight;
          const button = [...document.querySelectorAll("button")].find(
            (found) => found.textContent?.trim() === label,
          );
          const row = document.querySelector(".behind-slot > .steps");
          if (!button || !row) return null;
          return Math.round(
            row.getBoundingClientRect().top -
              button.getBoundingClientRect().bottom,
          );
        }, name);
      };
      const scenes: Array<[string, string, string]> = [
        ["#signin", "Self-contained OpenBot", "Cancel"],
        ["#licence", "Accept the license agreement", "Accept"],
        ["", "Connect your AI", "Continue"],
      ];
      for (const [hash, heading, button] of scenes) {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await open(page, hash);
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page.getByRole("heading", { name: heading }).waitFor();
          expect({ button, gap: await gap(page, button) }).toEqual({
            button,
            gap: 24,
          });
        } finally {
          await page.close();
        }
      }
    }, 40_000);
  }
});

/*
 * Seen on Windows F: on the first screen the download line shrank about 40px when the download
 * finished ("Downloading OpenBot." with its bar and bytes, then "OpenBot is downloaded and ready to
 * install."), and the usage-data text under it moved up. The line holds its tallest height in every
 * state, and before it says anything.
 */
describe.skipIf(!asked)("the first screen while its downloads run", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the text under the download line stays where it is`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
        await page.waitForTimeout(400);
        const usage = async () =>
          Math.round(
            (
              await page
                .getByText("OpenBot sends usage data", {
                  exact: false,
                })
                .boundingBox()
            )?.y ?? -1,
          );
        const say = async (payload: Record<string, unknown>) => {
          await page.evaluate((sent) => {
            (
              globalThis as unknown as {
                __fake: { emit: (name: string, payload: unknown) => void };
              }
            ).__fake.emit("setup:downloads", sent);
          }, payload);
          await page.waitForTimeout(300);
        };
        const GB = 1_000_000_000;
        const seen: Array<[string, number]> = [["nothing yet", await usage()]];
        for (const [state, payload] of [
          ["starting", { state: "downloading", bytes: 0 }],
          [
            "downloading",
            {
              state: "downloading",
              bytes: 0.15 * GB,
              size: 0.31 * GB,
              bytesPerSecond: 9_000_000,
            },
          ],
          ["done", { state: "done", bytes: 0.31 * GB, size: 0.31 * GB }],
          ["failed", { state: "failed", bytes: 0.2 * GB, size: 0.31 * GB }],
          [
            "short of disk",
            { state: "short", bytes: 0, free: 14.6 * GB, needed: 44.3 * GB },
          ],
        ] as const) {
          await say(payload);
          seen.push([state, await usage()]);
        }
        const first = seen[0]?.[1];
        expect(first).toBeGreaterThan(0);
        expect(seen.map(([state, y]) => [state, y - (first ?? 0)])).toEqual(
          seen.map(([state]) => [state, 0]),
        );
      } finally {
        await page.close();
      }
    }, 30_000);
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

/*
 * David's decision for 1.0.2: on a Mac whose own Podman OpenBot can't use, the account step says
 * OpenBot needs its own and offers to pause theirs, with one button. The card, its button and the
 * background row are all in the window at the setup window's sizes, without the page growing.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each size for a look.
 */
describe.skipIf(!asked)("the offer to pause the person's Podman", () => {
  for (const [width, height] of [
    [1016, 839],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the offer and its button are in the window`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page, "#pause-podman");
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Setting up this computer" })
          .waitFor();
        const card = page.getByRole("region", {
          name: "OpenBot needs its own Podman",
        });
        await card.waitFor();
        await page.waitForTimeout(400);
        const button = page.getByRole("button", { name: "Pause my Podman" });
        const box = await button.boundingBox();
        const behind = page.getByRole("listitem", {
          name: "Installing OpenBot in the background",
        });
        const foot = await page.locator(".step-footer").boundingBox();
        expect(box).not.toBeNull();
        expect(foot).not.toBeNull();
        if (box && foot) {
          // In the window, and not under the step's pinned foot: seen at 720x560, cut in half.
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(foot.y);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        expect(await behind.textContent()).toContain(
          "Waiting for you to pause your Podman.",
        );
        expect(
          await page.evaluate(() => ({
            page: document.documentElement.scrollHeight,
            window: window.innerHeight,
          })),
        ).toEqual({ page: height, window: height });
        const shots = process.env.OPENBOT_APP_SHOTS;
        if (shots)
          await page.screenshot({
            path: `${shots}/pause-podman-${width}x${height}.png`,
          });
        await button.click();
        expect(
          await page.evaluate(() =>
            (
              globalThis as unknown as { __fake: { calls: string[] } }
            ).__fake.calls.filter((call) => call === "allow_pause_podman"),
          ),
        ).toEqual(["allow_pause_podman"]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/** Goes from the first screen to "Connect your AI", as a first run does. */
async function toTheAiStep(page: Page) {
  await open(page);
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
  // The entrance animation settles before anything is measured.
  await page.waitForTimeout(600);
}

const PROVIDERS = [
  "OpenAI",
  "Anthropic",
  "Google Gemini",
  "xAI",
  "Unbiased AI",
  "Any OpenAI-compatible endpoint",
];

/*
 * Seen on Windows G (the default 1000x800 window): on "Connect your AI" the last providers sat under
 * the step's pinned foot, Continue and the background row, with a sliver of one tile's edge
 * showing, and nothing said the list went on. The list has no scroll of its own: the card is the
 * one scroll area, the list plainly goes on under the foot, and each provider scrolls into view.
 */
describe.skipIf(!asked)("Connect your AI with every provider", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, one scroll area, the list plainly goes on under the foot, and every provider scrolls into view`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await toTheAiStep(page);
        const look = () =>
          page.evaluate(() => {
            const sheet = document.querySelector(
              "main > .sheet",
            ) as HTMLElement;
            const foot = sheet.querySelector(".step-footer") as HTMLElement;
            const top = sheet.getBoundingClientRect().top;
            const footTop = foot.getBoundingClientRect().top;
            const scrolling = [...document.querySelectorAll("*")]
              .filter((element) => {
                const { overflowY } = getComputedStyle(element);
                return (
                  /auto|scroll/.test(overflowY) &&
                  element.scrollHeight > element.clientHeight + 1
                );
              })
              .map((element) => element.className);
            const fade = getComputedStyle(foot, "::before");
            const tiles = [
              ...sheet.querySelectorAll("fieldset.providers .tile"),
            ].map((tile) => {
              const box = tile.getBoundingClientRect();
              const at = document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              );
              return {
                name: tile.querySelector(".tile-name")?.textContent ?? "",
                // Whole, above the foot, and nothing over it.
                shown:
                  box.top >= top - 1 &&
                  box.bottom <= footTop + 1 &&
                  Boolean(at && tile.contains(at)),
              };
            });
            return {
              scrolling,
              goesOn:
                fade.content !== "none" && Number.parseFloat(fade.height) > 0,
              tiles,
            };
          });
        const first = await look();
        expect(first.scrolling).toEqual(["sheet"]);
        expect(first.tiles.map((tile) => tile.name)).toEqual(PROVIDERS);
        // Some are under the foot at this size, and the screen says the list goes on.
        expect(first.tiles.some((tile) => !tile.shown)).toBe(true);
        expect(first.goesOn).toBe(true);
        // A wheel over the list scrolls the card, and brings every provider into view.
        const seen = new Set(
          first.tiles.filter((tile) => tile.shown).map((tile) => tile.name),
        );
        await page.mouse.move(width / 2, height / 3);
        let now = first;
        for (let turn = 0; turn < 12 && now.goesOn; turn += 1) {
          await page.mouse.wheel(0, 90);
          await page.waitForTimeout(150);
          now = await look();
          for (const tile of now.tiles) if (tile.shown) seen.add(tile.name);
          expect(now.scrolling).toEqual(["sheet"]);
        }
        expect([...seen].sort()).toEqual([...PROVIDERS].sort());
        // At the end of the card nothing is under the foot, and the screen no longer says so.
        expect(now.goesOn).toBe(false);
        expect(now.tiles[now.tiles.length - 1]?.shown).toBe(true);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/*
 * Seen on Windows G: the background row read "Installing OpenBot in the backgr..." beside its
 * "Step 3 of 4 · 4m 18s elapsed" badge. Its name is whole now, the badge on a line of its own, and
 * the row still fits the height its slot holds in every state.
 */
describe.skipIf(!asked)(
  "the background row's name beside minutes of install",
  () => {
    for (const [width, height] of [
      [1016, 839],
      [1000, 800],
      [720, 560],
    ] as const) {
      test(`at ${width}x${height}, is read whole in Windows-wide type, and the row fits its slot`, async () => {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await toTheAiStep(page);
          await page.evaluate(() => {
            const real = Date.now;
            Date.now = () => real() + 258_000;
            // Wider type than this browser sets, as the foot's own test does: Windows' is.
            const wider = document.createElement("style");
            wider.textContent = ".behind-slot { letter-spacing: 0.12em; }";
            document.head.append(wider);
          });
          const read = () =>
            page.evaluate(() => {
              const name = document.querySelector(
                ".behind-slot .step-label",
              ) as HTMLElement;
              const row = document
                .querySelector(".behind-slot > .steps")
                ?.getBoundingClientRect();
              const slot = document
                .querySelector(".behind-slot")
                ?.getBoundingClientRect();
              return {
                name: name.textContent,
                cut: name.scrollWidth > name.clientWidth,
                badge:
                  document.querySelector(".behind-slot .step-status")
                    ?.textContent ?? "",
                fits: (row?.bottom ?? 1e9) <= (slot?.bottom ?? 0) + 0.5,
              };
            });
          // Setting up, then downloading the rest with its bar and bytes, then installed.
          await page.getByText(/Setting up OpenBot on this computer/).waitFor();
          await page.waitForTimeout(1100);
          const plain = await read();
          expect(plain).toEqual({
            name: "Installing OpenBot in the background",
            cut: false,
            badge: expect.stringMatching(/^Step 3 of 4 · 4m \d+s elapsed$/),
            fits: true,
          });
          await page.evaluate(() => {
            (
              globalThis as unknown as { __fake: { download: unknown } }
            ).__fake.download = { done: 481_800_000, total: 605_200_000 };
          });
          await page.getByText("481.8 MB of 605.2 MB").waitFor();
          expect(await read()).toEqual({ ...plain, badge: expect.any(String) });
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  },
);

/*
 * Seen on Windows G: the background row moved about 15 px sideways when a provider was chosen, as
 * the card stopped scrolling and its scrollbar went. With the scrollbars Windows draws, which
 * take room, the row is where it was either way.
 */
describe.skipIf(!asked)(
  "with scrollbars that take room, as Windows draws them",
  () => {
    test("at 1000x800, the background row holds still as the card's scrollbar comes and goes", async () => {
      const drawn = await chromium.launch({
        channel: "chromium",
        ignoreDefaultArgs: ["--hide-scrollbars"],
      });
      try {
        const page = await drawn.newPage({
          viewport: { width: 1000, height: 800 },
        });
        await toTheAiStep(page);
        const where = () =>
          page.evaluate(() => {
            const sheet = document.querySelector(
              "main > .sheet",
            ) as HTMLElement;
            const row = document
              .querySelector(".behind-slot > .steps")
              ?.getBoundingClientRect();
            const tile = document
              .querySelector("fieldset.providers .tile")
              ?.getBoundingClientRect();
            return {
              scrolls: sheet.scrollHeight > sheet.clientHeight + 1,
              scrollbar: sheet.offsetWidth - sheet.clientWidth > 2,
              row: row && { left: row.left, width: row.width },
              tile: tile && { left: tile.left, width: tile.width },
            };
          });
        const listing = await where();
        expect(listing.scrolls).toBe(true);
        expect(listing.scrollbar).toBe(true);
        // A provider chosen, the step fits, and the card has no scrollbar to draw.
        await page.getByText("Anthropic", { exact: true }).click();
        await page
          .getByRole("button", { name: "Choose a different provider" })
          .waitFor();
        await page.waitForTimeout(400);
        const chosen = await where();
        expect(chosen.scrolls).toBe(false);
        expect(chosen.row).toEqual(listing.row);
        expect(chosen.tile).toEqual(listing.tile);
      } finally {
        await drawn.close();
      }
    }, 30_000);
  },
);

/** Opens a relaunch whose Start updates OpenBot, at its last step, OpenBot opening. */
async function toStart(page: Page) {
  await open(page, "#start");
  await page.getByRole("listitem", { name: "Opening OpenBot" }).waitFor();
  await page.waitForTimeout(600);
}

const emitProgress = (page: Page, payload: Record<string, unknown>) =>
  page.evaluate(
    (sent) =>
      (
        globalThis as unknown as {
          __fake: { emit: (name: string, payload: unknown) => void };
        }
      ).__fake.emit("setup:progress", sent),
    payload,
  );

describe.skipIf(!asked)("the Start screen's words and card", () => {
  /*
   * Seen on Windows G: "Starting OpenBot" said "This usually takes a minute or two" over a card
   * that said "About 3 minutes left", and the start took four. The card's time comes from how long
   * each part takes; the heading gives none of its own.
   */
  test("the time is said once, by the card", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toStart(page);
      const said = await page.evaluate(() => ({
        heading: document.querySelector("main h1")?.textContent,
        lede: document.querySelector("main .lede")?.textContent ?? "",
        card: document.querySelector(".journey-time")?.textContent ?? "",
      }));
      expect(said.heading).toBe("Starting OpenBot");
      expect(said.lede).toBe("OpenBot is getting ready and opens by itself.");
      expect(said.lede).not.toMatch(/minute|second|hour/i);
      expect(said.card).toMatch(/left/);
    } finally {
      await page.close();
    }
  }, 30_000);

  /*
   * Seen on Windows G: the card grew from one line to Docker Desktop's three-line hand-off and back,
   * and the rows under it moved each time. It holds one height now, with what it says and its bar
   * at the top as a row's are, and the spare height at the bottom.
   */
  test("the card holds one height as what it says comes and goes, and the rows under it stay", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toStart(page);
      const measure = () =>
        page.evaluate(() => {
          const card = document
            .querySelector(".journey")
            ?.getBoundingClientRect();
          const words = document
            .querySelector(".journey-said")
            ?.getBoundingClientRect();
          const time = document
            .querySelector(".journey-time")
            ?.getBoundingClientRect();
          const bar = document
            .querySelector(".journey progress")
            ?.getBoundingClientRect();
          const said = document.querySelector(".journey-said") as HTMLElement;
          return {
            card: card?.height,
            row: document
              .querySelector('[aria-label="Setting up OpenBot"]')
              ?.getBoundingClientRect().top,
            cut: said.scrollHeight > said.clientHeight + 1,
            // At the top, in the card's own padding, and the bar right under the words.
            top: Math.round((words?.top ?? 0) - (card?.top ?? 0)),
            under: Math.round((bar?.top ?? 0) - (time?.bottom ?? 0)),
            spare: (card?.bottom ?? 0) - (bar?.bottom ?? 0) >= 13,
          };
        });
      const plain = await measure();
      expect(plain).toMatchObject({
        card: 130,
        top: 13,
        under: 10,
        spare: true,
        cut: false,
      });
      const handOff =
        "Docker Desktop is starting in its own window. If it asks you to accept its terms or sign in, do that there. OpenBot comes back when Docker is ready.";
      await emitProgress(page, {
        step: "engine",
        ok: true,
        running: true,
        elsewhere: true,
        detail: handOff,
      });
      await page
        .locator(".journey-said", { hasText: "Docker Desktop is starting" })
        .waitFor();
      expect(await measure()).toEqual(plain);
      await emitProgress(page, {
        step: "engine",
        ok: true,
        running: false,
        detail: "The software OpenBot runs on is ready.",
      });
      await page
        .locator(".journey-said", { hasText: "Docker Desktop is starting" })
        .waitFor({ state: "hidden" });
      expect(await measure()).toEqual(plain);
    } finally {
      await page.close();
    }
  }, 30_000);

  /*
   * Seen on Windows G: Cancel went at step 4 and the card shrank. Cancel stops the setup's own
   * steps; the last, OpenBot starting or updating, can't be stopped partway. Its place says so, in
   * a button's height.
   */
  test("at its last step, the place of Cancel says why it can't be cancelled", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toStart(page);
      expect(await page.getByRole("button", { name: "Cancel" }).count()).toBe(
        0,
      );
      const note = page.locator(".cannot-cancel");
      expect(await note.textContent()).toBe(
        "You can't cancel this last step. Stopping it partway could leave OpenBot half started.",
      );
      expect((await note.boundingBox())?.height).toBe(40);
      // OpenBot updating itself, as on Windows G.
      await emitProgress(page, {
        step: "release",
        ok: true,
        running: true,
        detail: "Downloading the update.",
      });
      await page
        .locator(".cannot-cancel", { hasText: "the update half done" })
        .waitFor();
      expect((await note.boundingBox())?.height).toBe(40);
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe.skipIf(!asked)(
  "the account step for a person already signed in",
  () => {
    /*
     * Seen on Windows G: for two seconds before the license agreement, a signed-in person saw the
     * signed-out pitch ("It requires a free license key", "does NOT send traffic data") over
     * "Checking your OpenBot account". The step says only that it is checking, until it knows.
     */
    test("while the sign-in is checked, the screen says so and nothing about signing in", async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
      });
      try {
        await open(page, "#licence-slow");
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Your OpenBot account" })
          .waitFor();
        const text = await page.evaluate(
          () =>
            (document.querySelector("main > .sheet") as HTMLElement).innerText,
        );
        expect(text).toContain("Checking your OpenBot account");
        expect(text).not.toMatch(
          /license key|traffic data|Self-contained|sign in/i,
        );
        await page
          .getByRole("heading", { name: "Accept the license agreement" })
          .waitFor();
      } finally {
        await page.close();
      }
    }, 30_000);

    /*
     * Seen on Windows G: signed in already, the license screen's background row still said "The rest
     * of the install starts after you sign in and accept the license agreement".
     */
    test("the background row waits on the agreement only", async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
      });
      try {
        await open(page, "#licence");
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Accept the license agreement" })
          .waitFor();
        const row = page.getByRole("listitem", {
          name: "Installing OpenBot in the background",
        });
        await page.getByText(/The rest of the install starts/).waitFor();
        const said = (await row.textContent()) ?? "";
        expect(said).toContain(
          "The rest of the install starts after you accept the license agreement.",
        );
        expect(said).not.toMatch(/sign in/i);
      } finally {
        await page.close();
      }
    }, 30_000);
  },
);
