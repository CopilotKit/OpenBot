import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  RECORDER_SIGNED_OUT,
  type RecorderBot,
} from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import type {
  NetworkCaptureDeps,
  NetworkMode,
} from "../src/background/network";
import type { PageFallback } from "../src/background/network/fallback";
import {
  installRecording,
  type RecordingDeps,
  recorderState,
  reduceRecorder,
} from "../src/background/recording";
import { installRouter } from "../src/background/router";
import {
  type BackgroundToOffscreen,
  IDLE_STATE,
  type PageResponse,
  type PageStateResponse,
  PORT_CONTENT,
  PORT_OFFSCREEN,
  type RecorderState,
  type StreamSession,
} from "../src/protocol/messages";
import { isRecordablePage } from "../src/shared/origin";
import type { RecorderPolicy } from "../src/shared/policy";
import type { ConnectionRecord, DrainRecord } from "../src/shared/storage";
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNED_OUT =
  "This browser was disconnected from OpenBot. Your recording stopped, and everything in it is kept in this browser until you connect again.";
const ORGANIZATION_SIGNED_OUT =
  "Your organization sign-in ended. Your recording stopped, and everything in it is kept in this browser until you connect again.";

const event = (name: string, value: unknown): CapturedEvent => ({
  type: "CUSTOM",
  name,
  timestamp: 1_700_000_000_000,
  value: value as CapturedEvent["value"],
});
const contentEvent = (value: unknown) => event("page", value);

// ---- The fake OpenBot -------------------------------------------------------------------------
//
// The extension asks OpenBot only to connect: who is connected (`me`), the Bots, and Disconnect. Every other request
// is recorded, so a test can say OpenBot heard nothing of a recording.

type Call = { method: string; path: string; auth: string | null };
type HeldRoute = "me" | "disconnect";

const openbot = {
  calls: [] as Call[],
  /** Tokens OpenBot no longer takes: `me` and the Bots answer signed out for them. */
  revoked: new Set<string>(),
  /** While set, that route's answers wait for it. */
  holds: {} as Partial<Record<HeldRoute, Promise<void>>>,
  me: { status: 200, body: {} as object },
  bots: [
    {
      id: "bot-1",
      name: "Deals",
      learning: { state: "assigned", containerId: "space-1" },
    },
  ] as RecorderBot[],
};
const meBody = {
  user: ada,
  connectionId: "c-obr_one",
};
const CONNECTING = new Set([
  "GET /api/recorder/me",
  "GET /api/recorder/bots",
  "DELETE /api/recorder/connections/current",
]);

function resetOpenBot() {
  openbot.calls = [];
  openbot.revoked = new Set();
  openbot.holds = {};
  openbot.me = { status: 200, body: meBody };
}

let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      const auth = request.headers.get("authorization");
      openbot.calls.push({ method: request.method, path: url.pathname, auth });
      const signedOut = () =>
        auth && openbot.revoked.has(auth.slice(7))
          ? Response.json(
              {
                error: "Connect this browser again.",
                code: RECORDER_SIGNED_OUT,
                reason: "revoked",
              },
              { status: 401 },
            )
          : null;
      if (route === "GET /api/recorder/me") {
        if (openbot.holds.me) await openbot.holds.me;
        return (
          signedOut() ??
          Response.json(openbot.me.body, { status: openbot.me.status })
        );
      }
      if (route === "GET /api/recorder/bots")
        return signedOut() ?? Response.json({ bots: openbot.bots });
      if (route === "DELETE /api/recorder/connections/current") {
        if (openbot.holds.disconnect) await openbot.holds.disconnect;
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    },
  });
  origin = server.url.origin;
});
afterAll(() => server.stop(true));

const requests = () => openbot.calls.map((c) => `${c.method} ${c.path}`);
/** What OpenBot heard beyond connecting: nothing, ever, about a recording. */
const recordingRequests = () =>
  requests().filter((request) => !CONNECTING.has(request));

// ---- Time, the fake offscreen document and the doubles --------------------------------------

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
/** A promise the test opens on cue. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}
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

/** The offscreen document: it connects and says ready once Chrome created it, and answers offscreen.stop on its own
 * unless `holdStop` is set. The test posts everything else on cue. */
let doc: FakePort | null = null;
/** Every port the document opened, in order. */
let docPorts: FakePort[] = [];
let docSeen = 0;
let docRecording = "";
let holdStop = false;
/** The recordings whose stop the document has not answered while `holdStop` was set. */
let heldStops: string[] = [];
let docPoll: ReturnType<typeof setInterval> | undefined;
function openDocument() {
  doc = fake.connectFrom(PORT_OFFSCREEN, OFFSCREEN_SENDER);
  docPorts.push(doc);
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
const everyDocumentMessage = () =>
  docPorts.flatMap((port) => port.messages as BackgroundToOffscreen[]);
/** The document reconnecting its port with its backoff: it connects again and says nothing first. */
function reconnectDocument(): FakePort {
  const port = fake.connectFrom(PORT_OFFSCREEN, OFFSCREEN_SENDER);
  doc = port;
  docPorts.push(port);
  docSeen = 0;
  return port;
}
/** Makes the service worker's first post of `type` on a document port that connects from now on throw, as a post on a
 * port that just went away does. */
function throwOnFirstPost(type: string) {
  const failure = { thrown: false };
  chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    if (port.name !== PORT_OFFSCREEN) return;
    const post = port.postMessage;
    port.postMessage = (message: unknown) => {
      if (!failure.thrown && (message as { type?: string }).type === type) {
        failure.thrown = true;
        throw new Error("Attempting to use a disconnected port object");
      }
      post(message);
    };
  });
  return failure;
}

type NetworkDouble = {
  deps?: NetworkCaptureDeps;
  options?: { fallback?: PageFallback };
  calls: string[];
  recorded: CapturedEvent[];
  failStart: boolean;
  /** How many captures were created, and the ones started and not stopped since. */
  created: number;
  running: Set<number>;
};
let network: NetworkDouble;
let fallback: { value: PageFallback; calls: string[]; created: number };
let acceptAnswer: CapturedEvent | null = null;
let accepted: { event: CapturedEvent; digests: string[] }[] = [];
let policy: RecorderPolicy;
let hostAccess = true;
let handlers: ReturnType<typeof installRecording>;
let restoreVariant: (() => void) | null = null;

/** The waits outside the fake OpenBot a test can hold: a double's answer, or the document saying ready. */
type GateName = "host" | "policy" | "document" | "networkStart" | "networkStop";
let gates: Partial<Record<GateName, Promise<void>>> = {};
/** The gates something has reached while they were held. */
let gatesHit = new Set<GateName>();
async function pass(name: GateName) {
  const held = gates[name];
  if (!held) return;
  gatesHit.add(name);
  await held;
}
/** Holds one of the waits in `GateName` until the test opens it. */
function hold(name: GateName) {
  const held = gate();
  gates[name] = held.promise;
  return {
    hit: () => gatesHit.has(name),
    open: () => {
      delete gates[name];
      held.open();
    },
  };
}
/** Holds the `nth` `chrome.storage` call to `method` whose argument `matches` until the test opens it. */
function holdStorage(
  area: "local" | "session",
  method: "set" | "remove",
  matches: (argument: unknown) => boolean,
  nth = 1,
) {
  const storage = chrome.storage[area] as unknown as Record<
    string,
    (argument: unknown) => Promise<void>
  >;
  const original = storage[method] as (argument: unknown) => Promise<void>;
  const held = gate();
  let seen = 0;
  storage[method] = async (argument) => {
    if (seen < nth && matches(argument)) {
      seen += 1;
      if (seen === nth) await held.promise;
    }
    return original.call(storage, argument);
  };
  return { hit: () => seen === nth, open: held.open };
}
/** Holds a route of the fake OpenBot from now on; reached once a request to it arrives. */
function holdRoute(route: HeldRoute, path: string) {
  const held = gate();
  const from = openbot.calls.length;
  openbot.holds[route] = held.promise;
  return {
    hit: () => openbot.calls.slice(from).some((call) => call.path === path),
    open: () => {
      delete openbot.holds[route];
      held.open();
    },
  };
}

function doubles(): Partial<RecordingDeps> {
  return {
    createNetworkCapture: (deps, options) => {
      network.deps = deps;
      network.options = options;
      network.created += 1;
      const capture = network.created;
      return {
        start: async (tabId, url) => {
          network.calls.push(`start ${tabId} ${url}`);
          await pass("networkStart");
          if (network.failStart) throw new Error("attach failed");
          network.running.add(capture);
          return isRecordablePage(url) ? "debugger" : "waiting";
        },
        addTab: async (tabId, url) => {
          network.calls.push(`addTab ${tabId} ${url}`);
        },
        onCommitted: async (tabId, frameId, url) => {
          network.calls.push(`onCommitted ${tabId} ${frameId} ${url}`);
        },
        resume: async () => "off" as NetworkMode,
        recordPageEvent: async (recorded) => {
          network.recorded.push(recorded);
        },
        stop: async () => {
          network.calls.push("stop");
          await pass("networkStop");
          network.running.delete(capture);
        },
      };
    },
    createPageFallback: () => {
      fallback.created += 1;
      return fallback.value;
    },
    acceptPageNetworkEvent: (received, digests) => {
      accepted.push({ event: received, digests: [...digests] });
      return acceptAnswer;
    },
    readPolicy: async () => {
      await pass("policy");
      return policy;
    },
    hasHostPermission: async () => {
      await pass("host");
      return hostAccess;
    },
    now: () => now,
    timers: fakeTimers,
  };
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
const active = () =>
  fake.storage.local.get("activeRecording") as DrainRecord | undefined;
const storedConnection = () =>
  fake.storage.local.get("connection") as ConnectionRecord | undefined;
const contentPort = (tabId: number, frameId = 0) =>
  fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId,
    url: "https://crm.example.test/",
  });
const captureMessages = (port: FakePort) =>
  port.messages.filter(
    (message) => (message as { type?: string }).type === "background.capture",
  );
const notices = (port: FakePort) =>
  port.messages.filter(
    (message) => (message as { type: string }).type === "background.notice",
  );

/** Records on `tabId` and resolves with the new recording's id. */
async function startRecording(input: {
  botId: string;
  title: string;
  tabId: number;
}): Promise<string> {
  if (!fake.tabs.has(input.tabId))
    fake.tabs.set(input.tabId, {
      id: input.tabId,
      url: DEAL,
    } as chrome.tabs.Tab);
  const answer = await page({ type: "page.record", ...input });
  expect(answer).toEqual({ ok: true });
  const id = (await state()).recordingId;
  if (!id) throw new Error("No recording id");
  return id;
}
const record = () => startRecording({ botId: "bot-1", title: "T", tabId: 7 });
/** The trajectory the document was told to stream a recording into. */
function trajectoryOf(recordingId: string): string {
  for (const message of everyDocumentMessage()) {
    if (
      message.type === "offscreen.start" &&
      message.session.recordingId === recordingId
    )
      return message.session.trajectoryId;
    if (
      message.type === "offscreen.rotate" &&
      message.recordingId === recordingId
    )
      return message.trajectoryId;
  }
  throw new Error(`No trajectory for ${recordingId}`);
}

