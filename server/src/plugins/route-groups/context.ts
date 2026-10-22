import type { Hono, MiddlewareHandler } from "hono";
import type { BotAccessCheck } from "../../agents/profile-policy";
import type { AppVariables } from "../../auth/guards";
import { BROKERED_PROFILE, type BrokerProvider } from "../access";
import type { AccountModeSwitch } from "../account-mode";
import {
  type AuthorizationFlow,
  BrokerReturnUrlError,
  brokerSentence,
  type ComposioBroker,
} from "../broker";
import { vendorSentence } from "../composio";
import type { AccountRef } from "../shared-accounts";
import type { SharedUseStore } from "../shared-use-store";
import type { PluginStore } from "../store";

/**
 * What the plugin route groups share. See `../routes.ts`, which builds one of these and mounts
 * every group on it in order.
 */

/**
 * Whether the person a consent was started for still has access to this deployment.
 *
 * A seam rather than an import, because these routes have no business knowing what a person is or
 * where the deny list lives — and because the answer has to come from the deployment as it is when
 * the callback lands, not from what was true when the flow started.
 *
 * False for somebody who was removed while they were away at the vendor's consent screen, and false
 * for a user id that names nobody at all. Both are the same refusal: there is no live person for
 * this grant to belong to.
 */
export type ConnectingPersonCheck = (userId: string) => Promise<boolean>;

/**
 * What somebody is told when the broker itself failed, and what is deliberately kept out of it.
 *
 * EVERY BROKERED ROUTE NEEDS THIS AND NONE OF THEM USED TO HAVE IT. A listing, a connect, a confirm
 * and a disconnect all end in a call to another company's API, and an unhandled rejection out of any
 * of them is a bare 500 with the vendor's thrown object on this deployment's console. That object is
 * the whole HTTP response — headers, trace ids, rate-limit counters — and the person reading the 500
 * gets none of it and no sentence either. A wrong `COMPOSIO_API_KEY` is the first failure a new
 * operator meets, and it is the one this used to answer worst.
 *
 * `vendorSentence` IS THE SAME ONE THE TRANSPORT USES, for the same reason it exists there: the
 * useful sentence — "Invalid API key", "No connected account found for user …" — is nested two
 * levels inside `cause` beside everything that must not be shown, so this reaches in for that one
 * string and takes nothing else. Null from it is a failure this deployment cannot explain, and the
 * caller's own generic sentence is what a reader gets instead of the vendor's placeholder.
 *
 * NOTHING FROM THE REQUEST OR THE ANSWER TRAVELS WITH IT. Not the API key, which never leaves the
 * adapter; not a connect link, which is a bearer capability handed to one browser; and not the
 * thrown object, whether by spreading it, stringifying it or logging it.
 *
 * 502 RATHER THAN 500, because nothing here broke: this deployment asked a third party and the third
 * party did not answer usefully, which is the same reading the dynamic-registration failure below
 * already gives.
 *
 * `./broker`'s `BrokerRefusalError` IS THE EXCEPTION, AND IT IS A WIDER ONE THAN IT WAS. It used to
 * be the one no-key state; it is now every refusal the broker layer AUTHORED — no key, an app whose
 * authorization config this deployment never created or cannot use, a consent the vendor answered
 * with nowhere to send anybody, a catalogue too large to be sure of. All of them share the property
 * that made the first one special: Composio answered, this deployment decided, and the sentence
 * already names the step that fixes it. So the message is passed through and the status stays 503,
 * which reads correctly for every one of them — the brokered surface is unavailable for this app
 * until somebody changes something here, rather than unavailable because a third party is down. The
 * generic sentence below is for failures this deployment genuinely cannot explain, and answering one
 * of these with it would tell an administrator to check a key that is fine.
 */
export function brokerRefusal(
  error: unknown,
  generic: string,
): { error: string; status: 502 | 503 } {
  const authored = brokerSentence(error);
  if (authored) return { error: authored, status: 503 };
  return { error: vendorSentence(error) ?? generic, status: 502 };
}

/**
 * A return address this deployment could not use, said once where an operator will read it.
 *
 * THE REMEDY AND THE READER HAD COME APART, WHICH IS WHAT THIS CLOSES. Both routes that check a
 * return address are `requireUser`, so the sentence they answer with reaches somebody who pressed
 * Connect — and `OPENBOT_APP_URL` is a variable they cannot set, named beside a vendor they may not
 * even be on. {@link BrokerReturnUrlError} answers them with neither now, which would leave the
 * operator's half nowhere at all if it were not written here: a misconfigured address would be
 * invisible to the one person who can correct it.
 *
 * A LOG AND NOT A RESPONSE, because that is the difference between the two readers. The log is the
 * operator's screen, and the sentence it carries is the error's own — written in `./broker`, naming
 * the ACTIVE provider, and quoting no address, which is the promise that makes it safe to write
 * down at all. Anything else thrown past this is somebody else's to explain, so it is ignored here
 * rather than logged generically.
 */
