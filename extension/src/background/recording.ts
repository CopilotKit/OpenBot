// The recording controller: Record, the tabs a recording follows, its steps, the 50-step notice, Stop and the drains
// that keep sending after it. The phase lives in a reducer (`reduceRecorder`), persisted to storage.session after every
// transition so a restarted service worker finds it; everything that must survive a browser restart lives in
// storage.local (`activeRecording`, `drains`) and IndexedDB (the step queue).
import { safeDemonstrationUrl } from "@openbot/shared/demonstration-rules";
import {
  type DemonstrationAction,
  demonstrationActionSchema,
} from "@openbot/shared/demonstration-schema";
import {
  type ExtensionDemonstration,
  type LearningSpaceState,
  RECORDER_OPEN_RECORDING,
  RECORDER_STEP_NOTICE_AT,
  type RecorderBot,
  type RecorderMe,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import type {
  BackgroundToOffscreen,
  CaptureStatus,
  ContentToBackground,
  ExternalResponse,
  ExternalToBackground,
  OffscreenSignedOut,
  OffscreenToBackground,
  PageResponse,
  PageStateResponse,
  PageToBackground,
  RecorderState,
  StreamSession,
} from "../protocol/messages";
import { IDLE_STATE, parseOffscreenSignedOut } from "../protocol/messages";
import {
  deleteDemonstrationData,
  openRecorderDatabase,
} from "../shared/database";
import { hasHostPermission } from "../shared/host-access";
import { OpenBotError, openbotJson } from "../shared/openbot-client";
import { isRecordablePage } from "../shared/origin";
import { readPolicy } from "../shared/policy";
import {
  type ConnectionRecord,
  type DrainRecord,
  type KeptEvents,
  readLocal,
  readSession,
  removeLocal,
  removeSession,
  writeLocal,
  writeSession,
} from "../shared/storage";
import { showBadge } from "./badge";
import { currentConnection, forgetConnection } from "./connection";
import {
  forgetContentPorts,
  injectRecordingScripts,
  postToContentPorts,
  stopRecordingScripts,
  trackContentPort,
} from "./content-scripts";
import {
  type NavigationDetails,
  navigateStep,
  navigationEvent,
} from "./navigation";
import {
  createNetworkCapture,
  type NetworkCapture,
  type NetworkCaptureDeps,
  type NetworkMode,
  recoverNetworkBodies,
} from "./network";
import { acceptPageNetworkEvent, createPageFallback } from "./network/fallback";
import {
  closeOffscreenDocument,
  ensureOffscreenDocument,
  hasOffscreenDocument,
} from "./offscreen-document";
import type { RouterHandlers } from "./router";
import { createStepUploader, type StepTarget } from "./steps";
import { acquireTabStreamId } from "./tab-capture";

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type RecordingDeps = {
  createNetworkCapture: typeof createNetworkCapture;
  createPageFallback: typeof createPageFallback;
  acceptPageNetworkEvent: typeof acceptPageNetworkEvent;
  acquireTabStreamId: typeof acquireTabStreamId;
  recoverNetworkBodies: typeof recoverNetworkBodies;
  readPolicy: typeof readPolicy;
  hasHostPermission: typeof hasHostPermission;
  now(): number;
  openDatabase: () => Promise<IDBDatabase>;
  /** Every wait (the document's ready, the stop watchdog, the stop retries, the uploader's flushes) goes through these. */
  timers: Timers;
  createStepUploader: typeof createStepUploader;
};

/** Called by the router after Task 8's handler answered: `connected` after a successful `page.connect.decide` (web or Desktop),
 * `disconnected` after `page.disconnect` (the person's own Disconnect). */
export type ConnectionEvents = {
  connected(): Promise<void>;
  disconnected(): Promise<void>;
};

const READY_TIMEOUT_MS = 5_000;
const STOP_WATCHDOG_MS = 120_000;
const POLL_EVERY_MS = 25_000;
const ME_FRESH_MS = 60_000;
const STOP_RETRY_FIRST_MS = 5_000;
const STOP_RETRY_MAX_MS = 5 * 60_000;
/** While the offscreen port is down, content events wait here; beyond either cap the oldest go, counted (Decision 19). */
const QUEUE_EVENTS = 2_000;
const QUEUE_BYTES = 8 * 1024 * 1024;

const SENTENCES = {
  noConnection: "Connect this browser to OpenBot first.",
  noAccess: "Allow the Recorder to read websites first.",
  busy: "A recording is already running.",
  notRecording: "Nothing is being recorded.",
  tabClosed:
    "That tab is closed. Open the Recorder on the tab you want to record.",
  openRecording:
    "You already have an open recording for this Bot, maybe in another browser.",
  startFailed: "The recording could not start. Try again.",
  documentFailed: "The Recorder could not start recording. Try again.",
  screenOnWebsite: "The screen is recorded once this tab opens a website.",
  screenFromPopup:
    "Open the Recorder on the tab you are recording, then choose Record screen.",
  stopPending:
    "Stopping: OpenBot did not answer yet. Your steps are kept in this browser and sent when it does.",
  stoppedInOpenBot:
    "This recording was stopped in OpenBot. Everything until then was saved.",
  signedOut:
    "This browser was disconnected from OpenBot. Your recording stopped, and everything in it is kept in this browser until you connect again.",
  organizationSignedOut:
    "Your organization sign-in ended. Your recording stopped, and everything in it is kept in this browser until you connect again.",
  keptSignedOut: "This browser was disconnected from OpenBot.",
  keptOrganization: "Your organization sign-in ended.",
} as const;

type SignedOutReason = "revoked" | "removed" | "organization";

/** The sentences that say a stopped recording is kept until something happens: a Disconnect discards it, so they go. */
const KEPT_SENTENCES: readonly string[] = [
  SENTENCES.stopPending,
  SENTENCES.signedOut,
  SENTENCES.organizationSignedOut,
];

/** Record ended by a stop (Stop, Disconnect, a sign-out) before its recording was live: it rolls back. */
const CANCELLED = new Error("Record was cancelled before it started.");

// ---- The state machine -------------------------------------------------------------------------

export type RecorderEvent =
  | {
      type: "record";
      botId: string;
      title: string;
      learning?: LearningSpaceState;
    }
  | {
      type: "started";
      demonstrationId: string;
      tabId: number;
      topUrl: string;
      startedAt: number;
      capture: CaptureStatus;
    }
  | { type: "step" }
  | { type: "notice" }
  | { type: "follow"; tabId: number; url: string }
  | { type: "page"; tabId: number; url: string }
  | { type: "capture"; capture: Partial<CaptureStatus> }
  | { type: "learning"; learning: LearningSpaceState }
  | { type: "stop"; since: number; stoppedFrom?: "openbot" }
  | { type: "stopped" }
  | {
      type: "finished";
      lastStopped: NonNullable<RecorderState["lastStopped"]>;
      learning?: LearningSpaceState;
      error?: string;
    }
  | { type: "restart"; demonstrationId: string; startedAt: number }
  | { type: "drains"; draining: number; kept?: RecorderState["kept"] }
  | {
      type: "error";
      error: string;
      openRecording?: { demonstrationId: string };
    }
  | { type: "cancelled" }
  | { type: "clear-error" };

/** Drops keys whose value is undefined, so the state reads the same before and after a JSON round trip. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/** The phase transitions, pure, so they are testable without timers. */
export function reduceRecorder(
  state: RecorderState,
  event: RecorderEvent,
): RecorderState {
  const kept = { draining: state.draining, kept: state.kept };
  switch (event.type) {
    case "record":
      return defined({
        ...IDLE_STATE,
        ...kept,
        lastStopped: state.lastStopped,
        phase: "starting",
        botId: event.botId,
        title: event.title,
        learning: event.learning,
      });
    case "started":
      return {
        ...state,
        phase: "recording",
        demonstrationId: event.demonstrationId,
        tabIds: [event.tabId],
        topUrls: { [event.tabId]: event.topUrl },
        startedAt: event.startedAt,
        steps: 0,
        noticeShown: false,
        capture: event.capture,
      };
    case "step":
      return { ...state, steps: state.steps + 1 };
    case "notice":
      return { ...state, noticeShown: true };
    case "follow":
      if (state.tabIds.includes(event.tabId)) return state;
      return {
        ...state,
        tabIds: [...state.tabIds, event.tabId],
        topUrls: { ...state.topUrls, [event.tabId]: event.url },
      };
    case "page":
      return {
        ...state,
        topUrls: { ...state.topUrls, [event.tabId]: event.url },
      };
    case "capture":
      return {
        ...state,
        capture: defined({ ...state.capture, ...event.capture }),
      };
    case "learning":
      return { ...state, learning: event.learning };
    case "stop":
      return {
        ...state,
        phase: "stopping",
        stopping: defined({
          since: event.since,
          stage: "draining" as const,
          stoppedFrom: event.stoppedFrom,
        }),
      };
    case "stopped":
      return state.stopping
        ? {
            ...state,
            stopping: { ...state.stopping, stage: "telling-openbot" },
          }
        : state;
    case "finished":
      return defined({
        ...IDLE_STATE,
        ...kept,
        lastStopped: event.lastStopped,
        learning: event.learning ?? state.learning,
        error: event.error,
      });
    case "restart":
      return {
        ...state,
        demonstrationId: event.demonstrationId,
        startedAt: event.startedAt,
        steps: 0,
        noticeShown: false,
      };
    case "drains":
      return defined({ ...state, draining: event.draining, kept: event.kept });
    case "error":
      return defined({
        ...IDLE_STATE,
        ...kept,
        lastStopped: state.lastStopped,
        botId: state.botId,
        error: event.error,
        openRecording: event.openRecording,
      });
    case "cancelled":
      return defined({
        ...IDLE_STATE,
        ...kept,
        lastStopped: state.lastStopped,
      });
    case "clear-error":
      return defined({ ...state, error: undefined });
  }
}

/** What the popup shows about stopped recordings whose events are kept (Decision 19). */
function keptSummary(drains: DrainRecord[]): RecorderState["kept"] {
  const kept = drains.filter(
    (drain): drain is DrainRecord & { kept: KeptEvents } =>
      drain.kept !== undefined,
  );
  const newest = kept.reduce<(DrainRecord & { kept: KeptEvents }) | undefined>(
    (latest, drain) =>
      latest === undefined || drain.kept.at > latest.kept.at ? drain : latest,
    undefined,
  );
  if (!newest) return undefined;
  const waiting = kept.filter((drain) => drain.kept.waitingForReconnect);
  return defined({
    recordings: kept.length,
    events: kept.reduce((sum, drain) => sum + drain.kept.events, 0),
    reason: newest.kept.reason,
    parked: kept.every((drain) => drain.kept.parked),
    waitingFor: waiting[0]
      ? { name: waiting[0].userName, recordings: waiting.length }
      : undefined,
  });
}

let lastPersist: Promise<void> = Promise.resolve();

/** The recorder state as a restarted service worker would find it. */
export async function recorderState(): Promise<RecorderState> {
  await lastPersist;
  return (await readSession("recorder")) ?? { ...IDLE_STATE };
}

const defaultDeps: RecordingDeps = {
  createNetworkCapture,
  createPageFallback,
  acceptPageNetworkEvent,
  acquireTabStreamId,
  recoverNetworkBodies,
  readPolicy,
  hasHostPermission,
  now: () => Date.now(),
  openDatabase: () => openRecorderDatabase(),
  timers: {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  createStepUploader,
};

/** The recording a stop or a step upload is about: whom it belongs to and the token it is sent with. */
type Live = {
  demonstrationId: string;
  botId: string;
  openbotUrl: string;
  token: string;
  userId: string;
};

type StopMode =
  | { kind: "person" } // Stop: every step, then POST stop
  | { kind: "openbot" } // stopped in OpenBot: no POST stop, the refused steps dropped
  | { kind: "signed-out"; reason: SignedOutReason; forgot: boolean } // kept for the person (only this recording when the connection was not forgotten)
  | { kind: "disconnect" } // the person's Disconnect: discarded right after
  | { kind: "restart-failed"; error: string }; // Start over could not open the new recording

const isRefusal = (error: unknown): boolean =>
  error instanceof OpenBotError &&
  !error.signedOut &&
  error.status >= 400 &&
  error.status < 500 &&
  ![401, 408, 429].includes(error.status);

const signedOutReason = (error: unknown): SignedOutReason | null =>
  error instanceof OpenBotError && error.signedOut
    ? (error.body?.reason ?? "revoked")
    : null;

const sentenceFor = (error: unknown, fallback: string): string =>
  error instanceof OpenBotError ? error.message : fallback;

const ownedBy = (drain: DrainRecord, connection: ConnectionRecord): boolean =>
  drain.userId === connection.user.id &&
  drain.openbotUrl === connection.openbotUrl;

function report(what: string): (error: unknown) => void {
  return (error) => console.error(`Recorder: ${what} failed`, error);
}

/** Steps the service worker builds itself skip the router's schema check: they are parsed here instead. */
function validStep(action: DemonstrationAction): DemonstrationAction | null {
  const parsed = demonstrationActionSchema.safeParse(action);
  return parsed.success ? parsed.data : null;
}

/** The page/content/offscreen handlers the router calls. Defaults are the real modules (Task 4's stubs until their owners land); tests pass doubles. */
export function installRecording(
  overrides: Partial<RecordingDeps> = {},
): RouterHandlers & ConnectionEvents {
  const deps: RecordingDeps = { ...defaultDeps, ...overrides };
  forgetContentPorts();

  let state: RecorderState = IDLE_STATE;
  let live: Live | null = null;
  let network: NetworkCapture | null = null;
  let networkMode: NetworkMode | "stopped" = "off";
  const digests = new Set<string>();
  let bots = new Map<string, RecorderBot>();
  const frameUrls = new Map<string, string>();
  let lastPollAt: number | undefined;
  /** The recording Start over is leaving: while it is still the live one, nothing uploads, takes a step, polls OpenBot or
   * stops it on a refusal. Once it has ended, a recording started after it is not held up by the Start over still
   * waiting on OpenBot. */
  let restartingFrom: Live | null = null;
  /** Set while Start over saves and makes the switch to the new recording (nothing in it waits on OpenBot): a stop waits
   * for it, so the document and the tabs always hear of the switch before they hear of the stop. */
  let switching: Promise<void> | null = null;
  /** Set from Record's first step until it finished starting (or rolled back). A stop (Stop, Disconnect, a sign-out)
   * and Start over wait for it. A stop that comes before the recording is live cancels it: Record checks just before
   * making the recording live and rolls back. One that comes later stops the recording once Record finished, so the
   * network capture and the tab's script Record starts are there for the stop to end. */
  let starting: { done: Promise<void>; cancelled: boolean } | null = null;
  /** The stop under way, from the moment it takes the live recording until it finished: Disconnect waits for it, so the
   * recording it moves into the drains is discarded with the rest. */
  let stopInFlight: Promise<void> | null = null;
  /** How many Disconnects are under way: a stop that finds the connection gone meanwhile is being discarded, not kept
   * for a person who was signed out. */
  let disconnecting = 0;
  /** The recording whose capture the popup shows and the trajectories it streams to: a status about any other
   * trajectory (a recording Start over discarded, still draining) leaves that capture alone. */
  let shown: { demonstrationId: string; trajectoryIds: Set<string> } | null =
    null;

  let database: Promise<IDBDatabase> | null = null;
  const db = () => {
    database ??= deps.openDatabase();
    return database;
  };

  // ---- Persistence ---------------------------------------------------------------------------

  let persisted: Promise<void> = Promise.resolve();
  function dispatch(event: RecorderEvent): void {
    const before = state;
    state = reduceRecorder(state, event);
    const snapshot = state;
    persisted = persisted
      .then(() => writeSession("recorder", snapshot))
      .catch(report("saving the recorder state"));
    lastPersist = persisted;
    if (before.phase !== state.phase || before.steps !== state.steps)
      void showBadge(state).catch(report("updating the badge"));
  }

  /** storage.local read-then-write work (the active recording and the drains) runs one job at a time. */
  let localQueue: Promise<unknown> = Promise.resolve();
  function serially<T>(work: () => Promise<T>): Promise<T> {
    const run = localQueue.then(work, work);
    localQueue = run.catch(() => undefined);
    return run;
  }

  async function writeDrains(drains: DrainRecord[]): Promise<void> {
    if (drains.length > 0) await writeLocal("drains", drains);
    else await removeLocal("drains");
  }

  function publishDrains(drains: DrainRecord[]): void {
    dispatch({
      type: "drains",
      draining: drains.length,
      kept: keptSummary(drains),
    });
  }

  async function updateDrains(
    change: (drains: DrainRecord[]) => DrainRecord[],
  ): Promise<DrainRecord[]> {
    const next = await serially(async () => {
      const changed = change((await readLocal("drains")) ?? []);
      await writeDrains(changed);
      return changed;
    });
    publishDrains(next);
    return next;
  }

  // ---- Steps ---------------------------------------------------------------------------------

  const steps = deps.createStepUploader({
    // Start over drains the recording it leaves itself, before OpenBot hears of its stop.
    target: (): StepTarget | null =>
      live && live !== restartingFrom
        ? {
            openbotUrl: live.openbotUrl,
            token: live.token,
            demonstrationId: live.demonstrationId,
          }
        : null,
    db,
    // Only the live recording's uploads report here (a drain's caller handles its own failure), and the work is
    // started, not awaited: the uploader waits on this callback while holding its queue, and a stop drains that queue.
    onSignedOut: async (reason) => {
      if (live)
        void handleSignedOut(
          reason,
          live.token,
          live.userId,
          live.openbotUrl,
        ).catch(report("signing out"));
    },
    // A refusal is about the recording its batch was for: one that is no longer live, or one Start over is leaving,
    // stops nothing.
    onRefused: async (_message, demonstrationId) => {
      if (
        !live ||
        live === restartingFrom ||
        live.demonstrationId !== demonstrationId
      )
        return;
      void stopRecording({ kind: "openbot" }).catch(
        report("stopping a recording stopped in OpenBot"),
      );
    },
    timers: deps.timers,
  });

  /** Adds a step to the live recording; navigate and gesture steps count toward the 50-step notice, network steps do not. */
  function addStep(action: DemonstrationAction): void {
    if (!live || live === restartingFrom) return;
    steps.add(action);
    if (action.kind === "network") return;
    dispatch({ type: "step" });
    if (state.steps >= RECORDER_STEP_NOTICE_AT && !state.noticeShown) {
      dispatch({ type: "notice" });
      postToContentPorts(
        state.tabIds,
        { type: "background.notice", show: true, steps: state.steps },
        { topFrameOnly: true },
      );
    }
  }

  /** The drafted Skill starts where the person is (Decision 16): a navigate step for the page, when it is a website. */
  function addFirstStep(url: string | undefined): void {
    if (!isRecordablePage(url)) return;
    const first = validStep({
      kind: "navigate",
      url: safeDemonstrationUrl(url ?? ""),
      transition: "other",
    });
    if (first) addStep(first);
  }

  const ready = (async () => {
    const stored = await readSession("recorder");
    if (stored) state = stored;
    for (const digest of (await readSession("digests")) ?? [])
      digests.add(digest);
    if (state.phase === "idle") return;
    const record = await readLocal("activeRecording");
    if (record)
      shown = {
        demonstrationId: record.demonstrationId,
        trajectoryIds: new Set(record.trajectoryIds),
      };
    if (state.phase !== "recording") return;
    const connection = await currentConnection();
    if (!record || !connection || !ownedBy(record, connection)) return;
    live = {
      demonstrationId: record.demonstrationId,
      botId: record.botId,
      openbotUrl: record.openbotUrl,
      token: connection.token,
      userId: record.userId,
    };
    await steps.load();
  })();
  ready.catch(report("loading the recorder state"));

  // ---- The offscreen document ----------------------------------------------------------------

  let offscreen: chrome.runtime.Port | null = null;
  /** The port has spoken (offscreen.ready on load, or any message from a document that reconnected). */
  let documentReady = false;
  let readyWaiters: ((port: chrome.runtime.Port) => void)[] = [];
  /** Waiting for the document's port to connect again (`documentPort`). */
  let connectWaiters: ((port: chrome.runtime.Port) => void)[] = [];
  /** Set while a document is opened for a start or a recovery: events wait until its session message is posted. */
  let holdEvents = false;
  const queued: { event: CapturedEvent; bytes: number }[] = [];
  let queuedBytes = 0;
  let droppedEvents = 0;
  const stopWaiters = new Map<string, () => void>();
  /** Offscreen answers that arrived before their recording reached `drains`, applied when it does. */
  const offscreenDone = new Set<string>();
  const earlyKept = new Map<string, KeptEvents>();
  const deleted = new Set<string>();

  /** Opening and closing the document never cross. */
  let documentQueue: Promise<unknown> = Promise.resolve();
  function documentWork<T>(work: () => Promise<T>): Promise<T> {
    const run = documentQueue.then(work, work);
    documentQueue = run.catch(() => undefined);
    return run;
  }

  function postOffscreen(message: BackgroundToOffscreen): boolean {
    if (!offscreen) return false;
    try {
      offscreen.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  /** The document's port. While a document exists but its port is down (the service worker restarted and the document
   * reconnects with its backoff), waits up to `ms` for the port to connect again; a connected port is enough, since the
   * document opened it and listens on it. Null when no document exists, or its port did not come back in time. */
  async function documentPort(ms: number): Promise<chrome.runtime.Port | null> {
    if (offscreen) return offscreen;
    if (!(await hasOffscreenDocument())) return null;
    if (offscreen) return offscreen;
    return new Promise((resolve) => {
      const waiter = (port: chrome.runtime.Port) => {
        deps.timers.clear(handle);
        resolve(port);
      };
      const handle = deps.timers.set(() => {
        connectWaiters = connectWaiters.filter((entry) => entry !== waiter);
        resolve(null);
      }, ms);
      connectWaiters.push(waiter);
    });
  }

  function waitForReady(): Promise<chrome.runtime.Port> {
    if (offscreen && documentReady) return Promise.resolve(offscreen);
    return new Promise((resolve, reject) => {
      const waiter = (port: chrome.runtime.Port) => {
        deps.timers.clear(handle);
        resolve(port);
      };
      const handle = deps.timers.set(() => {
        readyWaiters = readyWaiters.filter((entry) => entry !== waiter);
        reject(new Error(SENTENCES.documentFailed));
      }, READY_TIMEOUT_MS);
      readyWaiters.push(waiter);
    });
  }

  /** Makes sure the document exists and has said ready, holding events until the caller posted its session message and
   * called `releaseEvents`. */
  async function openDocument(): Promise<chrome.runtime.Port> {
    holdEvents = true;
    try {
      await documentWork(() => ensureOffscreenDocument());
      return await waitForReady();
    } catch (error) {
      releaseEvents();
      throw error;
    }
  }

  function releaseEvents(): void {
    holdEvents = false;
    flushEvents();
  }

  function forwardEvent(event: CapturedEvent): void {
    if (offscreen && !holdEvents && queued.length === 0 && droppedEvents === 0)
      if (postOffscreen({ type: "offscreen.event", event })) return;
    const bytes = JSON.stringify(event).length;
    queued.push({ event, bytes });
    queuedBytes += bytes;
    while (queued.length > QUEUE_EVENTS || queuedBytes > QUEUE_BYTES) {
      const oldest = queued.shift();
      if (!oldest) break;
      queuedBytes -= oldest.bytes;
      droppedEvents += 1;
    }
  }

  function flushEvents(): void {
    if (!offscreen || holdEvents) return;
    if (droppedEvents > 0) {
      const dropped: CapturedEvent = {
        type: "CUSTOM",
        name: "recorder.dropped",
        timestamp: deps.now(),
        value: { count: droppedEvents, reason: "offscreen-unreachable" },
      };
      if (!postOffscreen({ type: "offscreen.event", event: dropped })) return;
      droppedEvents = 0;
    }
    while (queued.length > 0) {
      const next = queued[0];
      if (
        !next ||
        !postOffscreen({ type: "offscreen.event", event: next.event })
      )
        return;
      queued.shift();
      queuedBytes -= next.bytes;
    }
  }

  /** The document is closed once nothing it holds is still sending: every drain is done, parked, or waiting for its
   * person to connect again (a held drain keeps it open for its retries). A recording Start over discarded is never
   * kept, and waits for its person to connect again before it can be drained and deleted. */
  function maybeCloseDocument(): Promise<void> {
    return documentWork(async () => {
      if (state.phase !== "idle" || holdEvents) return;
      const drains = (await readLocal("drains")) ?? [];
      const connection = await currentConnection();
      const busy = drains.some(
        (drain) =>
          !offscreenDone.has(drain.demonstrationId) &&
          !(
            drain.kept &&
            (drain.kept.parked || drain.kept.waitingForReconnect)
          ) &&
          !(drain.discard && !(connection && ownedBy(drain, connection))),
      );
      if (busy || !(await hasOffscreenDocument())) return;
      if (state.phase !== "idle" || holdEvents) return;
      await closeOffscreenDocument();
    });
  }

  function awaitStopped(
    demonstrationId: string,
    since: number,
    message: BackgroundToOffscreen,
  ): Promise<void> {
    return new Promise((resolve) => {
      let handle: unknown = null;
      const finish = () => {
        stopWaiters.delete(demonstrationId);
        if (handle !== null) deps.timers.clear(handle);
        resolve();
      };
      stopWaiters.set(demonstrationId, finish);
      // The watchdog counts from the persisted start of the stop, so a restarted worker waits no longer in total.
      const remaining = Math.max(0, since + STOP_WATCHDOG_MS - deps.now());
      handle = deps.timers.set(finish, remaining);
      // A document whose port is reconnecting is waited for within the watchdog. With no document there is nothing to
      // tell: what it holds is recovered with the drain. A wait Disconnect released still tells the document to stop.
      void documentPort(remaining).then((port) => {
        const posted = port !== null && postOffscreen(message);
        if (!posted && stopWaiters.get(demonstrationId) === finish) finish();
      });
    });
  }

  /** Posts a message the document must get, waiting up to the ready timeout for its port while it reconnects. */
  async function sendToDocument(message: BackgroundToOffscreen): Promise<void> {
    if (await documentPort(READY_TIMEOUT_MS)) postOffscreen(message);
  }

  function onOffscreenMessage(
    port: chrome.runtime.Port,
    message: OffscreenToBackground,
  ): void {
    if (offscreen === port && !documentReady) {
      documentReady = true;
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const waiter of waiters) waiter(port);
    }
    switch (message.type) {
      case "offscreen.ready":
        flushEvents();
        return;
      case "offscreen.status":
        if (
          state.phase !== "idle" &&
          shown?.trajectoryIds.has(message.trajectoryId)
        )
          dispatch({ type: "capture", capture: message.capture });
        return;
      case "offscreen.trajectory":
        if (shown?.demonstrationId === message.demonstrationId)
          shown.trajectoryIds.add(message.trajectoryId);
        void addTrajectory(message.demonstrationId, message.trajectoryId).catch(
          report("registering a trajectory"),
        );
        return;
      case "offscreen.stopped":
        stopWaiters.get(message.demonstrationId)?.();
        return;
      case "offscreen.rotated":
        void deleteDiscarded(message.previousDemonstrationId).catch(
          report("deleting a discarded recording"),
        );
        return;
      case "offscreen.done":
        void documentDone(message.demonstrationId).catch(
          report("finishing a drain"),
        );
        return;
      case "offscreen.kept":
        void keepEvents(message.demonstrationId, {
          reason: message.reason,
          parked: message.parked,
          events: message.events,
          at: deps.now(),
        }).catch(report("keeping events"));
        return;
      case "offscreen.heartbeat":
        void heartbeat().catch(report("checking the recording in OpenBot"));
        return;
      case "offscreen.signed-out": {
        const signedOut = parseOffscreenSignedOut(message);
        if (signedOut)
          void documentSignedOut(signedOut).catch(report("signing out"));
        else
          report("signing out")(
            new Error("offscreen.signed-out without a valid token"),
          );
        return;
      }
    }
  }

  async function addTrajectory(
    demonstrationId: string,
    trajectoryId: string,
  ): Promise<void> {
    const append = (record: DrainRecord): DrainRecord =>
      record.trajectoryIds.includes(trajectoryId)
        ? record
        : { ...record, trajectoryIds: [...record.trajectoryIds, trajectoryId] };
    await serially(async () => {
      const record = await readLocal("activeRecording");
      if (record?.demonstrationId === demonstrationId) {
        await writeLocal("activeRecording", append(record));
        return;
      }
      const drains = (await readLocal("drains")) ?? [];
      await writeDrains(
        drains.map((drain) =>
          drain.demonstrationId === demonstrationId ? append(drain) : drain,
        ),
      );
    });
  }

  /** Deletes a discarded recording in OpenBot; false while that cannot be done (its person is not connected). */
  async function deleteOnOpenBot(drain: DrainRecord): Promise<boolean> {
    if (deleted.has(drain.demonstrationId)) return true;
    const connection = await currentConnection();
    if (!connection || !ownedBy(drain, connection)) return false;
    try {
      await openbotJson(
        connection,
        recorderPaths.demonstration(drain.demonstrationId),
        { method: "DELETE" },
      );
    } catch (error) {
      if (!(error instanceof OpenBotError && error.status === 404)) throw error;
    }
    deleted.add(drain.demonstrationId);
    return true;
  }

  /** Start over: the discarded recording's events are sent and its trajectory closed, so OpenBot can forget it. */
  async function deleteDiscarded(demonstrationId: string): Promise<void> {
    const drain = ((await readLocal("drains")) ?? []).find(
      (entry) => entry.demonstrationId === demonstrationId,
    );
    if (drain?.discard) await deleteOnOpenBot(drain);
  }

  /** Everything of a stopped recording is sent: its drain goes, unless its stop has not reached OpenBot yet, or it is a
   * discarded one OpenBot cannot be told to delete yet (a later recovery reports it done again). An answer for the
   * recording a stop is still moving into the drains is remembered and applied by that move; the lookup runs in the same
   * storage queue as the move, so the two never cross. */
  async function documentDone(demonstrationId: string): Promise<void> {
    offscreenDone.add(demonstrationId);
    const drain = await serially(async () => {
      const found = ((await readLocal("drains")) ?? []).find(
        (entry) => entry.demonstrationId === demonstrationId,
      );
      const active =
        (await readLocal("activeRecording"))?.demonstrationId ===
        demonstrationId;
      if (!found && !active) offscreenDone.delete(demonstrationId);
      return found;
    });
    if (drain && !drain.stopPending) {
      const removable = !drain.discard || (await deleteOnOpenBot(drain));
      if (removable) {
        if (drain.discard)
          await deleteDemonstrationData(await db(), demonstrationId);
        await updateDrains((drains) =>
          drains.filter(
            (entry) =>
              entry.demonstrationId !== demonstrationId || entry.stopPending,
          ),
        );
        offscreenDone.delete(demonstrationId);
        deleted.delete(demonstrationId);
      }
    }
    await maybeCloseDocument();
  }

  async function keepEvents(
    demonstrationId: string,
    kept: KeptEvents,
  ): Promise<void> {
    const updated = await serially(async () => {
      const drains = (await readLocal("drains")) ?? [];
      if (drains.some((drain) => drain.demonstrationId === demonstrationId)) {
        const next = drains.map((drain) =>
          drain.demonstrationId === demonstrationId
            ? { ...drain, kept }
            : drain,
        );
        await writeDrains(next);
        return next;
      }
      if (
        (await readLocal("activeRecording"))?.demonstrationId ===
        demonstrationId
      )
        earlyKept.set(demonstrationId, kept);
      return null;
    });
    if (updated) publishDrains(updated);
    await maybeCloseDocument();
  }

  // ---- Record -------------------------------------------------------------------------------

  function refuse(error: string): PageResponse {
    dispatch({ type: "error", error });
    return { ok: false, error };
  }

  async function takeStreamId(tabId: number): Promise<string | null> {
    try {
      return await deps.acquireTabStreamId(tabId);
    } catch {
      return null;
    }
  }

  const networkDeps: NetworkCaptureDeps = {
    context: () =>
      live
        ? {
            openbotUrl: live.openbotUrl,
            token: live.token,
            demonstrationId: live.demonstrationId,
          }
        : null,
    emit: (event) => {
      if (live) forwardEvent(event);
    },
    step: (action) => {
      const step = validStep(action);
      if (step) addStep(step);
    },
    status: (mode, reason) => {
      networkMode = mode;
      if (state.phase === "starting" || state.phase === "recording")
        dispatch({
          type: "capture",
          capture: { network: mode, networkReason: reason },
        });
    },
    digests: () => digests,
  };

  async function record(
    message: Extract<PageToBackground, { type: "page.record" }>,
  ): Promise<PageResponse> {
    if (state.phase !== "idle") return { ok: false, error: SENTENCES.busy };
    // The open recording belongs to the Bot whose Record was refused: replaceOpen may stop it only for that Bot.
    const open =
      state.botId === message.botId ? state.openRecording : undefined;
    dispatch({
      type: "record",
      botId: message.botId,
      title: message.title,
      learning: bots.get(message.botId)?.learning,
    });
    let finish = () => {};
    const attempt = {
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      cancelled: false,
    };
    starting = attempt;
    try {
      const connection = await currentConnection();
      const allowed = connection !== null && (await deps.hasHostPermission());
      if (attempt.cancelled) return cancelled();
      if (!connection) return refuse(SENTENCES.noConnection);
      if (!allowed) return refuse(SENTENCES.noAccess);
      if (message.replaceOpen && open) {
        try {
          await stopOpenRecording(open.demonstrationId, connection);
        } catch (error) {
          return refuse(sentenceFor(error, SENTENCES.startFailed));
        }
        if (attempt.cancelled) return cancelled();
      }
      return await start(message, connection, attempt);
    } finally {
      if (starting === attempt) starting = null;
      finish();
    }
  }

  /** Record ended by a stop before anything recorded: idle, with no error (the person asked for it). */
  function cancelled(): PageResponse {
    dispatch({ type: "cancelled" });
    return { ok: false, error: SENTENCES.notRecording };
  }

  /** "Stop it and record here": the open recording is stopped in OpenBot, and becomes a drain if this browser holds it. */
  async function stopOpenRecording(
    demonstrationId: string,
    connection: ConnectionRecord,
  ): Promise<void> {
    await openbotJson(connection, recorderPaths.stop(demonstrationId), {
      method: "POST",
    });
    await serially(async () => {
      const held = await readLocal("activeRecording");
      if (held?.demonstrationId !== demonstrationId) return;
      const drains = (await readLocal("drains")) ?? [];
      await writeDrains([
        ...drains.filter((drain) => drain.demonstrationId !== demonstrationId),
        held,
      ]);
      await removeLocal("activeRecording");
    });
  }

  async function start(
    message: Extract<PageToBackground, { type: "page.record" }>,
    connection: ConnectionRecord,
    attempt: { cancelled: boolean },
  ): Promise<PageResponse> {
    const { botId, title, tabId } = message;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return refuse(SENTENCES.tabClosed);
    }
    // Chrome withholds the URL of a page the Recorder may not read (chrome:// pages included): such a tab starts with
    // the screen off and the network waiting, and topUrls holds "" until its first top-frame commit.
    const url = tab.url;
    const recordable = isRecordablePage(url);
    let demonstrationId: string | undefined;
    let documentStarted = false;
    let injected = false;
    let capture: NetworkCapture | null = null;
    try {
      let created: { demonstration: ExtensionDemonstration };
      try {
        created = await openbotJson(connection, recorderPaths.demonstrations, {
          body: { botId, title },
        });
      } catch (error) {
        if (
          error instanceof OpenBotError &&
          error.status === 409 &&
          error.body?.code === RECORDER_OPEN_RECORDING &&
          error.body.demonstrationId
        ) {
          dispatch({
            type: "error",
            error: SENTENCES.openRecording,
            openRecording: { demonstrationId: error.body.demonstrationId },
          });
          return { ok: false, error: SENTENCES.openRecording };
        }
        throw error;
      }
      demonstrationId = created.demonstration.id;
      if (attempt.cancelled) throw CANCELLED;
      const trajectoryId = crypto.randomUUID();
      await openbotJson(
        connection,
        recorderPaths.trajectories(demonstrationId),
        { body: { trajectoryId } },
      );
      if (attempt.cancelled) throw CANCELLED;
      const startedAt = deps.now();
      const active: DrainRecord = {
        demonstrationId,
        botId,
        title,
        openbotUrl: connection.openbotUrl,
        userId: connection.user.id,
        userName: connection.user.name,
        trajectoryIds: [trajectoryId],
        startedAt,
        discard: false,
      };
      await serially(() => writeLocal("activeRecording", active));
      await writeLocal("lastBotId", botId);
      const policy = await deps.readPolicy();
      const session: StreamSession = {
        demonstrationId,
        title,
        botId,
        openbotUrl: connection.openbotUrl,
        token: connection.token,
        trajectoryId,
        startedAt,
        allowedIntelligenceUrls: policy.allowedIntelligenceUrls,
        version: chrome.runtime.getManifest().version,
        media: { tabStreamId: null, microphone: message.microphone },
      };
      if (import.meta.env.RECORDER_VARIANT === "e2e") {
        const items = await chrome.storage.local.get(
          "RECORDER_E2E_HOLD_RETRY_MS",
        );
        const holdRetryMs: unknown = items.RECORDER_E2E_HOLD_RETRY_MS;
        if (typeof holdRetryMs === "number")
          session.e2eHoldRetryMs = holdRetryMs;
      }
      shown = { demonstrationId, trajectoryIds: new Set([trajectoryId]) };
      const port = await openDocument();
      // THEN, with nothing awaited in between: a tab stream id works once and expires within seconds, so it is taken
      // last and the document consumes it first thing.
      const tabStreamId = recordable ? await takeStreamId(tabId) : null;
      port.postMessage({
        type: "offscreen.start",
        session: { ...session, media: { ...session.media, tabStreamId } },
      } satisfies BackgroundToOffscreen);
      documentStarted = true;
      releaseEvents();
      await writeSession("stream", session);
      // Nothing records yet. A stop that came while Record waited, or a connection that went (a sign-out, Disconnect)
      // or changed meanwhile, ends Record here; nothing is awaited between this check and the recording going live.
      if (
        attempt.cancelled ||
        (await currentConnection())?.token !== connection.token
      )
        throw CANCELLED;
      live = {
        demonstrationId,
        botId,
        openbotUrl: connection.openbotUrl,
        token: connection.token,
        userId: connection.user.id,
      };
      lastPollAt = undefined;
      // Recording from here on, before the script is injected: a content script that says hello is told to capture.
      dispatch({
        type: "started",
        demonstrationId,
        tabId,
        topUrl: url ?? "",
        startedAt,
        capture: defined({
          intelligence: "connecting" as const,
          network: "off" as const,
          screen: "off" as const,
          screenReason: !recordable
            ? SENTENCES.screenOnWebsite
            : tabStreamId === null
              ? SENTENCES.screenFromPopup
              : undefined,
          voice: "off" as const,
        }),
      });
      injected = true;
      // A page the Recorder may not read refuses the script; its first commit to a website injects it.
      await injectRecordingScripts(tabId, demonstrationId).catch(
        () => undefined,
      );
      addFirstStep(url);
      // The capture owns the fallback: it alone starts, extends, resumes and stops it.
      capture = deps.createNetworkCapture(networkDeps, {
        fallback: deps.createPageFallback(),
      });
      network = capture;
      networkMode = await capture.start(tabId, url ?? "");
      dispatch({ type: "capture", capture: { network: networkMode } });
      postToContentPorts([tabId], {
        type: "background.capture",
        active: true,
        demonstrationId,
      });
      return { ok: true };
    } catch (error) {
      // Roll back in reverse.
      live = null;
      network = null;
      networkMode = "off";
      frameUrls.clear();
      if (capture)
        await capture.stop().catch(report("stopping network capture"));
      if (injected) await stopRecordingScripts([tabId]);
      if (documentStarted)
        postOffscreen({ type: "offscreen.stop", outcome: "failed" });
      releaseEvents();
      if (demonstrationId) {
        await openbotJson(
          connection,
          recorderPaths.demonstration(demonstrationId),
          {
            method: "DELETE",
          },
        ).catch(report("deleting the recording that could not start"));
        await steps.reset(demonstrationId);
      }
      await serially(() => removeLocal("activeRecording"));
      await removeSession("stream");
      if (error === CANCELLED) return cancelled();
      const reason = signedOutReason(error);
      if (reason) await forgetConnection(reason, connection.token);
      return refuse(sentenceFor(error, SENTENCES.startFailed));
    }
  }

  // ---- Stop ----------------------------------------------------------------------------------

  /** Uploads every queued step of a recording, then tells OpenBot it stopped (idempotent there). A refusal of the steps
   * (the recording is gone or already stopped) drops them; a 404 on the stop is a recording deleted in OpenBot. Anything
   * else throws, for the caller to retry or to sign out. */
  async function tellOpenBot(
    drain: DrainRecord,
    token: string,
  ): Promise<LearningSpaceState | undefined> {
    const target: StepTarget = {
      openbotUrl: drain.openbotUrl,
      token,
      demonstrationId: drain.demonstrationId,
    };
    try {
      await steps.drain(target);
    } catch (error) {
      if (!isRefusal(error)) throw error;
      await steps.reset(drain.demonstrationId);
    }
    try {
      const answer = await openbotJson<
        { demonstration?: ExtensionDemonstration } | undefined
      >(target, recorderPaths.stop(drain.demonstrationId), { method: "POST" });
      return answer?.demonstration?.learning ?? undefined;
    } catch (error) {
      if (error instanceof OpenBotError && error.status === 404)
        return undefined;
      throw error;
    }
  }

  async function moveIntoDrains(
    demonstrationId: string,
    flags: { stopPending: boolean; discard: boolean },
  ): Promise<void> {
    const drains = await serially(async () => {
      const record = await readLocal("activeRecording");
      const current = (await readLocal("drains")) ?? [];
      if (record?.demonstrationId !== demonstrationId) return current;
      const kept = earlyKept.get(demonstrationId);
      earlyKept.delete(demonstrationId);
      const drain: DrainRecord = defined({
        ...record,
        discard: flags.discard,
        stopPending: flags.stopPending ? true : undefined,
        kept,
      });
      const next = [
        ...current.filter((entry) => entry.demonstrationId !== demonstrationId),
        drain,
      ];
      await writeDrains(next);
      await removeLocal("activeRecording");
      return next;
    });
    publishDrains(drains);
  }

  async function stopRecording(mode: StopMode): Promise<void> {
    // A stop that comes while Record starts ends Record before its recording is live, or else waits for Record to
    // finish; one that comes while Start over makes its switch waits for it. Either way it then stops the recording
    // that is live. A Start over still waiting on OpenBot is not waited for: the stop wins, and that Start over finds
    // the recording ended.
    if (starting) {
      starting.cancelled = true;
      await starting.done;
    }
    if (switching) await switching;
    if (state.phase !== "recording" || !live) return;
    const current = live;
    live = null;
    const run = endRecording(current, mode);
    stopInFlight = run;
    try {
      await run;
    } finally {
      if (stopInFlight === run) stopInFlight = null;
    }
  }

  /** The stop of the recording `stopRecording` took from `live`. */
  async function endRecording(current: Live, mode: StopMode): Promise<void> {
    const since = deps.now();
    const stoppedFrom =
      mode.kind === "openbot" ? ("openbot" as const) : undefined;
    const tabIds = state.tabIds;
    const { demonstrationId } = current;
    // Persisted before anything else: awaiting does not keep a service worker alive, and a restarted one finishes the stop.
    dispatch({ type: "stop", since, stoppedFrom });
    await persisted;
    await stopRecordingScripts(tabIds);
    digests.clear();
    frameUrls.clear();
    await removeSession("digests");
    const capture = network;
    network = null;
    networkMode = "off";
    if (capture) await capture.stop().catch(report("stopping network capture"));
    const message: BackgroundToOffscreen = defined({
      type: "offscreen.stop" as const,
      outcome:
        mode.kind === "restart-failed"
          ? ("failed" as const)
          : ("succeeded" as const),
      stoppedFrom,
    });
    // Media and voice drain and the final outcome is queued before OpenBot hears of the stop. A recording kept for
    // its person, or discarded (a Disconnect is under way), waits only for a reconnecting document to hear of it.
    if (
      (mode.kind === "person" || mode.kind === "openbot") &&
      disconnecting === 0
    )
      await awaitStopped(demonstrationId, since, message);
    else await sendToDocument(message);
    dispatch({ type: "stopped" });

    let learning: LearningSpaceState | undefined;
    let error: string | undefined;
    let stopPending = false;
    let signedOut: SignedOutReason | null = null;
    if (mode.kind === "person") {
      const record = await readLocal("activeRecording");
      // Told with the connection its person has now, which is a new one when they connected again while it drained.
      const connection = await currentConnection();
      if (record && connection && ownedBy(record, connection)) {
        try {
          learning = await tellOpenBot(record, connection.token);
        } catch (failure) {
          stopPending = true;
          signedOut = signedOutReason(failure);
          if (signedOut) await forgetConnection(signedOut, connection.token);
          else error = SENTENCES.stopPending;
        }
      } else if (record) {
        // Its person's connection went while it drained: nothing goes out. Its stop stays owed, for Disconnect to
        // discard it, or for its person to send when they connect again, and a sign-out tells them so.
        stopPending = true;
        signedOut = await signedOutMeanwhile();
      }
    } else if (mode.kind === "openbot" || mode.kind === "restart-failed") {
      // The demonstration takes no more steps: what was queued after it stopped is the person's to lose.
      await steps.reset(demonstrationId);
      error = mode.kind === "openbot" ? SENTENCES.stoppedInOpenBot : mode.error;
    } else if (mode.kind === "signed-out") {
      stopPending = true;
      signedOut = mode.reason;
    }
    if (signedOut)
      error =
        signedOut === "organization"
          ? SENTENCES.organizationSignedOut
          : SENTENCES.signedOut;

    await moveIntoDrains(demonstrationId, {
      stopPending,
      discard: mode.kind === "restart-failed",
    });
    await removeSession("stream");
    dispatch({
      type: "finished",
      lastStopped: {
        demonstrationId,
        botId: current.botId,
        openbotUrl: current.openbotUrl,
      },
      learning,
      error,
    });
    if (signedOut)
      // A sign-out that forgot nothing (the person connected again) leaves their other drains to the new connection.
      await markWaiting(
        (drain) =>
          drain.userId === current.userId &&
          drain.openbotUrl === current.openbotUrl &&
          (mode.kind !== "signed-out" ||
            mode.forgot ||
            drain.demonstrationId === demonstrationId),
        signedOut,
      );
    if (offscreenDone.has(demonstrationId)) await documentDone(demonstrationId);
    if (error === SENTENCES.stopPending) scheduleStopRetry();
    await maybeCloseDocument();
  }

  /** Why the connection a stop drained under went away: a sign-out leaves its notice, the person's own Disconnect
   * leaves none (and is under way while the stop finishes, since Disconnect waits for it). */
  async function signedOutMeanwhile(): Promise<SignedOutReason | null> {
    if (disconnecting > 0) return null;
    const notice = await readLocal("notice");
    return notice?.kind === "signed-out" ? (notice.reason ?? "revoked") : null;
  }

  let stopRetryHandle: unknown = null;
  let stopRetryDelay = STOP_RETRY_FIRST_MS;

  function scheduleStopRetry(): void {
    if (stopRetryHandle !== null) return;
    const delay = stopRetryDelay;
    stopRetryDelay = Math.min(delay * 2, STOP_RETRY_MAX_MS);
    stopRetryHandle = deps.timers.set(() => {
      stopRetryHandle = null;
      void retryPendingStops().catch(report("retrying a stop"));
    }, delay);
  }

  async function finishPendingStop(
    drain: DrainRecord,
    connection: ConnectionRecord,
  ): Promise<void> {
    const learning = await tellOpenBot(drain, connection.token);
    await updateDrains((drains) =>
      drains.map((entry) => {
        if (entry.demonstrationId !== drain.demonstrationId) return entry;
        const { stopPending: _done, ...rest } = entry;
        return rest;
      }),
    );
    if (
      learning &&
      state.lastStopped?.demonstrationId === drain.demonstrationId
    )
      dispatch({ type: "learning", learning });
    if (offscreenDone.has(drain.demonstrationId))
      await documentDone(drain.demonstrationId);
  }

  /** Steps first, then the stop, for every drain whose stop has not reached OpenBot, with backoff 5 s doubling to 5 minutes. */
  async function retryPendingStops(): Promise<void> {
    const connection = await currentConnection();
    if (!connection) return;
    const pending = ((await readLocal("drains")) ?? []).filter(
      (drain) =>
        drain.stopPending &&
        !drain.kept?.waitingForReconnect &&
        ownedBy(drain, connection),
    );
    let failed = false;
    for (const drain of pending) {
      try {
        await finishPendingStop(drain, connection);
      } catch (error) {
        const reason = signedOutReason(error);
        if (reason) {
          await handleSignedOut(
            reason,
            connection.token,
            connection.user.id,
            connection.openbotUrl,
          );
          return;
        }
        failed = true;
      }
    }
    if (failed) {
      scheduleStopRetry();
      return;
    }
    stopRetryDelay = STOP_RETRY_FIRST_MS;
    if (state.error === SENTENCES.stopPending)
      dispatch({ type: "clear-error" });
  }

  // ---- Signed out ----------------------------------------------------------------------------

  /** Every drain `belongs` picks waits for its person to connect this browser again; nothing is discarded (Decision 19).
   * A recording Start over discarded is not kept for them: it only waits to be deleted in OpenBot once they connect. */
  async function markWaiting(
    belongs: (drain: DrainRecord) => boolean,
    reason: SignedOutReason,
  ): Promise<void> {
    await updateDrains((drains) =>
      drains.map((drain) =>
        !belongs(drain) || drain.discard
          ? drain
          : {
              ...drain,
              kept: {
                reason:
                  reason === "organization"
                    ? SENTENCES.keptOrganization
                    : SENTENCES.keptSignedOut,
                parked: true,
                events: drain.kept?.events ?? 0,
                at: deps.now(),
                waitingForReconnect: true,
              },
            },
      ),
    );
  }

  /** OpenBot answered that the connection a request used is gone: forget it (only if it is still the stored one), stop
   * a recording that used it, and keep everything for its person on that OpenBot (their drains on another OpenBot are
   * another connection's). */
  async function handleSignedOut(
    reason: SignedOutReason,
    token: string,
    userId: string,
    openbotUrl: string,
  ): Promise<void> {
    const forgot = await forgetConnection(reason, token);
    if (live && live.token === token && state.phase === "recording")
      // The live recording used this token, which is dead: it stops (and marks the person's other drains waiting).
      await stopRecording({ kind: "signed-out", reason, forgot });
    else if (forgot)
      await markWaiting(
        (drain) => drain.userId === userId && drain.openbotUrl === openbotUrl,
        reason,
      );
  }

  /** The document's pass or trajectory registration was answered signed out for `token`. A pass taken with an older
   * token, after the person connected again, changes nothing: the newer connection's recover may still be sending. A
   * reconnect can land between the read here and the forget, so drains wait only when the forget really happened. */
  async function documentSignedOut({
    reason,
    token,
  }: OffscreenSignedOut): Promise<void> {
    if (live && live.token === token && state.phase === "recording") {
      await handleSignedOut(reason, token, live.userId, live.openbotUrl);
      return;
    }
    const connection = await currentConnection();
    if (connection?.token !== token) return;
    if (!(await forgetConnection(reason, token))) return;
    await markWaiting((drain) => ownedBy(drain, connection), reason);
  }

  // ---- Noticing a stop made in OpenBot -------------------------------------------------------

  async function heartbeat(): Promise<void> {
    // Start over decides what happens to the recording it leaves, before and after the poll.
    if (state.phase !== "recording" || !live || live === restartingFrom) return;
    const at = deps.now();
    if (lastPollAt !== undefined && at - lastPollAt < POLL_EVERY_MS) return;
    lastPollAt = at;
    const current = live;
    let answer: { demonstration: ExtensionDemonstration | null };
    try {
      answer = await openbotJson(
        current,
        recorderPaths.openDemonstration(current.botId),
      );
    } catch (error) {
      const reason = signedOutReason(error);
      if (reason && current !== restartingFrom)
        await handleSignedOut(
          reason,
          current.token,
          current.userId,
          current.openbotUrl,
        );
      // Any other failure waits for the next heartbeat.
      return;
    }
    // An answer about a recording Start over is leaving, or one that is no longer live (Start over replaced it), decides
    // nothing.
    if (
      current === restartingFrom ||
      live !== current ||
      state.phase !== "recording"
    )
      return;
    if (answer.demonstration?.id !== current.demonstrationId) {
      await stopRecording({ kind: "openbot" });
      return;
    }
    if (answer.demonstration.learning)
      dispatch({ type: "learning", learning: answer.demonstration.learning });
  }

  // ---- Start over ----------------------------------------------------------------------------

  async function restart(): Promise<PageResponse> {
    // Start over while Record finishes (its script injection, its network capture) waits for Record: the recording it
    // leaves is then the one Record started, with its first step and its tabs told, before the switch.
    if (starting) await starting.done;
    if (state.phase !== "recording" || !live || live === restartingFrom)
      return { ok: false, error: SENTENCES.notRecording };
    const current = live;
    restartingFrom = current;
    try {
      return await rotate(current);
    } finally {
      if (restartingFrom === current) restartingFrom = null;
    }
  }

  async function rotate(current: Live): Promise<PageResponse> {
    // Stop, a sign-out or Disconnect can end the recording while Start over waits on OpenBot: after every wait it checks
    // the recording it leaves is still the live one, and once it is not, it lets go of it (a recording started next is
    // not held up) and nothing switches.
    const ended = (): boolean => {
      if (state.phase === "recording" && live === current) return false;
      if (restartingFrom === current) restartingFrom = null;
      return true;
    };
    const old = await readLocal("activeRecording");
    if (!old || ended()) return { ok: false, error: SENTENCES.notRecording };
    const target = { openbotUrl: current.openbotUrl, token: current.token };
    // Its queued steps go before its stop, because OpenBot refuses steps for a stopped recording. The drain waits behind
    // an upload in flight and reports no refusal; whatever it cannot send is discarded with the recording.
    await steps
      .drain({ ...target, demonstrationId: old.demonstrationId })
      .catch(() => undefined);
    if (ended()) return { ok: false, error: SENTENCES.notRecording };
    try {
      await openbotJson(target, recorderPaths.stop(old.demonstrationId), {
        method: "POST",
      });
    } catch (error) {
      // Still recording the old one.
      return { ok: false, error: sentenceFor(error, SENTENCES.startFailed) };
    }
    if (ended()) return { ok: false, error: SENTENCES.notRecording };
    const trajectoryId = crypto.randomUUID();
    let demonstrationId: string | undefined;
    try {
      const created = await openbotJson<{
        demonstration: ExtensionDemonstration;
      }>(target, recorderPaths.demonstrations, {
        body: { botId: old.botId, title: old.title },
      });
      demonstrationId = created.demonstration.id;
      await openbotJson(target, recorderPaths.trajectories(demonstrationId), {
        body: { trajectoryId },
      });
    } catch (error) {
      if (demonstrationId)
        await openbotJson(
          target,
          recorderPaths.demonstration(demonstrationId),
          {
            method: "DELETE",
          },
        ).catch(report("deleting the recording that could not start"));
      // A recording that ended meanwhile was stopped by whatever ended it; one started since is not this one's to stop.
      if (ended()) return { ok: false, error: SENTENCES.notRecording };
      // The old recording is stopped in OpenBot and no new one exists: stop here too.
      const sentence = sentenceFor(error, SENTENCES.startFailed);
      await stopRecording({ kind: "restart-failed", error: sentence });
      return { ok: false, error: sentence };
    }
    // The document must hear of the switch: while its port reconnects, the wait happens here, before the switch begins,
    // so nothing in the switch waits.
    await documentPort(READY_TIMEOUT_MS);
    if (ended()) {
      // The recording ended while OpenBot created the new one, or while the document reconnected, and the new one never
      // starts here: it is deleted as a recording that could not start is. Best effort: after a sign-out the token no
      // longer works, and OpenBot's own rules close it.
      await openbotJson(target, recorderPaths.demonstration(demonstrationId), {
        method: "DELETE",
      }).catch(() => undefined);
      return { ok: false, error: SENTENCES.notRecording };
    }
    // From here nothing waits on OpenBot. A stop that comes now waits for the switch (stopRecording), so it is never
    // told to the document or the tabs before the switch is.
    let switched = () => {};
    switching = new Promise<void>((resolve) => {
      switched = resolve;
    });
    try {
      await switchTo(current, old, demonstrationId, trajectoryId);
    } finally {
      switching = null;
      switched();
    }
    return { ok: true };
  }

  /** Saves the new recording as the active one and the old one as a discarded drain, then makes the switch in memory and
   * tells the document and the tabs in one turn, with nothing awaited in between. */
  async function switchTo(
    current: Live,
    old: DrainRecord,
    demonstrationId: string,
    trajectoryId: string,
  ): Promise<void> {
    const startedAt = deps.now();
    const next: DrainRecord = {
      demonstrationId,
      botId: old.botId,
      title: old.title,
      openbotUrl: old.openbotUrl,
      userId: old.userId,
      userName: old.userName,
      trajectoryIds: [trajectoryId],
      startedAt,
      discard: false,
    };
    const drains = await serially(async () => {
      const previous = (await readLocal("activeRecording")) ?? old;
      const existing = (await readLocal("drains")) ?? [];
      const changed = [
        ...existing.filter(
          (drain) => drain.demonstrationId !== previous.demonstrationId,
        ),
        { ...previous, discard: true },
      ];
      await writeLocal("activeRecording", next);
      await writeDrains(changed);
      return changed;
    });
    const stream = await readSession("stream");
    if (stream)
      await writeSession("stream", {
        ...stream,
        demonstrationId,
        trajectoryId,
        startedAt,
      });
    // The discarded recording's queued steps go with it; the new one counts from zero.
    await steps.reset(old.demonstrationId);
    live = { ...current, demonstrationId };
    shown = { demonstrationId, trajectoryIds: new Set([trajectoryId]) };
    frameUrls.clear();
    postOffscreen({ type: "offscreen.rotate", demonstrationId, trajectoryId });
    dispatch({ type: "restart", demonstrationId, startedAt });
    publishDrains(drains);
    postToContentPorts(
      state.tabIds,
      { type: "background.notice", show: false, steps: 0 },
      { topFrameOnly: true },
    );
    postToContentPorts(state.tabIds, {
      type: "background.capture",
      active: true,
      demonstrationId,
    });
    // Taken in the same turn as the switch, so it is the new recording's first step.
    const tabId = state.tabIds[0];
    addFirstStep(tabId === undefined ? undefined : state.topUrls[tabId]);
  }

  // ---- The 50-step notice --------------------------------------------------------------------

  async function noticeChoice(
    choice: "stop" | "restart" | "continue",
  ): Promise<PageResponse> {
    postToContentPorts(
      state.tabIds,
      { type: "background.notice", show: false, steps: state.steps },
      { topFrameOnly: true },
    );
    if (choice === "stop") {
      await stopRecording({ kind: "person" });
      return { ok: true };
    }
    if (choice === "restart") return restart();
    return { ok: true };
  }

  // ---- Screen --------------------------------------------------------------------------------

  async function startScreen(tabId: number): Promise<boolean> {
    const tabStreamId = await takeStreamId(tabId);
    // A stop that came while the stream id was taken already told the document to stop: no screen starts after it.
    if (state.phase !== "recording") return false;
    if (
      tabStreamId &&
      postOffscreen({ type: "offscreen.screen", tabStreamId })
    ) {
      dispatch({
        type: "capture",
        capture: { screen: "off", screenReason: undefined },
      });
      return true;
    }
    dispatch({
      type: "capture",
      capture: { screen: "off", screenReason: SENTENCES.screenFromPopup },
    });
    return false;
  }

  async function recordScreen(): Promise<PageResponse> {
    const tabId = state.tabIds[0];
    if (state.phase !== "recording" || tabId === undefined)
      return { ok: false, error: SENTENCES.notRecording };
    if (await startScreen(tabId)) return { ok: true };
    return {
      ok: false,
      error:
        state.phase === "recording"
          ? SENTENCES.screenFromPopup
          : SENTENCES.notRecording,
    };
  }

  // ---- Kept events, Disconnect and reconnecting ----------------------------------------------

  /** The person's own discard: the document clears their outbox and media, and the queued steps go here. */
  async function discardDrains(demonstrationIds: string[]): Promise<void> {
    if (demonstrationIds.length === 0) return;
    const port = await openDocument();
    try {
      port.postMessage({
        type: "offscreen.discard",
        demonstrationIds,
      } satisfies BackgroundToOffscreen);
    } finally {
      releaseEvents();
    }
    const database = await db();
    for (const id of demonstrationIds)
      await deleteDemonstrationData(database, id);
    await updateDrains((drains) =>
      drains.filter(
        (drain) => !demonstrationIds.includes(drain.demonstrationId),
      ),
    );
  }

  async function discardKept(): Promise<PageResponse> {
    const drains = (await readLocal("drains")) ?? [];
    await discardDrains(
      drains
        .filter((drain) => drain.kept)
        .map((drain) => drain.demonstrationId),
    );
    return { ok: true };
  }

  /** The person who recorded kept drains is connected again: send everything kept while signed out. Drains of another
   * person, or of another OpenBot, keep waiting: they are never sent under someone else's connection. */
  async function sendKept(): Promise<void> {
    const connection = await currentConnection();
    if (!connection) return;
    const drains = await updateDrains((all) =>
      all.map((drain) => {
        if (!ownedBy(drain, connection) || !drain.kept?.waitingForReconnect)
          return drain;
        const { kept: _waiting, ...rest } = drain;
        return rest;
      }),
    );
    const own = drains.filter((drain) => ownedBy(drain, connection));
    if (own.length === 0) return;
    for (const drain of own) {
      try {
        if (drain.stopPending) await finishPendingStop(drain, connection);
        else
          await steps.drain({
            openbotUrl: drain.openbotUrl,
            token: connection.token,
            demonstrationId: drain.demonstrationId,
          });
      } catch (error) {
        const reason = signedOutReason(error);
        if (reason) {
          await handleSignedOut(
            reason,
            connection.token,
            connection.user.id,
            connection.openbotUrl,
          );
          return;
        }
        if (isRefusal(error)) await steps.reset(drain.demonstrationId);
        else scheduleStopRetry();
      }
    }
    const port = await openDocument();
    try {
      const fresh = ((await readLocal("drains")) ?? []).filter((drain) =>
        ownedBy(drain, connection),
      );
      port.postMessage({
        type: "offscreen.recover",
        openbotUrl: connection.openbotUrl,
        token: connection.token,
        drains: fresh,
      } satisfies BackgroundToOffscreen);
    } finally {
      releaseEvents();
    }
  }

  // ---- The popup's answers -------------------------------------------------------------------

  async function currentMe(
    connection: ConnectionRecord,
  ): Promise<RecorderMe | null> {
    const cached = await readSession("me");
    if (
      cached &&
      cached.value.connectionId === connection.connectionId &&
      deps.now() - cached.fetchedAt < ME_FRESH_MS
    )
      return cached.value;
    try {
      const value = await openbotJson<RecorderMe>(connection, recorderPaths.me);
      await writeSession("me", { value, fetchedAt: deps.now() });
      return value;
    } catch (error) {
      const reason = signedOutReason(error);
      if (reason) {
        await forgetConnection(reason, connection.token);
        await removeSession("me");
        return null;
      }
      // OpenBot cannot answer for now: the last answer for this connection, if any.
      return cached?.value.connectionId === connection.connectionId
        ? cached.value
        : null;
    }
  }

  async function pageState(): Promise<PageStateResponse> {
    const known = await currentConnection();
    const me = known ? await currentMe(known) : null;
    const connection = await currentConnection();
    const policy = await deps.readPolicy();
    const notice = (await readLocal("notice")) ?? null;
    const drains = (await readLocal("drains")) ?? [];
    return {
      ok: true,
      state: defined({
        ...state,
        draining: drains.length,
        kept: keptSummary(drains),
      }),
      connection: connection
        ? {
            openbotUrl: connection.openbotUrl,
            user: { name: connection.user.name, email: connection.user.email },
            via: connection.via,
          }
        : null,
      me: connection ? me : null,
      policy: {
        openbotUrl: policy.openbotUrl,
        invalid: policy.openbotUrlInvalid,
      },
      notice,
    };
  }

  async function listBots(): Promise<PageResponse> {
    const connection = await currentConnection();
    if (!connection) return { ok: false, error: SENTENCES.noConnection };
    try {
      const answer = await openbotJson<{ bots: RecorderBot[] }>(
        connection,
        recorderPaths.bots,
      );
      bots = new Map(answer.bots.map((bot) => [bot.id, bot]));
      return { ok: true, bots: answer.bots };
    } catch (error) {
      const reason = signedOutReason(error);
      if (reason) await forgetConnection(reason, connection.token);
      return {
        ok: false,
        error: sentenceFor(error, "OpenBot did not answer. Try again."),
      };
    }
  }

  function flood(count: number): PageResponse {
    if (state.phase !== "recording" || !live)
      return { ok: false, error: SENTENCES.notRecording };
    for (let i = 0; i < count; i++)
      forwardEvent({
        type: "CUSTOM",
        name: "recorder.e2e",
        timestamp: deps.now(),
        value: { i },
      });
    return { ok: true };
  }

  // ---- Content scripts and navigation --------------------------------------------------------

  function tellPort(port: chrome.runtime.Port, active: boolean): void {
    try {
      port.postMessage(
        active
          ? {
              type: "background.capture",
              active: true,
              demonstrationId: state.demonstrationId,
            }
          : { type: "background.capture", active: false },
      );
    } catch {
      // The frame went away.
    }
  }

  /** A sub-frame's step belongs to the page the person sees (Decision 17); a top URL the schema refuses keeps the step's own. */
  function fromTopPage(
    action: DemonstrationAction,
    topUrl: string | undefined,
  ): DemonstrationAction {
    return (
      validStep({ ...action, url: safeDemonstrationUrl(topUrl ?? "") }) ??
      action
    );
  }

  function onContentMessage(
    port: chrome.runtime.Port,
    message: ContentToBackground,
  ): void {
    const tabId = port.sender?.tab?.id;
    const followed =
      state.phase === "recording" &&
      live !== null &&
      tabId !== undefined &&
      state.tabIds.includes(tabId);
    if (message.type === "content.hello") {
      tellPort(port, followed);
      return;
    }
    if (state.phase !== "recording" || tabId === undefined) return;
    if (!followed) {
      // Only a tab that navigated away from a recording and back can still hold a running script.
      tellPort(port, false);
      return;
    }
    switch (message.type) {
      case "content.event":
        forwardEvent(message.event as CapturedEvent);
        return;
      case "content.step":
        addStep(
          port.sender?.frameId === 0
            ? message.action
            : fromTopPage(message.action, state.topUrls[tabId]),
        );
        return;
      case "content.sensitive":
        // Memory only: it survives a service-worker restart, vanishes with the browser, and goes at Stop.
        digests.add(message.digest);
        void writeSession("digests", [...digests]).catch(
          report("keeping a sensitive-value digest"),
        );
        return;
      case "content.notice":
        void noticeChoice(message.choice).catch(report("the notice choice"));
        return;
    }
  }

  function onNavigation(
    details: NavigationDetails,
    kind: "commit" | "history",
  ): void {
    if (state.phase !== "recording" || !live) return;
    const { tabId, frameId, url } = details;
    if (!state.tabIds.includes(tabId)) return;
    const frame = `${tabId}:${frameId}`;
    const from = frameId === 0 ? state.topUrls[tabId] : frameUrls.get(frame);
    forwardEvent(navigationEvent(details, kind, from || undefined));
    frameUrls.set(frame, url);
    const step = navigateStep(details, kind);
    const valid = step ? validStep(step) : null;
    if (valid) addStep(valid);
    if (frameId === 0) dispatch({ type: "page", tabId, url });
    if (kind !== "commit") return;
    // The script's own guard makes a repeat harmless; a frame Chrome refuses (an opaque sandboxed one) is skipped.
    void injectRecordingScripts(tabId, live.demonstrationId, [frameId]).catch(
      () => undefined,
    );
    void network
      ?.onCommitted(tabId, frameId, url)
      .catch(report("following a navigation"));
    if (
      frameId === 0 &&
      tabId === state.tabIds[0] &&
      isRecordablePage(url) &&
      state.capture.screen === "off" &&
      state.capture.screenReason === SENTENCES.screenOnWebsite
    )
      void startScreen(tabId).catch(report("starting the screen"));
  }

  function onCreatedTarget(
    details: chrome.webNavigation.WebNavigationSourceCallbackDetails,
  ): void {
    if (
      state.phase !== "recording" ||
      !state.tabIds.includes(details.sourceTabId) ||
      state.tabIds.includes(details.tabId)
    )
      return;
    dispatch({ type: "follow", tabId: details.tabId, url: details.url });
    void network
      ?.addTab(details.tabId, details.url)
      .catch(report("following a new tab"));
  }

  chrome.webNavigation.onCommitted.addListener((details) => {
    void ready
      .then(() => onNavigation(details, "commit"))
      .catch(report("recording a navigation"));
  });
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    void ready
      .then(() => onNavigation(details, "history"))
      .catch(report("recording a navigation"));
  });
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    void ready
      .then(() => onCreatedTarget(details))
      .catch(report("following a new tab"));
  });

  // ---- The router's handlers -----------------------------------------------------------------

  return {
    async page(message) {
      await ready;
      if (
        import.meta.env.RECORDER_VARIANT === "e2e" &&
        message.type === "RECORDER_E2E_FLOOD"
      )
        return flood(message.count);
      switch (message.type) {
        case "page.state":
          return pageState();
        case "page.bots":
          return listBots();
        case "page.record":
          return record(message);
        case "page.stop":
          await stopRecording({ kind: "person" });
          return { ok: true };
        case "page.restart":
          return restart();
        case "page.notice":
          return noticeChoice(message.choice);
        case "page.notice.dismiss":
          await removeLocal("notice");
          return { ok: true };
        case "page.screen":
          return recordScreen();
        case "page.kept.discard":
          return discardKept();
        default:
          return { ok: false, error: "Unknown request." };
      }
    },

    async external(
      message: ExternalToBackground,
      sender: chrome.runtime.MessageSender,
    ): Promise<ExternalResponse> {
      await ready;
      if (message.type !== "recorder.page-network")
        return { ok: false, error: "invalid" };
      const tabId = sender.tab?.id;
      if (
        state.phase !== "recording" ||
        !live ||
        !network ||
        tabId === undefined ||
        !state.tabIds.includes(tabId) ||
        networkMode !== "page"
      )
        return { ok: false, error: "not-recording" };
      const result = deps.acceptPageNetworkEvent(
        message.event as CapturedEvent,
        digests,
      );
      if (!result) return { ok: false, error: "invalid" };
      await network.recordPageEvent(result.event);
      const step = result.step ? validStep(result.step) : null;
      if (step) addStep(step);
      return { ok: true };
    },

    contentPort(port) {
      trackContentPort(port);
      // Attached at once: the content port flushes its buffer the moment it connects.
      port.onMessage.addListener((message: ContentToBackground) => {
        void ready
          .then(() => onContentMessage(port, message))
          .catch(report("a content message"));
      });
    },

    offscreenPort(port) {
      offscreen = port;
      documentReady = false;
      port.onMessage.addListener((message: OffscreenToBackground) => {
        void ready
          .then(() => onOffscreenMessage(port, message))
          .catch(report("an offscreen message"));
      });
      port.onDisconnect.addListener(() => {
        if (offscreen !== port) return;
        offscreen = null;
        documentReady = false;
      });
      // The events that waited go first, then whatever waited for the port.
      flushEvents();
      const waiters = connectWaiters;
      connectWaiters = [];
      for (const waiter of waiters) waiter(port);
    },

    async connected() {
      await ready;
      // The connect page waits on this answer: the sending runs on its own.
      void sendKept().catch(report("sending kept recordings"));
    },

    async disconnected() {
      disconnecting += 1;
      try {
        await ready;
        // Everything is discarded: a Stop waiting for the document to drain stops waiting (the document is still told).
        for (const finish of [...stopWaiters.values()]) finish();
        // Ends a Record still starting, and a recording in progress, without telling OpenBot.
        await stopRecording({ kind: "disconnect" });
        // A stop still under way finishes first, so the recording it moves into the drains is discarded with the rest.
        if (stopInFlight) await stopInFlight;
        const drains = (await readLocal("drains")) ?? [];
        await discardDrains(drains.map((drain) => drain.demonstrationId));
        if (state.error !== undefined && KEPT_SENTENCES.includes(state.error))
          dispatch({ type: "clear-error" });
      } finally {
        disconnecting -= 1;
      }
    },
  };
}
