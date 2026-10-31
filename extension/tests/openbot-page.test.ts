// What OpenBot's own page asks the Recorder in the same browser (shared/recorder-page.ts), end to end through the
// Recorder's own code: the real service worker (connection, recording, router, setup, launcher) and the real offscreen
// document side by side over a fake OpenBot and Intelligence, driven through `externally_connectable` messages as
// Chrome delivers them, with the sender's origin, tab and frame as Chrome reports them. The steps are rows of the full
// end-to-end run (fixtures/e2e-held-steps.json).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAUNCHER_GLOBAL } from "@openbot/shared/openbot-browser";
import {
  RECORDER_SIGNED_OUT,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import { installConnection } from "../src/background/connection";
import { installLauncher } from "../src/background/launcher";
import {
  installRecording,
  type RecordingDeps,
} from "../src/background/recording";
import { installRouter } from "../src/background/router";
import { installSetup } from "../src/background/setup";
import { createOffscreenController } from "../src/offscreen/index";
import { openOutbox } from "../src/offscreen/outbox";
import {
  PORT_CONTENT,
  PORT_OFFSCREEN,
  type RecorderState,
} from "../src/protocol/messages";
import type { ConnectionRecord, DrainRecord } from "../src/shared/storage";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";
import { type FakeGateway, startFakeGateway } from "./support/fake-gateway";
import { fakeMicrophone, fakeSpeech } from "./support/fake-speech";

const EXTENSION_ID = "test";
const ada = { id: "p1", name: "Ada", email: "ada@example.test" };
const ORDER = "http://127.0.0.1:7420/orders/1043";
const TOKEN = "obr_openbot-page-token";
const NOT_CONNECTED = "Connect this browser to OpenBot first.";

const rows = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "e2e-held-steps.json"),
    "utf8",
  ),
) as { archiveClick: CapturedEvent };

type Globals = { indexedDB?: IDBFactory; IDBKeyRange?: unknown };
const globals = globalThis as unknown as Globals;
let saved: Globals = {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(20);
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
    await sleep(5);
  }
}

// ---- The fake OpenBot and Intelligence --------------------------------------------------------

let gateway: FakeGateway;
/** The tokens OpenBot still knows; the codes it took, and the tokens the Recorder asked it to revoke. */
let liveTokens = new Set<string>();
let exchanged: string[] = [];
let revokedTokens: string[] = [];
/** OpenBot taking the code OpenBot's page handed the Recorder. */
async function exchange(request: Request): Promise<Response> {
  const { code } = (await request.json()) as { code: string };
  exchanged.push(code);
  liveTokens.add(TOKEN);
  return Response.json({
    token: TOKEN,
    connection: { id: `c-${TOKEN}` },
    user: ada,
  });
}
function route(request: Request): Response | Promise<Response> | null {
  const path = new URL(request.url).pathname;
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (path === recorderPaths.connections && request.method === "POST")
    return exchange(request);
  if (path === recorderPaths.currentConnection && request.method === "DELETE") {
    revokedTokens.push(token);
    liveTokens.delete(token);
    return new Response(null, { status: 204 });
  }
  if (path === recorderPaths.me) {
    if (!liveTokens.has(token))
      return Response.json(
        {
          error: "This browser is no longer connected to OpenBot.",
          code: RECORDER_SIGNED_OUT,
          reason: "revoked",
        },
        { status: 401 },
      );
    return Response.json({ user: ada, connectionId: `c-${token}` });
  }
  if (path.startsWith("/api/recorder/"))
    return Response.json({ error: "Not found." }, { status: 404 });
  const pass = /^\/api\/copilotkit\/trajectory\/([^/]+)\/connect$/.exec(path);
  if (!pass || request.method !== "POST") return null;
  const trajectoryId = decodeURIComponent(pass[1] ?? "");
  return Response.json({
    joinToken: gateway.mintToken(trajectoryId),
    realtime: {
      clientUrl: `${gateway.url}/client`,
      topic: `trajectory:${trajectoryId}`,
    },
  });
}
const sent = (trajectoryId: string) =>
  gateway.events(trajectoryId).map((entry) => entry.raw as CapturedEvent);
