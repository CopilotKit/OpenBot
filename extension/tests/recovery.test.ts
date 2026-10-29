// A browser restart: the service worker, storage.session, the offscreen document and every timer go, while
// storage.local and the document's IndexedDB outbox stay. Recovery hands every recording the restart cut short to a new
// document, which sends what its outbox kept to Intelligence (with an interrupted outcome for the one that was live).
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
  PORT_OFFSCREEN,
} from "../src/protocol/messages";
import { KEPT_FOR_PERSON_MS } from "../src/shared/limits";
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
const bea = { id: "p2", name: "Bea", email: "bea@example.test" };
const DEAL = "https://crm.example.test/deals/42";
const KEPT_SIGNED_OUT = "This browser was disconnected from OpenBot.";

// ---- The fake OpenBot -------------------------------------------------------------------------
//
// Recovery asks OpenBot nothing: every request is recorded so the tests can say so.

const openbot = { calls: [] as string[] };

let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      openbot.calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ error: "Not found." }, { status: 404 });
    },
  });
  origin = server.url.origin;
});
afterAll(() => server.stop(true));

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

/** The offscreen document: it connects and says ready once Chrome created it, and answers offscreen.stop. */
let doc: FakePort | null = null;
let docSeen = 0;
let docRecording = "";
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
    if (message.type === "offscreen.start")
      docRecording = message.session.recordingId;
    if (message.type === "offscreen.rotate") docRecording = message.recordingId;
    if (message.type === "offscreen.stop")
      doc.postMessage({
        type: "offscreen.stopped",
        recordingId: docRecording,
        trajectoryIds: [],
      });
  }
}
const toDocument = (port: FakePort | null = doc) =>
  (port?.messages ?? []) as BackgroundToOffscreen[];
const sentToDocument = (type: string, port: FakePort | null = doc) =>
  toDocument(port).filter((message) => message.type === type);

/** The managed policy's pinned Intelligence addresses; null when the organization pins none. */
let pinnedIntelligenceUrls: string[] | null = null;

