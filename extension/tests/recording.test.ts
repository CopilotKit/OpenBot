import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import {
  type LearningSpaceState,
  RECORDER_OPEN_RECORDING,
  RECORDER_SIGNED_OUT,
  type RecorderBot,
} from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
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
import { createStepUploader } from "../src/background/steps";
import {
  type BackgroundToOffscreen,
  IDLE_STATE,
  type PageResponse,
  type PageStateResponse,
  PORT_CONTENT,
  PORT_OFFSCREEN,
  type RecorderState,
} from "../src/protocol/messages";
import {
  openRecorderDatabase,
  requestToPromise,
  STORES,
} from "../src/shared/database";
import { isRecordablePage } from "../src/shared/origin";
import type { RecorderPolicy } from "../src/shared/policy";
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
const SIGNED_OUT =
  "This browser was disconnected from OpenBot. Your recording stopped, and everything in it is kept in this browser until you connect again.";
const ORGANIZATION_SIGNED_OUT =
  "Your organization sign-in ended. Your recording stopped, and everything in it is kept in this browser until you connect again.";
const STOPPED_IN_OPENBOT =
  "This recording was stopped in OpenBot. Everything until then was saved.";
const STOP_PENDING =
  "Stopping: OpenBot did not answer yet. Your steps are kept in this browser and sent when it does.";

const click = (name = "Save", url = DEAL): DemonstrationAction => ({
  kind: "click",
  url,
  target: { role: "button", name, sensitive: false },
});
const networkStep: DemonstrationAction = {
  kind: "network",
  url: "https://crm.example.test/api/deals",
  method: "POST",
  status: 200,
};
const contentEvent = (value: unknown): CapturedEvent => ({
  type: "CUSTOM",
  name: "click",
  timestamp: 1_700_000_000_000,
  value: value as CapturedEvent["value"],
});

// ---- The fake OpenBot -------------------------------------------------------------------------

type Batch = { fromIndex: number; actions: DemonstrationAction[] };
type Call = {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
};
type Answer = { status: number; body: object };

const demonstration = (
  id: string,
  learning: LearningSpaceState | null = null,
) => ({
  id,
  botId: "bot-1",
  title: "T",
  source: "extension",
  status: "recording",
  actionCount: 0,
  learning,
});

const openbot = {
  calls: [] as Call[],
  batches: [] as Batch[],
  held: new Map<string, number>(),
  nextDemo: 0,
  createAnswers: [] as Answer[],
  trajectoryStatus: 204,
  failActions: 0,
  refuseActions: false,
  signedOutActions: null as null | "revoked" | "removed" | "organization",
  down: false,
  stopLearning: null as LearningSpaceState | null,
  open: (_botId: string | null): object => ({ demonstration: null }),
  openSignedOut: null as null | "revoked" | "removed" | "organization",
  /** Recordings told to stop: OpenBot refuses their steps from then on, as the real one does. */
  stopped: new Set<string>(),
  /** While set, the create and open-recording answers wait for it. */
  holdCreate: null as Promise<void> | null,
  holdOpen: null as Promise<void> | null,
  me: { status: 200, body: {} as object } as Answer,
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
  capabilities: { transcription: true },
};

function resetOpenBot() {
  openbot.calls = [];
  openbot.batches = [];
  openbot.held = new Map();
  openbot.nextDemo = 0;
  openbot.createAnswers = [];
  openbot.trajectoryStatus = 204;
  openbot.failActions = 0;
  openbot.refuseActions = false;
  openbot.signedOutActions = null;
  openbot.down = false;
  openbot.stopLearning = null;
  openbot.open = () => ({ demonstration: null });
  openbot.openSignedOut = null;
  openbot.stopped = new Set();
  openbot.holdCreate = null;
  openbot.holdOpen = null;
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
      const text = await request.text();
      const body: unknown = text ? JSON.parse(text) : undefined;
      openbot.calls.push({
        method: request.method,
        path: url.pathname + url.search,
        auth: request.headers.get("authorization"),
        body,
      });
      if (openbot.down)
        return Response.json(
          { error: "OpenBot is restarting." },
          { status: 503 },
        );
      const { method } = request;
      const path = url.pathname;
      if (method === "GET" && path === "/api/recorder/me")
        return Response.json(openbot.me.body, { status: openbot.me.status });
      if (method === "GET" && path === "/api/recorder/bots")
        return Response.json({ bots: openbot.bots });
      if (method === "DELETE" && path === "/api/recorder/connections/current")
        return new Response(null, { status: 204 });
      if (method === "POST" && path === "/api/recorder/demonstrations") {
        if (openbot.holdCreate) await openbot.holdCreate;
        const answer = openbot.createAnswers.shift();
        if (answer)
          return Response.json(answer.body, { status: answer.status });
        const id = `demo-${++openbot.nextDemo}`;
        return Response.json(
          { demonstration: demonstration(id) },
          { status: 201 },
        );
      }
      if (method === "GET" && path === "/api/recorder/demonstrations/open") {
        if (openbot.holdOpen) await openbot.holdOpen;
        return openbot.openSignedOut
          ? Response.json(
              {
                error: "Connect this browser again.",
                code: RECORDER_SIGNED_OUT,
                reason: openbot.openSignedOut,
              },
              { status: 401 },
            )
          : Response.json(openbot.open(url.searchParams.get("botId")));
      }
      const match =
        /^\/api\/recorder\/demonstrations\/([^/]+)(\/[a-z]+)?$/.exec(path);
      if (!match) return new Response("nope", { status: 404 });
      const id = decodeURIComponent(match[1] as string);
      const rest = match[2];
      if (method === "DELETE" && rest === undefined)
        return new Response(null, { status: 204 });
      if (method === "POST" && rest === "/trajectories")
        return openbot.trajectoryStatus < 400
          ? new Response(null, { status: openbot.trajectoryStatus })
          : Response.json(
              { error: "Could not register the trajectory." },
              { status: openbot.trajectoryStatus },
            );
      if (method === "POST" && rest === "/stop") {
        openbot.stopped.add(id);
        return Response.json({
          demonstration: demonstration(id, openbot.stopLearning),
        });
      }
      if (method === "POST" && rest === "/actions") {
        if (openbot.failActions > 0) {
          openbot.failActions -= 1;
          return Response.json({ error: "Busy." }, { status: 503 });
        }
        if (openbot.signedOutActions)
          return Response.json(
            {
              error: "Connect this browser again.",
              code: RECORDER_SIGNED_OUT,
              reason: openbot.signedOutActions,
            },
            { status: 401 },
          );
        if (openbot.refuseActions || openbot.stopped.has(id))
          return Response.json(
            { error: "This recording is not open." },
            { status: 400 },
          );
        const batch = body as Batch;
        const held = openbot.held.get(id) ?? 0;
        if (batch.fromIndex !== held)
          return Response.json({ error: "Gap.", count: held }, { status: 409 });
        openbot.batches.push(batch);
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
/** The trajectory id a request registered (its JSON body's `trajectoryId`). */
const registered = (index: number) =>
  (openbot.calls[index]?.body as { trajectoryId?: string } | undefined)
    ?.trajectoryId;
const demoPath = (id: string, rest = "") =>
  `/api/recorder/demonstrations/${id}${rest}`;

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
/** A promise the test opens on cue, to hold one of the fake OpenBot's answers. */
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
type Indexed = { indexedDB?: IDBFactory; IDBKeyRange?: typeof FakeIDBKeyRange };
const indexedGlobals = globalThis as unknown as Indexed;
let savedIndexed: Indexed = {};
let dbCounter = 0;
let dbName = "";

/** The offscreen document: it connects and says ready once Chrome created it, and answers offscreen.stop on its own
 * unless `holdStop` is set. The test posts everything else on cue. */
let doc: FakePort | null = null;
let docSeen = 0;
let docDemo = "";
let holdStop = false;
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
      docDemo = message.session.demonstrationId;
    if (message.type === "offscreen.rotate") docDemo = message.demonstrationId;
    if (message.type === "offscreen.stop" && !holdStop)
      doc.postMessage({
        type: "offscreen.stopped",
        demonstrationId: docDemo,
        trajectoryIds: [],
      });
  }
}
const toDocument = (port: FakePort | null = doc) =>
  (port?.messages ?? []) as BackgroundToOffscreen[];