const names = (trajectoryId: string) =>
  sent(trajectoryId).map((event) => event.name);

// ---- Time, and the two contexts ---------------------------------------------------------------

let clock = 0;
type Due = { id: number; at: number; fn: () => void };
let due: Due[] = [];
let nextTimer = 0;
const workerTimers = {
  set(fn: () => void, ms: number) {
    nextTimer += 1;
    due.push({ id: nextTimer, at: clock + Math.max(0, ms), fn });
    return nextTimer;
  },
  clear(handle: unknown) {
    due = due.filter((timer) => timer.id !== handle);
  },
};
/** Moves the clock to `to`, firing the service worker's held-step timers that fall due on the way, in order. */
async function advanceTo(to: number) {
  for (;;) {
    const next = due
      .filter((timer) => timer.at <= to)
      .sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    due = due.filter((timer) => timer !== next);
    clock = Math.max(clock, next.at);
    next.fn();
    await settle();
  }
  clock = Math.max(clock, to);
  await settle();
}

let fake: ChromeFake;
let databaseName = "";
let databaseCounter = 0;
let documentTimers: ReturnType<typeof setTimeout>[] = [];

function runDocument(): void {
  fake.runAs("offscreen-document", () =>
    createOffscreenController({
      openOutbox: () => openOutbox(databaseName),
      connectPort: () => chrome.runtime.connect({ name: PORT_OFFSCREEN }),
      now: () => clock,
      timers: {
        set: (fn, ms) => {
          const handle = setTimeout(fn, ms);
          documentTimers.push(handle);
          return handle;
        },
        clear: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      voice: {
        Recognition: fakeSpeech().Recognition,
        getUserMedia: fakeMicrophone().getUserMedia,
      },
    }),
  );
}

/** The service worker as background/index.ts starts it, on the test's clock. */
function startWorker(): void {
  const deps: Partial<RecordingDeps> = {
    createNetworkCapture: () => ({
      start: async () => "debugger",
      addTab: async () => {},
      onCommitted: async () => {},
      resume: async () => "debugger",
      recordPageEvent: async () => {},
      recordPageAgent: () => {},
      stop: async () => {},
    }),
    createPageFallback: () => ({
      start: async () => false,
      addTab: async () => {},
      onCommitted: async () => {},
      stop: async () => {},
      active: () => false,
    }),
    acceptPageNetworkEvent: () => null,
    hasHostPermission: async () => true,
    now: () => clock,
    timers: { set: () => 0, clear: () => {} },
    stepTimers: workerTimers,
  };
  const recording = installRecording(deps);
  installRouter(recording);
  installConnection({
    connectionLost: recording.connectionLost,
    connected: recording.connected,
  });
  installSetup();
  installLauncher(recording, { now: () => clock });
}

// ---- The tabs, and who asks ---------------------------------------------------------------------

const OPENBOT_TAB = 7;
const ORDER_TAB = 8;
const openbotPage = () => `${gateway.httpUrl}/`;

/** OpenBot in tab 7, the tab the person is on, and an order already open in tab 8 behind it. */
function openTabs(): void {
  fake.tabs.set(OPENBOT_TAB, {
    id: OPENBOT_TAB,
    url: openbotPage(),
    title: "OpenBot",
    active: true,
    windowId: 1,
  } as chrome.tabs.Tab);
  fake.tabs.set(ORDER_TAB, {
    id: ORDER_TAB,
    url: ORDER,
    title: "Order 1043 - Corner Shop admin",
    active: false,
    windowId: 1,
  } as chrome.tabs.Tab);
}

/** OpenBot's page (OpenBot Desktop's, on its loopback address), as Chrome reports it to the Recorder: its top frame. */
const fromOpenBot = (
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender => ({
  origin: gateway.httpUrl,
  url: openbotPage(),
  tab: fake.tabs.get(OPENBOT_TAB),
  frameId: 0,
  ...overrides,
});

/** Pages that are not the connected OpenBot, each as Chrome would report it. */
const others = (): chrome.runtime.MessageSender[] => [
  {
    origin: "https://evil.example",
    url: "https://evil.example/",
    tab: { id: 9 } as chrome.tabs.Tab,
    frameId: 0,
  },
  // Another server on this computer, on another port: not the OpenBot this copy is connected to.
  {
    origin: "http://127.0.0.1:1",
    url: "http://127.0.0.1:1/",
    tab: { id: 10 } as chrome.tabs.Tab,
    frameId: 0,
  },
  // A sandboxed frame's opaque origin, and a sender Chrome gives no origin.
  {
    origin: "null",
    url: "about:blank",
    tab: { id: 9 } as chrome.tabs.Tab,
    frameId: 2,
  },
  { url: openbotPage(), tab: { id: 9 } as chrome.tabs.Tab, frameId: 0 },
];

const ask = (message: unknown, sender = fromOpenBot()) =>
  fake.sendExternal(message, sender);
const stored = () =>
  fake.storage.local.get("connection") as ConnectionRecord | undefined;
async function recorderState(): Promise<RecorderState> {
  const answer = (await fake.sendFromPage(
    { type: "page.state" },
    { url: "chrome-extension://test/popup.html" },
  )) as { state: RecorderState };
  return answer.state;
}

/** OpenBot's page connects this browser: OpenBot Desktop's own address, so with no Connect page. */
async function connectFromOpenBot(): Promise<void> {
  expect(
    await ask({ type: "openbot.connect", code: "obc_from-openbot" }),
  ).toMatchObject({ ok: true, connected: true });
  await settle();
}

beforeEach(async () => {
  saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  databaseName = `openbot-page-${Date.now()}-${databaseCounter++}`;
  due = [];
  documentTimers = [];
  liveTokens = new Set();
  exchanged = [];
  revokedTokens = [];
  gateway = await startFakeGateway({ extraRoutes: route });
  fake = installChromeFake({
    extensionId: EXTENSION_ID,
    manifestVersion: "0.3.0",
  });
  // OpenBot Desktop runs on this computer, and its native host confirms the address its OpenBot answers on
  // (recorder_host.rs `address`): that is what makes OpenBot's page there one the Recorder connects with no click.
  fake.native.reply = (message) =>
    (message as { type?: string }).type === "address"
      ? { ok: true, openbotUrl: gateway.httpUrl }
      : { ok: false, error: "unknown-message" };
  fake.offscreen.onDocumentCreated.addListener(() => {
    setTimeout(runDocument, 0);
  });
  clock = rows.archiveClick.timestamp - 7_000;
  startWorker();
  openTabs();
  await settle();
}, 15_000);

afterEach(async () => {
  await settle();
  for (const handle of documentTimers) clearTimeout(handle);
  await gateway.stop();
  fake.uninstall();
  Reflect.deleteProperty(globalThis, LAUNCHER_GLOBAL);
  for (const key of ["indexedDB", "IDBKeyRange"] as const) {
    if (saved[key] === undefined) Reflect.deleteProperty(globals, key);
    else Object.assign(globals, { [key]: saved[key] });
  }
}, 15_000);

test("OpenBot's page connects with no Connect page, records its own tab and then a tab the person switches to, and stops", async () => {
  expect(await ask({ type: "openbot.state" })).toEqual({ connected: false });
  await connectFromOpenBot();
  expect(exchanged).toEqual(["obc_from-openbot"]);
  expect(fake.opened).toEqual([]);
  expect(stored()).toMatchObject({
    openbotUrl: gateway.httpUrl,
    token: TOKEN,
    via: "web",
  });
  expect(await ask({ type: "openbot.state" })).toEqual({
    connected: true,
    phase: "idle",
    actions: 0,
  });

  const startedAt = clock;
  expect(
    await ask({ type: "openbot.record", title: "  Archive order 1043  " }),
  ).toEqual({
    ok: true,
    state: {
      connected: true,
      phase: "recording",
      title: "Archive order 1043",
      startedAt,
      actions: 0,
    },
  });
  // It records the tab OpenBot asked from, through the popup's own Record.
  expect((await recorderState()).tabIds).toEqual([OPENBOT_TAB]);
  const active = fake.storage.local.get("activeRecording") as DrainRecord;
  const trajectoryId = active.trajectoryIds[0] ?? "";
  await until(
    () => names(trajectoryId).includes("outcome"),
    "the recording's start in Intelligence",
  );

  // The person goes to the order, open in a tab behind OpenBot's, and archives it there.
  fake.person.switchTo(ORDER_TAB);
  await until(
    async () => (await recorderState()).tabIds.includes(ORDER_TAB),
    "the tab the person switched to followed",
  );
  const port = fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: fake.tabs.get(ORDER_TAB),
    frameId: 0,
    url: ORDER,
  });
  const click = rows.archiveClick;
  clock = click.timestamp;
  port.postMessage({ type: "content.event", event: click });
  await settle();
  expect(await ask({ type: "openbot.state" })).toEqual({
    connected: true,
    phase: "recording",
    title: "Archive order 1043",
    startedAt,
    actions: 1,
  });
  // A second Record while one runs is refused with the Recorder's own sentence, and changes nothing.
  expect(await ask({ type: "openbot.record", title: "Again" })).toEqual({
    ok: false,
    error: "A recording is already running.",
  });

  await advanceTo(click.timestamp + 5_000);
  const stoppedAt = clock;
  expect(await ask({ type: "openbot.stop" })).toEqual({
    ok: true,
    state: {
      connected: true,
      phase: "idle",
      actions: 0,
      lastStopped: {
        recordingId: active.recordingId,
        title: "Archive order 1043",
        stoppedAt,
        actions: 1,
        phrases: 0,
      },
    },
  });
  await until(
    () => names(trajectoryId).filter((name) => name === "outcome").length === 2,
    "the recording stopped",
  );
  // OpenBot's page as the recording's first tab, then the order as its second, with the click in it.
  const steps = sent(trajectoryId).filter(
    (event) => event.name === "navigation" || event.name === "click",
  );
  expect(
    steps.map((event) => {
      // A navigation names the page it went `to`; a click the page it was on (`url`).
      const value = event.value as { tab?: number; to?: string; url?: string };
      return [event.name, value.tab, value.to ?? value.url];
    }),
  ).toEqual([
    ["navigation", 1, openbotPage()],
    ["navigation", 2, ORDER],
    ["click", 2, ORDER],
  ]);
  expect(sent(trajectoryId).at(-1)?.value).toMatchObject({
    phase: "succeeded",
  });
  // State after Stop says the same, and Stop again changes nothing.
  expect(await ask({ type: "openbot.state" })).toMatchObject({
    phase: "idle",
    lastStopped: { recordingId: active.recordingId, actions: 1 },
  });
  expect(await ask({ type: "openbot.stop" })).toMatchObject({
    ok: true,
    state: { phase: "idle", lastStopped: { recordingId: active.recordingId } },
  });
}, 20_000);

