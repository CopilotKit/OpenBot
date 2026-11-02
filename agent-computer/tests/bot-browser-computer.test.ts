import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotBrowserState } from "../../shared/bot-browser";
import type { ComputerControlState } from "../../shared/computer-control";
import type { LauncherConnection } from "../../shared/openbot-browser";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../../server/src/audit";
import type {
  AppVariables,
  AuthenticatedActor,
} from "../../server/src/auth/guards";
import { createComputerGateway } from "../../server/src/computer/gateway";
import type { PolicyStore } from "../../server/src/computer/policy-store";
import type { ComputerProvider } from "../../server/src/computer/provider";
import { createComputerRoutes } from "../../server/src/computer/routes";
import {
  NOT_ITS_OWN_COMPUTER,
  NOT_ITS_OWN_COMPUTER_RECORD,
} from "../src/person-access";

/**
 * A Bot's browser worked by a person, through the computer itself: the real process, its token, its dispatcher, its
 * control and the Bot's own routes, with bundled Chromium headless and the fixture Recorder (`fixtures/recorder`),
 * which reports every call it receives to the OpenBot it was connected to, so what these tests read about the
 * Recorder is the Recorder's side of each call.
 *
 * What it pins: the Bot works as it did with the Recorder in its browser; the bar and Record refuse anyone without the
 * wheel; a recording starts only for the person holding it; and the computer ends the recording, then disconnects the
 * Recorder, whenever the wheel leaves them.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/bot-browser-computer.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const TOKEN = "bot-browser-computer-token";
const BOT = "sales-bot";
const PERSON = "person-fedcba9876543210fedcba9876543210";
const FIXTURE = join(import.meta.dir, "fixtures", "recorder");

type FixtureCall = {
  method: string;
  input: unknown;
  front: string;
  /** Whether the last of a stopped recording was still on its way to Intelligence when the call came. */
  sending?: boolean;
};
const calls: FixtureCall[] = [];
/** How long the last of a stopped recording takes to reach Intelligence, as this OpenBot tells the fixture Recorder. */
let tailMs = 0;

type Computer = { base: string; child: ReturnType<typeof Bun.spawn> };
const computers: Computer[] = [];
let root = "";
let site: ReturnType<typeof Bun.serve> | undefined;
let origin = "";

