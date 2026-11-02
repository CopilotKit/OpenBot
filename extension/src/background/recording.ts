// The recording controller: Record, the tabs a recording follows, the 50-action notice, Stop, Start over and the
// drains that keep sending after it. A recording goes to Intelligence only: Record takes a new trajectory id, the
// offscreen document asks OpenBot for a capture pass (the trajectory joins the person's own Learning space) and streams
// every event to Intelligence, and
// Stop queues the outcome and lets the outbox drain. OpenBot hears nothing of the recording itself, only what the
// Recorder is doing (its phase, the recording's title and how many actions so far, activity.ts), for the Browser
// button's red dot. The phase lives in a
// reducer (`reduceRecorder`), persisted to storage.session after every transition so a restarted service worker finds
// it; what must survive a browser restart lives in storage.local (`activeRecording`, `drains`) and in the document's
// IndexedDB outbox.
import {
  type LearningSpaceState,
  RECORDER_AUTHORITY_UNAVAILABLE,
  type RecorderLearningResponse,
  type RecorderMe,
  recorderPaths,
  TRAJECTORY_GATE_REFUSALS,
} from "@openbot/shared/recorder-api";
import {
  type CapturedEvent,
  scrubText,
  scrubTranscript,
  scrubUrl,
} from "@openbot/shared/recorder-masking";
import type {
  BackgroundToContent,
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
import { hasHostPermission } from "../shared/host-access";
import {
  KEPT_FOR_PERSON_DAYS,
  KEPT_FOR_PERSON_MS,
  RECORDER_ACTION_NOTICE_AT,
} from "../shared/limits";
import { OpenBotError, openbotJson } from "../shared/openbot-client";
import { isRecordablePage } from "../shared/origin";
import {
  allowsOpenBot,
  onPolicyChanged,
  type RecorderPolicy,
  readPolicy,
} from "../shared/policy";
import { isExcludedSite, siteOf } from "../shared/sites";
import { narrationLanguage } from "../shared/speech-language";
import {
  type ConnectionRecord,
  type DrainRecord,
  type HeldEvent,
  type HeldSteps,
  type KeptEvents,
  readLocal,
  readSession,
  removeLocal,
  removeSession,
  writeLocal,
  writeSession,
} from "../shared/storage";
import { createActivityReport } from "./activity";
import {
  type AgentEvents,
  type AgentSnapshot,
  createAgentEvents,
} from "./agent/events";
import type { CaptureObservation } from "./agent/observation";
import { showBadge } from "./badge";
import {
  type ConnectionLoss,
  currentConnection,
  forgetConnection,
} from "./connection";
import { maskContentEvent } from "./content-masking";
import {
  forgetContentPorts,
  injectRecordingScripts,
  postToContentPorts,
  stopRecordingScripts,
  trackContentPort,
} from "./content-scripts";
import { type NavigationDetails, navigationEvent } from "./navigation";
import {
  createNetworkCapture,
  type NetworkCapture,
  type NetworkCaptureDeps,
  type NetworkMode,
} from "./network";
import { acceptPageNetworkEvent, createPageFallback } from "./network/fallback";
import {
  closeOffscreenDocument,
  ensureOffscreenDocument,
  hasOffscreenDocument,
} from "./offscreen-document";
import type { RouterHandlers } from "./router";
import {
  createStepAssembler,
  type StepAssembler,
  type StepSnapshot,
} from "./steps";

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type RecordingDeps = {
  createNetworkCapture: typeof createNetworkCapture;
  createAgentEvents: typeof createAgentEvents;
  createPageFallback: typeof createPageFallback;
  acceptPageNetworkEvent: typeof acceptPageNetworkEvent;
  readPolicy: typeof readPolicy;
  hasHostPermission: typeof hasHostPermission;
  now(): number;
  /** Every wait (the document's ready, the stop watchdog) goes through these. */
  timers: Timers;
  /** The held steps' own timers (steps.ts) and the writes that keep them (`heldSteps`): the browser's timers unless a
   * test passes its own. */
  stepTimers?: Timers;
};

/** Called by the router after Task 8's handler answered: `connected` after a successful `page.connect.decide` (web or Desktop),
 * `disconnected` after `page.disconnect` (the person's own Disconnect). `connectionLost` is connection.ts's: the
 * keep-alive's signed-out answer, the organization's policy moving the Recorder away from the connection's OpenBot, or a
 * connection to another OpenBot, or for another person, replacing it. */
type ConnectionEvents = {
  connected(): Promise<void>;
  disconnected(): Promise<void>;
  connectionLost(loss: ConnectionLoss): Promise<void>;
};

/** What the Recorder's launcher asks of the controller (launcher.ts), beyond what the popup asks through its messages. */
export type LauncherSide = {
  /** One phrase the launcher heard, with when the person started and stopped saying it (epoch ms): with narration
   * `external`, placed among the steps as a phrase of the document's own recogniser is, masked the same way. */
  narrate(phrase: {
    text: string;
    startedAt: number;
    endedAt: number;
  }): Promise<PageResponse>;
  /** The launcher heard the person begin a phrase at `since` (epoch ms), or stop speaking (null): with narration
   * `external`, the steps from `since` on wait for that phrase, as they wait for one the document hears. */
  speaking(since: number | null): Promise<PageResponse>;
  /** The recorder's state as it is now. */
  current(): Promise<RecorderState>;
};

/** What recovery.ts drives after a browser or service-worker restart (Task 9's Recovery), on the controller installed last. */
export type RecordingRecovery = {
  /** The phase this service worker found in storage.session when it started: idle after a browser restart. */
  loadedPhase(): Promise<RecorderState["phase"]>;
  /** A browser restart mid-recording: the recording moves into the drains, to be sent with an interrupted outcome, and
   * the popup says it was interrupted. */
  interrupt(): Promise<void>;
  /** A Record a service-worker restart cut short is discarded, as a Record that fails is. */
  abandonStart(): Promise<void>;
  /** Finishes a Stop a service-worker restart cut short, through the one stop path; resolves with the recording it
   * stopped. */
  resumeStop(): Promise<string | null>;
  /** The live recording after a service-worker restart: network capture again and, when it is gone, the document. */
  resumeRecording(): Promise<void>;
  /** Finishes every discard a restart interrupted, whoever is connected: the document clears what it holds of those
   * recordings (a document that outlived the service worker would otherwise keep sending them). */
  finishDiscards(): Promise<void>;
  /** offscreen.recover for every drain of the connected person. Drains of anyone else wait for their person to connect
   * again. */
  sendDrains(): Promise<void>;
  /** Deletes, unsent, every recording that has waited for its person longer than KEPT_FOR_PERSON_MS. */
  expireWaiting(): Promise<void>;
  /** Asks the open document to report on one drain again: answers it sent before that recording reached the drains were
   * held in the memory of the service worker that stopped. */
  recoverDrain(recordingId: string): Promise<void>;
};

let installedRecovery: RecordingRecovery | null = null;

/** The controller a restarted service worker installed, for recovery.ts. */
export function recordingRecovery(): RecordingRecovery | null {
  return installedRecovery;
}

const READY_TIMEOUT_MS = 5_000;
const STOP_WATCHDOG_MS = 120_000;
const ME_FRESH_MS = 60_000;
/** How often a running recording asks OpenBot whether its connection still stands. */
const CONNECTION_CHECK_MS = 30_000;
/** While the offscreen port is down, content events wait here; beyond either cap the oldest go, counted (Decision 19). */
const QUEUE_EVENTS = 2_000;
const QUEUE_BYTES = 8 * 1024 * 1024;
/** The collector events that are something the person did; page loads in a followed tab's top frame count too. */
const ACTION_EVENTS = new Set(["click", "input", "submit", "key"]);
/** The content events that are the person's steps: held until each one's save is known (steps.ts). */
const STEP_EVENTS = ACTION_EVENTS;
/** The held steps are written at once when they change, then at most this often while they keep changing: a step
 * reaches storage within this long of arriving, and a chatty page costs at most ten writes a second. */
const HELD_WRITE_MS = 100;
/** The most digests of what was typed into sensitive fields kept per tab, latest last: a digest comes with each keystroke,
 * so this is a few secrets typed lately. */
const TYPED_SECRETS = 64;
/** How long Stop waits for the document to hand over the phrase being spoken (its speech service has 1.5 s). */
const VOICE_END_MS = 2_000;
const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
/** Timers for an assembler that only takes up held steps to send them at once (a browser restart): none ever fires. */
const NO_TIMERS: Timers = { set: () => null, clear: () => {} };
/** Held steps that hold nothing, written beside an agent context. */
const NOTHING_HELD: StepSnapshot = {
  queue: [],
  calls: [],
  typed: [],
  speech: null,
};

/** The events a snapshot of held steps sends, in order, with what each owns and its key: after a browser quit nothing
 * more can arrive for them. */
export function heldEvents(
  snapshot: StepSnapshot,
  now: () => number,
): HeldEvent[] {
  const events: HeldEvent[] = [];
  const assembler = createStepAssembler({
    emit: (event, key) =>
      events.push(key === undefined ? { event } : { event, key }),
    now,
    timers: NO_TIMERS,
  });
  assembler.restore(snapshot);
  assembler.flush();
  assembler.clear();
  return events;
}

const SENTENCES = {
  noConnection: "Connect this browser to OpenBot first.",
  badSite: "That is not a website the Recorder can leave out.",
  // The install grants website access; only the person's own Site access setting can withhold it afterwards.
  noAccess:
    "Site access is off for OpenBot Recorder. Open your browser's Extensions page, choose Details on OpenBot Recorder and set Site access to On all sites.",
  busy: "A recording is already running.",
  notRecording: "Nothing is being recorded.",
  noVoice: "This recording has no voice.",
  ownVoice: "This browser hears your voice itself.",
  tabClosed:
    "That tab is closed. Open the Recorder on the tab you want to start recording in.",
  startFailed: "The recording could not start. Try again.",
  documentFailed: "The Recorder could not start recording. Try again.",
  restartUnreachable:
    "The Recorder could not start over just now. Your recording goes on; try again in a moment.",
  signedOut: `This browser was disconnected from OpenBot. Your recording stopped, and everything in it is kept in this browser for ${KEPT_FOR_PERSON_DAYS} days, until you connect again.`,
  organizationSignedOut: `Your organization sign-in ended. Your recording stopped, and everything in it is kept in this browser for ${KEPT_FOR_PERSON_DAYS} days, until you connect again.`,
  policyMoved: `Your organization moved the Recorder to another OpenBot. Your recording stopped, and everything in it is kept in this browser for ${KEPT_FOR_PERSON_DAYS} days.`,
  policyRefused:
    "Your organization's Recorder policy does not allow this OpenBot. Ask your IT team.",
  replaced: `This browser was connected to another OpenBot or person. Your recording stopped, and everything in it is kept in this browser for ${KEPT_FOR_PERSON_DAYS} days, until you connect again.`,
  keptSignedOut: "This browser was disconnected from OpenBot.",
  keptOrganization: "Your organization sign-in ended.",
  keptPolicy: "Your organization moved the Recorder to another OpenBot.",
  keptReplaced: "This browser was connected to another OpenBot or person.",
  authorityUnavailable: TRAJECTORY_GATE_REFUSALS.authorityUnavailable.message,
  forbidden: "OpenBot does not let you record. Ask whoever runs it.",
} as const;

type SignedOutReason = "revoked" | "removed" | "organization";
/** Why a connection went without the person's Disconnect: OpenBot signed it out, the policy moved the Recorder, or the
 * person connected this browser to another OpenBot, or as another person, on the Connect page. */
type LostReason = SignedOutReason | "policy" | "replaced";

/** The sentences that say a stopped recording is kept until something happens: a Disconnect discards it, so they go. */
const KEPT_SENTENCES: readonly string[] = [
  SENTENCES.signedOut,
  SENTENCES.organizationSignedOut,
  SENTENCES.policyMoved,
  SENTENCES.replaced,
];

const stoppedSentence = (reason: LostReason): string =>
  reason === "organization"
    ? SENTENCES.organizationSignedOut
    : reason === "policy"
      ? SENTENCES.policyMoved
      : reason === "replaced"
        ? SENTENCES.replaced
        : SENTENCES.signedOut;

const keptSentence = (reason: LostReason): string =>
  reason === "organization"
    ? SENTENCES.keptOrganization
    : reason === "policy"
      ? SENTENCES.keptPolicy
      : reason === "replaced"
        ? SENTENCES.keptReplaced
        : SENTENCES.keptSignedOut;

/** Record found the policy no longer allows the connection's OpenBot (connection.ts forgets it in a moment). */
const POLICY_REFUSED = new Error("The policy does not allow this OpenBot.");

/** Record ended by a stop (Stop, Disconnect, a sign-out) before its recording was live: it rolls back. */
const CANCELLED = new Error("Record was cancelled before it started.");

// ---- The state machine -------------------------------------------------------------------------

type RecorderEvent =
  | {
      type: "record";
      title: string;
      learning?: LearningSpaceState;
    }
  | {
      type: "started";
      recordingId: string;
      tabId: number;
      topUrl: string;
      startedAt: number;
      capture: CaptureStatus;
    }
  | { type: "action" }
  | { type: "phrases"; recordingId: string; count: number }
  | { type: "notice" }
  | { type: "notice-answered" }
  | { type: "follow"; tabId: number; url: string }
  | { type: "use"; tabId: number }
  | { type: "page"; tabId: number; url: string }
  | { type: "capture"; capture: Partial<CaptureStatus> }
  | { type: "stop"; since: number }
  | {
      type: "finished";
      /** Absent for a recording a Disconnect discards: nothing of it is sent. */
      lastStopped?: NonNullable<RecorderState["lastStopped"]>;
      error?: string;
    }
  | { type: "restart"; recordingId: string; startedAt: number }
  | { type: "drains"; draining: number; kept?: RecorderState["kept"] }
  | { type: "send-failed"; error: string }
  | { type: "error"; error: string }
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
        title: event.title,
        learning: event.learning,
      });
    case "started":
      return {
        ...state,
        phase: "recording",
        recordingId: event.recordingId,
        tabIds: [event.tabId],
        topUrls: { [event.tabId]: event.topUrl },
        startedAt: event.startedAt,
        actions: 0,
        noticeShown: false,
        noticeOpen: false,
        capture: event.capture,
      };
    case "action":
      return { ...state, actions: state.actions + 1 };
    case "phrases": {
      // The recording they belong to, while it runs or stops; once it has stopped, what Stop reported of it.
      if (
        state.recordingId === event.recordingId &&
        (state.phase === "recording" || state.phase === "stopping")
      )
        return { ...state, phrases: (state.phrases ?? 0) + event.count };
      const stopped = state.lastStopped;
      if (
        stopped?.recordingId !== event.recordingId ||
        stopped.phrases === undefined
      )
        return state;
      return {
        ...state,
        lastStopped: { ...stopped, phrases: stopped.phrases + event.count },
      };
    }
    case "notice":
      return {
        ...state,
        noticeShown: true,
        noticeOpen: true,
        noticeAt: state.actions,
      };
    case "notice-answered":
      return { ...state, noticeOpen: false };
    case "follow": {
      if (state.tabIds.includes(event.tabId)) return state;
      const used = state.usedTabIds?.filter((id) => id !== event.tabId);
      return defined({
        ...state,
        tabIds: [...state.tabIds, event.tabId],
        topUrls: { ...state.topUrls, [event.tabId]: event.url },
        usedTabIds: used?.length ? used : undefined,
      });
    }
    case "use":
      if (
        state.tabIds.includes(event.tabId) ||
        state.usedTabIds?.includes(event.tabId)
      )
        return state;
      return {
        ...state,
        usedTabIds: [...(state.usedTabIds ?? []), event.tabId],
      };
    case "page":
      return {
        ...state,
        topUrls: { ...state.topUrls, [event.tabId]: event.url },
      };
    case "capture": {
      const capture = { ...state.capture, ...event.capture };
      // The document's Intelligence status comes whole, its reason left out when there is none (a message drops an
      // undefined field): streaming again after a retry says nothing more of the retry.
      if (
        "intelligence" in event.capture &&
        !("intelligenceReason" in event.capture)
      )
        delete capture.intelligenceReason;
      return { ...state, capture: defined(capture) };
    }
    case "stop":
      return {
        ...state,
        phase: "stopping",
        noticeOpen: false,
        stopping: { since: event.since },
      };
    case "finished":
      return defined({
        ...IDLE_STATE,
        ...kept,
        lastStopped: event.lastStopped,
        // The Learning space belongs to the recording that went to Intelligence; with none, there is none to show.
        learning: event.lastStopped ? state.learning : undefined,
        error: event.error,
      });
    case "restart": {
      const { noticeAt: _previous, phrases: _said, ...rest } = state;
      return {
        ...rest,
        recordingId: event.recordingId,
        startedAt: event.startedAt,
        actions: 0,
        noticeShown: false,
        noticeOpen: false,
      };
    }
    case "drains":
      return defined({ ...state, draining: event.draining, kept: event.kept });
    case "send-failed":
      // The recording Stop ended last never reached Intelligence: the popup says so instead of where it went.
      return defined({
        ...state,
        lastStopped: undefined,
        learning: undefined,
        error: event.error,
      });
    case "error":
      return defined({
        ...IDLE_STATE,
        ...kept,
        lastStopped: state.lastStopped,
        error: event.error,
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
  createAgentEvents,
  createPageFallback,
  acceptPageNetworkEvent,
  readPolicy,
  hasHostPermission,
  now: () => Date.now(),
  timers: {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
};

/** The live recording: whom it belongs to and the token its passes are asked for with. */
type Live = {
  recordingId: string;
  openbotUrl: string;
  token: string;
  userId: string;
};

type StopMode =
  | { kind: "person" } // Stop: the outcome is queued, then the outbox drains
  | { kind: "signed-out"; reason: LostReason; forgot: boolean } // kept for the person (only this recording when the connection was not forgotten)
  | { kind: "disconnect" }; // the person's Disconnect: discarded right after

const signedOutReason = (error: unknown): SignedOutReason | null =>
  error instanceof OpenBotError && error.signedOut
    ? (error.body?.reason ?? "revoked")
    : null;

/** What the popup says when OpenBot refused a request: the Recorder's own sentence for what OpenBot answered, never the
 * text in its answer, which the popup would show in the Recorder's own voice. */
const sentenceFor = (error: unknown, fallback: string): string => {
  if (!(error instanceof OpenBotError)) return fallback;
  if (error.body?.code === RECORDER_AUTHORITY_UNAVAILABLE)
    return SENTENCES.authorityUnavailable;
  return error.status === 403 ? SENTENCES.forbidden : fallback;
};

const ownedBy = (drain: DrainRecord, connection: ConnectionRecord): boolean =>
  drain.userId === connection.user.id &&
  drain.openbotUrl === connection.openbotUrl;

function report(what: string): (error: unknown) => void {
  return (error) => console.error(`Recorder: ${what} failed`, error);
}

function liveFrom(record: DrainRecord, token: string): Live {
  return {
    recordingId: record.recordingId,
    openbotUrl: record.openbotUrl,
    token,
    userId: record.userId,
  };
}

/** The page/content/offscreen handlers the router calls. Defaults are the real modules; tests pass doubles. */
export function installRecording(
  overrides: Partial<RecordingDeps> = {},
): RouterHandlers & ConnectionEvents & LauncherSide {
  const deps: RecordingDeps = { ...defaultDeps, ...overrides };
  forgetContentPorts();

  let state: RecorderState = IDLE_STATE;
  let live: Live | null = null;
  let network: NetworkCapture | null = null;
  let networkMode: NetworkMode | "stopped" = "off";
  const digests = new Set<string>();
  /** Each followed tab's digests of what the person typed into sensitive fields there, latest last (`TYPED_SECRETS` at
   * most): a save whose body held one carries what they entered, though it reads [redacted] (network/index.ts). Kept as
   * `digests` are. */
  const typedSecrets = new Map<number, string[]>();
  /** The person's own Learning space as OpenBot last described it: a recording starts with it, for its popup line. Kept
   * in storage.session too (`learning`), so a service worker that started after the popup asked still has it. */
  let learningSpace: LearningSpaceState | undefined;
  /** The live recording's narration when its launcher passes it in (`external`): the language its phrases are in, and
   * the last phrase as said, so the next one is masked knowing what came before it, as the document's recogniser does. */
  let external: { language: string; before: string } | null = null;
  /** Each followed tab's last recorded top-frame address: the same one again is not recorded twice. */
  const recordedNavigations = new Map<number, string>();
  const forgetAddresses = () => {
    recordedNavigations.clear();
  };
  /** A tab a followed tab opened, until its first page change is recorded: the opener's top page when Chrome said it
   * opened it (webNavigation.onCreatedNavigationTarget), which that page change comes from. */
  const openers = new Map<number, string>();
  /** The sites the person keeps out of every recording (sites.ts): read when this worker starts, and changed only here
   * (`setSiteRecorded`). Nothing in a tab on one is recorded: not its steps, not what they save, not its AG-UI. */
  let excludedSites: ReadonlySet<string> = new Set();
  const excludedUrl = (url: string | undefined | null) =>
    isExcludedSite(url, excludedSites);
  /** Whether a tab the recording follows shows a site the person keeps out. */
  const excludedTab = (tabId: number) => excludedUrl(state.topUrls[tabId]);

  /** The event with the tab's number in the recording, the Recorder's own field `tab`: 1 for the tab the recording
   * started in, then 2, 3 in the order tabs join, so an agent can tell a multi-tab task's tabs apart. Never Chrome's tab
   * id, which changes when the browser starts again. */
  function inTab(tabId: number, event: CapturedEvent): CapturedEvent {
    const index = state.tabIds.indexOf(tabId);
    const value = event.value;
    if (
      index < 0 ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    )
      return event;
    return { ...event, value: { ...value, tab: index + 1 } };
  }
  /** The live recording's steps, held until each one's save (if any) is known (steps.ts). */
  let steps: StepAssembler | null = null;
  /** What a previous service worker held for the recording it left live or stopping, until this one takes it up. */
  let restoredSteps: HeldSteps | null = null;
  /** The live recording's agent side: the AG-UI the network capture observes, as CopilotKit's own events, placed among
   * the steps by time. A fresh one with each set of steps. */
  let agentEvents: AgentEvents | null = null;
  /** The recording a Start over is leaving, while it waits for the document's port: a second Start over is refused. */
  let restartingFrom: Live | null = null;
  /** Set while Start over saves and makes the switch to the new recording: a stop waits for it, so the document and the
   * tabs always hear of the switch before they hear of the stop. */
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
  /** The stop message a Stop waits on the document to answer: a document reopened meanwhile is told it again. */
  let pendingStop: BackgroundToOffscreen | null = null;
  /** The recording whose capture the popup shows and the trajectories it streams to: a status about any other
   * trajectory (a recording Start over replaced, still draining) leaves that capture alone. */
  let shown: { recordingId: string; trajectoryIds: Set<string> } | null = null;

  /** What this browser is recording, told to OpenBot whenever the phase or the recording changes and every 30 s while
   * one runs (activity.ts): with the live recording's connection, else the stored one, whatever made it. A signed-out
   * answer goes the way the connection check's does. */
  const activity = createActivityReport({
    state: () => state,
    target: async () => {
      if (live)
        return {
          openbotUrl: live.openbotUrl,
          token: live.token,
          userId: live.userId,
        };
      const connection = await currentConnection();
      return connection
        ? {
            openbotUrl: connection.openbotUrl,
            token: connection.token,
            userId: connection.user.id,
          }
        : null;
    },
    signedOut: (reason, target) =>
      handleSignedOut(reason, target.token, target.userId, target.openbotUrl),
    timers: deps.timers,
  });

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
    if (before.phase !== state.phase || before.actions !== state.actions)
      void showBadge(state).catch(report("updating the badge"));
    // The recording mark in each followed tab says whether the Recorder hears the person: it changes with the voice.
    if (
      before.phase === "recording" &&
      state.phase === "recording" &&
      narratingIn(before) !== narratingIn(state)
    )
      tellFollowedTabs({ topFrameOnly: true });
    if (
      before.phase !== state.phase ||
      before.recordingId !== state.recordingId
    )
      activity.changed();
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

  // ---- What the person did -------------------------------------------------------------------

  /** One more click, input or page load; at the 50th the notice goes to every followed tab's top frame. */
  function countAction(): void {
    if (!live || state.phase !== "recording") return;
    dispatch({ type: "action" });
    if (state.actions >= RECORDER_ACTION_NOTICE_AT && !state.noticeShown) {
      dispatch({ type: "notice" });
      postToContentPorts(
        state.tabIds,
        { type: "background.notice", show: true, actions: state.actions },
        { topFrameOnly: true },
      );
    }
  }

  /** What a previous service worker left in storage.session: recovery finishes it (recovery.ts). */
  let loadedPhase: RecorderState["phase"] = "idle";
  const ready = (async () => {
    excludedSites = new Set((await readLocal("excludedSites")) ?? []);
    const stored = await readSession("recorder");
    if (stored) state = stored;
    loadedPhase = state.phase;
    for (const digest of (await readSession("digests")) ?? [])
      digests.add(digest);
    for (const [tabId, typed] of (await readSession("typedSecrets")) ?? [])
      typedSecrets.set(tabId, typed);
    // The popup asks when it opens, and Chrome may stop this worker before the person presses Record: the next one takes
    // up what OpenBot said, while the connection that asked is still the one connected.
    const space = await readSession("learning");
    if (
      space &&
      space.connectionId === (await currentConnection())?.connectionId
    )
      learningSpace = space.value;
    if (state.phase === "idle") return;
    const record = await readLocal("activeRecording");
    if (record)
      shown = {
        recordingId: record.recordingId,
        trajectoryIds: new Set(record.trajectoryIds),
      };
    // What the previous service worker held for this recording is taken up as soon as it can be: a step that comes
    // meanwhile takes its place behind them.
    const held = record ? await readLocal("heldSteps") : undefined;
    if (held && held.recordingId === record?.recordingId) restoredSteps = held;
    if (state.phase !== "recording") return;
    const narration = (await readSession("stream"))?.narration;
    if (narration) external = { language: narration.language, before: "" };
    const connection = await currentConnection();
    if (!record || !connection || !ownedBy(record, connection)) return;
    live = liveFrom(record, connection.token);
    openSteps(live.recordingId, takeRestored(live.recordingId));
  })();
  ready.catch(report("loading the recorder state"));
  // A service worker that restarted while a recording runs tells OpenBot again, and goes on every 30 s.
  void ready.then(
    () => {
      if (state.phase !== "idle") activity.changed();
    },
    () => {},
  );

  // ---- The offscreen document ----------------------------------------------------------------

  let offscreen: chrome.runtime.Port | null = null;
  /** The port has spoken (offscreen.ready on load, or any message from a document that reconnected). */
  let documentReady = false;
  let readyWaiters: ((port: chrome.runtime.Port) => void)[] = [];
  /** Waiting for the document's port to connect again (`documentPort`). */
  let connectWaiters: ((port: chrome.runtime.Port) => void)[] = [];
  /** Set while a document is opened for a start or a recovery: events wait until its session message is posted. */
  let holdEvents = false;
  const queued: { event: CapturedEvent; key?: string; bytes: number }[] = [];
  let queuedBytes = 0;
  let droppedEvents = 0;
  const stopWaiters = new Map<string, () => void>();
  /** Offscreen answers that arrived before their recording reached `drains`, applied when it does. */
  const offscreenDone = new Set<string>();
  /** Recordings the document could not send at all, with the sentence that says so. */
  const failedSends = new Map<string, string>();
  const earlyKept = new Map<string, KeptEvents>();

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

  /** `key`: a held step's (steps.ts), which the document stores once. */
  function forwardEvent(event: CapturedEvent, key?: string): void {
    const message: BackgroundToOffscreen =
      key === undefined
        ? { type: "offscreen.event", event }
        : { type: "offscreen.event", event, key };
    if (offscreen && !holdEvents && queued.length === 0 && droppedEvents === 0)
      if (postOffscreen(message)) return;
    const bytes = JSON.stringify(event).length;
    queued.push(key === undefined ? { event, bytes } : { event, key, bytes });
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
        !postOffscreen(
          next.key === undefined
            ? { type: "offscreen.event", event: next.event }
            : { type: "offscreen.event", event: next.event, key: next.key },
        )
      )
        return;
      queued.shift();
      queuedBytes -= next.bytes;
    }
  }

  /** The document is closed once nothing it holds is still sending: every drain is done, parked, or waiting for its
   * person to connect again (a held drain keeps it open for its retries). */
  function maybeCloseDocument(): Promise<void> {
    return documentWork(async () => {
      if (state.phase !== "idle" || holdEvents) return;
      const drains = (await readLocal("drains")) ?? [];
      const busy = drains.some(
        (drain) =>
          !offscreenDone.has(drain.recordingId) &&
          !(
            drain.kept &&
            (drain.kept.parked || drain.kept.waitingForReconnect)
          ),
      );
      if (busy || !(await hasOffscreenDocument())) return;
      if (state.phase !== "idle" || holdEvents) return;
      await closeOffscreenDocument();
    });
  }

  function awaitStopped(
    recordingId: string,
    since: number,
    message: BackgroundToOffscreen,
  ): Promise<void> {
    return new Promise((resolve) => {
      let handle: unknown = null;
      const finish = () => {
        stopWaiters.delete(recordingId);
        if (handle !== null) deps.timers.clear(handle);
        resolve();
      };
      stopWaiters.set(recordingId, finish);
      // The watchdog counts from the persisted start of the stop, so a restarted worker waits no longer in total.
      const remaining = Math.max(0, since + STOP_WATCHDOG_MS - deps.now());
      handle = deps.timers.set(finish, remaining);
      // A document whose port is reconnecting is waited for within the watchdog. With no document there is nothing to
      // tell: what it holds is recovered with the drain. A wait Disconnect released still tells the document to stop.
      void documentPort(remaining).then((port) => {
        const posted = port !== null && postOffscreen(message);
        if (!posted && stopWaiters.get(recordingId) === finish) finish();
      });
    });
  }

  /** Posts a message the document must get, waiting up to the ready timeout for its port while it reconnects. */
  async function sendToDocument(message: BackgroundToOffscreen): Promise<void> {
    if (await documentPort(READY_TIMEOUT_MS)) postOffscreen(message);
  }

  /** How long the document's port may stay down before the document counts as gone: longer than its own reconnect
   * backoff's first tries. */
  const DOCUMENT_GONE_MS = READY_TIMEOUT_MS;

  /** The document's port went down while a recording runs or a Stop waits on it. A document that comes back reconnects
   * its port within the window; one that crashed never does, and nothing else would reopen it while the service worker
   * stays awake (recovery runs only when the service worker starts), so the queue would fill and drop events. */
  function watchForLostDocument(): void {
    if (state.phase !== "recording" && state.phase !== "stopping") return;
    deps.timers.set(() => {
      void reopenLostDocument().catch(report("reopening the document"));
    }, DOCUMENT_GONE_MS);
  }

  /** Reopens a document that is gone on the stored session, the same outbox: a live recording goes on, and a Stop that
   * was waiting tells the new document again. A document that still exists reconnects its port itself. */
  async function reopenLostDocument(): Promise<void> {
    if (offscreen) return;
    const stopping = state.phase === "stopping" ? pendingStop : null;
    if (state.phase !== "recording" && !stopping) return;
    if (await hasOffscreenDocument()) return;
    if (offscreen || !(await resumeDocument())) return;
    if (stopping && pendingStop === stopping) postOffscreen(stopping);
  }

  /** Opens a document that went away with a previous service worker on the stored session: the same outbox. False when
   * no session is stored. */
  async function resumeDocument(): Promise<boolean> {
    const stream = await readSession("stream");
    if (!stream) return false;
    const port = await openDocument();
    try {
      port.postMessage({
        type: "offscreen.resume",
        session: stream,
      } satisfies BackgroundToOffscreen);
    } finally {
      releaseEvents();
    }
    return true;
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
        if (state.phase === "recording" && digests.size > 0)
          postOffscreen({ type: "offscreen.digests", digests: [...digests] });
        return;
      case "offscreen.status":
        if (
          state.phase !== "idle" &&
          shown?.trajectoryIds.has(message.trajectoryId)
        )
          dispatch({ type: "capture", capture: message.capture });
        return;
      case "offscreen.trajectory":
        if (shown?.recordingId === message.recordingId)
          shown.trajectoryIds.add(message.trajectoryId);
        void addTrajectory(message.recordingId, message.trajectoryId).catch(
          report("keeping a trajectory"),
        );
        return;
      case "offscreen.stopped":
        // Before the stop goes on to report the recording: the phrases the document put in the stream itself.
        if (message.phrases)
          dispatch({
            type: "phrases",
            recordingId: message.recordingId,
            count: message.phrases,
          });
        stopWaiters.get(message.recordingId)?.();
        return;
      case "offscreen.done":
        if (message.failed !== undefined)
          sendFailed(message.recordingId, message.failed);
        void documentDone(message.recordingId).catch(
          report("finishing a drain"),
        );
        return;
      case "offscreen.kept":
        void keepEvents(message.recordingId, {
          reason: message.reason,
          parked: message.parked,
          events: message.events,
          at: deps.now(),
        }).catch(report("keeping events"));
        return;
      case "offscreen.transcript":
        placeTranscript(message.event);
        return;
      case "offscreen.speaking":
        holdForSpeech(message.since);
        return;
      case "offscreen.voice.ended":
        voiceEndWaiters.get(message.recordingId)?.();
        return;
      case "offscreen.held":
        void updateDrains((drains) =>
          drains.map((drain) => {
            if (drain.recordingId !== message.recordingId) return drain;
            const { held: _sent, ...rest } = drain;
            return rest;
          }),
        ).catch(report("forgetting a drain's held steps"));
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
    recordingId: string,
    trajectoryId: string,
  ): Promise<void> {
    const append = (record: DrainRecord): DrainRecord =>
      record.trajectoryIds.includes(trajectoryId)
        ? record
        : { ...record, trajectoryIds: [...record.trajectoryIds, trajectoryId] };
    await serially(async () => {
      const record = await readLocal("activeRecording");
      if (record?.recordingId === recordingId) {
        await writeLocal("activeRecording", append(record));
        return;
      }
      const drains = (await readLocal("drains")) ?? [];
      await writeDrains(
        drains.map((drain) =>
          drain.recordingId === recordingId ? append(drain) : drain,
        ),
      );
    });
  }

  /** None of a recording could be sent (its streamer never started): the popup must never say it went to Intelligence.
   * The answer can come before Stop finishes (`endRecording` reads it then) or after. */
  function sendFailed(recordingId: string, sentence: string): void {
    failedSends.set(recordingId, sentence);
    if (state.lastStopped?.recordingId === recordingId)
      dispatch({ type: "send-failed", error: sentence });
  }

  /** Intelligence has every event of a stopped recording: its drain goes. An answer for the recording a stop is still
   * moving into the drains is remembered and applied by that move; the lookup runs in the same storage queue as the
   * move, so the two never cross. */
  async function documentDone(recordingId: string): Promise<void> {
    offscreenDone.add(recordingId);
    const drain = await serially(async () => {
      const found = ((await readLocal("drains")) ?? []).find(
        (entry) => entry.recordingId === recordingId,
      );
      const active =
        (await readLocal("activeRecording"))?.recordingId === recordingId;
      if (!found && !active) offscreenDone.delete(recordingId);
      return found;
    });
    // A discard in progress removes its drain itself, once the document has been told to clear it.
    if (drain && !drain.discarding) {
      await updateDrains((drains) =>
        drains.filter((entry) => entry.recordingId !== recordingId),
      );
      offscreenDone.delete(recordingId);
    }
    await maybeCloseDocument();
  }

  async function keepEvents(
    recordingId: string,
    kept: KeptEvents,
  ): Promise<void> {
    const updated = await serially(async () => {
      const drains = (await readLocal("drains")) ?? [];
      if (drains.some((drain) => drain.recordingId === recordingId)) {
        const next = drains.map((drain) =>
          drain.recordingId === recordingId ? { ...drain, kept } : drain,
        );
        await writeDrains(next);
        return next;
      }
      if ((await readLocal("activeRecording"))?.recordingId === recordingId)
        earlyKept.set(recordingId, kept);
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

  /** A tab's top page as a step carries it: masked as every step is. */
  async function pageOf(
    tabId: number,
  ): Promise<{ url: string; title?: string } | null> {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) return null;
    const options = { digests };
    return {
      url: scrubUrl(tab.url, options),
      ...(tab.title ? { title: scrubText(tab.title, options) } : {}),
    };
  }

  // ---- The held steps, kept in storage ----------------------------------------------------------
  //
  // A service worker's memory goes when Chrome stops it, and with it every step it still held (waiting out its window
  // for the call that saves it). So the live recording's held steps are written to storage.local as they change: a
  // restarted service worker takes them up again, and after a browser quit they go with the recording's drain, as the
  // rest of the recording is kept (storage.session would not outlive the quit). The first change is written at once,
  // later ones at most every HELD_WRITE_MS.
  //
  // The agent events' context (the Threads open in each tab, the runs the page asked for, the Thread linked last) goes
  // in the same write, so a restarted service worker's clicks carry the Thread they would have. A link takes its place
  // in that context only as it goes to the steps, and when the context changed, the write comes before anything leaves:
  // a restarted service worker never makes a link again that left, nor takes up one that went nowhere.

  const stepTimers = deps.stepTimers ?? browserTimers;
  let heldSource: { recordingId: string; assembler: StepAssembler } | null =
    null;
  /** The live recording's agent events, whose context is written with its held steps. */
  let heldAgent: AgentEvents | null = null;
  /** The agent context in storage, as JSON (null: none). */
  let agentWritten: string | null = null;
  let heldTimer: unknown = null;
  let heldWrittenAt = Number.NEGATIVE_INFINITY;
  /** What storage holds, as JSON (null: nothing); undefined until this service worker wrote it. */
  let heldWritten: string | null | undefined;
  let heldWrites: Promise<void> = Promise.resolve();

  function heldChanged(recordingId: string, assembler: StepAssembler): void {
    heldSource = { recordingId, assembler };
    if (heldTimer !== null) return;
    heldTimer = stepTimers.set(
      () => void writeHeld(),
      Math.max(0, heldWrittenAt + HELD_WRITE_MS - deps.now()),
    );
  }

  /** The agent events' context as it is written, or null when it holds nothing a restart needs. */
  function agentContext(): AgentSnapshot | null {
    const agent = heldAgent?.snapshot();
    return agent && (agent.tabs.length > 0 || agent.recordedRuns.length > 0)
      ? agent
      : null;
  }

  /** Writes what the steps hold now and the agent context (or removes them when they hold nothing). The write is issued
   * at once, in order with the ones before it; resolves once it is in storage. */
  function writeHeld(): Promise<void> {
    if (heldTimer !== null) stepTimers.clear(heldTimer);
    heldTimer = null;
    heldWrittenAt = deps.now();
    const source = heldSource;
    const snapshot = source?.assembler.snapshot() ?? null;
    const agent = source ? agentContext() : null;
    const value: HeldSteps | null =
      source && (snapshot || agent)
        ? {
            recordingId: source.recordingId,
            steps: snapshot ?? NOTHING_HELD,
            ...(agent ? { agent } : {}),
          }
        : null;
    const text = value ? JSON.stringify(value) : null;
    if (text === heldWritten) return heldWrites;
    heldWritten = text;
    agentWritten = agent ? JSON.stringify(agent) : null;
    const write = (
      value ? writeLocal("heldSteps", value) : removeLocal("heldSteps")
    ).catch(report("keeping the held steps"));
    heldWrites = Promise.all([heldWrites, write]).then(() => undefined);
    return heldWrites;
  }

  /** Held items are about to leave: when the agent context changed since it was written, it is written first, with
   * the items still in it, so nothing leaves ahead of the context it came from. */
  function beforeLeaving(): void {
    const agent = agentContext();
    if ((agent ? JSON.stringify(agent) : null) !== agentWritten)
      void writeHeld();
  }

  /** A new set of held steps for the live recording, with its own agent events; the previous one's are sent first.
   * `restore` takes up what a previous service worker held for it, and its agent context. */
  function openSteps(recordingId: string, restore?: HeldSteps): StepAssembler {
    steps?.flush();
    steps?.clear();
    agentEvents?.stop();
    let paired: AgentEvents | null = null;
    const assembler = createStepAssembler({
      emit: (event, key) => {
        if (steps === assembler) forwardEvent(event, key);
      },
      // A click takes the Thread of the run it sent, seen while it was held: one with the open-Thread context is held
      // for its run as long as its join is open.
      settle: (tabId, event, joins) =>
        event.name === "click" && paired
          ? paired.settleClick(tabId, event, joins)
          : event,
      awaits: (tabId, event, joins) =>
        event.name === "click" &&
        paired !== null &&
        paired.awaitsRun(tabId, event, joins),
      pageOf,
      onChange: () => heldChanged(recordingId, assembler),
      leaving: () => {
        if (steps === assembler) beforeLeaving();
      },
      now: deps.now,
      timers: stepTimers,
    });
    steps = assembler;
    const events = deps.createAgentEvents({
      emit: (tabId, event) => {
        if (steps === assembler) assembler.place(tabId, event);
      },
      digests: () => digests,
      now: deps.now,
      onChange: () => {
        if (agentEvents === events) heldChanged(recordingId, assembler);
      },
    });
    agentEvents = paired = events;
    heldAgent = events;
    // What the agent events of a previous service worker knew of this recording (the Threads open in each tab, the runs
    // the page asked for, the Thread linked last) is taken up before anything reaches them, and its steps after.
    if (restore?.agent) events.restore(restore.agent);
    if (restore) assembler.restore(restore.steps);
    // A phrase still being spoken holds the new steps too (Start over); a restored one keeps its own hold until the
    // document says again.
    if (speechHold !== null) assembler.hold(speechHold);
    return assembler;
  }

  /** Sends every step held and holds no more (the recording stops). */
  function closeSteps(): void {
    const held = steps;
    if (!held) return;
    held.flush();
    held.clear();
    if (steps === held) steps = null;
    agentEvents?.stop();
    agentEvents = null;
  }

  /** The steps a previous service worker held for this recording, taken up by this one (once). */
  function takeRestored(recordingId: string): HeldSteps | undefined {
    const restored = restoredSteps;
    if (restored?.recordingId !== recordingId) return undefined;
    restoredSteps = null;
    return restored;
  }

  // ---- The narration among the steps --------------------------------------------------------
  //
  // The document transcribes the person's narration. Each phrase's transcript is stamped with its start but exists only
  // once the phrase ends, so the document says when a phrase begins (offscreen.speaking: the steps from then on wait)
  // and sends the transcript here to be placed among the held steps.

  /** When the phrase being spoken began, as the document last said (null: none is). */
  let speechHold: number | null = null;
  const voiceEndWaiters = new Map<string, () => void>();

  function placeTranscript(event: CapturedEvent): void {
    // A phrase that began before Start over is stamped no earlier than the recording it lands in (its own startedAt
    // still says when it began).
    const startedAt = state.startedAt;
    const placed =
      startedAt !== undefined && event.timestamp < startedAt
        ? { ...event, timestamp: startedAt }
        : event;
    // Counted for the recording it lands in, which Stop reports with its actions: a recording of narration alone
    // holds something.
    if (state.recordingId !== undefined)
      dispatch({ type: "phrases", recordingId: state.recordingId, count: 1 });
    if (steps) steps.transcript(state.tabIds[0] ?? -1, placed);
    else forwardEvent(placed);
  }

  /** A phrase the launcher passes in (`external`), as the document's recogniser emits one of its own: one `transcript`
   * event stamped with the phrase's start, masked with every sensitive value of the recording and knowing the phrase
   * before it (a number read out after "my card number is" can come as a phrase of its own), then placed among the held
   * steps. Taken until the steps are sent at Stop, so a phrase the person finished as they pressed Stop is not lost.
   * Its start is never later than now: the clock it was timed on is the person's, and a phrase stamped ahead of what is
   * happening would be placed after steps taken while it was said. Once it is placed, the steps its start held go on,
   * as they do after a final phrase of the document's own (the launcher says again if another phrase is under way). */
  function narrate(phrase: {
    text: string;
    startedAt: number;
    endedAt: number;
  }): PageResponse {
    const said = external;
    if (state.phase !== "recording" && state.phase !== "stopping")
      return { ok: false, error: SENTENCES.notRecording };
    if (!steps) return { ok: false, error: SENTENCES.notRecording };
    if (!said) return { ok: false, error: SENTENCES.ownVoice };
    const text = phrase.text.trim();
    if (!text) return { ok: true };
    const now = deps.now();
    const startedAt = Math.min(phrase.startedAt, now);
    const endedAt = Math.max(startedAt, Math.min(phrase.endedAt, now));
    const masked = scrubTranscript(text, { digests, before: said.before });
    said.before = text;
    placeTranscript({
      type: "CUSTOM",
      name: "transcript",
      timestamp: startedAt,
      value: {
        text: masked,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        language: said.language,
      },
    });
    holdForSpeech(null);
    return { ok: true };
  }

  /** The launcher heard the person begin a phrase (`external`), or stop speaking (null): what the document's
   * `offscreen.speaking` does for a phrase it hears itself. While the phrase is said, the steps taken from its start
   * wait for its transcript (`narrate`), or `speechCapMs` at most, so a phrase the person began before a click goes in
   * ahead of it. Its start is never later than now, as a phrase's is not. Stopping is taken while nothing records too:
   * there is nothing to hold then, and a page that heard the person stop as the recording ended says so after it. */
  function speaking(since: number | null): PageResponse {
    const recording =
      (state.phase === "recording" || state.phase === "stopping") &&
      steps !== null;
    if (since === null && !recording) return { ok: true };
    if (!recording) return { ok: false, error: SENTENCES.notRecording };
    if (!external) return { ok: false, error: SENTENCES.ownVoice };
    holdForSpeech(since === null ? null : Math.min(since, deps.now()));
    return { ok: true };
  }

  function holdForSpeech(since: number | null): void {
    speechHold = since;
    steps?.hold(since);
  }

  /** Before Stop sends the held steps: the document hands over the phrase being spoken, placed among them, and lets go
   * of the microphone. Only while a phrase is being spoken, and never longer than VOICE_END_MS. */
  function endVoiceFirst(recordingId: string): Promise<void> {
    if (speechHold === null || !steps || !offscreen) return Promise.resolve();
    return new Promise((resolve) => {
      let handle: unknown = null;
      const finish = () => {
        if (voiceEndWaiters.get(recordingId) === finish)
          voiceEndWaiters.delete(recordingId);
        if (handle !== null) deps.timers.clear(handle);
        resolve();
      };
      voiceEndWaiters.set(recordingId, finish);
      handle = deps.timers.set(finish, VOICE_END_MS);
      if (!postOffscreen({ type: "offscreen.voice.end", recordingId }))
        finish();
    });
  }

  /** The page a tab is on when a recording starts in it: its first step. */
  function startStep(tabId: number, url: string): void {
    if (!/^https?:/i.test(url) || excludedUrl(url)) return;
    const to = scrubUrl(url, { digests });
    steps?.navigation(
      tabId,
      inTab(tabId, {
        type: "CUSTOM",
        name: "navigation",
        timestamp: deps.now(),
        value: {
          step: "navigate",
          from: "",
          to,
          navigationType: "start",
          frameId: 0,
          parentFrameId: -1,
        },
      }),
    );
  }

  const networkDeps: NetworkCaptureDeps = {
    openbotUrl: () => live?.openbotUrl ?? null,
    // A tab on a site the person keeps out stays unattached until it reaches another site; one already attached when it
    // moved there has every call and AG-UI observation dropped here, as one to the site from another tab is.
    recordable: (url) => isRecordablePage(url) && !excludedUrl(url),
    call: (call) => {
      if (live && !excludedTab(call.tabId) && !excludedUrl(call.url))
        steps?.call(call);
    },
    writeStarted: (id, tabId, startedAt) => {
      if (!excludedTab(tabId)) steps?.writeStarted(id, tabId, startedAt);
    },
    writeEnded: (id) => steps?.writeEnded(id),
    agent: (observation) => {
      if (live && !excludedTab(observation.tabId))
        agentEvents?.observe(observation);
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
    typedSecrets: (tabId) => new Set(typedSecrets.get(tabId)),
  };

  async function record(
    message: Extract<PageToBackground, { type: "page.record" }>,
  ): Promise<PageResponse> {
    if (state.phase !== "idle") return { ok: false, error: SENTENCES.busy };
    dispatch({
      type: "record",
      title: message.title,
      learning: learningSpace,
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

  async function start(
    message: Extract<PageToBackground, { type: "page.record" }>,
    connection: ConnectionRecord,
    attempt: { cancelled: boolean },
  ): Promise<PageResponse> {
    const { title, tabId } = message;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return refuse(SENTENCES.tabClosed);
    }
    // Chrome withholds the URL of a page the Recorder may not read (chrome:// pages included): such a tab starts with
    // the network waiting, and topUrls holds "" until its first top-frame commit.
    const url = tab.url;
    const recordingId = crypto.randomUUID();
    const trajectoryId = crypto.randomUUID();
    const language = narrationLanguage(message.language, navigator.language);
    let saved = false;
    let documentStarted = false;
    let injected = false;
    let capture: NetworkCapture | null = null;
    try {
      const startedAt = deps.now();
      const active: DrainRecord = {
        recordingId,
        title,
        openbotUrl: connection.openbotUrl,
        userId: connection.user.id,
        userName: connection.user.name,
        trajectoryIds: [trajectoryId],
        startedAt,
      };
      await serially(() => writeLocal("activeRecording", active));
      saved = true;
      const policy = await deps.readPolicy();
      if (attempt.cancelled) throw CANCELLED;
      if (!allowsOpenBot(policy, connection.openbotUrl)) throw POLICY_REFUSED;
      // The microphone opens only for a person who chose to narrate: OpenBot says so with the Record it passes on (its
      // own Record form asked them), anything else goes by the choice made in the Recorder, and none yet is no.
      const narrate =
        message.narrate ?? (await readLocal("narration")) === "on";
      const session: StreamSession = {
        recordingId,
        title,
        openbotUrl: connection.openbotUrl,
        token: connection.token,
        trajectoryId,
        startedAt,
        allowedIntelligenceUrls: policy.allowedIntelligenceUrls,
        version: chrome.runtime.getManifest().version,
        // A recording the person does not narrate starts muted: the popup's Voice row turns it on. A browser with no
        // microphone of its own is narrated from outside instead (`external`), and the document listens to nothing.
        ...(connection.narration === "external"
          ? { narration: { language } }
          : { voice: { language, muted: !narrate } }),
      };
      if (import.meta.env.RECORDER_VARIANT === "e2e") {
        const items = await chrome.storage.local.get(
          "RECORDER_E2E_HOLD_RETRY_MS",
        );
        const holdRetryMs: unknown = items.RECORDER_E2E_HOLD_RETRY_MS;
        if (typeof holdRetryMs === "number")
          session.e2eHoldRetryMs = holdRetryMs;
      }
      shown = { recordingId, trajectoryIds: new Set([trajectoryId]) };
      const port = await openDocument();
      port.postMessage({
        type: "offscreen.start",
        session,
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
        recordingId,
        openbotUrl: connection.openbotUrl,
        token: connection.token,
        userId: connection.user.id,
      };
      watchConnection();
      external = session.narration
        ? { language: session.narration.language, before: "" }
        : null;
      // Recording from here on, before the script is injected: a content script that says hello is told to capture.
      recordedNavigations.set(tabId, url ?? "");
      dispatch({
        type: "started",
        recordingId,
        tabId,
        topUrl: url ?? "",
        startedAt,
        capture: {
          intelligence: "connecting",
          network: "off",
          // Narration from outside has no row of the Recorder's own: whoever passes it in shows it.
          ...(session.voice
            ? {
                voice: {
                  state: session.voice.muted
                    ? ("muted" as const)
                    : ("starting" as const),
                },
              }
            : {}),
        },
      });
      injected = true;
      openSteps(recordingId);
      startStep(tabId, url ?? "");
      // A page the Recorder may not read refuses the script; its first commit to a website injects it. On a site the
      // person keeps out, the script only shows the mark saying so.
      await injectRecordingScripts(tabId, recordingId, undefined, {
        active: !excludedUrl(url),
      }).catch(() => undefined);
      // The capture owns the fallback: it alone starts, extends, resumes and stops it.
      capture = deps.createNetworkCapture(networkDeps, {
        fallback: deps.createPageFallback(),
      });
      network = capture;
      networkMode = await capture.start(tabId, url ?? "");
      dispatch({ type: "capture", capture: { network: networkMode } });
      postToContentPorts([tabId], captureFor(tabId));
      return { ok: true };
    } catch (error) {
      // Roll back in reverse.
      live = null;
      external = null;
      unwatchConnection();
      network = null;
      networkMode = "off";
      steps?.clear();
      steps = null;
      agentEvents?.stop();
      agentEvents = null;
      forgetAddresses();
      if (capture)
        await capture.stop().catch(report("stopping network capture"));
      if (injected) await stopRecordingScripts([tabId]);
      releaseEvents();
      await removeSession("stream");
      if (documentStarted) {
        // The document holds the recording's first events: it clears them, and nothing of it is ever sent.
        await moveIntoDrains(recordingId, { discarding: true });
        await finishDiscards().catch(report("discarding a Record"));
      } else if (saved) await serially(() => removeLocal("activeRecording"));
      if (error === CANCELLED) return cancelled();
      if (error === POLICY_REFUSED) return refuse(SENTENCES.policyRefused);
      return refuse(sentenceFor(error, SENTENCES.startFailed));
    }
  }

  // ---- Stop ----------------------------------------------------------------------------------

  async function moveIntoDrains(
    recordingId: string,
    flags: { discarding?: boolean; held?: HeldEvent[] } = {},
  ): Promise<void> {
    const drains = await serially(async () => {
      const record = await readLocal("activeRecording");
      const current = (await readLocal("drains")) ?? [];
      if (record?.recordingId !== recordingId) return current;
      const kept = earlyKept.get(recordingId);
      earlyKept.delete(recordingId);
      const drain: DrainRecord = defined({
        ...record,
        discarding: flags.discarding ? true : undefined,
        kept: flags.discarding ? undefined : kept,
        held: flags.held?.length ? flags.held : undefined,
      });
      const next = [
        ...current.filter((entry) => entry.recordingId !== recordingId),
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
    // that is live.
    if (starting) {
      starting.cancelled = true;
      await starting.done;
    }
    if (switching) await switching;
    if (state.phase !== "recording" || !live) return;
    const current = live;
    live = null;
    unwatchConnection();
    await trackStop(endRecording(current, mode));
  }

  /** Disconnect waits for the stop under way, a resumed one included. */
  async function trackStop(run: Promise<void>): Promise<void> {
    stopInFlight = run;
    try {
      await run;
    } finally {
      if (stopInFlight === run) stopInFlight = null;
    }
  }

  /** The stop of the recording `stopRecording` took from `live`, or, with `resumed`, the rest of a stop a previous service
   * worker persisted before it went away. */
  async function endRecording(
    current: Live,
    mode: StopMode,
    resumed?: NonNullable<RecorderState["stopping"]>,
  ): Promise<void> {
    const since = resumed?.since ?? deps.now();
    const tabIds = state.tabIds;
    const { recordingId } = current;
    if (!resumed) {
      // Persisted before anything else: awaiting does not keep a service worker alive, and a restarted one finishes the stop.
      dispatch({ type: "stop", since });
      await persisted;
    }
    await stopRecordingScripts(tabIds);
    digests.clear();
    typedSecrets.clear();
    forgetAddresses();
    openers.clear();
    await removeSession("digests");
    await removeSession("typedSecrets");
    const capture = network;
    network = null;
    networkMode = "off";
    if (capture) await capture.stop().catch(report("stopping network capture"));
    // A stop this service worker finishes for one before it: what that one held is sent as this one's would be.
    const restored = steps ? undefined : takeRestored(recordingId);
    if (restored) openSteps(recordingId, restored);
    // The phrase being said is placed among the held steps, before they go (not for a Disconnect, which discards it).
    if (mode.kind !== "disconnect") await endVoiceFirst(recordingId);
    // The steps still held go before the outcome, with the saves they have; storage forgets them at once.
    closeSteps();
    // The recording's voice has ended with it: a phrase it was hearing holds nothing of the next recording, and a phrase
    // passed in from now on belongs to none.
    speechHold = null;
    external = null;
    await writeHeld();
    // Only the person's Stop succeeds. A Disconnect or a sign-out ends the recording midway: what it streamed live is in
    // Intelligence already, and its outcome says why it ended.
    const message: BackgroundToOffscreen =
      mode.kind === "person"
        ? { type: "offscreen.stop", outcome: "succeeded" }
        : {
            type: "offscreen.stop",
            outcome: "failed",
            // Only OpenBot signs a connection out; a policy move and a replaced connection disconnect it here.
            reason:
              mode.kind === "disconnect" ||
              mode.reason === "policy" ||
              mode.reason === "replaced"
                ? "disconnected"
                : "signed-out",
          };
    // The document went away (with the service worker, or on its own): the person's Stop reopens it on the stored
    // session, however long ago the stop began, so the outcome is queued and the rest is sent now rather than at the
    // next browser start. A recording kept for its person or discarded needs no document to be told.
    if (
      mode.kind === "person" &&
      disconnecting === 0 &&
      !(await hasOffscreenDocument())
    )
      await resumeDocument().catch(report("reopening the document"));
    if (since + STOP_WATCHDOG_MS <= deps.now()) {
      // The watchdog has run out (it counts from the persisted start): a document is still told, waiting for one that
      // is reconnecting after the restart, but nothing waits for it to answer, and the drain holds whatever it has not
      // sent.
      await sendToDocument(message);
    } else if (mode.kind === "person" && disconnecting === 0) {
      // The outcome is queued after every event before the recording counts as stopped. A document that goes away
      // meanwhile is reopened and told again (`reopenLostDocument`).
      pendingStop = message;
      try {
        await awaitStopped(recordingId, since, message);
      } finally {
        pendingStop = null;
      }
    } else {
      // A recording kept for its person, or discarded (a Disconnect is under way), waits only for a reconnecting
      // document to hear of it.
      await sendToDocument(message);
    }

    let signedOut: LostReason | null = null;
    if (mode.kind === "signed-out") signedOut = mode.reason;
    else if (mode.kind === "person") {
      // Its person's connection went while it stopped: its events are kept for them, never sent under another
      // connection.
      const record = await readLocal("activeRecording");
      const connection = await currentConnection();
      if (record && !(connection && ownedBy(record, connection)))
        signedOut = await signedOutMeanwhile();
    }

    await moveIntoDrains(recordingId);
    await removeSession("stream");
    const failed = failedSends.get(recordingId);
    dispatch({
      type: "finished",
      // A recording a Disconnect stops is discarded right after: what it had not sent yet never goes to Intelligence, so
      // the popup does not say it was sent (what it streamed live is there, ended with a failed outcome).
      lastStopped:
        mode.kind === "disconnect" || failed !== undefined
          ? undefined
          : {
              recordingId,
              ...(state.title !== undefined ? { title: state.title } : {}),
              stoppedAt: deps.now(),
              // What it held, for OpenBot to say: the badge's count and the phrases placed, both final now.
              actions: state.actions,
              phrases: state.phrases ?? 0,
            },
      error: signedOut ? stoppedSentence(signedOut) : failed,
    });
    if (signedOut)
      // A sign-out that forgot nothing (the person connected again) leaves their other drains to the new connection.
      await markWaiting(
        (drain) =>
          drain.userId === current.userId &&
          drain.openbotUrl === current.openbotUrl &&
          (mode.kind !== "signed-out" ||
            mode.forgot ||
            drain.recordingId === recordingId),
        signedOut,
      );
    if (offscreenDone.has(recordingId)) await documentDone(recordingId);
    await maybeCloseDocument();
  }

  /** Why the connection a stop drained under went away: a sign-out or a policy move leaves its notice, the person's own
   * Disconnect leaves none (and is under way while the stop finishes, since Disconnect waits for it). */
  async function signedOutMeanwhile(): Promise<LostReason | null> {
    if (disconnecting > 0) return null;
    const notice = await readLocal("notice");
    if (notice?.kind === "policy-moved") return "policy";
    return notice?.kind === "signed-out" ? (notice.reason ?? "revoked") : null;
  }

  /** Why a recording waits for its person when no answer said so (found after a restart): the notice's reason, else a
   * plain disconnect. */
  async function waitingReason(): Promise<LostReason> {
    const notice = await readLocal("notice");
    if (notice?.kind === "policy-moved") return "policy";
    return notice?.kind === "signed-out"
      ? (notice.reason ?? "revoked")
      : "revoked";
  }

  // ---- The connection check while recording -------------------------------------------------

  /** While a recording runs, OpenBot is asked every 30 s whether the connection it records under still stands: a
   * browser revoked in OpenBot's Settings, or a connection OpenBot signed out, would otherwise go on streaming until the
   * popup or the 12-hour keep-alive asked. A signed-out answer ends the recording through the sign-out path (a failed
   * outcome, reason signed-out, its streams halted, everything kept for its person). OpenBot not answering, or
   * answering anything else, says nothing about the connection: the recording goes on through an outage, and the next
   * check asks again. */
  let connectionCheck: unknown = null;
  function watchConnection(): void {
    unwatchConnection();
    connectionCheck = deps.timers.set(() => {
      connectionCheck = null;
      void ready.then(checkConnection).catch(report("checking the connection"));
    }, CONNECTION_CHECK_MS);
  }

  function unwatchConnection(): void {
    if (connectionCheck !== null) deps.timers.clear(connectionCheck);
    connectionCheck = null;
  }

  async function checkConnection(): Promise<void> {
    const current = live;
    if (!current || state.phase !== "recording") return;
    try {
      await openbotJson<RecorderMe>(
        { openbotUrl: current.openbotUrl, token: current.token },
        recorderPaths.me,
      );
    } catch (error) {
      const reason = signedOutReason(error);
      if (reason)
        await handleSignedOut(
          reason,
          current.token,
          current.userId,
          current.openbotUrl,
        );
    }
    // Still recording (OpenBot answered, could not answer, or the person connected again first): asked again later.
    if (live && state.phase === "recording" && connectionCheck === null)
      watchConnection();
  }

  // ---- Signed out ----------------------------------------------------------------------------

  /** Every drain `belongs` picks waits for its person to connect this browser again; nothing is discarded (Decision 19),
   * until it has waited KEPT_FOR_PERSON_MS (`expireWaiting`). A drain already waiting keeps when it began to. */
  async function markWaiting(
    belongs: (drain: DrainRecord) => boolean,
    reason: LostReason,
  ): Promise<void> {
    await updateDrains((drains) =>
      drains.map((drain) =>
        !belongs(drain) || drain.discarding
          ? drain
          : {
              ...drain,
              kept: {
                reason: keptSentence(reason),
                parked: true,
                events: drain.kept?.events ?? 0,
                at: drain.kept?.waitingForReconnect
                  ? drain.kept.at
                  : deps.now(),
                waitingForReconnect: true,
              },
            },
      ),
    );
  }

  /** A recording waits for its person at most KEPT_FOR_PERSON_MS: one that has waited longer is deleted unsent, its
   * events in the document's outbox with it, as the person's own discard deletes it (marked first, so a restart that
   * interrupts the clearing finishes it). Run at every service-worker start (recovery.ts), which the 12-hour keep-alive
   * alarm alone makes at least twice a day. */
  async function expireWaiting(): Promise<void> {
    const now = deps.now();
    const expired = ((await readLocal("drains")) ?? [])
      .filter(
        (drain) =>
          !drain.discarding &&
          drain.kept?.waitingForReconnect === true &&
          now - drain.kept.at >= KEPT_FOR_PERSON_MS,
      )
      .map((drain) => drain.recordingId);
    await discardDrains(expired);
  }

  /** No stream in the document sends with a lost connection's token any more: a socket still streaming stops now,
   * not at its next pass, and keeps its events for the person. */
  function haltStreams(token: string): void {
    void sendToDocument({ type: "offscreen.halt", token }).catch(
      report("stopping a lost connection's streams"),
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
    haltStreams(token);
    if (live && live.token === token && state.phase === "recording") {
      // Its person connected this browser again (which revoked this token) before the sign-out came back: the
      // recording goes on under the new connection.
      if (!forgot && (await adoptConnection())) return;
      // The live recording used this token, which is dead: it stops (and marks the person's other drains waiting).
      await stopRecording({ kind: "signed-out", reason, forgot });
    } else if (forgot)
      await markWaiting(
        (drain) => drain.userId === userId && drain.openbotUrl === openbotUrl,
        reason,
      );
  }

  /** The live recording's person connected this browser again: connecting revoked the token its passes were asked
   * with, so it takes the new one, as do the stored session (for a reopened document) and the document's stream.
   * Resolves true when it switched; a recording of another person, or on another OpenBot, keeps its own token. */
  async function adoptConnection(): Promise<boolean> {
    const connection = await currentConnection();
    const current = live;
    if (
      !connection ||
      !current ||
      state.phase !== "recording" ||
      current.userId !== connection.user.id ||
      current.openbotUrl !== connection.openbotUrl ||
      current.token === connection.token
    )
      return false;
    current.token = connection.token;
    const stream = await readSession("stream");
    if (stream)
      await writeSession("stream", { ...stream, token: connection.token });
    await sendToDocument({
      type: "offscreen.token",
      recordingId: current.recordingId,
      token: connection.token,
    });
    return true;
  }

  /** The document's pass was answered signed out for `token`. A pass taken with an older token, after the person
   * connected again, changes nothing: the newer connection's recover may still be sending. A reconnect can land between
   * the read here and the forget, so drains wait only when the forget really happened. */
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
    haltStreams(token);
    await markWaiting((drain) => ownedBy(drain, connection), reason);
  }

  /** The organization's policy moved the Recorder away from this connection's OpenBot (connection.ts forgot it), or a
   * connection to another OpenBot, or for another person, replaced it (connection.ts `endReplaced`, which revokes its
   * token next): the live recording that used it stops, the document stops sending with its token, and everything is
   * kept for its person on that OpenBot, as a sign-out keeps it. */
  async function connectionEnded(
    connection: ConnectionRecord,
    reason: "policy" | "replaced",
  ): Promise<void> {
    haltStreams(connection.token);
    if (live && live.token === connection.token && state.phase === "recording")
      await stopRecording({ kind: "signed-out", reason, forgot: true });
    else await markWaiting((drain) => ownedBy(drain, connection), reason);
  }

  /** A new policy goes to the document at once, and into the stored session a reopened document starts from. */
  async function pushPolicy(policy: RecorderPolicy): Promise<void> {
    const allowedIntelligenceUrls = policy.allowedIntelligenceUrls;
    const stream = await readSession("stream");
    if (stream)
      await writeSession("stream", { ...stream, allowedIntelligenceUrls });
    if (offscreen)
      postOffscreen({ type: "offscreen.policy", allowedIntelligenceUrls });
    else if (await hasOffscreenDocument())
      await sendToDocument({
        type: "offscreen.policy",
        allowedIntelligenceUrls,
      });
  }

  // ---- Start over ----------------------------------------------------------------------------

  async function restart(): Promise<PageResponse> {
    // Start over while Record finishes (its script injection, its network capture) waits for Record: the recording it
    // leaves is then the one Record started, with its tabs told, before the switch.
    if (starting) await starting.done;
    if (state.phase !== "recording" || !live || live === restartingFrom)
      return { ok: false, error: SENTENCES.notRecording };
    const current = live;
    restartingFrom = current;
    try {
      // The document must hear of the switch: while its port reconnects, the wait happens here, before the switch
      // begins, so nothing in the switch waits. Stop, a sign-out or Disconnect can end the recording meanwhile. A
      // document that cannot be reached would never hear of it, so Start over is refused (the recording goes on, and
      // a lost document is reopened).
      const port = await documentPort(READY_TIMEOUT_MS);
      if (state.phase !== "recording" || live !== current)
        return { ok: false, error: SENTENCES.notRecording };
      if (!port) return { ok: false, error: SENTENCES.restartUnreachable };
      let switched = () => {};
      switching = new Promise<void>((resolve) => {
        switched = resolve;
      });
      try {
        await switchTo(current);
      } finally {
        switching = null;
        switched();
      }
      return { ok: true };
    } finally {
      if (restartingFrom === current) restartingFrom = null;
    }
  }

  /** Saves the new recording as the active one and the one it leaves as a drain (the document sends it to Intelligence
   * with a failed outcome), then makes the switch in memory and tells the document and the tabs in one turn, with nothing
   * awaited in between. */
  async function switchTo(current: Live): Promise<void> {
    const recordingId = crypto.randomUUID();
    const trajectoryId = crypto.randomUUID();
    const startedAt = deps.now();
    const drains = await serially(async () => {
      const previous = await readLocal("activeRecording");
      const existing = (await readLocal("drains")) ?? [];
      if (!previous) return existing;
      const kept = earlyKept.get(previous.recordingId);
      earlyKept.delete(previous.recordingId);
      const changed = [
        ...existing.filter(
          (drain) => drain.recordingId !== previous.recordingId,
        ),
        defined({ ...previous, kept }),
      ];
      await writeLocal("activeRecording", {
        ...previous,
        recordingId,
        trajectoryIds: [trajectoryId],
        startedAt,
      });
      await writeDrains(changed);
      return changed;
    });
    const stream = await readSession("stream");
    if (stream)
      await writeSession("stream", {
        ...stream,
        recordingId,
        trajectoryId,
        startedAt,
      });
    // The recording it leaves gets its held steps first; the new one starts on the pages the tabs are on.
    steps?.flush();
    live = { ...current, recordingId };
    shown = { recordingId, trajectoryIds: new Set([trajectoryId]) };
    forgetAddresses();
    postOffscreen({
      type: "offscreen.rotate",
      recordingId,
      trajectoryId,
      startedAt,
    });
    openSteps(recordingId);
    for (const tabId of state.tabIds) {
      const top = state.topUrls[tabId] ?? "";
      recordedNavigations.set(tabId, top);
      startStep(tabId, top);
    }
    dispatch({ type: "restart", recordingId, startedAt });
    publishDrains(drains);
    postToContentPorts(
      state.tabIds,
      { type: "background.notice", show: false, actions: 0 },
      { topFrameOnly: true },
    );
    tellFollowedTabs();
  }

  // ---- Voice ---------------------------------------------------------------------------------

  /** The person mutes or unmutes the live recording's narration: the document stops or starts listening, and the stored
   * session says so, so a document reopened on it starts the same way. */
  async function setVoice(muted: boolean): Promise<PageResponse> {
    if (state.phase !== "recording" || !live)
      return { ok: false, error: SENTENCES.notRecording };
    const stream = await readSession("stream");
    if (!stream?.voice) return { ok: false, error: SENTENCES.noVoice };
    await writeSession("stream", {
      ...stream,
      voice: { ...stream.voice, muted },
    });
    dispatch({
      type: "capture",
      capture: { voice: { state: muted ? "muted" : "starting" } },
    });
    await sendToDocument({ type: "offscreen.voice", muted });
    return { ok: true };
  }

  // ---- The 50-action notice ------------------------------------------------------------------

  async function noticeChoice(
    choice: "stop" | "restart" | "continue",
  ): Promise<PageResponse> {
    // Answered, in a tab or in the popup: it is down everywhere.
    dispatch({ type: "notice-answered" });
    postToContentPorts(
      state.tabIds,
      { type: "background.notice", show: false, actions: state.actions },
      { topFrameOnly: true },
    );
    if (choice === "stop") {
      await stopRecording({ kind: "person" });
      return { ok: true };
    }
    if (choice === "restart") return restart();
    return { ok: true };
  }

  // ---- Kept events, Disconnect and reconnecting ----------------------------------------------

  /** The person's own discard: the drains are marked first (so a restart that interrupts the clearing finishes it and
   * never sends them), then the document clears their outbox. */
  async function discardDrains(recordingIds: string[]): Promise<void> {
    if (recordingIds.length === 0) return;
    await updateDrains((drains) =>
      drains.map((drain) =>
        recordingIds.includes(drain.recordingId)
          ? { ...drain, discarding: true }
          : drain,
      ),
    );
    await finishDiscards();
  }

  /** Clears every drain marked for discarding, whoever is connected: nothing of it is sent. */
  async function finishDiscards(): Promise<void> {
    const marked = ((await readLocal("drains")) ?? [])
      .filter((drain) => drain.discarding)
      .map((drain) => drain.recordingId);
    if (marked.length === 0) return;
    const port = await openDocument();
    try {
      port.postMessage({
        type: "offscreen.discard",
        recordingIds: marked,
      } satisfies BackgroundToOffscreen);
    } finally {
      releaseEvents();
    }
    await updateDrains((drains) =>
      drains.filter((drain) => !marked.includes(drain.recordingId)),
    );
  }

  async function discardKept(): Promise<PageResponse> {
    const drains = (await readLocal("drains")) ?? [];
    await discardDrains(
      drains.filter((drain) => drain.kept).map((drain) => drain.recordingId),
    );
    return { ok: true };
  }

  /** The person who recorded kept drains is connected again (or, `recovering`, the browser started): the document
   * sends everything their drains still hold. Drains of another person, or of another OpenBot, keep waiting: they are
   * never sent under someone else's connection, and recovery marks them waiting for their person. */
  async function sendDrains(options: { recovering: boolean }): Promise<void> {
    await finishDiscards();
    const connection = await currentConnection();
    if (options.recovering)
      await markWaiting(
        (drain) =>
          !(connection && ownedBy(drain, connection)) &&
          !drain.kept?.waitingForReconnect,
        await waitingReason(),
      );
    if (!connection) return;
    const drains = await updateDrains((all) =>
      all.map((drain) => {
        if (!ownedBy(drain, connection) || !drain.kept?.waitingForReconnect)
          return drain;
        const { kept: _waiting, ...rest } = drain;
        return rest;
      }),
    );
    const own = drains.filter(
      (drain) => ownedBy(drain, connection) && !drain.discarding,
    );
    if (own.length === 0) return;
    const port = await openDocument();
    try {
      const policy = await deps.readPolicy();
      port.postMessage({
        type: "offscreen.recover",
        openbotUrl: connection.openbotUrl,
        token: connection.token,
        allowedIntelligenceUrls: policy.allowedIntelligenceUrls,
        version: chrome.runtime.getManifest().version,
        drains: own,
      } satisfies BackgroundToOffscreen);
    } finally {
      releaseEvents();
    }
  }

  // ---- After a restart (recovery.ts) ---------------------------------------------------------

  async function interrupt(): Promise<void> {
    // Only what the browser restart left: a Record this service worker started since is not touched.
    if (loadedPhase !== "idle" || state.phase !== "idle" || starting) return;
    const record = await readLocal("activeRecording");
    const held = await readLocal("heldSteps");
    if (!record) {
      // Steps of a recording already moved into the drains were sent with it.
      if (held) await removeLocal("heldSteps");
      return;
    }
    // The steps its service worker still held when the browser quit go with it, sent as they would have been at Stop,
    // ahead of its interrupted outcome.
    await moveIntoDrains(record.recordingId, {
      held:
        held?.recordingId === record.recordingId
          ? heldEvents(held.steps, deps.now)
          : undefined,
    });
    if (held) await removeLocal("heldSteps");
    await writeLocal("notice", { kind: "interrupted", at: deps.now() });
  }

  async function abandonStart(): Promise<void> {
    if (loadedPhase !== "starting" || state.phase !== "starting" || starting)
      return;
    const record = await readLocal("activeRecording");
    await removeSession("stream");
    if (record) {
      // The document may have been told to start it: it clears what it holds, as Record's rollback has it.
      await moveIntoDrains(record.recordingId, { discarding: true });
      await finishDiscards().catch(report("discarding a Record"));
    }
    dispatch({ type: "error", error: SENTENCES.startFailed });
    await maybeCloseDocument();
  }

  async function resumeStop(): Promise<string | null> {
    const stopping = state.stopping;
    if (
      loadedPhase !== "stopping" ||
      state.phase !== "stopping" ||
      !stopping ||
      stopInFlight
    )
      return null;
    // The stop may have moved the recording into the drains just before the service worker went away.
    const record =
      (await readLocal("activeRecording")) ??
      ((await readLocal("drains")) ?? []).find(
        (drain) => drain.recordingId === state.recordingId,
      );
    if (!record) {
      dispatch({ type: "cancelled" });
      return null;
    }
    const connection = await currentConnection();
    const token =
      connection && ownedBy(record, connection) ? connection.token : "";
    await trackStop(
      endRecording(liveFrom(record, token), { kind: "person" }, stopping),
    );
    return record.recordingId;
  }

  async function resumeRecording(): Promise<void> {
    if (
      loadedPhase !== "recording" ||
      state.phase !== "recording" ||
      network ||
      stopInFlight
    )
      return;
    if (!live) {
      await stopWithoutConnection();
      return;
    }
    // The checks the previous service worker ran went with it.
    watchConnection();
    const capture = deps.createNetworkCapture(networkDeps, {
      fallback: deps.createPageFallback(),
    });
    network = capture;
    // Taken up when this service worker loaded, unless that could not happen then.
    if (!steps) openSteps(live.recordingId, takeRestored(live.recordingId));
    const mode = await capture.resume(
      state.tabIds.map((tabId) => ({
        tabId,
        url: state.topUrls[tabId] ?? "",
      })),
      state.capture.network,
    );
    // A stop that came meanwhile has stopped this capture already.
    if (network !== capture) return;
    networkMode = mode;
    dispatch({ type: "capture", capture: { network: mode } });
    // A live document reconnects its port and re-sends its status itself.
    if ((await hasOffscreenDocument()) || state.phase !== "recording") return;
    await resumeDocument();
  }

  /** A live recording whose connection went while the service worker was away (a sign-out the popup or the keep-alive
   * noticed): it stops here and is kept for its person, as a signed-out stop is. */
  async function stopWithoutConnection(): Promise<void> {
    const record = await readLocal("activeRecording");
    if (!record) {
      dispatch({ type: "cancelled" });
      return;
    }
    await trackStop(
      endRecording(liveFrom(record, ""), {
        kind: "signed-out",
        reason: await waitingReason(),
        forgot: true,
      }),
    );
  }

  async function recoverDrain(recordingId: string): Promise<void> {
    const connection = await currentConnection();
    const drain = ((await readLocal("drains")) ?? []).find(
      (entry) => entry.recordingId === recordingId,
    );
    if (
      !connection ||
      !drain ||
      !ownedBy(drain, connection) ||
      drain.discarding ||
      drain.kept?.waitingForReconnect
    )
      return;
    const policy = await deps.readPolicy();
    await sendToDocument({
      type: "offscreen.recover",
      openbotUrl: connection.openbotUrl,
      token: connection.token,
      allowedIntelligenceUrls: policy.allowedIntelligenceUrls,
      version: chrome.runtime.getManifest().version,
      drains: [drain],
    });
  }

  const afterReady =
    <A extends unknown[], R>(work: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await ready;
      return work(...args);
    };
  installedRecovery = {
    loadedPhase: afterReady(async () => loadedPhase),
    interrupt: afterReady(interrupt),
    abandonStart: afterReady(abandonStart),
    resumeStop: afterReady(resumeStop),
    resumeRecording: afterReady(resumeRecording),
    finishDiscards: afterReady(finishDiscards),
    sendDrains: afterReady(() => sendDrains({ recovering: true })),
    expireWaiting: afterReady(expireWaiting),
    recoverDrain: afterReady(recoverDrain),
  };

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
        await removeSession("me");
        // A recording that used this connection stops, and everything is kept for its person.
        await handleSignedOut(
          reason,
          connection.token,
          connection.user.id,
          connection.openbotUrl,
        );
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
      narration: (await readLocal("narration")) ?? null,
      excludedSites: [...excludedSites].sort(),
    };
  }

  /** The person's own Learning space, which every recording they make joins: whether Learning will see it. */
  async function readLearningSpace(): Promise<PageResponse> {
    const connection = await currentConnection();
    if (!connection) return { ok: false, error: SENTENCES.noConnection };
    try {
      const answer = await openbotJson<RecorderLearningResponse>(
        connection,
        recorderPaths.learning,
      );
      learningSpace = answer.learning;
      await writeSession("learning", {
        value: answer.learning,
        connectionId: connection.connectionId,
      }).catch(report("keeping the Learning space"));
      return { ok: true, learning: answer.learning };
    } catch (error) {
      const reason = signedOutReason(error);
      if (reason)
        await handleSignedOut(
          reason,
          connection.token,
          connection.user.id,
          connection.openbotUrl,
        );
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

  /** Whether the Recorder hears the person in this state, for the recording marks: null where it does not hear them
   * itself (narration passed in from outside, or none). */
  function narratingIn(at: RecorderState): boolean | null {
    const voice = at.capture.voice?.state;
    if (voice === undefined) return null;
    return voice === "starting" || voice === "listening";
  }

  /** What a frame of the tab is told: whether it captures, and, for a followed tab, what its recording mark says. A frame
   * on a site the person keeps out (`frameUrl`), or in a tab that shows one, captures nothing. */
  function captureFor(tabId: number, frameUrl?: string): BackgroundToContent {
    const followed =
      state.phase === "recording" &&
      live !== null &&
      state.tabIds.includes(tabId);
    if (!followed) return { type: "background.capture", active: false };
    const site = siteOf(state.topUrls[tabId]);
    const narrating = narratingIn(state);
    const mark = {
      ...(site !== null ? { site } : {}),
      ...(narrating !== null ? { narrating } : {}),
    };
    if (excludedTab(tabId) || excludedUrl(frameUrl))
      return {
        type: "background.capture",
        active: false,
        ...mark,
        ...(excludedTab(tabId) ? { excluded: true } : {}),
      };
    return {
      type: "background.capture",
      active: true,
      recordingId: state.recordingId,
      ...mark,
    };
  }

  function tellPort(port: chrome.runtime.Port, frameUrl?: string): void {
    const tabId = port.sender?.tab?.id;
    try {
      port.postMessage(
        tabId === undefined
          ? { type: "background.capture", active: false }
          : captureFor(tabId, frameUrl),
      );
    } catch {
      // The frame went away.
    }
  }

  /** Tells every followed tab again what it captures and what its mark says (an exclusion, Start over, the voice). */
  function tellFollowedTabs(options: { topFrameOnly?: boolean } = {}): void {
    for (const tabId of state.tabIds)
      postToContentPorts([tabId], captureFor(tabId), options);
  }

  /**
   * The person's click on a tab's recording mark (`content.site`) or the options page (`page.site`): the site is left out
   * of every recording from now on, or recorded again. Leaving it out drops what the steps still hold from each tab on
   * it, the whole visit the person has not acted on yet included (steps.ts), so nothing of it that has not left yet ever
   * does, and tells those tabs to stop capturing; recording it again tells them to capture, and lets a tab that never
   * attached its network capture there attach it now.
   */
  async function setSiteRecorded(
    site: string,
    recorded: boolean,
  ): Promise<PageResponse> {
    if (siteOf(`https://${site}/`) !== site)
      return { ok: false, error: SENTENCES.badSite };
    const next = new Set(excludedSites);
    if (recorded) next.delete(site);
    else next.add(site);
    excludedSites = next;
    await serially(() =>
      next.size > 0
        ? writeLocal("excludedSites", [...next].sort())
        : removeLocal("excludedSites"),
    );
    if (state.phase !== "recording" || !live) return { ok: true };
    for (const tabId of state.tabIds) {
      const top = state.topUrls[tabId];
      if (siteOf(top) !== site) continue;
      if (!recorded) {
        steps?.dropTab(tabId);
        agentEvents?.tabNavigated(tabId);
      } else if (top)
        void network
          ?.onCommitted(tabId, 0, top)
          .catch(report("following a site recorded again"));
      postToContentPorts([tabId], captureFor(tabId));
    }
    return { ok: true };
  }

  /** A sensitive value's digest, from a content script or from the masking here: every later step, save, agent event and
   * narration of the recording is masked with it. It is also what the person typed into a sensitive field in the tab, so
   * a save from that tab whose body held it carries their values. */
  function keepDigest(digest: string, tabId: number): void {
    // Memory only: it survives a service-worker restart, vanishes with the browser, and goes at Stop.
    digests.add(digest);
    void writeSession("digests", [...digests]).catch(
      report("keeping a sensitive-value digest"),
    );
    // The document masks the person's narration with them too; a document whose port is down gets them on ready.
    postOffscreen({ type: "offscreen.digests", digests: [...digests] });
    const typed = (typedSecrets.get(tabId) ?? []).filter(
      (known) => known !== digest,
    );
    typedSecrets.set(tabId, [...typed, digest].slice(-TYPED_SECRETS));
    void writeSession("typedSecrets", [...typedSecrets]).catch(
      report("keeping what was typed into a sensitive field"),
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
      tellPort(port, message.url);
      // The 50-action notice is still open: a page the tab moved to shows it again, as the one it left did.
      if (followed && message.top && state.noticeOpen)
        try {
          port.postMessage({
            type: "background.notice",
            show: true,
            actions: state.noticeAt ?? state.actions,
          } satisfies BackgroundToContent);
        } catch {
          // The frame went away.
        }
      return;
    }
    if (state.phase !== "recording" || tabId === undefined) return;
    if (!followed) {
      // Only a tab that navigated away from a recording and back can still hold a running script.
      tellPort(port);
      return;
    }
    switch (message.type) {
      case "content.site": {
        // The site the tab shows, as the service worker knows it: a page never names the site it leaves out.
        const site = siteOf(state.topUrls[tabId]);
        if (site !== null && port.sender?.frameId === 0)
          void setSiteRecorded(site, message.recorded).catch(
            report("leaving a site out of the recording"),
          );
        return;
      }
      case "content.event": {
        // Nothing from a site the person keeps out: the frame is told again to stop capturing.
        if (excludedTab(tabId) || excludedUrl(port.sender?.url)) {
          tellPort(port, port.sender?.url);
          return;
        }
        // A page load is recorded as the tab's page change, from the service worker.
        if ((message.event as CapturedEvent)?.name === "page") return;
        // Masked again with every digest of the recording: what was typed into a sensitive field on another page, in
        // another tab or frame, goes here too (content-masking.ts).
        const event = maskContentEvent(
          message.event as CapturedEvent,
          digests,
          (digest) => keepDigest(digest, tabId),
        );
        if (!event) return;
        if (!STEP_EVENTS.has(event.name)) {
          forwardEvent(event);
          return;
        }
        // A click takes the agent context CopilotKit adds to one before the steps hold it.
        const step =
          event.name === "click" && agentEvents
            ? agentEvents.enrichClick(tabId, event)
            : event;
        steps?.step(tabId, inTab(tabId, step), port.sender?.frameId !== 0);
        if (ACTION_EVENTS.has(event.name)) countAction();
        return;
      }
      case "content.sensitive":
        keepDigest(message.digest, tabId);
        return;
      case "content.notice":
        void noticeChoice(message.choice).catch(report("the notice choice"));
        return;
    }
  }

  /** A followed tab's top frame reached a page: recorded once per address (a reload again), never an iframe's. */
  function recordTopNavigation(
    details: NavigationDetails,
    kind: "commit" | "history",
  ): void {
    const { tabId, url } = details;
    // A tab's first page change after a followed tab opened it comes from the opener's page, never from its own address.
    const before = openers.get(tabId) ?? (state.topUrls[tabId] || undefined);
    // Nothing of a site the person keeps out, not even as where a page change came from: a page change from one, or a
    // tab one opened, is recorded as one from nowhere.
    const from =
      before !== undefined && !excludedUrl(before) ? before : undefined;
    const event = navigationEvent(details, kind, from, { digests });
    dispatch({ type: "page", tabId, url });
    if (!/^https?:/i.test(url)) return;
    openers.delete(tabId);
    // A site the person keeps out: no step. The next page change from here is recorded as one from nowhere.
    if (excludedUrl(url)) {
      recordedNavigations.delete(tabId);
      return;
    }
    const reload =
      (event.value as { navigationType?: string }).navigationType === "reload";
    if (!reload && recordedNavigations.get(tabId) === url) return;
    recordedNavigations.set(tabId, url);
    steps?.navigation(
      tabId,
      inTab(tabId, {
        ...event,
        value: {
          ...(event.value as Record<string, unknown>),
          step: "navigate",
        } as CapturedEvent["value"],
      }),
    );
    countAction();
  }

  function onNavigation(
    details: NavigationDetails,
    kind: "commit" | "history",
  ): void {
    if (state.phase !== "recording" || !live) return;
    const { tabId, frameId, url } = details;
    if (!state.tabIds.includes(tabId)) {
      // A tab the person used while it showed no website joins at its first one: that page change is its first step,
      // and the commit below gives it the content script and its network capture, as it gives any followed tab's.
      if (
        kind !== "commit" ||
        frameId !== 0 ||
        !state.usedTabIds?.includes(tabId) ||
        !isRecordablePage(url)
      )
        return;
      joinTab(tabId, null);
    }
    if (frameId === 0) recordTopNavigation(details, kind);
    if (kind !== "commit") return;
    // A new document in the top frame: the page's Threads went with the old one.
    if (frameId === 0) agentEvents?.tabNavigated(tabId);
    // The script's own guard makes a repeat harmless; a frame Chrome refuses (an opaque sandboxed one) is skipped. On a
    // site the person keeps out it captures nothing, and in the top frame shows the mark saying so.
    void injectRecordingScripts(tabId, live.recordingId, [frameId], {
      active: !excludedTab(tabId) && !excludedUrl(url),
    }).catch(() => undefined);
    void network
      ?.onCommitted(tabId, frameId, url)
      .catch(report("following a navigation"));
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
    openers.set(details.tabId, state.topUrls[details.sourceTabId] ?? "");
    dispatch({ type: "follow", tabId: details.tabId, url: details.url });
    void network
      ?.addTab(details.tabId, details.url)
      .catch(report("following a new tab"));
  }

  // ---- The tabs the person uses -------------------------------------------------------------
  //
  // A recording follows every tab the person uses while it runs (David, 2026-10-22), in any window: the tab Record
  // started in, a tab a followed tab opened (onCreatedTarget above), any tab they switch to and any tab they open. A tab
  // is used when it becomes the active tab of its window (tabs.onActivated: a click on it, a keyboard switch, OpenBot's
  // own tab strip), when its window comes to the front (windows.onFocusChanged: the active tab of the window the person
  // moved to is the one they now use), and when it is opened (tabs.onCreated: the new-tab button, a bookmark opened in
  // the background). A tab that was open before Record and that the person never goes to is never followed.
  //
  // It joins only on a website. A tab on a page no extension may reach (the new tab page, the browser's settings), on
  // the Recorder's own pages or on the Web Store records nothing there, so it waits in `usedTabIds` and joins at its
  // first website, whose page change is its first step: a tab that never reaches one never takes a number. A tab on a
  // website joins at once, with the page it shows as its first step, and from there it is captured as the Record tab
  // is: the content script in every frame, its network and AG-UI capture, the 50-action notice, the masking.

  /** The person used a tab: it joins now if it shows a website, else it waits for its first one. */
  function usedTab(tabId: number): void {
    if (state.phase !== "recording" || !live || tabId < 0) return;
    if (state.tabIds.includes(tabId)) return;
    if (!state.usedTabIds?.includes(tabId)) dispatch({ type: "use", tabId });
    // The tab's address, which webNavigation does not say for a page already loaded. A commit that comes first joins
    // the tab itself; this then finds it followed.
    void chrome.tabs
      .get(tabId)
      .catch(() => null)
      .then((tab) => {
        if (
          state.phase !== "recording" ||
          !live ||
          !state.usedTabIds?.includes(tabId) ||
          !isRecordablePage(tab?.url)
        )
          return;
        joinTab(tabId, tab?.url ?? "");
      })
      .catch(report("following a tab the person used"));
  }

  /** A used tab joins the recording: with `url`, the website it shows, which is its first step; with null, at a page
   * change the commit records. */
  function joinTab(tabId: number, url: string | null): void {
    if (!live) return;
    const { recordingId } = live;
    dispatch({ type: "follow", tabId, url: url ?? "" });
    if (url !== null) {
      recordedNavigations.set(tabId, url);
      startStep(tabId, url);
      void injectRecordingScripts(tabId, recordingId, undefined, {
        active: !excludedUrl(url),
      }).catch(() => undefined);
    }
    void network
      ?.addTab(tabId, url ?? "")
      .catch(report("following a tab the person used"));
    // A script still in the tab from an earlier recording is not injected again: it is told to capture, and shown the
    // 50-action notice if it is open, as a new script is when it says hello.
    postToContentPorts([tabId], captureFor(tabId));
    if (state.noticeOpen)
      postToContentPorts(
        [tabId],
        {
          type: "background.notice",
          show: true,
          actions: state.noticeAt ?? state.actions,
        },
        { topFrameOnly: true },
      );
  }

  /** The person is now on this tab: the page they were visiting in another tab is one they left (steps.ts). */
  function movedTo(tabId: number): void {
    if (state.phase !== "recording" || !live) return;
    steps?.entered(tabId);
    usedTab(tabId);
  }

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void ready
      .then(() => movedTo(tabId))
      .catch(report("following a tab the person used"));
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void ready
      .then(() => {
        if (state.phase === "recording" && live) steps?.left(tabId);
      })
      .catch(report("ending the visit of a tab that closed"));
  });
  chrome.tabs.onCreated.addListener((tab) => {
    const { id } = tab;
    if (id === undefined) return;
    void ready
      .then(() => usedTab(id))
      .catch(report("following a tab the person opened"));
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    // Focus left the browser: no tab is used by that.
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    void ready
      .then(async () => {
        if (state.phase !== "recording") return;
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        if (tab?.id !== undefined) movedTo(tab.id);
      })
      .catch(report("following the window the person moved to"));
  });
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
  onPolicyChanged((policy) => {
    void ready
      .then(() => pushPolicy(policy))
      .catch(report("passing on a new policy"));
  }, deps.readPolicy);

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
        case "page.learning":
          return readLearningSpace();
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
        case "page.kept.discard":
          return discardKept();
        case "page.voice":
          return setVoice(message.muted);
        case "page.narration":
          if (typeof message.on !== "boolean")
            return { ok: false, error: "Unknown request." };
          await serially(() =>
            writeLocal("narration", message.on ? "on" : "off"),
          );
          return { ok: true };
        case "page.site":
          if (
            typeof message.site !== "string" ||
            typeof message.recorded !== "boolean"
          )
            return { ok: false, error: SENTENCES.badSite };
          return setSiteRecorded(message.site, message.recorded);
        default:
          return { ok: false, error: "Unknown request." };
      }
    },

    async external(
      message: ExternalToBackground,
      sender: chrome.runtime.MessageSender,
    ): Promise<ExternalResponse> {
      await ready;
      if (
        message.type !== "recorder.page-network" &&
        message.type !== "recorder.page-agent"
      )
        return { ok: false, error: "invalid" };
      const tabId = sender.tab?.id;
      if (
        state.phase !== "recording" ||
        !live ||
        !network ||
        tabId === undefined ||
        !state.tabIds.includes(tabId) ||
        networkMode !== "page" ||
        // Nothing from a site the person keeps out, in its own tab or framed in another.
        excludedTab(tabId) ||
        excludedUrl(sender.url)
      )
        return { ok: false, error: "not-recording" };
      if (message.type === "recorder.page-agent") {
        // Stream ids are the page's own: the tab and frame keep two documents' apart.
        const observation = (
          message.observation.kind === "runtime"
            ? { ...message.observation, tabId }
            : {
                ...message.observation,
                tabId,
                streamId: `${tabId}/page/${sender.frameId ?? 0}/${message.observation.streamId}`,
              }
        ) as CaptureObservation;
        network.recordPageAgent(tabId, observation);
        return { ok: true };
      }
      const event = deps.acceptPageNetworkEvent(
        message.event as CapturedEvent,
        digests,
      );
      if (!event) return { ok: false, error: "invalid" };
      await network.recordPageEvent(tabId, event);
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
        watchForLostDocument();
      });
      // The events that waited go first, then whatever waited for the port.
      flushEvents();
      const waiters = connectWaiters;
      connectWaiters = [];
      for (const waiter of waiters) waiter(port);
    },

    async narrate(phrase) {
      await ready;
      return narrate(phrase);
    },

    async speaking(since) {
      await ready;
      return speaking(since);
    },

    async current() {
      await ready;
      return state;
    },

    async connected() {
      await ready;
      await adoptConnection();
      // Connected again: the sentence that said the stopped recording waits for a connection no longer holds. The kept
      // row says what still waits, and for whom.
      if (state.error !== undefined && KEPT_SENTENCES.includes(state.error))
        dispatch({ type: "clear-error" });
      // The connect page waits on this answer: the sending runs on its own.
      void sendDrains({ recovering: false }).catch(
        report("sending kept recordings"),
      );
    },

    async connectionLost(loss) {
      await ready;
      const { connection } = loss;
      if (loss.kind === "policy" || loss.kind === "replaced")
        await connectionEnded(connection, loss.kind);
      else
        await handleSignedOut(
          loss.reason,
          connection.token,
          connection.user.id,
          connection.openbotUrl,
        );
    },

    async disconnected() {
      disconnecting += 1;
      try {
        await ready;
        // Everything is discarded: a Stop waiting for the document to stop waits no more (the document is still told).
        for (const finish of [...stopWaiters.values()]) finish();
        // Ends a Record still starting, and a recording in progress.
        await stopRecording({ kind: "disconnect" });
        // A stop still under way finishes first, so the recording it moves into the drains is discarded with the rest.
        if (stopInFlight) await stopInFlight;
        const drains = (await readLocal("drains")) ?? [];
        await discardDrains(drains.map((drain) => drain.recordingId));
        if (state.error !== undefined && KEPT_SENTENCES.includes(state.error))
          dispatch({ type: "clear-error" });
      } finally {
        disconnecting -= 1;
      }
    },
  };
}
