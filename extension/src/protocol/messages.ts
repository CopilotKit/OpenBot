import type {
  LearningSpaceState,
  RecorderConnectVia,
  RecorderMe,
} from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { MAX_TIMESTAMP_MS } from "@openbot/shared/recorder-masking";
import {
  RECORDER_CONNECT_STATUS,
  type RecorderConnectWait,
  type RecorderPageResult,
  type RecorderPageState,
  recorderPageMessageSchema,
} from "@openbot/shared/recorder-page";
import { z } from "zod";
import { normaliseOpenBotOrigin } from "../shared/origin";
import type { DrainRecord, RecorderNotice } from "../shared/storage";

export const PORT_CONTENT = "recorder:content";
export const PORT_OFFSCREEN = "recorder:offscreen";

export type CaptureStatus = {
  intelligence:
    | "off"
    | "connecting"
    | "streaming"
    | "retrying"
    | "held"
    | "parked"; // held / parked: stopped with every event kept (Task 11's table)
  intelligenceReason?: string;
  events?: { sent: number; pending: number; rejected: number; dropped: number };
  network: "off" | "waiting" | "debugger" | "page" | "stopped";
  networkReason?: string;
  /** The person's narration, transcribed in this browser; absent when the recording has no voice. Replaced whole on
   * every update, so a reason or the words heard never outlive the state they belong to. */
  voice?: VoiceCapture;
};
/** What the Voice row shows. `heard` is the last words recognised (interim words too), masked as the transcript events
 * are; it lives in the popup's state only. `problem` says what went wrong when `state` is failed, so the row can offer
 * the fix (the setup page for `microphone`). `reason` is the sentence the row shows: why voice stopped when failed,
 * or, while listening, that the browser hears speech but hands back no words for it. */
export type VoiceCapture = {
  state: "starting" | "listening" | "muted" | "failed";
  reason?: string;
  heard?: string;
  problem?: VoiceProblem;
  /** For `speech-pack`: the language the browser has to download, which the popup's Download asks for. */
  language?: string;
};
/** `on-device`: this browser cannot recognise speech on the person's computer at all. `speech-pack`: it can, once the
 * narration's language is downloaded, which takes the person's click. `language`: it cannot recognise this language on
 * the computer. Recognition never leaves the computer (offscreen/voice.ts), so each of these turns voice off. */
export type VoiceProblem =
  | "microphone"
  | "no-microphone"
  | "no-recognition"
  | "on-device"
  | "speech-pack"
  | "service"
  | "network"
  | "language";
export type RecorderState = {
  phase: "idle" | "starting" | "recording" | "stopping";
  recordingId?: string;
  title?: string;
  tabIds: number[];
  startedAt?: number;
  /** What the person did so far: clicks, inputs and page loads in a followed tab's top frame. The 50-action notice and
   * the badge count these. */
  actions: number;
  noticeShown: boolean;
  /** How many actions there were when the 50-action notice showed: the popup and the page both say that number "or
   * more", while the count goes on. */
  noticeAt?: number;
  /** The 50-action notice is on screen: from when it shows until any choice (in a tab or the popup), Stop, Start over
   * or the end of the recording. The popup shows its card from this. */
  noticeOpen: boolean;
  capture: CaptureStatus;
  /** Narrated phrases this recording has kept so far: each final phrase placed among its steps, heard by the
   * Recorder itself or passed in by its launcher. Absent while there are none. */
  phrases?: number;
  /** The recording Stop ended last: the popup says it went to Intelligence, and the launcher tells OpenBot its name,
   * when it stopped and what it held (the person's actions as the badge counted them, and its narrated phrases), so
   * OpenBot can confirm it too and say when it held nothing. */
  lastStopped?: {
    recordingId: string;
    title?: string;
    stoppedAt?: number;
    actions?: number;
    phrases?: number;
  };
  draining: number; // stopped recordings still sending
  learning?: LearningSpaceState; // the person's own Learning space at Record (Decision 10)
  topUrls: Record<string, string>; // followed tab id -> its top frame's current URL
  /** Tabs the person used during the recording (switched to or opened) while they showed no website: a new tab page,
   * one of the browser's own pages or the Recorder's. Each joins `tabIds` at its first website (recording.ts). */
  usedTabIds?: number[];
  /** While phase is "stopping": persisted so a restarted service worker finishes the stop (Task 9). */
  stopping?: { since: number };
  /** Stopped recordings whose events are kept (summed over drains with `kept`), for the popup's Discard offer;
   * `waitingFor` names the person whose recordings wait for them to connect this browser again (Decision 19). */
  kept?: {
    recordings: number;
    events: number;
    reason: string;
    parked: boolean;
    waitingFor?: { name: string; recordings: number };
  };
  error?: string;
};
export const IDLE_STATE: RecorderState = {
  phase: "idle",
  tabIds: [],
  actions: 0,
  noticeShown: false,
  noticeOpen: false,
  draining: 0,
  topUrls: {},
  capture: { intelligence: "off", network: "off" },
};

