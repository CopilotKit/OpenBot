import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
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
import { OpenBotError } from "../src/shared/openbot-client";
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
  /** `POST .../stop` is answered 503 (OpenBot is up but cannot take the stop for now). */
  stopUnavailable: false,
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
      if (method === "POST" && rest === "/stop" && openbot.stopUnavailable)
        return Response.json(
          { error: "OpenBot could not stop the recording yet." },
          { status: 503 },
        );
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

/** Every network-body recovery the controller asked for, sent or not. */
let bodies: {
  demonstrationId: string;
  target: { openbotUrl: string; token: string };
}[] = [];
/** What the network-body recovery answers for a recording: nothing (its lines are sent) or the error it throws. */
let bodiesAnswer: (demonstrationId: string) => Error | null = () => null;
/** The managed policy's pinned Intelligence addresses; null when the organization pins none. */
let pinnedIntelligenceUrls: string[] | null = null;

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
    recoverNetworkBodies: async (drain, target) => {
      bodies.push({ demonstrationId: drain.demonstrationId, target });
      const failure = bodiesAnswer(drain.demonstrationId);
      if (failure) {
        timeline.push(`bodies ${drain.demonstrationId} failed`);
        throw failure;
      }
      timeline.push(`bodies ${drain.demonstrationId}`);
      // As the real recovery does: lines leave IndexedDB once OpenBot has them.
      await clearBodies(drain.demonstrationId);
    },
    readPolicy: async () => ({
      openbotUrl: null,
      openbotUrlInvalid: false,
      allowedIntelligenceUrls: pinnedIntelligenceUrls,
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

const bodiesMedia = (demonstrationId: string) => `net-${demonstrationId}`;

/** Network body lines a previous session stored and never sent (the layout database.ts documents). */
async function queueBodies(demonstrationId: string, lines: number) {
  const mediaId = bodiesMedia(demonstrationId);
  const db = await openRecorderDatabase(dbName);
  try {
    await tx(db, ["bodies", "meta"], "readwrite", (t) => {
      for (let line = 0; line < lines; line += 1)
        t.objectStore("bodies").put({
          mediaId,
          line,
          text: `{"line":${line}}`,
        });
      t.objectStore("meta").put(mediaId, `media:${demonstrationId}:network`);
      t.objectStore("meta").put(lines, `bodies-next:${mediaId}`);
    });
  } finally {
    db.close();
  }
}

const bodiesRange = (demonstrationId: string) =>
  IDBKeyRange.bound(
    [bodiesMedia(demonstrationId), -Infinity],
    [bodiesMedia(demonstrationId), Infinity],
  );

async function storedBodies(demonstrationId: string) {
  const db = await openRecorderDatabase(dbName);
  try {
    return await requestToPromise(
      db
        .transaction("bodies", "readonly")
        .objectStore("bodies")
        .count(bodiesRange(demonstrationId)),
    );
  } finally {
    db.close();
  }
}

async function clearBodies(demonstrationId: string) {
  const db = await openRecorderDatabase(dbName);
  try {
    await tx(db, ["bodies"], "readwrite", (t) => {
      t.objectStore("bodies").delete(bodiesRange(demonstrationId));
    });
  } finally {
    db.close();
  }
}

const unavailable = () =>
  new OpenBotError(503, "OpenBot could not take the bodies yet.", null);

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
  bodiesAnswer = () => null;
  pinnedIntelligenceUrls = null;
  now = 1_800_000_000_000;
  openbot.calls = [];
  openbot.held = new Map();
  openbot.nextDemo = 0;
  openbot.gone = new Set();
  openbot.signedOut = false;
  openbot.stopUnavailable = false;
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
      allowedIntelligenceUrls: null,
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

test("after a browser start, offscreen.recover carries the organization's pinned Intelligence addresses", async () => {
  pinnedIntelligenceUrls = ["wss://intelligence.example.com"];
  await recordThenRestartBrowser();
  startWorker();
  await recoverInterruptedRecording();

  expect(sentToDocument("offscreen.recover")).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      allowedIntelligenceUrls: ["wss://intelligence.example.com"],
      drains: drains(),
    },
  ]);
});