beforeEach(() => {
  fake = installChromeFake({
    extensionId: EXTENSION_ID,
    manifestVersion: "0.3.0",
  });
  fake.offscreen.onDocumentCreated.addListener(() => {
    setTimeout(() => {
      void pass("document").then(openDocument);
    }, 0);
  });
  fake.offscreen.onDocumentClosed.addListener(() => {
    doc?.disconnect();
    doc = null;
  });
  doc = null;
  docPorts = [];
  docRecording = "";
  holdStop = false;
  heldStops = [];
  gates = {};
  gatesHit = new Set();
  docPoll = setInterval(answerAsDocument, 1);
  timers = [];
  now = 1_800_000_000_000;
  resetOpenBot();
  network = {
    calls: [],
    recorded: [],
    failStart: false,
    created: 0,
    running: new Set(),
  };
  const fallbackCalls: string[] = [];
  fallback = {
    calls: fallbackCalls,
    created: 0,
    value: {
      start: async () => {
        fallbackCalls.push("start");
        return false;
      },
      addTab: async () => {
        fallbackCalls.push("addTab");
      },
      onCommitted: async () => {
        fallbackCalls.push("onCommitted");
      },
      stop: async () => {
        fallbackCalls.push("stop");
      },
      active: () => false,
    },
  };
  acceptAnswer = null;
  accepted = [];
  policy = {
    openbotUrl: null,
    openbotUrlInvalid: false,
    allowedIntelligenceUrls: null,
  };
  hostAccess = true;
  connect();
  handlers = installRecording(doubles());
  installRouter(handlers);
});

afterEach(async () => {
  clearInterval(docPoll);
  restoreVariant?.();
  restoreVariant = null;
  // Let work still in flight finish against this test's fakes before they go.
  await settle();
  fake.uninstall();
});

function useVariant(value: string) {
  const previous = process.env.RECORDER_VARIANT;
  process.env.RECORDER_VARIANT = value;
  restoreVariant = () => {
    if (previous === undefined) delete process.env.RECORDER_VARIANT;
    else process.env.RECORDER_VARIANT = previous;
  };
}

// ---- Record ------------------------------------------------------------------------------------

test("Record opens the document and starts a new trajectory for the picked Bot, telling OpenBot nothing", async () => {
  const id = await startRecording({
    botId: "bot-1",
    title: "Update deal",
    tabId: 7,
  });
  expect(id).toMatch(UUID);
  expect(openbot.calls).toEqual([]);
  const created = fake.calls.indexOf("offscreen.createDocument");
  const ready = fake.calls.indexOf("port:recorder:offscreen offscreen.ready");
  const started = fake.calls.indexOf("port:recorder:offscreen offscreen.start");
  expect(created).toBeGreaterThanOrEqual(0);
  expect(created).toBeLessThan(ready);
  expect(ready).toBeLessThan(started);
  const start = sentToDocument("offscreen.start")[0];
  if (start?.type !== "offscreen.start") throw new Error("No start");
  expect(start.session).toEqual({
    recordingId: id,
    title: "Update deal",
    botId: "bot-1",
    openbotUrl: origin,
    token: "obr_one",
    trajectoryId: expect.stringMatching(UUID),
    startedAt: now,
    allowedIntelligenceUrls: null,
    version: "0.3.0",
  });
  expect(start.session.trajectoryId).not.toBe(id);
  expect(fake.offscreen.created[0]).toMatchObject({
    url: "offscreen.html",
    reasons: ["LOCAL_STORAGE"],
  });
  expect(fake.scripting.registered).toEqual([]); // nothing registered for every site (Decision 4)
  const injected = fake.scripting.executed.filter(
    (i) => (i.target as { tabId: number }).tabId === 7,
  );
  expect(injected[0]).toMatchObject({
    target: { tabId: 7, allFrames: true },
    args: [id],
    injectImmediately: true,
  }); // the active flag first
  expect(injected[1]).toMatchObject({
    target: { tabId: 7, allFrames: true },
    files: ["content.js"],
    injectImmediately: true,
  });
  expect(active()).toEqual({
    recordingId: id,
    botId: "bot-1",
    title: "Update deal",
    openbotUrl: origin,
    userId: "p1",
    userName: "Ada",
    trajectoryIds: [start.session.trajectoryId],
    startedAt: now,
  });
  expect(fake.storage.local.get("lastBotId")).toBe("bot-1");
  expect(fake.storage.session.get("stream")).toEqual(start.session);
  expect(await state()).toMatchObject({
    phase: "recording",
    recordingId: id,
    botId: "bot-1",
    tabIds: [7],
    topUrls: { "7": DEAL },
    actions: 0,
    capture: { intelligence: "connecting", network: "debugger" },
  });
  expect(fake.badge).toEqual({ text: "REC", color: "#e7000b" });
});

test("Record copies the picked Bot's Learning space from the last Bot list", async () => {
  await page({ type: "page.bots" });
  await record();
  expect((await state()).learning).toEqual({
    state: "assigned",
    containerId: "space-1",
  });
});

test("a frame committed in a followed tab gets the content script; a frame in another tab does not", async () => {
  const id = await record();
  fake.scripting.executed.length = 0;
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 4,
    parentFrameId: 0,
    url: "https://widgets.example.test/frame",
  });
  await until(() => fake.scripting.executed.length === 2, "two injections");
  expect(fake.scripting.executed[0]).toMatchObject({
    target: { tabId: 7, frameIds: [4] },
    args: [id],
    injectImmediately: true,
  });
  expect(fake.scripting.executed[1]).toMatchObject({
    target: { tabId: 7, frameIds: [4] },
    files: ["content.js"],
  });
  expect(network.calls).toContain(
    "onCommitted 7 4 https://widgets.example.test/frame",
  );
  fake.webNavigation.commit({
    tabId: 99,
    frameId: 0,
    url: "https://other.example.test/",
  });
  await settle();
  expect(
    fake.scripting.executed.filter(
      (i) => (i.target as { tabId: number }).tabId === 99,
    ),
  ).toEqual([]);
  expect(network.calls.some((call) => call.includes(" 99 "))).toBe(false);
});

test("a refused frame is skipped and the recording carries on", async () => {
  await record();
  fake.scripting.refuseFrames = [5];
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 5,
    parentFrameId: 0,
    url: "https://sandbox.example.test/",
  });
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/next",
    transitionType: "link",
  });
  await until(async () => (await state()).actions === 1, "the page load");
  expect((await state()).phase).toBe("recording");
});

test("Record without website access is refused with the access sentence", async () => {
  hostAccess = false;
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  expect(
    await page({ type: "page.record", botId: "bot-1", title: "T", tabId: 7 }),
  ).toEqual({ ok: false, error: "Allow the Recorder to read websites first." });
  expect(fake.offscreen.created).toEqual([]);
  expect(await state()).toMatchObject({
    phase: "idle",
    error: "Allow the Recorder to read websites first.",
  });
});

test("Record without a connection is refused", async () => {
  fake.storage.local.delete("connection");
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  const answer = await page({
    type: "page.record",
    botId: "bot-1",
    title: "T",
    tabId: 7,
  });
  expect(answer).toEqual({
    ok: false,
    error: "Connect this browser to OpenBot first.",
  });
  expect(fake.offscreen.created).toEqual([]);
  expect((await state()).phase).toBe("idle");
});

test("Record while a recording runs is refused and changes nothing", async () => {
  const id = await record();
  const answer = await page({
    type: "page.record",
    botId: "bot-1",
    title: "T",
    tabId: 7,
  });
  expect(answer).toEqual({
    ok: false,
    error: "A recording is already running.",
  });
  expect(await state()).toMatchObject({ phase: "recording", recordingId: id });
  expect(sentToDocument("offscreen.start")).toHaveLength(1);
});

test("a tab whose url Chrome withholds (a chrome:// page) starts with the network waiting", async () => {
  fake.tabs.set(7, { id: 7 } as chrome.tabs.Tab);
  await record();
  expect(network.calls).toEqual(["start 7 "]);
  expect(await state()).toMatchObject({
    phase: "recording",
    topUrls: { "7": "" },
    actions: 0,
    capture: { network: "waiting" },
  });
});

test("a failure once the document started rolls everything back, and the document clears what it holds", async () => {
  network.failStart = true;
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  const content = contentPort(7);
  const answer = await page({
    type: "page.record",
    botId: "bot-1",
    title: "T",
    tabId: 7,
  });
  expect(answer).toEqual({
    ok: false,
    error: "The recording could not start. Try again.",
  });
  const start = sentToDocument("offscreen.start")[0];
  if (start?.type !== "offscreen.start") throw new Error("No start");
  // Nothing of it is ever sent: the document drops its first events.
  expect(sentToDocument("offscreen.discard")).toEqual([
    { type: "offscreen.discard", recordingIds: [start.session.recordingId] },
  ]);
  expect(sentToDocument("offscreen.stop")).toEqual([]);
  expect(content.messages.at(-1)).toEqual({
    type: "background.capture",
    active: false,
  });
  expect(network.running.size).toBe(0);
  expect(active()).toBeUndefined();
  expect(fake.storage.session.get("stream")).toBeUndefined();
  expect(drains()).toEqual([]);
  expect(await state()).toMatchObject({
    phase: "idle",
    error: "The recording could not start. Try again.",
  });
  expect(openbot.calls).toEqual([]);
});

// ---- Stop and the document --------------------------------------------------------------------

test("Stop queues the outcome in the document, and the recording waits as a drain until Intelligence has all of it", async () => {
  const id = await record();
  const content = contentPort(7);
  holdStop = true;
  const stopping = page({ type: "page.stop" });
  await until(
    () => sentToDocument("offscreen.stop").length === 1,
    "offscreen.stop",
  );
  expect(sentToDocument("offscreen.stop")[0]).toEqual({
    type: "offscreen.stop",
    outcome: "succeeded",
  });
  expect(await state()).toMatchObject({
    phase: "stopping",
    stopping: { since: now },
  });
  expect(content.messages).toContainEqual({
    type: "background.capture",
    active: false,
  });
  expect(network.calls).toContain("stop");
  doc?.postMessage({
    type: "offscreen.stopped",
    recordingId: id,
    trajectoryIds: [trajectoryOf(id)],
  });
  expect(await stopping).toEqual({ ok: true });
  expect(await state()).toMatchObject({
    phase: "idle",
    lastStopped: { recordingId: id, botId: "bot-1" },
    draining: 1,
  });
  expect(drains()).toMatchObject([{ recordingId: id, botId: "bot-1" }]);
  expect(active()).toBeUndefined();
  expect(fake.storage.session.get("stream")).toBeUndefined();
  expect(fake.badge.text).toBe("");
  expect(fake.offscreen.open).toBe(true);
  doc?.postMessage({ type: "offscreen.done", recordingId: id });
  await until(() => drains().length === 0, "the drain goes");
  await until(() => !fake.offscreen.open, "the document closes");
  expect((await state()).draining).toBe(0);
  expect(openbot.calls).toEqual([]);
});

