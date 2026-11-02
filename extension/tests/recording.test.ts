import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type LearningSpaceState,
  RECORDER_AUTHORITY_UNAVAILABLE,
  RECORDER_SIGNED_OUT,
  recorderActivitySchema,
} from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import type {
  AgentObservation,
  CaptureObservation,
} from "../src/background/agent/observation";
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
  "This browser was disconnected from OpenBot. Your recording stopped, and everything in it is kept in this browser for 7 days, until you connect again.";
const ORGANIZATION_SIGNED_OUT =
  "Your organization sign-in ended. Your recording stopped, and everything in it is kept in this browser for 7 days, until you connect again.";
const POLICY_MOVED =
  "Your organization moved the Recorder to another OpenBot. Your recording stopped, and everything in it is kept in this browser for 7 days.";
const REPLACED =
  "This browser was connected to another OpenBot or person. Your recording stopped, and everything in it is kept in this browser for 7 days, until you connect again.";

const event = (name: string, value: unknown): CapturedEvent => ({
  type: "CUSTOM",
  name,
  timestamp: 1_700_000_000_000,
  value: value as CapturedEvent["value"],
});
/** A step the person took in the page, as a content script sends it. */
const contentEvent = (value: unknown) => event("click", value);

// ---- The fake OpenBot -------------------------------------------------------------------------
//
// The extension asks OpenBot only to connect: who is connected (`me`), the person's Learning space, and Disconnect; and
// tells it what it is doing (activity.ts), which holds nothing recorded. Every other request is recorded, so a test can
// say OpenBot heard nothing of a recording.

type Call = { method: string; path: string; auth: string | null };
type HeldRoute = "me" | "disconnect";

const openbot = {
  calls: [] as Call[],
  /** Tokens OpenBot no longer takes: `me` and the Learning space answer signed out for them. */
  revoked: new Set<string>(),
  /** While set, that route's answers wait for it. */
  holds: {} as Partial<Record<HeldRoute, Promise<void>>>,
  me: { status: 200, body: {} as object },
  learning: { state: "assigned", containerId: "space-1" } as LearningSpaceState,
  /** While set, OpenBot refuses the Learning space with this answer. */
  learningRefusal: null as { status: number; body: object } | null,
  /** Every report of what the Recorder is doing, as OpenBot received it. */
  activity: [] as unknown[],
};
const meBody = {
  user: ada,
  connectionId: "c-obr_one",
};
const CONNECTING = new Set([
  "POST /api/recorder/connections",
  "GET /api/recorder/me",
  "GET /api/recorder/learning",
  "DELETE /api/recorder/connections/current",
  "POST /api/recorder/activity",
]);

function resetOpenBot() {
  openbot.calls = [];
  openbot.revoked = new Set();
  openbot.holds = {};
  openbot.me = { status: 200, body: meBody };
  openbot.learningRefusal = null;
  openbot.activity = [];
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
      if (route === "GET /api/recorder/learning")
        return (
          signedOut() ??
          (openbot.learningRefusal
            ? Response.json(openbot.learningRefusal.body, {
                status: openbot.learningRefusal.status,
              })
            : Response.json({ learning: openbot.learning }))
        );
      if (route === "POST /api/recorder/activity") {
        openbot.activity.push(await request.json());
        return signedOut() ?? new Response(null, { status: 204 });
      }
      if (route === "DELETE /api/recorder/connections/current") {
        if (openbot.holds.disconnect) await openbot.holds.disconnect;
        return new Response(null, { status: 204 });
      }
      // A connect code is always Bea's here: the person who connects this browser in place of whoever it was connected as.
      if (route === "POST /api/recorder/connections")
        return Response.json(
          { token: "obr_bea", connection: { id: "c-obr_bea" }, user: bea },
          { status: 201 },
        );
      return Response.json({ error: "Not found." }, { status: 404 });
    },
  });
  origin = server.url.origin;
});
afterAll(() => server.stop(true));

const requests = () => openbot.calls.map((c) => `${c.method} ${c.path}`);
/** OpenBot's calls other than the reports of what the Recorder is doing (activity.ts), which hold nothing recorded. */
const callsBeyondActivity = () =>
  openbot.calls.filter((call) => call.path !== "/api/recorder/activity");
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
    if (
      message.type === "offscreen.start" ||
      message.type === "offscreen.resume"
    )
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
  /** The tab each page-level event came from, in order. */
  pageTabs: number[];

  failStart: boolean;
  /** How many captures were created, and the ones started and not stopped since. */
  created: number;
  running: Set<number>;
  /** The AG-UI observations the page hook's messages reached the capture with. */
  pageAgent: CaptureObservation[];
};

/** Each recording's agent events (agent/events.ts), as a double that says what it was handed. */
type AgentDouble = {
  observed: CaptureObservation[];
  clicks: { tabId: number; click: CapturedEvent }[];
  navigated: number[];
  stopped: boolean;
  /** Whether a click comes back with agent context, as the real agent events add it when a Thread is open. */
  enrich: boolean;
  /** Each click as it left the steps: its tab, and whether its join holds a run started 20 ms, 2 s and 5 s after it. */
  settled: {
    tabId: number;
    click: CapturedEvent;
    soon: boolean;
    late: boolean;
    past: boolean;
  }[];
  /** The Thread a settled click takes, as the real agent events give it the Thread of the run it started. */
  settleTo: string | null;
  emit(tabId: number, event: CapturedEvent): void;
};
let agents: AgentDouble[] = [];
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
        recordPageEvent: async (tabId, recorded) => {
          network.pageTabs.push(tabId);
          network.recorded.push(recorded);
        },
        recordPageAgent: (_tabId, observation) => {
          network.pageAgent.push(observation);
        },
        stop: async () => {
          network.calls.push("stop");
          await pass("networkStop");
          network.running.delete(capture);
        },
      };
    },
    createAgentEvents: (options) => {
      const agent: AgentDouble = {
        observed: [],
        clicks: [],
        navigated: [],
        stopped: false,
        enrich: false,
        settled: [],
        settleTo: null,
        emit: options.emit,
      };
      agents.push(agent);
      return {
        observe: (observation) => agent.observed.push(observation),
        enrichClick: (tabId, click) => {
          agent.clicks.push({ tabId, click });
          if (!agent.enrich) return click;
          return {
            ...click,
            value: { ...(click.value as object), agent: { threadId: "t-1" } },
          };
        },
        settleClick: (tabId, click, joins) => {
          agent.settled.push({
            tabId,
            click,
            soon: joins(click.timestamp + 20),
            late: joins(click.timestamp + 2_000),
            past: joins(click.timestamp + 5_000),
          });
          if (agent.settleTo === null) return click;
          return {
            ...click,
            value: { ...(click.value as object), threadId: agent.settleTo },
          };
        },
        awaitsRun: () => false,
        tabNavigated: (tabId) => agent.navigated.push(tabId),
        snapshot: () => ({ tabs: [], recordedRuns: [] }),
        restore: () => {},
        stop: () => {
          agent.stopped = true;
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
  title: string;
  tabId: number;
  language?: string;
  narrate?: boolean;
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
const record = () => startRecording({ title: "T", tabId: 7 });
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
    pageTabs: [],
    failStart: false,
    created: 0,
    running: new Set(),
    pageAgent: [],
  };
  agents = [];
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
  // The person chose to narrate (the setup page, or the Record form).
  fake.storage.local.set("narration", "on");
  const id = await startRecording({
    title: "Update deal",
    tabId: 7,
    language: "de-DE",
  });
  expect(id).toMatch(UUID);
  expect(callsBeyondActivity()).toEqual([]);
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
    openbotUrl: origin,
    token: "obr_one",
    trajectoryId: expect.stringMatching(UUID),
    startedAt: now,
    allowedIntelligenceUrls: null,
    version: "0.3.0",
    // A person who chose to narrate narrates every recording, in the page's language.
    voice: { language: "de-DE", muted: false },
  });
  expect(start.session.trajectoryId).not.toBe(id);
  expect(fake.offscreen.created[0]).toMatchObject({
    url: "offscreen.html",
    reasons: ["LOCAL_STORAGE", "USER_MEDIA"],
  });
  expect((await state()).capture.voice).toEqual({ state: "starting" });
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
    title: "Update deal",
    openbotUrl: origin,
    userId: "p1",
    userName: "Ada",
    trajectoryIds: [start.session.trajectoryId],
    startedAt: now,
  });
  // No Bot is remembered: there is none to pick.
  expect(fake.storage.local.get("lastBotId")).toBeUndefined();
  expect(fake.storage.session.get("stream")).toEqual(start.session);
  expect(await state()).toMatchObject({
    phase: "recording",
    recordingId: id,
    tabIds: [7],
    topUrls: { "7": DEAL },
    actions: 0,
    capture: { intelligence: "connecting", network: "debugger" },
  });
  expect(fake.badge).toEqual({ text: "REC", color: "#e7000b" });
});

test("the microphone stays closed until the person chooses to narrate, and OpenBot's own Record can ask for it", async () => {
  // Nobody chose yet: the recording starts muted, and its Voice row says so.
  const first = await startRecording({ title: "T", tabId: 7 });
  const start = (recordingId: string) =>
    sentToDocument("offscreen.start").find(
      (message) =>
        message.type === "offscreen.start" &&
        message.session.recordingId === recordingId,
    );
  const opened = start(first);
  if (opened?.type !== "offscreen.start") throw new Error("No start");
  expect(opened.session.voice).toEqual({ language: "en-US", muted: true });
  expect((await state()).capture.voice).toEqual({ state: "muted" });
  await page({ type: "page.stop" });
  await until(async () => (await state()).phase === "idle", "idle");

  // Chosen off: still closed.
  expect(await page({ type: "page.narration", on: false })).toEqual({
    ok: true,
  });
  expect(fake.storage.local.get("narration")).toBe("off");
  const second = await startRecording({ title: "T", tabId: 7 });
  const off = start(second);
  if (off?.type !== "offscreen.start") throw new Error("No start");
  expect(off.session.voice?.muted).toBe(true);
  await page({ type: "page.stop" });
  await until(async () => (await state()).phase === "idle", "idle");

  // OpenBot's own Record form asked the person, and they said yes: that recording narrates.
  const third = await startRecording({ title: "T", tabId: 7, narrate: true });
  const asked = start(third);
  if (asked?.type !== "offscreen.start") throw new Error("No start");
  expect(asked.session.voice?.muted).toBe(false);
  // Its answer is for that recording only: the person's own choice in the Recorder stays as they made it.
  expect(fake.storage.local.get("narration")).toBe("off");
});