const event = z
  .object({
    type: z.literal("CUSTOM"),
    name: z.string().min(1).max(200),
    timestamp: z.number().positive().max(MAX_TIMESTAMP_MS),
    value: z.unknown(),
  })
  .strict();
const contentToBackgroundSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("content.hello"),
      top: z.boolean(),
      url: z.string().max(4096),
    })
    .strict(),
  z.object({ type: z.literal("content.event"), event }).strict(),
  z
    .object({
      type: z.literal("content.sensitive"),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("content.notice"),
      choice: z.enum(["stop", "restart", "continue"]),
    })
    .strict(),
  // The person's click on the recording mark in a tab: leave the site the tab shows out of every recording, or record it
  // again. The service worker takes the site from the tab, never from the page.
  z.object({ type: z.literal("content.site"), recorded: z.boolean() }).strict(),
]);
export type ContentToBackground = z.infer<typeof contentToBackgroundSchema>;
/**
 * `background.capture` says whether a frame captures, and, for a tab the recording follows, what its recording mark
 * shows (content/indicator.ts): `site` is the site the tab shows, `excluded` that the person keeps it out of their
 * recordings (nothing there is captured), and `narrating` whether the Recorder hears them now (absent where it does not
 * hear them itself). Without `site`, no mark: nothing is being recorded in the tab.
 */
export type BackgroundToContent =
  | {
      type: "background.capture";
      active: boolean;
      recordingId?: string;
      site?: string;
      excluded?: boolean;
      narrating?: boolean;
    }
  | { type: "background.notice"; show: boolean; actions: number };

export type StreamSession = {
  recordingId: string;
  title: string;
  openbotUrl: string;
  token: string;
  trajectoryId: string;
  startedAt: number;
  allowedIntelligenceUrls: string[] | null;
  version: string;
  /** The narration's language (BCP 47) and whether the person muted it. Absent: this recording has no voice. */
  voice?: { language: string; muted: boolean };
  /** Narration the Recorder's launcher passes in (`external`, launcher.ts): no voice here, and each phrase it is handed
   * is placed as the document's own recogniser's are, in this language. The document never reads it. */
  narration?: { language: string };
  /** e2e variant only: the service worker copies storage.local.RECORDER_E2E_HOLD_RETRY_MS here (an offscreen document can use
   * no extension API but runtime, so it cannot read storage itself); the offscreen document reads it only inside its e2e branch. */
  e2eHoldRetryMs?: number;
};
/** Why a recording ended without the person's Stop, sent to Intelligence with its failed outcome: `disconnected` for a
 * Disconnect (the person's own, or the organization's policy moving the Recorder), `signed-out` for a connection OpenBot
 * signed out. Events streamed live before it ended are already in Intelligence. */
