import type {
  ComputerControlState,
  HandoffRequest,
  HandoffSource,
} from "../../shared/computer-control";
import { createActionBarrier } from "./action-barrier";
import type { ControlStore, StoredControl } from "./control-store";
export type ControlState = ComputerControlState;
export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}
export class ControlRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ControlRequestError";
  }
}
export class SnapshotRequiredError extends Error {
  constructor() {
    super("Take a fresh browser snapshot after handback before acting.");
    this.name = "SnapshotRequiredError";
  }
}
export const NO_SECRET_PENDING = "Nothing is waiting for a secret.";
export const HELP_REQUEST_TTL_MS = 10 * 60 * 1000;
export const SECRET_REQUEST_TTL_MS = HELP_REQUEST_TTL_MS;
export const HUMAN_HAS_CONTROL =
  "A person has control or has been asked to take control. Wait for them to hand it back before acting.";
export const TAKE_CONTROL_FIRST =
  "Take control before driving the computer yourself.";
type Options = {
  store?: ControlStore;
  invalidateSnapshot?: () => void;
  drainTimeoutMs?: number;
};

/** Request identity is durable; secret values never enter this state machine. */
export function createControl(
  now: () => string = () => new Date().toISOString(),
  options: Options = {},
) {
  const barrier = createActionBarrier();
  const restored = options.store?.load();
  const data: StoredControl = restored ?? {
    version: 1,
    holder: "bot",
    since: now(),
    resumeSnapshotRequired: false,
    recoveryRequired: false,
    requests: [],
    aliases: {},
  };
  let secret:
    | { label: string; ref: string; snapshotId?: number; requestedAt: string }
    | undefined;
  let storageError: Error | undefined;
  const current = () =>
    data.requests.find((r) => r.id === data.currentRequestId);
  const active = (request: HandoffRequest | undefined) =>
    request?.status === "waiting" || request?.status === "taken";
  function persist() {
    // Keep the current identity and the latest 32 terminal records. Their aliases expire together.
    const cutoff = Date.parse(now()) - 30 * 24 * 60 * 60 * 1000;
    const keep = data.requests
      .filter(
        (r) =>
          r.id === data.currentRequestId || Date.parse(r.updatedAt) >= cutoff,
      )
      .slice(-33);
    const ids = new Set(keep.map((r) => r.id));
    data.requests = keep;
    data.aliases = Object.fromEntries(
      Object.entries(data.aliases)
        .filter(([, id]) => ids.has(id))
        .slice(-256),
    );
    if (storageError) throw storageError;
    try {
      options.store?.save(structuredClone(data));
    } catch (error) {
      storageError = new Error(
        "The handoff state could not be saved. Computer actions are disabled until storage is repaired.",
        { cause: error },
      );
      barrier.close();
      throw storageError;
    }
  }
  function finish(
    request: HandoffRequest,
    status: "completed" | "cancelled" | "expired" | "interrupted",
    interruption?: string,
  ) {
    request.status = status;
    request.updatedAt = now();
    request.finishedAt = request.updatedAt;
    delete request.expiresAt;
    if (interruption) request.interruption = interruption;
  }
  function syncAdmission() {
    if (active(current()) || data.holder === "human" || data.recoveryRequired)
      barrier.close();
    else barrier.open();
  }
  function expire() {
    if (storageError) throw storageError;
    const request = current();
    if (
      request?.status === "waiting" &&
      request.expiresAt &&
      Date.parse(now()) > Date.parse(request.expiresAt)
    ) {
      finish(request, "expired");
      persist();
      syncAdmission();
    }
    if (
      secret &&
      Date.parse(now()) - Date.parse(secret.requestedAt) > SECRET_REQUEST_TTL_MS
    )
      secret = undefined;
  }
  function get(requestId?: string): ControlState {
    expire();
    const request = requestId
      ? data.requests.find((r) => r.id === requestId)
      : current();
    if (requestId && !request)
      throw new ControlRequestError("That handoff request was not found.", 404);
    const live = current();
    return {
      holder: data.holder,
      since: data.since,
      requested: live?.status === "waiting",
      reason: active(live) ? live?.reason : undefined,
      request: request ? { ...request } : undefined,
      transitioning:
        (active(live) || data.holder === "human" || data.recoveryRequired) &&
        barrier.pending() > 0,
      resumeSnapshotRequired: data.resumeSnapshotRequired,
      ...(secret
        ? {
            secretWanted: secret.label,
            secretRef: secret.ref,
            secretSnapshotId: secret.snapshotId,
          }
        : {}),
    };
  }
  function intended(id: string): HandoffRequest {
    expire();
    const request = current();
    if (!request || request.id !== id)
      throw new ControlRequestError(
        "That request is no longer the current handoff.",
        409,
      );
    return request;
  }
  function interrupt(reason: string): ControlState {
    const request = current();
    // Recovery is for a page a person was driving: what they left it as is unknown until someone
    // looks. A request nobody took left the page exactly as the Bot had it, and holding the Bot
    // until a person "checks" a page no person touched stranded it asking for control it had.
    const personHadIt = data.holder === "human" || request?.status === "taken";
    if (request && active(request)) finish(request, "interrupted", reason);
    if (personHadIt) data.recoveryRequired = true;
    data.holder = "bot";
    data.since = now();
    data.resumeSnapshotRequired = true;
    secret = undefined;
    options.invalidateSnapshot?.();
    persist();
    syncAdmission();
    return get();
  }
  // A persisted active request names a page in a previous process. Never call that completion.
  if (restored && (active(current()) || data.holder === "human"))
    interrupt(
      "The computer process restarted; the previous page was interrupted. Request help again to continue.",
    );
  if (restored && !active(current()) && data.holder === "bot") {
    data.resumeSnapshotRequired = true;
    persist();
  }
  syncAdmission();

  function rememberAlias(toolCallId: string, requestId: string) {
    Object.defineProperty(data.aliases, toolCallId, {
      value: requestId,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return {
    get,
    requestHelp(
      reason: unknown,
      toolCallId?: string,
      source: HandoffSource = "model",
    ): ControlState {
      expire();
      if (
        toolCallId !== undefined &&
        (!toolCallId.trim() || toolCallId.length > 200)
      )
        throw new ControlRequestError(
          "The tool call id must be a nonempty string of at most 200 characters.",
        );
      const previous =
        toolCallId && Object.hasOwn(data.aliases, toolCallId)
          ? data.aliases[toolCallId]
          : undefined;
      if (previous) return get(previous);
      const existing = current();
      if (active(existing) || data.holder === "human") {
        if (toolCallId && existing) {
          rememberAlias(toolCallId, existing.id);
          persist();
        }
        return get();
      }
      barrier.close(); // Before any persistence or awaited browser operation.
      const at = now();
      const request: HandoffRequest = {
        id: crypto.randomUUID(),
        toolCallId,
        reason:
          typeof reason === "string" && reason.trim()
            ? reason.trim().slice(0, 500)
            : "The assistant needs a person to continue.",
        source,
        status: "waiting",
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(Date.parse(at) + HELP_REQUEST_TTL_MS).toISOString(),
      };
      data.currentRequestId = request.id;
      data.requests.push(request);
      if (toolCallId) rememberAlias(toolCallId, request.id);
      persist();
      return get();
    },
    async take(requestId: string): Promise<ControlState> {
      const request = intended(requestId);
      if (request.status === "taken" && data.holder === "human") return get();
      if (request.status !== "waiting")
        throw new ControlRequestError(
          "That request is no longer waiting for control.",
          409,
        );
      barrier.close();
      // Never await here from requestHelp: a navigation detector still owns its action lease.
      await barrier.drain(options.drainTimeoutMs);
      const after = intended(requestId);
      if (after.status === "taken" && data.holder === "human") return get();
      if (after.status !== "waiting")
        throw new ControlRequestError(
          "That request is no longer waiting for control.",
          409,
        );
      after.status = "taken";
      after.updatedAt = now();
      delete after.expiresAt;
      data.holder = "human";
      data.since = now();
      secret = undefined;
      persist();
      return get();
    },
    release(requestId: string): ControlState {
      const request = intended(requestId);
      if (request.status === "completed" && data.holder === "bot") return get();
      if (
        data.holder !== "human" ||
        (request.status !== "taken" && request.status !== "cancelled")
      )
        throw new ControlRequestError(
          "That request is no longer held by a person.",
          409,
        );
      if (request.status === "taken") finish(request, "completed");
      data.holder = "bot";
      data.since = now();
      data.resumeSnapshotRequired = true;
      data.recoveryRequired = false;
      secret = undefined;
      options.invalidateSnapshot?.();
      persist();
      syncAdmission();
      return get();
    },
    cancel(requestId: string): ControlState {
      const request = intended(requestId);
      if (request.status === "cancelled") return get();
      if (!active(request))
        throw new ControlRequestError("That request is no longer active.", 409);
      finish(request, "cancelled");
      persist();
      syncAdmission();
      return get();
    },
    interrupt,
    snapshotTaken() {
      if (
        data.holder === "bot" &&
        data.resumeSnapshotRequired &&
        !active(current())
      ) {
        data.resumeSnapshotRequired = false;
        persist();
      }
    },
    assertBotMayAct(browserMutation = false) {
      expire();
      if (data.holder === "human" || active(current()) || data.recoveryRequired)
        throw new ControlError(HUMAN_HAS_CONTROL);
      if (browserMutation && data.resumeSnapshotRequired)
        throw new SnapshotRequiredError();
    },
    admitBotAction(browserMutation = false): () => void {
      this.assertBotMayAct(browserMutation);
      return barrier.enter();
    },
    humanMayDrive(): boolean {
      return data.holder === "human" && barrier.pending() === 0;
    },
    requestSecret(input: {
      label?: unknown;
      ref?: unknown;
      snapshotId?: unknown;
    }): ControlState {
      if (typeof input.ref !== "string" || !input.ref.trim())
        throw new ControlRequestError(
          "Say which field the value goes in, using a ref from your snapshot.",
        );
      secret = {
        label:
          typeof input.label === "string" && input.label.trim()
            ? input.label.trim().slice(0, 500)
            : "the value this page is asking for",
        ref: input.ref.trim(),
        snapshotId:
          typeof input.snapshotId === "number" ? input.snapshotId : undefined,
        requestedAt: now(),
      };
      return get();
    },
    pendingSecret(): { ref: string; snapshotId?: number } | null {
      expire();
      return secret ? { ref: secret.ref, snapshotId: secret.snapshotId } : null;
    },
    secretSupplied() {
      secret = undefined;
    },
  };
}
export type Control = ReturnType<typeof createControl>;