export function logReturnUrlRefusal(error: unknown, serverId: string): void {
  if (!(error instanceof BrokerReturnUrlError)) return;
  console.error(
    JSON.stringify({
      type: "broker-return-url-unusable",
      serverId,
      note: error.operatorMessage,
    }),
  );
}

/**
 * What a reader is told when the active broker would not answer with its directory.
 *
 * One function because two routes make that call — browsing the catalogue and enabling an app out of
 * it — and a reader meeting the same failure through two doors should not meet two sentences. It
 * names the setting rather than quoting it: a key that was pasted with a space in it, or one for
 * another project, is the likeliest reason the vendor will not talk to this deployment at all.
 *
 * THE VENDOR AND ITS SETTING COME OFF THE ACTIVE PROVIDER'S PROFILE, because the client shows the
 * server's sentence in preference to its own fallback: a sentence that spelled one broker was read
 * by an operator of the other.
 */
export function directoryUnavailable(provider: BrokerProvider): string {
  const { vendor, envVar } = BROKERED_PROFILE[provider];
  return `${vendor} would not answer with its app directory, and said nothing about why. Check that ${envVar} is this project's key, and check ${vendor}'s status if it persists.`;
}

/**
 * Where a browser with no session is sent when it lands on the verifier, carrying what it arrived
 * with.
 *
 * ABSOLUTE ON THE APP'S ORIGIN, for the reason {@link connectedAccountsUrlFor} is: the verifier
 * lands on the API and the sign-in screen is a page, and locally those are two different ports — a
 * relative `Location` would resolve against this server, which serves no pages at all. A deployment
 * that serves both from one origin has no `appUrl`, and relative is correct there.
 *
 * THE HANDLE TRAVELS AS ITSELF AND NOT AS A RETURN ADDRESS. A `next=` parameter holding a URL is a
 * redirect target somebody else gets a say in; this carries the one opaque value the return leg
 * arrived with, so signing back in as the same person has everything it needs to resume and nothing
 * it could be pointed elsewhere with. Encoded, because it is somebody else's id and this deployment
 * does not know what is in it.
 */
export function signInUrlFor(
  appUrl: string | undefined,
  flowId: string,
): string {
  const base = `${appUrl?.replace(/\/+$/, "") ?? ""}/sign`;
  return flowId ? `${base}?flow_id=${encodeURIComponent(flowId)}` : base;
}

/**
 * WHY THE VERIFIER REFUSED, AS AN OPAQUE CODE — and the CLOSED SET of them.
 *
 * THE CODE TRAVELS AND THE SENTENCE DOES NOT. Each of these is rendered by the connected-accounts
 * list, which holds the words; a message rendered from a query string is a message anybody can
 * author on this deployment's own origin, and the code is also what keeps the copy in ONE place
 * rather than in two that drift. The parameter is `?authorized=`, a channel of its own: `?connected=`
 * belongs to the Composio OAuth callback and is neither reused nor widened here.
 *
 * ASSERTED AS A SET so another cannot be added without a test going red, and so the app's own map
 * can be held to exactly the same list.
 */
export const AUTHORIZATION_REFUSALS = [
  // This deployment reaches no broker at all, so there is no return leg to verify.
  "no-broker",
  // The broker it reaches declares no correlated authorization flow.
  "not-supported",
  // The link arrived without the part that says which authorization it finishes.
  "missing-handle",
  // Nothing USABLE of this person's is waiting: never started, expired, another session's, a mint
  // that never answered with an id, or a row that cannot say whose account it is for.
  "no-attempt",
  // The vendor was asked and did not answer.
  "vendor-unavailable",
  // The link, or the authorization behind it, is not the one this person is holding.
  "not-your-authorization",
  // The consent has not finished at the vendor yet. The attempt is LEFT STANDING for a retry.
  "not-finished",
  // The vendor says the authorization did not complete.
  "authorization-failed",
  // The app's account context moved on while the consent was open (D28).
  "context-changed",
  // The person can no longer act on the app's account — a Shared app's administrator was demoted,
  // or the app itself stopped resolving to an account — so the consent was closed and nothing moved.
  "not-permitted",
  // The attempt was cancelled, or otherwise ended, while its return leg was being finished.
  "cancelled",
  // The same, except the grant the return carried was not withdrawn — doing so would have ended a
  // connection nobody asked to end, or the withdrawal was not confirmed — so the vendor may still
  // allow the cancelled action.
  "cancelled-left-live",
  // This deployment could not write what it had, so it wrote none of it.
  "not-recorded",
] as const;

