import { z } from "zod";
import { demonstrationActionSchema } from "./demonstration-schema";

export const RECORDER_TOKEN_PREFIX = "obr_";
export const RECORDER_CODE_PREFIX = "obc_";
export const RECORDER_CONNECT_CODE_TTL_MS = 5 * 60_000;
export const RECORDER_ACTION_BATCH_MAX = 200;
export const RECORDER_ACTION_BATCH_BYTES = 256 * 1024;
/** 512 KiB: under ingress-nginx's default 1 MiB request body limit (`proxy-body-size`), which the chart's ingress does not raise
 * (`charts/openbot/values.yaml` `ingress.annotations` is `{}`), so an upload never needs a proxy setting changed. */
export const RECORDER_MEDIA_CHUNK_BYTES = 512 * 1024;
export const RECORDER_NETWORK_BODY_MAX_BYTES = 2 * 1024 * 1024;
/** A recorder.page-network message carries up to two masked bodies of RECORDER_NETWORK_BODY_MAX_BYTES (Task 18). */
export const RECORDER_PAGE_NETWORK_MESSAGE_BYTES =
  2 * RECORDER_NETWORK_BODY_MAX_BYTES + 256 * 1024;
export const RECORDER_STEP_NOTICE_AT = 50;
export const TRAJECTORY_ROLLOVER_AT = 19_000; // Intelligence caps a trajectory at 20,000 events (trajectories/store.ex @default_event_cap)
/** The `code` on every 401 the recorder bearer gets. Only this code means "signed out". */
export const RECORDER_SIGNED_OUT = "RECORDER_SIGNED_OUT";
/** The `code` on the 409 a start gets when this person already has an open extension recording for the Bot. */
export const RECORDER_OPEN_RECORDING = "OPEN_RECORDING";
/** The `code` on the 503 the recorder guard and the trajectory gate answer when the organization's sign-in server could not
 * answer for now (Decision 19): transient, never a sign-out; the caller retries. */
export const RECORDER_AUTHORITY_UNAVAILABLE = "RECORDER_AUTHORITY_UNAVAILABLE";
/** Every refusal OpenBot's trajectory gate answers on the pass (Task 15 sends them, Task 11's table classifies them, rows 1-4). */
export const TRAJECTORY_GATE_REFUSALS = {
  invalidId: {
    status: 400,
    code: "INVALID_REQUEST",
    message: "Trajectory ID must be a UUID.",
  },
  forbidden: {
    status: 403,
    code: "FORBIDDEN",
    message: "Authorization required.",
  },
  notOpen: {
    status: 404,
    code: "NOT_FOUND",
    message: "This recording is not open in OpenBot.",
  },
  authorityUnavailable: {
    status: 503,
    code: RECORDER_AUTHORITY_UNAVAILABLE,
    message: "Your organization could not answer. Try again in a moment.",
  },
} as const;

export type RecorderConnectVia = "web" | "desktop";
export type RecorderUser = { id: string; name: string; email: string };
export type RecorderConnection = {
  id: string;
  label: string;
  via: RecorderConnectVia;
  extensionId: string;
  /** The connecting copy's install id for this OpenBot origin (Decision 18): 32 lowercase hex digits. */
  installId: string;
  createdAt: string;
  lastUsedAt: string | null;
};
export const RECORDER_INSTALL_ID = /^[0-9a-f]{32}$/;
export type ConnectCodeResponse = { code: string; expiresAt: string };
export type RecorderConnectionsResponse = {
  connections: RecorderConnection[];
  extensionIds: string[];
};
export type ExchangeResponse = {
  token: string;
  connection: RecorderConnection;
  user: RecorderUser;
};
export type RecorderMe = {
  user: RecorderUser;
  connectionId: string;
  capabilities: { transcription: boolean };
};
/** Whether a Bot's recordings land in a Learning space (Decision 10, Task 15). */
export type LearningSpaceState = {
  /** Decision 10: assigned, unassigned (no space for the Bot), missing (Intelligence says the container does not exist),
   * learning-off (Intelligence's Learning delivery is off, unlicensed or unavailable, so existence was not checked),
   * unverified (Intelligence could not be asked), unjoined (the runtime's 5 s deadline passed and it joined no space). */
  state:
    | "assigned"
    | "unassigned"
    | "missing"
    | "learning-off"
    | "unverified"
    | "unjoined";
  containerId: string | null;
};
export const LEARNING_SPACE_STATES = [
  "assigned",
  "unassigned",
  "missing",
  "learning-off",
  "unverified",
  "unjoined",
] as const;
export type RecorderBot = {
  id: string;
  name: string;
  learning: LearningSpaceState;
};
export type ExtensionDemonstration = {
  id: string;
  botId: string;
  title: string;
  source: "extension";
  status: "recording" | "stopped" | "drafted" | "published";
  actionCount: number;
  /** What the newest trajectory's last pass found (Task 15), or null before the first pass. */
  learning: LearningSpaceState | null;
};
export type MediaRecord = {
  id: string;
  kind: "screen" | "audio" | "network";
  mimeType: string;
  chunks: number[];
  byteSize: number;
  completedAt: string | null;
};
export type TrajectoryGrant = {
  joinToken: string;
  realtime: { clientUrl: string; topic: string };
};
export type RecorderErrorBody = {
  error: string;
  code?: string;
  reason?: "revoked" | "removed" | "organization";
  count?: number;
  demonstrationId?: string;
};