test("the popup keeps the picked Bot's Learning space after Stop", async () => {
  await page({ type: "page.bots" });
  await record();
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  expect((await state()).learning).toEqual({
    state: "assigned",
    containerId: "space-1",
  });
});

test("a stop whose document never answers goes on after 120 seconds from when it began", async () => {
  await record();
  holdStop = true;
  let answered = false;
  void page({ type: "page.stop" }).then(() => {
    answered = true;
  });
  await until(() => heldStops.length === 1, "the document heard the stop");
  await advance(119_000);
  expect(answered).toBe(false);
  await advance(1_000);
  await until(() => answered, "the stop goes on");
  expect((await state()).phase).toBe("idle");
});

test("Stop while the document's port reconnects tells the document on its new port", async () => {
  const id = await record();
  doc?.disconnect();
  doc = null;
  await settle();
  let answered = false;
  void page({ type: "page.stop" }).then(() => {
    answered = true;
  });
  await settle();
  expect(answered).toBe(false);
  const again = reconnectDocument();
  await until(
    () => sentToDocument("offscreen.stop", again).length === 1,
    "offscreen.stop on the new port",
  );
  expect(sentToDocument("offscreen.stop", again)[0]).toEqual({
    type: "offscreen.stop",
    outcome: "succeeded",
  });
  again.postMessage({
    type: "offscreen.stopped",
    recordingId: id,
    trajectoryIds: [],
  });
  await until(() => answered, "Stop finishes");
  again.postMessage({ type: "offscreen.done", recordingId: id });
  await until(() => !fake.offscreen.open, "the document closes");
});

test("Stop with no document finishes at once: there is nothing to wait for", async () => {
  await record();
  await chrome.offscreen.closeDocument();
  await settle();
  let answered = false;
  void page({ type: "page.stop" }).then(() => {
    answered = true;
  });
  await until(() => answered, "Stop finishes without a timer");
  expect((await state()).phase).toBe("idle");
  expect(drains()).toHaveLength(1);
});

test("the document closes only when every drain is done", async () => {
  const first = await record();
  await page({ type: "page.stop" });
  const second = await record();
  await page({ type: "page.stop" });
  expect(fake.offscreen.created).toHaveLength(1);
  doc?.postMessage({ type: "offscreen.done", recordingId: first });
  await until(() => drains().length === 1, "the first drain is forgotten");
  await settle();
  expect(fake.offscreen.open).toBe(true);
  doc?.postMessage({ type: "offscreen.done", recordingId: second });
  await until(() => !fake.offscreen.open, "the document closes");
  expect(drains()).toEqual([]);
});

/** Holds the first `chrome.scripting.executeScript` (Record's script injection) until the test opens it. */
function holdFirstInjection() {
  const scripting = chrome.scripting as unknown as {
    executeScript: (details: unknown) => Promise<unknown>;
  };
  const executeScript = scripting.executeScript;
  const held = gate();
  let hit = false;
  scripting.executeScript = async (details) => {
    if (!hit) {
      hit = true;
      await held.promise;
    }
    return executeScript.call(scripting, details);
  };
  return { hit: () => hit, open: held.open };
}

test("Stop while Record still injects the content script waits for Record to finish, then stops the network capture and switches the tab off", async () => {
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  const content = contentPort(7);
  const injection = holdFirstInjection();
  const recording = page({
    type: "page.record",
    botId: "bot-1",
    title: "T",
    tabId: 7,
  });
  await until(injection.hit, "the first injection is held");
  const stopping = page({ type: "page.stop" });
  await settle();
  injection.open();
  expect(await recording).toEqual({ ok: true });
  expect(await stopping).toEqual({ ok: true });
  expect(network.calls).toEqual([`start 7 ${DEAL}`, "stop"]);
  expect(content.messages.at(-1)).toEqual({
    type: "background.capture",
    active: false,
  });
  expect((await state()).phase).toBe("idle");
});

test("Start over while Record still injects the content script waits for Record, then tells the tab only the new recording", async () => {
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  const content = contentPort(7);
  const injection = holdFirstInjection();
  const recording = page({
    type: "page.record",
    botId: "bot-1",
    title: "T",
    tabId: 7,
  });
  await until(injection.hit, "the first injection is held");
  const restarting = page({ type: "page.restart" });
  await settle();
  injection.open();
  expect(await recording).toEqual({ ok: true });
  expect(await restarting).toEqual({ ok: true });
  await settle();
  const start = sentToDocument("offscreen.start")[0];
  const rotate = sentToDocument("offscreen.rotate")[0];
  if (start?.type !== "offscreen.start" || rotate?.type !== "offscreen.rotate")
    throw new Error("No start and rotate");
  expect(await state()).toMatchObject({
    phase: "recording",
    recordingId: rotate.recordingId,
  });
  // The tab hears of the first recording, then of the new one, and never of the first one after the switch.
  expect(captureMessages(content)).toEqual([
    {
      type: "background.capture",
      active: true,
      recordingId: start.session.recordingId,
    },
    {
      type: "background.capture",
      active: true,
      recordingId: rotate.recordingId,
    },
  ]);
  expect(network.calls).toEqual([`start 7 ${DEAL}`]);
});

/** The waits of Record before its recording is live, and how a test holds each one. */
const recordWaits: {
  name: string;
  hold(): { hit(): boolean; open(): void };
}[] = [
  { name: "the website-access check", hold: () => hold("host") },
  {
    name: "saving the active recording",
    hold: () =>
      holdStorage(
        "local",
        "set",
        (items) =>
          (items as { activeRecording?: unknown }).activeRecording !==
          undefined,
      ),
  },
  { name: "the policy", hold: () => hold("policy") },
  { name: "the document saying ready", hold: () => hold("document") },
  {
    name: "saving the stream session",
    hold: () =>
      holdStorage(
        "session",
        "set",
        (items) => (items as { stream?: unknown }).stream !== undefined,
      ),
  },
];

for (const action of ["Stop", "Disconnect"] as const)
  for (const wait of recordWaits)
    test(`${action} while Record waits on ${wait.name} ends Record before anything records, and leaves nothing behind`, async () => {
      fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
      const content = contentPort(7);
      const held = wait.hold();
      const recording = page({
        type: "page.record",
        botId: "bot-1",
        title: "T",
        tabId: 7,
      });
      await until(held.hit, `Record waits on ${wait.name}`);
      const stopping = page({
        type: action === "Stop" ? "page.stop" : "page.disconnect",
      });
      await settle();
      held.open();
      expect(await recording).toEqual({
        ok: false,
        error: "Nothing is being recorded.",
      });
      expect(await stopping).toEqual({ ok: true });
      await settle();
      const after = await state();
      expect(after.phase).toBe("idle");
      expect(after.error).toBeUndefined();
      expect(active()).toBeUndefined();
      expect(fake.storage.session.get("stream")).toBeUndefined();
      expect(drains()).toEqual([]);
      // Nothing captures: no network capture, no script told to capture, and a recording the document was told to
      // start is discarded there, never sent.
      expect(network.calls).toEqual([]);
      expect(captureMessages(content)).toEqual([]);
      const started = sentToDocument("offscreen.start").map((message) =>
        message.type === "offscreen.start" ? message.session.recordingId : "",
      );
      const discarded = sentToDocument("offscreen.discard").flatMap(
        (message) =>
          message.type === "offscreen.discard" ? message.recordingIds : [],
      );
      for (const id of started) expect(discarded).toContain(id);
      expect(recordingRequests()).toEqual([]);
      if (action === "Disconnect") expect(storedConnection()).toBeUndefined();
    });

// ---- What the person did, and the 50-action notice ---------------------------------------------

test("clicks, inputs and page loads in a followed tab's top frame count as actions; nothing else does", async () => {
  await record();
  const top = contentPort(7, 0);
  const sub = contentPort(7, 2);
  top.postMessage({ type: "content.event", event: event("click", { a: 1 }) });
  sub.postMessage({ type: "content.event", event: event("input", { a: 2 }) });
  top.postMessage({ type: "content.event", event: event("page", { a: 3 }) });
  top.postMessage({
    type: "content.event",
    event: event("recorder.dropped", { count: 2 }),
  });
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/deals/43",
    transitionType: "link",
  });
  fake.webNavigation.historyUpdate({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/deals/44",
  });
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 3,
    parentFrameId: 0,
    url: "https://widgets.example.test/a",
  });
  await until(
    () => sentToDocument("offscreen.event").length === 7,
    "every event forwarded",
  );
  await settle();
  // A click, an input (from any frame), a page load and a history change: the frame load and the rest do not count.
  expect((await state()).actions).toBe(4);
  expect(fake.badge.text).toBe("4");
  network.deps?.emit(event("network", { url: "https://crm.example.test/x" }));
  await settle();
  expect((await state()).actions).toBe(4);
});

test("the 50-action notice goes once to every followed tab's top frame", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  await record();
  fake.webNavigation.createdTarget({
    sourceTabId: 7,
    tabId: 8,
    url: "https://crm.example.test/new",
  });
  await until(
    async () => (await state()).tabIds.length === 2,
    "tab 8 followed",
  );
  const top7 = contentPort(7, 0);
  const sub7 = contentPort(7, 2);
  const top8 = contentPort(8, 0);
  for (let i = 0; i < 49; i++)
    top7.postMessage({ type: "content.event", event: event("click", { i }) });
  for (let i = 0; i < 10; i++)
    network.deps?.emit(event("network", { i, url: DEAL }));
  await until(async () => (await state()).actions === 49, "49 actions");
  await settle();
  expect([...notices(top7), ...notices(top8), ...notices(sub7)]).toEqual([]);
  top7.postMessage({ type: "content.event", event: event("click", { i: 49 }) });
  await until(() => notices(top8).length === 1, "the notice reaches tab 8");
  expect(notices(top7)).toEqual([
    { type: "background.notice", show: true, actions: 50 },
  ]);
  expect(notices(top8)).toEqual([
    { type: "background.notice", show: true, actions: 50 },
  ]);
  expect(notices(sub7)).toEqual([]);
  expect((await state()).noticeShown).toBe(true);
  top7.postMessage({ type: "content.event", event: event("click", { i: 50 }) });
  await until(async () => (await state()).actions === 51, "51 actions");
  await settle();
  expect(notices(top7)).toHaveLength(1);
  top8.postMessage({ type: "content.notice", choice: "continue" });
  await until(() => notices(top7).length === 2, "the notice hides in tab 7");
  expect(notices(top7)[1]).toMatchObject({
    type: "background.notice",
    show: false,
  });
  expect(notices(top8)[1]).toMatchObject({
    type: "background.notice",
    show: false,
  });
  expect((await state()).phase).toBe("recording");
});