export type AuthorizationRefusal = (typeof AUTHORIZATION_REFUSALS)[number];

/** Whether two account references name the same account, holder included. */
export function sameAccount(left: AccountRef, right: AccountRef): boolean {
  if (left.vendorUserId !== right.vendorUserId) return false;
  if (left.holder === "person") {
    return right.holder === "person" && left.userId === right.userId;
  }
  return right.holder === "deployment";
}

/**
 * A BROKER CALL THAT DID NOT ANSWER INSIDE ITS BOUND, AND CARRYING NOTHING OF THE VENDOR'S (D31).
 *
 * The message names this deployment's own bound and the thrown object has no `cause`, deliberately:
 * a call that times out on the return leg is a call whose answer would have carried a LIVE provider
 * access token and a full profile, and the one thing certain about a half-read answer is that
 * nobody has narrowed it yet. So there is nothing here to attach, log or quote — which is the same
 * promise {@link brokerRefusal} makes about the vendor's own errors, kept by having no vendor
 * material to begin with.
 *
 * It is an ordinary `Error` to every reader of it: `brokerSentence` does not author it and
 * `vendorSentence` finds no nested body, so every call site below answers it with its OWN generic
 * sentence and a 502 — "we asked and got nothing back", which is exactly what happened.
 *
 * NOT EXPORTED, because nothing outside this file should be branching on it: every exit it can
 * reach is already one of this file's own refusals, and a caller matching on the class would be
 * re-deciding what the catch blocks here have decided.
 */
class VendorTimeoutError extends Error {
  constructor(afterMs: number) {
    super(`The broker did not answer within ${afterMs}ms.`);
    this.name = "VendorTimeoutError";
  }
}

/**
 * How long ONE outbound call to the broker may take before this deployment stops waiting on it.
 *
 * EVERY CALL OUT OF THIS FILE GOES THROUGH {@link withVendorDeadline}, and that is the invariant
 * rather than the number. A bound on how MANY times something is attempted is not a bound at all
 * while each attempt is unbounded: a vendor that accepts the connection and then never writes a
 * byte holds the socket, the handler and the browser open for as long as it cares to, and no retry
 * limit, poll count or loop condition is ever reached because the first wait never ends.
 */
const VENDOR_CALL_TIMEOUT_MS = 10_000;

/**
 * The same bound on ONE return-leg status poll, and tighter because a browser is held open on it.
 *
 * Five polls at two seconds with four one-second pauses is a worst case of FOURTEEN seconds for the
 * whole wait, and that arithmetic is the point of stating both numbers here.
 */
export const STATUS_CALL_TIMEOUT_MS = 2_000;

/**
 * At most five polls, pausing BETWEEN them — so four pauses, not five. NEVER the SDK's unbounded
 * `waitForCompletion`.
 */
const STATUS_POLLS = 5;
const STATUS_PAUSE_MS = 1000;

/**
 * One outbound vendor call under a deadline, with an `AbortSignal` for the seams that take one.
 *
 * THE SIGNAL IS THE HALF THAT MATTERS UPSTREAM AND THE RACE IS THE HALF THAT MATTERS HERE. The race
 * is what lets the handler answer and the browser go; aborting is what stops this deployment from
 * holding a socket open against a vendor it has already given up on, and the seams that can carry
 * a signal take it (see {@link AuthorizationFlow}). A seam that cannot is still bounded by the
 * race — a timeout is a timeout to the person waiting either way — and its call is simply
 * abandoned rather than cancelled.
 *
 * THE TIMER IS CLEARED ON BOTH OUTCOMES. A pending timer on a call that answered in time would keep
 * an event loop alive for the rest of the bound, which in a test run is a suite that will not exit
 * and in a deployment is a handler that has returned still holding a reason not to.
 *
 * NOTHING IS RETRIED HERE. A deadline that retried would be the very shape this fix exists to
 * remove, one layer up.
 */