export const connectCodeRequestSchema = z
  .object({ via: z.enum(["web", "desktop"]) })
  .strict();
export const exchangeRequestSchema = z
  .object({
    code: z.string().startsWith(RECORDER_CODE_PREFIX).max(80),
    label: z.string().trim().min(1).max(80),
    installId: z.string().regex(RECORDER_INSTALL_ID),
  })
  .strict();
export const startExtensionDemonstrationSchema = z
  .object({
    botId: z.string().min(1).max(200),
    title: z.string().trim().min(1).max(120),
  })
  .strict();
export const actionBatchSchema = z
  .object({
    fromIndex: z.number().int().min(0),
    actions: z
      .array(demonstrationActionSchema)
      .min(1)
      .max(RECORDER_ACTION_BATCH_MAX),
  })
  .strict();
export const registerTrajectorySchema = z
  .object({ trajectoryId: z.string().uuid() })
  .strict();
export const createMediaSchema = z
  .object({
    kind: z.enum(["screen", "audio", "network"]),
    mimeType: z.enum([
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "audio/webm;codecs=opus",
      "audio/webm",
      "application/x-ndjson",
    ]),
  })
  .strict()
  .refine(
    (m) =>
      (m.kind === "network") === (m.mimeType === "application/x-ndjson") &&
      (m.kind !== "audio" || m.mimeType.startsWith("audio/")),
    "The media kind and type do not match.",
  );
export const completeMediaSchema = z
  .object({ chunkCount: z.number().int().min(0) })
  .strict();

const id = (value: string) => encodeURIComponent(value);
const demo = (d: string) => `/api/recorder/demonstrations/${id(d)}`;
export const recorderPaths = {
  connectCodes: "/api/recorder/connect-codes",
  connections: "/api/recorder/connections",
  connection: (connectionId: string) =>
    `/api/recorder/connections/${id(connectionId)}`,
  currentConnection: "/api/recorder/connections/current",
  me: "/api/recorder/me",
  bots: "/api/recorder/bots",
  demonstrations: "/api/recorder/demonstrations",
  openDemonstration: (botId: string) =>
    `/api/recorder/demonstrations/open?botId=${id(botId)}`,
  demonstration: demo,
  actions: (d: string) => `${demo(d)}/actions`,
  trajectories: (d: string) => `${demo(d)}/trajectories`,
  closeTrajectory: (d: string, t: string) =>
    `${demo(d)}/trajectories/${id(t)}/close`,
  stop: (d: string) => `${demo(d)}/stop`,
  media: (d: string) => `${demo(d)}/media`,
  mediaItem: (d: string, m: string) => `${demo(d)}/media/${id(m)}`,
  mediaChunk: (d: string, m: string, index: number) =>
    `${demo(d)}/media/${id(m)}/chunks/${index}`,
  mediaComplete: (d: string, m: string) => `${demo(d)}/media/${id(m)}/complete`,
  trajectoryConnect: (t: string) =>
    `/api/copilotkit/trajectory/${id(t)}/connect`,
  transcriptions: "/api/audio/transcriptions",
  // Read routes, cookie only, for the demonstration's owner and administrators (Task 16):
  mediaList: (d: string) => `/api/demonstrations/${id(d)}/media`,
  mediaContent: (d: string, m: string) =>
    `/api/demonstrations/${id(d)}/media/${id(m)}/content`,
  mediaLine: (d: string, m: string, line: number) =>
    `/api/demonstrations/${id(d)}/media/${id(m)}/lines/${line}`,
} as const;

/**
 * The `bodyRef` a network event carries when its full bodies were too large for the event (Tasks 17, 18):
 * an absolute URL on the OpenBot the recording went to, answering that one NDJSON line to the
 * demonstration's owner and administrators (Task 16). `line` counts from 0 within that media.
 */
export function networkBodyRef(
  openbotOrigin: string,
  demonstrationId: string,
  mediaId: string,
  line: number,
): string {
  return `${openbotOrigin}${recorderPaths.mediaLine(demonstrationId, mediaId, line)}`;
}

const NETWORK_BODY_PATH =
  /^\/api\/demonstrations\/([^/]+)\/media\/([^/]+)\/lines\/(\d+)$/;

export function parseNetworkBodyRef(ref: string): {
  origin: string;
  demonstrationId: string;
  mediaId: string;
  line: number;
} | null {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return null;
  }
  const match = NETWORK_BODY_PATH.exec(url.pathname);
  if (!match || url.search || url.hash) return null;
  try {
    return {
      origin: url.origin,
      demonstrationId: decodeURIComponent(match[1]),
      mediaId: decodeURIComponent(match[2]),
      line: Number(match[3]),
    };
  } catch {
    return null;
  }
}
