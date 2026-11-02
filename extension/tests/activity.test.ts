// What the Recorder tells OpenBot it is recording (the Browser button's red dot), end to end through the Recorder's own
// code: the real service worker (connection, recording, router, setup, launcher) and the real offscreen document side
// by side over a fake OpenBot and Intelligence, on the test's clock, for a connection the popup records with and one
// an OpenBot browser's launcher made. Every report is read as OpenBot's route reads it (`recorderActivitySchema`).
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  LAUNCHER_GLOBAL,
  type LauncherApi,
} from "@openbot/shared/openbot-browser";
import {
  RECORDER_SIGNED_OUT,
  type RecorderActivity,
  recorderActivitySchema,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import { ACTIVITY_REPORT_MS } from "../src/background/activity";
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
import type { ConnectionRecord } from "../src/shared/storage";
import {
  type ChromeFake,
  type FakePort,
  installChromeFake,
} from "./support/chrome-fake";
import { type FakeGateway, startFakeGateway } from "./support/fake-gateway";
import { fakeMicrophone, fakeSpeech } from "./support/fake-speech";

const EXTENSION_ID = "test";
const POPUP = { url: `chrome-extension://${EXTENSION_ID}/popup.html` };
const ada = { id: "p1", name: "Ada", email: "ada@example.test" };
const ORDER = "http://127.0.0.1:7420/orders/1043";
const DESKTOP_TOKEN = "obr_desktop-connection";
const LAUNCHER_TOKEN = "obr_openbot-browser";
const SIGNED_OUT =
  "This browser was disconnected from OpenBot. Your recording stopped, and everything in it is kept in this browser for 7 days, until you connect again.";

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

// ---- The fake OpenBot -------------------------------------------------------------------------

let gateway: FakeGateway;
let liveTokens = new Set<string>();
/** Every report OpenBot's activity route received, with the bearer it came with. */
let reports: { token: string; body: RecorderActivity }[] = [];
/** How OpenBot's activity route answers: as it should (204), signed out (401), refusing the report (400, or 415 for a
 * body that is not JSON), broken, or never. */
let activityAnswer:
  | "ok"
  | "signed-out"
  | "bad-report"
  | "not-json"
  | "error"
  | "hang" = "ok";

const signedOut = () =>
  Response.json(
    {
      error: "This browser is no longer connected to OpenBot.",
      code: RECORDER_SIGNED_OUT,
      reason: "revoked",
    },
    { status: 401 },
  );

async function activity(request: Request, token: string): Promise<Response> {
  // OpenBot's route takes only what the contract types: anything else would be a 400 there.
  reports.push({
    token,
    body: recorderActivitySchema.parse(await request.json()),
  });
  if (!liveTokens.has(token) || activityAnswer === "signed-out")
    return signedOut();
  if (activityAnswer === "bad-report")
    return Response.json(
      { error: "That is not a Recorder report.", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  if (activityAnswer === "not-json")
    return Response.json(
      { error: "Send the report as JSON.", code: "UNSUPPORTED_MEDIA_TYPE" },
      { status: 415 },
    );
  if (activityAnswer === "error")
    return Response.json({ error: "OpenBot broke." }, { status: 500 });
  if (activityAnswer === "hang") await new Promise(() => {});
  return new Response(null, { status: 204 });
}

function route(request: Request): Response | Promise<Response> | null {
  const path = new URL(request.url).pathname;
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (path === recorderPaths.activity && request.method === "POST")
    return activity(request, token);
  if (path === recorderPaths.me)
    return liveTokens.has(token)
      ? Response.json({ user: ada, connectionId: `c-${token}` })
      : signedOut();
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

// ---- Time, and the two contexts ---------------------------------------------------------------

let clock = 0;
type Due = { id: number; at: number; fn: () => void };
let due: Due[] = [];
let nextTimer = 0;
/** The service worker's timers, on the test's clock: only `advanceTo` fires them. */
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

/** The service worker as background/index.ts starts it, on the test's clock and timers. */
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
    timers: workerTimers,
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

const launcher = () =>
  (globalThis as unknown as Record<string, LauncherApi>)[
    LAUNCHER_GLOBAL
  ] as LauncherApi;

/** A connection OpenBot Desktop made for the person's own browser, as the popup records with it. */
function connectedThroughDesktop(): void {
  liveTokens.add(DESKTOP_TOKEN);
  fake.storage.local.set("connection", {
    openbotUrl: gateway.httpUrl,
    token: DESKTOP_TOKEN,
    connectionId: `c-${DESKTOP_TOKEN}`,
    user: ada,
    via: "desktop",
    connectedAt: clock,
  } satisfies ConnectionRecord);
}

function openOrder(): void {
  fake.tabs.set(7, {
    id: 7,
    url: ORDER,
    title: "Order 1043 - Corner Shop admin",
    active: true,
    windowId: 1,
  } as chrome.tabs.Tab);
}

const page = (message: object) => fake.sendFromPage(message, POPUP);
const state = async () =>
  ((await page({ type: "page.state" })) as { state: RecorderState }).state;

/** Record from the popup, as the person presses it. */
async function recordFromPopup(title: string): Promise<void> {
  openOrder();
  expect(
    await page({ type: "page.record", title, tabId: 7, language: "en-GB" }),
  ).toEqual({ ok: true });
}

function contentPort(): FakePort {
  return fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: { id: 7 } as chrome.tabs.Tab,
    frameId: 0,
    url: ORDER,
  });
}

const click = (at: number): CapturedEvent => ({
  type: "CUSTOM",
  name: "click",
  timestamp: at,
  value: { tag: "button", text: "Archive", url: ORDER, frame: 0 },
});

const phases = () => reports.map((report) => report.body.phase);
const last = () => reports.at(-1)?.body;

beforeEach(async () => {
  saved = { indexedDB: globals.indexedDB, IDBKeyRange: globals.IDBKeyRange };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  databaseName = `activity-${Date.now()}-${databaseCounter++}`;
  due = [];
  documentTimers = [];
  liveTokens = new Set([LAUNCHER_TOKEN]);
  reports = [];
  activityAnswer = "ok";
  gateway = await startFakeGateway({ extraRoutes: route });
  fake = installChromeFake({
    extensionId: EXTENSION_ID,
    manifestVersion: "0.3.0",
  });
  fake.offscreen.onDocumentCreated.addListener(() => {
    setTimeout(runDocument, 0);
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

test("a recording made from the popup tells OpenBot what it records: each phase, every 30 s with the actions so far, then idle", async () => {
  connectedThroughDesktop();
  // Connected and idle, nothing changes: nothing is reported.
  await advanceTo(clock + 3 * ACTIVITY_REPORT_MS);
  expect(reports).toEqual([]);

  const startedAt = clock;
  await recordFromPopup("Archive order 1043");
  await until(() => last()?.phase === "recording", "the recording reported");
  const { recordingId } = await state();
  expect(last()).toEqual({
    phase: "recording",
    recordingId,
    title: "Archive order 1043",
    startedAt,
    actions: 0,
  });
  // Starting comes first when OpenBot hears it before the recording is live; either way it is never heard after.
  expect(phases().filter((phase) => phase !== "starting")[0]).toBe("recording");

  // The person archives the order; the next report, 30 s on, carries it.
  const port = contentPort();
  port.postMessage({ type: "content.event", event: click(clock + 1_000) });
  await until(async () => (await state()).actions === 1, "the click counted");
  const before = reports.length;
  await advanceTo(startedAt + ACTIVITY_REPORT_MS);
  await until(() => reports.length > before, "the 30 s report");
  expect(last()).toEqual({
    phase: "recording",
    recordingId,
    title: "Archive order 1043",
    startedAt,
    actions: 1,
  });
  await advanceTo(startedAt + 2 * ACTIVITY_REPORT_MS);
  await until(() => reports.length > before + 1, "the 60 s report");

  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  await until(() => last()?.phase === "idle", "idle reported");
  expect(last()).toEqual({ phase: "idle", actions: 0 });
  // Every report went with the connection's own bearer, and stopped when the recording did.
  expect(new Set(reports.map((report) => report.token))).toEqual(
    new Set([DESKTOP_TOKEN]),
  );
  const after = reports.length;
  await advanceTo(clock + 3 * ACTIVITY_REPORT_MS);
  expect(reports).toHaveLength(after);
}, 20_000);

test("an OpenBot browser's connection reports too, with the bearer its launcher handed in, and Start over reports the new recording", async () => {
  expect(
    await launcher().connect({
      connection: {
        openbotUrl: gateway.httpUrl,
        token: LAUNCHER_TOKEN,
        connectionId: `c-${LAUNCHER_TOKEN}`,
        user: ada,
      },
      narration: "external",
    }),
  ).toEqual({ ok: true });
  openOrder();
  const started = await launcher().record({
    action: "start",
    title: "Refund an order",
  });
  expect(started.ok).toBe(true);
  await until(() => last()?.phase === "recording", "the recording reported");
  const first = last()?.recordingId;

  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  await until(
    () => last()?.phase === "recording" && last()?.recordingId !== first,
    "Start over's recording reported",
  );
  expect(last()).toMatchObject({ title: "Refund an order", actions: 0 });

  expect(await launcher().record({ action: "stop" })).toMatchObject({
    ok: true,
  });
  await until(() => last()?.phase === "idle", "idle reported");
  expect(new Set(reports.map((report) => report.token))).toEqual(
    new Set([LAUNCHER_TOKEN]),
  );
}, 20_000);

test("OpenBot answering a report signed out ends the recording as any sign-out does, everything kept for its person", async () => {
  connectedThroughDesktop();
  await recordFromPopup("Archive order 1043");
  await until(() => last()?.phase === "recording", "the recording reported");

  // OpenBot revoked this browser: the next report hears it (the connection check, 30 s apart too, still says ok).
  activityAnswer = "signed-out";
  await advanceTo(clock + ACTIVITY_REPORT_MS);
  await until(async () => (await state()).phase === "idle", "the stop");
  expect(await state()).toMatchObject({ phase: "idle", error: SIGNED_OUT });
  expect(fake.storage.local.get("connection")).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "revoked",
  });
  expect(
    (fake.storage.local.get("drains") as { kept?: object }[])[0]?.kept,
  ).toMatchObject({ waitingForReconnect: true });
}, 20_000);

test("a report OpenBot cannot take, or never answers, holds up and fails nothing: Record, the 30 s reports and Stop go on", async () => {
  connectedThroughDesktop();
  activityAnswer = "error";
  await recordFromPopup("Archive order 1043");
  await until(() => reports.length > 0, "a report sent");
  expect((await state()).phase).toBe("recording");

  activityAnswer = "hang";
  const before = reports.length;
  await advanceTo(clock + ACTIVITY_REPORT_MS);
  await until(() => reports.length > before, "the 30 s report sent");
  // Stop answers at once though OpenBot is still holding the report.
  const stopping = page({ type: "page.stop" });
  expect(await stopping).toEqual({ ok: true });
  expect((await state()).phase).toBe("idle");
  expect(fake.storage.local.get("connection")).toMatchObject({
    token: DESKTOP_TOKEN,
  });
}, 20_000);

test("a report OpenBot refuses as malformed (400, 415) is said in the worker's console and stops nothing: the next one still goes", async () => {
  connectedThroughDesktop();
  const said: unknown[][] = [];
  const spy = spyOn(console, "error").mockImplementation((...args) => {
    said.push(args);
  });
  try {
    activityAnswer = "bad-report";
    await recordFromPopup("Archive order 1043");
    await until(() => reports.length > 0, "a report sent");
    await until(
      () =>
        said.some(
          (args) => args[0] === "Recorder: OpenBot refused its activity report",
        ),
      "the refusal said",
    );
    activityAnswer = "not-json";
    const before = reports.length;
    await advanceTo(clock + ACTIVITY_REPORT_MS);
    await until(() => reports.length > before, "the 30 s report sent");
    await until(
      () =>
        said.filter(
          (args) => args[0] === "Recorder: OpenBot refused its activity report",
        ).length >= 2,
      "the second refusal said",
    );
  } finally {
    spy.mockRestore();
  }
  expect((await state()).phase).toBe("recording");
  expect(fake.storage.local.get("connection")).toMatchObject({
    token: DESKTOP_TOKEN,
  });
  expect(fake.storage.local.get("notice")).toBeUndefined();

  activityAnswer = "ok";
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  await until(() => last()?.phase === "idle", "idle reported");
}, 20_000);

test("a service worker that restarts while a recording runs reports it again, and goes on every 30 s", async () => {
  connectedThroughDesktop();
  await recordFromPopup("Archive order 1043");
  await until(() => last()?.phase === "recording", "the recording reported");
  const { recordingId } = await state();

  // Chrome stops the worker and wakes it again: its timers and memory go, storage stays.
  fake.restartServiceWorker();
  due = [];
  const before = reports.length;
  startWorker();
  await until(() => reports.length > before, "the restarted worker's report");
  expect(last()).toMatchObject({ phase: "recording", recordingId });
  await advanceTo(clock + ACTIVITY_REPORT_MS);
  await until(() => reports.length > before + 1, "its 30 s report");
  expect(last()).toMatchObject({ phase: "recording", recordingId });
}, 20_000);
