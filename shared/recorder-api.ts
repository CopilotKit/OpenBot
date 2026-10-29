import { z } from "zod";

export const RECORDER_TOKEN_PREFIX = "obr_";
export const RECORDER_CODE_PREFIX = "obc_";
export const RECORDER_CONNECT_CODE_TTL_MS = 5 * 60_000;
/** The `code` on every 401 the recorder bearer gets. Only this code means "signed out". */
export const RECORDER_SIGNED_OUT = "RECORDER_SIGNED_OUT";
/** The `code` on the 503 the recorder guard and the trajectory gate answer when the organization's sign-in server could not
 * answer for now (Decision 19): transient, never a sign-out; the caller retries. */
export const RECORDER_AUTHORITY_UNAVAILABLE = "RECORDER_AUTHORITY_UNAVAILABLE";
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

/** How a browser was connected: Connect this browser in OpenBot (`web`), OpenBot Desktop's handoff (`desktop`), OpenBot
 * itself when it opened the person's own OpenBot browser, with no Connect step (`openbot-browser`), or OpenBot when the
 * person pressed Record in a Bot's browser, for that one recording (`bot-browser`, shared/bot-browser.ts). */
export type RecorderConnectVia =
  | "web"
  | "desktop"
  | "openbot-browser"
  | "bot-browser";
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
/** A connection as Settings, Browsers lists it. */
export type ListedRecorderConnection = RecorderConnection & {
  /**
   * Its Recorder said it is recording, in a report recent enough to stand (`RECORDER_ACTIVITY_STALE_MS`): a browser
   * recording now, whose last use says nothing useful, since a recording streams to the gateway rather than OpenBot.
   */
  recording: boolean;
};
export type RecorderConnectionsResponse = {
  connections: ListedRecorderConnection[];
  extensionIds: string[];
};
export type ExchangeResponse = {
  token: string;
  connection: RecorderConnection;
  user: RecorderUser;
};
export type RecorderMe = { user: RecorderUser; connectionId: string };
/** Decision 10, for the person's own Learning space: assigned (it exists), unassigned (Automatic Learning is off, so
 * there is no space), missing (it does not exist and could not be made), learning-off (Intelligence's Learning delivery
 * is off, unlicensed or unavailable, so existence was not checked), unverified (Intelligence could not be asked, or the
 * space was still being made), unjoined (the runtime's 5 s deadline passed and it joined no space). */
export const LEARNING_SPACE_STATES = [
  "assigned",
  "unassigned",
  "missing",
  "learning-off",
  "unverified",
  "unjoined",
] as const;
/** Whether the person's recordings land in their own Learning space (Decision 10, Task 15). */
export type LearningSpaceState = {
  state: (typeof LEARNING_SPACE_STATES)[number];
  containerId: string | null;
};
/**
 * The Learning container a capture pass joins for this answer, or null when it joins none. Only no space at all, or one
 * that does not exist and could not be made, joins none: an answer Intelligence could not give (unverified, or Learning
 * delivery off) still names the person's container, so one failed check does not change where a trajectory lands. The
 * server's selector joins by this, and the Recorder warns that Learning will not see a recording by it.
 */
export function joinedLearningContainer(
  learning: LearningSpaceState,
): string | null {
  const joins =
    learning.state === "assigned" ||
    learning.state === "unverified" ||
    learning.state === "learning-off";
  return joins && typeof learning.containerId === "string"
    ? learning.containerId
    : null;
}
/** `GET /api/recorder/learning`: the person's own Learning space, which every recording they make joins. */
export type RecorderLearningResponse = { learning: LearningSpaceState };
export type TrajectoryGrant = {
  joinToken: string;
  realtime: { clientUrl: string; topic: string };
};
export type RecorderErrorBody = {
  error: string;
  code?: string;
  reason?: "revoked" | "removed" | "organization";
};

/** Only `web` and `desktop` are asked for: OpenBot mints an OpenBot browser's connection itself, with no code anybody
 * could ask for. */
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

type OriginCheck = { ok: true; origin: string } | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/** https:// any host; http:// only for a loopback address with a port, 127.0.0.1 or [::1] (OpenBot Desktop's local stack,
 * Decision 21; never a name such as localhost); no userinfo, path other than "/", query or fragment. The Recorder's rule
 * for every OpenBot it connects to, here so the server never hands the Recorder an address it would refuse. */
export function normaliseOpenBotOrigin(raw: string): OriginCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a web address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "OpenBot's address must start with https://." };
  }
  if (url.username || url.password)
    return {
      ok: false,
      reason: "The address must not contain a user name or password.",
    };
  if (url.pathname !== "/" || url.search || url.hash) {
    return {
      ok: false,
      reason: "Use only the address, such as https://openbot.example.com.",
    };
  }
  if (
    url.protocol === "http:" &&
    !(LOOPBACK_HOSTS.has(url.hostname) && url.port)
  ) {
    return { ok: false, reason: "OpenBot's address must use HTTPS." };
  }
  return { ok: true, origin: url.origin };
}

const id = (value: string) => encodeURIComponent(value);
export const recorderPaths = {
  connectCodes: "/api/recorder/connect-codes",
  connections: "/api/recorder/connections",
  connection: (connectionId: string) =>
    `/api/recorder/connections/${id(connectionId)}`,
  currentConnection: "/api/recorder/connections/current",
  me: "/api/recorder/me",
  learning: "/api/recorder/learning",
  /** POST `RecorderActivity`, with the Recorder's bearer: what this browser's Recorder is doing now (the red dot). */
  activity: "/api/recorder/activity",
  trajectoryConnect: (t: string) =>
    `/api/copilotkit/trajectory/${id(t)}/connect`,
} as const;

/**
 * What a connected Recorder is doing, as it tells OpenBot whenever its recording phase changes and every 30 s while a
 * recording runs, so OpenBot can show it (the Browser button's red dot) wherever the person recorded: their own
 * everyday browser or the OpenBot browser. Best effort on the Recorder's side; OpenBot treats one older than 90 s as
 * stale.
 */
/**
 * How long a Recorder's report of what it is doing stands without another. It reports every 30 s while a recording runs,
 * so three missed reports in a row: a browser that quit or lost its network mid-recording stops reading as recording
 * after this, rather than forever.
 */
export const RECORDER_ACTIVITY_STALE_MS = 90_000;

export const recorderActivitySchema = z
  .object({
    phase: z.enum(["idle", "starting", "recording", "stopping"]),
    recordingId: z.string().min(1).max(200).optional(),
    title: z.string().max(200).optional(),
    startedAt: z.number().int().positive().optional(),
    actions: z.number().int().nonnegative(),
  })
  .strict();
export type RecorderActivity = z.infer<typeof recorderActivitySchema>;