test("any other page gets not connected and a refusal, the same whether this copy is connected or not, and learns nothing", async () => {
  const answers = async () => {
    const all: unknown[] = [];
    for (const sender of others())
      for (const message of [
        { type: "openbot.state" },
        { type: "openbot.record", title: "Steal it" },
        { type: "openbot.stop" },
      ])
        all.push(await ask(message, sender));
    return all;
  };
  const expected = others().flatMap(() => [
    { connected: false },
    { ok: false, error: NOT_CONNECTED },
    { ok: false, error: NOT_CONNECTED },
  ]);
  // Nothing connected.
  expect(await answers()).toEqual(expected);

  // Connected to OpenBot, and recording from it.
  await connectFromOpenBot();
  expect(
    await ask({ type: "openbot.record", title: "Archive order 1043" }),
  ).toMatchObject({ ok: true, state: { phase: "recording" } });
  const active = fake.storage.local.get("activeRecording") as DrainRecord;
  expect(await answers()).toEqual(expected);
  // The recording OpenBot started runs on, untouched, and no other started.
  expect(fake.storage.local.get("activeRecording")).toEqual(active);
  expect(await ask({ type: "openbot.state" })).toMatchObject({
    connected: true,
    phase: "recording",
    title: "Archive order 1043",
  });
  expect((await recorderState()).tabIds).toEqual([OPENBOT_TAB]);
}, 20_000);

