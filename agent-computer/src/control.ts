import type {
  ComputerControlState,
  HandoffRequest,
  HandoffSource,
} from "../../shared/computer-control";
import { createActionBarrier } from "./action-barrier";
import {
  type ControlStore,
  MAX_HELD_BY,
  MAX_REQUEST_URL,
  type StoredControl,
} from "./control-store";
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
export const RECORDING_ENDING =
  "A person's recording in this browser is still ending. Wait a moment before acting.";
type Options = {
  store?: ControlStore;
  invalidateSnapshot?: () => void;
  drainTimeoutMs?: number;
  /**
   * Told whenever the wheel leaves the person who held it: they hand it back, the request they took is cancelled, or
   * the computer interrupts it (a stop, a reset, the browser or the process starting again). A recording in a Bot's
   * browser is that person's alone and ends here (`shared/bot-browser.ts`). Called after the change is saved, and
   * never awaited: the state machine does not wait on a browser. What it returns settles once that recording has
   * ended, and until then no Bot action is admitted, so the Bot never acts into a recording that is still stopping.
   */
  onWheelLeft?: () => Promise<unknown> | undefined;
};

/**
 * A page worth sending a blank browser back to: a real http(s) address, short enough to keep.
 *
 * Cloudflare's `__cf_chl_*` parameters are dropped. They are one-time tokens for the challenge that
 * was on screen, which a restart has already lost, so the page kept is the one the Bot was opening.
 */
