import type { TrajectoryGrant } from "@openbot/shared/recorder-api";
import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  type JsonValue,
  MAX_EVENT_BYTES,
  MAX_TIMESTAMP_MS,
  sanitiseForIntelligence,
  trimEvent,
} from "@openbot/shared/recorder-masking";
import type { CaptureStatus } from "../protocol/messages";
import { TRAJECTORY_ROLLOVER_AT } from "../shared/limits";
import { isAllowedGatewayUrl } from "../shared/origin";
import { GrantError, type GrantVerdict, PASS_HINTS } from "./grant";
import {
  type Outbox,
  type OutboxEvent,
  type TrajectoryMeta,
  trajectoryMetaKey,
} from "./outbox";
import {
  type ChannelLike,
  createPhoenixSession,
  PHOENIX_TIMEOUT_MS,
  type PhoenixLike,
} from "./phoenix-session";

export type StreamerStatus = {
  intelligence: CaptureStatus["intelligence"];
  reason?: string;
  trajectoryId: string;
  events: { sent: number; pending: number; rejected: number; dropped: number };
};

/** A trajectory that stopped streaming with its events kept, and which recording it belongs to. */
export type KeptReport = {
  reason: string;
  parked: boolean;
  events: number;
  recordingId: string;
  trajectoryId: string;
};

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type StreamerDeps = {
  fetchGrant(trajectoryId: string): Promise<TrajectoryGrant>;
  allowedGatewayUrls: string[] | null;
  outbox: Outbox;
  sequencer: { next(): number; flush(): Promise<void> };
  status(update: StreamerStatus): void;
  /** A long recording rolled over to another trajectory of `recordingId`: after Start over that can be the replaced
   * recording. */
  onTrajectory(trajectoryId: string, recordingId: string): void;
  /** Forwarded as offscreen.signed-out { reason, token }: the controller adds the session token its fetchGrant used (the
   * streamer never holds it), so the service worker signs out only that connection. */
  onSignedOut(reason: "revoked" | "removed" | "organization"): void;
  /** A trajectory stopped streaming with its events kept (a stop (hold) or stop (park) row); called on each transition,
   * and again for every trajectory still kept when its recording stops or is replaced by Start over. */
  onKept(kept: KeptReport): void;
  randomUUID(): string;
  /** Default 300_000: a stop (hold) tries again every 5 minutes. In the e2e variant the controller passes session.e2eHoldRetryMs. */
  holdRetryMs?: number;
  /** Default 1_800_000: 30 minutes of consecutive retries for one trajectory becomes stop (hold). */
  retryEscalateMs?: number;
  /** Default TRAJECTORY_ROLLOVER_AT. */
  rolloverAt?: number;
  /** Test seam. */
  socketFactory?: (url: string, params: Record<string, string>) => PhoenixLike;
  /** Test seams: the clock the streamer measures windows and timestamps with, and its timers. */
  now?: () => number;
  timers?: Timers;
};

export type Streamer = {
  /** `stepKey`: a held step's key (steps.ts): one this streamer's trajectories already took is not stored again. */
  push(event: CapturedEvent, stepKey?: string): void;
  /** Start over: the current trajectory gets `recording.restarted` naming the new one and a failed outcome with reason
   * `restarted`; the switch is at once (the new one's `recording.started` names the one it replaced), and it resolves
   * when the old one is drained and finished. */
  rotate(next: {
    recordingId: string;
    trajectoryId: string;
    title: string;
    /** When Start over began: the new trajectory's start events are stamped then. */
    startedAt?: number;
  }): Promise<void>;
  /** Queues `outcome` last and resolves once it is in the outbox. */
  stop(
    outcome: "succeeded" | "failed",
    extra?: Record<string, JsonValue>,
  ): Promise<{ trajectoryIds: string[] }>;
  /** Resolves when every trajectory of this streamer has an empty outbox and is finished. A trajectory that stopped with
   * its events kept never resolves it; it reports `onKept` instead, and a later successful retry drains and resolves. */
  drained(): Promise<void>;
  discard(): Promise<void>;
  /** The connection it sends for is gone (signed out, revoked, or moved away by the organization's policy): every socket
   * closes at once and nothing more is sent; every event stays in the outbox. Resolves once the events already pushed
   * are in it. */
  halt(): Promise<void>;
  /** The organization's policy now allows these gateways (null: any). A trajectory streaming to a gateway it no longer
   * allows is parked with its events kept, and every later pass is checked against the new list. */
  allow(urls: string[] | null): void;
  /** Once the service worker has heard a recording is done: the records of its trajectories go from the outbox (each
   * one finished, so nothing is left of them to send or resume). Does nothing while any of them is still open. */
  forget(recordingId: string): Promise<void>;
};

export type StreamerSession = {
  trajectoryId: string;
  title: string;
  recordingId: string;
  version: string;
  /** Reopen the outbox entries and meta of this trajectory and the ones it rolled over to, and send them first. */
  resume?: boolean;
  /** A streamer for offscreen.recover: no new rollover starts (only the final outcome follows). */
  recover?: boolean;
  /** A new recording: when Record began. Its `recording.started` and started outcome are stamped then, so they come
   * before (in time as in seq) every event it records. */
  startedAt?: number;
};

const MAX_BATCH_EVENTS = 50;
/** Intelligence takes 65,536 bytes per batch; the whole `{"events":[...],"dropped":<n>}` stays 32 under it. */
const MAX_BATCH_BYTES = 64 * 1024 - 32;
const ENVELOPE_BYTES = '{"events":[],"dropped":}'.length;
const MAX_NAME_CODE_POINTS = 200;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const REGRANT_WINDOW_MS = 30_000;
const DEFAULT_HOLD_RETRY_MS = 300_000;
const DEFAULT_RETRY_ESCALATE_MS = 1_800_000;

