import {
  RECORDER_SIGNED_OUT,
  recorderPaths,
  type TrajectoryGrant,
} from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import {
  type BackgroundToOffscreen,
  type CaptureStatus,
  type OffscreenToBackground,
  PORT_OFFSCREEN,
  type StreamSession,
} from "../protocol/messages";
import { OpenBotError, openbotJson } from "../shared/openbot-client";
import type { DrainRecord } from "../shared/storage";
import { fetchGrant, GrantError } from "./grant";
import {
  discardMedia,
  type MediaHandle,
  type MediaSinks,
  recoverMedia,
  startMedia,
} from "./media";
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
  startMedia: typeof startMedia;
  recoverMedia: typeof recoverMedia;
  discardMedia: typeof discardMedia;
  openOutbox: () => Promise<Outbox>;
  connectPort(): chrome.runtime.Port;
  /** Test seams: the clock and timers of the controller, its sequencer and its streamers, and where a trajectory rolls over. */
  now?: () => number;
  timers?: Timers;
  rolloverAt?: number;
};

const HEARTBEAT_MS = 30_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000];
/** The sequencer's last issued seq, in the outbox's meta store. */
const SEQ_META_KEY = "seq";
/** Answers the service worker must not miss: one that could not be delivered is posted again once the port is back. */
const DELIVER_ONCE_BACK = new Set<OffscreenToBackground["type"]>([
  "offscreen.trajectory",
  "offscreen.stopped",
  "offscreen.rotated",
  "offscreen.kept",
  "offscreen.done",
  "offscreen.signed-out",
]);
const SIGNED_OUT_SENTENCE = "This browser is signed out of OpenBot.";

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
  demonstrations: Set<string>;
  signedOut: boolean;
  /** The bearer the request OpenBot answered "signed out" to used. */
  failedToken?: string;
  streamer?: Streamer;
};

/** The recording this document records now (offscreen.start or offscreen.resume). */
type Live = {
  session: StreamSession;
  demonstrationId: string;
  /** The trajectory its status is reported for: the service worker shows only statuses of the recording's trajectories. */
  trajectoryId: string;
  capture: Partial<CaptureStatus>;
  /** Started the moment the message arrives; null when screen and voice could not start. */
  media: Promise<MediaHandle | null>;
  stream: Stream | null;
  /** While above 0 (its streamer is being created, or Start over is switching it), events wait in `waiting`. */
  holds: number;
  waiting: CapturedEvent[];
  /** From the moment Stop queues its outcome: kept events are reported with offscreen.kept from then on. */
  ending: boolean;
  stopped: { trajectoryIds: string[] } | null;
};

