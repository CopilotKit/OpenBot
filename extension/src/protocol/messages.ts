import type {
  LearningSpaceState,
  RecorderBot,
  RecorderMe,
} from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { MAX_TIMESTAMP_MS } from "@openbot/shared/recorder-masking";
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
};
export type RecorderState = {
  phase: "idle" | "starting" | "recording" | "stopping";
  recordingId?: string;
  botId?: string;
  title?: string;
  tabIds: number[];
  startedAt?: number;
  /** What the person did so far: clicks, inputs and page loads in a followed tab's top frame. The 50-action notice and
   * the badge count these. */
  actions: number;
  noticeShown: boolean;
  /** The 50-action notice is on screen: from when it shows until any choice (in a tab or the popup), Stop, Start over
   * or the end of the recording. The popup shows its card from this. */
  noticeOpen: boolean;
  capture: CaptureStatus;
  /** The recording Stop ended last, and the Bot it was for: the popup says it went to Intelligence. */
  lastStopped?: { recordingId: string; botId: string };
  draining: number; // stopped recordings still sending
  learning?: LearningSpaceState; // the picked Bot's Learning space at Record (Decision 10)
  topUrls: Record<string, string>; // followed tab id -> its top frame's current URL
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
]);
export type ContentToBackground = z.infer<typeof contentToBackgroundSchema>;
export type BackgroundToContent =
  | { type: "background.capture"; active: boolean; recordingId?: string }
  | { type: "background.notice"; show: boolean; actions: number };

export type StreamSession = {
  recordingId: string;
  title: string;
  botId: string;
  openbotUrl: string;
  token: string;
  trajectoryId: string;
  startedAt: number;
  allowedIntelligenceUrls: string[] | null;
  version: string;
  /** e2e variant only: the service worker copies storage.local.RECORDER_E2E_HOLD_RETRY_MS here (an offscreen document can use
   * no extension API but runtime, so it cannot read storage itself); the offscreen document reads it only inside its e2e branch. */
  e2eHoldRetryMs?: number;
};
export type BackgroundToOffscreen =
  | { type: "offscreen.start"; session: StreamSession }
  | { type: "offscreen.resume"; session: StreamSession } // the service worker restarted and found no document: same outbox
  | { type: "offscreen.event"; event: CapturedEvent }
  | { type: "offscreen.rotate"; recordingId: string; trajectoryId: string } // "Start over"
  | { type: "offscreen.stop"; outcome: "succeeded" | "failed" } // idempotent per recording (Task 11)
  | {
      type: "offscreen.recover";
      openbotUrl: string;
      token: string;
      /** The managed policy's pinned Intelligence addresses when it was sent (null: none pinned); the recovered
       * streamers are held to it, since a document opened after a browser start was never told a policy. */
      allowedIntelligenceUrls: string[] | null;
      drains: DrainRecord[];
    } // after a browser restart, and when the person who recorded kept drains connects again
  | { type: "offscreen.discard"; recordingIds: string[] }; // the person's own "Discard kept events" or Disconnect, or a Record that never went live: clear their outbox
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
    } // final outcome queued
  | { type: "offscreen.done"; recordingId: string } // every event sent, every trajectory finished
  | {
      type: "offscreen.kept";
      recordingId: string;
      reason: string;
      parked: boolean;
      events: number;
    } // a stopped recording's events are kept (Decision 19)
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
  | { type: "page.bots" }
  | {
      type: "page.record";
      botId: string;
      title: string;
      tabId: number;
    }
  | { type: "page.stop" }
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
    via: "web" | "desktop";
  } | null;
  me: RecorderMe | null;
  policy: { openbotUrl: string | null; invalid: boolean };
  notice: RecorderNotice | null;
};
export type PageResponse =
  | PageStateResponse
  | { ok: true; pending: { origin: string; via: "web" | "desktop" } | null }
  | { ok: true; bots: RecorderBot[] }
  | { ok: true; available: boolean }
  | { ok: true; offered: boolean }
  | { ok: true }
  | { ok: false; error: string };

const externalToBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("openbot.ping") }).strict(),
  z
    .object({
      type: z.literal("openbot.connect"),
      code: z.string().startsWith("obc_").max(80),
    })
    .strict(),
  // From the MAIN-world fallback (Task 18), masked and trimmed to fit one event in the page; accepted only from a
  // recorded tab.
  z.object({ type: z.literal("recorder.page-network"), event }).strict(),
]);
export type ExternalToBackground = z.infer<typeof externalToBackgroundSchema>;
export type ExternalResponse =
  | { ok: true } // a ping from any origin this copy is not connected to (Decision 22)
  | {
      ok: true;
      version: string;
      installId: string;
      awaitingConfirmation?: boolean;
    } // the connected origin's ping, a pending connect's origin, and the connect answer; installId = installIdFor(sender.origin)
  | {
      ok: false;
      error:
        | "not-https"
        | "pinned-elsewhere"
        | "policy-invalid"
        | "busy"
        | "invalid"
        | "not-recording";
    };

const MAX_MESSAGE_BYTES = 64 * 1024;

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
 * event (16 KiB), so nothing larger is ever a real one. */
export function parseExternalMessage(
  raw: unknown,
): ExternalToBackground | null {
  const bytes = jsonBytes(raw);
  if (bytes === null || bytes > MAX_MESSAGE_BYTES) return null;
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
