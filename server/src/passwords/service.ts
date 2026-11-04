import { randomUUID } from "node:crypto";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { ActionActor, ComputerGateway } from "../computer/gateway";
import type { SignInCodeResult, SignInFillResult } from "../computer/schema";
import { decryptSecret, encryptSecret } from "../credentials";
import {
  originOf,
  type PasswordStore,
  type SavedLoginView,
  type SignInMethod,
  SignInRefusedError,
  type SignInRequestRecord,
  type SignInRequestView,
  type SignInStatus,
} from "./types";

/**
 * The private sign-in request and the Passwords vault.
 *
 * A Bot calls `computer_request_sign_in` with a site. That opens a request here and nothing else: the
 * Bot learns a request id, the person is sent to a form that is not part of the conversation, and the
 * turn waits. The form answers one of four ways:
 *
 *  - typed: a username and password go from the form to this service to the Bot's computer, which
 *    types them into the page itself;
 *  - saved: the person picks one of their saved logins for exactly this site. Choosing it in the form
 *    IS the confirmation Dot requires for using a saved login on a new sign-in: nothing here fills a
 *    saved login without that request from its owner;
 *  - takeover: the person takes the Bot's browser and signs in by hand;
 *  - cancel.
 *
 * A verification code is never asked for up front. When the site, having taken the password, shows a
 * one-time-code field, the request moves to `code_required` and the form asks for the code the site
 * just sent; `submitCode` has the computer type it into the page that is waiting. A wrong code keeps
 * the request there, and an unanswered one expires like any other request.
 *
 * Whatever happens, the Bot is told the outcome and never the credential. The audit rows say which
 * site, which request and how it was answered; they carry no username, password or code.
 */
export type SignInService = ReturnType<typeof createSignInService>;

export type SignInServiceDependencies = {
  store: PasswordStore;
  gateway: Pick<
    ComputerGateway,
    "signIn" | "signInCode" | "requestHelp" | "seatFor"
  >;
  /** The deployment's KEY_ENCRYPTION_KEY, the same one `credentials.ts` encrypts under. */
  encryptionKey: string;
  auditStore?: AuditStore;
  /**
   * The administrator's "password manager" switch, asked on every use. Absent means on.
   *
   * The admin capability toggles are a separate module; this is the seam they wire: when it answers
   * false, saved logins are neither offered nor saved, and the private form still works for typing a
   * login once.
   */
  passwordManagerEnabled?: (ownerUserId: string) => Promise<boolean>;
  /** Tell the owner there is a sign-in waiting, on their delivery channels. */
  notify?: (request: SignInRequestRecord) => Promise<void>;
  /** A request reached a final state. Resumes an unattended turn that was waiting on it. */
  onResolved?: (request: SignInRequestRecord) => Promise<void>;
  /** How long a request stays open. */
  ttlMs?: number;
};

const DEFAULT_TTL_MS = 15 * 60_000;
const OPEN: readonly SignInStatus[] = [
  "pending",
  "code_required",
  "taken_over",
];
/**
 * How long one attempt may hold a request in `filling`. Past the computer's own sign-in backstop
 * (75s), so a live attempt is never reopened under itself; a server that died mid-fill leaves the
 * request this long and no longer.
 */
const FILLING_LEASE_MS = 120_000;
const FINAL: readonly SignInStatus[] = [
  "signed_in",
  "failed",
  "cancelled",
  "expired",
];

export function isFinalSignIn(status: SignInStatus) {
  return FINAL.includes(status);
}

/**
 * What the Bot is told when a request ends. The only thing about a sign-in that reaches a model.
 */
export function signInToolResult(request: SignInRequestRecord) {
  const signedIn = request.status === "signed_in";
  return {
    ok: signedIn,
    signedIn,
    site: request.origin,
    status: request.status,
    ...(request.method ? { method: METHOD_WORDS[request.method] } : {}),
    result:
      request.outcome ??
      (signedIn
        ? `Signed in to ${request.origin}.`
        : `The sign-in to ${request.origin} did not complete.`),
    note: "You were not told the credentials and must never ask for them another way.",
  };
}