/** Records on tab 7 until its 50th action opens the notice. */
async function recordUntilNotice(top?: FakePort) {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  await record();
  const port = top ?? contentPort(7, 0);
  const before = (await state()).actions;
  for (let i = 0; i < 49; i++)
    port.postMessage({ type: "content.event", event: event("click", { i }) });
  await until(
    async () => (await state()).actions === before + 49,
    "49 actions",
  );
  await settle();
  expect((await state()).noticeOpen).toBe(false);
  port.postMessage({ type: "content.event", event: event("click", { i: 49 }) });
  await until(async () => (await state()).noticeOpen, "the notice is open");
  return port;
}

const pageStateNoticeOpen = async () =>
  ((await page({ type: "page.state" })) as PageStateResponse).state.noticeOpen;

test("the 50-action notice is open in the state the popup reads, and Keep going on the page closes it", async () => {
  const top = await recordUntilNotice();
  expect(await pageStateNoticeOpen()).toBe(true);
  top.postMessage({ type: "content.notice", choice: "continue" });
  await until(
    async () => !(await state()).noticeOpen,
    "Keep going on the page closes it",
  );
  expect(await pageStateNoticeOpen()).toBe(false);
  // Once per recording: it stays closed for the rest of this one.
  expect((await state()).noticeShown).toBe(true);
  top.postMessage({ type: "content.event", event: event("click", { i: 50 }) });
  await until(async () => (await state()).actions === 51, "51 actions");
  expect((await state()).noticeOpen).toBe(false);
});

test("Keep going in the popup closes the 50-action notice", async () => {
  await recordUntilNotice();
  expect(await page({ type: "page.notice", choice: "continue" })).toEqual({
    ok: true,
  });
  expect((await state()).noticeOpen).toBe(false);
  expect(await pageStateNoticeOpen()).toBe(false);
  expect((await state()).phase).toBe("recording");
});

test("Stop on the notice stops the recording, and the next recording to reach 50 actions opens it again", async () => {
  const top = await recordUntilNotice();
  top.postMessage({ type: "content.notice", choice: "stop" });
  await until(async () => (await state()).phase === "idle", "stopped");
  expect(await state()).toMatchObject({ phase: "idle", noticeOpen: false });
  expect(await pageStateNoticeOpen()).toBe(false);
  await recordUntilNotice(top);
  expect(await pageStateNoticeOpen()).toBe(true);
});

test("Start over on the notice records a new recording whose count starts again", async () => {
  const top = await recordUntilNotice();
  const old = (await state()).recordingId;
  top.postMessage({ type: "content.notice", choice: "restart" });
  await until(
    async () => (await state()).recordingId !== old,
    "the new recording",
  );
  expect(await state()).toMatchObject({
    phase: "recording",
    actions: 0,
    noticeShown: false,
    noticeOpen: false,
  });
});

// ---- Start over ------------------------------------------------------------------------------

test("Start over sends the recording it leaves to Intelligence with a failed outcome and records into a new trajectory", async () => {
  const old = await record();
  const oldTrajectory = trajectoryOf(old);
  const content = contentPort(7);
  content.postMessage({ type: "content.event", event: event("click", {}) });
  await until(async () => (await state()).actions === 1, "one action");
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  const rotate = sentToDocument("offscreen.rotate")[0];
  if (rotate?.type !== "offscreen.rotate") throw new Error("No rotate");
  const fresh = rotate.recordingId;
  expect(fresh).toMatch(UUID);
  expect(fresh).not.toBe(old);
  expect(rotate.trajectoryId).toMatch(UUID);
  expect(rotate.trajectoryId).not.toBe(oldTrajectory);
  expect(await state()).toMatchObject({
    phase: "recording",
    recordingId: fresh,
    actions: 0,
    noticeShown: false,
  });
  expect(active()).toMatchObject({
    recordingId: fresh,
    botId: "bot-1",
    trajectoryIds: [rotate.trajectoryId],
  });
  expect(
    (fake.storage.session.get("stream") as StreamSession).trajectoryId,
  ).toBe(rotate.trajectoryId);
  // The one it leaves is an ordinary drain: the document sends what it holds, its failed outcome included.
  expect(drains()).toEqual([
    expect.objectContaining({
      recordingId: old,
      trajectoryIds: [oldTrajectory],
    }),
  ]);
  expect(drains()[0]?.discarding).toBeUndefined();
  expect(captureMessages(content).at(-1)).toEqual({
    type: "background.capture",
    active: true,
    recordingId: fresh,
  });
  doc?.postMessage({ type: "offscreen.done", recordingId: old });
  await until(() => drains().length === 0, "the old one goes once sent");
  expect(sentToDocument("offscreen.discard")).toEqual([]);
  expect(openbot.calls).toEqual([]);
});

test("Start over while the document's port reconnects moves the document to the new recording before the tabs capture for it", async () => {
  await record();
  const content = contentPort(7);
  doc?.disconnect();
  doc = null;
  await settle();
  const restarting = page({ type: "page.restart" });
  await settle();
  const again = reconnectDocument();
  expect(await restarting).toEqual({ ok: true });
  const rotate = sentToDocument("offscreen.rotate", again)[0];
  if (rotate?.type !== "offscreen.rotate") throw new Error("No rotate");
  const rotateAt = fake.calls.indexOf(
    `port:${PORT_OFFSCREEN} offscreen.rotate`,
  );
  const captureAt = fake.calls.findIndex(
    (call, index) =>
      index > rotateAt && call === `port:${PORT_CONTENT} background.capture`,
  );
  expect(rotateAt).toBeGreaterThanOrEqual(0);
  expect(captureAt).toBeGreaterThan(rotateAt);
  expect(captureMessages(content).at(-1)).toEqual({
    type: "background.capture",
    active: true,
    recordingId: rotate.recordingId,
  });
});

test("after Start over, a status about the old recording's trajectory leaves the new recording's capture alone", async () => {
  const old = await record();
  const oldTrajectory = trajectoryOf(old);
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  const fresh = (await state()).recordingId ?? "";
  const newTrajectory = trajectoryOf(fresh);
  doc?.postMessage({
    type: "offscreen.status",
    capture: {
      intelligence: "held",
      intelligenceReason: "Learning capture is paused",
    },
    trajectoryId: oldTrajectory,
  });
  doc?.postMessage({
    type: "offscreen.status",
    capture: { events: { sent: 3, pending: 0, rejected: 0, dropped: 0 } },
    trajectoryId: newTrajectory,
  });
  await until(
    async () => (await state()).capture.events?.sent === 3,
    "the new recording's status",
  );
  expect((await state()).capture.intelligence).toBe("connecting");
  expect((await state()).capture.intelligenceReason).toBeUndefined();
  // A rollover of the new recording reports for it too.
  doc?.postMessage({
    type: "offscreen.trajectory",
    recordingId: fresh,
    trajectoryId: "t-3",
  });
  doc?.postMessage({
    type: "offscreen.status",
    capture: { intelligence: "streaming" },
    trajectoryId: "t-3",
  });
  await until(
    async () => (await state()).capture.intelligence === "streaming",
    "the rollover's status",
  );
});

test("a rollover adds its trajectory to the recording, and to a drain it belongs to", async () => {
  const id = await record();
  doc?.postMessage({
    type: "offscreen.trajectory",
    recordingId: id,
    trajectoryId: "t-2",
  });
  await until(
    () => active()?.trajectoryIds.includes("t-2") === true,
    "the trajectory is appended",
  );
  expect(active()?.trajectoryIds).toEqual([trajectoryOf(id), "t-2"]);
  await page({ type: "page.stop" });
  doc?.postMessage({
    type: "offscreen.trajectory",
    recordingId: id,
    trajectoryId: "t-3",
  });
  await until(
    () => drains()[0]?.trajectoryIds.includes("t-3") === true,
    "the drain's trajectory is appended",
  );
  expect(openbot.calls).toEqual([]);
});

test("Start over that comes when nothing records is refused", async () => {
  expect(await page({ type: "page.restart" })).toEqual({
    ok: false,
    error: "Nothing is being recorded.",
  });
});

// ---- Kept events, signing out and connecting again -------------------------------------------

test("kept events are listed, and discarded only when the person asks", async () => {
  const id = await record();
  await page({ type: "page.stop" });
  const first = doc;
  first?.postMessage({
    type: "offscreen.kept",
    recordingId: id,
    reason: "Learning capture is off for this organization.",
    parked: true,
    events: 12,
  });
  await until(() => drains()[0]?.kept !== undefined, "the drain is kept");
  expect(drains()[0]?.kept).toEqual({
    reason: "Learning capture is off for this organization.",
    parked: true,
    events: 12,
    at: now,
  });
  expect((await state()).kept).toMatchObject({
    recordings: 1,
    events: 12,
    parked: true,
    reason: "Learning capture is off for this organization.",
  });
  await until(
    () => !fake.offscreen.open,
    "the document closes (idle, only parked drains)",
  );
  expect(sentToDocument("offscreen.discard", first)).toEqual([]);
  expect(await page({ type: "page.kept.discard" })).toEqual({ ok: true });
  expect(fake.offscreen.created).toHaveLength(2);
  expect(sentToDocument("offscreen.discard")).toEqual([
    { type: "offscreen.discard", recordingIds: [id] },
  ]);
  expect(drains()).toEqual([]);
  expect((await state()).kept).toBeUndefined();
});

test("a kept answer that comes before Stop moves the recording into the drains is kept with it", async () => {
  const id = await record();
  holdStop = true;
  const stopping = page({ type: "page.stop" });
  await until(() => heldStops.length === 1, "the document heard the stop");
  doc?.postMessage({
    type: "offscreen.kept",
    recordingId: id,
    reason: "Learning capture is paused.",
    parked: false,
    events: 3,
  });
  await settle();
  doc?.postMessage({
    type: "offscreen.stopped",
    recordingId: id,
    trajectoryIds: [],
  });
  expect(await stopping).toEqual({ ok: true });
  expect(drains()[0]?.kept).toMatchObject({ parked: false, events: 3 });
});

test("a signed-out pass names its reason and keeps everything for the person", async () => {
  const id = await record();
  const document = doc;
  document?.postMessage({
    type: "offscreen.signed-out",
    reason: "organization",
    token: "obr_one",
  });
  await until(
    async () => (await state()).phase === "idle",
    "the recording stops",
  );
  expect(storedConnection()).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "organization",
  });
  const after = await state();
  expect(after.error).toBe(ORGANIZATION_SIGNED_OUT);
  expect(after.kept).toMatchObject({
    recordings: 1,
    parked: true,
    waitingFor: { name: "Ada", recordings: 1 },
  });
  // The person did not stop it: its outcome says the browser was signed out.
  expect(sentToDocument("offscreen.stop", document)).toEqual([
    { type: "offscreen.stop", outcome: "failed", reason: "signed-out" },
  ]);
  expect(sentToDocument("offscreen.discard", document)).toEqual([]);
  expect(drains()).toMatchObject([
    {
      recordingId: id,
      userId: "p1",
      kept: { waitingForReconnect: true, parked: true },
    },
  ]);
});