// The table's sentences (Task 11 "Error handling"); the pass rows' own sentences live in grant.ts PASS_HINTS.
const BUSY = "Intelligence is busy or unreachable. Retrying; nothing is lost.";
const MARKETPLACE =
  "Intelligence needs its marketplace licence before it can capture. Retrying; nothing is lost.";
const ENTITLEMENT =
  "Intelligence could not confirm this organization's licence (entitlement_unavailable). Retrying; nothing is lost.";
const GATEWAY_OFF =
  "Learning capture is off: the Intelligence gateway has trajectory capture turned off.";
const PASS_REFUSED =
  "Learning capture is off: Intelligence refused the capture pass.";
const NOT_ENABLED =
  "Learning capture is paused: Intelligence says this organization's licence does not include Product Trajectories, or that its billing is blocked.";
const MESSAGES_REFUSED =
  "Learning capture is off: Intelligence refused the recorder's messages.";
const SESSIONS_ENDED =
  "Learning capture is paused: Intelligence ended this person's capture sessions.";
const joinRefusedSentence = (reason: string) =>
  `Learning capture is paused: Intelligence refused to open the capture channel (${reason}).`;
const messagesRefusedSentence = (reason: string) =>
  `Learning capture is paused: Intelligence refused the recorder's messages (${reason}).`;
const sessionEndedSentence = (reason: string) =>
  `Learning capture is paused: Intelligence ended the capture session (${reason}).`;
/** Names the origin Intelligence saw, the id this copy runs under: the Recorder's fixed id unpacked, under policy or
 * from the Chrome Web Store, and the id Edge Add-ons assigned it in Edge, never the fixed one in its place. */
const checkOriginSentence = () =>
  `Intelligence refused the connection. If it sets CHECK_ORIGIN, that list must include chrome-extension://${chrome.runtime.id}.`;

type WireEvent = CapturedEvent & { value: Record<string, JsonValue> };

/** The meta a trajectory keeps in the outbox; `closed` records that every event of it reached Intelligence, so a resumed
 * streamer skips it. */
type StoredMeta = TrajectoryMeta & { closed?: boolean };

type Kept = { reason: string; parked: boolean };

/** The table's re-grant rows: every event stays and a fresh pass is taken at once; the escalation is the row's own. */
type RegrantRow =
  | "24"
  | "25"
  | "25a"
  | "27"
  | "32a"
  | "34"
  | "41"
  | "42"
  | "45"
  | "45a";

type Failure =
  | { kind: "retry"; reason: string; retryAfterMs?: number }
  | {
      kind: "regrant";
      row: RegrantRow;
      reason: string;
      holdAt?: number;
      parkAt?: number;
      showFrom: number;
    }
  | { kind: "hold"; reason: string }
  | { kind: "park"; reason: string }
  | { kind: "signed-out"; reason: "revoked" | "removed" | "organization" };

type InFlight = { items: OutboxEvent[]; dropped: number; timer: unknown };

type Connection = {
  socket: PhoenixLike | null;
  channel: ChannelLike | null;
  socketRefs: string[];
  channelRefs: [string, number][];
  opened: boolean;
  joined: boolean;
  dead: boolean;
  joinTimer: unknown;
  /** One push in flight per connection; "busy" while the outbox is read or written for it. */
  inflight: InFlight | "busy" | null;
  pushRetry: unknown;
  /** The gateway its pass pointed at, once the pass came. */
  gatewayUrl?: string;
};

type Lane = {
  id: string;
  meta: StoredMeta;
  pending: number;
  conn: Connection | null;
  /** The next connect attempt (a back-off or a held trajectory's retry). */
  timer: unknown;
  closing: boolean;
  kept: Kept | null;
  retry: { attempts: number; since: number } | null;
  regrant: { row: RegrantRow; count: number; at: number } | null;
  failures: number;
  /** The retrying sentence, once the person should see it (from the second consecutive failure). */
  showing: string | undefined;
  maxEvents: number;
  /** Its record is gone from the outbox (`forget`): nothing writes it again. */
  forgotten: boolean;
};

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const backoff = (attempt: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt - 1));

const sanitise = (event: WireEvent): WireEvent =>
  sanitiseForIntelligence(
    event as unknown as JsonValue,
  ) as unknown as WireEvent;

/** An `ok` reply the gateway can have sent for this batch (core's `isBatchAcknowledgement`). */
function isAcknowledgement(
  value: unknown,
  eventCount: number,
): value is { accepted: number; rejected: number } {
  if (!isRecord(value)) return false;
  const { accepted, rejected, highestSeq } = value;
  return (
    isCount(accepted) &&
    isCount(rejected) &&
    accepted + rejected === eventCount &&
    (highestSeq === null || isCount(highestSeq)) &&
    (accepted === 0 || highestSeq !== null)
  );
}

/**
 * Makes an event valid for Intelligence before it enters the outbox: the value wrapped exactly as core's
 * `TrajectoryConnection.send` does, the name cut to 200 code points, an impossible timestamp replaced, an oversize event
 * trimmed, and sanitising last, so no NUL and no lone surrogate can reach the wire. Null: still too large, dropped.
 */
function prepareEvent(
  event: CapturedEvent,
  seq: number,
  queuedAt: number,
): { event: WireEvent; bytes: number } | null {
  const original = event.value;
  const fields =
    isRecord(original) && !Object.hasOwn(original, "seq")
      ? original
      : { data: original };
  const timestamp =
    typeof event.timestamp === "number" &&
    event.timestamp > 0 &&
    event.timestamp <= MAX_TIMESTAMP_MS
      ? event.timestamp
      : queuedAt;
  let wire = sanitise({
    type: "CUSTOM",
    name: Array.from(event.name).slice(0, MAX_NAME_CODE_POINTS).join(""),
    timestamp,
    value: { ...fields, seq },
  });
  if (byteLength(wire) > MAX_EVENT_BYTES) {
    const trimmed = trimEvent(wire, EVENT_BUDGET_BYTES).event;
    const value = isRecord(trimmed.value)
      ? trimmed.value
      : { data: trimmed.value };
    wire = { ...trimmed, value: { ...value, seq } };
    if (byteLength(wire) > MAX_EVENT_BYTES) return null;
  }
  wire = sanitise(wire);
  return { event: wire, bytes: byteLength(wire) };
}

