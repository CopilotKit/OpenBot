// A service-worker restart: Chrome stops the worker and starts it again while storage.session, storage.local and the
// offscreen document (its outbox included) stay. The controller finishes what the old worker began: a Stop, a Record,
// or the live recording.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
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
const SIGNED_OUT =
  "This browser was disconnected from OpenBot. Your recording stopped, and everything in it is kept in this browser for 7 days, until you connect again.";
const START_FAILED = "The recording could not start. Try again.";
/** A card number typed into a sensitive field before the restart, and the digest the content script sent for it. */
const SECRET = "4111111111111111";
const SECRET_DIGEST = "ab".repeat(32);

const capturedEvent = (name: string, value: unknown): CapturedEvent => ({
  type: "CUSTOM",
  name,
  timestamp: 1_700_000_000_000,
  value: value as CapturedEvent["value"],
});

// ---- The fake OpenBot -------------------------------------------------------------------------
//
// Nothing a restart finishes asks OpenBot anything: every request is recorded so the tests can say so. A restarted worker
// tells OpenBot what it is doing again (activity.ts), which holds nothing recorded, so `asked` leaves those reports out.

const openbot = { calls: [] as string[] };
const asked = () =>
  openbot.calls.filter((call) => call !== "POST /api/recorder/activity");

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