test("Record copies the person's own Learning space, as OpenBot last described it", async () => {
  await page({ type: "page.learning" });
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

test("Record after the person took website access away in the browser's settings says how to give it back", async () => {
  // The install grants it; only the person's own Site access setting can withhold it afterwards.
  hostAccess = false;
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  expect(await page({ type: "page.record", title: "T", tabId: 7 })).toEqual({
    ok: false,
    error:
      "Site access is off for OpenBot Recorder. Open your browser's Extensions page, choose Details on OpenBot Recorder and set Site access to On all sites.",
  });
  expect(fake.offscreen.created).toEqual([]);
  expect(await state()).toMatchObject({
    phase: "idle",
    error:
      "Site access is off for OpenBot Recorder. Open your browser's Extensions page, choose Details on OpenBot Recorder and set Site access to On all sites.",
  });
});

test("Record without a connection is refused", async () => {
  fake.storage.local.delete("connection");
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  const answer = await page({
    type: "page.record",
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
  expect(callsBeyondActivity()).toEqual([]);
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
    lastStopped: { recordingId: id },
    draining: 1,
  });
  expect(drains()).toMatchObject([{ recordingId: id }]);
  expect(active()).toBeUndefined();
  expect(fake.storage.session.get("stream")).toBeUndefined();
  expect(fake.badge.text).toBe("");
  expect(fake.offscreen.open).toBe(true);
  doc?.postMessage({ type: "offscreen.done", recordingId: id });
  await until(() => drains().length === 0, "the drain goes");
  await until(() => !fake.offscreen.open, "the document closes");
  expect((await state()).draining).toBe(0);
  expect(callsBeyondActivity()).toEqual([]);
});

test("a recording the document could not send at all never reads as sent: Stop says nothing reached Intelligence", async () => {
  const id = await record();
  const NOT_SENT =
    "Nothing of this recording reached Intelligence: the Recorder could not start sending it. Try recording again.";
  holdStop = true;
  const stopping = page({ type: "page.stop" });
  await until(
    () => sentToDocument("offscreen.stop").length === 1,
    "offscreen.stop",
  );
  doc?.postMessage({
    type: "offscreen.stopped",
    recordingId: id,
    trajectoryIds: [],
  });
  doc?.postMessage({
    type: "offscreen.done",
    recordingId: id,
    failed: NOT_SENT,
  });
  expect(await stopping).toEqual({ ok: true });
  await until(() => drains().length === 0, "the drain goes");
  const after = await state();
  expect(after.lastStopped).toBeUndefined();
  expect(after.error).toBe(NOT_SENT);
});

test("a could-not-send answer that comes after Stop finished takes back the sent line", async () => {
  const id = await record();
  holdStop = true;
  const stopping = page({ type: "page.stop" });
  await until(
    () => sentToDocument("offscreen.stop").length === 1,
    "offscreen.stop",
  );
  doc?.postMessage({
    type: "offscreen.stopped",
    recordingId: id,
    trajectoryIds: [],
  });
  await stopping;
  expect((await state()).lastStopped?.recordingId).toBe(id);
  doc?.postMessage({
    type: "offscreen.done",
    recordingId: id,
    failed: "Nothing of this recording reached Intelligence.",
  });
  await until(
    async () => (await state()).lastStopped === undefined,
    "the sent line goes",
  );
  expect((await state()).error).toBe(
    "Nothing of this recording reached Intelligence.",
  );
});

test("the popup keeps the person's Learning space after Stop", async () => {
  await page({ type: "page.learning" });
  await record();
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  expect((await state()).learning).toEqual({
    state: "assigned",
    containerId: "space-1",
  });
});

test("the popup keeps the person's Learning space after Stop when Chrome stopped the service worker before Record", async () => {
  // End-to-end run 8: the popup opened and asked, the service worker went idle and Chrome stopped it, and the next one
  // started the recording with no Learning space, so after Stop the popup said only "Sent to Intelligence".
  await page({ type: "page.learning" });
  fake.restartServiceWorker();
  handlers = installRecording(doubles());
  installRouter(handlers);
  const id = await record();
  expect((await state()).learning).toEqual({
    state: "assigned",
    containerId: "space-1",
  });
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  expect(await state()).toMatchObject({
    phase: "idle",
    lastStopped: { recordingId: id },
    learning: { state: "assigned", containerId: "space-1" },
  });
  // Nothing more was asked of OpenBot for it: Record still tells OpenBot nothing.
  expect(
    requests().filter((request) => request === "GET /api/recorder/learning"),
  ).toHaveLength(1);
});

test("a service worker that restarted takes up no Learning space read for another connection", async () => {
  await page({ type: "page.learning" });
  connect(bea, "obr_two");
  fake.restartServiceWorker();
  handlers = installRecording(doubles());
  installRouter(handlers);
  await record();
  expect((await state()).learning).toBeUndefined();
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

test("Stop after the document went away reopens it on the stored session, so the outcome is queued now", async () => {
  const id = await record();
  const session = sentToDocument("offscreen.start")[0];
  if (session?.type !== "offscreen.start") throw new Error("No start");
  await chrome.offscreen.closeDocument();
  await settle();
  let answered = false;
  void page({ type: "page.stop" }).then(() => {
    answered = true;
  });
  await until(() => answered, "Stop finishes without a timer");
  expect(sentToDocument("offscreen.resume")).toEqual([
    {
      type: "offscreen.resume",
      session: session.session,
    },
  ]);
  expect(sentToDocument("offscreen.stop")).toEqual([
    { type: "offscreen.stop", outcome: "succeeded" },
  ]);
  expect((await state()).phase).toBe("idle");
  expect(drains()).toMatchObject([{ recordingId: id }]);
});

test("a document that goes away mid-recording is reopened on the stored session once its port stays down, and the waiting events follow", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  const content = contentPort(7);
  const session = sentToDocument("offscreen.start")[0];
  if (session?.type !== "offscreen.start") throw new Error("No start");
  // The document crashes: Chrome no longer lists it, and its port is gone.
  await chrome.offscreen.closeDocument();
  await settle();
  content.postMessage({ type: "content.event", event: contentEvent({ i: 1 }) });
  await settle();
  expect(fake.offscreen.created).toHaveLength(1);
  await advance(5_000);
  await until(
    () => sentToDocument("offscreen.event").length === 1,
    "the waiting event reaches the reopened document",
  );
  expect(fake.offscreen.created).toHaveLength(2);
  expect(toDocument().map((message) => message.type)).toEqual([
    "offscreen.resume",
    "offscreen.event",
  ]);
  expect(sentToDocument("offscreen.resume")[0]).toEqual({
    type: "offscreen.resume",
    session: session.session,
  });
  expect(await state()).toMatchObject({ phase: "recording", recordingId: id });
});

test("a document whose port comes back within the window is left alone", async () => {
  await record();
  doc?.disconnect();
  doc = null;
  await settle();
  const again = reconnectDocument();
  await advance(5_000);
  expect(fake.offscreen.created).toHaveLength(1);
  expect(sentToDocument("offscreen.resume", again)).toEqual([]);
});

test("a Stop waiting on a document that goes away tells the reopened document again", async () => {
  const id = await record();
  holdStop = true;
  let answered = false;
  void page({ type: "page.stop" }).then(() => {
    answered = true;
  });
  await until(
    () => sentToDocument("offscreen.stop").length === 1,
    "offscreen.stop",
  );
  holdStop = false;
  await chrome.offscreen.closeDocument();
  await settle();
  await advance(5_000);
  await until(() => answered, "Stop finishes on the reopened document");
  expect(toDocument().map((message) => message.type)).toEqual([
    "offscreen.resume",
    "offscreen.stop",
  ]);
  expect(drains()).toMatchObject([{ recordingId: id }]);
});

test("Start over is refused while the document cannot be reached, and the recording goes on", async () => {
  const id = await record();
  doc?.disconnect();
  doc = null;
  await settle();
  const restarting = page({ type: "page.restart" });
  await settle();
  await advance(5_000);
  expect(await restarting).toEqual({
    ok: false,
    error:
      "The Recorder could not start over just now. Your recording goes on; try again in a moment.",
  });
  expect(await state()).toMatchObject({ phase: "recording", recordingId: id });
  expect(everyDocumentMessage().map((message) => message.type)).not.toContain(
    "offscreen.rotate",
  );
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
      // The tab's recording mark: its site, and that the Recorder does not hear the person (nobody chose to narrate).
      site: "example.test",
      narrating: false,
    },
    {
      type: "background.capture",
      active: true,
      recordingId: rotate.recordingId,
      site: "example.test",
      narrating: false,
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
    () => sentToDocument("offscreen.event").length === 5,
    "every event forwarded",
  );
  await settle();
  // The page the recording started on, a click, an input (from any frame), and a page load with the history change the
  // page made right after it, one page change: the collector's page event and the frame load are not even recorded.
  // The start does not count; each top-frame page change does.
  expect((await state()).actions).toBe(4);
  expect(fake.badge.text).toBe("4");
  network.deps?.call({
    tabId: 7,
    startedAt: now,
    endedAt: now + 50,
    method: "GET",
    url: "https://crm.example.test/x",
  });
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
    network.deps?.call({
      tabId: 7,
      startedAt: now + i,
      endedAt: now + i + 50,
      method: "GET",
      url: DEAL,
    });
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

test("the 50-action notice still open follows the tab to its next page: the new page's script hears it on its hello", async () => {
  // Run 3: the notice was up on the order page, the person moved to the next page, and it was gone there while the
  // popup still said it was open.
  const top = await recordUntilNotice();
  expect(notices(top)).toEqual([
    { type: "background.notice", show: true, actions: 50 },
  ]);
  // The tab moves on: the old document's script goes, the new one's says hello (and an iframe's too).
  top.disconnect();
  const next = contentPort(7, 0);
  const frame = contentPort(7, 3);
  next.postMessage({
    type: "content.hello",
    top: true,
    url: "https://crm.example.test/deals/43",
  });
  frame.postMessage({
    type: "content.hello",
    top: false,
    url: "https://widgets.example.test/",
  });
  await until(() => notices(next).length === 1, "the notice on the new page");
  expect(notices(next)).toEqual([
    { type: "background.notice", show: true, actions: 50 },
  ]);
  expect(notices(frame)).toEqual([]);
  // Once answered it is down, and a later page does not show it again.
  next.postMessage({ type: "content.notice", choice: "continue" });
  await until(async () => !(await state()).noticeOpen, "answered");
  const later = contentPort(7, 0);
  later.postMessage({
    type: "content.hello",
    top: true,
    url: "https://crm.example.test/deals/44",
  });
  await until(() => captureMessages(later).length === 1, "the hello answered");
  expect(notices(later)).toEqual([]);
});

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
  // The popup and the page both say the count it opened at, while the count goes on.
  expect((await state()).noticeAt).toBe(50);
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
  expect((await state()).noticeAt).toBeUndefined();
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
    site: "example.test",
    narrating: false,
  });
  doc?.postMessage({ type: "offscreen.done", recordingId: old });
  await until(() => drains().length === 0, "the old one goes once sent");
  expect(sentToDocument("offscreen.discard")).toEqual([]);
  expect(callsBeyondActivity()).toEqual([]);
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
    site: "example.test",
    narrating: false,
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

test("once Intelligence takes events again the popup says Streaming, and nothing more of the retry", async () => {
  // Run 5: back online, the popup said "Streaming to Intelligence. Intelligence is busy or unreachable. Retrying;
  // nothing is lost." The document's status for streaming leaves the reason out, and the reason of the retry stayed.
  const id = await record();
  const trajectory = trajectoryOf(id);
  const busy =
    "Intelligence is busy or unreachable. Retrying; nothing is lost.";
  doc?.postMessage({
    type: "offscreen.status",
    capture: {
      intelligence: "retrying",
      intelligenceReason: busy,
      events: { sent: 3, pending: 4, rejected: 0, dropped: 0 },
    },
    trajectoryId: trajectory,
  });
  await until(
    async () => (await state()).capture.intelligenceReason === busy,
    "the retry",
  );
  // What the document posts when the socket joins again: the status, without a reason.
  doc?.postMessage({
    type: "offscreen.status",
    capture: {
      intelligence: "streaming",
      events: { sent: 7, pending: 0, rejected: 0, dropped: 0 },
    },
    trajectoryId: trajectory,
  });
  await until(
    async () => (await state()).capture.intelligence === "streaming",
    "streaming again",
  );
  const view = (await page({ type: "page.state" })) as PageStateResponse;
  expect(view.state.capture.intelligenceReason).toBeUndefined();
  // A status that says nothing of Intelligence (the voice, the counts) leaves a reason alone.
  doc?.postMessage({
    type: "offscreen.status",
    capture: {
      intelligence: "retrying",
      intelligenceReason: busy,
    },
    trajectoryId: trajectory,
  });
  doc?.postMessage({
    type: "offscreen.status",
    capture: { voice: { state: "listening" } },
    trajectoryId: trajectory,
  });
  await until(
    async () => (await state()).capture.voice?.state === "listening",
    "the voice",
  );
  expect((await state()).capture.intelligenceReason).toBe(busy);
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
  expect(callsBeyondActivity()).toEqual([]);
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

test("a signed-out answer to the Learning space does the same", async () => {
  await record();
  openbot.revoked.add("obr_one");
  const answer = await page({ type: "page.learning" });
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

test("the same person connecting again while recording moves the recording to the new token, and the old token's sign-out stops nothing", async () => {
  const id = await record();
  connect(ada, "obr_two");
  await handlers.connected();
  expect(sentToDocument("offscreen.token")).toEqual([
    { type: "offscreen.token", recordingId: id, token: "obr_two" },
  ]);
  expect((fake.storage.session.get("stream") as StreamSession).token).toBe(
    "obr_two",
  );
  // Connecting revoked the old token: the document's next pass with it comes back signed out.
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await settle();
  expect(await state()).toMatchObject({ phase: "recording", recordingId: id });
  expect(storedConnection()?.token).toBe("obr_two");
  expect(fake.storage.local.get("notice")).toBeUndefined();
});

test("an old token's sign-out that comes back before the reconnect is announced keeps the recording under the new connection", async () => {
  const id = await record();
  connect(ada, "obr_two");
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await until(
    () => sentToDocument("offscreen.token").length === 1,
    "offscreen.token",
  );
  expect(sentToDocument("offscreen.token")[0]).toEqual({
    type: "offscreen.token",
    recordingId: id,
    token: "obr_two",
  });
  expect(await state()).toMatchObject({ phase: "recording", recordingId: id });
});

test("another person connecting while a recording runs leaves the recording its own token", async () => {
  await record();
  connect(bea, "obr_bea");
  await handlers.connected();
  await settle();
  expect(sentToDocument("offscreen.token")).toEqual([]);
  expect((fake.storage.session.get("stream") as StreamSession).token).toBe(
    "obr_one",
  );
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

test("connecting again clears the sentence that the stopped recording waits for a connection, so the popup no longer says both sent and kept", async () => {
  // Run 6: after the person connected the browser again, the popup said "Sent to Intelligence" above "This browser was
  // disconnected from OpenBot ... kept in this browser for 7 days, until you connect again".
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const id = await record();
  doc?.postMessage({
    type: "offscreen.signed-out",
    reason: "revoked",
    token: "obr_one",
  });
  await until(
    async () => (await state()).error === SIGNED_OUT,
    "the signed-out sentence",
  );
  connect(ada, "obr_two");
  await handlers.connected();
  expect((await state()).error).toBeUndefined();
  // The kept recording goes to Intelligence under the new connection, and the popup then says it was sent.
  await until(
    () => sentToDocument("offscreen.recover").length === 1,
    "the kept recording recovered",
  );
  doc?.postMessage({ type: "offscreen.done", recordingId: id });
  await until(() => drains().length === 0, "the drain is forgotten");
  const view = (await page({ type: "page.state" })) as PageStateResponse;
  expect(view.state).toMatchObject({
    lastStopped: { recordingId: id },
    draining: 0,
  });
  expect(view.state.error).toBeUndefined();
});

// ---- A connection lost without a Disconnect ---------------------------------------------------

const meChecks = () =>
  openbot.calls.filter((call) => call.path === "/api/recorder/me");

test("while a recording runs OpenBot is asked every 30 s whether its connection stands, and a browser revoked in OpenBot ends the recording as signed out", async () => {
  const id = await record();
  const document = doc;
  await advance(29_999);
  expect(meChecks()).toEqual([]);
  await advance(1);
  await until(() => meChecks().length === 1, "the first check");
  expect(meChecks()[0]?.auth).toBe("Bearer obr_one");
  await advance(30_000);
  await until(() => meChecks().length === 2, "the second check");
  expect((await state()).phase).toBe("recording");

  // The person revokes this browser in OpenBot's Settings: the next check ends the recording through the sign-out path.
  openbot.revoked.add("obr_one");
  await advance(30_000);
  await until(async () => (await state()).phase === "idle", "the stop");
  expect(storedConnection()).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "revoked",
  });
  expect(sentToDocument("offscreen.halt", document)).toEqual([
    { type: "offscreen.halt", token: "obr_one" },
  ]);
  expect(sentToDocument("offscreen.stop", document)).toEqual([
    { type: "offscreen.stop", outcome: "failed", reason: "signed-out" },
  ]);
  expect(await state()).toMatchObject({ phase: "idle", error: SIGNED_OUT });
  expect(network.running.size).toBe(0);
  expect(drains()).toMatchObject([
    { recordingId: id, kept: { waitingForReconnect: true } },
  ]);

  // Nothing records any more, so nothing is checked.
  const checks = meChecks().length;
  await advance(90_000);
  expect(meChecks()).toHaveLength(checks);
});

test("a connection check that cannot reach OpenBot, or gets an error page, is no sign-out: the recording goes on and the next check asks again", async () => {
  await record();
  const realFetch = globalThis.fetch;
  const refused: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      refused.push(String(input));
      throw new TypeError("Failed to fetch");
    },
    { preconnect: realFetch.preconnect },
  );
  // The 30 s report of what the Recorder is doing fails the same way, and changes nothing either.
  const refusedChecks = () =>
    refused.filter((url) => url.endsWith("/api/recorder/me"));
  try {
    await advance(30_000);
    await until(() => refusedChecks().length === 1, "the check that fails");
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(refusedChecks()).toEqual([`${origin}/api/recorder/me`]);
  expect((await state()).phase).toBe("recording");
  expect(storedConnection()?.token).toBe("obr_one");

  openbot.me = { status: 503, body: { error: "OpenBot is restarting." } };
  await advance(30_000);
  await until(() => meChecks().length === 1, "the check OpenBot answers 503");
  await settle();
  expect((await state()).phase).toBe("recording");
  expect(storedConnection()?.token).toBe("obr_one");
  expect(sentToDocument("offscreen.stop")).toEqual([]);
  expect(sentToDocument("offscreen.halt")).toEqual([]);

  await advance(30_000);
  await until(() => meChecks().length === 2, "the next check");
  expect((await state()).phase).toBe("recording");
});

test("the connection check follows the recording through Start over, and stops with Stop", async () => {
  await record();
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  await advance(30_000);
  await until(() => meChecks().length === 1, "the check after Start over");
  await page({ type: "page.stop" });
  await advance(60_000);
  expect(meChecks()).toHaveLength(1);
});

test("a keep-alive that finds the connection signed out stops the recording at once and halts the document's streams for its token", async () => {
  const id = await record();
  const document = doc;
  const connection = storedConnection();
  if (!connection) throw new Error("No connection");
  await handlers.connectionLost({
    kind: "signed-out",
    reason: "revoked",
    connection,
  });
  expect(storedConnection()).toBeUndefined();
  expect(sentToDocument("offscreen.halt", document)).toEqual([
    { type: "offscreen.halt", token: "obr_one" },
  ]);
  expect(sentToDocument("offscreen.stop", document)).toEqual([
    { type: "offscreen.stop", outcome: "failed", reason: "signed-out" },
  ]);
  expect(await state()).toMatchObject({ phase: "idle", error: SIGNED_OUT });
  expect(network.running.size).toBe(0);
  expect(drains()).toMatchObject([
    { recordingId: id, kept: { waitingForReconnect: true } },
  ]);
});

test("a policy that moves the Recorder away stops the recording, halts the document's streams and keeps everything for its person", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const first = await record();
  await page({ type: "page.stop" });
  const second = await record();
  const document = doc;
  const connection = storedConnection();
  if (!connection) throw new Error("No connection");
  // connection.ts has forgotten the connection and left its notice.
  fake.storage.local.delete("connection");
  fake.storage.local.set("notice", {
    kind: "policy-moved",
    at: now,
    origin: "https://moved.example.test",
  });
  await handlers.connectionLost({ kind: "policy", connection });
  expect(sentToDocument("offscreen.halt", document)).toEqual([
    { type: "offscreen.halt", token: "obr_one" },
  ]);
  expect(sentToDocument("offscreen.stop", document).at(-1)).toEqual({
    type: "offscreen.stop",
    outcome: "failed",
    reason: "disconnected",
  });
  expect(await state()).toMatchObject({ phase: "idle", error: POLICY_MOVED });
  expect(network.running.size).toBe(0);
  expect(sentToDocument("offscreen.discard", document)).toEqual([]);
  expect(drains()).toMatchObject([
    {
      recordingId: first,
      kept: {
        waitingForReconnect: true,
        reason: "Your organization moved the Recorder to another OpenBot.",
      },
    },
    { recordingId: second, kept: { waitingForReconnect: true } },
  ]);
});

test("a Connect approved as another person stops the live recording, halts the old token's streams, keeps everything for its person, then revokes the old token", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const first = await record();
  await page({ type: "page.stop" });
  const second = await record();
  const document = doc;
  // Every sentence the popup was shown, as the state changed under it.
  const stoppedWith: (string | undefined)[] = [];
  chrome.storage.onChanged.addListener((changes, area) => {
    const recorder = changes.recorder?.newValue as RecorderState | undefined;
    if (area === "session" && recorder?.error) stoppedWith.push(recorder.error);
  });
  // OpenBot's page asks to connect this browser; this browser is connected already, so the person is asked.
  expect(
    await fake.sendExternal(
      { type: "openbot.connect", code: "obc_bea" },
      { origin },
    ),
  ).toEqual({ ok: true, awaitingConfirmation: true });
  expect(await page({ type: "page.connect.pending" })).toEqual({
    ok: true,
    pending: { origin, via: "web" },
    replaces: { origin, email: ada.email },
  });
  expect(
    await page({
      type: "page.connect.decide",
      approve: true,
      label: "Chrome",
      origin,
    }),
  ).toEqual({ ok: true });
  expect(storedConnection()).toMatchObject({ token: "obr_bea", user: bea });
  expect(sentToDocument("offscreen.halt", document)).toEqual([
    { type: "offscreen.halt", token: "obr_one" },
  ]);
  expect(sentToDocument("offscreen.stop", document).at(-1)).toEqual({
    type: "offscreen.stop",
    outcome: "failed",
    reason: "disconnected",
  });
  // The stop said why; the connect's follow-up then cleared that sentence, as any connect does, and the kept row says
  // what waits, for whom, and why.
  expect(stoppedWith).toContain(REPLACED);
  expect(await state()).toMatchObject({
    phase: "idle",
    kept: {
      recordings: 2,
      reason: "This browser was connected to another OpenBot or person.",
      waitingFor: { name: "Ada", recordings: 2 },
    },
  });
  expect((await state()).error).toBeUndefined();
  expect(network.running.size).toBe(0);
  expect(sentToDocument("offscreen.discard", document)).toEqual([]);
  expect(drains()).toMatchObject([
    {
      recordingId: first,
      userId: ada.id,
      kept: {
        waitingForReconnect: true,
        reason: "This browser was connected to another OpenBot or person.",
      },
    },
    {
      recordingId: second,
      userId: ada.id,
      kept: { waitingForReconnect: true },
    },
  ]);
  // Ada's token is revoked at her OpenBot once nothing uses it, so no live token is left that this browser lost.
  const revokes = openbot.calls.filter(
    (call) =>
      call.method === "DELETE" &&
      call.path === "/api/recorder/connections/current",
  );
  expect(revokes.map((call) => call.auth)).toEqual(["Bearer obr_one"]);
});

test("Record refuses a connection whose OpenBot the policy no longer allows, and starts nothing", async () => {
  policy = { ...policy, openbotUrl: "https://moved.example.test" };
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  const answer = await page({
    type: "page.record",
    title: "T",
    tabId: 7,
  });
  expect(answer).toEqual({
    ok: false,
    error:
      "Your organization's Recorder policy does not allow this OpenBot. Ask your IT team.",
  });
  expect(sentToDocument("offscreen.start")).toEqual([]);
  expect(active()).toBeUndefined();
  expect((await state()).phase).toBe("idle");
});

test("a policy change hands the running document its new Intelligence addresses, and the stored session too", async () => {
  await record();
  policy = { ...policy, allowedIntelligenceUrls: ["wss://gw.example.test"] };
  fake.storage.setManaged({
    AllowedIntelligenceUrls: ["wss://gw.example.test"],
  });
  await until(
    () => sentToDocument("offscreen.policy").length === 1,
    "offscreen.policy",
  );
  expect(sentToDocument("offscreen.policy")[0]).toEqual({
    type: "offscreen.policy",
    allowedIntelligenceUrls: ["wss://gw.example.test"],
  });
  expect(
    (fake.storage.session.get("stream") as StreamSession)
      .allowedIntelligenceUrls,
  ).toEqual(["wss://gw.example.test"]);
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
  // Each step names its tab, the one the recording started in.
  expect(events[1]?.value).toEqual({ i: 10, tab: 1 });
  expect(events.at(-1)?.value).toEqual({ i: 2_009, tab: 1 });
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

test("a step goes out once its save is known, carrying it; a call after the recording stopped changes nothing", async () => {
  await record();
  const clicks = () =>
    sentToDocument("offscreen.event")
      .map((m) => (m.type === "offscreen.event" ? m.event : null))
      .filter((recorded) => recorded?.name === "click");
  // Ten seconds ago on the service worker's clock: the step's window has closed.
  const at = now - 10_000;
  contentPort(7).postMessage({
    type: "content.event",
    event: {
      ...event("click", {
        step: "click",
        target: { tag: "button", role: "button", name: "Mark as read" },
      }),
      timestamp: at,
    },
  });
  network.deps?.call({
    tabId: 7,
    startedAt: at + 20,
    endedAt: at + 90,
    method: "PUT",
    url: "https://crm.example.test/api/notifications/9/read",
    exchange: {
      url: "https://crm.example.test/api/notifications/9/read",
      status: 200,
      body: { status: "empty" },
      response: { status: "complete", text: '{"ok":true}', encoding: "utf-8" },
    },
  });
  await until(() => clicks().length === 1, "the click");
  expect(clicks()[0]?.value).toMatchObject({
    step: "click",
    request: {
      method: "PUT",
      url: "https://crm.example.test/api/notifications/9/read",
      status: 200,
      body: { status: "empty" },
      response: { status: "complete", text: '{"ok":true}' },
    },
  });
  const sent = sentToDocument("offscreen.event").length;
  await page({ type: "page.stop" });
  network.deps?.call({
    tabId: 7,
    startedAt: at + 30,
    endedAt: at + 90,
    method: "GET",
    url: "https://crm.example.test/b",
  });
  await settle();
  expect(sentToDocument("offscreen.event")).toHaveLength(sent);
  // No network call is ever recorded on its own.
  expect(
    sentToDocument("offscreen.event").filter(
      (m) => m.type === "offscreen.event" && m.event.name === "network",
    ),
  ).toEqual([]);
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

test("a Record without a usable language narrates in the browser's, else English", async () => {
  fake.storage.local.set("narration", "on");
  await startRecording({
    title: "T",
    tabId: 7,
    language: "x-klingon",
  });
  const start = sentToDocument("offscreen.start")[0];
  if (start?.type !== "offscreen.start") throw new Error("No start");
  expect(start.session.voice).toEqual({
    language:
      typeof navigator !== "undefined" && navigator.language
        ? Intl.getCanonicalLocales(navigator.language)[0]
        : "en-US",
    muted: false,
  });
});

test("muting the voice tells the document, keeps the mute in the stored session, and says so in the popup at once", async () => {
  await record();
  expect(await page({ type: "page.voice", muted: true })).toEqual({ ok: true });
  expect(sentToDocument("offscreen.voice")).toEqual([
    { type: "offscreen.voice", muted: true },
  ]);
  expect(
    (fake.storage.session.get("stream") as StreamSession | undefined)?.voice,
  ).toMatchObject({ muted: true });
  expect((await state()).capture.voice).toEqual({ state: "muted" });
  expect(await page({ type: "page.voice", muted: false })).toEqual({
    ok: true,
  });
  expect(sentToDocument("offscreen.voice").at(-1)).toEqual({
    type: "offscreen.voice",
    muted: false,
  });
  expect((await state()).capture.voice).toEqual({ state: "starting" });
  await page({ type: "page.stop" });
  expect(await page({ type: "page.voice", muted: true })).toEqual({
    ok: false,
    error: "Nothing is being recorded.",
  });
  expect((await state()).capture.voice).toBeUndefined();
});

test("the document gets every sensitive-value digest, again when its port comes back, so spoken secrets are masked", async () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  await record();
  const port = contentPort(7);
  port.postMessage({ type: "content.sensitive", digest: first });
  port.postMessage({ type: "content.sensitive", digest: second });
  await until(
    () => sentToDocument("offscreen.digests").length === 2,
    "the digests reach the document",
  );
  expect(sentToDocument("offscreen.digests").at(-1)).toEqual({
    type: "offscreen.digests",
    digests: [first, second],
  });
  const back = reconnectDocument();
  back.postMessage({ type: "offscreen.ready" });
  await until(
    () => sentToDocument("offscreen.digests", back).length === 1,
    "the digests again on the new port",
  );
  expect(sentToDocument("offscreen.digests", back)[0]).toEqual({
    type: "offscreen.digests",
    digests: [first, second],
  });
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
    site: "example.test",
    narrating: false,
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
    () =>
      sentToDocument("offscreen.event").some(
        (m) =>
          m.type === "offscreen.event" &&
          (m.event.value as { from?: number }).from === 8,
      ),
    "tab 8's step is forwarded",
  );
  fake.webNavigation.createdTarget({
    sourceTabId: 99,
    tabId: 100,
    url: "https://other.example.test/",
  });
  await settle();
  expect((await state()).tabIds).toEqual([7, 8]);
});

// ---- Every tab the person uses (David, 2026-10-22) ---------------------------------------------
//
// Run 4's hosted recordings 55fe2cac and b60e9c34 held nothing after the person switched tabs: the Recorder followed
// only the tab Record started in and tabs opened from it.

const REPORT = "https://crm.example.test/reports/q3";
/** What reached the document, as events. */
const forwardedEvents = () =>
  sentToDocument("offscreen.event").flatMap((message) =>
    message.type === "offscreen.event" ? [message.event] : [],
  );
const injectedInto = (tabId: number) =>
  fake.scripting.executed.filter(
    (injection) => (injection.target as { tabId: number }).tabId === tabId,
  );

test("a tab the person switches to mid-recording is followed from then: its page is its first step, and its steps arrive", async () => {
  // Open before Record, in the same window.
  fake.tabs.set(9, {
    id: 9,
    windowId: 1,
    active: false,
    url: REPORT,
    title: "Q3 report",
  } as chrome.tabs.Tab);
  const id = await record();
  expect((await state()).tabIds).toEqual([7]);

  fake.person.switchTo(9);
  await until(async () => (await state()).tabIds.length === 2, "tab 9");
  expect(await state()).toMatchObject({
    tabIds: [7, 9],
    topUrls: { "7": DEAL, "9": REPORT },
  });
  expect((await state()).usedTabIds).toBeUndefined();
  // Captured as the Record tab is: the content script in every frame, flagged for this recording, and its network.
  await until(() => injectedInto(9).length === 2, "tab 9's content script");
  expect(injectedInto(9)[0]).toMatchObject({
    target: { tabId: 9, allFrames: true },
    args: [id],
  });
  expect(injectedInto(9)[1]).toMatchObject({
    target: { tabId: 9, allFrames: true },
    files: ["content.js"],
  });
  await until(() => network.calls.includes(`addTab 9 ${REPORT}`), "addTab");

  // Its script says hello and is told to capture; what the person does there arrives, as tab 2.
  const port = contentPort(9);
  port.postMessage({ type: "content.hello", top: true, url: REPORT });
  await until(() => port.messages.length > 0, "the answer to hello");
  expect(port.messages[0]).toEqual({
    type: "background.capture",
    active: true,
    recordingId: id,
    site: "example.test",
    narrating: false,
  });
  port.postMessage({
    type: "content.event",
    event: contentEvent({ step: "click", from: 9 }),
  });
  await until(
    () =>
      forwardedEvents().some(
        (recorded) => (recorded.value as { from?: number }).from === 9,
      ),
    "tab 9's click",
  );
  const inTab9 = forwardedEvents().filter(
    (recorded) => (recorded.value as { tab?: number }).tab === 2,
  );
  expect(inTab9.map((recorded) => recorded.name)).toEqual([
    "navigation",
    "click",
  ]);
  // The page it was on when the person switched to it is its first step, as the Record tab's is.
  expect(inTab9[0]?.value).toMatchObject({
    step: "navigate",
    from: "",
    to: REPORT,
    navigationType: "start",
    tab: 2,
    page: { url: REPORT, title: "Q3 report" },
  });
  // Moving to the tab is no action of its own; the click is.
  expect((await state()).actions).toBe(1);
  // Back to the first tab and over again: each tab keeps its number.
  fake.person.switchTo(7);
  fake.person.switchTo(9);
  await settle();
  expect((await state()).tabIds).toEqual([7, 9]);
  expect(
    forwardedEvents().filter(
      (recorded) =>
        (recorded.value as { navigationType?: string }).navigationType ===
        "start",
    ),
  ).toHaveLength(2);
});

test("a tab opened with the new-tab button is followed from its first website, whose page change is its first step", async () => {
  await record();
  const opened = fake.person.openTab();
  const tabId = opened.id as number;
  await until(
    async () => (await state()).usedTabIds?.includes(tabId) === true,
    "the new tab used",
  );
  await settle();
  // The new tab page is the browser's own: nothing of it is recorded, and the tab takes no number yet.
  fake.webNavigation.commit({
    tabId,
    frameId: 0,
    url: "chrome://new-tab-page/",
  });
  await settle();
  expect(await state()).toMatchObject({
    tabIds: [7],
    usedTabIds: [tabId],
  });
  expect(injectedInto(tabId)).toEqual([]);
  expect(network.calls.some((call) => call.includes(` ${tabId} `))).toBe(false);

  // The person types an address.
  fake.webNavigation.commit({
    tabId,
    frameId: 0,
    url: REPORT,
    transitionType: "typed",
  });
  await until(
    async () => (await state()).tabIds.includes(tabId),
    "the new tab followed",
  );
  expect((await state()).usedTabIds).toBeUndefined();
  await until(() => injectedInto(tabId).length === 2, "its content script");
  expect(injectedInto(tabId)[1]).toMatchObject({
    target: { tabId, frameIds: [0] },
    files: ["content.js"],
  });
  await until(
    () => network.calls.includes(`onCommitted ${tabId} 0 ${REPORT}`),
    "its network",
  );
  expect(network.calls).toContain(`addTab ${tabId} `);
  contentPort(tabId).postMessage({
    type: "content.event",
    event: contentEvent({ step: "click", from: tabId }),
  });
  await until(
    () =>
      forwardedEvents().some(
        (recorded) => (recorded.value as { from?: number }).from === tabId,
      ),
    "the new tab's click",
  );
  const inNewTab = forwardedEvents().filter(
    (recorded) => (recorded.value as { tab?: number }).tab === 2,
  );
  expect(inNewTab.map((recorded) => recorded.name)).toEqual([
    "navigation",
    "click",
  ]);
  expect(inNewTab[0]?.value).toMatchObject({
    step: "navigate",
    from: "",
    to: REPORT,
    navigationType: "push",
    transitionType: "typed",
    tab: 2,
  });
  // The page the person reached and the click are their actions.
  expect((await state()).actions).toBe(2);
});

test("a tab open before Record that the person never goes to is never followed, whatever it does", async () => {
  fake.tabs.set(9, {
    id: 9,
    windowId: 1,
    active: false,
    url: REPORT,
  } as chrome.tabs.Tab);
  // Another window, in front of nothing: the person never moves to it.
  fake.tabs.set(10, {
    id: 10,
    windowId: 2,
    active: true,
    url: "https://mail.example.test/inbox",
  } as chrome.tabs.Tab);
  await record();
  // The page reloads itself, changes its own address and runs its scripts.
  fake.webNavigation.commit({
    tabId: 9,
    frameId: 0,
    url: REPORT,
    transitionType: "reload",
  });
  fake.webNavigation.historyUpdate({
    tabId: 10,
    frameId: 0,
    url: "https://mail.example.test/inbox/2",
  });
  const port = contentPort(10);
  port.postMessage({ type: "content.event", event: contentEvent({}) });
  await until(() => port.messages.length > 0, "tab 10 told to stop");
  await settle();
  expect(await state()).toMatchObject({ tabIds: [7], actions: 0 });
  expect((await state()).usedTabIds).toBeUndefined();
  expect([...injectedInto(9), ...injectedInto(10)]).toEqual([]);
  expect(
    network.calls.filter((call) => /^(addTab|onCommitted) (9|10) /.test(call)),
  ).toEqual([]);
  expect(
    forwardedEvents().filter(
      (recorded) => (recorded.value as { tab?: number }).tab !== 1,
    ),
  ).toEqual([]);
});

test("a tab in another window is followed once the person brings that window to the front", async () => {
  fake.tabs.set(10, {
    id: 10,
    windowId: 2,
    active: true,
    url: "https://mail.example.test/inbox",
  } as chrome.tabs.Tab);
  fake.tabs.set(11, {
    id: 11,
    windowId: 2,
    active: false,
    url: REPORT,
  } as chrome.tabs.Tab);
  await record();
  // Focus leaving the browser is no tab.
  fake.person.focusWindow(chrome.windows.WINDOW_ID_NONE);
  await settle();
  expect((await state()).tabIds).toEqual([7]);
  fake.person.focusWindow(2);
  await until(async () => (await state()).tabIds.length === 2, "tab 10");
  expect((await state()).tabIds).toEqual([7, 10]);
  expect(network.calls).toContain("addTab 10 https://mail.example.test/inbox");
  // Its window's other tab, never shown, is not followed.
  expect((await state()).tabIds).not.toContain(11);
});

test("a tab on one of the Recorder's own pages or the Web Store is not followed until it reaches a website", async () => {
  fake.tabs.set(9, {
    id: 9,
    windowId: 1,
    active: false,
    url: `chrome-extension://${EXTENSION_ID}/options.html`,
  } as chrome.tabs.Tab);
  fake.tabs.set(10, {
    id: 10,
    windowId: 1,
    active: false,
    url: "https://chromewebstore.google.com/detail/x",
  } as chrome.tabs.Tab);
  await record();
  fake.person.switchTo(9);
  fake.person.switchTo(10);
  await until(
    async () => (await state()).usedTabIds?.length === 2,
    "both used",
  );
  await settle();
  expect((await state()).tabIds).toEqual([7]);
  expect([...injectedInto(9), ...injectedInto(10)]).toEqual([]);
  // From its options page the person goes to a website: the tab joins there.
  fake.webNavigation.commit({ tabId: 9, frameId: 0, url: REPORT });
  await until(async () => (await state()).tabIds.length === 2, "tab 9");
  expect(await state()).toMatchObject({ tabIds: [7, 9], usedTabIds: [10] });
});

test("a tab the Record tab opens is followed as before, from the opener's page, though Chrome says it is active before it says who opened it", async () => {
  // Measured on Chromium 151: a link with target=_blank fires tabs.onCreated and tabs.onActivated for the new tab, then
  // webNavigation.onCreatedNavigationTarget, then the new tab's commit.
  await record();
  const opened = fake.person.openTab();
  const tabId = opened.id as number;
  fake.webNavigation.createdTarget({ sourceTabId: 7, tabId, url: REPORT });
  await until(async () => (await state()).tabIds.length === 2, "followed");
  fake.tabs.set(tabId, { ...opened, url: REPORT });
  fake.webNavigation.commit({ tabId, frameId: 0, url: REPORT });
  // The person goes back to the tab that opened it: the page they looked at there is a visit that is over, and goes out.
  fake.person.switchTo(7);
  await until(
    () =>
      forwardedEvents().some(
        (recorded) => (recorded.value as { tab?: number }).tab === 2,
      ),
    "its page change",
  );
  await settle();
  expect(await state()).toMatchObject({ tabIds: [7, tabId] });
  expect((await state()).usedTabIds).toBeUndefined();
  expect(network.calls).toContain(`addTab ${tabId} ${REPORT}`);
  // Its first step is the page change from the page that opened it, never a start of its own.
  expect(
    forwardedEvents()
      .filter((recorded) => (recorded.value as { tab?: number }).tab === 2)
      .map((recorded) => recorded.value),
  ).toEqual([
    expect.objectContaining({
      step: "navigate",
      from: DEAL,
      to: REPORT,
      navigationType: "push",
    }),
  ]);
});

test("a tab the person used stays waiting for its first website through a service-worker restart", async () => {
  await record();
  const opened = fake.person.openTab();
  const tabId = opened.id as number;
  await until(
    async () => (await state()).usedTabIds?.includes(tabId) === true,
    "the new tab used",
  );
  fake.restartServiceWorker();
  handlers = installRecording(doubles());
  installRouter(handlers);
  fake.webNavigation.commit({ tabId, frameId: 0, url: REPORT });
  await until(async () => (await state()).tabIds.includes(tabId), "followed");
  expect((await state()).usedTabIds).toBeUndefined();
});

test("nothing is followed while nothing records, and a recording that stopped forgets the tabs it waited for", async () => {
  fake.person.openTab();
  await settle();
  expect((await state()).usedTabIds).toBeUndefined();
  await record();
  const opened = fake.person.openTab();
  await until(
    async () => (await state()).usedTabIds?.length === 1,
    "the new tab used",
  );
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  expect((await state()).usedTabIds).toBeUndefined();
  fake.webNavigation.commit({
    tabId: opened.id as number,
    frameId: 0,
    url: REPORT,
  });
  await settle();
  expect(await state()).toMatchObject({ phase: "idle", tabIds: [] });
});

test("a tab the recorded tab opened begins at the opener's page, and every step and page change names its tab", async () => {
  // The final run's run 1 (trajectory 764dddf8): on /support the person opened the account in a new tab, saved the memo
  // there, then went Home in the first tab. The new tab's first page change read from=/account to=/account, and nothing
  // but the address told the two tabs' steps apart.
  const { rows } = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "e2e-new-tab.json"), "utf8"),
  ) as { rows: (CapturedEvent & { row: string })[] };
  const SHOP = "http://127.0.0.1:7420";
  /** The rows the person made in the new tab: its first page change, the memo and its save. */
  const inNewTab = new Set(["68105", "68107", "68108", "68109"]);
  fake.tabs.set(7, {
    id: 7,
    url: `${SHOP}/address`,
    title: "Delivery address - Corner Shop admin",
  } as chrome.tabs.Tab);
  await record();
  const ports = new Map<number, FakePort>([[7, contentPort(7)]]);
  for (const { row, ...step } of rows) {
    const tabId = inNewTab.has(row) ? 8 : 7;
    if (step.name === "navigation") {
      const value = step.value as { to: string; transitionType: string };
      fake.webNavigation.commit({
        tabId,
        frameId: 0,
        url: value.to,
        transitionType:
          value.transitionType as chrome.webNavigation.WebNavigationTransitionCallbackDetails["transitionType"],
        timeStamp: step.timestamp,
      });
    } else {
      let port = ports.get(tabId);
      if (!port) {
        port = contentPort(tabId);
        ports.set(tabId, port);
      }
      port.postMessage({ type: "content.event", event: step });
    }
    await settle();
    if (row === "68104") {
      // The link's target="_blank": Chrome opens tab 8 from tab 7's top frame.
      fake.tabs.set(8, {
        id: 8,
        url: `${SHOP}/account`,
        title: "Account - Corner Shop admin",
      } as chrome.tabs.Tab);
      fake.webNavigation.createdTarget({
        sourceTabId: 7,
        tabId: 8,
        url: `${SHOP}/account`,
      });
      await until(async () => (await state()).tabIds.length === 2, "tab 8");
    }
  }
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  const sent = sentToDocument("offscreen.event").flatMap((message) =>
    message.type === "offscreen.event" ? [message.event] : [],
  );

  const changes = sent
    .filter((recorded) => recorded.name === "navigation")
    .map((recorded) => {
      const { from, to, tab } = recorded.value as Record<string, unknown>;
      return { from, to, tab };
    });
  expect(changes).toEqual([
    { from: "", to: `${SHOP}/address`, tab: 1 },
    { from: `${SHOP}/address`, to: `${SHOP}/support`, tab: 1 },
    // Row ...68105: the new tab begins at the page it was opened from.
    { from: `${SHOP}/support`, to: `${SHOP}/account`, tab: 2 },
    { from: `${SHOP}/support`, to: `${SHOP}/`, tab: 1 },
  ]);
  const steps = sent.filter((recorded) => recorded.name !== "navigation");
  const posted = rows.filter((row) => row.name !== "navigation");
  expect(
    steps.map((recorded) => [
      recorded.timestamp,
      (recorded.value as { tab?: number }).tab,
    ]),
  ).toEqual(
    posted.map((row) => [row.timestamp, inNewTab.has(row.row) ? 2 : 1]),
  );
  // CopilotKit's own fields are as the page sent them: the tab is the Recorder's own field beside them.
  steps.forEach((recorded, index) => {
    const { tab: _tab, ...own } = recorded.value as Record<string, unknown>;
    expect(own).toEqual(posted[index]?.value as Record<string, unknown>);
  });
});

test("only a followed tab's top frame becomes a page-change step, once per address, with masked addresses", async () => {
  await record();
  const navigations = () =>
    sentToDocument("offscreen.event")
      .map((m) => (m.type === "offscreen.event" ? m.event : null))
      .filter((recorded) => recorded?.name === "navigation");
  // The page the recording started on, again: already where the tab is.
  fake.webNavigation.historyUpdate({ tabId: 7, frameId: 0, url: DEAL });
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/deals/43?tab=notes&token=abc",
    transitionType: "link",
  });
  // An iframe loading, and an iframe's own history: the page's doing, never recorded.
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 2,
    parentFrameId: 0,
    url: "https://widgets.example.test/a?token=abc",
  });
  fake.webNavigation.historyUpdate({
    tabId: 7,
    frameId: 2,
    url: "https://widgets.example.test/b",
  });
  // The page rewriting its own address to the same one, as a single-page app does again and again.
  for (let i = 0; i < 3; i++)
    fake.webNavigation.historyUpdate({
      tabId: 7,
      frameId: 0,
      url: "https://crm.example.test/deals/43?tab=notes&token=abc",
    });
  fake.webNavigation.historyUpdate({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/deals/44",
  });
  // A reload of the same address is the person's, and recorded; a blank document is no page they reached.
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/deals/44",
    transitionType: "reload",
  });
  fake.webNavigation.commit({ tabId: 7, frameId: 0, url: "about:blank" });
  // The person moves to a new tab: the pages they visited in this one, with no step there, go out.
  fake.person.openTab();
  await until(() => navigations().length === 3, "three page changes");
  await settle();
  const events = navigations();
  expect(events).toHaveLength(3);
  // The page the recording started on is its first step.
  expect(events[0]).toMatchObject({
    name: "navigation",
    value: { step: "navigate", from: "", to: DEAL, navigationType: "start" },
  });
  // The page's own change of address right after the link is one step with it: from where it began to where it ended.
  expect(events[1]).toMatchObject({
    name: "navigation",
    value: {
      step: "navigate",
      from: DEAL,
      to: "https://crm.example.test/deals/44",
      navigationType: "push",
      frameId: 0,
    },
  });
  expect(events[2]).toMatchObject({
    value: {
      from: "https://crm.example.test/deals/44",
      to: "https://crm.example.test/deals/44",
      navigationType: "reload",
    },
  });
  expect(JSON.stringify(events)).not.toContain("widgets.example.test");
  expect((await state()).topUrls["7"]).toBe("about:blank");
  expect(callsBeyondActivity()).toEqual([]);
});

