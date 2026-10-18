import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RECORDER_SIGNED_OUT } from "@openbot/shared/recorder-api";
import type {
  CapturedEvent,
  JsonValue,
} from "@openbot/shared/recorder-masking";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import { PASS_HINTS } from "../src/offscreen/grant";
import {
  createOffscreenController,
  type OffscreenControllerDeps,
} from "../src/offscreen/index";
import type { MediaSinks } from "../src/offscreen/media";
import {
  type OutboxEvent,
  openOutbox,
  trajectoryMetaKey,
} from "../src/offscreen/outbox";
import {
  type BackgroundToOffscreen,
  type OffscreenToBackground,
  PORT_OFFSCREEN,
  type StreamSession,
} from "../src/protocol/messages";
import type { DrainRecord } from "../src/shared/storage";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";
import { type FakeGateway, startFakeGateway } from "./support/fake-gateway";

const MINUTE = 60_000;
const PARKED = PASS_HINTS.INTELLIGENCE_RUNTIME_REQUIRED;

type Globals = {
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof FakeIDBKeyRange;
  fetch: typeof fetch;
};
const globals = globalThis as unknown as Globals;
let saved: Partial<Globals> = {};
let savedVariant: string | undefined;
let fake: ChromeFake;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Fake timers and a fake clock; the network and IndexedDB stay real, so each step lets them run. */
const CLOCK_START = 1_800_000_000_000;
/** The next browser start, an hour on: the sequencer starts above everything issued before it. */
const NEXT_START = CLOCK_START + 60 * MINUTE;

function virtualClock(start = CLOCK_START) {
  let time = start;
  let nextHandle = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => time,
    timers: {
      set(fn: () => void, ms: number) {
        const handle = nextHandle++;
        pending.set(handle, { fn, at: time + Math.max(0, ms) });
        return handle;
      },
      clear(handle: unknown) {
        pending.delete(handle as number);
      },
    },
    async advance(ms: number) {
      const target = time + ms;
      for (;;) {
        await sleep(2);
        let due: [number, { fn: () => void; at: number }] | undefined;
        for (const entry of pending) {
          if (entry[1].at <= target && (!due || entry[1].at < due[1].at))
            due = entry;
        }
        if (!due) break;
        pending.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].fn();
      }
      time = target;
      await sleep(2);
    },
  };
}
type Clock = ReturnType<typeof virtualClock>;