/** The offscreen document: it says ready on every port it opens, and answers offscreen.stop unless `holdStop` is set. */
let doc: FakePort | null = null;
let docSeen = 0;
let docRecording = "";
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
      docRecording = message.session.recordingId;
    if (message.type === "offscreen.stop") {
      if (holdStop) heldStops.push(docRecording);
      else
        doc.postMessage({
          type: "offscreen.stopped",
          recordingId: docRecording,
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
  previous: string[];
  resumeMode: NetworkMode;
  recorded: CapturedEvent[];
};
let masked: string[][] = [];
/** The managed policy's pinned Intelligence addresses; null when the organization pins none. */
let pinnedIntelligenceUrls: string[] | null = null;

function doubles(): Partial<RecordingDeps> {
  return {
    createNetworkCapture: () => ({
      start: async (_tabId, url) =>
        isRecordablePage(url) ? "debugger" : "waiting",
      addTab: async () => {},
      onCommitted: async () => {},
      resume: async (tabs, previous) => {
        network.resumed.push(tabs);
        network.previous.push(previous);
        return previous === "stopped" ? "stopped" : network.resumeMode;
      },
      action: () => {},
      recordPageEvent: async (_tabId, event) => {
        network.recorded.push(event);
      },
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
    // Stands in for Task 18's masking: a value whose digest the content script reported is redacted.
    acceptPageNetworkEvent: (event, digests) => {
      masked.push([...digests]);
      const value = digests.has(SECRET_DIGEST)
        ? JSON.parse(
            JSON.stringify(event.value).replaceAll(SECRET, "[redacted]"),
          )
        : event.value;
      return { ...event, value };
    },
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

/** Chrome stops the service worker and starts it again: its listeners, timers and ports go, while storage.session,
 * storage.local and the offscreen document stay. */
async function restartWorker() {
  await settle();
  fake.restartServiceWorker();
  timers = [];
  doc = null;
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

async function startRecording(tabId = 7): Promise<string> {
  fake.tabs.set(tabId, { id: tabId, url: DEAL } as chrome.tabs.Tab);
  const answer = await page({
    type: "page.record",
    title: "Update deal",
    tabId,
  });
  expect(answer).toEqual({ ok: true });
  return (await state()).recordingId ?? "";
}

/** A recording, then Stop, which the document has not answered yet. */
async function recordThenStop() {
  const id = await startRecording(7);
  holdStop = true;
  void page({ type: "page.stop" });
  await until(() => heldStops.length === 1, "the document heard the stop");
  expect((await state()).stopping).toEqual({ since: now });
  return id;
}

// ---- What a previous service worker persisted -----------------------------------------------

const RECORDING = "rec-9";
const seededRecord = (): DrainRecord => ({
  recordingId: RECORDING,
  title: "Update deal",
  openbotUrl: origin,
  userId: ada.id,
  userName: ada.name,
  trajectoryIds: ["00000000-0000-4000-8000-000000000009"],
  startedAt: now - 60_000,
});

/** Writes what a service worker that went away persisted for `rec-9`, with the document still open unless told. */
function seed(
  recorder: Partial<RecorderState>,
  options: { activeRecording?: boolean; document?: boolean } = {},
) {
  const active = seededRecord();
  if (options.activeRecording ?? true)
    fake.storage.local.set("activeRecording", active);
  fake.storage.session.set("recorder", {
    ...IDLE_STATE,
    recordingId: RECORDING,
    title: "Update deal",
    tabIds: [7],
    topUrls: { "7": DEAL },
    startedAt: active.startedAt,
    actions: 3,
    capture: { intelligence: "streaming", network: "debugger" },
    ...recorder,
  });
  fake.storage.session.set("stream", {
    recordingId: RECORDING,
    title: "Update deal",
    openbotUrl: origin,
    token: "obr_one",
    trajectoryId: active.trajectoryIds[0] ?? "",
    startedAt: active.startedAt,
    allowedIntelligenceUrls: null,
    version: "0.3.0",
  } satisfies StreamSession);
  fake.offscreen.open = options.document ?? true;
  docRecording = RECORDING;
}

beforeEach(() => {
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
  docRecording = "";
  holdStop = false;
  heldStops = [];
  docPoll = setInterval(answerAsDocument, 1);
  timers = [];
  now = 1_800_000_000_000;
  openbot.calls = [];
  network = {
    resumed: [],
    previous: [],
    resumeMode: "debugger",
    recorded: [],
  };
  masked = [];
  pinnedIntelligenceUrls = null;
  connect();
});

afterEach(async () => {
  clearInterval(docPoll);
  await settle();
  fake.uninstall();
});

// ---- A restart in the middle of a Stop -------------------------------------------------------

test("a service-worker restart during Stop finishes the stop with the document alive", async () => {
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
  // Still stopping until the document has queued the outcome.
  expect((await state()).phase).toBe("stopping");

  port.postMessage({
    type: "offscreen.stopped",
    recordingId: id,
    trajectoryIds: [],
  });
  await recovering;
  const after = await state();
  expect(after.phase).toBe("idle");
  expect(after.stopping).toBeUndefined();
  expect(after.lastStopped).toEqual({
    recordingId: id,
    title: "Update deal",
    stoppedAt: now,
    actions: 0,
    phrases: 0,
  });
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect(fake.storage.session.get("stream")).toBeUndefined();
  expect(drains().map((drain) => drain.recordingId)).toEqual([id]);
  // The document is asked to report on it again: an offscreen.done it sent before the restart went with the old worker.
  expect(sentToDocument("offscreen.recover", port)).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      allowedIntelligenceUrls: null,
      version: "0.3.0",
      drains: drains(),
    },
  ]);
  port.postMessage({ type: "offscreen.done", recordingId: id });
  await until(() => drains().length === 0, "the drain forgotten");
  expect(asked()).toEqual([]);
});

test("the document asked to report on a resumed stop is held to the organization's pinned Intelligence addresses", async () => {
  pinnedIntelligenceUrls = ["wss://intelligence.example.com"];
  startWorker();
  const id = await recordThenStop();
  await restartWorker();
  const port = openDocumentPort();
  const recovering = recoverInterruptedRecording();
  await until(() => heldStops.length === 2, "the stop told again");
  port.postMessage({
    type: "offscreen.stopped",
    recordingId: id,
    trajectoryIds: [],
  });
  await recovering;
  expect(sentToDocument("offscreen.recover", port)).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      allowedIntelligenceUrls: ["wss://intelligence.example.com"],
      version: "0.3.0",
      drains: drains(),
    },
  ]);
  port.postMessage({ type: "offscreen.done", recordingId: id });
  await until(() => drains().length === 0, "the drain forgotten");
});

test("a service-worker restart during Stop with no document reopens it on the stored session and finishes the stop", async () => {
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
    { type: "offscreen.resume", session: stored },
  ]);
  expect((await state()).phase).toBe("idle");
  expect(drains().map((drain) => drain.recordingId)).toEqual([id]);
  expect(asked()).toEqual([]);
});

test("a stop whose persisted start is over 120 s old skips the wait", async () => {
  seed({ phase: "stopping", stopping: { since: now - 121_000 } });
  holdStop = true; // the document never answers
  startWorker();
  const port = openDocumentPort();
  await recoverInterruptedRecording(); // no clock advance needed

  expect(sentToDocument("offscreen.stop", port)).toHaveLength(1);
  expect((await state()).phase).toBe("idle");
  expect(drains().map((drain) => drain.recordingId)).toEqual([RECORDING]);
});

test("a stale resumed stop still reaches a document that reconnects after recovery starts", async () => {
  seed({ phase: "stopping", stopping: { since: now - 121_000 } });
  holdStop = true;
  startWorker();
  const recovering = recoverInterruptedRecording();
  await settle(); // recovery is under way and the document has not reconnected yet
  const port = openDocumentPort();
  await recovering;

  expect(sentToDocument("offscreen.stop", port)).toHaveLength(1);
  expect((await state()).phase).toBe("idle");
});

