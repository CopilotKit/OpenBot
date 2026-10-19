import {
  RECORDER_AUTHORITY_UNAVAILABLE,
  RECORDER_SIGNED_OUT,
  recorderPaths,
  type TrajectoryGrant,
} from "@openbot/shared/recorder-api";
import { openbotRaw } from "../shared/openbot-client";

/** The table's verdicts for the pass stage (rows 1-23a). Every one keeps every queued event; signed-out keeps them for the
 * person who recorded them until they connect this browser again (Decision 19). */
export type GrantVerdict =
  | { kind: "retry"; reason: string; retryAfterMs?: number }
  | { kind: "hold"; code: string; hint: string } // stop (hold): keep events, try again every 5 minutes
  | { kind: "park"; code: string; hint: string } // stop (park): keep events, try again at the next browser start
  | { kind: "signed-out"; reason: "revoked" | "removed" | "organization" };

export class GrantError extends Error {
  constructor(readonly verdict: GrantVerdict) {
    super(verdict.kind);
    this.name = "GrantError";
  }
}

const BUSY = "Intelligence is busy or unreachable. Retrying; nothing is lost.";
const AUTHORITY =
  "OpenBot could not reach your organization's sign-in. Retrying; nothing is lost.";
const MARKETPLACE =
  "Intelligence needs its marketplace licence before it can capture. Retrying; nothing is lost.";

/** Fixed sentences per code, never the server's text. `<status>` is replaced with the HTTP status. */
export const PASS_HINTS: Record<string, string> = {
  INVALID_REQUEST:
    "Learning capture is off: the Recorder sent Intelligence a request it could not read.",
  FORBIDDEN:
    "Learning capture is off: your OpenBot account has no role that may record.",
  NOT_FOUND:
    "Learning capture is off: OpenBot says this recording belongs to another person.",
  IDENTITY_REQUIRED:
    "Learning capture is paused: OpenBot could not tell Intelligence who you are.",
  INTELLIGENCE_RUNTIME_REQUIRED:
    "Learning capture is off: this OpenBot is not connected to Intelligence.",
  INVALID_GRANT:
    "Learning capture is paused: Intelligence answered the capture pass in a form the Recorder cannot use.",
  REFUSED:
    "Learning capture is paused: Intelligence refused the capture pass (<status>).",
  TRAJECTORIES_UNAVAILABLE:
    "Learning capture is off: Product Trajectories are turned off in Intelligence (FF_LEARNING_TRAJECTORIES).",
  TRAJECTORIES_NOT_ENABLED:
    "Learning capture is paused: Intelligence says this organization's licence does not include Product Trajectories, that its billing is blocked, or that it could not check right now.",
  VALIDATION_ERROR:
    "Learning capture is off: Intelligence refused the recording's request.",
  TRAJECTORY_APP_USER_CONFLICT:
    "Learning capture is off: Intelligence already holds this recording for someone else.",
  LEARNING_CONTAINER_NOT_FOUND:
    "Learning capture is paused: Intelligence could not find your Learning space.",
  UNAUTHORIZED: "Learning capture is paused: OpenBot refused the capture pass.",
  GATEWAY_NOT_ALLOWED:
    "Learning capture is off: the capture pass pointed at an Intelligence address your organization does not allow.",
  UNKNOWN_ANSWER:
    "Learning capture is paused: the capture pass got an answer the Recorder does not know (<status>).",
};

const SIGNED_OUT_REASONS = ["revoked", "removed", "organization"] as const;

function retryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** status null = network failure; one branch per pass row, then the row 23a default for anything else; `headers.retryAfter`
 * is the response's `Retry-After`, read for rows 18 and 4a. */
