import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type {
  BrowserState,
  LauncherConnection,
} from "../../shared/openbot-browser";
import type { BrowserRuntime } from "../src/browser-runtime";
import type { BrowserHost } from "../src/browser-host";
import {
  defaultNativeMessagingHosts,
  type InstalledBrowser,
  installedBrowser,
  PLAYWRIGHT_DEFAULTS_A_PERSON_DOES_NOT_GET,
  PLAYWRIGHT_DISABLED_FEATURES,
} from "../src/person-launch";
import type { Profiles } from "../src/profiles";
import { startScreencast } from "../src/screencast";

/**
 * A person's browser, launched for real and driven through the real browser routes.
 *
 * Two of them. The hosted one is the computer's bundled Chromium with the Recorder loaded by flag.
 * The Desktop one is the installed Google Chrome (or Edge where Chrome is missing) with the Recorder
 * installed through DevTools, launched headless here: the computer's own environment insists a
 * native browser is headed, and these tests must never open a window on the machine running them,
 * so the routes are served from `createBrowserHost` over browsers launched with that one difference.
 * Skipped cleanly where no Chrome or Edge is installed.
 *
 * The Recorder is `fixtures/recorder`, which implements its launcher API exactly as the contract types
 * it and reports every call it receives to the OpenBot it was connected to, so what these tests read
 * is the Recorder's side of the call. The real Recorder replaces it once both are built.
 *
 * Asked for by name, as the other real-browser tests are:
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/person-browser.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";

const FIXTURE = join(import.meta.dir, "fixtures", "recorder");
const REPO = join(import.meta.dir, "..", "..");
const PERSON = "person-0123456789abcdef0123456789abcdef";

type FixtureCall = {
  method: string;
  input: unknown;
  tabs: string[];
  front: string;
  microphone: string;
  setupOpened: boolean;
};

const calls: FixtureCall[] = [];

/** The OpenBot the fixture reports to, and the pages the tests browse. */
const openbot = asked
  ? Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/fixture/calls") {
          calls.push((await request.json()) as FixtureCall);
          return new Response("");
        }
        // What a browser sent, for comparing what two browsers say about themselves.
        if (url.pathname === "/headers")
          return Response.json(Object.fromEntries(request.headers));
        if (url.pathname === "/report.txt")
          return new Response("the person's file", {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": "attachment; filename=report.txt",
            },
          });
        const name = url.pathname.split("/").at(-1) || "home";
        return new Response(
          `<!doctype html><title>${name}</title><a id="download" href="/report.txt">Download</a><input autofocus>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    })
  : undefined;
const ORIGIN = `http://127.0.0.1:${openbot?.port ?? 0}`;

const CONNECTION: LauncherConnection = {
  openbotUrl: ORIGIN,
  token: "obr_fixture-token",
  connectionId: "connection-1",
  user: { id: "user-1", name: "Pat Example", email: "pat@example.com" },
};

const native = asked ? await installedBrowser(process.env) : null;

type Variant = {
  name: string;
  available: boolean;
  runtime: BrowserRuntime;
  product: "chromium" | InstalledBrowser;
  window: "screen" | "native";
};

const VARIANTS: Variant[] = [
  {
    name: "hosted: bundled Chromium on the live screen",
    available: true,
    runtime: {
      backend: "managed",
      channel: "chromium",
      mode: "headless",
      useVirtualDisplay: false,
      allowExec: true,
    },
    product: "chromium",
    window: "screen",
  },
  {
    name: `Desktop: installed ${native === "msedge" ? "Microsoft Edge" : "Google Chrome"}, headless here`,
    available: native !== null,
    runtime: {
      backend: "local-chrome",
      channel: "chrome",
      mode: "headless",
      useVirtualDisplay: false,
      hostname: "127.0.0.1",
      allowExec: false,
    },
    product: native ?? "chrome",
    window: "native",
  },
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  why: string,
  budgetMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${why}`);
    await wait(50);
  }
}

/** The launched browser's own command line, as `chrome://version` reports it. */
async function commandLine(page: Page): Promise<string[]> {
  await page.goto("chrome://version");
  const text = await page.evaluate(() => document.body.innerText);
  const line = text
    .split("\n")
    .find((candidate) => candidate.includes("--remote-debugging-pipe"));
  if (!line) throw new Error("chrome://version showed no command line.");
  return line.split(/\s+/);
}

/**
 * The features a browser runs without, from its own command line: Chromium keeps only the last
 * `--disable-features` it is given, so that one is the one that counts.
 */
function disabledFeatures(switches: string[]): string[] {
  const last = switches
    .filter((value) => value.startsWith("--disable-features="))
    .at(-1);
  return last ? last.slice("--disable-features=".length).split(",") : [];
}

/** A port nothing listens on, so a page there is refused. */
async function closedPort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const { port } = probe;
  await probe.stop(true);
  if (port === undefined) throw new Error("The port probe did not listen.");
  return port;
}

/** Every browser the tests start, closed at the end whatever happened. */
const opened: Profiles[] = [];

async function harness(runtime: BrowserRuntime, root: string, tag: string) {
  const { createProfiles } = (await import(
    `../src/profiles?person=${tag}`
  )) as typeof import("../src/profiles");
  const { createBrowserHost } = await import("../src/browser-host");
  const profiles = createProfiles(root, () => undefined, { runtime });
  opened.push(profiles);
  const host = createBrowserHost({
    profiles,
    recorderDir: () => FIXTURE,
    navigationTimeoutMs: 15_000,
  });
  return { profiles, host };
}

function serve(host: BrowserHost) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      host.handle(
        request,
        new URL(request.url).pathname,
        request.headers.get("x-openbot-bot-id") ?? "",
      ),
  });
}