test("an address recorded before is recorded again in the next recording and after Start over", async () => {
  const visits = (url: string) =>
    sentToDocument("offscreen.event").filter(
      (m) =>
        m.type === "offscreen.event" &&
        m.event.name === "navigation" &&
        (m.event.value as { to?: string }).to === url,
    ).length;
  const navigateTo = async (url: string) => {
    const before = visits(url);
    fake.webNavigation.commit({ tabId: 7, frameId: 0, url });
    // The person moves to another tab, so the page they visited goes out.
    fake.person.openTab();
    await until(() => visits(url) === before + 1, `the navigation to ${url}`);
  };
  await record();
  await navigateTo("https://crm.example.test/deals/43");
  await page({ type: "page.stop" });
  await record();
  await navigateTo("https://crm.example.test/deals/43");
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  await navigateTo("https://crm.example.test/deals/43");
  expect(visits("https://crm.example.test/deals/43")).toBe(3);
  // Each page change waits STEP_TIMING.redirectMs for a redirect before it is sent.
}, 15_000);

test("the collector's page event is never recorded: the tab's start and its page changes are the steps, with the tab's page", async () => {
  fake.tabs.set(7, { id: 7, url: DEAL, title: "Deal 42" } as chrome.tabs.Tab);
  await record();
  contentPort(7, 0).postMessage({
    type: "content.event",
    event: event("page", { url: DEAL, route: "/deals/42", title: "Deal 42" }),
  });
  // The person moves to another tab: the page the recording started on, which they did not act on, goes out.
  fake.person.openTab();
  const forwarded = () =>
    sentToDocument("offscreen.event").map((m) =>
      m.type === "offscreen.event" ? m.event : null,
    );
  await until(() => forwarded().length === 1, "the start step");
  await settle();
  expect(forwarded().map((recorded) => recorded?.name)).toEqual(["navigation"]);
  expect(forwarded()[0]?.value).toMatchObject({
    step: "navigate",
    to: DEAL,
    navigationType: "start",
    page: { url: DEAL, title: "Deal 42" },
  });
});

