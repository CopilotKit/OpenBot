// The Recorder's launcher API, end to end through the Recorder's own code: the real service worker (connection,
// recording, router, setup) and the real offscreen document side by side over a fake OpenBot and Intelligence, driven
// through `globalThis[LAUNCHER_GLOBAL]` as the process that launched the browser drives it over its DevTools pipe. The
// steps are rows of the full end-to-end run (fixtures/e2e-held-steps.json).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCHER_GLOBAL,
  type LauncherApi,
  type LauncherConnection,
} from "@openbot/shared/openbot-browser";
import {
  type LearningSpaceState,
  RECORDER_SIGNED_OUT,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import {
  type CapturedEvent,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";
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
import { PORT_CONTENT, PORT_OFFSCREEN } from "../src/protocol/messages";
import type { ConnectionRecord, DrainRecord } from "../src/shared/storage";
import {
  type ChromeFake,
  type FakePort,
  installChromeFake,
} from "./support/chrome-fake";
import { type FakeGateway, startFakeGateway } from "./support/fake-gateway";
import { fakeMicrophone, fakeSpeech } from "./support/fake-speech";

const EXTENSION_ID = "test";
const ada = { id: "p1", name: "Ada", email: "ada@example.test" };
const ORDER = "http://127.0.0.1:7420/orders/1043";
const TOKEN = "obr_openbot-browser-token";

const rows = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "e2e-held-steps.json"),
    "utf8",
  ),
) as { archiveClick: CapturedEvent; reasonClick: CapturedEvent };

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
/** The tokens OpenBot still knows, and how often each asked who it is for. */
let liveTokens = new Set<string>();
let meAsked: string[] = [];
/** Whose each token is, as OpenBot answers who a connection is for; Ada's unless a test hands out another's. */
let tokenOwners = new Map<string, typeof ada>();
/** Every call the Recorder made to OpenBot's own routes, as `<method> <path>`. */
let openbotAsked: string[] = [];
/** The person's own Learning space, as OpenBot answers the Recorder's popup; none until a test sets one. */
let learning: LearningSpaceState | null = null;
/** The token OpenBot mints for OpenBot Desktop's code, and the tokens the Recorder asked OpenBot to revoke. */
const DESKTOP_TOKEN = "obr_desktop-made";
let revokedTokens: string[] = [];
/** While set, OpenBot answers the exchange of OpenBot Desktop's code only once it resolves. */
let exchangeHeld: Promise<void> | null = null;
let exchangeArrived = () => {};
/** OpenBot taking OpenBot Desktop's code, when it is asked to and once `exchangeHeld` lets it. */
async function exchange(): Promise<Response> {
  exchangeArrived();
  if (exchangeHeld) await exchangeHeld;
  liveTokens.add(DESKTOP_TOKEN);
  return Response.json({
    token: DESKTOP_TOKEN,
    connection: { id: "c-desktop" },
    user: ada,
  });
}
function route(request: Request): Response | Promise<Response> | null {
  const path = new URL(request.url).pathname;
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (path.startsWith("/api/recorder/"))
    openbotAsked.push(`${request.method} ${path}`);
  if (path === recorderPaths.connections && request.method === "POST")
    return exchange();
  if (path === recorderPaths.currentConnection && request.method === "DELETE") {
    revokedTokens.push(token);
    liveTokens.delete(token);
    return new Response(null, { status: 204 });
  }
  if (path === "/api/recorder/me") {
    meAsked.push(token);
    if (!liveTokens.has(token))
      return Response.json(
        {
          error: "This browser is no longer connected to OpenBot.",
          code: RECORDER_SIGNED_OUT,
          reason: "revoked",
        },
        { status: 401 },
      );
    return Response.json({
      user: tokenOwners.get(token) ?? ada,
      connectionId: `c-${token}`,
    });
  }
  if (path === recorderPaths.learning && learning)
    return Response.json({ learning });
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
let speech = fakeSpeech();
let microphone = fakeMicrophone();

/*
 * Which document is open: closing one ends it, as Chrome ends a closed document's page, so its port goes, it cannot
 * connect again and its timers never fire. Without this a closed document went on answering beside the next one, and
 * the second recording in one browser could not be stopped.
 */
let documentGeneration = 0;
let documentPorts: chrome.runtime.Port[] = [];
function runDocument(): void {
  const generation = documentGeneration;
  fake.runAs("offscreen-document", () =>
    createOffscreenController({
      openOutbox: () => openOutbox(databaseName),
      connectPort: () => {
        if (generation !== documentGeneration)
          throw new Error("This document was closed.");
        const port = chrome.runtime.connect({ name: PORT_OFFSCREEN });
        documentPorts.push(port);
        return port;
      },
      now: () => clock,
      timers: {
        set: (fn, ms) => {
          const handle = setTimeout(() => {
            if (generation === documentGeneration) fn();
          }, ms);
          documentTimers.push(handle);
          return handle;
        },
        clear: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      voice: {
        Recognition: speech.Recognition,
        getUserMedia: microphone.getUserMedia,
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
  installConnection({ connectionLost: recording.connectionLost });
  installSetup();
  installLauncher(recording, { now: () => clock });
}

/** What the launcher reaches over the DevTools pipe: the API on the service worker's own global scope. */
const launcher = () =>
  (globalThis as unknown as Record<string, LauncherApi>)[
    LAUNCHER_GLOBAL
  ] as LauncherApi;

const connection = (
  overrides: Partial<LauncherConnection> = {},
): LauncherConnection => ({
  openbotUrl: gateway.httpUrl,
  token: TOKEN,
  connectionId: `c-${TOKEN}`,
  user: ada,
  ...overrides,
});
const stored = () =>
  fake.storage.local.get("connection") as ConnectionRecord | undefined;

function contentPort(): FakePort {
  return fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: { id: 7 } as chrome.tabs.Tab,
    frameId: 0,
    url: ORDER,
  });
}

/** Opens the order in tab 7, the tab the person is on. */
function openOrder(): void {
  fake.tabs.set(7, {
    id: 7,
    url: ORDER,
    title: "Order 1043 - Corner Shop admin",
    active: true,
    windowId: 1,
  } as chrome.tabs.Tab);
}

/** Starts a recording through the launcher at `at` and resolves with its trajectory once its start reached
 * Intelligence. */
async function record(
  at: number,
  title: string,
  options: { narrate?: boolean } = {},
): Promise<string> {
  clock = at;
  openOrder();
  const started = await launcher().record({
    action: "start",
    title,
    ...options,
  });
  expect(started).toMatchObject({
    ok: true,
    state: { phase: "recording", title, actions: 0 },
  });
  const active = fake.storage.local.get("activeRecording") as DrainRecord;
  const trajectoryId = active.trajectoryIds[0] ?? "";
  await until(
    () => names(trajectoryId).includes("outcome"),
    "the recording's start in Intelligence",
  );
  return trajectoryId;
}

beforeEach(async () => {
  saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  databaseName = `launcher-${Date.now()}-${databaseCounter++}`;
  due = [];
  documentTimers = [];
  // The last test's document is gone with its browser.
  documentGeneration += 1;
  documentPorts = [];
  speech = fakeSpeech();
  microphone = fakeMicrophone();
  liveTokens = new Set([TOKEN]);
  tokenOwners = new Map();
  meAsked = [];
  openbotAsked = [];
  learning = null;
  revokedTokens = [];
  exchangeHeld = null;
  exchangeArrived = () => {};
  gateway = await startFakeGateway({ extraRoutes: route });
  fake = installChromeFake({
    extensionId: EXTENSION_ID,
    manifestVersion: "0.3.0",
  });
  fake.offscreen.onDocumentCreated.addListener(() => {
    setTimeout(runDocument, 0);
  });
  fake.offscreen.onDocumentClosed.addListener(() => {
    documentGeneration += 1;
    for (const port of documentPorts.splice(0)) port.disconnect();
  });
  clock = 1_760_000_000_000;
  startWorker();
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

test("connect stores the connection as an approved Connect does, with no Connect page, and again changes nothing", async () => {
  expect(await launcher().state()).toEqual({
    connected: false,
    phase: "idle",
    actions: 0,
    narration: "own",
    voice: "off",
  });
  expect(
    await launcher().connect({
      connection: connection(),
      narration: "external",
    }),
  ).toEqual({ ok: true });

  expect(stored()).toMatchObject({
    openbotUrl: gateway.httpUrl,
    token: TOKEN,
    connectionId: `c-${TOKEN}`,
    user: ada,
    via: "openbot-browser",
    narration: "external",
  });
  // OpenBot said who the connection is for, as the popup asks when it opens, and the keep-alive is satisfied.
  expect(meAsked).toEqual([TOKEN]);
  expect(fake.storage.session.get("me")).toMatchObject({
    value: { user: ada, connectionId: `c-${TOKEN}` },
  });
  expect(fake.storage.local.get("lastKeepAliveAt")).toBe(clock);
  expect(fake.opened).toEqual([]);
  // The popup and the options page see an ordinary connected browser.
  expect(
    await fake.sendFromPage(
      { type: "page.state" },
      { url: "chrome-extension://test/popup.html" },
    ),
  ).toMatchObject({
    ok: true,
    connection: {
      openbotUrl: gateway.httpUrl,
      user: { name: "Ada", email: ada.email },
      via: "openbot-browser",
    },
  });
  // With the connection it holds by id, which OpenBot keeps rather than making another at every open.
  expect(await launcher().state()).toEqual({
    connected: true,
    userId: ada.id,
    connectionId: connection().connectionId,
    phase: "idle",
    actions: 0,
    narration: "external",
  });

  // The launcher hands the same connection again (a launch it retried): nothing is asked or written again.
  const connectedAt = stored()?.connectedAt;
  clock += 60_000;
  expect(
    await launcher().connect({
      connection: connection(),
      narration: "external",
    }),
  ).toEqual({ ok: true });
  expect(meAsked).toEqual([TOKEN]);
  expect(stored()?.connectedAt).toBe(connectedAt);
});

test("connect refuses an address the Recorder would not connect to, a malformed request and a policy that pins another OpenBot", async () => {
  for (const openbotUrl of [
    "http://openbot.example.com",
    "http://localhost:3010",
    "https://openbot.example.com/app",
    "javascript:alert(1)",
  ]) {
    const answer = await launcher().connect({
      connection: connection({ openbotUrl }),
      narration: "own",
    });
    expect(answer.ok).toBe(false);
  }
  expect(
    await launcher().connect({
      connection: { ...connection(), token: "not-a-recorder-token" },
      narration: "own",
    }),
  ).toMatchObject({ ok: false });
  expect(
    await launcher().connect({
      connection: connection(),
      narration: "loud" as never,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await (launcher().connect as (input: unknown) => Promise<unknown>)(null),
  ).toMatchObject({ ok: false });

  fake.storage.setManaged({ OpenBotUrl: "https://openbot.example.com" });
  await settle();
  expect(
    await launcher().connect({ connection: connection(), narration: "own" }),
  ).toEqual({
    ok: false,
    error:
      "Your organization's Recorder policy does not allow this OpenBot. Ask your IT team.",
  });
  expect(stored()).toBeUndefined();
  expect(meAsked).toEqual([]);
});

test("a connection OpenBot already signed out is refused and forgotten, with the signed-out notice", async () => {
  liveTokens.clear();
  expect(
    await launcher().connect({ connection: connection(), narration: "own" }),
  ).toMatchObject({ ok: false });
  expect(stored()).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "revoked",
  });
  expect((await launcher().state()).connected).toBe(false);
});

test("a revoked connection handed to a Recorder holding a good one is refused and leaves the good one, recording or not", async () => {
  // Two opens of one browser that cross: the older one's connection was revoked by the newer one's, and it reaches the
  // Recorder last. The Recorder asks OpenBot before it takes a connection, so the one that stands keeps it.
  expect(
    await launcher().connect({ connection: connection(), narration: "own" }),
  ).toEqual({ ok: true });
  const STALE = "obr_revoked-by-a-newer-open";
  expect(
    await launcher().connect({
      connection: connection({ token: STALE, connectionId: `c-${STALE}` }),
      narration: "own",
    }),
  ).toMatchObject({ ok: false });
  expect(stored()).toMatchObject({ token: TOKEN });
  expect(fake.storage.local.get("notice")).toBeUndefined();
  expect(await launcher().state()).toMatchObject({
    connected: true,
    userId: ada.id,
  });
});

test("disconnect forgets the connection OpenBot revoked at once and reports signed out, as OpenBot's own signed-out answer does", async () => {
  // The second end-to-end run: Disconnect in Settings, Browsers, and the Recorder went on reporting itself connected
  // until its next call to OpenBot, which on a quiet browser is the keep-alive, twelve hours away.
  await launcher().connect({ connection: connection(), narration: "external" });
  // OpenBot revoked the connection, then told the browser.
  liveTokens.delete(TOKEN);
  const asked = openbotAsked.length;
  expect(await launcher().disconnect()).toEqual({ ok: true });

  expect(stored()).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "revoked",
  });
  expect(await launcher().state()).toEqual({
    connected: false,
    phase: "idle",
    actions: 0,
    narration: "own",
    voice: "off",
  });
  // The popup shows what it shows after a sign-out.
  expect(
    await fake.sendFromPage(
      { type: "page.state" },
      { url: "chrome-extension://test/popup.html" },
    ),
  ).toMatchObject({
    ok: true,
    connection: null,
    notice: { kind: "signed-out", reason: "revoked" },
  });
  // OpenBot revoked the token itself, so it is not asked to again, nor asked who the token is for.
  expect(openbotAsked.slice(asked)).toEqual([]);
  // Record is refused until the launcher hands in a connection again.
  openOrder();
  expect(
    await launcher().record({ action: "start", title: "After Disconnect" }),
  ).toEqual({ ok: false, error: "Connect this browser to OpenBot first." });

  // Told again, or told with nothing stored: nothing more happens.
  expect(await launcher().disconnect()).toEqual({ ok: true });
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "revoked",
  });
  expect(openbotAsked.slice(asked)).toEqual([]);
});

test("a recording disconnect finds running stops as a sign-out stops one, kept for its person, and goes to Intelligence once the browser is connected again", async () => {
  await launcher().connect({ connection: connection(), narration: "external" });
  const click = rows.archiveClick;
  const trajectoryId = await record(
    click.timestamp - 7_000,
    "Archive order 1043",
  );
  const port = contentPort();
  clock = click.timestamp;
  port.postMessage({ type: "content.event", event: click });
  await settle();
  expect((await launcher().state()).actions).toBe(1);

  liveTokens.delete(TOKEN);
  clock = click.timestamp + 1_000;
  expect(await launcher().disconnect()).toEqual({ ok: true });
  expect(await launcher().state()).toMatchObject({
    connected: false,
    phase: "idle",
    actions: 0,
  });
  expect(fake.badge.text).toBe("");
  // Kept, waiting for its person to connect this browser again, as a recording a sign-out stopped is.
  expect(fake.storage.local.get("drains")).toMatchObject([
    {
      trajectoryIds: [trajectoryId],
      userId: ada.id,
      kept: { waitingForReconnect: true },
    },
  ]);
  expect(names(trajectoryId)).not.toContain("click");

  // Record after Disconnect: OpenBot connects the browser again first, and the kept recording goes, its outcome saying
  // the browser was signed out.
  const NEXT = "obr_openbot-browser-token-next";
  liveTokens.add(NEXT);
  expect(
    await launcher().connect({
      connection: connection({ token: NEXT, connectionId: `c-${NEXT}` }),
      narration: "external",
    }),
  ).toEqual({ ok: true });
  await until(
    () => names(trajectoryId).filter((name) => name === "outcome").length === 2,
    "the kept recording in Intelligence",
  );
  expect(names(trajectoryId)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "click",
    "outcome",
  ]);
  expect(sent(trajectoryId).at(-1)?.value).toMatchObject({
    workflow: "Archive order 1043",
    phase: "failed",
    reason: "signed-out",
  });
  await until(
    () =>
      ((fake.storage.local.get("drains") as unknown[] | undefined) ?? [])
        .length === 0,
    "the kept recording sent",
  );
}, 15_000);

test("an OpenBot browser shows no setup tab and no Connect page: none on a later launch, and the first launch's are closed", async () => {
  // OpenBot Desktop's native host answers in this profile too, and hands over a code its OpenBot takes.
  fake.native.reply = (message) =>
    (message as { type: string }).type === "ping"
      ? { ok: true }
      : { ok: true, openbotUrl: gateway.httpUrl, code: "obc_fixture" };

  // The first launch: the install opens its setup tab, and connects through OpenBot Desktop, before the launcher does.
  fake.fireInstalled("install");
  await until(
    () => fake.opened.length === 1 && stored()?.via === "desktop",
    "the install's own tab and connection",
  );
  const opened = [...fake.tabs.keys()];
  expect(
    await launcher().connect({ connection: connection(), narration: "own" }),
  ).toEqual({ ok: true });
  expect([...fake.removed].sort()).toEqual(opened.sort());
  expect(fake.storage.session.get("pendingConnect")).toBeUndefined();
  expect(stored()).toMatchObject({ via: "openbot-browser", token: TOKEN });
  // The connection the install made on its own is revoked: OpenBot would otherwise count this browser as one of the
  // person's own that OpenBot Desktop connected.
  expect(revokedTokens).toEqual([DESKTOP_TOKEN]);

  // The next launch: the Recorder is loaded afresh (an install again) with its storage, the connection in it.
  fake.restartServiceWorker();
  startWorker();
  const before = fake.opened.length;
  fake.fireInstalled("install");
  await settle();
  await settle();
  expect(fake.opened.length).toBe(before);
  // Desktop was not even asked for a code it would mint for nothing.
  expect(
    fake.native.sent.filter(
      (message) => (message as { type: string }).type === "handoff",
    ),
  ).toHaveLength(1);
  expect(stored()).toMatchObject({ via: "openbot-browser", token: TOKEN });
});

test("the launcher's connection that comes while the install's OpenBot Desktop code is exchanged keeps that one out, revoked", async () => {
  fake.native.reply = (message) =>
    (message as { type: string }).type === "ping"
      ? { ok: true }
      : { ok: true, openbotUrl: gateway.httpUrl, code: "obc_fixture" };
  const release = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  exchangeHeld = release.promise;
  exchangeArrived = arrived.resolve;

  fake.fireInstalled("install");
  await arrived.promise;
  const connecting = launcher().connect({
    connection: connection(),
    narration: "own",
  });
  await settle();
  release.resolve();
  expect(await connecting).toEqual({ ok: true });
  await until(
    () => revokedTokens.includes(DESKTOP_TOKEN),
    "the install's own connection revoked",
  );
  expect(stored()).toMatchObject({ via: "openbot-browser", token: TOKEN });
  expect(fake.storage.local.get("notice")).toBeUndefined();
});

test("a second person's recording in the same browser connects through the launcher, after a disconnect or over a connection still held", async () => {
  // A Bot's browser: one Recorder, one person per recording, each handed their own connection over the DevTools pipe
  // (agent-computer's bot-browser-host.ts). The launcher is the trusted way in, so no Connect page asks anyone, unlike a
  // web page asking to replace a live connection (connection.ts).
  const ben = { id: "p2", name: "Ben", email: "ben@example.test" };
  const BEN = "obr_bot-browser-ben";
  liveTokens.add(BEN);
  tokenOwners.set(BEN, ben);
  const forBen = connection({
    token: BEN,
    connectionId: `c-${BEN}`,
    user: ben,
  });

  // Ada records and stops; the computer disconnects the Recorder once the last of it has gone.
  await launcher().connect({ connection: connection(), narration: "external" });
  const adas = await record(clock, "Archive order 1043");
  clock += 30_000;
  expect(await launcher().record({ action: "stop" })).toMatchObject({
    ok: true,
  });
  const drains = () =>
    (fake.storage.local.get("drains") as DrainRecord[] | undefined) ?? [];
  await until(() => drains().length === 0, "the last of Ada's to be sent");
  expect(names(adas).filter((name) => name === "outcome")).toHaveLength(2);
  expect(await launcher().disconnect()).toEqual({ ok: true });

  // Ben takes the wheel and presses Record: his connection is taken at once, and the recording is his.
  expect(
    await launcher().connect({ connection: forBen, narration: "external" }),
  ).toEqual({ ok: true });
  expect(stored()).toMatchObject({ token: BEN, user: ben });
  expect(await launcher().state()).toMatchObject({
    connected: true,
    userId: ben.id,
  });
  const bens = await record(clock + 60_000, "Pay the vendor");
  expect(bens).not.toBe(adas);
  expect(
    (fake.storage.local.get("activeRecording") as DrainRecord).userId,
  ).toBe(ben.id);
  clock += 30_000;
  expect(await launcher().record({ action: "stop" })).toMatchObject({
    ok: true,
  });

  // The computer could not disconnect Ben's (it was stopped under it): Ada's next connection replaces it all the same.
  expect(
    await launcher().connect({
      connection: connection(),
      narration: "external",
    }),
  ).toEqual({ ok: true });
  expect(stored()).toMatchObject({ token: TOKEN, user: ada });
  expect(await launcher().state()).toMatchObject({ userId: ada.id });
  expect(fake.opened).toEqual([]);
  expect(fake.storage.session.get("pendingConnect")).toBeUndefined();
}, 15_000);

test("Record starts on the tab the person is on and Stop ends it, through the popup's own paths", async () => {
  await launcher().connect({ connection: connection(), narration: "own" });
  const click = rows.archiveClick;
  const trajectoryId = await record(
    click.timestamp - 7_000,
    "Archive order 1043",
  );
  const port = contentPort();
  clock = click.timestamp;
  port.postMessage({ type: "content.event", event: click });
  await settle();
  expect(await launcher().state()).toMatchObject({
    connected: true,
    phase: "recording",
    title: "Archive order 1043",
    startedAt: click.timestamp - 7_000,
    actions: 1,
  });
  expect(fake.badge.text).toBe("1");

  await advanceTo(click.timestamp + 5_000);
  const stopped = await launcher().record({ action: "stop" });
  expect(stopped).toMatchObject({
    ok: true,
    state: { phase: "idle", actions: 0 },
  });
  await until(
    () => names(trajectoryId).filter((name) => name === "outcome").length === 2,
    "the recording stopped",
  );
  expect(names(trajectoryId)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "click",
    "outcome",
  ]);
  expect(sent(trajectoryId).at(-1)?.value).toMatchObject({
    phase: "succeeded",
  });
  // A second Record while one runs is refused as the popup's is, and a Record with no connection says so.
  await record(click.timestamp + 10_000, "Again");
  expect(
    await launcher().record({ action: "start", title: "A third" }),
  ).toEqual({ ok: false, error: "A recording is already running." });
}, 15_000);

