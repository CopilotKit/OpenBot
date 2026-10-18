import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  RECORDER_SIGNED_OUT,
  type TrajectoryGrant,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import type {
  CapturedEvent,
  JsonValue,
} from "@openbot/shared/recorder-masking";
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from "fake-indexeddb";
import {
  classifyGrantError,
  GrantError,
  type GrantVerdict,
  PASS_HINTS,
} from "../src/offscreen/grant";
import { type Outbox, openOutbox } from "../src/offscreen/outbox";
import {
  type ChannelLike,
  createPhoenixSession,
  type PhoenixLike,
  type PushLike,
} from "../src/offscreen/phoenix-session";
import {
  createStreamer,
  type KeptReport,
  type Streamer,
  type StreamerDeps,
  type StreamerSession,
  type StreamerStatus,
} from "../src/offscreen/streamer";
import { type FakeGateway, startFakeGateway } from "./support/fake-gateway";

// The table's sentences, pinned here as the person reads them.
const BUSY = "Intelligence is busy or unreachable. Retrying; nothing is lost.";
const ENTITLEMENT =
  "Intelligence could not confirm this organization's licence (entitlement_unavailable). Retrying; nothing is lost.";
const MARKETPLACE =
  "Intelligence needs its marketplace licence before it can capture. Retrying; nothing is lost.";
const GATEWAY_OFF =
  "Learning capture is off: the Intelligence gateway has trajectory capture turned off.";
const PASS_REFUSED =
  "Learning capture is off: Intelligence refused the capture pass.";
const NOT_ENABLED =
  "Learning capture is paused: Intelligence says this organization's licence does not include Product Trajectories, or that its billing is blocked.";
const MESSAGES_REFUSED =
  "Learning capture is off: Intelligence refused the recorder's messages.";
const CHECK_ORIGIN = `Intelligence refused the connection. If it sets CHECK_ORIGIN, that list must include chrome-extension://${RECORDER_EXTENSION_ID}.`;

const MINUTE = 60_000;

type IndexedDbGlobals = {
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof FakeIDBKeyRange;
};
const globals = globalThis as unknown as IndexedDbGlobals;
let savedIndexedDb: IndexedDbGlobals = {};

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

/** Fake timers and a fake clock for the streamer; the network and IndexedDB stay real, so each step lets them run. */
function virtualClock() {
  let time = 1_800_000_000_000;
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
    /** Pending timers, as delays from now. */
    delays: () => [...pending.values()].map((timer) => timer.at - time),
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

/** A PhoenixLike whose join answers as scripted, for what the fake gateway cannot do (a join that never answers). */
class ScriptedPhoenix implements PhoenixLike {
  connectCalls = 0;
  disconnected = false;
  left = false;
  offSocketRefs: string[] = [];
  offChannel: [string, number][] = [];
  private socketHandlers = new Map<
    string,
    { kind: "open" | "error" | "close"; callback: (value?: unknown) => void }
  >();
  private channelHandlers = new Map<
    number,
    { event: string; callback: (payload: unknown) => void }
  >();
  private nextRef = 0;

  constructor(readonly join: "silent" | "ok") {}

  connect = () => {
    this.connectCalls += 1;
    for (const handler of this.socketHandlers.values())
      if (handler.kind === "open") handler.callback();
  };
  disconnect() {
    this.disconnected = true;
  }
  channel(_topic: string): ChannelLike {
    const silent: PushLike = { receive: () => silent };
    return {
      join: () => {
        const hooks: { status: string; callback: (r?: unknown) => void }[] = [];
        const push: PushLike = {
          receive: (status, callback) => {
            hooks.push({ status, callback });
            return push;
          },
        };
        if (this.join === "ok") {
          queueMicrotask(() => {
            for (const hook of hooks)
              if (hook.status === "ok") hook.callback({});
          });
        }
        return push;
      },
      push: () => silent,
      leave: () => {
        this.left = true;
      },
      on: (event, callback) => this.bind(event, callback),
      off: (event, ref) => {
        this.offChannel.push([event, ref]);
        this.channelHandlers.delete(ref);
      },
      onError: (callback) => this.bind("phx_error", callback),
      onClose: (callback) => this.bind("phx_close", callback),
    };
  }
  onOpen(callback: () => void) {
    return this.bindSocket("open", callback);
  }
  onError(callback: (error: unknown) => void) {
    return this.bindSocket("error", callback);
  }
  onClose(callback: (event: { code?: number } | undefined) => void) {
    return this.bindSocket("close", (event) =>
      callback(event as { code?: number } | undefined),
    );
  }
  off(refs: string[]) {
    this.offSocketRefs.push(...refs);
    for (const ref of refs) this.socketHandlers.delete(ref);
  }
  /** What phoenix.js does on a transport error: the socket's error callbacks, then a transport error on the channel. */
  failTransport() {
    for (const handler of [...this.socketHandlers.values()])
      if (handler.kind === "error") handler.callback(new Error("gone"));
    this.fireChannel("phx_error", {
      source: "transport",
      reason: "connection_error",
    });
    this.fireChannel("phx_error", { reason: "channel crashed" });
  }
  fireChannel(event: string, payload: unknown) {
    for (const handler of [...this.channelHandlers.values()])
      if (handler.event === event) handler.callback(payload);
  }
  get boundChannelHandlers() {
    return this.channelHandlers.size;
  }
  private bind(event: string, callback: (payload: unknown) => void) {
    const ref = this.nextRef++;
    this.channelHandlers.set(ref, { event, callback });
    return ref;
  }
  private bindSocket(
    kind: "open" | "error" | "close",
    callback: (value?: unknown) => void,
  ) {
    const ref = `${kind}-${this.nextRef++}`;
    this.socketHandlers.set(ref, { kind, callback });
    return ref;
  }
}

type Harness = {
  gateway: FakeGateway;
  clock: Clock;
  outbox: Outbox;
  dbName: string;
  grants: string[];
  tokens: string[];
  passScript: GrantVerdict[];
  gate: { promise: Promise<void>; release(): void } | null;
  beforeSocket: (() => void) | null;
  scripted: ScriptedPhoenix[];
  factoryCalls: number;
  sockets: WebSocket[];
  socketUrls: string[];
  statuses: { at: number; status: StreamerStatus }[];
  kept: KeptReport[];
  signedOut: string[];
  registered: string[];
  registerFailures: number;
  onTrajectory: string[];
  /** Each registered rollover with the recording it belongs to. */
  rollovers: { trajectoryId: string; demonstrationId: string }[];
  closed: string[];
  closeGate: Promise<void> | null;
  last(): StreamerStatus;
  stored(trajectoryId: string): { seq: number; name: string; raw: unknown }[];
  pending(trajectoryId: string): Promise<number>;
  deps(overrides?: Partial<StreamerDeps>): StreamerDeps;
  start(
    session?: Partial<StreamerSession>,
    overrides?: Partial<StreamerDeps>,
  ): Promise<Streamer>;
  trajectoryId: string;
};

let harness: Harness | null = null;
const streamers: Streamer[] = [];
let dbCounter = 0;

function makeGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function setup(options: { eventCap?: number } = {}): Promise<Harness> {
  const gateway = await startFakeGateway(options);
  const clock = virtualClock();
  const dbName = `streamer-test-${Date.now()}-${dbCounter++}`;
  const outbox = await openOutbox(dbName);
  let seq = 1;
  const sequencer = { next: () => seq++, flush: async () => {} };
  const h: Harness = {
    gateway,
    clock,
    outbox,
    dbName,
    grants: [],
    tokens: [],
    passScript: [],
    gate: null,
    beforeSocket: null,
    scripted: [],
    factoryCalls: 0,
    sockets: [],
    socketUrls: [],
    statuses: [],
    kept: [],
    signedOut: [],
    registered: [],
    registerFailures: 0,
    onTrajectory: [],
    rollovers: [],
    closed: [],
    closeGate: null,
    trajectoryId: crypto.randomUUID(),
    last: () => {
      const entry = h.statuses.at(-1);
      if (!entry) throw new Error("No status yet");
      return entry.status;
    },
    stored: (trajectoryId) => gateway.events(trajectoryId),
    pending: (trajectoryId) => h.outbox.count(trajectoryId),
    deps(overrides = {}) {
      class CountingWebSocket extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          h.sockets.push(this);
          h.socketUrls.push(String(url));
        }
      }
      return {
        async fetchGrant(trajectoryId: string): Promise<TrajectoryGrant> {
          h.grants.push(trajectoryId);
          if (h.gate) await h.gate.promise;
          const scripted = h.passScript.shift();
          if (scripted) throw new GrantError(scripted);
          h.beforeSocket?.();
          const joinToken = gateway.mintToken(trajectoryId);
          h.tokens.push(joinToken);
          return {
            joinToken,
            realtime: {
              clientUrl: `${gateway.url}/client`,
              topic: `trajectory:${trajectoryId}`,
            },
          };
        },
        async registerTrajectory(trajectoryId: string) {
          if (h.registerFailures > 0) {
            h.registerFailures -= 1;
            throw new Error("OpenBot is unreachable");
          }
          h.registered.push(trajectoryId);
        },
        async closeTrajectory(trajectoryId: string) {
          if (h.closeGate) await h.closeGate;
          h.closed.push(trajectoryId);
        },
        allowedGatewayUrls: null,
        outbox: h.outbox,
        sequencer,
        status: (status: StreamerStatus) =>
          h.statuses.push({ at: clock.now(), status }),
        onTrajectory: (trajectoryId: string, demonstrationId: string) => {
          h.onTrajectory.push(trajectoryId);
          h.rollovers.push({ trajectoryId, demonstrationId });
        },
        onSignedOut: (reason: string) => h.signedOut.push(reason),
        onKept: (kept: KeptReport) => h.kept.push(kept),
        randomUUID: () => crypto.randomUUID(),
        socketFactory: (url: string, params: Record<string, string>) => {
          h.factoryCalls += 1;
          return (
            h.scripted.shift() ??
            createPhoenixSession(url, params, { transport: CountingWebSocket })
          );
        },
        now: clock.now,
        timers: clock.timers,
        ...overrides,
      };
    },
    async start(session = {}, overrides = {}) {
      const streamer = await createStreamer(
        {
          trajectoryId: h.trajectoryId,
          title: "File the weekly report",
          demonstrationId: "demo-1",
          version: "0.1.0",
          ...session,
        },
        h.deps(overrides),
      );
      streamers.push(streamer);
      return streamer;
    },
  };
  harness = h;
  return h;
}