const sentToDocument = (type: string, port: FakePort | null = doc) =>
  toDocument(port).filter((message) => message.type === type);

type NetworkDouble = {
  deps?: NetworkCaptureDeps;
  options?: { fallback?: PageFallback };
  calls: string[];
  recorded: CapturedEvent[];
  failStart: boolean;
};
let network: NetworkDouble;
let fallback: { value: PageFallback; calls: string[]; created: number };
let acceptAnswer: ReturnType<RecordingDeps["acceptPageNetworkEvent"]> = null;
let accepted: { event: CapturedEvent; digests: string[] }[] = [];
let policy: RecorderPolicy;
let hostAccess = true;
let uploader: ReturnType<typeof createStepUploader>;
let handlers: ReturnType<typeof installRecording>;
let demoId = "";
let restoreVariant: (() => void) | null = null;

function doubles(): Partial<RecordingDeps> {
  return {
    createNetworkCapture: (deps, options) => {
      network.deps = deps;
      network.options = options;
      return {
        start: async (tabId, url) => {
          network.calls.push(`start ${tabId} ${url}`);
          if (network.failStart) throw new Error("attach failed");
          return isRecordablePage(url) ? "debugger" : "waiting";
        },
        addTab: async (tabId, url) => {
          network.calls.push(`addTab ${tabId} ${url}`);
        },
        onCommitted: async (tabId, frameId, url) => {
          network.calls.push(`onCommitted ${tabId} ${frameId} ${url}`);
        },
        resume: async () => "off" as NetworkMode,
        recordPageEvent: async (event) => {
          network.recorded.push(event);
        },
        stop: async () => {
          network.calls.push("stop");
        },
      };
    },
    createPageFallback: () => {
      fallback.created += 1;
      return fallback.value;
    },
    acceptPageNetworkEvent: (event, digests) => {
      accepted.push({ event, digests: [...digests] });
      return acceptAnswer;
    },
    acquireTabStreamId: async (tabId) =>
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
    recoverNetworkBodies: async () => {},
    readPolicy: async () => policy,
    hasHostPermission: async () => hostAccess,
    now: () => now,
    openDatabase: () => openRecorderDatabase(dbName),
    timers: fakeTimers,
    createStepUploader: (deps) => {
      uploader = createStepUploader(deps);
      return uploader;
    },
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
const contentPort = (tabId: number, frameId = 0) =>
  fake.connectFrom(PORT_CONTENT, {
    id: EXTENSION_ID,
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId,
    url: "https://crm.example.test/",
  });

async function startRecording(input: {
  botId: string;
  title: string;
  tabId: number;
  microphone?: boolean;
}) {
  if (!fake.tabs.has(input.tabId))
    fake.tabs.set(input.tabId, {
      id: input.tabId,
      url: DEAL,
    } as chrome.tabs.Tab);
  const answer = await page({
    type: "page.record",
    microphone: false,
    ...input,
  });
  expect(answer).toEqual({ ok: true });
  demoId = `demo-${openbot.nextDemo}`;
  return demoId;
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

async function everyStoredRecord(): Promise<unknown[]> {
  const db = await openRecorderDatabase(dbName);
  try {
    const all: unknown[] = [];
    for (const store of STORES)
      all.push(
        ...(await requestToPromise(
          db.transaction(store, "readonly").objectStore(store).getAll(),
        )),
      );
    return all;
  } finally {
    db.close();
  }
}

/** Posts content steps from a port and waits until the uploader holds `total` steps. */
async function sendSteps(
  port: FakePort,
  actions: DemonstrationAction[],
  total: number,
) {
  for (const action of actions)
    port.postMessage({ type: "content.step", action });
  await until(() => uploader.count() === total, `${total} steps queued`);
}

beforeEach(() => {
  savedIndexed = {
    indexedDB: indexedGlobals.indexedDB,
    IDBKeyRange: indexedGlobals.IDBKeyRange,
  };
  indexedGlobals.indexedDB = new IDBFactory();
  indexedGlobals.IDBKeyRange = FakeIDBKeyRange;
  dbName = `recording-test-${++dbCounter}`;
  fake = installChromeFake({
    extensionId: EXTENSION_ID,
    manifestVersion: "0.3.0",
  });
  const offscreen = chrome.offscreen as unknown as {
    createDocument(
      parameters: chrome.offscreen.CreateParameters,
    ): Promise<void>;
    closeDocument(): Promise<void>;
  };
  const create = offscreen.createDocument;
  const close = offscreen.closeDocument;
  offscreen.createDocument = async (parameters) => {
    await create(parameters);
    setTimeout(openDocument, 0);
  };
  offscreen.closeDocument = async () => {
    await close();
    doc?.disconnect();
    doc = null;
  };
  doc = null;
  docDemo = "";
  holdStop = false;
  docPoll = setInterval(answerAsDocument, 1);
  timers = [];
  now = 1_800_000_000_000;
  resetOpenBot();
  network = { calls: [], recorded: [], failStart: false };
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
  demoId = "";
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
  indexedGlobals.indexedDB = savedIndexed.indexedDB;
  indexedGlobals.IDBKeyRange = savedIndexed.IDBKeyRange;
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

test("Record starts the demonstration and trajectory, opens the document, then takes the tab stream id right before offscreen.start", async () => {
  fake.tabCapture.answer = "stream-1";
  await startRecording({ botId: "bot-1", title: "Update deal", tabId: 7 });
  expect(requests()).toEqual([
    "POST /api/recorder/demonstrations",
    `POST ${demoPath(demoId, "/trajectories")}`,
  ]);
  expect(openbot.calls[0]?.body).toEqual({
    botId: "bot-1",
    title: "Update deal",
  });
  expect(openbot.calls.every((c) => c.auth === "Bearer obr_one")).toBe(true);
  const created = fake.calls.indexOf("offscreen.createDocument");
  const ready = fake.calls.indexOf("port:recorder:offscreen offscreen.ready");
  const capture = fake.calls.indexOf("tabCapture.getMediaStreamId");
  expect(created).toBeGreaterThanOrEqual(0);
  expect(created).toBeLessThan(ready);
  expect(ready).toBeLessThan(capture);
  expect(fake.calls[capture + 1]).toBe(
    "port:recorder:offscreen offscreen.start",
  );
  expect(fake.tabCapture.calls).toEqual([{ targetTabId: 7 }]);
  const start = sentToDocument("offscreen.start")[0];
  const trajectoryId = registered(1);
  expect(start).toMatchObject({
    type: "offscreen.start",
    session: {
      demonstrationId: demoId,
      botId: "bot-1",
      title: "Update deal",
      openbotUrl: origin,
      token: "obr_one",
      trajectoryId,
      version: "0.3.0",
      allowedIntelligenceUrls: null,
      media: { tabStreamId: "stream-1", microphone: false },
    },
  });
  expect(fake.offscreen.created[0]).toMatchObject({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
  });
  expect(fake.scripting.registered).toEqual([]); // nothing registered for every site (Decision 4)
  const injected = fake.scripting.executed.filter(
    (i) => (i.target as { tabId: number }).tabId === 7,
  );
  expect(injected[0]).toMatchObject({
    target: { tabId: 7, allFrames: true },
    args: [demoId],
    injectImmediately: true,
  }); // the active flag first
  expect(injected[1]).toMatchObject({
    target: { tabId: 7, allFrames: true },
    files: ["content.js"],
    injectImmediately: true,
  });
  expect(fake.storage.local.get("activeRecording")).toMatchObject({
    demonstrationId: demoId,
    botId: "bot-1",
    title: "Update deal",
    openbotUrl: origin,
    userId: "p1",
    userName: "Ada",
    trajectoryIds: [trajectoryId],
    discard: false,
  });
  expect(fake.storage.local.get("lastBotId")).toBe("bot-1");
  expect((fake.storage.session.get("stream") as { token: string }).token).toBe(
    "obr_one",
  );
  const recording = await state();
  expect(recording).toMatchObject({
    phase: "recording",
    demonstrationId: demoId,
    tabIds: [7],
    topUrls: { "7": DEAL },
    steps: 1,
  });
  expect(fake.badge).toEqual({ text: "1", color: "#e7000b" });
});

test("Record copies the picked Bot's Learning space from the last Bot list", async () => {
  await page({ type: "page.bots" });
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  expect((await state()).learning).toEqual({
    state: "assigned",
    containerId: "space-1",
  });
});

test("the first step is the page the recording started on", async () => {
  fake.tabs.set(7, {
    id: 7,
    url: "http://127.0.0.1:9/login?next=/x",
  } as chrome.tabs.Tab);
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  await uploader.flush();
  expect(openbot.batches[0]?.actions[0]).toEqual({
    kind: "navigate",
    url: "http://127.0.0.1:9/login",
    transition: "other",
  });
});

test("a step from a sub-frame carries the top page's URL, so the draft never opens the frame", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const top = contentPort(7, 0);
  const frame = contentPort(7, 3);
  await sendSteps(frame, [click("Embed", "http://[::1]:9/embed")], 2);
  await sendSteps(
    top,
    [click("Save", "https://crm.example.test/deals/42/edit")],
    3,
  );
  await uploader.flush();
  const actions = openbot.batches.flatMap((batch) => batch.actions);
  expect(actions[1]).toEqual(click("Embed", DEAL));
  expect(actions[2]).toEqual(
    click("Save", "https://crm.example.test/deals/42/edit"),
  );
});

test("a frame committed in a followed tab gets the content script; a frame in another tab does not", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
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
    args: [demoId],
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
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
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
  await until(() => uploader.count() === 2, "the next page's step");
  expect((await state()).phase).toBe("recording");
});

test("Record without website access is refused with the access sentence", async () => {
  hostAccess = false;
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  expect(
    await page({
      type: "page.record",
      botId: "bot-1",
      title: "T",
      tabId: 7,
      microphone: false,
    }),
  ).toEqual({ ok: false, error: "Allow the Recorder to read websites first." });
  expect(openbot.calls).toEqual([]);
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
    microphone: false,
  });
  expect(answer.ok).toBe(false);
  expect(openbot.calls).toEqual([]);
  expect((await state()).phase).toBe("idle");
});

test("Record while a recording runs is refused and changes nothing", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const answer = await page({
    type: "page.record",
    botId: "bot-1",
    title: "T",
    tabId: 7,
    microphone: false,
  });
  expect(answer).toEqual({
    ok: false,
    error: "A recording is already running.",
  });
  expect(await state()).toMatchObject({
    phase: "recording",
    demonstrationId: demoId,
  });
});