export function withVendorDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  afterMs: number = VENDOR_CALL_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new VendorTimeoutError(afterMs));
    }, afterMs);
  });
  /*
   * A CALL THAT THROWS BEFORE IT RETURNS A PROMISE IS A REJECTION, NOT AN ESCAPE. The deadline is
   * already armed by this line, so invoking `call` bare inside the race would let a synchronous
   * throw — `brokerReturnUrl` refusing a scheme-less `OPENBOT_APP_URL` while the callback builds its
   * argument is the one that happens — leave this function before the race and its `.finally`
   * exist: the timer stays armed, aborts nothing anybody is waiting on and rejects `deadline` with
   * no one subscribed, and a caller's `.catch(...)` on the returned promise is skipped entirely.
   * Calling it inside an executor turns that throw into this promise's rejection, still
   * synchronously and still exactly once.
   */
  const answer = new Promise<T>((resolve) => resolve(call(controller.signal)));
  /*
   * `Promise.race` subscribes to both, so a call that answers AFTER the deadline has its rejection
   * observed here and never surfaces as an unhandled one. Its answer is dropped unread, which is
   * also the D31-safe thing to do with it.
   */
  return Promise.race([answer, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Where one authorization has got to, waited for with a BOUND ON THE WHOLE WAIT AND ON EACH CALL.
 *
 * `pending` is the only state worth asking again about, and five polls at two seconds each with a
 * one-second pause between them — at most fourteen seconds, and the pauses are BETWEEN the polls,
 * so four of them and not five — is the whole of the patience this has. A timeout is neither a
 * success nor a failure, so what comes back is the last answer read and the caller decides; nothing
 * here writes, retries forever or blocks a browser on a vendor that has stopped answering.
 *
 * THE POLL COUNT ALONE NEVER BOUNDED ANYTHING. It bounded how many times `flow.status` was CALLED,
 * while each call waited as long as the vendor liked — so a vendor that accepted the connection and
 * never answered held this request open forever, which is the one case the paragraph above claims
 * to prevent. {@link withVendorDeadline} is what makes the claim true, and a poll that spends its
 * own bound THROWS rather than counting: a vendor that will not answer in two seconds is a vendor
 * that is not answering, and the caller's `vendor-unavailable` refusal leaves the attempt row
 * standing exactly as the exhausted-polls refusal does.
 *
 * WHAT COMES BACK IS THE SEAM'S THREE FIELDS AND NOTHING MORE (D31). The vendor's own status reply
 * carries a live provider access token and the person's full profile; the adapter drops them, and
 * this function must never widen what it hands on, log it, or attach it as a `cause`.
 */
export async function settledStatus(
  flow: AuthorizationFlow,
  id: string,
): Promise<Awaited<ReturnType<AuthorizationFlow["status"]>>> {
  const poll = () =>
    withVendorDeadline(
      (signal) => flow.status(id, { signal }),
      STATUS_CALL_TIMEOUT_MS,
    );
  let answer = await poll();
  for (
    let polls = 1;
    polls < STATUS_POLLS && answer.status === "pending";
    polls += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, STATUS_PAUSE_MS));
    answer = await poll();
  }
  return answer;
}

/** What the connect flow needs that the store does not hold. See `createPluginRoutes`. */
export type PluginConnectOptions = {
  encryptionKey: string;
  /**
   * Whether the person a state names may still connect an account here.
   *
   * Required rather than optional, unlike everything else that arrived on this object as "one more
   * parameter". The callback is sessionless on purpose, so this is the ONLY thing asking whether
   * the identity in the state is still one this deployment recognises — and a deployment that
   * forgot to pass it would complete a consent for somebody who was removed ten minutes ago and
   * write a live refresh token nothing will ever revoke.
   */
  personHasAccess: ConnectingPersonCheck;
  /**
   * Whether this deployment holds a shared secret a Bot may present when calling a tool back.
   *
   * A boolean about configuration, never the secret. Without it, a Bot can only call back if it
   * holds a credential issued to it alone, and a Bot with neither is refused before the call ever
   * reaches the grant, the boundary or the trail. The Bots screen needs this to stop promising a
   * grant the deployment cannot honour.
   */
  botsMayCallBack?: boolean;
  publicUrl: string | undefined;
  /**
   * Where the app is, which is not where this API is.
   *
   * The callback lands here and has to send the person back to a page. A relative redirect would
   * put them on this server's origin, which locally is a Vite-less port that serves no pages at
   * all — so the flow would complete correctly and end on a 404.
   */
  appUrl: string | undefined;
};

/**
 * Everything a group of plugin routes is mounted with: the router they are added to, what
 * `createPluginRoutes` was given, and the per-request helpers more than one group asks.
 */
export type PluginRouteContext = {
  routes: Hono<{ Variables: AppVariables }>;
  store: PluginStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  connect: PluginConnectOptions | undefined;
  composio: { broker: ComposioBroker; provider: BrokerProvider } | undefined;
  shared: { modes: AccountModeSwitch; use: SharedUseStore } | undefined;
  /** The provider this deployment's brokered rows belong to. See `createPluginRoutes`. */
  activeProvider: BrokerProvider;
  /** {@link activeProvider}'s name as the sentences on this layer spell it. */
  activeVendor: string;
  /** Which app a brokered row is, read by {@link activeProvider}'s own parser. */
  appOfUrl: (url: string) => string | null;
  actorEmail: (context: { var: AppVariables }) => string;
  skillActor: (context: { var: AppVariables }) => {
    id: string;
    isAdmin: boolean;
  };
  skillRefusal: (
    context: { var: AppVariables },
    slug: string,
  ) => Promise<string | null>;
};