test("OpenBot's origin in a frame of another page may read the state and stop, but records only from its own top frame", async () => {
  await connectFromOpenBot();
  const framed = fromOpenBot({
    url: openbotPage(),
    tab: { id: 9, url: "https://evil.example/" } as chrome.tabs.Tab,
    frameId: 4,
  });
  expect(await ask({ type: "openbot.record", title: "x" }, framed)).toEqual({
    ok: false,
    error: "Record from OpenBot's own tab.",
  });
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect(await ask({ type: "openbot.state" }, framed)).toEqual({
    connected: true,
    phase: "idle",
    actions: 0,
  });
});

test("once the person disconnects this browser, OpenBot's page is told it is not connected and can no longer record", async () => {
  await connectFromOpenBot();
  expect(
    await fake.sendFromPage(
      { type: "page.disconnect" },
      { url: "chrome-extension://test/popup.html" },
    ),
  ).toEqual({ ok: true });
  expect(revokedTokens).toEqual([TOKEN]);
  expect(await ask({ type: "openbot.state" })).toEqual({ connected: false });
  expect(await ask({ type: "openbot.record", title: "x" })).toEqual({
    ok: false,
    error: NOT_CONNECTED,
  });
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
});

test("Record from OpenBot's page carries the person's narration choice from their account, and without one the Recorder's own", async () => {
  // OpenBot keeps the choice on the person's account, and its own Record form passes it on; a Record from its page
  // in the person's everyday browser used to leave it out, so the Recorder went by its own setting instead.
  await connectFromOpenBot();
  const voice = async () => (await recorderState()).capture.voice?.state;
  const recordAndStop = async (message: object) => {
    expect(await ask(message)).toMatchObject({ ok: true });
    await until(
      async () => (await voice()) !== undefined,
      "the recording's voice",
    );
    const heard = await voice();
    await advanceTo(clock + 5_000);
    expect(await ask({ type: "openbot.stop" })).toMatchObject({ ok: true });
    await until(
      async () => (await recorderState()).phase === "idle",
      "the recording stopped",
    );
    return heard;
  };
  // Nothing chosen in the Recorder, which is no microphone, while the account says to narrate.
  expect(
    await recordAndStop({
      type: "openbot.record",
      title: "Archive order 1043",
      narrate: true,
    }),
  ).not.toBe("muted");
  // The account says no, while the Recorder was set to narrate: the account's choice wins.
  fake.storage.local.set("narration", "on");
  expect(
    await recordAndStop({
      type: "openbot.record",
      title: "Archive order 1044",
      narrate: false,
    }),
  ).toBe("muted");
  // No choice from the account: the Recorder's own.
  expect(
    await recordAndStop({
      type: "openbot.record",
      title: "Archive order 1045",
    }),
  ).not.toBe("muted");
}, 20_000);
