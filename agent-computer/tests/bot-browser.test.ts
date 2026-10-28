import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { BotBrowserState } from "../../shared/bot-browser";
import type { LauncherConnection } from "../../shared/openbot-browser";
import { type BotBrowserHost, SENDING_WAIT_MS } from "../src/bot-browser-host";
import type { BrowserRuntime } from "../src/browser-runtime";
import { createControl } from "../src/control";
import { PLAYWRIGHT_DISABLED_FEATURES } from "../src/person-launch";
import type { Profiles } from "../src/profiles";
import { startScreencast } from "../src/screencast";
import { setWebBotAuth } from "../src/web-bot-auth";

/**
 * What the Recorder changes for a Bot's own browser, launched for real: two Bots side by side on one computer, one
 * whose browser has the fixture Recorder in it and one whose browser does not, as a computer without
 * `OPENBOT_RECORDER_DIR` launches it. Until somebody records, the Recorder must change nothing the Bot or a site can
 * see: not the page the Bot is on, not what the browser says about itself, not the Web Bot Auth signature.
 *
 * The bar's routes are served over the Bot's browser from `createBotBrowserHost`, with the real control state machine
 * (`control.ts`) holding the wheel for a person. `bot-browser-computer.test.ts` drives the same routes through the
 * running computer.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/bot-browser.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const FIXTURE = join(import.meta.dir, "fixtures", "recorder");
const WITH = "bot-with-recorder";
const WITHOUT = "bot-without-recorder";

const HOSTED: BrowserRuntime = {
  backend: "managed",
  channel: "chromium",
  mode: "headless",
  useVirtualDisplay: false,
  allowExec: true,
};

type FixtureCall = { method: string; input: unknown; sending: boolean };
/** Every call the fixture Recorder received, as it reported it to the OpenBot it was connected to. */
const calls: FixtureCall[] = [];
/** How long the last of a stopped recording takes to reach Intelligence, as this OpenBot tells the fixture Recorder. */
let tailMs = 0;

/**
 * The site both Bots browse, which says back what each browser sent it; and the OpenBot the fixture Recorder is
 * connected to while a person records.
 */
const site = asked
  ? Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/fixture/calls") {
          calls.push((await request.json()) as FixtureCall);
          return new Response("");
        }
        if (url.pathname === "/fixture/tail")
          return Response.json({ ms: tailMs });
        if (url.pathname === "/api/recorder/me")
          return Response.json({ user: CONNECTION.user });
        if (url.pathname === "/headers")
          return Response.json(Object.fromEntries(request.headers));
        const name = url.pathname.split("/").at(-1) || "home";
        return new Response(
          `<!doctype html><title>${name}</title><input autofocus>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    })
  : undefined;
const ORIGIN = `http://127.0.0.1:${site?.port ?? 0}`;
const CONNECTION: LauncherConnection = {
  openbotUrl: ORIGIN,
  token: "obr_bot-browser-tail",
  connectionId: "connection-tail",
  user: { id: "user-1", name: "Pat Example", email: "pat@example.com" },
};
/** How long a test lets ending a recording wait for its last part, so the bound runs out in seconds, not twenty. */
const SENDING_WAIT_IN_TESTS_MS = 3_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The launched browser's own command line, as `chrome://version` reports it, in a tab of its own. */
async function commandLine(page: Page): Promise<string[]> {
  const tab = await page.context().newPage();
  try {
    await tab.goto("chrome://version");
    const text = await tab.evaluate(() => document.body.innerText);
    const line = text
      .split("\n")
      .find((candidate) => candidate.includes("--remote-debugging-pipe"));
    if (!line) throw new Error("chrome://version showed no command line.");
    return line.split(/\s+/);
  } finally {
    await tab.close();
  }
}

/** What a page in a browser says about itself, on the wire and to its own scripts. */
async function identity(page: Page) {
  await page.goto(`${ORIGIN}/headers`);
  const headers = JSON.parse(
    await page.evaluate(() => document.body.innerText),
  ) as Record<string, string>;
  const script = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    brands: (
      navigator as Navigator & {
        userAgentData?: { brands: { brand: string }[] };
      }
    ).userAgentData?.brands.map((brand) => brand.brand),
    languages: navigator.languages,
    plugins: navigator.plugins.length,
    viewport: [innerWidth, innerHeight],
    runtime: typeof (globalThis as { chrome?: { runtime?: unknown } }).chrome
      ?.runtime,
  }));
  return {
    wire: {
      "user-agent": headers["user-agent"],
      "sec-ch-ua": headers["sec-ch-ua"],
      "sec-ch-ua-mobile": headers["sec-ch-ua-mobile"],
      "sec-ch-ua-platform": headers["sec-ch-ua-platform"],
      "accept-language": headers["accept-language"],
    },
    script,
  };
}

let root = "";
let withRecorder: Profiles;
let withoutRecorder: Profiles;
let host: BotBrowserHost;
let server: ReturnType<typeof Bun.serve>;
/** The Bot's control, as the computer keeps it: the real state machine, telling the routes when the wheel leaves. */
const control = createControl(undefined, {
  onWheelLeft: () => host.wheelLeft(WITH),
});