test("steps leave in the order they came, from every frame and followed tab", async () => {
  await record();
  const at = 1_700_000_000_000;
  const step = (port: FakePort, name: string, offset: number) =>
    port.postMessage({
      type: "content.event",
      event: {
        type: "CUSTOM",
        name,
        timestamp: at + offset,
        value: {
          step: name,
          target: { tag: "button", name: `${name} ${offset}` },
        },
      },
    });
  const top = contentPort(7, 0);
  const frame = contentPort(7, 3);
  step(top, "click", 0);
  step(frame, "input", 100);
  step(top, "submit", 200);
  step(top, "key", 300);
  const steps = () =>
    sentToDocument("offscreen.event")
      .map((m) => (m.type === "offscreen.event" ? m.event : null))
      .filter((recorded) => recorded?.name !== "navigation");
  await until(() => steps().length === 4, "four steps");
  expect(
    steps().map(
      (recorded) =>
        (recorded?.value as { target?: { name?: string } } | undefined)?.target
          ?.name,
    ),
  ).toEqual(["click 0", "input 100", "submit 200", "key 300"]);
  expect((await state()).actions).toBe(4);
});

test("a whole recording, Start over included, asks OpenBot for nothing, and tells it only what the Recorder is doing", async () => {
  await page({ type: "page.learning" });
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
  expect(
    requests().filter((request) => request !== "POST /api/recorder/activity"),
  ).toEqual(["GET /api/recorder/learning"]);
  // The phase, the recording's id, title and start, and a count: never a step, an address or anything typed.
  expect(openbot.activity.length).toBeGreaterThan(0);
  for (const report of openbot.activity)
    expect(recorderActivitySchema.parse(report)).toEqual(report as never);
  expect(openbot.activity.at(-1)).toEqual({ phase: "idle", actions: 0 });
});