async function freePort(): Promise<number> {
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

async function startComputer(
  name: string,
  env: Record<string, string>,
): Promise<Computer> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      // No API server pushes this computer a network policy, so it browses before one arrives.
      EGRESS_POLICY_REQUIRED: "0",
      PROFILES_DIR: join(root, name, "profiles"),
      WORKSPACE_DIR: join(root, name, "workspace"),
      ...env,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const computer = { base, child };
  computers.push(computer);
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`The computer exited with ${child.exitCode}.`);
    const ready = await fetch(`${base}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return computer;
    if (Date.now() > deadline) throw new Error("The computer did not start.");
    await Bun.sleep(50);
  }
}

let computer: Computer;

async function call<T = Record<string, unknown>>(
  path: string,
  options: { body?: unknown; botId?: string; on?: Computer } = {},
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${(options.on ?? computer).base}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": options.botId ?? BOT,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
}

const page = (name: string) => `${origin}/page/${name}`;
const state = async (on?: Computer) =>
  (await call<BotBrowserState>("/bot-browser/state", { on })).json;
const activeTab = (current: BotBrowserState) =>
  current.tabs.find((tab) => tab.active);
const callsFor = (method: string) =>
  calls.filter((each) => each.method === method);

const connection = (): LauncherConnection => ({
  openbotUrl: origin,
  token: "obr_bot-browser-fixture",
  connectionId: "connection-bot-1",
  user: { id: "user-1", name: "Pat Example", email: "pat@example.com" },
});

/** Ask for help and take the wheel as `by`, as the server does for the signed-in person. */
async function takeWheel(by: string, on?: Computer): Promise<string> {
  const asked = await call<ComputerControlState>("/control/request", {
    body: { reason: "I want to take control of the browser." },
    on,
  });
  const requestId = asked.json.request?.id;
  if (!requestId) throw new Error("The request was not raised.");
  const taken = await call<ComputerControlState>("/control/take", {
    body: { requestId, by },
    on,
  });
  expect(taken.status).toBe(200);
  return requestId;
}

const start = (by: string, title = "File an expense report", on?: Computer) =>
  call<BotBrowserState>("/bot-browser/recording", {
    body: { action: "start", title, by, connection: connection() },
    on,
  });

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "openbot-bot-browser-computer-"));
  // The OpenBot the fixture Recorder reports to, and the pages the Bot and the person browse.
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture/calls") {
        calls.push((await request.json()) as FixtureCall);
        return new Response("");
      }
      if (url.pathname === "/api/recorder/me")
        return Response.json({ user: connection().user });
      if (url.pathname === "/fixture/tail")
        return Response.json({ ms: tailMs });
      // A cookie kept for an hour, as a site keeps a sign-in: it outlives the browser closing.
      if (url.pathname === "/set-cookie")
        return new Response("<!doctype html><title>set</title>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "set-cookie": "signed-in=yes; Max-Age=3600; Path=/",
          },
        });
      // The cookies the browser sent, as the page's title.
      if (url.pathname === "/cookies")
        return new Response(
          `<!doctype html><title>cookies:${request.headers.get("cookie") ?? ""}</title>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      // Busy 20 ms on every key down, and writes every key it receives into its title, in the order it received them.
      if (url.pathname === "/keys")
        return new Response(
          '<!doctype html><title>none</title><input autofocus><script>const seen=[];const show=e=>{seen.push(e.type.slice(3)+":"+e.key);document.title=seen.join(" ")};addEventListener("keydown",e=>{const until=Date.now()+20;while(Date.now()<until){}show(e)});addEventListener("keyup",show)</script>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      // A form a Bot fills part of and hands to a person for the rest: a field, a dropdown and an editor.
      if (url.pathname === "/contact")
        return new Response(
          '<!doctype html><title>Contact</title><label>Name <input name="name"></label><label>Telephone <input name="tel"></label><label>Size <select name="size"><option>Small</option><option>Large</option></select></label><div role="textbox" aria-label="Notes" contenteditable="true"></div>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      const name = url.pathname.split("/").at(-1) || "home";
      return new Response(
        `<!doctype html><title>${name}</title><label>Amount <input name="amount" autofocus></label>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  origin = `http://127.0.0.1:${site.port}`;
  // A Bot's own computer, as a supervisor starts each container and a Sandbox each pod: Record runs only on one.
  computer = await startComputer("with-recorder", {
    OPENBOT_RECORDER_DIR: FIXTURE,
    COMPUTER_BOT_ID: BOT,
  });
}, 30_000);

afterAll(async () => {
  if (!asked) return;
  for (const running of computers) {
    for (const botId of [
      BOT,
      "other-bot",
      "source-bot",
      "typed-bot",
      "clear-bot",
    ])
      await call("/computers/stop", { body: {}, botId, on: running }).catch(
        () => undefined,
      );
    running.child.kill();
    await running.child.exited;
  }
  site?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!asked)(
  "a Bot's browser on a computer with the Recorder",
  () => {
    test("launches with the Recorder idle in it, and the Bot reads, snapshots and screenshots its own page as before", async () => {
      const navigated = await call<{ url: string; title: string }>(
        "/navigate",
        {
          body: { url: page("start") },
        },
      );
      expect(navigated.status).toBe(200);
      expect(navigated.json).toMatchObject({
        url: page("start"),
        title: "start",
      });

      const snapshot = await call<{
        url: string;
        elements: { role: string; name: string }[];
      }>("/snapshot", { body: {} });
      expect(snapshot.status).toBe(200);
      expect(snapshot.json.url).toBe(page("start"));
      expect(snapshot.json.elements).toContainEqual(
        expect.objectContaining({ role: "textbox", name: "Amount" }),
      );
      const screenshot = await call<{ url: string; base64: string }>(
        "/screenshot",
      );
      expect(screenshot.status).toBe(200);
      expect(screenshot.json.url).toBe(page("start"));
      expect(screenshot.json.base64.length).toBeGreaterThan(0);

      // One tab, the Bot's: the Recorder's setup page, which it opens at every install, never became one.
      const current = await state();
      expect(current.open).toBe(true);
      expect(current.tabs).toEqual([
        expect.objectContaining({
          url: page("start"),
          title: "start",
          active: true,
        }),
      ]);
      // Loaded and answering, connected to nobody, recording nothing.
      expect(current.recorder).toMatchObject({
        connected: false,
        phase: "idle",
      });
      expect(current.recordingBy).toBeUndefined();
      expect(calls).toEqual([]);
    }, 60_000);

    test("refuses a person's browser id: on a computer Bots share before any route, on the person's own at the Bot's", async () => {
      // A computer Bots run on runs no person's browser at all (person-access.ts), so the id goes no further than that.
      for (const [path, body] of [
        ["/bot-browser/state", undefined],
        ["/bot-browser/tabs", { action: "new" }],
      ] as const) {
        const refused = await call(path, { body, botId: PERSON });
        expect([path, refused.status, refused.json]).toEqual([
          path,
          503,
          { error: NOT_ITS_OWN_COMPUTER },
        ]);
      }
      // A person's own computer takes their id, and the Bot's routes still refuse it: their browser has its own routes.
      const own = await startComputer("persons-own", {
        OPENBOT_RECORDER_DIR: FIXTURE,
        COMPUTER_BOT_ID: PERSON,
      });
      for (const [path, body] of [
        ["/bot-browser/state", undefined],
        ["/bot-browser/tabs", { action: "new" }],
      ] as const)
        expect([
          path,
          (await call(path, { body, botId: PERSON, on: own })).status,
        ]).toEqual([path, 400]);
    }, 30_000);

    test("refuses Record on the computer every Bot shares, before the person's connection reaches the Bot's profile", async () => {
      const shared = await startComputer("shared", {
        OPENBOT_RECORDER_DIR: FIXTURE,
      });
      await takeWheel("user-1", shared);
      const before = calls.length;
      const refused = await start("user-1", "File an expense report", shared);
      expect([refused.status, refused.json]).toEqual([
        403,
        { error: NOT_ITS_OWN_COMPUTER_RECORD },
      ]);
      // The Recorder there was never handed the connection, nor asked to record.
      expect(calls.slice(before)).toEqual([]);
      // The bar is still the person's while they hold the wheel.
      expect(
        (
          await call("/bot-browser/navigate", {
            body: { url: page("shared") },
            on: shared,
          })
        ).status,
      ).toBe(200);
    }, 60_000);

    test("records on a person's own computer, where only their own Bots run", async () => {
      // How the supervisor and a Sandbox start a person's computer: named for the person, no Bot.
      const own = await startComputer("persons-computer", {
        OPENBOT_RECORDER_DIR: FIXTURE,
        COMPUTER_PERSON_ID: "user-1",
      });
      await takeWheel("user-1", own);
      const before = calls.length;
      const started = await start("user-1", "File an expense report", own);
      expect(started.status).toBe(200);
      expect(started.json.recordingBy).toBe("user-1");
      // The Recorder there was handed the person's connection and asked to record.
      expect(
        calls
          .slice(before)
          .map((each) => each.method)
          .filter((method) => method === "connect" || method === "record"),
      ).toEqual(["connect", "record"]);
      expect(
        (
          await call("/bot-browser/recording", {
            body: { action: "stop" },
            on: own,
          })
        ).status,
      ).toBe(200);
      // The fixture Recorder's calls are one list for the file; the tests after this one start from none.
      calls.length = 0;
    }, 60_000);

    test("refuses the bar, Record and narration while the Bot holds the wheel", async () => {
      for (const [path, body] of [
        ["/bot-browser/tabs", { action: "new", url: page("sneaky") }],
        ["/bot-browser/navigate", { url: page("sneaky") }],
        ["/bot-browser/navigate", { action: "back" }],
      ] as const)
        expect((await call(path, { body })).status).toBe(409);
      expect((await start("user-1")).status).toBe(409);
      expect(
        (await call("/bot-browser/recording", { body: { action: "stop" } }))
          .status,
      ).toBe(409);
      expect(
        (
          await call("/bot-browser/narration", {
            body: {
              text: "Here",
              startedAt: 1_760_000_000_000,
              endedAt: 1_760_000_000_500,
              sentAt: 1_760_000_001_000,
            },
          })
        ).status,
      ).toBe(409);
      // Nothing moved, and the Recorder was never handed anybody's connection.
      expect((await state()).tabs.map((tab) => tab.url)).toEqual([
        page("start"),
      ]);
      expect(calls).toEqual([]);
    });

    test("names the person who takes the wheel, and the bar then works for them, with the Bot following the tab they leave in front", async () => {
      const requestId = await takeWheel("user-1");
      const control = (await call<ComputerControlState>("/control")).json;
      expect(control).toMatchObject({ holder: "human", heldBy: "user-1" });

      const two = await call<BotBrowserState>("/bot-browser/tabs", {
        body: { action: "new", url: page("two") },
      });
      expect(two.status).toBe(200);
      expect(two.json.tabs).toHaveLength(2);
      expect(activeTab(two.json)).toMatchObject({
        url: page("two"),
        title: "two",
      });
      const first = two.json.tabs.find((tab) => tab.url === page("start"));
      const second = activeTab(two.json);
      if (!first || !second) throw new Error("Both tabs should be listed.");

      const switched = await call<BotBrowserState>("/bot-browser/tabs", {
        body: { action: "activate", tabId: first.id },
      });
      expect(activeTab(switched.json)?.id).toBe(first.id);
      // The Bot's page is the tab in front now: what it reads next is that tab.
      expect((await call<{ url: string }>("/read")).json.url).toBe(
        page("start"),
      );

      // The address bar, back, forward and reload, in the tab in front.
      const there = await call<BotBrowserState>("/bot-browser/navigate", {
        body: { url: page("three") },
      });
      expect(activeTab(there.json)).toMatchObject({
        id: first.id,
        url: page("three"),
      });
      const back = await call<BotBrowserState>("/bot-browser/navigate", {
        body: { action: "back" },
      });
      expect(activeTab(back.json)?.url).toBe(page("start"));
      const forward = await call<BotBrowserState>("/bot-browser/navigate", {
        body: { action: "forward" },
      });
      expect(activeTab(forward.json)?.url).toBe(page("three"));
      expect(
        (await call("/bot-browser/navigate", { body: { action: "reload" } }))
          .status,
      ).toBe(200);
      expect(
        (
          await call("/bot-browser/navigate", {
            body: { url: "javascript:alert(1)" },
          })
        ).status,
      ).toBe(400);

      const closed = await call<BotBrowserState>("/bot-browser/tabs", {
        body: { action: "close", tabId: second.id },
      });
      expect(closed.json.tabs.map((tab) => tab.id)).toEqual([first.id]);

      // Handed back: nobody is named, and the bar refuses again.
      expect(
        (await call("/control/release", { body: { requestId } })).status,
      ).toBe(200);
      expect(
        (await call<ComputerControlState>("/control")).json.heldBy,
      ).toBeUndefined();
      expect(
        (await call("/bot-browser/tabs", { body: { action: "new" } })).status,
      ).toBe(409);
      // And the Bot carries on in the tab the person left in front.
      expect((await call<{ url: string }>("/read")).json.url).toBe(
        page("three"),
      );
    }, 60_000);

    test("records the person holding the wheel and nobody else, narrates, and Stop ends it and disconnects the Recorder", async () => {
      const requestId = await takeWheel("user-1");
      calls.length = 0;
      // Somebody who does not hold the wheel cannot record, and the Recorder is never handed their connection.
      expect((await start("user-2")).status).toBe(409);
      expect(calls).toEqual([]);

      const started = await start("user-1");
      expect(started.status).toBe(200);
      expect(started.json.recordingBy).toBe("user-1");
      expect(started.json.recorder).toMatchObject({
        connected: true,
        userId: "user-1",
        phase: "recording",
        title: "File an expense report",
        narration: "external",
      });
      // The Recorder's side: connected with the person's connection for the app's narration, then recording the tab
      // the person has in front.
      expect(callsFor("connect").map((each) => each.input)).toEqual([
        { connection: connection(), narration: "external" },
      ]);
      const [record] = callsFor("record");
      expect(record?.input).toEqual({
        action: "start",
        title: "File an expense report",
      });
      expect(record?.front).toBe(activeTab(started.json)?.url ?? "missing");
      expect((await start("user-1", "Again")).status).toBe(409);

      const sentAt = 1_760_000_003_000;
      const phrase = {
        text: "This is where the receipts go",
        startedAt: 1_760_000_000_000,
        endedAt: 1_760_000_002_500,
      };
      expect(
        (await call("/bot-browser/narration", { body: { ...phrase, sentAt } }))
          .status,
      ).toBe(200);
      expect(
        (
          await call("/bot-browser/narration", {
            body: { speaking: true, since: 1_760_000_004_000, sentAt },
          })
        ).status,
      ).toBe(200);
      expect(callsFor("narrate").map((each) => each.input)).toEqual([phrase]);
      expect(callsFor("speaking").map((each) => each.input)).toEqual([
        { since: 1_760_000_004_000 },
      ]);
      expect((await state()).recordingBy).toBe("user-1");

      const stopped = await call<BotBrowserState>("/bot-browser/recording", {
        body: { action: "stop" },
      });
      expect(stopped.status).toBe(200);
      expect(stopped.json.recordingBy).toBeUndefined();
      // Whose it was, beside the recording the Recorder names, and still so when the bar is read again.
      expect(stopped.json.lastStoppedBy).toBe("user-1");
      expect((await state()).lastStoppedBy).toBe("user-1");
      expect(stopped.json.recorder).toMatchObject({
        connected: false,
        phase: "idle",
        lastStopped: {
          recordingId: started.json.recorder?.recordingId,
          title: "File an expense report",
        },
      });
      // Stopped, then disconnected, in that order.
      expect(calls.map((each) => each.method).slice(-2)).toEqual([
        "record",
        "disconnect",
      ]);
      expect(callsFor("record").at(-1)?.input).toEqual({ action: "stop" });
      expect(
        (
          await call("/bot-browser/narration", {
            body: { ...phrase, sentAt },
          })
        ).status,
      ).toBe(409);
      await call("/control/release", { body: { requestId } });
    }, 60_000);

    test("handing the wheel back ends the recording, then disconnects the Recorder, before the hand-back answers", async () => {
      const requestId = await takeWheel("user-1");
      expect((await start("user-1", "Handed back")).status).toBe(200);
      calls.length = 0;
      const released = await call<ComputerControlState>("/control/release", {
        body: { requestId },
      });
      expect(released.status).toBe(200);
      expect(calls.map((each) => each.method)).toEqual([
        "record",
        "disconnect",
      ]);
      expect(calls[0]?.input).toEqual({ action: "stop" });
      const after = await state();
      expect(after.recordingBy).toBeUndefined();
      expect(after.recorder).toMatchObject({
        connected: false,
        phase: "idle",
        lastStopped: { title: "Handed back" },
      });
      expect(after.lastStoppedBy).toBe("user-1");
    }, 60_000);

    test("a cancelled request ends the recording though the person still has the page, and they cannot start another", async () => {
      const requestId = await takeWheel("user-1");
      expect((await start("user-1", "Cancelled")).status).toBe(200);
      calls.length = 0;
      expect(
        (await call("/control/cancel", { body: { requestId } })).status,
      ).toBe(200);
      expect(calls.map((each) => each.method)).toEqual([
        "record",
        "disconnect",
      ]);
      expect((await state()).recordingBy).toBeUndefined();
      expect((await start("user-1", "After the cancel")).status).toBe(409);
      await call("/control/release", { body: { requestId } });
    }, 60_000);

    test("stopping the computer ends the recording while the Recorder can still be told", async () => {
      await takeWheel("user-1");
      expect((await start("user-1", "Stopped computer")).status).toBe(200);
      calls.length = 0;
      expect((await call("/computers/stop", { body: {} })).json).toMatchObject({
        stopped: true,
        wasRunning: true,
      });
      expect(calls.map((each) => each.method)).toEqual([
        "record",
        "disconnect",
      ]);
      expect(await state()).toEqual({ open: false, tabs: [] });
      expect(
        (await call<ComputerControlState>("/control")).json.heldBy,
      ).toBeUndefined();
    }, 60_000);
  },
);

describe.skipIf(!asked)("clearing a Bot's browser", () => {
  const botId = "clear-bot";
  const on = (path: string, body?: unknown) =>
    call<BotBrowserState>(path, { body, botId });
  const clear = (by: string) => on("/bot-browser/clear", { by });
  /** The cookies the Bot's browser sends, read by the Bot itself. */
  const botSees = async () =>
    (
      await call<{ title: string }>("/navigate", {
        body: { url: `${origin}/cookies` },
        botId,
      })
    ).json.title;
  /** The cookies the Bot's browser sends, read through the bar by the person holding the wheel. */
  const personSees = async () => {
    const there = await on("/bot-browser/navigate", {
      url: `${origin}/cookies`,
    });
    expect(there.status).toBe(200);
    return there.json.tabs.find((tab) => tab.active)?.title;
  };

  test("only the person holding the wheel clears it: their recording ends first, the profile goes and the Bot's files stay, and the browser starts fresh under them", async () => {
    // The Bot signs in somewhere (a cookie kept for an hour) and keeps a note in its files.
    expect(
      (
        await call("/navigate", {
          body: { url: `${origin}/set-cookie` },
          botId,
        })
      ).status,
    ).toBe(200);
    expect(await botSees()).toBe("cookies:signed-in=yes");
    expect(
      (
        await call("/files/write", {
          body: { path: "notes.md", contents: "Keep me." },
          botId,
        })
      ).status,
    ).toBe(200);

    // Never under the Bot, and never by someone who is only watching.
    expect((await clear("user-1")).status).toBe(409);
    const asked = await call<ComputerControlState>("/control/request", {
      body: { reason: "I want to take control of the browser." },
      botId,
    });
    const requestId = asked.json.request?.id;
    expect(
      (
        await call("/control/take", {
          body: { requestId, by: "user-1" },
          botId,
        })
      ).status,
    ).toBe(200);
    const refused = await clear("user-2");
    expect(refused.status).toBe(409);
    expect(refused.json as unknown).toEqual({
      error:
        "Only the person holding control of this Bot's browser can clear it. Take control first.",
    });
    expect(await personSees()).toBe("cookies:signed-in=yes");

    // A recording of theirs is running, and the last of it takes a moment to reach Intelligence after Stop.
    expect(
      (
        await on("/bot-browser/recording", {
          action: "start",
          title: "Before the clear",
          by: "user-1",
          connection: connection(),
        })
      ).status,
    ).toBe(200);
    tailMs = 1_500;
    calls.length = 0;
    const cleared = await clear("user-1");
    tailMs = 0;
    expect(cleared.status).toBe(200);
    // Stopped, waited for, and let go, before the browser was wiped.
    expect(calls.map((each) => each.method)).toEqual(["record", "disconnect"]);
    expect(calls[0]?.input).toEqual({ action: "stop" });
    expect(calls[1]?.sending).toBe(false);
    // Fresh: one empty tab, nothing recording, the Recorder in it again and connected to nobody.
    expect(cleared.json.open).toBe(true);
    expect(cleared.json.recordingBy).toBeUndefined();
    expect(cleared.json.tabs).toEqual([
      expect.objectContaining({ url: "about:blank", active: true }),
    ]);
    expect(cleared.json.recorder).toMatchObject({
      connected: false,
      phase: "idle",
    });
    // Still theirs: the wheel stayed with them, and the bar works the fresh browser.
    expect(
      (await call<ComputerControlState>("/control", { botId })).json,
    ).toMatchObject({
      holder: "human",
      heldBy: "user-1",
      recoveryRequired: false,
    });
    // Signed out: the cookie went with the profile, where only closing the browser would have kept it.
    expect(await personSees()).toBe("cookies:");
    // The Bot's files are its own, and stay.
    expect(
      await Bun.file(
        join(root, "with-recorder", "workspace", "notes.md"),
      ).text(),
    ).toBe("Keep me.");

    expect(
      (await call("/control/release", { body: { requestId }, botId })).status,
    ).toBe(200);
  }, 90_000);
});

describe.skipIf(!asked)("a person's keys on a Bot's live screen", () => {
  test("reach the page in the order they were typed, however long each takes to land", async () => {
    // Applying a key is a trip to the browser, and on a page busy 20 ms per key down, keys applied as each was ready
    // rather than one after another reached it with every key up of a word before any of its key downs.
    const botId = "other-bot";
    expect(
      (await call("/navigate", { body: { url: `${origin}/keys` }, botId }))
        .status,
    ).toBe(200);
    const asked = await call<ComputerControlState>("/control/request", {
      body: { reason: "I want to take control of the browser." },
      botId,
    });
    await call("/control/take", {
      body: { requestId: asked.json.request?.id, by: "user-1" },
      botId,
    });
    const socket = new WebSocket(
      `${computer.base.replace("http:", "ws:")}/stream?bot=${botId}&token=${TOKEN}`,
    );
    const errors: string[] = [];
    const casting = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          error?: string;
        };
        if (message.type === "frame") resolve();
        if (message.type === "error") errors.push(message.error ?? "");
      });
    });
    try {
      await casting;
      const typed = "abcdef";
      for (const key of typed) {
        const code = `Key${key.toUpperCase()}`;
        socket.send(
          JSON.stringify({ type: "key", event: "down", key, code, text: key }),
        );
        socket.send(JSON.stringify({ type: "key", event: "up", key, code }));
      }
      const expected = [...typed]
        .flatMap((key) => [`down:${key}`, `up:${key}`])
        .join(" ");
      let title = "";
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        title = (await call<{ title: string }>("/read", { botId })).json.title;
        if (title.split(" ").length >= expected.split(" ").length) break;
        await Bun.sleep(50);
      }
      expect(title).toBe(expected);
      expect(errors).toEqual([]);
    } finally {
      socket.close();
      await call("/control/release", {
        body: { requestId: asked.json.request?.id },
        botId,
      });
    }
  }, 60_000);
});