test("Record on a chrome:// page starts without a screen and takes it when the tab reaches a website", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  expect(fake.tabCapture.calls).toEqual([]);
  expect((await state()).capture).toMatchObject({
    screen: "off",
    screenReason: expect.stringContaining("website"),
  });
  expect(sentToDocument("offscreen.start")[0]).toMatchObject({
    session: { media: { tabStreamId: null } },
  });
  expect((await state()).steps).toBe(0); // no step for a page that is not a website
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/",
    transitionType: "typed",
  });
  await until(
    () => sentToDocument("offscreen.screen").length === 1,
    "the screen starts",
  );
  expect(toDocument().at(-1)).toMatchObject({
    type: "offscreen.screen",
    tabStreamId: expect.any(String),
  });
  expect(fake.tabCapture.calls).toEqual([{ targetTabId: 7 }]);
  expect((await state()).capture.screenReason).toBeUndefined();
});

test("Record screen in the popup takes a fresh stream id", async () => {
  fake.tabCapture.answer = "stream-1";
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  fake.tabCapture.answer = "stream-2";
  expect(await page({ type: "page.screen" })).toEqual({ ok: true });
  expect(toDocument().at(-1)).toEqual({
    type: "offscreen.screen",
    tabStreamId: "stream-2",
  });
  expect(fake.tabCapture.calls).toEqual([
    { targetTabId: 7 },
    { targetTabId: 7 },
  ]);
  fake.tabCapture.answer = new Error(
    "Extension has not been invoked for the current page.",
  );
  const refused = await page({ type: "page.screen" });
  expect(refused).toEqual({
    ok: false,
    error:
      "Open the Recorder on the tab you are recording, then choose Record screen.",
  });
  expect((await state()).capture).toMatchObject({
    screen: "off",
    screenReason:
      "Open the Recorder on the tab you are recording, then choose Record screen.",
  });
});