const click = (
  i: number,
  extra: Record<string, JsonValue> = {},
): CapturedEvent => ({
  type: "CUSTOM",
  name: "click",
  timestamp: 1_700_000_000_000 + i,
  value: { i, ...extra },
});

/** An event no trimming can bring under Intelligence's 16 KiB: its URL alone is larger. */
const oversize = (): CapturedEvent => ({
  type: "CUSTOM",
  name: "page",
  timestamp: 1_700_000_000_000,
  value: { url: `https://example.com/${"a".repeat(20_000)}` },
});

const payloadOf = (entry: { raw: unknown }) =>
  (entry.raw as { value: Record<string, JsonValue> }).value;

const clicks = (entries: { name: string; raw: unknown }[]) =>
  entries
    .filter((entry) => entry.name === "click")
    .map((entry) => payloadOf(entry).i);

const range = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => from + index);

const notEnabledPass = () =>
  classifyGrantError(403, {
    code: "TRAJECTORIES_NOT_ENABLED",
    message: "Trajectories are not enabled.",
  });
const busyPass = () =>
  classifyGrantError(502, {
    code: "CONNECTION_FAILED",
    message: "Could not connect to Intelligence",
  });

async function streaming(h: Harness) {
  await until(() => h.last().intelligence === "streaming", "streaming");
}

async function started(h: Harness, trajectoryId = h.trajectoryId) {
  await until(() => h.stored(trajectoryId).length >= 2, "the first events");
  await until(
    async () => (await h.pending(trajectoryId)) === 0,
    "an empty outbox",
  );
  await streaming(h);
}

beforeEach(() => {
  savedIndexedDb = {
    indexedDB: globals.indexedDB,
    IDBKeyRange: globals.IDBKeyRange,
  };
  globals.indexedDB = new IDBFactory();
  globals.IDBKeyRange = FakeIDBKeyRange;
});

afterEach(async () => {
  for (const streamer of streamers.splice(0)) await streamer.discard();
  if (harness) await harness.gateway.stop();
  harness = null;
  for (const key of ["indexedDB", "IDBKeyRange"] as const) {
    if (savedIndexedDb[key] === undefined) Reflect.deleteProperty(globals, key);
    else Object.assign(globals, { [key]: savedIndexedDb[key] });
  }
});