function passFailure(error: unknown): Failure {
  if (!(error instanceof GrantError)) {
    console.error("Recorder: the capture pass failed unexpectedly", error);
    return { kind: "retry", reason: BUSY };
  }
  const verdict: GrantVerdict = error.verdict;
  switch (verdict.kind) {
    case "retry":
      return verdict.retryAfterMs === undefined
        ? { kind: "retry", reason: verdict.reason }
        : {
            kind: "retry",
            reason: verdict.reason,
            retryAfterMs: verdict.retryAfterMs,
          };
    case "hold":
    case "park":
      return { kind: verdict.kind, reason: verdict.hint };
    case "signed-out":
      return { kind: "signed-out", reason: verdict.reason };
  }
}

function regrant(row: RegrantRow, detail = "unknown"): Failure {
  switch (row) {
    case "24":
      return {
        kind: "regrant",
        row,
        reason: checkOriginSentence(),
        holdAt: 3,
        showFrom: 3,
      };
    case "27":
      return {
        kind: "regrant",
        row,
        reason: PASS_REFUSED,
        parkAt: 2,
        showFrom: 2,
      };
    case "32a":
      return {
        kind: "regrant",
        row,
        reason: joinRefusedSentence("join crashed"),
        holdAt: 2,
        showFrom: 2,
      };
    case "42":
      return {
        kind: "regrant",
        row,
        reason: SESSIONS_ENDED,
        holdAt: 3,
        showFrom: 2,
      };
    case "45a":
      return {
        kind: "regrant",
        row,
        reason: sessionEndedSentence(detail),
        holdAt: 3,
        showFrom: 2,
      };
    default:
      return { kind: "regrant", row, reason: BUSY, holdAt: 3, showFrom: 2 };
  }
}

const reasonOf = (payload: unknown): string =>
  isRecord(payload) && typeof payload.reason === "string"
    ? payload.reason
    : "unknown";