async function bar<T = BotBrowserState>(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-openbot-bot-id": WITH },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "openbot-bot-browser-"));
  // Imported here rather than at the top, so a run that did not ask for a browser never loads Playwright.
  const { createProfiles } = await import("../src/profiles");
  const { createBotBrowserHost } = await import("../src/bot-browser-host");
  withRecorder = createProfiles(join(root, "with"), () => undefined, {
    runtime: HOSTED,
    recorderDir: () => FIXTURE,
  });
  withoutRecorder = createProfiles(join(root, "without"), () => undefined, {
    runtime: HOSTED,
    recorderDir: () => undefined,
  });
  host = createBotBrowserHost({
    profiles: withRecorder,
    control: () => control,
    navigationTimeoutMs: 15_000,
    sendingWaitMs: SENDING_WAIT_IN_TESTS_MS,
  });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      host.handle(
        request,
        new URL(request.url).pathname,
        request.headers.get("x-openbot-bot-id") ?? "",
      ),
  });
}, 30_000);

afterAll(async () => {
  if (!asked) return;
  server?.stop(true);
  await withRecorder?.closeAll();
  await withoutRecorder?.closeAll();
  site?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!asked)("a Bot's browser with the Recorder in it", () => {
  test("starts on its own first tab, and the Recorder's setup page, which it opens at every launch, never becomes the Bot's page", async () => {
    const page = await withRecorder.page(WITH);
    expect(page.url()).toBe("about:blank");
    // Given the setup page time to appear and go.
    await wait(1_500);
    const view = withRecorder.bot(WITH);
    if (!view?.recorder) throw new Error("The Recorder should be in it.");
    expect(view.recorder.problem).toBeUndefined();
    expect(await withRecorder.page(WITH)).toBe(page);
    expect(view.context.pages().map((each) => each.url())).not.toContainEqual(
      expect.stringContaining("chrome-extension://"),
    );
    // In it, answering, and connected to nobody.
    expect(await view.recorder.launcher.state()).toMatchObject({
      connected: false,
      phase: "idle",
    });
  }, 60_000);

  test("launches as a Bot's browser without it does, with only the Recorder's switches added", async () => {
    const withs = await commandLine(await withRecorder.page(WITH));
    const withouts = await commandLine(await withoutRecorder.page(WITHOUT));
    const recorderSwitches = [
      `--disable-extensions-except=${FIXTURE}`,
      `--load-extension=${FIXTURE}`,
      "--enable-unsafe-extension-debugging",
      "--silent-debugger-extension-api",
    ];
    for (const added of recorderSwitches) expect(withs).toContain(added);
    expect(withs).not.toContain("--disable-extensions");
    expect(withouts).toContain("--disable-extensions");
    // Everything else the same, the egress filter's features among it: only the profile folder differs.
    const rest = (switches: string[]) =>
      switches
        .filter(
          (value) =>
            !recorderSwitches.includes(value) &&
            value !== "--disable-extensions" &&
            !value.startsWith("--user-data-dir="),
        )
        .sort();
    expect(rest(withs)).toEqual(rest(withouts));
    expect(
      withs.filter((value) => value.startsWith("--disable-features=")).at(-1),
    ).toBe(
      `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, "AcceptCHFrame"].join(",")}`,
    );
  }, 60_000);

  test("says exactly what it says about itself without the Recorder, to sites and to their scripts", async () => {
    const withPage = await withRecorder.page(WITH);
    const withoutPage = await withoutRecorder.page(WITHOUT);
    const theirs = await identity(withPage);
    expect(theirs).toEqual(await identity(withoutPage));
    expect(theirs.wire["user-agent"]).not.toContain("HeadlessChrome");
    expect(theirs.script.webdriver).toBe(false);
  }, 60_000);

  test("still signs its requests as the deployment's Bot", async () => {
    const jwk = generateKeyPairSync("ed25519").privateKey.export({
      format: "jwk",
    });
    await setWebBotAuth({ agent: "https://openbot.example.com", jwk });
    try {
      for (const profiles of [withRecorder, withoutRecorder]) {
        const page = await profiles.page(
          profiles === withRecorder ? WITH : WITHOUT,
        );
        await page.goto(`${ORIGIN}/headers`);
        const headers = JSON.parse(
          await page.evaluate(() => document.body.innerText),
        ) as Record<string, string>;
        expect(headers["signature-agent"]).toBeTruthy();
        expect(headers.signature).toBeTruthy();
      }
    } finally {
      await setWebBotAuth(null);
    }
  }, 60_000);

  test("a page of the Recorder's own a tab shows is never the page the Bot is on, nor one of its tabs", async () => {
    const page = await withRecorder.page(WITH);
    const view = withRecorder.bot(WITH);
    if (!view?.recorder) throw new Error("The Recorder should be in it.");
    const own = await view.context.newPage();
    try {
      await own.goto(
        `chrome-extension://${view.recorder.recorderId}/options.html`,
      );
      expect(await withRecorder.page(WITH)).toBe(page);
      const listed = (await bar("/bot-browser/state")).json.tabs;
      expect(listed.map((tab) => tab.url)).not.toContainEqual(
        expect.stringContaining("chrome-extension://"),
      );
    } finally {
      await own.close();
    }
  }, 60_000);

  test("the live screen shows the whole page of the tab the person brings back to the front", async () => {
    const first = await withRecorder.page(WITH);
    await first.goto(`${ORIGIN}/page/first`);
    const help = control.requestHelp(
      "I want to take control of the browser.",
    ).request;
    if (!help) throw new Error("The request was not raised.");
    await control.take(help.id, "user-1");
    try {
      // Away to another tab and back, which lays the page out again in its window.
      const opened = (await bar("/bot-browser/tabs", { action: "new" })).json;
      const back = opened.tabs.find((tab) => tab.title === "first");
      const other = opened.tabs.find((tab) => tab.active);
      if (!back || !other) throw new Error("Both tabs should be listed.");
      await bar("/bot-browser/tabs", { action: "activate", tabId: back.id });
      await bar("/bot-browser/tabs", { action: "close", tabId: other.id });
      const page = await withRecorder.page(WITH);
      expect(page).toBe(first);
      const height = page.viewportSize()?.height;
      if (!height) throw new Error("The page should have a viewport.");
      const heights: number[] = [];
      const cast = await startScreencast(page, (frame) =>
        heights.push(frame.height),
      );
      try {
        for (let turn = 0; turn < 8; turn += 1) {
          await page.evaluate(
            (odd) => {
              document.body.style.background = odd ? "#fefefe" : "#ffffff";
            },
            turn % 2 === 1,
          );
          await wait(100);
        }
        expect(heights.length).toBeGreaterThan(0);
        expect(new Set(heights)).toEqual(new Set([height]));
      } finally {
        await cast.stop();
      }
    } finally {
      control.release(help.id);
    }
  }, 60_000);
});

describe.skipIf(!asked)("the last of a recording, after Stop", () => {
  /** Take the wheel as user-1, and start recording. Answers the request, to hand the wheel back with. */
  async function recording(title: string): Promise<string> {
    const help = control.requestHelp(
      "I want to take control of the browser.",
    ).request;
    if (!help) throw new Error("The request was not raised.");
    await control.take(help.id, "user-1");
    const started = await bar("/bot-browser/recording", {
      action: "start",
      title,
      by: "user-1",
      connection: CONNECTION,
    });
    expect(started.status).toBe(200);
    calls.length = 0;
    return help.id;
  }
  const disconnects = () =>
    calls.filter((call) => call.method === "disconnect");

  test("the bound is the Recorder's own: a rejoin and a push, each the gateway's timeout", async () => {
    const source = await readFile(
      join(
        import.meta.dir,
        "..",
        "..",
        "extension",
        "src",
        "offscreen",
        "phoenix-session.ts",
      ),
      "utf8",
    );
    const gateway = /PHOENIX_TIMEOUT_MS = ([\d_]+);/.exec(source)?.[1];
    expect(gateway).toBeDefined();
    expect(SENDING_WAIT_MS).toBe(2 * Number(gateway?.replaceAll("_", "")));
  });

  test("Stop disconnects the Recorder only once the last of the recording has reached Intelligence", async () => {
    tailMs = 800;
    const requestId = await recording("A slow tail");
    const from = Date.now();
    const stopped = await bar("/bot-browser/recording", { action: "stop" });
    expect(stopped.status).toBe(200);
    expect(Date.now() - from).toBeGreaterThanOrEqual(700);
    // Stopped while some of it was still on its way, and let go once none was.
    expect(calls.map((call) => [call.method, call.sending])).toEqual([
      ["record", true],
      ["disconnect", false],
    ]);
    expect(stopped.json.recorder).toMatchObject({ connected: false });
    expect(stopped.json.recorder?.lastStopped?.sending).toBeUndefined();
    control.release(requestId);
    await host.settled(WITH);
  }, 60_000);

  test("handing the wheel back waits for the last of it too", async () => {
    tailMs = 800;
    const requestId = await recording("Handed back with a tail");
    control.release(requestId);
    await host.settled(WITH);
    expect(calls.map((call) => [call.method, call.sending])).toEqual([
      ["record", true],
      ["disconnect", false],
    ]);
  }, 60_000);

  test("a last part that never arrives holds the disconnect no longer than the bound", async () => {
    tailMs = 600_000;
    const requestId = await recording("A tail that never ends");
    const from = Date.now();
    const stopped = await bar("/bot-browser/recording", { action: "stop" });
    const took = Date.now() - from;
    expect(stopped.status).toBe(200);
    expect(took).toBeGreaterThanOrEqual(SENDING_WAIT_IN_TESTS_MS);
    expect(took).toBeLessThan(SENDING_WAIT_IN_TESTS_MS + 5_000);
    // Disconnected all the same, with the rest kept for the person's next connection here.
    expect(disconnects()).toHaveLength(1);
    expect(disconnects()[0]?.sending).toBe(true);
    expect(stopped.json.recorder).toMatchObject({ connected: false });
    control.release(requestId);
    await host.settled(WITH);
  }, 60_000);
});