// ---- Stop and the document --------------------------------------------------------------------

test("Stop drains media and voice, then sends every step, then tells OpenBot", async () => {
  openbot.stopLearning = { state: "assigned", containerId: "space-1" };
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const content = contentPort(7);
  await sendSteps(content, [click("One"), click("Two")], 3);
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
    stopping: { since: now, stage: "draining" },
  });
  expect(content.messages).toContainEqual({
    type: "background.capture",
    active: false,
  });
  expect(network.calls).toContain("stop");
  await settle();
  expect(requests().some((r) => r.endsWith("/stop"))).toBe(false); // waits for offscreen.stopped
  doc?.postMessage({
    type: "offscreen.stopped",
    demonstrationId: demoId,
    trajectoryIds: [],
  });
  expect(await stopping).toEqual({ ok: true });
  expect(requests().slice(-2)).toEqual([
    `POST ${demoPath(demoId, "/actions")}`,
    `POST ${demoPath(demoId, "/stop")}`,
  ]);
  expect(openbot.batches.flatMap((b) => b.actions)).toHaveLength(3);
  expect(await storedSteps(demoId)).toEqual([]);
  expect(await state()).toMatchObject({
    phase: "idle",
    lastStopped: {
      demonstrationId: demoId,
      botId: "bot-1",
      openbotUrl: origin,
    },
    draining: 1,
    learning: { state: "assigned", containerId: "space-1" },
  });
  expect((await state()).stopping).toBeUndefined();
  expect(fake.badge.text).toBe("");
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect(drains().map((d) => d.demonstrationId)).toEqual([demoId]);
  doc?.postMessage({ type: "offscreen.done", demonstrationId: demoId });
  await until(() => drains().length === 0, "the drain is forgotten");
  expect((await state()).draining).toBe(0);
});

test("a stop whose document never answers goes on after 120 seconds from when it began", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  holdStop = true;
  const stopping = page({ type: "page.stop" });
  await until(
    () => sentToDocument("offscreen.stop").length === 1,
    "offscreen.stop",
  );
  await advance(119_000);
  expect(requests().some((r) => r.endsWith("/stop"))).toBe(false);
  await advance(1_000);
  expect(await stopping).toEqual({ ok: true });
  expect(requests().at(-1)).toBe(`POST ${demoPath(demoId, "/stop")}`);
});

test("the document closes only when every drain is done", async () => {
  const first = await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  await page({ type: "page.stop" });
  const second = await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  await page({ type: "page.stop" });
  expect(fake.offscreen.created).toHaveLength(1);
  doc?.postMessage({ type: "offscreen.done", demonstrationId: first });
  await until(() => drains().length === 1, "the first drain is forgotten");
  await settle();
  expect(fake.offscreen.open).toBe(true);
  doc?.postMessage({ type: "offscreen.done", demonstrationId: second });
  await until(() => !fake.offscreen.open, "the document closes");
  expect(drains()).toEqual([]);
});

test("steps upload while intelligence is unavailable", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const trajectoryId = registered(1) ?? "";
  doc?.postMessage({
    type: "offscreen.status",
    capture: {
      intelligence: "held",
      intelligenceReason: "Learning capture is paused",
    },
    trajectoryId,
  });
  await sendSteps(contentPort(7), [click()], 2);
  await uploader.flush();
  expect(openbot.batches.flatMap((b) => b.actions)).toHaveLength(2);
  expect((await state()).capture).toMatchObject({
    intelligence: "held",
    intelligenceReason: "Learning capture is paused",
  });
});

test("a recording stopped in OpenBot while idle stops here at the next heartbeat", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const polls = () =>
    requests().filter((r) =>
      r.startsWith("GET /api/recorder/demonstrations/open"),
    );
  openbot.open = (botId) => ({
    demonstration: botId === "bot-1" ? demonstration(demoId) : null,
  });
  doc?.postMessage({ type: "offscreen.heartbeat" });
  await until(() => polls().length === 1, "the first poll");
  expect(polls()[0]).toBe("GET /api/recorder/demonstrations/open?botId=bot-1");
  doc?.postMessage({ type: "offscreen.heartbeat" });
  await settle();
  expect(polls()).toHaveLength(1); // at most once per 25 s
  expect((await state()).phase).toBe("recording");
  await advance(25_000);
  openbot.open = () => ({ demonstration: null });
  doc?.postMessage({ type: "offscreen.heartbeat" });
  await until(
    async () => (await state()).phase === "idle",
    "the recording stops",
  );
  expect(polls()).toHaveLength(2);
  expect(sentToDocument("offscreen.stop")).toEqual([
    { type: "offscreen.stop", outcome: "succeeded", stoppedFrom: "openbot" },
  ]);
  expect(requests().some((r) => r.endsWith("/stop"))).toBe(false);
  expect(fake.badge.text).toBe("");
  expect((await state()).error).toBe(STOPPED_IN_OPENBOT);
});

test("a heartbeat answer carrying a Learning state updates the popup's row", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  openbot.open = () => ({
    demonstration: demonstration(demoId, {
      state: "unjoined",
      containerId: null,
    }),
  });
  doc?.postMessage({ type: "offscreen.heartbeat" });
  await until(
    async () => (await state()).learning?.state === "unjoined",
    "the Learning state",
  );
  expect((await state()).phase).toBe("recording");
});

test("a signed-out heartbeat answer stops here and keeps everything", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  openbot.openSignedOut = "revoked";
  doc?.postMessage({ type: "offscreen.heartbeat" });
  await until(
    async () => (await state()).phase === "idle",
    "the recording stops",
  );
  expect(fake.storage.local.get("connection")).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "revoked",
  });
  expect((await state()).error).toBe(SIGNED_OUT);
  expect(await storedSteps(demoId)).toHaveLength(1);
  expect(drains()[0]).toMatchObject({
    demonstrationId: demoId,
    stopPending: true,
    kept: { waitingForReconnect: true },
  });
});

