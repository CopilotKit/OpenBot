import type {
  CopilotRuntimeHooks,
  GetTrajectoryLearningContainerIds,
} from "@copilotkit/runtime/v2";
import {
  type LearningSpaceState,
  RECORDER_SIGNED_OUT,
  TRAJECTORY_GATE_REFUSALS,
} from "@openbot/shared/recorder-api";
import {
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import type { RecorderRefusal, RecorderResolver } from "./guard";
import type { LearningSpaceCheck } from "./learning-space";

/** The header the Recorder names its picked Bot in, beside its bearer, on the capture pass. */
export const RECORDER_BOT_HEADER = "x-openbot-recorder-bot";

export type TrajectoryRefusal = {
  reason:
    | "invalid-id"
    | "signed-out"
    | "forbidden"
    | "unavailable"
    | "no-bot"
    | "bot-forbidden"
    | "bound-elsewhere";
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

/** The pass's refusals about the picked Bot and the trajectory's binding; the codes are the ones the Recorder already reads. */
const BINDING_REFUSALS = {
  noBot: {
    status: 403,
    code: "FORBIDDEN",
    message: "Name the Bot this recording is for.",
  },
  botForbidden: {
    status: 403,
    code: "FORBIDDEN",
    message: "You cannot record for this Bot.",
  },
  boundElsewhere: {
    status: 404,
    code: "NOT_FOUND",
    message: "This trajectory belongs to another recording.",
  },
} as const;

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

/**
 * The capture pass's gate, on the runtime's own resolved route (onBeforeHandler runs before handleTrajectoryConnect's
 * isValidTrajectoryId). Only a connected browser gets a pass: a valid Recorder bearer, a UUID trajectory id, and the
 * Bot it names in {@link RECORDER_BOT_HEADER} one the person may record for. The first pass binds the trajectory to
 * that person and Bot; a later pass for it must name the same pair, or it is not found.
 */
export function createTrajectoryConnectHook(deps: {
  resolveRecorder: RecorderResolver;
  canRecordForBot(userId: string, botId: string): Promise<boolean>;
  /** False when the trajectory is already bound to another person or Bot. */
  bind(input: {
    trajectoryId: string;
    userId: string;
    botId: string;
  }): Promise<boolean>;
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
    const known = (
      reason: TrajectoryRefusal["reason"],
      userId: string | null,
      { status, ...body }: { status: number; code: string; message: string },
    ): never => refusal(reason, userId, refuse(status, body));

    if (!UUID.test(trajectoryId)) {
      known("invalid-id", null, TRAJECTORY_GATE_REFUSALS.invalidId);
    }

    const resolution = await deps.resolveRecorder(request);
    if (!resolution) {
      // No Recorder bearer: a signed-in session alone gets no pass, because only a connected browser records.
      return refusal(
        "signed-out",
        null,
        refuse(401, {
          code: "IDENTITY_REQUIRED",
          message: "Connect this browser to OpenBot to record.",
        }),
      );
    }
    if ("unavailable" in resolution) {
      return known(
        "unavailable",
        null,
        TRAJECTORY_GATE_REFUSALS.authorityUnavailable,
      );
    }
    if ("refused" in resolution) {
      const userId = resolution.userId ?? null;
      if (resolution.refused === "forbidden") {
        return known("forbidden", userId, TRAJECTORY_GATE_REFUSALS.forbidden);
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
    }
    const personId = resolution.actor.id;

    const botId = request.headers.get(RECORDER_BOT_HEADER)?.trim();
    if (!botId) {
      return known("no-bot", personId, BINDING_REFUSALS.noBot);
    }
    if (!(await deps.canRecordForBot(personId, botId))) {
      return known("bot-forbidden", personId, BINDING_REFUSALS.botForbidden);
    }
    if (!(await deps.bind({ trajectoryId, userId: personId, botId }))) {
      known("bound-elsewhere", personId, BINDING_REFUSALS.boundElsewhere);
    }
  };
}

/** Inside the runtime's 5 s selector deadline (`core/learning.ts` `resolveTrajectoryLearningContainerIds`). */
const SELECTOR_BUDGET_MS = 4_000;
/** The check is told to stop this long before the budget ends, so a probe it cuts short can still name its container. */
const CHECK_STOP_EARLY_MS = 100;

/**
 * The ids a pass joins. Only a container Intelligence says is missing, or no container at all, joins none: an answer
 * Intelligence could not give (unverified, or Learning delivery off) still names the Bot's container, so one slow probe
 * does not change which space a trajectory joins from one pass to the next. Never `[null]`, which the runtime would
 * reject whole and join with no container.
 */
function containerIdsFor(learning: LearningSpaceState): string[] | null {
  const joins =
    learning.state === "assigned" ||
    learning.state === "unverified" ||
    learning.state === "learning-off";
  return joins && typeof learning.containerId === "string"
    ? [learning.containerId]
    : null;
}

/**
 * Chooses a trajectory's Learning space for the runtime: the space of the Bot its first pass bound it to, through the
 * same target and container check the Recorder's Bot list uses. Stable for a trajectory, because the binding never
 * changes its Bot. It answers inside `budgetMs` and as soon as `signal` aborts, and never throws, because the runtime
 * joins without any container when the selector throws or misses its deadline (`intelligence-platform/client.ts`
 * `ɵconnectTrajectory`).
 */
export function createTrajectoryLearningSelector(deps: {
  /** The Bot this person's trajectory is bound to, or null. */
  botFor(trajectoryId: string, userId: string): Promise<string | null>;
  learningSpace: LearningSpaceCheck;
  /** Default 4_000: answer inside the runtime's 5 s deadline. */
  budgetMs?: number;
}): GetTrajectoryLearningContainerIds {
  const budgetMs = deps.budgetMs ?? SELECTOR_BUDGET_MS;
  const failed = (type: string, trajectoryId: string, error: unknown) =>
    console.error(JSON.stringify({ type, trajectoryId, error: String(error) }));

  return ({ trajectoryId, user }, signal) =>
    new Promise<string[] | null>((resolve) => {
      /** Aborted shortly before the budget ends or when the runtime gives up, so the probe stops too. */
      const stopCheck = new AbortController();
      let answered = false;

      const answer = (ids: string[] | null) => {
        if (answered) return;
        answered = true;
        clearTimeout(stopTimer);
        clearTimeout(budgetTimer);
        signal?.removeEventListener("abort", onAbort);
        stopCheck.abort(new Error("Learning space selection is over"));
        resolve(ids);
      };

      const onAbort = () => answer(null);
      const stopTimer = setTimeout(
        () =>
          stopCheck.abort(new Error("Learning space selection is out of time")),
        Math.max(0, budgetMs - CHECK_STOP_EARLY_MS),
      );
      const budgetTimer = setTimeout(() => {
        console.warn(
          JSON.stringify({
            type: "recorder-trajectory-learning-cut-short",
            trajectoryId,
          }),
        );
        answer(null);
      }, budgetMs);
      if (signal?.aborted) answer(null);
      else signal?.addEventListener("abort", onAbort, { once: true });

      void (async () => {
        let botId: string | null;
        try {
          botId = await deps.botFor(trajectoryId, user.id);
        } catch (error) {
          failed(
            "recorder-trajectory-learning-binding-failed",
            trajectoryId,
            error,
          );
          answer(null);
          return;
        }
        if (!botId || answered) {
          answer(null);
          return;
        }
        try {
          answer(
            containerIdsFor(await deps.learningSpace(botId, stopCheck.signal)),
          );
        } catch (error) {
          failed(
            "recorder-trajectory-learning-check-failed",
            trajectoryId,
            error,
          );
          answer(null);
        }
      })();
    });
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