export function pageWorthKeeping(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length > MAX_REQUEST_URL) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return undefined;
    for (const name of [...parsed.searchParams.keys()])
      if (name.startsWith("__cf_chl_")) parsed.searchParams.delete(name);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

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
  /**
   * End a request.
   *
   * Its page goes with it unless a restart interrupted it. A page address can carry a one-time token
   * (a sign-in code, a reset or magic link), and the record is kept on disk for a month: the address
   * is only needed while the request is live, or so a request raised after a restart can reopen it.
   */
  function finish(
    request: HandoffRequest,
    status: "completed" | "cancelled" | "expired" | "interrupted",
    interruption?: string,
    keepPage = false,
  ) {
    request.status = status;
    request.updatedAt = now();
    request.finishedAt = request.updatedAt;
    delete request.expiresAt;
    if (interruption) request.interruption = interruption;
    if (status === "interrupted" && keepPage && request.url)
      request.keepsPage = true;
    else {
      delete request.url;
      delete request.keepsPage;
    }
  }
  /**
   * Drop every page a finished request no longer needs: all of them, except the latest request's when
   * a restart interrupted it within the help TTL. Also cleans records written before pages were
   * dropped on finish. True when something changed.
   */
  function scrubPages(at: string): boolean {
    let changed = false;
    const latest = data.requests.at(-1);
    for (const request of data.requests) {
      if ((!request.url && !request.keepsPage) || active(request)) continue;
      const inheritable =
        request === latest &&
        request.status === "interrupted" &&
        request.keepsPage === true &&
        request.url !== undefined &&
        request.finishedAt !== undefined &&
        Date.parse(at) - Date.parse(request.finishedAt) <= HELP_REQUEST_TTL_MS;
      if (inheritable) continue;
      delete request.url;
      delete request.keepsPage;
      changed = true;
    }
    return changed;
  }
  /** Endings `onWheelLeft` started that have not settled: the Bot is not admitted while there are any. */
  let ending = 0;
  function syncAdmission() {
    if (
      active(current()) ||
      data.holder === "human" ||
      data.recoveryRequired ||
      ending > 0
    )
      barrier.close();
    else barrier.open();
  }
  /**
   * The wheel left the person: what ends with it is told, and the Bot stays out until it has ended. Counted before the
   * admission is synced, so a release never opens it for even one action while a recording is still stopping (behind a
   * Record that was still starting, as it may be).
   */
  function wheelLeft() {
    const settled = options.onWheelLeft?.();
    if (!settled) return;
    ending += 1;
    void settled
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        ending -= 1;
        syncAdmission();
      });
  }
  function expire() {
    if (storageError) throw storageError;
    if (scrubPages(now())) persist();
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
      recoveryRequired: data.recoveryRequired,
      ...(data.holder === "human" && data.heldBy
        ? { heldBy: data.heldBy }
        : {}),
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
  /**
   * The computer stopped serving the current request.
   *
   * `keepPage` only for a restart underneath the request (the process or the browser coming back up):
   * then a request raised from the blank browser that follows can reopen the page. A deliberate stop
   * or reset is someone moving on, and reset is meant to forget everything, so neither keeps it.
   */
  function interrupt(
    reason: string,
    { keepPage = false }: { keepPage?: boolean } = {},
  ): ControlState {
    const request = current();
    // Recovery is for a page a person was driving: what they left it as is unknown until someone
    // looks. A request nobody took left the page exactly as the Bot had it, and holding the Bot
    // until a person "checks" a page no person touched stranded it asking for control it had.
    const personHadIt = data.holder === "human" || request?.status === "taken";
    if (request && active(request))
      finish(request, "interrupted", reason, keepPage);
    if (!keepPage) {
      // A restart may already have interrupted this request and kept its page (a stop closes the
      // browser first, which reports as a replacement). The stop or reset is the last word.
      const latest = data.requests.at(-1);
      if (latest?.status === "interrupted") {
        delete latest.url;
        delete latest.keepsPage;
      }
    }
    if (personHadIt) data.recoveryRequired = true;
    data.holder = "bot";
    delete data.heldBy;
    data.since = now();
    data.resumeSnapshotRequired = true;
    secret = undefined;
    options.invalidateSnapshot?.();
    persist();
    if (personHadIt) wheelLeft();
    syncAdmission();
    return get();
  }
  // A persisted active request names a page in a previous process. Never call that completion.
  if (restored && (active(current()) || data.holder === "human"))
    interrupt(
      "The computer process restarted; the previous page was interrupted. Request help again to continue.",
      { keepPage: true },
    );
  // Records saved before finished requests dropped their pages are cleaned on first read.
  if (restored && scrubPages(now())) persist();
  if (restored && !active(current()) && data.holder === "bot") {
    data.resumeSnapshotRequired = true;
    persist();
  }
  syncAdmission();

  /**
   * The page of the most recent request, when that request was interrupted recently.
   *
   * Only the most recent one: a request that finished, was cancelled or expired after an
   * interruption means the person or the Bot moved on, and an older page must not come back.
   */
  function interruptedPage(at: string): string | undefined {
    const latest = data.requests.at(-1);
    if (
      latest?.status !== "interrupted" ||
      latest.keepsPage !== true ||
      !latest.url ||
      !latest.finishedAt
    )
      return undefined;
    if (Date.parse(at) - Date.parse(latest.finishedAt) <= HELP_REQUEST_TTL_MS)
      return latest.url;
    // Past the TTL the address is only a liability; requestHelp persists right after.
    delete latest.url;
    delete latest.keepsPage;
    return undefined;
  }

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
      pageUrl?: string,
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
      /*
       * The page this request is about. A browser that restarted comes back blank, so a request
       * raised on a blank page inherits the page of the request a restart interrupted, if that was
       * recent: the Bot asking again after "the computer process restarted" is still asking about
       * the page it lost, and the person it hands control to needs that page in front of them.
       */
      const url = pageWorthKeeping(pageUrl) ?? interruptedPage(at);
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
        ...(url ? { url } : {}),
      };
      data.currentRequestId = request.id;
      data.requests.push(request);
      if (toolCallId) rememberAlias(toolCallId, request.id);
      persist();
      return get();
    },
    /**
     * A person takes the wheel for the request that is waiting. `by` is their user id, which the server always sends,
     * kept as `heldBy` until the wheel goes back; a take without one leaves nobody named, and nobody may then record
     * in the Bot's browser or use its bar. Taking a request already taken changes nothing, whoever asks.
     */
    async take(requestId: string, by?: string): Promise<ControlState> {
      if (
        by !== undefined &&
        (typeof by !== "string" || !by.trim() || by.length > MAX_HELD_BY)
      )
        throw new ControlRequestError(
          `by must be a nonempty string of at most ${MAX_HELD_BY} characters.`,
        );
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
      if (by !== undefined) data.heldBy = by;
      else delete data.heldBy;
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
      delete data.heldBy;
      data.since = now();
      data.resumeSnapshotRequired = true;
      data.recoveryRequired = false;
      secret = undefined;
      options.invalidateSnapshot?.();
      persist();
      wheelLeft();
      syncAdmission();
      return get();
    },
    cancel(requestId: string): ControlState {
      const request = intended(requestId);
      if (request.status === "cancelled") return get();
      if (!active(request))
        throw new ControlRequestError("That request is no longer active.", 409);
      const wasTaken = request.status === "taken";
      finish(request, "cancelled");
      persist();
      // The person keeps the page until they hand it back, but what they took it for is over.
      if (wasTaken) wheelLeft();
      syncAdmission();
      return get();
    },
    interrupt,
    /**
     * Where a blank browser should be sent before a person works the current handoff.
     *
     * The live request's page, while one is waiting or held. Nothing otherwise: once the request
     * is over, whatever the browser shows is the Bot's business again.
     */
    pageToRestore(): string | undefined {
      expire();
      const request = current();
      return active(request) ? request?.url : undefined;
    },
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
      if (ending > 0) throw new ControlError(RECORDING_ENDING);
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
    /**
     * Whether `by` may record in the Bot's browser now: they hold the wheel, for a request that is still theirs (not
     * cancelled), and nothing the Bot was doing is still draining. Only the person is ever recorded, never the Bot,
     * because the Bot cannot act while this is true.
     */
    personMayRecord(by: string): boolean {
      return this.personHolds(by) && current()?.status === "taken";
    },
    /**
     * Whether `by` holds the wheel now, with nothing the Bot was doing still draining: the bar's own rule
     * (`humanMayDrive`), for the person it names. What clearing the Bot's browser asks, so it is never wiped under the
     * Bot, nor by anyone but the person working it.
     */
    personHolds(by: string): boolean {
      return (
        this.humanMayDrive() && data.heldBy !== undefined && data.heldBy === by
      );
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