test("kept events are listed, and discarded only when the person asks", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  await page({ type: "page.stop" });
  const first = doc;
  first?.postMessage({
    type: "offscreen.kept",
    demonstrationId: demoId,
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
    { type: "offscreen.discard", demonstrationIds: [demoId] },
  ]);
  expect(drains()).toEqual([]);
  expect((await state()).kept).toBeUndefined();
});

test("the 50-step notice goes once to every followed tab's top frame and network steps do not count", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
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
  const notices = (port: FakePort) =>
    port.messages.filter(
      (m) => (m as { type: string }).type === "background.notice",
    );
  for (let i = 0; i < 49; i++)
    top7.postMessage({ type: "content.step", action: click(`B${i}`) });
  for (let i = 0; i < 10; i++) network.deps?.step(networkStep);
  await until(() => uploader.count() === 59, "59 steps queued");
  await settle();
  expect((await state()).steps).toBe(49);
  expect([...notices(top7), ...notices(top8), ...notices(sub7)]).toEqual([]);
  await sendSteps(top7, [click("B49")], 60);
  await until(() => notices(top8).length === 1, "the notice reaches tab 8");
  expect(notices(top7)).toEqual([
    { type: "background.notice", show: true, steps: 50 },
  ]);
  expect(notices(top8)).toEqual([
    { type: "background.notice", show: true, steps: 50 },
  ]);
  expect(notices(sub7)).toEqual([]);
  expect((await state()).noticeShown).toBe(true);
  await sendSteps(top7, [click("B50")], 61);
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

test("a recording stopped in OpenBot stops here too and still drains", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const content = contentPort(7);
  await sendSteps(content, [click()], 2);
  openbot.refuseActions = true;
  await uploader.flush().catch(() => undefined);
  await until(
    async () => (await state()).phase === "idle",
    "the recording stops",
  );
  expect(sentToDocument("offscreen.stop")).toEqual([
    { type: "offscreen.stop", outcome: "succeeded", stoppedFrom: "openbot" },
  ]);
  expect(requests().some((r) => r.endsWith("/stop"))).toBe(false);
  expect(content.messages).toContainEqual({
    type: "background.capture",
    active: false,
  });
  expect((await state()).error).toBe(STOPPED_IN_OPENBOT);
  expect(await storedSteps(demoId)).toEqual([]); // the steps OpenBot refused are dropped
  expect(drains()).toMatchObject([{ demonstrationId: demoId }]);
  expect(drains()[0]?.stopPending).toBeUndefined();
});

test("a signed-out step upload stops here and keeps every step for the person", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  await sendSteps(contentPort(7), [click()], 2);
  openbot.signedOutActions = "removed";
  await uploader.flush().catch(() => undefined);
  await until(
    async () => (await state()).phase === "idle",
    "the recording stops",
  );
  expect(fake.storage.local.get("connection")).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "removed",
  });
  expect((await state()).error).toBe(SIGNED_OUT);
  expect(await storedSteps(demoId)).toHaveLength(2);
  expect(drains()[0]).toMatchObject({
    demonstrationId: demoId,
    stopPending: true,
    kept: { waitingForReconnect: true, parked: true },
  });
  expect(requests().some((r) => r.endsWith("/stop"))).toBe(false);
});

test("a signed-out pass names its reason and keeps everything for the person", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  await sendSteps(contentPort(7), [click("One"), click("Two")], 3);
  const document = doc;
  document?.postMessage({
    type: "offscreen.signed-out",
    reason: "organization",
  });
  await until(
    async () => (await state()).phase === "idle",
    "the recording stops",
  );
  expect(fake.storage.local.get("connection")).toBeUndefined();
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
  expect(sentToDocument("offscreen.discard", document)).toEqual([]);
  expect(await storedSteps(demoId)).toHaveLength(3);
  expect(drains()).toMatchObject([
    {
      demonstrationId: demoId,
      userId: "p1",
      stopPending: true,
      kept: { waitingForReconnect: true, parked: true },
    },
  ]);
  expect(requests().some((r) => r.endsWith("/stop"))).toBe(false);
});

test("connecting again as the same person sends what was kept; another person does not", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  await sendSteps(
    contentPort(7),
    [click("One"), click("Two"), click("Three")],
    3,
  );
  doc?.postMessage({ type: "offscreen.signed-out", reason: "revoked" });
  await until(
    () => drains()[0]?.kept?.waitingForReconnect === true,
    "kept for Ada",
  );
  const before = openbot.calls.length;
  connect(bea, "obr_bea");
  await handlers.connected();
  await settle();
  expect(openbot.calls.length).toBe(before);
  expect(drains()[0]?.kept?.waitingForReconnect).toBe(true);
  expect(await storedSteps(demoId)).toHaveLength(3);
  connect(ada, "obr_two");
  await handlers.connected();
  await until(
    () => sentToDocument("offscreen.recover").length === 1,
    "offscreen.recover",
  );
  const sent = openbot.calls.slice(before);
  expect(sent.map((c) => `${c.method} ${c.path}`)).toEqual([
    `POST ${demoPath(demoId, "/actions")}`,
    `POST ${demoPath(demoId, "/stop")}`,
  ]);
  expect(sent.every((c) => c.auth === "Bearer obr_two")).toBe(true);
  expect((sent[0]?.body as Batch | undefined)?.actions).toHaveLength(3);
  expect(sentToDocument("offscreen.recover")[0]).toMatchObject({
    type: "offscreen.recover",
    openbotUrl: origin,
    token: "obr_two",
    drains: [{ demonstrationId: demoId, userId: "p1" }],
  });
  expect(drains()[0]?.stopPending).toBeUndefined();
  expect(drains()[0]?.kept).toBeUndefined();
});

test("Disconnect discards the kept recordings, and nothing else does", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  const first = await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  await page({ type: "page.stop" });
  doc?.postMessage({
    type: "offscreen.kept",
    demonstrationId: first,
    reason: "Learning capture is paused.",
    parked: false,
    events: 4,
  });
  await until(() => drains()[0]?.kept !== undefined, "the first is kept");
  const second = await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  await sendSteps(contentPort(7), [click("One"), click("Two")], 2);
  expect(await page({ type: "page.disconnect" })).toEqual({ ok: true });
  await until(
    () => sentToDocument("offscreen.discard").length === 1,
    "offscreen.discard",
  );
  expect(sentToDocument("offscreen.stop").at(-1)).toEqual({
    type: "offscreen.stop",
    outcome: "succeeded",
  });
  expect(sentToDocument("offscreen.discard")[0]).toEqual({
    type: "offscreen.discard",
    demonstrationIds: [first, second],
  });
  expect(requests()).not.toContain(`POST ${demoPath(second, "/stop")}`);
  expect(await storedSteps(second)).toEqual([]);
  expect(drains()).toEqual([]);
  expect(fake.storage.local.get("connection")).toBeUndefined();
  expect((await state()).phase).toBe("idle");
});