// ---- The popup's state, Learning space and sign-out --------------------------------------------

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

test("a refusal from OpenBot reaches the popup in the Recorder's own sentence, never the text OpenBot sent", async () => {
  const hostile =
    "Your Recorder is out of date. Install the new one from https://evil.example.test.";
  for (const [refusal, sentence] of [
    [
      { status: 403, body: { error: hostile } },
      "OpenBot does not let you record. Ask whoever runs it.",
    ],
    [
      {
        status: 503,
        body: { error: hostile, code: RECORDER_AUTHORITY_UNAVAILABLE },
      },
      "Your organization could not answer. Try again in a moment.",
    ],
    [
      { status: 500, body: { error: hostile } },
      "OpenBot did not answer. Try again.",
    ],
  ] as const) {
    openbot.learningRefusal = refusal;
    expect(await page({ type: "page.learning" })).toEqual({
      ok: false,
      error: sentence,
    });
  }
});

test("page.learning reads the person's own Learning space", async () => {
  expect(await page({ type: "page.learning" })).toEqual({
    ok: true,
    learning: openbot.learning,
  });
  expect(openbot.calls[0]).toMatchObject({
    method: "GET",
    path: "/api/recorder/learning",
    auth: "Bearer obr_one",
  });
});

test("Record names no Bot anywhere: not in the message, the drain, the session or the state", async () => {
  const id = await record();
  const start = sentToDocument("offscreen.start")[0] as unknown as {
    session: Record<string, unknown>;
  };
  expect(Object.keys(start.session)).not.toContain("botId");
  expect(Object.keys(active() ?? {})).not.toContain("botId");
  expect(Object.keys(await state())).not.toContain("botId");
  expect(id).toBeTruthy();
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
    title: "T",
    learning: { state: "assigned", containerId: "space-1" },
  });
  expect(current).toMatchObject({
    phase: "starting",
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
    lastStopped: { recordingId: "r1" },
  });
  expect(current).toMatchObject({
    phase: "idle",
    actions: 0,
    tabIds: [],
    lastStopped: { recordingId: "r1" },
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

test("each recording has its own agent events: every AG-UI observation, every click before the steps hold it, each top-frame document, and its end; what they emit goes out among the steps by its time", async () => {
  await record();
  expect(agents).toHaveLength(1);
  const [agent] = agents;
  if (!agent) throw new Error("no agent events");
  const observation: AgentObservation = {
    kind: "event",
    tabId: 7,
    streamId: "7//1",
    at: now,
    agentId: "default",
    threadId: "t-1",
    event: { type: "RUN_STARTED", threadId: "t-1", runId: "r-1" },
  };
  network.deps?.agent(observation);
  expect(agent.observed).toEqual([observation]);

  const clicked = now - 10_000;
  agent.enrich = true;
  contentPort(7).postMessage({
    type: "content.event",
    event: {
      ...event("click", {
        step: "click",
        target: { tag: "button", role: "button", name: "Send" },
      }),
      timestamp: clicked,
    },
  });
  await until(() => agent.clicks.length === 1, "the click");
  expect(agent.clicks[0]?.tabId).toBe(7);
  // An agent event from just after the click, emitted while the click is still held: it goes out after it.
  agent.emit(7, event("agent.message", { text: "Looking it up" }));
  agent.emit(7, {
    ...event("agent.run", { phase: "started" }),
    timestamp: clicked + 5,
  });
  const out = () =>
    sentToDocument("offscreen.event").flatMap((m) =>
      m.type === "offscreen.event" ? [m.event] : [],
    );
  // The tab's first page change waits for its title (the steps' own timer), then everything held goes out in order.
  await until(
    () => out().some(({ name }) => name === "agent.run"),
    "the held events",
  );
  const names = out().map(({ name }) => name);
  // The click went out as the agent events enriched it.
  expect(out()[names.indexOf("click")]?.value).toMatchObject({
    step: "click",
    agent: { threadId: "t-1" },
  });
  expect(names.indexOf("agent.run")).toBeGreaterThan(names.indexOf("click"));
  // One stamped long before the click (1_700_000_000_000) left before it.
  expect(names.indexOf("agent.message")).toBeLessThan(names.indexOf("click"));

  fake.webNavigation.commit({
    tabId: 7,
    frameId: 3,
    parentFrameId: 0,
    url: "https://widgets.example.test/",
  });
  fake.webNavigation.historyUpdate({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/deals/43",
  });
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/next",
    transitionType: "link",
  });
  await until(() => agent.navigated.length === 1, "the new document");
  await settle();
  expect(agent.navigated).toEqual([7]);

  await page({ type: "page.stop" });
  expect(agent.stopped).toBe(true);
  network.deps?.agent(observation);
  expect(agent.observed).toHaveLength(1);
  await record();
  expect(agents).toHaveLength(2);
  expect(agents[1]?.stopped).toBe(false);
});

