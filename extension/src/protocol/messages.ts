import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import { demonstrationActionSchema } from "@openbot/shared/demonstration-schema";
import type {
  LearningSpaceState,
  RecorderBot,
  RecorderMe,
} from "@openbot/shared/recorder-api";
import { RECORDER_PAGE_NETWORK_MESSAGE_BYTES } from "@openbot/shared/recorder-api";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { MAX_TIMESTAMP_MS } from "@openbot/shared/recorder-masking";
import { z } from "zod";
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
  screen: "off" | "recording" | "failed";
  screenReason?: string;
  voice: "off" | "recording" | "unavailable" | "failed";
  voiceReason?: string;
};
export type RecorderState = {
  phase: "idle" | "starting" | "recording" | "stopping";
  demonstrationId?: string;
  botId?: string;
  title?: string;
  tabIds: number[];
  startedAt?: number;
  steps: number;
  noticeShown: boolean;
  capture: CaptureStatus;
  lastStopped?: { demonstrationId: string; botId: string; openbotUrl: string };
  draining: number; // stopped recordings still sending
  openRecording?: { demonstrationId: string }; // Record was refused: this person has one open for the Bot
  learning?: LearningSpaceState; // the picked Bot's Learning space at Record, then what the passes found (Decision 10)
  topUrls: Record<string, string>; // followed tab id -> its top frame's current URL, for sub-frame steps (Decision 17)
  /** While phase is "stopping": persisted so a restarted service worker finishes the stop (Task 9). */
  stopping?: {
    since: number;
    stage: "draining" | "telling-openbot";
    stoppedFrom?: "openbot";
  };
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
  steps: 0,
  noticeShown: false,
  draining: 0,
  topUrls: {},
  capture: { intelligence: "off", network: "off", screen: "off", voice: "off" },
};

const event = z
  .object({
    type: z.literal("CUSTOM"),
    name: z.string().min(1).max(200),
    timestamp: z.number().positive().max(MAX_TIMESTAMP_MS),
    value: z.unknown(),
  })
  .strict();
export const contentToBackgroundSchema = z.discriminatedUnion("type", [
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
      type: z.literal("content.step"),
      action: demonstrationActionSchema,
    })
    .strict(),
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
  | { type: "background.capture"; active: boolean; demonstrationId?: string }
  | { type: "background.notice"; show: boolean; steps: number };

export type StreamSession = {
  demonstrationId: string;
  title: string;
  botId: string;
  openbotUrl: string;
  token: string;
  trajectoryId: string;
  startedAt: number;
  allowedIntelligenceUrls: string[] | null;
  version: string;
  media: { tabStreamId: string | null; microphone: boolean };
  /** e2e variant only: the service worker copies storage.local.RECORDER_E2E_HOLD_RETRY_MS here (an offscreen document can use
   * no extension API but runtime, so it cannot read storage itself); the offscreen document reads it only inside its e2e branch. */
  e2eHoldRetryMs?: number;
};
export type BackgroundToOffscreen =
  | { type: "offscreen.start"; session: StreamSession } // media first (consumes tabStreamId), then the streamer
  | { type: "offscreen.resume"; session: StreamSession } // the service worker restarted and found no document: same outbox, no tab stream
  | { type: "offscreen.screen"; tabStreamId: string } // screen capture starting late (first real site, or the popup's Record screen)
  | { type: "offscreen.event"; event: CapturedEvent }
  | { type: "offscreen.rotate"; demonstrationId: string; trajectoryId: string } // "Start over"
  | {
      type: "offscreen.stop";
      outcome: "succeeded" | "failed";
      stoppedFrom?: "openbot";
    } // idempotent per demonstration (Task 11)
  | {
      type: "offscreen.recover";
      openbotUrl: string;
      token: string;
      drains: DrainRecord[];
    } // after a browser restart, and when the person who recorded kept drains connects again
  | { type: "offscreen.discard"; demonstrationIds: string[] }; // only on the person's own "Discard kept events" or Disconnect: clear their IndexedDB data
export type OffscreenToBackground =
  | { type: "offscreen.ready" }
  | {
      type: "offscreen.status";
      capture: Partial<CaptureStatus>;
      trajectoryId: string;
    }
  | {
      type: "offscreen.trajectory";
      demonstrationId: string;
      trajectoryId: string;
    } // rollover registered another trajectory
  | {
      type: "offscreen.stopped";
      demonstrationId: string;
      trajectoryIds: string[];
    } // final outcome queued, after the last transcript
  | { type: "offscreen.rotated"; previousDemonstrationId: string } // the discarded recording's events are drained and its trajectory closed
  | { type: "offscreen.done"; demonstrationId: string } // every event sent, every trajectory closed, every upload complete
  | {
      type: "offscreen.kept";
      demonstrationId: string;
      reason: string;
      parked: boolean;
      events: number;
    } // a stopped recording's events are kept (Decision 19)
  | { type: "offscreen.heartbeat" } // every 30 s while a live session exists (Task 9 polls OpenBot on it)
  | {
      type: "offscreen.signed-out";
      reason: "revoked" | "removed" | "organization";
    }; // a pass came back RECORDER_SIGNED_OUT, with the guard's reason; its events stay kept (Decision 19)

export type PageToBackground =
  | { type: "page.state" }
  | { type: "page.bots" }
  | {
      type: "page.record";
      botId: string;
      title: string;
      tabId: number;
      microphone: boolean;
      replaceOpen?: boolean;
    }
  | { type: "page.stop" }
  | { type: "page.restart" }
  | { type: "page.notice"; choice: "stop" | "restart" | "continue" }
  | { type: "page.notice.dismiss" }
  | { type: "page.screen" }
  | { type: "page.connect.pending" }
  | { type: "page.connect.decide"; approve: boolean; label: string }
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

export const externalToBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("openbot.ping") }).strict(),
  z
    .object({
      type: z.literal("openbot.connect"),
      code: z.string().startsWith("obc_").max(80),
    })
    .strict(),
  // From the MAIN-world fallback (Task 18), already masked in the page; accepted only from a recorded tab.
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
/** safeParse with a size cap per type: 64 KiB for openbot.*, RECORDER_PAGE_NETWORK_MESSAGE_BYTES for recorder.page-network
 * (it carries full masked bodies up to 2 MiB each, Task 18). */
export function parseExternalMessage(
  raw: unknown,
): ExternalToBackground | null {
  const bytes = jsonBytes(raw);
  if (bytes === null) return null;
  const type = (raw as { type?: unknown } | null)?.type;
  const cap =
    type === "recorder.page-network"
      ? RECORDER_PAGE_NETWORK_MESSAGE_BYTES
      : MAX_MESSAGE_BYTES;
  if (bytes > cap) return null;
  const parsed = externalToBackgroundSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export type { DemonstrationAction };