afterAll(async () => {
  for (const profiles of opened) await profiles.closeAll();
  openbot?.stop(true);
}, 60_000);

for (const variant of VARIANTS) {
  describe.skipIf(!asked || !variant.available)(variant.name, () => {
    let root = "";
    let downloads = "";
    let profiles: Profiles;
    let server: ReturnType<typeof Bun.serve>;

    async function api(
      path: string,
      body?: unknown,
      botId = PERSON,
    ): Promise<{ status: number; json: Record<string, unknown> }> {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-bot-id": botId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        json: (await response.json()) as Record<string, unknown>,
      };
    }

    const state = async () =>
      (await api("/browser/state")).json as BrowserState;
    const activeTab = (current: BrowserState) =>
      current.tabs.find((tab) => tab.active);
    const callsFor = (method: string) =>
      calls.filter((call) => call.method === method);

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "openbot-person-browser-"));
      downloads = join(root, "downloads");
      await mkdir(downloads);
      // Where the person's browser saves a download, as its own settings would say.
      await mkdir(join(root, PERSON, "Default"), { recursive: true });
      await writeFile(
        join(root, PERSON, "Default", "Preferences"),
        JSON.stringify({
          download: {
            default_directory: downloads,
            prompt_for_download: false,
          },
        }),
      );
      const built = await harness(variant.runtime, root, variant.window);
      profiles = built.profiles;
      server = serve(built.host);
      calls.length = 0;
    }, 30_000);

    afterAll(async () => {
      server?.stop(true);
      await profiles?.closeAll();
      if (root) await rm(root, { recursive: true, force: true });
    }, 60_000);

    test("refuses a Bot's id", async () => {
      const opening = await api(
        "/browser/open",
        { connection: CONNECTION },
        "bot-one",
      );
      expect(opening.status).toBe(400);
      expect((await api("/browser/state", undefined, "shared")).status).toBe(
        400,
      );
    });

    test("never opens a browser without a built Recorder", async () => {
      const { createBrowserHost } = await import("../src/browser-host");
      for (const [dir, says] of [
        [undefined, "OPENBOT_RECORDER_DIR"],
        [join(REPO, "extension"), "not a built OpenBot Recorder"],
      ] as const) {
        const refusing = serve(
          createBrowserHost({
            profiles,
            recorderDir: () => dir,
            navigationTimeoutMs: 15_000,
          }),
        );
        try {
          const response = await fetch(
            `http://127.0.0.1:${refusing.port}/browser/open`,
            {
              method: "POST",
              headers: { "x-openbot-bot-id": PERSON },
              body: JSON.stringify({ connection: CONNECTION }),
            },
          );
          expect(response.status).toBe(503);
          expect(
            ((await response.json()) as { error: string }).error,
          ).toContain(says);
        } finally {
          refusing.stop(true);
        }
      }
      expect(profiles.isLive(PERSON)).toBe(false);
      expect((await state()).open).toBe(false);
    });

    test("refuses an open that is not the contract's", async () => {
      expect((await api("/browser/open", {})).status).toBe(400);
      expect(
        (
          await api("/browser/open", {
            connection: { ...CONNECTION, extra: true },
          })
        ).status,
      ).toBe(400);
      expect(profiles.isLive(PERSON)).toBe(false);
    });

    test("opens with the Recorder in it, connected, and the microphone granted", async () => {
      const opening = await api("/browser/open", { connection: CONNECTION });
      expect(opening.status).toBe(200);
      const current = opening.json as BrowserState;
      expect(current.open).toBe(true);
      expect(current.browser).toBe(variant.product);
      expect(current.window).toBe(variant.window);
      const narration = variant.window === "native" ? "own" : "external";
      expect(current.recorder).toMatchObject({
        connected: true,
        userId: "user-1",
        phase: "idle",
        narration,
      });
      expect(current.tabs.length).toBeGreaterThan(0);
      expect(current.tabs.filter((tab) => tab.active)).toHaveLength(1);

      // The Recorder's side: called with exactly the contract's input, its microphone granted.
      const [connect] = callsFor("connect");
      expect(connect?.input).toEqual({ connection: CONNECTION, narration });
      expect(connect?.microphone).toBe("granted");
    }, 60_000);

    test("never shows the Recorder's setup page, though the Recorder opens one", async () => {
      // The fixture opened it on install, as the Recorder does. Given a moment to appear late, it is
      // still not there: not among the browser's pages, and not in the person's tabs.
      expect(callsFor("connect")[0]?.setupOpened).toBe(true);
      await wait(1_500);
      const pages = profiles.person(PERSON)?.context.pages() ?? [];
      expect(pages.map((page) => page.url())).not.toContainEqual(
        expect.stringContaining("setup.html"),
      );
      for (const tab of (await state()).tabs)
        expect(tab.url).not.toStartWith("chrome-extension://");
    });

    test("opening it again opens nothing new and connects the Recorder again", async () => {
      const before = (await state()).tabs;
      const connects = callsFor("connect").length;
      const again = await api("/browser/open", { connection: CONNECTION });
      expect(again.status).toBe(200);
      expect((again.json as BrowserState).tabs.map((tab) => tab.id)).toEqual(
        before.map((tab) => tab.id),
      );
      expect(callsFor("connect")).toHaveLength(connects + 1);
    }, 30_000);

    test("opens, switches between and closes the person's tabs", async () => {
      const one = await api("/browser/tabs", {
        action: "new",
        url: `${ORIGIN}/page/one`,
      });
      expect(one.status).toBe(200);
      const two = (
        await api("/browser/tabs", { action: "new", url: `${ORIGIN}/page/two` })
      ).json as BrowserState;
      expect(activeTab(two)).toMatchObject({
        url: `${ORIGIN}/page/two`,
        title: "two",
      });
      const tabOne = two.tabs.find((tab) => tab.title === "one");
      const tabTwo = activeTab(two);
      if (!tabOne || !tabTwo) throw new Error("Both tabs should be listed.");

      const switched = (
        await api("/browser/tabs", { action: "activate", tabId: tabOne.id })
      ).json as BrowserState;
      expect(activeTab(switched)?.id).toBe(tabOne.id);
      // The tab in front is the page the live screen shows.
      expect((await profiles.page(PERSON)).url()).toBe(`${ORIGIN}/page/one`);

      const closed = (
        await api("/browser/tabs", { action: "close", tabId: tabTwo.id })
      ).json as BrowserState;
      expect(closed.tabs.map((tab) => tab.id)).not.toContain(tabTwo.id);
      expect(activeTab(closed)?.id).toBe(tabOne.id);
      // Ids stay the same for the life of a tab.
      expect(closed.tabs.find((tab) => tab.id === tabOne.id)?.title).toBe(
        "one",
      );

      expect(
        (await api("/browser/tabs", { action: "close", tabId: "no-such-tab" }))
          .status,
      ).toBe(404);
      expect(
        (
          await api("/browser/tabs", {
            action: "new",
            url: "file:///etc/passwd",
          })
        ).status,
      ).toBe(400);
    }, 60_000);

    test("navigates the tab in front: an address, back, forward and reload", async () => {
      const there = (
        await api("/browser/navigate", { url: `${ORIGIN}/page/three` })
      ).json as BrowserState;
      expect(activeTab(there)).toMatchObject({ title: "three" });
      const back = (await api("/browser/navigate", { action: "back" }))
        .json as BrowserState;
      expect(activeTab(back)?.url).toBe(`${ORIGIN}/page/one`);
      const forward = (await api("/browser/navigate", { action: "forward" }))
        .json as BrowserState;
      expect(activeTab(forward)?.url).toBe(`${ORIGIN}/page/three`);
      expect(
        (await api("/browser/navigate", { action: "reload" })).status,
      ).toBe(200);
      expect(
        (await api("/browser/navigate", { url: "javascript:alert(1)" })).status,
      ).toBe(400);
      expect(
        (await api("/browser/navigate", { url: ORIGIN, action: "back" }))
          .status,
      ).toBe(400);

      // A page that does not open is said in a sentence about its address, not Playwright's error
      // and call log. In a tab of its own, which then closes, so the person's tab stays as it was.
      const before = activeTab(await state());
      const blank = activeTab(
        (await api("/browser/tabs", { action: "new" })).json as BrowserState,
      );
      if (!before || !blank) throw new Error("Both tabs should be listed.");
      const port = await closedPort();
      expect(
        await api("/browser/navigate", { url: `http://127.0.0.1:${port}/` }),
      ).toEqual({
        status: 502,
        json: { error: `127.0.0.1:${port} refused the connection.` },
      });
      await api("/browser/tabs", { action: "close", tabId: blank.id });
      await api("/browser/tabs", { action: "activate", tabId: before.id });
      expect(activeTab(await state())?.url).toBe(`${ORIGIN}/page/three`);
    }, 60_000);

    test("a tab whose page did not load names the address that failed", async () => {
      // The run that found it: the hosted address bar showed chrome-error://chromewebdata/, the error
      // page's own address, rather than what the person typed.
      const before = activeTab(await state());
      const blank = activeTab(
        (await api("/browser/tabs", { action: "new" })).json as BrowserState,
      );
      if (!before || !blank) throw new Error("Both tabs should be listed.");
      const port = await closedPort();
      const failed = `http://127.0.0.1:${port}/`;
      expect((await api("/browser/navigate", { url: failed })).status).toBe(
        502,
      );
      // Asked straight after the failure, as the app asks.
      expect(activeTab(await state())?.url).toBe(failed);
      // Reloading it is said about that address too.
      expect(await api("/browser/navigate", { action: "reload" })).toEqual({
        status: 502,
        json: { error: `127.0.0.1:${port} refused the connection.` },
      });
      expect(activeTab(await state())?.url).toBe(failed);
      await api("/browser/tabs", { action: "close", tabId: blank.id });
      await api("/browser/tabs", { action: "activate", tabId: before.id });
    }, 60_000);

    test("records and narrates through the Recorder", async () => {
      const started = await api("/browser/recording", {
        action: "start",
        title: "File an expense report",
      });
      expect(started.status).toBe(200);
      expect((started.json as BrowserState).recorder).toMatchObject({
        phase: "recording",
        title: "File an expense report",
      });
      const [record] = callsFor("record");
      expect(record?.input).toEqual({
        action: "start",
        title: "File an expense report",
      });
      // The tab the Recorder records is the one in front, which is the one the live screen shows.
      expect(record?.front).toBe(
        activeTab(started.json as BrowserState)?.url ?? "",
      );
      expect(record?.tabs).not.toContainEqual(
        expect.stringContaining("setup.html"),
      );

      // Hearing the person itself only in a native window, where narration is its own.
      expect((started.json as BrowserState).recorder?.voice).toBe(
        variant.window === "native" ? "listening" : undefined,
      );

      // The server's clock on every time, and `sentAt` its own, which goes no further.
      const sentAt = 1_760_000_003_000;
      const phrase = {
        text: "This is where the receipts go",
        startedAt: 1_760_000_000_000,
        endedAt: 1_760_000_002_500,
      };
      const ok = { status: 200, json: { ok: true } };
      expect(await api("/browser/narration", { ...phrase, sentAt })).toEqual(
        ok,
      );
      expect(callsFor("narrate").map((call) => call.input)).toEqual([phrase]);

      // The person starting a phrase, then stopping speaking.
      const since = 1_760_000_004_000;
      expect(
        await api("/browser/narration", { speaking: true, since, sentAt }),
      ).toEqual(ok);
      expect(
        await api("/browser/narration", { speaking: false, sentAt }),
      ).toEqual(ok);
      expect(callsFor("speaking").map((call) => call.input)).toEqual([
        { since },
        { since: null },
      ]);

      // Anything else is not the contract's and never reaches the Recorder.
      for (const body of [
        { ...phrase, endedAt: -1, sentAt },
        phrase,
        { speaking: true, sentAt },
        { speaking: false, since, sentAt },
      ])
        expect((await api("/browser/narration", body)).status).toBe(400);
      expect(callsFor("narrate")).toHaveLength(1);
      expect(callsFor("speaking")).toHaveLength(2);

      const stopped = await api("/browser/recording", { action: "stop" });
      expect((stopped.json as BrowserState).recorder?.phase).toBe("idle");
      // The recording Stop ended, so OpenBot can say where it went.
      const recordingId = (started.json as BrowserState).recorder?.recordingId;
      expect(
        (stopped.json as BrowserState).recorder?.lastStopped,
      ).toMatchObject({ recordingId, title: "File an expense report" });
      expect((stopped.json as BrowserState).recorder?.voice).toBe(
        variant.window === "native" ? "off" : undefined,
      );
      // The Recorder's own refusal comes back as one.
      const again = await api("/browser/recording", { action: "stop" });
      expect(again.status).toBe(409);
      expect(again.json.error).toBe("Nothing is being recorded.");
    }, 60_000);

    test("disconnecting makes the Recorder forget its connection now, recording or not", async () => {
      const started = await api("/browser/recording", {
        action: "start",
        title: "Disconnected part way",
      });
      expect(started.status).toBe(200);
      const disconnected = await api("/browser/disconnect", {});
      expect(disconnected.status).toBe(200);
      const after = disconnected.json as BrowserState;
      expect(after.open).toBe(true);
      expect(after.tabs.length).toBeGreaterThan(0);
      // The Recorder's own report: signed out, and the recording ended with it.
      expect(after.recorder).toMatchObject({ connected: false, phase: "idle" });
      expect(after.recorder?.userId).toBeUndefined();
      expect(callsFor("disconnect")).toHaveLength(1);
      // Asked again it is still signed out, and saying so twice is no error.
      expect((await api("/browser/disconnect", {})).status).toBe(200);
      expect((await state()).recorder?.connected).toBe(false);

      // The next open connects it again with what OpenBot hands it then.
      const reopened = await api("/browser/open", { connection: CONNECTION });
      expect((reopened.json as BrowserState).recorder?.connected).toBe(true);
    }, 60_000);

    test.skipIf(variant.window !== "screen")(
      "the live screen keeps the whole page while the Recorder records",
      async () => {
        const person = profiles.person(PERSON);
        if (!person) throw new Error("The browser should be open.");
        const page = person.active();
        // Away to another tab and back first, which lays the page out again in its window.
        const front = activeTab(await state());
        const other = activeTab(
          (await api("/browser/tabs", { action: "new" })).json as BrowserState,
        );
        if (!front || !other) throw new Error("Both tabs should be listed.");
        await api("/browser/tabs", { action: "activate", tabId: front.id });
        await api("/browser/tabs", { action: "close", tabId: other.id });
        const height = page.viewportSize()?.height;
        if (!height) throw new Error("The hosted page should have a viewport.");
        const heights: number[] = [];
        const cast = await startScreencast(page, (frame) =>
          heights.push(frame.height),
        );
        // The screen sends a frame when the page changes, so it is changed for as long as is asked.
        const repaint = async (ms: number) => {
          const until = Date.now() + ms;
          for (let turn = 0; Date.now() < until; turn += 1) {
            await page.evaluate(
              (odd) => {
                document.body.style.background = odd ? "#fefefe" : "#ffffff";
              },
              turn % 2 === 1,
            );
            await wait(100);
          }
        };
        try {
          await repaint(500);
          expect(heights.at(-1)).toBe(height);
          // The Recorder attaches its debugger to the tab here, which is when a browser shows its
          // "started debugging this browser" bar.
          const started = await api("/browser/recording", {
            action: "start",
            title: "Keep the whole page",
          });
          expect(started.status).toBe(200);
          const from = heights.length;
          await repaint(2_500);
          const recording = heights.slice(from);
          expect(recording.length).toBeGreaterThan(0);
          expect(new Set(recording)).toEqual(new Set([height]));
          expect(
            (await api("/browser/recording", { action: "stop" })).status,
          ).toBe(200);
          const after = heights.length;
          await repaint(1_000);
          expect(new Set(heights.slice(after))).toEqual(new Set([height]));
        } finally {
          await cast.stop();
        }
      },
      60_000,
    );

    test("wakes a Recorder whose worker has stopped", async () => {
      const person = profiles.person(PERSON);
      if (!person) throw new Error("The browser should be open.");
      const worker = async () =>
        (await person.session.send("Target.getTargets")).targetInfos.find(
          (target) =>
            target.type === "service_worker" &&
            target.url.startsWith(`chrome-extension://${person.recorderId}/`),
        );
      if (!(await worker()))
        throw new Error("The Recorder's worker should be running.");
      // Stopped as Chrome stops an idle MV3 worker, through a page's DevTools session.
      const page = await person.context.newCDPSession(person.active());
      await page.send("ServiceWorker.enable");
      await page.send("ServiceWorker.stopAllWorkers");
      await page.detach();
      await until(async () => !(await worker()), "the worker to stop");

      const woken = await state();
      expect(woken.recorder).toMatchObject({
        connected: true,
        userId: "user-1",
      });
      expect(await worker()).toBeDefined();
    }, 60_000);

    test("launches with the Recorder and nothing that makes it a test browser", async () => {
      const person = profiles.person(PERSON);
      if (!person) throw new Error("The browser should be open.");
      const page = await person.context.newPage();
      try {
        const switches = await commandLine(page);
        if (variant.window === "native") {
          expect(switches).toContain("--enable-unsafe-extension-debugging");
          for (const dropped of PLAYWRIGHT_DEFAULTS_A_PERSON_DOES_NOT_GET)
            expect(switches).not.toContain(dropped);
          // Spelled exactly as Playwright builds it, so an upgrade that changes the list shows here.
          expect(
            switches.filter((value) => value.startsWith("--disable-features=")),
          ).toEqual([]);
          // The person's own extensions are in it: the bar that says one attached stays.
          expect(switches).not.toContain("--silent-debugger-extension-api");
        } else {
          expect(switches).toContain(`--load-extension=${FIXTURE}`);
          expect(switches).toContain(`--disable-extensions-except=${FIXTURE}`);
          expect(switches).not.toContain("--disable-extensions");
          expect(switches).toContain("--silent-debugger-extension-api");
          // Through the egress filter: Playwright's own features off, and the ACCEPT_CH restart.
          expect(disabledFeatures(switches)).toEqual([
            ...PLAYWRIGHT_DISABLED_FEATURES,
            "AcceptCHFrame",
          ]);
        }
      } finally {
        await page.close();
      }
    }, 30_000);

    test.skipIf(variant.window !== "native")(
      "copies the person's native messaging hosts into the profile",
      async () => {
        const from = defaultNativeMessagingHosts(
          variant.product as InstalledBrowser,
          process.env,
        );
        const theirs: string[] = [];
        for (const name of from
          ? await readdir(from).catch(() => [] as string[])
          : []) {
          const file = await stat(join(from ?? "", name)).catch(() => null);
          if (name.endsWith(".json") && file?.isFile()) theirs.push(name);
        }
        const ours = await readdir(
          join(root, PERSON, "NativeMessagingHosts"),
        ).catch(() => [] as string[]);
        expect(ours.sort()).toEqual(theirs.sort());
      },
    );

    test.skipIf(variant.window !== "native")(
      "saves a download where the person's browser says, under its own name",
      async () => {
        const person = profiles.person(PERSON);
        if (!person) throw new Error("The browser should be open.");
        await person.active().click("#download");
        await until(
          async () => (await readdir(downloads)).includes("report.txt"),
          "the download to land",
        );
      },
      30_000,
    );

    test.skipIf(variant.window !== "screen")(
      "a Bot's browser beside it stays a test browser, with no Recorder in it",
      async () => {
        const previous = process.env.OPENBOT_RECORDER_DIR;
        process.env.OPENBOT_RECORDER_DIR = FIXTURE;
        try {
          const page = await profiles.page("bot-beside");
          const session = await page
            .context()
            .browser()
            ?.newBrowserCDPSession();
          const { targetInfos } = (await session?.send(
            "Target.getTargets",
          )) ?? {
            targetInfos: [],
          };
          expect(
            targetInfos.filter((target) =>
              target.url.startsWith("chrome-extension://"),
            ),
          ).toEqual([]);
          const switches = await commandLine(page);
          expect(switches).toContain("--disable-extensions");
          expect(disabledFeatures(switches)).toEqual([
            ...PLAYWRIGHT_DISABLED_FEATURES,
            "AcceptCHFrame",
          ]);
        } finally {
          if (previous === undefined) delete process.env.OPENBOT_RECORDER_DIR;
          else process.env.OPENBOT_RECORDER_DIR = previous;
          await profiles.stop("bot-beside");
        }
      },
      60_000,
    );

    test.skipIf(variant.window !== "screen")(
      "says exactly what a hosted Bot's browser says about itself",
      async () => {
        // The run that found it: Google showed the hosted person's browser its "unusual traffic"
        // check and refused it sign-in, from an address where Chrome was fine, and it had sent
        // HeadlessChrome/151 in its user agent where a Bot's browser beside it sent Chrome/151.
        const person = profiles.person(PERSON);
        if (!person) throw new Error("The browser should be open.");
        const said = async (page: Page) => {
          await page.goto(`${ORIGIN}/headers`);
          const headers = JSON.parse(
            await page.evaluate(() => document.body.innerText),
          ) as Record<string, string>;
          const script = await page.evaluate(() => ({
            userAgent: navigator.userAgent,
            brands: (
              navigator as Navigator & {
                userAgentData?: { brands: { brand: string }[] };
              }
            ).userAgentData?.brands.map((brand) => brand.brand),
          }));
          return {
            wire: {
              "user-agent": headers["user-agent"],
              "sec-ch-ua": headers["sec-ch-ua"],
              "sec-ch-ua-mobile": headers["sec-ch-ua-mobile"],
              "sec-ch-ua-platform": headers["sec-ch-ua-platform"],
            },
            script,
          };
        };
        const tab = activeTab(
          (await api("/browser/tabs", { action: "new" })).json as BrowserState,
        );
        const persons = await said(person.active());
        const bots = await said(await profiles.page("bot-identity"));
        try {
          expect(persons).toEqual(bots);
          expect(persons.wire["user-agent"]).toContain("Chrome/");
          expect(persons.wire["user-agent"]).not.toContain("HeadlessChrome");
          expect(persons.wire["sec-ch-ua"] ?? "").not.toContain(
            "HeadlessChrome",
          );
          expect(persons.script.userAgent).not.toContain("HeadlessChrome");
          expect(persons.script.brands ?? []).not.toContain("HeadlessChrome");
        } finally {
          await profiles.stop("bot-identity");
          if (tab)
            await api("/browser/tabs", { action: "close", tabId: tab.id });
        }
      },
      60_000,
    );

    test("closes, opens nothing until asked, and opens again with the Recorder", async () => {
      expect(await api("/browser/close", {})).toEqual({
        status: 200,
        json: { open: false, tabs: [] },
      });
      expect((await state()).open).toBe(false);
      expect((await api("/browser/recording", { action: "stop" })).status).toBe(
        409,
      );
      // Nothing but an open starts it: the live screen asking for its page finds it closed.
      await expect(profiles.page(PERSON)).rejects.toThrow("not open");
      expect(profiles.isLive(PERSON)).toBe(false);
      // Nor does a disconnect: a closed browser answers that it is closed and stays closed.
      expect(await api("/browser/disconnect", {})).toEqual({
        status: 200,
        json: { open: false, tabs: [] },
      });
      expect(profiles.isLive(PERSON)).toBe(false);

      // Loaded again at the next launch, which a DevTools load needs, and still connected.
      const reopened = await api("/browser/open", { connection: CONNECTION });
      expect(reopened.status).toBe(200);
      expect((reopened.json as BrowserState).recorder?.connected).toBe(true);
    }, 60_000);

    test("stays open while its one window shows a page of the Recorder's own, and opening it again relaunches nothing", async () => {
      const person = profiles.person(PERSON);
      if (!person) throw new Error("The browser should be open.");
      const { context } = person;
      const own = await context.newPage();
      await own.goto(`chrome-extension://${person.recorderId}/options.html`);
      for (const page of person.pages()) await page.close();
      await wait(500);

      // A window on the screen is an open browser, whatever it shows.
      const now = await state();
      expect(now.open).toBe(true);
      expect(now.tabs).toEqual([]);
      expect(own.isClosed()).toBe(false);

      // Opening it again is the same browser, connected again: nothing closed and nothing relaunched.
      const connects = callsFor("connect").length;
      const again = await api("/browser/open", { connection: CONNECTION });
      expect(again.status).toBe(200);
      expect((again.json as BrowserState).open).toBe(true);
      expect(callsFor("connect")).toHaveLength(connects + 1);
      expect(own.isClosed()).toBe(false);
      expect(profiles.person(PERSON)?.context).toBe(context);

      // A tab of the person's goes in front of it, and the browser stays open when it closes.
      const tab = await api("/browser/tabs", {
        action: "new",
        url: `${ORIGIN}/page/back`,
      });
      expect(activeTab(tab.json as BrowserState)?.title).toBe("back");
      await own.close();
      await wait(300);
      expect(activeTab(await state())?.title).toBe("back");
    }, 60_000);

    test("is closed when the person closes its last window", async () => {
      const person = profiles.person(PERSON);
      if (!person) throw new Error("The browser should be open.");
      for (const page of person.pages()) await page.close();
      await until(
        async () => !(await state()).open,
        "the browser to count as closed",
      );
      expect(profiles.isLive(PERSON)).toBe(false);
    }, 30_000);
  });
}

