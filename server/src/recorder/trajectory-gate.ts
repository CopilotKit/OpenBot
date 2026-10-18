import type { CopilotRuntimeHooks } from "@copilotkit/runtime/v2";
import {
  RECORDER_SIGNED_OUT,
  TRAJECTORY_GATE_REFUSALS,
} from "@openbot/shared/recorder-api";
import {
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import type { RecorderRefusal, RecorderResolver } from "./guard";

export type TrajectoryOwner = (
  ownerUserId: string,
  trajectoryId: string,
) => Promise<{
  demonstrationId: string;
  botId: string;
  status: string;
  source: "computer" | "extension";
  closedAt: Date | null;
} | null>;

export type TrajectoryRefusal = {
  reason:
    | "invalid-id"
    | "signed-out"
    | "forbidden"
    | "unavailable"
    | "not-open";
  trajectoryId: string;
  userId: string | null;
};

/** One row per (person, trajectory, reason) in this window: a browser retrying a refused pass must not flood the trail. */
const WINDOW_MS = 60_000;
/** The id is the caller's own text until it proves to be a UUID, so only its head is kept. */
const TRAJECTORY_ID_AUDIT_CHARS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SIGNED_OUT_MESSAGES: Record<
  Exclude<RecorderRefusal, "forbidden">,
  string
> = {
  malformed:
    "This browser is no longer connected to OpenBot. Connect it again.",
  unknown: "This browser is no longer connected to OpenBot. Connect it again.",
  removed: "This browser is no longer connected to OpenBot. Connect it again.",
  organization:
    "Your organization sign-in ended. Connect this browser to OpenBot again.",
};

/** What the extension is told when its token no longer resolves: the same reasons the recorder guard gives. */
function signedOutReason(refused: Exclude<RecorderRefusal, "forbidden">) {
  if (refused === "removed") return "removed";
  if (refused === "organization") return "organization";
  return "revoked";
}

function refuse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Runs on the runtime's own resolved route (onBeforeHandler runs before handleTrajectoryConnect's isValidTrajectoryId). */
export function createTrajectoryConnectHook(deps: {
  resolveRecorder: RecorderResolver;
  sessionActorId: (request: Request) => Promise<string | null>;
  trajectoryOwner: TrajectoryOwner;
  /** Writes recorder.trajectory_refused, at most once per (person, trajectory, reason) a minute on this replica, and once per reason a minute for callers with no person. */
  audit: (refusal: TrajectoryRefusal) => void;
}): NonNullable<CopilotRuntimeHooks["onBeforeHandler"]> {
  return async ({ request, route }) => {
    if (route.method !== "trajectory/connect") return;
    const { trajectoryId } = route;
    const refusal = (
      reason: TrajectoryRefusal["reason"],
      userId: string | null,
      response: Response,
    ): never => {
      deps.audit({ reason, trajectoryId, userId });
      throw response;
    };

    if (!UUID.test(trajectoryId)) {
      const { status, ...body } = TRAJECTORY_GATE_REFUSALS.invalidId;
      refusal("invalid-id", null, refuse(status, body));
    }

    let personId: string;
    const resolution = await deps.resolveRecorder(request);
    if (resolution && "actor" in resolution) {
      personId = resolution.actor.id;
    } else if (resolution && "unavailable" in resolution) {
      const { status, ...body } = TRAJECTORY_GATE_REFUSALS.authorityUnavailable;
      return refusal("unavailable", null, refuse(status, body));
    } else if (resolution) {
      const userId = resolution.userId ?? null;
      if (resolution.refused === "forbidden") {
        const { status, ...body } = TRAJECTORY_GATE_REFUSALS.forbidden;
        return refusal("forbidden", userId, refuse(status, body));
      }
      return refusal(
        "signed-out",
        userId,
        refuse(401, {
          code: RECORDER_SIGNED_OUT,
          message: SIGNED_OUT_MESSAGES[resolution.refused],
          reason: signedOutReason(resolution.refused),
        }),
      );
    } else {
      const sessionPerson = await deps.sessionActorId(request);
      if (!sessionPerson) {
        return refusal(
          "signed-out",
          null,
          refuse(401, {
            code: "IDENTITY_REQUIRED",
            message: "Sign in to OpenBot to record.",
          }),
        );
      }
      personId = sessionPerson;
    }

    const owner = await deps.trajectoryOwner(personId, trajectoryId);
    if (owner?.source !== "extension" || owner.closedAt !== null) {
      const { status, ...body } = TRAJECTORY_GATE_REFUSALS.notOpen;
      refusal("not-open", personId, refuse(status, body));
    }
  };
}

/**
 * Defense in depth for identifyUser: the same unanchored shape the runtime's router matches
 * (`core/fetch-router.ts` `matchRoute`): the last three non-empty segments are `trajectory/<id>/connect`.
 */
export function isTrajectoryConnectPath(
  pathname: string,
  basePath?: string,
): boolean {
  let remainder = pathname;
  if (basePath) {
    const base =
      basePath.length > 1 && basePath.endsWith("/")
        ? basePath.slice(0, -1)
        : basePath;
    if (base !== "/") {
      if (!pathname.startsWith(base)) return false;
      const afterBase = pathname.slice(base.length);
      if (afterBase.length > 0 && !afterBase.startsWith("/")) return false;
      remainder = afterBase || "/";
    }
  }
  const segments = remainder.split("/").filter(Boolean);
  const length = segments.length;
  if (
    length < 3 ||
    segments[length - 3] !== "trajectory" ||
    segments[length - 1] !== "connect"
  ) {
    return false;
  }
  try {
    return decodeURIComponent(segments[length - 2] ?? "") !== "";
  } catch {
    return false;
  }
}

/** Writes recorder.trajectory_refused at most once per (person, trajectory, reason) a minute on this replica, and once per reason a minute for callers with no person. */
export function createTrajectoryRefusalAudit(
  auditStore: AuditStore | undefined,
  options: { now?: () => number } = {},
): (refusal: TrajectoryRefusal) => void {
  if (!auditStore) return () => {};
  const now = options.now ?? Date.now;
  // Insertion order is time order (a key is only ever added after its old entry is gone), so the expired keys are a prefix.
  const written = new Map<string, number>();

  return (refusal) => {
    const at = now();
    for (const [key, writtenAt] of written) {
      if (at - writtenAt < WINDOW_MS) break;
      written.delete(key);
    }
    const trajectoryId = refusal.trajectoryId.slice(
      0,
      TRAJECTORY_ID_AUDIT_CHARS,
    );
    // A caller nobody is signed in as can invent trajectory ids without limit, so theirs dedupe on the reason alone.
    const key = refusal.userId
      ? `${refusal.userId}:${trajectoryId}:${refusal.reason}`
      : `none:${refusal.reason}`;
    if (written.has(key)) return;
    written.set(key, at);

    recordAuditEvent(auditStore, {
      eventType: "recorder.trajectory_refused",
      targetType: "recorder_trajectory",
      targetId: trajectoryId,
      // A refusal whose person is known is that person's; one nobody can be named for is the deployment refusing a caller.
      ...(refusal.userId
        ? { actorUserId: refusal.userId }
        : { initiator: DEPLOYMENT_INITIATOR }),
      payload: { reason: refusal.reason },
    }).catch((error: unknown) => {
      // Never fatal: the refusal is already decided and sent.
      console.error(
        JSON.stringify({
          type: "recorder-trajectory-refusal-audit-write-failed",
          error: String(error),
        }),
      );
    });
  };
}