export type StopFailure = "disconnected" | "signed-out";
export type BackgroundToOffscreen =
  | { type: "offscreen.start"; session: StreamSession }
  | { type: "offscreen.resume"; session: StreamSession } // the service worker restarted and found no document: same outbox
  | { type: "offscreen.event"; event: CapturedEvent; key?: string } // `key`: a held step's (steps.ts), stored once
  | {
      type: "offscreen.rotate";
      recordingId: string;
      trajectoryId: string;
      /** When Start over began: the new trajectory's recording.started is stamped then, before its first step. */
      startedAt?: number;
    } // "Start over"
  | { type: "offscreen.voice.end"; recordingId: string } // Stop: the phrase in progress goes to the service worker, placed among the steps it still holds, before they are sent; answered with offscreen.voice.ended
  | { type: "offscreen.stop"; outcome: "succeeded" } // the person's Stop; idempotent per recording (Task 11)
  | { type: "offscreen.stop"; outcome: "failed"; reason: StopFailure } // the browser was disconnected or signed out mid-recording
  | {
      type: "offscreen.recover";
      openbotUrl: string;
      token: string;
      /** The managed policy's pinned Intelligence addresses when it was sent (null: none pinned); the recovered
       * streamers are held to it, since a document opened after a browser start was never told a policy. */
      allowedIntelligenceUrls: string[] | null;
      /** The extension's version for the recovered trajectories' metadata: an offscreen document has no
       * chrome.runtime.getManifest (Chrome gives it only runtime messaging, getURL and id), so the service worker names it. */
      version: string;
      drains: DrainRecord[];
    } // after a browser restart, and when the person who recorded kept drains connects again
  | { type: "offscreen.discard"; recordingIds: string[] } // the person's own "Discard kept events" or Disconnect, or a Record that never went live: clear their outbox
  | { type: "offscreen.token"; recordingId: string; token: string } // the live recording's person connected this browser again: its passes use the new token
  | { type: "offscreen.halt"; token: string } // that connection is gone (signed out, or moved away by policy): every stream sending with its token stops at once, its events kept
  | { type: "offscreen.policy"; allowedIntelligenceUrls: string[] | null } // the managed policy changed: streams to a gateway it no longer allows are parked
  | { type: "offscreen.voice"; muted: boolean } // the person muted or unmuted the live recording's voice
  | { type: "offscreen.digests"; digests: string[] }; // every sensitive-value digest of the live recording, so a spoken secret is masked too
/** The one offscreen message the service worker parses: it signs a connection out, so it names the bearer the failing
 * pass used, and only that connection is signed out (a pass taken with an older token after the person connected again
 * signs out nothing). */
const offscreenSignedOutSchema = z
  .object({
    type: z.literal("offscreen.signed-out"),
    reason: z.enum(["revoked", "removed", "organization"]),
    token: z.string(),
  })
  .strict();
export type OffscreenSignedOut = z.infer<typeof offscreenSignedOutSchema>;
export type OffscreenToBackground =
  | { type: "offscreen.ready" }
  | {
      type: "offscreen.status";
      capture: Partial<CaptureStatus>;
      trajectoryId: string;
    }
  | {
      type: "offscreen.trajectory";
      recordingId: string;
      trajectoryId: string;
    } // a long recording rolled over to another trajectory
  | {
      type: "offscreen.stopped";
      recordingId: string;
      trajectoryIds: string[];
      /** Final phrases this document put straight into the stream after Stop reached it (the service worker had sent
       * its held steps by then), which the service worker did not place and so has not counted. */
      phrases?: number;
    } // final outcome queued
  | { type: "offscreen.done"; recordingId: string; failed?: string } // every event sent, every trajectory finished; `failed`: none of it could be sent, and why
  | {
      type: "offscreen.kept";
      recordingId: string;
      reason: string;
      parked: boolean;
      events: number;
    } // a stopped recording's events are kept (Decision 19)
  | { type: "offscreen.transcript"; recordingId: string; event: CapturedEvent } // a final phrase, stamped with its start: the service worker places it among the steps it holds
  | { type: "offscreen.speaking"; recordingId: string; since: number | null } // when the phrase being spoken began (null: none is): steps from then on wait for its transcript
  | { type: "offscreen.voice.ended"; recordingId: string } // the answer to offscreen.voice.end: every phrase was sent before it
  | { type: "offscreen.held"; recordingId: string } // the steps a recovered drain carried (`held`) are in the outbox, before its outcome
  | OffscreenSignedOut; // a pass came back RECORDER_SIGNED_OUT, with the guard's reason; its events stay kept (Decision 19)

/** The connect page's Connect or Cancel. `origin` is the one the page showed (its page.connect.pending answer), in the
 * form a pending connect stores (normaliseOpenBotOrigin's): the service worker refuses a decide whose origin is not the
 * pending connect's, so a connect tab only ever confirms the site it shows. */