test("with narration external the Recorder hears nothing itself, and each phrase passed in is a transcript placed by its start among the steps", async () => {
  await launcher().connect({ connection: connection(), narration: "external" });
  const click = rows.archiveClick;
  const trajectoryId = await record(
    click.timestamp - 7_000,
    "Archive order 1043",
  );
  // No speech recognition and no microphone: this browser has none.
  expect(speech.instances).toHaveLength(0);
  expect(microphone.constraints).toHaveLength(0);

  const port = contentPort();
  clock = click.timestamp;
  port.postMessage({ type: "content.event", event: click });
  await settle();
  // The person started saying it 1.5 s before the click, and their own browser handed the phrase over once they
  // stopped, while the click was still held for its save.
  clock = click.timestamp + 600;
  expect(
    await launcher().narrate({
      text: "  archiving the order now  ",
      startedAt: click.timestamp - 1_500,
      endedAt: click.timestamp + 400,
    }),
  ).toEqual({ ok: true });
  await advanceTo(click.timestamp + 5_000);
  await until(
    () => names(trajectoryId).includes("click"),
    "the click in Intelligence",
  );
  expect(names(trajectoryId)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "transcript",
    "click",
  ]);
  const transcript = sent(trajectoryId)[3];
  // The shape the Recorder's own recogniser emits (offscreen/voice.ts), numbered on its way to Intelligence as every
  // event is.
  expect(transcript).toMatchObject({
    type: "CUSTOM",
    name: "transcript",
    timestamp: click.timestamp - 1_500,
    value: {
      text: "archiving the order now",
      startedAt: new Date(click.timestamp - 1_500).toISOString(),
      endedAt: new Date(click.timestamp + 400).toISOString(),
      language: "en-US",
    },
  });
}, 15_000);