test("a signed-out answer the popup gets from OpenBot forgets the connection and stops the recording that used it, keeping everything", async () => {
  const id = await record();
  openbot.revoked.add("obr_one");
  const answer = (await page({ type: "page.state" })) as PageStateResponse;
  expect(answer).toMatchObject({ ok: true, connection: null, me: null });
  expect(storedConnection()).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "revoked",
  });
  expect(await state()).toMatchObject({ phase: "idle", error: SIGNED_OUT });
  expect(network.running.size).toBe(0);
  expect(drains()).toMatchObject([
    { recordingId: id, kept: { waitingForReconnect: true } },
  ]);
  expect(sentToDocument("offscreen.discard")).toEqual([]);
});

test("a signed-out answer to the Bot list does the same", async () => {
  await record();
  openbot.revoked.add("obr_one");
  const answer = await page({ type: "page.bots" });
  expect(answer.ok).toBe(false);
  expect(storedConnection()).toBeUndefined();
  expect((await state()).phase).toBe("idle");
  expect(drains()[0]?.kept?.waitingForReconnect).toBe(true);
});

test("connecting again as the same person sends what was kept; another person does not", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await until(
    () => drains()[0]?.kept?.waitingForReconnect === true,
    "kept for Ada",
  );
  connect(bea, "obr_bea");
  await handlers.connected();
  await settle();
  expect(sentToDocument("offscreen.recover")).toEqual([]);
  expect(drains()[0]?.kept?.waitingForReconnect).toBe(true);
  connect(ada, "obr_two");
  await handlers.connected();
  await until(
    () => sentToDocument("offscreen.recover").length === 1,
    "offscreen.recover",
  );
  expect(sentToDocument("offscreen.recover")[0]).toMatchObject({
    type: "offscreen.recover",
    openbotUrl: origin,
    token: "obr_two",
    allowedIntelligenceUrls: null,
    drains: [{ recordingId: id, userId: "p1" }],
  });
  expect(drains()[0]?.kept).toBeUndefined();
  expect(recordingRequests()).toEqual([]);
});

test("a sign-out the document reports for an older token, after the person connected again, changes nothing", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  expect(drains()).toMatchObject([{ recordingId: id }]);
  // Ada connects this browser again while the stopped recording still drains: its recover goes out with the new token.
  connect(ada, "obr_two");
  await handlers.connected();
  await until(
    () => sentToDocument("offscreen.recover").length === 1,
    "offscreen.recover",
  );
  // A pass the old connection's streamer took is answered signed out.
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await settle();
  expect(storedConnection()?.token).toBe("obr_two");
  expect(fake.storage.local.get("notice")).toBeUndefined();
  expect(drains()).toMatchObject([{ recordingId: id }]);
  expect(drains()[0]?.kept).toBeUndefined();
  expect((await state()).error).toBeUndefined();
  expect(fake.offscreen.open).toBe(true);
});

test("a sign-out the document reports for an older token leaves the new connection's recording running", async () => {
  connect(ada, "obr_two");
  await record();
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await settle();
  expect((await state()).phase).toBe("recording");
  expect(storedConnection()?.token).toBe("obr_two");
  expect(fake.storage.local.get("notice")).toBeUndefined();
  expect(sentToDocument("offscreen.stop")).toEqual([]);
});

test("a sign-out the document reports for the stored connection forgets it, tells the person, and keeps only that connection's drains waiting", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  const own = drains()[0] as DrainRecord;
  expect(own).toMatchObject({ recordingId: id, userId: "p1" });
  // Drains no connection of Ada's here sends: Bea's, and Ada's own on another OpenBot.
  const beas: DrainRecord = {
    ...own,
    recordingId: "rec-bea",
    userId: bea.id,
    userName: bea.name,
  };
  const elsewhere: DrainRecord = {
    ...own,
    recordingId: "rec-elsewhere",
    openbotUrl: "https://other-openbot.example.test",
  };
  fake.storage.local.set("drains", [own, beas, elsewhere]);
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await until(
    () => drains()[0]?.kept?.waitingForReconnect === true,
    "Ada's drain waits for her",
  );
  expect(storedConnection()).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "revoked",
  });
  expect(drains()[0]).toMatchObject({
    recordingId: id,
    kept: { parked: true, waitingForReconnect: true },
  });
  expect(drains().slice(1)).toEqual([beas, elsewhere]);
});

test("a sign-out that stops the running recording keeps waiting only the person's drains on this OpenBot", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  await record();
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  const own = drains()[0] as DrainRecord;
  const elsewhere: DrainRecord = {
    ...own,
    recordingId: "rec-elsewhere",
    openbotUrl: "https://other-openbot.example.test",
  };
  fake.storage.local.set("drains", [own, elsewhere]);
  const second = await record();
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await until(
    async () => (await state()).phase === "idle",
    "the recording stops",
  );
  await settle();
  expect(
    drains().find((drain) => drain.recordingId === second)?.kept,
  ).toMatchObject({ parked: true, waitingForReconnect: true });
  expect(
    drains().find((drain) => drain.recordingId === own.recordingId)?.kept,
  ).toMatchObject({ parked: true, waitingForReconnect: true });
  expect(
    drains().find((drain) => drain.recordingId === "rec-elsewhere"),
  ).toEqual(elsewhere);
});

test("a sign-out the document reports as a reconnect lands keeps no drain waiting and leaves the new connection", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  expect(drains()).toMatchObject([{ recordingId: id }]);
  // The handler's first read of the connection still finds the old token, and Ada connects again right after it.
  const local = chrome.storage.local as unknown as {
    get: (keys: unknown) => Promise<Record<string, unknown>>;
  };
  const original = local.get;
  local.get = async (keys) => {
    const items = await original.call(local, keys);
    if (keys === "connection") {
      local.get = original;
      connect(ada, "obr_two");
    }
    return items;
  };
  try {
    doc?.postMessage({
      type: "offscreen.signed-out",
      reason: "revoked",
      token: "obr_one",
    });
    await until(() => local.get === original, "the handler reads the token");
    await settle();
  } finally {
    local.get = original;
  }
  expect(storedConnection()?.token).toBe("obr_two");
  expect(fake.storage.local.get("notice")).toBeUndefined();
  expect(drains()).toMatchObject([{ recordingId: id }]);
  expect(drains().filter((drain) => drain.kept !== undefined)).toEqual([]);
});

test("a sign-out the document reports without a token is refused, logged, and changes nothing", async () => {
  await record();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    doc?.postMessage({ type: "offscreen.signed-out", reason: "revoked" });
    await settle();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[0]).toBe("Recorder: signing out failed");
    expect(String(logged.mock.calls[0]?.[1])).toContain(
      "offscreen.signed-out without a valid token",
    );
  } finally {
    logged.mockRestore();
  }
  expect((await state()).phase).toBe("recording");
  expect(storedConnection()?.token).toBe("obr_one");
  expect(fake.storage.local.get("notice")).toBeUndefined();
});

test("a recover the document could not be sent still lets it close once everything is done", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await until(
    () => drains()[0]?.kept?.waitingForReconnect === true,
    "kept for Ada",
  );
  await until(() => !fake.offscreen.open, "the document closes");
  const failure = throwOnFirstPost("offscreen.recover");
  connect(ada, "obr_two");
  await handlers.connected();
  await until(() => failure.thrown, "the recover post throws");
  await until(
    () => drains()[0]?.kept === undefined,
    "the drain no longer waits",
  );
  doc?.postMessage({ type: "offscreen.done", recordingId: id });
  await until(() => drains().length === 0, "the drain is forgotten");
  await until(() => !fake.offscreen.open, "the document closes again");
});

test("a discard the document could not be sent still lets the live recording's events through", async () => {
  const first = await record();
  await page({ type: "page.stop" });
  doc?.postMessage({
    type: "offscreen.kept",
    recordingId: first,
    reason: "Learning capture is off for this organization.",
    parked: true,
    events: 3,
  });
  await until(() => !fake.offscreen.open, "the document closes");
  const failure = throwOnFirstPost("offscreen.discard");
  await record();
  const content = contentPort(7);
  expect(await page({ type: "page.kept.discard" })).toMatchObject({
    ok: false,
  });
  expect(failure.thrown).toBe(true);
  content.postMessage({
    type: "content.event",
    event: contentEvent({ after: true }),
  });
  await until(
    () =>
      sentToDocument("offscreen.event").some(
        (message) =>
          message.type === "offscreen.event" &&
          (message.event.value as { after?: boolean } | undefined)?.after ===
            true,
      ),
    "the event reaches the document",
  );
});

// ---- Disconnect ------------------------------------------------------------------------------

test("Disconnect discards the kept recordings and the one recording, and nothing else does", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const first = await record();
  await page({ type: "page.stop" });
  doc?.postMessage({
    type: "offscreen.kept",
    recordingId: first,
    reason: "Learning capture is paused.",
    parked: false,
    events: 4,
  });
  await until(() => drains()[0]?.kept !== undefined, "the first is kept");
  const second = await record();
  expect(await page({ type: "page.disconnect" })).toEqual({ ok: true });
  await until(
    () => sentToDocument("offscreen.discard").length === 1,
    "offscreen.discard",
  );
  // What the recording streamed live is in Intelligence already: its outcome says it ended with a Disconnect.
  expect(sentToDocument("offscreen.stop").at(-1)).toEqual({
    type: "offscreen.stop",
    outcome: "failed",
    reason: "disconnected",
  });
  expect(sentToDocument("offscreen.discard")[0]).toEqual({
    type: "offscreen.discard",
    recordingIds: [first, second],
  });
  expect(drains()).toEqual([]);
  expect(storedConnection()).toBeUndefined();
  expect(await state()).toMatchObject({ phase: "idle", draining: 0 });
  expect((await state()).lastStopped?.recordingId).not.toBe(second);
  expect(recordingRequests()).toEqual([]);
});

test("Disconnect while a Stop drains discards that recording too", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  holdStop = true;
  const stopping = page({ type: "page.stop" });
  await until(async () => (await state()).phase === "stopping", "stopping");
  const disconnecting = page({ type: "page.disconnect" });
  await until(
    () => storedConnection() === undefined,
    "the connection is forgotten",
  );
  await settle();
  doc?.postMessage({
    type: "offscreen.stopped",
    recordingId: id,
    trajectoryIds: [],
  });
  expect(await stopping).toEqual({ ok: true });
  expect(await disconnecting).toEqual({ ok: true });
  expect(drains()).toEqual([]);
  expect(sentToDocument("offscreen.discard")).toEqual([
    { type: "offscreen.discard", recordingIds: [id] },
  ]);
  expect(active()).toBeUndefined();
  expect(await state()).toMatchObject({ phase: "idle", draining: 0 });
  expect((await state()).error).toBeUndefined();
});