type Gate = { promise: Promise<void>; release(): void };
function makeGate(): Gate {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** OpenBot's routes the offscreen document calls, served on the fake gateway's own origin. */
type OpenBot = {
  passes: {
    trajectoryId: string;
    authorization: string | null;
    bot: string | null;
  }[];
  /** Answers for the next passes, in order; then `refuse`, then a grant. */
  passScript: (() => Response)[];
  refuse: ((trajectoryId: string) => Response | null) | null;
  registered: { demonstrationId: string; trajectoryId: string }[];
  closed: { demonstrationId: string; trajectoryId: string }[];
  closeAnswer: (() => Response) | null;
};

/** Row 7: only an operator can fix it, so the events are parked. */
const parkedPass = () =>
  Response.json(
    {
      code: "INTELLIGENCE_RUNTIME_REQUIRED",
      message: "Intelligence is not configured.",
    },
    { status: 503 },
  );
/** Row 12: it cannot be told from a transient refusal, so the events are held. */
const heldPass = () =>
  Response.json(
    {
      code: "TRAJECTORIES_NOT_ENABLED",
      message: "Trajectories are not enabled.",
    },
    { status: 403 },
  );
/** Row 2: OpenBot's guard says this browser's connection is gone. */
const signedOutPass = (reason: "revoked" | "removed" | "organization") => () =>
  Response.json(
    {
      error: "This browser is no longer connected to OpenBot.",
      code: RECORDER_SIGNED_OUT,
      reason,
    },
    { status: 401 },
  );

type MediaDouble = {
  sessions: StreamSession[];
  sinks: MediaSinks[];
  screens: string[];
  rotated: string[];
  stops: number;
  onStart: ((sinks: MediaSinks) => void) | null;
  onStop: ((sinks: MediaSinks) => void) | null;
  /** Holds every media.stop() (voice still draining) until released. */
  stopGate: Gate | null;
  finish: Gate | null;
  recovered: {
    drain: DrainRecord;
    target: { openbotUrl: string; token: string };
  }[];
  onRecover: ((drain: DrainRecord, sinks: MediaSinks) => void) | null;
  discarded: string[];
};

type ServiceWorkerPort = {
  port: chrome.runtime.Port;
  messages: OffscreenToBackground[];
};

type Message<T extends OffscreenToBackground["type"]> = Extract<
  OffscreenToBackground,
  { type: T }
>;

type Harness = {
  gateway: FakeGateway;
  openbot: OpenBot;
  dbName: string;
  clock: Clock;
  /** "getUserMedia <tab stream id>" and "fetch <path>", in the order they happened. */
  log: string[];
  media: MediaDouble;
  ports: ServiceWorkerPort[];
  demonstrations: Set<string>;
  /** Registers the service worker's onConnect listener, as a (re)started worker does. */
  listen(): void;
  trackFetch(): void;
  /** Opens a document (a controller) with its own clock and waits for its offscreen.ready. */
  open(clock?: Clock, extra?: Partial<OffscreenControllerDeps>): Promise<void>;
  /** Posts on the newest document's port. */
  post(message: BackgroundToOffscreen): void;
  /** Every message of `type` the service worker received, on every port, in order. */
  received<T extends OffscreenToBackground["type"]>(type: T): Message<T>[];
  /** Messages the newest document posted. */
  latest(): OffscreenToBackground[];
  session(overrides?: Partial<StreamSession>): StreamSession;
  drain(session: StreamSession, overrides?: Partial<DrainRecord>): DrainRecord;
  names(trajectoryId: string): string[];
  values(trajectoryId: string): Record<string, JsonValue>[];
  pending(trajectoryId: string): Promise<OutboxEvent[]>;
};

const harnesses: Harness[] = [];
let dbCounter = 0;

async function setup(): Promise<Harness> {
  const openbot: OpenBot = {
    passes: [],
    passScript: [],
    refuse: null,
    registered: [],
    closed: [],
    closeAnswer: null,
  };
  let gateway: FakeGateway | null = null;
  const route = (request: Request): Response | Promise<Response> | null => {
    if (!gateway || request.method !== "POST") return null;
    const path = new URL(request.url).pathname;
    const pass = /^\/api\/copilotkit\/trajectory\/([^/]+)\/connect$/.exec(path);
    if (pass) {
      const trajectoryId = decodeURIComponent(pass[1]);
      openbot.passes.push({
        trajectoryId,
        authorization: request.headers.get("authorization"),
        bot: request.headers.get("x-openbot-recorder-bot"),
      });
      const scripted = openbot.passScript.shift();
      if (scripted) return scripted();
      const refused = openbot.refuse?.(trajectoryId);
      if (refused) return refused;
      return Response.json({
        joinToken: gateway.mintToken(trajectoryId),
        realtime: {
          clientUrl: `${gateway.url}/client`,
          topic: `trajectory:${trajectoryId}`,
        },
      });
    }
    const close =
      /^\/api\/recorder\/demonstrations\/([^/]+)\/trajectories\/([^/]+)\/close$/.exec(
        path,
      );
    if (close) {
      openbot.closed.push({
        demonstrationId: decodeURIComponent(close[1]),
        trajectoryId: decodeURIComponent(close[2]),
      });
      return openbot.closeAnswer?.() ?? new Response(null, { status: 204 });
    }
    const register =
      /^\/api\/recorder\/demonstrations\/([^/]+)\/trajectories$/.exec(path);
    if (register) {
      const demonstrationId = decodeURIComponent(register[1]);
      return request.json().then((body) => {
        openbot.registered.push({
          demonstrationId,
          trajectoryId: (body as { trajectoryId: string }).trajectoryId,
        });
        return new Response(null, { status: 204 });
      });
    }
    return null;
  };
  gateway = await startFakeGateway({ extraRoutes: route });
  const started = gateway;

  const media: MediaDouble = {
    sessions: [],
    sinks: [],
    screens: [],
    rotated: [],
    stops: 0,
    onStart: null,
    onStop: null,
    stopGate: null,
    finish: null,
    recovered: [],
    onRecover: null,
    discarded: [],
  };
  const h: Harness = {
    gateway: started,
    openbot,
    dbName: `offscreen-index-test-${Date.now()}-${dbCounter++}`,
    clock: virtualClock(),
    log: [],
    media,
    ports: [],
    demonstrations: new Set(),
    listen() {
      chrome.runtime.onConnect.addListener((port) => {
        const entry: ServiceWorkerPort = { port, messages: [] };
        port.onMessage.addListener((message: OffscreenToBackground) => {
          entry.messages.push(message);
        });
        h.ports.push(entry);
      });
    },
    trackFetch() {
      const original = globals.fetch;
      globals.fetch = Object.assign(
        (input: string | URL | Request, init?: RequestInit) => {
          const url =
            input instanceof Request ? input.url : new URL(String(input)).href;
          h.log.push(`fetch ${new URL(url).pathname}`);
          return original(input, init);
        },
        { preconnect: original.preconnect },
      );
    },
    async open(clock = h.clock, extra = {}) {
      const before = h.ports.length;
      createOffscreenController({
        startMedia: async (session, sinks) => {
          // getUserMedia is asynchronous: nothing may reach the network while it runs.
          await sleep(20);
          h.log.push(`getUserMedia ${session.media.tabStreamId}`);
          media.sessions.push(session);
          media.sinks.push(sinks);
          media.onStart?.(sinks);
          return {
            screen: async (tabStreamId) => {
              media.screens.push(tabStreamId);
            },
            rotate: async ({ demonstrationId }) => {
              media.rotated.push(demonstrationId);
            },
            stop: async () => {
              media.stops += 1;
              await media.stopGate?.promise;
              media.onStop?.(sinks);
            },
            finished: () => media.finish?.promise ?? Promise.resolve(),
          };
        },
        recoverMedia: async (drain, target, sinks) => {
          media.recovered.push({ drain, target });
          media.onRecover?.(drain, sinks);
        },
        discardMedia: async (demonstrationId) => {
          media.discarded.push(demonstrationId);
        },
        openOutbox: () => openOutbox(h.dbName),
        connectPort: () => chrome.runtime.connect({ name: PORT_OFFSCREEN }),
        now: clock.now,
        timers: clock.timers,
        ...extra,
      });
      await until(
        () =>
          h.ports.length > before &&
          h.ports.at(-1)?.messages[0]?.type === "offscreen.ready",
        "the document's offscreen.ready",
      );
    },
    post(message) {
      if (
        message.type === "offscreen.start" ||
        message.type === "offscreen.resume"
      )
        h.demonstrations.add(message.session.demonstrationId);
      if (message.type === "offscreen.rotate")
        h.demonstrations.add(message.demonstrationId);
      const newest = h.ports.at(-1);
      if (!newest) throw new Error("No document is connected");
      newest.port.postMessage(message);
    },
    received<T extends OffscreenToBackground["type"]>(type: T) {
      return h.ports
        .flatMap((entry) => entry.messages)
        .filter((message): message is Message<T> => message.type === type);
    },
    latest: () => h.ports.at(-1)?.messages ?? [],
    session(overrides = {}) {
      return {
        demonstrationId: "demo-1",
        title: "File the weekly report",
        botId: "bot-1",
        openbotUrl: started.httpUrl,
        token: "obr_first",
        trajectoryId: crypto.randomUUID(),
        startedAt: 1_700_000_000_000,
        allowedIntelligenceUrls: null,
        version: "0.1.0",
        media: { tabStreamId: "tab-stream-1", microphone: true },
        ...overrides,
      };
    },
    drain(session, overrides = {}) {
      return {
        demonstrationId: session.demonstrationId,
        botId: session.botId,
        title: session.title,
        openbotUrl: session.openbotUrl,
        userId: "user-1",
        userName: "Ada",
        trajectoryIds: [session.trajectoryId],
        startedAt: session.startedAt,
        discard: false,
        ...overrides,
      };
    },
    names: (trajectoryId) =>
      started.events(trajectoryId).map((entry) => entry.name),
    values: (trajectoryId) =>
      started
        .events(trajectoryId)
        .map(
          (entry) => (entry.raw as { value: Record<string, JsonValue> }).value,
        ),
    async pending(trajectoryId) {
      const outbox = await openOutbox(h.dbName);
      return outbox.oldest(trajectoryId, 100_000, Number.MAX_SAFE_INTEGER);
    },
  };
  h.listen();
  harnesses.push(h);
  return h;
}

const click = (i: number): CapturedEvent => ({
  type: "CUSTOM",
  name: "click",
  timestamp: 1_700_000_000_000 + i,
  value: { i },
});
const transcript = (text: string): CapturedEvent => ({
  type: "CUSTOM",
  name: "transcript",
  timestamp: 1_700_000_100_000,
  value: { text },
});

const outcomes = (h: Harness, trajectoryId: string) =>
  h.values(trajectoryId).filter((_, index) => {
    return h.names(trajectoryId)[index] === "outcome";
  });

async function streaming(h: Harness, trajectoryId: string, count = 2) {
  await until(
    () => h.names(trajectoryId).length >= count,
    "the first events at Intelligence",
  );
  await until(
    () =>
      h
        .received("offscreen.status")
        .some(
          (status) =>
            status.trajectoryId === trajectoryId &&
            status.capture.intelligence === "streaming",
        ),
    "a streaming status",
  );
}

/** Row 23: the organization pins its Intelligence addresses, and this one is not among them. */
const NOT_ALLOWED = PASS_HINTS.GATEWAY_NOT_ALLOWED;
/** An organization's pinned Intelligence addresses that leave the fake gateway out. */
const ELSEWHERE = ["wss://intelligence.example.com"];

/** A recording stopped with its events parked; then the next browser start opens a document and OpenBot passes again. */
async function keptThenRestart(h: Harness): Promise<StreamSession> {
  h.openbot.refuse = () => parkedPass();
  await h.open(virtualClock());
  const session = h.session();
  h.post({ type: "offscreen.start", session });
  h.post({ type: "offscreen.event", event: click(1) });
  h.post({ type: "offscreen.stop", outcome: "succeeded" });
  await until(() => h.received("offscreen.kept").length > 0, "kept");
  h.openbot.refuse = null;
  await h.open(virtualClock(NEXT_START));
  return session;
}

/** Counts the WebSockets opened while it is installed; `restore()` puts the global back. */
function countSockets() {
  const original = globalThis.WebSocket;
  const opened: string[] = [];
  globalThis.WebSocket = class extends original {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      opened.push(String(url));
    }
  };
  return {
    opened,
    restore() {
      globalThis.WebSocket = original;
    },
  };
}