const METHOD_WORDS: Record<SignInMethod, string> = {
  typed: "the person entered a login in a private form",
  saved: "the person confirmed one of their saved logins",
  takeover: "the person took over the browser and signed in themselves",
};

/**
 * A string with every credential it could contain removed.
 *
 * Belt and braces: nothing on the fill path is supposed to echo a value, but an error message from a
 * page or a browser is not something this module wrote, and it is about to be stored and shown.
 */
function scrub(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets)
    if (secret && secret.length >= 3) out = out.split(secret).join("[hidden]");
  return out.slice(0, 500);
}

export function createSignInService(deps: SignInServiceDependencies) {
  const { store, gateway, auditStore } = deps;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const managerOn = async (owner: string) =>
    deps.passwordManagerEnabled ? deps.passwordManagerEnabled(owner) : true;

  async function audit(
    eventType:
      | "computer.sign_in_requested"
      | "computer.sign_in_code_requested"
      | "computer.sign_in_completed"
      | "computer.sign_in_failed"
      | "computer.sign_in_cancelled"
      | "password.saved"
      | "password.deleted",
    actor: ActionActor,
    targetType: "computer" | "password",
    targetId: string,
    payload: Record<string, unknown>,
  ) {
    if (!auditStore) return;
    await recordAuditEvent(auditStore, {
      eventType,
      targetType,
      targetId,
      initiator: actor.initiator,
      ...(actor.userId ? { actorUserId: actor.userId } : {}),
      payload: { actor: actor.id, ...payload },
    });
  }

  /** The request, with an expired one closed on the way past. */
  async function load(owner: string, id: string) {
    const request = await store.request(owner, id);
    if (!request)
      throw new SignInRefusedError("There is no such sign-in request.", 404);
    if (
      request.status === "filling" &&
      request.fillingUntil !== null &&
      request.fillingUntil <= new Date()
    ) {
      // `method` is set once the site has taken the password, so an attempt abandoned while typing
      // the code goes back to asking for the code, not for the whole login again.
      const codeStep = request.method !== null;
      const reopened = await store.transition(owner, id, ["filling"], {
        status: codeStep ? "code_required" : "pending",
        fillingUntil: null,
        outcome: codeStep
          ? "The last attempt to enter the code did not finish. Try again."
          : "The last sign-in attempt did not finish. Try again.",
      });
      if (reopened) return load(owner, id);
      return (await store.request(owner, id)) ?? request;
    }
    if (OPEN.includes(request.status) && request.expiresAt <= new Date()) {
      const expired = await store.transition(owner, id, OPEN, {
        status: "expired",
        outcome:
          request.status === "code_required"
            ? `Nobody entered the verification code for ${request.origin} before the request expired. Do not ask for the login or the code another way.`
            : `Nobody signed in to ${request.origin} before the request expired. Do not ask for the login another way.`,
        resolvedAt: new Date(),
      });
      if (expired) {
        await resolved(expired);
        return expired;
      }
      return (await store.request(owner, id)) ?? request;
    }
    return request;
  }

  async function resolved(request: SignInRequestRecord) {
    if (!deps.onResolved) return;
    try {
      await deps.onResolved(request);
    } catch (error) {
      // The outcome is recorded either way; a turn that could not be resumed is reported, not hidden.
      console.error(
        JSON.stringify({
          type: "sign-in-resume-failed",
          request: request.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function view(
    request: SignInRequestRecord,
  ): Promise<SignInRequestView> {
    const passwordManager = await managerOn(request.ownerUserId);
    const logins = passwordManager
      ? await store.logins(request.ownerUserId, request.origin)
      : [];
    const {
      continuation: _continuation,
      ownerUserId: _owner,
      ...rest
    } = request;
    return {
      ...rest,
      passwordManager,
      savedLogins: logins.map((login) => ({
        id: login.id,
        username: login.username,
      })),
    };
  }

  /**
   * Save a typed login the site has accepted. Never a code: a verification code is good once.
   *
   * Called after the request has already moved on, so a save that fails is reported with `whenFailed`
   * and a 409, and never leaves the request stuck.
   */
  async function saveTyped(
    actor: ActionActor,
    owner: string,
    id: string,
    origin: string,
    username: string,
    password: string,
    whenFailed: string,
  ) {
    try {
      const saved = await store.saveLogin({
        ownerUserId: owner,
        origin,
        username,
        encryptedPassword: await encryptSecret(deps.encryptionKey, password),
      });
      await audit("password.saved", actor, "password", saved.id, {
        site: origin,
        login: saved.id,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "password-save-failed",
          request: id,
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      throw new SignInRefusedError(whenFailed, 409);
    }
  }

  /**
   * Type the verification code a site asked for, and record how it went.
   *
   * Only from `code_required`. The code lives in this function's arguments and the one request to
   * the computer, as a password does in `fill`.
   */
  async function enterCode(
    owner: string,
    id: string,
    actor: ActionActor,
    code: string,
  ): Promise<SignInRequestRecord> {
    const request = await load(owner, id);
    if (request.status !== "code_required")
      throw new SignInRefusedError(
        request.status === "filling"
          ? "This sign-in is already being entered."
          : request.status === "pending" || request.status === "taken_over"
            ? "The site is not asking for a verification code."
            : "This sign-in request is no longer open.",
        409,
      );
    const claimed = await store.transition(owner, id, ["code_required"], {
      status: "filling",
      fillingUntil: new Date(Date.now() + FILLING_LEASE_MS),
    });
    if (!claimed)
      throw new SignInRefusedError(
        "This sign-in is already being entered.",
        409,
      );
    let result: SignInCodeResult | undefined;
    let failure: string | undefined;
    // Where a failure leaves the request: asking for the code again, unless the site fell back to
    // its login page, when only the whole login again can help.
    let back: "code_required" | "pending" = "code_required";
    try {
      result = await gateway.signInCode(
        await gateway.seatFor(claimed.botId, claimed.ownerUserId),
        {
          origin: claimed.origin,
          code,
        },
      );
      if (result.error) failure = scrub(result.error, [code]);
      else if (!result.submitted)
        failure = "The verification code could not be submitted.";
      else if (result.passwordFieldVisible) {
        back = "pending";
        failure =
          "The site went back to its sign-in page, so the code did not finish signing in. Enter the login again.";
      } else if (result.codeFieldVisible)
        failure =
          "The site did not accept that code. Check it, or ask the site for a new one, and try again.";
    } catch (error) {
      failure = scrub(
        error instanceof Error
          ? error.message
          : "The Bot's computer did not respond.",
        [code],
      );
    }
    if (failure) {
      const reopened = await store.transition(owner, id, ["filling"], {
        status: back,
        fillingUntil: null,
        outcome: failure,
        ...(back === "pending" ? { method: null } : {}),
      });
      await audit("computer.sign_in_failed", actor, "computer", claimed.botId, {
        bot: claimed.botId,
        request: id,
        site: claimed.origin,
        ...(claimed.method ? { method: claimed.method } : {}),
        step: "code",
        failure,
      });
      throw new SignInRefusedError(failure, reopened ? 409 : 400);
    }
    const page = result?.url ? scrub(result.url, [code]) : undefined;
    const done = await store.transition(owner, id, ["filling"], {
      status: "signed_in",
      fillingUntil: null,
      outcome: `Signed in to ${claimed.origin}${page ? `; the page is now ${page}` : ""}.`,
      resolvedAt: new Date(),
    });
    if (!done)
      throw new Error(
        "The sign-in request changed while it was being entered.",
      );
    await audit("computer.sign_in_completed", actor, "computer", done.botId, {
      bot: done.botId,
      request: id,
      site: done.origin,
      ...(done.method ? { method: done.method } : {}),
      verificationCode: true,
    });
    await resolved(done);
    return done;
  }

  /**
   * Type a login into the Bot's browser, and record how it went.
   *
   * The credential lives in this function's arguments and the one request to the computer. It is not
   * put on the row, the audit payload, the outcome or any thrown error.
   */
  async function fill(
    owner: string,
    id: string,
    actor: ActionActor,
    credential: { username?: string; password: string },
    method: "typed" | "saved",
    extra: { loginId?: string; save?: boolean },
  ): Promise<SignInRequestRecord> {
    const request = await load(owner, id);
    if (request.status !== "pending")
      throw new SignInRefusedError(
        request.status === "filling"
          ? "This sign-in is already being entered."
          : "This sign-in request is no longer open.",
        409,
      );
    // Refused before anything is typed: discovering this after the site accepted the login left the
    // request in `filling` for good.
    const saving =
      method === "typed" && extra.save === true && !!credential.username;
    if (saving && !(await managerOn(owner)))
      throw new SignInRefusedError(
        "Saving passwords is turned off for this workspace.",
        403,
      );
    const claimed = await store.transition(owner, id, ["pending"], {
      status: "filling",
      fillingUntil: new Date(Date.now() + FILLING_LEASE_MS),
    });
    if (!claimed)
      throw new SignInRefusedError(
        "This sign-in is already being entered.",
        409,
      );
    const secrets = [credential.password, credential.username];
    let result: SignInFillResult | undefined;
    let failure: string | undefined;
    try {
      result = await gateway.signIn(
        await gateway.seatFor(claimed.botId, claimed.ownerUserId),
        {
          origin: claimed.origin,
          ...(credential.username ? { username: credential.username } : {}),
          password: credential.password,
        },
      );
      if (result.error) failure = scrub(result.error, secrets);
      else if (!result.submitted)
        failure = "The sign-in form could not be submitted.";
      else if (result.passwordFieldVisible)
        failure =
          "The site still shows a password field, so the login was probably not accepted.";
    } catch (error) {
      failure = scrub(
        error instanceof Error
          ? error.message
          : "The Bot's computer did not respond.",
        secrets,
      );
    }
    const page = result?.url ? scrub(result.url, secrets) : undefined;
    if (failure) {
      // Back to pending, so the person can correct a mistyped password. The Bot keeps waiting.
      const reopened = await store.transition(owner, id, ["filling"], {
        status: "pending",
        fillingUntil: null,
        outcome: failure,
      });
      await audit("computer.sign_in_failed", actor, "computer", claimed.botId, {
        bot: claimed.botId,
        request: id,
        site: claimed.origin,
        method,
        step: "login",
        ...(extra.loginId ? { savedLogin: extra.loginId } : {}),
        failure,
      });
      throw new SignInRefusedError(failure, reopened ? 409 : 400);
    }
    if (method === "saved" && extra.loginId)
      await store.touchLogin(owner, extra.loginId);
    if (result?.codeRequested) {
      /*
       * The site took the password and sent a code. Nothing is final and the Bot is told nothing: the
       * request waits for the person to enter the code the site just sent. `method` is recorded now,
       * which is also how an abandoned code attempt knows to reopen at the code step.
       */
      const waiting = await store.transition(owner, id, ["filling"], {
        status: "code_required",
        method,
        fillingUntil: null,
        outcome: null,
      });
      if (!waiting)
        throw new Error(
          "The sign-in request changed while it was being entered.",
        );
      await audit(
        "computer.sign_in_code_requested",
        actor,
        "computer",
        waiting.botId,
        {
          bot: waiting.botId,
          request: id,
          site: waiting.origin,
          method,
          ...(extra.loginId ? { savedLogin: extra.loginId } : {}),
        },
      );
      // The password was accepted, so it is saved now, while it is still in hand. Never the code.
      if (saving && credential.username)
        await saveTyped(
          actor,
          owner,
          id,
          waiting.origin,
          credential.username,
          credential.password,
          "The site accepted the password, but the login could not be saved. Enter the code to finish, then save it again from Passwords.",
        );
      return waiting;
    }
    /*
     * Signed in is recorded, and the Bot told, BEFORE the optional save. The site accepted the login
     * either way; a save that fails afterwards must not leave the request stuck in `filling` with the
     * turn waiting on it.
     */
    const done = await store.transition(owner, id, ["filling"], {
      status: "signed_in",
      method,
      fillingUntil: null,
      outcome: `Signed in to ${claimed.origin}${page ? `; the page is now ${page}` : ""}.`,
      resolvedAt: new Date(),
    });
    if (!done)
      throw new Error(
        "The sign-in request changed while it was being entered.",
      );
    await audit("computer.sign_in_completed", actor, "computer", done.botId, {
      bot: done.botId,
      request: id,
      site: done.origin,
      method,
      ...(extra.loginId ? { savedLogin: extra.loginId } : {}),
    });
    await resolved(done);
    if (saving && credential.username)
      await saveTyped(
        actor,
        owner,
        id,
        claimed.origin,
        credential.username,
        credential.password,
        "You are signed in, but the login could not be saved. Save it again from Passwords.",
      );
    return done;
  }

  return {
    /** A Bot asking. Returns the record; the caller decides how the turn waits on it. */
    async request(input: {
      ownerUserId: string;
      botId: string;
      site: string;
      reason?: string;
      actor: ActionActor;
      threadId?: string;
      toolCallId?: string;
      continuation?: Record<string, unknown>;
      /** Send it to the owner's delivery channels. Unattended turns do; the open chat need not. */
      notify?: boolean;
    }): Promise<SignInRequestRecord> {
      const origin = originOf(input.site);
      const request = await store.createRequest({
        id: randomUUID(),
        ownerUserId: input.ownerUserId,
        botId: input.botId,
        origin,
        reason: input.reason?.trim().slice(0, 500) || null,
        threadId: input.threadId ?? null,
        toolCallId: input.toolCallId ?? null,
        continuation: input.continuation ?? null,
        expiresAt: new Date(Date.now() + ttlMs),
      });
      await audit(
        "computer.sign_in_requested",
        input.actor,
        "computer",
        input.botId,
        {
          bot: input.botId,
          request: request.id,
          site: origin,
          ...(request.reason ? { reason: request.reason } : {}),
        },
      );
      if (input.notify && deps.notify) {
        try {
          await deps.notify(request);
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "sign-in-notify-failed",
              request: request.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      return request;
    },

    async get(owner: string, id: string) {
      return view(await load(owner, id));
    },

    /** The raw record, for the resume path. Never returned by a route. */
    record: load,

    async pending(owner: string) {
      return Promise.all((await store.pendingRequests(owner)).map(view));
    },

    async submit(
      owner: string,
      id: string,
      actor: ActionActor,
      input: {
        username?: string;
        password: string;
        save?: boolean;
      },
    ) {
      if (!input.password)
        throw new SignInRefusedError("Enter the password for this site.");
      return view(
        await fill(owner, id, actor, input, "typed", {
          save: input.save === true,
        }),
      );
    },

    /** The verification code the site sent, once the request is `code_required`. */
    async submitCode(
      owner: string,
      id: string,
      actor: ActionActor,
      input: { code: string },
    ) {
      const code = input.code?.trim();
      if (!code)
        throw new SignInRefusedError(
          "Enter the verification code the site sent.",
        );
      return view(await enterCode(owner, id, actor, code));
    },

    /** The person confirming one of their saved logins for this sign-in. */
    async useSaved(
      owner: string,
      id: string,
      actor: ActionActor,
      input: { loginId: string },
    ) {
      if (!(await managerOn(owner)))
        throw new SignInRefusedError(
          "Saved passwords are turned off for this workspace.",
          403,
        );
      const request = await load(owner, id);
      const login = await store.login(owner, input.loginId);
      // Exactly this origin. A login saved for one site is never offered to, or typed into, another.
      if (!login || login.origin !== request.origin)
        throw new SignInRefusedError(
          "That saved login is not for this site.",
          404,
        );
      const password = await decryptSecret(
        deps.encryptionKey,
        login.encryptedPassword,
      );
      return view(
        await fill(
          owner,
          id,
          actor,
          { username: login.username, password },
          "saved",
          { loginId: login.id },
        ),
      );
    },

    /** Sign in by hand instead: hand the person the Bot's browser. */
    async takeOver(owner: string, id: string, actor: ActionActor) {
      const request = await load(owner, id);
      // From the code step too: a person may rather type the code into the site themselves.
      const from: readonly SignInStatus[] = ["pending", "code_required"];
      if (!from.includes(request.status))
        throw new SignInRefusedError(
          "This sign-in request is no longer open.",
          409,
        );
      const state = await gateway.requestHelp(
        // The person the sign-in is for, whose computer the Bot is on.
        await gateway.seatFor(request.botId, request.ownerUserId),
        actor,
        `Sign in to ${request.origin}${request.reason ? `: ${request.reason}` : ""}`,
        request.toolCallId ?? undefined,
      );
      const next = await store.transition(owner, id, from, {
        status: "taken_over",
        controlRequestId: state.request?.id ?? null,
      });
      if (!next)
        throw new SignInRefusedError(
          "This sign-in request is no longer open.",
          409,
        );
      return view(next);
    },

    /** After a takeover: the person says they are signed in. */
    async finishTakeover(owner: string, id: string, actor: ActionActor) {
      const done = await store.transition(owner, id, ["taken_over"], {
        status: "signed_in",
        method: "takeover",
        outcome:
          "The person signed in by hand. Take a fresh snapshot before acting on the page.",
        resolvedAt: new Date(),
      });
      if (!done)
        throw new SignInRefusedError(
          "Take over the browser before finishing.",
          409,
        );
      await audit("computer.sign_in_completed", actor, "computer", done.botId, {
        bot: done.botId,
        request: id,
        site: done.origin,
        method: "takeover",
      });
      await resolved(done);
      return view(done);
    },

    async cancel(owner: string, id: string, actor: ActionActor) {
      const current = await load(owner, id);
      const done = await store.transition(owner, id, OPEN, {
        status: "cancelled",
        outcome: `The person chose not to sign in to ${current.origin}. Do not ask for the login another way.`,
        resolvedAt: new Date(),
      });
      if (!done)
        throw new SignInRefusedError(
          "This sign-in request is no longer open.",
          409,
        );
      await audit("computer.sign_in_cancelled", actor, "computer", done.botId, {
        bot: done.botId,
        request: id,
        site: done.origin,
      });
      await resolved(done);
      return view(done);
    },

    async logins(owner: string): Promise<{
      passwordManager: boolean;
      logins: SavedLoginView[];
    }> {
      const passwordManager = await managerOn(owner);
      const rows = await store.logins(owner);
      return {
        passwordManager,
        logins: rows.map(
          ({ encryptedPassword: _secret, ownerUserId: _owner, ...rest }) =>
            rest,
        ),
      };
    },

    async deleteLogin(owner: string, id: string, actor: ActionActor) {
      const login = await store.login(owner, id);
      if (!login || !(await store.deleteLogin(owner, id)))
        throw new SignInRefusedError("There is no such saved login.", 404);
      await audit("password.deleted", actor, "password", id, {
        site: login.origin,
        login: id,
      });
      return { deleted: true };
    },
  };
}