describe.skipIf(!asked)("what a person types while they hold the wheel", () => {
  type Snapshot = {
    snapshotId: number;
    elements: { ref: string; role: string; name: string; value?: string }[];
  };
  const snapshot = async (botId: string) =>
    (await call<Snapshot>("/snapshot", { body: {}, botId })).json;
  const field = (taken: Snapshot, name: string) =>
    taken.elements.find((element) => element.name === name);
  const FILLED = "[hidden: filled in by the person]";

  test("reaches the Bot as filled, never as what was typed, in its snapshot and its page text, until the Bot types there itself", async () => {
    // The run that found it: after a help step the Bot's next snapshot read `textbox "Telephone": 555-0100`, though
    // the person took over so they could enter what the Bot must not be told.
    const botId = "typed-bot";
    expect(
      (await call("/navigate", { body: { url: `${origin}/contact` }, botId }))
        .status,
    ).toBe(200);
    // The Bot fills the name itself: its own value, which it goes on reading.
    const before = await snapshot(botId);
    const name = field(before, "Name");
    if (!name) throw new Error("The form should have a Name field.");
    expect(
      (
        await call("/type", {
          body: {
            ref: name.ref,
            snapshotId: before.snapshotId,
            text: "Ada Lovelace",
          },
          botId,
        })
      ).status,
    ).toBe(200);

    const asked = await call<ComputerControlState>("/control/request", {
      body: { reason: "Enter the telephone number." },
      botId,
    });
    const requestId = asked.json.request?.id;
    await call("/control/take", { body: { requestId, by: "user-1" }, botId });
    const socket = new WebSocket(
      `${computer.base.replace("http:", "ws:")}/stream?bot=${botId}&token=${TOKEN}`,
    );
    const errors: string[] = [];
    const casting = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          error?: string;
        };
        if (message.type === "frame") resolve();
        if (message.type === "error") errors.push(message.error ?? "");
      });
    });
    const key = (key: string, code: string, windowsVirtualKeyCode: number) => {
      for (const event of ["down", "up"])
        socket.send(
          JSON.stringify({
            type: "key",
            event,
            key,
            code,
            windowsVirtualKeyCode,
          }),
        );
    };
    try {
      await casting;
      // From the name the Bot filled, on through the form as a person would: Tab, type, Tab, choose, Tab, type.
      key("Tab", "Tab", 9);
      socket.send(JSON.stringify({ type: "text", text: "555-0100" }));
      key("Tab", "Tab", 9);
      key("ArrowDown", "ArrowDown", 40);
      key("Tab", "Tab", 9);
      socket.send(JSON.stringify({ type: "text", text: "call after six" }));
      // Landed once the editor holds something, as the page's text says it either way.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const text = (await call<{ text: string }>("/read", { botId })).json
          .text;
        if (text.includes("call after six") || text.includes(FILLED)) break;
        if (Date.now() > deadline)
          throw new Error("The person's typing did not land.");
        await Bun.sleep(50);
      }
      expect(errors).toEqual([]);
    } finally {
      socket.close();
    }
    expect(
      (await call("/control/release", { body: { requestId }, botId })).status,
    ).toBe(200);

    // Back with the Bot: it reads that the person filled each, and never what with.
    const after = await snapshot(botId);
    expect(field(after, "Name")?.value).toBe("Ada Lovelace");
    expect(field(after, "Telephone")?.value).toBe(FILLED);
    expect(field(after, "Size")?.value).toBe(FILLED);
    expect(JSON.stringify(after)).not.toContain("555-0100");
    const read = (await call<{ text: string }>("/read", { botId })).json.text;
    expect(read).toContain(FILLED);
    expect(read).not.toContain("call after six");
    expect(read).not.toContain("555-0100");
    expect((await call("/screenshot", { botId })).status).toBe(200);

    // The Bot typing into a field the person filled makes the value its own again.
    const telephone = field(after, "Telephone");
    if (!telephone) throw new Error("The form should have a Telephone field.");
    expect(
      (
        await call("/type", {
          body: {
            ref: telephone.ref,
            snapshotId: after.snapshotId,
            text: "020 7946 0000",
          },
          botId,
        })
      ).status,
    ).toBe(200);
    expect(field(await snapshot(botId), "Telephone")?.value).toBe(
      "020 7946 0000",
    );
  }, 60_000);
});