describe.skipIf(!asked)("among Bots' browsers on one computer", () => {
  let root = "";
  let profiles: Profiles;
  let server: ReturnType<typeof Bun.serve>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // Read when the module loads, so a fresh copy of it is loaded with these set.
    for (const [name, value] of [
      ["COMPUTER_BROWSER_IDLE_MS", "1"],
      ["COMPUTER_MAX_BROWSERS", "2"],
    ] as const) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    root = await mkdtemp(join(tmpdir(), "openbot-person-cap-"));
    const built = await harness(VARIANTS[0]!.runtime, root, "cap");
    profiles = built.profiles;
    server = serve(built.host);
    const opening = await fetch(
      `http://127.0.0.1:${server.port}/browser/open`,
      {
        method: "POST",
        headers: { "x-openbot-bot-id": PERSON },
        body: JSON.stringify({ connection: CONNECTION }),
      },
    );
    expect(opening.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server?.stop(true);
    await profiles?.closeAll();
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  test("the idle sweep closes a Bot's browser and never the person's", async () => {
    await profiles.page("bot-idle");
    await wait(20);
    await profiles.sweepIdleNow();
    expect(profiles.isLive("bot-idle")).toBe(false);
    expect(profiles.isLive(PERSON)).toBe(true);
  }, 60_000);

  test("the cap closes Bots' browsers before the person's", async () => {
    // The person's browser is the least recently used of the three, and the cap is two.
    await profiles.page("bot-first");
    await profiles.page("bot-second");
    expect(profiles.isLive(PERSON)).toBe(true);
    expect(profiles.isLive("bot-first")).toBe(false);
    expect(profiles.isLive("bot-second")).toBe(true);
  }, 60_000);
});