test("a stale resumed stop with no document reopens it and tells it to stop, so the person's outcome stands", async () => {
  seed(
    { phase: "stopping", stopping: { since: now - 121_000 } },
    { document: false },
  );
  startWorker();
  await recoverInterruptedRecording();

  expect(toDocument().map((message) => message.type)).toEqual([
    "offscreen.resume",
    "offscreen.stop",
    "offscreen.recover",
  ]);
  expect(sentToDocument("offscreen.stop")).toEqual([
    { type: "offscreen.stop", outcome: "succeeded" },
  ]);
  expect((await state()).phase).toBe("idle");
});

test("a resumed stop waits only for what is left of the 120 seconds", async () => {
  seed({ phase: "stopping", stopping: { since: now - 119_000 } });
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

  await advance(1_000);
  await recovering;
  expect((await state()).phase).toBe("idle");
  expect(drains().map((drain) => drain.recordingId)).toEqual([RECORDING]);
});

test("a service-worker restart just after Stop moved the recording into the drains only finishes", async () => {
  seed(
    // Three actions and two narrated phrases, as the service worker that went away persisted them.
    { phase: "stopping", stopping: { since: now - 5_000 }, phrases: 2 },
    { activeRecording: false },
  );
  fake.storage.local.set("drains", [seededRecord()]);
  startWorker();
  const port = openDocumentPort();
  await recoverInterruptedRecording();

  const after = await state();
  expect(after.phase).toBe("idle");
  // What the recording held is reported by the worker that finished its stop.
  expect(after.lastStopped).toEqual({
    recordingId: RECORDING,
    title: "Update deal",
    stoppedAt: now,
    actions: 3,
    phrases: 2,
  });
  expect(drains()).toEqual([seededRecord()]);
  expect(sentToDocument("offscreen.recover", port)).toEqual([
    {
      type: "offscreen.recover",
      openbotUrl: origin,
      token: "obr_one",
      allowedIntelligenceUrls: null,
      version: "0.3.0",
      drains: [seededRecord()],
    },
  ]);
});

test("Disconnect waits for a resumed stop and discards the recording it finished", async () => {
  seed({ phase: "stopping", stopping: { since: now - 5_000 } });
  holdStop = true;
  startWorker();
  openDocumentPort();
  const recovering = recoverInterruptedRecording();
  await until(() => heldStops.length === 1, "the stop told again");
  // The person disconnects (the router calls this once the connection is gone).
  fake.storage.local.delete("connection");
  await handlers.disconnected();
  await recovering;
  expect(sentToDocument("offscreen.discard")).toEqual([
    { type: "offscreen.discard", recordingIds: [RECORDING] },
  ]);
  expect(drains()).toEqual([]);
  expect((await state()).phase).toBe("idle");
});

// ---- A restart in the middle of Record -------------------------------------------------------

test("a service-worker restart in the middle of Record discards what the document holds of it, and Record works again", async () => {
  seed({ phase: "starting", recordingId: undefined, tabIds: [] });
  startWorker();
  const port = openDocumentPort();
  await recoverInterruptedRecording();

  // Nothing of it is ever sent: it never went live.
  expect(sentToDocument("offscreen.discard", port)).toEqual([
    { type: "offscreen.discard", recordingIds: [RECORDING] },
  ]);
  expect(sentToDocument("offscreen.stop", port)).toEqual([]);
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect(fake.storage.session.get("stream")).toBeUndefined();
  expect(drains()).toEqual([]);
  const after = await state();
  expect(after.phase).toBe("idle");
  expect(after.error).toBe(START_FAILED);
  await until(() => !fake.offscreen.open, "the document closed");

  await startRecording(7);
  expect((await state()).phase).toBe("recording");
  expect(asked()).toEqual([]);
});

// ---- A restart while recording ---------------------------------------------------------------

test("a service-worker restart with no document resumes it with the stored session", async () => {
  startWorker();
  await startRecording(7);
  const stored = fake.storage.session.get("stream") as StreamSession;
  await chrome.offscreen.closeDocument();
  await restartWorker();
  const mark = fake.calls.length;
  await recoverInterruptedRecording();

  expect(fake.calls.slice(mark)).toContain("offscreen.createDocument");
  expect(toDocument()).toEqual([{ type: "offscreen.resume", session: stored }]);
  expect((await state()).phase).toBe("recording");
  expect(network.resumed).toEqual([[{ tabId: 7, url: DEAL }]]);
});