describe.skipIf(!asked)(
  "a Bot's browser on a computer without the Recorder",
  () => {
    let without: Computer;

    beforeAll(async () => {
      without = await startComputer("without-recorder", {
        OPENBOT_RECORDER_DIR: "",
        COMPUTER_BOT_ID: "other-bot",
      });
    }, 30_000);

    test("launches as it always has, its bar works for the person holding the wheel, and Record says it cannot", async () => {
      expect(
        (
          await call("/navigate", {
            body: { url: page("plain") },
            botId: "other-bot",
            on: without,
          })
        ).status,
      ).toBe(200);
      const plain = (
        await call<BotBrowserState>("/bot-browser/state", {
          botId: "other-bot",
          on: without,
        })
      ).json;
      expect(plain).toEqual({
        open: true,
        tabs: [expect.objectContaining({ url: page("plain"), active: true })],
      });

      const asked = await call<ComputerControlState>("/control/request", {
        body: { reason: "I want to take control of the browser." },
        botId: "other-bot",
        on: without,
      });
      await call("/control/take", {
        body: { requestId: asked.json.request?.id, by: "user-1" },
        botId: "other-bot",
        on: without,
      });
      const opened = await call<BotBrowserState>("/bot-browser/tabs", {
        body: { action: "new", url: page("second") },
        botId: "other-bot",
        on: without,
      });
      expect(opened.status).toBe(200);
      expect(activeTab(opened.json)?.url).toBe(page("second"));

      const record = await call<{ error: string }>("/bot-browser/recording", {
        body: {
          action: "start",
          title: "Nothing to record with",
          by: "user-1",
          connection: connection(),
        },
        botId: "other-bot",
        on: without,
      });
      expect(record).toEqual({
        status: 503,
        json: {
          error:
            "This Bot's browser cannot record: the OpenBot Recorder is not installed on its computer.",
        },
      });
    }, 60_000);
  },
);