test("a phrase the person began before a click and finished after it is placed before that click, however long they took to finish it", async () => {
  // The hosted end-to-end run: a long phrase began 0.4 s before a click into the search box and came back final after
  // the click, the typing and the Search had all left, so it was placed after all three.
  await launcher().connect({ connection: connection(), narration: "external" });
  const click = rows.archiveClick;
  const trajectoryId = await record(
    click.timestamp - 7_000,
    "Archive order 1043",
  );
  // The person's own browser heard their first words come back: the phrase began 0.4 s before the click.
  clock = click.timestamp - 100;
  expect(await launcher().speaking({ since: click.timestamp - 400 })).toEqual({
    ok: true,
  });
  const port = contentPort();
  clock = click.timestamp;
  port.postMessage({ type: "content.event", event: click });
  await settle();
  // Long past the click's own window and its settling: it waits for the phrase it was taken during.
  await advanceTo(click.timestamp + 6_000);
  expect(names(trajectoryId)).not.toContain("click");
  expect(
    await launcher().narrate({
      text: "I archive the order and give the reason",
      startedAt: click.timestamp - 400,
      endedAt: click.timestamp + 5_800,
    }),
  ).toEqual({ ok: true });
  await until(
    () => names(trajectoryId).includes("click"),
    "the click in Intelligence",
  );
  expect(names(trajectoryId)).toEqual([
    "recording.started",
    "outcome",
    "navigation",
    "transcript",
    "click",
  ]);
  expect(sent(trajectoryId)[3]).toMatchObject({
    name: "transcript",
    timestamp: click.timestamp - 400,
    value: { text: "I archive the order and give the reason" },
  });
}, 15_000);