test("a sign-out while a Stop drains tells the person, and keeps the recording for them", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  holdStop = true;
  const stopping = page({ type: "page.stop" });
  await until(async () => (await state()).phase === "stopping", "stopping");
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "organization",
    token: "obr_one",
  });
  await until(
    () => storedConnection() === undefined,
    "the connection is forgotten",
  );
  await settle();
  doc?.postMessage({
    type: "offscreen.stopped",
    recordingId: id,
    trajectoryIds: [],
  });
  expect(await stopping).toEqual({ ok: true });
  const after = await state();
  expect(after.error).toBe(ORGANIZATION_SIGNED_OUT);
  expect(after.kept).toMatchObject({
    recordings: 1,
    waitingFor: { name: "Ada", recordings: 1 },
  });
  expect(drains()).toMatchObject([
    {
      recordingId: id,
      kept: { waitingForReconnect: true, parked: true },
    },
  ]);
});

test("the same person connecting again while a Stop drains keeps the recording sending, under the new connection", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  holdStop = true;
  const stopping = page({ type: "page.stop" });
  await until(async () => (await state()).phase === "stopping", "stopping");
  connect(ada, "obr_two");
  await settle();
  doc?.postMessage({
    type: "offscreen.stopped",
    recordingId: id,
    trajectoryIds: [],
  });
  expect(await stopping).toEqual({ ok: true });
  expect(drains()).toMatchObject([{ recordingId: id }]);
  expect(drains()[0]?.kept).toBeUndefined();
  expect((await state()).error).toBeUndefined();
});

test("Disconnect while a Stop waits on a silent document answers at once, and discards that recording", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  holdStop = true;
  const stopping = page({ type: "page.stop" });
  await until(
    () => sentToDocument("offscreen.stop").length === 1,
    "offscreen.stop",
  );
  let answered = false;
  const disconnecting = page({ type: "page.disconnect" }).then((answer) => {
    answered = true;
    return answer;
  });
  // No clock moves: the stop's 120-second watchdog never fires.
  await until(() => answered, "Disconnect answers without the document");
  expect(await disconnecting).toEqual({ ok: true });
  expect(await stopping).toEqual({ ok: true });
  expect(drains()).toEqual([]);
  expect(sentToDocument("offscreen.discard")).toEqual([
    { type: "offscreen.discard", recordingIds: [id] },
  ]);
  expect(await state()).toMatchObject({ phase: "idle", draining: 0 });
});

test("Disconnect clears a sentence that says everything is kept until you connect again, since nothing is kept any more", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  await record();
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await until(
    async () => (await state()).error === SIGNED_OUT,
    "the signed-out sentence",
  );
  connect();
  expect(await page({ type: "page.disconnect" })).toEqual({ ok: true });
  expect(drains()).toEqual([]);
  expect((await state()).error).toBeUndefined();
});

// ---- Events, tabs and navigation -------------------------------------------------------------

test("content events wait while the offscreen port is down, and only the oldest beyond 2,000 are dropped, counted", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  await record();
  const content = contentPort(7);
  doc?.disconnect();
  doc = null;
  await settle();
  for (let i = 0; i < 2_010; i++) {
    content.postMessage({ type: "content.event", event: contentEvent({ i }) });
    if (i === 1_000)
      content.postMessage({
        type: "content.sensitive",
        digest: "d".repeat(64),
      });
  }
  await until(
    () =>
      (
        (fake.storage.session.get("digests") as string[] | undefined) ?? []
      ).includes("d".repeat(64)),
    "the digest is kept",
  );
  await settle();
  const again = fake.connectFrom(PORT_OFFSCREEN, OFFSCREEN_SENDER);
  await until(() => again.messages.length === 2_001, "the queue flushes");
  const events = (again.messages as BackgroundToOffscreen[]).map((m) =>
    m.type === "offscreen.event" ? m.event : null,
  );
  expect(events[0]).toMatchObject({
    type: "CUSTOM",
    name: "recorder.dropped",
    value: { count: 10, reason: "offscreen-unreachable" },
  });
  expect(events[1]?.value).toEqual({ i: 10 });
  expect(events.at(-1)?.value).toEqual({ i: 2_009 });
  expect(
    events.slice(1).map((e) => (e?.value as { i?: number } | undefined)?.i),
  ).toEqual(Array.from({ length: 2_000 }, (_, k) => k + 10));
});

test("the network capture is handed the fallback and the controller never calls the fallback itself", async () => {
  await record();
  expect(fallback.created).toBe(1);
  expect(network.options?.fallback).toBe(fallback.value);
  expect(network.deps?.openbotUrl()).toBe(origin);
  network.deps?.status("page", "Chrome refused the debugger here.");
  fake.webNavigation.createdTarget({
    sourceTabId: 7,
    tabId: 8,
    url: "https://crm.example.test/new",
  });
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/x",
  });
  await until(
    () => network.calls.includes("addTab 8 https://crm.example.test/new"),
    "addTab",
  );
  await until(
    () => network.calls.includes("onCommitted 7 0 https://crm.example.test/x"),
    "onCommitted",
  );
  expect((await state()).capture).toMatchObject({
    network: "page",
    networkReason: "Chrome refused the debugger here.",
  });
  await page({ type: "page.stop" });
  expect(fallback.calls).toEqual([]);
  expect(network.deps?.openbotUrl()).toBeNull();
});

test("a network event the capture emits goes to the document while the recording runs, and not after", async () => {
  await record();
  network.deps?.emit(event("network", { url: "https://crm.example.test/a" }));
  await until(
    () => sentToDocument("offscreen.event").length === 1,
    "the event is forwarded",
  );
  await page({ type: "page.stop" });
  network.deps?.emit(event("network", { url: "https://crm.example.test/b" }));
  await settle();
  expect(sentToDocument("offscreen.event")).toHaveLength(1);
});

test("in the e2e build the hold interval travels in the session", async () => {
  useVariant("e2e");
  fake.storage.local.set("RECORDER_E2E_HOLD_RETRY_MS", 5_000);
  await record();
  expect(sentToDocument("offscreen.start")[0]).toMatchObject({
    session: { e2eHoldRetryMs: 5_000 },
  });
});

test("outside the e2e build the session carries no hold interval", async () => {
  fake.storage.local.set("RECORDER_E2E_HOLD_RETRY_MS", 5_000);
  await record();
  const start = sentToDocument("offscreen.start")[0];
  expect(
    start?.type === "offscreen.start" && "e2eHoldRetryMs" in start.session,
  ).toBe(false);
});

test("in the e2e build a flood forwards synthetic events to the document", async () => {
  useVariant("e2e");
  await record();
  expect(await page({ type: "RECORDER_E2E_FLOOD", count: 3 })).toEqual({
    ok: true,
  });
  await until(
    () => sentToDocument("offscreen.event").length === 3,
    "three events",
  );
  expect(
    sentToDocument("offscreen.event").map((m) =>
      m.type === "offscreen.event" ? [m.event.name, m.event.value] : null,
    ),
  ).toEqual([
    ["recorder.e2e", { i: 0 }],
    ["recorder.e2e", { i: 1 }],
    ["recorder.e2e", { i: 2 }],
  ]);
});

test("sensitive digests live in storage.session only, reach the page masking, and go at Stop", async () => {
  const digest = "a".repeat(64);
  await record();
  contentPort(7).postMessage({ type: "content.sensitive", digest });
  await until(
    () =>
      (
        (fake.storage.session.get("digests") as string[] | undefined) ?? []
      ).includes(digest),
    "the digest is kept",
  );
  expect(JSON.stringify([...fake.storage.local.values()])).not.toContain(
    digest,
  );
  network.deps?.status("page");
  acceptAnswer = contentEvent({ masked: true });
  await fake.sendExternal(
    { type: "recorder.page-network", event: contentEvent({ body: "x" }) },
    { tab: { id: 7 } as chrome.tabs.Tab, url: DEAL },
  );
  expect(accepted[0]?.digests).toEqual([digest]); // masking sees the digest
  expect([...(network.deps?.digests() ?? [])]).toEqual([digest]);
  await page({ type: "page.stop" });
  expect(fake.storage.session.get("digests")).toBeUndefined();
});

test("events from a tab that is not being recorded are ignored", async () => {
  await record();
  const other = contentPort(99);
  other.postMessage({ type: "content.event", event: event("click", {}) });
  await until(() => other.messages.length > 0, "the tab is told to stop");
  await settle();
  expect(sentToDocument("offscreen.event")).toEqual([]);
  expect((await state()).actions).toBe(0);
  expect(other.messages).toContainEqual({
    type: "background.capture",
    active: false,
  });
});

test("a content script that says hello learns whether to capture", async () => {
  const id = await record();
  const followed = contentPort(7);
  const other = contentPort(99);
  followed.postMessage({ type: "content.hello", top: true, url: DEAL });
  other.postMessage({ type: "content.hello", top: true, url: DEAL });
  await until(
    () => followed.messages.length === 1 && other.messages.length === 1,
    "answers",
  );
  expect(followed.messages[0]).toEqual({
    type: "background.capture",
    active: true,
    recordingId: id,
  });
  expect(other.messages[0]).toEqual({
    type: "background.capture",
    active: false,
  });
});

test("a tab the recorded tab opened is followed", async () => {
  await record();
  fake.webNavigation.createdTarget({
    sourceTabId: 7,
    tabId: 8,
    url: "https://crm.example.test/report",
  });
  await until(
    () => network.calls.includes("addTab 8 https://crm.example.test/report"),
    "addTab",
  );
  expect(await state()).toMatchObject({
    tabIds: [7, 8],
    topUrls: { "7": DEAL, "8": "https://crm.example.test/report" },
  });
  contentPort(8).postMessage({
    type: "content.event",
    event: contentEvent({ from: 8 }),
  });
  await until(
    () => sentToDocument("offscreen.event").length === 1,
    "the event is forwarded",
  );
  fake.webNavigation.createdTarget({
    sourceTabId: 99,
    tabId: 100,
    url: "https://other.example.test/",
  });
  await settle();
  expect((await state()).tabIds).toEqual([7, 8]);
});

test("navigation in every frame becomes a navigation event for Intelligence, with masked addresses", async () => {
  await record();
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/deals/43?tab=notes",
    transitionType: "link",
  });
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 2,
    parentFrameId: 0,
    url: "https://widgets.example.test/a?token=abc",
  });
  fake.webNavigation.historyUpdate({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/deals/44",
  });
  await until(
    () => sentToDocument("offscreen.event").length === 3,
    "three navigation events",
  );
  const events = sentToDocument("offscreen.event").map((m) =>
    m.type === "offscreen.event" ? m.event : null,
  );
  expect(events[0]).toMatchObject({
    name: "navigation",
    value: { from: DEAL, navigationType: "push", frameId: 0 },
  });
  expect(events[1]).toMatchObject({
    name: "navigation",
    value: {
      frameId: 2,
      from: "",
      to: "https://widgets.example.test/a?token=[redacted]",
    },
  });
  expect(events[2]).toMatchObject({
    name: "navigation",
    value: {
      from: "https://crm.example.test/deals/43?tab=notes",
      to: "https://crm.example.test/deals/44",
    },
  });
  expect((await state()).topUrls["7"]).toBe(
    "https://crm.example.test/deals/44",
  );
  expect(openbot.calls).toEqual([]);
});