/**
 * The server's control routes and gateway, against this computer: the path a person's take and a Bot's request for help
 * travel in a deployment, minus only the sign-in in front of the routes.
 */
function serverOn(on: Computer) {
  const provider: ComputerProvider = {
    name: "this-test",
    isolation: "per-person",
    locate: async () => on.base,
    status: async (seat) => ({ botId: seat.botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const gateway = createComputerGateway({
    provider,
    auditStore: {
      insert: async (_event: AuditEventInput) => {},
    } as unknown as AuditStore,
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    token: TOKEN,
  });
  const actor: AuthenticatedActor = {
    id: "user-1",
    email: "pat@example.com",
    role: "user",
  };
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const routes = createComputerRoutes(
    gateway,
    {} as PolicyStore,
    signedIn,
    async () => true,
  );
  return {
    gateway,
    actor,
    /** A POST to the server's route under `/api/computers`, as the app makes it. */
    async post(botId: string, path: string, body: unknown) {
      const response = await routes.request(
        `http://openbot.test/${botId}${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      return {
        status: response.status,
        json: (await response.json()) as ComputerControlState,
      };
    },
  };
}

describe.skipIf(!asked)("who asked for the wheel", () => {
  test("a person's own take is recorded as theirs (manual) through the server's route, and the Bot's request for help as the Bot's (model)", async () => {
    const botId = "source-bot";
    const server = serverOn(computer);
    // What the app's Take control sends: its own words for asking, and that it is a person's take.
    const asked = await server.post(botId, "/control/request", {
      reason: "I want to take control of the browser.",
      source: "manual",
    });
    expect(asked.status).toBe(200);
    expect(asked.json.request).toMatchObject({
      source: "manual",
      reason: "I want to take control of the browser.",
      status: "waiting",
    });
    const requestId = asked.json.request?.id ?? "";
    const taken = await server.post(botId, "/control/take", { requestId });
    expect(taken.status).toBe(200);
    // The computer's own record, read past the server: the person's take, held by them.
    const held = await call<ComputerControlState>(
      `/control?requestId=${requestId}`,
      { botId },
    );
    expect(held.json).toMatchObject({
      holder: "human",
      heldBy: "user-1",
      request: { source: "manual", status: "taken" },
    });
    expect(
      (await server.post(botId, "/control/release", { requestId })).status,
    ).toBe(200);

    // The Bot asking, as the headless tools and the password service do: no source, so the Bot's.
    // On the seat the routes reach for this person, as the headless tools resolve it.
    const bots = await server.gateway.requestHelp(
      await server.gateway.seatFor(botId, server.actor.id),
      server.actor,
      "Sign in to the bank, then hand back.",
      "call-sign-in",
    );
    expect(bots.request).toMatchObject({
      source: "model",
      reason: "Sign in to the bank, then hand back.",
    });
    expect(
      (
        await server.post(botId, "/control/cancel", {
          requestId: bots.request?.id,
        })
      ).status,
    ).toBe(200);
    // And as the app's own help request does (`runHelpRequest`), through the route with no source: the Bot's too.
    const viaRoute = await server.post(botId, "/control/request", {
      reason: "Solve the puzzle on this page.",
      toolCallId: "call-puzzle",
    });
    expect(viaRoute.json.request).toMatchObject({
      source: "model",
      reason: "Solve the puzzle on this page.",
    });
    // A caller cannot claim a challenge the computer did not see.
    expect(
      (
        await call("/control/request", {
          body: { reason: "Nothing", source: "cloudflare" },
          botId,
        })
      ).status,
    ).toBe(400);
  }, 60_000);
});