test("a click leaves the steps as the agent events settle it, with the join of the runs it started: a run 20 ms after it is its own, and one 2 s after it while the person did nothing else, but not one 5 s after it", async () => {
  await record();
  const [agent] = agents;
  if (!agent) throw new Error("no agent events");
  agent.settleTo = "t-2";
  const clicked = now - 10_000;
  contentPort(7).postMessage({
    type: "content.event",
    event: {
      ...event("click", {
        step: "click",
        target: { tag: "button", role: "button", name: "Send" },
      }),
      timestamp: clicked,
    },
  });
  await until(() => agent.settled.length === 1, "the click leaving");
  expect(agent.settled[0]).toMatchObject({
    tabId: 7,
    soon: true,
    late: true,
    past: false,
  });
  const out = () =>
    sentToDocument("offscreen.event").flatMap((m) =>
      m.type === "offscreen.event" ? [m.event] : [],
    );
  await until(
    () => out().some(({ name }) => name === "click"),
    "the click going out",
  );
  expect(out().find(({ name }) => name === "click")?.value).toMatchObject({
    step: "click",
    threadId: "t-2",
  });
});

test("an AG-UI observation from the page hook is accepted only from a recorded tab while page capture is on, whole however large, with its tab and a stream id of that tab and frame", async () => {
  await record();
  const observation = {
    kind: "request",
    streamId: "k3x9/0",
    at: now,
    url: "https://crm.example.test/api/copilotkit",
    agentId: "default",
    method: "agent/run",
    // A long Thread: far past the 64 KiB a page-network event may be.
    input: {
      threadId: "t-1",
      messages: [{ id: "m", role: "user", content: "x".repeat(200_000) }],
    },
  };
  const fromTab = (
    tabId: number,
    message: object = { type: "recorder.page-agent", observation },
  ) =>
    fake.sendExternal(message, {
      tab: { id: tabId } as chrome.tabs.Tab,
      frameId: 4,
      url: DEAL,
      origin: "https://crm.example.test",
    });
  expect(await fromTab(7)).toEqual({ ok: false, error: "not-recording" }); // the debugger is capturing
  network.deps?.status("page");
  expect(await fromTab(7)).toEqual({ ok: true });
  expect(network.pageAgent).toEqual([
    {
      ...observation,
      tabId: 7,
      streamId: "7/page/4/k3x9/0",
    } as AgentObservation,
  ]);
  expect(await fromTab(99)).toEqual({ ok: false, error: "not-recording" });
  expect(
    await fromTab(7, {
      type: "recorder.page-agent",
      observation: {
        kind: "event",
        streamId: "k3x9/0",
        at: now,
        agentId: null,
        threadId: null,
        event: { delta: "no type" },
      },
    }),
  ).toEqual({ ok: false, error: "invalid" });
  expect(network.pageAgent).toHaveLength(1);
});