beforeEach(() => {
  saved = {
    indexedDB: globals.indexedDB,
    IDBKeyRange: globals.IDBKeyRange,
    fetch: globals.fetch,
  };
  savedVariant = process.env.RECORDER_VARIANT;
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
  fake = installChromeFake();
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    // Every document drops what it holds, so no streamer outlives its test.
    for (const entry of h.ports) {
      try {
        entry.port.postMessage({
          type: "offscreen.discard",
          demonstrationIds: [...h.demonstrations],
        } satisfies BackgroundToOffscreen);
      } catch {
        // That document's port is already gone.
      }
    }
    await sleep(30);
    await h.gateway.stop();
  }
  fake.uninstall();
  if (savedVariant === undefined) delete process.env.RECORDER_VARIANT;
  else process.env.RECORDER_VARIANT = savedVariant;
  if (saved.fetch) globals.fetch = saved.fetch;
  for (const key of ["indexedDB", "IDBKeyRange"] as const) {
    if (saved[key] === undefined) Reflect.deleteProperty(globals, key);
    else Object.assign(globals, { [key]: saved[key] });
  }
});

describe("offscreen controller", () => {
  test("start consumes the tab stream id before any network call", async () => {
    const h = await setup();
    h.trackFetch();
    h.media.onStart = (sinks) => sinks.emit(transcript("before the streamer"));
    await h.open();
    const session = h.session();
    h.post({ type: "offscreen.start", session });
    // Arrives while media starts: held until the streamer exists, then sent in order.
    h.post({ type: "offscreen.event", event: click(1) });

    await until(
      () => h.names(session.trajectoryId).length === 4,
      "the first events",
    );
    expect(h.log[0]).toBe("getUserMedia tab-stream-1");
    expect(h.log.length).toBeGreaterThan(1);
    expect(h.log.slice(1).every((entry) => entry.startsWith("fetch "))).toBe(
      true,
    );
    expect(h.names(session.trajectoryId)).toEqual([
      "recording.started",
      "outcome",
      "click",
      "transcript",
    ]);
  });

  test("stop drains voice, then queues the outcome, then reports stopped, then done after the drain and uploads", async () => {
    const h = await setup();
    h.media.onStop = (sinks) => sinks.emit(transcript("the last words"));
    h.media.finish = makeGate();
    await h.open();
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    await streaming(h, t);
    h.post({ type: "offscreen.event", event: click(1) });
    h.post({ type: "offscreen.event", event: click(2) });
    await until(() => h.names(t).length === 4, "the clicks");

    let queuedWhenStopped: string[] = [];
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(async () => {
      if (h.received("offscreen.stopped").length === 0) return false;
      // An event is at Intelligence, in the outbox, or briefly both: one entry per seq.
      const bySeq = new Map<number, string>();
      for (const entry of h.gateway.events(t)) bySeq.set(entry.seq, entry.name);
      for (const item of await h.pending(t))
        bySeq.set(item.seq, item.event.name);
      queuedWhenStopped = [...bySeq.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, name]) => name);
      return true;
    }, "offscreen.stopped");
    // Stopped is reported only once the outcome is queued, after the last transcript.
    expect(queuedWhenStopped.slice(-2)).toEqual(["transcript", "outcome"]);
    expect(h.received("offscreen.stopped")).toEqual([
      {
        type: "offscreen.stopped",
        demonstrationId: "demo-1",
        trajectoryIds: [t],
      },
    ]);

    await until(
      () => h.openbot.closed.some((entry) => entry.trajectoryId === t),
      "the trajectory closed",
    );
    expect(h.names(t)).toEqual([
      "recording.started",
      "outcome",
      "click",
      "click",
      "transcript",
      "outcome",
    ]);
    expect(outcomes(h, t).at(-1)).toMatchObject({ phase: "succeeded" });
    expect(h.openbot.closed).toEqual([
      { demonstrationId: "demo-1", trajectoryId: t },
    ]);
    // Drained and closed, but the uploads are still going: no done yet.
    await sleep(50);
    expect(h.received("offscreen.done")).toEqual([]);

    h.media.finish.release();
    await until(
      () => h.received("offscreen.done").length === 1,
      "offscreen.done",
    );
    const types = h.latest().map((message) => message.type);
    expect(types.indexOf("offscreen.stopped")).toBeLessThan(
      types.indexOf("offscreen.done"),
    );
    expect(h.received("offscreen.done")).toEqual([
      { type: "offscreen.done", demonstrationId: "demo-1" },
    ]);
    expect(h.media.stops).toBe(1);
  });

  test("stop still stops the screen and voice, and reports stopped and done, when the streamer never started", async () => {
    const h = await setup();
    await h.open(h.clock, {
      openOutbox: async () => {
        throw new Error("IndexedDB could not be opened");
      },
    });
    const session = h.session();
    h.post({ type: "offscreen.start", session });
    await until(() => h.media.sessions.length === 1, "the media starting");
    // Let the failed streamer start settle before Stop arrives.
    await sleep(100);

    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(
      () => h.received("offscreen.done").length === 1,
      "offscreen.done",
    );
    expect(h.media.stops).toBe(1);
    expect(h.received("offscreen.stopped")).toEqual([
      {
        type: "offscreen.stopped",
        demonstrationId: "demo-1",
        trajectoryIds: [],
      },
    ]);
    expect(h.received("offscreen.done")).toEqual([
      { type: "offscreen.done", demonstrationId: "demo-1" },
    ]);
    const types = h.latest().map((message) => message.type);
    expect(types.indexOf("offscreen.stopped")).toBeLessThan(
      types.indexOf("offscreen.done"),
    );
  });

  test("a new Record's media starts at once, even while the last Stop still drains voice", async () => {
    const h = await setup();
    h.media.stopGate = makeGate();
    await h.open();
    const first = h.session();
    h.post({ type: "offscreen.start", session: first });
    await streaming(h, first.trajectoryId);
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(() => h.media.stops === 1, "the first recording stopping");

    const second = h.session({
      demonstrationId: "demo-2",
      media: { tabStreamId: "tab-stream-2", microphone: false },
    });
    h.post({ type: "offscreen.start", session: second });
    await until(
      () => h.media.sessions.length === 2,
      "the second recording's media",
    );
    expect(h.log).toContain("getUserMedia tab-stream-2");
    expect(h.received("offscreen.stopped")).toEqual([]);

    h.media.stopGate.release();
    await until(
      () => h.received("offscreen.stopped").length === 1,
      "the first recording stopped",
    );
    await streaming(h, second.trajectoryId);
    expect(outcomes(h, first.trajectoryId).at(-1)).toMatchObject({
      phase: "succeeded",
    });
  });

  test("resume restarts the streamer over the existing outbox", async () => {
    const h = await setup();
    // The first document cannot reach Intelligence, so its events wait in the outbox.
    h.openbot.refuse = () => parkedPass();
    await h.open(virtualClock());
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    for (let i = 0; i < 5; i++)
      h.post({ type: "offscreen.event", event: click(i) });
    await until(
      async () => (await h.pending(t)).length === 7,
      "the events queued",
    );

    // The service worker restarted and found no document: a new one resumes the same session.
    h.openbot.refuse = null;
    await h.open(virtualClock(NEXT_START));
    h.post({ type: "offscreen.resume", session });
    await until(() => h.names(t).length === 7, "the queued events sent");
    await until(
      async () => (await h.pending(t)).length === 0,
      "an empty outbox",
    );

    expect(h.names(t)).toEqual([
      "recording.started",
      "outcome",
      "click",
      "click",
      "click",
      "click",
      "click",
    ]);
    expect(h.media.sessions.at(-1)?.media).toEqual({
      tabStreamId: null,
      microphone: true,
    });
  });

  test("a second stop for an already stopped demonstration only re-posts stopped", async () => {
    const h = await setup();
    await h.open();
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    await streaming(h, t);
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(() => h.received("offscreen.done").length === 1, "done");

    // The service worker restarted mid-Stop and asks again.
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(
      () => h.received("offscreen.stopped").length === 2,
      "stopped again",
    );
    await sleep(50);
    expect(h.received("offscreen.stopped")).toEqual([
      {
        type: "offscreen.stopped",
        demonstrationId: "demo-1",
        trajectoryIds: [t],
      },
      {
        type: "offscreen.stopped",
        demonstrationId: "demo-1",
        trajectoryIds: [t],
      },
    ]);
    expect(h.media.stops).toBe(1);
    expect(outcomes(h, t).map((value) => value.phase)).toEqual([
      "started",
      "succeeded",
    ]);
    expect(h.received("offscreen.done")).toHaveLength(1);
  });

  test("stop passes stoppedFrom to the outcome", async () => {
    const h = await setup();
    await h.open();
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    await streaming(h, t);
    h.post({
      type: "offscreen.stop",
      outcome: "succeeded",
      stoppedFrom: "openbot",
    });
    await until(() => h.received("offscreen.done").length === 1, "done");
    expect(outcomes(h, t).at(-1)).toMatchObject({
      workflow: "File the weekly report",
      phase: "succeeded",
      stoppedFrom: "openbot",
    });
  });

  test("a heartbeat is posted every 30 s while recording and stops at stop", async () => {
    const h = await setup();
    await h.open();
    const session = h.session();
    h.post({ type: "offscreen.start", session });
    await streaming(h, session.trajectoryId);
    expect(h.received("offscreen.heartbeat")).toHaveLength(0);

    await h.clock.advance(29_999);
    expect(h.received("offscreen.heartbeat")).toHaveLength(0);
    await h.clock.advance(1);
    await until(
      () => h.received("offscreen.heartbeat").length === 1,
      "the first heartbeat",
    );
    await h.clock.advance(30_000);
    await until(
      () => h.received("offscreen.heartbeat").length === 2,
      "the second heartbeat",
    );

    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(() => h.received("offscreen.stopped").length === 1, "stopped");
    await h.clock.advance(3 * MINUTE);
    await sleep(20);
    expect(h.received("offscreen.heartbeat")).toHaveLength(2);
  });

  test("a stopped recording whose events are kept posts offscreen.kept, and a later recover drains it and posts done", async () => {
    const h = await setup();
    h.openbot.refuse = () => parkedPass();
    await h.open(virtualClock());
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    for (let i = 0; i < 3; i++)
      h.post({ type: "offscreen.event", event: click(i) });
    await until(
      () =>
        h
          .received("offscreen.status")
          .some(
            (status) =>
              status.trajectoryId === t &&
              status.capture.intelligence === "parked" &&
              status.capture.intelligenceReason === PARKED &&
              typeof status.capture.events?.pending === "number",
          ),
      "a parked status with the kept count",
    );
    await until(
      async () => (await h.pending(t)).length === 5,
      "every event kept",
    );
    // While it still records, the status says it, not offscreen.kept.
    expect(h.received("offscreen.kept")).toEqual([]);

    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(() => h.received("offscreen.kept").length > 0, "kept");
    expect(h.received("offscreen.kept").at(-1)).toEqual({
      type: "offscreen.kept",
      demonstrationId: "demo-1",
      reason: PARKED,
      parked: true,
      events: 6,
    });
    expect(h.received("offscreen.done")).toEqual([]);

    // The next browser start: a new document recovers the kept recording.
    h.openbot.refuse = null;
    await h.open(virtualClock(NEXT_START));
    h.post({
      type: "offscreen.recover",
      openbotUrl: session.openbotUrl,
      token: session.token,
      allowedIntelligenceUrls: null,
      drains: [h.drain(session)],
    });
    await until(() => h.received("offscreen.done").length === 1, "done");
    expect(h.received("offscreen.done")).toEqual([
      { type: "offscreen.done", demonstrationId: "demo-1" },
    ]);
    expect(h.names(t)).toEqual([
      "recording.started",
      "outcome",
      "click",
      "click",
      "click",
      "outcome",
    ]);
    expect(outcomes(h, t).at(-1)).toMatchObject({ phase: "succeeded" });
    expect(
      h.media.recovered.map((entry) => entry.drain.demonstrationId),
    ).toEqual(["demo-1"]);
  });

  test("every pass names the recording's Bot, for the live recording and for a recovered one", async () => {
    const h = await setup();
    h.openbot.refuse = () => parkedPass();
    await h.open(virtualClock());
    const session = h.session({ botId: "bot-live" });
    h.post({ type: "offscreen.start", session });
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(() => h.received("offscreen.kept").length > 0, "kept");
    expect(h.openbot.passes.map((pass) => pass.bot)).toEqual(["bot-live"]);

    h.openbot.refuse = null;
    await h.open(virtualClock(NEXT_START));
    h.post({
      type: "offscreen.recover",
      openbotUrl: session.openbotUrl,
      token: session.token,
      allowedIntelligenceUrls: null,
      drains: [{ ...h.drain(session), botId: "bot-kept" }],
    });
    await until(() => h.received("offscreen.done").length === 1, "done");
    expect(h.openbot.passes.slice(1).map((pass) => pass.bot)).toEqual(
      h.openbot.passes.slice(1).map(() => "bot-kept"),
    );
    expect(h.openbot.passes.length).toBeGreaterThan(1);
  });

  test("recover drains a stopped recording's outbox before reporting done, and adds an interrupted outcome only when none was queued", async () => {
    const h = await setup();
    h.openbot.refuse = () => parkedPass();
    await h.open(virtualClock());
    const stopped = h.session({ demonstrationId: "demo-stopped" });
    h.post({ type: "offscreen.start", session: stopped });
    h.post({ type: "offscreen.event", event: click(1) });
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(
      () => h.received("offscreen.kept").length > 0,
      "the stopped recording kept",
    );
    // Then the browser crashed during the next recording.
    const interrupted = h.session({ demonstrationId: "demo-interrupted" });
    h.post({ type: "offscreen.start", session: interrupted });
    h.post({ type: "offscreen.event", event: click(2) });
    h.post({ type: "offscreen.event", event: click(3) });
    await until(
      async () => (await h.pending(interrupted.trajectoryId)).length === 4,
      "the interrupted recording's events queued",
    );

    h.openbot.refuse = null;
    h.media.onRecover = (drain, sinks) => {
      if (drain.demonstrationId === "demo-interrupted")
        sinks.emit(transcript("buffered voice"));
    };
    await h.open(virtualClock(NEXT_START));
    const atDone = new Map<string, string[]>();
    const recovering = h.ports.at(-1);
    if (!recovering) throw new Error("No document");
    recovering.port.onMessage.addListener((message: OffscreenToBackground) => {
      if (message.type !== "offscreen.done") return;
      const t =
        message.demonstrationId === "demo-stopped"
          ? stopped.trajectoryId
          : interrupted.trajectoryId;
      atDone.set(message.demonstrationId, h.names(t));
    });
    h.post({
      type: "offscreen.recover",
      openbotUrl: stopped.openbotUrl,
      token: stopped.token,
      allowedIntelligenceUrls: null,
      drains: [h.drain(stopped), h.drain(interrupted)],
    });
    await until(() => atDone.size === 2, "done for both recordings");

    const stoppedNames = ["recording.started", "outcome", "click", "outcome"];
    const interruptedNames = [
      "recording.started",
      "outcome",
      "click",
      "click",
      "transcript",
      "outcome",
    ];
    // Everything had reached Intelligence before each done was posted.
    expect(atDone.get("demo-stopped")).toEqual(stoppedNames);
    expect(atDone.get("demo-interrupted")).toEqual(interruptedNames);
    expect(
      outcomes(h, stopped.trajectoryId).map((value) => value.phase),
    ).toEqual(["started", "succeeded"]);
    expect(outcomes(h, interrupted.trajectoryId).at(-1)).toEqual(
      expect.objectContaining({
        workflow: "File the weekly report",
        phase: "failed",
        reason: "interrupted",
      }),
    );
    expect(h.openbot.closed.map((entry) => entry.trajectoryId).sort()).toEqual(
      [stopped.trajectoryId, interrupted.trajectoryId].sort(),
    );
  });

  test("a recover whose pinned Intelligence addresses leave the gateway out opens no socket and keeps the recording parked", async () => {
    const h = await setup();
    const session = await keptThenRestart(h);
    const t = session.trajectoryId;
    const passes = h.openbot.passes.length;
    const kept = h.received("offscreen.kept").length;
    const sockets = countSockets();
    try {
      // A fresh document after a browser start: no Record has told it any policy.
      h.post({
        type: "offscreen.recover",
        openbotUrl: session.openbotUrl,
        token: session.token,
        allowedIntelligenceUrls: ELSEWHERE,
        drains: [h.drain(session)],
      });
      await until(
        () =>
          h
            .received("offscreen.kept")
            .slice(kept)
            .some((report) => report.reason === NOT_ALLOWED),
        "kept as not allowed",
      );
      await sleep(50);
      expect(h.received("offscreen.kept").at(-1)).toEqual({
        type: "offscreen.kept",
        demonstrationId: "demo-1",
        reason: NOT_ALLOWED,
        parked: true,
        events: 4,
      });
      expect(h.openbot.passes.length).toBeGreaterThan(passes);
      expect(sockets.opened).toEqual([]);
      expect(h.gateway.joins).toEqual([]);
      expect(h.names(t)).toEqual([]);
      expect(await h.pending(t)).toHaveLength(4);
      expect(h.received("offscreen.done")).toEqual([]);
    } finally {
      sockets.restore();
    }
  });

  test("a recover whose pinned Intelligence addresses include the gateway streams, whatever the live recording's policy", async () => {
    const h = await setup();
    const session = await keptThenRestart(h);
    const t = session.trajectoryId;
    const live = h.session({
      demonstrationId: "demo-live",
      allowedIntelligenceUrls: ELSEWHERE,
    });
    h.post({ type: "offscreen.start", session: live });
    await until(
      () =>
        h
          .received("offscreen.status")
          .some(
            (status) =>
              status.trajectoryId === live.trajectoryId &&
              status.capture.intelligenceReason === NOT_ALLOWED,
          ),
      "the live recording parked by its own policy",
    );
    const sockets = countSockets();
    try {
      h.post({
        type: "offscreen.recover",
        openbotUrl: session.openbotUrl,
        token: session.token,
        allowedIntelligenceUrls: [h.gateway.url],
        drains: [h.drain(session)],
      });
      await until(
        () =>
          h
            .received("offscreen.done")
            .some((done) => done.demonstrationId === "demo-1"),
        "done for the recovered recording",
      );
      expect(sockets.opened.length).toBeGreaterThan(0);
      expect(h.names(t)).toEqual([
        "recording.started",
        "outcome",
        "click",
        "outcome",
      ]);
      expect(h.names(live.trajectoryId)).toEqual([]);
    } finally {
      sockets.restore();
    }
  });

  test("a recover with no pinned Intelligence addresses streams, whatever the live recording's policy", async () => {
    const h = await setup();
    const session = await keptThenRestart(h);
    const t = session.trajectoryId;
    const live = h.session({
      demonstrationId: "demo-live",
      allowedIntelligenceUrls: ELSEWHERE,
    });
    h.post({ type: "offscreen.start", session: live });
    await until(
      () =>
        h
          .received("offscreen.status")
          .some(
            (status) =>
              status.trajectoryId === live.trajectoryId &&
              status.capture.intelligenceReason === NOT_ALLOWED,
          ),
      "the live recording parked by its own policy",
    );
    const sockets = countSockets();
    try {
      h.post({
        type: "offscreen.recover",
        openbotUrl: session.openbotUrl,
        token: session.token,
        allowedIntelligenceUrls: null,
        drains: [h.drain(session)],
      });
      await until(
        () =>
          h
            .received("offscreen.done")
            .some((done) => done.demonstrationId === "demo-1"),
        "done for the recovered recording",
      );
      expect(sockets.opened.length).toBeGreaterThan(0);
      expect(h.names(t)).toEqual([
        "recording.started",
        "outcome",
        "click",
        "outcome",
      ]);
      expect(h.names(live.trajectoryId)).toEqual([]);
    } finally {
      sockets.restore();
    }
  });

  test("recover leaves a recording this document already streams to its own streamer", async () => {
    const h = await setup();
    h.media.finish = makeGate();
    await h.open();
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    await streaming(h, t);
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(() => h.received("offscreen.stopped").length === 1, "stopped");
    const passes = h.openbot.passes.length;

    // The person connected again while its uploads still ran: the service worker posts every drain they own.
    h.post({
      type: "offscreen.recover",
      openbotUrl: session.openbotUrl,
      token: "obr_second",
      allowedIntelligenceUrls: null,
      drains: [h.drain(session)],
    });
    await sleep(100);
    h.media.finish.release();
    await until(() => h.received("offscreen.done").length === 1, "done");
    await sleep(50);

    expect(h.media.recovered).toEqual([]);
    expect(h.openbot.passes).toHaveLength(passes);
    expect(outcomes(h, t).map((value) => value.phase)).toEqual([
      "started",
      "succeeded",
    ]);
    expect(h.received("offscreen.done")).toHaveLength(1);
  });

  test("a recording OpenBot no longer knows still reports done once its events are sent", async () => {
    const h = await setup();
    // A Record that could not start: the service worker stops it, then deletes it in OpenBot.
    h.openbot.closeAnswer = () =>
      Response.json({ error: "Demonstration not found." }, { status: 404 });
    await h.open();
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    await streaming(h, t);
    h.post({ type: "offscreen.stop", outcome: "failed" });
    await until(() => h.received("offscreen.done").length === 1, "done");
    expect(h.openbot.closed).toEqual([
      { demonstrationId: "demo-1", trajectoryId: t },
    ]);
    expect(outcomes(h, t).at(-1)).toMatchObject({ phase: "failed" });
  });

  test("discard clears a recording's events, and is posted only for the person's own discard or disconnect", async () => {
    const h = await setup();
    h.openbot.refuse = () => parkedPass();
    await h.open();
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    h.post({ type: "offscreen.event", event: click(1) });
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(() => h.received("offscreen.kept").length > 0, "kept");
    await h.clock.advance(30 * MINUTE);
    // Nothing was cleared on its own: the kept events wait for the person.
    expect(await h.pending(t)).toHaveLength(4);
    expect(h.media.discarded).toEqual([]);

    h.post({ type: "offscreen.discard", demonstrationIds: ["demo-1"] });
    await until(() => h.received("offscreen.done").length === 1, "done");
    expect(h.received("offscreen.done")).toEqual([
      { type: "offscreen.done", demonstrationId: "demo-1" },
    ]);
    expect(await h.pending(t)).toEqual([]);
    const outbox = await openOutbox(h.dbName);
    expect(await outbox.getMeta(trajectoryMetaKey(t))).toBeUndefined();
    expect(await outbox.trajectories()).not.toContain(t);
    expect(h.media.discarded).toEqual(["demo-1"]);
  });

  test("discarding a replaced recording's kept events leaves the recording that replaced it streaming", async () => {
    const h = await setup();
    const first = h.session();
    h.openbot.refuse = (trajectoryId) =>
      trajectoryId === first.trajectoryId ? parkedPass() : null;
    await h.open();
    h.post({ type: "offscreen.start", session: first });
    h.post({ type: "offscreen.event", event: click(1) });
    await until(
      async () => (await h.pending(first.trajectoryId)).length === 3,
      "the first recording's events queued",
    );

    // Start over: the replaced recording's events stay parked, so it reports them kept.
    const second = crypto.randomUUID();
    h.post({
      type: "offscreen.rotate",
      demonstrationId: "demo-2",
      trajectoryId: second,
    });
    await until(
      () =>
        h
          .received("offscreen.kept")
          .some((kept) => kept.demonstrationId === "demo-1"),
      "the replaced recording kept",
    );
    await streaming(h, second);

    h.post({ type: "offscreen.discard", demonstrationIds: ["demo-1"] });
    await until(
      () =>
        h
          .received("offscreen.done")
          .some((done) => done.demonstrationId === "demo-1"),
      "done for the discarded recording",
    );
    expect(await h.pending(first.trajectoryId)).toEqual([]);
    expect(h.media.discarded).toEqual(["demo-1"]);

    h.post({ type: "offscreen.event", event: click(2) });
    await until(
      () => h.names(second).includes("click"),
      "the new recording still streaming",
    );
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(
      () =>
        h
          .received("offscreen.done")
          .some((done) => done.demonstrationId === "demo-2"),
      "done for the new recording",
    );
    expect(h.names(second)).toEqual([
      "recording.started",
      "outcome",
      "click",
      "outcome",
    ]);
  });

  test("a signed-out pass stops sending and keeps the outbox, media chunks and voice slices, and a recover with a new token sends them", async () => {
    const h = await setup();
    h.openbot.passScript.push(signedOutPass("removed"));
    await h.open();
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    await until(
      () => h.received("offscreen.signed-out").length === 1,
      "signed out",
    );
    expect(h.received("offscreen.signed-out")).toEqual([
      { type: "offscreen.signed-out", reason: "removed", token: "obr_first" },
    ]);

    for (let i = 0; i < 3; i++)
      h.post({ type: "offscreen.event", event: click(i) });
    await until(
      async () => (await h.pending(t)).length === 5,
      "the events kept",
    );
    await h.clock.advance(30 * MINUTE);
    await sleep(30);
    // Nothing more goes out, and nothing is thrown away.
    expect(h.openbot.passes).toHaveLength(1);
    expect(h.names(t)).toEqual([]);
    expect(await h.pending(t)).toHaveLength(5);
    expect(h.media.discarded).toEqual([]);
    expect(h.media.stops).toBe(0);
    expect(h.received("offscreen.signed-out")).toHaveLength(1);

    // The service worker stops the recording it was signed out of; it waits for its person.
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(() => h.received("offscreen.stopped").length === 1, "stopped");
    await sleep(30);
    expect(h.received("offscreen.done")).toEqual([]);

    // The same person connects this browser again.
    const statuses = h.received("offscreen.status").length;
    h.post({
      type: "offscreen.recover",
      openbotUrl: session.openbotUrl,
      token: "obr_second",
      allowedIntelligenceUrls: null,
      drains: [h.drain(session)],
    });
    await until(() => h.received("offscreen.done").length === 1, "done");
    // A recovery's streamer reports no status: only the live recording's streamer does.
    expect(h.received("offscreen.status")).toHaveLength(statuses);
    expect(h.names(t)).toEqual([
      "recording.started",
      "outcome",
      "click",
      "click",
      "click",
      "outcome",
    ]);
    expect(h.openbot.passes.slice(1).map((pass) => pass.authorization)).toEqual(
      h.openbot.passes.slice(1).map(() => "Bearer obr_second"),
    );
    expect(h.openbot.passes.length).toBeGreaterThan(1);
    expect(h.media.recovered.map((entry) => entry.target)).toEqual([
      { openbotUrl: session.openbotUrl, token: "obr_second" },
    ]);
  });

  test("a sign-out stops every recording sent with its token, and is posted once", async () => {
    const h = await setup();
    const first = h.session({ demonstrationId: "demo-held" });
    h.openbot.refuse = (trajectoryId) =>
      trajectoryId === first.trajectoryId ? heldPass() : null;
    await h.open();
    h.post({ type: "offscreen.start", session: first });
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(
      () => h.received("offscreen.kept").length > 0,
      "the first recording held",
    );
    expect(h.received("offscreen.kept").at(-1)).toMatchObject({
      demonstrationId: "demo-held",
      parked: false,
    });

    // The next recording, on the same connection, hears that the connection is gone.
    h.openbot.passScript.push(signedOutPass("revoked"));
    const second = h.session({ demonstrationId: "demo-next" });
    h.post({ type: "offscreen.start", session: second });
    await until(
      () => h.received("offscreen.signed-out").length === 1,
      "signed out",
    );
    const passes = h.openbot.passes.length;
    h.openbot.refuse = null;

    // The held recording tries again with the same token: the attempt never reaches OpenBot.
    await h.clock.advance(10 * MINUTE);
    await sleep(50);
    expect(h.openbot.passes).toHaveLength(passes);
    expect(h.names(first.trajectoryId)).toEqual([]);
    expect(await h.pending(first.trajectoryId)).toHaveLength(3);
    expect(h.received("offscreen.signed-out")).toEqual([
      { type: "offscreen.signed-out", reason: "revoked", token: "obr_first" },
    ]);
  });

  test("in the e2e build, session.e2eHoldRetryMs becomes the hold interval; in a release build it is ignored", async () => {
    process.env.RECORDER_VARIANT = "e2e";
    const e2e = await setup();
    e2e.openbot.passScript.push(heldPass);
    await e2e.open();
    const first = e2e.session({ e2eHoldRetryMs: 2_000 });
    e2e.post({ type: "offscreen.start", session: first });
    await until(
      () =>
        e2e
          .received("offscreen.status")
          .some((status) => status.capture.intelligence === "held"),
      "held",
    );
    expect(e2e.openbot.passes).toHaveLength(1);
    await e2e.clock.advance(2_000);
    await streaming(e2e, first.trajectoryId);
    expect(e2e.openbot.passes).toHaveLength(2);

    process.env.RECORDER_VARIANT = "release";
    const release = await setup();
    release.openbot.passScript.push(heldPass);
    await release.open();
    const second = release.session({ e2eHoldRetryMs: 2_000 });
    release.post({ type: "offscreen.start", session: second });
    await until(
      () =>
        release
          .received("offscreen.status")
          .some((status) => status.capture.intelligence === "held"),
      "held",
    );
    await release.clock.advance(2_000);
    await sleep(50);
    expect(release.openbot.passes).toHaveLength(1);
    await release.clock.advance(5 * MINUTE - 2_000);
    await streaming(release, second.trajectoryId);
    expect(release.openbot.passes).toHaveLength(2);
  });

  test("a disconnected port is reconnected and the last status re-sent", async () => {
    const h = await setup();
    h.media.finish = makeGate();
    await h.open();
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    await streaming(h, t);
    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(() => h.received("offscreen.stopped").length === 1, "stopped");
    await until(
      () => h.openbot.closed.some((entry) => entry.trajectoryId === t),
      "the trajectory closed",
    );
    const lastStatus = h.received("offscreen.status").at(-1);

    // The service worker restarts while the uploads finish: done cannot be delivered yet.
    fake.restartServiceWorker();
    h.media.finish.release();
    await sleep(30);
    const connects = () =>
      fake.calls.filter((call) => call === "runtime.connect").length;
    const before = connects();

    // The restarted worker has not registered its listener yet: the first attempt fails.
    await h.clock.advance(500);
    await until(() => connects() === before + 1, "the first reconnect attempt");
    await h.clock.advance(999);
    expect(connects()).toBe(before + 1);
    h.listen();
    await h.clock.advance(1);
    await until(
      () => (h.ports.at(-1)?.messages.length ?? 0) >= 3 && h.ports.length === 2,
      "the reconnected port's messages",
    );
    const resent = h.ports[1].messages;
    expect(resent[0]).toEqual({ type: "offscreen.ready" });
    expect(resent[1]).toEqual({
      type: "offscreen.status",
      capture: expect.objectContaining({
        intelligence: lastStatus?.capture.intelligence,
      }),
      trajectoryId: t,
    });
    expect(resent[2]).toEqual({
      type: "offscreen.done",
      demonstrationId: "demo-1",
    });
    expect(h.received("offscreen.done")).toHaveLength(1);
  });

  test("messages in, statuses out", async () => {
    const h = await setup();
    await h.open(h.clock, { rolloverAt: 4 });
    expect(h.latest()[0]).toEqual({ type: "offscreen.ready" });
    const session = h.session();
    const t = session.trajectoryId;
    h.post({ type: "offscreen.start", session });
    await streaming(h, t);
    expect(h.received("offscreen.status")[0]).toMatchObject({
      trajectoryId: t,
      capture: { intelligence: "connecting" },
    });

    // Media reports through the same status message, for the live trajectory.
    h.media.sinks[0].status({ voice: "recording" });
    h.post({ type: "offscreen.screen", tabStreamId: "tab-stream-2" });
    await until(
      () =>
        h
          .received("offscreen.status")
          .some((status) => status.capture.voice === "recording"),
      "the media status",
    );
    expect(
      h
        .received("offscreen.status")
        .find((status) => status.capture.voice === "recording"),
    ).toEqual({
      type: "offscreen.status",
      capture: { voice: "recording" },
      trajectoryId: t,
    });
    await until(() => h.media.screens.length === 1, "the late screen");
    expect(h.media.screens).toEqual(["tab-stream-2"]);

    // A long recording rolls over: the new trajectory is reported with its recording.
    for (let i = 0; i < 3; i++)
      h.post({ type: "offscreen.event", event: click(i) });
    await until(
      () => h.received("offscreen.trajectory").length === 1,
      "offscreen.trajectory",
    );
    const [rolled] = h.received("offscreen.trajectory");
    expect(rolled).toEqual({
      type: "offscreen.trajectory",
      demonstrationId: "demo-1",
      trajectoryId: expect.any(String),
    });
    expect(h.openbot.registered).toEqual([
      { demonstrationId: "demo-1", trajectoryId: rolled.trajectoryId },
    ]);
    await until(
      () => h.names(rolled.trajectoryId).includes("click"),
      "the rolled-over trajectory streaming",
    );

    // Start over.
    const next = crypto.randomUUID();
    h.post({
      type: "offscreen.rotate",
      demonstrationId: "demo-2",
      trajectoryId: next,
    });
    await until(
      () => h.received("offscreen.rotated").length === 1,
      "offscreen.rotated",
    );
    expect(h.received("offscreen.rotated")).toEqual([
      { type: "offscreen.rotated", previousDemonstrationId: "demo-1" },
    ]);
    await until(
      () =>
        h
          .received("offscreen.done")
          .some((done) => done.demonstrationId === "demo-1"),
      "done for the replaced recording",
    );
    expect(h.media.rotated).toEqual(["demo-2"]);
    expect(outcomes(h, rolled.trajectoryId).at(-1)).toMatchObject({
      phase: "failed",
    });
    await streaming(h, next);
    expect(h.values(next)[0]).toMatchObject({ demonstrationId: "demo-2" });

    h.post({ type: "offscreen.stop", outcome: "succeeded" });
    await until(
      () =>
        h
          .received("offscreen.done")
          .some((done) => done.demonstrationId === "demo-2"),
      "done for the new recording",
    );
    expect(h.received("offscreen.stopped")).toEqual([
      {
        type: "offscreen.stopped",
        demonstrationId: "demo-2",
        trajectoryIds: [next],
      },
    ]);

    // A pass refused for a signed-out connection names the guard's reason and the token it used.
    h.openbot.passScript.push(signedOutPass("organization"));
    const later = h.session({
      demonstrationId: "demo-3",
      token: "obr_later",
    });
    h.post({ type: "offscreen.start", session: later });
    await until(
      () => h.received("offscreen.signed-out").length === 1,
      "offscreen.signed-out",
    );
    expect(h.received("offscreen.signed-out")).toEqual([
      {
        type: "offscreen.signed-out",
        reason: "organization",
        token: "obr_later",
      },
    ]);
  });
});