test("a phrase that never comes holds the steps 15 s at most, and the person stopping lets them go at once", async () => {
  await launcher().connect({ connection: connection(), narration: "external" });
  const click = rows.archiveClick;
  const trajectoryId = await record(
    click.timestamp - 7_000,
    "Archive order 1043",
  );
  clock = click.timestamp - 200;
  await launcher().speaking({ since: click.timestamp - 300 });
  const port = contentPort();
  clock = click.timestamp;
  port.postMessage({ type: "content.event", event: click });
  await settle();
  await advanceTo(click.timestamp + 14_000);
  expect(names(trajectoryId)).not.toContain("click");
  await advanceTo(click.timestamp + 14_800);
  await until(
    () => names(trajectoryId).includes("click"),
    "the click, once the phrase's hold ran out",
  );

  // Another phrase begins and the person stops with no words for it (a cough, or a phrase Chrome returned empty).
  const reason = { ...rows.reasonClick, timestamp: click.timestamp + 20_000 };
  clock = reason.timestamp - 100;
  await launcher().speaking({ since: reason.timestamp - 200 });
  clock = reason.timestamp;
  port.postMessage({ type: "content.event", event: reason });
  await settle();
  await advanceTo(reason.timestamp + 4_000);
  expect(names(trajectoryId).filter((name) => name === "click")).toHaveLength(
    1,
  );
  expect(await launcher().speaking({ since: null })).toEqual({ ok: true });
  await until(
    () => names(trajectoryId).filter((name) => name === "click").length === 2,
    "the second click, once the person stopped speaking",
  );
  expect(names(trajectoryId)).not.toContain("transcript");
}, 15_000);