test("the page hook's word that the page runs CopilotKit (its runtime answered the info call) reaches the capture with its tab, and nothing else rides on it", async () => {
  await record();
  network.deps?.status("page");
  const runtime = {
    kind: "runtime" as const,
    at: now,
    url: "http://127.0.0.1:7620/api/copilotkit-learning",
  };
  const fromTab = (observation: object) =>
    fake.sendExternal(
      { type: "recorder.page-agent", observation },
      {
        tab: { id: 7 } as chrome.tabs.Tab,
        frameId: 0,
        url: DEAL,
        origin: "https://crm.example.test",
      },
    );
  expect(await fromTab(runtime)).toEqual({ ok: true });
  expect(network.pageAgent).toEqual([{ ...runtime, tabId: 7 }]);
  expect(await fromTab({ ...runtime, streamId: "k3x9/0" })).toEqual({
    ok: false,
    error: "invalid",
  });
  expect(network.pageAgent).toHaveLength(1);
});

// ---- Sites the person leaves out: a recording follows every tab the person uses ----------------
//
// A glance at a bank or a mailbox mid-recording went into it: every followed tab now shows a recording mark from its
// first step, and one click on it leaves that site out of every recording.

test("one click on a tab's recording mark leaves its site out: what it still held is dropped, and nothing more of it is recorded", async () => {
  const id = await record();
  const port = contentPort(7);
  port.postMessage({ type: "content.hello", top: true, url: DEAL });
  await until(() => captureMessages(port).length > 0, "the mark");
  // The mark from the tab's first step: its site, and that the Recorder does not hear the person.
  expect(captureMessages(port).at(-1)).toEqual({
    type: "background.capture",
    active: true,
    recordingId: id,
    site: "example.test",
    narrating: false,
  });
  // A click the steps still hold when the person presses Don't record example.test on the mark.
  port.postMessage({
    type: "content.event",
    event: contentEvent({ step: "click", from: 7 }),
  });
  await until(async () => (await state()).actions === 1, "the click");
  port.postMessage({ type: "content.site", recorded: false });
  await until(
    () => fake.storage.local.get("excludedSites") !== undefined,
    "the site is kept out",
  );
  expect(fake.storage.local.get("excludedSites")).toEqual(["example.test"]);
  // The tab stops capturing, and its mark says it is not recording the site.
  expect(captureMessages(port).at(-1)).toEqual({
    type: "background.capture",
    active: false,
    site: "example.test",
    narrating: false,
    excluded: true,
  });
  // Its Threads go with it, so nothing of the page's AG-UI is linked to later.
  expect(agents.at(-1)?.navigated).toContain(7);

  // Anything more from the tab is dropped: a step from a script that had not heard yet, a save, the page's AG-UI.
  port.postMessage({
    type: "content.event",
    event: contentEvent({ step: "click", from: 7 }),
  });
  network.deps?.call({
    tabId: 7,
    startedAt: now,
    endedAt: now,
    method: "POST",
    url: "https://crm.example.test/api/deals/42",
  });
  network.deps?.agent({
    kind: "runtime",
    tabId: 7,
    at: now,
    url: "https://crm.example.test/api/copilotkit/info",
  } as never);
  await settle();
  expect(agents.at(-1)?.observed).toEqual([]);
  // A page on the site is not one the network capture attaches to.
  expect(network.deps?.recordable?.(DEAL)).toBe(false);
  expect(network.deps?.recordable?.("https://other.test/")).toBe(true);

  await page({ type: "page.stop" });
  await until(async () => (await state()).phase !== "recording", "stopped");
  // Stop sends everything the steps held: none of it is the tab's start or its clicks.
  expect(
    forwardedEvents().filter(
      (recorded) => recorded.name === "click" || recorded.name === "navigation",
    ),
  ).toEqual([]);
});