test("a service-worker restart with no document resumes the live recording before it finishes a discard the restart interrupted", async () => {
  startWorker();
  await startRecording(7);
  const stored = fake.storage.session.get("stream") as StreamSession;
  await chrome.offscreen.closeDocument();
  fake.storage.local.set("drains", [
    { ...seededRecord(), recordingId: "rec-gone", discarding: true },
  ]);
  await restartWorker();
  await recoverInterruptedRecording();

  expect(toDocument()).toEqual([
    { type: "offscreen.resume", session: stored },
    { type: "offscreen.discard", recordingIds: ["rec-gone"] },
  ]);
  expect((await state()).phase).toBe("recording");
  expect(drains()).toEqual([]);
});

test("a discard that cannot finish because the document never reconnects does not stop the live recording resuming", async () => {
  startWorker();
  await startRecording(7);
  fake.storage.local.set("drains", [
    { ...seededRecord(), recordingId: "rec-gone", discarding: true },
  ]);
  await restartWorker(); // the document is still open, but its port never reconnects
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const recovering = recoverInterruptedRecording();
    await settle();
    await advance(5_000);
    await recovering;
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }

  expect(network.resumed).toEqual([[{ tabId: 7, url: DEAL }]]);
  expect((await state()).phase).toBe("recording");
  expect(drains().map((drain) => drain.recordingId)).toEqual(["rec-gone"]);
});

test("a service-worker restart mid-recording goes on checking the connection with OpenBot every 30 s", async () => {
  startWorker();
  await startRecording(7);
  await restartWorker();
  openDocumentPort();
  await recoverInterruptedRecording();
  expect((await state()).phase).toBe("recording");
  expect(asked()).toEqual([]);
  await advance(30_000);
  await until(
    () => openbot.calls.includes("GET /api/recorder/me"),
    "the check after the restart",
  );
  // OpenBot's answer here says nothing about the connection: the recording goes on.
  expect((await state()).phase).toBe("recording");
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
  expect((await state()).phase).toBe("recording");
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
  const forwarded = () =>
    toDocument(port).flatMap((message) =>
      message.type === "offscreen.event" ? [message.event.name] : [],
    );
  await until(() => forwarded().includes("click"), "the click forwarded");
  // The old worker still held the recording's first page (waiting for its title): this one sent it, ahead of the click.
  expect(forwarded()).toEqual(["navigation", "click"]);
  expect(tab8.messages).toContainEqual({
    type: "background.capture",
    active: true,
    recordingId: id,
    // The tab's recording mark, which a restarted worker draws again.
    site: "example.test",
    narrating: false,
  });
});

test("a service-worker restart hands the network capture the mode it had, so a capture the person stopped stays stopped", async () => {
  const reason =
    "You closed Chrome's debugging bar, so what each step saves is no longer recorded.";
  seed({
    phase: "recording",
    capture: {
      intelligence: "streaming",
      network: "stopped",
      networkReason: reason,
    },
  });
  startWorker();
  openDocumentPort();
  await recoverInterruptedRecording();
  expect(network.previous).toEqual(["stopped"]);
  expect((await state()).capture).toMatchObject({
    network: "stopped",
    networkReason: reason,
  });
});

test("a service-worker restart keeps the action count, so the 50-action notice still comes at the 50th", async () => {
  seed({ phase: "recording", actions: 49 });
  startWorker();
  openDocumentPort();
  await recoverInterruptedRecording();
  const top = contentPort(7);
  top.postMessage({
    type: "content.event",
    event: capturedEvent("click", { text: "Save" }),
  });
  await until(async () => (await state()).noticeOpen, "the notice opens");
  expect((await state()).actions).toBe(50);
  expect(top.messages).toContainEqual({
    type: "background.notice",
    show: true,
    actions: 50,
  });
});

test("a service-worker restart whose recording lost its connection stops it and keeps it for its person", async () => {
  startWorker();
  const id = await startRecording(7);
  // The keep-alive found the connection revoked while the recording ran on.
  fake.storage.local.delete("connection");
  fake.storage.local.set("notice", {
    kind: "signed-out",
    at: now,
    reason: "revoked",
  });
  await restartWorker();
  const port = openDocumentPort();
  await recoverInterruptedRecording();

  expect(sentToDocument("offscreen.stop", port)).toEqual([
    { type: "offscreen.stop", outcome: "failed", reason: "signed-out" },
  ]);
  expect(sentToDocument("offscreen.discard", port)).toEqual([]);
  expect(network.resumed).toEqual([]);
  const after = await state();
  expect(after.phase).toBe("idle");
  expect(after.error).toBe(SIGNED_OUT);
  expect(drains()).toEqual([
    expect.objectContaining({
      recordingId: id,
      kept: expect.objectContaining({ waitingForReconnect: true }),
    }),
  ]);
  expect(asked()).toEqual([]);
});