const pageConnectDecideSchema = z
  .object({
    type: z.literal("page.connect.decide"),
    approve: z.boolean(),
    label: z.string(),
    origin: z.string().refine((value) => {
      const checked = normaliseOpenBotOrigin(value);
      return checked.ok && checked.origin === value;
    }),
  })
  .strict();
type PageConnectDecide = z.infer<typeof pageConnectDecideSchema>;

export type PageToBackground =
  | { type: "page.state" }
  | { type: "page.learning" }
  | {
      type: "page.record";
      title: string;
      tabId: number;
      /** The narration's language: the page's own, else the browser's (the service worker's browser language when
       * absent or unusable). */
      language?: string;
      /** Whether the person narrates this recording, when whoever started it asked them (OpenBot's own Record form, by
       * the launcher). Absent: the choice they made in the Recorder, and no microphone until they made one. */
      narrate?: boolean;
    }
  | { type: "page.stop" }
  | { type: "page.voice"; muted: boolean }
  /** The person's choice to narrate their recordings, or not: kept for every later recording. */
  | { type: "page.narration"; on: boolean }
  /** A site left out of every recording, or recorded again (the options page). */
  | { type: "page.site"; site: string; recorded: boolean }
  | { type: "page.restart" }
  | { type: "page.notice"; choice: "stop" | "restart" | "continue" }
  | { type: "page.notice.dismiss" }
  | { type: "page.connect.pending" }
  | PageConnectDecide
  | { type: "page.disconnect" }
  | { type: "page.desktop.available" }
  | { type: "page.connect.desktop" }
  | { type: "page.kept.discard" } // the person discards every stopped recording's kept events
  | { type: "RECORDER_E2E_FLOOD"; count: number }; // e2e variant only: the router ignores it in a release build (Task 9), and a type emits no code
export type PageStateResponse = {
  ok: true;
  state: RecorderState;
  connection: {
    openbotUrl: string;
    user: { name: string; email: string };
    via: RecorderConnectVia;
  } | null;
  me: RecorderMe | null;
  policy: { openbotUrl: string | null; invalid: boolean };
  notice: RecorderNotice | null;
  /** Whether the person narrates their recordings; null until they chose. */
  narration: "on" | "off" | null;
  /** The sites the person keeps out of every recording, sorted. */
  excludedSites: string[];
};
export type PageResponse =
  | PageStateResponse
  | {
      ok: true;
      pending: { origin: string; via: "web" | "desktop" } | null;
      /** The connection approving it replaces, when this browser is connected: its OpenBot and the person it is for. */
      replaces?: { origin: string; email: string };
    }
  | { ok: true; learning: LearningSpaceState }
  | { ok: true; available: boolean }
  | { ok: true; connected: true } // OpenBot Desktop connected this browser, with no Connect page
  | { ok: true; connected: false; reason: string } // why OpenBot Desktop did not connect this browser, as a code (DesktopConnect)
  | { ok: true }
  | { ok: false; error: string };

/** An AG-UI observation from the MAIN-world hook (shared/agui.ts PageObservation): raw, as the debugger's are; the
 * service worker adds the tab and prefixes a stream id with it. `runtime` says the page's CopilotKit runtime answered its
 * `info` call. */
const streamId = z.string().min(1).max(512);
const at = z.number().positive().max(MAX_TIMESTAMP_MS);
const pageAgentObservation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("request"),
      streamId,
      at,
      url: z.string().max(8192),
      agentId: z.string().max(512).nullable(),
      method: z.enum(["agent/run", "agent/connect"]),
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("event"),
      streamId,
      at,
      agentId: z.string().max(512).nullable(),
      threadId: z.string().max(512).nullable(),
      event: z.looseObject({ type: z.string().min(1).max(100) }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("end"),
      streamId,
      at,
      outcome: z.enum(["complete", "failed"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("runtime"),
      at,
      url: z.string().max(8192),
    })
    .strict(),
]);

const externalToBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("openbot.ping") }).strict(),
  z
    .object({
      type: z.literal("openbot.connect"),
      code: z.string().startsWith("obc_").max(80),
    })
    .strict(),
  // Where the asking origin's own connect has got to (shared/recorder-page.ts).
  z.object({ type: z.literal(RECORDER_CONNECT_STATUS) }).strict(),
  // From the MAIN-world fallback (Task 18), masked and trimmed to fit one event in the page; accepted only from a
  // recorded tab.
  z.object({ type: z.literal("recorder.page-network"), event }).strict(),
  // From the same hook: what it saw of AG-UI, raw (the agent events mask it); accepted only from a recorded tab.
  z
    .object({
      type: z.literal("recorder.page-agent"),
      observation: pageAgentObservation,
    })
    .strict(),
  // What OpenBot's own page asks the Recorder in the same browser (shared/recorder-page.ts): openbot.state,
  // openbot.record and openbot.stop, answered only for the OpenBot this copy is connected to (openbot-page.ts).
  ...recorderPageMessageSchema.options,
]);
export type ExternalToBackground = z.infer<typeof externalToBackgroundSchema>;
export type ExternalResponse =
  | { ok: true } // a ping from any origin this copy is not connected to (Decision 22)
  // A connect waiting for the person's click on the Connect page. Nothing about this copy goes with it: any site can
  // ask to connect, and it learns this copy's version and its install id for it only once the person approves.
  | { ok: true; awaitingConfirmation: true }
  // Where the asking origin's own connect has got to: nothing about this copy goes with it either.
  | { ok: true; connect: RecorderConnectWait }
  | {
      ok: true;
      version: string;
      installId: string;
      /** A trusted OpenBot's connect (connection.ts `trustedConnectRule`): connected now, with no Connect page. */
      connected?: true;
    } // the connected origin's ping, and a trusted OpenBot's connect; installId = installIdFor(sender.origin)
  | {
      ok: false;
      error:
        | "not-https"
        | "pinned-elsewhere"
        | "policy-invalid"
        | "busy"
        | "invalid"
        | "not-recording"
        // A trusted OpenBot's code that OpenBot refused, or an OpenBot that did not answer its exchange.
        | "exchange-refused"
        | "openbot-unreachable";
    }
  | { ok: false; error: "throttled"; retryAfterMs: number }; // too many connects from this origin lately, and how long until it may ask again
/** Every answer onMessageExternal gives: openbot.state's is a RecorderPageState, openbot.record's and openbot.stop's a
 * RecorderPageResult. */
export type ExternalAnswer =
  | ExternalResponse
  | RecorderPageState
  | RecorderPageResult;

const MAX_MESSAGE_BYTES = 64 * 1024;
/** An AG-UI observation is not cut in the page: a run's input carries its whole Thread, a snapshot the agent's state. */
const MAX_AGENT_MESSAGE_BYTES = 8 * 1024 * 1024;

function jsonBytes(raw: unknown): number | null {
  try {
    const text = JSON.stringify(raw);
    return text === undefined ? null : new TextEncoder().encode(text).length;
  } catch {
    return null;
  }
}

/** safeParse + 64 KiB JSON size cap. */
export function parseContentMessage(raw: unknown): ContentToBackground | null {
  const bytes = jsonBytes(raw);
  if (bytes === null || bytes > MAX_MESSAGE_BYTES) return null;
  const parsed = contentToBackgroundSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
/** safeParse + 64 KiB JSON size cap: a recorder.page-network event arrives already trimmed to fit one Intelligence
 * event (16 KiB), so nothing larger is ever a real one. A recorder.page-agent observation is raw, up to 8 MiB. */
export function parseExternalMessage(
  raw: unknown,
): ExternalToBackground | null {
  const bytes = jsonBytes(raw);
  const agent =
    typeof raw === "object" &&
    raw !== null &&
    (raw as { type?: unknown }).type === "recorder.page-agent";
  if (
    bytes === null ||
    bytes > (agent ? MAX_AGENT_MESSAGE_BYTES : MAX_MESSAGE_BYTES)
  )
    return null;
  const parsed = externalToBackgroundSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
/** The one page message the router parses, as it carries the origin the decide handler checks. */
export function parsePageConnectDecide(raw: unknown): PageConnectDecide | null {
  const parsed = pageConnectDecideSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
/** A sign-out without the token it is about is refused: forgetting without one would forget whichever connection is
 * stored. */
export function parseOffscreenSignedOut(
  raw: unknown,
): OffscreenSignedOut | null {
  const parsed = offscreenSignedOutSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