const STATUS_RANK: Record<CaptureStatus["intelligence"], number> = {
  off: 0,
  streaming: 1,
  connecting: 2,
  retrying: 3,
  held: 4,
  parked: 5,
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Streams one recording's events to Intelligence's trajectory channel from a durable outbox: every event is resent until
 * the gateway acknowledges it, every refusal gets the verdict of Task 11's table (none discards events), a long recording
 * rolls over to linked trajectories (a `recording.continued` event names the next one), and each trajectory is finished
 * once it is stopped and its outbox is empty.
 */
export async function createStreamer(
  session: StreamerSession,
  deps: StreamerDeps,
): Promise<Streamer> {
  if (!session.title.trim()) {
    throw new Error(
      "A recording needs a title: Intelligence refuses an outcome without a workflow.",
    );
  }
  const timers = deps.timers ?? realTimers;
  const now = deps.now ?? Date.now;
  const holdRetryMs = deps.holdRetryMs ?? DEFAULT_HOLD_RETRY_MS;
  const retryEscalateMs = deps.retryEscalateMs ?? DEFAULT_RETRY_ESCALATE_MS;
  const rolloverAt = deps.rolloverAt ?? TRAJECTORY_ROLLOVER_AT;
  const socketFactory =
    deps.socketFactory ??
    ((url: string, params: Record<string, string>) =>
      createPhoenixSession(url, params));
  const { outbox } = deps;
  let allowedGatewayUrls = deps.allowedGatewayUrls;

  const lanes: Lane[] = [];
  const counters = new Map<
    string,
    { sent: number; rejected: number; dropped: number }
  >();
  const waiters: { recordingId: string; resolve: () => void }[] = [];
  let recordingId = session.recordingId;
  let signedOut = false;
  let discarded = false;
  let lastStatus = "";
  let chain: Promise<void> = Promise.resolve();

  const halted = () => signedOut || discarded;
  const clear = (handle: unknown) => {
    if (handle !== undefined) timers.clear(handle);
  };
  const countsOf = (recording: string) => {
    let found = counters.get(recording);
    if (!found) {
      found = { sent: 0, rejected: 0, dropped: 0 };
      counters.set(recording, found);
    }
    return found;
  };
  const lanesOf = (recording: string) =>
    lanes.filter((lane) => lane.meta.recordingId === recording);

  const makeLane = (id: string, meta: StoredMeta, pending: number): Lane => ({
    id,
    meta,
    pending,
    conn: null,
    timer: undefined,
    closing: false,
    kept: null,
    retry: null,
    regrant: null,
    failures: 0,
    showing: undefined,
    maxEvents: MAX_BATCH_EVENTS,
    forgotten: false,
  });
  const freshMeta = (recording: string, title: string): StoredMeta => ({
    recordingId: recording,
    title,
    pushed: 0,
    outcomeQueued: false,
    droppedPending: 0,
    stopped: false,
  });

  /** Writes the lane's meta as it is now; a failed write is reported and the in-memory meta stays authoritative. */
  const persist = (lane: Lane): Promise<void> =>
    lane.forgotten
      ? Promise.resolve()
      : outbox.setMeta(trajectoryMetaKey(lane.id), lane.meta).catch((error) => {
          console.error(
            "Recorder: a trajectory's meta could not be saved",
            error,
          );
        });

  /** Runs outbox writes one at a time, in push order; a failure is reported and later work still runs. */
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work);
    chain = run.then(
      () => undefined,
      (error) => {
        console.error("Recorder: an event could not be queued", error);
      },
    );
    return run;
  };

  const laneState = (
    lane: Lane,
  ): {
    intelligence: CaptureStatus["intelligence"];
    reason?: string;
  } | null => {
    if (lane.meta.closed) return null;
    if (lane.kept) {
      return {
        intelligence: lane.kept.parked ? "parked" : "held",
        reason: lane.kept.reason,
      };
    }
    if (lane.conn?.joined) return { intelligence: "streaming" };
    if (lane.showing) return { intelligence: "retrying", reason: lane.showing };
    return { intelligence: "connecting" };
  };

  const emitStatus = () => {
    const own = lanesOf(recordingId);
    let pick: {
      intelligence: CaptureStatus["intelligence"];
      reason?: string;
      trajectoryId: string;
    } = { intelligence: "off", trajectoryId: own.at(-1)?.id ?? "" };
    if (!signedOut) {
      // Newest first, so the current trajectory wins a tie.
      for (const lane of [...own].reverse()) {
        const state = laneState(lane);
        if (
          state &&
          STATUS_RANK[state.intelligence] > STATUS_RANK[pick.intelligence]
        ) {
          pick = { ...state, trajectoryId: lane.id };
        }
      }
    }
    const counts = countsOf(recordingId);
    const update: StreamerStatus = {
      intelligence: pick.intelligence,
      ...(pick.reason === undefined ? {} : { reason: pick.reason }),
      trajectoryId: pick.trajectoryId,
      events: {
        sent: counts.sent,
        pending: own.reduce((sum, lane) => sum + lane.pending, 0),
        rejected: counts.rejected,
        dropped: counts.dropped,
      },
    };
    const key = JSON.stringify(update);
    if (key === lastStatus) return;
    lastStatus = key;
    deps.status(update);
  };

  const settleWaiters = () => {
    for (const waiter of [...waiters]) {
      const own = lanesOf(waiter.recordingId);
      if (own.length > 0 && own.every((lane) => lane.meta.closed)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  const closedAll = (recording: string) =>
    new Promise<void>((resolve) => {
      waiters.push({ recordingId: recording, resolve });
      settleWaiters();
    });

  /** Tears a connection down exactly as core's `TrajectoryConnection.cleanup` does. */
  const teardown = (conn: Connection) => {
    conn.dead = true;
    clear(conn.joinTimer);
    clear(conn.pushRetry);
    if (conn.inflight && conn.inflight !== "busy") clear(conn.inflight.timer);
    conn.inflight = null;
    const { socket, channel } = conn;
    try {
      if (channel) {
        for (const [event, ref] of conn.channelRefs) channel.off(event, ref);
        channel.leave();
      }
    } finally {
      if (socket) {
        socket.off(conn.socketRefs);
        socket.connect = () => undefined;
        socket.disconnect();
      }
    }
  };

  const reportKept = (lane: Lane, kept: Kept) => {
    deps.onKept({
      reason: kept.reason,
      parked: kept.parked,
      events: lane.pending,
      recordingId: lane.meta.recordingId,
      trajectoryId: lane.id,
    });
  };

  const keep = (lane: Lane, kept: Kept) => {
    const before = lane.kept;
    lane.kept = kept;
    lane.showing = undefined;
    if (
      !before ||
      before.parked !== kept.parked ||
      before.reason !== kept.reason
    ) {
      reportKept(lane, kept);
    }
    emitStatus();
  };

  /**
   * A recording that stops or is replaced with trajectories already held or parked reports them again: the transition
   * was reported while it still recorded, when the controller posts only a status, so this is its first offscreen.kept.
   */
  const reportStillKept = (recording: string) => {
    for (const lane of lanesOf(recording)) {
      if (lane.kept && !lane.meta.closed) reportKept(lane, lane.kept);
    }
  };

  const hold = (lane: Lane, reason: string) => {
    keep(lane, { reason, parked: false });
    clear(lane.timer);
    lane.timer = timers.set(() => {
      lane.timer = undefined;
      void connect(lane);
    }, holdRetryMs);
  };

  const schedule = (lane: Lane, delayMs: number) => {
    clear(lane.timer);
    lane.timer = undefined;
    if (delayMs <= 0) {
      void connect(lane);
      return;
    }
    lane.timer = timers.set(() => {
      lane.timer = undefined;
      void connect(lane);
    }, delayMs);
  };

  /** Nothing more goes out: every connection and retry ends, and the events stay in the outbox. */
  const stopSending = () => {
    signedOut = true;
    for (const lane of lanes) {
      if (lane.conn) teardown(lane.conn);
      lane.conn = null;
      clear(lane.timer);
      lane.timer = undefined;
    }
    emitStatus();
  };

  const signOut = (reason: "revoked" | "removed" | "organization") => {
    if (halted()) return;
    stopSending();
    deps.onSignedOut(reason);
  };

  /** One failure, one row: the connection (if any) is torn down and the row's verdict decides what happens next. */
  const fail = (lane: Lane, conn: Connection | null, failure: Failure) => {
    if (conn) {
      if (conn.dead || lane.conn !== conn) return;
      teardown(conn);
      lane.conn = null;
    }
    if (halted() || lane.meta.closed || lane.closing) return;
    switch (failure.kind) {
      case "signed-out":
        signOut(failure.reason);
        return;
      case "park":
        clear(lane.timer);
        lane.timer = undefined;
        keep(lane, { reason: failure.reason, parked: true });
        return;
      case "hold":
        hold(lane, failure.reason);
        return;
      case "retry": {
        const at = now();
        lane.retry ??= { attempts: 0, since: at };
        lane.retry.attempts += 1;
        lane.failures += 1;
        if (at - lane.retry.since >= retryEscalateMs) {
          hold(lane, failure.reason);
          return;
        }
        lane.kept = null;
        lane.showing = lane.failures >= 2 ? failure.reason : undefined;
        emitStatus();
        schedule(lane, failure.retryAfterMs ?? backoff(lane.retry.attempts));
        return;
      }
      case "regrant": {
        const at = now();
        const previous = lane.regrant;
        const count =
          previous &&
          previous.row === failure.row &&
          at - previous.at <= REGRANT_WINDOW_MS
            ? previous.count + 1
            : 1;
        lane.regrant = { row: failure.row, count, at };
        lane.failures += 1;
        if (failure.parkAt !== undefined && count >= failure.parkAt) {
          keep(lane, { reason: failure.reason, parked: true });
          return;
        }
        if (failure.holdAt !== undefined && count >= failure.holdAt) {
          hold(lane, failure.reason);
          return;
        }
        lane.kept = null;
        lane.showing = count >= failure.showFrom ? failure.reason : undefined;
        emitStatus();
        schedule(lane, count === 1 ? 0 : backoff(count));
        return;
      }
    }
  };

  /** Joined with nothing to send: the trajectory has caught up, so a retry streak is over. */
  const caughtUp = (lane: Lane) => {
    lane.retry = null;
    lane.failures = 0;
    lane.showing = undefined;
    emitStatus();
    maybeClose(lane);
  };

  const maybeClose = (lane: Lane) => {
    if (halted() || lane.meta.closed || lane.closing) return;
    if (!lane.meta.stopped || lane.pending > 0 || lane.meta.droppedPending > 0)
      return;
    if (lane.conn?.inflight) return;
    void close(lane);
  };

  /** A stopped trajectory whose every event Intelligence acknowledged is finished: its connection goes, and its meta
   * says so, so a resumed streamer leaves it alone. */
  const close = async (lane: Lane) => {
    lane.closing = true;
    clear(lane.timer);
    lane.timer = undefined;
    if (lane.conn) teardown(lane.conn);
    lane.conn = null;
    lane.meta.closed = true;
    await persist(lane);
    emitStatus();
    settleWaiters();
  };

  const current = (lane: Lane, conn: Connection) =>
    !conn.dead && lane.conn === conn;

  const send = (
    lane: Lane,
    conn: Connection,
    items: OutboxEvent[],
    dropped: number,
  ) => {
    const channel = conn.channel;
    if (!channel) return;
    const inflight: InFlight = { items, dropped, timer: undefined };
    conn.inflight = inflight;
    const lost = () => {
      // No reply: the batch may or may not be stored, so it is resent (the gateway dedupes by seq) and its dropped
      // count counts as sent, so a drop can never be reported twice.
      if (current(lane, conn) && conn.inflight === inflight) {
        fail(lane, conn, regrant("34"));
      }
    };
    inflight.timer = timers.set(lost, PHOENIX_TIMEOUT_MS);
    channel
      .push(
        "events",
        { events: items.map((item) => item.event), dropped },
        PHOENIX_TIMEOUT_MS,
      )
      .receive("ok", (response) => {
        void acknowledged(lane, conn, inflight, response);
      })
      .receive("error", (response) => {
        refused(lane, conn, inflight, response);
      })
      .receive("timeout", lost);
  };

  const acknowledged = async (
    lane: Lane,
    conn: Connection,
    inflight: InFlight,
    response: unknown,
  ) => {
    if (!current(lane, conn) || conn.inflight !== inflight) return;
    clear(inflight.timer);
    if (!isAcknowledgement(response, inflight.items.length)) {
      fail(lane, conn, regrant("34"));
      return;
    }
    conn.inflight = "busy";
    try {
      await outbox.remove(
        lane.id,
        inflight.items.map((item) => item.seq),
      );
    } catch (error) {
      console.error(
        "Recorder: acknowledged events could not be removed",
        error,
      );
      conn.inflight = null;
      fail(lane, conn, { kind: "retry", reason: BUSY });
      return;
    }
    lane.pending -= inflight.items.length;
    const counts = countsOf(lane.meta.recordingId);
    counts.sent += response.accepted;
    counts.rejected += response.rejected;
    lane.retry = null;
    lane.regrant = null;
    lane.failures = 0;
    lane.showing = undefined;
    lane.kept = null;
    lane.maxEvents = MAX_BATCH_EVENTS;
    emitStatus();
    if (!current(lane, conn)) return;
    conn.inflight = null;
    void pump(lane);
  };

  /** Push-level retry (rows 36, 37, 41a): the channel stays joined and the same batch is resent on it after a back-off. */
  const retryPush = (lane: Lane, conn: Connection, reason: string) => {
    conn.inflight = null;
    const at = now();
    lane.retry ??= { attempts: 0, since: at };
    lane.retry.attempts += 1;
    lane.failures += 1;
    if (at - lane.retry.since >= retryEscalateMs) {
      fail(lane, conn, { kind: "hold", reason });
      return;
    }
    lane.showing = lane.failures >= 2 ? reason : undefined;
    emitStatus();
    conn.pushRetry = timers.set(() => {
      conn.pushRetry = undefined;
      void pump(lane);
    }, backoff(lane.retry.attempts));
  };

  /** Row 38: halve the batch; a lone event the gateway still refuses is dropped, counted and reported once. */
  const split = async (lane: Lane, conn: Connection, inflight: InFlight) => {
    if (inflight.items.length > 1) {
      lane.maxEvents = Math.ceil(inflight.items.length / 2);
      conn.inflight = null;
      void pump(lane);
      return;
    }
    conn.inflight = "busy";
    const [item] = inflight.items;
    try {
      await outbox.remove(lane.id, [item.seq]);
    } catch (error) {
      console.error("Recorder: a refused event could not be removed", error);
      conn.inflight = null;
      fail(lane, conn, { kind: "retry", reason: BUSY });
      return;
    }
    lane.pending -= 1;
    lane.meta.droppedPending += 1;
    countsOf(lane.meta.recordingId).dropped += 1;
    await persist(lane);
    emitStatus();
    if (!current(lane, conn)) return;
    conn.inflight = null;
    void pump(lane);
  };

  const refused = (
    lane: Lane,
    conn: Connection,
    inflight: InFlight,
    response: unknown,
  ) => {
    if (!current(lane, conn) || conn.inflight !== inflight) return;
    clear(inflight.timer);
    // A refusal wrote nothing, so the drop count it carried rides the next push.
    if (inflight.dropped > 0) {
      lane.meta.droppedPending += inflight.dropped;
      void persist(lane);
    }
    const reason = reasonOf(response);
    switch (reason) {
      case "trajectories_not_enabled":
        fail(lane, conn, { kind: "hold", reason: NOT_ENABLED });
        return;
      case "entitlement_unavailable":
        retryPush(lane, conn, ENTITLEMENT);
        return;
      case "trajectory_over_share":
      case "trajectory_outbox_full":
      case "storage_unavailable":
        retryPush(lane, conn, BUSY);
        return;
      case "batch_too_many_events":
      case "batch_too_large":
        void split(lane, conn, inflight);
        return;
      case "invalid_batch":
      case "trajectory_mismatch":
      case "scope_mismatch":
      case "unsupported_event":
        fail(lane, conn, {
          kind: "park",
          reason: MESSAGES_REFUSED,
        });
        return;
      case "unmatched topic":
        fail(lane, conn, regrant("41"));
        return;
      default:
        if (isRecord(response) && response.retryable === true) {
          retryPush(lane, conn, messagesRefusedSentence(reason));
        } else {
          fail(lane, conn, {
            kind: "hold",
            reason: messagesRefusedSentence(reason),
          });
        }
    }
  };

  /** Sends the oldest events that fit one batch; one push in flight per connection. */
  const pump = async (lane: Lane): Promise<void> => {
    const conn = lane.conn;
    if (
      !conn ||
      conn.dead ||
      !conn.joined ||
      conn.inflight ||
      conn.pushRetry !== undefined
    )
      return;
    conn.inflight = "busy";
    try {
      const dropped = lane.meta.droppedPending;
      const budget =
        MAX_BATCH_BYTES -
        ENVELOPE_BYTES -
        String(dropped).length -
        (lane.maxEvents - 1);
      const items = await outbox.oldest(lane.id, lane.maxEvents, budget);
      if (!current(lane, conn)) return;
      // A drop count waits for the next push of new events, unless the trajectory is about to close.
      if (items.length === 0 && (dropped === 0 || !lane.meta.stopped)) {
        conn.inflight = null;
        caughtUp(lane);
        return;
      }
      if (dropped > 0) {
        lane.meta.droppedPending -= dropped;
        await persist(lane);
        if (!current(lane, conn)) {
          lane.meta.droppedPending += dropped;
          await persist(lane);
          return;
        }
      }
      send(lane, conn, items, dropped);
    } catch (error) {
      console.error("Recorder: the outbox could not be read", error);
      if (current(lane, conn)) {
        conn.inflight = null;
        fail(lane, conn, { kind: "retry", reason: BUSY });
      }
    }
  };

  const joined = (lane: Lane, conn: Connection) => {
    if (!current(lane, conn)) return;
    clear(conn.joinTimer);
    conn.joined = true;
    lane.kept = null;
    emitStatus();
    void pump(lane);
  };

  const joinRefused = (lane: Lane, conn: Connection, response: unknown) => {
    const reason = reasonOf(response);
    switch (reason) {
      case "trajectories_unavailable":
        fail(lane, conn, { kind: "park", reason: GATEWAY_OFF });
        return;
      case "token_not_trajectory_scoped":
      case "unauthorized":
        fail(lane, conn, regrant("27"));
        return;
      case "marketplace_license_required":
        fail(lane, conn, { kind: "retry", reason: MARKETPLACE });
        return;
      case "trajectories_not_enabled":
        fail(lane, conn, { kind: "hold", reason: NOT_ENABLED });
        return;
      case "entitlement_unavailable":
        fail(lane, conn, { kind: "retry", reason: ENTITLEMENT });
        return;
      case "unmatched topic":
        fail(lane, conn, {
          kind: "park",
          reason: PASS_REFUSED,
        });
        return;
      case "join crashed":
        fail(lane, conn, regrant("32a"));
        return;
      default:
        fail(lane, conn, {
          kind: "hold",
          reason: joinRefusedSentence(reason),
        });
    }
  };

  /** A socket fails once, by its socket row; the channel error that follows on the same connection finds it torn down. */
  const socketFailed = (lane: Lane, conn: Connection, code?: number) => {
    if (!current(lane, conn)) return;
    if (!conn.opened) {
      fail(lane, conn, regrant("24"));
      return;
    }
    if (code === 1012 || code === 1002) {
      fail(lane, conn, regrant("25"));
      return;
    }
    if (code === 1009) {
      const sent =
        conn.inflight && conn.inflight !== "busy"
          ? conn.inflight.items.length
          : lane.maxEvents;
      lane.maxEvents = Math.max(1, Math.ceil(sent / 2));
    }
    fail(lane, conn, regrant("25a"));
  };

  const channelErrored = (lane: Lane, conn: Connection, payload: unknown) => {
    if (!current(lane, conn)) return;
    if (isRecord(payload) && payload.source === "transport") {
      // phoenix.js reports a transport failure on the channel too; the socket's own close or error callback (which runs
      // in the same call) classifies it by its close code. Only a heartbeat timeout has no socket row of its own.
      if (payload.reason === "heartbeat_timeout")
        fail(lane, conn, regrant("25a"));
      return;
    }
    fail(lane, conn, regrant(conn.inflight ? "41" : "45"));
  };

  const expired = (lane: Lane, conn: Connection, payload: unknown) => {
    const reason = reasonOf(payload);
    switch (reason) {
      case "session_expired":
        fail(lane, conn, regrant("42"));
        return;
      case "trajectories_not_enabled":
        fail(lane, conn, { kind: "hold", reason: NOT_ENABLED });
        return;
      case "entitlement_unavailable":
        fail(lane, conn, { kind: "retry", reason: ENTITLEMENT });
        return;
      default:
        fail(lane, conn, regrant("45a", reason));
    }
  };

  const open = (lane: Lane, conn: Connection, grant: TrajectoryGrant) => {
    const socket = socketFactory(grant.realtime.clientUrl, {
      join_token: grant.joinToken,
    });
    conn.socket = socket;
    conn.socketRefs.push(
      socket.onOpen(() => {
        conn.opened = true;
      }),
      socket.onError(() => socketFailed(lane, conn)),
      socket.onClose((event) => socketFailed(lane, conn, event?.code)),
    );
    const channel = socket.channel(grant.realtime.topic);
    conn.channel = channel;
    conn.channelRefs.push(
      [
        "phx_error",
        channel.onError((payload) => channelErrored(lane, conn, payload)),
      ],
      ["phx_close", channel.onClose(() => fail(lane, conn, regrant("45")))],
      [
        "expired",
        channel.on("expired", (payload) => expired(lane, conn, payload)),
      ],
    );
    socket.connect();
    const timedOut = () => fail(lane, conn, { kind: "retry", reason: BUSY });
    conn.joinTimer = timers.set(timedOut, PHOENIX_TIMEOUT_MS);
    channel
      .join(PHOENIX_TIMEOUT_MS)
      .receive("ok", () => joined(lane, conn))
      .receive("error", (response) => {
        if (current(lane, conn)) joinRefused(lane, conn, response);
      })
      .receive("timeout", timedOut);
  };

  /** A fresh pass for every connection: a spent pass is never reused. */
  const connect = async (lane: Lane): Promise<void> => {
    if (halted() || lane.meta.closed || lane.closing || lane.conn) return;
    clear(lane.timer);
    lane.timer = undefined;
    const conn: Connection = {
      socket: null,
      channel: null,
      socketRefs: [],
      channelRefs: [],
      opened: false,
      joined: false,
      dead: false,
      joinTimer: undefined,
      inflight: null,
      pushRetry: undefined,
    };
    lane.conn = conn;
    emitStatus();
    let grant: TrajectoryGrant;
    try {
      grant = await deps.fetchGrant(lane.id);
    } catch (error) {
      fail(lane, conn, passFailure(error));
      return;
    }
    if (!current(lane, conn)) return;
    conn.gatewayUrl = grant.realtime.clientUrl;
    if (!isAllowedGatewayUrl(grant.realtime.clientUrl, allowedGatewayUrls)) {
      fail(lane, conn, {
        kind: "park",
        reason: PASS_HINTS.GATEWAY_NOT_ALLOWED,
      });
      return;
    }
    open(lane, conn, grant);
  };

  const wake = (lane: Lane) => {
    if (lane.conn?.joined) void pump(lane);
  };

  /** Assigns the event the next seq and puts it in the lane's outbox, valid for Intelligence, with the held step's key it
   * carries. */
  const queue = async (
    lane: Lane,
    event: CapturedEvent,
    stepKey?: string,
  ): Promise<void> => {
    const seq = deps.sequencer.next();
    const prepared = prepareEvent(event, seq, now());
    if (!prepared) {
      lane.meta.droppedPending += 1;
      countsOf(lane.meta.recordingId).dropped += 1;
      await persist(lane);
      emitStatus();
      return;
    }
    await outbox.put(
      {
        trajectoryId: lane.id,
        seq,
        event: prepared.event,
        bytes: prepared.bytes,
      },
      stepKey,
    );
    lane.pending += 1;
    lane.meta.pushed += 1;
    await persist(lane);
    wake(lane);
  };

  const custom = (
    name: string,
    value: Record<string, JsonValue>,
    at: number = now(),
  ): CapturedEvent => ({
    type: "CUSTOM",
    name,
    timestamp: at,
    value,
  });

  /** A new trajectory's first events, stamped when its recording began (never later than now, never in the future).
   * After Start over they name the trajectory it replaced. */
  const begin = async (
    lane: Lane,
    startedAt: number | undefined,
    previousTrajectoryId?: string,
  ) => {
    const at = Math.min(startedAt ?? now(), now());
    await queue(
      lane,
      custom(
        "recording.started",
        {
          recordingId: lane.meta.recordingId,
          source: "openbot-recorder",
          version: session.version,
          ...(previousTrajectoryId === undefined
            ? {}
            : { previousTrajectoryId }),
        },
        at,
      ),
    );
    await queue(
      lane,
      custom("outcome", { workflow: lane.meta.title, phase: "started" }, at),
    );
  };

  /** Moves new events to a linked trajectory before the current one can reach Intelligence's cap. */
  const rollover = async (old: Lane): Promise<Lane> => {
    const nextId = deps.randomUUID();
    await queue(
      old,
      custom("recording.continued", { nextTrajectoryId: nextId }),
    );
    const next = makeLane(
      nextId,
      freshMeta(old.meta.recordingId, old.meta.title),
      0,
    );
    lanes.push(next);
    await persist(next);
    old.meta.next = nextId;
    old.meta.stopped = true;
    await persist(old);
    await queue(
      next,
      custom("recording.continues", {
        previousTrajectoryId: old.id,
        recordingId: old.meta.recordingId,
      }),
    );
    deps.onTrajectory(next.id, next.meta.recordingId);
    void connect(next);
    maybeClose(old);
    return next;
  };

  const currentLane = (): Lane => {
    const own = lanesOf(recordingId);
    return own[own.length - 1];
  };

  const queueLive = async (event: CapturedEvent, stepKey?: string) => {
    // A step that left before a restart or a quit, sent again from the held steps the service worker kept: stored once.
    if (
      stepKey !== undefined &&
      (await outbox.hasStep(
        lanes.map((lane) => lane.id),
        stepKey,
      ))
    )
      return;
    let lane = currentLane();
    if (lane.meta.closed) {
      console.error(
        "Recorder: an event arrived after its trajectory was closed",
        event.name,
      );
      return;
    }
    if (
      !session.recover &&
      !lane.meta.stopped &&
      lane.meta.pushed >= rolloverAt
    ) {
      lane = await rollover(lane);
    }
    await queue(lane, event, stepKey);
  };

  // Open the trajectory, or reopen it and the ones it rolled over to.
  const first = session.resume
    ? await outbox.getMeta<StoredMeta>(trajectoryMetaKey(session.trajectoryId))
    : undefined;
  if (first) {
    let id: string | undefined = session.trajectoryId;
    let meta: StoredMeta | undefined = first;
    while (id !== undefined && meta) {
      lanes.push(makeLane(id, meta, await outbox.count(id)));
      id = meta.next;
      meta =
        id === undefined
          ? undefined
          : await outbox.getMeta<StoredMeta>(trajectoryMetaKey(id));
    }
  } else if (
    session.recover &&
    (await outbox.count(session.trajectoryId)) === 0
  ) {
    // A recording with neither a record nor an event left finished: its records go once it is done (`forget`). Nothing
    // is sent for it again, and no record is written back.
    const done = makeLane(
      session.trajectoryId,
      {
        ...freshMeta(session.recordingId, session.title),
        stopped: true,
        outcomeQueued: true,
        closed: true,
      },
      0,
    );
    done.forgotten = true;
    lanes.push(done);
  } else {
    const lane = makeLane(
      session.trajectoryId,
      freshMeta(session.recordingId, session.title),
      0,
    );
    lanes.push(lane);
    void enqueue(async () => {
      await persist(lane);
      await begin(lane, session.startedAt);
    }).catch(() => undefined);
  }
  for (const lane of lanes) {
    if (lane.meta.closed) continue;
    maybeClose(lane);
    void connect(lane);
  }
  emitStatus();

  return {
    push(event, stepKey) {
      if (discarded) return;
      void enqueue(() => queueLive(event, stepKey)).catch(() => undefined);
    },

    async rotate(next) {
      if (!next.title.trim()) {
        throw new Error(
          "A recording needs a title: Intelligence refuses an outcome without a workflow.",
        );
      }
      const previous = recordingId;
      await enqueue(async () => {
        const old = currentLane();
        if (!old.meta.outcomeQueued && !old.meta.closed) {
          // Ended by Start over, linked to the trajectory that takes over as a rollover links its next one.
          await queue(
            old,
            custom("recording.restarted", {
              nextTrajectoryId: next.trajectoryId,
              nextRecordingId: next.recordingId,
            }),
          );
          await queue(
            old,
            custom("outcome", {
              workflow: old.meta.title,
              phase: "failed",
              reason: "restarted",
            }),
          );
          old.meta.outcomeQueued = true;
        }
        old.meta.stopped = true;
        await persist(old);
        reportStillKept(old.meta.recordingId);
        recordingId = next.recordingId;
        const lane = makeLane(
          next.trajectoryId,
          freshMeta(next.recordingId, next.title),
          0,
        );
        lanes.push(lane);
        await persist(lane);
        await begin(lane, next.startedAt, old.id);
        emitStatus();
        void connect(lane);
        maybeClose(old);
      });
      await closedAll(previous);
    },

    stop(outcome, extra) {
      return enqueue(async () => {
        const lane = currentLane();
        if (!lane.meta.outcomeQueued && !lane.meta.closed) {
          await queue(
            lane,
            custom("outcome", {
              workflow: lane.meta.title,
              phase: outcome,
              ...extra,
            }),
          );
          lane.meta.outcomeQueued = true;
        }
        lane.meta.stopped = true;
        await persist(lane);
        reportStillKept(recordingId);
        maybeClose(lane);
        return {
          trajectoryIds: lanesOf(recordingId).map((own) => own.id),
        };
      });
    },

    drained() {
      return closedAll(recordingId);
    },

    async discard() {
      discarded = true;
      for (const lane of lanes) {
        if (lane.conn) teardown(lane.conn);
        lane.conn = null;
        clear(lane.timer);
        lane.timer = undefined;
      }
      await chain;
      for (const lane of lanes) await outbox.clear(lane.id);
    },

    async halt() {
      if (!halted()) stopSending();
      await chain;
    },

    async forget(recording) {
      const own = lanesOf(recording);
      if (own.length === 0 || !own.every((lane) => lane.meta.closed)) return;
      for (const lane of own) lane.forgotten = true;
      // Newest first: a step cut short leaves the start of the chain, never a record that no chain reaches.
      await enqueue(async () => {
        for (const lane of [...own].reverse()) await outbox.clear(lane.id);
      });
    },

    allow(urls) {
      allowedGatewayUrls = urls;
      for (const lane of lanes) {
        const conn = lane.conn;
        if (
          conn?.gatewayUrl !== undefined &&
          !isAllowedGatewayUrl(conn.gatewayUrl, urls)
        )
          fail(lane, conn, {
            kind: "park",
            reason: PASS_HINTS.GATEWAY_NOT_ALLOWED,
          });
      }
    },
  };
}