test("after a browser start with no pinned Intelligence addresses, offscreen.recover carries null", async () => {
  await recordThenRestartBrowser();
  startWorker();
  await recoverInterruptedRecording();

  const [recover] = sentToDocument("offscreen.recover");
  expect(recover).toHaveProperty("allowedIntelligenceUrls", null);
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

// ---- Network bodies a drain still owes -------------------------------------------------------

test("connecting again after a sign-out sends the kept recording's network bodies under the new connection", async () => {
  const id = await startRecording(7);
  openbot.signedOut = true;
  await page({ type: "page.stop" });
  await until(
    () => drains()[0]?.kept?.waitingForReconnect === true,
    "kept for Ada",
  );
  expect(bodies).toEqual([]);

  openbot.signedOut = false;
  timeline = [];
  connect(ada, "obr_two");
  await handlers.connected();
  await until(
    () => sentToDocument("offscreen.recover").length === 1,
    "recover",
  );
  expect(timeline.filter((entry) => !entry.startsWith("document "))).toEqual([
    `POST ${demoPath(id, "/actions")}`,
    `POST ${demoPath(id, "/stop")}`,
    `bodies ${id}`,
  ]);
  expect(bodies).toEqual([
    { demonstrationId: id, target: { openbotUrl: origin, token: "obr_two" } },
  ]);
});

test("a recording whose network bodies could not be sent is not forgotten on offscreen.done, and goes once they are sent", async () => {
  const id = await startRecording(7);
  await queueBodies(id, 2);
  openbot.signedOut = true;
  await page({ type: "page.stop" });
  await until(
    () => drains()[0]?.kept?.waitingForReconnect === true,
    "kept for Ada",
  );

  openbot.signedOut = false;
  bodiesAnswer = () => unavailable();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    connect(ada, "obr_two");
    await handlers.connected();
    await until(
      () => sentToDocument("offscreen.recover").length === 1,
      "recover",
    );
    // The document has sent everything it held, but the bodies are still in IndexedDB: the drain stays for them.
    doc?.postMessage({ type: "offscreen.done", demonstrationId: id });
    await settle();
    await settle();
    expect(drains().map((drain) => drain.demonstrationId)).toEqual([id]);
    expect(await storedBodies(id)).toBe(2);
  } finally {
    logged.mockRestore();
  }

  // The next browser start sends them, and the document it reopens reports the drain done again: now it goes.
  await until(() => !fake.offscreen.open, "the document closed");
  bodiesAnswer = () => null;
  await restartBrowser();
  startWorker();
  await recoverInterruptedRecording();
  expect(timeline.filter((entry) => !entry.startsWith("document "))).toEqual([
    `bodies ${id}`,
  ]);
  expect(await storedBodies(id)).toBe(0);
  expect(drains().map((drain) => drain.demonstrationId)).toEqual([id]);
  doc?.postMessage({ type: "offscreen.done", demonstrationId: id });
  await until(() => drains().length === 0, "the drain forgotten");
});

/** A network media whose lines were all acknowledged: no body line left, `progress` as the upload recorded it. */
async function seedAcknowledgedBodies(
  demonstrationId: string,
  progress: { chunks: number; offset: number; completed?: boolean } | null,
) {
  const mediaId = bodiesMedia(demonstrationId);
  const db = await openRecorderDatabase(dbName);
  try {
    await tx(db, ["meta"], "readwrite", (t) => {
      t.objectStore("meta").put(mediaId, `media:${demonstrationId}:network`);
      if (progress)
        t.objectStore("meta").put(progress, `bodies-progress:${mediaId}`);
    });
  } finally {
    db.close();
  }
}

/** Stops a recording while connected, then has the document report it done. */
async function finishWithDone(id: string) {
  await page({ type: "page.stop" });
  await until(() => drains().length === 1, "the drain recorded");
  doc?.postMessage({ type: "offscreen.done", demonstrationId: id });
  await until(() => drains().length === 0, "the drain forgotten");
}

test("offscreen.done finishes the network media when every line was acknowledged but its completion is still owed", async () => {
  const id = await startRecording(7);
  await seedAcknowledgedBodies(id, { chunks: 2, offset: 0 });
  await finishWithDone(id);

  expect(bodies).toEqual([
    { demonstrationId: id, target: { openbotUrl: origin, token: "obr_one" } },
  ]);
});

test("offscreen.done does not touch the network media when nothing is owed", async () => {
  const id = await startRecording(7);
  await seedAcknowledgedBodies(id, { chunks: 2, offset: 0, completed: true });
  await finishWithDone(id);

  expect(bodies).toEqual([]);
});

test("a browser start whose stop OpenBot cannot take yet still sends the network bodies, and sends them after the retried stop", async () => {
  const id = await recordThenRestartBrowser();
  openbot.stopUnavailable = true;
  bodiesAnswer = () => unavailable();
  startWorker();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    await recoverInterruptedRecording();
  } finally {
    logged.mockRestore();
  }

  expect(timeline.filter((entry) => !entry.startsWith("document "))).toEqual([
    `POST ${demoPath(id, "/actions")}`,
    `POST ${demoPath(id, "/stop")}`,
    `bodies ${id} failed`,
  ]);
  expect(drains().map((drain) => drain.stopPending)).toEqual([true]);

  // The stop retry goes through: the bodies go after it.
  openbot.stopUnavailable = false;
  bodiesAnswer = () => null;
  timeline = [];
  await advance(5_000);
  await until(
    () => timeline.includes(`bodies ${id}`),
    "the bodies sent after the retried stop",
  );
  expect(timeline.filter((entry) => !entry.startsWith("document "))).toEqual([
    `POST ${demoPath(id, "/stop")}`,
    `bodies ${id}`,
  ]);
  expect(bodies.at(-1)).toEqual({
    demonstrationId: id,
    target: { openbotUrl: origin, token: "obr_one" },
  });
  expect(drains().map((drain) => drain.stopPending)).toEqual([undefined]);
});