test("speaking is refused while nothing records and in a browser that hears its own voice, and stopping is always taken", async () => {
  await launcher().connect({ connection: connection(), narration: "own" });
  expect(await launcher().speaking({ since: clock - 500 })).toEqual({
    ok: false,
    error: "Nothing is being recorded.",
  });
  // A page that heard the person stop as the recording ended says so after it: there is nothing to hold.
  expect(await launcher().speaking({ since: null })).toEqual({ ok: true });
  // OpenBot's Record form asked the person, and they chose to narrate.
  await record(clock, "Own voice", { narrate: true });
  await until(() => speech.instances.length === 1, "the speech recognition");
  expect(await launcher().speaking({ since: clock - 500 })).toEqual({
    ok: false,
    error: "This browser hears your voice itself.",
  });
  for (const bad of [
    {},
    { since: -1 },
    { since: "now" },
    { since: Number.NaN },
    null,
  ])
    expect(
      await (launcher().speaking as (input: unknown) => Promise<unknown>)(bad),
    ).toMatchObject({ ok: false });
}, 15_000);

test("the Recorder says whether it hears the person: off while nothing records, listening, muted, or unavailable when the microphone is refused", async () => {
  await launcher().connect({ connection: connection(), narration: "own" });
  expect((await launcher().state()).voice).toBe("off");
  // OpenBot's Record form asked the person, and they chose to narrate.
  await record(clock, "Own voice", { narrate: true });
  await until(() => speech.instances.length === 1, "the speech recognition");
  speech.instances[0]?.begin();
  await until(
    async () => (await launcher().state()).voice === "listening",
    "listening",
  );
  // The person mutes it in the Recorder's popup.
  expect(
    await fake.sendFromPage(
      { type: "page.voice", muted: true },
      { url: "chrome-extension://test/popup.html" },
    ),
  ).toEqual({ ok: true });
  expect((await launcher().state()).voice).toBe("muted");
  // On again, and this time the browser refuses the microphone to the speech service.
  expect(
    await fake.sendFromPage(
      { type: "page.voice", muted: false },
      { url: "chrome-extension://test/popup.html" },
    ),
  ).toEqual({ ok: true });
  await until(() => speech.instances.length === 2, "listening again");
  speech.instances[1]?.error("not-allowed");
  await until(
    async () => (await launcher().state()).voice === "unavailable",
    "the refused microphone",
  );
  clock += 5_000;
  await launcher().record({ action: "stop" });
  expect((await launcher().state()).voice).toBe("off");

  // A browser narrated from outside has no voice of its own to report.
  await launcher().connect({ connection: connection(), narration: "external" });
  expect((await launcher().state()).voice).toBeUndefined();
}, 15_000);