function doubles(): Partial<RecordingDeps> {
  return {
    createNetworkCapture: () => ({
      start: async (_tabId, url) =>
        isRecordablePage(url) ? "debugger" : "waiting",
      addTab: async () => {},
      onCommitted: async () => {},
      resume: async () => "debugger",
      action: () => {},
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
    readPolicy: async () => ({
      openbotUrl: null,
      openbotUrlInvalid: false,
      allowedIntelligenceUrls: pinnedIntelligenceUrls,
    }),
    hasHostPermission: async () => true,
    now: () => now,
    timers: fakeTimers,
  };
}

let handlers: ReturnType<typeof installRecording>;
function startWorker() {
  handlers = installRecording(doubles());
  installRouter(handlers);
}

/** A browser restart: the service worker, storage.session, the document and every timer go; storage.local (and the
 * outbox in IndexedDB, which the document owns) stay. */
async function restartBrowser() {
  await settle();
  fake.restartServiceWorker();
  fake.storage.session.clear();
  fake.offscreen.open = false;
  doc = null;
  timers = [];
  openbot.calls = [];
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

async function startRecording(tabId = 7): Promise<string> {
  fake.tabs.set(tabId, { id: tabId, url: DEAL } as chrome.tabs.Tab);
  const answer = await page({
    type: "page.record",
    title: "Update deal",
    tabId,
  });
  expect(answer).toEqual({ ok: true });
  return (await recorderState()).recordingId ?? "";
}

/** A recording, then a browser restart. */
async function recordThenRestartBrowser() {
  const id = await startRecording(7);
  await restartBrowser();
  return id;
}

/** A stopped recording of `person` a previous browser session left in the drains. */
const storedDrain = (
  id: string,
  person: { id: string; name: string },
  extra: Partial<DrainRecord> = {},
): DrainRecord => ({
  recordingId: id,
  title: `${person.name}'s`,
  openbotUrl: origin,
  userId: person.id,
  userName: person.name,
  trajectoryIds: [`t-${id}`],
  startedAt: now - 60_000,
  ...extra,
});

beforeEach(() => {
  fake = installChromeFake({ extensionId: EXTENSION_ID });
  fake.offscreen.onDocumentCreated.addListener(() => {
    setTimeout(openDocument, 0);
  });
  fake.offscreen.onDocumentClosed.addListener(() => {
    doc?.disconnect();
    doc = null;
  });
  doc = null;
  docRecording = "";
  docPoll = setInterval(answerAsDocument, 1);
  timers = [];
  pinnedIntelligenceUrls = null;
  now = 1_800_000_000_000;
  openbot.calls = [];
  connect();
  startWorker();
});

afterEach(async () => {
  clearInterval(docPoll);
  await settle();
  fake.uninstall();
});

// ---- A browser restart mid-recording ---------------------------------------------------------

test("a browser restart mid-recording hands the recording to a new document, which sends what it kept with an interrupted outcome, and forgets it only after offscreen.done", async () => {
  const id = await recordThenRestartBrowser();
  startWorker();
  await recoverInterruptedRecording();

  expect(openbot.calls).toEqual([]);
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect(fake.storage.local.get("notice")).toEqual({
    kind: "interrupted",
    at: now,
  });
  expect(drains()).toEqual([
    expect.objectContaining({ recordingId: id, userId: "p1" }),
  ]);
  expect(drains()[0]?.kept).toBeUndefined();
  // The document recovers it: the streamer reads its outbox and queues the interrupted outcome itself.
  expect(sentToDocument("offscreen.stop")).toEqual([]);
  expect(sentToDocument("offscreen.recover")).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      allowedIntelligenceUrls: null,
      version: "0.0.0",
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
  doc?.postMessage({ type: "offscreen.done", recordingId: id });
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
      version: "0.0.0",
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

test("a recovered recording whose pass is answered signed out waits for its person, who sends it by connecting again", async () => {
  const id = await recordThenRestartBrowser();
  startWorker();
  await recoverInterruptedRecording();
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await until(
    () => drains()[0]?.kept?.waitingForReconnect === true,
    "kept for Ada",
  );
  expect(fake.storage.local.get("connection")).toBeUndefined();
  expect(drains()[0]?.kept).toEqual({
    reason: KEPT_SIGNED_OUT,
    parked: true,
    events: 0,
    at: now,
    waitingForReconnect: true,
  });
  expect((await recorderState()).kept?.waitingFor).toEqual({
    name: "Ada",
    recordings: 1,
  });

  connect(ada, "obr_two");
  await handlers.connected();
  await until(
    () => sentToDocument("offscreen.recover").length === 2,
    "recover again",
  );
  expect(sentToDocument("offscreen.recover")[1]).toEqual(
    expect.objectContaining({
      token: "obr_two",
      drains: [expect.objectContaining({ recordingId: id })],
    }),
  );
  expect(drains()[0]?.kept).toBeUndefined();
  expect(openbot.calls).toEqual([]);
});

test("recovery runs once when index.ts and runtime.onStartup both start it", async () => {
  await recordThenRestartBrowser();
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

test("a Start over interrupted by a restart sends both recordings: the one it left, and the new one with an interrupted outcome", async () => {
  const first = await startRecording(7);
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  const second = (await recorderState()).recordingId ?? "";
  expect(drains().map((drain) => drain.recordingId)).toEqual([first]);
  await restartBrowser();
  startWorker();
  await recoverInterruptedRecording();

  const [recover] = sentToDocument("offscreen.recover");
  expect(
    recover?.type === "offscreen.recover" &&
      recover.drains.map((drain) => drain.recordingId),
  ).toEqual([first, second]);
  expect(sentToDocument("offscreen.discard")).toEqual([]);
  doc?.postMessage({ type: "offscreen.done", recordingId: first });
  await until(() => drains().length === 1, "the first drain forgotten");
  doc?.postMessage({ type: "offscreen.done", recordingId: second });
  await until(() => drains().length === 0, "every drain forgotten");
  expect(openbot.calls).toEqual([]);
});

// ---- Drains whose person is not the one connected --------------------------------------------

test("a drain of another person waits for that person and nothing of it is sent; a kept drain of the connected person is tried again", async () => {
  await restartBrowser();
  const theirs = storedDrain("rec-bea", bea);
  const parked = storedDrain("rec-ada", ada, {
    kept: {
      reason: "Learning capture is off on this Intelligence.",
      parked: true,
      events: 12,
      at: now - 30_000,
    },
  });
  fake.storage.local.set("drains", [theirs, parked]);
  startWorker();
  await recoverInterruptedRecording();

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
  expect(sentToDocument("offscreen.recover")).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      allowedIntelligenceUrls: null,
      version: "0.0.0",
      drains: [parked],
    },
  ]);
  expect(openbot.calls).toEqual([]);
});

test("a recording that has waited for its person longer than OpenBot keeps anyone signed in is deleted unsent at the next start, its outbox with it, and one within that time waits on", async () => {
  await restartBrowser();
  const waiting = (id: string, since: number) =>
    storedDrain(id, bea, {
      startedAt: since - 60_000,
      kept: {
        reason: KEPT_SIGNED_OUT,
        parked: true,
        events: 3,
        at: since,
        waitingForReconnect: true,
      },
    });
  const expired = waiting("rec-old", now - KEPT_FOR_PERSON_MS);
  const fresh = waiting("rec-new", now - KEPT_FOR_PERSON_MS + 60_000);
  // The connected person's own kept recording is tried again, however old: the popup offers to discard it.
  const own = storedDrain("rec-ada", ada, {
    startedAt: now - 30 * 24 * 60 * 60 * 1000,
    kept: {
      reason: "Learning capture is off on this Intelligence.",
      parked: true,
      events: 12,
      at: now - 30 * 24 * 60 * 60 * 1000,
    },
  });
  fake.storage.local.set("drains", [expired, fresh, own]);
  startWorker();
  await recoverInterruptedRecording();

  expect(drains()).toEqual([fresh, own]);
  expect(sentToDocument("offscreen.discard")).toEqual([
    { type: "offscreen.discard", recordingIds: ["rec-old"] },
  ]);
  const [recover] = sentToDocument("offscreen.recover");
  expect(
    recover?.type === "offscreen.recover" &&
      recover.drains.map((drain) => drain.recordingId),
  ).toEqual(["rec-ada"]);
  expect((await recorderState()).kept?.waitingFor).toEqual({
    name: "Bea",
    recordings: 1,
  });
  expect(openbot.calls).toEqual([]);

  // A day later the other one has waited as long, and goes at the next start too.
  await restartBrowser();
  now += 24 * 60 * 60 * 1000;
  startWorker();
  await recoverInterruptedRecording();
  expect(drains().map((drain) => drain.recordingId)).toEqual(["rec-ada"]);
  expect(sentToDocument("offscreen.discard")).toEqual([
    { type: "offscreen.discard", recordingIds: ["rec-new"] },
  ]);
});

test("after a browser restart with nobody connected, the interrupted recording waits for its person and goes when they connect", async () => {
  const id = await recordThenRestartBrowser();
  fake.storage.local.delete("connection");
  startWorker();
  const mark = fake.calls.length;
  await recoverInterruptedRecording();

  expect(fake.calls.slice(mark)).not.toContain("offscreen.createDocument");
  expect(fake.storage.local.get("notice")).toEqual({
    kind: "interrupted",
    at: now,
  });
  expect(drains()).toEqual([
    expect.objectContaining({
      recordingId: id,
      kept: expect.objectContaining({ waitingForReconnect: true }),
    }),
  ]);

  connect(ada, "obr_two");
  await handlers.connected();
  await until(
    () => sentToDocument("offscreen.recover").length === 1,
    "recover",
  );
  expect(sentToDocument("offscreen.recover")[0]).toEqual(
    expect.objectContaining({ token: "obr_two" }),
  );
  expect(drains().map((drain) => drain.kept)).toEqual([undefined]);
  expect(openbot.calls).toEqual([]);
});

// ---- A recording the person discarded is never sent -------------------------------------------

/** A drain whose discard the person chose and a restart interrupted before it finished clearing it. */
function storeDiscardingDrain(id: string, extra: Partial<DrainRecord> = {}) {
  fake.storage.local.set("drains", [
    storedDrain(id, ada, { discarding: true, ...extra }),
  ]);
}

async function expectDiscardFinished(id: string) {
  await until(() => drains().length === 0, "the discarded drain cleared");
  expect(openbot.calls).toEqual([]);
  expect(sentToDocument("offscreen.recover")).toEqual([]);
  expect(sentToDocument("offscreen.discard")).toEqual([
    { type: "offscreen.discard", recordingIds: [id] },
  ]);
}

test("a browser start finishes a discard the restart interrupted and sends nothing of that recording", async () => {
  await restartBrowser();
  storeDiscardingDrain("rec-gone");
  startWorker();
  await recoverInterruptedRecording();
  await expectDiscardFinished("rec-gone");
});

test("a reconnect finishes a discard the restart interrupted and sends nothing of that recording", async () => {
  await restartBrowser();
  storeDiscardingDrain("rec-gone");
  startWorker();
  await handlers.connected();
  await expectDiscardFinished("rec-gone");
});

test("a discard the restart interrupted is finished even when nobody is connected", async () => {
  await restartBrowser();
  storeDiscardingDrain("rec-gone");
  fake.storage.local.delete("connection");
  startWorker();
  await recoverInterruptedRecording();
  await expectDiscardFinished("rec-gone");
});

test("a service-worker restart with the document still open finishes a discard it interrupted and sends nothing of that recording", async () => {
  // The document holds its events, retrying them while it lives on.
  storeDiscardingDrain("rec-gone", {
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
  await expectDiscardFinished("rec-gone");
});