test("a network-bodies failure is reported and the next drain still gets its turn", async () => {
  await restartBrowser();
  const drain = (demonstrationId: string): DrainRecord => ({
    demonstrationId,
    botId: "bot-1",
    title: "Ada's",
    openbotUrl: origin,
    userId: ada.id,
    userName: ada.name,
    trajectoryIds: [`t-${demonstrationId}`],
    startedAt: now - 60_000,
    discard: false,
  });
  fake.storage.local.set("drains", [drain("demo-a"), drain("demo-b")]);
  bodiesAnswer = (demonstrationId) =>
    demonstrationId === "demo-a" ? new Error("The body store broke.") : null;
  startWorker();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    await recoverInterruptedRecording();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[0]).toBe(
      "Recorder: sending network bodies failed",
    );
    expect(String(logged.mock.calls[0]?.[1])).toContain(
      "The body store broke.",
    );
  } finally {
    logged.mockRestore();
  }

  expect(timeline.filter((entry) => !entry.startsWith("document "))).toEqual([
    "bodies demo-a failed",
    "bodies demo-b",
  ]);
  expect(fake.storage.local.get("connection")).toBeDefined();
  expect(sentToDocument("offscreen.recover")).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      allowedIntelligenceUrls: null,
      drains: [drain("demo-a"), drain("demo-b")],
    },
  ]);
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
      allowedIntelligenceUrls: null,
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

// ---- A recording the person discarded is never sent -------------------------------------------

/** A drain whose discard the person chose and a restart interrupted before it finished clearing it. */
async function storeDiscardingDrain(
  id: string,
  extra: Partial<DrainRecord> = {},
) {
  const drain: DrainRecord = {
    demonstrationId: id,
    botId: "bot-1",
    title: "Ada's",
    openbotUrl: origin,
    userId: ada.id,
    userName: ada.name,
    trajectoryIds: [`t-${id}`],
    startedAt: now - 60_000,
    stopPending: true,
    discard: false,
    discarding: true,
    ...extra,
  };
  fake.storage.local.set("drains", [drain]);
  await queueSteps(id, [click("Approve")]);
  await queueBodies(id, 2);
}

async function expectDiscardFinished(id: string) {
  await until(() => drains().length === 0, "the discarded drain cleared");
  expect(requests()).toEqual([]);
  expect(bodies).toEqual([]);
  expect(sentToDocument("offscreen.recover")).toEqual([]);
  expect(sentToDocument("offscreen.discard")).toEqual([
    { type: "offscreen.discard", demonstrationIds: [id] },
  ]);
  expect(await storedSteps(id)).toHaveLength(0);
  expect(await storedBodies(id)).toBe(0);
}

test("a browser start finishes a discard the restart interrupted and sends nothing of that recording", async () => {
  await restartBrowser();
  await storeDiscardingDrain("demo-gone");
  startWorker();
  await recoverInterruptedRecording();
  await expectDiscardFinished("demo-gone");
});

test("a reconnect finishes a discard the restart interrupted and sends nothing of that recording", async () => {
  await restartBrowser();
  await storeDiscardingDrain("demo-gone");
  startWorker();
  await handlers.connected();
  await expectDiscardFinished("demo-gone");
});

test("a discard the restart interrupted is finished even when nobody is connected", async () => {
  await restartBrowser();
  await storeDiscardingDrain("demo-gone");
  fake.storage.local.delete("connection");
  startWorker();
  await recoverInterruptedRecording();
  await expectDiscardFinished("demo-gone");
});

test("a service-worker restart with the document still open finishes a discard it interrupted and sends nothing of that recording", async () => {
  // Its stop reached OpenBot and the document holds its events, retrying them while the document lives on.
  await storeDiscardingDrain("demo-gone", {
    stopPending: false,
    kept: {
      reason: "Intelligence could not take the events yet.",
      parked: false,
      events: 12,
      at: now - 1_000,
    },
  });
  fake.offscreen.open = true;
  fake.restartServiceWorker();
  startWorker();
  openDocument(); // the document reconnects its port
  await recoverInterruptedRecording();
  await expectDiscardFinished("demo-gone");
});
