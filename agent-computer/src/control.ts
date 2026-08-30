/**
 * Who has the wheel.
 *
 * One browser has at most one driver. When a Bot meets a login wall it can ask for
 * help; a person takes control, does the part only they can do, and hands back. While a person holds
 * control every acting call from the Bot is refused, because two drivers on one page is how a Bot
 * clicks "Confirm" on a form a human was still filling in.
 *
 * State lives in this process rather than in the server because this process owns the browser, and a
 * takeover that the browser does not know about is not a takeover. The server records it and decides
 * who may ask for it; this decides whether the next action happens.
 *
 * This module has no Playwright import, so state-machine tests do not need a browser. Browser work
 * stays in `index.ts`.
 */

export type ControlState = {
  holder: "bot" | "human";
  since: string;
  /** Why the Bot asked, so the person knows what they are being handed. Set when the Bot requests. */
  reason?: string;
  /** True once the Bot has asked for help and no person has taken the wheel yet. */
  requested: boolean;
  /**
   * When the Bot asked, so an unanswered request can stop being shown.
   *
   * A request nobody answers used to last forever. The run that made it had already ended, but the
   * prompt stayed on the computer, and control belongs to the computer rather than to a conversation
   * — so every later conversation with that Bot showed a live "Take control" for work it was not
   * doing, with the reason the Bot gave, written for whoever asked and rendered to whoever looked.
   */
  requestedAt?: string;
  /** Opaque generation of the pending help request, used only for conditional cancellation. */
  helpRequestId?: string;
  /**
   * A secret the Bot is waiting for, described by its label only.
   *
   * Secret entry is scoped rather than a full takeover. The Bot names the field, says what it needs,
   * and the person types into a masked box that goes straight to the page.
   *
   * The label is all that is ever stored. The value passes through one request and is not kept here,
   * not returned, and not on any path the model reads.
   */
  secretWanted?: string;
  /**
   * Which field the secret goes in, as a ref from the Bot's snapshot.
   *
   * Required so a secret cannot be sent to whichever field happens to have focus.
   */
  secretRef?: string;
  secretSnapshotId?: number;
  /** When this exact secret generation was requested, so it expires like a help request. */
  secretRequestedAt?: string;
  /** Opaque generation of the pending secret request, used only for conditional cancellation. */
  secretRequestId?: string;
};

export type AssistanceStatus =
  | "pending"
  | "human"
  | "completed"
  | "expired"
  | "cancelled"
  | "superseded"
  | "unknown";

export type AssistanceCancellationResult = {
  cancelled: boolean;
  state: ControlState;
  status: AssistanceStatus;
};

/** Refusal because a person is driving. Distinct from a failure, so the Bot can be told to wait. */
export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}

/** What a caller must say to ask for a secret. Rejected as a request error, not thrown. */
export class ControlRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlRequestError";
  }
}

export const NO_SECRET_PENDING = "Nothing is waiting for a secret.";
/**
 * How long an unanswered request to take the wheel is shown for.
 *
 * Long enough that somebody who stepped away can still act on it, short enough that it does not
 * follow the Bot into tomorrow's conversations. The run that made it is already over either way:
 * nothing resumes when a person takes the wheel this late, so the value trades "still useful" against
 * "still on screen" and nothing else.
 */
export const HELP_REQUEST_TTL_MS = 10 * 60 * 1000;

export const HUMAN_HAS_CONTROL =
  "A person has control of the computer right now. Wait for them to hand it back before acting.";
export const TAKE_CONTROL_FIRST =
  "Take control before driving the computer yourself.";

/**
 * The wheel, as a state machine.
 *
 * A factory rather than a module-level `let` so a test can have its own, and so two of these cannot
 * accidentally share state. `now` is injected for the same reason: `since` is part of the published
 * state, and a test that cannot control the clock has to either skip it or match it loosely.
 */