test("Stop sends every queued step before telling OpenBot, and waits for OpenBot when it is away", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  openbot.failActions = 1_000; // the live uploads fail while the steps are recorded
  const content = contentPort(7);
  for (let i = 0; i < 30; i++)
    content.postMessage({ type: "content.step", action: click(`B${i}`) });
  await until(() => uploader.count() === 30, "30 steps queued");
  await settle();
  expect(await storedSteps(demoId)).toHaveLength(30);
  openbot.failActions = 1;
  expect(await page({ type: "page.stop" })).toEqual({ ok: true });
  expect(await state()).toMatchObject({ phase: "idle", error: STOP_PENDING });
  expect(drains()).toMatchObject([
    { demonstrationId: demoId, stopPending: true },
  ]);
  expect(requests()).not.toContain(`POST ${demoPath(demoId, "/stop")}`);
  openbot.down = true; // OpenBot stays away through the first retry
  await advance(5_000);
  expect(requests()).not.toContain(`POST ${demoPath(demoId, "/stop")}`);
  expect((await state()).error).toBe(STOP_PENDING);
  openbot.down = false;
  await advance(9_000);
  expect(requests()).not.toContain(`POST ${demoPath(demoId, "/stop")}`); // the backoff doubled to 10 s
  await advance(1_000);
  await until(
    () => requests().includes(`POST ${demoPath(demoId, "/stop")}`),
    "the stop reaches OpenBot",
  );
  expect(requests().at(-1)).toBe(`POST ${demoPath(demoId, "/stop")}`);
  expect(openbot.batches.flatMap((b) => b.actions)).toHaveLength(30);
  await until(
    async () => (await state()).error === undefined,
    "the error clears",
  );
  expect(drains()[0]?.stopPending).toBeUndefined();
  expect(await storedSteps(demoId)).toEqual([]);
});

test("content events wait while the offscreen port is down, and only the oldest beyond 2,000 are dropped, counted", async () => {
  fake.tabs.set(7, { id: 7, url: "chrome://newtab/" } as chrome.tabs.Tab);
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const content = contentPort(7);
  doc?.disconnect();
  doc = null;
  await settle();
  for (let i = 0; i < 2_010; i++) {
    content.postMessage({ type: "content.event", event: contentEvent({ i }) });
    if (i === 1_000) {
      content.postMessage({ type: "content.step", action: click() });
      content.postMessage({
        type: "content.sensitive",
        digest: "d".repeat(64),
      });
    }
  }
  await until(() => uploader.count() === 1, "the step is queued");
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
  expect(await storedSteps(demoId)).toHaveLength(1);
  expect(fake.storage.session.get("digests")).toEqual(["d".repeat(64)]);
});

test("a tab whose url Chrome withholds (a chrome:// page) starts with the screen off", async () => {
  fake.tabs.set(7, { id: 7 } as chrome.tabs.Tab);
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  expect(fake.tabCapture.calls).toEqual([]);
  expect(network.calls).toEqual(["start 7 "]);
  expect(await state()).toMatchObject({
    phase: "recording",
    topUrls: { "7": "" },
    steps: 0,
    capture: {
      screen: "off",
      screenReason: "The screen is recorded once this tab opens a website.",
      network: "waiting",
    },
  });
});

test("the network capture is handed the fallback and Task 9 never calls the fallback itself", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  expect(fallback.created).toBe(1);
  expect(network.options?.fallback).toBe(fallback.value);
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
});

test("in the e2e build the hold interval travels in the session", async () => {
  useVariant("e2e");
  fake.storage.local.set("RECORDER_E2E_HOLD_RETRY_MS", 5_000);
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  expect(sentToDocument("offscreen.start")[0]).toMatchObject({
    session: { e2eHoldRetryMs: 5_000 },
  });
});

test("outside the e2e build the session carries no hold interval", async () => {
  fake.storage.local.set("RECORDER_E2E_HOLD_RETRY_MS", 5_000);
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const start = sentToDocument("offscreen.start")[0];
  expect(
    start?.type === "offscreen.start" && "e2eHoldRetryMs" in start.session,
  ).toBe(false);
});

test("in the e2e build a flood forwards synthetic events to the document", async () => {
  useVariant("e2e");
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
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

test("sensitive digests live in storage.session only", async () => {
  const digest = "a".repeat(64);
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
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
  expect(JSON.stringify(await everyStoredRecord())).not.toContain(digest);
  network.deps?.status("page");
  acceptAnswer = { event: contentEvent({ masked: true }), step: null };
  await fake.sendExternal(
    { type: "recorder.page-network", event: contentEvent({ body: "x" }) },
    { tab: { id: 7 } as chrome.tabs.Tab, url: DEAL },
  );
  expect(accepted[0]?.digests).toEqual([digest]); // masking sees the digest
  await page({ type: "page.stop" });
  expect(fake.storage.session.get("digests")).toBeUndefined();
});

test("events from a tab that is not being recorded are ignored", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const other = contentPort(99);
  other.postMessage({ type: "content.event", event: contentEvent({ i: 1 }) });
  other.postMessage({ type: "content.step", action: click() });
  await until(() => other.messages.length > 0, "the tab is told to stop");
  await settle();
  expect(sentToDocument("offscreen.event")).toEqual([]);
  expect(uploader.count()).toBe(1);
  expect(other.messages).toContainEqual({
    type: "background.capture",
    active: false,
  });
});

test("a content script that says hello learns whether to capture", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
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
    demonstrationId: demoId,
  });
  expect(other.messages[0]).toEqual({
    type: "background.capture",
    active: false,
  });
});

test("a tab the recorded tab opened is followed", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
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

test("navigation in every frame becomes an event, and only the top frame becomes a step", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
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
    url: "https://widgets.example.test/a",
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
    value: { frameId: 2, from: "" },
  });
  expect(events[2]).toMatchObject({
    name: "navigation",
    value: {
      from: "https://crm.example.test/deals/43?tab=notes",
      to: "https://crm.example.test/deals/44",
    },
  });
  await uploader.flush();
  expect(openbot.batches.flatMap((b) => b.actions)).toEqual([
    { kind: "navigate", url: DEAL, transition: "other" },
    {
      kind: "navigate",
      url: "https://crm.example.test/deals/43",
      transition: "link",
    },
    {
      kind: "navigate",
      url: "https://crm.example.test/deals/44",
      transition: "history",
    },
  ]);
  expect((await state()).topUrls["7"]).toBe(
    "https://crm.example.test/deals/44",
  );
});