test("a frame's address from an earlier recording is never where its navigation in the next one came from", async () => {
  const frameNavigation = async (url: string) => {
    const before = sentToDocument("offscreen.event").length;
    fake.webNavigation.commit({ tabId: 7, frameId: 2, parentFrameId: 0, url });
    await until(
      () => sentToDocument("offscreen.event").length === before + 1,
      `the frame's navigation to ${url}`,
    );
    const message = sentToDocument("offscreen.event").at(-1);
    return message?.type === "offscreen.event" ? message.event.value : null;
  };
  await record();
  await frameNavigation("https://widgets.example.test/a");
  expect(await frameNavigation("https://widgets.example.test/b")).toMatchObject(
    { from: "https://widgets.example.test/a" },
  );
  await page({ type: "page.stop" });
  await record();
  expect(await frameNavigation("https://widgets.example.test/c")).toMatchObject(
    { frameId: 2, from: "" },
  );
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  expect(await frameNavigation("https://widgets.example.test/d")).toMatchObject(
    { frameId: 2, from: "" },
  );
});

test("a whole recording, Start over included, asks OpenBot for nothing", async () => {
  await page({ type: "page.bots" });
  const content = contentPort(7);
  await record();
  content.postMessage({ type: "content.event", event: event("click", {}) });
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/deals/43",
  });
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  await settle();
  expect(requests()).toEqual(["GET /api/recorder/bots"]);
});

// ---- The popup's state, Bots and sign-out ------------------------------------------------------

test("page.state answers with the connection, me and the policy address, fetching me at most once a minute", async () => {
  policy = {
    openbotUrl: origin,
    openbotUrlInvalid: false,
    allowedIntelligenceUrls: null,
  };
  fake.storage.local.set("notice", { kind: "interrupted", at: 1 });
  const answer = (await page({ type: "page.state" })) as PageStateResponse;
  expect(answer).toMatchObject({
    ok: true,
    state: { phase: "idle", tabIds: [], actions: 0 },
    connection: {
      openbotUrl: origin,
      user: { name: "Ada", email: "ada@example.test" },
      via: "web",
    },
    me: meBody,
    policy: { openbotUrl: origin, invalid: false },
    notice: { kind: "interrupted", at: 1 },
  });
  expect(
    (answer.connection as unknown as { token?: string }).token,
  ).toBeUndefined();
  await page({ type: "page.state" });
  const meCalls = () => requests().filter((r) => r === "GET /api/recorder/me");
  expect(meCalls()).toHaveLength(1);
  now += 61_000;
  await page({ type: "page.state" });
  expect(meCalls()).toHaveLength(2);
  expect(await page({ type: "page.notice.dismiss" })).toEqual({ ok: true });
  expect(fake.storage.local.get("notice")).toBeUndefined();
});

test("page.bots lists the Bots", async () => {
  expect(await page({ type: "page.bots" })).toEqual({
    ok: true,
    bots: openbot.bots,
  });
  expect(openbot.calls[0]).toMatchObject({
    method: "GET",
    path: "/api/recorder/bots",
    auth: "Bearer obr_one",
  });
});

test("a signed-out answer from me forgets the connection with its reason", async () => {
  openbot.me = {
    status: 401,
    body: {
      error: "Connect again.",
      code: RECORDER_SIGNED_OUT,
      reason: "removed",
    },
  };
  const answer = (await page({ type: "page.state" })) as PageStateResponse;
  expect(answer).toMatchObject({ ok: true, connection: null, me: null });
  expect(storedConnection()).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "removed",
  });
});

test("a page-network event is accepted only from a recorded tab while page capture is on, and goes to the capture", async () => {
  await record();
  const raw = contentEvent({ request: "x" });
  const fromTab = (tabId: number) =>
    fake.sendExternal(
      { type: "recorder.page-network", event: raw },
      {
        tab: { id: tabId } as chrome.tabs.Tab,
        url: DEAL,
        origin: "https://crm.example.test",
      },
    );
  expect(await fromTab(7)).toEqual({ ok: false, error: "not-recording" }); // the debugger is capturing
  network.deps?.status("page");
  acceptAnswer = null;
  expect(await fromTab(7)).toEqual({ ok: false, error: "invalid" });
  expect(network.recorded).toEqual([]);
  const masked = contentEvent({ request: "[redacted]" });
  acceptAnswer = masked;
  expect(await fromTab(7)).toEqual({ ok: true });
  expect(network.recorded).toEqual([masked]);
  expect(sentToDocument("offscreen.event")).toEqual([]); // the capture emits it, not this module
  expect((await state()).actions).toBe(0); // network calls are not actions
  expect(await fromTab(99)).toEqual({ ok: false, error: "not-recording" });
  expect(network.recorded).toHaveLength(1);
});

test("the state machine's transitions need no timers", () => {
  const capture: RecorderState["capture"] = {
    intelligence: "connecting",
    network: "debugger",
  };
  let current = reduceRecorder(IDLE_STATE, {
    type: "record",
    botId: "bot-1",
    title: "T",
    learning: { state: "assigned", containerId: "space-1" },
  });
  expect(current).toMatchObject({
    phase: "starting",
    botId: "bot-1",
    title: "T",
  });
  current = reduceRecorder(current, {
    type: "started",
    recordingId: "r1",
    tabId: 7,
    topUrl: DEAL,
    startedAt: 5,
    capture,
  });
  expect(current).toMatchObject({
    phase: "recording",
    tabIds: [7],
    actions: 0,
    topUrls: { "7": DEAL },
  });
  current = reduceRecorder(current, { type: "action" });
  current = reduceRecorder(current, { type: "action" });
  current = reduceRecorder(current, { type: "stop", since: 9 });
  expect(current).toMatchObject({
    phase: "stopping",
    actions: 2,
    stopping: { since: 9 },
  });
  current = reduceRecorder(current, {
    type: "finished",
    lastStopped: { recordingId: "r1", botId: "bot-1" },
  });
  expect(current).toMatchObject({
    phase: "idle",
    actions: 0,
    tabIds: [],
    lastStopped: { recordingId: "r1", botId: "bot-1" },
    learning: { state: "assigned", containerId: "space-1" },
  });
  expect(current.stopping).toBeUndefined();
  current = reduceRecorder(current, { type: "finished" });
  expect(current.learning).toBeUndefined();
  current = reduceRecorder(current, { type: "error", error: "No." });
  expect(current).toMatchObject({ phase: "idle", error: "No." });
});

// ---- Every pair of actions at every wait ---------------------------------------------------------
//
// The first action is held at one of its waits, the second is fired, the wait is let go, and once everything has
// settled the invariants that matter are checked:
// (i)   after a Stop, a Disconnect or a sign-out nothing captures: no network capture, the tab's last word is to stop
//       capturing, and the document hears no start or rotate after its last stop or discard;
// (ii)  nothing is silently lost: every recording the tabs captured for is the live one, a drain the document still
//       sends (or keeps for its person), or one a Disconnect discarded on purpose; a recording discarded without a
//       Disconnect never captured anything (a Record that never went live);
// (iii) the phase, the live recording, the active recording, the stream session, the connection and the drains agree.
// Every pair runs at every wait, including two the popup cannot send (it offers Start over only once a recording is
// live, and Record only while idle): the controller refuses or waits for them, and must stay consistent either way.

type Action = "Record" | "Stop" | "Start over" | "Disconnect" | "sign-out";
type Delivery = "document" | "popup";
type Held = { hit(): boolean; open(): void };
type Wait = { name: string; hold(): Held };

const stopLike = (action: Action) =>
  action === "Stop" || action === "Disconnect" || action === "sign-out";

/** OpenBot ends the connection: every request with its token is answered signed out from then on. The Recorder hears
 * of it from the document's pass (`document`), or from the popup asking for its state (`popup`). */
async function signOut(via: Delivery): Promise<undefined> {
  const connection = storedConnection();
  if (!connection) return undefined;
  openbot.revoked.add(connection.token);
  if (via === "document" && doc) {
    doc.postMessage({
      type: "offscreen.signed-out",
      reason: "revoked",
      token: connection.token,
    });
    return undefined;
  }
  fake.storage.session.delete("me");
  await page({ type: "page.state" });
  return undefined;
}

function fire(
  action: Action,
  via: Delivery = "document",
): Promise<PageResponse | undefined> {
  switch (action) {
    case "Record":
      return page({
        type: "page.record",
        botId: "bot-1",
        title: "T",
        tabId: 7,
      });
    case "Stop":
      return page({ type: "page.stop" });
    case "Start over":
      return page({ type: "page.restart" });
    case "Disconnect":
      return page({ type: "page.disconnect" });
    case "sign-out":
      return signOut(via);
  }
}

/** The document keeps a stop unanswered (its outcome not yet queued) until the wait is let go. */
const holdDocumentDrain = (): Held => {
  holdStop = true;
  return {
    hit: () => heldStops.length > 0,
    open: () => {
      holdStop = false;
      for (const recordingId of heldStops.splice(0))
        doc?.postMessage({
          type: "offscreen.stopped",
          recordingId,
          trajectoryIds: [],
        });
    },
  };
};
const items = (argument: unknown) => argument as Record<string, unknown>;
const writes = (key: string) => (argument: unknown) =>
  items(argument)[key] !== undefined;
const removes = (key: string) => (argument: unknown) =>
  argument === key || (Array.isArray(argument) && argument.includes(key));
/** The recording that was live when the first action began. */
let firstRecording = "";