test("a site left out stays out of later recordings, and one click on the mark records it again", async () => {
  // Left out in an earlier recording; a later service worker reads the list.
  fake.storage.local.set("excludedSites", ["example.test"]);
  fake.restartServiceWorker();
  handlers = installRecording(doubles());
  installRouter(handlers);
  const id = await record();
  // The tab's script is injected without the flag that starts capture at once: on this site it only shows the mark.
  expect(injectedInto(7).map((injection) => injection.files ?? "flag")).toEqual(
    [["content.js"]],
  );
  const port = contentPort(7);
  port.postMessage({ type: "content.hello", top: true, url: DEAL });
  await until(() => captureMessages(port).length > 0, "the mark");
  expect(captureMessages(port).at(-1)).toMatchObject({
    active: false,
    site: "example.test",
    excluded: true,
  });
  port.postMessage({
    type: "content.event",
    event: contentEvent({ step: "click", from: 7 }),
  });
  await settle();
  expect((await state()).actions).toBe(0);
  expect(
    (await page({ type: "page.state" })) as { excludedSites?: string[] },
  ).toMatchObject({ excludedSites: ["example.test"] });

  // Record it: the tab captures again, and its network capture attaches now rather than at its next page.
  port.postMessage({ type: "content.site", recorded: true });
  await until(
    () => fake.storage.local.get("excludedSites") === undefined,
    "recorded again",
  );
  expect(captureMessages(port).at(-1)).toEqual({
    type: "background.capture",
    active: true,
    recordingId: id,
    site: "example.test",
    narrating: false,
  });
  expect(network.calls).toContain(`onCommitted 7 0 ${DEAL}`);
  port.postMessage({
    type: "content.event",
    event: contentEvent({ step: "click", from: 7 }),
  });
  await until(async () => (await state()).actions === 1, "the click");
  await page({ type: "page.stop" });
  await until(
    () => forwardedEvents().some((recorded) => recorded.name === "click"),
    "the click is sent",
  );
  // The tab's start was on a site left out, so it is no step; the click after the person recorded it again is.
  expect(
    forwardedEvents()
      .filter((recorded) => (recorded.value as { tab?: number }).tab === 1)
      .map((recorded) => recorded.name),
  ).toEqual(["click"]);
});

test("the options page leaves a site out or records it again; a page that is not a website is refused", async () => {
  expect(
    await page({ type: "page.site", site: "bank.example", recorded: false }),
  ).toEqual({ ok: true });
  expect(
    await page({ type: "page.site", site: "mail.example", recorded: false }),
  ).toEqual({ ok: true });
  expect(fake.storage.local.get("excludedSites")).toEqual([
    "bank.example",
    "mail.example",
  ]);
  expect(
    await page({ type: "page.site", site: "bank.example", recorded: true }),
  ).toEqual({ ok: true });
  expect(fake.storage.local.get("excludedSites")).toEqual(["mail.example"]);
  for (const site of ["", "chrome://settings", "mail.example/inbox", 42])
    expect(
      await page({ type: "page.site", site, recorded: false }),
    ).toMatchObject({ ok: false });
  expect(fake.storage.local.get("excludedSites")).toEqual(["mail.example"]);
});
