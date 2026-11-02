/**
 * The bound on an outbound call to a connected-app broker, Composio or Arcade.
 *
 * HERE, BELOW BOTH THE ROUTES AND THE STORE, so the store can use the bound the routes use. It
 * lived in the routes' context, and the store's vendor call that decides which card a Bot's refused
 * call shows (`isConnected` in `plugin-store/calls.ts`) had none: a broker that accepted the
 * connection and never answered held the Bot's run open with it.
 */

/**
 * A BROKER CALL THAT DID NOT ANSWER INSIDE ITS BOUND, AND CARRYING NOTHING OF THE VENDOR'S (D31).
 *
 * The message names this deployment's own bound and the thrown object has no `cause`, deliberately:
 * a call that times out on the return leg is a call whose answer would have carried a LIVE provider
 * access token and a full profile, and the one thing certain about a half-read answer is that
 * nobody has narrowed it yet. So there is nothing here to attach, log or quote, which is the same
 * promise {@link brokerRefusal} makes about the vendor's own errors, kept by having no vendor
 * material to begin with.
 *
 * It is an ordinary `Error` to every reader of it: `brokerSentence` does not author it and
 * `vendorSentence` finds no nested body, so every route answers it with its OWN generic sentence and
 * a 502: "we asked and got nothing back", which is exactly what happened.
 *
 * NOT EXPORTED, because nothing should be branching on it: every exit it can reach is already one
 * of its caller's own refusals, and a caller matching on the class would be re-deciding what those
 * catch blocks have decided.
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
 * EVERY CALL OUT OF THE ROUTES GOES THROUGH {@link withVendorDeadline}, and that is the invariant
 * rather than the number. A bound on how MANY times something is attempted is not a bound at all
 * while each attempt is unbounded: a vendor that accepts the connection and then never writes a
 * byte holds the socket, the handler and the browser open for as long as it cares to, and no retry
 * limit, poll count or loop condition is ever reached because the first wait never ends.
 */
const VENDOR_CALL_TIMEOUT_MS = 10_000;

/**
 * One outbound vendor call under a deadline, with an `AbortSignal` for the seams that take one.
 *
 * THE SIGNAL IS THE HALF THAT MATTERS UPSTREAM AND THE RACE IS THE HALF THAT MATTERS HERE. The race
 * is what lets the handler answer and the browser go; aborting is what stops this deployment from
 * holding a socket open against a vendor it has already given up on, and the seams that can carry
 * a signal take it (see {@link AuthorizationFlow}). A seam that cannot is still bounded by the
 * race (a timeout is a timeout to the person waiting either way), and its call is simply
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
   * throw (`brokerReturnUrl` refusing a scheme-less `OPENBOT_APP_URL` while the callback builds its
   * argument is the one that happens) leave this function before the race and its `.finally`
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