const recordMatrixWaits: Wait[] = [
  ...recordWaits,
  { name: "the script injection", hold: holdFirstInjection },
  { name: "the network capture's start", hold: () => hold("networkStart") },
];
const stopWaits: Wait[] = [
  {
    name: "saving the stopping state",
    hold: () =>
      holdStorage(
        "session",
        "set",
        (argument) =>
          (items(argument).recorder as RecorderState | undefined)?.phase ===
          "stopping",
      ),
  },
  { name: "the network capture's stop", hold: () => hold("networkStop") },
  { name: "the document queuing the outcome", hold: holdDocumentDrain },
  {
    name: "saving the drains",
    hold: () => holdStorage("local", "set", writes("drains")),
  },
  {
    name: "forgetting the stream session",
    hold: () => holdStorage("session", "remove", removes("stream")),
  },
];
const restartWaits: Wait[] = [
  {
    name: "saving the switch",
    hold: () =>
      holdStorage("local", "set", (argument) => {
        const saved = items(argument).activeRecording as
          | DrainRecord
          | undefined;
        return saved !== undefined && saved.recordingId !== firstRecording;
      }),
  },
  {
    name: "saving the switched stream session",
    hold: () =>
      holdStorage("session", "set", (argument) => {
        const saved = items(argument).stream as StreamSession | undefined;
        return saved !== undefined && saved.recordingId !== firstRecording;
      }),
  },
];
const disconnectWaits: Wait[] = [
  {
    name: "OpenBot forgetting the connection",
    hold: () => holdRoute("disconnect", "/api/recorder/connections/current"),
  },
  {
    name: "forgetting the stored connection",
    hold: () => holdStorage("local", "remove", removes("connection")),
  },
  { name: "the network capture's stop", hold: () => hold("networkStop") },
  {
    name: "saving the drains",
    hold: () => holdStorage("local", "set", writes("drains")),
  },
  {
    name: "clearing the drains",
    hold: () => holdStorage("local", "remove", removes("drains")),
  },
];
const documentSignOutWaits: Wait[] = [
  {
    name: "forgetting the stored connection",
    hold: () => holdStorage("local", "remove", removes("connection")),
  },
  {
    name: "writing the signed-out notice",
    hold: () => holdStorage("local", "set", writes("notice")),
  },
  { name: "the network capture's stop", hold: () => hold("networkStop") },
  {
    name: "saving the drains",
    hold: () => holdStorage("local", "set", writes("drains")),
  },
  {
    name: "marking the drains waiting",
    hold: () => holdStorage("local", "set", writes("drains"), 2),
  },
];
const popupSignOutWaits: Wait[] = [
  {
    name: "OpenBot's signed-out answer",
    hold: () => holdRoute("me", "/api/recorder/me"),
  },
  {
    name: "forgetting the stored connection",
    hold: () => holdStorage("local", "remove", removes("connection")),
  },
  { name: "the network capture's stop", hold: () => hold("networkStop") },
  {
    name: "saving the drains",
    hold: () => holdStorage("local", "set", writes("drains")),
  },
];

type FirstAction = {
  action: Action;
  via?: Delivery;
  label: string;
  /** Record starts from idle; everything else from a recording on tab 7 that already captured a click. */
  from: "idle" | "recording";
  waits: Wait[];
};
const firstActions: FirstAction[] = [
  {
    action: "Record",
    label: "Record",
    from: "idle",
    waits: recordMatrixWaits,
  },
  { action: "Stop", label: "Stop", from: "recording", waits: stopWaits },
  {
    action: "Start over",
    label: "Start over",
    from: "recording",
    waits: restartWaits,
  },
  {
    action: "Disconnect",
    label: "Disconnect",
    from: "recording",
    waits: disconnectWaits,
  },
  {
    action: "sign-out",
    via: "document",
    label: "a sign-out the document reports",
    from: "recording",
    waits: documentSignOutWaits,
  },
  {
    action: "sign-out",
    via: "popup",
    label: "a sign-out the popup hears",
    from: "recording",
    waits: popupSignOutWaits,
  },
];
const secondActions: Action[] = [
  "Record",
  "Stop",
  "Start over",
  "Disconnect",
  "sign-out",
];

/** Moves the clock until both actions answered, then lets everything still scheduled run (watchdogs, waits) and waits
 * for the service worker to go quiet. */
async function settleAll(
  pending: Record<"first" | "second", Promise<PageResponse | undefined>>,
) {
  const answers: Partial<Record<"first" | "second", PageResponse>> = {};
  const done = new Set<string>();
  for (const [which, promise] of Object.entries(pending))
    void promise.then(
      (answer) => {
        if (answer) answers[which as "first" | "second"] = answer;
        done.add(which);
      },
      () => done.add(which),
    );
  for (let round = 0; round < 40 && done.size < 2; round++) {
    await settle();
    if (done.size < 2) await advance(5_000);
  }
  const quiet = async () => {
    let before = "";
    for (let round = 0; round < 40; round++) {
      await settle();
      const after = `${openbot.calls.length} ${fake.calls.length} ${timers.length}`;
      if (after === before) return;
      before = after;
    }
  };
  await quiet();
  await advance(130_000);
  await quiet();
  const hung = (["first", "second"] as const)
    .filter((which) => !done.has(which))
    .map((which) => `the ${which} action never answered`);
  return { answers, hung };
}

/** Everything the invariants above say must hold once a pair of actions has settled. */
async function interleavingViolations(run: {
  first: Action;
  second: Action;
  answers: Partial<Record<"first" | "second", PageResponse>>;
  content: FakePort;
}): Promise<string[]> {
  const problems: string[] = [];
  const s = await state();
  const last =
    stopLike(run.second) || run.answers.second?.ok ? run.second : run.first;
  const involved = (action: Action) =>
    run.first === action || run.second === action;
  const allDrains = drains();
  const saved = active();
  const stream = fake.storage.session.get("stream") as
    | StreamSession
    | undefined;
  const live = network.deps?.openbotUrl() ?? null;
  const toDoc = everyDocumentMessage();
  const captures = captureMessages(run.content) as {
    active: boolean;
    recordingId?: string;
  }[];
  const lastCapture = captures.at(-1);
  const lastEndAt = toDoc.findLastIndex(
    (message) =>
      message.type === "offscreen.stop" || message.type === "offscreen.discard",
  );
  const lastStartAt = toDoc.findLastIndex(
    (message) =>
      message.type === "offscreen.start" || message.type === "offscreen.rotate",
  );
  const discarded = new Set(
    toDoc.flatMap((message) =>
      message.type === "offscreen.discard" ? message.recordingIds : [],
    ),
  );
  const captured = new Set(
    captures.flatMap((capture) =>
      capture.active && capture.recordingId ? [capture.recordingId] : [],
    ),
  );

  // (i) After a Stop, a Disconnect or a sign-out nothing captures.
  if (stopLike(last)) {
    if (s.phase !== "idle") problems.push(`(i) ${s.phase} after ${last}`);
    if (network.running.size > 0)
      problems.push("(i) a network capture still runs");
    if (lastCapture?.active)
      problems.push(
        `(i) the tab was last told to capture for ${lastCapture.recordingId}`,
      );
    if (lastStartAt > lastEndAt)
      problems.push(
        `(i) the document was told ${toDoc[lastStartAt]?.type} after its last stop`,
      );
  }

  // (ii) Nothing is silently lost.
  for (const id of captured) {
    const isLive = s.phase === "recording" && s.recordingId === id;
    const isDrain = allDrains.some((drain) => drain.recordingId === id);
    if (isLive || isDrain) continue;
    if (discarded.has(id) && involved("Disconnect")) continue;
    problems.push(
      `(ii) ${id} captured, and is neither live, a drain, nor discarded by a Disconnect`,
    );
  }
  for (const id of discarded)
    if (captured.has(id) && !involved("Disconnect"))
      problems.push(`(ii) ${id} captured, then discarded without a Disconnect`);

  // (iii) The state agrees with itself.
  if (s.phase === "starting" || s.phase === "stopping")
    problems.push(`(iii) still ${s.phase}`);
  if (s.phase === "idle") {
    if (live) problems.push("(iii) idle while a recording is live");
    if (saved) problems.push(`(iii) idle with ${saved.recordingId} active`);
    if (stream)
      problems.push(
        `(iii) idle with a stream session for ${stream.recordingId}`,
      );
    if (network.running.size > 0)
      problems.push("(iii) idle while a network capture runs");
  }
  if (s.phase === "recording") {
    const id = s.recordingId;
    if (!live) problems.push(`(iii) recording ${id} while nothing is live`);
    if (saved?.recordingId !== id)
      problems.push(
        `(iii) recording ${id} while ${saved?.recordingId} is active`,
      );
    if (stream?.recordingId !== id)
      problems.push(
        `(iii) recording ${id} with a stream session for ${stream?.recordingId}`,
      );
    if (allDrains.some((drain) => drain.recordingId === id))
      problems.push(`(iii) recording ${id}, which is also a drain`);
    if (network.running.size !== 1)
      problems.push(
        `(iii) recording with ${network.running.size} network captures`,
      );
    if (!lastCapture?.active || lastCapture.recordingId !== id)
      problems.push(
        `(iii) recording ${id} while the tab was last told ${JSON.stringify(lastCapture)}`,
      );
    const started = toDoc[lastStartAt];
    const startedId =
      started?.type === "offscreen.start"
        ? started.session.recordingId
        : started?.type === "offscreen.rotate"
          ? started.recordingId
          : undefined;
    if (startedId !== id || lastEndAt > lastStartAt)
      problems.push(
        `(iii) recording ${id} while the document records ${lastEndAt > lastStartAt ? "nothing" : startedId}`,
      );
  }
  const ids = allDrains.map((drain) => drain.recordingId);
  if (new Set(ids).size !== ids.length)
    problems.push(`(iii) a drain is listed twice: ${ids.join(", ")}`);
  for (const drain of allDrains) {
    if (drain.discarding)
      problems.push(`(iii) ${drain.recordingId} is still being discarded`);
    if (discarded.has(drain.recordingId))
      problems.push(
        `(iii) ${drain.recordingId} was discarded and is still a drain`,
      );
  }
  // Signed out (not disconnected): every recording its person still has here waits for them to connect again.
  if (!storedConnection() && !involved("Disconnect"))
    for (const drain of allDrains)
      if (!drain.kept?.waitingForReconnect)
        problems.push(
          `(iii) signed out, and ${drain.recordingId} does not wait for its person`,
        );
  if (last === "Disconnect") {
    if (allDrains.length > 0)
      problems.push(`(iii) Disconnect left the drains ${ids.join(", ")}`);
    if ([SIGNED_OUT, ORGANIZATION_SIGNED_OUT].includes(s.error ?? ""))
      problems.push(`(iii) Disconnect left the error "${s.error}"`);
  }
  if (recordingRequests().length > 0)
    problems.push(`OpenBot heard ${recordingRequests().join(", ")}`);
  return problems;
}

for (const first of firstActions)
  for (const wait of first.waits)
    for (const second of secondActions)
      test(`interleaving: ${second} while ${first.label} waits on ${wait.name}`, async () => {
        fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
        const content = contentPort(7);
        firstRecording = "";
        if (first.from === "recording") {
          firstRecording = await record();
          content.postMessage({
            type: "content.event",
            event: event("click", { before: true }),
          });
          await until(async () => (await state()).actions === 1, "a click");
        }
        const held = wait.hold();
        const firstAnswer = fire(first.action, first.via);
        await until(held.hit, `${first.label} waits on ${wait.name}`);
        const secondAnswer = fire(second);
        await settle();
        held.open();
        const { answers, hung } = await settleAll({
          first: firstAnswer,
          second: secondAnswer,
        });
        const problems = await interleavingViolations({
          first: first.action,
          second,
          answers,
          content,
        });
        expect([...hung, ...problems]).toEqual([]);
      });
