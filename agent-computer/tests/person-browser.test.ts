import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type {
  BrowserState,
  LauncherConnection,
} from "../../shared/openbot-browser";
import { RECORDER_SIGNED_OUT } from "../../shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "../../shared/recorder-extension";
import type { BrowserHost } from "../src/browser-host";
import type { BrowserRuntime } from "../src/browser-runtime";
import {
  defaultNativeMessagingHosts,
  type InstalledBrowser,
  installedBrowser,
  PLAYWRIGHT_DEFAULTS_A_PERSON_DOES_NOT_GET,
  PLAYWRIGHT_DISABLED_FEATURES,
} from "../src/person-launch";
import type { Profiles } from "../src/profiles";
import { startScreencast } from "../src/screencast";
import { setWebBotAuth } from "../src/web-bot-auth";

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
const OTHER_PINNED = "ghbmnnjooekpmoecnnnilnnbdlolhkhi";
const PERSON = "person-0123456789abcdef0123456789abcdef";

type FixtureCall = {
  method: string;
  input: unknown;
  tabs: string[];
  front: string;
  microphone: string;
  setupOpened: boolean;
  /** Which build of the fixture's worker script answered. */
  build: string;
};

const calls: FixtureCall[] = [];
/** Recorder tokens OpenBot has revoked, which it answers are signed out. */
const revoked = new Set<string>();

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
        // Who a Recorder connection is for, as OpenBot answers it: signed out once it was revoked.
        if (url.pathname === "/api/recorder/me") {
          const token = (request.headers.get("authorization") ?? "").replace(
            /^Bearer /,
            "",
          );
          return revoked.has(token)
            ? Response.json(
                {
                  error:
                    "This browser is no longer connected to OpenBot. Connect it again.",
                  code: RECORDER_SIGNED_OUT,
                  reason: "revoked",
                },
                { status: 401 },
              )
            : Response.json({ user: CONNECTION.user });
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

/**
 * The browser's own process, found by the profile it runs on: the one with no `--type`, which its renderers, GPU and
 * utility processes all have. That process answers DevTools, so stopping it is a browser that does not answer.
 */
async function browserProcess(profile: string): Promise<number> {
  const listing = Bun.spawnSync(["ps", "-axo", "pid=,command="]);
  const found = listing.stdout
    .toString()
    .split("\n")
    .filter(
      (line) =>
        line.includes(`--user-data-dir=${profile}`) &&
        !line.includes("--type="),
    )
    .map((line) => Number.parseInt(line.trim(), 10));
  if (found.length !== 1)
    throw new Error(
      `Expected one browser on ${profile}, found ${found.length}.`,
    );
  return found[0] as number;
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
          // Pinned once per earlier launch, as the end-to-end run's desktop profile was, beside
          // another extension's pin.
          extensions: {
            pinned_extensions: [
              RECORDER_EXTENSION_ID,
              OTHER_PINNED,
              RECORDER_EXTENSION_ID,
              RECORDER_EXTENSION_ID,
            ],
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
      // No connection at all is the contract's (an open that leaves the Recorder its own); a misnamed one is not.
      expect(
        (await api("/browser/open", { connections: CONNECTION })).status,
      ).toBe(400);
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

    test.skipIf(variant.window !== "native")(
      "tabs behind the one in front are behind it, as in any browser, and the tab the person brings to front is the one OpenBot acts on",
      async () => {
        // The fifth end-to-end run: every tab of the Desktop window said it was visible and focused,
        // background ones included, so sites behind the tab in front behaved as if in front, and
        // OpenBot could not tell which tab the person had in front: it named and navigated another.
        const person = profiles.person(PERSON);
        if (!person) throw new Error("The browser should be open.");
        const behind = activeTab(
          (
            await api("/browser/tabs", {
              action: "new",
              url: `${ORIGIN}/page/behind`,
            })
          ).json as BrowserState,
        );
        const front = activeTab(
          (
            await api("/browser/tabs", {
              action: "new",
              url: `${ORIGIN}/page/front`,
            })
          ).json as BrowserState,
        );
        if (!behind || !front) throw new Error("Both tabs should be listed.");
        const tab = (path: string) => {
          const page = person
            .pages()
            .find((candidate) =>
              candidate.url().startsWith(`${ORIGIN}${path}`),
            );
          if (!page) throw new Error(`No tab shows ${path}.`);
          return page;
        };
        const seen = (page: Page) =>
          page.evaluate(() => ({
            visibility: document.visibilityState,
            focused: document.hasFocus(),
          }));
        const inFront = { visibility: "visible", focused: true } as const;
        const atTheBack = { visibility: "hidden", focused: false } as const;
        try {
          expect(await seen(tab("/page/front"))).toEqual(inFront);
          expect(await seen(tab("/page/behind"))).toEqual(atTheBack);
          // Still behind once it has gone somewhere else, which is a new document in the same tab.
          await tab("/page/behind").goto(`${ORIGIN}/page/behind-again`);
          expect(await seen(tab("/page/behind-again"))).toEqual(atTheBack);

          // The person brings it to front in the window itself, which OpenBot is not told of.
          await person.session.send("Target.activateTarget", {
            targetId: behind.id,
          });
          await until(
            async () => activeTab(await state())?.id === behind.id,
            "OpenBot to name the tab the person has in front",
          );
          expect(await seen(tab("/page/behind-again"))).toEqual(inFront);
          expect(await seen(tab("/page/front"))).toEqual(atTheBack);
          // And what OpenBot does next acts on that tab, not the one it opened last.
          const went = (
            await api("/browser/navigate", { url: `${ORIGIN}/page/went` })
          ).json as BrowserState;
          expect(went.tabs.find((each) => each.id === behind.id)?.url).toBe(
            `${ORIGIN}/page/went`,
          );
          expect(went.tabs.find((each) => each.id === front.id)?.url).toBe(
            `${ORIGIN}/page/front`,
          );
        } finally {
          for (const id of [behind.id, front.id])
            await api("/browser/tabs", { action: "close", tabId: id });
        }
      },
      60_000,
    );

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

    /*
     * A browser that stops answering DevTools: in the end-to-end run a key forwarded to the person's Chromium on macOS
     * left its main thread spinning, and the state route waited for it as long as OpenBot did, 45 s, after OpenBot's own
     * server had closed the person's request with an empty reply at 10. The Browser page had nothing to show and no
     * sentence, and the sidebar lost its Browser button. Stopped here with SIGSTOP, which is the same browser from
     * outside: alive, connected, and silent.
     */
    test("a browser that stops answering is said to be, within seconds, and is shown again once it answers", async () => {
      expect(
        (await api("/browser/open", { connection: CONNECTION })).status,
      ).toBe(200);
      const pid = await browserProcess(join(root, PERSON));
      const warned = spyOn(console, "warn");
      process.kill(pid, "SIGSTOP");
      try {
        const asking = Date.now();
        const silent = await fetch(
          `http://127.0.0.1:${server.port}/browser/state`,
          {
            headers: { "x-openbot-bot-id": PERSON },
            // Well short of OpenBot's own server closing the person's request, at 10 s.
            signal: AbortSignal.timeout(8_000),
          },
        );
        expect(silent.status).toBe(504);
        expect(await silent.json()).toEqual({
          error: "The browser did not answer within 5 s.",
        });
        expect(Date.now() - asking).toBeLessThan(7_000);
        // Asked again while it is still silent: the same answer, and said once in the log, not once a second.
        expect((await api("/browser/state")).status).toBe(504);
        const said = warned.mock.calls.filter((call) =>
          String(call[0]).includes("computer-browser-not-answering"),
        );
        expect(said).toHaveLength(1);
      } finally {
        process.kill(pid, "SIGCONT");
        warned.mockRestore();
      }
      const back = await until(async () => {
        const answer = await api("/browser/state");
        return answer.status === 200
          ? (answer.json as BrowserState)
          : undefined;
      }, "the browser to answer again");
      expect(back.open).toBe(true);
      expect(back.tabs.length).toBeGreaterThan(0);
    }, 60_000);

    test("launches with the Recorder and nothing that makes it a test browser", async () => {
      const person = profiles.person(PERSON);
      if (!person) throw new Error("The browser should be open.");
      const page = await person.context.newPage();
      try {
        // What Google's sign-in refuses a browser for, false at the source in both.
        await page.goto(`${ORIGIN}/page/webdriver`);
        expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
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
      "a Bot's browser beside it has a Recorder of its own, which the person's connection never reaches",
      async () => {
        // A Bot's browser takes the Recorder from OPENBOT_RECORDER_DIR at its launch, as this computer's do
        // (`shared/bot-browser.ts`), and keeps it disconnected until a person holding its wheel records.
        const previous = process.env.OPENBOT_RECORDER_DIR;
        process.env.OPENBOT_RECORDER_DIR = FIXTURE;
        try {
          const page = await profiles.page("bot-beside");
          const bot = profiles.bot("bot-beside");
          if (!bot?.recorder)
            throw new Error("The Bot's Recorder should be in it.");
          expect(await bot.recorder.launcher.state()).toMatchObject({
            connected: false,
            phase: "idle",
          });
          // The person's is connected, in their own browser, and theirs alone.
          expect((await state()).recorder).toMatchObject({
            connected: true,
            userId: "user-1",
          });
          const switches = await commandLine(page);
          expect(switches).toContain(`--load-extension=${FIXTURE}`);
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

    test.skipIf(variant.window !== "screen")(
      "never signs a person's requests as the deployment's Bot, though a Bot's browser beside it does",
      async () => {
        // Web Bot Auth tells a site the request comes from this deployment's automated agent. A
        // person browsing in their own browser is not that agent, whatever the computer does for Bots.
        const person = profiles.person(PERSON);
        if (!person) throw new Error("The browser should be open.");
        const jwk = generateKeyPairSync("ed25519").privateKey.export({
          format: "jwk",
        });
        const headersAt = async (page: Page) => {
          await page.goto(`${ORIGIN}/headers`);
          return JSON.parse(
            await page.evaluate(() => document.body.innerText),
          ) as Record<string, string>;
        };
        const tab = activeTab(
          (await api("/browser/tabs", { action: "new" })).json as BrowserState,
        );
        await setWebBotAuth({ agent: "https://openbot.example.com", jwk });
        try {
          const bots = await headersAt(await profiles.page("bot-signed"));
          const persons = await headersAt(person.active());
          expect(bots["signature-agent"]).toBeTruthy();
          expect(bots.signature).toBeTruthy();
          expect(persons["signature-agent"]).toBeUndefined();
          expect(persons.signature).toBeUndefined();
          expect(persons["signature-input"]).toBeUndefined();
        } finally {
          await setWebBotAuth(null);
          await profiles.stop("bot-signed");
          if (tab)
            await api("/browser/tabs", { action: "close", tabId: tab.id });
        }
      },
      60_000,
    );

    test("says the page in front changed when a tab closes, and not for every tab as the browser closes", async () => {
      // The fifth end-to-end run: after a close, both computers logged `computer-page-changed` for
      // each tab as it went.
      const said = spyOn(console, "info");
      const pageChanges = () =>
        said.mock.calls.filter(([line]) =>
          String(line).includes('"computer-page-changed"'),
        ).length;
      try {
        for (const name of ["one", "two", "three"])
          await api("/browser/tabs", {
            action: "new",
            url: `${ORIGIN}/page/${name}`,
          });
        // The browser stays open while the tab in front closes: the one now in front is a change.
        const three = activeTab(await state());
        if (!three) throw new Error("A tab should be in front.");
        const before = pageChanges();
        await api("/browser/tabs", { action: "close", tabId: three.id });
        await until(() => pageChanges() > before, "the page change");

        const closing = pageChanges();
        expect((await api("/browser/close", {})).json).toEqual({
          open: false,
          tabs: [],
        });
        await wait(1_000);
        expect(pageChanges()).toBe(closing);

        // Nor when the person quits the browser themselves, which closes its tabs one by one too.
        await api("/browser/open", { connection: CONNECTION });
        for (const name of ["four", "five", "six"])
          await api("/browser/tabs", {
            action: "new",
            url: `${ORIGIN}/page/${name}`,
          });
        await wait(1_000);
        const quitting = pageChanges();
        const person = profiles.person(PERSON);
        if (!person) throw new Error("The browser should be open.");
        await person.session.send("Browser.close").catch(() => undefined);
        await until(
          () => !profiles.isLive(PERSON),
          "the browser to count as closed",
        );
        await wait(1_000);
        expect(pageChanges()).toBe(quitting);
      } finally {
        said.mockRestore();
        await api("/browser/open", { connection: CONNECTION });
      }
    }, 60_000);

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

    /*
     * OpenBot keeps a connection that stands rather than making one at every open: in the end-to-end run each visit to
     * the Browser page revoked the browser's connection and made another, a `recorder.revoked` and a `recorder.connected`
     * row each time. So an open that brings no connection leaves the Recorder holding its own, and says which it holds
     * (`recorder.connectionId`), for OpenBot to decide whether it stands.
     */
    test("an open that brings no connection leaves the Recorder the one it holds, open, and closed and opened again", async () => {
      const held = {
        connected: true,
        userId: "user-1",
        connectionId: "connection-1",
      };
      expect(
        (await api("/browser/open", { connection: CONNECTION })).status,
      ).toBe(200);
      const connects = callsFor("connect").length;

      const again = await api("/browser/open", {});
      expect(again.status).toBe(200);
      expect((again.json as BrowserState).recorder).toMatchObject(held);

      // Closed, then opened with no connection: the Recorder kept its own in the profile, as it keeps it in its storage.
      expect((await api("/browser/close", {})).status).toBe(200);
      const relaunched = await api("/browser/open", {});
      expect(relaunched.status).toBe(200);
      expect((relaunched.json as BrowserState).open).toBe(true);
      expect((relaunched.json as BrowserState).recorder).toMatchObject(held);
      // Never handed a connection by either.
      expect(callsFor("connect")).toHaveLength(connects);
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

    test("after several launches the Recorder is pinned once at most, and other pins stay", async () => {
      // Written by the browser as it closed, so read once it has finished writing.
      const pinned = await until(async () => {
        const preferences = JSON.parse(
          await readFile(join(root, PERSON, "Default", "Preferences"), "utf8"),
        ) as { extensions?: { pinned_extensions?: string[] } };
        return preferences.extensions?.pinned_extensions;
      }, "the profile's pins");
      expect(
        pinned.filter((id) => id === RECORDER_EXTENSION_ID).length,
      ).toBeLessThanOrEqual(1);
      expect(pinned).toContain(OTHER_PINNED);
    }, 30_000);
  });
}

/**
 * A Recorder rebuilt since the profile last ran one. The browser kept the worker it registered first,
 * with its script cached in the profile, and ran it at every later launch, so no Recorder fix reached
 * a browser that had run an earlier Recorder. Build A runs, the browser closes, build B (one line
 * different) is put where A was, and the same profile opens again: B is what answers, and a third
 * launch of an unchanged B reloads nothing.
 */
for (const variant of VARIANTS) {
  describe.skipIf(!asked || !variant.available)(
    `${variant.name}: a Recorder rebuilt since the profile last ran it`,
    () => {
      let root = "";
      let profiles: Profiles | undefined;
      let server: ReturnType<typeof Bun.serve> | undefined;

      afterAll(async () => {
        server?.stop(true);
        await profiles?.closeAll();
        if (root) await rm(root, { recursive: true, force: true });
      }, 60_000);

      test("runs at the next launch of the same profile", async () => {
        root = await mkdtemp(join(tmpdir(), "openbot-person-rebuilt-"));
        const recorder = join(root, "recorder");
        await cp(FIXTURE, recorder, { recursive: true });
        const worker = join(recorder, "service-worker.js");
        const fixture = await readFile(worker, "utf8");
        const build = (name: string) =>
          writeFile(
            worker,
            fixture.replace(
              'const BUILD = "fixture";',
              `const BUILD = "${name}";`,
            ),
          );

        const { createProfiles } = (await import(
          `../src/profiles?rebuilt=${variant.window}`
        )) as typeof import("../src/profiles");
        const { createBrowserHost } = await import("../src/browser-host");
        profiles = createProfiles(join(root, "profiles"), () => undefined, {
          runtime: variant.runtime,
        });
        opened.push(profiles);
        const routes = serve(
          createBrowserHost({
            profiles,
            recorderDir: () => recorder,
            navigationTimeoutMs: 15_000,
          }),
        );
        server = routes;
        const said = spyOn(console, "info");
        const reloads = () =>
          said.mock.calls.filter(([line]) =>
            String(line).includes("computer-recorder-reloaded"),
          ).length;
        const openAndClose = async () => {
          const from = calls.length;
          const opening = await fetch(
            `http://127.0.0.1:${routes.port}/browser/open`,
            {
              method: "POST",
              headers: { "x-openbot-bot-id": PERSON },
              body: JSON.stringify({ connection: CONNECTION }),
            },
          );
          expect(opening.status).toBe(200);
          const connect = calls
            .slice(from)
            .find((call) => call.method === "connect");
          await fetch(`http://127.0.0.1:${routes.port}/browser/close`, {
            method: "POST",
            headers: { "x-openbot-bot-id": PERSON },
          });
          return connect?.build;
        };
        try {
          await build("A");
          expect(await openAndClose()).toBe("A");
          expect(reloads()).toBe(0);

          await build("B");
          expect(await openAndClose()).toBe("B");
          expect(reloads()).toBe(1);

          // Current now, so the next launch leaves its worker alone.
          expect(await openAndClose()).toBe("B");
          expect(reloads()).toBe(1);
        } finally {
          said.mockRestore();
        }
      }, 120_000);
    },
  );
}

/**
 * Opens that arrive together, and opens that fail.
 *
 * Every open carries the connection OpenBot minted for it, and minting one revokes the one before:
 * OpenBot holds one connection per browser. The third end-to-end run: the Browser page, loaded again
 * while it was opening, sent a second open; the first open's connection, revoked by then, was handed
 * to the Recorder, which refused it; the computer closed the browser it had just launched, under the
 * second open too, and both answered 502. Neither the computer's log nor the server's said why.
 */
for (const variant of VARIANTS) {
  describe.skipIf(!asked || !variant.available)(
    `${variant.name}: opens that arrive together, and opens that fail`,
    () => {
      let root = "";
      let profiles: Profiles;
      let server: ReturnType<typeof Bun.serve>;
      let said: ReturnType<typeof spyOn<Console, "info">>;

      const openWith = (connection: LauncherConnection) =>
        fetch(`http://127.0.0.1:${server.port}/browser/open`, {
          method: "POST",
          headers: { "x-openbot-bot-id": PERSON },
          body: JSON.stringify({ connection }),
        });
      const close = () =>
        fetch(`http://127.0.0.1:${server.port}/browser/close`, {
          method: "POST",
          headers: { "x-openbot-bot-id": PERSON },
        });
      /** What the computer logged of `type` since the spy was last cleared. */
      const logged = (type: string) =>
        said.mock.calls.flatMap(([line]) => {
          try {
            const parsed = JSON.parse(String(line)) as Record<string, unknown>;
            return parsed.type === type ? [parsed] : [];
          } catch {
            return [];
          }
        });
      const connection = (name: string): LauncherConnection => ({
        ...CONNECTION,
        token: `obr_${name}-${variant.window}`,
        connectionId: `connection-${name}`,
      });

      beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "openbot-person-together-"));
        const built = await harness(
          variant.runtime,
          root,
          `together-${variant.window}`,
        );
        profiles = built.profiles;
        server = serve(built.host);
        said = spyOn(console, "info");
      }, 30_000);

      afterAll(async () => {
        said?.mockRestore();
        server?.stop(true);
        await profiles?.closeAll();
        if (root) await rm(root, { recursive: true, force: true });
      }, 60_000);

      test("two opens at once both open the browser, and its Recorder holds the newer connection", async () => {
        const first = connection("first");
        const second = connection("second");
        const from = calls.length;
        const opening = openWith(first);
        // The second open's connection is minted while the first is opening, which revokes the first's.
        await wait(50);
        revoked.add(first.token);
        const answers = await Promise.all([opening, openWith(second)]);
        expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
        const opened = (await answers[1]?.json()) as BrowserState;
        expect(opened.open).toBe(true);
        expect(opened.recorder).toMatchObject({
          connected: true,
          userId: "user-1",
        });
        // The Recorder was handed the newer connection, and never the revoked one.
        const taken = calls
          .slice(from)
          .filter((call) => call.method === "connect")
          .map(
            (call) =>
              (call.input as { connection: LauncherConnection }).connection
                .token,
          );
        expect(taken.length).toBeGreaterThan(0);
        expect(new Set(taken)).toEqual(new Set([second.token]));
        expect(profiles.isLive(PERSON)).toBe(true);
        expect(logged("computer-browser-open-failed")).toEqual([]);
        await close();
      }, 60_000);

      test("an open whose connection OpenBot revoked says why and at which step, and closes the browser it launched", async () => {
        said.mockClear();
        const refused = connection("revoked");
        revoked.add(refused.token);
        const answer = await openWith(refused);
        const sentence =
          "The Recorder could not be connected: OpenBot did not accept this browser's connection. Open the browser from OpenBot again.";
        expect(answer.status).toBe(502);
        expect(await answer.json()).toEqual({ error: sentence });
        expect(logged("computer-browser-open-failed")).toEqual([
          {
            type: "computer-browser-open-failed",
            botId: PERSON,
            step: "connect",
            status: 502,
            error: sentence,
            ms: expect.any(Number),
          },
        ]);
        expect(logged("computer-browser-closed")).toEqual([
          {
            type: "computer-browser-closed",
            botId: PERSON,
            reason: "its Recorder could not be connected",
          },
        ]);
        expect(profiles.isLive(PERSON)).toBe(false);
      }, 60_000);

      test.skipIf(variant.window !== "native")(
        "an open that cannot start the browser says so, at the launch",
        async () => {
          // Another browser holds the profile, as one of the person's own might after a crash: Chrome
          // refuses a second process on one profile.
          const { chromium } = await import("playwright");
          const holder = await chromium.launchPersistentContext(
            join(root, PERSON),
            { channel: variant.product, headless: true },
          );
          said.mockClear();
          try {
            const answer = await openWith(connection("held"));
            // Not the computer's setup: the person is told in a sentence of their own, and the
            // browser's own words for why it would not start stay in the log.
            expect(answer.status).toBe(502);
            expect(await answer.json()).toEqual({
              error: "Your browser could not be opened. Try again.",
            });
            expect(logged("computer-browser-open-failed")).toEqual([
              {
                type: "computer-browser-open-failed",
                botId: PERSON,
                step: "launch",
                status: 502,
                error: expect.stringContaining(
                  "Failed to create a ProcessSingleton for your profile directory",
                ),
                ms: expect.any(Number),
              },
            ]);
            expect(profiles.isLive(PERSON)).toBe(false);
          } finally {
            await holder.close();
          }
        },
        60_000,
      );
    },
  );
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
    await open();
  }, 60_000);

  /** The person opens their cloud browser, as the Browser page does. */
  async function open() {
    const opening = await fetch(
      `http://127.0.0.1:${server.port}/browser/open`,
      {
        method: "POST",
        headers: { "x-openbot-bot-id": PERSON },
        body: JSON.stringify({ connection: CONNECTION }),
      },
    );
    expect(opening.status).toBe(200);
  }

  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server?.stop(true);
    await profiles?.closeAll();
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  /*
   * A cloud browser, shown on the Browser page, takes the Bots' own rule. It used to be exempt: an abandoned Browser
   * tab kept a root, sandbox-less Chromium running for ever, and the cap closed Bots' browsers first.
   */
  test("the cap closes whichever browser was used longest ago, the person's cloud browser among them", async () => {
    // The person's browser is the least recently used of the three, and the cap is two.
    await profiles.page("bot-first");
    await profiles.page("bot-second");
    expect(profiles.isLive(PERSON)).toBe(false);
    expect(profiles.isLive("bot-first")).toBe(true);
    expect(profiles.isLive("bot-second")).toBe(true);
  }, 60_000);

  test("the idle sweep closes a person's cloud browser nobody has touched, as it closes a Bot's", async () => {
    await open();
    await profiles.page("bot-idle");
    await wait(20);
    await profiles.sweepIdleNow();
    expect(profiles.isLive("bot-idle")).toBe(false);
    expect(profiles.isLive(PERSON)).toBe(false);
    // Opened again from the same profile, as a Bot's browser starts again where it left off.
    await open();
    expect(profiles.isLive(PERSON)).toBe(true);
  }, 60_000);
});