test("Stop leaves the recording it ended, by name, for OpenBot to confirm it went to the person's Learning space", async () => {
  await launcher().connect({ connection: connection(), narration: "external" });
  const trajectoryId = await record(clock, "Archive order 1043");
  const recordingId = (await launcher().state()).recordingId;
  expect((await launcher().state()).lastStopped).toBeUndefined();
  clock += 30_000;
  const stoppedAt = clock;
  const stopped = await launcher().record({ action: "stop" });
  expect(stopped).toMatchObject({
    ok: true,
    state: {
      phase: "idle",
      lastStopped: { recordingId, title: "Archive order 1043", stoppedAt },
    },
  });
  await until(
    () => names(trajectoryId).filter((name) => name === "outcome").length === 2,
    "the recording stopped",
  );
  // Nothing was done and nothing said in it: both counts say so, for OpenBot to say nothing was recorded.
  expect((await launcher().state()).lastStopped).toEqual({
    recordingId: recordingId ?? "",
    title: "Archive order 1043",
    stoppedAt,
    actions: 0,
    phrases: 0,
  });
}, 15_000);

test("Stop says the recording is still sending until the last of it has reached Intelligence", async () => {
  // A Bot's browser disconnects the Recorder after Stop, and a disconnect keeps what is not sent yet for the person's
  // next connection there: whoever disconnects waits until this says the last of it has gone.
  await launcher().connect({ connection: connection(), narration: "external" });
  const trajectoryId = await record(clock, "Archive order 1043");
  const recordingId = (await launcher().state()).recordingId;
  clock += 30_000;
  // Intelligence takes its time over the last of it.
  gateway.delayNextAck(1_500);
  const stopped = await launcher().record({ action: "stop" });
  expect(stopped).toMatchObject({
    ok: true,
    state: { lastStopped: { recordingId, sending: true } },
  });
  expect((await launcher().state()).lastStopped?.sending).toBe(true);
  const drains = () =>
    (fake.storage.local.get("drains") as DrainRecord[] | undefined) ?? [];
  await until(() => drains().length === 0, "the last of it to be sent");
  expect(names(trajectoryId).filter((name) => name === "outcome")).toHaveLength(
    2,
  );
  const after = (await launcher().state()).lastStopped;
  expect(after?.recordingId).toBe(recordingId ?? "");
  expect(after).not.toHaveProperty("sending");
}, 15_000);