export function classifyGrantError(
  status: number | null,
  body: { code?: string; message?: string; reason?: string } | null,
  headers?: { retryAfter?: string | null },
): GrantVerdict {
  const code = body?.code;
  // A body from the wire may carry a non-text message; treat it as no message.
  const message = typeof body?.message === "string" ? body.message : "";
  const retry = (reason: string): GrantVerdict => {
    const after = retryAfterMs(headers?.retryAfter);
    return after === undefined
      ? { kind: "retry", reason }
      : { kind: "retry", reason, retryAfterMs: after };
  };
  const stop = (kind: "hold" | "park", key: string): GrantVerdict => ({
    kind,
    code: key,
    hint: PASS_HINTS[key].replace("<status>", String(status)),
  });

  // Row 21: a network failure.
  if (status === null) return retry(BUSY);
  // Row 18 takes 408 and 429 over row 10 and over any code the body carries.
  if (status === 408 || status === 429 || code === "RATE_LIMIT_EXCEEDED") {
    return retry(BUSY);
  }
  // Rows 1 and 5.
  if (status === 400 && code === "INVALID_REQUEST") {
    return stop("park", "INVALID_REQUEST");
  }
  // Row 2.
  if (status === 401 && code === RECORDER_SIGNED_OUT) {
    const reason =
      SIGNED_OUT_REASONS.find((r) => r === body?.reason) ?? "revoked";
    return { kind: "signed-out", reason };
  }
  // Row 3.
  if (status === 403 && code === "FORBIDDEN") return stop("park", "FORBIDDEN");
  // Row 4.
  if (status === 404 && code === "NOT_FOUND") return stop("park", "NOT_FOUND");
  // Row 4a.
  if (status === 503 && code === RECORDER_AUTHORITY_UNAVAILABLE) {
    return retry(AUTHORITY);
  }
  // Row 6.
  if (status === 401 && code === "IDENTITY_REQUIRED") {
    return stop("hold", "IDENTITY_REQUIRED");
  }
  // Row 7.
  if (status === 503 && code === "INTELLIGENCE_RUNTIME_REQUIRED") {
    return stop("park", "INTELLIGENCE_RUNTIME_REQUIRED");
  }
  if (code === "CONNECTION_FAILED") {
    // Row 8.
    if (message.includes("Could not connect to Intelligence")) {
      return retry(BUSY);
    }
    // Row 9.
    if (message.includes("invalid trajectory connection grant")) {
      return stop("hold", "INVALID_GRANT");
    }
    // Row 10: Intelligence's own status decides.
    return status >= 500 ? retry(BUSY) : stop("hold", "REFUSED");
  }
  // Row 11.
  if (status === 404 && code === "TRAJECTORIES_UNAVAILABLE") {
    return stop("park", "TRAJECTORIES_UNAVAILABLE");
  }
  // Row 12.
  if (status === 403 && code === "TRAJECTORIES_NOT_ENABLED") {
    return stop("hold", "TRAJECTORIES_NOT_ENABLED");
  }
  // Row 13.
  if (status === 400 && code === "VALIDATION_ERROR") {
    return stop("park", "VALIDATION_ERROR");
  }
  // Row 14.
  if (status === 409 && code === "TRAJECTORY_APP_USER_CONFLICT") {
    return stop("park", "TRAJECTORY_APP_USER_CONFLICT");
  }
  // Row 15.
  if (status === 404 && code === "LEARNING_CONTAINER_NOT_FOUND") {
    return stop("hold", "LEARNING_CONTAINER_NOT_FOUND");
  }
  // Row 16.
  if (status === 500 && code === "INTERNAL_SERVER_ERROR") return retry(BUSY);
  // Row 17.
  if (status === 503 && code === "MARKETPLACE_LICENSE_REQUIRED") {
    return retry(MARKETPLACE);
  }
  // Row 19: no route matched, or a method other than POST.
  if ((status === 404 && !code) || status === 405) {
    return stop("park", "INVALID_REQUEST");
  }
  // Row 20: the fetch handler's catch-all.
  if (status === 500 && !code) return retry(BUSY);
  // Row 22: any other 401.
  if (status === 401) return stop("hold", "UNAUTHORIZED");
  // Row 23 is the streamer's own policy check on the grant (`isAllowedGatewayUrl`).
  // Row 23a: anything no row names.
  return status >= 500 ? retry(BUSY) : stop("hold", "UNKNOWN_ANSWER");
}

function isGrant(value: unknown): value is TrajectoryGrant {
  if (typeof value !== "object" || value === null) return false;
  const { joinToken, realtime } = value as Partial<TrajectoryGrant>;
  return (
    typeof joinToken === "string" &&
    joinToken !== "" &&
    typeof realtime === "object" &&
    realtime !== null &&
    typeof realtime.clientUrl === "string" &&
    typeof realtime.topic === "string"
  );
}

/** Where a pass is asked for: the connected OpenBot and the recorder bearer. No Bot: the recording is the person's. */
type GrantTarget = { openbotUrl: string; token: string };

/** Asks the runtime's `trajectory/connect` for a one-time capture pass, which joins the trajectory to the person's own
 * Learning space; throws a GrantError carrying the row's verdict. */
export async function fetchGrant(
  target: GrantTarget,
  trajectoryId: string,
): Promise<TrajectoryGrant> {
  let response: Response;
  try {
    response = await openbotRaw(
      target,
      recorderPaths.trajectoryConnect(trajectoryId),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
  } catch {
    throw new GrantError(classifyGrantError(null, null));
  }
  let parsed: unknown = null;
  let unparsable = false;
  try {
    parsed = await response.json();
  } catch {
    // A body that is not JSON carries no code.
    unparsable = true;
  }
  // Row 21: a page that is not JSON on a 2xx is OpenBot or the network
  // misbehaving, not an answer the Recorder does not know (row 23a).
  if (response.ok && unparsable) {
    throw new GrantError(classifyGrantError(null, null));
  }
  if (response.ok && isGrant(parsed)) return parsed;
  const body =
    !response.ok && typeof parsed === "object" && parsed !== null
      ? (parsed as { code?: string; message?: string; reason?: string })
      : null;
  throw new GrantError(
    classifyGrantError(response.status, body, {
      retryAfter: response.headers.get("Retry-After"),
    }),
  );
}
