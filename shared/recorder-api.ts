import { z } from "zod";

export const RECORDER_TOKEN_PREFIX = "obr_";
export const RECORDER_CODE_PREFIX = "obc_";
export const RECORDER_CONNECT_CODE_TTL_MS = 5 * 60_000;
export const RECORDER_NETWORK_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const RECORDER_STEP_NOTICE_AT = 50;
export const TRAJECTORY_ROLLOVER_AT = 19_000; // Intelligence caps a trajectory at 20,000 events (trajectories/store.ex @default_event_cap)
/** The `code` on every 401 the recorder bearer gets. Only this code means "signed out". */
export const RECORDER_SIGNED_OUT = "RECORDER_SIGNED_OUT";
/** The `code` on the 503 the recorder guard and the trajectory gate answer when the organization's sign-in server could not
 * answer for now (Decision 19): transient, never a sign-out; the caller retries. */
export const RECORDER_AUTHORITY_UNAVAILABLE = "RECORDER_AUTHORITY_UNAVAILABLE";
/** The header the Recorder names the Bot the person picked in on every capture pass request, beside its bearer: OpenBot
 * binds the trajectory to that Bot and puts it into that Bot's Learning space. */
export const RECORDER_BOT_HEADER = "x-openbot-recorder-bot";
/** The refusals OpenBot's trajectory gate shares with the Recorder's pass table (rows 1, 3 and 4a). */
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
const RECORDER_INSTALL_ID = /^[0-9a-f]{32}$/;
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
export type RecorderMe = { user: RecorderUser; connectionId: string };
/** Decision 10: assigned, unassigned (no space for the Bot), missing (Intelligence says the container does not exist),
 * learning-off (Intelligence's Learning delivery is off, unlicensed or unavailable, so existence was not checked),
 * unverified (Intelligence could not be asked), unjoined (the runtime's 5 s deadline passed and it joined no space). */
export const LEARNING_SPACE_STATES = [
  "assigned",
  "unassigned",
  "missing",
  "learning-off",
  "unverified",
  "unjoined",
] as const;
/** Whether a Bot's recordings land in a Learning space (Decision 10, Task 15). */
export type LearningSpaceState = {
  state: (typeof LEARNING_SPACE_STATES)[number];
  containerId: string | null;
};
export type RecorderBot = {
  id: string;
  name: string;
  learning: LearningSpaceState;
};
export type TrajectoryGrant = {
  joinToken: string;
  realtime: { clientUrl: string; topic: string };
};
export type RecorderErrorBody = {
  error: string;
  code?: string;
  reason?: "revoked" | "removed" | "organization";
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

const id = (value: string) => encodeURIComponent(value);
export const recorderPaths = {
  connectCodes: "/api/recorder/connect-codes",
  connections: "/api/recorder/connections",
  connection: (connectionId: string) =>
    `/api/recorder/connections/${id(connectionId)}`,
  currentConnection: "/api/recorder/connections/current",
  me: "/api/recorder/me",
  bots: "/api/recorder/bots",
  trajectoryConnect: (t: string) =>
    `/api/copilotkit/trajectory/${id(t)}/connect`,
} as const;
