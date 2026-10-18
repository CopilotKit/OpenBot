import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import type { NetworkMode } from "../src/background/network";
import {
  installRecording,
  type RecordingDeps,
  recorderState,
} from "../src/background/recording";
import { recoverInterruptedRecording } from "../src/background/recovery";
import { installRouter } from "../src/background/router";
import {
  type BackgroundToOffscreen,
  IDLE_STATE,
  type PageResponse,
  PORT_CONTENT,
  PORT_OFFSCREEN,
  type RecorderState,
  type StreamSession,
} from "../src/protocol/messages";
import {
  openRecorderDatabase,
  requestToPromise,
  stepsNextKey,
  tx,
} from "../src/shared/database";
import { isRecordablePage } from "../src/shared/origin";
import type { DrainRecord } from "../src/shared/storage";
import {
  type ChromeFake,
  type FakePort,
  installChromeFake,
} from "./support/chrome-fake";

const EXTENSION_ID = "test";
const OFFSCREEN_SENDER = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/offscreen.html`,
};
const ada = { id: "p1", name: "Ada", email: "ada@example.test" };
const DEAL = "https://crm.example.test/deals/42";
const NEXT_DEAL = "https://crm.example.test/deals/43";
const SCREEN_RESTARTED =
  "The screen recording stopped when Chrome restarted the Recorder in the background.";
const STOPPED_IN_OPENBOT =
  "This recording was stopped in OpenBot. Everything until then was saved.";
const SIGNED_OUT =
  "This browser was disconnected from OpenBot. Your recording stopped, and everything in it is kept in this browser until you connect again.";
const START_FAILED = "The recording could not start. Try again.";
/** A card number typed into a sensitive field before the restart, and the digest the content script sent for it. */
const SECRET = "4111111111111111";
const SECRET_DIGEST = "ab".repeat(32);

const click = (name: string): DemonstrationAction => ({
  kind: "click",
  url: DEAL,
  target: { role: "button", name, sensitive: false },
});
const capturedEvent = (name: string, value: unknown): CapturedEvent => ({
  type: "CUSTOM",
  name,
  timestamp: 1_700_000_000_000,
  value: value as CapturedEvent["value"],
});

// ---- The fake OpenBot -------------------------------------------------------------------------

type Call = { method: string; path: string; body: unknown };
type Batch = { fromIndex: number; actions: DemonstrationAction[] };

const openbot = {
  calls: [] as Call[],
  held: new Map<string, number>(),
  nextDemo: 0,
  /** While set, stop answers wait for it. */
  holdStop: null as Promise<void> | null,
};

let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      openbot.calls.push({
        method: request.method,
        path: url.pathname,
        body: text ? JSON.parse(text) : undefined,
      });
      const { method } = request;
      const demonstration = (id: string, status: string) => ({
        id,
        botId: "bot-1",
        title: "Update deal",
        source: "extension",
        status,
        actionCount: openbot.held.get(id) ?? 0,
        learning: null,
      });
      if (method === "POST" && url.pathname === "/api/recorder/demonstrations")
        return Response.json(
          {
            demonstration: demonstration(
              `demo-${++openbot.nextDemo}`,
              "recording",
            ),
          },
          { status: 201 },
        );
      const match =
        /^\/api\/recorder\/demonstrations\/([^/]+)(\/[a-z]+)?$/.exec(
          url.pathname,
        );
      if (!match) return new Response("nope", { status: 404 });
      const id = match[1] as string;
      const rest = match[2];
      if (method === "DELETE" && rest === undefined)
        return new Response(null, { status: 204 });
      if (method === "POST" && rest === "/trajectories")
        return new Response(null, { status: 204 });
      if (method === "POST" && rest === "/stop") {
        if (openbot.holdStop) await openbot.holdStop;
        return Response.json({ demonstration: demonstration(id, "stopped") });
      }
      if (method === "POST" && rest === "/actions") {
        const batch = JSON.parse(text) as Batch;
        const held = openbot.held.get(id) ?? 0;
        if (batch.fromIndex !== held)
          return Response.json({ error: "Gap.", count: held }, { status: 409 });
        openbot.held.set(id, held + batch.actions.length);
        return Response.json({ count: held + batch.actions.length });
      }
      return new Response("nope", { status: 404 });
    },
  });
  origin = server.url.origin;
});
afterAll(() => server.stop(true));

const requests = () => openbot.calls.map((c) => `${c.method} ${c.path}`);
const demoPath = (id: string, rest = "") =>
  `/api/recorder/demonstrations/${id}${rest}`;

// ---- Time, the offscreen document and the doubles -------------------------------------------

let now = 1_800_000_000_000;
type Timer = { id: number; at: number; fn: () => void };
let timers: Timer[] = [];
let timerId = 0;
const fakeTimers = {
  set(fn: () => void, ms: number) {
    timerId += 1;
    timers.push({ id: timerId, at: now + ms, fn });
    return timerId;
  },
  clear(handle: unknown) {
    timers = timers.filter((timer) => timer.id !== handle);
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(25);
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
    await sleep(2);
  }
}
/** Moves the clock, firing every fake timer that falls due on the way, in order. */
async function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const due = timers
      .filter((timer) => timer.at <= end)
      .sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((timer) => timer !== due);
    now = due.at;
    due.fn();
    await settle();
  }
  now = end;
}
function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

let fake: ChromeFake;
type Indexed = { indexedDB?: IDBFactory; IDBKeyRange?: typeof FakeIDBKeyRange };
const indexedGlobals = globalThis as unknown as Indexed;
let savedIndexed: Indexed = {};
let dbCounter = 0;
let dbName = "";

/** The offscreen document: it says ready on every port it opens, and answers offscreen.stop unless `holdStop` is set. */
let doc: FakePort | null = null;
let docSeen = 0;
let docDemo = "";
let holdStop = false;
let heldStops: string[] = [];
let docPoll: ReturnType<typeof setInterval> | undefined;
function openDocumentPort(): FakePort {
  const port = fake.connectFrom(PORT_OFFSCREEN, OFFSCREEN_SENDER);
  doc = port;
  docSeen = 0;
  port.postMessage({ type: "offscreen.ready" });
  return port;
}
function answerAsDocument() {
  if (!doc) return;
  while (docSeen < doc.messages.length) {
    const message = doc.messages[docSeen++] as BackgroundToOffscreen;
    if (
      message.type === "offscreen.start" ||
      message.type === "offscreen.resume"
    )
      docDemo = message.session.demonstrationId;
    if (message.type === "offscreen.stop") {
      if (holdStop) heldStops.push(docDemo);
      else
        doc.postMessage({
          type: "offscreen.stopped",
          demonstrationId: docDemo,
          trajectoryIds: [],
        });
    }
  }
}
const toDocument = (port: FakePort | null = doc) =>
  (port?.messages ?? []) as BackgroundToOffscreen[];
const sentToDocument = (type: string, port: FakePort | null = doc) =>
  toDocument(port).filter((message) => message.type === type);

let network: {
  resumed: { tabId: number; url: string }[][];
  resumeMode: NetworkMode;
  recorded: CapturedEvent[];
};
let masked: string[][] = [];

function doubles(): Partial<RecordingDeps> {
  return {
    createNetworkCapture: () => ({
      start: async (_tabId, url) =>
        isRecordablePage(url) ? "debugger" : "waiting",
      addTab: async () => {},
      onCommitted: async () => {},
      resume: async (tabs) => {
        network.resumed.push(tabs);
        return network.resumeMode;
      },
      recordPageEvent: async (event) => {
        network.recorded.push(event);
      },
      stop: async () => {},
    }),
    createPageFallback: () => ({
      start: async () => false,
      addTab: async () => {},
      onCommitted: async () => {},
      stop: async () => {},
      active: () => false,
    }),
    // Stands in for Task 18's masking: a value whose digest the content script reported is redacted.
    acceptPageNetworkEvent: (event, digests) => {
      masked.push([...digests]);
      const value = digests.has(SECRET_DIGEST)
        ? JSON.parse(
            JSON.stringify(event.value).replaceAll(SECRET, "[redacted]"),
          )
        : event.value;
      return { event: { ...event, value }, step: null };
    },
    acquireTabStreamId: async (tabId) =>
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
    recoverNetworkBodies: async () => {},
    readPolicy: async () => ({
      openbotUrl: null,
      openbotUrlInvalid: false,
      allowedIntelligenceUrls: null,
    }),
    hasHostPermission: async () => true,
    now: () => now,
    openDatabase: () => openRecorderDatabase(dbName),
    timers: fakeTimers,
  };
}

let handlers: ReturnType<typeof installRecording>;
function startWorker() {
  handlers = installRecording(doubles());
  installRouter(handlers);
}

/** Chrome stops the service worker and starts it again: its listeners, timers and ports go, while storage.session,
 * storage.local, IndexedDB and the offscreen document stay. */
async function restartWorker() {
  await settle();
  fake.restartServiceWorker();
  timers = [];
  doc = null;
  openbot.calls = [];
  startWorker();
}

function connect(user = ada, token = "obr_one") {
  fake.storage.local.set("connection", {
    openbotUrl: origin,
    token,
    connectionId: `c-${token}`,
    user,
    via: "web",
    connectedAt: now,
  });
}

const page = (message: object) =>
  fake.sendFromPage(message) as Promise<PageResponse & { error?: string }>;
const state = () => recorderState();
const drains = () =>
  (fake.storage.local.get("drains") as DrainRecord[] | undefined) ?? [];
const contentPort = (tabId: number, url = DEAL) =>
  fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId: 0,
    url,
  });

async function startRecording(tabId = 7) {
  fake.tabs.set(tabId, { id: tabId, url: DEAL } as chrome.tabs.Tab);
  const answer = await page({
    type: "page.record",
    botId: "bot-1",
    title: "Update deal",
    tabId,
    microphone: false,
  });
  expect(answer).toEqual({ ok: true });
  return `demo-${openbot.nextDemo}`;
}

async function storedSteps(demonstrationId: string) {
  const db = await openRecorderDatabase(dbName);
  try {
    return await requestToPromise<{ action: DemonstrationAction }[]>(
      db
        .transaction("steps", "readonly")
        .objectStore("steps")
        .getAll(
          IDBKeyRange.bound(
            [demonstrationId, -Infinity],
            [demonstrationId, Infinity],
          ),
        ),
    );
  } finally {
    db.close();
  }
}

/** A recording with a queued click besides its first step, then Stop, which the document has not answered yet. */
async function recordThenStop() {
  const id = await startRecording(7);
  contentPort(7).postMessage({ type: "content.step", action: click("Save") });
  await until(
    async () => (await storedSteps(id)).length === 2,
    "two steps queued",
  );
  holdStop = true;
  void page({ type: "page.stop" });
  await until(() => heldStops.length === 1, "the document heard the stop");
  expect((await state()).stopping?.stage).toBe("draining");
  return id;
}

// ---- What a previous service worker persisted -----------------------------------------------

const DEMO = "demo-9";
const seededRecord = (): DrainRecord => ({
  demonstrationId: DEMO,
  botId: "bot-1",
  title: "Update deal",
  openbotUrl: origin,
  userId: ada.id,
  userName: ada.name,
  trajectoryIds: ["00000000-0000-4000-8000-000000000009"],
  startedAt: now - 60_000,
  discard: false,
});

/** Writes what a service worker that went away persisted for `demo-9`, with the document still open unless told. */
function seed(
  recorder: Partial<RecorderState>,
  options: { activeRecording?: boolean; document?: boolean } = {},
) {
  const active = seededRecord();
  if (options.activeRecording ?? true)
    fake.storage.local.set("activeRecording", active);
  fake.storage.session.set("recorder", {
    ...IDLE_STATE,
    demonstrationId: DEMO,
    botId: "bot-1",
    title: "Update deal",
    tabIds: [7],
    topUrls: { "7": DEAL },
    startedAt: active.startedAt,
    steps: 1,
    capture: {
      intelligence: "streaming",
      network: "debugger",
      screen: "recording",
      voice: "off",
    },
    ...recorder,
  });
  fake.storage.session.set("stream", {
    demonstrationId: DEMO,
    title: "Update deal",
    botId: "bot-1",
    openbotUrl: origin,
    token: "obr_one",
    trajectoryId: active.trajectoryIds[0],
    startedAt: active.startedAt,
    allowedIntelligenceUrls: null,
    version: "0.3.0",
    media: { tabStreamId: null, microphone: false },
  } satisfies StreamSession);
  fake.offscreen.open = options.document ?? true;
  docDemo = DEMO;
}

async function queueSteps(
  demonstrationId: string,
  actions: DemonstrationAction[],
) {
  const db = await openRecorderDatabase(dbName);
  try {
    await tx(db, ["steps", "meta"], "readwrite", (t) => {
      actions.forEach((action, index) => {
        t.objectStore("steps").put({ demonstrationId, index, action });
      });
      t.objectStore("meta").put(actions.length, stepsNextKey(demonstrationId));
    });
  } finally {
    db.close();
  }
}

beforeEach(() => {
  savedIndexed = {
    indexedDB: indexedGlobals.indexedDB,
    IDBKeyRange: indexedGlobals.IDBKeyRange,
  };
  indexedGlobals.indexedDB = new IDBFactory();
  indexedGlobals.IDBKeyRange = FakeIDBKeyRange;
  dbName = `resume-test-${++dbCounter}`;
  fake = installChromeFake({
    extensionId: EXTENSION_ID,
    manifestVersion: "0.3.0",
  });
  fake.offscreen.onDocumentCreated.addListener(() => {
    setTimeout(openDocumentPort, 0);
  });
  fake.offscreen.onDocumentClosed.addListener(() => {
    doc?.disconnect();
    doc = null;
  });
  doc = null;
  docDemo = "";
  holdStop = false;
  heldStops = [];
  docPoll = setInterval(answerAsDocument, 1);
  timers = [];
  now = 1_800_000_000_000;
  openbot.calls = [];
  openbot.held = new Map();
  openbot.nextDemo = 0;
  openbot.holdStop = null;
  network = { resumed: [], resumeMode: "debugger", recorded: [] };
  masked = [];
  connect();
});

afterEach(async () => {
  clearInterval(docPoll);
  await settle();
  fake.uninstall();
  indexedGlobals.indexedDB = savedIndexed.indexedDB;
  indexedGlobals.IDBKeyRange = savedIndexed.IDBKeyRange;
});

// ---- A restart in the middle of a Stop -------------------------------------------------------

test("a service-worker restart during Stop finishes the stop: draining with the document alive", async () => {
  startWorker();
  const id = await recordThenStop();
  await restartWorker();
  // The document reconnects its port with its backoff and says ready again.
  const port = openDocumentPort();
  const recovering = recoverInterruptedRecording();
  await until(() => heldStops.length === 2, "the stop told again");
  expect(sentToDocument("offscreen.stop", port)).toEqual([
    { type: "offscreen.stop", outcome: "succeeded" },
  ]);
  await settle();
  expect(requests()).toEqual([]); // OpenBot hears of the stop only once the document stopped

  port.postMessage({
    type: "offscreen.stopped",
    demonstrationId: id,
    trajectoryIds: [],
  });
  await recovering;
  expect(requests()).toEqual([
    `POST ${demoPath(id, "/actions")}`,
    `POST ${demoPath(id, "/stop")}`,
  ]);
  expect(await storedSteps(id)).toEqual([]);
  const after = await state();
  expect(after.phase).toBe("idle");
  expect(after.stopping).toBeUndefined();
  expect(after.lastStopped).toEqual({
    demonstrationId: id,
    botId: "bot-1",
    openbotUrl: origin,
  });
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect(fake.storage.session.get("stream")).toBeUndefined();
  expect(
    drains().map((drain) => [drain.demonstrationId, drain.stopPending]),
  ).toEqual([[id, undefined]]);
  // The document is asked to report on it again: an offscreen.done it sent before the restart went with the old worker.
  expect(sentToDocument("offscreen.recover", port)).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      drains: drains(),
    },
  ]);
  port.postMessage({ type: "offscreen.done", demonstrationId: id });
  await until(() => drains().length === 0, "the drain forgotten");
});

test("a service-worker restart during Stop finishes the stop: draining with no document", async () => {
  startWorker();
  const id = await recordThenStop();
  const stored = fake.storage.session.get("stream") as StreamSession;
  await chrome.offscreen.closeDocument(); // the document went away too
  await restartWorker();
  holdStop = false;
  await recoverInterruptedRecording();

  expect(toDocument().map((message) => message.type)).toEqual([
    "offscreen.resume",
    "offscreen.stop",
    "offscreen.recover",
  ]);
  expect(sentToDocument("offscreen.resume")).toEqual([
    {
      type: "offscreen.resume",
      session: { ...stored, media: { tabStreamId: null, microphone: false } },
    },
  ]);
  expect(requests()).toEqual([
    `POST ${demoPath(id, "/actions")}`,
    `POST ${demoPath(id, "/stop")}`,
  ]);
  expect((await state()).phase).toBe("idle");
  expect(drains().map((drain) => drain.demonstrationId)).toEqual([id]);
});

test("a service-worker restart during Stop finishes the stop: telling OpenBot", async () => {
  seed({
    phase: "stopping",
    stopping: { since: now - 5_000, stage: "telling-openbot" },
  });
  startWorker();
  const port = openDocumentPort();
  await recoverInterruptedRecording();

  expect(requests()).toEqual([`POST ${demoPath(DEMO, "/stop")}`]);
  expect(sentToDocument("offscreen.stop", port)).toEqual([]);
  expect(sentToDocument("offscreen.resume", port)).toEqual([]);
  expect((await state()).phase).toBe("idle");
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect(drains()).toEqual([seededRecord()]);
});

test("a service-worker restart during Stop finishes the stop: stopped from OpenBot sends no stop", async () => {
  seed({
    phase: "stopping",
    stopping: { since: now - 5_000, stage: "draining", stoppedFrom: "openbot" },
  });
  // A step recorded after the recording was stopped in OpenBot, which refuses it.
  await queueSteps(DEMO, [click("Too late")]);
  startWorker();
  const port = openDocumentPort();
  await recoverInterruptedRecording();

  expect(sentToDocument("offscreen.stop", port)).toEqual([
    { type: "offscreen.stop", outcome: "succeeded", stoppedFrom: "openbot" },
  ]);
  expect(requests()).toEqual([]);
  expect(await storedSteps(DEMO)).toEqual([]);
  const after = await state();
  expect(after.phase).toBe("idle");
  expect(after.error).toBe(STOPPED_IN_OPENBOT);
  expect(drains().map((drain) => drain.demonstrationId)).toEqual([DEMO]);
});

test("a stop whose persisted start is over 120 s old skips the wait", async () => {
  seed({
    phase: "stopping",
    stopping: { since: now - 121_000, stage: "draining" },
  });
  holdStop = true; // the document never answers
  startWorker();
  const port = openDocumentPort();
  await recoverInterruptedRecording(); // no clock advance needed

  expect(sentToDocument("offscreen.stop", port)).toHaveLength(1);
  expect(requests()).toEqual([`POST ${demoPath(DEMO, "/stop")}`]);
  expect((await state()).phase).toBe("idle");
  expect(drains().map((drain) => drain.demonstrationId)).toEqual([DEMO]);
});

test("a resumed stop waits only for what is left of the 120 seconds", async () => {
  seed({
    phase: "stopping",
    stopping: { since: now - 119_000, stage: "draining" },
  });
  holdStop = true;
  startWorker();
  openDocumentPort();
  let finished = false;
  const recovering = recoverInterruptedRecording().then(() => {
    finished = true;
  });
  await until(() => heldStops.length === 1, "the stop told again");
  await settle();
  expect(finished).toBe(false);
  expect(requests()).toEqual([]);

  await advance(1_000);
  await recovering;
  expect(requests()).toEqual([`POST ${demoPath(DEMO, "/stop")}`]);
  expect((await state()).phase).toBe("idle");
});

test("a service-worker restart just after Stop moved the recording into the drains only finishes", async () => {
  seed(
    {
      phase: "stopping",
      stopping: { since: now - 5_000, stage: "telling-openbot" },
    },
    { activeRecording: false },
  );
  fake.storage.local.set("drains", [seededRecord()]);
  startWorker();
  const port = openDocumentPort();
  await recoverInterruptedRecording();

  expect(requests()).toEqual([]);
  const after = await state();
  expect(after.phase).toBe("idle");
  expect(after.lastStopped).toEqual({
    demonstrationId: DEMO,
    botId: "bot-1",
    openbotUrl: origin,
  });
  expect(drains()).toEqual([seededRecord()]);
  expect(sentToDocument("offscreen.recover", port)).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      drains: [seededRecord()],
    },
  ]);
});

test("Disconnect waits for a resumed stop and discards the recording it finished", async () => {
  seed({
    phase: "stopping",
    stopping: { since: now - 5_000, stage: "telling-openbot" },
  });
  const stopAnswer = gate();
  openbot.holdStop = stopAnswer.promise;
  startWorker();
  openDocumentPort();
  const recovering = recoverInterruptedRecording();
  await until(
    () => requests().includes(`POST ${demoPath(DEMO, "/stop")}`),
    "the stop sent",
  );
  // The person disconnects (the router calls this once the connection is gone).
  fake.storage.local.delete("connection");
  let disconnected = false;
  const disconnecting = handlers.disconnected().then(() => {
    disconnected = true;
  });
  await settle();
  expect(disconnected).toBe(false);

  stopAnswer.open();
  await recovering;
  await disconnecting;
  expect(sentToDocument("offscreen.discard")).toEqual([
    { type: "offscreen.discard", demonstrationIds: [DEMO] },
  ]);
  expect(drains()).toEqual([]);
  expect((await state()).phase).toBe("idle");
});

// ---- A restart in the middle of Record -------------------------------------------------------

test("a service-worker restart in the middle of Record rolls it back, and Record works again", async () => {
  seed({ phase: "starting", demonstrationId: undefined, tabIds: [] });
  startWorker();
  const port = openDocumentPort();
  await recoverInterruptedRecording();

  expect(sentToDocument("offscreen.stop", port)).toEqual([
    { type: "offscreen.stop", outcome: "failed" },
  ]);
  expect(requests()).toEqual([`DELETE ${demoPath(DEMO)}`]);
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect(fake.storage.session.get("stream")).toBeUndefined();
  expect(drains()).toEqual([]);
  const after = await state();
  expect(after.phase).toBe("idle");
  expect(after.error).toBe(START_FAILED);
  await until(() => !fake.offscreen.open, "the document closed");

  openbot.calls = [];
  const id = await startRecording(7);
  expect((await state()).phase).toBe("recording");
  expect(requests()).toEqual([
    "POST /api/recorder/demonstrations",
    `POST ${demoPath(id, "/trajectories")}`,
  ]);
});

// ---- A restart while recording ---------------------------------------------------------------

test("a service-worker restart with no document resumes it with the stored session and marks the screen failed", async () => {
  startWorker();
  await startRecording(7);
  const stored = fake.storage.session.get("stream") as StreamSession;
  doc?.postMessage({
    type: "offscreen.status",
    trajectoryId: stored.trajectoryId,
    capture: { screen: "recording" },
  });
  await until(
    async () => (await state()).capture.screen === "recording",
    "the screen recording",
  );
  await chrome.offscreen.closeDocument();
  await restartWorker();
  const mark = fake.calls.length;
  await recoverInterruptedRecording();

  expect(fake.calls.slice(mark)).toContain("offscreen.createDocument");
  expect(toDocument()).toEqual([
    {
      type: "offscreen.resume",
      session: { ...stored, media: { tabStreamId: null, microphone: false } },
    },
  ]);
  const after = await state();
  expect(after.phase).toBe("recording");
  expect(after.capture.screen).toBe("failed");
  expect(after.capture.screenReason).toBe(SCREEN_RESTARTED);
  expect(network.resumed).toEqual([[{ tabId: 7, url: DEAL }]]);
});

test("a service-worker restart with the document alive posts nothing to it", async () => {
  startWorker();
  await startRecording(7);
  await restartWorker();
  const port = openDocumentPort();
  const mark = fake.calls.length;
  await recoverInterruptedRecording();
  await settle();

  expect(toDocument(port)).toEqual([]);
  expect(fake.calls.slice(mark)).not.toContain("offscreen.createDocument");
  expect(network.resumed).toEqual([[{ tabId: 7, url: DEAL }]]);
  const after = await state();
  expect(after.phase).toBe("recording");
  expect(after.capture.screen).not.toBe("failed");
});

test("a service-worker restart restores followed tabs, digests and network capture", async () => {
  startWorker();
  const id = await startRecording(7);
  fake.tabs.set(8, { id: 8, url: NEXT_DEAL } as chrome.tabs.Tab);
  fake.webNavigation.createdTarget({
    sourceTabId: 7,
    tabId: 8,
    url: NEXT_DEAL,
  });
  await until(
    async () => (await state()).tabIds.length === 2,
    "tab 8 followed",
  );
  contentPort(7).postMessage({
    type: "content.sensitive",
    digest: SECRET_DIGEST,
  });
  await until(
    () =>
      (fake.storage.session.get("digests") as string[] | undefined)?.includes(
        SECRET_DIGEST,
      ) ?? false,
    "the digest kept",
  );
  await restartWorker();
  const port = openDocumentPort();
  network.resumeMode = "page";
  await recoverInterruptedRecording();

  expect(network.resumed).toEqual([
    [
      { tabId: 7, url: DEAL },
      { tabId: 8, url: NEXT_DEAL },
    ],
  ]);

  // A page-level body from tab 8 is masked with the digest from before the restart.
  const answer = await fake.sendExternal(
    {
      type: "recorder.page-network",
      event: capturedEvent("network", {
        url: "https://crm.example.test/api/cards",
        requestBody: `{"card":"${SECRET}"}`,
      }),
    },
    {
      tab: { id: 8 } as chrome.tabs.Tab,
      url: NEXT_DEAL,
      origin: "https://crm.example.test",
    },
  );
  expect(answer).toEqual({ ok: true });
  expect(masked).toEqual([[SECRET_DIGEST]]);
  expect(JSON.stringify(network.recorded)).not.toContain(SECRET);
  expect(network.recorded).toEqual([
    capturedEvent("network", {
      url: "https://crm.example.test/api/cards",
      requestBody: '{"card":"[redacted]"}',
    }),
  ]);

  // Tab 8's content script reconnects, is told to capture, and its events still reach the document.
  const tab8 = contentPort(8, NEXT_DEAL);
  tab8.postMessage({ type: "content.hello", top: true, url: NEXT_DEAL });
  tab8.postMessage({
    type: "content.event",
    event: capturedEvent("click", { text: "Save" }),
  });
  await until(
    () => sentToDocument("offscreen.event", port).length === 1,
    "the event forwarded",
  );
  expect(tab8.messages).toContainEqual({
    type: "background.capture",
    active: true,
    demonstrationId: id,
  });
});

test("a service-worker restart whose recording lost its connection stops it and keeps it for its person", async () => {
  startWorker();
  const id = await startRecording(7);
  contentPort(7).postMessage({ type: "content.step", action: click("Save") });
  await until(
    async () => (await storedSteps(id)).length === 2,
    "two steps queued",
  );
  // The popup's /me refresh found the connection revoked while the recording ran on.
  fake.storage.local.delete("connection");
  fake.storage.local.set("notice", {
    kind: "signed-out",
    at: now,
    reason: "revoked",
  });
  await restartWorker();
  const port = openDocumentPort();
  await recoverInterruptedRecording();

  expect(requests()).toEqual([]);
  expect(sentToDocument("offscreen.stop", port)).toEqual([
    { type: "offscreen.stop", outcome: "succeeded" },
  ]);
  expect(network.resumed).toEqual([]);
  expect(await storedSteps(id)).toHaveLength(2);
  const after = await state();
  expect(after.phase).toBe("idle");
  expect(after.error).toBe(SIGNED_OUT);
  expect(drains()).toEqual([
    expect.objectContaining({
      demonstrationId: id,
      stopPending: true,
      kept: expect.objectContaining({ waitingForReconnect: true }),
    }),
  ]);
});