test("a stopped recording a disconnect catches part sent is kept for its person, and no longer said to be sending", async () => {
  await launcher().connect({ connection: connection(), narration: "external" });
  await record(clock, "Archive order 1043");
  const recordingId = (await launcher().state()).recordingId;
  clock += 30_000;
  gateway.delayNextAck(5_000);
  const stopped = await launcher().record({ action: "stop" });
  expect(stopped).toMatchObject({ state: { lastStopped: { sending: true } } });
  liveTokens.delete(TOKEN);
  expect(await launcher().disconnect()).toEqual({ ok: true });
  // What is left waits for the person to connect this browser again: nothing more is on its way now.
  const drains = (fake.storage.local.get("drains") as DrainRecord[]) ?? [];
  expect(
    drains.find((drain) => drain.recordingId === recordingId)?.kept,
  ).toMatchObject({ waitingForReconnect: true });
  expect((await launcher().state()).lastStopped?.sending).toBeUndefined();
}, 15_000);

test("Stop reports what the recording held: narration alone is something, and actions and phrases are both counted", async () => {
  // The fifth end-to-end run: a recording of three narrated phrases and no clicks reached Intelligence, and OpenBot's
  // page said nothing was recorded, from the only count it had, the actions.
  await launcher().connect({ connection: connection(), narration: "external" });
  const click = rows.archiveClick;
  const said = await record(click.timestamp - 7_000, "Talk it through");
  for (const [offset, text] of [
    [-6_000, "this is the order page"],
    [-4_000, "I would archive it from here"],
  ] as const) {
    clock = click.timestamp + offset + 1_000;
    expect(
      await launcher().narrate({
        text,
        startedAt: click.timestamp + offset,
        endedAt: click.timestamp + offset + 800,
      }),
    ).toEqual({ ok: true });
  }
  clock = click.timestamp;
  const stopped = await launcher().record({ action: "stop" });
  expect(stopped).toMatchObject({
    ok: true,
    state: { phase: "idle", lastStopped: { actions: 0, phrases: 2 } },
  });
  await until(
    () => names(said).filter((name) => name === "outcome").length === 2,
    "the narrated recording stopped",
  );
  expect(names(said).filter((name) => name === "transcript")).toHaveLength(2);
}, 15_000);

test("Stop counts a recording's actions and its phrases both", async () => {
  await launcher().connect({ connection: connection(), narration: "external" });
  const click = rows.archiveClick;
  const trajectoryId = await record(
    click.timestamp - 7_000,
    "Archive order 1043",
  );
  const port = contentPort();
  clock = click.timestamp;
  port.postMessage({ type: "content.event", event: click });
  await settle();
  clock = click.timestamp + 600;
  expect(
    await launcher().narrate({
      text: "archiving the order now",
      startedAt: click.timestamp - 1_500,
      endedAt: click.timestamp + 400,
    }),
  ).toEqual({ ok: true });
  await advanceTo(click.timestamp + 5_000);
  const stopped = await launcher().record({ action: "stop" });
  expect(stopped).toMatchObject({
    ok: true,
    state: { phase: "idle", lastStopped: { actions: 1, phrases: 1 } },
  });
  await until(
    () => names(trajectoryId).filter((name) => name === "outcome").length === 2,
    "the recording stopped",
  );
}, 15_000);

test("a recording the Recorder hears itself counts the phrases its own recogniser placed", async () => {
  await launcher().connect({ connection: connection(), narration: "own" });
  const trajectoryId = await record(clock, "Say it out loud", {
    narrate: true,
  });
  await until(() => speech.instances.length === 1, "the speech recognition");
  const listening = speech.instances[0];
  listening?.begin();
  listening?.say([["opening the first order", true]]);
  await settle();
  await advanceTo(clock + 5_000);
  // Placed among the steps the service worker holds, after the page the recording started on: the person has not acted
  // there, so both go when the recording stops.
  const stopped = await launcher().record({ action: "stop" });
  expect(stopped).toMatchObject({
    ok: true,
    state: { phase: "idle", lastStopped: { actions: 0, phrases: 1 } },
  });
  await until(
    () => names(trajectoryId).includes("transcript"),
    "the phrase in Intelligence",
  );
}, 15_000);

test("a recording a sign-out stops leaves what it held too", async () => {
  await launcher().connect({ connection: connection(), narration: "external" });
  const click = rows.archiveClick;
  await record(click.timestamp - 7_000, "Archive order 1043");
  const port = contentPort();
  clock = click.timestamp;
  port.postMessage({ type: "content.event", event: click });
  await settle();
  expect(
    await launcher().narrate({
      text: "archiving it",
      startedAt: click.timestamp - 300,
      endedAt: click.timestamp + 200,
    }),
  ).toEqual({ ok: true });
  // OpenBot revoked the connection and said so: the recording stops as a sign-out stops one.
  liveTokens.delete(TOKEN);
  clock = click.timestamp + 1_000;
  expect(await launcher().disconnect()).toEqual({ ok: true });
  expect((await launcher().state()).lastStopped).toMatchObject({
    title: "Archive order 1043",
    actions: 1,
    phrases: 1,
  });
}, 15_000);