test("a failure after the demonstration exists rolls everything back", async () => {
  openbot.trajectoryStatus = 500;
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  const answer = await page({
    type: "page.record",
    botId: "bot-1",
    title: "T",
    tabId: 7,
    microphone: false,
  });
  expect(answer).toEqual({
    ok: false,
    error: "Could not register the trajectory.",
  });
  expect(requests()).toEqual([
    "POST /api/recorder/demonstrations",
    `POST ${demoPath("demo-1", "/trajectories")}`,
    `DELETE ${demoPath("demo-1")}`,
  ]);
  expect(fake.scripting.registered).toEqual([]);
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect(await state()).toMatchObject({
    phase: "idle",
    error: "Could not register the trajectory.",
  });
  // A failure once the document started also stops it and the scripts.
  openbot.trajectoryStatus = 204;
  network.failStart = true;
  const later = await page({
    type: "page.record",
    botId: "bot-1",
    title: "T",
    tabId: 7,
    microphone: false,
  });
  expect(later.ok).toBe(false);
  expect(requests().at(-1)).toBe(`DELETE ${demoPath("demo-2")}`);
  expect(sentToDocument("offscreen.stop")).toEqual([
    { type: "offscreen.stop", outcome: "failed" },
  ]);
  expect(await storedSteps("demo-2")).toEqual([]);
  expect(fake.storage.local.get("activeRecording")).toBeUndefined();
  expect((await state()).phase).toBe("idle");
});

test("an open recording elsewhere is offered for stopping, and replaceOpen stops it and starts", async () => {
  openbot.createAnswers.push({
    status: 409,
    body: {
      error: "You already have an open recording.",
      code: RECORDER_OPEN_RECORDING,
      demonstrationId: "demo-old",
    },
  });
  fake.tabs.set(7, { id: 7, url: DEAL } as chrome.tabs.Tab);
  const refused = await page({
    type: "page.record",
    botId: "bot-1",
    title: "T",
    tabId: 7,
    microphone: false,
  });
  expect(refused).toEqual({
    ok: false,
    error:
      "You already have an open recording for this Bot, maybe in another browser.",
  });
  expect(await state()).toMatchObject({
    phase: "idle",
    openRecording: { demonstrationId: "demo-old" },
  });
  const before = openbot.calls.length;
  const replaced = await page({
    type: "page.record",
    botId: "bot-1",
    title: "T",
    tabId: 7,
    microphone: false,
    replaceOpen: true,
  });
  expect(replaced).toEqual({ ok: true });
  expect(requests().slice(before)).toEqual([
    `POST ${demoPath("demo-old", "/stop")}`,
    "POST /api/recorder/demonstrations",
    `POST ${demoPath("demo-1", "/trajectories")}`,
  ]);
  expect(await state()).toMatchObject({
    phase: "recording",
    demonstrationId: "demo-1",
  });
  expect((await state()).openRecording).toBeUndefined();
});

test("Start over stops the old recording, records into a new one and deletes the old one only after its events drained", async () => {
  const old = await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  await sendSteps(contentPort(7), [click()], 2);
  const before = openbot.calls.length;
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  const fresh = "demo-2";
  const trajectoryId = registered(before + 3) ?? "";
  expect(requests().slice(before)).toEqual([
    `POST ${demoPath(old, "/actions")}`, // its queued steps go before OpenBot hears of the stop
    `POST ${demoPath(old, "/stop")}`,
    "POST /api/recorder/demonstrations",
    `POST ${demoPath(fresh, "/trajectories")}`,
  ]);
  expect(sentToDocument("offscreen.rotate")).toEqual([
    { type: "offscreen.rotate", demonstrationId: fresh, trajectoryId },
  ]);
  expect(await state()).toMatchObject({
    phase: "recording",
    demonstrationId: fresh,
    steps: 1, // the page it starts on (Decision 16)
    noticeShown: false,
  });
  expect(fake.storage.local.get("activeRecording")).toMatchObject({
    demonstrationId: fresh,
    trajectoryIds: [trajectoryId],
  });
  expect(drains()).toMatchObject([{ demonstrationId: old, discard: true }]);
  expect(await storedSteps(old)).toEqual([]);
  await settle();
  expect(requests()).not.toContain(`DELETE ${demoPath(old)}`);
  doc?.postMessage({ type: "offscreen.rotated", previousDemonstrationId: old });
  await until(
    () => requests().includes(`DELETE ${demoPath(old)}`),
    "the old one is deleted",
  );
  doc?.postMessage({ type: "offscreen.done", demonstrationId: old });
  await until(() => drains().length === 0, "its drain is forgotten");
  expect(
    requests().filter((r) => r === `DELETE ${demoPath(old)}`),
  ).toHaveLength(1);
  await sendSteps(contentPort(7), [click()], 2);
  await uploader.flush();
  expect(openbot.batches.at(-1)).toMatchObject({ fromIndex: 0 });
  expect(openbot.calls.at(-1)?.path).toBe(demoPath(fresh, "/actions"));
});

test("Start over is not stopped by a step upload OpenBot refuses for the recording it leaves", async () => {
  const old = await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const content = contentPort(7);
  await sendSteps(content, [click()], 2);
  const create = gate();
  openbot.holdCreate = create.promise;
  const before = openbot.calls.length;
  const restarted = page({ type: "page.restart" });
  await until(
    () =>
      requests().slice(before).includes("POST /api/recorder/demonstrations"),
    "the new recording is being created",
  );
  // A step and the uploader's 3 s flush land while OpenBot is still creating the new recording.
  content.postMessage({ type: "content.step", action: click("Late") });
  await settle();
  await advance(3_000);
  create.open();
  expect(await restarted).toEqual({ ok: true });
  expect(await state()).toMatchObject({
    phase: "recording",
    demonstrationId: "demo-2",
  });
  expect((await state()).error).toBeUndefined();
  expect(sentToDocument("offscreen.stop")).toEqual([]);
  // The old recording's queued steps went before its stop, and nothing was sent to it after.
  expect(requests().slice(before)).toEqual([
    `POST ${demoPath(old, "/actions")}`,
    `POST ${demoPath(old, "/stop")}`,
    "POST /api/recorder/demonstrations",
    `POST ${demoPath("demo-2", "/trajectories")}`,
  ]);
  expect(fake.storage.local.get("activeRecording")).toMatchObject({
    demonstrationId: "demo-2",
  });
  await sendSteps(content, [click()], 2);
  await uploader.flush();
  expect(openbot.calls.at(-1)?.path).toBe(demoPath("demo-2", "/actions"));
  expect(openbot.batches.at(-1)).toMatchObject({ fromIndex: 0 });
  expect(openbot.batches.at(-1)?.actions).toHaveLength(2);
});

