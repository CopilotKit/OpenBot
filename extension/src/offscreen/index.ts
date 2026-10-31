import type { TrajectoryGrant } from "@openbot/shared/recorder-api";
import {
  type CapturedEvent,
  scrubTranscript,
} from "@openbot/shared/recorder-masking";
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
import {
  browserName,
  type RecognitionConstructor,
  startVoice,
  type Voice,
  type VoiceDeps,
} from "./voice";

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
  /** Test seam: the speech recognition and the microphone the live recording's voice uses. */
  voice?: Pick<VoiceDeps, "Recognition" | "getUserMedia">;
};

/** The browser's own speech recognition and microphone: web APIs only, as an offscreen document has no other chrome.*
 * API than runtime messaging. */
function browserVoice(): Pick<VoiceDeps, "Recognition" | "getUserMedia"> {
  const scope = globalThis as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return {
    Recognition:
      scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null,
    getUserMedia: (constraints) =>
      navigator.mediaDevices.getUserMedia(constraints),
  };
}

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000];
/** The live status of a recording whose streamer could not be created (its storage did not open, say). */
const NOT_STARTED =
  "The Recorder could not start sending this recording to Intelligence.";
/** What the service worker shows after Stop for such a recording: none of it was stored, so none of it can be sent. */
const NOT_SENT =
  "Nothing of this recording reached Intelligence: the Recorder could not start sending it. Try recording again.";