/**
 * The offscreen document: records the screen and voice, streams captured events to Intelligence and answers the service
 * worker over its port. Media starts first at Record, because the tab stream id expires within seconds; every message
 * that ends a recording's work is posted again if the service worker restarted before it could be delivered.
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
  /** Which recording each trajectory belongs to, for OpenBot's routes; kept in memory, since a discard clears the meta. */
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

  const streaming = (demonstrationId: string) =>
    streams.find(
      (stream) =>
        stream.streamer &&
        !stream.signedOut &&
        stream.demonstrations.has(demonstrationId),
    );

  function finished(stream: Stream, demonstrationId: string): void {
    stream.demonstrations.delete(demonstrationId);
    const index = streams.indexOf(stream);
    if (
      stream.demonstrations.size === 0 &&
      live?.stream !== stream &&
      index >= 0
    )
      streams.splice(index, 1);
  }

  async function ownerOf(
    outbox: Outbox,
    trajectoryId: string,
  ): Promise<string> {
    const known = owners.get(trajectoryId);
    if (known) return known;
    const meta = await outbox.getMeta<TrajectoryMeta>(
      trajectoryMetaKey(trajectoryId),
    );
    if (!meta)
      throw new Error(`No recording is known for trajectory ${trajectoryId}.`);
    owners.set(trajectoryId, meta.demonstrationId);
    return meta.demonstrationId;
  }

  /** A resumed recording's trajectories, rolled-over ones included, as its outbox links them. */
  async function rememberChain(
    outbox: Outbox,
    trajectoryId: string,
    demonstrationId: string,
  ): Promise<void> {
    let id: string | undefined = trajectoryId;
    while (id !== undefined && !owners.has(id)) {
      owners.set(id, demonstrationId);
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

  const signedOutError = (reason: SignedOutReason) =>
    new OpenBotError(401, SIGNED_OUT_SENTENCE, {
      error: SIGNED_OUT_SENTENCE,
      code: RECORDER_SIGNED_OUT,
      reason,
    });

  async function register(
    stream: Stream,
    outbox: Outbox,
    trajectoryId: string,
  ): Promise<void> {
    const { openbotUrl, token } = stream.target;
    const reason = signedOutReason(stream, token);
    if (reason) throw signedOutError(reason);
    const demonstrationId = await ownerOf(outbox, trajectoryId);
    try {
      await openbotJson(
        { openbotUrl, token },
        recorderPaths.trajectories(demonstrationId),
        { body: { trajectoryId } },
      );
    } catch (error) {
      if (error instanceof OpenBotError && error.signedOut)
        stream.failedToken = token;
      throw error;
    }
  }

  async function closeTrajectory(
    stream: Stream,
    outbox: Outbox,
    trajectoryId: string,
  ): Promise<void> {
    const { openbotUrl, token } = stream.target;
    const reason = signedOutTokens.get(token);
    if (reason) throw signedOutError(reason);
    const demonstrationId = await ownerOf(outbox, trajectoryId);
    try {
      await openbotJson(
        { openbotUrl, token },
        recorderPaths.closeTrajectory(demonstrationId, trajectoryId),
        { method: "POST" },
      );
    } catch (error) {
      // OpenBot's own 404: it no longer knows the recording (a Record that could not start is deleted at once), so
      // nothing is left to close and the recording can report done.
      if (
        error instanceof OpenBotError &&
        error.status === 404 &&
        error.body !== null
      ) {
        console.error(
          "Recorder: OpenBot no longer knows a trajectory it was asked to close",
          error,
        );
        return;
      }
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
      target.demonstrationId === report.demonstrationId &&
      !target.ending;
    // While it still records, its status says so.
    if (recording) return;
    post({
      type: "offscreen.kept",
      demonstrationId: report.demonstrationId,
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
      await rememberChain(
        outbox,
        session.trajectoryId,
        session.demonstrationId,
      );
    else owners.set(session.trajectoryId, session.demonstrationId);
    const stream: Stream = {
      target: { ...target },
      botId,
      demonstrations: new Set([session.demonstrationId]),
      signedOut: false,
    };
    streams.push(stream);
    // Before the streamer exists, so its first status (sent while it is created) is the live recording's.
    if (options.live) options.live.stream = stream;
    try {
      const streamer = await createStreamer(session, {
        fetchGrant: (trajectoryId) => pass(stream, trajectoryId),
        registerTrajectory: (trajectoryId) =>
          register(stream, outbox, trajectoryId),
        closeTrajectory: (trajectoryId) =>
          closeTrajectory(stream, outbox, trajectoryId),
        allowedGatewayUrls: options.allowedGatewayUrls,
        outbox,
        sequencer,
        status: (update) => streamerStatus(stream, update),
        onTrajectory: (trajectoryId, demonstrationId) => {
          owners.set(trajectoryId, demonstrationId);
          post({ type: "offscreen.trajectory", demonstrationId, trajectoryId });
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

  let heartbeat: unknown;
  function beat(): void {
    heartbeat = timers.set(() => {
      post({ type: "offscreen.heartbeat" });
      beat();
    }, HEARTBEAT_MS);
  }
  function stopBeat(): void {
    if (heartbeat !== undefined) timers.clear(heartbeat);
    heartbeat = undefined;
  }

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

  function liveSinks(target: Live): MediaSinks {
    return {
      // Media events go to the streamer as soon as it exists; before that they wait, in order, with the rest.
      emit: (event) => {
        const streamer = target.stream?.streamer;
        if (streamer) streamer.push(event);
        else deliver(target, event);
      },
      status: (capture) => postStatus(target, capture),
      // Stop waits on media.finished(); the count itself is the media module's to show.
      uploadsPending: () => {},
    };
  }

  async function begin(target: Live, resume: boolean): Promise<void> {
    const { session } = target;
    // Media first: the streamer, and with it every network call, waits until it consumed the tab stream id.
    await target.media;
    try {
      const existing = streaming(session.demonstrationId);
      if (existing) {
        existing.target.token = session.token;
        target.stream = existing;
        return;
      }
      await openStream(
        {
          trajectoryId: session.trajectoryId,
          title: session.title,
          demonstrationId: session.demonstrationId,
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
      demonstrationId: session.demonstrationId,
      trajectoryId: session.trajectoryId,
      capture: {},
      media: Promise.resolve(null),
      stream: null,
      holds: 1,
      waiting: [],
      ending: false,
      stopped: null,
    };
    // At once, never behind earlier work: the tab stream id expires within seconds.
    target.media = deps
      .startMedia(
        resume
          ? { ...session, media: { ...session.media, tabStreamId: null } }
          : session,
        liveSinks(target),
      )
      .catch((error) => {
        console.error(
          "Recorder: screen and voice recording could not start",
          error,
        );
        return null;
      });
    live = target;
    stopBeat();
    beat();
    serially(
      () => begin(target, resume),
      resume ? "resume a recording" : "start a recording",
    );
  }

  async function rotate(
    target: Live,
    demonstrationId: string,
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
      const previous = target.demonstrationId;
      try {
        await (await target.media)?.rotate({ demonstrationId });
      } catch (error) {
        console.error(
          "Recorder: the replaced recording's screen and voice could not be dropped",
          error,
        );
      }
      owners.set(trajectoryId, demonstrationId);
      stream.demonstrations.add(demonstrationId);
      // Switched before the streamer reports anything for it: the replaced recording's kept events are offscreen.kept.
      target.demonstrationId = demonstrationId;
      target.trajectoryId = trajectoryId;
      const rotated = streamer.rotate({
        demonstrationId,
        trajectoryId,
        title: target.session.title,
      });
      void rotated.then(
        () => {
          finished(stream, previous);
          post({
            type: "offscreen.rotated",
            previousDemonstrationId: previous,
          });
          // Its media went with media.rotate and its trajectories are drained and closed: nothing is left of it.
          post({ type: "offscreen.done", demonstrationId: previous });
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
    outcome: "succeeded" | "failed",
    stoppedFrom: "openbot" | undefined,
  ): Promise<void> {
    if (target.stopped) {
      // The service worker restarted mid-Stop and asks again.
      post({
        type: "offscreen.stopped",
        demonstrationId: target.demonstrationId,
        trajectoryIds: target.stopped.trajectoryIds,
      });
      return;
    }
    const stream = target.stream;
    const streamer = stream?.streamer;
    const media = await target.media;
    try {
      // Recorders stop and voice drains, so the last transcript is queued before the outcome.
      await media?.stop();
    } catch (error) {
      console.error("Recorder: screen and voice did not stop cleanly", error);
    }
    if (!stream || !streamer) {
      // The streamer never started (its storage failed to open): nothing was sent, but the recording still ends.
      console.error(
        "Recorder: Stop arrived for a recording whose streamer never started",
      );
      target.ending = true;
      const demonstrationId = target.demonstrationId;
      target.stopped = { trajectoryIds: [] };
      post({ type: "offscreen.stopped", demonstrationId, trajectoryIds: [] });
      void Promise.resolve(media?.finished()).then(
        () => post({ type: "offscreen.done", demonstrationId }),
        (error) => {
          console.error(
            "Recorder: a stopped recording could not finish sending",
            error,
          );
        },
      );
      return;
    }
    target.ending = true;
    const demonstrationId = target.demonstrationId;
    const { trajectoryIds } = await streamer.stop(
      outcome,
      stoppedFrom ? { stoppedFrom } : undefined,
    );
    target.stopped = { trajectoryIds };
    post({ type: "offscreen.stopped", demonstrationId, trajectoryIds });
    void Promise.all([streamer.drained(), media?.finished()]).then(
      () => {
        finished(stream, demonstrationId);
        post({ type: "offscreen.done", demonstrationId });
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
    let media = true;
    try {
      await deps.recoverMedia(
        drain,
        { ...stream.target },
        {
          emit: (event) => stream.streamer.push(event),
          // Only the live recording reports a status.
          status: () => {},
          uploadsPending: () => {},
        },
      );
    } catch (error) {
      media = false;
      console.error(
        "Recorder: a recording's buffered screen or voice could not be recovered",
        error,
      );
    }
    // After every transcript, so the outcome is last; the streamer queues it only when none was queued.
    await stream.streamer.stop("failed", { reason: "interrupted" });
    await stream.streamer.drained();
    finished(stream, drain.demonstrationId);
    // A recording whose media is not finished is not done: the next recovery tries again.
    if (media)
      post({ type: "offscreen.done", demonstrationId: drain.demonstrationId });
  }

  async function recover(
    message: Extract<BackgroundToOffscreen, { type: "offscreen.recover" }>,
  ): Promise<void> {
    const target: Target = {
      openbotUrl: message.openbotUrl,
      token: message.token,
    };
    for (const drain of message.drains) {
      const current = streaming(drain.demonstrationId);
      if (current) {
        // Never a second streamer for one recording: the one sending it goes on, with the new connection's token.
        if (current.target.openbotUrl === target.openbotUrl)
          current.target.token = target.token;
        continue;
      }
      for (const stale of streams.filter(
        (stream) =>
          stream.signedOut && stream.demonstrations.has(drain.demonstrationId),
      ))
        finished(stale, drain.demonstrationId);
      const [first] = drain.trajectoryIds;
      if (first === undefined) {
        console.error(
          "Recorder: a kept recording has no trajectory to recover",
          drain.demonstrationId,
        );
        continue;
      }
      for (const trajectoryId of drain.trajectoryIds)
        owners.set(trajectoryId, drain.demonstrationId);
      const stream = await openStream(
        {
          trajectoryId: first,
          title: drain.title,
          demonstrationId: drain.demonstrationId,
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
    demonstrationId: string,
  ): Promise<void> {
    for (const trajectoryId of await outbox.trajectories()) {
      const meta = await outbox.getMeta<TrajectoryMeta>(
        trajectoryMetaKey(trajectoryId),
      );
      const owner = meta?.demonstrationId ?? owners.get(trajectoryId);
      if (owner === demonstrationId) await outbox.clear(trajectoryId);
    }
  }

  /** Only on the person's own "Discard kept events" or Disconnect. */
  async function discard(demonstrationIds: string[]): Promise<void> {
    const wanted = new Set(demonstrationIds);
    const dropped: Streamer[] = [];
    for (const stream of [...streams]) {
      const own = [...stream.demonstrations].filter((id) => wanted.has(id));
      if (own.length === 0) continue;
      if (own.length === stream.demonstrations.size) {
        if (stream.streamer) dropped.push(stream.streamer);
        stream.demonstrations.clear();
        streams.splice(streams.indexOf(stream), 1);
      } else {
        // It also sends a recording that goes on (Start over replaced the discarded one): only the discarded one's
        // events are cleared below.
        for (const id of own) stream.demonstrations.delete(id);
      }
    }
    if (live && wanted.has(live.demonstrationId)) {
      stopBeat();
      live = null;
    }
    const { outbox } = await storage();
    // Closing the discarded trajectories in OpenBot can take a while: later messages do not wait for it.
    void (async () => {
      await Promise.all(dropped.map((streamer) => streamer.discard()));
      for (const demonstrationId of demonstrationIds) {
        await clearOutbox(outbox, demonstrationId);
        await deps.discardMedia(demonstrationId);
        // The service worker closes the document once nothing it holds is still sending.
        post({ type: "offscreen.done", demonstrationId });
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
      case "offscreen.screen":
        // Waits only for its recording's media, never behind other work: this stream id expires within seconds too.
        void target?.media
          .then((media) => media?.screen(message.tabStreamId))
          .catch((error) => {
            console.error(
              "Recorder: the screen recording could not start",
              error,
            );
          });
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
          () => rotate(target, message.demonstrationId, message.trajectoryId),
          "start over",
        );
        return;
      case "offscreen.stop":
        // Heartbeats tell the service worker a recording is live; they end with it.
        stopBeat();
        if (!target) return;
        serially(
          () => stop(target, message.outcome, message.stoppedFrom),
          "stop the recording",
        );
        return;
      case "offscreen.recover":
        serially(() => recover(message), "recover kept recordings");
        return;
      case "offscreen.discard":
        serially(
          () => discard(message.demonstrationIds),
          "discard kept recordings",
        );
        return;
    }
  }

  connect();
}

// The extension's own offscreen document runs the controller once; tests import the factory without running it.
if (globalThis.location?.protocol === "chrome-extension:") {
  createOffscreenController({
    startMedia,
    recoverMedia,
    discardMedia,
    openOutbox: () => openOutbox(),
    connectPort: () => chrome.runtime.connect({ name: PORT_OFFSCREEN }),
  });
}