test("a heartbeat answered with no open recording during Start over stops nothing", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const polls = () =>
    requests().filter((r) =>
      r.startsWith("GET /api/recorder/demonstrations/open"),
    );
  const open = gate();
  openbot.holdOpen = open.promise;
  doc?.postMessage({ type: "offscreen.heartbeat" });
  await until(() => polls().length === 1, "a poll in flight");
  const create = gate();
  openbot.holdCreate = create.promise;
  const before = openbot.calls.length;
  const restarted = page({ type: "page.restart" });
  await until(
    () =>
      requests().slice(before).includes("POST /api/recorder/demonstrations"),
    "the new recording is being created",
  );
  // The poll sent before Start over is answered while it runs (`{ demonstration: null }`), and a heartbeat during it
  // does not ask at all.
  open.open();
  now += 25_000;
  doc?.postMessage({ type: "offscreen.heartbeat" });
  await settle();
  create.open();
  expect(await restarted).toEqual({ ok: true });
  expect(await state()).toMatchObject({
    phase: "recording",
    demonstrationId: "demo-2",
  });
  expect((await state()).error).toBeUndefined();
  expect(sentToDocument("offscreen.stop")).toEqual([]);
  expect(drains()).toMatchObject([
    { demonstrationId: "demo-1", discard: true },
  ]);
  expect(polls()).toHaveLength(1);
});

test("after Start over, a status about the old recording's trajectory leaves the new recording's capture alone", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const oldTrajectory = registered(1) ?? "";
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  const newTrajectory = registered(openbot.calls.length - 1) ?? "";
  expect(newTrajectory).not.toBe(oldTrajectory);
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
    capture: { voice: "recording" },
    trajectoryId: newTrajectory,
  });
  await until(
    async () => (await state()).capture.voice === "recording",
    "the new recording's status",
  );
  expect((await state()).capture.intelligence).toBe("connecting");
  expect((await state()).capture.intelligenceReason).toBeUndefined();
  // A rollover of the new recording reports for it too.
  doc?.postMessage({
    type: "offscreen.trajectory",
    demonstrationId: "demo-2",
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

test("Start over begins the new recording at the page the person is on", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  fake.webNavigation.commit({
    tabId: 7,
    frameId: 0,
    url: "https://crm.example.test/deals/43?tab=notes",
    transitionType: "link",
  });
  await until(
    async () =>
      (await state()).topUrls["7"] ===
      "https://crm.example.test/deals/43?tab=notes",
    "the tab moved",
  );
  expect(await page({ type: "page.restart" })).toEqual({ ok: true });
  expect((await state()).steps).toBe(1);
  await uploader.flush();
  const batches = openbot.calls
    .filter((call) => call.path === demoPath("demo-2", "/actions"))
    .map((call) => call.body as Batch);
  expect(batches[0]).toEqual({
    fromIndex: 0,
    actions: [
      {
        kind: "navigate",
        url: "https://crm.example.test/deals/43",
        transition: "other",
      },
    ],
  });
});

test("a rollover registers the new trajectory on the recording", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  doc?.postMessage({
    type: "offscreen.trajectory",
    demonstrationId: demoId,
    trajectoryId: "t-2",
  });
  await until(
    () =>
      (
        fake.storage.local.get("activeRecording") as DrainRecord
      ).trajectoryIds.includes("t-2"),
    "the trajectory is appended",
  );
  expect(
    (fake.storage.local.get("activeRecording") as DrainRecord).trajectoryIds,
  ).toHaveLength(2);
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
    state: { phase: "idle", tabIds: [], steps: 0 },
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
  expect(fake.storage.local.get("connection")).toBeUndefined();
  expect(fake.storage.local.get("notice")).toMatchObject({
    kind: "signed-out",
    reason: "removed",
  });
});

test("a page-network event is accepted only from a recorded tab while page capture is on", async () => {
  await startRecording({ botId: "bot-1", title: "T", tabId: 7 });
  const event = contentEvent({ request: "x" });
  const fromTab = (tabId: number) =>
    fake.sendExternal(
      { type: "recorder.page-network", event },
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
  acceptAnswer = { event: masked, step: networkStep };
  expect(await fromTab(7)).toEqual({ ok: true });
  expect(network.recorded).toEqual([masked]);
  expect(sentToDocument("offscreen.event")).toEqual([]); // the capture emits it, not this module
  expect(uploader.count()).toBe(2);
  expect((await state()).steps).toBe(1); // network steps do not count
  expect(await fromTab(99)).toEqual({ ok: false, error: "not-recording" });
  expect(network.recorded).toHaveLength(1);
});

test("the state machine's transitions need no timers", () => {
  const capture: RecorderState["capture"] = {
    intelligence: "connecting",
    network: "debugger",
    screen: "off",
    voice: "off",
  };
  let current = reduceRecorder(IDLE_STATE, {
    type: "record",
    botId: "bot-1",
    title: "T",
  });
  expect(current).toMatchObject({
    phase: "starting",
    botId: "bot-1",
    title: "T",
  });
  current = reduceRecorder(current, {
    type: "started",
    demonstrationId: "d1",
    tabId: 7,
    topUrl: DEAL,
    startedAt: 5,
    capture,
  });
  expect(current).toMatchObject({
    phase: "recording",
    tabIds: [7],
    steps: 0,
    topUrls: { "7": DEAL },
  });
  current = reduceRecorder(current, { type: "step" });
  current = reduceRecorder(current, { type: "step" });
  current = reduceRecorder(current, { type: "stop", since: 9 });
  expect(current).toMatchObject({
    phase: "stopping",
    steps: 2,
    stopping: { since: 9, stage: "draining" },
  });
  current = reduceRecorder(current, { type: "stopped" });
  expect(current.stopping?.stage).toBe("telling-openbot");
  current = reduceRecorder(current, {
    type: "finished",
    lastStopped: { demonstrationId: "d1", botId: "bot-1", openbotUrl: origin },
  });
  expect(current).toMatchObject({
    phase: "idle",
    steps: 0,
    tabIds: [],
    lastStopped: { demonstrationId: "d1" },
  });
  expect(current.stopping).toBeUndefined();
  current = reduceRecorder(current, { type: "error", error: "No." });
  expect(current).toMatchObject({ phase: "idle", error: "No." });
});
