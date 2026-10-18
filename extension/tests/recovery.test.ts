import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import { RECORDER_SIGNED_OUT } from "@openbot/shared/recorder-api";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import { ensureOffscreenDocument } from "../src/background/offscreen-document";
import {
  installRecording,
  type RecordingDeps,
  recorderState,
} from "../src/background/recording";
import { recoverInterruptedRecording } from "../src/background/recovery";
import { installRouter } from "../src/background/router";
import {
  type BackgroundToOffscreen,
  type PageResponse,
  PORT_CONTENT,
  PORT_OFFSCREEN,
} from "../src/protocol/messages";
import {
  openRecorderDatabase,
  requestToPromise,
  stepsNextKey,
  tx,
} from "../src/shared/database";
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
const bea = { id: "p2", name: "Bea", email: "bea@example.test" };
const DEAL = "https://crm.example.test/deals/42";
const KEPT_SIGNED_OUT = "This browser was disconnected from OpenBot.";

const click = (name: string): DemonstrationAction => ({
  kind: "click",
  url: DEAL,
  target: { role: "button", name, sensitive: false },
});

// ---- The fake OpenBot -------------------------------------------------------------------------

type Call = {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
};
type Batch = { fromIndex: number; actions: DemonstrationAction[] };

const openbot = {
  calls: [] as Call[],
  held: new Map<string, number>(),
  nextDemo: 0,
  /** Recordings deleted in OpenBot: every request about one is answered 404. */
  gone: new Set<string>(),
  /** Every request is answered with the recorder guard's signed-out 401. */
  signedOut: false,
};
/** OpenBot's requests, the network-body recoveries and what the document received, in order. */
let timeline: string[] = [];

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
        auth: request.headers.get("authorization"),
        body: text ? JSON.parse(text) : undefined,
      });
      timeline.push(`${request.method} ${url.pathname}`);
      if (openbot.signedOut)
        return Response.json(
          {
            error: "Connect this browser again.",
            code: RECORDER_SIGNED_OUT,
            reason: "revoked",
          },
          { status: 401 },
        );
      const { method } = request;
      if (method === "POST" && url.pathname === "/api/recorder/demonstrations")
        return Response.json(
          {
            demonstration: {
              id: `demo-${++openbot.nextDemo}`,
              botId: "bot-1",
              title: "Update deal",
              source: "extension",
              status: "recording",
              actionCount: 0,
              learning: null,
            },
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
      if (openbot.gone.has(id))
        return Response.json(
          { error: "This recording was deleted." },
          { status: 404 },
        );
      if (method === "DELETE" && rest === undefined)
        return new Response(null, { status: 204 });
      if (method === "POST" && rest === "/trajectories")
        return new Response(null, { status: 204 });
      if (method === "POST" && rest === "/stop")
        return Response.json({
          demonstration: {
            id,
            botId: "bot-1",
            title: "Update deal",
            source: "extension",
            status: "stopped",
            actionCount: openbot.held.get(id) ?? 0,
            learning: null,
          },
        });
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
const sentActions = (id: string) =>
  openbot.calls
    .filter((c) => c.path === demoPath(id, "/actions"))
    .flatMap((c) => (c.body as Batch).actions);

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

let fake: ChromeFake;
type Indexed = { indexedDB?: IDBFactory; IDBKeyRange?: typeof FakeIDBKeyRange };
const indexedGlobals = globalThis as unknown as Indexed;
let savedIndexed: Indexed = {};
let dbCounter = 0;
let dbName = "";

/** The offscreen document: it connects and says ready once Chrome created it, and answers offscreen.stop. */
let doc: FakePort | null = null;
let docSeen = 0;
let docDemo = "";
let docPoll: ReturnType<typeof setInterval> | undefined;
function openDocument() {
  doc = fake.connectFrom(PORT_OFFSCREEN, OFFSCREEN_SENDER);
  docSeen = 0;
  doc.postMessage({ type: "offscreen.ready" });
}
function answerAsDocument() {
  if (!doc) return;
  while (docSeen < doc.messages.length) {
    const message = doc.messages[docSeen++] as BackgroundToOffscreen;
    timeline.push(`document ${message.type}`);
    if (message.type === "offscreen.start")
      docDemo = message.session.demonstrationId;
    if (message.type === "offscreen.rotate") docDemo = message.demonstrationId;
    if (message.type === "offscreen.stop")
      doc.postMessage({
        type: "offscreen.stopped",
        demonstrationId: docDemo,
        trajectoryIds: [],
      });
  }
}
const toDocument = (port: FakePort | null = doc) =>
  (port?.messages ?? []) as BackgroundToOffscreen[];
const sentToDocument = (type: string) =>
  toDocument().filter((message) => message.type === type);

let bodies: {
  demonstrationId: string;
  target: { openbotUrl: string; token: string };
}[] = [];

function doubles(): Partial<RecordingDeps> {
  return {
    createNetworkCapture: () => ({
      start: async () => "debugger",
      addTab: async () => {},
      onCommitted: async () => {},
      resume: async () => "debugger",
      recordPageEvent: async () => {},
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
    acquireTabStreamId: async (tabId) =>
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
    recoverNetworkBodies: async (drain, target) => {
      bodies.push({ demonstrationId: drain.demonstrationId, target });
      timeline.push(`bodies ${drain.demonstrationId}`);
    },
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

/** A browser restart: the service worker, storage.session, the document and every timer go; storage.local and
 * IndexedDB stay. */
async function restartBrowser() {
  await settle();
  fake.restartServiceWorker();
  fake.storage.session.clear();
  fake.offscreen.open = false;
  doc = null;
  timers = [];
  openbot.calls = [];
  timeline = [];
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
const drains = () =>
  (fake.storage.local.get("drains") as DrainRecord[] | undefined) ?? [];
const contentPort = (tabId: number) =>
  fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId: 0,
    url: DEAL,
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

/** Steps a previous browser session queued and never sent. */
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

/** A recording with three queued steps (the page it started on and two clicks), then a browser restart. */
async function recordThenRestartBrowser() {
  const id = await startRecording(7);
  const tab = contentPort(7);
  tab.postMessage({ type: "content.step", action: click("Edit") });
  tab.postMessage({ type: "content.step", action: click("Save") });
  await until(
    async () => (await storedSteps(id)).length === 3,
    "three steps queued",
  );
  await restartBrowser();
  return id;
}

beforeEach(() => {
  savedIndexed = {
    indexedDB: indexedGlobals.indexedDB,
    IDBKeyRange: indexedGlobals.IDBKeyRange,
  };
  indexedGlobals.indexedDB = new IDBFactory();
  indexedGlobals.IDBKeyRange = FakeIDBKeyRange;
  dbName = `recovery-test-${++dbCounter}`;
  fake = installChromeFake({ extensionId: EXTENSION_ID });
  fake.offscreen.onDocumentCreated.addListener(() => {
    setTimeout(openDocument, 0);
  });
  fake.offscreen.onDocumentClosed.addListener(() => {
    doc?.disconnect();
    doc = null;
  });
  doc = null;
  docDemo = "";
  docPoll = setInterval(answerAsDocument, 1);
  timers = [];
  timeline = [];
  bodies = [];
  now = 1_800_000_000_000;
  openbot.calls = [];
  openbot.held = new Map();
  openbot.nextDemo = 0;
  openbot.gone = new Set();
  openbot.signedOut = false;
  connect();
  startWorker();
});

afterEach(async () => {
  clearInterval(docPoll);
  await settle();
  fake.uninstall();
  indexedGlobals.indexedDB = savedIndexed.indexedDB;
  indexedGlobals.IDBKeyRange = savedIndexed.IDBKeyRange;
});

// ---- A browser restart mid-recording ---------------------------------------------------------

test("a browser restart mid-recording uploads its queued steps, stops the dangling recording, reopens the document and forgets it only after offscreen.done", async () => {
  const id = await recordThenRestartBrowser();
  startWorker();
  await recoverInterruptedRecording();

  expect(timeline.filter((entry) => !entry.startsWith("document "))).toEqual([
    `POST ${demoPath(id, "/actions")}`,
    `POST ${demoPath(id, "/stop")}`,
    `bodies ${id}`,
  ]);
  expect(sentActions(id).map((action) => action.kind)).toEqual([
    "navigate",
    "click",
    "click",
  ]);
  expect(openbot.calls.every((c) => c.auth === "Bearer obr_one")).toBe(true);
  expect(await storedSteps(id)).toEqual([]);
  expect(bodies).toEqual([
    { demonstrationId: id, target: { openbotUrl: origin, token: "obr_one" } },
  ]);
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect(fake.storage.local.get("notice")).toEqual({
    kind: "interrupted",
    at: now,
  });
  const [drain] = drains();
  expect(drains()).toHaveLength(1);
  expect(drain?.demonstrationId).toBe(id);
  expect(drain?.stopPending).toBeUndefined();
  expect(drain?.discard).toBe(false);
  expect(sentToDocument("offscreen.recover")).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      drains: drains(),
    },
  ]);
  const state = await recorderState();
  expect(state.phase).toBe("idle");
  expect(state.draining).toBe(1);

  // Still there until the document has sent everything; then forgotten, and the document closes.
  await settle();
  expect(drains()).toHaveLength(1);
  expect(fake.offscreen.open).toBe(true);
  doc?.postMessage({ type: "offscreen.done", demonstrationId: id });
  await until(() => drains().length === 0, "the drain forgotten");
  await until(() => !fake.offscreen.open, "the document closed");
  expect((await recorderState()).draining).toBe(0);
});

test("a 404 while recovering still drains and clears", async () => {
  const id = await recordThenRestartBrowser();
  openbot.gone.add(id); // the person deleted it in OpenBot meanwhile
  startWorker();
  await recoverInterruptedRecording();

  expect(requests()).toEqual([
    `POST ${demoPath(id, "/actions")}`,
    `POST ${demoPath(id, "/stop")}`,
  ]);
  expect(await storedSteps(id)).toEqual([]); // refused because it is gone: dropped
  expect(drains().map((drain) => drain.stopPending)).toEqual([undefined]);
  expect(sentToDocument("offscreen.recover")).toHaveLength(1);
  doc?.postMessage({ type: "offscreen.done", demonstrationId: id });
  await until(() => drains().length === 0, "the drain forgotten");
});

test("a signed-out answer while recovering keeps the queued data for the person", async () => {
  const id = await recordThenRestartBrowser();
  openbot.signedOut = true;
  startWorker();
  const mark = fake.calls.length;
  await recoverInterruptedRecording();

  expect(requests()).toEqual([`POST ${demoPath(id, "/actions")}`]);
  expect(await storedSteps(id)).toHaveLength(3);
  expect(fake.storage.local.get("connection")).toBeUndefined();
  expect(fake.storage.local.get("notice")).toEqual(
    expect.objectContaining({ kind: "signed-out", reason: "revoked" }),
  );
  expect(drains()).toEqual([
    expect.objectContaining({
      demonstrationId: id,
      stopPending: true,
      kept: {
        reason: KEPT_SIGNED_OUT,
        parked: true,
        events: 0,
        at: now,
        waitingForReconnect: true,
      },
    }),
  ]);
  expect((await recorderState()).kept?.waitingFor).toEqual({
    name: "Ada",
    recordings: 1,
  });
  expect(fake.calls.slice(mark)).not.toContain("offscreen.createDocument");
  expect(fake.calls.slice(mark)).not.toContain(
    `port:${PORT_OFFSCREEN} offscreen.discard`,
  );

  // Connecting again as the same person sends everything that was kept.
  openbot.signedOut = false;
  openbot.calls = [];
  connect(ada, "obr_two");
  await handlers.connected();
  await until(
    () => sentToDocument("offscreen.recover").length === 1,
    "recover",
  );
  expect(requests()).toEqual([
    `POST ${demoPath(id, "/actions")}`,
    `POST ${demoPath(id, "/stop")}`,
  ]);
  expect(openbot.calls.every((c) => c.auth === "Bearer obr_two")).toBe(true);
  expect(await storedSteps(id)).toEqual([]);
  expect(sentToDocument("offscreen.recover")[0]).toEqual(
    expect.objectContaining({ token: "obr_two" }),
  );
});

test("recovery runs once when index.ts and runtime.onStartup both start it", async () => {
  const id = await recordThenRestartBrowser();
  startWorker();
  const mark = fake.calls.length;
  chrome.runtime.onStartup.addListener(recoverInterruptedRecording);
  const first = recoverInterruptedRecording();
  fake.fireStartup();
  const second = recoverInterruptedRecording();
  expect(second).toBe(first);
  await first;
  await settle();

  const since = fake.calls.slice(mark);
  expect(
    requests().filter((r) => r === `POST ${demoPath(id, "/stop")}`),
  ).toEqual([`POST ${demoPath(id, "/stop")}`]);
  expect(since.filter((call) => call === "offscreen.createDocument")).toEqual([
    "offscreen.createDocument",
  ]);
  expect(
    since.filter((call) => call === `port:${PORT_OFFSCREEN} offscreen.recover`),
  ).toHaveLength(1);
});

test("two concurrent ensureOffscreenDocument calls create one document", async () => {
  await Promise.all([ensureOffscreenDocument(), ensureOffscreenDocument()]);
  expect(fake.offscreen.created).toHaveLength(1);
  expect(fake.offscreen.open).toBe(true);
});

test("a Start over interrupted by a restart deletes the discarded demonstration after its drain", async () => {
  const first = await startRecording(7);
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  const second = `demo-${openbot.nextDemo}`;
  expect(drains()).toEqual([
    expect.objectContaining({ demonstrationId: first, discard: true }),
  ]);
  await until(
    async () => (await storedSteps(second)).length === 1,
    "the new recording's first step queued",
  );
  await restartBrowser();
  startWorker();
  await recoverInterruptedRecording();

  // The new recording is sent and stopped; the discarded one has nothing left to send and is not deleted yet.
  expect(requests()).toEqual([
    `POST ${demoPath(second, "/actions")}`,
    `POST ${demoPath(second, "/stop")}`,
  ]);
  expect(bodies.map((entry) => entry.demonstrationId)).toEqual([first, second]);
  const [recover] = sentToDocument("offscreen.recover");
  expect(
    recover?.type === "offscreen.recover" &&
      recover.drains.map((drain) => [drain.demonstrationId, drain.discard]),
  ).toEqual([
    [first, true],
    [second, false],
  ]);

  openbot.calls = [];
  doc?.postMessage({ type: "offscreen.done", demonstrationId: first });
  await until(() => drains().length === 1, "the discarded drain forgotten");
  expect(requests()).toEqual([`DELETE ${demoPath(first)}`]);
  expect(drains().map((drain) => drain.demonstrationId)).toEqual([second]);
  doc?.postMessage({ type: "offscreen.done", demonstrationId: second });
  await until(() => drains().length === 0, "every drain forgotten");
  expect(requests()).toEqual([`DELETE ${demoPath(first)}`]);
});

// ---- Drains whose person is not the one connected --------------------------------------------

test("a drain of another person waits for that person and nothing of it is sent; a kept drain of the connected person is tried again", async () => {
  await restartBrowser();
  const theirs: DrainRecord = {
    demonstrationId: "demo-bea",
    botId: "bot-1",
    title: "Bea's",
    openbotUrl: origin,
    userId: bea.id,
    userName: bea.name,
    trajectoryIds: ["t-bea"],
    startedAt: now - 60_000,
    stopPending: true,
    discard: false,
  };
  const parked: DrainRecord = {
    demonstrationId: "demo-ada",
    botId: "bot-1",
    title: "Ada's",
    openbotUrl: origin,
    userId: ada.id,
    userName: ada.name,
    trajectoryIds: ["t-ada"],
    startedAt: now - 120_000,
    discard: false,
    kept: {
      reason: "Learning capture is off on this Intelligence.",
      parked: true,
      events: 12,
      at: now - 30_000,
    },
  };
  fake.storage.local.set("drains", [theirs, parked]);
  await queueSteps(theirs.demonstrationId, [click("Approve")]);
  startWorker();
  await recoverInterruptedRecording();

  expect(requests()).toEqual([]); // nothing queued for Ada's, and nothing of Bea's
  expect(await storedSteps(theirs.demonstrationId)).toHaveLength(1);
  expect(drains()).toEqual([
    {
      ...theirs,
      kept: {
        reason: KEPT_SIGNED_OUT,
        parked: true,
        events: 0,
        at: now,
        waitingForReconnect: true,
      },
    },
    parked,
  ]);
  expect((await recorderState()).kept?.waitingFor).toEqual({
    name: "Bea",
    recordings: 1,
  });
  expect(bodies.map((entry) => entry.demonstrationId)).toEqual(["demo-ada"]);
  expect(sentToDocument("offscreen.recover")).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      drains: [parked],
    },
  ]);
});

test("after a browser restart with nobody connected, the interrupted recording waits for its person and goes when they connect", async () => {
  const id = await recordThenRestartBrowser();
  fake.storage.local.delete("connection");
  startWorker();
  const mark = fake.calls.length;
  await recoverInterruptedRecording();

  expect(requests()).toEqual([]);
  expect(fake.calls.slice(mark)).not.toContain("offscreen.createDocument");
  expect(await storedSteps(id)).toHaveLength(3);
  expect(fake.storage.local.get("notice")).toEqual({
    kind: "interrupted",
    at: now,
  });
  expect(drains()).toEqual([
    expect.objectContaining({
      demonstrationId: id,
      stopPending: true,
      kept: expect.objectContaining({ waitingForReconnect: true }),
    }),
  ]);

  connect(ada, "obr_two");
  await handlers.connected();
  await until(
    () => sentToDocument("offscreen.recover").length === 1,
    "recover",
  );
  expect(requests()).toEqual([
    `POST ${demoPath(id, "/actions")}`,
    `POST ${demoPath(id, "/stop")}`,
  ]);
  expect(drains().map((drain) => [drain.stopPending, drain.kept])).toEqual([
    [undefined, undefined],
  ]);
});
