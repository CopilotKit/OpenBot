import type { TrajectoryGrant } from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import {
  type BackgroundToOffscreen,
  type CaptureStatus,
  type OffscreenToBackground,
  PORT_OFFSCREEN,
  type StreamSession,
} from "../protocol/messages";
import type { DrainRecord } from "../shared/storage";
import { fetchGrant, GrantError } from "./grant";
import {
  type Outbox,
  openOutbox,
  type TrajectoryMeta,
  trajectoryMetaKey,
} from "./outbox";
import { createSequencer } from "./sequencer";
import {
  createStreamer,
  type KeptReport,
  type Streamer,
  type StreamerSession,
  type StreamerStatus,
} from "./streamer";

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
type SignedOutReason = "revoked" | "removed" | "organization";
type Target = { openbotUrl: string; token: string };

export type OffscreenControllerDeps = {
  openOutbox: () => Promise<Outbox>;
  connectPort(): chrome.runtime.Port;
  /** Test seams: the clock and timers of the controller, its sequencer and its streamers, and where a trajectory rolls over. */
  now?: () => number;
  timers?: Timers;
  rolloverAt?: number;
};

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000];
/** The sequencer's last issued seq, in the outbox's meta store. */
const SEQ_META_KEY = "seq";
/** Answers the service worker must not miss: one that could not be delivered is posted again once the port is back. */
const DELIVER_ONCE_BACK = new Set<OffscreenToBackground["type"]>([
  "offscreen.trajectory",
  "offscreen.stopped",
  "offscreen.kept",
  "offscreen.done",
  "offscreen.signed-out",
]);

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One streamer this document runs, and the connection it streams for. */
type Stream = {
  /** The token is replaced when the person connects this browser again while it still streams (offscreen.recover). */
  target: Target;
  /** The Bot its recordings are for, named on every pass (Start over keeps the Bot). */
  botId: string;
  /** Recordings it still sends; one leaves when it is done, replaced by Start over, or discarded. */
  recordings: Set<string>;
  signedOut: boolean;
  /** The bearer the pass OpenBot answered "signed out" to used. */
  failedToken?: string;
  streamer?: Streamer;
};

/** The recording this document records now (offscreen.start or offscreen.resume). */
type Live = {
  session: StreamSession;
  recordingId: string;
  /** The trajectory its status is reported for: the service worker shows only statuses of the recording's trajectories. */
  trajectoryId: string;
  capture: Partial<CaptureStatus>;
  stream: Stream | null;
  /** While above 0 (its streamer is being created, or Start over is switching it), events wait in `waiting`. */
  holds: number;
  waiting: CapturedEvent[];
  /** From the moment Stop queues its outcome: kept events are reported with offscreen.kept from then on. */
  ending: boolean;
  stopped: { trajectoryIds: string[] } | null;
};

/**
 * The offscreen document: streams captured events to Intelligence from its IndexedDB outbox and answers the service
 * worker over its port; every message that ends a recording's work is posted again if the service worker restarted
 * before it could be delivered.
 */
