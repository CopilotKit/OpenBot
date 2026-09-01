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
export const CONTROL_ALREADY_HELD =
  "Another person already has control of this computer.";
export const CONTROL_LEASE_REQUIRED =
  "This control lease is missing, expired, or belongs to another session.";

const LEASE_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

function sameLease(left: string | undefined, right: string | undefined) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

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
  // A bearer capability held only by the browser session that took control. Never returned by get().
  let humanLease: string | undefined;
  let humanLeaseUntil = 0;

  const expireHumanLease = () => {
    if (state.holder !== "human") return;
    const current = now();
    if (Date.parse(current) < humanLeaseUntil) return;
    humanLease = undefined;
    humanLeaseUntil = 0;
    state = { holder: "bot", since: current, requested: false };
  };

  const checkedLease = (lease: unknown, expiresAt: unknown) => {
    const current = Date.parse(now());
    const expiry =
      typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    if (
      typeof lease !== "string" ||
      !LEASE_TOKEN.test(lease) ||
      !Number.isFinite(expiry) ||
      expiry <= current
    ) {
      throw new ControlRequestError(CONTROL_LEASE_REQUIRED);
    }
    return { lease, expiry };
  };

  return {
    /**
     * The current state, as the surface polls it. A copy, so a caller cannot mutate the machine.
     *
     * An unanswered request is dropped once it is older than {@link HELP_REQUEST_TTL_MS}. It is
     * expired on read rather than on a timer because there is nothing to wake: the run that asked
     * has ended, and the only thing that cares is whoever looks next.
     *
     * The human lease is short-lived and renewed by the browser that took control. That keeps a
     * closed or abandoned tab from locking the computer indefinitely without taking control away
     * from an active person midway through a login.
     */
    get(): ControlState {
      expireHumanLease();
      if (
        state.requested &&
        state.holder === "bot" &&
        state.requestedAt &&
        Date.parse(now()) - Date.parse(state.requestedAt) > HELP_REQUEST_TTL_MS
      ) {
        const { reason: _reason, requestedAt: _at, ...rest } = state;
        state = { ...rest, requested: false };
      }
      return { ...state };
    },

    /**
     * The Bot asking for help.
     *
     * It does not take control: it says it is stuck and why, and a person decides. A Bot that could
     * hand itself to a human could also hand a human a page they never asked to see.
     */
    requestHelp(reason: unknown): ControlState {
      state = {
        ...state,
        requested: true,
        requestedAt: now(),
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
    }): ControlState {
      if (typeof input.ref !== "string" || !input.ref.trim()) {
        throw new ControlRequestError(
          "Say which field the value goes in, using a ref from your snapshot.",
        );
      }
      state = {
        ...state,
        secretWanted:
          typeof input.label === "string" && input.label.trim()
            ? input.label.trim()
            : "the value this page is asking for",
        secretRef: input.ref.trim(),
        secretSnapshotId:
          typeof input.snapshotId === "number" ? input.snapshotId : undefined,
      };
      return this.get();
    },

    /**
     * The pending secret request, or null.
     *
     * Read before typing so the caller can refuse when nothing asked for one: this is what keeps the
     * masked box from being a general-purpose way to type into the page.
     */
    pendingSecret(): { ref: string; snapshotId?: number } | null {
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
      state = {
        ...state,
        secretWanted: undefined,
        secretRef: undefined,
        secretSnapshotId: undefined,
      };
    },

    /**
     * A person taking the wheel.
     *
     * `reason` survives, because it is the thing they were just asked to do. Any pending secret is
     * cleared: a person with full browser control can type the password into the page, and a masked
     * box left open behind them no longer corresponds to an active request.
     */
    take(lease: unknown, expiresAt: unknown): ControlState {
      expireHumanLease();
      const checked = checkedLease(lease, expiresAt);
      if (state.holder === "human" && !sameLease(humanLease, checked.lease)) {
        throw new ControlError(CONTROL_ALREADY_HELD);
      }
      humanLease = checked.lease;
      humanLeaseUntil = checked.expiry;
      state = {
        holder: "human",
        since: now(),
        reason: state.reason,
        requested: false,
      };
      return this.get();
    },

    /** Keep an active browser session's capability alive without changing when it took the wheel. */
    renew(lease: unknown, expiresAt: unknown): ControlState {
      expireHumanLease();
      const checked = checkedLease(lease, expiresAt);
      if (state.holder !== "human" || !sameLease(humanLease, checked.lease)) {
        throw new ControlError(CONTROL_LEASE_REQUIRED);
      }
      humanLeaseUntil = checked.expiry;
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
    release(lease: unknown): ControlState {
      expireHumanLease();
      if (state.holder === "human" && !sameLease(humanLease, String(lease))) {
        throw new ControlError(CONTROL_LEASE_REQUIRED);
      }
      humanLease = undefined;
      humanLeaseUntil = 0;
      state = {
        holder: "bot",
        since: now(),
        requested: false,
      };
      return this.get();
    },

    /**
     * The controlled browser ceased to exist, so invalidate every human capability for it.
     *
     * This is intentionally not exposed on the network. Stop/reset already require an authorized
     * server call and destroy the resource the lease names; requiring a now-useless browser token
     * would leave the replacement browser permanently owned by a dead session.
     */
    revoke(): ControlState {
      humanLease = undefined;
      humanLeaseUntil = 0;
      state = { holder: "bot", since: now(), requested: false };
      return this.get();
    },

    /**
     * The Bot may not act while a person holds the wheel.
     *
     * Refused rather than queued. A queued click lands after the person has moved on and is worse than
     * a refusal, which the Bot can explain and wait out.
     */
    assertBotMayAct(): void {
      // A vanished browser cannot keep the Bot blocked. No polling tab remains to call `get()`, so
      // the first Bot action after expiry must perform the same lease check itself.
      expireHumanLease();
      if (state.holder === "human") throw new ControlError(HUMAN_HAS_CONTROL);
    },

    /** Whether a person's input should be applied. The socket being open is not permission. */
    humanMayDrive(lease: string | undefined): boolean {
      expireHumanLease();
      return state.holder === "human" && sameLease(humanLease, lease);
    },
  };
}

export type Control = ReturnType<typeof createControl>;