describe("streamer", () => {
  test("120 events arrive once, in seq order, in batches within Intelligence's limits", async () => {
    const h = await setup();
    h.gate = makeGate();
    const s = await h.start();
    for (let i = 0; i < 60; i++) s.push(click(i));
    for (let i = 60; i < 120; i++)
      s.push(click(i, { text: "x".repeat(3_000) }));
    await until(
      async () => (await h.pending(h.trajectoryId)) === 122,
      "all queued",
    );
    h.gate.release();
    await until(() => h.stored(h.trajectoryId).length === 122, "all stored");
    await until(
      async () => (await h.pending(h.trajectoryId)) === 0,
      "an empty outbox",
    );

    const stored = h.stored(h.trajectoryId);
    const seqs = stored.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(122);
    expect(stored.slice(0, 2).map((entry) => entry.name)).toEqual([
      "recording.started",
      "outcome",
    ]);
    expect(payloadOf(stored[0])).toMatchObject({
      demonstrationId: "demo-1",
      source: "openbot-recorder",
      version: "0.1.0",
    });
    expect(payloadOf(stored[1])).toMatchObject({
      workflow: "File the weekly report",
      phase: "started",
    });
    expect(clicks(stored)).toEqual(range(120));
    for (const batch of h.gateway.batches) {
      expect(batch.count).toBeLessThanOrEqual(50);
      expect(batch.bytes).toBeLessThanOrEqual(65_536);
    }
    expect(h.gateway.batches.some((batch) => batch.count === 50)).toBe(true);
    expect(
      Math.max(...h.gateway.batches.map((batch) => batch.bytes)),
    ).toBeGreaterThan(60_000);
    expect(h.last().events).toEqual({
      sent: 122,
      pending: 0,
      rejected: 0,
      dropped: 0,
    });
  });

  test("a dropped socket reconnects with a fresh pass and loses nothing", async () => {
    const h = await setup();
    const s = await h.start();
    await started(h);
    for (let i = 0; i < 10; i++) s.push(click(i));
    await until(() => h.stored(h.trajectoryId).length === 12, "the first ten");
    h.gateway.dropConnections();
    for (let i = 10; i < 20; i++) s.push(click(i));
    await until(() => h.stored(h.trajectoryId).length === 22, "the second ten");
    expect(h.grants).toHaveLength(2);
    expect(new Set(h.tokens).size).toBe(2);
    expect(clicks(h.stored(h.trajectoryId))).toEqual(range(20));
  });

  test("an unacknowledged batch is resent and stored once", async () => {
    const h = await setup();
    const s = await h.start();
    await started(h);
    h.gateway.delayNextAck(15_000);
    for (let i = 0; i < 3; i++) s.push(click(i));
    await until(
      () => h.stored(h.trajectoryId).length >= 3,
      "the unanswered batch stored",
    );
    const batches = h.gateway.batches.length;
    await h.clock.advance(10_000);
    await until(
      async () => (await h.pending(h.trajectoryId)) === 0,
      "the resend acknowledged",
    );
    expect(h.grants).toHaveLength(2);
    expect(h.gateway.batches.length).toBeGreaterThan(batches);
    expect(h.stored(h.trajectoryId)).toHaveLength(5);
    expect(clicks(h.stored(h.trajectoryId))).toEqual(range(3));
  });

  test("a resent batch carries dropped 0, so a drop is reported once", async () => {
    const h = await setup();
    const s = await h.start();
    await started(h);
    s.push(oversize());
    h.gateway.delayNextAck(15_000);
    s.push(click(0));
    await until(
      () => h.stored(h.trajectoryId).length === 3,
      "the unanswered batch stored",
    );
    expect(h.gateway.batches.at(-1)?.dropped).toBe(1);
    await h.clock.advance(10_000);
    await until(
      async () => (await h.pending(h.trajectoryId)) === 0,
      "the resend acknowledged",
    );
    expect(h.gateway.batches.at(-1)?.dropped).toBe(0);
    expect(h.gateway.droppedReported(h.trajectoryId)).toBe(1);
    expect(h.last().events.dropped).toBe(1);
  });

  test("a refusal Intelligence also answers for a failed entitlement lookup keeps every event and retries", async () => {
    const h = await setup();
    h.passScript = [notEnabledPass(), notEnabledPass()];
    const s = await h.start();
    for (let i = 0; i < 38; i++) s.push(click(i));
    await until(
      () => h.statuses.some((entry) => entry.status.intelligence === "held"),
      "held",
    );
    expect(h.last()).toMatchObject({
      intelligence: "held",
      reason: PASS_HINTS.TRAJECTORIES_NOT_ENABLED,
    });
    await until(
      async () => (await h.pending(h.trajectoryId)) === 40,
      "40 kept",
    );
    s.push(click(38));
    s.push(click(39));
    await until(
      async () => (await h.pending(h.trajectoryId)) === 42,
      "new events still queue",
    );
    expect(h.stored(h.trajectoryId)).toHaveLength(0);

    await h.clock.advance(5 * MINUTE);
    await until(() => h.grants.length === 2, "the second attempt");
    expect(h.last().intelligence).toBe("held");
    await h.clock.advance(5 * MINUTE);
    await until(
      () => h.stored(h.trajectoryId).length === 42,
      "everything sent",
    );
    expect(clicks(h.stored(h.trajectoryId))).toEqual(range(40));
    expect(h.kept).toHaveLength(1);
    expect(h.kept[0]).toMatchObject({
      parked: false,
      reason: PASS_HINTS.TRAJECTORIES_NOT_ENABLED,
      demonstrationId: "demo-1",
      trajectoryId: h.trajectoryId,
    });

    await s.stop("succeeded");
    await s.drained();
    expect(h.closed).toEqual([h.trajectoryId]);
    expect(h.stored(h.trajectoryId)).toHaveLength(43);
  });

  test("a definitive refusal parks: events kept, no automatic retry, and the channel never rejoins on its own", async () => {
    const h = await setup();
    h.gateway.refuseNextJoin("trajectories_unavailable");
    const s = await h.start();
    for (let i = 0; i < 8; i++) s.push(click(i));
    await until(
      () => h.statuses.some((entry) => entry.status.intelligence === "parked"),
      "parked",
    );
    expect(h.last()).toMatchObject({
      intelligence: "parked",
      reason: GATEWAY_OFF,
    });
    await until(
      async () => (await h.pending(h.trajectoryId)) === 10,
      "everything kept",
    );
    const joins = h.gateway.joins.length;

    await h.clock.advance(30 * MINUTE);
    await sleep(1_300); // phoenix.js would rejoin an errored channel after 1 s of real time
    expect(await h.pending(h.trajectoryId)).toBe(10);
    expect(h.grants).toHaveLength(1);
    expect(h.gateway.joins).toHaveLength(joins);
    expect(h.kept).toEqual([
      {
        reason: GATEWAY_OFF,
        parked: true,
        events: expect.any(Number),
        demonstrationId: "demo-1",
        trajectoryId: h.trajectoryId,
      },
    ]);

    // The next browser start: a resumed streamer over the same database sends them all.
    h.outbox = await openOutbox(h.dbName);
    await h.start({ resume: true });
    await until(
      () => h.stored(h.trajectoryId).length === 10,
      "everything sent",
    );
    expect(clicks(h.stored(h.trajectoryId))).toEqual(range(8));
  });

  describe("trajectories_not_enabled from the gateway holds, because its answer can lag", () => {
    test("on the join (row 29)", async () => {
      const h = await setup();
      h.gateway.refuseNextJoin("trajectories_not_enabled");
      const s = await h.start();
      s.push(click(0));
      await until(() => h.last().intelligence === "held", "held");
      expect(h.last().reason).toBe(NOT_ENABLED);
      await until(async () => (await h.pending(h.trajectoryId)) === 3, "kept");
      await h.clock.advance(5 * MINUTE);
      await until(
        () => h.stored(h.trajectoryId).length === 3,
        "sent after the hold",
      );
      expect(h.kept).toHaveLength(1);
    });

    test("on a push, and the channel close that follows is not counted again (row 35)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gateway.replyNextPush({ reason: "trajectories_not_enabled" });
      s.push(click(0));
      await until(() => h.last().intelligence === "held", "held");
      expect(h.last().reason).toBe(NOT_ENABLED);
      await sleep(50);
      expect(h.grants).toHaveLength(1);
      expect(h.kept).toHaveLength(1);
      s.push(click(1));
      await h.clock.advance(5 * MINUTE);
      await until(
        () => h.stored(h.trajectoryId).length === 4,
        "sent after the hold",
      );
      expect(clicks(h.stored(h.trajectoryId))).toEqual([0, 1]);
    });

    test("on an expired channel (row 43)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gateway.expire(h.trajectoryId, "trajectories_not_enabled");
      await until(() => h.last().intelligence === "held", "held");
      expect(h.last().reason).toBe(NOT_ENABLED);
      s.push(click(0));
      await until(async () => (await h.pending(h.trajectoryId)) === 1, "kept");
      await h.clock.advance(5 * MINUTE);
      await until(
        () => h.stored(h.trajectoryId).length === 3,
        "sent after the hold",
      );
    });
  });

  test("a signed-out pass keeps every event for its person", async () => {
    const h = await setup();
    const s = await h.start();
    await started(h);
    for (let i = 0; i < 3; i++) s.push(click(i));
    await until(() => h.stored(h.trajectoryId).length === 5, "the first three");
    h.passScript = [
      classifyGrantError(401, { code: RECORDER_SIGNED_OUT, reason: "revoked" }),
    ];
    h.gateway.dropConnections();
    await until(() => h.signedOut.length === 1, "signed out");
    expect(h.signedOut).toEqual(["revoked"]);
    for (let i = 3; i < 7; i++) s.push(click(i));
    await until(async () => (await h.pending(h.trajectoryId)) === 4, "kept");
    await until(
      () => h.sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
      "every socket closed",
    );
    await h.clock.advance(30 * MINUTE);
    expect(h.grants).toHaveLength(2);
    expect(h.signedOut).toHaveLength(1);
    expect(h.last().intelligence).toBe("off");

    // Connecting this browser again as the same person: a resumed streamer with a new token sends them all, once each.
    h.outbox = await openOutbox(h.dbName);
    await h.start({ resume: true });
    await until(() => h.stored(h.trajectoryId).length === 9, "everything sent");
    expect(clicks(h.stored(h.trajectoryId))).toEqual(range(7));
  });

  test("a retry that never clears settles into a hold after 30 minutes", async () => {
    const h = await setup();
    h.passScript = Array.from({ length: 500 }, busyPass);
    const begun = h.clock.now();
    await h.start();
    await until(() => h.grants.length === 1, "the first attempt");
    await h.clock.advance(29 * MINUTE);
    expect(h.last()).toMatchObject({ intelligence: "retrying", reason: BUSY });
    expect(
      h.statuses.some((entry) => entry.status.intelligence === "held"),
    ).toBe(false);
    await h.clock.advance(2 * MINUTE);
    const held = h.statuses.find(
      (entry) => entry.status.intelligence === "held",
    );
    expect(held?.status.reason).toBe(BUSY);
    expect(held?.at).toBeGreaterThanOrEqual(begun + 30 * MINUTE);
    expect(held?.at).toBeLessThan(begun + 31 * MINUTE);
    const attempts = h.grants.length;
    await h.clock.advance(5 * MINUTE);
    expect(h.grants).toHaveLength(attempts + 1);
    await h.clock.advance(5 * MINUTE);
    expect(h.grants).toHaveLength(attempts + 2);
    expect(h.last().intelligence).toBe("held");
    expect(h.kept).toHaveLength(1);
  });

  test("a refused socket is retired and retried with a fresh pass, and the third refusal names CHECK_ORIGIN", async () => {
    const h = await setup();
    let refusals = 3;
    h.beforeSocket = () => {
      if (refusals-- > 0) h.gateway.refuseNextSocket();
    };
    const s = await h.start();
    s.push(click(0));
    await until(
      () => h.clock.delays().includes(2_000),
      "the back-off before the third pass",
    );
    expect(h.grants).toHaveLength(2);
    expect(
      h.statuses.some((entry) => entry.status.reason === CHECK_ORIGIN),
    ).toBe(false);
    await h.clock.advance(2_000);
    await until(() => h.last().intelligence === "held", "held");
    expect(h.last().reason).toBe(CHECK_ORIGIN);
    await sleep(300); // phoenix.js would reconnect a dropped socket after 10 ms of real time
    expect(h.grants).toHaveLength(3);
    expect(new Set(h.tokens).size).toBe(3);
    expect(h.socketUrls).toHaveLength(3);
    expect(
      h.socketUrls.map((url) => new URL(url).searchParams.get("join_token")),
    ).toEqual(h.tokens);
    expect(await h.pending(h.trajectoryId)).toBe(3);
  });

  describe("join rows", () => {
    test("entitlement_unavailable retries with its sentence (row 30)", async () => {
      const h = await setup();
      h.gateway.refuseNextJoin("entitlement_unavailable");
      h.gateway.refuseNextJoin("entitlement_unavailable");
      await h.start();
      await until(() => h.clock.delays().includes(1_000), "the first back-off");
      expect(h.last().intelligence).toBe("connecting");
      await h.clock.advance(1_000);
      await until(
        () => h.clock.delays().includes(2_000),
        "the second back-off",
      );
      expect(h.last()).toMatchObject({
        intelligence: "retrying",
        reason: ENTITLEMENT,
      });
      await h.clock.advance(2_000);
      await started(h);
      expect(h.grants).toHaveLength(3);
    });

    test("marketplace_license_required retries (row 28)", async () => {
      const h = await setup();
      h.gateway.refuseNextJoin("marketplace_license_required");
      h.gateway.refuseNextJoin("marketplace_license_required");
      await h.start();
      await until(() => h.clock.delays().includes(1_000), "the first back-off");
      await h.clock.advance(1_000);
      await until(
        () => h.clock.delays().includes(2_000),
        "the second back-off",
      );
      expect(h.last()).toMatchObject({
        intelligence: "retrying",
        reason: MARKETPLACE,
      });
      await h.clock.advance(2_000);
      await started(h);
    });

    test("trajectories_unavailable parks with every event kept (row 26)", async () => {
      const h = await setup();
      h.gateway.refuseNextJoin("trajectories_unavailable");
      const s = await h.start();
      s.push(click(0));
      await until(() => h.last().intelligence === "parked", "parked");
      expect(await h.pending(h.trajectoryId)).toBe(3);
      expect(h.clock.delays()).toEqual([]);
    });

    for (const reason of ["unauthorized", "token_not_trajectory_scoped"]) {
      test(`${reason} re-grants once and parks on the second (row 27)`, async () => {
        const h = await setup();
        h.gateway.refuseNextJoin(reason);
        h.gateway.refuseNextJoin(reason);
        await h.start();
        await until(() => h.last().intelligence === "parked", "parked");
        expect(h.last().reason).toBe(PASS_REFUSED);
        expect(h.grants).toHaveLength(2);
        expect(new Set(h.tokens).size).toBe(2);
        expect(h.kept[0]).toMatchObject({ parked: true, reason: PASS_REFUSED });
      });
    }

    test("unmatched topic parks (row 31)", async () => {
      const h = await setup();
      h.gateway.refuseNextJoin("unmatched topic");
      await h.start();
      await until(() => h.last().intelligence === "parked", "parked");
      expect(h.last().reason).toBe(PASS_REFUSED);
      expect(h.grants).toHaveLength(1);
    });

    test("a join with no reply in 10 s retries (row 32)", async () => {
      const h = await setup();
      h.scripted = [new ScriptedPhoenix("silent")];
      const s = await h.start();
      s.push(click(0));
      await until(() => h.clock.delays().includes(10_000), "the join timeout");
      await h.clock.advance(10_000);
      await until(() => h.clock.delays().includes(1_000), "the back-off");
      expect(h.grants).toHaveLength(1);
      await h.clock.advance(1_000);
      await until(
        () => h.stored(h.trajectoryId).length === 3,
        "sent on the second pass",
      );
      expect(h.grants).toHaveLength(2);
    });

    test("join crashed re-grants and a second holds (row 32a)", async () => {
      const h = await setup();
      h.gateway.replyNextJoin("join crashed");
      h.gateway.replyNextJoin("join crashed");
      await h.start();
      await until(() => h.last().intelligence === "held", "held");
      expect(h.last().reason).toBe(
        "Learning capture is paused: Intelligence refused to open the capture channel (join crashed).",
      );
      expect(h.grants).toHaveLength(2);
    });

    test("a join reason no row names holds (row 32a)", async () => {
      const h = await setup();
      h.gateway.replyNextJoin("something new");
      await h.start();
      await until(() => h.last().intelligence === "held", "held");
      expect(h.last().reason).toBe(
        "Learning capture is paused: Intelligence refused to open the capture channel (something new).",
      );
      expect(h.grants).toHaveLength(1);
    });
  });

  describe("push rows", () => {
    test("an ok acknowledgement removes the batch (row 33)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      s.push(click(0));
      await until(
        async () =>
          (await h.pending(h.trajectoryId)) === 0 &&
          h.stored(h.trajectoryId).length === 3,
        "acknowledged",
      );
      expect(h.last().events).toEqual({
        sent: 3,
        pending: 0,
        rejected: 0,
        dropped: 0,
      });
    });

    test("an acknowledgement whose counts do not add up re-grants and resends (row 34)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gateway.ackWithBadCounts();
      s.push(click(0));
      s.push(click(1));
      await until(() => h.grants.length === 2, "a fresh pass");
      await until(
        async () => (await h.pending(h.trajectoryId)) === 0,
        "resent",
      );
      expect(clicks(h.stored(h.trajectoryId))).toEqual([0, 1]);
    });

    for (const reason of [
      "entitlement_unavailable",
      "trajectory_outbox_full",
      "trajectory_over_share",
      "storage_unavailable",
    ]) {
      test(`${reason} with retryable: true resends the same batch on the same channel (rows 36, 37)`, async () => {
        const h = await setup();
        const s = await h.start();
        await started(h);
        h.gateway.replyNextPush({ reason });
        s.push(click(0));
        await until(() => h.clock.delays().includes(1_000), "the back-off");
        expect(h.stored(h.trajectoryId)).toHaveLength(2);
        await h.clock.advance(1_000);
        await until(() => h.stored(h.trajectoryId).length === 3, "resent");
        expect(h.grants).toHaveLength(1);
        const last = h.gateway.batches.slice(-2);
        expect(last.map((batch) => batch.count)).toEqual([1, 1]);
      });
    }

    test("batch_too_large splits the batch in two and both halves are stored (row 38)", async () => {
      const h = await setup();
      h.gate = makeGate();
      const s = await h.start();
      for (let i = 0; i < 10; i++) s.push(click(i));
      await until(
        async () => (await h.pending(h.trajectoryId)) === 12,
        "queued",
      );
      h.gateway.replyNextPush({ reason: "batch_too_large" });
      h.gate.release();
      await until(
        async () => (await h.pending(h.trajectoryId)) === 0,
        "both halves",
      );
      expect(h.gateway.batches.map((batch) => batch.count)).toEqual([12, 6, 6]);
      expect(clicks(h.stored(h.trajectoryId))).toEqual(range(10));
    });

    test("a lone event the gateway still refuses is dropped and reported once (row 38)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gateway.replyNextPush({ reason: "batch_too_large" });
      s.push(click(0, { text: "x".repeat(16_000) }));
      await until(() => h.last().events.dropped === 1, "dropped");
      s.push(click(1));
      await until(
        () => h.stored(h.trajectoryId).length === 3,
        "the next event",
      );
      expect(clicks(h.stored(h.trajectoryId))).toEqual([1]);
      expect(h.gateway.batches.at(-1)?.dropped).toBe(1);
      expect(h.gateway.droppedReported(h.trajectoryId)).toBe(1);
    });

    for (const reason of [
      "invalid_batch",
      "trajectory_mismatch",
      "scope_mismatch",
      "unsupported_event",
    ]) {
      test(`${reason} parks with every event kept (rows 39, 40)`, async () => {
        const h = await setup();
        const s = await h.start();
        await started(h);
        h.gateway.replyNextPush({ reason });
        s.push(click(0));
        s.push(click(1));
        await until(() => h.last().intelligence === "parked", "parked");
        expect(h.last().reason).toBe(MESSAGES_REFUSED);
        await until(
          async () => (await h.pending(h.trajectoryId)) === 2,
          "kept",
        );
        await h.clock.advance(30 * MINUTE);
        expect(h.grants).toHaveLength(1);
      });
    }

    test("a per-event rejection removes the batch, shows the count and is never resent (rows 33, 46)", async () => {
      const h = await setup();
      h.gate = makeGate();
      const s = await h.start();
      for (let i = 0; i < 3; i++) s.push(click(i));
      await until(
        async () => (await h.pending(h.trajectoryId)) === 5,
        "queued",
      );
      h.gateway.rejectNextEvents(2);
      h.gate.release();
      await until(
        async () => (await h.pending(h.trajectoryId)) === 0,
        "removed",
      );
      await sleep(50);
      expect(h.gateway.batches).toHaveLength(1);
      expect(h.stored(h.trajectoryId)).toHaveLength(3);
      expect(h.last().events).toMatchObject({ sent: 3, rejected: 2 });
    });

    test("no reply, then a channel error, re-grants and resends (row 41)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gateway.delayNextAck(15_000);
      s.push(click(0));
      await until(
        () => h.stored(h.trajectoryId).length === 3,
        "stored, unanswered",
      );
      h.gateway.sendChannelError(h.trajectoryId);
      await until(() => h.grants.length === 2, "a fresh pass");
      await until(
        async () => (await h.pending(h.trajectoryId)) === 0,
        "resent",
      );
      expect(h.stored(h.trajectoryId)).toHaveLength(3);
    });

    test("an unknown reason with retryable: true resends, and without it holds (row 41a)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gateway.replyNextPush({ reason: "something_new", retryable: true });
      s.push(click(0));
      await until(() => h.clock.delays().includes(1_000), "the back-off");
      await h.clock.advance(1_000);
      await until(() => h.stored(h.trajectoryId).length === 3, "resent");

      h.gateway.replyNextPush({ reason: "something_else" });
      s.push(click(1));
      await until(() => h.last().intelligence === "held", "held");
      expect(h.last().reason).toBe(
        "Learning capture is paused: Intelligence refused the recorder's messages (something_else).",
      );
      expect(await h.pending(h.trajectoryId)).toBe(1);
    });
  });

  describe("channel rows", () => {
    test("a channel error re-grants (row 45)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gateway.sendChannelError(h.trajectoryId);
      await until(() => h.grants.length === 2, "a fresh pass");
      s.push(click(0));
      await until(
        () => h.stored(h.trajectoryId).length === 3,
        "sent on the new channel",
      );
    });

    test("expired with an unknown reason re-grants and the third in a row holds (row 45a)", async () => {
      const h = await setup();
      await h.start();
      await started(h);
      const expire = () =>
        h.gateway.expire(
          h.trajectoryId,
          "session_revoked" as "session_expired",
        );
      expire();
      await until(() => h.grants.length === 2, "the first re-grant");
      await streaming(h);
      expire();
      await until(() => h.clock.delays().includes(2_000), "the back-off");
      await h.clock.advance(2_000);
      await until(() => h.grants.length === 3, "the second re-grant");
      await streaming(h);
      expire();
      await until(() => h.last().intelligence === "held", "held");
      expect(h.last().reason).toBe(
        "Learning capture is paused: Intelligence ended the capture session (session_revoked).",
      );
    });

    test("expired session_expired re-grants at once, backs off, and the next one in a row holds (row 42)", async () => {
      const h = await setup();
      await h.start();
      await started(h);
      h.gateway.expire(h.trajectoryId, "session_expired");
      await until(() => h.grants.length === 2, "the first re-grant, at once");
      await streaming(h);
      h.gateway.expire(h.trajectoryId, "session_expired");
      await until(() => h.clock.delays().includes(2_000), "the back-off");
      await h.clock.advance(1_999);
      expect(h.grants).toHaveLength(2);
      await h.clock.advance(1);
      await until(
        () => h.grants.length === 3,
        "the second re-grant, after the back-off",
      );
      await streaming(h);
      h.gateway.expire(h.trajectoryId, "session_expired");
      await until(() => h.last().intelligence === "held", "held");
      expect(h.last().reason).toBe(
        "Learning capture is paused: Intelligence ended this person's capture sessions.",
      );
      expect(h.grants).toHaveLength(3);
    });

    test("expired entitlement_unavailable retries (row 44)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gateway.expire(h.trajectoryId, "entitlement_unavailable");
      await until(() => h.clock.delays().includes(1_000), "the back-off");
      s.push(click(0));
      await h.clock.advance(1_000);
      await until(
        () => h.stored(h.trajectoryId).length === 3,
        "sent after the retry",
      );
      expect(h.grants).toHaveLength(2);
    });
  });

  describe("socket rows", () => {
    test("a draining gateway (1012) re-grants (row 25)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gateway.closeSockets(1012);
      await until(() => h.grants.length === 2, "a fresh pass");
      s.push(click(0));
      await until(
        () => h.stored(h.trajectoryId).length === 3,
        "sent on the new socket",
      );
    });

    test("closes 1011 and 1000 re-grant and the third in a row holds; the channel error that follows each counts once (row 25a)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gateway.closeSockets(1011);
      await until(() => h.grants.length === 2, "the first re-grant");
      await streaming(h);
      h.gateway.closeSockets(1000);
      await until(() => h.clock.delays().includes(2_000), "the back-off");
      expect(h.last().intelligence).toBe("retrying");
      await h.clock.advance(2_000);
      await until(() => h.grants.length === 3, "the second re-grant");
      await streaming(h);
      h.gateway.closeSockets(1011);
      await until(() => h.last().intelligence === "held", "held");
      expect(h.last().reason).toBe(BUSY);
      s.push(click(0));
      await until(async () => (await h.pending(h.trajectoryId)) === 1, "kept");
    });

    test("a frame too large (1009) re-grants and the next batch goes in halves (row 25a)", async () => {
      const h = await setup();
      const s = await h.start();
      await started(h);
      h.gate = makeGate();
      h.gateway.closeSockets(1009);
      await until(() => h.grants.length === 2, "a fresh pass");
      for (let i = 0; i < 40; i++) s.push(click(i));
      await until(
        async () => (await h.pending(h.trajectoryId)) === 40,
        "queued",
      );
      const before = h.gateway.batches.length;
      h.gate.release();
      await until(async () => (await h.pending(h.trajectoryId)) === 0, "sent");
      expect(
        h.gateway.batches.slice(before).map((batch) => batch.count),
      ).toEqual([25, 15]);
    });

    test("a socket failure followed by the channel's own errors counts once, and is torn down as core does", async () => {
      const h = await setup();
      const scripted = new ScriptedPhoenix("ok");
      h.scripted = [scripted];
      await h.start();
      await streaming(h);
      scripted.failTransport();
      await until(() => h.grants.length === 2, "one fresh pass");
      await started(h);
      expect(h.grants).toHaveLength(2);
      expect(
        h.statuses.some((entry) => entry.status.intelligence === "held"),
      ).toBe(false);
      expect(scripted.boundChannelHandlers).toBe(0);
      expect(scripted.offChannel.map(([event]) => event).sort()).toEqual([
        "expired",
        "phx_close",
        "phx_error",
      ]);
      expect(scripted.left).toBe(true);
      expect(scripted.offSocketRefs).toHaveLength(3);
      expect(scripted.disconnected).toBe(true);
      const calls = scripted.connectCalls;
      scripted.connect();
      expect(scripted.connectCalls).toBe(calls);
    });
  });

  test("a pass pointing at a disallowed gateway opens no socket", async () => {
    const h = await setup();
    const s = await h.start(
      {},
      { allowedGatewayUrls: ["wss://intelligence.example.com"] },
    );
    s.push(click(0));
    await until(() => h.last().intelligence === "parked", "parked");
    expect(h.last().reason).toBe(PASS_HINTS.GATEWAY_NOT_ALLOWED);
    expect(h.factoryCalls).toBe(0);
    expect(h.sockets).toHaveLength(0);
    await until(async () => (await h.pending(h.trajectoryId)) === 3, "kept");
  });

  test("an event with a NUL character is sanitised and accepted, an event that already has a seq is wrapped, not overwritten, and an event whose timestamp is past Intelligence's maximum is given the time it was queued", async () => {
    const h = await setup();
    const s = await h.start();
    await started(h);
    s.push({
      type: "CUSTOM",
      name: "input",
      timestamp: 1,
      value: { text: "a\u0000b" },
    });
    s.push({
      type: "CUSTOM",
      name: "custom",
      timestamp: 2,
      value: { seq: 42, x: 1 },
    });
    s.push({ type: "CUSTOM", name: "list", timestamp: 3, value: [1, 2] });
    s.push({
      type: "CUSTOM",
      name: "page",
      timestamp: 253_402_300_800_000,
      value: {},
    });
    s.push({ type: "CUSTOM", name: "n".repeat(250), timestamp: 4, value: {} });
    await until(() => h.stored(h.trajectoryId).length === 7, "all accepted");
    const [input, custom, list, page, long] = h.stored(h.trajectoryId).slice(2);
    expect(payloadOf(input).text).toBe("a�b");
    expect(payloadOf(custom)).toEqual({
      data: { seq: 42, x: 1 },
      seq: custom.seq,
    });
    expect(payloadOf(list)).toEqual({ data: [1, 2], seq: list.seq });
    expect((page.raw as { timestamp: number }).timestamp).toBe(h.clock.now());
    expect(long.name).toBe("n".repeat(200));
    expect(h.last().events.rejected).toBe(0);
  });

  test("a split emoji never reaches the gateway", async () => {
    const h = await setup();
    const s = await h.start();
    await started(h);
    s.push({
      type: "CUSTOM",
      name: "input",
      timestamp: 1,
      value: { text: "hello \ud83d" },
    });
    s.push({
      type: "CUSTOM",
      name: "click",
      timestamp: 2,
      value: { target: { text: `x\ud83d${"😀".repeat(20_000)}` } },
    });
    await until(() => h.stored(h.trajectoryId).length === 4, "both stored");
    await until(
      async () => (await h.pending(h.trajectoryId)) === 0,
      "acknowledged",
    );
    const [input, trimmed] = h.stored(h.trajectoryId).slice(2);
    expect(payloadOf(input).text).toBe("hello �");
    const text = (payloadOf(trimmed).target as { text: string }).text;
    expect(text.startsWith("x�")).toBe(true);
    expect(text.isWellFormed()).toBe(true);
    expect(text.length).toBeLessThan(400);
    expect(h.gateway.undecodable).toBe(0);
    expect(h.grants).toHaveLength(1);
  });

  test("a drop count survives a refused push and is never sent twice", async () => {
    const h = await setup();
    const s = await h.start();
    await started(h);
    s.push(oversize());
    h.gateway.replyNextPush({ reason: "trajectory_outbox_full" });
    s.push(click(0));
    await until(() => h.clock.delays().includes(1_000), "the back-off");
    expect(h.gateway.droppedReported(h.trajectoryId)).toBe(0);
    await h.clock.advance(1_000);
    await until(() => h.stored(h.trajectoryId).length === 3, "resent");
    expect(h.gateway.droppedReported(h.trajectoryId)).toBe(1);

    // An unanswered push may have been stored: its resend carries 0, so the total never exceeds 1.
    s.push(oversize());
    h.gateway.delayNextAck(15_000);
    s.push(click(1));
    await until(
      () => h.stored(h.trajectoryId).length === 4,
      "stored, unanswered",
    );
    await h.clock.advance(10_000);
    await until(async () => (await h.pending(h.trajectoryId)) === 0, "resent");
    expect(h.gateway.batches.at(-1)?.dropped).toBe(0);
    expect(h.gateway.droppedReported(h.trajectoryId)).toBe(2);
    expect(h.last().events.dropped).toBe(2);
  });

  test("a long recording rolls over to a linked trajectory and closes the old one", async () => {
    const h = await setup();
    const s = await h.start({}, { rolloverAt: 30 });
    for (let i = 0; i < 70; i++) s.push(click(i));
    await until(() => h.onTrajectory.length === 2, "two rollovers");
    const [second, third] = h.onTrajectory;
    await until(
      () =>
        clicks([
          ...h.stored(h.trajectoryId),
          ...h.stored(second),
          ...h.stored(third),
        ]).length === 70,
      "all 70 stored",
    );
    await until(() => h.closed.length === 2, "the first two closed");
    expect(h.registered).toEqual([second, third]);
    expect(h.closed).toEqual([h.trajectoryId, second]);
    const first = h.stored(h.trajectoryId);
    const middle = h.stored(second);
    const last = h.stored(third);
    expect(first).toHaveLength(31);
    expect(first.at(-1)?.name).toBe("recording.continued");
    expect(payloadOf(first.at(-1) ?? first[0]).nextTrajectoryId).toBe(second);
    expect(middle[0].name).toBe("recording.continues");
    expect(payloadOf(middle[0])).toMatchObject({
      previousTrajectoryId: h.trajectoryId,
      demonstrationId: "demo-1",
    });
    expect(payloadOf(middle.at(-1) ?? middle[0]).nextTrajectoryId).toBe(third);
    expect(payloadOf(last[0]).previousTrajectoryId).toBe(second);
    expect(clicks([...first, ...middle, ...last])).toEqual(range(70));
    const stopped = await s.stop("succeeded");
    expect(stopped.trajectoryIds).toEqual([h.trajectoryId, second, third]);
    await s.drained();
    expect(h.closed).toEqual([h.trajectoryId, second, third]);
  });

  test("registration that keeps failing never pushes the old trajectory past its cap", async () => {
    const h = await setup({ eventCap: 40 });
    h.registerFailures = 5;
    const s = await h.start({}, { rolloverAt: 30 });
    for (let i = 0; i < 98; i++) s.push(click(i));
    await until(
      () => h.stored(h.trajectoryId).length === 31,
      "the first trajectory full",
    );
    await sleep(100);
    const first = h.stored(h.trajectoryId);
    expect(first).toHaveLength(31);
    expect(first.at(-1)?.name).toBe("recording.continued");
    expect(h.onTrajectory).toHaveLength(0);
    for (let step = 0; step < 10 && h.onTrajectory.length < 3; step++) {
      await h.clock.advance(MINUTE);
    }
    await until(
      () => h.onTrajectory.length === 3,
      "every next trajectory registered",
    );
    const chain = [h.trajectoryId, ...h.onTrajectory];
    await until(
      () => clicks(chain.flatMap((id) => h.stored(id))).length === 98,
      "every event stored",
    );
    expect(clicks(chain.flatMap((id) => h.stored(id)))).toEqual(range(98));
    for (const id of chain) expect(h.stored(id).length).toBeLessThanOrEqual(31);
    expect(h.last().events.rejected).toBe(0);
  });

  test("a rollover registered after Start over is reported for the recording it belongs to", async () => {
    const h = await setup();
    h.registerFailures = 1;
    const second = crypto.randomUUID();
    const s = await h.start({}, { rolloverAt: 5, randomUUID: () => second });
    // started, outcome and three clicks fill the first trajectory; the fourth click rolls over.
    for (let i = 0; i < 4; i++) s.push(click(i));
    await until(
      () => h.registerFailures === 0,
      "the first registration refused",
    );
    expect(h.rollovers).toEqual([]);
    const next = crypto.randomUUID();
    const rotating = s.rotate({
      demonstrationId: "demo-2",
      trajectoryId: next,
      title: "Try again",
    });
    await until(() => h.stored(next).length === 2, "the new recording streams");

    await h.clock.advance(1_000);
    await until(() => h.rollovers.length === 1, "the rollover registered");
    expect(h.rollovers).toEqual([
      { trajectoryId: second, demonstrationId: "demo-1" },
    ]);
    await rotating;
    expect(h.closed).toEqual([h.trajectoryId, second]);
    const rolled = h.stored(second);
    expect(clicks(rolled)).toEqual([3]);
    expect(payloadOf(rolled.at(-1) ?? rolled[0])).toMatchObject({
      workflow: "File the weekly report",
      phase: "failed",
    });
  });

  test("stop queues the outcome last, keeps draining with no deadline and closes each trajectory when empty", async () => {
    const h = await setup();
    const s = await h.start();
    await started(h);
    h.passScript = Array.from({ length: 7 }, busyPass);
    h.gateway.dropConnections();
    await until(() => h.grants.length === 2, "the gateway is paused");
    s.push(click(0));
    s.push(click(1));
    const stopped = await s.stop("succeeded", { stoppedFrom: "openbot" });
    expect(stopped.trajectoryIds).toEqual([h.trajectoryId]);
    expect(await h.pending(h.trajectoryId)).toBe(3);
    let drained = false;
    void s.drained().then(() => {
      drained = true;
    });
    await h.clock.advance(90_000);
    expect(drained).toBe(false);
    expect(h.closed).toEqual([]);
    await h.clock.advance(MINUTE);
    await until(() => drained, "drained");
    expect(h.closed).toEqual([h.trajectoryId]);
    const stored = h.stored(h.trajectoryId);
    expect(stored.at(-1)?.name).toBe("outcome");
    expect(payloadOf(stored.at(-1) ?? stored[0])).toMatchObject({
      workflow: "File the weekly report",
      phase: "succeeded",
      stoppedFrom: "openbot",
    });
    expect(clicks(stored)).toEqual([0, 1]);
    expect(h.last().intelligence).toBe("off");
  });

  test("Start over closes the old trajectory as failed, switches at once and resolves after the old one drained", async () => {
    const h = await setup();
    const s = await h.start();
    await started(h);
    s.push(click(0));
    const gate = makeGate();
    h.closeGate = gate.promise;
    const next = crypto.randomUUID();
    let rotated = false;
    const rotating = s
      .rotate({
        demonstrationId: "demo-2",
        trajectoryId: next,
        title: "Try again",
      })
      .then(() => {
        rotated = true;
      });
    s.push(click(1));
    await until(
      () => h.stored(next).length === 3,
      "the new trajectory streams at once",
    );
    await until(
      () => h.stored(h.trajectoryId).length === 4,
      "the old one drained",
    );
    await sleep(50);
    expect(rotated).toBe(false);
    gate.release();
    await rotating;
    expect(h.closed).toEqual([h.trajectoryId]);
    const old = h.stored(h.trajectoryId);
    expect(old.at(-1)?.name).toBe("outcome");
    expect(payloadOf(old.at(-1) ?? old[0])).toMatchObject({
      workflow: "File the weekly report",
      phase: "failed",
    });
    const fresh = h.stored(next);
    expect(fresh.map((entry) => entry.name)).toEqual([
      "recording.started",
      "outcome",
      "click",
    ]);
    expect(payloadOf(fresh[0]).demonstrationId).toBe("demo-2");
    expect(payloadOf(fresh[1])).toMatchObject({
      workflow: "Try again",
      phase: "started",
    });
    expect(clicks(old)).toEqual([0]);
    expect(clicks(fresh)).toEqual([1]);
  });

  test("a recording that stops while its events are kept reports them again, outcome included, for the stopped recording", async () => {
    const h = await setup();
    h.gateway.refuseNextJoin("trajectories_unavailable");
    const s = await h.start();
    s.push(click(0));
    await until(() => h.last().intelligence === "parked", "parked");
    await until(async () => (await h.pending(h.trajectoryId)) === 3, "kept");
    expect(h.kept).toHaveLength(1);

    await s.stop("succeeded");
    expect(await h.pending(h.trajectoryId)).toBe(4);
    expect(h.kept).toHaveLength(2);
    expect(h.kept[1]).toEqual({
      reason: GATEWAY_OFF,
      parked: true,
      events: 4,
      demonstrationId: "demo-1",
      trajectoryId: h.trajectoryId,
    });
  });

  test("Start over reports the replaced recording's kept events again, outcome included", async () => {
    const h = await setup();
    h.gateway.refuseNextJoin("trajectories_unavailable");
    const s = await h.start();
    await until(() => h.last().intelligence === "parked", "parked");
    await until(async () => (await h.pending(h.trajectoryId)) === 2, "kept");
    expect(h.kept).toHaveLength(1);

    const next = crypto.randomUUID();
    let rotated = false;
    void s
      .rotate({
        demonstrationId: "demo-2",
        trajectoryId: next,
        title: "Try again",
      })
      .then(() => {
        rotated = true;
      });
    await until(() => h.stored(next).length === 2, "the new recording streams");
    expect(h.kept).toHaveLength(2);
    expect(h.kept[1]).toEqual({
      reason: GATEWAY_OFF,
      parked: true,
      events: 3,
      demonstrationId: "demo-1",
      trajectoryId: h.trajectoryId,
    });
    expect(await h.pending(h.trajectoryId)).toBe(3);
    expect(rotated).toBe(false);
  });

  test("events still in the outbox are sent after the offscreen document restarts", async () => {
    const h = await setup();
    h.passScript = [busyPass()];
    // The first document never gets to retry: it is gone.
    const s = await h.start({}, { timers: virtualClock().timers });
    for (let i = 0; i < 5; i++) s.push(click(i));
    await until(async () => (await h.pending(h.trajectoryId)) === 7, "queued");
    h.outbox = await openOutbox(h.dbName);
    const resumed = await h.start({ resume: true });
    resumed.push(click(5));
    await until(() => h.stored(h.trajectoryId).length === 8, "everything sent");
    const stored = h.stored(h.trajectoryId);
    expect(stored.slice(0, 2).map((entry) => entry.name)).toEqual([
      "recording.started",
      "outcome",
    ]);
    expect(clicks(stored)).toEqual(range(6));
  });

  test("an outcome without a workflow would be rejected, so an empty title is refused at construction", async () => {
    const h = await setup();
    await expect(h.start({ title: "" })).rejects.toThrow("needs a title");
    await expect(h.start({ title: "   " })).rejects.toThrow("needs a title");
    const s = await h.start();
    await expect(
      s.rotate({
        demonstrationId: "demo-2",
        trajectoryId: crypto.randomUUID(),
        title: "",
      }),
    ).rejects.toThrow("needs a title");
    expect(h.grants.length).toBeLessThanOrEqual(1);
  });
});