export function createOffscreenController(deps: OffscreenControllerDeps): void {
  const timers = deps.timers ?? realTimers;
  const now = deps.now ?? Date.now;

  // ---- The port to the service worker ------------------------------------------------------------

  let port: chrome.runtime.Port | null = null;
  /** The service worker has posted on the current port, so it is there and gets what is posted. */
  let established = false;
  /** Posted on a port that has not proved itself yet: posted again if that port goes before it does. */
  let probation: OffscreenToBackground[] = [];
  const undelivered: OffscreenToBackground[] = [];
  let reconnects = 0;
  let lastStatus: {
    capture: Partial<CaptureStatus>;
    trajectoryId: string;
  } | null = null;

  function post(message: OffscreenToBackground): void {
    const keep = DELIVER_ONCE_BACK.has(message.type);
    if (port) {
      try {
        port.postMessage(message);
        if (keep && !established) probation.push(message);
        return;
      } catch (error) {
        console.error(
          "Recorder: the service worker's port refused a message",
          error,
        );
      }
    }
    if (keep) undelivered.push(message);
  }

  function connect(): void {
    let next: chrome.runtime.Port;
    try {
      next = deps.connectPort();
    } catch (error) {
      console.error("Recorder: the service worker could not be reached", error);
      scheduleReconnect();
      return;
    }
    port = next;
    established = false;
    probation = [];
    next.onMessage.addListener((message: BackgroundToOffscreen) => {
      if (port === next && !established) {
        established = true;
        probation = [];
        reconnects = 0;
      }
      receive(message);
    });
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      port = null;
      undelivered.unshift(...probation);
      probation = [];
      scheduleReconnect();
    });
    post({ type: "offscreen.ready" });
    if (lastStatus) post({ type: "offscreen.status", ...lastStatus });
    for (const message of undelivered.splice(0)) post(message);
  }

  function scheduleReconnect(): void {
    const delay =
      RECONNECT_DELAYS_MS[Math.min(reconnects, RECONNECT_DELAYS_MS.length - 1)];
    reconnects += 1;
    timers.set(connect, delay);
  }

  // ---- Shared storage and the streams ------------------------------------------------------------

  let stores: Promise<{
    outbox: Outbox;
    sequencer: { next(): number; flush(): Promise<void> };
  }> | null = null;
  function storage() {
    stores ??= (async () => {
      const outbox = await deps.openOutbox();
      const sequencer = await createSequencer({
        now,
        timers,
        load: async () => (await outbox.getMeta<number>(SEQ_META_KEY)) ?? null,
        save: (last) =>
          outbox.setMeta(SEQ_META_KEY, last).catch((error) => {
            console.error("Recorder: the last seq could not be saved", error);
          }),
      });
      return { outbox, sequencer };
    })();
    stores.catch(() => {
      stores = null;
    });
    return stores;
  }

  const streams: Stream[] = [];
  /** Which recording each trajectory belongs to; kept in memory, since a discard clears the meta. */
  const owners = new Map<string, string>();
  /** Tokens OpenBot answered "signed out" for, with the guard's reason: nothing more is sent with them. */
  const signedOutTokens = new Map<string, SignedOutReason>();
  let live: Live | null = null;
  let work: Promise<void> = Promise.resolve();

  /** Handles one message at a time, in the order the service worker posted them; nothing awaits a drain here. */
  function serially(task: () => Promise<void>, what: string): void {
    work = work.then(task).catch((error) => {
      console.error(
        `Recorder: the offscreen document could not ${what}`,
        error,
      );
    });
  }

  const streaming = (recordingId: string) =>
    streams.find(
      (stream) =>
        stream.streamer &&
        !stream.signedOut &&
        stream.recordings.has(recordingId),
    );

  function finished(stream: Stream, recordingId: string): void {
    stream.recordings.delete(recordingId);
    const index = streams.indexOf(stream);
    if (stream.recordings.size === 0 && live?.stream !== stream && index >= 0)
      streams.splice(index, 1);
  }

  /** A resumed recording's trajectories, rolled-over ones included, as its outbox links them. */
  async function rememberChain(
    outbox: Outbox,
    trajectoryId: string,
    recordingId: string,
  ): Promise<void> {
    let id: string | undefined = trajectoryId;
    while (id !== undefined && !owners.has(id)) {
      owners.set(id, recordingId);
      id = (await outbox.getMeta<TrajectoryMeta>(trajectoryMetaKey(id)))?.next;
    }
  }

  /** A token OpenBot already signed out: the request is refused here, without reaching OpenBot. */
  function signedOutReason(
    stream: Stream,
    token: string,
  ): SignedOutReason | undefined {
    const reason = signedOutTokens.get(token);
    if (reason) stream.failedToken = token;
    return reason;
  }

  async function pass(
    stream: Stream,
    trajectoryId: string,
  ): Promise<TrajectoryGrant> {
    const { openbotUrl, token } = stream.target;
    const reason = signedOutReason(stream, token);
    if (reason) throw new GrantError({ kind: "signed-out", reason });
    try {
      return await fetchGrant(
        { openbotUrl, token, botId: stream.botId },
        trajectoryId,
      );
    } catch (error) {
      if (error instanceof GrantError && error.verdict.kind === "signed-out")
        stream.failedToken = token;
      throw error;
    }
  }

  function signedOut(stream: Stream, reason: SignedOutReason): void {
    stream.signedOut = true;
    const token = stream.failedToken ?? stream.target.token;
    if (signedOutTokens.has(token)) return;
    signedOutTokens.set(token, reason);
    post({ type: "offscreen.signed-out", reason, token });
  }

  function postStatus(target: Live, capture: Partial<CaptureStatus>): void {
    if (live !== target) return;
    target.capture = { ...target.capture, ...capture };
    lastStatus = { capture: target.capture, trajectoryId: target.trajectoryId };
    post({
      type: "offscreen.status",
      capture,
      trajectoryId: target.trajectoryId,
    });
  }

  function streamerStatus(stream: Stream, update: StreamerStatus): void {
    const target = live;
    // Only the live recording's streamer reports a status; the service worker also filters by trajectory.
    if (!target || target.stream !== stream) return;
    target.trajectoryId = update.trajectoryId;
    if (update.reason === undefined) delete target.capture.intelligenceReason;
    postStatus(target, {
      intelligence: update.intelligence,
      ...(update.reason === undefined
        ? {}
        : { intelligenceReason: update.reason }),
      events: update.events,
    });
  }

  function kept(stream: Stream, report: KeptReport): void {
    const target = live;
    const recording =
      target?.stream === stream &&
      target.recordingId === report.recordingId &&
      !target.ending;
    // While it still records, its status says so.
    if (recording) return;
    post({
      type: "offscreen.kept",
      recordingId: report.recordingId,
      reason: report.reason,
      parked: report.parked,
      events: report.events,
    });
  }

  async function openStream(
    session: StreamerSession,
    target: Target,
    botId: string,
    options: {
      live: Live | null;
      allowedGatewayUrls: string[] | null;
      holdRetryMs?: number;
    },
  ): Promise<Stream & { streamer: Streamer }> {
    const { outbox, sequencer } = await storage();
    if (session.resume)
      await rememberChain(outbox, session.trajectoryId, session.recordingId);
    else owners.set(session.trajectoryId, session.recordingId);
    const stream: Stream = {
      target: { ...target },
      botId,
      recordings: new Set([session.recordingId]),
      signedOut: false,
    };
    streams.push(stream);
    // Before the streamer exists, so its first status (sent while it is created) is the live recording's.
    if (options.live) options.live.stream = stream;
    try {
      const streamer = await createStreamer(session, {
        fetchGrant: (trajectoryId) => pass(stream, trajectoryId),
        allowedGatewayUrls: options.allowedGatewayUrls,
        outbox,
        sequencer,
        status: (update) => streamerStatus(stream, update),
        onTrajectory: (trajectoryId, recordingId) => {
          owners.set(trajectoryId, recordingId);
          post({ type: "offscreen.trajectory", recordingId, trajectoryId });
        },
        onSignedOut: (reason) => signedOut(stream, reason),
        onKept: (report) => kept(stream, report),
        randomUUID: () => crypto.randomUUID(),
        holdRetryMs: options.holdRetryMs,
        rolloverAt: deps.rolloverAt,
        now,
        timers,
      });
      return Object.assign(stream, { streamer });
    } catch (error) {
      streams.splice(streams.indexOf(stream), 1);
      if (options.live?.stream === stream) options.live.stream = null;
      throw error;
    }
  }

  // ---- The live recording ------------------------------------------------------------------------

  function deliver(target: Live, event: CapturedEvent): void {
    const streamer = target.stream?.streamer;
    if (target.holds > 0 || !streamer) {
      if (target.holds > 0) target.waiting.push(event);
      else
        console.error(
          "Recorder: an event was dropped: its recording has no streamer",
          event.name,
        );
      return;
    }
    streamer.push(event);
  }

  function release(target: Live): void {
    target.holds -= 1;
    if (target.holds > 0) return;
    for (const event of target.waiting.splice(0)) deliver(target, event);
  }

  async function begin(target: Live, resume: boolean): Promise<void> {
    const { session } = target;
    try {
      const existing = streaming(session.recordingId);
      if (existing) {
        existing.target.token = session.token;
        target.stream = existing;
        return;
      }
      await openStream(
        {
          trajectoryId: session.trajectoryId,
          title: session.title,
          recordingId: session.recordingId,
          version: session.version,
          ...(resume ? { resume: true } : {}),
        },
        { openbotUrl: session.openbotUrl, token: session.token },
        session.botId,
        {
          live: target,
          allowedGatewayUrls: session.allowedIntelligenceUrls,
          holdRetryMs:
            import.meta.env.RECORDER_VARIANT === "e2e"
              ? session.e2eHoldRetryMs
              : undefined,
        },
      );
    } finally {
      release(target);
    }
  }

  function startLive(session: StreamSession, resume: boolean): void {
    const target: Live = {
      session,
      recordingId: session.recordingId,
      trajectoryId: session.trajectoryId,
      capture: {},
      stream: null,
      holds: 1,
      waiting: [],
      ending: false,
      stopped: null,
    };
    live = target;
    serially(
      () => begin(target, resume),
      resume ? "resume a recording" : "start a recording",
    );
  }

  async function rotate(
    target: Live,
    recordingId: string,
    trajectoryId: string,
  ): Promise<void> {
    try {
      const stream = target.stream;
      const streamer = stream?.streamer;
      if (!stream || !streamer || target.ending) {
        console.error(
          "Recorder: Start over arrived for a recording this document does not stream",
        );
        return;
      }
      const previous = target.recordingId;
      owners.set(trajectoryId, recordingId);
      stream.recordings.add(recordingId);
      // Switched before the streamer reports anything for it: the replaced recording's kept events are offscreen.kept.
      target.recordingId = recordingId;
      target.trajectoryId = trajectoryId;
      const rotated = streamer.rotate({
        recordingId,
        trajectoryId,
        title: target.session.title,
      });
      void rotated.then(
        () => {
          finished(stream, previous);
          // Its trajectories are drained and finished, its failed outcome included: nothing is left of it.
          post({ type: "offscreen.done", recordingId: previous });
        },
        (error) => {
          console.error(
            "Recorder: Start over could not switch the recording",
            error,
          );
        },
      );
    } finally {
      // After the switch: the events that waited belong to the new recording.
      release(target);
    }
  }

  async function stop(
    target: Live,
    message: Extract<BackgroundToOffscreen, { type: "offscreen.stop" }>,
  ): Promise<void> {
    if (target.stopped) {
      // The service worker restarted mid-Stop and asks again.
      post({
        type: "offscreen.stopped",
        recordingId: target.recordingId,
        trajectoryIds: target.stopped.trajectoryIds,
      });
      return;
    }
    const stream = target.stream;
    const streamer = stream?.streamer;
    if (!stream || !streamer) {
      // The streamer never started (its storage failed to open): nothing was sent, but the recording still ends.
      console.error(
        "Recorder: Stop arrived for a recording whose streamer never started",
      );
      target.ending = true;
      const recordingId = target.recordingId;
      target.stopped = { trajectoryIds: [] };
      post({ type: "offscreen.stopped", recordingId, trajectoryIds: [] });
      post({ type: "offscreen.done", recordingId });
      return;
    }
    target.ending = true;
    const recordingId = target.recordingId;
    const { trajectoryIds } =
      message.outcome === "failed"
        ? await streamer.stop("failed", { reason: message.reason })
        : await streamer.stop("succeeded");
    target.stopped = { trajectoryIds };
    post({ type: "offscreen.stopped", recordingId, trajectoryIds });
    void streamer.drained().then(
      () => {
        finished(stream, recordingId);
        post({ type: "offscreen.done", recordingId });
      },
      (error) => {
        console.error(
          "Recorder: a stopped recording could not finish sending",
          error,
        );
      },
    );
  }

  // ---- Recovery and discard ----------------------------------------------------------------------

  async function finishRecovery(
    stream: Stream & { streamer: Streamer },
    drain: DrainRecord,
  ): Promise<void> {
    // The streamer queues the interrupted outcome only when none was queued.
    await stream.streamer.stop("failed", { reason: "interrupted" });
    await stream.streamer.drained();
    finished(stream, drain.recordingId);
    post({ type: "offscreen.done", recordingId: drain.recordingId });
  }

  async function recover(
    message: Extract<BackgroundToOffscreen, { type: "offscreen.recover" }>,
  ): Promise<void> {
    const target: Target = {
      openbotUrl: message.openbotUrl,
      token: message.token,
    };
    for (const drain of message.drains) {
      const current = streaming(drain.recordingId);
      if (current) {
        // Never a second streamer for one recording: the one sending it goes on, with the new connection's token.
        if (current.target.openbotUrl === target.openbotUrl)
          current.target.token = target.token;
        continue;
      }
      for (const stale of streams.filter(
        (stream) =>
          stream.signedOut && stream.recordings.has(drain.recordingId),
      ))
        finished(stale, drain.recordingId);
      const [first] = drain.trajectoryIds;
      if (first === undefined) {
        console.error(
          "Recorder: a kept recording has no trajectory to recover",
          drain.recordingId,
        );
        continue;
      }
      for (const trajectoryId of drain.trajectoryIds)
        owners.set(trajectoryId, drain.recordingId);
      const stream = await openStream(
        {
          trajectoryId: first,
          title: drain.title,
          recordingId: drain.recordingId,
          version: chrome.runtime.getManifest().version,
          resume: true,
          recover: true,
        },
        target,
        drain.botId,
        // The policy the recover was sent with, never a live recording's: a gateway it does not allow gets no socket,
        // and the recording stays parked with its events kept.
        { live: null, allowedGatewayUrls: message.allowedIntelligenceUrls },
      );
      void finishRecovery(stream, drain).catch((error) => {
        console.error(
          "Recorder: a kept recording could not be recovered",
          error,
        );
      });
    }
  }

  async function clearOutbox(
    outbox: Outbox,
    recordingId: string,
  ): Promise<void> {
    for (const trajectoryId of await outbox.trajectories()) {
      const meta = await outbox.getMeta<TrajectoryMeta>(
        trajectoryMetaKey(trajectoryId),
      );
      const owner = meta?.recordingId ?? owners.get(trajectoryId);
      if (owner === recordingId) await outbox.clear(trajectoryId);
    }
  }

  /** The person's own "Discard kept events" or Disconnect, or a Record that never went live. */
  async function discard(recordingIds: string[]): Promise<void> {
    const wanted = new Set(recordingIds);
    const dropped: Streamer[] = [];
    for (const stream of [...streams]) {
      const own = [...stream.recordings].filter((id) => wanted.has(id));
      if (own.length === 0) continue;
      if (own.length === stream.recordings.size) {
        if (stream.streamer) dropped.push(stream.streamer);
        stream.recordings.clear();
        streams.splice(streams.indexOf(stream), 1);
      } else {
        // It also sends a recording that goes on (Start over replaced the discarded one): only the discarded one's
        // events are cleared below.
        for (const id of own) stream.recordings.delete(id);
      }
    }
    if (live && wanted.has(live.recordingId)) live = null;
    const { outbox } = await storage();
    // Later messages do not wait for the clearing.
    void (async () => {
      await Promise.all(dropped.map((streamer) => streamer.discard()));
      for (const recordingId of recordingIds) {
        await clearOutbox(outbox, recordingId);
        // The service worker closes the document once nothing it holds is still sending.
        post({ type: "offscreen.done", recordingId });
      }
    })().catch((error) => {
      console.error("Recorder: kept recordings could not be discarded", error);
    });
  }

  // ---- Messages in -------------------------------------------------------------------------------

  function receive(message: BackgroundToOffscreen): void {
    const target = live;
    switch (message.type) {
      case "offscreen.event":
        if (target) deliver(target, message.event);
        else
          console.error(
            "Recorder: an event arrived with no recording in this document",
            message.event.name,
          );
        return;
      case "offscreen.start":
      case "offscreen.resume":
        startLive(message.session, message.type === "offscreen.resume");
        return;
      case "offscreen.rotate":
        if (!target) {
          console.error(
            "Recorder: Start over arrived with no recording in this document",
          );
          return;
        }
        target.holds += 1;
        serially(
          () => rotate(target, message.recordingId, message.trajectoryId),
          "start over",
        );
        return;
      case "offscreen.stop":
        if (!target) return;
        serially(() => stop(target, message), "stop the recording");
        return;
      case "offscreen.recover":
        serially(() => recover(message), "recover kept recordings");
        return;
      case "offscreen.discard":
        serially(() => discard(message.recordingIds), "discard recordings");
        return;
    }
  }

  connect();
}

// The extension's own offscreen document runs the controller once; tests import the factory without running it.
if (globalThis.location?.protocol === "chrome-extension:") {
  createOffscreenController({
    openOutbox: () => openOutbox(),
    connectPort: () => chrome.runtime.connect({ name: PORT_OFFSCREEN }),
  });
}