test("a recording the person's Learning space will not take is not confirmed as gone there", async () => {
  await launcher().connect({ connection: connection(), narration: "external" });
  // No Learning space is assigned to them, as OpenBot answers the Recorder's popup.
  learning = { state: "unassigned", containerId: null };
  expect(
    await fake.sendFromPage(
      { type: "page.learning" },
      { url: "chrome-extension://test/popup.html" },
    ),
  ).toMatchObject({ ok: true });
  await record(clock, "Refund order 1043");
  clock += 30_000;
  const stopped = await launcher().record({ action: "stop" });
  expect(stopped).toMatchObject({ ok: true, state: { phase: "idle" } });
  expect(
    (stopped as { state: { lastStopped?: unknown } }).state.lastStopped,
  ).toBeUndefined();
}, 15_000);

test("a phrase passed in is masked as the Recorder's own are: a value typed into a sensitive field, and a number after the phrase that named a PIN", async () => {
  await launcher().connect({ connection: connection(), narration: "external" });
  const click = rows.reasonClick;
  const trajectoryId = await record(
    click.timestamp - 5_000,
    "Refund order 1043",
  );
  const port = contentPort();
  clock = click.timestamp - 4_000;
  port.postMessage({
    type: "content.sensitive",
    digest: sha256HexSync("Kestrel99"),
  });
  await settle();
  const say = (text: string, at: number) =>
    launcher().narrate({ text, startedAt: at, endedAt: at + 800 });
  expect(await say("now I type Kestrel99 into the box", clock - 2_000)).toEqual(
    {
      ok: true,
    },
  );
  expect(await say("my pin is", clock - 1_000)).toEqual({ ok: true });
  expect(await say("4815", clock - 100)).toEqual({ ok: true });
  await advanceTo(click.timestamp);
  // The phrases wait behind the page the recording started on, which the person has not acted on, until they stop.
  expect(await launcher().record({ action: "stop" })).toMatchObject({
    ok: true,
  });
  await until(
    () =>
      names(trajectoryId).filter((name) => name === "transcript").length === 3,
    "the phrases in Intelligence",
  );
  const spoken = sent(trajectoryId)
    .filter((event) => event.name === "transcript")
    .map((event) => (event.value as { text: string }).text);
  expect(spoken).toEqual([
    "now I type [redacted] into the box",
    "my pin is",
    "[redacted]",
  ]);
  expect(JSON.stringify(sent(trajectoryId))).not.toContain("Kestrel99");
  expect(JSON.stringify(sent(trajectoryId))).not.toContain("4815");
}, 15_000);

test("narrate is refused while nothing records, in a browser that hears its own voice, and for a phrase that is not one", async () => {
  await launcher().connect({ connection: connection(), narration: "own" });
  const phrase = { text: "hello", startedAt: clock - 500, endedAt: clock };
  expect(await launcher().narrate(phrase)).toEqual({
    ok: false,
    error: "Nothing is being recorded.",
  });
  await record(clock, "Own voice", { narrate: true });
  // The Recorder hears this browser's microphone itself, as in any browser.
  await until(() => speech.instances.length === 1, "the speech recognition");
  expect(await launcher().narrate(phrase)).toEqual({
    ok: false,
    error: "This browser hears your voice itself.",
  });
  for (const bad of [
    { ...phrase, text: "" },
    { ...phrase, startedAt: -1 },
    { ...phrase, endedAt: phrase.startedAt - 1 },
    { ...phrase, text: "x".repeat(4_001) },
  ])
    expect((await launcher().narrate(bad)).ok).toBe(false);
}, 15_000);

test("no runtime message reaches the launcher API: not from a page, a content script, the Recorder's own pages or another extension", async () => {
  const before = fake.calls.filter((call) => call.includes("addListener"));
  // The launcher adds no listener of any kind: it is reached only on the service worker's global scope.
  fake.restartServiceWorker();
  const recording = installRecording({
    hasHostPermission: async () => true,
    now: () => clock,
  });
  installRouter(recording);
  installConnection({ connectionLost: recording.connectionLost });
  installSetup();
  const listening = fake.calls.filter((call) => call.includes("addListener"));
  installLauncher(recording);
  expect(fake.calls.filter((call) => call.includes("addListener")).length).toBe(
    listening.length,
  );
  expect(before.length).toBeGreaterThan(0);
  expect(typeof launcher().connect).toBe("function");

  const asks = [
    { type: "connect", connection: connection(), narration: "own" },
    {
      type: "launcher.connect",
      connection: connection(),
      narration: "own",
    },
    { type: LAUNCHER_GLOBAL, method: "connect", args: [connection()] },
    { type: "openbotLauncher.connect", connection: connection() },
    { type: "launcher.record", action: "start", title: "x" },
  ];
  for (const message of asks) {
    expect(
      await fake.sendFromPage(message, {
        url: "chrome-extension://test/popup.html",
      }),
    ).toEqual({ ok: false, error: "Unknown request." });
    expect(
      await fake.sendExternal(message, {
        origin: "https://evil.example",
        url: "https://evil.example/",
      }),
    ).toEqual({ ok: false, error: "invalid" });
    contentPort().postMessage(message);
  }
  await settle();
  expect(stored()).toBeUndefined();
  expect(meAsked).toEqual([]);
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
});