export function createControl(
  now: () => string = () => new Date().toISOString(),
) {
  let state: ControlState = {
    holder: "bot",
    since: now(),
    requested: false,
  };
  const terminalAssistance = new Map<string, AssistanceStatus>();
  let humanAssistanceId: string | undefined;

  const remember = (
    requestId: string | undefined,
    status: AssistanceStatus,
  ) => {
    if (!requestId) return;
    terminalAssistance.delete(requestId);
    terminalAssistance.set(requestId, status);
    while (terminalAssistance.size > 128) {
      const oldest = terminalAssistance.keys().next().value;
      if (oldest === undefined) break;
      terminalAssistance.delete(oldest);
    }
  };

  const expirePending = () => {
    const current = Date.parse(now());
    if (
      state.holder === "bot" &&
      state.requested &&
      state.requestedAt &&
      current - Date.parse(state.requestedAt) > HELP_REQUEST_TTL_MS
    ) {
      remember(state.helpRequestId, "expired");
      const {
        helpRequestId: _requestId,
        reason: _reason,
        requestedAt: _at,
        ...rest
      } = state;
      state = { ...rest, requested: false };
    }
    if (
      state.holder === "bot" &&
      state.secretWanted &&
      state.secretRequestedAt &&
      current - Date.parse(state.secretRequestedAt) > HELP_REQUEST_TTL_MS
    ) {
      remember(state.secretRequestId, "expired");
      const {
        secretRequestId: _requestId,
        secretWanted: _wanted,
        secretRef: _ref,
        secretSnapshotId: _snapshotId,
        secretRequestedAt: _at,
        ...rest
      } = state;
      state = rest;
    }
  };

  const assistanceRequestId = (candidate: unknown) =>
    typeof candidate === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate,
    )
      ? candidate
      : crypto.randomUUID();

  return {
    /**
     * The current state, as the surface polls it. A copy, so a caller cannot mutate the machine.
     *
     * An unanswered request is dropped once it is older than {@link HELP_REQUEST_TTL_MS}. It is
     * expired on read rather than on a timer because there is nothing to wake: the run that asked
     * has ended, and the only thing that cares is whoever looks next.
     *
     * Only ever the ASK. A person actually holding the wheel is never timed out from under them:
     * they may be halfway through typing a code, and taking the browser back mid-sign-in is worse
     * than any stale prompt.
     */
    get(): ControlState {
      expirePending();
      return { ...state };
    },

    /**
     * The Bot asking for help.
     *
     * It does not take control: it says it is stuck and why, and a person decides. A Bot that could
     * hand itself to a human could also hand a human a page they never asked to see.
     */
    requestHelp(reason: unknown, requestId?: unknown): ControlState {
      expirePending();
      if (state.requested) remember(state.helpRequestId, "superseded");
      const id = assistanceRequestId(requestId);
      state = {
        ...state,
        requested: true,
        requestedAt: now(),
        helpRequestId: id,
        reason:
          typeof reason === "string" && reason.trim()
            ? reason.trim()
            : "The assistant needs a person to continue.",
      };
      return this.get();
    },

    /** The Bot asking for one value it must not be told, naming the field it goes in. */
    requestSecret(input: {
      label?: unknown;
      ref?: unknown;
      snapshotId?: unknown;
      requestId?: unknown;
    }): ControlState {
      expirePending();
      if (typeof input.ref !== "string" || !input.ref.trim()) {
        throw new ControlRequestError(
          "Say which field the value goes in, using a ref from your snapshot.",
        );
      }
      if (state.secretWanted) remember(state.secretRequestId, "superseded");
      const requestedAt = now();
      state = {
        ...state,
        secretWanted:
          typeof input.label === "string" && input.label.trim()
            ? input.label.trim()
            : "the value this page is asking for",
        secretRef: input.ref.trim(),
        secretSnapshotId:
          typeof input.snapshotId === "number" ? input.snapshotId : undefined,
        secretRequestId: assistanceRequestId(input.requestId),
        secretRequestedAt: requestedAt,
      };
      return this.get();
    },

    /**
     * Clear only the exact pending assistance generation while the Bot still owns the browser.
     * A stale delivery timeout is therefore harmless after a newer request or human handoff.
     */
    cancelAssistance(requestId: string): AssistanceCancellationResult {
      expirePending();
      if (humanAssistanceId === requestId) {
        return { cancelled: false, state: this.get(), status: "human" };
      }
      if (state.holder !== "bot") {
        return {
          cancelled: false,
          state: this.get(),
          status: terminalAssistance.get(requestId) ?? "unknown",
        };
      }
      if (state.helpRequestId === requestId && state.requested) {
        const {
          helpRequestId: _requestId,
          reason: _reason,
          requestedAt: _requestedAt,
          ...rest
        } = state;
        state = { ...rest, requested: false };
        remember(requestId, "cancelled");
        return { cancelled: true, state: this.get(), status: "cancelled" };
      }
      if (state.secretRequestId === requestId && state.secretWanted) {
        const {
          secretRequestId: _requestId,
          secretWanted: _wanted,
          secretRef: _ref,
          secretSnapshotId: _snapshotId,
          secretRequestedAt: _requestedAt,
          ...rest
        } = state;
        state = rest;
        remember(requestId, "cancelled");
        return { cancelled: true, state: this.get(), status: "cancelled" };
      }
      return {
        cancelled: false,
        state: this.get(),
        status: terminalAssistance.get(requestId) ?? "unknown",
      };
    },

    assistanceStatus(requestId: string): AssistanceStatus {
      expirePending();
      if (humanAssistanceId === requestId) return "human";
      if (state.requested && state.helpRequestId === requestId)
        return "pending";
      if (state.secretWanted && state.secretRequestId === requestId)
        return "pending";
      return terminalAssistance.get(requestId) ?? "unknown";
    },

    /**
     * The pending secret request, or null.
     *
     * Read before typing so the caller can refuse when nothing asked for one: this is what keeps the
     * masked box from being a general-purpose way to type into the page.
     */
    pendingSecret(): { ref: string; snapshotId?: number } | null {
      expirePending();
      if (!state.secretWanted || !state.secretRef) return null;
      return { ref: state.secretRef, snapshotId: state.secretSnapshotId };
    },

    /**
     * The secret landed, so the request is closed.
     *
     * Called only after the value reaches the field. A failure leaves the request open so the person
     * can try again.
     */
    secretSupplied(): void {
      remember(state.secretRequestId, "completed");
      state = {
        ...state,
        secretWanted: undefined,
        secretRef: undefined,
        secretSnapshotId: undefined,
        secretRequestId: undefined,
        secretRequestedAt: undefined,
      };
    },

    /**
     * A person taking the wheel.
     *
     * `reason` survives, because it is the thing they were just asked to do. Any pending secret is
     * cleared: a person with full browser control can type the password into the page, and a masked
     * box left open behind them no longer corresponds to an active request.
     */
    take(): ControlState {
      expirePending();
      if (state.holder === "bot") {
        humanAssistanceId = state.requested ? state.helpRequestId : undefined;
      }
      if (state.secretWanted) remember(state.secretRequestId, "cancelled");
      state = {
        holder: "human",
        since: now(),
        reason: state.reason,
        requested: false,
      };
      return this.get();
    },

    /**
     * A person handing back.
     *
     * `reason` is dropped: it described the thing the person was asked to do, and once they have done
     * it, leaving it set would have the surface still showing the old request. Any pending secret goes
     * with it, a person who took the whole wheel and handed it back has dealt with the login, and a
     * secret box left open afterwards is asking for a password nothing is waiting for.
     */
    release(): ControlState {
      remember(humanAssistanceId, "completed");
      humanAssistanceId = undefined;
      state = {
        holder: "bot",
        since: now(),
        requested: false,
      };
      return this.get();
    },

    /**
     * The Bot may not act while a person holds the wheel.
     *
     * Refused rather than queued. A queued click lands after the person has moved on and is worse than
     * a refusal, which the Bot can explain and wait out.
     */
    assertBotMayAct(): void {
      if (state.holder === "human") throw new ControlError(HUMAN_HAS_CONTROL);
    },

    /** Whether a person's input should be applied. The socket being open is not permission. */
    humanMayDrive(): boolean {
      return state.holder === "human";
    },
  };
}

export type Control = ReturnType<typeof createControl>;