/** The sequencer's last issued seq, in the outbox's meta store. */
const SEQ_META_KEY = "seq";
/** Answers the service worker must not miss: one that could not be delivered is posted again once the port is back. */
const DELIVER_ONCE_BACK = new Set<OffscreenToBackground["type"]>([
  "offscreen.trajectory",
  "offscreen.stopped",
  "offscreen.kept",
  "offscreen.done",
  "offscreen.signed-out",
  // A phrase the person said is part of the recording: it waits for the service worker as a step would.
  "offscreen.transcript",
  "offscreen.voice.ended",
  "offscreen.held",
]);

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One streamer this document runs, and the connection it streams for. */
type Stream = {
  /** The token is replaced when the person connects this browser again while it still streams (offscreen.recover). */
  target: Target;
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
  /** The recording's first trajectory (Start over's new one after a switch): a resumed streamer follows its rollovers. */
  first: string;
  capture: Partial<CaptureStatus>;
  stream: Stream | null;
  /** While above 0 (its streamer is being created, or Start over is switching it), events wait in `waiting`. */
  holds: number;
  waiting: { event: CapturedEvent; key?: string }[];
  /** From the moment Stop queues its outcome: kept events are reported with offscreen.kept from then on. */
  ending: boolean;
  /** Its streamer could not be created: every event it is handed is dropped, counted. A resumed recording still has what
   * it stored before in the outbox. */
  notStarted: { resumed: boolean } | null;
  dropped: number;
  stopped: { trajectoryIds: string[] } | null;
  /** The person's narration, transcribed here; null when the session has none, and once Stop has ended it. */
  voice: Voice | null;
  /** When the phrase being spoken began (null: none is), as the service worker was last told. */
  speaking: number | null;
  /** From the moment Stop reaches this document the service worker has sent every step it held: a phrase still to
   * come goes straight into the stream, before the outcome. Until then each goes to the service worker, which places
   * it among the steps it holds. */
  voiceDirect: boolean;
  /** Final phrases that went straight into the stream that way: the service worker counts the others as it places
   * them, and hears of these with offscreen.stopped. */
  directPhrases: number;
  /** The voice's end, once something asked for it. */
  voiceEnded: Promise<void> | null;
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
    // A service worker that restarted knows the phrase being spoken only from its last snapshot: it hears it again.
    if (live?.session.voice)
      post({
        type: "offscreen.speaking",
        recordingId: live.recordingId,
        since: live.speaking,
      });
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
  /** The live recording's sensitive-value digests, from the service worker: a spoken secret is masked like a typed one. */
  let digests = new Set<string>();

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

  /** A recording is done and the service worker told: its finished trajectories' records leave the outbox, so a
   * discard's walk of every trajectory stays short. */
  function forget(streamer: Streamer, recordingId: string): void {
    void streamer.forget(recordingId).catch((error) => {
      console.error(
        "Recorder: a finished recording's records could not be removed",
        error,
      );
    });
  }

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
      return await fetchGrant({ openbotUrl, token }, trajectoryId);
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

  /** A recording with no streamer says so, and how many of its events were dropped. */
  function postNotStarted(target: Live): void {
    postStatus(target, {
      intelligence: "off",
      intelligenceReason: NOT_STARTED,
      events: { sent: 0, pending: 0, rejected: 0, dropped: target.dropped },
    });
  }

  function deliver(target: Live, event: CapturedEvent, key?: string): void {
    const streamer = target.stream?.streamer;
    if (target.holds > 0 || !streamer) {
      if (target.holds > 0) {
        target.waiting.push({ event, key });
        return;
      }
      console.error(
        "Recorder: an event was dropped: its recording has no streamer",
        event.name,
      );
      target.dropped += 1;
      if (target.notStarted) postNotStarted(target);
      return;
    }
    streamer.push(event, key);
  }

  function release(target: Live): void {
    target.holds -= 1;
    if (target.holds > 0) return;
    for (const { event, key } of target.waiting.splice(0))
      deliver(target, event, key);
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
          // Record's own moment: the recording starts before anything it records.
          ...(resume ? { resume: true } : { startedAt: session.startedAt }),
        },
        { openbotUrl: session.openbotUrl, token: session.token },
        {
          live: target,
          allowedGatewayUrls: session.allowedIntelligenceUrls,
          holdRetryMs:
            import.meta.env.RECORDER_VARIANT === "e2e"
              ? session.e2eHoldRetryMs
              : undefined,
        },
      );
    } catch (error) {
      // Nothing can send this recording: the popup says so while it records, and Stop reports it (never as sent).
      console.error(
        "Recorder: the offscreen document could not start a recording's streamer",
        error,
      );
      target.notStarted = { resumed: resume };
      postNotStarted(target);
    } finally {
      release(target);
    }
  }

  /** The live recording's voice: each final phrase is a masked `transcript` event stamped with its start, which the
   * service worker places among the steps it holds (steps taken while the phrase was said wait for it), so it reaches
   * the stream in order with the rest. Its status goes to the popup with the recording's other capture statuses. */
  function startVoiceFor(target: Live): void {
    const voice = target.session.voice;
    if (!voice) return;
    target.voice = startVoice(
      {
        language: voice.language,
        muted: voice.muted,
        emit: (event) => {
          if (live !== target || target.ending) return;
          if (target.voiceDirect) {
            target.directPhrases += 1;
            deliver(target, event);
          } else
            post({
              type: "offscreen.transcript",
              recordingId: target.recordingId,
              event,
            });
        },
        speaking: (since) => {
          target.speaking = since;
          if (live !== target || target.voiceDirect) return;
          post({
            type: "offscreen.speaking",
            recordingId: target.recordingId,
            since,
          });
        },
        status: (update) => postStatus(target, { voice: update }),
        mask: (text, before) => scrubTranscript(text, { digests, before }),
        browser: browserName(),
      },
      { ...(deps.voice ?? browserVoice()), now, timers },
    );
  }

  /** Stop is coming: the phrase in progress goes to the service worker (offscreen.transcript) and the microphone is let
   * go, then the service worker hears that nothing more will come, so it sends its held steps with the phrase in place. */
  function endVoiceFirst(target: Live): void {
    void endVoice(target)
      .catch((error) => {
        console.error("Recorder: the voice could not end", error);
      })
      .then(() =>
        post({
          type: "offscreen.voice.ended",
          recordingId: target.recordingId,
        }),
      );
  }

  /** Ends the voice of a recording that ends: the phrase in progress goes into its stream first. */
  /** Ends the voice once, whoever asks first (the service worker before Stop, or Stop itself); every caller waits for
   * that same end, so a phrase still coming is never left behind. */
  async function endVoice(target: Live): Promise<void> {
    const voice = target.voice;
    target.voice = null;
    if (voice) target.voiceEnded = voice.stop();
    await target.voiceEnded;
  }

  function startLive(session: StreamSession, resume: boolean): void {
    // A recording that was never told to stop (its document was replaced) lets go of the microphone.
    if (live) void endVoice(live);
    const target: Live = {
      session,
      recordingId: session.recordingId,
      trajectoryId: session.trajectoryId,
      first: session.trajectoryId,
      capture: {},
      stream: null,
      notStarted: null,
      dropped: 0,
      holds: 1,
      waiting: [],
      ending: false,
      stopped: null,
      voice: null,
      speaking: null,
      voiceDirect: false,
      directPhrases: 0,
      voiceEnded: null,
    };
    live = target;
    startVoiceFor(target);
    serially(
      () => begin(target, resume),
      resume ? "resume a recording" : "start a recording",
    );
  }

  async function rotate(
    target: Live,
    recordingId: string,
    trajectoryId: string,
    startedAt: number | undefined,
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
      target.first = trajectoryId;
      const rotated = streamer.rotate({
        recordingId,
        trajectoryId,
        title: target.session.title,
        ...(startedAt === undefined ? {} : { startedAt }),
      });
      void rotated.then(
        () => {
          finished(stream, previous);
          // Its trajectories are drained and finished, its failed outcome included: nothing is left of it.
          post({ type: "offscreen.done", recordingId: previous });
          forget(streamer, previous);
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

  /** The phrases a stopped recording put straight into the stream, for offscreen.stopped, when there were any. */
  const said = (target: Live): { phrases?: number } =>
    target.directPhrases > 0 ? { phrases: target.directPhrases } : {};

  async function stop(
    target: Live,
    message: Extract<BackgroundToOffscreen, { type: "offscreen.stop" }>,
  ): Promise<void> {
    // The phrase being spoken goes in before the outcome; the microphone is let go whatever happens next. The service
    // worker sent every step it held before this stop, so the phrase goes straight into the stream.
    target.voiceDirect = true;
    await endVoice(target);
    if (target.stopped) {
      // The service worker restarted mid-Stop and asks again.
      post({
        type: "offscreen.stopped",
        recordingId: target.recordingId,
        trajectoryIds: target.stopped.trajectoryIds,
        ...said(target),
      });
      return;
    }
    const stream = target.stream;
    const streamer = stream?.streamer;
    if (!stream || !streamer) {
      // The streamer never started (its storage failed to open): the recording still ends. A new one stored nothing and
      // can never be sent, so it is done with that said; a resumed one keeps what it stored before, parked for a later
      // recover.
      console.error(
        "Recorder: Stop arrived for a recording whose streamer never started",
      );
      target.ending = true;
      const recordingId = target.recordingId;
      target.stopped = { trajectoryIds: [] };
      post({ type: "offscreen.stopped", recordingId, trajectoryIds: [] });
      if (target.notStarted?.resumed)
        post({
          type: "offscreen.kept",
          recordingId,
          reason: NOT_STARTED,
          parked: true,
          events: 0,
        });
      else post({ type: "offscreen.done", recordingId, failed: NOT_SENT });
      return;
    }
    target.ending = true;
    const recordingId = target.recordingId;
    const { trajectoryIds } =
      message.outcome === "failed"
        ? await streamer.stop("failed", { reason: message.reason })
        : await streamer.stop("succeeded");
    target.stopped = { trajectoryIds };
    post({
      type: "offscreen.stopped",
      recordingId,
      trajectoryIds,
      ...said(target),
    });
    void streamer.drained().then(
      () => {
        finished(stream, recordingId);
        post({ type: "offscreen.done", recordingId });
        forget(streamer, recordingId);
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
    // The steps its service worker still held when the browser quit go in first, in their order; the streamer queues
    // them ahead of the interrupted outcome, which it queues only when none was queued.
    // One that left before the quit, which the held steps still listed, is in the outbox already: not stored again.
    for (const { event, key } of drain.held ?? [])
      stream.streamer.push(event, key);
    await stream.streamer.stop("failed", { reason: "interrupted" });
    // They are in the outbox now, ahead of the outcome: the drain need not carry them again.
    if (drain.held?.length)
      post({ type: "offscreen.held", recordingId: drain.recordingId });
    await stream.streamer.drained();
    finished(stream, drain.recordingId);
    post({ type: "offscreen.done", recordingId: drain.recordingId });
    forget(stream.streamer, drain.recordingId);
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
          version: message.version,
          resume: true,
          recover: true,
        },
        target,
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
    if (live && wanted.has(live.recordingId)) {
      void endVoice(live);
      live = null;
    }
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

  /** The live recording's person connected this browser again, which revoked the token its passes used: its stream
   * asks with the new one. A stream that a pass with the old token already signed out is replaced by one that resumes
   * the recording's trajectories from the outbox, once the old one has stored every event it was handed. */
  async function retoken(target: Live, token: string): Promise<void> {
    try {
      target.session = { ...target.session, token };
      const stream = target.stream;
      if (stream && !stream.signedOut) {
        stream.target.token = token;
        return;
      }
      if (target.ending) return;
      if (stream) {
        await stream.streamer?.halt();
        target.stream = null;
        finished(stream, target.recordingId);
      }
      await openStream(
        {
          trajectoryId: target.first,
          title: target.session.title,
          recordingId: target.recordingId,
          version: target.session.version,
          resume: true,
        },
        { openbotUrl: target.session.openbotUrl, token },
        {
          live: target,
          allowedGatewayUrls: target.session.allowedIntelligenceUrls,
        },
      );
    } finally {
      release(target);
    }
  }

  /** The service worker says this token's connection is gone: no stream sends with it any more, and a pass asked
   * with it is refused here, so nothing reaches OpenBot or Intelligence for it. The events stay in the outbox. */
  async function halt(token: string): Promise<void> {
    if (!signedOutTokens.has(token)) signedOutTokens.set(token, "revoked");
    const halting: Promise<void>[] = [];
    for (const stream of streams) {
      if (stream.signedOut || stream.target.token !== token) continue;
      stream.signedOut = true;
      stream.failedToken = token;
      if (stream.streamer) halting.push(stream.streamer.halt());
    }
    await Promise.all(halting);
  }

  /** The managed policy changed: every streamer is held to its new gateway list from now on. */
  function allow(urls: string[] | null): void {
    if (live) live.session = { ...live.session, allowedIntelligenceUrls: urls };
    for (const stream of streams) stream.streamer?.allow(urls);
  }

  // ---- Messages in -------------------------------------------------------------------------------

  function receive(message: BackgroundToOffscreen): void {
    const target = live;
    switch (message.type) {
      case "offscreen.event":
        if (target) deliver(target, message.event, message.key);
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
          () =>
            rotate(
              target,
              message.recordingId,
              message.trajectoryId,
              message.startedAt,
            ),
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
      case "offscreen.token":
        if (target?.recordingId !== message.recordingId) {
          console.error(
            "Recorder: a new token arrived for a recording this document does not record",
          );
          return;
        }
        // Events wait while a signed-out stream is replaced.
        target.holds += 1;
        serially(() => retoken(target, message.token), "take the new token");
        return;
      case "offscreen.halt":
        // At once, not behind the queue: a socket still streaming for a lost connection stops now.
        void halt(message.token).catch((error) => {
          console.error(
            "Recorder: a lost connection's streams could not stop",
            error,
          );
        });
        return;
      case "offscreen.policy":
        allow(message.allowedIntelligenceUrls);
        return;
      case "offscreen.voice.end":
        // At once, not behind the queue: the service worker waits for the answer before it sends the steps it holds.
        if (target && target.recordingId === message.recordingId)
          endVoiceFirst(target);
        else
          post({
            type: "offscreen.voice.ended",
            recordingId: message.recordingId,
          });
        return;
      case "offscreen.voice":
        if (!target?.session.voice) return;
        // Kept in the session too, so a document reopened on it would start the same way.
        target.session = {
          ...target.session,
          voice: { ...target.session.voice, muted: message.muted },
        };
        target.voice?.mute(message.muted);
        return;
      case "offscreen.digests":
        digests = new Set(message.digests);
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
